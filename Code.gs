// ================== НАСТРОЙКИ ==================
// Заполни свои значения. НИКОГДА не коммить этот файл с реальными токенами!
const BOT_TOKEN  = 'ВСТАВЬ_ТОКЕН_БОТА';        // от @BotFather, вида 123456789:AA...
const GEMINI_KEY = 'ВСТАВЬ_КЛЮЧ_GEMINI';       // из Google AI Studio, вида AIzaSy...
const SHEET_ID   = 'ВСТАВЬ_ID_ТАБЛИЦЫ';        // из URL таблицы, между /d/ и /edit
const TOPIC_ID   = 0;                          // ID темы форум-чата, где живёт бот (число)
const CHAT_ID    = 0;                          // ID группового чата (отрицательное число)
const TZ         = 'Europe/Belgrade';          // ваш часовой пояс

const TG_API   = 'https://api.telegram.org/bot' + BOT_TOKEN;
const TG_FILES = 'https://api.telegram.org/file/bot' + BOT_TOKEN + '/';

// ============ ПРИЁМ СООБЩЕНИЙ ============
function doPost(e) {
  try {
    const update = JSON.parse(e.postData.contents);
    const msg = update.message;
    if (!msg) return;
    if (msg.message_thread_id !== TOPIC_ID) return;   // бот работает только в своей теме

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text   = msg.text || msg.caption || '';
    const hasPhoto = !!msg.photo;
    if (!text && !hasPhoto) return;

    if (text.startsWith('/')) { handleCommand(chatId, userId, text); return; }

    const cache = CacheService.getScriptCache();

    // Анкета расчёта нормы (если запущена)
    if (!hasPhoto && cache.get('n_' + userId)) { wizardStep(chatId, userId, text); return; }

    // Еда: контекст из этого сообщения или из недавнего вопроса бота
    let fileId = hasPhoto ? msg.photo[msg.photo.length - 1].file_id : null;
    let fullText = text;
    if (!hasPhoto) {
      const pending = cache.get('p_' + userId);
      if (pending) {
        const p = JSON.parse(pending);
        fileId = p.f || null;
        fullText = (p.t ? p.t + ' ' : '') + text;
      }
    }

    const imageBase64 = fileId ? downloadPhoto(fileId) : null;
    const meal = askGemini(fullText, imageBase64);

    if (!meal) {
      sendMessage(chatId, '😵 Не смогла разобрать. Попробуй другое фото или опиши текстом: «творог 5% 180 г»');
      return;
    }
    if (meal.question) {
      cache.put('p_' + userId, JSON.stringify({ f: fileId, t: fullText }), 1800);
      sendMessage(chatId, '❓ ' + meal.question + '\n(не знаешь — так и ответь, прикину сама)');
      return;
    }
    cache.remove('p_' + userId);

    // Считаем «до», записываем, показываем «до + сейчас» — без гонки с таблицей
    const name = getUserName(userId);
    const prev = collect(name, 0)[0] || { kcal: 0 };
    logMeal(name, meal);
    const todayKcal = Math.round((Number(prev.kcal) || 0) + (Number(meal.kcal) || 0));
    const u = getUser(userId);

    let reply = '✅ ' + meal.dish + ', ' + meal.grams + ' г — ' + meal.kcal +
                ' ккал (Б ' + meal.protein + ' / Ж ' + meal.fat + ' / У ' + meal.carbs + ')';
    reply += '\n📊 ' + name + ' за сегодня: ' + todayKcal +
             (u && u.norm ? ' из ' + u.norm + ' ккал' : ' ккал');
    sendMessage(chatId, reply);

  } catch (err) {
    debugLog('Ошибка в doPost: ' + err);
  }
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
    // Формула Миффлина—Сан-Жеора
    const bmr = 10 * d.w + 6.25 * d.h - 5 * d.age + (d.sex === 'm' ? 5 : -161);
    let kcal = bmr * [1.3, 1.45, 1.6][d.act - 1];
    if (num === 1) kcal *= 0.85;                       // мягкий дефицит 15%
    kcal = Math.round(kcal / 10) * 10;
    const p = Math.round(1.8 * d.w);
    const f = Math.round(1.0 * d.w);
    const c = Math.max(0, Math.round((kcal - p * 4 - f * 9) / 4));
    updateNorm(userId, kcal, p, f, c);
    cache.remove('n_' + userId);
    return sendMessage(chatId,
      '✅ Готово! Твоя норма: ' + kcal + ' ккал (Б ' + p + ' / Ж ' + f + ' / У ' + c + ')\n' +
      'Это расчётная оценка (±10%) — через 2–3 недели сверим с реальной динамикой. Поменять: /норма');
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

// ============ ВЕЧЕРНЯЯ СВОДКА (по триггеру) ============
function dailySummary() {
  try {
    const users = getAllUsers();
    let facts = '', any = false;
    users.forEach(function (u) {
      const t = collect(u.name, 0)[0];
      if (!t) { facts += u.name + ': записей нет\n'; return; }
      any = true;
      facts += u.name + ': ' + Math.round(t.kcal) + (u.norm ? '/' + u.norm : '') + ' ккал, Б ' +
               Math.round(t.p) + (u.np ? '/' + u.np : '') + ', Ж ' + Math.round(t.f) + (u.nf ? '/' + u.nf : '') +
               ', У ' + Math.round(t.c) + (u.nc ? '/' + u.nc : '') + '\n';
    });
    let text = '🌙 Итоги дня:\n' + facts.trim();
    if (any) {
      const analysis = askGeminiText(
        'Данные питания за день (факт/норма):\n' + facts +
        '\nНапиши по 1 короткому предложению на каждого человека: сухое наблюдение о балансе БЖУ/калорий и один практичный вариант на завтра, если есть перекос. ' +
        'Без похвал, без критики, без обращений на "вы", без эмодзи. Если данных мало — просто скажи это.');
      if (analysis) text += '\n\n' + analysis.trim();
    }
    sendMessage(CHAT_ID, text);
  } catch (err) { debugLog('Ошибка в dailySummary: ' + err); }
}

// Запусти ОДИН РАЗ вручную: создаст ежедневный триггер на ~21:00
function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailySummary') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailySummary').timeBased().everyDays(1).atHour(21).create();
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
    '- Штучные количества — это достаточная мера: «2 тоста, 6 черри, 3 слайса колбасы, 1 банан» считай по стандартным средним весам, вопрос НЕ задавай.\n' +
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
  // gemini-flash-latest — «плавающее» имя, всегда указывает на актуальную версию.
  // При отказе (лимит и т.п.) пробуем более лёгкую модель.
  const models = ['gemini-flash-latest', 'gemini-flash-lite-latest'];
  for (let i = 0; i < models.length; i++) {
    const resp = UrlFetchApp.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + models[i] + ':generateContent?key=' + GEMINI_KEY,
      { method: 'post', contentType: 'application/json',
        payload: JSON.stringify({ contents: [{ parts: parts }] }),
        muteHttpExceptions: true });
    if (resp.getResponseCode() === 200) {
      try {
        const data = JSON.parse(resp.getContentText());
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
function logMeal(name, meal) {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Лог');
  const now = new Date();
  sheet.appendRow([
    "'" + Utilities.formatDate(now, TZ, 'dd.MM.yyyy'),   // апостроф = хранить как текст, а не дату
    "'" + Utilities.formatDate(now, TZ, 'HH:mm'),
    name, meal.dish, meal.grams, meal.kcal, meal.protein, meal.fat, meal.carbs
  ]);
  SpreadsheetApp.flush();
}

// Суммы по дням: collect(name, 0) → [сегодня], collect(name, 6) → до 7 последних дней с записями
function collect(name, daysBack) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const rows = ss.getSheetByName('Лог').getDataRange().getValues();
  const sheetTz = ss.getSpreadsheetTimeZone();   // даты-объекты читаем в поясе таблицы
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
    const ds = Utilities.formatDate(new Date(Date.now() - k * 86400000), TZ, 'dd.MM.yyyy');
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
function sendMessage(chatId, text) {
  const resp = UrlFetchApp.fetch(TG_API + '/sendMessage', {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ chat_id: String(chatId), text: text, message_thread_id: TOPIC_ID }),
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) debugLog('Telegram отказал: ' + resp.getContentText().slice(0, 300));
}

// ============ ЧЁРНЫЙ ЯЩИК ============
// Пишет ошибки в лист Debug таблицы — удобно, когда журнал «Выполнений» капризничает
function debugLog(text) {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let sh = ss.getSheetByName('Debug');
    if (!sh) sh = ss.insertSheet('Debug');
    sh.appendRow([Utilities.formatDate(new Date(), TZ, 'HH:mm:ss'), text]);
  } catch (e) {}
}
