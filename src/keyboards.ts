import { InlineKeyboard } from "grammy";

// Одна кнопка на строку — так же, как было сделано в Make.
// callback_data = сам текст варианта (варианты в анкете короткие,
// лимит Telegram в 64 байта не превышается).
export function singleChoiceKeyboard(options: string[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const option of options) {
    kb.text(option, option).row();
  }
  return kb;
}

// Для multi_choice: у уже выбранных вариантов спереди галочка ✅.
// "Готово" никогда не помечается галочкой.
export function multiChoiceKeyboard(options: string[], selected: string[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const option of options) {
    const isDone = option === "Готово";
    const label = !isDone && selected.includes(option) ? `✅ ${option}` : option;
    kb.text(label, option).row();
  }
  return kb;
}

export function csatKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (let i = 1; i <= 5; i++) {
    kb.text(String(i), `csat_${i}`);
  }
  return kb;
}

export function fakeDoorKeyboard(price: number): InlineKeyboard {
  return new InlineKeyboard()
    .text(`Оплатить ${price} ₽`, "fakedoor_pay")
    .row()
    .text("Не сейчас", "fakedoor_skip");
}
