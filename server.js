/* CareConnect backend (no framework, Node 18+).
   - Keeps ONE shared state for every phone/browser (sync + live updates over Server-Sent Events)
   - Runs alert escalation and daily check-in reminders on a timer, so it works even if the elder's phone is off
   - Sends phone push notifications (Web Push) and SMS (Twilio or any webhook)
   Run:  npm install && node server.js        Open: http://localhost:3000                              */
process.env.TZ = process.env.TZ || 'Asia/Kolkata';   // check-in times are local to the elders
const http = require('http'), fs = require('fs'), path = require('path');
const ESC = require('./escalation.js');
const PORT = +process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || 'http://localhost:' + PORT).replace(/\/$/, '');
const DATA = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
const ESC_TICK_MS = +process.env.ESC_TICK_MS || 2000, CI_GRACE = +process.env.CI_GRACE_MIN || 30;
const ADMIN_PHONE = process.env.ADMIN_PHONE || '';
const BOOT = Date.now();
let webpush = null; try { webpush = require('web-push'); } catch (e) {}

/* keys the server owns (alerts) vs keys clients may write */
const IDK = ['acc', 'req', 'fb', 'funds', 'usedL', 'dh', 'nf', 'msgs', 'cl'], PRE = ['nf', 'msgs', 'fb', 'dh', 'cl', 'req'];
const OWN = ['who', 'ack', 'ackAt', 'esc', 'kind', 'log', 'called', 'ch', 'nextAt', 'alId', 'ah'];

/* ---------- storage ---------- */
let db = { v: 0, s: {}, sent: [], subs: {}, vapid: null };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA, 'utf8'))); } catch (e) {}
const sent = new Set(db.sent || []);
(db.s.nf || []).forEach(n => sent.add(n.id));   // never re-send old notifications after a restart
let st = null;
const saveNow = () => { try { fs.mkdirSync(path.dirname(DATA), { recursive: true }); db.sent = [...sent].slice(-3000); fs.writeFileSync(DATA + '.tmp', JSON.stringify(db)); fs.renameSync(DATA + '.tmp', DATA); } catch (e) { console.error('save failed', e.message); } };
const saveSoon = () => { clearTimeout(st); st = setTimeout(saveNow, 300); };

/* ---------- web push (optional) ---------- */
if (webpush) {
  if (process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE) db.vapid = { publicKey: process.env.VAPID_PUBLIC, privateKey: process.env.VAPID_PRIVATE };
  if (!db.vapid) { db.vapid = webpush.generateVAPIDKeys(); saveNow(); }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@careconnect.example', db.vapid.publicKey, db.vapid.privateKey);
}

/* ---------- SMS ---------- */
const smsOn = () => !!(process.env.SMS_WEBHOOK_URL || (process.env.TWILIO_SID && process.env.TWILIO_TOKEN && process.env.TWILIO_FROM));
const phone = p => { if (!p || /•/.test(p)) return ''; const d = String(p).replace(/\D/g, ''); if (String(p).trim().startsWith('+')) return '+' + d; if (d.length == 10) return '+91' + d; if (d.length == 12 && d.startsWith('91')) return '+' + d; return d.length >= 11 ? '+' + d : ''; };
async function sendSms(to, body) {
  to = phone(to); if (!to) return false;
  try {
    if (process.env.SMS_WEBHOOK_URL) {
      const r = await fetch(process.env.SMS_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to, body }) }); return r.ok;
    }
    if (process.env.TWILIO_SID && process.env.TWILIO_TOKEN && process.env.TWILIO_FROM) {
      const base = process.env.TWILIO_BASE || 'https://api.twilio.com';
      const r = await fetch(`${base}/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: 'Basic ' + Buffer.from(process.env.TWILIO_SID + ':' + process.env.TWILIO_TOKEN).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: to, From: process.env.TWILIO_FROM, Body: body }).toString()
      }); return r.ok;
    }
  } catch (e) { console.error('sms failed', e.message); return false; }
  console.log('[SMS not configured] would send to', to, ':', body); return false;
}

/* ---------- delivering notifications ---------- */
async function pushTo(nf) {
  if (!webpush) return;
  for (const [ep, rec] of Object.entries(db.subs)) {
    if (!rec.keys.includes(nf.to)) continue;
    try { await webpush.sendNotification(rec.sub, JSON.stringify({ title: 'CareConnect', body: nf.msg, urgent: !!nf.urgent, url: '/' }), { TTL: 3600, urgency: nf.urgent ? 'high' : 'normal' }); }
    catch (e) { if (e.statusCode == 404 || e.statusCode == 410) { delete db.subs[ep]; saveSoon(); } }
  }
}
function deliver() {
  const nf = db.s.nf || [], fresh = nf.filter(n => !sent.has(n.id));
  if (!fresh.length) return;
  fresh.forEach(n => sent.add(n.id));
  fresh.slice().reverse().forEach(n => {
    if (n.to == 'sms') {
      const link = n.tok && db.s.alId ? ' ' + PUBLIC_URL + '/ack/' + db.s.alId + '/' + n.tok : '';
      sendSms(n.ph, n.msg + link);
    } else {
      pushTo(n);
      if (n.to == 'admin' && n.urgent && ADMIN_PHONE) sendSms(ADMIN_PHONE, n.msg);
    }
  });
  db.s.nf = nf.filter(n => n.to != 'sms').slice(0, 300);   // SMS jobs (they can contain codes) are dropped once handed over
}

/* ---------- live updates ---------- */
const clients = new Set();
function bump() { db.v++; deliver(); saveSoon(); clients.forEach(r => { try { r.write('data: ' + db.v + '\n\n'); } catch (e) {} }); }

/* ---------- merging client changes ---------- */
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function applyPatch(p) {
  if (!p) return false;
  const s = db.s; let ch = false;
  const empty = !s.acc;   // first device ever connected: its data becomes the starting data
  Object.keys(p.v || {}).forEach(k => { if (OWN.includes(k) && !empty) return; if (!eq(s[k], p.v[k])) { s[k] = p.v[k]; ch = true; } });
  Object.keys(p.set || {}).forEach(k => {
    if (!IDK.includes(k) || (OWN.includes(k) && !empty)) return;
    const arr = s[k] = s[k] || [];
    p.set[k].forEach(it => {
      const i = arr.findIndex(x => String(x.id) == String(it.id));
      if (i >= 0) { if (!eq(arr[i], it)) { arr[i] = it; ch = true; } } else { (PRE.includes(k) ? arr.unshift(it) : arr.push(it)); ch = true; }
    });
  });
  Object.keys(p.del || {}).forEach(k => {
    if (!IDK.includes(k)) return;
    const ids = p.del[k].map(String), before = (s[k] || []).length;
    s[k] = (s[k] || []).filter(x => !ids.includes(String(x.id)));
    if (s[k].length != before) ch = true;
  });
  return ch;
}

/* ---------- timers: escalation + daily check-in run here, 24/7 ---------- */
setInterval(() => {
  const now = Date.now();
  const a = ESC.step(db.s, now), b = ESC.ci(db.s, now, BOOT, CI_GRACE);
  if (a || b) bump();
}, ESC_TICK_MS);
setInterval(() => clients.forEach(r => { try { r.write(': hb\n\n'); } catch (e) {} }), 25000);

/* ---------- HTTP ---------- */
const json = (res, o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(o)); };
const body = req => new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > 8e6) { no(new Error('too big')); req.destroy(); } }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { ok({}); } }); });
const page = (res, t, m) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><body style="font:20px system-ui;max-width:480px;margin:12vh auto;padding:0 20px;text-align:center"><div style="font-size:64px">${t}</div><p>${m}</p>`); };
const file = (res, f, type, extra) => fs.readFile(path.join(__dirname, 'public', f), (e, d) => { if (e) { res.writeHead(404); return res.end('Not found'); } res.writeHead(200, Object.assign({ 'Content-Type': type }, extra || {})); res.end(d); });
const state = () => ({ v: db.v, s: db.s });

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname;
  if (req.method == 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST' }); return res.end(); }
  try {
    if (p == '/' || p == '/index.html') return file(res, 'index.html', 'text/html; charset=utf-8');
    if (p == '/sw.js') return file(res, 'sw.js', 'application/javascript', { 'Service-Worker-Allowed': '/' });
    if (p == '/api/config') return json(res, { push: !!webpush, vapid: webpush ? db.vapid.publicKey : '', sms: smsOn() });
    if (p == '/api/state') return json(res, state());
    if (p == '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
      res.write('data: ' + db.v + '\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    if (req.method == 'POST' && p == '/api/sync') {
      const b = await body(req), ch = applyPatch(b.patch);
      if (ch) bump();
      return json(res, !ch && b.v === db.v ? { v: db.v, same: 1 } : state());
    }
    if (req.method == 'POST' && p.startsWith('/api/alert/')) {
      const b = await body(req), op = p.slice(11), s = db.s; let ch = false;
      if (op == 'start') {
        const el = (s.acc || []).find(a => a.id == b.eid);
        if (el && !(s.esc > 0 && s.who && s.who.id == el.id && s.kind == b.kind)) { ESC.start(s, el, b.kind == 'sos' ? 'sos' : 'checkin', b.loc || null); ch = true; }
      }
      else if (op == 'ack') ch = ESC.ack(s, String(b.by || 'Someone').slice(0, 80));
      else if (op == 'resolve') ch = ESC.resolve(s, String(b.res || 'Closed').slice(0, 80));
      else if (op == 'call') ch = ESC.call(s);
      if (ch) bump();
      return json(res, state());
    }
    if (req.method == 'POST' && p == '/api/push/subscribe') {
      const b = await body(req);
      if (b.sub && b.sub.endpoint) { db.subs[b.sub.endpoint] = { sub: b.sub, keys: (b.keys || []).slice(0, 6) }; saveSoon(); }
      return json(res, { ok: 1 });
    }
    if (req.method == 'POST' && p == '/api/reset') {
      if (process.env.ALLOW_RESET != '1') return json(res, { ok: 0 }, 403);
      db.s = {}; db.v++; sent.clear(); saveNow(); clients.forEach(r => { try { r.write('data: ' + db.v + '\n\n'); } catch (e) {} }); return json(res, { ok: 1 });
    }
    /* A contact without an account taps the link in their SMS to acknowledge */
    const m = p.match(/^\/ack\/(\d+)\/([\w]+)$/);
    if (m) {
      const s = db.s, step = (s.ch || []).find(x => x.k == 'contact' && x.c.tok == m[2]);
      if (!step || String(s.alId) != m[1]) return page(res, '⚠️', 'This link is no longer active.');
      if (s.ack) return page(res, '✅', 'Already acknowledged by <b>' + s.ack.replace(/[<>&]/g, '') + '</b> at ' + s.ackAt + '. Thank you.');
      if (ESC.ack(s, step.c.n + ' (SMS link)')) bump();
      return page(res, '✅', 'Thank you, <b>' + step.c.n.replace(/[<>&]/g, '') + '</b>. The alert is acknowledged and escalation has stopped.');
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) { console.error(e); json(res, { error: 'server error' }, 500); }
});
if (require.main === module) {
  server.listen(PORT, () => console.log(`CareConnect running at ${PUBLIC_URL}  (push: ${webpush ? 'on' : 'off - run npm install'}, sms: ${smsOn() ? 'on' : 'off'}, tz: ${process.env.TZ})`));
}
module.exports = { server, db, bump };
