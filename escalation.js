/* CareConnect escalation engine.
   ONE source of truth: the server requires this file, and the app (public/index.html) has the same code inlined.
   It works on a plain state object, so it runs identically on the server and in the browser (offline demo mode). */
(function (root, f) { if (typeof module === 'object' && module.exports) module.exports = f(); else root.ESC = f(); })(typeof self !== 'undefined' ? self : this, function () {
  const MSG = '👋 R U OK? Time for your daily check-in. Tap “I’m okay”.';
  const D = s => String(s == null ? '' : s).replace(/\D/g, '');
  const clock = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  let lastId = 0;
  const nid = () => { lastId = Math.max(Date.now(), lastId + 1); return lastId; };
  const tok = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 8);
  const real = p => p && !/•/.test(p) && D(p).length >= 10;
  const who = st => st.who || { id: 'ammini', n: 'Ammini Amma', a: '', p: '' };
  const push = (st, o) => { (st.nf = st.nf || []).unshift(Object.assign({ id: nid(), at: clock() }, o)); };
  const lg = (st, m) => { st.log = st.log || []; st.log.push(clock() + ' · ' + m); const a = (st.ah || []).find(x => x.id == st.alId); if (a) a.log = st.log.slice(); };

  /* Escalation order = the elder's Trusted people list (in that order), then free volunteers, then the admin, then 108/112. */
  function build(st, el) {
    const people = (st.people || []).filter(p => p.ok && (p.of || 'ammini') == el.id);
    const fams = (st.acc || []).filter(a => a.role == 'family' && a.of == el.id), used = new Set(), ct = [];
    people.forEach(p => {
      const f = fams.find(a => D(a.phone) && D(a.phone) == D(p.ph));
      if (f) used.add(f.id);
      ct.push({ n: p.n, ph: p.ph || '', key: f ? 'fam:' + el.id : '', tok: tok() });
    });
    fams.filter(a => !used.has(a.id)).forEach(a => ct.push({ n: a.name, ph: a.phone || '', key: 'fam:' + el.id, tok: tok() }));
    const ch = ct.map(c => ({ k: 'contact', c }));
    ch.push({ k: 'vol' }, { k: 'admin' }, { k: '112' });
    return { ch, fams };
  }

  function notify(st, i) {
    const s = st.ch[i], w = who(st), sec = st.escSec || 60, ah = (st.ah || []).find(x => x.id == st.alId), loc = ah && ah.loc;
    const base = (st.kind == 'sos' ? '🆘 SOS from ' : '⚠ Missed check-in: ') + w.n + (w.a ? ' · ' + w.a : '') + (loc ? ' · live location shared' : '');
    const wait = i < st.ch.length - 1, tail = wait ? ' Waiting ' + sec + 's for an acknowledgement.' : '';
    if (s.k == 'contact') {
      const c = s.c;
      if (c.key) push(st, { to: c.key, msg: base + ' · please acknowledge', urgent: 1 });
      if (real(c.ph)) push(st, { to: 'sms', ph: c.ph, msg: base + '. Please confirm you are on the way:', tok: c.tok, sms: 1 });
      lg(st, 'Alerted ' + c.n + '.' + tail);
    } else if (s.k == 'vol') {
      const v = (st.acc || []).filter(a => a.role == 'vol' && a.ok && a.bio && a.free);
      push(st, { to: 'vol', msg: base + ' · welfare check needed', urgent: 1 });
      v.forEach(a => { if (real(a.phone)) push(st, { to: 'sms', ph: a.phone, msg: base + '. Please help if you can.', sms: 1 }); });
      lg(st, 'No acknowledgement yet. Alerting ' + v.length + ' free volunteer' + (v.length == 1 ? '' : 's') + ' nearby.' + tail);
    } else if (s.k == 'admin') {
      push(st, { to: 'admin', msg: '🚨 No one has acknowledged the alert for ' + w.n + '.', urgent: 1 });
      lg(st, 'Still no acknowledgement. Escalated to the admin.' + tail);
    } else {
      push(st, { to: 'admin', msg: '🚨 Call 108 / 112 for ' + w.n + (w.a ? ' · ' + w.a : ''), urgent: 1 });
      lg(st, 'Still no acknowledgement. Admin to call 108 / 112.');
    }
    st.esc = i + 1;
    st.nextAt = wait ? Date.now() + sec * 1000 : 0;
  }

  function start(st, el, kind, loc) {
    el = el || (st.acc || []).find(a => a.id == 'ammini') || { id: 'ammini', name: 'Ammini Amma' };
    const b = build(st, el);
    st.kind = kind; st.called = 0; st.log = []; st.ack = null; st.ackAt = null;
    st.ch = b.ch; st.who = { id: el.id, n: el.name, a: el.addr || '', p: el.phone || '' }; st.alId = nid();
    (st.ah = st.ah || []).unshift({ id: st.alId, eid: el.id, k: kind, at: clock(), who: st.who, loc: loc || null, log: [], res: 'Open' });
    const msg = (kind == 'sos' ? '🆘 SOS from ' : '⚠ Missed check-in: ') + el.name + (loc ? ' · live location shared' : '');
    lg(st, kind == 'sos' ? 'SOS pressed.' : 'Check-in missed.');
    if (b.fams.length && !(b.ch[0].k == 'contact' && b.ch[0].c.key)) { push(st, { to: 'fam:' + el.id, msg: msg + ' · tap “I’m responding” if you are on it' }); lg(st, 'Family updated: ' + b.fams.map(a => a.name).join(', ') + '.'); }
    push(st, { to: 'admin', msg: msg + ' · escalation started' });
    st.esc = 0; notify(st, 0);
  }

  /* Move to the next person only when time is up AND nobody has acknowledged. */
  function step(st, t) {
    if (!st.esc || st.ack || !st.nextAt || t < st.nextAt || st.esc >= (st.ch || []).length) return false;
    notify(st, st.esc); return true;
  }

  function ack(st, by) {
    if (!st.esc || st.ack) return false;
    st.ack = by; st.ackAt = clock(); st.nextAt = 0;
    lg(st, by + ' acknowledged at ' + st.ackAt + '. Escalation stopped.');
    const a = (st.ah || []).find(x => x.id == st.alId); if (a) a.res = 'Acknowledged by ' + by + ' · ' + st.ackAt;
    const w = who(st);
    ['admin', 'fam:' + w.id, 'el:' + w.id].forEach(to => push(st, { to, msg: '✓ ' + by + ' acknowledged the alert for ' + w.n + ' at ' + st.ackAt + '.' }));
    return true;
  }

  function resolve(st, res) {
    if (!st.esc) return false;
    const a = (st.ah || []).find(x => x.id == st.alId); if (a) a.res = res;
    lg(st, res + '.');
    st.esc = 0; st.ack = null; st.ackAt = null; st.nextAt = 0; return true;
  }
  function call(st) { if (!st.esc || st.called) return false; st.called = 1; lg(st, 'Admin called 108 / 112. Ambulance requested.'); return true; }

  /* Daily check-in: remind (and repeat every 10 min), then start an alert if still no answer after `grace` minutes. */
  function ci(st, t, boot, grace) {
    const n = new Date(t), d = n.toDateString(); let ch = false;
    (st.acc || []).filter(a => a.role == 'elder' && !a.g && a.ct).forEach(e => {
      const [h, m] = e.ct.split(':').map(Number), due = new Date(n); due.setHours(h, m, 0, 0);
      if (n < due || e.ciOk == d) return;
      if (e.ciDay != d || (e.ciAl != d && t - (e.ciNx || 0) > 600000)) {
        e.ciDay = d; e.ciNx = t;
        st.nf = (st.nf || []).filter(x => !(x.to == 'el:' + e.id && x.msg == MSG));
        push(st, { to: 'el:' + e.id, msg: MSG }); ch = true;
      }
      if (e.ciAl != d && !st.esc && t - Math.max(+due, boot) > grace * 60000) { e.ciAl = d; start(st, e, 'checkin', null); ch = true; }
    });
    return ch;
  }
  return { MSG, build, start, step, ack, resolve, call, ci, push, lg, nid };
});
