// Сколько токенов занимают промпты — чтобы сравнить «было и стало»
// после разделения генерации на два шага.
//
// Запуск из корня проекта:
//   npx tsx scripts/count-tokens.ts
//   npx tsx scripts/count-tokens.ts claude-sonnet-5
//
// Нужен только ANTHROPIC_API_KEY (возьмётся из .env). Эндпоинт подсчёта
// токенов бесплатный, денег этот скрипт не тратит.
//
// В сборку бота скрипт не входит: tsconfig собирает только src/.

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { METHODOLOGY_ANALYSIS } from "../src/methodology-analysis";
import { VOICE_PROMPT } from "../src/voicePrompt";
import { METHODOLOGY } from "../src/methodology";

const model = process.argv[2] ?? "claude-opus-5";

const PROMPTS: Array<{ name: string; text: string }> = [
  { name: "METHODOLOGY_ANALYSIS (шаг 1)", text: METHODOLOGY_ANALYSIS },
  { name: "VOICE_PROMPT (шаг 2)", text: VOICE_PROMPT },
  { name: "METHODOLOGY (старая, один вызов)", text: METHODOLOGY },
];

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Не задан ANTHROPIC_API_KEY — положи его в .env или передай в окружении.");
    process.exit(1);
  }
  const client = new Anthropic({ apiKey });

  console.log(`Модель: ${model}\n`);
  const counts: number[] = [];

  for (const prompt of PROMPTS) {
    const { input_tokens } = await client.messages.countTokens({
      model,
      system: prompt.text,
      // Эндпоинту нужно хотя бы одно сообщение; на счёт системного
      // промпта этот символ влияет пренебрежимо мало.
      messages: [{ role: "user", content: "." }],
    });
    counts.push(input_tokens);
    console.log(`${prompt.name}: ${input_tokens} токенов (${prompt.text.length} символов)`);
  }

  const [analysis, voice, old] = counts;
  console.log(`\nДва шага вместе: ${analysis + voice} токенов на входе за разбор.`);
  console.log(`Старый один вызов: ${old} токенов.`);
  const diff = old - (analysis + voice);
  console.log(
    diff >= 0
      ? `Экономия на входе: ${diff} токенов за разбор.`
      : `Стало больше на ${-diff} токенов за разбор.`
  );
  console.log(
    "\nЭто только системные промпты. К ним на каждый вызов добавляются анкета" +
      "\n(шаг 1) или блок ВЫВОДЫ (шаг 2) плюс выходные токены."
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
