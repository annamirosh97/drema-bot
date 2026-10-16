// Бот поддержки.
//
// Отдельный бот в том же процессе и на той же базе. Родитель пишет ему
// как обычному боту, а его сообщения попадают в свою тему закрытой
// группы; что отвечают в теме, уходит родителю. Про группу он не знает.
//
// Главное правило: основной бот от этого не меняется и не зависит.
// Токена нет — поддержка просто не поднимается. Упала — упала одна: её
// ошибки не выходят за пределы этого файла.

import { Bot, Context } from "grammy";
import { prisma } from "../prisma";
import { env } from "../env";
import { supportTexts } from "./texts";
import type { CardIdentity } from "./card";
import {
  closeTopic,
  ensureTopic,
  sendCard,
  getOrCreateThread,
  getSupportGroupId,
  reopenTopic,
  replayPendingThreads,
  setStatus,
  setSupportGroupId,
  storeMessage,
} from "./threads";

function isSupportAdmin(id?: number): boolean {
  return id != null && env.SUPPORT_ADMIN_IDS.includes(String(id));
}

function identity(ctx: Context): CardIdentity {
  return {
    telegramId: BigInt(ctx.from!.id),
    firstName: ctx.from?.first_name ?? null,
    username: ctx.from?.username ?? null,
  };
}

// Что за вложение пришло: по нему в админке видно, чем был ответ, а
// пересылаем мы всё одинаково — копией.
function describe(ctx: Context): { type: string; text: string | null; fileId: string | null } {
  const m = ctx.message ?? ctx.editedMessage;
  if (!m) return { type: "unknown", text: null, fileId: null };

  const caption = m.caption ?? null;
  if (m.text) return { type: "text", text: m.text, fileId: null };
  if (m.photo?.length) return { type: "photo", text: caption, fileId: m.photo.at(-1)!.file_id };
  if (m.voice) return { type: "voice", text: caption, fileId: m.voice.file_id };
  if (m.video_note) return { type: "video_note", text: caption, fileId: m.video_note.file_id };
  if (m.video) return { type: "video", text: caption, fileId: m.video.file_id };
  if (m.document) return { type: "document", text: caption, fileId: m.document.file_id };
  if (m.audio) return { type: "audio", text: caption, fileId: m.audio.file_id };
  if (m.sticker) return { type: "sticker", text: null, fileId: m.sticker.file_id };
  return { type: "unsupported", text: caption, fileId: null };
}

// ── Альбомы ─────────────────────────────────────────────────────────
//
// Telegram присылает альбом не целиком, а по сообщению на вложение, с
// общим media_group_id. Чтобы в теме он остался альбомом, придерживаем
// такие сообщения на секунду и копируем пачкой.

const ALBUM_WAIT_MS = 1000;
const albums = new Map<string, { ids: number[]; timer: NodeJS.Timeout }>();

function collectAlbum(groupKey: string, messageId: number, flush: (ids: number[]) => void) {
  const existing = albums.get(groupKey);
  if (existing) {
    existing.ids.push(messageId);
    return;
  }

  const entry = {
    ids: [messageId],
    timer: setTimeout(() => {
      albums.delete(groupKey);
      flush(entry.ids);
    }, ALBUM_WAIT_MS),
  };
  albums.set(groupKey, entry);
}

// ── Сторона родителя ────────────────────────────────────────────────

async function handleParentMessage(bot: Bot, ctx: Context) {
  const from = ctx.from;
  const message = ctx.message;
  if (!from || !message) return;

  const telegramId = BigInt(from.id);
  const thread = await getOrCreateThread(telegramId);
  const who = identity(ctx);

  // Закрытое обращение открывается заново, и человек снова получает
  // подтверждение: для него это новый разговор.
  const reopened = thread.status === "CLOSED";
  if (reopened) await reopenTopic(bot.api, thread);

  const groupId = await getSupportGroupId();
  let topicId = thread.topicId;

  if (groupId) {
    // Тему могли удалить руками — тогда заводим новую с пометкой.
    const fresh = await prisma.supportThread.findUnique({ where: { telegramId } });
    topicId = await ensureTopic(bot.api, fresh ?? thread, who, {
      recreated: Boolean(fresh?.topicId === null && fresh?.lastUserMessageAt),
    });
  }

  const info = describe(ctx);
  const stored = await storeMessage({
    threadId: thread.id,
    direction: "IN",
    authorTelegramId: telegramId,
    type: info.type,
    text: info.text,
    fileId: info.fileId,
    userMessageId: message.message_id,
  });

  if (info.type === "unsupported") {
    await ctx.reply(supportTexts.unsupported);
    return;
  }

  if (groupId && topicId) {
    const flush = async (ids: number[]) => {
      try {
        if (ids.length > 1) {
          await bot.api.copyMessages(groupId, Number(telegramId), ids, {
            message_thread_id: topicId!,
          });
        } else {
          const copied = await bot.api.copyMessage(groupId, Number(telegramId), ids[0], {
            message_thread_id: topicId!,
          });
          await prisma.supportMessage
            .update({ where: { id: stored.id }, data: { groupMessageId: copied.message_id } })
            .catch(() => {});
        }
      } catch (error) {
        console.error(`Не удалось передать сообщение от #${telegramId} в тему:`, error);
      }
    };

    if (message.media_group_id) collectAlbum(message.media_group_id, message.message_id, flush);
    else await flush([message.message_id]);
  }

  const updated = await prisma.supportThread.update({
    where: { id: thread.id },
    data: { status: "WAITING", lastUserMessageAt: new Date() },
  });
  await setStatus(bot.api, updated, "WAITING", who);

  // Подтверждение — только на первое сообщение обращения или когда
  // разговор открылся заново. Иначе человек, пишущий в три сообщения,
  // получил бы три одинаковых ответа.
  const isFirst = thread.lastUserMessageAt === null;
  if (isFirst || reopened) await ctx.reply(supportTexts.received);
}

// Правку отдельным сообщением: в Telegram нельзя «переправить» уже
// скопированное, а поддержка должна видеть, что текст изменился.
async function handleParentEdit(bot: Bot, ctx: Context) {
  const from = ctx.from;
  const edited = ctx.editedMessage;
  if (!from || !edited?.text) return;

  const telegramId = BigInt(from.id);
  const thread = await prisma.supportThread.findUnique({ where: { telegramId } });
  const groupId = await getSupportGroupId();
  if (!thread?.topicId || !groupId) return;

  await bot.api
    .sendMessage(groupId, supportTexts.edited(edited.text), {
      message_thread_id: thread.topicId,
    })
    .catch((error) => console.error("Не удалось передать правку в тему:", error));

  await storeMessage({
    threadId: thread.id,
    direction: "IN",
    authorTelegramId: telegramId,
    type: "edit",
    text: edited.text,
    userMessageId: edited.message_id,
  });
}

// ── Сторона поддержки ───────────────────────────────────────────────

async function handleGroupMessage(bot: Bot, ctx: Context) {
  const from = ctx.from;
  const message = ctx.message;
  if (!from || !message || !isSupportAdmin(from.id)) return;

  const groupId = await getSupportGroupId();
  if (!groupId || ctx.chat?.id !== groupId) return;

  const topicId = message.message_thread_id;
  if (!topicId) {
    // Общая тема: непонятно, кому отвечать.
    await ctx.reply(supportTexts.generalHint);
    return;
  }

  const thread = await prisma.supportThread.findFirst({ where: { topicId } });
  if (!thread) {
    await ctx.reply(supportTexts.noThreadHere);
    return;
  }

  const who: CardIdentity = { telegramId: thread.telegramId };
  const info = describe(ctx);

  // Заметка для своих: родителю не уходит, в базе остаётся.
  if (info.text?.startsWith("//")) {
    await storeMessage({
      threadId: thread.id,
      direction: "NOTE",
      authorTelegramId: BigInt(from.id),
      type: info.type,
      text: info.text.slice(2).trim(),
      fileId: info.fileId,
      groupMessageId: message.message_id,
    });
    await react(bot, groupId, message.message_id);
    return;
  }

  try {
    const copied = await bot.api.copyMessage(
      Number(thread.telegramId),
      groupId,
      message.message_id
    );

    await storeMessage({
      threadId: thread.id,
      direction: "OUT",
      authorTelegramId: BigInt(from.id),
      type: info.type,
      text: info.text,
      fileId: info.fileId,
      groupMessageId: message.message_id,
      userMessageId: copied.message_id,
    });

    const updated = await prisma.supportThread.update({
      where: { id: thread.id },
      data: { status: "ANSWERED", lastSupportMessageAt: new Date() },
    });
    await setStatus(bot.api, updated, "ANSWERED", who);
    await react(bot, groupId, message.message_id);
  } catch (error) {
    const description = (error as { description?: string })?.description ?? String(error);
    const blocked = /bot was blocked|user is deactivated/i.test(description);

    console.error(`Не удалось доставить ответ родителю #${thread.telegramId}:`, error);
    await storeMessage({
      threadId: thread.id,
      direction: "OUT",
      authorTelegramId: BigInt(from.id),
      type: info.type,
      text: info.text,
      fileId: info.fileId,
      groupMessageId: message.message_id,
      deliveryError: description,
    });

    await ctx.reply(
      blocked ? supportTexts.notDeliveredBlocked : supportTexts.notDelivered(description)
    );
  }
}

// Реакция — тихое «доставлено». Не поставилась (запрещены реакции,
// слишком старое сообщение) — не беда, доставку это не отменяет.
async function react(bot: Bot, chatId: number, messageId: number) {
  await bot.api
    .setMessageReaction(chatId, messageId, [{ type: "emoji", emoji: "👍" }])
    .catch((error) => console.error("Не удалось поставить реакцию:", error));
}

// ── Привязка группы ─────────────────────────────────────────────────

async function handleBind(bot: Bot, ctx: Context) {
  if (!isSupportAdmin(ctx.from?.id)) return ctx.reply(supportTexts.bindNotAdmin);
  const chat = ctx.chat;
  if (!chat || chat.type === "private") return;

  const full = await bot.api.getChat(chat.id);
  if (!("is_forum" in full) || !full.is_forum) {
    return ctx.reply(supportTexts.bindNeedsTopics);
  }

  const me = await bot.api.getChatMember(chat.id, bot.botInfo.id);
  const missing: string[] = [];
  if (!("can_manage_topics" in me) || !me.can_manage_topics) missing.push("управление темами");
  if (!("can_pin_messages" in me) || !me.can_pin_messages) missing.push("закрепление сообщений");
  if (missing.length) return ctx.reply(supportTexts.bindNeedsRights(missing));

  const current = await getSupportGroupId();
  if (current && current !== chat.id) {
    // Переключение — действие, которое молча делать не стоит: прежняя
    // группа перестанет получать обращения.
    return ctx.reply(supportTexts.bindAlreadyBound(String(current)), {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Да, переключить", callback_data: "support_bind_yes" }],
          [{ text: "Отмена", callback_data: "support_bind_no" }],
        ],
      },
    });
  }

  await setSupportGroupId(chat.id);
  await ctx.reply(supportTexts.bound);

  // Всё, что накопилось без группы, переезжает в темы.
  const moved = await replayPendingThreads(bot.api);
  if (moved) await ctx.reply(`Перенёс накопленных сообщений: ${moved}.`);
}

// ── Команды в теме ──────────────────────────────────────────────────

async function handleDone(bot: Bot, ctx: Context) {
  if (!isSupportAdmin(ctx.from?.id)) return;
  const topicId = ctx.message?.message_thread_id;
  if (!topicId) return;

  const thread = await prisma.supportThread.findFirst({ where: { topicId } });
  if (!thread) return ctx.reply(supportTexts.noThreadHere);

  await setStatus(bot.api, thread, "CLOSED", { telegramId: thread.telegramId });
  await closeTopic(bot.api, thread);
  // Родителю ничего не отправляем: закрытие — наша внутренняя отметка.
}

async function handleCard(bot: Bot, ctx: Context) {
  if (!isSupportAdmin(ctx.from?.id)) return;
  const topicId = ctx.message?.message_thread_id;
  const groupId = await getSupportGroupId();
  if (!topicId || !groupId) return;

  const thread = await prisma.supportThread.findFirst({ where: { topicId } });
  if (!thread) return ctx.reply(supportTexts.noThreadHere);

  await sendCard(bot.api, groupId, topicId, { telegramId: thread.telegramId });
}

// ── Запуск ──────────────────────────────────────────────────────────

export function startSupportBot(): void {
  if (!env.SUPPORT_BOT_TOKEN) {
    console.log("SUPPORT_BOT_TOKEN не задан — бот поддержки не запускается.");
    return;
  }

  const bot = new Bot(env.SUPPORT_BOT_TOKEN);

  bot.command("start", async (ctx) => {
    if (ctx.chat?.type !== "private") return;
    // Параметр ссылки (/start src_pdf) запоминаем как источник.
    const source = ctx.match?.toString().trim() || undefined;
    await getOrCreateThread(BigInt(ctx.from!.id), source);
    await ctx.reply(supportTexts.welcome(), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });

  bot.command("bind", (ctx) => handleBind(bot, ctx));
  bot.command("done", (ctx) => handleDone(bot, ctx));
  bot.command("card", (ctx) => handleCard(bot, ctx));

  bot.callbackQuery("support_bind_yes", async (ctx) => {
    if (!isSupportAdmin(ctx.from?.id) || !ctx.chat) return;
    await setSupportGroupId(ctx.chat.id);
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.reply(supportTexts.bindSwitched);
    await replayPendingThreads(bot.api);
  });

  bot.callbackQuery("support_bind_no", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.reply(supportTexts.bindCancelled);
  });

  bot.on("edited_message", (ctx) => {
    if (ctx.chat?.type !== "private") return;
    return handleParentEdit(bot, ctx);
  });

  bot.on("message", async (ctx) => {
    if (ctx.chat?.type === "private") return handleParentMessage(bot, ctx);
    return handleGroupMessage(bot, ctx);
  });

  bot.catch((err) => {
    console.error("Ошибка в боте поддержки:", err.message, err.error);
  });

  // Не ждём: бот поддержки не должен задерживать запуск основного, а
  // его падение не должно ронять процесс целиком.
  void bot
    .start({
      onStart: (info) => console.log(`Бот поддержки @${info.username} запущен.`),
    })
    .catch((error) => console.error("Бот поддержки не запустился:", error));
}
