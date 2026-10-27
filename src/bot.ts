import { Bot, Context } from "grammy";
import { env } from "./env";
import { trackBlockedUsers } from "./blockedTracker";
import {
  handleIncoming,
  handleGotoCommand,
  handleMenuCommand,
  handleResetCommand,
} from "./engine";
import { handleConsultStatusCallback } from "./consult";
import { registerAdminCommands, handleAdminFlowMessage } from "./admin";
import { startAdminServer } from "./web/server";
import { startUpsellScheduler } from "./upsell";
import { startFeedbackScheduler } from "./feedback";
import { startQuizReminderScheduler } from "./quizReminders";
import { startSupportBot } from "./support/bot";
import { handleDataCommand, handleUnsubscribeCommand } from "./dataCommand";
import { loadLegalDocuments } from "./legalDocs";
import { countUsersWithoutPdConsent } from "./consents";

const bot = new Bot(env.BOT_TOKEN);

// Трансформер видит все исходящие вызовы: 403 «бота остановили» будет
// записан событием независимо от того, откуда шла отправка.
trackBlockedUsers(bot.api);

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

// /reset — чистый лист с удалением ответов. Только для админа, проверка
// внутри: людям для «начать заново» служит /restart, который ничего не
// удаляет.
bot.command("reset", (ctx) => handleResetCommand(ctx));

// Меню и его пункты. Зарегистрированы как команды, а не как текст:
// иначе «/menu», набранное посреди анкеты, уехало бы в ответ на вопрос.
//
// Все четыре идут через handleMenuCommand: он проверяет закрытый режим
// и заводит сессию — ровно то же, с чего начинает handleIncoming.
bot.command("menu", (ctx) => handleMenuCommand(ctx, "menu"));
bot.command("support", (ctx) => handleMenuCommand(ctx, "support"));
bot.command("docs", (ctx) => handleMenuCommand(ctx, "docs"));
bot.command("team", (ctx) => handleMenuCommand(ctx, "team"));
// «Начать заново» для людей. Имя не /regen: оно уже занято админской
// командой перегенерации разбора (/regen <id> в admin.ts).
bot.command("restart", (ctx) => handleMenuCommand(ctx, "restart"));

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
  console.log("Дрёмиус-бот запускается...");

  // Если у токена остался вебхук с прошлой жизни, long polling на нём
  // не заработает: Telegram отдаст 409. Снимаем, но очередь
  // накопленных обновлений не сбрасываем — терять чужие сообщения
  // из-за нашего переезда незачем.
  await bot.api
    .deleteWebhook()
    .catch((error) => console.error("Не удалось снять вебхук:", error));

  if (env.ALLOWED_USER_IDS.length) {
    console.log(
      `Закрытый режим: отвечаю только ${env.ALLOWED_USER_IDS.join(", ")}. ` +
        `Остальным — «Дрёмиус скоро откроется».`
    );
  }
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
  // Предложение консультации со скидкой через пару минут после плана.
  startUpsellScheduler(bot.api);
  // Отложенные вопросы: о разборе через сутки, о плане через неделю.
  startFeedbackScheduler(bot.api);
  // Напоминания тем, кто остановился посреди анкеты: через 3 и 24 часа.
  startQuizReminderScheduler(bot.api);
  // Бот поддержки — отдельный бот в этом же процессе. Запускаем до
  // bot.start(): тот не возвращается, пока основной бот живёт. Без
  // токена поддержка просто не поднимается.
  startSupportBot();
  // Список команд за кнопкой слева от поля ввода. Короткий намеренно:
  // всё остальное лежит в самом меню, а длинный список людей пугает.
  // /start, /restart, /support, /docs, /team и /unsubscribe работают,
  // если набрать руками, но здесь не показываются.
  //
  // Задаём для личных чатов и отдельно для русского: Telegram выбирает
  // список по языку клиента, и без общего (без language_code) человек с
  // английским интерфейсом не увидел бы ничего.
  const commands = [
    { command: "menu", description: "Меню" },
    { command: "data", description: "Мои данные и согласия" },
  ];
  for (const language_code of [undefined, "ru"] as const) {
    await bot.api
      .setMyCommands(commands, { scope: { type: "all_private_chats" }, language_code })
      .catch((error) =>
        console.error(`Не удалось задать меню команд (${language_code ?? "по умолчанию"}):`, error)
      );
  }

  // Кнопка слева от поля ввода — стандартная кнопка команд. Telegram
  // показывает её и по умолчанию, но задаём явно: у бота мог остаться
  // другой тип кнопки, выставленный раньше через BotFather.
  await bot.api
    .setChatMenuButton({ menu_button: { type: "commands" } })
    .catch((error) => console.error("Не удалось задать кнопку меню:", error));

  await bot
    .start({
      onStart: (botInfo) =>
        console.log(`Бот @${botInfo.username} запущен и слушает сообщения (long polling).`),
    })
    .catch((error) => {
      // 409 значит, что этим же токеном уже кто-то пользуется: второй
      // деплой, локальный запуск или не снятый вебхук. Сообщение
      // Telegram об этом невнятное, поэтому говорим прямо.
      const description = (error as { description?: string })?.description ?? String(error);
      if (/409|terminated by other|Conflict/i.test(description)) {
        console.error(
          "Этот токен уже используется другим процессом: проверь, не запущен ли бот " +
            "локально или вторым деплоем. Два экземпляра с одним токеном работать не могут."
        );
      }
      throw error;
    });
}

main().catch((err) => {
  console.error("Не удалось запустить бота:", err);
  process.exit(1);
});

process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());
