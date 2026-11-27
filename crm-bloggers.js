'use strict';
/* ---------- Блогеры и оплаты из Blogger CRM внутри Barter Box (22.11.2026) ----------
   Данные лежат в схеме crm своего Supabase (BB_DB_URL):
     crm.bloggers / crm.payments — по строке на запись, все поля CRM в data (jsonb);
     crm.items — товары, бартеры, ТЗ, пользователи CRM и прочее;
     crm.status_log — кто и когда менял статус блогера;
     crm.meta — cutover (переезд завершён) и служебные отметки.
   До переезда их заливает старая CRM, здесь — только просмотр.
   После переезда (кнопка у Нины) CRM только для чтения, а правки идут здесь, и этот модуль
   сам дублирует изменения в базу Константина (crm_blogers.*) и в резервную копию (public.*). */
const { Pool } = require('pg');

const USER_NAMES = { kamila: 'Камила', madina: 'Мадина', zarina: 'Зарина', zarina1234: 'Нина', marina: 'Марина', saya: 'Сая',
  altynay: 'Алтынай', anastasiia: 'Анастасия', sabrina: 'Сабрина', nadira: 'Надира', aneljan1: 'Анеля', elmira1: 'Эльмира',
  ajar: 'Ажар', oxana: 'Оксана', sabina: 'Сабина', admin: 'Нина', marketing: 'Нина', grok_bot: 'бот' };
const managerName = m => !m ? null : (m.startsWith('bb:') ? m.slice(3) : (USER_NAMES[m] || m));

// Статусы блогера (понятные слова, см. прототип «Статусы и даты»)
const TALK = { new: 'Новый', contacted: 'Написали', replied: 'Ответили', considering: 'На рассмотрении' };
const LEGACY = { in_work: 'В работе', transferred: 'Передан в работу', payment_pending: 'К оплате', payment_submitted: 'Подано на оплату', paid: 'Оплачено' };
const DECLINE = { child: 'ребёнок', male: 'мужчина', content: 'контент', low_views: 'низкие просмотры', fake: 'накрутка', expensive: 'дорого',
  shop: 'магазин', rf: 'РФ', no_answer: 'не отвечает', blacklist: 'чёрный список', other: 'другое' };
const LEGACY_DECLINE = { declined_reach: 'low_views', declined_rf: 'rf', declined_shop: 'shop', declined_bad: 'content' };
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const PAY_STATUS = { pending: 'К оплате', submitted: 'Подано', paid: 'Оплачено', rejected: 'Отклонено', refunded: 'Возврат' };

const nickOf = url => String(url || '').replace(/#.*$/, '').replace(/[?].*$/, '').replace(/\/+$/, '').split('/').pop().replace('@', '').trim().toLowerCase() || null;
const num = v => { const n = parseFloat(String(v ?? '').replace(/\s/g, '').replace(',', '.')); return isFinite(n) ? n : null; };
const str = (v, n = 500) => (v === undefined || v === null) ? null : String(v).trim().slice(0, n) || null;

function declineCode(status, reason) {
  if (LEGACY_DECLINE[status]) return LEGACY_DECLINE[status];
  if (reason && DECLINE[reason]) return reason;
  if (reason === 'reach') return 'low_views';
  if (reason === 'bad') return 'content';
  if (reason === 'rf') return 'rf';
  if (reason && /охват/i.test(reason)) return 'low_views';
  return 'other';
}

function mount(app, { getState, requireAuth, kostPool, persist, env = process.env }) {
  // 23.11.2026: статус оплаты в интеграции ставится сам — подали заявку → «к оплате», Нина отметила → «оплачено».
  const PAY_TO_DEAL = { pending: 'к оплате', submitted: 'к оплате', approved: 'к оплате', paid: 'оплачено' };
  const syncDealPay = (dealId, s) => { const v = PAY_TO_DEAL[s]; if (!dealId || !v) return; const d = ((getState() || {}).microInfluencerDeals || []).find((x) => String(x.id) === String(dealId)); if (d && d.paymentStatus !== v) { d.paymentStatus = v; if (v === 'оплачено') { d.paidAt = new Date().toISOString(); d.paidMsgSent = null; d.paidSkip = true; d.paidMsgNote = null; d.paidMsgErr = null; d.paidMsgTries = 0; d.paidMsgAuto = false; } if (persist) persist(); } };
  const URL = env.BB_DB_URL || '';
  const pool = URL ? new Pool({ connectionString: URL, ssl: { rejectUnauthorized: false }, max: 4, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 }) : null;
  const need = (res) => { if (!pool) { res.status(503).json({ error: 'База не подключена (BB_DB_URL)' }); return false; } return true; };
  const isNina = req => req.session && req.session.name === 'Нина' && req.session.canExport;
  const canStaff = req => req.session && (req.session.role === 'manager' || req.session.role === 'marketer');

  let cutoverCache = { at: 0, value: null };
  async function cutover() {
    if (!pool) return null;
    if (Date.now() - cutoverCache.at < 15000) return cutoverCache.value;
    try { const r = await pool.query("select value from crm.meta where key='cutover'"); cutoverCache = { at: Date.now(), value: r.rows[0] ? r.rows[0].value : null }; }
    catch (e) { cutoverCache = { at: Date.now(), value: null }; }
    return cutoverCache.value;
  }

  // Интеграции BB по нику/ID CRM — для статусов «В работе · месяц / Вышло · месяц / Работали · месяц».
  let dealIdx = { at: 0, byNick: new Map(), byCrm: new Map() };
  function deals() {
    if (Date.now() - dealIdx.at < 20000) return dealIdx;
    const byNick = new Map(), byCrm = new Map();
    const st = getState() || {};
    const add = (k, map, d) => { if (!k) return; if (!map.has(k)) map.set(k, []); map.get(k).push(d); };
    for (const d of (st.microInfluencerDeals || [])) {
      const x = { id: d.id, kind: 'micro', date: d.publishDate || d.plannedDate || '', product: d.product || '', manager: d.responsible || '',
        done: d.videoStatus === 'опубликовано' || (num(d.factReachStories) || 0) > 0, cancelled: /отмен/i.test(String(d.problemStatus || '')), cost: num(d.cost), paymentStatus: d.paymentStatus || '' };
      add(nickOf(d.instagramAccount) || nickOf(d.tiktokAccount), byNick, x); add(d.crmBloggerId && String(d.crmBloggerId), byCrm, x);
    }
    for (const d of (st.influencerDeals || [])) {
      const x = { id: d.id, kind: 'large', date: d.publishDate || d.plannedDate || d.date || '', product: d.product || '', manager: d.responsible || '',
        done: ['Опубликована', 'Закрыта', 'Оплачена'].includes(d.status), cancelled: d.status === 'Отменена', cost: num(d.plannedCost || d.cost), paymentStatus: d.paymentStatus || '' };
      add(nickOf(d.instagramLink) || nickOf(d.blogerLogin), byNick, x); add(d.crmBloggerId && String(d.crmBloggerId), byCrm, x);
    }
    dealIdx = { at: Date.now(), byNick, byCrm };
    return dealIdx;
  }
  const dealsFor = (id, nick) => { const i = deals(); const m = new Map(); for (const d of [...(i.byCrm.get(String(id)) || []), ...(nick ? (i.byNick.get(nick) || []) : [])]) m.set(d.kind + d.id, d); return [...m.values()]; };
  const monthOf = s => { const m = /^(\d{4})-(\d{2})/.exec(String(s || '')); return m ? { ym: m[1] + '-' + m[2], name: MONTHS[+m[2] - 1] } : null; };

  function statusView(status, reason, ds) {
    if (String(status || '').startsWith('declined')) { const c = declineCode(status, reason); return { group: 'declined', label: 'Отказ: ' + DECLINE[c], code: c, note: (reason && !DECLINE[reason] && !['reach', 'bad', 'rf', 'declined'].includes(reason)) ? reason : null }; }
    const live = ds.filter(d => !d.cancelled);
    if (live.length) {
      const open = live.filter(d => !d.done).sort((a, b) => String(a.date).localeCompare(String(b.date)));
      const now = new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 7);
      if (open.length) { const m = monthOf(open[0].date); return { group: 'work', label: 'В работе' + (m ? ' · ' + m.name : ''), month: m && m.ym }; }
      const last = live.sort((a, b) => String(b.date).localeCompare(String(a.date)))[0]; const m = monthOf(last.date);
      return { group: 'worked', label: (m && m.ym === now ? 'Вышло' : 'Работали') + (m ? ' · ' + m.name : ''), month: m && m.ym };
    }
    if (TALK[status]) return { group: 'talk', label: TALK[status] };
    if (LEGACY[status]) return { group: 'legacy', label: LEGACY[status] + ' (CRM)' };
    return { group: 'talk', label: TALK.new };
  }

  function view(row) {
    const b = row.data || {};
    const ds = dealsFor(row.id, row.nick);
    return {
      id: row.id, name: b.name || null, nick: row.nick, instagram: b.instagram_url || null, tiktok: b.tiktok_url || null,
      followers: num(b.instagram_followers), followersTT: num(b.tiktok_followers), reach: num(b.instagram_avg_reach), reachTT: num(b.tiktok_avg_reach),
      storiesReach: num(b.stories_avg_reach), er: b.er || null, category: b.category || null,
      price: { reels: num(b.price_reels), tiktok: num(b.price_tiktok), both: num(b.price_both), stories: num(b.price_stories) },
      cpv: { reels: num(b.cpv_reels), tiktok: num(b.cpv_tiktok), both: num(b.cpv_both), stories: num(b.cpv_stories) }, batchId: b.batch_id || null,
      status: b.status || 'new', declineReason: b.decline_reason || null, st: statusView(b.status, b.decline_reason, ds),
      manager: managerName(row.manager), lastComment: b.last_comment || null, notes: b.notes || null,
      whatsapp: b.blogger_whatsapp || null, managerWhatsapp: b.manager_whatsapp || null, managerInstagram: b.manager_instagram || null,
      exclusive: !!b.is_exclusive, contactedAt: b.contacted_at || null, updatedAt: b.updated_at || null, createdAt: b.created_at || null,
      deals: ds.length,
    };
  }

  // ---------- Справочники ----------
  app.get('/api/crm/meta', requireAuth, async (req, res) => {
    if (!canStaff(req) || !need(res)) return;
    try {
      const [cnt, push, mgr] = await Promise.all([
        pool.query("select count(*)::int n, count(*) filter (where status like 'declined%')::int declined from crm.bloggers where not deleted"),
        pool.query("select value, updated_at from crm.meta where key='last_crm_push'"),
        pool.query('select manager, count(*)::int n from crm.bloggers where not deleted group by 1 order by 2 desc'),
      ]);
      const managers = {}; for (const r of mgr.rows) { const n = managerName(r.manager) || '— без менеджера'; managers[n] = (managers[n] || 0) + r.n; }
      res.json({ cutover: await cutover(), total: cnt.rows[0].n, declined: cnt.rows[0].declined, lastPush: push.rows[0] || null,
        managers, talk: TALK, decline: DECLINE, payStatus: PAY_STATUS, isNina: isNina(req) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---------- Список блогеров: все фильтры старой CRM ----------
  const N = f => `crm.num(data->>'${f}')`;
  const BEST_CPV = `least(coalesce(${N('cpv_reels')},9999),coalesce(${N('cpv_tiktok')},9999),coalesce(${N('cpv_both')},9999))`;
  function buildWhere(q, session) {
    const where = ['not deleted']; const args = [];
    const arg = v => { args.push(v); return '$' + args.length; };
    const n = v => { const x = num(v); return x === null ? null : x; };
    if (q.q) { const s = String(q.q).toLowerCase().replace('@', '').trim(); where.push(`(search like ${arg('%' + s + '%')} or nick like ${arg('%' + s + '%')})`); }
    if (q.status === 'talk') where.push("status in ('new','contacted','replied','considering')");
    else if (q.status === 'declined') where.push("status like 'declined%'");
    else if (q.status === 'notdeclined') where.push("status not like 'declined%'");
    else if (q.status && q.status.startsWith('decl:')) { const c = q.status.slice(5); const legacy = Object.keys(LEGACY_DECLINE).filter(k => LEGACY_DECLINE[k] === c);
      where.push(`(status like 'declined%' and (data->>'decline_reason' = ${arg(c)} or status = any(${arg(legacy.length ? legacy : ['__'])})))`); }
    else if (q.status) where.push(`status = ${arg(String(q.status))}`);
    let mgrNames = null;
    if (q.mine === '1') mgrNames = [session.name];
    else if (q.manager) mgrNames = [String(q.manager)];
    if (mgrNames) {
      const users = Object.keys(USER_NAMES).filter(u => mgrNames.includes(USER_NAMES[u]));
      if (mgrNames.includes('— без менеджера')) where.push('manager is null');
      else where.push(`(manager = any(${arg([...users, ...mgrNames.map(x => 'bb:' + x)])}))`);
    }
    if (q.no_manager === '1') where.push('manager is null');
    if (q.platform === 'instagram') where.push("coalesce(data->>'instagram_url','') <> ''");
    if (q.platform === 'tiktok') where.push("coalesce(data->>'tiktok_url','') <> ''");
    if (q.platform === 'both') where.push("coalesce(data->>'instagram_url','') <> '' and coalesce(data->>'tiktok_url','') <> ''");
    if (n(q.cpv_min) !== null) where.push(`${BEST_CPV} >= ${arg(n(q.cpv_min))}`);
    if (n(q.cpv_max) !== null) where.push(`${BEST_CPV} <= ${arg(n(q.cpv_max))}`);
    if (n(q.reach_min) !== null) { const a = arg(n(q.reach_min)); where.push(`(coalesce(${N('instagram_avg_reach')},0) >= ${a} or coalesce(${N('tiktok_avg_reach')},0) >= ${a})`); }
    if (n(q.followers_min) !== null) where.push(`coalesce(${N('instagram_followers')},0) >= ${arg(n(q.followers_min))}`);
    if (n(q.followers_max) !== null) where.push(`coalesce(${N('instagram_followers')},0) <= ${arg(n(q.followers_max))}`);
    if (n(q.reels_min) !== null) where.push(`${N('price_reels')} >= ${arg(n(q.reels_min))}`);
    if (n(q.reels_max) !== null) where.push(`${N('price_reels')} <= ${arg(n(q.reels_max))}`);
    if (n(q.tt_min) !== null) where.push(`${N('price_tiktok')} >= ${arg(n(q.tt_min))}`);
    if (n(q.tt_max) !== null) where.push(`${N('price_tiktok')} <= ${arg(n(q.tt_max))}`);
    if (q.no_price === '1') where.push(`coalesce(${N('price_reels')},0)=0 and coalesce(${N('price_tiktok')},0)=0 and coalesce(${N('price_both')},0)=0`);
    if (q.in_work === '1') where.push("(status in ('in_work','transferred') or data->>'in_work' = 'true')");
    if (q.exclude_in_work === '1') where.push("not (status = 'in_work' or data->>'in_work' = 'true')");
    if (q.exclude_transferred === '1') where.push("status <> 'transferred'");
    if (q.exclude_declined === '1') where.push("status not like 'declined%'");
    if (q.exclude_considering === '1') where.push("status <> 'considering'");
    if (q.category) where.push(`data->>'category' = ${arg(String(q.category))}`);
    if (q.exclude_category) where.push(`coalesce(data->>'category','') <> all(${arg(String(q.exclude_category).split(','))})`);
    if (q.batch_id) where.push(`data->>'batch_id' = ${arg(String(q.batch_id))}`);
    if (q.ids) where.push(`id = any(${arg(String(q.ids).split(',').slice(0, 20000))})`);
    if (q.worked && /^\d{4}-\d{2}$/.test(q.worked)) {
      const i = deals(); const nicks = []; const ids = [];
      for (const [k, list] of i.byNick) if (list.some(d => !d.cancelled && String(d.date).startsWith(q.worked))) nicks.push(k);
      for (const [k, list] of i.byCrm) if (list.some(d => !d.cancelled && String(d.date).startsWith(q.worked))) ids.push(k);
      where.push(`(nick = any(${arg(nicks.length ? nicks : ['__'])}) or id = any(${arg(ids.length ? ids : ['__'])}))`);
    }
    return { w: where.join(' and '), args };
  }
  const SORTS = {
    default: "coalesce(data->>'price_updated_at', data->>'updated_at', '') desc",
    updated: "coalesce(data->>'updated_at', '') desc",
    created_desc: "coalesce(data->>'created_at', '') desc",
    cpv_asc: `${BEST_CPV} asc`,
    cpv_desc: `nullif(${BEST_CPV},9999) desc nulls last`,
    reach: `coalesce(${N('instagram_avg_reach')},0) desc`,
    followers: `coalesce(${N('instagram_followers')},0) desc`,
    name: 'nick asc',
  };
  const COLSORT = { followers: N('instagram_followers'), reach: N('instagram_avg_reach'), followersTT: N('tiktok_followers'), reachTT: N('tiktok_avg_reach'),
    priceReels: N('price_reels'), cpvReels: N('cpv_reels'), priceTiktok: N('price_tiktok'), cpvTiktok: N('cpv_tiktok'), priceBoth: N('price_both'), cpvBoth: N('cpv_both'),
    storiesReach: N('stories_avg_reach'), priceStories: N('price_stories'), cpvStories: N('cpv_stories'), created: "data->>'created_at'" };
  function orderOf(q) {
    if (q.col && COLSORT[q.col]) return `${COLSORT[q.col]} ${q.dir === 'asc' ? 'asc' : 'desc'} nulls last`;
    return SORTS[q.sort] || SORTS.default;
  }

  app.get('/api/crm/bloggers', requireAuth, async (req, res) => {
    if (!canStaff(req) || !need(res)) return;
    const q = req.query;
    const { w, args } = buildWhere(q, req.session);
    try {
      if (q.ids_only === '1') { const r = await pool.query(`select id from crm.bloggers where ${w} limit 20000`, args); return res.json({ ids: r.rows.map(x => x.id) }); }
      const limit = Math.min(200, Math.max(10, parseInt(q.limit) || 50));
      const page = Math.max(1, parseInt(q.page) || 1);
      const [rows, cnt] = await Promise.all([
        pool.query(`select id, data, status, manager, nick from crm.bloggers where ${w} order by ${orderOf(q)} limit ${limit} offset ${(page - 1) * limit}`, args),
        pool.query(`select count(*)::int n from crm.bloggers where ${w}`, args),
      ]);
      res.json({ items: rows.rows.map(view), total: cnt.rows[0].n, page, limit });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/crm/batches', requireAuth, async (req, res) => {
    if (!canStaff(req) || !need(res)) return;
    try {
      const r = await pool.query("select id, data from crm.items where collection='batches' and not deleted order by data->>'created_at' desc nulls last limit 300");
      const c = await pool.query("select data->>'batch_id' b, count(*)::int n from crm.bloggers where not deleted and data->>'batch_id' is not null group by 1");
      const cnt = Object.fromEntries(c.rows.map(x => [x.b, x.n]));
      res.json(r.rows.map(x => ({ id: x.id, name: x.data.name || x.data.filename || null, createdAt: x.data.created_at || x.data.date || null, n: cnt[x.id] || x.data.count || 0 })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---------- Шаблон (все), Excel (Нина/Сая), дубли ----------
  const XLSX = (() => { try { return require('xlsx'); } catch (e) { return null; } })();
  const TEMPLATE_HEAD = ['ID', 'Ник', 'Ссылка Instagram', 'Подп. Инст', 'Охват Инст', 'Ссылка TikTok', 'Подп. ТТ', 'Охват ТТ', 'Цена Рилс (₸)', 'Цена ТТ (₸)', 'Цена Рилс+ТТ (₸)', 'Цена Сторис (₸)', 'Охват Сторис', 'Статус', 'Последний комментарий', 'Менеджер', 'Категория', 'WhatsApp'];
  function sendXlsx(res, filename, aoa, sheet) {
    const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = aoa[0].map(h => ({ wch: Math.max(String(h).length + 4, 14) }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, sheet);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  }
  app.get('/api/crm/template', requireAuth, (req, res) => {
    if (!canStaff(req)) return res.status(403).json({ error: 'Нет доступа' });
    if (!XLSX) return res.status(503).json({ error: 'Excel недоступен на сервере' });
    sendXlsx(res, 'шаблон_блогеры.xlsx', [TEMPLATE_HEAD, ['', '@blogger_name', 'https://instagram.com/blogger_name', 62700, 28700, 'https://tiktok.com/@blogger_name', 15000, 23900, '', '', '', '', '', 'new', '', '', '', '']], 'Шаблон');
  });
  const canExportReq = req => !!(req.session && req.session.canExport);
  app.get('/api/crm/export', requireAuth, async (req, res) => {
    if (!need(res)) return;
    if (!canExportReq(req)) return res.status(403).json({ error: 'Выгрузка только у Нины и Саи' });
    if (!XLSX) return res.status(503).json({ error: 'Excel недоступен на сервере' });
    try {
      const { w, args } = buildWhere(req.query, req.session);
      const r = await pool.query(`select id, data, status, manager, nick from crm.bloggers where ${w} order by ${orderOf(req.query)} limit 20000`, args);
      const head = ['ID', 'Ник', 'Ссылка Instagram', 'Подп. Инст', 'Охват Инст', 'Ссылка TikTok', 'Подп. ТТ', 'Охват ТТ', 'Цена Рилс (₸)', 'CPV Рилс', 'Цена ТТ (₸)', 'CPV ТТ', 'Цена Рилс+ТТ (₸)', 'CPV Рилс+ТТ', 'Охват Сторис', 'Цена Сторис (₸)', 'CPV Сторис', 'Статус', 'Причина отказа', 'Менеджер', 'Категория', 'WhatsApp', 'Последний комментарий', 'Добавлен'];
      const rows = r.rows.map(row => { const b = row.data, v = view(row); return [row.id, b.name || '', b.instagram_url || '', v.followers, v.reach, b.tiktok_url || '', v.followersTT, v.reachTT, v.price.reels, v.cpv.reels, v.price.tiktok, v.cpv.tiktok, v.price.both, v.cpv.both, v.storiesReach, v.price.stories, v.cpv.stories, v.st.label, b.decline_reason || '', v.manager || '', b.category || '', b.blogger_whatsapp || '', b.last_comment || '', (b.created_at || '').slice(0, 10)]; });
      console.log(`CRM: выгрузка ${rows.length} блогеров — ${req.session.name}`);
      sendXlsx(res, `блогеры_${new Date().toISOString().slice(0, 10)}.xlsx`, [head, ...rows], 'Блогеры');
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/crm/duplicates', requireAuth, async (req, res) => {
    if (!canStaff(req) || !need(res)) return;
    try {
      const r = await pool.query(`with d as (select nick from crm.bloggers where not deleted and nick is not null group by nick having count(*)>1 limit 500)
        select b.id, b.data, b.status, b.manager, b.nick from crm.bloggers b join d using (nick) where not b.deleted order by b.nick, b.data->>'created_at'`);
      const groups = {}; for (const row of r.rows) (groups[row.nick] = groups[row.nick] || []).push(view(row));
      res.json(Object.entries(groups).map(([nick, items]) => ({ nick, items })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---------- Карточка ----------
  app.get('/api/crm/bloggers/:id', requireAuth, async (req, res) => {
    if (!canStaff(req) || !need(res)) return;
    try {
      const r = await pool.query('select id, data, status, manager, nick from crm.bloggers where id=$1', [req.params.id]);
      if (!r.rows[0]) return res.status(404).json({ error: 'Блогер не найден' });
      const [pays, log] = await Promise.all([
        pool.query('select id, data, status from crm.payments where blogger_id=$1 and not deleted order by created_at desc nulls last', [req.params.id]),
        pool.query('select status, decline_reason, actor, at from crm.status_log where blogger_id=$1 order by at desc limit 30', [req.params.id]),
      ]);
      const b = view(r.rows[0]);
      b.dealList = dealsFor(r.rows[0].id, r.rows[0].nick).sort((a, z) => String(z.date).localeCompare(String(a.date)));
      b.payments = pays.rows.map(p => ({ id: p.id, status: p.status, statusLabel: PAY_STATUS[p.status] || p.status, amount: num(p.data.amount),
        name: p.data.payment_name || null, recipient: p.data.recipient_name || null, isIp: !!p.data.is_ip, createdAt: p.data.created_at || null }));
      b.log = log.rows;
      res.json(b);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  async function requireCutover(res) {
    if (await cutover()) return true;
    res.status(409).json({ error: 'Пока блогеры ведутся в старой CRM — правки будут доступны после переезда (кнопка у Нины во вкладке «Блогеры»)' });
    return false;
  }
  async function crmUserId(client, username) {
    if (!username) return null;
    const r = await client.query("select id from crm.items where collection='users' and data->>'username'=$1", [username]);
    return r.rows[0] ? r.rows[0].id : null;
  }
  function managerKey(name) { const u = name === 'Нина' ? 'admin' : Object.keys(USER_NAMES).find(k => USER_NAMES[k] === name); return u || (name ? 'bb:' + name : null); }
  const searchOf = b => [b.name, b.instagram_url, b.tiktok_url, b.last_comment, b.blogger_whatsapp].filter(Boolean).join(' ').toLowerCase();

  // ---------- Правка ----------
  app.patch('/api/crm/bloggers/:id', requireAuth, async (req, res) => {
    if (!canStaff(req) || !need(res) || !(await requireCutover(res))) return;
    const body = req.body || {};
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query('select data, manager from crm.bloggers where id=$1 for update', [req.params.id]);
      if (!r.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Блогер не найден' }); }
      const b = r.rows[0].data; let manager = r.rows[0].manager; let statusChanged = false;
      if (body.status !== undefined) {
        const s = String(body.status);
        if (s === 'declined') {
          if (!DECLINE[body.declineReason]) throw Object.assign(new Error('Выберите причину отказа'), { code: 400 });
          b.status = 'declined'; b.decline_reason = body.declineReason; b.in_work = false;
        } else if (TALK[s] || LEGACY[s]) { b.status = s; b.decline_reason = null; if (s === 'contacted' && !b.contacted_at) b.contacted_at = new Date().toISOString(); }
        else throw Object.assign(new Error('Неизвестный статус'), { code: 400 });
        statusChanged = true;
      }
      if (body.manager !== undefined) { manager = body.manager ? managerKey(String(body.manager)) : null; b.assigned_manager_id = manager && !manager.startsWith('bb:') ? await crmUserId(client, manager) : null; b.manager_name_bb = body.manager || null; }
      if (body.exclusive !== undefined) { if (!canExportReq(req)) throw Object.assign(new Error('Звёздочку ставят Нина и Сая'), { code: 400 }); b.is_exclusive = !!body.exclusive; }
      const fields = { lastComment: 'last_comment', notes: 'notes', whatsapp: 'blogger_whatsapp', category: 'category', name: 'name', instagram: 'instagram_url', tiktok: 'tiktok_url', managerInstagram: 'manager_instagram', managerWhatsapp: 'manager_whatsapp' };
      if (body.er !== undefined) b.er = num(body.er);
      if (body.ipRequisites && typeof body.ipRequisites === 'object') { const R = ['name', 'iin', 'head', 'address', 'iban', 'bank', 'bik', 'kbe', 'phone', 'email']; b.ip_requisites = Object.fromEntries(R.map((k) => [k, str(body.ipRequisites[k], 300) || ''])); }
      for (const [k, f] of Object.entries(fields)) if (body[k] !== undefined) b[f] = str(body[k], 2000);
      const nums = { followers: 'instagram_followers', followersTT: 'tiktok_followers', reach: 'instagram_avg_reach', reachTT: 'tiktok_avg_reach', storiesReach: 'stories_avg_reach',
        priceReels: 'price_reels', priceTiktok: 'price_tiktok', priceBoth: 'price_both', priceStories: 'price_stories' };
      for (const [k, f] of Object.entries(nums)) if (body[k] !== undefined) b[f] = num(body[k]);
      const cpv = (p, r) => p && r ? +(p / r).toFixed(2) : null;
      b.cpv_reels = cpv(b.price_reels, b.instagram_avg_reach); b.cpv_tiktok = cpv(b.price_tiktok, b.tiktok_avg_reach);
      b.cpv_both = cpv(b.price_both, (b.instagram_avg_reach || 0) + (b.tiktok_avg_reach || 0)); b.cpv_stories = cpv(b.price_stories, b.stories_avg_reach || b.instagram_avg_reach);
      if (['priceReels', 'priceTiktok', 'priceBoth', 'priceStories'].some(k => body[k] !== undefined)) b.price_updated_at = new Date().toISOString();
      b.updated_at = new Date().toISOString(); b.updated_by = req.session.name || null;
      await client.query('update crm.bloggers set data=$2, status=$3, manager=$4, nick=$5, search=$6, updated_at=now() where id=$1',
        [req.params.id, b, b.status, manager, nickOf(b.instagram_url) || nickOf(b.tiktok_url) || (b.name || '').replace('@', '').toLowerCase() || null, searchOf(b)]);
      if (statusChanged) await client.query('insert into crm.status_log(blogger_id,status,decline_reason,actor) values ($1,$2,$3,$4)', [req.params.id, b.status, b.decline_reason, req.session.name || null]);
      await client.query('COMMIT');
      const row = await pool.query('select id, data, status, manager, nick from crm.bloggers where id=$1', [req.params.id]);
      res.json(view(row.rows[0]));
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); res.status(e.code === 400 ? 400 : 500).json({ error: e.message }); }
    finally { client.release(); }
  });

  // ---------- Новый блогер (с проверкой дубля по нику) ----------
  app.post('/api/crm/bloggers', requireAuth, async (req, res) => {
    if (!canStaff(req) || !need(res) || !(await requireCutover(res))) return;
    const body = req.body || {};
    // 27.11.2026: форма как в старой CRM — ник обязателен, ссылки по желанию
    const nick = nickOf(body.instagram) || nickOf(body.tiktok) || (String(body.name || '').trim().replace(/^@/, '').toLowerCase() || null);
    if (!nick) return res.status(400).json({ error: 'Укажите ник блогера' });
    try {
      const dup = await pool.query('select id, data, manager from crm.bloggers where nick=$1 and not deleted limit 1', [nick]);
      if (dup.rows[0]) return res.status(409).json({ error: 'Такой блогер уже есть — ведёт ' + (managerName(dup.rows[0].manager) || 'никто'), id: dup.rows[0].id });
      const id = require('crypto').randomUUID();
      const now = new Date().toISOString();
      const mName = str(body.manager) || req.session.name || null; const manager = managerKey(mName);
      const st0 = TALK[body.status] ? body.status : 'new';
      const REQ = ['name', 'iin', 'head', 'address', 'iban', 'bank', 'bik', 'kbe', 'phone', 'email'];
      const ipReq = body.ipRequisites && typeof body.ipRequisites === 'object' ? Object.fromEntries(REQ.map((k) => [k, str(body.ipRequisites[k], 300) || ''])) : null;
      const b = { id, name: str(body.name) || '@' + nick, instagram_url: str(body.instagram), tiktok_url: str(body.tiktok), instagram_followers: num(body.followers), tiktok_followers: num(body.followersTT),
        instagram_avg_reach: num(body.reach), tiktok_avg_reach: num(body.reachTT), price_reels: num(body.priceReels), price_tiktok: num(body.priceTiktok), price_both: num(body.priceBoth), price_stories: num(body.priceStories),
        stories_avg_reach: num(body.storiesReach), er: num(body.er), manager_instagram: str(body.managerInstagram), manager_whatsapp: str(body.managerWhatsapp),
        ip_requisites: ipReq && Object.values(ipReq).some(Boolean) ? ipReq : undefined,
        status: st0, decline_reason: null, category: str(body.category), blogger_whatsapp: str(body.whatsapp), last_comment: str(body.lastComment, 2000), notes: str(body.notes, 4000),
        assigned_manager_id: null, manager_name_bb: mName, in_work: false, created_at: now, updated_at: now, created_by: req.session.name || null };
      b.assigned_manager_id = manager && !manager.startsWith('bb:') ? await crmUserId(pool, manager) : null;
      b.cpv_reels = b.price_reels && b.instagram_avg_reach ? +(b.price_reels / b.instagram_avg_reach).toFixed(2) : null;
      b.cpv_tiktok = b.price_tiktok && b.tiktok_avg_reach ? +(b.price_tiktok / b.tiktok_avg_reach).toFixed(2) : null;
      b.cpv_both = b.price_both && (b.instagram_avg_reach || b.tiktok_avg_reach) ? +(b.price_both / ((b.instagram_avg_reach || 0) + (b.tiktok_avg_reach || 0))).toFixed(2) : null;
      b.cpv_stories = b.price_stories && (b.stories_avg_reach || b.instagram_avg_reach) ? +(b.price_stories / (b.stories_avg_reach || b.instagram_avg_reach)).toFixed(2) : null;
      await pool.query('insert into crm.bloggers(id,data,status,manager,nick,search) values ($1,$2,$3,$4,$5,$6)', [id, b, st0, manager, nick, searchOf(b)]);
      await pool.query('insert into crm.status_log(blogger_id,status,actor) values ($1,$2,$3)', [id, st0, req.session.name || null]);
      const row = await pool.query('select id, data, status, manager, nick from crm.bloggers where id=$1', [id]);
      res.json(view(row.rows[0]));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---------- Импорт из Excel/CSV (после переезда) ----------
  const upload = require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
  const ALIASES = {
    id: ['id'], name: ['ник', 'name', 'имя', 'блогер', 'никнейм'],
    instagram_url: ['ссылкаinstagram', 'ссылкаинстаграм', 'instagram_url', 'инстаграм', 'instagram'], tiktok_url: ['ссылкаtiktok', 'ссылкатикток', 'tiktok_url', 'тикток', 'tiktok'],
    instagram_followers: ['подп.инст', 'подписчикиинстаграм', 'подписчикиинст', 'instagram_followers'], tiktok_followers: ['подп.тт', 'подписчикитикток', 'подписчикитт', 'tiktok_followers'],
    instagram_avg_reach: ['охватинст', 'среднийохватинстаграм', 'instagram_avg_reach'], tiktok_avg_reach: ['охваттт', 'среднийохваттикток', 'tiktok_avg_reach'],
    price_reels: ['ценарилс', 'стоимостьрилс', 'price_reels'], price_tiktok: ['ценатт', 'стоимостьтт', 'price_tiktok'], price_both: ['ценарилстт', 'стоимостьрилстт', 'price_both'],
    price_stories: ['ценасторис', 'стоимостьсторис', 'price_stories'], stories_avg_reach: ['охватсторис', 'stories_avg_reach'],
    status: ['статус', 'status'], last_comment: ['последнийкомментарий', 'комментарий', 'last_comment'], manager: ['менеджер', 'ответственный', 'manager'],
    category: ['категория', 'category'], blogger_whatsapp: ['whatsapp', 'ватсап', 'телефон'],
  };
  const normKey = k => String(k).toLowerCase().replace(/[\s_\-\.+\(\)₸]+/g, '');
  const STATUS_IN = { 'новый': 'new', 'написали': 'contacted', 'ответили': 'replied', 'нарассмотрении': 'considering', 'new': 'new', 'contacted': 'contacted', 'replied': 'replied', 'considering': 'considering', 'отказ': 'declined', 'declined': 'declined' };
  app.post('/api/crm/import', requireAuth, upload.single('file'), async (req, res) => {
    if (!canStaff(req) || !need(res) || !(await requireCutover(res))) return;
    if (!XLSX) return res.status(503).json({ error: 'Excel недоступен на сервере' });
    if (!req.file) return res.status(400).json({ error: 'Нет файла' });
    let rows;
    try { const wb = XLSX.read(req.file.buffer, { type: 'buffer' }); rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' }); }
    catch (e) { return res.status(400).json({ error: 'Не получилось прочитать файл: ' + e.message }); }
    if (!rows.length) return res.status(400).json({ error: 'В файле нет строк' });
    const keys = Object.keys(rows[0]); const col = {};
    for (const [f, al] of Object.entries(ALIASES)) { const k = keys.find(k => al.some(a => normKey(k) === normKey(a))) || keys.find(k => al.some(a => normKey(k).startsWith(normKey(a)))); if (k) col[f] = k; }
    if (!col.instagram_url && !col.tiktok_url && !col.id && !col.name) return res.status(400).json({ error: 'Не нашла колонки со ссылками — скачайте «Шаблон»' });
    const lead = canExportReq(req);
    const batchId = require('crypto').randomUUID(); const now = new Date().toISOString();
    let added = 0, updated = 0, skipped = 0; const errors = [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [i, row] of rows.entries()) {
        const g = f => col[f] ? String(row[col[f]] ?? '').trim() : '';
        let ig = g('instagram_url'), tt = g('tiktok_url');
        const nm = g('name');
        if (!ig && !tt && nm && /^@?[a-z0-9._]{2,30}$/i.test(nm)) ig = 'https://www.instagram.com/' + nm.replace('@', '') + '/';
        const nick = nickOf(ig) || nickOf(tt);
        let ex = null;
        if (g('id')) ex = (await client.query('select id, data, manager from crm.bloggers where id=$1', [g('id')])).rows[0];
        if (!ex && nick) ex = (await client.query('select id, data, manager from crm.bloggers where nick=$1 and not deleted limit 1', [nick])).rows[0];
        if (!ex && !nick) { skipped++; if (errors.length < 20) errors.push(`строка ${i + 2}: нет ссылки`); continue; }
        const b = ex ? ex.data : { id: require('crypto').randomUUID(), status: 'new', created_at: now, batch_id: batchId, created_by: req.session.name || null, in_work: false };
        if (nm) b.name = nm; else if (!b.name) b.name = '@' + nick;
        if (ig) b.instagram_url = ig; if (tt) b.tiktok_url = tt;
        for (const f of ['instagram_followers', 'tiktok_followers', 'instagram_avg_reach', 'tiktok_avg_reach', 'price_reels', 'price_tiktok', 'price_both', 'price_stories', 'stories_avg_reach']) {
          const v = num(String(g(f)).replace(/[^\d.,]/g, '')); if (g(f) !== '' && v !== null) { if (f.startsWith('price') && b[f] !== v) b.price_updated_at = now; b[f] = v; }
        }
        for (const f of ['last_comment', 'category', 'blogger_whatsapp']) if (g(f)) b[f] = g(f);
        const st = STATUS_IN[normKey(g('status'))]; if (st && st !== 'declined') { b.status = st; b.decline_reason = null; }
        const cpv = (p, r) => p && r ? +(p / r).toFixed(2) : null;
        b.cpv_reels = cpv(b.price_reels, b.instagram_avg_reach); b.cpv_tiktok = cpv(b.price_tiktok, b.tiktok_avg_reach);
        b.cpv_both = cpv(b.price_both, (b.instagram_avg_reach || 0) + (b.tiktok_avg_reach || 0)); b.cpv_stories = cpv(b.price_stories, b.stories_avg_reach || b.instagram_avg_reach);
        let manager = ex ? ex.manager : managerKey(req.session.name);
        if (lead && g('manager')) { const mName = USER_NAMES[g('manager').toLowerCase()] || g('manager'); manager = managerKey(mName); b.manager_name_bb = mName; }
        b.assigned_manager_id = manager && !manager.startsWith('bb:') ? await crmUserId(client, manager) : null;
        b.updated_at = now; b.updated_by = req.session.name || null;
        const nk = nickOf(b.instagram_url) || nickOf(b.tiktok_url) || nick;
        if (ex) { await client.query('update crm.bloggers set data=$2, status=$3, manager=$4, nick=$5, search=$6, updated_at=now(), deleted=false where id=$1', [ex.id, b, b.status, manager, nk, searchOf(b)]); updated++; }
        else { await client.query('insert into crm.bloggers(id,data,status,manager,nick,search) values ($1,$2,$3,$4,$5,$6)', [b.id, b, b.status, manager, nk, searchOf(b)]); added++; }
      }
      await client.query("insert into crm.items(collection,id,data) values ('batches',$1,$2)", [batchId, { id: batchId, name: req.file.originalname, created_at: now, count: added, by: req.session.name }]);
      await client.query('COMMIT');
      console.log(`CRM импорт ${req.file.originalname}: +${added}, обновлено ${updated}, пропущено ${skipped} — ${req.session.name}`);
      res.json({ ok: true, added, updated, skipped, errors });
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); res.status(500).json({ error: e.message }); }
    finally { client.release(); }
  });

  // ---------- Массовые действия и удаление (Нина и Сая) ----------
  app.post('/api/crm/bulk', requireAuth, async (req, res) => {
    if (!need(res)) return;
    if (!canExportReq(req)) return res.status(403).json({ error: 'Массовые действия — у Нины и Саи' });
    if (!(await requireCutover(res))) return;
    const { ids, action } = req.body || {};
    if (!Array.isArray(ids) || !ids.length || ids.length > 20000) return res.status(400).json({ error: 'Не выбраны блогеры' });
    try {
      if (action === 'delete') {
        const r = await pool.query("update crm.bloggers set deleted=true, updated_at=now(), data = data || jsonb_build_object('deleted_by',$2::text,'deleted_at',now()::text) where id = any($1) and not deleted", [ids, req.session.name]);
        return res.json({ ok: true, n: r.rowCount });
      }
      if (action === 'manager') {
        const name = String(req.body.manager || ''); const mk = name ? managerKey(name) : null; const uid = mk && !mk.startsWith('bb:') ? await crmUserId(pool, mk) : null;
        const r = await pool.query("update crm.bloggers set manager=$2, updated_at=now(), data = data || jsonb_build_object('assigned_manager_id',$3::text,'manager_name_bb',$4::text,'updated_at',now()::text) where id = any($1)", [ids, mk, uid, name || null]);
        return res.json({ ok: true, n: r.rowCount });
      }
      if (action === 'status') {
        const s = String(req.body.status || ''); const reason = s === 'declined' ? String(req.body.declineReason || '') : null;
        if (!(TALK[s] || (s === 'declined' && DECLINE[reason]))) return res.status(400).json({ error: 'Выберите статус' });
        const r = await pool.query("update crm.bloggers set status=$2, updated_at=now(), data = data || jsonb_build_object('status',$2::text,'decline_reason',$3::text,'updated_at',now()::text) where id = any($1)", [ids, s, reason]);
        await pool.query('insert into crm.status_log(blogger_id,status,decline_reason,actor) select unnest($1::text[]), $2, $3, $4', [ids, s, reason, req.session.name]);
        return res.json({ ok: true, n: r.rowCount });
      }
      res.status(400).json({ error: 'Неизвестное действие' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---------- Товары: один справочник (crm.items, collection='products'); меняют Нина и Сая ----------
  const prodView = r => { const d = r.data || {}; return { id: r.id, name: d.name || '', article: d.article || d.barcode || (String(r.id).startsWith('sku:') ? String(r.id).slice(4) : ''), sku: d.sku || '', category: d.category || '', cost: num(d.cost),
    tz: d.tz || (Array.isArray(d.tz_list) ? d.tz_list.join('\n') : (d.tz_list || '')), notes: d.notes || '', updatedAt: d.updated_at || null }; };
  app.get('/api/crm/products', requireAuth, async (req, res) => {
    if (!canStaff(req) || !need(res)) return;
    try { const r = await pool.query("select id, data from crm.items where collection='products' and not deleted order by data->>'name'"); res.json(r.rows.map(prodView)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  const prodBody = (b, old) => Object.assign({}, old || {}, { name: str(b.name, 200), article: str(b.article, 120), category: str(b.category, 80), cost: num(b.cost), tz: str(b.tz, 5000), notes: str(b.notes, 2000), updated_at: new Date().toISOString() });
  app.post('/api/crm/products', requireAuth, async (req, res) => {
    if (!need(res)) return; if (!canExportReq(req)) return res.status(403).json({ error: 'Товары меняют Нина и Сая' });
    if (!str((req.body || {}).name)) return res.status(400).json({ error: 'Укажите название' });
    try { const id = require('crypto').randomUUID(); const d = prodBody(req.body, { id, created_at: new Date().toISOString(), created_by: req.session.name });
      await pool.query("insert into crm.items(collection,id,data) values ('products',$1,$2)", [id, d]); res.json({ ok: true, id }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Правка или создание по коду (id «sku:КОД»). Товары, пришедшие из старой CRM, до переезда не трогаем — CRM перезапишет.
  app.put('/api/crm/products/:id', requireAuth, async (req, res) => {
    if (!need(res)) return; if (!canExportReq(req)) return res.status(403).json({ error: 'Товары меняют Нина и Сая' });
    try { const r = await pool.query("select data from crm.items where collection='products' and id=$1", [req.params.id]);
      const fromCrm = r.rows[0] && !r.rows[0].data.created_by && !String(req.params.id).startsWith('sku:');
      if (fromCrm && !(await requireCutover(res))) return;
      const d = prodBody(req.body, r.rows[0] ? r.rows[0].data : { id: req.params.id, created_at: new Date().toISOString(), created_by: req.session.name }); d.updated_by = req.session.name;
      await pool.query("insert into crm.items(collection,id,data) values ('products',$1,$2) on conflict (collection,id) do update set data=excluded.data, deleted=false, updated_at=now()", [req.params.id, d]); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.delete('/api/crm/products/:id', requireAuth, async (req, res) => {
    if (!need(res)) return; if (!canExportReq(req)) return res.status(403).json({ error: 'Товары меняют Нина и Сая' });
    try { await pool.query("update crm.items set deleted=true, updated_at=now() where collection='products' and id=$1", [req.params.id]); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/crm/products/:id/restore', requireAuth, async (req, res) => {
    if (!need(res)) return; if (!canExportReq(req)) return res.status(403).json({ error: 'Товары меняют Нина и Сая' });
    try { await pool.query("update crm.items set deleted=false, updated_at=now() where collection='products' and id=$1", [req.params.id]); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---------- Оплаты ----------
  const rcpt = (a) => (Array.isArray(a) ? a : []).map((x) => x && String(x.url || '')).filter((u) => /^https:\/\//.test(u)).slice(0, 6);
  function payView(p) {
    const d = p.data || {};
    return { id: p.id, status: p.status, statusLabel: PAY_STATUS[p.status] || p.status, bloggerId: d.blogger_id || null, blogger: p.blogger_name || null, bloggerInstagram: p.blogger_instagram || null,
      manager: managerName(p.manager) || d.manager_name_bb || null, recipient: d.recipient_name || null, iin: d.iin || null, kaspi: d.kaspi || null, name: d.payment_name || null,
      amount: num(d.amount), amountVideo: num(d.amount_video), amountProduct: num(d.amount_product), isIp: !!d.is_ip, notes: d.notes || null, approvalUrl: d.approval_url || null,
      // 25.11.2026 Нина: чеки и ссылка на согласование — как в CRM («Чек оплаты» = receipts_video, «Чек видео» = receipts_product)
      chkPay: rcpt(d.receipts_video).concat(rcpt(d.receipts)), chkVideo: rcpt(d.receipts_product),
      createdAt: d.created_at || null, updatedAt: d.updated_at || null, paidBy: d.paid_by || null };
  }
  app.get('/api/crm/payments', requireAuth, async (req, res) => {
    if (!need(res)) return;
    if (!isNina(req)) return res.status(403).json({ error: 'Оплаты видит только Нина' });
    const st = String(req.query.status || 'pending');
    try {
      const r = await pool.query(`select p.id, p.data, p.status, p.manager, b.data->>'name' blogger_name, b.data->>'instagram_url' blogger_instagram
        from crm.payments p left join crm.bloggers b on b.id = p.blogger_id
        where not p.deleted ${st === 'all' ? '' : 'and p.status = $1'} order by p.created_at desc nulls last limit 2000`, st === 'all' ? [] : [st]);
      const c = await pool.query('select status, count(*)::int n, coalesce(sum((data->>\'amount\')::numeric),0)::bigint s from crm.payments where not deleted group by 1');
      res.json({ items: r.rows.map(payView), counts: Object.fromEntries(c.rows.map(x => [x.status, { n: x.n, sum: Number(x.s) }])) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.patch('/api/crm/payments/:id', requireAuth, async (req, res) => {
    if (!need(res)) return;
    if (!isNina(req)) return res.status(403).json({ error: 'Только Нина' });
    if (!(await requireCutover(res))) return;
    const s = String((req.body || {}).status || '');
    if (!PAY_STATUS[s]) return res.status(400).json({ error: 'Неизвестный статус оплаты' });
    try {
      const r = await pool.query('select data from crm.payments where id=$1', [req.params.id]);
      if (!r.rows[0]) return res.status(404).json({ error: 'Оплата не найдена' });
      const d = r.rows[0].data; d.status = s; d.updated_at = new Date().toISOString(); if (s === 'paid') { d.paid_by = req.session.name; d.paid_at = d.updated_at; }
      await pool.query('update crm.payments set data=$2, status=$3, updated_at=now() where id=$1', [req.params.id, d, s]); syncDealPay(d.bb_deal_id, s);
      // Статус блогера «Оплачено» больше не ставим — оплата живёт отдельно (см. прототип).
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // ---------- Оплаты по прототипу (23.11.2026): Excel, импорт файла пополнения с проверкой, массовая смена статуса ----------
  const payRows = async (ids) => { const r = await pool.query(`select p.id, p.data, p.status, p.manager, b.data->>'name' blogger_name, b.data->>'instagram_url' blogger_instagram
      from crm.payments p left join crm.bloggers b on b.id = p.blogger_id where not p.deleted ${ids ? 'and p.id = any($1)' : ''} order by p.created_at desc nulls last limit 5000`, ids ? [ids] : []); return r.rows.map(payView); };
  // 23.11.2026: какие блогеры — ИП (по заявкам на оплату). Только ники/инстаграм, без реквизитов — чтобы в Barter Box везде стояла пометка «ИП».
  app.get('/api/crm/ip-bloggers', requireAuth, async (req, res) => {
    if (!need(res)) return; if (!canStaff(req)) return res.status(403).json({ error: 'Нет доступа' });
    try { const r = await pool.query(`select distinct lower(coalesce(b.data->>'instagram_url','')) ig, lower(coalesce(b.data->>'name','')) nm from crm.payments p join crm.bloggers b on b.id = p.blogger_id where not p.deleted and coalesce((p.data->>'is_ip')::boolean, false)`);
      res.json({ items: r.rows.map((x) => [x.ig, x.nm]) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Мои заявки на оплату — менеджер видит только поданные им (все статусы).
  app.get('/api/crm/payments/mine', requireAuth, async (req, res) => {
    if (!need(res)) return; if (!canStaff(req)) return res.status(403).json({ error: 'Нет доступа' });
    // 27.11.2026: тимлид — заявки своей команды, Нина и руководство — все, остальные — свои.
    try { const me = req.session.name; const sc = req.app.locals.bbScopeNames ? req.app.locals.bbScopeNames(req) : [me];
      const items = (await payRows()).filter(p => !sc || sc.includes(p.manager));
      const counts = {}; for (const p of items) { const c = counts[p.status] || (counts[p.status] = { n: 0, sum: 0 }); c.n++; c.sum += Number(p.amount) || 0; }
      res.json({ items, counts });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/crm/payments/export', requireAuth, async (req, res) => {
    if (!need(res)) return; if (!isNina(req)) return res.status(403).json({ error: 'Только Нина' }); if (!XLSX) return res.status(503).json({ error: 'Excel недоступен' });
    try { const ids = req.query.ids ? String(req.query.ids).split(',').filter(Boolean) : null; let items = await payRows(ids);
      if (!ids && req.query.status && req.query.status !== 'all') items = items.filter(p => p.status === req.query.status);
      sendXlsx(res, 'оплаты.xlsx', [['Дата', 'Менеджер', 'Блогер', 'ФИО получателя', 'ИИН', 'Kaspi', 'Видео ₸', 'Товар ₸', 'Сумма ₸', 'ИП', 'За что', 'Статус', 'Примечание'],
        ...items.map(p => [String(p.createdAt || '').slice(0, 10), p.manager || '', p.blogger || '', p.recipient || '', p.iin || '', p.kaspi || '', p.amountVideo || '', p.amountProduct || '', p.amount || 0, p.isIp ? 'ИП' : '', p.name || '', p.statusLabel, p.notes || ''])], 'Оплаты');
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  const normName = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-яәіңғүұқөһ ]/g, ' ').replace(/\s+/g, ' ').trim();
  const digits = s => String(s || '').replace(/\D/g, '');
  app.post('/api/crm/payments/import-preview', requireAuth, upload.single('file'), async (req, res) => {
    if (!need(res)) return; if (!isNina(req)) return res.status(403).json({ error: 'Только Нина' }); if (!XLSX || !req.file) return res.status(400).json({ error: 'Нужен файл Excel' });
    try {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' }); const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
      const subs = (await payRows()).filter(p => p.status === 'submitted' || p.status === 'pending');
      const used = new Set(), toPaid = [], mismatch = [], notFound = [];
      for (const row of aoa) {
        const cells = row.map(x => String(x)); const text = normName(cells.join(' ')); if (!text) continue;
        const nums = row.map(x => typeof x === 'number' ? x : Number(String(x).replace(/[\s ₸,]/g, ''))).filter(x => Number.isFinite(x) && x >= 100 && x < 100000000);
        if (!nums.length) continue;
        const dg = digits(cells.join(' '));
        const cand = subs.filter(p => !used.has(p.id) && ((() => { const nm = normName(p.recipient).split(' ').filter(Boolean); if (!nm.length || nm[0].length < 3) return false; const tw = ' ' + text + ' '; return tw.includes(' ' + nm[0] + ' ') && (!nm[1] || tw.includes(' ' + nm[1].slice(0, 1))); })() || (digits(p.kaspi).length >= 10 && dg.includes(digits(p.kaspi).slice(-10)))));
        if (!cand.length) { notFound.push({ row: cells.filter(Boolean).join(' · ').slice(0, 160), amount: nums[0] }); continue; }
        const hit = cand.find(p => nums.includes(Number(p.amount)));
        if (hit) { used.add(hit.id); toPaid.push({ id: hit.id, blogger: hit.blogger, recipient: hit.recipient, amount: hit.amount, status: hit.statusLabel }); }
        else mismatch.push({ id: cand[0].id, blogger: cand[0].blogger, recipient: cand[0].recipient, amount: cand[0].amount, fileAmount: nums[0], status: cand[0].statusLabel });
      }
      res.json({ file: req.file.originalname, rows: aoa.length, toPaid, mismatch, notFound });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/crm/payments/bulk', requireAuth, async (req, res) => {
    if (!need(res)) return; if (!isNina(req)) return res.status(403).json({ error: 'Только Нина' }); if (!(await requireCutover(res))) return;
    const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map(String) : []; const s = String((req.body || {}).status || '');
    if (!ids.length || !PAY_STATUS[s]) return res.status(400).json({ error: 'Нужны ids и статус' });
    try { let n = 0; const now = new Date().toISOString();
      for (const id of ids) { const r = await pool.query('select data from crm.payments where id=$1', [id]); if (!r.rows[0]) continue; const d = r.rows[0].data; d.status = s; d.updated_at = now; if (s === 'paid') { d.paid_by = req.session.name; d.paid_at = now; }
        await pool.query('update crm.payments set data=$2, status=$3, updated_at=now() where id=$1', [id, d, s]); syncDealPay(d.bb_deal_id, s); n++; }
      res.json({ ok: true, n });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Менеджер подаёт на оплату. Наличные/Kaspi (не ИП) — сумма кратна 500.
  app.post('/api/crm/payments', requireAuth, async (req, res) => {
    if (!canStaff(req) || !need(res) || !(await requireCutover(res))) return;
    const b = req.body || {};
    const amount = num(b.amount);
    if (!b.bloggerId) return res.status(400).json({ error: 'Не выбран блогер' });
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Укажите сумму' });
    if (!b.isIp && amount % 500 !== 0) return res.status(400).json({ error: 'Сумму наличными округлите до 500 ₸ (например ' + (Math.round(amount / 500) * 500).toLocaleString('ru-RU') + ')' });
    if (!str(b.recipient)) return res.status(400).json({ error: 'Укажите получателя (ФИО)' });
    if (!b.isIp && !str(b.kaspi)) return res.status(400).json({ error: 'Укажите номер Kaspi' });
    try {
      const bl = await pool.query('select id from crm.bloggers where id=$1', [b.bloggerId]);
      if (!bl.rows[0]) return res.status(404).json({ error: 'Блогер не найден' });
      const id = require('crypto').randomUUID(); const now = new Date().toISOString();
      const manager = managerKey(req.session.name);
      const d = { id, blogger_id: b.bloggerId, manager_id: manager && !manager.startsWith('bb:') ? await crmUserId(pool, manager) : null, manager_name_bb: req.session.name || null,
        recipient_name: str(b.recipient), iin: str(b.iin, 20), kaspi: str(b.kaspi, 40), payment_name: str(b.name), amount, amount_video: num(b.amountVideo), amount_product: num(b.amountProduct),
        is_ip: !!b.isIp, notes: str(b.notes, 1000), status: 'pending', created_at: now, updated_at: now, created_by_bb: req.session.name || null, bb_deal_id: str(b.dealId, 80) };
      // 27.11.2026: заявка может быть за несколько интеграций или вовсе без интеграции
      const extra = Array.isArray(b.dealIds) ? b.dealIds.map(String).filter((x) => x && x !== String(b.dealId || '')).slice(0, 20) : [];
      if (extra.length) d.flow_integration_ids = extra;
      await pool.query('insert into crm.payments(id,data,status,blogger_id,manager,created_at) values ($1,$2,$3,$4,$5,$6)', [id, d, 'pending', b.bloggerId, manager, now]); syncDealPay(b.dealId, 'pending'); for (const x of extra) syncDealPay(x, 'pending');
      res.json({ ok: true, id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---------- Переезд (только Нина) ----------
  app.post('/api/crm/cutover', requireAuth, async (req, res) => {
    if (!need(res)) return;
    if (!isNina(req)) return res.status(403).json({ error: 'Только Нина' });
    if ((req.body || {}).confirm !== 'ПЕРЕЕЗД') return res.status(400).json({ error: 'Нужно подтверждение' });
    try {
      const p = await pool.query("select value, updated_at from crm.meta where key='last_crm_push'");
      if (!p.rows[0] || Date.now() - new Date(p.rows[0].updated_at).getTime() > 15 * 60e3) return res.status(409).json({ error: 'Свежих данных из CRM нет (последние старше 15 минут) — сначала нужно, чтобы CRM прислала данные' });
      const value = { at: new Date().toISOString(), by: req.session.name };
      await pool.query("insert into crm.meta(key,value) values ('cutover',$1) on conflict (key) do update set value=excluded.value, updated_at=now()", [value]);
      cutoverCache = { at: 0, value: null };
      res.json({ ok: true, cutover: value });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---------- Копии после переезда: база Константина (crm_blogers.*) и резервная (public.*) ----------
  const KOST_B = ['id', 'name', 'instagram_url', 'tiktok_url', 'instagram_followers', 'tiktok_followers', 'instagram_avg_reach', 'tiktok_avg_reach', 'price_reels', 'price_tiktok', 'price_both', 'price_stories',
    'cpv_reels', 'cpv_tiktok', 'cpv_both', 'status', 'category', 'manager_name', 'last_comment', 'notes', 'in_work', 'created_at', 'updated_at'];
  const KOST_P = ['id', 'blogger_id', 'blogger_name', 'manager_name', 'recipient_name', 'iin', 'payment_name', 'kaspi', 'amount', 'amount_video', 'amount_product', 'status', 'approval_url', 'notes', 'created_at', 'updated_at'];
  const MY_B = [...KOST_B.slice(0, 18), 'assigned_manager_id', 'manager_instagram', 'last_comment', 'notes', 'in_work', 'created_at', 'updated_at'];
  const MY_P = ['id', 'blogger_id', 'blogger_name', 'manager_id', 'manager_name', 'recipient_name', 'iin', 'payment_name', 'kaspi', 'amount', 'amount_video', 'amount_product', 'status', 'approval_url', 'notes', 'linked_payment_id', 'created_at', 'updated_at'];
  async function upsert(db, table, cols, rows) {
    if (!rows.length) return;
    const vals = []; const ph = rows.map((r, i) => '(' + cols.map((c, j) => { vals.push(r[c] === undefined ? null : r[c]); return '$' + (i * cols.length + j + 1); }).join(',') + ')').join(',');
    await db.query(`insert into ${table} (${cols.join(',')}) values ${ph} on conflict (id) do update set ${cols.filter(c => c !== 'id').map(c => c + '=excluded.' + c).join(',')}`, vals);
  }
  let mirroring = false;
  async function mirror() {
    if (!pool || mirroring || !(await cutover())) return;
    mirroring = true; const t0 = Date.now();
    try {
      const m = await pool.query("select value from crm.meta where key='bb_mirror_at'");
      const since = (m.rows[0] && m.rows[0].value && m.rows[0].value.at) || (await cutover()).at;
      const startedAt = new Date().toISOString();
      const bs = await pool.query('select id, data, manager, deleted from crm.bloggers where updated_at > $1', [since]);
      const ps = await pool.query("select p.id, p.data, p.manager, p.deleted, b.data->>'name' bname from crm.payments p left join crm.bloggers b on b.id=p.blogger_id where p.updated_at > $1", [since]);
      const bRows = bs.rows.filter(r => !r.deleted).map(r => ({ ...r.data, id: r.id, manager_name: r.manager && !r.manager.startsWith('bb:') ? r.manager : (r.data.manager_name_bb || null), in_work: !!r.data.in_work }));
      const pRows = ps.rows.filter(r => !r.deleted).map(r => ({ ...r.data, id: r.id, blogger_name: r.bname || null, manager_name: r.manager && !r.manager.startsWith('bb:') ? r.manager : (r.data.manager_name_bb || null) }));
      const dropB = bs.rows.filter(r => r.deleted).map(r => r.id), dropP = ps.rows.filter(r => r.deleted).map(r => r.id);
      const chunks = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
      if (kostPool && env.SUPABASE_PLACEMENTS_URL) {
        for (const c of chunks(bRows, 300)) await upsert(kostPool, 'crm_blogers.bloggers', KOST_B, c);
        for (const c of chunks(pRows, 300)) await upsert(kostPool, 'crm_blogers.payments', KOST_P, c);
        if (dropB.length) await kostPool.query('delete from crm_blogers.bloggers where id = any($1)', [dropB]);
        if (dropP.length) await kostPool.query('delete from crm_blogers.payments where id = any($1)', [dropP]);
      }
      for (const c of chunks(bRows, 300)) await upsert(pool, 'public.bloggers', MY_B, c);
      for (const c of chunks(pRows, 300)) await upsert(pool, 'public.payments', MY_P, c);
      await pool.query("insert into crm.meta(key,value) values ('bb_mirror_at',$1) on conflict (key) do update set value=excluded.value, updated_at=now()",
        [{ at: startedAt, bloggers: bRows.length, payments: pRows.length, ms: Date.now() - t0 }]);
      if (bRows.length || pRows.length) console.log(`CRM-копии: ${bRows.length} блогеров, ${pRows.length} оплат → Константин и резерв, ${Date.now() - t0} мс`);
    } catch (e) { console.error('CRM-копии: ошибка', e.message); }
    finally { mirroring = false; }
  }
  if (pool) { setInterval(() => mirror().catch(() => {}), 2 * 60 * 1000); setTimeout(() => mirror().catch(() => {}), 30000); }
  // 24.11.2026 Нина: «оплачено» ставят прямо в Blogger CRM (оплата не связана с интеграцией). Ловим переход в paid
  // (снимок статусов — state.crmPaySeen) и кладём в очередь state.crmPaidQueue → coordinator.js шлёт блогеру «Оплата прошла».
  // Статус интеграции НЕ меняем (Нина: «не надо проставлять, главное уведомление»). Связанные оплаты ведут syncDealPay / finance-client.
  let payWatching = false;
  async function payWatch() {
    if (!pool || payWatching) return; payWatching = true;
    try {
      const st = getState() || {};
      const r = await pool.query("select p.id, p.status, p.blogger_id, p.created_at, p.manager, p.data->>'amount' amount, p.data->>'bb_deal_id' bb, p.data->'flow_integration_ids' fi, b.data->>'instagram_url' ig, b.data->>'tiktok_url' tt, b.data->>'blogger_whatsapp' wa from crm.payments p left join crm.bloggers b on b.id = p.blogger_id where not p.deleted and p.created_at > now() - interval '120 days'");
      const seen = st.crmPaySeen && typeof st.crmPaySeen === 'object' ? st.crmPaySeen : null, next = {};
      for (const x of r.rows) next[x.id] = x.status;
      if (!seen) { st.crmPaySeen = next; if (persist) persist(); return; } // первый запуск: только запоминаем, по старым не пишем
      const q = Array.isArray(st.crmPaidQueue) ? st.crmPaidQueue : (st.crmPaidQueue = []);
      let changed = Object.keys(seen).length !== r.rows.length;
      for (const x of r.rows) {
        const was = seen[x.id]; if (was === x.status) continue; changed = true;
        if (x.status !== 'paid') continue;
        if (was === undefined && Date.now() - Date.parse(x.created_at) > 3 * 864e5) continue;
        const dealIds = [x.bb, ...(Array.isArray(x.fi) ? x.fi : [])].filter(Boolean).map(String); // 25.11: и связанные с интеграцией тоже
        if (q.some((e) => e.id === x.id)) continue;
        q.push({ id: x.id, bloggerId: String(x.blogger_id || ''), nicks: [nickOf(x.ig), nickOf(x.tt)].filter(Boolean), wa: x.wa || '', manager: managerName(x.manager) || '', amount: Number(x.amount) || 0, dealIds, at: new Date().toISOString() });
      }
      if (q.length > 400) q.splice(0, q.length - 400);
      st.crmPaySeen = next;
      if (changed && persist) persist();
    } catch (e) { console.error('Оплаты CRM → уведомления:', e.message); } finally { payWatching = false; }
  }
  if (pool) { setInterval(() => payWatch().catch(() => {}), 60 * 1000); setTimeout(() => payWatch().catch(() => {}), 40000); }

  // 24.11.2026 Нина: «у 99.aiym видео вышли, а стоит „не оплачено“ — хотя ей оплатили». В Blogger CRM оплату заводят на блогера
  // (часто сразу за несколько видео), а не на интеграцию. Сверка раз в 10 минут: идём по оплаченным заявкам CRM по порядку дат и
  // «раскладываем» сумму на интеграции этого блогера у того же менеджера (−45…+35 дней от даты оплаты): сначала уже оплаченные,
  // потом остальные — пока хватает суммы. Покрытые целиком → «оплачено» (paidSkip: уведомление блогеру не шлём — оплата прошлая).
  const nickOk = (v) => { const n = nickOf(v); return n && /^[a-z0-9._]+$/.test(n) ? n : null; };
  let reconBusy = false;
  async function payReconcile() {
    if (!pool || reconBusy) return; reconBusy = true;
    try {
      const st = getState() || {}; const deals = st.microInfluencerDeals || [];
      const r = await pool.query("select p.id, p.blogger_id, p.manager, p.created_at, p.updated_at, p.data->>'amount' amount, p.data->>'bb_deal_id' bb, p.data->'flow_integration_ids' fi, b.nick, b.data->>'instagram_url' ig, b.data->>'tiktok_url' tt from crm.payments p left join crm.bloggers b on b.id = p.blogger_id where not p.deleted and p.status = 'paid' order by p.created_at");
      const byKey = new Map(); const add = (k, d) => { let a = byKey.get(k); if (!a) byKey.set(k, a = []); if (!a.includes(d)) a.push(d); };
      for (const d of deals) { if (d.crmBloggerId) add('id:' + d.crmBloggerId, d); for (const v of [d.blogerName, d.instagramAccount, d.tiktokAccount]) { const n = nickOk(v); if (n) add('n:' + n, d); } }
      const dateOf = (d) => String(d.publishDate || d.plannedDate || d.createdAt || '').slice(0, 10);
      const used = new Set(); let changed = 0;
      for (const p of r.rows) {
        if (p.bb || (Array.isArray(p.fi) && p.fi.length)) continue;
        let rem = Number(p.amount) || 0; if (rem <= 0) continue;
        const pd = new Date(p.created_at).getTime(), mg = managerName(p.manager), only = mg && !['Нина', 'бот'].includes(mg) ? mg : null;
        const cand = new Set(byKey.get('id:' + p.blogger_id) || []);
        for (const v of [p.nick, p.ig, p.tt]) { const n = nickOk(v); if (n) (byKey.get('n:' + n) || []).forEach((d) => cand.add(d)); }
        const list = [...cand].filter((d) => !used.has(d.id) && (Number(d.cost) || 0) > 0 && !/отмен/i.test(String(d.problemStatus || '')) && (!only || d.responsible === only))
          .filter((d) => { const t = Date.parse(dateOf(d) + 'T12:00:00'); if (!Number.isFinite(t)) return false; const days = (t - pd) / 864e5; return days >= -45 && days <= 35; })
          .sort((a, b) => dateOf(a).localeCompare(dateOf(b)) || a.id - b.id);
        for (const d of list) if (d.paymentStatus === 'оплачено' && Number(d.cost) <= rem + 1) { used.add(d.id); rem -= Number(d.cost); }
        for (const d of list) if (d.paymentStatus !== 'оплачено' && !used.has(d.id) && Number(d.cost) <= rem + 1) {
          used.add(d.id); rem -= Number(d.cost); changed++;
          Object.assign(d, { paymentStatus: 'оплачено', paidAt: new Date(p.updated_at || p.created_at).toISOString(), paidBy: 'Blogger CRM (сверка)', crmPaymentId: p.id, paidSkip: true });
        }
      }
      if (changed) { console.log('Сверка оплат CRM → интеграции: «оплачено» у ' + changed); if (persist) persist(); }
    } catch (e) { console.error('Сверка оплат CRM:', e.message); } finally { reconBusy = false; }
  }
  if (pool) { setInterval(() => payReconcile().catch(() => {}), 10 * 60 * 1000); setTimeout(() => payReconcile().catch(() => {}), 90000); }

  // 24.11.2026 Нина: «Подать на оплату» из «Блогеров» / «Оплат» — прошлые реквизиты блогера (ФИО, ИИН, Kaspi, сумма) подтягиваются по памяти.
  app.get('/api/crm/pay-history', requireAuth, async (req, res) => {
    if (!need(res)) return; if (!canStaff(req) || req.session.readOnly) return res.status(403).json({ error: 'Нет доступа' });
    const id = String(req.query.bloggerId || '').trim(), nick = nickOk(req.query.nick || '') || '';
    if (!id && !nick) return res.json({ blogger: null, items: [] });
    try {
      const b = await pool.query("select id, nick, data from crm.bloggers where not deleted and ((id = $1 and $1 <> '') or ($2 <> '' and (lower(nick) = $2 or lower(data->>'instagram_url') ~ ('instagram\\.com/' || $2 || '([/?#]|$)') or lower(data->>'tiktok_url') ~ ('@' || $2 || '([/?#]|$)')))) limit 5", [id, nick]);
      const ids = b.rows.map((x) => x.id); const bb = b.rows.find((x) => x.id === id) || b.rows[0] || null;
      const r = ids.length ? await pool.query("select id from crm.payments where not deleted and blogger_id = any($1) order by created_at desc nulls last limit 8", [ids]) : { rows: [] };
      const items = r.rows.length ? (await payRows(r.rows.map((x) => x.id))) : [];
      const dd = (bb && bb.data) || {};
      res.json({ blogger: bb ? { id: bb.id, nick: bb.nick || nickOf(dd.instagram_url), whatsapp: dd.blogger_whatsapp || '', price: { reels: num(dd.price_reels), tiktok: num(dd.price_tiktok), both: num(dd.price_both), stories: num(dd.price_stories) } } : null,
        items: items.map((p) => ({ createdAt: p.createdAt, status: p.status, statusLabel: p.statusLabel, amount: p.amount, amountVideo: p.amountVideo, amountProduct: p.amountProduct, recipient: p.recipient, iin: p.iin, kaspi: p.kaspi, isIp: p.isIp, name: p.name })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = { mount, nickOf, statusLabels: { TALK, DECLINE, PAY_STATUS } };
