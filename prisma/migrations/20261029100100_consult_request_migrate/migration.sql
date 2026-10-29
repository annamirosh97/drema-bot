-- Перенос существующих заявок на новые статусы.
--
-- CANCELED — это те же «не дошли до оплаты», причина теперь хранится
-- явно; у перенесённых её не узнать, поэтому «другое». Дату берём из
-- canceledAt: сама отмена была тогда же.
UPDATE "ConsultRequest"
SET status = 'LOST',
    "lostReason" = 'другое',
    "lostAt" = COALESCE("canceledAt", "createdAt")
WHERE status = 'CANCELED';

-- Задел под оплату в боте не пригодился: такие заявки ещё ждут
-- первого сообщения команды.
UPDATE "ConsultRequest" SET status = 'NEW' WHERE status = 'PENDING_PAYMENT';
