import { Api, Context, InlineKeyboard } from "grammy";
import { prisma } from "./prisma";
import { env } from "./env";
import { texts } from "./texts";
import { QUESTIONS, QuestionDef, getFirstQuestionNumber, getNextQuestionNumber, getQuestion } from "./questions";
import {
  csatKeyboard,
  editMoreKeyboard,
  fakeDoorKeyboard,
  multiChoiceKeyboard,
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

async function sendSummary(ctx: Context, telegramId: bigint) {
  const answers = await getAnswersMap(telegramId);
  const questions = summaryQuestions(answers);

  // Нумеруем подряд с единицы — именно этот номер пользователь потом
  // называет, чтобы поправить ответ.
  const lines = questions.map(
    (q, i) => `${i + 1}. ${questionLabel(q)}\n— ${answers[q.number]}`
  );

  for (const chunk of splitForTelegram(`${texts.summaryHeader}\n\n${lines.join("\n\n")}`)) {
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
  return ctx.reply(texts.questionnaireComplete);
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
