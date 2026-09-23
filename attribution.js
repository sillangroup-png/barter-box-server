// ============================================================================
// attribution.js — автоматический расчёт "вклада в продажи" для интеграций
// блогеров, на основе продаж Kaspi (analytics.v_kaspi_placed_sku в Supabase).
//
// v2. Что изменилось относительно первой версии и почему:
//
// 1) БАЗА ТЕПЕРЬ "СКОЛЬЗЯЩАЯ И ЧИСТАЯ", а не "7 календарных дней перед публикацией".
//    Раньше: если перед выкладкой шла активная реклама (несколько блогеров подряд),
//    эти дни всё равно попадали в базу как "обычный уровень" — база завышалась, и
//    блогер, который выкладывался в затишье ПОСЛЕ такой кампании, выглядел так,
//    будто ничего не добавил (реальные продажи оказывались НИЖЕ вот этой вздутой
//    базы). Теперь база каждого дня — среднее по последним BASELINE_DAYS дням,
//    которые (а) есть в истории продаж и (б) не попадают в окно [публикация;
//    публикация+1] НИ ОДНОГО размещения по этому ШК (не только из текущей пачки —
//    вообще любого, даже отсеянного по охвату: реклама была, база всё равно грязная).
//    Ищем такие дни, отступая назад до BASELINE_LOOKBACK_DAYS — если кампания шла
//    несколько недель подряд, база возьмётся из последнего действительно чистого
//    периода перед ней, а не из хвоста кампании. У некоторых товаров (например,
//    Коллаген+Биотин) реклама идёт настолько плотно, что чистых дней в пределах
//    BASELINE_LOOKBACK_DAYS может не найтись вообще — база тогда 0, и это НЕ
//    прячем как уверенный ноль: если чистых дней нашлось меньше MIN_CLEAN_DAYS_TRUST,
//    статус получается "baseline_uncertain", а не "ok"/"zero" — число может быть
//    занижено или завышено, доверять ему нельзя, это честно написано в заметке.
//
// 2) ОДИН ПРОХОД СЧИТАЕТ И "СВЕЖЕЕ" ОКНО, И ВЕСЬ БЭКЛОГ.
//    Раньше runDailyAttribution всегда брал только today-2/today-3 — размещения
//    старше этого НИКОГДА не досчитывались (весь сентябрь и более ранние месяцы
//    так и остались бы "ещё не считалось" навсегда). Теперь в один проход берём
//    today-2/today-3 (пересчитываем всегда, т.к. статусы заказов в Kaspi ещё
//    "оседают" в первые сутки) ПЛЮС любые ещё не посчитанные публикации любой
//    давности (auto_contribution_status IS NULL) — так бэклог убирается сам,
//    без отдельного скрипта. Группы по ШК обрабатываются в порядке "сначала
//    самые свежие публикации" — если процесс не успеет за один тик, сентябрь
//    досчитается раньше июня.
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
const PRICE_DRIFT_TOLERANCE = 0.03;      // >3% разброса цены — не считаем, слишком рискованно
const NAME_MATCH_MIN_SHARED_WORDS = 1;   // минимум общих значимых слов между sku_name и названием в Kaspi

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
function nameLooksRelated(skuName, kaspiTovar) {
  const a = new Set(normalizeWords(skuName));
  const b = new Set(normalizeWords(kaspiTovar));
  if (a.size === 0 || b.size === 0) return true; // нечего сравнивать — не блокируем
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared >= NAME_MATCH_MIN_SHARED_WORDS;
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
    // Та же защита, что и ниже для групп по ШК: одна кривая запись не должна ронять
    // весь проход — фиксируем и идём дальше.
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

  const byCode = groupBy(eligible, (p) => p.kaspi_code);

  // Сначала группы, где есть хотя бы одна свежая (последний месяц данных) публикация —
  // чтобы если процесс прервётся или не успеет за один тик, недавние месяцы (сейчас
  // это сентябрь) досчитались раньше, чем старый бэклог с июня.
  const codeEntries = [...byCode.entries()].sort((a, b) => {
    const maxA = a[1].reduce((m, p) => (p.published_date > m ? p.published_date : m), "");
    const maxB = b[1].reduce((m, p) => (p.published_date > m ? p.published_date : m), "");
    return maxB.localeCompare(maxA); // по убыванию даты — свежие сначала
  });

  let processed = 0;
  const staleCutoff = addDaysStr(today, -SKU_STALE_DAYS);

  for (const [code, group] of codeEntries) {
   try {
    // Всё тело обработки одной группы (один ШК) — в try/catch. Если в данных по
    // этому конкретному товару окажется что-то, чего мы не предусмотрели (кривая
    // дата, неожиданный формат и т.п.) — падать должна только ЭТА группа, а не
    // весь суточный расчёт целиком (см. историю: одна запись без даты публикации
    // обрушивала вообще всё, и прогресс стоял на месте много часов).
    const pubDates = group.map((p) => p.published_date);
    const minTarget = pubDates.reduce((a, b) => (a < b ? a : b));
    const maxTarget = pubDates.reduce((a, b) => (a > b ? a : b));
    const windowEnd = addDaysStr(maxTarget, 1);
    const historyStart = addDaysStr(minTarget, -BASELINE_LOOKBACK_DAYS);

    const { rows: recentCheck } = await pgPool.query(
      `SELECT count(*)::int AS n FROM analytics.v_kaspi_placed_sku WHERE offer_code = $1 AND order_date >= $2::date`,
      [code, staleCutoff]
    );
    if (recentCheck[0].n === 0) {
      for (const p of group) {
        await writeResult(pgPool, p.id, {
          status: "no_sku_data",
          note: `По ШК ${code} нет продаж в Kaspi за последние ${SKU_STALE_DAYS} дн. Похоже, код битый/старый — проверьте вручную (см. историю: так было со "скульптор 01/02").`,
        });
      }
      continue;
    }

    // Продажи для базы (с большим запасом назад) и для окна.
    const { rows: history } = await pgPool.query(
      `SELECT order_date::text AS d, shtuk, cena, tovar
       FROM analytics.v_kaspi_placed_sku
       WHERE offer_code = $1 AND order_date BETWEEN $2::date AND $3::date
       ORDER BY order_date`,
      [code, historyStart, windowEnd]
    );
    const byDate = new Map(history.map((r) => [r.d, { shtuk: Number(r.shtuk), cena: Number(r.cena) }]));

    // Календарь "занятых" дней по этому ШК — ЛЮБОЕ опубликованное размещение
    // (даже отсеянное по охвату: реклама всё равно была, база рядом с ней грязная),
    // не только те, что попали в текущую пачку на пересчёт.
    const { rows: allCodePlacements } = await pgPool.query(
      `SELECT published_date::text AS d FROM public.influencer_placements
       WHERE kaspi_code = $1 AND status = 'published'`,
      [code]
    );
    const occupied = new Set();
    allCodePlacements.forEach((p) => {
      occupied.add(p.d);
      occupied.add(addDaysStr(p.d, 1));
    });

    // База дня D = среднее по последним BASELINE_DAYS чистым (не занятым и с
    // данными) дням строго до D, отступая назад до BASELINE_LOOKBACK_DAYS.
    // Не нашли ни одного чистого дня в разумных пределах — база 0 (новый товар
    // без истории до старта рекламы либо реклама идёт непрерывно давно).
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

    // Проверка на дрейф/скачок цены — только по реально использованным точкам
    // (чистые дни, откуда взята база, и дни окна), а не по всему календарю между
    // ними — иначе случайная старая смена цены за пределами реального расчёта
    // блокировала бы то, что она не должна блокировать.
    const usedPriceDates = new Set();
    for (let d = minTarget; d <= windowEnd; d = addDaysStr(d, 1)) usedPriceDates.add(d);
    for (const [d] of byDate) if (d >= historyStart && d <= windowEnd && !occupied.has(d)) usedPriceDates.add(d);
    const pricesUsed = [...usedPriceDates]
      .map((d) => (byDate.has(d) ? Number(byDate.get(d).cena) : null))
      .filter((v) => v > 0);
    if (pricesUsed.length) {
      const priceRange = (Math.max(...pricesUsed) - Math.min(...pricesUsed)) / Math.min(...pricesUsed);
      if (priceRange > PRICE_DRIFT_TOLERANCE) {
        for (const p of group) {
          await writeResult(pgPool, p.id, {
            status: "unconfident_price",
            note: `Цена по ШК ${code} нестабильна в использованных для расчёта днях (от ${Math.min(...pricesUsed)} до ${Math.max(...pricesUsed)} ₸) — прирост в штуках/деньгах может быть от цены, а не от блогера. Не считаем.`,
          });
        }
        continue;
      }
    }

    // Название в Kaspi для сверки с sku_name из barter-box
    const kaspiTovar = history.length ? history[history.length - 1].tovar : "";
    const groupChecked = [];
    for (const p of group) {
      if (!nameLooksRelated(p.sku_name, kaspiTovar)) {
        await writeResult(pgPool, p.id, {
          status: "name_mismatch",
          note: `Название в barter-box ("${p.sku_name}") не похоже на товар по ШК ${code} в Kaspi ("${kaspiTovar}"). Похоже на опечатку в ШК (см. историю: так было с bota.kasss) — проверьте вручную.`,
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
    // покрывает, пропорционально охвату — как и раньше, без изменений.
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
      if (t.missingReachDays > 0) {
        await writeResult(pgPool, p.id, {
          status: "needs_reach_data",
          units: Math.round(t.units * 100) / 100,
          kzt: Math.round(t.kzt),
          note: `Охват не заполнен, а в ${t.missingReachDays} дн. окна тот же товар публиковали ещё: ${[...t.sharedWith].join(", ") || "—"}. Без охвата долю не разделить — заполните охват и пересчитается. Частично посчитанное (дни, где делить было не с кем): ${Math.round(t.units * 100) / 100} шт / ${Math.round(t.kzt)} ₸.`,
        });
      } else {
        const units = Math.round(t.units * 100) / 100;
        const kzt = Math.round(t.kzt);
        // Доверяем базе, только если на КАЖДЫЙ день окна этого размещения (публикация
        // + день после) нашлось достаточно чистых дней. Если реклама по товару идёт
        // настолько плотно, что чистых дней почти нет (см. Коллаген+Биотин) — база
        // может быть занижена (или вовсе 0), и число, посчитанное на ней, не заслуживает
        // доверия наравне с обычным "ok". Не гадаем — помечаем отдельным статусом.
        const windowDates = [p.published_date, addDaysStr(p.published_date, 1)];
        const minCleanInWindow = Math.min(...windowDates.map((d) => baselineByDate.get(d).cleanCount));
        const base = baselineByDate.get(p.published_date);
        if (minCleanInWindow < MIN_CLEAN_DAYS_TRUST) {
          await writeResult(pgPool, p.id, {
            status: "baseline_uncertain",
            units,
            kzt,
            note: `По этому ШК почти нет "чистых" дней без чужой рекламы за последние ${BASELINE_LOOKBACK_DAYS} дн. (нашлось только ${minCleanInWindow} из ${BASELINE_DAYS} нужных) — база ${base.value.toFixed(1)} шт/день ненадёжна, число ${units} шт / ${kzt} ₸ может быть занижено или завышено. Проверьте вручную.`,
          });
        } else {
          await writeResult(pgPool, p.id, {
            status: units > 0 ? "ok" : "zero",
            units,
            kzt,
            note: `База ${base.value.toFixed(1)} шт/день (скользящая, по ${base.cleanCount} чистым дням без рекламы по этому ШК), окно ${p.published_date}–${addDaysStr(p.published_date, 1)}${groupChecked.length > 1 ? `, делили с: ${groupChecked.filter((x) => x.id !== p.id).map((x) => x.blogger_handle).join(", ")}` : ""}.`,
          });
        }
      }
      processed++;
    }
   } catch (e) {
    // Эта конкретная группа (ШК) не посчиталась — фиксируем причину по каждой её
    // записи и идём дальше, к следующему товару. Остальной расчёт не страдает.
    log(`[attribution] ошибка при расчёте ШК ${code}: ${e.message}`);
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
