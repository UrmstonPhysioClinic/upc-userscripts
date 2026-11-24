// ==UserScript==
// @name         UPC Billing: Old balances (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.2.4
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/old-balances.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/old-balances.user.js
// @description  Finances > Old balances (CH only for now): unpaid invoices over 6 months old, and over 6 years to write off.
// @match        https://*.halaxy.com/a/pr/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * Old balances (CH, 20 Nov 2026: "clear all old outstanding accounts from more than 6 years ago (written off)" and
 * "highlight all outstanding accounts from > 6 months ago to go through and clear up").
 *
 *  - One request: Halaxy's Unpaid Invoices report (core's UPC.reports.unpaidLines) from 1 Jan 2000, Active and Issued
 *    invoices with a balance. One row per invoice (its balance is on its last line), aged by invoice date.
 *  - Cards: "Over 6 years" and "6 months to 6 years". Each row: invoice, date, payer, funder, balance, and Write off:
 *    confirmed, queued (Queue, don't block), sets the invoice's status to Write-off in its settings (UPC.invoice.setStatus,
 *    which reads it back). Chasing is done by hand from the invoice link.
 *  - Checked when the page opens (kept on this PC for an hour) and with Check now. Nothing runs in the background.
 *  - 0.2.0 (UI/UX audit, 23 Nov 2026): built on core's page kit (title bar, search, sorting, Show 50 more), with tick
 *    boxes: "Write off 12 invoices" for the ticked ones, confirmed once, each then queued as a single Write off.
 */
(() => {
  'use strict';
  if (window.__hxOldBalances) return;
  window.__hxOldBalances = true;

  const VERSION = '0.2.4';
  const ROUTE = 'upc-old-balances';
  const MENU_CLS = 'upc-ob-menu';
  const DAY = 864e5;
  const FRESH = 3600e3;
  const U = () => window.UPC;
  const rule = (k, d) => (window.UPC && UPC.settings && UPC.settings.def(k) ? UPC.settings.get(k) : d);
  const PEOPLE = () => rule('oldBalances.people', ['Carl Healy']);
  const allowed = () => U() && U().user && U().user.is(PEOPLE());
  const store = { get: (k, d) => U().storage('upc-ob:').get(k, d), set: (k, v) => U().storage('upc-ob:').set(k, v) };
  const esc = (s) => U().esc(s);
  const label = (ms) => U().dayLabel(ms);
  const fmt = (c) => U().money.fmt(c);
  const tellHealthCheck = (e) => {
    if (!/has changed/.test((e && e.message) || '')) return;
    document.dispatchEvent(new CustomEvent('upc-loader-error', { detail: JSON.stringify({ file: 'old-balances.user.js', message: e.message }) }));
  };
  const CSS = `
    .upc-ob .card { margin-bottom: 24px; }
    .upc-ob .card-header h2 { margin: 0; }
    .upc-ob td.upc-ob-date, .upc-ob td.upc-ob-act { white-space: nowrap; }
    .upc-ob td.upc-ob-act .btn { margin: 0; }
  `;

  const state = { unmount: null, running: false, status: '', error: '', errors: [] };
  const done = new Map();   // invoice id -> 'ok' | error text
  let root = null;

  // ------------------------------------------------------------------ the check

  async function check() {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const sixMonths = new Date(today); sixMonths.setMonth(sixMonths.getMonth() - 6);
    const sixYears = new Date(today); sixYears.setFullYear(sixYears.getFullYear() - 6);
    const lines = await U().reports.unpaidLines('01-Jan-2000');
    const byInv = new Map();
    lines.forEach((l) => {
      if (!l.invoiceId) return;
      const x = byInv.get(l.invoiceId) || { id: l.invoiceId, number: l.invoice, date: U().parseDay(l.date), payer: l.payer, funder: l.funder, status: l.invoiceStatus, balance: null };
      if (l.balance !== null) x.balance = l.balance;   // the balance is on the invoice's last line
      byInv.set(l.invoiceId, x);
    });
    const rows = [...byInv.values()].filter((x) => x.date !== null && x.balance > 0 && x.date < sixMonths.getTime())
      .map((x) => Object.assign(x, { old: x.date < sixYears.getTime() })).sort((a, b) => a.date - b.date);
    const result = { at: Date.now(), by: VERSION, rows, since: sixMonths.getTime(), cut: sixYears.getTime() };
    store.set('result', result);
    const a = document.querySelector('a.' + MENU_CLS), old6 = rows.filter((x) => x.old);
    if (a && U().todo) U().todo.publish('old-balances', { title: 'Old balances', cls: MENU_CLS, href: a.getAttribute('href'), count: old6.length, rows: old6.slice(0, 3).map((x) => x.number + ', ' + x.payer + ', ' + fmt(x.balance)) });
    return result;
  }

  // ------------------------------------------------------------------ write off (queued)

  const jobs = [];
  let jobBusy = null;
  const queuedOf = (id) => (jobBusy === id ? 'busy' : jobs.some((j) => j.id === id) ? 'queued' : null);
  async function pump() {
    if (jobBusy !== null || !jobs.length) return;
    const j = jobs.shift();
    jobBusy = j.id;
    render();
    try { await U().invoice.setStatus(j.id, 'write-off'); done.set(j.id, 'ok'); }
    catch (e) { done.set(j.id, e.message || String(e)); state.errors.push('Not written off: ' + j.number + ' (' + (e.message || e) + ')'); tellHealthCheck(e); }
    finally { jobBusy = null; render(); pump(); }
  }
  window.addEventListener('beforeunload', (e) => { if (jobBusy !== null || jobs.length) { e.preventDefault(); e.returnValue = ''; } });

  function confirmBox(title, html, yes) {
    return new Promise((resolve) => {
      let answered = false;
      const end = (v) => { if (!answered) { answered = true; resolve(v); } };
      const dlg = U().ui.dialog({ title, small: true, onClose: () => end(false) });
      dlg.root.setAttribute('data-upc-ob-confirm', '');
      dlg.body.innerHTML = html + '<div class="upc-actions"><button type="button" class="btn btn-outline-primary" data-c="no">Cancel</button><button type="button" class="btn btn-primary" data-c="yes">' + esc(window.UPC && UPC.ui.titleCase ? UPC.ui.titleCase(yes) : yes) + '</button></div>';
      dlg.body.addEventListener('click', (e) => { const b = e.target.closest('[data-c]'); if (!b) return; end(b.dataset.c === 'yes'); dlg.close(); });
    });
  }

  async function writeOff(id) {
    const r = store.get('result', null);
    const x = r && r.rows.find((y) => y.id === id);
    if (!x || queuedOf(id) || done.get(id) === 'ok') return;
    if (!(await confirmBox('Write off?', '<p>Write off ' + esc(x.number) + ' (' + esc(fmt(x.balance)) + ', ' + esc(x.payer) + ', ' + esc(label(x.date)) + ')? Its status is set to Write-off.</p>', 'Write off'))) return;
    jobs.push({ id, number: x.number });
    U().ui.list.unpick('old', [id]); U().ui.list.unpick('mid', [id]);
    render();
    pump();
  }

  async function writeOffTicked(listId) {
    const r = store.get('result', null);
    const ids = U().ui.list.picked(listId);
    const xs = (r ? r.rows : []).filter((y) => ids.includes(String(y.id)) && !queuedOf(y.id) && done.get(y.id) !== 'ok');
    if (!xs.length) return;
    const total = xs.reduce((t, y) => t + y.balance, 0);
    const nums = xs.slice(0, 10).map((y) => y.number).join(', ') + (xs.length > 10 ? ' and ' + (xs.length - 10) + ' more' : '');
    if (!(await confirmBox('Write off?', '<p>Write off ' + xs.length + ' invoice' + (xs.length === 1 ? '' : 's') + ', ' + esc(fmt(total)) + ' in all? ' + (xs.length === 1 ? 'Its' : 'Their') + ' status is set to Write-off.</p><p class="text-muted">' + esc(nums) + '</p>', 'Write off ' + xs.length))) return;
    xs.forEach((y) => jobs.push({ id: y.id, number: y.number }));
    U().ui.list.unpick(listId, xs.map((y) => String(y.id)));
    render();
    pump();
  }

  // ------------------------------------------------------------------ the page

  function table(listId, rows) {
    const base = U().base();
    return '<table class="table table-striped table-bordered w-100 m-0" data-upc-list="' + listId + '" data-upc-pick><thead><tr><th>Invoice</th><th>Date</th><th>Payer</th><th>Funder</th><th class="number">Balance</th><th data-upc-nosort></th></tr></thead><tbody>' +
      rows.map((x) => {
        const q = queuedOf(x.id), d = done.get(x.id);
        const act = q === 'busy' ? U().ui.run.inline('') : q === 'queued' ? 'Queued' : d === 'ok' ? '<span class="upc-ok">Written off</span>'
          : '<button type="button" class="btn btn-outline-primary-light" data-a="off" data-id="' + esc(x.id) + '">Write Off</button>';
        return '<tr data-upc-id="' + esc(x.id) + '"' + (q || d === 'ok' ? ' data-upc-nopick' : '') + '><td><a href="' + esc(base + '/invoice/' + x.id) + '" target="_blank" rel="noopener">' + esc(x.number) + '</a></td><td class="upc-ob-date">' + esc(label(x.date)) + '</td>' +
          '<td>' + esc(x.payer) + '</td><td>' + esc(x.funder) + '</td><td class="number">' + esc(fmt(x.balance)) + '</td><td class="upc-ob-act">' + act + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  // The bulk action for a list's ticked rows, shown in its tool row.
  function bulk(listId, rows) {
    const ids = U().ui.list.picked(listId);
    const xs = rows.filter((x) => ids.includes(String(x.id)));
    if (!xs.length) return '';
    return '<span data-upc-bulk-for="' + listId + '"><span class="text-muted">' + xs.length + ' ticked, ' + esc(fmt(xs.reduce((t, x) => t + x.balance, 0))) + '</span>' +
      '<button type="button" class="btn btn-primary" data-a="bulk" data-list="' + listId + '">Write Off ' + xs.length + '</button></span>';
  }

  function render() {
    if (!root) return;
    const r = store.get('result', null);
    const btn = '<button type="button" class="btn btn-outline-primary" data-a="refresh"' + (state.running ? ' disabled' : '') + '>' + (state.running ? 'Checking...' : 'Check Now') + '</button>';
    const bq = U().ui.batch('old-balances', 'Writing off', 'written off', jobs.length + (jobBusy !== null ? 1 : 0), state.errors.length);
    let h = '<div class="upc-ob">' + U().ui.page.bar('Old balances', btn, bq || (state.running ? U().ui.run.inline(state.status) : U().ui.page.checked(r && r.at)));
    if (state.error) h += '<div class="alert alert-danger upc-err">' + esc(state.error) + '</div>';
    state.errors.forEach((m) => { h += '<div class="alert alert-danger upc-err">' + esc(m) + '</div>'; });
    if (r) {
      const card = (listId, title, rows) => {
        const total = rows.reduce((t, x) => t + (done.get(x.id) === 'ok' ? 0 : x.balance), 0);
        return U().ui.page.card(title, rows.length, rows.length ? fmt(total) : '', bulk(listId, rows) + table(listId, rows));
      };
      h += card('old', 'Over 6 years', r.rows.filter((x) => x.old)) + card('mid', '6 months to 6 years', r.rows.filter((x) => !x.old));
      h += '<p class="text-muted">Active and Issued invoices dated before ' + esc(label(r.since)) + ' with a balance.</p>';
    }
    h += '</div>';
    root.innerHTML = h;
    U().ui.list.enhance(root, { onPick: render });
  }

  async function run() {
    if (state.running) return;
    state.running = true;
    state.error = '';
    state.status = 'Reading the Unpaid Invoices report...';
    if (!jobs.length && jobBusy === null) { state.errors = []; done.clear(); }
    render();
    try { await check(); } catch (e) { state.error = 'Could not check: ' + (e.message || e); tellHealthCheck(e); }
    state.running = false;
    render();
  }

  function mount() {
    if (state.unmount || !allowed()) return;
    U().ui.nativeStyles();
    root = document.createElement('div');
    root.className = 'upc-native';
    root.setAttribute('data-upc-old-balances', '');
    root.addEventListener('click', (e) => {
      if (e.target.closest('[data-a=refresh]')) run();
      const b = e.target.closest('[data-a=off]');
      if (b) writeOff(b.dataset.id);
      const k = e.target.closest('[data-a=bulk]');
      if (k) writeOffTicked(k.dataset.list);
    });
    state.unmount = U().ui.mountPage('Old balances', root, MENU_CLS);
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
    if (!U()) { console.error('[UPC old balances] needs the core library'); return; }
    U().user.whenAllowed(PEOPLE(), () => {
      if (!document.getElementById('upc-ob-css')) { const st = document.createElement('style'); st.id = 'upc-ob-css'; st.textContent = CSS; document.head.appendChild(st); }
      U().ui.ensureMenuItem('Old balances', (section) => {
        const inv = section && [...section.querySelectorAll('a.mainmenu-sublink')].find((a) => /^invoices$/i.test(U().clean(a.textContent)));
        return (inv ? inv.getAttribute('href').split('#')[0] : U().base() + '/invoice/') + '#' + ROUTE;
      }, MENU_CLS, /^finances?$/i);
      window.addEventListener('hashchange', route);
      route();
    });
  }

  window.upcOldBalances = { version: VERSION, check, allowed };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
