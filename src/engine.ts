import { Api, Context, InlineKeyboard } from "grammy";
import { prisma } from "./prisma";
import { env } from "./env";
import { photos, texts } from "./texts";
import {
  ApiCallUsage,
  RedFlagError,
  formatUsageLine,
  generateRecommendationDraft,
} from "./claudeApi";
import { PaidRedFlagError, PdfContent, generatePdfDraft } from "./paidPdf";
import { renderPdf } from "./pdf/render";
import { PROJECT_ROOT, isRelaxationMemoReady, readRelaxationMemo } from "./prompts";
import { orderUrl } from "./web/server";
import { QUESTIONS, QuestionDef, getFirstQuestionNumber, getNextQuestionNumber, getQuestion } from "./questions";
import { InputFile } from "grammy";
import { join } from "path";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import {
  csatKeyboard,
  editMoreKeyboard,
  exampleFollowupKeyboard,
  multiChoiceKeyboard,
  offerKeyboard,
  singleChoiceKeyboard,
  summaryKeyboard,
} from "./keyboards";
import type { Session } from "@prisma/client";

// ── Вспомогательные функции работы с БД ─────────────────────────────

async function getOrCreateSession(telegramId: bigint, chatId: bigint, firstName?: string): Promise<Session> {
  return prisma.session.upsert({
    where: { telegramId },
    update: { chatId, firstName: firstName ?? undefined },
    create: { telegramId, chatId, firstName },
  });
}

// Служебные записи (-3 причина отказа, 30/31 CSAT, 99 дополнения после
// анкеты). Их может быть несколько на пользователя, поэтому просто
// добавляем строку.
async function saveAnswer(telegramId: bigint, questionNumber: number, answerText: string) {
  await prisma.answer.create({ data: { telegramId, questionNumber, answerText } });
}

// Ответ на вопрос анкеты: один вопрос — одна строка в базе. Пользователь
// может переписать ответ через «Внести изменения» в конце, и тогда
// старый должен исчезнуть, иначе в /prep попадут оба варианта сразу.
async function saveQuestionAnswer(telegramId: bigint, questionNumber: number, answerText: string) {
  await prisma.answer.deleteMany({ where: { telegramId, questionNumber } });
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

  // Кнопки оффера разбираем до стадий. Оффер мог быть отправлен вручную
  // командой /offer, когда пользователь уже ушёл дальше по сценарию, и
  // тогда его стадия с оффером не совпадёт, а кнопки окажутся мёртвыми.
  // Та же защита срабатывает, если человек пролистал чат наверх и нажал
  // кнопку под старым сообщением.
  if (callbackData?.startsWith("offer_")) {
    return handleOffer(ctx, session, callbackData);
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
    case "SUMMARY_REVIEW":
      return handleSummaryReview(ctx, session, callbackData);
    case "EDIT_PICK_QUESTION":
      return handleEditPickQuestion(ctx, session, messageText);
    case "EDIT_ANSWER":
      return handleEditAnswer(ctx, session, callbackData, messageText);
    case "EDIT_MORE":
      return handleEditMore(ctx, session, callbackData);
    case "AWAITING_RECOMMENDATION":
      return handleAwaitingRecommendation(ctx, session, messageText);
    case "FAKE_DOOR_OFFER":
      return handleOffer(ctx, session, callbackData);
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
    await replyWithOptionalPhoto(ctx, texts.goStart, photos.goStart);
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

// Отправляет сообщение с картинкой, если она задана: текст уходит
// подписью к фото. Если Telegram не смог скачать картинку (битая ссылка,
// закрытый доступ) — не роняем анкету, шлём обычным текстом.
async function replyWithOptionalPhoto(
  ctx: Context,
  text: string,
  photoUrl?: string,
  markup?: InlineKeyboard
) {
  if (photoUrl) {
    try {
      return await ctx.replyWithPhoto(photoUrl, { caption: text, reply_markup: markup });
    } catch {
      // падаем в обычную текстовую отправку ниже
    }
  }
  return ctx.reply(text, markup ? { reply_markup: markup } : undefined);
}

async function sendQuestionPrompt(ctx: Context, question: QuestionDef, selected: string[]) {
  let markup;
  if (question.type === "single_choice" && question.options) {
    markup = singleChoiceKeyboard(question.options);
  } else if (question.type === "multi_choice" && question.options) {
    markup = multiChoiceKeyboard(question.options, selected);
  }

  return replyWithOptionalPhoto(ctx, question.text, question.photoUrl, markup);
}

// Перерисовывает сообщение с вопросом после того, как пользователь нажал
// кнопку: кнопки убираются, а под текстом вопроса остаётся выбранный
// вариант — чтобы, листая чат вверх, было видно, что где выбрано.
// Кнопки исчезают именно потому, что в запросе не передаётся reply_markup.
async function markQuestionAnswered(ctx: Context, question: QuestionDef, chosen: string) {
  const message = ctx.callbackQuery?.message;
  if (!message) return;

  // Вопрос с единственной кнопкой (например, «Продолжить» в вопросе 9) —
  // это не выбор, а просто «дальше»: подпись «Выбрано: Продолжить»
  // читалась бы странно, поэтому там только убираем кнопку.
  if (question.options?.length === 1) {
    await ctx.editMessageReplyMarkup().catch(() => {});
    return;
  }

  const body = `${question.text}\n\n${texts.answeredMark(chosen)}`;

  // У вопроса с картинкой текст лежит в подписи к фото, у обычного — в тексте
  // сообщения, и правятся они разными методами Telegram API.
  // Если правка не прошла (например, подпись длиннее 1024 символов) — не
  // роняем анкету: пользователь просто увидит вопрос с кнопками как раньше.
  const edit =
    "photo" in message ? ctx.editMessageCaption({ caption: body }) : ctx.editMessageText(body);
  await edit.catch(() => {});
}

async function advanceQuestionnaire(ctx: Context, telegramId: bigint, currentQNum: number) {
  const answers = await getAnswersMap(telegramId);
  const next = getNextQuestionNumber(currentQNum, answers);

  // Вопросы кончились — не завершаем анкету сразу, а показываем итог и
  // даём пользователю сверить ответы (см. handleSummaryReview).
  if (next === null) {
    return goToSummary(ctx, telegramId);
  }

  await prisma.session.update({ where: { telegramId }, data: { currentQuestionNumber: next } });
  return sendQuestionPrompt(ctx, getQuestion(next), []);
}

// Что произошло с присланным ответом. "saved" — ответ записан, дальше
// решает вызывающий: идти к следующему вопросу (обычный проход анкеты)
// или вернуться к правке (handleEditAnswer). "handled" — записывать
// нечего: невалидный ввод, переключение галочки в multi_choice или
// анкета остановлена по возрасту/красному флагу; пользователю в этих
// случаях уже ответили внутри.
type AnswerOutcome = { kind: "handled" } | { kind: "saved" };

async function consumeAnswer(
  ctx: Context,
  session: Session,
  question: QuestionDef,
  qNum: number,
  callbackData?: string,
  messageText?: string
): Promise<AnswerOutcome> {
  if (question.type === "number") {
    if (!messageText) {
      await ctx.reply(texts.invalidNumber);
      return { kind: "handled" };
    }
    const num = Number(messageText.replace(",", "."));
    if (Number.isNaN(num)) {
      await ctx.reply(texts.invalidNumber);
      return { kind: "handled" };
    }

    if (
      question.outOfRangeEndsFlow &&
      question.min != null &&
      question.max != null &&
      (num < question.min || num > question.max)
    ) {
      await saveQuestionAnswer(session.telegramId, qNum, messageText);
      await prisma.session.update({
        where: { telegramId: session.telegramId },
        data: { stage: "OUT_OF_RANGE", status: "out_of_range" },
      });
      await ctx.reply(texts.outOfRange);
      return { kind: "handled" };
    }
    await saveQuestionAnswer(session.telegramId, qNum, messageText);
    return { kind: "saved" };
  }

  if (question.type === "free_text") {
    if (!messageText) {
      await ctx.reply("Напишите, пожалуйста, ответ текстом.");
      return { kind: "handled" };
    }
    await saveQuestionAnswer(session.telegramId, qNum, messageText);
    return { kind: "saved" };
  }

  if (question.type === "single_choice") {
    if (!callbackData || !question.options?.includes(callbackData)) {
      await sendQuestionPrompt(ctx, question, []);
      return { kind: "handled" };
    }
    await markQuestionAnswered(ctx, question, callbackData);
    await saveQuestionAnswer(session.telegramId, qNum, callbackData);
    return { kind: "saved" };
  }

  // multi_choice
  if (!callbackData || !question.options?.includes(callbackData)) return { kind: "handled" };

  if (callbackData === "Готово") {
    const selections = session.tempSelections;
    const answerText = selections.join(", ") || "—";
    await markQuestionAnswered(ctx, question, answerText);

    if (question.redFlagValues?.some((v) => selections.includes(v))) {
      await saveQuestionAnswer(session.telegramId, qNum, answerText);
      await prisma.session.update({
        where: { telegramId: session.telegramId },
        data: { stage: "RED_FLAG_ENDED", status: "red_flag_ended", tempSelections: [] },
      });
      await ctx.reply(texts.redFlag);
      return { kind: "handled" };
    }

    let yellowFlags = session.yellowFlags;
    if (question.yellowFlagLabel && question.yellowFlagValues?.some((v) => selections.includes(v))) {
      yellowFlags = Array.from(new Set([...yellowFlags, question.yellowFlagLabel]));
    }

    await saveQuestionAnswer(session.telegramId, qNum, answerText);
    await prisma.session.update({
      where: { telegramId: session.telegramId },
      data: { tempSelections: [], yellowFlags },
    });
    return { kind: "saved" };
  }

  const already = session.tempSelections.includes(callbackData);
  const updated = already
    ? session.tempSelections.filter((v: string) => v !== callbackData)
    : [...session.tempSelections, callbackData];
  await prisma.session.update({ where: { telegramId: session.telegramId }, data: { tempSelections: updated } });
  await ctx.editMessageReplyMarkup({ reply_markup: multiChoiceKeyboard(question.options, updated) }).catch(() => {});
  return { kind: "handled" };
}

async function handleQuestion(ctx: Context, session: Session, callbackData?: string, messageText?: string) {
  const qNum = session.currentQuestionNumber;
  if (qNum == null) return resetToWelcomeAndSend(ctx, session);
  const question = safeGetQuestion(qNum);
  if (!question) return resetToWelcomeAndSend(ctx, session);

  const outcome = await consumeAnswer(ctx, session, question, qNum, callbackData, messageText);
  if (outcome.kind !== "saved") return;

  return advanceQuestionnaire(ctx, session.telegramId, qNum);
}

// ── Итоговая анкета и правка ответов ────────────────────────────────

// Какие вопросы попадают в итоговую анкету: те, на которые есть ответ.
// Экраны с единственной кнопкой («Продолжить» в вопросе 9) — это не
// вопрос, а переход дальше, сверять там нечего.
function summaryQuestions(answers: Record<number, string>): QuestionDef[] {
  return [...QUESTIONS]
    .sort((a, b) => a.number - b.number)
    .filter((q) => q.options?.length !== 1 && answers[q.number] != null);
}

// Короткая подпись вопроса для списка. Хвост вида "→ Вопрос 9/20" из
// текста убираем — в итоговой анкете своя сквозная нумерация.
function questionLabel(question: QuestionDef): string {
  if (question.shortLabel) return question.shortLabel;
  const oneLine = question.text
    .replace(/→\s*Вопрос\s*\d+\s*\/\s*\d+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return oneLine.length > 90 ? `${oneLine.slice(0, 89)}…` : oneLine;
}

// Telegram не принимает сообщения длиннее 4096 символов, а итоговая
// анкета с развёрнутыми ответами про режим дня легко переваливает за
// лимит. Режем по пустым строкам, чтобы пункт не разрывался посередине.
function splitForTelegram(text: string, limit = 3500): string[] {
  const parts: string[] = [];
  let current = "";

  for (const block of text.split("\n\n")) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current) parts.push(current);
    if (block.length <= limit) {
      current = block;
      continue;
    }
    // Один ответ длиннее лимита — режем как есть, по живому.
    for (let i = 0; i < block.length; i += limit) parts.push(block.slice(i, i + limit));
    current = "";
  }

  if (current) parts.push(current);
  return parts.length ? parts : [text];
}

// Пронумерованный список «вопрос — ответ». Ровно в этом виде анкету
// видит пользователь на сверке, и в этом же виде она уходит админу
// после подтверждения, чтобы вы смотрели на одно и то же.
async function buildSummaryText(telegramId: bigint): Promise<string> {
  const answers = await getAnswersMap(telegramId);

  // Нумеруем подряд с единицы — именно этот номер пользователь потом
  // называет, чтобы поправить ответ.
  return summaryQuestions(answers)
    .map((q, i) => `${i + 1}. ${questionLabel(q)}\n— ${answers[q.number]}`)
    .join("\n\n");
}

async function sendSummary(ctx: Context, telegramId: bigint) {
  const body = await buildSummaryText(telegramId);

  for (const chunk of splitForTelegram(`${texts.summaryHeader}\n\n${body}`)) {
    await ctx.reply(chunk);
  }
  return ctx.reply(texts.summaryConfirmPrompt, { reply_markup: summaryKeyboard() });
}

async function goToSummary(ctx: Context, telegramId: bigint) {
  await prisma.session.update({
    where: { telegramId },
    data: { stage: "SUMMARY_REVIEW", currentQuestionNumber: null, tempSelections: [] },
  });
  return sendSummary(ctx, telegramId);
}

// Убирает кнопки у сообщения, на котором только что нажали, — чтобы на
// него нельзя было нажать второй раз.
async function dropKeyboard(ctx: Context) {
  if (!ctx.callbackQuery?.message) return;
  await ctx.editMessageReplyMarkup().catch(() => {});
}

async function handleSummaryReview(ctx: Context, session: Session, callbackData?: string) {
  if (callbackData === "summary_confirm") {
    await dropKeyboard(ctx);
    return finishQuestionnaire(ctx, session.telegramId);
  }

  if (callbackData === "summary_edit") {
    await dropKeyboard(ctx);
    await prisma.session.update({
      where: { telegramId: session.telegramId },
      data: { stage: "EDIT_PICK_QUESTION" },
    });
    return askWhichQuestionToEdit(ctx, session.telegramId);
  }

  // Нажатие на кнопку старого, уже отвеченного вопроса выше по чату —
  // молча игнорируем, чтобы не заваливать человека копиями анкеты.
  if (callbackData) return;
  return sendSummary(ctx, session.telegramId);
}

async function finishQuestionnaire(ctx: Context, telegramId: bigint) {
  await prisma.session.update({
    where: { telegramId },
    data: { stage: "AWAITING_RECOMMENDATION", status: "completed", currentQuestionNumber: null },
  });
  await prisma.recommendation.upsert({
    where: { telegramId },
    update: {},
    create: { telegramId, status: "pending" },
  });

  // Всё, что дальше, запускаем в фоне и результата не ждём: обращение к
  // Claude API идёт десятки секунд, а пользователь должен получить своё
  // сообщение сразу. Отбивка и черновик придут тебе в Telegram сами.
  void announceAndGenerateDraft(ctx.api, telegramId);

  return replyWithOptionalPhoto(ctx, texts.questionnaireComplete, photos.questionnaireComplete);
}

// Порядок сообщений админу после подтверждения анкеты: сначала отбивка,
// затем сама анкета, затем «готовлю черновик» и уже сам черновик.
// Сбой отбивки не должен отменять генерацию — она важнее.
async function announceAndGenerateDraft(api: Api, telegramId: bigint) {
  const adminChatId = Number(env.ADMIN_TELEGRAM_ID);

  try {
    await api.sendMessage(
      adminChatId,
      `Пользователь #${telegramId} завершил анкету и ждёт рекомендаций.`
    );
    await sendLongMessage(
      api,
      BigInt(adminChatId),
      `Анкета #${telegramId} — в том виде, в каком её подтвердил пользователь:\n\n${await buildSummaryText(telegramId)}`
    );
  } catch (error) {
    console.error(`Не удалось отправить отбивку по анкете #${telegramId}:`, error);
  }

  await generateDraftForAdmin(api, telegramId);
}

// Одно и то же сообщение и при автоматической генерации, и при /draft —
// поэтому текст один, в одном месте.
export function draftInProgressNote(telegramId: bigint): string {
  return `Готовлю черновик для #${telegramId}. Займёт до минуты — пришлю, как будет готов.`;
}

// Готовит черновик разбора и присылает его тебе на проверку — ровно в том
// виде, в каком его увидел бы пользователь. Ничего не бросает наружу:
// это фоновая задача, и любая ошибка здесь не должна ронять бота.
//
// Запускать только через void, не через await: бот обрабатывает входящие
// сообщения строго по одному, и ожидание ответа модели заморозило бы его
// для всех остальных на десятки секунд.
export async function generateDraftForAdmin(api: Api, telegramId: bigint) {
  const adminChatId = Number(env.ADMIN_TELEGRAM_ID);

  try {
    await api.sendMessage(adminChatId, draftInProgressNote(telegramId));

    const draft = await generateRecommendationDraft(await buildPrepText(telegramId), String(telegramId));
    await recordApiCalls(draft.usage);

    await prisma.recommendation.update({
      where: { telegramId },
      data: { message1: draft.message1, message2: draft.message2, analysis: draft.analysis },
    });

    await api.sendMessage(adminChatId, `Черновик разбора для #${telegramId} готов — вот он целиком:`);
    await sendLongMessage(api, BigInt(adminChatId), formatDraftMessage(texts.draftHeading1, draft.message1), true);
    await sendLongMessage(api, BigInt(adminChatId), formatDraftMessage(texts.draftHeading2, draft.message2), true);

    const warningLine = draft.warnings.length ? `\n\n⚠️ ${draft.warnings.join("; ")}` : "";
    await api.sendMessage(
      adminChatId,
      `${formatUsageLine(draft.usage)}\nВыводы анализа: /analysis ${telegramId}${warningLine}\n\n` +
        `Отправить как есть: /approve ${telegramId}\nНаписать свою версию: /send ${telegramId}`
    );
  } catch (error) {
    // Красный флаг — не поломка: анкета дошла до анализа и он сказал, что
    // писать разбор нельзя. Родителю ничего не отправляем.
    if (error instanceof RedFlagError) {
      await prisma.recommendation
        .update({ where: { telegramId }, data: { analysis: error.analysis } })
        .catch((dbError) => console.error("Не удалось сохранить выводы анализа:", dbError));
      await api
        .sendMessage(
          adminChatId,
          `В анкете #${telegramId} красный флаг — черновик не создан, пользователю ничего не отправлено.\n\n` +
            `Что нашёл анализ:\n${error.analysis}`
        )
        .catch((sendError) => console.error("И сообщить об этом не вышло:", sendError));
      return;
    }
    return reportDraftFailure(api, adminChatId, telegramId, error);
  }
}

// Последний пробный прогон /regen по каждому пользователю. В базу он не
// пишется специально: /regen — это проба промптов, и перезаписывать ею
// готовый к отправке черновик нельзя. Но и терять удачный вариант
// обидно, поэтому держим его здесь до команды /keep.
//
// В памяти процесса, а не в базе: живёт минуты, до перезапуска, и
// предназначен одному человеку.
const lastRegen = new Map<string, { analysis: string; message1: string; message2: string }>();

// Сохранить последний пробный прогон как черновик — то, что отправит
// /approve. Возвращает false, если пробы не было или процесс успел
// перезапуститься.
export async function keepLastRegen(telegramId: bigint): Promise<boolean> {
  const draft = lastRegen.get(String(telegramId));
  if (!draft) return false;

  await prisma.recommendation.update({
    where: { telegramId },
    data: { analysis: draft.analysis, message1: draft.message1, message2: draft.message2 },
  });
  lastRegen.delete(String(telegramId));
  return true;
}

// Отладочный прогон для /regen: оба шага по сохранённым ответам анкеты.
// Присылает админу блок ВЫВОДЫ, оба сообщения и строку с ценой.
// Черновик в базе НЕ трогает — результат придерживается в памяти, и
// попадёт в черновик только по команде /keep.
export async function regenerateForAdmin(api: Api, telegramId: bigint) {
  const adminChatId = Number(env.ADMIN_TELEGRAM_ID);

  try {
    await api.sendMessage(adminChatId, `Пробный прогон для #${telegramId}. Черновик пока не перезапишу.`);

    const draft = await generateRecommendationDraft(await buildPrepText(telegramId), String(telegramId));
    await recordApiCalls(draft.usage);

    await sendLongMessage(api, BigInt(adminChatId), `ВЫВОДЫ (шаг 1):\n\n${draft.analysis}`);
    await sendLongMessage(api, BigInt(adminChatId), formatDraftMessage(texts.draftHeading1, draft.message1), true);
    await sendLongMessage(api, BigInt(adminChatId), formatDraftMessage(texts.draftHeading2, draft.message2), true);

    lastRegen.set(String(telegramId), {
      analysis: draft.analysis,
      message1: draft.message1,
      message2: draft.message2,
    });

    const warningLine = draft.warnings.length ? `\n⚠️ ${draft.warnings.join("; ")}` : "";
    await api.sendMessage(
      adminChatId,
      `${formatUsageLine(draft.usage)}${warningLine}\n\n` +
        `⚠️ Это проба, в черновик она пока не попала. Сейчас /approve ${telegramId} отправит ПРЕДЫДУЩУЮ версию.\n\n` +
        `Сохранить этот вариант как черновик: /keep ${telegramId}`
    );
  } catch (error) {
    if (error instanceof RedFlagError) {
      lastRegen.delete(String(telegramId));
      await api
        .sendMessage(adminChatId, `Пробный прогон #${telegramId}: красный флаг.\n\n${error.analysis}`)
        .catch((sendError) => console.error("И сообщить об этом не вышло:", sendError));
      return;
    }
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`Пробный прогон для #${telegramId} не удался:`, error);
    await api
      .sendMessage(adminChatId, `Пробный прогон #${telegramId} не удался.\n\nПричина: ${reason}`)
      .catch((sendError) => console.error("И сообщить об этом не вышло:", sendError));
  }
}

// Пишем в базу по одной записи и не роняем генерацию, если не вышло:
// это статистика, а не рабочие данные.
async function recordApiCalls(usage: ApiCallUsage[]) {
  for (const call of usage) {
    try {
      await prisma.apiCall.create({ data: call });
    } catch (error) {
      console.error("Не удалось записать обращение к Claude API в базу:", error);
    }
  }
}

async function reportDraftFailure(api: Api, adminChatId: number, telegramId: bigint, error: unknown) {
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`Не удалось подготовить черновик для #${telegramId}:`, error);
  await api
    .sendMessage(
      adminChatId,
      `Не получилось подготовить черновик для #${telegramId}.\n\nПричина: ${reason}\n\n` +
        `Анкета цела, пользователь ждёт.\n` +
        `Попробовать ещё раз: /draft ${telegramId}\n` +
        `Собрать вручную: /prep ${telegramId}, затем /send ${telegramId}`
    )
    .catch((sendError) => console.error("И сообщить об этом в Telegram тоже не вышло:", sendError));
}

async function askWhichQuestionToEdit(ctx: Context, telegramId: bigint) {
  const answers = await getAnswersMap(telegramId);
  const count = summaryQuestions(answers).length;
  return ctx.reply(texts.editPickQuestion(count ? `1–${count}` : "—"));
}

// Пользователь назвал номер строки из итоговой анкеты.
async function handleEditPickQuestion(ctx: Context, session: Session, messageText?: string) {
  const answers = await getAnswersMap(session.telegramId);
  const questions = summaryQuestions(answers);
  const position = Number((messageText ?? "").replace(",", ".").trim());
  const question = Number.isInteger(position) ? questions[position - 1] : undefined;

  if (!question) {
    return ctx.reply(texts.editUnknownNumber(questions.length ? `1–${questions.length}` : "—"));
  }
  return startEditingQuestion(ctx, session.telegramId, question, answers);
}

// Прошлые галочки multi_choice восстанавливаем из сохранённого ответа,
// чтобы не отмечать всё заново — достаточно поправить отличия.
function restoreSelections(question: QuestionDef, saved?: string): string[] {
  if (!saved || saved === "—") return [];
  return saved
    .split(", ")
    .filter((value) => value !== "Готово" && question.options?.includes(value));
}

async function startEditingQuestion(
  ctx: Context,
  telegramId: bigint,
  question: QuestionDef,
  answers: Record<number, string>
) {
  const selected = question.type === "multi_choice" ? restoreSelections(question, answers[question.number]) : [];
  await prisma.session.update({
    where: { telegramId },
    data: { stage: "EDIT_ANSWER", currentQuestionNumber: question.number, tempSelections: selected },
  });
  return sendQuestionPrompt(ctx, question, selected);
}

async function handleEditAnswer(ctx: Context, session: Session, callbackData?: string, messageText?: string) {
  const qNum = session.currentQuestionNumber;
  if (qNum == null) return goToSummary(ctx, session.telegramId);
  const question = safeGetQuestion(qNum);
  if (!question) return goToSummary(ctx, session.telegramId);

  const outcome = await consumeAnswer(ctx, session, question, qNum, callbackData, messageText);
  if (outcome.kind !== "saved") return;

  return afterEditSaved(ctx, session.telegramId);
}

// После записи нового ответа проверяем условные вопросы (сейчас это
// только 4.5, который показывается лишь при ответе «Другое» в вопросе 4).
// Если условие перестало выполняться — старый ответ убираем, чтобы в
// разбор не попали противоречивые данные. Если, наоборот, только что
// стало выполняться — сразу задаём этот вопрос.
async function afterEditSaved(ctx: Context, telegramId: bigint) {
  let answers = await getAnswersMap(telegramId);

  const stale = QUESTIONS.filter((q) => q.skipUnless && !q.skipUnless(answers) && answers[q.number] != null);
  if (stale.length) {
    await prisma.answer.deleteMany({
      where: { telegramId, questionNumber: { in: stale.map((q) => q.number) } },
    });
    await ctx.reply(texts.editStaleRemoved);
    answers = await getAnswersMap(telegramId);
  }

  const nowNeeded = [...QUESTIONS]
    .sort((a, b) => a.number - b.number)
    .find((q) => q.skipUnless && q.skipUnless(answers) && answers[q.number] == null);
  if (nowNeeded) return startEditingQuestion(ctx, telegramId, nowNeeded, answers);

  await prisma.session.update({
    where: { telegramId },
    data: { stage: "EDIT_MORE", currentQuestionNumber: null, tempSelections: [] },
  });
  return ctx.reply(texts.editMorePrompt, { reply_markup: editMoreKeyboard() });
}

async function handleEditMore(ctx: Context, session: Session, callbackData?: string) {
  if (callbackData === "edit_more_yes") {
    await dropKeyboard(ctx);
    await prisma.session.update({
      where: { telegramId: session.telegramId },
      data: { stage: "EDIT_PICK_QUESTION" },
    });
    return askWhichQuestionToEdit(ctx, session.telegramId);
  }

  if (callbackData === "edit_more_no") {
    await dropKeyboard(ctx);
    return goToSummary(ctx, session.telegramId);
  }

  if (callbackData) return;
  return ctx.reply(texts.editMorePrompt, { reply_markup: editMoreKeyboard() });
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
// События оффера намеренно остаются — на них держится /stats.
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

// ── Оффер платного PDF ──────────────────────────────────────────────

const EXAMPLE_PDF_PATH = join(PROJECT_ROOT, "assets/example/Drema_plan_sna_primer.pdf");

// Telegram разрешает переотправлять уже загруженный файл по
// идентификатору, не загружая его заново. Храним идентификатор вместе с
// хэшем содержимого: если пример в репозитории заменили, хэш разойдётся
// и файл уйдёт на загрузку заново.
//
// Сам кэш живёт в памяти процесса и перезапуск не переживает, так что
// после деплоя новый пример подхватится и без проверки хэша. Хэш нужен
// на случай подмены файла без перезапуска и чтобы правило осталось
// явным, если кэш когда-нибудь переедет в базу.
let exampleCache: { fileId: string; hash: string } | null = null;

// Файл около 800 КБ, а кнопку нажимают редко — читать и хэшировать его
// на каждое нажатие дешевле, чем держать хэш и не замечать подмену.
function exampleFileHash(): string {
  return createHash("sha256").update(readFileSync(EXAMPLE_PDF_PATH)).digest("hex");
}

function exampleFollowUp(ctx: Context) {
  return ctx.reply(texts.exampleFollowup, {
    reply_markup: exampleFollowupKeyboard(env.PDF_PRICE_RUB),
  });
}

async function sendExamplePdf(ctx: Context) {
  const hash = exampleFileHash();

  if (exampleCache?.hash === hash) {
    try {
      await ctx.replyWithDocument(exampleCache.fileId);
      return exampleFollowUp(ctx);
    } catch (error) {
      // Идентификатор мог устареть на стороне Telegram. Родителю эта
      // ошибка ни о чём не говорит — просто грузим файл заново.
      console.error("Не удалось отправить пример по file_id, загружаю заново:", error);
      exampleCache = null;
    }
  }

  const sent = await ctx.replyWithDocument(new InputFile(EXAMPLE_PDF_PATH));
  const fileId = sent.document?.file_id;
  if (fileId) exampleCache = { fileId, hash };

  return exampleFollowUp(ctx);
}

// Отправляет оффер вручную, командой /offer. Ни стадию сессии, ни
// заказы не трогает: это просто повторный показ предложения тому, кто
// его пропустил или потерял в переписке. Показ при этом попадает в
// статистику, иначе покупка по такому офферу выглядела бы в /stats
// покупкой без показа.
export async function sendOfferTo(api: Api, telegramId: bigint, chatId: bigint) {
  await logOfferEvent(telegramId, "offer_shown");
  await api.sendMessage(Number(chatId), texts.paidOffer, {
    reply_markup: offerKeyboard(env.PDF_PRICE_RUB),
  });
}

async function handleOffer(ctx: Context, session: Session, callbackData?: string) {
  const price = env.PDF_PRICE_RUB;

  if (callbackData === "offer_example") {
    await logOfferEvent(session.telegramId, "example_clicked");
    return sendExamplePdf(ctx);
  }

  if (callbackData === "offer_buy") {
    await dropKeyboard(ctx);
    await logOfferEvent(session.telegramId, "buy_clicked");
    return handleBuy(ctx, session);
  }

  if (callbackData === "offer_decline") {
    await dropKeyboard(ctx);
    await prisma.session.update({
      where: { telegramId: session.telegramId },
      data: { stage: "CSAT_RATING" },
    });
    return ctx.reply(texts.csatPrompt, { reply_markup: csatKeyboard() });
  }

  // Нажали кнопку старого сообщения выше по чату — молча игнорируем.
  if (callbackData) return;
  return ctx.reply(texts.paidOffer, { reply_markup: offerKeyboard(price) });
}

// Повторное «Купить» не создаёт второй заказ: отвечаем по статусу
// существующего.
async function handleBuy(ctx: Context, session: Session) {
  const existing = await prisma.order.findFirst({
    where: {
      telegramId: session.telegramId,
      status: { in: ["GENERATING", "DRAFT_READY", "SENT"] },
    },
    orderBy: { createdAt: "desc" },
  });

  if (existing) {
    return ctx.reply(
      existing.status === "SENT" ? texts.orderAlreadySent : texts.orderAlreadyGenerating
    );
  }

  const order = await createPdfOrder(session.telegramId);
  await ctx.reply(texts.orderAccepted);

  await ctx.api
    .sendMessage(Number(env.ADMIN_TELEGRAM_ID), `🧾 Новый заказ PDF #${order.id} от #${session.telegramId}`)
    .catch((error) => console.error("Не удалось сообщить админу о заказе:", error));

  // Создание заказа и его выполнение намеренно разделены: когда появится
  // оплата, генерация будет запускаться по событию «заказ можно
  // выполнять», а не прямо отсюда. Результата не ждём — обращения к
  // модели идут десятки секунд, а бот обрабатывает сообщения по одному.
  void runPdfGeneration(ctx.api, order.id);
}

export async function createPdfOrder(telegramId: bigint) {
  return prisma.order.create({
    data: { telegramId, product: "PDF", priceRub: env.PDF_PRICE_RUB, status: "GENERATING" },
  });
}

async function logOfferEvent(telegramId: bigint, type: "offer_shown" | "example_clicked" | "buy_clicked") {
  await prisma.offerEvent
    .create({ data: { telegramId, type } })
    .catch((error) => console.error("Не удалось записать событие оффера:", error));
}

// ── Генерация платного PDF ──────────────────────────────────────────

// Собирает вход для P1 из того, что уже сохранено по бесплатному
// разбору, и запускает оба шага. Ничего не бросает наружу: фоновая
// задача, её сбой не должен ронять бота.
//
// Запускать только через void: бот обрабатывает входящие сообщения
// строго по одному, и ожидание двух вызовов модели заморозило бы его
// для всех остальных на минуты.
export async function runPdfGeneration(api: Api, orderId: number, reviewerComment?: string) {
  const adminChatId = Number(env.ADMIN_TELEGRAM_ID);

  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) return console.error(`Заказ #${orderId} не найден, генерация отменена.`);

  try {
    const recommendation = await prisma.recommendation.findUnique({
      where: { telegramId: order.telegramId },
    });
    if (!recommendation?.analysis || !recommendation.message1 || !recommendation.message2) {
      throw new Error("Нет сохранённого бесплатного разбора: не из чего собирать план.");
    }

    const answers = await getAnswersMap(order.telegramId);
    const ageMonths = Number(answers[1]);
    if (!Number.isFinite(ageMonths)) {
      throw new Error("В анкете не разобрать возраст малыша — не выбрать группу памятки.");
    }

    const draft = await generatePdfDraft(
      {
        analysis: recommendation.analysis,
        questionnaire: await buildPrepText(order.telegramId),
        message1: recommendation.message1,
        message2: recommendation.message2,
        ageMonths,
      },
      String(order.telegramId),
      reviewerComment
    );
    await recordApiCalls(draft.usage);

    const costUsd = draft.usage.reduce<number | null>(
      (sum, call) => (sum === null || call.costUsd === null ? null : sum + call.costUsd),
      0
    );
    const tokens = (step: string) => draft.usage.find((u) => u.step === step);

    // aiContent перезаписывается только перегенерацией — правки админа
    // живут отдельно, в editedContent, и этим обновлением не затираются.
    await prisma.pdfDraft.upsert({
      where: { orderId },
      create: {
        orderId,
        aiContent: draft.content as object,
        rawPlan: draft.rawPlan,
        reviewerNotes: draft.reviewerNotes,
        planModel: env.PDF_PLAN_MODEL,
        writerModel: env.PDF_WRITER_MODEL,
        planTokensIn: tokens("pdf_plan")?.inputTokens ?? 0,
        planTokensOut: tokens("pdf_plan")?.outputTokens ?? 0,
        writerTokensIn: tokens("pdf_writer")?.inputTokens ?? 0,
        writerTokensOut: tokens("pdf_writer")?.outputTokens ?? 0,
        costUsd,
      },
      update: {
        aiContent: draft.content as object,
        rawPlan: draft.rawPlan,
        reviewerNotes: draft.reviewerNotes,
        planModel: env.PDF_PLAN_MODEL,
        writerModel: env.PDF_WRITER_MODEL,
        planTokensIn: tokens("pdf_plan")?.inputTokens ?? 0,
        planTokensOut: tokens("pdf_plan")?.outputTokens ?? 0,
        writerTokensIn: tokens("pdf_writer")?.inputTokens ?? 0,
        writerTokensOut: tokens("pdf_writer")?.outputTokens ?? 0,
        costUsd,
        generationCount: { increment: 1 },
      },
    });

    await prisma.order.update({ where: { id: orderId }, data: { status: "DRAFT_READY" } });

    const memoWarning = draft.memoReady
      ? ""
      : `\n⚠️ Памятка для группы ${draft.content.relaxationGroup} не готова — отправлять нельзя.`;
    const link = orderUrl(orderId);
    await api.sendMessage(
      adminChatId,
      `📝 Черновик PDF #${orderId} готов (пользователь #${order.telegramId}).\n` +
        `${formatUsageLine(draft.usage)}${memoWarning}\n\n` +
        (link ? `Проверить и отправить: ${link}` : "Ссылка на заказ появится, когда будет задан PUBLIC_BASE_URL.")
    );
  } catch (error) {
    const redFlag = error instanceof PaidRedFlagError;
    const reason = redFlag
      ? "красный флаг — решить вручную"
      : error instanceof Error
        ? error.message
        : String(error);

    if (!redFlag) console.error(`Не удалось собрать PDF для заказа #${orderId}:`, error);

    await prisma.order
      .update({ where: { id: orderId }, data: { status: "FAILED", failReason: reason } })
      .catch((dbError) => console.error("И статус заказа обновить не вышло:", dbError));

    await api
      .sendMessage(
        adminChatId,
        `❌ Заказ PDF #${orderId} (пользователь #${order.telegramId}) не собрался.\n\n` +
          `Причина: ${reason}\n\nПользователю ничего не отправлено, он ждёт.` +
          (orderUrl(orderId) ? `\n\nЗаказ: ${orderUrl(orderId)}` : "")
      )
      .catch((sendError) => console.error("И сообщить об этом не вышло:", sendError));
  }
}

// ── Отправка готового PDF ───────────────────────────────────────────

// Рендерит PDF из правок админа (а если их нет — из того, что выдала
// модель), отправляет родителю документом и закрывает заказ. Готовый
// файл кладём в базу: отправить повторно нужно уметь без рендера.
//
// Ошибка отправки статус не меняет: заказ остаётся в DRAFT_READY, и его
// видно в админке как неотправленный.
export async function approveAndSendPdf(api: Api, orderId: number): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { draft: true } });
  if (!order) throw new Error(`Заказ #${orderId} не найден.`);
  if (!order.draft) throw new Error(`У заказа #${orderId} нет черновика.`);
  if (order.status === "SENT") throw new Error(`Заказ #${orderId} уже отправлен.`);

  const content = (order.draft.editedContent ?? order.draft.aiContent) as unknown as PdfContent;
  const group = content.relaxationGroup;
  if (!isRelaxationMemoReady(group)) {
    throw new Error(`Памятка для группы ${group} не готова — отправлять такой план нельзя.`);
  }

  const approvedAt = new Date();
  const pdf = await renderPdf(content, readRelaxationMemo(group), approvedAt);

  await api.sendDocument(
    Number(order.telegramId),
    new InputFile(pdf, "Drema_plan_sna.pdf"),
    { caption: texts.pdfCaption }
  );

  await prisma.pdfDraft.update({ where: { orderId }, data: { pdfBytes: pdf, approvedAt } });
  await prisma.order.update({
    where: { id: orderId },
    data: { status: "SENT", sentAt: new Date() },
  });
}

// ── Напоминания о зависших заказах ──────────────────────────────────

const REMINDER_INTERVAL_MS = 30 * 60 * 1000;
const REMIND_AFTER_HOURS = 12;
const URGENT_AFTER_HOURS = 20;
// Родителям обещаны сутки, поэтому напоминать раз в три часа достаточно
// часто, чтобы не пропустить срок, и редко, чтобы не надоесть.
const REMINDER_COOLDOWN_MS = 3 * 60 * 60 * 1000;

// Когда последний раз напоминали по каждому заказу. В памяти процесса:
// после перезапуска напомним заново, и это не беда.
const lastReminded = new Map<number, number>();

export function startOrderReminders(api: Api) {
  setInterval(() => {
    void remindAboutStuckOrders(api).catch((error) =>
      console.error("Не удалось проверить зависшие заказы:", error)
    );
  }, REMINDER_INTERVAL_MS);
}

async function remindAboutStuckOrders(api: Api) {
  const threshold = new Date(Date.now() - REMIND_AFTER_HOURS * 3_600_000);
  const stuck = await prisma.order.findMany({
    where: {
      status: { in: ["GENERATING", "DRAFT_READY", "FAILED"] },
      createdAt: { lt: threshold },
    },
    orderBy: { createdAt: "asc" },
  });

  for (const order of stuck) {
    const previous = lastReminded.get(order.id) ?? 0;
    if (Date.now() - previous < REMINDER_COOLDOWN_MS) continue;

    const hours = Math.floor((Date.now() - order.createdAt.getTime()) / 3_600_000);
    const urgent = hours >= URGENT_AFTER_HOURS ? "🔴 срочно: " : "";
    const link = orderUrl(order.id);

    await api
      .sendMessage(
        Number(env.ADMIN_TELEGRAM_ID),
        `${urgent}заказ PDF #${order.id} ждёт ${hours} ч, статус ${order.status}.` +
          (link ? `\n${link}` : "")
      )
      .then(() => lastReminded.set(order.id, Date.now()))
      .catch((error) => console.error(`Не удалось напомнить о заказе #${order.id}:`, error));
  }
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

// Заголовки у сообщений разбора должны быть жирными, а жирный в Telegram
// возможен только с разметкой. Разметка HTML, и текст в ней приходит от
// модели — значит, три её служебных символа нужно обезвредить, иначе
// Telegram либо съест кусок текста, либо откажется принимать сообщение.
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Заголовок применяется при отправке, а не хранится в базе: и админ в
// черновике, и пользователь в итоге видят одно и то же, а поменять
// формулировку можно в texts.ts, не переписывая уже готовые черновики.
function formatDraftMessage(heading: string, body: string): string {
  return `<b>${escapeHtml(heading)}</b>\n\n${escapeHtml(body)}`;
}

// Длинное сообщение Telegram не примет (лимит 4096 символов), поэтому
// шлём по частям. Модель просят писать короче, но подстраховаться дешевле,
// чем потерять уже готовый разбор на отправке.
async function sendLongMessage(api: Api, chatId: bigint, text: string, asHtml = false) {
  for (const chunk of splitForTelegram(text)) {
    await api.sendMessage(Number(chatId), chunk, asHtml ? { parse_mode: "HTML" } : undefined);
  }
}

// Общий хвост обоих путей — и ручного /send, и автоматического /approve:
// помечаем рекомендацию отправленной и показываем экран оплаты.
async function markSentAndShowOffer(api: Api, telegramId: bigint, chatId: bigint) {
  await prisma.recommendation.update({
    where: { telegramId },
    data: { status: "sent", sentAt: new Date() },
  });

  await prisma.session.update({ where: { telegramId }, data: { stage: "FAKE_DOOR_OFFER" } });

  await logOfferEvent(telegramId, "offer_shown");
  await api.sendMessage(Number(chatId), texts.paidOffer, {
    reply_markup: offerKeyboard(env.PDF_PRICE_RUB),
  });
}

// Ручной путь (/send): два сообщения, собранные тобой в переписке с ботом.
// Сохраняем именно их, а не черновик модели: платный шаг P1 опирается на
// то, что родитель реально прочитал.
export async function deliverRecommendation(
  api: Api,
  telegramId: bigint,
  chatId: bigint,
  messages: [string, string]
) {
  await sendLongMessage(api, chatId, formatDraftMessage(texts.draftHeading1, messages[0]), true);
  await sendLongMessage(api, chatId, formatDraftMessage(texts.draftHeading2, messages[1]), true);

  await prisma.recommendation.update({
    where: { telegramId },
    data: { message1: messages[0], message2: messages[1] },
  });

  await markSentAndShowOffer(api, telegramId, chatId);
}

// Автоматический путь (/approve): отправляем пользователю тот черновик,
// который бот подготовил сам и показал тебе на проверку.
export async function sendApprovedRecommendation(api: Api, telegramId: bigint, chatId: bigint) {
  const recommendation = await prisma.recommendation.findUnique({ where: { telegramId } });
  if (!recommendation?.message1 || !recommendation?.message2) {
    throw new Error("Черновик разбора не найден.");
  }

  await sendLongMessage(api, chatId, formatDraftMessage(texts.draftHeading1, recommendation.message1), true);
  await sendLongMessage(api, chatId, formatDraftMessage(texts.draftHeading2, recommendation.message2), true);

  await markSentAndShowOffer(api, telegramId, chatId);
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
