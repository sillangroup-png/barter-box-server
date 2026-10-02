// ============================================================================
// attribution.js — расчёт «вклада в продажи» (колонка «Авто (Kaspi)») для интеграций
// блогеров по заказам Kaspi. Результат пишется в public.influencer_placements
// (auto_contribution_units/kzt/status/note/computed_at). Это же число во фронтенде —
// «Вклад в продажи» / ROMI / ROAS для интеграций с сентября 2026 (kaspiContributionOf()).
//
// v6 (02.10.2026) — ОКНО 24 ЧАСА ОТ УСЛОВНОГО ВРЕМЕНИ ВЫХОДА (решение Нины).
// Точного времени публикаций нет, принято рабочее допущение:
//   — крупные (barter_box_deals) выкладывают в 12:00 → окно 12:00 D0 … 12:00 D+1;
//   — микро/средние (barter_box_micro) — в 16:00     → окно 16:00 D0 … 16:00 D+1.
// Время заказа берётся из kaspi_order_sync_state.creation_at (Asia/Almaty). Это допущение,
// а не известное время выхода конкретного ролика.
//
// ПРАВИЛО
//  1. Источник — analytics.kaspi_live_order_entries, конкретный SKU из поля ШК (не категория,
//     не магазин). Несколько кодов через запятую = несколько товаров, вклад = сумма по ним.
//     Строки заказа — уникальные (DISTINCT по entry_id), без CANCELLED/CANCELLING, без заказов
//     с зафиксированным возвратом. Агрегируем по (SKU, час) ДО соединения с интеграциями.
//     Заказ без времени (creation_at пуст) раскладывается по часам своего дня по типичному
//     суточному профилю магазина — не теряется и не попадает целиком в один час.
//  2. Фон по часам: уровень продаж SKU (₸ в сутки) оценивается по «чистым» часам — тем, что
//     не входят ни в одно окно публикаций этого SKU (ни крупных, ни микро) — ближайшим к дате,
//     в пределах ±14 дней, после начала истории Kaspi. Уровень × доля этого часа в суточном
//     профиле магазина = фон часа. Фон надёжен, если чистых часов набирается хотя бы на 5
//     «эквивалентных суток» и цена в окне отличается от цены чистых часов ≤ 1,5%.
//  3. Прирост часа e = заказы часа − фон часа (со знаком). Каждый час делится между всеми
//     публикациями SKU, чьё окно накрывает этот час (крупные и микро вместе), по весам:
//     вес = √охвата × формат (Stories ×2, Reels/видео ×1, не указан ×1). Вклад интеграции =
//     сумма её долей по 24 часам окна; отрицательный итог → 0. Плюсы и минусы внутри окна
//     взаимно гасятся, поэтому случайные всплески не накапливаются.
//  4. Жёсткие ограничения: сумма вкладов всех блогеров SKU ≤ сумма положительных приростов
//     часов ≤ реальные заказы в этих часах; по связной группе пересекающихся окон сумма
//     вкладов ≤ max(0, суммарный прирост группы) — иначе пропорционально уменьшается (это
//     потолок по факту, а не прогноз). Нарушение проверяется в коде → compute_error.
//  5. «Недостаточно данных» (числа нет, во фронтенде «—»): фон не обоснован; у кого-то из
//     делящих часы нет охвата; больше 1 покупки на 100 просмотров блогера (рост окна его
//     публикацией не объяснить). Окно ещё не закончилось / данные Kaspi не догружены /
//     окно раньше начала истории Kaspi — тоже «—».
//  6. Ручной вклад менеджера (manualContribution) живёт в barter-box и главнее; сервер его
//     не видит и всегда делит часы по всем участникам — доля такого блогера остаётся
//     нераспределённой. Отметка «нет всплеска» на расчёт не влияет.
//  7. Одна интеграция в обеих таблицах (тот же логин, дата, коды) учитывается один раз:
//     число в строке крупных (окно от 12:00), вторая — duplicate.
//  8. Каждый прогон пересчитывает все опубликованные строки; неопубликованные обнуляются.
// ============================================================================

const PARAMS_VERSION = "attrib-v6-24h-12h16h-2026-10-02";

// Условное время выхода (час по Алматы) и длина окна.
const ASSUMED_POST_HOUR = { barter_box_deals: 12, barter_box_micro: 16 };
const WINDOW_HOURS = 24;

const BASELINE_SEARCH_RADIUS_DAYS = 14;
const BASELINE_TARGET_DAYS = 7;   // набираем чистых часов на ~7 суток
const BASELINE_MIN_DAYS = 5;      // меньше 5 «эквивалентных суток» — фон не обоснован
const PRICE_DRIFT_TOLERANCE = 0.015;
const MAX_PURCHASES_PER_VIEW = 0.01;

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

const NO_NUMBER_STATUSES = new Set([
  "no_published_date", "no_sku_code", "no_sku_data", "no_kaspi_data",
  "window_open", "kaspi_data_pending", "needs_reach_data", "baseline_uncertain",
  "duplicate", "compute_error",
]);

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
function fmt(n) { return Math.round(n).toLocaleString("ru-RU").replace(/ /g, " "); }
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

// ---------------------------------------------------------------------------
// ЧИСТАЯ функция расчёта (без базы).
//   placements — опубликованные интеграции [{id, source, blogger_handle, reach, platform, kaspi_code, published_date}]
//   resolution — Map исходный код → живой код | null
//   hourly     — Map код → Map 'YYYY-MM-DDTHH' → {lines,cancelled,returned,netLines,qty,kzt}
//   undated    — Map код → Map 'YYYY-MM-DD'    → то же (заказы без времени)
//   profile    — массив 24 долей выручки магазина по часам суток (сумма 1)
//   listedSince, feedStart, dataLoadedThrough, nowHour ('YYYY-MM-DDTHH')
// ---------------------------------------------------------------------------
function planAttribution({ placements, resolution, hourly, undated, profile, listedSince, feedStart, dataLoadedThrough, nowHour }) {
  const results = new Map();
  const V = ` [${PARAMS_VERSION}]`;
  const setNo = (id, status, note) => results.set(String(id), { status, units: null, kzt: null, note: note + V });
  const prof = Array.isArray(profile) && profile.length === 24 && profile.some((x) => x > 0)
    ? profile.map((x) => x / profile.reduce((a, b) => a + b, 0))
    : Array(24).fill(1 / 24);

  // Последний час, за который данные точно полные: не позже текущего часа и не позже конца
  // дня, предшествующего последней загруженной дате (её саму считаем ещё догружаемой).
  const lastCompleteExcl = (() => {
    const a = nowHour;
    const b = dataLoadedThrough ? hourKey(dataLoadedThrough, 0) : null;
    return b && b < a ? b : a;
  })();

  // Ряд заказов часа: заказы с временем + заказы дня без времени × профиль.
  const seriesCache = new Map();
  function hourRec(code, hk) {
    const key = code + "|" + hk;
    if (seriesCache.has(key)) return seriesCache.get(key);
    const h = (hourly.get(code) && hourly.get(code).get(hk)) || EMPTY;
    const u = undated && undated.get(code) && undated.get(code).get(dateOf(hk));
    let rec = h;
    if (u) {
      const f = prof[hourOfDay(hk)];
      rec = { lines: h.lines + u.lines * f, cancelled: h.cancelled + u.cancelled * f, returned: h.returned + u.returned * f,
        netLines: h.netLines + u.netLines * f, qty: h.qty + u.qty * f, kzt: h.kzt + u.kzt * f };
    }
    seriesCache.set(key, rec);
    return rec;
  }

  // Часы, занятые ЛЮБОЙ опубликованной интеграцией с этим кодом (для фона).
  const busyByCode = new Map();
  for (const p of placements) {
    if (!p.published_date) continue;
    const w = windowOf(p.source, p.published_date);
    for (const raw of splitCodes(p.kaspi_code)) {
      for (const c of [raw, resolution.get(raw)]) {
        if (!c) continue;
        if (!busyByCode.has(c)) busyByCode.set(c, new Set());
        const set = busyByCode.get(c);
        w.hours.forEach((h) => set.add(h));
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
    if (nowHour < w.end) { setNo(p.id, "window_open", `Окно 24 ч (${ddmm(w.start)}–${ddmm(w.end)}) ещё не закончилось — посчитается после.`); continue; }
    if (lastCompleteExcl < w.end) { setNo(p.id, "kaspi_data_pending", `Заказы Kaspi загружены только по ${dataLoadedThrough || "?"} — окно ${ddmm(w.start)}–${ddmm(w.end)} ещё не догружено.`); continue; }
    const codes = [...new Set(raw.map((c) => resolution.get(c)))].sort();
    const replaced = raw.filter((c) => resolution.get(c) !== c).map((c) => `${c}→${resolution.get(c)}`);
    eligible.push({ ...p, id: String(p.id), d0, codes, replaced, win: w, handle: normalizeHandle(p.blogger_handle), format: formatOf(p.platform) });
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

  // --- 3. Фон: уровень продаж SKU (₸/сутки) на дату — по ближайшим чистым часам ---
  const levelCache = new Map();
  function levelFor(code, date) {
    const key = code + "|" + date;
    if (levelCache.has(key)) return levelCache.get(key);
    const busy = busyByCode.get(code) || new Set();
    const listed = (listedSince && listedSince.get(code)) || feedStart || date;
    const loDate = feedStart && feedStart > listed ? feedStart : listed;
    const lo = hourKey(loDate, 0);
    const center = hourKey(date, 12);
    let cov = 0, kzt = 0, qty = 0, hoursUsed = 0;
    const days = new Set();
    for (let k = 1; k <= BASELINE_SEARCH_RADIUS_DAYS * 24 && cov < BASELINE_TARGET_DAYS; k++) {
      for (const hk of [addHours(center, -k), addHours(center, k)]) {
        if (hk < lo || hk >= lastCompleteExcl || busy.has(hk)) continue;
        const r = hourRec(code, hk);
        cov += prof[hourOfDay(hk)];
        kzt += r.kzt; qty += r.qty; hoursUsed++; days.add(dateOf(hk));
      }
    }
    const res = { level: cov > 0 ? kzt / cov : null, coverageDays: cov, price: qty > 0 ? kzt / qty : null, hoursUsed, days: [...days].sort() };
    levelCache.set(key, res);
    return res;
  }
  const baseOfHour = (code, hk) => {
    const L = levelFor(code, dateOf(hk));
    return L.level == null ? 0 : L.level * prof[hourOfDay(hk)];
  };

  // --- 4. Распределение по часам ---
  const byCode = new Map();
  for (const p of primaries) for (const c of p.codes) {
    if (!byCode.has(c)) byCode.set(c, []);
    byCode.get(c).push(p);
  }
  const perPlacement = new Map();
  const push = (id, x) => { if (!perPlacement.has(id)) perPlacement.set(id, []); perPlacement.get(id).push(x); };

  for (const [code, members] of byCode) {
    const active = new Map();
    for (const m of members) for (const hk of m.win.hours) {
      if (!active.has(hk)) active.set(hk, []);
      active.get(hk).push(m);
    }
    const info = new Map();
    for (const m of members) {
      const dates = [...new Set(m.win.hours.map(dateOf))];
      const levels = dates.map((d) => levelFor(code, d));
      let A = 0, Aq = 0, B = 0, lines = 0, canc = 0, ret = 0;
      for (const hk of m.win.hours) {
        const r = hourRec(code, hk);
        A += r.kzt; Aq += r.qty; lines += r.netLines; canc += r.cancelled; ret += r.returned;
        B += baseOfHour(code, hk);
      }
      const winPrice = Aq > 0 ? A / Aq : null;
      let bad = null;
      const weak = levels.find((L) => L.coverageDays < BASELINE_MIN_DAYS);
      if (weak) bad = `фон не обоснован: чистых часов без рекламы этого SKU рядом — на ${weak.coverageDays.toFixed(1)} сут. из ${BASELINE_MIN_DAYS} нужных (история Kaspi с ${feedStart})`;
      const basePrice = levels.map((L) => L.price).filter((x) => x);
      if (!bad && winPrice && basePrice.length) {
        const bp = basePrice.reduce((a, b) => a + b, 0) / basePrice.length;
        const drift = (winPrice - bp) / bp;
        if (Math.abs(drift) > PRICE_DRIFT_TOLERANCE) bad = `фон не обоснован: цена в окне ${fmt(winPrice)} ₸ против ${fmt(bp)} ₸ в чистые часы (${(drift * 100).toFixed(1)}%, порог ${PRICE_DRIFT_TOLERANCE * 100}%) — рост может быть от цены`;
      }
      info.set(m.id, { A, Aq, B, lines, canc, ret, winPrice, bad });
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
      const credit = new Map(cl.map((m) => [m.id, 0]));
      const others = new Map(cl.map((m) => [m.id, new Set()]));
      // Ненадёжность и «нет охвата» — только у тех, с кем реально делятся часы.
      const sharesWith = new Map(cl.map((m) => [m.id, new Set()]));
      let posSum = 0, netSum = 0, actualSum = 0;
      for (const hk of hours) {
        const act = active.get(hk).filter((m) => inCl.has(m.id));
        const r = hourRec(code, hk);
        const e = r.kzt - baseOfHour(code, hk);
        actualSum += r.kzt; netSum += e; posSum += Math.max(0, e);
        const W = act.reduce((a, m) => a + m.weight, 0);
        for (const m of act) {
          const share = act.length === 1 ? 1 : (W > 0 ? m.weight / W : 0);
          credit.set(m.id, credit.get(m.id) + e * share);
          act.forEach((o) => { if (o.id !== m.id) { others.get(m.id).add(o.handle || o.blogger_handle); sharesWith.get(m.id).add(o); } });
        }
      }
      for (const m of cl) credit.set(m.id, Math.max(0, credit.get(m.id)));
      let total = [...credit.values()].reduce((a, b) => a + b, 0);
      let scaled = null;
      const cap = Math.max(0, netSum);
      if (total > cap + 0.5 && total > 0) { scaled = cap / total; for (const m of cl) credit.set(m.id, credit.get(m.id) * scaled); total = cap; }
      const floorTotal = [...credit.values()].reduce((a, b) => a + Math.floor(b), 0);
      const invariantBroken = floorTotal > posSum + 0.5 || floorTotal > actualSum + 0.5;

      for (const m of cl) {
        const inf = info.get(m.id);
        const c = Math.floor(credit.get(m.id));
        const units = inf.winPrice ? Math.floor((c / inf.winPrice) * 100) / 100 : 0;
        const partners = [...sharesWith.get(m.id)];
        const badPartner = partners.find((o) => info.get(o.id).bad);
        const noReach = [m, ...partners].filter((x) => !(x.reachUsed > 0));
        let status = c > 0 ? "ok" : "zero", reason = null;
        if (invariantBroken) { status = "compute_error"; reason = `нарушен потолок: вклады ${fmt(floorTotal)} > прирост ${fmt(posSum)} или заказы ${fmt(actualSum)}`; }
        else if (inf.bad) { status = "baseline_uncertain"; reason = inf.bad; }
        else if (badPartner) { status = "baseline_uncertain"; reason = `часы окна делятся с ${badPartner.handle || badPartner.blogger_handle}, у которого ${info.get(badPartner.id).bad}`; }
        else if (noReach.length && (c > 0 || partners.length)) { status = "needs_reach_data"; reason = `у ${noReach.map((x) => x.handle || x.blogger_handle).slice(0, 4).join(", ")} не заполнен охват — долю не обосновать (заполните охват)`; }
        else if (c > 0 && units > m.reachUsed * MAX_PURCHASES_PER_VIEW) { status = "baseline_uncertain"; reason = `прирост ≈${Math.round(units)} шт несоразмерен охвату ${fmt(m.reachUsed)} (больше 1 покупки на 100 просмотров) — рост окна этой публикацией не объяснить`; }
        push(m.id, { code, status, reason, credit: c, units, inf, others: [...others.get(m.id)], scaled });
      }
    }
  }

  // --- 5. Итог по интеграции ---
  const RANK = { compute_error: 5, needs_reach_data: 4, baseline_uncertain: 3 };
  for (const p of primaries) {
    const parts = perPlacement.get(p.id) || [];
    const replNote = p.replaced.length ? ` Код заменён на живую карточку Kaspi: ${p.replaced.join(", ")}.` : "";
    const timeNote = `Окно 24 ч: ${ddmm(p.win.start)} – ${ddmm(p.win.end)} (допущение: ${p.source === "barter_box_deals" ? "крупные выходят в 12:00" : "микро выходят в 16:00"}).`;
    const bad = parts.filter((x) => RANK[x.status]).sort((a, b) => RANK[b.status] - RANK[a.status]);
    if (bad.length) {
      setNo(p.id, bad[0].status, `${timeNote} ${bad.map((x) => `SKU ${x.code} — ${x.reason}`).join("; ")}. Суммы нет («недостаточно данных»).${replNote}`);
      continue;
    }
    let kzt = 0, units = 0;
    const txt = parts.map((x) => {
      kzt += x.credit; units += x.units;
      const i = x.inf;
      return `SKU ${x.code}: заказы в окне ${Math.round(i.lines)} строк / ${fmt(i.A)} ₸ (исключено: отмены ${Math.round(i.canc)}, возвраты ${Math.round(i.ret)}); фон окна ${fmt(i.B)} ₸; ` +
        (x.others.length
          ? `часы делились по правилу √охвата × формат (у этой интеграции √${fmt(p.reachUsed)} × ${p.format.coef}, ${p.format.label}) с: ${x.others.slice(0, 4).join(", ")}${x.others.length > 4 ? ` и ещё ${x.others.length - 4}` : ""}`
          : "в окне других публикаций этого SKU не было") +
        (x.scaled != null ? `; уменьшено до чистого прироста группы пересекающихся окон (×${x.scaled.toFixed(2)})` : "") +
        ` → ${fmt(x.credit)} ₸`;
    });
    const dupNote = p.duplicates.length ? ` Та же интеграция есть в строке id ${p.duplicates.map((d) => d.id).join(", ")} — сумма записана только здесь.` : "";
    results.set(p.id, {
      status: kzt > 0 ? "ok" : "zero",
      units: Math.round(units * 100) / 100,
      kzt,
      note: `${timeNote} ${txt.join(" | ")}.${replNote}${dupNote} Условное распределение по времени выхода, охвату и формату — не установленное число покупок блогера.${V}`,
    });
  }
  return { results };
}

// ---------------------------------------------------------------------------
// Ввод-вывод
// ---------------------------------------------------------------------------
async function runDailyAttribution(pgPool, { log = console.log } = {}) {
  const nowHour = almatyNowHour();

  const reset = await pgPool.query(
    `UPDATE public.influencer_placements
     SET auto_contribution_units = NULL, auto_contribution_kzt = NULL,
         auto_contribution_status = NULL, auto_contribution_note = NULL,
         auto_contribution_computed_at = now()
     WHERE status IS DISTINCT FROM 'published'
       AND (auto_contribution_status IS NOT NULL OR auto_contribution_kzt IS NOT NULL OR auto_contribution_units IS NOT NULL)`
  );
  const { rows: health } = await pgPool.query(`SELECT last_order_date::text AS d FROM analytics.kaspi_sync_health LIMIT 1`);
  const dataLoadedThrough = health[0] ? health[0].d : null;
  const { rows: fsr } = await pgPool.query(`SELECT min(order_date)::text AS d FROM analytics.kaspi_live_order_entries`);
  const feedStart = fsr[0] ? fsr[0].d : null;

  const { rows: placements } = await pgPool.query(
    `SELECT id::text AS id, source, blogger_handle, reach, platform, kaspi_code, sku_name,
            published_date::date::text AS published_date
     FROM public.influencer_placements WHERE status = 'published'`
  );
  log(`[attribution ${PARAMS_VERSION}] ${nowHour}: опубликованных ${placements.length}, история Kaspi ${feedStart}…${dataLoadedThrough}, обнулено неопубликованных: ${reset.rowCount}`);
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

  // 2. Суточный профиль магазина (доля выручки по часам) — для фона и для заказов без времени.
  const profile = Array(24).fill(0);
  {
    const { rows } = await pgPool.query(
      `SELECT extract(hour FROM s.c AT TIME ZONE 'Asia/Almaty')::int AS h, sum(e.total_price)::float8 AS kzt
       FROM analytics.kaspi_live_order_entries e
       JOIN (SELECT order_id, min(creation_at) AS c FROM public.kaspi_order_sync_state GROUP BY order_id) s ON s.order_id = e.order_id
       WHERE s.c IS NOT NULL AND e.order_status <> ALL($1::text[])
       GROUP BY 1`, [EXCLUDED_ORDER_STATUSES]);
    rows.forEach((r) => { if (r.h >= 0 && r.h < 24) profile[r.h] = Number(r.kzt) || 0; });
  }

  // 3. Заказы по (SKU, час) — агрегируем ДО соединения с интеграциями.
  const liveCodes = [...new Set([...resolution.values()].filter(Boolean))];
  const d0s = placements.map((p) => p.published_date).filter(Boolean).sort();
  const hourly = new Map(), undated = new Map();
  let undatedLines = 0;
  if (liveCodes.length && d0s.length && feedStart) {
    const from = d0s[0] < feedStart ? feedStart : addDaysStr(d0s[0], -BASELINE_SEARCH_RADIUS_DAYS - 1);
    const to = addDaysStr(d0s[d0s.length - 1], BASELINE_SEARCH_RADIUS_DAYS + 2);
    const { rows } = await pgPool.query(
      `WITH lines AS (
         SELECT DISTINCT ON (COALESCE(e.entry_id, e.order_id || '|' || e.offer_code))
                e.order_id, e.offer_code, e.order_date, e.order_status, e.quantity, e.total_price
         FROM analytics.kaspi_live_order_entries e
         WHERE e.offer_code = ANY($1::text[]) AND e.order_date BETWEEN $2::date AND $3::date
         ORDER BY COALESCE(e.entry_id, e.order_id || '|' || e.offer_code), e.last_seen_at DESC NULLS LAST
       ),
       st AS (
         SELECT s.order_id, bool_or(COALESCE(s.return_recorded, false)) AS returned, min(s.creation_at) AS created
         FROM public.kaspi_order_sync_state s WHERE s.order_id IN (SELECT order_id FROM lines) GROUP BY s.order_id
       ),
       f AS (
         SELECT l.*, (l.order_status = ANY($4::text[])) AS is_cancelled, COALESCE(st.returned, false) AS is_returned,
                to_char(st.created AT TIME ZONE 'Asia/Almaty', 'YYYY-MM-DD"T"HH24') AS hk
         FROM lines l LEFT JOIN st ON st.order_id = l.order_id
       )
       SELECT offer_code, hk, order_date::text AS d,
              count(*)::int AS lines,
              count(*) FILTER (WHERE is_cancelled)::int AS cancelled,
              count(*) FILTER (WHERE NOT is_cancelled AND is_returned)::int AS returned,
              count(*) FILTER (WHERE NOT is_cancelled AND NOT is_returned)::int AS net_lines,
              COALESCE(sum(quantity) FILTER (WHERE NOT is_cancelled AND NOT is_returned), 0)::float8 AS qty,
              COALESCE(sum(total_price) FILTER (WHERE NOT is_cancelled AND NOT is_returned), 0)::float8 AS kzt
       FROM f GROUP BY offer_code, hk, order_date`,
      [liveCodes, from, to, EXCLUDED_ORDER_STATUSES]);
    const add = (map, code, key, r) => {
      if (!map.has(code)) map.set(code, new Map());
      const m = map.get(code);
      const cur = m.get(key) || { lines: 0, cancelled: 0, returned: 0, netLines: 0, qty: 0, kzt: 0 };
      m.set(key, { lines: cur.lines + r.lines, cancelled: cur.cancelled + r.cancelled, returned: cur.returned + r.returned,
        netLines: cur.netLines + r.net_lines, qty: cur.qty + Number(r.qty), kzt: cur.kzt + Number(r.kzt) });
    };
    for (const r of rows) {
      if (r.hk) add(hourly, r.offer_code, r.hk, r);
      else { add(undated, r.offer_code, r.d, r); undatedLines += r.lines; }
    }
  }

  // 4. Расчёт и запись.
  const plan = planAttribution({ placements, resolution, hourly, undated, profile, listedSince, feedStart, dataLoadedThrough, nowHour });
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
  const byStatus = {};
  statuses.forEach((s) => (byStatus[s] = (byStatus[s] || 0) + 1));
  log(`[attribution] готово: ${ids.length} строк, без времени заказа ${undatedLines} строк (разложены по профилю), по статусам ${JSON.stringify(byStatus)}`);
  return { processed: ids.length, byStatus, undatedLines };
}

module.exports = {
  CATALOG_CODE_MAP, runDailyAttribution, planAttribution, almatyTodayStr, addDaysStr, splitCodes, normalizeHandle,
  windowOf, formatOf, PARAMS_VERSION, NO_NUMBER_STATUSES, ASSUMED_POST_HOUR,
};
