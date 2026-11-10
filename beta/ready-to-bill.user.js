// ==UserScript==
// @name         Halaxy ready to bill (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.1.0
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/ready-to-bill.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/ready-to-bill.user.js
// @description  Finances > Ready to bill (Carl and Wendy only): insurer patients whose unbilled fees are due to be billed, with the reason and an Invoice Funder button, and a count on the menu. Read-only.
// @match        https://*.halaxy.com/a/pr/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * Ready to bill (agreed with Carl, 6 to 7 and 10 November 2026; spec in the Claude project).
 *
 *  - Unbilled fees: Halaxy's Unpaid Invoices report (one request) gives every unpaid fee line with its
 *    payer, funder and invoice status. A fee is unbilled when it is on a patient's invoice (not the
 *    insurer's), has an insurer funder, the invoice is Active (Issued means billed), and Halaxy doesn't
 *    list the invoice as Pending (billed, waiting for the insurer). Fees older than 6 months are ignored.
 *  - Per patient (only those with unbilled fees): the earliest and latest unbilled invoices (authorisation
 *    "3rd of 5", claim, patient), cached per invoice; and one calendar request for everyone (last attended,
 *    next booked).
 *  - Due when: the authorisation is used up; no attended appointment for 14 days and nothing booked;
 *    the last working day of the month; or fees 3 months old or more.
 *  - Excess hold: on a new claim (its first authorised appointment is among the unbilled fees) hold until
 *    the fees cover the excess. This version doesn't read the intake form's excess yet, so it uses the
 *    spec's fallback: hold until there are at least 2 fees. A used-up authorisation or old fees override.
 *  - Shown only to Carl and Wendy, only inside Halaxy. The count on the menu is refreshed at most every
 *    2 hours, in the visible tab only, shared across tabs, never while Halaxy has asked us to pause.
 *  - Reads only. Billing is Invoice Funder's job: the button opens the invoice with Invoice Funder.
 */
(() => {
  'use strict';
  if (window.__hxReadyToBill) return;
  window.__hxReadyToBill = true;

  const VERSION = '0.1.0';
  const ROUTE = 'upc-ready-to-bill';
  const MENU_CLS = 'upc-rtb-menu';
  const ALLOWED = ['Carl Healy', 'Wendy Pritchard'];   // Carl, 7 Nov 2026: only the two of them
  const DAY = 86400e3;
  const WINDOW_MONTHS = 6, OLD_MONTHS = 3, QUIET_DAYS = 14, MIN_FEES_NO_EXCESS = 2;
  const REFRESH_EVERY = 2 * 3600e3;    // menu count
  const PAGE_FRESH = 10 * 60e3;        // the page re-checks when its results are older than this
  const KEY = 'upc-rtb:';
  const NOT_ATTENDED = /did not attend|did-not-attend|cancel/i;

  const U = () => window.UPC;
  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(KEY + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
  };
  const fmt = (c) => U().money.fmt(c);
  const label = (ms) => U().dayLabel(ms);
  const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const addMonths = (ms, n) => { const d = new Date(ms); const r = new Date(d.getFullYear(), d.getMonth() + n, 1); r.setDate(Math.min(d.getDate(), new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate())); return r.getTime(); };
  // The last weekday of the month (bank holidays aren't known, so a bank holiday Friday still counts).
  const isLastWorkingDay = (ms) => {
    const d = new Date(ms);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    while (last.getDay() === 0 || last.getDay() === 6) last.setDate(last.getDate() - 1);
    return last.getDate() === d.getDate();
  };

  // ------------------------------------------------------------------ who may see it

  function userName() {
    const h = window.HkUser || {};
    const c = h.CalendarDefault || {};
    const named = String(h.pracName || c.pracName || '').trim();
    if (named) return named;
    // Fallback: the signed-in name in Halaxy's top bar.
    const el = [...document.querySelectorAll('header *, nav *, .navbar *, #top *')]
      .find((e) => !e.children.length && ALLOWED.some((n) => n.toLowerCase() === e.textContent.trim().toLowerCase()));
    return el ? el.textContent.trim() : '';
  }
  const allowed = () => ALLOWED.some((n) => n.toLowerCase() === userName().toLowerCase());

  // ------------------------------------------------------------------ the check

  const insurer = (funder) => !!funder && !/self/i.test(funder);
  const payerIsFunder = (payer, funder) => { const p = String(payer).toLowerCase(), f = String(funder).toLowerCase(); return !!p && !!f && (p.includes(f) || f.includes(p)); };

  // Invoice facts that don't change (patient, claim, authorisation position), cached for a week.
  async function invoiceFacts(id, say) {
    const cache = store.get('inv', {});
    const hit = cache[id];
    if (hit && Date.now() - hit.at < 7 * DAY) return hit;
    say('Reading invoice ' + id + '...');
    const inv = await U().invoice.fetch(id);
    const facts = { at: Date.now(), number: inv.number, patientId: inv.patientId, claimId: inv.claimId, funderName: inv.funderName,
      referral: inv.referral, billable: !!inv.billFunderHref };
    cache[id] = facts;
    const keys = Object.keys(cache);
    if (keys.length > 400) keys.sort((a, b) => cache[a].at - cache[b].at).slice(0, keys.length - 400).forEach((k) => delete cache[k]);
    store.set('inv', cache);
    return facts;
  }

  async function calendar(fromMs, toMs, say) {
    say('Reading the calendar...');
    const pracs = await U().http.json('/lookup/practitioner?clinic=&include_id=&type=');
    const qs = new URLSearchParams({ start: Math.floor(fromMs / 1000), end: Math.floor(toMs / 1000) });
    (Array.isArray(pracs) ? pracs : []).forEach((p, i) => qs.append('practitioners[' + i + '][id]', p.id));
    const cal = await U().http.json('/calendar/json?' + qs.toString());
    return ((cal && cal.payload && cal.payload.events) || []).filter((e) => e.type === 'appointment');
  }

  async function check(say) {
    say = say || (() => {});
    const now = Date.now(), day0 = today();
    const cutoff = addMonths(day0, -WINDOW_MONTHS);
    say('Reading Halaxy\'s Unpaid Invoices report...');
    const lines = await U().reports.unpaidLines(label(cutoff));
    say('Reading which invoices are already billed...');
    const pending = await U().reports.pendingInvoiceIds();

    // Unbilled insurer fees on patients' invoices.
    const invoices = new Map();
    lines.forEach((l) => {
      if (!l.invoiceId || !insurer(l.funder) || payerIsFunder(l.payer, l.funder)) return;
      if (/issued/i.test(l.invoiceStatus) || pending.has(String(l.invoiceId))) return;
      const when = U().parseDay(l.date);
      if (when !== null && when < cutoff) return;
      let inv = invoices.get(l.invoiceId);
      if (!inv) { inv = { id: String(l.invoiceId), number: l.invoice, when, payer: l.payer, payerId: l.payerId, funder: l.funder, lines: [] }; invoices.set(l.invoiceId, inv); }
      inv.lines.push({ fee: l.fee, status: l.apptStatus, amount: l.amount || 0 });
    });

    // One group per patient and funder.
    const groups = new Map();
    for (const inv of invoices.values()) {
      const k = (inv.payerId || inv.payer) + '|' + inv.funder;
      if (!groups.has(k)) groups.set(k, { payer: inv.payer, funder: inv.funder, invoices: [] });
      groups.get(k).invoices.push(inv);
    }

    const list = [];
    for (const g of groups.values()) {
      g.invoices.sort((a, b) => (a.when || 0) - (b.when || 0));
      const first = g.invoices[0], last = g.invoices[g.invoices.length - 1];
      const fFirst = await invoiceFacts(first.id, say);
      const fLast = last === first ? fFirst : await invoiceFacts(last.id, say);
      g.patientId = fLast.patientId || fFirst.patientId;
      g.lastInvoice = last;
      g.referral = fLast.referral;
      g.newClaim = !!(fFirst.referral && fFirst.referral.position === 1);
      g.allLines = g.invoices.flatMap((i) => i.lines.map((l) => Object.assign({ when: i.when }, l)));
      g.billable = g.allLines.filter((l) => !NOT_ATTENDED.test(l.status) && l.amount > 0);
      g.total = g.billable.reduce((s, l) => s + l.amount, 0);
      g.oldest = first.when;
      list.push(g);
    }

    // Last attended and next booked, for everyone at once.
    const events = list.length ? await calendar(day0 - 30 * DAY, day0 + 120 * DAY, say) : [];
    list.forEach((g) => {
      const mine = events.filter((e) => g.patientId && String(e.linkPaGId) === String(g.patientId));
      const startMs = (e) => (typeof e.start === 'number' ? e.start * 1000 : Date.parse(e.start));
      const attended = mine.filter((e) => startMs(e) < now && !e.appointmentStatus).map(startMs);
      const booked = mine.filter((e) => startMs(e) >= now && !/cancel|reject|declin/i.test(e.appointmentStatus || '')).map(startMs);
      g.lastSeen = attended.length ? Math.max(...attended) : null;
      g.nextBooked = booked.length ? Math.min(...booked) : null;
    });

    // Decide.
    const monthEnd = isLastWorkingDay(day0);
    list.forEach((g) => {
      const reasons = [];
      const ref = g.referral;
      const authUsed = !!(ref && ref.limit && ref.position >= ref.limit);
      if (authUsed) reasons.push('Authorisation used up (' + ref.position + ' of ' + ref.limit + ')');
      const quiet = !g.nextBooked && (!g.lastSeen || g.lastSeen < now - QUIET_DAYS * DAY);
      if (quiet) reasons.push('No visit for ' + QUIET_DAYS + ' days' + (g.lastSeen ? ' (last ' + label(g.lastSeen) + ')' : '') + ', nothing booked');
      const old = g.oldest !== null && g.oldest <= addMonths(day0, -OLD_MONTHS);
      if (old) reasons.push('Fees from ' + label(g.oldest) + ', over ' + OLD_MONTHS + ' months old');
      if (monthEnd) reasons.push('Last working day of the month');
      const held = g.newClaim && g.billable.length < MIN_FEES_NO_EXCESS && !authUsed && !old;
      g.state = !g.billable.length ? 'check' : held ? 'held' : reasons.length ? 'due' : 'later';
      g.reasons = reasons;
      g.note = g.state === 'check' ? 'Only cancelled, did-not-attend or £0 fees: check whether to bill them'
        : g.state === 'held' ? 'Held for the excess: first invoice on a new claim, ' + g.billable.length + ' fee so far (excess not read yet, so waiting for ' + MIN_FEES_NO_EXCESS + ' fees)'
          : g.state === 'later' ? 'Not due yet' + (g.nextBooked ? ': next booked ' + label(g.nextBooked) : g.lastSeen ? ': last seen ' + label(g.lastSeen) : '') : '';
    });
    const order = { due: 0, check: 1, held: 2, later: 3 };
    list.sort((a, b) => order[a.state] - order[b.state] || (a.oldest || 0) - (b.oldest || 0));
    const result = {
      at: Date.now(), by: VERSION, monthEnd,
      due: list.filter((g) => g.state === 'due').length,
      rows: list.map((g) => ({
        payer: g.payer, funder: g.funder, patientId: g.patientId, state: g.state, reasons: g.reasons, note: g.note,
        fees: g.billable.length, total: g.total, oldest: g.oldest, lastInvoiceId: g.lastInvoice.id,
        invoices: g.invoices.map((i) => ({ id: i.id, number: i.number, when: i.when, total: i.lines.reduce((s, l) => s + l.amount, 0) })),
      })),
    };
    store.set('result', result);
    return result;
  }

  // ------------------------------------------------------------------ menu count

  // Shared by all tabs: one refresh at a time, at most every 2 hours, in the visible tab only.
  async function refreshCount() {
    if (!allowed() || document.visibilityState !== 'visible' || !U()) return;
    if (U().http.pausedFor() > 0) return;
    const last = store.get('result', null);
    if (last && Date.now() - last.at < REFRESH_EVERY) return;
    if (locked()) return;
    try { await checkLocked(); } catch (e) { console.warn('[UPC ready to bill]', e); store.set('lastError', { at: Date.now(), message: e.message || String(e) }); tellHealthCheck(e); }
    paintBadge();
  }

  // One check at a time across tabs (the page and the menu count share it).
  const locked = () => Date.now() - store.get('running', 0) < 5 * 60e3;
  async function checkLocked(say) {
    store.set('running', Date.now());
    try { return await check(say); } finally { store.set('running', 0); }
  }

  // A Halaxy change (report columns moved) is shown by the health check, as the menu count fails quietly.
  function tellHealthCheck(e) {
    const message = (e && e.message) || String(e);
    if (!/has changed/.test(message)) return;   // not a passing network problem
    document.dispatchEvent(new CustomEvent('upc-loader-error', { detail: JSON.stringify({ file: 'ready-to-bill.user.js', message }) }));
  }

  function paintBadge() {
    const a = document.querySelector('a.' + MENU_CLS);
    if (!a) return;
    const r = store.get('result', null);
    let b = a.querySelector('.upc-rtb-badge');
    const n = r ? r.due : 0;
    if (!n) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('span'); b.className = 'upc-rtb-badge'; a.appendChild(b); }
    const text = n > 99 ? '99+' : String(n);
    if (b.textContent !== text) b.textContent = text;   // only on change: the menu is watched for redraws
    const title = n + ' patient' + (n === 1 ? '' : 's') + ' ready to bill';
    if (b.title !== title) b.title = title;
  }

  // ------------------------------------------------------------------ page

  const CSS = `
    .upc-rtb-badge { display: inline-block; min-width: 18px; margin-left: 6px; padding: 0 5px; border-radius: 9px; font-size: .75em; line-height: 18px;
      text-align: center; font-weight: 600; color: #fff; background: var(--vs-notification-badge-bg-color, #ec6b65); vertical-align: middle; }
    .upc-rtb { max-width: 1300px; }
    .upc-rtb h1 { margin: 0 0 16px; }
    .upc-rtb .card { margin-bottom: 24px; }
    .upc-rtb .card-header { display: flex; align-items: center; justify-content: space-between; }
    .upc-rtb .card-header h2 { margin: 0; }
    .upc-rtb .upc-rtb-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-bottom: 12px; }
    .upc-rtb .upc-rtb-bar .btn { margin: 0; }
    .upc-rtb ul.upc-rtb-why { margin: 0; padding-left: 16px; }
    .upc-rtb tr.upc-off td, .upc-rtb tr.upc-off a { color: var(--vs-viewData-label-color, #6c757d); }
    .upc-rtb .upc-rtb-invs a { margin-right: 8px; white-space: nowrap; }
  `;

  const state = { unmount: null, running: false, status: '', error: '' };
  let root = null;

  function rowHtml(r) {
    const base = U().base();
    const invs = r.invoices.map((i) => '<a href="' + esc(base + '/invoice/' + i.id) + '" target="_blank" rel="noopener">' + esc(i.number) + '</a>').join('');
    const who = r.patientId ? '<a href="' + esc(base + '/patient/' + r.patientId) + '" target="_blank" rel="noopener">' + esc(r.payer) + '</a>' : esc(r.payer);
    const why = r.state === 'due' ? '<ul class="upc-rtb-why">' + r.reasons.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>' : esc(r.note);
    const act = r.state === 'due' ? '<a class="btn btn-outline-primary-light" href="' + esc(base + '/invoice/' + r.lastInvoiceId + '#upc-invoice-funder') + '">Invoice Funder</a>' : '';
    return '<tr class="' + (r.state === 'due' ? '' : 'upc-off') + '"><td>' + who + '</td><td>' + esc(r.funder) + '</td>' +
      '<td class="number">' + r.fees + ' fee' + (r.fees === 1 ? '' : 's') + '<br>' + fmt(r.total) + '</td><td>' + (r.oldest ? esc(label(r.oldest)) : '') + '</td>' +
      '<td>' + why + '</td><td class="upc-rtb-invs">' + invs + '</td><td>' + act + '</td></tr>';
  }

  function render() {
    if (!root) return;
    const r = store.get('result', null);
    const head = '<thead><tr><th>Patient</th><th>Funder</th><th class="number">Unbilled</th><th>Oldest fee</th><th>Why</th><th>Invoices</th><th></th></tr></thead>';
    let h = '<div class="upc-rtb"><h1>Ready to bill</h1><div class="upc-rtb-bar">' +
      '<button type="button" class="btn btn-outline-primary-light" data-a="refresh" ' + (state.running ? 'disabled' : '') + '>' + (state.running ? 'Checking...' : 'Check again') + '</button>' +
      '<span class="text-muted">' + esc(state.running ? state.status : r ? 'Checked at ' + new Date(r.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + ' on ' + label(r.at) + '.' : '') + '</span></div>';
    if (state.error) h += '<p class="upc-err">' + esc(state.error) + '</p>';
    if (r) {
      const due = r.rows.filter((x) => x.state === 'due'), rest = r.rows.filter((x) => x.state !== 'due');
      h += '<div class="card"><div class="card-header"><h2>Due to bill (' + due.length + ')</h2></div><div class="card-body p-0">' +
        (due.length ? '<table class="table table-striped table-bordered w-100 m-0">' + head + '<tbody>' + due.map(rowHtml).join('') + '</tbody></table>'
          : '<p class="text-muted m-3">Nothing is due to bill.</p>') + '</div></div>';
      if (rest.length) {
        h += '<div class="card"><div class="card-header"><h2>Not due yet (' + rest.length + ')</h2></div><div class="card-body p-0">' +
          '<table class="table table-bordered w-100 m-0">' + head + '<tbody>' + rest.map(rowHtml).join('') + '</tbody></table></div></div>';
      }
      h += '<p class="text-muted">Unbilled means an insurer patient\'s fee on an Active invoice that Halaxy doesn\'t show as Pending. ' +
        'Fees older than ' + WINDOW_MONTHS + ' months are left out. The excess on new claims isn\'t read from the intake form yet, so new claims wait for ' + MIN_FEES_NO_EXCESS + ' fees.</p>';
    }
    h += '<div class="text-muted upc-version">Ready to bill ' + VERSION + '</div></div>';
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
        // Another tab is checking: wait for its result rather than asking Halaxy twice.
        state.status = 'Checking in another tab...';
        render();
        const t0 = Date.now();
        while (locked() && Date.now() - t0 < 5 * 60e3) await U().sleep(1000);
        if (!store.get('result', null) || Date.now() - store.get('result', null).at > PAGE_FRESH) await checkLocked((t) => { state.status = t; render(); });
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
    if (!document.getElementById('upc-rtb-css')) { const st = document.createElement('style'); st.id = 'upc-rtb-css'; st.textContent = CSS; document.head.appendChild(st); }
    U().ui.nativeStyles();
    root = document.createElement('div');
    root.className = 'upc-native';
    root.setAttribute('data-upc-ready-to-bill', '');
    root.addEventListener('click', (e) => { if (e.target.closest('[data-a=refresh]')) run(); });
    state.unmount = U().ui.mountPage('Ready to bill', root, MENU_CLS);
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
    if (!U()) { console.error('[UPC ready to bill] needs the core library'); return; }
    if (!allowed()) return;
    if (!document.getElementById('upc-rtb-css')) { const st = document.createElement('style'); st.id = 'upc-rtb-css'; st.textContent = CSS; document.head.appendChild(st); }
    // Under Finances, after Remittances, opening over Halaxy's Invoices page (as Remittances does).
    U().ui.ensureMenuItem('Ready to bill', (section) => {
      const inv = section && [...section.querySelectorAll('a.mainmenu-sublink')].find((a) => /^invoices$/i.test(U().clean(a.textContent)));
      return (inv ? inv.getAttribute('href').split('#')[0] : U().base() + '/invoice/') + '#' + ROUTE;
    }, MENU_CLS, /^finances?$/i);
    const paint = () => paintBadge();
    new MutationObserver(paint).observe(document.getElementById('mainMenu') || document.body, { childList: true, subtree: true });
    window.addEventListener('storage', (e) => { if (e.key === KEY + 'result') { paintBadge(); render(); } });
    document.addEventListener('visibilitychange', refreshCount);
    window.addEventListener('hashchange', route);
    paint();
    route();
    setTimeout(refreshCount, 3000);
    setInterval(refreshCount, 10 * 60e3);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  // For tests and diagnostics.
  window.upcReadyToBill = { version: VERSION, check, isLastWorkingDay, allowed, userName };
})();
