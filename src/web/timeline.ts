// Лента событий в карточке родителя.
//
// Собирается из рабочих таблиц, а не из журнала OfferEvent. Причина: в
// журнале лежат нажатия и показы экранов — он отвечает на вопрос «где
// отваливаются», и событий там десятки на человека. Карточка отвечает
// на другой вопрос: что с этим родителем происходило по существу.
// Прохождения, согласия, заказы и разборы знают это точнее, потому что
// у них есть собственные времена.
//
// Исключение — действия админа: у них своей рабочей таблицы нет, и они
// берутся из AdminAction.

import type {
  AdminAction,
  AnalysisFeedback,
  ConsentRecord,
  ConsultRequest,
  Order,
  PdfFeedback,
  QuestionnaireAttempt,
  Recommendation,
} from "@prisma/client";
import { consentTypeLabel } from "../consents";

// Типы для фильтра в карточке. Группы крупные: фильтр нужен, чтобы
// отсечь шум, а не чтобы перебирать по одному событию.
export type TimelineKind = "quiz" | "consent" | "analysis" | "order" | "consult" | "feedback" | "admin";

export const TIMELINE_LABELS: Record<TimelineKind, string> = {
  quiz: "Анкета",
  consent: "Согласия",
  analysis: "Разбор",
  order: "Заказы",
  consult: "Консультации",
  feedback: "Отзывы",
  admin: "Действия админа",
};

export interface TimelineEvent {
  at: Date;
  kind: TimelineKind;
  text: string;
  // Куда ведёт событие: вкладка карточки или внешняя страница.
  href?: string;
}

const ORDER_STATUS: Record<string, string> = {
  PENDING_PAYMENT: "ждёт оплаты",
  PAID: "оплачен",
  GENERATING: "готовится",
  DRAFT_READY: "черновик готов",
  SENT: "отправлен",
  FAILED: "сбой",
  CANCELED: "отменён",
  REFUNDED: "возврат",
};

const CONSULT_STATUS: Record<string, string> = {
  PENDING_PAYMENT: "ждёт оплаты",
  PAID: "оплачена",
  NEW: "новая",
  CONTACTED: "связались",
  DONE: "проведена",
  CANCELED: "отменена",
};

export interface TimelineInput {
  attempts: QuestionnaireAttempt[];
  consents: ConsentRecord[];
  recommendations: Recommendation[];
  orders: (Order & { draft: { approvedAt: Date | null; createdAt: Date } | null })[];
  consults: ConsultRequest[];
  analysisFeedback: AnalysisFeedback | null;
  pdfFeedback: PdfFeedback[];
  adminActions: AdminAction[];
}

// Одно событие на каждый случившийся факт. Пустые времена
// пропускаются: событие, которого не было, в ленте не нужно.
export function buildTimeline(input: TimelineInput): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const add = (at: Date | null, kind: TimelineKind, text: string, href?: string) => {
    if (at) events.push({ at, kind, text, href });
  };

  for (const a of input.attempts) {
    add(a.startedAt, "quiz", `Начала анкету, прохождение №${a.attemptNumber}`, "#attempts");
    if (a.completedAt) {
      add(a.completedAt, "quiz", `Завершила анкету, прохождение №${a.attemptNumber}`, "#attempts");
    } else if (a.lastStep != null) {
      add(
        a.lastActivityAt,
        "quiz",
        `Остановилась на вопросе ${a.lastStep}, прохождение №${a.attemptNumber}`,
        "#attempts"
      );
    }
  }

  for (const c of input.consents) {
    const action =
      c.action === "GRANTED" ? "Дала согласие" : c.action === "DECLINED" ? "Отказалась" : "Отозвала согласие";
    add(
      c.createdAt,
      "consent",
      `${action}: ${consentTypeLabel(c.type)}`,
      "#consents"
    );
  }

  for (const r of input.recommendations) {
    add(r.createdAt, "analysis", `Анкета сдана, разбор №${r.attempt} в очереди`, "#recommendations");
    if (r.message1) {
      add(r.createdAt, "analysis", `Черновик разбора №${r.attempt} готов`, "#recommendations");
    }
    add(r.sentAt, "analysis", `Разбор №${r.attempt} отправлен`, "#recommendations");
    if (r.deliveryError) {
      add(r.sentAt ?? r.createdAt, "analysis", `Ошибка доставки разбора: ${r.deliveryError}`, "#recommendations");
    }
    add(r.cancelledAt, "analysis", `Разбор №${r.attempt} отменён: ${r.cancelReason ?? "без причины"}`, "#recommendations");
  }

  for (const o of input.orders) {
    add(o.createdAt, "order", `Нажала «Купить»: ${o.product}, ${o.priceRub} ₽`, `/admin/orders/${o.id}`);
    add(o.paidAt, "order", `Оплатила заказ #${o.id}`, `/admin/orders/${o.id}`);
    add(o.draft?.createdAt ?? null, "order", `Черновик плана по заказу #${o.id} готов`, `/admin/orders/${o.id}`);
    add(o.draft?.approvedAt ?? null, "order", `План по заказу #${o.id} утверждён`, `/admin/orders/${o.id}`);
    add(o.sentAt, "order", `План по заказу #${o.id} отправлен`, `/admin/orders/${o.id}`);
    if (o.deliveryError) {
      add(o.sentAt ?? o.createdAt, "order", `Ошибка доставки плана: ${o.deliveryError}`, `/admin/orders/${o.id}`);
    }
    if (o.receiptStatus === "ISSUED") {
      add(o.paidAt, "order", `Чек по заказу #${o.id} выбит`, `/admin/orders/${o.id}`);
    }
    add(o.refundedAt, "order", `Возврат по заказу #${o.id}`, `/admin/orders/${o.id}`);
    if (o.status === "FAILED") {
      add(o.createdAt, "order", `Сбой генерации плана: ${o.failReason ?? "без причины"}`, `/admin/orders/${o.id}`);
    }
  }

  for (const c of input.consults) {
    add(c.createdAt, "consult", `Запросила консультацию, заявка #${c.id}`, `/admin/consults/${c.id}`);
    add(c.contactConsentAt, "consult", `Разрешила передать контакт по заявке #${c.id}`, `/admin/consults/${c.id}`);
    add(c.paidAt, "consult", `Оплатила консультацию, заявка #${c.id}`, `/admin/consults/${c.id}`);
    add(c.contactedAt, "consult", `София связалась, заявка #${c.id}`, `/admin/consults/${c.id}`);
    if (c.diaryReceived) {
      add(c.contactedAt ?? c.createdAt, "consult", `Дневник сна получен, заявка #${c.id}`, `/admin/consults/${c.id}`);
    }
    add(c.doneAt, "consult", `Консультация проведена, заявка #${c.id}`, `/admin/consults/${c.id}`);
    add(c.payoutPaidAt, "consult", `Выплата Софии по заявке #${c.id}: ${c.consultantPayoutRub ?? "?"} ₽`, `/admin/consults/${c.id}`);
    add(c.canceledAt, "consult", `Заявка #${c.id} отменена`, `/admin/consults/${c.id}`);
  }

  const f = input.analysisFeedback;
  if (f?.answeredAt) {
    add(f.answeredAt, "feedback", `Оценила разбор: ${f.rating ?? "без оценки"}`, "/admin/feedback/analysis");
  }
  for (const p of input.pdfFeedback) {
    if (p.answeredAt) {
      add(p.answeredAt, "feedback", `Рассказала о результате плана: ${p.result ?? "без ответа"}`, "/admin/feedback/pdf");
    }
  }

  for (const a of input.adminActions) {
    add(a.createdAt, "admin", `${a.action} · ${a.entityType} #${a.entityId}`, "/admin/log");
  }

  // Свежее сверху, как просит ТЗ.
  return events.sort((x, y) => y.at.getTime() - x.at.getTime());
}

export { ORDER_STATUS, CONSULT_STATUS };
