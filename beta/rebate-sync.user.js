// ==UserScript==
// @name         UPC Billing: Rebate sync (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.3.2
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/rebate-sync.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/rebate-sync.user.js
// @description  Change a rebate on either the patient invoice or the funder invoice and the linked line on the other invoice follows. Runs Halaxy's own revert, edit and re-bill steps for you.
// @match        https://*.halaxy.com/a/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '0.3.2';
  const MONEY_FIELDS = ['form[amount]', 'form[rebate]', 'form[tax]', 'form[taxManual]'];

  const snapshots = {};      // lineId -> { fields: [[name, value]], at }
  let currentLineId = null;  // line whose edit dialog was opened last
  let passUntil = 0;         // while set, Save clicks and submits go straight to Halaxy
  let busy = false;

  // Requests, invoice reading and the revert / rebate / re-bill steps all come from the core library (UPC), so they are
  // paced like every other script's and work the same way as Remittances'.
  const U = () => window.UPC;
  const cents = (v) => {
    const n = parseFloat(String(v === undefined || v === null ? '' : v).replace(/[£,\s]/g, ''));
    return isNaN(n) ? null : Math.round(n * 100);
  };
  const money = (c) => U().money.fmt(c);   // as Halaxy writes it
  const htmlDoc = (html) => new DOMParser().parseFromString(html || '', 'text/html');
  const serialize = (form) => U().http.serialize(form);

  class SyncError extends Error {}

  const fieldMap = (pairs) => { const m = {}; pairs.forEach(([k, v]) => { m[k] = v; }); return m; };
  const same = (name, a, b) => (MONEY_FIELDS.includes(name) ? cents(a) === cents(b) : String(a === undefined ? '' : a) === String(b === undefined ? '' : b));

  function changedFields(before, after) {
    const a = fieldMap(before);
    const b = fieldMap(after);
    const out = {};
    Object.keys(b).forEach((k) => { if (k !== 'form[_token]' && !same(k, a[k], b[k])) out[k] = b[k]; });
    return out;
  }

  function currentInvoiceId() {
    // Patient invoices: /invoice/{id}. Funder invoices: /patient/invoice/{patientId}/{id}.
    const m = location.pathname.match(/\/invoice\/(?:\d+\/)?(\d+)\/?$/);
    return m ? m[1] : null;
  }

  // ------------------------------------------------------------------ working out what to do

  // Returns null when Halaxy's normal save should go ahead, or a plan (core UPC.rebate.plan) for a linked update.
  async function planFor(lineId, liveFields) {
    const snap = snapshots[lineId];
    if (!snap) return null;
    const changes = changedFields(snap.fields, liveFields);
    const page = U().invoice.parse(document, currentInvoiceId());
    const line = page.lines.find((l) => l.lineId === lineId);
    if (!line) return null;
    const before = fieldMap(snap.fields);

    if (page.isFunder) {
      const moneyChanged = ('form[amount]' in changes) || ('form[rebate]' in changes);
      if (!moneyChanged) return null;
      const others = Object.keys(changes).filter((k) => k !== 'form[amount]' && k !== 'form[rebate]');
      if (others.length) throw new SyncError('You changed the amount and other details together. Change the amount on its own first, then the other details.');
      if ('form[amount]' in changes && 'form[rebate]' in changes && cents(changes['form[amount]']) !== cents(changes['form[rebate]'])) {
        throw new SyncError('Amount and Rebate were changed to different values. On a funder invoice the Amount is what the funder pays, so change just that.');
      }
      const newRebate = cents('form[amount]' in changes ? changes['form[amount]'] : changes['form[rebate]']);
      return U().rebate.plan(page.id, lineId, newRebate);
    }

    // Patient invoice: find the funder line this fee was billed as.
    if (!('form[rebate]' in changes)) return null;
    const origRebate = cents(before['form[rebate]']);
    const newRebate = cents(changes['form[rebate]']);
    if (newRebate === null) throw new SyncError('The new rebate is not a valid amount.');
    const funderIds = Array.from(new Set(page.payments.map((p) => p.funderInvoiceId)));
    if (!funderIds.length) return null; // nothing billed to a funder: normal save
    if (page.lines.filter((l) => l.date === line.date && l.item === line.item).length > 1) {
      throw new SyncError('This invoice has more than one ' + line.item + ' line on ' + line.date + ', so the script cannot tell which funder line belongs to it. Use the manual route for this one.');
    }
    const found = [];
    const mismatched = [];
    for (const fid of funderIds) {
      const f = await U().invoice.fetch(fid);
      f.lines.filter((l) => l.patientInvoiceId === page.id && l.date === line.date && l.item === line.item).forEach((l) => {
        (l.amount === origRebate ? found : mismatched).push({ funder: f, line: l });
      });
    }
    if (!found.length && !mismatched.length) return null; // this line is not billed yet: normal save
    if (!found.length) throw new SyncError('The funder line for this fee shows ' + money(mismatched[0].line.amount) + ' but the rebate here is ' + money(origRebate) + '. The invoices already disagree, so sort that out manually first.');
    if (found.length > 1) throw new SyncError('More than one funder line matches this fee. Use the manual route for this one.');
    const overrides = Object.assign({}, changes);
    delete overrides['form[rebate]'];
    const fee = cents('form[amount]' in changes ? changes['form[amount]'] : before['form[amount]']);
    return U().rebate.plan(found[0].funder.id, found[0].line.lineId, newRebate, { overrides, fee });
  }

  // ------------------------------------------------------------------ dialog

  // A Halaxy-style pop-up (core library), shown above Halaxy's fee edit pop-up it starts from.
  function showDialog(onDismiss) {
    let closable = true;
    const dlg = U().ui.dialog({ title: '', small: true, above: true, canClose: () => closable, onClose: () => { if (onDismiss) onDismiss(); } });
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

  const esc = (s) => U().esc(s);

  function confirmPlan(plan) {
    return new Promise((resolve) => {
      const d = showDialog(() => resolve(false));
      const diff = plan.origRebate - plan.newRebate;
      d.title('Update both invoices?');
      d.body(`
        <div class="text-muted">${esc(plan.date)} · ${esc(plan.item)}</div>
        <table class="table w-100">
          <tr><td>Rebate on patient invoice ${esc(plan.patientNumber)}</td><td class="number">${money(plan.origRebate)} → <b>${money(plan.newRebate)}</b></td></tr>
          <tr><td>Line on funder invoice ${esc(plan.funderNumber)}</td><td class="number">${money(plan.origRebate)} → <b>${money(plan.newRebate)}</b></td></tr>
          <tr><td>${diff >= 0 ? 'Patient pays more' : 'Patient pays less'}</td><td class="number"><b>${money(Math.abs(diff))}</b></td></tr>
        </table>
        <div class="text-muted">Done with Halaxy's own steps: revert the funder line, change the rebate, re-bill to ${esc(plan.funderNumber)} (a £ 0.00 line if the rebate is £ 0.00), and put the fee's date back on the re-billed line.</div>`);
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
      const r = await U().rebate.apply(plan, (s) => { steps.push(s); render(); });
      render(`<p class="upc-ok upc-gap">Done. ${esc(plan.funderNumber)} total is now ${r.funderTotal !== null ? money(r.funderTotal) : 'updated'}${r.patientOutstanding !== null ? ', and ' + esc(plan.patientNumber) + ' shows ' + money(r.patientOutstanding) + ' outstanding' : ''}.</p>`);
      d.buttons([['Reload', () => location.reload(), true]]);
      setTimeout(() => location.reload(), 2500);
    } catch (e) {
      render(`<p class="upc-err upc-gap">${esc(e.message || e)}</p>`);
      d.buttons([['Reload', () => location.reload(), true]]);
      // A task for Carl to look at why it failed (Carl, 12 Nov 2026). The core library has already put it back as it
      // was if it could; the message says which.
      try {
        const d0 = new Date(), due = String(d0.getDate()).padStart(2, '0') + '-' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d0.getMonth()] + '-' + d0.getFullYear();
        await U().tasks.addToInvoice(plan.funderInvoiceId, {
          title: 'Rebate sync stopped on ' + plan.funderNumber + ': please check', assignee: 'Carl Healy', priority: 3, due, by: 'Rebate sync',
          comment: ['Changing the ' + plan.date + ' fee from ' + money(plan.origRebate) + ' to ' + money(plan.newRebate) + ' (patient invoice ' + plan.patientNumber + ') stopped: ' + (e.message || e),
            e.undone === false ? 'It could NOT all be put back: check both invoices.' : 'Everything was put back as it was.'],
        });
        steps.push('Task added for Carl Healy on ' + plan.funderNumber + '.');
        render(`<p class="upc-err upc-gap">${esc(e.message || e)}</p>`);
      } catch (te) { /* the error is on screen */ }
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
