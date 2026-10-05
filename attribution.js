// ============================================================================
// attribution.js — расчёт «вклада в продажи» (колонка «Авто (Kaspi)») для интеграций
// блогеров по заказам Kaspi. Результат пишется в public.influencer_placements
// (auto_contribution_units/kzt/status/note/computed_at) — БД и поля те же, что раньше.
//
// v7 (02.10.2026) — переписано ядро: фон, перекрытия окон, время заказов, дедупликация.
//
// ОКНО. Точного времени выхода нет, рабочее допущение (решение Нины): крупные выходят в 12:00
// (окно 12:00 D0 … 12:00 D+1), микро — в 16:00 (16:00 D0 … 16:00 D+1). Время заказа —
// kaspi_order_sync_state.creation_at (Asia/Almaty).
//
// 1. ЗАКАЗЫ. analytics.kaspi_live_order_entries по конкретному SKU из ШК. Одна строка заказа =
//    один entry_id (последний снимок по last_seen_at, порядок детерминирован). Строки без entry_id
//    не склеиваются по (заказ, SKU) — ключ включает количество и сумму. Без CANCELLED/CANCELLING и
//    без заказов с возвратом (в источнике возврат есть только на уровне заказа — исключается
//    заказ целиком, одинаково и в окне, и в фоне). Агрегируем по (SKU, час) до соединения с
//    интеграциями. Заказы БЕЗ ВРЕМЕНИ по часам НЕ раскладываются: они не входят ни в окно, ни в
//    фон, а их доля в днях окна проверяется — больше 25% → статус partial_time_data («—»),
//    больше 5% → уверенность «низкая».
//
// 2. ФОН (в штуках, по SKU и часу). «Чистые» часы SKU — не в окне ни одной публикации этого SKU
//    (крупные + микро) и не в 12 ч после окна (хвост). День с ≥ 50% чистых часов (по профилю SKU)
//    — наблюдение: шт/сутки = чистые шт / доля чистых часов, приведённые к среднему дню недели.
//    Дни со скидкой (цена ниже медианной цены чистых дней > 5%) выкидываются.
//    Уровень на дату = усечённое среднее (по 15% с краёв) по чистым дням ±14 дн. с весами:
//    тот же день недели ×2, ближе к дате — больше. Тренд SKU — наклон Тейла–Сена по тем же дням
//    (не больше ±30% к уровню). Фон часа = уровень × коэффициент дня недели (по магазину) ×
//    доля часа в профиле SKU (свой профиль SKU, сглаженный к профилю магазина для будней/выходных).
//    Нужно ≥ 5 «эквивалентных суток» чистых дней; иначе запасная ступень ±60 дн. (≥ 3 сут.,
//    уверенность «низкая»); иначе «—».
//
// 3. ПРИРОСТ. Цена перевода в тенге — фактическая средняя цена продаж в группе окон.
//    Прирост часа e = (заказы, шт − фон, шт) × цена. Часы окна делятся на:
//      • СВОИ (эксклюзивные) — активна только эта публикация SKU: прирост наблюдаемый, целиком её;
//      • ОБЩИЕ — активно несколько: прирост часа делится по √охвата × формат (Stories ×2,
//        видео ×1) — это условное распределение, а не наблюдение;
//      • НЕРАСПРЕДЕЛЁННЫЕ — общий час, где у кого-то нет охвата: никому не отдаётся.
//    Вклад = max(0, свои + доля общих). Ограничение на группу пересекающихся окон: Σ вкладов ≤
//    max(0, Σ(заказы − фон)) ≤ заказы. Если клиппинг отрицательных даёт превышение — сначала
//    срезается доля общих часов, потом (если мало) свои. Проверка в коде → compute_error.
//    Почасовой потолок max(0, e_h) не используется намеренно: сумма положительных шумов за 24 ч
//    всегда > 0 и систематически завышает вклад.
//
// 4. УВЕРЕННОСТЬ (в заметке): ВЫСОКАЯ — ≥ 8 сут. чистых данных рядом, без скидки, ≥ 60% своих
//    часов, заказы с временем; НИЗКАЯ — < 40% своих часов, мало чистых данных (< 6 сут. или
//    запасная ступень), заказы без времени > 5%, нераспределённые часы; иначе СРЕДНЯЯ.
//
// 5. «—» (числа нет): фон не обоснован; скидка в окне; > 1 покупки на 100 просмотров; заказов без
//    времени > 25%; нет охвата и нет своих часов; окно раньше истории Kaspi.
//
// 6. ОКНО ЕЩЁ ИДЁТ: считаем по прошедшим часам, но в официальное поле auto_contribution_kzt
//    сумма НЕ пишется (там null) — только в машиночитаемую метку в начале заметки (p=1).
//    Фронтенд показывает её как «⏳ пока N ₸», в итоги/ROMI она не входит.
//
// Метка в начале заметки (новых колонок нет): ⟦v7;t=итого;x=свои;s=из общих;c=H|M|L;
//   xh=своих часов;sh=общих;uh=нераспределённых;cd=сут. чистых данных;p=1 если предварительно⟧
//
// 7. Ручной вклад менеджера живёт в barter-box и главнее; сервер его не видит — доля такого
//    блогера остаётся нераспределённой. «Нет всплеска» на расчёт не влияет.
// 8. Одна интеграция в обеих таблицах учитывается один раз (строка крупных), вторая — duplicate.
// 9. Каждый прогон пересчитывает все вышедшие строки; остальные обнуляются. v7.1: вышедшей
//    считается строка со статусом «опубликовано» ИЛИ с датой выхода и (оплачено или ссылка на ролик)
//    — раньше оплаченные/«товар отправлен» с уже вышедшим роликом выпадали из расчёта.
// ============================================================================

const PARAMS_VERSION = "attrib-v7.1-2026-10-05";

const ASSUMED_POST_HOUR = { barter_box_deals: 12, barter_box_micro: 16 };
const WINDOW_HOURS = 24;
const POST_WINDOW_TAIL_HOURS = 12;      // после окна часы ещё не «чистые» (досмотры, отложенные покупки)

const BASELINE_SEARCH_RADIUS_DAYS = 14;
const BASELINE_MIN_DAYS = 5;            // эквивалентных суток чистых данных для надёжного фона
const BASELINE_FALLBACK_RADIUS_DAYS = 60;
const BASELINE_FALLBACK_TARGET_DAYS = 7;
const BASELINE_FALLBACK_MIN_DAYS = 3;
const CLEAN_DAY_MIN_COVERAGE = 0.5;     // день идёт в фон, если чистые часы покрывают ≥ 50% его продаж
const SAME_DOW_WEIGHT = 2;
const TRIM_SHARE = 0.15;
const TREND_MAX_EFFECT = 0.3;
const SKU_PROFILE_PRIOR = 20;           // «виртуальных штук» профиля магазина при сглаживании профиля SKU

const PRICE_DRIFT_TOLERANCE = 0.05;
const PRICE_NOTE_TOLERANCE = 0.015;
const MAX_PURCHASES_PER_VIEW = 0.01;
const UNDATED_LOW_CONFIDENCE = 0.05;
const UNDATED_NO_NUMBER = 0.25;

const CONF_HIGH_CLEAN_DAYS = 8;
const CONF_HIGH_EXCL_SHARE = 0.6;
const CONF_LOW_EXCL_SHARE = 0.4;
const CONF_LOW_CLEAN_DAYS = 6;

const FORMAT_COEF_STORIES = 2;
const FORMAT_COEF_DEFAULT = 1;
function formatOf(platform) {
  const p = String(platform || "").toLowerCase();
  if (/stories|сторис/.test(p)) return { coef: FORMAT_COEF_STORIES, label: "Stories ×2" };
  if (/reels|рилс|tiktok|тикток|shorts|видео|video|youtube/.test(p)) return { coef: FORMAT_COEF_DEFAULT, label: "видео ×1" };
  return { coef: FORMAT_COEF_DEFAULT, label: p ? `«${platform}» ×1` : "формат не указан ×1" };
}
const EXCLUDED_ORDER_STATUSES = ["CANCELLED", "CANCELLING"];

// Коды каталога поставщика без заказов в Kaspi → живая карточка того же товара (проверено 30.09.2026).
const CATALOG_CODE_MAP = {
  SKUA000932400: "4620400203526", // тональный флюид 01
  SKUA000932500: "4620400203533", // тональный флюид 02
  SKUA000662900: "2000000034256", // набор Collagen&Biotin
  SKUA000635300: "4650358457429", // спрей-фиксатор
  SKUA000677100: "4650358455579", // крем Vitamin C
  SKUA000834500: "4680607211953", // ламинирующая маска
  SKUA001006300: "4620400204820", // блеск cherry cola
  SKUA001006500: "4620400204318", // стик для контуринга 01
  "4650195821414": "SKU0014304000", // гидрофильное масло Mango
};

// Статусы, у которых в официальном поле суммы нет (null). window_open / kaspi_data_pending —
// предварительная сумма только в метке заметки.
const NO_NUMBER_STATUSES = new Set([
  "no_published_date", "no_sku_code", "no_sku_data", "no_kaspi_data",
  "needs_reach_data", "baseline_uncertain", "partial_time_data",
  "duplicate", "compute_error", "window_open", "kaspi_data_pending",
]);
const CONF_LABEL = { H: "высокая", M: "средняя", L: "низкая" };
const CONF_RANK = { H: 3, M: 2, L: 1 };

// ---------------------------------------------------------------------------
// Утилиты. Часы — строки 'YYYY-MM-DDTHH' по Алматы (UTC+5, без перехода на летнее время).
// ---------------------------------------------------------------------------
function splitCodes(raw) {
  return (raw || "").split(/[,+;\s]+/).map((s) => s.trim()).filter(Boolean);
}
function almatyTodayStr() {
  return new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
}
function almatyNowHour() {
  return new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 13);
}
function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function hourKey(date, h) { return `${date}T${String(h).padStart(2, "0")}`; }
function addHours(hk, n) {
  const d = new Date(hk + ":00:00Z");
  d.setUTCHours(d.getUTCHours() + n);
  return d.toISOString().slice(0, 13);
}
function hourOfDay(hk) { return Number(hk.slice(11, 13)); }
function dateOf(hk) { return hk.slice(0, 10); }
function dowOf(date) { return new Date(date + "T00:00:00Z").getUTCDay(); }
function dayType(date) { const d = dowOf(date); return d === 0 || d === 6 ? "we" : "wd"; }
function fmt(n) { return Math.round(n).toLocaleString("ru-RU").replace(/\s/g, " "); }
function fmtQ(n) { return (Math.round(n * 10) / 10).toLocaleString("ru-RU").replace(/\s/g, " "); }
function ddmm(hk) { return `${hk.slice(8, 10)}.${hk.slice(5, 7)} ${hk.slice(11, 13)}:00`; }
function normalizeHandle(h) {
  let s = (h || "").trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  s = s.replace(/^(instagram\.com|instagr\.am|tiktok\.com)\//, "");
  s = s.split(/[?#]/)[0].replace(/^@/, "");
  s = s.split("/")[0].replace(/^@/, "");
  return s;
}
const EMPTY = Object.freeze({ lines: 0, cancelled: 0, returned: 0, netLines: 0, qty: 0, kzt: 0 });
function windowOf(source, d0) {
  const start = hourKey(d0, ASSUMED_POST_HOUR[source] != null ? ASSUMED_POST_HOUR[source] : 12);
  const hours = [];
  for (let i = 0; i < WINDOW_HOURS; i++) hours.push(addHours(start, i));
  return { start, end: addHours(start, WINDOW_HOURS), hours };
}
function normProfile(arr) {
  if (!Array.isArray(arr) || arr.length !== 24) return Array(24).fill(1 / 24);
  const s = arr.reduce((a, b) => a + (Number(b) > 0 ? Number(b) : 0), 0);
  return s > 0 ? arr.map((x) => (Number(x) > 0 ? Number(x) : 0) / s) : Array(24).fill(1 / 24);
}
function median(xs) {
  const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
// Взвешенное усечённое среднее: отбрасываем по TRIM_SHARE веса с каждого края.
function weightedTrimmedMean(items) {
  const it = items.filter((x) => x.w > 0 && Number.isFinite(x.v)).sort((a, b) => a.v - b.v);
  const tot = it.reduce((a, x) => a + x.w, 0);
  if (!tot) return null;
  if (it.length < 5) return it.reduce((a, x) => a + x.v * x.w, 0) / tot;
  const lo = TRIM_SHARE * tot, hi = (1 - TRIM_SHARE) * tot;
  let cum = 0, sw = 0, sv = 0;
  for (const x of it) {
    const a = cum, b = cum + x.w; cum = b;
    const ov = Math.max(0, Math.min(b, hi) - Math.max(a, lo));
    sw += ov; sv += ov * x.v;
  }
  return sw > 0 ? sv / sw : null;
}
// Наклон Тейла–Сена: медиана наклонов по всем парам точек — устойчив к выбросам.
function theilSen(points) {
  const s = [];
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    const dx = points[j].x - points[i].x;
    if (dx !== 0) s.push((points[j].y - points[i].y) / dx);
  }
  return s.length ? median(s) : 0;
}
// Метка в начале заметки — машиночитаемая разбивка (фронтенд её разбирает и не показывает).
function makeTag(o) {
  const parts = ["v7"];
  for (const k of ["t", "x", "s", "c", "xh", "sh", "uh", "cd", "p"]) if (o[k] != null) parts.push(`${k}=${o[k]}`);
  return `⟦${parts.join(";")}⟧`;
}
function parseTag(note) {
  const m = String(note || "").match(/^⟦v7;([^⟧]*)⟧/);
  if (!m) return null;
  const o = {};
  m[1].split(";").forEach((kv) => { const [k, v] = kv.split("="); if (k) o[k] = v; });
  return o;
}

// ---------------------------------------------------------------------------
// ЧИСТАЯ функция расчёта (без базы).
//   placements   — опубликованные интеграции [{id, source, blogger_handle, reach, platform, kaspi_code, published_date}]
//   resolution   — Map исходный код → живой код | null
//   hourly       — Map код → Map 'YYYY-MM-DDTHH' → {lines,cancelled,returned,netLines,qty,kzt} (только заказы с временем)
//   undated      — Map код → Map 'YYYY-MM-DD' → то же (заказы без времени — только для доли/статуса)
//   storeProfile — {wd:[24], we:[24]} доли выручки магазина по часам для будней/выходных
//   weekdayFactor— [7] коэффициенты дня недели (0 = вс), среднее ≈ 1
//   listedSince, feedStart, dataLoadedThrough, nowHour ('YYYY-MM-DDTHH'), syncFresh
// ---------------------------------------------------------------------------
function planAttribution({ placements, resolution, hourly, undated, storeProfile, weekdayFactor, listedSince, feedStart, dataLoadedThrough, nowHour, syncFresh }) {
  const results = new Map();
  const V = ` [${PARAMS_VERSION}]`;
  const setNo = (id, status, note, tag) => results.set(String(id), { status, units: null, kzt: null, note: (tag ? tag + " " : "") + note + V });
  const storeP = { wd: normProfile(storeProfile && storeProfile.wd), we: normProfile(storeProfile && storeProfile.we) };
  const wf = Array.isArray(weekdayFactor) && weekdayFactor.length === 7 ? weekdayFactor.map((x) => (Number(x) > 0 ? Number(x) : 1)) : Array(7).fill(1);
  const undatedMap = undated || new Map();

  // Последний час с полными данными (исключительно).
  const lastCompleteExcl = (() => {
    const a = nowHour;
    if (syncFresh && dataLoadedThrough && dataLoadedThrough >= dateOf(nowHour)) return a;
    const b = dataLoadedThrough ? hourKey(dataLoadedThrough, 0) : null;
    return b && b < a ? b : a;
  })();
  const rec = (code, hk) => (hourly.get(code) && hourly.get(code).get(hk)) || EMPTY;

  // Часы, занятые любой опубликованной интеграцией с этим кодом (+ хвост после окна) — не для фона.
  const busyByCode = new Map();
  for (const p of placements) {
    if (!p.published_date) continue;
    const w = windowOf(p.source, p.published_date);
    const hrs = w.hours.slice();
    for (let i = 0; i < POST_WINDOW_TAIL_HOURS; i++) hrs.push(addHours(w.end, i));
    for (const raw of splitCodes(p.kaspi_code)) {
      for (const c of [raw, resolution.get(raw)]) {
        if (!c) continue;
        if (!busyByCode.has(c)) busyByCode.set(c, new Set());
        const set = busyByCode.get(c);
        hrs.forEach((h) => set.add(h));
      }
    }
  }

  // --- 1. Кто участвует ---
  const eligible = [];
  for (const p of placements) {
    const d0 = p.published_date;
    if (!d0) { setNo(p.id, "no_published_date", "Статус «опубликовано», но дата публикации не заполнена."); continue; }
    const raw = splitCodes(p.kaspi_code);
    if (!raw.length) { setNo(p.id, "no_sku_code", "ШК/SKU не указан — рекламируемый товар не определён."); continue; }
    const dead = raw.filter((c) => !resolution.get(c));
    if (dead.length) { setNo(p.id, "no_sku_data", `Код ${dead.join(", ")} не найден в заказах Kaspi (и замены нет ни в каталоге, ни в справочнике product_aliases) — впишите живой код товара.`); continue; }
    const w = windowOf(p.source, d0);
    if (feedStart && d0 < feedStart) { setNo(p.id, "no_kaspi_data", `Окно ${ddmm(w.start)}–${ddmm(w.end)} раньше начала истории заказов Kaspi (${feedStart}).`); continue; }
    let partial = null;
    if (nowHour < w.end || lastCompleteExcl < w.end) {
      const until = nowHour < lastCompleteExcl ? nowHour : lastCompleteExcl;
      const done = w.hours.filter((h) => h < until);
      const st = nowHour < w.end ? "window_open" : "kaspi_data_pending";
      if (!done.length) {
        setNo(p.id, st, st === "window_open"
          ? `Окно 24 ч (${ddmm(w.start)}–${ddmm(w.end)}) только началось — предварительная сумма появится в течение часа.`
          : `Заказы Kaspi загружены только по ${dataLoadedThrough || "?"} — окно ${ddmm(w.start)}–${ddmm(w.end)} ещё не догружено.`);
        continue;
      }
      partial = { status: st, until };
      w.hours = done;
    }
    const codes = [...new Set(raw.map((c) => resolution.get(c)))].sort();
    const replaced = raw.filter((c) => resolution.get(c) !== c).map((c) => `${c}→${resolution.get(c)}`);
    eligible.push({ ...p, id: String(p.id), d0, codes, replaced, win: w, partial, handle: normalizeHandle(p.blogger_handle), format: formatOf(p.platform) });
  }

  // --- 2. Дубли одной интеграции в двух таблицах ---
  const groups = new Map();
  for (const p of eligible) {
    const key = p.handle ? `${p.handle}|${p.d0}|${p.codes.join(",")}` : `id:${p.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const primaries = [];
  for (const members of groups.values()) {
    members.sort((a, b) => (a.source === b.source ? Number(a.id) - Number(b.id) : a.source === "barter_box_deals" ? -1 : 1));
    const primary = members[0];
    const reaches = members.map((m) => Number(m.reach) || 0).filter((r) => r > 0);
    primary.reachUsed = reaches.length ? Math.max(...reaches) : 0;
    primary.weight = Math.sqrt(primary.reachUsed) * primary.format.coef;
    primary.duplicates = members.slice(1);
    primaries.push(primary);
    for (const dup of members.slice(1)) {
      setNo(dup.id, "duplicate", `Та же интеграция (${dup.blogger_handle}, ${dup.d0}, ${dup.codes.join(", ")}) уже учтена в строке id ${primary.id} — сумма записана там, чтобы не задвоить заказы.`);
    }
  }

  // --- 3. Фон по SKU ---
  const loCache = new Map();
  function loOf(code) {
    if (loCache.has(code)) return loCache.get(code);
    const listed = (listedSince && listedSince.get(code)) || feedStart || "0000-00-00";
    const loDate = feedStart && feedStart > listed ? feedStart : listed;
    const v = hourKey(loDate, 0);
    loCache.set(code, v);
    return v;
  }
  const isClean = (code, hk) => hk >= loOf(code) && hk < lastCompleteExcl && !(busyByCode.get(code) && busyByCode.get(code).has(hk));

  // Профиль SKU по часам (будни/выходные) по чистым часам, сглаженный к профилю магазина.
  const profCache = new Map();
  function skuProfile(code) {
    if (profCache.has(code)) return profCache.get(code);
    // Профиль — по ИНТЕНСИВНОСТИ (шт на один чистый час данного часа суток), а не по сумме штук:
    // иначе часы, чаще попадающие в окна рекламы, получали бы заниженную долю.
    const q = { wd: Array(24).fill(0), we: Array(24).fill(0) }, c = { wd: Array(24).fill(0), we: Array(24).fill(0) }, n = { wd: 0, we: 0 };
    const m = hourly.get(code);
    if (m && m.size) {
      const keys = [...m.keys()].sort();
      let d = dateOf(keys[0]) > dateOf(loOf(code)) ? dateOf(keys[0]) : dateOf(loOf(code));
      const lastD = dateOf(keys[keys.length - 1]) < dateOf(lastCompleteExcl) ? dateOf(keys[keys.length - 1]) : dateOf(lastCompleteExcl);
      for (; d <= lastD; d = addDaysStr(d, 1)) {
        const t = dayType(d);
        for (let h = 0; h < 24; h++) {
          const hk = hourKey(d, h);
          if (!isClean(code, hk)) continue;
          const r = rec(code, hk);
          c[t][h]++; q[t][h] += r.qty; n[t] += r.qty;
        }
      }
    }
    const out = {};
    for (const t of ["wd", "we"]) {
      const rate = q[t].map((x, h) => (c[t][h] ? x / c[t][h] : 0));
      const rs = rate.reduce((a, b) => a + b, 0);
      const raw = rs > 0 ? rate.map((x) => x / rs) : storeP[t];
      out[t] = raw.map((x, h) => (n[t] * x + SKU_PROFILE_PRIOR * storeP[t][h]) / (n[t] + SKU_PROFILE_PRIOR));
    }
    profCache.set(code, out);
    return out;
  }
  // Чистая часть дня: доля продаж дня, которую покрывают чистые часы, и что в них продано.
  const dayCache = new Map();
  function cleanDay(code, date) {
    const key = code + "|" + date;
    if (dayCache.has(key)) return dayCache.get(key);
    const p = skuProfile(code)[dayType(date)];
    let cov = 0, qty = 0, kzt = 0;
    for (let h = 0; h < 24; h++) {
      const hk = hourKey(date, h);
      if (!isClean(code, hk)) continue;
      cov += p[h];
      const r = rec(code, hk);
      qty += r.qty; kzt += r.kzt;
    }
    const v = { date, cov, qty, kzt };
    dayCache.set(key, v);
    return v;
  }
  const levelCache = new Map();
  function levelFor(code, date) {
    const key = code + "|" + date;
    if (levelCache.has(key)) return levelCache.get(key);
    const collect = (radius) => {
      const obs = [];
      for (let k = -radius; k <= radius; k++) {
        const c = cleanDay(code, addDaysStr(date, k));
        if (c.cov >= CLEAN_DAY_MIN_COVERAGE) obs.push({ ...c, off: k });
      }
      return obs;
    };
    let obs = collect(BASELINE_SEARCH_RADIUS_DAYS), tier = 1;
    const eqOf = (a) => a.reduce((s, o) => s + o.cov, 0);
    if (eqOf(obs) < BASELINE_MIN_DAYS) {
      const wide = collect(BASELINE_FALLBACK_RADIUS_DAYS).sort((a, b) => Math.abs(a.off) - Math.abs(b.off) || a.off - b.off);
      const pick = [];
      let e = 0;
      for (const o of wide) { if (e >= BASELINE_FALLBACK_TARGET_DAYS) break; pick.push(o); e += o.cov; }
      if (e > eqOf(obs)) { obs = pick; tier = 2; }
    }
    // Дни со скидкой (цена заметно ниже обычной цены чистых дней) — не фон.
    const prices = obs.filter((o) => o.qty > 0).map((o) => o.kzt / o.qty);
    const medPrice = median(prices);
    let discountDays = 0;
    if (prices.length >= 3 && medPrice) {
      const before = obs.length;
      obs = obs.filter((o) => !(o.qty > 0 && o.kzt / o.qty < medPrice * (1 - PRICE_DRIFT_TOLERANCE)));
      discountDays = before - obs.length;
    }
    const cleanEq = eqOf(obs);
    const tDow = dowOf(date);
    const pts = obs.map((o) => ({
      x: o.off,
      y: o.qty / o.cov / wf[dowOf(o.date)],
      w: o.cov * (dowOf(o.date) === tDow ? SAME_DOW_WEIGHT : 1) / (1 + Math.abs(o.off) / 7),
    }));
    let level = weightedTrimmedMean(pts.map((p) => ({ v: p.y, w: p.w })));
    let slope = 0;
    if (level != null && pts.length >= 6 && Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x)) >= 7) {
      slope = theilSen(pts);
      const adj = weightedTrimmedMean(pts.map((p) => ({ v: p.y - slope * p.x, w: p.w })));
      if (adj != null) level = level > 0 ? Math.min(level * (1 + TREND_MAX_EFFECT), Math.max(level * (1 - TREND_MAX_EFFECT), adj)) : Math.max(0, adj);
    }
    if (level != null) level = Math.max(0, level);
    const qSum = obs.reduce((s, o) => s + o.qty, 0), kSum = obs.reduce((s, o) => s + o.kzt, 0);
    const ok = tier === 1 ? cleanEq >= BASELINE_MIN_DAYS : cleanEq >= BASELINE_FALLBACK_MIN_DAYS;
    const days = obs.map((o) => o.date).sort();
    const res = {
      levelUnits: ok ? level : null, cleanEq, tier, ok, slope, discountDays,
      price: qSum > 0 ? kSum / qSum : null,
      sameDow: obs.filter((o) => dowOf(o.date) === tDow).length,
      firstDay: days[0] || null, lastDay: days[days.length - 1] || null,
    };
    levelCache.set(key, res);
    return res;
  }
  const baseUnits = (code, hk) => {
    const L = levelFor(code, dateOf(hk));
    if (L.levelUnits == null) return 0;
    const d = dateOf(hk);
    return L.levelUnits * wf[dowOf(d)] * skuProfile(code)[dayType(d)][hourOfDay(hk)];
  };
  // Доля заказов без времени в днях окна.
  function undatedShare(code, hours) {
    let u = 0, all = 0;
    for (const d of new Set(hours.map(dateOf))) {
      const ud = undatedMap.get(code) && undatedMap.get(code).get(d);
      const uq = ud ? ud.qty : 0;
      let dq = 0;
      for (let h = 0; h < 24; h++) dq += rec(code, hourKey(d, h)).qty;
      u += uq; all += uq + dq;
    }
    return all > 0 ? u / all : 0;
  }

  // --- 4. Распределение по часам ---
  const byCode = new Map();
  for (const p of primaries) for (const c of p.codes) {
    if (!byCode.has(c)) byCode.set(c, []);
    byCode.get(c).push(p);
  }
  const perPlacement = new Map();
  const push = (id, x) => { if (!perPlacement.has(id)) perPlacement.set(id, []); perPlacement.get(id).push(x); };
  const nameOf = (x) => x.handle || x.blogger_handle || `id ${x.id}`;

  for (const [code, members] of byCode) {
    const active = new Map();
    for (const m of members) for (const hk of m.win.hours) {
      if (!active.has(hk)) active.set(hk, []);
      active.get(hk).push(m);
    }
    // Связные группы пересекающихся окон.
    const parent = new Map(members.map((m) => [m.id, m.id]));
    const find = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x; };
    for (const list of active.values()) for (let i = 1; i < list.length; i++) {
      const a = find(list[i].id), b = find(list[0].id);
      if (a !== b) parent.set(a, b);
    }
    const clusters = new Map();
    for (const m of members) { const r = find(m.id); if (!clusters.has(r)) clusters.set(r, []); clusters.get(r).push(m); }

    for (const cl of clusters.values()) {
      const inCl = new Set(cl.map((m) => m.id));
      const hoursSet = new Set();
      cl.forEach((m) => m.win.hours.forEach((h) => hoursSet.add(h)));
      const hours = [...hoursSet].sort();
      let Aq = 0, Ak = 0;
      for (const hk of hours) { const r = rec(code, hk); Aq += r.qty; Ak += r.kzt; }
      // Цена перевода штук в тенге — фактическая цена продаж в группе окон (нет продаж — цена чистых дней).
      const P = Aq > 0 ? Ak / Aq : (levelFor(code, dateOf(hours[0])).price || 0);

      const st = new Map(cl.map((m) => [m.id, { E: 0, S: 0, xh: 0, sh: 0, uh: 0, sharedGross: 0, A: 0, Aq: 0, Bq: 0, lines: 0, canc: 0, ret: 0, partners: new Set(), missing: new Set() }]));
      let sumE = 0, sumBq = 0;
      for (const hk of hours) {
        const act = active.get(hk).filter((m) => inCl.has(m.id));
        const r = rec(code, hk);
        const Bq = baseUnits(code, hk);
        const e = r.qty - Bq;
        sumE += e; sumBq += Bq;
        for (const m of act) {
          const s = st.get(m.id);
          s.A += r.kzt; s.Aq += r.qty; s.Bq += Bq; s.lines += r.netLines; s.canc += r.cancelled; s.ret += r.returned;
        }
        if (act.length === 1) { const s = st.get(act[0].id); s.E += e; s.xh++; continue; }
        const W = act.reduce((a, m) => a + m.weight, 0);
        const allReach = act.every((m) => m.weight > 0);
        for (const m of act) {
          const s = st.get(m.id);
          act.forEach((o) => { if (o.id !== m.id) s.partners.add(nameOf(o)); });
          if (allReach && W > 0) { s.S += e * m.weight / W; s.sh++; s.sharedGross += e; }
          else { s.uh++; act.filter((o) => !(o.weight > 0)).forEach((o) => s.missing.add(nameOf(o))); }
        }
      }
      // Вклад = max(0, свои + доля общих); разбивка так, чтобы части в сумме давали итог.
      for (const m of cl) {
        const s = st.get(m.id);
        const t = Math.max(0, s.E + s.S);
        if (t === 0) { s.x = 0; s.s = 0; }
        else if (s.E >= 0 && s.S >= 0) { s.x = s.E; s.s = s.S; }
        else if (s.E > 0) { s.x = t; s.s = 0; }
        else { s.x = 0; s.s = t; }
      }
      // Ограничение по факту: Σ вкладов группы ≤ max(0, Σ(заказы − фон)). Сначала режем доли общих часов.
      const cap = Math.max(0, sumE);
      let total = cl.reduce((a, m) => a + st.get(m.id).x + st.get(m.id).s, 0);
      let cut = 0;
      if (total > cap + 1e-9) {
        let excess = total - cap;
        cut = excess;
        const sSum = cl.reduce((a, m) => a + st.get(m.id).s, 0);
        if (sSum > 0) {
          const k = Math.min(1, excess / sSum);
          cl.forEach((m) => { st.get(m.id).s *= (1 - k); });
          excess -= Math.min(excess, sSum);
        }
        if (excess > 1e-9) {
          const xSum = cl.reduce((a, m) => a + st.get(m.id).x, 0);
          const k = xSum > 0 ? Math.min(1, excess / xSum) : 0;
          cl.forEach((m) => { st.get(m.id).x *= (1 - k); });
        }
        total = cl.reduce((a, m) => a + st.get(m.id).x + st.get(m.id).s, 0);
      }
      const kztOf = (u) => Math.max(0, Math.floor(u * P));
      const sumKzt = cl.reduce((a, m) => a + kztOf(st.get(m.id).x) + kztOf(st.get(m.id).s), 0);
      const invariantBroken = total > cap + 1e-6 || sumKzt > Ak + 1 || sumKzt > cap * P + cl.length * 2 + 1;

      for (const m of cl) {
        const s = st.get(m.id);
        const xK = kztOf(s.x), sK = kztOf(s.s), tK = xK + sK;
        const units = Math.floor((s.x + s.s) * 100) / 100;
        const L = [...new Set(m.win.hours.map(dateOf))].map((d) => levelFor(code, d));
        const weak = L.find((l) => !l.ok);
        const cleanEq = Math.min(...L.map((l) => l.cleanEq));
        const tier2 = L.some((l) => l.tier === 2);
        const clean = L.map((l) => l.price).filter(Boolean);
        let refPrice = clean.length ? clean.reduce((a, b) => a + b, 0) / clean.length : null;
        if (!refPrice) {
          let k = 0, q = 0;
          for (let d = 1; d <= 7; d++) for (let h = 0; h < 24; h++) { const r = rec(code, hourKey(addDaysStr(m.d0, -d), h)); k += r.kzt; q += r.qty; }
          refPrice = q > 0 ? k / q : null;
        }
        const winPrice = s.Aq > 0 ? s.A / s.Aq : null;
        const drift = winPrice && refPrice ? (winPrice - refPrice) / refPrice : 0;
        const uShare = undatedShare(code, m.win.hours);
        const allH = s.xh + s.sh + s.uh;
        const exclShare = allH ? s.xh / allH : 0;

        let status = tK > 0 ? "ok" : "zero", reason = null;
        if (invariantBroken) { status = "compute_error"; reason = `нарушен потолок: вклады ${fmt(sumKzt)} ₸ > прирост группы ${fmt(cap * P)} ₸ или заказы ${fmt(Ak)} ₸`; }
        else if (weak) { status = "baseline_uncertain"; reason = `фон не обоснован: часов без рекламы этого SKU почти нет — чистых данных на ${weak.cleanEq.toFixed(1)} сут. даже за ±${BASELINE_FALLBACK_RADIUS_DAYS} дн.`; }
        else if (drift < -PRICE_DRIFT_TOLERANCE) { status = "baseline_uncertain"; reason = `фон не обоснован: цена в окне ${fmt(winPrice)} ₸ ниже обычной цены дней без рекламы (${fmt(refPrice)} ₸, ${(drift * 100).toFixed(1)}%) — рост может быть от скидки`; }
        else if (uShare > UNDATED_NO_NUMBER) { status = "partial_time_data"; reason = `у ${Math.round(uShare * 100)}% заказов этого SKU в дни окна нет времени создания — окно 24 ч не отделить`; }
        else if (!(m.reachUsed > 0) && s.xh === 0) { status = "needs_reach_data"; reason = `у ${nameOf(m)} не заполнен охват, а все часы окна общие с другими — долю не обосновать (заполните охват)`; }
        else if (s.xh + s.sh === 0 && s.uh > 0) { status = "needs_reach_data"; reason = `у ${[...s.missing].slice(0, 4).join(", ")} не заполнен охват — общие часы не распределить (заполните охват)`; }
        else if (tK > 0 && m.reachUsed > 0 && units > m.reachUsed * MAX_PURCHASES_PER_VIEW) { status = "baseline_uncertain"; reason = `прирост ≈${Math.round(units)} шт несоразмерен охвату ${fmt(m.reachUsed)} (больше 1 покупки на 100 просмотров) — рост окна этой публикацией не объяснить`; }

        // Уверенность.
        const why = [];
        let conf;
        const low = [];
        if (exclShare < CONF_LOW_EXCL_SHARE) low.push(`своих часов ${Math.round(exclShare * 100)}% — остальное общее с другими`);
        if (tier2) low.push("фон по дальним дням (рядом чистых нет)");
        else if (cleanEq < CONF_LOW_CLEAN_DAYS) low.push(`мало чистых данных (${cleanEq.toFixed(1)} сут.)`);
        if (uShare > UNDATED_LOW_CONFIDENCE) low.push(`${Math.round(uShare * 100)}% заказов без времени`);
        if (s.uh > 0) low.push(`${s.uh} ч не распределено: нет охвата у ${[...s.missing].slice(0, 3).join(", ")}`);
        if (low.length) { conf = "L"; why.push(...low); }
        else if (!tier2 && cleanEq >= CONF_HIGH_CLEAN_DAYS && exclShare >= CONF_HIGH_EXCL_SHARE && drift >= -PRICE_NOTE_TOLERANCE) conf = "H";
        else {
          conf = "M";
          if (exclShare < CONF_HIGH_EXCL_SHARE) why.push(`своих часов ${Math.round(exclShare * 100)}%`);
          if (cleanEq < CONF_HIGH_CLEAN_DAYS) why.push(`чистых данных ${cleanEq.toFixed(1)} сут.`);
          if (drift < -PRICE_NOTE_TOLERANCE) why.push(`цена в окне ниже обычной на ${(-drift * 100).toFixed(1)}%`);
        }
        const L0 = L[0];
        push(m.id, {
          code, status, reason, xK, sK, tK, units, conf, why, exclShare, uShare,
          xh: s.xh, sh: s.sh, uh: s.uh, cleanEq,
          A: s.A, Aq: s.Aq, Bq: s.Bq, Bk: s.Bq * P, lines: s.lines, canc: s.canc, ret: s.ret, P,
          sharedGrossK: s.sharedGross * P, rawE: s.E, rawS: s.S,
          partners: [...s.partners], cut: cut > 1e-9,
          baseInfo: L0 ? `${L0.cleanEq.toFixed(1)} сут. чистых дней ${L0.firstDay ? L0.firstDay.slice(5) : "?"}…${L0.lastDay ? L0.lastDay.slice(5) : "?"}, того же дня недели ${L0.sameDow}${L0.discountDays ? `, дни со скидкой исключены (${L0.discountDays})` : ""}${Math.abs(L0.slope) > 1e-9 ? `, тренд ${L0.slope > 0 ? "+" : ""}${fmtQ(L0.slope)} шт/сут. за день` : ""}${L0.tier === 2 ? ", дальние дни" : ""}` : "",
        });
      }
    }
  }

  // --- 5. Итог по интеграции ---
  const RANK = { compute_error: 6, partial_time_data: 5, needs_reach_data: 4, baseline_uncertain: 3 };
  for (const p of primaries) {
    const parts = perPlacement.get(p.id) || [];
    const replNote = p.replaced.length ? ` Код заменён на живую карточку Kaspi: ${p.replaced.join(", ")}.` : "";
    const timeNote = `Окно 24 ч: ${ddmm(p.win.start)} – ${ddmm(p.win.end)} (допущение: ${p.source === "barter_box_deals" ? "крупные выходят в 12:00" : "микро выходят в 16:00"}).`;
    const bad = parts.filter((x) => RANK[x.status]).sort((a, b) => RANK[b.status] - RANK[a.status]);
    if (bad.length) {
      setNo(p.id, bad[0].status, `${timeNote} ${bad.map((x) => `SKU ${x.code} — ${x.reason}`).join("; ")}. Суммы нет («недостаточно данных»).${replNote}`);
      continue;
    }
    let x = 0, s = 0, units = 0, xh = 0, sh = 0, uh = 0, conf = "H", cd = Infinity;
    const why = [];
    for (const q of parts) {
      x += q.xK; s += q.sK; units += q.units; xh += q.xh; sh += q.sh; uh += q.uh;
      if (CONF_RANK[q.conf] < CONF_RANK[conf]) conf = q.conf;
      cd = Math.min(cd, q.cleanEq);
      q.why.forEach((w) => { if (!why.includes(w)) why.push(w); });
    }
    const t = x + s;
    if (!Number.isFinite(cd)) cd = 0;
    const txt = parts.map((q) =>
      `SKU ${q.code}: заказы в окне ${fmtQ(q.Aq)} шт / ${fmt(q.A)} ₸ (строк ${Math.round(q.lines)}; исключено: отмены ${Math.round(q.canc)}, возвраты ${Math.round(q.ret)}); ` +
      `фон окна ${fmtQ(q.Bq)} шт ≈ ${fmt(q.Bk)} ₸ (${q.baseInfo}); ` +
      `часы: свои ${q.xh}, общие ${q.sh}${q.uh ? `, не распределено ${q.uh}` : ""}` +
      (q.partners.length ? ` (общие с: ${q.partners.slice(0, 4).join(", ")}${q.partners.length > 4 ? ` и ещё ${q.partners.length - 4}` : ""}; прирост в общих часах всего ${fmt(q.sharedGrossK)} ₸, доля — по √охвата × формат: √${fmt(p.reachUsed)} × ${p.format.coef}, ${p.format.label})` : "") +
      (q.cut ? "; сумма группы окон срезана до её чистого прироста" : "") +
      ` → свои ${fmt(q.xK)} ₸ + из общих ${fmt(q.sK)} ₸`);
    const dupNote = p.duplicates.length ? ` Та же интеграция есть в строке id ${p.duplicates.map((d) => d.id).join(", ")} — сумма записана только здесь.` : "";
    const partialNote = p.partial ? `ПРЕДВАРИТЕЛЬНО: посчитано по ${ddmm(p.partial.until)}, окно идёт до ${ddmm(p.win.end)} — сумма ещё уточнится, в итоги и ROMI пока не входит. ` : "";
    const head = `Итого ${fmt(t)} ₸ (≈${fmtQ(units)} шт) = свои часы ${fmt(x)} ₸ (наблюдаемый прирост, когда выходила только она) + доля общих часов ${fmt(s)} ₸ (условно: √охвата × формат). Уверенность: ${CONF_LABEL[conf]}${why.length ? ` — ${why.join("; ")}` : ""}.`;
    const tag = makeTag({ t, x, s, c: conf, xh, sh, uh, cd: cd.toFixed(1), p: p.partial ? 1 : null });
    results.set(p.id, {
      status: p.partial ? p.partial.status : (t > 0 ? "ok" : "zero"),
      units: Math.round(units * 100) / 100,
      kzt: t,
      breakdown: { exclusiveKzt: x, sharedKzt: s, confidence: conf, exclusiveHours: xh, sharedHours: sh, unallocatedHours: uh, cleanDays: cd },
      note: `${tag} ${partialNote}${head} ${timeNote} ${txt.join(" | ")}.${replNote}${dupNote}${V}`,
    });
  }
  return { results };
}

// ---------------------------------------------------------------------------
// Ввод-вывод
// ---------------------------------------------------------------------------
// Дедупликация строк заказа: ключ — entry_id; если его нет, ключ включает количество и сумму,
// чтобы две разные строки одного SKU в одном заказе не склеились. Порядок детерминирован.
const LINES_CTE = `
  raw AS (
    SELECT e.order_id, e.offer_code, e.order_date, e.order_status, e.quantity, e.total_price, e.last_seen_at,
           (e.entry_id IS NULL) AS no_entry_id,
           COALESCE(e.entry_id::text, 'noid|' || e.order_id::text || '|' || e.offer_code || '|' || COALESCE(e.quantity::text, '') || '|' || COALESCE(e.total_price::text, '')) AS line_key
    FROM analytics.kaspi_live_order_entries e
    WHERE %WHERE%
  ),
  lines AS (
    SELECT DISTINCT ON (line_key) *
    FROM raw
    ORDER BY line_key, last_seen_at DESC NULLS LAST, order_status, total_price DESC NULLS LAST, quantity DESC NULLS LAST
  ),
  st AS (
    SELECT s.order_id, bool_or(COALESCE(s.return_recorded, false)) AS returned, min(s.creation_at) AS created
    FROM public.kaspi_order_sync_state s WHERE s.order_id IN (SELECT order_id FROM lines) GROUP BY s.order_id
  ),
  f AS (
    SELECT l.*, (l.order_status = ANY($EXCL::text[])) AS is_cancelled, COALESCE(st.returned, false) AS is_returned,
           to_char(st.created AT TIME ZONE 'Asia/Almaty', 'YYYY-MM-DD"T"HH24') AS hk
    FROM lines l LEFT JOIN st ON st.order_id = l.order_id
  )`;

// Какие строки считаем вышедшими. Не только status='published': у микро после оплаты статус
// становится «оплачено» (paid), а у части выходов отметку «опубликовано» не ставят, хотя есть дата
// выхода и ссылка на ролик. Поэтому: опубликовано, ИЛИ есть дата выхода и (оплачено или есть ссылка).
const PUBLISHED_SQL = `(status = 'published' OR (published_date IS NOT NULL AND (status = 'paid' OR NULLIF(btrim(video_url), '') IS NOT NULL)))`;

async function runDailyAttribution(pgPool, { log = console.log } = {}) {
  const nowHour = almatyNowHour();

  const reset = await pgPool.query(
    `UPDATE public.influencer_placements
     SET auto_contribution_units = NULL, auto_contribution_kzt = NULL,
         auto_contribution_status = NULL, auto_contribution_note = NULL,
         auto_contribution_computed_at = now()
     WHERE NOT ${PUBLISHED_SQL}
       AND (auto_contribution_status IS NOT NULL OR auto_contribution_kzt IS NOT NULL OR auto_contribution_units IS NOT NULL)`
  );
  const { rows: health } = await pgPool.query(`SELECT last_order_date::text AS d, minutes_since_ok::float8 AS m FROM analytics.kaspi_sync_health LIMIT 1`);
  const dataLoadedThrough = health[0] ? health[0].d : null;
  const syncFresh = !!(health[0] && health[0].m != null && Number(health[0].m) <= 90);
  const { rows: fsr } = await pgPool.query(`SELECT min(order_date)::text AS d FROM analytics.kaspi_live_order_entries`);
  const feedStart = fsr[0] ? fsr[0].d : null;

  const { rows: placements } = await pgPool.query(
    `SELECT id::text AS id, source, blogger_handle, reach, platform, kaspi_code, sku_name,
            published_date::date::text AS published_date
     FROM public.influencer_placements WHERE ${PUBLISHED_SQL}`
  );
  log(`[attribution ${PARAMS_VERSION}] ${nowHour}: опубликованных ${placements.length}, история Kaspi ${feedStart}…${dataLoadedThrough} (синк ${syncFresh ? "живой" : "давно не обновлялся"}), обнулено неопубликованных: ${reset.rowCount}`);
  if (!placements.length) return { processed: 0 };

  // 1. Живые коды + замены.
  const allRaw = [...new Set(placements.flatMap((p) => splitCodes(p.kaspi_code)))];
  const listedSince = new Map();
  const firstSeen = async (codes) => {
    if (!codes.length) return;
    const { rows } = await pgPool.query(
      `SELECT offer_code, min(order_date)::text AS first_d FROM analytics.kaspi_live_order_entries
       WHERE offer_code = ANY($1::text[]) GROUP BY offer_code`, [codes]);
    rows.forEach((r) => listedSince.set(r.offer_code, r.first_d));
  };
  await firstSeen(allRaw);
  const dead = allRaw.filter((c) => !listedSince.has(c));
  const aliasMap = new Map();
  for (const c of dead) if (CATALOG_CODE_MAP[c]) aliasMap.set(c, CATALOG_CODE_MAP[c]);
  const deadNoCatalog = dead.filter((c) => !aliasMap.has(c));
  if (deadNoCatalog.length) {
    const { rows } = await pgPool.query(
      `SELECT po.kaspi_code AS old_code, array_agg(DISTINCT pn.kaspi_code) AS new_codes
       FROM public.product_aliases pa
       JOIN public.products po ON po.id = pa.old_product_id
       JOIN public.products pn ON pn.id = pa.new_product_id
       WHERE po.kaspi_code = ANY($1::text[]) AND pn.kaspi_code IS NOT NULL
       GROUP BY po.kaspi_code`, [deadNoCatalog]);
    rows.forEach((r) => { if (r.new_codes.length === 1) aliasMap.set(r.old_code, r.new_codes[0]); });
  }
  await firstSeen([...new Set(aliasMap.values())].filter((c) => !listedSince.has(c)));
  const resolution = new Map();
  for (const c of allRaw) {
    if (listedSince.has(c)) resolution.set(c, c);
    else if (aliasMap.has(c) && listedSince.has(aliasMap.get(c))) resolution.set(c, aliasMap.get(c));
    else resolution.set(c, null);
  }

  // 2. Магазин за 90 дней: профиль по часам (будни/выходные) и коэффициенты дня недели.
  //    Без отмен и возвратов, только заказы с временем (для профиля).
  const storeProfile = { wd: Array(24).fill(0), we: Array(24).fill(0) };
  const weekdayFactor = Array(7).fill(1);
  {
    const today = nowHour.slice(0, 10);
    const sql = `WITH ${LINES_CTE.replace("%WHERE%", () => "e.order_date >= ($1::date - 90) AND e.order_date < $1::date").replace("$EXCL", () => "$2")}
      SELECT order_date::text AS d, hk, COALESCE(sum(total_price), 0)::float8 AS kzt
      FROM f WHERE NOT is_cancelled AND NOT is_returned GROUP BY 1, 2`;
    const { rows } = await pgPool.query(sql, [today, EXCLUDED_ORDER_STATUSES]);
    const daily = new Map();
    for (const r of rows) {
      daily.set(r.d, (daily.get(r.d) || 0) + Number(r.kzt));
      if (r.hk) storeProfile[dayType(r.hk.slice(0, 10))][Number(r.hk.slice(11, 13))] += Number(r.kzt);
    }
    const byDow = Array.from({ length: 7 }, () => []);
    for (const [d, v] of daily) if (!feedStart || d >= feedStart) byDow[dowOf(d)].push(v);
    const meds = byDow.map((a) => (a.length >= 2 ? median(a) : null));
    const known = meds.filter((x) => x > 0);
    if (known.length === 7) {
      const avg = known.reduce((a, b) => a + b, 0) / 7;
      meds.forEach((m, i) => { weekdayFactor[i] = Math.min(1.5, Math.max(0.6, m / avg)); });
    }
  }

  // 3. Заказы по (SKU, час) — агрегируем ДО соединения с интеграциями.
  const liveCodes = [...new Set([...resolution.values()].filter(Boolean))];
  const d0s = placements.map((p) => p.published_date).filter(Boolean).sort();
  const hourly = new Map(), undated = new Map();
  let undatedLines = 0, noEntryIdLines = 0;
  if (liveCodes.length && d0s.length && feedStart) {
    const fromWanted = addDaysStr(d0s[0], -BASELINE_FALLBACK_RADIUS_DAYS - 1);
    const from = fromWanted < feedStart ? feedStart : fromWanted;
    const to = addDaysStr(d0s[d0s.length - 1], BASELINE_FALLBACK_RADIUS_DAYS + 2);
    const sql = `WITH ${LINES_CTE.replace("%WHERE%", () => "e.offer_code = ANY($1::text[]) AND e.order_date BETWEEN $2::date AND $3::date").replace("$EXCL", () => "$4")}
      SELECT offer_code, hk, order_date::text AS d,
             count(*)::int AS lines,
             count(*) FILTER (WHERE no_entry_id)::int AS no_entry_id,
             count(*) FILTER (WHERE is_cancelled)::int AS cancelled,
             count(*) FILTER (WHERE NOT is_cancelled AND is_returned)::int AS returned,
             count(*) FILTER (WHERE NOT is_cancelled AND NOT is_returned)::int AS net_lines,
             COALESCE(sum(quantity) FILTER (WHERE NOT is_cancelled AND NOT is_returned), 0)::float8 AS qty,
             COALESCE(sum(total_price) FILTER (WHERE NOT is_cancelled AND NOT is_returned), 0)::float8 AS kzt
      FROM f GROUP BY offer_code, hk, order_date`;
    const { rows } = await pgPool.query(sql, [liveCodes, from, to, EXCLUDED_ORDER_STATUSES]);
    const add = (map, code, key, r) => {
      if (!map.has(code)) map.set(code, new Map());
      const m = map.get(code);
      const cur = m.get(key) || { lines: 0, cancelled: 0, returned: 0, netLines: 0, qty: 0, kzt: 0 };
      m.set(key, { lines: cur.lines + r.lines, cancelled: cur.cancelled + r.cancelled, returned: cur.returned + r.returned,
        netLines: cur.netLines + r.net_lines, qty: cur.qty + Number(r.qty), kzt: cur.kzt + Number(r.kzt) });
    };
    for (const r of rows) {
      noEntryIdLines += r.no_entry_id;
      if (r.hk) add(hourly, r.offer_code, r.hk, r);
      else { add(undated, r.offer_code, r.d, r); undatedLines += r.lines; }
    }
  }

  // 4. Расчёт и запись.
  const plan = planAttribution({ placements, resolution, hourly, undated, storeProfile, weekdayFactor, listedSince, feedStart, dataLoadedThrough, nowHour, syncFresh });
  const ids = [], units = [], kzts = [], statuses = [], notes = [];
  for (const p of placements) {
    const r = plan.results.get(String(p.id)) || { status: "compute_error", units: null, kzt: null, note: `Строка не попала в расчёт. [${PARAMS_VERSION}]` };
    ids.push(String(p.id));
    units.push(NO_NUMBER_STATUSES.has(r.status) ? null : r.units);
    kzts.push(NO_NUMBER_STATUSES.has(r.status) ? null : r.kzt);
    statuses.push(r.status);
    notes.push((r.note || "").slice(0, 900));
  }
  await pgPool.query(
    `UPDATE public.influencer_placements p
     SET auto_contribution_units = v.units, auto_contribution_kzt = v.kzt,
         auto_contribution_status = v.status, auto_contribution_note = v.note,
         auto_contribution_computed_at = now()
     FROM (SELECT unnest($1::text[]) AS id, unnest($2::numeric[]) AS units, unnest($3::numeric[]) AS kzt,
                  unnest($4::text[]) AS status, unnest($5::text[]) AS note) v
     WHERE p.id::text = v.id`,
    [ids, units, kzts, statuses, notes]);
  const byStatus = {}, byConf = {};
  statuses.forEach((s) => (byStatus[s] = (byStatus[s] || 0) + 1));
  for (const r of plan.results.values()) if (r.breakdown) byConf[r.breakdown.confidence] = (byConf[r.breakdown.confidence] || 0) + 1;
  log(`[attribution] готово: ${ids.length} строк; заказов без времени ${undatedLines} строк (в часы не раскладываются), строк без entry_id ${noEntryIdLines}; по статусам ${JSON.stringify(byStatus)}; уверенность ${JSON.stringify(byConf)}; дни недели ${weekdayFactor.map((x) => x.toFixed(2)).join("/")}`);
  return { processed: ids.length, byStatus, byConfidence: byConf, undatedLines, noEntryIdLines };
}

module.exports = {
  CATALOG_CODE_MAP, runDailyAttribution, planAttribution, almatyTodayStr, addDaysStr, splitCodes, normalizeHandle,
  windowOf, formatOf, parseTag, makeTag, weightedTrimmedMean, theilSen, PARAMS_VERSION, NO_NUMBER_STATUSES, ASSUMED_POST_HOUR,
};
