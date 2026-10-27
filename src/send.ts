// Отправка статических текстов бота с разметкой HTML.
//
// Разметка нужна ради жирных заголовков и ссылок-названий. Включать её
// на каждом вызове руками опасно: стоит один раз забыть экранировать
// подставляемое значение — и Telegram откажется принимать сообщение
// целиком, а человек останется вообще без ответа.
//
// Поэтому правило такое: статические тексты из texts.ts уходят через
// эти функции, а всё, где есть текст от человека или от модели (разбор,
// отзывы, ответы анкеты в сообщениях админу), отправляется как раньше,
// без разметки. Подставляемые значения — через escapeHtml.
//
// Если Telegram всё-таки не разобрал разметку, сообщение уходит второй
// раз простым текстом без тегов, а ошибка пишется в лог. Лучше потерять
// жирный заголовок, чем сообщение.

import { Api, Context, InputFile } from "grammy";

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Для запасной отправки: убираем теги, а мнемоники возвращаем в символы,
// иначе человек увидит «&amp;» вместо «&».
function stripTags(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// Telegram отвечает на кривую разметку ошибкой 400 с описанием
// «can't parse entities». Остальные ошибки (нет прав, пользователь
// заблокировал бота) запасной отправкой не чинятся — их пробрасываем.
function isParseError(error: unknown): boolean {
  const description = (error as { description?: string })?.description ?? String(error);
  return /can't parse entities|unsupported start tag|unmatched end tag/i.test(description);
}

type SendOptions = Record<string, unknown>;

export async function replyStatic(ctx: Context, text: string, options: SendOptions = {}) {
  try {
    return await ctx.reply(text, { ...options, parse_mode: "HTML" });
  } catch (error) {
    if (!isParseError(error)) throw error;
    console.error("Telegram не разобрал HTML, отправляю простым текстом:", error);
    return ctx.reply(stripTags(text), options);
  }
}

export async function sendStatic(
  api: Api,
  chatId: bigint | number,
  text: string,
  options: SendOptions = {}
) {
  try {
    return await api.sendMessage(Number(chatId), text, { ...options, parse_mode: "HTML" });
  } catch (error) {
    if (!isParseError(error)) throw error;
    console.error("Telegram не разобрал HTML, отправляю простым текстом:", error);
    return api.sendMessage(Number(chatId), stripTags(text), options);
  }
}

// Фото с подписью: подпись тоже поддерживает разметку, и запасной путь
// у неё тот же.
export async function replyPhotoStatic(
  ctx: Context,
  photo: string | InputFile,
  caption: string,
  options: SendOptions = {}
) {
  try {
    return await ctx.replyWithPhoto(photo, { ...options, caption, parse_mode: "HTML" });
  } catch (error) {
    if (!isParseError(error)) throw error;
    console.error("Telegram не разобрал HTML в подписи, отправляю простым текстом:", error);
    return ctx.replyWithPhoto(photo, { ...options, caption: stripTags(caption) });
  }
}
