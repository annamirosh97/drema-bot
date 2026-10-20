// Журнал действий админа: сбор данных.
//
// Записи пишутся с этапа 4 из девяти мест. Здесь они собираются в
// таблицу и обогащаются родителем: в самой записи лежит только тип и
// идентификатор сущности, а искать в журнале почти всегда хочется по
// родителю, а не по номеру заказа.

import { prisma } from "../prisma";
import { TableQuery, dateRange, paginate, sortRows } from "./tableChrome";

export interface LogRow {
  id: number;
  createdAt: Date;
  action: string;
  entityType: string;
  entityId: string;
  // Родитель, к которому относится действие. Выводится из сущности:
  // у заказа, заявки и разбора свой telegramId, у сессии это он сам.
  telegramId: string | null;
  parent: string | null;
  // Ссылка на запись, которой касалось действие.
  href: string | null;
  diff: unknown;
}

export interface LogFilters {
  action: string;
}

export function parseLogFilters(query: Record<string, unknown>): LogFilters {
  const str = (k: string) => (typeof query[k] === "string" ? (query[k] as string).trim() : "");
  return { action: str("action") };
}

// Человеческие подписи действий. Коды в базе остаются машинными: по ним
// удобно фильтровать и они не меняются от правки текста.
export const ACTION_LABELS: Record<string, string> = {
  analysis_draft_edited: "Правка черновика разбора",
  analysis_sent: "Разбор отправлен",
  analysis_send_failed: "Разбор не отправился",
  analysis_resent: "Разбор отправлен повторно",
  analysis_resend_failed: "Повтор отправки разбора не удался",
  analysis_regenerated: "Разбор перегенерирован",
  pdf_draft_edited: "Правка черновика плана",
  pdf_sent: "План отправлен",
  pdf_send_failed: "План не отправился",
  pdf_resent: "План отправлен повторно",
  pdf_resend_failed: "Повтор отправки плана не удался",
  pdf_regenerated: "План перегенерирован",
  order_marked_paid: "Заказ отмечен оплаченным",
  receipt_issued: "Чек выбит",
  consult_contacted: "София связалась",
  consult_diary_received: "Дневник сна получен",
  consult_payout_paid: "Выплата Софии",
  consult_status_changed: "Статус заявки изменён",
  user_meta_changed: "Теги и заметка",
  deletion_requested: "Запрос на удаление данных",
};

function hrefFor(entityType: string, entityId: string, telegramId: string | null): string | null {
  switch (entityType) {
    case "order":
      return `/admin/orders/${entityId}`;
    case "consult":
      return `/admin/consults/${entityId}`;
    case "recommendation":
      return telegramId ? `/admin/analysis/${telegramId}` : null;
    case "session":
      return `/admin/users/${entityId}`;
    default:
      return null;
  }
}

export async function loadLog(query: TableQuery, filters: LogFilters) {
  const range = dateRange(query);

  const actions = await prisma.adminAction.findMany({
    where: {
      ...(filters.action ? { action: filters.action } : {}),
      ...(range.gte || range.lte ? { createdAt: range } : {}),
    },
  });

  // Родителя ищем пачками, а не по строке: журнал читают целыми
  // страницами, и отдельный запрос на каждую строку был бы расточителен.
  const idsBy = (type: string) =>
    actions
      .filter((a) => a.entityType === type)
      .map((a) => Number(a.entityId))
      .filter((n) => Number.isFinite(n));

  const [orders, consults, recommendations, sessions] = await Promise.all([
    prisma.order.findMany({
      where: { id: { in: idsBy("order") } },
      select: { id: true, telegramId: true },
    }),
    prisma.consultRequest.findMany({
      where: { id: { in: idsBy("consult") } },
      select: { id: true, telegramId: true },
    }),
    prisma.recommendation.findMany({
      where: { id: { in: idsBy("recommendation") } },
      select: { id: true, telegramId: true },
    }),
    prisma.session.findMany({ select: { telegramId: true, firstName: true, username: true } }),
  ]);

  const orderOwner = new Map(orders.map((o) => [String(o.id), String(o.telegramId)]));
  const consultOwner = new Map(consults.map((c) => [String(c.id), String(c.telegramId)]));
  const recOwner = new Map(recommendations.map((r) => [String(r.id), String(r.telegramId)]));
  const sessionById = new Map(sessions.map((s) => [String(s.telegramId), s]));

  const ownerOf = (type: string, id: string): string | null => {
    switch (type) {
      case "order":
        return orderOwner.get(id) ?? null;
      case "consult":
        return consultOwner.get(id) ?? null;
      case "recommendation":
        return recOwner.get(id) ?? null;
      case "session":
        return id;
      default:
        return null;
    }
  };

  let rows: LogRow[] = actions.map((a) => {
    const telegramId = ownerOf(a.entityType, a.entityId);
    const session = telegramId ? sessionById.get(telegramId) : undefined;
    return {
      id: a.id,
      createdAt: a.createdAt,
      action: a.action,
      entityType: a.entityType,
      entityId: a.entityId,
      telegramId,
      parent: session
        ? session.firstName ?? (session.username ? `@${session.username}` : "без имени")
        : null,
      href: hrefFor(a.entityType, a.entityId, telegramId),
      diff: a.diff,
    };
  });

  // Фильтр по родителю — после обогащения: в самой записи его нет.
  // Берём общий поиск обвязки: принимаем и telegram id, и часть имени.
  if (query.q) {
    const needle = query.q.replace(/^@/, "").toLowerCase();
    rows = rows.filter(
      (r) => r.telegramId === query.q || (r.parent ?? "").toLowerCase().includes(needle)
    );
  }

  const sorted = sortRows(rows, query, {
    created: (r) => r.createdAt.getTime(),
    action: (r) => r.action,
    parent: (r) => r.parent,
  });

  // Список действий для фильтра: только встречающиеся, чтобы не
  // предлагать то, чего в журнале нет.
  const usedActions = [...new Set(actions.map((a) => a.action))].sort();

  return { ...paginate(sorted, query.page), all: sorted, usedActions };
}
