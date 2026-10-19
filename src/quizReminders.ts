// Напоминания о незаконченной анкете.
//
// Два на одно прохождение: через 3 часа после последнего ответа и через
// 24 часа. Второе — только если после первого человек так и не ответил;
// ответил хотя бы на один вопрос — второе отменяется насовсем, даже
// если он снова остановится. Доставать человека третий раз мы не будем.
//
// Срок считается от последнего ответа на вопрос анкеты. Открытие меню,
// документов или поддержки активностью не считается: человек мог зайти
// за политикой, это не значит, что он вернулся к анкете.
//
// Напоминания живут только внутри анкеты: от показа первого вопроса до
// ответа на последний. На экранах до анкеты — приветствие, условия,
// согласия — не напоминаем ни о чём: человек ещё не начал, и дёргать
// его там значило бы продавать, а не помогать.
//
// Планировщик, а не setTimeout: деплой случается чаще, чем раз в сутки,
// и таймер бы просто потерялся вместе с процессом. Все условия
// проверяются в момент отправки, а не планирования, — за три часа
// человек успевает и анкету закончить, и согласие отозвать.
//
// Окно 10:00–21:00 по Москве общее с отложенными вопросами (см.
// feedback.ts): ночью бот молчит, что бы ни было запланировано.

import { Api, Context } from "grammy";
import type { QuizReminder, Session } from "@prisma/client";
import { prisma } from "./prisma";
import { env } from "./env";
import { texts } from "./texts";
import { sendStatic } from "./send";
import { allowedToSend } from "./consents";
import { isAllowed, inQuestionnaire, resendCurrentStep } from "./engine";
import { isPermanentSendError, nextWindowOpening, withinWindow } from "./feedback";
import { quizReminder1Keyboard, quizReminder2Keyboard } from "./keyboards";

const HOUR_MS = 3_600_000;

// Между первым и вторым напоминанием не меньше 12 часов. Нужно, когда
// первое сдвинулось из-за ночного окна: без этого правила человек,
// остановившийся в 23:00, получил бы первое в 10:00, а второе — в 23:00
// того же дня, и выглядело бы это как настойчивость.
const MIN_GAP_MS = 12 * HOUR_MS;

async function logEvent(telegramId: bigint, type: string) {
  await prisma.offerEvent
    .create({ data: { telegramId, type: type as never } })
    .catch((error) => console.error(`Не удалось записать событие ${type}:`, error));
}

// ── Начало и конец ──────────────────────────────────────────────────

// Зовётся в момент показа первого вопроса анкеты. Строка одна на
// прохождение: начав заново, человек получает право на новые два
// напоминания, а прошлая строка остаётся для статистики.
export async function startQuizReminders(telegramId: bigint, attempt: number): Promise<void> {
  try {
    const now = new Date();
    await prisma.quizReminder.upsert({
      where: { telegramId_attempt: { telegramId, attempt } },
      // Если строка уже есть, это повторный показ первого вопроса —
      // считаем его активностью и начинаем отсчёт заново.
      update: {
        lastActivityAt: now,
        reminder1ScheduledAt: new Date(now.getTime() + env.QUIZ_REMINDER_1_HOURS * HOUR_MS),
      },
      create: {
        telegramId,
        attempt,
        lastActivityAt: now,
        reminder1ScheduledAt: new Date(now.getTime() + env.QUIZ_REMINDER_1_HOURS * HOUR_MS),
      },
    });
  } catch (error) {
    console.error(`Не удалось запланировать напоминания для #${telegramId}:`, error);
  }
}

// Напоминания больше не нужны: анкета пройдена, человек начал заново,
// отозвал согласие. Строку не удаляем — на ней держится статистика.
export const QUIZ_DONE_REASON = "анкета завершена";

export async function stopQuizReminders(
  telegramId: bigint,
  attempt: number,
  reason: string
): Promise<void> {
  try {
    const row = await prisma.quizReminder.findUnique({
      where: { telegramId_attempt: { telegramId, attempt } },
    });
    if (!row || row.remindersStoppedReason) return;
    await stopRow(row, reason);
  } catch (error) {
    console.error(`Не удалось остановить напоминания для #${telegramId}:`, error);
  }
}

// Единственное место, где напоминания останавливаются. И движок, и
// планировщик идут через него: иначе одна и та же причина писалась бы
// в двух местах по-разному, и цифры в /stats разошлись бы.
async function stopRow(row: QuizReminder, reason: string) {
  await prisma.quizReminder.update({
    where: { id: row.id },
    data: {
      remindersStoppedReason: reason,
      reminder1ScheduledAt: null,
      reminder2ScheduledAt: null,
    },
  });

  // Дошёл до конца, хотя напоминание уже уходило, — главная цифра всей
  // затеи. Если напоминаний не было, записывать нечего: человек прошёл
  // анкету сам.
  if (reason === QUIZ_DONE_REASON) {
    if (row.reminder1SentAt || row.reminder2SentAt) {
      await logEvent(row.telegramId, "quiz_completed_after_reminder");
    }
    return;
  }

  await logEvent(row.telegramId, "quiz_reminder_cancelled");
  console.log(`Напоминания об анкете для #${row.telegramId} остановлены: ${reason}.`);
}

// ── Активность ──────────────────────────────────────────────────────

// Зовётся на каждый ответ на вопрос анкеты. Сдвигает отсчёт и, если
// человек вернулся после напоминания, записывает это.
//
// Сбой здесь не должен ломать анкету: напоминания — вспомогательная
// механика, а человек в этот момент отвечает на вопрос.
export async function markQuizActivity(telegramId: bigint, attempt: number): Promise<void> {
  try {
    const row = await prisma.quizReminder.findUnique({
      where: { telegramId_attempt: { telegramId, attempt } },
    });
    if (!row || row.remindersStoppedReason) return;

    const now = new Date();

    // Первый ответ после напоминания. Считаем возвращением только в
    // пределах суток: вернувшийся через неделю вернулся сам, а не
    // потому что мы напомнили, и приписывать это напоминанию нечестно.
    const resumedAfter = firstAnswerAfterReminder(row);
    if (resumedAfter) {
      const sentAt = resumedAfter === 1 ? row.reminder1SentAt! : row.reminder2SentAt!;
      if (now.getTime() - sentAt.getTime() <= 24 * HOUR_MS) {
        await logEvent(telegramId, `quiz_resumed_after_reminder_${resumedAfter}`);
      }
    }

    // Ответ после первого напоминания отменяет второе насовсем: человек
    // показал, что помнит про анкету, и второго толчка ему не нужно.
    const cancelSecond = row.reminder2Cancelled || row.reminder1SentAt !== null;

    await prisma.quizReminder.update({
      where: { id: row.id },
      data: {
        lastActivityAt: now,
        // Первое напоминание переносится, пока не отправлено.
        reminder1ScheduledAt: row.reminder1SentAt
          ? null
          : new Date(now.getTime() + env.QUIZ_REMINDER_1_HOURS * HOUR_MS),
        reminder2Cancelled: cancelSecond,
        reminder2ScheduledAt: cancelSecond ? null : row.reminder2ScheduledAt,
      },
    });
  } catch (error) {
    console.error(`Не удалось отметить активность в анкете у #${telegramId}:`, error);
  }
}

// Какое напоминание было последним, если после него ещё не отвечали.
// null — отвечали уже после, или напоминаний не было вовсе.
function firstAnswerAfterReminder(row: QuizReminder): 1 | 2 | null {
  if (row.reminder2SentAt && row.lastActivityAt <= row.reminder2SentAt) return 2;
  if (row.reminder1SentAt && row.lastActivityAt <= row.reminder1SentAt) return 1;
  return null;
}

// ── Кнопка «Продолжить анкету» ──────────────────────────────────────

// Присылает текущий вопрос заново — тем же механизмом, что «Вернуться к
// анкете» в меню. Состояние сценария не меняет: это не ответ, а просто
// повтор вопроса.
export async function handleQuizContinue(ctx: Context, session: Session): Promise<void> {
  await logEvent(session.telegramId, "quiz_reminder_continue_click");

  // Анкету могли закончить или начать заново уже после того, как
  // напоминание ушло. Начатая заново анкета стоит на своём вопросе, и
  // мы пришлём именно его — это и есть «текущий вопрос».
  if (!inQuestionnaire(session)) {
    await ctx.answerCallbackQuery({ text: texts.quizAlreadyDone }).catch(() => {});
    return;
  }

  await resendCurrentStep(ctx, session);
}

// ── Планировщик ─────────────────────────────────────────────────────

const TICK_MS = 60 * 1000;

export function startQuizReminderScheduler(api: Api) {
  setInterval(() => {
    void sendDueQuizReminders(api).catch((error) =>
      console.error("Не удалось разослать напоминания об анкете:", error)
    );
  }, TICK_MS);
}

type Verdict =
  | { kind: "send" }
  | { kind: "defer"; until: Date }
  | { kind: "stop"; reason: string };

// Можно ли отправлять прямо сейчас. Проверка «человек сейчас занят»,
// которая есть у отложенных вопросов, здесь намеренно отсутствует:
// получатель напоминания по определению стоит на стадии анкеты, и с
// таким условием напоминание не ушло бы никогда.
async function decide(row: QuizReminder, session: Session | null): Promise<Verdict> {
  if (!session) return { kind: "stop", reason: "нет сессии" };

  // Человек начал анкету заново: у нового прохождения свои напоминания,
  // а это прохождение больше не актуально.
  if (session.attempt !== row.attempt) {
    return { kind: "stop", reason: "начал анкету заново" };
  }

  if (session.status === "completed") return { kind: "stop", reason: QUIZ_DONE_REASON };

  // Анкета могла остановиться не только завершением: возраст вне
  // диапазона, красный флаг, уход с экрана здоровья. Напоминать о
  // анкете, к которой человек не вернётся, незачем.
  if (!inQuestionnaire(session)) {
    return { kind: "stop", reason: "анкета больше не идёт" };
  }

  if (!isAllowed(row.telegramId)) return { kind: "stop", reason: "закрытый режим" };

  // Категория SERVICE: напоминание об услуге, за которой человек пришёл
  // сам, согласия на рассылку не требует. Но без согласия на обработку
  // данных бот молчит совсем.
  if (!(await allowedToSend(row.telegramId, "SERVICE", "quiz_reminder"))) {
    return { kind: "stop", reason: "нет согласия на обработку данных" };
  }

  const now = new Date();
  if (!withinWindow(now)) return { kind: "defer", until: nextWindowOpening(now) };

  return { kind: "send" };
}

export async function sendDueQuizReminders(api: Api) {
  await sendDue(api, 1);
  await sendDue(api, 2);
}

async function sendDue(api: Api, which: 1 | 2) {
  const field = which === 1 ? "reminder1ScheduledAt" : "reminder2ScheduledAt";

  const due = await prisma.quizReminder.findMany({
    where: {
      remindersStoppedReason: null,
      [field]: { lte: new Date() },
      ...(which === 1 ? { reminder1SentAt: null } : { reminder2SentAt: null, reminder2Cancelled: false }),
    },
    orderBy: { [field]: "asc" },
    take: 20,
  });

  for (const row of due) {
    try {
      const session = await prisma.session.findUnique({ where: { telegramId: row.telegramId } });
      const verdict = await decide(row, session);

      if (verdict.kind === "stop") {
        await stopRow(row, verdict.reason);
        continue;
      }
      if (verdict.kind === "defer") {
        await prisma.quizReminder.update({
          where: { id: row.id },
          data: { [field]: verdict.until },
        });
        continue;
      }

      await deliver(api, row, session!, which);
    } catch (error) {
      console.error(`Не удалось напомнить об анкете #${row.telegramId}:`, error);
      // Человек остановил бота: повторять бессмысленно, и каждую минуту
      // стучаться в закрытую дверь — тем более.
      if (isPermanentSendError(error)) {
        await stopRow(row, "родитель остановил бота");
      }
    }
  }
}

async function deliver(api: Api, row: QuizReminder, session: Session, which: 1 | 2) {
  const now = new Date();

  if (which === 1) {
    await sendStatic(api, session.chatId, texts.quizReminder1, {
      reply_markup: quizReminder1Keyboard(),
    });

    // Второе планируем сразу: ровно в этот момент известны оба срока —
    // сутки от последнего ответа и 12 часов от этого напоминания.
    const fromActivity = row.lastActivityAt.getTime() + env.QUIZ_REMINDER_2_HOURS * HOUR_MS;
    const minGap = now.getTime() + MIN_GAP_MS;

    await prisma.quizReminder.update({
      where: { id: row.id },
      data: {
        reminder1SentAt: now,
        reminder1ScheduledAt: null,
        reminder1QuestionNumber: session.currentQuestionNumber,
        reminder2ScheduledAt: new Date(Math.max(fromActivity, minGap)),
      },
    });
    await logEvent(row.telegramId, "quiz_reminder_1_sent");
    return;
  }

  const hasSupport = Boolean(env.SUPPORT_BOT_USERNAME);
  await sendStatic(api, session.chatId, texts.quizReminder2(hasSupport), {
    reply_markup: quizReminder2Keyboard(env.SUPPORT_BOT_USERNAME),
  });

  // После второго не отправляется больше ничего.
  await prisma.quizReminder.update({
    where: { id: row.id },
    data: {
      reminder2SentAt: now,
      reminder2ScheduledAt: null,
      remindersStoppedReason: "оба напоминания отправлены",
    },
  });
  await logEvent(row.telegramId, "quiz_reminder_2_sent");
}


