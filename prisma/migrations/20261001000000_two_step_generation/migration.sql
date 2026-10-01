-- AlterTable
-- Блок ВЫВОДЫ из первого вызова Claude API.
ALTER TABLE "Recommendation" ADD COLUMN "analysis" TEXT;

-- CreateTable
-- Токены, время и стоимость каждого обращения к Claude API.
CREATE TABLE "ApiCall" (
    "id" SERIAL NOT NULL,
    "step" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "cacheCreationTokens" INTEGER NOT NULL,
    "cacheReadTokens" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "stopReason" TEXT,
    "costUsd" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApiCall_createdAt_idx" ON "ApiCall"("createdAt");
