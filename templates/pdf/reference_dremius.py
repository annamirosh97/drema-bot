"""Референсная сборка PDF «Персональный план сна» в стиле Дрёмиуса.
Содержание и структура — как в прежнем PDF (P1 режим + P2 тексты + памятка).
Меняется только визуальный слой: палитра Night/Indigo/Lavender/Cream/Apricot/Blush,
шрифты Rubik (заголовки) и Onest (текст), персонаж Дрёмиус на обложке и финальной странице.
Запуск: python3 build_dremius.py  → Dremius_plan_sna_primer.pdf
"""
import base64, html, re
from pathlib import Path
from playwright.sync_api import sync_playwright
from pypdf import PdfWriter, PdfReader

HERE = Path(__file__).parent
ASSETS = HERE.parent.parent / "assets"  # шрифты и картинки берём из репозитория

# ---------- данные (в продукте приходят из P1/P2 и env) ----------
RECOMMENDATIONS = (HERE / "content_recommendations.md").read_text(encoding="utf-8")
RELAXATION = (HERE / "content_relaxation_9-12.md").read_text(encoding="utf-8")
SCHEDULE_INTRO = "Это ориентир, а не расписание по минутам: время может сдвигаться на 15–20 минут, и это нормально. Он построен от подъёма в 8:00. Главное — смотреть на признаки усталости малыша, а не только на часы."
SCHEDULE_NOTE = "Приходите к этому режиму постепенно: сначала выровняйте подъём, потом понемногу удлиняйте утро, примерно на 5 минут в день, и следите, чтобы второй сон не затягивался. Если малыш явно устал раньше времени из таблицы, укладывайте по признакам усталости. Если дневные сны окажутся длиннее или короче, всё остальное сдвинется вслед за ними."
SCHEDULE_ROWS = [
    ("08:00", "Подъём", "wake", ""),
    ("11:35", "Первый дневной сон", "sleep", "около 1 ч 10 мин – 1 ч 20 мин"),
    ("16:45", "Второй дневной сон", "sleep", "около 40–50 мин"),
    ("20:50", "Спокойный час перед сном", "calm", ""),
    ("21:50", "Ночной сон", "night", ""),
]
DATE = "27 октября 2026"
OFFER_URL = ""                      # env OFFER_URL; пусто — строка не выводится
CONTACT_EMAIL = "hello@dremius.ru"  # env CONTACT_EMAIL

# ---------- фиксированные тексты шаблона ----------
BRAND = "Дрёмиус"
DESCRIPTOR = "ваш помощник по детскому сну"
COVER_DISCLAIMER = "Этот план носит информационный характер и не является медицинской консультацией. Он составлен на основе общедоступных рекомендаций о детском сне, подобранных по вашим ответам в анкете. Если вас беспокоит здоровье малыша, обратитесь к педиатру."
SCHEDULE_DISCLAIMER = "Этот режим — ориентир, который обычно подходит детям в возрасте вашего малыша. Индивидуальные потребности в сне у каждого малыша свои, поэтому ваш режим может отличаться. Чтобы подобрать и скорректировать режим именно под вашего малыша, можно обратиться к специалисту по сну."
FINAL_DISCLAIMER = "Материалы Дрёмиуса носят исключительно информационный характер. Они составлены на основе общедоступных источников о детском сне и подобраны с учётом ваших ответов в анкете. Это не медицинская консультация, не диагноз и не назначение лечения, и они не заменяют осмотр врача. Решения о режиме и уходе за малышом принимаете вы. Если малыш болеет, вы заметили изменения в его самочувствии или вас что-то тревожит, обратитесь к педиатру."


def data_uri(p: Path, mime: str) -> str:
    return f"data:{mime};base64," + base64.b64encode(p.read_bytes()).decode()


def font_faces() -> str:
    out = []
    for fam, slug in (("Rubik", "rubik"), ("Onest", "onest")):
        for w in (400, 500, 600, 700):
            for sub in ("cyrillic", "latin"):
                f = ASSETS / "fonts" / f"{slug}-{sub}-{w}-normal.woff2"
                rng = "U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116" if sub == "cyrillic" else "U+0000-00FF,U+2000-206F,U+20AC,U+2122,U+2190-2199,U+2212"
                out.append(f"@font-face{{font-family:'{fam}';font-weight:{w};src:url({data_uri(f,'font/woff2')}) format('woff2');unicode-range:{rng};}}")
    return "\n".join(out)


def inline(s: str) -> str:
    s = html.escape(s)
    return re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)


def md(text: str) -> str:
    out = []
    first_h2 = True
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
            out.append("<ul>" + "".join(f"<li>{inline(l[2:])}</li>" for l in lines) + "</ul>")
        elif len(lines) == 1 and re.fullmatch(r"\*\*.+\*\*", lines[0]):
            out.append(f"<h3>{inline(lines[0][2:-2])}</h3>")
        else:
            out.append("<p>" + " ".join(inline(l) for l in lines) + "</p>")
    return "\n".join(out)


# line-иконки (луна, звезда, лупа, сердце) — мягкие окончания, по гайду
ICONS = {
    "loupe": '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
    "moon": '<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/>',
    "star": '<path d="M12 3.5l2.4 5.1 5.6.7-4.1 3.9 1 5.5L12 16l-4.9 2.7 1-5.5L4 9.3l5.6-.7z"/>',
    "heart": '<path d="M12 19.5s-7-4.3-7-9.4A3.9 3.9 0 0 1 12 7.6a3.9 3.9 0 0 1 7 2.5c0 5.1-7 9.4-7 9.4z"/>',
    "sun": '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
}


def icon(name, cls="ic"):
    return f'<svg class="{cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">{ICONS[name]}</svg>'


WORDMARK_STAR = '<svg class="wm-star" viewBox="0 0 24 24"><path d="M12 2.5l2.6 5.6 6.1.8-4.5 4.2 1.1 6-5.3-3-5.3 3 1.1-6L3.3 8.9l6.1-.8z" fill="#F3B17E"/></svg>'


def schedule_html():
    kind_icon = {"wake": "sun", "sleep": "moon", "calm": "heart", "night": "star"}
    rows = []
    for time, event, kind, dur in SCHEDULE_ROWS:
        rows.append(f'<div class="row {kind}"><div class="t">{time}</div>{icon(kind_icon[kind], "ri")}'
                    f'<div class="e">{html.escape(event)}{f"<span>{html.escape(dur)}</span>" if dur else ""}</div></div>')
    return '<div class="sched">' + "".join(rows) + "</div>"


CSS = """
:root{--night:#10182F;--indigo:#3E4F7C;--lav:#9D92B6;--cream:#FFF1D9;--apricot:#F3B17E;--blush:#EAC9CA;
--paper:#FFF8EE;--ink:#1D2540;--muted:#5F6683;--line:#E9DFCF;--tint:#EEEBF4;}
*{box-sizing:border-box}
html{background:var(--paper)}
body{margin:0;font-family:Onest,sans-serif;color:var(--ink);font-size:10.6pt;line-height:1.6;background:var(--paper)}
h1,h2,h3,.rub{font-family:Rubik,sans-serif}
.page{position:relative;page-break-after:always}
.page:last-child{page-break-after:auto}
.full{width:210mm;height:297mm;overflow:hidden}
/* ---------- обложка ---------- */
.cover{background:var(--night);color:var(--cream);padding:20mm 20mm 18mm;display:flex;flex-direction:column}
.wm{font-family:Rubik;font-weight:700;font-size:26pt;letter-spacing:-.3px;color:var(--cream);position:relative;display:inline-block;line-height:1}
.yo{position:relative;display:inline-block}.wm-star{position:absolute;width:.42em;height:.42em;left:50%;top:-.12em;transform:translateX(-50%);filter:drop-shadow(0 0 4px rgba(243,177,126,.8))}
.desc{font-size:10pt;color:var(--lav);margin-top:2.5mm;letter-spacing:.2px}
.hero{margin:12mm 0 6mm;display:flex;justify-content:center}
.hero img{width:128mm;height:auto;display:block}
.cover h1{font-weight:600;font-size:27pt;line-height:1.15;margin:4mm 0 4mm;color:#FFF6E8;letter-spacing:-.2px}
.cover .sub{font-size:11pt;color:#C9C3DA;max-width:150mm}
.cover .spacer{flex:1}
.cdisc{font-size:8.6pt;line-height:1.55;color:#C9C3DA;background:rgba(62,79,124,.35);border:1px solid rgba(157,146,182,.28);border-radius:16px;padding:4mm 5mm;margin:0 0 5mm}
.meta{display:flex;justify-content:space-between;font-size:8.8pt;color:var(--lav);border-top:1px solid rgba(157,146,182,.25);padding-top:4mm}
/* ---------- разделы ---------- */
.head{display:flex;align-items:center;gap:4mm;margin-bottom:7mm}
.badge{width:13mm;height:13mm;border-radius:50%;background:var(--night);color:var(--apricot);display:flex;align-items:center;justify-content:center;flex:none;border:2.5px solid rgba(243,177,126,.35)}
.badge .ic{width:7mm;height:7mm}
.kicker{font-size:8pt;text-transform:uppercase;letter-spacing:1.6px;color:var(--indigo);font-weight:600}
.ptitle{font-size:20pt;line-height:1.2;font-weight:600;margin:.5mm 0 0;color:var(--night);letter-spacing:-.2px}
h2{font-size:13.5pt;font-weight:600;color:var(--night);margin:7mm 0 2.5mm;break-after:avoid}
.body > h2:first-child{margin-top:0}
h3{font-size:11.2pt;font-weight:600;color:var(--indigo);margin:5mm 0 1.5mm;break-after:avoid;display:flex;align-items:center;gap:2.5mm}
h3::before{content:"";width:2.4mm;height:2.4mm;border-radius:50%;background:var(--apricot);flex:none}
p{margin:0 0 2.6mm}
ul{margin:0 0 3mm;padding-left:0;list-style:none}
li{position:relative;padding-left:6mm;margin-bottom:1.8mm;break-inside:avoid}
li::before{content:"";position:absolute;left:1mm;top:2.3mm;width:1.8mm;height:1.8mm;border-radius:50%;background:var(--apricot)}
strong{color:var(--night);font-weight:600}
/* «Коротко о главном» — тёмная карточка-ночник */
.rec > h2:first-child + p{background:var(--night);color:var(--cream);border-radius:18px;padding:5.5mm 6mm;font-size:11pt;line-height:1.6;
 position:relative}
.rec > h2:first-child{margin-top:0}
/* ---------- режим ---------- */
.intro{background:var(--tint);border-radius:16px;padding:4.5mm 5.5mm;margin-bottom:6mm}
.sched{background:var(--night);border-radius:22px;padding:5mm 5mm}
.row{display:flex;align-items:center;gap:4mm;padding:3.6mm 3mm;border-bottom:1px solid rgba(157,146,182,.18)}
.row:last-child{border-bottom:0}
.row .t{font-family:Rubik;font-weight:600;font-size:15pt;color:var(--apricot);width:24mm;flex:none}
.row .ri{width:6mm;height:6mm;color:var(--lav);flex:none}
.row .e{font-family:Rubik;font-weight:500;font-size:11.5pt;color:var(--cream)}
.row .e span{display:block;font-family:Onest;font-weight:400;font-size:9.4pt;color:#B9B3CE;margin-top:.5mm}
.row.night{background:rgba(62,79,124,.55);border-radius:14px;border-bottom:0}
.row.night .ri{color:var(--apricot)}
.row.wake .ri{color:var(--apricot)}
.sdisc{margin-top:5mm;font-size:9.4pt;color:var(--ink);background:var(--tint);border-radius:14px;padding:3.8mm 5mm}
.note{margin-top:5mm;font-size:10.2pt;border-top:1px solid var(--line);padding-top:4.5mm}
/* ---------- финал ---------- */
.end{background:var(--night);color:var(--cream);display:flex;flex-direction:column;align-items:center;text-align:center;padding:30mm 22mm 18mm}
.end .pic{width:112mm;display:block;filter:drop-shadow(0 0 18mm rgba(243,177,126,.26))}
.end h2{font-size:22pt;font-weight:600;color:#FFF6E8;margin:8mm 0 2mm}
.end .sign{font-family:Rubik;font-weight:500;color:var(--apricot);font-size:12pt}
.end .spacer{flex:1}
.fdisc{font-size:8.6pt;line-height:1.55;color:#C9C3DA;text-align:left;background:rgba(62,79,124,.35);border:1px solid rgba(157,146,182,.28);border-radius:16px;padding:4.5mm 5.5mm}
.fdisc b{color:var(--cream)}
.contacts{margin-top:5mm;font-size:8.8pt;color:var(--lav);line-height:1.8}
.contacts span{color:var(--apricot)}
"""


def section(kicker, title, ico, body, cls=""):
    return (f'<section class="page {cls}"><div class="head"><div class="badge">{icon(ico)}</div>'
            f'<div><div class="kicker">{kicker}</div><h1 class="ptitle">{title}</h1></div></div>'
            f'<div class="body {cls}">{body}</div></section>')


def build():
    hero = data_uri(ASSETS / "pdf/dremius-cloud.png", "image/png")
    sleepy = data_uri(ASSETS / "pdf/dremius-final.png", "image/png")
    cover = f"""<section class="page full cover">
<div><div class="wm">Др<span class="yo">е{WORDMARK_STAR}</span>миус</div><div class="desc">{DESCRIPTOR}</div></div>
<div class="hero"><img src="{hero}"></div>
<h1>Персональный план сна<br>для вашего малыша</h1>
<div class="sub">Что попробовать в вашей ситуации, примерный режим дня и памятка о том, как помочь малышу расслабиться перед сном.</div>
<div class="spacer"></div>
<div class="cdisc">{html.escape(COVER_DISCLAIMER)}</div>
<div class="meta"><span>Подготовлено по вашей анкете и разбору</span><span>{DATE}</span></div></section>"""

    rec = section("Часть 1", "Что попробовать в вашей ситуации", "loupe", md(RECOMMENDATIONS), "rec")
    sched = section("Часть 2", "Примерный режим дня", "moon",
                    f'<div class="intro">{inline(SCHEDULE_INTRO)}</div>{schedule_html()}'
                    f'<div class="sdisc">{inline(SCHEDULE_DISCLAIMER)}</div>'
                    f'<div class="note"><strong>Как прийти к этому режиму.</strong> {inline(SCHEDULE_NOTE)}</div>')
    relax = section("Часть 3", "Памятка: как помочь малышу расслабиться перед сном", "heart", md(RELAXATION))
    contacts = [x for x in [
        f'Условия оказания услуги: <span>{html.escape(OFFER_URL)}</span>' if OFFER_URL else "",
        f'Почта для связи: <span>{html.escape(CONTACT_EMAIL)}</span>' if CONTACT_EMAIL else ""] if x]
    end = f"""<section class="page full end">
<img class="pic" src="{sleepy}">
<h2>Спокойной ночи 💛</h2><div class="sign">Ваш помощник {BRAND}</div>
<div class="spacer"></div>
<div class="fdisc"><b>Важно.</b> {html.escape(FINAL_DISCLAIMER)}</div>
<div class="contacts">{"<br>".join(contacts)}</div></section>"""

    head = f"<!doctype html><html lang='ru'><head><meta charset='utf-8'><style>{font_faces()}{CSS}</style></head><body>"
    footer = ('<div style="width:100%;font-family:Onest,sans-serif;font-size:7.5pt;color:#5F6683;padding:0 20mm;'
              f'display:flex;justify-content:space-between"><span>{BRAND} · персональный план сна</span>'
              '<span><span class="pageNumber"></span></span></div>')
    parts = {"cover": (cover, False), "content": (rec + sched + relax, True), "end": (end, False)}
    w = PdfWriter()
    with sync_playwright() as p:
        b = p.chromium.launch()
        paper = HERE / "_paper.pdf"
        pg = b.new_page()
        pg.set_content("<html style='background:#FFF8EE'><style>@page{size:A4;margin:0}html,body{margin:0;height:100%}</style><body></body></html>")
        pg.pdf(path=str(paper), format="A4", print_background=True, prefer_css_page_size=True)
        for name, (body, flow) in parts.items():
            f = HERE / f"_{name}.html"
            page_css = "@page{size:A4;margin:0}" if not flow else "@page{size:A4;margin:18mm 20mm 18mm}"
            f.write_text(head.replace("<style>", f"<style>{page_css}") + body + "</body></html>", encoding="utf-8")
            pg = b.new_page()
            pg.goto(f.as_uri())
            pg.wait_for_timeout(300)
            out = HERE / f"_{name}.pdf"
            if flow:
                pg.pdf(path=str(out), format="A4", print_background=True, prefer_css_page_size=True,
                       display_header_footer=True, header_template="<span></span>", footer_template=footer)
            else:
                pg.pdf(path=str(out), format="A4", print_background=True, prefer_css_page_size=True)
            for pp in PdfReader(str(out)).pages:
                if flow:  # подложка цвета бумаги под всю страницу, включая поля
                    bg = PdfReader(str(paper)).pages[0]
                    bg.merge_page(pp)
                    pp = bg
                w.add_page(pp)
        b.close()
    dst = HERE / "Dremius_plan_sna_primer.pdf"
    with open(dst, "wb") as fh:
        w.write(fh)
    print(dst)


if __name__ == "__main__":
    build()
