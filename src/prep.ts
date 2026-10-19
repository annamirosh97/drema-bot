// Текстовый дамп «Вопрос / Ответ» по конкретному родителю.
//
// Лежит отдельным файлом, а не в engine.ts, потому что нужен сразу
// трём местам: самому движку (вход для Claude), веб-админке и пакету
// заявки на консультацию. Если бы функция осталась в engine.ts,
// src/consult.ts пришлось бы импортировать движок, а движок и так
// импортирует consult.ts — получился бы круг.

import { prisma } from "./prisma";
import { currentAttempt } from "./attempt";
import { QuestionDef, getQuestion } from "./questions";

export function safeGetQuestion(number: number): QuestionDef | null {
  try {
    return getQuestion(number);
  } catch {
    return null;
  }
}

// По умолчанию собирает текущее прохождение анкеты. Номер передаётся
// явно там, где нужно именно прошлое: в пакете заявки на консультацию и
// в генерации плана по оплаченному заказу — родитель платил за ту
// анкету, которую заполнил тогда.
export async function buildPrepText(telegramId: bigint, attempt?: number): Promise<string> {
  const rows = await prisma.answer.findMany({
    where: { telegramId, attempt: attempt ?? (await currentAttempt(telegramId)) },
    orderBy: { questionNumber: "asc" },
  });

  const qaLines: string[] = [];
  const addenda: string[] = [];

  for (const r of rows) {
    if (r.questionNumber === -3 || r.questionNumber === 30 || r.questionNumber === 31) continue;
    if (r.questionNumber === 99) {
      addenda.push(r.answerText);
      continue;
    }
    const q = safeGetQuestion(r.questionNumber);
    const label = q ? q.text.replace(/\n/g, " ") : `Вопрос ${r.questionNumber}`;
    qaLines.push(`Вопрос: ${label}\nОтвет: ${r.answerText}`);
  }

  let out = qaLines.join("\n\n") || "Нет сохранённых ответов.";
  if (addenda.length) out += `\n\n— Дополнительно от пользователя —\n${addenda.join("\n")}`;
  // Строка «Обратить внимание» с жёлтыми флагами убрана 15.10.2026:
  // флагов больше нет, и подмешивать их в вход для модели нечего.
  return out;
}
