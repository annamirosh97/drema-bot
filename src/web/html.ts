// Сборка HTML для веб-админки. Шаблонизатора нет намеренно: страниц
// две, и обычных шаблонных строк для них достаточно.
//
// ГЛАВНОЕ ПРАВИЛО: всё, что пришло от пользователя или от модели,
// проходит через escape(). Ответы анкеты родители пишут свободным
// текстом, и одной угловой скобки хватит, чтобы сломать вёрстку.

export function escape(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Тег-функция: всё подставляемое экранируется само. Готовый HTML,
// собранный этими же функциями, оборачивается в raw().
export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, str, i) => {
    if (i === 0) return str;
    const value = values[i - 1];
    const rendered = Array.isArray(value)
      ? value.map((v) => (isRaw(v) ? v.value : escape(v))).join("")
      : isRaw(value)
        ? value.value
        : escape(value);
    return acc + rendered + str;
  }, "");
}

interface Raw {
  __raw: true;
  value: string;
}

function isRaw(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && (value as Raw).__raw === true;
}

export function raw(value: string): Raw {
  return { __raw: true, value };
}

const STYLES = `
  :root {
    --bg: #FBF4E8; --card: #fff; --ink: #1B1A3A; --muted: #6b6a85;
    --line: #e4ddd0; --accent: #8C7BB8; --warn: #F3C99A; --danger: #E3A598;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px; background: var(--bg); color: var(--ink);
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  a { color: var(--accent); }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 0 0 10px; }
  .muted { color: var(--muted); font-size: 13px; }
  .wrap { max-width: 1500px; margin: 0 auto; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; align-items: start; }
  @media (max-width: 1100px) { .cols { grid-template-columns: 1fr; } }
  .card {
    background: var(--card); border: 1px solid var(--line); border-radius: 10px;
    padding: 16px; margin-bottom: 16px;
  }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); }
  th { font-size: 13px; color: var(--muted); font-weight: 600; }
  tr:last-child td { border-bottom: none; }
  details { border-bottom: 1px solid var(--line); padding: 10px 0; }
  details:last-of-type { border-bottom: none; }
  summary { cursor: pointer; font-weight: 600; }
  pre {
    white-space: pre-wrap; word-wrap: break-word; margin: 10px 0 0;
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  textarea, input[type="text"] {
    width: 100%; padding: 8px 10px; border: 1px solid var(--line);
    border-radius: 6px; font: inherit; background: #fff; color: inherit;
  }
  textarea { resize: vertical; }
  button, .btn {
    font: inherit; padding: 9px 16px; border-radius: 6px; cursor: pointer;
    border: 1px solid var(--accent); background: var(--accent); color: #fff;
    text-decoration: none; display: inline-block;
  }
  button.secondary, .btn.secondary { background: #fff; color: var(--accent); }
  button:disabled { opacity: .45; cursor: not-allowed; }
  .notes { background: #FFF6E6; border-color: var(--warn); }
  .row-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
  .pill { padding: 2px 9px; border-radius: 99px; font-size: 12px; background: #efeaf7; }
  .pill.warn { background: var(--warn); }
  .pill.danger { background: var(--danger); color: #fff; }
  .schedule-row { display: grid; grid-template-columns: 90px 1fr 110px 32px; gap: 8px; margin-bottom: 6px; }
  /* Фиксированный блок под таблицей режима. Оформление как .sdisc в
     прототипе PDF: мелкий приглушённый текст на кремовом фоне. */
  .sdisc {
    margin-top: 14px; padding: 12px 16px; border-radius: 8px;
    background: var(--bg); border: 1px solid #efe6d6;
    font-size: 13px; line-height: 1.5; color: var(--muted);
  }
  .banner { padding: 10px 14px; border-radius: 8px; margin-bottom: 16px; background: #e8f3e8; }
  .banner.warn { background: #FFF6E6; }
`;

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · Дрёма</title>
<style>${STYLES}</style>
</head>
<body><div class="wrap">${body}</div></body>
</html>`;
}
