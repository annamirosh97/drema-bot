import { Api, Context, InlineKeyboard } from "grammy";
import { prisma } from "./prisma";
import { env } from "./env";
import { formatPrice, photos, texts } from "./texts";
import { buildPrepText, safeGetQuestion } from "./prep";
import { replyPhotoStatic, replyStatic, sendStatic } from "./send";
import { allowedToSend } from "./consents";
import { MENU_CALLBACKS, sendDocs, sendMenu, sendSupport, sendTeam } from "./menu";
import { logEvent } from "./events";
import { completeAttempt, markAttemptStep, startAttempt } from "./attempts";
import {
  QUIZ_DONE_REASON,
  handleQuizContinue,
  markQuizActivity,
  startQuizReminders,
  stopQuizReminders,
} from "./quizReminders";
import { DATA_CALLBACKS, handleDataCallback } from "./dataCommand";
import {
  FEEDBACK_CALLBACK_PREFIXES,
  handleFeedbackCallback,
  scheduleAnalysisFeedback,
  schedulePdfFeedback,
  takeFeedbackComment,
} from "./feedback";
import {
  consultPriceText,
  remindAboutConsentOnce,
  remindConsultRequestText,
  skipConsultRequest,
  startConsultRequest,
  takeConsultRequestText,
  takeConsultCancel,
  takeConsultContact,
  takeConsultSelfWrite,
} from "./consult";
import { handleUpsell } from "./upsell";
import {
  ApiCallUsage,
  RedFlagError,
  formatUsageLine,
  generateRecommendationDraft,
} from "./claudeApi";
import { PaidRedFlagError, PdfContent, generatePdfDraft } from "./paidPdf";
import { renderPdf } from "./pdf/render";
import { PROJECT_ROOT, isRelaxationMemoReady, readRelaxationMemo } from "./prompts";
import { projectFile, sendCachedDocument, sendCachedPhoto, withCachedPhoto } from "./staticDocs";

// Гид «Азбука сна» — уходит каждому сразу после анкеты, пока готовится разбор.
const GUIDE_PDF = "assets/guide/Dremius_azbuka_sna.pdf";
import { orderUrl } from "./web/server";
import {
  QUESTIONS,
  QuestionDef,
  getFirstQuestionNumber,
  getNextQuestionNumber,
  getQuestion,
  nearestQuestionNumber,
  questionTextWithCounter,
} from "./questions";
import { InputFile } from "grammy";
import { getConsent, recordConsent } from "./consents";
import {
  CONSULT_CANCEL_BUTTON,
  CONSULT_SELF_WRITE_BUTTON,
  HEALTH_OK,
  MARKETING_NO,
  MARKETING_YES,
  PD_CONSENT_NO,
  PD_CONSENT_YES,
  csatKeyboard,
  healthGuideKeyboard,
  healthScreenKeyboard,
  marketingConsentKeyboard,
  pdConsentKeyboard,
  editMoreKeyboard,
  exampleFinalKeyboard,
  exampleFollowupKeyboard,
  examplePlanKeyboard,
  multiChoiceKeyboard,
  consultRequestKeyboard,
  offerChoiceKeyboard,
  offerConsultCardKeyboard,
  offerPdfCardKeyboard,
  singleChoiceKeyboard,
  summaryKeyboard,
  howItWorksKeyboard,
  stepsKeyboard,
  welcomeKeyboard,
  welcomeValueKeyboard,
  backToQuizKeyboard,
  restartConfirmKeyboard,
} from "./keyboards";
import type { Session, Stage } from "@prisma/client";
import {
  answersOfCurrentAttempt,
  currentAttempt,
  currentRecommendation,
  lastCancelledRecommendation,
  pendingRecommendation,
} from "./attempt";

// ── Вспомогательные функции работы с БД ─────────────────────────────

// username обновляем при каждом входе: человек может его сменить, а
// админке нужен актуальный, чтобы открыть чат. Источник, наоборот,
// пишем только при создании — это то, откуда человек пришёл впервые, и
// переписывать его следующим deep-link нельзя.
async function getOrCreateSession(
  telegramId: bigint,
  chatId: bigint,
  firstName?: string,
  username?: string,
  source?: string
): Promise<Session> {
  return prisma.session.upsert({
    where: { telegramId },
    update: { chatId, firstName: firstName ?? undefined, username: username ?? undefined },
    create: { telegramId, chatId, firstName, username, source },
  });
}

// Служебные записи (30/31 CSAT, 99 дополнения после анкеты). Их может
// быть несколько на пользователя, поэтому просто добавляем строку.
//
// Номер -3 раньше хранил причину отказа. Вопрос о причине убран
// 15.10.2026: отказ от согласия — это ответ, а не повод расспрашивать.
// Старые записи остались в базе нетронутыми.
async function saveAnswer(telegramId: bigint, questionNumber: number, answerText: string) {
  const attempt = await currentAttempt(telegramId);
  await prisma.answer.create({ data: { telegramId, questionNumber, answerText, attempt } });
}

// Ответ на вопрос анкеты: один вопрос — одна строка в базе. Пользователь
// может переписать ответ через «Внести изменения» в конце, и тогда
// старый должен исчезнуть, иначе в /prep попадут оба варианта сразу.
//
// Удаляем только в пределах текущего прохождения: ответ на тот же
// вопрос из прошлого прохождения — это не черновик, а история, и
// переписывать её правка ответа не должна.
async function saveQuestionAnswer(telegramId: bigint, questionNumber: number, answerText: string) {
  const attempt = await currentAttempt(telegramId);
  await prisma.answer.deleteMany({ where: { telegramId, questionNumber, attempt } });
  await prisma.answer.create({ data: { telegramId, questionNumber, answerText, attempt } });

  // Единственное, что считается активностью в анкете. Открытие меню,
  // документов или поддержки сюда не попадает намеренно: человек мог
  // зайти за политикой, и к анкете это его не вернуло.
  await markQuizActivity(telegramId, attempt);
}

async function getAnswersMap(telegramId: bigint): Promise<Record<number, string>> {
  const rows = await prisma.answer.findMany({ where: await answersOfCurrentAttempt(telegramId) });
  const map: Record<number, string> = {};
  for (const r of rows) map[r.questionNumber] = r.answerText;
  return map;
}


// ── Точка входа: вызывается и на текстовые сообщения, и на нажатия кнопок ──

export async function handleIncoming(ctx: Context) {
  const from = ctx.from;
  if (!from || !ctx.chat) return;

  // Закрытый режим — самое первое, что проверяется: сессию и любые
  // другие следы заводить нельзя, пока человек не в списке.
  if (!isAllowed(from.id)) {
    await logOfferEvent(BigInt(from.id), "closed_mode_blocked");
    if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
    return replyStatic(ctx, texts.notOpenYet);
  }

  const telegramId = BigInt(from.id);
  const chatId = BigInt(ctx.chat.id);
  // Параметр deep-link «/start utm_vk» запоминаем как источник. У
  // остальных сообщений его нет, и значение не трогается.
  const startSource = startPayload(ctx.message?.text);
  const session = await getOrCreateSession(
    telegramId,
    chatId,
    from.first_name,
    from.username,
    startSource
  );

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
  // Согласие на обработку данных проверяем раньше всего остального.
  // Нажатие кнопки — такое же действие, как сообщение: человеку,
  // который начал пользоваться ботом до появления согласий, нельзя
  // позволить купить план по старой кнопке в истории чата, минуя
  // согласие.
  if (callbackData && DATA_CALLBACKS.has(callbackData)) {
    return handleDataCallback(ctx, callbackData);
  }

  // Вопросы обратной связи приходят через сутки и через неделю, когда
  // человек уже где угодно по сценарию, — разбираем их до стадий.
  if (callbackData && FEEDBACK_CALLBACK_PREFIXES.some((p) => callbackData.startsWith(p))) {
    return handleFeedbackCallback(ctx, callbackData);
  }

  // Меню разбираем до проверки согласия, и это осознанно: в нём лежат
  // «Документы», то есть ровно то, что человек может захотеть прочитать
  // ПЕРЕД тем, как дать согласие. Пустить дальше анкеты это не может:
  // «Начать заново» ведёт на экран условий, а оттуда — на
  // согласие, если его нет.
  if (callbackData === "menu_example") {
    return handleExampleCallback(ctx, session, "example_menu");
  }

  if (callbackData && MENU_CALLBACKS.has(callbackData)) {
    return handleMenuCallback(ctx, session, callbackData);
  }

  // Пример разбора разбирается до шлюза согласия и до стадий: он
  // ничего о человеке не собирает и не показывает, а кнопки под ним
  // остаются в чате и должны работать откуда угодно.
  if (callbackData?.startsWith("example_")) {
    return handleExampleCallback(ctx, session, callbackData);
  }

  if (callbackData === "restart_yes") return confirmRestart(ctx, session);
  if (callbackData === "restart_no") return cancelRestart(ctx, session);

  // Кнопка из напоминания о незаконченной анкете. Тоже до стадий:
  // напоминание висит в чате, и нажать его могут когда угодно.
  if (callbackData === "quiz_continue") return handleQuizContinue(ctx, session);

  if (!(await allowedWithoutPdConsent(session, callbackData))) {
    return askPdConsentFirst(ctx, session);
  }

  // Вопрос о рассылке приходит после анкеты и живёт в чате дальше:
  // разбираем его до стадий, как оффер и предложение после покупки.
  if (callbackData === "marketing_yes" || callbackData === "marketing_no") {
    return handleMarketingAnswer(ctx, session, callbackData);
  }

  if (callbackData?.startsWith("offer_")) {
    return handleOffer(ctx, session, callbackData);
  }

  // Предложение после покупки плана приходит, когда родитель давно
  // прошёл весь сценарий, — его кнопки тем более не должны зависеть от
  // стадии, в которой он остановился.
  if (callbackData?.startsWith("upsell_")) {
    return handleUpsell(ctx, session, callbackData);
  }

  // Выбор родителя по заявке на консультацию тоже разбираем до стадий, и
  // по той же причине: клавиатура согласия — reply-клавиатура, она висит
  // внизу чата и может переехать за пределы той стадии, в которой её
  // показали. Нажатие должно сработать всё равно.
  const contact = ctx.message?.contact;
  if (contact) {
    // Если ждать контакт было незачем — молчим: человек просто переслал
    // визитку, отвечать на это нечего.
    await takeConsultContact(ctx, session, contact);
    return;
  }

  if (messageText === CONSULT_SELF_WRITE_BUTTON) {
    if (await takeConsultSelfWrite(ctx, session)) return;
  }

  if (messageText === CONSULT_CANCEL_BUTTON) {
    if (await takeConsultCancel(ctx, session)) return;
  }

  // Комментарий к вопросу обратной связи — обычное текстовое
  // сообщение, поэтому ловим его до разбора по стадиям. Если ждать
  // нечего, сообщение идёт дальше как раньше.
  if (messageText && (await takeFeedbackComment(ctx, messageText))) return;

  // Кнопка «Прислать гид» живёт в ветке «не подходит», где сессия уже
  // вернулась в исходное состояние, — поэтому разбираем её до стадий.
  if (callbackData === "health_guide") return sendHealthGuide(ctx);

  // Команда, которую бот не знает. Ответом на вопрос анкеты она быть не
  // может: показываем текущий экран заново и ничего не сохраняем.
  //
  // Посреди анкеты сюда почти всегда приходит /start, и человек жмёт её,
  // чтобы начать сначала. Один и тот же вопрос в ответ выглядит так,
  // будто бот не услышал, — поэтому сначала объясняем, где он
  // остановился и какая команда начинает заново. Приписка живёт здесь, а
  // не в resendCurrentStep: тот же повтор вопроса делает кнопка
  // «Вернуться к анкете», и ей объяснять нечего.
  if (messageText && looksLikeCommand(messageText)) {
    if (isStartCommand(messageText)) return handleStartCommand(ctx, session);
    if (inQuestionnaire(session)) await replyStatic(ctx, texts.startDuringQuiz);
    return resendCurrentStep(ctx, session);
  }

  switch (session.stage) {
    case "TERMS_HEALTH":
      return handleTermsHealth(ctx, session, callbackData);
    // Сессии, заведённые до объединения экранов: переводим на новый,
    // не теряя людей посреди онбординга.
    case "TERMS":
    case "HEALTH_SCREEN":
      return goToTermsHealth(ctx, session);
    case "PD_CONSENT":
      return handlePdConsent(ctx, session, callbackData);
    // Стадия прежнего онбординга. Кнопки разбираются выше, сюда
    // доходит текст вместо нажатия — показываем вопрос заново.
    case "MARKETING_CONSENT":
      return sendMarketingConsent(ctx);
    case "WELCOME":
      return handleWelcome(ctx, session, callbackData, messageText);
    case "WELCOME_VALUE":
      return handleWelcomeValue(ctx, session, callbackData);
    case "STEPS":
      return handleSteps(ctx, session, callbackData);
    case "HOW_IT_WORKS":
      return handleHowItWorks(ctx, session, callbackData);
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
    case "CONSULT_REQUEST":
      return handleConsultRequestStage(ctx, session, callbackData, messageText);
    case "CONSULT_CONSENT":
      return remindAboutConsentOnce(ctx, session);
    case "CSAT_RATING":
      return handleCsatRating(ctx, session, callbackData);
    case "CSAT_FEEDBACK":
      return handleCsatFeedback(ctx, session, messageText);
    case "CSAT_DONE":
      await logOfferEvent(session.telegramId, "unrecognized_input");
      return replyStatic(ctx, texts.csatThankYou);
    case "DECLINED":
    case "OUT_OF_RANGE":
    case "RED_FLAG_ENDED":
      return resetToWelcomeAndSend(ctx, session);
  }
}

// Параметр команды /start: «/start utm_vk» → «utm_vk». Длину режем,
// потому что в deep-link можно положить что угодно, а поле источника
// нужно для группировки, а не для хранения мусора.
function startPayload(text?: string): string | undefined {
  const match = text?.match(/^\/start(?:@\S+)?\s+(\S{1,64})/);
  return match?.[1];
}

// ── Возврат к прерванному шагу (кнопка из меню) ─────────────────────
//
// Меню можно открыть в любой момент, в том числе посреди анкеты. Чтобы
// человек не остался без последнего вопроса под стопкой новых
// сообщений, кнопка «Вернуться к анкете» стоит и пятой в самом меню, и
// под каждым его пунктом. Она присылает текущий вопрос заново и ничего
// не меняет в состоянии.
//
// Стадии перечислены явно, а не через вызов обработчиков: обработчик,
// позванный без ввода, местами отвечает «напишите ответ текстом», и
// для возврата это не годится.

// Идёт ли анкета прямо сейчас — то есть есть ли вопрос, который можно
// прислать заново.
//
// Условие намеренно узкое. Кнопка обещает вернуть к анкете, и показывать
// её там, где анкеты нет, значит путать: до её начала возвращаться
// некуда, а после — незачем, человек уже всё ответил. Поэтому ни
// приветственные экраны, ни согласия, ни оффер, ни CSAT сюда не входят.
//
// Сверку ответов и правку тоже не считаем: там нет «текущего вопроса»,
// там итоговая анкета, и кнопка прислала бы не то, что обещает.
export function inQuestionnaire(session: Session): boolean {
  if (session.stage !== "QUESTION" && session.stage !== "EDIT_ANSWER") return false;
  const qNum = session.currentQuestionNumber;
  // Вопрос мог быть убран из анкеты: присылать нечего.
  return qNum != null && safeGetQuestion(qNum) !== null;
}

// Присылает текущий экран заново. Состояние сессии не меняет.
export async function resendCurrentStep(ctx: Context, session: Session) {
  switch (session.stage) {
    case "WELCOME":
      return sendWelcome(ctx);
    case "WELCOME_VALUE":
      return sendWelcomeValue(ctx);
    case "STEPS":
      return sendSteps(ctx);
    case "HOW_IT_WORKS":
      return replyStatic(ctx, texts.howItWorks, { reply_markup: howItWorksKeyboard() });
    case "TERMS":
    case "TERMS_HEALTH":
    case "HEALTH_SCREEN":
      return sendTermsHealth(ctx);
    case "PD_CONSENT":
      return sendPdConsent(ctx);
    case "MARKETING_CONSENT":
      return sendMarketingConsent(ctx);
    case "QUESTION":
    case "EDIT_ANSWER": {
      const qNum = session.currentQuestionNumber;
      const question = qNum == null ? null : safeGetQuestion(qNum);
      // Вопрос мог быть убран из анкеты: возвращать человека некуда,
      // но и молчать нельзя — показываем начало.
      if (!question) return sendWelcome(ctx);
      return sendQuestionPrompt(ctx, question, session.tempSelections);
    }
    case "SUMMARY_REVIEW":
      return sendSummary(ctx, session.telegramId);
    case "EDIT_PICK_QUESTION":
    case "EDIT_MORE":
      // У правки ответов свой короткий диалог; его начало — итоговая
      // анкета, с неё и продолжаем.
      return sendSummary(ctx, session.telegramId);
    case "FAKE_DOOR_OFFER":
      return sendOfferMessages(ctx.api, session.chatId);
    case "CSAT_RATING":
      return replyStatic(ctx, texts.csatPrompt, { reply_markup: csatKeyboard() });
    case "CSAT_FEEDBACK":
      return replyStatic(ctx, texts.csatFeedbackPrompt);
    case "CONSULT_REQUEST":
      return replyStatic(ctx, texts.consultRequestAsk, {
        reply_markup: consultRequestKeyboard(),
      });
    case "CONSULT_CONSENT":
      // То же, что и на обычный текст в этой стадии: напоминаем про
      // контакт один раз.
      return remindAboutConsentOnce(ctx, session);
    case "AWAITING_RECOMMENDATION":
      // Падать в обработчик стадии нельзя: он сохранил бы «/start»
      // дополнением к анкете.
      return replyStatic(ctx, texts.startWhileAnalysisPending);
    // Сценарий кончился: повторять нечего. Молчать тоже нельзя — бот
    // выглядел бы мёртвым ровно тогда, когда человек вернулся сам.
    // Ведём в /restart, а не сбрасываем на приветствие: сброс начал бы
    // новую анкету внутри старой попытки, и новые ответы легли бы
    // вперемешку с прошлыми.
    case "CSAT_DONE":
    case "DECLINED":
    case "OUT_OF_RANGE":
    case "RED_FLAG_ENDED":
    // Стадия не используется с 15.10.2026, но сессия могла в ней
    // застрять: без этой ветки она не отвечает ни на что.
    case "DECLINE_REASON":
      return replyStatic(ctx, texts.startAfterFinish);
    default:
      return;
  }
}

// ── Меню: маршрутизация и перезапуск анкеты ─────────────────────────

// Пункт меню присылает новое сообщение, а само меню не трогает: п.2 ТЗ
// просит, чтобы оно осталось рабочим и после нажатия.
async function handleMenuCallback(ctx: Context, session: Session, callbackData: string) {
  const back = inQuestionnaire(session);

  switch (callbackData) {
    case "menu_restart":
      return askRestart(ctx, session);
    case "menu_support":
      await logOfferEvent(session.telegramId, "menu_support");
      return sendSupport(ctx, back);
    case "menu_docs":
      await logOfferEvent(session.telegramId, "menu_docs");
      return sendDocs(ctx, back);
    case "menu_team":
      await logOfferEvent(session.telegramId, "menu_team");
      return sendTeam(ctx, back);
    case "menu_root":
      // Возврат в меню из раздела. Событие то же, что у /menu: для
      // статистики это такой же показ меню, и разделять их нечем —
      // человек в обоих случаях на него смотрит.
      await logOfferEvent(session.telegramId, "menu_opened");
      return sendMenu(ctx, back);
    case "menu_back":
      // Следом resendCurrentStep напишет quiz_question_shown: по паре
      // событий видно, откуда человек вернулся.
      await logOfferEvent(session.telegramId, "menu_back_to_quiz");
      return resendCurrentStep(ctx, session);
  }
}

// Команды меню: /menu, /support, /docs, /team, /restart.
//
// Начинаем с того же, с чего handleIncoming: закрытый режим — первым
// делом, до всякой записи в базу. Команда для человека не из списка не
// должна оставить даже сессии.
//
// Согласие на обработку данных здесь не проверяется по той же причине,
// по которой не проверяется в handleIncoming для кнопок меню: в меню
// лежат «Документы», и читать их человек вправе до согласия. В анкету
// меню не ведёт — «Начать заново» упирается в экран согласия.
export type MenuCommand = "menu" | "support" | "docs" | "team" | "restart";

export async function handleMenuCommand(ctx: Context, which: MenuCommand) {
  const from = ctx.from;
  if (!from || !ctx.chat) return;

  if (!isAllowed(from.id)) return replyStatic(ctx, texts.notOpenYet);

  const session = await getOrCreateSession(
    BigInt(from.id),
    BigInt(ctx.chat.id),
    from.first_name
  );
  const back = inQuestionnaire(session);

  switch (which) {
    case "menu":
      await logOfferEvent(session.telegramId, "menu_opened");
      return sendMenu(ctx, back);
    case "support":
      await logOfferEvent(session.telegramId, "menu_support");
      return sendSupport(ctx, back);
    case "docs":
      await logOfferEvent(session.telegramId, "menu_docs");
      return sendDocs(ctx, back);
    case "team":
      await logOfferEvent(session.telegramId, "menu_team");
      return sendTeam(ctx, back);
    case "restart":
      return askRestart(ctx, session);
  }
}

// Подтверждение перезапуска. Предупреждение про готовящийся разбор
// встаёт перед кнопками: человек должен узнать о потере до того, как
// нажмёт, а не после.
// Есть ли в текущем прохождении хоть один ответ. По этому и решаем,
// нужно ли новое прохождение: пустое заводить незачем.
async function hasAnswersInAttempt(telegramId: bigint): Promise<boolean> {
  const answers = await prisma.answer.count({
    where: await answersOfCurrentAttempt(telegramId),
  });
  return answers > 0;
}

// Стадии, на которых человеку есть что терять: анкета не дошла до
// конца, и новое прохождение стёрло бы работу, которую он уже сделал.
// Здесь /start спрашивает, а не действует.
const UNFINISHED_STAGES: Stage[] = [
  "QUESTION",
  "EDIT_ANSWER",
  "SUMMARY_REVIEW",
  "EDIT_PICK_QUESTION",
  "EDIT_MORE",
];

// /start.
//
// Команда означает «начать сначала», и показывать по ней текущий экран
// значит не ответить на просьбу. Но начать сначала — это новое
// прохождение, иначе новые ответы легли бы поверх старых внутри одного
// и того же, и брошенная на середине анкета дала бы разбор по смеси
// (см. beginNewAttempt).
//
// Поэтому три исхода, и выбор между ними — по тому, что человек теряет:
// идёт анкета или ждёт разбор — спрашиваем; прохождение завершено —
// заводим новое молча; ответов ещё нет — просто приветствие.
async function handleStartCommand(ctx: Context, session: Session) {
  if (UNFINISHED_STAGES.includes(session.stage)) return askRestart(ctx, session);

  // Разбор ещё не отправлен: новое прохождение его отменит, и человек
  // должен об этом узнать до, а не после. Текст предупреждения
  // подставит сам askRestart.
  if (await pendingRecommendation(session.telegramId)) return askRestart(ctx, session);

  if (await hasAnswersInAttempt(session.telegramId)) {
    await beginNewAttempt(session, "start");
  } else {
    // Прохождение заводить незачем, но на приветствие сессию перевести
    // обязательно. Иначе человек видит первый экран, а бот считает, что
    // он всё ещё на прежнем, и следующая кнопка уходит в его обработчик:
    // «Что я получу?» с застрявшей стадией TERMS_HEALTH возвращала
    // экран условий.
    await prisma.session.update({
      where: { telegramId: session.telegramId },
      data: { stage: "WELCOME", status: "onboarding", resumeStage: null },
    });
  }

  return sendWelcome(ctx);
}

// Событие пишется здесь, а не у вызывающих: экран подтверждения
// открывается из меню, по /restart и по /start, и забытая разметка в
// одном из трёх мест дала бы в /stats «подтвердили больше, чем
// спросили».
async function askRestart(ctx: Context, session: Session) {
  await logOfferEvent(session.telegramId, "restart_asked");
  const pending = await pendingRecommendation(session.telegramId);
  const text = pending
    ? `${texts.restartConfirm}\n\n${texts.restartPendingWarning}`
    : texts.restartConfirm;

  return replyStatic(ctx, text, { reply_markup: restartConfirmKeyboard() });
}

// Обе кнопки подтверждения заменяют текст самого сообщения и убирают
// клавиатуру: п.3 требует, чтобы повторное нажатие ничего не делало, а
// без клавиатуры нажать второй раз просто нечего.
async function replaceConfirmMessage(ctx: Context, text: string, keyboard?: InlineKeyboard) {
  const markup = keyboard ? { reply_markup: keyboard } : undefined;
  try {
    await ctx.editMessageText(text, markup);
  } catch (error) {
    // Сообщение могли удалить, или оно слишком старое для правки.
    // Тогда отвечаем обычным сообщением: человек должен увидеть ответ.
    console.error("Не удалось заменить сообщение подтверждения:", error);
    await replyStatic(ctx, text, markup);
  }
}

async function cancelRestart(ctx: Context, session: Session) {
  await logOfferEvent(session.telegramId, "restart_cancelled");

  // Кнопка возврата встаёт на то же сообщение, а не приходит вторым:
  // иначе человек увидел бы «Хорошо, продолжаем» дважды.
  return replaceConfirmMessage(
    ctx,
    texts.restartCancelled,
    inQuestionnaire(session) ? backToQuizKeyboard() : undefined
  );
}

// Собственно перезапуск. Ничего не удаляет: прохождение получает новый
// номер, и всё прошлое остаётся в базе, просто перестаёт попадать в
// новый разбор (см. attempt.ts).
async function confirmRestart(ctx: Context, session: Session) {
  const telegramId = session.telegramId;

  // Повторное нажатие. Кнопки убираются вместе с текстом сообщения, так
  // что обычно нажать второй раз нечего, — но если человек открыл меню
  // дважды, в чате висят два подтверждения, и у второго кнопки живые.
  //
  // Признак того, что перезапуск уже случился: человек стоит на первом
  // экране нового прохождения и ответить ещё ничего не успел. Второй
  // раз номер прохождения не увеличиваем, иначе в базе появились бы
  // пустые прохождения, а в /stats — лишние перезапуски.
  if (session.stage === "WELCOME" && !(await hasAnswersInAttempt(telegramId))) {
    await replaceConfirmMessage(ctx, texts.restartStarted);
    return sendWelcome(ctx);
  }

  await beginNewAttempt(session, "restart");
  await replaceConfirmMessage(ctx, texts.restartStarted);

  // Дальше путь онбординга с самого начала. Экран условий
  // человек увидит снова — состояние малыша могло измениться, — а
  // согласия, на которые ответ уже есть, пропустятся сами.
  return sendWelcome(ctx);
}

// Заводит новое прохождение. Ничего не удаляет: прошлое остаётся в
// базе, просто перестаёт попадать в новый разбор (см. attempt.ts).
//
// Общая часть двух путей: подтверждённого перезапуска и молчаливого
// возврата через /start, когда терять нечего. Отдельной функцией,
// потому что забыть здесь любую строку — значит получить прохождение,
// которое тащит за собой хвост прошлого: невыключенные напоминания,
// недосброшенный номер вопроса или разбор, который придёт по уже
// переписанным ответам.
type NewAttemptReason = "restart" | "start";

async function beginNewAttempt(session: Session, reason: NewAttemptReason) {
  const telegramId = session.telegramId;

  // Разбор, который ждал проверки, не придёт: он про ответы, которые
  // человек сейчас перепишет. Отменяем до смены номера прохождения,
  // пока он ещё считается текущим.
  const pending = await pendingRecommendation(telegramId);
  if (pending) {
    await prisma.recommendation.update({
      where: { id: pending.id },
      data: {
        status: "cancelled",
        cancelReason: "пользователь начал заново",
        cancelledAt: new Date(),
      },
    });
  }

  // Номер прохождения передаём явно: это событие закрывает прежнее
  // прохождение, а не открывает новое. Полагаться на то, что сессию
  // увеличат строкой ниже, а не выше, слишком хрупко.
  const event =
    reason === "start"
      ? "start_new_attempt"
      : pending
        ? "restart_confirmed_cancelled_draft"
        : "restart_confirmed";
  await logOfferEvent(telegramId, event, { attempt: session.attempt });

  // Напоминания прошлого прохождения больше не нужны: у нового будут
  // свои, и начнутся они с показа первого вопроса.
  await stopQuizReminders(telegramId, session.attempt, "начал анкету заново");

  await prisma.session.update({
    where: { telegramId },
    data: {
      attempt: { increment: 1 },
      stage: "WELCOME",
      status: "onboarding",
      currentQuestionNumber: null,
      resumeStage: null,
      tempSelections: [],
      yellowFlags: [],
    },
  });
}

// Куда идти после экрана условий.
//
// У того, кто начал заново, согласия, на которые ответ уже есть в
// журнале, второй раз не спрашиваем (п.3 ТЗ). Первое прохождение идёт
// ровно как раньше — через экран согласия на данные, — и отличаем мы их
// по номеру прохождения, а не по новому полю: attempt > 1 бывает только
// после «Начать заново».
//
// Почему не пропускать согласия всем, у кого ответ уже есть: у тех, кто
// начал пользоваться ботом до появления согласий, экраны показываются
// посреди сценария, и этот путь менять не просили.
async function afterTermsHealth(ctx: Context, session: Session) {
  // Спрашиваем по факту согласия, а не по номеру прохождения. Эти
  // условия расходятся на том, кто дал согласие, но анкету не закончил:
  // он остаётся на первом прохождении, и по номеру экран согласия
  // показали бы ему второй раз, хотя ответ уже лежит в журнале.
  //
  // Без согласия на обработку данных дальше нельзя никому и никогда.
  const pd = await getConsent(session.telegramId, "PD_PROCESSING");
  if (pd.action !== "GRANTED") return goToPdConsent(ctx, session);

  // Про рассылку здесь больше не спрашиваем: вопрос переехал за анкету,
  // чтобы не стоять между человеком и первым вопросом.
  return startQuestionnaire(ctx, session);
}

// ── Команды, набранные посреди сценария ─────────────────────────────

// Команда — это не ответ на вопрос. До появления меню такое сообщение
// сохранялось как ответ: человек писал «/start» посреди анкеты, и
// строка «/start» уезжала в разбор, а в ожидании разбора — в
// дополнения к анкете. Незарегистрированные команды до сих могут
// прийти сюда, и сохранять их нельзя.
//
// Зарегистрированные команды (/menu, /data и прочие) сюда не доходят
// вовсе: grammY разбирает их раньше общего обработчика текста.
function looksLikeCommand(text: string): boolean {
  return /^\/[A-Za-z0-9_]+(@[A-Za-z0-9_]+)?(\s|$)/.test(text);
}

// Та же форма, что у looksLikeCommand: имя бота после «@» Telegram
// добавляет сам в группах, а параметр deep-link идёт через пробел.
function isStartCommand(text: string): boolean {
  return /^\/start(@[A-Za-z0-9_]+)?(\s|$)/.test(text);
}

// ── Закрытый режим ──────────────────────────────────────────────────

// Пустой список значит «бот открыт». Админ в списке всегда: иначе бот
// можно закрыть и от себя тоже (см. env.ts).
export function isAllowed(telegramId: number | bigint): boolean {
  if (!env.ALLOWED_USER_IDS.length) return true;
  return env.ALLOWED_USER_IDS.includes(String(telegramId));
}

// ── Воронка онбординга ──────────────────────────────────────────────

// Шаги онбординга по порядку. Этот же порядок рисуется в /stats, так
// что менять его нужно здесь, а не в двух местах.
export const ONBOARDING_FUNNEL = [
  "onb_welcome",
  "onb_welcome_value",
  // Условия и здоровье — один экран с 15.10.2026, поэтому и шаг один.
  // Значение onb_health осталось в enum ради записей, сделанных раньше.
  "onb_terms",
  "onb_pd_consent",
  "onb_marketing",
  "onb_go",
  // Был quiz_q1, который с 20.10.2026 не пишется.
  "quiz_question_shown",
  "quiz_completed",
] as const;

type OnboardingEvent = OfferEventName;

// Было ли такое событие хоть раз. Нужно ровно в двух местах, где
// однократность — свойство продукта, а не статистики: гайд отправляется
// один раз на человека, и по наличию onb_welcome опознаётся тот, кто
// застал прежнее приветствие.
async function hasOnboardingEvent(telegramId: number | bigint, type: OnboardingEvent) {
  const existing = await prisma.offerEvent.findFirst({
    where: { telegramId: BigInt(telegramId), type },
  });
  return existing !== null;
}

// Показ экрана онбординга. С 20.10.2026 пишется каждый раз, а не один
// раз на человека: по журналу должно быть видно и второй проход, и
// возврат к онбордингу после «Начать заново». Уникальных людей считаем
// в SQL через DISTINCT (см. analytics/funnel.sql).
//
// Отдельное имя оставлено ради читаемости вызовов: на экранах
// онбординга «logOnboarding» говорит больше, чем «logEvent».
async function logOnboarding(telegramId: number | bigint, type: OnboardingEvent) {
  await logEvent(telegramId, type);
}

// ── Онбординг ────────────────────────────────────────────────────────

async function sendWelcome(ctx: Context) {
  await logOnboarding(ctx.from!.id, "onb_welcome");
  return replyStatic(ctx, texts.welcome, { reply_markup: welcomeKeyboard() });
}

async function sendWelcomeValue(ctx: Context) {
  await logOnboarding(ctx.from!.id, "onb_welcome_value");
  return replyStatic(ctx, texts.welcomeValue, { reply_markup: welcomeValueKeyboard() });
}

async function goToWelcomeValue(ctx: Context, session: Session) {
  // Кнопку первого сообщения убираем, чтобы на неё не нажали второй раз.
  await dropKeyboard(ctx);
  await prisma.session.update({
    where: { telegramId: session.telegramId },
    data: { stage: "WELCOME_VALUE" },
  });
  return sendWelcomeValue(ctx);
}

async function handleWelcome(
  ctx: Context,
  session: Session,
  callbackData?: string,
  messageText?: string
) {
  if (callbackData === "welcome_value") return goToWelcomeValue(ctx, session);

  // /start всегда показывает первый экран: по нему человек и приходит
  // знакомиться, в том числе тот, кто застал прежнее приветствие.
  if (messageText === "/start") return sendWelcome(ctx);

  // «Получить разбор» и «Как я работаю» — кнопки нового приветствия.
  // Те же callback висят под старыми сообщениями в чатах, и ведут они
  // теперь туда же: «Как я работаю» — на экран трёх шагов.
  if (callbackData === "start") return goToTermsHealth(ctx, session);
  if (callbackData === "how_it_works") return goToSteps(ctx, session);

  // Написал текстом вместо нажатия — показываем приветствие заново.
  return sendWelcome(ctx);
}

// Экран не в основном пути с 27.10.2026, но стадия жива: на ней стоят
// те, кто открыл его старой кнопкой. «Как я работаю» отсюда ведёт на
// экран трёх шагов, как и с приветствия.
async function handleWelcomeValue(ctx: Context, session: Session, callbackData?: string) {
  if (callbackData === "start") return goToTermsHealth(ctx, session);
  if (callbackData === "how_it_works") return goToSteps(ctx, session);
  return sendWelcomeValue(ctx);
}

// Три шага до плана. Необязательный экран: в основной путь не входит,
// на него уводит «Как я работаю» с приветствия.
async function sendSteps(ctx: Context) {
  await logOnboarding(ctx.from!.id, "onb_steps");
  return replyStatic(ctx, texts.steps, { reply_markup: stepsKeyboard() });
}

async function goToSteps(ctx: Context, session: Session) {
  // Кнопки приветствия убираем: на них не нужно нажимать второй раз.
  await dropKeyboard(ctx);
  await prisma.session.update({
    where: { telegramId: session.telegramId },
    data: { stage: "STEPS" },
  });
  return sendSteps(ctx);
}

async function handleSteps(ctx: Context, session: Session, callbackData?: string) {
  if (callbackData === "start") return goToTermsHealth(ctx, session);
  if (callbackData === "my_approach") return goToHowItWorks(ctx, session);
  return sendSteps(ctx);
}

async function goToHowItWorks(ctx: Context, session: Session) {
  await prisma.session.update({
    where: { telegramId: session.telegramId },
    data: { stage: "HOW_IT_WORKS" },
  });
  await logOnboarding(ctx.from!.id, "onb_how_it_works");
  return replyStatic(ctx, texts.howItWorks, { reply_markup: howItWorksKeyboard() });
}

async function handleHowItWorks(ctx: Context, session: Session, callbackData?: string) {
  if (callbackData === "start") return goToTermsHealth(ctx, session);
  return replyStatic(ctx, texts.howItWorks, { reply_markup: howItWorksKeyboard() });
}

// ── Обезличенный счётчик ────────────────────────────────────────────

// Имя счётчика ухода с экрана здоровья. По этой строке его видно и в
// базе, и в /stats.
const HEALTH_EXIT_COUNTER = "health_screen_exit";

// Прибавляет единицу к счётчику за сегодня. Намеренно не знает, кто
// нажал кнопку: в таблице нет ни telegram id, ни связи с сессией.
// Сбой счётчика не должен ломать ответ человеку, поэтому ошибку только
// логируем.
async function bumpDailyCounter(name: string): Promise<void> {
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);

  try {
    await prisma.dailyCounter.upsert({
      where: { name_day: { name, day } },
      create: { name, day, count: 1 },
      update: { count: { increment: 1 } },
    });
  } catch (error) {
    console.error(`Не удалось увеличить счётчик ${name}:`, error);
  }
}

// ── Условия и здоровье малыша ───────────────────────────────────────
//
// Один экран с 15.10.2026: раньше условия и блок про здоровье были
// двумя шагами подряд, и отдельная кнопка «Понятно, дальше» между ними
// ничего не решала.
//
// Вопросов о здоровье бот не задаёт. Вместо них — самоподтверждение:
// родитель сам сверяется со списком и решает, подхожу я ему или нет.
// Поэтому здесь нет ни ответа, который можно сохранить, ни причины,
// которую можно записать.

async function sendTermsHealth(ctx: Context) {
  await logOnboarding(ctx.from!.id, "onb_terms");
  return replyStatic(ctx, texts.termsHealth, { reply_markup: healthScreenKeyboard() });
}

async function goToTermsHealth(ctx: Context, session: Session) {
  await prisma.session.update({
    where: { telegramId: session.telegramId },
    data: { stage: "TERMS_HEALTH" },
  });
  return sendTermsHealth(ctx);
}

async function handleTermsHealth(ctx: Context, session: Session, callbackData?: string) {
  if (callbackData === "health_ok") {
    // Подтверждение — такое же юридически значимое действие, как
    // согласие: пишем в журнал до того, как пустить дальше. Документа
    // за ним не стоит, человек подтверждает факт о себе. В журнал идёт
    // весь экран целиком, вместе с условиями, — именно это он видел.
    const saved = await saveConsent(ctx, {
      telegramId: session.telegramId,
      type: "HEALTH_SELF_DECLARATION",
      action: "GRANTED",
      source: "ONBOARDING",
      documents: [],
      messageText: texts.termsHealth,
      buttonText: HEALTH_OK,
      telegramMessageId: ctx.callbackQuery?.message?.message_id,
    });
    if (!saved) return;

    await logOfferEvent(session.telegramId, "onb_health_ok");
    await dropKeyboard(ctx);
    return afterTermsHealth(ctx, session);
  }

  if (callbackData === "health_stop") return handleHealthExit(ctx, session);

  return sendTermsHealth(ctx);
}

// Родитель сказал, что что-то из списка есть. О причине не сохраняем
// ничего: ни записи в журнале, ни ответа, ни статуса — это данные о
// здоровье, собирать которые бот и перестал. Сессию возвращаем в
// исходное состояние, как будто человек ещё не начинал: если ситуация
// изменится, он пройдёт путь заново с чистого листа.
async function handleHealthExit(ctx: Context, session: Session) {
  await dropKeyboard(ctx);
  await prisma.session.update({
    where: { telegramId: session.telegramId },
    data: { stage: "WELCOME", status: "onboarding", resumeStage: null },
  });

  // Единственный след — обезличенный счётчик по дням, по которому
  // нельзя понять, кто именно ушёл.
  await bumpDailyCounter(HEALTH_EXIT_COUNTER);

  return replyStatic(ctx, texts.healthNotSuitable, { reply_markup: healthGuideKeyboard() });
}

// Кнопку убираем сразу: гид отправляется один раз, а повторные нажатия
// присылали бы один и тот же файл снова.
async function sendHealthGuide(ctx: Context) {
  await dropKeyboard(ctx);
  try {
    await sendCachedDocument(ctx, projectFile(GUIDE_PDF), texts.healthGuideCaption);
  } catch (error) {
    console.error("Не удалось отправить гид в ветке «не подходит»:", error);
    await replyStatic(ctx, texts.healthGuideCaption);
  }
}

// ── Согласие на обработку персональных данных ───────────────────────

// Единственное сообщение бота с разметкой: адреса документов приходят
// из переменных окружения, и в HTML они должны быть обезврежены — иначе
// кавычка в адресе разорвёт тег.
function pdConsentText(): string {
  return texts.pdConsent(escapeHtml(env.PRIVACY_POLICY_URL), escapeHtml(env.PD_CONSENT_URL));
}

async function sendPdConsent(ctx: Context) {
  await logOnboarding(ctx.from!.id, "onb_pd_consent");
  return replyStatic(ctx, pdConsentText(), {
    link_preview_options: { is_disabled: true },
    reply_markup: pdConsentKeyboard(),
  });
}

async function goToPdConsent(ctx: Context, session: Session) {
  await prisma.session.update({
    where: { telegramId: session.telegramId },
    data: { stage: "PD_CONSENT" },
  });
  return sendPdConsent(ctx);
}

// Записываем согласие и только потом отвечаем. Не записалось — ничего
// не делаем: согласие, которого нет в журнале, для проверяющей стороны
// не существует, и пускать человека дальше с ним нельзя.
async function saveConsent(ctx: Context, input: Parameters<typeof recordConsent>[0]): Promise<boolean> {
  try {
    await recordConsent(input);
    return true;
  } catch (error) {
    console.error(`Не удалось записать согласие ${input.type} для #${input.telegramId}:`, error);
    await logOfferEvent(input.telegramId, "consent_write_failed");
    await replyStatic(ctx, texts.consentSaveFailed).catch(() => {});
    return false;
  }
}

async function handlePdConsent(ctx: Context, session: Session, callbackData?: string) {
  if (callbackData === "pd_consent_yes" || callbackData === "pd_consent_no") {
    const granted = callbackData === "pd_consent_yes";
    const saved = await saveConsent(ctx, {
      telegramId: session.telegramId,
      type: "PD_PROCESSING",
      action: granted ? "GRANTED" : "DECLINED",
      source: "ONBOARDING",
      documents: ["PRIVACY_POLICY", "PD_CONSENT"],
      messageText: pdConsentText(),
      buttonText: granted ? PD_CONSENT_YES : PD_CONSENT_NO,
      telegramMessageId: ctx.callbackQuery?.message?.message_id,
    });
    if (!saved) return;

    await logOfferEvent(session.telegramId, granted ? "onb_pd_granted" : "onb_pd_declined");
    await dropKeyboard(ctx);
    // Сразу в анкету: про рассылку спросим после неё.
    if (granted) return afterConsents(ctx, session);

    // Стадию не меняем: /start после отказа должен вернуть к этому же
    // экрану, а не показывать приветствие заново.
    return replyStatic(ctx, texts.pdConsentDeclined);
  }

  // Нажали кнопку старого сообщения или написали текстом — показываем
  // экран ещё раз: без согласия дальше всё равно нельзя.
  return sendPdConsent(ctx);
}

// ── Согласие на рекламную рассылку ──────────────────────────────────

function marketingConsentText(): string {
  return texts.marketingConsent(escapeHtml(env.MARKETING_CONSENT_URL));
}

async function sendMarketingConsent(ctx: Context) {
  await logOnboarding(ctx.from!.id, "onb_marketing");
  return replyStatic(ctx, marketingConsentText(), {
    link_preview_options: { is_disabled: true },
    reply_markup: marketingConsentKeyboard(),
  });
}

// Ответ на вопрос о рассылке.
//
// Разбирается до стадий и стадию не меняет: вопрос приходит после
// анкеты, и к моменту нажатия человек может уже ждать разбор, читать
// оффер или начать новое прохождение. Привязывать ответ к стадии
// значит потерять его у всех, кто нажал не сразу.
async function handleMarketingAnswer(ctx: Context, session: Session, callbackData: string) {
  const granted = callbackData === "marketing_yes";

  // Нажали второй раз или вернулись к старому сообщению: ответ уже в
  // журнале, второй записи там быть не должно. Клавиатуру всё равно
  // убираем — иначе кнопки выглядят живыми.
  const current = await getConsent(session.telegramId, "MARKETING");
  if (current.action === "GRANTED" || current.action === "DECLINED") {
    return dropKeyboard(ctx);
  }

  const saved = await saveConsent(ctx, {
    telegramId: session.telegramId,
    type: "MARKETING",
    action: granted ? "GRANTED" : "DECLINED",
    source: "ONBOARDING",
    documents: ["MARKETING_CONSENT"],
    messageText: marketingConsentText(),
    buttonText: granted ? MARKETING_YES : MARKETING_NO,
    telegramMessageId: ctx.callbackQuery?.message?.message_id,
  });
  if (!saved) return;

  await logOfferEvent(session.telegramId, granted ? "onb_marketing_yes" : "onb_marketing_no");
  await dropKeyboard(ctx);

  // Переходный случай: человек стоит на экране рассылки прежнего
  // онбординга, и для него этот ответ — последний шаг перед анкетой.
  if (session.stage === "MARKETING_CONSENT") return afterConsents(ctx, session);

  return replyStatic(ctx, granted ? texts.marketingThanksYes : texts.marketingThanksNo);
}

// Вопрос о рассылке после завершённой анкеты.
//
// Спрашиваем один раз в жизни: отказ — это тоже ответ. Привязан к концу
// анкеты, а не к отправке гайда: гайд уходит один раз на человека, и на
// втором прохождении вопрос не достался бы тому, кто ещё не отвечал.
//
// Молчит при любой ошибке: это последнее сообщение в цепочке после
// анкеты, и ронять из-за него гайд и разбор нельзя.
async function askMarketingAfterQuiz(ctx: Context, telegramId: bigint) {
  try {
    const current = await getConsent(telegramId, "MARKETING");
    if (current.action === "GRANTED" || current.action === "DECLINED") return;
    await sendMarketingConsent(ctx);
  } catch (error) {
    console.error("Не удалось спросить про рассылку после анкеты:", error);
  }
}

// Куда идти после согласий: новичок начинает анкету, а тот, кому экраны
// показали посреди сценария, возвращается туда, где его прервали.
async function afterConsents(ctx: Context, session: Session) {
  const resume = session.resumeStage;
  if (resume) {
    await prisma.session.update({
      where: { telegramId: session.telegramId },
      data: { stage: resume, resumeStage: null },
    });
    return;
  }

  return startQuestionnaire(ctx, session);
}

async function startQuestionnaire(ctx: Context, session: Session) {
  const first = getFirstQuestionNumber();
  await prisma.session.update({
    where: { telegramId: session.telegramId },
    data: { stage: "QUESTION", status: "in_progress", currentQuestionNumber: first },
  });
  await logOnboarding(session.telegramId, "onb_go");
  await replyWithOptionalPhoto(ctx, texts.goStart, photos.goStart, undefined, true);
  // quiz_q1 больше не пишем: показ первого вопроса записывает сам
  // sendQuestionPrompt как quiz_question_shown с номером 1.
  //
  // Отсчёт напоминаний и строка прохождения начинаются здесь: до
  // первого вопроса напоминать не о чем и прохождения ещё нет.
  const attemptNumber = await currentAttempt(session.telegramId);
  await startQuizReminders(session.telegramId, attemptNumber);
  await startAttempt(session.telegramId, attemptNumber, first);
  return sendQuestionPrompt(ctx, getQuestion(first), []);
}

// ── Запрет на всё, пока нет согласия на обработку данных ────────────

// Стадии самого онбординга: на них согласие как раз и спрашивается.
const ONBOARDING_STAGES: Session["stage"][] = [
  "WELCOME",
  "WELCOME_VALUE",
  "STEPS",
  "HOW_IT_WORKS",
  "TERMS",
  "TERMS_HEALTH",
  "HEALTH_SCREEN",
  "PD_CONSENT",
  "MARKETING_CONSENT",
];

// Кнопки онбординга. Всё, что не отсюда, без согласия не работает —
// включая кнопки под старыми сообщениями выше по чату.
const ONBOARDING_CALLBACKS = new Set([
  "welcome_value",
  "start",
  "how_it_works",
  "my_approach",
  "health_ok",
  "health_stop",
  "health_guide",
  "pd_consent_yes",
  "pd_consent_no",
  "marketing_yes",
  "marketing_no",
]);

async function allowedWithoutPdConsent(
  session: Session,
  callbackData?: string
): Promise<boolean> {
  const status = await getConsent(session.telegramId, "PD_PROCESSING");
  if (status.action === "GRANTED") return true;

  // Идёт сам онбординг — пропускаем: согласие спросят на его шаге.
  // Отказ и отзыв сюда тоже попадают: человек остаётся на экране
  // согласия и может передумать.
  return (
    ONBOARDING_STAGES.includes(session.stage) &&
    (!callbackData || ONBOARDING_CALLBACKS.has(callbackData))
  );
}

// Показываем экран согласия и запоминаем, куда вернуть человека. Это
// случай тех, кто начал пользоваться ботом до того, как согласия
// появились: их прервали посреди сценария.
async function askPdConsentFirst(ctx: Context, session: Session) {
  await prisma.session.update({
    where: { telegramId: session.telegramId },
    data: {
      stage: "PD_CONSENT",
      // Если человек уже стоит на экране согласия, возвращать его
      // некуда — иначе после ответа он попал бы сюда же по кругу.
      resumeStage: ONBOARDING_STAGES.includes(session.stage)
        ? session.resumeStage
        : session.stage,
    },
  });
  return sendPdConsent(ctx);
}

async function resetToWelcomeAndSend(ctx: Context, session: Session) {
  await prisma.session.update({ where: { telegramId: session.telegramId }, data: { stage: "WELCOME" } });
  return sendWelcome(ctx);
}

// ── Анкета ───────────────────────────────────────────────────────────

// Отправляет сообщение с картинкой, если она задана: текст уходит
// подписью к фото. Картинка — путь в репозитории; уходит с кэшем
// file_id, иначе один и тот же файл заливался бы в Telegram заново на
// каждого человека. Если отправить не удалось — не роняем анкету, шлём
// обычным текстом.
// asHtml включаем только для статических текстов из texts.ts. У вопросов
// анкеты разметки нет, а угловая скобка в тексте вопроса сломала бы
// отправку — поэтому они уходят как раньше, простым текстом.
async function replyWithOptionalPhoto(
  ctx: Context,
  text: string,
  photo?: string,
  markup?: InlineKeyboard,
  asHtml = false
) {
  const options = markup ? { reply_markup: markup } : {};

  if (photo) {
    try {
      return await withCachedPhoto(projectFile(photo), (file) =>
        asHtml
          ? replyPhotoStatic(ctx, file, text, options)
          : ctx.replyWithPhoto(file, { ...options, caption: text })
      );
    } catch (error) {
      console.error(`Не удалось отправить картинку ${photo}, шлю текстом:`, error);
    }
  }
  return asHtml ? replyStatic(ctx, text, options) : ctx.reply(text, options);
}

type QuestionShownEvent = "quiz_question_shown" | "quiz_edit_question_shown";

// Событие показа пишется здесь, а не в вызывающих: вопрос показывается
// из семи разных мест (первый вопрос, переход к следующему, возврат из
// меню, кнопка из напоминания, команда посреди анкеты, прыжок админа,
// правка ответа), и любое из них легко забыть разметить.
//
// Правка ответов пишет свой тип: её показы не должны смешиваться с
// основным прохождением, иначе воронка по вопросам соврёт.
async function sendQuestionPrompt(
  ctx: Context,
  question: QuestionDef,
  selected: string[],
  event: QuestionShownEvent = "quiz_question_shown"
) {
  if (ctx.from) {
    await logOfferEvent(BigInt(ctx.from.id), event, { questionNumber: question.number });
  }

  let markup;
  if (question.type === "single_choice" && question.options) {
    markup = singleChoiceKeyboard(question.options);
  } else if (question.type === "multi_choice" && question.options) {
    markup = multiChoiceKeyboard(question.options, selected);
  }

  return replyWithOptionalPhoto(ctx, questionTextWithCounter(question), question.photo, markup);
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

  // Со счётчиком: сообщение подменяется тем же текстом, который человек
  // уже видел, иначе в истории чата вопрос вдруг потерял бы номер.
  const body = `${questionTextWithCounter(question)}\n\n${texts.answeredMark(chosen)}`;

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
// анкета остановлена по возрасту; пользователю в этих случаях уже
// ответили внутри.
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
      await logOfferEvent(session.telegramId, "quiz_answer_invalid", { questionNumber: qNum });
      await replyStatic(ctx, texts.invalidNumber);
      return { kind: "handled" };
    }
    const num = Number(messageText.replace(",", "."));
    if (Number.isNaN(num)) {
      await logOfferEvent(session.telegramId, "quiz_answer_invalid", { questionNumber: qNum });
      await replyStatic(ctx, texts.invalidNumber);
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
      await logOfferEvent(session.telegramId, "quiz_out_of_range", { questionNumber: qNum });
      await replyStatic(ctx, texts.outOfRange);
      return { kind: "handled" };
    }
    await saveQuestionAnswer(session.telegramId, qNum, messageText);
    return { kind: "saved" };
  }

  if (question.type === "free_text") {
    if (!messageText) {
      await logOfferEvent(session.telegramId, "quiz_answer_invalid", { questionNumber: qNum });
      await ctx.reply("Напишите, пожалуйста, ответ текстом.");
      return { kind: "handled" };
    }
    await saveQuestionAnswer(session.telegramId, qNum, messageText);
    return { kind: "saved" };
  }

  if (question.type === "single_choice") {
    if (!callbackData || !question.options?.includes(callbackData)) {
      await logOfferEvent(session.telegramId, "quiz_answer_invalid", { questionNumber: qNum });
      await sendQuestionPrompt(ctx, question, []);
      return { kind: "handled" };
    }
    await markQuestionAnswered(ctx, question, callbackData);
    await saveQuestionAnswer(session.telegramId, qNum, callbackData);
    return { kind: "saved" };
  }

  // multi_choice
  if (!callbackData || !question.options?.includes(callbackData)) {
    await logOfferEvent(session.telegramId, "quiz_answer_invalid", { questionNumber: qNum });
    return { kind: "handled" };
  }

  if (callbackData === "Готово") {
    const selections = session.tempSelections;
    const answerText = selections.join(", ") || "—";
    await markQuestionAnswered(ctx, question, answerText);

    // Красных и жёлтых флагов в анкете больше нет: с 15.10.2026 бот не
    // спрашивает о здоровье, а недоношенность учитывается методологией
    // через скорректированный возраст, а не через флаг.
    await saveQuestionAnswer(session.telegramId, qNum, answerText);
    await prisma.session.update({
      where: { telegramId: session.telegramId },
      data: { tempSelections: [] },
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

  // Человек мог стоять на вопросе, который из анкеты убрали (вопросы о
  // здоровье удалены 15.10.2026). Переводим его на следующий
  // существующий молча: сообщать тут не о чем, анкета просто
  // продолжается.
  const question = safeGetQuestion(qNum);
  if (!question) return resumeFromRemovedQuestion(ctx, session, qNum);

  const outcome = await consumeAnswer(ctx, session, question, qNum, callbackData, messageText);
  if (outcome.kind !== "saved") return;

  await logOfferEvent(session.telegramId, "quiz_question_answered", { questionNumber: qNum });
  // Последний шаг прохождения двигаем только здесь, в основном пути
  // анкеты. Правка ответов его не трогает: человек правит с экрана
  // сверки, и «остановился на вопросе 2» было бы неправдой.
  await markAttemptStep(session.telegramId, session.attempt, qNum);
  return advanceQuestionnaire(ctx, session.telegramId, qNum);
}

// Вопроса, на котором стоял человек, больше нет. Ведём его дальше с
// ближайшего существующего, а если дальше ничего не осталось — сразу к
// сверке ответов.
async function resumeFromRemovedQuestion(ctx: Context, session: Session, qNum: number) {
  const next = nearestQuestionNumber(qNum);
  if (next === null) return goToSummary(ctx, session.telegramId);

  await prisma.session.update({
    where: { telegramId: session.telegramId },
    data: { currentQuestionNumber: next, tempSelections: [] },
  });
  return sendQuestionPrompt(ctx, getQuestion(next), []);
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
  await logOfferEvent(telegramId, "quiz_summary_shown");

  const body = await buildSummaryText(telegramId);

  for (const chunk of splitForTelegram(`${texts.summaryHeader}\n\n${body}`)) {
    await ctx.reply(chunk);
  }
  return replyStatic(ctx, texts.summaryConfirmPrompt, { reply_markup: summaryKeyboard() });
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
    await logOfferEvent(session.telegramId, "quiz_edit_started");
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
  const attempt = await currentAttempt(telegramId);
  await stopQuizReminders(telegramId, attempt, QUIZ_DONE_REASON);
  await completeAttempt(telegramId, attempt);
  // waitStartedAt — момент, с которого родитель ждёт разбор. Совпадает
  // с созданием строки, но хранится отдельно: таймер в админке не
  // должен зависеть от того, когда именно появилась запись.
  await prisma.recommendation.upsert({
    where: { telegramId_attempt: { telegramId, attempt } },
    update: {},
    create: { telegramId, attempt, status: "pending", waitStartedAt: new Date() },
  });

  // Всё, что дальше, запускаем в фоне и результата не ждём: обращение к
  // Claude API идёт десятки секунд, а пользователь должен получить своё
  // сообщение сразу. Отбивка и черновик придут тебе в Telegram сами.
  void announceAndGenerateDraft(ctx.api, telegramId);

  await logOnboarding(telegramId, "quiz_completed");

  // Картинка идёт отдельным сообщением и без подписи: текст относится к
  // гиду и уходит вместе с ним. Не отправилась — не страшно, главное
  // сообщение идёт следом.
  await sendCachedPhoto(ctx, projectFile(photos.questionnaireComplete)).catch((error) =>
    console.error("Не удалось отправить картинку после анкеты:", error)
  );

  await sendGuideAfterQuiz(ctx, telegramId);

  // Последним в цепочке: сначала человек получает обещанное, и только
  // потом его о чём-то просят.
  return askMarketingAfterQuiz(ctx, telegramId);
}

// Азбуку обещает приветствие, поэтому её получает каждый, кто дошёл до
// конца анкеты, — но только один раз: второй файл при повторном
// прохождении человеку не нужен.
//
// Текст идёт подписью к гиду, одним сообщением: он прямо на этот файл и
// указывает. Если отправить документ не вышло, шлём хотя бы текст —
// анкета уже сдана, и человек не должен остаться вообще без ответа.
async function sendGuideAfterQuiz(ctx: Context, telegramId: bigint) {
  if (await hasOnboardingEvent(telegramId, "guide_sent")) return;

  try {
    await sendCachedDocument(ctx, projectFile(GUIDE_PDF), texts.guideAfterQuiz);
  } catch (error) {
    console.error("Не удалось отправить гид после анкеты:", error);
    await replyStatic(ctx, texts.guideAfterQuiz);
  }

  await logOnboarding(telegramId, "guide_sent");
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

  // Прохождение запоминаем до генерации, а не после. Модель отвечает
  // десятки секунд, и за это время человек успевает нажать «Начать
  // заново»: тогда черновик должен лечь в ту строку, по ответам которой
  // его и считали, а не в новую. Если ту строку уже отменили, черновик
  // просто останется в ней неотправленным.
  const attempt = await currentAttempt(telegramId);

  try {
    await api.sendMessage(adminChatId, draftInProgressNote(telegramId));

    const draft = await generateRecommendationDraft(await buildPrepText(telegramId), String(telegramId));
    await recordApiCalls(draft.usage);

    // aiMessage* — неизменный исходник, message* — то, что будет
    // правиться и уйдёт родителю. При перегенерации исходник
    // перезаписывается новым: он и есть последний черновик модели.
    await prisma.recommendation.update({
      where: { telegramId_attempt: { telegramId, attempt } },
      data: {
        aiMessage1: draft.message1,
        aiMessage2: draft.message2,
        message1: draft.message1,
        message2: draft.message2,
        analysis: draft.analysis,
        // Перегенерация после сбоя доставки начинает с чистого листа.
        deliveryError: null,
      },
    });

    await logOfferEvent(telegramId, "analysis_draft_created");
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
        .update({
          where: { telegramId_attempt: { telegramId, attempt } },
          data: { analysis: error.analysis },
        })
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
    where: { telegramId_attempt: { telegramId, attempt: await currentAttempt(telegramId) } },
    data: {
      analysis: draft.analysis,
      aiMessage1: draft.message1,
      aiMessage2: draft.message2,
      message1: draft.message1,
      message2: draft.message2,
    },
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
  return replyStatic(ctx, texts.editPickQuestion(count ? `1–${count}` : "—"));
}

// Пользователь назвал номер строки из итоговой анкеты.
async function handleEditPickQuestion(ctx: Context, session: Session, messageText?: string) {
  const answers = await getAnswersMap(session.telegramId);
  const questions = summaryQuestions(answers);
  const position = Number((messageText ?? "").replace(",", ".").trim());
  const question = Number.isInteger(position) ? questions[position - 1] : undefined;

  if (!question) {
    await logOfferEvent(session.telegramId, "quiz_edit_invalid_pick");
    return replyStatic(ctx, texts.editUnknownNumber(questions.length ? `1–${questions.length}` : "—"));
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
  return sendQuestionPrompt(ctx, question, selected, "quiz_edit_question_shown");
}

async function handleEditAnswer(ctx: Context, session: Session, callbackData?: string, messageText?: string) {
  const qNum = session.currentQuestionNumber;
  if (qNum == null) return goToSummary(ctx, session.telegramId);
  const question = safeGetQuestion(qNum);
  if (!question) return goToSummary(ctx, session.telegramId);

  const outcome = await consumeAnswer(ctx, session, question, qNum, callbackData, messageText);
  if (outcome.kind !== "saved") return;

  await logOfferEvent(session.telegramId, "quiz_edit_answered", { questionNumber: qNum });
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
      where: {
        ...(await answersOfCurrentAttempt(telegramId)),
        questionNumber: { in: stale.map((q) => q.number) },
      },
    });
    await replyStatic(ctx, texts.editStaleRemoved);
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
  return replyStatic(ctx, texts.editMorePrompt, { reply_markup: editMoreKeyboard() });
}

async function handleEditMore(ctx: Context, session: Session, callbackData?: string) {
  if (callbackData === "edit_more_yes") {
    await logOfferEvent(session.telegramId, "quiz_edit_more");
    await dropKeyboard(ctx);
    await prisma.session.update({
      where: { telegramId: session.telegramId },
      data: { stage: "EDIT_PICK_QUESTION" },
    });
    return askWhichQuestionToEdit(ctx, session.telegramId);
  }

  if (callbackData === "edit_more_no") {
    await logOfferEvent(session.telegramId, "quiz_edit_done");
    await dropKeyboard(ctx);
    return goToSummary(ctx, session.telegramId);
  }

  if (callbackData) return;
  return replyStatic(ctx, texts.editMorePrompt, { reply_markup: editMoreKeyboard() });
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

// /reset — стереть ответы человека совсем и вернуть его на приветствие.
// Ждущую отправки рекомендацию тоже удаляем: анкета, под которую её
// готовили, только что стёрлась, и висеть в /pending ей незачем.
// События оффера намеренно остаются — на них держится /stats.
//
// Только для админа, и это важно. Обычный человек начинает заново
// командой /restart, которая ничего не удаляет (см. restart.ts): его
// ответы — это данные о ребёнке, и бот их не стирает по нажатию. А
// здесь нужен именно чистый лист — для прогона анкеты на себе, когда
// прошлые прохождения в базе только мешают.
export async function handleResetCommand(ctx: Context) {
  const from = ctx.from;
  if (!from || !ctx.chat) return;
  if (String(from.id) !== env.ADMIN_TELEGRAM_ID) return;

  const telegramId = BigInt(from.id);
  await getOrCreateSession(telegramId, BigInt(ctx.chat.id), from.first_name);

  await prisma.answer.deleteMany({ where: { telegramId } });
  await prisma.recommendation.deleteMany({ where: { telegramId } });
  // Иначе прохождение осталось бы со статусом «завершено» при пустой
  // анкете, и в админке это выглядело бы как потерянные ответы.
  await prisma.questionnaireAttempt.deleteMany({ where: { telegramId } });
  await prisma.session.update({
    where: { telegramId },
    data: {
      stage: "WELCOME",
      status: "onboarding",
      currentQuestionNumber: null,
      resumeStage: null,
      tempSelections: [],
      yellowFlags: [],
      // Прохождения начинаются заново: ответов в базе больше нет, и
      // держать номер высоким незачем.
      attempt: 1,
    },
  });

  await replyStatic(ctx, texts.resetDone);
  return sendWelcome(ctx);
}

// ── Ожидание рекомендации (после анкеты, до отправки админом) ──────────

async function handleAwaitingRecommendation(ctx: Context, session: Session, messageText?: string) {
  if (!messageText) return;
  await saveAnswer(session.telegramId, 99, messageText);
  await logOfferEvent(session.telegramId, "quiz_addendum_received");
  return replyStatic(ctx, texts.addendumAck);
}

// Шаг «что хотите обсудить». Текст сохраняется как запрос, «Пропустить»
// ведёт дальше без него. Всё остальное — голосовое, фото, стикер —
// просьба повторяется: сохранять такое нечем, а молчать нельзя.
//
// Команды и кнопки меню сюда не доходят: они разбираются выше, до
// стадий, и в запрос не попадают.
async function handleConsultRequestStage(
  ctx: Context,
  session: Session,
  callbackData?: string,
  messageText?: string
) {
  if (callbackData === "consult_request_skip") return skipConsultRequest(ctx, session);
  if (callbackData) return;

  if (messageText) {
    if (await takeConsultRequestText(ctx, session, messageText)) return;
    // Заявки, которая ждёт ответа, нет: шаг потерял смысл, возвращаем
    // человека к офферу, чтобы он не застрял на пустом экране.
    return sendOfferMessages(ctx.api, session.chatId);
  }

  return remindConsultRequestText(ctx);
}

// ── Пример разбора ──────────────────────────────────────────────────
//
// Статичный текст: через модель не проходит, о человеке ничего не
// сохраняет и состояние онбординга не трогает. Активностью в анкете
// это тоже не считается — её отмечает только сохранение ответа.

// Защита от двойного нажатия. Четыре сообщения подряд по второму
// тапу — худшее, что может случиться с этим экраном, и дешевле
// держать отметку в памяти, чем писать её в базу: перезапуск в
// худшем случае пропустит одну защиту.
const EXAMPLE_COOLDOWN_MS = 30 * 1000;
const exampleSentAt = new Map<string, number>();

function tooSoon(telegramId: bigint, kind: string): boolean {
  const key = `${kind}:${telegramId}`;
  const last = exampleSentAt.get(key) ?? 0;
  if (Date.now() - last < EXAMPLE_COOLDOWN_MS) return true;
  exampleSentAt.set(key, Date.now());
  return false;
}

// Пауза между сообщениями примера. Без неё четыре сообщения падают
// одной стеной, и прочитать их невозможно.
const EXAMPLE_PAUSE_MS = 1000;

async function pause(ctx: Context) {
  await ctx.api.sendChatAction(Number(ctx.chat!.id), "typing").catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, EXAMPLE_PAUSE_MS));
}

async function sendExampleAnalysis(ctx: Context, session: Session, source: string) {
  await logEvent(session.telegramId, "example_analysis_opened", { source });
  if (tooSoon(session.telegramId, "analysis")) return;

  await replyStatic(ctx, texts.exampleIntro);
  await pause(ctx);
  await replyStatic(ctx, texts.exampleAnalysis1);
  await pause(ctx);
  await replyStatic(ctx, texts.exampleAnalysis2);
  await pause(ctx);
  return replyStatic(ctx, texts.exampleFinal(formatPrice(env.PDF_PRICE_RUB)), {
    reply_markup: exampleFinalKeyboard(),
  });
}

// Пример плана — тот же публичный файл с размытой памяткой, что уходит
// по кнопке в оффере, и с тем же кэшем file_id.
async function sendExamplePlan(ctx: Context, session: Session, source: string) {
  await logEvent(session.telegramId, "example_plan_opened", { source });
  if (tooSoon(session.telegramId, "plan")) return;

  return sendCachedDocument(
    ctx,
    projectFile(EXAMPLE_PDF),
    texts.examplePlanCaption,
    examplePlanKeyboard()
  );
}

// «Получить свой разбор». Ведёт туда же, куда «Получить разбор» на
// первом экране, но с оглядкой на то, где человек сейчас: звать в
// начало того, кто уже ждёт разбор, значит не ответить на нажатие.
async function handleExampleCta(ctx: Context, session: Session, source: string) {
  await logEvent(session.telegramId, "example_cta_get_analysis", { source });

  const recommendation = await currentRecommendation(session.telegramId);
  if (recommendation?.status === "sent") {
    return replyStatic(ctx, texts.exampleAnalysisSent);
  }
  if (recommendation) return replyStatic(ctx, texts.exampleAnalysisPending);

  // Онбординг ещё не пройден или идёт анкета — показываем текущий шаг.
  // Он же и есть «следующий шаг после первого экрана» у новичка.
  if (session.stage === "WELCOME") return goToTermsHealth(ctx, session);
  return resendCurrentStep(ctx, session);
}

// Разбор кнопок примера. Источник в самом callback_data: по нему
// видно, с какого экрана человек пришёл и куда пошёл дальше.
const EXAMPLE_SOURCES: Record<string, string> = {
  example_welcome: "welcome",
  example_steps: "steps",
  example_how_it_works: "how_it_works",
  example_menu: "menu",
};

async function handleExampleCallback(ctx: Context, session: Session, data: string) {
  const source = EXAMPLE_SOURCES[data];
  if (source) return sendExampleAnalysis(ctx, session, source);

  if (data === "example_plan_final") return sendExamplePlan(ctx, session, "example_final");
  if (data === "example_cta_final") return handleExampleCta(ctx, session, "example_final");
  if (data === "example_cta_plan") return handleExampleCta(ctx, session, "example_plan");

  if (data === "example_hiw_final" || data === "example_hiw_plan") {
    const from = data === "example_hiw_final" ? "example_final" : "example_plan";
    await logEvent(session.telegramId, "example_how_it_works", { source: from });
    return goToHowItWorks(ctx, session);
  }
}

// ── Оффер платного PDF ──────────────────────────────────────────────

const EXAMPLE_PDF = "assets/example/Dremius_plan_sna_primer.pdf";

function exampleFollowUp(ctx: Context) {
  return replyStatic(ctx, texts.exampleFollowup, {
    reply_markup: exampleFollowupKeyboard(formatPrice(env.PDF_PRICE_RUB)),
  });
}

async function sendExamplePdf(ctx: Context) {
  await sendCachedDocument(ctx, projectFile(EXAMPLE_PDF));
  return exampleFollowUp(ctx);
}

// Цены на кнопках и в текстах — из env, с пробелом-разделителем тысяч.
// Цена консультации приходит из consult.ts: там же она записывается в
// заявку, и двух источников у неё быть не должно.
function pdfPrice(): string {
  return formatPrice(env.PDF_PRICE_RUB);
}

// Шаг оффера — два сообщения: «Поддержка» без кнопок и «Выбор» с
// кнопками. Карточки продуктов дальше подменяют текст второго
// сообщения, поэтому отдельным сообщением оно и уходит.
async function sendOfferMessages(api: Api, chatId: bigint) {
  await sendStatic(api, chatId, texts.offerSupport);
  await sendStatic(api, chatId, texts.offerChoice(pdfPrice(), consultPriceText()), {
    reply_markup: offerChoiceKeyboard(),
  });
}

// Отправляет оффер вручную, командой /offer. Ни стадию сессии, ни
// заказы не трогает: это просто повторный показ предложения тому, кто
// его пропустил или потерял в переписке. Показ при этом попадает в
// статистику, иначе покупка по такому офферу выглядела бы в /stats
// покупкой без показа.
export async function sendOfferTo(api: Api, telegramId: bigint, chatId: bigint) {
  await logOfferEvent(telegramId, "offer_shown");
  return sendOfferMessages(api, chatId);
}

// Карточка продукта подменяет собой сообщение «Выбор», а «← Назад»
// возвращает его обратно: так в чате не растёт лента сообщений, из
// которой непонятно, что из этого ещё актуально.
//
// Если править не дали (сообщение слишком старое, его удалили), карточка
// уходит новым сообщением — хуже выглядит, но работает.
// photo — адрес картинки, которую нужно показать над текстом. Telegram
// не умеет добавлять фото к существующему сообщению, но умеет показать
// превью ссылки крупно и над текстом — этим и пользуемся. Ссылки в
// самом тексте при этом нет, и человек видит только картинку.
async function replaceWithCard(
  ctx: Context,
  text: string,
  markup: InlineKeyboard,
  photo?: string
) {
  const preview = photo
    ? { url: photo, prefer_large_media: true, show_above_text: true }
    : { is_disabled: true };
  const options = { reply_markup: markup, parse_mode: "HTML" as const, link_preview_options: preview };

  try {
    await ctx.editMessageText(text, options);
  } catch (error) {
    // Повторный тап по той же кнопке: сообщение уже такое, какое нужно.
    // Отправлять копию было бы хуже, чем не делать ничего.
    if (String(error).includes("message is not modified")) return;
    await replyStatic(ctx, text, options);
  }
}

async function handleOffer(ctx: Context, session: Session, callbackData?: string) {
  if (callbackData === "offer_pdf_details") {
    await logOfferEvent(session.telegramId, "offer_pdf_details");
    return replaceWithCard(
      ctx,
      texts.offerPdfCard(pdfPrice(), escapeHtml(env.OFFER_URL)),
      offerPdfCardKeyboard(pdfPrice())
    );
  }

  if (callbackData === "offer_consult_details") {
    await logOfferEvent(session.telegramId, "offer_consult_details");
    await logOfferEvent(session.telegramId, "consult_card_opened");
    return replaceWithCard(
      ctx,
      texts.offerConsultCard(consultPriceText()),
      offerConsultCardKeyboard(consultPriceText()),
      env.SOFIA_CARD_URL
    );
  }

  if (callbackData === "offer_back") {
    await logOfferEvent(session.telegramId, "offer_back");
    return replaceWithCard(
      ctx,
      texts.offerChoice(pdfPrice(), consultPriceText()),
      offerChoiceKeyboard()
    );
  }

  if (callbackData === "offer_example") {
    await logOfferEvent(session.telegramId, "example_clicked");
    return sendExamplePdf(ctx);
  }

  // Карточку после нажатия намеренно не меняем: вернуться к ней и
  // посмотреть пример человек может и после того, как нажал «Купить».
  if (callbackData === "offer_buy") {
    await logOfferEvent(session.telegramId, "buy_clicked");
    return handleBuy(ctx, session);
  }

  // offer_consult_signup — кнопка «Записаться» из сообщений, которые
  // ушли до 29.10.2026. Ведёт туда же, куда новая «Оставить заявку»:
  // ломать её незачем, а путь теперь один.
  if (callbackData === "offer_consult_request" || callbackData === "offer_consult_signup") {
    await logOfferEvent(session.telegramId, "consult_signup");
    return startConsultRequest(ctx, session, {
      cardText: texts.offerConsultCard(consultPriceText()),
    });
  }

  if (callbackData === "offer_decline") return handleDecline(ctx, session);

  // Нажали кнопку старого сообщения выше по чату — молча игнорируем.
  if (callbackData) return;
  return sendOfferMessages(ctx.api, session.chatId);
}

// «Пока не нужно». Сообщение «Выбор» не трогаем: кнопки остаются в
// чате, и на них ссылается текст ответа. О причине отказа отдельно не
// спрашиваем — вместо этого сразу идёт CSAT по всему опыту.
async function handleDecline(ctx: Context, session: Session) {
  // Повторный тап не должен присылать второе такое же сообщение.
  // Сутки — ровно то окно, за которое человек видит оффер в чате; потом
  // отказ имеет смысл записать заново.
  const declinedRecently = await prisma.offerEvent.findFirst({
    where: {
      telegramId: session.telegramId,
      type: "offer_declined",
      createdAt: { gte: new Date(Date.now() - 24 * 3_600_000) },
    },
  });
  if (declinedRecently) return;

  await logOfferEvent(session.telegramId, "offer_declined");
  await replyStatic(ctx, texts.offerDeclined);

  // Если человек уже проходил CSAT, второй раз не спрашиваем.
  if (session.stage === "CSAT_FEEDBACK" || session.stage === "CSAT_DONE") return;

  // Вопрос о впечатлениях — отдельная категория: по умолчанию он не
  // требует согласия на рассылку, но флагом это можно изменить.
  if (!(await allowedToSend(session.telegramId, "FEEDBACK", "csat_prompt"))) return;

  await prisma.session.update({
    where: { telegramId: session.telegramId },
    data: { stage: "CSAT_RATING" },
  });
  await logOfferEvent(session.telegramId, "csat_asked");
  return replyStatic(ctx, texts.csatPrompt, { reply_markup: csatKeyboard() });
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
    await logOfferEvent(session.telegramId, "buy_repeat_click");
    return replyStatic(
      ctx,
      existing.status === "SENT" ? texts.orderAlreadySent : texts.orderAlreadyGenerating
    );
  }

  const order = await createPdfOrder(session.telegramId);

  // Нажатие на кнопку с ценой — это и есть принятие оферты: её условия
  // написаны прямо в карточке, над кнопкой. Записываем сразу после
  // создания заказа, чтобы запись ссылалась на его номер.
  await saveConsent(ctx, {
    telegramId: session.telegramId,
    type: "OFFER_ACCEPTANCE",
    action: "GRANTED",
    source: "PURCHASE_PDF",
    documents: ["OFFER"],
    messageText: texts.offerPdfCard(pdfPrice(), env.OFFER_URL),
    buttonText: `Купить за ${pdfPrice()} ₽`,
    telegramMessageId: ctx.callbackQuery?.message?.message_id,
    relatedOrderId: order.id,
  });

  await replyStatic(ctx, texts.orderAccepted);

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
  await logOfferEvent(telegramId, "order_generation_started");
  return prisma.order.create({
    data: {
      telegramId,
      attempt: await currentAttempt(telegramId),
      product: "PDF",
      priceRub: env.PDF_PRICE_RUB,
      status: "GENERATING",
    },
  });
}

type OfferEventName =
  | "offer_shown"
  | "offer_pdf_details"
  | "offer_consult_details"
  | "offer_back"
  | "example_clicked"
  | "buy_clicked"
  | "consult_signup"
  | "consult_card_opened"
  | "consult_request_started"
  | "consult_request_text"
  | "consult_request_skipped"
  | "offer_declined"
  | "onb_welcome"
  | "onb_welcome_value"
  | "onb_steps"
  | "onb_how_it_works"
  | "onb_terms"
  | "onb_health"
  | "onb_pd_consent"
  | "onb_marketing"
  | "onb_go"
  | "quiz_q1"
  | "quiz_completed"
  | "guide_sent"
  | "csat_asked"
  // Меню. В отличие от шагов онбординга пишутся каждый раз: в /stats
  // важно, сколько раз меню открывали, а не сколько людей его видели.
  | "menu_opened"
  | "menu_support"
  | "menu_docs"
  | "menu_team"
  | "restart_asked"
  | "restart_confirmed"
  | "start_new_attempt"
  | "restart_confirmed_cancelled_draft"
  | "restart_cancelled"
  // Полная разметка воронки, 20.10.2026.
  | "onb_health_ok"
  | "onb_pd_granted"
  | "onb_pd_declined"
  | "onb_marketing_yes"
  | "onb_marketing_no"
  | "quiz_question_shown"
  | "quiz_question_answered"
  | "quiz_answer_invalid"
  | "quiz_out_of_range"
  | "quiz_summary_shown"
  | "quiz_edit_started"
  | "quiz_edit_question_shown"
  | "quiz_edit_invalid_pick"
  | "quiz_edit_answered"
  | "quiz_edit_more"
  | "quiz_edit_done"
  | "quiz_addendum_received"
  | "analysis_draft_created"
  | "analysis_sent"
  | "analysis_send_failed"
  | "buy_repeat_click"
  | "order_generation_started"
  | "order_generation_failed"
  | "pdf_sent"
  | "consult_contact_shared"
  | "consult_self_contact"
  | "consult_wrong_contact"
  | "consult_signup_duplicate"
  | "consult_sent_to_specialist"
  | "csat_rated"
  | "csat_feedback_left"
  | "menu_back_to_quiz"
  | "closed_mode_blocked"
  | "unrecognized_input"
  | "consent_write_failed";

async function logOfferEvent(
  telegramId: bigint,
  type: OfferEventName,
  opts: { questionNumber?: number; attempt?: number } = {}
) {
  await logEvent(telegramId, type, opts);
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
    // Разбор берём того прохождения, из которого заказ и пришёл:
    // человек заплатил за то, что прочитал.
    const recommendation = await prisma.recommendation.findUnique({
      where: { telegramId_attempt: { telegramId: order.telegramId, attempt: order.attempt } },
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

    await logOfferEvent(order.telegramId, "order_generation_failed");
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
    new InputFile(pdf, "Dremius_plan_sna.pdf"),
    { caption: texts.pdfCaption }
  );

  await prisma.pdfDraft.update({ where: { orderId }, data: { pdfBytes: pdf, approvedAt } });
  await prisma.order.update({
    where: { id: orderId },
    data: { status: "SENT", sentAt: new Date() },
  });
  await logOfferEvent(order.telegramId, "pdf_sent");

  // Через неделю спросим, что изменилось со сном.
  await schedulePdfFeedback(orderId, order.telegramId);
}

// ── Напоминания ─────────────────────────────────────────────────────
//
// Их больше нет совсем. Напоминания о зависших заказах PDF убраны
// 15.10.2026, напоминания по заявкам на консультацию — 19.10.2026;
// вместе с последними ушёл и сам цикл, запускавший эти проверки.
// Оставшиеся два планировщика (апселл и отложенные вопросы) живут в
// upsell.ts и feedback.ts и шлют сообщения родителям, а не нам.

// ── CSAT ─────────────────────────────────────────────────────────────

async function handleCsatRating(ctx: Context, session: Session, callbackData?: string) {
  const match = callbackData?.match(/^csat_([1-5])$/);
  if (!match) return replyStatic(ctx, texts.csatPrompt, { reply_markup: csatKeyboard() });

  await saveAnswer(session.telegramId, 30, match[1]);
  await logOfferEvent(session.telegramId, "csat_rated");
  await prisma.session.update({ where: { telegramId: session.telegramId }, data: { stage: "CSAT_FEEDBACK" } });
  return replyStatic(ctx, texts.csatFeedbackPrompt);
}

async function handleCsatFeedback(ctx: Context, session: Session, messageText?: string) {
  if (!messageText) return; // тишина ок, ничего страшного не происходит
  await saveAnswer(session.telegramId, 31, messageText);
  await logOfferEvent(session.telegramId, "csat_feedback_left");
  await prisma.session.update({ where: { telegramId: session.telegramId }, data: { stage: "CSAT_DONE" } });
  return replyStatic(ctx, texts.csatThankYou);
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

// Текст ошибки Telegram у текущего разбора. По нему он попадает в
// очередь админки как «не доставлено», и видно, что именно случилось.
// Сбой самой записи ничего не меняет: ошибка уже уходит вызывающему.
async function saveDeliveryError(telegramId: bigint, error: unknown): Promise<void> {
  const reason = (error as { description?: string })?.description ?? String(error);
  await prisma.recommendation
    .update({
      where: { telegramId_attempt: { telegramId, attempt: await currentAttempt(telegramId) } },
      data: { deliveryError: reason.slice(0, 500) },
    })
    .catch((dbError) => console.error("Не удалось записать ошибку доставки:", dbError));
}

// Общий хвост обоих путей — и ручного /send, и автоматического /approve:
// помечаем рекомендацию отправленной и показываем экран оплаты.
async function markSentAndShowOffer(api: Api, telegramId: bigint, chatId: bigint) {
  // Сначала помечаем разбор отправленным, и только потом решаем про
  // оффер. Порядок важен: раньше проверка согласия стояла первой и
  // выходила из функции целиком. Родитель, отозвавший согласие между
  // сдачей анкеты и отправкой, получал оба сообщения разбора — они
  // уходят выше, до этой функции, — а запись оставалась pending. Такой
  // разбор висел в очереди админки навсегда, и повторное нажатие
  // «Отправить» присылало его во второй раз.
  //
  // Сообщения ушли — значит отправлено, что бы ни решилось про оффер.
  await prisma.recommendation.update({
    where: { telegramId_attempt: { telegramId, attempt: await currentAttempt(telegramId) } },
    data: { status: "sent", sentAt: new Date(), deliveryError: null },
  });
  await logOfferEvent(telegramId, "analysis_sent");

  // Оффер идёт следом за разбором, за которым человек и пришёл, — это
  // не реклама. Но если согласие на данные отозвано, бот молчит совсем.
  if (!(await allowedToSend(telegramId, "SERVICE", "offer_after_analysis"))) return;

  await prisma.session.update({ where: { telegramId }, data: { stage: "FAKE_DOOR_OFFER" } });

  await logOfferEvent(telegramId, "offer_shown");
  await sendOfferMessages(api, chatId);

  // Через сутки спросим, узнал ли родитель в разборе своего малыша.
  // Планируем здесь: это момент, когда разбор действительно ушёл.
  await scheduleAnalysisFeedback(telegramId);
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
  try {
    await sendLongMessage(api, chatId, formatDraftMessage(texts.draftHeading1, messages[0]), true);
    await sendLongMessage(api, chatId, formatDraftMessage(texts.draftHeading2, messages[1]), true);
  } catch (error) {
    // Ошибку пробрасываем: админу она нужна, чтобы понять, что разбор
    // не дошёл. Статистике нужен сам факт, а очереди — текст ошибки.
    await logOfferEvent(telegramId, "analysis_send_failed");
    await saveDeliveryError(telegramId, error);
    throw error;
  }

  await prisma.recommendation.update({
    where: { telegramId_attempt: { telegramId, attempt: await currentAttempt(telegramId) } },
    data: { message1: messages[0], message2: messages[1] },
  });

  await markSentAndShowOffer(api, telegramId, chatId);
}

// Автоматический путь (/approve): отправляем пользователю тот черновик,
// который бот подготовил сам и показал тебе на проверку.
export async function sendApprovedRecommendation(api: Api, telegramId: bigint, chatId: bigint) {
  const recommendation = await currentRecommendation(telegramId);

  // Человек начал анкету заново, пока черновик ждал проверки.
  // Отправлять его нельзя: он про ответы, которые человек уже
  // переписал. Проверяем до «черновика нет»: сразу после перезапуска
  // текущего разбора не существует, и сообщение про отсутствие
  // черновика сбивало бы с толку.
  if (!recommendation || recommendation.status === "cancelled") {
    if (recommendation?.status === "cancelled" || (await lastCancelledRecommendation(telegramId))) {
      throw new Error(
        "Этот разбор отменён: человек начал анкету заново. Новый придёт на проверку сам."
      );
    }
  }

  if (recommendation?.status === "sent") {
    // Идемпотентность по ТЗ: повторное нажатие «Отправить» не должно
    // отправлять родителю второе сообщение. Проверка здесь, а не у
    // вызывающих: их три, и забыть её в одном из них слишком легко.
    throw new Error("Этот разбор уже отправлен.");
  }

  if (!recommendation?.message1 || !recommendation?.message2) {
    throw new Error("Черновик разбора не найден.");
  }

  try {
    await sendLongMessage(api, chatId, formatDraftMessage(texts.draftHeading1, recommendation.message1), true);
    await sendLongMessage(api, chatId, formatDraftMessage(texts.draftHeading2, recommendation.message2), true);
  } catch (error) {
    await logOfferEvent(telegramId, "analysis_send_failed");
    await saveDeliveryError(telegramId, error);
    throw error;
  }

  await markSentAndShowOffer(api, telegramId, chatId);
}

// Текстовый дамп "Вопрос/Ответ" для конкретного пользователя — чтобы
// скопировать в Claude при подготовке рекомендации (замена листа `prep`).
// Сама функция живёт в src/prep.ts: она нужна ещё админке и пакету
// заявки на консультацию. Здесь — только реэкспорт, чтобы не править
// импорты во всех вызывающих файлах.
export { buildPrepText } from "./prep";
