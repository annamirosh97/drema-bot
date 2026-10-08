// Вёрстка платного PDF: HTML и CSS, перенесённые из прототипа
// templates/pdf/reference_build.py. Прототип остаётся образцом дизайна:
// если тут что-то меняется, сверяться нужно с ним и с готовым примером
// assets/example/Drema_plan_sna_primer.pdf.
//
// Документ собирается тремя кусками, потому что у них разные страничные
// настройки: обложка и финал — во всю страницу без полей, содержание —
// с полями и колонтитулом. Chromium умеет только один набор полей на
// документ, поэтому куски рендерятся отдельно и склеиваются
// (см. src/pdf/render.ts).

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
function fontFace(family: string, file: string, style: "normal" | "italic"): string {
  const full = path.join(PROJECT_ROOT, "assets/fonts", file);
  const base64 = fs.readFileSync(full).toString("base64");
  return `@font-face {
  font-family: "${family}";
  src: url(data:font/ttf;base64,${base64}) format("truetype");
  font-weight: 100 900;
  font-style: ${style};
  font-display: block;
}`;
}

const FONTS = [
  fontFace("Lora", "Lora-Variable.ttf", "normal"),
  fontFace("Lora", "Lora-Italic-Variable.ttf", "italic"),
  fontFace("Inter", "Inter-Variable.ttf", "normal"),
].join("\n");

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

// ── Таблица режима ──────────────────────────────────────────────────

type RowKind = "wake" | "sleep" | "calm" | "night";

const ICONS: Record<RowKind, string> = { wake: "☀", sleep: "☾", calm: "✦", night: "★" };

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
      const duration = row.duration ? `<span class="d">${escapeHtml(row.duration)}</span>` : "";
      return `<tr class="${kind}"><td class="t">${escapeHtml(row.time)}</td>` +
        `<td class="i">${ICONS[kind]}</td>` +
        `<td class="e">${escapeHtml(row.event)}${duration}</td></tr>`;
    })
    .join("");
  return `<table class="sched">${rows}</table>`;
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

// ── Страницы ────────────────────────────────────────────────────────

const CLOUD = `<svg viewBox="0 0 200 130" class="cloud" aria-hidden="true">
<defs><radialGradient id="g" cx="50%" cy="45%" r="60%"><stop offset="0" stop-color="#FFF6E6"/><stop offset="1" stop-color="#F3C99A"/></radialGradient>
<filter id="glow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="9"/></filter></defs>
<g filter="url(#glow)" opacity=".55"><ellipse cx="100" cy="78" rx="92" ry="52" fill="#F3C99A"/></g>
<path d="M45 112c-22 0-36-15-36-33 0-17 13-31 30-32 5-21 23-36 44-36 18 0 33 10 40 25 4-2 9-3 14-3 21 0 37 17 37 38 0 23-17 41-40 41z" fill="url(#g)"/>
<circle cx="80" cy="72" r="5" fill="#1B1A3A"/><circle cx="120" cy="72" r="5" fill="#1B1A3A"/>
<path d="M90 86q10 8 20 0" stroke="#1B1A3A" stroke-width="3.5" fill="none" stroke-linecap="round"/>
<circle cx="68" cy="86" r="7" fill="#E3A598" opacity=".55"/><circle cx="132" cy="86" r="7" fill="#E3A598" opacity=".55"/></svg>`;

const COVER_DISCLAIMER =
  "Этот план носит информационный характер и не является медицинской консультацией. " +
  "Он составлен на основе общедоступных рекомендаций о детском сне, подобранных по вашим " +
  "ответам в анкете. Если вас беспокоит здоровье малыша, обратитесь к педиатру.";

const FINAL_DISCLAIMER =
  "<b>Важно.</b> Материалы Дрёмы носят исключительно информационный характер. Они составлены " +
  "на основе общедоступных источников о детском сне и подобраны с учётом ваших ответов в анкете. " +
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

const CSS = `
${FONTS}
:root { --navy:#1B1A3A; --navy2:#2A2852; --cream:#FBF4E8; --peach:#F3C99A; --pink:#E3A598; --lav:#8C7BB8; --ink:#2B2A3F; --muted:#6E6A82; }
* { box-sizing: border-box; }
body { margin:0; font-family: Inter, "Noto Color Emoji", sans-serif; color: var(--ink); font-size: 10.6pt; line-height: 1.55; }
h1,h2,h3,.serif { font-family: Lora, "Noto Color Emoji", serif; }
.page { position: relative; page-break-after: always; background: #fff; }
.full { width: 210mm; height: 297mm; overflow:hidden; }
.page:last-child { page-break-after: auto; }
.cover .bottom { display:flex; flex-direction:column; }
.cover { background: radial-gradient(120% 80% at 50% 38%, #34306A 0%, var(--navy) 62%); color: var(--cream); display:flex; flex-direction:column; justify-content:space-between; padding: 26mm 22mm; }
.cover .brand { font-family: Lora, serif; font-size: 22pt; color: var(--peach); letter-spacing:.5px; }
.cover .brand small { display:block; font-family: Inter; font-size: 9.5pt; color:#CFC7E8; letter-spacing:.3px; margin-top:2px; }
.cover .cloud { width: 92mm; display:block; margin: 0 auto; }
.cover h1 { font-size: 30pt; line-height:1.15; margin: 0 0 6mm; font-weight: 500; color:#FFF6E6; }
.cover .sub { color:#CFC7E8; font-size: 11pt; max-width: 125mm; }
.cover .meta { display:flex; justify-content:space-between; color:#A9A1CC; font-size: 9pt; border-top: 1px solid rgba(207,199,232,.25); padding-top: 5mm; }
.star { position:absolute; color: var(--peach); opacity:.75; }
.kicker { font-size: 8.5pt; text-transform: uppercase; letter-spacing: 1.6px; color: var(--lav); font-weight: 600; margin-bottom: 2mm; }
.ptitle { font-size: 21pt; margin: 0 0 7mm; color: var(--navy); font-weight: 500; }
h2 { font-size: 14pt; color: var(--navy); margin: 7mm 0 2.5mm; font-weight: 600; break-after: avoid; }
h2:first-child { margin-top: 0; }
h3 { font-size: 11.5pt; color: var(--navy); margin: 5mm 0 1.5mm; font-weight: 600; padding-left: 4mm; border-left: 3px solid var(--peach); break-after: avoid; }
li { break-inside: avoid; } ul.short { break-inside: avoid; }
p { margin: 0 0 2.6mm; } ul { margin: 0 0 3mm; padding-left: 5mm; } li { margin-bottom: 1.6mm; } li::marker { color: var(--pink); }
.rec h2:first-of-type + p { background: var(--cream); border-radius: 4mm; padding: 4.5mm 5mm; font-size: 11pt; }
.intro { background: var(--cream); border-radius: 4mm; padding: 4.5mm 5mm; margin-bottom: 7mm; }
.sched { width:100%; border-collapse: separate; border-spacing: 0 2.5mm; }
.sched td { padding: 4mm 4mm; background:#F6F3FB; }
.sched td:first-child { border-radius: 3mm 0 0 3mm; } .sched td:last-child { border-radius: 0 3mm 3mm 0; }
.sched .t { font-family: Lora, serif; font-size: 15pt; color: var(--navy); width: 26mm; font-weight:600; }
.sched .i { width: 10mm; font-size: 13pt; color: var(--lav); text-align:center; }
.sched .e { font-size: 11pt; font-weight: 600; color: var(--navy); }
.sched .d { display:block; font-weight:400; font-size: 9.5pt; color: var(--muted); }
.sched tr.wake td { background: #FDF0DC; } .sched tr.wake .i { color:#D9973F; }
.sched tr.calm td { background: #FBE9E5; } .sched tr.calm .i { color: var(--pink); }
.sched tr.night td { background: var(--navy); } .sched tr.night .t, .sched tr.night .e { color:#FFF6E6; } .sched tr.night .i { color: var(--peach); }
.sdisc { margin-top: 5mm; font-size: 8.5pt; line-height: 1.5; color: var(--muted); background: var(--cream); border: 1px solid #EFE6D6; border-radius: 3mm; padding: 3.5mm 4.5mm; }
.note { margin-top: 6mm; font-size: 10.2pt; color: var(--ink); border-top: 1px solid #E8E3F2; padding-top: 5mm; }
.note b { color: var(--navy); }
.end { background: var(--navy); color: var(--cream); display:flex; flex-direction:column; justify-content:center; align-items:center; text-align:center; }
.end .cloud { width: 60mm; }
.end h2 { color: #FFF6E6; font-size: 20pt; font-weight:500; margin: 6mm 0 4mm; }
.end p { color:#CFC7E8; max-width: 130mm; }
.cdisc { font-size: 8.5pt; line-height:1.5; color:#CFC7E8; background: rgba(255,255,255,.06); border:1px solid rgba(207,199,232,.22); border-radius: 3mm; padding: 3.5mm 4.5mm; margin-bottom: 5mm; }
.disc b { color:#FFF6E6; }
.end .sign { font-family: Lora, serif; font-style: italic; color: var(--peach); font-size: 12pt; margin-top: -1mm; }
.contacts { margin-top: 5mm; font-size: 8.5pt; color:#A9A1CC; line-height:1.7; }
.contacts span { color: var(--peach); }
.disc { margin-top: 18mm; font-size: 8.5pt; color:#A9A1CC; max-width: 140mm; border-top: 1px solid rgba(207,199,232,.25); padding-top: 5mm; }
`;

// Колонтитул содержательных страниц. Живёт в поле страницы, поэтому его
// задаёт сам Chromium, а не разметка — отсюда inline-стили.
export const FOOTER_TEMPLATE =
  '<div style="width:100%;font-family:Inter,sans-serif;font-size:7.5pt;color:#6E6A82;padding:0 20mm;' +
  'display:flex;justify-content:space-between"><span>Дрёма · персональный план сна</span>' +
  '<span>стр. <span class="pageNumber"></span></span></div>';

function document(body: string, pageMargin: string): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>
@page { size: A4; margin: ${pageMargin}; }
${CSS}</style></head><body>${body}</body></html>`;
}

function contentPage(kicker: string, title: string, body: string): string {
  return `<section class="page"><div class="kicker">${escapeHtml(kicker)}</div>` +
    `<h1 class="ptitle">${escapeHtml(title)}</h1>${body}</section>`;
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
<span class="star" style="top:30mm;right:32mm;font-size:14pt">✦</span><span class="star" style="top:70mm;left:26mm;font-size:9pt">✦</span>
<span class="star" style="top:118mm;right:24mm;font-size:8pt">★</span>
<div class="brand">Дрёма<small>ваш помощник по детскому сну</small></div>
<div>${CLOUD}</div>
<div><h1>Персональный план сна<br>для вашего малыша</h1>
<div class="sub">Что попробовать в вашей ситуации, примерный режим дня и памятка о том, как помочь малышу расслабиться перед сном.</div></div>
<div class="cdisc">${COVER_DISCLAIMER}</div>
<div class="meta"><span>Подготовлено по вашей анкете и разбору</span><span>${escapeHtml(formatRussianDate(approvedAt))}</span></div></section>`;

  const recommendations = contentPage(
    "Часть 1",
    "Что попробовать в вашей ситуации",
    `<div class="rec">${markdown(content.recommendations)}</div>`
  );

  const schedule = contentPage(
    "Часть 2",
    "Примерный режим дня",
    `<div class="intro">${inline(content.schedule.intro)}</div>` +
      scheduleBlock(content.schedule.variants) +
      `<div class="sdisc">${escapeHtml(SCHEDULE_DISCLAIMER)}</div>` +
      `<div class="note"><b>Как прийти к этому режиму.</b> ${inline(content.schedule.note)}</div>`
  );

  const relaxation = contentPage(
    "Часть 3",
    "Памятка: как помочь малышу расслабиться перед сном",
    markdown(relaxationMemo)
  );

  const end = `<section class="page full end">${CLOUD}<h2>Спокойной ночи 💛</h2>
<div class="sign">Ваш помощник Дрёма</div>
<div class="disc">${FINAL_DISCLAIMER}</div>
<div class="contacts">${contacts()}</div></section>`;

  return {
    cover: document(cover, "0"),
    content: document(recommendations + schedule + relaxation, "20mm 20mm 20mm"),
    end: document(end, "0"),
  };
}
