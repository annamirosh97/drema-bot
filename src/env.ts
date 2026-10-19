import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Не задана переменная окружения ${name}. Проверь файл .env (локально) или Variables в Railway (на проде).`
    );
  }
  return value;
}

// Адрес юридического документа: либо задан явно, либо собирается из
// публичного адреса приложения и ведёт на нашу страницу-заглушку. Если
// публичный адрес не задан, остаётся пустым — это видно сразу, в отличие
// от битой ссылки.
function legalUrl(variable: string, fallbackPath: string): string {
  const explicit = (process.env[variable] ?? "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const base = (process.env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  return base ? `${base}${fallbackPath}` : "";
}

export const env = {
  BOT_TOKEN: required("BOT_TOKEN"),
  DATABASE_URL: required("DATABASE_URL"),
  // Telegram ID администратора (тебя) — только этому ID доступны /pending, /prep, /send, /stats.
  // Узнать свой ID можно у бота @userinfobot.
  ADMIN_TELEGRAM_ID: required("ADMIN_TELEGRAM_ID"),
  // Ключ к Claude API — им бот сам готовит черновик разбора сразу после
  // анкеты. Взять в console.anthropic.com → API keys.
  ANTHROPIC_API_KEY: required("ANTHROPIC_API_KEY"),
  // Разбор готовится в два вызова, и модель у каждого своя — так можно
  // сравнивать качество и цену по шагам, не трогая код. Значения по
  // умолчанию — та модель, что стояла до разделения на шаги.
  ANALYSIS_MODEL: process.env.ANALYSIS_MODEL || "claude-opus-5",
  WRITER_MODEL: process.env.WRITER_MODEL || "claude-opus-5",
  // Цена платного PDF, в рублях. Одна для всех.
  PDF_PRICE_RUB: parseInt(process.env.PDF_PRICE_RUB ?? "990", 10) || 990,
  // Цена консультации специалиста, в рублях.
  CONSULT_PRICE_RUB: parseInt(process.env.CONSULT_PRICE_RUB ?? "4990", 10) || 4990,
  // Telegram-username специалиста, который проводит консультации, без «@».
  // Подставляется в сообщения родителю: по нему он находит специалиста, а
  // специалист — его.
  SPECIALIST_USERNAME: (process.env.SPECIALIST_USERNAME ?? "sophiazolotova").replace(/^@/, ""),
  // Telegram ID специалиста. Если задан, пакет заявки уходит не только
  // админу, но и ей. Писать ей бот сможет только после того, как она
  // хотя бы раз нажала /start — это ограничение Telegram.
  CONSULT_SPECIALIST_TELEGRAM_ID: process.env.CONSULT_SPECIALIST_TELEGRAM_ID ?? "",
  // Предложение консультации со скидкой тем, кто купил план: цена,
  // сколько дней оно действует и через сколько минут после отправки PDF
  // приходит. Задержка небольшая намеренно — чтобы предложение не
  // налезло на сам файл, но и пришло, пока план ещё перед глазами.
  UPSELL_PRICE_RUB: parseInt(process.env.UPSELL_PRICE_RUB ?? "3990", 10) || 3990,
  UPSELL_VALID_DAYS: parseInt(process.env.UPSELL_VALID_DAYS ?? "7", 10) || 7,
  UPSELL_DELAY_MIN: parseInt(process.env.UPSELL_DELAY_MIN ?? "2", 10) || 2,
  // Модели двух шагов генерации платного PDF: P1 «План» и P2 «Текст».
  // Разделены, чтобы сравнивать качество и цену по шагам, не трогая код.
  PDF_PLAN_MODEL: process.env.PDF_PLAN_MODEL || "claude-opus-5",
  PDF_WRITER_MODEL: process.env.PDF_WRITER_MODEL || "claude-opus-5",
  // Пароль к веб-админке, где проверяются черновики PDF. Если не задан,
  // админка не поднимается, а бот работает как обычно — чтобы деплой до
  // того, как переменная прописана, не ронял бота целиком.
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ?? "",
  // Порт веб-админки. На Railway подставляется автоматически.
  PORT: parseInt(process.env.PORT ?? "3000", 10) || 3000,
  // Публичный адрес приложения — из него собираются ссылки на заказы,
  // которые бот присылает в Telegram. Без него ссылок просто не будет.
  PUBLIC_BASE_URL: (process.env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, ""),
  // Контакты на финальной странице PDF. Если не заданы, строки не
  // выводятся вовсе — пустое «Почта для связи:» выглядело бы небрежно.
  OFFER_URL: legalUrl("OFFER_URL", "/offer"),
  CONTACT_EMAIL: process.env.CONTACT_EMAIL ?? "",
  // Адреса юридических документов. Пока текстов нет, по умолчанию ведут
  // на страницы-заглушки этого же приложения — пустая ссылка в сообщении
  // о персональных данных недопустима.
  PRIVACY_POLICY_URL: legalUrl("PRIVACY_POLICY_URL", "/privacy"),
  PD_CONSENT_URL: legalUrl("PD_CONSENT_URL", "/consent"),
  MARKETING_CONSENT_URL: legalUrl("MARKETING_CONSENT_URL", "/marketing-consent"),
  // Требовать ли согласие на рассылку для опросов о впечатлениях (CSAT).
  // По умолчанию нет: это не реклама, а вопрос о качестве услуги, за
  // которой человек пришёл сам. Флаг оставлен на случай, если юрист
  // решит иначе — тогда опрос тоже станет требовать согласия.
  FEEDBACK_REQUIRES_MARKETING: (process.env.FEEDBACK_REQUIRES_MARKETING ?? "") === "true",
  // Отложенные вопросы обратной связи: через сколько спрашивать и в
  // какие часы по Москве это допустимо. Окно общее для обоих вопросов:
  // ночью такие сообщения приходить не должны.
  FREE_ANALYSIS_FEEDBACK_DELAY_HOURS:
    parseInt(process.env.FREE_ANALYSIS_FEEDBACK_DELAY_HOURS ?? "24", 10) || 24,
  PDF_FEEDBACK_DELAY_DAYS: parseInt(process.env.PDF_FEEDBACK_DELAY_DAYS ?? "7", 10) || 7,
  // Окно одно на все сообщения, которые бот отправляет по своей
  // инициативе: отложенные вопросы и напоминания о незаконченной
  // анкете. Две независимые пары переменных однажды разъехались бы
  // молча, и ночью приходило бы то, что ночью приходить не должно.
  //
  // FEEDBACK_WINDOW_* читается как запасной вариант: именно он задан на
  // проде, и переезд на новое имя не должен ничего сломать.
  REMINDER_WINDOW_START: parseInt(
    process.env.REMINDER_WINDOW_START ?? process.env.FEEDBACK_WINDOW_START ?? "10",
    10
  ) || 10,
  REMINDER_WINDOW_END: parseInt(
    process.env.REMINDER_WINDOW_END ?? process.env.FEEDBACK_WINDOW_END ?? "21",
    10
  ) || 21,
  // Через сколько часов после последнего ответа напоминать о
  // незаконченной анкете. Второе напоминание приходит, только если
  // после первого человек так и не ответил.
  QUIZ_REMINDER_1_HOURS: parseInt(process.env.QUIZ_REMINDER_1_HOURS ?? "3", 10) || 3,
  QUIZ_REMINDER_2_HOURS: parseInt(process.env.QUIZ_REMINDER_2_HOURS ?? "24", 10) || 24,
  // Бот поддержки — отдельный бот в этом же процессе. Без токена он
  // просто не поднимается, основной работает как обычно.
  // Username основного бота без «@»: подставляется там, где на него
  // нужно сослаться, например в приветствии поддержки.
  MAIN_BOT_USERNAME: (process.env.MAIN_BOT_USERNAME ?? "drema_sleep_bot").replace(/^@/, ""),
  // Username бота поддержки без «@»: из него собирается ссылка в пункте
  // «Поддержка». Если не задан, в меню вместо кнопки будет почта —
  // ссылка на несуществующий бот хуже, чем её отсутствие.
  SUPPORT_BOT_USERNAME: (process.env.SUPPORT_BOT_USERNAME ?? "").replace(/^@/, ""),
  // Закрытый режим. Пусто — бот открыт для всех. Если список задан,
  // всем остальным бот отвечает, что скоро откроется, и больше ничего
  // не делает и не сохраняет. Админ проходит всегда: иначе бот можно
  // закрыть и от себя.
  ALLOWED_USER_IDS: (() => {
    const ids = (process.env.ALLOWED_USER_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (!ids.length) return [];
    const admin = required("ADMIN_TELEGRAM_ID");
    return ids.includes(admin) ? ids : [...ids, admin];
  })(),
  SUPPORT_BOT_TOKEN: process.env.SUPPORT_BOT_TOKEN ?? "",
  // Кто может привязать группу и отвечать родителям. По умолчанию —
  // админ основного бота.
  SUPPORT_ADMIN_IDS: (process.env.SUPPORT_ADMIN_IDS || required("ADMIN_TELEGRAM_ID"))
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
};
