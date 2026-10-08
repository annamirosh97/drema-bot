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
import { buildPrepText, runPdfGeneration } from "../engine";
import { PdfContent, ScheduleRow, ScheduleVariant } from "../paidPdf";
import { RelaxationGroup, isRelaxationMemoReady, readRelaxationMemo } from "../prompts";
import { OrderRow, renderOrderPage, renderOrdersPage, renderPreview } from "./pages";

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
    where: { telegramId: order.telegramId },
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

  // Хостинг проверяет живость сервиса по корню — отвечаем без пароля.
  app.get("/", (_req, res) => res.send("Дрёма-бот жив. Админка — /admin/orders"));

  app.get("/admin/orders", async (_req, res) => {
    const orders = await prisma.order.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
    const rows: OrderRow[] = orders.map((o) => ({
      id: o.id,
      telegramId: String(o.telegramId),
      status: o.status,
      createdAt: o.createdAt,
      hoursWaiting: (Date.now() - o.createdAt.getTime()) / 3_600_000,
    }));
    res.send(renderOrdersPage(rows));
  });

  app.get("/admin/orders/:id", async (req, res) => {
    const loaded = await loadOrder(Number(req.params.id));
    if (!loaded) return res.status(404).send("Заказ не найден или черновик ещё не готов.");

    const { order, draft, recommendation } = loaded;
    const content = currentContent(draft);
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

  app.get("/admin/orders/:id/preview", async (req, res) => {
    const loaded = await loadOrder(Number(req.params.id));
    if (!loaded) return res.status(404).send("Заказ не найден.");

    const content = currentContent(loaded.draft);
    res.send(renderPreview(content, readRelaxationMemo(content.relaxationGroup as RelaxationGroup)));
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
