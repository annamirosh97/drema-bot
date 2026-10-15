-- Приветствие в два шага и воронка онбординга.

-- AlterEnum
-- Второй шаг приветствия: «что вы получите» с кнопками «Начать» и
-- «Как я работаю».
ALTER TYPE "Stage" ADD VALUE 'WELCOME_VALUE';

-- AlterEnum
-- По событию на каждый экран онбординга плюс отправка гида. Пишутся
-- один раз на человека, в /stats считаются по уникальным людям.
ALTER TYPE "OfferEventType" ADD VALUE 'onb_welcome';
ALTER TYPE "OfferEventType" ADD VALUE 'onb_welcome_value';
ALTER TYPE "OfferEventType" ADD VALUE 'onb_how_it_works';
ALTER TYPE "OfferEventType" ADD VALUE 'onb_terms';
ALTER TYPE "OfferEventType" ADD VALUE 'onb_health';
ALTER TYPE "OfferEventType" ADD VALUE 'onb_pd_consent';
ALTER TYPE "OfferEventType" ADD VALUE 'onb_marketing';
ALTER TYPE "OfferEventType" ADD VALUE 'onb_go';
ALTER TYPE "OfferEventType" ADD VALUE 'quiz_q1';
ALTER TYPE "OfferEventType" ADD VALUE 'quiz_completed';
ALTER TYPE "OfferEventType" ADD VALUE 'guide_sent';
