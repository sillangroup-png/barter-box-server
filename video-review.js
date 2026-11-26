// video-review.js — разбор видео блогера через Gemini (03.11.2026).
// Те же наставления, что у Telegram-бота «AI-аудитор Reels» MIXIT: оценка для менеджера + что сказать блогеру.
// Видео скачиваем по ссылке (Wazzup отдаёт contentUri), грузим в Gemini File API, ждём обработку, просим разбор,
// файл в Gemini сразу удаляем. Ключ — GEMINI_API_KEY в Render; модель — GEMINI_MODEL (по умолчанию gemini-3.5-flash).
const API = "https://generativelanguage.googleapis.com";
const MAX_BYTES = 200 * 1024 * 1024;

// 26.11.2026 Нина: критерии — как у Telegram-бота «AI-аудитор Reels» MIXIT; оценка из 18 (6 осей по 0–3), было из 9.
const SYSTEM_INSTRUCTION = [
  "Ты эксперт по видеомаркетингу бренда MIXIT. Анализируй ролик блогера строго и честно внутри, но блогеру пиши тепло и конструктивно.",
  "Выдай СТРОГО два блока.",
  "",
  "ВНУТРИ СЕБЯ задай вопрос: остановился бы я в ленте? Досмотрел? Захотел купить?",
  "",
  "=== БЛОК 1: ОЦЕНКА ДЛЯ МЕНЕДЖЕРА ===",
  "",
  "Оцени шесть осей, каждую от 0 до 3:",
  "",
  "hookAngle -- ХУК (первые 3 сек), важнейшее. Должно быть ОДНОВРЕМЕННО два элемента:",
  "  а) визуальный захват: крупный план результата, до/после, макро текстура кожи, резкий переход, эмоция лица;",
  "  б) вербальное сообщение: цепляющая фраза голосом ИЛИ текст на экране.",
  "  Сильные углы: через боль (проблема кожи), через желаемый результат (сияние, чистые поры), через честный отзыв, через сравнение до/после, через разрушение стереотипа, через social proof.",
  "  0 = нет ни того, ни другого; 1 = есть только один элемент; 2 = оба есть, но слабые; 3 = мощный двойной хук.",
  "",
  "oneThought -- ОДНА МЫСЛЬ: один продукт, один угол, одна эмоция. Прыжки между разными проблемами и продуктами разрушают структуру.",
  "  0 = мешанина тем и продуктов; 1 = идея размыта; 2 = понятно о чём, но уходит в сторону; 3 = одна чёткая идея от начала до конца.",
  "",
  "result -- РЕЗУЛЬТАТ (железное правило): до/после или чёткий видимый эффект на коже/волосах крупным планом (сияние, блеск, текстура, чистота). Просто держит баночку -- не считается.",
  "  0 = результата нет; 1 = только слова об эффекте или едва виден; 2 = виден, но не крупно или без сравнения; 3 = чёткое до/после или эффект крупным планом.",
  "",
  "dynamics -- ДИНАМИКА: считай скучные секунды. Затянутость -- это молчание, пустые движения без слов, повтор без смысла. Показывать продукт с рассказом -- это НЕ затянутость. Оптимальная длина: 15-30 сек для Reels, до 60 сек для демонстрации продукта.",
  "  0 = больше половины ролика скучно; 1 = много провисаний; 2 = 1-2 провисания; 3 = держит до конца.",
  "",
  "delivery -- ПОДАЧА: если есть озвучка -- темп (медленная убивает досмотры), энергетика, естественность; если озвучки нет -- достаточно ли текста на экране. ОДНОГО из двух достаточно -- не требуй оба одновременно и не требуй текстовые плашки для каждого этапа, если есть озвучка.",
  "  0 = ни озвучки, ни текста / не понять; 1 = вяло или медленно; 2 = нормально; 3 = энергично, живо, естественно.",
  "",
  "selling -- ПРОДАЮЩИЕ ЭЛЕМЕНТЫ и CTA: обозначена ли боль/проблема, понятно ли УТП продукта, есть ли социальное доказательство (отзыв, цифры, трансформация); в конце обязателен призыв к действию ЛИБО голосом, ЛИБО текстом (одного достаточно), формат для Kaspi: 'Заказала на Kaspi, артикул оставила в описании' или аналог. Артикул в самом видео писать НЕ нужно.",
  "  0 = ничего продающего и нет CTA; 1 = что-то одно; 2 = боль/УТП есть, но CTA или доказательство слабые; 3 = боль + УТП + доказательство + CTA.",
  "",
  "gate_score = сумма шести осей (максимум 18).",
  "",
  "Отдельно проверь (ДА или НЕТ):",
  "cta_ok: в конце есть призыв к действию голосом ИЛИ текстом. Нет CTA -- обязательная правка.",
  "result_ok: есть видимый результат (ось result не ниже 2).",
  "no_other_brands: в кадре НЕТ косметики других брендов. Одежда с логотипами, декор, техника -- ок.",
  "",
  "Решение:",
  "ПУБЛИКАЦИЯ -- gate_score 15-18 И cta_ok = ДА И result_ok = ДА И no_other_brands = ДА",
  "ПРАВКИ -- gate_score 10-14, ИЛИ (gate_score 15-18, но провален cta_ok, result_ok или no_other_brands)",
  "ПЕРЕСЪЁМКА -- gate_score ниже 10",
  "",
  "Выведи блок 1 СТРОГО в этом формате:",
  "--- ОЦЕНКА ДЛЯ МЕНЕДЖЕРА ---",
  "hookAngle: X/3",
  "oneThought: X/3",
  "result: X/3",
  "dynamics: X/3",
  "delivery: X/3",
  "selling: X/3",
  "gate_score: X/18",
  "cta_ok: ДА / НЕТ",
  "result_ok: ДА / НЕТ",
  "no_other_brands: ДА / НЕТ",
  "РЕШЕНИЕ: ПУБЛИКАЦИЯ / ПРАВКИ / ПЕРЕСЪЁМКА",
  "Причина: [1-2 предложения -- что конкретно слабое и почему именно это решение]",
  "",
  "=== БЛОК 2: ЧТО СКАЗАТЬ БЛОГЕРУ ===",
  "",
  "Готовое сообщение блогеру, на 'вы':",
  "- 1 комплимент за то, что реально хорошо в ролике",
  "- 'Вот что стоит доработать:'",
  "- 3-4 правки: что видишь в кадре + почему слабо + как исправить конкретно (с таймкодом, если возможно). Если хук слабый -- предложи конкретную замену. Если нет результата -- это правка номер один. Нет CTA -- обязательная правка.",
  "- тон тёплый, без жаргона, без слова 'проблема'",
  "- 1 финальная фраза -- ждём новую версию",
  "- 10-12 строк максимум",
  "Если решение ПУБЛИКАЦИЯ -- коротко похвали и напиши, что видео согласовано, без списка правок.",
  "",
  "Формат:",
  "--- ЧТО СКАЗАТЬ БЛОГЕРУ ---",
  "[текст сообщения]",
  "",
  "Критикуй только видео: монтаж, структуру, содержание -- не внешность и не личность. Не придирайся к виду упаковки. Если результат на коже не виден -- причина в съёмке (свет, ракурс, тональник), не в продукте.",
  "Косметику других брендов в кадре всегда указывай как правку.",
].join("\n");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseReview(text) {
  const t = String(text || "");
  const dec = (t.match(/РЕШЕНИЕ:\s*(ПУБЛИКАЦИЯ|ПРАВКИ|ПЕРЕСЪ[ЁЕ]МКА)/i) || [])[1] || "";
  const sm = t.match(/gate_score:\s*(\d+)\s*\/\s*(18|9)/i);
  const req = ["cta_ok", "result_ok", "no_other_brands"].map((k) => (t.match(new RegExp(k + ":\\s*(ДА|НЕТ)", "i")) || [])[1]);
  const formal = (t.match(/formal_pass:\s*(ДА|НЕТ)/i) || [])[1] || (req.every(Boolean) ? (req.every((x) => /да/i.test(x)) ? "ДА" : "НЕТ") : "");
  return { decision: dec.toUpperCase().replace("Ё", "Е").replace("ПЕРЕСЪЕМКА", "ПЕРЕСЪЁМКА"), score: sm ? Number(sm[1]) : null, scale: sm ? Number(sm[2]) : null, formal: formal.toUpperCase() };
}

async function reviewVideo(url, { mimeHint } = {}) {
  const key = String(process.env.GEMINI_API_KEY || "").trim();
  if (!key) throw new Error("В Render не задан GEMINI_API_KEY");
  const model = String(process.env.GEMINI_MODEL || "gemini-3.5-flash").trim();
  const H = { "x-goog-api-key": key };

  // 1) скачать видео
  const dl = await fetch(url);
  if (!dl.ok) throw new Error(`не удалось скачать видео (${dl.status})`);
  const len = Number(dl.headers.get("content-length") || 0);
  if (len > MAX_BYTES) throw new Error("видео больше 200 МБ — ИИ не проверит, посмотрите вручную");
  const buf = Buffer.from(await dl.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error("видео больше 200 МБ — ИИ не проверит, посмотрите вручную");
  let mime = String(dl.headers.get("content-type") || mimeHint || "").split(";")[0].trim();
  if (!/^video\//.test(mime)) {
    if (/\.(mov)(\?|$)/i.test(url)) mime = "video/quicktime";
    else if (/\.(mp4|m4v)(\?|$)/i.test(url) || !mime || mime === "application/octet-stream") mime = "video/mp4";
    else throw new Error(`это не видео (${mime}) — ИИ не проверяет`);
  }

  // 2) загрузить в Gemini (resumable)
  const st = await fetch(`${API}/upload/v1beta/files`, { method: "POST", headers: { ...H, "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
    "X-Goog-Upload-Header-Content-Length": String(buf.length), "X-Goog-Upload-Header-Content-Type": mime, "Content-Type": "application/json" },
    body: JSON.stringify({ file: { display_name: `barterbox-${Date.now()}` } }) });
  const upUrl = st.headers.get("x-goog-upload-url");
  if (!st.ok || !upUrl) throw new Error(`Gemini: загрузка не началась (${st.status}) ${(await st.text().catch(() => "")).slice(0, 200)}`);
  const up = await fetch(upUrl, { method: "POST", headers: { "Content-Length": String(buf.length), "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" }, body: buf });
  const upj = await up.json().catch(() => ({}));
  let file = upj.file;
  if (!up.ok || !file) throw new Error(`Gemini: загрузка не удалась (${up.status})`);

  try {
    // 3) дождаться обработки
    for (let waited = 0; file.state === "PROCESSING" && waited < 180000; waited += 4000) {
      await sleep(4000);
      const g = await fetch(`${API}/v1beta/${file.name}`, { headers: H });
      if (g.ok) file = await g.json();
    }
    if (file.state !== "ACTIVE") throw new Error("Gemini не смог обработать видео");

    // 4) разбор (повторы при перегрузке)
    const body = {
      system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      contents: [{ role: "user", parts: [{ file_data: { mime_type: mime, file_uri: file.uri } }, { text: "Проанализируй этот ролик. Выведи СТРОГО два блока по инструкции." }] }],
      generationConfig: { temperature: 0.1 },
    };
    // Перегрузка (503/429/500) — по 3 попытки на основной модели, потом на запасной (GEMINI_FALLBACK_MODEL).
    const fallback = String(process.env.GEMINI_FALLBACK_MODEL || "gemini-flash-latest").trim();
    const models = [model].concat(fallback && fallback !== model ? [fallback] : []);
    let lastErr = "", busy = false;
    for (const m of models) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = await fetch(`${API}/v1beta/models/${encodeURIComponent(m)}:generateContent`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const j = await r.json().catch(() => ({}));
        if (r.ok) {
          const text = ((j.candidates || [])[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
          if (!text) throw new Error("Gemini вернул пустой ответ");
          return { text, model: m, ...parseReview(text) };
        }
        lastErr = `${r.status} ${(j.error && j.error.message) || ""}`.slice(0, 300);
        busy = r.status === 503 || r.status === 429 || r.status === 500;
        if (r.status === 404) break; // такой модели нет — сразу к запасной
        if (!busy) break;
        await sleep([10000, 20000, 40000][attempt]);
      }
    }
    const err = new Error(busy ? "Gemini перегружен" : `Gemini: ${lastErr}`);
    err.retryable = busy;
    throw err;
  } finally {
    fetch(`${API}/v1beta/${file.name}`, { method: "DELETE", headers: H }).catch(() => {});
  }
}


// 23.11.2026: язык видео и похожее базовое ТЗ (для автопроставления в интеграцию). Отдельный короткий запрос.
async function classifyVideo(url, candidates) {
  const key = String(process.env.GEMINI_API_KEY || "").trim();
  if (!key) throw new Error("В Render не задан GEMINI_API_KEY");
  const model = String(process.env.GEMINI_MODEL || "gemini-3.5-flash").trim();
  const H = { "x-goog-api-key": key };
  const dl = await fetch(url);
  if (!dl.ok) throw new Error(`не удалось скачать видео (${dl.status})`);
  const buf = Buffer.from(await dl.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error("видео больше 200 МБ");
  let mime = String(dl.headers.get("content-type") || "").split(";")[0].trim();
  if (!/^video\//.test(mime)) mime = /\.mov(\?|$)/i.test(url) ? "video/quicktime" : "video/mp4";
  const st = await fetch(`${API}/upload/v1beta/files`, { method: "POST", headers: { ...H, "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
    "X-Goog-Upload-Header-Content-Length": String(buf.length), "X-Goog-Upload-Header-Content-Type": mime, "Content-Type": "application/json" },
    body: JSON.stringify({ file: { display_name: `bb-classify-${Date.now()}` } }) });
  const upUrl = st.headers.get("x-goog-upload-url");
  if (!st.ok || !upUrl) throw new Error(`Gemini: загрузка не началась (${st.status})`);
  const up = await fetch(upUrl, { method: "POST", headers: { "Content-Length": String(buf.length), "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" }, body: buf });
  let file = (await up.json().catch(() => ({}))).file;
  if (!up.ok || !file) throw new Error(`Gemini: загрузка не удалась (${up.status})`);
  try {
    for (let waited = 0; file.state === "PROCESSING" && waited < 180000; waited += 4000) {
      await sleep(4000);
      const g = await fetch(`${API}/v1beta/${file.name}`, { headers: H });
      if (g.ok) file = await g.json();
    }
    if (file.state !== "ACTIVE") throw new Error("Gemini не смог обработать видео");
    const list = (candidates || []).map((c) => `${c.id} | ${c.group} | ${c.title}${c.hook ? " | хук: " + c.hook : ""}${c.angle ? " | идея: " + c.angle : ""}`).join("\n");
    const prompt = [
      "Посмотри рекламный ролик блогера для косметики MIXIT.",
      "1) Язык речи/текста в видео: ru (русский), kz (казахский) или music (без речи, только музыка и надписи).",
      "2) Какой из базовых сценариев (ТЗ) ниже ролик повторяет по идее, хуку и структуре. Если ни один явно не подходит — tz_id пустой.",
      "Сценарии (id | товар | название | хук | идея):", list || "(список пуст)",
      'Ответь СТРОГО JSON без пояснений: {"lang":"ru|kz|music","tz_id":"…","confidence":0.0-1.0}',
    ].join("\n");
    const fallback = String(process.env.GEMINI_FALLBACK_MODEL || "gemini-flash-latest").trim();
    let lastErr = "";
    for (const m of [model].concat(fallback && fallback !== model ? [fallback] : [])) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = await fetch(`${API}/v1beta/models/${encodeURIComponent(m)}:generateContent`, { method: "POST", headers: { ...H, "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ file_data: { mime_type: mime, file_uri: file.uri } }, { text: prompt }] }], generationConfig: { temperature: 0, responseMimeType: "application/json" } }) });
        const j = await r.json().catch(() => ({}));
        if (r.ok) {
          const text = ((j.candidates || [])[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
          let o = {}; try { o = JSON.parse((text.match(/\{[\s\S]*\}/) || ["{}"])[0]); } catch (e) {}
          const lang = o.lang === "ru" ? "ru" : o.lang === "kz" ? "kz" : o.lang === "music" ? "под музыку" : "";
          const tz = (candidates || []).find((c) => c.id === String(o.tz_id || "")) || null;
          return { lang, tz, confidence: Number(o.confidence) || 0, model: m };
        }
        lastErr = `${r.status} ${(j.error && j.error.message) || ""}`.slice(0, 200);
        if (r.status === 404) break;
        if (![429, 500, 503].includes(r.status)) break;
        await sleep([10000, 20000, 40000][attempt]);
      }
    }
    throw new Error(`Gemini: ${lastErr}`);
  } finally {
    fetch(`${API}/v1beta/${file.name}`, { method: "DELETE", headers: H }).catch(() => {});
  }
}

module.exports = { reviewVideo, classifyVideo, parseReview, SYSTEM_INSTRUCTION };
