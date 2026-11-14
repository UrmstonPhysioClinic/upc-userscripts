// ==UserScript==
// @name         UPC Billing: Ready to bill (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.4.2
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/ready-to-bill.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/ready-to-bill.user.js
// @description  Finances > Ready to bill (Carl and Wendy only): insurer patients whose unbilled fees are due to be billed, with the reason and an Invoice Funder button, and a count on the menu. Reads only, except Set to £ 0.00 on a cancelled or did-not-attend fee after confirming.
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
 *  - Due when: the authorisation is used up; or no attended appointment for 14 days and nothing booked.
 *    Bupa, AXA, WPA and Aviva can also be billed mid-treatment (Carl, 10 Nov 2026), so for them also: the
 *    oldest unbilled fee is 4 weeks old (unless the next visit is within 7 days: then after it, on the same
 *    bill), or fees 3 months old or more. Rolling rather than month end (Carl, 14 Nov 2026), so the work is
 *    spread through the month and nobody drops off the list on a set day. Other funders (3rd Party Funded and
 *    so on) are billed only at the end.
 *  - Excess hold (Bupa, AXA, WPA): on a new claim (its first authorised appointment is among the unbilled
 *    fees) hold until the fees cover the excess. Bupa and AXA: the excess is the patient's answer to
 *    "Excess amount:" on their Initial Assessment Form (patient-reported, unconfirmed, used only to time
 *    the hold). Aviva and WPA forms don't ask, and a missing or unreadable answer falls back to: hold until
 *    there are at least 2 fees. A used-up authorisation, old fees, or no visit for 14 days with nothing booked
 *    (no more fees coming) override. Patient status Discharged with nothing booked (read from the calendar
 *    events) is due straight away, for any funder, and ends the excess hold.
 *  - Patients whose only unbilled fees are cancelled or did-not-attend: listed with each appointment's
 *    comments and Set to £ 0.00 (fee and funder rebate, after confirming), read when the page is open.
 *  - Shown only to Carl and Wendy, only inside Halaxy. The count on the menu is refreshed at most every
 *    2 hours, in the visible tab only, shared across tabs, never while Halaxy has asked us to pause.
 *  - Billing is Invoice Funder's job: the button opens the invoice with Invoice Funder.
 */
(() => {
  'use strict';
  if (window.__hxReadyToBill) return;
  window.__hxReadyToBill = true;

  const VERSION = '0.4.2';
  const ROUTE = 'upc-ready-to-bill';
  const MENU_CLS = 'upc-rtb-menu';
  const ALLOWED = ['Carl Healy', 'Wendy Pritchard'];   // Carl, 7 Nov 2026: only the two of them
  const DAY = 86400e3;
  const WINDOW_MONTHS = 6, OLD_MONTHS = 3, QUIET_DAYS = 14, MIN_FEES_NO_EXCESS = 2, ROLLING_DAYS = 28, SOON_DAYS = 7;
  const REFRESH_EVERY = 2 * 3600e3;    // menu count
  const PAGE_FRESH = 10 * 60e3;        // the page re-checks when its results are older than this
  const KEY = 'upc-rtb:';
  const NOT_ATTENDED = /did not attend|did-not-attend|cancel/i;
  const MID_TREATMENT = /bupa|axa|wpa|aviva/i;
  const EXCESS_ON_FORM = /bupa|axa/i;      // only their intake forms ask for the excess
  const MAX_EXCESS = 50000;                // over £ 500 is taken as a slip (an extra 0, the annual limit): use the fallback (Carl, 14 Nov 2026: real excesses up to about £ 300)   // Carl, 10 Nov 2026: only these can be billed before treatment ends

  const U = () => window.UPC;
  const esc = (s) => U().esc(s);
  const store = { get: (k, d) => U().storage(KEY).get(k, d), set: (k, v) => U().storage(KEY).set(k, v), del: (k) => U().storage(KEY).del(k) };   // core's per-PC storage

  const fmt = (c) => U().money.fmt(c);
  const label = (ms) => U().dayLabel(ms);
  const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const addMonths = (ms, n) => { const d = new Date(ms); const r = new Date(d.getFullYear(), d.getMonth() + n, 1); r.setDate(Math.min(d.getDate(), new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate())); return r.getTime(); };

  // ------------------------------------------------------------------ who may see it

  // Who's signed in: the core library's check (Halaxy can fill the name in late, so it keeps looking for 20 seconds).
  const userName = () => U().user.name(ALLOWED);
  const allowed = () => !!U() && U().user.is(ALLOWED);

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

  // The patient-reported excess (pence) from the Initial Assessment Form for this funder, or null when
  // there's no form near the start of the claim or the answer can't be read. Cached for a day.
  const parseExcess = (text) => {
    const t = String(text || '').trim();
    if (!t) return null;
    if (/^(none|nil|no|no excess|zero|£?\s*0+(\.0+)?)\.?$/i.test(t)) return 0;
    const m = t.replace(/,/g, '').match(/(\d+(?:\.\d{1,2})?)/);
    if (!m) return null;
    const v = Math.round(parseFloat(m[1]) * 100);
    return v > MAX_EXCESS ? null : v;
  };
  async function patientExcess(g, say) {
    const key = g.patientId + '|' + g.invoices[0].id;
    const cache = store.get('excess', {});
    if (cache[key] && Date.now() - cache[key].at < DAY) return cache[key].pence;
    say('Reading the intake form...');
    const word = /bupa/i.test(g.funder) ? /bupa/i : /axa/i;
    const from = (g.oldest || Date.now()) - 120 * DAY, to = (g.oldest || Date.now()) + 14 * DAY;
    const form = (await U().forms.list(g.patientId))
      .find((f) => /initial assessment form/i.test(f.label) && word.test(f.label) && (f.date === null || (f.date >= from && f.date <= to)));
    let pence = null;
    if (form) {
      const q = (await U().forms.answers(form.id)).find((a) => /excess/i.test(a.question));
      pence = q ? parseExcess(q.answer) : null;
    }
    cache[key] = { at: Date.now(), pence };
    Object.keys(cache).forEach((k) => { if (Date.now() - cache[k].at > DAY) delete cache[k]; });
    store.set('excess', cache);
    return pence;
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
      g.notAttended = g.allLines.filter((l) => NOT_ATTENDED.test(l.status) && l.amount > 0);
      if (!g.billable.length && !g.notAttended.length) continue;   // only £0 fees: nothing to do
      g.total = g.billable.reduce((s, l) => s + l.amount, 0);
      g.oldest = first.when;
      g.mid = MID_TREATMENT.test(g.funder);
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
      // The patient's status comes with each calendar event (no extra request): the latest one's.
      const st = mine.slice().sort((a, b) => startMs(a) - startMs(b)).map((e) => e.patientStatus).filter(Boolean).pop();
      g.discharged = /^discharged$/i.test(String(st || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
    });

    // Decide.
    for (const g of list) {
      const reasons = [];
      const ref = g.referral;
      const authUsed = !!(ref && ref.limit && ref.position >= ref.limit);
      if (authUsed) reasons.push('Authorisation used up (' + ref.position + ' of ' + ref.limit + ')');
      const quiet = !g.nextBooked && (!g.lastSeen || g.lastSeen < now - QUIET_DAYS * DAY);
      if (quiet) reasons.push('No visit for ' + QUIET_DAYS + ' days' + (g.lastSeen ? ' (last ' + label(g.lastSeen) + ')' : '') + ', nothing booked');
      // Marked Discharged with nothing booked: treatment has finished, so bill now rather than wait for 14 quiet days
      // (Carl, 14 Nov 2026). Any funder, as finished treatment is when all of them are billed.
      const finished = g.discharged && !g.nextBooked;
      if (finished && !quiet) reasons.push('Discharged, nothing booked');
      // Mid-treatment billing (4-weekly, old fees, the excess hold) is for Bupa, AXA, WPA and Aviva only.
      const old = g.mid && g.oldest !== null && g.oldest <= addMonths(day0, -OLD_MONTHS);
      if (old) reasons.push('Fees from ' + label(g.oldest) + ', over ' + OLD_MONTHS + ' months old');
      // Rolling, not month end (Carl, 14 Nov 2026: billed "around once a month", spread through the month): due once
      // the oldest unbilled fee is 4 weeks old, unless the next visit is within a week, so that it joins the same bill.
      const rolling = g.mid && !old && g.oldest !== null && g.oldest <= day0 - ROLLING_DAYS * DAY;
      const visitSoon = !!g.nextBooked && g.nextBooked - now <= SOON_DAYS * DAY;
      if (rolling && !visitSoon) reasons.push('Fees from ' + label(g.oldest) + ', over 4 weeks old');
      const afterVisit = rolling && visitSoon;
      // The excess hold ends when no more fees are coming (no visit for 14 days, nothing booked): Carl, 14 Nov 2026.
      const mayHold = g.mid && g.newClaim && g.billable.length > 0 && !authUsed && !old && !quiet && !finished;
      let excess = null;
      if (mayHold && EXCESS_ON_FORM.test(g.funder) && g.patientId) {
        try { excess = await patientExcess(g, say); } catch (e) { tellHealthCheck(e); }   // fall back to 2 fees
      }
      const held = mayHold && (excess !== null ? g.total < excess : g.billable.length < MIN_FEES_NO_EXCESS);
      g.state = !g.billable.length ? 'check' : held ? 'held' : reasons.length ? 'due' : 'later';
      g.reasons = reasons;
      const when = g.nextBooked ? 'next booked ' + label(g.nextBooked) : g.lastSeen ? 'last seen ' + label(g.lastSeen) : '';
      g.note = g.state === 'check' ? 'Only cancelled or did-not-attend fees: check whether to bill them'
        : g.state === 'held' ? (excess !== null
          ? 'Held for the excess: patient-reported excess ' + fmt(excess) + ' (unconfirmed), fees so far ' + fmt(g.total)
          : 'Held for the excess: first invoice on a new claim, ' + g.billable.length + ' fee so far (' +
            (EXCESS_ON_FORM.test(g.funder) ? 'excess not found on the intake form' : g.funder + '\'s form doesn\'t ask for the excess') +
            ', so waiting for ' + MIN_FEES_NO_EXCESS + ' fees)')
          : g.state === 'later' ? (g.mid ? (afterVisit ? 'Fees over 4 weeks old: billed after the visit on ' + label(g.nextBooked) + ', so it goes on the same bill' : 'Not due yet' + (when ? ': ' + when : ''))
            : 'Billed at the end of treatment (' + g.funder + ' isn\'t billed mid-treatment)' + (when ? ': ' + when : '')) : '';
    }
    const order = { due: 0, check: 1, held: 2, later: 3 };
    list.sort((a, b) => order[a.state] - order[b.state] || (a.oldest || 0) - (b.oldest || 0));
    const result = {
      at: Date.now(), by: VERSION,
      due: list.filter((g) => g.state === 'due').length,
      rows: list.map((g) => ({
        payer: g.payer, funder: g.funder, patientId: g.patientId, state: g.state, reasons: g.reasons, note: g.note,
        fees: g.billable.length, total: g.total, oldest: g.oldest, lastInvoiceId: g.lastInvoice.id,
        notAttended: g.notAttended.length, notAttendedTotal: g.notAttended.reduce((s, l) => s + l.amount, 0),
        invoices: g.invoices.map((i) => ({ id: i.id, number: i.number, when: i.when, total: i.lines.reduce((s, l) => s + l.amount, 0) })),
      })),
    };
    store.set('result', result);
    return result;
  }

  // ------------------------------------------------------------------ menu count

  // Shared by all tabs: one refresh at a time, at most every 2 hours, in the visible tab only.
  async function refreshCount() {
    if (!allowed() || !U() || !U().background.ok()) return;   // visible tab, clinic hours, someone at the PC, Halaxy not busy
    const last = store.get('result', null);
    if (last && !U().background.due(last.at, REFRESH_EVERY)) return;
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
    .upc-rtb td.upc-rtb-date { white-space: nowrap; }
    .upc-rtb .upc-rtb-fee { margin-top: 8px; }
    .upc-rtb .upc-rtb-fee .btn { margin: 4px 0 0; }
    .upc-rtb tr.upc-off .upc-rtb-fee .btn { color: inherit; }
  `;

  const state = { unmount: null, running: false, status: '', error: '' };
  let root = null;

  // Cancelled and did-not-attend fees of patients with nothing else to bill: each fee with its appointment
  // comments, read when the page is open (kept for this tab only, never stored). By invoice id.
  const details = new Map();
  const zeroed = new Map();   // line id -> { ok, error }
  let detailsRunning = false;
  async function loadDetails() {
    if (detailsRunning) return;
    detailsRunning = true;
    try {
      const r = store.get('result', null);
      const invs = r ? r.rows.filter((x) => x.state === 'check').flatMap((x) => x.invoices) : [];
      for (const i of invs) {
        if (!root) return;
        if (details.has(i.id)) continue;
        details.set(i.id, { state: 'loading' });
        render();
        try {
          const inv = await U().invoice.fetch(i.id);
          const fees = [];
          for (const l of inv.lines.filter((x) => x.amount > 0)) {
            let comment = '', commentError = '';
            if (l.appointmentId) { try { comment = await U().appointment.notes(l.appointmentId); } catch (e) { commentError = e.message || String(e); } }
            fees.push({ invoiceId: i.id, invoiceNumber: inv.number, lineId: l.lineId, date: l.date, item: l.item, amount: l.amount, comment, commentError });
          }
          details.set(i.id, { state: 'ok', fees });
        } catch (e) {
          details.set(i.id, { state: 'error', error: e.message || String(e) });
        }
        render();
      }
    } finally {
      detailsRunning = false;
    }
  }

  function feesHtml(r) {
    return r.invoices.map((i) => {
      const d = details.get(i.id);
      if (!d || d.state === 'loading') return '<div class="upc-rtb-fee text-muted">Reading ' + esc(i.number) + '...</div>';
      if (d.state === 'error') return '<div class="upc-rtb-fee upc-err">' + esc(i.number) + ': ' + esc(d.error) + '</div>';
      return d.fees.map((f) => {
        const z = zeroed.get(f.lineId);
        const btn = '<button type="button" class="' + U().ui.btn('light') + '" data-zero="' + esc(f.lineId) + '" data-inv="' + esc(f.invoiceId) + '">Set to £ 0.00</button>';
        const act = !z ? btn : z.busy ? '<span class="text-muted">Working...</span>' : z.ok ? '<span class="upc-ok">Set to £ 0.00</span>'
          : '<span class="upc-err">Not changed: ' + esc(z.error) + '</span> ' + btn;
        return '<div class="upc-rtb-fee"><b>' + esc(f.date) + '</b> ' + esc(f.item) + ', ' + fmt(f.amount) + ' (' + esc(f.invoiceNumber) + ')' +
          (f.comment ? '<div class="upc-note">' + esc(f.comment) + '</div>' : '<div class="text-muted">' + (f.commentError ? 'Comments not read: ' + esc(f.commentError) : 'No comments') + '</div>') +
          '<div>' + act + '</div></div>';
      }).join('');
    }).join('');
  }

  function rowHtml(r, withAction) {
    const base = U().base();
    const invs = r.invoices.map((i) => '<a href="' + esc(base + '/invoice/' + i.id) + '" target="_blank" rel="noopener">' + esc(i.number) + '</a>').join('');
    const who = r.patientId ? '<a href="' + esc(base + '/patient/' + r.patientId) + '" target="_blank" rel="noopener">' + esc(r.payer) + '</a>' : esc(r.payer);
    const why = r.state === 'due' ? '<ul class="upc-rtb-why">' + r.reasons.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>'
      : esc(r.note) + (r.state === 'check' ? feesHtml(r) : '');
    const na = r.notAttended ? r.notAttended + ' not attended<br>' + fmt(r.notAttendedTotal) : '';
    const unbilled = r.fees ? r.fees + ' fee' + (r.fees === 1 ? '' : 's') + '<br>' + fmt(r.total) + (na ? '<div class="text-muted">+ ' + na + '</div>' : '') : na;
    const act = r.state === 'due' ? '<a class="btn btn-outline-primary-light" href="' + esc(base + '/invoice/' + r.lastInvoiceId + '#upc-invoice-funder') + '">Invoice Funder</a>' : '';
    return '<tr class="' + (r.state === 'due' ? '' : 'upc-off') + '"><td>' + who + '</td><td>' + esc(r.funder) + '</td>' +
      '<td class="number">' + unbilled + '</td><td class="upc-rtb-date">' + (r.oldest ? esc(label(r.oldest)) : '') + '</td>' +
      '<td>' + why + '</td><td class="upc-rtb-invs">' + invs + '</td>' + (withAction ? '<td>' + act + '</td>' : '') + '</tr>';
  }

  function confirmZero(f) {
    return new Promise((resolve) => {
      let answered = false;
      const done = (v) => { if (!answered) { answered = true; resolve(v); } };
      const dlg = U().ui.dialog({ title: 'Set to £ 0.00?', small: true, onClose: () => done(false) });
      dlg.root.setAttribute('data-upc-rtb-confirm', '');
      dlg.body.innerHTML = '<p>Set the ' + esc(f.date) + ' fee on ' + esc(f.invoiceNumber) + ' (' + fmt(f.amount) + ') to £ 0.00?</p>' +
        '<p class="text-muted">The fee and its funder rebate are set to £ 0.00 in its fee edit pop-up, with every other field left as it is.</p>' +
        '<div class="upc-actions"><button type="button" class="btn btn-outline-primary" data-a="no">Cancel</button><button type="button" class="btn btn-primary" data-a="yes">Set to £ 0.00</button></div>';
      dlg.body.addEventListener('click', (e) => {
        const a = e.target.closest('[data-a]');
        if (!a) return;
        done(a.dataset.a === 'yes');
        dlg.close();
      });
    });
  }

  async function zero(lineId, invoiceId) {
    const d = details.get(invoiceId);
    const f = d && d.fees && d.fees.find((x) => String(x.lineId) === String(lineId));
    const z = f && zeroed.get(f.lineId);
    if (!f || (z && (z.busy || z.ok)) || !(await confirmZero(f))) return;
    zeroed.set(f.lineId, { busy: true });
    render();
    try {
      await U().invoice.setLineAmount(f.invoiceId, f.lineId, 0, { lowerRebate: true });   // amount and funder rebate together
      zeroed.set(f.lineId, { ok: true });
    } catch (e) {
      zeroed.set(f.lineId, { ok: false, error: e.message || String(e) });
    }
    render();
  }

  function render() {
    if (!root) return;
    const r = store.get('result', null);
    const head = (withAction) => '<thead><tr><th>Patient</th><th>Funder</th><th class="number">Unbilled</th><th>Oldest fee</th><th>Why</th><th>Invoices</th>' + (withAction ? '<th></th>' : '') + '</tr></thead>';
    let h = '<div class="upc-rtb"><h1>Ready to bill</h1><div class="upc-rtb-bar">' +
      '<button type="button" class="btn btn-outline-primary-light" data-a="refresh" ' + (state.running ? 'disabled' : '') + '>' + (state.running ? 'Checking...' : 'Check again') + '</button>' +
      (state.running ? U().ui.run.inline(state.status) : '<span class="text-muted">' + esc(r ? 'Checked at ' + new Date(r.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + ' on ' + label(r.at) + '.' : '') + '</span>') + '</div>';
    if (state.error) h += '<p class="upc-err">' + esc(state.error) + '</p>';
    if (r) {
      const due = r.rows.filter((x) => x.state === 'due'), rest = r.rows.filter((x) => x.state !== 'due');
      h += '<div class="card"><div class="card-header"><h2>Due to bill (' + due.length + ')</h2></div><div class="card-body p-0">' +
        (due.length ? '<table class="table table-striped table-bordered w-100 m-0">' + head(true) + '<tbody>' + due.map((x) => rowHtml(x, true)).join('') + '</tbody></table>'
          : '<p class="text-muted m-3">Nothing is due to bill.</p>') + '</div></div>';
      if (rest.length) {
        h += '<div class="card"><div class="card-header"><h2>Not due yet (' + rest.length + ')</h2></div><div class="card-body p-0">' +
          '<table class="table table-bordered w-100 m-0">' + head(false) + '<tbody>' + rest.map((x) => rowHtml(x, false)).join('') + '</tbody></table></div></div>';
      }
      h += '<p class="text-muted">Unbilled means an insurer patient\'s fee on an Active invoice that Halaxy doesn\'t show as Pending. ' +
        'Fees older than ' + WINDOW_MONTHS + ' months are left out. Only Bupa, AXA, WPA and Aviva are billed mid-treatment; other funders are due when the authorisation is used up or treatment has finished. ' +
        'New claims are held until the fees cover the excess the patient gave on their Bupa or AXA intake form (unconfirmed; used only to time billing), otherwise until there are ' + MIN_FEES_NO_EXCESS + ' fees.</p>';
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
    loadDetails();
  }

  function mount() {
    if (state.unmount || !allowed()) return;
    if (!document.getElementById('upc-rtb-css')) { const st = document.createElement('style'); st.id = 'upc-rtb-css'; st.textContent = CSS; document.head.appendChild(st); }
    U().ui.nativeStyles();
    root = document.createElement('div');
    root.className = 'upc-native';
    root.setAttribute('data-upc-ready-to-bill', '');
    root.addEventListener('click', (e) => {
      if (e.target.closest('[data-a=refresh]')) run();
      const z = e.target.closest('[data-zero]');
      if (z) zero(z.dataset.zero, z.dataset.inv);
    });
    state.unmount = U().ui.mountPage('Ready to bill', root, MENU_CLS);
    render();
    const r = store.get('result', null);
    if (!r || Date.now() - r.at > PAGE_FRESH || r.by !== VERSION) run();
    else loadDetails();
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
  const begin = () => { if (U()) U().user.whenAllowed(ALLOWED, start); else start(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', begin, { once: true });
  else begin();

  // For tests and diagnostics.
  window.upcReadyToBill = { version: VERSION, check, allowed, userName };
})();
