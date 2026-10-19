-- Напоминания о незаконченной анкете (TZ_quiz_reminders.md).
--
-- Одна строка на прохождение анкеты. Существующим людям строки не
-- создаём: напоминания начнут работать с тех, кто дойдёт до первого
-- вопроса после выката. Задним числом напоминать тому, кто бросил
-- анкету месяц назад, незачем — для него это сообщение из ниоткуда.

CREATE TABLE "QuizReminder" (
  "id" SERIAL NOT NULL,
  "telegramId" BIGINT NOT NULL,
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reminder1ScheduledAt" TIMESTAMP(3),
  "reminder1SentAt" TIMESTAMP(3),
  "reminder1QuestionNumber" DOUBLE PRECISION,
  "reminder2ScheduledAt" TIMESTAMP(3),
  "reminder2SentAt" TIMESTAMP(3),
  "reminder2Cancelled" BOOLEAN NOT NULL DEFAULT false,
  "remindersStoppedReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "QuizReminder_pkey" PRIMARY KEY ("id")
);

-- Одно прохождение — одна строка.
CREATE UNIQUE INDEX "QuizReminder_telegramId_attempt_key"
  ON "QuizReminder"("telegramId", "attempt");

-- По этим двум планировщик выбирает, кому пора напомнить.
CREATE INDEX "QuizReminder_reminder1ScheduledAt_idx" ON "QuizReminder"("reminder1ScheduledAt");
CREATE INDEX "QuizReminder_reminder2ScheduledAt_idx" ON "QuizReminder"("reminder2ScheduledAt");

ALTER TABLE "QuizReminder" ADD CONSTRAINT "QuizReminder_telegramId_fkey"
  FOREIGN KEY ("telegramId") REFERENCES "Session"("telegramId")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- События для /stats.
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'quiz_reminder_1_sent';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'quiz_reminder_2_sent';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'quiz_reminder_continue_click';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'quiz_reminder_cancelled';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'quiz_resumed_after_reminder_1';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'quiz_resumed_after_reminder_2';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'quiz_completed_after_reminder';
