// Что о здоровье малышей уже лежит в базе.
//
// Скрипт ТОЛЬКО СЧИТАЕТ И ПОКАЗЫВАЕТ. Он ничего не удаляет и не меняет —
// ни одной записи. Решение об удалении принимается после разговора с
// юристом, и тогда это будет отдельный скрипт, который надо будет
// написать и запустить осознанно.
//
// Запуск:
//   DATABASE_URL=... npx tsx scripts/health-data-report.ts
// На Railway удобнее через консоль сервиса, где DATABASE_URL уже задан.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Вопросы, которые удалены из анкеты 15.10.2026. Ответы на них остались
// в базе у всех, кто успел пройти анкету раньше.
const HEALTH_QUESTIONS = [
  { number: 18, title: "диагнозы и особые состояния" },
  { number: 19, title: "проблемы с ЖКТ" },
  { number: 20, title: "анемия" },
];

// Строка блока ВЫВОДЫ, в которой раньше жили жёлтые и красные флаги.
const FLAGS_LINE = /^ФЛАГИ:\s*(.+)$/im;

function isEmptyFlags(value: string): boolean {
  return /^(нет|—|-)\.?$/i.test(value.trim());
}

async function main() {
  console.log("Отчёт по сохранённым данным о здоровье");
  console.log("Ничего не удаляется, только подсчёт.\n");

  // ── Ответы на удалённые вопросы ───────────────────────────────────
  console.log("Ответы на удалённые вопросы анкеты:");
  let answersTotal = 0;
  const peopleWithAnswers = new Set<string>();

  for (const question of HEALTH_QUESTIONS) {
    const rows = await prisma.answer.findMany({
      where: { questionNumber: question.number },
      select: { telegramId: true, answerText: true },
    });
    answersTotal += rows.length;
    for (const row of rows) peopleWithAnswers.add(String(row.telegramId));

    // Распределение ответов: по нему видно, насколько эти данные
    // содержательны. Тексты ответов короткие и из фиксированных
    // вариантов, так что показать их целиком безопаснее, чем гадать.
    const byValue = new Map<string, number>();
    for (const row of rows) byValue.set(row.answerText, (byValue.get(row.answerText) ?? 0) + 1);
    const breakdown = [...byValue.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => `      ${count}× ${value}`)
      .join("\n");

    console.log(`  Вопрос ${question.number} (${question.title}): ${rows.length}`);
    if (breakdown) console.log(breakdown);
  }
  console.log(`  Всего ответов: ${answersTotal}, у ${peopleWithAnswers.size} человек\n`);

  // ── Жёлтые флаги в сессиях ────────────────────────────────────────
  const sessions = await prisma.session.findMany({ select: { telegramId: true, yellowFlags: true } });
  const withFlags = sessions.filter((s) => s.yellowFlags.length > 0);

  const flagCounts = new Map<string, number>();
  for (const session of withFlags) {
    for (const flag of session.yellowFlags) flagCounts.set(flag, (flagCounts.get(flag) ?? 0) + 1);
  }

  console.log(`Сессии с заполненным yellowFlags: ${withFlags.length} из ${sessions.length}`);
  for (const [flag, count] of [...flagCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count}× ${flag}`);
  }
  console.log();

  // ── Флаги в сохранённых блоках ВЫВОДЫ ─────────────────────────────
  const recommendations = await prisma.recommendation.findMany({
    where: { analysis: { not: null } },
    select: { telegramId: true, analysis: true },
  });

  const withFlagLine: { telegramId: string; value: string }[] = [];
  for (const row of recommendations) {
    const match = row.analysis?.match(FLAGS_LINE);
    if (!match || isEmptyFlags(match[1])) continue;
    withFlagLine.push({ telegramId: String(row.telegramId), value: match[1].trim() });
  }

  console.log(`Сохранённых блоков ВЫВОДЫ: ${recommendations.length}`);
  console.log(`Из них со строкой «ФЛАГИ:» не «нет»: ${withFlagLine.length}`);
  for (const row of withFlagLine) console.log(`  #${row.telegramId}: ФЛАГИ: ${row.value}`);
  console.log();

  // ── Итог ──────────────────────────────────────────────────────────
  const touched = new Set([
    ...peopleWithAnswers,
    ...withFlags.map((s) => String(s.telegramId)),
    ...withFlagLine.map((r) => r.telegramId),
  ]);
  console.log(`Итого людей, у которых хранится хоть что-то о здоровье: ${touched.size}`);
  console.log("\nНичего не удалено. Это только отчёт.");
}

main()
  .catch((error) => {
    console.error("Отчёт не собрался:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
