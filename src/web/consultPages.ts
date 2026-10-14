// Разметка двух страниц админки по заявкам на консультацию: список и
// страница заявки. Данные сюда приходят уже собранными, обращений к базе
// здесь нет — как и в pages.ts.

import { html, page, raw } from "./html";

// Человеческие подписи вместо значений enum: статусы читает человек, а
// не код, и «Связались» понятнее, чем CONTACTED.
const STATUS_LABELS: Record<string, string> = {
  PENDING_PAYMENT: "ждёт оплаты",
  PAID: "оплачена",
  NEW: "новая",
  CONTACTED: "связались",
  DONE: "завершена",
  CANCELED: "отменена",
};

const FIRST_CONTACT_LABELS: Record<string, string> = {
  PENDING: "родитель ещё не выбрал",
  SPECIALIST: "София",
  PARENT: "родитель",
};

const SOURCE_LABELS: Record<string, string> = {
  OFFER: "оффер",
  AFTER_PDF: "после PDF",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

export function firstContactLabel(value: string): string {
  return FIRST_CONTACT_LABELS[value] ?? value;
}

export interface ConsultRow {
  id: number;
  createdAt: Date;
  status: string;
  parentUsername: string | null;
  firstContact: string;
  source: string;
  priceRub: number;
  hoursWaiting: number;
}

// Подсветка только у новых заявок: у завершённой «48 ч» ни о чём не
// говорит, а у новой это пропущенные сутки.
function waitingPill(hours: number, status: string): string {
  const cls = status === "NEW" && hours > 20 ? "pill danger" : "pill";
  return html`<span class="${cls}">${Math.round(hours)} ч</span>`;
}

export function renderConsultsPage(requests: ConsultRow[]): string {
  const rows = requests.map(
    (r) => html`<tr>
      <td><a href="/admin/consults/${r.id}">#${r.id}</a></td>
      <td>${r.createdAt.toLocaleString("ru-RU")}</td>
      <td>${statusLabel(r.status)}</td>
      <td>${r.parentUsername ? `@${r.parentUsername}` : "—"}</td>
      <td>${firstContactLabel(r.firstContact)}</td>
      <td>${sourceLabel(r.source)}</td>
      <td>${r.priceRub} ₽</td>
      <td>${raw(waitingPill(r.hoursWaiting, r.status))}</td>
    </tr>`
  );

  const body = requests.length
    ? html`<table>
        <tr><th>Заявка</th><th>Создана</th><th>Статус</th><th>Родитель</th><th>Пишет первым</th><th>Источник</th><th>Цена</th><th>Ждёт</th></tr>
        ${raw(rows.join(""))}
      </table>`
    : html`<p class="muted">Заявок пока нет.</p>`;

  return page(
    "Консультации",
    html`<h1>Заявки на консультацию</h1>
      <p class="muted">
        Красным — новые заявки, которые ждут больше 20 часов ·
        <a href="/admin/orders">к заказам PDF</a>
      </p>
      <div class="card">${raw(body)}</div>`
  );
}

// ── Страница заявки ─────────────────────────────────────────────────

export interface ConsultPageData {
  id: number;
  telegramId: string;
  createdAt: Date;
  status: string;
  parentUsername: string | null;
  parentPhone: string | null;
  contactConsentAt: Date | null;
  firstContact: string;
  contactedAt: Date | null;
  doneAt: Date | null;
  priceRub: number;
  source: string;
  orderId: number | null;
  babyAge: string;
  questionnaire: string;
  analysis: string;
  message1: string;
  message2: string;
  statusChanged: boolean;
}

function collapsible(title: string, text: string): string {
  return html`<details><summary>${title}</summary><pre>${text}</pre></details>`;
}

// Кнопки ведут только вперёд по жизни заявки: вернуть «новая» из
// «завершена» через админку нельзя, и это намеренно — такие откаты
// делаются руками в базе и должны быть заметны.
function statusButtons(data: ConsultPageData): string {
  const button = (value: string, label: string, confirm: string) =>
    html`<form method="post" action="/admin/consults/${data.id}/status"
            onsubmit="return confirm('${confirm}')">
          <input type="hidden" name="status" value="${value}">
          <button type="submit" class="secondary">${label}</button>
        </form>`;

  const buttons: string[] = [];
  if (data.status === "NEW") buttons.push(button("CONTACTED", "Связались", "Отметить, что связались?"));
  if (data.status === "NEW" || data.status === "CONTACTED") {
    buttons.push(button("DONE", "Консультация завершена", "Закрыть заявку?"));
    buttons.push(button("CANCELED", "Отменить заявку", "Отменить заявку?"));
  }

  if (!buttons.length) return html`<p class="muted">Заявка закрыта, менять статус больше нечего.</p>`;
  return html`<div class="row-actions">${raw(buttons.join(""))}</div>`;
}

export function renderConsultPage(data: ConsultPageData): string {
  const when = (date: Date | null) => (date ? date.toLocaleString("ru-RU") : "—");

  const contactHint =
    data.firstContact === "PENDING"
      ? html`<div class="banner warn">Родитель ещё не решил, передавать ли контакт.
          Пакет заявки специалисту не отправлен — передавать контакт без разрешения нельзя.</div>`
      : "";

  const left = html`<div class="card">
      <h2>Родитель</h2>
      <table>
        <tr><th>Telegram</th><td>${data.parentUsername ? `@${data.parentUsername}` : "без username"}</td></tr>
        <tr><th>Телефон</th><td>${data.parentPhone ?? "не передан"}</td></tr>
        <tr><th>Согласие на передачу контакта</th><td>${when(data.contactConsentAt)}</td></tr>
        <tr><th>Пишет первым</th><td>${firstContactLabel(data.firstContact)}</td></tr>
        <tr><th>Возраст малыша</th><td>${data.babyAge}</td></tr>
        <tr><th>Telegram ID</th><td class="muted">#${data.telegramId}</td></tr>
      </table>
    </div>

    <div class="card">
      <h2>Исходные данные</h2>
      ${raw(collapsible("Ответы анкеты", data.questionnaire))}
      ${raw(collapsible("ВЫВОДЫ анализа", data.analysis))}
      ${raw(collapsible("Сообщение 1, отправленное родителю", data.message1))}
      ${raw(collapsible("Сообщение 2, отправленное родителю", data.message2))}
      <div class="row-actions">
        <a class="btn secondary" href="/admin/consults/${data.id}/package">Скачать пакет заявки</a>
      </div>
    </div>`;

  const right = html`<div class="card">
      <h2>Статус</h2>
      <table>
        <tr><th>Сейчас</th><td>${statusLabel(data.status)}</td></tr>
        <tr><th>Создана</th><td>${when(data.createdAt)}</td></tr>
        <tr><th>Связались</th><td>${when(data.contactedAt)}</td></tr>
        <tr><th>Завершена</th><td>${when(data.doneAt)}</td></tr>
        <tr><th>Источник</th><td>${sourceLabel(data.source)}</td></tr>
        <tr><th>Цена</th><td>${data.priceRub} ₽</td></tr>
        ${raw(
          data.orderId == null
            ? ""
            : html`<tr><th>Заказ плана</th><td><a href="/admin/orders/${data.orderId}">#${data.orderId}</a></td></tr>`
        )}
      </table>
      ${raw(statusButtons(data))}
    </div>`;

  const banner = data.statusChanged ? html`<div class="banner">Статус изменён.</div>` : "";

  return page(
    `Заявка #${data.id}`,
    html`<h1>Заявка на консультацию #${data.id}</h1>
      <p class="muted">
        ${statusLabel(data.status)} · создана ${when(data.createdAt)} ·
        <a href="/admin/consults">ко всем заявкам</a>
      </p>
      ${raw(banner)}${raw(contactHint)}
      <div class="cols"><div>${raw(left)}</div><div>${raw(right)}</div></div>`
  );
}
