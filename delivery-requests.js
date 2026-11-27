// Заявки на доставку (прототип X10, 23.11.2026).
// Менеджер подаёт из карточки интеграции: адрес, что отправляем (ШК × кол-во) и себестоимость — она идёт в расходы интеграции.
// Сая и Нина видят все заявки: Новая → Подано логисту (файл для логиста) → Доставлено / Не доставлено.
// «Доставлено» ставит в интеграции «товар доставлен» (даты не трогаем — 23.11.2026 без «+2 дня»).
'use strict';
const LEADS = new Set(['Нина', 'Сая']);
const STATUS = { new: 'Новая', sent: 'Подано логисту', delivered: 'Доставлено', failed: 'Не доставлено' };

function mount(app, { getState, requireAuth, persist }) {
  const list = () => { const st = getState(); if (!Array.isArray(st.deliveryRequests)) st.deliveryRequests = []; return st.deliveryRequests; };
  const isLead = (req) => !!(req.session && LEADS.has(req.session.name) && req.session.canExport);
  const isStaff = (req) => !!(req.session && (req.session.role === 'marketer' || req.session.role === 'manager') && !req.session.readOnly);
  const view = (r) => Object.assign({}, r, { statusLabel: STATUS[r.status] || r.status });
  const addDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const today = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
  const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/[\s ₸]/g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };

  app.get('/api/delivery-requests', requireAuth, (req, res) => {
    if (!isStaff(req)) return res.status(403).json({ error: 'Нет доступа' });
    const all = list(); const name = req.session.name;
    // 27.11.2026: тимлид — заявки своей команды, Нина и руководство — все, остальные — свои.
    const sc = req.app.locals.bbScopeNames ? req.app.locals.bbScopeNames(req) : (isLead(req) ? null : [name]);
    const own = (r) => r.createdBy === name || r.manager === name;
    const items = req.query.mine === '1' ? all.filter(own) : (!sc ? all : all.filter((r) => own(r) || sc.includes(r.createdBy) || sc.includes(r.manager)));
    res.json({ lead: isLead(req), items: items.slice().reverse().map(view) });
  });

  app.post('/api/delivery-requests', requireAuth, (req, res) => {
    if (!isStaff(req)) return res.status(403).json({ error: 'Нет доступа' });
    const b = req.body || {}; const st = getState();
    // 24.11.2026 Нина: доставку можно подать и без интеграции (отправляют несколько товаров, а снимают на один / интеграции ещё нет).
    const deal = b.dealId ? (st.microInfluencerDeals || []).find((d) => d.id === +b.dealId) : null;
    if (b.dealId && !deal) return res.status(404).json({ error: 'Интеграция не найдена' });
    if (!deal && !String(b.blogger || '').replace('@', '').trim()) return res.status(400).json({ error: 'Укажите блогера' });
    const items = (Array.isArray(b.items) ? b.items : []).map((x) => ({ name: String(x.name || '').slice(0, 200), code: String(x.code || '').slice(0, 60), qty: Math.max(1, parseInt(x.qty, 10) || 1), cost: num(x.cost) })).filter((x) => x.name || x.code);
    if (!items.length) return res.status(400).json({ error: 'Добавьте, что отправляем' });
    if (!String(b.address || '').trim()) return res.status(400).json({ error: 'Укажите адрес' });
    if (!String(b.phone || '').trim()) return res.status(400).json({ error: 'Укажите телефон блогера' });
    const productCost = items.reduce((s, x) => s + x.cost * x.qty, 0);
    const all = list(); const id = (all.reduce((m, r) => Math.max(m, r.id), 0) || 0) + 1;
    const dd = deal || {};
    const r = { id, dealId: deal ? deal.id : null, createdAt: new Date().toISOString(), createdBy: req.session.name || '', manager: dd.responsible || req.session.name || '',
      blogger: String(b.blogger || dd.instagramAccount || dd.blogerName || '').slice(0, 120), phone: String(b.phone).slice(0, 40), city: String(b.city || dd.city || '').slice(0, 80),
      address: String(b.address).slice(0, 300), items, productCost, deliveryCost: num(b.deliveryCost), note: String(b.note || '').slice(0, 500), status: 'new', history: [{ at: new Date().toISOString(), by: req.session.name, status: 'new' }] };
    all.push(r);
    // в интеграцию: себестоимость набора, «отправим», товар заказан; адрес/телефон — если были пустые
    if (deal) { deal.productCost = productCost; deal.productDelivery = 'ship'; deal.productStatus = 'товар заказан';
      if (!deal.address) deal.address = r.address; if (!deal.city && r.city) deal.city = r.city; if (!deal.phone) deal.phone = r.phone; }
    persist(); res.json(view(r));
  });

  const setStatus = (req, ids, status) => {
    const st = getState(); const all = list(); let n = 0;
    for (const r of all) {
      if (!ids.includes(r.id)) continue;
      r.status = status; r.history = (r.history || []).concat({ at: new Date().toISOString(), by: req.session.name, status }); n++;
      if (status === 'sent') r.sentAt = new Date().toISOString();
      const deal = (st.microInfluencerDeals || []).find((d) => d.id === r.dealId);
      if (status === 'delivered') { r.deliveredAt = new Date().toISOString();
        if (deal) { deal.productStatus = 'товар доставлен'; deal.productDeliveredAt = today(); } }
      if (status === 'failed' && deal) deal.problemReason = 'Товар не доставлен — проверьте адрес';
    }
    persist(); return n;
  };
  app.post('/api/delivery-requests/status', requireAuth, (req, res) => {
    if (!isLead(req)) return res.status(403).json({ error: 'Статус меняют Сая и Нина' });
    const ids = (Array.isArray((req.body || {}).ids) ? req.body.ids : []).map(Number); const s = String((req.body || {}).status || '');
    if (!ids.length || !STATUS[s]) return res.status(400).json({ error: 'Нужны заявки и статус' });
    res.json({ ok: true, n: setStatus(req, ids, s) });
  });
  app.delete('/api/delivery-requests/:id', requireAuth, (req, res) => {
    const all = list(); const i = all.findIndex((r) => r.id === +req.params.id); if (i < 0) return res.status(404).json({ error: 'Нет заявки' });
    const r = all[i]; if (!(isLead(req) || (r.createdBy === req.session.name && r.status === 'new'))) return res.status(403).json({ error: 'Отменить можно только свою новую заявку' });
    all.splice(i, 1); persist(); res.json({ ok: true });
  });
  // 23.11.2026: импорт списка «Бартер — логист» из Excel (Сая и Нина). Колонки: Дата, Менеджер, Ник, Город, Адрес, Телефон, Товары.
  // Адреса и телефоны блогеров живут только в данных Barter Box — в репозиторий не кладём.
  const upload = require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
  const MGR = { oxana: 'Оксана', sabrina: 'Сабрина', anastasiia: 'Анастасия', anastasia: 'Анастасия', ajar: 'Ажар', azhar: 'Ажар', kamila: 'Камила', madina: 'Мадина', marina: 'Марина', zarina: 'Зарина', nadira: 'Надира', anelya: 'Анеля', anel: 'Анеля' };
  app.post('/api/delivery-requests/import', requireAuth, upload.single('file'), (req, res) => {
    if (!isLead(req)) return res.status(403).json({ error: 'Импорт — только Сая и Нина' });
    let XLSX; try { XLSX = require('xlsx'); } catch (e) { return res.status(503).json({ error: 'Excel недоступен' }); }
    if (!req.file) return res.status(400).json({ error: 'Нет файла' });
    let rows; try { const wb = XLSX.read(req.file.buffer, { type: 'buffer' }); rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' }); } catch (e) { return res.status(400).json({ error: 'Не читается файл' }); }
    const pick = (r, ...ks) => { for (const k of Object.keys(r)) if (ks.some((x) => k.toLowerCase().includes(x))) return String(r[k]).trim(); return ''; };
    const norm = (v) => { let x = String(v || '').trim().toLowerCase(); if (x.includes('instagram.com/')) x = x.split('instagram.com/')[1].split(/[/?#]/)[0]; if (x.includes('tiktok.com/')) x = x.split('tiktok.com/')[1].split(/[/?#]/)[0]; return x.replace(/^@/, ''); };
    const st = getState(); const all = list(); const deals = st.microInfluencerDeals || []; let id = all.reduce((m, r) => Math.max(m, r.id || 0), 0); let added = 0, skipped = 0;
    const status = STATUS[String(req.body && req.body.status || '')] ? req.body.status : 'sent';
    for (const r of rows) {
      const nick = norm(pick(r, 'ник', 'блогер')); if (!nick) continue;
      const m0 = pick(r, 'менеджер'); const manager = MGR[m0.toLowerCase()] || m0;
      const phone = pick(r, 'телефон').replace(/[^\d+]/g, ''); const day = /^\d{4}-\d{2}-\d{2}/.test(pick(r, 'дата')) ? pick(r, 'дата').slice(0, 10) : today();
      if (all.some((x) => norm(x.blogger) === nick && String(x.phone || '').replace(/[^\d+]/g, '') === phone && x.status !== 'failed')) { skipped++; continue; }
      const cands = deals.filter((d) => [d.instagramAccount, d.tiktokAccount, d.blogerName].some((v) => norm(v) === nick));
      const deal = cands.filter((d) => d.responsible === manager).sort((a, b) => b.id - a.id)[0] || cands.sort((a, b) => b.id - a.id)[0];
      const at = day + 'T09:00:00.000Z';
      all.push({ id: ++id, dealId: deal ? deal.id : null, createdAt: at, createdBy: manager, manager, blogger: '@' + nick, phone, city: pick(r, 'город'), address: pick(r, 'адрес'),
        items: [{ name: pick(r, 'товар'), code: '', qty: 1, cost: 0 }], productCost: 0, deliveryCost: 0, note: 'импорт списка логиста ' + today().slice(8, 10) + '.' + today().slice(5, 7), status,
        sentAt: status === 'sent' ? at : undefined, history: [{ at: new Date().toISOString(), by: req.session.name, status }] });
      added++;
    }
    persist(); res.json({ ok: true, added, skipped });
  });
  // Файл для логиста (новые → «Подано логисту») и Excel по фильтру — только Сая и Нина
  app.get('/api/delivery-requests/export', requireAuth, (req, res) => {
    if (!isLead(req)) return res.status(403).json({ error: 'Только Сая и Нина' });
    let XLSX; try { XLSX = require('xlsx'); } catch (e) { return res.status(503).json({ error: 'Excel недоступен' }); }
    const ids = String(req.query.ids || '').split(',').filter(Boolean).map(Number); const logist = req.query.logist === '1';
    const rows = list().filter((r) => !ids.length || ids.includes(r.id));
    const what = (r) => r.items.map((x) => x.name + (x.qty > 1 ? ' ×' + x.qty : '')).join(', ');
    const aoa = logist ? [['№', 'Блогер', 'Телефон', 'Город', 'Адрес', 'Что отправляем', 'Комментарий'], ...rows.map((r, i) => [i + 1, r.blogger, r.phone, r.city, r.address, what(r), r.note || ''])]
      : [['Дата', 'Менеджер', 'Блогер', 'Телефон', 'Город', 'Адрес', 'Что отправляем', 'Себестоимость ₸', 'Доставка ₸', 'Статус'], ...rows.map((r) => [String(r.createdAt).slice(0, 10), r.manager, r.blogger, r.phone, r.city, r.address, what(r), r.productCost, r.deliveryCost, STATUS[r.status]])];
    if (logist) setStatus(req, rows.filter((r) => r.status === 'new').map((r) => r.id), 'sent');
    const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = aoa[0].map(() => ({ wch: 22 })); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Доставки');
    const fn = logist ? 'для_логиста.xlsx' : 'заявки_на_доставку.xlsx';
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fn)}`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  });
}
module.exports = { mount, STATUS };
