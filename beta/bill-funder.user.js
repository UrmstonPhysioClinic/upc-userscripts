// ==UserScript==
// @name         Halaxy bill funder (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.2.0
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

  const VERSION = '0.2.0';
  const MAX_AGE_DAYS = 183;   // about 6 months
  const NOT_ATTENDED = /cancel|did-not-attend|dna|reject|declin|reschedul/i;
  const DAY = 86400e3;

  const U = () => window.UPC;
  const fmt = (c) => U().money.fmt(c);
  const esc = (s) => U().esc(s);
  const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  function parseDate(s) {   // '2026-08-27T09:00:00+01:00' or '05-Sep-2026 09:00'
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return new Date(s).getTime();
    const m = String(s).match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
    return m ? new Date(+m[3], MONTHS[m[2].toLowerCase()], +m[1]).getTime() : null;
  }
  const dateLabel = (t) => (t ? new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

  // ------------------------------------------------------------------ reading Halaxy

  // The merge pop-up embeds the patient's fees on other invoices as JSON inside a script.
  function mergeCandidates(popupJson) {
    const html = String(popupJson && popupJson.message || '');
    const m = html.match(/allInvoiceGroupEditGridData\s*=\s*JSON\.parse\('([\s\S]*?)'\)/);
    if (!m) throw new U().Error('Halaxy\'s merge pop-up has changed, so nothing was done.');
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
    if (!current.billFunderHref || !current.claimId) throw new U().Error('This invoice has no Invoice Funder button, so there is nothing to bill from here.');
    if (!current.patientId) throw new U().Error('Could not tell which patient this invoice is for.');
    say('Finding this patient\'s other fees...');
    const popup = await U().http.popup('/invoice/' + currentId + '/group');
    const others = mergeCandidates(popup.json);

    // One entry per invoice (current plus each invoice in the merge list).
    const ids = [String(currentId), ...new Set(others.map((r) => String(r.invoiceId)))].filter((v, i, a) => a.indexOf(v) === i);
    const today = startOfToday();
    const cutoff = today - MAX_AGE_DAYS * DAY;
    const fees = [];
    const skipped = { future: 0, old: 0, otherClaim: 0, billed: 0, issued: 0 };
    for (let i = 0; i < ids.length; i++) {
      say('Checking invoice ' + (i + 1) + ' of ' + ids.length + '...');
      const inv = String(ids[i]) === String(currentId) ? current : await U().invoice.fetch(ids[i]);
      let status = '';
      try { status = await U().invoice.status(inv.id); } catch (e) { status = inv.issued ? 'issued' : ''; }
      if (status) { skipped.issued += inv.lines.length; continue; }   // Issued, or anything other than Active
      if (inv.claimId !== current.claimId) { skipped.otherClaim += inv.lines.length; continue; }
      if (!inv.billFunderHref) { skipped.billed += inv.lines.length; continue; }
      inv.lines.forEach((l) => {
        const row = others.find((r) => String(r.invoiceLineId) === String(l.lineId));
        const when = parseDate(row ? row.invoiceLineDate : l.date);
        if (when === null || when >= today + DAY) { skipped.future++; return; }
        if (when < cutoff) { skipped.old++; return; }
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
    }
    fees.sort((a, b) => a.when - b.when);
    return { current, fees, skipped };
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
    throw new U().Error('Every chosen invoice also holds a fee you did not choose, so there is nowhere safe to merge them. Nothing was changed. Tick those fees too, or merge by hand.');
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
      if (missing.length) throw new U().Error('Halaxy no longer offers some of the chosen fees for merging. Nothing was changed. Reload and try again.');
      const pairs = [['form[type]', '1'], ['form[hasUnpaidInvoices]', '1']].concat(toMove.map((id) => ['form[il][]', id]));
      U().http.expectRefresh(await U().http.postForm('/invoice/' + targetId + '/group', pairs), 'Merging the fees');
    }

    // 2. Check the merged invoice.
    say('Checking ' + target.invoiceNumber + '...');
    const merged = await U().invoice.fetch(targetId);
    const have = merged.lines.map((l) => String(l.lineId)).sort();
    const extra = have.filter((id) => !expectLines.includes(id));
    const lacking = expectLines.filter((id) => !have.includes(id));
    if (lacking.length) throw new U().Error('After merging, ' + merged.number + ' is missing ' + lacking.length + ' of the chosen fees. The funder has not been invoiced. Check the invoice.');
    if (extra.length) throw new U().Error(merged.number + ' also has fees you did not choose. The funder has not been invoiced. Check the invoice.');
    if (merged.total !== null && merged.total !== expectTotal) throw new U().Error(merged.number + ' totals ' + fmt(merged.total) + ', expected ' + fmt(expectTotal) + '. The funder has not been invoiced. Check the invoice.');
    if (!merged.billFunderHref || merged.claimId !== plan.current.claimId) throw new U().Error(merged.number + ' no longer shows Invoice Funder for this claim. The funder has not been invoiced.');

    // 3. Invoice Funder once, as a new organisation invoice, keeping the patient invoice.
    say('Invoicing ' + (plan.current.funderName || 'the funder') + ' from ' + merged.number + ' (new organisation invoice)...');
    const bill = await U().http.popup(merged.billFunderHref);
    const form = bill.doc.querySelector('form#organisationBillForm');
    if (!form || !form.querySelector('input[name="form[orgInvoice]"][value="0"]') || !form.querySelector('input[name="form[switchPayer]"][value="no"]')) {
      throw new U().Error('Halaxy\'s Invoice Funder pop-up has changed, so the funder was not invoiced. The fees are merged on ' + merged.number + '; use Invoice Funder there by hand.');
    }
    U().http.expectRefresh(await U().http.postForm(merged.billFunderHref, [['form[switchPayer]', 'no'], ['form[orgInvoice]', '0']]), 'Invoicing the funder');

    // 4. Check.
    const after = await U().invoice.fetch(targetId);
    const org = after.payments.find((p) => p.funderInvoiceId);
    if (after.billFunderHref || !org) throw new U().Error('Halaxy accepted the request, but ' + after.number + ' does not show an organisation invoice. Check it.');
    let orgNumber = '';
    try { orgNumber = (await U().invoice.fetch(org.funderInvoiceId)).number; } catch (e) { /* link still works */ }

    // 5. Mark the patient invoice Issued.
    say('Marking ' + after.number + ' as Issued...');
    let issuedError = '';
    try { await U().invoice.setStatus(targetId, 'issued'); } catch (e) { issuedError = e.message || String(e); }
    return { patientInvoiceId: targetId, patientInvoiceNumber: after.number, orgInvoiceId: org.funderInvoiceId, orgInvoiceNumber: orgNumber, amount: org.amount, issuedError };
  }

  // ------------------------------------------------------------------ panel

  const CSS = `
    .bg { position: fixed; inset: 0; background: rgba(20,24,35,.45); display: flex; align-items: center; justify-content: center; z-index: 2147483000; }
    .d { font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Arial, sans-serif; color: #1d2433; background: #fff; border-radius: 10px;
         box-shadow: 0 12px 40px rgba(0,0,0,.25); width: min(900px, calc(100vw - 32px)); max-height: calc(100vh - 48px); overflow: auto; padding: 20px; }
    h2 { font-size: 17px; margin: 0 0 4px; }
    .muted { color: #5b6478; font-size: 12.5px; }
    table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e6e8ef; vertical-align: top; }
    th { font-size: 12px; color: #5b6478; font-weight: 600; }
    td.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    tr.off td { color: #6b7280; }
    .warn { color: #9a3412; font-size: 12px; }
    .cmt { font-size: 12px; background: #fff8db; border-radius: 4px; padding: 2px 6px; margin-top: 3px; }
    .sum { font-weight: 600; margin: 8px 0; }
    .log { font-size: 12.5px; background: #f6f7fa; border-radius: 6px; padding: 8px 12px; margin-top: 10px; }
    .log .err { color: #b3261e; } .ok { color: #1e7a3c; font-weight: 600; }
    .btns { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; margin-top: 14px; }
    button { font: inherit; border-radius: 6px; padding: 7px 14px; cursor: pointer; border: 1px solid #c9cfdc; background: #fff; color: #1d2433; }
    button.p { background: #1d4ed8; border-color: #1d4ed8; color: #fff; }
    button[disabled] { opacity: .5; cursor: default; }
    a { color: #1d4ed8; }
  `;

  function openPanel(currentId) {
    if (document.querySelector('[data-upc-bill-funder]')) return;
    const host = document.createElement('div');
    host.setAttribute('data-upc-bill-funder', '');
    const sh = host.attachShadow({ mode: 'open' });
    document.body.appendChild(host);
    const st = { phase: 'loading', status: 'Reading...', plan: null, log: [], result: null, error: '', confirm: false };
    const chosen = () => (st.plan ? st.plan.fees.filter((f) => f.selected) : []);

    function render() {
      const p = st.plan;
      let h = '<style>' + CSS + '</style><div class="bg"><div class="d" role="dialog" aria-label="Bill funder"><h2>Bill funder' + (p && p.current.funderName ? ': ' + esc(p.current.funderName) : '') + '</h2>' +
        '<div class="muted">Merges the chosen fees onto one invoice, then invoices the funder once, so the patient\'s excess is charged once. Halaxy\'s own steps; nothing changes until you confirm.</div>';
      if (st.phase === 'loading') h += '<p>' + esc(st.status) + '</p>';
      if (st.error) h += '<p class="warn">' + esc(st.error) + '</p>';
      if (p && st.phase !== 'loading') {
        if (!p.fees.length) h += '<p>No unbilled fees for this claim, dated today or earlier in the last 6 months.</p>';
        else {
          h += '<table><thead><tr><th></th><th>Date</th><th>Fee</th><th>Invoice</th><th class="n">Amount</th><th>Notes</th></tr></thead><tbody>';
          p.fees.forEach((f, i) => {
            const notes = [];
            if (f.notAttended) notes.push('<span class="warn">' + esc(f.apptStatus.replace(/-/g, ' ')) + ': not ticked, include only if you mean to bill it</span>');
            if (!f.amount) notes.push('<span class="muted">£0 fee: not ticked</span>');
            if (f.referral) notes.push((f.beyondAuth ? '<span class="warn">' : '<span class="muted">') + 'Appointment ' + f.referral.position + ' of ' + f.referral.limit + ' authorised' + (f.beyondAuth ? ': beyond the authorisation' : '') + '</span>');
            if (f.comment) notes.push('<div class="cmt">' + esc(f.comment) + '</div>');
            h += '<tr class="' + (f.selected ? '' : 'off') + '"><td><input type="checkbox" data-i="' + i + '" ' + (f.selected ? 'checked' : '') + (st.phase !== 'choose' ? ' disabled' : '') + ' aria-label="Include ' + esc(dateLabel(f.when)) + '"></td>' +
              '<td>' + esc(dateLabel(f.when)) + '</td><td>' + esc(f.name) + (f.practitioner ? '<div class="muted">' + esc(f.practitioner) + '</div>' : '') + '</td>' +
              '<td><a href="' + esc(U().base() + '/invoice/' + f.invoiceId) + '" target="_blank" rel="noopener">' + esc(f.invoiceNumber) + '</a></td><td class="n">' + fmt(f.amount) + '</td><td>' + notes.join('<br>') + '</td></tr>';
          });
          h += '</tbody></table>';
          const c = chosen();
          h += '<div class="sum">' + c.length + ' fee' + (c.length === 1 ? '' : 's') + ' chosen, total ' + fmt(c.reduce((s, f) => s + f.amount, 0)) + '.</div>';
          if (c.some((f) => f.beyondAuth)) h += '<p class="warn">Some chosen fees are beyond the authorisation. The insurer may not pay them.</p>';
        }
        const sk = p.skipped;
        const skipped = [[sk.future, 'future-dated'], [sk.old, 'older than 6 months'], [sk.billed, 'already billed'], [sk.issued, 'on Issued invoices'], [sk.otherClaim, 'for another claim or self-funded']]
          .filter(([n]) => n).map(([n, w]) => n + ' ' + w);
        if (skipped.length) h += '<div class="muted">Not shown: ' + esc(skipped.join(', ')) + '.</div>';
      }
      if (st.confirm) {
        const c = chosen();
        h += '<div class="log"><b>Confirm</b><br>Merge ' + c.length + ' fee' + (c.length === 1 ? '' : 's') + ' (' + fmt(c.reduce((s, f) => s + f.amount, 0)) + ') onto the latest of their invoices, then invoice ' + esc(p.current.funderName || 'the funder') +
          ' once as a new organisation invoice, keeping the patient invoice, and mark that patient invoice Issued. Fees on invoices emptied by the merge are moved and those invoices are deleted by Halaxy, as its merge does.</div>';
      }
      if (st.log.length) h += '<div class="log">' + st.log.map((l) => '<div class="' + (l.err ? 'err' : '') + '">' + esc(l.t) + '</div>').join('') + '</div>';
      if (st.result) {
        const r = st.result;
        h += '<p class="ok">Done. ' + esc(r.patientInvoiceNumber) + ' is billed to the funder on <a href="' + esc(U().base() + '/invoice/' + r.orgInvoiceId) + '" target="_blank" rel="noopener">' + esc(r.orgInvoiceNumber || 'the new organisation invoice') + '</a>' + (r.amount !== null && r.amount !== undefined ? ' (' + fmt(r.amount) + ')' : '') +
          (r.issuedError ? '.</p><p class="warn">Billing is done, but ' + esc(r.patientInvoiceNumber) + ' could not be marked Issued (' + esc(r.issuedError) + '). Set it with the cogwheel.</p>' : ', and ' + esc(r.patientInvoiceNumber) + ' is marked Issued.</p>');
      }
      h += '<div class="btns">';
      if (st.phase === 'choose' && !st.confirm) h += '<button data-a="close">Cancel</button><button class="p" data-a="next" ' + (chosen().length ? '' : 'disabled') + '>Merge and bill</button>';
      else if (st.confirm) h += '<button data-a="back">Back</button><button class="p" data-a="go">Merge and bill</button>';
      else if (st.phase === 'running') h += '<button disabled>Working...</button>';
      else h += '<button class="p" data-a="' + (st.result || st.phase === 'failed' ? 'reload' : 'close') + '">' + (st.result || st.phase === 'failed' ? 'Close and reload' : 'Close') + '</button>';
      h += '</div><div class="muted" style="margin-top:8px">Bill funder ' + VERSION + '</div></div></div>';
      sh.innerHTML = h;
    }

    sh.addEventListener('change', (e) => {
      const i = e.target.dataset && e.target.dataset.i;
      if (i !== undefined && st.plan) { st.plan.fees[+i].selected = e.target.checked; render(); }
    });
    sh.addEventListener('click', async (e) => {
      const a = e.target.closest && e.target.closest('[data-a]');
      if (!a) return;
      const act = a.dataset.a;
      if (act === 'close') host.remove();
      else if (act === 'reload') location.reload();
      else if (act === 'next') { st.confirm = true; render(); }
      else if (act === 'back') { st.confirm = false; render(); }
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

  // ------------------------------------------------------------------ button next to Invoice Funder

  function addButton() {
    const halaxyBtn = document.getElementById('invoiceFunderBtn');
    const id = (location.pathname.match(/\/invoice\/(\d+)\/?$/) || [])[1];
    if (!halaxyBtn || !id || document.getElementById('upcBillFunderBtn')) return;
    const b = document.createElement('a');
    b.id = 'upcBillFunderBtn';
    b.href = '#';
    b.className = 'btn btn-primary ml-1';
    b.textContent = 'Bill funder';
    b.title = 'Merge this patient\'s unbilled fees for this claim onto one invoice, then invoice the funder once';
    b.addEventListener('click', (e) => { e.preventDefault(); openPanel(id); });
    halaxyBtn.after(b);
  }

  function start() {
    if (!window.UPC) { console.error('[UPC bill funder] needs the core library'); return; }
    addButton();
    new MutationObserver(addButton).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  window.upcBillFunder = { version: VERSION, gather, run, mergeCandidates, open: openPanel };
})();
