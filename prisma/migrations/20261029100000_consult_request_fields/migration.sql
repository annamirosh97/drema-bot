-- Заявка на консультацию вместо записи с оплатой: запрос родителя,
-- причина отказа и даты новых статусов.
--
-- Новые значения enum добавляются отдельной миграцией от переноса
-- строк: PostgreSQL не даёт использовать значение в той же
-- транзакции, в которой оно добавлено, а Prisma выполняет файл
-- миграции транзакцией.
ALTER TYPE "ConsultStatus" ADD VALUE IF NOT EXISTS 'CHAT_CREATED';
ALTER TYPE "ConsultStatus" ADD VALUE IF NOT EXISTS 'LOST';

ALTER TABLE "ConsultRequest" ADD COLUMN IF NOT EXISTS "requestText" TEXT;
ALTER TABLE "ConsultRequest" ADD COLUMN IF NOT EXISTS "lostReason" TEXT;
ALTER TABLE "ConsultRequest" ADD COLUMN IF NOT EXISTS "chatCreatedAt" TIMESTAMP(3);
ALTER TABLE "ConsultRequest" ADD COLUMN IF NOT EXISTS "lostAt" TIMESTAMP(3);
