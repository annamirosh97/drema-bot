import { Bot, Context } from "grammy";
import { env } from "./env";
import { handleIncoming, handleGotoCommand, handleResetCommand } from "./engine";
import { handleConsultStatusCallback } from "./consult";
import { registerAdminCommands, handleAdminFlowMessage } from "./admin";
import { startAdminServer } from "./web/server";
import { startReminders } from "./engine";
import { startUpsellScheduler } from "./upsell";
import { handleDataCommand, handleUnsubscribeCommand } from "./dataCommand";
import { loadLegalDocuments } from "./legalDocs";
import { countUsersWithoutPdConsent } from "./consents";

const bot = new Bot(env.BOT_TOKEN);

// Про race condition, которая ломала анкету в Make при быстрых повторных
// сообщениях от одного пользователя: bot.start() ниже — это простой
// long polling, который обрабатывает входящие обновления строго одно за
// другим, по порядку. Двух апдейтов от одного и того же (или разных)
// пользователей одновременно тут просто не бывает — сама причина той
// ошибки в новой архитектуре отсутствует. Если бота нужно будет
// масштабировать на очень большой поток сообщений, для параллельной
// обработки разных чатов при сохранении порядка внутри одного чата есть
// пакет @grammyjs/runner + его sequentialize() — но для пилота это не
// требуется.

registerAdminCommands(bot);

// Явно ловим "/start", чтобы кнопка Start у бота в Telegram сразу
// показывала приветствие, даже у совсем нового пользователя.
bot.command("start", (ctx) => handleIncoming(ctx));

// /reset — вернуться в начало бота. Доступна всем: обычный
// пользователь тоже может захотеть пройти анкету заново.
bot.command("reset", (ctx) => handleResetCommand(ctx));

// /data и /unsubscribe работают в любом состоянии, в том числе когда
// согласие на обработку данных отозвано: иначе отзыв был бы дверью без
// ручки — ни посмотреть своё состояние, ни передумать.
bot.command("data", (ctx) => handleDataCommand(ctx));
bot.command("unsubscribe", (ctx) => handleUnsubscribeCommand(ctx));

// /goto <номер> — прыжок на конкретный вопрос. Только для админа:
// обычному пользователю прыжки по анкете оставят её с дырами, и разбор
// придётся готовить по неполным ответам.
bot.command("goto", (ctx) => {
  if (String(ctx.from?.id ?? "") !== env.ADMIN_TELEGRAM_ID) return;
  return handleGotoCommand(ctx, ctx.match?.toString() ?? "");
});

bot.on("message:text", async (ctx) => {
  const handledByAdminFlow = await handleAdminFlowMessage(bot, ctx);
  if (handledByAdminFlow) return;
  await handleIncoming(ctx);
});

// Кнопка «Поделиться контактом» в заявке на консультацию присылает не
// текст, а сообщение с контактом — без этого обработчика оно просто не
// дошло бы до бота, и согласие на передачу контакта не работало бы.
bot.on("message:contact", (ctx) => handleIncoming(ctx));

// Кнопки статуса под заявкой на консультацию. Зарегистрированы ДО общего
// обработчика нажатий: их жмёт в том числе специалист, у которой своей
// анкеты в боте может не быть вовсе, и гонять её через движок анкеты
// незачем.
bot.callbackQuery(/^consult_(contacted|done)_\d+$/, (ctx) => handleConsultStatusCallback(ctx));

bot.on("callback_query:data", (ctx) => handleIncoming(ctx));

bot.catch((err) => {
  console.error("Ошибка в обработчике бота:", err.message, err.error);
});

async function main() {
  console.log("Дрёма-бот запускается...");
  // Версии юридических документов нужны до первого онбординга: без них
  // согласие не записать, поэтому поднимаемся только с ними.
  await loadLegalDocuments();

  // Сколько людей пользовались ботом до появления согласий: им экраны
  // покажутся при следующем действии. Цифра нужна один раз, после
  // выката, поэтому просто пишем её в лог.
  const withoutConsent = await countUsersWithoutPdConsent();
  console.log(
    withoutConsent
      ? `Пользователей без согласия на обработку данных: ${withoutConsent}. Им оба экрана покажутся при следующем действии.`
      : "Все пользователи в базе уже отвечали на согласие об обработке данных."
  );

  // Веб-админка живёт в этом же процессе. Если ADMIN_PASSWORD не задан,
  // сервер всё равно поднимается, но админка отвечает 503 с объяснением.
  startAdminServer(bot.api);
  // Напоминания по заявкам на консультацию, которые ждут контакта.
  startReminders(bot.api);
  // Предложение консультации со скидкой через пару минут после плана.
  startUpsellScheduler(bot.api);
  // Меню команд в интерфейсе Telegram. Только для обычных людей:
  // админские команды сюда не кладём, они и так известны.
  await bot.api
    .setMyCommands([
      { command: "start", description: "Начать заново" },
      { command: "data", description: "Мои согласия и данные" },
      { command: "unsubscribe", description: "Отписаться от рассылки" },
      { command: "reset", description: "Пройти анкету с чистого листа" },
    ])
    .catch((error) => console.error("Не удалось задать меню команд:", error));

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
