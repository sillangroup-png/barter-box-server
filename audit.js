// audit.js — журнал изменений Barter Box (29.10.2026).
// После каждого изменения (persist) сравниваем записи с прошлым снимком и пишем, ЧТО поменялось,
// КТО (логин/имя из запроса; фоновые задачи — «система») и КОГДА. Удалённые записи сохраняются целиком,
// чтобы их можно было вернуть. Журнал — файл DATA_DIR/audit.jsonl (на постоянном диске) + последние
// записи в памяти для быстрого просмотра на сайте.
const fs = require("fs");
const path = require("path");
const { AsyncLocalStorage } = require("async_hooks");

const COLLECTIONS = [
  // [ключ в state, сущность, поле-id, поле-название]
  ["microInfluencerDeals", "micro", "id", "blogerName"],
  ["influencerDeals", "large", "id", "blogerLogin"],
  ["orders", "order", "id", "blogger"],
  ["campaigns", "campaign", "id", "name"],
  ["drivers", "driver", "code", "name"],
  ["returns", "return", "id", "item"],
  ["publications", "publication", "id", "link"],
];
// Поля, которые сервер ведёт сам и часто (вклад, просмотры, служебное) — в журнал не пишем, это шум.
const NOISE = new Set([
  "autoContributionKzt", "autoContributionStatus", "autoContributionNote", "autoContributionAt", "autoContributionUnits",
  "autoContributionBreakdown", "autoContributionConfidence", "autoContribution", "viewsHistory", "socialViewsAuto",
  "reachAutoSet", "driveFolderAuto", "updatedAt", "syncedAt",
]);
const MAX_MEM = 20000, MAX_FILE = 60 * 1024 * 1024, MAX_STR = 3000;

function cleanRecord(o) {
  const r = {};
  for (const k of Object.keys(o || {})) if (!NOISE.has(k) && !/^autoContribution/.test(k)) r[k] = o[k];
  return r;
}
function short(v) {
  if (typeof v === "string" && v.length > MAX_STR) return v.slice(0, MAX_STR) + "…";
  return v === undefined ? null : v;
}

module.exports = function createAudit({ dataDir, getState }) {
  const als = new AsyncLocalStorage();
  const FILE = path.join(dataDir, "audit.jsonl");
  let shadow = new Map(); // ключ коллекции → Map(id → {json, obj})
  let mem = [];
  let seq = 0;

  // Загрузить хвост журнала в память (последние MAX_MEM записей).
  try {
    if (fs.existsSync(FILE)) {
      const lines = fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean);
      for (const l of lines.slice(-MAX_MEM)) { try { const e = JSON.parse(l); mem.push(e); } catch (e) {} }
      seq = mem.length ? Math.max(...mem.map((e) => Number(e.n) || 0)) : 0;
    }
  } catch (e) { console.error("Журнал изменений: не прочитан —", e.message); }

  function snapshot() {
    const st = getState();
    const out = new Map();
    for (const [key, , idf] of COLLECTIONS) {
      const m = new Map();
      for (const o of st[key] || []) {
        if (!o || o[idf] == null) continue;
        const c = cleanRecord(o);
        m.set(String(o[idf]), { json: JSON.stringify(c), obj: c });
      }
      out.set(key, m);
    }
    return out;
  }
  shadow = snapshot();

  function actor() {
    const st = als.getStore();
    const req = st && st.req;
    if (!req) return { who: "система", sys: true };
    const s = req.session || {};
    let name = "";
    try { name = decodeURIComponent(String(req.headers["x-actor"] || "")).trim().slice(0, 60); } catch (e) {}
    const roleLabel = s.role === "driver" ? "водитель " + (s.driverCode || "") : s.role === "marketer" ? "маркетолог" : s.role === "manager" ? "менеджер" : (s.role || "без входа");
    const who = s.name ? s.name : name ? `${name} (${roleLabel})` : roleLabel;
    return { who };
  }

  function append(entries) {
    if (!entries.length) return;
    mem.push(...entries);
    if (mem.length > MAX_MEM) mem = mem.slice(-MAX_MEM);
    try {
      try { if (fs.statSync(FILE).size > MAX_FILE) fs.renameSync(FILE, FILE.replace(/\.jsonl$/, "-old.jsonl")); } catch (e) {}
      fs.appendFileSync(FILE, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    } catch (e) { console.error("Журнал изменений: запись не удалась —", e.message); }
  }

  // Вызывается из persist(): находит изменения с прошлого раза и пишет их в журнал.
  function check() {
    const now = snapshot();
    const at = new Date().toISOString();
    const a = actor();
    const entries = [];
    for (const [key, entity, , lf] of COLLECTIONS) {
      const before = shadow.get(key) || new Map(), after = now.get(key) || new Map();
      for (const [id, cur] of after) {
        const prev = before.get(id);
        if (!prev) {
          entries.push({ n: ++seq, at, ...a, e: entity, id, label: short(cur.obj[lf] || ""), act: "create" });
          continue;
        }
        if (prev.json === cur.json) continue;
        const ch = {};
        const keys = new Set([...Object.keys(prev.obj), ...Object.keys(cur.obj)]);
        for (const k of keys) {
          const x = prev.obj[k], y = cur.obj[k];
          if (JSON.stringify(x) !== JSON.stringify(y)) ch[k] = [short(x), short(y)];
        }
        if (Object.keys(ch).length) entries.push({ n: ++seq, at, ...a, e: entity, id, label: short(cur.obj[lf] || prev.obj[lf] || ""), act: "update", ch });
      }
      for (const [id, prev] of before) {
        if (!after.has(id)) entries.push({ n: ++seq, at, ...a, e: entity, id, label: short(prev.obj[lf] || ""), act: "delete", rec: prev.obj });
      }
    }
    shadow = now;
    append(entries);
    return entries.length;
  }

  function list({ entity, id, q, before, limit, includeSystem } = {}) {
    const lim = Math.min(1000, Math.max(1, Number(limit) || 200));
    const ql = String(q || "").toLowerCase();
    const out = [];
    for (let i = mem.length - 1; i >= 0 && out.length < lim; i--) {
      const e = mem[i];
      if (before && !(e.n < Number(before))) continue;
      if (entity && e.e !== entity) continue;
      if (id != null && id !== "" && String(e.id) !== String(id)) continue;
      if (!includeSystem && e.sys && !id) continue;
      if (ql && !JSON.stringify(e).toLowerCase().includes(ql)) continue;
      out.push(e);
    }
    return out;
  }

  // Вернуть: для изменения — старые значения полей (всех или одного), для удаления — запись целиком.
  function revert(n, field) {
    const e = mem.find((x) => x.n === Number(n));
    if (!e) return { error: "Запись журнала не найдена (возможно, слишком старая)" };
    const col = COLLECTIONS.find((c) => c[1] === e.e);
    if (!col) return { error: "Неизвестный раздел" };
    const [key, , idf] = col;
    const st = getState();
    const arr = st[key] = st[key] || [];
    if (e.act === "delete") {
      if (arr.some((o) => String(o[idf]) === String(e.id))) return { error: "Запись с таким id уже есть — восстанавливать нечего" };
      const rec = Object.assign({}, e.rec);
      if (idf === "id") rec.id = Number(e.id) || e.id;
      arr.push(rec);
      return { ok: true, restored: rec };
    }
    if (e.act !== "update") return { error: "Создание не отменяется отсюда — удалите запись в таблице" };
    const obj = arr.find((o) => String(o[idf]) === String(e.id));
    if (!obj) return { error: "Запись удалена — сначала верните её (в журнале — строка удаления)" };
    const fields = field ? [field] : Object.keys(e.ch || {});
    for (const f of fields) {
      if (!e.ch || !(f in e.ch)) continue;
      const old = e.ch[f][0];
      if (old === null) delete obj[f]; else obj[f] = old;
    }
    return { ok: true, record: obj };
  }

  function middleware(req, res, next) { als.run({ req }, next); }

  return { check, list, revert, middleware, file: FILE };
};
