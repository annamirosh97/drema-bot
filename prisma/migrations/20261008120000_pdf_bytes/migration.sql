-- AlterTable
-- Готовый PDF хранится рядом с черновиком: отправить повторно нужно
-- уметь без повторного рендера.
ALTER TABLE "PdfDraft" ADD COLUMN "pdfBytes" BYTEA;
