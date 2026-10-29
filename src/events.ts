// Журнал событий: единственное место, где они пишутся.
//
// До 20.10.2026 запись была размазана по пяти помощникам в четырёх
// файлах, и у каждого были свои правила: онбординг дедуплицировался
// «раз на человека», остальные писались каждый раз. Из-за этого по
// одной и той же таблице нельзя было построить воронку: часть шагов
// считалась по людям, часть по действиям, и прохождения не отличались
// друг от друга.
//
// Теперь правило одно: **событие пишется каждый раз, когда шаг
// происходит**. Уникальных людей считаем в SQL через DISTINCT, а не при
// записи. Повторный показ экрана, возврат к анкете после напоминания,
// второй проход онбординга — каждый раз новая запись.
//
// Исключение одно: гайд «Азбука сна малыша» отправляется один раз на
// человека и по продукту, поэтому guide_sent пишется в момент реальной
// отправки и остаётся однократным сам по себе, без проверки в этой
// функции.

import type { OfferEventType } from "@prisma/client";
import { prisma } from "./prisma";

// Номер вопроса анкеты. Дробный намеренно: условный вопрос 4.5
// («своими словами») так и хранится, как и в Session.currentQuestionNumber.
export type QuestionNumber = number;

// События, у которых номер вопроса обязателен. Если он не передан,
// запись всё равно уходит, но в лог пишется предупреждение: потерять
// данные хуже, чем получить событие без номера, а предупреждение
// покажет, что разметка где-то забыта.
const REQUIRES_QUESTION: ReadonlySet<string> = new Set([
  "quiz_question_shown",
  "quiz_question_answered",
  "quiz_answer_invalid",
  "quiz_out_of_range",
  "quiz_edit_question_shown",
  "quiz_edit_answered",
  "quiz_reminder_1_sent",
  "quiz_reminder_2_sent",
  "quiz_reminder_continue_click",
  "quiz_resumed_after_reminder_1",
  "quiz_resumed_after_reminder_2",
]);

interface LogOptions {
  questionNumber?: QuestionNumber | null;
  // Номер прохождения, если он уже известен вызывающему. Нужен там, где
  // прохождение успело измениться: «Начать заново» пишет событие с
  // прежним номером, а сессию увеличивает уже после.
  attempt?: number;
  // Экран, с которого пришло событие. Нужен там, где одного типа
  // мало: пример разбора открывают с четырёх мест.
  source?: string;
}

// Прохождение берём из сессии в момент записи. Сессии нет — значит
// человек пришёл только в бот поддержки: у таких событий прохождение
// нулевое, и в воронку основного бота они не попадают.
async function resolveAttempt(telegramId: bigint): Promise<number> {
  const session = await prisma.session.findUnique({
    where: { telegramId },
    select: { attempt: true },
  });
  return session?.attempt ?? 0;
}

// Никогда не бросает исключение: событие — это наблюдение за ботом, а
// не его работа. Упавшая запись не должна оставить родителя без ответа.
export async function logEvent(
  telegramId: bigint | number,
  type: OfferEventType,
  opts: LogOptions = {}
): Promise<void> {
  try {
    const id = BigInt(telegramId);

    if (REQUIRES_QUESTION.has(type) && opts.questionNumber == null) {
      console.warn(`Событие ${type} для #${id} записано без номера вопроса.`);
    }

    await prisma.offerEvent.create({
      data: {
        telegramId: id,
        type,
        questionNumber: opts.questionNumber ?? null,
        attempt: opts.attempt ?? (await resolveAttempt(id)),
        source: opts.source ?? null,
      },
    });
  } catch (error) {
    console.error(`Не удалось записать событие ${type} для #${telegramId}:`, error);
  }
}
