import { Bot, Context } from "grammy";
import { prisma } from "./prisma";
import { env } from "./env";
import {
  deliverRecommendation,
  buildPrepText,
  sendApprovedRecommendation,
  generateDraftForAdmin,
  regenerateForAdmin,
} from "./engine";
import { formatUsd } from "./claudeApi";

function isAdmin(ctx: Context): boolean {
  return String(ctx.from?.id ?? "") === env.ADMIN_TELEGRAM_ID;
}

// Аргумент почти всех админских команд — telegram_id. null означает,
// что его не передали или передали не число.
function parseTelegramId(raw?: string): bigint | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

// Один разбор — это несколько вызовов подряд по одной сессии: шаг
// «анализ», шаг «письмо» и возможные повторы. В базе они лежат
// россыпью, поэтому собираем их обратно по сессии и близости во
// времени. По минуте группировать нельзя: два вызова разбора легко
// расходятся через границу минуты, и тогда один разбор посчитался бы
// за два, а средняя цена вышла бы вдвое меньше настоящей.
const RUN_GAP_MS = 5 * 60 * 1000;

interface ApiCallRow {
  sessionId: string;
  createdAt: Date;
  step: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

// На входе вызовы от новых к старым, на выходе — разборы в том же порядке.
export function groupIntoRuns<T extends ApiCallRow>(callsNewestFirst: T[]): T[][] {
  const runs: T[][] = [];

  for (const call of callsNewestFirst) {
    const current = runs[runs.length - 1];
    const previous = current?.[current.length - 1];
    const sameRun =
      previous &&
      previous.sessionId === call.sessionId &&
      previous.createdAt.getTime() - call.createdAt.getTime() < RUN_GAP_MS;

    if (sameRun) current.push(call);
    else runs.push([call]);
  }

  return runs;
}

interface SendFlowState {
  telegramId: bigint;
  chatId: bigint;
  messages: string[];
  stage: "collecting" | "confirming";
}

// Состояние сборки рекомендации (/send) держим в памяти процесса —
// это ты сама, действие короткое и разовое, БД для этого не нужна.
const sendFlows = new Map<number, SendFlowState>();

export function registerAdminCommands(bot: Bot) {
  bot.command("pending", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const rows = await prisma.recommendation.findMany({
      where: { status: "pending" },
      orderBy: { createdAt: "asc" },
    });
    if (!rows.length) return ctx.reply("Очередь пуста — никто не ждёт разбора.");
    const lines = rows.map(
      (r: { telegramId: bigint; createdAt: Date }) =>
        `#${r.telegramId} — анкета завершена ${r.createdAt.toLocaleString("ru-RU")}`
    );
    await ctx.reply(
      `Ждут разбора (${rows.length}):\n\n${lines.join("\n")}\n\nПосмотреть ответы: /prep <id>\nОтправить разбор: /send <id>`
    );
  });

  bot.command("prep", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const idStr = ctx.match?.toString().trim();
    if (!idStr) return ctx.reply("Использование: /prep <telegram_id>");
    let telegramId: bigint;
    try {
      telegramId = BigInt(idStr);
    } catch {
      return ctx.reply("telegram_id должен быть числом.");
    }
    const text = await buildPrepText(telegramId);
    for (let i = 0; i < text.length; i += 3500) {
      await ctx.reply(text.slice(i, i + 3500));
    }
  });

  bot.command("send", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const idStr = ctx.match?.toString().trim();
    if (!idStr) return ctx.reply("Использование: /send <telegram_id>");
    let telegramId: bigint;
    try {
      telegramId = BigInt(idStr);
    } catch {
      return ctx.reply("telegram_id должен быть числом.");
    }
    const session = await prisma.session.findUnique({ where: { telegramId } });
    if (!session) return ctx.reply("Такого пользователя нет в базе.");

    sendFlows.set(ctx.from!.id, { telegramId, chatId: session.chatId, messages: [], stage: "collecting" });
    await ctx.reply(`Собираю разбор для #${telegramId}. Пришли сообщение 1 из 4.\n\nОтменить в любой момент — /cancel`);
  });

  // Переподготовить черновик для уже заполненной анкеты. Нужна, когда
  // автоматическая генерация сорвалась: анкета готова, а черновика нет.
  bot.command("draft", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const idStr = ctx.match?.toString().trim();
    if (!idStr) return ctx.reply("Использование: /draft <telegram_id>");
    let telegramId: bigint;
    try {
      telegramId = BigInt(idStr);
    } catch {
      return ctx.reply("telegram_id должен быть числом.");
    }

    const recommendation = await prisma.recommendation.findUnique({ where: { telegramId } });
    if (!recommendation) {
      return ctx.reply(
        `#${telegramId} ещё не подтвердил анкету — готовить черновик не из чего.\n\n` +
          `Кто закончил и ждёт разбора: /pending`
      );
    }
    if (recommendation.status === "sent") {
      const when = recommendation.sentAt?.toLocaleString("ru-RU") ?? "раньше";
      return ctx.reply(
        `Разбор для #${telegramId} уже отправлен (${when}), новый черновик его не заменит.\n\n` +
          `Если нужна другая версия — /send ${telegramId}`
      );
    }

    // Не ждём результата: бот обрабатывает сообщения по одному, и ожидание
    // ответа модели заморозило бы его для остальных на десятки секунд.
    // «Готовлю черновик…» отправит сама generateDraftForAdmin — она это
    // делает и при автоматической генерации, чтобы текст был один.
    void generateDraftForAdmin(bot.api, telegramId);
  });

  // Отправить пользователю черновик, который бот подготовил сам.
  // Если нужна своя версия — не /approve, а /send: он перезапишет черновик.
  bot.command("approve", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const idStr = ctx.match?.toString().trim();
    if (!idStr) return ctx.reply("Использование: /approve <telegram_id>");
    let telegramId: bigint;
    try {
      telegramId = BigInt(idStr);
    } catch {
      return ctx.reply("telegram_id должен быть числом.");
    }

    const recommendation = await prisma.recommendation.findUnique({ where: { telegramId } });
    if (!recommendation?.message1 || !recommendation?.message2) {
      return ctx.reply(
        `Черновика для #${telegramId} нет — видимо, автоматическая подготовка не сработала.\n\n` +
          `Собрать вручную: /prep ${telegramId}, затем /send ${telegramId}`
      );
    }
    if (recommendation.status === "sent") {
      const when = recommendation.sentAt?.toLocaleString("ru-RU") ?? "раньше";
      return ctx.reply(`Разбор для #${telegramId} уже отправлен (${when}).`);
    }

    const session = await prisma.session.findUnique({ where: { telegramId } });
    if (!session) return ctx.reply("Такого пользователя нет в базе.");

    try {
      await sendApprovedRecommendation(bot.api, telegramId, session.chatId);
      await ctx.reply(`Готово: разбор #${telegramId} отправлен, экран оплаты показан.`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Не получилось отправить разбор #${telegramId}.\n\nПричина: ${reason}`);
    }
  });

  // Показать блок ВЫВОДЫ — то, на чём второй шаг строил текст.
  bot.command("analysis", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const telegramId = parseTelegramId(ctx.match?.toString());
    if (telegramId === null) return ctx.reply("Использование: /analysis <telegram_id>");

    const recommendation = await prisma.recommendation.findUnique({ where: { telegramId } });
    if (!recommendation?.analysis) {
      return ctx.reply(`Выводов анализа для #${telegramId} нет — черновик ещё не готовили.`);
    }
    for (let i = 0; i < recommendation.analysis.length; i += 3500) {
      await ctx.reply(recommendation.analysis.slice(i, i + 3500));
    }
  });

  // Пробный прогон обоих шагов для отладки промптов. Сохранённый
  // черновик не трогает и пользователю ничего не отправляет.
  bot.command("regen", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const telegramId = parseTelegramId(ctx.match?.toString());
    if (telegramId === null) return ctx.reply("Использование: /regen <telegram_id>");

    const answers = await prisma.answer.count({ where: { telegramId } });
    if (!answers) return ctx.reply(`У #${telegramId} нет сохранённых ответов — прогонять нечего.`);

    // Не ждём результата: бот обрабатывает сообщения по одному, и ожидание
    // двух вызовов модели заморозило бы его для остальных.
    void regenerateForAdmin(bot.api, telegramId);
  });

  // Во что обходятся разборы: по последним 20 прогонам.
  bot.command("cost", async (ctx) => {
    if (!isAdmin(ctx)) return;

    const calls = await prisma.apiCall.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
    if (!calls.length) {
      return ctx.reply(
        "Обращений к Claude API ещё не было — считать нечего.\n\n" +
          "Записи появятся после первого разбора: автоматического после анкеты либо /draft и /regen."
      );
    }

    const runs = groupIntoRuns(calls).slice(0, 20);
    const callsInRuns = runs.flat();

    const totals = runs.map((run) => run.reduce((sum, c) => sum + (c.costUsd ?? 0), 0));
    const average = totals.reduce((a, b) => a + b, 0) / totals.length;

    const perStep = (step: string) => {
      const stepCalls = callsInRuns.filter((c) => c.step === step);
      if (!stepCalls.length) return `${step}: вызовов нет`;
      const avgIn = Math.round(stepCalls.reduce((s, c) => s + c.inputTokens, 0) / stepCalls.length);
      const avgOut = Math.round(stepCalls.reduce((s, c) => s + c.outputTokens, 0) / stepCalls.length);
      const models = [...new Set(stepCalls.map((c) => c.model))].join(", ");
      return `${step} (${models}): в среднем ${avgIn} вход / ${avgOut} выход`;
    };

    const unpriced = callsInRuns.some((c) => c.costUsd === null)
      ? "\n\n⚠️ У части вызовов цена неизвестна — модели нет в таблице цен в src/claudeApi.ts."
      : "";

    await ctx.reply(
      `Последние ${runs.length} разборов (всего вызовов ${callsInRuns.length}):\n\n` +
        `Средняя цена разбора: ${formatUsd(average)}\n` +
        `Самый дорогой: ${formatUsd(Math.max(...totals))}\n\n` +
        `${perStep("analysis")}\n${perStep("writer")}${unpriced}`
    );
  });

  bot.command("stats", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const [total, completed, declined, offers, clicks] = await Promise.all([
      prisma.session.count(),
      prisma.session.count({ where: { status: "completed" } }),
      prisma.session.count({ where: { status: "declined" } }),
      prisma.fakeDoorOffer.count(),
      prisma.fakeDoorOffer.count({ where: { clickedAt: { not: null } } }),
    ]);
    const rate = offers ? Math.round((clicks / offers) * 100) : 0;
    await ctx.reply(
      `Всего пользователей: ${total}\n` +
        `Завершили анкету: ${completed}\n` +
        `Отказались: ${declined}\n\n` +
        `Fake door — показано экранов: ${offers}\n` +
        `Нажали «Оплатить»: ${clicks} (${rate}%)`
    );
  });
}

// Возвращает true, если сообщение было перехвачено и обработано как
// часть сборки рекомендации (/send) — тогда в обычный движок анкеты
// (src/engine.ts) его пускать не нужно.
export async function handleAdminFlowMessage(bot: Bot, ctx: Context): Promise<boolean> {
  const adminId = ctx.from?.id;
  if (!adminId) return false;
  const flow = sendFlows.get(adminId);
  if (!flow) return false;

  const text = ctx.message?.text?.trim();

  if (text === "/cancel") {
    sendFlows.delete(adminId);
    await ctx.reply("Отменила.");
    return true;
  }

  if (flow.stage === "confirming") {
    if (text === "/confirm") {
      sendFlows.delete(adminId);
      await deliverRecommendation(bot.api, flow.telegramId, flow.chatId, flow.messages as [string, string, string, string]);
      await ctx.reply("Готово — отправила 4 сообщения и показала пользователю экран оплаты (fake door).");
    } else {
      await ctx.reply("Напиши /confirm, чтобы отправить как есть, или /cancel, чтобы отменить.");
    }
    return true;
  }

  if (!text) {
    await ctx.reply("Пришли текстом, пожалуйста.");
    return true;
  }

  flow.messages.push(text);
  if (flow.messages.length < 4) {
    await ctx.reply(`Принято. Пришли сообщение ${flow.messages.length + 1} из 4.`);
  } else {
    flow.stage = "confirming";
    const preview = flow.messages.map((m, i) => `— Сообщение ${i + 1} —\n${m}`).join("\n\n");
    await ctx.reply(`Проверь перед отправкой:\n\n${preview}`);
    await ctx.reply("Всё верно? /confirm — отправить, /cancel — отменить.");
  }
  return true;
}
