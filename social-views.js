// ============================================================================
// social-views.js — просмотры роликов Instagram / TikTok по ссылке через Apify,
// чтобы охват не вбивали вручную.
//
// Что видно снаружи: просмотры ролика (Reels/видео-пост, TikTok), лайки, комментарии.
// Охват (reach) Instagram отдаёт только владельцу аккаунта — его не получить. Поэтому в поле
// охвата пишем ПРОСМОТРЫ ролика. Сторис публично не видны — их охват остаётся ручным.
//
// Куда пишем (поля те же, новых колонок нет):
//   микро:   reelsLink (Instagram)  → factReachReels;  tiktokVideoLink → factReachTT
//   крупные: reelsLink (Instagram или TikTok — по адресу) → reach
// v2 (05.10.2026, решение Нины): просмотры по ссылке ЗАМЕНЯЮТ охват сразу, в т.ч. ручной, и идут
// в общий охват. Где ссылки на ролик нет или просмотры не получены (сторис, фото, закрытый аккаунт),
// остаётся ручная цифра. deal.reachAutoSet[поле] — что записал сервер; детали последнего запроса —
// deal.socialViewsAuto = {ig:{...}, tt:{...}}.
//
// Когда обновляем (v3, 15.10.2026): только сам сервер, кнопки нет. Ролики текущего месяца (и вышедшие
// за последние 7 дней): новая ссылка — при ближайшей проверке, дальше каждый ролик раз в 3 дня.
// Прошлые месяцы не пересчитываются.
// Нужен APIFY_TOKEN в Render → Environment. Без него модуль ничего не делает.
// Стоимость (сентябрь 2026): Instagram Scraper ~$1.5, TikTok Scraper ~$1.7 за 1000 роликов.
// ============================================================================

const IG_ACTOR = process.env.APIFY_IG_ACTOR || "apify~instagram-scraper";
const TT_ACTOR = process.env.APIFY_TT_ACTOR || "clockworks~tiktok-scraper";
const REFRESH_EVERY_H = Number(process.env.SOCIAL_VIEWS_REFRESH_HOURS) || 72;   // раз в 3 дня
const MAX_PER_RUN = Number(process.env.SOCIAL_VIEWS_MAX_PER_RUN) || 150;
const H = 3600 * 1000;

function almatyToday() { return new Date(Date.now() + 5 * H).toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5); }
function isEmptyNum(v) { return v == null || v === "" || Number(v) === 0 || isNaN(Number(v)); }

// --- Разбор ссылок ---
// Instagram-пост/рилс: /p/CODE, /reel/CODE, /reels/CODE, /tv/CODE (в т.ч. /username/reel/CODE).
// Ссылка на профиль или вкладку «Reels» профиля — НЕ ролик, по ней не считаем.
function igShortcode(url) {
  const m = String(url || "").match(/instagram\.com\/(?:[A-Za-z0-9._]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})/i);
  return m ? m[1] : null;
}
function igPostUrl(code) { return `https://www.instagram.com/p/${code}/`; }
// TikTok: /@user/video/ID, /video/ID, короткие vm./vt.tiktok.com/XXXX (их раскрывает сам Apify).
function ttVideoId(url) {
  const m = String(url || "").match(/tiktok\.com\/(?:@[^/]+\/)?(?:video|photo)\/(\d{8,})/i);
  return m ? m[1] : null;
}
function ttShort(url) { return /(?:vm|vt)\.tiktok\.com\/[A-Za-z0-9]+/i.test(String(url || "")); }
function ttKey(url) { const id = ttVideoId(url); if (id) return "id:" + id; const m = String(url || "").match(/(?:vm|vt)\.tiktok\.com\/([A-Za-z0-9]+)/i); return m ? "short:" + m[1] : null; }
function cleanUrl(u) { const s = String(u || "").trim(); return !s ? "" : /^https?:\/\//i.test(s) ? s : "https://" + s.replace(/^\/+/, ""); }
function platformOfLink(url) {
  if (igShortcode(url)) return "ig";
  if (ttVideoId(url) || ttShort(url)) return "tt";
  return null;
}

// Какие (сделка, ссылка, поле охвата) есть.
function targetsOf(deal, kind) {
  const out = [];
  if (kind === "micro") {
    const ig = cleanUrl(deal.reelsLink), tt = cleanUrl(deal.tiktokVideoLink);
    if (igShortcode(ig)) out.push({ net: "ig", url: ig, field: "factReachReels" });
    if (ttKey(tt)) out.push({ net: "tt", url: tt, field: "factReachTT" });
  } else {
    const link = cleanUrl(deal.reelsLink);
    const net = platformOfLink(link);
    if (net) out.push({ net, url: link, field: "reach" });
  }
  return out;
}
function pubDateOf(deal, kind) { return String((kind === "micro" ? deal.publishDate : deal.publishedDate) || "").slice(0, 10) || null; }

// Пора ли обновлять эту ссылку.
function isDue(deal, kind, t, nowMs, today) {
  const pd = pubDateOf(deal, kind);
  if (!pd) return false;
  const age = daysBetween(pd, today);
  if (age < 0) return false;
  const prev = deal.socialViewsAuto && deal.socialViewsAuto[t.net];
  const sameLink = prev && prev.url === t.url;
  const last = sameLink && prev.fetchedAt ? Date.parse(prev.fetchedAt) : 0;
  // v3 (15.10.2026, решение Нины): только ролики ТЕКУЩЕГО месяца (+ вышедшие за последние 7 дней,
  // чтобы ролики конца прошлого месяца добрали просмотры). Прошлые месяцы не пересчитываются.
  if (pd.slice(0, 7) !== today.slice(0, 7) && age > 7) return false;
  if (sameLink && prev.errors >= 3 && !prev.views) return false;                  // 3 раза не нашли — хватит
  if (!sameLink || !last) return true;                                             // новая ссылка — при ближайшей проверке
  if (prev.error && !prev.views) return nowMs - last >= 24 * H;                    // ошибка — повтор через сутки
  return nowMs - last >= REFRESH_EVERY_H * H;                                      // дальше — раз в 3 дня
}

async function runActor(actor, input, token, { timeoutSec = 240 } = {}) {
  const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?timeout=${timeoutSec}&clean=true&format=json`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), (timeoutSec + 30) * 1000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(input),
      signal: ctrl.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Apify ${actor}: HTTP ${r.status} ${text.slice(0, 200)}`);
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [];
  } finally { clearTimeout(timer); }
}

// Instagram: результат → по shortcode.
function parseIg(items) {
  const byCode = new Map();
  for (const it of items) {
    const code = it.shortCode || igShortcode(it.url) || igShortcode(it.inputUrl);
    if (!code) continue;
    if (it.error || it.errorDescription) { byCode.set(code, { error: String(it.errorDescription || it.error).slice(0, 120) }); continue; }
    const views = Number(it.videoPlayCount) || Number(it.videoViewCount) || null;
    byCode.set(code, {
      views, likes: it.likesCount != null && it.likesCount >= 0 ? Number(it.likesCount) : null,
      comments: it.commentsCount != null ? Number(it.commentsCount) : null,
      type: it.type || it.productType || null, owner: it.ownerUsername || null,
      error: views ? null : "у поста нет просмотров (фото/карусель) — охват вручную",
    });
  }
  return byCode;
}
// TikTok: результат → по id видео и по присланной ссылке (для коротких vm./vt.).
function parseTt(items) {
  const byKey = new Map();
  for (const it of items) {
    if (it.error || it.errorDescription) {
      const k = ttKey(it.submittedVideoUrl || it.url || it.input);
      if (k) byKey.set(k, { error: String(it.errorDescription || it.error).slice(0, 120) });
      continue;
    }
    const rec = {
      views: Number(it.playCount) || null, likes: it.diggCount != null ? Number(it.diggCount) : null,
      comments: it.commentCount != null ? Number(it.commentCount) : null, shares: it.shareCount != null ? Number(it.shareCount) : null,
      owner: (it.authorMeta && (it.authorMeta.name || it.authorMeta.nickName)) || null, error: null,
    };
    if (!rec.views) rec.error = "просмотры не отдаются";
    if (it.id) byKey.set("id:" + it.id, rec);
    const sk = ttKey(it.submittedVideoUrl);
    if (sk) byKey.set(sk, rec);
    const wk = ttKey(it.webVideoUrl);
    if (wk) byKey.set(wk, rec);
  }
  return byKey;
}

// Записать результат в сделку. Возвращает true, если что-то изменилось.
function applyResult(deal, t, res, nowIso) {
  deal.socialViewsAuto = deal.socialViewsAuto || {};
  const prev = deal.socialViewsAuto[t.net];
  const sameLink = prev && prev.url === t.url;
  const rec = Object.assign({ url: t.url, field: t.field, fetchedAt: nowIso }, res || { error: "ролик не найден (удалён, закрыт аккаунт или неверная ссылка)" });
  if (rec.error && !rec.views) {
    rec.errors = (sameLink ? prev.errors || 0 : 0) + 1;
    if (sameLink && prev.views) { rec.views = prev.views; rec.likes = prev.likes; rec.comments = prev.comments; }   // не теряем прошлую цифру
  } else rec.errors = 0;
  deal.socialViewsAuto[t.net] = rec;
  if (rec.views) writeViews(deal, t.field, rec.views);
  return true;
}
// Просмотры заменяют охват в поле (ручная цифра тоже заменяется — так решено).
function writeViews(deal, field, views) {
  deal.reachAutoSet = deal.reachAutoSet || {};
  if (Number(deal[field]) === views && deal.reachAutoSet[field] === views) return false;
  deal[field] = views;
  deal.reachAutoSet[field] = views;
  return true;
}
// Уже полученные просмотры подставить в охват сразу, без нового запроса в Apify (если ссылка та же).
function reconcileStored(state) {
  let n = 0;
  for (const [kind, list] of [["micro", state.microInfluencerDeals || []], ["large", state.influencerDeals || []]]) {
    for (const d of list) {
      const sv = d.socialViewsAuto;
      if (!sv) continue;
      for (const t of targetsOf(d, kind)) {
        const r = sv[t.net];
        if (r && r.url === t.url && r.views) { if (writeViews(d, t.field, r.views)) n++; delete r.manualKept; }
      }
    }
  }
  return n;
}

let running = false;
// month ("YYYY-MM") + kind ("micro"|"large") — кнопка «Обновить охваты» на открытой вкладке:
// обновляем ВСЕ ролики этой вкладки за этот месяц (кроме проверенных меньше часа назад), остальное не трогаем.
async function syncSocialViews(state, { force = false, month = null, kind: onlyKind = null, recentDays = 0, log = console.log } = {}) {
  const token = process.env.APIFY_TOKEN;
  if (!token) { state.socialViewsSync = { lastRunAt: new Date().toISOString(), error: "APIFY_TOKEN не задан в Render", updated: 0 }; return false; }
  if (running) return false;
  running = true;
  const started = Date.now();
  const nowIso = new Date().toISOString();
  const today = almatyToday();
  const summary = { lastRunAt: nowIso, checked: 0, updated: 0, notFound: 0, igRequested: 0, ttRequested: 0, error: null };
  try {
    summary.replacedFromStored = reconcileStored(state);
    const jobs = [];
    const monthOk = month && /^\d{4}-\d{2}$/.test(month);
    summary.scope = monthOk ? { month, kind: onlyKind || "all" } : null;
    for (const [kind, list] of [["micro", state.microInfluencerDeals || []], ["large", state.influencerDeals || []]]) {
      if (monthOk && onlyKind && onlyKind !== kind) continue;
      for (const d of list) for (const t of targetsOf(d, kind)) {
        if (monthOk) {
          const pd = pubDateOf(d, kind);
          const recent = recentDays > 0 && pd && daysBetween(pd, today) >= 0 && daysBetween(pd, today) <= recentDays;
          if (!pd || (pd.slice(0, 7) !== month && !recent)) continue;
          const prev = d.socialViewsAuto && d.socialViewsAuto[t.net];
          const fresh = prev && prev.url === t.url && prev.fetchedAt && started - Date.parse(prev.fetchedAt) < H;
          if (!fresh) jobs.push({ d, kind, t });
          continue;
        }
        if (isDue(d, kind, t, started, today)) jobs.push({ d, kind, t });
      }
    }
    // Сначала самые свежие выходы.
    jobs.sort((a, b) => String(pubDateOf(b.d, b.kind)).localeCompare(String(pubDateOf(a.d, a.kind))));
    // Ручное обновление по секретной ссылке (month задан) — ВСЕ ролики пачками по MAX_PER_RUN подряд;
    // иначе — одна пачка за запуск.
    const allIg = jobs.filter((j) => j.t.net === "ig"), allTt = jobs.filter((j) => j.t.net === "tt");
    const maxBatches = monthOk ? Infinity : 1;
    let changed = false, doneIg = 0, doneTt = 0;

    for (let b = 0; doneIg < allIg.length && b < maxBatches; b++) {
      const ig = allIg.slice(doneIg, doneIg + MAX_PER_RUN);
      doneIg += ig.length;
      const codes = [...new Set(ig.map((j) => igShortcode(j.t.url)))];
      summary.igRequested += codes.length;
      try {
        const items = await runActor(IG_ACTOR, { directUrls: codes.map(igPostUrl), resultsType: "posts", resultsLimit: 1, addParentData: false }, token);
        const by = parseIg(items);
        for (const j of ig) { const r = by.get(igShortcode(j.t.url)); if (!r) summary.notFound++; if (applyResult(j.d, j.t, r, nowIso)) changed = true; summary.checked++; if (r && r.views && j.d.reachAutoSet && j.d.reachAutoSet[j.t.field] === r.views) summary.updated++; }
      } catch (e) { summary.error = (summary.error ? summary.error + "; " : "") + "Instagram: " + e.message; }
    }
    for (let b = 0; doneTt < allTt.length && b < maxBatches; b++) {
      const tt = allTt.slice(doneTt, doneTt + MAX_PER_RUN);
      doneTt += tt.length;
      const urls = [...new Set(tt.map((j) => j.t.url))];
      summary.ttRequested += urls.length;
      try {
        const items = await runActor(TT_ACTOR, { postURLs: urls, resultsPerPage: 1, shouldDownloadVideos: false, shouldDownloadCovers: false, shouldDownloadAvatars: false, shouldDownloadSubtitles: false, shouldDownloadSlideshowImages: false }, token);
        const by = parseTt(items);
        for (const j of tt) { const r = by.get(ttKey(j.t.url)); if (!r) summary.notFound++; if (applyResult(j.d, j.t, r, nowIso)) changed = true; summary.checked++; if (r && r.views && j.d.reachAutoSet && j.d.reachAutoSet[j.t.field] === r.views) summary.updated++; }
      } catch (e) { summary.error = (summary.error ? summary.error + "; " : "") + "TikTok: " + e.message; }
    }
    summary.durationMs = Date.now() - started;
    summary.pending = (allIg.length - doneIg) + (allTt.length - doneTt);
    state.socialViewsSync = summary;
    log(`[social-views] подставлено из уже полученных ${summary.replacedFromStored}; проверено ${summary.checked} (IG ${summary.igRequested}, TT ${summary.ttRequested}), охват обновлён ${summary.updated}, не найдено ${summary.notFound}, в очереди ${summary.pending}${summary.error ? ", ошибка: " + summary.error : ""}`);
    return changed || true;
  } finally { running = false; }
}

module.exports = { syncSocialViews, reconcileStored, igShortcode, ttVideoId, ttKey, platformOfLink, targetsOf, isDue, applyResult, parseIg, parseTt };
