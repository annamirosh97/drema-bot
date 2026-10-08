// Загрузка промптов платной части из prompts/*.md.
//
// Промпты лежат отдельными файлами, а не константами в коде: их правит
// методолог, и диффы в markdown читаются куда легче, чем в шаблонной
// строке TypeScript. Файлы читаются один раз при старте процесса —
// дальше промпт уже собран, и обращения к диску на каждый заказ нет.
//
// Два преобразования при сборке:
//  - вырезается HTML-комментарий в начале файла (служебная шапка для
//    методолога, модели она не нужна);
//  - в P1 плейсхолдер {{EXAMPLE_1_INPUT}} заменяется на вход примера 1,
//    собранный из voicePrompt.ts. Так пример живёт в одном месте: если
//    методолог поправит его в промпте шага 2, он поедет и сюда.

import fs from "fs";
import path from "path";
import { VOICE_PROMPT } from "./voicePrompt";

// Собранный код лежит в dist/, а prompts/ и content/ — в корне проекта,
// поэтому путь считаем от файла вверх, а не от текущей рабочей папки:
// бот может быть запущен из любой.
export const PROJECT_ROOT = path.resolve(__dirname, "..");

function readProjectFile(relativePath: string): string {
  const full = path.join(PROJECT_ROOT, relativePath);
  try {
    return fs.readFileSync(full, "utf8");
  } catch (error) {
    throw new Error(`Не удалось прочитать ${relativePath} (искал в ${full}): ${error}`);
  }
}

// Шапка для методолога: <!-- ... --> в самом начале файла.
function stripLeadingHtmlComment(text: string): string {
  return text.replace(/^\s*<!--[\s\S]*?-->\s*/, "").trim();
}

// Вход примера 1 из промпта шага 2: блок ВЫВОДЫ до строки «**ОТВЕТ:**».
// Нужен как есть в примере P1, чтобы оба шага учились на одном кейсе.
function buildExample1Input(): string {
  const marker = "### Пример 1.";
  const start = VOICE_PROMPT.indexOf(marker);
  if (start === -1) throw new Error("В VOICE_PROMPT не найден пример 1 — нечего подставить в P1.");

  const block = VOICE_PROMPT.slice(start);
  const answerAt = block.indexOf("**ОТВЕТ:**");
  if (answerAt === -1) throw new Error("В примере 1 нет блока «**ОТВЕТ:**».");

  // Отрезаем заголовок примера: он про оформление, а не про данные.
  const body = block.slice(0, answerAt);
  const findingsAt = body.indexOf("**ВЫВОДЫ:**");
  if (findingsAt === -1) throw new Error("В примере 1 нет блока «**ВЫВОДЫ:**».");

  return body.slice(findingsAt).trim();
}

function loadPlanPrompt(): string {
  const raw = stripLeadingHtmlComment(readProjectFile("prompts/paid-pdf-p1-plan.md"));
  const placeholder = "{{EXAMPLE_1_INPUT}}";
  if (!raw.includes(placeholder)) {
    throw new Error(`В prompts/paid-pdf-p1-plan.md нет плейсхолдера ${placeholder}.`);
  }
  return raw.replace(placeholder, buildExample1Input());
}

export const PLAN_PROMPT = loadPlanPrompt();
export const WRITER_PROMPT = stripLeadingHtmlComment(readProjectFile("prompts/paid-pdf-p2-writer.md"));

// ── Памятки по расслаблению ─────────────────────────────────────────

export type RelaxationGroup = "4-6" | "6-9" | "9-12";

// Возраст — скорректированный при недоношенности (см. вызывающий код).
export function relaxationGroupForAge(months: number): RelaxationGroup {
  if (months < 6) return "4-6";
  if (months < 9) return "6-9";
  return "9-12";
}

export function readRelaxationMemo(group: RelaxationGroup): string {
  return readProjectFile(`content/relaxation/${group}.md`).trim();
}

// Памятка ещё не написана — такой заказ нельзя отправлять родителю.
// Маркер проставлен прямо в файле заглушки, см. content/relaxation/.
export function isRelaxationMemoReady(group: RelaxationGroup): boolean {
  return !readRelaxationMemo(group).includes("ЗАГЛУШКА");
}
