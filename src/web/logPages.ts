// Страница журнала действий админа.
//
// Данные приходят готовыми, обращений к базе здесь нет.

import { formatMoscow } from "../consents";
import { escape, html, page, raw } from "./html";
import { ChromeData, crossLinks, cut, pager, searchForm, sortHeader } from "./tableChrome";
import { ACTION_LABELS, LogRow } from "./logData";

const ENTITY_LABELS: Record<string, string> = {
  order: "заказ",
  consult: "заявка",
  recommendation: "разбор",
  session: "родитель",
};

// Что изменилось — короткой строкой для таблицы.
//
// В diff правки черновика лежат оба текста целиком, и в списке они бы
// растянули строку на экран. Показываем суть, а полное значение — по
// клику: в тексте разбора есть подробности о ребёнке, и в таблице,
// которую пролистывают, им не место.
function diffSummary(diff: unknown): string {
  if (!diff || typeof diff !== "object") return "—";

  const parts: string[] = [];
  for (const [key, value] of Object.entries(diff as Record<string, unknown>)) {
    if (value && typeof value === "object" && "from" in value && "to" in value) {
      const pair = value as { from: unknown; to: unknown };
      const from = pair.from === null || pair.from === undefined ? "пусто" : String(pair.from);
      const to = pair.to === null || pair.to === undefined ? "пусто" : String(pair.to);
      // Длинные тексты в сводке не показываем вовсе: по ним всё равно
      // ничего не понять, а короткие значения вроде статуса — читаемы.
      if (from.length > 40 || to.length > 40) {
        parts.push(`${key}: текст изменён`);
      } else {
        parts.push(`${key}: ${from} → ${to}`);
      }
    } else {
      parts.push(`${key}: ${cut(String(value), 40)}`);
    }
  }
  return parts.join("; ") || "—";
}

function diffDetails(diff: unknown): string {
  if (!diff || typeof diff !== "object") return "";
  return html`<details>
    <summary class="muted">подробнее</summary>
    <pre>${JSON.stringify(diff, null, 2)}</pre>
  </details>`;
}

export function renderLogPage(data: {
  chrome: ChromeData;
  rows: LogRow[];
  filters: { action: string };
  usedActions: string[];
}): string {
  const rows = data.rows.map(
    (r) => html`<tr>
      <td class="muted" style="white-space:nowrap">${formatMoscow(r.createdAt, true)}</td>
      <td>${ACTION_LABELS[r.action] ?? r.action}</td>
      <td>
        ${raw(
          r.parent && r.telegramId
            ? html`<a href="/admin/users/${r.telegramId}">${r.parent}</a>`
            : escape("—")
        )}
      </td>
      <td>
        ${raw(
          r.href
            ? html`<a href="${r.href}">${ENTITY_LABELS[r.entityType] ?? r.entityType} #${r.entityId}</a>`
            : escape(`${ENTITY_LABELS[r.entityType] ?? r.entityType} #${r.entityId}`)
        )}
      </td>
      <td>
        ${diffSummary(r.diff)}
        ${raw(diffDetails(r.diff))}
      </td>
    </tr>`
  );

  const actionOptions = [html`<option value="">любое действие</option>`]
    .concat(
      data.usedActions.map(
        (a) =>
          html`<option value="${a}" ${raw(a === data.filters.action ? "selected" : "")}>
            ${ACTION_LABELS[a] ?? a}
          </option>`
      )
    )
    .join("");

  const filters = html`<select name="action">${raw(actionOptions)}</select>`;

  const table = data.rows.length
    ? html`<table>
        <tr>
          <th>${raw(sortHeader(data.chrome, "created", "Когда"))}</th>
          <th>${raw(sortHeader(data.chrome, "action", "Действие"))}</th>
          <th>${raw(sortHeader(data.chrome, "parent", "Родитель"))}</th>
          <th>Запись</th>
          <th>Что изменилось</th>
        </tr>
        ${raw(rows.join(""))}
      </table>`
    : html`<p class="muted">Записей нет.</p>`;

  return page(
    "Журнал",
    html`<h1>Журнал действий</h1>
      <p class="muted">
        Найдено ${data.chrome.total} · записи только добавляются ·
        ${raw(crossLinks(data.chrome.base))}
      </p>
      ${raw(searchForm(data.chrome, filters))}
      <div class="card">${raw(table)}${raw(pager(data.chrome))}</div>
      <p class="muted">
        Поиск ищет по родителю: журнал читают, отвечая на вопрос
        «что мы делали с этим человеком».
      </p>`
  );
}
