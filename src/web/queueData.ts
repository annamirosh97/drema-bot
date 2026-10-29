// Очередь «что горит»: сбор задач.
//
// Главный экран админки. Одна таблица всех открытых задач, самые
// срочные сверху. Строка исчезает сама, когда задача закрыта: ничего
// «отметить выполненным» здесь нет, потому что признак закрытия у
// каждой задачи свой и уже есть в базе.
//
// Статусы разбора ТЗ описывает шестью значениями (generating,
// generation_failed, draft, approved, sent, delivery_failed), а в базе
// их три (pending, sent, cancelled). Новое поле заводить не стали:
// остальные четыре однозначно выводятся из того, что уже есть, —
// заполнен ли текст, записана ли ошибка доставки, сколько прошло
// времени. Хранимый статус пришлось бы обновлять из пяти мест, и
// первое же забытое давало бы очередь, которая врёт.

import type { Order, Recommendation } from "@prisma/client";
import { prisma } from "../prisma";
import { env } from "../env";
import { waitedText } from "./usersData";

// Сколько ждать ответа модели, прежде чем считать генерацию зависшей.
// Два вызова идут минуты; полчаса — это уже сбой, о котором бот не
// сообщил.
const GENERATION_STUCK_MIN = 30;

export type TaskType =
  | "analysis_draft"
  | "analysis_failed"
  | "analysis_delivery_failed"
  | "pdf_draft"
  | "pdf_failed"
  | "pdf_delivery_failed"
  | "consult_not_contacted"
  | "receipt_pending"
  | "payout_pending"
  | "deletion_requested";

export const TASK_LABELS: Record<TaskType, string> = {
  analysis_draft: "Разбор: проверить черновик",
  analysis_failed: "Разбор: сбой генерации",
  analysis_delivery_failed: "Разбор: не доставлен",
  pdf_draft: "План: проверить черновик",
  pdf_failed: "План: сбой генерации",
  pdf_delivery_failed: "План: не доставлен",
  consult_not_contacted: "Консультация: София не связалась",
  receipt_pending: "Заказ: чек не выбит",
  payout_pending: "Консультация: выплата Софии",
  deletion_requested: "Удалить данные по запросу",
};

export type SlaLevel = "ok" | "warn" | "danger";

export interface QueueTask {
  type: TaskType;
  telegramId: string;
  parentName: string;
  babyAge: string | null;
  waiting: string;
  // Минуты ожидания: по ним сортируется очередь.
  waitingMinutes: number;
  sla: SlaLevel;
  status: string;
  // Адрес, куда ведёт основное действие.
  href: string;
  actionLabel: string;
  // Дополнительные кнопки-формы: адрес и подпись.
  posts: { href: string; label: string; confirm?: string }[];
}

function slaFor(minutes: number): SlaLevel {
  if (minutes >= env.SLA_DANGER_HOURS * 60) return "danger";
  if (minutes >= env.SLA_WARN_HOURS * 60) return "warn";
  return "ok";
}

function minutesSince(from: Date | null): number {
  if (!from) return 0;
  return Math.max(0, Math.floor((Date.now() - from.getTime()) / 60_000));
}

// Статус разбора по правилам ТЗ, выведенный из полей.
export function analysisStatus(
  rec: Pick<Recommendation, "status" | "message1" | "deliveryError" | "createdAt">
): "generating" | "generation_failed" | "draft" | "sent" | "delivery_failed" | "cancelled" {
  if (rec.status === "cancelled") return "cancelled";
  if (rec.deliveryError) return "delivery_failed";
  if (rec.status === "sent") return "sent";
  if (rec.message1) return "draft";
  return minutesSince(rec.createdAt) > GENERATION_STUCK_MIN ? "generation_failed" : "generating";
}

// То же для платного плана. У заказа есть собственный статус, но он
// описывает оплату и генерацию вместе, поэтому разбираем по частям.
export function pdfStatus(
  order: Pick<Order, "status" | "sentAt" | "deliveryError" | "createdAt"> & {
    draft: { approvedAt: Date | null } | null;
  }
): "generating" | "generation_failed" | "draft" | "sent" | "delivery_failed" | "closed" {
  if (order.deliveryError) return "delivery_failed";
  if (order.sentAt) return "sent";
  if (order.status === "CANCELED" || order.status === "REFUNDED") return "closed";
  if (order.status === "FAILED") return "generation_failed";
  if (order.draft) return "draft";
  return minutesSince(order.createdAt) > GENERATION_STUCK_MIN ? "generation_failed" : "generating";
}

export interface QueueData {
  tasks: QueueTask[];
  counts: { type: TaskType; label: string; count: number }[];
  filter: TaskType | "";
}

export async function loadQueue(filter: TaskType | ""): Promise<QueueData> {
  const [recs, orders, consults, deletions, ages] = await Promise.all([
    // Неотправленные и недоставленные разборы. Отменённые не берём:
    // они закрыты перезапуском анкеты.
    prisma.recommendation.findMany({
      where: { status: { not: "cancelled" }, OR: [{ sentAt: null }, { deliveryError: { not: null } }] },
      include: { session: { select: { firstName: true, botBlockedAt: true } } },
    }),
    prisma.order.findMany({
      where: { status: { notIn: ["CANCELED", "REFUNDED"] } },
      include: { draft: { select: { approvedAt: true } }, session: { select: { firstName: true } } },
    }),
    prisma.consultRequest.findMany({
      where: { status: { notIn: ["LOST", "CANCELED"] } },
      include: { session: { select: { firstName: true } } },
    }),
    prisma.session.findMany({
      where: { deletionRequestedAt: { not: null } },
      select: { telegramId: true, firstName: true, deletionRequestedAt: true },
    }),
    // Возраст малыша — ответ на первый вопрос. Берём по всем сразу:
    // отдельный запрос на каждую строку очереди был бы расточительным.
    prisma.answer.findMany({
      where: { questionNumber: 1 },
      orderBy: { createdAt: "asc" },
      select: { telegramId: true, answerText: true },
    }),
  ]);

  // Свежий ответ побеждает: человек мог проходить анкету дважды.
  const ageByUser = new Map(ages.map((a) => [String(a.telegramId), a.answerText]));
  const tasks: QueueTask[] = [];

  const push = (task: Omit<QueueTask, "waiting" | "sla" | "babyAge">, from: Date | null) => {
    const minutes = minutesSince(from);
    tasks.push({
      ...task,
      babyAge: ageByUser.get(task.telegramId) ?? null,
      waiting: waitedText(from, null),
      waitingMinutes: minutes,
      sla: slaFor(minutes),
    });
  };

  // ── 1. Разборы ────────────────────────────────────────────────────
  for (const r of recs) {
    const status = analysisStatus(r);
    const id = String(r.telegramId);
    const base = {
      telegramId: id,
      parentName: r.session.firstName ?? "без имени",
      waitingMinutes: 0,
      href: `/admin/analysis/${id}`,
      actionLabel: "Открыть черновик",
      posts: [] as QueueTask["posts"],
    };
    // Таймер от момента, когда родитель начал ждать.
    const from = r.waitStartedAt ?? r.createdAt;

    if (status === "draft") {
      push({ ...base, type: "analysis_draft", status: "черновик готов" }, from);
    } else if (status === "generation_failed") {
      push(
        {
          ...base,
          type: "analysis_failed",
          status: "генерация не удалась",
          posts: [{ href: `/admin/analysis/${id}/regenerate`, label: "Перегенерировать" }],
        },
        from
      );
    } else if (status === "delivery_failed") {
      push(
        {
          ...base,
          type: "analysis_delivery_failed",
          status: r.session.botBlockedAt ? "родитель остановил бота" : "не доставлено",
          posts: [
            {
              href: `/admin/analysis/${id}/retry`,
              label: "Повторить отправку",
              confirm: "Отправить разбор родителю ещё раз?",
            },
          ],
        },
        from
      );
    }
  }

  // ── 2. Платные планы ──────────────────────────────────────────────
  for (const o of orders) {
    const status = pdfStatus(o);
    if (status === "sent" || status === "closed") {
      // Заказ закрыт по плану, но мог остаться без чека.
      if (o.paidAt && o.receiptStatus === "PENDING") {
        push(
          {
            type: "receipt_pending",
            telegramId: String(o.telegramId),
            parentName: o.session.firstName ?? "без имени",
            waitingMinutes: 0,
            status: `оплачен ${o.priceRub} ₽`,
            href: `/admin/orders/${o.id}`,
            actionLabel: "Открыть заказ",
            posts: [{ href: `/admin/orders/${o.id}/receipt`, label: "Чек выбит" }],
          },
          o.paidAt
        );
      }
      continue;
    }

    const base = {
      telegramId: String(o.telegramId),
      parentName: o.session.firstName ?? "без имени",
      waitingMinutes: 0,
      href: `/admin/orders/${o.id}`,
      actionLabel: "Открыть черновик",
      posts: [] as QueueTask["posts"],
    };
    const from = o.paidAt ?? o.createdAt;

    if (status === "draft") {
      push({ ...base, type: "pdf_draft", status: "черновик готов" }, from);
    } else if (status === "generation_failed") {
      push(
        {
          ...base,
          type: "pdf_failed",
          status: o.failReason ? `сбой: ${o.failReason}` : "генерация не удалась",
          posts: [{ href: `/admin/orders/${o.id}/regenerate`, label: "Перегенерировать" }],
        },
        from
      );
    } else if (status === "delivery_failed") {
      push(
        {
          ...base,
          type: "pdf_delivery_failed",
          status: "не доставлено",
          posts: [
            {
              href: `/admin/orders/${o.id}/retry`,
              label: "Повторить отправку",
              confirm: "Отправить план родителю ещё раз?",
            },
          ],
        },
        from
      );
    }
  }

  // ── 3 и 4. Консультации ───────────────────────────────────────────
  for (const c of consults) {
    const name = c.session.firstName ?? "без имени";

    // Оплачена, но София ещё не связалась. Пока оплата не подключена,
    // отсчёт идёт от создания заявки: ждёт-то человек с этого момента.
    if (!c.contactedAt && c.status !== "DONE") {
      push(
        {
          type: "consult_not_contacted",
          telegramId: String(c.telegramId),
          parentName: name,
          waitingMinutes: 0,
          status: c.firstContact === "PENDING" ? "ждём согласия на контакт" : "контакт передан",
          href: `/admin/consults/${c.id}`,
          actionLabel: "Открыть заявку",
          posts: [{ href: `/admin/consults/${c.id}/contacted`, label: "София связалась" }],
        },
        c.paidAt ?? c.createdAt
      );
    }

    // Проведена, но выплата не отмечена.
    if (c.doneAt && !c.payoutPaidAt) {
      push(
        {
          type: "payout_pending",
          telegramId: String(c.telegramId),
          parentName: name,
          waitingMinutes: 0,
          status: "консультация проведена",
          href: `/admin/consults/${c.id}`,
          actionLabel: "Открыть заявку",
          posts: [],
        },
        c.doneAt
      );
    }
  }

  // ── 5. Запросы на удаление ────────────────────────────────────────
  for (const d of deletions) {
    push(
      {
        type: "deletion_requested",
        telegramId: String(d.telegramId),
        parentName: d.firstName ?? "без имени",
        waitingMinutes: 0,
        status: "удаление не выполнено",
        href: `/admin/users/${d.telegramId}`,
        actionLabel: "Открыть карточку",
        posts: [],
      },
      d.deletionRequestedAt
    );
  }

  // Самые срочные сверху: по ТЗ сортировка по оставшемуся до обещания
  // времени, то есть по убыванию ожидания.
  tasks.sort((a, b) => b.waitingMinutes - a.waitingMinutes);

  // Счётчики по типам: только по тем, что встречаются.
  const counts = (Object.keys(TASK_LABELS) as TaskType[])
    .map((type) => ({
      type,
      label: TASK_LABELS[type],
      count: tasks.filter((t) => t.type === type).length,
    }))
    .filter((c) => c.count > 0);

  return {
    tasks: filter ? tasks.filter((t) => t.type === filter) : tasks,
    counts,
    filter,
  };
}
