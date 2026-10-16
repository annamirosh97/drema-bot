-- Подавленные сообщения: что бот не отправил из-за отсутствия согласия.

-- CreateTable
CREATE TABLE "SuppressedMessage" (
    "id" SERIAL NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "category" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuppressedMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SuppressedMessage_telegramId_idx" ON "SuppressedMessage"("telegramId");
CREATE INDEX "SuppressedMessage_createdAt_idx" ON "SuppressedMessage"("createdAt");
