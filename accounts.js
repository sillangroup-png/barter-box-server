/* ---------- Личные учётки Barter Box (27.11.2026, Нина) ----------
   У каждого сотрудника свой логин и пароль. Пароль человек задаёт сам по одноразовой ссылке-приглашению,
   которую делает Нина во вкладке «Учётки» (Нина пароли не видит и в код/чат они не попадают).
   Хранится только соль + scrypt-хеш пароля и sha256 приглашения — в Supabase bb.accounts (RLS, читает только сервер)
   и копией в DATA_DIR/accounts.json на случай, если база недоступна.
   Уровни: admin — видит всё (Нина, Сауле, Мария, Константин); lead — все вкладки, данные своей команды (Сая, Анеля);
   manager — свой рабочий стол, свои оплаты/доставки/ТЗ, общая база блогеров и интеграции микро/средние. */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const TEAMS = { "Нина": ["Мадина", "Марина", "Зарина", "Камила"], "Сая": ["Надира", "Анастасия", "Сабрина", "Оксана"], "Анеля": ["Ажар"] };
const LIST = [
  { login: "anelya", name: "Анеля", lvl: "lead" },
  { login: "saule", name: "Сауле", lvl: "admin" },
  { login: "mariya", name: "Мария", lvl: "admin" },
  { login: "konstantin", name: "Константин", lvl: "admin" },
  { login: "ayauzhan", name: "Аяужан", lvl: "admin" }, // 27.11.2026: видит всё и выгружает, без рабочего стола
  { login: "kamila", name: "Камила", lvl: "manager" },
  { login: "zarina", name: "Зарина", lvl: "manager" },
  { login: "marina", name: "Марина", lvl: "manager" },
  { login: "madina", name: "Мадина", lvl: "manager" },
  { login: "sabrina", name: "Сабрина", lvl: "manager" },
  { login: "nadira", name: "Надира", lvl: "manager" },
  { login: "anastasia", name: "Анастасия", lvl: "manager" },
  { login: "oksana", name: "Оксана", lvl: "manager" },
  { login: "azhar", name: "Ажар", lvl: "manager" },
  { login: "olga", name: "Ольга", lvl: "large" },
  { login: "altynay", name: "Алтынай", lvl: "large" },
];
const LVL_BY_NAME = { "Нина": "admin", "Сая": "lead" };
for (const u of LIST) LVL_BY_NAME[u.name] = u.lvl;
function lvlOf(name) { return LVL_BY_NAME[name] || null; }
function teamOf(name) { return lvlOf(name) === "lead" ? (TEAMS[name] || []).slice() : []; }
// Чьи данные видит человек: null — всё (Нина, руководство); тимлид — себя и свою команду; остальные — только себя.
// undefined — старый общий вход без личной учётки: каждый модуль ведёт себя по-старому.
function scopeOf(name) {
  const l = lvlOf(name); if (!l) return undefined;
  if (l === "admin") return null;
  if (l === "lead") return [name].concat(TEAMS[name] || []);
  return [name];
}
function leadOf(name) { for (const [l, m] of Object.entries(TEAMS)) if (m.includes(name)) return l; return null; }

function createAccounts({ dataDir }) {
  const FILE = path.join(dataDir, "accounts.json");
  const url = process.env.BB_DB_URL || "";
  const pool = url ? new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 1, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 }) : null;
  let rows = {}; // login → {salt, hash, set_at, invite_hash, invite_exp, disabled}
  try { if (fs.existsSync(FILE)) rows = JSON.parse(fs.readFileSync(FILE, "utf8")) || {}; } catch (e) { console.error("accounts.json:", e.message); }
  const ready = (async () => {
    if (!pool) return;
    try {
      const r = await pool.query("select login, salt, hash, set_at, invite_hash, invite_exp, disabled from bb.accounts");
      for (const x of r.rows) rows[x.login] = { salt: x.salt, hash: x.hash, set_at: x.set_at, invite_hash: x.invite_hash, invite_exp: x.invite_exp, disabled: x.disabled };
      saveFile();
    } catch (e) { console.error("bb.accounts не прочиталась:", e.message); }
  })();
  function saveFile() { try { fs.writeFileSync(FILE, JSON.stringify(rows)); } catch (e) { console.error("accounts.json:", e.message); } }
  async function save(login) {
    saveFile();
    if (!pool) return;
    const x = rows[login];
    await pool.query(`insert into bb.accounts(login, salt, hash, set_at, invite_hash, invite_exp, disabled, updated_at) values ($1,$2,$3,$4,$5,$6,$7,now())
      on conflict (login) do update set salt=excluded.salt, hash=excluded.hash, set_at=excluded.set_at, invite_hash=excluded.invite_hash, invite_exp=excluded.invite_exp, disabled=excluded.disabled, updated_at=now()`,
      [login, x.salt || null, x.hash || null, x.set_at || null, x.invite_hash || null, x.invite_exp || null, !!x.disabled]);
  }
  const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
  const scrypt = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString("hex");
  const byLogin = (l) => LIST.find((u) => u.login === String(l || "").trim().toLowerCase());
  const byName = (n) => LIST.find((u) => u.name === n);

  function verify(login, password) {
    const u = byLogin(login); if (!u) return null;
    const x = rows[u.login]; if (!x || !x.hash || x.disabled) return null;
    const h = scrypt(password, x.salt);
    if (h.length !== x.hash.length || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(x.hash))) return null;
    return u;
  }
  function hasPassword(name) { const u = byName(name); return !!(u && rows[u.login] && rows[u.login].hash && !rows[u.login].disabled); }
  async function invite(login) {
    const u = byLogin(login); if (!u) throw Error("Нет такой учётки");
    const token = crypto.randomBytes(24).toString("base64url");
    rows[u.login] = { ...(rows[u.login] || {}), invite_hash: sha(token), invite_exp: new Date(Date.now() + 7 * 864e5).toISOString() };
    await save(u.login);
    return { token, user: u };
  }
  function inviteUser(token) {
    if (!token || String(token).length < 20) return null;
    const h = sha(token);
    for (const u of LIST) { const x = rows[u.login]; if (x && x.invite_hash === h && new Date(x.invite_exp).getTime() > Date.now()) return u; }
    return null;
  }
  async function accept(token, password) {
    const u = inviteUser(token); if (!u) throw Error("Ссылка недействительна или устарела — попросите Нину сделать новую");
    const pw = String(password || "");
    if (pw.length < 8) throw Error("Пароль — минимум 8 символов");
    const salt = crypto.randomBytes(16).toString("hex");
    rows[u.login] = { ...(rows[u.login] || {}), salt, hash: scrypt(pw, salt), set_at: new Date().toISOString(), invite_hash: null, invite_exp: null, disabled: false };
    await save(u.login);
    return u;
  }
  // Нина задаёт пароль сама (без ссылки)
  async function setPassword(login, password) {
    const u = byLogin(login); if (!u) throw Error("Нет такой учётки");
    const pw = String(password || ""); if (pw.length < 8) throw Error("Пароль — минимум 8 символов");
    const salt = crypto.randomBytes(16).toString("hex");
    rows[u.login] = { ...(rows[u.login] || {}), salt, hash: scrypt(pw, salt), set_at: new Date().toISOString(), invite_hash: null, invite_exp: null, disabled: false };
    await save(u.login); return u;
  }
  async function setDisabled(login, disabled) {
    const u = byLogin(login); if (!u) throw Error("Нет такой учётки");
    rows[u.login] = { ...(rows[u.login] || {}), disabled: !!disabled }; await save(u.login); return u;
  }
  function list() {
    return LIST.map((u) => { const x = rows[u.login] || {}; return { login: u.login, name: u.name, lvl: u.lvl, lead: u.lvl === "manager" ? leadOf(u.name) : null,
      hasPassword: !!x.hash, setAt: x.set_at || null, invitePending: !!(x.invite_hash && new Date(x.invite_exp).getTime() > Date.now()), inviteExp: x.invite_exp || null, disabled: !!x.disabled }; });
  }
  return { ready, verify, hasPassword, invite, inviteUser, accept, setPassword, setDisabled, list };
}

module.exports = { createAccounts, lvlOf, teamOf, leadOf, scopeOf, TEAMS };
