// Статические файлы, которые бот отправляет многим людям: гид «Азбука
// сна» после анкеты и пример платного плана по кнопке в оффере.
//
// Telegram разрешает переотправлять уже загруженный файл по
// идентификатору, так что грузить его заново на каждого пользователя
// незачем. Идентификатор храним вместе с хэшем содержимого: заменили
// файл в репозитории — хэш разойдётся, и файл уйдёт на загрузку заново.
//
// Кэш живёт в памяти процесса и перезапуск не переживает, так что после
// деплоя новый файл подхватится и без проверки хэша. Хэш страхует
// случай, когда файл подменили без перезапуска, и оставляет правило
// явным, если кэш когда-нибудь переедет в базу.

import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { Context, InputFile } from "grammy";
import { PROJECT_ROOT } from "./prompts";

export function projectFile(relativePath: string): string {
  return join(PROJECT_ROOT, relativePath);
}

const cache = new Map<string, { fileId: string; hash: string }>();

// Файлы меньше мегабайта, и считать хэш дешевле, чем держать его и не
// заметить подмену.
function hashOf(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Отправляет документ и запоминает идентификатор. Если Telegram отверг
// сохранённый идентификатор, молча загружает файл заново: пользователю
// эта ошибка ни о чём не говорит.
export async function sendCachedDocument(
  ctx: Context,
  path: string,
  caption?: string
): Promise<void> {
  const hash = hashOf(path);
  const cached = cache.get(path);
  const options = caption ? { caption } : undefined;

  if (cached?.hash === hash) {
    try {
      await ctx.replyWithDocument(cached.fileId, options);
      return;
    } catch (error) {
      console.error(`Не удалось отправить ${path} по file_id, загружаю заново:`, error);
      cache.delete(path);
    }
  }

  const sent = await ctx.replyWithDocument(new InputFile(path), options);
  const fileId = sent.document?.file_id;
  if (fileId) cache.set(path, { fileId, hash });
}

// То же для фотографии: фото команды в меню. Отдельная функция, а не
// флаг у предыдущей, потому что Telegram возвращает фото не одним
// file_id, а набором размеров, и брать из него нужно самый большой —
// именно он соответствует загруженному файлу.
//
// Файла может не быть вовсе (фото команды в репозиторий ещё не
// положили), поэтому сначала спрашиваем — наличие проверяет вызывающий.
export async function sendCachedPhoto(ctx: Context, path: string): Promise<void> {
  const hash = hashOf(path);
  const cached = cache.get(path);

  if (cached?.hash === hash) {
    try {
      await ctx.replyWithPhoto(cached.fileId);
      return;
    } catch (error) {
      console.error(`Не удалось отправить ${path} по file_id, загружаю заново:`, error);
      cache.delete(path);
    }
  }

  const sent = await ctx.replyWithPhoto(new InputFile(path));
  const largest = sent.photo?.[sent.photo.length - 1]?.file_id;
  if (largest) cache.set(path, { fileId: largest, hash });
}

// Есть ли файл на диске. Нужно меню: фото команды необязательно, и его
// отсутствие — не ошибка, а штатный случай.
export function projectFileExists(relativePath: string): boolean {
  return existsSync(projectFile(relativePath));
}
