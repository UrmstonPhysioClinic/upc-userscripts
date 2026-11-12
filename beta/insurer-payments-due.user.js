// ==UserScript==
// @name         UPC Billing: Insurer payments due (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.1.5
// @upc-was      funder-chaser.user.js
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/insurer-payments-due.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/insurer-payments-due.user.js
// @description  Finances > Insurer payments due (Carl only for now): insurer invoices marked Issued that still aren't paid 30 days after their invoice date, with a count on the menu. Reads only.
// @match        https://*.halaxy.com/a/pr/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * Insurer payments due (Carl, 10 and 11 Nov 2026; named by Carl; first built as Funder chaser, and the file keeps that name).
 *
 *  - One request: Halaxy's Unpaid Invoices report (core's UPC.reports.unpaidLines), which lists every unpaid invoice,
 *    Active or Issued, with its payer, funder, date and balance.
 *  - A funder invoice is one billed to the insurer itself (the payer is the funder), as Ready to bill tells them apart.
 *  - Overdue: marked Issued (submitted), a balance still to pay, and the invoice date (set to the billing day by Invoice
 *    Funder) 30 days ago or more. A remittance attached doesn't matter: until the payment is recorded it still counts
 *    (Carl, 11 Nov 2026: "an invoice with a Remittance but no payment should also flag").
 *  - Also shown, greyed: funder invoices still Active (not marked Issued) after 30 days, which may never have been
 *    submitted. Not counted on the menu.
 *  - Just the list and the count for now (Carl): no tasks.
 */
(() => {
  'use strict';
  if (window.__hxFunderChaser) return;
  window.__hxFunderChaser = true;

  const VERSION = '0.1.5';
  const ROUTE = 'upc-funder-chaser';
  const MENU_CLS = 'upc-fc-menu';
  const ALLOWED = ['Carl Healy'];
  const DAY = 86400e3;
  const OVERDUE_DAYS = 30;             // Carl, 11 Nov 2026: 30 days for every insurer to start with
  const LOOK_BACK_MONTHS = 18;         // how far back the report is read
  const REFRESH_EVERY = 12 * 3600e3;   // menu count: twice a day (it reads 18 months of the Unpaid Invoices report)
  const PAGE_FRESH = 10 * 60e3;
  const KEY = 'upc-fc:';

  const U = () => window.UPC;
  const esc = (s) => U().esc(s);
  const store = { get: (k, d) => U().storage(KEY).get(k, d), set: (k, v) => U().storage(KEY).set(k, v), del: (k) => U().storage(KEY).del(k) };   // core's per-PC storage

  const fmt = (c) => U().money.fmt(c);
  const label = (ms) => U().dayLabel(ms);
  const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const insurer = (funder) => !!funder && !/self/i.test(funder);
  const payerIsFunder = (payer, funder) => { const p = String(payer).toLowerCase(), f = String(funder).toLowerCase(); return !!p && !!f && (p.includes(f) || f.includes(p)); };

  // Who's signed in: the core library's check (Halaxy can fill the name in late, so it keeps looking for 20 seconds).
  const allowed = () => !!U() && U().user.is(ALLOWED);
  const whenAllowed = (fn) => U().user.whenAllowed(ALLOWED, fn);

  // ------------------------------------------------------------------ the check

  async function check(say) {
    const tell = say || (() => {});
    tell('Reading Halaxy\'s Unpaid Invoices report...');
    const from = new Date(today());
    from.setMonth(from.getMonth() - LOOK_BACK_MONTHS);
    const lines = await U().reports.unpaidLines(label(from.getTime()));
    const invoices = new Map();
    lines.forEach((l) => {
      if (!l.invoiceId || !insurer(l.funder) || !payerIsFunder(l.payer, l.funder)) return;
      let inv = invoices.get(l.invoiceId);
      if (!inv) {
        const when = U().parseDay(l.date);
        inv = { id: String(l.invoiceId), number: l.invoice, when, funder: l.funder, payer: l.payer, status: l.invoiceStatus, balance: l.balance, amount: 0, fees: 0 };
        invoices.set(l.invoiceId, inv);
      }
      inv.amount += l.amount || 0;
      inv.fees += 1;
    });
    const cutoff = today() - OVERDUE_DAYS * DAY;
    const rows = [...invoices.values()].filter((i) => i.when !== null && i.when <= cutoff && (i.balance === null || i.balance > 0))
      .map((i) => Object.assign(i, { days: Math.floor((today() - i.when) / DAY), issued: /issued/i.test(i.status) }))
      .sort((a, b) => a.when - b.when);
    const result = { at: Date.now(), by: VERSION, rows, overdue: rows.filter((r) => r.issued).length };
    store.set('result', result);
    return result;
  }

  // ------------------------------------------------------------------ menu count

  async function refreshCount() {
    if (!allowed() || !U() || !U().background.ok()) return;   // visible tab, clinic hours, someone at the PC, Halaxy not busy
    const last = store.get('result', null);
    if (last && !U().background.due(last.at, REFRESH_EVERY) && last.by === VERSION) return;
    if (locked()) return;
    try { await checkLocked(); } catch (e) { console.warn('[UPC insurer payments due]', e); tellHealthCheck(e); }
    paintBadge();
  }
  const locked = () => Date.now() - store.get('running', 0) < 5 * 60e3;
  async function checkLocked(say) {
    store.set('running', Date.now());
    try { return await check(say); } finally { store.set('running', 0); }
  }
  function tellHealthCheck(e) {
    const message = (e && e.message) || String(e);
    if (!/has changed/.test(message)) return;
    document.dispatchEvent(new CustomEvent('upc-loader-error', { detail: JSON.stringify({ file: 'insurer-payments-due.user.js', message }) }));
  }
  function paintBadge() {
    const a = document.querySelector('a.' + MENU_CLS);
    if (!a) return;
    const r = store.get('result', null);
    let b = a.querySelector('.upc-fc-badge');
    const n = r ? r.overdue : 0;
    if (!n) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('span'); b.className = 'upc-fc-badge'; a.appendChild(b); }
    const text = n > 99 ? '99+' : String(n);
    if (b.textContent !== text) b.textContent = text;
    const title = n + ' insurer invoice' + (n === 1 ? '' : 's') + ' unpaid after ' + OVERDUE_DAYS + ' days';
    if (b.title !== title) b.title = title;
  }

  // ------------------------------------------------------------------ page

  const CSS = `
    .upc-fc-badge { display: inline-block; min-width: 18px; margin-left: 6px; padding: 0 5px; border-radius: 9px; font-size: .75em; line-height: 18px;
      text-align: center; font-weight: 600; color: #fff; background: var(--vs-notification-badge-bg-color, #ec6b65); vertical-align: middle; }
    .upc-fc { max-width: 1100px; }
    .upc-fc h1 { margin: 0 0 16px; }
    .upc-fc .card { margin-bottom: 24px; }
    .upc-fc .card-header h2 { margin: 0; }
    .upc-fc .upc-fc-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-bottom: 12px; }
    .upc-fc .upc-fc-bar .btn { margin: 0; }
    .upc-fc tr.upc-off td, .upc-fc tr.upc-off a { color: var(--vs-viewData-label-color, #6c757d); }
    .upc-fc td.upc-fc-date { white-space: nowrap; }
  `;
  const state = { unmount: null, running: false, status: '', error: '' };
  let root = null;

  function table(rows, off) {
    const base = U().base();
    return '<table class="table ' + (off ? '' : 'table-striped ') + 'table-bordered w-100 m-0"><thead><tr><th>Funder</th><th>Invoice</th><th>Invoice date</th>' +
      '<th class="number">Days</th><th class="number">Fees</th><th class="number">Amount</th><th class="number">Still to pay</th></tr></thead><tbody>' +
      rows.map((r) => '<tr class="' + (off ? 'upc-off' : '') + '"><td>' + esc(r.funder) + '</td><td><a href="' + esc(base + '/invoice/' + r.id) + '" target="_blank" rel="noopener">' + esc(r.number) + '</a></td>' +
        '<td class="upc-fc-date">' + esc(label(r.when)) + '</td><td class="number">' + r.days + '</td><td class="number">' + r.fees + '</td>' +
        '<td class="number">' + fmt(r.amount) + '</td><td class="number">' + (r.balance === null ? '' : fmt(r.balance)) + '</td></tr>').join('') +
      '</tbody></table>';
  }

  function render() {
    if (!root) return;
    const r = store.get('result', null);
    let h = '<div class="upc-fc"><h1>Insurer payments due</h1><div class="upc-fc-bar">' +
      '<button type="button" class="btn btn-outline-primary-light" data-a="refresh" ' + (state.running ? 'disabled' : '') + '>' + (state.running ? 'Checking...' : 'Check again') + '</button>' +
      '<span class="text-muted">' + esc(state.running ? state.status : r ? 'Checked at ' + new Date(r.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + ' on ' + label(r.at) + '.' : '') + '</span></div>';
    if (state.error) h += '<p class="upc-err">' + esc(state.error) + '</p>';
    if (r) {
      const due = r.rows.filter((x) => x.issued), active = r.rows.filter((x) => !x.issued);
      const total = due.reduce((t, x) => t + (x.balance === null ? x.amount : x.balance), 0);
      h += '<div class="card"><div class="card-header"><h2>Unpaid after ' + OVERDUE_DAYS + ' days (' + due.length + (due.length ? ', ' + fmt(total) : '') + ')</h2></div><div class="card-body p-0">' +
        (due.length ? table(due, false) : '<p class="text-muted m-3">No insurer invoice marked Issued is unpaid after ' + OVERDUE_DAYS + ' days.</p>') + '</div></div>';
      if (active.length) {
        h += '<div class="card"><div class="card-header"><h2>Not marked Issued after ' + OVERDUE_DAYS + ' days (' + active.length + ')</h2></div><div class="card-body p-0">' +
          '<p class="text-muted m-3">Still Active, so perhaps never submitted. Not counted on the menu.</p>' + table(active, true) + '</div></div>';
      }
      h += '<p class="text-muted">Insurer invoices (billed to the funder itself) with something still to pay, ' + OVERDUE_DAYS + ' days or more after their invoice date. ' +
        'A remittance attached doesn\'t take an invoice off the list: only the payment, once recorded, does.</p>';
    }
    h += '<div class="text-muted upc-version">Insurer payments due ' + VERSION + '</div></div>';
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
        while (locked() && Date.now() - t0 < 5 * 60e3) await U().sleep(1000);
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
    root.setAttribute('data-upc-funder-chaser', '');
    root.addEventListener('click', (e) => { if (e.target.closest('[data-a=refresh]')) run(); });
    state.unmount = U().ui.mountPage('Insurer payments due', root, MENU_CLS);
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
    if (!U()) { console.error('[UPC insurer payments due] needs the core library'); return; }
    if (!allowed()) return;
    if (!document.getElementById('upc-fc-css')) { const st = document.createElement('style'); st.id = 'upc-fc-css'; st.textContent = CSS; document.head.appendChild(st); }
    // Under Finances, opening over Halaxy's Invoices page (as Ready to bill does).
    U().ui.ensureMenuItem('Insurer payments due', (section) => {
      const inv = section && [...section.querySelectorAll('a.mainmenu-sublink')].find((a) => /^invoices$/i.test(U().clean(a.textContent)));
      return (inv ? inv.getAttribute('href').split('#')[0] : U().base() + '/invoice/') + '#' + ROUTE;
    }, MENU_CLS, /^finances?$/i);
    new MutationObserver(paintBadge).observe(document.getElementById('mainMenu') || document.body, { childList: true, subtree: true });
    window.addEventListener('storage', (e) => { if (e.key === KEY + 'result') { paintBadge(); render(); } });
    document.addEventListener('visibilitychange', refreshCount);
    window.addEventListener('hashchange', route);
    paintBadge();
    route();
    setTimeout(refreshCount, 4000);
    setInterval(refreshCount, 10 * 60e3);
  }
  const begin = () => { if (U()) whenAllowed(start); else start(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', begin, { once: true });
  else begin();

  window.upcFunderChaser = { version: VERSION, check, allowed };
})();
