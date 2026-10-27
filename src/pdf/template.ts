// Вёрстка платного PDF: HTML и CSS, перенесённые из прототипа
// templates/pdf/reference_dremius.py. Прототип остаётся образцом дизайна:
// если тут что-то меняется, сверяться нужно с ним и с готовым примером
// assets/example/Dremius_plan_sna_primer.pdf.
//
// Документ собирается тремя кусками, потому что у них разные страничные
// настройки: обложка и финал — во всю страницу без полей, содержание —
// с полями и колонтитулом. Chromium умеет только один набор полей на
// документ, поэтому куски рендерятся отдельно и склеиваются
// (см. src/pdf/render.ts). Там же под страницы с полями подкладывается
// фон цвета бумаги: поля Chromium всегда печатает белыми.

import fs from "fs";
import path from "path";
import { env } from "../env";
import { PdfContent, ScheduleVariant } from "../paidPdf";
import { SCHEDULE_DISCLAIMER } from "../pdfTexts";
import { PROJECT_ROOT } from "../prompts";

// ── Шрифты ──────────────────────────────────────────────────────────

// Шрифты вшиваются в CSS как data-URI, а не подключаются файлами: тогда
// страницу можно отдать браузеру строкой, без временных файлов и возни
// с относительными путями. Читаются один раз при старте.
//
// Начертания лежат отдельными файлами на каждый вес и каждый алфавит, а
// не одним переменным шрифтом: кириллица и латиница подключаются своими
// unicode-range, и в документ попадает только то, что в нём встречается.
// Без такого деления один Onest со всеми алфавитами весил бы больше, чем
// все шестнадцать файлов вместе.
const CYRILLIC = "U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116";
const LATIN = "U+0000-00FF,U+2000-206F,U+20AC,U+2122,U+2190-2199,U+2212";

function fontFace(family: string, slug: string, subset: string, weight: number): string {
  const file = path.join(PROJECT_ROOT, "assets/fonts", `${slug}-${subset}-${weight}-normal.woff2`);
  const base64 = fs.readFileSync(file).toString("base64");
  return `@font-face {
  font-family: "${family}";
  font-weight: ${weight};
  font-style: normal;
  font-display: block;
  src: url(data:font/woff2;base64,${base64}) format("woff2");
  unicode-range: ${subset === "cyrillic" ? CYRILLIC : LATIN};
}`;
}

const FONTS = [
  ["Rubik", "rubik"],
  ["Onest", "onest"],
]
  .flatMap(([family, slug]) =>
    [400, 500, 600, 700].flatMap((weight) =>
      ["cyrillic", "latin"].map((subset) => fontFace(family, slug, subset, weight))
    )
  )
  .join("\n");

// ── Картинки ────────────────────────────────────────────────────────

// Персонаж появляется только на обложке и финальной странице: в Частях
// 1–3 приоритет у информации, это правило брендбука.
function imageUri(file: string, mime: string): string {
  const full = path.join(PROJECT_ROOT, "assets/pdf", file);
  return `data:${mime};base64,${fs.readFileSync(full).toString("base64")}`;
}

const COVER_IMAGE = imageUri("dremius-cloud.png", "image/png");
const FINAL_IMAGE = imageUri("dremius-final.png", "image/png");

// ── Разметка из промптов ────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Подмножество разметки ровно такое, какое разрешено промптам: «**жирный**».
function inline(text: string): string {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

// Остальное подмножество: «## » заголовки, «- » списки, строка целиком
// из «**…**» — подзаголовок шага. Всё прочее идёт абзацем как текст.
function markdown(text: string): string {
  const out: string[] = [];

  for (const block of text.trim().split(/\n\s*\n/)) {
    let lines = block.split("\n").filter((line) => line.trim());
    if (!lines.length) continue;

    if (lines[0].startsWith("## ")) {
      out.push(`<h2>${inline(lines[0].slice(3))}</h2>`);
      lines = lines.slice(1);
      if (!lines.length) continue;
    }

    if (lines.every((line) => line.startsWith("- "))) {
      const short = lines.length <= 6 && lines.every((line) => line.length < 60);
      const items = lines.map((line) => `<li>${inline(line.slice(2))}</li>`).join("");
      out.push(`<ul${short ? ' class="short"' : ""}>${items}</ul>`);
    } else if (lines.length === 1 && /^\*\*.+\*\*$/.test(lines[0])) {
      out.push(`<h3>${inline(lines[0].slice(2, -2))}</h3>`);
    } else {
      out.push(`<p>${lines.map(inline).join(" ")}</p>`);
    }
  }

  return out.join("\n");
}

// ── Иконки ──────────────────────────────────────────────────────────

// Простые line-иконки с мягкими окончаниями: шапки разделов и строки
// режима. Рисуем разметкой, а не картинками, — цвет задаётся из CSS и
// не нужно таскать файлы ради пяти значков.
const ICON_PATHS: Record<string, string> = {
  loupe: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  moon: '<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/>',
  star: '<path d="M12 3.5l2.4 5.1 5.6.7-4.1 3.9 1 5.5L12 16l-4.9 2.7 1-5.5L4 9.3l5.6-.7z"/>',
  heart: '<path d="M12 19.5s-7-4.3-7-9.4A3.9 3.9 0 0 1 12 7.6a3.9 3.9 0 0 1 7 2.5c0 5.1-7 9.4-7 9.4z"/>',
  sun:
    '<circle cx="12" cy="12" r="4"/>' +
    '<path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
};

function icon(name: string, cls = "ic"): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name]}</svg>`;
}

// Звезда над «ё» в логотипе: вместо двух точек. Цвет вшит в разметку —
// это часть знака, а не оформление текста.
const WORDMARK_STAR =
  '<svg class="wm-star" viewBox="0 0 24 24">' +
  '<path d="M12 2.5l2.6 5.6 6.1.8-4.5 4.2 1.1 6-5.3-3-5.3 3 1.1-6L3.3 8.9l6.1-.8z" fill="#F3B17E"/></svg>';

const WORDMARK = `<div class="wm">Др<span class="yo">е${WORDMARK_STAR}</span>миус</div>`;

// ── Таблица режима ──────────────────────────────────────────────────

type RowKind = "wake" | "sleep" | "calm" | "night";

const ROW_ICON: Record<RowKind, string> = {
  wake: "sun",
  sleep: "moon",
  calm: "heart",
  night: "star",
};

// Цвет строки и значок зависят от того, что это за событие. В прототипе
// вид был задан руками, а P1 отдаёт только время, событие и
// длительность — поэтому определяем по тексту. «Ночной» проверяем до
// общего «сна», иначе ночь попадёт в дневные сны.
function rowKind(event: string): RowKind {
  const text = event.toLowerCase();
  if (text.includes("подъём") || text.includes("подъем")) return "wake";
  if (text.includes("ноч")) return "night";
  if (text.includes("спокойн")) return "calm";
  if (text.includes("сон") || text.includes("сна")) return "sleep";
  return "calm";
}

function scheduleTable(variant: ScheduleVariant): string {
  const rows = variant.rows
    .map((row) => {
      const kind = rowKind(row.event);
      const duration = row.duration ? `<span>${escapeHtml(row.duration)}</span>` : "";
      return `<div class="row ${kind}"><div class="t">${escapeHtml(row.time)}</div>` +
        `${icon(ROW_ICON[kind], "ri")}` +
        `<div class="e">${escapeHtml(row.event)}${duration}</div></div>`;
    })
    .join("");
  return `<div class="sched">${rows}</div>`;
}

// Вариантов может быть два — при переходе на меньшее число снов.
// Заголовок варианта показываем только тогда, когда их больше одного:
// у единственной таблицы он лишний.
function scheduleBlock(variants: ScheduleVariant[]): string {
  if (variants.length === 1) return scheduleTable(variants[0]);
  return variants
    .map((variant) => `<h2>${escapeHtml(variant.title)}</h2>${scheduleTable(variant)}`)
    .join("");
}

// ── Фиксированные тексты ────────────────────────────────────────────

const BRAND = "Дрёмиус";
const DESCRIPTOR = "ваш помощник по детскому сну";

const COVER_DISCLAIMER =
  "Этот план носит информационный характер и не является медицинской консультацией. " +
  "Он составлен на основе общедоступных рекомендаций о детском сне, подобранных по вашим " +
  "ответам в анкете. Если вас беспокоит здоровье малыша, обратитесь к педиатру.";

const FINAL_DISCLAIMER =
  "<b>Важно.</b> Материалы Дрёмиуса носят исключительно информационный характер. Они составлены " +
  "на основе общедоступных рекомендаций о детском сне и подобраны с учётом ваших ответов в анкете. " +
  "Это не медицинская консультация, не диагноз и не назначение лечения, и они не заменяют осмотр " +
  "врача. Решения о режиме и уходе за малышом принимаете вы. Если малыш болеет, вы заметили " +
  "изменения в его самочувствии или вас что-то тревожит, обратитесь к педиатру.";

const MONTHS = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

export function formatRussianDate(date: Date): string {
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

// ФИО, ИНН и телефон в PDF не выводим — так решено в ТЗ. Строки без
// заданной переменной окружения не показываем вовсе, чтобы не осталось
// пустого «Почта для связи:».
function contacts(): string {
  const lines: string[] = [];
  if (env.OFFER_URL) {
    const url = escapeHtml(env.OFFER_URL);
    lines.push(`Условия оказания услуги: <a href="${url}"><span>${url}</span></a>`);
  }
  if (env.CONTACT_EMAIL) {
    lines.push(`Почта для связи: <span>${escapeHtml(env.CONTACT_EMAIL)}</span>`);
  }
  return lines.join("<br>");
}

// ── Стили ───────────────────────────────────────────────────────────
//
// Теней в содержательных страницах нет намеренно: Chromium при печати
// разрезает их по границе страницы и переносит обрывок на следующую.
// Мягкость даётся скруглениями, а свечение остаётся только на обложке и
// финальной странице — они печатаются отдельными кусками в одну
// страницу каждая, и переносить там нечего.

const CSS = `
${FONTS}
:root {
  --night:#10182F; --indigo:#3E4F7C; --lav:#9D92B6; --cream:#FFF1D9;
  --apricot:#F3B17E; --blush:#EAC9CA; --paper:#FFF8EE; --ink:#1D2540;
  --muted:#5F6683; --line:#E9DFCF; --tint:#EEEBF4;
}
* { box-sizing: border-box; }
html { background: var(--paper); }
body { margin:0; font-family: Onest, "Noto Color Emoji", sans-serif; color: var(--ink); font-size: 10.6pt; line-height: 1.6; background: var(--paper); }
h1,h2,h3,.rub { font-family: Rubik, "Noto Color Emoji", sans-serif; }
.page { position: relative; page-break-after: always; }
.page:last-child { page-break-after: auto; }
.full { width: 210mm; height: 297mm; overflow: hidden; }

/* ── обложка ── */
.cover { background: var(--night); color: var(--cream); padding: 20mm 20mm 18mm; display:flex; flex-direction:column; }
.wm { font-family: Rubik; font-weight:700; font-size: 26pt; letter-spacing:-.3px; color: var(--cream); position:relative; display:inline-block; line-height:1; }
.yo { position:relative; display:inline-block; }
.wm-star { position:absolute; width:.42em; height:.42em; left:50%; top:-.12em; transform:translateX(-50%); filter: drop-shadow(0 0 4px rgba(243,177,126,.8)); }
.desc { font-size: 10pt; color: var(--lav); margin-top: 2.5mm; letter-spacing:.2px; }
.hero { margin: 12mm 0 6mm; display:flex; justify-content:center; }
.hero img { width: 128mm; height:auto; display:block; }
.cover h1 { font-weight:600; font-size: 27pt; line-height:1.15; margin: 4mm 0; color:#FFF6E8; letter-spacing:-.2px; }
.cover .sub { font-size: 11pt; color:#C9C3DA; max-width: 150mm; }
.spacer { flex: 1; }
.cdisc { font-size: 8.6pt; line-height:1.55; color:#C9C3DA; background: rgba(62,79,124,.35); border:1px solid rgba(157,146,182,.28); border-radius: 16px; padding: 4mm 5mm; margin: 0 0 5mm; }
.meta { display:flex; justify-content:space-between; font-size: 8.8pt; color: var(--lav); border-top:1px solid rgba(157,146,182,.25); padding-top: 4mm; }

/* ── разделы ── */
.head { display:flex; align-items:center; gap: 4mm; margin-bottom: 7mm; }
.badge { width:13mm; height:13mm; border-radius:50%; background: var(--night); color: var(--apricot); display:flex; align-items:center; justify-content:center; flex:none; border: 2.5px solid rgba(243,177,126,.35); }
.badge .ic { width:7mm; height:7mm; }
.kicker { font-size: 8pt; text-transform: uppercase; letter-spacing: 1.6px; color: var(--indigo); font-weight:600; }
.ptitle { font-size: 20pt; line-height:1.2; font-weight:600; margin: .5mm 0 0; color: var(--night); letter-spacing:-.2px; }
h2 { font-size: 13.5pt; font-weight:600; color: var(--night); margin: 7mm 0 2.5mm; break-after: avoid; }
.body > h2:first-child { margin-top: 0; }
h3 { font-size: 11.2pt; font-weight:600; color: var(--indigo); margin: 5mm 0 1.5mm; break-after: avoid; display:flex; align-items:center; gap: 2.5mm; }
h3::before { content:""; width:2.4mm; height:2.4mm; border-radius:50%; background: var(--apricot); flex:none; }
p { margin: 0 0 2.6mm; }
ul { margin: 0 0 3mm; padding-left: 0; list-style: none; }
ul.short { break-inside: avoid; }
li { position:relative; padding-left: 6mm; margin-bottom: 1.8mm; break-inside: avoid; }
li::before { content:""; position:absolute; left:1mm; top:2.3mm; width:1.8mm; height:1.8mm; border-radius:50%; background: var(--apricot); }
strong { color: var(--night); font-weight:600; }

/* «Коротко о главном» — первый абзац Части 1 тёмной карточкой-ночником */
.rec > h2:first-child { margin-top: 0; }
.rec > h2:first-child + p { background: var(--night); color: var(--cream); border-radius: 18px; padding: 5.5mm 6mm; font-size: 11pt; line-height:1.6; }

/* ── режим ── */
.intro { background: var(--tint); border-radius: 16px; padding: 4.5mm 5.5mm; margin-bottom: 6mm; }
.sched { background: var(--night); border-radius: 22px; padding: 5mm; }
.row { display:flex; align-items:center; gap: 4mm; padding: 3.6mm 3mm; border-bottom: 1px solid rgba(157,146,182,.18); break-inside: avoid; }
.row:last-child { border-bottom: 0; }
.row .t { font-family: Rubik; font-weight:600; font-size: 15pt; color: var(--apricot); width: 24mm; flex:none; }
.row .ri { width:6mm; height:6mm; color: var(--lav); flex:none; }
.row .e { font-family: Rubik; font-weight:500; font-size: 11.5pt; color: var(--cream); }
.row .e span { display:block; font-family: Onest; font-weight:400; font-size: 9.4pt; color:#B9B3CE; margin-top:.5mm; }
.row.night { background: rgba(62,79,124,.55); border-radius: 14px; border-bottom: 0; }
.row.night .ri, .row.wake .ri { color: var(--apricot); }
.sdisc { margin-top: 5mm; font-size: 9.4pt; color: var(--ink); background: var(--tint); border-radius: 14px; padding: 3.8mm 5mm; }
.note { margin-top: 5mm; font-size: 10.2pt; border-top: 1px solid var(--line); padding-top: 4.5mm; }
.note b { color: var(--night); }

/* ── финал ── */
.end { background: var(--night); color: var(--cream); display:flex; flex-direction:column; align-items:center; text-align:center; padding: 30mm 22mm 18mm; }
/* Персонаж на прозрачном фоне стоит прямо на тёмной странице, без
   карточки. Свечение — drop-shadow: он идёт по контуру облачка, а
   box-shadow обвёл бы прямоугольник картинки. */
.end .pic { width: 112mm; display:block; filter: drop-shadow(0 0 18mm rgba(243,177,126,.26)); }
.end h2 { font-size: 22pt; font-weight:600; color:#FFF6E8; margin: 8mm 0 2mm; }
.end .sign { font-family: Rubik; font-weight:500; color: var(--apricot); font-size: 12pt; }
.fdisc { font-size: 8.6pt; line-height:1.55; color:#C9C3DA; text-align:left; background: rgba(62,79,124,.35); border:1px solid rgba(157,146,182,.28); border-radius: 16px; padding: 4.5mm 5.5mm; }
.fdisc b { color: var(--cream); }
.contacts { margin-top: 5mm; font-size: 8.8pt; color: var(--lav); line-height:1.8; }
.contacts span { color: var(--apricot); }
`;

// Колонтитул содержательных страниц. Живёт в поле страницы, поэтому его
// задаёт сам Chromium, а не разметка — отсюда inline-стили. Шрифты
// страницы сюда не достают: Chromium рендерит колонтитул отдельным
// документом, и он печатается системным гротеском.
export const FOOTER_TEMPLATE =
  '<div style="width:100%;font-family:Onest,sans-serif;font-size:7.5pt;color:#5F6683;padding:0 20mm;' +
  `display:flex;justify-content:space-between"><span>${BRAND} · персональный план сна</span>` +
  '<span><span class="pageNumber"></span></span></div>';

function document(body: string, pageMargin: string): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>
@page { size: A4; margin: ${pageMargin}; }
${CSS}</style></head><body>${body}</body></html>`;
}

function contentPage(kicker: string, title: string, ico: string, body: string, cls = ""): string {
  return `<section class="page"><div class="head"><div class="badge">${icon(ico)}</div>` +
    `<div><div class="kicker">${escapeHtml(kicker)}</div>` +
    `<h1 class="ptitle">${escapeHtml(title)}</h1></div></div>` +
    `<div class="body ${cls}">${body}</div></section>`;
}

export interface PdfParts {
  cover: string;
  content: string;
  end: string;
}

// Три куска документа. approvedAt — дата одобрения, она же дата на
// обложке; памятка приходит отдельно, её текст лежит в репозитории.
export function buildPdfParts(content: PdfContent, relaxationMemo: string, approvedAt: Date): PdfParts {
  const cover = `<section class="page full cover">
<div>${WORDMARK}<div class="desc">${DESCRIPTOR}</div></div>
<div class="hero"><img src="${COVER_IMAGE}"></div>
<h1>Персональный план сна<br>для вашего малыша</h1>
<div class="sub">Что попробовать в вашей ситуации, примерный режим дня и памятка о том, как помочь малышу расслабиться перед сном.</div>
<div class="spacer"></div>
<div class="cdisc">${COVER_DISCLAIMER}</div>
<div class="meta"><span>Подготовлено по вашей анкете и разбору</span><span>${escapeHtml(formatRussianDate(approvedAt))}</span></div></section>`;

  const recommendations = contentPage(
    "Часть 1",
    "Что попробовать в вашей ситуации",
    "loupe",
    markdown(content.recommendations),
    "rec"
  );

  const schedule = contentPage(
    "Часть 2",
    "Примерный режим дня",
    "moon",
    `<div class="intro">${inline(content.schedule.intro)}</div>` +
      scheduleBlock(content.schedule.variants) +
      `<div class="sdisc">${escapeHtml(SCHEDULE_DISCLAIMER)}</div>` +
      `<div class="note"><b>Как прийти к этому режиму.</b> ${inline(content.schedule.note)}</div>`
  );

  const relaxation = contentPage(
    "Часть 3",
    "Памятка: как помочь малышу расслабиться перед сном",
    "heart",
    markdown(relaxationMemo)
  );

  const end = `<section class="page full end">
<img class="pic" src="${FINAL_IMAGE}">
<h2>Спокойной ночи 💛</h2>
<div class="sign">Ваш помощник ${BRAND}</div>
<div class="spacer"></div>
<div class="fdisc">${FINAL_DISCLAIMER}</div>
<div class="contacts">${contacts()}</div></section>`;

  return {
    cover: document(cover, "0"),
    content: document(recommendations + schedule + relaxation, "18mm 20mm"),
    end: document(end, "0"),
  };
}
