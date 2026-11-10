// ==UserScript==
// @name         Halaxy bill funder (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.7.3
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/bill-funder.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/bill-funder.user.js
// @description  "Bill funder" next to Halaxy's Invoice Funder button: finds this patient's unbilled fees for the same claim, lets you choose, merges them onto one invoice, then invoices the funder once as a new organisation invoice. Asks before changing anything.
// @match        https://*.halaxy.com/a/pr/*/invoice/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * Why merge first: the patient's excess is charged per invoice, and each card charge costs
 * £1 + 1.99%. Merging every chosen fee onto one patient invoice before invoicing the funder means
 * the excess is charged once.
 *
 * Which fees are suggested (agreed rules):
 *  - this patient, same claim (same funder authorisation) as the invoice you're on
 *  - dated today or earlier, and within the last 6 months
 *  - not already billed to the funder (Halaxy still shows its Invoice Funder button)
 *  - not on an Issued invoice (Halaxy can't merge those)
 *  - did-not-attend or cancelled with a fee above £0: listed but not ticked, with the
 *    appointment's comments, so you decide; £0 fees are listed but not ticked
 *
 * What it does after one confirmation, with Halaxy's own pop-ups:
 *  1. Merge: on the latest chosen invoice, Halaxy's "Merge invoice fees" with the chosen fees.
 *  2. Check the merged invoice has exactly the chosen fees.
 *  3. Invoice Funder once: keep the patient invoice, create a NEW organisation invoice
 *     (Halaxy pre-selects an existing one, often another patient's; this never uses it).
 *  4. Check the patient invoice now shows the organisation invoice.
 *  5. Mark the merged patient invoice Issued (cogwheel status), so nothing more merges into it.
 * Needs the core library (core.user.js).
 */

(function () {
  'use strict';
  if (window.__upcBillFunder) return;
  window.__upcBillFunder = true;

  const VERSION = '0.7.3';
  const MAX_AGE_DAYS = 183;   // about 6 months
  const NOT_ATTENDED = /cancel|did-not-attend|dna|reject|declin|reschedul/i;
  const DAY = 86400e3;

  const U = () => window.UPC;
  const fmt = (c) => U().money.fmt(c);   // £ 40.00, as Halaxy
  const esc = (s) => U().esc(s);
  const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  function parseDate(s) {   // '2026-08-27T09:00:00+01:00' or '05-Sep-2026 09:00'
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return new Date(s).getTime();
    const m = String(s).match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
    return m ? new Date(+m[3], MONTHS[m[2].toLowerCase()], +m[1]).getTime() : null;
  }
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // Same day N months later; the last day of the month when that day doesn't exist (31-Aug + 3 = 30-Nov).
  const addMonths = (d, n) => { const r = new Date(d.getFullYear(), d.getMonth() + n, 1); r.setDate(Math.min(d.getDate(), new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate())); return r; };
  const dateLabel = (t) => { if (!t) return ''; const d = new Date(t); return String(d.getDate()).padStart(2, '0') + '-' + MON[d.getMonth()] + '-' + d.getFullYear(); };   // 05-Nov-2026, as Halaxy

  // ------------------------------------------------------------------ reading Halaxy

  // The merge pop-up embeds the patient's fees on other invoices as JSON inside a script.
  function mergeCandidates(popupJson) {
    const html = String(popupJson && popupJson.message || '');
    const m = html.match(/allInvoiceGroupEditGridData\s*=\s*JSON\.parse\('([\s\S]*?)'\)/);
    if (!m) throw new (U().Error)('Halaxy\'s merge pop-up has changed, so nothing was done.');
    const text = m[1].replace(/\\(["'\\/])/g, '$1');
    return JSON.parse(text);
  }

  // Appointment status and comments for the appointments behind the fees.
  async function appointmentInfo(fromTime) {
    const info = {};
    try {
      const pracs = await U().http.json('/lookup/practitioner?clinic=&include_id=&type=');
      const qs = new URLSearchParams({ start: Math.floor(fromTime / 1000) - DAY / 1000, end: Math.floor(Date.now() / 1000) + DAY / 1000 });
      (Array.isArray(pracs) ? pracs : []).forEach((p, i) => qs.append('practitioners[' + i + '][id]', p.id));
      const cal = await U().http.json('/calendar/json?' + qs.toString());
      ((cal && cal.payload && cal.payload.events) || []).forEach((e) => {
        if (e.type && e.type !== 'appointment') return;
        const comment = [e.note, e.description, e.comment, e.comments].find((x) => x && String(x).trim());
        info[String(e.id)] = {
          status: String(e.appointmentStatus || '').trim(),
          comment: comment ? U().clean(U().htmlDoc(String(comment)).body.textContent) : '',
        };
      });
    } catch (e) {
      console.warn('[UPC bill funder] appointment details unavailable:', e.message);
    }
    return info;
  }

  // Everything the chooser needs, read only.
  async function gather(currentId, say) {
    say('Reading this invoice...');
    const current = await U().invoice.fetch(currentId);
    if (!current.billFunderHref || !current.claimId) throw new (U().Error)('This invoice has no Invoice Funder button, so there is nothing to bill from here.');
    if (!current.patientId) throw new (U().Error)('Could not tell which patient this invoice is for.');
    say('Finding this patient\'s other fees...');
    const popup = await U().http.popup('/invoice/' + currentId + '/group');
    const others = mergeCandidates(popup.json);

    // One entry per invoice (current plus each invoice in the merge list).
    const ids = [String(currentId), ...new Set(others.map((r) => String(r.invoiceId)))].filter((v, i, a) => a.indexOf(v) === i);
    const today = startOfToday();
    const cutoff = today - MAX_AGE_DAYS * DAY;
    const fees = [];
    const skipped = { future: 0, old: 0, otherClaim: 0, billed: 0, issued: 0 };
    // Which invoice and date each left-out fee is, so the list can be checked against Halaxy's merge menu.
    const leftOut = [];
    const lineWhen = (l) => { const row = others.find((r) => String(r.invoiceLineId) === String(l.lineId)); return parseDate(row ? row.invoiceLineDate : l.date); };
    const leave = (inv, reason, lines) => leftOut.push({ number: inv.number, id: inv.id, reason, dates: lines.map(lineWhen).filter((w) => w !== null) });
    for (let i = 0; i < ids.length; i++) {
      say('Checking invoice ' + (i + 1) + ' of ' + ids.length + '...');
      const inv = String(ids[i]) === String(currentId) ? current : await U().invoice.fetch(ids[i]);
      let status = '';
      try { status = await U().invoice.status(inv.id); } catch (e) { status = inv.issued ? 'issued' : ''; }
      if (status) { skipped.issued += inv.lines.length; leave(inv, status === 'issued' ? 'invoice is Issued' : 'invoice is ' + status, inv.lines); continue; }   // anything other than Active
      if (inv.claimId !== current.claimId) { skipped.otherClaim += inv.lines.length; leave(inv, 'another claim or self-funded', inv.lines); continue; }
      if (!inv.billFunderHref) { skipped.billed += inv.lines.length; leave(inv, 'already billed to the funder', inv.lines); continue; }
      inv.lines.forEach((l) => {
        const row = others.find((r) => String(r.invoiceLineId) === String(l.lineId));
        const when = parseDate(row ? row.invoiceLineDate : l.date);
        if (when === null || when >= today + DAY) { skipped.future++; leave(inv, 'future-dated', [l]); return; }
        if (when < cutoff) { skipped.old++; leave(inv, 'older than 6 months', [l]); return; }
        fees.push({
          invoiceId: inv.id, invoiceNumber: inv.number, lineId: l.lineId, appointmentId: l.appointmentId, when,
          name: row ? row.invoiceLineName : (l.item || 'Fee'), amount: row ? Math.round(parseFloat(row.total) * 100) : l.amount,
          practitioner: row ? row.practitionerName : '', referral: inv.referral, isCurrent: String(inv.id) === String(currentId),
        });
      });
    }
    if (fees.length) {
      say('Reading appointment details...');
      const appts = await appointmentInfo(Math.min(...fees.map((f) => f.when)));
      fees.forEach((f) => {
        const a = f.appointmentId && appts[f.appointmentId];
        f.apptStatus = a ? a.status : '';
        f.comment = a ? a.comment : '';
        f.notAttended = !!(a && NOT_ATTENDED.test(a.status));
        f.beyondAuth = !!(f.referral && f.referral.position > f.referral.limit);
        f.selected = f.amount > 0 && !f.notAttended;
      });
      // Cancellation reasons and billing notes are in the appointment's own comments, which the
      // calendar data leaves out: read them from its details pop-up (one request per such fee).
      for (const f of fees.filter((x) => x.notAttended && x.appointmentId && !x.comment)) {
        say('Reading the comments on the ' + dateLabel(f.when) + ' appointment...');
        try { f.comment = await U().appointment.notes(f.appointmentId); } catch (e) { f.commentError = e.message || String(e); }
      }
    }
    fees.sort((a, b) => a.when - b.when);
    return { current, fees, skipped, leftOut };
  }

  // ------------------------------------------------------------------ doing it

  // The invoice to merge onto: the latest chosen one that holds only chosen fees (so nothing you
  // didn't tick ends up billed). Checked against a fresh copy before anything changes.
  async function pickTarget(chosen, say) {
    const ids = new Set(chosen.map((f) => String(f.lineId)));
    const byInvoice = [...new Set(chosen.slice().sort((a, b) => b.when - a.when || +b.invoiceId - +a.invoiceId).map((f) => String(f.invoiceId)))];
    for (const id of byInvoice) {
      say('Checking ' + (chosen.find((f) => String(f.invoiceId) === id).invoiceNumber) + ' can take the merge...');
      const inv = await U().invoice.fetch(id);
      if (inv.lines.length && inv.lines.every((l) => ids.has(String(l.lineId))) && inv.billFunderHref && !inv.issued) return chosen.find((f) => String(f.invoiceId) === id);
    }
    throw new (U().Error)('Every chosen invoice also holds a fee you did not choose, so there is nowhere safe to merge them. Nothing was changed. Tick those fees too, or merge by hand.');
  }

  async function run(plan, chosen, say) {
    const target = await pickTarget(chosen, say);
    const targetId = String(target.invoiceId);
    const toMove = chosen.filter((f) => String(f.invoiceId) !== targetId).map((f) => String(f.lineId));
    const expectLines = chosen.map((f) => String(f.lineId)).sort();
    const expectTotal = chosen.reduce((s, f) => s + f.amount, 0);

    // 1. Merge onto the latest chosen invoice.
    if (toMove.length) {
      say('Merging ' + toMove.length + ' fee' + (toMove.length === 1 ? '' : 's') + ' onto ' + target.invoiceNumber + '...');
      const popup = await U().http.popup('/invoice/' + targetId + '/group');
      const offered = new Set(mergeCandidates(popup.json).map((r) => String(r.invoiceLineId)));
      const missing = toMove.filter((id) => !offered.has(id));
      if (missing.length) throw new (U().Error)('Halaxy no longer offers some of the chosen fees for merging. Nothing was changed. Reload and try again.');
      const pairs = [['form[type]', '1'], ['form[hasUnpaidInvoices]', '1']].concat(toMove.map((id) => ['form[il][]', id]));
      U().http.expectRefresh(await U().http.postForm('/invoice/' + targetId + '/group', pairs), 'Merging the fees');
    }

    // 2. Check the merged invoice.
    say('Checking ' + target.invoiceNumber + '...');
    const merged = await U().invoice.fetch(targetId);
    const have = merged.lines.map((l) => String(l.lineId)).sort();
    const extra = have.filter((id) => !expectLines.includes(id));
    const lacking = expectLines.filter((id) => !have.includes(id));
    if (lacking.length) throw new (U().Error)('After merging, ' + merged.number + ' is missing ' + lacking.length + ' of the chosen fees. The funder has not been invoiced. Check the invoice.');
    if (extra.length) throw new (U().Error)(merged.number + ' also has fees you did not choose. The funder has not been invoiced. Check the invoice.');
    if (merged.total !== null && merged.total !== expectTotal) throw new (U().Error)(merged.number + ' totals ' + fmt(merged.total) + ', expected ' + fmt(expectTotal) + '. The funder has not been invoiced. Check the invoice.');
    if (!merged.billFunderHref || merged.claimId !== plan.current.claimId) throw new (U().Error)(merged.number + ' no longer shows Invoice Funder for this claim. The funder has not been invoiced.');

    // 3. Invoice Funder once, as a new organisation invoice, keeping the patient invoice.
    say('Invoicing ' + (plan.current.funderName || 'the funder') + ' from ' + merged.number + ' (new organisation invoice)...');
    const bill = await U().http.popup(merged.billFunderHref);
    const form = bill.doc.querySelector('form#organisationBillForm');
    if (!form || !form.querySelector('input[name="form[orgInvoice]"][value="0"]') || !form.querySelector('input[name="form[switchPayer]"][value="no"]')) {
      throw new (U().Error)('Halaxy\'s Invoice Funder pop-up has changed, so the funder was not invoiced. The fees are merged on ' + merged.number + '; use Invoice Funder there by hand.');
    }
    U().http.expectRefresh(await U().http.postForm(merged.billFunderHref, [['form[switchPayer]', 'no'], ['form[orgInvoice]', '0']]), 'Invoicing the funder');

    // 4. Check.
    const after = await U().invoice.fetch(targetId);
    const org = after.payments.find((p) => p.funderInvoiceId);
    if (after.billFunderHref || !org) throw new (U().Error)('Halaxy accepted the request, but ' + after.number + ' does not show an organisation invoice. Check it.');
    let orgNumber = '';
    try { orgNumber = (await U().invoice.fetch(org.funderInvoiceId)).number; } catch (e) { /* link still works */ }

    // 5. Mark the patient invoice Issued.
    say('Marking ' + after.number + ' as Issued...');
    let issuedError = '';
    try { await U().invoice.setStatus(targetId, 'issued'); } catch (e) { issuedError = e.message || String(e); }

    // 6. Fee dates on the funder invoice (Carl, 9 Nov 2026): Halaxy sometimes copies a fee with the wrong
    // date (13-Oct became 14-Oct). Pair each funder fee with the patient fee it came from (same order by
    // date, same item) and correct dates a day or two out. Anything else is reported, not changed.
    say('Checking the fee dates on ' + (orgNumber || 'the funder invoice') + '...');
    const dateFixes = [];
    let feeDateError = '';
    try {
      const byWhen = (a, b2) => (parseDate(a.date) || 0) - (parseDate(b2.date) || 0);
      const P = after.lines.slice().sort(byWhen);
      const O = (await U().invoice.fetch(org.funderInvoiceId)).lines.slice().sort(byWhen);
      if (P.length !== O.length || P.some((l, i) => l.item && O[i].item && l.item !== O[i].item)) {
        feeDateError = 'its fees could not be paired with the patient invoice\'s, so their dates were not checked';
      } else {
        for (let i = 0; i < P.length; i++) {
          const want = P[i].date, have = O[i].date;
          if (!want || !have || want === have) continue;
          const days = Math.round(Math.abs(parseDate(want) - parseDate(have)) / DAY);
          if (days > 2) { feeDateError = 'the ' + have + ' fee is ' + days + ' days from the patient fee (' + want + '), so it was not changed'; continue; }
          say('Correcting a fee date on ' + (orgNumber || 'the funder invoice') + ': ' + have + ' to ' + want + '...');
          try { await U().invoice.setLineDate(O[i].lineId, want); dateFixes.push({ from: have, to: want }); }
          catch (e) { feeDateError = 'the ' + have + ' fee could not be changed to ' + want + ' (' + (e.message || e) + ')'; }
        }
      }
    } catch (e) { feeDateError = e.message || String(e); }

    // 7. Funder invoice dates (Carl, 9 Nov 2026): invoice date the day it was created, due 3 months later.
    // Halaxy copies the patient invoice's date and leaves the due date empty.
    const today = new Date();
    const invDate = dateLabel(today.getTime());
    const dueDate = dateLabel(addMonths(today, 3).getTime());
    say('Setting ' + (orgNumber || 'the funder invoice') + ' to invoice date ' + invDate + ', due ' + dueDate + '...');
    let datesError = '';
    try { await U().invoice.setSettings(org.funderInvoiceId, { 'form[displayDate]': invDate, 'form[dueDate]': dueDate }, 'the invoice dates'); } catch (e) { datesError = e.message || String(e); }
    return { patientInvoiceId: targetId, patientInvoiceNumber: after.number, orgInvoiceId: org.funderInvoiceId, orgInvoiceNumber: orgNumber, amount: org.amount, issuedError, invDate, dueDate, datesError, dateFixes, feeDateError };
  }

  // ------------------------------------------------------------------ panel

  function openPanel(currentId) {
    const st = { phase: 'loading', status: 'Reading...', plan: null, log: [], result: null, error: '', confirm: false, zero: {}, zeroDone: {}, zeroConfirm: false };
    const dlg = U().ui.dialog({ title: 'Invoice Funder', key: 'bill-funder', canClose: () => st.phase !== 'running' && st.phase !== 'zeroing' });
    if (!dlg) return;
    dlg.root.setAttribute('data-upc-bill-funder', '');
    const sh = dlg.body;
    const chosen = () => (st.plan ? st.plan.fees.filter((f) => f.selected) : []);
    const needsMerge = () => new Set(chosen().map((f) => String(f.invoiceId))).size > 1;
    const goLabel = () => (needsMerge() ? 'Merge and bill' : 'Bill funder');
    const leftover = () => (st.plan && st.result ? st.plan.fees.filter((f) => !f.selected && f.notAttended && f.amount > 0) : []);
    const toZero = () => leftover().filter((f) => st.zero[String(f.lineId)] === 'zero' && !st.zeroDone[String(f.lineId)]);

    function render() {
      const p = st.plan;
      dlg.setTitle('Invoice Funder');
      let h = '<div class="text-muted">Merges the chosen fees onto one invoice, then invoices the funder once, so the patient\'s excess is charged once. Halaxy\'s own steps; nothing changes until you confirm.</div>';
      if (st.phase === 'loading') h += '<p>' + esc(st.status) + '</p>';
      if (st.error) h += '<p class="upc-warn upc-gap">' + esc(st.error) + '</p>';
      if (p && st.phase !== 'loading') {
        if (!p.fees.length) h += '<p>No unbilled fees for this claim, dated today or earlier in the last 6 months.</p>';
        else {
          h += '<table class="table w-100"><thead><tr><th></th><th>Date</th><th>Fee</th><th>Invoice</th><th class="number">Amount</th><th>Notes</th></tr></thead><tbody>';
          p.fees.forEach((f, i) => {
            const notes = [];
            if (f.notAttended) notes.push('<span class="upc-warn">' + esc(f.apptStatus.replace(/-/g, ' ')) + ': not ticked, include only if you mean to bill it</span>');
            if (f.isCurrent) notes.push('<span class="text-muted">On this invoice</span>');
            if (!f.amount) notes.push('<span class="text-muted">£0 fee: not ticked</span>');
            if (f.referral) notes.push((f.beyondAuth ? '<span class="upc-warn">' : '<span class="text-muted">') + 'Appointment ' + f.referral.position + ' of ' + f.referral.limit + ' authorised' + (f.beyondAuth ? ': beyond the authorisation' : '') + '</span>');
            if (f.comment) notes.push('<div class="upc-note">' + esc(f.comment) + '</div>');
            else if (f.commentError) notes.push('<span class="text-muted">Comments could not be read: open the appointment to check.</span>');
            h += '<tr class="' + (f.selected ? '' : 'upc-off') + '"><td><input type="checkbox" data-i="' + i + '" ' + (f.selected ? 'checked' : '') + (st.phase !== 'choose' ? ' disabled' : '') + ' aria-label="Include ' + esc(dateLabel(f.when)) + '"></td>' +
              '<td>' + esc(dateLabel(f.when)) + '</td><td>' + esc(f.name) + (f.practitioner ? '<div class="text-muted">' + esc(f.practitioner) + '</div>' : '') + '</td>' +
              '<td><a href="' + esc(U().base() + '/invoice/' + f.invoiceId) + '" target="_blank" rel="noopener">' + esc(f.invoiceNumber) + '</a></td><td class="number">' + fmt(f.amount) + '</td><td>' + notes.join('<br>') + '</td></tr>';
          });
          h += '</tbody></table>';
          const c = chosen();
          h += '<div class="upc-gap font-weight-bold">' + c.length + ' fee' + (c.length === 1 ? '' : 's') + ' chosen, total ' + fmt(c.reduce((s, f) => s + f.amount, 0)) + '.</div>';
          if (c.some((f) => f.beyondAuth)) h += '<p class="upc-warn upc-gap">Some chosen fees are beyond the authorisation. The insurer may not pay them.</p>';
        }
        // Left out, one line per invoice and reason, to match against Halaxy's merge menu.
        const groups = [];
        (p.leftOut || []).forEach((x) => {
          const g = groups.find((y) => y.id === x.id && y.reason === x.reason);
          if (g) g.dates.push(...x.dates); else groups.push({ id: x.id, number: x.number, reason: x.reason, dates: x.dates.slice() });
        });
        if (groups.length) {
          h += '<div class="text-muted upc-gap">Not shown:<ul class="mb-0">' + groups.map((g) => '<li><a href="' + esc(U().base() + '/invoice/' + g.id) + '" target="_blank" rel="noopener">' + esc(g.number) + '</a>' +
            (g.dates.length ? ', ' + esc([...new Set(g.dates.sort((a, b) => a - b).map(dateLabel))].join(', ')) : '') + ': ' + esc(g.reason) + '</li>').join('') + '</ul></div>';
        }
      }
      if (st.confirm) {
        const c = chosen();
        const total = fmt(c.reduce((s, f) => s + f.amount, 0));
        const funder = esc(p.current.funderName || 'the funder');
        h += '<div class="upc-box upc-log"><b>Confirm</b><br>' + (needsMerge()
          ? 'Merge ' + c.length + ' fees (' + total + ') onto the latest of their invoices, then invoice ' + funder + ' once as a new organisation invoice (dated today, due in 3 months), keeping the patient invoice, and mark that patient invoice Issued. Fees on invoices emptied by the merge are moved and those invoices are deleted by Halaxy, as its merge does.'
          : 'Nothing to merge: ' + (c.length === 1 ? 'the fee is' : 'the fees are') + ' already on ' + esc(c[0].invoiceNumber) + '. Invoice ' + funder + ' once from it (' + total + ') as a new organisation invoice (dated today, due in 3 months), keeping the patient invoice, and mark it Issued.') + '</div>';
      }
      if (st.log.length) h += '<div class="upc-box upc-log">' + st.log.map((l) => '<div class="' + (l.err ? 'upc-err' : '') + '">' + esc(l.t) + '</div>').join('') + '</div>';
      if (st.result) {
        const r = st.result;
        h += '<p class="upc-ok upc-gap">Billed. ' + esc(r.patientInvoiceNumber) + ' is billed to the funder on <a href="' + esc(U().base() + '/invoice/' + r.orgInvoiceId) + '" target="_blank" rel="noopener">' + esc(r.orgInvoiceNumber || 'the new organisation invoice') + '</a>' + (r.amount !== null && r.amount !== undefined ? ' (' + fmt(r.amount) + ')' : '') +
          (r.issuedError ? '.</p><p class="upc-warn upc-gap">Billing is done, but ' + esc(r.patientInvoiceNumber) + ' could not be marked Issued (' + esc(r.issuedError) + '). Set it with the cogwheel.</p>' : ', and ' + esc(r.patientInvoiceNumber) + ' is marked Issued.</p>');
        h += r.datesError ? '<p class="upc-warn">The funder invoice dates were not set (' + esc(r.datesError) + '). Set the invoice date to ' + esc(r.invDate) + ' and the due date to ' + esc(r.dueDate) + ' with its cogwheel.</p>'
          : '<p class="text-muted">' + esc(r.orgInvoiceNumber || 'The funder invoice') + ': invoice date ' + esc(r.invDate) + ', due ' + esc(r.dueDate) + '.</p>';
        if (r.dateFixes && r.dateFixes.length) h += '<p class="text-muted">Fee date' + (r.dateFixes.length === 1 ? '' : 's') + ' corrected on ' + esc(r.orgInvoiceNumber || 'the funder invoice') + ' (Halaxy copied ' + (r.dateFixes.length === 1 ? 'it' : 'them') + ' wrongly): ' + esc(r.dateFixes.map((f) => f.from + ' to ' + f.to).join(', ')) + '.</p>';
        if (r.feeDateError) h += '<p class="upc-warn">Check the fee dates on ' + esc(r.orgInvoiceNumber || 'the funder invoice') + ': ' + esc(r.feeDateError) + '.</p>';
      }
      // After billing: cancelled or did-not-attend fees left out, to keep or set to £0.
      const left = leftover();
      if (st.result && left.length) {
        h += '<div class="upc-gap"><b>Not billed to ' + esc(p.current.funderName || 'the funder') + '</b>' +
          '<div class="text-muted">These cancelled or did-not-attend fees were left out. Keep any you will charge another way; set the rest to £ 0.00. Nothing changes until you confirm.</div>' +
          '<table class="table w-100"><thead><tr><th>Date</th><th>Fee</th><th>Invoice</th><th class="number">Amount</th><th>Comments</th><th>Keep or set to £ 0.00</th></tr></thead><tbody>';
        left.forEach((f) => {
          const key = String(f.lineId);
          const choice = st.zero[key] || 'keep';
          const done = st.zeroDone[key];
          const pick = done ? (done.ok ? '<span class="upc-ok">Set to £ 0.00</span>' : '<span class="upc-err">Not changed: ' + esc(done.error) + '</span>')
            : ['keep', 'zero'].map((v) => '<label class="mr-2 mb-0"><input type="radio" name="upc-z-' + key + '" data-z="' + key + '" value="' + v + '"' + (choice === v ? ' checked' : '') +
              (st.phase !== 'done' || st.zeroConfirm ? ' disabled' : '') + '> ' + (v === 'keep' ? 'Keep' : 'Set to £ 0.00') + '</label>').join('');
          h += '<tr><td>' + esc(dateLabel(f.when)) + '</td><td>' + esc(f.name) + '<div class="text-muted">' + esc(f.apptStatus.replace(/-/g, ' ')) + '</div></td>' +
            '<td><a href="' + esc(U().base() + '/invoice/' + f.invoiceId) + '" target="_blank" rel="noopener">' + esc(f.invoiceNumber) + '</a></td><td class="number">' + fmt(f.amount) + '</td>' +
            '<td>' + (f.comment ? '<div class="upc-note">' + esc(f.comment) + '</div>' : '<span class="text-muted">None</span>') + '</td><td>' + pick + '</td></tr>';
        });
        h += '</tbody></table></div>';
        if (st.zeroConfirm) {
          const z = toZero();
          h += '<div class="upc-box upc-log"><b>Confirm</b><br>Set ' + z.length + ' fee' + (z.length === 1 ? '' : 's') + ' to £ 0.00: ' +
            esc(z.map((f) => dateLabel(f.when) + ' on ' + f.invoiceNumber + ' (' + fmt(f.amount) + ')').join(', ')) + '. Each fee and its funder rebate are set to £ 0.00 in its fee edit pop-up, with every other field left as it is. A fee on an invoice that has been billed to the funder is not changed.</div>';
        }
      }
      // Halaxy's original, at the left like Halaxy's own Merge Invoices: before anything has changed only.
      const nativeOk = (st.phase === 'loading' || st.phase === 'choose' || st.phase === 'error') && !st.confirm;
      h += '<div class="upc-actions">' + (nativeOk ? '<button type="button" class="btn btn-outline-primary-light upc-native-funder" data-a="native" title="Halaxy\'s own Invoice Funder: bills this invoice only, without merging">Use Halaxy\'s Invoice Funder</button>' : '') +
        '<span class="text-muted upc-version">Clinic version ' + VERSION + '</span>';
      if (st.phase === 'choose' && !st.confirm) h += '<button type="button" class="btn btn-outline-primary" data-a="close">Cancel</button><button type="button" class="btn btn-primary" data-a="next" ' + (chosen().length ? '' : 'disabled') + '>' + goLabel() + '</button>';
      else if (st.confirm) h += '<button type="button" class="btn btn-outline-primary" data-a="back">Back</button><button type="button" class="btn btn-primary" data-a="go">' + goLabel() + '</button>';
      else if (st.phase === 'running' || st.phase === 'zeroing') h += '<button type="button" class="btn btn-primary" disabled>Working...</button>';
      else if (st.phase === 'done' && st.zeroConfirm) h += '<button type="button" class="btn btn-outline-primary" data-a="zeroback">Back</button><button type="button" class="btn btn-primary" data-a="zerogo">Set ' + toZero().length + ' to £ 0.00</button>';
      else if (st.phase === 'done' && left.length) h += '<button type="button" class="btn btn-outline-primary" data-a="reload">Close and reload</button><button type="button" class="btn btn-primary" data-a="zeronext" ' + (toZero().length ? '' : 'disabled') + '>Set chosen fees to £ 0.00</button>';
      else h += '<button type="button" class="btn btn-primary" data-a="' + (st.result || st.phase === 'failed' ? 'reload' : 'close') + '">' + (st.result || st.phase === 'failed' ? 'Close and reload' : 'Close') + '</button>';
      h += '</div>';
      sh.innerHTML = h;
    }

    sh.addEventListener('change', (e) => {
      const i = e.target.dataset && e.target.dataset.i;
      if (i !== undefined && st.plan) { st.plan.fees[+i].selected = e.target.checked; render(); }
      const z = e.target.dataset && e.target.dataset.z;
      if (z !== undefined && e.target.checked) { st.zero[z] = e.target.value; render(); }
    });
    sh.addEventListener('click', async (e) => {
      const a = e.target.closest && e.target.closest('[data-a]');
      if (!a) return;
      const act = a.dataset.a;
      if (act === 'close') dlg.close();
      else if (act === 'native') { dlg.close(); openNative(); }
      else if (act === 'reload') location.reload();
      else if (act === 'next') { st.confirm = true; render(); }
      else if (act === 'back') { st.confirm = false; render(); }
      else if (act === 'zeronext') { st.zeroConfirm = true; render(); }
      else if (act === 'zeroback') { st.zeroConfirm = false; render(); }
      else if (act === 'zerogo') {
        const list = toZero();
        st.zeroConfirm = false;
        st.phase = 'zeroing';
        const say = (t, err) => { st.log.push({ t, err }); render(); };
        for (const f of list) {
          say('Setting the ' + dateLabel(f.when) + ' fee on ' + f.invoiceNumber + ' to £ 0.00...');
          try {
            await U().invoice.setLineAmount(f.invoiceId, f.lineId, 0, { lowerRebate: true });   // amount and funder rebate together
            st.zeroDone[String(f.lineId)] = { ok: true };
          } catch (err) {
            st.zeroDone[String(f.lineId)] = { ok: false, error: err.message || String(err) };
            say('Not changed: ' + (err.message || err), true);
          }
        }
        st.phase = 'done';
        render();
      }
      else if (act === 'go') {
        st.confirm = false;
        st.phase = 'running';
        const say = (t, err) => { st.log.push({ t, err }); render(); };
        render();
        try {
          st.result = await run(st.plan, chosen(), say);
          st.phase = 'done';
        } catch (err) {
          st.phase = 'failed';
          say('Stopped: ' + (err.message || err), true);
        }
        render();
      }
    });

    render();
    gather(currentId, (t) => { st.status = t; render(); })
      .then((plan) => { st.plan = plan; st.phase = 'choose'; render(); })
      .catch((err) => { st.phase = 'error'; st.error = err.message || String(err); render(); });
  }

  // ------------------------------------------------------------------ Halaxy's Invoice Funder button opens our flow

  // One button, as Halaxy draws it (Carl, 9 Nov 2026): clicking Halaxy's own Invoice Funder opens this
  // flow instead. Halaxy's original is one click away inside our pop-up ("Use Halaxy's Invoice
  // Funder"), for what this flow does not do (switching the payer, adding to an existing organisation
  // invoice). If these scripts are not loaded, the button simply works as Halaxy's.
  let nativeNext = false;
  function openNative() {
    const btn = document.getElementById('invoiceFunderBtn');
    if (!btn) return;
    nativeNext = true;
    btn.click();
  }
  function onClick(e) {
    const btn = e.target && e.target.closest && e.target.closest('#invoiceFunderBtn');
    if (!btn) return;
    if (nativeNext) { nativeNext = false; return; }   // let Halaxy's own pop-up open
    // The invoice is the one Halaxy's button bills (data-modal-href /invoicefunctions/{invoice}/claim/{claim}/),
    // whichever address the page was opened at: /invoice/{id}, or /patient/invoice/{patient}/{id} from
    // the patient's Invoices tab.
    const href = btn.getAttribute('data-modal-href') || btn.getAttribute('href') || '';
    const id = (href.match(/\/invoicefunctions\/(\d+)\//) || [])[1] || (location.pathname.match(/\/invoice\/(?:\d+\/)?(\d+)\/?$/) || [])[1];
    if (!id) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    openPanel(id);
  }

  function start() {
    if (!window.UPC) { console.error('[UPC bill funder] needs the core library'); return; }
    window.addEventListener('click', onClick, true);   // capture: before Halaxy's own handlers
    if (location.hash === '#upc-invoice-funder') autoOpen();
  }

  // Ready to bill links to an invoice with #upc-invoice-funder: open Invoice Funder once Halaxy has drawn its button.
  function autoOpen() {
    history.replaceState(null, '', location.pathname + location.search);   // a reload doesn't open it again
    const t0 = Date.now();
    const tick = () => {
      const btn = document.getElementById('invoiceFunderBtn');
      const id = btn && ((btn.getAttribute('data-modal-href') || '').match(/\/invoicefunctions\/(\d+)\//) || [])[1];
      if (id) { openPanel(id); return; }
      if (Date.now() - t0 < 10000) { setTimeout(tick, 250); return; }
      const d = window.UPC.ui.dialog({ title: 'Invoice Funder', key: 'upc-bf-auto', small: true });
      d.body.innerHTML = '<p>This invoice doesn\'t show Invoice Funder, so its fees may already have been billed to the funder.</p>' +
        '<div class="text-right"><button type="button" class="' + window.UPC.ui.btn('outline') + '" data-upc-close>Close</button></div>';
    };
    tick();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  window.upcBillFunder = { version: VERSION, gather, run, mergeCandidates, open: openPanel };
})();
