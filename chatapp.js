'use strict';
// ChatApp (20.11.2026): второй номер WhatsApp. Блогерам менеджеров из CHATAPP_MANAGERS пишем с номера ChatApp,
// остальным — как раньше, через Wazzup. Данные входа только в Render: CHATAPP_EMAIL, CHATAPP_PASSWORD,
// CHATAPP_APP_ID, CHATAPP_LICENSE_ID (+ необязательно CHATAPP_MESSENGER, по умолчанию grWhatsApp).
// API: POST /v1/tokens {email,password,appId} → accessToken (24 ч); дальше заголовок Authorization: <токен>.
const API = 'https://api.chatapp.online/v1';

function createChatApp({ env = process.env, fetchImpl = fetch } = {}) {
  let tok = null, tokEnd = 0, pending = null, lastCheck = null;
  const cfg = () => ({
    email: String(env.CHATAPP_EMAIL || '').trim(), password: String(env.CHATAPP_PASSWORD || ''),
    appId: String(env.CHATAPP_APP_ID || '').trim(), licenseId: String(env.CHATAPP_LICENSE_ID || '').trim(),
    messenger: String(env.CHATAPP_MESSENGER || 'grWhatsApp').trim() || 'grWhatsApp',
  });
  const configured = () => { const k = cfg(); return !!(k.email && k.password && k.appId && k.licenseId); };
  const missing = () => { const k = cfg(); return [['CHATAPP_EMAIL', k.email], ['CHATAPP_PASSWORD', k.password], ['CHATAPP_APP_ID', k.appId], ['CHATAPP_LICENSE_ID', k.licenseId]].filter((x) => !x[1]).map((x) => x[0]); };

  async function call(method, path, body, auth) {
    const headers = { Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (auth) headers.Authorization = auth;
    const r = await fetchImpl(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch (e) {}
    if (!r.ok || (j && j.success === false)) {
      const er = j && j.error;
      const e = new Error('ChatApp ' + r.status + ': ' + String((er && (er.message || er.code)) || txt || '').slice(0, 200));
      e.status = r.status; e.code = er && er.code;
      throw e;
    }
    return j || {};
  }
  async function token(force) {
    if (!force && tok && Date.now() < tokEnd - 10 * 60000) return tok;
    if (pending) return pending;
    const k = cfg();
    pending = (async () => {
      const j = await call('POST', '/tokens', { email: k.email, password: k.password, appId: k.appId });
      const d = (j && j.data) || j;
      if (!d || !d.accessToken) throw new Error('ChatApp: вход не удался (токен не выдан)');
      tok = d.accessToken;
      const end = Number(d.accessTokenEndTime);
      tokEnd = end > 1e12 ? end : end > 0 ? end * 1000 : Date.now() + 20 * 3600000;
      return tok;
    })().finally(() => { pending = null; });
    return pending;
  }
  async function authed(method, path, body) {
    let t = await token();
    try { return await call(method, path, body, t); }
    catch (e) {
      if (e.status === 401 || e.code === 'ApiInvalidTokenError') { t = await token(true); return call(method, path, body, t); }
      throw e;
    }
  }
  const idOf = (j) => {
    const d = j && j.data != null ? j.data : j;
    const x = Array.isArray(d) ? d[0] : d;
    return String((x && (x.id || x.messageId || x.internalId)) || '');
  };
  // body — в формате Wazzup ({chatId, text} или {chatId, contentUri}), чтобы все отправители работали без переделки.
  async function send(body) {
    if (!configured()) throw new Error('ChatApp не настроен: нет ' + missing().join(', '));
    const k = cfg();
    const n = String(body.chatId || '').replace(/\D/g, '');
    if (!n) throw new Error('ChatApp: нет номера получателя');
    const base = `/licenses/${encodeURIComponent(k.licenseId)}/messengers/${encodeURIComponent(k.messenger)}/chats/${n}/messages`;
    let j;
    if (body.contentUri) {
      const u = String(body.contentUri);
      let name = String(body.fileName || '');
      if (!name) { try { name = decodeURIComponent(new URL(u).pathname.split('/').pop() || ''); } catch (e) {} }
      if (!/\.[a-z0-9]{2,5}$/i.test(name)) name = (name || 'file') + (/\.(mp4|mov|webm)(?:$|[?#])/i.test(u) ? '.mp4' : '.pdf');
      j = await authed('POST', base + '/file', Object.assign({ file: u, fileName: name }, body.caption ? { caption: String(body.caption) } : {}));
    } else if (body.text) {
      j = await authed('POST', base + '/text', { text: String(body.text) });
    } else throw new Error('ChatApp: шаблоны WABA не поддерживаются — только текст и файлы');
    const id = idOf(j);
    return { messageId: 'chatapp:' + (id || Date.now()), provider: 'chatapp' };
  }
  // Проверка входа (без отправки сообщений). Секреты в ответ не попадают.
  async function check() {
    if (!configured()) return (lastCheck = { ok: false, at: new Date().toISOString(), error: 'нет переменных: ' + missing().join(', ') });
    const k = cfg();
    try { await token(true); }
    catch (e) { return (lastCheck = { ok: false, at: new Date().toISOString(), error: e.message }); }
    let license = 'не проверена';
    try {
      const j = await authed('GET', '/licenses');
      const list = Array.isArray(j.data) ? j.data : Array.isArray(j) ? j : [];
      if (list.length) {
        const own = list.find((x) => String(x.licenseId || x.id) === k.licenseId);
        license = own ? 'найдена' + (own.messenger || own.messengerType ? ' (' + (own.messenger || own.messengerType) + ')' : '') : 'НЕ найдена среди ' + list.map((x) => x.licenseId || x.id).join(', ');
      }
    } catch (e) { license = 'не проверена (' + e.message.slice(0, 80) + ')'; }
    return (lastCheck = { ok: true, at: new Date().toISOString(), license, messenger: k.messenger });
  }
  // Вебхук входящих (24.11.2026): ставим адрес Barter Box через API — в кабинет ChatApp ничего вставлять не нужно.
  // PUT /licenses/{licenseId}/messengers/{messenger}/callbackUrl {events, url}; список — GET /callbackUrls (свой для appId).
  async function setCallback(url, events) {
    if (!configured()) throw new Error('ChatApp не настроен: нет ' + missing().join(', '));
    const k = cfg();
    await authed('PUT', `/licenses/${encodeURIComponent(k.licenseId)}/messengers/${encodeURIComponent(k.messenger)}/callbackUrl`, { events: events || ['message'], url });
    return listCallbacks();
  }
  async function listCallbacks() {
    const j = await authed('GET', '/callbackUrls');
    const list = Array.isArray(j.data) ? j.data : [];
    // адрес содержит секрет — наружу отдаём только начало
    return list.map((x) => ({ licenseId: x.licenseId, messengerType: x.messengerType, events: x.events, url: String(x.url || '').replace(/(\/webhook\/)[^/?#]+/, '$1•••') }));
  }
  // Диагностика (24.11.2026): что видит наш вход — без пароля и ключей.
  async function diag() {
    const k = cfg(), out = { appId: k.appId, email: k.email.replace(/^(.).*(@.*)$/, '$1•••$2'), licenseIdEnv: k.licenseId, messenger: k.messenger };
    const safe = async (name, fn) => { try { out[name] = await fn(); } catch (e) { out[name] = { error: e.message }; } };
    await safe('me', async () => { const j = await authed('GET', '/me'); const d = j.data || j; return { id: d.id, name: d.name, role: d.role || d.roleName, companies: (d.companies || []).map((c) => c.id + ' ' + (c.name || '')) }; });
    await safe('licenses', async () => { const j = await authed('GET', '/licenses'); const list = Array.isArray(j.data) ? j.data : []; return list.map((x) => ({ id: x.licenseId || x.id, name: x.name || x.licenseName, active: x.active, status: x.status, paid: x.licenseTo || x.endDate, messengers: (x.messenger || x.messengers || []).map ? (x.messenger || x.messengers || []).map((m) => (m.type || m.messengerType || m) + (m.status ? ':' + m.status : '') + (m.phone ? ':' + m.phone : '')) : x.messenger })); });
    return out;
  }
  return { configured, send, check, setCallback, listCallbacks, diag, status: () => lastCheck };
}
module.exports = { createChatApp };
