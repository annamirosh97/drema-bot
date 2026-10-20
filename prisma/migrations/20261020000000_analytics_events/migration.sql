-- Полная разметка бота событиями (tz-analytics-events.md).
--
-- Две колонки в журнале событий и 51 новый тип. Исторические записи не
-- трогаем: attempt у них остаётся NULL, потому что по старым данным
-- прохождения честно не различить, а questionNumber просто неизвестен.

ALTER TABLE "OfferEvent" ADD COLUMN "questionNumber" DOUBLE PRECISION;
ALTER TABLE "OfferEvent" ADD COLUMN "attempt" INTEGER;

-- По этим двум идут запросы воронки: по людям с прохождениями и по
-- типу события за период.
CREATE INDEX "OfferEvent_telegramId_attempt_createdAt_idx"
  ON "OfferEvent"("telegramId", "attempt", "createdAt");
CREATE INDEX "OfferEvent_type_createdAt_idx" ON "OfferEvent"("type", "createdAt");

-- Внешний ключ на Session снимаем. События пишет и бот поддержки, где
-- человека из основного бота может не быть вовсе, а журнал аналитики не
-- должен исчезать вместе с сессией. Удалять события при удалении данных
-- придётся явно — см. пометку в src/dataCommand.ts.
ALTER TABLE "OfferEvent" DROP CONSTRAINT IF EXISTS "OfferEvent_telegramId_fkey";

-- Новые типы событий. ADD VALUE внутри транзакции разрешён с PG 12.
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'onb_health_ok';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'onb_pd_granted';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'onb_pd_declined';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'onb_marketing_yes';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'onb_marketing_no';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'quiz_question_shown';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'quiz_question_answered';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'quiz_answer_invalid';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'quiz_out_of_range';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'quiz_summary_shown';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'quiz_edit_started';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'quiz_edit_question_shown';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'quiz_edit_invalid_pick';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'quiz_edit_answered';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'quiz_edit_more';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'quiz_edit_done';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'quiz_addendum_received';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'analysis_draft_created';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'analysis_sent';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'analysis_send_failed';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'buy_repeat_click';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'order_generation_started';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'order_generation_failed';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'pdf_sent';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'upsell_back';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'upsell_skipped';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'consult_contact_shared';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'consult_self_contact';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'consult_wrong_contact';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'consult_signup_duplicate';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'consult_sent_to_specialist';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'csat_rated';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'csat_feedback_left';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'menu_back_to_quiz';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'data_opened';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'marketing_unsubscribed';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'marketing_subscribed';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'pd_revoke_asked';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'pd_revoked';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'pd_revoke_cancelled';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'message_suppressed';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'support_started';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'support_ask_clicked';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'support_thread_opened';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'support_message_in';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'support_reply_out';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'support_unsupported_type';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'closed_mode_blocked';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'unrecognized_input';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'consent_write_failed';
ALTER TYPE "OfferEventType" ADD VALUE IF NOT EXISTS 'bot_blocked';
