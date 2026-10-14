-- Оффер с двумя продуктами: план в PDF и консультация специалиста.

-- AlterEnum
-- Стадия, в которой родитель уже записался на консультацию, но ещё не
-- решил, передавать ли контакт специалисту.
ALTER TYPE "Stage" ADD VALUE 'CONSULT_CONSENT';

-- AlterEnum
-- Новые события воронки оффера. Прежние три значения остаются как есть:
-- на них держится статистика уже собранных показов.
ALTER TYPE "OfferEventType" ADD VALUE 'offer_pdf_details';
ALTER TYPE "OfferEventType" ADD VALUE 'offer_consult_details';
ALTER TYPE "OfferEventType" ADD VALUE 'offer_back';
ALTER TYPE "OfferEventType" ADD VALUE 'consult_signup';
ALTER TYPE "OfferEventType" ADD VALUE 'offer_declined';

-- CreateEnum
-- PENDING_PAYMENT и PAID пока не используются: заведены заранее под оплату.
CREATE TYPE "ConsultStatus" AS ENUM ('PENDING_PAYMENT', 'PAID', 'NEW', 'CONTACTED', 'DONE', 'CANCELED');

-- CreateEnum
CREATE TYPE "FirstContact" AS ENUM ('PENDING', 'SPECIALIST', 'PARENT');

-- CreateTable
CREATE TABLE "ConsultRequest" (
    "id" SERIAL NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "priceRub" INTEGER NOT NULL,
    "status" "ConsultStatus" NOT NULL DEFAULT 'NEW',
    "parentUsername" TEXT,
    "parentPhone" TEXT,
    "contactConsentAt" TIMESTAMP(3),
    "firstContact" "FirstContact" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contactedAt" TIMESTAMP(3),
    "doneAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "yookassaPaymentId" TEXT,
    "paidAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),

    CONSTRAINT "ConsultRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConsultRequest_telegramId_idx" ON "ConsultRequest"("telegramId");
CREATE INDEX "ConsultRequest_status_idx" ON "ConsultRequest"("status");

-- AddForeignKey
ALTER TABLE "ConsultRequest" ADD CONSTRAINT "ConsultRequest_telegramId_fkey" FOREIGN KEY ("telegramId") REFERENCES "Session"("telegramId") ON DELETE CASCADE ON UPDATE CASCADE;
