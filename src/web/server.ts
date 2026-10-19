// Веб-админка: проверка и правка черновиков PDF перед отправкой.
//
// Живёт в том же процессе, что и бот: так страница заказа напрямую
// вызывает генерацию и шлёт уведомления через bot.api, без очередей и
// межпроцессного взаимодействия. Нагрузка — один человек, этого хватает.
//
// Если ADMIN_PASSWORD не задан, сервер не поднимается, а бот продолжает
// работать. Иначе первый же деплой до того, как переменная прописана,
// уронил бы бота целиком.

import express, { NextFunction, Request, Response } from "express";
import type { Api } from "grammy";
import { prisma } from "../prisma";
import { env } from "../env";
import { approveAndSendPdf, buildPrepText, runPdfGeneration } from "../engine";
import { renderPdf } from "../pdf/render";
import { PdfContent, ScheduleRow, ScheduleVariant } from "../paidPdf";
import { RelaxationGroup, isRelaxationMemoReady, readRelaxationMemo } from "../prompts";
import { OrderRow, renderOrderPage, renderOrdersPage, renderPreview } from "./pages";
import { ConsultRow, renderConsultPage, renderConsultsPage } from "./consultPages";
import { ConsultStatusChange, buildConsultPackage, setConsultStatus } from "../consult";
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
import { getConsentState } from "../consents";
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

// ── Авторизация ─────────────────────────────────────────────────────

// Basic auth: логин не проверяем, он может быть любым — пользователь
// ровно один, и значение имеет только пароль.
function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const [scheme, encoded] = header.split(" ");

  if (scheme === "Basic" && encoded) {
    const password = Buffer.from(encoded, "base64").toString("utf8").split(":").slice(1).join(":");
    if (password === env.ADMIN_PASSWORD) return next();
  }

  res.setHeader("WWW-Authenticate", 'Basic realm="Drema admin", charset="UTF-8"');
  res.status(401).send("Нужен пароль.");
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

  // Сервер поднимаем всегда, даже когда пароль не задан. Если не
  // поднять, хостингу некуда маршрутизировать запрос, и в браузере
  // вместо объяснения получается «Application failed to respond», по
  // которому не понять, бот упал, порт не тот или дело в переменной.
  // Поэтому без пароля админка отвечает честным 503 с объяснением.
  app.use("/admin", (req, res, next) => {
    if (!env.ADMIN_PASSWORD) {
      return res
        .status(503)
        .type("html")
        .send(
          "<h1>Админка не настроена</h1>" +
            "<p>Не задана переменная окружения <code>ADMIN_PASSWORD</code>. " +
            "Добавь её в Variables сервиса и перезапусти деплой.</p>" +
            "<p>Сам бот при этом работает.</p>"
        );
    }
    return requireAuth(req, res, next);
  });

  // Юридические документы. Пока это заглушки, но адреса уже уходят
  // людям в сообщениях о согласиях и будут лежать в журнале, поэтому
  // отвечать по ним нужно с самого начала — и без пароля.
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
  app.get("/", (_req, res) =>
    res.send("Дрёма-бот жив. Админка — /admin/orders, /admin/consults, /admin/consents и /admin/support")
  );

  app.get("/admin/orders", async (_req, res) => {
    const orders = await prisma.order.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
    const feedback = await prisma.pdfFeedback.findMany({
      where: { orderId: { in: orders.map((o) => o.id) } },
      select: { orderId: true, result: true },
    });
    const byOrder = new Map(feedback.map((f) => [f.orderId, f.result]));

    const rows: OrderRow[] = orders.map((o) => ({
      id: o.id,
      telegramId: String(o.telegramId),
      status: o.status,
      createdAt: o.createdAt,
      hoursWaiting: (Date.now() - o.createdAt.getTime()) / 3_600_000,
      result: byOrder.get(o.id) ?? null,
    }));
    res.send(renderOrdersPage(rows));
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
      res.redirect(`/admin/orders/${id}?sent=1`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`Не удалось отправить план по заказу #${id}:`, error);
      res.redirect(`/admin/orders/${id}?error=${encodeURIComponent(reason)}`);
    }
  });

  app.post("/admin/orders/:id/regenerate", async (req, res) => {
    const id = Number(req.params.id);
    const loaded = await loadOrder(id);
    if (!loaded) return res.status(404).send("Заказ не найден.");

    const comment = String(req.body.comment ?? "").trim() || undefined;

    // Результата не ждём: два обращения к модели идут минуты, и запрос
    // за это время успел бы отвалиться по таймауту.
    void runPdfGeneration(api, id, comment);
    res.redirect(`/admin/orders/${id}?regen=1`);
  });

  // ── Заявки на консультацию ────────────────────────────────────────

  app.get("/admin/consults", async (_req, res) => {
    const requests = await prisma.consultRequest.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const rows: ConsultRow[] = requests.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      status: r.status,
      parentUsername: r.parentUsername,
      firstContact: r.firstContact,
      source: r.source,
      priceRub: r.priceRub,
      hoursWaiting: (Date.now() - r.createdAt.getTime()) / 3_600_000,
    }));
    res.send(renderConsultsPage(rows));
  });

  app.get("/admin/consults/:id", async (req, res) => {
    const request = await prisma.consultRequest.findUnique({ where: { id: Number(req.params.id) } });
    if (!request) return res.status(404).send("Заявка не найдена.");

    const [recommendation, ageAnswer] = await Promise.all([
      prisma.recommendation.findUnique({
        where: {
          telegramId_attempt: { telegramId: request.telegramId, attempt: request.attempt },
        },
      }),
      prisma.answer.findFirst({
        where: { telegramId: request.telegramId, attempt: request.attempt, questionNumber: 1 },
      }),
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
        doneAt: request.doneAt,
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
    if (!["CONTACTED", "DONE", "CANCELED"].includes(status)) {
      return res.status(400).send("Неизвестный статус.");
    }

    await setConsultStatus(id, status as ConsultStatusChange);
    res.redirect(`/admin/consults/${id}?status=1`);
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
    if (!env.ADMIN_PASSWORD) {
      console.warn("ADMIN_PASSWORD не задан — админка отвечает 503. Бот работает.");
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
