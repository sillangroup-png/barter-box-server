// ============================================================================
// attribution.js — автоматический расчёт "вклада в продажи" для интеграций
// блогеров, на основе продаж Kaspi. Результат пишется в СУЩЕСТВУЮЩИЕ колонки
// public.influencer_placements (auto_contribution_units/kzt/status/note/
// computed_at) — новых колонок нет и не будет, по прямому требованию.
// Существующее поле "вклад в продажи" (ручной ввод менеджера) не трогается.
//
// v4.1 (2026-09-30, доп. правка тем же днём). Проверка v4 на соответствие ТЗ выявила
// один реальный пробел, не про методику: полные (order-level) возвраты не исключались
// из денег/штук — заказ с зафиксированным возвратом (kaspi_order_sync_state.
// return_recorded) считался как обычная продажа. Добавлено: JOIN на
// kaspi_order_sync_state и исключение заказов с return_recorded=true из ВСЕХ трёх
// запросов к kaspi_live_order_entries (проверка "жив ли код", проверка "есть ли
// недавние продажи", основной запрос истории по дням). На дату проверки это 277 из
// ~110 тыс. заказов — не пересчитывает методику, но убирает конкретную известную
// неточность. Частичные возвраты (по конкретному ШК внутри заказа) по-прежнему не
// отделить — этого уровня детализации в источнике нет (см. ограничения в конце файла,
// пункт про частичные возвраты — не снят).
//
// v4 (2026-09-30). Полностью переписана методика начисления по регламенту,
// присланному вручную (см. PARAMS_VERSION ниже — версия зашита в каждую
// заметку, т.к. отдельной колонки под неё нет). Коротко, что изменилось:
//
// 1) ОКНО D0–D2 (было D0–D1). Три календарных дня начиная с ФАКТИЧЕСКОЙ даты
//    публикации: день выхода + два следующих. Раньше был всего день выхода +
//    один следующий.
//
// 2) ЗАТУХАЮЩИЕ ВЕСА ПО ДАВНОСТИ вместо чистого деления по охвату. Вес участия
//    конкретного размещения в конкретный день = его охват × коэффициент
//    давности (0.60 / 0.30 / 0.10 для D0/D1/D2 этого размещения). Раньше день
//    делился только пропорционально охвату, без разницы D0 это или D1.
//
// 3) ОТМЕНЁННЫЕ ЗАКАЗЫ ИСКЛЮЧЕНЫ ИЗ РАСЧЁТА. Раньше источником фактических
//    продаж была analytics.v_kaspi_placed_sku — проверка её определения
//    показала, что сумма/штуки там считаются БЕЗ фильтра по статусу заказа,
//    то есть отменённые (CANCELLED/CANCELLING) заказы были внутри. За
//    последние 30 дней это ~6.7% строк — не мелочь. Теперь деньги и штуки
//    считаются напрямую из analytics.kaspi_live_order_entries с явным
//    исключением статусов CANCELLED/CANCELLING. Доп. (v4.1): заказы с
//    зафиксированным возвратом (kaspi_order_sync_state.return_recorded=true)
//    тоже исключены полностью — частичные возвраты внутри заказа по-прежнему
//    не выделить, данных по сумме/штукам возврата на уровне ШК нет нигде.
//
// 4) ОКНО МОЖЕТ БЫТЬ ОТКРЫТО / ДАННЫЕ МОГУТ БЫТЬ НЕ ЗАГРУЖЕНЫ. Новые статусы
//    window_open (D2 этого размещения ещё не наступил календарно) и
//    kaspi_data_pending (D2 уже наступил, но синк Kaspi по last_order_date
//    ещё не дошёл до этой даты). Раньше при неполном окне просто считали по
//    тому, что было, и могли выдать финальный "0 ₸" до того, как окно вообще
//    закрылось.
//
// 5) СПРАВОЧНИК СООТВЕТСТВИЙ ДЛЯ МЁРТВЫХ ШК. Раньше был только собственный
//    эвристический подбор по совпадению слов с живым каталогом Kaspi. Теперь
//    ПЕРВЫМ делом проверяется реальный, курируемый справочник
//    public.product_aliases (старая карточка → новая, ~245 проверенных пар,
//    там же и наш случай LashLust: id 11 → SKUA000932200) — он надёжнее
//    собственной эвристики. Она остаётся как запасной вариант, если в
//    справочнике совпадения нет.
//
// 6) СХЛОПЫВАНИЕ ОДНОЙ ИНТЕГРАЦИИ, ЕСЛИ ОНА СЛУЧАЙНО ПОПАЛА И В КРУПНЫХ, И В
//    МИКРО/СРЕДНИХ. Если в одной товарной группе несколько строк указывают
//    одного и того же блогера (по нормализованному логину) в одну и ту же
//    дату публикации — это один и тот же реальный выход, а не два разных.
//    Для расчёта долей он учитывается ОДИН раз (максимальный охват среди
//    дублей), а итоговая сумма пишется КАЖДОЙ из дублирующихся строк целиком
//    (не делится пополам) — иначе в одной вкладке сумма выглядела бы
//    заниженной вдвое без причины.
//
// 7) ПОРОГ РАЗБРОСА ЦЕНЫ ужесточён с 3% до 1.5% (правило analytics_rules
//    analysis-01: рядом с любым движением продаж проверять цену). Дополнительно
//    сравнивается не только разброс ВНУТРИ периода расчёта, а и цена периода
//    рекламы против цены базового периода — если разница за порогом, статус
//    понижается до "недостаточно данных для оценки", а не тихо подмешивается
//    в заметку.
//
// 8) ПОРОГ ПРАВДОПОДОБИЯ (₸ на 1000 охвата) НЕ ВВЕДЁН КАК ЖЁСТКИЙ ФИЛЬТР —
//    осознанно. У нас нет проверенной исторической выборки, на которой можно
//    честно откалибровать такой порог, а по регламенту его нельзя обучать на
//    тех же неподтверждённых расчётах, которые он должен проверять. Вместо
//    этого показатель "₸ на 1000 охвата" просто попадает в заметку для ручной
//    проверки — ничего не режется и не обнуляется автоматически.
//
// 9) СЕМЬИ ТОВАРОВ И РУЧНОЙ MULTI-SKU (из v3) — без изменений по сути, см.
//    FAMILY_CODES и splitCodes ниже.
//
// ВАЖНОЕ ОГРАНИЧЕНИЕ, НЕ РЕШЁННОЕ В ЭТОЙ ВЕРСИИ (честно, а не молчанием):
// в аналитической базе уже есть ОТДЕЛЬНЫЙ, официальный регламент атрибуции
// маркетинга (analytics.analytics_rules, id=attr-01, "регламент v1 от
// 23.09.2026"): скользящая 28-дневная лог-база по КАТЕГОРИИ, окно 5 дней с
// РАВНЫМИ весами, кластеризация пересекающихся размещений — и он прямым
// текстом называет "вклад в продажи" Barter Box НЕВЕРНЫМ способом (пример:
// Barter Box показал ROI 1.94 при реальном ~0.96). Эта версия НЕ реализует
// ту, другую методику — она реализует ИМЕННО то, что описано в присланном
// техзадании (окно D0–D2, веса 0.60/0.30/0.10, база по SKU, а не по
// категории). Это два разных документа с разными числами. Какую методику
// считать источником истины для этой колонки — решение не техническое,
// стоит сверить с attr-01 отдельно.
//
// Также не реализовано (данных недостаточно, чтобы делать честно):
// - точное время публикации/заказа (barter-box хранит только дату, не время;
//   Kaspi даёт реальное время заказа через kaspi_order_sync_state.creation_at,
//   но состыковать его с датой ВЫХОДА нечем, раз даты публикации без времени);
// - частичные возвраты на уровне конкретного SKU (order-level флаг
//   return_recorded теперь ИСКЛЮЧАЕТ такой заказ из расчёта целиком, см. п.3
//   выше и v4.1 в самом верху файла, — но выделить ЧАСТЬ заказа, относящуюся
//   именно к возвращённой позиции, по-прежнему нечем: суммы/количества
//   возврата на уровне конкретного ШК в источнике нет);
// - учёт "дней снижения" в сводном отчёте — эта версия считает P=max(0,D) по
//   каждому размещению отдельно, как и просили, но агрегированного отчёта
//   "прирост с учётом провалов" здесь нет и не может быть — это отдельный
//   дашборд, а добавлять новые окна интерфейса запрещено.
// ============================================================================

const REACH_MIN = 10000;                 // порог охвата для малых/микро блогеров
const BASELINE_DAYS = 7;                 // сколько ЧИСТЫХ дней брать под базу
const BASELINE_LOOKBACK_DAYS = 60;       // как далеко назад искать чистые дни для базы
const MIN_CLEAN_DAYS_TRUST = 3;          // меньше стольки чистых дней в базе — не доверяем числу
const SKU_STALE_DAYS = 14;               // если по ШК нет продаж дольше этого — код считаем битым
const PRICE_DRIFT_TOLERANCE = 0.015;     // порог из analytics_rules (analysis-01) — было 0.03
const NAME_MATCH_MIN_SHARED_WORDS = 1;   // порог для мягкой сверки (name_mismatch — предупреждение)
const AUTO_RESOLVE_MIN_SHARED_WORDS = 2; // порог для автозамены мёртвого ШК (строже — решение молчаливое)
const PARAMS_VERSION = "attrib-v4.1-2026-09-30"; // версия параметров расчёта — своей колонки нет, пишем в заметку

// Окно атрибуции: день публикации (D0) + два следующих календарных дня.
// Веса по давности — рабочие параметры модели, НЕ доказанные доли покупок
// (см. ТЗ, п.9). Индекс массива = смещение в днях от даты публикации.
const RECENCY_WEIGHTS = [0.60, 0.30, 0.10];
const WINDOW_MAX_OFFSET = RECENCY_WEIGHTS.length - 1; // 2 → D2

// Статусы, которые считаются "ожидающими" — число могло измениться с прошлого
// расчёта (заполнили охват, накопилась чистая база, обновился каталог Kaspi,
// поправили название/ШК, закрылось окно D0–D2, догрузились данные Kaspi),
// поэтому пересчитываем их каждую ночь, а не только в свежем окне после
// публикации. Ограничиваем возрастом публикации, чтобы бэклог не рос вечно.
const PENDING_RETRY_STATUSES = [
  "needs_reach_data", "baseline_uncertain", "no_sku_data", "name_mismatch",
  "window_open", "kaspi_data_pending",
];
const PENDING_RETRY_MAX_AGE_DAYS = 90;

// Семьи товаров: набор + отдельные позиции той же линейки считаются вместе.
const FAMILY_CODES = {
  biotin_family: ["2000000034256", "SKUA000787900", "SKUA000788000"], // набор, шампунь, бальзам — Коллаген+Биотин
  amino_family: ["2000000034263", "SKUA000392700", "SKUA000392900"],  // набор, шампунь, бальзам — Коллаген+Аминокислоты
};
const CODE_TO_FAMILY = {};
for (const [fam, codes] of Object.entries(FAMILY_CODES)) {
  for (const c of codes) CODE_TO_FAMILY[c] = fam;
}

// Разбирает строку с одним или несколькими кодами (ручной multi-SKU) на
// массив отдельных кодов. Разделители — запятая, плюс, точка с запятой или
// пробел, вперемешку. Один код возвращается как массив из одного элемента.
// Коды — всегда строки, начальные нули не трогаем (parseInt нигде не зовём).
function splitCodes(raw) {
  return (raw || "")
    .split(/[,+;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Даты. Через to_char/::text, а не Date из pg: колонки типа `date` при чтении
// в JS легко ловят сдвиг на день туда-сюда из-за таймзоны драйвера. Работаем
// со строками 'YYYY-MM-DD', которые Postgres формирует сам — однозначно.
// Часовой пояс — Asia/Almaty везде (правило analytics_rules time-02).
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
// Смещение дня d относительно даты публикации pubDate, ТОЛЬКО в пределах окна
// (0..WINDOW_MAX_OFFSET); вне окна — -1. Через сравнение строк, а не через
// вычитание дат, чтобы не тащить в файл ещё один способ работы с датами.
function offsetInWindow(pubDate, d) {
  for (let off = 0; off <= WINDOW_MAX_OFFSET; off++) {
    if (addDaysStr(pubDate, off) === d) return off;
  }
  return -1;
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
// Логин блогера к канонiчному виду — чтобы поймать "одна и та же интеграция
// вписана и в крупных, и в микро/средних" (см. п.6 в шапке файла). Ссылки на
// Instagram, логины с "@" и без — всё приводим к одному виду.
function normalizeHandle(h) {
  let s = (h || "").trim().toLowerCase();
  s = s.replace(/^https?:\/\/(www\.)?(instagram\.com|instagr\.am)\//, "");
  s = s.split("?")[0];
  s = s.replace(/\/+$/, "");
  s = s.replace(/^@/, "");
  return s;
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
  const pendingRetryCutoff = addDaysStr(today, -PENDING_RETRY_MAX_AGE_DAYS);

  log(`[attribution ${PARAMS_VERSION}] запуск на ${today}: свежее окно ${freshDates.join(" и ")} + весь ещё не посчитанный бэклог + ожидающие статусы (${PENDING_RETRY_STATUSES.join(", ")}) моложе ${PENDING_RETRY_MAX_AGE_DAYS} дн.`);

  // До какой даты реально загружены заказы Kaspi — нужен для "окно закрылось
  // календарно, но данных ещё нет" (kaspi_data_pending, см. п.4 в шапке).
  const { rows: healthRows } = await pgPool.query(
    `SELECT last_order_date::text AS d FROM analytics.kaspi_sync_health LIMIT 1`
  );
  const dataLoadedThrough = healthRows[0] ? healthRows[0].d : null;
  if (!dataLoadedThrough) {
    log(`[attribution] предупреждение: analytics.kaspi_sync_health пуст — не знаем, до какой даты загружены заказы; проверка "данные не загружены" отключена на этот прогон`);
  }

  const { rows: placements } = await pgPool.query(
    `SELECT id, tier, reach, kaspi_code, sku_name, published_date::text AS published_date,
            manager, blogger_handle, source
     FROM public.influencer_placements
     WHERE status = 'published'
       AND (
         published_date::date = ANY($1::date[])
         OR auto_contribution_status IS NULL
         OR (auto_contribution_status = ANY($2::text[]) AND published_date::date >= $3::date)
       )`,
    [freshDates, PENDING_RETRY_STATUSES, pendingRetryCutoff]
  );

  if (placements.length === 0) {
    log("[attribution] нечего считать — ни свежего окна, ни бэклога");
    return { processed: 0 };
  }

  const eligible = [];
  for (const p of placements) {
   try {
    if (!p.published_date) {
      await writeResult(pgPool, p.id, {
        status: "no_published_date",
        note: `Статус «опубликовано», но дата публикации не заполнена — заполните дату, тогда посчитается. [${PARAMS_VERSION}]`,
      });
      continue;
    }
    const isSmallTier = p.tier === "Малый" || p.tier === "Микро";
    if (isSmallTier && (!p.reach || p.reach < REACH_MIN)) {
      await writeResult(pgPool, p.id, {
        status: "excluded_reach",
        note: `Охват ${p.reach || 0} < ${REACH_MIN} — для малых/микро блогеров прирост не считаем. [${PARAMS_VERSION}]`,
      });
      continue;
    }
    if (!p.kaspi_code) {
      await writeResult(pgPool, p.id, { status: "no_sku_code", note: `ШК/SKU не указан в barter-box — товар не сопоставлен. [${PARAMS_VERSION}]` });
      continue;
    }
    eligible.push(p);
   } catch (e) {
    log(`[attribution] ошибка на записи id=${p.id}: ${e.message}`);
    try {
      await writeResult(pgPool, p.id, {
        status: "compute_error",
        note: `Внутренняя ошибка расчёта: ${String(e.message).slice(0, 400)}. Разберите вручную. [${PARAMS_VERSION}]`,
      });
    } catch (e2) {
      log(`[attribution] не удалось записать статус ошибки для id=${p.id}: ${e2.message}`);
    }
   }
  }
  if (eligible.length === 0) return { processed: 0 };

  // --- Справочник соответствий для мёртвых ШК: сначала проверенный, потом эвристика ---

  // 1) Курируемый справочник public.product_aliases (старая карточка → новая).
  // Не наша эвристика — реальный, поддерживаемый в аналитике список пар,
  // включая ровно наш случай LashLust (id 11 → SKUA000932200). Сопоставляем
  // по названию: старое название товара (products.name того же id, что и
  // old_product_id) против sku_name в barter-box, тем же порогом общих слов,
  // что и для мягкой сверки названий ниже.
  const { rows: aliasRows } = await pgPool.query(
    `SELECT po.name AS old_name, pn.kaspi_code AS new_kaspi_code, pn.name AS new_name
     FROM public.product_aliases pa
     JOIN public.products po ON po.id = pa.old_product_id
     JOIN public.products pn ON pn.id = pa.new_product_id
     WHERE pn.kaspi_code IS NOT NULL AND po.name IS NOT NULL`
  );

  // 2) Живой каталог Kaspi за последние SKU_STALE_DAYS — для собственной
  // эвристики, когда в справочнике совпадения не нашлось.
  const { rows: catalogRows } = await pgPool.query(
    `SELECT offer_code, tovar FROM analytics.v_kaspi_placed_sku
     WHERE order_date >= $1::date GROUP BY offer_code, tovar`,
    [staleCutoff]
  );
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
    if (CODE_TO_FAMILY[origCode]) { codeResolution.set(origCode, origCode); continue; }
    if (splitCodes(origCode).length > 1) {
      // Несколько кодов вручную в одном поле SKU — доверяем как есть.
      codeResolution.set(origCode, origCode);
      continue;
    }
    const { rows: check } = await pgPool.query(
      `SELECT count(*)::int AS n FROM analytics.kaspi_live_order_entries e
       LEFT JOIN public.kaspi_order_sync_state s ON s.order_id = e.order_id
       WHERE e.offer_code = $1 AND e.order_date >= $2::date AND e.order_status NOT IN ('CANCELLED','CANCELLING')
         AND COALESCE(s.return_recorded, false) = false`,
      [origCode, staleCutoff]
    );
    if (check[0].n > 0) { codeResolution.set(origCode, origCode); continue; } // код живой

    const bestNameCandidates = [...new Set(grp.map((p) => p.sku_name).filter(Boolean))];
    if (bestNameCandidates.length === 0) { codeResolution.set(origCode, null); continue; }

    // Сортируем по количеству значимых слов — самое подробное название надёжнее.
    const namesRanked = bestNameCandidates
      .map((name) => ({ name, words: normalizeWords(name) }))
      .filter((x) => x.words.length > 0)
      .sort((a, b) => b.words.length - a.words.length);
    if (namesRanked.length === 0) { codeResolution.set(origCode, null); continue; }
    const bestName = namesRanked[0].name;

    // Шаг 1: проверенный справочник product_aliases.
    const aliasScored = aliasRows
      .map((a) => ({ code: a.new_kaspi_code, score: sharedWordCount(bestName, a.old_name), newName: a.new_name }))
      .filter((x) => x.score >= AUTO_RESOLVE_MIN_SHARED_WORDS);
    aliasScored.sort((a, b) => b.score - a.score);
    if (aliasScored.length === 1 || (aliasScored.length > 1 && aliasScored[0].score > aliasScored[1].score)) {
      const resolved = aliasScored[0].code;
      codeResolution.set(origCode, resolved);
      resolutionNote.set(origCode, ` ШК автоматически заменён с ${origCode} на ${resolved} — по проверенному справочнику соответствий product_aliases (карточка "${bestName}" → "${aliasScored[0].newName}").`);
      log(`[attribution] авто-замена ШК по справочнику: ${origCode} → ${resolved}`);
      continue;
    }

    // Шаг 2: собственная эвристика по живому каталогу (запасной вариант).
    const threshold = Math.min(AUTO_RESOLVE_MIN_SHARED_WORDS, namesRanked[0].words.length);
    const scored = [];
    for (const c of catalogRows) {
      const score = distinctiveSharedWordCount(bestName, c.tovar);
      if (score >= threshold) scored.push({ code: c.offer_code, score });
    }
    scored.sort((a, b) => b.score - a.score);
    if (scored.length === 0) {
      codeResolution.set(origCode, null);
    } else if (scored.length === 1 || scored[0].score > scored[1].score) {
      const resolved = scored[0].code;
      codeResolution.set(origCode, resolved);
      resolutionNote.set(origCode, ` ШК автоматически заменён с ${origCode} на ${resolved} — в Kaspi товар переехал на новую карточку, название совпало (по "${bestName}").`);
      log(`[attribution] авто-замена ШК по каталогу: ${origCode} → ${resolved} (счёт ${scored[0].score} против ${scored[1] ? scored[1].score : 0} у второго места)`);
    } else {
      codeResolution.set(origCode, null); // несколько одинаково похожих — не гадаем
    }
  }

  const byCode = groupBy(eligible, (p) => {
    if (CODE_TO_FAMILY[p.kaspi_code]) return CODE_TO_FAMILY[p.kaspi_code];
    const resolved = codeResolution.get(p.kaspi_code);
    return resolved || p.kaspi_code;
  });

  const codeEntries = [...byCode.entries()].sort((a, b) => {
    const maxA = a[1].reduce((m, p) => (p.published_date > m ? p.published_date : m), "");
    const maxB = b[1].reduce((m, p) => (p.published_date > m ? p.published_date : m), "");
    return maxB.localeCompare(maxA); // свежие сначала
  });

  let processed = 0;

  for (const [productKey, group] of codeEntries) {
   try {
    const isFamily = !!FAMILY_CODES[productKey];
    const isManualMulti = !isFamily && splitCodes(productKey).length > 1;
    const rawCodes = [
      ...new Set([
        ...(FAMILY_CODES[productKey] || splitCodes(productKey)),
        ...group.flatMap((p) => splitCodes(p.kaspi_code)),
      ]),
    ];

    const pubDates = group.map((p) => p.published_date);
    const minTarget = pubDates.reduce((a, b) => (a < b ? a : b));
    const maxTarget = pubDates.reduce((a, b) => (a > b ? a : b));
    const windowEnd = addDaysStr(maxTarget, WINDOW_MAX_OFFSET);
    const historyStart = addDaysStr(minTarget, -BASELINE_LOOKBACK_DAYS);

    // "Живой ли код вообще" — без отменённых заказов и без заказов с зафиксированным
    // возвратом (kaspi_order_sync_state.return_recorded, см. п.3 в шапке файла).
    const { rows: recentCheck } = await pgPool.query(
      `SELECT count(*)::int AS n FROM analytics.kaspi_live_order_entries e
       LEFT JOIN public.kaspi_order_sync_state s ON s.order_id = e.order_id
       WHERE e.offer_code = ANY($1::text[]) AND e.order_date >= $2::date
         AND e.order_status NOT IN ('CANCELLED','CANCELLING')
         AND COALESCE(s.return_recorded, false) = false`,
      [rawCodes, staleCutoff]
    );
    if (recentCheck[0].n === 0) {
      for (const p of group) {
        await writeResult(pgPool, p.id, {
          status: "no_sku_data",
          note: `По ШК ${p.kaspi_code} нет (не отменённых) продаж в Kaspi за последние ${SKU_STALE_DAYS} дн., и заменить код автоматически не удалось (ни по справочнику product_aliases, ни по совпадению названий в каталоге) — проверьте вручную, либо впишите правильный живой код в поле SKU у товара. [${PARAMS_VERSION}]`,
        });
      }
      continue;
    }

    // Факт по дням: штуки и выручка БЕЗ отменённых/отменяемых заказов и БЕЗ заказов
    // с зафиксированным возвратом (order-level флаг kaspi_order_sync_state.return_recorded
    // — 277 из ~110 тыс. заказов на дату проверки; сумму/штуки конкретного ШК внутри
    // такого заказа система не хранит, поэтому вычесть частичный возврат точно нельзя,
    // но исключить ВЕСЬ заказ, где возврат уже зафиксирован, — можно и нужно, это не
    // придуманный коэффициент, а прямой факт из отдельной таблицы синка Kaspi).
    // LEFT JOIN + COALESCE(...,false): заказ без записи в kaspi_order_sync_state (её
    // синк может ещё не видеть) не считается возвратом по умолчанию — данные не теряем.
    // summa — сумма строки заказа с учётом скидки (total_price), не вся корзина целиком.
    const { rows: history } = await pgPool.query(
      `SELECT e.order_date::text AS d, SUM(e.quantity) AS shtuk, SUM(e.total_price) AS revenue
       FROM analytics.kaspi_live_order_entries e
       LEFT JOIN public.kaspi_order_sync_state s ON s.order_id = e.order_id
       WHERE e.offer_code = ANY($1::text[]) AND e.order_date BETWEEN $2::date AND $3::date
         AND e.order_status NOT IN ('CANCELLED','CANCELLING')
         AND COALESCE(s.return_recorded, false) = false
       GROUP BY e.order_date ORDER BY e.order_date`,
      [rawCodes, historyStart, windowEnd]
    );
    const byDate = new Map(
      history.map((r) => {
        const shtuk = Number(r.shtuk);
        const revenue = Number(r.revenue);
        return [r.d, { shtuk, cena: shtuk > 0 ? revenue / shtuk : 0 }];
      })
    );

    const { rows: tovarRows } = await pgPool.query(
      `SELECT DISTINCT tovar FROM analytics.v_kaspi_placed_sku WHERE offer_code = ANY($1::text[]) AND order_date >= $2::date`,
      [rawCodes, historyStart]
    );
    const kaspiTovars = tovarRows.map((r) => r.tovar).filter(Boolean);

    // Календарь "занятых" дней — публикация + D0..D2, ЛЮБОЕ опубликованное
    // размещение с одним из rawCodes (даже отсеянное по охвату — реклама всё
    // равно была, база рядом с ней грязная). kaspi_code может хранить
    // НЕСКОЛЬКО кодов через запятую — сравниваем разобранный массив.
    const { rows: allCodePlacements } = await pgPool.query(
      `SELECT published_date::text AS d FROM public.influencer_placements
       WHERE status = 'published' AND published_date IS NOT NULL
         AND regexp_split_to_array(trim(kaspi_code), '[,+;\\s]+') && $1::text[]`,
      [rawCodes]
    );
    const occupied = new Set();
    allCodePlacements.forEach((p) => {
      for (let off = 0; off <= WINDOW_MAX_OFFSET; off++) occupied.add(addDaysStr(p.d, off));
    });

    // База дня D = среднее по последним BASELINE_DAYS чистым (не занятым и с
    // данными) дням строго до D, отступая назад до BASELINE_LOOKBACK_DAYS.
    // Заодно запоминаем среднюю цену этих же чистых дней — нужна для сверки
    // цены базового периода против периода рекламы (analytics_rules analysis-01).
    function cleanBaselineFor(dateD) {
      const vals = [];
      const prices = [];
      let cursor = addDaysStr(dateD, -1);
      for (let steps = 0; steps < BASELINE_LOOKBACK_DAYS && vals.length < BASELINE_DAYS; steps++) {
        if (!occupied.has(cursor) && byDate.has(cursor)) {
          vals.push(byDate.get(cursor).shtuk);
          if (byDate.get(cursor).cena > 0) prices.push(byDate.get(cursor).cena);
        }
        cursor = addDaysStr(cursor, -1);
      }
      return {
        value: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0,
        cleanCount: vals.length,
        avgPrice: prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null,
      };
    }

    const baselineByDate = new Map();
    for (let d = minTarget; d <= windowEnd; d = addDaysStr(d, 1)) baselineByDate.set(d, cleanBaselineFor(d));

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
        priceNote = ` Цена в этот период менялась (от ${priceMin} до ${priceMax} ₸, порог сверки ${(PRICE_DRIFT_TOLERANCE * 100).toFixed(1)}%) — ₸ посчитаны по факту цены каждого дня, штуки цена не затрагивает.`;
      }
    }

    const familyNote = isFamily
      ? ` Считалось суммарно по всей линейке (набор + отдельные шампунь/бальзам): ${FAMILY_CODES[productKey].join(", ")}.`
      : isManualMulti
      ? ` Считалось суммарно по нескольким SKU, вписанным вручную в одно поле: ${rawCodes.join(", ")}.`
      : "";

    // Сверка названия — мягкая, только предупреждение (не блокирует).
    const groupChecked = [];
    for (const p of group) {
      const related = kaspiTovars.length === 0 || kaspiTovars.some((t) => nameLooksRelated(p.sku_name, t));
      if (!related) {
        await writeResult(pgPool, p.id, {
          status: "name_mismatch",
          note: `Название в barter-box ("${p.sku_name}") не похоже ни на одно название товара по ШК ${p.kaspi_code} в Kaspi (${kaspiTovars.slice(0, 3).map((t) => `"${t}"`).join(", ")}). Проверьте вручную.${resolutionNote.get(p.kaspi_code) || ""} [${PARAMS_VERSION}]`,
        });
        continue;
      }
      groupChecked.push(p);
    }
    if (groupChecked.length === 0) continue;

    // Схлопывание одной и той же интеграции, попавшей в разные вкладки
    // (см. п.6 в шапке файла): по нормализованному логину + дате публикации.
    // Для расчёта долей кластер — один участник (макс. охват среди дублей),
    // итог пишется КАЖДОМУ участнику кластера целиком, не делится.
    const clusterKeyOf = (p) => `${normalizeHandle(p.blogger_handle)}|${p.published_date}`;
    const clustersMap = groupBy(groupChecked, clusterKeyOf);
    const clusters = [...clustersMap.entries()].map(([key, members]) => {
      const reaches = members.map((m) => m.reach).filter((r) => r && r > 0);
      return {
        key,
        members,
        published_date: members[0].published_date,
        blogger_handle: members[0].blogger_handle,
        reach: reaches.length ? Math.max(...reaches) : (members[0].reach || 0),
      };
    });

    // Прирост по каждому дню окна: факт минус СВОЯ база этого дня, floor на 0.
    // D = S - B хранится со знаком нигде отдельно не нужен на уровне записи
    // (нет колонки под него) — но floor на P = max(0, D) применяем только тут,
    // при распределении, как и просит ТЗ (п.8): отрицательные дни просто не
    // добавляют вклада, а не "занимают" его у соседних дней.
    const dayIncrement = new Map();
    for (let d = minTarget; d <= windowEnd; d = addDaysStr(d, 1)) {
      const rec = byDate.get(d);
      const actualUnits = rec ? rec.shtuk : 0;
      const price = rec ? rec.cena : pricesUsed[pricesUsed.length - 1] || 0;
      const base = baselineByDate.get(d).value;
      const incUnits = Math.max(0, actualUnits - base);
      dayIncrement.set(d, { units: incUnits, kzt: incUnits * price });
    }

    // Распределение между кластерами: вес = охват × коэффициент давности
    // (см. RECENCY_WEIGHTS). Доли не округляем до итога — округляем только
    // финальную сумму по каждому участнику (п.9 ТЗ).
    const totals = new Map(clusters.map((c) => [c.key, { units: 0, kzt: 0, missingReachDays: 0, sharedWith: new Set() }]));

    for (let d = minTarget; d <= windowEnd; d = addDaysStr(d, 1)) {
      const participants = clusters
        .map((c) => ({ c, offset: offsetInWindow(c.published_date, d) }))
        .filter((x) => x.offset !== -1);
      if (participants.length === 0) continue;
      const inc = dayIncrement.get(d) || { units: 0, kzt: 0 };
      if (inc.units === 0) continue;

      if (participants.length === 1) {
        const t = totals.get(participants[0].c.key);
        t.units += inc.units;
        t.kzt += inc.kzt;
        continue;
      }

      const withReach = participants.filter((x) => x.c.reach && x.c.reach > 0);
      const withoutReach = participants.filter((x) => !x.c.reach || x.c.reach <= 0);
      for (const x of withoutReach) {
        const t = totals.get(x.c.key);
        t.missingReachDays += 1;
        for (const other of participants) if (other.c.key !== x.c.key) t.sharedWith.add(other.c.blogger_handle);
      }
      if (withReach.length === 0) continue; // делить не на что — просто ждём охват

      const weights = withReach.map((x) => ({ x, w: x.c.reach * RECENCY_WEIGHTS[x.offset] }));
      const totalWeight = weights.reduce((s, w) => s + w.w, 0);
      if (totalWeight <= 0) continue;
      for (const { x, w } of weights) {
        const share = w / totalWeight;
        const t = totals.get(x.c.key);
        t.units += inc.units * share;
        t.kzt += inc.kzt * share;
      }
    }

    for (const cluster of clusters) {
      const t = totals.get(cluster.key);
      const p0 = cluster.members[0];
      const resNote = resolutionNote.get(p0.kaspi_code) || "";
      const dupNote = cluster.members.length > 1
        ? ` Эта интеграция встретилась ${cluster.members.length} раз(а) в разных вкладках/строках (id: ${cluster.members.map((m) => m.id).join(", ")}) — учтена как ОДИН выход (по максимальному указанному охвату), сумма ниже записана каждой из строк целиком, а не поделена между ними.`
        : "";

      const windowEndForCluster = addDaysStr(cluster.published_date, WINDOW_MAX_OFFSET);
      const windowNotOverYet = today < windowEndForCluster;
      const dataNotSyncedYet = !windowNotOverYet && dataLoadedThrough && dataLoadedThrough < windowEndForCluster;

      const unitsSoFar = Math.round(t.units * 100) / 100;
      const kztSoFar = Math.round(t.kzt);
      const per1000 = cluster.reach > 0 ? Math.round((kztSoFar / (cluster.reach / 1000)) * 100) / 100 : null;
      const per1000Note = per1000 != null ? ` Для сверки на глаз: ${per1000} ₸ на 1000 охвата (порог правдоподобия не задан — нет проверенной истории, чтобы его честно откалибровать; смотрите вручную, не как автоматический отказ).` : "";

      let result;
      if (windowNotOverYet) {
        result = {
          status: "window_open",
          units: unitsSoFar, kzt: kztSoFar,
          note: `Окно D0–D2 ещё не закончилось (закроется ${windowEndForCluster}) — результат предварительный, посчитано по факту на сегодня (${unitsSoFar} шт / ${kztSoFar} ₸), пересчитается автоматически.${familyNote}${resNote}${dupNote}`,
        };
      } else if (dataNotSyncedYet) {
        result = {
          status: "kaspi_data_pending",
          units: unitsSoFar, kzt: kztSoFar,
          note: `Окно D0–D2 закрылось ${windowEndForCluster}, но заказы Kaspi загружены только по ${dataLoadedThrough} — данные периода ещё не полные, результат предварительный (${unitsSoFar} шт / ${kztSoFar} ₸), пересчитается, когда синк догонит.${familyNote}${resNote}${dupNote}`,
        };
      } else if (t.missingReachDays > 0) {
        result = {
          status: "needs_reach_data",
          units: unitsSoFar, kzt: kztSoFar,
          note: `Охват не заполнен, а в ${t.missingReachDays} дн. окна тот же товар публиковали ещё: ${[...t.sharedWith].join(", ") || "—"}. Без охвата долю не разделить — заполните охват и пересчитается. Частично посчитанное (дни, где делить было не с кем): ${unitsSoFar} шт / ${kztSoFar} ₸.${familyNote}${resNote}${dupNote}`,
        };
      } else {
        const windowDates = [];
        for (let off = 0; off <= WINDOW_MAX_OFFSET; off++) windowDates.push(addDaysStr(cluster.published_date, off));
        const minCleanInWindow = Math.min(...windowDates.map((d) => baselineByDate.get(d).cleanCount));
        const base = baselineByDate.get(cluster.published_date);

        // Цена периода рекламы против цены базового периода (analysis-01):
        // если баланс сравнения даже отдалённо нельзя доверять из-за смены
        // цены — не выдаём уверенный "ok", понижаем до "недостаточно данных".
        const windowPrices = windowDates.map((d) => (byDate.has(d) ? byDate.get(d).cena : null)).filter((v) => v > 0);
        const avgWindowPrice = windowPrices.length ? windowPrices.reduce((a, b) => a + b, 0) / windowPrices.length : null;
        let priceDriftVsBaseline = null;
        if (avgWindowPrice != null && base.avgPrice != null && base.avgPrice > 0) {
          priceDriftVsBaseline = (avgWindowPrice - base.avgPrice) / base.avgPrice;
        }
        const priceMovedNearby = priceDriftVsBaseline != null && Math.abs(priceDriftVsBaseline) > PRICE_DRIFT_TOLERANCE;

        if (minCleanInWindow < MIN_CLEAN_DAYS_TRUST || priceMovedNearby) {
          const reasons = [];
          if (minCleanInWindow < MIN_CLEAN_DAYS_TRUST) reasons.push(`почти нет "чистых" дней без чужой рекламы за последние ${BASELINE_LOOKBACK_DAYS} дн. (нашлось только ${minCleanInWindow} из ${BASELINE_DAYS} нужных)`);
          if (priceMovedNearby) reasons.push(`цена периода рекламы (${Math.round(avgWindowPrice)} ₸) отличается от цены базового периода (${Math.round(base.avgPrice)} ₸) на ${(priceDriftVsBaseline * 100).toFixed(1)}% — часть изменения продаж может объясняться ценой, а не рекламой`);
          result = {
            status: "baseline_uncertain",
            units: unitsSoFar, kzt: kztSoFar,
            note: `Недостаточно данных для уверенной оценки: ${reasons.join("; ")}. База ${base.value.toFixed(1)} шт/день, число ${unitsSoFar} шт / ${kztSoFar} ₸ может быть занижено или завышено — проверьте вручную.${familyNote}${resNote}${dupNote}${per1000Note}`,
          };
        } else {
          result = {
            status: unitsSoFar > 0 ? "ok" : "zero",
            units: unitsSoFar, kzt: kztSoFar,
            note: `Расчётная атрибуция (не доказанная сумма покупок этого блогера): база ${base.value.toFixed(1)} шт/день (скользящая, по ${base.cleanCount} чистым дням без рекламы по этому товару), окно ${cluster.published_date}–${windowEndForCluster}${clusters.length > 1 ? `, делили с: ${clusters.filter((x) => x.key !== cluster.key).map((x) => x.blogger_handle).join(", ")}` : ""}. Точность первого дня (D0) ограничена — известна только дата публикации, не время; часть заказов D0 могла быть оформлена до выхода.${priceNote}${familyNote}${resNote}${dupNote}${per1000Note} [${PARAMS_VERSION}]`,
          };
        }
      }

      for (const member of cluster.members) {
        await writeResult(pgPool, member.id, result);
        processed++;
      }
    }
   } catch (e) {
    log(`[attribution] ошибка при расчёте товара ${productKey}: ${e.message}`);
    for (const p of group) {
      try {
        await writeResult(pgPool, p.id, {
          status: "compute_error",
          note: `Внутренняя ошибка расчёта для этого товара: ${String(e.message).slice(0, 400)}. Разберите вручную, остальные размещения это не затронуло. [${PARAMS_VERSION}]`,
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
