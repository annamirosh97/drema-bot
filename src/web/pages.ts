// Разметка двух страниц админки: список заказов и страница заказа.
// Данные сюда приходят уже собранными, обращений к базе здесь нет.

import { PdfContent, ScheduleVariant } from "../paidPdf";
import { escape, html, page, raw } from "./html";

export interface OrderRow {
  id: number;
  telegramId: string;
  status: string;
  createdAt: Date;
  hoursWaiting: number;
}

// Подсветка по времени ожидания: ТЗ просит отметить заказы старше 12
// часов и отдельно — старше 20, чтобы не пропустить обещанные сутки.
function waitingPill(hours: number, status: string): string {
  if (status === "SENT" || status === "CANCELED") {
    return html`<span class="pill">${Math.round(hours)} ч</span>`;
  }
  const cls = hours > 20 ? "pill danger" : hours > 12 ? "pill warn" : "pill";
  return html`<span class="${cls}">${Math.round(hours)} ч</span>`;
}

export function renderOrdersPage(orders: OrderRow[]): string {
  const rows = orders.map(
    (o) => html`<tr>
      <td><a href="/admin/orders/${o.id}">#${o.id}</a></td>
      <td>${o.createdAt.toLocaleString("ru-RU")}</td>
      <td>${o.status}</td>
      <td>${raw(waitingPill(o.hoursWaiting, o.status))}</td>
      <td class="muted">#${o.telegramId}</td>
    </tr>`
  );

  const body = orders.length
    ? html`<table>
        <tr><th>Заказ</th><th>Создан</th><th>Статус</th><th>Ждёт</th><th>Пользователь</th></tr>
        ${raw(rows.join(""))}
      </table>`
    : html`<p class="muted">Заказов пока нет.</p>`;

  return page(
    "Заказы",
    html`<h1>Заказы PDF</h1>
      <p class="muted">Жёлтым — ждут больше 12 часов, красным — больше 20.</p>
      <div class="card">${raw(body)}</div>`
  );
}

// ── Страница заказа ─────────────────────────────────────────────────

export interface OrderPageData {
  id: number;
  telegramId: string;
  status: string;
  createdAt: Date;
  generationCount: number;
  hasEdits: boolean;
  memoReady: boolean;
  content: PdfContent;
  reviewerNotes: string;
  rawPlan: string;
  questionnaire: string;
  analysis: string;
  message1: string;
  message2: string;
  relaxationMemo: string;
  savedJustNow: boolean;
  regenerating: boolean;
}

function collapsible(title: string, text: string): string {
  return html`<details><summary>${title}</summary><pre>${text}</pre></details>`;
}

function scheduleRows(variant: ScheduleVariant, vi: number): string {
  const rows = variant.rows.map(
    (row, ri) => html`<div class="schedule-row">
      <input type="text" name="v${vi}_time_${ri}" value="${row.time}" placeholder="08:00">
      <input type="text" name="v${vi}_event_${ri}" value="${row.event}" placeholder="Подъём">
      <input type="text" name="v${vi}_duration_${ri}" value="${row.duration}" placeholder="1:15">
      <button type="button" class="secondary" onclick="this.parentElement.remove()" title="Удалить строку">×</button>
    </div>`
  );

  return html`<div class="card">
    <input type="text" name="v${vi}_title" value="${variant.title}" placeholder="Название варианта">
    <p class="muted" style="margin:10px 0 6px">Время · событие · длительность</p>
    <div id="variant-${vi}">${raw(rows.join(""))}</div>
    <button type="button" class="secondary" onclick="addRow(${vi})">Добавить строку</button>
  </div>`;
}

export function renderOrderPage(data: OrderPageData): string {
  const banner = data.regenerating
    ? html`<div class="banner warn">Перегенерация запущена. Она идёт пару минут — обнови страницу позже.</div>`
    : data.savedJustNow
      ? html`<div class="banner">Правки сохранены.</div>`
      : "";

  const memoWarning = data.memoReady
    ? ""
    : html`<div class="banner warn">Памятка для группы ${data.content.relaxationGroup} не готова.
        Отправлять этот план нельзя, пока она не написана.</div>`;

  const left = html`<div class="card">
      <h2>Исходные данные</h2>
      ${raw(collapsible("Ответы анкеты", data.questionnaire))}
      ${raw(collapsible("ВЫВОДЫ анализа", data.analysis))}
      ${raw(collapsible("Сообщение 1, отправленное родителю", data.message1))}
      ${raw(collapsible("Сообщение 2, отправленное родителю", data.message2))}
      ${raw(collapsible("Полный ответ шага «План» (P1)", data.rawPlan))}
    </div>`;

  const variants = data.content.schedule.variants.map((v, i) => scheduleRows(v, i));

  const right = html`<div class="card notes">
      <h2>Заметки для проверки</h2>
      <pre>${data.reviewerNotes || "нет"}</pre>
    </div>

    <form method="post" action="/admin/orders/${data.id}/save">
      <div class="card">
        <h2>Рекомендации</h2>
        <textarea name="recommendations" rows="22">${data.content.recommendations}</textarea>
      </div>

      <div class="card">
        <h2>Режим дня</h2>
        <p class="muted" style="margin:0 0 6px">Вступление</p>
        <textarea name="scheduleIntro" rows="4">${data.content.schedule.intro}</textarea>
        <p class="muted" style="margin:12px 0 6px">Примечание «Как прийти к этому режиму»</p>
        <textarea name="scheduleNote" rows="4">${data.content.schedule.note}</textarea>
      </div>

      ${raw(variants.join(""))}
      <input type="hidden" name="variantCount" value="${data.content.schedule.variants.length}">

      <div class="row-actions">
        <button type="submit">Сохранить</button>
        <a class="btn secondary" href="/admin/orders/${data.id}/preview" target="_blank">Превью</a>
        <button type="button" disabled title="Появится на следующем этапе">Одобрить и отправить</button>
      </div>
    </form>

    <div class="card">
      <h2>Памятка</h2>
      <p class="muted">Группа ${data.content.relaxationGroup}. Правится в репозитории,
        в content/relaxation/${data.content.relaxationGroup}.md — здесь только просмотр.</p>
      <details><summary>Показать текст</summary><pre>${data.relaxationMemo}</pre></details>
    </div>

    <form method="post" action="/admin/orders/${data.id}/regenerate"
          onsubmit="return confirmRegen(${data.hasEdits ? "true" : "false"})">
      <div class="card">
        <h2>Перегенерировать</h2>
        <p class="muted">Прогон обоих шагов заново. Комментарий уйдёт модели в задание.
          Исходник от модели перезапишется, ваши правки — нет.</p>
        <textarea name="comment" rows="3" placeholder="Что поправить, например: вечернее бодрствование слишком длинное"></textarea>
        <div class="row-actions"><button type="submit" class="secondary">Перегенерировать</button></div>
      </div>
    </form>`;

  const script = `
    function addRow(vi) {
      const box = document.getElementById('variant-' + vi);
      const i = Date.now();
      const div = document.createElement('div');
      div.className = 'schedule-row';
      div.innerHTML =
        '<input type="text" name="v' + vi + '_time_' + i + '" placeholder="08:00">' +
        '<input type="text" name="v' + vi + '_event_' + i + '" placeholder="Событие">' +
        '<input type="text" name="v' + vi + '_duration_' + i + '" placeholder="1:15">' +
        '<button type="button" class="secondary" onclick="this.parentElement.remove()">×</button>';
      box.appendChild(div);
    }
    function confirmRegen(hasEdits) {
      if (!hasEdits) return true;
      return confirm('По этому заказу уже есть ваши правки. Перегенерация их не тронет, но текст от модели заменится новым. Продолжить?');
    }
  `;

  return page(
    `Заказ #${data.id}`,
    html`<h1>Заказ #${data.id}</h1>
      <p class="muted">
        ${data.status} · создан ${data.createdAt.toLocaleString("ru-RU")} ·
        пользователь #${data.telegramId} · прогонов: ${data.generationCount}
        ${data.hasEdits ? " · есть правки" : ""} ·
        <a href="/admin/orders">ко всем заказам</a>
      </p>
      ${raw(banner)}${raw(memoWarning)}
      <div class="cols"><div>${raw(left)}</div><div>${raw(right)}</div></div>
      <script>${raw(script)}</script>`
  );
}

// ── Превью ──────────────────────────────────────────────────────────

// На этом этапе превью — просто HTML. Настоящий PDF с вёрсткой по
// брендбуку появится на следующем этапе, тогда эта функция уступит
// место рендеру через headless-браузер.
export function renderPreview(content: PdfContent, memo: string): string {
  const variants = content.schedule.variants.map(
    (v) => html`<h3>${v.title}</h3>
      <table>
        <tr><th>Время</th><th>Событие</th><th>Длительность</th></tr>
        ${raw(
          v.rows
            .map((r) => html`<tr><td>${r.time}</td><td>${r.event}</td><td>${r.duration}</td></tr>`)
            .join("")
        )}
      </table>`
  );

  return page(
    "Превью плана",
    html`<h1>Персональный план сна</h1>
      <p class="muted">Черновое превью. Вёрстка PDF появится на следующем этапе.</p>

      <div class="card">
        <h2>Часть 1. Что попробовать в вашей ситуации</h2>
        <pre>${content.recommendations}</pre>
      </div>

      <div class="card">
        <h2>Часть 2. Примерный режим дня</h2>
        <p>${content.schedule.intro}</p>
        ${raw(variants.join(""))}
        <p style="margin-top:16px"><strong>Как прийти к этому режиму.</strong> ${content.schedule.note}</p>
      </div>

      <div class="card">
        <h2>Часть 3. Памятка: как помочь малышу расслабиться перед сном</h2>
        <pre>${memo}</pre>
      </div>`
  );
}

export { escape };
