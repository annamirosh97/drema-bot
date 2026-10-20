// Журнал согласий.
//
// Главное правило: записи только добавляются. Ни одна функция здесь не
// умеет менять или удалять запись, и база этого тоже не позволит — на
// таблице стоит триггер (см. миграцию 20261015000000_consents_journal).
// Текущее состояние согласия — это последняя запись его типа.
//
// Второе правило: запись делается ДО того, как бот ответит человеку.
// Если записать не вышло, действие не выполняется вовсе — иначе
// получилось бы согласие, которого нет в журнале, то есть которого для
// проверяющей стороны не существует.

import type {
  ConsentAction,
  ConsentRecord,
  ConsentSource,
  ConsentType,
  LegalDocType,
} from "@prisma/client";
import { prisma } from "./prisma";
import { logEvent } from "./events";
import { env } from "./env";
import { activeDocumentIds } from "./legalDocs";

export interface ConsentInput {
  telegramId: bigint;
  type: ConsentType;
  action: ConsentAction;
  source: ConsentSource;
  // Документы, показанные в момент действия. Для согласия на ПД это
  // сразу два: политика и само согласие.
  documents: LegalDocType[];
  // Точный текст, который видел человек, и подпись нажатой кнопки или
  // введённая команда. Хранятся как есть: через год формулировки
  // поменяются, а доказывать придётся по той, что была тогда.
  messageText: string;
  buttonText: string;
  telegramMessageId?: number;
  relatedOrderId?: number;
  relatedConsultRequestId?: number;
}

export async function recordConsent(input: ConsentInput): Promise<ConsentRecord> {
  return prisma.consentRecord.create({
    data: {
      telegramId: input.telegramId,
      type: input.type,
      action: input.action,
      source: input.source,
      documentIds: activeDocumentIds(...input.documents),
      messageText: input.messageText,
      buttonText: input.buttonText,
      telegramMessageId: input.telegramMessageId ?? null,
      relatedOrderId: input.relatedOrderId ?? null,
      relatedConsultRequestId: input.relatedConsultRequestId ?? null,
    },
  });
}

// ── Текущее состояние ───────────────────────────────────────────────

export interface ConsentStatus {
  action: ConsentAction | null; // null — записей этого типа ещё не было
  at: Date | null;
  record: ConsentRecord | null;
}

export type ConsentState = Record<ConsentType, ConsentStatus>;

const ALL_TYPES: ConsentType[] = [
  "PD_PROCESSING",
  "MARKETING",
  "OFFER_ACCEPTANCE",
  "SPECIALIST_TRANSFER",
  "HEALTH_SELF_DECLARATION",
];

const EMPTY: ConsentStatus = { action: null, at: null, record: null };

// Состояние по всем типам сразу. Вся логика бота смотрит только сюда и
// никогда — на отдельные записи: что считать текущим значением, решает
// одно место.
export async function getConsentState(telegramId: bigint): Promise<ConsentState> {
  const records = await prisma.consentRecord.findMany({
    where: { telegramId },
    orderBy: { createdAt: "desc" },
  });

  const state = Object.fromEntries(ALL_TYPES.map((type) => [type, EMPTY])) as ConsentState;

  for (const record of records) {
    // Записи идут от новых к старым, поэтому первая встреченная запись
    // типа и есть текущее состояние.
    if (state[record.type].record) continue;
    state[record.type] = { action: record.action, at: record.createdAt, record };
  }

  return state;
}

// Последнее состояние одного типа — когда остальные не нужны.
export async function getConsent(
  telegramId: bigint,
  type: ConsentType
): Promise<ConsentStatus> {
  const record = await prisma.consentRecord.findFirst({
    where: { telegramId, type },
    orderBy: { createdAt: "desc" },
  });
  return record ? { action: record.action, at: record.createdAt, record } : EMPTY;
}

export function isGranted(status: ConsentStatus): boolean {
  return status.action === "GRANTED";
}

// Типы согласий человеческими словами — для админки и выгрузок. У
// подтверждения о здоровье подпись развёрнутая: проверяющей стороне
// важно видеть, что именно подтвердил родитель, а не имя константы.
const TYPE_LABELS: Record<ConsentType, string> = {
  PD_PROCESSING: "Обработка персональных данных",
  MARKETING: "Рекламная рассылка",
  OFFER_ACCEPTANCE: "Принятие оферты",
  SPECIALIST_TRANSFER: "Передача данных специалисту",
  HEALTH_SELF_DECLARATION: "Подтверждение: нет особенностей здоровья, влияющих на сон",
};

export function consentTypeLabel(type: ConsentType): string {
  return TYPE_LABELS[type] ?? type;
}

// ── Можно ли писать человеку ────────────────────────────────────────
//
// Категория есть у каждого сообщения, которое бот отправляет по своей
// инициативе — то есть не в ответ на нажатие или сообщение человека.
// Через canSend проходят все такие отправки, и решение принимается в
// момент отправки, а не когда её запланировали: за эти минуты человек
// мог отписаться.

export type MessageCategory = "SERVICE" | "FEEDBACK" | "FOLLOWUP" | "MARKETING";

const CATEGORY_LABELS: Record<MessageCategory, string> = {
  SERVICE: "то, за чем человек пришёл: разбор, план, сообщения по заказу",
  FEEDBACK: "вопрос о впечатлениях",
  FOLLOWUP: "проверка «как дела» после разбора или плана",
  MARKETING: "предложения и рассылки",
};

export function categoryLabel(category: MessageCategory): string {
  return CATEGORY_LABELS[category] ?? category;
}

export interface SendDecision {
  allowed: boolean;
  reason?: string;
}

// Решение по одному сообщению.
//
// Два правила, и первое важнее: если человек не дал или отозвал
// согласие на обработку данных, бот молчит совсем. Отвечать на его
// собственные действия это не мешает — через canSend такие ответы не
// проходят.
export async function canSend(
  telegramId: bigint,
  category: MessageCategory
): Promise<SendDecision> {
  const state = await getConsentState(telegramId);

  if (!isGranted(state.PD_PROCESSING)) {
    return { allowed: false, reason: "нет согласия на обработку данных" };
  }

  const needsMarketing =
    category === "MARKETING" ||
    category === "FOLLOWUP" ||
    (category === "FEEDBACK" && env.FEEDBACK_REQUIRES_MARKETING);

  if (needsMarketing && !isGranted(state.MARKETING)) {
    return { allowed: false, reason: "нет согласия на рассылку" };
  }

  return { allowed: true };
}

// Записывает, что сообщение не ушло. Нужна, чтобы потом было видно:
// человек не получил предложение не по сбою, а потому что отказался.
// Сбой самой записи не должен ничего ронять — это статистика.
export async function logSuppressed(
  telegramId: bigint,
  category: MessageCategory,
  kind: string
): Promise<void> {
  try {
    await prisma.suppressedMessage.create({ data: { telegramId, category, kind } });
    await logEvent(telegramId, "message_suppressed");
  } catch (error) {
    console.error(`Не удалось записать подавленное сообщение ${kind}:`, error);
  }
}

// Проверка и запись одним движением: так ни одна инициативная отправка
// не потеряет отметку о том, почему её не было.
export async function allowedToSend(
  telegramId: bigint,
  category: MessageCategory,
  kind: string
): Promise<boolean> {
  const decision = await canSend(telegramId, category);
  if (decision.allowed) return true;

  console.log(`Не отправляю ${kind} пользователю #${telegramId}: ${decision.reason}.`);
  await logSuppressed(telegramId, category, kind);
  return false;
}

// ── Даты для человека ───────────────────────────────────────────────

// Время показываем по Москве: бот русскоязычный, а контейнер живёт в
// UTC, и «14.10.2026 12:42» без поправки сбивало бы с толку.
const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;

export function formatMoscow(date: Date, withSeconds = false): string {
  const m = new Date(date.getTime() + MOSCOW_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  const time =
    `${pad(m.getUTCHours())}:${pad(m.getUTCMinutes())}` +
    (withSeconds ? `:${pad(m.getUTCSeconds())}` : "");
  return `${pad(m.getUTCDate())}.${pad(m.getUTCMonth() + 1)}.${m.getUTCFullYear()} ${time} (мск)`;
}

// ── Те, кто пользовался ботом до появления согласий ─────────────────

// Сколько таких в базе: у человека есть сессия, но ни одной записи о
// согласии на обработку данных. Им экраны согласий показываются при
// следующем действии (см. engine.ts).
export async function countUsersWithoutPdConsent(): Promise<number> {
  const [sessions, consented] = await Promise.all([
    prisma.session.count(),
    prisma.consentRecord.findMany({
      where: { type: "PD_PROCESSING" },
      distinct: ["telegramId"],
      select: { telegramId: true },
    }),
  ]);
  return Math.max(0, sessions - consented.length);
}
