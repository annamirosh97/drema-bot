// Рендер PDF из вёрстки: HTML → headless Chromium → три куска → склейка.
//
// Браузер не держим поднятым между заказами: рендер случается редко, а
// Chromium в простое занимает сотни мегабайт — в одном процессе с ботом
// это риск, что контейнер убьют по памяти посреди чужой анкеты. Поэтому
// запускаем на время рендера и сразу закрываем.
//
// Рендеры выстроены в очередь по той же причине: два одновременных
// Chromium удваивают пик памяти, а выигрыша во времени почти не дают —
// заказы приходят поштучно.

import { PDFDocument, rgb } from "pdf-lib";
import { chromium } from "playwright";
import { PdfContent } from "../paidPdf";
import { FOOTER_TEMPLATE, buildPdfParts } from "./template";

// Пустой заголовок обязателен: без него Chromium печатает свой, с датой
// и адресом страницы.
const EMPTY_HEADER = "<span></span>";

let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task);
  // В очереди держим только факт завершения, без результата и без
  // ошибки: иначе сбой одного рендера уронил бы следующий.
  queue = result.catch(() => undefined);
  return result;
}

export async function renderPdf(
  content: PdfContent,
  relaxationMemo: string,
  approvedAt: Date
): Promise<Buffer> {
  return enqueue(async () => {
    const parts = buildPdfParts(content, relaxationMemo, approvedAt);
    const browser = await chromium.launch();

    try {
      const page = await browser.newPage();
      const chunks: Chunk[] = [];

      for (const [name, html] of Object.entries(parts)) {
        // Шрифты вшиты в CSS как data-URI, поэтому ждать сети не нужно,
        // но дождаться их разбора обязательно — иначе первая страница
        // успевает отрендериться системным шрифтом.
        await page.setContent(html, { waitUntil: "load" });
        // Выражением строкой, а не функцией: в проекте нет типов DOM,
        // и ссылка на document не прошла бы проверку типов.
        await page.evaluate("document.fonts.ready");

        const withMargins = name === "content";
        chunks.push({
          withMargins,
          bytes: await page.pdf({
            format: "A4",
            printBackground: true,
            preferCSSPageSize: true,
            ...(withMargins
              ? {
                  margin: { top: "18mm", bottom: "18mm", left: "20mm", right: "20mm" },
                  displayHeaderFooter: true,
                  headerTemplate: EMPTY_HEADER,
                  footerTemplate: FOOTER_TEMPLATE,
                }
              : {}),
          }),
        });
      }

      return mergePdfs(chunks);
    } finally {
      await browser.close();
    }
  });
}

interface Chunk {
  bytes: Buffer;
  // Страницы с полями печатаются на белом: фон из CSS Chromium кладёт
  // только внутрь области содержания, а поля остаются бумагой принтера.
  // Такие страницы кладём поверх прямоугольника цвета --paper.
  withMargins: boolean;
}

// Цвет бумаги содержательных страниц, он же --paper в шаблоне.
const PAPER = rgb(0xff / 255, 0xf8 / 255, 0xee / 255);

async function mergePdfs(parts: Chunk[]): Promise<Buffer> {
  const merged = await PDFDocument.create();

  for (const part of parts) {
    if (!part.withMargins) {
      const source = await PDFDocument.load(part.bytes);
      const pages = await merged.copyPages(source, source.getPageIndices());
      for (const page of pages) merged.addPage(page);
      continue;
    }

    // Готовую страницу встраиваем как единый объект и рисуем поверх
    // заливки. Перекрасить её «изнутри» нельзя: содержание уже
    // нарисовано, и фон, добавленный после, лёг бы на текст.
    const source = await PDFDocument.load(part.bytes);
    const embedded = await merged.embedPdf(part.bytes, source.getPageIndices());
    for (const stamp of embedded) {
      const page = merged.addPage([stamp.width, stamp.height]);
      page.drawRectangle({ x: 0, y: 0, width: stamp.width, height: stamp.height, color: PAPER });
      page.drawPage(stamp);
    }
  }

  return Buffer.from(await merged.save());
}
