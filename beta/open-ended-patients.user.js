// ==UserScript==
// @name         UPC Patients: Open-ended recalls (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.4.2
// @upc-was      check-ins.user.js
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/open-ended-patients.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/open-ended-patients.user.js
// @description  Patients > Open-ended recalls (CH only for now): patients left open-ended in their last note ("open return", "book again if needed" and so on), last seen 3 weeks or more ago, with nothing booked. A list with a count on the menu; Send recall schedules the "Recall - Open-ended" email, once per episode, after confirming.
// @match        https://*.halaxy.com/a/pr/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * Open-ended patients (CH, 11 Nov 2026; named by CH; first built as Check-ins, and the file keeps that name), the list only for now: who to send a short "how are things going?" with the booking link.
 *
 *  - One calendar request: patients whose last attended appointment was 3 weeks to 3 months ago, with nothing booked
 *    since and nothing booked ahead. Left out if their last appointment was cancelled or missed.
 *  - For each, their latest clinical note is read (two requests the first time; kept for a week per patient and visit) for
 *    open-ended wording: "open return", "open appointment", "book again if needed", "see how things go",
 *    "come back if needed" and similar. "Not", "no longer" and so on just before a phrase cancel it.
 *  - Shown: the patient, last seen, which wording was found and a link to the note.
 *  - Separate from Review requests: neither reads or affects the other (CH, 11 Nov 2026).
 *  - Note text is read when checking and never kept: only which wording was found.
 *  - Send recall (0.2.0, CH, 17-18 Nov 2026: "Open-ended recalls"): after confirming, schedules the Halaxy template
 *    "Recall - Open-ended" through Email patient for the next weekday at 10:30, once per episode (the last visit). From
 *    the clinic; [Practitioner First Name] is written in as the practitioner of the last visit (Halaxy would fill it
 *    with whoever is signed in); Halaxy fills [Patient First Name], also in the subject. Recorded in the shared note
 *    "Open-ended recalls" (p.<patient> = sched <time> <last visit day>) so every PC knows, and checked in the patient's
 *    scheduled emails. A send Halaxy accepted is never repeated, even if it can't be seen afterwards.
 *    No opt-out field yet (CH, 18 Nov 2026: later).
 *  - Cancelled, not rebooked (0.3.0, CH, 18 Nov 2026): last visit 3 weeks to 3 months ago, the booking after it
 *    cancelled or missed, nothing booked since; its own card, same recall email. Left out: last note says treatment
 *    finished, or an unpaid invoice of their own (chasing payment comes first; the Unpaid Invoices report finds who
 *    might owe, their own invoices confirm). Don't send: p.<patient> = skip 0 <last visit day>, for every PC.
 */
(() => {
  'use strict';
  if (window.__hxCheckIns) return;
  window.__hxCheckIns = true;

  const VERSION = '0.4.2';
  const ROUTE = 'upc-check-ins';
  const MENU_CLS = 'upc-ci-menu';
  const ALLOWED = () => rule('openEnded.people', ['Carl Healy']);
  const DAY = 86400e3;
  // Clinic settings (Script settings > Clinic settings; core's UPC.settings), with the defaults if core is older.
  const rule = (k, d) => (window.UPC && UPC.settings && UPC.settings.def(k) ? UPC.settings.get(k) : d);
  const AFTER_DAYS = () => rule('openEnded.afterDays', 21);   // CH, 11 Nov 2026: 3 weeks after the last visit
  const UP_TO_DAYS = () => rule('openEnded.upToDays', 91);    // not further back than about 3 months
  const REFRESH_EVERY = 12 * 3600e3, PAGE_FRESH = 30 * 60e3, KEEP = 7 * DAY;
  const KEY = 'upc-ci:';
  const RULES = 4;   // bump when the wording list changes, so patients are read again

  const U = () => window.UPC;
  const esc = (s) => U().esc(s);
  const store = { get: (k, d) => U().storage(KEY).get(k, d), set: (k, v) => U().storage(KEY).set(k, v), del: (k) => U().storage(KEY).del(k) };   // core's per-PC storage

  // Shared with every PC (CH, 16 Nov 2026; core's UPC.sharedResult): one PC works the list out and every PC
  // shows it, so the list (and its count) is the same everywhere and Halaxy is read once for the clinic.
  const sharedList = () => (U() && U().sharedResult ? U().sharedResult('Open-ended patients') : null);
  // A list worked out by an older version on another PC (before every PC has updated) doesn't replace this PC's own:
  // it lacks what this version adds (0.2.0: the practitioner, so Send recall couldn't name them).
  async function pullShared(maxAge) {
    const sl = sharedList(); if (!sl) return;
    const mine = store.get('result', null);
    try { await sl.pull(store, maxAge); } catch (e) { /* this PC's own list */ }
    const now = store.get('result', null);
    if (now && now.by !== VERSION && mine && mine.by === VERSION) store.set('result', mine);
  }
  function pushShared(result) { const sl = sharedList(); if (sl) sl.push(result).catch((e) => console.warn('[UPC open-ended patients] shared list', e)); }
  async function myTurn() { const sl = sharedList(); if (!sl) return true; try { return await sl.claim(); } catch (e) { return true; } }

  const label = (ms) => U().dayLabel(ms);
  const TEMPLATE = 'Recall - Open-ended';
  const recalls = () => U().shared('Open-ended recalls', { keep: 150 * DAY, claimFor: 5 * 60e3, file: 'open-ended-patients.user.js' });
  const dayOf = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const two = (n) => String(n).padStart(2, '0');
  const whenLabel = (ms) => { const d = new Date(ms); return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()] + ' ' + label(ms) + ' at ' + two(d.getHours()) + ':' + two(d.getMinutes()); };
  // The next weekday 10:30 at least 15 minutes away (as Review requests).
  function sendTime() {
    const d = new Date();
    d.setHours(10, 30, 0, 0);
    if (d.getTime() < Date.now() + 15 * 60e3) d.setDate(d.getDate() + 1);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  // This patient's recall for this episode: { value: 'sched <ms> <day>' | 'check <ms> <day>' } or null.
  function recallFor(row, recs) {
    const r = recs['p.' + row.id];
    if (!r || !r.value) return null;
    const f = r.value.split(' ');
    if (f[2] !== dayOf(row.lastSeen) || f[0] === 'undo') return null;   // undo: a Don't send taken back
    return { kind: f[0], at: Number(f[1]) };                             // sched, check or skip
  }
  const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

  // Who's signed in: the core library's check (Halaxy can fill the name in late, so it keeps looking for 20 seconds).
  const allowed = () => !!U() && U().user.is(ALLOWED());
  const whenAllowed = (fn) => U().user.whenAllowed(ALLOWED(), fn);

  // ------------------------------------------------------------------ open-ended wording

  // The core library's open-ended wording (open return, book again if needed, see as needed and so on), so every script
  // reads a note the same way.
  const wording = (text) => U().wording.openEnded(text);

  // ------------------------------------------------------------------ the check

  // Appointments from the calendar: the core library reads one standard window per page and shares it with the other
  // scripts that read long windows (Patient statuses, Open-ended patients, Review requests).
  async function calendar(fromMs, toMs, say) {
    say('Reading the calendar...');
    return U().calendar.appointments(fromMs, toMs);
  }


  // Owing money: the Unpaid Invoices report (one request for everyone) names who might; only their own invoices are read
  // to be sure (as Review requests). Its Payer ID is the clinic's patient number, so the match is by name.
  let unpaid = null;
  async function owes(p) {
    if (unpaid === null) {
      try {
        const lines = await U().reports.unpaidLines(label(today() - 3 * 366 * DAY));
        unpaid = new Set(lines.filter((l) => /^P-?\d+$/i.test(String(l.payerId || '').trim())).map((l) => U().clean(l.payer).toLowerCase()));
      } catch (e) { unpaid = false; tellHealthCheck(e); }
    }
    if (unpaid && !unpaid.has(U().clean(p.name).toLowerCase())) return false;
    return (await U().patient.invoices(p.id)).some((x) => /not yet paid|part/i.test(String(x.status || '')) && Number(String(x.balance).replace(/[^\d.-]/g, '')) > 0);
  }

  async function check(say) {
    unpaid = null;
    say = say || (() => {});
    const now = Date.now(), day0 = today();
    const cache = store.get('cache', {});
    const events = await calendar(day0 - (UP_TO_DAYS() + 30) * DAY, day0 + 120 * DAY, say);
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
      if (lastSeen < now - UP_TO_DAYS() * DAY) continue;
      if (lastSeen > now - AFTER_DAYS() * DAY) { counts.recent++; continue; }
      // The booking after the last visit cancelled or missed, nothing since: "Cancelled, not rebooked".
      const after = past.find((e) => startMs(e) > lastSeen && /cancel|did-not-attend/i.test(e.appointmentStatus || ''));
      if (past[0] && past[0].appointmentStatus && startMs(past[0]) > lastSeen && !after) { counts.ended++; continue; }
      const name = U().clean(U().htmlDoc(attended[0].title || '').body.textContent).replace(/^[\s*★]+/, '') || 'Patient';
      const c = { id, name, lastSeen, pracId: String(attended[0].practitionerID || '') };
      if (after) { c.kind = 'cancelled'; c.missedOn = startMs(after); c.missed = /did-not-attend/i.test(after.appointmentStatus || '') ? 'Missed' : 'Cancelled'; }
      candidates.push(c);
    }
    const pracs = new Map();
    try { (await U().http.json('/lookup/practitioner?clinic=&include_id=&type=') || []).forEach((x) => pracs.set(String(x.id), U().clean(x.name))); } catch (e) { /* names left blank */ }
    candidates.forEach((p) => { p.prac = pracs.get(p.pracId) || ''; delete p.pracId; });
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
          const f = last ? await U().notes.facts(last.noteId, ['open', 'finished'], { draft: /draft/i.test(last.status) }) : { open: [], finished: [] };
          r = { at: now, rules: RULES, noteId: last ? last.noteId : null, noteDate: last ? last.date : null, found: f.open, finished: f.finished.length > 0 };
          cache[ck] = r;
          store.set('cache', cache);
        } catch (e) {
          r = { error: e.message || String(e), found: [] };
          if (/has changed/.test(r.error)) tellHealthCheck(e);
        }
      }
      if (r.error) { counts.error++; rows.push(Object.assign({}, p, { error: r.error, found: [] })); continue; }
      if (p.kind === 'cancelled') {
        if (r.finished) { counts.finished = (counts.finished || 0) + 1; continue; }
        if (await owes(p)) { counts.owing = (counts.owing || 0) + 1; continue; }
      } else if (!r.found.length) { counts.none++; continue; }
      else if (r.finished) { counts.done = (counts.done || 0) + 1; continue; }   // "Discharge ... return if symptoms recur": finished
      rows.push(Object.assign({}, p, { found: r.found, noteId: r.noteId, noteDate: r.noteDate }));
    }
    Object.keys(cache).forEach((k) => { if (now - cache[k].at > KEEP) delete cache[k]; });
    store.set('cache', cache);
    rows.sort((a, b) => (a.error ? 1 : 0) - (b.error ? 1 : 0) || a.lastSeen - b.lastSeen);
    const result = { at: Date.now(), by: VERSION, rows, counts, listed: rows.filter((r) => !r.error).length };
    store.set('result', result);
    pushShared(result);
    return result;
  }

  function tellHealthCheck(e) {
    const message = (e && e.message) || String(e);
    if (!/has changed/.test(message)) return;
    document.dispatchEvent(new CustomEvent('upc-loader-error', { detail: JSON.stringify({ file: 'open-ended-patients.user.js', message }) }));
  }

  // ------------------------------------------------------------------ menu count

  const locked = () => Date.now() - store.get('running', 0) < 2 * 60e3;
  async function checkLocked(say) {
    store.set('running', Date.now());
    const beat = (t) => { store.set('running', Date.now()); if (say) say(t); };
    try { return await check(beat); } finally { store.set('running', 0); }
  }
  async function refreshCount() {
    if (!allowed() || !U() || !U().background.ok() || locked()) return;   // visible tab, clinic hours, someone at the PC
    await pullShared(10 * 60e3);   // what another PC has worked out (read at most every 10 minutes)
    const last = store.get('result', null);
    if (last && !U().background.due(last.at, REFRESH_EVERY) && last.by === VERSION) { paintBadge(); return; }
    if (!(await myTurn())) return;   // another PC is working it out now
    try { await checkLocked(); } catch (e) { console.warn('[UPC open-ended patients]', e); tellHealthCheck(e); }
    paintBadge();
  }
  function paintBadge() {
    const a = document.querySelector('a.' + MENU_CLS);
    if (!a) return;
    const r = store.get('result', null);
    const recs = (() => { try { return recalls().cached(); } catch (e) { return {}; } })();
    const n = r ? r.rows.filter((x) => !x.error && !recallFor(x, recs)).length : 0;
    let b = a.querySelector('.upc-ci-badge');
    if (!n) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('span'); b.className = 'upc-ci-badge'; a.appendChild(b); }
    const text = n > 99 ? '99+' : String(n);
    if (b.textContent !== text) b.textContent = text;
    const title = n + ' patient' + (n === 1 ? '' : 's') + ' to recall';
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
    .upc-ci td.upc-ci-act { white-space: nowrap; }
    .upc-ci-when { display: flex; align-items: center; gap: 8px; }
    .upc-ci-when .form-control { max-width: 12em; }
    .upc-ci td.upc-ci-act .upc-actions { margin: 0; justify-content: flex-start; flex-wrap: nowrap; }
  `;
  const state = { unmount: null, running: false, status: '', error: '', busy: null, queue: [], errors: [] };
  let root = null;

  function render() {
    if (!root) return;
    const r = store.get('result', null);
    const base = U().base();
    let h = '<div class="upc-ci"><h1>Open-ended recalls</h1><div class="upc-ci-bar">' +
      '<button type="button" class="btn btn-outline-primary-light" data-a="refresh" ' + (state.running ? 'disabled' : '') + '>' + (state.running ? 'Checking...' : 'Check now') + '</button>' +
      (state.running ? U().ui.run.inline(state.status) : '<span class="text-muted">' + esc(r ? 'Checked at ' + new Date(r.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + ' on ' + label(r.at) + '.' : '') + '</span>') + '</div>';
    if (state.error) h += '<div class="alert alert-danger upc-err">' + esc(state.error) + '</div>';
    state.errors.forEach((m) => { h += '<div class="alert alert-danger upc-err">' + esc(m) + '</div>'; });
    if (r) {
      const recs = (() => { try { return recalls().cached(); } catch (e) { return {}; } })();
      const ok = r.rows.filter((x) => !x.error), bad = r.rows.filter((x) => x.error);
      const todo = ok.filter((x) => !recallFor(x, recs)), done = ok.filter((x) => { const k = recallFor(x, recs); return k && k.kind !== 'skip'; });
      const notRecalled = ok.filter((x) => { const k = recallFor(x, recs); return k && k.kind === 'skip'; });
      const open = todo.filter((x) => x.kind !== 'cancelled'), cancelled = todo.filter((x) => x.kind === 'cancelled');
      const head = '<thead><tr><th>Patient</th><th>Last seen</th><th class="number">Weeks</th><th>Practitioner</th><th>Why</th><th></th></tr></thead>';
      const row = (x) => {
        const rc = recallFor(x, recs);
        const act = rc && rc.kind === 'skip' ? (state.busy === x.id ? U().ui.run.inline('') : state.queue.some((q) => q.id === x.id) ? 'Queued'
            : '<button type="button" class="btn btn-outline-primary-light" data-a="undo" data-id="' + esc(x.id) + '">Undo</button>')
          : rc ? esc(rc.kind === 'sched' ? (rc.at > Date.now() ? 'Scheduled for ' : 'Sent ') + label(rc.at) + ' ' + two(new Date(rc.at).getHours()) + ':' + two(new Date(rc.at).getMinutes()) : 'Check in Halaxy')
          : state.busy === x.id ? U().ui.run.inline('') : state.queue.some((q) => q.id === x.id) ? 'Queued'
          : '<div class="upc-actions"><button type="button" class="btn btn-outline-primary" data-a="recall" data-id="' + esc(x.id) + '">Send recall</button>' +
            '<button type="button" class="btn btn-outline-primary-light" data-a="skip" data-id="' + esc(x.id) + '">Don\'t send</button></div>';
        return '<tr><td><a href="' + esc(base + '/patient/' + x.id) + '" target="_blank" rel="noopener">' + esc(x.name) + '</a></td>' +
          '<td class="upc-ci-date">' + esc(label(x.lastSeen)) + '</td><td class="number">' + Math.floor(Math.round((today() - new Date(x.lastSeen).setHours(0, 0, 0, 0)) / DAY) / 7) + '</td>' +
          '<td>' + esc(x.prac || '') + '</td>' +
          '<td>' + esc(x.kind === 'cancelled' ? x.missed + ' ' + label(x.missedOn) : x.found.join(', ')) + (x.noteId ? ' (<a href="' + esc(base + '/patient/' + x.id + '/clinical/category/note/id/' + x.noteId) + '" target="_blank" rel="noopener">note' + (x.noteDate ? ' ' + esc(label(x.noteDate)) : '') + '</a>)' : '') + '</td>' +
          '<td class="upc-ci-act">' + act + '</td></tr>';
      };
      const card = (title, list) => '<div class="card"><div class="card-header"><h2>' + title + ' (' + list.length + ')</h2></div><div class="card-body p-0">' +
        (list.length ? '<table class="table table-striped table-bordered w-100 m-0">' + head + '<tbody>' + list.map(row).join('') + '</tbody></table>' : '<p class="text-muted m-3">None.</p>') + '</div></div>';
      h += card('Open-ended', open) + card('Cancelled, not rebooked', cancelled);
      if (done.length) h += card('Recalled', done);
      if (notRecalled.length) h += card('Not recalled', notRecalled);
      if (bad.length) h += '<div class="alert alert-danger upc-err">Notes not read for ' + bad.map((x) => esc(x.name) + ' (' + esc(x.error) + ')').join(', ') + '.</div>';
      const c = r.counts || {};
      h += '<p class="text-muted">Last seen ' + AFTER_DAYS() + ' to ' + UP_TO_DAYS() + ' days ago, nothing booked. Left out: ' + (c.recent || 0) + ' seen in the last ' + AFTER_DAYS() + ' days, ' +
        (c.ended || 0) + ' last appointment declined or rescheduled, ' + (c.none || 0) + ' not open-ended, ' + (c.done || 0) + ' finished, ' + (c.finished || 0) + ' cancelled after finishing treatment, ' +
        (c.owing || 0) + ' cancelled and owing money.</p>';
    }
    h += '</div>';
    root.innerHTML = h;
  }

  // ------------------------------------------------------------------ send recall

  // Resolves false (cancelled) or the pop-up's body (confirmed), so fields in it can be read.
  function confirmBox(title, html, yes, check) {
    return new Promise((resolve) => {
      let answered = false;
      const doneWith = (v) => { if (!answered) { answered = true; resolve(v); } };
      const dlg = U().ui.dialog({ title, small: true, onClose: () => doneWith(false) });
      dlg.root.setAttribute('data-upc-ci-confirm', '');
      dlg.body.innerHTML = html + '<div class="alert alert-danger upc-err" data-c-err hidden></div><div class="upc-actions"><button type="button" class="btn btn-outline-primary" data-c="no">Cancel</button><button type="button" class="btn btn-primary" data-c="yes">' + esc(yes) + '</button></div>';
      dlg.body.addEventListener('click', (e) => {
        const b = e.target.closest('[data-c]'); if (!b) return;
        if (b.dataset.c === 'yes' && check) { const m = check(dlg.body); if (m) { const el = dlg.body.querySelector('[data-c-err]'); el.textContent = m; el.hidden = false; return; } }
        doneWith(b.dataset.c === 'yes' ? dlg.body : false); dlg.close();
      });
    });
  }

  async function scheduledEmails(patientId) {
    const headers = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
    if (window.Hk && window.Hk.jwt) headers.Authorization = 'Bearer ' + window.Hk.jwt;
    const j = await U().http.json(location.origin + '/api/v2/practitioner/messaging/history/scheduled/emails?_locale=' + U().pg() + '&linkPaG=' + encodeURIComponent(patientId) + '&dateFrom=&dateTo=&term=&contacts=false', { headers });
    const list = j && j.data && j.data.emailMessages;
    if (!Array.isArray(list)) throw new (U().Error)('Halaxy\'s scheduled emails list has changed.');
    return list.map((m) => { const x = /(\d{2}-[A-Za-z]{3}-\d{4})\s+(\d{1,2}):(\d{2})/.exec(m.sentDateLocal || ''); let at = null; if (x) { const d = U().parseDay(x[1]); if (d !== null) { const t = new Date(d); t.setHours(+x[2], +x[3], 0, 0); at = t.getTime(); } } return { id: String(m.entityId), at }; });
  }

  // The template's practitioner tags filled with the practitioner of the last visit; Halaxy fills the patient's.
  const BLOCKED = /^(Practitioner\b|Appointment\b)/;
  function fill(text, prac) {
    const map = { 'Practitioner First Name': prac.split(' ')[0], 'Practitioner Name': prac, 'Practitioner Surname': prac.split(' ').slice(1).join(' ') };
    const left = [];
    const out = String(text).replace(/(<span class="dynamicterm">)?\[([A-Za-z][A-Za-z /]{1,40})\](<\/span>)?/g, (m, open, tag) => {
      if (Object.prototype.hasOwnProperty.call(map, tag)) return esc(map[tag]);
      if (BLOCKED.test(tag)) left.push('[' + tag + ']');
      return m;
    });
    if (left.length) throw new (U().Error)('The ' + TEMPLATE + ' template has ' + left.join(', ') + ', which Halaxy fills with the signed-in person\'s details. Nothing was sent.');
    return out;
  }

  async function sendRecall(x, due) {
    if (!x.prac) throw new (U().Error)('The practitioner of ' + x.name + '\'s last visit isn\'t known. Nothing was sent.');
    const path = '/email/compose/patient/' + encodeURIComponent(x.id);
    const { doc } = await U().http.popup(path);
    const form = doc.querySelector('form#composeEmailForm');
    if (!form || !form.querySelector('[name="form[body]"]') || !form.querySelector('[name="form[scheduleDetails][scheduleDate]"]')) throw new (U().Error)('The Email patient pop-up has changed. Nothing was sent.');
    if (!U().clean((form.querySelector('[name="form[toEmail]"]') || {}).value)) throw new (U().Error)(x.name + ' has no email address. Nothing was sent.');
    const opt = [...form.querySelectorAll('select[name="form[template]"] option')].find((o) => U().clean(o.textContent).toLowerCase() === TEMPLATE.toLowerCase());
    if (!opt) throw new (U().Error)('There is no "' + TEMPLATE + '" template in Halaxy. Nothing was sent.');
    const page = await U().http.html('/communication/template/list/' + encodeURIComponent(opt.value));
    const bodyEl = page.querySelector('textarea[name="form[contentForFormHandler]"]'), subjEl = page.querySelector('[name="form[subject]"]');
    if (!bodyEl || !U().clean(bodyEl.value || bodyEl.textContent)) throw new (U().Error)('The ' + TEMPLATE + ' template couldn\'t be read (its edit page has changed). Nothing was sent.');
    const subject = U().clean(U().htmlDoc(subjEl ? (subjEl.value || subjEl.textContent) : '').body.textContent);
    if (!subject) throw new (U().Error)('The ' + TEMPLATE + ' template has no subject. Nothing was sent.');
    const body = fill(bodyEl.value || bodyEl.textContent, x.prac);
    fill(subject, x.prac);
    const before = new Set((await scheduledEmails(x.id)).map((m) => m.id));
    const set = { 'form[subject]': subject, 'form[body]': body, 'form[template]': '', 'form[scheduleDetails][scheduleDate]': label(due),
      'form[scheduleDetails][scheduleTime][hour]': String(new Date(due).getHours()), 'form[scheduleDetails][scheduleTime][minute]': String(new Date(due).getMinutes()) };
    const pairs = U().http.serialize(form).map(([k, v]) => [k, k in set ? set[k] : v]);
    Object.keys(set).forEach((k) => { if (!pairs.some(([n]) => n === k)) pairs.push([k, set[k]]); });
    const res = await U().http.postForm(path, pairs);
    if (!res || !['REFRESH', 'OK', 'POPUP'].includes(res.status)) U().http.expectRefresh(res, 'Scheduling the recall');
    // Accepted by Halaxy: from here it is never sent again, even if it can't be seen afterwards.
    const seen = await scheduledEmails(x.id).then((l) => l.some((m) => !before.has(m.id) && m.at === due)).catch(() => false);
    return seen ? 'sched' : 'check';
  }

  // Queue (CH, 18 Nov 2026: scripts save work time, so the next action can be pressed straight away and the queue
  // left to run): each press is confirmed, then waits its turn; one runs at a time, at Halaxy's usual pace.
  const rowOf = (id) => { const r = store.get('result', null); return r && r.rows.find((y) => y.id === id && !y.error); };
  const queued = (id) => state.queue.some((q) => q.id === id) || state.busy === id;
  function enqueue(job) {
    state.queue.push(job);
    render();
    pump();
  }
  async function pump() {
    if (state.busy || !state.queue.length) return;
    const job = state.queue.shift();
    state.busy = job.id;
    render();
    try { await (job.kind === 'skip' ? doSkip(job.x) : job.kind === 'undo' ? doUndo(job.x) : doRecall(job.x, job.due)); }
    finally { state.busy = null; render(); paintBadge(); pump(); }
  }
  window.addEventListener('beforeunload', (e) => { if (state.busy || state.queue.length) { e.preventDefault(); e.returnValue = ''; } });

  async function skip(id) {
    const x = rowOf(id);
    if (!x || queued(id)) return;
    if (!(await confirmBox('Don\'t send a recall?', '<p>Take ' + esc(x.name) + ' off the list for their visit on ' + esc(label(x.lastSeen)) + '?</p>', 'Don\'t send'))) return;
    enqueue({ kind: 'skip', id, x });
  }
  async function undo(id) {
    const x = rowOf(id);
    if (!x || queued(id)) return;
    if (!(await confirmBox('Undo Don\'t send?', '<p>Put ' + esc(x.name) + ' back on the list to recall?</p>', 'Undo'))) return;
    enqueue({ kind: 'undo', id, x });
  }
  async function doUndo(x) {
    try { await recalls().write({ ['p.' + x.id]: 'undo 0 ' + dayOf(x.lastSeen) }); }
    catch (e) { state.errors.push('Not changed: ' + x.name + ' (' + (e.message || e) + ')'); }
  }
  async function doSkip(x) {
    try { await recalls().write({ ['p.' + x.id]: 'skip 0 ' + dayOf(x.lastSeen) }); }
    catch (e) { state.errors.push('Not changed: ' + x.name + ' (' + (e.message || e) + ')'); }
  }

  // Send date chosen in the pop-up (CH, 20 Nov 2026), the next weekday by default; always at 10:30.
  const iso = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()); };
  const at1030 = (isoDay) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3], 10, 30).getTime() : null; };
  async function recall(id) {
    const x = rowOf(id);
    if (!x || queued(id)) return;
    const first = sendTime();
    const body = await confirmBox('Send recall?', '<p>Schedule the ' + esc(TEMPLATE) + ' email to ' + esc(x.name) + ', naming ' + esc(x.prac ? x.prac.split(' ')[0] : 'their practitioner') + '?</p>' +
      '<div class="form-group"><label for="upc-ci-when">Send on</label><div class="upc-ci-when"><input type="date" id="upc-ci-when" class="form-control" value="' + iso(first) + '" min="' + iso(first) + '"><span>at 10:30</span></div></div>', 'Send recall',
      (b) => { const due = at1030(b.querySelector('#upc-ci-when').value); return due === null ? 'Choose a date.' : due < first ? 'Choose ' + label(first) + ' or later.' : ''; });
    if (body) enqueue({ kind: 'recall', id, x, due: at1030(body.querySelector('#upc-ci-when').value) });
  }
  async function doRecall(x, chosen) {
    const due = chosen && chosen > Date.now() + 15 * 60e3 ? chosen : sendTime();
    const sh = recalls();
    const key = 'p.' + x.id;
    try {
      await sh.read(0);
      if (recallFor(x, sh.cached())) return;                       // another PC got there first
      if (!(await sh.claim([key])).includes(key)) throw new (U().Error)('Another PC is sending a recall to ' + x.name + '.');
      let kind;
      try { kind = await sendRecall(x, due); } catch (e) { await sh.write({}).catch(() => {}); throw e; }
      await sh.write({ [key]: kind + ' ' + due + ' ' + dayOf(x.lastSeen) });
      if (kind === 'check') {
        const m = 'Halaxy accepted the recall to ' + x.name + ', but it isn\'t in their scheduled emails. Check their emails in Halaxy.';
        state.errors.push(m);
        document.dispatchEvent(new CustomEvent('upc-loader-error', { detail: JSON.stringify({ file: 'open-ended-patients.user.js', message: m }) }));
      }
    } catch (e) {
      state.errors.push('Recall not sent to ' + x.name + ': ' + (e.message || e));
      tellHealthCheck(e);
    }
  }

  async function run() {
    if (state.running) return;
    state.running = true;
    state.error = '';
    if (!state.busy && !state.queue.length) state.errors = [];
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
    root.addEventListener('click', (e) => {
      if (e.target.closest('[data-a=refresh]')) { U().calendar.forget(); run(); }
      const b = e.target.closest('[data-a=recall]');
      if (b) recall(b.dataset.id);
      const k = e.target.closest('[data-a=skip]');
      if (k) skip(k.dataset.id);
      const u = e.target.closest('[data-a=undo]');
      if (u) undo(u.dataset.id);
    });
    state.unmount = U().ui.mountPage('Open-ended recalls', root, MENU_CLS);
    render();
    const r = store.get('result', null);
    Promise.all([pullShared(0), recalls().read(10 * 60e3).catch(() => {})]).then(() => {
      render(); paintBadge();
      const r2 = store.get('result', null);
      if (!r2 || Date.now() - r2.at > PAGE_FRESH || r2.by !== VERSION) run();
    });
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
    U().ui.ensureMenuItem('Open-ended recalls', (section) => {
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

  window.upcCheckIns = { version: VERSION, wording, check, allowed, sendTime, fill, pullShared };
})();
