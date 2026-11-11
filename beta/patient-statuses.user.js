// ==UserScript==
// @name         Halaxy patient statuses (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.1.1
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/patient-statuses.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/patient-statuses.user.js
// @description  Patients > Patient statuses (Carl only for now): patients whose status looks out of date (Current, Claimant or Discharged, and Contacts who have an appointment), with the suggested status and why, and Change / Change all after confirming. Review and every other status are left alone.
// @match        https://*.halaxy.com/a/pr/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * Patient statuses (Carl, 11 Nov 2026). Suggests; changes only when asked, for now. Once the suggestions have been
 * right on real patients, the plan is to change them automatically.
 *
 *  - Only Current, Claimant and Discharged are suggested or changed. Review is set by hand (Carl: "not something that
 *    should be guessed at"), and Archived, Waiting List, Blocked and the rest are left alone.
 *  - From one calendar request (6 months back, 4 months ahead):
 *    - Something booked: Current if the next booked appointment's fee is self-funded, Claimant if it's funded.
 *      This also brings back a Discharged patient who has booked again.
 *    - Nothing booked, and no appointment for 6 weeks or more: Discharged (open-ended patients too, Carl).
 *    - Nothing booked, seen in the last 6 weeks: Discharged if their last note says so ("discharged", "goals met",
 *      "no further treatment needed", "self-managing"); otherwise Current or Claimant from their last fee.
 *  - Funded or not (Carl: the latest fee): the fee's own funder in Halaxy's fee list (the appointment type sets the fee,
 *    so an online booking counts before any claim exists), or the invoice being linked to an insurance claim.
 *  - Contact (only another patient's contact, hidden from searches) with an appointment: moved to the usual statuses
 *    by the same rules (Carl, 11 Nov 2026). Contact is never suggested.
 *  - The status itself is changed on the patient's Edit page (core UPC.patient.setStatus), only from what was shown, so
 *    a status someone changed meanwhile is left alone.
 */
(() => {
  'use strict';
  if (window.__hxPatientStatuses) return;
  window.__hxPatientStatuses = true;

  const VERSION = '0.1.1';
  const ROUTE = 'upc-patient-statuses';
  const MENU_CLS = 'upc-ps-menu';
  const ALLOWED = ['Carl Healy'];
  const DAY = 86400e3;
  const GAP_DAYS = 42;          // Carl, 11 Nov 2026: a gap counts; 6 weeks
  const BACK_DAYS = 183, AHEAD_DAYS = 122;
  const MANAGED = ['current', 'claimant', 'discharged'];
  // Contact (someone added only as another patient's contact) who has an appointment, say booked online: moved to the
  // usual statuses, as Contacts don't show in searches (Carl, 11 Nov 2026). Never suggested as a status.
  const FROM = MANAGED.concat(['contact']);
  const SELF_FUNDED = /self|private/i;
  const KNOWN = MANAGED.concat(['review', 'archived', 'waiting list', 'blocked', 'deleted', 'deceased', 'contact', 'lead']);
  const NAME = { current: 'Current', claimant: 'Claimant', discharged: 'Discharged', contact: 'Contact' };
  const REFRESH_EVERY = 12 * 3600e3, PAGE_FRESH = 30 * 60e3;
  const KEY = 'upc-ps:';

  const U = () => window.UPC;
  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(KEY + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
  };
  const label = (ms) => U().dayLabel(ms);
  const norm = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

  function userName() {
    const h = window.HkUser || {};
    const named = String(h.pracName || (h.CalendarDefault || {}).pracName || '').trim();
    if (named) return named;
    const btn = document.getElementById('activeUser');
    return btn ? btn.textContent.replace(/\s+/g, ' ').trim() : '';
  }
  const allowed = () => ALLOWED.some((n) => n.toLowerCase() === userName().toLowerCase());

  // Treatment finished, in the last note. "See as needed" and similar open-ended wording don't count: those patients
  // are discharged by the 6-week gap instead.
  const FINISHED = /\bdischarg(ed|e)\b|\bgoals? (met|achieved|reached)\b|\bno (further|more) (treatment|physio|physiotherapy|sessions?|appointments?) (needed|required|necessary)\b|\bself[- ]?manag/i;
  const NEGATION = /\b(not|no longer|never|isn'?t|wasn'?t|hasn'?t|without|unable to|not yet|before)\b[^.]{0,20}$/i;
  function saysFinished(text) {
    const g = new RegExp(FINISHED.source, 'gi');
    let m;
    while ((m = g.exec(text))) {
      if (!NEGATION.test(text.slice(Math.max(0, m.index - 30), m.index))) return m[0].toLowerCase();
    }
    return '';
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
    const now = Date.now();
    const funded = store.get('funded2', {});     // invoice id -> true (funded) / false (self-funded)
    const finished = store.get('finished', {});  // note id -> wording found ('' if none)
    const events = await calendar(now - BACK_DAYS * DAY, now + AHEAD_DAYS * DAY, say);
    const startMs = (e) => (typeof e.start === 'number' ? e.start * 1000 : Date.parse(e.start));
    const byPatient = new Map();
    events.forEach((e) => { const id = String(e.linkPaGId); if (!byPatient.has(id)) byPatient.set(id, []); byPatient.get(id).push(e); });
    const counts = { other: 0, right: 0, unknown: 0 };
    const rows = [];
    // Funded: the fee's own funder (set by the fee, which the appointment type sets, so an online booking counts before
    // any claim exists), or the invoice being linked to an insurance claim.
    let feeFunder = null;
    const fundedOf = async (e) => {
      const iid = e.invoiceID || e.invoiceId;
      if (!iid) return null;
      if (!(String(iid) in funded)) {
        if (!feeFunder) {
          const fees = await U().http.json('/funder/fee/data');
          feeFunder = {};
          (Array.isArray(fees) ? fees : []).forEach((f) => { if (f && f.feeNumber) feeFunder[U().clean(f.feeNumber).toLowerCase()] = String(f.funder || ''); });
        }
        const inv = await U().invoice.fetch(iid);
        const byFee = inv.lines.some((l) => { const f = feeFunder[U().clean(l.item).toLowerCase()]; return !!f && !SELF_FUNDED.test(f); });
        funded[iid] = byFee || !!inv.claimId;
        store.set('funded2', funded);
      }
      return funded[iid];
    };
    const list = [...byPatient.entries()];
    let n = 0;
    for (const [id, evs] of list) {
      n++;
      evs.sort((a, b) => startMs(a) - startMs(b));
      const name = U().clean(U().htmlDoc(evs[evs.length - 1].title || '').body.textContent).replace(/^[\s*★]+/, '') || 'Patient';
      let status = norm(evs.map((e) => e.patientStatus).filter(Boolean).pop());
      const future = evs.filter((e) => startMs(e) >= now && !/cancel|reject|declin|did-not-attend/i.test(e.appointmentStatus || ''));
      const attended = evs.filter((e) => startMs(e) < now && !e.appointmentStatus);
      if (!future.length && !attended.length) continue;
      const tell = (t) => say(t + ' (' + n + ' of ' + list.length + ')...');
      try {
        // The calendar carries each patient's status; if it isn't one of Halaxy's status names, ask the patient's details.
        if (!KNOWN.includes(status)) { tell('Reading ' + name + '\'s status'); status = norm((await U().patient.details(id)).status); }
        if (!FROM.includes(status)) { counts.other++; continue; }
        let to = '', why = '';
        if (future.length) {
          tell('Reading the fee for ' + name);
          const f = await fundedOf(future[0]);
          if (f === null) { counts.unknown++; continue; }
          to = f ? 'claimant' : 'current';
          why = 'Booked ' + label(startMs(future[0])) + ', ' + (f ? 'funded fee' : 'self-funded fee');
        } else {
          const last = attended[attended.length - 1];
          const gap = Math.floor((now - startMs(last)) / DAY);
          if (gap >= GAP_DAYS) {
            to = 'discharged';
            why = 'No appointment for ' + Math.floor(gap / 7) + ' weeks (last ' + label(startMs(last)) + '), nothing booked';
          } else if (status !== 'discharged') {
            tell('Reading ' + name + '\'s last note');
            const items = await U().notes.items(id);
            const note = items.find((x) => x.noteId && x.entity === 'note' && (x.category === 'appointment' || x.category === 'note'));
            let said = '';
            if (note) {
              if (!(note.noteId in finished)) { finished[note.noteId] = saysFinished(await U().notes.text(note.noteId)); store.set('finished', finished); }
              said = finished[note.noteId];
            }
            if (said) { to = 'discharged'; why = 'Last note (' + label(note.date || startMs(last)) + ') says "' + said + '", nothing booked'; }
            else {
              const f = await fundedOf(last);
              if (f === null) { counts.unknown++; continue; }
              to = f ? 'claimant' : 'current';
              why = 'Seen ' + label(startMs(last)) + ', ' + (f ? 'funded fee' : 'self-funded fee') + ', treatment still going';
            }
          } else { counts.right++; continue; }   // discharged, seen recently, nothing booked: leave it
        }
        if (to === status) { counts.right++; continue; }
        rows.push({ id, name, from: status, to, why });
      } catch (e) {
        if (/has changed/.test(e.message || '')) tellHealthCheck(e);
        rows.push({ id, name, from: status, to: '', why: '', error: e.message || String(e) });
      }
    }
    const order = { discharged: 0, claimant: 1, current: 2, '': 3 };
    rows.forEach((r) => { if (r.from === 'contact' && r.to) r.why = 'Contact with an appointment (not found in searches). ' + r.why; });
    rows.sort((a, b) => order[a.to] - order[b.to] || a.name.localeCompare(b.name));
    const result = { at: Date.now(), by: VERSION, rows, counts, suggested: rows.filter((r) => r.to).length };
    store.set('result', result);
    return result;
  }

  function tellHealthCheck(e) {
    const message = (e && e.message) || String(e);
    if (!/has changed/.test(message)) return;
    document.dispatchEvent(new CustomEvent('upc-loader-error', { detail: JSON.stringify({ file: 'patient-statuses.user.js', message }) }));
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
    try { await checkLocked(); } catch (e) { console.warn('[UPC patient statuses]', e); tellHealthCheck(e); }
    paintBadge();
  }
  const done = new Map();   // patient id -> { ok, error, busy }
  function paintBadge() {
    const a = document.querySelector('a.' + MENU_CLS);
    if (!a) return;
    const r = store.get('result', null);
    const n = r ? r.rows.filter((x) => x.to && !(done.get(x.id) || {}).ok).length : 0;
    let b = a.querySelector('.upc-ps-badge');
    if (!n) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('span'); b.className = 'upc-ps-badge'; a.appendChild(b); }
    const text = n > 99 ? '99+' : String(n);
    if (b.textContent !== text) b.textContent = text;
    const title = n + ' patient status' + (n === 1 ? '' : 'es') + ' to update';
    if (b.title !== title) b.title = title;
  }

  // ------------------------------------------------------------------ page

  const CSS = `
    .upc-ps-badge { display: inline-block; min-width: 18px; margin-left: 6px; padding: 0 5px; border-radius: 9px; font-size: .75em; line-height: 18px;
      text-align: center; font-weight: 600; color: #fff; background: var(--vs-notification-badge-bg-color, #ec6b65); vertical-align: middle; }
    .upc-ps { max-width: 1100px; }
    .upc-ps h1 { margin: 0 0 16px; }
    .upc-ps .card { margin-bottom: 24px; }
    .upc-ps .card-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .upc-ps .card-header h2 { margin: 0; }
    .upc-ps .upc-ps-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-bottom: 12px; }
    .upc-ps .btn { margin: 0; }
    .upc-ps td.upc-ps-act { white-space: nowrap; }
  `;
  const state = { unmount: null, running: false, status: '', error: '', all: false };
  let root = null;

  function render() {
    if (!root) return;
    const r = store.get('result', null);
    const base = U().base();
    let h = '<div class="upc-ps"><h1>Patient statuses</h1><div class="upc-ps-bar">' +
      '<button type="button" class="btn btn-outline-primary-light" data-a="refresh" ' + (state.running || state.all ? 'disabled' : '') + '>' + (state.running ? 'Checking...' : 'Check again') + '</button>' +
      '<span class="text-muted">' + esc(state.running ? state.status : r ? 'Checked at ' + new Date(r.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + ' on ' + label(r.at) + '.' : '') + '</span></div>';
    if (state.error) h += '<p class="upc-err">' + esc(state.error) + '</p>';
    if (r) {
      const sug = r.rows.filter((x) => x.to), bad = r.rows.filter((x) => !x.to);
      const left = sug.filter((x) => !(done.get(x.id) || {}).ok).length;
      h += '<div class="card"><div class="card-header"><h2>To update (' + sug.length + ')</h2>' +
        (left ? '<button type="button" class="btn btn-primary" data-a="all" ' + (state.all || state.running ? 'disabled' : '') + '>' + (state.all ? 'Changing...' : 'Change all (' + left + ')') + '</button>' : '') + '</div><div class="card-body p-0">' +
        (sug.length ? '<table class="table table-striped table-bordered w-100 m-0"><thead><tr><th>Patient</th><th>Now</th><th>Change to</th><th>Why</th><th></th></tr></thead><tbody>' +
          sug.map((x) => {
            const d = done.get(x.id) || {};
            const act = d.busy ? '<span class="text-muted">Changing...</span>' : d.ok ? '<span class="upc-ok">Changed</span>'
              : (d.error ? '<span class="upc-err">' + esc(d.error) + '</span> ' : '') + '<button type="button" class="btn btn-outline-primary-light" data-change="' + esc(x.id) + '"' + (state.all ? ' disabled' : '') + '>Change</button>';
            return '<tr><td><a href="' + esc(base + '/patient/' + x.id) + '" target="_blank" rel="noopener">' + esc(x.name) + '</a></td><td>' + esc(NAME[x.from] || x.from) + '</td>' +
              '<td><b>' + esc(NAME[x.to]) + '</b></td><td>' + esc(x.why) + '</td><td class="upc-ps-act">' + act + '</td></tr>';
          }).join('') + '</tbody></table>'
          : '<p class="text-muted m-3">Every Current, Claimant, Discharged and Contact status looks right.</p>') + '</div></div>';
      if (bad.length) h += '<p class="upc-err">Not checked: ' + bad.map((x) => esc(x.name) + ' (' + esc(x.error) + ')').join(', ') + '.</p>';
      const c = r.counts || {};
      h += '<p class="text-muted">Patients with an appointment in the last 6 months or booked in the next 4. Booked: Current if the booked fee is self-funded, Claimant if it\'s funded. ' +
        'Contacts with an appointment are moved to these too. ' +
        'Nothing booked: Discharged after ' + (GAP_DAYS / 7) + ' weeks without an appointment, or sooner if the last note says treatment has finished. ' +
        'Review and every other status are never suggested or changed (' + (c.other || 0) + ' left alone). ' + (c.right || 0) + ' already right.' +
        (c.unknown ? ' ' + c.unknown + ' couldn\'t be told (no invoice for the fee).' : '') + '</p>';
    }
    h += '<div class="text-muted upc-version">Patient statuses ' + VERSION + '</div></div>';
    root.innerHTML = h;
  }

  function confirmDlg(title, html, yes) {
    return new Promise((resolve) => {
      let answered = false;
      const end = (v) => { if (!answered) { answered = true; resolve(v); } };
      const dlg = U().ui.dialog({ title, small: true, onClose: () => end(false) });
      if (!dlg) { end(false); return; }
      dlg.root.setAttribute('data-upc-ps-confirm', '');
      dlg.body.innerHTML = html + '<div class="upc-actions"><button type="button" class="btn btn-outline-primary" data-c="no">Cancel</button><button type="button" class="btn btn-primary" data-c="yes">' + esc(yes) + '</button></div>';
      dlg.body.addEventListener('click', (e) => { const b = e.target.closest('[data-c]'); if (!b) return; end(b.dataset.c === 'yes'); dlg.close(); });
    });
  }

  async function changeOne(x) {
    done.set(x.id, { busy: true });
    render();
    try { await U().patient.setStatus(x.id, x.from, x.to); done.set(x.id, { ok: true }); }
    catch (e) { done.set(x.id, { ok: false, error: e.message || String(e) }); tellHealthCheck(e); }
    render();
    paintBadge();
  }
  async function change(id) {
    const r = store.get('result', null);
    const x = r && r.rows.find((y) => y.id === id && y.to);
    if (!x || (done.get(id) || {}).busy || (done.get(id) || {}).ok) return;
    if (!(await confirmDlg('Change status?', '<p>Change ' + esc(x.name) + ' from ' + esc(NAME[x.from] || x.from) + ' to <b>' + esc(NAME[x.to]) + '</b>?</p><p class="text-muted">' + esc(x.why) + '.</p>', 'Change to ' + NAME[x.to]))) return;
    await changeOne(x);
  }
  async function changeAll() {
    const r = store.get('result', null);
    const todo = r ? r.rows.filter((x) => x.to && !(done.get(x.id) || {}).ok) : [];
    if (!todo.length || state.all) return;
    const by = {};
    todo.forEach((x) => { by[x.to] = (by[x.to] || 0) + 1; });
    if (!(await confirmDlg('Change all?', '<p>Change ' + todo.length + ' patient status' + (todo.length === 1 ? '' : 'es') + ': ' +
      Object.keys(by).map((k) => by[k] + ' to ' + NAME[k]).join(', ') + '?</p><p class="text-muted">Each is changed on the patient\'s Edit page, only if it still shows what\'s listed here.</p>', 'Change all'))) return;
    state.all = true;
    render();
    for (const x of todo) { if (!root) break; await changeOne(x); }
    state.all = false;
    render();
  }

  async function run() {
    if (state.running) return;
    state.running = true;
    state.error = '';
    state.status = 'Checking...';
    done.clear();
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
    root.setAttribute('data-upc-patient-statuses', '');
    root.addEventListener('click', (e) => {
      if (e.target.closest('[data-a=refresh]')) run();
      if (e.target.closest('[data-a=all]')) changeAll();
      const c = e.target.closest('[data-change]');
      if (c) change(c.dataset.change);
    });
    state.unmount = U().ui.mountPage('Patient statuses', root, MENU_CLS);
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
    if (!U()) { console.error('[UPC patient statuses] needs the core library'); return; }
    if (!allowed()) return;
    if (!document.getElementById('upc-patient-statuses-css')) { const st = document.createElement('style'); st.id = 'upc-patient-statuses-css'; st.textContent = CSS; document.head.appendChild(st); }
    U().ui.ensureMenuItem('Patient statuses', (section) => {
      const list = section && [...section.querySelectorAll('a.mainmenu-sublink')].find((a) => /^patient list$/i.test(U().clean(a.textContent)));
      return (list ? list.getAttribute('href').split('#')[0] : U().base() + '/patient/') + '#' + ROUTE;
    }, MENU_CLS, /^patients?$/i);
    new MutationObserver(paintBadge).observe(document.getElementById('mainMenu') || document.body, { childList: true, subtree: true });
    window.addEventListener('storage', (e) => { if (e.key === KEY + 'result') { paintBadge(); render(); } });
    document.addEventListener('visibilitychange', refreshCount);
    window.addEventListener('hashchange', route);
    paintBadge();
    route();
    setTimeout(refreshCount, 7000);
    setInterval(refreshCount, 30 * 60e3);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  window.upcPatientStatuses = { version: VERSION, saysFinished, check, allowed };
})();
