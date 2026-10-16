// Темы в группе поддержки и доставка сообщений в обе стороны.
//
// Одна тема на родителя на всё время. Внутри темы ответ не нужно
// привязывать к сообщению: адресат определяется самой темой.
//
// Сообщения копируются, а не пересылаются (copyMessage): пересланное
// показывало бы родителю, из какого чата оно пришло, а он про группу
// поддержки знать не должен.

import { Api } from "grammy";
import type { SupportStatus, SupportThread } from "@prisma/client";
import { prisma } from "../prisma";
import { buildSupportCard, buildTopicTitle, CardIdentity } from "./card";
import { supportTexts } from "./texts";

const STATUS_EMOJI: Record<SupportStatus, string> = {
  WAITING: "🟡",
  ANSWERED: "🟢",
  CLOSED: "✅",
};

// ── Привязка группы ─────────────────────────────────────────────────

const GROUP_KEY = "supportGroupId";

export async function getSupportGroupId(): Promise<number | null> {
  const row = await prisma.setting.findUnique({ where: { key: GROUP_KEY } });
  if (!row) return null;
  const id = Number(row.value);
  return Number.isFinite(id) ? id : null;
}

export async function setSupportGroupId(chatId: number): Promise<void> {
  await prisma.setting.upsert({
    where: { key: GROUP_KEY },
    create: { key: GROUP_KEY, value: String(chatId) },
    update: { value: String(chatId) },
  });
}

// ── Обращения ───────────────────────────────────────────────────────

export async function getOrCreateThread(
  telegramId: bigint,
  source?: string
): Promise<SupportThread> {
  const existing = await prisma.supportThread.findUnique({ where: { telegramId } });
  if (existing) {
    // Источник записываем только если его ещё не было: первая метка
    // честнее последней.
    if (source && !existing.source) {
      return prisma.supportThread.update({ where: { telegramId }, data: { source } });
    }
    return existing;
  }
  return prisma.supportThread.create({ data: { telegramId, source: source ?? null } });
}

// Создаёт тему и закрепляет в ней карточку. Возвращает id темы или
// null, если группа не привязана либо создать тему не вышло.
export async function ensureTopic(
  api: Api,
  thread: SupportThread,
  who: CardIdentity,
  options: { recreated?: boolean } = {}
): Promise<number | null> {
  if (thread.topicId) return thread.topicId;

  const groupId = await getSupportGroupId();
  if (!groupId) return null; // копим сообщения до привязки

  try {
    const title = await buildTopicTitle(STATUS_EMOJI[thread.status], who);
    const topic = await api.createForumTopic(groupId, title);

    await prisma.supportThread.update({
      where: { id: thread.id },
      data: { topicId: topic.message_thread_id },
    });

    if (options.recreated) {
      await api.sendMessage(groupId, supportTexts.topicRecreated, {
        message_thread_id: topic.message_thread_id,
      });
    }

    await sendCard(api, groupId, topic.message_thread_id, who);
    return topic.message_thread_id;
  } catch (error) {
    console.error(`Не удалось создать тему для #${thread.telegramId}:`, error);
    return null;
  }
}

// Карточка уходит отдельным сообщением и закрепляется: так она видна
// в шапке темы, даже когда переписка стала длинной.
export async function sendCard(
  api: Api,
  groupId: number,
  topicId: number,
  who: CardIdentity
): Promise<void> {
  try {
    const card = await buildSupportCard(who);
    const message = await api.sendMessage(groupId, card, {
      message_thread_id: topicId,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    await api
      .pinChatMessage(groupId, message.message_id, { disable_notification: true })
      .catch((error) => console.error("Не удалось закрепить карточку:", error));
  } catch (error) {
    console.error("Не удалось отправить карточку:", error);
  }
}

// ── Статусы ─────────────────────────────────────────────────────────

// Статус живёт в названии темы: его видно в списке тем, не открывая.
export async function setStatus(
  api: Api,
  thread: SupportThread,
  status: SupportStatus,
  who: CardIdentity
): Promise<void> {
  const data: Record<string, unknown> = { status };
  if (status === "CLOSED") data.closedAt = new Date();
  await prisma.supportThread.update({ where: { id: thread.id }, data });

  const groupId = await getSupportGroupId();
  if (!groupId || !thread.topicId) return;

  try {
    const title = await buildTopicTitle(STATUS_EMOJI[status], who);
    await api.editForumTopic(groupId, thread.topicId, { name: title });
  } catch (error) {
    console.error(`Не удалось сменить статус темы #${thread.topicId}:`, error);
  }
}

export async function closeTopic(api: Api, thread: SupportThread): Promise<void> {
  const groupId = await getSupportGroupId();
  if (!groupId || !thread.topicId) return;
  await api
    .closeForumTopic(groupId, thread.topicId)
    .catch((error) => console.error("Не удалось закрыть тему:", error));
}

export async function reopenTopic(api: Api, thread: SupportThread): Promise<void> {
  const groupId = await getSupportGroupId();
  if (!groupId || !thread.topicId) return;
  await api
    .reopenForumTopic(groupId, thread.topicId)
    .catch((error) => console.error("Не удалось открыть тему заново:", error));
}

// ── Запись в базу ───────────────────────────────────────────────────

export interface StoredMessage {
  threadId: number;
  direction: "IN" | "OUT" | "NOTE";
  authorTelegramId: bigint;
  type: string;
  text?: string | null;
  fileId?: string | null;
  userMessageId?: number | null;
  groupMessageId?: number | null;
  deliveryError?: string | null;
}

export async function storeMessage(message: StoredMessage) {
  return prisma.supportMessage.create({
    data: {
      threadId: message.threadId,
      direction: message.direction,
      authorTelegramId: message.authorTelegramId,
      type: message.type,
      text: message.text ?? null,
      fileId: message.fileId ?? null,
      userMessageId: message.userMessageId ?? null,
      groupMessageId: message.groupMessageId ?? null,
      deliveryError: message.deliveryError ?? null,
    },
  });
}

// ── Перенос накопленного при привязке группы ────────────────────────

// Пока группы не было, сообщения родителей копились в базе. Теперь у
// каждого появляется тема, и всё написанное переезжает в неё по порядку.
//
// Копируем из чата с родителем: оригиналы там никуда не делись, и
// Telegram пустит нас копировать их хоть через неделю.
export async function replayPendingThreads(api: Api): Promise<number> {
  const groupId = await getSupportGroupId();
  if (!groupId) return 0;

  const threads = await prisma.supportThread.findMany({ where: { topicId: null } });
  let moved = 0;

  for (const thread of threads) {
    const messages = await prisma.supportMessage.findMany({
      where: { threadId: thread.id, direction: "IN", groupMessageId: null },
      orderBy: { createdAt: "asc" },
    });

    const who: CardIdentity = { telegramId: thread.telegramId };
    const topicId = await ensureTopic(api, thread, who);
    if (!topicId) continue;

    for (const message of messages) {
      if (message.userMessageId == null) continue;
      try {
        const copied = await api.copyMessage(
          groupId,
          Number(thread.telegramId),
          message.userMessageId,
          { message_thread_id: topicId }
        );
        await prisma.supportMessage.update({
          where: { id: message.id },
          data: { groupMessageId: copied.message_id },
        });
        moved++;
      } catch (error) {
        console.error(`Не удалось перенести сообщение #${message.id} в тему:`, error);
      }
    }
  }

  return moved;
}

export { STATUS_EMOJI };
