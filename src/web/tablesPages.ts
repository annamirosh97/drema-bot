// Вёрстка пяти таблиц, воронки анкеты и итогов по деньгам.
//
// Данные приходят готовыми, обращений к базе здесь нет. Общая обвязка —
// поиск, сортировка, страницы, выгрузка — в tableChrome.ts.

import { formatMoscow } from "../consents";
import { escape, html, page, raw } from "./html";
import {
  ChromeData,
  crossLinks,
  cut,
  pager,
  searchForm,
  sortHeader,
} from "./tableChrome";
import type {
  AnalysisRow,
  AttemptRow,
  ConsentLogRow,
  ConsultTableRow,
  FunnelStep,
  OrderTableRow,
} from "./tablesData";

function money(rub: number): string {
  return `${String(rub).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} ₽`;
}

function when(date: Date | null): string {
  return date ? formatMoscow(date) : "—";
}

function yesNo(value: boolean): string {
  return value ? "да" : "нет";
}

// Выпадающий фильтр: пустое значение всегда первым.
function select(
  name: string,
  current: string,
  options: [string, string][],
  anyLabel: string
): string {
  const items = [html`<option value="">${anyLabel}</option>`].concat(
    options.map(
      ([value, label]) =>
        html`<option value="${value}" ${raw(value === current ? "selected" : "")}>${label}</option>`
    )
  );
  return html`<select name="${name}">${raw(items.join(""))}</select>`;
}

function checkbox(name: string, checked: boolean, label: string): string {
  return html`<label class="muted">
    <input type="checkbox" name="${name}" value="1" ${raw(checked ? "checked" : "")}> ${label}
  </label>`;
}

// Общий каркас страницы-таблицы.
function tablePage(options: {
  title: string;
  heading: string;
  note: string;
  chrome: ChromeData;
  filters: string;
  above?: string;
  table: string;
}): string {
  return page(
    options.title,
    html`<h1>${options.heading}</h1>
      <p class="muted">${raw(options.note)} · ${raw(crossLinks(options.chrome.base))}</p>
      ${raw(options.above ?? "")}
      ${raw(searchForm(options.chrome, options.filters))}
      <div class="card">${raw(options.table)}${raw(pager(options.chrome))}</div>`
  );
}

function emptyRow(text = "Ничего не нашлось."): string {
  return html`<p class="muted">${text}</p>`;
}

// ── Воронка анкеты ──────────────────────────────────────────────────

// Горизонтальные полосы с числом и процентом от начавших, как в ТЗ.
export function renderFunnel(steps: FunnelStep[]): string {
  if (!steps.length || steps[0].reached === 0) {
    return html`<div class="card">
      <h2>Воронка анкеты</h2>
      <p class="muted">
        За выбранный период прохождений нет. Воронка строится только по
        прохождениям после 20.10.2026: у более старых событий нет номера
        прохождения, и смешивать их с новыми нельзя.
      </p>
    </div>`;
  }

  const bars = steps
    .map(
      (s) => html`<tr>
        <td style="white-space:nowrap">${s.question}</td>
        <td class="muted">${s.label}</td>
        <td style="width:45%">
          <div class="bar"><span style="width:${s.percent}%"></span></div>
        </td>
        <td style="white-space:nowrap">${s.reached} · ${s.percent}%</td>
      </tr>`
    )
    .join("");

  const style = `
    .bar { background:#EFEDF6; border-radius:4px; height:14px; overflow:hidden }
    .bar span { display:block; height:100%; background:#8E86C4 }
  `;

  return html`<style>${raw(style)}</style>
    <div class="card">
      <h2>Воронка анкеты</h2>
      <p class="muted">Процент от дошедших до первого вопроса.</p>
      <table>${raw(bars)}</table>
    </div>`;
}

// ── Экран 3. Прохождения ────────────────────────────────────────────

const ATTEMPT_VIEWS: [string, string][] = [
  ["in_progress", "в работе"],
  ["completed", "завершено"],
  ["abandoned", "брошено"],
];

const VIEW_LABELS: Record<string, string> = {
  in_progress: "в работе",
  completed: "завершено",
  abandoned: "брошено",
};

export function renderAttemptsPage(data: {
  chrome: ChromeData;
  rows: AttemptRow[];
  funnel: FunnelStep[];
  filters: { view: string; step: string; repeated: boolean };
  steps: string[];
}): string {
  const rows = data.rows.map(
    (r) => html`<tr>
      <td><a href="/admin/users/${r.telegramId}">${r.parent}</a></td>
      <td>№${r.attemptNumber}</td>
      <td>${r.babyAge ? `${r.babyAge} мес` : "—"}</td>
      <td class="muted">${when(r.startedAt)}</td>
      <td class="muted">${when(r.completedAt)}</td>
      <td>${r.lastStep ?? "—"}</td>
      <td>
        <span class="${r.view === "abandoned" ? "pill warn" : "pill"}">${VIEW_LABELS[r.view]}</span>
      </td>
      <td class="muted">${r.version}</td>
    </tr>`
  );

  const table = data.rows.length
    ? html`<table>
        <tr>
          <th>${raw(sortHeader(data.chrome, "parent", "Родитель"))}</th>
          <th>${raw(sortHeader(data.chrome, "attempt", "Попытка"))}</th>
          <th>Малышу</th>
          <th>${raw(sortHeader(data.chrome, "started", "Начало"))}</th>
          <th>${raw(sortHeader(data.chrome, "completed", "Конец"))}</th>
          <th>${raw(sortHeader(data.chrome, "step", "Шаг остановки"))}</th>
          <th>Статус</th>
          <th>Версия</th>
        </tr>
        ${raw(rows.join(""))}
      </table>`
    : emptyRow();

  const filters = [
    select("view", data.filters.view, ATTEMPT_VIEWS, "любой статус"),
    select(
      "step",
      data.filters.step,
      data.steps.map((s) => [s, `вопрос ${s}`] as [string, string]),
      "любой шаг"
    ),
    checkbox("repeated", data.filters.repeated, "только повторные"),
  ].join("");

  return tablePage({
    title: "Прохождения",
    heading: "Прохождения анкеты",
    note: `Найдено ${data.chrome.total}`,
    chrome: data.chrome,
    filters,
    above: renderFunnel(data.funnel),
    table,
  });
}

// ── Экран 4. Согласия ───────────────────────────────────────────────

const CONSENT_TYPES: [string, string][] = [
  ["PD_PROCESSING", "обработка данных"],
  ["MARKETING", "рассылка"],
  ["OFFER_ACCEPTANCE", "оферта"],
  ["SPECIALIST_TRANSFER", "передача специалисту"],
  ["HEALTH_SELF_DECLARATION", "о здоровье"],
];

const CONSENT_ACTIONS: [string, string][] = [
  ["GRANTED", "дал"],
  ["DECLINED", "отказался"],
  ["REVOKED", "отозвал"],
];

const LABEL = (pairs: [string, string][], value: string) =>
  pairs.find(([v]) => v === value)?.[1] ?? value;

export function renderConsentLogPage(data: {
  chrome: ChromeData;
  rows: ConsentLogRow[];
  filters: { type: string; action: string; version: string };
  versions: string[];
}): string {
  const rows = data.rows.map(
    (r) => html`<tr>
      <td><a href="/admin/users/${r.telegramId}">${r.parent}</a></td>
      <td>${LABEL(CONSENT_TYPES, r.type)}</td>
      <td>
        <span class="${r.action === "REVOKED" ? "pill warn" : "pill"}">
          ${LABEL(CONSENT_ACTIONS, r.action)}
        </span>
      </td>
      <td class="muted">${r.version ?? "—"}</td>
      <td class="muted">${r.source}</td>
      <td class="muted">${formatMoscow(r.createdAt, true)}</td>
      <td><a href="/admin/users/${r.telegramId}/consents">журнал</a></td>
    </tr>`
  );

  const table = data.rows.length
    ? html`<table>
        <tr>
          <th>${raw(sortHeader(data.chrome, "parent", "Родитель"))}</th>
          <th>${raw(sortHeader(data.chrome, "type", "Согласие"))}</th>
          <th>${raw(sortHeader(data.chrome, "action", "Действие"))}</th>
          <th>Версия</th>
          <th>Источник</th>
          <th>${raw(sortHeader(data.chrome, "created", "Когда"))}</th>
          <th></th>
        </tr>
        ${raw(rows.join(""))}
      </table>`
    : emptyRow("Записей нет.");

  const filters = [
    select("type", data.filters.type, CONSENT_TYPES, "любое согласие"),
    select("action", data.filters.action, CONSENT_ACTIONS, "любое действие"),
    select(
      "version",
      data.filters.version,
      data.versions.map((v) => [v, v] as [string, string]),
      "любая версия"
    ),
  ].join("");

  return tablePage({
    title: "Согласия",
    heading: "Согласия",
    note: `Найдено ${data.chrome.total} · записи только добавляются, менять их нельзя`,
    chrome: data.chrome,
    filters,
    table,
  });
}

// ── Экран 5. Бесплатные анализы ─────────────────────────────────────

const ANALYSIS_STATUSES: [string, string][] = [
  ["generating", "генерируется"],
  ["generation_failed", "сбой генерации"],
  ["draft", "черновик готов"],
  ["sent", "отправлен"],
  ["delivery_failed", "не доставлен"],
  ["cancelled", "отменён"],
];

const PDF_RESULT_LABELS: Record<string, string> = {
  BETTER: "Стало лучше",
  SAME: "Без изменений",
  WORSE: "Стало хуже",
  NOT_STARTED: "Пока не начали",
};

const RATING_LABELS: Record<string, string> = {
  YES: "узнал",
  PARTLY: "отчасти",
  NO: "не совсем",
};

export function renderAnalysesPage(data: {
  chrome: ChromeData;
  rows: AnalysisRow[];
  filters: { status: string; overdue: boolean };
}): string {
  const rows = data.rows.map(
    (r) => html`<tr>
      <td><a href="/admin/users/${r.telegramId}">${r.parent}</a></td>
      <td>№${r.attempt}</td>
      <td>${LABEL(ANALYSIS_STATUSES, r.status)}</td>
      <td>
        <span class="${r.overdue ? "pill danger" : "pill"}">${r.waiting}</span>
      </td>
      <td class="muted">${when(r.sentAt)}</td>
      <td class="muted">${r.costUsd !== null ? `$${r.costUsd.toFixed(2)}` : "—"}</td>
      <td>${r.rating ? RATING_LABELS[r.rating] ?? r.rating : "—"}</td>
      <td><a href="/admin/analysis/${r.telegramId}">открыть</a></td>
    </tr>`
  );

  const table = data.rows.length
    ? html`<table>
        <tr>
          <th>${raw(sortHeader(data.chrome, "parent", "Родитель"))}</th>
          <th>Прохождение</th>
          <th>${raw(sortHeader(data.chrome, "status", "Статус"))}</th>
          <th>${raw(sortHeader(data.chrome, "waiting", "Ждал"))}</th>
          <th>${raw(sortHeader(data.chrome, "sent", "Отправлено"))}</th>
          <th>${raw(sortHeader(data.chrome, "cost", "API"))}</th>
          <th>Оценка</th>
          <th></th>
        </tr>
        ${raw(rows.join(""))}
      </table>`
    : emptyRow("Разборов нет.");

  const filters = [
    select("status", data.filters.status, ANALYSIS_STATUSES, "любой статус"),
    checkbox("overdue", data.filters.overdue, "только просроченные"),
  ].join("");

  return tablePage({
    title: "Бесплатные анализы",
    heading: "Бесплатные анализы",
    note:
      `Найдено ${data.chrome.total} · стоимость API суммируется по родителю: ` +
      "в таблице вызовов нет номера прохождения",
    chrome: data.chrome,
    filters,
    table,
  });
}

// ── Экран 6. Заказы ─────────────────────────────────────────────────

const PRODUCTS: [string, string][] = [
  ["PDF", "персональный план"],
  ["CONSULT", "консультация"],
];

const PAY_STATUSES: [string, string][] = [
  ["не оплачен", "не оплачен"],
  ["оплачен", "оплачен"],
  ["возврат", "возврат"],
];

const PDF_STATUSES: [string, string][] = [
  ["generating", "генерируется"],
  ["generation_failed", "сбой генерации"],
  ["draft", "черновик готов"],
  ["sent", "отправлен"],
  ["delivery_failed", "не доставлен"],
  ["closed", "закрыт"],
];

const RECEIPTS: [string, string][] = [
  ["NOT_NEEDED", "не нужен"],
  ["PENDING", "не выбит"],
  ["ISSUED", "выбит"],
];

export interface OrderTotals {
  paidRub: number;
  paidCount: number;
  refundedRub: number;
  refundedCount: number;
  receiptsPending: number;
  payoutPendingCount: number;
}

function renderTotals(totals: OrderTotals): string {
  return html`<div class="card">
    <h2>Итоги за период</h2>
    <table>
      <tr><th>Оплачено</th><td>${money(totals.paidRub)} · ${totals.paidCount} заказов</td></tr>
      <tr><th>Возвраты</th><td>${money(totals.refundedRub)} · ${totals.refundedCount}</td></tr>
      <tr><th>Чеков не выбито</th><td>${totals.receiptsPending}</td></tr>
      <tr><th>Консультаций к выплате</th><td>${totals.payoutPendingCount}</td></tr>
    </table>
    <p class="muted">
      Сумма к выплате Софии не считается: её доля пока не зафиксирована,
      и в заявках она заполняется руками.
    </p>
  </div>`;
}

export function renderOrdersTablePage(data: {
  chrome: ChromeData;
  rows: OrderTableRow[];
  totals: OrderTotals;
  filters: { product: string; pay: string; pdf: string; receipt: string };
}): string {
  const rows = data.rows.map(
    (r) => html`<tr>
      <td><a href="/admin/orders/${r.id}">#${r.id}</a></td>
      <td><a href="/admin/users/${r.telegramId}">${r.parent}</a></td>
      <td>${LABEL(PRODUCTS, r.product)}</td>
      <td>${money(r.priceRub)}</td>
      <td>
        <span class="${r.payStatus === "возврат" ? "pill warn" : "pill"}">${r.payStatus}</span>
      </td>
      <td class="muted">${when(r.paidAt)}</td>
      <td>${LABEL(PDF_STATUSES, r.pdfStatus)}</td>
      <td>
        <span class="${r.pdfStatus === "delivery_failed" ? "pill danger" : "pill"}">${r.waiting}</span>
      </td>
      <td>${yesNo(r.analysisSent)}</td>
      <td>
        ${raw(
          r.receiptUrl
            ? html`<a href="${r.receiptUrl}">${LABEL(RECEIPTS, r.receiptStatus)}</a>`
            : escape(LABEL(RECEIPTS, r.receiptStatus))
        )}
      </td>
      <td>${r.pdfResult ? PDF_RESULT_LABELS[r.pdfResult] ?? r.pdfResult : "—"}</td>
    </tr>`
  );

  const table = data.rows.length
    ? html`<table>
        <tr>
          <th>Заказ</th>
          <th>${raw(sortHeader(data.chrome, "parent", "Родитель"))}</th>
          <th>Продукт</th>
          <th>${raw(sortHeader(data.chrome, "price", "Сумма"))}</th>
          <th>Оплата</th>
          <th>${raw(sortHeader(data.chrome, "paid", "Оплачен"))}</th>
          <th>План</th>
          <th>${raw(sortHeader(data.chrome, "waiting", "Ждал"))}</th>
          <th>Разбор ушёл</th>
          <th>Чек</th>
          <th>Результат</th>
        </tr>
        ${raw(rows.join(""))}
      </table>`
    : emptyRow("Заказов нет.");

  const filters = [
    select("product", data.filters.product, PRODUCTS, "любой продукт"),
    select("pay", data.filters.pay, PAY_STATUSES, "любая оплата"),
    select("pdf", data.filters.pdf, PDF_STATUSES, "любой статус плана"),
    select("receipt", data.filters.receipt, RECEIPTS, "любой чек"),
  ].join("");

  return tablePage({
    title: "Заказы",
    heading: "Платные заказы",
    note: `Найдено ${data.chrome.total}`,
    chrome: data.chrome,
    filters,
    above: renderTotals(data.totals),
    table,
  });
}

// ── Экран 7. Консультации ───────────────────────────────────────────

const CONSULT_STATUSES: [string, string][] = [
  ["PENDING_PAYMENT", "ждёт оплаты"],
  ["PAID", "оплачена"],
  ["NEW", "новая"],
  ["CONTACTED", "связались"],
  ["DONE", "проведена"],
  ["CHAT_CREATED", "чат создан"],
  ["LOST", "не дошли до оплаты"],
  ["CANCELED", "отменена"],
];

export function renderConsultsTablePage(data: {
  chrome: ChromeData;
  rows: ConsultTableRow[];
  filters: { status: string; notContacted: boolean; notPaidOut: boolean };
}): string {
  const rows = data.rows.map(
    (r) => html`<tr>
      <td><a href="/admin/consults/${r.id}">#${r.id}</a></td>
      <td><a href="/admin/users/${r.telegramId}">${r.parent}</a></td>
      <td>${LABEL(CONSULT_STATUSES, r.status)}</td>
      <td class="muted">${when(r.createdAt)}</td>
      <td class="muted">${when(r.paidAt)}</td>
      <td class="muted">${when(r.contactedAt)}</td>
      <td>${yesNo(r.diaryReceived)}</td>
      <td class="muted">${when(r.doneAt)}</td>
      <td>
        ${raw(
          r.payoutPaidAt
            ? html`${money(r.payoutRub ?? 0)} · ${formatMoscow(r.payoutPaidAt)}`
            : r.doneAt
              ? html`<span class="pill warn">не выплачено</span>`
              : escape("—")
        )}
      </td>
    </tr>`
  );

  const table = data.rows.length
    ? html`<table>
        <tr>
          <th>Заявка</th>
          <th>${raw(sortHeader(data.chrome, "parent", "Родитель"))}</th>
          <th>${raw(sortHeader(data.chrome, "status", "Статус"))}</th>
          <th>${raw(sortHeader(data.chrome, "created", "Запрос"))}</th>
          <th>Оплата</th>
          <th>${raw(sortHeader(data.chrome, "contacted", "София связалась"))}</th>
          <th>Дневник</th>
          <th>${raw(sortHeader(data.chrome, "done", "Проведена"))}</th>
          <th>Выплата</th>
        </tr>
        ${raw(rows.join(""))}
      </table>`
    : emptyRow("Заявок нет.");

  const filters = [
    select("status", data.filters.status, CONSULT_STATUSES, "любой статус"),
    checkbox("notContacted", data.filters.notContacted, "не связались"),
    checkbox("notPaidOut", data.filters.notPaidOut, "не выплачено"),
  ].join("");

  return tablePage({
    title: "Консультации",
    heading: "Консультации",
    note: `Найдено ${data.chrome.total}`,
    chrome: data.chrome,
    filters,
    table,
  });
}

export { cut, escape };
