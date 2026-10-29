import { Bot, Context } from "grammy";
import { prisma } from "./prisma";
import { env } from "./env";
import {
  ONBOARDING_FUNNEL,
  deliverRecommendation,
  buildPrepText,
  sendApprovedRecommendation,
  generateDraftForAdmin,
  regenerateForAdmin,
  keepLastRegen,
  sendOfferTo,
  createPdfOrder,
  runPdfGeneration,
} from "./engine";
import { formatUsd } from "./claudeApi";
import { consultUrl, consentUrl, orderUrl } from "./web/server";
import { formatMoscow, getConsentState } from "./consents";
import {
  answersOfCurrentAttempt,
  currentRecommendation,
  lastCancelledRecommendation,
} from "./attempt";

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

// ── Воронка онбординга ──────────────────────────────────────────────

const FUNNEL_DAYS = 14;

// Подписи шагов. Порядок берём из ONBOARDING_FUNNEL в engine.ts, чтобы
// он жил в одном месте, а здесь — только человеческие названия.
const FUNNEL_LABELS: Record<string, string> = {
  onb_welcome: "Приветствие",
  onb_welcome_value: "Что вы получите",
  onb_terms: "Условия и здоровье",
  onb_pd_consent: "Согласие на данные",
  onb_marketing: "Рассылка",
  onb_go: "Погнали",
  quiz_question_shown: "Первый вопрос",
  quiz_completed: "Анкета завершена",
};

interface FunnelEvent {
  telegramId: bigint;
  type: string;
  source?: string | null;
}

// Шаги считаем по уникальным людям: один человек, нажавший /start
// дважды, — это по-прежнему один дошедший.
//
// Проценты два: от предыдущего шага (где именно теряем) и от начала
// (сколько доходит в сумме). Шаг, которого в сценарии нет (экран
// здоровья или согласия до их появления), пропускаем — иначе нулевая
// строка обнулила бы всю воронку после себя.
export function buildOnboardingFunnel(events: FunnelEvent[], days: number): string {
  const usersBy = (type: string) =>
    new Set(events.filter((e) => e.type === type).map((e) => String(e.telegramId)));

  const pct = (part: number, whole: number) =>
    whole ? `${Math.round((part / whole) * 100)}%` : "—";

  const steps = ONBOARDING_FUNNEL.map((type) => ({ type, users: usersBy(type).size })).filter(
    (step, index) => index === 0 || step.users > 0
  );

  const first = steps[0]?.users ?? 0;
  if (!first) return `Онбординг за ${days} дн.: показов приветствия не было.`;

  const lines = steps.map((step, index) => {
    const previous = index === 0 ? step.users : steps[index - 1].users;
    const label = FUNNEL_LABELS[step.type] ?? step.type;
    const share =
      index === 0
        ? ""
        : ` (${pct(step.users, previous)} от предыдущего, ${pct(step.users, first)} от начала)`;
    return `  ${label}: ${step.users}${share}`;
  });

  // «Как я работаю» — не шаг воронки, а необязательная развилка: его
  // открывают не все, и считать это потерей неправильно.
  const howItWorks = usersBy("onb_how_it_works").size;
  const guide = usersBy("guide_sent").size;

  return (
    `Онбординг за ${days} дн.:\n${lines.join("\n")}\n` +
    `  — «Как я работаю» открыли: ${howItWorks} (${pct(howItWorks, first)} от начала)\n` +
    `  — азбуку получили: ${guide}`
  );
}

// ── Пример разбора ──────────────────────────────────────────────────
//
// Главный вопрос здесь не «сколько открыли», а «помогает ли пример
// дойти до анкеты». Поэтому рядом стоят две доходимости: у тех, кто
// пример видел, и у тех, кто нет. Без второй цифры первая ничего не
// значит — до анкеты доходят и без примера.
export function buildExampleBlock(events: FunnelEvent[], days: number): string {
  const idsBy = (type: string) =>
    new Set(events.filter((e) => e.type === type).map((e) => String(e.telegramId)));

  const opened = idsBy("example_analysis_opened");
  const started = idsBy("quiz_question_shown");
  const completed = idsBy("quiz_completed");
  const everyone = new Set(events.map((e) => String(e.telegramId)));

  const pct = (part: number, whole: number) =>
    whole ? `${Math.round((part / whole) * 100)}%` : "—";
  const share = (group: Set<string>, target: Set<string>) =>
    [...group].filter((id) => target.has(id)).length;

  const withoutExample = new Set([...everyone].filter((id) => !opened.has(id)));

  // Откуда открывали. Источник пишется в самом событии: пример
  // доступен с четырёх экранов, и без разбивки непонятно, какой из них
  // работает.
  const bySource = new Map<string, number>();
  for (const e of events) {
    if (e.type !== "example_analysis_opened") continue;
    const key = e.source ?? "неизвестно";
    bySource.set(key, (bySource.get(key) ?? 0) + 1);
  }
  const sourceNames: Record<string, string> = {
    welcome: "с приветствия",
    steps: "с трёх шагов",
    how_it_works: "с «Как я работаю»",
    menu: "из меню",
  };

  const lines = [
    `Пример разбора за ${days} дн.:`,
    `  открыли: ${opened.size}`,
  ];
  for (const [source, count] of [...bySource].sort((a, b) => b[1] - a[1])) {
    lines.push(`    ${sourceNames[source] ?? source}: ${count}`);
  }
  lines.push(
    `  открыли пример → дошли до анкеты: ${share(opened, started)} (${pct(share(opened, started), opened.size)})`,
    `  открыли пример → завершили анкету: ${share(opened, completed)} (${pct(share(opened, completed), opened.size)})`,
    `  без примера → дошли до анкеты: ${share(withoutExample, started)} (${pct(share(withoutExample, started), withoutExample.size)})`,
    `  без примера → завершили анкету: ${share(withoutExample, completed)} (${pct(share(withoutExample, completed), withoutExample.size)})`,
    `  открыли пример плана: ${idsBy("example_plan_opened").size}`
  );

  return lines.join("\n");
}

// ── Меню в /stats ───────────────────────────────────────────────────

// Здесь, в отличие от воронки онбординга, считаем события, а не людей:
// вопрос «сколько раз открывали меню» — про использование, и человек,
// заходивший в него пять раз, это пять заходов, а не один.
//
// «Начали заново» показываем двумя числами: сколько раз спрашивали и
// сколько раз подтвердили. Разница между ними — те, кто передумал,
// увидев предупреждение, и это самое интересное в этом блоке.
export function buildMenuBlock(events: { type: string }[], days: number): string {
  const count = (type: string) => events.filter((e) => e.type === type).length;

  const asked = count("restart_asked");
  const confirmedClean = count("restart_confirmed");
  const confirmedWithDraft = count("restart_confirmed_cancelled_draft");
  const confirmed = confirmedClean + confirmedWithDraft;

  const lines = [
    `Меню за ${days} дн.:`,
    `  открывали: ${count("menu_opened")}`,
    `  поддержка: ${count("menu_support")}`,
    `  документы: ${count("menu_docs")}`,
    `  команда Дрёмиуса: ${count("menu_team")}`,
    `  начать заново: спросили ${asked}, подтвердили ${confirmed}`,
    // /start у того, кто анкету уже прошёл: спрашивать нечего, новое
    // прохождение заводится молча. Считаем отдельно от перезапусков —
    // это возвраты, а не отказ от своей же работы.
    `  вернулись через /start: ${count("start_new_attempt")}`,
  ];

  // Строку про отменённые разборы показываем только когда такое было:
  // ноль здесь — норма, и постоянная строка о нём только мешала бы.
  if (confirmedWithDraft) {
    lines.push(`    из них с отменой готовившегося разбора: ${confirmedWithDraft}`);
  }

  return lines.join("\n");
}

// ── Напоминания анкеты в /stats ─────────────────────────────────────

// Главный вопрос этого блока — работают ли напоминания вообще, то есть
// сколько людей после них вернулись и сколько дошли до конца. Поэтому
// считаем по людям, а не по событиям: один человек, вернувшийся после
// напоминания, — это один вернувшийся, сколько бы вопросов он потом ни
// ответил.
//
// Топ-5 вопросов, на которых останавливаются, берём из QuizReminder, а
// не из событий: у OfferEvent нет колонки для номера вопроса.
// Воронка консультаций: от карточки до завершённой заявки.
//
// Считается по заявкам, а не по событиям: статусы меняет команда уже
// после того, как родитель ушёл из бота, и событие «оплатили» в его
// ленте не появится. По событиям берём только два первых шага — показ
// карточки и начало заявки, их в заявках нет.
export interface ConsultStatsInput {
  cardOpened: number;
  started: number;
  requests: {
    source: string;
    status: string;
    lostReason: string | null;
    createdAt: Date;
    contactedAt: Date | null;
    paidAt: Date | null;
    chatCreatedAt: Date | null;
    doneAt: Date | null;
  }[];
  days: number;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function hoursBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 3_600_000;
}

export function buildConsultBlock(input: ConsultStatsInput): string {
  const { requests } = input;
  const pct = (part: number, whole: number) =>
    whole ? ` (${Math.round((part / whole) * 100)}%)` : "";

  // «Дошёл до шага» считаем по датам, а не по текущему статусу:
  // заявка, которую закрыли как «не дошли до оплаты», всё равно
  // добралась до первого сообщения, и выкидывать её из воронки
  // значило бы занижать каждый шаг до самого отказа.
  const line = (label: string, value: number, previous: number) =>
    `  ${label}: ${value}${pct(value, previous)}`;

  const steps = (list: typeof requests) => {
    const contacted = list.filter((r) => r.contactedAt).length;
    const paid = list.filter((r) => r.paidAt).length;
    const chat = list.filter((r) => r.chatCreatedAt).length;
    const done = list.filter((r) => r.doneAt).length;
    return [
      line("оставили контакт", list.length, list.length),
      line("написали", contacted, list.length),
      line("оплатили", paid, contacted),
      line("чат создан", chat, paid),
      line("завершена", done, chat),
    ].join("\n");
  };

  const lines = [
    `Консультации за ${input.days} дн.:`,
    `  открыли карточку: ${input.cardOpened}`,
    `  начали заявку: ${input.started}${pct(input.started, input.cardOpened)}`,
    steps(requests),
  ];

  // Отдельно по источнику: у заявок после плана своя цена и свой путь,
  // и смешивать их конверсию с обычными нельзя.
  for (const [source, label] of [["OFFER", "после разбора"], ["AFTER_PDF", "после плана"]]) {
    const list = requests.filter((r) => r.source === source);
    if (list.length) lines.push(`  ${label}:`, steps(list).replace(/^ {2}/gm, "    "));
  }

  const lost = requests.filter((r) => r.status === "LOST");
  if (lost.length) {
    const byReason = new Map<string, number>();
    for (const r of lost) {
      const reason = r.lostReason ?? "другое";
      byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    }
    lines.push(`  не дошли до оплаты: ${lost.length}`);
    for (const [reason, count] of [...byReason].sort((a, b) => b[1] - a[1])) {
      lines.push(`    ${reason}: ${count}`);
    }
  }

  const toContacted = median(
    requests.filter((r) => r.contactedAt).map((r) => hoursBetween(r.createdAt, r.contactedAt!))
  );
  const toPaid = median(
    requests.filter((r) => r.paidAt).map((r) => hoursBetween(r.createdAt, r.paidAt!))
  );
  const hours = (value: number | null) => (value == null ? "—" : `${value.toFixed(1)} ч`);
  lines.push(`  медиана до первого сообщения: ${hours(toContacted)}`);
  lines.push(`  медиана до оплаты: ${hours(toPaid)}`);

  return lines.join("\n");
}

export function buildQuizReminderBlock(
  events: { telegramId: bigint; type: string }[],
  stopQuestions: (number | null)[],
  days: number
): string {
  const users = (type: string) =>
    new Set(events.filter((e) => e.type === type).map((e) => String(e.telegramId)));

  const sent1 = users("quiz_reminder_1_sent");
  const sent2 = users("quiz_reminder_2_sent");
  const resumed1 = users("quiz_resumed_after_reminder_1");
  const resumed2 = users("quiz_resumed_after_reminder_2");
  const completed = users("quiz_completed_after_reminder");

  const pct = (part: number, whole: number) =>
    whole ? `${Math.round((part / whole) * 100)}%` : "—";

  // Дошедшие до конца — только те, кто и возвращался после этого
  // напоминания: иначе один и тот же человек попал бы в оба счётчика.
  const completedAfter = (resumed: Set<string>) =>
    [...completed].filter((id) => resumed.has(id)).length;

  const line = (n: number, sent: Set<string>, resumed: Set<string>) =>
    `  напоминание ${n}: отправлено ${sent.size}, вернулись ${resumed.size} ` +
    `(${pct(resumed.size, sent.size)}), дошли до конца ${completedAfter(resumed)}`;

  const lines = [
    `Напоминания анкеты за ${days} дн.:`,
    line(1, sent1, resumed1),
    line(2, sent2, resumed2),
  ];

  // Где застревают. Строку показываем только когда есть что показать:
  // «топ-5: —» ничего не сообщает.
  const counts = new Map<number, number>();
  for (const q of stopQuestions) {
    if (q === null) continue;
    counts.set(q, (counts.get(q) ?? 0) + 1);
  }
  if (counts.size) {
    const top = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, 5)
      .map(([question, n]) => `${question} (${n})`)
      .join(", ");
    lines.push(`  чаще останавливаются на вопросах: ${top}`);
  }

  return lines.join("\n");
}

// ── Обратная связь в /stats ─────────────────────────────────────────

const ANALYSIS_LABELS: Record<string, string> = {
  YES: "Да, очень похоже",
  PARTLY: "Отчасти",
  NO: "Не совсем",
};

const PDF_LABELS: Record<string, string> = {
  BETTER: "Стало лучше",
  SAME: "Без изменений",
  WORSE: "Стало хуже",
  NOT_STARTED: "Пока не начали",
};

// Возрастные группы те же, что у памяток: 4–6, 6–9, 9–12 месяцев.
function ageGroup(months: number | null): string | null {
  if (months === null || !Number.isFinite(months)) return null;
  if (months < 6) return "4–6";
  if (months < 9) return "6–9";
  return "9–12";
}

interface Answered<T extends string> {
  telegramId: bigint;
  value: T;
}

// Распределение ответов одной строкой: «лучше 3 · хуже 1».
function distribution<T extends string>(
  rows: Answered<T>[],
  labels: Record<string, string>
): string {
  if (!rows.length) return "ответов нет";
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.value, (counts.get(row.value) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([value, n]) => `${labels[value] ?? value} ${n}`)
    .join(" · ");
}

// Разрез по признаку. Группы без ответов пропускаем: строка «9–12:
// ответов нет» ничего не добавляет.
function breakdown<T extends string>(
  rows: Answered<T>[],
  labels: Record<string, string>,
  by: (row: Answered<T>) => string | null
): string[] {
  const groups = new Map<string, Answered<T>[]>();
  for (const row of rows) {
    const key = by(row);
    if (key === null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, group]) => `    ${key}: ${distribution(group, labels)}`);
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

// Разбор, отменённый перезапуском анкеты. Объяснение одно для /draft,
// /approve и /send: иначе в трёх местах разошлись бы формулировки, а
// случай редкий и непонятный — человек начал заново, пока ты держал его
// черновик открытым.
function cancelledNote(telegramId: bigint): string {
  return (
    `Разбор для #${telegramId} отменён: человек начал анкету заново.\n\n` +
    `Отправлять его нельзя — он про ответы, которые человек уже переписал. ` +
    `Когда он закончит новую анкету, черновик придёт на проверку сам.`
  );
}

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

    // Проверяем до сбора сообщений, а не после: писать два сообщения
    // вручную и узнать в конце, что отправлять их некуда, — обидно.
    const existing = await currentRecommendation(telegramId);
    if (existing?.status === "cancelled") return ctx.reply(cancelledNote(telegramId));
    if (!existing) {
      if (await lastCancelledRecommendation(telegramId)) {
        return ctx.reply(cancelledNote(telegramId));
      }
      return ctx.reply(
        `#${telegramId} ещё не завершил анкету — отправлять разбор пока некуда.\n\n` +
          `Кто закончил и ждёт: /pending`
      );
    }

    sendFlows.set(ctx.from!.id, { telegramId, chatId: session.chatId, messages: [], stage: "collecting" });
    await ctx.reply(`Собираю разбор для #${telegramId}. Пришли сообщение 1 из 2.\n\nОтменить в любой момент — /cancel`);
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

    const recommendation = await currentRecommendation(telegramId);
    if (!recommendation) {
      // Сразу после перезапуска разбора нет, но причина не в том, что
      // человек не дошёл до конца: его черновик отменили.
      if (await lastCancelledRecommendation(telegramId)) {
        return ctx.reply(cancelledNote(telegramId));
      }
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
    if (recommendation.status === "cancelled") return ctx.reply(cancelledNote(telegramId));

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

    const recommendation = await currentRecommendation(telegramId);
    if (!recommendation?.message1 || !recommendation?.message2) {
      if (
        recommendation?.status === "cancelled" ||
        (!recommendation && (await lastCancelledRecommendation(telegramId)))
      ) {
        return ctx.reply(cancelledNote(telegramId));
      }
      return ctx.reply(
        `Черновика для #${telegramId} нет — видимо, автоматическая подготовка не сработала.\n\n` +
          `Собрать вручную: /prep ${telegramId}, затем /send ${telegramId}`
      );
    }
    if (recommendation.status === "sent") {
      const when = recommendation.sentAt?.toLocaleString("ru-RU") ?? "раньше";
      return ctx.reply(`Разбор для #${telegramId} уже отправлен (${when}).`);
    }
    if (recommendation.status === "cancelled") return ctx.reply(cancelledNote(telegramId));

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

    const recommendation = await currentRecommendation(telegramId);
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

    const answers = await prisma.answer.count({
      where: await answersOfCurrentAttempt(telegramId),
    });
    if (!answers) return ctx.reply(`У #${telegramId} нет сохранённых ответов — прогонять нечего.`);

    // Не ждём результата: бот обрабатывает сообщения по одному, и ожидание
    // двух вызовов модели заморозило бы его для остальных.
    void regenerateForAdmin(bot.api, telegramId);
  });

  // Сохранить последний пробный прогон /regen как черновик. Без этого
  // /approve отправит ту версию, что лежала в базе до пробы.
  bot.command("keep", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const telegramId = parseTelegramId(ctx.match?.toString());
    if (telegramId === null) return ctx.reply("Использование: /keep <telegram_id>");

    const saved = await keepLastRegen(telegramId);
    if (!saved) {
      return ctx.reply(
        `Сохранять нечего: пробного прогона для #${telegramId} в памяти нет.\n\n` +
          `Он теряется при перезапуске бота. Сделай /regen ${telegramId} заново, ` +
          `либо /draft ${telegramId} — тот сразу пишет в черновик.`
      );
    }
    await ctx.reply(
      `Готово: проба стала черновиком для #${telegramId}.\n\nОтправить: /approve ${telegramId}`
    );
  });

  // Создать заказ PDF вручную, в обход проверки «у этого пользователя
  // заказ уже есть». Нужна для тестов: пройти анкету заново со своего
  // аккаунта и получить план по новым ответам, не трогая прежний заказ.
  // Прежний заказ остаётся в истории как есть.
  bot.command("pdf", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const telegramId = parseTelegramId(ctx.match?.toString());
    if (telegramId === null) return ctx.reply("Использование: /pdf <telegram_id>");

    const session = await prisma.session.findUnique({ where: { telegramId } });
    if (!session) return ctx.reply("Такого пользователя нет в базе.");

    const recommendation = await currentRecommendation(telegramId);
    if (!recommendation?.analysis || !recommendation.message1 || !recommendation.message2) {
      return ctx.reply(
        `У #${telegramId} нет готового разбора — план собирать не из чего.\n\n` +
          `Он строится на выводах анализа и двух отправленных сообщениях: ` +
          `сначала /draft ${telegramId}, затем /approve ${telegramId}.`
      );
    }

    const previous = await prisma.order.count({ where: { telegramId } });
    const order = await createPdfOrder(telegramId);

    await ctx.reply(
      `Заказ PDF #${order.id} создан, собираю план по текущим ответам анкеты.` +
        (previous ? `\n\nПрежних заказов у этого пользователя: ${previous}, их не трогаю.` : "")
    );

    // Результата не ждём: два обращения к модели идут минуты, а бот
    // обрабатывает сообщения по одному.
    void runPdfGeneration(bot.api, order.id);
  });

  // Отправить оффер вручную — тому, кто его пропустил или потерял в
  // переписке. Сессию и заказы не трогает.
  bot.command("offer", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const telegramId = parseTelegramId(ctx.match?.toString());
    if (telegramId === null) return ctx.reply("Использование: /offer <telegram_id>");

    const session = await prisma.session.findUnique({ where: { telegramId } });
    if (!session) return ctx.reply("Такого пользователя нет в базе.");

    const recommendation = await currentRecommendation(telegramId);
    const warning = recommendation?.message1
      ? ""
      : `\n\n⚠️ У #${telegramId} нет готового разбора. Если он нажмёт «Купить», ` +
        `план не соберётся: он строится на выводах анализа и двух отправленных сообщениях.`;

    try {
      await sendOfferTo(bot.api, telegramId, session.chatId);
      await ctx.reply(`Оффер отправлен #${telegramId}. Сессия и заказы не менялись.${warning}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Не получилось отправить оффер #${telegramId}.\n\nПричина: ${reason}`);
    }
  });

  // Незакрытые заказы PDF со ссылками в админку.
  bot.command("orders", async (ctx) => {
    if (!isAdmin(ctx)) return;

    const orders = await prisma.order.findMany({
      where: { status: { in: ["GENERATING", "DRAFT_READY", "FAILED"] } },
      orderBy: { createdAt: "asc" },
    });
    if (!orders.length) return ctx.reply("Незакрытых заказов PDF нет.");

    const lines = orders.map((order) => {
      const hours = Math.floor((Date.now() - order.createdAt.getTime()) / 3_600_000);
      const mark = hours >= 20 ? "🔴 " : hours >= 12 ? "🟡 " : "";
      const link = orderUrl(order.id);
      return `${mark}#${order.id} — ${order.status}, ждёт ${hours} ч` + (link ? `\n${link}` : "");
    });

    await ctx.reply(`Незакрытые заказы (${orders.length}):\n\n${lines.join("\n\n")}`);
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

    // Воронку онбординга смотрим за период: по умолчанию две недели,
    // иначе первые дни пилота перевешивают всё остальное.
    // Аргумент — число дней: /stats 30.
    const days = Math.max(1, Number(ctx.match?.toString().trim()) || FUNNEL_DAYS);
    const since = new Date(Date.now() - days * 24 * 3_600_000);

    const [
      total,
      completed,
      pdRecords,
      events,
      orders,
      consults,
      healthExitRows,
      funnelEvents,
      analysisRows,
      pdfRows,
      ageAnswers,
      drafts,
      consultRows,
      quizStops,
    ] = await Promise.all([
      prisma.session.count(),
      prisma.session.count({ where: { status: "completed" } }),
      // Отказы теперь считаем по журналу согласий: кнопка «Пока не
      // готовы» на «Условиях» убрана, и статус declined больше не
      // проставляется — он остался только у старых сессий.
      prisma.consentRecord.findMany({
        where: { type: "PD_PROCESSING" },
        orderBy: { createdAt: "desc" },
        select: { telegramId: true, action: true },
      }),
      prisma.offerEvent.findMany({ select: { telegramId: true, type: true } }),
      prisma.order.groupBy({ by: ["status"], _count: true }),
      prisma.consultRequest.groupBy({ by: ["status"], _count: true }),
      // Обезличенный счётчик ухода с экрана здоровья: по дням, без
      // привязки к людям. За 30 дней — чтобы цифра была про сейчас.
      prisma.dailyCounter.findMany({
        where: {
          name: "health_screen_exit",
          day: { gte: new Date(Date.now() - 30 * 24 * 3_600_000) },
        },
      }),
      prisma.offerEvent.findMany({
        where: { createdAt: { gte: since } },
        select: { telegramId: true, type: true, source: true },
      }),
      // Обратная связь за тот же период, что и воронка: один /stats —
      // один период, иначе цифры в нём начали бы жить по разным часам.
      prisma.analysisFeedback.findMany({ where: { createdAt: { gte: since } } }),
      prisma.pdfFeedback.findMany({ where: { createdAt: { gte: since } } }),
      prisma.answer.findMany({
        where: { questionNumber: 1 },
        orderBy: { createdAt: "asc" },
        select: { telegramId: true, answerText: true },
      }),
      prisma.pdfDraft.findMany({ select: { orderId: true, editedContent: true } }),
      prisma.consultRequest.findMany({
        select: {
          telegramId: true,
          source: true,
          status: true,
          lostReason: true,
          createdAt: true,
          contactedAt: true,
          paidAt: true,
          chatCreatedAt: true,
          doneAt: true,
        },
      }),
      // На каких вопросах останавливаются: берём те прохождения, где
      // первое напоминание за период уже ушло.
      prisma.quizReminder.findMany({
        where: { reminder1SentAt: { gte: since } },
        select: { reminder1QuestionNumber: true },
      }),
    ]);

    const healthExits = healthExitRows.reduce((sum, row) => sum + row.count, 0);

    // Текущее состояние согласия — последняя запись по человеку, а
    // записи пришли от новых к старым: первая встреченная и есть она.
    const pdState = new Map<string, string>();
    for (const record of pdRecords) {
      const key = String(record.telegramId);
      if (!pdState.has(key)) pdState.set(key, record.action);
    }
    const granted = [...pdState.values()].filter((a) => a === "GRANTED").length;
    const declined = [...pdState.values()].filter((a) => a === "DECLINED").length;

    // Считаем по пользователям, а не по событиям: один человек может
    // нажать «Купить» дважды, и это всё равно одна конверсия.
    const usersBy = (type: string) =>
      new Set(events.filter((e) => e.type === type).map((e) => String(e.telegramId)));
    const shown = usersBy("offer_shown");
    const pdfCard = usersBy("offer_pdf_details");
    const consultCard = usersBy("offer_consult_details");
    const sawExample = usersBy("example_clicked");
    const bought = usersBy("buy_clicked");
    const signedUp = usersBy("consult_signup");
    const skipped = usersBy("offer_declined");

    const upsellShown = usersBy("upsell_shown");
    const upsellDetails = usersBy("upsell_details");
    const upsellSignup = usersBy("upsell_signup");
    const upsellDeclined = usersBy("upsell_declined");
    const upsellExpired = usersBy("upsell_expired_click");

    const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "—");

    // «Из открывших карточку» — доля тех, кто дошёл до покупки именно
    // после того, как раскрыл подробности. Это и есть цена шага
    // «карточка → оплата», отдельно от показа.
    const line = (label: string, who: Set<string>, card: Set<string>) =>
      `${label}: ${who.size} (${pct(who.size, shown.size)} от показов, ` +
      `${pct(who.size, card.size)} от открывших карточку)`;

    const boughtAfterExample = [...bought].filter((id) => sawExample.has(id)).length;
    const withoutExample = [...shown].filter((id) => !sawExample.has(id));
    const boughtWithoutExample = [...bought].filter((id) => !sawExample.has(id)).length;

    // Строки отсортированы от старых к новым, и Map оставляет
    // последнее значение: у прошедшего анкету дважды берётся свежий
    // возраст, а не тот, что он называл месяцы назад.
    const ageByUser = new Map(ageAnswers.map((a) => [String(a.telegramId), Number(a.answerText)]));
    const editedByOrder = new Map(drafts.map((d) => [d.orderId, d.editedContent !== null]));
    const withConsult = new Set(consultRows.map((c) => String(c.telegramId)));

    // ── Оценка разбора ──────────────────────────────────────────────
    const aAsked = analysisRows.filter((r) => r.askedAt !== null);
    const aSkipped = analysisRows.filter((r) => r.skipReason !== null);
    const aAnswered: Answered<string>[] = analysisRows
      .filter((r) => r.rating !== null)
      .map((r) => ({ telegramId: r.telegramId, value: r.rating as string }));
    const aComments = analysisRows.filter((r) => r.comment !== null).length;

    const skipReasons = new Map<string, number>();
    for (const row of aSkipped) {
      skipReasons.set(row.skipReason!, (skipReasons.get(row.skipReason!) ?? 0) + 1);
    }

    const analysisBlock = [
      `Оценка разбора за ${days} дн.:`,
      `  запланировано: ${analysisRows.length}`,
      `  отправлено: ${aAsked.length}`,
      `  не отправлено: ${aSkipped.length}` +
        (skipReasons.size
          ? ` (${[...skipReasons].map(([r, n]) => `${r} ${n}`).join(", ")})`
          : ""),
      `  ответили: ${aAnswered.length} (${pct(aAnswered.length, aAsked.length)} от отправленных)`,
      `  ${distribution(aAnswered, ANALYSIS_LABELS)}`,
      `  комментариев: ${aComments}`,
      ...(aAnswered.length
        ? [
            "  по возрасту:",
            ...breakdown(aAnswered, ANALYSIS_LABELS, (r) =>
              ageGroup(ageByUser.get(String(r.telegramId)) ?? null)
            ),
          ]
        : []),
    ];

    // ── Результат плана ─────────────────────────────────────────────
    const pAsked = pdfRows.filter((r) => r.askedAt !== null);
    const pAnsweredRows = pdfRows.filter((r) => r.result !== null);
    const pAnswered: Answered<string>[] = pAnsweredRows.map((r) => ({
      telegramId: r.telegramId,
      value: r.result as string,
    }));
    const pComments = pdfRows.filter((r) => r.comment !== null).length;
    const orderByUser = new Map(pAnsweredRows.map((r) => [String(r.telegramId), r.orderId]));

    const pdfBlock = [
      `Результат плана за ${days} дн.:`,
      `  отправлено: ${pAsked.length}`,
      `  ответили: ${pAnswered.length} (${pct(pAnswered.length, pAsked.length)} от отправленных)`,
      `  ${distribution(pAnswered, PDF_LABELS)}`,
      `  комментариев: ${pComments}`,
      ...(pAnswered.length
        ? [
            "  правки админа:",
            ...breakdown(pAnswered, PDF_LABELS, (r) => {
              const orderId = orderByUser.get(String(r.telegramId));
              if (orderId === undefined) return null;
              return editedByOrder.get(orderId) ? "с правками" : "без правок";
            }),
            "  по возрасту:",
            ...breakdown(pAnswered, PDF_LABELS, (r) =>
              ageGroup(ageByUser.get(String(r.telegramId)) ?? null)
            ),
            "  консультация:",
            ...breakdown(pAnswered, PDF_LABELS, (r) =>
              withConsult.has(String(r.telegramId)) ? "записались" : "не записывались"
            ),
          ]
        : []),
    ];

    const feedbackLink = env.PUBLIC_BASE_URL
      ? `\n\nПодробно: ${env.PUBLIC_BASE_URL}/admin/feedback/analysis и ${env.PUBLIC_BASE_URL}/admin/feedback/pdf`
      : "";

    const byStatus = (rows: { status: string; _count: number }[], empty: string) =>
      rows.map((row) => `  ${row.status}: ${row._count}`).join("\n") || `  ${empty}`;

    await ctx.reply(
      buildOnboardingFunnel(funnelEvents, days) +
        `\n\n${buildExampleBlock(funnelEvents, days)}` +
        `\n\n${buildMenuBlock(funnelEvents, days)}` +
        `\n\n${buildQuizReminderBlock(funnelEvents, quizStops.map((r) => r.reminder1QuestionNumber), days)}` +
        `\n\n${buildConsultBlock({
          cardOpened: new Set(
            funnelEvents.filter((e) => e.type === "consult_card_opened").map((e) => String(e.telegramId))
          ).size,
          started: new Set(
            funnelEvents
              .filter((e) => e.type === "consult_request_started")
              .map((e) => String(e.telegramId))
          ).size,
          // Заявки за тот же период, что и события: иначе проценты
          // считались бы от разных множеств.
          requests: consultRows.filter((c) => c.createdAt >= since),
          days,
        })}` +
        `\n\nВсего пользователей: ${total}\n` +
        `Дали согласие на обработку данных: ${granted}\n` +
        `Отказались на согласии: ${declined}\n` +
        `Ушли с экрана здоровья за 30 дней: ${healthExits}\n` +
        `Завершили анкету: ${completed}\n\n` +
        `Экран выбора показан: ${shown.size}\n` +
        `Открыли карточку плана: ${pdfCard.size} (${pct(pdfCard.size, shown.size)})\n` +
        `Открыли карточку консультации: ${consultCard.size} (${pct(consultCard.size, shown.size)})\n` +
        `Смотрели пример плана: ${sawExample.size} (${pct(sawExample.size, shown.size)})\n` +
        `«Пока не нужно»: ${skipped.size} (${pct(skipped.size, shown.size)})\n\n` +
        `${line("Купили план", bought, pdfCard)}\n` +
        `${line("Записались на консультацию", signedUp, consultCard)}\n\n` +
        `Из тех, кто смотрел пример: ${boughtAfterExample} из ${sawExample.size} (${pct(boughtAfterExample, sawExample.size)})\n` +
        `Из тех, кто не смотрел: ${boughtWithoutExample} из ${withoutExample.length} (${pct(boughtWithoutExample, withoutExample.length)})\n\n` +
        `Заказы PDF:\n${byStatus(orders, "заказов пока нет")}\n\n` +
        `Заявки на консультацию:\n${byStatus(consults, "заявок пока нет")}\n\n` +
        `После PDF:\n` +
        `  предложений отправлено: ${upsellShown.size}\n` +
        `  открыли карточку: ${upsellDetails.size} (${pct(upsellDetails.size, upsellShown.size)})\n` +
        `  записались: ${upsellSignup.size} (${pct(upsellSignup.size, upsellShown.size)})\n` +
        `  «Пока не нужно»: ${upsellDeclined.size} (${pct(upsellDeclined.size, upsellShown.size)})\n` +
        `  нажали запись после срока: ${upsellExpired.size}\n\n` +
        `${analysisBlock.join("\n")}\n\n` +
        `${pdfBlock.join("\n")}${feedbackLink}`
    );
  });

  // Что человек разрешил и когда. Нужна, когда вопрос приходит в
  // переписке и лезть в админку долго.
  bot.command("consents", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const telegramId = parseTelegramId(ctx.match?.toString());
    if (telegramId === null) return ctx.reply("Использование: /consents <telegram_id>");

    const state = await getConsentState(telegramId);
    const line = (label: string, status: { action: string | null; at: Date | null }) => {
      if (!status.action) return `${label}: записей нет`;
      const word =
        status.action === "GRANTED" ? "дано" : status.action === "REVOKED" ? "отозвано" : "отказ";
      return `${label}: ${word}${status.at ? ` с ${formatMoscow(status.at)}` : ""}`;
    };

    const link = consentUrl(telegramId);
    await ctx.reply(
      `Согласия #${telegramId}:\n\n` +
        `${line("🔒 Обработка данных", state.PD_PROCESSING)}\n` +
        `${line("📬 Рассылка", state.MARKETING)}\n` +
        `${line("📄 Оферта", state.OFFER_ACCEPTANCE)}\n` +
        `${line("🤝 Передача специалисту", state.SPECIALIST_TRANSFER)}\n` +
        `${line("👶 Подтверждение о здоровье", state.HEALTH_SELF_DECLARATION)}` +
        (link ? `\n\nВся история: ${link}` : "")
    );
  });

  // Незакрытые заявки на консультацию со ссылками в админку.
  bot.command("consults", async (ctx) => {
    if (!isAdmin(ctx)) return;

    const requests = await prisma.consultRequest.findMany({
      where: { status: { in: ["NEW", "CONTACTED"] } },
      orderBy: { createdAt: "asc" },
    });
    if (!requests.length) return ctx.reply("Незакрытых заявок на консультацию нет.");

    const lines = requests.map((request) => {
      const hours = Math.floor((Date.now() - request.createdAt.getTime()) / 3_600_000);
      const mark = request.status === "NEW" && hours >= 20 ? "🔴 " : "";
      const who = request.parentUsername ? `@${request.parentUsername}` : "без username";
      const waiting = request.firstContact === "PENDING" ? ", ждём согласия родителя" : "";
      const link = consultUrl(request.id);
      return `${mark}#${request.id} — ${who}, ${request.status}, ${hours} ч${waiting}` + (link ? `\n${link}` : "");
    });

    await ctx.reply(`Незакрытые заявки (${requests.length}):\n\n${lines.join("\n\n")}`);
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
      await deliverRecommendation(bot.api, flow.telegramId, flow.chatId, flow.messages as [string, string]);
      await ctx.reply("Готово: разбор отправлен двумя сообщениями, следом показан оффер.");
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
  if (flow.messages.length < 2) {
    await ctx.reply(`Принято. Пришли сообщение ${flow.messages.length + 1} из 2.`);
  } else {
    flow.stage = "confirming";
    const preview = flow.messages.map((m, i) => `— Сообщение ${i + 1} —\n${m}`).join("\n\n");
    await ctx.reply(`Проверь перед отправкой:\n\n${preview}`);
    await ctx.reply("Всё верно? /confirm — отправить, /cancel — отменить.");
  }
  return true;
}
