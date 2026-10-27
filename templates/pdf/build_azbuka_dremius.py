"""Сборка гида «Азбука сна малыша» в стиле Дрёмиуса.
Тексты — те же, что в прежней версии (content_azbuka.md + глоссарий ниже).
Стиль, шрифты, иконки и картинки — из reference_dremius.py."""
import html, sys
from pathlib import Path
from playwright.sync_api import sync_playwright
from pypdf import PdfReader, PdfWriter

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import reference_dremius as B  # noqa: E402

NAPS = [("4 месяца", "4"), ("5 месяцев", "4 или 3"), ("6 месяцев", "3"), ("7–9 месяцев", "3 или 2"), ("10–12 месяцев", "2"), ("после года", "постепенно 1")]

GLOSSARY = [
    ("Ассоциация на засыпание", "Способ, с которым малыш привык засыпать: грудь, бутылочка, укачивание, руки взрослого. Сама по себе это норма."),
    ("Бодрствование активное и спокойное", "Активное наполнено движением, играми и новыми впечатлениями. Спокойное проходит за книжками, тихими играми, прогулкой. Перед сном нужно спокойное."),
    ("Дневной сон", "Сны в течение дня. С возрастом их становится меньше: от четырёх в 4 месяца до двух к концу первого года."),
    ("Недогул", "Малыш бодрствовал меньше, чем ему нужно, и не успел устать: засыпает долго, но спокойно, спит поверхностно."),
    ("Ночной сон", "Самая длинная и глубокая часть сна за сутки, главная для восстановления."),
    ("Ночные «гуляния»", "Долгие ночные пробуждения, когда малыш бодр, спокоен и не может снова уснуть."),
    ("Окно бодрствования", "Время от пробуждения до следующего сна. С возрастом окна удлиняются, а в течение дня обычно растут от утра к вечеру."),
    ("Перегул", "Переутомление: малыш бодрствовал дольше, чем может выдержать. Засыпает со слезами, ночью просыпается с резким плачем."),
    ("Переход на меньшее число снов", "Период, когда малыш перестаёт нуждаться в одном из дневных снов. Обычно проходит постепенно, за несколько дней или недель."),
    ("Признаки усталости", "Сигналы, что малышу пора спать: трёт глаза, теребит ушки, отворачивается, хнычет без причины."),
    ("Ранний подъём", "Утреннее пробуждение раньше 6:00."),
    ("Ритм дня", "Повторяющийся порядок снов и бодрствования, который строится от времени утреннего подъёма."),
    ("Ритуал", "Несколько одних и тех же спокойных действий перед сном в одном и том же порядке. Подсказывает малышу, что скоро сон."),
    ("Самоуспокоение", "Умение малыша уснуть или снова заснуть без активной помощи взрослого. Развивается постепенно."),
    ("Сброс сна", "Временный период, когда сон сбивается без видимой причины: протест против укладывания, ночные «гуляния», ранние подъёмы."),
    ("Суммарное бодрствование", "Сумма всех окон бодрствования за день, от утреннего подъёма до ночного сна. Ночные пробуждения и «гуляния» в неё не входят. С неё начинают, когда подбирают режим."),
    ("Цикл сна", "Повторяющийся отрезок сна, в котором лёгкий сон сменяется глубоким. У малышей обычно около 40–60 минут."),
]

COVER_DISCLAIMER = "Материалы носят информационно-образовательный характер и составлены на основе общедоступных источников о детском сне. Они не являются медицинской консультацией. Если вас беспокоит здоровье малыша, обратитесь к педиатру."
FINAL_DISCLAIMER = "Материалы Дрёмиуса носят исключительно информационно-образовательный характер и составлены на основе общедоступных источников о детском сне. Это не медицинская консультация, не диагноз и не назначение лечения, и они не заменяют осмотр врача. Если малыш болеет, вы заметили изменения в его самочувствии или вас что-то тревожит, обратитесь к педиатру."

EXTRA_CSS = """
.toc{background:var(--tint);border-radius:16px;padding:4.5mm 5.5mm;margin-bottom:7mm}
.toc b{font-family:Rubik;font-weight:600;color:var(--night)}
.toc ol{margin:2mm 0 0;padding-left:5mm;columns:2;column-gap:8mm}
.toc ol li{padding-left:0;margin-bottom:1mm}
.toc ol li::before{display:none}
.toc ol li::marker{color:var(--indigo);font-weight:600}
.naps{break-inside:avoid;background:var(--night);border-radius:20px;padding:3mm 5mm;margin:2mm 0 5mm}
.naps .nh,.naps .nr{display:flex;justify-content:space-between;align-items:center;padding:2.6mm 1mm}
.naps .nh{font-size:8pt;text-transform:uppercase;letter-spacing:1.4px;color:var(--lav);font-weight:600;border-bottom:1px solid rgba(157,146,182,.25)}
.naps .nr{border-bottom:1px solid rgba(157,146,182,.18)}
.naps .nr:last-child{border-bottom:0}
.naps .a{font-family:Rubik;font-weight:500;color:var(--cream);font-size:11pt}
.naps .b{font-family:Rubik;font-weight:600;color:var(--apricot);font-size:12pt}
dl.gl{margin:0}
dl.gl div{break-inside:avoid;padding:3mm 0;border-bottom:1px solid var(--line)}
dl.gl dt{font-family:Rubik;font-weight:600;color:var(--night);font-size:11.3pt;margin-bottom:.6mm}
dl.gl dd{margin:0}
section.newsec{break-before:page}
.end .lead{color:#C9C3DA;max-width:125mm;margin:2mm auto 3mm}
"""


def naps_table():
    rows = "".join(f'<div class="nr"><span class="a">{a}</span><span class="b">{b}</span></div>' for a, b in NAPS)
    return f'<div class="naps"><div class="nh"><span>Возраст</span><span>Дневных снов обычно</span></div>{rows}</div>'


def main():
    theory_md = (HERE / "content_azbuka.md").read_text(encoding="utf-8")
    before, after = theory_md.split("{{NAPS_TABLE}}")
    theory = B.md(before) + naps_table() + B.md(after)
    heads = [l[3:] for l in theory_md.splitlines() if l.startswith("## ")]
    toc = ("<div class='toc'><b>Что внутри</b><ol>" + "".join(f"<li>{html.escape(h)}</li>" for h in heads)
           + "<li>Глоссарий</li></ol></div>")
    gl = "<dl class='gl'>" + "".join(f"<div><dt>{html.escape(t)}</dt><dd>{html.escape(d)}</dd></div>" for t, d in GLOSSARY) + "</dl>"

    cloud = B.data_uri(B.ASSETS / "pdf/dremius-cloud.png", "image/png")
    sleepy = B.data_uri(B.ASSETS / "pdf/dremius-final.png", "image/png")
    cover = f"""<section class="page full cover">
<div><div class="wm">Др<span class="yo">е{B.WORDMARK_STAR}</span>миус</div><div class="desc">{B.DESCRIPTOR}</div></div>
<div class="hero"><img src="{cloud}"></div>
<h1>Азбука сна малыша</h1>
<div class="sub">Короткий гайд о том, как устроен сон малышей от 4 до 12 месяцев, а также словарик основных понятий.</div>
<div class="spacer"></div>
<div class="cdisc">{html.escape(COVER_DISCLAIMER)}</div>
<div class="meta"><span>Образовательный проект о детском сне</span><span>Дрёмиус</span></div></section>"""

    part1 = B.section("Часть 1", "Как устроен сон малыша", "moon", toc + theory)
    part2 = B.section("Часть 2", "Глоссарий", "loupe", gl, "newsec")
    end = f"""<section class="page full end">
<div class="pic"><img src="{sleepy}"></div>
<h2>Скоро пришлю ваш разбор 💛</h2>
<p class="lead">Пока я его готовлю, этот гид поможет лучше понять, о чём в нём пойдёт речь.</p>
<div class="sign">Ваш помощник Дрёмиус</div>
<div class="spacer"></div>
<div class="fdisc"><b>Важно.</b> {html.escape(FINAL_DISCLAIMER)}</div>
<div class="contacts">Почта для связи: <span>hello@dremius.ru</span></div></section>"""

    head = f"<!doctype html><html lang='ru'><head><meta charset='utf-8'><style>{B.font_faces()}{B.CSS}{EXTRA_CSS}</style></head><body>"
    footer = ('<div style="width:100%;font-family:Onest,sans-serif;font-size:7.5pt;color:#5F6683;padding:0 20mm;'
              'display:flex;justify-content:space-between"><span>Дрёмиус · Азбука сна малыша</span>'
              '<span><span class="pageNumber"></span></span></div>')
    w = PdfWriter()
    with sync_playwright() as p:
        b = p.chromium.launch()
        paper = HERE / "_paper.pdf"
        pg = b.new_page()
        pg.set_content("<html style='background:#FFF8EE'><style>@page{size:A4;margin:0}html,body{margin:0;height:100%}</style><body></body></html>")
        pg.pdf(path=str(paper), format="A4", print_background=True, prefer_css_page_size=True)
        for name, body, flow in [("cover", cover, False), ("content", part1 + part2, True), ("end", end, False)]:
            page_css = "@page{size:A4;margin:0}" if not flow else "@page{size:A4;margin:18mm 20mm 18mm}"
            f = HERE / f"_az_{name}.html"
            f.write_text(head.replace("<style>", f"<style>{page_css}") + body + "</body></html>", encoding="utf-8")
            pg = b.new_page(); pg.goto(f.as_uri()); pg.wait_for_timeout(300)
            out = HERE / f"_az_{name}.pdf"
            if flow:
                pg.pdf(path=str(out), format="A4", print_background=True, prefer_css_page_size=True,
                       display_header_footer=True, header_template="<span></span>", footer_template=footer)
            else:
                pg.pdf(path=str(out), format="A4", print_background=True, prefer_css_page_size=True)
            for pp in PdfReader(str(out)).pages:
                if flow:
                    bg = PdfReader(str(paper)).pages[0]; bg.merge_page(pp); pp = bg
                w.add_page(pp)
        b.close()
    dst = HERE / "Dremius_azbuka_sna.pdf"
    with open(dst, "wb") as fh:
        w.write(fh)
    for f in HERE.glob("_az_*"):
        f.unlink()
    print(dst)


if __name__ == "__main__":
    main()
