// ============================================================================
// drive-folders.js — автоподбор папки Google Drive с видео для крупных интеграций.
//
// Структура на диске (договорённость с Ниной, 02.10.2026):
//   <общая папка>/
//     <логин блогера без @>/            ← например saya_orazgaliyeva
//       <ГГГГ-ММ-ДД> <слово про товар>/ ← например «2026-09-08 флюид», внутри — любые видео
//
// Правила подбора:
//  - папка блогера = логин из поля «Логин» (без @, без ссылки, регистр не важен);
//  - папка интеграции = подпапка с датой в пределах ±3 дней от даты публикации (или плановой);
//    если таких несколько — выбирается та, где слово совпадает с товаром интеграции;
//    если всё равно неоднозначно — ничего не подставляется;
//  - подпапок с датой нет, а у блогера ровно одна крупная интеграция — берётся сама папка блогера;
//  - ручная ссылка (deal.driveFolderLink) всегда главнее, автоподбор её не трогает;
//  - найденная папка запоминается по id: переименование/перенос её не ломают; если папку
//    удалили — на следующем прогоне подбор повторяется.
//
// Доступ: служебный аккаунт Google, только чтение (scope drive.readonly). Ключ — в переменной
// окружения GOOGLE_SERVICE_ACCOUNT_JSON (весь JSON целиком), общая папка — в
// GOOGLE_DRIVE_ROOT_FOLDER_ID. Сторонних пакетов нет: JWT подписывается встроенным crypto.
// ============================================================================
const crypto = require("crypto");
const https = require("https");

const DEFAULT_ROOT_FOLDER_ID = "1GHCUkSrJu79aC87skOHcl7UVbu8qq1-L";
const DATE_TOLERANCE_DAYS = 3;
const FOLDER_MIME = "application/vnd.google-apps.folder";

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function httpsRequest(method, url, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { method, hostname: u.hostname, path: u.pathname + u.search, headers },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch (e) { /* не JSON */ }
          resolve({ status: res.statusCode, json, text: data });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error("timeout")));
    if (body) req.write(body);
    req.end();
  });
}

function readConfig() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  let sa;
  try { sa = JSON.parse(raw); } catch (e) { throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON — не JSON (скопируйте файл ключа целиком)"); }
  if (!sa.client_email || !sa.private_key) throw new Error("в ключе нет client_email/private_key — это не ключ служебного аккаунта");
  const rootId = (process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || DEFAULT_ROOT_FOLDER_ID).trim();
  return { sa, rootId };
}

let tokenCache = { token: null, exp: 0 };
async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.token && tokenCache.exp - 60 > now) return tokenCache.token;
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${claim}`);
  const sig = b64url(signer.sign(sa.private_key.replace(/\\n/g, "\n")));
  const body = `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${header}.${claim}.${sig}`;
  const r = await httpsRequest("POST", "https://oauth2.googleapis.com/token", {
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
    body,
  });
  if (r.status !== 200 || !r.json || !r.json.access_token) {
    throw new Error(`Google не выдал доступ (${r.status}): ${(r.json && (r.json.error_description || r.json.error)) || r.text.slice(0, 200)}`);
  }
  tokenCache = { token: r.json.access_token, exp: now + (r.json.expires_in || 3600) };
  return tokenCache.token;
}

async function driveList(token, q, fields) {
  const out = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      q, fields: `nextPageToken, files(${fields})`, pageSize: "1000",
      supportsAllDrives: "true", includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const r = await httpsRequest("GET", `https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status !== 200) throw new Error(`Drive API ${r.status}: ${(r.json && r.json.error && r.json.error.message) || r.text.slice(0, 200)}`);
    out.push(...(r.json.files || []));
    pageToken = r.json.nextPageToken || "";
  } while (pageToken);
  return out;
}

async function driveGet(token, id) {
  const params = new URLSearchParams({ fields: "id,name,trashed,mimeType", supportsAllDrives: "true" });
  const r = await httpsRequest("GET", `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error(`Drive API ${r.status}: ${(r.json && r.json.error && r.json.error.message) || ""}`);
  return r.json;
}

// --- чистые помощники (проверяются тестами без Google) ---
function normalizeLogin(s) {
  let v = String(s || "").trim().toLowerCase();
  v = v.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/^(instagram\.com|instagr\.am|tiktok\.com)\//, "");
  v = v.split(/[?#]/)[0].replace(/^@/, "").split("/")[0].replace(/^@/, "");
  return v.replace(/\s+/g, "");
}
function parseDatedFolder(name) {
  const m = String(name || "").trim().match(/^(\d{4})[-.](\d{2})[-.](\d{2})\s*(.*)$/);
  if (!m) return null;
  return { date: `${m[1]}-${m[2]}-${m[3]}`, rest: m[4] || "" };
}
function daysDiff(a, b) {
  return Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86400000);
}
function words(s) {
  return String(s || "").toLowerCase().replace(/ё/g, "е").split(/[^a-zа-я0-9]+/i).filter((w) => w.length >= 3);
}
function sharesWord(a, b) {
  const A = new Set(words(a));
  return words(b).some((w) => A.has(w) || [...A].some((x) => x.length >= 4 && w.length >= 4 && (x.startsWith(w) || w.startsWith(x))));
}
// Выбор подпапки для одной интеграции. Возвращает {folder} | {reason}.
function pickFolder(deal, bloggerFolder, subfolders, dealsOfBlogger) {
  const dated = subfolders.map((f) => ({ f, p: parseDatedFolder(f.name) })).filter((x) => x.p);
  const date = deal.publishedDate || deal.plannedDate || "";
  if (!dated.length) {
    if (dealsOfBlogger.length === 1) return { folder: bloggerFolder };
    return { reason: `в папке «${bloggerFolder.name}» нет подпапок с датой, а интеграций у блогера ${dealsOfBlogger.length}` };
  }
  if (!date) return { reason: "у интеграции нет даты (ни факт, ни план)" };
  let cands = dated.filter((x) => Math.abs(daysDiff(x.p.date, date)) <= DATE_TOLERANCE_DAYS);
  if (!cands.length) return { reason: `нет подпапки с датой ${date} ±${DATE_TOLERANCE_DAYS} дн.` };
  if (cands.length > 1) {
    const byWord = cands.filter((x) => sharesWord(deal.product, x.p.rest));
    if (byWord.length === 1) cands = byWord;
    else if (byWord.length > 1) cands = byWord;
  }
  if (cands.length > 1) {
    const exact = cands.filter((x) => x.p.date === date);
    if (exact.length === 1) cands = exact;
  }
  if (cands.length === 1) return { folder: cands[0].f };
  return { reason: `подходит несколько папок: ${cands.map((x) => x.f.name).join(", ")} — допишите в название товар` };
}

function folderUrl(id) { return `https://drive.google.com/drive/folders/${id}`; }

async function countFiles(token, folderId) {
  const files = await driveList(token, `'${folderId}' in parents and trashed = false and mimeType != '${FOLDER_MIME}'`, "id,mimeType");
  return files.length;
}

// Основной прогон. Меняет state.influencerDeals[*].driveFolderAuto и state.driveSync.
// Возвращает true, если что-то изменилось (тогда вызывающий делает persist()).
async function syncDriveFolders(state, { log = console.log } = {}) {
  const prevSync = state.driveSync || {};
  let cfg;
  try { cfg = readConfig(); } catch (e) {
    state.driveSync = { configured: false, error: e.message, lastRunAt: new Date().toISOString() };
    return true;
  }
  if (!cfg) {
    const changed = prevSync.configured !== false || prevSync.error;
    state.driveSync = { configured: false, error: null, lastRunAt: prevSync.lastRunAt || null };
    return !!changed;
  }
  const deals = state.influencerDeals || [];
  let changed = false;
  try {
    const token = await getAccessToken(cfg.sa);
    const root = await driveGet(token, cfg.rootId);
    if (!root) throw new Error(`общая папка не видна служебному аккаунту ${cfg.sa.client_email} — поделитесь ею (Читатель)`);
    const bloggerFolders = await driveList(token, `'${cfg.rootId}' in parents and trashed = false and mimeType = '${FOLDER_MIME}'`, "id,name");
    const byLogin = new Map();
    for (const f of bloggerFolders) {
      const k = normalizeLogin(f.name);
      if (!k) continue;
      if (!byLogin.has(k)) byLogin.set(k, []);
      byLogin.get(k).push(f);
    }
    const dealsByLogin = new Map();
    for (const d of deals) {
      const k = normalizeLogin(d.blogerLogin);
      if (!k) continue;
      if (!dealsByLogin.has(k)) dealsByLogin.set(k, []);
      dealsByLogin.get(k).push(d);
    }
    const subCache = new Map();
    let matched = 0, unmatched = 0;
    for (const d of deals) {
      const before = JSON.stringify(d.driveFolderAuto || null);
      const login = normalizeLogin(d.blogerLogin);
      let auto = d.driveFolderAuto || null;
      // Уже найденная папка — проверяем, что она жива, и обновляем счётчик.
      if (auto && auto.id) {
        const f = await driveGet(token, auto.id);
        if (!f || f.trashed) auto = null;
        else auto = { ...auto, name: f.name, url: folderUrl(f.id), count: await countFiles(token, f.id), reason: null, checkedAt: new Date().toISOString() };
      }
      if (!auto || !auto.id) {
        const folders = byLogin.get(login) || [];
        if (!login) auto = { id: null, reason: "у интеграции не указан логин", checkedAt: new Date().toISOString() };
        else if (!folders.length) auto = { id: null, reason: `нет папки «${login}» в общей папке`, checkedAt: new Date().toISOString() };
        else if (folders.length > 1) auto = { id: null, reason: `папок с логином «${login}» несколько: ${folders.map((f) => f.name).join(", ")}`, checkedAt: new Date().toISOString() };
        else {
          const bf = folders[0];
          if (!subCache.has(bf.id)) subCache.set(bf.id, await driveList(token, `'${bf.id}' in parents and trashed = false and mimeType = '${FOLDER_MIME}'`, "id,name"));
          const pick = pickFolder(d, bf, subCache.get(bf.id), dealsByLogin.get(login) || [d]);
          if (pick.folder) auto = { id: pick.folder.id, name: pick.folder.name, url: folderUrl(pick.folder.id), count: await countFiles(token, pick.folder.id), reason: null, checkedAt: new Date().toISOString() };
          else auto = { id: null, reason: pick.reason, checkedAt: new Date().toISOString() };
        }
      }
      if (auto && auto.id) matched++; else unmatched++;
      // checkedAt не считаем изменением, чтобы не писать state.json каждый час без причины.
      const strip = (x) => JSON.stringify(x ? { ...x, checkedAt: undefined } : null);
      if (strip(auto) !== strip(JSON.parse(before))) changed = true;
      d.driveFolderAuto = auto;
    }
    state.driveSync = { configured: true, error: null, account: cfg.sa.client_email, rootName: root.name, bloggerFolders: bloggerFolders.length, matched, unmatched, lastRunAt: new Date().toISOString() };
    log(`[drive] папок блогеров ${bloggerFolders.length}, интеграций с папкой ${matched}, без папки ${unmatched}`);
    return changed || prevSync.error || prevSync.configured !== true || prevSync.matched !== matched;
  } catch (e) {
    state.driveSync = { ...prevSync, configured: true, error: e.message, lastRunAt: new Date().toISOString() };
    log(`[drive] ошибка: ${e.message}`);
    return true;
  }
}

module.exports = { syncDriveFolders, pickFolder, parseDatedFolder, normalizeLogin, folderUrl, DEFAULT_ROOT_FOLDER_ID };
