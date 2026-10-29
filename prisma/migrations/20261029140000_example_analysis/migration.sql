-- Пример разбора: откуда его открыли, нужно четырём событиям сразу,
-- поэтому источник — колонка, а не три отдельных типа событий.
ALTER TABLE "OfferEvent" ADD COLUMN IF NOT EXISTS "source" TEXT;

ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'example_analysis_opened';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'example_plan_opened';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'example_cta_get_analysis';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'example_how_it_works';
