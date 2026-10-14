import { InlineKeyboard, Keyboard } from "grammy";

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

// ── Согласия в онбординге ───────────────────────────────────────────
//
// Подписи кнопок уходят в журнал как есть: по записи должно быть видно,
// на что именно нажал человек. Менять их — значит менять то, что увидит
// проверяющая сторона в старых записях, поэтому они вынесены в
// константы и берутся отсюда и кодом, и журналом.

export const PD_CONSENT_YES = "Даю согласие";
export const PD_CONSENT_NO = "Не сейчас";
export const MARKETING_YES = "Да, присылайте";
export const MARKETING_NO = "Нет, спасибо";

export function pdConsentKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(PD_CONSENT_YES, "pd_consent_yes")
    .row()
    .text(PD_CONSENT_NO, "pd_consent_no");
}

export function marketingConsentKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(MARKETING_YES, "marketing_yes")
    .row()
    .text(MARKETING_NO, "marketing_no");
}

// Экран итоговой анкеты в конце: подтвердить или пойти править ответы.
export function summaryKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Всё верно, подтверждаю", "summary_confirm")
    .row()
    .text("Внести изменения", "summary_edit");
}

// «Хотите поправить что-то ещё?» после правки одного ответа.
export function editMoreKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Да, поправить ещё", "edit_more_yes")
    .row()
    .text("Нет, это всё", "edit_more_no");
}

export function csatKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (let i = 1; i <= 5; i++) {
    kb.text(String(i), `csat_${i}`);
  }
  return kb;
}

// ── Оффер: выбор формата и карточки продуктов ───────────────────────
//
// Все callback_data начинаются с offer_ — такие нажатия разбираются до
// стадий сессии (см. handleIncoming), чтобы кнопки под старыми
// сообщениями в истории чата не умирали.

// Сообщение «Выбор»: два продукта и отказ.
export function offerChoiceKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📄 Подробнее о плане", "offer_pdf_details")
    .row()
    .text("💬 Подробнее о консультации", "offer_consult_details")
    .row()
    .text("Пока не нужно", "offer_decline");
}

// Карточка плана. Подменяет текст сообщения «Выбор», поэтому «← Назад»
// возвращает его на место.
export function offerPdfCardKeyboard(price: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(`Купить за ${price} ₽`, "offer_buy")
    .row()
    .text("Посмотреть пример плана", "offer_example")
    .row()
    .text("← Назад", "offer_back");
}

// Карточка консультации. Имени специалиста на кнопке нет намеренно:
// оно живёт в тексте карточки, а кнопка остаётся про формат услуги.
export function offerConsultCardKeyboard(price: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(`Записаться за ${price} ₽`, "offer_consult_signup")
    .row()
    .text("← Назад", "offer_back");
}

// ── Предложение консультации после покупки плана ────────────────────
//
// Свой префикс upsell_, и эти нажатия тоже разбираются до стадий: к
// моменту, когда предложение приходит, родитель обычно уже прошёл CSAT
// и находится в стадии, где кнопок никто не ждёт.

export function upsellOfferKeyboard(price: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("Подробнее о консультации", "upsell_details")
    .row()
    .text(`Записаться за ${price} ₽`, "upsell_signup")
    .row()
    .text("Пока не нужно", "upsell_decline");
}

export function upsellCardKeyboard(price: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(`Записаться за ${price} ₽`, "upsell_signup")
    .row()
    .text("← Назад", "upsell_back");
}

// Скидка кончилась — записаться можно, но уже по обычной цене. Кнопка
// намеренно ведёт в тот же обработчик, что и основной оффер: это и есть
// обычная запись, дублировать её незачем.
export function upsellExpiredKeyboard(fullPrice: string): InlineKeyboard {
  return new InlineKeyboard().text(`Записаться за ${fullPrice} ₽`, "offer_consult_signup");
}

// Сообщение вслед за примером плана: только кнопка покупки.
export function exampleFollowupKeyboard(price: string): InlineKeyboard {
  return new InlineKeyboard().text(`Купить за ${price} ₽`, "offer_buy");
}

// Согласие на передачу контакта специалисту. Это reply-клавиатура, а не
// inline: иначе Telegram не даст кнопку, которая присылает контакт.
// Нажатие на вторую кнопку приходит обычным текстовым сообщением с её
// подписью — поэтому подпись вынесена в константу и сверяется с текстом.
export const CONSULT_SELF_WRITE_BUTTON = "Я напишу специалисту сам(а)";

export function consultConsentKeyboard(): Keyboard {
  return new Keyboard()
    .requestContact("Поделиться контактом")
    .row()
    .text(CONSULT_SELF_WRITE_BUTTON)
    .resized()
    .oneTime();
}
