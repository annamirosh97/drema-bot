-- Новые значения перечисления событий: оценка плана от 1 до 5.
--
-- Отдельным файлом от таблицы, которая их использует: Prisma выполняет
-- миграцию одной транзакцией, а Postgres не даёт пользоваться только
-- что добавленным значением enum внутри той же транзакции.
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'pdf_rating_scheduled';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'pdf_rating_asked';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'pdf_rating_skipped';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'pdf_rating_rated';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'pdf_rating_comment';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'pdf_rating_comment_skipped';
