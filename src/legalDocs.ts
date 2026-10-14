// Версии юридических документов.
//
// Текст каждого документа лежит в репозитории, в legal/<тип>/<версия>.md,
// а в базе — строка с его адресом и хэшем. Так по записи журнала,
// сделанной полгода назад, видно не только «человек согласился», но и с
// каким именно текстом: файл той версии никуда не делся, и хэш сходится.
//
// Новая версия документа — новый файл рядом и новая строка в базе.
// Старые не трогаются никогда: на них ссылаются уже сделанные записи.

import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import type { LegalDocType, LegalDocument } from "@prisma/client";
import { prisma } from "./prisma";
import { env } from "./env";
import { PROJECT_ROOT } from "./prompts";

// Версия-заглушка, которая заводится, пока юрист не прислал тексты.
const DRAFT_VERSION = "draft-1";

// Папка документа и переменная окружения с его адресом.
const DOCUMENTS: Record<LegalDocType, { folder: string; url: () => string }> = {
  PRIVACY_POLICY: { folder: "privacy-policy", url: () => env.PRIVACY_POLICY_URL },
  PD_CONSENT: { folder: "pd-consent", url: () => env.PD_CONSENT_URL },
  MARKETING_CONSENT: { folder: "marketing-consent", url: () => env.MARKETING_CONSENT_URL },
  OFFER: { folder: "offer", url: () => env.OFFER_URL },
};

export function legalFilePath(type: LegalDocType, version: string): string {
  return join(PROJECT_ROOT, "legal", DOCUMENTS[type].folder, `${version}.md`);
}

function hashOf(type: LegalDocType, version: string): string {
  return createHash("sha256").update(readFileSync(legalFilePath(type, version))).digest("hex");
}

// Активная версия типа — последняя по effectiveFrom. Держим в памяти:
// документы меняются раз в месяцы, а спрашиваем мы их на каждое согласие.
const active = new Map<LegalDocType, LegalDocument>();

// Заводит версии-заглушки, если их ещё нет, и запоминает активные.
// Вызывается один раз при старте: без документов записать согласие
// нельзя, поэтому ошибка здесь должна уронить запуск, а не всплыть
// посреди онбординга у живого человека.
export async function loadLegalDocuments(): Promise<void> {
  for (const type of Object.keys(DOCUMENTS) as LegalDocType[]) {
    const sha256 = hashOf(type, DRAFT_VERSION);
    const url = DOCUMENTS[type].url();

    // Адрес и хэш обновляем: пока это заглушка, адрес может переехать
    // вместе с доменом, а текст — поправиться. Как только появится
    // настоящая версия, заглушку перестанут показывать, и трогать её
    // будет уже нечего.
    await prisma.legalDocument.upsert({
      where: { type_version: { type, version: DRAFT_VERSION } },
      update: { url, sha256 },
      create: { type, version: DRAFT_VERSION, url, sha256, effectiveFrom: new Date("2026-01-01") },
    });

    const latest = await prisma.legalDocument.findFirst({
      where: { type },
      orderBy: { effectiveFrom: "desc" },
    });
    if (!latest) throw new Error(`Не удалось завести версию документа ${type}.`);
    active.set(type, latest);
  }

  const versions = [...active.values()].map((d) => `${d.type}=${d.version}`).join(", ");
  console.log(`Юридические документы загружены: ${versions}`);
}

// Активная версия. Бросает, если документы не загружены: записать
// согласие без ссылки на документ нельзя, и молча подставлять null
// здесь хуже, чем упасть.
export function activeDocument(type: LegalDocType): LegalDocument {
  const document = active.get(type);
  if (!document) {
    throw new Error(`Версия документа ${type} не загружена — вызови loadLegalDocuments() при старте.`);
  }
  return document;
}

export function activeDocumentIds(...types: LegalDocType[]): number[] {
  return types.map((type) => activeDocument(type).id);
}

export function documentUrl(type: LegalDocType): string {
  return activeDocument(type).url;
}

// Текст версии — для страниц-заглушек и будущей выгрузки в админке.
export function readLegalText(type: LegalDocType, version: string): string {
  return readFileSync(legalFilePath(type, version), "utf8");
}
