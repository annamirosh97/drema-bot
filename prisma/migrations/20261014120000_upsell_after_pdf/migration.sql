-- Предложение консультации со скидкой после покупки плана.

-- CreateEnum
CREATE TYPE "ConsultSource" AS ENUM ('OFFER', 'AFTER_PDF');

-- AlterEnum
-- Воронка предложения после PDF.
ALTER TYPE "OfferEventType" ADD VALUE 'upsell_shown';
ALTER TYPE "OfferEventType" ADD VALUE 'upsell_details';
ALTER TYPE "OfferEventType" ADD VALUE 'upsell_signup';
ALTER TYPE "OfferEventType" ADD VALUE 'upsell_declined';
ALTER TYPE "OfferEventType" ADD VALUE 'upsell_expired_click';

-- AlterTable
-- Уже существующие заявки пришли из основного оффера: значение по
-- умолчанию проставит их само.
ALTER TABLE "ConsultRequest" ADD COLUMN "source" "ConsultSource" NOT NULL DEFAULT 'OFFER';
ALTER TABLE "ConsultRequest" ADD COLUMN "orderId" INTEGER;

-- CreateTable
CREATE TABLE "UpsellOffer" (
    "id" SERIAL NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "orderId" INTEGER NOT NULL,
    "priceRub" INTEGER NOT NULL,
    "fullPriceRub" INTEGER NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "messageId" INTEGER,
    "declinedAt" TIMESTAMP(3),
    "consultRequestId" INTEGER,

    CONSTRAINT "UpsellOffer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Предложение одно на родителя, даже если планов он купил несколько.
CREATE UNIQUE INDEX "UpsellOffer_telegramId_key" ON "UpsellOffer"("telegramId");
CREATE UNIQUE INDEX "UpsellOffer_consultRequestId_key" ON "UpsellOffer"("consultRequestId");
CREATE INDEX "UpsellOffer_expiresAt_idx" ON "UpsellOffer"("expiresAt");

-- AddForeignKey
ALTER TABLE "UpsellOffer" ADD CONSTRAINT "UpsellOffer_telegramId_fkey" FOREIGN KEY ("telegramId") REFERENCES "Session"("telegramId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UpsellOffer" ADD CONSTRAINT "UpsellOffer_consultRequestId_fkey" FOREIGN KEY ("consultRequestId") REFERENCES "ConsultRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
