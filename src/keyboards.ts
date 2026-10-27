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

// ── Приветствие ─────────────────────────────────────────────────────
//
// Два шага: первое сообщение знакомит и ведёт ко второму, второе
// отвечает «что вы получите» и уже предлагает начать.

export function welcomeKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("Что я получу?", "welcome_value");
}

export function welcomeValueKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("Начать", "start").row().text("Как я работаю", "how_it_works");
}

// ── Меню (/menu) ────────────────────────────────────────────────────

// Кнопки по одной в строке: подписи длинные, и в два столбца Telegram
// обрезал бы их на узком экране.
//
// Пятая кнопка — возврат к анкете — появляется только посреди анкеты.
// Решает это движок: он один знает, есть ли вопрос, к которому можно
// вернуться.
export function menuKeyboard(withBack = false): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text("Начать бот заново", "menu_restart")
    .row()
    .text("Поддержка", "menu_support")
    .row()
    .text("Документы", "menu_docs")
    .row()
    .text("Команда Дрёмиуса", "menu_team");

  return withBack ? keyboard.row().text(BACK_TO_QUIZ, "menu_back") : keyboard;
}

export const RESTART_YES = "Да, начать заново";
export const RESTART_NO = "Нет, вернуться";

export function restartConfirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(RESTART_YES, "restart_yes")
    .row()
    .text(RESTART_NO, "restart_no");
}

// Подпись одна на две клавиатуры: эта кнопка встаёт и отдельно, и
// рядом со ссылкой в поддержку. Константой — чтобы не разъехались.
export const BACK_TO_QUIZ = "Вернуться к анкете";

// Возврат к прерванному шагу. Появляется только у тех, от кого бот
// чего-то ждёт: человеку, который всё прошёл, возвращаться некуда.
export function backToQuizKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text(BACK_TO_QUIZ, "menu_back");
}

// Кнопка-ссылка в бот поддержки. Параметр src_menu доезжает до карточки
// обращения: по нему видно, что человек пришёл из меню.
//
// Возврат к анкете кладём в ту же клавиатуру, а не отдельным
// сообщением: двух клавиатур на одном сообщении Telegram не покажет, а
// лишнее сообщение ради одной кнопки — шум.
export function supportLinkKeyboard(botUsername: string, withBack = false): InlineKeyboard {
  const keyboard = new InlineKeyboard().url(
    "Написать в поддержку",
    `https://t.me/${botUsername}?start=src_menu`
  );
  return withBack ? keyboard.row().text(BACK_TO_QUIZ, "menu_back") : keyboard;
}

// ── Напоминания о незаконченной анкете ──────────────────────────────

export const QUIZ_CONTINUE = "Продолжить анкету";

// Первое напоминание: одна кнопка.
export function quizReminder1Keyboard(): InlineKeyboard {
  return new InlineKeyboard().text(QUIZ_CONTINUE, "quiz_continue");
}

// Второе: плюс ссылка в поддержку, если бот поддержки задан. Параметр
// src_quiz_reminder доезжает до карточки обращения — по нему видно, что
// человек пришёл из напоминания, а не из меню.
export function quizReminder2Keyboard(botUsername: string): InlineKeyboard {
  const keyboard = new InlineKeyboard().text(QUIZ_CONTINUE, "quiz_continue");
  if (!botUsername) return keyboard;
  return keyboard
    .row()
    .url("Написать в поддержку", `https://t.me/${botUsername}?start=src_quiz_reminder`);
}

// ── Управление согласиями (/data) ───────────────────────────────────
//
// Подписи кнопок уходят в журнал как есть, поэтому живут константами.

export const DATA_UNSUBSCRIBE = "Отписаться от рассылки";
export const DATA_SUBSCRIBE = "Подписаться на рассылку";
export const DATA_REVOKE_PD = "Отозвать согласие на обработку данных";
export const DATA_REVOKE_YES = "Да, отозвать";
export const DATA_REVOKE_NO = "Отмена";

// Показываем только применимые кнопки: подписанному незачем видеть
// «подписаться», а тому, кто уже отозвал согласие, — «отозвать».
export function dataKeyboard(options: {
  canSubscribe: boolean;
  canUnsubscribe: boolean;
  canRevokePd: boolean;
}): InlineKeyboard | undefined {
  const kb = new InlineKeyboard();
  let empty = true;

  if (options.canUnsubscribe) {
    kb.text(DATA_UNSUBSCRIBE, "data_unsubscribe").row();
    empty = false;
  }
  if (options.canSubscribe) {
    kb.text(DATA_SUBSCRIBE, "data_subscribe").row();
    empty = false;
  }
  if (options.canRevokePd) {
    kb.text(DATA_REVOKE_PD, "data_revoke_pd").row();
    empty = false;
  }

  return empty ? undefined : kb;
}

export function pdRevokeConfirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(DATA_REVOKE_YES, "data_revoke_yes")
    .row()
    .text(DATA_REVOKE_NO, "data_revoke_no");
}

export const HEALTH_OK = "Ничего из этого";
export const HEALTH_STOP = "Есть что-то из списка";

export function healthScreenKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(HEALTH_OK, "health_ok")
    .row()
    .text(HEALTH_STOP, "health_stop");
}

// Единственная кнопка в ветке «не подходит». Ни офферов, ни покупок
// здесь нет и быть не должно: человеку только что сказали, что разбор
// подготовить не получится.
export function healthGuideKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("Прислать гайд", "health_guide");
}

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

// ── Отложенные вопросы обратной связи ───────────────────────────────
//
// Подписи кнопок уходят в журнал событий и в админку, поэтому живут
// константами: по ним потом собирается статистика.

export const ANALYSIS_RATINGS = [
  { label: "Да, очень похоже", data: "afb_yes" },
  { label: "Отчасти", data: "afb_partly" },
  { label: "Не совсем", data: "afb_no" },
] as const;

export const PDF_RESULTS = [
  { label: "Стало лучше", data: "pfb_better" },
  { label: "Без изменений", data: "pfb_same" },
  { label: "Стало хуже", data: "pfb_worse" },
  { label: "Пока не начали", data: "pfb_not_started" },
] as const;

export const FEEDBACK_SKIP = "Пропустить";

// По одной в строке: варианты длинные, в ряд не помещаются.
export function analysisFeedbackKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const r of ANALYSIS_RATINGS) kb.text(r.label, r.data).row();
  return kb;
}

// В два ряда по две: подписи короткие, и так их видно целиком.
export function pdfResultKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(PDF_RESULTS[0].label, PDF_RESULTS[0].data)
    .text(PDF_RESULTS[1].label, PDF_RESULTS[1].data)
    .row()
    .text(PDF_RESULTS[2].label, PDF_RESULTS[2].data)
    .text(PDF_RESULTS[3].label, PDF_RESULTS[3].data);
}

export function feedbackSkipKeyboard(kind: "afb" | "pfb"): InlineKeyboard {
  return new InlineKeyboard().text(FEEDBACK_SKIP, `${kind}_skip`);
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
    .text("💬 Подробнее о консультации", "upsell_details")
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
