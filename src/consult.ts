// Заявки на консультацию специалиста.
//
// Главное правило этого файла: контакт родителя не уходит специалисту,
// пока родитель сам этого не разрешил. Поэтому заявка создаётся в
// состоянии firstContact = PENDING, и пакет с анкетой и разбором
// отправляется только после того, как родитель нажал «Поделиться
// контактом» или «Я напишу специалисту сам(а)».
//
// Создание заявки и отправка пакета намеренно разведены по отдельным
// функциям: позже между ними встанет оплата, и тогда пакет будет
// уходить по событию «заявка оплачена», а не из обработчика кнопки.

import { Api, Context, InlineKeyboard, InputFile } from "grammy";
import type { ConsultRequest, ConsultSource, Session } from "@prisma/client";
import { prisma } from "./prisma";
import { env } from "./env";
import { formatPrice, texts } from "./texts";
import { ConsentInput, recordConsent } from "./consents";
import { buildPrepText } from "./prep";
import { currentAttempt } from "./attempt";
import { CONSULT_SELF_WRITE_BUTTON, consultConsentKeyboard } from "./keyboards";
import { escapeHtml, replyStatic } from "./send";
import { logEvent } from "./events";

// Заявки в этих статусах считаются живыми: пока такая есть, вторую не
// создаём. DONE и CANCELED не мешают записаться заново.
const OPEN_STATUSES = ["NEW", "CONTACTED"] as const;

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
    messageText: consultConsentText(),
    buttonText,
    telegramMessageId: ctx.callbackQuery?.message?.message_id,
    relatedConsultRequestId: requestId,
  });
}

// В сообщении о контакте стоит ссылка на согласие — адрес приходит из
// переменных окружения и в HTML должен быть обезврежен.
export function consultConsentText(): string {
  return texts.consultConsent(escapeHtml(env.PD_CONSENT_URL));
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

// Создаёт заявку и коротко сообщает админу. Пакет не отправляет: ждём
// выбора родителя (или, в будущем, оплаты).
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

  await api
    .sendMessage(
      adminChatId(),
      `🗓 Заявка на консультацию #${request.id} создана, ждём выбора родителя.`
    )
    .catch((error) => console.error("Не удалось сообщить админу о заявке:", error));

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
  const username = ctx.from?.username;

  const existing = await prisma.consultRequest.findFirst({
    where: { telegramId: session.telegramId, status: { in: [...OPEN_STATUSES] } },
    orderBy: { createdAt: "desc" },
  });
  if (existing) {
    await logEvent(session.telegramId, "consult_signup_duplicate");
    await replyStatic(ctx, texts.consultAlreadyExists(escapeHtml(env.SPECIALIST_USERNAME)));
    return null;
  }

  const request = await createConsultRequest(ctx.api, session.telegramId, username, origin);

  // Условия оферты написаны в карточке, над кнопкой с ценой: нажатие и
  // есть их принятие. Источник и текст карточки зависят от того, откуда
  // человек записался — из основного оффера или из предложения со
  // скидкой после покупки плана.
  await saveConsent(ctx, {
    telegramId: session.telegramId,
    type: "OFFER_ACCEPTANCE",
    action: "GRANTED",
    source: origin.source === "AFTER_PDF" ? "UPSELL" : "CONSULT_SIGNUP",
    documents: ["OFFER"],
    messageText: origin.cardText ?? "",
    buttonText: `Записаться за ${formatPrice(request.priceRub)} ₽`,
    telegramMessageId: ctx.callbackQuery?.message?.message_id,
    relatedConsultRequestId: request.id,
  });

  if (!username) {
    // Без username специалист родителя не найдёт, передавать нечего:
    // первым пишет родитель, и пакет можно отправлять сразу.
    await prisma.consultRequest.update({
      where: { id: request.id },
      data: { firstContact: "PARENT" },
    });
    const transferred = await recordSpecialistTransfer(
      ctx,
      session.telegramId,
      request.id,
      "без username — пакет уходит специалисту, первым пишет родитель"
    );
    await replyStatic(ctx, texts.consultAcceptedNoUsername(escapeHtml(env.SPECIALIST_USERNAME), request.id));
    if (transferred) await sendConsultPackage(ctx.api, request.id);
    return request;
  }

  await prisma.session.update({
    where: { telegramId: session.telegramId },
    data: { stage: "CONSULT_CONSENT" },
  });
  await replyStatic(ctx, consultConsentText(), { reply_markup: consultConsentKeyboard() });
  return request;
}

// ── Выбор родителя: передать контакт или написать самому ────────────

// Заявка, которая ждёт выбора родителя. null — ждать нечего.
async function pendingRequest(telegramId: bigint): Promise<ConsultRequest | null> {
  return prisma.consultRequest.findFirst({
    where: { telegramId, firstContact: "PENDING", status: { in: [...OPEN_STATUSES] } },
    orderBy: { createdAt: "desc" },
  });
}

// Возвращает родителя из стадии ожидания согласия обратно к офферу:
// кнопки продуктов остаются в чате и должны продолжать работать.
async function leaveConsentStage(telegramId: bigint, stage: Session["stage"]) {
  if (stage !== "CONSULT_CONSENT") return;
  await prisma.session.update({ where: { telegramId }, data: { stage: "FAKE_DOOR_OFFER" } });
}

// Родитель прислал контакт. Возвращает false, если ждать его было
// незачем — тогда вызывающий решает, что делать с сообщением.
export async function takeConsultContact(
  ctx: Context,
  session: Session,
  contact: { user_id?: number; phone_number: string }
): Promise<boolean> {
  const request = await pendingRequest(session.telegramId);
  if (!request) return false;

  // Переслать можно контакт любого человека из своей книги. Чужой номер
  // специалисту не нужен и согласием не является.
  if (contact.user_id == null || BigInt(contact.user_id) !== session.telegramId) {
    await logEvent(session.telegramId, "consult_wrong_contact");
    await replyStatic(ctx, texts.consultContactNotYours, { reply_markup: consultConsentKeyboard() });
    return true;
  }

  await prisma.consultRequest.update({
    where: { id: request.id },
    data: {
      parentPhone: contact.phone_number,
      contactConsentAt: new Date(),
      firstContact: "SPECIALIST",
      // username мог появиться уже после создания заявки.
      parentUsername: ctx.from?.username ?? request.parentUsername,
    },
  });
  await leaveConsentStage(session.telegramId, session.stage);

  // remove_keyboard — чтобы клавиатура согласия не висела внизу чата
  // после того, как выбор сделан.
  const transferred = await recordSpecialistTransfer(
    ctx,
    session.telegramId,
    request.id,
    "Поделиться контактом"
  );

  await logEvent(session.telegramId, "consult_contact_shared");
  await replyStatic(ctx, texts.consultAccepted(escapeHtml(env.SPECIALIST_USERNAME)), {
    reply_markup: { remove_keyboard: true },
  });
  if (transferred) await sendConsultPackage(ctx.api, request.id);
  return true;
}

// Нажали «Я напишу специалисту сам(а)». Возвращает false, если такой
// заявки нет: значит, это просто совпавший с подписью кнопки текст.
export async function takeConsultSelfWrite(ctx: Context, session: Session): Promise<boolean> {
  const request = await pendingRequest(session.telegramId);
  if (!request) return false;

  await prisma.consultRequest.update({
    where: { id: request.id },
    data: { firstContact: "PARENT", parentUsername: ctx.from?.username ?? request.parentUsername },
  });
  await leaveConsentStage(session.telegramId, session.stage);

  const transferred = await recordSpecialistTransfer(
    ctx,
    session.telegramId,
    request.id,
    CONSULT_SELF_WRITE_BUTTON
  );

  await logEvent(session.telegramId, "consult_self_contact");
  await replyStatic(ctx, texts.consultSelfWrite(escapeHtml(env.SPECIALIST_USERNAME), request.id), {
    reply_markup: { remove_keyboard: true },
  });
  if (transferred) await sendConsultPackage(ctx.api, request.id);
  return true;
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
  return replyStatic(ctx, consultConsentText(), { reply_markup: consultConsentKeyboard() });
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
