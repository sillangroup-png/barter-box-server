'use strict';
// ============================================================================
// pub-check.js (23.11.2026, просьба Нины) — сам находит вышедшие ролики.
// Каждый вечер в 23:55 по Алматы: интеграции микро с датой выхода «сегодня» (и вчера — на случай позднего поста),
// у которых нет ссылки. Заходим в профиль блогера в Instagram и TikTok (Apify, те же сервисы, что для охватов),
// берём последние ролики и ищем наш: опубликован в день выхода + в описании MIXIT / @mixit / название товара.
//   уверенно (один такой ролик, есть упоминание MIXIT) → вставляем ссылку, «опубликовано», дата выкладки;
//   сомневаемся (нет упоминания или несколько роликов) → d.linkSuggest — утром менеджер подтверждает одной кнопкой;
//   ничего — утром интеграция в «Должны были выйти», как раньше.
// Блогерам ничего не пишет. Нужен APIFY_TOKEN. Выключить — PUB_CHECK=off в Render.
// ============================================================================
const IG_ACTOR = process.env.APIFY_IG_ACTOR || 'apify~instagram-scraper';
const TT_ACTOR = process.env.APIFY_TT_ACTOR || 'clockworks~tiktok-scraper';
const H = 3600 * 1000;
const almatyNow = () => new Date(Date.now() + 5 * H);
const ymd = (d) => d.toISOString().slice(0, 10);
const almatyDay = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? ymd(new Date(t + 5 * H)) : ''; };
const addDays = (s, n) => { const t = new Date(s + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return ymd(t); };

function igNick(v) { const s = String(v || '').trim(); if (!s) return ''; const m = s.match(/instagram\.com\/([A-Za-z0-9._]+)/i); const n = (m ? m[1] : s.replace(/^@/, '').split(/[/?\s]/)[0]); return /^(p|reel|reels|stories|explore)$/i.test(n) ? '' : n.toLowerCase(); }
function ttNick(v) { const s = String(v || '').trim(); if (!s) return ''; const m = s.match(/tiktok\.com\/@([A-Za-z0-9._]+)/i); return (m ? m[1] : s.replace(/^@/, '').split(/[/?\s]/)[0]).toLowerCase(); }

async function runActor(actor, input, token, timeoutSec = 280) {
  const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?timeout=${timeoutSec}&clean=true&format=json`;
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(input), signal: AbortSignal.timeout((timeoutSec + 30) * 1000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`Apify ${actor}: HTTP ${r.status} ${text.slice(0, 160)}`);
  const data = JSON.parse(text); return Array.isArray(data) ? data : [];
}

// Слова товара для поиска в описании: «Набор бестселлеров First Class Set» → first, class, бестселлеров…
function productWords(p) { return String(p || '').toLowerCase().replace(/[^a-zа-яё0-9\s]/gi, ' ').split(/\s+/).filter((w) => w.length >= 5 && !/^(набор|mixit|миксит|крем|маска|средство|для)$/.test(w)); }
function scorePost(post, d) {
  const cap = String(post.caption || '').toLowerCase();
  const mixit = /mixit|миксит|микс\s?ит/.test(cap);
  const prod = productWords(d.product).some((w) => cap.includes(w));
  return { mixit, prod, score: (mixit ? 2 : 0) + (prod ? 1 : 0) };
}

function mount(app, { getState, persist, requireAuth }) {
  const enabled = () => String(process.env.PUB_CHECK || '').toLowerCase() !== 'off' && !!process.env.APIFY_TOKEN;
  let running = false;

  async function run(day, { log = console.log } = {}) {
    if (running) return { error: 'уже идёт' };
    const token = process.env.APIFY_TOKEN; if (!token) return { error: 'APIFY_TOKEN не задан' };
    running = true;
    const st = getState(); const out = { day, checked: 0, found: 0, suggested: 0, errors: [] };
    try {
      const days = new Set([day, addDays(day, -1)]);
      const deals = (st.microInfluencerDeals || []).filter((d) => days.has(String(d.plannedDate || '').slice(0, 10)) && !d.reelsLink && !d.tiktokVideoLink
        && !/отмен/i.test(String(d.problemStatus || '')) && d.videoStatus !== 'опубликовано' && (igNick(d.instagramAccount) || ttNick(d.tiktokAccount)) && !/^Сторис$/.test(String(d.contentFormat || '')));
      out.checked = deals.length;
      if (!deals.length) return out;
      const ig = [...new Set(deals.map((d) => igNick(d.instagramAccount)).filter(Boolean))];
      const tt = [...new Set(deals.filter((d) => /TikTok/i.test(String(d.contentFormat || 'Reels + TikTok')) || !igNick(d.instagramAccount)).map((d) => ttNick(d.tiktokAccount)).filter(Boolean))];
      const posts = []; // {platform, owner, url, caption, day}
      for (let i = 0; i < ig.length; i += 20) {
        try {
          const items = await runActor(IG_ACTOR, { directUrls: ig.slice(i, i + 20).map((n) => `https://www.instagram.com/${n}/`), resultsType: 'posts', resultsLimit: 6, onlyPostsNewerThan: '3 days', addParentData: false }, token);
          for (const it of items) { const isVideo = /video|clips/i.test(String(it.type || '') + ' ' + String(it.productType || '')); if (!isVideo || !it.url) continue;
            posts.push({ platform: 'ig', owner: String(it.ownerUsername || '').toLowerCase(), url: it.url, caption: String(it.caption || '') + ' ' + (it.mentions || []).join(' ') + ' ' + (it.hashtags || []).join(' '), day: almatyDay(it.timestamp) }); }
        } catch (e) { out.errors.push('Instagram: ' + e.message.slice(0, 120)); }
      }
      for (let i = 0; i < tt.length; i += 20) {
        try {
          const items = await runActor(TT_ACTOR, { profiles: tt.slice(i, i + 20), resultsPerPage: 6, profileScrapeSections: ['videos'], profileSorting: 'latest', shouldDownloadVideos: false, shouldDownloadCovers: false, shouldDownloadAvatars: false, shouldDownloadSubtitles: false, shouldDownloadSlideshowImages: false }, token);
          for (const it of items) { if (!it.webVideoUrl) continue;
            posts.push({ platform: 'tt', owner: String((it.authorMeta && it.authorMeta.name) || '').toLowerCase(), url: it.webVideoUrl, caption: String(it.text || '') + ' ' + (it.mentions || []).join(' '), day: almatyDay(it.createTimeISO || (it.createTime ? new Date(it.createTime * 1000).toISOString() : '')) }); }
        } catch (e) { out.errors.push('TikTok: ' + e.message.slice(0, 120)); }
      }
      const now = new Date().toISOString();
      for (const d of deals) {
        const pd = String(d.plannedDate).slice(0, 10);
        const mine = posts.filter((p) => (p.platform === 'ig' ? p.owner === igNick(d.instagramAccount) : p.owner === ttNick(d.tiktokAccount)) && p.day >= pd && p.day <= day);
        if (!mine.length) continue;
        const scored = mine.map((p) => Object.assign({}, p, scorePost(p, d))).sort((a, b) => b.score - a.score);
        const sure = scored.filter((p) => p.mixit);
        const pick = (pl) => sure.filter((p) => p.platform === pl);
        const igSure = pick('ig'), ttSure = pick('tt');
        const ch = {};
        if (igSure.length === 1) ch.reelsLink = igSure[0].url;
        if (ttSure.length === 1) ch.tiktokVideoLink = ttSure[0].url;
        if (Object.keys(ch).length) {
          Object.assign(d, ch, { videoStatus: 'опубликовано', publishDate: (igSure[0] || ttSure[0]).day || pd, linkAuto: { at: now, urls: Object.values(ch) } });
          delete d.linkSuggest; out.found++;
          log(`Выход найден сам: ${d.blogerName} → ${Object.values(ch).join(', ')}`);
        } else {
          d.linkSuggest = scored.slice(0, 3).map((p) => ({ platform: p.platform, url: p.url, day: p.day, caption: p.caption.slice(0, 160), mixit: p.mixit, prod: p.prod }));
          d.linkSuggestAt = now; out.suggested++;
        }
      }
      st.pubCheck = Object.assign({}, out, { at: now });
      persist();
      return out;
    } finally { running = false; }
  }

  // Каждые 5 минут: если в Алматы 23:55 или позже и сегодня ещё не проверяли — проверяем.
  setInterval(() => {
    if (!enabled()) return;
    const n = almatyNow(), day = ymd(n), st = getState();
    if (n.getUTCHours() === 23 && n.getUTCMinutes() >= 55 && (!st.pubCheck || st.pubCheck.day !== day)) run(day).catch((e) => console.error('pub-check:', e.message));
  }, 5 * 60 * 1000).unref();

  // Ручной запуск для проверки (Нина/Сая): POST /api/pub-check/run {day?}
  app.post('/api/pub-check/run', requireAuth, async (req, res) => {
    if (!(req.session && req.session.canExport)) return res.status(403).json({ error: 'Только Нина и Сая' });
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String((req.body || {}).day || '')) ? req.body.day : ymd(almatyNow());
    try { res.json(await run(day)); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Менеджер подтверждает найденную ссылку или отклоняет.
  app.post('/api/pub-check/confirm/:id', requireAuth, (req, res) => {
    const s = req.session || {}; if (!['manager', 'marketer'].includes(s.role) || s.readOnly) return res.status(403).json({ error: 'нет доступа' });
    const d = (getState().microInfluencerDeals || []).find((x) => x.id === +req.params.id); if (!d) return res.status(404).json({ error: 'не найдено' });
    const url = String((req.body || {}).url || '');
    if (url) {
      const s2 = (d.linkSuggest || []).find((x) => x.url === url); if (!s2) return res.status(400).json({ error: 'нет такой ссылки' });
      if (s2.platform === 'tt') d.tiktokVideoLink = url; else d.reelsLink = url;
      d.videoStatus = 'опубликовано'; if (!d.publishDate) d.publishDate = s2.day || String(d.plannedDate || '').slice(0, 10);
      d.linkAuto = { at: new Date().toISOString(), urls: [url], confirmedBy: s.name || '' };
    }
    delete d.linkSuggest; persist(); res.json({ ok: true });
  });
  return { run };
}
module.exports = { mount, igNick, ttNick, scorePost };
