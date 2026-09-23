// ============================================================================
// attribution.js — автоматический расчёт "вклада в продажи" для интеграций
// блогеров, на основе продаж Kaspi (analytics.v_kaspi_placed_sku в Supabase).
//
// Формализует то, что делалось вручную в чате: порог по охвату, окно
// атрибуции (день публикации + день после), деление пересекающихся дней по
// охвату, проверка на скачки/дрейф цены, обработка новых товаров без
// истории (база = 0), отказ от расчёта при битом/несуществующем ШК вместо
// угадывания.
//
// Результат пишется в НОВЫЕ колонки public.influencer_placements
// (auto_contribution_*, см. 01_migration.sql) — существующее поле
// "вклад в продажи", которое менеджеры заполняют вручную, не трогается.
//
// Запускается РАЗ В СУТКИ (см. integration-snippet.js) для двух последних
// уже полностью закрытых окон публикации — чтобы не считать по неполному
// дню и один раз переподтвердить предыдущий день (в Kaspi отмены/статусы
// заказов ещё немного "оседают" в течение суток).
// ============================================================================

const REACH_MIN = 10000;                // порог охвата для малых/микро блогеров
const BASELINE_DAYS = 7;                 // сколько дней брать под базу перед окном
const SKU_STALE_DAYS = 14;               // если по ШК нет продаж дольше этого — код считаем битым
const PRICE_DRIFT_TOLERANCE = 0.03;      // >3% разброса цены в периоде — не считаем, слишком рискованно
const NAME_MATCH_MIN_SHARED_WORDS = 1;   // минимум общих значимых слов между sku_name и названием в Kaspi

// ---------------------------------------------------------------------------
// Даты. Почему через to_char, а не через Date из pg: колонки типа `date` при
// чтении в JS легко ловят сдвиг на день туда-сюда из-за таймзоны драйвера.
// Работаем со строками 'YYYY-MM-DD', которые Postgres формирует сам —
// однозначно, без клиентской интерпретации.
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
// Основная функция. Вызывать раз в сутки.
// ---------------------------------------------------------------------------
async function runDailyAttribution(pgPool, { log = console.log } = {}) {
  const today = almatyTodayStr();
  // Окно публикации D закрывается на дату D+1. Чтобы окно было полностью
  // закрыто на момент расчёта, публикация должна быть не позже today-2.
  // Пересчитываем два последних таких дня (сегодня и вчера относительно
  // "закрытия") — свежее плюс один повторный проход, т.к. статусы заказов
  // в Kaspi ещё немного меняются в первые сутки после окна.
  const targetPublishDates = [addDaysStr(today, -2), addDaysStr(today, -3)];

  log(`[attribution] запуск на ${today}, публикации от ${targetPublishDates.join(" и ")}`);

  const { rows: placements } = await pgPool.query(
    `SELECT id, tier, reach, kaspi_code, sku_name, published_date::text AS published_date, manager, blogger_handle
     FROM public.influencer_placements
     WHERE status = 'published'
       AND published_date::date = ANY($1::date[])`,
    [targetPublishDates]
  );

  if (placements.length === 0) {
    log("[attribution] нет опубликованных размещений на эти даты — нечего считать");
    return { processed: 0 };
  }

  const eligible = [];
  for (const p of placements) {
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
  }

  const byCode = groupBy(eligible, (p) => p.kaspi_code);
  let processed = 0;

  for (const [code, group] of byCode) {
    const pubDates = group.map((p) => p.published_date);
    const earliestPub = pubDates.reduce((a, b) => (a < b ? a : b));
    const latestPub = pubDates.reduce((a, b) => (a > b ? a : b));
    const baselineStart = addDaysStr(earliestPub, -BASELINE_DAYS);
    const baselineEnd = addDaysStr(earliestPub, -1);
    const windowEnd = addDaysStr(latestPub, 1);
    const staleCutoff = addDaysStr(today, -SKU_STALE_DAYS);

    // Продажи, с реальными датами (order_date уже как есть, без клиентской
    // конвертации таймзоны — берём текстом).
    const { rows: history } = await pgPool.query(
      `SELECT order_date::text AS d, shtuk, cena, tovar
       FROM analytics.v_kaspi_placed_sku
       WHERE offer_code = $1 AND order_date BETWEEN $2::date AND $3::date
       ORDER BY order_date`,
      [code, baselineStart, windowEnd]
    );

    const { rows: recentCheck } = await pgPool.query(
      `SELECT count(*)::int AS n
       FROM analytics.v_kaspi_placed_sku
       WHERE offer_code = $1 AND order_date >= $2::date`,
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

    // Проверка на дрейф/скачок цены в интересующем периоде — не гадаем.
    const prices = history.map((r) => Number(r.cena)).filter((v) => v > 0);
    if (prices.length > 0) {
      const priceRange = (Math.max(...prices) - Math.min(...prices)) / Math.min(...prices);
      if (priceRange > PRICE_DRIFT_TOLERANCE) {
        for (const p of group) {
          await writeResult(pgPool, p.id, {
            status: "unconfident_price",
            note: `Цена по ШК ${code} нестабильна в период ${baselineStart}–${windowEnd} (от ${Math.min(...prices)} до ${Math.max(...prices)} ₸) — прирост в штуках/деньгах может быть от цены, а не от блогера. Не считаем.`,
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

    // База: среднее по дням baselineStart..baselineEnd, где есть данные.
    // Если данных в базовом периоде нет вообще, а в окне есть — это новый
    // товар без истории, база = 0 (не отказываемся считать).
    const byDate = new Map(history.map((r) => [r.d, { shtuk: Number(r.shtuk), cena: Number(r.cena) }]));
    const baselineVals = [];
    for (let d = baselineStart; d <= baselineEnd; d = addDaysStr(d, 1)) {
      if (byDate.has(d)) baselineVals.push(byDate.get(d).shtuk);
    }
    const baselineAvg = baselineVals.length
      ? baselineVals.reduce((a, b) => a + b, 0) / baselineVals.length
      : 0;

    // Прирост по каждому дню окна, floor на 0 (отрицательное не приписываем).
    const dayIncrement = new Map(); // date -> {units, kzt}
    for (let d = earliestPub; d <= windowEnd; d = addDaysStr(d, 1)) {
      const rec = byDate.get(d);
      const actualUnits = rec ? rec.shtuk : 0;
      const price = rec ? rec.cena : prices[prices.length - 1] || 0;
      const incUnits = Math.max(0, actualUnits - baselineAvg);
      dayIncrement.set(d, { units: incUnits, kzt: incUnits * price });
    }

    // Делим каждый день окна между теми, чьё окно (публикация + день после)
    // его покрывает, пропорционально охвату.
    const totals = new Map(groupChecked.map((p) => [p.id, { units: 0, kzt: 0, missingReachDays: 0, sharedWith: new Set() }]));

    for (let d = earliestPub; d <= windowEnd; d = addDaysStr(d, 1)) {
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
        await writeResult(pgPool, p.id, {
          status: units > 0 ? "ok" : "zero",
          units,
          kzt,
          note: `База ${baselineAvg.toFixed(1)} шт/день (${baselineStart}–${baselineEnd}), окно ${p.published_date}–${addDaysStr(p.published_date, 1)}${groupChecked.length > 1 ? `, делили с: ${groupChecked.filter((x) => x.id !== p.id).map((x) => x.blogger_handle).join(", ")}` : ""}.`,
        });
      }
      processed++;
    }
  }

  log(`[attribution] готово, обработано размещений: ${processed}`);
  return { processed };
}

module.exports = { runDailyAttribution, almatyTodayStr, addDaysStr };
