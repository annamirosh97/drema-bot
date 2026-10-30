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

// Версии, опубликованные на сайте. Новая версия документа — новая
// строка здесь и новый файл legal/<папка>/<версия>.md рядом.
//
// Дата вступления взята из самого документа: на странице каждого стоит
// «редакция от …», и эта же дата в номере версии. Если документ выложен
// на сайт позже своей редакции, поправь здесь дату выкладки — строка в
// базе заводится один раз, по первому старту с этой версией.
//
// Версии-заглушки draft-1 в этой таблице больше нет, и бот её не
// трогает: строки заглушек остаются в базе как были, потому что на них
// ссылаются записи журнала, сделанные до публикации.
const VERSIONS: Record<LegalDocType, { version: string; effectiveFrom: string }> = {
  PRIVACY_POLICY: { version: "2026-10-22", effectiveFrom: "2026-10-22" },
  PD_CONSENT: { version: "2026-10-26", effectiveFrom: "2026-10-26" },
  MARKETING_CONSENT: { version: "2026-10-26", effectiveFrom: "2026-10-26" },
  OFFER: { version: "2026-10-26", effectiveFrom: "2026-10-26" },
};

// Папка документа и переменная окружения с его адресом. Имя переменной
// нужно в сообщении об ошибке: «не задан адрес» без него заставляет
// лезть в код посреди упавшего деплоя.
const DOCUMENTS: Record<LegalDocType, { folder: string; variable: string; url: () => string }> = {
  PRIVACY_POLICY: {
    folder: "privacy-policy",
    variable: "PRIVACY_POLICY_URL",
    url: () => env.PRIVACY_POLICY_URL,
  },
  PD_CONSENT: { folder: "pd-consent", variable: "PD_CONSENT_URL", url: () => env.PD_CONSENT_URL },
  MARKETING_CONSENT: {
    folder: "marketing-consent",
    variable: "MARKETING_CONSENT_URL",
    url: () => env.MARKETING_CONSENT_URL,
  },
  OFFER: { folder: "offer", variable: "OFFER_URL", url: () => env.OFFER_URL },
};

export function legalFilePath(type: LegalDocType, version: string): string {
  return join(PROJECT_ROOT, "legal", DOCUMENTS[type].folder, `${version}.md`);
}

function hashOf(type: LegalDocType, version: string): string {
  const path = legalFilePath(type, version);
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch (error) {
    throw new Error(
      `Нет файла с текстом документа ${type} версии ${version}: ожидаю ${path}. ` +
        `Без текста нечего хэшировать, а запись журнала без хэша бесполезна.`
    );
  }
}

// Активная версия типа — последняя по effectiveFrom. Держим в памяти:
// документы меняются раз в месяцы, а спрашиваем мы их на каждое согласие.
const active = new Map<LegalDocType, LegalDocument>();

// Заводит строки опубликованных версий, если их ещё нет, и запоминает
// активные. Вызывается один раз при старте: без документов записать
// согласие нельзя, поэтому ошибка здесь должна уронить запуск, а не
// всплыть посреди онбординга у живого человека.
//
// Строка версии создаётся один раз и больше не меняется. Это главное
// правило этого файла: адрес и хэш, записанные в строке, — то, на что
// человек соглашался, и перезапись превратила бы журнал в набор ссылок
// на другой текст. Переехал адрес или поправился текст — это новая
// версия, а не правка старой строки.
export async function loadLegalDocuments(): Promise<void> {
  for (const type of Object.keys(DOCUMENTS) as LegalDocType[]) {
    const { version, effectiveFrom } = VERSIONS[type];
    const url = DOCUMENTS[type].url();
    if (!url) {
      throw new Error(
        `Не задан адрес документа ${type}: переменная ${DOCUMENTS[type].variable}. ` +
          `Записать согласие без ссылки на документ нельзя — задай переменную и перезапусти.`
      );
    }
    const sha256 = hashOf(type, version);

    const existing = await prisma.legalDocument.findUnique({
      where: { type_version: { type, version } },
    });

    if (!existing) {
      await prisma.legalDocument.create({
        data: { type, version, url, sha256, effectiveFrom: new Date(effectiveFrom) },
      });
    } else if (existing.sha256 !== sha256 || existing.url !== url) {
      // Не падаем и не переписываем: бот работает, а строка остаётся
      // той, на которую ссылаются записи. Но сказать об этом нужно
      // громко — расхождение означает, что документ изменили, не
      // заведя новую версию.
      console.error(
        `Документ ${type} версии ${version} в базе не совпадает с тем, что в репозитории и в ` +
          `переменных: ${existing.url !== url ? "разный адрес" : "разный текст"}. ` +
          `Строку не меняю — заведи новую версию.`
      );
    }

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
