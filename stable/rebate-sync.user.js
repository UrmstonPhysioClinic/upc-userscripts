// ==UserScript==
// @name         UPC Halaxy Rebate Sync
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.2.0
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/stable/rebate-sync.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/stable/rebate-sync.user.js
// @description  Change a rebate on either the patient invoice or the funder invoice and the linked line on the other invoice follows. Runs Halaxy's own revert, edit and re-bill steps for you.
// @match        https://*.halaxy.com/a/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '0.2.0';
  const JSON_HEADERS = { Accept: 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' };
  const MONEY_FIELDS = ['form[amount]', 'form[rebate]', 'form[tax]', 'form[taxManual]'];

  const snapshots = {};      // lineId -> { fields: [[name, value]], at }
  let currentLineId = null;  // line whose edit dialog was opened last
  let passUntil = 0;         // while set, Save clicks and submits go straight to Halaxy
  let busy = false;

  // ------------------------------------------------------------------ helpers

  const group = () => (location.pathname.match(/\/a\/pr\/(\d+)\//) || [])[1];
  const base = () => '/a/pr/' + group();
  const cents = (v) => {
    const n = parseFloat(String(v === undefined || v === null ? '' : v).replace(/[£,\s]/g, ''));
    return isNaN(n) ? null : Math.round(n * 100);
  };
  const money = (c) => '£ ' + (c / 100).toFixed(2);   // as Halaxy writes it
  const plain = (c) => (c / 100).toFixed(2);
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const moneyIn = (s) => { const m = String(s || '').match(/£\s*(-?[\d,]+\.\d{2})/); return m ? cents(m[1]) : null; };
  const lastMoneyIn = (s) => { const all = String(s || '').match(/£\s*-?[\d,]+\.\d{2}/g); return all ? cents(all[all.length - 1]) : null; };

  class SyncError extends Error {}

  function serialize(form) {
    const out = [];
    Array.from(form.elements).forEach((el) => {
      if (!el.name || el.disabled) return;
      const type = (el.type || '').toLowerCase();
      if (['submit', 'button', 'file', 'reset', 'image'].includes(type)) return;
      if ((type === 'checkbox' || type === 'radio') && !el.checked) return;
      if (el.tagName === 'SELECT' && el.multiple) {
        Array.from(el.options).filter((o) => o.selected).forEach((o) => out.push([el.name, o.value]));
        return;
      }
      out.push([el.name, el.value]);
    });
    return out;
  }
  const fieldMap = (pairs) => { const m = {}; pairs.forEach(([k, v]) => { m[k] = v; }); return m; };
  const same = (name, a, b) => (MONEY_FIELDS.includes(name) ? cents(a) === cents(b) : String(a === undefined ? '' : a) === String(b === undefined ? '' : b));

  function changedFields(before, after) {
    const a = fieldMap(before);
    const b = fieldMap(after);
    const out = {};
    Object.keys(b).forEach((k) => { if (k !== 'form[_token]' && !same(k, a[k], b[k])) out[k] = b[k]; });
    return out;
  }

  async function getJson(url) {
    const sep = url.includes('?') ? '&' : '?';
    const res = await fetch(url + (/\/(edit|remove)$/.test(url) ? sep + 'clicked=' + Date.now() : ''), { credentials: 'same-origin', headers: JSON_HEADERS });
    if (!res.ok) throw new SyncError('Halaxy returned ' + res.status + ' for ' + url);
    try { return await res.json(); } catch (e) { throw new SyncError('Unexpected reply from ' + url); }
  }
  async function postForm(url, pairs) {
    const body = new URLSearchParams();
    pairs.forEach(([k, v]) => body.append(k, v));
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, JSON_HEADERS),
      body: body.toString(),
    });
    if (!res.ok) throw new SyncError('Halaxy returned ' + res.status + ' for ' + url);
    try { return await res.json(); } catch (e) { throw new SyncError('Unexpected reply from ' + url); }
  }
  function expectRefresh(json, what) {
    if (json && json.status === 'REFRESH') return;
    let detail = '';
    if (json && json.message) {
      const d = new DOMParser().parseFromString(json.message, 'text/html');
      detail = clean(Array.from(d.querySelectorAll('.text-danger, .form-error, .alert-danger')).map((e) => e.textContent).join(' '));
    }
    if (json && json.errors) detail += ' ' + clean(JSON.stringify(json.errors));
    throw new SyncError(what + ' was not accepted by Halaxy' + (detail.trim() ? ': ' + detail.trim() : '.'));
  }
  const htmlDoc = (html) => new DOMParser().parseFromString(html || '', 'text/html');

  async function fetchInvoice(id) {
    const res = await fetch(base() + '/invoice/' + id, { credentials: 'same-origin' });
    if (!res.ok) throw new SyncError('Could not open invoice ' + id + ' (' + res.status + ').');
    return parseInvoice(htmlDoc(await res.text()), id);
  }

  async function fetchLineForm(lineId) {
    const json = await getJson(base() + '/invoice/line/' + lineId + '/edit');
    const form = htmlDoc(json && json.message).querySelector('form#invoiceLineForm, form');
    if (!form) throw new SyncError('Could not read the edit form for line ' + lineId + '.');
    return serialize(form);
  }

  // ------------------------------------------------------------------ reading an invoice page

  function parseInvoice(doc, id) {
    const inv = { id: String(id), number: (clean(doc.title).match(/UPC\d+/) || [clean(doc.title)])[0], lines: [], payments: [], pending: [], total: null, outstanding: null };
    const table = doc.querySelector('#invoiceLines');
    if (table) {
      table.querySelectorAll('tr').forEach((tr) => {
        const edit = tr.querySelector('a[href*="/invoice/line/"][href*="/edit"]');
        const amountTd = tr.querySelector('td[data-property="amount"]');
        if (edit && amountTd) {
          const dateTd = tr.querySelector('td[data-property="date"]');
          const dateLink = dateTd && dateTd.querySelector('a[href]');
          const pInv = dateLink && (dateLink.getAttribute('href').match(/\/invoice\/(\d+)\/?$/) || [])[1];
          inv.lines.push({
            lineId: edit.getAttribute('href').match(/\/invoice\/line\/(\d+)\//)[1],
            date: (clean(dateTd && dateTd.textContent).match(/\d{2}-[A-Za-z]{3}-\d{4}/) || [''])[0],
            item: clean((tr.querySelector('td[data-property="itemNumber"]') || {}).textContent),
            amount: moneyIn(amountTd.textContent),
            patientInvoiceId: pInv || null,
          });
        } else if (!edit && Array.from(tr.children).some((c) => clean(c.textContent) === 'Total') && lastMoneyIn(tr.textContent) !== null) {
          inv.total = lastMoneyIn(tr.textContent);
        }
      });
    }
    const pay = doc.querySelector('#invoicePayments');
    if (pay) {
      pay.querySelectorAll('tbody tr').forEach((tr) => {
        const t = clean(tr.textContent);
        const link = Array.from(tr.querySelectorAll('a[href]')).map((a) => (a.getAttribute('href').match(/\/invoice\/(\d+)\/?$/) || [])[1]).find(Boolean);
        // Halaxy's "Invoice Funder" button: an amount reverted to the patient and waiting to be billed.
        const pend = tr.querySelector('[data-modal-href*="/invoicefunctions/"][data-modal-href*="/claim/"]');
        if (pend) inv.pending.push({ href: pend.getAttribute('data-modal-href'), amount: moneyIn(t) });
        else if (Array.from(tr.children).some((c) => clean(c.textContent) === 'Outstanding')) inv.outstanding = moneyIn(t);
        else if (link && /^Invoice\b/.test(clean(tr.querySelectorAll('td')[1] && tr.querySelectorAll('td')[1].textContent))) {
          inv.payments.push({ funderInvoiceId: link, amount: lastMoneyIn(t), status: clean(tr.querySelectorAll('td')[2] && tr.querySelectorAll('td')[2].textContent) });
        }
      });
    }
    inv.isFunder = inv.lines.some((l) => l.patientInvoiceId);
    return inv;
  }

  function currentInvoiceId() {
    // Patient invoices: /invoice/{id}. Funder invoices: /patient/invoice/{patientId}/{id}.
    const m = location.pathname.match(/\/invoice\/(?:\d+\/)?(\d+)\/?$/);
    return m ? m[1] : null;
  }

  // ------------------------------------------------------------------ working out what to do

  // Returns null when Halaxy's normal save should go ahead, or a plan for a linked update.
  async function planFor(lineId, liveFields) {
    const snap = snapshots[lineId];
    if (!snap) return null;
    const changes = changedFields(snap.fields, liveFields);
    const page = parseInvoice(document, currentInvoiceId());
    const line = page.lines.find((l) => l.lineId === lineId);
    if (!line) return null;
    const before = fieldMap(snap.fields);

    if (page.isFunder) {
      const moneyChanged = ('form[amount]' in changes) || ('form[rebate]' in changes);
      if (!moneyChanged) return null;
      const others = Object.keys(changes).filter((k) => k !== 'form[amount]' && k !== 'form[rebate]');
      if (others.length) throw new SyncError('You changed the amount and other details together. Change the amount on its own first, then the other details.');
      let newRebate;
      if ('form[amount]' in changes && 'form[rebate]' in changes && cents(changes['form[amount]']) !== cents(changes['form[rebate]'])) {
        throw new SyncError('Amount and Rebate were changed to different values. On a funder invoice the Amount is what the funder pays, so change just that.');
      }
      newRebate = cents('form[amount]' in changes ? changes['form[amount]'] : changes['form[rebate]']);
      const origFunder = cents(before['form[amount]']);
      if (!line.patientInvoiceId) throw new SyncError('Cannot see which patient invoice this line belongs to.');
      if (page.lines.filter((l) => l.patientInvoiceId === line.patientInvoiceId && l.date === line.date && l.item === line.item).length > 1) {
        throw new SyncError('This funder invoice has more than one ' + line.item + ' line for that patient on ' + line.date + ', so the script cannot tell them apart. Use the manual route for this one.');
      }
      const patient = await fetchInvoice(line.patientInvoiceId);
      const cands = patient.lines.filter((l) => l.date === line.date && l.item === line.item);
      if (cands.length !== 1) throw new SyncError(cands.length ? 'The patient invoice has more than one ' + line.item + ' line on ' + line.date + '. Use the manual route for this one.' : 'Could not find the matching line on patient invoice ' + patient.number + '.');
      const pFields = fieldMap(await fetchLineForm(cands[0].lineId));
      const origRebate = cents(pFields['form[rebate]']);
      if (origRebate !== origFunder) throw new SyncError('The two invoices already disagree (patient rebate ' + money(origRebate) + ', funder line ' + money(origFunder) + '). Sort that out manually first.');
      return {
        patient, patientLineId: cands[0].lineId, funderInvoiceId: page.id, funderNumber: page.number, funderLineId: lineId,
        date: line.date, item: line.item, origRebate, newRebate, patientAmount: cents(pFields['form[amount]']), patientOverrides: { 'form[rebate]': plain(newRebate) },
      };
    }

    // Patient invoice
    if (!('form[rebate]' in changes)) return null;
    const origRebate = cents(before['form[rebate]']);
    const newRebate = cents(changes['form[rebate]']);
    if (newRebate === null) throw new SyncError('The new rebate is not a valid amount.');
    const funderIds = Array.from(new Set(page.payments.map((p) => p.funderInvoiceId)));
    if (!funderIds.length) return null; // nothing billed to a funder: normal save
    if (page.lines.filter((l) => l.date === line.date && l.item === line.item).length > 1) {
      throw new SyncError('This invoice has more than one ' + line.item + ' line on ' + line.date + ', so the script cannot tell which funder line belongs to it. Use the manual route for this one.');
    }
    let found = [];
    let mismatched = [];
    for (const fid of funderIds) {
      const f = await fetchInvoice(fid);
      f.lines.filter((l) => l.patientInvoiceId === page.id && l.date === line.date && l.item === line.item).forEach((l) => {
        (l.amount === origRebate ? found : mismatched).push({ funder: f, line: l });
      });
    }
    if (!found.length && !mismatched.length) return null; // this line is not billed yet: normal save
    if (!found.length) throw new SyncError('The funder line for this fee shows ' + money(mismatched[0].line.amount) + ' but the rebate here is ' + money(origRebate) + '. The invoices already disagree, so sort that out manually first.');
    if (found.length > 1) throw new SyncError('More than one funder line matches this fee. Use the manual route for this one.');
    return {
      patient: page, patientLineId: lineId, funderInvoiceId: found[0].funder.id, funderNumber: found[0].funder.number, funderLineId: found[0].line.lineId,
      date: line.date, item: line.item, origRebate, newRebate,
      patientAmount: cents('form[amount]' in changes ? changes['form[amount]'] : before['form[amount]']),
      patientOverrides: changes,
    };
  }

  // ------------------------------------------------------------------ the linked update

  async function runSync(plan, say) {
    const { patientLineId, funderInvoiceId, funderLineId, origRebate, newRebate } = plan;
    const patientId = plan.patient.id;

    if (newRebate < 0) throw new SyncError('The rebate cannot be negative.');
    if (plan.patientAmount !== null && newRebate > plan.patientAmount) throw new SyncError('The rebate (' + money(newRebate) + ') cannot be more than the fee (' + money(plan.patientAmount) + ').');

    say('Checking both invoices');
    const funder = await fetchInvoice(funderInvoiceId);
    const fLine = funder.lines.find((l) => l.lineId === funderLineId);
    if (!fLine || fLine.amount !== origRebate) throw new SyncError('The funder line has changed since the page loaded. Reload and try again.');
    if (funder.total === null || funder.outstanding === null) throw new SyncError('Could not find an outstanding balance on funder invoice ' + funder.number + ' (it may already be paid), so stopped without changing anything.');
    if (funder.outstanding !== funder.total) throw new SyncError('Funder invoice ' + funder.number + ' already has a payment recorded, so it should not be changed.');
    let patient = await fetchInvoice(patientId);
    if (patient.pending.length) throw new SyncError('Patient invoice ' + patient.number + ' already has an amount waiting to be billed to a funder. Bill or clear that first.');

    // 1. Revert the funder line to the patient
    say('Reverting the funder line to the patient invoice');
    const removeJson = await getJson(base() + '/invoice/line/' + funderLineId + '/remove');
    const m = String(removeJson && removeJson.message).match(/case\s+'delete'\s*:[\s\S]*?url\s*=\s*"([^"]+)"/);
    if (!m) throw new SyncError('Could not find Halaxy\'s revert option for this line. Nothing has been changed.');
    expectRefresh(await getJson(m[1]), 'Reverting the funder line');

    patient = await fetchInvoice(patientId);
    if (patient.pending.length !== 1 || patient.pending[0].amount !== origRebate) {
      throw new SyncError('After reverting, the patient invoice does not show ' + money(origRebate) + ' waiting to bill. Check patient invoice ' + patient.number + ' and use Invoice Funder to re-bill it to ' + plan.funderNumber + '.', { cause: 'partial' });
    }

    // 2. Change the rebate on the patient line
    say('Changing the rebate to ' + money(newRebate));
    try {
      const fresh = await fetchLineForm(patientLineId);
      const ov = plan.patientOverrides;
      const names = new Set(fresh.map(([k]) => k));
      const pairs = fresh.map(([k, v]) => [k, k in ov ? ov[k] : v]);
      Object.keys(ov).forEach((k) => { if (!names.has(k)) pairs.push([k, ov[k]]); });
      expectRefresh(await postForm(base() + '/invoice/line/' + patientLineId + '/edit', pairs), 'Saving the new rebate');
    } catch (e) {
      say('Saving the rebate failed, putting the original back on ' + plan.funderNumber);
      await rebill(patientId, funderInvoiceId, origRebate).catch(() => {});
      throw e;
    }

    // 3. Re-bill to the same funder invoice
    if (newRebate > 0) {
      say('Re-billing ' + money(newRebate) + ' to ' + plan.funderNumber);
      await rebill(patientId, funderInvoiceId, newRebate);
    } else {
      say('Rebate is £0.00, so nothing to bill to the funder');
    }

    // 4. Check the result
    say('Checking the result');
    const fAfter = await fetchInvoice(funderInvoiceId);
    const pAfter = await fetchInvoice(patientId);
    const newLine = fAfter.lines.filter((l) => l.patientInvoiceId === patientId && l.date === plan.date && l.item === plan.item);
    const problems = [];
    if (newRebate > 0 && !newLine.some((l) => l.amount === newRebate)) problems.push('no ' + money(newRebate) + ' line found on ' + fAfter.number);
    if (newRebate === 0 && newLine.length) problems.push('a line for this fee is still on ' + fAfter.number);
    if (fAfter.total !== null && funder.total !== null && fAfter.total !== funder.total - origRebate + newRebate) problems.push(fAfter.number + ' total is ' + money(fAfter.total) + ', expected ' + money(funder.total - origRebate + newRebate));
    if (pAfter.pending.length) problems.push(pAfter.number + ' still has an amount waiting to bill');
    if (problems.length) throw new SyncError('Changes were made but the result looks wrong: ' + problems.join('; ') + '.');
    return { funderTotal: fAfter.total, patientOutstanding: pAfter.outstanding, patientNumber: pAfter.number, funderNumber: fAfter.number };
  }

  async function rebill(patientId, funderInvoiceId, expected) {
    const p = await fetchInvoice(patientId);
    if (p.pending.length !== 1) throw new SyncError('Expected one amount waiting to bill on ' + p.number + ', found ' + p.pending.length + '. Use Invoice Funder on the patient invoice to finish.');
    if (p.pending[0].amount !== expected) throw new SyncError('Amount waiting to bill is ' + money(p.pending[0].amount) + ', expected ' + money(expected) + '. Use Invoice Funder on the patient invoice to finish.');
    const href = p.pending[0].href.split('?')[0];
    const dlg = await getJson(href);
    const opt = htmlDoc(dlg && dlg.message).querySelector('input[name="form[orgInvoice]"][value="' + funderInvoiceId + '"]');
    if (!opt) throw new SyncError('Halaxy did not offer the original funder invoice when re-billing. Use Invoice Funder on ' + p.number + ' to finish.');
    expectRefresh(await postForm(href, [['form[orgInvoice]', funderInvoiceId]]), 'Re-billing to the funder');
  }

  // ------------------------------------------------------------------ dialog

  // A Halaxy-style pop-up (core library), shown above Halaxy's fee edit pop-up it starts from.
  function showDialog(onDismiss) {
    let closable = true;
    const dlg = window.UPC.ui.dialog({ title: '', small: true, above: true, canClose: () => closable, onClose: () => { if (onDismiss) onDismiss(); } });
    dlg.body.innerHTML = '<div class="upc-body"></div><div class="upc-actions"></div>';
    const el = (q) => dlg.body.querySelector(q);
    return {
      title(t) { dlg.setTitle(t); },
      body(html) { el('.upc-body').innerHTML = html; },
      buttons(list) {
        const b = el('.upc-actions');
        b.innerHTML = '';
        closable = list.length > 0;   // no buttons means it is working: keep it open
        list.forEach(([label, fn, primary]) => {
          const x = document.createElement('button');
          x.type = 'button';
          x.textContent = label;
          x.className = primary ? 'btn btn-primary' : 'btn btn-outline-primary';
          x.addEventListener('click', fn);
          b.appendChild(x);
        });
      },
      close() { onDismiss = null; closable = true; dlg.close(); },
    };
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function confirmPlan(plan) {
    return new Promise((resolve) => {
      const d = showDialog(() => resolve(false));
      const diff = plan.origRebate - plan.newRebate;
      d.title('Update both invoices?');
      d.body(`
        <div class="text-muted">${esc(plan.date)} · ${esc(plan.item)}</div>
        <table class="table w-100">
          <tr><td>Rebate on patient invoice ${esc(plan.patient.number)}</td><td class="number">${money(plan.origRebate)} → <b>${money(plan.newRebate)}</b></td></tr>
          <tr><td>Line on funder invoice ${esc(plan.funderNumber)}</td><td class="number">${money(plan.origRebate)} → <b>${plan.newRebate ? money(plan.newRebate) : 'removed'}</b></td></tr>
          <tr><td>${diff >= 0 ? 'Patient pays more' : 'Patient pays less'}</td><td class="number"><b>${money(Math.abs(diff))}</b></td></tr>
        </table>
        <div class="text-muted">Done with Halaxy's own steps: revert the funder line, change the rebate, re-bill to ${esc(plan.funderNumber)}. The funder line on the patient's payment list will show today's date.</div>`);
      d.buttons([['Cancel', () => { d.close(); resolve(false); }], ['Update both', () => { d.close(); resolve(true); }, true]]);
    });
  }

  function message(title, html) {
    const d = showDialog();
    d.title(title);
    d.body(html);
    d.buttons([['OK', () => d.close(), true]]);
  }

  async function doSync(plan) {
    const d = showDialog();
    d.title('Updating both invoices');
    const steps = [];
    const render = (extra) => d.body('<ol>' + steps.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ol>' + (extra || ''));
    d.buttons([]);
    render();
    try {
      const r = await runSync(plan, (s) => { steps.push(s); render(); });
      render(`<p class="upc-ok upc-gap">Done. ${esc(r.funderNumber)} total is now ${r.funderTotal !== null ? money(r.funderTotal) : 'updated'}${r.patientOutstanding !== null ? ', and ' + esc(r.patientNumber) + ' shows ' + money(r.patientOutstanding) + ' outstanding' : ''}.</p>`);
      d.buttons([['Reload', () => location.reload(), true]]);
      setTimeout(() => location.reload(), 2500);
    } catch (e) {
      render(`<p class="upc-err upc-gap">${esc(e.message || e)}</p>`);
      d.buttons([['Reload', () => location.reload(), true]]);
    } finally {
      busy = false;
    }
  }

  // ------------------------------------------------------------------ hooks

  // Remember each line's values exactly as Halaxy sent them when the edit dialog opened.
  const XO = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    const m = String(method).toUpperCase() === 'GET' && String(url).match(/\/invoice\/line\/(\d+)\/edit(?:\?|$)/);
    if (m) {
      const lineId = m[1];
      this.addEventListener('load', () => {
        try {
          const json = JSON.parse(this.responseText);
          const form = htmlDoc(json.message).querySelector('form#invoiceLineForm, form');
          if (form) { snapshots[lineId] = { fields: serialize(form), at: Date.now() }; currentLineId = lineId; }
        } catch (e) { /* not a form reply */ }
      });
    }
    return XO.apply(this, arguments);
  };

  function liveForm() {
    const forms = Array.from(document.querySelectorAll('form#invoiceLineForm'));
    return forms.find((f) => f.offsetParent !== null) || forms[forms.length - 1] || null;
  }

  async function onSave(e, btn) {
    if (Date.now() < passUntil) return;
    const form = liveForm();
    const lineId = currentLineId;
    if (!form || !lineId || !snapshots[lineId]) return;
    const live = serialize(form);
    if (fieldMap(live)['form[feeItemNumber]'] !== fieldMap(snapshots[lineId].fields)['form[feeItemNumber]']) return;

    e.preventDefault();
    e.stopImmediatePropagation();
    if (busy) return;
    busy = true;
    btn.disabled = true;
    let plan = null;
    try {
      plan = await planFor(lineId, live);
    } catch (err) {
      btn.disabled = false;
      busy = false;
      message('Not saved', '<p>' + esc(err.message || err) + '</p><p class="text-muted">Nothing has been changed. Cancel the edit dialog or adjust it.</p>');
      return;
    }
    btn.disabled = false;
    if (!plan || plan.newRebate === plan.origRebate) {
      busy = false;
      passUntil = Date.now() + 1500;
      btn.click();
      return;
    }
    const ok = await confirmPlan(plan);
    if (!ok) { busy = false; return; }
    doSync(plan);
  }

  window.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('#invoiceLineSaveBtn');
    if (btn) onSave(e, btn);
  }, true);

  window.addEventListener('submit', (e) => {
    if (e.target && e.target.id === 'invoiceLineForm' && Date.now() >= passUntil) {
      const btn = e.target.querySelector('#invoiceLineSaveBtn');
      if (btn) { e.preventDefault(); e.stopImmediatePropagation(); btn.click(); }
    }
  }, true);

  window.UPCRebateSync = { version: VERSION };
})();
