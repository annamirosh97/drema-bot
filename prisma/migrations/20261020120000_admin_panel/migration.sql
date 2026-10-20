-- Админка: поля родителя, прохождения анкеты, журнал действий.
-- ТЗ админки Дрёмы, этап 1.

-- ── Поля родителя ───────────────────────────────────────────────────
ALTER TABLE "Session" ADD COLUMN "username" TEXT;
ALTER TABLE "Session" ADD COLUMN "source" TEXT;
ALTER TABLE "Session" ADD COLUMN "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Session" ADD COLUMN "adminNote" TEXT;
ALTER TABLE "Session" ADD COLUMN "botBlockedAt" TIMESTAMP(3);
ALTER TABLE "Session" ADD COLUMN "deletionRequestedAt" TIMESTAMP(3);

-- username до сих пор хранился только в заявке на консультацию.
-- Переносим последний известный: это единственный источник, который у
-- нас есть, и для остальных поле останется пустым до следующего входа.
UPDATE "Session" s
SET "username" = c."parentUsername"
FROM (
  SELECT DISTINCT ON ("telegramId") "telegramId", "parentUsername"
  FROM "ConsultRequest"
  WHERE "parentUsername" IS NOT NULL
  ORDER BY "telegramId", "createdAt" DESC
) c
WHERE c."telegramId" = s."telegramId";

-- ── Таймер и ошибка доставки у бесплатного разбора ──────────────────
ALTER TABLE "Recommendation" ADD COLUMN "waitStartedAt" TIMESTAMP(3);
ALTER TABLE "Recommendation" ADD COLUMN "deliveryError" TEXT;

-- У существующих разборов таймер считаем от создания строки: она
-- создаётся при завершении анкеты, то есть ровно тогда, когда родитель
-- начал ждать.
UPDATE "Recommendation" SET "waitStartedAt" = "createdAt" WHERE "waitStartedAt" IS NULL;

-- ── Чек и ошибка доставки у заказа ──────────────────────────────────
CREATE TYPE "ReceiptStatus" AS ENUM ('NOT_NEEDED', 'PENDING', 'ISSUED');
ALTER TABLE "Order" ADD COLUMN "receiptStatus" "ReceiptStatus" NOT NULL DEFAULT 'NOT_NEEDED';
ALTER TABLE "Order" ADD COLUMN "receiptUrl" TEXT;
ALTER TABLE "Order" ADD COLUMN "deliveryError" TEXT;

-- Оплаченные заказы ждут чека. Пока оплата не подключена, таких нет,
-- но если появятся из ручной отметки — они сразу попадут в очередь.
UPDATE "Order" SET "receiptStatus" = 'PENDING' WHERE "paidAt" IS NOT NULL;

-- ── Дневник и выплата по консультации ───────────────────────────────
ALTER TABLE "ConsultRequest" ADD COLUMN "diaryReceived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ConsultRequest" ADD COLUMN "consultantPayoutRub" INTEGER;
ALTER TABLE "ConsultRequest" ADD COLUMN "payoutPaidAt" TIMESTAMP(3);
ALTER TABLE "ConsultRequest" ADD COLUMN "note" TEXT;

-- ── Прохождения анкеты ──────────────────────────────────────────────
CREATE TYPE "AttemptStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED');

CREATE TABLE "QuestionnaireAttempt" (
  "id" SERIAL NOT NULL,
  "telegramId" BIGINT NOT NULL,
  "attemptNumber" INTEGER NOT NULL,
  "questionnaireVersion" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "lastStep" DOUBLE PRECISION,
  "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status" "AttemptStatus" NOT NULL DEFAULT 'IN_PROGRESS',

  CONSTRAINT "QuestionnaireAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "QuestionnaireAttempt_telegramId_attemptNumber_key"
  ON "QuestionnaireAttempt"("telegramId", "attemptNumber");
CREATE INDEX "QuestionnaireAttempt_status_lastActivityAt_idx"
  ON "QuestionnaireAttempt"("status", "lastActivityAt");

ALTER TABLE "QuestionnaireAttempt" ADD CONSTRAINT "QuestionnaireAttempt_telegramId_fkey"
  FOREIGN KEY ("telegramId") REFERENCES "Session"("telegramId")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Переносим существующие прохождения.
--
-- Честно переносится только текущее: у человека с Session.attempt = 3
-- в базе нет ни начала, ни последнего шага первых двух прохождений, и
-- выдумывать их нельзя. Поэтому заводим одну строку на сессию с её
-- текущим номером.
--
-- startedAt берём от создания сессии, lastActivityAt — от её
-- обновления, lastStep — текущий вопрос. Для завершённых анкет
-- completedAt берём от разбора того же прохождения: он создаётся ровно
-- в момент подтверждения анкеты.
--
-- Версию анкеты у исторических прохождений пишем 'legacy': какие были
-- вопросы на тот момент, по базе не восстановить.
INSERT INTO "QuestionnaireAttempt"
  ("telegramId", "attemptNumber", "questionnaireVersion",
   "startedAt", "completedAt", "lastStep", "lastActivityAt", "status")
SELECT s."telegramId",
       s."attempt",
       'legacy',
       s."createdAt",
       r."createdAt",
       s."currentQuestionNumber",
       s."updatedAt",
       CASE WHEN r."id" IS NOT NULL THEN 'COMPLETED'::"AttemptStatus"
            ELSE 'IN_PROGRESS'::"AttemptStatus" END
FROM "Session" s
LEFT JOIN "Recommendation" r
  ON r."telegramId" = s."telegramId" AND r."attempt" = s."attempt"
ON CONFLICT ("telegramId", "attemptNumber") DO NOTHING;

-- ── Журнал действий админа ──────────────────────────────────────────
CREATE TABLE "AdminAction" (
  "id" SERIAL NOT NULL,
  "adminId" BIGINT NOT NULL,
  "action" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "diff" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AdminAction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminAction_createdAt_idx" ON "AdminAction"("createdAt");
CREATE INDEX "AdminAction_entityType_entityId_idx" ON "AdminAction"("entityType", "entityId");
CREATE INDEX "AdminAction_adminId_idx" ON "AdminAction"("adminId");
