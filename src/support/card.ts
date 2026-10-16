// Карточка родителя: что про него известно из основного бота.
//
// Закрепляется первым сообщением в теме, чтобы отвечающий человек видел
// контекст сразу и не ходил в админку за каждой мелочью. Данные только
// читаются: бот поддержки ничего в основном боте не меняет.
//
// Полей, которых в базе нет, в карточке не будет — пустая строка
// «Оценка разбора: —» хуже отсутствующей.

import { prisma } from "../prisma";
import { formatMoscow, getConsentState } from "../consents";
import { escapeHtml } from "../send";
import { consentUrl, consultUrl, orderUrl } from "../web/server";
import { supportTexts } from "./texts";

const ANALYSIS_RATING_LABELS: Record<string, string> = {
  YES: "Да, очень похоже",
  PARTLY: "Отчасти",
  NO: "Не совсем",
};

const PDF_RESULT_LABELS: Record<string, string> = {
  BETTER: "Стало лучше",
  SAME: "Без изменений",
  WORSE: "Стало хуже",
  NOT_STARTED: "Пока не начали",
};

const CONSENT_LABELS: Record<string, string> = {
  GRANTED: "дано",
  DECLINED: "не дано",
  REVOKED: "отозвано",
};

// Главная гипотеза из блока ВЫВОДЫ. Анализ помечает её словом
// «(главная)» — ищем строку с этой пометкой и отрезаем служебное.
export function mainHypothesis(analysis: string | null): string | null {
  if (!analysis) return null;

  const line = analysis
    .split("\n")
    .find((l) => /\(главная\)/i.test(l));
  if (!line) return null;

  return line
    .replace(/^\s*\d+[.)]\s*/, "")
    .replace(/\s*\(главная\)\s*/i, "")
    .trim() || null;
}

// Имя и username, если вызывающий их не знал.
async function resolveIdentity(
  who: CardIdentity,
  sessionName: string | null
): Promise<CardIdentity> {
  if (who.firstName && who.username) return who;

  const request = who.username
    ? null
    : await prisma.consultRequest.findFirst({
        where: { telegramId: who.telegramId, parentUsername: { not: null } },
        orderBy: { createdAt: "desc" },
      });

  return {
    telegramId: who.telegramId,
    firstName: who.firstName ?? sessionName,
    username: who.username ?? request?.parentUsername ?? null,
  };
}

function shortDate(date: Date | null | undefined): string {
  return date ? formatMoscow(date).replace(/ \(мск\)$/, "") : "";
}

export interface CardIdentity {
  telegramId: bigint;
  firstName?: string | null;
  username?: string | null;
}

// Собирает карточку. Если человека нет в основном боте, возвращает
// короткий вариант: имя, username и честное «не найден».
export async function buildSupportCard(who: CardIdentity): Promise<string> {
  const { telegramId } = who;
  const session = await prisma.session.findUnique({ where: { telegramId } });

  // Карточку собирают и из темы, где известен только id: тогда имя
  // берём из сессии, а username — из заявки на консультацию, он
  // сохраняется там в момент записи. Больше его взять неоткуда.
  const known = await resolveIdentity(who, session?.firstName ?? null);
  const head =
    `👤 ${escapeHtml(known.firstName || "без имени")}` +
    (known.username ? ` · @${escapeHtml(known.username)}` : "") +
    ` · id ${telegramId}`;

  if (!session) return `${head}\nВ основном боте не найден.`;

  const [age, recommendation, analysisFeedback, order, consult, consents, thread] =
    await Promise.all([
      prisma.answer.findFirst({ where: { telegramId, questionNumber: 1 } }),
      prisma.recommendation.findUnique({ where: { telegramId } }),
      prisma.analysisFeedback.findUnique({ where: { telegramId } }),
      prisma.order.findFirst({ where: { telegramId }, orderBy: { createdAt: "desc" } }),
      prisma.consultRequest.findFirst({ where: { telegramId }, orderBy: { createdAt: "desc" } }),
      getConsentState(telegramId),
      prisma.supportThread.findUnique({ where: { telegramId } }),
    ]);

  const pdfFeedback = order
    ? await prisma.pdfFeedback.findUnique({ where: { orderId: order.id } })
    : null;

  const lines: string[] = [head];

  if (age?.answerText) lines.push(`👶 ${escapeHtml(age.answerText)} мес`);

  const quiz =
    session.status === "completed"
      ? `пройдена ${shortDate(session.updatedAt)}`
      : "не пройдена";
  const analysisSent =
    recommendation?.status === "sent"
      ? `отправлен ${shortDate(recommendation.sentAt)}`
      : "нет";
  lines.push(`📋 Анкета: ${quiz}; разбор: ${analysisSent}`);

  const hypothesis = mainHypothesis(recommendation?.analysis ?? null);
  if (hypothesis) lines.push(`🔎 Главная гипотеза: ${escapeHtml(hypothesis)}`);

  if (analysisFeedback?.rating) {
    lines.push(`📝 Оценка разбора: ${ANALYSIS_RATING_LABELS[analysisFeedback.rating]}`);
  }

  if (order) {
    const result = pdfFeedback?.result ? PDF_RESULT_LABELS[pdfFeedback.result] : null;
    lines.push(
      `📄 План: заказ #${order.id}, ${order.status}, ${shortDate(order.createdAt)}` +
        (result ? `; результат: ${result}` : "")
    );
  } else {
    lines.push("📄 План: нет");
  }

  lines.push(
    consult
      ? `🗓 Консультация: заявка #${consult.id}, ${consult.status}`
      : "🗓 Консультация: нет"
  );

  const consentLabel = (action: string | null) =>
    action ? CONSENT_LABELS[action] ?? action : "нет записей";
  lines.push(
    `🔒 Согласия: ПД ${consentLabel(consents.PD_PROCESSING.action)}, ` +
      `рассылка ${consentLabel(consents.MARKETING.action)}`
  );

  if (thread?.source) lines.push(`↪️ Источник: ${escapeHtml(thread.source)}`);

  // Ссылки показываем только те, что ведут на существующие страницы:
  // битая ссылка в карточке хуже её отсутствия.
  const links: string[] = [];
  const user = consentUrl(telegramId);
  if (user) links.push(`<a href="${user}">пользователь</a>`);
  if (order) {
    const link = orderUrl(order.id);
    if (link) links.push(`<a href="${link}">заказ</a>`);
  }
  if (consult) {
    const link = consultUrl(consult.id);
    if (link) links.push(`<a href="${link}">заявка</a>`);
  }
  if (links.length) lines.push(`🔗 ${links.join(" · ")}`);

  return lines.join("\n");
}

// Название темы: статус, имя, username и возраст. Telegram ограничивает
// его 128 символами, поэтому длинное имя обрезаем, а не теряем всё
// название целиком.
export async function buildTopicTitle(
  statusEmoji: string,
  who: CardIdentity
): Promise<string> {
  const [age, session] = await Promise.all([
    prisma.answer
      .findFirst({ where: { telegramId: who.telegramId, questionNumber: 1 } })
      .catch(() => null),
    prisma.session.findUnique({ where: { telegramId: who.telegramId } }).catch(() => null),
  ]);
  const known = await resolveIdentity(who, session?.firstName ?? null);

  const parts = [known.firstName || `id ${who.telegramId}`];
  if (known.username) parts.push(`@${known.username}`);
  if (age?.answerText) parts.push(`${age.answerText} мес`);

  const title = `${statusEmoji} ${parts.join(" · ")}`;
  return title.length > 128 ? `${title.slice(0, 127)}…` : title;
}

export { supportTexts };
