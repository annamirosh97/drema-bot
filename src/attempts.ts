// Прохождения анкеты как записи.
//
// До 20.10.2026 прохождение было числом в Session.attempt: по нему
// нельзя было узнать ни когда человек начал анкету, ни где именно
// остановился, ни сколько прохождений он бросил. Админке это нужно, и
// восстановить задним числом невозможно, поэтому на каждое прохождение
// теперь есть строка.
//
// Строка заводится при показе первого вопроса и закрывается при
// подтверждении анкеты. Между этими моментами её двигает каждый ответ.
//
// Сбой записи не должен мешать человеку проходить анкету: всё внутри
// try/catch, как у журнала событий.

import { prisma } from "./prisma";

// Версия анкеты. Увеличивать руками при изменении состава или
// формулировок вопросов: по ней в админке видно, можно ли честно
// сравнивать два прохождения между собой.
//
// 'legacy' стоит у прохождений, перенесённых миграцией: какими были
// вопросы до этой даты, по базе не восстановить.
export const QUESTIONNAIRE_VERSION = "2026-10-20";

// Сколько человек должен молчать, чтобы прохождение считалось
// брошенным. Не хранится в базе: это наблюдение в момент просмотра, а
// не событие. Хранимый статус требовал бы фоновой задачи и всё равно
// врал бы между её тиками.
const ABANDONED_AFTER_MS = 48 * 3_600_000;

export type AttemptView = "in_progress" | "completed" | "abandoned";

// Как показывать прохождение сейчас.
export function attemptView(attempt: {
  status: string;
  lastActivityAt: Date;
}): AttemptView {
  if (attempt.status === "COMPLETED") return "completed";
  return Date.now() - attempt.lastActivityAt.getTime() > ABANDONED_AFTER_MS
    ? "abandoned"
    : "in_progress";
}

export function abandonedBefore(): Date {
  return new Date(Date.now() - ABANDONED_AFTER_MS);
}

// Начало прохождения: зовётся при показе первого вопроса.
//
// upsert, а не create: первый вопрос может быть показан повторно — из
// меню, по кнопке из напоминания, командой. Второй раз это то же
// прохождение, и начало у него прежнее.
export async function startAttempt(
  telegramId: bigint,
  attemptNumber: number,
  firstStep: number | null
): Promise<void> {
  try {
    const now = new Date();
    await prisma.questionnaireAttempt.upsert({
      where: { telegramId_attemptNumber: { telegramId, attemptNumber } },
      update: { lastActivityAt: now, lastStep: firstStep },
      create: {
        telegramId,
        attemptNumber,
        questionnaireVersion: QUESTIONNAIRE_VERSION,
        startedAt: now,
        lastActivityAt: now,
        lastStep: firstStep,
      },
    });
  } catch (error) {
    console.error(`Не удалось начать прохождение #${attemptNumber} у #${telegramId}:`, error);
  }
}

// Ответ на вопрос: двигаем последний шаг и время активности.
export async function markAttemptStep(
  telegramId: bigint,
  attemptNumber: number,
  step: number | null
): Promise<void> {
  try {
    await prisma.questionnaireAttempt.update({
      where: { telegramId_attemptNumber: { telegramId, attemptNumber } },
      data: { lastStep: step, lastActivityAt: new Date() },
    });
  } catch (error) {
    // Строки может не быть у людей, начавших анкету до выката: для них
    // прохождение заведено миграцией, но номер мог разойтись. Не
    // ломаем анкету из-за статистики.
    console.error(`Не удалось отметить шаг прохождения у #${telegramId}:`, error);
  }
}

// Анкета подтверждена.
export async function completeAttempt(
  telegramId: bigint,
  attemptNumber: number
): Promise<void> {
  try {
    const now = new Date();
    await prisma.questionnaireAttempt.update({
      where: { telegramId_attemptNumber: { telegramId, attemptNumber } },
      data: { status: "COMPLETED", completedAt: now, lastActivityAt: now },
    });
  } catch (error) {
    console.error(`Не удалось закрыть прохождение #${attemptNumber} у #${telegramId}:`, error);
  }
}
