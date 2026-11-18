'use strict';
// Договор и счёт на оплату для блогера-ИП прямо из интеграции (18.11.2026).
// Шаблон договора — Word с полями {{…}}, загружается в Barter Box и лежит в DATA_DIR.
// Реквизиты MIXIT (Заказчик) — только в переменной CONTRACT_CUSTOMER_JSON (репозиторий публичный).
// Без внешних библиотек: docx — это zip, читаем/пишем его через zlib.
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const multer = require('multer');

// ---------- zip ----------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function unzip(buf) {
  let eocd = -1; for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw Error('not zip');
  const count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16); const out = {};
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw Error('bad zip');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), loff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    const lnl = buf.readUInt16LE(loff + 26), lel = buf.readUInt16LE(loff + 28); const data = buf.slice(loff + 30 + lnl + lel, loff + 30 + lnl + lel + csize);
    if (!name.endsWith('/')) out[name] = method === 0 ? Buffer.from(data) : method === 8 ? zlib.inflateRawSync(data) : (() => { throw Error('zip method'); })();
    p += 46 + nlen + elen + clen;
  }
  return out;
}
function zip(files) {
  const locals = [], central = []; let off = 0;
  for (const [name, raw] of Object.entries(files)) {
    const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw); const comp = zlib.deflateRawSync(data); const nb = Buffer.from(name, 'utf8'); const crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x5921, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x5921, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, comp); central.push(ch, nb); off += 30 + nb.length + comp.length;
  }
  const cd = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---------- текст ----------
const MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const COUNT_WORDS = ['ноль','один','два','три','четыре','пять','шесть','семь','восемь','девять','десять'];
function numberWords(n) {
  n = Math.floor(Math.abs(Number(n) || 0)); if (!n) return 'ноль';
  const ones = [['','один','два','три','четыре','пять','шесть','семь','восемь','девять'], ['','одна','две','три','четыре','пять','шесть','семь','восемь','девять']];
  const teens = ['десять','одиннадцать','двенадцать','тринадцать','четырнадцать','пятнадцать','шестнадцать','семнадцать','восемнадцать','девятнадцать'];
  const tens = ['','','двадцать','тридцать','сорок','пятьдесят','шестьдесят','семьдесят','восемьдесят','девяносто'];
  const hundreds = ['','сто','двести','триста','четыреста','пятьсот','шестьсот','семьсот','восемьсот','девятьсот'];
  const plural = (x, f) => { const a = x % 100, b = x % 10; return a > 10 && a < 20 ? f[2] : b === 1 ? f[0] : b >= 2 && b <= 4 ? f[1] : f[2]; };
  const triad = (x, fem) => { const o = [hundreds[Math.floor(x / 100)]]; const t = x % 100; if (t >= 10 && t < 20) o.push(teens[t - 10]); else { o.push(tens[Math.floor(t / 10)]); o.push(ones[fem ? 1 : 0][t % 10]); } return o.filter(Boolean).join(' '); };
  const parts = [], m = Math.floor(n / 1e6), th = Math.floor(n / 1e3) % 1000, r = n % 1000;
  if (m) parts.push(triad(m, false) + ' ' + plural(m, ['миллион','миллиона','миллионов']));
  if (th) parts.push(triad(th, true) + ' ' + plural(th, ['тысяча','тысячи','тысяч']));
  if (r) parts.push(triad(r, false));
  return parts.join(' ');
}
const money = n => Math.round(Number(n) || 0).toLocaleString('ru-RU').replace(/\u00a0|\u202f/g, ' ');
const xml = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const dots = ymd => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '')); return m ? `${m[3]}.${m[2]}.${m[1]}` : ''; };
const words = ymd => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '')); return m ? `«${m[3]}» ${MONTHS[+m[2] - 1]} ${m[1]}г.` : ''; };
const REQ = [['name','название ИП'],['iin','ИИН/БИН'],['address','адрес'],['iban','IBAN'],['kbe','КБе'],['bik','БИК'],['bank','банк'],['head','ФИО']];
const CUST = ['preamble','name','iin','address','iban','kbe','bik','bank','phone','email','head','marking'];
const TOKENS = ['{{ИП}}','{{ИИН}}','{{СУММА}}','{{КОЛВО}}','{{НОМЕР}}'];
const fail = (status, msg) => Object.assign(Error(msg), { status });

function createContracts({ getState, env = process.env, dataDir }) {
  const templatePath = path.join(dataDir, 'contract-template.docx');
  const customer = () => { try { const c = JSON.parse(env.CONTRACT_CUSTOMER_JSON || '{}'); return c && typeof c === 'object' ? c : {}; } catch { return {}; } };
  function prepare(d, body) {
    const r = Object.assign({}, d.ipRequisites || {}), c = customer();
    const miss = REQ.filter(([k]) => !String(r[k] || '').trim()).map(([, l]) => l);
    if (miss.length) throw fail(409, 'Заполните реквизиты ИП: ' + miss.join(', '));
    const cm = CUST.filter(k => !String(c[k] || '').trim());
    if (cm.length) throw fail(503, 'Не настроены реквизиты MIXIT (CONTRACT_CUSTOMER_JSON): ' + cm.join(', '));
    const amount = Math.round(Number(body.amount != null && body.amount !== '' ? body.amount : d.cost));
    if (!(amount > 0)) throw fail(400, 'Укажите сумму');
    const videos = Math.round(Number(body.videos) || 1);
    if (!(videos >= 1 && videos <= 20)) throw fail(400, 'Количество видео — от 1 до 20');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) ? body.date : new Date().toISOString().slice(0, 10);
    const number = String(body.number || '').trim().slice(0, 40) || `${d.id}-${date.slice(5, 7)}-${date.slice(0, 4)}`;
    const ig = String(d.instagramAccount || '').trim(), tt = String(d.tiktokAccount || '').trim();
    return { r, c, amount, videos, date, number, city: String(body.city || c.city || 'Астана').slice(0, 60),
      instagram: ig || '—', tiktok: tt ? (/^https?:/.test(tt) ? tt : 'https://www.tiktok.com/@' + tt.replace(/^@/, '')) : '—' };
  }
  const safe = s => s.replace(/[\\/:*?"<>|]/g, '_');
  function contract(d, body) {
    const p = prepare(d, body);
    if (!fs.existsSync(templatePath)) throw fail(409, 'Шаблон договора не загружен — загрузите его один раз (кнопка под реквизитами)');
    const files = unzip(fs.readFileSync(templatePath));
    const v = { 'НОМЕР': p.number, 'ГОРОД': p.city, 'ДАТА': words(p.date), 'ИП': p.r.name, 'ИИН': p.r.iin, 'АДРЕС': p.r.address, 'IBAN': p.r.iban, 'КБЕ': p.r.kbe, 'БИК': p.r.bik, 'БАНК': p.r.bank,
      'ТЕЛ': p.r.phone || '—', 'EMAIL': p.r.email || '—', 'ФИО': p.r.head, 'INSTAGRAM': p.instagram, 'TIKTOK': p.tiktok, 'КОЛВО': `${p.videos} (${COUNT_WORDS[p.videos] || numberWords(p.videos)})`,
      'СУММА': money(p.amount), 'СУММА_ПРОПИСЬЮ': numberWords(p.amount) + ' тенге', 'МАРКИРОВКА': p.c.marking, 'З_ПРЕАМБУЛА': p.c.preamble, 'З_НАЗВАНИЕ': p.c.name, 'З_ИИН': p.c.iin,
      'З_АДРЕС': p.c.address, 'З_IBAN': p.c.iban, 'З_КБЕ': p.c.kbe, 'З_БИК': p.c.bik, 'З_БАНК': p.c.bank, 'З_ТЕЛ': p.c.phone, 'З_EMAIL': p.c.email, 'З_РУК': p.c.head };
    let doc = files['word/document.xml'].toString('utf8').replace(/\{\{([^{}<>]+)\}\}/g, (m, k) => (k in v ? xml(v[k]) : m));
    if (/\{\{[^{}<>]+\}\}/.test(doc)) throw fail(500, 'В шаблоне остались незаполненные поля');
    files['word/document.xml'] = Buffer.from(doc, 'utf8');
    return { buffer: zip(files), filename: safe(`Договор ${p.number} — ИП ${p.r.name}.docx`) };
  }
  function invoice(d, body) {
    const p = prepare(d, body); const no = String(body.invoiceNumber || p.number).slice(0, 40);
    const run = (t, b) => `<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>${b ? '<w:b/>' : ''}<w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">${xml(t)}</w:t></w:r>`;
    const par = (inner, align, after = 60) => `<w:p><w:pPr><w:spacing w:after="${after}"/>${align ? `<w:jc w:val="${align}"/>` : ''}</w:pPr>${inner}</w:p>`;
    const cell = (t, w, b, align) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr>${par(run(t, b), align, 0)}</w:tc>`;
    const service = `Рекламные услуги: создание и размещение ${p.videos} (${COUNT_WORDS[p.videos] || p.videos}) рекламных видеороликов (Instagram Reels + TikTok) по договору № ${p.number} от ${dots(p.date)}`;
    const W = [500, 4900, 900, 1100, 1250, 1250], B = '<w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/>';
    const body2 = [
      par(`<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:sz w:val="28"/></w:rPr><w:t>${xml(`Счёт на оплату № ${no} от ${dots(p.date)}`)}</w:t></w:r>`, null, 200),
      par(run('Поставщик: ', true) + run(`ИП «${p.r.name}», ИИН ${p.r.iin}, ${p.r.address}`)),
      par(run('Банк: ', true) + run(`${p.r.bank}, БИК ${p.r.bik}, ИИК (IBAN) ${p.r.iban}, КБе ${p.r.kbe}`)),
      par(run('Покупатель: ', true) + run(`${p.c.name}, БИН (ИИН) ${p.c.iin}, ${p.c.address}`)),
      par(run('Договор: ', true) + run(`№ ${p.number} от ${dots(p.date)}`), null, 200),
      `<w:tbl><w:tblPr><w:tblW w:w="9900" w:type="dxa"/><w:tblBorders>${B}</w:tblBorders></w:tblPr><w:tblGrid>${W.map(w => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`
        + `<w:tr>${['№','Наименование','Кол-во','Ед.','Цена, ₸','Сумма, ₸'].map((t, i) => cell(t, W[i], true)).join('')}</w:tr>`
        + `<w:tr>${cell('1', W[0])}${cell(service, W[1])}${cell('1', W[2])}${cell('услуга', W[3])}${cell(money(p.amount), W[4], false, 'right')}${cell(money(p.amount), W[5], false, 'right')}</w:tr></w:tbl>`,
      par(run(`Итого: ${money(p.amount)} ₸`, true), 'right'), par(run('Без НДС'), 'right'),
      par(run(`Всего к оплате: ${numberWords(p.amount)} тенге 00 тиын`, true), null, 360),
      par(run(`Исполнитель: ____________________ / ${p.r.head} /`)),
    ].join('');
    const files = {
      '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body2}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1000" w:right="850" w:bottom="1000" w:left="1134" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body></w:document>`,
    };
    return { buffer: zip(files), filename: safe(`Счёт ${no} — ИП ${p.r.name}.docx`) };
  }
  function saveTemplate(buffer) {
    let doc = ''; try { doc = unzip(buffer)['word/document.xml'].toString('utf8'); } catch { doc = ''; }
    const miss = TOKENS.filter(t => !doc.includes(t));
    if (!doc || miss.length) throw fail(400, 'Это не шаблон договора MIXIT: нет полей ' + (miss.join(', ') || 'Word'));
    fs.mkdirSync(path.dirname(templatePath), { recursive: true }); fs.writeFileSync(templatePath + '.tmp', buffer); fs.renameSync(templatePath + '.tmp', templatePath);
    return { ok: true };
  }
  function mount(app, requireAuth) {
    const staff = (req, res, next) => ['manager', 'marketer'].includes(req.session && req.session.role) ? next() : res.status(403).json({ error: 'Нет доступа' });
    const up = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }).single('template');
    const send = (res, out) => { res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'); res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(out.filename)}`); res.set('Cache-Control', 'no-store'); res.send(out.buffer); };
    app.get('/api/contracts/template', requireAuth, (req, res) => { let at = null; try { at = fs.statSync(templatePath).mtime.toISOString(); } catch {} res.json({ uploaded: !!at, updatedAt: at }); });
    app.post('/api/contracts/template', requireAuth, staff, (req, res, next) => up(req, res, e => e ? res.status(400).json({ error: 'Файл до 5 МБ' }) : next()), (req, res) => {
      try { if (!req.file || !/\.docx$/i.test(req.file.originalname)) throw fail(400, 'Нужен файл .docx'); res.json(saveTemplate(req.file.buffer)); } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Не удалось сохранить шаблон' }); } });
    app.post('/api/micro-influencer-deals/:id/documents/:kind', requireAuth, staff, (req, res) => {
      try {
        const d = (getState().microInfluencerDeals || []).find(x => x.id === +req.params.id);
        if (!d) throw fail(404, 'Интеграция не найдена');
        if (!['contract', 'invoice'].includes(req.params.kind)) throw fail(404, 'Неизвестный документ');
        send(res, req.params.kind === 'contract' ? contract(d, req.body || {}) : invoice(d, req.body || {}));
      } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Не удалось собрать документ' }); }
    });
  }
  return { contract, invoice, saveTemplate, mount, numberWords, unzip, zip };
}
module.exports = { createContracts };
