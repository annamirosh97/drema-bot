// Общий статус родителя и сводные цифры по нему.
//
// Статус по ТЗ не хранится, а вычисляется из последних записей. Это не
// прихоть: хранимое поле пришлось бы обновлять из десятка мест в боте,
// и первое же забытое место дало бы карточку, которая врёт. Здесь же
// правило одно и видно целиком.
//
// Порядок проверок важен: он от самого «горячего» к самому спокойному.
// Человек, заблокировавший бота, остаётся заблокировавшим, что бы он ни
// проходил раньше, — иначе в списке он выглядел бы живым.

import type {
  ConsultRequest,
  Order,
  QuestionnaireAttempt,
  Recommendation,
  Session,
} from "@prisma/client";
import { attemptView } from "../attempts";

export type UserStatusCode =
  | "blocked"
  | "deletion_requested"
  | "consult_in_progress"
  | "pdf_sent"
  | "pdf_waiting"
  | "analysis_sent"
  | "analysis_waiting"
  | "quiz_abandoned"
  | "quiz_in_progress"
  | "onboarding";

export interface UserStatus {
  code: UserStatusCode;
  label: string;
  // Вопрос, на котором человек стоит: только для идущей анкеты.
  step?: number | null;
}

export interface UserFacts {
  session: Pick<Session, "botBlockedAt" | "deletionRequestedAt">;
  attempts: Pick<QuestionnaireAttempt, "status" | "lastActivityAt" | "lastStep" | "attemptNumber">[];
  recommendations: Pick<Recommendation, "status" | "attempt">[];
  orders: Pick<Order, "status" | "paidAt" | "sentAt">[];
  consults: Pick<ConsultRequest, "status">[];
}

const CONSULT_IN_WORK = new Set(["PAID", "NEW", "CONTACTED"]);

export function userStatus(facts: UserFacts): UserStatus {
  if (facts.session.botBlockedAt) return { code: "blocked", label: "заблокировала бота" };
  if (facts.session.deletionRequestedAt) {
    return { code: "deletion_requested", label: "запросила удаление данных" };
  }

  if (facts.consults.some((c) => CONSULT_IN_WORK.has(c.status))) {
    return { code: "consult_in_progress", label: "консультация в работе" };
  }

  // Платный план: сначала смотрим отправленный, потом ожидание.
  if (facts.orders.some((o) => o.sentAt)) return { code: "pdf_sent", label: "получила PDF" };
  if (facts.orders.some((o) => !o.sentAt && o.status !== "CANCELED" && o.status !== "FAILED")) {
    return { code: "pdf_waiting", label: "ждёт PDF" };
  }

  // Последнее прохождение: по нему судим о бесплатном разборе.
  const last = [...facts.attempts].sort((a, b) => b.attemptNumber - a.attemptNumber)[0];

  if (last?.status === "COMPLETED") {
    const rec = facts.recommendations.find((r) => r.attempt === last.attemptNumber);
    return rec?.status === "sent"
      ? { code: "analysis_sent", label: "получила анализ" }
      : { code: "analysis_waiting", label: "ждёт бесплатный анализ" };
  }

  if (last) {
    // Заброшенность считается от времени последней активности, а не
    // хранится: см. src/attempts.ts.
    return attemptView(last) === "abandoned"
      ? { code: "quiz_abandoned", label: "бросила анкету", step: last.lastStep }
      : { code: "quiz_in_progress", label: "проходит анкету", step: last.lastStep };
  }

  return { code: "onboarding", label: "в онбординге" };
}

// Статус строкой для таблицы: у идущей и брошенной анкеты дописываем
// шаг, иначе «проходит анкету» ничего не говорит.
export function userStatusText(status: UserStatus): string {
  if (status.step == null) return status.label;
  return `${status.label} (вопрос ${status.step})`;
}

// Сколько человек заплатил. Считаем по оплаченным и отправленным
// заказам: заказ со статусом «создан» денег ещё не принёс, а возврат
// их забрал.
export function paidTotal(orders: Pick<Order, "priceRub" | "paidAt" | "refundedAt">[]): number {
  return orders
    .filter((o) => o.paidAt && !o.refundedAt)
    .reduce((sum, o) => sum + o.priceRub, 0);
}

// Все статусы для фильтра в таблице. Порядок тот же, что в userStatus:
// сверху то, что требует внимания.
export const USER_STATUS_OPTIONS: { code: UserStatusCode; label: string }[] = [
  { code: "analysis_waiting", label: "ждёт бесплатный анализ" },
  { code: "pdf_waiting", label: "ждёт PDF" },
  { code: "consult_in_progress", label: "консультация в работе" },
  { code: "quiz_in_progress", label: "проходит анкету" },
  { code: "quiz_abandoned", label: "бросила анкету" },
  { code: "analysis_sent", label: "получила анализ" },
  { code: "pdf_sent", label: "получила PDF" },
  { code: "onboarding", label: "в онбординге" },
  { code: "blocked", label: "заблокировала бота" },
  { code: "deletion_requested", label: "запросила удаление данных" },
];
