// Отложенные вопросы обратной связи.
//
// Их два: «узнали в разборе своего малыша?» через сутки после
// бесплатного разбора и «как сейчас сон малыша?» через неделю после
// плана. Оба бот задаёт по своей инициативе, поэтому у них одни правила
// и один планировщик:
//
//  - окно 10:00–21:00 по Москве: ночью такие сообщения не приходят;
//  - не больше одного вопроса обратной связи за сутки, иначе родитель
//    получает два опроса подряд;
//  - если человек прямо сейчас проходит анкету или что-то пишет, вопрос
//    ждёт час: перебивать его посреди дела не нужно;
//  - без согласия на обработку данных не отправляем ничего.
//
// Планировщик, а не setTimeout: деплой случается чаще, чем раз в сутки,
// и таймер бы просто потерялся. Строка создаётся в момент, когда вопрос
// запланирован, и дальше её двигает тик.
//
// Переносить вопрос из-за лимита можно только один раз: если и через
// сутки условие не выполняется, спрашивать уже поздно — лучше не
// спросить вовсе, чем прислать «вчера я прислал разбор» через неделю.

import { Api, Context } from "grammy";
import type { AnalysisRating, PdfResult, Session } from "@prisma/client";
import { prisma } from "./prisma";
import { env } from "./env";
import { texts } from "./texts";
import { replyStatic, sendStatic } from "./send";
import { allowedToSend } from "./consents";
import { isAllowed } from "./engine";
import { orderUrl } from "./web/server";
import {
  ANALYSIS_RATINGS,
  FEEDBACK_SKIP,
  PDF_RESULTS,
  analysisFeedbackKeyboard,
  feedbackSkipKeyboard,
  pdfResultKeyboard,
} from "./keyboards";

// ── Окно по Москве ──────────────────────────────────────────────────

const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;

function moscowHour(date: Date): number {
  return new Date(date.getTime() + MOSCOW_OFFSET_MS).getUTCHours();
}

export function withinWindow(date: Date): boolean {
  const hour = moscowHour(date);
  return hour >= env.FEEDBACK_WINDOW_START && hour < env.FEEDBACK_WINDOW_END;
}

// Ближайшее начало окна после указанного момента. Если сейчас раннее
// утро, это сегодняшние 10:00, если вечер или ночь — завтрашние.
export function nextWindowOpening(from: Date): Date {
  const moscow = new Date(from.getTime() + MOSCOW_OFFSET_MS);
  const opening = Date.UTC(
    moscow.getUTCFullYear(),
    moscow.getUTCMonth(),
    moscow.getUTCDate(),
    env.FEEDBACK_WINDOW_START
  );
  const asUtc = opening - MOSCOW_OFFSET_MS;
  return asUtc > from.getTime() ? new Date(asUtc) : new Date(asUtc + 24 * 3_600_000);
}

// ── Не больше одного вопроса в сутки ────────────────────────────────

// Любой вопрос обратной связи, который человек уже получал: оба
// отложенных и опрос после «Пока не нужно» в оффере. Последний приходит
// в ответ на нажатие, но для родителя это такой же вопрос, и два подряд
// он бы воспринял одинаково.
const FEEDBACK_EVENTS = ["csat_asked", "analysis_feedback_asked", "pdf_feedback_asked"] as const;

async function askedFeedbackWithin24h(telegramId: bigint): Promise<boolean> {
  const recent = await prisma.offerEvent.findFirst({
    where: {
      telegramId,
      type: { in: [...FEEDBACK_EVENTS] },
      createdAt: { gte: new Date(Date.now() - 24 * 3_600_000) },
    },
  });
  return recent !== null;
}

// ── Занят ли человек прямо сейчас ───────────────────────────────────

// Стадии, на которых родитель ничего не делает и вопрос его не
// перебивает. Всё остальное — анкета, согласия, ввод текста — повод
// подождать час.
const IDLE_STAGES: Session["stage"][] = [
  "AWAITING_RECOMMENDATION",
  "FAKE_DOOR_OFFER",
  "CSAT_DONE",
  "DECLINED",
  "OUT_OF_RANGE",
  "RED_FLAG_ENDED",
];

async function isBusy(telegramId: bigint): Promise<boolean> {
  const session = await prisma.session.findUnique({ where: { telegramId } });
  if (!session) return true;
  return !IDLE_STAGES.includes(session.stage);
}

// ── Общий разбор: можно ли отправлять прямо сейчас ──────────────────

type Verdict =
  | { kind: "send" }
  | { kind: "defer"; until: Date; limit?: boolean }
  | { kind: "skip"; reason: string };

async function decide(
  telegramId: bigint,
  kind: "analysis" | "pdf",
  limitDeferred: boolean
): Promise<Verdict> {
  const now = new Date();

  if (!(await allowedToSend(telegramId, "FEEDBACK", `${kind}_feedback`))) {
    return { kind: "skip", reason: "нет согласия" };
  }

  if (await askedFeedbackWithin24h(telegramId)) {
    // Второй раз не переносим: вопрос уже потерял смысл по времени.
    if (limitDeferred) return { kind: "skip", reason: "лимит одного вопроса в сутки" };
    return { kind: "defer", until: new Date(now.getTime() + 24 * 3_600_000), limit: true };
  }

  if (!withinWindow(now)) {
    return { kind: "defer", until: nextWindowOpening(now) };
  }

  if (await isBusy(telegramId)) {
    return { kind: "defer", until: new Date(now.getTime() + 3_600_000) };
  }

  return { kind: "send" };
}

// Ошибка, после которой повторять отправку бессмысленно: человек
// остановил бота, удалил аккаунт или чата просто нет. Остальные
// (таймаут, 500 от Telegram) — временные, их надо повторить.
export function isPermanentSendError(error: unknown): boolean {
  const description = (error as { description?: string })?.description ?? String(error);
  return /bot was blocked|user is deactivated|chat not found|bot can't initiate|Forbidden/i.test(
    description
  );
}

async function logEvent(telegramId: bigint, type: string) {
  await prisma.offerEvent
    .create({ data: { telegramId, type: type as never } })
    .catch((error) => console.error(`Не удалось записать событие ${type}:`, error));
}

// ── Планирование ────────────────────────────────────────────────────

// Оценка разбора. Зовётся в момент, когда родителю ушло второе
// сообщение разбора. Спрашиваем только тех, у кого нет заказа плана: у
// купивших план свой вопрос, через неделю.
export async function scheduleAnalysisFeedback(telegramId: bigint): Promise<void> {
  try {
    const existing = await prisma.analysisFeedback.findUnique({ where: { telegramId } });
    if (existing) return; // один раз на человека, по первому разбору

    const scheduledAt = new Date(
      Date.now() + env.FREE_ANALYSIS_FEEDBACK_DELAY_HOURS * 3_600_000
    );
    await prisma.analysisFeedback.create({ data: { telegramId, scheduledAt } });
    await logEvent(telegramId, "analysis_feedback_scheduled");
  } catch (error) {
    console.error(`Не удалось запланировать вопрос о разборе для #${telegramId}:`, error);
  }
}

// Результат плана. Зовётся, когда заказ перешёл в SENT. Спрашиваем
// всех, кто получил план, в том числе записавшихся на консультацию.
export async function schedulePdfFeedback(orderId: number, telegramId: bigint): Promise<void> {
  try {
    const existing = await prisma.pdfFeedback.findUnique({ where: { orderId } });
    if (existing) return;

    const scheduledAt = new Date(Date.now() + env.PDF_FEEDBACK_DELAY_DAYS * 24 * 3_600_000);
    await prisma.pdfFeedback.create({ data: { orderId, telegramId, scheduledAt } });
    await logEvent(telegramId, "pdf_feedback_scheduled");
  } catch (error) {
    console.error(`Не удалось запланировать вопрос о плане по заказу #${orderId}:`, error);
  }
}

// ── Планировщик ─────────────────────────────────────────────────────

const TICK_MS = 60 * 1000;

export function startFeedbackScheduler(api: Api) {
  setInterval(() => {
    void sendDueFeedback(api).catch((error) =>
      console.error("Не удалось разослать вопросы обратной связи:", error)
    );
  }, TICK_MS);
}

export async function sendDueFeedback(api: Api) {
  await sendDueAnalysisFeedback(api);
  await sendDuePdfFeedback(api);
}

async function sendDueAnalysisFeedback(api: Api) {
  const due = await prisma.analysisFeedback.findMany({
    where: { askedAt: null, skipReason: null, scheduledAt: { lte: new Date() } },
    orderBy: { scheduledAt: "asc" },
    take: 20,
  });

  for (const row of due) {
    try {
      // Заказ плана мог появиться за эти сутки — тогда вопрос не нужен
      // и не переносится: у купившего плана будет свой вопрос.
      const order = await prisma.order.findFirst({ where: { telegramId: row.telegramId } });
      if (order) {
        await skipAnalysis(row.id, row.telegramId, "заказ плана");
        continue;
      }

      // В закрытом режиме отложенные вопросы тем, кого нет в списке,
      // не уходят: бот только что сказал им «скоро откроется».
      if (!isAllowed(row.telegramId)) {
        await skipAnalysis(row.id, row.telegramId, "закрытый режим");
        continue;
      }

      const verdict = await decide(row.telegramId, "analysis", row.limitDeferred);
      if (verdict.kind === "skip") {
        await skipAnalysis(row.id, row.telegramId, verdict.reason);
        continue;
      }
      if (verdict.kind === "defer") {
        await prisma.analysisFeedback.update({
          where: { id: row.id },
          data: { scheduledAt: verdict.until, limitDeferred: row.limitDeferred || !!verdict.limit },
        });
        continue;
      }

      const session = await prisma.session.findUnique({ where: { telegramId: row.telegramId } });
      if (!session) {
        await skipAnalysis(row.id, row.telegramId, "нет сессии");
        continue;
      }

      // «Вчера» уместно, только если вопрос не слишком опоздал.
      const hours = (Date.now() - row.createdAt.getTime()) / 3_600_000;
      await sendStatic(api, session.chatId, texts.analysisFeedbackQuestion(hours <= 30), {
        reply_markup: analysisFeedbackKeyboard(),
      });

      await prisma.analysisFeedback.update({
        where: { id: row.id },
        data: { askedAt: new Date() },
      });
      await logEvent(row.telegramId, "analysis_feedback_asked");
    } catch (error) {
      console.error(`Не удалось спросить о разборе у #${row.telegramId}:`, error);
      // Иначе планировщик будет долбиться в заблокировавшего бота
      // каждую минуту до скончания времён.
      if (isPermanentSendError(error)) {
        await skipAnalysis(row.id, row.telegramId, "родитель остановил бота");
      }
    }
  }
}

async function sendDuePdfFeedback(api: Api) {
  const due = await prisma.pdfFeedback.findMany({
    where: { askedAt: null, skipReason: null, scheduledAt: { lte: new Date() } },
    orderBy: { scheduledAt: "asc" },
    take: 20,
  });

  for (const row of due) {
    try {
      if (!isAllowed(row.telegramId)) {
        await skipPdf(row.id, row.telegramId, "закрытый режим");
        continue;
      }

      const verdict = await decide(row.telegramId, "pdf", row.limitDeferred);
      if (verdict.kind === "skip") {
        await skipPdf(row.id, row.telegramId, verdict.reason);
        continue;
      }
      if (verdict.kind === "defer") {
        await prisma.pdfFeedback.update({
          where: { id: row.id },
          data: { scheduledAt: verdict.until, limitDeferred: row.limitDeferred || !!verdict.limit },
        });
        continue;
      }

      const session = await prisma.session.findUnique({ where: { telegramId: row.telegramId } });
      if (!session) {
        await skipPdf(row.id, row.telegramId, "нет сессии");
        continue;
      }

      const days = (Date.now() - row.createdAt.getTime()) / (24 * 3_600_000);
      await sendStatic(api, session.chatId, texts.pdfResultQuestion(days <= 8), {
        reply_markup: pdfResultKeyboard(),
      });

      await prisma.pdfFeedback.update({ where: { id: row.id }, data: { askedAt: new Date() } });
      await logEvent(row.telegramId, "pdf_feedback_asked");
    } catch (error) {
      console.error(`Не удалось спросить о плане по заказу #${row.orderId}:`, error);
      if (isPermanentSendError(error)) {
        await skipPdf(row.id, row.telegramId, "родитель остановил бота");
      }
    }
  }
}

async function skipAnalysis(id: number, telegramId: bigint, reason: string) {
  await prisma.analysisFeedback.update({ where: { id }, data: { skipReason: reason } });
  await logEvent(telegramId, "analysis_feedback_skipped");
  console.log(`Вопрос о разборе для #${telegramId} не отправлен: ${reason}.`);
}

async function skipPdf(id: number, telegramId: bigint, reason: string) {
  await prisma.pdfFeedback.update({ where: { id }, data: { skipReason: reason } });
  await logEvent(telegramId, "pdf_feedback_skipped");
  console.log(`Вопрос о плане #${id} не отправлен: ${reason}.`);
}

// ── Ответы на вопрос о разборе ──────────────────────────────────────

const ANALYSIS_BY_DATA: Record<string, { rating: AnalysisRating; label: string }> = {
  afb_yes: { rating: "YES", label: ANALYSIS_RATINGS[0].label },
  afb_partly: { rating: "PARTLY", label: ANALYSIS_RATINGS[1].label },
  afb_no: { rating: "NO", label: ANALYSIS_RATINGS[2].label },
};

export const FEEDBACK_CALLBACK_PREFIXES = ["afb_", "pfb_"];

export async function handleFeedbackCallback(ctx: Context, callbackData: string) {
  const from = ctx.from;
  if (!from) return;
  const telegramId = BigInt(from.id);

  if (callbackData === "afb_skip") return skipAnalysisComment(ctx, telegramId);
  if (callbackData === "pfb_skip") return skipPdfComment(ctx, telegramId);
  if (callbackData.startsWith("afb_")) return rateAnalysis(ctx, telegramId, callbackData);
  if (callbackData.startsWith("pfb_")) return answerPdf(ctx, telegramId, callbackData);
}

// Клавиатуру убираем сразу: ответ менять нельзя, и повторное нажатие
// не должно писать вторую оценку.
async function dropKeyboard(ctx: Context) {
  if (!ctx.callbackQuery?.message) return;
  await ctx.editMessageReplyMarkup().catch(() => {});
}

async function toast(ctx: Context) {
  await ctx.answerCallbackQuery({ text: texts.feedbackThanksToast }).catch(() => {});
}

async function rateAnalysis(ctx: Context, telegramId: bigint, data: string) {
  const choice = ANALYSIS_BY_DATA[data];
  if (!choice) return;

  const row = await prisma.analysisFeedback.findUnique({ where: { telegramId } });
  if (!row || row.answeredAt) return; // оценку изменить нельзя

  await prisma.analysisFeedback.update({
    where: { telegramId },
    data: { rating: choice.rating, answeredAt: new Date() },
  });
  await logEvent(telegramId, "analysis_feedback_rated");
  await dropKeyboard(ctx);

  // «Да, очень похоже» — разговор закончен: всплывающей подсказки
  // достаточно, лишнее сообщение в чате было бы шумом.
  if (choice.rating === "YES") return toast(ctx);

  const prompt = await replyStatic(ctx, texts.analysisFeedbackLow, {
    reply_markup: feedbackSkipKeyboard("afb"),
  });
  await prisma.analysisFeedback
    .update({ where: { telegramId }, data: { promptMessageId: prompt?.message_id ?? null } })
    .catch(() => {});

  const who = ctx.from?.username ? `@${ctx.from.username}` : `#${telegramId}`;
  await notifyAdmin(ctx, `📝 Разбор: «${choice.label}», пользователь ${who}`);
}

async function skipAnalysisComment(ctx: Context, telegramId: bigint) {
  await prisma.analysisFeedback
    .update({ where: { telegramId }, data: { skippedComment: true } })
    .catch(() => {});
  await logEvent(telegramId, "analysis_feedback_comment_skipped");
  await dropKeyboard(ctx);
  return toast(ctx);
}

// ── Ответы на вопрос о плане ────────────────────────────────────────

const PDF_BY_DATA: Record<string, { result: PdfResult; label: string; reply: string }> = {
  pfb_better: { result: "BETTER", label: PDF_RESULTS[0].label, reply: texts.pdfResultBetter },
  pfb_same: { result: "SAME", label: PDF_RESULTS[1].label, reply: texts.pdfResultSame },
  pfb_worse: { result: "WORSE", label: PDF_RESULTS[2].label, reply: texts.pdfResultWorse },
  pfb_not_started: {
    result: "NOT_STARTED",
    label: PDF_RESULTS[3].label,
    reply: texts.pdfResultNotStarted,
  },
};

// Тревожные ответы: по ним админ должен узнать сразу, не дожидаясь
// комментария, — человеку стало хуже или не помогло.
const ALARMING: PdfResult[] = ["SAME", "WORSE"];

async function answerPdf(ctx: Context, telegramId: bigint, data: string) {
  const choice = PDF_BY_DATA[data];
  if (!choice) return;

  const row = await prisma.pdfFeedback.findFirst({
    where: { telegramId, askedAt: { not: null }, answeredAt: null },
    orderBy: { askedAt: "desc" },
  });
  if (!row) return;

  await prisma.pdfFeedback.update({
    where: { id: row.id },
    data: { result: choice.result, answeredAt: new Date() },
  });
  await logEvent(telegramId, "pdf_feedback_answered");
  await dropKeyboard(ctx);

  const prompt = await replyStatic(ctx, choice.reply, {
    reply_markup: feedbackSkipKeyboard("pfb"),
  });
  await prisma.pdfFeedback
    .update({ where: { id: row.id }, data: { promptMessageId: prompt?.message_id ?? null } })
    .catch(() => {});

  if (ALARMING.includes(choice.result)) {
    const link = orderUrl(row.orderId);
    await notifyAdmin(
      ctx,
      `⚠️ План: «${choice.label}», заказ #${row.orderId}` + (link ? `\n${link}` : "")
    );
  }
}

async function skipPdfComment(ctx: Context, telegramId: bigint) {
  const row = await pendingPdfComment(telegramId);
  if (row) {
    await prisma.pdfFeedback.update({ where: { id: row.id }, data: { skippedComment: true } });
  }
  await logEvent(telegramId, "pdf_feedback_comment_skipped");
  await dropKeyboard(ctx);
  return toast(ctx);
}

// ── Комментарии ─────────────────────────────────────────────────────

// Комментарием считается следующее текстовое сообщение в течение суток
// после просьбы. Позже — обычное сообщение, обрабатывается как раньше.
const COMMENT_WINDOW_MS = 24 * 3_600_000;

function freshEnough(answeredAt: Date | null): boolean {
  return answeredAt !== null && Date.now() - answeredAt.getTime() < COMMENT_WINDOW_MS;
}

async function pendingAnalysisComment(telegramId: bigint) {
  const row = await prisma.analysisFeedback.findUnique({ where: { telegramId } });
  if (!row || row.comment || row.skippedComment) return null;
  if (row.rating === "YES" || row.rating === null) return null; // комментарий просили не у всех
  return freshEnough(row.answeredAt) ? row : null;
}

async function pendingPdfComment(telegramId: bigint) {
  const row = await prisma.pdfFeedback.findFirst({
    where: { telegramId, answeredAt: { not: null }, comment: null, skippedComment: false },
    orderBy: { answeredAt: "desc" },
  });
  if (!row) return null;
  return freshEnough(row.answeredAt) ? row : null;
}

// Возвращает true, если сообщение было комментарием и обработано здесь.
// Иначе движок разбирает его как обычно.
export async function takeFeedbackComment(ctx: Context, text: string): Promise<boolean> {
  const from = ctx.from;
  if (!from) return false;
  const telegramId = BigInt(from.id);

  const analysis = await pendingAnalysisComment(telegramId);
  if (analysis) {
    await prisma.analysisFeedback.update({ where: { id: analysis.id }, data: { comment: text } });
    await logEvent(telegramId, "analysis_feedback_comment");
    await dropSkipButton(ctx, analysis.promptMessageId);
    await replyStatic(ctx, texts.analysisFeedbackThanks);

    const who = from.username ? `@${from.username}` : `#${telegramId}`;
    await notifyAdmin(ctx, `📝 Разбор, комментарий от ${who}:\n\n${text}`);
    return true;
  }

  const pdf = await pendingPdfComment(telegramId);
  if (pdf) {
    await prisma.pdfFeedback.update({ where: { id: pdf.id }, data: { comment: text } });
    await logEvent(telegramId, "pdf_feedback_comment");
    await dropSkipButton(ctx, pdf.promptMessageId);
    await replyStatic(ctx, texts.pdfResultThanks);

    // Уведомляем только по тревожным ответам: остальные комментарии
    // видно в админке, и дёргать ими незачем.
    if (pdf.result && ALARMING.includes(pdf.result)) {
      const link = orderUrl(pdf.orderId);
      await notifyAdmin(
        ctx,
        `⚠️ План #${pdf.orderId}, комментарий:\n\n${text}` + (link ? `\n\n${link}` : "")
      );
    }
    return true;
  }

  return false;
}

// Кнопка «Пропустить» висит на предыдущем сообщении бота, а комментарий
// приходит отдельным сообщением от человека — поэтому убираем её по
// сохранённому id. Не вышло (сообщение удалили, слишком старое) — не
// беда: нажатие по ней уже ничего не сохранит.
async function dropSkipButton(ctx: Context, messageId: number | null) {
  if (!ctx.chat || messageId == null) return;
  await ctx.api.editMessageReplyMarkup(ctx.chat.id, messageId).catch(() => {});
}

async function notifyAdmin(ctx: Context, text: string) {
  await ctx.api
    .sendMessage(Number(env.ADMIN_TELEGRAM_ID), text)
    .catch((error) => console.error("Не удалось сообщить админу об обратной связи:", error));
}

export { FEEDBACK_SKIP };
