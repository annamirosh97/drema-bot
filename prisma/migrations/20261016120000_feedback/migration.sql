-- Два отложенных вопроса обратной связи: оценка разбора через сутки и
-- результат плана через неделю.

-- AlterEnum
ALTER TYPE "OfferEventType" ADD VALUE 'csat_asked';
ALTER TYPE "OfferEventType" ADD VALUE 'analysis_feedback_scheduled';
ALTER TYPE "OfferEventType" ADD VALUE 'analysis_feedback_asked';
ALTER TYPE "OfferEventType" ADD VALUE 'analysis_feedback_skipped';
ALTER TYPE "OfferEventType" ADD VALUE 'analysis_feedback_rated';
ALTER TYPE "OfferEventType" ADD VALUE 'analysis_feedback_comment';
ALTER TYPE "OfferEventType" ADD VALUE 'analysis_feedback_comment_skipped';
ALTER TYPE "OfferEventType" ADD VALUE 'pdf_feedback_scheduled';
ALTER TYPE "OfferEventType" ADD VALUE 'pdf_feedback_asked';
ALTER TYPE "OfferEventType" ADD VALUE 'pdf_feedback_skipped';
ALTER TYPE "OfferEventType" ADD VALUE 'pdf_feedback_answered';
ALTER TYPE "OfferEventType" ADD VALUE 'pdf_feedback_comment';
ALTER TYPE "OfferEventType" ADD VALUE 'pdf_feedback_comment_skipped';

-- CreateEnum
CREATE TYPE "AnalysisRating" AS ENUM ('YES', 'PARTLY', 'NO');
CREATE TYPE "PdfResult" AS ENUM ('BETTER', 'SAME', 'WORSE', 'NOT_STARTED');

-- CreateTable
CREATE TABLE "AnalysisFeedback" (
    "id" SERIAL NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "askedAt" TIMESTAMP(3),
    "rating" "AnalysisRating",
    "comment" TEXT,
    "skippedComment" BOOLEAN NOT NULL DEFAULT false,
    "answeredAt" TIMESTAMP(3),
    "skipReason" TEXT,
    "limitDeferred" BOOLEAN NOT NULL DEFAULT false,
    "promptMessageId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalysisFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PdfFeedback" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "askedAt" TIMESTAMP(3),
    "result" "PdfResult",
    "comment" TEXT,
    "skippedComment" BOOLEAN NOT NULL DEFAULT false,
    "answeredAt" TIMESTAMP(3),
    "skipReason" TEXT,
    "limitDeferred" BOOLEAN NOT NULL DEFAULT false,
    "promptMessageId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PdfFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisFeedback_telegramId_key" ON "AnalysisFeedback"("telegramId");
CREATE INDEX "AnalysisFeedback_askedAt_idx" ON "AnalysisFeedback"("askedAt");
CREATE INDEX "AnalysisFeedback_scheduledAt_idx" ON "AnalysisFeedback"("scheduledAt");
CREATE UNIQUE INDEX "PdfFeedback_orderId_key" ON "PdfFeedback"("orderId");
CREATE INDEX "PdfFeedback_telegramId_idx" ON "PdfFeedback"("telegramId");
CREATE INDEX "PdfFeedback_askedAt_idx" ON "PdfFeedback"("askedAt");
CREATE INDEX "PdfFeedback_scheduledAt_idx" ON "PdfFeedback"("scheduledAt");

-- AddForeignKey
ALTER TABLE "PdfFeedback" ADD CONSTRAINT "PdfFeedback_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
