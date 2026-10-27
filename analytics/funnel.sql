-- Воронка родителя по журналу событий (таблица OfferEvent).
--
-- Запросы готовы к запуску в psql на базе Railway. Перед запуском нужно
-- подставить два параметра:
--
--   :internal_ids — свои аккаунты из INTERNAL_TELEGRAM_IDS, массивом
--                   bigint: ARRAY[123456789]::bigint[]. Если своих нет,
--                   передать пустой массив: ARRAY[]::bigint[].
--
-- Прохождения считаются только по событиям с attempt IS NOT NULL: у
-- записей, сделанных до 20.10.2026, прохождения не различить, и
-- смешивать их с новыми нельзя — воронка соврёт.
--
-- Везде, где считаются люди, стоит DISTINCT: событие пишется каждый
-- раз, когда шаг происходит, и один человек даёт несколько записей.


-- ── 1. Основная воронка: по прохождениям и по людям ─────────────────
--
-- attempts — сколько прохождений дошло до шага, people — сколько людей.
-- Разница между ними и есть вклад тех, кто начинал заново.

WITH steps(ord, step, types) AS (VALUES
  (1,  'start',            ARRAY['onb_welcome']),
  (2,  'terms',            ARRAY['onb_terms']),
  (3,  'health_ok',        ARRAY['onb_health_ok']),
  (4,  'pd_granted',       ARRAY['onb_pd_granted']),
  (5,  'quiz_started',     ARRAY['onb_go']),
  (6,  'quiz_completed',   ARRAY['quiz_completed']),
  (7,  'analysis_sent',    ARRAY['analysis_sent']),
  (8,  'offer_shown',      ARRAY['offer_shown']),
  (9,  'buy_or_consult',   ARRAY['buy_clicked','consult_signup','upsell_signup']),
  (10, 'pdf_sent',         ARRAY['pdf_sent']),
  (11, 'consult_contact',  ARRAY['consult_contact_shared','consult_self_contact'])
)
SELECT s.ord,
       s.step,
       COUNT(DISTINCT (e."telegramId", e.attempt)) AS attempts,
       COUNT(DISTINCT e."telegramId")              AS people
FROM steps s
LEFT JOIN "OfferEvent" e
  ON e.type::text = ANY(s.types)
 AND e.attempt IS NOT NULL
 AND e."telegramId" <> ALL(:internal_ids)
GROUP BY s.ord, s.step
ORDER BY s.ord;


-- ── 2. Отвал по вопросам анкеты ─────────────────────────────────────
--
-- Для каждого прохождения, где анкета начата но не завершена, берём
-- последний показанный вопрос. Порядок вопросов задан явно: вопрос 4.5
-- условный (показывается только при ответе «Другая проблема»), и по
-- номеру его место в анкете не угадать.
--
-- Отсекаем последние сутки: человек, остановившийся час назад, ещё
-- может вернуться, и считать его отвалом рано.

WITH q_order(qn, ord) AS (VALUES
  (1,1),(2,2),(3,3),(4,4),(4.5,5),(5,6),(6,7),(7,8),(8,9),(9,10),
  (10,11),(11,12),(12,13),(13,14),(14,15),(15,16),(16,17),(17,18),(21,19)
),
started AS (
  SELECT DISTINCT "telegramId", attempt
  FROM "OfferEvent"
  WHERE type = 'quiz_question_shown' AND attempt IS NOT NULL
),
completed AS (
  SELECT DISTINCT "telegramId", attempt
  FROM "OfferEvent"
  WHERE type = 'quiz_completed' AND attempt IS NOT NULL
),
last_shown AS (
  SELECT DISTINCT ON (e."telegramId", e.attempt)
         e."telegramId", e.attempt, e."questionNumber", e."createdAt"
  FROM "OfferEvent" e
  WHERE e.type = 'quiz_question_shown' AND e.attempt IS NOT NULL
  ORDER BY e."telegramId", e.attempt, e."createdAt" DESC
)
SELECT o.ord,
       l."questionNumber",
       COUNT(*) AS dropped_attempts
FROM last_shown l
JOIN started s USING ("telegramId", attempt)
LEFT JOIN completed c USING ("telegramId", attempt)
JOIN q_order o ON o.qn = l."questionNumber"
WHERE c."telegramId" IS NULL
  AND l."telegramId" <> ALL(:internal_ids)
  AND l."createdAt" < now() - interval '24 hours'
GROUP BY o.ord, l."questionNumber"
ORDER BY o.ord;


-- ── 3. Где каждый человек сейчас ────────────────────────────────────
--
-- Последнее событие текущего прохождения, стадия сессии и сколько
-- человек молчит. Добавить «AND now() - e."createdAt" > interval '24
-- hours'» в WHERE — получится список зависших.

SELECT DISTINCT ON (e."telegramId")
       e."telegramId",
       s.attempt,
       s.stage,
       e.type               AS last_event,
       e."questionNumber",
       e."createdAt"        AS last_event_at,
       now() - e."createdAt" AS idle_for
FROM "OfferEvent" e
JOIN "Session" s
  ON s."telegramId" = e."telegramId"
 AND s.attempt = e.attempt
WHERE e."telegramId" <> ALL(:internal_ids)
ORDER BY e."telegramId", e."createdAt" DESC;


-- ── 4. Какие вопросы непонятны ──────────────────────────────────────
--
-- Сколько раз на вопросе отвечали не так, как ждёт бот: не числом,
-- текстом вместо кнопки, нажатием не той кнопки.

SELECT "questionNumber",
       COUNT(*)                        AS invalid_answers,
       COUNT(DISTINCT "telegramId")    AS people
FROM "OfferEvent"
WHERE type = 'quiz_answer_invalid'
  AND attempt IS NOT NULL
  AND "telegramId" <> ALL(:internal_ids)
GROUP BY "questionNumber"
ORDER BY invalid_answers DESC;


-- ── 5. Куда возвращаются ────────────────────────────────────────────
--
-- Вопрос, показанный внутри одного прохождения больше одного раза:
-- человек уходил в меню, получал напоминание или набирал команду.
-- Источник возврата видно по соседнему событию (menu_back_to_quiz,
-- quiz_reminder_continue_click).

SELECT "questionNumber",
       COUNT(*) AS repeated_shows
FROM (
  SELECT "telegramId", attempt, "questionNumber", COUNT(*) AS shows
  FROM "OfferEvent"
  WHERE type = 'quiz_question_shown'
    AND attempt IS NOT NULL
    AND "telegramId" <> ALL(:internal_ids)
  GROUP BY "telegramId", attempt, "questionNumber"
) t
WHERE shows > 1
GROUP BY "questionNumber"
ORDER BY repeated_shows DESC;


-- ── 6. Какие ответы чаще исправляют ─────────────────────────────────

SELECT "questionNumber",
       COUNT(*)                     AS edits,
       COUNT(DISTINCT "telegramId") AS people
FROM "OfferEvent"
WHERE type = 'quiz_edit_answered'
  AND attempt IS NOT NULL
  AND "telegramId" <> ALL(:internal_ids)
GROUP BY "questionNumber"
ORDER BY edits DESC;


-- ── 7. Необязательные экраны онбординга ─────────────────────────────
--
-- Основной путь с 27.10.2026: приветствие → «Прежде чем начать». Эти
-- два экрана в него не входят, человек заходит на них сам, и доля
-- заходов показывает, многим ли коротких обещаний приветствия мало.
--
-- onb_welcome_value — прежний экран «Что я получу?». В основном пути
-- его больше нет, остались только кнопки под старыми сообщениями;
-- ненулевые значения здесь — это легаси, а не новый трафик.

SELECT step,
       COUNT(DISTINCT (e."telegramId", e.attempt)) AS attempts,
       COUNT(DISTINCT e."telegramId")              AS people
FROM (VALUES
  ('welcome',       'onb_welcome'),
  ('steps',         'onb_steps'),
  ('how_it_works',  'onb_how_it_works'),
  ('welcome_value (легаси)', 'onb_welcome_value')
) AS s(step, type)
JOIN "OfferEvent" e ON e.type = s.type::"OfferEventType"
WHERE e.attempt IS NOT NULL
  AND e."telegramId" <> ALL(:internal_ids)
GROUP BY step
ORDER BY people DESC;


-- ── 8. Согласие на рассылку ─────────────────────────────────────────
--
-- С 27.10.2026 вопрос задаётся после анкеты, вместе с гайдом, а не в
-- онбординге. Считаем долю согласившихся среди тех, кому вопрос
-- показали: до переноса знаменателем был весь онбординг, и цифры до и
-- после сравнивать нельзя.
--
-- Вопрос задаётся один раз в жизни, поэтому здесь нет attempt и нет
-- DISTINCT по прохождениям — только люди.

SELECT COUNT(DISTINCT CASE WHEN type = 'onb_marketing'     THEN "telegramId" END) AS asked,
       COUNT(DISTINCT CASE WHEN type = 'onb_marketing_yes' THEN "telegramId" END) AS granted,
       COUNT(DISTINCT CASE WHEN type = 'onb_marketing_no'  THEN "telegramId" END) AS declined,
       ROUND(
         100.0 * COUNT(DISTINCT CASE WHEN type = 'onb_marketing_yes' THEN "telegramId" END)
         / NULLIF(COUNT(DISTINCT CASE WHEN type = 'onb_marketing' THEN "telegramId" END), 0),
         1
       ) AS granted_pct
FROM "OfferEvent"
WHERE type IN ('onb_marketing', 'onb_marketing_yes', 'onb_marketing_no')
  AND "telegramId" <> ALL(:internal_ids);
