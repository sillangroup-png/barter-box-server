// ============================================================================
// attribution.js — автоматический расчёт "вклада в продажи" для интеграций
// блогеров, на основе продаж Kaspi (analytics.v_kaspi_placed_sku в Supabase).
//
// v3. Что нового по сравнению с v2 и почему:
//
// 1) АВТО-ИСПРАВЛЕНИЕ МЁРТВЫХ/УСТАРЕВШИХ ШК ПО НАЗВАНИЮ.
//    Раньше: если по ШК из barter-box нет продаж — просто флагуем "no_sku_data" и
//    ждём, пока кто-то вручную найдёт правильный код (так было со "скульптор
//    01/02", потом с "тушь"/LashLust — Kaspi переносит товар на новую карточку,
//    а ШК в barter-box остаётся старым). Теперь при "коде без продаж" система
//    сама ищет среди РЕАЛЬНО живых кодов в Kaspi (за последние SKU_STALE_DAYS)
//    товар, чьё название заметно совпадает с sku_name из barter-box (≥2 общих
//    значимых слова — порог строже, чем для простой сверки, т.к. тут решение
//    принимается автоматически, не просто предупреждение). Если находится РОВНО
//    один такой код — используем его, а в заметке честно пишем, что код заменён
//    автоматически. Если совпадений 0 или больше одного — не гадаем, остаётся
//    no_sku_data, как раньше.
//
// 2) СЕМЬИ ТОВАРОВ: НАБОР + ОТДЕЛЬНЫЕ ШАМПУНЬ/БАЛЬЗАМ СЧИТАЮТСЯ ВМЕСТЕ.
//    Коллаген+Биотин и Коллаген+Аминокислоты продаются и набором, и отдельными
//    шампунем/бальзамом той же линейки — блогер может спровоцировать покупку
//    любого варианта, поэтому считать нужно суммарный прирост по всей семье
//    кодов, а не только по тому одному ШК, что указан в конкретном размещении.
//    См. FAMILY_CODES — список зашит вручную (не auto-detect), т.к. это два
//    конкретных, явно названных случая, а не общее правило для всех товаров.
//
// 3) БАЗА "СКОЛЬЗЯЩАЯ И ЧИСТАЯ" (без изменений с v2): среднее по последним
//    BASELINE_DAYS чистым (без рекламы) дням, ищем вглубь до BASELINE_LOOKBACK_DAYS.
//    Если чистых дней меньше MIN_CLEAN_DAYS_TRUST — статус "baseline_uncertain",
//    число не прячем, но доверять ему нельзя наравне с "ok".
//
// 4) ЦЕНА НЕ БЛОКИРУЕТ РАСЧЁТ (без изменений с v2): штуки от цены не зависят,
//    ₸ считается по факту цены каждого дня — при разбросе цены просто пометка
//    в заметке, не отказ считать.
//
// 5) ОДИН ПРОХОД СЧИТАЕТ И "СВЕЖЕЕ" ОКНО, И ВЕСЬ БЭКЛОГ (без изменений с v2):
//    today-2/today-3 пересчитываются всегда, плюс любые ещё не посчитанные
//    публикации любой давности — сентябрь и раньше добираются сами, свежие
//    месяцы в приоритете при сортировке групп.
//
// Результат пишется в НОВЫЕ колонки public.influencer_placements
// (auto_contribution_*, см. 01_migration.sql) — существующее поле
// "вклад в продажи", которое менеджеры заполняют вручную, не трогается.
// ============================================================================

const REACH_MIN = 10000;                 // порог охвата для малых/микро блогеров
const BASELINE_DAYS = 7;                 // сколько ЧИСТЫХ дней брать под базу
const BASELINE_LOOKBACK_DAYS = 60;       // как далеко назад искать чистые дни для базы
const MIN_CLEAN_DAYS_TRUST = 3;          // меньше стольки чистых дней в базе — не доверяем числу (см. baseline_uncertain)
const SKU_STALE_DAYS = 14;               // если по ШК нет продаж дольше этого — код считаем битым
const PRICE_DRIFT_TOLERANCE = 0.03;      // >3% разброса цены — не блокируем расчёт, только помечаем в заметке
const NAME_MATCH_MIN_SHARED_WORDS = 1;   // порог для мягкой сверки (name_mismatch — предупреждение, не блокирует)
const AUTO_RESOLVE_MIN_SHARED_WORDS = 2; // порог для автозамены мёртвого ШК на живой (строже — тут решение принимается молча)

// Семьи товаров: набор + отдельные позиции той же линейки считаются вместе (см.
// пункт 2 выше). Ключ — служебное имя семьи, значение — все ШК, которые нужно
// суммировать. Коды подтверждены напрямую в Kaspi (analytics.v_kaspi_placed_sku).
const FAMILY_CODES = {
  biotin_family: ["2000000034256", "SKUA000787900", "SKUA000788000"], // набор, шампунь, бальзам — Коллаген+Биотин
  amino_family: ["2000000034263", "SKUA000392700", "SKUA000392900"],  // набор, шампунь, бальзам — Коллаген+Аминокислоты
};
const CODE_TO_FAMILY = {};
for (const [fam, codes] of Object.entries(FAMILY_CODES)) {
  for (const c of codes) CODE_TO_FAMILY[c] = fam;
}
function codesForKey(key) {
  return FAMILY_CODES[key] || [key];
}

// ---------------------------------------------------------------------------
// Даты. Через to_char/::text, а не Date из pg: колонки типа `date` при чтении
// в JS легко ловят сдвиг на день туда-сюда из-за таймзоны драйвера. Работаем
// со строками 'YYYY-MM-DD', которые Postgres формирует сам — однозначно.
// ---------------------------------------------------------------------------
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

function normalizeWords(s) {
  return (s || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^a-zа-я0-9]+/i)
    .filter((w) => w.length >= 4); // короткие служебные слова не считаем
}
function sharedWordCount(nameA, nameB) {
  const a = new Set(normalizeWords(nameA));
  const b = new Set(normalizeWords(nameB));
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared;
}
function nameLooksRelated(skuName, kaspiTovar) {
  const a = normalizeWords(skuName);
  const b = normalizeWords(kaspiTovar);
  if (a.length === 0 || b.length === 0) return true; // нечего сравнивать — не блокируем
  return sharedWordCount(skuName, kaspiTovar) >= NAME_MATCH_MIN_SHARED_WORDS;
}

async function writeResult(pgPool, id, { status, units = null, kzt = null, note = "" }) {
  await pgPool.query(
    `UPDATE public.influencer_placements
     SET auto_contribution_units = $2,
         auto_contribution_kzt = $3,
         auto_contribution_status = $4,
         auto_contribution_note = $5,
         auto_contribution_computed_at = now()
     WHERE id = $1`,
    [id, units, kzt, status, note.slice(0, 900)]
  );
}

function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Основная функция. Вызывать раз в сутки (можно чаще — для уже посчитанных
// пар "сегодня-2/сегодня-3" и для пустого бэклога это дешёвые запросы).
// ---------------------------------------------------------------------------
async function runDailyAttribution(pgPool, { log = console.log } = {}) {
  const today = almatyTodayStr();
  const freshDates = [addDaysStr(today, -2), addDaysStr(today, -3)];
  const staleCutoff = addDaysStr(today, -SKU_STALE_DAYS);

  log(`[attribution] запуск на ${today}: свежее окно ${freshDates.join(" и ")} + весь ещё не посчитанный бэклог`);

  const { rows: placements } = await pgPool.query(
    `SELECT id, tier, reach, kaspi_code, sku_name, published_date::text AS published_date, manager, blogger_handle
     FROM public.influencer_placements
     WHERE status = 'published'
       AND (published_date::date = ANY($1::date[]) OR auto_contribution_status IS NULL)`,
    [freshDates]
  );

  if (placements.length === 0) {
    log("[attribution] нечего считать — ни свежего окна, ни бэклога");
    return { processed: 0 };
  }

  const eligible = [];
  for (const p of placements) {
   try {
    // status='published', но дата публикации не заполнена — такое есть (см. историю: упало
    // на "Invalid time value"). Без даты не построить окно атрибуции — не гадаем, флагуем.
    if (!p.published_date) {
      await writeResult(pgPool, p.id, {
        status: "no_published_date",
        note: "Статус «опубликовано», но дата публикации не заполнена — заполните дату, тогда посчитается.",
      });
      continue;
    }
    const isSmallTier = p.tier === "Малый" || p.tier === "Микро";
    if (isSmallTier && (!p.reach || p.reach < REACH_MIN)) {
      await writeResult(pgPool, p.id, {
        status: "excluded_reach",
        note: `Охват ${p.reach || 0} < ${REACH_MIN} — для малых/микро блогеров прирост не считаем.`,
      });
      continue;
    }
    if (!p.kaspi_code) {
      await writeResult(pgPool, p.id, { status: "no_sku_code", note: "ШК не указан в barter-box." });
      continue;
    }
    eligible.push(p);
   } catch (e) {
    log(`[attribution] ошибка на записи id=${p.id}: ${e.message}`);
    try {
      await writeResult(pgPool, p.id, {
        status: "compute_error",
        note: `Внутренняя ошибка расчёта: ${String(e.message).slice(0, 400)}. Разберите вручную.`,
      });
    } catch (e2) {
      log(`[attribution] не удалось записать статус ошибки для id=${p.id}: ${e2.message}`);
    }
   }
  }

  // --- Авто-исправление мёртвых ШК по названию (см. пункт 1 в шапке файла) ---
  // Живой каталог: все офферы с продажами за последние SKU_STALE_DAYS — по нему
  // ищем, куда мог "переехать" товар с мёртвого кода. Один запрос на весь прогон.
  const { rows: catalogRows } = await pgPool.query(
    `SELECT offer_code, tovar FROM analytics.v_kaspi_placed_sku
     WHERE order_date >= $1::date GROUP BY offer_code, tovar`,
    [staleCutoff]
  );

  // Частотный словарь слов по всему живому каталогу. Нужен, чтобы отличать
  // РАЗЛИЧИТЕЛЬНЫЕ слова конкретного товара ("lashlust", "magnif eye",
  // "скульптор") от общих для бренда/категории слов ("mixit", "для", "тушь",
  // "крем", "набор"), которые встречаются в доброй половине каталога и потому
  // ничего не различают — по ним "тушь" совпадёт сразу с 3-4 разными тушами.
  // Слово, встречающееся более чем в GENERIC_WORD_MAX_DOCS разных названиях
  // каталога, в счёт совпадений не идёт.
  const wordDocFreq = new Map();
  for (const c of catalogRows) {
    for (const w of new Set(normalizeWords(c.tovar))) wordDocFreq.set(w, (wordDocFreq.get(w) || 0) + 1);
  }
  const GENERIC_WORD_MAX_DOCS = Math.max(3, Math.round(catalogRows.length * 0.03));
  function distinctiveWords(name) {
    return normalizeWords(name).filter((w) => (wordDocFreq.get(w) || 1) <= GENERIC_WORD_MAX_DOCS);
  }
  function distinctiveSharedWordCount(nameA, nameB) {
    const a = new Set(distinctiveWords(nameA));
    const b = new Set(normalizeWords(nameB));
    let shared = 0;
    for (const w of a) if (b.has(w)) shared++;
    return shared;
  }

  const byOriginalCode = groupBy(eligible, (p) => p.kaspi_code);
  const codeResolution = new Map(); // originalCode -> resolvedCode | null (не нашли)
  const resolutionNote = new Map(); // originalCode -> текст для заметки

  for (const [origCode, grp] of byOriginalCode) {
    if (CODE_TO_FAMILY[origCode]) { codeResolution.set(origCode, origCode); continue; } // уже родной код семьи
    const { rows: check } = await pgPool.query(
      `SELECT count(*)::int AS n FROM analytics.v_kaspi_placed_sku WHERE offer_code = $1 AND order_date >= $2::date`,
      [origCode, staleCutoff]
    );
    if (check[0].n > 0) { codeResolution.set(origCode, origCode); continue; } // код живой, всё в порядке

    // Код мёртвый — ищем среди живого каталога совпадение по названию. В
    // barter-box у одного и того же ШК бывают и подробные названия ("Тушь для
    // ресниц с эффектом максимального объёма-MIXIT Make Up LashLust Volume Max
    // Mascara"), и однословные ("тушь" — так писали часть менеджеров). Решение
    // принимаем ОДНО на весь код, по самому подробному названию, какое есть в
    // группе — оно надёжнее; общие слова бренда/категории ("mixit", "тушь",
    // "для") не считаем — иначе любая тушь совпадёт с любой тушью. Берём того
    // живого кандидата, у кого различительных совпадений заметно БОЛЬШЕ, чем у
    // всех прочих (не просто "набралось >= порога" — а "явно лучше второго
    // места"); если явного лидера нет — не гадаем, оставляем как было.
    const namesRanked = [...new Set(grp.map((p) => p.sku_name).filter(Boolean))]
      .map((name) => ({ name, words: distinctiveWords(name) }))
      .filter((x) => x.words.length > 0)
      .sort((a, b) => b.words.length - a.words.length);

    if (namesRanked.length === 0) {
      codeResolution.set(origCode, null); // названия нет или оно целиком из общих слов — сверять не с чем
      continue;
    }
    const bestName = namesRanked[0].name;
    const threshold = Math.min(AUTO_RESOLVE_MIN_SHARED_WORDS, namesRanked[0].words.length);

    const scored = [];
    for (const c of catalogRows) {
      const score = distinctiveSharedWordCount(bestName, c.tovar);
      if (score >= threshold) scored.push({ code: c.offer_code, score });
    }
    scored.sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      codeResolution.set(origCode, null); // ни одного похожего живого товара
    } else if (scored.length === 1 || scored[0].score > scored[1].score) {
      const resolved = scored[0].code;
      codeResolution.set(origCode, resolved);
      resolutionNote.set(origCode, ` ШК автоматически заменён с ${origCode} на ${resolved} — в Kaspi товар переехал на новую карточку, название совпало (по "${bestName}").`);
      log(`[attribution] авто-замена ШК: ${origCode} → ${resolved} (по названию: ${bestName}, счёт ${scored[0].score} против ${scored[1] ? scored[1].score : 0} у второго места)`);
    } else {
      codeResolution.set(origCode, null); // несколько одинаково похожих — не гадаем
    }
  }

  // Пересобираем группы: по семье (если код входит в семью), иначе по
  // резолвленному коду (если нашли замену), иначе по исходному коду как раньше
  // (сработает no_sku_data ниже, ничего не потеряно относительно v2).
  const byCode = groupBy(eligible, (p) => {
    if (CODE_TO_FAMILY[p.kaspi_code]) return CODE_TO_FAMILY[p.kaspi_code];
    const resolved = codeResolution.get(p.kaspi_code);
    return resolved || p.kaspi_code;
  });

  // Сначала группы, где есть хотя бы одна свежая публикация — чтобы если процесс
  // прервётся или не успеет за один тик, недавние месяцы (сейчас это сентябрь)
  // досчитались раньше, чем старый бэклог с июня.
  const codeEntries = [...byCode.entries()].sort((a, b) => {
    const maxA = a[1].reduce((m, p) => (p.published_date > m ? p.published_date : m), "");
    const maxB = b[1].reduce((m, p) => (p.published_date > m ? p.published_date : m), "");
    return maxB.localeCompare(maxA); // по убыванию даты — свежие сначала
  });

  let processed = 0;

  for (const [productKey, group] of codeEntries) {
   try {
    // Всё тело обработки одной группы (один товар — код, семья или резолвленный
    // код) — в try/catch. Если в данных окажется что-то, чего мы не предусмотрели
    // — падать должна только ЭТА группа, а не весь суточный расчёт целиком.
    const isFamily = !!FAMILY_CODES[productKey];
    // Все "сырые" ШК, под которыми может копиться реклама по этому продукту: коды
    // семьи (если семья) плюс любые исходные ШК, реально встретившиеся в группе
    // (после авто-замены сюда попадают и старые мёртвые коды, чтобы их реклама
    // тоже засчиталась как "занятый" день).
    const rawCodes = [...new Set([...(FAMILY_CODES[productKey] || [productKey]), ...group.map((p) => p.kaspi_code)])];

    const pubDates = group.map((p) => p.published_date);
    const minTarget = pubDates.reduce((a, b) => (a < b ? a : b));
    const maxTarget = pubDates.reduce((a, b) => (a > b ? a : b));
    const windowEnd = addDaysStr(maxTarget, 1);
    const historyStart = addDaysStr(minTarget, -BASELINE_LOOKBACK_DAYS);

    const { rows: recentCheck } = await pgPool.query(
      `SELECT count(*)::int AS n FROM analytics.v_kaspi_placed_sku WHERE offer_code = ANY($1::text[]) AND order_date >= $2::date`,
      [rawCodes, staleCutoff]
    );
    if (recentCheck[0].n === 0) {
      for (const p of group) {
        await writeResult(pgPool, p.id, {
          status: "no_sku_data",
          note: `По ШК ${p.kaspi_code} нет продаж в Kaspi за последние ${SKU_STALE_DAYS} дн., и автоматически найти замену по названию не удалось (совпадений 0 или больше одного) — проверьте вручную.`,
        });
      }
      continue;
    }

    // Продажи для базы и для окна — суммируем по дню, если товар представлен
    // несколькими ШК (семья: набор + отдельные позиции).
    const { rows: history } = await pgPool.query(
      `SELECT order_date::text AS d, SUM(shtuk) AS shtuk, SUM(shtuk*cena) AS revenue
       FROM analytics.v_kaspi_placed_sku
       WHERE offer_code = ANY($1::text[]) AND order_date BETWEEN $2::date AND $3::date
       GROUP BY order_date ORDER BY order_date`,
      [rawCodes, historyStart, windowEnd]
    );
    const byDate = new Map(
      history.map((r) => {
        const shtuk = Number(r.shtuk);
        const revenue = Number(r.revenue);
        return [r.d, { shtuk, cena: shtuk > 0 ? revenue / shtuk : 0 }]; // cena — средневзвешенная цена дня
      })
    );

    // Названия для сверки — все, что реально продавались под этими кодами
    // (для семьи это разом "набор", "шампунь", "бальзам" — sku_name может
    // упоминать любое из них).
    const { rows: tovarRows } = await pgPool.query(
      `SELECT DISTINCT tovar FROM analytics.v_kaspi_placed_sku WHERE offer_code = ANY($1::text[]) AND order_date >= $2::date`,
      [rawCodes, historyStart]
    );
    const kaspiTovars = tovarRows.map((r) => r.tovar).filter(Boolean);

    // Календарь "занятых" дней — ЛЮБОЕ опубликованное размещение с одним из
    // rawCodes (даже отсеянное по охвату: реклама всё равно была, база рядом
    // с ней грязная), не только те, что попали в текущую пачку на пересчёт.
    const { rows: allCodePlacements } = await pgPool.query(
      `SELECT published_date::text AS d FROM public.influencer_placements
       WHERE kaspi_code = ANY($1::text[]) AND status = 'published' AND published_date IS NOT NULL`,
      [rawCodes]
    );
    const occupied = new Set();
    allCodePlacements.forEach((p) => {
      occupied.add(p.d);
      occupied.add(addDaysStr(p.d, 1));
    });

    // База дня D = среднее по последним BASELINE_DAYS чистым (не занятым и с
    // данными) дням строго до D, отступая назад до BASELINE_LOOKBACK_DAYS.
    function cleanBaselineFor(dateD) {
      const vals = [];
      let cursor = addDaysStr(dateD, -1);
      for (let steps = 0; steps < BASELINE_LOOKBACK_DAYS && vals.length < BASELINE_DAYS; steps++) {
        if (!occupied.has(cursor) && byDate.has(cursor)) vals.push(byDate.get(cursor).shtuk);
        cursor = addDaysStr(cursor, -1);
      }
      return {
        value: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0,
        cleanCount: vals.length,
      };
    }

    const baselineByDate = new Map();
    for (let d = minTarget; d <= windowEnd; d = addDaysStr(d, 1)) baselineByDate.set(d, cleanBaselineFor(d));

    // Цена: штуки считаем всегда, ₸ — каждый день своей реальной (средневзвешенной,
    // если товар = семья) ценой на тот день, поэтому смена цены посреди периода не
    // искажает ₸-сумму задним числом. Если цена всё же прыгала — не блокируем,
    // а просто помечаем это в заметке к результату, для сведения.
    const usedPriceDates = new Set();
    for (let d = minTarget; d <= windowEnd; d = addDaysStr(d, 1)) usedPriceDates.add(d);
    for (const [d] of byDate) if (d >= historyStart && d <= windowEnd && !occupied.has(d)) usedPriceDates.add(d);
    const pricesUsed = [...usedPriceDates]
      .map((d) => (byDate.has(d) ? Number(byDate.get(d).cena) : null))
      .filter((v) => v > 0);
    let priceNote = "";
    if (pricesUsed.length) {
      const priceMin = Math.min(...pricesUsed);
      const priceMax = Math.max(...pricesUsed);
      const priceRange = (priceMax - priceMin) / priceMin;
      if (priceRange > PRICE_DRIFT_TOLERANCE) {
        priceNote = ` Цена в этот период менялась (от ${priceMin} до ${priceMax} ₸) — ₸ посчитаны по факту цены каждого дня, штуки цена не затрагивает.`;
      }
    }

    const familyNote = isFamily
      ? ` Считалось суммарно по всей линейке (набор + отдельные шампунь/бальзам): ${FAMILY_CODES[productKey].join(", ")}.`
      : "";

    // Сверка названия — мягкая, только предупреждение (не блокирует): сравниваем
    // с ЛЮБЫМ из реально продающихся названий под этими кодами, не только с одним.
    const groupChecked = [];
    for (const p of group) {
      const related = kaspiTovars.length === 0 || kaspiTovars.some((t) => nameLooksRelated(p.sku_name, t));
      if (!related) {
        await writeResult(pgPool, p.id, {
          status: "name_mismatch",
          note: `Название в barter-box ("${p.sku_name}") не похоже ни на одно название товара по ШК ${p.kaspi_code} в Kaspi (${kaspiTovars.slice(0, 3).map((t) => `"${t}"`).join(", ")}). Проверьте вручную.${resolutionNote.get(p.kaspi_code) || ""}`,
        });
        continue;
      }
      groupChecked.push(p);
    }
    if (groupChecked.length === 0) continue;

    // Прирост по каждому дню окна: факт минус СВОЯ база этого дня, floor на 0.
    const dayIncrement = new Map();
    for (let d = minTarget; d <= windowEnd; d = addDaysStr(d, 1)) {
      const rec = byDate.get(d);
      const actualUnits = rec ? rec.shtuk : 0;
      const price = rec ? rec.cena : pricesUsed[pricesUsed.length - 1] || 0;
      const base = baselineByDate.get(d).value;
      const incUnits = Math.max(0, actualUnits - base);
      dayIncrement.set(d, { units: incUnits, kzt: incUnits * price });
    }

    // Делим каждый день окна между теми, чьё окно (публикация + день после) его
    // покрывает, пропорционально охвату — без изменений.
    const totals = new Map(groupChecked.map((p) => [p.id, { units: 0, kzt: 0, missingReachDays: 0, sharedWith: new Set() }]));

    for (let d = minTarget; d <= windowEnd; d = addDaysStr(d, 1)) {
      const participants = groupChecked.filter((p) => d >= p.published_date && d <= addDaysStr(p.published_date, 1));
      if (participants.length === 0) continue;
      const inc = dayIncrement.get(d) || { units: 0, kzt: 0 };
      if (inc.units === 0) continue;

      if (participants.length === 1) {
        const t = totals.get(participants[0].id);
        t.units += inc.units;
        t.kzt += inc.kzt;
        continue;
      }

      const withReach = participants.filter((p) => p.reach && p.reach > 0);
      const withoutReach = participants.filter((p) => !p.reach || p.reach <= 0);
      for (const p of withoutReach) {
        const t = totals.get(p.id);
        t.missingReachDays += 1;
        for (const other of participants) if (other.id !== p.id) t.sharedWith.add(other.blogger_handle);
      }
      if (withReach.length === 0) continue; // делить не на что — просто ждём охват

      const totalReach = withReach.reduce((s, p) => s + p.reach, 0);
      for (const p of withReach) {
        const share = p.reach / totalReach;
        const t = totals.get(p.id);
        t.units += inc.units * share;
        t.kzt += inc.kzt * share;
      }
    }

    for (const p of groupChecked) {
      const t = totals.get(p.id);
      const resNote = resolutionNote.get(p.kaspi_code) || "";
      if (t.missingReachDays > 0) {
        await writeResult(pgPool, p.id, {
          status: "needs_reach_data",
          units: Math.round(t.units * 100) / 100,
          kzt: Math.round(t.kzt),
          note: `Охват не заполнен, а в ${t.missingReachDays} дн. окна тот же товар публиковали ещё: ${[...t.sharedWith].join(", ") || "—"}. Без охвата долю не разделить — заполните охват и пересчитается. Частично посчитанное (дни, где делить было не с кем): ${Math.round(t.units * 100) / 100} шт / ${Math.round(t.kzt)} ₸.${familyNote}${resNote}`,
        });
      } else {
        const units = Math.round(t.units * 100) / 100;
        const kzt = Math.round(t.kzt);
        const windowDates = [p.published_date, addDaysStr(p.published_date, 1)];
        const minCleanInWindow = Math.min(...windowDates.map((d) => baselineByDate.get(d).cleanCount));
        const base = baselineByDate.get(p.published_date);
        if (minCleanInWindow < MIN_CLEAN_DAYS_TRUST) {
          await writeResult(pgPool, p.id, {
            status: "baseline_uncertain",
            units,
            kzt,
            note: `По этому товару почти нет "чистых" дней без чужой рекламы за последние ${BASELINE_LOOKBACK_DAYS} дн. (нашлось только ${minCleanInWindow} из ${BASELINE_DAYS} нужных) — база ${base.value.toFixed(1)} шт/день ненадёжна, число ${units} шт / ${kzt} ₸ может быть занижено или завышено. Проверьте вручную.${familyNote}${resNote}`,
          });
        } else {
          await writeResult(pgPool, p.id, {
            status: units > 0 ? "ok" : "zero",
            units,
            kzt,
            note: `База ${base.value.toFixed(1)} шт/день (скользящая, по ${base.cleanCount} чистым дням без рекламы по этому товару), окно ${p.published_date}–${addDaysStr(p.published_date, 1)}${groupChecked.length > 1 ? `, делили с: ${groupChecked.filter((x) => x.id !== p.id).map((x) => x.blogger_handle).join(", ")}` : ""}.${priceNote}${familyNote}${resNote}`,
          });
        }
      }
      processed++;
    }
   } catch (e) {
    log(`[attribution] ошибка при расчёте товара ${productKey}: ${e.message}`);
    for (const p of group) {
      try {
        await writeResult(pgPool, p.id, {
          status: "compute_error",
          note: `Внутренняя ошибка расчёта для этого товара: ${String(e.message).slice(0, 400)}. Разберите вручную, остальные размещения это не затронуло.`,
        });
      } catch (e2) {
        log(`[attribution] не удалось даже записать статус ошибки для id=${p.id}: ${e2.message}`);
      }
    }
   }
  }

  log(`[attribution] готово, обработано размещений: ${processed}`);
  return { processed };
}

module.exports = { runDailyAttribution, almatyTodayStr, addDaysStr };
