import { Bot, Context } from "grammy";
import { prisma } from "./prisma";
import { env } from "./env";
import { deliverRecommendation, buildPrepText } from "./engine";

function isAdmin(ctx: Context): boolean {
  return String(ctx.from?.id ?? "") === env.ADMIN_TELEGRAM_ID;
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
