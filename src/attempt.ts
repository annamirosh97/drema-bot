// Прохождения анкеты.
//
// До появления «Начать заново» у человека был один набор ответов и один
// разбор, а команда /reset прошлые просто удаляла. Теперь прохождения
// нумеруются: ответы и разборы прошлых остаются в базе, но в новый
// разбор не попадают.
//
// Правило одно и оно важное: **всё, что читается для разбора, для
// анкеты и для карточек, читается по текущему прохождению**. Забыть
// фильтр — значит смешать в одном разборе ответы, которые человек дал
// про разные месяцы жизни малыша, и этого в выдаче будет не видно.
// Поэтому фильтр живёт здесь, одной функцией, а не повторяется
// условием в каждом запросе.
//
// Исторические строки (их в базе большинство) получили прохождение 1
// в миграции, и для них ничего не меняется.

import { prisma } from "./prisma";

// Номер текущего прохождения. Для человека, которого в базе ещё нет,
// это первое прохождение: отсутствие сессии и прохождение 1 — для
// чтения одно и то же, а заводить сессию ради номера незачем.
export async function currentAttempt(telegramId: bigint): Promise<number> {
  const session = await prisma.session.findUnique({
    where: { telegramId },
    select: { attempt: true },
  });
  return session?.attempt ?? 1;
}

// Условие «ответы этого человека по текущему прохождению». Подставляется
// в where целиком:
//
//   where: { ...(await answersOfCurrentAttempt(telegramId)), questionNumber: 1 }
//
// Строки без номера в базе невозможны (колонка NOT NULL DEFAULT 1),
// так что проверять на null не нужно.
export async function answersOfCurrentAttempt(telegramId: bigint) {
  return { telegramId, attempt: await currentAttempt(telegramId) };
}

// Текущий разбор человека — тот, что относится к текущему прохождению.
// Отменённые сюда попадают: админке и карточке поддержки важно видеть,
// что разбор был и чем кончился. Кому нужен только живой разбор,
// проверяет status отдельно.
export async function currentRecommendation(telegramId: bigint) {
  return prisma.recommendation.findUnique({
    where: { telegramId_attempt: { telegramId, attempt: await currentAttempt(telegramId) } },
  });
}

// Разбор, который ждёт проверки. Нужен в двух местах: перед
// перезапуском (предупредить, что он не придёт) и при самом
// перезапуске (отменить его).
export async function pendingRecommendation(telegramId: bigint) {
  const recommendation = await currentRecommendation(telegramId);
  return recommendation?.status === "pending" ? recommendation : null;
}

// Последний отменённый разбор.
//
// Нужен, чтобы объяснить админу, почему отправлять нечего. Сразу после
// перезапуска текущего разбора не существует вовсе: номер прохождения
// уже новый, а новую анкету человек ещё не сдал. Без этой проверки
// /approve и /send отвечали бы «черновика нет» — формально верно и
// совершенно не по делу, потому что черновик был, и его отменили.
export async function lastCancelledRecommendation(telegramId: bigint) {
  return prisma.recommendation.findFirst({
    where: { telegramId, status: "cancelled" },
    orderBy: { attempt: "desc" },
  });
}
