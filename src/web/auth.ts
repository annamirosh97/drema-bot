// Вход в админку.
//
// Было: HTTP basic auth с паролем в открытом виде в переменной
// окружения. У него три беды, и все три ТЗ требует закрыть. Браузер
// кэширует введённые данные до закрытия окна и шлёт их при каждом
// запросе; выйти нельзя вообще; срок сессии задать невозможно, а ТЗ
// требует истечения через 12 часов бездействия.
//
// Стало: форма входа, пароль хранится хэшем, сессия — подписанная
// cookie с временем последней активности внутри.
//
// Сессии нарочно не в базе. Админ один, сервер один, и состояние,
// которое незачем хранить, лучше не хранить: подписанная cookie
// проверяется без обращения к базе и не оставляет мусора после
// деплоя. Цена — после смены ADMIN_SESSION_SECRET все входы
// сбрасываются, что как раз и нужно.
//
// Новых зависимостей нет: хэш и подпись — на штатном crypto.
//
// TOTP и роли ТЗ требует, но по решению от 20.10.2026 они отложены.
// Места, где они появятся, помечены ниже.

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { env } from "../env";

const COOKIE = "drema_admin";
// Срок бездействия из ТЗ. Каждый запрос продлевает сессию.
const IDLE_MS = 12 * 3_600_000;

// ── Пароль ──────────────────────────────────────────────────────────

// Хэш в формате «scrypt$соль$ключ», оба в hex. Генерируется командой
// `npm run admin:hash` (scripts/admin-password-hash.ts) и кладётся в
// ADMIN_PASSWORD_HASH.
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

// Сравнение в постоянное время: иначе по времени ответа можно
// подбирать пароль побайтово.
function passwordMatches(password: string, stored: string): boolean {
  const [scheme, saltHex, keyHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !keyHex) return false;
  try {
    const expected = Buffer.from(keyHex, "hex");
    const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// ── Cookie сессии ───────────────────────────────────────────────────

// Содержимое: логин и время последней активности. Подпись не даёт
// подделать ни то, ни другое.
interface SessionData {
  login: string;
  seenAt: number;
}

function sign(payload: string): string {
  return createHmac("sha256", env.ADMIN_SESSION_SECRET).update(payload).digest("hex");
}

function pack(data: SessionData): string {
  const payload = Buffer.from(JSON.stringify(data), "utf8").toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function unpack(cookie: string): SessionData | null {
  const [payload, signature] = cookie.split(".");
  if (!payload || !signature) return null;

  const expected = sign(payload);
  // Подпись сравниваем тоже в постоянное время.
  if (
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return null;
  }

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionData;
    return typeof data?.login === "string" && typeof data?.seenAt === "number" ? data : null;
  } catch {
    return null;
  }
}

// Express 5 читает cookie сам только с парсером, которого в проекте
// нет. Нужна ровно одна cookie, и разобрать заголовок проще, чем
// тащить зависимость.
function readCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=");
  }
  return null;
}

function setCookie(res: Response, data: SessionData) {
  const flags = [
    `${COOKIE}=${pack(data)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(IDLE_MS / 1000)}`,
  ];
  // Secure только по HTTPS: с ним cookie не доедет до localhost, и
  // админку нельзя будет отладить локально.
  if (env.ADMIN_HTTPS_ONLY) flags.push("Secure");
  res.setHeader("Set-Cookie", flags.join("; "));
}

function clearCookie(res: Response) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// ── Проверка на каждом запросе ──────────────────────────────────────

// Кто вошёл. Дальше пригодится ролям: пока роль у всех одна.
export interface AdminIdentity {
  login: string;
}

declare module "express-serve-static-core" {
  interface Request {
    admin?: AdminIdentity;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const cookie = readCookie(req);
  const data = cookie ? unpack(cookie) : null;

  if (!data || Date.now() - data.seenAt > IDLE_MS) {
    if (data) clearCookie(res);
    // Куда вернуться после входа. Берём только путь: открытый
    // редирект на чужой адрес из параметра — классическая дыра.
    const back = encodeURIComponent(req.originalUrl.startsWith("/") ? req.originalUrl : "/admin");
    return res.redirect(`/admin/login?next=${back}`);
  }

  // Продлеваем: срок считается от последней активности, а не от входа.
  setCookie(res, { login: data.login, seenAt: Date.now() });
  req.admin = { login: data.login };
  next();
}

// ── Форма входа ─────────────────────────────────────────────────────

export function checkCredentials(login: string, password: string): boolean {
  if (!env.ADMIN_LOGIN || !env.ADMIN_PASSWORD_HASH) return false;
  // Логин сравниваем обычным равенством: он не секрет.
  if (login !== env.ADMIN_LOGIN) return false;
  return passwordMatches(password, env.ADMIN_PASSWORD_HASH);
  // Здесь появится второй шаг с кодом TOTP, когда его включат.
}

export function startSession(res: Response, login: string) {
  setCookie(res, { login, seenAt: Date.now() });
}

export function endSession(res: Response) {
  clearCookie(res);
}

// Настроен ли вход вообще. Без логина и хэша админка не поднимается:
// открытая админка хуже недоступной.
export function authConfigured(): boolean {
  return Boolean(env.ADMIN_LOGIN && env.ADMIN_PASSWORD_HASH && env.ADMIN_SESSION_SECRET);
}
