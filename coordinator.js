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
const { reviewVideo, classifyVideo } = require("./video-review.js");
const videoFlow = require("./video-flow.js");

const H = 3600 * 1000;
const WAZZUP = "https://api.wazzup24.com/v3";
const MAX_LOG = 6000, MAX_EVENTS = 500, SEEN_KEEP_MS = 7 * 24 * H;
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
    if (dir === "out" && dealId) { const d = (getState().microInfluencerDeals || []).find((x) => x.id === dealId); const n = d && waNumber(d.phone); if (n && c.inbox && c.inbox[n]) { const t = new Date().toISOString(); c.inbox[n].lastOut = t; tzSentMark(c.inbox[n], t, String(text || ""), extra && extra.type); } }
  };
  const event = (d, kind, text, extra) => {
    const c = C();
    c.events.push(Object.assign({ id: crypto.randomBytes(6).toString("hex"), at: new Date().toISOString(), dealId: d ? d.id : null,
      to: d ? (d.responsible || cfg().manager) : cfg().manager, blogger: d ? d.blogerName : "", kind, text: String(text).slice(0, 600), read: false }, extra || {}));
    if (c.events.length > MAX_EVENTS) c.events.splice(0, c.events.length - MAX_EVENTS);
    return c.events[c.events.length - 1];
  };
  // ---------- «Входящие» (23.11.2026) ----------
  // Все диалоги с блогерами — общий номер Wazzup и номер ChatApp, все менеджеры. Сообщение привязывается к интеграции по телефону
  // (ближайшая по дате, ещё не вышедшая), пишется в переписку карточки. «Ждёт ответа» — последнее сообщение от блогера.
  // Блогерам здесь ничего не отправляется автоматически.
  const IB = () => { const c = C(); c.inbox = c.inbox && typeof c.inbox === "object" ? c.inbox : {}; return c.inbox; };
  const dealsByPhone = (n) => (getState().microInfluencerDeals || []).filter((d) => waNumber(d.phone) === n && !/отмен/i.test(String(d.problemStatus || "")));
  function pickDeal(list) {
    const today = almatyDate(), act = list.filter((d) => !isPublished(d)), pool = act.length ? act : list;
    const dist = (d) => Math.abs(daysBetween(today, String(d.plannedDate || today).slice(0, 10)) || 0);
    return pool.slice().sort((a, b) => dist(a) - dist(b))[0] || null;
  }
  const isVideoMsg = (type, url, name) => String(type) === "video" || /\.(mp4|mov|webm|m4v)(?:$|[?#])/i.test(String(url || "") + " " + String(name || ""));
  // 24.11.2026: блогер просит ТЗ / сценарий → у менеджера «Просят ТЗ», пока ТЗ не отправлено (наш файл или сообщение с «ТЗ»).
  const TZ_ASK_RE = /(^|[^а-яёa-z])(тз|т\.з|техническ[а-яё]*\s*задани[а-яё]*|техзадани[а-яё]*|сценари[а-яё]*|бриф[а-яё]*|задани[ея]|тапсырма[а-яә]*)([^а-яёa-z]|$)/i;
  const tzSentMark = (row, t, body, type) => { if (row && row.tzAskAt && (TZ_ASK_RE.test(body) || /^(file|document|pdf)$/i.test(String(type || "")) || /\.pdf(\b|$)/i.test(body))) row.tzSentAt = t; };
  function inboxRecord({ phone, side, text, type, url, via, id, at, noLog }) {
    const n = waNumber(phone); if (!n) return null;
    const c = C();
    if (id) { const key = "ib:" + via + ":" + id; if (c.seen[key]) return null; c.seen[key] = Date.now(); }
    const list = dealsByPhone(n); if (!list.length) return null;
    const d = pickDeal(list); if (!d) return null;
    const ib = IB(), t = at || new Date().toISOString();
    const row = ib[n] = Object.assign(ib[n] || { phone: n }, { dealId: d.id, manager: d.responsible || "", blogger: d.blogerName || d.instagramAccount || "", via });
    const body = type && type !== "text" ? `[${type === "video" ? "видео" : type === "image" ? "фото" : type === "audio" ? "голосовое" : "файл"}] ${text || ""} ${url || ""}`.trim() : String(text || "").trim();
    if (side === "in") { if (via === "wazzup") c.lastIn[n] = t; row.lastIn = t; row.lastInText = body.slice(0, 300); row.lastInType = type || "text";
      if (TZ_ASK_RE.test(String(text || ""))) { row.tzAskAt = t; row.tzAskText = String(text || "").slice(0, 200); } }
    else { row.lastOut = t; tzSentMark(row, t, body, type); }
    if (!noLog) log(d.id, side === "in" ? "in" : "out", (side === "in" ? "" : "мы (" + via + "): ") + body);
    const keys = Object.keys(ib); if (keys.length > 4000) { keys.sort((a, b) => String(ib[a].lastIn || ib[a].lastOut || "").localeCompare(String(ib[b].lastIn || ib[b].lastOut || ""))).slice(0, keys.length - 4000).forEach((k) => delete ib[k]); }
    return { d, row };
  }
  const waiting = (r) => !!r.lastIn && r.lastIn > (r.lastOut || "") && r.lastIn > (r.doneAt || "");
  const inPilot = (d) => {
    const k = cfg();
    // COORD_PILOT_MANAGER — одно имя или несколько через запятую: «Марина, Камила».
    const mgrs = k.manager.split(/[,;]+/).map((x) => personKey(x)).filter(Boolean);
    if (!mgrs.length || !mgrs.includes(personKey(d.responsible))) return false;
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
  // Сколько рабочих дней прошло после срока (срок не считается): срок пн, сегодня ср → 2.
  const workdaysAfter = (due, today) => { if (!due || today <= due) return 0; let n = 0, x = due; while (x < today) { x = addDays(x, 1); if (isWd(x)) n++; } return n; };
  const isDone = (d) => isPublished(d) || (!!d.publishDate && String(d.publishDate).slice(0, 10) <= almatyDate()); // 23.11.2026: будущая дата выкладки — ещё не вышло
  const stageOf = (d) => (isDone(d) ? "published" : ["received", "lead", "revise", "reshoot", "approved"].includes(d.vstage) ? d.vstage : "wait");
  // Тимлиды (как в Barter Box: группы менеджеров). Чужой/неизвестный менеджер — к COORD_TEAMLEAD (по умолчанию Нина).
  const TEAM_GROUPS = [
    { lead: "Нина", members: ["Мадина", "Марина", "Зарина", "Камила"] },
    { lead: "Сая", members: ["Надира", "Анастасия", "Сабрина", "Оксана"] },
    { lead: "Анеля", members: ["Ажар"] }, // с ноября 2026
  ];
  const leadOf = (resp) => {
    const k = personKey(resp);
    const g = TEAM_GROUPS.find((x) => personKey(x.lead) === k || x.members.some((m) => personKey(m) === k));
    return g ? g.lead : String(process.env.COORD_TEAMLEAD || "Нина");
  };
  // Срок сдачи видео на согласование: после правок — свой (vdue), иначе рабочий день до публикации.
  const dueOf = (d) => { const pd = String(d.plannedDate || "").slice(0, 10); if (!pd) return ""; return (d.vstage === "revise" || d.vstage === "reshoot") && d.vdue ? d.vdue : prevWorkday(pd); };
  // «завтра» или «в понедельник (09.11)» (если между сегодня и сроком выходные).
  const WD = ["в воскресенье", "в понедельник", "во вторник", "в среду", "в четверг", "в пятницу", "в субботу"];
  const whenWord = (today, ymd) => (daysBetween(today, ymd) === 1 ? "завтра" : `${WD[new Date(ymd + "T00:00:00Z").getUTCDay()]} (${ddmm(ymd)})`);
  const nameOf = (d) => String(d.blogerName || "").replace(/@/g, "").trim() || "здравствуйте";
  // 19.11.2026: автонапоминания блогерам выключены (решение Нины) — включаются только COORD_AUTO_REMIND=on.
  // Менеджер напоминает вручную: кнопка в карточке интеграции и «Напомнить всем без видео» (remindNow).
  const autoRemind = () => String(process.env.COORD_AUTO_REMIND || "").toLowerCase() === "on";
  function planReminders() {
    const k = cfg();
    if (k.mode === "off") return;
    const st = getState(), c = C(), today = almatyDate(), hour = almatyHour();
    let changed = false;
    const queue = (d, kind, key, dateStr, extra) => {
      if (!autoRemind()) return;
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
      if (stage === "published" && !d.vthanksAt && !d.coordStop && (d.vstage || d.coordLastOutDay) && hour >= 10 && hour < 20) {
        // Менеджер отметил публикацию (ссылка/факт-дата) — один раз спасибо блогеру, только по свежим публикациям.
        const pub = String(d.publishDate || today).slice(0, 10);
        d.vthanksAt = new Date().toISOString(); changed = true;
        if (daysBetween(pub, today) <= 2) tellBlogger(d, "link_thanks", [nameOf(d), d.product || "", ""]).then(() => persist()).catch(() => {});
      }
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
        const due = dueOf(d), missed = workdaysAfter(due, today), ep = `${d.vepoch || ""}|${pd}`; // новая дата выхода (менеджер поменял) — новый цикл напоминаний
        if (missed >= 3) { next = { text: "молчит 3 дня — напоминания остановлены, нужен менеджер" }; mgrOnce(d, `${d.id}:mgr-silent:${ep}`, "overdue", `Видео не прислали уже ${missed} раб. дня после срока — блогеру больше не пишем, нужен менеджер`); }
        else if (!pausedTill) {
          let kind = null, key = null, ds = ddmm(due);
          if (missed >= 1) { kind = "overdue"; key = `${d.id}:overdue:${ep}`; ds = ddmm(due); }
          else if (today === due) { kind = "due_today"; key = `${d.id}:due_today:${due}`; }
          else if (today === prevWorkday(due) || (today < due && daysBetween(today, due) === 1)) { kind = "due_soon"; key = `${d.id}:due_soon:${due}`; ds = whenWord(today, due); }
          if (kind && !c.keys[key]) queue(d, kind, key, ds);
        }
        if (!next) next = { text: pausedTill ? `пауза до ${new Date(d.coordPausedUntil).toLocaleString("ru-RU", { timeZone: "Asia/Almaty" })}`
          : missed >= 1 ? (cfg().mode === "on" ? "срок сдачи прошёл — спросили, когда пришлёт" : "срок сдачи прошёл — бот в тестовом режиме, блогеру не писали") : today < due ? `видео на согласование ждём ${ddmm(due)}; напомним накануне` : `сегодня ждём видео на согласование` };
      }
      if (!autoRemind() && next && !d.coordStop && !["published", "lead", "received"].includes(stage) && pd) next = { text: next.text + " · автонапоминания выключены — напомнить кнопкой" };
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
    if (from && from !== to) d.planHistory = (Array.isArray(d.planHistory) ? d.planHistory : []).concat([{ at: new Date().toISOString(), from, to, by: why || "" }]).slice(-30);
  }
  // 11.11.2026 (ТЗ MIXIT §12): дату НЕ двигаем. Плановая дата = согласованная с блогером; поменять её может только
  // менеджер (или «Принять дату» по просьбе блогера). В DAYPLAN_HOUR (10:00 Алматы) фиксируем НЕИЗМЕНЯЕМЫЙ снимок
  // плана дня по всем командам: видео, согласованные (✅) или уже вышедшие, с датой на сегодня. Согласованное позже
  // попадает в текущий план («сверх плана»), снимок не переписывается. DAYPLAN_SCOPE=off — снимок не делаем.
  function runDayPlan(force) {
    const sc = String(process.env.DAYPLAN_SCOPE || "all").toLowerCase();
    if (sc === "off") return false;
    const st = getState(), today = almatyDate();
    const hourFix = Number(process.env.DAYPLAN_HOUR) || 10;
    st.dayPlan = st.dayPlan && typeof st.dayPlan === "object" ? st.dayPlan : {};
    if (st.dayPlan[today] && st.dayPlan[today].v === 2) return false; // снимок дня уже есть — не переписываем
    if (!force && almatyHour() < hourFix) return false;
    const ids = (st.microInfluencerDeals || []).filter((d) => String(d.plannedDate || "").slice(0, 10) === today && ["approved", "published"].includes(stageOf(d))).map((d) => d.id);
    st.dayPlan[today] = { v: 2, at: new Date().toISOString(), ids };
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
    // Тексты утверждены Ниной 03.11.2026 (без «Это MIXIT» — блогеры и так знают, кто пишет).
    overdue: (v) => `Здравствуйте! Видео на согласование ждали ${v[2]}. Подскажите, пожалуйста, когда сможете прислать? 🙏`,
    due_soon: (v) => `Добрый день! 🌸 Ожидаем ${v[2]} видео на согласование 🤍`,
    due_today: (v) => `Добрый день! Сегодня ожидаем видео на согласование.`, // Нина 23.11.2026
    video_today: (v) => `Добрый день! Сегодня ожидаем видео на согласование.`, // кнопка менеджера «Сегодня ждём видео»
    link_ask: (v) => `Здравствуйте! Сегодня день публикации 🎬 Когда выложите, пришлите, пожалуйста, ссылку 💚`,
    approved: (v) => `Спасибо! 💚 Видео согласовано ✅ Публикация ${v[2]} - когда выложите, пришлите, пожалуйста, ссылку 🙏`,
    received_ack: (v) => `Спасибо, видео получили! 🙌 Посмотрим и вернёмся с ответом ${v[2]}`,
    link_thanks: (v) => `Спасибо!`, // Нина 23.11.2026: без «приятно было работать» — не прощаемся
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
    if (chatappFor(d.phone)) { const n = waNumber(d.phone); await chatapp.send({ chatId: n, text }); return { via: `через ChatApp (менеджер ${d.responsible || "—"})`, chatId: n, contactId: "—", userId: "—" }; }
    if (transport() === "bitrix") { const r = await sendViaBitrix(d, text); return { via: `через Битрикс (чат ${r.chatId})`, ...r }; }
    if (transport() !== "wazzup") throw new Error("Отправка не настроена: в Render нет WAZZUP_API_KEY / BITRIX_WEBHOOK_URL");
    const ch = await chanInfo();
    const n = waNumber(d.phone);
    const inWindow = C().lastIn[n] && Date.now() - Date.parse(C().lastIn[n]) < 23.5 * H;
    if (!ch.plain && !inWindow) throw new Error("канал WABA: блогер не писал сутки, свободный текст нельзя — только шаблоном (автонапоминание)");
    await wazzupSend({ channelId: ch.id, chatType: "whatsapp", chatId: n, text, crmMessageId: `bb-manual-${d.id}-${Date.now()}` });
    return { via: `через Wazzup (${ch.phone})`, chatId: n, contactId: "—", userId: "—" };
  }
  // ChatApp (20.11.2026): блогерам менеджеров из CHATAPP_MANAGERS пишем со второго номера (ChatApp), остальным — Wazzup.
  // Менеджер определяется по номеру получателя: интеграция с этим телефоном → ответственный. Тимлидам (согласование) — Wazzup.
  const chatapp = require("./chatapp").createChatApp({});
  const CHATAPP_MANAGERS_DEFAULT = "Анастасия, Надира, Сабрина, Оксана, Сая, Анеля";
  const chatappManagers = () => String(process.env.CHATAPP_MANAGERS || CHATAPP_MANAGERS_DEFAULT).split(/[,;]+/).map((x) => personKey(x)).filter(Boolean);
  function chatappFor(phone) {
    if (!chatapp.configured()) return null;
    const n = waNumber(phone); if (!n) return null;
    const st = getState();
    const deals = (st.microInfluencerDeals || []).concat(st.influencerDeals || []).filter((d) => waNumber(d.phone) === n && d.responsible);
    if (!deals.length) return null;
    const d = deals.sort((a, b) => String(b.plannedDate || b.createdAt || "").localeCompare(String(a.plannedDate || a.createdAt || "")))[0];
    return chatappManagers().includes(personKey(d.responsible)) ? d.responsible : null;
  }
  if (chatapp.configured()) setTimeout(() => chatapp.check().then((r) => console.log("ChatApp:", r.ok ? `вход OK, лицензия ${r.license}, мессенджер ${r.messenger}; менеджеры: ${chatappManagers().join(", ")}` : `ошибка — ${r.error}`)).catch(() => {}), 5000).unref();
  // 24.11.2026 Нина: отправить блогеру договор или базовое ТЗ — с того же номера, что и переписка.
  // ChatApp умеет файл — шлём файлом с подписью; иначе (Wazzup / Битрикс) — текстом со ссылкой.
  async function sendToBlogger({ phone, dealId, text, fileUrl, fileName }) {
    const n = waNumber(phone); if (!n) throw new Error("нет номера WhatsApp — впишите телефон в интеграцию");
    const d = (getState().microInfluencerDeals || []).find((x) => x.id === +dealId) || { id: null, phone, responsible: "" };
    if (fileUrl && chatappFor(phone)) { await chatapp.send({ chatId: n, contentUri: fileUrl, fileName, caption: text }); if (d.id) log(d.id, "out", `[вручную] через ChatApp: ${text} (файл ${fileName || ""})`); return "ChatApp"; }
    const full = fileUrl ? `${text}\n${fileUrl}` : text;
    const r = await sendNow(d, full); if (d.id) log(d.id, "out", `[вручную] ${r.via}: ${full}`); return r.via;
  }
  app.locals.bbSendToBlogger = sendToBlogger;
  app.locals.bbScope = (req) => paidScope(req);
  // Базовое ТЗ блогеру: ссылка на страницу ТЗ (без входа, подписанная), в интеграции фиксируется, какое ТЗ и когда ушло.
  const TZ_KEY = crypto.createHash("sha256").update("bb-tz-link|" + (process.env.SESSION_SECRET || [process.env.MANAGER_PASSWORD, process.env.MARKETER_PASSWORD, process.env.ANNA_PASSWORD].filter(Boolean).join("|") || "barter-box-fallback-key")).digest();
  const tzSig = (id) => crypto.createHmac("sha256", TZ_KEY).update(String(id)).digest("hex").slice(0, 20);
  const escH = (t) => String(t == null ? "" : t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  function tzMd(md) {
    const inl = (t) => escH(t).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
    const L = String(md || "").replace(/\r/g, "").split("\n"), out = []; let i = 0;
    while (i < L.length) { const l = L[i];
      if (/^\s*\|/.test(l)) { const rows = []; while (i < L.length && /^\s*\|/.test(L[i])) { if (!/^\s*\|[\s:|-]+\|?\s*$/.test(L[i])) rows.push(L[i].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim())); i++; }
        out.push("<table>" + rows.map((r, k) => "<tr>" + r.map((c) => (k ? "<td>" : "<th>") + inl(c) + (k ? "</td>" : "</th>")).join("") + "</tr>").join("") + "</table>"); continue; }
      if (/^\s*[-*•]\s+/.test(l)) { const it = []; while (i < L.length && /^\s*[-*•]\s+/.test(L[i])) { it.push("<li>" + inl(L[i].replace(/^\s*[-*•]\s+/, "")) + "</li>"); i++; } out.push("<ul>" + it.join("") + "</ul>"); continue; }
      const h = /^(#{1,3})\s+(.*)$/.exec(l); if (h) { out.push(`<h${h[1].length}>${inl(h[2])}</h${h[1].length}>`); i++; continue; }
      if (l.trim()) out.push("<p>" + inl(l) + "</p>"); i++; }
    return out.join("\n");
  }
  app.get("/tz/:id", (req, res) => {
    const x = (getState().tzTexts || []).find((t) => t.id === req.params.id);
    if (!x || req.query.k !== tzSig(x.id)) return res.status(404).send("Ссылка устарела — попросите менеджера отправить ТЗ ещё раз");
    res.set("Cache-Control", "no-store"); res.set("X-Robots-Tag", "noindex");
    res.send(`<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>ТЗ MIXIT — ${escH(x.family || "")}</title><style>
      body{font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;font-size:15px;line-height:1.55;color:#2B2228;max-width:820px;margin:20px auto;padding:0 18px}
      h1{font-size:22px;margin:0 0 6px} h2{font-size:17px;margin:20px 0 6px;color:#C2306F} h3{font-size:15px;margin:14px 0 4px}
      table{border-collapse:collapse;width:100%;margin:8px 0;font-size:14px} th,td{border:1px solid #E7D3DC;padding:6px 8px;vertical-align:top;text-align:left} th{background:#FCE4EF}
      .meta{color:#8A7B83;font-size:13px;margin-bottom:14px;border-bottom:1px solid #F1E1E8;padding-bottom:10px}</style></head><body>
      <div class="meta">MIXIT KZ · техническое задание · ${escH(x.product || x.family || "")}</div>${tzMd(x.text)}</body></html>`);
  });
  app.post("/api/coord/send-tz", requireAuth, async (req, res) => {
    if (!staff(req, res)) return;
    try {
      const b = req.body || {}, st = getState();
      const d = (st.microInfluencerDeals || []).find((x) => x.id === +b.dealId); if (!d) return res.status(404).json({ error: "Выберите интеграцию блогера" });
      const x = (st.tzTexts || []).find((t) => t.id === String(b.tzId || "")); if (!x) return res.status(404).json({ error: "ТЗ не найдено" });
      const base = `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}`;
      const link = `${base}/tz/${encodeURIComponent(x.id)}?k=${tzSig(x.id)}`;
      const text = String(b.text || "").trim() || `Добрый день! Отправляем техническое задание${x.family ? " — " + x.family : ""}. Посмотрите, пожалуйста, и подтвердите 🙏`;
      const via = await sendToBlogger({ phone: d.phone, dealId: d.id, text: `${text}\n${link}` }); // ссылкой (страница ТЗ — не файл)
      const now = new Date().toISOString();
      d.tz = x.hook || d.tz; d.tzBaseId = x.id; d.tzSentAt = now; d.tzSentBy = (req.session && req.session.name) || "";
      const r = IB()[waNumber(d.phone)]; if (r) { r.tzDoneAt = now; r.tzDoneBy = d.tzSentBy; }
      persist(); res.json({ ok: true, via, link });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.get("/api/chatapp/status", requireAuth, async (req, res) => { try { res.json(Object.assign({ configured: chatapp.configured(), managers: chatappManagers() }, req.query.fresh ? await chatapp.check() : chatapp.status() || {})); } catch (e) { res.status(500).json({ error: e.message }); } });
  async function wazzupSend(body) {
    const m = body && !body.templateId ? chatappFor(body.chatId) : null;
    if (m) {
      const fileName = body.contentUri && /^brief-delivery:/.test(String(body.crmMessageId || "")) ? "ТЗ MIXIT.pdf" : undefined;
      const r = await chatapp.send(Object.assign({}, body, fileName ? { fileName } : {}));
      // У ChatApp статусы доставки не приходят к нам вебхуком — принятое ChatApp ТЗ считаем отправленным.
      if (fileName) setTimeout(() => { try { if (briefDelivery.statuses([{ messageId: r.messageId, status: "sent" }])) persist(); } catch (e) {} }, 3000).unref();
      return r;
    }
    return wazzupSendRaw(body);
  }
  async function wazzupSendRaw(body) {
    const k = cfg();
    const r = await fetch(`${WAZZUP}/message`, { method: "POST", headers: { Authorization: `Bearer ${k.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const txt = await r.text();
    if (!r.ok) throw new Error(`Wazzup ${r.status}: ${txt.slice(0, 200)}`);
    let j = {}; try { j = JSON.parse(txt) || {}; } catch (e) {}
    if (j.messageId) C().seen[`out:${j.messageId}`] = Date.now(); // чтобы статусы ошибок брать только по нашим сообщениям
    return j;
  }
  const flowMedia=require('./flow-media').createMedia({});
  flowMedia.mount(app,requireAuth);
  const reviewTransport=require('./review-transport').createReviewTransport({getState,persist,send:wazzupSend,getChannel:chanInfo,resolveUrl:item=>{const v=(getState().microInfluencerDeals||[]).find(d=>d.id===item.dealId)?.flowVideoVersions?.find(v=>v.id===item.videoVersionId);return v?.mediaId?flowMedia.url(v.mediaId):item.url}});
  const briefDelivery=require('./brief-delivery').createBriefDelivery({getState,persist,send:wazzupSend,getChannel:chanInfo});
  briefDelivery.mount(app,requireAuth);
  const logisticsDigests=require('./logistics-digests').createDigests({getState,persist,send:wazzupSend,getChannel:chanInfo});
  const digestTimer=setInterval(()=>logisticsDigests.drain().catch(()=>{}),30000);digestTimer.unref();
  const reviewTimer=setInterval(()=>reviewTransport.drain().catch(()=>{}),15000);reviewTimer.unref();
  const crmRelay=require('./crm-comms-relay').createRelay({getState,persist});
  const relayTimer=setInterval(()=>crmRelay.drain().catch(()=>{}),15000);relayTimer.unref();
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
        if (!d || d.coordStop || isPublished(d) || !inPilot(d)) { q.status = "cancelled"; log(q.dealId, "sys", "напоминание отменено: опубликовано / стоп / строка удалена"); changed = true; continue; }
        if (!autoRemind()) { q.status = "cancelled"; log(q.dealId, "sys", "напоминание отменено: автонапоминания выключены"); changed = true; continue; }
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
    if(videoFlow.enabled() && reviewTransport.incoming(msg,ourChannel))return true;
    if (String(msg.chatType || "whatsapp") === "whatsapp") {
      const n0 = waNumber(msg.chatId), pilotIn = !msg.isEcho && (getState().microInfluencerDeals || []).some((d) => inPilot(d) && waNumber(d.phone) === n0);
      // Сообщения, отправленные через API (наши кнопки), уже в журнале — не дублируем.
      const apiOut = msg.isEcho && (msg.authorType === "api" || /^bb-/.test(String(msg.crmMessageId || "")) || C().seen["out:" + msg.messageId]);
      if (!apiOut) {
        const r = inboxRecord({ phone: msg.chatId, side: msg.isEcho ? "out" : "in", text: msg.text, type: msg.type, url: msg.contentUri, via: "wazzup", id: msg.messageId, at: msg.dateTime, noLog: pilotIn });
        if (r && !msg.isEcho && !pilotIn && isVideoMsg(msg.type, msg.contentUri, msg.fileName)) queueClassify(r.d, msg.contentUri);
        if (r && !pilotIn) return true;
      }
    }
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
    if(videoFlow.enabled()){
      const possible=active.length?active:cands;
      const isVideo=String(msg.type)==='video'||(['document','file'].includes(String(msg.type))&&/\.(mp4|mov|webm)(?:$|[?#])/i.test(String(msg.fileName||msg.contentUri||'')));
      if(possible.length>1){
        videoFlow.queueAmbiguous(st,msg,possible);
        for(const candidate of possible) event(candidate,'media_ambiguous','Сообщение требует выбора интеграции: автоматическая привязка остановлена',{messageId:id,review:false});
        return true;
      }
      if(isVideo)videoFlow.recordVersion(possible[0],{messageId:id,url:String(msg.contentUri||''),source:'blogger'});
    }
    const d = active[0] || cands[0];
    return processReply(d, String(msg.text || "").trim(), String(msg.type || "text"), msg.contentUri || "");
  }
  // Разбор ответа блогера (общий для Wazzup и бота Битрикса). Дату сам не меняет — только предлагает менеджеру.
  function processReply(d, text, type, url) {
    const today = almatyDate();
    log(d.id, "in", type === "text" ? text : `[${type}] ${url || ""} ${text}`.trim());
    // Ссылки (на Диск, Reels, TikTok) бот больше не разбирает автоматически: блогер может прислать старое видео,
    // менеджер — референс. Видео на согласование = только видео/файл в переписке.
    const draft = null;
    if (["video", "image", "document", "file"].includes(type)) {
      const u = url || (draft ? draft[1] : "");
      d.coordMedia = (Array.isArray(d.coordMedia) ? d.coordMedia : []).concat([{ at: new Date().toISOString(), type: draft ? "link" : type, url: u }]).slice(-20);
      // Только настоящее видео: PDF/договор/фото — не видео (18.11: бот ответил «видео получили» на подписанный договор).
      const isVideo = type === "video" || /\.(mp4|mov|webm|m4v|avi|mkv|3gp)(?:$|[?#])/i.test(u);
      if (isVideo && ["wait", "revise", "reshoot"].includes(stageOf(d))) {
        d.vstage = "received"; d.vreceivedAt = new Date().toISOString();
        log(d.id, "sys", "видео пришло — статус «📥 проверить»");
        const ev = event(d, "media", process.env.GEMINI_API_KEY ? "Блогер прислал видео на согласование — 🤖 ИИ разбирает (1–2 мин)" : "Блогер прислал видео на согласование — посмотрите и отправьте тимлиду", { url: u, review: true });
        if (process.env.GEMINI_API_KEY && u) startReview(d, u, ev && ev.id);
        if (u) queueClassify(d, u);
        // Ответ блогеру «видео получили» — один раз на пачку (если шлёт несколько частей подряд).
        if (!d.vackAt || Date.now() - Date.parse(d.vackAt) > 6 * H) {
          d.vackAt = new Date().toISOString();
          tellBlogger(d, "received_ack", [nameOf(d), d.product || "", almatyHour() >= 17 ? "завтра" : "сегодня"]).then(() => persist()).catch(() => {});
        }
      } else event(d, "media", `Блогер прислал ${type === "video" ? "видео" : type === "image" ? "фото" : "файл"} — посмотрите${u ? "" : " в переписке"}`, { url: u });
      return true;
    }
    const link = text.match(RE_LINK);
    if (link) {
      // Ничего не записываем в строку (05.11.2026, просьба менеджеров): ссылку вставляет менеджер сам.
      const url = link[1];
      log(d.id, "sys", "блогер прислал ссылку — в строку не записана, проверит менеджер");
      event(d, "link", `Блогер прислал ссылку: ${url} — если это публикация, вставьте её в строку сами`, { info: true, url });
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
    if(crmRelay.enqueue(b)){changed=true;crmRelay.drain().catch(()=>{});}
    try {
      const our = k.apiKey ? (await chanInfo()).id : "";
      for (const m of msgs) if (handleIncoming(m, our)) changed = true;
      if(briefDelivery.statuses(sts)) changed=true;
      for (const s of sts) if (s && s.status === "error" && C().seen[`out:${s.messageId}`]) { log(null, "sys", "Wazzup: ошибка доставки нашего напоминания"); changed = true; }
    } catch (e) { console.error("Wazzup webhook:", e.message); }
    if (changed) persist();
  });

  // ---------- ChatApp: входящие (23.11.2026) ----------
  // Адрес вставляется один раз в кабинете ChatApp (вебхук сообщений). Формат — события API ChatApp: {data:[{fromMe, side, type,
  // message:{text,file}, chat:{phone}}], meta:{type:"message"}}; на всякий случай понимаем и плоский {phone, text, fromMe}.
  app.post("/api/chatapp/webhook/:secret", require("express").urlencoded({ extended: true, limit: "2mb" }), (req, res) => {
    const k = cfg();
    if (k.secret.length < 16 || req.params.secret !== k.secret) return res.status(404).end();
    res.status(200).json({ ok: true });
    try {
      const b = req.body || {};
      const meta = b.meta || {};
      if (meta.type && !/message/i.test(String(meta.type))) return;
      const items = Array.isArray(b.data) ? b.data : b.data && typeof b.data === "object" ? [b.data] : Array.isArray(b) ? b : [b];
      let changed = false;
      for (const m of items) {
        if (!m || typeof m !== "object") continue;
        const chat = m.chat || {};
        const phone = chat.phone || m.phone || String(chat.id || m.chatId || "").replace(/@.*/, "");
        const msg = m.message && typeof m.message === "object" ? m.message : { text: m.message || m.text };
        const f = msg.file; const url = f ? (typeof f === "string" ? f : f.link || f.url || f.src || "") : String(m.file || "");
        const out = m.fromMe === true || m.fromMe === "1" || m.fromMe === "true" || m.side === "out";
        if (out && (m.fromApp || m.fromApi)) continue; // отправлено нашими кнопками через API — уже в журнале
        const type = String(m.type || (url ? "file" : "text"));
        const at = m.time ? new Date(Number(m.time) > 1e12 ? Number(m.time) : Number(m.time) * 1000).toISOString() : null;
        const r = inboxRecord({ phone, side: out ? "out" : "in", text: msg.text || msg.caption || "", type, url, via: "chatapp", id: m.id || m.messageId, at });
        if (r) { changed = true; if (!out && url && isVideoMsg(type, url, f && f.name)) queueClassify(r.d, url); }
      }
      if (changed) persist();
    } catch (e) { console.error("ChatApp webhook:", e.message); }
  });
  // 24.11.2026: подключение входящих одной кнопкой — Barter Box сам прописывает свой адрес в ChatApp через API.
  app.post("/api/chatapp/connect", requireAuth, async (req, res) => {
    if (!(req.session && req.session.canExport)) return res.status(403).json({ error: "Только Нина и Сая" });
    const k = cfg(); if (k.secret.length < 16) return res.status(400).json({ error: "В Render нет COORD_WEBHOOK_SECRET" });
    const base = String(process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "https://barter-box-server.onrender.com").replace(/\/$/, "");
    try { const list = await chatapp.setCallback(`${base}/api/chatapp/webhook/${k.secret}`, ["message"]); log(null, "sys", "ChatApp: входящие подключены (" + ((req.session && req.session.name) || "") + ")"); persist(); res.json({ ok: true, callbacks: list }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get("/api/chatapp/diag", requireAuth, async (req, res) => {
    if (!(req.session && req.session.canExport)) return res.status(403).json({ error: "Только Нина и Сая" });
    try { res.json(await chatapp.diag()); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get("/api/chatapp/callbacks", requireAuth, async (req, res) => {
    if (!(req.session && req.session.canExport)) return res.status(403).json({ error: "Только Нина и Сая" });
    try { res.json({ callbacks: await chatapp.listCallbacks() }); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get("/api/chatapp/webhook-url", requireAuth, (req, res) => {
    if (!(req.session && req.session.canExport)) return res.status(403).json({ error: "Только Нина и Сая" });
    const k = cfg(); if (k.secret.length < 16) return res.status(400).json({ error: "В Render нет COORD_WEBHOOK_SECRET" });
    const base = String(process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "https://barter-box-server.onrender.com").replace(/\/$/, "");
    res.json({ url: `${base}/api/chatapp/webhook/${k.secret}` });
  });


  // ---------- «Оплачено — сообщите блогеру» (23.11.2026) ----------
  // Нина ставит «оплачено» → у менеджера на Рабочем столе плашка. Менеджер/тимлид отправляет «Оплата прошла» одному или всем.
  // Перед отправкой смотрим переписку: если блогер после оплаты уже сам написал про оплату — не пишем, показываем его сообщение.
  // Текст Нины 23.11.2026; приветствие по времени Алматы.
  const paidText = () => { const h = almatyHour(); return `${h < 12 ? "Доброе утро" : h < 18 ? "Добрый день" : "Добрый вечер"}! Направили вам оплату 💚🙌`; };
  const RE_PAIDMSG = /оплат|оплачен|пришл[аио]|получил|поступил|деньг|перевел|перевели|төлен|алдым|келді|спасибо|рахмет/i;
  function paidWrote(d) {
    const since = Date.parse(d.paidAt || 0) - 6 * H;
    const n = waNumber(d.phone), ids = new Set([d.id]);
    if (n) for (const x of getState().microInfluencerDeals || []) if (waNumber(x.phone) === n) ids.add(x.id);
    return C().log.filter((l) => l.dir === "in" && ids.has(l.dealId) && Date.parse(l.at) >= since && RE_PAIDMSG.test(String(l.text || ""))).pop() || null;
  }
  function paidScope(req) {
    const s = req.session || {}, me = personKey(s.name);
    if (s.canExport && req.query.all === "1") return () => true;
    const g = TEAM_GROUPS.find((x) => personKey(x.lead) === me);
    const team = new Set([me].concat(g ? g.members.map(personKey) : []));
    return (d) => team.has(personKey(d.responsible));
  }
  // 24.11.2026 Нина: «оплачено» (в Blogger CRM или здесь) → «Оплата прошла» уходит блогеру сам, без кнопки.
  // Только для оплат, поставленных после запуска (по старым — не рассылаем). Ночью (22:00–9:00 Алматы) ждём утра.
  // Блогер уже сам написал про оплату / нет номера / 3 ошибки → не шлём, остаётся плашка у менеджера. PAID_AUTO=0 — выключить.
  const paidAutoOn = () => process.env.PAID_AUTO !== "0";
  const paidAutoQueued = (d) => { const c = C(); return paidAutoOn() && c.paidAutoSince && Date.parse(d.paidAt || 0) >= Date.parse(c.paidAutoSince) && !d.paidMsgNote && (d.paidMsgTries || 0) < 3; };
  let paidAutoBusy = false;
  async function paidAutoSweep() {
    if (!paidAutoOn() || paidAutoBusy) return;
    const c = C();
    if (!c.paidAutoSince) { c.paidAutoSince = new Date().toISOString(); persist(); return; }
    const h = almatyHour(); if (h < 9 || h >= 22) return;
    paidAutoBusy = true; try { await crmPaidSweep(); } catch (e) { console.error("Оплата из CRM → блогеру:", e.message); } finally { paidAutoBusy = false; }
    const since = Date.parse(c.paidAutoSince), all = getState().microInfluencerDeals || [];
    const due = all.filter((d) => d.paymentStatus === "оплачено" && d.paidAt && Date.parse(d.paidAt) >= since && !d.paidMsgSent && !d.paidSkip && !d.paidMsgNote && (d.paidMsgTries || 0) < 3);
    if (!due.length) return;
    paidAutoBusy = true;
    try {
      for (const d of due.slice(0, 40)) {
        const n = waNumber(d.phone);
        if (!n) { d.paidMsgNote = "нет номера WhatsApp — сообщите вручную"; persist(); continue; }
        if (d.paidMsgEver && Date.now() - Date.parse(d.paidMsgEver) < 3 * 24 * H) { d.paidMsgSent = d.paidMsgEver; d.paidMsgAuto = true; persist(); continue; } // статус переключали туда-обратно
        const sib = all.find((x) => x !== d && waNumber(x.phone) === n && x.paidMsgSent && Date.now() - Date.parse(x.paidMsgSent) < 6 * H);
        if (sib) { d.paidMsgSent = sib.paidMsgSent; d.paidMsgAuto = true; persist(); continue; } // одному блогеру — одно сообщение
        const w = paidWrote(d);
        if (w) { d.paidMsgNote = `блогер уже написал: «${String(w.text).slice(0, 80)}»`; persist(); continue; }
        try {
          const t = paidText(); const r = await sendNow(d, t);
          log(d.id, "out", `[оплата, авто] ${r.via}: ${t}`);
          d.paidMsgSent = d.paidMsgEver = new Date().toISOString(); d.paidMsgAuto = true; d.paidMsgErr = null;
        } catch (e) { d.paidMsgTries = e.permanent ? 3 : (d.paidMsgTries || 0) + 1; d.paidMsgErr = String(e.message || e).slice(0, 200); }
        persist();
        await new Promise((r) => setTimeout(r, 1500));
      }
    } finally { paidAutoBusy = false; }
  }
  // 24.11.2026: оплата отмечена в Blogger CRM (без связи с интеграцией) → state.crmPaidQueue (crm-bloggers.js).
  // Статус интеграции не трогаем; находим блогера по ID CRM / нику, номер — из его интеграций (иначе WhatsApp из CRM).
  const nickKey = (v) => String(v || "").replace(/#.*$/, "").replace(/[?].*$/, "").replace(/\/+$/, "").split("/").pop().replace("@", "").trim().toLowerCase();
  async function crmPaidSweep() {
    const st = getState(), q = Array.isArray(st.crmPaidQueue) ? st.crmPaidQueue : [];
    const todo = q.filter((e) => !e.done && (e.tries || 0) < 3);
    if (!todo.length) return;
    const all = st.microInfluencerDeals || [];
    for (const e of todo.slice(0, 40)) {
      const his = all.filter((d) => (e.bloggerId && String(d.crmBloggerId || "") === e.bloggerId) || (e.nicks.length && [d.blogerName, d.instagramAccount, d.tiktokAccount].some((v) => v && e.nicks.includes(nickKey(v)))));
      const withPhone = his.filter((d) => waNumber(d.phone)).sort((a, b) => String(b.plannedDate || b.createdAt || "").localeCompare(String(a.plannedDate || a.createdAt || "")));
      const deal = withPhone[0] || his[0] || null, target = withPhone[0];
      e.dealId = deal ? deal.id : null; e.blogger = (deal && deal.blogerName) || (e.nicks[0] ? "@" + e.nicks[0] : ""); if (deal && deal.responsible) e.manager = deal.responsible;
      if (!deal) { e.done = new Date().toISOString(); e.note = "блогер не найден в Бартер Боксе — уведомление не отправлено"; persist(); continue; }
      const n = target && waNumber(target.phone); // номер — только из интеграций Бартер Бокса
      if (!n) { e.done = new Date().toISOString(); e.note = "нет номера в интеграции — уведомление не отправлено"; persist(); continue; }
      const recent = all.find((d) => waNumber(d.phone) === n && [d.paidMsgSent, d.crmPaidMsgAt].some((t) => t && Date.now() - Date.parse(t) < 6 * H));
      if (recent) { e.done = new Date().toISOString(); e.note = "уже отправляли сегодня"; if (deal) deal.crmPaidMsgAt = recent.crmPaidMsgAt || recent.paidMsgSent; persist(); continue; }
      const ids = new Set(his.map((d) => d.id)), since = Date.parse(e.at) - 6 * H;
      const w = C().log.filter((l) => l.dir === "in" && ids.has(l.dealId) && Date.parse(l.at) >= since && RE_PAIDMSG.test(String(l.text || ""))).pop();
      if (w) { e.done = new Date().toISOString(); e.note = "блогер уже написал про оплату"; persist(); continue; }
      try {
        const t = paidText(); const r = await sendNow(target, t);
        log(deal ? deal.id : null, "out", `[оплата из CRM, авто] ${r.via}: ${t}`);
        e.done = new Date().toISOString(); e.sent = true;
        if (deal) { deal.crmPaidMsgAt = e.done; deal.crmPaidMsgAmount = e.amount; }
      } catch (err) { e.tries = err.permanent ? 3 : (e.tries || 0) + 1; e.err = String(err.message || err).slice(0, 200); }
      persist();
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  // Рабочий стол: «Оплачено в CRM — уведомление отправлено / не отправлено» (по своим; тимлид — по команде; Нина — все).
  app.get("/api/coord/crm-paid-feed", requireAuth, (req, res) => {
    if (!staff(req, res)) return;
    const inScope = paidScope(req), from = Date.now() - 3 * 24 * H;
    const q = Array.isArray(getState().crmPaidQueue) ? getState().crmPaidQueue : [];
    const items = q.filter((e) => e.done && !e.dismissed && Date.parse(e.done) > from && inScope({ responsible: e.manager }))
      .map((e) => ({ id: e.id, dealId: e.dealId || null, blogger: e.blogger || "", manager: e.manager || "", amount: e.amount || 0, sent: !!e.sent, note: e.note || "", at: e.done }))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));
    res.json({ items });
  });
  app.post("/api/coord/crm-paid-feed/dismiss", requireAuth, (req, res) => {
    if (!staff(req, res)) return;
    const ids = new Set((Array.isArray(req.body && req.body.ids) ? req.body.ids : []).map(String));
    for (const e of getState().crmPaidQueue || []) if (ids.has(String(e.id))) e.dismissed = true;
    persist(); res.json({ ok: true });
  });
  setInterval(() => { paidAutoSweep().catch((e) => console.error("Оплата → блогеру:", e.message)); }, 60 * 1000);
  setTimeout(() => { paidAutoSweep().catch(() => {}); }, 25000);
  app.get("/api/coord/paid-pending", requireAuth, (req, res) => {
    if (!staff(req, res)) return;
    const inScope = paidScope(req), weekAgo = Date.now() - 21 * 24 * H;
    const items = (getState().microInfluencerDeals || []).filter((d) => d.paymentStatus === "оплачено" && d.paidAt && Date.parse(d.paidAt) > weekAgo && !d.paidMsgSent && !d.paidSkip && !paidAutoQueued(d) && inScope(d))
      .map((d) => { const w = paidWrote(d); return { id: d.id, blogger: d.blogerName || "", product: d.product || "", manager: d.responsible || "", cost: Number(d.cost) || 0, paidAt: d.paidAt, phone: !!waNumber(d.phone), err: d.paidMsgErr || "", wrote: w ? { at: w.at, text: String(w.text).slice(0, 160) } : null }; });
    res.json({ text: paidText(), items });
  });
  app.post("/api/coord/paid-notify", requireAuth, async (req, res) => {
    if (!staff(req, res)) return;
    const ids = (Array.isArray(req.body && req.body.ids) ? req.body.ids : []).map(Number).filter(Boolean).slice(0, 100);
    const skip = !!(req.body && req.body.skip), out = { sent: 0, skipped: [], errors: [] };
    const sentPhones = new Set();
    for (const id of ids) {
      const d = (getState().microInfluencerDeals || []).find((x) => x.id === id); if (!d) continue;
      if (skip) { d.paidSkip = true; continue; }
      const w = paidWrote(d);
      if (w && !(req.body && req.body.force)) { out.skipped.push(`${d.blogerName}: уже писал(а) «${String(w.text).slice(0, 60)}»`); continue; }
      const n = waNumber(d.phone);
      if (!n) { out.errors.push(`${d.blogerName}: нет номера`); continue; }
      if (sentPhones.has(n)) { d.paidMsgSent = new Date().toISOString(); continue; } // одному блогеру — одно сообщение
      try { const t = paidText(); const r = await sendNow(d, t); log(d.id, "out", `[оплата] ${r.via}: ${t}`); d.paidMsgSent = d.paidMsgEver = new Date().toISOString(); d.paidMsgErr = null; sentPhones.add(n); out.sent++; }
      catch (e) { out.errors.push(`${d.blogerName}: ${e.message}`); }
    }
    persist(); res.json(out);
  });

  // ---------- «Входящие»: список, отметка «ответила» ----------
  const LEAD_NAMES = new Set(["Нина", "Сая"]);
  app.get("/api/inbox", requireAuth, (req, res) => {
    if (!staff(req, res)) return;
    // 24.11.2026: всех видят только Нина, Сая и руководство; роль «маркетолог» есть и у менеджеров (Сабрина видела чужие диалоги).
    const s = req.session || {}, all = (s.canExport && LEAD_NAMES.has(s.name)) || ["Мария", "Сауле", "Константин"].includes(s.name);
    const me = personKey(s.name), mine = req.query.mine === "1" || !all;
    const st = getState(), byId = new Map((st.microInfluencerDeals || []).map((d) => [d.id, d]));
    const rows = Object.values(IB()).filter((r) => !mine || personKey(r.manager) === me).map((r) => {
      const d = byId.get(r.dealId) || {};
      return { phone: r.phone, dealId: r.dealId, manager: r.manager, blogger: d.blogerName || r.blogger, product: d.product || "", via: r.via,
        lastIn: r.lastIn || "", lastInText: r.lastInText || "", lastInType: r.lastInType || "", lastOut: r.lastOut || "", waiting: waiting(r),
        tzAskAt: r.tzAskAt || "", tzAskText: r.tzAskText || "", tzWait: !!r.tzAskAt && !(String(r.tzSentAt || "") > r.tzAskAt) && !(String(r.tzDoneAt || "") > r.tzAskAt) && !(d.flowBriefSentVersionId && String(d.flowBriefSentAt || "") > r.tzAskAt) };
    }).sort((a, b) => String(b.lastIn || b.lastOut).localeCompare(String(a.lastIn || a.lastOut)));
    res.json({ all, items: rows.slice(0, 400) });
  });
  app.post("/api/inbox/:phone/tz-done", requireAuth, (req, res) => {
    if (!staff(req, res)) return;
    const r = IB()[waNumber(req.params.phone)]; if (!r) return res.status(404).json({ error: "не найдено" });
    r.tzDoneAt = new Date().toISOString(); r.tzDoneBy = (req.session && req.session.name) || "";
    persist(); res.json({ ok: true });
  });
  app.post("/api/inbox/:phone/done", requireAuth, (req, res) => {
    if (!staff(req, res)) return;
    const r = IB()[waNumber(req.params.phone)]; if (!r) return res.status(404).json({ error: "не найдено" });
    r.doneAt = new Date().toISOString(); r.doneBy = (req.session && req.session.name) || "";
    persist(); res.json({ ok: true });
  });

  // ---------- Автопроставление ТЗ и языка по присланному видео (23.11.2026) ----------
  // ИИ смотрит видео и выбирает из базовых ТЗ «Базы ТЗ» похожее + язык. Ставим только в пустые поля — менеджер может поменять.
  const classifyQueue = []; let classifying = false;
  function tzCandidates(d) {
    let lib = null; try { lib = require("./tz-library.json"); } catch (e) { return []; }
    const texts = new Map((getState().tzTexts || []).map((t) => [String(t.id), t]));
    const items = (lib.items || []).filter((x) => x[3] !== "archive");
    const prod = String(d.product || "").toLowerCase();
    const groups = Object.entries(lib.groups || {}).filter(([g, re]) => { if (!prod) return true; try { return (re && new RegExp(re, "i").test(prod)) || prod.includes(g.toLowerCase()); } catch (e) { return prod.includes(g.toLowerCase()); } }).map(([g]) => g);
    const pool = groups.length ? items.filter((x) => groups.includes(x[1])) : items;
    return pool.slice(0, 60).map((x) => { const t = texts.get(String(x[0])) || {}; return { id: String(x[0]), group: x[1], title: x[2], hook: String(t.hook || "").slice(0, 160), angle: String(t.angle || "").slice(0, 160) }; });
  }
  function queueClassify(d, url) {
    if (!process.env.GEMINI_API_KEY || !url || !d) return;
    if (String(d.tz || "").trim() && d.videoLang) return; // всё уже заполнено
    if (classifyQueue.some((j) => j.dealId === d.id)) return;
    classifyQueue.push({ dealId: d.id, url }); runClassify();
  }
  async function runClassify() {
    if (classifying) return; classifying = true;
    try {
      while (classifyQueue.length) {
        const job = classifyQueue.shift();
        const d = (getState().microInfluencerDeals || []).find((x) => x.id === job.dealId); if (!d) continue;
        try {
          const r = await classifyVideo(job.url, tzCandidates(d));
          const ch = [];
          if (!d.videoLang && r.lang) { d.videoLang = r.lang; ch.push("язык: " + ({ ru: "русский", kz: "казахский", "под музыку": "под музыку" })[r.lang]); }
          if (!String(d.tz || "").trim() && r.tz && r.confidence >= 0.7) { d.tz = r.tz.title; d.tzGroup = r.tz.group; d.tzAuto = { id: r.tz.id, confidence: r.confidence, at: new Date().toISOString() }; ch.push("ТЗ: " + r.tz.title); }
          else if (!String(d.tz || "").trim()) d.tzAutoGuess = r.tz ? { title: r.tz.title, group: r.tz.group, confidence: r.confidence } : { none: true }; // ниже 70% — спросим менеджера «это персональное?»
          if (ch.length) { log(d.id, "sys", "ИИ по видео проставил — " + ch.join(", ")); persist(); }
        } catch (e) { log(d.id, "sys", "ИИ не определил ТЗ/язык: " + String(e.message).slice(0, 150)); persist(); }
      }
    } finally { classifying = false; }
  }

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
  // Переписка по интеграции для карточки (23.11.2026): все сообщения с этим номером, по всем его интеграциям.
  app.get("/api/coord/deal/:id/chat", requireAuth, (req, res) => {
    const st = getState(), d = (st.microInfluencerDeals || []).find((x) => x.id === +req.params.id);
    if (!d) return res.status(404).json({ error: "не найдено" });
    const n = waNumber(d.phone), ids = new Set([d.id]);
    if (n) for (const x of st.microInfluencerDeals || []) if (waNumber(x.phone) === n) ids.add(x.id);
    res.json({ pilot: inPilot(d), transport: transport(), log: C().log.filter((l) => ids.has(l.dealId)).slice(-80) });
  });
  app.post('/api/coord/pending-media/:messageId/attach',requireAuth,(req,res)=>{
    if(!staff(req,res))return;
    if(!videoFlow.enabled())return res.status(409).json({error:'Версионность выключена'});
    const st=getState(),pending=(st.videoFlow?.pendingMedia||[]).find(x=>x.messageId===req.params.messageId);
    if(!pending)return res.status(404).json({error:'Сообщение не найдено'});
    const deal=(st.microInfluencerDeals||[]).find(x=>String(x.id)===String(req.body.dealId));
    if(!deal||!pending.dealIds.includes(deal.id))return res.status(400).json({error:'Выберите одну из связанных интеграций'});
    if(pending.status==='attached')return pending.dealId===deal.id?res.json({ok:true}):res.status(409).json({error:'Уже связано с другой интеграцией'});
    const isVideo=pending.type==='video'||/\.(mp4|mov|webm)(?:$|[?#])/i.test(pending.url);
    if(isVideo)videoFlow.recordVersion(deal,{messageId:pending.messageId,url:pending.url,source:'blogger'});
    processReply(deal,pending.text,pending.type,pending.url);
    pending.status='attached';pending.dealId=deal.id;persist();res.json({ok:true});
  });
  app.get('/api/automation/editing',requireAuth,(req,res)=>{
    if(!staff(req,res))return;
    const st=getState();res.json({tasks:(st.automationFlow?.drafts||[]).filter(x=>x.topic==='editing.requested').map(task=>{
      const deal=(st.microInfluencerDeals||[]).find(d=>d.id===task.dealId),version=deal?.flowVideoVersions?.find(v=>v.id===task.videoVersionId);
      let source=version?.url||'';if(version?.mediaId){try{source=flowMedia.url(version.mediaId)}catch{}}
      return {...task,blogger:deal?.blogerName,source,versionNumber:version?.number};
    })});
  });
  app.post('/api/automation/editing/:taskId/upload',requireAuth,(req,res,next)=>{if(!staff(req,res))return;if(process.env.FLOW_VIDEO_VERSIONS_ENABLED!=='1')return res.status(409).json({error:'Версионность выключена'});const task=getState().automationFlow?.drafts?.find(x=>x.id===req.params.taskId&&x.topic==='editing.requested');if(!task||task.status!=='pending')return res.status(409).json({error:'Задача уже обработана или не найдена'});try{flowMedia.url('00000000-0000-0000-0000-000000000000.mp4')}catch(e){return res.status(503).json({error:e.message})}next();},flowMedia.upload,(req,res)=>{
    if(!req.file)return res.status(400).json({error:'Загрузите видео'});
    const st=getState(),task=st.automationFlow?.drafts?.find(x=>x.id===req.params.taskId&&x.topic==='editing.requested');
    if(!task||task.status!=='pending'){flowMedia.remove(req.file.filename);return res.status(409).json({error:'Задача уже обработана'});}
    const deal=(st.microInfluencerDeals||[]).find(d=>d.id===task.dealId);if(!deal){flowMedia.remove(req.file.filename);return res.status(404).json({error:'Интеграция удалена'});}
    const version=videoFlow.recordVersion(deal,{messageId:'editor:'+req.file.filename,url:flowMedia.url(req.file.filename),source:'editor'});version.mediaId=req.file.filename;
    task.status='uploaded';task.uploadedVersionId=version.id;task.uploadedBy=actorName(req)||'монтажёр';deal.vstage='received';deal.flowEditingStatus='uploaded';
    const ev=event(deal,'media','Монтажёр загрузил новую версию — автоматическая проверка',{review:true,url:version.url});
    if(process.env.GEMINI_API_KEY)startReview(deal,version.url,ev?.id);else event(deal,'error','Видео сохранено; автоматическая проверка требует настроенного Gemini');persist();res.json({ok:true,versionId:version.id});
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
  // 24.11.2026: только чтение — какие смарт-процессы и поля есть в Битриксе (для заявки «Согласование оплаты» по ИП).
  app.get("/api/bitrix/pay-discover", requireAuth, async (req, res) => {
    if (!staff(req, res)) return;
    try {
      const t = await bxPay("crm.type.list", {}); const types = ((t && t.types) || []).map((x) => ({ id: x.entityTypeId, title: x.title }));
      const want = types.filter((x) => new RegExp(String(req.query.q || "оплат"), "i").test(x.title));
      const out = [];
      for (const ty of want.slice(0, 4)) {
        const f = await bxPay("crm.item.fields", { entityTypeId: ty.id }); const fields = (f && f.fields) || {};
        out.push({ type: ty, fields: Object.entries(fields).map(([k, v]) => ({ code: k, title: v.title, type: v.type, required: !!v.isRequired, multiple: !!v.isMultiple, items: (v.items || []).slice(0, 40).map((i) => ({ id: i.ID, value: i.VALUE })) })) });
      }
      res.json({ types, details: out });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  // 24.11.2026 Нина: заявка на оплату по ИП (со счётом) → карточка «Согласование оплаты» в Битриксе через вебхук.
  // Вебхук — BITRIX_PAY_WEBHOOK_URL (права crm и user), иначе BITRIX_WEBHOOK_URL. Поля ищем по названиям, значения списков — по тексту,
  // поэтому ID полей в коде нет. Название: «Оплата блогеру @ник за рекламу в Instagram»; Организация — ИП Нигай; Подразделение — Миксит;
  // Статус бюджета — В рамках бюджета; Направление — Маркетинг; Описание — сколько видео и за какой месяц; счёт — файлом.
  async function bxPay(method, params) {
    let base = String(process.env.BITRIX_PAY_WEBHOOK_URL || process.env.BITRIX_WEBHOOK_URL || "").trim();
    if (!base) throw new Error("в Render не задан BITRIX_PAY_WEBHOOK_URL");
    if (!base.endsWith("/")) base += "/";
    const r = await fetch(base + method + ".json", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params || {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(`Битрикс ${method}: ${j.error_description || j.error || r.status}`);
    return j.result;
  }
  let bxPayMeta = null;
  async function bxPayType() {
    if (bxPayMeta && Date.now() - bxPayMeta.at < 3600e3) return bxPayMeta;
    let id = Number(process.env.BITRIX_PAY_ENTITY_TYPE_ID) || 0;
    if (!id) { const t = await bxPay("crm.type.list", {}); const ty = ((t && t.types) || []).find((x) => /согласован[а-яё]*\s+оплат/i.test(x.title)) || ((t && t.types) || []).find((x) => /оплат/i.test(x.title)); if (!ty) throw new Error("в Битриксе не найден смарт-процесс «Согласование оплаты»"); id = ty.entityTypeId; }
    const f = await bxPay("crm.item.fields", { entityTypeId: id });
    bxPayMeta = { at: Date.now(), id, fields: (f && f.fields) || {} }; return bxPayMeta;
  }
  const bxUpload = require("multer")({ storage: require("multer").memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }).single("invoice");
  app.post("/api/bitrix/pay-request", requireAuth, (req, res, next) => bxUpload(req, res, (e) => (e ? res.status(400).json({ error: "Счёт до 10 МБ" }) : next())), async (req, res) => {
    if (!staff(req, res)) return;
    try {
      const b = req.body || {}; const nick = String(b.nick || "").replace(/^@/, "").trim(); if (!nick) throw new Error("нет ника блогера");
      const amount = Math.round(Number(String(b.amount || "").replace(/\s/g, "")) || 0); if (!(amount > 0)) throw new Error("нет суммы");
      if (!req.file) throw new Error("прикрепите счёт на оплату");
      const meta = await bxPayType(); const F = meta.fields;
      const byTitle = (re) => Object.entries(F).find(([k, v]) => k.startsWith("uf") && re.test(String(v.title || v.listLabel || v.formLabel || "")));
      const fields = {}, missed = [];
      const setList = (re, valRe, label) => { const hit = byTitle(re); if (!hit) { missed.push(label + " (нет поля)"); return; } const [code, v] = hit;
        if (Array.isArray(v.items) && v.items.length) { const it = v.items.find((i) => valRe.test(String(i.VALUE))); if (it) fields[code] = v.isMultiple ? [it.ID] : it.ID; else missed.push(label + " (нет варианта)"); }
        else if (/string|text/.test(v.type)) fields[code] = label.split(": ")[1] || ""; else missed.push(label + " (тип поля " + v.type + ")"); };
      const platform = /tiktok/i.test(b.platform || "") && !/insta/i.test(b.platform || "") ? "TikTok" : /tiktok/i.test(b.platform || "") ? "Instagram и TikTok" : "Instagram";
      fields.title = `Оплата блогеру @${nick} за рекламу в ${platform}`;
      fields.opportunity = amount; fields.currencyId = "KZT";
      setList(/организац/i, /нигай/i, "Организация: ИП Нигай");
      setList(/подразделен/i, /микс|mixit/i, "Подразделение: Миксит");
      setList(/статус\s*бюджет/i, /в\s*рамках/i, "Статус бюджета: В рамках бюджета");
      setList(/направлен/i, /маркет/i, "Направление: Маркетинг");
      const videos = Math.round(Number(b.videos) || 0), stories = Math.round(Number(b.stories) || 0);
      const what = [videos ? `${videos} видео` : "", stories ? `${stories} сторис` : ""].filter(Boolean).join(" + ") || "реклама";
      const desc = `Прошу оплатить блогеру @${nick} за рекламу в ${platform}: ${what}${b.month ? ` за ${b.month}` : ""}.${b.contract ? ` Договор № ${b.contract}.` : ""}${b.notes ? " " + String(b.notes).slice(0, 500) : ""}`;
      const dHit = byTitle(/описани|назначени|комментар/i); if (dHit) fields[dHit[0]] = desc; else missed.push("Описание платежа (нет поля)");
      const fHit = byTitle(/сч[её]т/i) || Object.entries(F).find(([k, v]) => k.startsWith("uf") && v.type === "file");
      if (fHit) { const val = { fileData: [String(req.file.originalname || "счёт.pdf").slice(0, 150), req.file.buffer.toString("base64")] }; fields[fHit[0]] = fHit[1].isMultiple ? [val] : val; } else missed.push("Счёт на оплату (нет поля)");
      // ответственный: BITRIX_USER_MAP_JSON {"Мадина": 123} или поиск сотрудника по имени (нужно право user)
      const me = String(b.manager || (req.session && req.session.name) || "").trim();
      let uid = 0; try { uid = Number((JSON.parse(process.env.BITRIX_USER_MAP_JSON || "{}") || {})[me]) || 0; } catch (e) {}
      if (!uid && me) { try { const u = await bxPay("user.search", { NAME: me, ACTIVE: true }); if (Array.isArray(u) && u.length === 1) uid = Number(u[0].ID); } catch (e) {} }
      if (uid) fields.assignedById = uid; else missed.push("Ответственный (не нашла «" + me + "» в Битриксе)");
      const r = await bxPay("crm.item.add", { entityTypeId: meta.id, fields });
      const itemId = r && r.item && r.item.id;
      const st = getState(); for (const id of String(b.dealIds || "").split(",").map(Number).filter(Boolean)) { const d = (st.microInfluencerDeals || []).find((x) => x.id === id); if (d) { d.bitrixPayItemId = itemId; d.bitrixPayAt = new Date().toISOString(); } }
      persist(); res.json({ ok: true, itemId, missed });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
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
  // «Готово» сразу для нескольких уведомлений (по блогеру или все).
  app.post("/api/coord/events/read-many", requireAuth, (req, res) => {
    if (!staff(req, res)) return;
    const ids = new Set(Array.isArray(req.body && req.body.ids) ? req.body.ids.map(String) : []);
    const now = new Date().toISOString();
    let n = 0;
    for (const e of C().events) if (ids.has(String(e.id)) && !e.read) { e.read = true; e.readAt = now; n++; }
    if (n) persist();
    res.json({ ok: true, read: n });
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
  // Напомнить блогеру сейчас (одна строка или все без видео). Видео пришло/опубликовано — не пишем.
  async function remindNow(d, force, own) {
    const fail = (m) => { const e = new Error(m); e.status = 400; throw e; };
    // 23.11.2026: кнопка менеджера — ручное действие, пишем любому блогеру с номером (не только пилот COORD_PILOT_MANAGER).
    if (!waNumber(d.phone)) fail("У блогера нет номера WhatsApp");
    if (transport() === "none" && !chatappFor(d.phone)) fail("Отправка не настроена: в Render нет WAZZUP_API_KEY / BITRIX_WEBHOOK_URL");
    if (d.coordStop) fail("Напоминания для этой строки остановлены");
    const pd = String(d.plannedDate || "").slice(0, 10), today = almatyDate();
    const stage = stageOf(d), due = dueOf(d);
    let kind, ds;
    const ownText = String(own || "").trim().slice(0, 1000);
    if (ownText) { kind = "own"; }
    else if (force === "video_today" && !["received", "approved", "published"].includes(stage)) { kind = "video_today"; ds = ddmm(today); }
    else if (stage === "approved") { kind = "link_ask"; ds = ddmm(pd); }
    else if (stage === "received") fail("Видео уже пришло и ждёт проверки — блогеру напоминать не нужно");
    else if (stage === "published") fail("Уже опубликовано");
    else if (!due) fail("Нет плановой даты");
    else if (today > due) { kind = "overdue"; ds = ddmm(due); }
    else if (today === due) { kind = "due_today"; ds = ddmm(due); }
    else { kind = "due_soon"; ds = whenWord(today, due); }
    const text = kind === "own" ? ownText : TEXTS[kind]([nameOf(d), d.product || "интеграции", ds]);
    try {
      const r = await sendNow(d, text);
      d.coordLastOutDay = today;
      log(d.id, "out", `[вручную] ${r.via}: ${text}`);
      persist();
      return { ok: true, text, ...r };
    } catch (e) {
      log(d.id, "sys", `[вручную] не отправлено: ${e.message}`);
      persist();
      e.status = 400; throw e;
    }
  }
  app.post("/api/coord/deal/:id/send-now", requireAuth, async (req, res) => {
    if (!staff(req, res)) return;
    const d = (getState().microInfluencerDeals || []).find((x) => x.id === +req.params.id);
    if (!d) return res.status(404).json({ error: "не найдено" });
    try { res.json(await remindNow(d, req.body && req.body.kind, req.body && req.body.text)); } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
  });
  // «Напомнить всем»: только строки без присланного/опубликованного видео и не чаще раза в день на блогера.
  app.post("/api/coord/send-now-many", requireAuth, async (req, res) => {
    if (!staff(req, res)) return;
    const ids = (Array.isArray(req.body && req.body.ids) ? req.body.ids : []).map(Number).filter(Boolean).slice(0, 100);
    const today = almatyDate(), out = { sent: 0, skipped: 0, errors: [] };
    for (const id of ids) {
      const d = (getState().microInfluencerDeals || []).find((x) => x.id === id);
      if (!d || isPublished(d) || ["received", "approved", "published"].includes(stageOf(d)) || d.coordLastOutDay === today) { out.skipped++; continue; }
      try { await remindNow(d); out.sent++; } catch (e) { out.errors.push(`${d.blogerName || id}: ${e.message}`); }
    }
    res.json(out);
  });
  // Кнопки менеджера по видео: approve / revise / reshoot / received / wait. Дату двигает сама (рабочие дни),
  // блогеру пишет только в тесте (inPilot) и если координатор включён; в режиме dry — только в журнал.
  // ---------- ИИ-разбор видео (Gemini, наставления как у Telegram-бота) ----------
  // По одному видео за раз. Результат — d.vreview {status, text, decision, score}; уведомление менеджеру обновляется.
  const reviewQueue = [];
  let reviewing = false;
  function startReview(d, url, eventId, mode) {
    d.vreview = { status: "running", at: new Date().toISOString(), url };
    let videoVersionId=null;
    if(videoFlow.enabled()){
      let version=(d.flowVideoVersions||[]).find(v=>v.id===d.flowCurrentVideoVersionId&&v.url===url);
      if(!version)version=videoFlow.beginReview(d,url);
      videoVersionId=version.id;
    }
    reviewQueue.push({ dealId: d.id, url, eventId, mode: mode || "", tries: 0, videoVersionId });
    runReviews();
  }
  async function runReviews() {
    if (reviewing) return;
    reviewing = true;
    try {
      while (reviewQueue.length) {
        const job = reviewQueue.shift();
        const find = () => (getState().microInfluencerDeals || []).find((x) => x.id === job.dealId);
        let res = null, err = null, retryable = false;
        try {
          if(job.videoVersionId && process.env.FLOW_MEDIA_CACHE_ENABLED!=='0' && process.env.FLOW_PUBLIC_ORIGIN && process.env.FLOW_MEDIA_SECRET){
            const version=find()?.flowVideoVersions?.find(v=>v.id===job.videoVersionId);
            if(version&&!version.mediaId){try{const saved=await flowMedia.copyRemote(job.url);version.originalUri=version.url;version.mediaId=saved.id;version.url=saved.url;job.url=saved.url;persist();}catch(e){e.retryable=true;throw e;}}
            else if(version?.mediaId)job.url=flowMedia.url(version.mediaId);
          }
          res = await reviewVideo(job.url);
        } catch (e) { err = e.message; retryable = !!e.retryable; }
        const d = find();
        if (!d) continue;
        const ev = job.eventId ? C().events.find((e) => e.id === job.eventId) : null;
        // Gemini перегружен — сами повторим через 10 минут (до 6 раз, ~1 час), менеджеру ничего жать не нужно.
        if (!res && retryable && job.tries < 6) {
          job.tries++;
          d.vreview = { status: "running", at: new Date().toISOString(), url: job.url, note: `Gemini перегружен — повторим сами через 10 мин (попытка ${job.tries + 1} из 7)` };
          setTimeout(() => { reviewQueue.push(job); runReviews(); }, 10 * 60 * 1000);
          persist();
          continue;
        }
        if(job.videoVersionId && (!retryable || job.tries>=6 || res)) videoFlow.finishReview(getState(),d,job.videoVersionId,res,err);
        if(job.videoVersionId && d.flowCurrentVideoVersionId!==job.videoVersionId){persist();continue;}
        if (res) {
          d.vreview = { status: "done", at: new Date().toISOString(), url: job.url, text: String(res.text).slice(0, 12000), decision: res.decision, score: res.score, formal: res.formal, model: res.model };
          const head = `🤖 ИИ: ${res.decision || "разбор готов"}${res.score != null ? ` · ${res.score}/9` : ""}`;
          log(d.id, "sys", `ИИ разобрал видео: ${res.decision || "?"}${res.score != null ? " " + res.score + "/9" : ""}`);
          if (ev && job.mode === "lead") { ev.text = `${ev.text.replace(/ · 🤖 ИИ разбирает…$/, "")} · ${head}`; ev.read = false; }
          else if (ev) { ev.text = `Блогер прислал видео на согласование. ${head} — посмотрите разбор и отправьте тимлиду`; ev.read = false; }
          else event(d, "media", `${head} — посмотрите разбор и отправьте тимлиду`, { url: job.url, review: true });
        } else {
          d.vreview = { status: "error", at: new Date().toISOString(), url: job.url, error: String(err).slice(0, 300) };
          log(d.id, "sys", `ИИ не разобрал видео: ${err}`);
          if (ev && job.mode === "lead") { ev.text = `${ev.text.replace(/ · 🤖 ИИ разбирает…$/, "")} · ИИ не смог разобрать (${String(err).slice(0, 120)})`; ev.read = false; }
          else if (ev) { ev.text = `Блогер прислал видео на согласование. ИИ не смог разобрать (${String(err).slice(0, 150)}) — посмотрите сами`; ev.read = false; }
        }
        persist();
        if(job.videoVersionId)reviewTransport.drain().catch(()=>{});
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
      // Разбора ещё нет (ключ добавили позже, видео отметили вручную) — запускаем сейчас, тимлид увидит результат в том же уведомлении.
      const needAi = !(d.vreview && (d.vreview.status === "done" || d.vreview.status === "running")) && process.env.GEMINI_API_KEY && media && media.url;
      const lev = event(d, "lead", `На согласование от ${who}${r}${comment ? ` · комментарий: ${comment}` : ""}${needAi ? " · 🤖 ИИ разбирает…" : ""}`, { to: lead, review: true, lead: true, url: media ? media.url : "" });
      if (needAi) startReview(d, media.url, lev && lev.id, "lead");
      log(d.id, "sys", `${who} отправил(а) видео на согласование тимлиду (${lead})`);
      try { planReminders(); } catch (er) {}
      persist();
      return res.json({ ok: true, stage: "lead", lead, plannedDate: d.plannedDate });
    }
    if (action === "approve") {
      // Дату не трогаем (ТЗ §12): одобрение ≠ перенос. Дату выхода меняет только менеджер.
      d.vstage = "approved"; d.vstageAt = now; d.vmissed = 0; d.vdueMissed = null;
      const npd = String(d.plannedDate || today).slice(0, 10);
      log(d.id, "sys", `менеджер одобрил видео, публикация ${ddmm(npd)}`);
      sent = await tellBlogger(d, "approved", [nameOf(d), d.product || "", npd === today ? "сегодня" : ddmm(npd)]);
    } else if (action === "revise" || action === "reshoot") {
      const days = Math.max(1, Math.min(10, Number(b.days) || (action === "revise" ? 1 : 2)));
      // Исправленное видео ждём через N рабочих дней от сегодня; публикацию двигаем, только если она раньше,
      // чем рабочий день после нового срока (видео пришло заранее — дата публикации остаётся).
      // Дату выхода НЕ двигаем (ТЗ §9, §12) — только срок исправленного видео; перенос — решение менеджера.
      const due = addWorkdays(today, days);
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
