// Страницы админки по согласиям: поиск, карточка пользователя, версия
// для печати и список рассылки.
//
// Карточка — это то, что показывают проверяющей стороне, поэтому она
// устроена как документ, а не как панель: сверху текущее состояние,
// ниже вся история подряд, у каждой записи — время, версия документа,
// кнопка и точный текст, который человек видел.
//
// Менять записи отсюда нельзя: ни одной формы, которая что-то правит,
// на этих страницах нет, и в базе стоит триггер (см. миграцию
// 20261015000000_consents_journal).

import { consentTypeLabel, formatMoscow } from "../consents";
import { escape, html, page, raw } from "./html";

const ACTION_LABELS: Record<string, string> = {
  GRANTED: "дано",
  DECLINED: "отказ",
  REVOKED: "отозвано",
};

const SOURCE_LABELS: Record<string, string> = {
  ONBOARDING: "онбординг",
  PURCHASE_PDF: "покупка плана",
  CONSULT_SIGNUP: "запись на консультацию",
  UPSELL: "предложение после плана",
  DATA_COMMAND: "команда /data",
  UNSUBSCRIBE_COMMAND: "команда /unsubscribe",
  ADMIN: "админ",
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

// ── Поиск ───────────────────────────────────────────────────────────

export interface ConsentSearchRow {
  telegramId: string;
  username: string | null;
  firstName: string | null;
  pdStatus: string;
  marketingStatus: string;
  lastActionAt: Date | null;
}

export function renderConsentSearchPage(query: string, rows: ConsentSearchRow[]): string {
  const list = rows.map(
    (r) => html`<tr>
      <td><a href="/admin/users/${r.telegramId}/consents">#${r.telegramId}</a></td>
      <td>${r.username ? `@${r.username}` : "—"}</td>
      <td>${r.firstName ?? "—"}</td>
      <td>${r.pdStatus}</td>
      <td>${r.marketingStatus}</td>
      <td class="muted">${r.lastActionAt ? formatMoscow(r.lastActionAt) : "—"}</td>
    </tr>`
  );

  const body = rows.length
    ? html`<table>
        <tr><th>Пользователь</th><th>Username</th><th>Имя</th><th>Данные</th><th>Рассылка</th><th>Последнее действие</th></tr>
        ${raw(list.join(""))}
      </table>`
    : html`<p class="muted">
        ${query ? "Никого не нашлось." : "Введите telegram id или username."}
      </p>`;

  return page(
    "Согласия",
    html`<h1>Согласия</h1>
      <p class="muted">
        Поиск по telegram id или username ·
        <a href="/admin/marketing">список рассылки</a> ·
        <a href="/admin/users">пользователи</a> ·
        <a href="/admin/orders">заказы</a>
      </p>
      <div class="card">
        <form method="get" action="/admin/consents">
          <div class="row-actions" style="margin-top:0">
            <input type="text" name="q" value="${query}" placeholder="123456789 или username">
            <button type="submit">Найти</button>
          </div>
        </form>
      </div>
      <div class="card">${raw(body)}</div>`
  );
}

// ── Карточка пользователя ───────────────────────────────────────────

export interface ConsentRecordRow {
  id: number;
  type: string;
  action: string;
  source: string;
  buttonText: string;
  messageText: string;
  createdAt: Date;
  documents: { id: number; type: string; version: string; url: string }[];
  relatedOrderId: number | null;
  relatedConsultRequestId: number | null;
}

export interface ConsentCardData {
  telegramId: string;
  username: string | null;
  firstName: string | null;
  current: { type: string; action: string | null; at: Date | null; version: string | null }[];
  history: ConsentRecordRow[];
  // Прохождения анкеты и судьба разбора по каждому. Показываем только
  // когда их больше одного: у подавляющего большинства прохождение
  // одно, и таблица из одной строки ничего не добавляет.
  attempts?: {
    attempt: number;
    status: string;
    cancelReason: string | null;
    sentAt: Date | null;
    createdAt: Date;
  }[];
  // Обращение в поддержку, если человек писал. Ссылка нужна рядом с
  // согласиями: это одно и то же место, куда идут за историей.
  supportThreadId?: number | null;
  // Что человек ответил про бесплатный разбор. Отдельной страницы
  // разбора в админке нет, а смотреть на это удобнее всего здесь:
  // рядом с тем, что он разрешил и что получил.
  analysisFeedback?: {
    rating: string | null;
    comment: string | null;
    skippedComment: boolean;
    askedAt: Date | null;
    answeredAt: Date | null;
    skipReason: string | null;
  } | null;
  // true — страница для печати: без навигации и кнопок, с шапкой.
  forPrint?: boolean;
  printedAt?: Date;
}

const ANALYSIS_LABELS: Record<string, string> = {
  YES: "Да, очень похоже",
  PARTLY: "Отчасти",
  NO: "Не совсем",
};

function analysisFeedbackCard(data: ConsentCardData): string {
  const f = data.analysisFeedback;
  if (!f) return "";

  let body: string;
  if (f.skipReason) {
    body = html`<p class="muted">Не спрашивали: ${f.skipReason}.</p>`;
  } else if (!f.askedAt) {
    body = html`<p class="muted">Вопрос запланирован, ещё не отправлен.</p>`;
  } else if (!f.rating) {
    body = html`<p class="muted">Спросили ${formatMoscow(f.askedAt)}, ответа нет.</p>`;
  } else {
    const comment = f.comment
      ? html`<pre>${f.comment}</pre>`
      : html`<p class="muted">${f.skippedComment ? "комментарий пропущен" : "комментария нет"}</p>`;
    body =
      html`<p><b>${ANALYSIS_LABELS[f.rating] ?? f.rating}</b>
        <span class="muted">· ${f.answeredAt ? formatMoscow(f.answeredAt) : ""}</span></p>` +
      comment;
  }

  return html`<div class="card">
    <h2>Узнали в разборе своего малыша?</h2>
    ${raw(body)}
  </div>`;
}

const RECOMMENDATION_STATUS: Record<string, string> = {
  pending: "готовится",
  sent: "отправлен",
  cancelled: "отменён",
};

// Прохождения анкеты. Нужны ровно в одном случае: человек начал
// заново, его прошлый разбор не пришёл, и он спрашивает почему.
function attemptsCard(data: ConsentCardData): string {
  const attempts = data.attempts ?? [];
  if (attempts.length < 2) return "";

  const rows = attempts.map(
    (a) => html`<tr>
      <td>${a.attempt}</td>
      <td>${formatMoscow(a.createdAt)}</td>
      <td>
        ${RECOMMENDATION_STATUS[a.status] ?? a.status}
        ${a.status === "sent" && a.sentAt ? ` ${formatMoscow(a.sentAt)}` : ""}
        ${a.status === "cancelled" ? `: ${a.cancelReason ?? "без причины"}` : ""}
      </td>
    </tr>`
  );

  return html`<div class="card">
    <h2>Прохождения анкеты</h2>
    <p class="muted">
      Человек начинал анкету заново. Ответы каждого прохождения остались в
      базе; в разбор идут только ответы последнего.
    </p>
    <table>
      <tr><th>Прохождение</th><th>Анкета завершена</th><th>Разбор</th></tr>
      ${raw(rows.join(""))}
    </table>
  </div>`;
}

function documentsCell(record: ConsentRecordRow): string {
  if (!record.documents.length) return html`<span class="muted">документ не привязан</span>`;
  return record.documents
    .map((d) => html`<a href="${d.url}">${d.type} ${d.version}</a>`)
    .join("<br>");
}

function relatedCell(record: ConsentRecordRow): string {
  if (record.relatedOrderId != null) {
    return html`<a href="/admin/orders/${record.relatedOrderId}">заказ #${record.relatedOrderId}</a>`;
  }
  if (record.relatedConsultRequestId != null) {
    return html`<a href="/admin/consults/${record.relatedConsultRequestId}">заявка #${record.relatedConsultRequestId}</a>`;
  }
  return html`<span class="muted">—</span>`;
}

// Время показываем дважды: по Москве — чтобы читать, в UTC — чтобы
// сверять с логами и выгрузками.
function bothTimes(date: Date): string {
  return html`${formatMoscow(date, true)}<br><span class="muted">${date.toISOString()}</span>`;
}

export function renderConsentCard(data: ConsentCardData): string {
  const who =
    (data.username ? `@${data.username}` : "без username") +
    (data.firstName ? `, ${data.firstName}` : "");

  const current = data.current.map(
    (row) => html`<tr>
      <td>${consentTypeLabel(row.type as never)}</td>
      <td>${row.action ? actionLabel(row.action) : "записей нет"}</td>
      <td>${row.at ? formatMoscow(row.at, true) : "—"}</td>
      <td class="muted">${row.version ?? "—"}</td>
    </tr>`
  );

  const history = data.history.map(
    (record) => html`<tr>
      <td>${raw(bothTimes(record.createdAt))}</td>
      <td>${consentTypeLabel(record.type as never)}</td>
      <td>${actionLabel(record.action)}</td>
      <td>${sourceLabel(record.source)}</td>
      <td>${record.buttonText}</td>
      <td>${raw(documentsCell(record))}</td>
      <td>${raw(relatedCell(record))}</td>
    </tr>`
  );

  const texts = data.history.map(
    (record) => html`<details>
      <summary>
        ${formatMoscow(record.createdAt, true)} · ${consentTypeLabel(record.type as never)} ·
        ${actionLabel(record.action)}
      </summary>
      <pre>${record.messageText || "текст не сохранён"}</pre>
    </details>`
  );

  const header = data.forPrint
    ? html`<div class="card">
        <h1>Журнал согласий</h1>
        <table>
          <tr><th>Telegram ID</th><td>${data.telegramId}</td></tr>
          <tr><th>Пользователь</th><td>${who}</td></tr>
          <tr><th>Выгружено</th><td>${formatMoscow(data.printedAt ?? new Date(), true)}</td></tr>
        </table>
      </div>`
    : html`<h1>Согласия #${data.telegramId}</h1>
        <p class="muted">
          ${who} ·
          <a href="/admin/users/${data.telegramId}/consents/print" target="_blank">Выгрузить для проверки</a> ·
          ${raw(
            data.supportThreadId
              ? html`<a href="/admin/support/${data.supportThreadId}">обращение в поддержку</a> · `
              : ""
          )}
          <a href="/admin/consents">к поиску</a>
        </p>`;

  const body = html`${raw(header)}

    ${raw(attemptsCard(data))}

    ${raw(analysisFeedbackCard(data))}

    <div class="card">
      <h2>Сейчас</h2>
      <table>
        <tr><th>Согласие</th><th>Состояние</th><th>Когда</th><th>Версия документа</th></tr>
        ${raw(current.join(""))}
      </table>
    </div>

    <div class="card">
      <h2>История</h2>
      <p class="muted">
        Записи только добавляются: ни код, ни админка не умеют их менять или удалять.
      </p>
      ${raw(
        data.history.length
          ? html`<table>
              <tr><th>Когда (мск / UTC)</th><th>Согласие</th><th>Действие</th><th>Источник</th><th>Кнопка</th><th>Документы</th><th>Связано</th></tr>
              ${raw(history.join(""))}
            </table>`
          : html`<p class="muted">Записей нет.</p>`
      )}
    </div>

    <div class="card">
      <h2>Что видел человек</h2>
      ${raw(texts.join("") || html`<p class="muted">Записей нет.</p>`)}
    </div>`;

  return page(`Согласия #${data.telegramId}`, body);
}

// ── Список рассылки ─────────────────────────────────────────────────

export interface MarketingRow {
  telegramId: string;
  username: string | null;
  grantedAt: Date;
  version: string | null;
}

export function renderMarketingPage(rows: MarketingRow[]): string {
  const list = rows.map(
    (r) => html`<tr>
      <td><a href="/admin/users/${r.telegramId}/consents">#${r.telegramId}</a></td>
      <td>${r.username ? `@${r.username}` : "—"}</td>
      <td>${formatMoscow(r.grantedAt)}</td>
      <td class="muted">${r.version ?? "—"}</td>
    </tr>`
  );

  const body = rows.length
    ? html`<table>
        <tr><th>Пользователь</th><th>Username</th><th>Согласие дано</th><th>Версия документа</th></tr>
        ${raw(list.join(""))}
      </table>`
    : html`<p class="muted">Согласие на рассылку пока никто не дал.</p>`;

  return page(
    "Рассылка",
    html`<h1>Список рассылки</h1>
      <p class="muted">
        ${rows.length} чел. с действующим согласием. Только они могут попадать в рассылки ·
        <a href="/admin/consents">к поиску</a>
      </p>
      <div class="row-actions" style="margin-top:0">
        <a class="btn" href="/admin/marketing.csv">Выгрузить CSV</a>
      </div>
      <div class="card" style="margin-top:16px">${raw(body)}</div>`
  );
}

// CSV для выгрузки. Поля экранируем по правилам CSV: username и имя
// приходят от людей, а запятая в них сломала бы колонки.
export function marketingCsv(rows: MarketingRow[]): string {
  const cell = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const lines = [["telegram_id", "username", "granted_at_msk", "document_version"].join(",")];

  for (const r of rows) {
    lines.push(
      [
        cell(r.telegramId),
        cell(r.username ?? ""),
        cell(formatMoscow(r.grantedAt, true)),
        cell(r.version ?? ""),
      ].join(",")
    );
  }

  return lines.join("\r\n") + "\r\n";
}

export { escape };
