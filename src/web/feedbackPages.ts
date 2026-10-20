// Страницы админки по обратной связи: что ответили про бесплатный
// разбор и что — про платный план.
//
// Две отдельные страницы, а не одна: вопросы разные, и смотрят на них в
// разные моменты. Оценку разбора читают, когда думают над промптами;
// результат плана — когда думают над методологией.
//
// Данные сюда приходят уже собранными, обращений к базе здесь нет.

import { formatMoscow } from "../consents";
import { escape, html, page, raw } from "./html";

export const ANALYSIS_LABELS: Record<string, string> = {
  YES: "Да, очень похоже",
  PARTLY: "Отчасти",
  NO: "Не совсем",
};

export const PDF_LABELS: Record<string, string> = {
  BETTER: "Стало лучше",
  SAME: "Без изменений",
  WORSE: "Стало хуже",
  NOT_STARTED: "Пока не начали",
};

// Тревожные ответы подсвечиваем: ради них страница и нужна.
const ALARMING = new Set(["PARTLY", "NO", "SAME", "WORSE"]);

function answerPill(value: string, labels: Record<string, string>): string {
  const label = labels[value] ?? value;
  return html`<span class="${ALARMING.has(value) ? "pill warn" : "pill"}">${label}</span>`;
}

function periodForm(action: string, days: number, extra = ""): string {
  return html`<form method="get" action="${action}">
    <div class="row-actions" style="margin-top:0">
      <input type="text" name="days" value="${days}" style="max-width:90px">
      <button type="submit">За столько дней</button>
      ${raw(extra)}
    </div>
  </form>`;
}

// ── Оценка разбора ──────────────────────────────────────────────────

export interface AnalysisFeedbackRow {
  telegramId: string;
  name: string | null;
  rating: string;
  comment: string | null;
  skippedComment: boolean;
  answeredAt: Date;
  links: { label: string; url: string }[];
}

export interface AnalysisFeedbackPageData {
  rows: AnalysisFeedbackRow[];
  days: number;
  asked: number;
  answered: number;
}

export function renderAnalysisFeedbackPage(data: AnalysisFeedbackPageData): string {
  const rows = data.rows.map(
    (r) => html`<div class="card">
      <p class="muted">
        ${formatMoscow(r.answeredAt)} · ${r.name ?? "без имени"} · #${r.telegramId}
        ${raw(r.links.map((l) => html` · <a href="${l.url}">${l.label}</a>`).join(""))}
      </p>
      <p>${raw(answerPill(r.rating, ANALYSIS_LABELS))}</p>
      ${raw(
        r.comment
          ? html`<pre>${r.comment}</pre>`
          : html`<p class="muted">${r.skippedComment ? "комментарий пропущен" : "комментария нет"}</p>`
      )}
    </div>`
  );

  return page(
    "Оценка разбора",
    html`<h1>Оценка разбора</h1>
      <p class="muted">
        Только «Отчасти» и «Не совсем»: ради них страница и нужна ·
        <a href="/admin/feedback/pdf">результат плана</a> ·
        <a href="/admin/users">пользователи</a> ·
        <a href="/admin/orders">заказы</a>
      </p>

      <div class="card">
        <p>За ${data.days} дн.: спросили ${data.asked}, ответили ${data.answered}.</p>
        ${raw(periodForm("/admin/feedback/analysis", data.days))}
      </div>

      ${raw(rows.join("") || html`<p class="muted">Таких ответов пока нет.</p>`)}`
  );
}

// ── Результат плана ─────────────────────────────────────────────────

export interface PdfFeedbackRow {
  orderId: number;
  telegramId: string;
  name: string | null;
  result: string;
  comment: string | null;
  skippedComment: boolean;
  answeredAt: Date;
  hasEdits: boolean;
  orderUrl: string | null;
}

export interface PdfFeedbackPageData {
  rows: PdfFeedbackRow[];
  days: number;
  filter: string;
  asked: number;
  answered: number;
}

export function renderPdfFeedbackPage(data: PdfFeedbackPageData): string {
  const options = ["", ...Object.keys(PDF_LABELS)]
    .map(
      (value) =>
        html`<option value="${value}" ${raw(value === data.filter ? "selected" : "")}>
          ${value ? PDF_LABELS[value] : "любой ответ"}
        </option>`
    )
    .join("");

  const rows = data.rows.map(
    (r) => html`<div class="card">
      <p class="muted">
        ${formatMoscow(r.answeredAt)} · ${r.name ?? "без имени"} · #${r.telegramId} ·
        ${raw(r.orderUrl ? html`<a href="${r.orderUrl}">заказ #${r.orderId}</a>` : html`заказ #${r.orderId}`)}
        · ${r.hasEdits ? "с правками" : "без правок"}
      </p>
      <p>${raw(answerPill(r.result, PDF_LABELS))}</p>
      ${raw(
        r.comment
          ? html`<pre>${r.comment}</pre>`
          : html`<p class="muted">${r.skippedComment ? "комментарий пропущен" : "комментария нет"}</p>`
      )}
    </div>`
  );

  const filter = html`<select name="result">${raw(options)}</select>`;

  return page(
    "Результат плана",
    html`<h1>Результат плана</h1>
      <p class="muted">
        Что ответили через неделю после плана ·
        <a href="/admin/feedback/analysis">оценка разбора</a> ·
        <a href="/admin/users">пользователи</a> ·
        <a href="/admin/orders">заказы</a>
      </p>

      <div class="card">
        <p>За ${data.days} дн.: спросили ${data.asked}, ответили ${data.answered}.</p>
        ${raw(periodForm("/admin/feedback/pdf", data.days, filter))}
      </div>

      ${raw(rows.join("") || html`<p class="muted">Ответов пока нет.</p>`)}`
  );
}

export { escape };
