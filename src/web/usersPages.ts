// Таблица пользователей и карточка родителя.
//
// Данные сюда приходят уже собранными, обращений к базе здесь нет.
//
// Главное правило этих страниц: свободный текст родителей в списках
// обрезается и полностью виден только в карточке. В ответах может
// оказаться информация о здоровье ребёнка, и показывать её в таблице,
// которую пролистывают по диагонали, не нужно.

import { formatMoscow } from "../consents";
import { escape, html, page, raw } from "./html";
import { TIMELINE_LABELS, TimelineEvent, TimelineKind } from "./timeline";
import { USER_STATUS_OPTIONS, UserStatus, userStatusText } from "./userStatus";

// Длина обрезки свободного текста из ТЗ.
const SNIPPET = 60;

export function snippet(text: string | null | undefined): string {
  if (!text) return "—";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SNIPPET ? `${flat.slice(0, SNIPPET - 1)}…` : flat;
}

function money(rub: number): string {
  return rub ? `${String(rub).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} ₽` : "—";
}

// ── Таблица пользователей ───────────────────────────────────────────

export interface UserRow {
  telegramId: string;
  username: string | null;
  firstName: string | null;
  createdAt: Date;
  source: string | null;
  status: UserStatus;
  attempts: number;
  paidRub: number;
  tags: string[];
  blocked: boolean;
}

export interface UsersPageData {
  rows: UserRow[];
  total: number;
  page: number;
  pages: number;
  query: string;
  status: string;
  source: string;
  tag: string;
  blocked: boolean;
  sort: string;
  dir: "asc" | "desc";
  sources: string[];
  tags: string[];
  // Текущие параметры строкой: нужны ссылкам сортировки и CSV, чтобы
  // не потерять фильтры.
  params: string;
}

// Ссылка-заголовок: повторный клик переворачивает порядок.
function sortLink(data: UsersPageData, key: string, label: string): string {
  const dir = data.sort === key && data.dir === "asc" ? "desc" : "asc";
  const mark = data.sort === key ? (data.dir === "asc" ? " ↑" : " ↓") : "";
  const params = new URLSearchParams(data.params);
  params.set("sort", key);
  params.set("dir", dir);
  params.delete("page");
  return html`<a href="/admin/users?${raw(params.toString())}">${label}${mark}</a>`;
}

export function renderUsersPage(data: UsersPageData): string {
  const rows = data.rows.map(
    (r) => html`<tr>
      <td>
        <a href="/admin/users/${r.telegramId}">${r.firstName ?? "без имени"}</a>
        ${raw(r.blocked ? html` <span class="pill danger">заблокировала</span>` : "")}
      </td>
      <td>${r.username ? `@${r.username}` : "—"}</td>
      <td class="muted">${formatMoscow(r.createdAt)}</td>
      <td>${r.source ?? "—"}</td>
      <td>${userStatusText(r.status)}</td>
      <td>${r.attempts}</td>
      <td>${money(r.paidRub)}</td>
      <td class="muted">${r.tags.length ? r.tags.join(", ") : "—"}</td>
      <td class="muted">#${r.telegramId}</td>
    </tr>`
  );

  const statusOptions = [`<option value="">любой статус</option>`]
    .concat(
      USER_STATUS_OPTIONS.map(
        (o) =>
          html`<option value="${o.code}" ${raw(o.code === data.status ? "selected" : "")}>${o.label}</option>`
      )
    )
    .join("");

  const sourceOptions = [`<option value="">любой источник</option>`]
    .concat(
      data.sources.map(
        (s) => html`<option value="${s}" ${raw(s === data.source ? "selected" : "")}>${s}</option>`
      )
    )
    .join("");

  const tagOptions = [`<option value="">любой тег</option>`]
    .concat(
      data.tags.map(
        (t) => html`<option value="${t}" ${raw(t === data.tag ? "selected" : "")}>${t}</option>`
      )
    )
    .join("");

  const body = data.rows.length
    ? html`<table>
        <tr>
          <th>${raw(sortLink(data, "name", "Родитель"))}</th>
          <th>Username</th>
          <th>${raw(sortLink(data, "created", "Первый вход"))}</th>
          <th>Источник</th>
          <th>Статус</th>
          <th>${raw(sortLink(data, "attempts", "Прохождений"))}</th>
          <th>${raw(sortLink(data, "paid", "Оплат"))}</th>
          <th>Теги</th>
          <th>Telegram ID</th>
        </tr>
        ${raw(rows.join(""))}
      </table>`
    : html`<p class="muted">Никого не нашлось.</p>`;

  // Пагинация: только соседние страницы, номера целиком не нужны.
  const pager = () => {
    if (data.pages <= 1) return "";
    const link = (p: number, label: string) => {
      const params = new URLSearchParams(data.params);
      params.set("page", String(p));
      return html`<a href="/admin/users?${raw(params.toString())}">${label}</a>`;
    };
    const parts: string[] = [];
    if (data.page > 1) parts.push(link(data.page - 1, "← назад"));
    parts.push(html`<span class="muted">стр. ${data.page} из ${data.pages}</span>`);
    if (data.page < data.pages) parts.push(link(data.page + 1, "вперёд →"));
    return html`<p>${raw(parts.join(" · "))}</p>`;
  };

  const csvParams = new URLSearchParams(data.params);
  csvParams.delete("page");

  return page(
    "Пользователи",
    html`<h1>Пользователи</h1>
      <p class="muted">
        Найдено ${data.total} · <a href="/admin/orders">заказы</a> ·
        <a href="/admin/consents">согласия</a> · <a href="/admin/support">поддержка</a>
      </p>

      <div class="card">
        <form method="get" action="/admin/users">
          <div class="row-actions" style="margin-top:0">
            <input type="text" name="q" value="${data.query}" placeholder="имя, username или id">
            <select name="status">${raw(statusOptions)}</select>
            <select name="source">${raw(sourceOptions)}</select>
            <select name="tag">${raw(tagOptions)}</select>
            <label class="muted">
              <input type="checkbox" name="blocked" value="1" ${raw(data.blocked ? "checked" : "")}>
              только заблокировавшие
            </label>
            <button type="submit">Найти</button>
            <a class="btn secondary" href="/admin/users.csv?${raw(csvParams.toString())}">CSV</a>
          </div>
        </form>
      </div>

      <div class="card">${raw(body)}${raw(pager())}</div>`
  );
}

// ── Карточка родителя ───────────────────────────────────────────────

export interface AttemptCard {
  attemptNumber: number;
  version: string;
  startedAt: Date;
  completedAt: Date | null;
  lastStep: number | null;
  view: string;
  answers: { question: string; answer: string; at: Date }[];
  // Что изменилось относительно предыдущего прохождения: номера
  // вопросов, у которых ответ стал другим.
  changed: Set<string>;
  previousAnswers: Map<string, string> | null;
}

export interface RecommendationCard {
  attempt: number;
  status: string;
  createdAt: Date;
  sentAt: Date | null;
  aiDraft: string | null;
  finalText: string | null;
  deliveryError: string | null;
  cancelReason: string | null;
  waitedText: string;
}

export interface OrderCard {
  id: number;
  product: string;
  priceRub: number;
  status: string;
  createdAt: Date;
  paidAt: Date | null;
  sentAt: Date | null;
  receiptStatus: string;
  receiptUrl: string | null;
  deliveryError: string | null;
  waitedText: string;
}

export interface ConsultCard {
  id: number;
  status: string;
  createdAt: Date;
  paidAt: Date | null;
  contactedAt: Date | null;
  diaryReceived: boolean;
  doneAt: Date | null;
  payoutRub: number | null;
  payoutPaidAt: Date | null;
}

export interface ConsentCardRow {
  type: string;
  action: string;
  version: string | null;
  createdAt: Date;
}

export interface UserCardData {
  telegramId: string;
  username: string | null;
  firstName: string | null;
  createdAt: Date;
  source: string | null;
  status: UserStatus;
  attemptsCount: number;
  paidRub: number;
  tags: string[];
  adminNote: string | null;
  blockedAt: Date | null;
  deletionRequestedAt: Date | null;
  pdConsentWithdrawn: boolean;
  supportThreadId: number | null;
  openDraftUrl: string | null;
  timeline: TimelineEvent[];
  timelineFilter: TimelineKind | "";
  attempts: AttemptCard[];
  recommendations: RecommendationCard[];
  orders: OrderCard[];
  consults: ConsultCard[];
  consents: ConsentCardRow[];
}

function banners(data: UserCardData): string {
  const parts: string[] = [];
  if (data.blockedAt) {
    parts.push(
      html`<div class="banner danger">
        Заблокировала бота ${formatMoscow(data.blockedAt)}. Отправки ей не доходят.
      </div>`
    );
  }
  if (data.deletionRequestedAt) {
    parts.push(
      html`<div class="banner danger">
        Запросила удаление данных ${formatMoscow(data.deletionRequestedAt)}.
      </div>`
    );
  }
  if (data.pdConsentWithdrawn) {
    parts.push(
      html`<div class="banner warn">
        Согласие на обработку данных отозвано: бот ей ничего не отправляет.
      </div>`
    );
  }
  return parts.join("");
}

function header(data: UserCardData): string {
  const who = data.firstName ?? "без имени";
  const links: string[] = [];
  if (data.username) {
    links.push(html`<a href="https://t.me/${data.username}" target="_blank">@${data.username}</a>`);
  }
  if (data.supportThreadId) {
    links.push(html`<a href="/admin/support/${data.supportThreadId}">обращение в поддержку</a>`);
  }
  if (data.openDraftUrl) {
    links.push(html`<a href="${data.openDraftUrl}">открытый черновик</a>`);
  }

  return html`<h1>${who}</h1>
    <p class="muted">
      ${raw(links.join(" · "))}${raw(links.length ? " · " : "")}id ${data.telegramId}
    </p>

    ${raw(banners(data))}

    <div class="card">
      <table>
        <tr><th>Статус</th><td>${userStatusText(data.status)}</td></tr>
        <tr><th>Первый вход</th><td>${formatMoscow(data.createdAt)}</td></tr>
        <tr><th>Источник</th><td>${data.source ?? "—"}</td></tr>
        <tr><th>Прохождений анкеты</th><td>${data.attemptsCount}</td></tr>
        <tr><th>Оплачено</th><td>${money(data.paidRub)}</td></tr>
      </table>

      <form method="post" action="/admin/users/${data.telegramId}/meta">
        <div class="row-actions">
          <input type="text" name="tags" value="${data.tags.join(", ")}" placeholder="теги через запятую">
          <input type="text" name="note" value="${data.adminNote ?? ""}" placeholder="заметка" style="min-width:260px">
          <button type="submit">Сохранить</button>
        </div>
      </form>

      ${raw(
        data.deletionRequestedAt
          ? ""
          : html`<form method="post" action="/admin/users/${data.telegramId}/deletion"
                   onsubmit="return confirm('Отметить запрос на удаление данных?')">
                <div class="row-actions">
                  <button type="submit" class="secondary">Отметить запрос на удаление данных</button>
                </div>
              </form>`
      )}
    </div>`;
}

function timelineBlock(data: UserCardData): string {
  const kinds = Object.keys(TIMELINE_LABELS) as TimelineKind[];
  const chip = (kind: TimelineKind | "", label: string) => {
    const active = data.timelineFilter === kind;
    const url = kind ? `?kind=${kind}` : "?";
    return html`<a class="${active ? "btn" : "btn secondary"}" href="${url}#timeline">${label}</a>`;
  };

  const rows = data.timeline.map(
    (e) => html`<tr>
      <td class="muted" style="white-space:nowrap">${formatMoscow(e.at, true)}</td>
      <td class="muted">${TIMELINE_LABELS[e.kind]}</td>
      <td>${raw(e.href ? html`<a href="${e.href}">${e.text}</a>` : escape(e.text))}</td>
    </tr>`
  );

  return html`<div class="card" id="timeline">
    <h2>История</h2>
    <div class="row-actions" style="margin-top:0">
      ${raw([chip("", "всё"), ...kinds.map((k) => chip(k, TIMELINE_LABELS[k]))].join(""))}
    </div>
    ${raw(
      rows.length
        ? html`<table>${raw(rows.join(""))}</table>`
        : html`<p class="muted">Событий нет.</p>`
    )}
  </div>`;
}

function attemptsTab(data: UserCardData): string {
  if (!data.attempts.length) return html`<p class="muted">Анкету не начинала.</p>`;

  const blocks = data.attempts.map((a) => {
    const rows = a.answers.map((ans) => {
      const changed = a.changed.has(ans.question);
      const before = a.previousAnswers?.get(ans.question);
      return html`<tr class="${changed ? "changed" : ""}">
        <td>${ans.question}</td>
        <td>${ans.answer}</td>
        ${raw(
          a.previousAnswers
            ? html`<td class="muted">${before ?? "—"}</td>`
            : ""
        )}
        <td class="muted" style="white-space:nowrap">${formatMoscow(ans.at)}</td>
      </tr>`;
    });

    const head = a.previousAnswers
      ? html`<tr><th>Вопрос</th><th>Ответ</th><th>Было в №${a.attemptNumber - 1}</th><th>Когда</th></tr>`
      : html`<tr><th>Вопрос</th><th>Ответ</th><th>Когда</th></tr>`;

    return html`<details ${raw(a.attemptNumber === data.attempts.length ? "open" : "")}>
      <summary>
        Прохождение №${a.attemptNumber} · ${a.view} ·
        начато ${formatMoscow(a.startedAt)}${raw(
          a.completedAt ? html`, завершено ${formatMoscow(a.completedAt)}` : ""
        )}${raw(a.completedAt ? "" : html`, остановилась на вопросе ${a.lastStep ?? "—"}`)}
        <span class="muted">· версия ${a.version}</span>
      </summary>
      ${raw(
        a.previousAnswers
          ? html`<p class="muted">Подсвечены ответы, изменившиеся относительно прохождения №${a.attemptNumber - 1}.</p>`
          : ""
      )}
      <table>${raw(head)}${raw(rows.join(""))}</table>
    </details>`;
  });

  return blocks.join("");
}

function recommendationsTab(data: UserCardData): string {
  if (!data.recommendations.length) return html`<p class="muted">Разборов нет.</p>`;

  return data.recommendations
    .map(
      (r) => html`<div class="card">
        <p class="muted">
          Прохождение №${r.attempt} · ${r.status} · ждала ${r.waitedText} ·
          анкета сдана ${formatMoscow(r.createdAt)}${raw(
            r.sentAt ? html`, отправлено ${formatMoscow(r.sentAt)}` : ""
          )}
        </p>
        ${raw(
          r.deliveryError
            ? html`<div class="banner danger">Ошибка доставки: ${r.deliveryError}</div>`
            : ""
        )}
        ${raw(
          r.cancelReason
            ? html`<div class="banner warn">Отменён: ${r.cancelReason}</div>`
            : ""
        )}
        <div class="two-up">
          <div>
            <h3>Черновик модели</h3>
            <pre>${r.aiDraft ?? "—"}</pre>
          </div>
          <div>
            <h3>Что ушло родителю</h3>
            <pre>${r.finalText ?? "—"}</pre>
          </div>
        </div>
      </div>`
    )
    .join("");
}

function ordersTab(data: UserCardData): string {
  if (!data.orders.length) return html`<p class="muted">Заказов нет.</p>`;
  const rows = data.orders.map(
    (o) => html`<tr>
      <td><a href="/admin/orders/${o.id}">#${o.id}</a></td>
      <td>${o.product}</td>
      <td>${money(o.priceRub)}</td>
      <td>${o.status}</td>
      <td class="muted">${formatMoscow(o.createdAt)}</td>
      <td class="muted">${o.paidAt ? formatMoscow(o.paidAt) : "—"}</td>
      <td>${o.waitedText}</td>
      <td>${raw(o.receiptUrl ? html`<a href="${o.receiptUrl}">${o.receiptStatus}</a>` : escape(o.receiptStatus))}</td>
    </tr>`
  );
  return html`<table>
    <tr><th>Заказ</th><th>Продукт</th><th>Сумма</th><th>Статус</th><th>Создан</th><th>Оплачен</th><th>Ждала</th><th>Чек</th></tr>
    ${raw(rows.join(""))}
  </table>`;
}

function consultsTab(data: UserCardData): string {
  if (!data.consults.length) return html`<p class="muted">Заявок на консультацию нет.</p>`;
  const rows = data.consults.map(
    (c) => html`<tr>
      <td><a href="/admin/consults/${c.id}">#${c.id}</a></td>
      <td>${c.status}</td>
      <td class="muted">${formatMoscow(c.createdAt)}</td>
      <td class="muted">${c.paidAt ? formatMoscow(c.paidAt) : "—"}</td>
      <td class="muted">${c.contactedAt ? formatMoscow(c.contactedAt) : "—"}</td>
      <td>${c.diaryReceived ? "да" : "нет"}</td>
      <td class="muted">${c.doneAt ? formatMoscow(c.doneAt) : "—"}</td>
      <td>${c.payoutPaidAt ? `${money(c.payoutRub ?? 0)} ${formatMoscow(c.payoutPaidAt)}` : "—"}</td>
    </tr>`
  );
  return html`<table>
    <tr><th>Заявка</th><th>Статус</th><th>Запрос</th><th>Оплата</th><th>София связалась</th><th>Дневник</th><th>Проведена</th><th>Выплата</th></tr>
    ${raw(rows.join(""))}
  </table>`;
}

function consentsTab(data: UserCardData): string {
  if (!data.consents.length) return html`<p class="muted">Записей нет.</p>`;
  const rows = data.consents.map(
    (c) => html`<tr>
      <td class="muted">${formatMoscow(c.createdAt, true)}</td>
      <td>${c.type}</td>
      <td>${c.action}</td>
      <td class="muted">${c.version ?? "—"}</td>
    </tr>`
  );
  return html`<table>
      <tr><th>Когда</th><th>Согласие</th><th>Действие</th><th>Версия</th></tr>
      ${raw(rows.join(""))}
    </table>
    <p class="muted">
      Полный журнал с текстами, которые человек видел:
      <a href="/admin/users/${data.telegramId}/consents">открыть</a>
    </p>`;
}

export function renderUserCard(data: UserCardData): string {
  // Вкладки на чистом CSS, без скриптов: нужен один открытый блок из
  // пяти, и :target справляется без строчки JavaScript.
  const style = `
    .tabs { display:flex; gap:8px; flex-wrap:wrap; margin:24px 0 0 }
    .tab { display:none }
    .tab:target { display:block }
    .tab:first-of-type { display:block }
    .tab:target ~ .tab:first-of-type { display:none }
    .two-up { display:grid; grid-template-columns:1fr 1fr; gap:16px }
    .two-up pre { white-space:pre-wrap; word-break:break-word }
    tr.changed td { background:#FFF6E6 }
    details { margin-bottom:12px }
    summary { cursor:pointer }
    @media (max-width:900px) { .two-up { grid-template-columns:1fr } }
  `;

  const tabs: [string, string, string][] = [
    ["attempts", "Прохождения", attemptsTab(data)],
    ["recommendations", "Разборы", recommendationsTab(data)],
    ["orders", "Заказы", ordersTab(data)],
    ["consults", "Консультации", consultsTab(data)],
    ["consents", "Согласия", consentsTab(data)],
  ];

  const nav = tabs
    .map(([id, label]) => html`<a class="btn secondary" href="#${id}">${label}</a>`)
    .join("");

  const panes = tabs
    .map(
      ([id, label, body]) => html`<div class="card tab" id="${id}">
        <h2>${label}</h2>
        ${raw(body)}
      </div>`
    )
    .join("");

  return page(
    data.firstName ?? `#${data.telegramId}`,
    html`<style>${raw(style)}</style>
      <p class="muted"><a href="/admin/users">← ко всем пользователям</a></p>
      ${raw(header(data))}
      ${raw(timelineBlock(data))}
      <div class="tabs">${raw(nav)}</div>
      ${raw(panes)}`
  );
}

// ── CSV ─────────────────────────────────────────────────────────────

// Выгрузка текущей выборки. Свободного текста здесь нет: в таблице его
// и не показывают, а в выгрузке он утёк бы целиком.
export function usersCsv(rows: UserRow[]): string {
  const cell = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const lines = [
    [
      "telegram_id",
      "username",
      "first_name",
      "created_at_msk",
      "source",
      "status",
      "attempts",
      "paid_rub",
      "tags",
      "blocked",
    ].join(","),
  ];

  for (const r of rows) {
    lines.push(
      [
        cell(r.telegramId),
        cell(r.username ?? ""),
        cell(r.firstName ?? ""),
        cell(formatMoscow(r.createdAt, true)),
        cell(r.source ?? ""),
        cell(userStatusText(r.status)),
        cell(String(r.attempts)),
        cell(String(r.paidRub)),
        cell(r.tags.join(" ")),
        cell(r.blocked ? "yes" : "no"),
      ].join(",")
    );
  }

  return lines.join("\r\n") + "\r\n";
}

export { escape };
