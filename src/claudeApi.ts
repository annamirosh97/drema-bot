// Обращение к Claude API: по заполненной анкете готовит черновик разбора.
// Вызывается автоматически, как только пользователь подтвердил анкету
// (см. finishQuestionnaire в src/engine.ts). Результат уходит админу
// на проверку, пользователю сам по себе он не отправляется.
//
// Два шага вместо одного:
//   1. АНАЛИЗ  — системный промпт METHODOLOGY_ANALYSIS, на входе анкета,
//      на выходе блок ВЫВОДЫ. Родителю этот текст не показывается.
//   2. ПИСЬМО  — системный промпт VOICE_PROMPT, на входе блок ВЫВОДЫ,
//      на выходе два сообщения, разделённые маркерами.
// Так дешевле (в каждый вызов уходит только нужная часть методологии)
// и текст получается ближе по тону к ручной работе.

import Anthropic from "@anthropic-ai/sdk";
import { env } from "./env";
import { METHODOLOGY_ANALYSIS } from "./methodology-analysis";
import { VOICE_PROMPT } from "./voicePrompt";

// ── Цены ────────────────────────────────────────────────────────────

// Доллары за миллион токенов. ПРОВЕРИТЬ АКТУАЛЬНОСТЬ: цены меняются,
// сверяться с anthropic.com/pricing. Сверено 01.10.2026.
const PRICE_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

// Запись в кэш дороже обычного входа, чтение из кэша — заметно дешевле.
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

// Незнакомая модель — не повод падать: пишем null и считаем токены дальше.
function computeCostUsd(model: string, u: UsageCounters): number | null {
  const price = PRICE_PER_MTOK[model];
  if (!price) return null;
  const input =
    u.inputTokens * price.input +
    u.cacheCreationTokens * price.input * CACHE_WRITE_MULTIPLIER +
    u.cacheReadTokens * price.input * CACHE_READ_MULTIPLIER;
  return (input + u.outputTokens * price.output) / 1_000_000;
}

// ── Что отдаём наружу ───────────────────────────────────────────────

interface UsageCounters {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

// Шаги бесплатной части (analysis, writer) и платной (pdf_plan, pdf_writer).
export type ApiStep = "analysis" | "writer" | "pdf_plan" | "pdf_writer";

export interface ApiCallUsage extends UsageCounters {
  step: ApiStep;
  model: string;
  sessionId: string;
  durationMs: number;
  stopReason: string | null;
  costUsd: number | null;
}

export interface RecommendationDraft {
  analysis: string;
  message1: string;
  message2: string;
  usage: ApiCallUsage[];
  // Непустой список означает: отправлять можно, но админу стоит взглянуть.
  warnings: string[];
}

// Красный флаг — не сбой, а штатный исход: черновик не создаём,
// родителю ничего не шлём. Отдельный тип, чтобы вызывающий код отличил
// это от поломки и написал админу по делу.
export class RedFlagError extends Error {
  constructor(public readonly analysis: string) {
    super("В анкете красный флаг — черновик не создан.");
    this.name = "RedFlagError";
  }
}

// ── Один вызов модели ───────────────────────────────────────────────

const MAX_TOKENS = 1500;
const TELEGRAM_MESSAGE_LIMIT = 4096;

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

export interface ClaudeCallOptions {
  step: ApiStep;
  model: string;
  system: string;
  userText: string;
  sessionId: string;
  maxTokens?: number;
  // Рассуждение модели перед ответом. Выключено по умолчанию: оно
  // тратит токены из того же лимита, что и сам ответ. Включать там, где
  // в промпте много правил и важно, чтобы модель их соблюдала —
  // с выключенным рассуждением Opus 5 следует инструкциям заметно хуже.
  // Вместе с ним обязательно поднимать maxTokens.
  thinking?: boolean;
  // Глубина рассуждения: low дешевле и быстрее, high — тщательнее.
  // Имеет смысл только вместе с thinking.
  effort?: "low" | "medium" | "high";
}

// Единственное место, где бот обращается к модели. Повторы при 429, 5xx
// и overloaded делает сам SDK (maxRetries по умолчанию 2) — своего цикла
// повторов здесь нет. Логирование расхода тоже тут, чтобы ни один вызов
// не прошёл мимо [claude-usage].
export async function callClaude({
  step,
  model,
  system,
  userText,
  sessionId,
  maxTokens = MAX_TOKENS,
  thinking = false,
  effort,
}: ClaudeCallOptions): Promise<{ text: string; usage: ApiCallUsage }> {
  const startedAt = Date.now();

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    // На Opus 5 рассуждение включено по умолчанию, поэтому выключать его
    // нужно явно — иначе оно съест лимит, рассчитанный только на ответ.
    thinking: thinking ? { type: "adaptive" } : { type: "disabled" },
    ...(effort ? { output_config: { effort } } : {}),
    system,
    messages: [{ role: "user", content: userText }],
  });

  const counters: UsageCounters = {
    inputTokens: response.usage.input_tokens ?? 0,
    outputTokens: response.usage.output_tokens ?? 0,
    cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
  };

  const usage: ApiCallUsage = {
    step,
    model,
    sessionId,
    ...counters,
    durationMs: Date.now() - startedAt,
    stopReason: response.stop_reason,
    costUsd: computeCostUsd(model, counters),
  };

  // Одна строка JSON на вызов — чтобы находить её в логах хостинга поиском
  // по [claude-usage] и выгружать для сравнения моделей.
  console.log(`[claude-usage] ${JSON.stringify(usage)}`);

  if (response.stop_reason === "refusal") {
    throw new Error(`Шаг «${step}»: модель отказалась отвечать.`);
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error(`Шаг «${step}»: ответ не поместился в ${maxTokens} токенов и оборвался.`);
  }

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  if (!text) throw new Error(`Шаг «${step}»: модель вернула ответ без текста.`);

  return { text, usage };
}

// ── Шаг 1: анализ ───────────────────────────────────────────────────

// Красный флаг описан в методологии как единственная строка ответа.
const RED_FLAG_MARKER = "ФЛАГИ: КРАСНЫЙ";

// Минимальный признак, что перед нами блок ВЫВОДЫ, а не что-то иное.
const REQUIRED_ANALYSIS_FIELDS = ["ВОЗРАСТ:", "ФАКТЫ", "ГИПОТЕЗЫ"];

function missingAnalysisFields(analysis: string): string[] {
  return REQUIRED_ANALYSIS_FIELDS.filter((field) => !analysis.includes(field));
}

// ── Шаг 2: письмо ───────────────────────────────────────────────────

const MARKER_1 = "===СООБЩЕНИЕ 1===";
const MARKER_2 = "===СООБЩЕНИЕ 2===";

// Разметка, которую Telegram не покажет как разметку: в тексте для
// родителя она выглядит мусором. Не повод не отправлять, но админу
// об этом сообщаем.
const MARKDOWN_HINTS = ["**", "##", "`"];
// Выключенное thinking на Opus 5 изредка протекает тегом в видимый текст.
const LEAK_HINTS = ["<thinking", "</thinking"];

// Авторские тире — то, что промпт шага 2 запрещает, а модель всё равно
// ставит. Полностью их отловить нельзя: отличить «Ритуал — это…» (можно)
// от «вечер длиннее — и это заметно» (нельзя) без разбора грамматики не
// получится. Поэтому ловим только заведомо лишние: тире перед союзом,
// то есть ровно вместо запятой. Остальное видно по счётчику.
const AUTHORIAL_DASH = /—\s+(и|но|а|однако|зато|поэтому|потому что|хотя)[\s,]/g;

function countDashes(text: string): number {
  // Только настоящее тире. Диапазоны чисел пишутся коротким знаком
  // «15–20» и правилом разрешены, их не считаем.
  return (text.match(/—/g) ?? []).length;
}

function splitByMarkers(text: string): { message1: string; message2: string } {
  const start1 = text.indexOf(MARKER_1);
  const start2 = text.indexOf(MARKER_2);
  if (start1 === -1 || start2 === -1 || start2 < start1) {
    throw new Error(
      `Шаг «writer»: в ответе нет обоих маркеров. Начало ответа: ${text.slice(0, 200)}`
    );
  }

  const message1 = text.slice(start1 + MARKER_1.length, start2).trim();
  const message2 = text.slice(start2 + MARKER_2.length).trim();

  if (!message1 || !message2) {
    throw new Error("Шаг «writer»: один из текстов между маркерами пустой.");
  }
  for (const [label, body] of [
    ["первое", message1],
    ["второе", message2],
  ] as const) {
    if (body.length > TELEGRAM_MESSAGE_LIMIT) {
      throw new Error(
        `Шаг «writer»: ${label} сообщение длиннее ${TELEGRAM_MESSAGE_LIMIT} символов (${body.length}) — Telegram его не примет.`
      );
    }
  }

  return { message1, message2 };
}

function collectWarnings(message1: string, message2: string): string[] {
  const warnings: string[] = [];
  for (const [label, body] of [
    ["сообщении 1", message1],
    ["сообщении 2", message2],
  ] as const) {
    const markdown = MARKDOWN_HINTS.filter((hint) => body.includes(hint));
    if (markdown.length) {
      warnings.push(`в ${label} осталась разметка: ${markdown.join(" ")}`);
    }
    if (LEAK_HINTS.some((hint) => body.includes(hint))) {
      warnings.push(`в ${label} протёк служебный тег размышлений`);
    }

    const beforeConjunction = body.match(AUTHORIAL_DASH) ?? [];
    if (beforeConjunction.length) {
      warnings.push(
        `в ${label} тире вместо запятой (${beforeConjunction.length}): ` +
          beforeConjunction.map((m) => `«${m.trim()}…»`).join(", ")
      );
    }
    const dashes = countDashes(body);
    if (dashes > 4) {
      warnings.push(`в ${label} всего тире: ${dashes} — стоит пробежать глазами`);
    }
  }
  return warnings;
}

// ── Сборка ──────────────────────────────────────────────────────────

// Один повтор на шаг: модель иногда промахивается мимо формата, и второй
// заход обычно попадает. Повторяем ровно тот шаг, который не удался.
async function withOneRetry<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (firstError) {
    console.error("Первая попытка не удалась, повторяю:", firstError);
    return attempt();
  }
}

// Бросает понятную ошибку на любой нештатной ситуации: вызывающий код
// её ловит, пишет админу и предлагает собрать разбор вручную. Ронять
// бота нельзя — пользователь свою анкету уже сдал.
export async function generateRecommendationDraft(
  prepText: string,
  sessionId: string
): Promise<RecommendationDraft> {
  const usage: ApiCallUsage[] = [];

  const analysisResult = await withOneRetry(async () => {
    const result = await callClaude({
      step: "analysis",
      model: env.ANALYSIS_MODEL,
      system: METHODOLOGY_ANALYSIS,
      userText: `Вот заполненная анкета:\n\n${prepText}`,
      sessionId,
    });
    usage.push(result.usage);

    // Красный флаг проверяем до разбора полей: в таком ответе методология
    // требует только одну строку, остальных полей там и не должно быть.
    if (result.text.includes(RED_FLAG_MARKER)) return result;

    const missing = missingAnalysisFields(result.text);
    if (missing.length) {
      throw new Error(
        `Шаг «analysis»: в ответе нет полей ${missing.join(", ")}. Начало ответа: ${result.text.slice(0, 200)}`
      );
    }
    return result;
  });

  if (analysisResult.text.includes(RED_FLAG_MARKER)) {
    throw new RedFlagError(analysisResult.text);
  }

  const writerResult = await withOneRetry(async () => {
    const result = await callClaude({
      step: "writer",
      model: env.WRITER_MODEL,
      system: VOICE_PROMPT,
      userText: analysisResult.text,
      sessionId,
      // В промпте шага 2 полтора десятка правил голоса и блок
      // самопроверки. С выключенным рассуждением модель их проговаривает
      // мимо: в текстах оставались авторские тире, которые правило прямо
      // запрещает. Низкой глубины хватает, чтобы она прошла по
      // самопроверке, и это дешевле остальных уровней.
      thinking: true,
      effort: "low",
      // Рассуждение тратит токены из общего лимита, поэтому его мало
      // поднять — без запаса ответ оборвётся на середине второго
      // сообщения. Проверка на stop_reason max_tokens это поймает.
      maxTokens: 8000,
    });
    usage.push(result.usage);
    return { ...result, ...splitByMarkers(result.text) };
  });

  return {
    analysis: analysisResult.text,
    message1: writerResult.message1,
    message2: writerResult.message2,
    usage,
    warnings: collectWarnings(writerResult.message1, writerResult.message2),
  };
}

// Короткая строка для сообщения админу: сколько стоил этот разбор.
export function formatUsageLine(usage: ApiCallUsage[]): string {
  const parts = usage.map(
    (u) => `${u.step} ${u.inputTokens}→${u.outputTokens} (${formatUsd(u.costUsd)})`
  );
  const total = usage.reduce((sum, u) => sum + (u.costUsd ?? 0), 0);
  const incomplete = usage.some((u) => u.costUsd === null) ? " и ещё, цена модели неизвестна" : "";
  return `Токены и цена: ${parts.join(", ")}. Всего ${formatUsd(total)}${incomplete}.`;
}

export function formatUsd(value: number | null): string {
  return value === null ? "цена неизвестна" : `$${value.toFixed(4)}`;
}
