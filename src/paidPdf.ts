// Генерация платного PDF: два обращения к Claude API.
//
//   P1 «План»  — system: промпт плана + тактика + нормы. На входе ВЫВОДЫ
//                анализа, ответы анкеты и два отправленных бесплатных
//                сообщения. На выходе внутренний план с точными цифрами:
//                фокус, что не менять, временные факторы, режим дня,
//                оценка, заметки для проверки. Родитель его не видит.
//   P2 «Текст» — system: только промпт письма. На входе полный ответ P1
//                и те же два бесплатных сообщения. На выходе текст для
//                PDF: рекомендации, вступление и примечание к режиму.
//
// Время в таблице режима берётся только из P1. P2 время не генерирует —
// иначе два шага начали бы расходиться в цифрах.

import { env } from "./env";
import { ApiCallUsage, callClaude, formatUsageLine } from "./claudeApi";
import { METHODOLOGY_TACTICS } from "./methodology-tactics";
import { NORMS } from "./methodology-norms";
import {
  PLAN_PROMPT,
  RelaxationGroup,
  WRITER_PROMPT,
  isRelaxationMemoReady,
  relaxationGroupForAge,
} from "./prompts";

// ── Структура контента PDF ──────────────────────────────────────────

export interface ScheduleRow {
  time: string;
  event: string;
  duration: string;
}

export interface ScheduleVariant {
  title: string;
  rows: ScheduleRow[];
}

// Одинаковая и для aiContent, и для editedContent: админ правит ровно
// то, что сгенерировала модель, и рендер не знает, чья это версия.
export interface PdfContent {
  recommendations: string;
  schedule: {
    intro: string;
    note: string;
    variants: ScheduleVariant[];
  };
  relaxationGroup: RelaxationGroup;
}

export interface PdfDraftResult {
  content: PdfContent;
  rawPlan: string;
  reviewerNotes: string;
  usage: ApiCallUsage[];
  memoReady: boolean;
}

// Исходные данные бесплатной части, на которых строится платный план.
export interface FreeAnalysisInput {
  analysis: string;
  questionnaire: string;
  message1: string;
  message2: string;
  ageMonths: number;
}

// Красный флаг — штатный исход, а не сбой: P1 и P2 не запускаем,
// заказ уходит в FAILED, родителю ничего. Отдельный тип, чтобы
// вызывающий код отличил это от поломки.
export class PaidRedFlagError extends Error {
  constructor() {
    super("В выводах анализа красный флаг — решить вручную.");
    this.name = "PaidRedFlagError";
  }
}

const RED_FLAG_MARKER = "ФЛАГИ: КРАСНЫЙ";
const MAX_TOKENS = 4000;

// ── Разбор ответов по разделителям ──────────────────────────────────

// Делит ответ на секции вида ===ИМЯ===. Всё до первого разделителя
// отбрасывается: модель иногда начинает с вводной фразы.
function splitSections(text: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const parts = text.split(/^===([А-ЯЁ: ]+)===\s*$/m);

  for (let i = 1; i < parts.length; i += 2) {
    sections[parts[i].trim()] = (parts[i + 1] ?? "").trim();
  }
  return sections;
}

function requireSections(sections: Record<string, string>, required: string[], step: string) {
  const missing = required.filter((name) => !sections[name]);
  if (missing.length) {
    throw new Error(`Шаг «${step}»: в ответе нет разделов ${missing.map((m) => `===${m}===`).join(", ")}.`);
  }
}

// ── Разбор режима дня ───────────────────────────────────────────────

// Строка режима: «ЧЧ:ММ — событие» или «ЧЧ:ММ — событие, длительность».
const SCHEDULE_ROW = /^(\d{1,2}:\d{2})\s*[—–-]\s*(.+)$/;

interface ParsedSchedule {
  variants: ScheduleVariant[];
  // Строки, которые не удалось разобрать, и строки ПРОВЕРКА — они не
  // идут в PDF, но теряться не должны: уходят в заметки для проверки.
  notes: string[];
}

function parseSchedule(block: string): ParsedSchedule {
  const variants: ScheduleVariant[] = [];
  const notes: string[] = [];

  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("ВАРИАНТ:")) {
      variants.push({ title: line.slice("ВАРИАНТ:".length).trim() || "Режим дня", rows: [] });
      continue;
    }
    if (line.startsWith("ПРОВЕРКА:")) {
      notes.push(line);
      continue;
    }

    const match = line.match(SCHEDULE_ROW);
    if (!match) {
      notes.push(`не разобрано: ${line}`);
      continue;
    }

    // Единственный вариант без заголовка — заведём его сами, иначе
    // строки будет некуда класть.
    if (!variants.length) variants.push({ title: "Режим дня", rows: [] });

    // Длительность, если есть, отделена последней запятой.
    const rest = match[2].trim();
    const comma = rest.lastIndexOf(",");
    const hasDuration = comma !== -1 && /\d/.test(rest.slice(comma + 1));

    variants[variants.length - 1].rows.push({
      time: match[1],
      event: (hasDuration ? rest.slice(0, comma) : rest).trim(),
      duration: hasDuration ? rest.slice(comma + 1).trim() : "",
    });
  }

  return { variants, notes };
}

// ── Один шаг с повтором ─────────────────────────────────────────────

// Одна повторная попытка этого же шага: модель иногда промахивается
// мимо формата, второй заход обычно попадает. Повторяем ровно тот шаг,
// который не удался, — предыдущий переигрывать незачем.
async function withOneRetry<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (firstError) {
    console.error("Платный PDF: первая попытка шага не удалась, повторяю:", firstError);
    return attempt();
  }
}

// ── Сборка ──────────────────────────────────────────────────────────

function buildPlanUserMessage(input: FreeAnalysisInput): string {
  return [
    "=== ВЫВОДЫ АНАЛИЗА АНКЕТЫ ===",
    input.analysis,
    "",
    "=== ОТВЕТЫ АНКЕТЫ ===",
    input.questionnaire,
    "",
    "=== СООБЩЕНИЕ 1, УЖЕ ОТПРАВЛЕННОЕ РОДИТЕЛЮ (разбор режима) ===",
    input.message1,
    "",
    "=== СООБЩЕНИЕ 2, УЖЕ ОТПРАВЛЕННОЕ РОДИТЕЛЮ (вероятные причины) ===",
    input.message2,
  ].join("\n");
}

// Анкету и методологию в P2 намеренно не передаём: его работа —
// переписать готовый план человеческим языком, а не пересчитать его.
function buildWriterUserMessage(rawPlan: string, input: FreeAnalysisInput): string {
  return [
    "=== ПЛАН (шаг 1) ===",
    rawPlan,
    "",
    "=== СООБЩЕНИЕ 1, УЖЕ ОТПРАВЛЕННОЕ РОДИТЕЛЮ ===",
    input.message1,
    "",
    "=== СООБЩЕНИЕ 2, УЖЕ ОТПРАВЛЕННОЕ РОДИТЕЛЮ ===",
    input.message2,
  ].join("\n");
}

export async function generatePdfDraft(
  input: FreeAnalysisInput,
  sessionId: string,
  // Комментарий админа при перегенерации (этап 3). Уходит в user-сообщение P1.
  reviewerComment?: string
): Promise<PdfDraftResult> {
  if (input.analysis.includes(RED_FLAG_MARKER)) {
    throw new PaidRedFlagError();
  }

  const usage: ApiCallUsage[] = [];
  const notes: string[] = [];

  // ── P1: план
  const planUser = reviewerComment
    ? `${buildPlanUserMessage(input)}\n\n=== КОММЕНТАРИЙ ПРОВЕРЯЮЩЕГО ===\n${reviewerComment}`
    : buildPlanUserMessage(input);

  const plan = await withOneRetry(async () => {
    const result = await callClaude({
      step: "pdf_plan",
      model: env.PDF_PLAN_MODEL,
      system: `${PLAN_PROMPT}\n\n${METHODOLOGY_TACTICS}\n\n${NORMS}`,
      userText: planUser,
      sessionId,
      maxTokens: MAX_TOKENS,
    });
    usage.push(result.usage);

    const sections = splitSections(result.text);
    requireSections(sections, ["ФОКУС", "РЕЖИМ"], "pdf_plan");
    return { text: result.text, sections };
  });

  const schedule = parseSchedule(plan.sections["РЕЖИМ"]);
  notes.push(...schedule.notes);
  if (plan.sections["ЗАМЕТКИ ДЛЯ ПРОВЕРКИ"]) notes.push(plan.sections["ЗАМЕТКИ ДЛЯ ПРОВЕРКИ"]);
  if (!schedule.variants.length) notes.push("⚠️ В ответе P1 не разобрано ни одной строки режима");

  // ── P2: текст
  const writer = await withOneRetry(async () => {
    const result = await callClaude({
      step: "pdf_writer",
      model: env.PDF_WRITER_MODEL,
      system: WRITER_PROMPT,
      userText: buildWriterUserMessage(plan.text, input),
      sessionId,
      maxTokens: MAX_TOKENS,
    });
    usage.push(result.usage);

    const sections = splitSections(result.text);
    requireSections(sections, ["РЕКОМЕНДАЦИИ", "РЕЖИМ: ВСТУПЛЕНИЕ", "РЕЖИМ: ПРИМЕЧАНИЕ"], "pdf_writer");
    return sections;
  });

  const relaxationGroup = relaxationGroupForAge(input.ageMonths);
  const memoReady = isRelaxationMemoReady(relaxationGroup);
  if (!memoReady) {
    notes.push(`⚠️ Памятка для группы ${relaxationGroup} не готова`);
  }

  return {
    content: {
      recommendations: writer["РЕКОМЕНДАЦИИ"],
      schedule: {
        intro: writer["РЕЖИМ: ВСТУПЛЕНИЕ"],
        note: writer["РЕЖИМ: ПРИМЕЧАНИЕ"],
        variants: schedule.variants,
      },
      relaxationGroup,
    },
    rawPlan: plan.text,
    reviewerNotes: notes.join("\n"),
    usage,
    memoReady,
  };
}

export { formatUsageLine };
