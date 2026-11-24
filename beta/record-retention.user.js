// ==UserScript==
// @name         UPC Patients: Record retention (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.1.4
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/record-retention.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/record-retention.user.js
// @description  Patients > Record retention (CH only for now): patients whose records are past the time they are kept, to set to Deleted after confirming.
// @match        https://*.halaxy.com/a/pr/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * Record retention (CH, 20 to 23 Nov 2026; plan in the project's retention-plan.md).
 *
 *  - Rule (CSP, after the NHS Records Management Code of Practice): adults kept for 8 years after the last appointment;
 *    a child (under 18 at the last appointment) until their 25th birthday, or 26th if 17 at the last appointment, when
 *    that is later. Deceased patients: 8 years after death, which Halaxy doesn't hold, so they are listed on their own
 *    for CH to decide.
 *  - Past it, the patient's status is set to Deleted (core's UPC.patient.setStatus, which reads it back): the record
 *    stays in Halaxy and can be found through reports; nothing is erased. Not Archived: CH tested on 23 Nov 2026 that
 *    Archived patients still show in the search boxes.
 *  - One read: Halaxy's patient list (POST /patient/list-data, the same list as Patients > Patient List), in blocks.
 *    Rows give id (linkPaGId), names, status, created, dateOfBirth, lastAppointment and nextAppointment (fields as the
 *    retired Custom Reports read them). Halaxy's last appointment is used as it stands: if it counts cancelled
 *    appointments, records are kept longer, never shorter.
 *  - Cards: Due (past the rule), No date of birth (last appointment over 8 years ago but no date of birth, so whether
 *    the child rule applies can't be told), Deceased (last appointment over 8 years ago), No appointments (record made
 *    over 8 years ago and never seen). Anyone booked ahead, and Deleted and Contact records, are left out.
 *  - Tick, then "Set N to Deleted" (or "Set all N to Deleted" on Due): confirmed once, then sent in batches of 50
 *    (see below). Nothing is changed without that.
 *  - Checked when the page opens (kept on this PC for a day) and with Check now. Nothing runs in the background.
 */
(() => {
  'use strict';
  if (window.__hxRecordRetention) return;
  window.__hxRecordRetention = true;

  const VERSION = '0.1.4';
  const ROUTE = 'upc-record-retention';
  const MENU_CLS = 'upc-rr8-menu';
  const FRESH = 24 * 3600e3;
  const BATCH = 50;   // patients per status change
  const YEARS = 8;
  const U = () => window.UPC;
  const rule = (k, d) => (window.UPC && UPC.settings && UPC.settings.def(k) ? UPC.settings.get(k) : d);
  const PEOPLE = () => rule('recordRetention.people', ['Carl Healy']);
  const allowed = () => U() && U().user && U().user.is(PEOPLE());
  const store = { get: (k, d) => U().storage('upc-retention:').get(k, d), set: (k, v) => U().storage('upc-retention:').set(k, v) };
  const esc = (s) => U().esc(s);
  const label = (ms) => (ms === null || ms === undefined ? '' : U().dayLabel(ms));
  const tellHealthCheck = (e) => {
    if (!/has changed/.test((e && e.message) || '')) return;
    document.dispatchEvent(new CustomEvent('upc-loader-error', { detail: JSON.stringify({ file: 'record-retention.user.js', message: e.message }) }));
  };
  const CSS = `
    .upc-ret .card { margin-bottom: 24px; }
    .upc-ret .card-header h2 { margin: 0; }
    .upc-ret td.upc-ret-date, .upc-ret td.upc-ret-act { white-space: nowrap; }
  `;

  // ------------------------------------------------------------------ dates

  const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  // Halaxy's lists write dates as 25/12/2026, 25-Dec-2026 or 2026-12-25 (with or without a time). Local midnight, in ms.
  function day(s) {
    if (s === null || s === undefined || s === '') return null;
    const t = String(s).trim();
    let m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1]).getTime();
    m = t.match(/^(\d{1,2})[- ]([A-Za-z]{3})[a-z]*[- ,]+(\d{4})/);
    if (m && MON.indexOf(m[2].toLowerCase()) >= 0) return new Date(+m[3], MON.indexOf(m[2].toLowerCase()), +m[1]).getTime();
    m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
    return null;
  }
  // The same day n years on (29 Feb becomes 28 Feb).
  function addYears(ms, n) {
    const d = new Date(ms), y = d.getFullYear() + n;
    const out = new Date(y, d.getMonth(), d.getDate());
    if (out.getMonth() !== d.getMonth()) out.setDate(0);
    return out.getTime();
  }
  function ageOn(dob, ms) {
    const b = new Date(dob), d = new Date(ms);
    let a = d.getFullYear() - b.getFullYear();
    if (d.getMonth() < b.getMonth() || (d.getMonth() === b.getMonth() && d.getDate() < b.getDate())) a -= 1;
    return a;
  }
  // When a record may go: 8 years after the last appointment (or, never seen, after it was made); a child's record
  // not before their 25th birthday (26th if 17 then).
  function keepUntil(p) {
    const from = p.last !== null ? p.last : p.created;
    if (from === null) return null;
    let until = addYears(from, YEARS);
    if (p.dob !== null) {
      const age = ageOn(p.dob, from);
      if (age < 18) until = Math.max(until, addYears(p.dob, age === 17 ? 26 : 25));
    }
    return until;
  }

  // ------------------------------------------------------------------ the check

  const nameOf = (r) => [r.givenName, r.preferredName && r.preferredName !== r.givenName ? '(' + r.preferredName + ')' : '', r.surname].filter(Boolean).join(' ') || ('Patient ' + (r.patientNum || r.id));
  const SKIP = /^(deleted|contact|lead)$/i;

  async function check(say) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const now = today.getTime();
    const cut = addYears(now, -YEARS);
    const rows = await U().patient.listAll(say);
    if (rows.length && !rows.some((r) => 'dateOfBirth' in r)) throw new (U().Error)('The patient list has changed (date of birth not found), so nothing was checked.');
    const out = [];
    rows.forEach((r) => {
      const status = String(r.status || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      if (r.id === null || r.id === undefined || SKIP.test(status) || day(r.nextAppointment) !== null) return;
      const p = { id: String(r.id), name: nameOf(r), num: r.patientNum || '', status, dob: day(r.dateOfBirth), last: day(r.lastAppointment), created: day(r.created) };
      p.until = keepUntil(p);
      if (/^deceased$/i.test(status)) { if (p.last !== null ? p.last < cut : p.created !== null && p.created < cut) out.push(Object.assign(p, { group: 'deceased' })); return; }
      if (p.last === null) { if (p.until !== null && p.until < now) out.push(Object.assign(p, { group: 'never' })); return; }
      if (p.dob === null) { if (p.last < cut) out.push(Object.assign(p, { group: 'nodob' })); return; }
      if (p.until < now) out.push(Object.assign(p, { group: 'due' }));
    });
    out.sort((a, b) => (a.last || a.created || 0) - (b.last || b.created || 0));
    const result = { at: Date.now(), by: VERSION, cut, read: rows.length, rows: out };
    store.set('result', result);
    const a = document.querySelector('a.' + MENU_CLS), due = out.filter((x) => x.group === 'due');
    if (a && U().todo) U().todo.publish('record-retention', { title: 'Record retention', cls: MENU_CLS, href: a.getAttribute('href'), count: due.length, rows: due.slice(0, 3).map((x) => x.name + ', last seen ' + label(x.last)) });
    return result;
  }

  // ------------------------------------------------------------------ set to Deleted (in batches)
  //
  // Patients go to Halaxy in batches of 50 through the Case Load report's Update patient status (core
  // UPC.patient.setStatusMany; CH, 23 Nov 2026: 875 at once would otherwise be about 2,600 requests). The report gives
  // each patient's practitioner pairings (read once). A patient not in it is changed on their own Edit page. When the
  // queue is empty, the Deleted patients are read (Introduction Source report; the patient list leaves them out), and
  // each patient sent shows Deleted or Not changed.

  const state = { unmount: null, running: false, status: '', error: '', errors: [], failed: 0 };
  const done = new Map();   // patient id -> 'ok' | error text
  const jobs = [];
  const sent = new Set();   // sent to Halaxy, waiting to be checked
  let busy = null, checking = false, caseMap = null, root = null;
  const queuedOf = (id) => (busy && busy.has(id) ? 'busy' : sent.has(id) ? 'busy' : jobs.some((j) => j.id === id) ? 'queued' : null);
  const pending = () => jobs.length + (busy ? busy.size : 0) + sent.size;
  const fail = (id, why) => { done.set(id, why); state.failed += 1; };

  async function pump() {
    if (busy || checking) return;
    if (!jobs.length) { if (sent.size) verify(); return; }
    const batch = jobs.splice(0, BATCH);
    busy = new Set(batch.map((j) => j.id));
    render();
    try {
      if (!caseMap) caseMap = await U().patient.caseLoad();
      const inReport = batch.filter((j) => caseMap.has(j.id)), own = batch.filter((j) => !caseMap.has(j.id));
      if (inReport.length) {
        try {
          await U().patient.setStatusMany(inReport.flatMap((j) => caseMap.get(j.id)), 'deleted');
          inReport.forEach((j) => sent.add(j.id));
        } catch (e) {
          inReport.forEach((j) => fail(j.id, e.message || String(e)));
          state.errors.push('Not changed: ' + inReport.length + ' patient' + (inReport.length === 1 ? '' : 's') + ' (' + (e.message || e) + ')');
          tellHealthCheck(e);
        }
      }
      for (const j of own) {
        try { await U().patient.setStatus(j.id, j.status, 'deleted'); done.set(j.id, 'ok'); } catch (e) {
          if (e && e.statusChanged) done.set(j.id, 'ok'); else fail(j.id, e.message || String(e));
          state.errors.push('Not changed: ' + j.name + ' (' + (e.message || e) + ')');
          tellHealthCheck(e);
        }
      }
    } catch (e) {
      batch.forEach((j) => fail(j.id, e.message || String(e)));
      state.errors.push('Not changed: ' + batch.length + ' patient' + (batch.length === 1 ? '' : 's') + ' (' + (e.message || e) + ')');
      tellHealthCheck(e);
    } finally { busy = null; render(); pump(); }
  }

  async function verify() {
    checking = true;
    render();
    try {
      // Halaxy's patient list leaves Deleted patients out (live, 23 Nov 2026), so they are looked for in the one list
      // that shows them: the Introduction Source report for Deleted patients (core UPC.patient.deletedIds).
      const gone = await U().patient.deletedIds();
      let missed = 0;
      sent.forEach((id) => { if (gone.has(id)) done.set(id, 'ok'); else { fail(id, 'Halaxy still shows the old status'); missed += 1; } });
      if (missed) state.errors.push('Not changed: ' + missed + ' patient' + (missed === 1 ? '' : 's') + ' (Halaxy still shows the old status). Check now lists them again.');
    } catch (e) {
      sent.forEach((id) => fail(id, 'not checked'));
      state.errors.push('Could not check the changes: ' + (e.message || e) + ' Check now shows where things stand.');
      tellHealthCheck(e);
    }
    sent.clear();
    checking = false;
    render();
    pump();
  }
  window.addEventListener('beforeunload', (e) => { if (pending()) { e.preventDefault(); e.returnValue = ''; } });

  function confirmBox(title, html, yes) {
    return new Promise((resolve) => {
      let answered = false;
      const end = (v) => { if (!answered) { answered = true; resolve(v); } };
      const dlg = U().ui.dialog({ title, small: true, onClose: () => end(false) });
      dlg.root.setAttribute('data-upc-ret-confirm', '');
      dlg.body.innerHTML = html + '<div class="upc-actions"><button type="button" class="btn btn-outline-primary" data-c="no">Cancel</button><button type="button" class="btn btn-primary" data-c="yes">' + esc(window.UPC && UPC.ui.titleCase ? UPC.ui.titleCase(yes) : yes) + '</button></div>';
      dlg.body.addEventListener('click', (e) => { const b = e.target.closest('[data-c]'); if (!b) return; end(b.dataset.c === 'yes'); dlg.close(); });
    });
  }

  const open = (x) => !queuedOf(x.id) && done.get(x.id) !== 'ok';
  async function deleteRows(listId, all) {
    const r = store.get('result', null);
    const ids = all ? null : U().ui.list.picked(listId);
    const xs = (r ? r.rows : []).filter((y) => y.group === listId && (all || ids.includes(y.id)) && open(y));
    if (!xs.length) return;
    const names = xs.slice(0, 10).map((y) => y.name).join(', ') + (xs.length > 10 ? ' and ' + (xs.length - 10) + ' more' : '');
    const n = xs.length + ' patient' + (xs.length === 1 ? '' : 's');
    if (!(await confirmBox('Set to Deleted?', '<p>Set ' + n + ' to Deleted?</p><p class="text-muted">' + esc(names) + '</p>', 'Set ' + xs.length + ' to Deleted'))) return;
    xs.forEach((y) => jobs.push({ id: y.id, name: y.name, status: y.status }));
    U().ui.list.unpick(listId, xs.map((y) => y.id));
    render();
    pump();
  }

  // ------------------------------------------------------------------ the page

  const GROUPS = [
    ['due', 'Due'],
    ['nodob', 'No date of birth'],
    ['deceased', 'Deceased'],
    ['never', 'No appointments'],
  ];

  function table(listId, rows) {
    const base = U().base();
    const never = listId === 'never';
    return '<table class="table table-striped table-bordered w-100 m-0" data-upc-list="' + listId + '" data-upc-pick><thead><tr><th>Patient</th><th>Status</th><th>Date of Birth</th>' +
      '<th>' + (never ? 'Record made' : 'Last appointment') + '</th><th>Kept Until</th><th data-upc-nosort></th></tr></thead><tbody>' +
      rows.map((x) => {
        const q = queuedOf(x.id), d = done.get(x.id);
        const act = q === 'busy' ? U().ui.run.inline('') : q === 'queued' ? 'Queued' : d === 'ok' ? '<span class="upc-ok">Deleted</span>' : d ? '<span class="upc-err">Not changed</span>' : '';
        const when = never ? x.created : x.last;
        return '<tr data-upc-id="' + esc(x.id) + '"' + (q || d === 'ok' ? ' data-upc-nopick' : '') + '><td><a href="' + esc(base + '/patient/' + x.id) + '" target="_blank" rel="noopener">' + esc(x.name) + '</a></td>' +
          '<td>' + esc(x.status.charAt(0).toUpperCase() + x.status.slice(1)) + '</td><td class="upc-ret-date">' + esc(label(x.dob)) + '</td><td class="upc-ret-date">' + esc(label(when)) + '</td>' +
          '<td class="upc-ret-date">' + esc(x.group === 'due' || x.group === 'never' ? label(x.until) : '') + '</td><td class="upc-ret-act">' + act + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  // The tool row: "Set 3 to Deleted" for the ticked rows; on Due, "Set all 875 to Deleted" when none are ticked.
  function bulk(listId, rows) {
    const ids = U().ui.list.picked(listId);
    const n = rows.filter((x) => ids.includes(x.id)).length;
    const left = rows.filter(open).length;
    if (!n && !(listId === 'due' && left)) return '';
    return '<span data-upc-bulk-for="' + listId + '">' + (n ? '<span class="text-muted">' + n + ' ticked</span><button type="button" class="btn btn-primary" data-a="bulk" data-list="' + listId + '">Set ' + n + ' to Deleted</button>'
      : '<button type="button" class="btn btn-primary" data-a="all" data-list="' + listId + '">Set all ' + left + ' to Deleted</button>') + '</span>';
  }

  function render() {
    if (!root) return;
    const r = store.get('result', null);
    const btn = '<button type="button" class="btn btn-outline-primary" data-a="refresh"' + (state.running ? ' disabled' : '') + '>' + (state.running ? 'Checking...' : 'Check Now') + '</button>';
    const bq = U().ui.batch('record-retention', checking ? 'Checking the changes' : 'Setting to Deleted', 'set to Deleted', pending(), state.failed);
    let h = '<div class="upc-ret">' + U().ui.page.bar('Record retention', btn, bq || (state.running ? U().ui.run.inline(state.status) : U().ui.page.checked(r && r.at)));
    if (state.error) h += '<div class="alert alert-danger upc-err">' + esc(state.error) + '</div>';
    state.errors.forEach((m) => { h += '<div class="alert alert-danger upc-err">' + esc(m) + '</div>'; });
    if (r) {
      GROUPS.forEach(([g, title]) => {
        const rows = r.rows.filter((x) => x.group === g);
        if (g !== 'due' && !rows.length) return;
        h += U().ui.page.card(title, rows.length, '', bulk(g, rows) + table(g, rows));
      });
      h += '<p class="text-muted">Last appointment before ' + esc(label(r.cut)) + '; children\'s records until their 25th or 26th birthday. Booked patients left out.</p>';
    }
    h += '</div>';
    root.innerHTML = h;
    U().ui.list.enhance(root, { onPick: render });
  }

  async function run() {
    if (state.running) return;
    state.running = true;
    state.error = '';
    state.status = 'Reading the patient list...';
    if (!pending()) { state.errors = []; state.failed = 0; done.clear(); caseMap = null; }
    render();
    try { await check((t) => { state.status = t; render(); }); } catch (e) { state.error = 'Could not check: ' + (e.message || e); tellHealthCheck(e); }
    state.running = false;
    render();
  }

  function mount() {
    if (state.unmount || !allowed()) return;
    U().ui.nativeStyles();
    root = document.createElement('div');
    root.className = 'upc-native';
    root.setAttribute('data-upc-record-retention', '');
    root.addEventListener('click', (e) => {
      if (e.target.closest('[data-a=refresh]')) run();
      const k = e.target.closest('[data-a=bulk], [data-a=all]');
      if (k) deleteRows(k.dataset.list, k.dataset.a === 'all');
    });
    state.unmount = U().ui.mountPage('Record retention', root, MENU_CLS);
    render();
    const r = store.get('result', null);
    if (!r || Date.now() - r.at > FRESH || r.by !== VERSION) run();
  }
  function unmount() {
    if (!state.unmount) return;
    state.unmount();
    state.unmount = null;
    root = null;
  }
  const route = () => (location.hash === '#' + ROUTE ? mount() : unmount());

  function start() {
    if (!U()) { console.error('[UPC record retention] needs the core library'); return; }
    U().user.whenAllowed(PEOPLE(), () => {
      if (!document.getElementById('upc-retention-css')) { const st = document.createElement('style'); st.id = 'upc-retention-css'; st.textContent = CSS; document.head.appendChild(st); }
      U().ui.ensureMenuItem('Record retention', (section) => {
        const list = section && [...section.querySelectorAll('a.mainmenu-sublink')].find((a) => /^patient list$/i.test(U().clean(a.textContent)));
        return (list ? list.getAttribute('href').split('#')[0] : U().base() + '/patient/') + '#' + ROUTE;
      }, MENU_CLS, /^patients?$/i);
      window.addEventListener('hashchange', route);
      route();
    });
  }

  window.upcRecordRetention = { version: VERSION, check, keepUntil, day, allowed };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
