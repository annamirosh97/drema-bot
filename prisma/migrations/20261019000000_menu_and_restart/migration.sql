-- Меню бота и перезапуск анкеты (TZ_menu.md).
--
-- Главное здесь — номер прохождения. До сих пор у человека мог быть
-- только один набор ответов и один разбор: /reset просто удалял
-- прошлые. Теперь прохождения нумеруются, старые строки остаются в
-- базе, а в новый разбор попадают только ответы текущего прохождения.
--
-- Всем существующим строкам ставим прохождение 1: у них оно и есть
-- первое, и после миграции бот читает ровно те же данные, что читал до
-- неё.

-- Номер текущего прохождения у человека.
ALTER TABLE "Session" ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 1;

-- К какому прохождению относится ответ.
ALTER TABLE "Answer" ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 1;
CREATE INDEX "Answer_telegramId_attempt_idx" ON "Answer"("telegramId", "attempt");

-- Разбор тоже привязывается к прохождению. Уникальным становится не
-- сам telegramId, а пара с номером: иначе новый разбор затёр бы
-- прошлый, а он должен остаться.
ALTER TABLE "Recommendation" ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Recommendation" ADD COLUMN "cancelReason" TEXT;
ALTER TABLE "Recommendation" ADD COLUMN "cancelledAt" TIMESTAMP(3);

DROP INDEX IF EXISTS "Recommendation_telegramId_key";
CREATE UNIQUE INDEX "Recommendation_telegramId_attempt_key"
  ON "Recommendation"("telegramId", "attempt");
CREATE INDEX "Recommendation_telegramId_idx" ON "Recommendation"("telegramId");

-- Заказ плана и заявка на консультацию тоже помнят своё прохождение:
-- п.3 ТЗ требует, чтобы они остались привязаны к прежнему разбору.
-- Человек заплатил за разбор, который прочитал, и начатая заново
-- анкета не должна подменить то, по чему собирается его план.
ALTER TABLE "Order" ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ConsultRequest" ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 1;

-- Отменённый разбор: лежит в базе, но не отправляется и не ждёт
-- проверки. ADD VALUE внутри транзакции разрешён с PostgreSQL 12.
ALTER TYPE "RecommendationStatus" ADD VALUE IF NOT EXISTS 'cancelled';

-- События меню для /stats.
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'menu_opened';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'menu_support';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'menu_docs';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'menu_team';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'restart_asked';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'restart_confirmed';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'restart_confirmed_cancelled_draft';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'restart_cancelled';
