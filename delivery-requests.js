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
    const items = isLead(req) && req.query.mine !== '1' ? all : all.filter((r) => r.createdBy === name || r.manager === name);
    res.json({ lead: isLead(req), items: items.slice().reverse().map(view) });
  });

  app.post('/api/delivery-requests', requireAuth, (req, res) => {
    if (!isStaff(req)) return res.status(403).json({ error: 'Нет доступа' });
    const b = req.body || {}; const st = getState();
    const deal = (st.microInfluencerDeals || []).find((d) => d.id === +b.dealId);
    if (!deal) return res.status(404).json({ error: 'Интеграция не найдена' });
    const items = (Array.isArray(b.items) ? b.items : []).map((x) => ({ name: String(x.name || '').slice(0, 200), code: String(x.code || '').slice(0, 60), qty: Math.max(1, parseInt(x.qty, 10) || 1), cost: num(x.cost) })).filter((x) => x.name || x.code);
    if (!items.length) return res.status(400).json({ error: 'Добавьте, что отправляем' });
    if (!String(b.address || '').trim()) return res.status(400).json({ error: 'Укажите адрес' });
    if (!String(b.phone || '').trim()) return res.status(400).json({ error: 'Укажите телефон блогера' });
    const productCost = items.reduce((s, x) => s + x.cost * x.qty, 0);
    const all = list(); const id = (all.reduce((m, r) => Math.max(m, r.id), 0) || 0) + 1;
    const r = { id, dealId: deal.id, createdAt: new Date().toISOString(), createdBy: req.session.name || '', manager: deal.responsible || req.session.name || '',
      blogger: String(b.blogger || deal.instagramAccount || deal.blogerName || '').slice(0, 120), phone: String(b.phone).slice(0, 40), city: String(b.city || deal.city || '').slice(0, 80),
      address: String(b.address).slice(0, 300), items, productCost, deliveryCost: num(b.deliveryCost), note: String(b.note || '').slice(0, 500), status: 'new', history: [{ at: new Date().toISOString(), by: req.session.name, status: 'new' }] };
    all.push(r);
    // в интеграцию: себестоимость набора, «отправим», товар заказан; адрес/телефон — если были пустые
    deal.productCost = productCost; deal.productDelivery = 'ship'; deal.productStatus = 'товар заказан';
    if (!deal.address) deal.address = r.address; if (!deal.city && r.city) deal.city = r.city; if (!deal.phone) deal.phone = r.phone;
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
