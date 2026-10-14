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
  OFFER_URL: process.env.OFFER_URL ?? "",
  CONTACT_EMAIL: process.env.CONTACT_EMAIL ?? "",
};
