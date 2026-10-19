// Меню бота: сами экраны.
//
// Здесь только то, что бот показывает по /menu и по трём его пунктам —
// «Поддержка», «Документы», «Команда Дрёмы». Ни один из них не трогает
// состояние сценария: человек может открыть меню посреди анкеты и
// вернуться к ней той же кнопкой.
//
// Движок этот файл импортирует, а не наоборот: меню не знает ни про
// стадии, ни про анкету, и единственное, что ему сообщают снаружи, —
// нужна ли кнопка возврата. Иначе engine.ts и menu.ts получили бы
// круговой импорт.
//
// «Начать заново» живёт в engine.ts: это шаг онбординга, и ему нужны
// анкета, согласия и прохождения.

import { Context } from "grammy";
import { env } from "./env";
import { texts } from "./texts";
import { backToQuizKeyboard, menuKeyboard, supportLinkKeyboard } from "./keyboards";
import { replyStatic } from "./send";
import { projectFileExists, sendCachedPhoto, projectFile } from "./staticDocs";

// Фото для пункта «Команда Дрёмы». Файла может не быть — тогда уходит
// только текст, и это штатный случай, а не ошибка.
const TEAM_PHOTO = "assets/team/anna.jpg";

export const MENU_CALLBACKS = new Set([
  "menu_restart",
  "menu_support",
  "menu_docs",
  "menu_team",
  "menu_back",
]);

// Кнопка возврата — только если бот действительно чего-то ждёт.
// Решает это движок: он один знает стадию.
function backButton(showBack: boolean) {
  return showBack ? { reply_markup: backToQuizKeyboard() } : {};
}

export async function sendMenu(ctx: Context, showBack = false) {
  return replyStatic(ctx, texts.menu, { reply_markup: menuKeyboard(showBack) });
}

// ── Поддержка ───────────────────────────────────────────────────────

export async function sendSupport(ctx: Context, showBack: boolean) {
  // Без username бота поддержки ссылка вела бы в никуда, поэтому вместо
  // кнопки показываем почту. Если и её нет, остаётся только текст: это
  // лучше, чем «Почта для связи:» без адреса.
  if (env.SUPPORT_BOT_USERNAME) {
    return replyStatic(ctx, texts.menuSupport(env.SUPPORT_BOT_USERNAME), {
      reply_markup: supportLinkKeyboard(env.SUPPORT_BOT_USERNAME, showBack),
    });
  }

  const email = env.CONTACT_EMAIL ? `\n\n${texts.contactEmailLine(env.CONTACT_EMAIL)}` : "";
  return replyStatic(ctx, `${texts.menuSupport("")}${email}`, backButton(showBack));
}

// ── Документы ───────────────────────────────────────────────────────

// Строку документа показываем только если адрес задан: пункт списка со
// пустой ссылкой выглядел бы как поломка. Ссылки появятся после юриста,
// а MARKETING_CONSENT_URL может так и остаться пустым.
export function docsText(): string {
  const documents: [string, string][] = [
    [env.PRIVACY_POLICY_URL, "Политика обработки персональных данных"],
    [env.PD_CONSENT_URL, "Согласие на обработку персональных данных"],
    [env.MARKETING_CONSENT_URL, "Согласие на получение рассылки"],
    [env.OFFER_URL, "Публичная оферта"],
  ];

  const lines = documents
    .filter(([url]) => url)
    .map(([url, label]) => `• <a href="${escapeAttribute(url)}">${label}</a>`);

  const parts = [texts.menuDocsHeading];
  // Ни одной ссылки — выводим только почту, как велит ТЗ.
  if (lines.length) parts.push(lines.join("\n"));
  if (env.CONTACT_EMAIL) parts.push(texts.contactEmailLine(env.CONTACT_EMAIL));
  parts.push(texts.menuDocsDataHint);

  return parts.join("\n\n");
}

// Адреса приходят из переменных окружения, и в HTML их нужно
// обезвредить: кавычка в адресе разорвала бы тег. Та же защита стоит на
// экране согласия на обработку данных.
function escapeAttribute(url: string): string {
  return url.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function sendDocs(ctx: Context, showBack: boolean) {
  await replyStatic(ctx, docsText(), {
    link_preview_options: { is_disabled: true },
    ...backButton(showBack),
  });
}

// ── Команда Дрёмы ───────────────────────────────────────────────────

export async function sendTeam(ctx: Context, showBack: boolean) {
  if (projectFileExists(TEAM_PHOTO)) {
    try {
      await sendCachedPhoto(ctx, projectFile(TEAM_PHOTO));
    } catch (error) {
      // Фото — украшение, без него текст всё равно должен дойти.
      console.error("Не удалось отправить фото команды:", error);
    }
  }

  await replyStatic(ctx, texts.menuTeam, backButton(showBack));
}
