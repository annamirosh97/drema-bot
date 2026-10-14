-- Журнал согласий: версии документов и записи действий пользователя.

-- AlterEnum
-- Два новых экрана онбординга между «Условиями» и анкетой.
ALTER TYPE "Stage" ADD VALUE 'PD_CONSENT';
ALTER TYPE "Stage" ADD VALUE 'MARKETING_CONSENT';

-- AlterTable
-- Куда вернуть тех, кому согласия показываются посреди сценария.
ALTER TABLE "Session" ADD COLUMN "resumeStage" "Stage";

-- CreateEnum
CREATE TYPE "LegalDocType" AS ENUM ('PRIVACY_POLICY', 'PD_CONSENT', 'MARKETING_CONSENT', 'OFFER');
CREATE TYPE "ConsentType" AS ENUM ('PD_PROCESSING', 'MARKETING', 'OFFER_ACCEPTANCE', 'SPECIALIST_TRANSFER');
CREATE TYPE "ConsentAction" AS ENUM ('GRANTED', 'DECLINED', 'REVOKED');
CREATE TYPE "ConsentSource" AS ENUM ('ONBOARDING', 'PURCHASE_PDF', 'CONSULT_SIGNUP', 'UPSELL', 'DATA_COMMAND', 'UNSUBSCRIBE_COMMAND', 'ADMIN');

-- CreateTable
CREATE TABLE "LegalDocument" (
    "id" SERIAL NOT NULL,
    "type" "LegalDocType" NOT NULL,
    "version" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegalDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- Внешнего ключа на Session нет намеренно: журнал должен пережить
-- удаление данных пользователя, а каскад унёс бы его вместе с сессией.
CREATE TABLE "ConsentRecord" (
    "id" SERIAL NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "type" "ConsentType" NOT NULL,
    "action" "ConsentAction" NOT NULL,
    "source" "ConsentSource" NOT NULL,
    "documentIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "messageText" TEXT NOT NULL,
    "buttonText" TEXT NOT NULL,
    "telegramMessageId" INTEGER,
    "relatedOrderId" INTEGER,
    "relatedConsultRequestId" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LegalDocument_type_version_key" ON "LegalDocument"("type", "version");
CREATE INDEX "LegalDocument_type_effectiveFrom_idx" ON "LegalDocument"("type", "effectiveFrom");
CREATE INDEX "ConsentRecord_telegramId_type_createdAt_idx" ON "ConsentRecord"("telegramId", "type", "createdAt");
CREATE INDEX "ConsentRecord_type_action_idx" ON "ConsentRecord"("type", "action");

-- Журнал только пополняется.
--
-- Это не перестраховка: запись согласия — доказательство, и «мы просто
-- не пишем update в коде» здесь недостаточно. Триггер делает правку и
-- удаление невозможными для любого, кто работает с этой базой, включая
-- будущий код, админку и ручной psql.
--
-- Если когда-нибудь понадобится удалить журнал по-настоящему (например,
-- по требованию регулятора), триггер придётся сначала снять руками —
-- и это будет осознанное действие, а не случайность.
CREATE OR REPLACE FUNCTION "consent_record_is_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ConsentRecord — журнал согласий: записи нельзя менять и удалять (операция %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "consent_record_no_update"
  BEFORE UPDATE ON "ConsentRecord"
  FOR EACH ROW EXECUTE FUNCTION "consent_record_is_append_only"();

CREATE TRIGGER "consent_record_no_delete"
  BEFORE DELETE ON "ConsentRecord"
  FOR EACH ROW EXECUTE FUNCTION "consent_record_is_append_only"();
