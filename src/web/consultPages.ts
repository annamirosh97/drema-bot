// Разметка двух страниц админки по заявкам на консультацию: список и
// страница заявки. Данные сюда приходят уже собранными, обращений к базе
// здесь нет — как и в pages.ts.

import { html, page, raw } from "./html";

// Человеческие подписи вместо значений enum: статусы читает человек, а
// не код, и «Связались» понятнее, чем CONTACTED.
const STATUS_LABELS: Record<string, string> = {
  NEW: "новая",
  CONTACTED: "написали",
  PAID: "оплачено",
  CHAT_CREATED: "чат создан",
  DONE: "завершена",
  LOST: "не дошли до оплаты",
  // Не используются с 29.10.2026, остались у перенесённых заявок.
  PENDING_PAYMENT: "ждёт оплаты",
  CANCELED: "отменена",
};

const FIRST_CONTACT_LABELS: Record<string, string> = {
  PENDING: "родитель ещё не выбрал",
  TEAM: "команда Дрёмиуса",
  PARENT: "родитель",
  // Не используется с 29.10.2026: раньше первой писала София.
  SPECIALIST: "София",
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


// Подсветка только у новых заявок: у завершённой «48 ч» ни о чём не
// говорит, а у новой это пропущенные сутки.
function waitingPill(hours: number, status: string): string {
  const cls = status === "NEW" && hours > 20 ? "pill danger" : "pill";
  return html`<span class="${cls}">${Math.round(hours)} ч</span>`;
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
  // Отметки, которых требует очередь админки.
  diaryReceived: boolean;
  payoutRub: number | null;
  payoutPaidAt: Date | null;
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

  // Статусы идут только вперёд, поэтому кнопка одна — на следующий
  // шаг. «Не дошли до оплаты» доступна с любого шага до завершения.
  const NEXT: Record<string, [string, string] | undefined> = {
    NEW: ["CONTACTED", "Написали"],
    CONTACTED: ["PAID", "Оплачено"],
    PAID: ["CHAT_CREATED", "Чат создан"],
    CHAT_CREATED: ["DONE", "Завершена"],
  };

  const buttons: string[] = [];
  const next = NEXT[data.status];
  if (next) {
    buttons.push(button(next[0], next[1], `Отметить: ${next[1].toLowerCase()}?`));
    buttons.push(button("LOST", "Не дошли до оплаты", "Закрыть заявку как «не дошли до оплаты»?"));
  }

  if (!buttons.length) return html`<p class="muted">Заявка закрыта, менять статус больше нечего.</p>`;
  return html`<div class="row-actions">${raw(buttons.join(""))}</div>`;
}

// Отметки, которых требует очередь: дневник сна и выплата Софии.
// Отдельно от статусов: это не переходы заявки, а факты рядом с ней.
function marksForm(data: ConsultPageData): string {
  const parts: string[] = [];

  if (!data.diaryReceived) {
    parts.push(
      html`<form method="post" action="/admin/consults/${data.id}/diary">
        <button type="submit" class="secondary">Дневник сна получен</button>
      </form>`
    );
  }

  // Выплата — только по проведённой консультации: платить за
  // непроведённую нечего.
  if (data.doneAt && !data.payoutPaidAt) {
    parts.push(
      html`<form method="post" action="/admin/consults/${data.id}/payout">
        <input type="number" name="rub" placeholder="сумма Софии, ₽" style="max-width:160px" required>
        <button type="submit" class="secondary">Выплата сделана</button>
      </form>`
    );
  }

  if (!parts.length) return "";
  return html`<div class="card">
    <h2>Отметки</h2>
    <div class="row-actions" style="margin-top:0">${raw(parts.join(""))}</div>
    <p class="muted">
      Сумму выплаты вводим руками: доля Софии пока не зафиксирована.
    </p>
  </div>`;
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
    </div>

    ${raw(marksForm(data))}`;

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
