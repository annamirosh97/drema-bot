// Заявки на консультацию специалиста.
//
// Бот собирает заявку, а не записывает с оплатой: дальше родителю
// пишет команда Дрёмиуса, отвечает на вопросы, присылает ссылку на
// оплату и уже после знакомит с Софией в общем чате.
//
// Два правила этого файла.
//
// Первое: контакт родителя не уходит никому, пока родитель сам этого
// не разрешил. Заявка создаётся в состоянии firstContact = PENDING, и
// запись SPECIALIST_TRANSFER появляется только после его выбора.
//
// Второе: пакет с анкетой и разбором уходит Софии только после статуса
// PAID. До оплаты Софии не нужно ничего, а родитель ещё может
// передумать — передавать его данные раньше незачем.

import { Api, Context, InlineKeyboard, InputFile } from "grammy";
import type { ConsultRequest, ConsultSource, Session } from "@prisma/client";
import { prisma } from "./prisma";
import { env } from "./env";
import { formatPrice, texts } from "./texts";
import { ConsentInput, recordConsent } from "./consents";
import { buildPrepText } from "./prep";
import { currentAttempt } from "./attempt";
import {
  CONSULT_SELF_WRITE_BUTTON,
  consultConsentKeyboard,
  consultRequestKeyboard,
} from "./keyboards";
import { escapeHtml, replyStatic, sendStatic } from "./send";
import { logEvent } from "./events";

// Заявки в этих статусах считаются живыми: пока такая есть, вторую не
// создаём. Оплаченная тоже живая — человек уже в работе, а DONE и LOST
// записаться заново не мешают.
const OPEN_STATUSES = ["NEW", "CONTACTED", "PAID"] as const;

// Пишет согласие и, если не вышло, честно говорит об этом человеку.
// Возвращает false — значит, действие выполнять нельзя: согласие,
// которого нет в журнале, для проверяющей стороны не существует.
async function saveConsent(ctx: Context, input: ConsentInput): Promise<boolean> {
  try {
    await recordConsent(input);
    return true;
  } catch (error) {
    console.error(`Не удалось записать согласие ${input.type} для #${input.telegramId}:`, error);
    await replyStatic(ctx, texts.consentSaveFailed).catch(() => {});
    return false;
  }
}

// Передача данных специалисту — отдельное согласие: Софии уходят не
// только контакт, но и анкета, разбор и план. Пакет не отправляется,
// пока этой записи нет.
async function recordSpecialistTransfer(
  ctx: Context,
  telegramId: bigint,
  requestId: number,
  buttonText: string
): Promise<boolean> {
  return saveConsent(ctx, {
    telegramId,
    type: "SPECIALIST_TRANSFER",
    action: "GRANTED",
    source: "CONSULT_SIGNUP",
    documents: ["PD_CONSENT"],
    messageText: consultContactText(),
    buttonText,
    telegramMessageId: ctx.callbackQuery?.message?.message_id,
    relatedConsultRequestId: requestId,
  });
}

// В сообщении о контакте стоит ссылка на согласие — адрес приходит из
// переменных окружения и в HTML должен быть обезврежен.
export function consultContactText(): string {
  return texts.consultContactAsk(escapeHtml(env.PD_CONSENT_URL));
}

function adminChatId(): number {
  return Number(env.ADMIN_TELEGRAM_ID);
}

// Telegram ID специалиста, если он задан и похож на число.
function specialistChatId(): number | null {
  const raw = env.CONSULT_SPECIALIST_TELEGRAM_ID.trim();
  if (!raw) return null;
  const id = Number(raw);
  return Number.isFinite(id) && id !== 0 ? id : null;
}

function firstContactLabel(request: ConsultRequest): string {
  if (request.firstContact === "SPECIALIST") return "София";
  if (request.firstContact === "PARENT") return "родитель";
  return "родитель ещё не выбрал";
}

// ── Создание заявки ─────────────────────────────────────────────────

// Откуда пришла заявка и по какой цене. По умолчанию — основной оффер
// после бесплатного разбора, полная цена.
export interface ConsultOrigin {
  priceRub?: number;
  source?: ConsultSource;
  orderId?: number;
  // Текст карточки, в которой человек нажал «Записаться». Уходит в
  // журнал как то, что он видел, принимая условия оферты.
  cardText?: string;
}

// Создаёт заявку. Ни команде, ни Софии ничего не уходит: команде
// нужен контакт, а Софии — оплата.
export async function createConsultRequest(
  api: Api,
  telegramId: bigint,
  parentUsername?: string,
  origin: ConsultOrigin = {}
): Promise<ConsultRequest> {
  const request = await prisma.consultRequest.create({
    data: {
      telegramId,
      attempt: await currentAttempt(telegramId),
      priceRub: origin.priceRub ?? env.CONSULT_PRICE_RUB,
      source: origin.source ?? "OFFER",
      orderId: origin.orderId ?? null,
      status: "NEW",
      firstContact: "PENDING",
      parentUsername: parentUsername ?? null,
    },
  });

  // Команде ничего не сообщаем: заявка без контакта ей бесполезна, а
  // родитель может уйти на первом же шаге. Уведомление уходит после
  // шага 2, когда известно, как с человеком связаться.
  return request;
}

// Нажали «Записаться». Создаёт заявку и ведёт родителя дальше: либо
// просит разрешить передать контакт, либо — если username нет и найти
// его специалисту всё равно не по чему — сразу просит написать самому.
//
// Один и тот же путь для обоих предложений: из основного оффера и из
// предложения со скидкой после покупки плана. Разница только в том, что
// приходит в origin. Возвращает созданную заявку либо null, если живая
// заявка у родителя уже была.
export async function startConsultRequest(
  ctx: Context,
  session: Session,
  origin: ConsultOrigin = {}
): Promise<ConsultRequest | null> {
  const existing = await prisma.consultRequest.findFirst({
    where: { telegramId: session.telegramId, status: { in: [...OPEN_STATUSES] } },
    orderBy: { createdAt: "desc" },
  });
  if (existing) {
    await logEvent(session.telegramId, "consult_signup_duplicate");
    await replyStatic(ctx, texts.consultRequestExists(escapeHtml(env.TEAM_USERNAME)));
    return null;
  }

  const request = await createConsultRequest(ctx.api, session.telegramId, ctx.from?.username, origin);
  await logEvent(session.telegramId, "consult_request_started");

  await prisma.session.update({
    where: { telegramId: session.telegramId },
    data: { stage: "CONSULT_CONSENT" },
  });
  await replyStatic(ctx, consultContactText(), {
    link_preview_options: { is_disabled: true },
    reply_markup: consultConsentKeyboard(),
  });
  return request;
}

// Заявка, которая ждёт ответа родителя. null — ждать нечего.
async function pendingRequest(telegramId: bigint): Promise<ConsultRequest | null> {
  return prisma.consultRequest.findFirst({
    where: { telegramId, status: { in: [...OPEN_STATUSES] } },
    orderBy: { createdAt: "desc" },
  });
}

// Заявка, по которой ещё не выбран способ связи.
async function awaitingContact(telegramId: bigint): Promise<ConsultRequest | null> {
  const request = await pendingRequest(telegramId);
  return request?.firstContact === "PENDING" ? request : null;
}

// ── Шаг 1: контакт для команды ──────────────────────────────────────

// Спрашиваем, что обсудить. Клавиатуру контакта убирать отдельно не
// нужно: она одноразовая и прячется сама, как только по ней нажали.
async function askWhatToDiscuss(ctx: Context, telegramId: bigint) {
  await prisma.session.update({
    where: { telegramId },
    data: { stage: "CONSULT_REQUEST" },
  });
  return replyStatic(ctx, texts.consultRequestAsk, {
    reply_markup: consultRequestKeyboard(),
  });
}

// Карточка заявки команде собирается на третьем этапе; пока уходит
// короткое уведомление — в конце пути, когда известно и как связаться,
// и о чём человек хочет говорить.
async function notifyTeam(api: Api, request: ConsultRequest) {
  const who = request.parentUsername
    ? `@${request.parentUsername}`
    : request.parentPhone ?? "без username — напишет сам";
  const what = request.requestText ? `\nЗапрос: «${request.requestText}»` : "";
  await api
    .sendMessage(adminChatId(), `🗓 Заявка на консультацию №${request.id}: ${who}${what}`)
    .catch((error) => console.error("Не удалось сообщить о заявке:", error));
}

// Родитель прислал контакт. Возвращает false, если ждать его было
// незачем — тогда вызывающий решает, что делать с сообщением.
export async function takeConsultContact(
  ctx: Context,
  session: Session,
  contact: { user_id?: number; phone_number: string }
): Promise<boolean> {
  const request = await awaitingContact(session.telegramId);
  if (!request) return false;

  // Переслать можно контакт любого человека из своей книги. Чужой
  // команде не нужен и согласием не является.
  if (contact.user_id == null || BigInt(contact.user_id) !== session.telegramId) {
    await logEvent(session.telegramId, "consult_wrong_contact");
    await replyStatic(ctx, texts.consultContactNotYours, { reply_markup: consultConsentKeyboard() });
    return true;
  }

  const username = ctx.from?.username ?? request.parentUsername;

  // Без username команда может не найти человека по одному телефону,
  // поэтому первым пишет родитель — но контакт мы всё равно приняли.
  await prisma.consultRequest.update({
    where: { id: request.id },
    data: {
      parentPhone: contact.phone_number,
      contactConsentAt: new Date(),
      firstContact: username ? "TEAM" : "PARENT",
      parentUsername: username,
    },
  });

  const saved = await recordSpecialistTransfer(
    ctx,
    session.telegramId,
    request.id,
    "Поделиться контактом"
  );
  if (!saved) return true;

  await logEvent(session.telegramId, "consult_contact_shared");
  await askWhatToDiscuss(ctx, session.telegramId);
  return true;
}

// Нажали «Напишу команде сам(а)». Возвращает false, если такой заявки
// нет: значит, это просто совпавший с подписью кнопки текст.
export async function takeConsultSelfWrite(ctx: Context, session: Session): Promise<boolean> {
  const request = await awaitingContact(session.telegramId);
  if (!request) return false;

  await prisma.consultRequest.update({
    where: { id: request.id },
    data: {
      firstContact: "PARENT",
      parentUsername: ctx.from?.username ?? request.parentUsername,
      // Отметка согласия нужна и здесь: от неё отсчитывается ожидание
      // ответа на второй шаг.
      contactConsentAt: new Date(),
    },
  });

  const saved = await recordSpecialistTransfer(
    ctx,
    session.telegramId,
    request.id,
    CONSULT_SELF_WRITE_BUTTON
  );
  if (!saved) return true;

  await logEvent(session.telegramId, "consult_self_contact");
  await askWhatToDiscuss(ctx, session.telegramId);
  return true;
}

// ── Шаг 2: что хотите обсудить ──────────────────────────────────────

// Конец пути: подтверждение родителю и уведомление команде. Текст
// подтверждения зависит от того, кто пишет первым.
async function finishConsultRequest(ctx: Context, session: Session, request: ConsultRequest) {
  // Отмечаем до отправки: если уведомление не уйдёт, второй раз его
  // пошлёт фоновая проверка, а два одинаковых — хуже, чем ни одного.
  const finished = await prisma.consultRequest.update({
    where: { id: request.id },
    data: { teamNotifiedAt: new Date() },
  });
  await prisma.session.update({
    where: { telegramId: session.telegramId },
    data: { stage: "FAKE_DOOR_OFFER" },
  });

  // remove_keyboard — на случай, если клавиатура контакта почему-то
  // осталась внизу чата: одноразовой её прячет сам Telegram, но
  // полагаться на это в последнем сообщении пути не стоит.
  await replyStatic(
    ctx,
    request.firstContact === "TEAM"
      ? texts.consultRequestAccepted(escapeHtml(env.TEAM_USERNAME))
      : texts.consultRequestSelfWrite(escapeHtml(env.TEAM_USERNAME), request.id),
    { reply_markup: { remove_keyboard: true } }
  );
  await notifyTeam(ctx.api, finished);
}

// ── Заявки, брошенные на втором шаге ────────────────────────────────
//
// Контакт родитель уже оставил — значит, команде есть с чем работать,
// и держать такую заявку невидимой из-за неотвеченного вопроса нельзя.
// Через CONSULT_REQUEST_TIMEOUT_MIN минут считаем её законченной, будто
// нажали «Пропустить»: родитель получает подтверждение, команда —
// уведомление.
//
// Проверка идёт по базе, а не по таймеру в памяти: перезапуск бота не
// должен терять заявки, а других способов узнать про них нет.
export async function finishStaleConsultRequests(api: Api): Promise<void> {
  const deadline = new Date(Date.now() - env.CONSULT_REQUEST_TIMEOUT_MIN * 60_000);

  const stale = await prisma.consultRequest.findMany({
    where: {
      status: "NEW",
      teamNotifiedAt: null,
      firstContact: { not: "PENDING" },
      contactConsentAt: { lte: deadline },
    },
    include: { session: true },
  });

  for (const request of stale) {
    try {
      const finished = await prisma.consultRequest.update({
        where: { id: request.id },
        data: { teamNotifiedAt: new Date() },
      });

      // Родитель мог застрять на шаге запроса: возвращаем его к офферу,
      // иначе следующее его сообщение уйдёт в пустоту.
      if (request.session.stage === "CONSULT_REQUEST") {
        await prisma.session.update({
          where: { telegramId: request.telegramId },
          data: { stage: "FAKE_DOOR_OFFER" },
        });
      }

      await sendStatic(
        api,
        request.session.chatId,
        request.firstContact === "TEAM"
          ? texts.consultRequestAccepted(escapeHtml(env.TEAM_USERNAME))
          : texts.consultRequestSelfWrite(escapeHtml(env.TEAM_USERNAME), request.id),
        { reply_markup: { remove_keyboard: true } }
      );
      await logEvent(request.telegramId, "consult_request_skipped");
      await notifyTeam(api, finished);
    } catch (error) {
      console.error(`Не удалось закрыть заявку #${request.id}:`, error);
    }
  }
}

const CHECK_INTERVAL_MS = 60 * 1000;

export function startConsultScheduler(api: Api) {
  setInterval(() => {
    void finishStaleConsultRequests(api).catch((error) =>
      console.error("Проверка брошенных заявок не удалась:", error)
    );
  }, CHECK_INTERVAL_MS);
}

// Родитель написал, что хочет обсудить. Возвращает false, если ждать
// текста было незачем: тогда сообщение разбирается как обычно.
export async function takeConsultRequestText(
  ctx: Context,
  session: Session,
  text: string
): Promise<boolean> {
  if (session.stage !== "CONSULT_REQUEST") return false;
  const request = await pendingRequest(session.telegramId);
  if (!request) return false;

  // Тысяча символов — предел, за которым это уже не «пара
  // предложений». Режем, а не отказываем: человек написал по делу, и
  // терять написанное из-за длины неправильно.
  const updated = await prisma.consultRequest.update({
    where: { id: request.id },
    data: { requestText: text.slice(0, 1000) },
  });
  await logEvent(session.telegramId, "consult_request_text");
  await finishConsultRequest(ctx, session, updated);
  return true;
}

// Прислали не текст: голосовое, фото, стикер. Повторяем просьбу.
export async function remindConsultRequestText(ctx: Context): Promise<void> {
  await replyStatic(ctx, texts.consultRequestNotText, {
    reply_markup: consultRequestKeyboard(),
  });
}

export async function skipConsultRequest(ctx: Context, session: Session): Promise<void> {
  const request = await pendingRequest(session.telegramId);
  if (!request) return;
  await logEvent(session.telegramId, "consult_request_skipped");
  await finishConsultRequest(ctx, session, request);
}

// Родитель в стадии согласия прислал что-то своё. ТЗ просит повторить
// просьбу один раз: кнопки у него на экране, и дальше долбить ими
// человека незачем.
//
// Кому уже повторили — держим в памяти процесса: перезапуск сбросит, и
// в худшем случае просьба повторится ещё раз. Для такой мелочи этого
// достаточно, строка в базе ради неё не нужна.
const nudged = new Set<string>();

export async function remindAboutConsentOnce(ctx: Context, session: Session) {
  const key = String(session.telegramId);
  if (nudged.has(key)) return replyStatic(ctx, texts.genericFallback);

  nudged.add(key);
  return replyStatic(ctx, consultContactText(), {
    link_preview_options: { is_disabled: true },
    reply_markup: consultConsentKeyboard(),
  });
}

// ── Пакет заявки для админа и специалиста ───────────────────────────

function statusKeyboard(request: ConsultRequest): InlineKeyboard | undefined {
  if (request.status === "NEW") {
    return new InlineKeyboard()
      .text("Связалась", `consult_contacted_${request.id}`)
      .row()
      .text("Консультация завершена", `consult_done_${request.id}`);
  }
  if (request.status === "CONTACTED") {
    return new InlineKeyboard().text("Консультация завершена", `consult_done_${request.id}`);
  }
  return undefined;
}

// Как родителя найти: username, телефон, или прямое предупреждение, что
// ни того ни другого нет и писать будет он сам.
function parentLine(request: ConsultRequest): string {
  const parts: string[] = [];
  if (request.parentUsername) parts.push(`@${request.parentUsername}`);
  if (request.parentPhone) parts.push(request.parentPhone);
  if (!parts.length) parts.push("без username — напишет сам");
  return parts.join(", ");
}

async function babyAge(telegramId: bigint, attempt: number): Promise<string> {
  const answer = await prisma.answer.findFirst({
    where: { telegramId, attempt, questionNumber: 1 },
  });
  return answer?.answerText ?? "не указан";
}

// Источник и цену показываем только у заявок со скидкой: у обычных это
// лишняя строка, которая ничего не добавляет.
function discountLines(request: ConsultRequest): string {
  if (request.source !== "AFTER_PDF") return "";
  return (
    `\nИсточник: после покупки PDF` +
    `\nЦена: ${formatPrice(request.priceRub)} ₽ (скидка)`
  );
}

async function buildSummary(request: ConsultRequest): Promise<string> {
  return (
    `🗓 Новая заявка на консультацию #${request.id}\n` +
    `Родитель: ${parentLine(request)}\n` +
    `Кто пишет первым: ${firstContactLabel(request)}\n` +
    `Возраст малыша: ${await babyAge(request.telegramId, request.attempt)}` +
    discountLines(request)
  );
}

// Полный пакет текстом: с ним специалист начинает работу, не задавая
// родителю вопросов, на которые тот уже ответил в анкете.
export async function buildConsultPackage(request: ConsultRequest): Promise<string> {
  // Разбор и анкету берём того прохождения, по которому записались:
  // специалист должен увидеть то же, что видел родитель, даже если тот
  // успел начать анкету заново.
  const recommendation = await prisma.recommendation.findUnique({
    where: {
      telegramId_attempt: { telegramId: request.telegramId, attempt: request.attempt },
    },
  });

  const header = [
    `ЗАЯВКА НА КОНСУЛЬТАЦИЮ №${request.id}`,
    `Дата: ${request.createdAt.toLocaleString("ru-RU")}`,
    `Родитель: ${request.parentUsername ? `@${request.parentUsername}` : "без username"}`,
    `Телефон: ${request.parentPhone ?? "не передан"}`,
    `Telegram ID: ${request.telegramId}`,
    `Кто пишет первым: ${firstContactLabel(request)}`,
    `Возраст малыша: ${await babyAge(request.telegramId, request.attempt)}`,
    ...(request.source === "AFTER_PDF"
      ? [`Источник: после покупки PDF`, `Цена: ${formatPrice(request.priceRub)} ₽ (скидка)`]
      : []),
  ].join("\n");

  const block = (title: string, body?: string | null) =>
    `\n\n${"=".repeat(60)}\n${title}\n${"=".repeat(60)}\n\n${body?.trim() || "нет"}`;

  return (
    header +
    block("ОТВЕТЫ АНКЕТЫ", await buildPrepText(request.telegramId, request.attempt)) +
    block("СООБЩЕНИЕ 1, ОТПРАВЛЕННОЕ РОДИТЕЛЮ", recommendation?.message1) +
    block("СООБЩЕНИЕ 2, ОТПРАВЛЕННОЕ РОДИТЕЛЮ", recommendation?.message2) +
    block("ВЫВОДЫ АНАЛИЗА", recommendation?.analysis) +
    "\n"
  );
}

// Отправленный родителю план — он есть только у заявок, пришедших из
// предложения после покупки. Файл сохраняется в черновике заказа при
// одобрении, поэтому рендерить заново не нужно.
async function planFile(
  request: ConsultRequest
): Promise<{ bytes: Buffer; name: string } | null> {
  if (request.source !== "AFTER_PDF" || request.orderId == null) return null;

  try {
    const draft = await prisma.pdfDraft.findUnique({ where: { orderId: request.orderId } });
    if (!draft?.pdfBytes) {
      console.error(`У заказа #${request.orderId} нет сохранённого PDF — заявка уйдёт без плана.`);
      return null;
    }
    return { bytes: Buffer.from(draft.pdfBytes), name: `Plan_${request.orderId}.pdf` };
  } catch (error) {
    console.error(`Не удалось достать план заказа #${request.orderId}:`, error);
    return null;
  }
}

// Отправляет заявку админу и, если задан её Telegram ID, специалисту.
// Ничего не бросает наружу: заявка уже создана, и сбой отправки не
// должен выглядеть для родителя как ошибка записи.
export async function sendConsultPackage(api: Api, requestId: number): Promise<void> {
  const request = await prisma.consultRequest.findUnique({ where: { id: requestId } });
  if (!request) return console.error(`Заявка #${requestId} не найдена, пакет не отправлен.`);

  let summary: string;
  let packageText: string;
  try {
    summary = await buildSummary(request);
    packageText = await buildConsultPackage(request);
  } catch (error) {
    console.error(`Не удалось собрать пакет заявки #${requestId}:`, error);
    await api
      .sendMessage(adminChatId(), `⚠️ Заявка #${requestId} создана, но пакет собрать не вышло: ${error}`)
      .catch(() => {});
    return;
  }

  const markup = statusKeyboard(request);
  const fileName = `Zayavka_${request.id}.txt`;
  // Готовый план лежит в базе с момента отправки родителю, так что
  // специалисту он уходит без повторного рендера. Если по какой-то
  // причине файла нет, заявку это не ломает — уйдёт без него.
  const plan = await planFile(request);

  async function sendTo(chatId: number) {
    await api.sendMessage(chatId, summary, markup ? { reply_markup: markup } : undefined);
    await api.sendDocument(chatId, new InputFile(Buffer.from(packageText, "utf8"), fileName));
    if (plan) await api.sendDocument(chatId, new InputFile(plan.bytes, plan.name));
  }

  try {
    await sendTo(adminChatId());
  } catch (error) {
    console.error(`Не удалось отправить заявку #${requestId} админу:`, error);
  }

  const specialist = specialistChatId();
  if (!specialist) return;

  try {
    await sendTo(specialist);
    await logEvent(request.telegramId, "consult_sent_to_specialist");
  } catch (error) {
    // Бот может писать специалисту только после того, как она нажала
    // /start. Пока этого нет, заявка всё равно у админа — её можно
    // передать вручную.
    console.error(`Не удалось отправить заявку #${requestId} специалисту:`, error);
    await api
      .sendMessage(
        adminChatId(),
        `⚠️ Заявку #${requestId} не удалось отправить специалисту: ${error}\n\n` +
          `Обычно это значит, что она ещё не нажимала /start у бота. Передай заявку вручную.`
      )
      .catch(() => {});
  }
}

// ── Смена статуса ───────────────────────────────────────────────────

// Кнопки «Связалась» и «Консультация завершена» под заявкой. Нажать их
// могут и админ, и специалист — у каждой своя копия сообщения.
export function canChangeConsultStatus(telegramId?: number): boolean {
  if (telegramId == null) return false;
  if (String(telegramId) === env.ADMIN_TELEGRAM_ID) return true;
  return specialistChatId() === telegramId;
}

export type ConsultStatusChange = "CONTACTED" | "DONE" | "CANCELED";

// Отметку времени ставим ту, которая соответствует новому статусу:
// прежние остаются как были, чтобы по заявке было видно всю её историю.
export async function setConsultStatus(id: number, status: ConsultStatusChange) {
  const stamps = {
    CONTACTED: { contactedAt: new Date() },
    DONE: { doneAt: new Date() },
    CANCELED: { canceledAt: new Date() },
  }[status];

  return prisma.consultRequest.update({ where: { id }, data: { status, ...stamps } });
}

// Обработчик нажатия в Telegram. Сессию нажавшего не трогает: кнопку
// жмёт специалист, и своей анкеты у неё в боте может не быть вовсе.
export async function handleConsultStatusCallback(ctx: Context) {
  const data = ctx.callbackQuery?.data ?? "";
  const match = data.match(/^consult_(contacted|done)_(\d+)$/);
  if (!match) return;

  if (!canChangeConsultStatus(ctx.from?.id)) {
    return ctx.answerCallbackQuery({ text: "Эта кнопка не для вас.", show_alert: true }).catch(() => {});
  }

  const status = match[1] === "contacted" ? "CONTACTED" : "DONE";
  const id = Number(match[2]);

  try {
    const updated = await setConsultStatus(id, status);
    await ctx.answerCallbackQuery({
      text: status === "CONTACTED" ? `Заявка #${id}: связались.` : `Заявка #${id} закрыта.`,
    });
    // Оставляем под сообщением только те кнопки, которые ещё имеют смысл.
    const markup = statusKeyboard(updated);
    await ctx.editMessageReplyMarkup(markup ? { reply_markup: markup } : undefined).catch(() => {});
  } catch (error) {
    console.error(`Не удалось сменить статус заявки #${id}:`, error);
    await ctx
      .answerCallbackQuery({ text: "Не получилось, подробности в логах.", show_alert: true })
      .catch(() => {});
  }
}

// ── Напоминания ─────────────────────────────────────────────────────
//
// Напоминаний по заявкам больше нет: убраны 19.10.2026 по просьбе
// команды. Висящие заявки видны в админке на /admin/consults, а о новой
// заявке специалист и админ-чат по-прежнему узнают сразу — разовым
// сообщением при её создании, не напоминанием.
