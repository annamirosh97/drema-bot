// Очередь «что горит» и редактор бесплатного разбора.
//
// Данные приходят готовыми, обращений к базе здесь нет.

import { formatMoscow } from "../consents";
import { env } from "../env";
import { escape, html, page, raw } from "./html";
import { QueueData, TASK_LABELS, TaskType } from "./queueData";

// ── Очередь ─────────────────────────────────────────────────────────

export function renderQueuePage(data: QueueData): string {
  const chip = (type: TaskType | "", label: string, count: number) => {
    const active = data.filter === type;
    const url = type ? `/admin/queue?type=${type}` : "/admin/queue";
    return html`<a class="${active ? "btn" : "btn secondary"}" href="${url}">${label} · ${count}</a>`;
  };

  const total = data.counts.reduce((sum, c) => sum + c.count, 0);
  const chips = [chip("", "всё", total), ...data.counts.map((c) => chip(c.type, c.label, c.count))];

  const rows = data.tasks.map((t) => {
    const posts = t.posts
      .map(
        (p) => html`<form method="post" action="${p.href}" style="display:inline"
          ${raw(p.confirm ? html`onsubmit="return confirm('${p.confirm}')"` : "")}>
          <button type="submit" class="secondary">${p.label}</button>
        </form>`
      )
      .join(" ");

    return html`<tr>
      <td>${TASK_LABELS[t.type]}</td>
      <td><a href="/admin/users/${t.telegramId}">${t.parentName}</a></td>
      <td>${t.babyAge ? `${t.babyAge} мес` : "—"}</td>
      <td>
        <span class="${t.sla === "danger" ? "pill danger" : t.sla === "warn" ? "pill warn" : "pill"}">
          ${t.waiting}
        </span>
      </td>
      <td class="muted">${t.status}</td>
      <td>
        <a class="btn" href="${t.href}">${t.actionLabel}</a>
        ${raw(posts)}
      </td>
    </tr>`;
  });

  const body = data.tasks.length
    ? html`<table>
        <tr>
          <th>Задача</th><th>Родитель</th><th>Малышу</th>
          <th>Ждёт</th><th>Статус</th><th>Действие</th>
        </tr>
        ${raw(rows.join(""))}
      </table>`
    : html`<p class="muted">Очередь пуста. Никто ничего не ждёт.</p>`;

  return page(
    "Очередь",
    html`<h1>Что горит</h1>
      <p class="muted">
        Самые срочные сверху · красным — ждут больше ${env.SLA_DANGER_HOURS} ч ·
        <a href="/admin/users">пользователи</a> · <a href="/admin/orders">заказы</a> ·
        <a href="/admin/consults">консультации</a>
      </p>

      <div class="row-actions" style="margin-top:0">${raw(chips.join(""))}</div>

      <div class="card" style="margin-top:16px">${raw(body)}</div>

      <p class="muted">
        Строка исчезает сама, когда задача закрыта: отдельной отметки «сделано» нет.
      </p>`
  );
}

// ── Редактор бесплатного разбора ────────────────────────────────────

export interface AnalysisEditorData {
  telegramId: string;
  parentName: string;
  attempt: number;
  status: string;
  waiting: string;
  createdAt: Date;
  sentAt: Date | null;
  babyAge: string | null;
  // Черновик модели: не меняется никогда.
  aiMessage1: string | null;
  aiMessage2: string | null;
  // То, что уйдёт родителю.
  message1: string;
  message2: string;
  analysis: string | null;
  deliveryError: string | null;
  edited: boolean;
  notice: string | null;
  error: string | null;
}

// Заголовки, с которыми сообщения уйдут в Telegram. Нужны предпросмотру:
// по ТЗ перед отправкой показывается текст так, как его увидит родитель.
const HEADING_1 = "Разбор режима сна";
const HEADING_2 = "Вероятные причины";

export function renderAnalysisEditor(data: AnalysisEditorData): string {
  const style = `
    .cols { display:grid; grid-template-columns:1fr 1fr; gap:16px }
    .cols textarea { width:100%; box-sizing:border-box; min-height:320px; font-family:inherit }
    .cols pre { white-space:pre-wrap; word-break:break-word; margin:0 }
    .preview { background:#F7F6FB; border-radius:8px; padding:12px }
    .preview h4 { margin:0 0 6px }
    @media (max-width:900px) { .cols { grid-template-columns:1fr } }
  `;

  const banner = data.notice
    ? html`<div class="banner">${data.notice}</div>`
    : data.error
      ? html`<div class="banner danger">${data.error}</div>`
      : "";

  const delivery = data.deliveryError
    ? html`<div class="banner danger">
        Не доставлено: ${data.deliveryError}. Таймер ожидания продолжает идти.
      </div>`
    : "";

  // Предпросмотр: ровно то, что увидит родитель, с заголовками.
  const preview = html`<div class="preview">
    <h4>${HEADING_1}</h4>
    <pre>${data.message1}</pre>
    <h4 style="margin-top:14px">${HEADING_2}</h4>
    <pre>${data.message2}</pre>
  </div>`;

  const sent = data.sentAt !== null;

  return page(
    `Разбор · ${data.parentName}`,
    html`<style>${raw(style)}</style>
      <p class="muted">
        <a href="/admin/queue">← в очередь</a> ·
        <a href="/admin/users/${data.telegramId}">карточка родителя</a>
      </p>

      <h1>Разбор для ${data.parentName}</h1>
      <p class="muted">
        Прохождение №${data.attempt} · ${data.status} · ждёт ${data.waiting} ·
        анкета сдана ${formatMoscow(data.createdAt)}${raw(
          data.sentAt ? html` · отправлено ${formatMoscow(data.sentAt)}` : ""
        )}${raw(data.babyAge ? html` · малышу ${data.babyAge} мес` : "")}
      </p>

      ${raw(banner)}
      ${raw(delivery)}
      ${raw(
        data.edited
          ? html`<div class="banner warn">Текст правили: ниже слева черновик модели, справа то, что уйдёт.</div>`
          : ""
      )}

      <form method="post" action="/admin/analysis/${data.telegramId}/save">
        <div class="card">
          <h2>Сообщение 1 · ${HEADING_1}</h2>
          <div class="cols">
            <div>
              <p class="muted">Черновик модели, не меняется</p>
              <pre>${data.aiMessage1 ?? "—"}</pre>
            </div>
            <div>
              <p class="muted">Что уйдёт родителю</p>
              <textarea name="message1" ${raw(sent ? "readonly" : "")}>${data.message1}</textarea>
            </div>
          </div>
        </div>

        <div class="card">
          <h2>Сообщение 2 · ${HEADING_2}</h2>
          <div class="cols">
            <div>
              <p class="muted">Черновик модели, не меняется</p>
              <pre>${data.aiMessage2 ?? "—"}</pre>
            </div>
            <div>
              <p class="muted">Что уйдёт родителю</p>
              <textarea name="message2" ${raw(sent ? "readonly" : "")}>${data.message2}</textarea>
            </div>
          </div>
        </div>

        ${raw(
          sent
            ? html`<div class="card"><p class="muted">Разбор уже отправлен, править нечего.</p></div>`
            : html`<div class="row-actions">
                <button type="submit">Сохранить правки</button>
              </div>`
        )}
      </form>

      <div class="card">
        <h2>Как это увидит родитель</h2>
        ${raw(preview)}
      </div>

      ${raw(
        sent
          ? ""
          : html`<div class="row-actions">
              <form method="post" action="/admin/analysis/${data.telegramId}/approve"
                    onsubmit="return confirm('Отправить родителю текст, показанный в предпросмотре?')">
                <button type="submit">Утвердить и отправить</button>
              </form>
              <form method="post" action="/admin/analysis/${data.telegramId}/regenerate"
                    onsubmit="return confirm('Перегенерировать черновик? Текущие правки пропадут.')">
                <button type="submit" class="secondary">Перегенерировать</button>
              </form>
            </div>`
      )}

      ${raw(
        data.deliveryError && !sent
          ? html`<div class="row-actions">
              <form method="post" action="/admin/analysis/${data.telegramId}/retry"
                    onsubmit="return confirm('Отправить разбор родителю ещё раз?')">
                <button type="submit">Повторить отправку</button>
              </form>
            </div>`
          : ""
      )}

      ${raw(
        data.analysis
          ? html`<details class="card">
              <summary>Выводы анализа (родитель их не видит)</summary>
              <pre>${data.analysis}</pre>
            </details>`
          : ""
      )}`
  );
}

export { escape };
