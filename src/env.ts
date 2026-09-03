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
  // Цены для fake door теста, через запятую. Каждому новому пользователю
  // на экране оплаты случайно достаётся одна из них — так меряем
  // конверсию по разным ценам одновременно.
  FAKE_DOOR_PRICES: (process.env.FAKE_DOOR_PRICES ?? "490,590,690")
    .split(",")
    .map((v) => parseInt(v.trim(), 10))
    .filter((v) => !Number.isNaN(v)),
};
