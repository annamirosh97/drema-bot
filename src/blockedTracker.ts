// Отслеживание того, что родитель остановил бота.
//
// Повесить это на каждую отправку невозможно: в коде 86 прямых
// ctx.reply, 13 api.sendMessage и десяток отправок файлов, и любая новая
// отправка оказалась бы неразмеченной. Поэтому ставим трансформер API
// grammY: он видит **все** исходящие вызовы обоих ботов, включая те,
// что идут из планировщиков напоминаний и отложенных вопросов.
//
// Пишем не чаще раза в сутки на человека. Это единственное место, где
// ограничение частоты оправдано: планировщики ретраят отправку, и без
// него один заблокировавший бота человек давал бы десятки событий в
// день. Счётчик в памяти процесса — после деплоя событие запишется
// заново, и это не беда: раз в сутки превратится в «раз в сутки или
// после перезапуска».

import type { Api } from "grammy";
import { logEvent } from "./events";

const DAY_MS = 24 * 3_600_000;

// Когда последний раз писали про этого человека.
const lastLogged = new Map<string, number>();

// Методы, у которых получатель — это chat_id в payload. Для остальных
// (getMe, setMyCommands и прочей служебной части) 403 означает совсем
// другое, и человека в них нет.
const SENDING_METHODS = /^(sendMessage|sendPhoto|sendDocument|sendVideo|sendAudio|sendVoice|sendSticker|sendMediaGroup|copyMessage|copyMessages|forwardMessage|editMessageText|editMessageReplyMarkup|editMessageCaption|sendChatAction)$/;

function isBlockedError(error: unknown): boolean {
  const description = (error as { description?: string })?.description ?? String(error);
  return /bot was blocked by the user|user is deactivated|bot can't initiate conversation/i.test(
    description
  );
}

// Телеграм-идентификатор получателя из payload вызова. Строковый
// chat_id (@username канала) нас не интересует: родитель — всегда
// числовой id.
function recipientOf(payload: unknown): number | null {
  const chatId = (payload as { chat_id?: unknown })?.chat_id;
  return typeof chatId === "number" ? chatId : null;
}

export function trackBlockedUsers(api: Api): void {
  // Трекер не имеет права ронять бота: если трансформеры недоступны
  // (подменённый api в тестах, смена версии grammY), просто не следим.
  if (typeof api?.config?.use !== "function") {
    console.warn("Трансформеры API недоступны, события bot_blocked писаться не будут.");
    return;
  }

  api.config.use(async (prev, method, payload, signal) => {
    try {
      return await prev(method, payload, signal);
    } catch (error) {
      if (SENDING_METHODS.test(method) && isBlockedError(error)) {
        const id = recipientOf(payload);
        if (id !== null) {
          const key = String(id);
          const last = lastLogged.get(key) ?? 0;
          if (Date.now() - last >= DAY_MS) {
            lastLogged.set(key, Date.now());
            // Не ждём записи: отправка уже провалилась, и вызывающий
            // должен получить свою ошибку без задержки на базу.
            void logEvent(id, "bot_blocked");
          }
        }
      }
      throw error;
    }
  });
}
