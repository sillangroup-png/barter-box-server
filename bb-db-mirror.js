/* ---------- Зеркало всех данных Barter Box в базу Supabase (схема bb) ----------
   Зачем: сейчас всё живёт в одном файле state.json на диске Render. Если диск или файл
   пострадают — данные пропадут. Этот модуль раз в 5 минут кладёт ВСЁ состояние в базу:
     bb.integrations  — каждая интеграция (микро и крупные) отдельной строкой + полные данные в jsonb;
     bb.collections   — остальные списки (заказы, кампании, публикации, планы…) целиком;
     bb.snapshots     — раз в день полная копия state.json (хранятся последние 45 дней);
     bb.sync_log      — журнал каждого прогона (успех/ошибка, сколько строк, сколько мс).
   Основная работа сайта от этого не зависит: если база недоступна, сайт работает как раньше,
   а ошибка пишется в журнал и лог. Подключение — переменная BB_DB_URL в Render.
   Удалённая в Barter Box интеграция в базе не стирается, а помечается deleted_at. */

const { Pool } = require("pg");

const URL = process.env.BB_DB_URL || "";
const pool = URL ? new Pool({
  connectionString: URL,
  ssl: { rejectUnauthorized: false },
  max: 2, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000,
}) : null;

const EVERY_MS = 5 * 60 * 1000;
let running = false;
let lastSnapshotDay = "";

const num = v => { const n = parseFloat(String(v ?? "").replace(/\s/g, "").replace(",", ".")); return isFinite(n) ? n : null; };
const txt = v => (v === undefined || v === null || v === "") ? null : String(v);

function microRow(d){
  return {
    kind: "micro", id: d.id, crm_blogger_id: txt(d.crmBloggerId), blogger: txt(d.blogerName),
    instagram: txt(d.instagramAccount), tiktok: txt(d.tiktokAccount), manager: txt(d.responsible),
    product: txt(d.product), barcode: txt(d.barcode), planned_date: txt(d.plannedDate), publish_date: txt(d.publishDate),
    video_status: txt(d.videoStatus), payment_status: txt(d.paymentStatus), cost: num(d.cost), product_cost: num(d.productCost),
    reels_link: txt(d.reelsLink), tiktok_link: txt(d.tiktokVideoLink), reach_reels: num(d.factReachReels), reach_tt: num(d.factReachTT),
    contribution_kzt: num(d.autoContributionKzt), problem_reason: txt(d.problemReason), problem_status: txt(d.problemStatus),
    coop_type: txt(d.coopType), data: d,
  };
}
function largeRow(d){
  return {
    kind: "large", id: d.id, crm_blogger_id: txt(d.crmBloggerId), blogger: txt(d.blogerLogin),
    instagram: txt(d.platform && /insta/i.test(d.platform) ? d.blogerLogin : null), tiktok: null, manager: txt(d.responsible),
    product: txt(d.product), barcode: txt(d.barcode), planned_date: txt(d.plannedDate), publish_date: txt(d.publishedDate),
    video_status: txt(d.status), payment_status: null, cost: num(d.cost), product_cost: null,
    reels_link: txt(d.link || d.videoUrl), tiktok_link: null, reach_reels: num(d.reach), reach_tt: null,
    contribution_kzt: num(d.autoContributionKzt), problem_reason: null, problem_status: null,
    coop_type: null, data: d,
  };
}
const COLS = ["kind","id","crm_blogger_id","blogger","instagram","tiktok","manager","product","barcode","planned_date",
  "publish_date","video_status","payment_status","cost","product_cost","reels_link","tiktok_link","reach_reels","reach_tt",
  "contribution_kzt","problem_reason","problem_status","coop_type","data"];

async function upsertIntegrations(client, rows){
  for(let i = 0; i < rows.length; i += 300){
    const part = rows.slice(i, i + 300);
    const values = [];
    const ph = part.map((r, k) => {
      const base = k * COLS.length;
      COLS.forEach(c => values.push(c === "data" ? JSON.stringify(r[c]) : r[c]));
      return "(" + COLS.map((_, j) => "$" + (base + j + 1)).join(",") + ")";
    }).join(",");
    const set = COLS.filter(c => c !== "kind" && c !== "id").map(c => `${c}=EXCLUDED.${c}`).join(",");
    await client.query(
      `INSERT INTO bb.integrations (${COLS.join(",")}) VALUES ${ph}
       ON CONFLICT (kind, id) DO UPDATE SET ${set}, synced_at=now(), deleted_at=NULL`, values);
  }
}

async function runOnce(getState, todayStr){
  if(!pool || running) return;
  running = true;
  const t0 = Date.now();
  let client, nInt = 0, nCol = 0;
  try{
    const state = getState();
    const micro = (state.microInfluencerDeals || []).filter(d => d && d.id != null).map(microRow);
    const large = (state.influencerDeals || []).filter(d => d && d.id != null).map(largeRow);
    // одинаковый id дважды ломает ON CONFLICT — оставляем последнюю версию
    const uniq = rows => [...new Map(rows.map(r => [r.kind + ":" + r.id, r])).values()];
    const rows = uniq([...micro, ...large]);
    nInt = rows.length;

    client = await pool.connect();
    await client.query("BEGIN");
    await upsertIntegrations(client, rows);
    for(const kind of ["micro", "large"]){
      const ids = rows.filter(r => r.kind === kind).map(r => r.id);
      await client.query(
        `UPDATE bb.integrations SET deleted_at=now() WHERE kind=$1 AND deleted_at IS NULL AND NOT (id = ANY($2::bigint[]))`,
        [kind, ids.length ? ids : [-1]]);
    }
    for(const [name, val] of Object.entries(state)){
      if(name === "microInfluencerDeals" || name === "influencerDeals") continue;
      if(!Array.isArray(val)) continue;
      await client.query(
        `INSERT INTO bb.collections (name, row_count, rows) VALUES ($1,$2,$3)
         ON CONFLICT (name) DO UPDATE SET row_count=EXCLUDED.row_count, rows=EXCLUDED.rows, synced_at=now()`,
        [name, val.length, JSON.stringify(val)]);
      nCol++;
    }
    await client.query("COMMIT");

    const day = todayStr();
    if(day !== lastSnapshotDay){
      const json = JSON.stringify(state);
      await client.query(
        `INSERT INTO bb.snapshots (day, bytes, state) VALUES ($1,$2,$3)
         ON CONFLICT (day) DO UPDATE SET state=EXCLUDED.state, bytes=EXCLUDED.bytes, taken_at=now()`,
        [day, json.length, json]);
      await client.query(`DELETE FROM bb.snapshots WHERE day < (current_date - 45)`);
      lastSnapshotDay = day;
    }
    await client.query(`INSERT INTO bb.sync_log (ok, integrations, collections, ms) VALUES (true,$1,$2,$3)`, [nInt, nCol, Date.now() - t0]);
    await client.query(`DELETE FROM bb.sync_log WHERE run_at < now() - interval '14 days'`);
    console.log(`[bb-db] зеркало OK: интеграций ${nInt}, списков ${nCol}, ${Date.now() - t0} мс`);
  }catch(e){
    if(client) await client.query("ROLLBACK").catch(() => {});
    console.error("[bb-db] ошибка зеркала:", e.message);
    if(client) await client.query(`INSERT INTO bb.sync_log (ok, integrations, collections, ms, error) VALUES (false,$1,$2,$3,$4)`,
      [nInt, nCol, Date.now() - t0, String(e.message).slice(0, 500)]).catch(() => {});
  }finally{
    if(client) client.release();
    running = false;
  }
}

function startBbDbMirror(getState, todayStr){
  if(!pool){ console.warn("[WARN] BB_DB_URL не задан — зеркало данных Barter Box в базу выключено"); return; }
  setTimeout(() => runOnce(getState, todayStr), 20 * 1000);
  setInterval(() => runOnce(getState, todayStr), EVERY_MS);
}

module.exports = { startBbDbMirror, _runOnce: runOnce, _microRow: microRow, _largeRow: largeRow };
