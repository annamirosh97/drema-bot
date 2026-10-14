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
