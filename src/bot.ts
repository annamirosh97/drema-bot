import { Bot, Context } from "grammy";
import { env } from "./env";
import { handleIncoming } from "./engine";
import { registerAdminCommands, handleAdminFlowMessage } from "./admin";

const bot = new Bot(env.BOT_TOKEN);

// Про race condition, которая ломала анкету в Make при быстрых повторных
// сообщениях от одного пользователя: bot.start() ниже — это простой
// long polling, который обрабатывает входящие обновления строго одно за
// другим, по порядку. Двух апдейтов от одного и того же (или разных)
// пользователей одновременно тут просто не бывает — сама причина той
// ошибки в новой архитектуре отсутствует. Если бота нужно будет
// масштабировать на очень большой поток сообщений, для параллельной
// обработки разных чатов при сохранении порядка внутри одного чата есть
// пакет @grammyjs/runner + его sequentialize() — но для пилота/fake door
// теста это не требуется.

registerAdminCommands(bot);

// Явно ловим "/start", чтобы кнопка Start у бота в Telegram сразу
// показывала приветствие, даже у совсем нового пользователя.
bot.command("start", (ctx) => handleIncoming(ctx));

bot.on("message:text", async (ctx) => {
  const handledByAdminFlow = await handleAdminFlowMessage(bot, ctx);
  if (handledByAdminFlow) return;
  await handleIncoming(ctx);
});

bot.on("callback_query:data", (ctx) => handleIncoming(ctx));

bot.catch((err) => {
  console.error("Ошибка в обработчике бота:", err.message, err.error);
});

async function main() {
  console.log("Дрёма-бот запускается...");
  await bot.start({
    onStart: (botInfo) => console.log(`Бот @${botInfo.username} запущен и слушает сообщения (long polling).`),
  });
}

main().catch((err) => {
  console.error("Не удалось запустить бота:", err);
  process.exit(1);
});

process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());
