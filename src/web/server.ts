// Веб-админка: проверка и правка черновиков PDF перед отправкой.
//
// Живёт в том же процессе, что и бот: так страница заказа напрямую
// вызывает генерацию и шлёт уведомления через bot.api, без очередей и
// межпроцессного взаимодействия. Нагрузка — один человек, этого хватает.
//
// Если переменные админки не заданы, сервер всё равно поднимается, а
// админка отвечает 503 со списком недостающих. Иначе первый же деплой
// до того, как их прописали, уронил бы бота целиком.

import express, { NextFunction, Request, Response } from "express";
import { join } from "path";
import { PROJECT_ROOT } from "../prompts";
import type { Api } from "grammy";
import { prisma } from "../prisma";
import { env } from "../env";
import {
  approveAndSendPdf,
  buildPrepText,
  generateDraftForAdmin,
  runPdfGeneration,
  sendApprovedRecommendation,
} from "../engine";
import { renderPdf } from "../pdf/render";
import { PdfContent, ScheduleRow, ScheduleVariant } from "../paidPdf";
import { RelaxationGroup, isRelaxationMemoReady, readRelaxationMemo } from "../prompts";
import { renderOrderPage, renderPreview } from "./pages";
import { renderConsultPage } from "./consultPages";
import {
  ConsultStatusChange,
  buildConsultPackage,
  sendConsultPackage,
  setConsultStatus,
} from "../consult";
import type { LegalDocType } from "@prisma/client";
import { activeDocument, readLegalText } from "../legalDocs";
import { renderLegalPage } from "./legalPage";
import {
  ConsentCardData,
  ConsentSearchRow,
  MarketingRow,
  marketingCsv,
  renderConsentCard,
  renderConsentSearchPage,
  renderMarketingPage,
} from "./consentPages";
import { formatMoscow, getConsentState } from "../consents";
import {
  AnalysisFeedbackPageData,
  AnalysisFeedbackRow,
  PdfFeedbackPageData,
  PdfFeedbackRow,
  renderAnalysisFeedbackPage,
  renderPdfFeedbackPage,
} from "./feedbackPages";
import {
  SupportListData,
  SupportRow,
  SupportThreadData,
  mean,
  median,
  renderSupportListPage,
  renderSupportThreadPage,
} from "./supportPages";
import { authConfigured, checkCredentials, endSession, requireAuth, startSession } from "./auth";
import { renderAuthNotConfigured, renderLoginPage } from "./loginPage";
import { renderUserCard, renderUsersPage, usersCsv } from "./usersPages";
import {
  loadAllUserRows,
  buildQuestionnaireText,
  loadUserCard,
  loadUsersPage,
  logAdminAction,
  parseUsersQuery,
} from "./usersData";
import { TIMELINE_LABELS, TimelineKind } from "./timeline";
import { loadLog, parseLogFilters } from "./logData";
import { renderLogPage } from "./logPages";
import { renderAnalysisEditor, renderQueuePage } from "./queuePages";
import { analysisStatus, loadQueue, TASK_LABELS, TaskType } from "./queueData";
import { waitedText } from "./usersData";
import { currentRecommendation } from "../attempt";
import {
  buildParams,
  csvOf,
  dateRange,
  parseTableQuery,
  type ChromeData,
} from "./tableChrome";
import {
  loadAnalyses,
  loadAttempts,
  loadConsentLog,
  loadConsultsTable,
  loadFunnel,
  loadOrdersTable,
  parseAnalysisFilters,
  parseAttemptsFilters,
  parseConsentFilters,
  parseConsultFilters as parseConsultTableFilters,
  parseOrderFilters,
} from "./tablesData";
import {
  renderAnalysesPage,
  renderAttemptsPage,
  renderConsentLogPage,
  renderConsultsTablePage,
  renderOrdersTablePage,
} from "./tablesPages";

const TIMELINE_KINDS = Object.keys(TIMELINE_LABELS) as readonly TimelineKind[];

// Кто сейчас в админке. Пока админ один, и его telegram id берётся из
// переменной окружения: таблицы администраторов нет, логин — из входа.
function adminId(_req: Request): bigint {
  return BigInt(env.ADMIN_TELEGRAM_ID);
}

// ── Авторизация ─────────────────────────────────────────────────────
//
// Basic auth заменён входом по логину с сессией: см. src/web/auth.ts,
// там же причины. Чего не хватает для входа — показываем прямо, чтобы
// не гадать по пустой странице.
function notConfiguredPage(): string {
  const missing = [
    !env.ADMIN_LOGIN && "ADMIN_LOGIN",
    !env.ADMIN_PASSWORD_HASH && "ADMIN_PASSWORD_HASH",
    !env.ADMIN_SESSION_SECRET && "ADMIN_SESSION_SECRET",
  ].filter((name): name is string => Boolean(name));
  return renderAuthNotConfigured(missing);
}

// ── Чтение черновика ────────────────────────────────────────────────

// Показываем и правим editedContent, если правки уже были, иначе
// исходник модели. aiContent при сохранении не трогается никогда.
function currentContent(draft: { aiContent: unknown; editedContent: unknown }): PdfContent {
  return (draft.editedContent ?? draft.aiContent) as PdfContent;
}

async function loadOrder(id: number) {
  const order = await prisma.order.findUnique({ where: { id }, include: { draft: true } });
  if (!order?.draft) return null;

  const recommendation = await prisma.recommendation.findUnique({
    where: { telegramId_attempt: { telegramId: order.telegramId, attempt: order.attempt } },
  });

  return { order, draft: order.draft, recommendation };
}

// ── Разбор формы редактора ──────────────────────────────────────────

// Поля строк режима называются v<вариант>_<поле>_<строка>. Индекс строки
// не обязан идти подряд: удалённые строки оставляют дыры, а добавленные
// получают индекс по времени. Поэтому группируем по индексу, а порядок
// восстанавливаем по тому, в каком виде поля пришли в теле запроса.
function parseScheduleVariants(body: Record<string, unknown>): ScheduleVariant[] {
  const count = Number(body.variantCount ?? 0);
  const variants: ScheduleVariant[] = [];

  for (let vi = 0; vi < count; vi++) {
    const rowsByIndex = new Map<string, Partial<ScheduleRow>>();
    const order: string[] = [];

    for (const key of Object.keys(body)) {
      const match = key.match(new RegExp(`^v${vi}_(time|event|duration)_(.+)$`));
      if (!match) continue;

      const [, field, index] = match;
      if (!rowsByIndex.has(index)) {
        rowsByIndex.set(index, {});
        order.push(index);
      }
      rowsByIndex.get(index)![field as keyof ScheduleRow] = String(body[key] ?? "").trim();
    }

    const rows = order
      .map((index) => rowsByIndex.get(index)!)
      // Полностью пустую строку выбрасываем: её добавили и не заполнили.
      .filter((row) => row.time || row.event)
      .map((row) => ({ time: row.time ?? "", event: row.event ?? "", duration: row.duration ?? "" }));

    variants.push({ title: String(body[`v${vi}_title`] ?? "").trim() || "Режим дня", rows });
  }

  return variants;
}

// ── Данные для страниц согласий ─────────────────────────────────────

// Короткая подпись состояния для списков.
function shortStatus(action: string | null): string {
  if (action === "GRANTED") return "дано";
  if (action === "REVOKED") return "отозвано";
  if (action === "DECLINED") return "отказ";
  return "нет записей";
}

// Поиск по telegram id или username. Числовой запрос ищем по id,
// остальное — по username, без учёта регистра и ведущей «@».
async function searchUsers(query: string): Promise<ConsentSearchRow[]> {
  const username = query.replace(/^@/, "");
  const asId = /^\d+$/.test(query) ? BigInt(query) : null;

  const sessions = await prisma.session.findMany({
    where: asId
      ? { telegramId: asId }
      : { firstName: { contains: username, mode: "insensitive" } },
    take: 50,
    orderBy: { updatedAt: "desc" },
  });

  // username лежит не в сессии, а в заявках на консультацию: там он
  // сохраняется в момент записи. Поэтому ищем и по ним.
  const byUsername = asId
    ? []
    : await prisma.consultRequest.findMany({
        where: { parentUsername: { equals: username, mode: "insensitive" } },
        distinct: ["telegramId"],
        take: 50,
      });

  const ids = new Set<string>();
  for (const row of [...sessions, ...byUsername]) ids.add(String(row.telegramId));

  const rows: ConsentSearchRow[] = [];
  for (const id of ids) {
    const telegramId = BigInt(id);
    const [session, request, state] = await Promise.all([
      prisma.session.findUnique({ where: { telegramId } }),
      prisma.consultRequest.findFirst({
        where: { telegramId, parentUsername: { not: null } },
        orderBy: { createdAt: "desc" },
      }),
      getConsentState(telegramId),
    ]);

    const dates = Object.values(state)
      .map((s) => s.at)
      .filter((d): d is Date => d !== null);

    rows.push({
      telegramId: id,
      username: request?.parentUsername ?? null,
      firstName: session?.firstName ?? null,
      pdStatus: shortStatus(state.PD_PROCESSING.action),
      marketingStatus: shortStatus(state.MARKETING.action),
      lastActionAt: dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null,
    });
  }

  return rows;
}

async function loadConsentCard(rawId: string): Promise<ConsentCardData | null> {
  let telegramId: bigint;
  try {
    telegramId = BigInt(rawId);
  } catch {
    return null;
  }

  const [session, request, records, documents, support, analysisFeedback, recommendations] =
    await Promise.all([
    prisma.session.findUnique({ where: { telegramId } }),
    prisma.consultRequest.findFirst({
      where: { telegramId, parentUsername: { not: null } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.consentRecord.findMany({ where: { telegramId }, orderBy: { createdAt: "asc" } }),
    prisma.legalDocument.findMany(),
    prisma.supportThread.findUnique({ where: { telegramId } }),
    prisma.analysisFeedback.findUnique({ where: { telegramId } }),
    // Все прохождения анкеты: по ним видно, начинал ли человек заново
    // и чем кончился каждый разбор.
    prisma.recommendation.findMany({ where: { telegramId }, orderBy: { attempt: "asc" } }),
  ]);

  // Карточку показываем и тому, у кого сессии уже нет: журнал её
  // переживает, и именно это чаще всего и нужно проверяющей стороне.
  if (!session && !records.length) return null;

  const byId = new Map(documents.map((d) => [d.id, d]));
  const state = await getConsentState(telegramId);

  return {
    telegramId: String(telegramId),
    username: request?.parentUsername ?? null,
    firstName: session?.firstName ?? null,
    supportThreadId: support?.id ?? null,
    attempts: recommendations.map((r) => ({
      attempt: r.attempt,
      status: r.status,
      cancelReason: r.cancelReason,
      sentAt: r.sentAt,
      createdAt: r.createdAt,
    })),
    analysisFeedback: analysisFeedback
      ? {
          rating: analysisFeedback.rating,
          comment: analysisFeedback.comment,
          skippedComment: analysisFeedback.skippedComment,
          askedAt: analysisFeedback.askedAt,
          answeredAt: analysisFeedback.answeredAt,
          skipReason: analysisFeedback.skipReason,
        }
      : null,
    current: Object.entries(state).map(([type, status]) => ({
      type,
      action: status.action,
      at: status.at,
      version:
        status.record?.documentIds.map((id) => byId.get(id)?.version).filter(Boolean).join(", ") ||
        null,
    })),
    history: records.map((record) => ({
      id: record.id,
      type: record.type,
      action: record.action,
      source: record.source,
      buttonText: record.buttonText,
      messageText: record.messageText,
      createdAt: record.createdAt,
      documents: record.documentIds
        .map((id) => byId.get(id))
        .filter((d): d is NonNullable<typeof d> => Boolean(d))
        .map((d) => ({ id: d.id, type: d.type, version: d.version, url: d.url })),
      relatedOrderId: record.relatedOrderId,
      relatedConsultRequestId: record.relatedConsultRequestId,
    })),
  };
}

// Кто сейчас может попадать в рассылки: последняя запись типа MARKETING
// у человека — GRANTED. Считаем по журналу, а не по флажку, потому что
// флажка нет: состояние всегда выводится из записей.
async function marketingAudience(): Promise<MarketingRow[]> {
  const records = await prisma.consentRecord.findMany({
    where: { type: "MARKETING" },
    orderBy: { createdAt: "desc" },
  });
  const documents = new Map((await prisma.legalDocument.findMany()).map((d) => [d.id, d]));

  const seen = new Set<string>();
  const rows: MarketingRow[] = [];

  for (const record of records) {
    const key = String(record.telegramId);
    if (seen.has(key)) continue;
    seen.add(key);
    if (record.action !== "GRANTED") continue;

    const request = await prisma.consultRequest.findFirst({
      where: { telegramId: record.telegramId, parentUsername: { not: null } },
      orderBy: { createdAt: "desc" },
    });

    rows.push({
      telegramId: key,
      username: request?.parentUsername ?? null,
      grantedAt: record.createdAt,
      version:
        record.documentIds.map((id) => documents.get(id)?.version).filter(Boolean).join(", ") ||
        null,
    });
  }

  return rows;
}

// ── Данные для страниц обратной связи ───────────────────────────────

async function loadAnalysisFeedback(days: number): Promise<AnalysisFeedbackPageData> {
  const since = new Date(Date.now() - days * 24 * 3_600_000);

  const [asked, answered, rows] = await Promise.all([
    prisma.analysisFeedback.count({ where: { askedAt: { gte: since } } }),
    prisma.analysisFeedback.count({ where: { answeredAt: { gte: since } } }),
    // Показываем только тревожные ответы: «Да, очень похоже» читать
    // построчно незачем, его видно в сводке.
    prisma.analysisFeedback.findMany({
      where: { answeredAt: { gte: since }, rating: { in: ["PARTLY", "NO"] } },
      orderBy: { answeredAt: "desc" },
      take: 200,
    }),
  ]);

  const list: AnalysisFeedbackRow[] = [];
  for (const row of rows) {
    const session = await prisma.session.findUnique({ where: { telegramId: row.telegramId } });
    const links: { label: string; url: string }[] = [];
    const user = consentUrl(row.telegramId);
    if (user) links.push({ label: "пользователь", url: user });

    list.push({
      telegramId: String(row.telegramId),
      name: session?.firstName ?? null,
      rating: row.rating!,
      comment: row.comment,
      skippedComment: row.skippedComment,
      answeredAt: row.answeredAt!,
      links,
    });
  }

  return { rows: list, days, asked, answered };
}

async function loadPdfFeedback(days: number, filter: string): Promise<PdfFeedbackPageData> {
  const since = new Date(Date.now() - days * 24 * 3_600_000);

  const [asked, answered, rows] = await Promise.all([
    prisma.pdfFeedback.count({ where: { askedAt: { gte: since } } }),
    prisma.pdfFeedback.count({ where: { answeredAt: { gte: since } } }),
    prisma.pdfFeedback.findMany({
      where: {
        answeredAt: { gte: since },
        ...(filter ? { result: filter as never } : { result: { not: null } }),
      },
      orderBy: { answeredAt: "desc" },
      take: 200,
    }),
  ]);

  const list: PdfFeedbackRow[] = [];
  for (const row of rows) {
    const [session, draft] = await Promise.all([
      prisma.session.findUnique({ where: { telegramId: row.telegramId } }),
      prisma.pdfDraft.findUnique({ where: { orderId: row.orderId } }),
    ]);

    list.push({
      orderId: row.orderId,
      telegramId: String(row.telegramId),
      name: session?.firstName ?? null,
      result: row.result!,
      comment: row.comment,
      skippedComment: row.skippedComment,
      answeredAt: row.answeredAt!,
      hasEdits: draft?.editedContent != null,
      orderUrl: orderUrl(row.orderId),
    });
  }

  return { rows: list, days, filter, asked, answered };
}

// ── Данные для страниц поддержки ────────────────────────────────────

// Время до первого ответа: от первого сообщения родителя до первого
// ответа поддержки. Заметки не считаются ответом — родитель их не видел.
function firstReplyMs(messages: { direction: string; createdAt: Date }[]): number | null {
  const firstIn = messages.find((m) => m.direction === "IN");
  if (!firstIn) return null;
  const firstOut = messages.find(
    (m) => m.direction === "OUT" && m.createdAt >= firstIn.createdAt
  );
  return firstOut ? firstOut.createdAt.getTime() - firstIn.createdAt.getTime() : null;
}

// Имя берём из сессии основного бота, username — из заявки на
// консультацию: больше его взять неоткуда, сессия его не хранит.
async function supportIdentity(telegramId: bigint) {
  const [session, request] = await Promise.all([
    prisma.session.findUnique({ where: { telegramId } }),
    prisma.consultRequest.findFirst({
      where: { telegramId, parentUsername: { not: null } },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  return { name: session?.firstName ?? null, username: request?.parentUsername ?? null };
}

async function loadSupportList(days: number): Promise<SupportListData> {
  const since = new Date(Date.now() - days * 24 * 3_600_000);

  const threads = await prisma.supportThread.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  const rows: SupportRow[] = [];
  const replyTimes: number[] = [];
  let inPeriod = 0;
  let answeredInPeriod = 0;

  for (const thread of threads) {
    const [identity, messages] = await Promise.all([
      supportIdentity(thread.telegramId),
      prisma.supportMessage.findMany({
        where: { threadId: thread.id },
        orderBy: { createdAt: "asc" },
        select: { direction: true, createdAt: true },
      }),
    ]);

    const lastMessageAt =
      [thread.lastUserMessageAt, thread.lastSupportMessageAt]
        .filter((d): d is Date => d !== null)
        .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

    rows.push({
      id: thread.id,
      telegramId: String(thread.telegramId),
      name: identity.name,
      username: identity.username,
      status: thread.status,
      lastMessageAt,
      waitingMs:
        thread.status === "WAITING" && thread.lastUserMessageAt
          ? Date.now() - thread.lastUserMessageAt.getTime()
          : null,
    });

    if (thread.createdAt >= since) {
      inPeriod++;
      const reply = firstReplyMs(messages);
      if (reply !== null) {
        answeredInPeriod++;
        replyTimes.push(reply);
      }
    }
  }

  // Сначала те, кто ждёт: именно они требуют действия. Внутри групп —
  // по свежести последнего сообщения.
  const order = { WAITING: 0, ANSWERED: 1, CLOSED: 2 } as Record<string, number>;
  rows.sort((a, b) => {
    const byStatus = (order[a.status] ?? 9) - (order[b.status] ?? 9);
    if (byStatus) return byStatus;
    return (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0);
  });

  return {
    rows,
    days,
    inPeriod,
    answeredInPeriod,
    firstReplyMean: mean(replyTimes),
    firstReplyMedian: median(replyTimes),
  };
}

async function loadSupportThread(id: number): Promise<SupportThreadData | null> {
  const thread = await prisma.supportThread.findUnique({ where: { id } });
  if (!thread) return null;

  const [identity, messages, order, consult] = await Promise.all([
    supportIdentity(thread.telegramId),
    prisma.supportMessage.findMany({
      where: { threadId: thread.id },
      orderBy: { createdAt: "asc" },
    }),
    prisma.order.findFirst({
      where: { telegramId: thread.telegramId },
      orderBy: { createdAt: "desc" },
    }),
    prisma.consultRequest.findFirst({
      where: { telegramId: thread.telegramId },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  // Показываем только ссылки на существующие страницы: битая ссылка
  // хуже её отсутствия.
  const links: { label: string; url: string }[] = [];
  const user = consentUrl(thread.telegramId);
  if (user) links.push({ label: "пользователь и согласия", url: user });
  if (order) {
    const url = orderUrl(order.id);
    if (url) links.push({ label: `заказ #${order.id}`, url });
  }
  if (consult) {
    const url = consultUrl(consult.id);
    if (url) links.push({ label: `заявка #${consult.id}`, url });
  }

  return {
    id: thread.id,
    telegramId: String(thread.telegramId),
    name: identity.name,
    username: identity.username,
    status: thread.status,
    source: thread.source,
    createdAt: thread.createdAt,
    closedAt: thread.closedAt,
    firstReplyMs: firstReplyMs(messages),
    messages: messages.map((m) => ({
      id: m.id,
      direction: m.direction,
      type: m.type,
      text: m.text,
      fileId: m.fileId,
      deliveryError: m.deliveryError,
      createdAt: m.createdAt,
    })),
    links,
  };
}

// ── Сервер ──────────────────────────────────────────────────────────

export function startAdminServer(api: Api) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));

  // ── Вход ──────────────────────────────────────────────────────────
  //
  // Страница входа — единственная под /admin, доступная без сессии.
  // Регистрируется до проверки, иначе войти было бы некуда.
  app.get("/admin/login", (req, res) => {
    if (!authConfigured()) return res.status(503).type("html").send(notConfiguredPage());
    const back = typeof req.query.next === "string" && req.query.next.startsWith("/")
      ? req.query.next
      : "/admin";
    res.type("html").send(renderLoginPage({ failed: req.query.failed === "1", next: back }));
  });

  app.post("/admin/login", (req, res) => {
    if (!authConfigured()) return res.status(503).type("html").send(notConfiguredPage());

    const login = String(req.body.login ?? "");
    const password = String(req.body.password ?? "");
    // Редирект только на свой путь: открытый редирект из параметра —
    // классическая дыра, через неё уводят на поддельную форму входа.
    const raw = String(req.body.next ?? "/admin");
    const back = raw.startsWith("/") ? raw : "/admin";

    if (!checkCredentials(login, password)) {
      console.warn(`Неудачный вход в админку с логином «${login}».`);
      return res.redirect(`/admin/login?failed=1&next=${encodeURIComponent(back)}`);
    }

    startSession(res, login);
    res.redirect(back);
  });

  app.post("/admin/logout", (_req, res) => {
    endSession(res);
    res.redirect("/admin/login");
  });

  // Сервер поднимаем всегда, даже когда вход не настроен. Если его не
  // поднять, хостингу некуда маршрутизировать запрос, и в браузере
  // вместо объяснения получается «Application failed to respond», по
  // которому не понять, бот упал, порт не тот или дело в переменной.
  // Поэтому без настроек админка отвечает честным 503 с объяснением.
  app.use("/admin", (req, res, next) => {
    if (!authConfigured()) return res.status(503).type("html").send(notConfiguredPage());
    return requireAuth(req, res, next);
  });

  // Картинки, на которые ссылаются сообщения бота: фото Софии в
  // карточке консультации показывается превью ссылки, а значит его
  // забирает сам Telegram — без куки и без пароля. Авторизация висит
  // только на /admin, так что сюда она не достаёт.
  //
  // maxAge большой намеренно: адрес версионируется через ?v=, и при
  // замене фото меняется он, а не содержимое по старому адресу.
  app.use(
    "/static",
    // fallthrough по умолчанию: запрос несуществующего файла уходит
    // дальше и заканчивается обычной 404, а не стеком в логе.
    express.static(join(PROJECT_ROOT, "public/static"), { maxAge: "30d" })
  );

  // Юридические документы. Ссылки в боте ведут на сайт, а эти страницы
  // остаются копией для проверяющего: они показывают текст активной
  // версии из legal/ — тот самый, на который ссылается запись журнала.
  // Открыты без пароля: по этим адресам ходили из прежних сообщений, и
  // они лежат в журнале.
  const LEGAL_PAGES: Record<string, { type: LegalDocType; title: string }> = {
    "/privacy": { type: "PRIVACY_POLICY", title: "Политика обработки персональных данных" },
    "/consent": { type: "PD_CONSENT", title: "Согласие на обработку персональных данных" },
    "/marketing-consent": {
      type: "MARKETING_CONSENT",
      title: "Согласие на получение рекламной рассылки",
    },
    "/offer": { type: "OFFER", title: "Публичная оферта" },
  };

  for (const [path, { type, title }] of Object.entries(LEGAL_PAGES)) {
    app.get(path, (_req, res) => {
      const document = activeDocument(type);
      res.send(renderLegalPage(title, document.version, readLegalText(type, document.version)));
    });
  }

  // Хостинг проверяет живость сервиса по корню — отвечаем без пароля.
  // Корень отвечает живым текстом, а не редиректом: по нему проверяют,
  // что процесс поднялся, в том числе снаружи без входа в админку.
  app.get("/", (_req, res) =>
    res.send("Дрёмиус-бот жив. Админка — /admin")
  );

  // ── Очередь «что горит» ───────────────────────────────────────────

  app.get("/admin", (_req, res) => res.redirect("/admin/queue"));

  app.get("/admin/queue", async (req, res) => {
    const type = typeof req.query.type === "string" ? req.query.type : "";
    const filter = (Object.keys(TASK_LABELS) as string[]).includes(type) ? (type as TaskType) : "";
    res.type("html").send(renderQueuePage(await loadQueue(filter)));
  });

  // ── Бесплатный разбор: черновик и отправка ────────────────────────
  //
  // До этого правка и отправка бесплатного разбора жили только в
  // командах бота (/draft, /send, /approve). В админке их не было
  // вовсе, хотя очередь ведёт именно сюда.

  async function loadAnalysis(telegramId: bigint) {
    const rec = await currentRecommendation(telegramId);
    if (!rec) return null;
    const [session, age] = await Promise.all([
      prisma.session.findUnique({ where: { telegramId } }),
      prisma.answer.findFirst({
        where: { telegramId, attempt: rec.attempt, questionNumber: 1 },
      }),
    ]);
    return { rec, session, age: age?.answerText ?? null };
  }

  app.get("/admin/analysis/:telegramId", async (req, res) => {
    let telegramId: bigint;
    try {
      telegramId = BigInt(req.params.telegramId);
    } catch {
      return res.status(404).send("Такого пользователя нет.");
    }

    const loaded = await loadAnalysis(telegramId);
    if (!loaded?.rec) return res.status(404).send("Разбора для этого родителя нет.");
    const { rec, session, age } = loaded;

    const notices: Record<string, string> = {
      saved: "Правки сохранены. Родителю пока ничего не ушло.",
      sent: "Разбор отправлен родителю.",
      regen: "Перегенерация запущена, черновик обновится через минуту-две.",
    };
    const noticeKey = Object.keys(notices).find((k) => req.query[k] === "1");

    res.type("html").send(
      renderAnalysisEditor({
        telegramId: String(telegramId),
        parentName: session?.firstName ?? "без имени",
        attempt: rec.attempt,
        status: analysisStatus(rec),
        waiting: waitedText(rec.waitStartedAt ?? rec.createdAt, rec.sentAt),
        createdAt: rec.createdAt,
        sentAt: rec.sentAt,
        babyAge: age,
        aiMessage1: rec.aiMessage1,
        aiMessage2: rec.aiMessage2,
        message1: rec.message1 ?? "",
        message2: rec.message2 ?? "",
        analysis: rec.analysis,
        deliveryError: rec.deliveryError,
        edited:
          (rec.aiMessage1 !== null && rec.aiMessage1 !== rec.message1) ||
          (rec.aiMessage2 !== null && rec.aiMessage2 !== rec.message2),
        notice: noticeKey ? notices[noticeKey] : null,
        error: typeof req.query.error === "string" ? req.query.error : null,
      })
    );
  });

  app.post("/admin/analysis/:telegramId/save", async (req, res) => {
    const telegramId = BigInt(req.params.telegramId);
    const rec = await currentRecommendation(telegramId);
    if (!rec) return res.status(404).send("Разбора нет.");
    // Отправленный разбор не правим: родитель его уже прочитал.
    if (rec.sentAt) return res.redirect(`/admin/analysis/${telegramId}?error=Разбор+уже+отправлен`);

    const message1 = String(req.body.message1 ?? "").trim();
    const message2 = String(req.body.message2 ?? "").trim();
    // Запоминаем до обновления: полагаться на то, что объект из базы
    // останется неизменным после update, не стоит.
    const was = { message1: rec.message1, message2: rec.message2 };

    await prisma.recommendation.update({
      where: { id: rec.id },
      data: { message1, message2 },
    });
    await logAdminAction(adminId(req), "analysis_draft_edited", "recommendation", String(rec.id), {
      message1: { from: was.message1, to: message1 },
      message2: { from: was.message2, to: message2 },
    });

    res.redirect(`/admin/analysis/${telegramId}?saved=1`);
  });

  app.post("/admin/analysis/:telegramId/approve", async (req, res) => {
    const telegramId = BigInt(req.params.telegramId);
    const session = await prisma.session.findUnique({ where: { telegramId } });
    if (!session) return res.status(404).send("Такого пользователя нет.");

    const rec = await currentRecommendation(telegramId);
    try {
      // Идемпотентность внутри sendApprovedRecommendation: повторный
      // клик упрётся в «уже отправлен» и второго сообщения не будет.
      await sendApprovedRecommendation(api, telegramId, session.chatId);
      await logAdminAction(adminId(req), "analysis_sent", "recommendation", String(rec?.id ?? ""), {
        result: "ok",
      });
      res.redirect(`/admin/analysis/${telegramId}?sent=1`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await logAdminAction(adminId(req), "analysis_send_failed", "recommendation", String(rec?.id ?? ""), {
        result: reason,
      });
      res.redirect(`/admin/analysis/${telegramId}?error=${encodeURIComponent(reason)}`);
    }
  });

  // Повтор отправки — тот же путь, что утверждение: разбор не
  // помечен отправленным, значит отправлять можно снова.
  app.post("/admin/analysis/:telegramId/retry", async (req, res) => {
    const telegramId = BigInt(req.params.telegramId);
    const session = await prisma.session.findUnique({ where: { telegramId } });
    if (!session) return res.status(404).send("Такого пользователя нет.");

    const rec = await currentRecommendation(telegramId);
    try {
      await sendApprovedRecommendation(api, telegramId, session.chatId);
      await logAdminAction(adminId(req), "analysis_resent", "recommendation", String(rec?.id ?? ""), {
        result: "ok",
      });
      res.redirect(`/admin/analysis/${telegramId}?sent=1`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await logAdminAction(adminId(req), "analysis_resend_failed", "recommendation", String(rec?.id ?? ""), {
        result: reason,
      });
      res.redirect(`/admin/analysis/${telegramId}?error=${encodeURIComponent(reason)}`);
    }
  });

  app.post("/admin/analysis/:telegramId/regenerate", async (req, res) => {
    const telegramId = BigInt(req.params.telegramId);
    const rec = await currentRecommendation(telegramId);
    if (!rec) return res.status(404).send("Разбора нет.");
    if (rec.sentAt) return res.redirect(`/admin/analysis/${telegramId}?error=Разбор+уже+отправлен`);

    await logAdminAction(adminId(req), "analysis_regenerated", "recommendation", String(rec.id));
    // Результата не ждём: два обращения к модели идут десятки секунд, и
    // запрос успел бы отвалиться по таймауту.
    void generateDraftForAdmin(api, telegramId);
    res.redirect(`/admin/analysis/${telegramId}?regen=1`);
  });

  // ── Таблицы: прохождения, согласия, разборы ───────────────────────
  //
  // Заказы и консультации живут ниже, рядом со своими карточками.

  // Обвязка страницы: одна и та же для всех таблиц.
  const chromeOf = (
    base: string,
    query: ReturnType<typeof parseTableQuery>,
    filters: Record<string, string | boolean>,
    data: { total: number; page: number; pages: number }
  ): ChromeData => ({
    base,
    params: buildParams(query, filters),
    query,
    total: data.total,
    page: data.page,
    pages: data.pages,
  });

  const sendCsv = (res: Response, name: string, body: string) => {
    res.type("text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.send(body);
  };

  app.get("/admin/attempts", async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const query = parseTableQuery(q, "started");
    const filters = parseAttemptsFilters(q);
    const [data, funnel] = await Promise.all([
      loadAttempts(query, filters),
      loadFunnel(dateRange(query)),
    ]);
    res.type("html").send(
      renderAttemptsPage({
        chrome: chromeOf("/admin/attempts", query, { ...filters }, data),
        rows: data.rows,
        funnel,
        filters,
        steps: data.steps,
      })
    );
  });

  app.get("/admin/attempts.csv", async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const query = parseTableQuery(q, "started");
    const data = await loadAttempts(query, parseAttemptsFilters(q));
    sendCsv(
      res,
      "drema-attempts.csv",
      csvOf(
        ["telegram_id", "parent", "attempt", "baby_age_months", "started_at_msk",
         "completed_at_msk", "last_step", "status", "questionnaire_version"],
        data.all.map((r) => [
          r.telegramId, r.parent, String(r.attemptNumber), r.babyAge ?? "",
          formatMoscow(r.startedAt, true), r.completedAt ? formatMoscow(r.completedAt, true) : "",
          r.lastStep === null ? "" : String(r.lastStep), r.view, r.version,
        ])
      )
    );
  });

  app.get("/admin/consent-log", async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const query = parseTableQuery(q, "created");
    const filters = parseConsentFilters(q);
    const data = await loadConsentLog(query, filters);
    res.type("html").send(
      renderConsentLogPage({
        chrome: chromeOf("/admin/consent-log", query, { ...filters }, data),
        rows: data.rows,
        filters,
        versions: data.versions,
      })
    );
  });

  app.get("/admin/consent-log.csv", async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const query = parseTableQuery(q, "created");
    const data = await loadConsentLog(query, parseConsentFilters(q));
    sendCsv(
      res,
      "drema-consents.csv",
      csvOf(
        ["telegram_id", "parent", "consent_type", "action", "document_version", "source", "created_at_msk"],
        data.all.map((r) => [
          r.telegramId, r.parent, r.type, r.action, r.version ?? "", r.source,
          formatMoscow(r.createdAt, true),
        ])
      )
    );
  });

  app.get("/admin/analyses", async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const query = parseTableQuery(q, "waiting");
    const filters = parseAnalysisFilters(q);
    const data = await loadAnalyses(query, filters, env.SLA_PROMISE_HOURS);
    res.type("html").send(
      renderAnalysesPage({
        chrome: chromeOf("/admin/analyses", query, { ...filters }, data),
        rows: data.rows,
        filters,
      })
    );
  });

  app.get("/admin/analyses.csv", async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const query = parseTableQuery(q, "waiting");
    const data = await loadAnalyses(query, parseAnalysisFilters(q), env.SLA_PROMISE_HOURS);
    sendCsv(
      res,
      "drema-analyses.csv",
      csvOf(
        ["telegram_id", "parent", "attempt", "status", "waited", "overdue",
         "sent_at_msk", "api_cost_usd", "rating"],
        data.all.map((r) => [
          r.telegramId, r.parent, String(r.attempt), r.status, r.waiting,
          r.overdue ? "yes" : "no", r.sentAt ? formatMoscow(r.sentAt, true) : "",
          r.costUsd === null ? "" : r.costUsd.toFixed(4), r.rating ?? "",
        ])
      )
    );
  });

  app.get("/admin/orders.csv", async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const query = parseTableQuery(q, "created");
    const data = await loadOrdersTable(query, parseOrderFilters(q));
    sendCsv(
      res,
      "drema-orders.csv",
      csvOf(
        ["order_id", "telegram_id", "parent", "product", "price_rub", "pay_status",
         "paid_at_msk", "pdf_status", "waited", "analysis_sent", "receipt_status", "receipt_url"],
        data.all.map((r) => [
          String(r.id), r.telegramId, r.parent, r.product, String(r.priceRub), r.payStatus,
          r.paidAt ? formatMoscow(r.paidAt, true) : "", r.pdfStatus, r.waiting,
          r.analysisSent ? "yes" : "no", r.receiptStatus, r.receiptUrl ?? "",
        ])
      )
    );
  });

  app.get("/admin/consults.csv", async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const query = parseTableQuery(q, "created");
    const data = await loadConsultsTable(query, parseConsultTableFilters(q));
    sendCsv(
      res,
      "drema-consults.csv",
      csvOf(
        ["consult_id", "telegram_id", "parent", "status", "requested_at_msk", "paid_at_msk",
         "contacted_at_msk", "diary_received", "completed_at_msk", "payout_rub", "payout_paid_at_msk"],
        data.all.map((r) => [
          String(r.id), r.telegramId, r.parent, r.status,
          formatMoscow(r.createdAt, true),
          r.paidAt ? formatMoscow(r.paidAt, true) : "",
          r.contactedAt ? formatMoscow(r.contactedAt, true) : "",
          r.diaryReceived ? "yes" : "no",
          r.doneAt ? formatMoscow(r.doneAt, true) : "",
          r.payoutRub === null ? "" : String(r.payoutRub),
          r.payoutPaidAt ? formatMoscow(r.payoutPaidAt, true) : "",
        ])
      )
    );
  });

  // ── Журнал действий админа ────────────────────────────────────────

  app.get("/admin/log", async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const query = parseTableQuery(q, "created");
    const filters = parseLogFilters(q);
    const data = await loadLog(query, filters);
    res.type("html").send(
      renderLogPage({
        chrome: chromeOf("/admin/log", query, { ...filters }, data),
        rows: data.rows,
        filters,
        usedActions: data.usedActions,
      })
    );
  });

  app.get("/admin/log.csv", async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const query = parseTableQuery(q, "created");
    const data = await loadLog(query, parseLogFilters(q));
    sendCsv(
      res,
      "drema-admin-log.csv",
      csvOf(
        ["created_at_msk", "action", "telegram_id", "parent", "entity_type", "entity_id", "diff"],
        data.all.map((r) => [
          formatMoscow(r.createdAt, true),
          r.action,
          r.telegramId ?? "",
          r.parent ?? "",
          r.entityType,
          r.entityId,
          // Полный diff: выгрузка нужна как раз затем, чтобы разобрать
          // спорный случай целиком, а не по сводке.
          r.diff ? JSON.stringify(r.diff) : "",
        ])
      )
    );
  });

  // ── Пользователи ──────────────────────────────────────────────────

  app.get("/admin/users", async (req, res) => {
    const query = parseUsersQuery(req.query as Record<string, unknown>);
    res.type("html").send(renderUsersPage(await loadUsersPage(query)));
  });

  app.get("/admin/users.csv", async (req, res) => {
    const query = parseUsersQuery(req.query as Record<string, unknown>);
    const rows = await loadAllUserRows(query);
    res.type("text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="drema-users.csv"');
    res.send(usersCsv(rows));
  });

  // Карточка родителя. Отдельный адрес, чтобы ссылку можно было
  // сохранить и переслать — так просит ТЗ.
  app.get("/admin/users/:telegramId", async (req, res) => {
    let telegramId: bigint;
    try {
      telegramId = BigInt(req.params.telegramId);
    } catch {
      return res.status(404).send("Такого пользователя нет.");
    }

    const kind = typeof req.query.kind === "string" ? req.query.kind : "";
    const filter = (TIMELINE_KINDS as readonly string[]).includes(kind)
      ? (kind as TimelineKind)
      : "";

    const data = await loadUserCard(telegramId, filter);
    if (!data) return res.status(404).send("Такого пользователя нет.");
    res.type("html").send(renderUserCard(data));
  });

  // Анкета текстовым файлом. Без параметра attempt — все прохождения
  // подряд, с ним — одно. Данные те же, что в карточке: ничего нового
  // здесь не запрашивается и не считается.
  app.get("/admin/users/:telegramId/questionnaire.txt", async (req, res) => {
    let telegramId: bigint;
    try {
      telegramId = BigInt(req.params.telegramId);
    } catch {
      return res.status(404).send("Такого пользователя нет.");
    }

    const raw = typeof req.query.attempt === "string" ? Number(req.query.attempt) : NaN;
    const attempt = Number.isInteger(raw) ? raw : undefined;

    const data = await loadUserCard(telegramId, "");
    if (!data) return res.status(404).send("Такого пользователя нет.");

    const file = buildQuestionnaireText(data, attempt);
    if (!file) return res.status(404).send("Такого прохождения нет.");

    // filename* с UTF-8: имя файла только из цифр и латиницы, но без
    // звёздочки некоторые браузеры всё равно портят кодировку.
    res.type("text/plain; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${file.filename}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`
    );
    res.send(file.body);
  });

  // Теги и заметка. Ответы родителей тут не правятся — только пометки
  // админа, как и велит ТЗ.
  app.post("/admin/users/:telegramId/meta", async (req, res) => {
    const telegramId = BigInt(req.params.telegramId);
    const tags = String(req.body.tags ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const note = String(req.body.note ?? "").trim() || null;

    const before = await prisma.session.findUnique({
      where: { telegramId },
      select: { tags: true, adminNote: true },
    });

    await prisma.session.update({ where: { telegramId }, data: { tags, adminNote: note } });
    await logAdminAction(adminId(req), "user_meta_changed", "session", String(telegramId), {
      tags: { from: before?.tags ?? [], to: tags },
      note: { from: before?.adminNote ?? null, to: note },
    });

    res.redirect(`/admin/users/${telegramId}`);
  });

  // Отметка запроса на удаление данных. Само удаление — отдельная
  // процедура, которой пока нет: порядок определит юрист.
  app.post("/admin/users/:telegramId/deletion", async (req, res) => {
    const telegramId = BigInt(req.params.telegramId);
    const at = new Date();
    // updateMany с условием: повторное нажатие не должно сдвигать дату
    // запроса на сегодня.
    await prisma.session.updateMany({
      where: { telegramId, deletionRequestedAt: null },
      data: { deletionRequestedAt: at },
    });
    await logAdminAction(adminId(req), "deletion_requested", "session", String(telegramId), {
      at: at.toISOString(),
    });
    res.redirect(`/admin/users/${telegramId}`);
  });

  app.get("/admin/orders", async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const query = parseTableQuery(q, "created");
    const filters = parseOrderFilters(q);
    const data = await loadOrdersTable(query, filters);
    res.type("html").send(
      renderOrdersTablePage({
        chrome: {
          base: "/admin/orders",
          params: buildParams(query, { ...filters }),
          query,
          total: data.total,
          page: data.page,
          pages: data.pages,
        },
        rows: data.rows,
        totals: data.totals,
        filters,
      })
    );
  });

  app.get("/admin/orders/:id", async (req, res) => {
    const loaded = await loadOrder(Number(req.params.id));
    if (!loaded) return res.status(404).send("Заказ не найден или черновик ещё не готов.");

    const { order, draft, recommendation } = loaded;
    const content = currentContent(draft);
    const feedback = await prisma.pdfFeedback.findUnique({ where: { orderId: order.id } });
    const group = content.relaxationGroup as RelaxationGroup;

    res.send(
      renderOrderPage({
        id: order.id,
        telegramId: String(order.telegramId),
        status: order.status,
        createdAt: order.createdAt,
        generationCount: draft.generationCount,
        hasEdits: draft.editedContent !== null,
        memoReady: isRelaxationMemoReady(group),
        content,
        reviewerNotes: draft.reviewerNotes,
        rawPlan: draft.rawPlan,
        questionnaire: await buildPrepText(order.telegramId),
        analysis: recommendation?.analysis ?? "нет",
        message1: recommendation?.message1 ?? "нет",
        message2: recommendation?.message2 ?? "нет",
        relaxationMemo: readRelaxationMemo(group),
        savedJustNow: req.query.saved === "1",
        regenerating: req.query.regen === "1",
        sentJustNow: req.query.sent === "1",
        sendError: typeof req.query.error === "string" ? req.query.error : "",
        feedback: feedback
          ? {
              result: feedback.result,
              comment: feedback.comment,
              skippedComment: feedback.skippedComment,
              askedAt: feedback.askedAt,
              answeredAt: feedback.answeredAt,
              skipReason: feedback.skipReason,
            }
          : null,
      })
    );
  });

  app.post("/admin/orders/:id/save", async (req, res) => {
    const id = Number(req.params.id);
    const loaded = await loadOrder(id);
    if (!loaded) return res.status(404).send("Заказ не найден.");

    const previous = currentContent(loaded.draft);
    const edited: PdfContent = {
      recommendations: String(req.body.recommendations ?? "").trim(),
      schedule: {
        intro: String(req.body.scheduleIntro ?? "").trim(),
        note: String(req.body.scheduleNote ?? "").trim(),
        variants: parseScheduleVariants(req.body),
      },
      // Группу памятки админ не меняет: она выводится из возраста малыша.
      relaxationGroup: previous.relaxationGroup,
    };

    await prisma.pdfDraft.update({
      where: { orderId: id },
      data: { editedContent: edited as object },
    });
    // В журнал идут обе версии: по ТЗ от правки черновика нужен diff.
    await logAdminAction(adminId(req), "pdf_draft_edited", "order", String(id), {
      recommendations: { from: previous.recommendations, to: edited.recommendations },
      scheduleIntro: { from: previous.schedule.intro, to: edited.schedule.intro },
      scheduleNote: { from: previous.schedule.note, to: edited.schedule.note },
    });
    res.redirect(`/admin/orders/${id}?saved=1`);
  });

  // Превью — настоящий PDF, тот же рендер, что уйдёт родителю. Так
  // видно переносы страниц и шрифты, чего HTML-превью не показывало.
  // Дата на обложке — сегодняшняя: настоящая проставится при одобрении.
  app.get("/admin/orders/:id/preview", async (req, res) => {
    const loaded = await loadOrder(Number(req.params.id));
    if (!loaded) return res.status(404).send("Заказ не найден.");

    const content = currentContent(loaded.draft);
    const group = content.relaxationGroup as RelaxationGroup;
    const pdf = await renderPdf(content, readRelaxationMemo(group), new Date());
    res.type("pdf").setHeader("Content-Disposition", "inline; filename=preview.pdf");
    res.send(pdf);
  });

  // HTML-превью осталось как быстрый способ вычитать текст без ожидания
  // рендера: PDF собирается несколько секунд.
  app.get("/admin/orders/:id/preview-html", async (req, res) => {
    const loaded = await loadOrder(Number(req.params.id));
    if (!loaded) return res.status(404).send("Заказ не найден.");

    const content = currentContent(loaded.draft);
    res.send(renderPreview(content, readRelaxationMemo(content.relaxationGroup as RelaxationGroup)));
  });

  app.post("/admin/orders/:id/approve", async (req, res) => {
    const id = Number(req.params.id);
    try {
      await approveAndSendPdf(api, id);
      await logAdminAction(adminId(req), "pdf_sent", "order", String(id), { result: "ok" });
      res.redirect(`/admin/orders/${id}?sent=1`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`Не удалось отправить план по заказу #${id}:`, error);
      await prisma.order
        .update({ where: { id }, data: { deliveryError: reason.slice(0, 500) } })
        .catch(() => {});
      await logAdminAction(adminId(req), "pdf_send_failed", "order", String(id), { result: reason });
      res.redirect(`/admin/orders/${id}?error=${encodeURIComponent(reason)}`);
    }
  });

  app.post("/admin/orders/:id/regenerate", async (req, res) => {
    const id = Number(req.params.id);
    const loaded = await loadOrder(id);
    if (!loaded) return res.status(404).send("Заказ не найден.");

    const comment = String(req.body.comment ?? "").trim() || undefined;

    await logAdminAction(adminId(req), "pdf_regenerated", "order", String(id), { comment });
    // Результата не ждём: два обращения к модели идут минуты, и запрос
    // за это время успел бы отвалиться по таймауту.
    void runPdfGeneration(api, id, comment);
    res.redirect(`/admin/orders/${id}?regen=1`);
  });

  // ── Заявки на консультацию ────────────────────────────────────────

  app.get("/admin/consults", async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const query = parseTableQuery(q, "created");
    const filters = parseConsultTableFilters(q);
    const data = await loadConsultsTable(query, filters);
    res.type("html").send(
      renderConsultsTablePage({
        chrome: {
          base: "/admin/consults",
          params: buildParams(query, { ...filters }),
          query,
          total: data.total,
          page: data.page,
          pages: data.pages,
        },
        rows: data.rows,
        totals: data.totals,
        filters,
        fullPriceRub: env.CONSULT_PRICE_RUB,
      })
    );
  });

  app.get("/admin/consults/:id", async (req, res) => {
    const request = await prisma.consultRequest.findUnique({ where: { id: Number(req.params.id) } });
    if (!request) return res.status(404).send("Заявка не найдена.");

    const [recommendation, ageAnswer, transfer, upsell] = await Promise.all([
      prisma.recommendation.findUnique({
        where: {
          telegramId_attempt: { telegramId: request.telegramId, attempt: request.attempt },
        },
      }),
      prisma.answer.findFirst({
        where: { telegramId: request.telegramId, attempt: request.attempt, questionNumber: 1 },
      }),
      // Согласие на передачу данных Софии: без него пакет не уходит, и
      // в карточке это должно быть видно, а не выясняться в логах.
      prisma.consentRecord.findFirst({
        where: {
          type: "SPECIALIST_TRANSFER",
          action: "GRANTED",
          relatedConsultRequestId: request.id,
        },
      }),
      // Срок скидки живёт у предложения, а не у заявки.
      request.source === "AFTER_PDF"
        ? prisma.upsellOffer.findUnique({ where: { telegramId: request.telegramId } })
        : Promise.resolve(null),
    ]);

    res.send(
      renderConsultPage({
        id: request.id,
        telegramId: String(request.telegramId),
        createdAt: request.createdAt,
        status: request.status,
        parentUsername: request.parentUsername,
        parentPhone: request.parentPhone,
        contactConsentAt: request.contactConsentAt,
        firstContact: request.firstContact,
        contactedAt: request.contactedAt,
        paidAt: request.paidAt,
        chatCreatedAt: request.chatCreatedAt,
        lostAt: request.lostAt,
        lostReason: request.lostReason,
        teamNotifiedAt: request.teamNotifiedAt,
        requestText: request.requestText,
        transferAt: transfer?.createdAt ?? null,
        discountUntil: upsell?.expiresAt ?? null,
        fullPriceRub: env.CONSULT_PRICE_RUB,
        doneAt: request.doneAt,
        diaryReceived: request.diaryReceived,
        payoutRub: request.consultantPayoutRub,
        payoutPaidAt: request.payoutPaidAt,
        priceRub: request.priceRub,
        source: request.source,
        orderId: request.orderId,
        babyAge: ageAnswer?.answerText ?? "не указан",
        questionnaire: await buildPrepText(request.telegramId),
        analysis: recommendation?.analysis ?? "нет",
        message1: recommendation?.message1 ?? "нет",
        message2: recommendation?.message2 ?? "нет",
        statusChanged: req.query.status === "1",
      })
    );
  });

  // Тот же .txt, что уходит специалисту в Telegram: собирается здесь же,
  // чтобы версия в админке и в чате не разъезжались.
  app.get("/admin/consults/:id/package", async (req, res) => {
    const request = await prisma.consultRequest.findUnique({ where: { id: Number(req.params.id) } });
    if (!request) return res.status(404).send("Заявка не найдена.");

    res
      .type("text/plain; charset=utf-8")
      .setHeader("Content-Disposition", `attachment; filename=Zayavka_${request.id}.txt`);
    res.send(await buildConsultPackage(request));
  });

  app.post("/admin/consults/:id/status", async (req, res) => {
    const id = Number(req.params.id);
    const status = String(req.body.status ?? "");
    if (!["CONTACTED", "PAID", "CHAT_CREATED", "DONE", "LOST"].includes(status)) {
      return res.status(400).send("Неизвестный статус.");
    }
    const lostReason = String(req.body.lostReason ?? "").trim() || undefined;

    const before = await prisma.consultRequest.findUnique({
      where: { id },
      select: { status: true },
    });
    await setConsultStatus(id, status as ConsultStatusChange, lostReason);
    await logAdminAction(adminId(req), "consult_status_changed", "consult", String(id), {
      status: { from: before?.status ?? null, to: status },
      ...(lostReason ? { lostReason } : {}),
    });

    // Пакет Софии уходит в момент оплаты — из админки так же, как из
    // кнопки в Telegram.
    if (status === "PAID") await sendConsultPackage(api, id);
    res.redirect(`/admin/consults/${id}?status=1`);
  });

  // Повтор отправки плана. approveAndSendPdf сам откажется, если
  // заказ уже отправлен, — двойной клик второго файла не пришлёт.
  app.post("/admin/orders/:id/retry", async (req, res) => {
    const id = Number(req.params.id);
    try {
      await approveAndSendPdf(api, id);
      await prisma.order.update({ where: { id }, data: { deliveryError: null } });
      await logAdminAction(adminId(req), "pdf_resent", "order", String(id), { result: "ok" });
      res.redirect(`/admin/orders/${id}?sent=1`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await prisma.order
        .update({ where: { id }, data: { deliveryError: reason.slice(0, 500) } })
        .catch(() => {});
      await logAdminAction(adminId(req), "pdf_resend_failed", "order", String(id), { result: reason });
      res.redirect(`/admin/orders/${id}?error=${encodeURIComponent(reason)}`);
    }
  });

  // Чек выбит. Ссылку можно не указывать: чек бывает и без адреса.
  app.post("/admin/orders/:id/receipt", async (req, res) => {
    const id = Number(req.params.id);
    const url = String(req.body.url ?? "").trim() || null;
    await prisma.order.update({
      where: { id },
      data: { receiptStatus: "ISSUED", receiptUrl: url },
    });
    await logAdminAction(adminId(req), "receipt_issued", "order", String(id), { url });
    res.redirect(req.body.back ? String(req.body.back) : "/admin/queue");
  });

  // Заказ оплачен — ручная отметка, пока оплата не подключена.
  app.post("/admin/orders/:id/paid", async (req, res) => {
    const id = Number(req.params.id);
    const before = await prisma.order.findUnique({ where: { id }, select: { status: true, paidAt: true } });
    if (!before) return res.status(404).send("Заказ не найден.");
    // Повторная отметка не сдвигает дату оплаты.
    if (before.paidAt) return res.redirect(`/admin/orders/${id}`);

    await prisma.order.update({
      where: { id },
      data: { paidAt: new Date(), status: "PAID", receiptStatus: "PENDING" },
    });
    await logAdminAction(adminId(req), "order_marked_paid", "order", String(id), {
      status: { from: before.status, to: "PAID" },
    });
    res.redirect(`/admin/orders/${id}`);
  });

  // ── Отметки по консультации ───────────────────────────────────────

  app.post("/admin/consults/:id/contacted", async (req, res) => {
    const id = Number(req.params.id);
    const before = await prisma.consultRequest.findUnique({
      where: { id },
      select: { status: true, contactedAt: true },
    });
    if (!before) return res.status(404).send("Заявка не найдена.");
    if (!before.contactedAt) {
      await setConsultStatus(id, "CONTACTED");
      await logAdminAction(adminId(req), "consult_contacted", "consult", String(id), {
        status: { from: before.status, to: "CONTACTED" },
      });
    }
    res.redirect(req.body.back ? String(req.body.back) : "/admin/queue");
  });

  app.post("/admin/consults/:id/diary", async (req, res) => {
    const id = Number(req.params.id);
    await prisma.consultRequest.update({ where: { id }, data: { diaryReceived: true } });
    await logAdminAction(adminId(req), "consult_diary_received", "consult", String(id));
    res.redirect(req.body.back ? String(req.body.back) : `/admin/consults/${id}`);
  });

  // Выплата Софии. Сумма вводится руками: процент пока не решён, и
  // считать автоматически нечего (открытый вопрос самого ТЗ).
  app.post("/admin/consults/:id/payout", async (req, res) => {
    const id = Number(req.params.id);
    const rub = parseInt(String(req.body.rub ?? ""), 10);
    if (!Number.isFinite(rub) || rub <= 0) {
      return res.redirect(`/admin/consults/${id}?error=${encodeURIComponent("Нужна сумма выплаты")}`);
    }

    const before = await prisma.consultRequest.findUnique({
      where: { id },
      select: { payoutPaidAt: true },
    });
    if (before?.payoutPaidAt) return res.redirect(`/admin/consults/${id}`);

    const at = new Date();
    await prisma.consultRequest.update({
      where: { id },
      data: { consultantPayoutRub: rub, payoutPaidAt: at },
    });
    await logAdminAction(adminId(req), "consult_payout_paid", "consult", String(id), {
      rub,
      at: at.toISOString(),
    });
    res.redirect(req.body.back ? String(req.body.back) : `/admin/consults/${id}`);
  });

  // ── Согласия ──────────────────────────────────────────────────────
  //
  // Страницы только читают: ни одной формы, которая что-то меняет в
  // журнале, здесь нет и быть не должно.

  app.get("/admin/consents", async (req, res) => {
    const query = String(req.query.q ?? "").trim();
    res.send(renderConsentSearchPage(query, query ? await searchUsers(query) : []));
  });

  app.get("/admin/users/:telegramId/consents", async (req, res) => {
    const card = await loadConsentCard(req.params.telegramId);
    if (!card) return res.status(404).send("Пользователь не найден.");
    res.send(renderConsentCard(card));
  });

  // Версия для печати: та же таблица, но с шапкой и без навигации —
  // её и показывают проверяющей стороне.
  app.get("/admin/users/:telegramId/consents/print", async (req, res) => {
    const card = await loadConsentCard(req.params.telegramId);
    if (!card) return res.status(404).send("Пользователь не найден.");
    res.send(renderConsentCard({ ...card, forPrint: true, printedAt: new Date() }));
  });

  app.get("/admin/marketing", async (_req, res) => {
    res.send(renderMarketingPage(await marketingAudience()));
  });

  app.get("/admin/marketing.csv", async (_req, res) => {
    res
      .type("text/csv; charset=utf-8")
      .setHeader("Content-Disposition", "attachment; filename=marketing.csv");
    res.send(marketingCsv(await marketingAudience()));
  });

  // ── Обратная связь ────────────────────────────────────────────────

  app.get("/admin/feedback/analysis", async (req, res) => {
    const days = Math.max(1, Number(req.query.days) || 30);
    res.send(renderAnalysisFeedbackPage(await loadAnalysisFeedback(days)));
  });

  app.get("/admin/feedback/pdf", async (req, res) => {
    const days = Math.max(1, Number(req.query.days) || 30);
    const filter = String(req.query.result ?? "");
    res.send(renderPdfFeedbackPage(await loadPdfFeedback(days, filter)));
  });

  // ── Поддержка ─────────────────────────────────────────────────────

  app.get("/admin/support", async (req, res) => {
    const days = Math.max(1, Number(req.query.days) || 14);
    res.send(renderSupportListPage(await loadSupportList(days)));
  });

  app.get("/admin/support/:id", async (req, res) => {
    const thread = await loadSupportThread(Number(req.params.id));
    if (!thread) return res.status(404).send("Обращение не найдено.");
    res.send(renderSupportThreadPage(thread));
  });

  // Без этого Express отдаёт в браузер стектрейс. Админке он ни к чему,
  // а в логах он останется.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("Ошибка в админке:", error);
    res.status(500).send("Что-то пошло не так. Подробности — в логах приложения.");
  });

  // Слушаем 0.0.0.0, а не localhost: внутри контейнера запрос приходит
  // с другого интерфейса, и на localhost его просто никто не услышит.
  app.listen(env.PORT, "0.0.0.0", () => {
    console.log(`HTTP-сервер слушает 0.0.0.0:${env.PORT}`);
    if (!authConfigured()) {
      console.warn(
        "Вход в админку не настроен (ADMIN_LOGIN, ADMIN_PASSWORD_HASH, " +
          "ADMIN_SESSION_SECRET) — админка отвечает 503. Бот работает."
      );
      return;
    }
    const base = env.PUBLIC_BASE_URL || `http://localhost:${env.PORT}`;
    console.log(`Админка: ${base}/admin/orders`);
  });
}

// Ссылка на заказ для сообщений в Telegram. Без PUBLIC_BASE_URL ссылки
// не будет — лучше её отсутствие, чем битый адрес.
export function orderUrl(orderId: number): string | null {
  return env.PUBLIC_BASE_URL ? `${env.PUBLIC_BASE_URL}/admin/orders/${orderId}` : null;
}

export function consultUrl(requestId: number): string | null {
  return env.PUBLIC_BASE_URL ? `${env.PUBLIC_BASE_URL}/admin/consults/${requestId}` : null;
}

export function consentUrl(telegramId: bigint): string | null {
  return env.PUBLIC_BASE_URL
    ? `${env.PUBLIC_BASE_URL}/admin/users/${telegramId}/consents`
    : null;
}
