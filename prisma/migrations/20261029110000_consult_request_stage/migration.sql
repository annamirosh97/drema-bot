-- Шаг «что хотите обсудить» перед передачей контакта и события заявки.
ALTER TYPE "Stage" ADD VALUE IF NOT EXISTS 'CONSULT_REQUEST';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'consult_card_opened';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'consult_request_started';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'consult_request_text';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'consult_request_skipped';

-- Первым родителю теперь пишет команда, а не специалист.
ALTER TYPE "FirstContact" ADD VALUE IF NOT EXISTS 'TEAM';
