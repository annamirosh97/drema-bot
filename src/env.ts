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
  // Цена платного продукта на экране оплаты, в рублях. Одна для всех:
  // раньше здесь был список цен, из которого каждому доставалась
  // случайная, — от этого отказались.
  PRODUCT_PRICE_RUB: parseInt(process.env.PRODUCT_PRICE_RUB ?? "990", 10) || 990,
};
