// ============================================================================
// attribution.js — автоматический расчёт "вклада в продажи" (колонка «Авто (Kaspi)»)
// для интеграций блогеров по заказам Kaspi. Результат пишется в существующие
// колонки public.influencer_placements (auto_contribution_units/kzt/status/note/
// computed_at). С версии v5 это же число — единственный источник «Вклада в
// продажи» / ROMI / ROAS во фронтенде для интеграций с сентября 2026 (см.
// kaspiContributionOf() в index.html).
//
// v5 (2026-09-30) — ДЕНЬ В ДЕНЬ (D0). Полностью заменяет v4/v4.1 (окно D0–D2).
//
// ПРАВИЛО
//  1. D0 — календарная дата фактической публикации (не «24 часа после выхода»).
//     Учитываются ТОЛЬКО заказы с order_date = D0. Заказы следующих дней не
//     учитываются никак. Коэффициентов давности больше нет.
//  2. Источник — analytics.kaspi_live_order_entries, КОНКРЕТНЫЙ рекламируемый SKU
//     (код из поля ШК/SKU интеграции). Не категория, не магазин, не «семья» товаров
//     (объединение набор+шампунь+бальзам из v3–v4 убрано). Если в поле вписано
//     несколько кодов (реклама двух товаров) — каждый код считается отдельным
//     товаром со своим потолком, вклад интеграции = сумма её долей по этим товарам.
//  3. Заказы агрегируются ДО соединения с интеграциями: сначала одна строка на
//     (SKU, дата) — уникальные строки заказа (DISTINCT по entry_id), без
//     CANCELLED/CANCELLING и без заказов с зафиксированным возвратом
//     (kaspi_order_sync_state.return_recorded, свёрнут bool_or по order_id, чтобы
//     не размножать строки). Только потом распределение между интеграциями —
//     поэтому несколько интеграций не могут размножить исходную сумму.
//  4. Фон дня = медиана выручки SKU за «чистые» дни (в эти даты ни одна
//     опубликованная интеграция с этим SKU не выходила — ни крупная, ни микро).
//     Берутся ближайшие к D0 полностью загруженные дни в пределах ±14 дней
//     (до 7 дней), не раньше начала истории Kaspi и не раньше первой продажи SKU.
//     Фон надёжен, только если таких дней ≥ 5 И цена за единицу в D0 отличается
//     от медианной цены фона не больше чем на 1,5% (analytics_rules analysis-01).
//  5. Распределяемая сумма P = min(A, max(0, A − фон)), где A — факт. заказы SKU
//     за D0. Фон ненадёжен → «недостаточно данных», числа НЕТ (kzt = NULL).
//     Всё A единственному блогеру не отдаётся никогда: без надёжного фона — «—».
//  6. P делится между ВСЕМИ интеграциями этого SKU с этой D0 — крупными и
//     микро/средними вместе — пропорционально охвату. Охват задаёт долю, но не
//     создаёт продаж: сумма долей ≤ P ≤ A (проверяется в коде, доли округляются
//     вниз до тенге). Если у кого-то из участников нет охвата — обосновать
//     деление нечем → «недостаточно данных» для всех участников дня. Если на
//     охват всех участников приходится больше 1 покупки на 100 просмотров —
//     прирост дня эти публикации не объясняют (хвост вчерашней крупной рекламы,
//     акция) → тоже «недостаточно данных» (число не урезается, а не выдаётся).
//  7. Одна и та же интеграция, вписанная и в крупные, и в микро (тот же блогер,
//     та же D0, те же коды), участвует ОДИН раз; число пишется в одну строку
//     (приоритет — крупные), вторая получает статус duplicate без суммы — иначе
//     сумма по обеим таблицам превысила бы факт заказов.
//  8. Каждый прогон пересчитывает ВСЕ опубликованные интеграции целиком (а не
//     только «свежие»), и обнуляет auto_* у неопубликованных — старые результаты
//     многодневного расчёта v4 не остаются ни в одной строке.
//  9. Нет данных (D0 раньше начала истории Kaspi, день ещё не закончился, синк
//     не догнал, код не найден) → kzt = NULL, во фронтенде «—». Ни план, ни
//     прогноз по охвату, ни старая автосумма вместо факта не подставляются.
//
// ОГРАНИЧЕНИЯ (честно):
//  - время публикации неизвестно (только дата) — часть заказов D0 могла быть
//    оформлена до выхода ролика; D0 = календарный день целиком, как и требуется;
//  - частичный возврат одной позиции внутри заказа не выделить (в источнике
//    только флаг на весь заказ) — такие заказы исключаются целиком;
//  - события по товару (акции Kaspi, смена цены) живут только в barter-box, в
//    базе их нет: смену цены ловит сверка цены D0 с ценой фона (п.4), акцию без
//    смены цены — нет.
// ============================================================================

const PARAMS_VERSION = "attrib-v5-D0-2026-09-30";

const BASELINE_SEARCH_RADIUS_DAYS = 14; // ищем чистые дни в пределах ±14 дней от D0
const BASELINE_MAX_DAYS = 7;            // берём до 7 ближайших чистых дней
const BASELINE_MIN_DAYS = 5;            // меньше 5 — фон не обоснован
const PRICE_DRIFT_TOLERANCE = 0.015;    // analytics_rules analysis-01
// Проверка обоснованности деления (не потолок и не прогноз): если на весь охват
// участников дня приходится больше 1 покупки на 100 просмотров, прирост дня этими
// публикациями не объяснить (обычно это хвост вчерашней крупной рекламы или акция) —
// такой день получает «недостаточно данных», а не урезанную сумму.
const MAX_PURCHASES_PER_VIEW = 0.01;
const EXCLUDED_ORDER_STATUSES = ["CANCELLED", "CANCELLING"];

// Коды из каталога поставщика (mixit_goods.xlsx: SKU_Поставщика ↔ Штрихкод), под которыми
// в Kaspi заказов нет, → код живой карточки того же товара. Только точные пары каталога,
// проверенные по заказам Kaspi (30.09.2026), без угадывания по названию. Без этой таблицы
// интеграции со старым кодом выпадали бы из дележа дня, и их доля доставалась бы другим.
// Применяется, ТОЛЬКО если исходный код в заказах не встречается, а целевой — встречается.
const CATALOG_CODE_MAP = {
  SKUA000932400: "4620400203526", // тональный флюид 01 (Velvet 01 Natural)
  SKUA000932500: "4620400203533", // тональный флюид 02 (Velvet 02 Soft Sand)
  SKUA000662900: "2000000034256", // набор шампунь+бальзам Collagen&Biotin (живая карточка набора)
  SKUA000635300: "4650358457429", // спрей-фиксатор макияжа
  SKUA000677100: "4650358455579", // крем Vitamin C Face Cream
  SKUA000834500: "4680607211953", // ламинирующая маска Collagen&Keratin 400 мл
  SKUA001006300: "4620400204820", // масло-блеск для губ cherry cola
  SKUA001006500: "4620400204318", // стик для контуринга 01
  "4650195821414": "SKU0014304000", // гидрофильное масло Mango (у штрихкода нет заказов, у SKU — есть)
};

// Статусы, при которых суммы НЕТ (kzt = NULL → во фронтенде «—»).
const NO_NUMBER_STATUSES = new Set([
  "no_published_date", "no_sku_code", "no_sku_data", "no_kaspi_data",
  "window_open", "kaspi_data_pending", "needs_reach_data", "baseline_uncertain",
  "duplicate", "compute_error",
]);

// ---------------------------------------------------------------------------
// Утилиты
// ---------------------------------------------------------------------------
function splitCodes(raw) {
  return (raw || "")
    .split(/[,+;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
function almatyTodayStr() {
  // Asia/Almaty = UTC+5, без перехода на летнее время
  const now = new Date(Date.now() + 5 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}
function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function minStr(a, b) { return a < b ? a : b; }
function maxStr(a, b) { return a > b ? a : b; }
function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function fmt(n) { return Math.round(n).toLocaleString("ru-RU").replace(/ /g, " "); }
// Логин блогера к одному виду: ссылка на Instagram (с /reels/ и т.п.), "@логин",
// голый логин — всё в "логин". Нужен для п.7 (одна интеграция в двух таблицах).
function normalizeHandle(h) {
  let s = (h || "").trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  s = s.replace(/^(instagram\.com|instagr\.am|tiktok\.com)\//, "");
  s = s.split(/[?#]/)[0].replace(/^@/, "");
  s = s.split("/")[0].replace(/^@/, "");
  return s;
}
const EMPTY_DAY = Object.freeze({ lines: 0, cancelled: 0, returned: 0, netLines: 0, qty: 0, kzt: 0 });

// ---------------------------------------------------------------------------
// ЧИСТАЯ функция расчёта (без базы) — вся методика здесь, чтобы её можно было
// проверить на реальных выгрузках без доступа к серверу.
//
// input:
//   placements  — [{id, source, blogger_handle, reach, kaspi_code, sku_name, published_date}]
//                 ВСЕ опубликованные интеграции (крупные + микро)
//   resolution  — Map исходный код → живой код | null (не найден в Kaspi)
//   daily       — Map код → Map дата → {lines, cancelled, returned, netLines, qty, kzt}
//                 (уже агрегировано ДО соединения с интеграциями)
//   listedSince — Map код → дата первой строки заказа в истории Kaspi
//   feedStart   — первая дата в истории Kaspi
//   dataLoadedThrough — последняя дата, до которой загружены заказы
//   today       — сегодня по Алматы
// ---------------------------------------------------------------------------
function planAttribution({ placements, resolution, daily, listedSince, feedStart, dataLoadedThrough, today }) {
  const results = new Map(); // id -> {status, units, kzt, note}
  const V = ` [${PARAMS_VERSION}]`;
  const setNoNumber = (id, status, note) => results.set(String(id), { status, units: null, kzt: null, note: note + V });
  const dayOf = (code, d) => (daily.get(code) && daily.get(code).get(d)) || EMPTY_DAY;
  const lastCompleteDay = dataLoadedThrough ? minStr(addDaysStr(today, -1), addDaysStr(dataLoadedThrough, -1)) : null;

  // Даты публикаций по каждому живому коду — ЛЮБАЯ опубликованная интеграция
  // (даже без охвата/с дублем): такие дни не могут быть «чистыми» для фона.
  const pubDatesByCode = new Map();
  for (const p of placements) {
    if (!p.published_date) continue;
    for (const raw of splitCodes(p.kaspi_code)) {
      for (const c of [raw, resolution.get(raw)]) {
        if (!c) continue;
        if (!pubDatesByCode.has(c)) pubDatesByCode.set(c, new Set());
        pubDatesByCode.get(c).add(p.published_date);
      }
    }
  }

  // --- 1. Кто вообще может участвовать ---
  const eligible = [];
  for (const p of placements) {
    const d0 = p.published_date;
    if (!d0) { setNoNumber(p.id, "no_published_date", "Статус «опубликовано», но дата публикации не заполнена."); continue; }
    const raw = splitCodes(p.kaspi_code);
    if (raw.length === 0) { setNoNumber(p.id, "no_sku_code", "ШК/SKU не указан — рекламируемый товар не определён."); continue; }
    const dead = raw.filter((c) => !resolution.get(c));
    if (dead.length) {
      setNoNumber(p.id, "no_sku_data", `Код ${dead.join(", ")} не найден в заказах Kaspi (и замены нет ни в каталоге, ни в справочнике product_aliases) — впишите живой код товара.`);
      continue;
    }
    if (feedStart && d0 < feedStart) {
      setNoNumber(p.id, "no_kaspi_data", `D0 = ${d0}, а история заказов Kaspi начинается с ${feedStart} — данных за день публикации нет.`);
      continue;
    }
    if (d0 >= today) { setNoNumber(p.id, "window_open", `D0 = ${d0} ещё не закончился — посчитается на следующий день.`); continue; }
    if (!dataLoadedThrough || dataLoadedThrough <= d0) {
      setNoNumber(p.id, "kaspi_data_pending", `Заказы Kaspi загружены только по ${dataLoadedThrough || "?"} — день ${d0} ещё не загружен полностью.`);
      continue;
    }
    const codes = [...new Set(raw.map((c) => resolution.get(c)))].sort();
    const replaced = raw.filter((c) => resolution.get(c) !== c).map((c) => `${c}→${resolution.get(c)}`);
    eligible.push({ ...p, id: String(p.id), d0, codes, replaced, handle: normalizeHandle(p.blogger_handle) });
  }

  // --- 2. Дубли одной интеграции в двух таблицах (п.7 шапки) ---
  const dupGroups = new Map();
  for (const p of eligible) {
    const key = p.handle ? `${p.handle}|${p.d0}|${p.codes.join(",")}` : `id:${p.id}`;
    if (!dupGroups.has(key)) dupGroups.set(key, []);
    dupGroups.get(key).push(p);
  }
  const primaries = [];
  for (const members of dupGroups.values()) {
    members.sort((a, b) => (a.source === b.source ? Number(a.id) - Number(b.id) : a.source === "barter_box_deals" ? -1 : 1));
    const primary = members[0];
    const reaches = members.map((m) => Number(m.reach) || 0).filter((r) => r > 0);
    primary.reachUsed = reaches.length ? Math.max(...reaches) : 0;
    primary.duplicates = members.slice(1);
    primaries.push(primary);
    for (const dup of members.slice(1)) {
      setNoNumber(dup.id, "duplicate", `Та же интеграция (${dup.blogger_handle}, ${dup.d0}, ${dup.codes.join(", ")}) уже учтена в строке id ${primary.id} (${primary.source === "barter_box_deals" ? "крупные" : "микро/средние"}) — сумма записана там, чтобы не задвоить заказы.`);
    }
  }

  // --- 3. Пулы (SKU, D0): факт → фон → доступная сумма → доли ---
  const pools = new Map();
  for (const p of primaries) {
    for (const code of p.codes) {
      const key = `${code}|${p.d0}`;
      if (!pools.has(key)) pools.set(key, { code, d0: p.d0, members: [] });
      pools.get(key).members.push(p);
    }
  }

  for (const pool of pools.values()) {
    const { code, d0, members } = pool;
    const A = dayOf(code, d0);
    pool.actual = A;
    pool.unitPrice = A.qty > 0 ? A.kzt / A.qty : null;
    pool.shares = new Map();

    if (A.qty <= 0 || A.kzt <= 0) {
      pool.status = "zero";
      pool.distributable = 0;
      pool.reason = `за ${d0} заказов этого SKU нет`;
      for (const m of members) pool.shares.set(m.id, { kzt: 0, units: 0, weight: members.length ? 1 / members.length : 0 });
      continue;
    }

    // Фон: ближайшие чистые, полностью загруженные дни в ±14 дней.
    const listed = listedSince.get(code) || d0;
    const lo = maxStr(feedStart || listed, listed);
    const hi = lastCompleteDay;
    const busy = pubDatesByCode.get(code) || new Set();
    const cand = [];
    for (let k = 1; k <= BASELINE_SEARCH_RADIUS_DAYS && cand.length < BASELINE_MAX_DAYS; k++) {
      for (const d of [addDaysStr(d0, -k), addDaysStr(d0, k)]) {
        if (cand.length >= BASELINE_MAX_DAYS) break;
        if (d < lo || !hi || d > hi || busy.has(d)) continue;
        cand.push(d);
      }
    }
    cand.sort();
    pool.baselineDays = cand;
    const candRecs = cand.map((d) => dayOf(code, d));
    pool.baselineKzt = median(candRecs.map((r) => r.kzt));
    const candPrices = candRecs.filter((r) => r.qty > 0).map((r) => r.kzt / r.qty);
    pool.baselinePrice = median(candPrices);

    if (cand.length < BASELINE_MIN_DAYS) {
      pool.status = "baseline_uncertain";
      pool.reason = `фон не обоснован: чистых дней без рекламы этого SKU рядом с D0 — ${cand.length} из ${BASELINE_MIN_DAYS} нужных (история Kaspi с ${feedStart})`;
      continue;
    }
    if (pool.baselinePrice != null && pool.unitPrice != null) {
      const drift = (pool.unitPrice - pool.baselinePrice) / pool.baselinePrice;
      if (Math.abs(drift) > PRICE_DRIFT_TOLERANCE) {
        pool.status = "baseline_uncertain";
        pool.reason = `фон не обоснован: цена в D0 ${fmt(pool.unitPrice)} ₸ против ${fmt(pool.baselinePrice)} ₸ в дни фона (${(drift * 100).toFixed(1)}%, порог ${PRICE_DRIFT_TOLERANCE * 100}%) — рост может быть от цены`;
        continue;
      }
    }

    const P = Math.min(A.kzt, Math.max(0, A.kzt - pool.baselineKzt));
    pool.distributable = P;

    if (P > 0 && members.some((m) => !(m.reachUsed > 0))) {
      pool.status = "needs_reach_data";
      pool.reason = `у ${members.filter((m) => !(m.reachUsed > 0)).map((m) => m.handle || m.blogger_handle).slice(0, 4).join(", ")} не заполнен охват — ${members.length > 1 ? "долю" : "соразмерность прироста охвату"} не обосновать (заполните охват)`;
      continue;
    }
    const totalReach = members.reduce((s, m) => s + (m.reachUsed || 0), 0);
    const impliedUnits = pool.unitPrice ? P / pool.unitPrice : 0;
    if (P > 0 && impliedUnits > totalReach * MAX_PURCHASES_PER_VIEW) {
      pool.status = "baseline_uncertain";
      pool.reason = `прирост дня ${fmt(P)} ₸ (≈${Math.round(impliedUnits)} шт) несоразмерен охвату публикаций этого дня (${fmt(totalReach)} просмотров — больше 1 покупки на 100 просмотров): рост объясняется не ими (хвост другой рекламы, акция) — делить нечего обоснованно`;
      continue;
    }
    let sum = 0;
    for (const m of members) {
      const w = members.length === 1 ? 1 : m.reachUsed / totalReach;
      const kzt = Math.floor(P * w);                // вниз — сумма долей не превысит P
      const units = pool.unitPrice ? Math.floor((kzt / pool.unitPrice) * 100) / 100 : 0;
      pool.shares.set(m.id, { kzt, units, weight: w });
      sum += kzt;
    }
    // Жёсткие ограничения (п.5–6): нарушение = ошибка, а не «подрезка» цифры.
    if (P > A.kzt + 0.5 || sum > P + 0.5) {
      pool.status = "compute_error";
      pool.reason = `нарушен потолок: доли ${sum} > доступно ${P} или ${P} > факт ${A.kzt}`;
      continue;
    }
    pool.sharedSum = sum;
    pool.status = P > 0 ? "ok" : "zero";
    if (P === 0) pool.reason = `факт ${fmt(A.kzt)} ₸ не выше фона ${fmt(pool.baselineKzt)} ₸`;
  }

  // --- 4. Итог по интеграции: сумма её долей по всем её SKU ---
  const RANK = { compute_error: 5, needs_reach_data: 4, baseline_uncertain: 3 };
  for (const p of primaries) {
    const myPools = p.codes.map((c) => pools.get(`${c}|${p.d0}`));
    const bad = myPools.filter((x) => RANK[x.status]).sort((a, b) => RANK[b.status] - RANK[a.status]);
    const replNote = p.replaced.length ? ` Код заменён на живую карточку Kaspi (каталог/product_aliases): ${p.replaced.join(", ")}.` : "";
    if (bad.length) {
      setNoNumber(p.id, bad[0].status, `D0 ${p.d0}: ${bad.map((x) => `SKU ${x.code} — ${x.reason}`).join("; ")}. Суммы нет (не «не уверены», а «недостаточно данных»).${replNote}`);
      continue;
    }
    let kzt = 0, units = 0;
    const parts = [];
    for (const x of myPools) {
      const sh = x.shares.get(p.id) || { kzt: 0, units: 0, weight: 0 };
      kzt += sh.kzt;
      units += sh.units;
      const others = x.members.filter((m) => m.id !== p.id);
      const A = x.actual;
      parts.push(
        x.status === "zero" && x.distributable === 0 && !x.baselineDays
          ? `SKU ${x.code}: ${x.reason}`
          : `SKU ${x.code}: заказы за D0 — ${A.netLines} уник. строк / ${fmt(A.kzt)} ₸ (исключено: отмены ${A.cancelled}, возвраты ${A.returned}); ` +
            `фон ${fmt(x.baselineKzt)} ₸ (медиана ${x.baselineDays.length} чистых дн.: ${x.baselineDays.join(", ")}); ` +
            `к распределению ${fmt(x.distributable)} ₸; ` +
            (others.length ? `делили по охвату (${fmt(p.reachUsed)} из ${fmt(x.members.reduce((a, m) => a + (m.reachUsed || 0), 0))}) с: ${others.slice(0, 4).map((m) => m.handle || m.blogger_handle).join(", ")}${others.length > 4 ? ` и ещё ${others.length - 4}` : ""}; доля ${(sh.weight * 100).toFixed(1)}%` : "единственная интеграция этого SKU в этот день") +
            ` → ${fmt(sh.kzt)} ₸`
      );
    }
    const dupNote = p.duplicates.length ? ` Та же интеграция есть и в строке id ${p.duplicates.map((d) => d.id).join(", ")} — сумма записана только здесь.` : "";
    results.set(p.id, {
      status: kzt > 0 ? "ok" : "zero",
      units: Math.round(units * 100) / 100,
      kzt,
      note: `День в день, D0 ${p.d0}. ${parts.join(" | ")}.${replNote}${dupNote} Расчётная атрибуция, не доказанные покупки конкретного блогера.${V}`,
    });
  }

  return { results, pools };
}

// ---------------------------------------------------------------------------
// Ввод-вывод: читаем базу, считаем planAttribution, пишем всё одним UPDATE.
// ---------------------------------------------------------------------------
async function runDailyAttribution(pgPool, { log = console.log } = {}) {
  const today = almatyTodayStr();

  // 0. Старые результаты у неопубликованных строк не должны висеть в кэше.
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
  const { rows: fs } = await pgPool.query(`SELECT min(order_date)::text AS d FROM analytics.kaspi_live_order_entries`);
  const feedStart = fs[0] ? fs[0].d : null;

  const { rows: placements } = await pgPool.query(
    `SELECT id::text AS id, source, blogger_handle, reach, kaspi_code, sku_name,
            published_date::date::text AS published_date
     FROM public.influencer_placements
     WHERE status = 'published'`
  );
  log(`[attribution ${PARAMS_VERSION}] ${today}: опубликованных интеграций ${placements.length}, история Kaspi ${feedStart}…${dataLoadedThrough}, обнулено неопубликованных: ${reset.rowCount}`);
  if (placements.length === 0) return { processed: 0 };

  // 1. Какие коды живые: есть хоть одна строка заказа в истории Kaspi.
  const allRaw = [...new Set(placements.flatMap((p) => splitCodes(p.kaspi_code)))];
  const listedSince = new Map();
  if (allRaw.length) {
    const { rows } = await pgPool.query(
      `SELECT offer_code, min(order_date)::text AS first_d FROM analytics.kaspi_live_order_entries
       WHERE offer_code = ANY($1::text[]) GROUP BY offer_code`,
      [allRaw]
    );
    rows.forEach((r) => listedSince.set(r.offer_code, r.first_d));
  }
  // Мёртвые коды — точные пары каталога (CATALOG_CODE_MAP) и проверенный справочник
  // product_aliases, оба по КОДУ. Подбор по похожести названий (v4) убран: он мог
  // подменить рекламируемый товар чужим.
  const resolution = new Map();
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
       GROUP BY po.kaspi_code`,
      [deadNoCatalog]
    );
    rows.forEach((r) => { if (r.new_codes.length === 1) aliasMap.set(r.old_code, r.new_codes[0]); });
  }
  const newCodes = [...new Set(aliasMap.values())].filter((c) => !listedSince.has(c));
  if (newCodes.length) {
    const { rows: r2 } = await pgPool.query(
      `SELECT offer_code, min(order_date)::text AS first_d FROM analytics.kaspi_live_order_entries
       WHERE offer_code = ANY($1::text[]) GROUP BY offer_code`,
      [newCodes]
    );
    r2.forEach((r) => listedSince.set(r.offer_code, r.first_d));
  }
  for (const c of allRaw) {
    if (listedSince.has(c)) resolution.set(c, c);
    else if (aliasMap.has(c) && listedSince.has(aliasMap.get(c))) resolution.set(c, aliasMap.get(c));
    else resolution.set(c, null);
  }

  // 2. Заказы по (SKU, дата) — агрегируем ДО соединения с интеграциями.
  const liveCodes = [...new Set([...resolution.values()].filter(Boolean))];
  const d0s = placements.map((p) => p.published_date).filter(Boolean).sort();
  const daily = new Map();
  if (liveCodes.length && d0s.length && feedStart) {
    const from = maxStr(addDaysStr(d0s[0], -BASELINE_SEARCH_RADIUS_DAYS), feedStart);
    const to = addDaysStr(d0s[d0s.length - 1], BASELINE_SEARCH_RADIUS_DAYS);
    const { rows } = await pgPool.query(
      `WITH lines AS (
         SELECT DISTINCT ON (COALESCE(e.entry_id, e.order_id || '|' || e.offer_code))
                e.order_id, e.offer_code, e.order_date, e.order_status, e.quantity, e.total_price
         FROM analytics.kaspi_live_order_entries e
         WHERE e.offer_code = ANY($1::text[]) AND e.order_date BETWEEN $2::date AND $3::date
         ORDER BY COALESCE(e.entry_id, e.order_id || '|' || e.offer_code), e.last_seen_at DESC NULLS LAST
       ),
       ret AS (
         SELECT s.order_id, bool_or(COALESCE(s.return_recorded, false)) AS returned
         FROM public.kaspi_order_sync_state s
         WHERE s.order_id IN (SELECT order_id FROM lines)
         GROUP BY s.order_id
       ),
       flagged AS (
         SELECT l.*, (l.order_status = ANY($4::text[])) AS is_cancelled, COALESCE(r.returned, false) AS is_returned
         FROM lines l LEFT JOIN ret r ON r.order_id = l.order_id
       )
       SELECT offer_code, order_date::text AS d,
              count(*)::int AS lines,
              count(*) FILTER (WHERE is_cancelled)::int AS cancelled,
              count(*) FILTER (WHERE NOT is_cancelled AND is_returned)::int AS returned,
              count(*) FILTER (WHERE NOT is_cancelled AND NOT is_returned)::int AS net_lines,
              COALESCE(sum(quantity) FILTER (WHERE NOT is_cancelled AND NOT is_returned), 0)::float8 AS qty,
              COALESCE(sum(total_price) FILTER (WHERE NOT is_cancelled AND NOT is_returned), 0)::float8 AS kzt
       FROM flagged GROUP BY offer_code, order_date`,
      [liveCodes, from, to, EXCLUDED_ORDER_STATUSES]
    );
    for (const r of rows) {
      if (!daily.has(r.offer_code)) daily.set(r.offer_code, new Map());
      daily.get(r.offer_code).set(r.d, {
        lines: r.lines, cancelled: r.cancelled, returned: r.returned, netLines: r.net_lines,
        qty: Number(r.qty), kzt: Number(r.kzt),
      });
    }
  }

  // 3. Расчёт.
  let plan;
  try {
    plan = planAttribution({ placements, resolution, daily, listedSince, feedStart, dataLoadedThrough, today });
  } catch (e) {
    log(`[attribution] ошибка расчёта: ${e.message}`);
    throw e;
  }

  // 4. Запись — одним UPDATE для всех опубликованных строк.
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
    [ids, units, kzts, statuses, notes]
  );

  const byStatus = {};
  statuses.forEach((s) => (byStatus[s] = (byStatus[s] || 0) + 1));
  log(`[attribution] готово: ${ids.length} строк, по статусам ${JSON.stringify(byStatus)}`);
  return { processed: ids.length, byStatus };
}

module.exports = {
  CATALOG_CODE_MAP, runDailyAttribution, planAttribution, almatyTodayStr, addDaysStr, splitCodes, normalizeHandle,
  PARAMS_VERSION, NO_NUMBER_STATUSES,
};
