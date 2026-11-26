// video-review.js — разбор видео блогера через Gemini (03.11.2026).
// Те же наставления, что у Telegram-бота «AI-аудитор Reels» MIXIT: оценка для менеджера + что сказать блогеру.
// Видео скачиваем по ссылке (Wazzup отдаёт contentUri), грузим в Gemini File API, ждём обработку, просим разбор,
// файл в Gemini сразу удаляем. Ключ — GEMINI_API_KEY в Render; модель — GEMINI_MODEL (по умолчанию gemini-3.5-flash).
const API = "https://generativelanguage.googleapis.com";
const MAX_BYTES = 200 * 1024 * 1024;

// 26.11.2026 Нина: Margo Gate — один в один с Telegram-ботом «AI-аудитор Reels» MIXIT (две ступени):
// 1) строгая оценка JSON: gate_score = К1×3 + К2×2 + К3 (макс. 18), формальные проверки F1–F12;
// 2) тёплое сообщение блогеру по этой оценке. В Barter Box решения называются ПУБЛИКАЦИЯ / ПРАВКИ / ПЕРЕСЪЁМКА.
const AUDIT_INSTRUCTION = `Ты строгий аудитор рекламных роликов бренда MIXIT (Казахстан, продажи на Kaspi).
Досмотри ролик ЦЕЛИКОМ, до последней секунды, со звуком. Оценивай только то, что реально видно и слышно,
каждое замечание — с таймкодом. Не додумывай и не ставь баллы «из вежливости».

=== СИСТЕМА MARGO GATE ===

ФОРМУЛА: gate_score = К1×3 + К2×2 + К3×1 (максимум 18)
РЕШЕНИЕ: 15–18 → ПУБЛИКУЕМ | 11–14 → ДОРАБОТКА | ≤10 → ПЕРЕСЪЁМКА
Если К1=0 — ПЕРЕСЪЁМКА при любых баллах.

--- К1 «Единая мысль и УТП» (0–3, вес 3) ---
3 — один товар, один угол, одна эмоция; УТП ясно за 10 секунд; нет прыжков между продуктами/проблемами
2 — мысль есть, но угол размыт или УТП проговорено вскользь
1 — несколько идей конкурируют, зритель теряется
0 — непонятно что рекламируется и зачем

--- К2 «Структура и логика» (0–3, вес 2) ---
3 — чёткая цепочка: хук (0–3 с) → проблема/желание → товар как решение (название на экране или голосом) →
    доказательство на себе (до/после при одном свете и ракурсе; ощущение «не липнет»; ингредиент;
    сравнение по одному критерию; почти пустая банка; реакция других) → призыв купить
    «Супер» и «просто держит баночку» — НЕ доказательство
2 — структура угадывается, но один блок слабый или переставлен
1 — структура сломана: нет доказательства или нет CTA, или хук не работает
0 — хаос, нет ни одного работающего блока

--- К3 «Сила хука и угол» (0–3, вес 1) ---
3 — в первые 3 секунды ОДНОВРЕМЕННО: картинка-захват (крупный план результата, до/после, макро текстура,
    резкий переход, эмоция лица) + фраза голосом или текстом; понятно без звука; один сильный угол:
    боль / желаемый результат / честный отзыв / сравнение / разрушение стереотипа / социальное доказательство
2 — один из двух элементов есть, угол нечёткий
1 — хук формальный, не цепляет
0 — хука нет или запрещённый зачин (Девочки / Қыздар / Всем привет / Сәлеметсіздер ме / Меня зовут…)

=== ФОРМАЛЬНЫЕ ПРОВЕРКИ ===
Каждая — да/нет с таймкодом и конкретным доказательством из ролика:
F1 один товар MIXIT — главный, не фон, не сторитайм без товара
F2 призыв купить в конце: голосом или текстом («переходите по ссылке», «артикул в описании» и т.п.)
F3 живой голос / своя озвучка (НЕ музыка без речи, НЕ липсинк под чужой звук)
F4 нет косметики других брендов в кадре и по названию
F5 нет медобещаний (лечит / убирает пигментацию / поры чище / омолаживает / от выпадения)
F6 нет распаковки как основы ролика
F7 нет запрещённых зачинов: «Девочки», «Қыздар», «Всем привет», «Сәлеметсіздер ме», «Меня зовут…»
F8 нет слов «дешёвый», «бюджетный», «недорогой», «арзан»
F9 бренд назван голосом (МИ́ксит, ударение на первый слог)
F10 хороший свет на лице, субтитры есть
F11 есть социальное доказательство (Kaspi-отзыв или аналог)
F12 дети не трогают и не наносят косметику

Если F1, F3, F4, F5, F6, F7, F8, F12 нарушены — решение ПЕРЕСЪЁМКА независимо от баллов.
Если нарушен только F2 — решение по баллам (не ПЕРЕСЪЁМКА автоматически).

Динамика: перечисли пустые секунды (молчание, движения без смысла, повтор).
Показ товара с рассказом — НЕ затянутость.
Если ролик не про косметику MIXIT — напиши в verdict_reason.

Произношение: проверь, говорит ли блогер «МИ́ксит» (ударение на И).
Если говорит «микси́т» или как-то иначе — укажи таймкод и что именно сказано.

Отвечай строго JSON по схеме.`;

const AUDIT_SCHEMA = { type: "OBJECT", properties: {
  product: { type: "STRING", description: "какой товар MIXIT в ролике" },
  idea: { type: "STRING", description: "главная мысль ролика одной фразой" },
  language: { type: "STRING", description: "язык речи: ru / kk / смешанный / без речи" },
  hook_text: { type: "STRING", description: "что сказано/написано в первые 3 с (дословно)" },
  k1: { type: "INTEGER" }, k1_why: { type: "STRING" },
  k2: { type: "INTEGER" }, k2_why: { type: "STRING" },
  k3: { type: "INTEGER" }, k3_why: { type: "STRING" },
  formal: { type: "ARRAY", items: { type: "OBJECT", properties: { check: { type: "STRING" }, ok: { type: "BOOLEAN" }, evidence: { type: "STRING" } }, required: ["check", "ok", "evidence"] } },
  empty_seconds: { type: "ARRAY", items: { type: "STRING" } },
  strengths: { type: "ARRAY", items: { type: "STRING" } },
  fixes: { type: "ARRAY", description: "3–4 главные правки по убыванию важности", items: { type: "OBJECT", properties: { timecode: { type: "STRING" }, what: { type: "STRING" }, why: { type: "STRING" }, how: { type: "STRING" } }, required: ["what", "why", "how"] } },
  verdict: { type: "STRING", enum: ["ПУБЛИКУЕМ", "ДОРАБОТКА", "ПЕРЕСЪЁМКА"] },
  verdict_reason: { type: "STRING" },
  brand_mention: { type: "STRING", description: "назван / НЕ назван" },
  pronunciation: { type: "STRING", description: "МИ́ксит ок / таймкод + что сказано вместо МИ́ксит" },
}, required: ["product", "idea", "language", "hook_text", "k1", "k1_why", "k2", "k2_why", "k3", "k3_why", "formal", "fixes", "strengths", "verdict", "verdict_reason", "brand_mention", "pronunciation"] };

const MESSAGE_INSTRUCTION = `Ты пишешь блогеру от имени команды MIXIT по готовой строгой оценке ролика (JSON ниже).
Ничего не добавляй от себя сверх оценки и не смягчай суть правок — только тон.
Критику пиши прямо и конкретно: не «можно было лучше», а «хука нет — первые 3 секунды молчание».
Формат (на «вы», тепло, без жаргона, без слова «проблема»):
- 1 искренний комплимент за то, что реально хорошо (из strengths);
- «Вот что стоит доработать:»;
- 3–4 правки из fixes: таймкод → что в кадре → почему это мешает продажам → как сделать конкретно;
- если есть формальные нарушения (ok=false) — они идут первыми;
- финальная фраза: ждём новую версию (или «можно публиковать», если verdict = ПУБЛИКУЕМ).
10–12 строк максимум. Если язык ролика казахский — пиши на казахском, иначе на русском.
Пиши ТОЛЬКО сообщение блогеру.`;

// Решение бота → названия Barter Box
const VERDICT_BB = { "ПУБЛИКУЕМ": "ПУБЛИКАЦИЯ", "ДОРАБОТКА": "ПРАВКИ", "ПЕРЕСЪЁМКА": "ПЕРЕСЪЁМКА", "ПЕРЕСЪЕМКА": "ПЕРЕСЪЁМКА" };
const clamp3 = (v) => Math.max(0, Math.min(3, Math.round(Number(v) || 0)));
// Текст для менеджера — как строка бота «ОЦЕНКА ДЛЯ МЕНЕДЖЕРА», + формальные нарушения и пустые секунды
function managerText(a, score) {
  const bad = (a.formal || []).filter((f) => f && f.ok === false);
  return [
    "--- ОЦЕНКА ДЛЯ МЕНЕДЖЕРА ---",
    `товар: ${a.product || "—"}`,
    `идея: ${a.idea || "—"}`,
    `хук: ${a.hook_text || "—"}`,
    "---",
    `К1 (мысль и УТП)=${clamp3(a.k1)}/3 · К2 (структура)=${clamp3(a.k2)}/3 · К3 (хук)=${clamp3(a.k3)}/3`,
    `gate_score: ${score}/18`,
    `РЕШЕНИЕ: ${VERDICT_BB[String(a.verdict || "").toUpperCase()] || a.verdict || "—"}`,
    `минусы: ${a.verdict_reason || "—"}`,
    `бренд голосом: ${a.brand_mention || "—"}`,
    `произношение: ${a.pronunciation || "—"}`,
    bad.length ? "формальные нарушения:\n" + bad.map((f) => `· ${f.check}: ${f.evidence || ""}`).join("\n") : "формальные проверки: все пройдены",
    (a.empty_seconds || []).length ? "пустые секунды: " + a.empty_seconds.join("; ") : "",
  ].filter(Boolean).join("\n");
}

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

    // 4) Margo Gate: ступень 1 — строгая оценка (JSON), ступень 2 — сообщение блогеру. Повторы при перегрузке.
    const fallback = String(process.env.GEMINI_FALLBACK_MODEL || "gemini-flash-latest").trim();
    const models = [model].concat(fallback && fallback !== model ? [fallback] : []);
    const ask = async (body) => {
      let lastErr = "", busy = false;
      for (const m of models) {
        for (let attempt = 0; attempt < 3; attempt++) {
          const r = await fetch(`${API}/v1beta/models/${encodeURIComponent(m)}:generateContent`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify(body) });
          const j = await r.json().catch(() => ({}));
          if (r.ok) {
            const text = ((j.candidates || [])[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
            if (!text) throw new Error("Gemini вернул пустой ответ");
            return { text, model: m };
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
    };
    const auditBody = (schema) => ({
      system_instruction: { parts: [{ text: AUDIT_INSTRUCTION + (schema ? "" : "\nПоля JSON: " + Object.keys(AUDIT_SCHEMA.properties).join(", ") + ". formal — массив {check, ok, evidence}; fixes — массив {timecode, what, why, how}.") }] },
      contents: [{ role: "user", parts: [{ file_data: { mime_type: mime, file_uri: file.uri } }, { text: "Оцени этот ролик по правилам Margo Gate." }] }],
      generationConfig: Object.assign({ temperature: 0, responseMimeType: "application/json", maxOutputTokens: 8192 }, schema ? { responseSchema: AUDIT_SCHEMA } : {}),
    });
    let r1;
    try { r1 = await ask(auditBody(true)); }
    catch (e) { if (e.retryable) throw e; r1 = await ask(auditBody(false)); } // схему не приняли — та же оценка без схемы
    let audit;
    try { audit = JSON.parse((r1.text.match(/\{[\s\S]*\}/) || [r1.text])[0]); } catch (e) { throw new Error("Gemini вернул оценку не в формате JSON"); }
    const score = clamp3(audit.k1) * 3 + clamp3(audit.k2) * 2 + clamp3(audit.k3);
    audit.score = score;
    const r2 = await ask({
      system_instruction: { parts: [{ text: MESSAGE_INSTRUCTION }] },
      contents: [{ role: "user", parts: [{ text: JSON.stringify(audit) }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
    });
    const decision = VERDICT_BB[String(audit.verdict || "").toUpperCase()] || "";
    const bad = (audit.formal || []).filter((f) => f && f.ok === false);
    const text = managerText(audit, score) + "\n\n--- ЧТО СКАЗАТЬ БЛОГЕРУ ---\n" + r2.text.trim();
    return { text, model: r1.model, decision, score, scale: 18, formal: bad.length ? "НЕТ" : "ДА", k: { k1: clamp3(audit.k1), k2: clamp3(audit.k2), k3: clamp3(audit.k3) }, method: "margo-gate" };
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

module.exports = { reviewVideo, classifyVideo, parseReview, AUDIT_INSTRUCTION, MESSAGE_INSTRUCTION, managerText, SYSTEM_INSTRUCTION: AUDIT_INSTRUCTION };
