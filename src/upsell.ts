// Предложение консультации со скидкой тем, кто купил план.
//
// Приходит через пару минут после самого файла — отдельным сообщением,
// не подписью к нему: план нужно сначала открыть, а предложение прочесть
// после. Отправку ведёт планировщик, а не setTimeout: деплой случается
// чаще, чем раз в две минуты, и таймер бы просто потерялся.
//
// Срок скидки считаем концом дня по Москве. Контейнер живёт в UTC, и
// если считать конец дня там, родитель, купивший план поздно вечером,
// получил бы на день меньше, чем написано в сообщении.

import { Api, Context, InlineKeyboard } from "grammy";
import type { Session, UpsellOffer } from "@prisma/client";
import { prisma } from "./prisma";
import { env } from "./env";
import { formatPrice, texts } from "./texts";
import { startConsultRequest } from "./consult";
import { allowedToSend } from "./consents";
import { isAllowed } from "./engine";
import { isPermanentSendError } from "./feedback";
import { escapeHtml, replyStatic, sendStatic } from "./send";
import {
  upsellCardKeyboard,
  upsellExpiredKeyboard,
  upsellOfferKeyboard,
} from "./keyboards";

// ── Срок действия и дата в тексте ───────────────────────────────────

const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;

const MONTHS = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

// Конец дня по Москве через UPSELL_VALID_DAYS дней. Сдвигаем время в
// московское, отрезаем часы, прибавляем дни и возвращаемся в UTC —
// так не нужно полагаться на часовой пояс машины.
export function expiryFor(sentAt: Date, days = env.UPSELL_VALID_DAYS): Date {
  const moscow = new Date(sentAt.getTime() + MOSCOW_OFFSET_MS);
  const midnight = Date.UTC(
    moscow.getUTCFullYear(),
    moscow.getUTCMonth(),
    moscow.getUTCDate() + days + 1
  );
  // Полночь следующего дня минус миллисекунда — это конец нужного дня.
  return new Date(midnight - MOSCOW_OFFSET_MS - 1);
}

// «21 октября» — дата последнего дня скидки, тоже по Москве.
export function formatOfferDate(expiresAt: Date): string {
  const moscow = new Date(expiresAt.getTime() + MOSCOW_OFFSET_MS);
  return `${moscow.getUTCDate()} ${MONTHS[moscow.getUTCMonth()]}`;
}

// Ссылка на оферту: подставляется в карточки, где её принимают нажатием.
function offerUrl(): string {
  return escapeHtml(env.OFFER_URL);
}

function price(): string {
  return formatPrice(env.UPSELL_PRICE_RUB);
}

function fullPrice(offer: UpsellOffer): string {
  return formatPrice(offer.fullPriceRub);
}

// ── Отправка ────────────────────────────────────────────────────────

// Раз в минуту: задержка по умолчанию две минуты, реже проверять
// бессмысленно. Проверка дешёвая — один запрос по индексу статуса.
const CHECK_INTERVAL_MS = 60 * 1000;

export function startUpsellScheduler(api: Api) {
  setInterval(() => {
    void sendDueUpsells(api).catch((error) =>
      console.error("Не удалось разослать предложения после PDF:", error)
    );
  }, CHECK_INTERVAL_MS);
}

// Кому предложение не нужно: тем, кому его уже отправляли, и тем, у кого
// есть живая заявка на консультацию. Отменённая заявка не в счёт — по
// ней родитель остался без ничего.
//
// Собираем список и исключаем его из запроса, а не фильтруем по связи:
// иначе заказы пропущенных родителей оставались бы в выборке навсегда и
// занимали собой окно. Список короткий — это купившие план, их десятки.
async function telegramIdsToSkip(): Promise<bigint[]> {
  const [offered, consulting] = await Promise.all([
    prisma.upsellOffer.findMany({ select: { telegramId: true } }),
    prisma.consultRequest.findMany({
      where: { status: { not: "CANCELED" } },
      select: { telegramId: true },
    }),
  ]);
  return [...new Set([...offered, ...consulting].map((row) => String(row.telegramId)))].map(
    (id) => BigInt(id)
  );
}

export async function sendDueUpsells(api: Api) {
  const readyAt = new Date(Date.now() - env.UPSELL_DELAY_MIN * 60_000);

  // Отправленные планы, по которым предложения ещё не было. Берём по
  // старшинству и помалу: спешить некуда, а разом разослать сотню
  // сообщений Telegram всё равно не даст.
  const orders = await prisma.order.findMany({
    where: {
      status: "SENT",
      sentAt: { lte: readyAt },
      telegramId: { notIn: await telegramIdsToSkip() },
    },
    orderBy: { sentAt: "asc" },
    take: 20,
  });

  // Один родитель мог купить несколько планов: предложение всё равно
  // одно, поэтому второй его заказ в этом же проходе пропускаем.
  const done = new Set<string>();

  for (const order of orders) {
    const key = String(order.telegramId);
    if (done.has(key)) continue;
    done.add(key);

    try {
      if (!isAllowed(order.telegramId)) continue;
      // Это предложение, а не то, за чем человек пришёл: без согласия
      // на рассылку оно не уходит, и отказ записывается.
      if (!(await allowedToSend(order.telegramId, "MARKETING", "upsell_offer"))) continue;
      await sendUpsell(api, order.id, order.telegramId);
    } catch (error) {
      console.error(`Не удалось отправить предложение по заказу #${order.id}:`, error);
      // Строка уже создана, так что повтора не будет и без пометки, но
      // без неё непонятно, почему предложение так и не ушло.
      if (isPermanentSendError(error)) {
        await prisma.upsellOffer
          .update({
            where: { telegramId: order.telegramId },
            data: { skipReason: "родитель остановил бота" },
          })
          .catch(() => {});
      }
    }
  }
}

// Отправляет предложение и запоминает его. Запись создаётся до отправки:
// если Telegram не примет сообщение, второй попытки не будет, и это
// лучше, чем долбить родителя при каждом тике планировщика.
async function sendUpsell(api: Api, orderId: number, telegramId: bigint) {
  const session = await prisma.session.findUnique({ where: { telegramId } });
  if (!session) return;

  const sentAt = new Date();
  const offer = await prisma.upsellOffer.create({
    data: {
      telegramId,
      orderId,
      priceRub: env.UPSELL_PRICE_RUB,
      fullPriceRub: env.CONSULT_PRICE_RUB,
      sentAt,
      expiresAt: expiryFor(sentAt),
    },
  });

  const message = await sendStatic(
    api,
    session.chatId,
    texts.upsellOffer(price(), fullPrice(offer), formatOfferDate(offer.expiresAt), offerUrl()),
    { reply_markup: upsellOfferKeyboard(price()) }
  );

  await prisma.upsellOffer.update({
    where: { id: offer.id },
    data: { messageId: message.message_id },
  });
  await logUpsellEvent(telegramId, "upsell_shown");
}

// ── Кнопки ──────────────────────────────────────────────────────────

type UpsellEvent =
  | "upsell_shown"
  | "upsell_details"
  | "upsell_signup"
  | "upsell_declined"
  | "upsell_expired_click";

async function logUpsellEvent(telegramId: bigint, type: UpsellEvent) {
  await prisma.offerEvent
    .create({ data: { telegramId, type } })
    .catch((error) => console.error("Не удалось записать событие предложения:", error));
}

// Та же логика, что у карточек основного оффера: правим то же
// сообщение, а если не дали — отправляем новым.
async function replaceWithCard(ctx: Context, text: string, markup: InlineKeyboard) {
  try {
    await ctx.editMessageText(text, { reply_markup: markup, parse_mode: "HTML" });
  } catch (error) {
    if (String(error).includes("message is not modified")) return;
    await replyStatic(ctx, text, { reply_markup: markup });
  }
}

export async function handleUpsell(ctx: Context, session: Session, callbackData: string) {
  const offer = await prisma.upsellOffer.findUnique({ where: { telegramId: session.telegramId } });
  // Предложения нет — значит, нажали кнопку под сообщением, которого в
  // базе уже нет (например, после /reset). Молчим.
  if (!offer) return;

  const date = formatOfferDate(offer.expiresAt);

  if (callbackData === "upsell_details") {
    await logUpsellEvent(session.telegramId, "upsell_details");
    return replaceWithCard(
      ctx,
      texts.upsellConsultCard(price(), fullPrice(offer), date, offerUrl()),
      upsellCardKeyboard(price())
    );
  }

  if (callbackData === "upsell_back") {
    return replaceWithCard(
      ctx,
      texts.upsellOffer(price(), fullPrice(offer), date, offerUrl()),
      upsellOfferKeyboard(price())
    );
  }

  if (callbackData === "upsell_signup") return handleUpsellSignup(ctx, session, offer);
  if (callbackData === "upsell_decline") return handleUpsellDecline(ctx, session, offer, date);
}

async function handleUpsellSignup(ctx: Context, session: Session, offer: UpsellOffer) {
  if (Date.now() > offer.expiresAt.getTime()) {
    await logUpsellEvent(session.telegramId, "upsell_expired_click");
    return replyStatic(ctx, texts.upsellExpired, {
      reply_markup: upsellExpiredKeyboard(fullPrice(offer)),
    });
  }

  await logUpsellEvent(session.telegramId, "upsell_signup");

  // Дальше — ровно тот же путь, что и в основном оффере: согласие на
  // передачу контакта, подтверждение родителю, пакет заявки. Разница
  // только в цене, источнике и привязке к заказу.
  const request = await startConsultRequest(ctx, session, {
    priceRub: offer.priceRub,
    source: "AFTER_PDF",
    orderId: offer.orderId,
    cardText: texts.upsellConsultCard(
      price(),
      fullPrice(offer),
      formatOfferDate(offer.expiresAt),
      env.OFFER_URL
    ),
  });
  if (!request) return;

  await prisma.upsellOffer.update({
    where: { id: offer.id },
    data: { consultRequestId: request.id },
  });
}

// Кнопки в самом предложении не убираем: скидка действует ещё несколько
// дней, и родитель может передумать.
async function handleUpsellDecline(
  ctx: Context,
  session: Session,
  offer: UpsellOffer,
  date: string
) {
  // Повторный тап не должен присылать второе такое же сообщение.
  if (offer.declinedAt) return;

  await prisma.upsellOffer.update({ where: { id: offer.id }, data: { declinedAt: new Date() } });
  await logUpsellEvent(session.telegramId, "upsell_declined");
  return replyStatic(ctx, texts.upsellDeclined(date));
}
