// Сбор данных для таблицы пользователей и карточки родителя.
//
// Отдельно от отрисовки: страницы получают готовые структуры и в базу
// не ходят. Так их можно проверять без базы, а запросы — читать не
// продираясь через вёрстку.

import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { env } from "../env";
import { attemptView } from "../attempts";
import { getQuestion } from "../questions";
import { safeGetQuestion } from "../prep";
import { buildTimeline, TimelineKind } from "./timeline";
import {
  AttemptCard,
  UserCardData,
  UserRow,
  UsersPageData,
} from "./usersPages";
import { paidTotal, userStatus, UserStatusCode } from "./userStatus";

const PAGE_SIZE = 50;

// ── Время ожидания ──────────────────────────────────────────────────

// «4 ч 12 мин» из ТЗ. Ждёт до сих пор — считаем до сейчас.
export function waitedText(from: Date | null, to: Date | null): string {
  if (!from) return "—";
  const ms = (to ?? new Date()).getTime() - from.getTime();
  if (ms < 0) return "—";
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} ч ${minutes % 60} мин` : `${minutes} мин`;
}

// Цвет по порогам из переменных окружения. Нужен очереди из этапа 4,
// но живёт здесь, рядом с расчётом времени.
export function slaLevel(from: Date | null, to: Date | null): "ok" | "warn" | "danger" {
  if (!from || to) return "ok";
  const hours = (Date.now() - from.getTime()) / 3_600_000;
  if (hours >= env.SLA_DANGER_HOURS) return "danger";
  if (hours >= env.SLA_WARN_HOURS) return "warn";
  return "ok";
}

// ── Таблица ─────────────────────────────────────────────────────────

export interface UsersQuery {
  q: string;
  status: string;
  source: string;
  tag: string;
  blocked: boolean;
  sort: string;
  dir: "asc" | "desc";
  page: number;
}

export function parseUsersQuery(query: Record<string, unknown>): UsersQuery {
  const str = (key: string) => (typeof query[key] === "string" ? (query[key] as string).trim() : "");
  const dir = str("dir") === "desc" ? "desc" : "asc";
  return {
    q: str("q"),
    status: str("status"),
    source: str("source"),
    tag: str("tag"),
    blocked: query.blocked === "1",
    sort: str("sort") || "created",
    dir: str("sort") ? dir : "desc",
    page: Math.max(1, parseInt(str("page") || "1", 10) || 1),
  };
}

// Поиск по имени, username или telegram id. Числовой запрос ищем и как
// id: он чаще всего и означает id.
function searchFilter(q: string): Prisma.SessionWhereInput | null {
  if (!q) return null;
  const or: Prisma.SessionWhereInput[] = [
    { firstName: { contains: q, mode: "insensitive" } },
    { username: { contains: q.replace(/^@/, ""), mode: "insensitive" } },
  ];
  if (/^\d+$/.test(q)) {
    try {
      or.push({ telegramId: BigInt(q) });
    } catch {
      // Число длиннее bigint — просто не ищем по id.
    }
  }
  return { OR: or };
}

export async function loadUsersPage(
  query: UsersQuery,
  pageSize = PAGE_SIZE
): Promise<UsersPageData> {
  const where: Prisma.SessionWhereInput = {};
  const search = searchFilter(query.q);
  if (search) Object.assign(where, search);
  if (query.source) where.source = query.source;
  if (query.tag) where.tags = { has: query.tag };
  if (query.blocked) where.botBlockedAt = { not: null };

  // Статус вычисляется, а не хранится, поэтому фильтр по нему нельзя
  // отдать базе. Берём всё по остальным условиям, считаем статус и
  // отбираем в памяти. Пользователей тысячи, а не миллионы, так что
  // это дешевле, чем денормализовать статус в колонку и ловить
  // расхождения.
  const sessions = await prisma.session.findMany({
    where,
    select: {
      telegramId: true,
      username: true,
      firstName: true,
      createdAt: true,
      source: true,
      tags: true,
      botBlockedAt: true,
      deletionRequestedAt: true,
      attempts: {
        select: { status: true, lastActivityAt: true, lastStep: true, attemptNumber: true },
      },
      recommendations: { select: { status: true, attempt: true } },
      orders: { select: { status: true, paidAt: true, sentAt: true, priceRub: true, refundedAt: true } },
      consultRequests: { select: { status: true } },
    },
  });

  let rows: UserRow[] = sessions.map((s) => ({
    telegramId: String(s.telegramId),
    username: s.username,
    firstName: s.firstName,
    createdAt: s.createdAt,
    source: s.source,
    status: userStatus({
      session: { botBlockedAt: s.botBlockedAt, deletionRequestedAt: s.deletionRequestedAt },
      attempts: s.attempts,
      recommendations: s.recommendations,
      orders: s.orders,
      consults: s.consultRequests,
    }),
    attempts: s.attempts.length,
    paidRub: paidTotal(s.orders),
    tags: s.tags,
    blocked: s.botBlockedAt !== null,
  }));

  if (query.status) {
    rows = rows.filter((r) => r.status.code === (query.status as UserStatusCode));
  }

  const factor = query.dir === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    switch (query.sort) {
      case "name":
        return factor * (a.firstName ?? "").localeCompare(b.firstName ?? "");
      case "attempts":
        return factor * (a.attempts - b.attempts);
      case "paid":
        return factor * (a.paidRub - b.paidRub);
      default:
        return factor * (a.createdAt.getTime() - b.createdAt.getTime());
    }
  });

  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(query.page, pages);

  // Списки для выпадающих фильтров: только то, что реально встречается.
  const sources = [...new Set(sessions.map((s) => s.source).filter((v): v is string => Boolean(v)))].sort();
  const tags = [...new Set(sessions.flatMap((s) => s.tags))].sort();

  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.status) params.set("status", query.status);
  if (query.source) params.set("source", query.source);
  if (query.tag) params.set("tag", query.tag);
  if (query.blocked) params.set("blocked", "1");
  params.set("sort", query.sort);
  params.set("dir", query.dir);

  return {
    rows: Number.isFinite(pageSize) ? rows.slice((page - 1) * pageSize, page * pageSize) : rows,
    total,
    page,
    pages,
    query: query.q,
    status: query.status,
    source: query.source,
    tag: query.tag,
    blocked: query.blocked,
    sort: query.sort,
    dir: query.dir,
    sources,
    tags,
    params: params.toString(),
  };
}

// Для CSV нужна вся выборка, а не страница: по ТЗ выгружается текущая
// выборка целиком.
export async function loadAllUserRows(query: UsersQuery): Promise<UserRow[]> {
  const data = await loadUsersPage(query, Number.POSITIVE_INFINITY);
  return data.rows;
}

// ── Карточка ────────────────────────────────────────────────────────

// Подпись вопроса для списка «вопрос → ответ». Служебные номера
// (CSAT и дополнение после анкеты) называем словами: в анкете их нет.
function questionLabel(number: number): string {
  if (number === 30) return "Оценка опыта (CSAT)";
  if (number === 31) return "Отзыв после оценки";
  if (number === 99) return "Дописала после анкеты";
  const q = safeGetQuestion(number);
  if (!q) return `Вопрос ${number} (убран из анкеты)`;
  const text = (q.shortLabel ?? q.text).replace(/\s+/g, " ").trim();
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

export async function loadUserCard(
  telegramId: bigint,
  timelineFilter: TimelineKind | ""
): Promise<UserCardData | null> {
  const session = await prisma.session.findUnique({
    where: { telegramId },
    include: {
      attempts: { orderBy: { attemptNumber: "asc" } },
      recommendations: { orderBy: { attempt: "asc" } },
      orders: { orderBy: { createdAt: "asc" }, include: { draft: true } },
      consultRequests: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!session) return null;

  const [answers, consents, documents, support, analysisFeedback, pdfFeedback, adminActions] =
    await Promise.all([
      prisma.answer.findMany({
        where: { telegramId },
        orderBy: [{ attempt: "asc" }, { questionNumber: "asc" }],
      }),
      prisma.consentRecord.findMany({ where: { telegramId }, orderBy: { createdAt: "asc" } }),
      prisma.legalDocument.findMany(),
      prisma.supportThread.findUnique({ where: { telegramId } }),
      prisma.analysisFeedback.findUnique({ where: { telegramId } }),
      prisma.pdfFeedback.findMany({ where: { telegramId } }),
      prisma.adminAction.findMany({
        where: { entityType: "session", entityId: String(telegramId) },
        orderBy: { createdAt: "asc" },
      }),
    ]);

  const versionById = new Map(documents.map((d) => [d.id, d.version]));

  // Ответы по прохождениям: нужны и сами ответы, и сравнение с
  // предыдущим прохождением.
  const byAttempt = new Map<number, typeof answers>();
  for (const a of answers) {
    const list = byAttempt.get(a.attempt) ?? [];
    list.push(a);
    byAttempt.set(a.attempt, list);
  }

  const attempts: AttemptCard[] = session.attempts.map((a) => {
    const own = byAttempt.get(a.attemptNumber) ?? [];
    const previous = byAttempt.get(a.attemptNumber - 1);

    const previousAnswers = previous
      ? new Map(previous.map((p) => [questionLabel(p.questionNumber), p.answerText]))
      : null;

    const changed = new Set<string>();
    if (previousAnswers) {
      for (const ans of own) {
        const label = questionLabel(ans.questionNumber);
        const before = previousAnswers.get(label);
        if (before !== undefined && before !== ans.answerText) changed.add(label);
      }
    }

    return {
      attemptNumber: a.attemptNumber,
      version: a.questionnaireVersion,
      startedAt: a.startedAt,
      completedAt: a.completedAt,
      lastStep: a.lastStep,
      view:
        attemptView(a) === "completed"
          ? "завершено"
          : attemptView(a) === "abandoned"
            ? "брошено"
            : "в работе",
      answers: own.map((ans) => ({
        question: questionLabel(ans.questionNumber),
        answer: ans.answerText,
        at: ans.createdAt,
      })),
      changed,
      previousAnswers,
    };
  });

  // Открытый черновик: платный план, который ждёт проверки. На него
  // ссылается шапка карточки.
  const openOrder = session.orders.find((o) => o.draft && !o.draft.approvedAt && !o.sentAt);

  const status = userStatus({
    session: { botBlockedAt: session.botBlockedAt, deletionRequestedAt: session.deletionRequestedAt },
    attempts: session.attempts,
    recommendations: session.recommendations,
    orders: session.orders,
    consults: session.consultRequests,
  });

  const timeline = buildTimeline({
    attempts: session.attempts,
    consents,
    recommendations: session.recommendations,
    orders: session.orders,
    consults: session.consultRequests,
    analysisFeedback,
    pdfFeedback,
    adminActions,
  }).filter((e) => !timelineFilter || e.kind === timelineFilter);

  // Текущее состояние согласия на обработку данных: записи идут от
  // старых к новым, значит последняя и есть текущая.
  const pdRecords = consents.filter((c) => c.type === "PD_PROCESSING");
  const pdLast = pdRecords[pdRecords.length - 1];

  return {
    telegramId: String(telegramId),
    username: session.username,
    firstName: session.firstName,
    createdAt: session.createdAt,
    source: session.source,
    status,
    attemptsCount: session.attempts.length,
    paidRub: paidTotal(session.orders),
    tags: session.tags,
    adminNote: session.adminNote,
    blockedAt: session.botBlockedAt,
    deletionRequestedAt: session.deletionRequestedAt,
    pdConsentWithdrawn: pdLast?.action === "REVOKED" || pdLast?.action === "DECLINED",
    supportThreadId: support?.id ?? null,
    openDraftUrl: openOrder ? `/admin/orders/${openOrder.id}` : null,
    timeline,
    timelineFilter,
    attempts,
    recommendations: session.recommendations.map((r) => ({
      attempt: r.attempt,
      status: r.status,
      createdAt: r.createdAt,
      sentAt: r.sentAt,
      // Черновик модели и то, что ушло родителю. Они различаются, если
      // разбор отправляли вручную через /send.
      aiDraft: joinMessages(r.analysis, null),
      finalText: joinMessages(r.message1, r.message2),
      deliveryError: r.deliveryError,
      cancelReason: r.cancelReason,
      waitedText: waitedText(r.waitStartedAt ?? r.createdAt, r.sentAt),
    })),
    orders: session.orders.map((o) => ({
      id: o.id,
      product: o.product,
      priceRub: o.priceRub,
      status: o.status,
      createdAt: o.createdAt,
      paidAt: o.paidAt,
      sentAt: o.sentAt,
      receiptStatus: o.receiptStatus,
      receiptUrl: o.receiptUrl,
      deliveryError: o.deliveryError,
      waitedText: waitedText(o.paidAt ?? o.createdAt, o.sentAt),
    })),
    consults: session.consultRequests.map((c) => ({
      id: c.id,
      status: c.status,
      createdAt: c.createdAt,
      paidAt: c.paidAt,
      contactedAt: c.contactedAt,
      diaryReceived: c.diaryReceived,
      doneAt: c.doneAt,
      payoutRub: c.consultantPayoutRub,
      payoutPaidAt: c.payoutPaidAt,
    })),
    consents: consents.map((c) => ({
      type: c.type,
      action: c.action,
      version: c.documentIds.map((id) => versionById.get(id)).filter(Boolean).join(", ") || null,
      createdAt: c.createdAt,
    })),
  };
}

function joinMessages(a: string | null, b: string | null): string | null {
  const parts = [a, b].filter((v): v is string => Boolean(v));
  return parts.length ? parts.join("\n\n———\n\n") : null;
}

// ── Журнал действий ─────────────────────────────────────────────────

// Пишем действие админа. Сбой записи не должен мешать самому действию:
// отменить уже отправленное сообщение из-за неудачной записи в журнал
// нельзя, а потерянная строка журнала — меньшая беда.
export async function logAdminAction(
  adminId: bigint,
  action: string,
  entityType: string,
  entityId: string,
  diff?: unknown
): Promise<void> {
  try {
    await prisma.adminAction.create({
      data: {
        adminId,
        action,
        entityType,
        entityId,
        diff: diff === undefined ? undefined : (diff as Prisma.InputJsonValue),
      },
    });
  } catch (error) {
    console.error(`Не удалось записать действие админа ${action}:`, error);
  }
}

export { getQuestion };
