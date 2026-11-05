-- Оценка плана от 1 до 5 через сутки после отправки файла.
--
-- Отдельная таблица, а не колонки в PdfFeedback: там вопрос про
-- результат через неделю, у него свой срок, свои пропуски и свой ответ.
CREATE TABLE "PdfRating" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "askedAt" TIMESTAMP(3),
    "rating" INTEGER,
    "comment" TEXT,
    "skippedComment" BOOLEAN NOT NULL DEFAULT false,
    "answeredAt" TIMESTAMP(3),
    "promptMessageId" INTEGER,
    "skipReason" TEXT,
    "limitDeferred" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PdfRating_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PdfRating_orderId_key" ON "PdfRating"("orderId");
CREATE INDEX "PdfRating_telegramId_idx" ON "PdfRating"("telegramId");
CREATE INDEX "PdfRating_askedAt_idx" ON "PdfRating"("askedAt");
CREATE INDEX "PdfRating_scheduledAt_idx" ON "PdfRating"("scheduledAt");

ALTER TABLE "PdfRating" ADD CONSTRAINT "PdfRating_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
