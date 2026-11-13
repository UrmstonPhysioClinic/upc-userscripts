// ==UserScript==
// @name         UPC System: Core library (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.1.42
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/core.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/core.user.js
// @description  Shared helpers for the clinic's Halaxy scripts (window.UPC). Does nothing on its own.
// @match        https://*.halaxy.com/a/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

/*
 * window.UPC: helpers other scripts use, so each feature doesn't carry its own copy.
 * Loaded by the loader straight after the health check, before every other script.
 *
 *   UPC.money      parse and format pounds (amounts are handled in pence)
 *   UPC.http       Halaxy requests: JSON, HTML pages, pop-up forms, list grids
 *   UPC.invoice    read an invoice page; find an invoice by its number (UPC-12345)
 *   UPC.rebate     move part of a funder line back to the patient (revert, new rebate, re-bill)
 *   UPC.files      attach a file to an invoice
 *   UPC.load       load a library from a CDN once
 *   UPC.ui         Halaxy side menu item and a page inside Halaxy's layout
 *
 * Writes follow the repository rule: they drive Halaxy's own pop-ups (GET the form, read its
 * token, POST), check every step, and the calling script asks the user before starting.
 */

(function () {
  'use strict';
  if (window.UPC) return;

  const VERSION = '0.1.42';
  const JSON_HEADERS = { Accept: 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' };

  class UPCError extends Error {}

  const pg = () => (location.pathname.match(/\/a\/pr\/(\d+)\//) || [])[1];
  const base = () => '/a/pr/' + pg();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const htmlDoc = (html) => new DOMParser().parseFromString(html || '', 'text/html');
  // Whole days between two Halaxy dates ('13-Oct-2026'); Infinity if either can't be read.
  const MONTH_NO = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const halaxyDay = (s) => { const m = String(s || '').match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/); return m && m[2].toLowerCase() in MONTH_NO ? Date.UTC(+m[3], MONTH_NO[m[2].toLowerCase()], +m[1]) : null; };
  const dayGap = (a, b) => { const x = halaxyDay(a), y = halaxyDay(b); return x === null || y === null ? Infinity : Math.round(Math.abs(x - y) / 86400e3); };

  // ------------------------------------------------------------------ money (pence)

  const money = {
    cents(v) {
      const n = parseFloat(String(v === undefined || v === null ? '' : v).replace(/[£,\s]/g, ''));
      return isNaN(n) ? null : Math.round(n * 100);
    },
    // As Halaxy writes amounts: £ 40.00 (and -£ 5.00).
    fmt: (c) => (c === null || c === undefined ? '' : (c < 0 ? '-£ ' : '£ ') + (Math.abs(c) / 100).toFixed(2)),
    plain: (c) => (c / 100).toFixed(2),
    inText(s) { const m = String(s || '').match(/£\s*(-?[\d,]+\.\d{2})/); return m ? money.cents(m[1]) : null; },
    lastInText(s) { const all = String(s || '').match(/£\s*-?[\d,]+\.\d{2}/g); return all ? money.cents(all[all.length - 1]) : null; },
  };

  // ------------------------------------------------------------------ pacing (be a polite Halaxy user)
  //
  // Every request our scripts make goes through pace(): one at a time per tab, a short gap between
  // them, and a cap per minute shared by all Halaxy tabs on this PC. If Halaxy says it is busy
  // (429, 502, 503, 504), every script on this PC pauses for a few minutes. Halaxy's own requests
  // are not affected. Requests carry nothing extra, so they look like Halaxy's own.

  const PACE = { gapMs: 300, perMinute: 45, pauseMs: 3 * 60e3 };
  const PACE_KEY = 'upc-pace:';
  const store = {
    get(k, d) { try { const v = localStorage.getItem(PACE_KEY + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(PACE_KEY + k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
  };
  let chain = Promise.resolve();
  let lastAt = 0;

  const pausedFor = () => Math.max(0, store.get('pausedUntil', 0) - Date.now());

  function pace() {
    const turn = chain.then(async () => {
      for (;;) {
        const wait = pausedFor();
        if (wait) { await sleep(Math.min(wait, 5000)); continue; }
        const now = Date.now();
        const recent = store.get('recent', []).filter((t) => now - t < 60e3);
        if (recent.length >= PACE.perMinute) { await sleep(60e3 - (now - recent[0]) + 50); continue; }
        const gap = PACE.gapMs - (now - lastAt);
        if (gap > 0) { await sleep(gap); continue; }
        recent.push(now);
        store.set('recent', recent);
        lastAt = now;
        return;
      }
    });
    chain = turn.catch(() => {});
    return turn;
  }

  function noteStatus(res) {
    if ([429, 502, 503, 504].includes(res.status)) {
      store.set('pausedUntil', Date.now() + PACE.pauseMs);
      console.warn('[UPC] Halaxy answered ' + res.status + '; scripts pause for ' + PACE.pauseMs / 60e3 + ' minutes.');
    }
    return res;
  }

  async function pacedFetch(input, init) {
    await pace();
    return noteStatus(await fetch(input, init));
  }

  // ------------------------------------------------------------------ requests

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

  const url = (p) => (/^https?:|^\//.test(p) && p.startsWith('/a/') ? p : (p.startsWith('/') ? base() + p : p));

  const http = {
    async json(path, opts) {
      const res = await pacedFetch(url(path), Object.assign({ credentials: 'same-origin', headers: JSON_HEADERS }, opts || {}));
      if (!res.ok) throw new UPCError('Halaxy returned ' + res.status + ' for ' + path.split('?')[0]);
      const text = await res.text();
      try { return JSON.parse(text); } catch (e) { throw new UPCError('Unexpected reply from ' + path.split('?')[0] + ' (signed out?)'); }
    },
    async html(path) {
      const res = await pacedFetch(url(path), { credentials: 'same-origin' });
      if (!res.ok) throw new UPCError('Halaxy returned ' + res.status + ' for ' + path.split('?')[0]);
      return htmlDoc(await res.text());
    },
    // An HTML fragment as Halaxy's own pop-ups request it (with X-Requested-With). Some pages, such
    // as an appointment's details, only include their content when asked this way.
    async fragment(path) {
      const res = await pacedFetch(url(path), { credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      if (!res.ok) throw new UPCError('Halaxy returned ' + res.status + ' for ' + path.split('?')[0]);
      return htmlDoc(await res.text());
    },
    // Halaxy pop-up: GET returns { status: 'FORM', message: '<form ...>' }.
    async popup(path) {
      const sep = path.includes('?') ? '&' : '?';
      const json = await http.json(path + sep + 'clicked=' + Date.now());
      return { json, doc: htmlDoc(json && json.message) };
    },
    async postForm(path, pairs) {
      const body = new URLSearchParams();
      pairs.forEach(([k, v]) => body.append(k, v));
      return http.json(path, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, JSON_HEADERS),
        body: body.toString(),
      });
    },
    // ag-Grid list endpoints (invoice/list-data and friends), with the page's bearer token.
    async list(path, filterModel, sortModel, startRow, endRow) {
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (window.Hk && window.Hk.jwt) headers.Authorization = 'Bearer ' + window.Hk.jwt;
      const body = { startRow: startRow || 0, endRow: endRow || 50, rowGroupCols: [], valueCols: [], pivotCols: [], pivotMode: false, groupKeys: [], filterModel: filterModel || {}, sortModel: sortModel || [] };
      const res = await pacedFetch(url(path), { method: 'POST', headers, body: JSON.stringify(body), credentials: 'same-origin' });
      if (!res.ok) throw new UPCError('Halaxy returned ' + res.status + ' for ' + path);
      return res.json();
    },
    expectRefresh(json, what) {
      if (json && (json.status === 'REFRESH' || json.status === 'OK')) return json;
      let detail = '';
      // Halaxy's own list of what was wrong, when it sends one. The form HTML also carries a hint for every
      // required field ("* Title is required"), shown or not, so it's only used when there's no list.
      const listed = json && Array.isArray(json.errors) ? json.errors.map((x) => clean(typeof x === 'string' ? x : JSON.stringify(x))).filter(Boolean) : [];
      if (listed.length) throw new UPCError(what + ' was not accepted by Halaxy: ' + listed.join('; '));
      if (json && json.message) {
        detail = clean(Array.from(htmlDoc(json.message).querySelectorAll('.text-danger, .form-error, .alert-danger, .invalid-feedback')).map((e) => e.textContent).join(' '));
      }
      if (json && json.errors) detail += ' ' + clean(JSON.stringify(json.errors));
      throw new UPCError(what + ' was not accepted by Halaxy' + (detail.trim() ? ': ' + detail.trim() : '.'));
    },
    serialize,
    // For scripts that make their own requests: wait your turn, and report Halaxy's answer.
    pace,
    fetch: pacedFetch,
    // Milliseconds until scripts may make requests again (0 = not paused). Background checks should skip while paused.
    pausedFor,
    PACE,
  };

  // ------------------------------------------------------------------ invoices

  // Reads an invoice page (patient or organisation). Lines on an organisation invoice link back
  // to the patient invoice they came from (patientInvoiceId).
  function parseInvoice(doc, id) {
    const title = clean(doc.title);
    const num = (title.match(/UPC-?\d+/i) || [''])[0].toUpperCase().replace(/^UPC-?/, 'UPC-');
    const inv = { id: String(id), number: num || title, lines: [], payments: [], paymentRows: [], pending: [], attachments: [], attachmentList: [], total: null, outstanding: null };
    const table = doc.querySelector('#invoiceLines');
    if (table) {
      table.querySelectorAll('tr').forEach((tr) => {
        const edit = tr.querySelector('a[href*="/invoice/line/"][href*="/edit"]');
        const amountTd = tr.querySelector('td[data-property="amount"]');
        if (edit && amountTd) {
          const dateTd = tr.querySelector('td[data-property="date"]');
          const dateLink = dateTd && dateTd.querySelector('a[href]');
          const pInv = dateLink && (dateLink.getAttribute('href').match(/\/invoice\/(\d+)\/?$/) || [])[1];
          const apptLink = dateTd && dateTd.querySelector('a[href*="/appointment/"]');
          // On an organisation invoice the Patient column is also marked "description" (and holds a script), so
          // the fee's own description is the last such cell, read without scripts (live, 11 Nov 2026).
          const descTd = [...tr.querySelectorAll('td[data-property="description"]')].pop();
          const descCopy = descTd ? descTd.cloneNode(true) : null;
          if (descCopy) descCopy.querySelectorAll('script, style').forEach((x) => x.remove());
          inv.lines.push({
            appointmentId: apptLink ? (apptLink.getAttribute('href').match(/\/appointment\/(\d+)/) || [])[1] || null : null,
            lineId: edit.getAttribute('href').match(/\/invoice\/line\/(\d+)\//)[1],
            date: (clean(dateTd && dateTd.textContent).match(/\d{2}-[A-Za-z]{3}-\d{4}/) || [''])[0],
            item: clean((tr.querySelector('td[data-property="itemNumber"]') || {}).textContent),
            description: descCopy ? clean(descCopy.textContent) : '',
            amount: money.inText(amountTd.textContent),
            patientInvoiceId: pInv || null,
          });
        } else if (!edit && Array.from(tr.children).some((c) => clean(c.textContent) === 'Total') && money.lastInText(tr.textContent) !== null) {
          inv.total = money.lastInText(tr.textContent);
        }
      });
    }
    const pay = doc.querySelector('#invoicePayments');
    if (pay) {
      pay.querySelectorAll('tbody tr').forEach((tr) => {
        const t = clean(tr.textContent);
        const link = Array.from(tr.querySelectorAll('a[href]')).map((a) => (a.getAttribute('href').match(/\/invoice\/(\d+)\/?$/) || [])[1]).find(Boolean);
        const pend = tr.querySelector('[data-modal-href*="/invoicefunctions/"][data-modal-href*="/claim/"]');
        const tds = tr.querySelectorAll('td');
        if (pend) inv.pending.push({ href: pend.getAttribute('data-modal-href'), amount: money.inText(t) });
        else if (Array.from(tr.children).some((c) => clean(c.textContent) === 'Outstanding')) inv.outstanding = money.inText(t);
        else if (link && /^Invoice\b/.test(clean(tds[1] && tds[1].textContent))) {
          inv.payments.push({ funderInvoiceId: link, amount: money.lastInText(t), status: clean(tds[2] && tds[2].textContent) });
        }
        if (!pend && !Array.from(tr.children).some((c) => /^(Outstanding|Available)$/.test(clean(c.textContent)))) inv.paymentRows.push(t);   // each payment row's text
      });
    }
    // Paid in full: Halaxy shows the invoice as a "Receipt" and leaves out the Outstanding row (live, 12 Nov 2026:
    // UPC-38023), so nothing is outstanding.
    if (inv.outstanding === null && (/^receipt\b/i.test(title) || Array.from(doc.querySelectorAll('.badge, .status, .label, span, div')).some((e) => !e.children.length && /^paid in full$/i.test(clean(e.textContent))))) {
      inv.outstanding = 0;
      inv.paidInFull = true;
    }
    const att = doc.querySelector('#invoiceAttachments');
    if (att) {
      // Each attachment as its whole row (created date, type, file name, comment): the first cell is
      // the date, not the name.
      att.querySelectorAll('tbody tr').forEach((tr) => {
        const row = clean(tr.textContent);
        if (row && tr.querySelector('td')) inv.attachments.push(row);
        // The same row in parts (capture 13 Nov 2026): created, category, title, comments, then the buttons: download
        // (/a/file/get/<name>.pdf), view, edit (/invoice/attachment/:id, a pop-up), delete (never used).
        const td = [...tr.querySelectorAll('td')];
        if (td.length < 3) return;
        const get = tr.querySelector('a[href*="/file/get/"]');
        const edit = [...tr.querySelectorAll('a[href*="/invoice/attachment/"]')].find((a) => !/\/delete\b/.test(a.getAttribute('href')));
        inv.attachmentList.push({ created: clean(td[0].textContent), category: clean(td[1].textContent), title: clean(td[2].textContent), comments: clean(td[3] ? td[3].textContent : ''),
          fileUrl: get ? get.getAttribute('href') : null, editUrl: edit ? edit.getAttribute('href') : null });
      });
    }
    inv.isFunder = inv.lines.some((l) => l.patientInvoiceId);
    // Patient invoices: who, which claim, whether it is still waiting to be billed to the funder,
    // and where this fee sits in the authorisation ("3rd of 5 appts").
    // The card also holds an edit link (/a/magic/add/patient/{id}/invoice) before the patient's own page link.
    const pLink = [...doc.querySelectorAll('#card-invoice-view-patient a[href]')].find((a) => /\/a\/pr\/\d+\/patient\/\d+\/?$/.test(a.getAttribute('href')));
    inv.patientId = pLink ? (pLink.getAttribute('href').match(/\/patient\/(\d+)\/?$/) || [])[1] || null : null;
    inv.patientName = pLink ? clean(pLink.textContent) : '';
    const funderBtn = doc.querySelector('#invoiceFunderBtn[data-modal-href*="/claim/"]');
    inv.billFunderHref = funderBtn ? funderBtn.getAttribute('data-modal-href').split('?')[0] : null;
    const claimLink = doc.querySelector('#editClaimButton') || doc.querySelector('a[href*="/claim/"][href*="/referral/"]');
    const claimFromBtn = inv.billFunderHref && (inv.billFunderHref.match(/\/claim\/(\d+)/) || [])[1];
    const claimFromEdit = claimLink && ((claimLink.getAttribute('href').match(/\/patient\/claim\/\d+\/\d+\/(\d+)\//) || [])[1] || (claimLink.getAttribute('href').match(/\/claim\/(\d+)\/referral/) || [])[1]);
    inv.claimId = claimFromBtn || claimFromEdit || null;
    const org = doc.querySelector('#card-invoice-parts-claim-view a[href*="/organisation/"]');
    inv.funderName = org ? clean(org.textContent) : '';
    // An organisation invoice's Bill To box names the funder (#card-invoice-view-organisation, live 11 Nov 2026).
    const billTo = doc.querySelector('#card-invoice-view-organisation a[href*="/organisation/"]:not([href*="/edit"])');
    inv.billToName = billTo ? clean(billTo.textContent) : '';
    inv.billToOrgId = billTo ? ((billTo.getAttribute('href') || '').match(/\/organisation\/(\d+)/) || [])[1] || null : null;
    const ref = doc.querySelector('[data-referral]');
    const pos = ref && clean(ref.textContent).match(/\((\d+)(?:st|nd|rd|th)\s+of\s+(\d+)\s+appt/i);
    inv.referral = pos ? { position: +pos[1], limit: +pos[2] } : null;
    inv.issued = [...doc.querySelectorAll('.status-badge, .badge, .invoice-status, [class*="status"]')]
      .some((e) => !e.closest('#invoicePayments') && /^issued$/i.test(clean(e.textContent)));
    return inv;
  }

  const invoice = {
    parse: parseInvoice,
    async fetch(id) {
      const doc = await http.html('/invoice/' + id);
      if (!doc.querySelector('#invoiceLines')) throw new UPCError('Could not open invoice ' + id + '.');
      return parseInvoice(doc, id);
    },
    // The invoice's status from its settings (cogwheel): '' (Active), 'issued', 'deleted' or 'write-off'.
    async status(id) {
      const { doc } = await http.popup('/invoice/options/' + id);
      const sel = doc.querySelector('form#frmInvoiceType select[name="form[status]"]');
      if (!sel) throw new UPCError('Could not read the settings of invoice ' + id + '.');
      return sel.value;
    },
    // Sets the status the way the cogwheel's Save does: the whole settings form as Halaxy filled
    // it, with only the status changed. Reads it back to confirm.
    // Changes fields in the invoice settings (cogwheel) the way its Save does: the whole form as Halaxy
    // filled it, with only the given fields changed (e.g. { 'form[displayDate]': '09-Nov-2026' }).
    // Reads the pop-up again to confirm each one.
    async setSettings(id, changes, what) {
      const { doc } = await http.popup('/invoice/options/' + id);
      const form = doc.querySelector('form#frmInvoiceType');
      const missing = Object.keys(changes).filter((k) => !form || !form.querySelector('[name="' + k + '"]'));
      if (missing.length) throw new UPCError('The invoice settings pop-up has changed (' + missing.join(', ') + ' not found), so ' + (what || 'the settings') + ' were not changed.');
      const pairs = serialize(form).map(([k, v]) => [k, k in changes ? changes[k] : v]);
      Object.keys(changes).forEach((k) => { if (!pairs.some(([x]) => x === k)) pairs.push([k, changes[k]]); });
      http.expectRefresh(await http.postForm('/invoice/options/' + id, pairs), 'Saving ' + (what || 'the invoice settings'));
      const again = (await http.popup('/invoice/options/' + id)).doc.querySelector('form#frmInvoiceType');
      const wrong = Object.keys(changes).filter((k) => { const el = again && again.querySelector('[name="' + k + '"]'); return !el || String(el.value).trim() !== String(changes[k]); });
      if (wrong.length) throw new UPCError('Halaxy accepted the change, but invoice ' + id + ' does not show the new ' + (what || 'settings') + '.');
    },
    // Records a payment the way the invoice's "Mark as Paid" pop-up does (GET /invoicefunctions/{id}/pay/offline,
    // form#paymentForm; capture 11 Nov 2026): method by its name in the list (e.g. 'Direct Deposit'), date
    // '11-Sep-2026', amount in pence, a note; every other field as Halaxy filled it (no discount). Only if the invoice
    // still has at least that much outstanding, and checks afterwards that the outstanding went down by the amount.
    async payOffline(id, p) {
      const before = p.before || await invoice.fetch(id);   // p.before: the invoice just read by the caller
      if (before.outstanding === null) throw new UPCError('Could not read what is outstanding on invoice ' + (before.number || id) + ', so no payment was recorded.');
      if (before.outstanding < p.amount) throw new UPCError(before.number + ' has only ' + money.fmt(before.outstanding) + ' outstanding, less than ' + money.fmt(p.amount) + ', so no payment was recorded.');
      const path = '/invoicefunctions/' + encodeURIComponent(id) + '/pay/offline';
      const { doc } = await http.popup(path);
      const form = doc.querySelector('form#paymentForm') || doc.querySelector('form');
      const need = ['form[paymentMethod]', 'form[paymentDate]', 'form[amount]', 'form[note]', 'form[_token]'];
      const missing = need.filter((k) => !form || !form.querySelector('[name="' + k + '"]'));
      if (missing.length) throw new UPCError('The Mark as Paid pop-up has changed (' + missing.join(', ') + ' not found), so no payment was recorded.');
      const opt = [...form.querySelectorAll('select[name="form[paymentMethod]"] option')].find((o) => clean(o.textContent).toLowerCase() === String(p.method).toLowerCase());
      if (!opt) throw new UPCError('"' + p.method + '" is not in the payment methods, so no payment was recorded.');
      const set = { 'form[paymentMethod]': opt.value, 'form[paymentDate]': p.date, 'form[amount]': (p.amount / 100).toFixed(2), 'form[note]': p.note || '', 'form[invoiceDiscount]': '', 'form[discountPercentage]': '' };
      const pairs = serialize(form).map(([k, v]) => [k, k in set ? set[k] : v]);
      Object.keys(set).forEach((k) => { if (!pairs.some(([x]) => x === k) && form.querySelector('[name="' + k + '"]')) pairs.push([k, set[k]]); });
      // Halaxy records the payment but doesn't answer with OK or REFRESH (live, 12 Nov 2026: shown as "not accepted"
      // although it was recorded), so the invoice itself is the answer: read it back. Only the form coming back
      // (Halaxy refusing it) counts as not accepted.
      let answer = null, sendErr = null;
      try { answer = await http.postForm(path, pairs); } catch (e) { sendErr = e; }
      if (answer && answer.status === 'FORM') http.expectRefresh(answer, 'Recording the payment');
      const after = await invoice.fetch(id);
      if (after.outstanding !== null && after.outstanding === before.outstanding - p.amount) return after;
      if (after.outstanding === before.outstanding && sendErr) throw sendErr;
      throw new UPCError(before.number + ' now shows ' + (after.outstanding === null ? 'no outstanding amount' : money.fmt(after.outstanding) + ' outstanding') + ', not ' + money.fmt(before.outstanding - p.amount) + ' as expected after recording ' + money.fmt(p.amount) + '. Please check it.');
    },
    async setStatus(id, status) {
      const { doc } = await http.popup('/invoice/options/' + id);
      const form = doc.querySelector('form#frmInvoiceType');
      const sel = form && form.querySelector('select[name="form[status]"]');
      if (!sel || ![...sel.options].some((o) => o.value === status)) throw new UPCError('The invoice settings pop-up has changed, so the status was not set.');
      const pairs = serialize(form).map(([k, v]) => [k, k === 'form[status]' ? status : v]);
      if (!pairs.some(([k]) => k === 'form[status]')) pairs.push(['form[status]', status]);
      http.expectRefresh(await http.postForm('/invoice/options/' + id, pairs), 'Setting the invoice status');
      if ((await invoice.status(id)) !== status) throw new UPCError('Halaxy accepted the change, but invoice ' + id + ' does not show the new status.');
    },
    // Sets a fee line's amount (pence) the way the fee edit pop-up's Save does: every other field as
    // Halaxy filled it. A fee on a claim carries its funder rebate (the share the funder is expected to
    // pay) from the start, before any billing. With { lowerRebate: true }, a rebate above the new amount
    // is lowered with it, but only while the invoice still shows Invoice Funder (nothing billed yet);
    // otherwise, and without the option, such a fee is refused. Re-reads the fee to confirm.
    async setLineAmount(invoiceId, lineId, amount, opts) {
      const o = opts || {};
      const pairs = await lineForm(lineId);
      const field = (k) => { const p = pairs.find(([x]) => x === k); return p ? p[1] : undefined; };
      if (field('form[amount]') === undefined) throw new UPCError('The fee edit pop-up has changed, so the fee was not changed.');
      const rebate = field('form[rebate]') === undefined ? null : money.cents(field('form[rebate]'));
      let newRebate = null;
      if (rebate !== null && rebate > amount) {
        if (!o.lowerRebate) throw new UPCError('This fee has a funder rebate of ' + money.fmt(rebate) + ', so it was not changed.');
        const inv = await invoice.fetch(invoiceId);
        if (!inv.billFunderHref) throw new UPCError(inv.number + ' no longer shows Invoice Funder, so this fee may have been billed to the funder. It was not changed.');
        newRebate = amount;
      }
      const out = pairs.map(([k, v]) => [k, k === 'form[amount]' ? money.plain(amount) : k === 'form[rebate]' && newRebate !== null ? money.plain(newRebate) : v]);
      http.expectRefresh(await http.postForm('/invoice/line/' + lineId + '/edit', out), 'Saving the fee');
      const after = await lineForm(lineId);
      const get = (k) => { const p = after.find(([x]) => x === k); return p ? p[1] : undefined; };
      if (money.cents(get('form[amount]')) !== amount || (newRebate !== null && money.cents(get('form[rebate]')) !== newRebate)) {
        throw new UPCError('Halaxy accepted the change, but the fee does not show ' + money.fmt(amount) + (newRebate !== null ? ' with a ' + money.fmt(newRebate) + ' rebate' : '') + '.');
      }
    },
    // Sets a fee line's date ('13-Oct-2026'), the field form[date] in the fee edit pop-up (confirmed live
    // 9 Nov 2026), every other field as Halaxy filled it. Re-reads the fee to confirm.
    async setLineDate(lineId, date) {
      const pairs = await lineForm(lineId);
      if (!pairs.some(([k]) => k === 'form[date]')) throw new UPCError('The fee edit pop-up has changed, so the fee date was not changed.');
      http.expectRefresh(await http.postForm('/invoice/line/' + lineId + '/edit', pairs.map(([k, v]) => [k, k === 'form[date]' ? date : v])), 'Saving the fee date');
      const after = (await lineForm(lineId)).find(([k]) => k === 'form[date]');
      if (!after || String(after[1]).trim() !== date) throw new UPCError('Halaxy accepted the change, but the fee does not show ' + date + '.');
    },
    // Finds an invoice by its number (UPC-12345). Returns the list row ({ id, invoiceNum, payerName, total, balance, ... }) or null.
    async findByNumber(number) {
      const want = String(number).toUpperCase().replace(/\s+/g, '');
      const j = await http.list('/invoice/list-data', { serverQuickFilter: { filterType: 'text', type: 'contains', filter: want } }, [], 0, 50);
      const rows = (j && j.rowData) || [];
      return rows.find((r) => String(r.invoiceNum || r.invoiceNumber || '').toUpperCase().replace(/\s+/g, '') === want) || null;
    },
  };

  // ------------------------------------------------------------------ rebate: move part of a funder line to the patient

  async function lineForm(lineId) {
    const { doc } = await http.popup('/invoice/line/' + lineId + '/edit');
    const form = doc.querySelector('form#invoiceLineForm, form');
    if (!form) throw new UPCError('Could not read the edit form for line ' + lineId + '.');
    return serialize(form);
  }

  async function rebill(patientId, funderInvoiceId, expected) {
    const p = await invoice.fetch(patientId);
    if (p.pending.length !== 1) throw new UPCError('Expected one amount waiting to bill on ' + p.number + ', found ' + p.pending.length + '. Use Invoice Funder on the patient invoice to finish.');
    if (p.pending[0].amount !== expected) throw new UPCError('Amount waiting to bill is ' + money.fmt(p.pending[0].amount) + ', expected ' + money.fmt(expected) + '. Use Invoice Funder on the patient invoice to finish.');
    const href = p.pending[0].href.split('?')[0];
    const { doc } = await http.popup(href);
    if (!doc.querySelector('input[name="form[orgInvoice]"][value="' + funderInvoiceId + '"]')) {
      throw new UPCError('Halaxy did not offer the original funder invoice when re-billing. Use Invoice Funder on ' + p.number + ' to finish.');
    }
    http.expectRefresh(await http.postForm(href, [['form[orgInvoice]', funderInvoiceId]]), 'Re-billing to the funder');
  }

  // Halaxy only offers Active organisation invoices when billing a funder, so a fee can be taken off an Issued
  // invoice but not put back (live, 12 Nov 2026: UPC-38023 and UPC-37983 left part-way). An Issued funder invoice is
  // set back to Active for the change and marked Issued again afterwards, whatever happens in between.
  async function withActive(funderInvoiceId, number, say, fn) {
    const was = await invoice.status(funderInvoiceId);
    if (was === 'issued') { say('Setting ' + number + ' back to Active while it is changed'); await invoice.setStatus(funderInvoiceId, ''); }
    let result, failure = null;
    try { result = await fn(); } catch (e) { failure = e; }
    if (was === 'issued') {
      try { say('Marking ' + number + ' Issued again'); await invoice.setStatus(funderInvoiceId, 'issued'); }
      catch (e) {
        const more = 'Could not mark ' + number + ' Issued again (' + (e.message || e) + '): mark it Issued by hand (cogwheel, Status).';
        throw new UPCError(failure ? (failure.message || failure) + ' ' + more : more);
      }
    }
    if (failure) throw failure;
    return result;
  }

  // Finishes a move that stopped after the fee was taken off the funder invoice: the amount waiting on the patient
  // invoice is billed back to the same funder invoice and given its fee's date. opts.from / opts.to (ISO dates) limit
  // which of the patient's fees it can be (those the remittance covers).
  async function resumeMove(funderInvoiceId, patientInvoiceId, opts, say) {
    opts = opts || {}; say = say || (() => {});
    const p = await invoice.fetch(patientInvoiceId);
    if (p.pending.length !== 1) throw new UPCError(p.number + ' has ' + p.pending.length + ' amounts waiting to bill, not one. Finish it by hand.');
    const amount = p.pending[0].amount;
    const funder = await invoice.fetch(funderInvoiceId);
    if (funder.outstanding !== funder.total) throw new UPCError(funder.number + ' already has a payment recorded, so it was not changed.');
    const days = (iso) => Math.round(Date.parse(iso + 'T12:00:00Z') / 86400e3);
    const inWindow = (d) => {
      if (!opts.from) return true;
      const t = halaxyDay(d);
      if (t === null) return false;
      const x = Math.round((t + 12 * 3600e3) / 86400e3);   // the fee's day, whatever the clock change
      return x >= days(opts.from) - 2 && x <= days(opts.to || opts.from) + 2;
    };
    const onFunder = funder.lines.filter((l) => l.patientInvoiceId === String(patientInvoiceId));
    const missing = p.lines.filter((pl) => inWindow(pl.date) && !onFunder.some((fl) => fl.item === pl.item && dayGap(fl.date, pl.date) <= 2));
    if (missing.length !== 1) throw new UPCError('Could not tell which fee on ' + p.number + ' is waiting to go back on ' + funder.number + ' (' + missing.length + ' possible). Finish it by hand.');
    return withActive(funderInvoiceId, funder.number, say, async () => {
      say('Billing ' + money.fmt(amount) + ' (the ' + missing[0].date + ' fee) back to ' + funder.number);
      await rebill(patientInvoiceId, funderInvoiceId, amount);
      let fAfter = await invoice.fetch(funderInvoiceId);
      const before = new Set(funder.lines.map((l) => l.lineId));
      const added = fAfter.lines.filter((l) => !before.has(l.lineId) && l.patientInvoiceId === String(patientInvoiceId));
      if (added.length !== 1 || added[0].amount !== amount) throw new UPCError('Billed, but ' + funder.number + ' does not show one new ' + money.fmt(amount) + ' line. Check it.');
      if (added[0].date !== missing[0].date) {
        say('Correcting the date Halaxy gave it: ' + added[0].date + ' to ' + missing[0].date);
        await invoice.setLineDate(added[0].lineId, missing[0].date);
      }
      const pAfter = await invoice.fetch(patientInvoiceId);
      if (pAfter.pending.length) throw new UPCError(pAfter.number + ' still shows an amount waiting to bill. Check it.');
      return { amount, date: missing[0].date };
    });
  }

  // Works out the steps for one funder line: which patient invoice line it came from, and checks
  // both invoices agree. Read-only. opts.overrides: other fields to change on the patient fee in the same save (Rebate
  // sync, when the fee's amount is changed with its rebate), with opts.fee the fee's new amount (pence).
  async function planMove(funderInvoiceId, funderLineId, newRebate, opts) {
    opts = opts || {};
    const funder = await invoice.fetch(funderInvoiceId);
    const line = funder.lines.find((l) => l.lineId === String(funderLineId));
    if (!line) throw new UPCError('Line ' + funderLineId + ' is not on invoice ' + funder.number + '.');
    if (!line.patientInvoiceId) throw new UPCError('Cannot see which patient invoice this line belongs to.');
    if (funder.lines.filter((l) => l.patientInvoiceId === line.patientInvoiceId && l.date === line.date && l.item === line.item).length > 1) {
      throw new UPCError(funder.number + ' has more than one ' + line.item + ' line for that patient on ' + line.date + '. Do this one by hand.');
    }
    const patient = await invoice.fetch(line.patientInvoiceId);
    let cands = patient.lines.filter((l) => l.date === line.date && l.item === line.item);
    if (!cands.length) {
      // Halaxy sometimes copies a fee onto the funder invoice a day or two out (13-Oct became 14-Oct,
      // seen 9 Nov 2026). Accept the one same-item fee within two days that no other funder line claims.
      const claimed = new Set(funder.lines.filter((l) => l !== line && l.patientInvoiceId === line.patientInvoiceId).map((l) => l.date + '|' + l.item));
      cands = patient.lines.filter((l) => l.item === line.item && dayGap(l.date, line.date) <= 2 && !claimed.has(l.date + '|' + l.item));
      if (cands.length > 1) throw new UPCError(patient.number + ' has more than one ' + line.item + ' fee near ' + line.date + ' (' + cands.map((l) => l.date).join(', ') + '). Do this one by hand.');
    }
    if (cands.length !== 1) {
      const dates = patient.lines.filter((l) => l.item === line.item).map((l) => l.date);
      throw new UPCError(cands.length ? patient.number + ' has more than one ' + line.item + ' line on ' + line.date + '. Do this one by hand.'
        : 'Could not find the ' + line.date + ' ' + line.item + ' fee on ' + patient.number + (dates.length ? ' (its ' + line.item + ' fees are dated ' + dates.join(', ') + ')' : '') + '.');
    }
    const pFields = Object.fromEntries(await lineForm(cands[0].lineId));
    const origRebate = money.cents(pFields['form[rebate]']);
    if (origRebate !== line.amount) throw new UPCError('The invoices already disagree (patient rebate ' + money.fmt(origRebate) + ', funder line ' + money.fmt(line.amount) + '). Sort that out by hand first.');
    const fee = opts.fee !== undefined && opts.fee !== null ? opts.fee : money.cents(pFields['form[amount]']);
    if (newRebate === null || newRebate === undefined || isNaN(newRebate)) throw new UPCError('The new funder amount is not a valid amount.');
    if (newRebate < 0) throw new UPCError('The new funder amount cannot be negative.');
    if (fee !== null && newRebate > fee) throw new UPCError('The new funder amount (' + money.fmt(newRebate) + ') is more than the fee (' + money.fmt(fee) + ').');
    return { funderInvoiceId: funder.id, funderNumber: funder.number, funderLineId: line.lineId, patientInvoiceId: patient.id, patientNumber: patient.number,
      patientLineId: cands[0].lineId, date: line.date, patientDate: cands[0].date, item: line.item, fee, origRebate, newRebate,
      overrides: Object.assign({}, opts.overrides || {}) };
  }

  // Carries out a plan from planMove: revert the funder line, change the rebate on the patient
  // line, re-bill the new amount to the same funder invoice, then check. say(text) reports progress.
  async function applyMove(plan, say) {
    say = say || (() => {});
    const { funderInvoiceId, funderLineId, patientInvoiceId, patientLineId, origRebate, newRebate } = plan;
    say('Checking ' + plan.funderNumber + ' and ' + plan.patientNumber);
    const funder = await invoice.fetch(funderInvoiceId);
    const fLine = funder.lines.find((l) => l.lineId === funderLineId);
    if (!fLine || fLine.amount !== origRebate) throw new UPCError('The line on ' + plan.funderNumber + ' has changed since it was checked. Nothing was changed.');
    if (funder.total === null || funder.outstanding === null) throw new UPCError('Could not find an outstanding balance on ' + funder.number + ', so nothing was changed.');
    if (funder.outstanding !== funder.total) throw new UPCError(funder.number + ' already has a payment recorded, so it was not changed.');
    const patient0 = await invoice.fetch(patientInvoiceId);
    if (patient0.pending.length) throw new UPCError(patient0.number + ' already has an amount waiting to be billed to a funder. Nothing was changed.');
    return withActive(funderInvoiceId, plan.funderNumber, say, () => moveSteps(plan, funder, say));
  }
  // Takes a funder line off its invoice (Halaxy's "Revert the fee back to the patient"): it then waits on the patient invoice.
  async function revertLine(lineId) {
    const removeJson = await http.json('/invoice/line/' + lineId + '/remove?clicked=' + Date.now());
    const m = String(removeJson && removeJson.message).match(/case\s+'delete'\s*:[\s\S]*?url\s*=\s*"([^"]+)"/);
    if (!m) throw new UPCError('Could not find Halaxy\'s revert option for this line.');
    http.expectRefresh(await http.json(m[1]), 'Reverting the funder line');
  }
  // Saves fields on a patient fee (the fee edit pop-up), everything else as Halaxy filled it.
  async function saveLineFields(lineId, set, what) {
    const fresh = await lineForm(lineId);
    const want = Object.assign({}, set);
    delete want['form[_token]'];
    const pairs = fresh.map(([k, v]) => [k, k in want ? want[k] : v]);
    Object.keys(want).forEach((k) => { if (!fresh.some(([x]) => x === k)) pairs.push([k, want[k]]); });
    http.expectRefresh(await http.postForm('/invoice/line/' + lineId + '/edit', pairs), what);
  }

  // The steps of a move. If any step fails after something was changed, everything is put back as it was (Carl,
  // 12 Nov 2026: "any work that was started reverted back to the original state"): the error says whether that
  // worked (error.undone true), or exactly what is left (error.undone false).
  async function moveSteps(plan, funder, say) {
    const { funderInvoiceId, funderLineId, patientInvoiceId, patientLineId, origRebate, newRebate } = plan;
    let stage = 'start';
    const origFields = {};
    try {
      // What the patient fee shows now, to put back if needed.
      const before = await lineForm(patientLineId);
      Object.keys(Object.assign({ 'form[rebate]': 1 }, plan.overrides || {})).forEach((k) => { const p = before.find(([x]) => x === k); if (p) origFields[k] = p[1]; });

      say('Reverting the ' + plan.date + ' line to ' + plan.patientNumber);
      await revertLine(funderLineId);
      stage = 'reverted';
      const patient = await invoice.fetch(patientInvoiceId);
      if (patient.pending.length !== 1 || patient.pending[0].amount !== origRebate) {
        throw new UPCError('After reverting, ' + patient.number + ' does not show ' + money.fmt(origRebate) + ' waiting to bill.');
      }

      say('Setting the rebate to ' + money.fmt(newRebate));
      stage = 'rebate';   // from here the rebate may have changed
      await saveLineFields(patientLineId, Object.assign({}, plan.overrides || {}, { 'form[rebate]': money.plain(newRebate) }), 'Saving the new rebate');

      // Re-bill what the funder now owes, £0 included, so the fee stays on the funder invoice at that
      // amount (Carl, 9 Nov 2026: a £0.00 line, never a missing one). Halaxy offers £0 to bill like any amount.
      say('Re-billing ' + money.fmt(newRebate) + ' to ' + plan.funderNumber);
      await rebill(patientInvoiceId, funderInvoiceId, newRebate);
      stage = 'rebilled';

      let fAfter = await invoice.fetch(funderInvoiceId);
      const known = new Set(funder.lines.map((l) => l.lineId));
      const added = fAfter.lines.filter((l) => !known.has(l.lineId) && l.patientInvoiceId === patientInvoiceId && l.item === plan.item);
      const nl = added.filter((l) => l.amount === newRebate);
      if (fAfter.lines.some((l) => l.lineId === funderLineId)) throw new UPCError('The original line is still on ' + fAfter.number + '.');
      if (nl.length !== 1) throw new UPCError('No new ' + money.fmt(newRebate) + ' line found on ' + fAfter.number + '.');
      if (plan.patientDate && nl[0].date !== plan.patientDate) {
        // Halaxy can give the re-billed line the wrong date too: set it to the patient fee's date.
        say('Correcting the date Halaxy gave the re-billed line: ' + nl[0].date + ' to ' + plan.patientDate);
        await invoice.setLineDate(nl[0].lineId, plan.patientDate);
        fAfter = await invoice.fetch(funderInvoiceId);
      }
      const pAfter = await invoice.fetch(patientInvoiceId);
      if (fAfter.total !== funder.total - origRebate + newRebate) throw new UPCError(fAfter.number + ' total is ' + money.fmt(fAfter.total) + ', expected ' + money.fmt(funder.total - origRebate + newRebate) + '.');
      if (pAfter.pending.length) throw new UPCError(pAfter.number + ' still has an amount waiting to bill.');
      return { funderTotal: fAfter.total, patientOutstanding: pAfter.outstanding, newLineId: nl[0].lineId };
    } catch (e) {
      const why = (e && e.message) || String(e);
      if (stage === 'start') { const err = new UPCError(why + ' Nothing was changed.'); err.undone = true; throw err; }
      say('Stopped (' + why + '). Putting ' + plan.funderNumber + ' and ' + plan.patientNumber + ' back as they were...');
      try {
        await undoMove(plan, funder, stage, origFields, say);
      } catch (u) {
        const err = new UPCError(why + ' Putting it back also failed: ' + ((u && u.message) || u) + ' Check ' + plan.funderNumber + ' (the ' + plan.date + ' fee should be ' + money.fmt(origRebate) +
          ') and ' + plan.patientNumber + ' (its rebate should be ' + money.fmt(origRebate) + ', with nothing waiting to bill).');
        err.undone = false;
        throw err;
      }
      const err = new UPCError(why + ' Everything was put back as it was.');
      err.undone = true;
      throw err;
    }
  }

  // Puts a move back: the re-billed line (if any) taken off again, the patient fee's fields as they were, the original
  // amount billed back to the same funder invoice with the original line's date, then checked against how it was.
  async function undoMove(plan, funder, stage, origFields, say) {
    const { funderInvoiceId, patientInvoiceId, patientLineId, origRebate } = plan;
    if (stage === 'rebilled') {
      const f = await invoice.fetch(funderInvoiceId);
      const known = new Set(funder.lines.map((l) => l.lineId));
      const added = f.lines.filter((l) => !known.has(l.lineId) && l.patientInvoiceId === patientInvoiceId);
      if (added.length !== 1) throw new UPCError('Could not tell which line was re-billed to ' + f.number + '.');
      say('  Taking the re-billed line off again');
      await revertLine(added[0].lineId);
    }
    if (stage === 'rebate' || stage === 'rebilled') {
      say('  Setting the rebate back to ' + money.fmt(origRebate));
      await saveLineFields(patientLineId, origFields, 'Putting the rebate back');
    }
    say('  Billing ' + money.fmt(origRebate) + ' back to ' + plan.funderNumber);
    await rebill(patientInvoiceId, funderInvoiceId, origRebate);
    const f = await invoice.fetch(funderInvoiceId);
    const known = new Set(funder.lines.map((l) => l.lineId));
    const back = f.lines.filter((l) => !known.has(l.lineId) && l.patientInvoiceId === patientInvoiceId && l.amount === origRebate);
    if (back.length === 1 && back[0].date !== plan.date) await invoice.setLineDate(back[0].lineId, plan.date);
    const f2 = await invoice.fetch(funderInvoiceId), p2 = await invoice.fetch(patientInvoiceId);
    if (f2.total !== funder.total || p2.pending.length) throw new UPCError(f2.number + ' shows ' + money.fmt(f2.total) + ' (was ' + money.fmt(funder.total) + ')' + (p2.pending.length ? ' and ' + p2.number + ' still has an amount waiting to bill' : '') + '.');
  }

  const rebate = { plan: planMove, apply: applyMove, resume: resumeMove };

  // ------------------------------------------------------------------ files

  // Halaxy's attach categories on invoices (radio values in the attach pop-up).
  const ATTACH_CATEGORY = { other: '0', authoriseBenefit: '1', payment: '2' };

  const files = {
    CATEGORY: ATTACH_CATEGORY,
    // Attaches a file to an invoice the way the attach button does: open the pop-up, upload the
    // file to Halaxy's file store, then save it against the invoice with a title and category.
    // Checks the invoice lists one more attachment afterwards.
    // Returns false, attaching nothing, when opts.skipIfAttached and a file with this title (or any name in
    // opts.alsoSkipIf) is already on the invoice.
    async attachToInvoice(invoiceId, file, opts) {
      opts = opts || {};
      const before = await invoice.fetch(invoiceId);
      const wanted = String(opts.title || file.name || 'Attachment').replace(/\.pdf$/i, '');
      if (opts.skipIfAttached && before.attachments.some((r) => r.includes(wanted) || (opts.alsoSkipIf || []).some((t) => t && r.includes(t)))) return false;
      const { doc } = await http.popup('/file/upload/invoice/' + invoiceId);
      const form = doc.querySelector('form#fileupload, form.js-file-edit-form');
      const uploadUrl = form && form.getAttribute('data-upload-url');
      const token = form && form.querySelector('[name="form[_token]"]');
      if (!uploadUrl || !token) throw new UPCError('The attach pop-up has changed, so the file was not attached.');

      const fd = new FormData();
      fd.append('file', file, file.name || 'remittance.pdf');
      const headers = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
      if (window.Hk && window.Hk.jwt) headers.Authorization = 'Bearer ' + window.Hk.jwt;
      const res = await pacedFetch(uploadUrl, { method: 'POST', headers, body: fd, credentials: 'same-origin' });
      if (!res.ok) throw new UPCError('Halaxy returned ' + res.status + ' when uploading the file.');
      const up = await res.json().catch(() => null);
      const stored = up && up.files && up.files[0];
      if (!stored || !stored.id) throw new UPCError('Halaxy did not accept the file' + (stored && stored.error ? ': ' + stored.error : '.'));

      const title = String(opts.title || file.name || 'Attachment').replace(/\.pdf$/i, '');
      const saved = await http.postForm('/file/upload/invoice/' + invoiceId, [
        ['form[files][0][fileEntity]', String(stored.id)],
        ['form[files][0][title]', title],
        ['form[files][0][invoiceComments]', opts.comments || ''],
        ['form[files][0][invoiceCategory]', opts.category || ATTACH_CATEGORY.payment],
        ['form[_token]', token.value],
      ]);
      http.expectRefresh(saved, 'Attaching the file');
      const after = await invoice.fetch(invoiceId);
      if (after.attachments.length <= before.attachments.length) throw new UPCError('Halaxy accepted the file but does not list it on ' + after.number + '. Check the invoice.');
      return { fileId: stored.id };
    },
    // True when the file already attached (its download link) is byte for byte the same as `file`.
    async sameFile(fileUrl, file) {
      const res = await pacedFetch(fileUrl, { credentials: 'same-origin' });
      if (!res.ok) throw new UPCError('Halaxy returned ' + res.status + ' for the attached file.');
      const digest = async (buf) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
      const [a, b] = await Promise.all([res.arrayBuffer(), file.arrayBuffer()]);
      return a.byteLength === b.byteLength && (await digest(a)) === (await digest(b));
    },
    // Changes an attachment's title, comment and category through its edit pop-up (the pencil; form#frmInvoiceFile,
    // capture 13 Nov 2026), then reads the invoice back to check the comment is there.
    async updateAttachment(invoiceId, editUrl, opts) {
      const path = String(editUrl).replace(/^\/a\/pr\/\d+/, '');
      const { doc } = await http.popup(path);
      const form = doc.querySelector('form#frmInvoiceFile') || doc.querySelector('form');
      const has = (n) => form && form.querySelector('[name="' + n + '"]');
      if (!form || !has('form[title]') || !has('form[comments]') || !has('form[_token]')) throw new UPCError('Halaxy\'s attachment edit pop-up has changed, so the details were not updated.');
      // `append` adds to the comment as it is in the pop-up (the whole of it: the page may show it shortened), once.
      const was = (n) => clean(form.querySelector('[name="' + n + '"]').value);
      if (opts.title === undefined) opts = Object.assign({}, opts, { title: was('form[title]') });
      if (opts.append) opts = Object.assign({}, opts, { comments: was('form[comments]').includes(clean(opts.append)) ? was('form[comments]') : [was('form[comments]'), opts.append].filter(Boolean).join('; ') });
      const pairs = serialize(form).filter(([k]) => !['form[title]', 'form[comments]', 'form[invoiceFileType]'].includes(k));
      pairs.push(['form[title]', opts.title], ['form[comments]', opts.comments || '']);
      if (has('form[invoiceFileType]')) pairs.push(['form[invoiceFileType]', String(opts.category !== undefined ? opts.category : ATTACH_CATEGORY.payment)]);
      const res = await http.postForm(path, pairs);
      if (res && res.status === 'FORM') throw new UPCError('Halaxy did not accept the new details' + (Array.isArray(res.errors) && res.errors.length ? ': ' + res.errors.join(' ') : '.'));
      const after = await invoice.fetch(invoiceId);
      const start = clean(opts.comments || '').slice(0, 60);   // Halaxy may shorten a long comment on the page
      if (!after.attachmentList.some((a) => a.comments.includes(start) && a.title.includes(clean(opts.title)))) throw new UPCError('Halaxy does not show the new details on ' + after.number + '. Check the invoice.');
      return true;
    },
  };

  // ------------------------------------------------------------------ libraries from a CDN

  const loading = {};
  const load = {
    script(src, globalName) {
      if (globalName && window[globalName]) return Promise.resolve(window[globalName]);
      if (!loading[src]) {
        loading[src] = new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = src;
          s.async = true;
          s.onload = () => resolve(globalName ? window[globalName] : true);
          s.onerror = () => { delete loading[src]; reject(new UPCError('Could not load ' + src.split('/').slice(2, 3)[0] + '. Check the internet connection.')); };
          (document.head || document.documentElement).appendChild(s);
        });
      }
      return loading[src];
    },
  };

  // ------------------------------------------------------------------ reports

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // '05-Nov-2026' for a Date or milliseconds.
  const dayLabel = (d) => { const x = new Date(d); return String(x.getDate()).padStart(2, '0') + '-' + MONTHS[x.getMonth()] + '-' + x.getFullYear(); };
  // Milliseconds (local midnight) from '05-Nov-2026', '05/11/2026' or ISO; null if unreadable.
  const parseDay = (s) => {
    const t = String(s || '').trim();
    let m = t.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
    if (m) { const i = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase()); return i < 0 ? null : new Date(+m[3], i, +m[1]).getTime(); }
    m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1]).getTime();
    m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : null;
  };
  // A table's cells as a grid, following rowspan and colspan.
  function cellGrid(rows) {
    const grid = [], carry = [];
    for (const tr of rows) {
      const out = [];
      let col = 0;
      const fill = () => { while (carry[col] && carry[col].left > 0) { out[col] = carry[col].cell; carry[col].left--; col++; } };
      for (const td of tr.cells) {
        fill();
        const cs = Math.max(1, td.colSpan || 1), rs = Math.max(1, td.rowSpan || 1);
        for (let k = 0; k < cs; k++) { out[col] = td; carry[col] = rs > 1 ? { cell: td, left: rs - 1 } : null; col++; }
      }
      fill();
      grid.push(out);
    }
    return grid;
  }

  // A Halaxy finance report's table: its column names (the last header row) and its body rows as a grid.
  async function reportTable(path, what) {
    const doc = await http.html(path);
    const table = doc.querySelector('table.table-report');
    if (!table) throw new UPCError('Halaxy\'s ' + what + ' report has changed (its table was not found).');
    const all = [...table.rows];
    const head = table.tHead ? [...table.tHead.rows] : all.filter((r) => r.cells.length && [...r.cells].every((c) => c.tagName === 'TH'));
    const body = all.filter((r) => !head.includes(r));
    const hg = cellGrid(head);
    return { names: (hg[hg.length - 1] || []).map((c) => clean(c && c.textContent)), body, grid: cellGrid(body) };
  }
  // ------------------------------------------------------------------ funder deposits (captures 13 Nov 2026)
  // An insurer payment as it reached the bank, held on the insurer's (organisation's) profile, then applied to invoices
  // billed to it. Apply sends only the invoices: each is paid its whole balance, never more than the deposit's balance.
  const isoOf = (s) => (String(s || '').match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
  const deposits = {
    // Every deposit on the profile: { id, type ("Direct Deposit"), day (yyyy-mm-dd), amount, balance (pence) }.
    async list(orgId) {
      const j = await http.json('/organisation/' + encodeURIComponent(orgId) + '/balance/data?viewMode=ajax');
      if (!j || !Array.isArray(j.data)) throw new UPCError('Halaxy\'s deposit list has changed, so the deposits could not be read.');
      return j.data.map((r) => ({ id: String(r.id), type: clean(r.type), day: isoOf(r.date), amount: money.cents(r.amount), balance: money.cents(r.balance) }));
    },
    // A deposit's own date and note, from its Edit pop-up (read only).
    async details(depositId) {
      const { doc } = await http.popup('/invoicefunctions/payment/' + encodeURIComponent(depositId) + '/edit');
      const f = (n) => { const el = doc.querySelector('[name="form[' + n + ']"]'); return el ? clean(el.value) : ''; };
      return { note: f('note'), date: f('paymentDate') || f('date') };
    },
    // Adds a deposit as "Add new > Offline payment" does. `date` dd-Mon-yyyy, `amount` pence. Checks it is listed.
    async add(orgId, { method, date, amount, note }) {
      const before = await deposits.list(orgId);
      const path = '/invoicefunctions/0/pay/offline/0/' + encodeURIComponent(orgId);
      const { doc } = await http.popup(path);
      const form = doc.querySelector('form#paymentForm');
      const sel = form && form.querySelector('select[name="form[paymentMethod]"]');
      const need = ['form[paymentDate]', 'form[amount]', 'form[note]', 'form[_token]'].filter((n) => !form || !form.querySelector('[name="' + n + '"]'));
      if (!sel || need.length) throw new UPCError('Halaxy\'s add deposit pop-up has changed (' + (sel ? need.join(', ') : 'payment method') + ' not found), so nothing was added.');
      const opt = [...sel.options].find((o) => clean(o.textContent).toLowerCase() === String(method).toLowerCase());
      if (!opt) throw new UPCError('"' + method + '" is not a payment method in Halaxy, so nothing was added.');
      const set = { 'form[paymentMethod]': opt.value, 'form[paymentDate]': date, 'form[amount]': (amount / 100).toFixed(2), 'form[note]': note || '' };
      const pairs = serialize(form).filter(([k]) => !(k in set));
      Object.keys(set).forEach((k) => pairs.push([k, set[k]]));
      const res = await http.postForm(path, pairs);
      if (res && res.status === 'FORM') throw new UPCError('Halaxy did not accept the deposit' + (Array.isArray(res.errors) && res.errors.length ? ': ' + res.errors.join(' ') : '.'));
      const added = (await deposits.list(orgId)).filter((d) => !before.some((b) => b.id === d.id) && d.amount === amount);
      if (added.length !== 1) throw new UPCError('Halaxy accepted the deposit but its list ' + (added.length ? 'shows ' + added.length + ' new ones' : 'does not show it') + '. Check the profile\'s deposits.');
      return added[0];
    },
    // Applies a deposit to whole invoices (their full balances). Checks the deposit's balance fell by `total` (pence).
    async apply(orgId, depositId, invoiceIds, total) {
      const before = (await deposits.list(orgId)).find((d) => d.id === String(depositId));
      if (!before) throw new UPCError('The deposit is no longer on the profile, so nothing was applied.');
      if (before.balance < total) throw new UPCError('The deposit has ' + money.fmt(before.balance) + ' left, less than ' + money.fmt(total) + ', so nothing was applied.');
      const path = '/invoicefunctions/payment/' + encodeURIComponent(depositId) + '/allocate';
      const { doc } = await http.popup(path);
      const token = doc.querySelector('form#allocatePaymentForm [name="form[_token]"]');
      if (!token) throw new UPCError('Halaxy\'s apply deposit pop-up has changed, so nothing was applied.');
      const res = await http.postForm(path, invoiceIds.map((id) => ['form[invoices][]', String(id)]).concat([['form[_token]', token.value]]));
      if (res && res.status === 'FORM') throw new UPCError('Halaxy did not apply the deposit' + (Array.isArray(res.errors) && res.errors.length ? ': ' + res.errors.join(' ') : '.'));
      const after = (await deposits.list(orgId)).find((d) => d.id === String(depositId));
      if (!after || after.balance !== before.balance - total) throw new UPCError('Halaxy applied the deposit, but it now has ' + (after ? money.fmt(after.balance) : 'nothing') + ' left, not ' + money.fmt(before.balance - total) + '. Check the profile and the invoices.');
      return after;
    },
    // Insurer profiles seen on invoices (their Bill To), kept on this PC so a bank line with no invoice to go by can
    // still find its insurer's profile, and so the lingering check knows which profiles to look at.
    orgs() { return storage('upc-funder-orgs:').get('list', {}); },
    rememberOrg(orgId, name, insurer) {
      if (!orgId) return;
      const st = storage('upc-funder-orgs:'), all = st.get('list', {});
      const was = all[orgId] || {};
      if (was.name === name && was.insurer === insurer) return;
      all[orgId] = { name: name || was.name || '', insurer: insurer || was.insurer || '' };
      st.set('list', all);
    },
    // The profiles known for an insurer ('Bupa'), as ids.
    orgsFor(insurer) { return Object.entries(deposits.orgs()).filter(([, o]) => o.insurer === insurer).map(([id]) => id); },
    // Deposits from the bank not applied after `days` (no remittance has come for them): a task on the insurer's
    // profile for each. At most once a day per PC, and not while Halaxy is asking us to slow down.
    async lingering({ days, assignee, by }) {
      const st = storage('upc-funder-orgs:');
      const today = dayLabel(Date.now());
      if (st.get('lingerDay', '') === today || http.pausedFor() > 0) return [];
      st.set('lingerDay', today);
      const out = [];
      for (const [orgId, o] of Object.entries(deposits.orgs())) {
        for (const d of await deposits.list(orgId)) {
          const when = parseDay(d.day);
          if (!(d.balance > 0) || when === null || Date.now() - when < days * 86400e3) continue;
          const title = (o.insurer || o.name || 'Insurer') + ' deposit ' + dayLabel(when) + ' ' + money.fmt(d.amount) + ': not applied after ' + days + ' days';
          const added = await tasks.addToOrganisation(orgId, { title, assignee, priority: 2, due: today, by,
            comment: ['The ' + money.fmt(d.amount) + ' deposit from the bank (' + dayLabel(when) + ') on this profile still has ' + money.fmt(d.balance) + ' to apply.',
              'No remittance has been put through Remittances for it yet. Ask the insurer for the remittance, or apply the deposit by hand.'] });
          if (added) out.push(title);
        }
      }
      return out;
    },
  };

  // Files on a funder profile (captures 13 Nov 2026): Add Files, and each file's Edit pop-up.
  async function uploadFile(uploadUrl, file) {
    const fd = new FormData();
    fd.append('file', file, file.name || 'file.pdf');
    const headers = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
    if (window.Hk && window.Hk.jwt) headers.Authorization = 'Bearer ' + window.Hk.jwt;
    const res = await pacedFetch(uploadUrl, { method: 'POST', headers, body: fd, credentials: 'same-origin' });
    if (!res.ok) throw new UPCError('Halaxy returned ' + res.status + ' when uploading the file.');
    const up = await res.json().catch(() => null);
    const stored = up && up.files && up.files[0];
    if (!stored || !stored.id) throw new UPCError('Halaxy did not accept the file' + (stored && stored.error ? ': ' + stored.error : '.'));
    return stored;
  }
  const orgFiles = {
    // The files on a funder profile, as its Attachments box lists them in the page (capture 13 Nov 2026): one
    // div.attachment-file-card per file (data-href its download link), followed by its menu, whose Edit item opens
    // /file/edit/:id. { id, fileUrl, text } in the page's order; text is what the card shows.
    async list(orgId) {
      const doc = await http.html('/organisation/' + encodeURIComponent(orgId));
      const out = [];
      let card = null;
      doc.querySelectorAll('.attachment-file-card, [data-modal-href*="/file/edit/"]').forEach((el) => {
        if (el.classList.contains('attachment-file-card')) { card = { fileUrl: el.getAttribute('data-href'), text: clean(el.textContent) }; return; }
        const id = (el.getAttribute('data-modal-href').match(/\/file\/edit\/(\d+)/) || [])[1];
        if (!id || out.some((f) => f.id === id)) return;
        out.push({ id, fileUrl: card ? card.fileUrl : null, text: card ? card.text : '' });
        card = null;
      });
      return out;
    },
    // The profile's files whose details pass `test({ id, title, comments, fileUrl })`. Only files whose card shows
    // `hint` are opened when any does (each file's details take one request); otherwise the newest `max`.
    async find(orgId, test, hint, max) {
      const all = await orgFiles.list(orgId);
      const hinted = hint ? all.filter((f) => f.text.toLowerCase().includes(String(hint).toLowerCase())) : [];
      const look = hinted.length ? hinted : all.slice(0, max || 25);
      const out = [];
      for (const f of look) {
        const d = await orgFiles.details(f.id);
        d.fileUrl = d.fileUrl || f.fileUrl;
        if (test(d)) out.push(d);
      }
      return out;
    },
    // A file's title, comments and download link, from its Edit pop-up (read only).
    async details(fileId) {
      const { doc } = await http.popup('/file/edit/' + encodeURIComponent(fileId));
      const form = doc.querySelector('form#fileupload');
      const v = (n) => { const el = form && form.querySelector('[name="form[' + n + ']"]'); return el ? clean(el.value) : ''; };
      const card = doc.querySelector('[data-href*="/file/get/"]');
      if (!form) throw new UPCError('Halaxy\'s file edit pop-up has changed, so the file could not be read.');
      return { id: String(fileId), title: v('title'), comments: v('comments'), fileUrl: card ? card.getAttribute('data-href') : null };
    },
    // New title and comments; `append` adds to the comment as it is, once (title kept when not given).
    async update(fileId, { title, comments, append }) {
      const path = '/file/edit/' + encodeURIComponent(fileId);
      const { doc } = await http.popup(path);
      const form = doc.querySelector('form#fileupload');
      if (!form || !form.querySelector('[name="form[title]"]') || !form.querySelector('[name="form[comments]"]') || !form.querySelector('[name="form[_token]"]')) throw new UPCError('Halaxy\'s file edit pop-up has changed, so the details were not updated.');
      const was = (n) => clean(form.querySelector('[name="form[' + n + ']"]').value);
      if (title === undefined) title = was('title');
      if (append) comments = was('comments').includes(clean(append)) ? was('comments') : [was('comments'), append].filter(Boolean).join('; ');
      const pairs = serialize(form).filter(([k]) => k !== 'form[title]' && k !== 'form[comments]');
      pairs.push(['form[title]', title], ['form[comments]', comments || '']);
      const res = await http.postForm(path, pairs);
      if (res && res.status === 'FORM') throw new UPCError('Halaxy did not accept the new details' + (Array.isArray(res.errors) && res.errors.length ? ': ' + res.errors.join(' ') : '.'));
      const back = await orgFiles.details(fileId);
      if (back.title !== clean(title) || !back.comments.includes(clean(comments || '').slice(0, 60))) throw new UPCError('Halaxy does not show the new details on the file. Check the profile.');
      return true;
    },
    // Attaches a file to a funder profile as Add Files does. Returns the new file's id (its Edit pop-up's).
    async attach(orgId, file, { title, comments }) {
      const before = await orgFiles.list(orgId);
      const path = '/file/upload/organisation/' + encodeURIComponent(orgId);
      const { doc, json } = await http.popup(path);
      const form = doc.querySelector('form#fileupload, form.js-file-edit-form');
      const uploadUrl = form && form.getAttribute('data-upload-url');
      const token = form && form.querySelector('[name="form[_token]"]');
      if (!uploadUrl || !token) throw new UPCError('The profile\'s Add Files pop-up has changed, so the file was not attached.');
      const stored = await uploadFile(uploadUrl + (/[?&]organisation=/.test(uploadUrl) ? '' : (uploadUrl.includes('?') ? '&' : '?') + 'organisation=' + encodeURIComponent(orgId)), file);
      // The category Halaxy's own pop-up offers for a profile file (its template), else none.
      const cat = (String((json && json.message) || '').match(/name="form\[files\]\[[^\]]*\]\[category\]"[^>]*value="([^"]+)"/) || String((json && json.message) || '').match(/value="([^"]+)"[^>]*name="form\[files\]\[[^\]]*\]\[category\]"/) || [])[1] || '';
      const res = await http.postForm(path, [['form[files][1][fileEntity]', String(stored.id)], ['form[files][1][title]', title], ['form[files][1][comments]', comments || ''], ['form[files][1][category]', cat], ['form[_token]', token.value]]);
      if (res && res.status === 'FORM') throw new UPCError('Halaxy did not attach the file' + (Array.isArray(res.errors) && res.errors.length ? ': ' + res.errors.join(' ') : '.'));
      const added = (await orgFiles.list(orgId)).filter((f) => !before.some((b) => b.id === f.id));
      if (added.length !== 1) throw new UPCError('Halaxy accepted the file but the profile ' + (added.length ? 'shows ' + added.length + ' new files' : 'does not show it') + '. Check the profile.');
      return added[0].id;
    },
  };

  const reports = {
    // Halaxy's Unpaid Invoices report (Reports > Finance, type 5) from `start` ('09-May-2026'): one row per
    // fee line of every unpaid invoice, active or issued. Columns confirmed live 10 Nov 2026. An invoice's later
    // fee rows leave the Invoice cell blank, and invoice-level cells (date, status, balance) appear on only one of
    // its rows; every line returned carries its invoice and the invoice's values.
    async unpaidLines(start) {
      const p = new URLSearchParams([['type', '5'], ['start', start], ['unpaid', '0'], ['overdue', 'all'], ['showTotalMode', '0'],
        ['incomeType', 'paymentMethods'], ['invoicestatuses', 'active'], ['invoicestatuses', 'issued'], ['displayNames', '1'],
        ['plTaxTypeStatus', 'exclusive'], ['lineStatus', 'write-off'], ['lineStatus', 'voided'],
        ['usedDepositOption', 'all'], ['creditSummaryOption', 'summary'], ['clicked', String(Date.now())]]);
      const { names, body, grid } = await reportTable('/report/finance/0?' + p.toString(), 'Unpaid Invoices');
      const col = (n) => names.indexOf(n);
      const need = ['Invoice / Deposit', 'Date', 'Payer ID', 'Payer', 'Funder', 'Fee', 'Appointment Status', 'Invoice Status', 'Amount'];
      const missing = need.filter((n) => col(n) < 0);
      if (missing.length) throw new UPCError('Halaxy\'s Unpaid Invoices report has changed (' + missing.join(', ') + ' not found).');
      const balanceCol = names.lastIndexOf('Balance');
      const out = [];
      let last = null;
      grid.forEach((row, ri) => {
        if ([...body[ri].cells].some((td) => (td.colSpan || 1) > 3)) return;   // totals and headings
        const cell = (n) => { const i = typeof n === 'number' ? n : col(n); return i < 0 ? '' : clean(row[i] && row[i].textContent); };
        const link = row[col('Invoice / Deposit')] && row[col('Invoice / Deposit')].querySelector('a[href*="/invoice/"]');
        let invoiceId = link ? (link.getAttribute('href').match(/\/invoice\/(\d+)/) || [])[1] || null : null;
        const text = cell('Invoice / Deposit');
        // An invoice's second and later fees leave the Invoice cell blank (live, 12 Nov 2026: UPC-37737, two fees):
        // they belong to the invoice above.
        if (!invoiceId && last && last.invoiceId && (!text || text === last.invoice)) invoiceId = last.invoiceId;
        const same = !!last && !!invoiceId && last.invoiceId === invoiceId;
        const line = {
          invoiceId, invoice: text || (same ? last.invoice : ''),
          date: cell('Date') || (same ? last.date : ''), invoiceStatus: cell('Invoice Status') || (same ? last.invoiceStatus : ''),
          balance: balanceCol >= 0 && cell(balanceCol) ? money.cents(cell(balanceCol)) : (same ? last.balance : null),
          payerId: cell('Payer ID') || (same ? last.payerId : ''), payer: cell('Payer') || (same ? last.payer : ''),
          funder: cell('Funder') || (same ? last.funder : ''), category: cell('Category'), fee: cell('Fee'),
          apptStatus: cell('Appointment Status'), amount: money.cents(cell('Amount')),
        };
        out.push(line);
        last = line;
      });
      // Invoice-level cells sit on one of an invoice's lines only (the balance on its last line, live 12 Nov 2026), so
      // every line gets the invoice's values, whichever line carries them.
      const byInv = new Map();
      out.forEach((l) => { if (l.invoiceId) { if (!byInv.has(l.invoiceId)) byInv.set(l.invoiceId, []); byInv.get(l.invoiceId).push(l); } });
      byInv.forEach((ls) => {
        ['date', 'invoiceStatus', 'payerId', 'payer', 'funder'].forEach((k) => { const v = (ls.find((l) => l[k]) || {})[k]; if (v) ls.forEach((l) => { l[k] = v; }); });
        const withBal = ls.filter((l) => l.balance !== null && l.balance !== undefined);
        if (withBal.length) { const b = withBal[withBal.length - 1].balance; ls.forEach((l) => { l.balance = b; }); }
      });
      return out;
    },
    // Every payment recorded in Halaxy between two days (Halaxy's Income report, Finance type 1, filtered by the payment's
    // date; capture 12 Nov 2026): one entry per payment, { invoiceId, invoice, payer, funder, date (dd-Mon-yyyy, the
    // payment's), method, amount (pence) }. An invoice with several fees has a row per fee; its first row links the
    // invoice and gives the payer and funder; a second payment sits on a later row, which repeats the number unlinked.
    async paymentLines(start, stop) {
      const p = new URLSearchParams([['type', '1'], ['tyropm', '19'], ['start', start], ['stop', stop], ['altDate', ''], ['transferStart', ''],
        ['transferStop', ''], ['transferAltDate', ''], ['startExpiry', ''], ['stopExpiry', ''], ['aa', ''], ['pr', ''], ['loc', ''], ['clinic', ''],
        ['overdueDays', ''], ['payer', 'All'], ['patient', ''], ['organisation', ''], ['autopm', ''], ['showTotalMode', '0'], ['ecat', ''], ['aob', ''],
        ['incomeType', 'paymentMethods'], ['displayNames', '1'], ['rstat', ''], ['rtype', ''], ['rstype', ''], ['xc', ''], ['rc', ''], ['qc', ''],
        ['plTaxTypeStatus', 'exclusive'], ['lineStatus', 'write-off'], ['lineStatus', 'voided'], ['usedDepositOption', 'all'],
        ['creditSummaryOption', 'summary'], ['clicked', String(Date.now())]]);
      const { names, body, grid } = await reportTable('/report/finance/0?' + p.toString(), 'Income');
      const col = (n) => names.indexOf(n);
      const invCol = col('Invoice / Deposit'), payCol = col('Payments'), dateCol = names.lastIndexOf('Date'), methodCol = col('Method');
      const missing = ['Invoice / Deposit', 'Payer', 'Funder', 'Payments', 'Method'].filter((n) => col(n) < 0);
      if (dateCol <= col('Date')) missing.push('the payment Date');
      if (missing.length) throw new UPCError('Halaxy\'s Income report has changed (' + missing.join(', ') + ' not found).');
      const num = (t) => (String(t || '').match(/UPC-?0*(\d+)/i) || [])[1] || '';
      const out = [];
      let cur = null;
      grid.forEach((row, ri) => {
        if ([...body[ri].cells].some((td) => (td.colSpan || 1) > 3)) return;   // totals and headings
        const cell = (i) => (i < 0 ? '' : clean(row[i] && row[i].textContent));
        const link = row[invCol] && row[invCol].querySelector('a[href*="/invoice/"]');
        const text = cell(invCol);
        if (link) cur = { invoiceId: (link.getAttribute('href').match(/\/invoice\/(\d+)/) || [])[1] || null, invoice: text, payer: cell(col('Payer')), funder: cell(col('Funder')) };
        else if (text && (!cur || num(text) !== num(cur.invoice))) cur = { invoiceId: null, invoice: text, payer: cell(col('Payer')), funder: cell(col('Funder')) };
        if (!cur) return;
        const method = cell(methodCol), amount = money.cents(cell(payCol));
        if (method && amount !== null) out.push(Object.assign({}, cur, { date: cell(dateCol), method, amount }));
      });
      return out;
    },
    // Ids of patient invoices Halaxy lists as Pending: billed to a funder, waiting for its payment.
    async pendingInvoiceIds() {
      const ids = new Set();
      for (let start = 0; start < 2000; start += 100) {
        const res = await http.list('/invoice/list-data', { status: { filterType: 'text', type: 'contains', filter: 'Pending' } }, [], start, start + 100);
        const rows = (res && res.rowData) || [];   // ag-Grid answer: { rowData, lastRow }
        rows.forEach((r) => { if (r && r.id !== undefined) ids.add(String(r.id)); });
        if (rows.length < 100 || (typeof res.lastRow === 'number' && res.lastRow >= 0 && start + 100 >= res.lastRow)) break;
      }
      return ids;
    },
  };

  // ------------------------------------------------------------------ tasks

  // Halaxy's add-task pop-up for an invoice (the invoice page's add-task button, confirmed live 9 Nov 2026):
  // GET /task/new/invoice/{id} returns form#form_task_edit; POST the same address with its fields.
  // Halaxy answers { status: 'POPUP', url: '/task/list/invoice/{id}' } and lists the invoice's tasks at
  // /task/invoice/{id}/list-data.
  // A patient's tasks (the profile's Tasks box, confirmed live 11 Nov 2026): GET /task/linkPaG/{linkPaGId}/list-data,
  // an array of { id, title, assignees, comment, priority, status, dueDate, editRoute, action }; its Add Task button
  // opens GET /task/new/linkPaG/{linkPaGId}, the same form#form_task_edit as an invoice's.
  const tasks = {
    async forInvoice(invoiceId) {
      return http.json('/task/invoice/' + encodeURIComponent(invoiceId) + '/list-data');
    },
    async forPatient(linkPaGId) {
      const j = await http.json('/task/linkPaG/' + encodeURIComponent(linkPaGId) + '/list-data');
      const rows = Array.isArray(j) ? j : (j && (j.rowData || j.data));
      if (!Array.isArray(rows)) throw new UPCError('The patient\'s task list has changed, so their tasks could not be read.');
      return rows;
    },
    // A stamp (Carl, 11 Nov 2026): "2026-11-11 15:45 Portal fill" (the date, the time, and who: a script's name or a person's
    // initials), on its own line with the notes below it.
    stamp(by, when) {
      const d = new Date(when || Date.now());
      const p2 = (n) => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ' ' + by;
    },
    // A script's task comment (Carl, 11 Nov 2026): the stamp, then each statement on its own line starting "- ".
    // `lines` is an array or text with line breaks; blank lines are dropped.
    comment(by, lines) {
      const list = (Array.isArray(lines) ? lines : String(lines || '').split('\n')).map((l) => clean(l).replace(/^[-*•]\s*/, '')).filter(Boolean);
      return [tasks.stamp(by || 'UPC scripts')].concat(list.map((l) => '- ' + l)).join('\n');
    },
    // { title, assignee (name as in Assign to), priority 1 Low / 2 Medium / 3 High, due '09-Nov-2026', comment, by (the script's name) }.
    // The comment is written as tasks.comment(by, comment).
    // Returns false if a task with this title is already on the invoice.
    async addToInvoice(invoiceId, task) {
      return addTask('/task/new/invoice/' + encodeURIComponent(invoiceId), () => tasks.forInvoice(invoiceId), task, 'on the invoice\'s task list');
    },
    // As addToInvoice, on the patient's profile. `task.key` (optional) is text the task's title or comment carries
    // so it is recognised later; without it the title is used. Returns false if the patient already has it.
    async addToPatient(linkPaGId, task) {
      return addTask('/task/new/linkPaG/' + encodeURIComponent(linkPaGId), () => tasks.forPatient(linkPaGId), task, 'in the patient\'s tasks');
    },
    // On a funder (organisation) profile (capture 13 Nov 2026: /task/new/organisation/:org, the same form).
    async forOrganisation(orgId) {
      const j = await http.json('/task/organisation/' + encodeURIComponent(orgId) + '/list-data');
      const rows = Array.isArray(j) ? j : (j && (j.rowData || j.data));
      if (!Array.isArray(rows)) throw new UPCError('The profile\'s task list has changed, so its tasks could not be read.');
      return rows;
    },
    async addToOrganisation(orgId, task) {
      return addTask('/task/new/organisation/' + encodeURIComponent(orgId), () => tasks.forOrganisation(orgId), task, 'on the profile\'s task list');
    },
    // A general task, as Tasks & Follow-ups' New task (/task/new). No list to check against, so it is added each time.
    async addGeneral(task) {
      return addTask('/task/new', null, task, '');
    },
  };
  async function addTask(path, list, task, where) {
    const mark = String(task.key || task.title).replace(/["\\]/g, '');
    const listed = (rows) => JSON.stringify(rows || '').includes(mark);
    if (list && listed(await list().catch(() => null))) return false;
    const { doc } = await http.popup(path + '?clicked=' + Date.now());
    const form = doc.querySelector('form#form_task_edit');
    const need = ['form[title]', 'form[linkPrGs][]', 'form[priority]', 'form[displayDueDate]', 'form[comment]', 'form[_token]'];
    const missing = need.filter((k) => !form || !form.querySelector('[name="' + k + '"]'));
    if (missing.length) throw new UPCError('The add-task pop-up has changed (' + missing.join(', ') + ' not found), so no task was added.');
    const who = [...form.querySelectorAll('select[name="form[linkPrGs][]"] option')].find((o) => clean(o.textContent).toLowerCase() === String(task.assignee).toLowerCase());
    if (!who) throw new UPCError('Could not find ' + task.assignee + ' in the task\'s Assign to list, so no task was added.');
    const set = { 'form[title]': task.title, 'form[taskTemplates]': '', 'form[actionerType]': '1', 'form[priority]': String(task.priority || 2),
      'form[displayDueDate]': task.due, 'form[displayDueTime][hour]': '0', 'form[displayDueTime][minute]': '0', 'form[isTimeSet]': 'false', 'form[comment]': tasks.comment(task.by, task.comment) };
    const pairs = serialize(form).filter(([k]) => k !== 'form[linkPrGs][]' && !(k in set));
    Object.keys(set).forEach((k) => pairs.push([k, set[k]]));
    pairs.push(['form[linkPrGs][]', who.value]);
    const res = await http.postForm(path, pairs);
    if (!res || !['POPUP', 'REFRESH', 'OK'].includes(res.status)) http.expectRefresh(res, 'Adding the task');
    if (list && !listed(await list())) throw new UPCError('Halaxy accepted the task, but it does not show ' + where + '.');
    return true;
  }

  // ------------------------------------------------------------------ appointments

  const appointment = {
    // The appointment's comments (the details pop-up's "Notes" box), as plain text with line breaks.
    // '' when there are none. Confirmed on live Halaxy 9 Nov 2026: GET /appointment/{id} with
    // X-Requested-With returns div.appointment-details-popup, where div.subTitle "Notes" is followed
    // by the comment's div. The calendar's own `note` field is empty for these.
    async notes(id) {
      const doc = await http.fragment('/appointment/' + encodeURIComponent(id));
      const box = doc.querySelector('.appointment-details-popup');
      if (!box) throw new UPCError('The appointment details pop-up has changed, so its comments could not be read.');
      const head = [...box.querySelectorAll('.subTitle')].find((h) => /^\s*notes\s*$/i.test(h.textContent));
      const body = head && head.nextElementSibling;
      if (!body) return '';
      body.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
      return body.textContent.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
    },
  };

  // ------------------------------------------------------------------ clinical notes

  // Confirmed on live Halaxy 10 Nov 2026. The notes list (GET /note/menu/linkPaG/{linkPaGId}/items,
  // payload.menuItems, nested in items[]) holds appointment notes ("appointment" / "note"), other
  // notes ("note" / "note"), forms ("form" / "intake-form-invite") and tools ("tool" / "note").
  // A note's text: GET /note/{id}, JSON with HTML in content (and contentQuestions for template answers).
  // Note text is patient data: callers use it in the page and never store or send it anywhere.
  const notes = {
    // [{ id, noteId, category, entity, label, date (ms or null), status }], newest first.
    async items(linkPaGId) {
      const j = await http.json('/note/menu/linkPaG/' + encodeURIComponent(linkPaGId) + '/items');
      const list = j && j.payload && j.payload.menuItems;
      if (!Array.isArray(list)) throw new UPCError('The patient\'s notes list has changed, so their notes could not be read.');
      const out = [];
      const walk = (items) => (items || []).forEach((it) => {
        if (!it) return;
        const digits = [it.id, it.linkId, it.key].map((v) => String(v === null || v === undefined ? '' : v)).map((v) => (/^\d+$/.test(v) ? v : (v.match(/(\d{4,})$/) || [])[1])).find(Boolean);
        out.push({ id: String(it.id), noteId: digits || null, category: it.category || '', entity: it.entity || '', label: clean(it.label || it.title || ''),
          date: typeof it.sortDate === 'number' && it.sortDate > 0 ? (it.sortDate > 1e12 ? it.sortDate : it.sortDate * 1000) : parseDay(it.date), status: it.status || '' });
        walk(it.items);
      });
      walk(list);
      return out.sort((a, b) => (b.date || 0) - (a.date || 0));
    },
    async text(noteId) {
      const j = await http.json('/note/' + encodeURIComponent(noteId));
      if (!j || (typeof j.content !== 'string' && typeof j.final !== 'string')) throw new UPCError('Clinical notes have changed, so a note could not be read.');
      const doc = htmlDoc('<div>' + (j.content || j.final || '') + '</div><div>' + (j.contentQuestions || '') + '</div>');
      doc.querySelectorAll('br, p, div, li, tr, h1, h2, h3, h4, h5, h6').forEach((e) => e.append(' '));
      return clean(doc.body.textContent);
    },
  };

  // ------------------------------------------------------------------ follow-ups

  // Halaxy's Tasks & Follow-Ups (confirmed live 10 Nov 2026).
  //  - List: GET /task/task-followup/list/data, an array of { id, title, status ('Sent', 'Scheduled'),
  //    scheduledOrSentDate (ISO), assignedTo (the patient's name), assignedToUrl (/a/pr/{pg}/patient/{linkPaGId}),
  //    linkedTo / linkedToUrl / linkedToId (the clinical note it was added from; empty when added from the
  //    patient's profile, as ours are: live, 10 Nov 2026), method, ... }. The patient comes from assignedToUrl.
  //  - Add: the Add Follow-Up pop-up, GET/POST /task/patient/{linkPaGId}/task-followup/create: form[recallTemplate]
  //    (follow-up template), form[title], form[isEmailMethod], form[isSmsMethod], form[scheduleAt][date],
  //    form[scheduleAt][time][hour|minute], form[intakeFormTemplate], form[emailTemplate], form[smsTemplate], form[_token].
  const FOLLOWUP_TZ = 'Australia/Sydney';
  const followUps = {
    async list() {
      const j = await http.json('/task/task-followup/list/data');
      const rows = Array.isArray(j) ? j : (j && (j.rowData || j.data));
      if (!Array.isArray(rows)) throw new UPCError('The follow-ups list has changed, so follow-ups could not be read.');
      const pat = (u) => (String(u || '').match(/\/patient\/(\d+)/) || [])[1];
      return rows.map((r) => Object.assign({}, r, { linkPaGId: pat(r.assignedToUrl) || pat(r.linkedToUrl) || '' }));
    },
    // Adds an email follow-up from a follow-up template and email template (matched by name), scheduled for `when`
    // (a Date; if left out, the next 5 minutes from 10 minutes' time, as Halaxy refuses a time that isn't in the
    // future: live, 10 Nov 2026). Checks the follow-ups list afterwards.
    async add(linkPaGId, o) {
      const path = '/task/patient/' + encodeURIComponent(linkPaGId) + '/task-followup/create';
      const { doc } = await http.popup(path);
      const form = doc.querySelector('form#form-recall-template') || [...doc.querySelectorAll('form')].find((f) => f.querySelector('[name="form[title]"]'));
      const need = ['form[recallTemplate]', 'form[title]', 'form[isEmailMethod]', 'form[scheduleAt][date]', 'form[scheduleAt][time][hour]', 'form[scheduleAt][time][minute]', 'form[emailTemplate]', 'form[_token]'];
      const missing = need.filter((k) => !form || !form.querySelector('[name="' + k + '"]'));
      if (missing.length) throw new UPCError('The Add Follow-Up pop-up has changed (' + missing.join(', ') + ' not found), so nothing was sent.');
      const pick = (name, text) => {
        const opt = [...form.querySelectorAll('select[name="' + name + '"] option')].find((x) => clean(x.textContent).toLowerCase() === String(text).toLowerCase());
        if (!opt) throw new UPCError('"' + text + '" is not in the Add Follow-Up pop-up\'s list, so nothing was sent.');
        return opt.value;
      };
      const when = o.when || (() => { const d = new Date(Date.now() + 10 * 60e3); d.setSeconds(0, 0); d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5); return d; })();
      const two = (n) => String(n).padStart(2, '0');
      // Halaxy's follow-ups read the date and time typed in as Sydney time, whatever the practice's time zone:
      // 11-Nov 10:30 entered went on the list, and out, at 23:30 UK time on 10-Nov (live, 10 Nov 2026; Carl:
      // "they actually go out at the evening time displayed"). So the time is entered as Sydney's clock reads
      // at the moment it should go, and checked against the list afterwards.
      const p = {};
      new Intl.DateTimeFormat('en-GB', { timeZone: FOLLOWUP_TZ, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
        .formatToParts(when).forEach((x) => { p[x.type] = Number(x.value); });
      const typed = new Date(p.year, p.month - 1, p.day, p.hour, p.minute);
      const timeOpt = (name, n) => { const x = [...form.querySelectorAll('select[name="' + name + '"] option')].find((op) => Number(clean(op.textContent)) === n); return x ? x.value : two(n); };
      const email = form.querySelector('[name="form[isEmailMethod]"]');
      const set = {
        // The follow-up template isn't imported: Halaxy then sets its own send time from the template (a review request
        // sent at 21:30 went on the list for 23:30: live, 10 Nov 2026). The title, email and time are set here instead.
        'form[recallTemplate]': '', 'form[title]': o.title || o.template, 'form[isEmailMethod]': email.value || '1',
        'form[scheduleAt][date]': dayLabel(typed.getTime()), 'form[scheduleAt][time][hour]': timeOpt('form[scheduleAt][time][hour]', typed.getHours()),
        'form[scheduleAt][time][minute]': timeOpt('form[scheduleAt][time][minute]', typed.getMinutes()), 'form[emailTemplate]': pick('form[emailTemplate]', o.emailTemplate || o.template),
      };
      const pairs = serialize(form).filter(([k]) => !(k in set) && k !== 'form[isSmsMethod]');
      Object.keys(set).forEach((k) => pairs.push([k, set[k]]));
      const before = (await followUps.list()).filter((r) => r.linkPaGId === String(linkPaGId)).map((r) => String(r.id));
      const res = await http.postForm(path, pairs);
      if (!res || !['POPUP', 'REFRESH', 'OK'].includes(res.status)) http.expectRefresh(res, 'Adding the follow-up');
      const added = (await followUps.list()).find((r) => r.linkPaGId === String(linkPaGId) && !before.includes(String(r.id)) && clean(r.title).toLowerCase() === String(set['form[title]']).toLowerCase());
      if (!added) throw new UPCError('Halaxy accepted the follow-up, but it does not show in Tasks & Follow-Ups.');
      const listed = Date.parse(added.scheduledOrSentDate);
      if (!isNaN(listed) && Math.abs(listed - when.getTime()) > 5 * 60e3) {
        const t = (ms) => dayLabel(ms) + ' ' + new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        throw new UPCError('The follow-up is in Tasks & Follow-Ups for ' + t(listed) + ', not ' + t(when.getTime()) + ': Halaxy\'s follow-up times may have changed. Please check it there.');
      }
      return added;
    },
  };

  // ------------------------------------------------------------------ patients

  // Halaxy's patient search box (confirmed live 11 Nov 2026): GET /a/magic/lookup/patient?includeContacts=1&term=...&_locale={the number in /a/pr/{n}/}
  // returns { lookup: [{ id, title, payload: { pag: { id = linkPaGId, ... }, detail: { dob: { uDate 'yyyy-mm-dd', ... } }, ... } }] }.
  const nameKey = (s) => clean(String(s || '').replace(/\([^)]*\)/g, ' ').replace(/^(mr|mrs|ms|miss|mx|dr|master|prof)\.?\s+/i, '')).toLowerCase();
  let lookupLocale;
  const patient = {
    nameKey,
    // The linkPaGId of the patient with this name and date of birth (ms, as parseDay gives), or null when there's
    // no such patient or more than one could be meant. Without a date of birth, only a single match counts.
    async find(name, dob) {
      const term = nameKey(name);
      if (!term) return null;
      if (lookupLocale === undefined) { try { lookupLocale = JSON.parse(localStorage.getItem('upc-core:lookupLocale')); } catch (e) { lookupLocale = null; } }
      // The search box sends the practice number from the page address (live, 11 Nov 2026; HkUser.linkPrG gets an HTML page back).
      const tries = [lookupLocale, pg(), ''].filter((x, i, a) => x !== null && x !== undefined && a.indexOf(x) === i);
      let hits = null;
      for (const loc of tries) {
        const q = new URLSearchParams({ includeContacts: '1', term });
        if (loc !== '') q.set('_locale', String(loc));
        const j = await http.json('/a/magic/lookup/patient?' + q.toString()).catch(() => null);
        if (j && Array.isArray(j.lookup)) {
          hits = j.lookup;
          if (lookupLocale !== loc) { lookupLocale = loc; try { localStorage.setItem('upc-core:lookupLocale', JSON.stringify(loc)); } catch (e) { /* storage blocked */ } }
          break;
        }
      }
      if (!hits) throw new UPCError('Halaxy\'s patient search has changed, so the patient could not be found.');
      const people = hits.map((h) => {
        const p = (h && h.payload) || {};
        const d = p.detail && p.detail.dob;
        return { id: p.pag && p.pag.id ? String(p.pag.id) : null, name: nameKey(p.quickAddValue || h.title || ''), dob: d ? parseDay(d.uDate || d.date || '') : null };
      }).filter((x) => x.id);
      const named = people.filter((x) => x.name === term || x.name.startsWith(term + ' '));
      const pool = named.length ? named : people;
      if (dob) {
        const same = pool.filter((x) => x.dob === dob);
        return same.length === 1 ? same[0].id : null;
      }
      return pool.length === 1 ? pool[0].id : null;
    },
    // The notes sidebar's patient details (GET /note/sidebar/linkPaG/{linkPaGId}): fullName, status, dob, userLabels, ...
    async details(linkPaGId) {
      const j = await http.json('/note/sidebar/linkPaG/' + encodeURIComponent(linkPaGId));
      if (!j || !j.patientDetails) throw new UPCError('The patient details have changed, so they could not be read.');
      return j.patientDetails;
    },
    // Unpaid patient invoices (GET /patient/invoice/{linkPaGId}/list-data: id, total, balance, status).
    async invoices(linkPaGId) {
      const j = await http.json('/patient/invoice/' + encodeURIComponent(linkPaGId) + '/list-data');
      const rows = Array.isArray(j) ? j : (j && (j.rowData || j.data));
      if (!Array.isArray(rows)) throw new UPCError('The patient\'s invoice list has changed, so it could not be read.');
      return rows;
    },
    // Adds a label (by name) on the patient's Edit page (form#patientGeneralEditForm, confirmed live 10 Nov 2026),
    // sending the form exactly as Halaxy filled it with only the label added, then reads the page again to check
    // that the label is there and nothing else changed. False if the patient already has it.
    async addLabel(linkPaGId, name) {
      const path = '/patient/' + encodeURIComponent(linkPaGId) + '/edit';
      const FIELD = 'patientdetailmain[linkPaG][userLabels][]';
      const read = async () => {
        const doc = await http.html(path);
        const form = doc.querySelector('form#patientGeneralEditForm');
        const sel = form && form.querySelector('select[name="' + FIELD + '"]');
        if (!sel || !form.querySelector('[name="patientdetailmain[_token]"]')) throw new UPCError('The patient Edit page has changed, so the label was not added.');
        const opt = [...sel.options].find((x) => clean(x.textContent).toLowerCase() === String(name).toLowerCase());
        if (!opt) throw new UPCError('There is no "' + name + '" label in Halaxy yet (practice profile, Manage labels), so it was not added.');
        return { form, opt };
      };
      const { form, opt } = await read();
      if (opt.selected) return false;
      const was = serialize(form).filter(([k]) => k !== 'patientdetailmain[_token]');
      opt.selected = true;
      const pairs = serialize(form);
      const save = form.querySelector('[name="save_patient"]');
      if (save && !pairs.some(([k]) => k === 'save_patient')) pairs.push(['save_patient', save.value || '']);
      const body = new URLSearchParams();
      pairs.forEach(([k, v]) => body.append(k, v));
      const res = await pacedFetch(url(path), { method: 'POST', credentials: 'same-origin', body: body.toString(),
        headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, JSON_HEADERS) });
      if (!res.ok) throw new UPCError('Halaxy returned ' + res.status + ' when saving the patient.');
      const after = await read();
      if (!after.opt.selected) throw new UPCError('Halaxy did not keep the "' + name + '" label. Add it on the patient\'s Edit page instead.');
      const now = serialize(after.form).filter(([k]) => k !== 'patientdetailmain[_token]' && k !== FIELD).map((x) => x.join('='));
      const changed = was.filter(([k]) => k !== FIELD).map((x) => x.join('=')).filter((x) => !now.includes(x));
      if (changed.length) throw new UPCError('The label was added, but these details now read differently on the Edit page: ' + changed.map((x) => x.split('=')[0]).join(', ') + '. Please check the patient.');
      return true;
    },
    // Sets the patient's status on their Edit page (select patientdetailmain[linkPaG][customStatus], options valued
    // by name: current, claimant, discharged, review...; capture 11 Nov 2026), sending the form exactly as Halaxy
    // filled it with only the status changed, then reads it back. Only from `from` (what the caller saw), so a
    // status someone changed meanwhile is left alone. False if it's already `to`.
    async setStatus(linkPaGId, from, to) {
      const path = '/patient/' + encodeURIComponent(linkPaGId) + '/edit';
      const FIELD = 'patientdetailmain[linkPaG][customStatus]';
      const read = async () => {
        const doc = await http.html(path);
        const form = doc.querySelector('form#patientGeneralEditForm');
        const sel = form && form.querySelector('select[name="' + FIELD + '"]');
        if (!sel || !form.querySelector('[name="patientdetailmain[_token]"]')) throw new UPCError('The patient Edit page has changed (status not found), so the status was not changed.');
        return { form, sel };
      };
      const { form, sel } = await read();
      const now0 = String(sel.value || '').toLowerCase();
      if (now0 === String(to).toLowerCase()) return false;
      if (from && now0 !== String(from).toLowerCase()) throw new UPCError('The status is now ' + (now0 || 'blank') + ', not ' + from + ', so it was left alone.');
      const opt = [...sel.options].find((x) => x.value.toLowerCase() === String(to).toLowerCase());
      if (!opt) throw new UPCError('There is no "' + to + '" status in Halaxy\'s list, so it was not changed.');
      const was = serialize(form).filter(([k]) => k !== 'patientdetailmain[_token]' && k !== FIELD);
      [...sel.options].forEach((x) => { x.selected = x === opt; });
      const pairs = serialize(form);
      const save = form.querySelector('[name="save_patient"]');
      if (save && !pairs.some(([k]) => k === 'save_patient')) pairs.push(['save_patient', save.value || '']);
      const body = new URLSearchParams();
      pairs.forEach(([k, v]) => body.append(k, v));
      const res = await pacedFetch(url(path), { method: 'POST', credentials: 'same-origin', body: body.toString(),
        headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, JSON_HEADERS) });
      if (!res.ok) throw new UPCError('Halaxy returned ' + res.status + ' when saving the patient.');
      const after = await read();
      if (String(after.sel.value).toLowerCase() !== opt.value.toLowerCase()) throw new UPCError('Halaxy did not keep the new status. Change it on the patient\'s Edit page instead.');
      const now = serialize(after.form).filter(([k]) => k !== 'patientdetailmain[_token]' && k !== FIELD).map((x) => x.join('='));
      const changed = was.map((x) => x.join('=')).filter((x) => !now.includes(x));
      if (changed.length) throw new UPCError('The status was changed, but these details now read differently on the Edit page: ' + changed.map((x) => x.split('=')[0]).join(', ') + '. Please check the patient.');
      return true;
    },
  };

  // ------------------------------------------------------------------ patient forms

  // Forms patients fill in (intake forms), confirmed on live Halaxy 10 Nov 2026:
  //  - The patient's notes list, GET /note/menu/linkPaG/{linkPaGId}/items, JSON payload.menuItems[]
  //    (nested in items[]). A filled form is an item with category "form", entity "intake-form-invite",
  //    id = the form's id, label = the template name ("Initial Assessment Form - Bupa"), date dd-Mon-yyyy.
  //  - The form, GET /setting/clinical/patient/intake/{id}, JSON whose message is HTML. Each question is
  //    a span.answerName inside p.answerContainer; its answer is the span.answer-wrap that follows.
  // Answers are patient data: callers use them in the page and never store or send them anywhere.
  const forms = {
    async list(linkPaGId) {
      const j = await http.json('/note/menu/linkPaG/' + encodeURIComponent(linkPaGId) + '/items');
      const items = j && j.payload && j.payload.menuItems;
      if (!Array.isArray(items)) throw new UPCError('The patient\'s notes list has changed, so their forms could not be found.');
      const out = [];
      const walk = (list) => (list || []).forEach((it) => {
        if (it && it.category === 'form' && /intake-form/.test(it.entity || '')) {
          out.push({ id: String(it.id), label: clean(it.label || it.title || ''), date: parseDay(it.date), status: it.status || '' });
        }
        if (it && Array.isArray(it.items)) walk(it.items);
      });
      walk(items);
      return out.sort((a, b) => (b.date || 0) - (a.date || 0));
    },
    // [{ question, answer }] in the form's order; answer '' when left blank.
    async answers(id) {
      const j = await http.json('/setting/clinical/patient/intake/' + encodeURIComponent(id));
      const doc = htmlDoc(j && j.message);
      const qs = [...doc.querySelectorAll('.answerName')];
      if (!qs.length) throw new UPCError('The intake form layout has changed, so its answers could not be read.');
      const answerFor = (q) => {
        const box = q.closest('.answerContainer') || q.parentElement;
        const inside = box && box.querySelector('.answer-wrap');
        if (inside) return inside;
        for (let n = box && box.nextElementSibling; n; n = n.nextElementSibling) {
          if (n.classList.contains('answer-wrap')) return n;
          if (n.classList.contains('answerContainer') || n.querySelector('.answerName')) return null;   // next question: this one is blank
        }
        return null;
      };
      const out = qs.map((q) => { const a = answerFor(q); return { question: clean(q.textContent), answer: a ? clean(a.textContent) : '' }; });
      return out;
    },
  };

  // ------------------------------------------------------------------ surveys

  // Survey responses (Reports > Surveys > Responses), confirmed live 11 Nov 2026:
  //  - List: GET /report/survey/feedback-data, an array of { id, template, patientName ("Mr ..."), answeredDate and
  //    appointmentDateAndTime ("18-Aug-2026 14:35") }. No patient id: the patient is found by name and date of birth.
  //  - A response: GET /report/survey/view/{id}, JSON whose message is HTML: patient details (div.viewRow with div.label
  //    "Date of Birth" and div.data), the total (span#note_total_score), the level (span.score-level-name), and each
  //    question (span.answerName) followed by its answer (span.answer-wrap; none when skipped).
  // Responses are patient data: callers use them in the page and never store them.
  const whenOf = (s) => { const day = parseDay(s); const m = String(s || '').match(/(\d{1,2}):(\d{2})\s*$/); return day === null ? null : day + (m ? (+m[1] * 60 + +m[2]) * 60e3 : 0); };
  const surveys = {
    async list() {
      const j = await http.json('/report/survey/feedback-data');
      if (!Array.isArray(j)) throw new UPCError('The survey responses list has changed, so responses could not be read.');
      return j.map((r) => ({ id: String(r.id), template: clean(r.template), name: clean(r.patientName), answered: whenOf(r.answeredDate), appointment: whenOf(r.appointmentDateAndTime) }));
    },
    // { total (number), level ('Excellent' ...), dob (ms or null), answers: [{ question, answer }] }.
    async response(id) {
      const j = await http.json('/report/survey/view/' + encodeURIComponent(id));
      const doc = htmlDoc(j && j.message);
      const totalEl = doc.querySelector('#note_total_score');
      const total = totalEl ? parseInt(clean(totalEl.textContent), 10) : NaN;
      if (isNaN(total)) throw new UPCError('The survey response layout has changed, so its score could not be read.');
      const levelEl = doc.querySelector('.score-level-name');
      const level = levelEl ? clean(levelEl.textContent).replace(/^[-\s]+/, '') : '';
      const dobRow = [...doc.querySelectorAll('.viewRow')].find((r) => /^date of birth$/i.test(clean((r.querySelector('.label') || {}).textContent)));
      const dob = dobRow ? parseDay(clean((dobRow.querySelector('.data') || {}).textContent)) : null;
      const answers = [];
      doc.querySelectorAll('.answerName, .answer-wrap').forEach((el) => {   // in page order: each answer follows its question
        if (el.classList.contains('answerName')) answers.push({ question: clean(el.textContent), answer: '' });
        else if (answers.length && !answers[answers.length - 1].answer) answers[answers.length - 1].answer = clean(el.textContent);
      });
      return { id: String(id), total, level, dob, answers };
    },
    // 'excellent', 'satisfactory' or 'below', from the response's level (the clinic's Feedback Request levels:
    // Excellent 32 to 35, Satisfactory 26 to 31, Below expected 0 to 25), or its total if the level is missing.
    band(r) {
      const l = String((r && r.level) || '').toLowerCase();
      if (/excellent/.test(l)) return 'excellent';
      if (/satisf/.test(l)) return 'satisfactory';
      if (/below|poor/.test(l)) return 'below';
      return r && r.total >= 32 ? 'excellent' : r && r.total >= 26 ? 'satisfactory' : 'below';
    },
  };

  // ------------------------------------------------------------------ Halaxy page furniture

  // Our interface sits in Halaxy's page and uses Halaxy's own classes (btn, btn-primary,
  // btn-outline-primary(-light), card, card-header, table, form-control, modal-dialog,
  // modal-content, modal-header, modal-title, modal-body, text-muted, text-danger), so Halaxy's
  // theme and the clinic branding style it exactly as they style Halaxy. Everything we add is
  // inside an element with class "upc-native", and our few rules are scoped to it.
  // Never use Halaxy's behaviour classes, which its scripts act on: ajax, btn-submit, btn-cancel,
  // bootbox, bootbox-close-button, modal (on the outer layer), dialogBoxForm, datepicker,
  // popoverTarget, chosen.
  const NATIVE_CSS = `
    .upc-native .upc-gap { margin-top: 12px; }
    .upc-native .upc-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 4.8px; margin-top: 16px; }
    .upc-native .upc-actions .btn { margin: 0; }
    .upc-native .upc-version { margin-top: 8px; font-size: .86em; }
    .upc-native .upc-actions .upc-version { margin: 0 auto 0 8px; }
    .upc-native .upc-actions > .upc-version:first-child { margin-left: 0; }
    .upc-native .upc-note { white-space: pre-line; background: var(--vs-card-standout-bg-color, #f0f0f5); border-radius: 4.8px; padding: 2px 8px; margin-top: 3px; }
    .upc-native .upc-box { background: var(--vs-card-header-bg-color, #f0f0f5); border: 1px solid var(--vs-card-border-color, #ced4da); border-radius: 4.8px; padding: 8px 12px; margin-top: 12px; }
    .upc-native .upc-ok { color: var(--success, #28a745); font-weight: 600; }
    .upc-native .upc-warn, .upc-native .upc-err { color: var(--vs-balance-negative-color, #ec6b65); }
    .upc-native tr.upc-off td { color: var(--vs-viewData-label-color, #6c757d); }
    .upc-native td.number, .upc-native th.number { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .upc-native table.table { margin: 12px 0 0; }
    .upc-native table.table td { vertical-align: top; }
    .upc-native .upc-run { margin-top: 12px; }
    .upc-native .upc-run .progress { height: 8px; background: var(--vs-card-header-bg-color, #e9ecef); border-radius: 4px; overflow: hidden; }
    .upc-native .upc-run .progress-bar { height: 100%; background-color: var(--vs-btn-primary-bg-color, var(--primary, #7c3fe4)); transition: width .3s ease; }
    .upc-native .upc-run-now { margin-top: 4px; }
    .upc-native .upc-run-inline { display: inline-flex; align-items: center; gap: 8px; }
    .upc-native .upc-run-inline .progress { display: inline-block; width: 120px; height: 8px; background: var(--vs-card-header-bg-color, #e9ecef); border-radius: 4px; overflow: hidden; }
    .upc-native .upc-run-inline .progress-bar { display: block; height: 100%; background-color: var(--vs-btn-primary-bg-color, var(--primary, #7c3fe4)); }
    .upc-native .upc-run-log > summary { display: inline-block; list-style: none; margin-top: 8px; }
    .upc-native .upc-run-log > summary::-webkit-details-marker { display: none; }
    .upc-native .upc-run-log .upc-box { max-height: 300px; overflow: auto; margin-top: 8px; }
    .upc-dialog { position: fixed; inset: 0; z-index: 2990; overflow-y: auto; }
    .upc-dialog > .upc-backdrop { position: fixed; inset: 0; background: #000; opacity: .5; }
    .upc-dialog > .modal-dialog { position: relative; margin: 28px auto; width: calc(100% - 32px); max-width: 800px; pointer-events: auto; }
    .upc-dialog > .modal-dialog.upc-wide { max-width: 1000px; }
    .upc-dialog > .modal-dialog.upc-small { max-width: 500px; }
    .upc-dialog.upc-above { z-index: 3100; }
    .upc-dialog .modal-content { background: var(--vs-modal-bg-color, #fff); border: 1px solid rgba(0,0,0,.2); border-radius: 10px; box-shadow: 0 8px 16px rgba(0,0,0,.5); }
    .upc-dialog .modal-header { display: flex; align-items: flex-start; justify-content: space-between; padding: 16px; border-bottom: 1px solid var(--vs-modal-border-color, #ced4da); }
    .upc-dialog .modal-title { margin: 0; padding-left: 8px; font-size: 1.43em; font-weight: 500; text-transform: uppercase; color: var(--vs-modal-title-color, #000); }
    .upc-dialog .modal-header .close { cursor: pointer; }
    .upc-dialog .modal-body { padding: 16px; }
  `;
  function nativeStyles() {
    if (document.getElementById('upc-native-css')) return;
    const s = document.createElement('style');
    s.id = 'upc-native-css';
    s.textContent = NATIVE_CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  // A run of steps shown as a progress bar with one line for the current step; the steps themselves go to a log,
  // shown when asked for (Carl, 13 Nov 2026: no step-by-step output while it works). Problems are always shown once
  // it has finished. The script keeps the run object and puts `ui.run.html(run)` where its log used to be.
  const runOpen = new Map();   // run id -> log open (kept across re-renders)
  let runSeq = 0;
  document.addEventListener('toggle', (e) => {
    const d = e.target;
    if (d && d.matches && d.matches('details[data-upc-run]')) runOpen.set(d.getAttribute('data-upc-run'), d.open);
  }, true);
  const run = {
    // total: the number of units of work (0 when unknown: the bar just moves)
    start(total) { return { id: 'r' + (++runSeq), total: total || 0, done: 0, now: '', lines: [], finished: false }; },
    step(r, text, err) { if (!r) return; r.lines.push({ t: String(text), err: !!err }); if (!err) r.now = String(text); },
    tick(r, n) { if (r) r.done = Math.min(r.total || Infinity, r.done + (n || 1)); },
    end(r, text) { if (!r) return; r.finished = true; r.done = r.total; if (text) r.lines.push({ t: String(text), err: false }); r.now = text || ''; },
    // A small moving bar with a short status, for a page's header line while it checks.
    inline(text) {
      return '<span class="upc-run-inline"><span class="progress" role="progressbar"><span class="progress-bar progress-bar-striped progress-bar-animated" style="width:100%"></span></span><span class="text-muted">' + esc(text) + '</span></span>';
    },
    html(r) {
      if (!r) return '';
      const errs = r.lines.filter((l) => l.err);
      let h = '<div class="upc-run">';
      if (!r.finished) {
        const pct = r.total ? Math.round(100 * r.done / r.total) : 0;
        // Unknown length: Halaxy's own striped, moving bar (Bootstrap) at full width.
        h += '<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100"' + (r.total ? ' aria-valuenow="' + pct + '"' : '') + '>' +
          '<div class="progress-bar' + (r.total ? '' : ' progress-bar-striped progress-bar-animated') + '" style="width:' + (r.total ? pct : 100) + '%"></div></div>' +
          '<div class="upc-run-now text-muted" aria-live="polite">' + esc(r.now || 'Working...') + '</div>';
      } else {
        if (r.now) h += '<div class="upc-run-now">' + esc(r.now) + '</div>';
        if (errs.length) h += '<div class="upc-err upc-run-errs"><b>' + errs.length + ' problem' + (errs.length === 1 ? '' : 's') + ':</b>' + errs.map((l) => '<div>' + esc(l.t) + '</div>').join('') + '</div>';
      }
      if (r.lines.length) {
        h += '<details class="upc-run-log" data-upc-run="' + r.id + '"' + (runOpen.get(r.id) ? ' open' : '') + '><summary class="btn btn-outline-primary-light">View log (' + r.lines.length + ' step' + (r.lines.length === 1 ? '' : 's') + ')</summary>' +
          '<div class="upc-box upc-log">' + r.lines.map((l) => '<div class="' + (l.err ? 'upc-err' : '') + '">' + esc(l.t) + '</div>').join('') + '</div></details>';
      }
      return h + '</div>';
    },
  };

  const ui = {
    nativeStyles,
    run,
    // A pop-up that looks like Halaxy's own. Returns { root, body, close, setTitle }. `onClose` runs when
    // it closes; `canClose` (optional) may return false to keep it open (for example while working).
    // `above` puts it over Halaxy's own pop-ups (for steps that start from one); `small` is 500px, `wide` 1000px.
    dialog({ title, key, wide, small, above, onClose, canClose }) {
      nativeStyles();
      if (key && document.querySelector('[data-upc-dialog="' + key + '"]')) return null;
      const root = document.createElement('div');
      root.className = 'upc-native upc-dialog' + (above ? ' upc-above' : '');
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-modal', 'true');
      root.setAttribute('aria-label', title);
      if (key) root.setAttribute('data-upc-dialog', key);
      root.innerHTML = '<div class="upc-backdrop"></div><div class="modal-dialog' + (small ? ' upc-small' : ' modal-lg') + (wide ? ' upc-wide' : '') + '"><div class="modal-content">' +
        '<div class="modal-header"><h5 class="modal-title"></h5><button type="button" class="close" aria-label="Close" data-upc-close>&times;</button></div>' +
        '<div class="modal-body"></div></div></div>';
      root.querySelector('.modal-title').textContent = title || '';
      const body = root.querySelector('.modal-body');
      const close = () => {
        if (canClose && canClose() === false) return;
        document.removeEventListener('keydown', onKey, true);
        root.remove();
        if (onClose) onClose();
      };
      const onKey = (e) => { if (e.key === 'Escape' && root.isConnected) { e.stopPropagation(); close(); } };
      root.addEventListener('click', (e) => { if (e.target.closest('[data-upc-close]')) close(); });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(root);
      return { root, body, close, setTitle: (s) => { root.querySelector('.modal-title').textContent = s; } };
    },
    // Halaxy button class names: 'primary' (filled), 'outline' (pop-up secondary), 'light' (small, on pages).
    btn: (kind) => 'btn ' + ({ primary: 'btn-primary', outline: 'btn-outline-primary', light: 'btn-outline-primary-light' }[kind] || 'btn-outline-primary'),
    // Adds a link under Reports in Halaxy's side menu (or as its own item). Returns true once added.
    // Adds a menu item at the end of a section (default Reports; `section` is a pattern for its heading,
    // e.g. /^finances?$/i). `href` may be a function given the section's element.
    menuItem(label, href, cls, section) {
      const menu = document.getElementById('mainMenu');
      if (!menu) return false;
      if (menu.querySelector('.' + cls)) return true;
      const items = [...menu.querySelectorAll('.mainmenu-item')];
      const want = section || /^reports?$/i;
      const reports = items.find((li) => want.test(clean((li.querySelector('.mainmenu-link-label') || li.querySelector('.mainmenu-link') || {}).textContent)));
      const sub = reports && reports.querySelector('a.mainmenu-sublink');
      if (typeof href === 'function') { href = href(reports || null); if (!href) return false; }
      if (sub) {
        const host = sub.parentElement && sub.parentElement.tagName === 'LI' ? sub.parentElement : sub;
        const copy = host.cloneNode(true);
        copy.removeAttribute('id');
        copy.classList.remove('active');
        copy.querySelectorAll('.active').forEach((n) => n.classList.remove('active'));   // the copied item may be the highlighted one
        copy.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
        const a = copy.tagName === 'A' ? copy : copy.querySelector('a.mainmenu-sublink');
        a.setAttribute('href', href);
        a.removeAttribute('onclick');
        a.classList.remove('active');
        a.classList.add(cls);
        a.textContent = label;
        host.parentNode.appendChild(copy);
        return true;
      }
      const first = items[0];
      if (first && first.parentNode) {
        const li = document.createElement(first.tagName.toLowerCase());
        li.className = 'mainmenu-item';
        li.innerHTML = '<a class="mainmenu-link ' + esc(cls) + '" href="' + esc(href) + '"><span class="mainmenu-link-label">' + esc(label) + '</span></a>';
        first.parentNode.appendChild(li);
        return true;
      }
      return false;
    },
    // Keeps trying to add the menu item while Halaxy draws its menu.
    ensureMenuItem(label, href, cls, section) {
      const start = () => {
        if (ui.menuItem(label, href, cls, section)) return;
        const mo = new MutationObserver(() => { if (ui.menuItem(label, href, cls, section)) mo.disconnect(); });
        mo.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => mo.disconnect(), 15000);
      };
      if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
    },
    // Shows `root` as a page of its own inside Halaxy: it covers the whole content area between
    // the side menu, the top bar and the footer, whatever Halaxy page is underneath, and sits
    // below Halaxy's own pop-ups and menus. Returns an unmount function.
    mountPage(title, root, menuCls) {
      const undo = [];
      const shell = document.createElement('div');
      shell.setAttribute('data-upc-page', '');
      const bg = getComputedStyle(document.body).backgroundColor;
      shell.style.cssText = 'position:fixed;z-index:60;overflow:auto;box-sizing:border-box;padding:16px 20px;background:' +
        (bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg) ? bg : '#fff') + ';';
      shell.appendChild(root);
      document.body.appendChild(shell);

      const sidebarRight = () => {
        const menu = document.getElementById('mainMenu');
        let right = 0;
        for (let el = menu; el && el !== document.body; el = el.parentElement) {
          const r = el.getBoundingClientRect();
          if (r.width && r.left <= 1 && r.width < window.innerWidth / 2) right = Math.max(right, r.right);
        }
        return right;
      };
      const topBarBottom = () => {
        const cands = [document.getElementById('headerWrapper'), document.querySelector('header'), document.querySelector('.navbar')];
        const search = document.querySelector('input[placeholder*="Search by patient" i], input[type="search"]');
        for (let el = search; el && el !== document.body; el = el.parentElement) cands.push(el);
        let bottom = 0;
        cands.filter(Boolean).forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.height && r.top <= 2 && r.height < 160 && r.width > window.innerWidth / 3) bottom = Math.max(bottom, r.bottom);
        });
        return bottom || 56;
      };
      const footerHeight = () => {
        const f = document.getElementById('footer');
        const r = f && f.getBoundingClientRect();
        if (!r || !r.height || getComputedStyle(f).display === 'none') return 0;
        return r.top < window.innerHeight && r.bottom >= window.innerHeight - 2 ? window.innerHeight - r.top : 0;
      };
      const place = () => {
        shell.style.left = Math.round(sidebarRight()) + 'px';
        shell.style.top = Math.round(topBarBottom()) + 'px';
        shell.style.right = '0';
        shell.style.bottom = Math.round(footerHeight()) + 'px';
      };
      place();
      window.addEventListener('resize', place);
      undo.push(() => window.removeEventListener('resize', place));
      const menuBox = document.getElementById('mainMenu');
      if (menuBox && typeof ResizeObserver === 'function') {
        const ro = new ResizeObserver(place);
        ro.observe(menuBox.parentElement || menuBox);
        undo.push(() => ro.disconnect());
      }

      const docTitle = document.title;
      undo.push(() => { document.title = docTitle; });
      document.title = title + ' | Halaxy';
      if (menuCls) {
        // Highlight our menu item instead of the Halaxy page underneath: take the highlight off
        // other sub-items (link or its line), leave the group heading (it contains ours) alone.
        const isOther = (n) => !n.classList.contains(menuCls) && !n.querySelector('.' + menuCls) &&
          (n.matches('a.mainmenu-sublink') || (n.tagName === 'LI' && !!n.querySelector(':scope > a.mainmenu-sublink')));
        document.querySelectorAll('#mainMenu .active').forEach((n) => {
          if (!isOther(n)) return;
          n.classList.remove('active');
          undo.push(() => n.classList.add('active'));
        });
        document.querySelectorAll('a.' + menuCls).forEach((a) => {
          a.classList.add('active');
          const li = a.parentElement && a.parentElement.tagName === 'LI' ? a.parentElement : null;
          if (li && !li.classList.contains('active')) { li.classList.add('active'); undo.push(() => li.classList.remove('active')); }
        });
      }
      return () => {
        while (undo.length) undo.pop()();
        shell.remove();
        if (menuCls) document.querySelectorAll('.' + menuCls).forEach((a) => a.classList.remove('active'));
      };
    },
  };



  // ------------------------------------------------------------------ background checks

  // When background checks (menu counts, Patient statuses and the like) may run: in the visible tab, between 7 am and
  // 9 pm, only while someone has used this PC in the last 30 minutes (any Halaxy tab), and not while Halaxy has asked
  // us to wait. A PC left open overnight or unattended goes quiet. Checks fall due at their interval give or take 15%,
  // so they don't run on an exact clock (Carl, 12 Nov 2026).
  const BG = { from: 7, to: 21, idleMs: 30 * 60e3, key: 'upc-core:active' };
  let activeMark = 0;
  function markActive() {
    const now = Date.now();
    if (now - activeMark < 30e3) return;
    activeMark = now;
    try { localStorage.setItem(BG.key, String(now)); } catch (e) { /* storage blocked */ }
  }
  ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove'].forEach((t) => document.addEventListener(t, markActive, { capture: true, passive: true }));
  const background = {
    // Someone has used this PC (any Halaxy tab) in the last 30 minutes.
    active() {
      let at = activeMark;
      try { at = Math.max(at, Number(localStorage.getItem(BG.key)) || 0); } catch (e) { /* storage blocked */ }
      return Date.now() - at < BG.idleMs;
    },
    inHours() { const h = new Date().getHours(); return h >= BG.from && h < BG.to; },
    ok() { return document.visibilityState === 'visible' && background.inHours() && background.active() && http.pausedFor() <= 0; },
    // True when a check last run at lastMs is due again, everyMs give or take 15% (a different, fixed amount each time).
    due(lastMs, everyMs) {
      if (!lastMs) return true;
      const f = 0.85 + 0.3 * (Math.abs(Math.sin(Number(lastMs) % 100000)) % 1);
      return Date.now() - lastMs >= everyMs * f;
    },
    // A pause of min to max milliseconds, for spacing changes made without a person clicking.
    pause(min, max) { return new Promise((r) => setTimeout(r, min + Math.random() * (max - min))); },
  };

  // ------------------------------------------------------------------ who is signed in

  // Halaxy may not have filled in who's signed in when a script starts (HkUser.pracName empty for a few seconds: live,
  // 11 Nov 2026), so whenAllowed keeps looking for 20 seconds, and the name in the top bar is a fallback.
  const user = {
    name(known) {
      const h = window.HkUser || {};
      const named = String(h.pracName || (h.CalendarDefault || {}).pracName || '').trim();
      if (named) return named;
      const btn = document.getElementById('activeUser');
      if (btn && clean(btn.textContent)) return clean(btn.textContent);
      const list = (known || []).map((n) => n.toLowerCase());
      if (!list.length) return '';
      const el = [...document.querySelectorAll('header *, nav *, .navbar *, #top *, #headerWrapper *')]
        .find((e) => !e.children.length && list.includes(e.textContent.trim().toLowerCase()));
      return el ? el.textContent.trim() : '';
    },
    // True when the signed-in person is one of `names` ('Carl Healy').
    is(names) { const me = user.name(names).toLowerCase(); return !!me && names.some((n) => n.toLowerCase() === me); },
    // Runs fn once the signed-in person is one of `names`; gives up after 20 seconds.
    whenAllowed(names, fn) {
      if (user.is(names)) { fn(); return; }
      const t0 = Date.now();
      const timer = setInterval(() => { if (user.is(names)) { clearInterval(timer); fn(); } else if (Date.now() - t0 > 20000) clearInterval(timer); }, 500);
    },
    // Initials from a name ('Carl Healy' -> 'CH').
    initials(name) { const w = clean(name).split(' ').filter(Boolean); return w.length ? (w[0][0] + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase() : ''; },
  };

  // ------------------------------------------------------------------ per-PC working state

  // localStorage under a prefix ('upc-rtb:'), shared by this PC's Halaxy tabs. Never note text, form or survey answers.
  function storage(prefix) {
    return {
      get(k, d) { try { const v = localStorage.getItem(prefix + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
      set(k, v) { try { localStorage.setItem(prefix + k, JSON.stringify(v)); } catch (e) { /* storage blocked or full */ } },
      del(k) { try { localStorage.removeItem(prefix + k); } catch (e) { /* storage blocked */ } },
    };
  }

  // ------------------------------------------------------------------ calendar

  // Appointments (with a patient) from Halaxy's calendar, every practitioner. Several scripts read long windows (Patient
  // statuses, Open-ended patients, Review requests), so on each page one standard window (200 days back to 125 ahead) is
  // read once and shared for 15 minutes; a window outside it is read on its own.
  const CAL = { back: 200, ahead: 125, freshMs: 15 * 60e3 };
  let calShared = null;   // { at, from, to, promise }
  async function calendarRead(fromMs, toMs) {
    const pracs = await http.json('/lookup/practitioner?clinic=&include_id=&type=');
    const qs = new URLSearchParams({ start: Math.floor(fromMs / 1000), end: Math.floor(toMs / 1000) });
    (Array.isArray(pracs) ? pracs : []).forEach((p, i) => qs.append('practitioners[' + i + '][id]', p.id));
    const cal = await http.json('/calendar/json?' + qs.toString());
    if (!cal || !cal.payload || !Array.isArray(cal.payload.events)) throw new UPCError('Halaxy\'s calendar data has changed (no events list).');
    return cal.payload.events.filter((e) => e.type === 'appointment' && e.linkPaGId);
  }
  const calendar = {
    // Forget the shared window, so the next read asks Halaxy again (a person pressing "Check now").
    forget() { calShared = null; },
    async appointments(fromMs, toMs) {
      const day0 = new Date(); day0.setHours(0, 0, 0, 0);
      const from = day0.getTime() - CAL.back * 86400e3, to = day0.getTime() + (CAL.ahead + 1) * 86400e3;
      if (fromMs < from || toMs > to) return calendarRead(fromMs, toMs);
      if (!calShared || Date.now() - calShared.at > CAL.freshMs || calShared.from !== from) {
        calShared = { at: Date.now(), from, to, promise: calendarRead(from, to) };
        calShared.promise.catch(() => { calShared = null; });
      }
      const all = await calShared.promise;
      return all.filter((e) => Number(e.start) * 1000 >= fromMs && Number(e.start) * 1000 < toMs);
    },
  };

  // ------------------------------------------------------------------ note wording

  // Phrases in clinical notes, shared so every script reads a note the same way. Only the kind's name is ever kept,
  // never the words. A phrase just after "not", "no longer" and similar doesn't count ("not yet discharged").
  const IF_NEEDED = '(if|when|as) (needed|required|necessary|nec|req|reqd|appropriate)|if (any|further) (problems|issues|concerns|symptoms)|if (it |things |symptoms |pain )?(gets? worse|worsens?|returns?|recurs?|flares?( up)?)|prn|sos';
  const wording = {
    NEGATION: /\b(not|no longer|never|isn'?t|wasn'?t|hasn'?t|without|unable to|not yet|before|no need to)\b[^.]{0,20}$/i,
    // Treatment has finished.
    FINISHED: [
      ['discharged', /\bdischarg(ed|e)\b/i],
      ['goals met', /\bgoals? (met|achieved|reached)\b|\bachieved (all )?(his |her |their )?goals?\b/i],
      ['no further treatment', /\bno (further|more) (treatment|physio|physiotherapy|sessions?|appointments?) (needed|required|necessary)\b/i],
      ['self-managing', /\bself[- ]?manag|\bindependent(ly)? (with|managing)|\bcontinue (with )?(home )?(exercises|hep|programme|program) independently\b/i],
    ],
    // Left open: the patient may come back.
    OPEN_ENDED: [
      ['open return', /\bopen (return|review|f\/?u|follow[- ]?up)\b|\bleft open\b|\bopen[- ]ended\b/i],
      ['open appointment', /\bopen (appointment|appt|booking)\b/i],
      ['book again if needed', new RegExp('\\b(re-?)?book (again|in|back|another( session| appointment| appt)?|a follow[- ]?up)?\\s*(' + IF_NEEDED + ')\\b', 'i')],
      ['come back if needed', new RegExp('\\b(come|coming|call|ring|get|getting|contact|be) (back|in touch|us)\\s*(' + IF_NEEDED + ')\\b|\\b(to |will )?(contact|call|ring|email|e-?mail|text|message) (us|clinic|the clinic|me)?\\s*(' + IF_NEEDED + ')\\b|\\bget in touch\\b', 'i')],
      ['see how things go', /\bsee how (things|it|he|she|they|pt|patient|symptoms|knee|back|shoulder|ankle|hip|neck)?\s*(go(es)?|get(s)? on|progress(es)?|settle(s)?)\b|\bwait and see\b/i],
      ['see as needed', /\b(see|review|f\/?u|follow[- ]?up) (as|when|if) (needed|required|necessary|nec|req|reqd)\b|\bprn\b|\bsos\b/i],
    ],
    // The kinds in `list` ([[name, regex]]) found in text, in list order; with negatable (default), negated ones don't count.
    find(text, list, negatable) {
      const t = String(text || '');
      const found = [];
      list.forEach(([name, re]) => {
        const g = new RegExp(re.source, 'gi');
        let m;
        while ((m = g.exec(t))) {
          if (negatable !== false && wording.NEGATION.test(t.slice(Math.max(0, m.index - 30), m.index))) continue;
          if (!found.includes(name)) found.push(name);
          break;
        }
      });
      return found;
    },
    finished(text) { return wording.find(text, wording.FINISHED); },
    openEnded(text) { return wording.find(text, wording.OPEN_ENDED); },
  };

  window.UPC = Object.freeze({
    version: VERSION, Error: UPCError, pg, base, sleep, clean, esc, htmlDoc, money, http, invoice, appointment, forms, notes, followUps, patient, tasks, surveys, reports, dayLabel, parseDay, rebate, files, deposits, orgFiles, load, ui,
    user, storage, calendar, wording, background,
  });
})();
