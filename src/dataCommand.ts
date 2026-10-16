// Команды /data и /unsubscribe: что бот знает про согласия человека и
// как это изменить.
//
// Работают, даже когда согласие на обработку данных отозвано, — иначе
// отзыв был бы дверью без ручки: человек не смог бы ни посмотреть своё
// состояние, ни передумать. Поэтому эти команды и их кнопки проходят
// мимо общего запрета (см. allowedWithoutPdConsent в engine.ts).
//
// Отзыв согласия ничего не удаляет. Данные удаляются отдельно и вручную,
// порядок определит юрист; журнал согласий не удаляется никогда.

import { Context } from "grammy";
import type { ConsentAction, ConsentSource } from "@prisma/client";
import { env } from "./env";
import { texts } from "./texts";
import { escapeHtml, replyStatic } from "./send";
import {
  ConsentInput,
  formatMoscow,
  getConsentState,
  recordConsent,
} from "./consents";
import {
  DATA_REVOKE_NO,
  DATA_REVOKE_PD,
  DATA_REVOKE_YES,
  DATA_SUBSCRIBE,
  DATA_UNSUBSCRIBE,
  dataKeyboard,
  pdRevokeConfirmKeyboard,
} from "./keyboards";

// Сколько дней даётся на удаление данных после отзыва. Срок назовёт
// юрист; пока это и текст для человека, и срок в уведомлении админу
// держатся на одном числе, чтобы они не разошлись.
const DELETION_DAYS = 30;

// Все кнопки этого экрана. Через них человек управляет согласиями, и
// работать они должны в любом состоянии.
export const DATA_CALLBACKS = new Set([
  "data_unsubscribe",
  "data_subscribe",
  "data_revoke_pd",
  "data_revoke_yes",
  "data_revoke_no",
]);

// ── Экран состояния ─────────────────────────────────────────────────

function statusLine(action: ConsentAction | null, at: Date | null): string {
  if (action === null) return "не дано";
  const word = action === "GRANTED" ? "дано" : action === "DECLINED" ? "не дано" : "отозвано";
  return at ? `${word} с ${formatMoscow(at)}` : word;
}

async function sendOverview(ctx: Context, telegramId: bigint) {
  const state = await getConsentState(telegramId);

  const text = texts.dataOverview(
    statusLine(state.PD_PROCESSING.action, state.PD_PROCESSING.at),
    statusLine(state.MARKETING.action, state.MARKETING.at),
    escapeHtml(env.PRIVACY_POLICY_URL)
  );

  const markup = dataKeyboard({
    canUnsubscribe: state.MARKETING.action === "GRANTED",
    canSubscribe: state.MARKETING.action !== "GRANTED",
    canRevokePd: state.PD_PROCESSING.action === "GRANTED",
  });

  return replyStatic(ctx, text, {
    link_preview_options: { is_disabled: true },
    ...(markup ? { reply_markup: markup } : {}),
  });
}

export async function handleDataCommand(ctx: Context) {
  const from = ctx.from;
  if (!from) return;
  return sendOverview(ctx, BigInt(from.id));
}

// ── Запись изменений ────────────────────────────────────────────────

// Пишем до ответа, как и везде в журнале: не записалось — не сделали.
async function save(ctx: Context, input: ConsentInput): Promise<boolean> {
  try {
    await recordConsent(input);
    return true;
  } catch (error) {
    console.error(`Не удалось записать согласие ${input.type} для #${input.telegramId}:`, error);
    await replyStatic(ctx, texts.consentSaveFailed).catch(() => {});
    return false;
  }
}

// Подписка и отписка от рассылки. Источник разный: из /data и из
// /unsubscribe, по записи должно быть видно, откуда пришло действие.
async function setMarketing(
  ctx: Context,
  telegramId: bigint,
  action: "GRANTED" | "REVOKED",
  source: ConsentSource,
  buttonText: string
) {
  const state = await getConsentState(telegramId);

  // Повторное нажатие новую запись не добавляет: журнал пополняется
  // действиями, а не подтверждениями того, что и так уже так.
  const already =
    (action === "GRANTED" && state.MARKETING.action === "GRANTED") ||
    (action === "REVOKED" && state.MARKETING.action !== "GRANTED");

  if (!already) {
    const saved = await save(ctx, {
      telegramId,
      type: "MARKETING",
      action,
      source,
      documents: ["MARKETING_CONSENT"],
      messageText: texts.dataOverview(
        statusLine(state.PD_PROCESSING.action, state.PD_PROCESSING.at),
        statusLine(state.MARKETING.action, state.MARKETING.at),
        env.PRIVACY_POLICY_URL
      ),
      buttonText,
      telegramMessageId: ctx.callbackQuery?.message?.message_id,
    });
    if (!saved) return;
  }

  await replyStatic(
    ctx,
    action === "GRANTED" ? texts.marketingGranted : texts.marketingRevoked
  );
  return sendOverview(ctx, telegramId);
}

export async function handleUnsubscribeCommand(ctx: Context) {
  const from = ctx.from;
  if (!from) return;
  return setMarketing(
    ctx,
    BigInt(from.id),
    "REVOKED",
    "UNSUBSCRIBE_COMMAND",
    "/unsubscribe"
  );
}

// ── Кнопки ──────────────────────────────────────────────────────────

export async function handleDataCallback(ctx: Context, callbackData: string) {
  const from = ctx.from;
  if (!from) return;
  const telegramId = BigInt(from.id);

  if (callbackData === "data_unsubscribe") {
    await dropKeyboard(ctx);
    return setMarketing(ctx, telegramId, "REVOKED", "DATA_COMMAND", DATA_UNSUBSCRIBE);
  }

  if (callbackData === "data_subscribe") {
    await dropKeyboard(ctx);
    return setMarketing(ctx, telegramId, "GRANTED", "DATA_COMMAND", DATA_SUBSCRIBE);
  }

  if (callbackData === "data_revoke_pd") {
    await dropKeyboard(ctx);
    return replyStatic(ctx, texts.pdRevokeConfirm, {
      reply_markup: pdRevokeConfirmKeyboard(),
    });
  }

  if (callbackData === "data_revoke_no") {
    await dropKeyboard(ctx);
    return replyStatic(ctx, texts.pdRevokeCancelled);
  }

  if (callbackData === "data_revoke_yes") {
    await dropKeyboard(ctx);
    return revokePdConsent(ctx, telegramId);
  }
}

// Отзыв согласия на обработку данных. После него бот молчит: ответы на
// прямые действия человека остаются, но ничего по своей инициативе
// (разбор, оффер, предложения) не отправляется — см. canSend.
async function revokePdConsent(ctx: Context, telegramId: bigint) {
  const saved = await save(ctx, {
    telegramId,
    type: "PD_PROCESSING",
    action: "REVOKED",
    source: "DATA_COMMAND",
    documents: ["PRIVACY_POLICY", "PD_CONSENT"],
    messageText: texts.pdRevokeConfirm,
    buttonText: DATA_REVOKE_YES,
    telegramMessageId: ctx.callbackQuery?.message?.message_id,
  });
  if (!saved) return;

  await replyStatic(ctx, texts.pdRevoked);

  // Данные автоматически не удаляем: порядок удаления определит юрист.
  // Админу уходит срок, до которого это нужно сделать руками.
  const deadline = new Date(Date.now() + DELETION_DAYS * 24 * 3_600_000);
  await ctx.api
    .sendMessage(
      Number(env.ADMIN_TELEGRAM_ID),
      `🔒 Пользователь ${telegramId} отозвал согласие на обработку ПД. ` +
        `Удалить данные до ${formatMoscow(deadline)}`
    )
    .catch((error) => console.error("Не удалось сообщить админу об отзыве согласия:", error));
}

// Убирает кнопки у сообщения, на котором нажали: повторное нажатие по
// тому же экрану ничего не должно менять.
async function dropKeyboard(ctx: Context) {
  if (!ctx.callbackQuery?.message) return;
  await ctx.editMessageReplyMarkup().catch(() => {});
}

export { DELETION_DAYS };
