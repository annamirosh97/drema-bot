import { Api, Context, InlineKeyboard } from "grammy";
import { prisma } from "./prisma";
import { env } from "./env";
import { texts } from "./texts";
import { QUESTIONS, QuestionDef, getFirstQuestionNumber, getNextQuestionNumber, getQuestion } from "./questions";
import { csatKeyboard, fakeDoorKeyboard, multiChoiceKeyboard, singleChoiceKeyboard } from "./keyboards";
import type { Session } from "@prisma/client";

// ── Вспомогательные функции работы с БД ─────────────────────────────

async function getOrCreateSession(telegramId: bigint, chatId: bigint, firstName?: string): Promise<Session> {
  return prisma.session.upsert({
    where: { telegramId },
    update: { chatId, firstName: firstName ?? undefined },
    create: { telegramId, chatId, firstName },
  });
}

async function saveAnswer(telegramId: bigint, questionNumber: number, answerText: string) {
  await prisma.answer.create({ data: { telegramId, questionNumber, answerText } });
}

async function getAnswersMap(telegramId: bigint): Promise<Record<number, string>> {
  const rows = await prisma.answer.findMany({ where: { telegramId } });
  const map: Record<number, string> = {};
  for (const r of rows) map[r.questionNumber] = r.answerText;
  return map;
}

function safeGetQuestion(number: number): QuestionDef | null {
  try {
    return getQuestion(number);
  } catch {
    return null;
  }
}

// ── Точка входа: вызывается и на текстовые сообщения, и на нажатия кнопок ──

export async function handleIncoming(ctx: Context) {
  const from = ctx.from;
  if (!from || !ctx.chat) return;

  const telegramId = BigInt(from.id);
  const chatId = BigInt(ctx.chat.id);
  const session = await getOrCreateSession(telegramId, chatId, from.first_name);

  const callbackData = ctx.callbackQuery?.data;
  const messageText = ctx.message?.text?.trim();

  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery().catch(() => {});
  }

  switch (session.stage) {
    case "WELCOME":
      return handleWelcome(ctx, session, callbackData);
    case "HOW_IT_WORKS":
      return handleHowItWorks(ctx, session, callbackData);
    case "TERMS":
      return handleTerms(ctx, session, callbackData);
    case "DECLINE_REASON":
      return handleDeclineReason(ctx, session, messageText);
    case "QUESTION":
      return handleQuestion(ctx, session, callbackData, messageText);
    case "AWAITING_RECOMMENDATION":
      return handleAwaitingRecommendation(ctx, session, messageText);
    case "FAKE_DOOR_OFFER":
      return handleFakeDoor(ctx, session, callbackData);
    case "CSAT_RATING":
      return handleCsatRating(ctx, session, callbackData);
    case "CSAT_FEEDBACK":
      return handleCsatFeedback(ctx, session, messageText);
    case "CSAT_DONE":
      return ctx.reply(texts.csatThankYou);
    case "DECLINED":
    case "OUT_OF_RANGE":
    case "RED_FLAG_ENDED":
      return resetToWelcomeAndSend(ctx, session);
  }
}

// ── Онбординг ────────────────────────────────────────────────────────

function welcomeKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("Начать", "start").row().text("Как я работаю", "how_it_works");
}

async function sendWelcome(ctx: Context) {
  return ctx.reply(texts.welcome, { reply_markup: welcomeKeyboard() });
}

async function handleWelcome(ctx: Context, session: Session, callbackData?: string) {
  if (callbackData === "start") return goToTerms(ctx, session);
  if (callbackData === "how_it_works") {
    await prisma.session.update({ where: { telegramId: session.telegramId }, data: { stage: "HOW_IT_WORKS" } });
    return ctx.reply(texts.howItWorks, { reply_markup: new InlineKeyboard().text("Начать", "start") });
  }
  return sendWelcome(ctx);
}

async function handleHowItWorks(ctx: Context, session: Session, callbackData?: string) {
  if (callbackData === "start") return goToTerms(ctx, session);
  return ctx.reply(texts.howItWorks, { reply_markup: new InlineKeyboard().text("Начать", "start") });
}

async function goToTerms(ctx: Context, session: Session) {
  await prisma.session.update({ where: { telegramId: session.telegramId }, data: { stage: "TERMS" } });
  const kb = new InlineKeyboard()
    .text("Всё понятно, начинаем", "terms_accept")
    .row()
    .text("Пока не готовы", "terms_decline");
  return ctx.reply(texts.terms, { reply_markup: kb });
}

async function handleTerms(ctx: Context, session: Session, callbackData?: string) {
  if (callbackData === "terms_accept") {
    const first = getFirstQuestionNumber();
    await prisma.session.update({
      where: { telegramId: session.telegramId },
      data: { stage: "QUESTION", status: "in_progress", currentQuestionNumber: first },
    });
    await ctx.reply(texts.goStart);
    return sendQuestionPrompt(ctx, getQuestion(first), []);
  }
  if (callbackData === "terms_decline") {
    await prisma.session.update({ where: { telegramId: session.telegramId }, data: { stage: "DECLINE_REASON" } });
    return ctx.reply(texts.declineReasonPrompt);
  }
  const kb = new InlineKeyboard()
    .text("Всё понятно, начинаем", "terms_accept")
    .row()
    .text("Пока не готовы", "terms_decline");
  return ctx.reply(texts.terms, { reply_markup: kb });
}

async function handleDeclineReason(ctx: Context, session: Session, messageText?: string) {
  if (!messageText) return ctx.reply(texts.declineReasonPrompt);
  await saveAnswer(session.telegramId, -3, messageText);
  await prisma.session.update({
    where: { telegramId: session.telegramId },
    data: { stage: "WELCOME", status: "declined" },
  });
  return ctx.reply(texts.declineFarewell);
}

async function resetToWelcomeAndSend(ctx: Context, session: Session) {
  await prisma.session.update({ where: { telegramId: session.telegramId }, data: { stage: "WELCOME" } });
  return sendWelcome(ctx);
}

// ── Анкета ───────────────────────────────────────────────────────────

async function sendQuestionPrompt(ctx: Context, question: QuestionDef, selected: string[]) {
  let markup;
  if (question.type === "single_choice" && question.options) {
    markup = singleChoiceKeyboard(question.options);
  } else if (question.type === "multi_choice" && question.options) {
    markup = multiChoiceKeyboard(question.options, selected);
  }

  // Если у вопроса есть картинка — отправляем фото, а текст вопроса уходит подписью.
  // Если Telegram не смог скачать картинку — не роняем анкету, шлём обычным текстом.
  if (question.photoUrl) {
    try {
      return await ctx.replyWithPhoto(question.photoUrl, {
        caption: question.text,
        reply_markup: markup,
      });
    } catch {
      // падаем в обычную текстовую отправку ниже
    }
  }

  return ctx.reply(question.text, markup ? { reply_markup: markup } : undefined);
}

async function advanceQuestionnaire(ctx: Context, telegramId: bigint, currentQNum: number) {
  const answers = await getAnswersMap(telegramId);
  const next = getNextQuestionNumber(currentQNum, answers);

  if (next === null) {
    await prisma.session.update({
      where: { telegramId },
      data: { stage: "AWAITING_RECOMMENDATION", status: "completed", currentQuestionNumber: null },
    });
    await prisma.recommendation.upsert({
      where: { telegramId },
      update: {},
      create: { telegramId, status: "pending" },
    });
    return ctx.reply(texts.questionnaireComplete);
  }

  await prisma.session.update({ where: { telegramId }, data: { currentQuestionNumber: next } });
  return sendQuestionPrompt(ctx, getQuestion(next), []);
}

async function handleQuestion(ctx: Context, session: Session, callbackData?: string, messageText?: string) {
  const qNum = session.currentQuestionNumber;
  if (qNum == null) return resetToWelcomeAndSend(ctx, session);
  const question = getQuestion(qNum);

  if (question.type === "number") {
    if (!messageText) return ctx.reply(texts.invalidNumber);
    const num = Number(messageText.replace(",", "."));
    if (Number.isNaN(num)) return ctx.reply(texts.invalidNumber);

    if (
      question.outOfRangeEndsFlow &&
      question.min != null &&
      question.max != null &&
      (num < question.min || num > question.max)
    ) {
      await saveAnswer(session.telegramId, qNum, messageText);
      await prisma.session.update({
        where: { telegramId: session.telegramId },
        data: { stage: "OUT_OF_RANGE", status: "out_of_range" },
      });
      return ctx.reply(texts.outOfRange);
    }
    await saveAnswer(session.telegramId, qNum, messageText);
    return advanceQuestionnaire(ctx, session.telegramId, qNum);
  }

  if (question.type === "free_text") {
    if (!messageText) return ctx.reply("Напишите, пожалуйста, ответ текстом.");
    await saveAnswer(session.telegramId, qNum, messageText);
    return advanceQuestionnaire(ctx, session.telegramId, qNum);
  }

  if (question.type === "single_choice") {
    if (!callbackData || !question.options?.includes(callbackData)) {
      return sendQuestionPrompt(ctx, question, []);
    }
    await saveAnswer(session.telegramId, qNum, callbackData);
    return advanceQuestionnaire(ctx, session.telegramId, qNum);
  }

  if (question.type === "multi_choice") {
    if (!callbackData || !question.options?.includes(callbackData)) return;

    if (callbackData === "Готово") {
      const selections = session.tempSelections;

      if (question.redFlagValues?.some((v) => selections.includes(v))) {
        await saveAnswer(session.telegramId, qNum, selections.join(", ") || "—");
        await prisma.session.update({
          where: { telegramId: session.telegramId },
          data: { stage: "RED_FLAG_ENDED", status: "red_flag_ended", tempSelections: [] },
        });
        return ctx.reply(texts.redFlag);
      }

      let yellowFlags = session.yellowFlags;
      if (question.yellowFlagLabel && question.yellowFlagValues?.some((v) => selections.includes(v))) {
        yellowFlags = Array.from(new Set([...yellowFlags, question.yellowFlagLabel]));
      }

      await saveAnswer(session.telegramId, qNum, selections.join(", ") || "—");
      await prisma.session.update({
        where: { telegramId: session.telegramId },
        data: { tempSelections: [], yellowFlags },
      });
      return advanceQuestionnaire(ctx, session.telegramId, qNum);
    }

    const already = session.tempSelections.includes(callbackData);
    const updated = already
      ? session.tempSelections.filter((v: string) => v !== callbackData)
      : [...session.tempSelections, callbackData];
    await prisma.session.update({ where: { telegramId: session.telegramId }, data: { tempSelections: updated } });
    return ctx.editMessageReplyMarkup({ reply_markup: multiChoiceKeyboard(question.options, updated) }).catch(() => {});
  }
}

// ── Служебные команды /goto и /reset ────────────────────────────────

function availableQuestionNumbers(): string {
  return [...QUESTIONS]
    .map((q) => q.number)
    .sort((a, b) => a - b)
    .join(", ");
}

// /goto <номер> — перепрыгнуть на конкретный вопрос анкеты.
// Нужна для тестирования: не проходить каждый раз всю анкету с начала,
// чтобы посмотреть, как выглядит, например, вопрос 12.
// Ответы на пропущенные вопросы при этом НЕ сохраняются, а уже данные
// ответы остаются в базе — прыжок меняет только текущую позицию.
export async function handleGotoCommand(ctx: Context, arg: string) {
  const from = ctx.from;
  if (!from || !ctx.chat) return;

  const raw = arg.trim().replace(",", ".");
  if (!raw) {
    return ctx.reply(`Использование: /goto <номер вопроса>\n\nДоступные вопросы: ${availableQuestionNumbers()}`);
  }

  const number = Number(raw);
  const question = Number.isFinite(number) ? safeGetQuestion(number) : null;
  if (!question) {
    return ctx.reply(`Вопроса №${raw} нет.\n\nДоступные вопросы: ${availableQuestionNumbers()}`);
  }

  const telegramId = BigInt(from.id);
  await getOrCreateSession(telegramId, BigInt(ctx.chat.id), from.first_name);
  await prisma.session.update({
    where: { telegramId },
    data: {
      stage: "QUESTION",
      status: "in_progress",
      currentQuestionNumber: number,
      tempSelections: [],
    },
  });

  await ctx.reply(`Перешли к вопросу №${number}.`);
  return sendQuestionPrompt(ctx, question, []);
}

// /reset — вернуть пользователя на самое начало (экран приветствия)
// и стереть его ответы, чтобы следующий проход был с чистого листа.
// Ждущую отправки рекомендацию тоже удаляем: анкета, под которую её
// готовили, только что стёрлась, и висеть в /pending ей незачем.
// Запись fakeDoorOffer намеренно остаётся — на ней держится /stats.
export async function handleResetCommand(ctx: Context) {
  const from = ctx.from;
  if (!from || !ctx.chat) return;

  const telegramId = BigInt(from.id);
  await getOrCreateSession(telegramId, BigInt(ctx.chat.id), from.first_name);

  await prisma.answer.deleteMany({ where: { telegramId } });
  await prisma.recommendation.deleteMany({ where: { telegramId } });
  await prisma.session.update({
    where: { telegramId },
    data: {
      stage: "WELCOME",
      status: "onboarding",
      currentQuestionNumber: null,
      tempSelections: [],
      yellowFlags: [],
    },
  });

  await ctx.reply(texts.resetDone);
  return sendWelcome(ctx);
}

// ── Ожидание рекомендации (после анкеты, до отправки админом) ──────────

async function handleAwaitingRecommendation(ctx: Context, session: Session, messageText?: string) {
  if (!messageText) return;
  await saveAnswer(session.telegramId, 99, messageText);
  return ctx.reply(texts.addendumAck);
}

// ── Fake door экран оплаты ──────────────────────────────────────────

async function handleFakeDoor(ctx: Context, session: Session, callbackData?: string) {
  const offer = await prisma.fakeDoorOffer.findUnique({ where: { telegramId: session.telegramId } });
  const price = offer?.priceRub ?? env.FAKE_DOOR_PRICES[0] ?? 490;

  if (callbackData === "fakedoor_pay") {
    await prisma.fakeDoorOffer
      .update({ where: { telegramId: session.telegramId }, data: { clickedAt: new Date() } })
      .catch(() => {});
    await ctx.reply(texts.fakeDoorClicked);
  } else if (callbackData !== "fakedoor_skip") {
    return ctx.reply(texts.fakeDoorOffer(price), { reply_markup: fakeDoorKeyboard(price) });
  }

  await prisma.session.update({ where: { telegramId: session.telegramId }, data: { stage: "CSAT_RATING" } });
  return ctx.reply(texts.csatPrompt, { reply_markup: csatKeyboard() });
}

// ── CSAT ─────────────────────────────────────────────────────────────

async function handleCsatRating(ctx: Context, session: Session, callbackData?: string) {
  const match = callbackData?.match(/^csat_([1-5])$/);
  if (!match) return ctx.reply(texts.csatPrompt, { reply_markup: csatKeyboard() });

  await saveAnswer(session.telegramId, 30, match[1]);
  await prisma.session.update({ where: { telegramId: session.telegramId }, data: { stage: "CSAT_FEEDBACK" } });
  return ctx.reply(texts.csatFeedbackPrompt);
}

async function handleCsatFeedback(ctx: Context, session: Session, messageText?: string) {
  if (!messageText) return; // тишина ок, ничего страшного не происходит
  await saveAnswer(session.telegramId, 31, messageText);
  await prisma.session.update({ where: { telegramId: session.telegramId }, data: { stage: "CSAT_DONE" } });
  return ctx.reply(texts.csatThankYou);
}

// ── Функции для админки (src/admin.ts) ──────────────────────────────

// Отправляет 4 сообщения с рекомендацией, помечает Recommendation как
// отправленную и переводит пользователя на экран fake door оплаты.
export async function deliverRecommendation(
  api: Api,
  telegramId: bigint,
  chatId: bigint,
  messages: [string, string, string, string]
) {
  for (const m of messages) {
    await api.sendMessage(Number(chatId), m);
  }

  await prisma.recommendation.update({
    where: { telegramId },
    data: {
      status: "sent",
      sentAt: new Date(),
      message1: messages[0],
      message2: messages[1],
      message3: messages[2],
      message4: messages[3],
    },
  });

  const prices = env.FAKE_DOOR_PRICES.length ? env.FAKE_DOOR_PRICES : [490];
  const price = prices[Math.floor(Math.random() * prices.length)];

  await prisma.fakeDoorOffer.upsert({
    where: { telegramId },
    update: { priceRub: price, shownAt: new Date(), clickedAt: null },
    create: { telegramId, priceRub: price },
  });

  await prisma.session.update({ where: { telegramId }, data: { stage: "FAKE_DOOR_OFFER" } });

  await api.sendMessage(Number(chatId), texts.fakeDoorOffer(price), {
    reply_markup: fakeDoorKeyboard(price),
  });
}

// Текстовый дамп "Вопрос/Ответ" для конкретного пользователя — чтобы
// скопировать в Claude при подготовке рекомендации (замена листа `prep`).
export async function buildPrepText(telegramId: bigint): Promise<string> {
  const session = await prisma.session.findUnique({ where: { telegramId } });
  const rows = await prisma.answer.findMany({ where: { telegramId }, orderBy: { questionNumber: "asc" } });

  const qaLines: string[] = [];
  const addenda: string[] = [];

  for (const r of rows) {
    if (r.questionNumber === -3 || r.questionNumber === 30 || r.questionNumber === 31) continue;
    if (r.questionNumber === 99) {
      addenda.push(r.answerText);
      continue;
    }
    const q = safeGetQuestion(r.questionNumber);
    const label = q ? q.text.replace(/\n/g, " ") : `Вопрос ${r.questionNumber}`;
    qaLines.push(`Вопрос: ${label}\nОтвет: ${r.answerText}`);
  }

  let out = qaLines.join("\n\n") || "Нет сохранённых ответов.";
  if (addenda.length) out += `\n\n— Дополнительно от пользователя —\n${addenda.join("\n")}`;
  if (session?.yellowFlags.length) out += `\n\n⚠️ Обратить внимание: ${session.yellowFlags.join(", ")}`;
  return out;
}
