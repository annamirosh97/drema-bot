// Данные для таблиц прохождений, согласий, разборов, заказов и
// консультаций, плюс воронка анкеты и итоги по деньгам.
//
// Запросы здесь, вёрстка в tablesPages.ts. Общая обвязка — поиск,
// сортировка, страницы — в tableChrome.ts.

import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { attemptView } from "../attempts";
import { QUESTIONS } from "../questions";
import { analysisStatus, pdfStatus } from "./queueData";
import { waitedText } from "./usersData";
import {
  TableQuery,
  dateRange,
  paginate,
  sortRows,
} from "./tableChrome";

// Кого искать по имени, username или telegram id. Таблицы ищут по
// родителю, а не по своей сущности, поэтому фильтр один на всех.
async function matchingUsers(q: string): Promise<bigint[] | null> {
  if (!q) return null;
  const or: Prisma.SessionWhereInput[] = [
    { firstName: { contains: q, mode: "insensitive" } },
    { username: { contains: q.replace(/^@/, ""), mode: "insensitive" } },
  ];
  if (/^\d+$/.test(q)) {
    try {
      or.push({ telegramId: BigInt(q) });
    } catch {
      // Число длиннее bigint — ищем только по тексту.
    }
  }
  const found = await prisma.session.findMany({ where: { OR: or }, select: { telegramId: true } });
  return found.map((s) => s.telegramId);
}

function parentName(session: { firstName: string | null; username: string | null } | null): string {
  if (!session) return "без имени";
  return session.firstName ?? (session.username ? `@${session.username}` : "без имени");
}

// ── Воронка анкеты ──────────────────────────────────────────────────

export interface FunnelStep {
  question: number;
  label: string;
  reached: number;
  percent: number;
}

// Сколько прохождений дошло до каждого вопроса.
//
// Считаем по событиям quiz_question_shown: только у них есть номер
// вопроса и номер прохождения. По ответам в Answer так не получится —
// у брошенной анкеты ответа на последний показанный вопрос как раз и
// нет, а воронке важно именно «дошёл до вопроса».
//
// Прохождения до 20.10.2026 в воронку не попадают: у их событий нет
// номера прохождения, и смешивать их с новыми нельзя.
export async function loadFunnel(range: { gte?: Date; lte?: Date }): Promise<FunnelStep[]> {
  const events = await prisma.offerEvent.findMany({
    where: {
      type: "quiz_question_shown",
      attempt: { not: null },
      ...(range.gte || range.lte ? { createdAt: range } : {}),
    },
    select: { telegramId: true, attempt: true, questionNumber: true },
  });

  // Уникальные прохождения на каждый вопрос: повторный показ одного и
  // того же вопроса — это не второй дошедший.
  const byQuestion = new Map<number, Set<string>>();
  for (const e of events) {
    if (e.questionNumber === null) continue;
    const key = `${e.telegramId}:${e.attempt}`;
    const set = byQuestion.get(e.questionNumber) ?? new Set<string>();
    set.add(key);
    byQuestion.set(e.questionNumber, set);
  }

  // Порядок берём из самой анкеты: по номеру его не угадать, вопрос 4.5
  // условный и стоит между четвёртым и пятым.
  const order = [...QUESTIONS].sort((a, b) => a.number - b.number);
  const started = byQuestion.get(order[0]?.number ?? 1)?.size ?? 0;

  return order.map((q) => {
    const reached = byQuestion.get(q.number)?.size ?? 0;
    const text = (q.shortLabel ?? q.text).replace(/\s+/g, " ").trim();
    return {
      question: q.number,
      label: text.length > 60 ? `${text.slice(0, 59)}…` : text,
      reached,
      percent: started ? Math.round((reached / started) * 100) : 0,
    };
  });
}

// ── Экран 3. Прохождения ────────────────────────────────────────────

export interface AttemptRow {
  telegramId: string;
  parent: string;
  attemptNumber: number;
  babyAge: string | null;
  startedAt: Date;
  completedAt: Date | null;
  lastStep: number | null;
  view: string;
  version: string;
}

export interface AttemptsFilters {
  view: string;
  step: string;
  repeated: boolean;
}

export function parseAttemptsFilters(query: Record<string, unknown>): AttemptsFilters {
  const str = (k: string) => (typeof query[k] === "string" ? (query[k] as string).trim() : "");
  return { view: str("view"), step: str("step"), repeated: query.repeated === "1" };
}

export async function loadAttempts(query: TableQuery, filters: AttemptsFilters) {
  const users = await matchingUsers(query.q);
  const range = dateRange(query);

  const rows0 = await prisma.questionnaireAttempt.findMany({
    where: {
      ...(users ? { telegramId: { in: users } } : {}),
      ...(range.gte || range.lte ? { startedAt: range } : {}),
      ...(filters.repeated ? { attemptNumber: { gt: 1 } } : {}),
    },
    include: { session: { select: { firstName: true, username: true } } },
  });

  // Возраст малыша — первый ответ того же прохождения.
  const ages = await prisma.answer.findMany({
    where: { questionNumber: 1 },
    select: { telegramId: true, attempt: true, answerText: true },
  });
  const ageKey = new Map(ages.map((a) => [`${a.telegramId}:${a.attempt}`, a.answerText]));

  let rows: AttemptRow[] = rows0.map((a) => ({
    telegramId: String(a.telegramId),
    parent: parentName(a.session),
    attemptNumber: a.attemptNumber,
    babyAge: ageKey.get(`${a.telegramId}:${a.attemptNumber}`) ?? null,
    startedAt: a.startedAt,
    completedAt: a.completedAt,
    lastStep: a.lastStep,
    // Заброшенность считается, а не хранится: см. src/attempts.ts.
    view: attemptView(a),
    version: a.questionnaireVersion,
  }));

  if (filters.view) rows = rows.filter((r) => r.view === filters.view);
  if (filters.step) rows = rows.filter((r) => String(r.lastStep ?? "") === filters.step);

  const sorted = sortRows(rows, query, {
    started: (r) => r.startedAt.getTime(),
    parent: (r) => r.parent,
    attempt: (r) => r.attemptNumber,
    step: (r) => r.lastStep,
    completed: (r) => r.completedAt?.getTime() ?? null,
  });

  // Шаги для выпадающего фильтра: только те, на которых кто-то реально
  // останавливался.
  const steps = [...new Set(rows.map((r) => r.lastStep).filter((v): v is number => v !== null))]
    .sort((a, b) => a - b)
    .map(String);

  return { ...paginate(sorted, query.page), all: sorted, steps };
}

// ── Экран 4. Согласия ───────────────────────────────────────────────

export interface ConsentLogRow {
  telegramId: string;
  parent: string;
  type: string;
  action: string;
  version: string | null;
  source: string;
  createdAt: Date;
}

export interface ConsentFilters {
  type: string;
  action: string;
  version: string;
}

export function parseConsentFilters(query: Record<string, unknown>): ConsentFilters {
  const str = (k: string) => (typeof query[k] === "string" ? (query[k] as string).trim() : "");
  return { type: str("type"), action: str("action"), version: str("version") };
}

export async function loadConsentLog(query: TableQuery, filters: ConsentFilters) {
  const users = await matchingUsers(query.q);
  const range = dateRange(query);

  const [records, documents, sessions] = await Promise.all([
    prisma.consentRecord.findMany({
      where: {
        ...(users ? { telegramId: { in: users } } : {}),
        ...(range.gte || range.lte ? { createdAt: range } : {}),
        ...(filters.type ? { type: filters.type as never } : {}),
        ...(filters.action ? { action: filters.action as never } : {}),
      },
    }),
    prisma.legalDocument.findMany(),
    prisma.session.findMany({ select: { telegramId: true, firstName: true, username: true } }),
  ]);

  const versionById = new Map(documents.map((d) => [d.id, d.version]));
  const sessionById = new Map(sessions.map((s) => [String(s.telegramId), s]));

  let rows: ConsentLogRow[] = records.map((r) => ({
    telegramId: String(r.telegramId),
    parent: parentName(sessionById.get(String(r.telegramId)) ?? null),
    type: r.type,
    action: r.action,
    version:
      r.documentIds.map((id) => versionById.get(id)).filter(Boolean).join(", ") || null,
    source: r.source,
    createdAt: r.createdAt,
  }));

  if (filters.version) rows = rows.filter((r) => (r.version ?? "") === filters.version);

  const sorted = sortRows(rows, query, {
    created: (r) => r.createdAt.getTime(),
    parent: (r) => r.parent,
    type: (r) => r.type,
    action: (r) => r.action,
  });

  const versions = [...new Set(documents.map((d) => d.version))].sort();
  return { ...paginate(sorted, query.page), all: sorted, versions };
}

// ── Экран 5. Бесплатные анализы ─────────────────────────────────────

export interface AnalysisRow {
  telegramId: string;
  parent: string;
  attempt: number;
  status: string;
  waiting: string;
  waitingMinutes: number;
  overdue: boolean;
  sentAt: Date | null;
  costUsd: number | null;
  rating: string | null;
}

export interface AnalysisFilters {
  status: string;
  overdue: boolean;
}

export function parseAnalysisFilters(query: Record<string, unknown>): AnalysisFilters {
  const str = (k: string) => (typeof query[k] === "string" ? (query[k] as string).trim() : "");
  return { status: str("status"), overdue: query.overdue === "1" };
}

export async function loadAnalyses(
  query: TableQuery,
  filters: AnalysisFilters,
  promiseHours: number
) {
  const users = await matchingUsers(query.q);
  const range = dateRange(query);

  const [recs, calls, feedback] = await Promise.all([
    prisma.recommendation.findMany({
      where: {
        ...(users ? { telegramId: { in: users } } : {}),
        ...(range.gte || range.lte ? { createdAt: range } : {}),
      },
      include: { session: { select: { firstName: true, username: true } } },
    }),
    // Стоимость API: таблица вызовов знает её по шагам, а не по разбору,
    // поэтому суммируем по человеку. Разделить по прохождениям нельзя —
    // в ApiCall есть только telegramId.
    prisma.apiCall.groupBy({ by: ["sessionId"], _sum: { costUsd: true } }),
    prisma.analysisFeedback.findMany({ select: { telegramId: true, rating: true } }),
  ]);

  const costByUser = new Map(calls.map((c) => [c.sessionId, c._sum.costUsd]));
  const ratingByUser = new Map(feedback.map((f) => [String(f.telegramId), f.rating]));

  let rows: AnalysisRow[] = recs.map((r) => {
    const from = r.waitStartedAt ?? r.createdAt;
    const minutes = Math.max(
      0,
      Math.floor(((r.sentAt ?? new Date()).getTime() - from.getTime()) / 60_000)
    );
    return {
      telegramId: String(r.telegramId),
      parent: parentName(r.session),
      attempt: r.attempt,
      status: analysisStatus(r),
      waiting: waitedText(from, r.sentAt),
      waitingMinutes: minutes,
      // Просрочено: обещание из конфига нарушено, причём не важно,
      // отправлен разбор или ещё ждёт.
      overdue: minutes > promiseHours * 60,
      sentAt: r.sentAt,
      costUsd: costByUser.get(String(r.telegramId)) ?? null,
      rating: ratingByUser.get(String(r.telegramId)) ?? null,
    };
  });

  if (filters.status) rows = rows.filter((r) => r.status === filters.status);
  if (filters.overdue) rows = rows.filter((r) => r.overdue);

  const sorted = sortRows(rows, query, {
    waiting: (r) => r.waitingMinutes,
    parent: (r) => r.parent,
    status: (r) => r.status,
    sent: (r) => r.sentAt?.getTime() ?? null,
    cost: (r) => r.costUsd,
  });

  return { ...paginate(sorted, query.page), all: sorted };
}

// ── Экран 6. Заказы ─────────────────────────────────────────────────

export interface OrderTableRow {
  id: number;
  telegramId: string;
  parent: string;
  product: string;
  priceRub: number;
  payStatus: string;
  paidAt: Date | null;
  pdfStatus: string;
  waiting: string;
  waitingMinutes: number;
  analysisSent: boolean;
  receiptStatus: string;
  receiptUrl: string | null;
  refundedAt: Date | null;
  createdAt: Date;
  // Что родитель ответил через неделю после плана. В перечне колонок
  // ТЗ этого нет, но в прежнем списке заказов колонка была, и убирать
  // работающее незачем.
  pdfResult: string | null;
}

export interface OrderFilters {
  product: string;
  pay: string;
  pdf: string;
  receipt: string;
}

export function parseOrderFilters(query: Record<string, unknown>): OrderFilters {
  const str = (k: string) => (typeof query[k] === "string" ? (query[k] as string).trim() : "");
  return { product: str("product"), pay: str("pay"), pdf: str("pdf"), receipt: str("receipt") };
}

export async function loadOrdersTable(query: TableQuery, filters: OrderFilters) {
  const users = await matchingUsers(query.q);
  const range = dateRange(query);

  const [orders, recs, feedback] = await Promise.all([
    prisma.order.findMany({
      where: {
        ...(users ? { telegramId: { in: users } } : {}),
        ...(range.gte || range.lte ? { createdAt: range } : {}),
        ...(filters.product ? { product: filters.product as never } : {}),
        ...(filters.receipt ? { receiptStatus: filters.receipt as never } : {}),
      },
      include: {
        draft: { select: { approvedAt: true } },
        session: { select: { firstName: true, username: true } },
      },
    }),
    // Отправлен ли бесплатный разбор того же прохождения: по ТЗ это
    // колонка в таблице заказов.
    prisma.recommendation.findMany({ select: { telegramId: true, attempt: true, status: true } }),
    prisma.pdfFeedback.findMany({ select: { orderId: true, result: true } }),
  ]);

  const analysisSent = new Set(
    recs.filter((r) => r.status === "sent").map((r) => `${r.telegramId}:${r.attempt}`)
  );
  const resultByOrder = new Map(feedback.map((f) => [f.orderId, f.result]));

  let rows: OrderTableRow[] = orders.map((o) => {
    const from = o.paidAt ?? o.createdAt;
    const minutes = Math.max(
      0,
      Math.floor(((o.sentAt ?? new Date()).getTime() - from.getTime()) / 60_000)
    );
    return {
      id: o.id,
      telegramId: String(o.telegramId),
      parent: parentName(o.session),
      product: o.product,
      priceRub: o.priceRub,
      payStatus: o.refundedAt ? "возврат" : o.paidAt ? "оплачен" : "не оплачен",
      paidAt: o.paidAt,
      pdfStatus: pdfStatus(o),
      waiting: waitedText(from, o.sentAt),
      waitingMinutes: minutes,
      analysisSent: analysisSent.has(`${o.telegramId}:${o.attempt}`),
      receiptStatus: o.receiptStatus,
      receiptUrl: o.receiptUrl,
      refundedAt: o.refundedAt,
      createdAt: o.createdAt,
      pdfResult: resultByOrder.get(o.id) ?? null,
    };
  });

  if (filters.pay) rows = rows.filter((r) => r.payStatus === filters.pay);
  if (filters.pdf) rows = rows.filter((r) => r.pdfStatus === filters.pdf);

  const sorted = sortRows(rows, query, {
    created: (r) => r.createdAt.getTime(),
    parent: (r) => r.parent,
    price: (r) => r.priceRub,
    paid: (r) => r.paidAt?.getTime() ?? null,
    waiting: (r) => r.waitingMinutes,
  });

  // Итоги за период по ТЗ: оплачено, возвраты, чеков не выбито, к
  // выплате Софии. Последнее — по консультациям того же периода.
  const consultsInRange = await prisma.consultRequest.findMany({
    where: {
      doneAt: { not: null },
      payoutPaidAt: null,
      ...(range.gte || range.lte ? { createdAt: range } : {}),
    },
    select: { priceRub: true },
  });

  const totals = {
    paidRub: rows.filter((r) => r.paidAt && !r.refundedAt).reduce((s, r) => s + r.priceRub, 0),
    paidCount: rows.filter((r) => r.paidAt && !r.refundedAt).length,
    refundedRub: rows.filter((r) => r.refundedAt).reduce((s, r) => s + r.priceRub, 0),
    refundedCount: rows.filter((r) => r.refundedAt).length,
    receiptsPending: rows.filter((r) => r.receiptStatus === "PENDING").length,
    payoutPendingCount: consultsInRange.length,
  };

  return { ...paginate(sorted, query.page), all: sorted, totals };
}

// ── Экран 7. Консультации ───────────────────────────────────────────

export interface ConsultTableRow {
  id: number;
  telegramId: string;
  parent: string;
  // Как с родителем связываться: @username, телефон или прямая
  // пометка, что писать будет он сам.
  contact: string;
  status: string;
  lostReason: string | null;
  source: string;
  priceRub: number;
  request: string | null;
  createdAt: Date;
  paidAt: Date | null;
  contactedAt: Date | null;
  diaryReceived: boolean;
  doneAt: Date | null;
  payoutRub: number | null;
  payoutPaidAt: Date | null;
  // Сколько часов заявка ждёт следующего действия команды. null —
  // ждать нечего: заявка уже оплачена, закрыта или потеряна.
  waitingHours: number | null;
  waitingOverdue: boolean;
}

export interface ConsultFilters {
  status: string;
  source: string;
  notContacted: boolean;
  notPaidOut: boolean;
}

export function parseConsultFilters(query: Record<string, unknown>): ConsultFilters {
  const str = (k: string) => (typeof query[k] === "string" ? (query[k] as string).trim() : "");
  return {
    status: str("status"),
    source: str("source"),
    notContacted: query.notContacted === "1",
    notPaidOut: query.notPaidOut === "1",
  };
}

// Сколько заявка ждёт и не пора ли вмешаться. Пороги из ТЗ: новая
// заявка ждёт первого сообщения три часа, написанная — двое суток до
// оплаты. Напоминаний по ним бот не шлёт, но в списке это видно.
const NEW_OVERDUE_H = 3;
const CONTACTED_OVERDUE_H = 48;

function waiting(status: string, createdAt: Date, contactedAt: Date | null) {
  const hours = (from: Date) => Math.floor((Date.now() - from.getTime()) / 3_600_000);
  if (status === "NEW") {
    const h = hours(createdAt);
    return { waitingHours: h, waitingOverdue: h > NEW_OVERDUE_H };
  }
  if (status === "CONTACTED" && contactedAt) {
    const h = hours(contactedAt);
    return { waitingHours: h, waitingOverdue: h > CONTACTED_OVERDUE_H };
  }
  return { waitingHours: null, waitingOverdue: false };
}

// Сколько заявок дошло до денег и на какую сумму. Считается по тем же
// фильтрам, что и список: иначе итог не совпадал бы с тем, что видно.
export interface ConsultTotals {
  paidCount: number;
  paidRub: number;
}

export async function loadConsultsTable(query: TableQuery, filters: ConsultFilters) {
  const users = await matchingUsers(query.q);
  const range = dateRange(query);

  const requests = await prisma.consultRequest.findMany({
    where: {
      ...(users ? { telegramId: { in: users } } : {}),
      ...(range.gte || range.lte ? { createdAt: range } : {}),
      ...(filters.status ? { status: filters.status as never } : {}),
      ...(filters.source ? { source: filters.source as never } : {}),
      ...(filters.notContacted ? { contactedAt: null } : {}),
      ...(filters.notPaidOut ? { payoutPaidAt: null } : {}),
    },
    include: { session: { select: { firstName: true, username: true } } },
  });

  const rows: ConsultTableRow[] = requests.map((c) => ({
    id: c.id,
    telegramId: String(c.telegramId),
    parent: parentName(c.session),
    contact: c.parentUsername
      ? `@${c.parentUsername}`
      : c.parentPhone ?? (c.firstContact === "PARENT" ? "напишет сам" : "—"),
    status: c.status,
    lostReason: c.lostReason,
    source: c.source,
    priceRub: c.priceRub,
    request: c.requestText,
    createdAt: c.createdAt,
    paidAt: c.paidAt,
    contactedAt: c.contactedAt,
    diaryReceived: c.diaryReceived,
    doneAt: c.doneAt,
    payoutRub: c.consultantPayoutRub,
    payoutPaidAt: c.payoutPaidAt,
    ...waiting(c.status, c.createdAt, c.contactedAt),
  }));

  const sorted = sortRows(rows, query, {
    created: (r) => r.createdAt.getTime(),
    parent: (r) => r.parent,
    status: (r) => r.status,
    price: (r) => r.priceRub,
    waiting: (r) => r.waitingHours,
    contacted: (r) => r.contactedAt?.getTime() ?? null,
    done: (r) => r.doneAt?.getTime() ?? null,
  });

  // Деньгами считаем всё, что дошло до оплаты: дальше статус меняется,
  // но заявка уже оплачена и из суммы выпадать не должна.
  const paid = rows.filter((r) => ["PAID", "CHAT_CREATED", "DONE"].includes(r.status));
  const totals: ConsultTotals = {
    paidCount: paid.length,
    paidRub: paid.reduce((sum, r) => sum + r.priceRub, 0),
  };

  return { ...paginate(sorted, query.page), all: sorted, totals };
}
