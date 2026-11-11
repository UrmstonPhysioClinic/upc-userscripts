// ==UserScript==
// @name         Halaxy open-ended patients (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.1.3
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/check-ins.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/check-ins.user.js
// @description  Patients > Open-ended patients (Carl only for now): patients left open-ended in their last note ("open return", "book again if needed" and so on), last seen 3 weeks or more ago, with nothing booked. A list with a count on the menu; sends nothing. Reads only.
// @match        https://*.halaxy.com/a/pr/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * Open-ended patients (Carl, 11 Nov 2026; named by Carl; first built as Check-ins, and the file keeps that name), the list only for now: who to send a short "how are things going?" with the booking link.
 *
 *  - One calendar request: patients whose last attended appointment was 3 weeks to 3 months ago, with nothing booked
 *    since and nothing booked ahead. Left out if their last appointment was cancelled or missed.
 *  - For each, their latest clinical note is read (two requests the first time; kept for a week per patient and visit) for
 *    open-ended wording: "open return", "open appointment", "book again if needed", "see how things go",
 *    "come back if needed" and similar. "Not", "no longer" and so on just before a phrase cancel it.
 *  - Shown: the patient, last seen, which wording was found and a link to the note.
 *  - Separate from Review requests: neither reads or affects the other (Carl, 11 Nov 2026).
 *  - Note text is read when checking and never kept: only which wording was found.
 */
(() => {
  'use strict';
  if (window.__hxCheckIns) return;
  window.__hxCheckIns = true;

  const VERSION = '0.1.3';
  const ROUTE = 'upc-check-ins';
  const MENU_CLS = 'upc-ci-menu';
  const ALLOWED = ['Carl Healy'];
  const DAY = 86400e3;
  const AFTER_DAYS = 21;       // Carl, 11 Nov 2026: 3 weeks after the last visit
  const UP_TO_DAYS = 91;       // not further back than about 3 months
  const REFRESH_EVERY = 12 * 3600e3, PAGE_FRESH = 30 * 60e3, KEEP = 7 * DAY;
  const KEY = 'upc-ci:';
  const RULES = 1;   // bump when the wording list changes, so patients are read again

  const U = () => window.UPC;
  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(KEY + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
  };
  const label = (ms) => U().dayLabel(ms);
  const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

  function userName() {
    const h = window.HkUser || {};
    const named = String(h.pracName || (h.CalendarDefault || {}).pracName || '').trim();
    if (named) return named;
    const btn = document.getElementById('activeUser');
    if (btn && btn.textContent.trim()) return btn.textContent.replace(/\s+/g, ' ').trim();
    const el = [...document.querySelectorAll('header *, nav *, .navbar *, #top *, #headerWrapper *')]
      .find((e) => !e.children.length && ALLOWED.some((n) => n.toLowerCase() === e.textContent.trim().toLowerCase()));
    return el ? el.textContent.trim() : '';
  }
  const allowed = () => ALLOWED.some((n) => n.toLowerCase() === userName().toLowerCase());
  // Halaxy may not have filled in who's signed in when this script starts (it starts early in the load order: live,
  // 11 Nov 2026), so keep looking for 20 seconds before deciding it isn't for this person.
  function whenAllowed(fn) {
    if (allowed()) return fn();
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (allowed()) { clearInterval(timer); fn(); } else if (Date.now() - t0 > 20000) clearInterval(timer);
    }, 500);
  }

  // ------------------------------------------------------------------ open-ended wording

  const IF_NEEDED = '(if|when|as) (needed|required|necessary|nec|req|reqd|appropriate)|if (any|further) (problems|issues|concerns|symptoms)|if (it |things |symptoms |pain )?(gets? worse|worsens?|returns?|recurs?|flares?( up)?)|prn|sos';
  const WORDING = [
    ['open return', /\bopen (return|review|f\/?u|follow[- ]?up)\b|\bleft open\b|\bopen[- ]ended\b/i],
    ['open appointment', /\bopen (appointment|appt|booking)\b/i],
    ['book again if needed', new RegExp('\\b(re-?)?book (again|in|back|another( session| appointment| appt)?|a follow[- ]?up)?\\s*(' + IF_NEEDED + ')\\b', 'i')],
    ['come back if needed', new RegExp('\\b(come|coming|call|ring|get|getting|contact|be) (back|in touch|us)\\s*(' + IF_NEEDED + ')\\b|\\b(to |will )?(contact|call|ring|email|e-?mail|text|message) (us|clinic|the clinic|me)?\\s*(' + IF_NEEDED + ')\\b|\\bget in touch\\b', 'i')],
    ['see how things go', /\bsee how (things|it|he|she|they|pt|patient|symptoms|knee|back|shoulder|ankle|hip|neck)?\s*(go(es)?|get(s)? on|progress(es)?|settle(s)?)\b|\bwait and see\b/i],
    ['see as needed', /\b(see|review|f\/?u|follow[- ]?up) (as|when|if) (needed|required|necessary|nec|req|reqd)\b|\bprn\b|\bsos\b/i],
  ];
  const NEGATION = /\b(not|no longer|never|isn'?t|wasn'?t|hasn'?t|without|unable to|no need to)\b[^.]{0,20}$/i;
  function wording(text) {
    const found = [];
    WORDING.forEach(([name, re]) => {
      const g = new RegExp(re.source, 'gi');
      let m;
      while ((m = g.exec(text))) {
        if (NEGATION.test(text.slice(Math.max(0, m.index - 30), m.index))) continue;
        if (!found.includes(name)) found.push(name);
        break;
      }
    });
    return found;
  }

  // ------------------------------------------------------------------ the check

  async function calendar(fromMs, toMs, say) {
    say('Reading the calendar...');
    const pracs = await U().http.json('/lookup/practitioner?clinic=&include_id=&type=');
    const qs = new URLSearchParams({ start: Math.floor(fromMs / 1000), end: Math.floor(toMs / 1000) });
    (Array.isArray(pracs) ? pracs : []).forEach((p, i) => qs.append('practitioners[' + i + '][id]', p.id));
    const cal = await U().http.json('/calendar/json?' + qs.toString());
    return ((cal && cal.payload && cal.payload.events) || []).filter((e) => e.type === 'appointment' && e.linkPaGId);
  }

  async function check(say) {
    say = say || (() => {});
    const now = Date.now(), day0 = today();
    const cache = store.get('cache', {});
    const events = await calendar(day0 - (UP_TO_DAYS + 30) * DAY, day0 + 120 * DAY, say);
    const startMs = (e) => (typeof e.start === 'number' ? e.start * 1000 : Date.parse(e.start));
    const byPatient = new Map();
    events.forEach((e) => {
      const id = String(e.linkPaGId);
      if (!byPatient.has(id)) byPatient.set(id, []);
      byPatient.get(id).push(e);
    });
    const counts = { recent: 0, ended: 0, none: 0, error: 0 };
    const candidates = [];
    for (const [id, evs] of byPatient) {
      const past = evs.filter((e) => startMs(e) < now).sort((a, b) => startMs(b) - startMs(a));
      const attended = past.filter((e) => !e.appointmentStatus);
      const booked = evs.some((e) => startMs(e) >= now && !/cancel|reject|declin|did-not-attend/i.test(e.appointmentStatus || ''));
      if (!attended.length || booked) continue;
      const lastSeen = startMs(attended[0]);
      if (lastSeen < now - UP_TO_DAYS * DAY) continue;
      if (lastSeen > now - AFTER_DAYS * DAY) { counts.recent++; continue; }
      if (past[0] && past[0].appointmentStatus && startMs(past[0]) > lastSeen) { counts.ended++; continue; }   // last one cancelled or missed
      const name = U().clean(U().htmlDoc(attended[0].title || '').body.textContent).replace(/^[\s*★]+/, '') || 'Patient';
      candidates.push({ id, name, lastSeen });
    }
    const rows = [];
    let read = 0;
    for (const p of candidates) {
      read++;
      const ck = p.id + '|' + p.lastSeen;
      let r = cache[ck];
      if (!(r && now - r.at <= KEEP && r.rules === RULES)) {
        say('Reading ' + p.name + '\'s last note (' + read + ' of ' + candidates.length + ')...');
        try {
          const items = await U().notes.items(p.id);
          const last = items.find((x) => x.noteId && x.entity === 'note' && (x.category === 'appointment' || x.category === 'note'));
          r = { at: now, rules: RULES, noteId: last ? last.noteId : null, noteDate: last ? last.date : null, found: last ? wording(await U().notes.text(last.noteId)) : [] };
          cache[ck] = r;
          store.set('cache', cache);
        } catch (e) {
          r = { error: e.message || String(e), found: [] };
          if (/has changed/.test(r.error)) tellHealthCheck(e);
        }
      }
      if (r.error) { counts.error++; rows.push(Object.assign({}, p, { error: r.error, found: [] })); continue; }
      if (!r.found.length) { counts.none++; continue; }
      rows.push(Object.assign({}, p, { found: r.found, noteId: r.noteId, noteDate: r.noteDate }));
    }
    Object.keys(cache).forEach((k) => { if (now - cache[k].at > KEEP) delete cache[k]; });
    store.set('cache', cache);
    rows.sort((a, b) => (a.error ? 1 : 0) - (b.error ? 1 : 0) || a.lastSeen - b.lastSeen);
    const result = { at: Date.now(), by: VERSION, rows, counts, listed: rows.filter((r) => !r.error).length };
    store.set('result', result);
    return result;
  }

  function tellHealthCheck(e) {
    const message = (e && e.message) || String(e);
    if (!/has changed/.test(message)) return;
    document.dispatchEvent(new CustomEvent('upc-loader-error', { detail: JSON.stringify({ file: 'check-ins.user.js', message }) }));
  }

  // ------------------------------------------------------------------ menu count

  const locked = () => Date.now() - store.get('running', 0) < 2 * 60e3;
  async function checkLocked(say) {
    store.set('running', Date.now());
    const beat = (t) => { store.set('running', Date.now()); if (say) say(t); };
    try { return await check(beat); } finally { store.set('running', 0); }
  }
  async function refreshCount() {
    if (!allowed() || document.visibilityState !== 'visible' || !U() || U().http.pausedFor() > 0 || locked()) return;
    const last = store.get('result', null);
    if (last && Date.now() - last.at < REFRESH_EVERY && last.by === VERSION) return;
    try { await checkLocked(); } catch (e) { console.warn('[UPC open-ended patients]', e); tellHealthCheck(e); }
    paintBadge();
  }
  function paintBadge() {
    const a = document.querySelector('a.' + MENU_CLS);
    if (!a) return;
    const r = store.get('result', null);
    const n = r ? r.listed : 0;
    let b = a.querySelector('.upc-ci-badge');
    if (!n) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('span'); b.className = 'upc-ci-badge'; a.appendChild(b); }
    const text = n > 99 ? '99+' : String(n);
    if (b.textContent !== text) b.textContent = text;
    const title = n + ' patient' + (n === 1 ? '' : 's') + ' to check in with';
    if (b.title !== title) b.title = title;
  }

  // ------------------------------------------------------------------ page

  const CSS = `
    .upc-ci-badge { display: inline-block; min-width: 18px; margin-left: 6px; padding: 0 5px; border-radius: 9px; font-size: .75em; line-height: 18px;
      text-align: center; font-weight: 600; color: #fff; background: var(--vs-notification-badge-bg-color, #ec6b65); vertical-align: middle; }
    .upc-ci { max-width: 1100px; }
    .upc-ci h1 { margin: 0 0 16px; }
    .upc-ci .card { margin-bottom: 24px; }
    .upc-ci .card-header h2 { margin: 0; }
    .upc-ci .upc-ci-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-bottom: 12px; }
    .upc-ci .upc-ci-bar .btn { margin: 0; }
    .upc-ci td.upc-ci-date { white-space: nowrap; }
  `;
  const state = { unmount: null, running: false, status: '', error: '' };
  let root = null;

  function render() {
    if (!root) return;
    const r = store.get('result', null);
    const base = U().base();
    let h = '<div class="upc-ci"><h1>Open-ended patients</h1><div class="upc-ci-bar">' +
      '<button type="button" class="btn btn-outline-primary-light" data-a="refresh" ' + (state.running ? 'disabled' : '') + '>' + (state.running ? 'Checking...' : 'Check again') + '</button>' +
      '<span class="text-muted">' + esc(state.running ? state.status : r ? 'Checked at ' + new Date(r.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + ' on ' + label(r.at) + '.' : '') + '</span></div>';
    if (state.error) h += '<p class="upc-err">' + esc(state.error) + '</p>';
    if (r) {
      const ok = r.rows.filter((x) => !x.error), bad = r.rows.filter((x) => x.error);
      h += '<div class="card"><div class="card-header"><h2>Nothing booked (' + ok.length + ')</h2></div><div class="card-body p-0">' +
        (ok.length ? '<table class="table table-striped table-bordered w-100 m-0"><thead><tr><th>Patient</th><th>Last seen</th><th class="number">Days</th><th>Last note says</th></tr></thead><tbody>' +
          ok.map((x) => '<tr><td><a href="' + esc(base + '/patient/' + x.id) + '" target="_blank" rel="noopener">' + esc(x.name) + '</a></td>' +
            '<td class="upc-ci-date">' + esc(label(x.lastSeen)) + '</td><td class="number">' + Math.round((today() - new Date(x.lastSeen).setHours(0, 0, 0, 0)) / DAY) + '</td>' +
            '<td>' + esc(x.found.join(', ')) + (x.noteId ? ' (<a href="' + esc(base + '/patient/' + x.id + '/clinical/category/note/id/' + x.noteId) + '" target="_blank" rel="noopener">note' + (x.noteDate ? ' ' + esc(label(x.noteDate)) : '') + '</a>)' : '') + '</td></tr>').join('') + '</tbody></table>'
          : '<p class="text-muted m-3">Nobody left open-ended is due a check-in.</p>') + '</div></div>';
      if (bad.length) h += '<p class="upc-err">Notes not read for ' + bad.map((x) => esc(x.name) + ' (' + esc(x.error) + ')').join(', ') + '.</p>';
      const c = r.counts || {};
      h += '<p class="text-muted">Patients last seen ' + AFTER_DAYS + ' days to 3 months ago, with nothing booked, whose latest note leaves treatment open-ended ' +
        '("open return", "book again if needed", "see how things go", "come back if needed" and similar). Left out: ' + (c.recent || 0) + ' seen in the last ' + AFTER_DAYS + ' days, ' +
        (c.ended || 0) + ' whose last appointment was cancelled or missed, ' + (c.none || 0) + ' whose last note doesn\'t leave it open. Nothing is sent from here yet.</p>';
    }
    h += '<div class="text-muted upc-version">Open-ended patients ' + VERSION + '</div></div>';
    root.innerHTML = h;
  }

  async function run() {
    if (state.running) return;
    state.running = true;
    state.error = '';
    state.status = 'Checking...';
    render();
    try {
      if (locked()) {
        state.status = 'Checking in another tab...';
        render();
        const t0 = Date.now();
        while (locked() && Date.now() - t0 < 10 * 60e3) await U().sleep(1000);
        const r = store.get('result', null);
        if (!r || Date.now() - r.at > PAGE_FRESH) await checkLocked((t) => { state.status = t; render(); });
      } else {
        await checkLocked((t) => { state.status = t; render(); });
      }
    } catch (e) {
      state.error = 'Could not check: ' + (e.message || e);
      tellHealthCheck(e);
    }
    state.running = false;
    render();
    paintBadge();
  }

  function mount() {
    if (state.unmount || !allowed()) return;
    U().ui.nativeStyles();
    root = document.createElement('div');
    root.className = 'upc-native';
    root.setAttribute('data-upc-check-ins', '');
    root.addEventListener('click', (e) => { if (e.target.closest('[data-a=refresh]')) run(); });
    state.unmount = U().ui.mountPage('Open-ended patients', root, MENU_CLS);
    render();
    const r = store.get('result', null);
    if (!r || Date.now() - r.at > PAGE_FRESH || r.by !== VERSION) run();
  }
  function unmount() {
    if (!state.unmount) return;
    state.unmount();
    state.unmount = null;
    root = null;
  }
  const route = () => (location.hash === '#' + ROUTE ? mount() : unmount());

  function start() {
    if (!U()) { console.error('[UPC open-ended patients] needs the core library'); return; }
    if (!allowed()) return;
    if (!document.getElementById('upc-check-ins-css')) { const st = document.createElement('style'); st.id = 'upc-check-ins-css'; st.textContent = CSS; document.head.appendChild(st); }
    // Under Patients, opening over Halaxy's Patient List (as Review requests does).
    U().ui.ensureMenuItem('Open-ended patients', (section) => {
      const list = section && [...section.querySelectorAll('a.mainmenu-sublink')].find((a) => /^patient list$/i.test(U().clean(a.textContent)));
      return (list ? list.getAttribute('href').split('#')[0] : U().base() + '/patient/') + '#' + ROUTE;
    }, MENU_CLS, /^patients?$/i);
    new MutationObserver(paintBadge).observe(document.getElementById('mainMenu') || document.body, { childList: true, subtree: true });
    window.addEventListener('storage', (e) => { if (e.key === KEY + 'result') { paintBadge(); render(); } });
    document.addEventListener('visibilitychange', refreshCount);
    window.addEventListener('hashchange', route);
    paintBadge();
    route();
    setTimeout(refreshCount, 6000);
    setInterval(refreshCount, 30 * 60e3);
  }
  const begin = () => { if (U()) whenAllowed(start); else start(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', begin, { once: true });
  else begin();

  window.upcCheckIns = { version: VERSION, wording, check, allowed };
})();
