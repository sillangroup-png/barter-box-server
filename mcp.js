// mcp.js — коннектор для Claude (MCP, Streamable HTTP, без OAuth), 23.10.2026.
// Claude подключается по адресу https://<сайт>/mcp/<MCP_KEY> (Настройки → Коннекторы → Добавить свой).
// ТОЛЬКО ЧТЕНИЕ:
//   • Barter Box — данные сайта (микро/крупные интеграции, бартер и доставки, любые разделы базы);
//   • Supabase (CRM блогеров, заказы Kaspi, вклад) — SQL только SELECT/WITH в READ ONLY транзакции,
//     одна команда (prepared statement), таймаут 20 с, до 500 строк.
// Персональное: поле iin, а также в CRM recipient_name / kaspi / iin не отдаются; номера из 12+ цифр в
// тексте → «[скрыто]» (кроме ШК/кодов/телефонов) — так же, как в read-only API.
// Без MCP_KEY (≥24 символов) в Render коннектор выключен.

const crypto = require("crypto");

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_TEXT = 180000;           // символов в ответе инструмента (чтобы не обрезалось у Claude)
const DB_ROW_LIMIT = 500;
const DB_DROP_COLS = /^(iin|recipient_name|kaspi|.*_iin|iin_.*)$/i;

module.exports = function mountMcp(app, { getState, pgPool, readonlyScrub }) {
  const KEY = String(process.env.MCP_KEY || "");
  const keyOk = (given) => {
    const a = Buffer.from(String(given || "")), b = Buffer.from(KEY);
    return KEY.length >= 24 && a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  // ---------- помощники ----------
  const lc = (s) => String(s == null ? "" : s).toLowerCase();
  const monthOf = (s) => String(s || "").slice(0, 7);
  const microDate = (d) => String(d.publishDate || d.plannedDate || "").slice(0, 10);
  const largeDate = (d) => String(d.publishedDate || d.plannedDate || "").slice(0, 10);
  const page = (arr, offset, limit, def = 200, max = 1000) => {
    const o = Math.max(0, Number(offset) || 0), l = Math.min(max, Math.max(1, Number(limit) || def));
    return { total: arr.length, offset: o, limit: l, items: arr.slice(o, o + l) };
  };
  const MICRO_SHORT = ["id","responsible","blogerName","instagramAccount","tiktokAccount","followers","bloggerCategory","product","productCategory","barcode",
    "cost","productCost","paymentStatus","productStatus","videoStatus","plannedDate","publishDate","contentFormat","reelsLink","tiktokVideoLink",
    "factReachReels","factReachTT","factReachStories","storiesClicks","storiesLink","autoContributionKzt","autoContributionStatus","manualContribution",
    "problemReason","problemReason2","problemStatus","problemNote","cpvNote","viewsHistory","city","tz","tzGroup"];
  const LARGE_SHORT = ["id","blogerLogin","platform","product","barcode","responsible","bloggerCategory","status","plannedDate","publishedDate","plannedReach","reach",
    "plannedClicks","clicks","plannedCost","cost","plannedContribution","autoContributionKzt","autoContributionStatus","likes","comments","saves","reelsLink","viewsHistory"];
  const pick = (o, keys) => { const r = {}; for (const k of keys) if (o[k] !== undefined && o[k] !== "" && o[k] !== null) r[k] = o[k]; return r; };
  const scrub = (v, k) => readonlyScrub(v, k);
  // Колонки-коды (ШК, offer_code, id, телефон) — цифры не прячем; в остальном тексте 12+ цифр → «[скрыто]».
  const CODE_COL = /(code|barcode|sku|phone|ean|article|^id$|_id$)/i;
  const dbScrub = (v, col) => (typeof v === "string" ? (CODE_COL.test(col) ? v : v.replace(/\d(?:[\s-]?\d){11,}/g, "[скрыто]")) : (v && typeof v === "object" ? readonlyScrub(v, col) : v));
  const matchSearch = (o, q) => !q || lc(JSON.stringify(o)).includes(lc(q));

  // ---------- инструменты ----------
  const TOOLS = [
    {
      name: "bb_overview",
      description: "Barter Box (CRM инфлюенс-маркетинга MIXIT KZ): какие разделы есть в базе и сколько в них записей, плюс краткая сводка по микро/крупным интеграциям и доставкам. Вызывай первым, чтобы понять, где искать.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run() {
        const st = getState();
        const sections = {};
        for (const k of Object.keys(st)) {
          if (k === "seeds") continue;
          const v = st[k];
          sections[k] = Array.isArray(v) ? `${v.length} записей` : (v && typeof v === "object" ? `объект (${Object.keys(v).length} ключей)` : typeof v);
        }
        const micro = st.microInfluencerDeals || [], large = st.influencerDeals || [], orders = st.orders || [];
        const byMonth = {};
        for (const d of micro) { const m = monthOf(microDate(d)) || "без даты"; byMonth[m] = byMonth[m] || { all: 0, published: 0, cost: 0 }; byMonth[m].all++; if (d.videoStatus === "опубликовано") byMonth[m].published++; byMonth[m].cost += Number(d.cost) || 0; }
        return {
          sections,
          hint: "microInfluencerDeals — мелкие/средние блогеры (вкладка «Микро»); influencerDeals — крупные; orders/campaigns/drivers/returns — бартер и доставки; publications — публикации по бартеру. Подробно: bb_micro_deals, bb_large_deals, bb_barter, bb_section. Данные Kaspi, вклад и CRM блогеров — db_tables / db_query.",
          micro: { total: micro.length, byMonth },
          large: { total: large.length },
          barter: { orders: orders.length, delivered: orders.filter((o) => o.status === "delivered").length, campaigns: (st.campaigns || []).length },
        };
      },
    },
    {
      name: "bb_micro_deals",
      description: "Мелкие/средние блогеры (вкладка «Микро» в Barter Box): интеграции с ответственным, суммой, товаром и ШК, статусом видео, ссылками, факт. охватом (Reels/TikTok/сторис), вкладом в продажи Kaspi, проблемами. Фильтры по месяцу (по дате выкладки, иначе плановой), ответственному, поиску. full=true — все поля записи.",
      inputSchema: { type: "object", additionalProperties: false, properties: {
        month: { type: "string", description: "ГГГГ-ММ, например 2026-10" },
        responsible: { type: "string", description: "имя ответственного менеджера, например «Сая»" },
        search: { type: "string", description: "поиск по любому полю: логин блогера, товар, ШК…" },
        published_only: { type: "boolean", description: "только опубликованные" },
        full: { type: "boolean", description: "все поля записи (заметки, условия, комментарий к вкладу…)" },
        offset: { type: "number" }, limit: { type: "number", description: "по умолчанию 200, максимум 1000" },
      } },
      run(a) {
        let list = getState().microInfluencerDeals || [];
        if (a.month) list = list.filter((d) => monthOf(microDate(d)) === a.month);
        if (a.responsible) list = list.filter((d) => lc(d.responsible) === lc(a.responsible));
        if (a.published_only) list = list.filter((d) => d.videoStatus === "опубликовано" || Number(d.factReachStories) > 0);
        if (a.search) list = list.filter((d) => matchSearch(d, a.search));
        const p = page(list, a.offset, a.limit);
        p.items = p.items.map((d) => scrub(a.full ? d : pick(d, MICRO_SHORT)));
        return p;
      },
    },
    {
      name: "bb_large_deals",
      description: "Крупные блогеры (интеграции) в Barter Box: план/факт охват, клики, стоимость, вклад в продажи Kaspi, статус. Фильтры по месяцу (дата выхода, иначе плановая) и поиску. full=true — все поля.",
      inputSchema: { type: "object", additionalProperties: false, properties: {
        month: { type: "string", description: "ГГГГ-ММ" }, search: { type: "string" }, full: { type: "boolean" },
        offset: { type: "number" }, limit: { type: "number" },
      } },
      run(a) {
        let list = getState().influencerDeals || [];
        if (a.month) list = list.filter((d) => monthOf(largeDate(d)) === a.month);
        if (a.search) list = list.filter((d) => matchSearch(d, a.search));
        const p = page(list, a.offset, a.limit);
        p.items = p.items.map((d) => scrub(a.full ? d : pick(d, LARGE_SHORT)));
        return p;
      },
    },
    {
      name: "bb_barter",
      description: "Бартер и доставки Barter Box: проекты (кампании) с расходами, доставки (блогер, город, статус, водитель, адрес и телефон для логистики), водители, возвраты. Фильтры: проект (часть названия), статус доставки (created, assigned, accepted, in_route, delivered, no_answer, addr_bad, absent, reschedule, returned, cancelled), поиск.",
      inputSchema: { type: "object", additionalProperties: false, properties: {
        campaign: { type: "string" }, status: { type: "string" }, search: { type: "string" },
        include_orders: { type: "boolean", description: "по умолчанию true" }, offset: { type: "number" }, limit: { type: "number" },
      } },
      run(a) {
        const st = getState();
        const camps = st.campaigns || [];
        const campName = new Map(camps.map((c) => [c.id, c.name]));
        let orders = (st.orders || []).map((o) => Object.assign({}, o, { campaign: campName.get(o.campaignId) || "", photo: o.photo ? "есть" : "" }));
        if (a.campaign) orders = orders.filter((o) => lc(o.campaign).includes(lc(a.campaign)));
        if (a.status) orders = orders.filter((o) => o.status === a.status);
        if (a.search) orders = orders.filter((o) => matchSearch(o, a.search));
        const campaigns = camps.filter((c) => !a.campaign || lc(c.name).includes(lc(a.campaign))).map((c) => {
          const own = (st.orders || []).filter((o) => o.campaignId === c.id);
          const boxesCost = (Number(c.costPerBox) || 0) * own.length, logisticsCost = own.reduce((s, o) => s + (Number(o.logisticsCost) || 0), 0);
          const byStatus = {};
          own.forEach((o) => { byStatus[o.status] = (byStatus[o.status] || 0) + 1; });
          return Object.assign(scrub(c), { ordersCount: own.length, byStatus, boxesCost, logisticsCost, totalExpense: boxesCost + logisticsCost });
        });
        const out = { campaigns, drivers: scrub(st.drivers || []), returns: scrub(st.returns || []) };
        if (a.include_orders !== false) { const p = page(orders, a.offset, a.limit, 300); p.items = scrub(p.items); out.orders = p; }
        return out;
      },
    },
    {
      name: "bb_section",
      description: "Любой раздел базы Barter Box как есть (названия разделов — в bb_overview): например publications, salesDaily, plans, productEvents, socialViewsSync. Для списков — постранично и с поиском.",
      inputSchema: { type: "object", required: ["key"], additionalProperties: false, properties: {
        key: { type: "string" }, search: { type: "string" }, offset: { type: "number" }, limit: { type: "number" },
      } },
      run(a) {
        const st = getState();
        if (a.key === "seeds" || !(a.key in st)) return { error: `раздела «${a.key}» нет. Есть: ${Object.keys(st).filter((k) => k !== "seeds").join(", ")}` };
        const v = st[a.key];
        if (!Array.isArray(v)) return scrub(v, a.key);
        const list = a.search ? v.filter((x) => matchSearch(x, a.search)) : v;
        const p = page(list, a.offset, a.limit);
        p.items = scrub(p.items, a.key);
        return p;
      },
    },
    {
      name: "db_tables",
      description: "Таблицы и колонки базы Supabase MIXIT KZ (CRM блогеров, заказы Kaspi analytics.kaspi_live_order_entries, товары public.products, интеграции и вклад public.influencer_placements и т.д.). Без schema — список таблиц по схемам; со schema (и table) — колонки.",
      inputSchema: { type: "object", additionalProperties: false, properties: { schema: { type: "string" }, table: { type: "string" } } },
      async run(a) {
        if (!a.schema) {
          const { rows } = await pgPool.query(`SELECT table_schema AS schema, table_name AS name, table_type AS type FROM information_schema.tables
            WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_schema NOT LIKE 'pg_%' ORDER BY 1,2`);
          const by = {};
          rows.forEach((r) => { (by[r.schema] = by[r.schema] || []).push(r.type === "VIEW" ? r.name + " (view)" : r.name); });
          return by;
        }
        const { rows } = await pgPool.query(`SELECT table_name AS t, column_name AS c, data_type AS type FROM information_schema.columns
          WHERE table_schema = $1 AND ($2::text IS NULL OR table_name = $2) ORDER BY table_name, ordinal_position`, [a.schema, a.table || null]);
        const by = {};
        rows.forEach((r) => { (by[r.t] = by[r.t] || []).push(`${r.c} ${r.type}${DB_DROP_COLS.test(r.c) ? " (скрыто)" : ""}`); });
        return by;
      },
    },
    {
      name: "db_query",
      description: "SQL-запрос к базе Supabase MIXIT KZ — только чтение (SELECT / WITH, одна команда), до 500 строк, таймаут 20 с. Сначала посмотри колонки через db_tables. Колонки iin / recipient_name / kaspi не возвращаются. Даты заказов Kaspi — order_date; отменённые статусы CANCELLED/CANCELLING исключай.",
      inputSchema: { type: "object", required: ["sql"], additionalProperties: false, properties: { sql: { type: "string" } } },
      async run(a) {
        let sql = String(a.sql || "").trim().replace(/;\s*$/, "");
        if (!/^(select|with)\b/i.test(sql)) return { error: "Разрешены только SELECT / WITH" };
        if (sql.includes(";")) return { error: "Только одна команда (без ;)" };
        if (/\b(set_config|pg_sleep|dblink|lo_import|lo_export|pg_read_file|pg_read_binary_file|copy)\b/i.test(sql)) return { error: "Эта функция запрещена" };
        const client = await pgPool.connect();
        try {
          await client.query("BEGIN READ ONLY");
          await client.query("SET LOCAL statement_timeout = '20s'");
          const r = await client.query({ name: "mcp_" + crypto.createHash("md5").update(sql).digest("hex").slice(0, 16), text: `SELECT * FROM (${sql}) _q LIMIT ${DB_ROW_LIMIT + 1}` });
          const cols = r.fields.map((f) => f.name).filter((c) => !DB_DROP_COLS.test(c));
          const hidden = r.fields.map((f) => f.name).filter((c) => DB_DROP_COLS.test(c));
          const plain = JSON.parse(JSON.stringify(r.rows.slice(0, DB_ROW_LIMIT)));   // даты → строки
          const rows = plain.map((row) => { const o = {}; cols.forEach((c) => { o[c] = dbScrub(row[c], c); }); return o; });
          return { rowCount: rows.length, truncated: r.rows.length > DB_ROW_LIMIT, hiddenColumns: hidden.length ? hidden : undefined, rows };
        } catch (e) {
          return { error: e.message };
        } finally {
          await client.query("ROLLBACK").catch(() => {});
          client.release();
        }
      },
    },
  ];
  const byName = new Map(TOOLS.map((t) => [t.name, t]));

  // ---------- JSON-RPC ----------
  async function handle(msg) {
    const { id, method, params } = msg || {};
    const isNote = id === undefined || id === null;
    const ok = (result) => (isNote ? null : { jsonrpc: "2.0", id, result });
    const err = (code, message) => (isNote ? null : { jsonrpc: "2.0", id, error: { code, message } });
    switch (method) {
      case "initialize": {
        const want = params && params.protocolVersion;
        return ok({
          protocolVersion: PROTOCOL_VERSIONS.includes(want) ? want : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "barter-box", title: "Barter Box (MIXIT KZ)", version: "1.0.0" },
          instructions: "Barter Box — CRM инфлюенс-маркетинга MIXIT KZ (Казахстан): мелкие/средние и крупные блогеры, бартер и доставки, вклад блогеров в продажи Kaspi. Только чтение. Начни с bb_overview; для данных Kaspi и CRM блогеров — db_tables, затем db_query. Суммы в тенге (₸).",
        });
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: true, openWorldHint: false } })) });
      case "tools/call": {
        const t = byName.get(params && params.name);
        if (!t) return err(-32602, "Неизвестный инструмент: " + (params && params.name));
        try {
          const result = await t.run((params && params.arguments) || {});
          let text = JSON.stringify(result);
          if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + `\n…[ответ обрезан: ${text.length} символов — уменьшите limit или добавьте фильтры]`;
          return ok({ content: [{ type: "text", text }], isError: !!(result && result.error) });
        } catch (e) {
          return ok({ content: [{ type: "text", text: "Ошибка: " + e.message }], isError: true });
        }
      }
      default:
        return isNote ? null : err(-32601, "Метод не поддерживается: " + method);
    }
  }

  app.post("/mcp/:key", async (req, res) => {
    // НЕ 401: на 401 Claude начинает вход через OAuth («Couldn't register with … sign-in service»).
    if (KEY.length < 24) return res.status(503).json({ error: "MCP_KEY не задан в Render — коннектор выключен" });
    if (!keyOk(req.params.key)) return res.status(403).json({ error: "неверный ключ в адресе коннектора" });
    const body = req.body;
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(handle))).filter(Boolean);
      return out.length ? res.json(out) : res.status(202).end();
    }
    const out = await handle(body);
    return out ? res.json(out) : res.status(202).end();
  });
  // Проверка в браузере: открыть адрес коннектора — покажет, всё ли настроено.
  app.get("/mcp/:key", (req, res) => {
    const say = (code, text) => res.status(code).type("text/plain; charset=utf-8").send(text);
    if (KEY.length < 24) return say(503, "Коннектор выключен: в Render не задана переменная MCP_KEY (или короче 24 символов).");
    if (!keyOk(req.params.key)) return say(403, "Ключ в адресе не совпадает с MCP_KEY в Render.");
    return say(200, "OK: коннектор Barter Box работает. Этот адрес вставьте в Claude → Настройки → Коннекторы → Добавить свой.");
  });
  // Входа через OAuth нет — коннектор без авторизации (ключ в адресе).
  app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/*", "/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/*", "/.well-known/openid-configuration"],
    (req, res) => res.status(404).json({ error: "OAuth не используется" }));
  app.delete("/mcp/:key", (req, res) => res.status(405).end());
  return { TOOLS, handle };
};
