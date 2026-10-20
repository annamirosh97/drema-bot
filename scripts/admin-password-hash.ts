// Хэш пароля для входа в админку.
//
// Запуск: npm run admin:hash
//
// Пароль спрашивается в терминале и не попадает ни в историю команд,
// ни в аргументы процесса — иначе он остался бы в ~/.zsh_history и в
// выводе ps у всех, кто есть на машине. В терминале он при этом видим:
// скрытый ввод через readline делается хаками по сырому режиму, и ради
// команды, которую запускают раз в полгода, оно не стоит риска
// оставить терминал в сломанном состоянии.
//
// Готовую строку положить в ADMIN_PASSWORD_HASH. Сам пароль нигде не
// хранится: проверить его можно только входом.

import { createInterface } from "readline";
import { randomBytes, scryptSync } from "crypto";

// Дублирует hashPassword из src/web/auth.ts намеренно: скрипт лежит вне
// rootDir и не собирается вместе с ботом, а импорт из dist требовал бы
// сборки перед сменой пароля.
//
// ВАЖНО: формат должен совпадать с тем, что читает auth.ts. Если
// меняется здесь — менять и там.
function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

const MIN_LENGTH = 12;

// Читаем построчно из потока, а не двумя вызовами question. Второй
// вызов не работает, когда ввод идёт из конвейера: readline успевает
// прочитать обе строки до того, как задан второй вопрос, и ответ
// теряется. Через поток скрипт одинаково ведёт себя в терминале и в
// проверке вроде `printf 'pass\npass\n' | npm run admin:hash`.
async function main() {
  const rl = createInterface({ input: process.stdin });
  const answers: string[] = [];

  process.stdout.write("Пароль для админки: ");

  for await (const line of rl) {
    answers.push(line.trim());
    if (answers.length === 1) process.stdout.write("Повторите пароль: ");
    if (answers.length === 2) break;
  }
  rl.close();

  const [password, again] = answers;

  if (!password) {
    console.error("\nПароль не введён.");
    process.exit(1);
  }

  if (password.length < MIN_LENGTH) {
    console.error(
      `\nПароль короче ${MIN_LENGTH} символов. Админка открывает переписку с ` +
        "родителями и их ответы о детях — пароль стоит сделать длинным."
    );
    process.exit(1);
  }

  if (again !== password) {
    console.error("\nПароли не совпали.");
    process.exit(1);
  }

  console.log("\nПоложите это в переменную ADMIN_PASSWORD_HASH:\n");
  console.log(hashPassword(password));
  console.log(
    "\nИ не забудьте ADMIN_LOGIN и ADMIN_SESSION_SECRET " +
      "(случайная строка, например openssl rand -hex 32)."
  );
}

main();
