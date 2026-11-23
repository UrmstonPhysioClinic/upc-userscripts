// ==UserScript==
// @name         UPC Patients: Cards on file (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.1.1
// @upc-was      stored-cards.user.js
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/cards-on-file.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/cards-on-file.user.js
// @description  Patients > Cards on file (CH only for now): cards on file that are no longer needed (nothing booked or owed, last appointment a while ago), to remove after confirming.
// @match        https://*.halaxy.com/a/pr/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * Cards on file (CH, 23 Nov 2026; first called Stored cards: option 1, "once nothing more can be owed"; a page a person works through, not
 * automatic, until it has proved itself).
 *
 *  - A card is due to come off when its patient has nothing booked, no unpaid invoice of their own, no unpaid insurer
 *    invoice (a remittance can still show an excess to charge), and their last appointment was at least
 *    storedCards.afterDays ago (Clinic settings, 28 by default).
 *  - Reads: Halaxy's Credit Card Expiry report (one request; core UPC.reports.storedCards), the patient list (core
 *    UPC.patient.listAll: next and last appointment, patient number) and the Unpaid Invoices report (one request).
 *    A patient's own invoices are matched by the report's Payer ID (the patient number); an insurer invoice by the
 *    patient's name in its payer ("Bupa Healthcare / (Patient Name)"), first and last name, so a near match keeps the
 *    card rather than losing it. Patients not in the patient list are left out.
 *  - Tick, then "Remove N cards": confirmed once, then queued (Queue, don't block): the patient's Funding tab is read,
 *    the card with that number removed through Halaxy's Delete credit card pop-up, and the tab read again to check.
 *  - Checked when the page opens (kept on this PC for a day) and with Check now. Nothing runs in the background.
 */
(() => {
  'use strict';
  if (window.__hxStoredCards) return;
  window.__hxStoredCards = true;

  const VERSION = '0.1.1';
  const ROUTE = 'upc-cards-on-file';
  const MENU_CLS = 'upc-sc-menu';
  const DAY = 864e5;
  const FRESH = 24 * 3600e3;
  const U = () => window.UPC;
  const rule = (k, d) => (window.UPC && UPC.settings && UPC.settings.def(k) ? UPC.settings.get(k) : d);
  const PEOPLE = () => rule('storedCards.people', ['Carl Healy']);
  const AFTER = () => rule('storedCards.afterDays', 28);
  const allowed = () => U() && U().user && U().user.is(PEOPLE());
  const store = { get: (k, d) => U().storage('upc-cards:').get(k, d), set: (k, v) => U().storage('upc-cards:').set(k, v) };
  const esc = (s) => U().esc(s);
  const label = (ms) => (ms === null || ms === undefined ? '' : U().dayLabel(ms));
  const tellHealthCheck = (e) => {
    if (!/has changed/.test((e && e.message) || '')) return;
    document.dispatchEvent(new CustomEvent('upc-loader-error', { detail: JSON.stringify({ file: 'cards-on-file.user.js', message: e.message }) }));
  };
  const CSS = `
    .upc-sc .card { margin-bottom: 24px; }
    .upc-sc .card-header h2 { margin: 0; }
    .upc-sc td.upc-sc-date, .upc-sc td.upc-sc-act { white-space: nowrap; }
  `;

  // ------------------------------------------------------------------ dates and names

  const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
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
  // "Mrs Liz (Lizzie) Frost" -> "liz frost": no title, no preferred name, first and last word.
  const TITLES = /^(mr|mrs|ms|miss|mx|dr|master|prof|rev)\.?$/i;
  function nameKey(s) {
    const w = String(s || '').replace(/\([^)]*\)/g, ' ').replace(/[^A-Za-z' -]/g, ' ').toLowerCase().split(/\s+/).filter((x) => x && !TITLES.test(x));
    return w.length ? w[0] + ' ' + w[w.length - 1] : '';
  }

  // ------------------------------------------------------------------ the check

  async function check(say) {
    const now = Date.now();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const after = AFTER();
    const cut = today.getTime() - after * DAY;
    say('Reading the Credit Card Expiry report...');
    const cards = await U().reports.storedCards();
    const rows = await U().patient.listAll(say);
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    say('Reading the Unpaid Invoices report...');
    const lines = await U().reports.unpaidLines('01-Jan-2000');
    const owedByNum = new Map(), owedByName = new Map();
    lines.forEach((l) => {
      if (!l.invoiceId || !(l.balance > 0)) return;
      const add = (map, k) => { if (!k) return; if (!map.has(k)) map.set(k, new Set()); map.get(k).add(l.invoice); };
      add(owedByNum, String(l.payerId || '').trim().toLowerCase());
      const inBrackets = (String(l.payer).match(/\(([^)]+)\)\s*$/) || [])[1];
      if (inBrackets) add(owedByName, nameKey(inBrackets));
    });
    const due = [];
    let kept = 0, unknown = 0;
    cards.forEach((c, i) => {
      const p = byId.get(c.patientId);
      if (!p) { unknown += 1; return; }
      const last = day(p.lastAppointment), next = day(p.nextAppointment);
      const own = owedByNum.get(String(p.patientNum || '').trim().toLowerCase());
      const ins = owedByName.get(nameKey(c.patient)) || owedByName.get(nameKey([p.givenName, p.surname].join(' ')));
      if (next !== null || own || ins || last === null || last > cut) { kept += 1; return; }
      due.push({ key: c.patientId + '-' + c.last4 + '-' + i, patientId: c.patientId, patient: c.patient, status: c.status, last4: c.last4, type: c.type, expiry: c.expiry, expiryText: c.expiryText, last });
    });
    due.sort((a, b) => a.last - b.last);
    const result = { at: now, by: VERSION, after, cut, total: cards.length, kept, unknown, rows: due };
    store.set('result', result);
    const a = document.querySelector('a.' + MENU_CLS);
    if (a && U().todo) U().todo.publish('stored-cards', { title: 'Cards on file', cls: MENU_CLS, href: a.getAttribute('href'), count: due.length, rows: due.slice(0, 3).map((x) => x.patient + ', ' + x.type + ' ending ' + x.last4) });
    return result;
  }

  // ------------------------------------------------------------------ remove (queued)

  const state = { unmount: null, running: false, status: '', error: '', errors: [] };
  const done = new Map();   // row key -> 'ok' | error text
  const jobs = [];
  let jobBusy = null, root = null;
  const queuedOf = (k) => (jobBusy === k ? 'busy' : jobs.some((j) => j.key === k) ? 'queued' : null);
  async function pump() {
    if (jobBusy !== null || !jobs.length) return;
    const j = jobs.shift();
    jobBusy = j.key;
    render();
    try {
      const on = (await U().patient.cards(j.patientId)).filter((c) => c.last4 === j.last4);
      if (!on.length) throw new (U().Error)('the card is no longer on the Funding tab');
      if (on.length > 1) throw new (U().Error)('there are ' + on.length + ' cards ending ' + j.last4 + ' on the Funding tab');
      await U().patient.deleteCard(j.patientId, on[0].id);
      done.set(j.key, 'ok');
    } catch (e) {
      done.set(j.key, e.message || String(e));
      state.errors.push('Not changed: ' + j.patient + ', card ending ' + j.last4 + ' (' + (e.message || e) + ')');
      tellHealthCheck(e);
    } finally { jobBusy = null; render(); pump(); }
  }
  window.addEventListener('beforeunload', (e) => { if (jobBusy !== null || jobs.length) { e.preventDefault(); e.returnValue = ''; } });

  function confirmBox(title, html, yes) {
    return new Promise((resolve) => {
      let answered = false;
      const end = (v) => { if (!answered) { answered = true; resolve(v); } };
      const dlg = U().ui.dialog({ title, small: true, onClose: () => end(false) });
      dlg.root.setAttribute('data-upc-sc-confirm', '');
      dlg.body.innerHTML = html + '<div class="upc-actions"><button type="button" class="btn btn-outline-primary" data-c="no">Cancel</button><button type="button" class="btn btn-primary" data-c="yes">' + esc(yes) + '</button></div>';
      dlg.body.addEventListener('click', (e) => { const b = e.target.closest('[data-c]'); if (!b) return; end(b.dataset.c === 'yes'); dlg.close(); });
    });
  }

  async function removeTicked() {
    const r = store.get('result', null);
    const keys = U().ui.list.picked('due');
    const xs = (r ? r.rows : []).filter((y) => keys.includes(y.key) && !queuedOf(y.key) && done.get(y.key) !== 'ok');
    if (!xs.length) return;
    const n = xs.length + ' card' + (xs.length === 1 ? '' : 's');
    const people = new Set(xs.map((y) => y.patientId)).size;
    const who = xs.slice(0, 10).map((y) => y.patient + ' (' + y.last4 + ')').join(', ') + (xs.length > 10 ? ' and ' + (xs.length - 10) + ' more' : '');
    if (!(await confirmBox('Remove cards?', '<p>Remove ' + n + ' from ' + people + ' patient' + (people === 1 ? '' : 's') + '?</p><p class="text-muted">' + esc(who) + '</p>', 'Remove ' + xs.length))) return;
    xs.forEach((y) => jobs.push({ key: y.key, patientId: y.patientId, patient: y.patient, last4: y.last4 }));
    U().ui.list.unpick('due', xs.map((y) => y.key));
    render();
    pump();
  }

  // ------------------------------------------------------------------ the page

  function table(rows) {
    const base = U().base();
    return '<table class="table table-striped table-bordered w-100 m-0" data-upc-list="due" data-upc-pick><thead><tr><th>Patient</th><th>Status</th><th>Card</th><th>Expires</th><th>Last appointment</th><th data-upc-nosort></th></tr></thead><tbody>' +
      rows.map((x) => {
        const q = queuedOf(x.key), d = done.get(x.key);
        const act = q === 'busy' ? U().ui.run.inline('') : q === 'queued' ? 'Queued' : d === 'ok' ? '<span class="upc-ok">Removed</span>' : d ? '<span class="upc-err">Not changed</span>' : '';
        return '<tr data-upc-id="' + esc(x.key) + '"' + (q || d === 'ok' ? ' data-upc-nopick' : '') + '><td><a href="' + esc(base + '/patient/' + x.patientId + '/funding') + '" target="_blank" rel="noopener">' + esc(x.patient) + '</a></td>' +
          '<td>' + esc(x.status) + '</td><td>' + esc(x.type + ' ending ' + x.last4) + '</td><td class="upc-sc-date" data-sort="' + esc(x.expiry || 0) + '">' + esc(x.expiryText) + '</td>' +
          '<td class="upc-sc-date">' + esc(label(x.last)) + '</td><td class="upc-sc-act">' + act + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function bulk(rows) {
    const keys = U().ui.list.picked('due');
    const n = rows.filter((x) => keys.includes(x.key)).length;
    if (!n) return '';
    return '<span data-upc-bulk-for="due"><span class="text-muted">' + n + ' ticked</span><button type="button" class="btn btn-primary" data-a="bulk">Remove ' + n + '</button></span>';
  }

  function render() {
    if (!root) return;
    const r = store.get('result', null);
    const btn = '<button type="button" class="btn btn-outline-primary" data-a="refresh"' + (state.running ? ' disabled' : '') + '>' + (state.running ? 'Checking...' : 'Check now') + '</button>';
    const bq = U().ui.batch('stored-cards', 'Removing cards', 'removed', jobs.length + (jobBusy !== null ? 1 : 0), state.errors.length);
    let h = '<div class="upc-sc">' + U().ui.page.bar('Cards on file', btn, bq || (state.running ? U().ui.run.inline(state.status) : U().ui.page.checked(r && r.at)));
    if (state.error) h += '<div class="alert alert-danger upc-err">' + esc(state.error) + '</div>';
    state.errors.forEach((m) => { h += '<div class="alert alert-danger upc-err">' + esc(m) + '</div>'; });
    if (r) {
      h += U().ui.page.card('No longer needed', r.rows.length, '', bulk(r.rows) + table(r.rows));
      h += '<p class="text-muted">Nothing booked or owed, last appointment before ' + esc(label(r.cut)) + '. ' + r.kept + ' of ' + r.total + ' cards kept' +
        (r.unknown ? '; ' + r.unknown + ' for patients not in the patient list left out' : '') + '.</p>';
    }
    h += '</div>';
    root.innerHTML = h;
    U().ui.list.enhance(root, { onPick: render });
  }

  async function run() {
    if (state.running) return;
    state.running = true;
    state.error = '';
    state.status = 'Reading the Credit Card Expiry report...';
    if (!jobs.length && jobBusy === null) { state.errors = []; done.clear(); }
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
    root.setAttribute('data-upc-stored-cards', '');
    root.addEventListener('click', (e) => {
      if (e.target.closest('[data-a=refresh]')) run();
      if (e.target.closest('[data-a=bulk]')) removeTicked();
    });
    state.unmount = U().ui.mountPage('Cards on file', root, MENU_CLS);
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
    if (!U() || !U().reports.storedCards || !U().patient.listAll) { console.error('[UPC cards on file] needs the core library'); return; }
    U().user.whenAllowed(PEOPLE(), () => {
      if (!document.getElementById('upc-cards-css')) { const st = document.createElement('style'); st.id = 'upc-cards-css'; st.textContent = CSS; document.head.appendChild(st); }
      U().ui.ensureMenuItem('Cards on file', (section) => {
        const list = section && [...section.querySelectorAll('a.mainmenu-sublink')].find((a) => /^patient list$/i.test(U().clean(a.textContent)));
        return (list ? list.getAttribute('href').split('#')[0] : U().base() + '/patient/') + '#' + ROUTE;
      }, MENU_CLS, /^patients?$/i);
      window.addEventListener('hashchange', route);
      route();
    });
  }

  window.upcStoredCards = { version: VERSION, check, nameKey, allowed };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
