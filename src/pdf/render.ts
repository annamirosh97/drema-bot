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

import { PDFDocument } from "pdf-lib";
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
      const chunks: Buffer[] = [];

      for (const [name, html] of Object.entries(parts)) {
        // Шрифты вшиты в CSS как data-URI, поэтому ждать сети не нужно,
        // но дождаться их разбора обязательно — иначе первая страница
        // успевает отрендериться системным шрифтом.
        await page.setContent(html, { waitUntil: "load" });
        // Выражением строкой, а не функцией: в проекте нет типов DOM,
        // и ссылка на document не прошла бы проверку типов.
        await page.evaluate("document.fonts.ready");

        const withMargins = name === "content";
        chunks.push(
          await page.pdf({
            format: "A4",
            printBackground: true,
            preferCSSPageSize: true,
            ...(withMargins
              ? {
                  margin: { top: "20mm", bottom: "18mm", left: "20mm", right: "20mm" },
                  displayHeaderFooter: true,
                  headerTemplate: EMPTY_HEADER,
                  footerTemplate: FOOTER_TEMPLATE,
                }
              : {}),
          })
        );
      }

      return mergePdfs(chunks);
    } finally {
      await browser.close();
    }
  });
}

async function mergePdfs(parts: Buffer[]): Promise<Buffer> {
  const merged = await PDFDocument.create();

  for (const part of parts) {
    const source = await PDFDocument.load(part);
    const pages = await merged.copyPages(source, source.getPageIndices());
    for (const page of pages) merged.addPage(page);
  }

  return Buffer.from(await merged.save());
}
