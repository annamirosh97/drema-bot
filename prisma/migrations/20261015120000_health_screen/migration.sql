-- Экран самоподтверждения о здоровье малыша вместо вопросов о здоровье.

-- AlterEnum
-- Новый шаг онбординга между «Условиями» и согласием на обработку данных.
ALTER TYPE "Stage" ADD VALUE 'HEALTH_SCREEN';

-- AlterEnum
-- Родитель сам подтвердил, что особенностей здоровья нет. Документа за
-- этим подтверждением не стоит — documentIds у таких записей пустой.
ALTER TYPE "ConsentType" ADD VALUE 'HEALTH_SELF_DECLARATION';

-- CreateTable
-- Обезличенный счётчик по дням: считать можно, знать кто — нельзя.
-- Ни telegram id, ни внешнего ключа здесь нет намеренно.
CREATE TABLE "DailyCounter" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DailyCounter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DailyCounter_name_day_key" ON "DailyCounter"("name", "day");
