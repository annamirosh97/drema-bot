-- CreateEnum
CREATE TYPE "Product" AS ENUM ('PDF');

-- CreateEnum
-- PENDING_PAYMENT, PAID и REFUNDED пока не используются: заведены заранее под оплату.
CREATE TYPE "OrderStatus" AS ENUM ('PENDING_PAYMENT', 'PAID', 'GENERATING', 'DRAFT_READY', 'SENT', 'FAILED', 'CANCELED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "OfferEventType" AS ENUM ('offer_shown', 'example_clicked', 'buy_clicked');

-- CreateTable
CREATE TABLE "Order" (
    "id" SERIAL NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "product" "Product" NOT NULL DEFAULT 'PDF',
    "priceRub" INTEGER NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'GENERATING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "failReason" TEXT,
    "yookassaPaymentId" TEXT,
    "paidAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PdfDraft" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "aiContent" JSONB NOT NULL,
    "editedContent" JSONB,
    "rawPlan" TEXT NOT NULL,
    "reviewerNotes" TEXT NOT NULL DEFAULT '',
    "planModel" TEXT NOT NULL,
    "writerModel" TEXT NOT NULL,
    "planTokensIn" INTEGER NOT NULL DEFAULT 0,
    "planTokensOut" INTEGER NOT NULL DEFAULT 0,
    "writerTokensIn" INTEGER NOT NULL DEFAULT 0,
    "writerTokensOut" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION,
    "generationCount" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "PdfDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfferEvent" (
    "id" SERIAL NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "type" "OfferEventType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfferEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Order_telegramId_idx" ON "Order"("telegramId");
CREATE INDEX "Order_status_idx" ON "Order"("status");
CREATE UNIQUE INDEX "PdfDraft_orderId_key" ON "PdfDraft"("orderId");
CREATE INDEX "OfferEvent_telegramId_idx" ON "OfferEvent"("telegramId");
CREATE INDEX "OfferEvent_type_idx" ON "OfferEvent"("type");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_telegramId_fkey" FOREIGN KEY ("telegramId") REFERENCES "Session"("telegramId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PdfDraft" ADD CONSTRAINT "PdfDraft_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OfferEvent" ADD CONSTRAINT "OfferEvent_telegramId_fkey" FOREIGN KEY ("telegramId") REFERENCES "Session"("telegramId") ON DELETE CASCADE ON UPDATE CASCADE;

-- DropTable
-- Данные fake door теста не удаляем: таблица переименована в архивную.
-- Код её больше не знает. Когда статистика пилота станет не нужна:
--   DROP TABLE "_archive_FakeDoorOffer";
ALTER TABLE "FakeDoorOffer" DROP CONSTRAINT "FakeDoorOffer_telegramId_fkey";
ALTER TABLE "FakeDoorOffer" RENAME TO "_archive_FakeDoorOffer";
