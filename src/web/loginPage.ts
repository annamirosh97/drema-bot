// Страница входа в админку.
//
// Отдельным файлом, потому что это единственная страница, доступная без
// сессии, и смешивать её с остальными — повод однажды случайно открыть
// что-то ещё.

import { html, page, raw } from "./html";

// Сообщение об ошибке одно на все случаи: «неверный логин» и «неверный
// пароль» порознь подсказывают, что логин угадан.
const WRONG = "Неверный логин или пароль.";

export function renderLoginPage(options: { failed?: boolean; next?: string } = {}): string {
  const error = options.failed ? html`<div class="banner danger">${WRONG}</div>` : "";
  const next = options.next ?? "/admin";

  const style = `
    .login { max-width: 360px; margin: 10vh auto; }
    .login label { display: block; margin-bottom: 14px; }
    .login input { width: 100%; box-sizing: border-box; }
    .login button { width: 100%; }
  `;

  return page(
    "Вход",
    html`<style>${raw(style)}</style>
      <div class="login">
        <h1>Админка Дрёмы</h1>
        ${raw(error)}
        <div class="card">
          <form method="post" action="/admin/login">
            <input type="hidden" name="next" value="${next}">
            <label>Логин<input type="text" name="login" autocomplete="username" autofocus></label>
            <label>Пароль<input type="password" name="password" autocomplete="current-password"></label>
            <button type="submit">Войти</button>
          </form>
        </div>
      </div>`
  );
}

// Вход не настроен: нет логина, хэша пароля или секрета подписи.
// Админка в таком состоянии не поднимается вовсе.
export function renderAuthNotConfigured(missing: string[]): string {
  return page(
    "Админка не настроена",
    html`<h1>Админка не настроена</h1>
      <div class="banner danger">
        Не заданы переменные окружения: ${missing.join(", ")}.
      </div>
      <div class="card">
        <p>Пока их нет, админка не открывается: открытая админка хуже недоступной.</p>
        <p class="muted">
          Хэш пароля получить командой <code>npm run admin:hash</code>, секрет подписи —
          любой случайной строкой, например <code>openssl rand -hex 32</code>.
        </p>
        <p class="muted">Бот при этом работает как обычно.</p>
      </div>`
  );
}
