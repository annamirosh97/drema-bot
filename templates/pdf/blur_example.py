"""Делает публичный пример PDF: страницы памятки растрируются и размываются,
чтобы текст нельзя было ни прочитать, ни скопировать. Видны только заголовок памятки и плашка.
Запуск: python3 blur_example.py <вход.pdf> <выход.pdf>"""
import subprocess, sys, tempfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from pypdf import PdfReader, PdfWriter

SRC, DST = Path(sys.argv[1]), Path(sys.argv[2])
DPI = 110
FONT_B = "/usr/share/fonts/opentype/inter/Inter-SemiBold.otf"
FONT_R = "/usr/share/fonts/opentype/inter/Inter-Regular.otf"
SERIF = "/usr/share/fonts/truetype/google-fonts/Lora-Variable.ttf"


def memo_pages(reader):
    pages = []
    for i, p in enumerate(reader.pages):
        t = p.extract_text() or ""
        if "Памятка:" in t or (pages and i == pages[-1] + 1 and "Спокойной ночи" not in t):
            pages.append(i)
    return pages


def badge(img, first):
    d = ImageDraw.Draw(img)
    W, H = img.size
    bw, bh = int(W * 0.78), int(H * 0.15)
    x0, y0 = (W - bw) // 2, int(H * (0.42 if first else 0.40))
    d.rounded_rectangle([x0, y0, x0 + bw, y0 + bh], radius=int(bh * 0.18), fill="#1B1A3A")
    f1 = ImageFont.truetype(SERIF if Path(SERIF).exists() else FONT_B, int(H * 0.022))
    f2 = ImageFont.truetype(FONT_R, int(H * 0.0135))
    t1 = "Полная памятка — в вашем плане"
    t2 = "Спокойные занятия для последнего часа перед сном,\nкороткий вечерний ритуал и что делать,\nесли малыш капризничает"
    w1 = d.textlength(t1, font=f1)
    d.text(((W - w1) / 2, y0 + bh * 0.2), t1, font=f1, fill="#FFF6E6")
    d.multiline_text((W / 2, y0 + bh * 0.52), t2, font=f2, fill="#CFC7E8", anchor="ma", align="center", spacing=int(H * 0.005))


def main():
    reader = PdfReader(str(SRC))
    memo = memo_pages(reader)
    tmp = Path(tempfile.mkdtemp())
    writer = PdfWriter()
    for i, page in enumerate(reader.pages):
        if i not in memo:
            writer.add_page(page)
            continue
        subprocess.run(["pdftoppm", "-r", str(DPI), "-f", str(i + 1), "-l", str(i + 1), "-png", "-singlefile", str(SRC), str(tmp / f"p{i}")], check=True)
        img = Image.open(tmp / f"p{i}.png").convert("RGB")
        W, H = img.size
        first = i == memo[0]
        keep = int(H * 0.165) if first else 0          # заголовок «Часть 3 / Памятка…» остаётся читаемым
        region = img.crop((0, keep, W, H - int(H * 0.06)))  # колонтитул тоже оставляем
        region = region.filter(ImageFilter.GaussianBlur(radius=W * 0.012))
        img.paste(region, (0, keep))
        if first:
            badge(img, first)
        out = tmp / f"p{i}.pdf"
        img.save(out, "PDF", resolution=DPI)
        writer.add_page(PdfReader(str(out)).pages[0])
    with open(DST, "wb") as fh:
        writer.write(fh)
    print("размыты страницы:", [m + 1 for m in memo])


if __name__ == "__main__":
    main()
