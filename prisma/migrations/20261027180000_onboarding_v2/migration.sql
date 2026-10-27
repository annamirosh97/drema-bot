-- Новый онбординг: экран «три шага» вместо «что я получу» в основном
-- пути. Прежняя стадия WELCOME_VALUE остаётся: в чатах висят кнопки со
-- старых сообщений, и они должны работать.
--
-- IF NOT EXISTS и отдельными командами: ALTER TYPE ... ADD VALUE нельзя
-- выполнять в одной транзакции с использованием значения.
ALTER TYPE "Stage" ADD VALUE IF NOT EXISTS 'STEPS';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'onb_steps';
