// ============================================================================
// attribution.js — расчёт «вклада в продажи» (колонка «Авто (Kaspi)») для интеграций
// блогеров по заказам Kaspi. Результат пишется в public.influencer_placements
// (auto_contribution_units/kzt/status/note/computed_at) — БД и поля те же, что раньше.
//
// v8 (13.10.2026) — МОДЕЛЬ «ПРОДАЖИ ↔ ОХВАТ ВЫХОДОВ» ПО ДНЯМ (вместо окна 24 ч с «чистым фоном»).
//
// Почему переписано. v7 считал фон по часам, где рекламы этого товара нет. Флюид, палетку, стики
// рекламируют каждый день десятки блогеров — «чистых» часов нет вообще (→ «—»), а там, где они
// есть, фон уже поднят самой кампанией (флюид до кампании ~17 шт/день, в октябре 250–500),
// поэтому вклад блогеров срезался почти до нуля. Плюс заказы последних дней ещё не имели времени
// в kaspi_order_sync_state (→ partial_time_data). v8 решает обе проблемы.
//
// 1. ЗАКАЗЫ ПО ДНЯМ. analytics.kaspi_live_order_entries по SKU и дате заказа (order_date), строка =
//    entry_id (последний снимок), без отмен (статус строки ИЛИ отмена в kaspi_orders_register) и
//    без заказов с зафиксированным возвратом. Время заказа больше не нужно.
//
// 2. ЭКСПОЗИЦИЯ. Каждый выход SKU даёт «охват-силу» w = √охвата × формат (Stories ×2) и затухает:
//    эффект ролика падает вдвое каждые 24 ч (сторис — каждые 8 ч), считая от условного времени выхода
//    (крупные 12:00, микро 16:00). Доля эффекта, пришедшаяся на календарный день, — f(день).
//    Экспозиция дня E = Σ w·f по всем выходам этого SKU (крупные + микро), 7 дней от выхода.
//    Охват не заполнен → оценка по подписчикам (медианное отношение охват/подписчики по базе),
//    без подписчиков — медианный охват; уверенность «низкая», в пояснении написано.
//
// 3. МОДЕЛЬ ПО КАЖДОМУ SKU: продажи дня (шт, с поправкой на день недели) = фон(цена) + b × E,
//    фон(цена) = a + c·ln(цена дня / обычная цена), c ≤ 0 (v8.1, 15.10.2026): когда цену подняли,
//    обычных продаж меньше — фон ниже, и прирост выходов при высокой цене не «съедается» старым фоном;
//    при скидке фон выше — скидка не выдаётся за блогера. Если цена не менялась или модель даёт
//    c > 0 — цена не учитывается. Подбор по всей истории SKU (устойчивая регрессия). b — сколько штук даёт единица охват-силы:
//    находится из того, как продажи РЕАЛЬНО растут и падают вместе с количеством/охватом выходов.
//    Если связи нет (b ≤ 0 или t < 1) — вклад 0, это честный ответ «продажи не двигаются вместе с выходами».
//
// 4. v8.2: если выходы товара доказанно двигают продажи (t ≥ 2) — вклад = реальный всплеск заказов
//    сверх фона при той же цене (заказы − фон дня), поделённый между блогерами товара по доле экспозиции
//    этого дня; от дня выхода, пока всплеск не закончился (с 3-го дня), до 7 дней. Иначе — осторожно:
//    ВКЛАД ВЫХОДА за день = b × w × f(день) × (поправка дня недели). Сумма всех выходов за неделю не
//    больше продаж сверх фона за эту неделю: если модель «обещает» больше — всё срезается пропорционально.
//    Итог = сумма за 7 дней (день выхода + последующие), в тенге по фактической цене дня.
//    Потолок правдоподобия: не больше 1 покупки на 100 просмотров (если охват известен) — срезаем
//    до потолка, а не ставим «—».
//
// 5. УВЕРЕННОСТЬ: ВЫСОКАЯ — связь продаж с выходами t ≥ 3 и R² ≥ 0,3, охват известен; СРЕДНЯЯ — t ≥ 2;
//    НИЗКАЯ — иначе, или охват оценён.
//
// 6. «—»: нет даты / ШК / кода в Kaspi; выход раньше истории Kaspi; по SKU меньше 10 дней истории
//    или меньше 4 дней с выходами (модель не из чего построить). День выхода ещё не закончился —
//    window_open (суммы нет). Если 7 дней ещё не прошли — сумма есть (статус ok), в пояснении
//    «ещё копится до …».
//
// Метка в начале заметки (новых колонок нет): ⟦v8;t=итого;d0=день выхода;tl=следующие дни;c=H|M|L;
//   bt=t-статистика;r2=R²;re=1 если охват оценён;g=1 если ещё копится⟧
//
// 7. Ручной вклад менеджера живёт в barter-box и главнее. Одна интеграция в обеих таблицах —
//    один раз (строка крупных), вторая duplicate. Отменённые (cancelled) не считаются.
// ============================================================================

const PARAMS_VERSION = "attrib-v8.3-2026-10-15";

const ASSUMED_POST_HOUR = { barter_box_deals: 12, barter_box_micro: 16 };
const KERNEL_DAYS = 7;
const HALF_LIFE_HOURS_VIDEO = 24;
const HALF_LIFE_HOURS_STORIES = 8;
const MIN_FIT_DAYS = 10;
const MIN_EXPOSED_DAYS = 4;
const PRICE_DRIFT_TOLERANCE = 0.05;
const MAX_PURCHASES_PER_VIEW = 0.01;
const HUBER_K = 1.5;

const FORMAT_COEF_STORIES = 2;
const FORMAT_COEF_DEFAULT = 1;
function formatOf(platform) {
  const p = String(platform || "").toLowerCase();
  if (/stories|сторис/.test(p)) return { coef: FORMAT_COEF_STORIES, label: "Stories ×2", stories: true };
  if (/reels|рилс|tiktok|тикток|shorts|видео|video|youtube/.test(p)) return { coef: FORMAT_COEF_DEFAULT, label: "видео ×1", stories: false };
  return { coef: FORMAT_COEF_DEFAULT, label: p ? `«${platform}» ×1` : "формат не указан ×1", stories: false };
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

const NO_NUMBER_STATUSES = new Set([
  "no_published_date", "no_sku_code", "no_sku_data", "no_kaspi_data",
  "needs_reach_data", "baseline_uncertain", "partial_time_data",
  "duplicate", "compute_error", "window_open", "kaspi_data_pending",
]);
const CONF_LABEL = { H: "высокая", M: "средняя", L: "низкая" };
const CONF_RANK = { H: 3, M: 2, L: 1 };

// ---------------------------------------------------------------------------
// Утилиты (даты — 'YYYY-MM-DD' по Алматы)
// ---------------------------------------------------------------------------
function splitCodes(raw) { return (raw || "").split(/[,+;\s]+/).map((s) => s.trim()).filter(Boolean); }
function almatyTodayStr() { return new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10); }
function almatyNowHour() { return new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 13); }
function addDaysStr(dateStr, n) { const d = new Date(dateStr + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5); }
function dowOf(date) { return new Date(date + "T00:00:00Z").getUTCDay(); }
function fmt(n) { return Math.round(n).toLocaleString("ru-RU").replace(/\s/g, " "); }
function fmtQ(n) { return (Math.round(n * 10) / 10).toLocaleString("ru-RU").replace(/\s/g, " "); }
function ddmmD(d) { return `${d.slice(8, 10)}.${d.slice(5, 7)}`; }
function normalizeHandle(h) {
  let s = (h || "").trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  s = s.replace(/^(instagram\.com|instagr\.am|tiktok\.com)\//, "");
  s = s.split(/[?#]/)[0].replace(/^@/, "");
  s = s.split("/")[0].replace(/^@/, "");
  return s;
}
function median(xs) {
  const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function makeTag(o) {
  const parts = ["v8"];
  for (const k of ["t", "d0", "tl", "c", "bt", "r2", "re", "g"]) if (o[k] != null) parts.push(`${k}=${o[k]}`);
  return `⟦${parts.join(";")}⟧`;
}
function parseTag(note) {
  const m = String(note || "").match(/^⟦v[78];([^⟧]*)⟧/);
  if (!m) return null;
  const o = {};
  m[1].split(";").forEach((kv) => { const [k, v] = kv.split("="); if (k) o[k] = v; });
  return o;
}
// Доля эффекта выхода, пришедшаяся на календарный день dayIdx (0 = день выхода): экспонента с
// периодом полураспада hl часов, отсчёт от часа выхода postHour.
function kernelShare(dayIdx, postHour, hl) {
  const s = Math.max(0, dayIdx * 24 - postHour), e = dayIdx * 24 + 24 - postHour;
  if (e <= 0) return 0;
  return Math.pow(2, -s / hl) - Math.pow(2, -e / hl);
}
// Устойчивая линейная регрессия y = a + b·x (Huber, несколько итераций). Возвращает a, b, se(b), t, r2.
function robustFit(xs, ys) {
  const n = xs.length;
  let w = Array(n).fill(1), a = 0, b = 0;
  const wls = () => {
    let sw = 0, sx = 0, sy = 0;
    for (let i = 0; i < n; i++) { sw += w[i]; sx += w[i] * xs[i]; sy += w[i] * ys[i]; }
    const mx = sx / sw, my = sy / sw;
    let sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sxx += w[i] * (xs[i] - mx) ** 2; sxy += w[i] * (xs[i] - mx) * (ys[i] - my); }
    if (sxx <= 0) return false;
    b = sxy / sxx; a = my - b * mx;
    return true;
  };
  if (!wls()) return null;
  for (let it = 0; it < 6; it++) {
    const res = ys.map((y, i) => y - a - b * xs[i]);
    const mad = median(res.map((r) => Math.abs(r - median(res)))) || 0;
    const s = mad > 0 ? mad / 0.6745 : (Math.sqrt(res.reduce((q, r) => q + r * r, 0) / n) || 1);
    w = res.map((r) => { const u = Math.abs(r) / (HUBER_K * s); return u <= 1 ? 1 : 1 / u; });
    if (!wls()) return null;
  }
  // Стандартная ошибка b и R² — по взвешенным остаткам.
  let sw = 0, sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sw += w[i]; sx += w[i] * xs[i]; sy += w[i] * ys[i]; }
  const mx = sx / sw, my = sy / sw;
  let sxx = 0, sse = 0, sst = 0;
  for (let i = 0; i < n; i++) {
    sxx += w[i] * (xs[i] - mx) ** 2;
    const r = ys[i] - a - b * xs[i];
    sse += w[i] * r * r; sst += w[i] * (ys[i] - my) ** 2;
  }
  const dof = Math.max(1, n - 2);
  const se = sxx > 0 ? Math.sqrt(sse / dof / sxx) : Infinity;
  return { a, b, se, t: se > 0 && Number.isFinite(se) ? b / se : 0, r2: sst > 0 ? Math.max(0, 1 - sse / sst) : 0, n };
}

// Устойчивая регрессия y = a + b·x1 + c·x2 (Huber). Возвращает a, b, c, se(b), t(b), r2.
function solve3(M, v) {
  const A = M.map((r, i) => r.concat([v[i]]));
  for (let i = 0; i < 3; i++) {
    let p = i; for (let r = i + 1; r < 3; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    if (Math.abs(A[p][i]) < 1e-12) return null;
    [A[i], A[p]] = [A[p], A[i]];
    for (let r = 0; r < 3; r++) if (r !== i) { const f = A[r][i] / A[i][i]; for (let c = i; c < 4; c++) A[r][c] -= f * A[i][c]; }
  }
  return [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]];
}
function robustFit2(x1, x2, ys) {
  const n = ys.length;
  let w = Array(n).fill(1), coef = null;
  const wls = () => {
    const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], v = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const r = [1, x1[i], x2[i]];
      for (let j = 0; j < 3; j++) { v[j] += w[i] * r[j] * ys[i]; for (let k = 0; k < 3; k++) M[j][k] += w[i] * r[j] * r[k]; }
    }
    const c = solve3(M, v);
    if (!c) return null;
    coef = c; return M;
  };
  let M = wls();
  if (!M) return null;
  for (let it = 0; it < 6; it++) {
    const res = ys.map((y, i) => y - coef[0] - coef[1] * x1[i] - coef[2] * x2[i]);
    const mres = median(res);
    const mad = median(res.map((r) => Math.abs(r - mres))) || 0;
    const sc = mad > 0 ? mad / 0.6745 : (Math.sqrt(res.reduce((q, r) => q + r * r, 0) / n) || 1);
    w = res.map((r) => { const u = Math.abs(r) / (HUBER_K * sc); return u <= 1 ? 1 : 1 / u; });
    M = wls();
    if (!M) return null;
  }
  let sw = 0, sy = 0, sse = 0, sst = 0;
  for (let i = 0; i < n; i++) { sw += w[i]; sy += w[i] * ys[i]; }
  const my = sy / sw;
  for (let i = 0; i < n; i++) { const r = ys[i] - coef[0] - coef[1] * x1[i] - coef[2] * x2[i]; sse += w[i] * r * r; sst += w[i] * (ys[i] - my) ** 2; }
  const sigma2 = sse / Math.max(1, n - 3);
  const e1 = solve3(M, [0, 1, 0]);
  const varB = e1 ? sigma2 * e1[1] : Infinity;
  const se = varB > 0 ? Math.sqrt(varB) : Infinity;
  return { a: coef[0], b: coef[1], c: coef[2], se, t: Number.isFinite(se) && se > 0 ? coef[1] / se : 0, r2: sst > 0 ? Math.max(0, 1 - sse / sst) : 0, n };
}

// ---------------------------------------------------------------------------
// ЧИСТАЯ функция расчёта (без базы).
//   placements — вышедшие интеграции [{id, source, blogger_handle, reach, followers, platform, kaspi_code, published_date}]
//   resolution — Map исходный код → живой код | null
//   daily      — Map код → Map 'YYYY-MM-DD' → {lines,cancelled,returned,netLines,qty,kzt}
//   weekdayFactor — [7] (0 = вс), среднее ≈ 1
//   listedSince, feedStart, lastCompleteDay ('YYYY-MM-DD' — последний полностью загруженный день)
// ---------------------------------------------------------------------------
const EMPTY = Object.freeze({ lines: 0, cancelled: 0, returned: 0, netLines: 0, qty: 0, kzt: 0 });
function planAttribution({ placements, resolution, daily, weekdayFactor, listedSince, feedStart, lastCompleteDay }) {
  const results = new Map();
  const V = ` [${PARAMS_VERSION}]`;
  const setNo = (id, status, note) => results.set(String(id), { status, units: null, kzt: null, note: note + V });
  const wf = Array.isArray(weekdayFactor) && weekdayFactor.length === 7 ? weekdayFactor.map((x) => (Number(x) > 0 ? Number(x) : 1)) : Array(7).fill(1);
  const rec = (code, d) => (daily.get(code) && daily.get(code).get(d)) || EMPTY;

  // Оценка охвата, если он не заполнен: подписчики × медианное (охват/подписчики), иначе медианный охват.
  const ratios = placements.filter((p) => Number(p.reach) > 0 && Number(p.followers) > 0).map((p) => Number(p.reach) / Number(p.followers));
  const reachRatio = Math.min(3, Math.max(0.05, median(ratios) || 0.3));
  const medianReach = median(placements.map((p) => Number(p.reach)).filter((x) => x > 0)) || 10000;

  // --- 1. Кто участвует ---
  const eligible = [];
  for (const p of placements) {
    const d0 = p.published_date;
    if (!d0) { setNo(p.id, "no_published_date", "Статус «опубликовано», но дата публикации не заполнена."); continue; }
    const raw = splitCodes(p.kaspi_code);
    if (!raw.length) { setNo(p.id, "no_sku_code", "ШК/SKU не указан — рекламируемый товар не определён."); continue; }
    const dead = raw.filter((c) => !resolution.get(c));
    if (dead.length) { setNo(p.id, "no_sku_data", `Код ${dead.join(", ")} не найден в заказах Kaspi (и замены нет ни в каталоге, ни в справочнике product_aliases) — впишите живой код товара.`); continue; }
    if (feedStart && d0 < feedStart) { setNo(p.id, "no_kaspi_data", `Выход ${ddmmD(d0)} раньше начала истории заказов Kaspi (${feedStart}).`); continue; }
    if (!lastCompleteDay || d0 > lastCompleteDay) { setNo(p.id, "window_open", `Выход ${ddmmD(d0)}: день ещё не закончился или заказы за него не загружены — сумма появится завтра.`); continue; }
    const codes = [...new Set(raw.map((c) => resolution.get(c)))].sort();
    const replaced = raw.filter((c) => resolution.get(c) !== c).map((c) => `${c}→${resolution.get(c)}`);
    const format = formatOf(p.platform);
    eligible.push({ ...p, id: String(p.id), d0, codes, replaced, format, handle: normalizeHandle(p.blogger_handle),
      postHour: ASSUMED_POST_HOUR[p.source] != null ? ASSUMED_POST_HOUR[p.source] : 12,
      hl: format.stories ? HALF_LIFE_HOURS_STORIES : HALF_LIFE_HOURS_VIDEO });
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
    const followers = Math.max(0, ...members.map((m) => Number(m.followers) || 0));
    if (reaches.length) { primary.reachUsed = Math.max(...reaches); primary.reachEstimated = null; }
    else if (followers > 0) { primary.reachUsed = Math.round(followers * reachRatio); primary.reachEstimated = `охват не заполнен — оценка по подписчикам: ${fmt(followers)} × ${reachRatio.toFixed(2)} ≈ ${fmt(primary.reachUsed)}`; }
    else { primary.reachUsed = Math.round(medianReach); primary.reachEstimated = `охват и подписчики не заполнены — взят медианный охват выходов ≈ ${fmt(primary.reachUsed)}`; }
    primary.weight = Math.sqrt(primary.reachUsed) * primary.format.coef;
    primary.duplicates = members.slice(1);
    primaries.push(primary);
    for (const dup of members.slice(1)) {
      setNo(dup.id, "duplicate", `Та же интеграция (${dup.blogger_handle}, ${dup.d0}, ${dup.codes.join(", ")}) уже учтена в строке id ${primary.id} — сумма записана там, чтобы не задвоить заказы.`);
    }
  }

  // --- 3. Модель по SKU ---
  const byCode = new Map();
  for (const p of primaries) for (const c of p.codes) { if (!byCode.has(c)) byCode.set(c, []); byCode.get(c).push(p); }
  const perPlacement = new Map();
  const push = (id, x) => { if (!perPlacement.has(id)) perPlacement.set(id, []); perPlacement.get(id).push(x); };

  for (const [code, members] of byCode) {
    const startD = [feedStart, listedSince && listedSince.get(code)].filter(Boolean).sort().pop() || feedStart;
    const days = [];
    for (let d = startD; d && d <= lastCompleteDay; d = addDaysStr(d, 1)) days.push(d);
    // Экспозиция по дням и доли каждого выхода.
    const E = new Map(days.map((d) => [d, 0]));
    const share = new Map(); // id → Map day → w·f
    for (const m of members) {
      const sm = new Map();
      for (let k = 0; k < KERNEL_DAYS; k++) {
        const d = addDaysStr(m.d0, k);
        if (!E.has(d)) continue;
        const v = m.weight * kernelShare(k, m.postHour, m.hl);
        if (v <= 0) continue;
        E.set(d, E.get(d) + v); sm.set(d, v);
      }
      share.set(m.id, sm);
    }
    const prices = days.map((d) => rec(code, d)).filter((r) => r.qty > 0).map((r) => r.kzt / r.qty);
    const medPrice = median(prices);
    // Цена дня (по фактическим продажам; в день без продаж — последняя известная). В модели — как
    // лог-отклонение от обычной цены: при более высокой цене обычных продаж меньше, и фон ниже.
    const dayPrice = new Map();
    { let last = medPrice || 0; for (const d of days) { const r = rec(code, d); if (r.qty > 0) last = r.kzt / r.qty; dayPrice.set(d, last); } }
    const lnP = (d) => (medPrice && dayPrice.get(d) > 0 ? Math.log(dayPrice.get(d) / medPrice) : 0);
    const isDiscount = (d) => { const r = rec(code, d); return medPrice && r.qty > 0 && r.kzt / r.qty < medPrice * (1 - PRICE_DRIFT_TOLERANCE); };
    const fitDays = days;
    const exposedDays = fitDays.filter((d) => E.get(d) > 0).length;
    let fit = null, why = null;
    if (fitDays.length < MIN_FIT_DAYS) why = `по SKU всего ${fitDays.length} дн. истории заказов — модель не из чего построить`;
    else if (exposedDays < MIN_EXPOSED_DAYS) why = `по SKU всего ${exposedDays} дн. с выходами — модель не из чего построить`;
    else {
      const ys = fitDays.map((d) => rec(code, d).qty / wf[dowOf(d)]);
      const xE = fitDays.map((d) => E.get(d)), xP = fitDays.map(lnP);
      const priceVaries = Math.max(...xP) - Math.min(...xP) > 0.03;
      fit = priceVaries ? robustFit2(xE, xP, ys) : null;
      // Цена должна снижать продажи (c ≤ 0); если модель говорит обратное — цену не учитываем.
      if (!fit || !(fit.c <= 0)) { const f1 = robustFit(xE, ys); fit = f1 ? Object.assign(f1, { c: 0 }) : null; }
      if (!fit) why = "выходы этого SKU шли равномерно каждый день — связь продаж с ними не выделить";
    }
    if (why) {
      for (const m of members) push(m.id, { code, status: "baseline_uncertain", reason: why });
      continue;
    }
    const a = Math.max(0, fit.a);
    const baseOf = (d) => Math.max(0, fit.a + fit.c * lnP(d));   // фон дня с учётом цены дня
    const linked = fit.b > 0 && fit.t >= 1;
    const bEff = linked ? fit.b : 0;
    // Потолок по факту — по неделям (пн–вс): сумма вкладов всех блогеров за неделю ≤ продаж сверх фона
    // за эту неделю (фон — при цене каждого дня). По неделе, а не по дню: случайные недобор/перебор
    // заказов в отдельные дни взаимно гасятся и не срезают вклад систематически.
    const weekOf = (d) => addDaysStr(d, -((dowOf(d) + 6) % 7));
    const wk = new Map();
    for (const d of days) {
      const f = wf[dowOf(d)];
      const k = weekOf(d);
      const cur = wk.get(k) || { pred: 0, room: 0 };
      cur.pred += bEff * E.get(d) * f;
      cur.room += rec(code, d).qty - baseOf(d) * f;
      wk.set(k, cur);
    }
    const scale = new Map();
    for (const d of days) { const w = wk.get(weekOf(d)); scale.set(d, w.pred > 0 ? Math.min(1, Math.max(0, w.room) / w.pred) : 0); }
    const priceOf = (d) => { const r = rec(code, d); return r.qty > 0 ? r.kzt / r.qty : (medPrice || 0); };
    // v8.3 (15.10.2026). Вклад выхода за день = БОЛЬШЕЕ из двух оценок:
    //  (а) модель: b × сила выхода (средняя отдача этого товара; срезано до факта недели);
    //  (б) реальный всплеск: заказы дня минус ЛОКАЛЬНЫЙ фон вокруг выхода (медиана продаж за 10 дней до
    //      и 10 дней после, без самих дней выхода, при той же цене ±5%, с поправкой на день недели),
    //      поделённый между блогерами этого дня по доле экспозиции; от дня выхода, пока всплеск не
    //      закончился (с 3-го дня), до 7 дней. Локальный фон уже содержит постоянный поток рекламы этого
    //      товара — поэтому «всплеск» отражает только то, что добавил именно этот выход.
    // Затем по каждому дню: сумма всех блогеров ≤ заказы − фон дня (фон при цене дня из модели).
    // (б) работает только если по истории доказано, что выходы двигают продажи (t ≥ 2).
    const observedOk = linked && fit.t >= 2;
    const localBaseOf = (m) => {
      const p0 = dayPrice.get(m.d0) || medPrice || 0;
      const cand = [];
      for (let k = -10; k <= 14; k++) {
        if (k >= -1 && k <= 4) continue;
        const d = addDaysStr(m.d0, k);
        if (!E.has(d)) continue;
        cand.push({ y: rec(code, d).qty / wf[dowOf(d)], samePrice: p0 > 0 && Math.abs((dayPrice.get(d) || 0) / p0 - 1) <= PRICE_DRIFT_TOLERANCE });
      }
      const same = cand.filter((c) => c.samePrice);
      const use = same.length >= 5 ? same : cand;
      return use.length >= 5 ? median(use.map((c) => c.y)) : null;
    };
    const cand = new Map(); // id → Map day → {u, src}
    for (const m of members) {
      const lb = observedOk ? localBaseOf(m) : null;
      const cm = new Map();
      let stopped = null;
      const mDays = [...share.get(m.id).entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1));
      for (const [d, v] of mDays) {
        const f = wf[dowOf(d)];
        const uModel = bEff * v * f * scale.get(d);
        let uObs = 0;
        if (lb != null && !stopped) {
          const k = daysBetween(m.d0, d);
          const ex = rec(code, d).qty - lb * f;
          if (k >= 2 && ex <= 0) stopped = d;
          else uObs = Math.max(0, ex) * (E.get(d) > 0 ? v / E.get(d) : 0);
        }
        cm.set(d, { u: Math.max(uModel, uObs), src: uObs > uModel ? "obs" : "model" });
      }
      cand.set(m.id, { cm, lb, stopped });
    }
    // Потолок дня по факту: заказы дня минус обычный уровень. Обычный уровень = большее из
    //  (1) фона модели при цене дня и (2) медианы «чистых» дней рядом (±14 дн., без заметных выходов этого
    //  SKU, при той же цене ±5%; нужно ≥5 таких дней). Если продажи давно держатся на одном уровне и
    //  выход его не поднял — делить нечего, как бы ни была велика средняя отдача товара.
    const posE = days.map((d) => E.get(d)).filter((x) => x > 0);
    const cleanThr = posE.length ? 0.1 * median(posE) : 0;
    const cleanDays = days.filter((d) => E.get(d) <= cleanThr && rec(code, d).qty >= 0);
    const nearCleanBase = (d) => {
      const p0 = dayPrice.get(d) || medPrice || 0;
      const near = cleanDays.filter((x) => x !== d && Math.abs(daysBetween(d, x)) <= 14);
      const same = near.filter((x) => p0 > 0 && Math.abs((dayPrice.get(x) || 0) / p0 - 1) <= PRICE_DRIFT_TOLERANCE);
      const use = same.length >= 5 ? same : near;
      return use.length >= 5 ? median(use.map((x) => rec(code, x).qty / wf[dowOf(x)])) : null;
    };
    const dayCap = new Map();
    for (const d of days) {
      let tot = 0;
      for (const m of members) { const c = cand.get(m.id).cm.get(d); if (c) tot += c.u; }
      if (tot <= 0) { dayCap.set(d, 1); continue; }
      const nb = nearCleanBase(d);
      const usual = Math.max(baseOf(d), nb == null ? 0 : nb);
      const room = Math.max(0, rec(code, d).qty - usual * wf[dowOf(d)]);
      dayCap.set(d, tot > room && tot > 0 ? room / tot : 1);
    }
    for (const m of members) {
      let u0 = 0, k0 = 0, uT = 0, kT = 0, lastDay = null, cut = false, obsDays = 0;
      const { cm, lb, stopped } = cand.get(m.id);
      const stoppedAt = stopped;
      for (const [d, c] of [...cm.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
        const sc = dayCap.get(d);
        if (sc < 1 - 1e-9) cut = true;
        const u = c.u * sc;
        if (c.src === "obs" && u > 0) obsDays++;
        const kz = u * priceOf(d);
        if (d === m.d0) { u0 += u; k0 += kz; } else { uT += u; kT += kz; }
        lastDay = d;
      }
      const observed = obsDays > 0;
      let units = u0 + uT, kzt = k0 + kT, capped = false;
      if (!m.reachEstimated && units > m.reachUsed * MAX_PURCHASES_PER_VIEW && units > 0) {
        const k = (m.reachUsed * MAX_PURCHASES_PER_VIEW) / units;
        u0 *= k; uT *= k; k0 *= k; kT *= k; units *= k; kzt *= k; capped = true;
      }
      const conf = !linked ? "L" : (fit.t >= 3 && fit.r2 >= 0.3 && !m.reachEstimated ? "H" : (fit.t >= 2 && !m.reachEstimated ? "M" : "L"));
      const growing = daysBetween(m.d0, lastCompleteDay) < KERNEL_DAYS - 1;
      push(m.id, {
        code, status: kzt >= 1 ? "ok" : "zero", k0: Math.floor(k0), kT: Math.floor(kT), units, conf, linked, fit, a, cut, capped, growing: growing && !stoppedAt,
        observed, localBase: lb, stoppedAt, sharedWith: Math.max(0, (E.get(m.d0) || 0) > 0 ? 1 - (share.get(m.id).get(m.d0) || 0) / E.get(m.d0) : 0),
        E0: E.get(m.d0) || 0, q0: rec(code, m.d0).qty, discount: isDiscount(m.d0),
        base0: baseOf(m.d0), price0: dayPrice.get(m.d0), medPrice, elast: fit.c,
      });
    }
  }

  // --- 4. Итог по интеграции ---
  for (const p of primaries) {
    const parts = perPlacement.get(p.id) || [];
    const replNote = p.replaced.length ? ` Код заменён на живую карточку Kaspi: ${p.replaced.join(", ")}.` : "";
    const good = parts.filter((x) => x.status === "ok" || x.status === "zero");
    const bad = parts.filter((x) => x.status === "baseline_uncertain");
    if (!good.length) {
      setNo(p.id, "baseline_uncertain", `${bad.map((x) => `SKU ${x.code} — ${x.reason}`).join("; ")}. Суммы нет («недостаточно данных»).${replNote}`);
      continue;
    }
    let k0 = 0, kT = 0, units = 0, conf = "H", growing = false;
    for (const q of good) {
      k0 += q.k0; kT += q.kT; units += q.units; growing = growing || q.growing;
      if (CONF_RANK[q.conf] < CONF_RANK[conf]) conf = q.conf;
    }
    if (bad.length || p.reachEstimated) conf = "L";
    const t = k0 + kT;
    const bt = Math.min(...good.map((q) => q.fit.t)), r2 = Math.min(...good.map((q) => q.fit.r2));
    const txt = good.map((q) =>
      `SKU ${q.code}: ${q.observed
        ? `реальный всплеск заказов над обычным уровнем вокруг выхода (${fmtQ(q.localBase)} шт/день при той же цене)${q.stoppedAt ? `, до ${ddmmD(addDaysStr(q.stoppedAt, -1))} (дальше продажи вернулись к обычным)` : ""}` + (q.sharedWith > 0.05 ? `, поделён с другими блогерами этого товара (доля в день выхода ${Math.round((1 - q.sharedWith) * 100)}%)` : "")
        : `средняя отдача товара: ${q.fit.b > 0 ? fmtQ(q.fit.b * 1000) : 0} шт на 1000 ед. охват-силы × сила выхода`} (история ${q.fit.n} дн., связь t=${q.fit.t.toFixed(1)}, R²=${q.fit.r2.toFixed(2)})` +
      (q.linked ? "" : " — продажи не растут вместе с выходами, вклад 0") +
      (q.elast < 0 && q.medPrice
        ? `; фон зависит от цены: при обычной цене ${fmt(q.medPrice)} ₸ — ${fmtQ(q.a)} шт/день, цена +10% → обычных продаж ${fmtQ(Math.max(0, q.a + q.elast * Math.log(1.1)))} шт/день`
        : `; фон ${fmtQ(q.a)} шт/день`) +
      `; в день выхода цена ${fmt(q.price0 || 0)} ₸, фон при этой цене ${fmtQ(q.base0)} шт, заказов ${fmtQ(q.q0)} шт${q.discount ? " (скидка)" : ""}` +
      (q.cut ? "; срезано до реальных продаж сверх фона" : "") + (q.capped ? "; срезано до 1 покупки на 100 просмотров" : "") +
      ` → день выхода ${fmt(q.k0)} ₸ + следующие дни ${fmt(q.kT)} ₸`);
    const head = `Итого ${fmt(t)} ₸ (≈${fmtQ(units)} шт) = день выхода ${fmt(k0)} ₸ + следующие 6 дней ${fmt(kT)} ₸. Уверенность: ${CONF_LABEL[conf]}.` +
      (growing ? ` Ещё копится до ${ddmmD(addDaysStr(p.d0, KERNEL_DAYS - 1))}.` : "");
    const how = ` Вес выхода √охвата × формат: √${fmt(p.reachUsed)} × ${p.format.coef} (${p.format.label})${p.reachEstimated ? ` — ${p.reachEstimated}` : ""}; эффект ролика затухает вдвое за ${p.hl} ч от условного выхода в ${p.postHour}:00.`;
    const badNote = bad.length ? ` Не посчитано: ${bad.map((x) => `SKU ${x.code} — ${x.reason}`).join("; ")}.` : "";
    const dupNote = p.duplicates.length ? ` Та же интеграция есть в строке id ${p.duplicates.map((d) => d.id).join(", ")} — сумма записана только здесь.` : "";
    const tag = makeTag({ t, d0: k0, tl: kT, c: conf, bt: bt.toFixed(1), r2: r2.toFixed(2), re: p.reachEstimated ? 1 : null, g: growing ? 1 : null });
    results.set(p.id, {
      status: t >= 1 ? "ok" : "zero",
      units: Math.round(units * 100) / 100,
      kzt: t,
      breakdown: { dayZeroKzt: k0, tailKzt: kT, confidence: conf },
      note: `${tag} ${head} ${txt.join(" | ")}.${how}${badNote}${replNote}${dupNote} Сумма всех блогеров за неделю не больше продаж сверх фона.${V}`,
    });
  }
  return { results };
}

// ---------------------------------------------------------------------------
// Ввод-вывод
// ---------------------------------------------------------------------------
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
    SELECT s.order_id, bool_or(COALESCE(s.return_recorded, false)) AS returned
    FROM public.kaspi_order_sync_state s WHERE s.order_id IN (SELECT order_id FROM lines) GROUP BY s.order_id
  ),
  rg AS (
    SELECT r.order_id, bool_or(r.status = ANY($EXCL::text[])) AS cancelled
    FROM public.kaspi_orders_register r WHERE r.order_id IN (SELECT order_id FROM lines) GROUP BY r.order_id
  ),
  f AS (
    SELECT l.*, (l.order_status = ANY($EXCL::text[]) OR COALESCE(rg.cancelled, false)) AS is_cancelled,
           COALESCE(st.returned, false) AS is_returned
    FROM lines l LEFT JOIN st ON st.order_id = l.order_id LEFT JOIN rg ON rg.order_id = l.order_id
  )`;

// Какие строки считаем вышедшими: опубликовано, ИЛИ есть дата выхода и (оплачено или ссылка на ролик).
// Отменённые (status = 'cancelled') не считаются никогда.
const PUBLISHED_SQL = `(status IS DISTINCT FROM 'cancelled' AND (status = 'published' OR (published_date IS NOT NULL AND (status = 'paid' OR NULLIF(btrim(video_url), '') IS NOT NULL))))`;

async function runDailyAttribution(pgPool, { log = console.log } = {}) {
  const nowHour = almatyNowHour();
  const today = nowHour.slice(0, 10);

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
  // Последний полный день: при живом синке — вчера; иначе день перед последней загруженной датой.
  let lastCompleteDay = addDaysStr(today, -1);
  if (!(syncFresh && dataLoadedThrough && dataLoadedThrough >= today) && dataLoadedThrough) {
    const d = addDaysStr(dataLoadedThrough, -1);
    if (d < lastCompleteDay) lastCompleteDay = d;
  }
  const { rows: fsr } = await pgPool.query(`SELECT min(order_date)::text AS d FROM analytics.kaspi_live_order_entries`);
  const feedStart = fsr[0] ? fsr[0].d : null;

  const { rows: placements } = await pgPool.query(
    `SELECT id::text AS id, source, blogger_handle, reach, followers, platform, kaspi_code, sku_name,
            published_date::date::text AS published_date
     FROM public.influencer_placements WHERE ${PUBLISHED_SQL}`
  );
  log(`[attribution ${PARAMS_VERSION}] ${nowHour}: вышедших ${placements.length}, история Kaspi ${feedStart}…${dataLoadedThrough}, полный день по ${lastCompleteDay} (синк ${syncFresh ? "живой" : "давно не обновлялся"}), обнулено прочих: ${reset.rowCount}`);
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

  // 2. Коэффициенты дня недели — по выручке всего магазина за 90 дней (без отмен и возвратов).
  const weekdayFactor = Array(7).fill(1);
  {
    const sql = `WITH ${LINES_CTE.replace("%WHERE%", () => "e.order_date >= ($1::date - 90) AND e.order_date < $1::date").replace(/\$EXCL/g, () => "$2")}
      SELECT order_date::text AS d, COALESCE(sum(total_price), 0)::float8 AS kzt
      FROM f WHERE NOT is_cancelled AND NOT is_returned GROUP BY 1`;
    const { rows } = await pgPool.query(sql, [today, EXCLUDED_ORDER_STATUSES]);
    const byDow = Array.from({ length: 7 }, () => []);
    for (const r of rows) if (!feedStart || r.d >= feedStart) byDow[dowOf(r.d)].push(Number(r.kzt));
    const meds = byDow.map((a) => (a.length >= 2 ? median(a) : null));
    const known = meds.filter((x) => x > 0);
    if (known.length === 7) {
      const avg = known.reduce((a, b) => a + b, 0) / 7;
      meds.forEach((m, i) => { weekdayFactor[i] = Math.min(1.5, Math.max(0.6, m / avg)); });
    }
  }

  // 3. Заказы по (SKU, день) — вся история SKU (нужна модели).
  const liveCodes = [...new Set([...resolution.values()].filter(Boolean))];
  const daily = new Map();
  let noEntryIdLines = 0;
  if (liveCodes.length && feedStart) {
    const sql = `WITH ${LINES_CTE.replace("%WHERE%", () => "e.offer_code = ANY($1::text[]) AND e.order_date >= $2::date").replace(/\$EXCL/g, () => "$3")}
      SELECT offer_code, order_date::text AS d,
             count(*)::int AS lines,
             count(*) FILTER (WHERE no_entry_id)::int AS no_entry_id,
             count(*) FILTER (WHERE is_cancelled)::int AS cancelled,
             count(*) FILTER (WHERE NOT is_cancelled AND is_returned)::int AS returned,
             count(*) FILTER (WHERE NOT is_cancelled AND NOT is_returned)::int AS net_lines,
             COALESCE(sum(quantity) FILTER (WHERE NOT is_cancelled AND NOT is_returned), 0)::float8 AS qty,
             COALESCE(sum(total_price) FILTER (WHERE NOT is_cancelled AND NOT is_returned), 0)::float8 AS kzt
      FROM f GROUP BY offer_code, order_date`;
    const { rows } = await pgPool.query(sql, [liveCodes, feedStart, EXCLUDED_ORDER_STATUSES]);
    for (const r of rows) {
      noEntryIdLines += r.no_entry_id;
      if (!daily.has(r.offer_code)) daily.set(r.offer_code, new Map());
      daily.get(r.offer_code).set(r.d, { lines: r.lines, cancelled: r.cancelled, returned: r.returned, netLines: r.net_lines, qty: Number(r.qty), kzt: Number(r.kzt) });
    }
  }

  // 4. Расчёт и запись.
  const plan = planAttribution({ placements, resolution, daily, weekdayFactor, listedSince, feedStart, lastCompleteDay });
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
  log(`[attribution] готово: ${ids.length} строк; строк без entry_id ${noEntryIdLines}; по статусам ${JSON.stringify(byStatus)}; уверенность ${JSON.stringify(byConf)}; дни недели ${weekdayFactor.map((x) => x.toFixed(2)).join("/")}`);
  return { processed: ids.length, byStatus, byConfidence: byConf, noEntryIdLines };
}

module.exports = {
  CATALOG_CODE_MAP, runDailyAttribution, planAttribution, almatyTodayStr, addDaysStr, splitCodes, normalizeHandle,
  formatOf, parseTag, makeTag, kernelShare, robustFit, PARAMS_VERSION, NO_NUMBER_STATUSES, ASSUMED_POST_HOUR,
};
