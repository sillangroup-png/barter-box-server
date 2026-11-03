// coordinator.js — ИИ-координатор блогеров через WhatsApp (Wazzup, канал WABA), ТЕСТ на одном менеджере. 30.10.2026.
//
// Режимы (переменная COORD_MODE в Render):
//   off — выключен (по умолчанию);
//   dry — всё считает и пишет в журнал «отправила бы …», но в WhatsApp НЕ отправляет (проверка без риска);
//   on  — отправляет через Wazzup.
// Тест: COORD_PILOT_MANAGER (например «Нина») — только её строки; COORD_PILOT_PHONES — если задано, только эти номера.
//
// Правила:
//  1. Дубли: входящее событие Wazzup с тем же messageId обрабатывается один раз; одно напоминание (строка + вид + дата)
//     ставится в очередь один раз.
//  2. Очередь: сообщения не теряются при сбоях — повторы через 5/15/60 мин; старше 6 часов не отправляются (чтобы не
//     слать устаревшее хаотично после восстановления); отправка только 10:00–20:00 по Алматы.
//  3. Дата: координатор САМ дату НЕ меняет. Предложенный блогером перенос → менеджеру с кнопкой «Принять дату».
//  4. Журнал: что отправлено, что получено, что решено и следующее напоминание — state.coord.log и d.coordNext.
//
// Не больше 1 сообщения в день и 3 напоминаний на одну плановую дату; блогер ответил «стоп» — больше не пишем.
//
// Транспорт (31.10.2026): у MIXIT обычный номер WhatsApp (не WABA) через Wazzup, подключённый к открытой линии Битрикс24.
// Если задан BITRIX_WEBHOOK_URL (и нет WAZZUP_API_KEY) — отправка через Битрикс: контакт по телефону → последний чат
// открытой линии → сообщение от имени менеджера чата (Wazzup доставляет в WhatsApp). Шаблоны не нужны — обычный текст.
// Ответы: бот Barter Box на открытой линии читает первое сообщение диалога, пишет уведомление в Barter Box и СРАЗУ
// передаёт чат менеджеру (imopenlines.bot.session.operator) — работа менеджеров в Битриксе не меняется.
// Лимит: COORD_DAILY_CAP сообщений в день на всех (по умолчанию 30).
const crypto = require("crypto");
const { reviewVideo } = require("./video-review.js");

const H = 3600 * 1000;
const WAZZUP = "https://api.wazzup24.com/v3";
const MAX_LOG = 1500, MAX_EVENTS = 500, SEEN_KEEP_MS = 7 * 24 * H;
const RETRY_MIN = [5, 15, 60, 60, 60];
const STALE_MS = 6 * H;
const SOON_DAYS = 2, MAX_REMINDERS_PER_DATE = 3;

function almatyNow() { return new Date(Date.now() + 5 * H); }
function almatyDate() { return almatyNow().toISOString().slice(0, 10); }
function almatyHour() { return almatyNow().getUTCHours(); }
function daysBetween(a, b) { return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5); }
function ddmm(ymd) { return ymd ? ymd.slice(8, 10) + "." + ymd.slice(5, 7) : ""; }
function waNumber(raw) {
  let x = String(raw || "").replace(/\.0+$/, "").replace(/\D/g, "");
  if (x.length === 11 && x[0] === "8") x = "7" + x.slice(1);
  if (x.length === 10 && x[0] === "7") x = "7" + x;
  return /^7\d{10}$/.test(x) ? x : "";
}
function personKey(name) { return String(name || "").toLowerCase().replace(/ё/g, "е").trim().split(/[\s,.;()\-–—\/]+/).filter(Boolean)[0] || ""; }
function isPublished(d) { return d.videoStatus === "опубликовано" || (Number(d.factReachStories) > 0); }

module.exports = function mountCoordinator(app, { getState, persist, requireAuth }) {
  const cfg = () => ({
    mode: ["dry", "on"].includes(String(process.env.COORD_MODE || "").toLowerCase()) ? String(process.env.COORD_MODE).toLowerCase() : "off",
    manager: String(process.env.COORD_PILOT_MANAGER || "").trim(),
    phones: String(process.env.COORD_PILOT_PHONES || "").split(/[,;\s]+/).map(waNumber).filter(Boolean),
    apiKey: String(process.env.WAZZUP_API_KEY || ""),
    channelId: String(process.env.WAZZUP_CHANNEL_ID || ""),
    tpl: { soon: process.env.WAZZUP_TPL_SOON || "", today: process.env.WAZZUP_TPL_TODAY || "", overdue: process.env.WAZZUP_TPL_OVERDUE || "" },
    secret: String(process.env.COORD_WEBHOOK_SECRET || ""),
    bitrix: String(process.env.BITRIX_WEBHOOK_URL || "").trim(),
    dailyCap: Number(process.env.COORD_DAILY_CAP) || 30,
    senderId: Number(process.env.COORD_SENDER_USER_ID) || 0,
  });
  const transport = () => { const k = cfg(); return k.apiKey ? "wazzup" : k.bitrix ? "bitrix" : "none"; };
  const C = () => {
    const st = getState();
    st.coord = st.coord && typeof st.coord === "object" ? st.coord : {};
    const c = st.coord;
    c.queue = Array.isArray(c.queue) ? c.queue : [];
    c.log = Array.isArray(c.log) ? c.log : [];
    c.events = Array.isArray(c.events) ? c.events : [];
    c.seen = c.seen && typeof c.seen === "object" ? c.seen : {};
    c.keys = c.keys && typeof c.keys === "object" ? c.keys : {};
    c.lastIn = c.lastIn && typeof c.lastIn === "object" ? c.lastIn : {}; // chatId → ISO последнего входящего (24-часовое окно)
    return c;
  };
  const log = (dealId, dir, text, extra) => {
    const c = C();
    c.log.push(Object.assign({ at: new Date().toISOString(), dealId: dealId || null, dir, text: String(text).slice(0, 600) }, extra || {}));
    if (c.log.length > MAX_LOG) c.log.splice(0, c.log.length - MAX_LOG);
  };
  const event = (d, kind, text, extra) => {
    const c = C();
    c.events.push(Object.assign({ id: crypto.randomBytes(6).toString("hex"), at: new Date().toISOString(), dealId: d ? d.id : null,
      to: d ? (d.responsible || cfg().manager) : cfg().manager, blogger: d ? d.blogerName : "", kind, text: String(text).slice(0, 600), read: false }, extra || {}));
    if (c.events.length > MAX_EVENTS) c.events.splice(0, c.events.length - MAX_EVENTS);
    return c.events[c.events.length - 1];
  };
  const inPilot = (d) => {
    const k = cfg();
    if (!k.manager || personKey(d.responsible) !== personKey(k.manager)) return false;
    const n = waNumber(d.phone);
    if (!n) return false;
    return !k.phones.length || k.phones.includes(n);
  };

  // ---------- Этапы видео (03.11.2026) ----------
  // Каждая строка микро: ⏳ wait (ждём видео) → 📥 received (прислали, проверить) → ✏️ revise / 🔁 reshoot (правки/пересъём,
  // снова ждём) → ✅ approved (одобрено, в план дня) → 🎬 опубликовано (ссылка/факт-дата). Видео ждём на согласование
  // за рабочий день до плановой даты публикации. Утром (DAYPLAN_HOUR, по умолчанию 10:00 Алматы) всё, что на сегодня не
  // одобрено, переезжает на следующий рабочий день — в «сегодня» остаётся только то, что реально выйдет.
  const isWd = (ymd) => { const g = new Date(ymd + "T00:00:00Z").getUTCDay(); return g !== 0 && g !== 6; };
  const nextWorkday = (ymd) => { let x = addDays(ymd, 1); while (!isWd(x)) x = addDays(x, 1); return x; };
  const prevWorkday = (ymd) => { let x = addDays(ymd, -1); while (!isWd(x)) x = addDays(x, -1); return x; };
  const addWorkdays = (ymd, n) => { let x = ymd; for (let i = 0; i < n; i++) x = nextWorkday(x); return x; };
  const isDone = (d) => isPublished(d) || !!d.publishDate;
  const stageOf = (d) => (isDone(d) ? "published" : ["received", "lead", "revise", "reshoot", "approved"].includes(d.vstage) ? d.vstage : "wait");
  // Тимлиды (как в Barter Box: группы менеджеров). Чужой/неизвестный менеджер — к COORD_TEAMLEAD (по умолчанию Нина).
  const TEAM_GROUPS = [
    { lead: "Нина", members: ["Мадина", "Марина", "Зарина", "Камила"] },
    { lead: "Сая", members: ["Надира", "Анеля", "Анастасия", "Сабрина", "Оксана"] },
  ];
  const leadOf = (resp) => {
    const k = personKey(resp);
    const g = TEAM_GROUPS.find((x) => personKey(x.lead) === k || x.members.some((m) => personKey(m) === k));
    return g ? g.lead : String(process.env.COORD_TEAMLEAD || "Нина");
  };
  // Срок сдачи видео на согласование: после правок — свой (vdue), иначе рабочий день до публикации.
  const dueOf = (d) => { const pd = String(d.plannedDate || "").slice(0, 10); if (!pd) return ""; return (d.vstage === "revise" || d.vstage === "reshoot") && d.vdue ? d.vdue : prevWorkday(pd); };
  const nameOf = (d) => String(d.blogerName || "").replace(/@/g, "").trim() || "здравствуйте";
  function planReminders() {
    const k = cfg();
    if (k.mode === "off") return;
    const st = getState(), c = C(), today = almatyDate(), hour = almatyHour();
    let changed = false;
    const queue = (d, kind, key, dateStr, extra) => {
      c.keys[key] = new Date().toISOString();
      const vals = [nameOf(d), d.product || "интеграции", dateStr, extra || ""];
      c.queue.push({ id: crypto.randomBytes(6).toString("hex"), key, dealId: d.id, kind, chatId: waNumber(d.phone), vals,
        createdAt: new Date().toISOString(), nextTry: Date.now(), tries: 0, status: "pending" });
      log(d.id, "plan", `в очереди: ${KIND_LABEL[kind] || kind}`);
      changed = true;
    };
    const mgrOnce = (d, key, kind, text) => { if (c.keys[key]) return; c.keys[key] = new Date().toISOString(); event(d, kind, text); changed = true; };
    for (const d of st.microInfluencerDeals || []) {
      if (!inPilot(d)) continue;
      const pd = String(d.plannedDate || "").slice(0, 10);
      const stage = stageOf(d);
      const pausedTill = d.coordPausedUntil && Date.parse(d.coordPausedUntil) > Date.now();
      let next = null;
      if (d.coordStop) next = { text: "автонапоминания выключены (стоп)" };
      else if (stage === "published") next = { text: "опубликовано — напоминаний нет" };
      else if (!pd) next = { text: "нет плановой даты" };
      else if (stage === "lead") {
        next = { text: "видео у тимлида на согласовании — блогеру не пишем" };
        if (d.vleadAt && Date.now() - Date.parse(d.vleadAt) > 24 * H) mgrOnce(d, `${d.id}:lead-check:${d.vleadAt}`, "lead", "Видео ждёт согласования тимлида больше суток");
      } else if (stage === "received") {
        next = { text: "видео у менеджера на проверке — блогеру не пишем" };
        if (d.vreceivedAt && Date.now() - Date.parse(d.vreceivedAt) > 24 * H) mgrOnce(d, `${d.id}:mgr-check:${d.vreceivedAt}`, "media", "Видео ждёт проверки больше суток — одобрите или отправьте правки");
      } else if (stage === "approved") {
        if (today === pd && hour >= 18 && !pausedTill) { const key = `${d.id}:link_ask:${pd}`; if (!c.keys[key]) queue(d, "link_ask", key, ddmm(pd)); }
        if (today > pd) mgrOnce(d, `${d.id}:mgr-nolink:${pd}`, "overdue", `Видео одобрено на ${ddmm(pd)}, но ссылки на публикацию нет — уточните у блогера`);
        next = { text: today < pd ? `одобрено, публикация ${ddmm(pd)}; вечером в день публикации попросим ссылку` : today === pd ? "одобрено, сегодня публикация; в 18:00 попросим ссылку, если её не будет" : "одобрено, но ссылки нет — менеджеру" };
      } else {
        // wait / revise / reshoot — ждём видео на согласование
        const due = dueOf(d), missed = Number(d.vmissed) || 0, ep = d.vepoch || d.plannedDateOrig || pd;
        if (missed >= 3) { next = { text: "молчит 3 дня — напоминания остановлены, нужен менеджер" }; mgrOnce(d, `${d.id}:mgr-silent:${ep}`, "overdue", `Видео не прислали уже ${missed} раб. дня после срока — блогеру больше не пишем, нужен менеджер`); }
        else if (!pausedTill) {
          let kind = null, key = null, ds = ddmm(due);
          if (missed >= 1) { kind = "overdue"; key = `${d.id}:overdue:${ep}`; ds = ddmm(d.vdueMissed || due); }
          else if (today === due) { kind = "due_today"; key = `${d.id}:due_today:${due}`; }
          else if (today === prevWorkday(due) || (today < due && daysBetween(today, due) === 1)) { kind = "due_soon"; key = `${d.id}:due_soon:${due}`; }
          if (kind && !c.keys[key]) queue(d, kind, key, ds);
        }
        if (!next) next = { text: pausedTill ? `пауза до ${new Date(d.coordPausedUntil).toLocaleString("ru-RU", { timeZone: "Asia/Almaty" })}`
          : missed >= 1 ? "срок сдачи прошёл — спросили, когда пришлёт" : today < due ? `видео на согласование ждём ${ddmm(due)}; напомним накануне` : `сегодня ждём видео на согласование` };
      }
      const nx = JSON.stringify(next);
      if (JSON.stringify(d.coordNext) !== nx) { d.coordNext = next; changed = true; }
    }
    if (changed) persist();
  }
  const KIND_LABEL = { soon: "скоро", today: "сегодня", overdue: "срок прошёл", due_soon: "завтра ждём видео", due_today: "сегодня ждём видео",
    link_ask: "просим ссылку", approved: "видео согласовано", revise: "правки", reshoot: "пересъём" };

  // Утро: план дня. Неодобренное на сегодня (и забытое за прошлые дни с момента запуска) — на следующий рабочий день.
  // DAYPLAN_SCOPE: pilot (по умолчанию — только строки теста, как у бота) | all | off.
  function dayplanScope(d) {
    const sc = String(process.env.DAYPLAN_SCOPE || "pilot").toLowerCase();
    if (sc === "off") return false;
    if (sc === "all") return true;
    return inPilot(d);
  }
  function moveDeal(d, to, why) {
    const from = String(d.plannedDate || "").slice(0, 10);
    if (!d.plannedDateOrig && from) d.plannedDateOrig = from;
    d.plannedDate = to;
    d.vmoved = { from, to, why, at: new Date().toISOString() };
    d.vmoves = (Number(d.vmoves) || 0) + 1;
  }
  function runDayPlan(force) {
    const sc = String(process.env.DAYPLAN_SCOPE || "pilot").toLowerCase();
    if (sc === "off") return false;
    const st = getState(), today = almatyDate();
    const hourFix = Number(process.env.DAYPLAN_HOUR) || 10;
    st.dayPlan = st.dayPlan && typeof st.dayPlan === "object" ? st.dayPlan : {};
    if (!force && (st.dayPlan[today] || almatyHour() < hourFix)) return false;
    if (!st.dayPlanStart) st.dayPlanStart = today;
    const start = st.dayPlanStart;
    let moved = 0;
    for (const d of st.microInfluencerDeals || []) {
      if (!dayplanScope(d)) continue;
      const pd = String(d.plannedDate || "").slice(0, 10);
      if (!pd || pd > today || pd < start) continue;
      const stage = stageOf(d);
      if (stage === "published" || stage === "approved") continue;
      const to = nextWorkday(today);
      if (stage === "wait" || stage === "revise" || stage === "reshoot") {
        const due = dueOf(d);
        if (due && due <= today) { if (!d.vmissed) d.vdueMissed = due; d.vmissed = (Number(d.vmissed) || 0) + 1; }
      }
      moveDeal(d, to, stage === "received" ? "видео не проверено к утру" : stage === "lead" ? "видео не согласовано к утру" : "видео не готово к утру");
      if (d.vstage === "revise" || d.vstage === "reshoot") d.vdue = today; // правки так и не пришли — ждём сегодня
      log(d.id, "sys", `план дня: не готово к утру — перенесено ${ddmm(pd)} → ${ddmm(to)}`);
      if (stage === "received") event(d, "media", `Видео не проверено к утру — перенесено на ${ddmm(to)}. Одобрите, чтобы вернуть в план`);
      moved++;
    }
    const ids = (st.microInfluencerDeals || []).filter((d) => dayplanScope(d) && String(d.plannedDate || "").slice(0, 10) === today && ["approved", "published"].includes(stageOf(d))).map((d) => d.id);
    st.dayPlan[today] = { at: new Date().toISOString(), ids, moved, scope: sc };
    for (const day of Object.keys(st.dayPlan)) if (daysBetween(day, today) > 120) delete st.dayPlan[day];
    persist();
    return true;
  }
  function addDays(ymd, n) { const t = new Date(ymd + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }

  // ---------- Отправка (очередь) ----------
  // Тексты напоминаний (обычный WhatsApp — пишем свободным текстом). Можно заменить своими в Render:
  // COORD_TEXT_SOON / COORD_TEXT_TODAY / COORD_TEXT_OVERDUE, подстановки {имя} {товар} {дата}.
  const cap = (x) => { x = String(x || "").trim(); if (!x || x === "здравствуйте") return ""; return /^[а-яё]/.test(x) ? x[0].toUpperCase() + x.slice(1) : x; }; // логины (aru_beauty) не трогаем
  const prodPh = (p) => (p && p !== "интеграции" ? ` с продуктом «${p}»` : "");
  const DEFAULT_TEXTS = { // без имени и товара — коротко и сразу про видео
    soon: (v) => `Здравствуйте! 😊 Это MIXIT 💚\nПубликация видео запланирована на ${v[2]} 📅 Всё в силе?`,
    today: (v) => `Здравствуйте! 😊 Это MIXIT 💚\nНапоминаем, что публикация видео запланирована на сегодня 🎬`,
    overdue: (v) => `Здравствуйте! 😊 Это MIXIT 💚\nВидео на согласование ждали ${v[2]}. Подскажите, пожалуйста, когда сможете прислать? 🙏`,
    due_soon: (v) => `Здравствуйте! 😊 Это MIXIT 💚\nНапоминаем: видео на согласование ждём ${v[2]} 📅`,
    due_today: (v) => `Здравствуйте! 😊 Это MIXIT 💚\nСегодня ждём видео на согласование 🎬 Пришлите его, пожалуйста, сюда, когда будет готово 🙏`,
    link_ask: (v) => `Здравствуйте! 😊 Это MIXIT 💚\nСегодня день публикации 🎬 Когда выложите, пришлите, пожалуйста, ссылку 💚`,
    approved: (v) => `Спасибо! 💚 Видео согласовано ✅\nПубликация ${v[2]} — когда выложите, пришлите, пожалуйста, ссылку 🙏`,
    revise: (v) => `Спасибо за видео! 💚 Есть правки:\n${v[3]}\nПришлите, пожалуйста, исправленный вариант до ${v[2]} 🙏`,
    reshoot: (v) => `Спасибо за видео! 💚 К сожалению, нужно переснять:\n${v[3]}\nПришлите, пожалуйста, новый вариант до ${v[2]} 🙏`,
  };
  // Свой текст для любого вида: COORD_TEXT_<ВИД> (SOON, TODAY, OVERDUE, DUE_SOON, DUE_TODAY, LINK_ASK, APPROVED, REVISE, RESHOOT).
  const envText = Object.fromEntries(Object.keys(DEFAULT_TEXTS).map((x) => [x, "COORD_TEXT_" + x.toUpperCase()]));
  const TEXTS = {};
  for (const kind of Object.keys(DEFAULT_TEXTS)) TEXTS[kind] = (v) => {
    const own = String(process.env[envText[kind]] || "").trim();
    if (!own) return DEFAULT_TEXTS[kind](v);
    return own.replace(/\\n/g, "\n").replace(/\{имя\}/g, cap(v[0])).replace(/\{товар\}/g, v[1] && v[1] !== "интеграции" ? v[1] : "").replace(/\{дата\}/g, v[2] || "").replace(/\{правки\}/g, v[3] || "");
  };
  // Канал WhatsApp: из WAZZUP_CHANNEL_ID или, если не задан, единственный WhatsApp/WABA-канал аккаунта (GET /channels).
  let channelCache = null;
  async function wazzupGet(path) {
    const k = cfg();
    const r = await fetch(`${WAZZUP}${path}`, { headers: { Authorization: `Bearer ${k.apiKey}` } });
    const txt = await r.text();
    if (!r.ok) throw new Error(`Wazzup ${r.status}: ${txt.slice(0, 200)}`);
    try { return JSON.parse(txt); } catch (e) { return null; }
  }
  // WAZZUP_CHANNEL_ID — код канала или просто номер канала (например 77710206625). transport "whatsapp" — обычный
  // WhatsApp (можно писать любым текстом), "wapi" — WABA (вне 24 ч только шаблоном).
  async function chanInfo() {
    if (channelCache) return channelCache;
    const k = cfg();
    const list = await wazzupGet("/channels");
    const all = Array.isArray(list) ? list : [];
    const wa = all.filter((c) => /wapi|whatsapp/i.test(String(c.transport || "")));
    const want = k.channelId.trim(), wd = want.replace(/\D/g, "");
    let pick = null;
    if (want) pick = all.find((c) => c.channelId === want) || (wd.length >= 10 ? wa.find((c) => String(c.plainId || "").replace(/\D/g, "").endsWith(wd.slice(-10))) : null);
    else { const act = wa.filter((c) => !c.state || /active/i.test(String(c.state))); if (act.length === 1) pick = act[0]; }
    const names = wa.map((c) => `${c.plainId || "?"} (${c.transport})`).join(", ") || "—";
    if (!pick) throw new Error(want ? `канал «${want}» не найден в Wazzup; есть: ${names}` : `WhatsApp-каналов в Wazzup несколько: ${names} — укажите в Render WAZZUP_CHANNEL_ID = номер нужного канала`);
    channelCache = { id: pick.channelId, plain: !/wapi/i.test(String(pick.transport || "")), phone: pick.plainId || "" };
    return channelCache;
  }
  async function channelId() { return (await chanInfo()).id; }
  // Ручная отправка одному блогеру (кнопки «напомнить сейчас» и «тест»): через Wazzup, если задан ключ, иначе через Битрикс.
  async function sendNow(d, text) {
    if (transport() === "bitrix") { const r = await sendViaBitrix(d, text); return { via: `через Битрикс (чат ${r.chatId})`, ...r }; }
    if (transport() !== "wazzup") throw new Error("Отправка не настроена: в Render нет WAZZUP_API_KEY / BITRIX_WEBHOOK_URL");
    const ch = await chanInfo();
    const n = waNumber(d.phone);
    const inWindow = C().lastIn[n] && Date.now() - Date.parse(C().lastIn[n]) < 23.5 * H;
    if (!ch.plain && !inWindow) throw new Error("канал WABA: блогер не писал сутки, свободный текст нельзя — только шаблоном (автонапоминание)");
    await wazzupSend({ channelId: ch.id, chatType: "whatsapp", chatId: n, text, crmMessageId: `bb-manual-${d.id}-${Date.now()}` });
    return { via: `через Wazzup (${ch.phone})`, chatId: n, contactId: "—", userId: "—" };
  }
  async function wazzupSend(body) {
    const k = cfg();
    const r = await fetch(`${WAZZUP}/message`, { method: "POST", headers: { Authorization: `Bearer ${k.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const txt = await r.text();
    if (!r.ok) throw new Error(`Wazzup ${r.status}: ${txt.slice(0, 200)}`);
    let j = {}; try { j = JSON.parse(txt) || {}; } catch (e) {}
    if (j.messageId) C().seen[`out:${j.messageId}`] = Date.now(); // чтобы статусы ошибок брать только по нашим сообщениям
    return j;
  }
  let sending = false;
  async function processQueue() {
    const k = cfg();
    if (k.mode === "off" || sending) return;
    const h = almatyHour();
    if (h < 10 || h >= 20) return; // тихие часы — ждём утра
    sending = true;
    const st = getState(), c = C();
    let changed = false;
    try {
      const today = almatyDate();
      for (const q of c.queue) {
        if (q.status !== "pending" || q.nextTry > Date.now()) continue;
        const d = (st.microInfluencerDeals || []).find((x) => x.id === q.dealId);
        if (Date.now() - Date.parse(q.createdAt) > STALE_MS) { q.status = "stale"; log(q.dealId, "sys", "напоминание устарело (не отправлено вовремя) — пропущено"); changed = true; continue; }
        if (!d || d.coordStop || isPublished(d)) { q.status = "cancelled"; log(q.dealId, "sys", "напоминание отменено: опубликовано / стоп / строка удалена"); changed = true; continue; }
        if (d.coordLastOutDay === today) { q.nextTry = Date.now() + 12 * H; continue; } // не больше 1 сообщения в день
        const sentToday = c.log.filter((l) => l.dir === "out" && String(l.at).slice(0, 10) === new Date().toISOString().slice(0, 10)).length;
        if (sentToday >= k.dailyCap) { q.nextTry = Date.now() + 2 * H; continue; } // общий лимит в день
        const text = TEXTS[q.kind](q.vals);
        if (transport() === "bitrix") {
          if (k.mode === "dry") {
            q.status = "dry"; d.coordLastOutDay = today;
            log(q.dealId, "out", `[ТЕСТ, не отправлено] через Битрикс: ${text}`);
            changed = true; continue;
          }
          try {
            const r = await sendViaBitrix(d, text);
            q.status = "sent"; q.sentAt = new Date().toISOString(); d.coordLastOutDay = today;
            log(q.dealId, "out", `через Битрикс (чат ${r.chatId}): ${text}`);
          } catch (e) {
            q.tries++;
            if (e.permanent || q.tries >= RETRY_MIN.length) { q.status = "failed"; log(q.dealId, "sys", `не отправлено: ${e.message}`); event(d, "error", `Не удалось отправить напоминание: ${e.message}`); }
            else { q.nextTry = Date.now() + RETRY_MIN[q.tries - 1] * 60 * 1000; log(q.dealId, "sys", `ошибка отправки, повтор через ${RETRY_MIN[q.tries - 1]} мин: ${e.message}`); }
          }
          changed = true; continue;
        }
        if (transport() === "none") { q.nextTry = Date.now() + H; continue; }
        const inWindow = c.lastIn[q.chatId] && Date.now() - Date.parse(c.lastIn[q.chatId]) < 23.5 * H;
        const body = { channelId: k.channelId, chatType: "whatsapp", chatId: q.chatId, crmMessageId: q.key };
        let plain = false;
        try { plain = (await chanInfo()).plain; }
        catch (e) { q.tries++; q.nextTry = Date.now() + 30 * 60 * 1000; log(q.dealId, "sys", `Wazzup: ${e.message}`); if (q.tries >= RETRY_MIN.length) { q.status = "failed"; event(d, "error", `Не удалось отправить напоминание: ${e.message}`); } changed = true; continue; }
        if (inWindow || plain) body.text = text;
        else if (k.tpl[q.kind]) { body.templateId = k.tpl[q.kind]; body.templateValues = q.kind === "today" ? q.vals.slice(0, 2) : q.vals; } // «сегодня»: {{1}} имя, {{2}} товар; остальные + {{3}} дата
        else { q.status = "failed"; log(q.dealId, "sys", `нет кода шаблона WAZZUP_TPL_${q.kind.toUpperCase()} — блогер не писал сутки, без шаблона WABA отправить нельзя`); changed = true; continue; }
        if (k.mode === "dry") {
          q.status = "dry"; d.coordLastOutDay = today;
          log(q.dealId, "out", `[ТЕСТ, не отправлено] через Wazzup ${body.text ? "текст" : "шаблон"}: ${text}`);
          changed = true; continue;
        }
        try {
          body.channelId = await channelId();
          await wazzupSend(body);
          q.status = "sent"; q.sentAt = new Date().toISOString(); d.coordLastOutDay = today;
          log(q.dealId, "out", `через Wazzup ${body.text ? "текст" : "шаблон"}: ${text}`);
        } catch (e) {
          q.tries++;
          if (q.tries >= RETRY_MIN.length) { q.status = "failed"; log(q.dealId, "sys", `не отправлено после ${q.tries} попыток: ${e.message}`); event(d, "error", `Не удалось отправить напоминание: ${e.message}`); }
          else { q.nextTry = Date.now() + RETRY_MIN[q.tries - 1] * 60 * 1000; log(q.dealId, "sys", `ошибка отправки, повтор через ${RETRY_MIN[q.tries - 1]} мин: ${e.message}`); }
        }
        changed = true;
      }
      // чистка
      c.queue = c.queue.filter((q) => q.status === "pending" || Date.now() - Date.parse(q.createdAt) < 3 * 24 * H);
      for (const [id, ts] of Object.entries(c.seen)) if (Date.now() - ts > SEEN_KEEP_MS) { delete c.seen[id]; changed = true; }
      for (const [key, iso] of Object.entries(c.keys)) if (Date.now() - Date.parse(iso) > 60 * 24 * H) { delete c.keys[key]; changed = true; }
    } finally { sending = false; }
    if (changed) persist();
  }

  // ---------- Входящие (вебхук Wazzup) ----------
  const RE_LINK = /(https?:\/\/[^\s]*(instagram\.com|tiktok\.com)[^\s]*)/i;
  const RE_DRAFT = /(https?:\/\/[^\s]*(drive\.google\.com|disk\.yandex|yadi\.sk|dropbox\.com|cloud\.mail\.ru|wetransfer\.com|we\.tl)[^\s]*)/i; // черновик на согласование
  const RE_STOP = /(^|\s)(стоп|не пишите|отпиш|хватит писать)/i;
  const RE_YES = /^(да|да,? в силе|в силе|все в силе|всё в силе|ок|окей|хорошо|\+)[.!\s]*$/i;
  const RE_MOVE = /(перенес|перенос|позже|задерж|не успева|не успею|нужно перенести|выложу позже)/i;
  function parseDate(text) {
    const t = String(text).toLowerCase();
    const today = almatyDate();
    if (/послезавтра/.test(t)) return addDays(today, 2);
    if (/завтра/.test(t)) return addDays(today, 1);
    const m = t.match(/\b(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2,4}))?\b/);
    if (!m) return null;
    const dd = +m[1], mm = +m[2];
    if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return null;
    let y = m[3] ? +m[3] : +today.slice(0, 4);
    if (y < 100) y += 2000;
    let ymd = `${y}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    if (!m[3] && ymd < addDays(today, -60)) ymd = `${y + 1}${ymd.slice(4)}`;
    return ymd;
  }
  function handleIncoming(msg, ourChannel) {
    // Адрес вебхука один на весь аккаунт Wazzup (24 номера Sillan, Masterok…): сюда приходят сообщения ВСЕХ клиентов.
    // Берём только наш канал (WAZZUP_CHANNEL_ID), входящие, от номеров из теста. Всё остальное — сразу мимо, ничего не сохраняем.
    if (!msg || !ourChannel || String(msg.channelId || "") !== ourChannel) return false;
    if (msg.isEcho || String(msg.chatType || "whatsapp") !== "whatsapp") return false;
    const chatId = waNumber(msg.chatId);
    if (!chatId) return false;
    const st = getState(), c = C();
    const id = String(msg.messageId || "");
    if (!id || c.seen[id]) return false; // дубль
    c.seen[id] = Date.now();
    // Через Wazzup идёт вся переписка компании — берём только номера из теста, остальное не трогаем и не пишем в журнал.
    const cands = (st.microInfluencerDeals || []).filter((d) => inPilot(d) && waNumber(d.phone) === chatId);
    if (!cands.length) { delete c.seen[id]; return false; }
    c.lastIn[chatId] = new Date().toISOString();
    const today = almatyDate();
    const active = cands.filter((d) => !isPublished(d)).sort((a, b) => Math.abs(daysBetween(today, a.plannedDate || today)) - Math.abs(daysBetween(today, b.plannedDate || today)));
    const d = active[0] || cands[0];
    return processReply(d, String(msg.text || "").trim(), String(msg.type || "text"), msg.contentUri || "");
  }
  // Разбор ответа блогера (общий для Wazzup и бота Битрикса). Дату сам не меняет — только предлагает менеджеру.
  function processReply(d, text, type, url) {
    const today = almatyDate();
    log(d.id, "in", type === "text" ? text : `[${type}] ${url || ""} ${text}`.trim());
    const draft = text.match(RE_DRAFT);
    if (["video", "image", "document", "file"].includes(type) || draft) {
      const u = url || (draft ? draft[1] : "");
      d.coordMedia = (Array.isArray(d.coordMedia) ? d.coordMedia : []).concat([{ at: new Date().toISOString(), type: draft ? "link" : type, url: u }]).slice(-20);
      const isVideo = type === "video" || type === "document" || type === "file" || !!draft;
      if (isVideo && ["wait", "revise", "reshoot"].includes(stageOf(d))) {
        d.vstage = "received"; d.vreceivedAt = new Date().toISOString();
        log(d.id, "sys", "видео пришло — статус «📥 проверить»");
        const ev = event(d, "media", process.env.GEMINI_API_KEY ? "Блогер прислал видео на согласование — 🤖 ИИ разбирает (1–2 мин)" : "Блогер прислал видео на согласование — посмотрите и отправьте тимлиду", { url: u, review: true });
        if (process.env.GEMINI_API_KEY && u) startReview(d, u, ev && ev.id);
      } else event(d, "media", `Блогер прислал ${type === "video" ? "видео" : type === "image" ? "фото" : "файл"} — посмотрите${u ? "" : " в переписке"}`, { url: u });
      return true;
    }
    const link = text.match(RE_LINK);
    if (link) {
      const url = link[1];
      const isTT = /tiktok\.com/i.test(url);
      if (isTT && !d.tiktokVideoLink) d.tiktokVideoLink = url;
      if (!isTT && !d.reelsLink) d.reelsLink = url;
      if (d.videoStatus !== "опубликовано") d.videoStatus = "опубликовано";
      if (!d.publishDate) d.publishDate = today;
      log(d.id, "sys", `ссылка записана (${isTT ? "TikTok" : "Instagram"}), статус «опубликовано»`);
      event(d, "link", `Блогер прислал ссылку — записана, статус «опубликовано»: ${url}`, { info: true });
      return true;
    }
    if (RE_STOP.test(text)) {
      d.coordStop = true;
      log(d.id, "sys", "блогер попросил не писать — автонапоминания остановлены");
      event(d, "stop", `Блогер попросил больше не писать: «${text}». Автонапоминания остановлены — нужен менеджер`);
      return true;
    }
    if (RE_YES.test(text)) { log(d.id, "sys", "подтвердил дату — напоминания по графику"); return true; }
    if (RE_MOVE.test(text)) {
      const nd = parseDate(text);
      d.coordPausedUntil = new Date(Date.now() + 24 * H).toISOString();
      event(d, "move", nd ? `Блогер просит перенести на ${ddmm(nd)}: «${text}»` : `Блогер просит перенести, дату не назвал: «${text}»`, nd ? { proposedDate: nd } : {});
      log(d.id, "sys", `перенос: ${nd ? "предложена дата " + ddmm(nd) + " — ждёт менеджера" : "дата не названа — менеджеру"}; напоминания на паузе 24 ч`);
      return true;
    }
    d.coordPausedUntil = new Date(Date.now() + 24 * H).toISOString();
    event(d, "question", `Сообщение блогера — нужен ответ: «${text || type}»`);
    log(d.id, "sys", "неясное сообщение / вопрос — менеджеру, напоминания на паузе 24 ч");
    return true;
  }
  app.post("/api/wazzup/webhook/:secret", async (req, res) => {
    const k = cfg();
    if (k.secret.length < 16 || req.params.secret !== k.secret) return res.status(404).end();
    res.status(200).json({ ok: true }); // Wazzup ждёт быстрый ответ; разбираем после
    const b = req.body || {};
    const msgs = Array.isArray(b.messages) ? b.messages : [];
    const sts = Array.isArray(b.statuses) ? b.statuses : [];
    if (!msgs.length && !sts.length) return;
    let changed = false;
    try {
      const our = k.apiKey ? (await chanInfo()).id : "";
      for (const m of msgs) if (handleIncoming(m, our)) changed = true;
      for (const s of sts) if (s && s.status === "error" && C().seen[`out:${s.messageId}`]) { log(null, "sys", "Wazzup: ошибка доставки нашего напоминания"); changed = true; }
    } catch (e) { console.error("Wazzup webhook:", e.message); }
    if (changed) persist();
  });

  // ---------- Битрикс24: отправка и бот ----------
  function bxPhoneVariants(n) { return [`+${n}`, n, `8${n.slice(1)}`]; }
  // Чат блогера в открытой линии: Wazzup мог привязать переписку к контакту, сделке контакта, лиду или компании —
  // ищем все объекты CRM с этим телефоном и берём самый свежий чат (imopenlines.crm.chat.get, типы — строчными).
  async function findOpenlineChat(n) {
    const found = { contact: [], deal: [], lead: [], company: [] };
    for (const [et, key] of [["CONTACT", "contact"], ["LEAD", "lead"], ["COMPANY", "company"]]) {
      const f = await bitrix("crm.duplicate.findbycomm", { entity_type: et, type: "PHONE", values: bxPhoneVariants(n) }).catch(() => null);
      if (f && Array.isArray(f[et])) found[key] = f[et].slice(0, 5).map(Number);
    }
    for (const cid of found.contact) {
      const deals = await bitrix("crm.deal.list", { filter: { CONTACT_ID: cid }, select: ["ID"], order: { ID: "DESC" } }).catch(() => []);
      found.deal.push(...(Array.isArray(deals) ? deals : []).slice(0, 5).map((x) => Number(x.ID)));
    }
    const all = [];
    for (const type of ["contact", "deal", "lead", "company"]) {
      for (const id of found[type]) {
        const chats = await bitrix("imopenlines.crm.chat.get", { CRM_ENTITY_TYPE: type, CRM_ENTITY: id, ACTIVE_ONLY: "N" }).catch(() => []);
        for (const ch of Array.isArray(chats) ? chats : []) {
          const chatId = Number(ch.CHAT_ID || ch.chatId);
          if (chatId && !all.some((x) => x.chatId === chatId)) all.push({ chatId, type, id, connector: ch.CONNECTOR_TITLE || ch.CONNECTOR_ID || "" });
        }
      }
    }
    all.sort((a, b) => b.chatId - a.chatId);
    // Только чат нужной открытой линии (COORD_LINE_ID, например 52 — линия с WhatsApp): у блогера могут быть чаты и в других линиях.
    const lineId = String(process.env.COORD_LINE_ID || "").trim();
    let best = null; const lines = [];
    for (const ch of all) {
      const dlg = await bitrix("imopenlines.dialog.get", { CHAT_ID: ch.chatId }).catch(() => null);
      const ent = String((dlg && (dlg.entity_id || dlg.ENTITY_ID)) || "");
      const ln = String((dlg && (dlg.config_id || dlg.CONFIG_ID || dlg.line_id)) || ent.split("|")[1] || "");
      ch.line = ln; ch.owner = dlg && Number(dlg.owner || dlg.OWNER) || 0;
      lines.push(`чат ${ch.chatId} — линия ${ln || "?"}`);
      if (!lineId || ln === lineId) { best = ch; break; }
    }
    let extra = "";
    if (!best && lineId) {
      // Запасной путь: чат линии мог привязаться к другой карточке (новый лид/контакт без телефона в поле PHONE).
      // Смотрим последние диалоги открытых линий в CRM (дела IMOPENLINES_SESSION) и ищем номер в них или в их карточке.
      const r = await findByRecentSessions(n, lineId).catch((e) => ({ err: e.message }));
      if (r && r.best) best = r.best;
      extra = r && r.err ? `; поиск по диалогам: ${r.err}` : r && r.note ? `; ${r.note}` : "";
    }
    const summary = `контакты: ${found.contact.join(",") || "—"}; сделки: ${found.deal.join(",") || "—"}; лиды: ${found.lead.join(",") || "—"}${lines.length ? "; " + lines.slice(0, 5).join(", ") : ""}${lineId ? `; нужна линия ${lineId}` : ""}${extra}`;
    return { best, summary };
  }
  const OWNER_TYPES = { 1: "lead", 2: "deal", 3: "contact", 4: "company" };
  function phonesOf(o) {
    const out = [];
    for (const f of ["PHONE", "IM"]) for (const x of (o && Array.isArray(o[f]) ? o[f] : [])) out.push(String(x.VALUE || ""));
    return out.join(" ");
  }
  // Номер в тексте в любом виде: «+7 701 280-89-60», «87012808960», «77012808960@c.us».
  function hasNum(text, tail) { return String(text || "").replace(/[\s\-().+]/g, "").split(/\D+/).some((x) => x.length >= 10 && x.endsWith(tail)); }
  async function findByRecentSessions(n, lineId) {
    const tail = n.slice(-10);
    const acts = await bitrix("crm.activity.list", {
      order: { ID: "DESC" }, filter: { PROVIDER_ID: "IMOPENLINES_SESSION" },
      select: ["ID", "OWNER_TYPE_ID", "OWNER_ID", "ASSOCIATED_ENTITY_ID", "SUBJECT", "COMMUNICATIONS", "PROVIDER_PARAMS", "ORIGIN_ID"],
    });
    const list = (Array.isArray(acts) ? acts : []).slice(0, 50);
    const seenOwner = new Map(); let lookups = 0; let onLine = 0;
    for (const a of list) {
      const blob = JSON.stringify(a);
      const sid = Number(a.ASSOCIATED_ENTITY_ID) || Number(String(a.ORIGIN_ID || "").replace(/\D/g, "")) || 0;
      const type = OWNER_TYPES[Number(a.OWNER_TYPE_ID)];
      const ownerId = Number(a.OWNER_ID) || 0;
      let hit = hasNum(blob, tail);
      if (!hit && type && ownerId && lookups < 25) {
        const key = `${type}:${ownerId}`;
        if (!seenOwner.has(key)) {
          lookups++;
          let txt = "";
          if (type === "deal") {
            const items = await bitrix("crm.deal.contact.items.get", { id: ownerId }).catch(() => []);
            for (const it of (Array.isArray(items) ? items : []).slice(0, 3)) txt += " " + phonesOf(await bitrix("crm.contact.get", { id: it.CONTACT_ID }).catch(() => null));
          } else txt = phonesOf(await bitrix(`crm.${type}.get`, { id: ownerId }).catch(() => null));
          seenOwner.set(key, hasNum(txt, tail));
        }
        hit = seenOwner.get(key);
      }
      if (!hit) continue;
      const dlg = sid ? await bitrix("imopenlines.dialog.get", { SESSION_ID: sid }).catch(() => null) : null;
      if (!dlg) continue;
      const ent = String(dlg.entity_id || dlg.ENTITY_ID || "");
      const ln = String(dlg.config_id || dlg.CONFIG_ID || dlg.line_id || ent.split("|")[1] || "");
      const chatId = Number(dlg.id || dlg.chat_id || dlg.CHAT_ID || String(dlg.dialog_id || "").replace(/\D/g, "")) || 0;
      if (ln === lineId) onLine++;
      if (ln === lineId && chatId && type && ownerId) return { best: { chatId, type, id: ownerId, line: ln, owner: Number(dlg.owner || dlg.OWNER) || 0 } };
    }
    return { note: `в последних ${list.length} диалогах открытых линий номер ${onLine ? "есть, но чат не открылся" : "не найден"}` };
  }
  async function sendViaBitrix(d, text) {
    const k = cfg();
    const n = waNumber(d.phone);
    const fail = (m) => { const e = new Error(m); e.permanent = true; return e; };
    const { best, summary } = await findOpenlineChat(n);
    if (!best) throw fail(`в Битриксе не найден чат открытой линии с номером +${n} (${summary}) — напишите блогеру вручную`);
    d.coordChatId = best.chatId; d.coordCrm = { type: best.type, id: best.id };
    let userId = k.senderId || best.owner || 0;
    if (!userId) throw fail("не понятно, от чьего имени писать (у чата нет ответственного) — задайте COORD_SENDER_USER_ID");
    await bitrix("imopenlines.crm.message.add", { CRM_ENTITY_TYPE: best.type, CRM_ENTITY: best.id, USER_ID: userId, CHAT_ID: best.chatId, MESSAGE: text });
    return { chatId: best.chatId, contactId: `${best.type} ${best.id}`, userId };
  }
  // Бот Barter Box на открытой линии. Регистрация — кнопкой на сайте; к линии его прикрепляют в Контакт-центре.
  const express = require("express");
  app.post("/api/bitrix/bot/:secret", express.urlencoded({ extended: true, limit: "2mb" }), (req, res) => {
    const k = cfg(), c = C();
    if (k.secret.length < 16 || req.params.secret !== k.secret) return res.status(404).end();
    res.status(200).end(); // отвечаем сразу, разбираем после (повторной доставки у Битрикса нет)
    const b = req.body || {};
    const token = c.botToken || "";
    const auth = b.auth || {};
    if (!token || auth.application_token !== `custom${token}`) { console.error("Бот Битрикса: неверный токен события"); return; }
    if (!/MESSAGEADD/i.test(String(b.event || ""))) return;
    const data = b.data || {};
    const chat = data.chat || {}, msg = data.message || {};
    if (String(chat.entityType || "").toUpperCase() !== "LINES") return;
    const chatId = Number(chat.id || msg.chatId);
    const mid = `bx:${msg.id || ""}`;
    (async () => {
      try {
        if (msg.id && c.seen[mid]) return;
        if (msg.id) c.seen[mid] = Date.now();
        const st = getState();
        const d = (st.microInfluencerDeals || []).find((x) => Number(x.coordChatId) === chatId && inPilot(x));
        if (d) {
          const files = data.files || msg.files || null;
          const hasFile = files && (Array.isArray(files) ? files.length : Object.keys(files).length);
          processReply(d, String(msg.text || "").replace(/\[[^\]]+\]/g, "").trim(), hasFile && !String(msg.text || "").trim() ? "file" : "text", "");
          persist();
        }
      } catch (e) { console.error("Бот Битрикса:", e.message); }
      // Всегда сразу отдаём чат менеджеру — для всех диалогов линии, не только тестовых.
      try { await bitrix("imopenlines.bot.session.operator", { CHAT_ID: chatId }); } catch (e) { console.error("Бот Битрикса → оператор:", e.message); }
    })();
  });

  // ---------- Для сайта ----------
  const staff = (req, res) => { const s = req.session || {}; if (s.role !== "manager" && s.role !== "marketer") { res.status(403).json({ error: "нет доступа" }); return false; } return true; };
  app.get("/api/coord/status", requireAuth, (req, res) => {
    const k = cfg(), c = C();
    res.json({ mode: k.mode, transport: transport(), bot: C().botId || null, manager: k.manager, phones: k.phones, wazzup: !!k.apiKey, templates: { soon: !!k.tpl.soon, today: !!k.tpl.today, overdue: !!k.tpl.overdue },
      webhook: k.secret.length >= 16, queue: c.queue.filter((q) => q.status === "pending").length, log: c.log.slice(-60).reverse() });
  });
  // Каналы и шаблоны WABA из Wazzup — чтобы взять коды для WAZZUP_TPL_* и WAZZUP_CHANNEL_ID без программиста.
  app.get("/api/coord/wazzup-info", requireAuth, async (req, res) => {
    if (!staff(req, res)) return;
    if (!cfg().apiKey) return res.status(400).json({ error: "В Render не задан WAZZUP_API_KEY" });
    const out = {};
    try { const ch = await wazzupGet("/channels"); out.channels = (Array.isArray(ch) ? ch : []).map((c) => ({ channelId: c.channelId, transport: c.transport, plainId: c.plainId, state: c.state })); }
    catch (e) { out.channelsError = e.message; }
    try { const t = await wazzupGet("/templates/whatsapp?limit=100"); out.templates = (Array.isArray(t) ? t : (t && t.data) || []).map((x) => ({ templateGuid: x.templateGuid, title: x.title || x.name || "", status: x.status, text: (x.components && JSON.stringify(x.components).slice(0, 300)) || x.text || "" })); }
    catch (e) { out.templatesError = e.message; }
    res.json(out);
  });
  // Битрикс24 (входящий вебхук BITRIX_WEBHOOK_URL в Render): проверка прав и список открытых линий и ботов.
  // Только чтение — ничего в Битриксе не меняет. Нужна, чтобы узнать ID линии с WhatsApp (Wazzup).
  async function bitrix(method, params) {
    let base = String(process.env.BITRIX_WEBHOOK_URL || "").trim();
    if (!base) throw new Error("В Render не задан BITRIX_WEBHOOK_URL");
    if (!base.endsWith("/")) base += "/";
    const r = await fetch(base + method + ".json", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params || {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(`Битрикс ${method}: ${j.error_description || j.error || r.status}`);
    return j.result;
  }
  app.post("/api/coord/bitrix-bot/register", requireAuth, async (req, res) => {
    if (!staff(req, res)) return;
    const k = cfg(), c = C();
    if (!k.bitrix) return res.status(400).json({ error: "В Render не задан BITRIX_WEBHOOK_URL" });
    if (k.secret.length < 16) return res.status(400).json({ error: "В Render не задан COORD_WEBHOOK_SECRET" });
    if (!c.botToken) c.botToken = crypto.randomBytes(16).toString("hex");
    const base = String(process.env.PUBLIC_URL || `https://${req.get("host")}`).replace(/\/+$/, "");
    try {
      const r = await bitrix("imbot.v2.Bot.register", { code: "barterbox_coord", botToken: c.botToken, type: "bot", isSupportOpenline: true,
        eventMode: "webhook", webhookUrl: `${base}/api/bitrix/bot/${k.secret}`, properties: { name: "Barter Box", workPosition: "Координатор блогеров" } });
      c.botId = (r && r.bot && r.bot.id) || (r && r.id) || r;
      log(null, "sys", `бот Barter Box зарегистрирован в Битриксе (ID ${c.botId}) — прикрепите его к открытой линии в Контакт-центре`);
      persist();
      res.json({ ok: true, botId: c.botId });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  // Тест: одно сообщение на тестовый номер (только из COORD_PILOT_PHONES) — показывает, на каком шаге ошибка.
  app.post("/api/coord/test-send", requireAuth, async (req, res) => {
    if (!staff(req, res)) return;
    const k = cfg();
    const d = (getState().microInfluencerDeals || []).find((x) => inPilot(x) && k.phones.includes(waNumber(x.phone)));
    if (!d) return res.status(400).json({ error: "Нет строки тестового менеджера с номером из COORD_PILOT_PHONES" });
    try {
      const r = await sendNow(d, `Тест Barter Box: проверка связи (${d.blogerName || ""}). Можно не отвечать.`);
      log(d.id, "out", `[проверка] ${r.via}`);
      persist();
      res.json({ ok: true, ...r, blogger: d.blogerName });
    } catch (e) { res.status(400).json({ error: e.message, blogger: d.blogerName }); }
  });
  // Wazzup → Barter Box: куда присылать ответы блогеров. Если в Wazzup уже стоит ДРУГОЙ адрес — не перезаписываем.
  app.post("/api/coord/wazzup/connect", requireAuth, async (req, res) => {
    if (!staff(req, res)) return;
    const k = cfg();
    if (!k.apiKey) return res.status(400).json({ error: "В Render не задан WAZZUP_API_KEY" });
    if (k.secret.length < 16) return res.status(400).json({ error: "В Render не задан COORD_WEBHOOK_SECRET (16+ символов)" });
    const base = String(process.env.PUBLIC_URL || `https://${req.get("host")}`).replace(/\/+$/, "");
    const url = `${base}/api/wazzup/webhook/${k.secret}`;
    try {
      const cur = await wazzupGet("/webhooks").catch(() => null);
      const curUri = String((cur && cur.webhooksUri) || "");
      if (curUri && curUri !== url && !(req.body && req.body.replace === true)) {
        let host = ""; try { host = new URL(curUri).host; } catch (e) { host = "?"; }
        return res.status(409).json({ error: `В Wazzup уже указан другой адрес для вебхуков (${host}).`, host, canReplace: true });
      }
      const r = await fetch(`${WAZZUP}/webhooks`, { method: "PATCH", headers: { Authorization: `Bearer ${k.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ webhooksUri: url, subscriptions: { messagesAndStatuses: true } }) });
      const txt = await r.text();
      if (!r.ok) throw new Error(`Wazzup ${r.status}: ${txt.slice(0, 200)}`);
      log(null, "sys", "Wazzup: ответы блогеров подключены к Barter Box");
      persist();
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.get("/api/coord/bitrix-info", requireAuth, async (req, res) => {
    if (!staff(req, res)) return;
    if (!process.env.BITRIX_WEBHOOK_URL) return res.status(400).json({ error: "В Render не задан BITRIX_WEBHOOK_URL" });
    const out = {};
    try { out.scope = await bitrix("scope"); } catch (e) { out.scopeError = e.message; }
    try {
      const l = await bitrix("imopenlines.config.list.get", { PARAMS: { select: ["ID", "LINE_NAME", "ACTIVE"] } });
      out.lines = (Array.isArray(l) ? l : []).map((x) => ({ id: x.ID, name: x.LINE_NAME, active: x.ACTIVE }));
    } catch (e) { out.linesError = e.message; }
    try {
      const b = await bitrix("imbot.bot.list");
      out.bots = Object.values(b || {}).map((x) => ({ id: x.ID, code: x.CODE, type: x.TYPE, openline: x.OPENLINE }));
    } catch (e) { out.botsError = e.message; }
    res.json(out);
  });
  app.post("/api/coord/events/:id/read", requireAuth, (req, res) => {
    if (!staff(req, res)) return;
    const e = C().events.find((x) => x.id === req.params.id);
    if (!e) return res.status(404).json({ error: "не найдено" });
    e.read = true; e.readAt = new Date().toISOString(); persist(); res.json(e);
  });
  app.post("/api/coord/events/:id/accept-date", requireAuth, (req, res) => {
    if (!staff(req, res)) return;
    const e = C().events.find((x) => x.id === req.params.id);
    if (!e || !e.proposedDate) return res.status(404).json({ error: "нет предложенной даты" });
    const d = (getState().microInfluencerDeals || []).find((x) => x.id === e.dealId);
    if (!d) return res.status(404).json({ error: "строка удалена" });
    moveDeal(d, e.proposedDate, "блогер попросил перенос"); d.coordPausedUntil = null;
    if (stageOf(d) !== "approved") { d.vmissed = 0; d.vepoch = new Date().toISOString(); if (d.vstage === "revise" || d.vstage === "reshoot") d.vdue = prevWorkday(e.proposedDate) < almatyDate() ? almatyDate() : prevWorkday(e.proposedDate); }
    e.read = true; e.readAt = new Date().toISOString();
    log(d.id, "sys", `менеджер принял новую дату ${ddmm(e.proposedDate)}`);
    try { planReminders(); } catch (er) {}
    persist(); res.json({ ok: true, plannedDate: d.plannedDate });
  });
  // Принудительно: отправить напоминание этой строке СЕЙЧАС (кнопка «📨 напомнить сейчас»). Ручное действие менеджера:
  // работает и в режиме dry, без тихих часов и графика; но только в рамках теста (менеджер + номера из COORD_PILOT_PHONES).
  app.post("/api/coord/deal/:id/send-now", requireAuth, async (req, res) => {
    if (!staff(req, res)) return;
    const d = (getState().microInfluencerDeals || []).find((x) => x.id === +req.params.id);
    if (!d) return res.status(404).json({ error: "не найдено" });
    if (!inPilot(d)) return res.status(400).json({ error: "Строка не в тесте: ответственный должен быть " + (cfg().manager || "(не задан COORD_PILOT_MANAGER)") + ", номер — из COORD_PILOT_PHONES" });
    if (transport() === "none") return res.status(400).json({ error: "Отправка не настроена: в Render нет WAZZUP_API_KEY / BITRIX_WEBHOOK_URL" });
    const pd = String(d.plannedDate || "").slice(0, 10), today = almatyDate();
    const stage = stageOf(d), due = dueOf(d);
    let kind, ds;
    if (stage === "approved") { kind = "link_ask"; ds = ddmm(pd); }
    else if (stage === "received") return res.status(400).json({ error: "Видео уже пришло и ждёт проверки — блогеру напоминать не нужно" });
    else if (stage === "published") return res.status(400).json({ error: "Уже опубликовано" });
    else if (!due) return res.status(400).json({ error: "Нет плановой даты" });
    else if ((Number(d.vmissed) || 0) >= 1 || today > due) { kind = "overdue"; ds = ddmm(d.vdueMissed || due); }
    else if (today === due) { kind = "due_today"; ds = ddmm(due); }
    else { kind = "due_soon"; ds = ddmm(due); }
    const vals = [nameOf(d), d.product || "интеграции", ds];
    const text = TEXTS[kind](vals);
    try {
      const r = await sendNow(d, text);
      d.coordLastOutDay = today;
      log(d.id, "out", `[вручную] ${r.via}: ${text}`);
      persist();
      res.json({ ok: true, text, ...r });
    } catch (e) {
      log(d.id, "sys", `[вручную] не отправлено: ${e.message}`);
      persist();
      res.status(400).json({ error: e.message });
    }
  });
  // Кнопки менеджера по видео: approve / revise / reshoot / received / wait. Дату двигает сама (рабочие дни),
  // блогеру пишет только в тесте (inPilot) и если координатор включён; в режиме dry — только в журнал.
  // ---------- ИИ-разбор видео (Gemini, наставления как у Telegram-бота) ----------
  // По одному видео за раз. Результат — d.vreview {status, text, decision, score}; уведомление менеджеру обновляется.
  const reviewQueue = [];
  let reviewing = false;
  function startReview(d, url, eventId) {
    d.vreview = { status: "running", at: new Date().toISOString(), url };
    reviewQueue.push({ dealId: d.id, url, eventId });
    runReviews();
  }
  async function runReviews() {
    if (reviewing) return;
    reviewing = true;
    try {
      while (reviewQueue.length) {
        const job = reviewQueue.shift();
        const find = () => (getState().microInfluencerDeals || []).find((x) => x.id === job.dealId);
        let res = null, err = null;
        try { res = await reviewVideo(job.url); } catch (e) { err = e.message; }
        const d = find();
        if (!d) continue;
        const ev = job.eventId ? C().events.find((e) => e.id === job.eventId) : null;
        if (res) {
          d.vreview = { status: "done", at: new Date().toISOString(), url: job.url, text: String(res.text).slice(0, 12000), decision: res.decision, score: res.score, formal: res.formal, model: res.model };
          const head = `🤖 ИИ: ${res.decision || "разбор готов"}${res.score != null ? ` · ${res.score}/9` : ""}`;
          log(d.id, "sys", `ИИ разобрал видео: ${res.decision || "?"}${res.score != null ? " " + res.score + "/9" : ""}`);
          if (ev) { ev.text = `Блогер прислал видео на согласование. ${head} — посмотрите разбор и отправьте тимлиду`; ev.read = false; }
          else event(d, "media", `${head} — посмотрите разбор и отправьте тимлиду`, { url: job.url, review: true });
        } else {
          d.vreview = { status: "error", at: new Date().toISOString(), url: job.url, error: String(err).slice(0, 300) };
          log(d.id, "sys", `ИИ не разобрал видео: ${err}`);
          if (ev) { ev.text = `Блогер прислал видео на согласование. ИИ не смог разобрать (${String(err).slice(0, 150)}) — посмотрите сами`; ev.read = false; }
        }
        persist();
      }
    } finally { reviewing = false; }
  }
  const actorName = (req) => {
    const s = req.session || {};
    if (s.name) return s.name;
    try { return decodeURIComponent(String(req.headers["x-actor"] || "")).trim().slice(0, 60); } catch (e) { return ""; }
  };
  app.post("/api/coord/deal/:id/ai-review", requireAuth, (req, res) => {
    if (!staff(req, res)) return;
    const d = (getState().microInfluencerDeals || []).find((x) => x.id === +req.params.id);
    if (!d) return res.status(404).json({ error: "не найдено" });
    if (!process.env.GEMINI_API_KEY) return res.status(400).json({ error: "В Render не задан GEMINI_API_KEY" });
    const media = (Array.isArray(d.coordMedia) ? d.coordMedia : []).slice().reverse().find((m) => m.url);
    const url = String((req.body && req.body.url) || (media && media.url) || "").trim();
    if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: "Нет присланного видео (ссылки на файл) для проверки" });
    startReview(d, url, null);
    persist();
    res.json({ ok: true, status: "running" });
  });
  async function tellBlogger(d, kind, vals) {
    const k = cfg();
    if (k.mode === "off" || !inPilot(d) || transport() === "none" || d.coordStop) return "";
    const text = TEXTS[kind](vals);
    if (k.mode === "dry") { log(d.id, "out", `[ТЕСТ, не отправлено] ${text}`); return "тест: не отправлено"; }
    try { const r = await sendNow(d, text); log(d.id, "out", `${r.via}: ${text}`); return "отправлено блогеру"; }
    catch (e) { log(d.id, "sys", `не отправлено: ${e.message}`); event(d, "error", `Не удалось написать блогеру: ${e.message}`); return "не отправлено: " + e.message; }
  }
  app.post("/api/coord/deal/:id/video", requireAuth, async (req, res) => {
    if (!staff(req, res)) return;
    if (req.session && req.session.readOnly) return res.status(403).json({ error: "только просмотр" });
    const d = (getState().microInfluencerDeals || []).find((x) => x.id === +req.params.id);
    if (!d) return res.status(404).json({ error: "не найдено" });
    const b = req.body || {};
    const action = String(b.action || "");
    const comment = String(b.comment || "").trim().slice(0, 1500);
    const today = almatyDate(), now = new Date().toISOString();
    const pd = String(d.plannedDate || "").slice(0, 10);
    if (isDone(d) && action !== "wait") return res.status(400).json({ error: "Уже опубликовано" });
    let sent = "";
    const wasLead = stageOf(d) === "lead";
    const who = actorName(req) || "менеджер";
    const closeEvents = () => { for (const e of C().events) if (e.dealId === d.id && (e.kind === "media" || e.kind === "lead") && !e.read) { e.read = true; e.readAt = now; } };
    if (action === "to_lead") {
      const lead = leadOf(d.responsible);
      d.vstage = "lead"; d.vstageAt = now; d.vleadAt = now; d.vleadComment = comment || null; d.vleadFrom = who; d.vlead = lead;
      closeEvents();
      const r = d.vreview && d.vreview.status === "done" ? ` · 🤖 ${d.vreview.decision || ""}${d.vreview.score != null ? " " + d.vreview.score + "/9" : ""}` : "";
      const media = (Array.isArray(d.coordMedia) ? d.coordMedia : []).slice().reverse().find((m) => m.url);
      event(d, "lead", `На согласование от ${who}${r}${comment ? ` · комментарий: ${comment}` : ""}`, { to: lead, review: true, lead: true, url: media ? media.url : "" });
      log(d.id, "sys", `${who} отправил(а) видео на согласование тимлиду (${lead})`);
      try { planReminders(); } catch (er) {}
      persist();
      return res.json({ ok: true, stage: "lead", lead, plannedDate: d.plannedDate });
    }
    if (action === "approve") {
      if (!pd || pd < today) moveDeal(d, today, "одобрено после плановой даты — публикация сегодня");
      // Утром перенесли с сегодня (видео не было к 10:00), а днём прислали и одобрили — возвращаем на сегодня («сверх плана»).
      else if (pd > today && d.vmoved && d.vmoved.from === today && /к утру/.test(d.vmoved.why || "")) moveDeal(d, today, "одобрено днём — вернули на сегодня");
      d.vstage = "approved"; d.vstageAt = now; d.vmissed = 0; d.vdueMissed = null;
      const npd = String(d.plannedDate).slice(0, 10);
      log(d.id, "sys", `менеджер одобрил видео, публикация ${ddmm(npd)}`);
      sent = await tellBlogger(d, "approved", [nameOf(d), d.product || "", npd === today ? "сегодня" : ddmm(npd)]);
    } else if (action === "revise" || action === "reshoot") {
      const days = Math.max(1, Math.min(10, Number(b.days) || (action === "revise" ? 1 : 2)));
      // Исправленное видео ждём через N рабочих дней от сегодня; публикацию двигаем, только если она раньше,
      // чем рабочий день после нового срока (видео пришло заранее — дата публикации остаётся).
      const due = addWorkdays(today, days);
      const minPub = nextWorkday(due);
      if (!pd || pd < minPub) moveDeal(d, minPub, action === "revise" ? "правки" : "пересъём");
      d.vstage = action; d.vstageAt = now; d.vepoch = now; d.vmissed = 0; d.vdueMissed = null;
      d.vdue = due; d.vcomment = comment || null; d.vrounds = (Number(d.vrounds) || 0) + 1;
      // Сами правки менеджер пишет блогеру в чате — бот их не отправляет. Если новый срок уже сегодня, не дёргаем блогера
      // напоминанием сразу после разговора с менеджером.
      log(d.id, "sys", `${action === "revise" ? "правки" : "пересъём"}: исправленное видео ждём ${ddmm(d.vdue)}, публикация ${ddmm(String(d.plannedDate).slice(0, 10))}`);
    } else if (action === "received") {
      d.vstage = "received"; d.vstageAt = now; d.vreceivedAt = now;
      log(d.id, "sys", "менеджер отметил: видео пришло");
    } else if (action === "wait") {
      d.vstage = "wait"; d.vstageAt = now; d.vepoch = now; d.vmissed = 0; d.vdueMissed = null; d.vdue = null;
      log(d.id, "sys", "менеджер вернул в «ждём видео»");
    } else return res.status(400).json({ error: "неизвестное действие" });
    // Закрываем уведомления «прислал видео» / «на согласование» по этой строке.
    closeEvents();
    // Решение тимлида — менеджеру строки (если решал не он сам).
    if (wasLead && ["approve", "revise", "reshoot"].includes(action) && personKey(who) !== personKey(d.responsible)) {
      const verdict = action === "approve" ? "✅ одобрил(а) видео" : action === "revise" ? "✏️ вернул(а) на правки" : "🔁 просит переснять";
      event(d, action === "approve" ? "info" : "question", `${who} ${verdict}${comment ? `: ${comment}` : ""}${action !== "approve" ? " — напишите блогеру правки" : ""}`, action === "approve" ? { info: true } : {});
    }
    // Одобрено днём на сегодня после фиксации плана — «сверх плана» (видно в планере).
    try { planReminders(); } catch (er) {}
    persist();
    res.json({ ok: true, stage: stageOf(d), plannedDate: d.plannedDate, vdue: d.vdue || null, sent });
  });
  app.post("/api/coord/dayplan/run", requireAuth, (req, res) => {
    if (!staff(req, res)) return;
    const s = req.session || {};
    if (s.role !== "manager" || s.readOnly) return res.status(403).json({ error: "только менеджер" });
    const done = runDayPlan(true);
    res.json({ ok: done, today: almatyDate(), plan: (getState().dayPlan || {})[almatyDate()] || null });
  });
  app.post("/api/coord/deal/:id/stop", requireAuth, (req, res) => {
    if (!staff(req, res)) return;
    const d = (getState().microInfluencerDeals || []).find((x) => x.id === +req.params.id);
    if (!d) return res.status(404).json({ error: "не найдено" });
    d.coordStop = !(req.body && req.body.resume);
    log(d.id, "sys", d.coordStop ? "менеджер выключил автонапоминания" : "менеджер включил автонапоминания");
    persist(); res.json({ ok: true, coordStop: d.coordStop });
  });

  setInterval(() => { try { planReminders(); } catch (e) { console.error("Координатор (план):", e.message); } }, 10 * 60 * 1000);
  setInterval(() => { processQueue().catch((e) => console.error("Координатор (отправка):", e.message)); }, 60 * 1000);
  setTimeout(() => { try { planReminders(); } catch (e) {} }, 15000);
  setInterval(() => { try { runDayPlan(false); } catch (e) { console.error("План дня:", e.message); } }, 5 * 60 * 1000);
  setTimeout(() => { try { runDayPlan(false); } catch (e) {} }, 20000);
  return { planReminders, processQueue, handleIncoming, parseDate, waNumber, runDayPlan, stageOf };
};
