// Страницы админки по обращениям в поддержку: список и переписка.
//
// Нужны затем, что в Telegram историю приходится листать, а здесь она
// видна целиком и со ссылками на всё остальное про этого человека.
// Данные сюда приходят уже собранными, обращений к базе здесь нет.

import { formatMoscow } from "../consents";
import { escape, html, page, raw } from "./html";

const STATUS_LABELS: Record<string, string> = {
  WAITING: "🟡 ждёт ответа",
  ANSWERED: "🟢 ответили",
  CLOSED: "✅ закрыто",
};

const DIRECTION_LABELS: Record<string, string> = {
  IN: "родитель",
  OUT: "поддержка",
  NOTE: "заметка",
};

// Что было во вложении. Текст показываем как есть, остальное —
// подписью: самих файлов у нас нет, только ссылки Telegram.
const TYPE_LABELS: Record<string, string> = {
  text: "",
  photo: "📷 фото",
  voice: "🎤 голосовое",
  video: "🎬 видео",
  video_note: "⭕️ кружок",
  document: "📎 файл",
  audio: "🎵 аудио",
  sticker: "🙂 стикер",
  edit: "✏️ правка",
  unsupported: "⚠️ неподдерживаемый тип",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

// ── Время до первого ответа ─────────────────────────────────────────

// Считаем по часам: минуты тут не нужны, а «2 дня» читается хуже, чем
// «48 ч», когда рядом стоит среднее.
export function formatHours(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.round(ms / 60_000)} мин`;
  if (hours < 48) return `${hours.toFixed(1)} ч`;
  return `${Math.round(hours / 24)} дн.`;
}

// Медиана честнее среднего: одно забытое на неделю обращение способно
// утянуть среднее так, что оно перестанет описывать обычный день.
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// ── Список обращений ────────────────────────────────────────────────

export interface SupportRow {
  id: number;
  telegramId: string;
  name: string | null;
  username: string | null;
  status: string;
  lastMessageAt: Date | null;
  // Сколько ждёт ответа прямо сейчас. Только у тех, кто ждёт.
  waitingMs: number | null;
}

export interface SupportListData {
  rows: SupportRow[];
  days: number;
  inPeriod: number;
  firstReplyMean: number | null;
  firstReplyMedian: number | null;
  answeredInPeriod: number;
}

export function renderSupportListPage(data: SupportListData): string {
  const rows = data.rows.map(
    (r) => html`<tr>
      <td><a href="/admin/support/${r.id}">#${r.id}</a></td>
      <td>${statusLabel(r.status)}</td>
      <td>${r.name ?? "—"}</td>
      <td>${r.username ? `@${r.username}` : "—"}</td>
      <td>${r.lastMessageAt ? formatMoscow(r.lastMessageAt) : "—"}</td>
      <td>
        ${raw(
          r.waitingMs === null
            ? html`<span class="muted">—</span>`
            : html`<span class="${r.waitingMs > 24 * 3_600_000 ? "pill danger" : "pill warn"}">${formatHours(r.waitingMs)}</span>`
        )}
      </td>
      <td class="muted">#${r.telegramId}</td>
    </tr>`
  );

  const body = data.rows.length
    ? html`<table>
        <tr><th>Обращение</th><th>Статус</th><th>Имя</th><th>Username</th><th>Последнее сообщение</th><th>Ждёт</th><th>Пользователь</th></tr>
        ${raw(rows.join(""))}
      </table>`
    : html`<p class="muted">Обращений пока нет.</p>`;

  const value = (ms: number | null) => (ms === null ? "—" : formatHours(ms));

  return page(
    "Поддержка",
    html`<h1>Поддержка</h1>
      <p class="muted">
        Сначала те, кто ждёт ответа · красным — ждут больше суток ·
        <a href="/admin/consents">согласия</a> · <a href="/admin/users">пользователи</a> ·
        <a href="/admin/orders">заказы</a>
      </p>

      <div class="card">
        <h2>За ${data.days} дн.</h2>
        <table>
          <tr><th>Обращений</th><td>${data.inPeriod}</td></tr>
          <tr><th>Из них ответили</th><td>${data.answeredInPeriod}</td></tr>
          <tr><th>Время до первого ответа, среднее</th><td>${value(data.firstReplyMean)}</td></tr>
          <tr><th>Оно же, медиана</th><td>${value(data.firstReplyMedian)}</td></tr>
        </table>
        <p class="muted" style="margin-top:10px">
          Медиана обычно честнее среднего: одно забытое обращение способно
          утянуть среднее так, что оно перестанет описывать обычный день.
          Другой период — <code>?days=30</code>.
        </p>
      </div>

      <div class="card">${raw(body)}</div>`
  );
}

// ── Переписка ───────────────────────────────────────────────────────

export interface SupportMessageRow {
  id: number;
  direction: string;
  type: string;
  text: string | null;
  fileId: string | null;
  deliveryError: string | null;
  createdAt: Date;
}

export interface SupportThreadData {
  id: number;
  telegramId: string;
  name: string | null;
  username: string | null;
  status: string;
  source: string | null;
  createdAt: Date;
  closedAt: Date | null;
  firstReplyMs: number | null;
  messages: SupportMessageRow[];
  links: { label: string; url: string }[];
}

function messageRow(m: SupportMessageRow): string {
  const attachment = TYPE_LABELS[m.type] ?? m.type;
  const cls = m.direction === "IN" ? "in" : m.direction === "NOTE" ? "note" : "out";

  return html`<div class="msg ${cls}">
    <div class="muted">
      ${DIRECTION_LABELS[m.direction] ?? m.direction} · ${formatMoscow(m.createdAt, true)}
      ${attachment ? ` · ${attachment}` : ""}
    </div>
    ${raw(m.text ? html`<pre>${m.text}</pre>` : html`<p class="muted">без текста</p>`)}
    ${raw(
      m.deliveryError
        ? html`<p class="muted">❌ не доставлено: ${m.deliveryError}</p>`
        : ""
    )}
  </div>`;
}

export function renderSupportThreadPage(data: SupportThreadData): string {
  const who =
    (data.name ?? "без имени") + (data.username ? ` · @${data.username}` : "");

  const links = data.links
    .map((l) => html`<a href="${l.url}">${l.label}</a>`)
    .join(" · ");

  const messages = data.messages.map(messageRow).join("");

  // Стили переписки держим здесь: это единственная страница, где они
  // нужны, и тащить их в общий файл незачем.
  const style = `
    .msg { border-left: 3px solid var(--line); padding: 8px 0 8px 12px; margin-bottom: 12px; }
    .msg.in { border-left-color: var(--accent); }
    .msg.out { border-left-color: #8FBF8F; }
    .msg.note { border-left-color: var(--warn); background: #FFF6E6; border-radius: 0 8px 8px 0; padding-right: 12px; }
    .msg pre { margin: 6px 0 0; }
  `;

  return page(
    `Обращение #${data.id}`,
    html`<style>${raw(style)}</style>
      <h1>Обращение #${data.id}</h1>
      <p class="muted">
        ${who} · id ${data.telegramId} · ${statusLabel(data.status)} ·
        <a href="/admin/support">ко всем обращениям</a>
      </p>

      <div class="card">
        <table>
          <tr><th>Началось</th><td>${formatMoscow(data.createdAt)}</td></tr>
          <tr><th>Закрыто</th><td>${data.closedAt ? formatMoscow(data.closedAt) : "—"}</td></tr>
          <tr><th>Время до первого ответа</th><td>${data.firstReplyMs === null ? "ещё не отвечали" : formatHours(data.firstReplyMs)}</td></tr>
          ${raw(data.source ? html`<tr><th>Источник</th><td>${data.source}</td></tr>` : "")}
        </table>
        ${raw(links ? html`<p style="margin-top:12px">🔗 ${raw(links)}</p>` : "")}
      </div>

      <div class="card">
        <h2>Переписка</h2>
        <p class="muted">
          Заметки поддержки (начинались с «//») родителю не отправлялись.
        </p>
        ${raw(messages || html`<p class="muted">Сообщений нет.</p>`)}
      </div>`
  );
}

export { escape };
