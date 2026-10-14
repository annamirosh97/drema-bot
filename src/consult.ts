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
import { buildPrepText } from "./prep";
import { consultConsentKeyboard } from "./keyboards";

// Заявки в этих статусах считаются живыми: пока такая есть, вторую не
// создаём. DONE и CANCELED не мешают записаться заново.
const OPEN_STATUSES = ["NEW", "CONTACTED"] as const;

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
    await ctx.reply(texts.consultAlreadyExists(env.SPECIALIST_USERNAME));
    return null;
  }

  const request = await createConsultRequest(ctx.api, session.telegramId, username, origin);

  if (!username) {
    // Без username специалист родителя не найдёт, передавать нечего:
    // первым пишет родитель, и пакет можно отправлять сразу.
    await prisma.consultRequest.update({
      where: { id: request.id },
      data: { firstContact: "PARENT" },
    });
    await ctx.reply(texts.consultAcceptedNoUsername(env.SPECIALIST_USERNAME, request.id));
    await sendConsultPackage(ctx.api, request.id);
    return request;
  }

  await prisma.session.update({
    where: { telegramId: session.telegramId },
    data: { stage: "CONSULT_CONSENT" },
  });
  await ctx.reply(texts.consultConsent, { reply_markup: consultConsentKeyboard() });
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
    await ctx.reply(texts.consultContactNotYours, { reply_markup: consultConsentKeyboard() });
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
  await ctx.reply(texts.consultAccepted(env.SPECIALIST_USERNAME), {
    reply_markup: { remove_keyboard: true },
  });
  await sendConsultPackage(ctx.api, request.id);
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

  await ctx.reply(texts.consultSelfWrite(env.SPECIALIST_USERNAME, request.id), {
    reply_markup: { remove_keyboard: true },
  });
  await sendConsultPackage(ctx.api, request.id);
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
  if (nudged.has(key)) return ctx.reply(texts.genericFallback);

  nudged.add(key);
  return ctx.reply(texts.consultConsent, { reply_markup: consultConsentKeyboard() });
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

async function babyAge(telegramId: bigint): Promise<string> {
  const answer = await prisma.answer.findFirst({ where: { telegramId, questionNumber: 1 } });
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
    `Возраст малыша: ${await babyAge(request.telegramId)}` +
    discountLines(request)
  );
}

// Полный пакет текстом: с ним специалист начинает работу, не задавая
// родителю вопросов, на которые тот уже ответил в анкете.
export async function buildConsultPackage(request: ConsultRequest): Promise<string> {
  const recommendation = await prisma.recommendation.findUnique({
    where: { telegramId: request.telegramId },
  });

  const header = [
    `ЗАЯВКА НА КОНСУЛЬТАЦИЮ №${request.id}`,
    `Дата: ${request.createdAt.toLocaleString("ru-RU")}`,
    `Родитель: ${request.parentUsername ? `@${request.parentUsername}` : "без username"}`,
    `Телефон: ${request.parentPhone ?? "не передан"}`,
    `Telegram ID: ${request.telegramId}`,
    `Кто пишет первым: ${firstContactLabel(request)}`,
    `Возраст малыша: ${await babyAge(request.telegramId)}`,
    ...(request.source === "AFTER_PDF"
      ? [`Источник: после покупки PDF`, `Цена: ${formatPrice(request.priceRub)} ₽ (скидка)`]
      : []),
  ].join("\n");

  const block = (title: string, body?: string | null) =>
    `\n\n${"=".repeat(60)}\n${title}\n${"=".repeat(60)}\n\n${body?.trim() || "нет"}`;

  return (
    header +
    block("ОТВЕТЫ АНКЕТЫ", await buildPrepText(request.telegramId)) +
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

const CONSENT_OVERDUE_HOURS = 24;
const CONTACT_OVERDUE_HOURS = 20;
const REMINDER_COOLDOWN_MS = 3 * 60 * 60 * 1000;

// Когда последний раз напоминали, по видам напоминаний. В памяти
// процесса: после перезапуска напомним заново, и это не беда.
const lastReminded = new Map<string, number>();

function dueForReminder(key: string): boolean {
  return Date.now() - (lastReminded.get(key) ?? 0) >= REMINDER_COOLDOWN_MS;
}

// Зовётся из общего цикла напоминаний в engine.ts.
export async function remindAboutStuckConsults(api: Api) {
  const now = Date.now();

  // Родитель записался, но так и не решил, передавать ли контакт.
  const undecided = await prisma.consultRequest.findMany({
    where: {
      firstContact: "PENDING",
      status: { in: [...OPEN_STATUSES] },
      createdAt: { lt: new Date(now - CONSENT_OVERDUE_HOURS * 3_600_000) },
    },
    orderBy: { createdAt: "asc" },
  });

  for (const request of undecided) {
    const key = `consent:${request.id}`;
    if (!dueForReminder(key)) continue;
    await api
      .sendMessage(adminChatId(), `Заявка #${request.id}: родитель не подтвердил контакт.`)
      .then(() => lastReminded.set(key, Date.now()))
      .catch((error) => console.error(`Не удалось напомнить о заявке #${request.id}:`, error));
  }

  // Заявка передана, но специалист ещё не отметил, что связалась.
  // Заявки без выбора родителя сюда не попадают: связываться по ним
  // пока не с чем, про них напоминает проверка выше.
  const waiting = await prisma.consultRequest.findMany({
    where: {
      status: "NEW",
      firstContact: { not: "PENDING" },
      createdAt: { lt: new Date(now - CONTACT_OVERDUE_HOURS * 3_600_000) },
    },
    orderBy: { createdAt: "asc" },
  });

  for (const request of waiting) {
    const key = `contact:${request.id}`;
    if (!dueForReminder(key)) continue;

    const text = `⏰ Заявка на консультацию #${request.id} ждёт контакта больше ${CONTACT_OVERDUE_HOURS} часов.`;
    const recipients = [adminChatId(), specialistChatId()].filter(
      (id): id is number => id !== null
    );

    let delivered = false;
    for (const chatId of recipients) {
      await api
        .sendMessage(chatId, text)
        .then(() => {
          delivered = true;
        })
        .catch((error) => console.error(`Не удалось напомнить о заявке #${request.id}:`, error));
    }
    if (delivered) lastReminded.set(key, Date.now());
  }
}
