// Общая обвязка таблиц админки: поиск, фильтры, сортировка, страницы,
// выгрузка.
//
// ТЗ требует одного и того же от пяти экранов. Без этого файла поиск,
// пагинация и ссылки сортировки были бы написаны пять раз, и первая же
// правка расходилась бы по четырём из них.

import { html, raw } from "./html";

export const PAGE_SIZE = 50;

// Разбор общих параметров. Своё у каждой таблицы — только фильтры, они
// приходят отдельным разбором.
export interface TableQuery {
  q: string;
  from: string;
  to: string;
  sort: string;
  dir: "asc" | "desc";
  page: number;
}

export function parseTableQuery(
  query: Record<string, unknown>,
  defaultSort: string
): TableQuery {
  const str = (key: string) =>
    typeof query[key] === "string" ? (query[key] as string).trim() : "";
  const sort = str("sort") || defaultSort;
  // По умолчанию свежее сверху: в админке почти всегда нужно последнее.
  const dir = str("dir") === "asc" ? "asc" : "desc";
  return {
    q: str("q"),
    from: str("from"),
    to: str("to"),
    sort,
    dir,
    page: Math.max(1, parseInt(str("page") || "1", 10) || 1),
  };
}

// Границы периода. Пустое поле означает «без границы», а не «сегодня»:
// иначе открытая страница молча показывала бы только один день.
export function dateRange(query: TableQuery): { gte?: Date; lte?: Date } {
  const range: { gte?: Date; lte?: Date } = {};
  if (query.from) {
    const d = new Date(`${query.from}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) range.gte = d;
  }
  if (query.to) {
    const d = new Date(`${query.to}T23:59:59Z`);
    if (!Number.isNaN(d.getTime())) range.lte = d;
  }
  return range;
}

// Сортировка в памяти: таблицы собираются из нескольких источников, и
// отдать порядок базе получается не всегда.
export function sortRows<T>(
  rows: T[],
  query: TableQuery,
  keys: Record<string, (row: T) => string | number | null>
): T[] {
  const pick = keys[query.sort] ?? Object.values(keys)[0];
  const factor = query.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = pick(a);
    const y = pick(b);
    // Пустые значения всегда снизу: «нет данных» не должно
    // притворяться самым маленьким числом.
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    if (typeof x === "number" && typeof y === "number") return factor * (x - y);
    return factor * String(x).localeCompare(String(y));
  });
}

export interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pages: number;
}

export function paginate<T>(rows: T[], page: number, pageSize = PAGE_SIZE): Paged<T> {
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(page, pages);
  return {
    rows: Number.isFinite(pageSize)
      ? rows.slice((current - 1) * pageSize, current * pageSize)
      : rows,
    total,
    page: current,
    pages,
  };
}

// ── Вёрстка ─────────────────────────────────────────────────────────

export interface ChromeData {
  base: string;
  params: string;
  query: TableQuery;
  total: number;
  page: number;
  pages: number;
}

// Заголовок-ссылка: повторный клик переворачивает порядок.
export function sortHeader(data: ChromeData, key: string, label: string): string {
  const dir = data.query.sort === key && data.query.dir === "asc" ? "desc" : "asc";
  const mark = data.query.sort === key ? (data.query.dir === "asc" ? " ↑" : " ↓") : "";
  const params = new URLSearchParams(data.params);
  params.set("sort", key);
  params.set("dir", dir);
  params.delete("page");
  return html`<a href="${data.base}?${raw(params.toString())}">${label}${mark}</a>`;
}

// Поиск, период и выгрузка. Фильтры каждой таблицы передаются готовой
// разметкой: они у всех свои.
export function searchForm(data: ChromeData, filters = ""): string {
  const csv = new URLSearchParams(data.params);
  csv.delete("page");

  return html`<div class="card">
    <form method="get" action="${data.base}">
      <div class="row-actions" style="margin-top:0">
        <input type="text" name="q" value="${data.query.q}" placeholder="имя, username или id">
        <input type="date" name="from" value="${data.query.from}" title="с даты">
        <input type="date" name="to" value="${data.query.to}" title="по дату">
        ${raw(filters)}
        <input type="hidden" name="sort" value="${data.query.sort}">
        <input type="hidden" name="dir" value="${data.query.dir}">
        <button type="submit">Показать</button>
        <a class="btn secondary" href="${data.base}.csv?${raw(csv.toString())}">CSV</a>
      </div>
    </form>
  </div>`;
}

export function pager(data: ChromeData): string {
  if (data.pages <= 1) return "";
  const link = (p: number, label: string) => {
    const params = new URLSearchParams(data.params);
    params.set("page", String(p));
    return html`<a href="${data.base}?${raw(params.toString())}">${label}</a>`;
  };
  const parts: string[] = [];
  if (data.page > 1) parts.push(link(data.page - 1, "← назад"));
  parts.push(html`<span class="muted">стр. ${data.page} из ${data.pages}</span>`);
  if (data.page < data.pages) parts.push(link(data.page + 1, "вперёд →"));
  return html`<p>${raw(parts.join(" · "))}</p>`;
}

// Общая строка ссылок между экранами. Текущий не ссылается на себя.
export function crossLinks(current: string): string {
  const links: [string, string][] = [
    ["/admin/queue", "очередь"],
    ["/admin/users", "пользователи"],
    ["/admin/attempts", "прохождения"],
    ["/admin/analyses", "разборы"],
    ["/admin/orders", "заказы"],
    ["/admin/consults", "консультации"],
    ["/admin/consent-log", "согласия"],
    ["/admin/support", "поддержка"],
    ["/admin/log", "журнал"],
  ];
  return links
    .filter(([href]) => href !== current)
    .map(([href, label]) => html`<a href="${href}">${label}</a>`)
    .join(" · ");
}

// Параметры текущей выборки строкой: нужны ссылкам сортировки, страниц
// и выгрузки, чтобы не растерять фильтры.
export function buildParams(
  query: TableQuery,
  filters: Record<string, string | boolean>
): string {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  for (const [key, value] of Object.entries(filters)) {
    if (value === true) params.set(key, "1");
    else if (typeof value === "string" && value) params.set(key, value);
  }
  params.set("sort", query.sort);
  params.set("dir", query.dir);
  return params.toString();
}

// Свободный текст в списках обрезается: в ответах может оказаться
// информация о здоровье ребёнка, и в таблице, которую пролистывают по
// диагонали, ей не место.
export function cut(text: string | null | undefined, limit = 60): string {
  if (!text) return "—";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

// CSV: экранирование по правилам формата. Запятая и кавычка в имени
// родителя сломали бы колонки.
export function csvOf(header: string[], rows: string[][]): string {
  const cell = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const lines = [header.join(",")];
  for (const row of rows) lines.push(row.map(cell).join(","));
  return lines.join("\r\n") + "\r\n";
}
