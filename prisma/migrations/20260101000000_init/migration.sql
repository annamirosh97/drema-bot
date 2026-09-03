-- CreateEnum
CREATE TYPE "Stage" AS ENUM ('WELCOME', 'HOW_IT_WORKS', 'TERMS', 'DECLINE_REASON', 'QUESTION', 'AWAITING_RECOMMENDATION', 'FAKE_DOOR_OFFER', 'CSAT_RATING', 'CSAT_FEEDBACK', 'CSAT_DONE', 'DECLINED', 'OUT_OF_RANGE', 'RED_FLAG_ENDED');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('onboarding', 'in_progress', 'completed', 'declined', 'out_of_range', 'red_flag_ended');

-- CreateEnum
CREATE TYPE "RecommendationStatus" AS ENUM ('pending', 'sent');

-- CreateTable
CREATE TABLE "Session" (
    "id" SERIAL NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "firstName" TEXT,
    "stage" "Stage" NOT NULL DEFAULT 'WELCOME',
    "status" "SessionStatus" NOT NULL DEFAULT 'onboarding',
    "currentQuestionNumber" DOUBLE PRECISION,
    "tempSelections" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "yellowFlags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Answer" (
    "id" SERIAL NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "questionNumber" DOUBLE PRECISION NOT NULL,
    "answerText" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Answer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recommendation" (
    "id" SERIAL NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "message1" TEXT,
    "message2" TEXT,
    "message3" TEXT,
    "message4" TEXT,
    "status" "RecommendationStatus" NOT NULL DEFAULT 'pending',
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Recommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FakeDoorOffer" (
    "id" SERIAL NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "priceRub" INTEGER NOT NULL,
    "shownAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clickedAt" TIMESTAMP(3),

    CONSTRAINT "FakeDoorOffer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Session_telegramId_key" ON "Session"("telegramId");

-- CreateIndex
CREATE INDEX "Session_status_idx" ON "Session"("status");

-- CreateIndex
CREATE INDEX "Answer_telegramId_idx" ON "Answer"("telegramId");

-- CreateIndex
CREATE UNIQUE INDEX "Recommendation_telegramId_key" ON "Recommendation"("telegramId");

-- CreateIndex
CREATE UNIQUE INDEX "FakeDoorOffer_telegramId_key" ON "FakeDoorOffer"("telegramId");

-- AddForeignKey
ALTER TABLE "Answer" ADD CONSTRAINT "Answer_telegramId_fkey" FOREIGN KEY ("telegramId") REFERENCES "Session"("telegramId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_telegramId_fkey" FOREIGN KEY ("telegramId") REFERENCES "Session"("telegramId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FakeDoorOffer" ADD CONSTRAINT "FakeDoorOffer_telegramId_fkey" FOREIGN KEY ("telegramId") REFERENCES "Session"("telegramId") ON DELETE CASCADE ON UPDATE CASCADE;
