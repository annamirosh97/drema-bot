"""Сборка примера PDF Дрёмы из ответа P1 (режим) и P2 (тексты).
Мини-рендер разметки: ## заголовки, - списки, **жирный** — ровно подмножество из промпта."""
import html, re, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

HERE = Path(__file__).parent

RECOMMENDATIONS = (HERE / "p2_recommendations.md").read_text(encoding="utf-8")
SCHEDULE_INTRO = "Это ориентир, а не расписание по минутам: время может сдвигаться на 15–20 минут, и это нормально. Он построен от подъёма в 8:00. Главное — смотреть на признаки усталости малыша, а не только на часы."
SCHEDULE_NOTE = "Приходите к этому режиму постепенно: сначала выровняйте подъём, потом понемногу удлиняйте утро, примерно на 5 минут в день, и следите, чтобы второй сон не затягивался. Если малыш явно устал раньше времени из таблицы, укладывайте по признакам усталости. Если дневные сны окажутся длиннее или короче, всё остальное сдвинется вслед за ними."
SCHEDULE_ROWS = [  # строки из ===РЕЖИМ=== ответа P1
    ("08:00", "Подъём", "wake"),
    ("11:35", "Первый дневной сон", "sleep", "около 1 ч 10 мин – 1 ч 20 мин"),
    ("16:45", "Второй дневной сон", "sleep", "около 40–50 мин"),
    ("20:50", "Спокойный час перед сном", "calm"),
    ("21:50", "Ночной сон", "night"),
]
# В продукте: OFFER_URL = PUBLIC_BASE_URL + "/offer", CONTACT_EMAIL — из env
OFFER_URL = ""  # пусто — строка не выводится
CONTACT_EMAIL = ""  # пусто — строка не выводится
RELAXATION = (HERE / "relaxation_9-12.md").read_text(encoding="utf-8")


def inline(s: str) -> str:
    s = html.escape(s)
    return re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)


def md(text: str) -> str:
    out, in_list = [], False
    for block in re.split(r"\n\s*\n", text.strip()):
        lines = [l for l in block.splitlines() if l.strip()]
        if not lines:
            continue
        if lines[0].startswith("## "):
            out.append(f"<h2>{inline(lines[0][3:])}</h2>")
            lines = lines[1:]
            if not lines:
                continue
        if all(l.startswith("- ") for l in lines):
            out.append(("<ul class='short'>" if len(lines) <= 6 and all(len(l) < 60 for l in lines) else "<ul>") + "".join(f"<li>{inline(l[2:])}</li>" for l in lines) + "</ul>")
        elif len(lines) == 1 and re.fullmatch(r"\*\*.+\*\*", lines[0]):
            out.append(f"<h3>{inline(lines[0][2:-2])}</h3>")
        else:
            out.append("<p>" + " ".join(inline(l) for l in lines) + "</p>")
    return "\n".join(out)


CLOUD = """<svg viewBox="0 0 200 130" class="cloud" aria-hidden="true">
<defs><radialGradient id="g" cx="50%" cy="45%" r="60%"><stop offset="0" stop-color="#FFF6E6"/><stop offset="1" stop-color="#F3C99A"/></radialGradient>
<filter id="glow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="9"/></filter></defs>
<g filter="url(#glow)" opacity=".55"><ellipse cx="100" cy="78" rx="92" ry="52" fill="#F3C99A"/></g>
<path d="M45 112c-22 0-36-15-36-33 0-17 13-31 30-32 5-21 23-36 44-36 18 0 33 10 40 25 4-2 9-3 14-3 21 0 37 17 37 38 0 23-17 41-40 41z" fill="url(#g)"/>
<circle cx="80" cy="72" r="5" fill="#1B1A3A"/><circle cx="120" cy="72" r="5" fill="#1B1A3A"/>
<path d="M90 86q10 8 20 0" stroke="#1B1A3A" stroke-width="3.5" fill="none" stroke-linecap="round"/>
<circle cx="68" cy="86" r="7" fill="#E3A598" opacity=".55"/><circle cx="132" cy="86" r="7" fill="#E3A598" opacity=".55"/></svg>"""

ICON = {"wake": "☀", "sleep": "☾", "calm": "✦", "night": "★"}


def schedule_html():
    rows = []
    for r in SCHEDULE_ROWS:
        time, event, kind = r[:3]
        dur = r[3] if len(r) > 3 else ""
        rows.append(f"""<tr class="{kind}"><td class="t">{time}</td><td class="i">{ICON[kind]}</td>
<td class="e">{html.escape(event)}{f'<span class="d">{html.escape(dur)}</span>' if dur else ''}</td></tr>""")
    return "<table class='sched'>" + "".join(rows) + "</table>"


CSS = """
@page { size: A4; margin: 0; }
:root { --navy:#1B1A3A; --navy2:#2A2852; --cream:#FBF4E8; --peach:#F3C99A; --pink:#E3A598; --lav:#8C7BB8; --ink:#2B2A3F; --muted:#6E6A82; }
* { box-sizing: border-box; }
body { margin:0; font-family: Inter, sans-serif; color: var(--ink); font-size: 10.6pt; line-height: 1.55; }
h1,h2,h3,.serif { font-family: Lora, serif; }
.page { position: relative; page-break-after: always; background: #fff; }
.full { width: 210mm; height: 297mm; overflow:hidden; }
.page:last-child { page-break-after: auto; }
/* обложка */
.cover .bottom { display:flex; flex-direction:column; }
.cover { background: radial-gradient(120% 80% at 50% 38%, #34306A 0%, var(--navy) 62%); color: var(--cream); display:flex; flex-direction:column; justify-content:space-between; padding: 26mm 22mm; }
.cover .brand { font-family: Lora, serif; font-size: 22pt; color: var(--peach); letter-spacing:.5px; }
.cover .brand small { display:block; font-family: Inter; font-size: 9.5pt; color:#CFC7E8; letter-spacing:.3px; margin-top:2px; }
.cover .cloud { width: 92mm; display:block; margin: 0 auto; }
.cover h1 { font-size: 30pt; line-height:1.15; margin: 0 0 6mm; font-weight: 500; color:#FFF6E6; }
.cover .sub { color:#CFC7E8; font-size: 11pt; max-width: 125mm; }
.cover .meta { display:flex; justify-content:space-between; color:#A9A1CC; font-size: 9pt; border-top: 1px solid rgba(207,199,232,.25); padding-top: 5mm; }
.star { position:absolute; color: var(--peach); opacity:.75; }
/* содержание страниц */
.kicker { font-size: 8.5pt; text-transform: uppercase; letter-spacing: 1.6px; color: var(--lav); font-weight: 600; margin-bottom: 2mm; }
.ptitle { font-size: 21pt; margin: 0 0 7mm; color: var(--navy); font-weight: 500; }
h2 { font-size: 14pt; color: var(--navy); margin: 7mm 0 2.5mm; font-weight: 600; break-after: avoid; }
h2:first-child { margin-top: 0; }
h3 { font-size: 11.5pt; color: var(--navy); margin: 5mm 0 1.5mm; font-weight: 600; padding-left: 4mm; border-left: 3px solid var(--peach); break-after: avoid; }
li { break-inside: avoid; } ul.short { break-inside: avoid; }
p { margin: 0 0 2.6mm; } ul { margin: 0 0 3mm; padding-left: 5mm; } li { margin-bottom: 1.6mm; } li::marker { color: var(--pink); }
.rec h2:first-of-type + p { background: var(--cream); border-radius: 4mm; padding: 4.5mm 5mm; font-size: 11pt; }
.foot { position:absolute; bottom: 9mm; left:20mm; right:20mm; display:flex; justify-content:space-between; font-size: 8pt; color: var(--muted); }
/* режим */
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
.note { margin-top: 6mm; font-size: 10.2pt; color: var(--ink); border-top: 1px solid #E8E3F2; padding-top: 5mm; }
.note b { color: var(--navy); }
/* финал */
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
"""


def page(kicker, title, body, n, cls=""):
    return f"""<section class="page {cls}"><div class="kicker">{kicker}</div><h1 class="ptitle">{title}</h1>{body}
</section>"""


def build():
    cover = f"""<section class="page full cover">
<span class="star" style="top:30mm;right:32mm;font-size:14pt">✦</span><span class="star" style="top:70mm;left:26mm;font-size:9pt">✦</span>
<span class="star" style="top:118mm;right:24mm;font-size:8pt">★</span>
<div class="brand">Дрёма<small>ваш помощник по детскому сну</small></div>
<div>{CLOUD}</div>
<div><h1>Персональный план сна<br>для вашего малыша</h1>
<div class="sub">Что попробовать в вашей ситуации, примерный режим дня и памятка о том, как помочь малышу расслабиться перед сном.</div></div>
<div class="cdisc">Этот план носит информационный характер и не является медицинской консультацией. Он составлен на основе общедоступных рекомендаций о детском сне, подобранных по вашим ответам в анкете. Если вас беспокоит здоровье малыша, обратитесь к педиатру.</div>
<div class="meta"><span>Подготовлено по вашей анкете и разбору</span><span>6 октября 2026</span></div></section>"""

    rec = page("Часть 1", "Что попробовать в вашей ситуации", f'<div class="rec">{md(RECOMMENDATIONS)}</div>', 2)
    sched = page("Часть 2", "Примерный режим дня",
                 f'<div class="intro">{inline(SCHEDULE_INTRO)}</div>{schedule_html()}'
                 f'<div class="note"><b>Как прийти к этому режиму.</b> {inline(SCHEDULE_NOTE)}</div>', 4)
    relax = page("Часть 3", "Памятка: как помочь малышу расслабиться перед сном", md(RELAXATION), 5)
    end = f"""<section class="page full end">{CLOUD}<h2>Спокойной ночи 💛</h2>
<div class="sign">Ваш помощник Дрёма</div>
<div class="disc"><b>Важно.</b> Материалы Дрёмы носят исключительно информационный характер. Они составлены на основе общедоступных источников о детском сне и подобраны с учётом ваших ответов в анкете. Это не медицинская консультация, не диагноз и не назначение лечения, и они не заменяют осмотр врача. Решения о режиме и уходе за малышом принимаете вы. Если малыш болеет, вы заметили изменения в его самочувствии или вас что-то тревожит, обратитесь к педиатру.</div>
<div class="contacts">{"<br>".join(x for x in [f'Условия оказания услуги: <a href="{html.escape(OFFER_URL)}"><span>{html.escape(OFFER_URL)}</span></a>' if OFFER_URL else "", f'Почта для связи: <span>{html.escape(CONTACT_EMAIL)}</span>' if CONTACT_EMAIL else ""] if x)}</div></section>"""

    head = f"<!doctype html><html lang='ru'><head><meta charset='utf-8'><style>{CSS}</style></head><body>"
    parts = {"cover": (cover, False), "content": (rec + sched + relax, True), "end": (end, False)}
    footer = ('<div style="width:100%;font-family:Inter;font-size:7.5pt;color:#6E6A82;padding:0 20mm;'
              'display:flex;justify-content:space-between"><span>Дрёма · персональный план сна</span>'
              '<span>стр. <span class="pageNumber"></span></span></div>')
    from pypdf import PdfWriter, PdfReader
    w = PdfWriter()
    with sync_playwright() as p:
        b = p.chromium.launch()
        for name, (body, margins) in parts.items():
            f = HERE / f"_{name}.html"
            h = head.replace("@page { size: A4; margin: 0; }", "@page { size: A4; margin: 20mm 20mm 20mm; }") if margins else head
            f.write_text(h + body + "</body></html>", encoding="utf-8")
            pg = b.new_page(); pg.goto(f.as_uri())
            out = HERE / f"_{name}.pdf"
            if margins:
                pg.pdf(path=str(out), format="A4", print_background=True, prefer_css_page_size=True,
                       margin={"top": "20mm", "bottom": "18mm", "left": "20mm", "right": "20mm"},
                       display_header_footer=True, header_template="<span></span>", footer_template=footer)
            else:
                pg.pdf(path=str(out), format="A4", print_background=True, prefer_css_page_size=True)
            for page_ in PdfReader(str(out)).pages:
                w.add_page(page_)
        b.close()
    with open(HERE / "Drema_plan_sna_primer.pdf", "wb") as fh:
        w.write(fh)


if __name__ == "__main__":
    build()
