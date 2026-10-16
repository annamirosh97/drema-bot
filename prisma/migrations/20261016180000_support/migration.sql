-- Бот поддержки: темы в закрытой группе и копия переписки.

-- CreateEnum
CREATE TYPE "SupportStatus" AS ENUM ('WAITING', 'ANSWERED', 'CLOSED');
CREATE TYPE "SupportDirection" AS ENUM ('IN', 'OUT', 'NOTE');

-- CreateTable
CREATE TABLE "SupportThread" (
    "id" SERIAL NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "topicId" INTEGER,
    "status" "SupportStatus" NOT NULL DEFAULT 'WAITING',
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUserMessageAt" TIMESTAMP(3),
    "lastSupportMessageAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "SupportThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportMessage" (
    "id" SERIAL NOT NULL,
    "threadId" INTEGER NOT NULL,
    "direction" "SupportDirection" NOT NULL,
    "authorTelegramId" BIGINT NOT NULL,
    "type" TEXT NOT NULL,
    "text" TEXT,
    "fileId" TEXT,
    "userMessageId" INTEGER,
    "groupMessageId" INTEGER,
    "deliveryError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupportThread_telegramId_key" ON "SupportThread"("telegramId");
CREATE INDEX "SupportThread_status_idx" ON "SupportThread"("status");
CREATE INDEX "SupportMessage_threadId_idx" ON "SupportMessage"("threadId");

-- AddForeignKey
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "SupportThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
