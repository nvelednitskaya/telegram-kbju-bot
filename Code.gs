// ================== НАСТРОЙКИ ==================
// Заполни свои значения. НИКОГДА не коммить этот файл с реальными токенами!
const BOT_TOKEN  = 'ВСТАВЬ_ТОКЕН_БОТА';        // от @BotFather, вида 123456789:AA...
const GEMINI_KEY = 'ВСТАВЬ_КЛЮЧ_GEMINI';       // из Google AI Studio, вида AIzaSy...
const SHEET_ID   = 'ВСТАВЬ_ID_ТАБЛИЦЫ';        // из URL таблицы, между /d/ и /edit
const TOPIC_ID   = 0;                          // ID темы форум-чата, где живёт бот (число)
const CHAT_ID    = 0;                          // ID группового чата (отрицательное число)
const TZ         = 'Europe/Belgrade';          // ваш часовой пояс (для дат записей)

const TG_API   = 'https://api.telegram.org/bot' + BOT_TOKEN;
const TG_FILES = 'https://api.telegram.org/file/bot' + BOT_TOKEN + '/';

// ============ ПРИЁМ СООБЩЕНИЙ ============
function doPost(e) {
  try {
    const update = JSON.parse(e.postData.contents);
    const msg = update.message;
    if (!msg) return;
    if (msg.message_thread_id !== TOPIC_ID) return;   // бот работает только в своей теме

    const cache = CacheService.getScriptCache();

    // Защита от дублей: Telegram повторяет доставку при медленном ответе
    const dupKey = 'u_' + update.update_id;
    if (cache.get(dupKey)) return;
    cache.put(dupKey, '1', 21600);

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text   = msg.text || msg.caption || '';
    const hasPhoto = !!msg.photo;
    if (!text && !hasPhoto) return;

    const msgFileId = hasPhoto ? msg.photo[msg.photo.length - 1].file_id : null;

    // ---- Реплай со словом «вчера»: единый смысл — «эта еда должна быть во вчера» ----
    if (msg.reply_to_message && /^вчера[.!]?$/i.test(text.trim())) {
      const r = msg.reply_to_message;
      if (r.from && r.from.is_bot) {
        // Реплай на ✅-сообщение бота → ищем запись по колонке J
        if (!moveToYesterday(chatId, userId, r.message_id, 9)) {
          sendMessage(chatId, 'Не нашла эту запись. Удали её строку в таблице руками и внеси через /вчера');
        }
      } else if (r.from && r.from.id === userId) {
        // Реплай на СВОЁ сообщение → сначала ищем, не записана ли эта еда уже (колонка K)
        if (moveToYesterday(chatId, userId, r.message_id, 10)) return;
        // Не записана → вносим во вчера
        const rText = r.text || r.caption || '';
        const rFile = r.photo ? r.photo[r.photo.length - 1].file_id : null;
        if (!rText && !rFile) { sendMessage(chatId, 'В том сообщении не вижу еды 🤔'); return; }
        handleMeal(chatId, userId, rText, rFile, true, r.message_id);
      } else {
        sendMessage(chatId, 'Могу перенести только свою запись или твоё сообщение с едой');
      }
      return;
    }

    // ---- Команды ----
    if (text.startsWith('/')) {
      const firstTok = text.trim().split(/\s+/)[0].split('@')[0].toLowerCase();
      if (firstTok === '/вчера' || firstTok === '/yesterday') {
        const rest = text.trim().replace(/^\S+\s*/, '');
        if (!rest && !msgFileId) {
          sendMessage(chatId, 'Формат: /вчера гречка с курицей 300 г — или фото с такой подписью');
          return;
        }
        handleMeal(chatId, userId, rest, msgFileId, true, msg.message_id);
        return;
      }
      handleCommand(chatId, userId, text);
      return;
    }

    // ---- Анкета расчёта нормы (если запущена) ----
    if (!hasPhoto && cache.get('n_' + userId)) { wizardStep(chatId, userId, text); return; }

    // ---- Обычная еда ----
    handleMeal(chatId, userId, text, msgFileId, false, msg.message_id);

  } catch (err) {
    debugLog('Ошибка в doPost: ' + err);
  }
}

// ============ ОБРАБОТКА ЕДЫ (сегодня или вчера) ============
function handleMeal(chatId, userId, text, fileId, yesterday, srcMsgId) {
  const cache = CacheService.getScriptCache();

  let fullText = text;
  if (!fileId) {
    const pending = cache.get('p_' + userId);
    if (pending) {
      const p = JSON.parse(pending);
      fileId = p.f || null;
      fullText = (p.t ? p.t + ' ' : '') + text;
      if (p.y) yesterday = true;               // ответ на вопрос в «вчерашнем» режиме — тоже во вчера
      if (p.s) srcMsgId = p.s;                 // помним исходное сообщение с едой
    }
  }

  const imageBase64 = fileId ? downloadPhoto(fileId) : null;
  const meal = askGemini(fullText, imageBase64);

  if (!meal) {
    sendMessage(chatId, '😵 Не смогла разобрать. Попробуй другое фото или опиши текстом: «творог 5% 180 г»');
    return;
  }
  if (meal.question) {
    cache.put('p_' + userId, JSON.stringify({ f: fileId, t: fullText, y: yesterday ? 1 : 0, s: srcMsgId || '' }), 1800);
    sendMessage(chatId, '❓ ' + meal.question + '\n(не знаешь — так и ответь, прикину сама)');
    return;
  }
  cache.remove('p_' + userId);

  const name = getUserName(userId);
  const offset = yesterday ? 1 : 0;
  const prev = collect(name, 0, Date.now() - offset * 86400000)[0] || { kcal: 0, p: 0, f: 0, c: 0 };
  const rowIndex = logMeal(name, meal, offset, srcMsgId);
  const u = getUser(userId) || { norm: 0 };

  const dK = Math.round((Number(prev.kcal) || 0) + (Number(meal.kcal) || 0));
  let reply = '✅ ' + meal.dish + ', ' + meal.grams + ' г — ' + meal.kcal +
              ' ккал (Б ' + meal.protein + ' / Ж ' + meal.fat + ' / У ' + meal.carbs + ')';

  if (yesterday) {
    const dP = Math.round((prev.p || 0) + (Number(meal.protein) || 0));
    const dF = Math.round((prev.f || 0) + (Number(meal.fat) || 0));
    const dC = Math.round((prev.c || 0) + (Number(meal.carbs) || 0));
    reply += ' — записала во вчера';
    reply += '\n📊 Вчера у ' + name + ': ' + dK + (u.norm ? '/' + u.norm : '') + ' ккал · Б ' + dP + ' · Ж ' + dF + ' · У ' + dC;
  } else {
    reply += '\n📊 ' + name + ' за сегодня: ' + dK + (u.norm ? ' из ' + u.norm + ' ккал' : ' ккал');
  }

  const msgId = sendMessage(chatId, reply);
  if (msgId && rowIndex) linkRow(rowIndex, msgId);   // связка «сообщение бота → строка» для переносов
}

// ============ ПЕРЕНОС ЗАПИСИ ВО ВЧЕРА ============
// colIdx: 9 — поиск по сообщению бота (J), 10 — по исходному сообщению пользователя (K)
// Возвращает true, если запись найдена (перенесена, уже во вчера или отказано)
function moveToYesterday(chatId, userId, msgId, colIdx) {
  const name = getUserName(userId);
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Лог');
  const rows = sheet.getDataRange().getValues();

  for (let i = rows.length - 1; i >= 1; i--) {
    if (String(rows[i][colIdx] || '') !== String(msgId)) continue;

    if (String(rows[i][2]).trim() !== String(name).trim()) {
      sendMessage(chatId, 'Эта запись не твоя — перенести её может только автор 🙂');
      return true;
    }
    const yStr = Utilities.formatDate(new Date(Date.now() - 86400000), TZ, 'dd.MM.yyyy');
    if (String(rows[i][0]).trim() === yStr) {
      sendMessage(chatId, 'Эта запись уже во вчерашнем дне 👌');
      return true;
    }
    sheet.getRange(i + 1, 1).setValue("'" + yStr);
    sheet.getRange(i + 1, 2).setValue("'23:59");
    SpreadsheetApp.flush();

    const u = getUser(userId) || { norm: 0 };
    const tY = collect(name, 0, Date.now() - 86400000)[0] || { kcal: 0 };
    const tT = collect(name, 0)[0] || { kcal: 0 };
    let reply = '↩️ Перенесла во вчера: ' + rows[i][3] + ', ' + rows[i][5] + ' ккал';
    reply += '\n📊 Вчера у ' + name + ': ' + Math.round(tY.kcal) + (u.norm ? '/' + u.norm : '') + ' ккал';
    reply += '\n📊 Сегодня у ' + name + ': ' + Math.round(tT.kcal) + (u.norm ? '/' + u.norm : '') + ' ккал';
    sendMessage(chatId, reply);
    return true;
  }
  return false;
}

// ============ КОМАНДЫ ============
function handleCommand(chatId, userId, rawText) {
  const parts = rawText.trim().split(/\s+/);
  const cmd = parts[0].split('@')[0].toLowerCase();
  const cache = CacheService.getScriptCache();

  if (cmd === '/день' || cmd === '/day')      return sendMessage(chatId, dayReport());
  if (cmd === '/неделя' || cmd === '/week')   return sendMessage(chatId, weekReport());
  if (cmd === '/удали' || cmd === '/del')     return deleteLast(chatId, userId);
  if (cmd === '/норма' || cmd === '/norm')    return normCommand(chatId, userId, parts);
  if (cmd === '/отмена' || cmd === '/cancel') {
    cache.remove('p_' + userId); cache.remove('n_' + userId);
    return sendMessage(chatId, 'Ок, отменила 👌');
  }
  if (cmd === '/помощь' || cmd === '/help' || cmd === '/start') {
    return sendMessage(chatId,
      '🍑 Что я умею:\n' +
      '• Кидай фото еды (лучше на весах) или текст «гречка 200 г» — посчитаю и запишу\n' +
      '• Не знаешь вес — опиши штуками («2 тоста, 6 черри») или скажи «прикинь сама»\n' +
      '• Составное блюдо — опиши состав в подписи, посчитаю точнее\n' +
      '• Забыла внести вчерашнее — /вчера гречка с курицей (можно фото с такой подписью)\n' +
      '• Записалось не в тот день — ответь «вчера» на мою запись, перенесу и пересчитаю оба дня\n' +
      '• /день — сводка за сегодня\n' +
      '• /неделя — итоги за 7 дней\n' +
      '• /удали — стереть мою последнюю запись\n' +
      '• /норма 1600 — задать норму вручную (можно /норма 1600 120 50 150 с БЖУ)\n' +
      '• /норма расчёт — рассчитаю норму по анкете\n' +
      '• /отмена — сбросить мой вопрос или анкету');
  }
  sendMessage(chatId, 'Не знаю такую команду 🙈 /помощь');
}

function dayReport() {
  const users = getAllUsers();
  if (!users.length) return 'В листе «Настройки» пока пусто';
  let out = '📊 Сегодня:';
  users.forEach(function (u) {
    const t = collect(u.name, 0)[0];
    if (!t) { out += '\n' + u.name + ': пока ничего не записано'; return; }
    out += '\n' + u.name + ': ' + Math.round(t.kcal) + (u.norm ? '/' + u.norm : '') + ' ккал' +
           ' · Б ' + Math.round(t.p) + (u.np ? '/' + u.np : '') +
           ' · Ж ' + Math.round(t.f) + (u.nf ? '/' + u.nf : '') +
           ' · У ' + Math.round(t.c) + (u.nc ? '/' + u.nc : '');
  });
  return out;
}

function weekReport() {
  const users = getAllUsers();
  let out = '📅 За 7 дней:';
  users.forEach(function (u) {
    const days = collect(u.name, 6);
    if (!days.length) { out += '\n' + u.name + ': записей нет'; return; }
    let k = 0; days.forEach(function (d) { k += d.kcal; });
    out += '\n' + u.name + ': ' + days.length + ' дн. с записями, в среднем ' +
           Math.round(k / days.length) + ' ккал/день';
  });
  return out;
}

function deleteLast(chatId, userId) {
  const name = getUserName(userId);
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Лог');
  const rows = sheet.getDataRange().getValues();
  for (let i = rows.length - 1; i >= 1; i--) {
    if (String(rows[i][2]).trim() === String(name).trim()) {
      sendMessage(chatId, '🗑 Удалила: ' + rows[i][3] + ', ' + rows[i][5] + ' ккал');
      sheet.deleteRow(i + 1);
      return;
    }
  }
  sendMessage(chatId, 'У тебя пока нет записей, нечего удалять');
}

// ============ НОРМА ============
function normCommand(chatId, userId, parts) {
  const cache = CacheService.getScriptCache();
  const arg = (parts[1] || '').toLowerCase();

  if (arg === 'расчёт' || arg === 'расчет') {
    cache.put('n_' + userId, JSON.stringify({ s: 1, d: {} }), 1800);
    return sendMessage(chatId, '📋 Посчитаем норму. Вопрос 1/6: пол — ж или м?');
  }
  const kcal = parseInt(arg);
  if (kcal > 500 && kcal < 6000) {
    const p = parseInt(parts[2]) || '';
    const f = parseInt(parts[3]) || '';
    const c = parseInt(parts[4]) || '';
    updateNorm(userId, kcal, p, f, c);
    return sendMessage(chatId, '✅ Норма: ' + kcal + ' ккал' + (p ? ' (Б ' + p + ' / Ж ' + f + ' / У ' + c + ')' : ''));
  }
  sendMessage(chatId, 'Так: «/норма 1600» — задать вручную, «/норма расчёт» — посчитаю по анкете');
}

function wizardStep(chatId, userId, text) {
  const cache = CacheService.getScriptCache();
  const st = JSON.parse(cache.get('n_' + userId));
  const v = text.trim().toLowerCase();
  const num = parseFloat(v.replace(',', '.'));

  if (st.s === 1) {
    if (v[0] === 'ж') st.d.sex = 'f'; else if (v[0] === 'м') st.d.sex = 'm';
    else return sendMessage(chatId, 'Просто «ж» или «м» 🙂');
    st.s = 2; save(); return sendMessage(chatId, 'Вопрос 2/6: возраст (лет)?');
  }
  if (st.s === 2) {
    if (!(num >= 10 && num <= 100)) return sendMessage(chatId, 'Возраст числом, например 30');
    st.d.age = num; st.s = 3; save(); return sendMessage(chatId, 'Вопрос 3/6: рост в см?');
  }
  if (st.s === 3) {
    if (!(num >= 120 && num <= 230)) return sendMessage(chatId, 'Рост в сантиметрах, например 168');
    st.d.h = num; st.s = 4; save(); return sendMessage(chatId, 'Вопрос 4/6: вес в кг?');
  }
  if (st.s === 4) {
    if (!(num >= 30 && num <= 300)) return sendMessage(chatId, 'Вес в кг, например 65');
    st.d.w = num; st.s = 5; save();
    return sendMessage(chatId, 'Вопрос 5/6: активность — ответь цифрой:\n1 — сидячий образ жизни\n2 — 1–3 тренировки в неделю\n3 — 3–5 тренировок в неделю');
  }
  if (st.s === 5) {
    if (!(num >= 1 && num <= 3)) return sendMessage(chatId, 'Цифрой: 1, 2 или 3');
    st.d.act = num; st.s = 6; save();
    return sendMessage(chatId, 'Вопрос 6/6: цель — ответь цифрой:\n1 — снижение веса\n2 — поддержание');
  }
  if (st.s === 6) {
    if (!(num === 1 || num === 2)) return sendMessage(chatId, 'Цифрой: 1 или 2');
    const d = st.d;
    // Формула Миффлина—Сан-Жеора; активность 1.3/1.45/1.6; мягкий дефицит 15%
    const bmr = 10 * d.w + 6.25 * d.h - 5 * d.age + (d.sex === 'm' ? 5 : -161);
    let kcal = bmr * [1.3, 1.45, 1.6][d.act - 1];
    if (num === 1) kcal *= 0.85;
    kcal = Math.round(kcal / 10) * 10;
    const p = Math.round(1.8 * d.w);
    const f = Math.round(1.0 * d.w);
    const c = Math.max(0, Math.round((kcal - p * 4 - f * 9) / 4));
    updateNorm(userId, kcal, p, f, c);
    cache.remove('n_' + userId);
    return sendMessage(chatId,
      '✅ Готово! Твоя норма: ' + kcal + ' ккал (Б ' + p + ' / Ж ' + f + ' / У ' + c + ')\n' +
      'Это расчётная оценка (±10%) — через 2–3 недели сверь с реальной динамикой. Поменять: /норма');
  }
  function save() { cache.put('n_' + userId, JSON.stringify(st), 1800); }
}

function updateNorm(userId, kcal, p, f, c) {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Настройки');
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(userId)) {
      sheet.getRange(i + 1, 3, 1, 4).setValues([[kcal, p, f, c]]);
      return;
    }
  }
}

// ============ НОЧНАЯ СВОДКА (триггер, час задаётся в setupTrigger) ============
function dailySummary() {
  try {
    // Точка отсчёта −3 часа: сводка всегда про ЗАКОНЧИВШИЙСЯ день,
    // даже если триггер проснулся после местной полуночи
    const ref = Date.now() - 3 * 3600 * 1000;
    const users = getAllUsers();

    let text = '🌙 Сводка дня:';
    users.forEach(function (u) {
      const t = collect(u.name, 0, ref)[0];
      if (!t) { text += '\n' + u.name + ': записей нет'; return; }
      text += '\n' + u.name + ': ' + Math.round(t.kcal) + (u.norm ? '/' + u.norm : '') + ' ккал' +
              ' · Б ' + Math.round(t.p) + (u.np ? '/' + u.np : '') +
              ' · Ж ' + Math.round(t.f) + (u.nf ? '/' + u.nf : '') +
              ' · У ' + Math.round(t.c) + (u.nc ? '/' + u.nc : '');
    });

    const dow = Utilities.formatDate(new Date(ref), TZ, 'u'); // 1=пн … 7=вс
    if (dow === '7') text += '\n\n' + weeklyBlock(ref);

    sendMessage(CHAT_ID, text);
  } catch (err) { debugLog('Ошибка в dailySummary: ' + err); }
}

// ============ НЕДЕЛЬНЫЙ БЛОК (цифры + бережный комментарий) ============
function weeklyBlock(ref) {
  const users = getAllUsers();
  let numbers = '📅 Неделя:';
  let facts = '';

  users.forEach(function (u) {
    const s = weekStats(u.name, ref);
    if (!s.days) { numbers += '\n' + u.name + ': записей нет'; return; }
    const aK = Math.round(s.kcal / s.days), aP = Math.round(s.p / s.days);
    const aF = Math.round(s.f / s.days),    aC = Math.round(s.c / s.days);
    const late = s.kcal ? Math.round(100 * s.late / s.kcal) : 0;
    numbers += '\n' + u.name + ': ' + s.days + ' дн. · в среднем ' + aK + (u.norm ? '/' + u.norm : '') +
               ' ккал · Б ' + aP + (u.np ? '/' + u.np : '') +
               ' · Ж ' + aF + (u.nf ? '/' + u.nf : '') +
               ' · У ' + aC + (u.nc ? '/' + u.nc : '');
    facts += u.name + ': дней с записями ' + s.days + ' из 7; средние за день: ' + aK +
             ' ккал (цель ' + (u.norm || 'не задана') + '), белок ' + aP + ' (цель ' + (u.np || 'не задана') +
             '), жиры ' + aF + ' (цель ' + (u.nf || 'не задана') + '), углеводы ' + aC +
             ' (цель ' + (u.nc || 'не задана') + '); доля калорий после 20:00 — ' + late + '%\n';
  });

  let out = numbers;
  if (facts) {
    const comment = askGeminiText(
      'Ты пишешь короткий недельный комментарий о питании для друзей. Данные (средние за неделю):\n' + facts +
      '\nЖёсткие правила, нарушать нельзя:\n' +
      '1. Прошедшую неделю не оценивай и не описывай — ни хорошо, ни плохо, ни нейтрально. Цифры люди уже видят.\n' +
      '2. Советы ТОЛЬКО в форме «что можно ДОБАВИТЬ» (белок в завтрак, овощи к обеду). НИКОГДА не советуй убрать, сократить, ограничить, уменьшить что-либо.\n' +
      '3. Хвалить можно только достаточность и стабильность (белок в цели, записи каждый день). НИКОГДА не хвали за низкие калории или за то, что человек ел меньше.\n' +
      '4. Запрещены идеи компенсации: «выровнять», «разгрузить», «отработать», «наверстать».\n' +
      '5. Еда без морали. Запрещённые слова: срыв, перебор, профицит, дефицит, недобор, превышение, вредное, правильное, чистое, заслужила, зафиксирован, рекомендуется, следует, бывает, ничего страшного.\n' +
      '6. Тело, вес, похудение, фигуру не упоминай вообще.\n' +
      '7. Формат: по 1–2 предложения на человека, обращение по имени, совет — как возможность с конкретным продуктом. Если у человека всё ровно по цифрам — одна фраза-факт, без выдуманных советов. Если у человека меньше 4 дней с записями — не пиши про него ничего.\n' +
      '8. Наблюдение о структуре (доля поздних калорий) можно использовать только как основу для совета на следующую неделю, не как оценку.\n' +
      '9. Без эмодзи, без обращения на «вы», тон — как у друга, который разбирается в питании.');
    if (comment) out += '\n\n' + comment.trim();
  }
  return out;
}

// Статистика за 7 дней, заканчивающихся днём ref
function weekStats(name, ref) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const rows = ss.getSheetByName('Лог').getDataRange().getValues();
  const sheetTz = ss.getSpreadsheetTimeZone();

  const weekDates = {};
  for (let k = 0; k < 7; k++) {
    weekDates[Utilities.formatDate(new Date(ref - k * 86400000), TZ, 'dd.MM.yyyy')] = true;
  }

  const daysSeen = {};
  const s = { days: 0, kcal: 0, p: 0, f: 0, c: 0, late: 0 };
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][2]).trim() !== String(name).trim()) continue;
    let d = rows[i][0];
    if (d instanceof Date) d = Utilities.formatDate(d, sheetTz, 'dd.MM.yyyy');
    d = String(d).trim();
    if (!weekDates[d]) continue;
    daysSeen[d] = true;
    const kcal = Number(rows[i][5]) || 0;
    s.kcal += kcal;
    s.p += Number(rows[i][6]) || 0;
    s.f += Number(rows[i][7]) || 0;
    s.c += Number(rows[i][8]) || 0;
    const hour = parseInt(String(rows[i][1]).trim().slice(0, 2));
    if (hour >= 20) s.late += kcal;
  }
  s.days = Object.keys(daysSeen).length;
  return s;
}

// Запусти ОДИН РАЗ вручную: создаст ежедневный триггер на atHour
// (час считается по часовому поясу ПРОЕКТА: ⚙️ Настройки проекта → Часовой пояс)
function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailySummary') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailySummary').timeBased().everyDays(1).atHour(0).create();
}

// Временная: посмотреть недельный блок, не дожидаясь воскресенья (пришлёт в чат!)
function testWeekly() {
  sendMessage(CHAT_ID, weeklyBlock(Date.now() - 3 * 3600 * 1000));
}

// ============ СКАЧИВАНИЕ ФОТО ============
function downloadPhoto(fileId) {
  const info = UrlFetchApp.fetch(TG_API + '/getFile?file_id=' + fileId);
  const filePath = JSON.parse(info.getContentText()).result.file_path;
  const blob = UrlFetchApp.fetch(TG_FILES + filePath).getBlob();
  return Utilities.base64Encode(blob.getBytes());
}

// ============ GEMINI ============
function askGemini(text, imageBase64) {
  const prompt =
    'Ты — калькулятор КБЖУ. Определи еду по фото и/или тексту и верни СТРОГО один JSON без пояснений:\n' +
    '{"dish":"название","grams":число,"kcal":число,"protein":число,"fat":число,"carbs":число,"question":null}\n' +
    'Правила:\n' +
    '- КБЖУ считай на ВСЮ порцию, не на 100 г.\n' +
    '- Если на фото кухонные весы — возьми вес с дисплея.\n' +
    '- Текст пользователя ВАЖНЕЕ фото: если указан вес или продукт — бери из текста.\n' +
    '- Слово «вчера» в тексте — служебное, к еде не относится, игнорируй его.\n' +
    '- БУДЬ КОНСИСТЕНТЕН: на одинаковое описание всегда давай одинаковую оценку. При неопределённости выбирай самый типичный вариант, а не случайный.\n' +
    '- Дефолты для напитков с молоком, если не указано иное: молоко 2.5% жирности, объём молока — половина объёма напитка. Чайная ложка сиропа — 7 г, ~20 ккал.\n' +
    '- Для составных блюд (суп, салат, рагу) опирайся на состав из текста; ингредиенты, которых по описанию «мало»/«чуть-чуть», считай по минимуму, а не по среднему рецепту.\n' +
    '- Штучные количества — это достаточная мера: «2 тоста, 6 черри, 1 банан» считай по стандартным средним весам, вопрос НЕ задавай.\n' +
    '- Если пользователь пишет «не знаю», «примерно», «на глаз», «прикинь» — оцени типичную порцию сам и добавь к dish пометку «(примерно)».\n' +
    '- Вопрос {"question":"..."} задавай ТОЛЬКО если нет ни веса, ни штук, ни нетто на упаковке, ни дисплея весов — и пользователь не просил оценить. Один короткий вопрос.\n' +
    '- Никакого текста вне JSON, без markdown-кавычек.';

  const parts = [{ text: prompt + '\n\nСообщение пользователя: ' + (text || '(только фото)') }];
  if (imageBase64) parts.push({ inline_data: { mime_type: 'image/jpeg', data: imageBase64 } });

  const raw = geminiRequest(parts);
  if (raw === null) return null;
  try { return JSON.parse(raw.replace(/```json|```/g, '').trim()); }
  catch (e) { debugLog('Gemini вернул не-JSON: ' + String(raw).slice(0, 300)); return null; }
}

function askGeminiText(promptText) {
  return geminiRequest([{ text: promptText }]);
}

function geminiRequest(parts) {
  // «Плавающие» имена моделей + фолбэк на лёгкую модель при лимите/перегрузе
  const models = ['gemini-flash-latest', 'gemini-flash-lite-latest'];
  for (let i = 0; i < models.length; i++) {
    const resp = UrlFetchApp.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + models[i] + ':generateContent?key=' + GEMINI_KEY,
      { method: 'post', contentType: 'application/json',
        payload: JSON.stringify({
          contents: [{ parts: parts }],
          generationConfig: { temperature: 0 }   // одинаковый вход → одинаковый ответ
        }),
        muteHttpExceptions: true });
    if (resp.getResponseCode() === 200) {
      try {
        const data = JSON.parse(resp.getContentText());
        if (i > 0) debugLog('Ответила запасная модель: ' + models[i]);
        // Склеиваем все текстовые куски ответа (новые модели могут дробить)
        return data.candidates[0].content.parts
          .map(function (p) { return p.text || ''; }).join('');
      } catch (e) { return null; }
    }
    debugLog('Gemini ' + models[i] + ': код ' + resp.getResponseCode() + ' ' + resp.getContentText().slice(0, 200));
  }
  return null;
}

// ============ ТАБЛИЦА ============
function logMeal(name, meal, offsetDays, srcMsgId) {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Лог');
  const d = new Date(Date.now() - (offsetDays || 0) * 86400000);
  sheet.appendRow([
    "'" + Utilities.formatDate(d, TZ, 'dd.MM.yyyy'),   // апостроф = хранить как текст
    "'" + (offsetDays ? '23:59' : Utilities.formatDate(new Date(), TZ, 'HH:mm')),
    name, meal.dish, meal.grams, meal.kcal, meal.protein, meal.fat, meal.carbs,
    '', String(srcMsgId || '')                          // J: msg_id бота, K: src_msg_id
  ]);
  SpreadsheetApp.flush();
  return sheet.getLastRow();
}

function linkRow(rowIndex, msgId) {
  try {
    SpreadsheetApp.openById(SHEET_ID).getSheetByName('Лог')
      .getRange(rowIndex, 10).setValue(String(msgId));
  } catch (e) { debugLog('linkRow: ' + e); }
}

// Суммы по дням: collect(name, 0) → [сегодня]; refMs — необязательная точка отсчёта
function collect(name, daysBack, refMs) {
  const ref = refMs || Date.now();
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const rows = ss.getSheetByName('Лог').getDataRange().getValues();
  const sheetTz = ss.getSpreadsheetTimeZone();
  const byDay = {};
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][2]).trim() !== String(name).trim()) continue;
    let d = rows[i][0];
    if (d instanceof Date) d = Utilities.formatDate(d, sheetTz, 'dd.MM.yyyy');
    d = String(d).trim();
    if (!byDay[d]) byDay[d] = { kcal: 0, p: 0, f: 0, c: 0 };
    byDay[d].kcal += Number(rows[i][5]) || 0;
    byDay[d].p    += Number(rows[i][6]) || 0;
    byDay[d].f    += Number(rows[i][7]) || 0;
    byDay[d].c    += Number(rows[i][8]) || 0;
  }
  const res = [];
  for (let k = 0; k <= daysBack; k++) {
    const ds = Utilities.formatDate(new Date(ref - k * 86400000), TZ, 'dd.MM.yyyy');
    if (byDay[ds]) res.push(byDay[ds]);
  }
  return res;
}

function getAllUsers() {
  const rows = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Настройки').getDataRange().getValues();
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i][0]) continue;
    out.push({ id: String(rows[i][0]), name: rows[i][1],
               norm: Number(rows[i][2]) || 0, np: Number(rows[i][3]) || 0,
               nf: Number(rows[i][4]) || 0, nc: Number(rows[i][5]) || 0 });
  }
  return out;
}

function getUser(userId) {
  const users = getAllUsers();
  for (let i = 0; i < users.length; i++) if (users[i].id === String(userId)) return users[i];
  return null;
}

function getUserName(userId) {
  const u = getUser(userId);
  return u ? u.name : 'Гость';
}

// ============ TELEGRAM ============
// Отправка с повторами: серверные сбои Telegram (5xx/429) пережидаем до 3 попыток
function sendMessage(chatId, text) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const resp = UrlFetchApp.fetch(TG_API + '/sendMessage', {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ chat_id: String(chatId), text: text, message_thread_id: TOPIC_ID }),
      muteHttpExceptions: true
    });
    const code = resp.getResponseCode();
    if (code === 200) {
      try { return JSON.parse(resp.getContentText()).result.message_id; } catch (e) { return null; }
    }
    debugLog('Telegram отказал (попытка ' + attempt + '/3): ' + resp.getContentText().slice(0, 200));
    if (code >= 500 || code === 429) {
      Utilities.sleep(2000 * attempt);
    } else {
      break;   // 4xx повторять бессмысленно
    }
  }
  return null;
}

// ============ ЧЁРНЫЙ ЯЩИК ============
function debugLog(text) {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let sh = ss.getSheetByName('Debug');
    if (!sh) sh = ss.insertSheet('Debug');
    sh.appendRow([Utilities.formatDate(new Date(), TZ, 'HH:mm:ss'), text]);
  } catch (e) {}
}
