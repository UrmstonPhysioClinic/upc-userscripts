// ==UserScript==
// @name         UPC System: Core library (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.1.83
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

  const VERSION = '0.1.83';
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
    // Thousands with commas, as Halaxy writes them (£ 1,234.00).
    fmt: (c) => (c === null || c === undefined ? '' : (c < 0 ? '-£ ' : '£ ') + (Math.abs(c) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')),
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

  // The steps of a move. If any step fails after something was changed, everything is put back as it was (CH,
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
      // amount (CH, 9 Nov 2026: a £0.00 line, never a missing one). Halaxy offers £0 to bill like any amount.
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
  // A report page without its table is usually a passing Halaxy hiccup (both PCs, 13 Nov 2026, cleared by itself): it
  // asks once more after 20 seconds, and only then says the report has changed, naming the page Halaxy sent instead.
  const pageKind = (doc) => {
    if (doc.querySelector('input[type=password]')) return 'a sign-in page';
    const t = clean(doc.title || (doc.querySelector('h1, h2') || {}).textContent || '');
    return t ? 'a page titled "' + t.slice(0, 60) + '"' : 'an empty page';
  };
  async function reportTable(path, what) {
    let doc = await http.html(path);
    let table = doc.querySelector('table.table-report');
    if (!table) {
      await sleep(20000);
      doc = await http.html(path.replace(/([?&]clicked=)\d+/, '$1' + Date.now()));
      table = doc.querySelector('table.table-report');
    }
    if (!table) throw new UPCError('Halaxy\'s ' + what + ' report has changed (its table was not found twice; Halaxy sent ' + pageKind(doc) + ').');
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
    // Insurer profiles seen on invoices (their Bill To), so a bank line with no invoice to go by can still find its
    // insurer's profile, and so the lingering check knows which profiles to look at. Kept on this PC and, for every PC,
    // in the shared note "UPC shared checks: Insurer profiles" (org.<id> | when | insurer; CH, 15 Nov 2026).
    shared: () => shared('Insurer profiles', { keep: 400 * 86400e3 }),
    orgs() {
      const all = Object.assign({}, storage('upc-funder-orgs:').get('list', {}));
      let recs = {};
      try { recs = deposits.shared().cached(); } catch (e) { /* this PC's list still applies */ }
      Object.keys(recs).forEach((k) => {
        const m = /^org\.(\d+)$/.exec(k), r = recs[k];
        if (m && r.at !== null && !all[m[1]]) all[m[1]] = { name: '', insurer: r.value === '-' ? '' : r.value };
      });
      return all;
    },
    rememberOrg(orgId, name, insurer) {
      if (!orgId) return;
      const st = storage('upc-funder-orgs:'), all = st.get('list', {});
      const was = all[orgId] || {};
      if (!(was.name === name && was.insurer === insurer)) {
        all[orgId] = { name: name || was.name || '', insurer: insurer || was.insurer || '' };
        st.set('list', all);
      }
      // For every PC: when the shared note doesn't have it, has a different insurer, or last noted it a month ago.
      // Kept as pending here and written by flushOrgs (after a step the user confirmed, and on the daily check), so
      // reading a statement or remittance writes nothing.
      try {
        const r = deposits.shared().cached()['org.' + orgId], ins = String(all[orgId].insurer || '').replace(/[^A-Za-z0-9 _.:,-]/g, '').trim() || '-';
        if (!r || r.at === null || r.value !== ins || Date.now() - r.at > 30 * 86400e3) { const p = st.get('pending', {}); p['org.' + orgId] = ins; st.set('pending', p); }
      } catch (e) { /* noted next time */ }
    },
    async flushOrgs() {
      const st = storage('upc-funder-orgs:'), p = st.get('pending', {});
      if (!Object.keys(p).length) return;
      await deposits.shared().write(p);
      const now = st.get('pending', {});
      Object.keys(p).forEach((k) => { if (now[k] === p[k]) delete now[k]; });
      st.set('pending', now);
    },
    // Once a day for the whole clinic (the shared note's lingerDay, claimed so two PCs don't both check); this PC's
    // own day if the note can't be read. Returns true when this PC should check today.
    async dailyTurn(sh, local) {
      const today = dayLabel(Date.now());
      if (sh) {
        try {
          const recs = await sh.read(0);
          if (recs.lingerDay && recs.lingerDay.value === today) return false;
          return (await sh.claim(['lingerDay'])).includes('lingerDay');
        } catch (e) { /* this PC's own day */ }
      }
      if (local.get('lingerDay', '') === today) return false;
      local.set('lingerDay', today);
      return true;
    },
    // The profiles known for an insurer ('Bupa'), as ids.
    orgsFor(insurer) { return Object.entries(deposits.orgs()).filter(([, o]) => o.insurer === insurer).map(([id]) => id); },
    // Deposits from the bank not applied after `days` (no remittance has come for them): a task on the insurer's
    // profile for each. At most once a day per PC, and not while Halaxy is asking us to slow down.
    async lingering({ days, assignee, by }) {
      const st = storage('upc-funder-orgs:');
      const today = dayLabel(Date.now());
      if (http.pausedFor() > 0) return [];
      let sh = null;
      try { sh = deposits.shared(); } catch (e) { sh = null; }
      if (sh) await deposits.flushOrgs().catch(() => {});
      if (!(await deposits.dailyTurn(sh, st))) return [];
      const out = [];
      try {
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
      } finally {
        if (sh) await sh.write({ lingerDay: today }).catch(() => {});
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
  // Admin Notes on a funder profile (organisation) or a patient (linkPaG), as Halaxy's Admin Notes tab keeps them
  // (capture 14 Nov 2026): list-data gives every note with its whole text; Add and Edit are a small pop-up
  // (form#adminNoteForm) that touches nothing else. Text is kept as one paragraph per line.
  const adminNotes = {
    path: (kind, id) => '/communication-log/' + (kind === 'patient' ? 'linkPaG' : 'organisation') + '/' + encodeURIComponent(id),
    toText(html) {
      const doc = htmlDoc('<div>' + String(html || '').replace(/<\/(p|div|li)>|<br\s*\/?>/gi, '\n') + '</div>');
      return String(doc.body.textContent || '').split('\n').map((l) => l.replace(/ /g, ' ').replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
    },
    toHtml: (text) => String(text || '').split('\n').map((l) => '<p>' + esc(l) + '</p>').join(''),
    // [{ id, date, creator, privacy, important, text }], newest first as Halaxy lists them.
    // Asked afresh each time (a time in the address, no browser cache): right after saving, an earlier copy of the list
    // was seen (live, 15 Nov 2026: the new note missing).
    async list(kind, id) {
      const res = await http.json(adminNotes.path(kind, id) + '/list-data?viewMode=ajax&_=' + Date.now(), { cache: 'no-store', headers: JSON_HEADERS });
      if (!res || !Array.isArray(res.data)) throw new UPCError('Halaxy\'s Admin Notes list has changed, so the notes could not be read.');
      return res.data.map((n) => ({ id: String(n.id), date: n.date || '', creator: clean(n.creator), privacy: clean(n.privacy), important: !!n.isImportant, text: adminNotes.toText(adminNotes.body(n.content)) }));
    },
    // A listed note's content as written: Halaxy's list puts a "Log Notes" heading (p.font-weight-bold) before it and an
    // empty div.form-row after it (capture 15 Nov 2026), so the first line read was "Log Notes", not the note's own.
    body(html) {
      return String(html || '').replace(/^\s*<p\b[^>]*\bfont-weight-bold\b[^>]*>\s*Log Notes\s*<\/p>/i, '').replace(/<div\b[^>]*\bform-row\b[^>]*>\s*<\/div>\s*$/i, '');
    },
    async save(path, text, check) {
      const { doc } = await http.popup(path);
      const form = doc.querySelector('form#adminNoteForm');
      if (!form || !form.querySelector('[name="form[logContent]"]') || !form.querySelector('[name="form[_token]"]')) throw new UPCError('Halaxy\'s Admin Note pop-up has changed, so the note was not saved.');
      const pairs = serialize(form).filter(([k]) => k !== 'form[logContent]' && k !== 'form[isImportant]');
      pairs.push(['form[logContent]', adminNotes.toHtml(text)]);
      const res = await http.postForm(path, pairs);
      if (res && res.status === 'FORM') throw new UPCError('Halaxy did not save the note' + (Array.isArray(res.errors) && res.errors.length ? ': ' + res.errors.join(' ') : '.'));
      return check();
    },
    // Adds a note (Access left as Halaxy offers it: All) and returns it, as listed afterwards.
    async add(kind, id, text) {
      const before = (await adminNotes.list(kind, id)).map((n) => n.id);
      const want = adminNotes.toText(adminNotes.toHtml(text));
      return adminNotes.save(adminNotes.path(kind, id) + '/new', text, () => adminNotes.settle(kind, id, (notes) => {
        // Another note (another script's shared note) can be added at the same moment: find this one by its text.
        return notes.filter((n) => !before.includes(n.id)).find((n) => n.text === want) || null;
      }, 'Halaxy accepted the note but does not list it as written. Check the Admin Notes.'));
    },
    // Reads the list until found(notes) gives the note (up to three looks, a second or two apart: Halaxy's list can lag
    // just after a save), else fails with message.
    async settle(kind, id, found, message) {
      for (let i = 0; i < 3; i++) {
        if (i) await sleep(1500 * i);
        const n = found(await adminNotes.list(kind, id));
        if (n) return n;
      }
      throw new UPCError(message);
    },
    // Deletes a note (capture 14 Nov 2026): GET .../:noteId/delete is Halaxy's "Delete Admin Note" pop-up, whose Delete
    // button is a link to .../:noteId/delete/<hex>; opening that deletes it. Checked by listing afterwards. Only used for
    // the scripts' own spare shared-check notes (CH, 15 Nov 2026).
    async remove(kind, id, noteId) {
      const del = adminNotes.path(kind, id) + '/' + encodeURIComponent(noteId) + '/delete';
      const { doc } = await http.popup(del);
      const link = [...doc.querySelectorAll('a[href]')].find((a) => a.getAttribute('href').split('?')[0].replace(/^.*\/a\/pr\/\d+/, '').startsWith(del + '/'));
      if (!link) throw new UPCError('Halaxy\'s Delete Admin Note pop-up has changed, so the note was not deleted.');
      await http.json(link.getAttribute('href').replace(/^.*\/a\/pr\/\d+/, ''));
      if ((await adminNotes.list(kind, id)).some((n) => n.id === String(noteId))) throw new UPCError('Halaxy still lists the note after deleting it.');
    },
    // Replaces a note's text (its date, owner and access stay as they are).
    async update(kind, id, noteId, text) {
      const want = adminNotes.toText(adminNotes.toHtml(text));
      return adminNotes.save(adminNotes.path(kind, id) + '/' + encodeURIComponent(noteId) + '/edit', text, () => adminNotes.settle(kind, id,
        (notes) => notes.find((x) => x.id === String(noteId) && x.text === want) || null, 'Halaxy does not show the note as changed. Check the Admin Notes.'));
    },
  };

  // Checks shared between the PCs (CH, 15 Nov 2026). One Admin Note per script on the "UPC scripts (settings)"
  // organisation holds what each PC found, so the other PCs needn't check again, and claims ("checking"), so two PCs
  // don't check the same thing at once. Ids and short codes only, never names. Lines:
  //   <key> | <when found> | <what was found> [| checking <pc> until <time>]
  // A line that can't be read is dropped when the note is next saved (and the health check is told); a note that has
  // lost its first line is found again by its id and rewritten; a deleted note is made again by the next save.
  const SHARED_ORG = '78842';
  const SHARED_HEAD = 'UPC shared checks: ';
  const SHARED_INFO = 'Kept by UPC scripts. Please do not edit: a line that is changed is dropped and checked again.';
  function pcId() {
    let id = null;
    try { id = localStorage.getItem('upc-core:pc'); } catch (e) { /* storage blocked */ }
    if (!/^[a-z0-9]{4}$/.test(id || '')) {
      id = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
      try { localStorage.setItem('upc-core:pc', id); } catch (e) { /* storage blocked */ }
    }
    return id;
  }
  const SHARED_QUEUE = {};
  function shared(name, opts) {
    opts = opts || {};
    const head = SHARED_HEAD + name;
    const keep = opts.keep || 30 * 86400e3, claimFor = opts.claimFor || 5 * 60e3, max = opts.max || 1500;
    const st = storage('upc-shared:' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + ':');
    const me = pcId();
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()); };
    const unstamp = (s) => { const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)$/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : null; };
    const KEY_RE = /^[A-Za-z0-9_.:-]{1,40}$/, VALUE_RE = /^[A-Za-z0-9 _.:,-]{1,200}$/;
    // { recs: { key: { at, value, claim: { by, until } | null } }, bad: number of lines that couldn't be read }
    function parse(text) {
      const lines = String(text || '').split('\n');
      const recs = {};
      let bad = lines[0] === head ? 0 : 1;
      lines.slice(1).forEach((l, i) => {
        if (i === 0 && l === SHARED_INFO) return;
        const f = l.split(' | ');
        const at = f[1] === '-' ? null : unstamp(f[1]);
        const claim = f[3] ? /^checking ([a-z0-9]{4}) until (\d{4}-\d\d-\d\d \d\d:\d\d)$/.exec(f[3]) : null;
        const ok = f.length >= 3 && f.length <= 4 && KEY_RE.test(f[0]) && !recs[f[0]] && (f[1] === '-' ? f[2] === '-' : at !== null && VALUE_RE.test(f[2])) &&
          (f.length === 3 ? f[1] !== '-' : !!claim);
        if (!ok) { bad++; return; }
        recs[f[0]] = { at, value: at === null ? null : f[2], claim: claim ? { by: claim[1], until: unstamp(claim[2]) } : null };
      });
      return { recs, bad };
    }
    function format(recs) {
      const keys = Object.keys(recs).sort((a, b) => (recs[b].at || 0) - (recs[a].at || 0)).slice(0, max).sort();
      return [head, SHARED_INFO].concat(keys.map((k) => {
        const r = recs[k];
        return [k, r.at === null ? '-' : stamp(r.at), r.at === null ? '-' : r.value].concat(r.claim ? ['checking ' + r.claim.by + ' until ' + stamp(r.claim.until)] : []).join(' | ');
      })).join('\n');
    }
    // The note among the organisation's Admin Notes: the oldest whose first line is ours (so every PC settles on the same
    // one, live 15 Nov 2026: three PCs made one each at the same moment), or the one this PC last used (if its first line
    // was lost). Lines in any other copies are taken in (the newest check wins); those copies are deleted on the next save
    // (CH, 15 Nov 2026), or relabelled as spare if Halaxy won't delete them (and deleted on a later save).
    const SPARE = 'Spare copy of ' + head + ' (two PCs started it at the same moment). It can be deleted.';
    function pick(notes) {
      const ours = notes.filter((n) => n.text.split('\n')[0] === head).sort((a, b) => Number(a.id) - Number(b.id));
      const note = ours[0] || notes.find((n) => n.id === st.get('noteId', '')) || null;
      const got = note ? parse(note.text) : { recs: {}, bad: 0 };
      const spares = ours.slice(1).concat(notes.filter((n) => n.text === SPARE));
      spares.forEach((n) => {
        const more = parse(n.text).recs;
        Object.keys(more).forEach((k) => {
          const a = got.recs[k], b = more[k];
          if (!a) { got.recs[k] = b; return; }
          if (b.at !== null && (a.at === null || b.at > a.at)) { a.at = b.at; a.value = b.value; }
          if (!a.claim && b.claim) a.claim = b.claim;
        });
      });
      return Object.assign({ note, spares }, got);
    }
    async function retire(spares) {
      for (const n of spares) {
        try { await adminNotes.remove('organisation', SHARED_ORG, n.id); continue; } catch (e) { console.warn('[UPC shared]', e); }
        if (n.text === SPARE) continue;
        try { await adminNotes.update('organisation', SHARED_ORG, n.id, SPARE); } catch (e) { console.warn('[UPC shared]', e); }
      }
    }
    function remember(got) {
      if (got.note) st.set('noteId', got.note.id);
      st.set('cache', { at: Date.now(), recs: got.recs });
      return got.recs;
    }
    function tellRepaired(n) {
      try {
        document.dispatchEvent(new CustomEvent('upc-loader-error', { detail: JSON.stringify({ file: opts.file || 'core.user.js',
          message: 'Its shared note on UPC scripts (settings) had ' + n + ' line' + (n === 1 ? '' : 's') + ' that could not be read, so the note was rewritten (those checks are simply done again).' }) }));
      } catch (e) { /* ignore */ }
    }
    async function read(maxAge) {
      const c = st.get('cache', null);
      if (c && maxAge && Date.now() - c.at < maxAge) return c.recs;
      return remember(pick(await adminNotes.list('organisation', SHARED_ORG)));
    }
    // Reads the note afresh, changes it and saves it (old outcomes and lapsed claims dropped), then returns what the
    // note says afterwards. If another PC saved at the same moment, theirs may win: the caller sees that in the result.
    // One save at a time per note on this page (two at once would each write over the other's change).
    function save(change) {
      const run = (SHARED_QUEUE[name] || Promise.resolve()).catch(() => {}).then(() => saveNow(change));
      SHARED_QUEUE[name] = run;
      return run;
    }
    async function saveNow(change) {
      const got = pick(await adminNotes.list('organisation', SHARED_ORG));
      const recs = got.recs, now = Date.now();
      change(recs, now);
      Object.keys(recs).forEach((k) => {
        const r = recs[k];
        if (r.claim && !(r.claim.until > now)) r.claim = null;
        if (r.at !== null && now - r.at > keep) { r.at = null; r.value = null; }
        if (r.at === null && !r.claim) delete recs[k];
      });
      const text = format(recs);
      if (got.note && got.note.text === text) { await retire(got.spares); return remember(got); }
      let saved = null;
      try {
        saved = got.note ? await adminNotes.update('organisation', SHARED_ORG, got.note.id, text) : await adminNotes.add('organisation', SHARED_ORG, text);
      } catch (e) {
        if (!/does not (list|show) the note as/.test(e.message || '')) throw e;
      }
      if (got.bad) tellRepaired(got.bad);
      if (saved) await retire(got.spares);
      if (saved) return remember({ note: saved, recs: parse(saved.text).recs });
      return read(0);
    }
    return {
      me,
      // { key: { at, value, claim } }; maxAge: use this PC's last read if it is younger than that (ms).
      read,
      // This PC's last read, without asking Halaxy ({} if none).
      cached: () => ((st.get('cache', null) || {}).recs || {}),
      // Claims the keys nobody else is checking; returns those this PC now holds.
      async claim(keys) {
        if (!keys.length) return [];
        const after = await save((recs, now) => keys.forEach((k) => {
          if (!KEY_RE.test(String(k))) return;
          const r = recs[k] || (recs[k] = { at: null, value: null, claim: null });
          if (r.claim && r.claim.by !== me && r.claim.until > now) return;
          r.claim = { by: me, until: now + claimFor };
        }));
        return keys.filter((k) => after[k] && after[k].claim && after[k].claim.by === me);
      },
      // Records outcomes { key: value } (found now) or { key: { value, at } } (found earlier, kept with its time; a newer
      // line already in the note wins), and lets go of this PC's claims. Tried twice if another PC's save wins.
      async write(outcomes) {
        const norm = {};
        Object.keys(outcomes).forEach((k) => {
          const o = outcomes[k], value = String(o && typeof o === 'object' ? o.value : o), at = o && typeof o === 'object' && o.at ? o.at : null;
          if (KEY_RE.test(k) && VALUE_RE.test(value) && (at === null || at > Date.now() - keep)) norm[k] = { value, at };
        });
        const keys = Object.keys(norm);
        // This PC's copy of the note is changed first, so a save cut short (the page left) is noticed next time.
        const c = st.get('cache', null);
        if (c && keys.length) { keys.forEach((k) => { c.recs[k] = { at: norm[k].at || Date.now(), value: norm[k].value, claim: null }; }); st.set('cache', c); }
        const change = (recs, now) => {
          keys.forEach((k) => {
            const at = norm[k].at || now, was = recs[k];
            if (was && was.at !== null && was.at >= at - 60e3 && norm[k].at) return;   // the note already has this or newer
            recs[k] = { at, value: norm[k].value, claim: was && was.claim && was.claim.by !== me ? was.claim : null };
          });
          Object.values(recs).forEach((r) => { if (r.claim && r.claim.by === me) r.claim = null; });
        };
        let after = await save(change);
        if (keys.some((k) => !after[k] || after[k].at === null)) after = await save(change);
        return after;
      },
      stamp, unstamp, parse, format,
    };
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
    // Every card on file (Finance report type 26, "Credit Card Expiry", capture 23 Nov 2026: columns Patient (linking
    // the patient's Funding tab /patient/{linkPaGId}/funding), Status (the patient's), Card (XXXX-XXXX-XXXX-1234), Type,
    // Expiry ("Mar 2029"); one row per card). Expiry from Jan 2000 to Dec 2060, so every card is listed.
    // Returns [{ patientId, patient, status, last4, type, expiry (ms, the 1st of the month), expiryText }].
    async storedCards() {
      const p = new URLSearchParams([['type', '26'], ['tyropm', '19'], ['start', ''], ['stop', ''], ['altDate', ''], ['transferStart', ''], ['transferStop', ''],
        ['transferAltDate', ''], ['startExpiry', '01-2000'], ['stopExpiry', '12-2060'], ['aa', ''], ['pr', ''], ['loc', ''], ['clinic', ''], ['overdueDays', ''],
        ['payer', 'All'], ['patient', ''], ['organisation', ''], ['autopm', ''], ['showTotalMode', '0'], ['ecat', ''], ['aob', ''], ['incomeType', 'paymentMethods'],
        ['displayNames', '1'], ['rstat', ''], ['rtype', ''], ['rstype', ''], ['xc', ''], ['rc', ''], ['qc', ''], ['plTaxTypeStatus', 'exclusive'],
        ['lineStatus', 'write-off'], ['lineStatus', 'voided'], ['usedDepositOption', 'all'], ['creditSummaryOption', 'summary'], ['clicked', String(Date.now())]]);
      const { names, grid } = await reportTable('/report/finance/0?' + p.toString(), 'Credit Card Expiry');
      const col = (n) => names.indexOf(n);
      const missing = ['Patient', 'Status', 'Card', 'Type', 'Expiry'].filter((n) => col(n) < 0);
      if (missing.length) throw new UPCError('Halaxy\'s Credit Card Expiry report has changed (' + missing.join(', ') + ' not found).');
      const out = [];
      grid.forEach((row) => {
        const cell = (n) => clean(row[col(n)] && row[col(n)].textContent);
        const a = row[col('Patient')] && row[col('Patient')].querySelector('a[href*="/patient/"]');
        const id = a ? (a.getAttribute('href').match(/\/patient\/(\d+)/) || [])[1] : null;
        if (!id) return;
        const m = cell('Expiry').match(/^([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
        const mi = m ? MONTHS.findIndex((x) => x.toLowerCase() === m[1].toLowerCase()) : -1;
        out.push({ patientId: String(id), patient: cell('Patient'), status: cell('Status'), last4: (cell('Card').match(/(\d{4})\s*$/) || [])[1] || '',
          type: cell('Type'), expiry: mi >= 0 ? new Date(+m[2], mi, 1).getTime() : null, expiryText: cell('Expiry') });
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
    // A stamp (CH, 11 Nov 2026): "2026-11-11 15:45 Portal fill" (the date, the time, and who: a script's name or a person's
    // initials), on its own line with the notes below it.
    stamp(by, when) {
      const d = new Date(when || Date.now());
      const p2 = (n) => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ' ' + by;
    },
    // A script's task comment (CH, 11 Nov 2026): the stamp, then each statement on its own line starting "- ".
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
    // What a note's wording says, read once and reused by every script on every PC (see noteFacts below).
    // opts.draft: the note is a draft (its notes list item's status), so it is read again after a day.
    facts: (noteId, kinds, opts) => noteFacts.get(noteId, kinds, opts),
    addFacts: (kind, version, fn) => noteFacts.add(kind, version, fn),
    saveFacts: () => noteFacts.save(),
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
      // 11-Nov 10:30 entered went on the list, and out, at 23:30 UK time on 10-Nov (live, 10 Nov 2026; CH:
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
    // Halaxy's whole patient list (POST /patient/list-data, Patients > Patient List), read in blocks of 100. Rows:
    // id (linkPaGId), givenName, preferredName, surname, patientNum, status, created, dateOfBirth, lastAppointment,
    // nextAppointment (as the retired Custom Reports read them). say(text) gets "(300 of about 4200)" for a progress bar.
    // filterModel narrows it as the list's own filters do (e.g. { status: { filterType: 'text', type: 'contains',
    // filter: 'Deleted' } }); callers still check each row, in case Halaxy ignores it.
    async listAll(say, filterModel) {
      const rows = [];
      let start = 0, total = null;
      for (;;) {
        if (say) say('Reading the patient list' + (total ? ' (' + Math.min(start, total) + ' of about ' + total + ')' : '') + '...');
        const j = await http.list('/patient/list-data', filterModel || {}, [], start, start + 100);
        const got = j && Array.isArray(j.rowData) ? j.rowData : null;
        if (!got) throw new UPCError('The patient list has changed, so it could not be read.');
        if (typeof j.lastRow === 'number' && j.lastRow >= 0) total = j.lastRow;
        rows.push(...got);
        start += got.length;
        if (!got.length || (total !== null && start >= total)) break;
      }
      if (rows.length && !rows.some((r) => 'lastAppointment' in r && 'nextAppointment' in r && 'status' in r)) {
        throw new UPCError('The patient list has changed (last or next appointment, or status, not found).');
      }
      return rows;
    },
    // Halaxy's Case Load report (Reports > Patient, type 13; capture 23 Nov 2026), every status and practitioner: one
    // table row per patient and practitioner, with a tick box input[name=link-pr-pa-g] valued with that pairing's number
    // (a linkPrPaG, not the patient's own number) and a link to the patient (/patient/{linkPaGId}).
    // Returns Map linkPaGId -> [linkPrPaG, ...].
    async caseLoad() {
      const keys = ['referralDateStart', 'referralDateStop', 'start', 'stop', 'date-range-expiry', 'patientFormExpiryFrom', 'patientFormExpiryTo', 'dateRangePatientFormExpiry',
        'patientFormSentFrom', 'patientFormSentTo', 'dateRangePatientFormSent', 'noteStatus', 'referralRecipient', 'referralLimitType', 'referralLimitOperator', 'referralLimit',
        'altDate', 'dayMonthStartDay', 'dayMonthStartMonth', 'dayMonthStopDay', 'dayMonthStopMonth', 'daysSince', 'daysSinceUnit', 'appointmentOffsetOperator',
        'appointmentOffsetAmount', 'appointmentOffsetUnit', 'appointmentOffsetTense', 'checkFuture', 'appointmentCount', 'minAge', 'maxAge', 'patientStatus', 'patient',
        'organisation', 'linkSpecialistClinic', 'accessStatus', 'pr', 'medicareDvaFunder', 'medicareVerificationStatus', 'clinic', 'introSource', 'appointmentSource', 'campaign',
        'internal-campaign', 'cstat', 'ctype', 'rstat', 'sstat', 'estat', 'faxDirection', 'phoneDirection', 'faxStatus', 'rtype', 'etype', 'rstype', 'clinicalQuestion',
        'clinicalQuestionOperator', 'clinicalQuestionValue', 'clinicalQuestionDateValue', 'clinicalQuestionLookupAnswer', 'nextApptStart', 'nextApptStop', 'nextApptAltDate',
        'nextApptDaysSince', 'nextApptDaysSinceUnit'];
      const p = new URLSearchParams([['type', '13']].concat(keys.map((k) => [k, k === 'referralLimitType' ? 'appointment' : k === 'appointmentSource' ? '0' : ''])));
      const read = async () => {
        const doc = await http.html('/report/patient/0?' + p.toString() + '&clicked=' + Date.now());
        return [...doc.querySelectorAll('input[name="link-pr-pa-g"]')];
      };
      let boxes = await read();
      if (!boxes.length) { await sleep(20000); boxes = await read(); }   // a big report can take Halaxy a moment
      if (!boxes.length) throw new UPCError('Halaxy\'s Case Load report has changed (no patient tick boxes found).');
      const map = new Map();
      boxes.forEach((b) => {
        const row = b.closest('tr');
        const a = row && row.querySelector('a[href*="/patient/"]');
        const id = a ? (a.getAttribute('href').match(/\/patient\/(\d+)/) || [])[1] : null;
        if (!id || !/^\d+$/.test(b.value)) return;
        if (!map.has(id)) map.set(id, []);
        if (!map.get(id).includes(b.value)) map.get(id).push(b.value);
      });
      if (!map.size) throw new UPCError('Halaxy\'s Case Load report has changed (no patient links by its tick boxes).');
      return map;
    },
    // Every Deleted patient's linkPaGId, from the Introduction Source report (Reports > Patient, type 12) filtered to
    // Deleted (CH, 23 Nov 2026: the only list that still shows them; the patient list leaves them out). One request.
    async deletedIds() {
      const q = 'type=12&referralDateStart=&referralDateStop=&start=&stop=&date-range-expiry=&patientFormExpiryFrom=&patientFormExpiryTo=&dateRangePatientFormExpiry=' +
        '&patientFormSentFrom=&patientFormSentTo=&dateRangePatientFormSent=&noteStatus=&referralRecipient=&referralLimitType=appointment&referralLimitOperator=&referralLimit=' +
        '&altDate=&dayMonthStartMonth=&dayMonthStopMonth=&daysSince=&daysSinceUnit=&appointmentOffsetOperator=&appointmentOffsetAmount=&appointmentOffsetUnit=' +
        '&appointmentOffsetTense=&checkFuture=&appointmentCount=&minAge=&maxAge=&patientStatus=&patientStatusMulti=deleted&patient=&organisation=&linkSpecialistClinic=' +
        '&accessStatus=&pr=&medicareDvaFunder=&medicareVerificationStatus=&clinic=&introSource=&appointmentSource=0&campaign=&internal-campaign=&cstat=&ctype=&rstat=' +
        '&sstat=&estat=&faxDirection=&phoneDirection=&faxStatus=&rtype=&etype=&rstype=&clinicalQuestion=&clinicalQuestionOperator=&clinicalQuestionValue=' +
        '&clinicalQuestionDateValue=&clinicalQuestionLookupAnswer=&nextApptStart=&nextApptStop=&nextApptAltDate=&nextApptDaysSince=&nextApptDaysSinceUnit=';
      const doc = await http.html('/report/patient/0?' + q + '&clicked=' + Date.now());
      const rows = [...doc.querySelectorAll('table tr')];
      if (!rows.length) throw new UPCError('Halaxy\'s Introduction Source report has changed (no table found).');
      const ids = new Set();
      rows.forEach((tr) => {
        const a = tr.querySelector('a[href*="/patient/"]');
        const id = a ? (a.getAttribute('href').match(/\/patient\/(\d+)/) || [])[1] : null;
        if (id && /deleted/i.test(tr.textContent)) ids.add(id);
      });
      return ids;
    },
    // Changes the status of many patients at once, as the Case Load report's Actions > Update patient status does
    // (capture 23 Nov 2026): GET /patient/bulk-update-status/LinkPaG?linkPrPaGs[]=... gives form#patient-bulk-update
    // (form[_token], select form[patientStatus] valued by lower-case name, select form[linkPrPaGs][] of the pairings
    // asked for); POST it back, answered REFRESH. Callers read the patients back to see which changed.
    async setStatusMany(linkPrPaGs, status) {
      if (!linkPrPaGs.length) return;
      const q = linkPrPaGs.map((x) => 'linkPrPaGs%5B%5D=' + encodeURIComponent(x)).join('&');
      const { doc } = await http.popup('/patient/bulk-update-status/LinkPaG?' + q);
      const form = doc.querySelector('form#patient-bulk-update');
      const token = form && form.querySelector('[name="form[_token]"]');
      const sel = form && form.querySelector('select[name="form[patientStatus]"]');
      const ids = form ? [...form.querySelectorAll('select[name="form[linkPrPaGs][]"] option')].map((o) => o.value) : [];
      if (!token || !sel) throw new UPCError('Halaxy\'s Update patient status pop-up has changed, so nothing was changed.');
      const opt = [...sel.options].find((o) => o.value.toLowerCase() === String(status).toLowerCase());
      if (!opt) throw new UPCError('There is no "' + status + '" status in Halaxy\'s list, so nothing was changed.');
      const missing = linkPrPaGs.filter((x) => !ids.includes(String(x)));
      if (missing.length) throw new UPCError('Halaxy\'s Update patient status pop-up did not list ' + missing.length + ' of the patients, so nothing was changed.');
      const pairs = [['form[_token]', token.value], ['form[patientStatus]', opt.value]].concat(linkPrPaGs.map((x) => ['form[linkPrPaGs][]', String(x)]));
      http.expectRefresh(await http.postForm('/patient/bulk-update-status/LinkPaG', pairs), 'The status change');
    },
    // The cards on a patient's Funding tab (/patient/{linkPaGId}/funding, a page; capture 23 Nov 2026): each card's delete
    // link (a#deleteCreditCardBtn, "Remove credit card") /patient/{linkPaGId}/creditcard/{card}/delete, in the same
    // card-body as its number XXXX-XXXX-XXXX-1234.
    // Returns [{ id, last4 }].
    async cards(linkPaGId) {
      const doc = await http.html('/patient/' + encodeURIComponent(linkPaGId) + '/funding');
      if (!doc.querySelector('#pageContent, body')) throw new UPCError('The patient\'s Funding tab could not be read.');
      // Halaxy gives each card's link the same id (a#deleteCreditCardBtn), not a class (live, 23 Nov 2026), so the
      // links are found by their address.
      return [...doc.querySelectorAll('a[href*="/creditcard/"]')].filter((a) => /\/creditcard\/\d+\/delete\/?$/.test(a.getAttribute('href').split('?')[0])).map((a) => {
        const id = (a.getAttribute('href').match(/\/creditcard\/(\d+)\/delete/) || [])[1] || null;
        let last4 = '';
        for (let el = a.parentElement, i = 0; el && i < 8 && !last4; el = el.parentElement, i++) last4 = (el.textContent.match(/X{4}-X{4}-X{4}-(\d{4})/i) || [])[1] || '';
        if (!id || !last4) throw new UPCError('The patient\'s Funding tab has changed (a card\'s number or delete link not found), so nothing was removed.');
        return { id, last4 };
      });
    },
    // Removes one card: Halaxy's "Delete credit card" pop-up, whose Delete button is a link
    // /patient/{linkPaGId}/creditcard/{card}/delete/<hex> (capture 23 Nov 2026); then the Funding tab is read again
    // to check it has gone.
    async deleteCard(linkPaGId, cardId) {
      const del = '/patient/' + encodeURIComponent(linkPaGId) + '/creditcard/' + encodeURIComponent(cardId) + '/delete';
      const { doc } = await http.popup(del);
      const link = [...doc.querySelectorAll('a[href]')].find((a) => a.getAttribute('href').split('?')[0].replace(/^.*\/a\/pr\/\d+/, '').startsWith(del + '/'));
      if (!link) throw new UPCError('Halaxy\'s Delete credit card pop-up has changed, so the card was not removed.');
      await http.json(link.getAttribute('href').replace(/^.*\/a\/pr\/\d+/, ''));
      if ((await patient.cards(linkPaGId)).some((c) => c.id === String(cardId))) throw new UPCError('Halaxy still shows the card after removing it.');
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
      // A Contact made a patient is given a patient number by Halaxy (14 Nov 2026): a number that was blank before is
      // expected to fill in, not a sign of something else changing.
      const changed = was.filter(([k, v]) => !(/\[patientNumber\]/.test(k) && !String(v || '').trim())).map((x) => x.join('=')).filter((x) => !now.includes(x));
      if (changed.length) {
        const err = new UPCError('The status was changed, but these details now read differently on the Edit page: ' + changed.map((x) => x.split('=')[0]).join(', ') + '. Please check the patient.');
        err.statusChanged = true;
        throw err;
      }
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
  // Our own progress bars, ticks and radio buttons are in the clinic's brand purple (#994DE6, Branding's --purple; CH,
  // 16 Nov 2026), not the browser's or Halaxy's blue.
  const NATIVE_CSS = `
    .upc-native .upc-gap { margin-top: 12px; }
    .upc-native .upc-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 4.8px; margin-top: 16px; }
    .upc-native .upc-actions .btn { margin: 0; }
    .upc-native .upc-note { white-space: pre-line; background: var(--vs-card-standout-bg-color, #f0f0f5); border-radius: 4.8px; padding: 2px 8px; margin-top: 3px; }
    .upc-native .upc-box { background: var(--vs-card-header-bg-color, #f0f0f5); border: 1px solid var(--vs-card-border-color, #ced4da); border-radius: 4.8px; padding: 8px 12px; margin-top: 12px; }
    .upc-native .upc-ok:not(.alert) { color: var(--success, #28a745); font-weight: 600; }
    .upc-native .upc-warn:not(.alert), .upc-native .upc-err:not(.alert) { color: var(--vs-balance-negative-color, #ec6b65); }
    .upc-native .alert { margin: 0 0 12px; }
    .upc-native .alert.upc-gap { margin-top: 12px; }
    .upc-native .upc-actions .upc-spacer { margin-left: auto; }
    .upc-native td.number, .upc-native th.number { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .upc-native table.table { margin: 12px 0 0; }
    .upc-native table.table td { vertical-align: top; }
    .upc-native .upc-run { margin: 12px 0 16px; }
    .upc-native .upc-run .progress { height: 8px; background: var(--vs-card-header-bg-color, #e9ecef); border-radius: 4px; overflow: hidden; }
    .upc-native .upc-run .progress-bar { height: 100%; background-color: var(--vs-btn-primary-bg-color, var(--primary, #7c3fe4)); transition: width .3s ease; }
    .upc-native .progress-bar, .upc-dialog .progress-bar { background-color: #994DE6 !important; }
    .upc-native input[type=checkbox], .upc-native input[type=radio], .upc-dialog input[type=checkbox], .upc-dialog input[type=radio],
      .upc-native input[type=range], .upc-dialog input[type=range], .upc-native progress, .upc-dialog progress { accent-color: #994DE6; }
    .upc-native .upc-run-now { margin-top: 4px; }
    .upc-native .upc-run-inline { display: inline-flex; align-items: center; gap: 8px; }
    .upc-native .upc-run-inline .progress { display: inline-block; width: 120px; height: 8px; background: var(--vs-card-header-bg-color, #e9ecef); border-radius: 4px; overflow: hidden; }
    .upc-native .upc-run-inline .progress-bar { display: block; height: 100%; background-color: var(--vs-btn-primary-bg-color, var(--primary, #7c3fe4)); }
    .upc-native .upc-run-log > summary { display: inline-block; list-style: none; margin-top: 8px; }
    .upc-native .upc-run-log > summary::-webkit-details-marker { display: none; }
    .upc-native .upc-run-log .upc-box { max-height: 300px; overflow: auto; margin-top: 8px; }
    .upc-native .upc-page-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding-bottom: 12px; margin-bottom: 4px; border-bottom: 1px solid var(--vs-card-border-color, #dee2e6); }
    .upc-native .upc-page-bar h1 { margin: 0; }
    .upc-native .nav-tabs .nav-link { border: 0; border-bottom: 2px solid transparent; margin-bottom: -1px; padding: 8px 16px 14px; border-radius: 0;
      background: none; font-weight: 500; text-decoration: none; color: var(--vs-theme-body-color, #2d2d35); }
    .upc-native .nav-tabs .nav-link:hover { text-decoration: none; color: var(--vs-nav-tabs-nav-link-hover-color, #7a38c0);
      border-bottom-color: var(--vs-nav-tabs-nav-link-hover-bottom-border-color, #c9a6f0); }
    .upc-native .nav-tabs .nav-link.active { font-weight: 700; color: var(--vs-nav-tabs-nav-link-active-color, #5c2899);
      border-bottom-color: var(--vs-nav-tabs-nav-link-active-bottom-border-color, #994de6); }
    .upc-native .upc-pill { font-size: .8em; font-weight: 600; padding: .35em .75em; vertical-align: middle; white-space: nowrap; }
    .upc-native .upc-pill.badge-light { border: 1px solid var(--vs-card-border-color, #dee2e6); }
    .upc-native .upc-divider { display: flex; align-items: center; gap: 12px; margin: 32px 0 20px; font-weight: 600; color: var(--vs-text-muted-color, #6c757d); }
    .upc-native .upc-divider::before, .upc-native .upc-divider::after { content: ''; flex: 1; border-top: 2px solid #DCC5F9; }
    .upc-native .upc-page-bar .upc-page-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .upc-native .upc-page-bar .btn { margin: 0; }
    .upc-native .upc-page-sub { display: block; min-height: 1.5em; margin: 0 0 16px; }
    .upc-native .upc-list-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px; }
    .upc-native .upc-list-tools input[type=search] { width: 280px; max-width: 100%; }
    .upc-native .upc-list-tools .upc-bulk { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-left: auto; }
    .upc-native .upc-list-tools .upc-bulk .btn { margin: 0; }
    .upc-native th[data-upc-sort] { cursor: pointer; user-select: none; white-space: nowrap; }
    .upc-native th[data-upc-sort]::after { content: '\\2195'; margin-left: 4px; opacity: .35; font-size: .85em; }
    .upc-native th[aria-sort=ascending]::after { content: '\\2191'; opacity: 1; }
    .upc-native th[aria-sort=descending]::after { content: '\\2193'; opacity: 1; }
    .upc-native th.upc-pick, .upc-native td.upc-pick { width: 1%; text-align: center; }
    .upc-native .upc-list-more { padding: 12px; }
    .upc-native .upc-list-more .btn { margin: 0; }
    .upc-native .upc-batch .progress { width: 240px; }
    .upc-native.upc-toasts { position: fixed; right: 20px; bottom: 60px; z-index: 2995; width: 380px; max-width: calc(100vw - 40px); }
    .upc-native.upc-toast { display: flex; align-items: center; gap: 12px; }
    .upc-native.upc-toast .upc-toast-act { margin: 0 0 0 auto; }
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
  // shown when asked for (CH, 13 Nov 2026: no step-by-step output while it works). Problems are always shown once
  // it has finished. The script keeps the run object and puts `ui.run.html(run)` where its log used to be.
  const runOpen = new Map();   // run id -> log open (kept across re-renders)
  let runSeq = 0;
  document.addEventListener('toggle', (e) => {
    const d = e.target;
    if (d && d.matches && d.matches('details[data-upc-run]')) runOpen.set(d.getAttribute('data-upc-run'), d.open);
  }, true);
  // A bar that fills smoothly: pages redraw it on every step, so each new bar starts where the last one was drawn and
  // slides to the new point over about the time a step has been taking (at most 2 seconds), so it keeps moving
  // rather than jumping. A redraw that doesn't move the point (pages redraw for other reasons mid-step) carries on the
  // slide already under way from where it has got to, rather than snapping to its end (CH, 23 Nov 2026: it jumped).
  const bars = new Map();   // key -> { from, to, t0, dur, stepAt, stepMs }
  function barHtml(key, pct, tag) {
    const now = Date.now();
    let b = bars.get(key), from = pct, ms = 0;
    if (!b || pct < b.to) {
      b = { from: pct, to: pct, t0: now, dur: 0, stepAt: now, stepMs: b ? b.stepMs : 0 };
    } else {
      const cur = b.dur ? b.from + (b.to - b.from) * Math.min(1, (now - b.t0) / b.dur) : b.to;
      from = cur;
      if (pct > b.to) {
        const gap = now - b.stepAt;
        b.stepMs = b.stepMs ? (b.stepMs + gap) / 2 : gap;
        b.stepAt = now;
        ms = Math.min(2000, Math.max(300, b.stepMs));
        Object.assign(b, { from: cur, to: pct, t0: now, dur: ms });
      } else {
        ms = b.dur ? Math.max(0, b.t0 + b.dur - now) : 0;
      }
    }
    bars.set(key, b);
    const t = tag || 'span';
    return '<' + t + ' class="progress-bar upc-bar" data-upc-to="' + pct.toFixed(1) + '" data-upc-ms="' + Math.round(ms) + '" style="display:block;transition:none;width:' + from.toFixed(1) + '%"></' + t + '>';
  }
  function slideBars(rootEl) {
    (rootEl || document).querySelectorAll('.upc-bar[data-upc-to]').forEach((el) => {
      const to = el.getAttribute('data-upc-to'), ms = +el.getAttribute('data-upc-ms');
      el.removeAttribute('data-upc-to');
      void el.offsetWidth;   // the starting width counts before the slide
      el.style.transition = ms ? 'width ' + ms + 'ms linear' : 'none';
      el.style.width = to + '%';
    });
  }
  if (typeof MutationObserver === 'function') {
    const hasBar = (n) => n.nodeType === 1 && (n.matches('.upc-bar[data-upc-to]') || !!n.querySelector('.upc-bar[data-upc-to]'));
    const watch = () => new MutationObserver((list) => { if (list.some((m) => [...m.addedNodes].some(hasBar))) slideBars(document); }).observe(document.body || document.documentElement, { childList: true, subtree: true });
    if (document.body) watch(); else document.addEventListener('DOMContentLoaded', watch, { once: true });
  }

  // Short-lived messages (a batch finished, Undo) as toasts: in Halaxy's own alert area (#alerts, which Toast alerts
  // lifts out of the page), so the page never moves (CH, 23 Nov 2026: a message bar bumped the page down). Without
  // #alerts, our own corner box in the same place. action: { label, fn } adds a button (Undo). ms: 0 keeps it until
  // closed (closeIn(ms) then sets when). Returns { close, closeIn }.
  function toast(text, opts) {
    opts = opts || {};
    let box = document.getElementById('alerts');
    if (!box) {
      box = document.getElementById('upc-toasts');
      if (!box) { box = document.createElement('div'); box.id = 'upc-toasts'; box.className = 'upc-native upc-toasts'; document.body.appendChild(box); }
    }
    const el = document.createElement('div');
    el.className = 'alert alert-' + (opts.kind || 'success') + ' upc-native upc-toast';
    el.setAttribute('role', 'status');
    el.textContent = text;
    let timer = null;
    const close = () => { clearTimeout(timer); el.remove(); };
    if (opts.action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-outline-primary-light upc-toast-act';
      b.textContent = opts.action.label;
      b.addEventListener('click', () => { close(); opts.action.fn(); });
      el.appendChild(document.createTextNode(' '));
      el.appendChild(b);
    }
    box.appendChild(el);
    if (opts.ms !== 0) timer = setTimeout(close, opts.ms || 8000);
    return { close, closeIn(ms) { clearTimeout(timer); timer = setTimeout(close, ms); } };
  }

  // A batch of queued actions on a page (CH, 23 Nov 2026): while two or more are queued, the line under the title bar
  // shows "Writing off (3 of 12)" with a bar filling smoothly (pages pass it as the title bar's sub-line, so nothing
  // moves); when the batch is over, a toast says how it went ("12 written off.", or "11 written off. 1 not changed.").
  // A single action keeps only its row's spinner. pending: actions queued or running now; errs: the page's running count
  // of actions that failed. Returns the sub-line's HTML while the batch runs, otherwise ''.
  const batches = new Map();
  function batch(key, verb, past, pending, errs) {
    let b = batches.get(key);
    if (pending > 0) {
      if (!b || b.over) { b = { total: pending, last: pending, start: errs, over: false }; batches.set(key, b); }
      if (pending > b.last) b.total += pending - b.last;
      b.last = pending;
      if (b.total < 2) return '';
      const done = b.total - pending;
      return '<span class="upc-batch upc-run-inline"><span class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="' + b.total + '" aria-valuenow="' + done + '">' +
        barHtml('batch:' + key, 100 * done / b.total) + '</span><span class="text-muted">' + esc(verb + ' (' + done + ' of ' + b.total + ')') + '</span></span>';
    }
    if (b && !b.over) {
      b.over = true;
      b.failed = Math.max(0, Math.min(b.total, errs - b.start));
      if (b.total >= 2) {
        const ok = b.total - b.failed;
        toast(ok + ' ' + past + '.' + (b.failed ? ' ' + b.failed + ' not changed.' : ''), { kind: b.failed ? 'warning' : 'success' });
      }
    }
    return '';
  }

  const run = {
    // total: the number of units of work (0 when unknown: the bar just moves)
    start(total) { return { id: 'r' + (++runSeq), total: total || 0, done: 0, now: '', lines: [], finished: false }; },
    step(r, text, err) { if (!r) return; r.lines.push({ t: String(text), err: !!err }); if (!err) r.now = String(text); },
    tick(r, n) { if (r) r.done = Math.min(r.total || Infinity, r.done + (n || 1)); },
    end(r, text) { if (!r) return; r.finished = true; r.done = r.total; if (text) r.lines.push({ t: String(text), err: false }); r.now = text || ''; },
    // A small moving bar with a short status, for a page's header line while it checks.
    // When the status says how far along it is ("(12 of 40)", "(12 of about 40)"), the bar shows it and fills
    // smoothly (CH, 23 Nov 2026); otherwise it is a moving "working" bar.
    inline(text) {
      const m = /\((\d+) of (?:about )?(\d+)\)/.exec(String(text || ''));
      if (m && +m[2] > 0) {
        return '<span class="upc-run-inline"><span class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="' + m[2] + '" aria-valuenow="' + m[1] + '">' +
          barHtml('inline' + m[2], Math.min(100, 100 * (+m[1]) / (+m[2]))) + '</span><span class="text-muted">' + esc(text) + '</span></span>';
      }
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
          (r.total ? barHtml(r.id, pct, 'div') : '<div class="progress-bar progress-bar-striped progress-bar-animated" style="width:100%"></div>') + '</div>' +
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

  // ------------------------------------------------------------------ page kit (CH, 23 Nov 2026: UI/UX audit)
  //
  // Every page of ours is built from the same parts, so they look and behave alike:
  //  - page.bar(): Halaxy's title bar (title left, the page's buttons right, a rule under it) and a muted line under
  //    it ("Checked at 13:56 on 23-Nov-2026.", or the inline progress bar while checking).
  //  - page.card(): a group as a card, its count (and total) in the heading, "None." when empty.
  //  - Lists: a table marked data-upc-list="<id>" gets, from list.enhance(root):
  //      search (over 10 rows; filters the rows on the page, "12 of 171"), sorting by any column heading (amounts and
  //      dates sort as such; a cell's data-sort wins), "Show 25 more" past 25 rows (CH, 23 Nov 2026), and, with data-upc-pick, a tick box
  //      per row (rows with data-upc-id; data-upc-nopick for rows that can't be picked now) and one in the heading for
  //      every row showing. A [data-upc-bulk-for="<id>"] element in the page is moved into the list's tool row.
  //    The page re-renders as it likes; the list keeps its search, sort, rows shown and ticks (and the search box its
  //    focus) across re-renders. list.picked(id) gives the ticked ids, list.unpick(id, ids) clears them.
  const PAGE_ROWS = 25;
  const lists = new Map();   // list id -> { q, col, dir, shown, picked: Set, focus, caret }
  const listState = (id) => { if (!lists.has(id)) lists.set(id, { q: '', col: -1, dir: 1, shown: PAGE_ROWS, picked: new Set(), focus: false, caret: 0 }); return lists.get(id); };
  const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  function sortKey(td) {
    const raw = td ? (td.hasAttribute('data-sort') ? td.getAttribute('data-sort') : clean(td.textContent)) : '';
    let m = raw.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
    if (m && MON[m[2].toLowerCase()] !== undefined) return { n: Date.UTC(+m[3], MON[m[2].toLowerCase()], +m[1]) };
    m = raw.match(/^-?£?\s*-?[\d,]+(\.\d+)?$/);
    if (m && raw !== '') return { n: parseFloat(raw.replace(/[£,\s]/g, '')) };
    return { s: raw.toLowerCase() };
  }
  // Headings, menu items, tabs, column headers and buttons are written as Halaxy writes them, each word with a capital
  // ("Patient List", "Tasks & Follow-Ups"; CH, 24 Nov 2026), except short joining words inside ("Cards on File",
  // "Ready to Bill"). Words already with capitals (AXA, HTML, UPC-012235) are left as they are. Sentences are not changed.
  const MINOR = new Set('a an and as at but by for in nor of on or per the to vs via with'.split(' '));
  function titleCase(text) {
    const ws = String(text == null ? '' : text).split(' ');
    let first = true;
    return ws.map((w, i) => {
      if (!/[A-Za-z]/.test(w)) return w;
      const isFirst = first;
      first = /:$/.test(w);
      if (!isFirst && i < ws.length - 1 && MINOR.has(w.toLowerCase())) return w.toLowerCase();
      return w.split('-').map((p) => (/^[a-z]/.test(p) ? p[0].toUpperCase() + p.slice(1) : p)).join('-');
    }).join(' ');
  }
  const page = {
    bar(title_, actions, sub) {
      return '<div class="upc-page-bar"><h1>' + esc(titleCase(title_)) + '</h1><div class="upc-page-actions">' + (actions || '') + '</div></div>' +
        '<div class="upc-page-sub">' + (sub || '') + '</div>';
    },
    // "Checked at 12:30 on 16-Nov-2026." for the line under the title bar.
    checked(ms) {
      return ms ? '<span class="text-muted">Checked at ' + new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + ' on ' + dayLabel(ms) + '.</span>' : '';
    },
    // A line across the page with a word in it, between the groups still to act on and those already done
    // (CH, 24 Nov 2026), e.g. divider('Done').
    divider(text) { return '<div class="upc-divider"><span>' + esc(titleCase(text)) + '</span></div>'; },
    // A row's outcome as a pill (CH, 24 Nov 2026: "Moved" in green text looked out of place): kind ok (done), err
    // (not changed), wait (queued), info.
    pill(text, kind) {
      const k = { ok: 'success', err: 'danger', wait: 'light', info: 'info' }[kind || 'ok'] || 'success';
      return '<span class="badge badge-pill badge-' + k + ' upc-pill">' + esc(text) + '</span>';
    },
    card(title_, n, extra, body) {
      return '<div class="card"><div class="card-header"><h2>' + esc(titleCase(title_)) + ' (' + n + (extra ? ', ' + esc(extra) : '') + ')</h2></div><div class="card-body p-0">' +
        (n ? body : '<p class="text-muted m-3">None.</p>') + '</div></div>';
    },
  };
  const list = {
    picked: (id) => [...listState(id).picked],
    unpick(id, ids) { const s = listState(id); (ids || [...s.picked]).forEach((x) => s.picked.delete(String(x))); },
    enhance(root, opts) {
      opts = opts || {};
      if (!root.__upcLists) {
        root.__upcLists = true;
        root.addEventListener('input', (e) => {
          const box = e.target.closest && e.target.closest('input[data-upc-search]');
          if (!box) return;
          const s = listState(box.getAttribute('data-upc-search'));
          s.q = box.value; s.shown = PAGE_ROWS; s.caret = box.selectionStart || 0;
          list.enhance(root, root.__upcListOpts);
        });
        root.addEventListener('focusin', (e) => { const b = e.target.closest && e.target.closest('input[data-upc-search]'); if (b) listState(b.getAttribute('data-upc-search')).focus = true; });
        root.addEventListener('focusout', (e) => { const b = e.target.closest && e.target.closest('input[data-upc-search]'); if (b) { const s = listState(b.getAttribute('data-upc-search')); s.focus = false; s.caret = b.selectionStart || 0; } });
        root.addEventListener('click', (e) => {
          const th = e.target.closest && e.target.closest('th[data-upc-sort]');
          if (th) {
            const s = listState(th.closest('table').getAttribute('data-upc-list')), col = +th.getAttribute('data-upc-sort');
            if (s.col === col) s.dir = -s.dir; else { s.col = col; s.dir = 1; }
            list.enhance(root, root.__upcListOpts);
            return;
          }
          const more = e.target.closest && e.target.closest('[data-upc-more]');
          if (more) { listState(more.getAttribute('data-upc-more')).shown += PAGE_ROWS; list.enhance(root, root.__upcListOpts); }
        });
        root.addEventListener('change', (e) => {
          const box = e.target.closest && e.target.closest('input[data-upc-tick]');
          if (!box) return;
          const table = box.closest('table'), s = listState(table.getAttribute('data-upc-list'));
          const rows = box.hasAttribute('data-upc-all') ? [...table.tBodies[0].rows].filter((tr) => tr.style.display !== 'none' && tr.querySelector('input[data-upc-tick]:not([data-upc-all]):not(:disabled)')) : [box.closest('tr')];
          rows.forEach((tr) => { const id = tr.getAttribute('data-upc-id'); if (box.checked) s.picked.add(id); else s.picked.delete(id); });
          if (typeof (root.__upcListOpts || {}).onPick === 'function') root.__upcListOpts.onPick(); else list.enhance(root, root.__upcListOpts);
        });
      }
      root.__upcListOpts = opts;
      // auto: every table in a card is a list, named by its card's heading (without the count), so its search,
      // sort and ticks stay with it whichever cards are showing.
      if (opts.auto) root.querySelectorAll('.card table.table:not([data-upc-list])').forEach((t) => {
        if (t.parentElement.closest('table')) return;
        const h = t.closest('.card').querySelector('.card-header h2, .card-header');
        t.setAttribute('data-upc-list', clean(h ? h.textContent : '').replace(/\s*\(.*$/, '').toLowerCase() || 'list');
      });
      root.querySelectorAll('table[data-upc-list]').forEach((table) => {
        const id = table.getAttribute('data-upc-list'), s = listState(id), body = table.tBodies[0];
        if (!body) return;
        const pick = table.hasAttribute('data-upc-pick'), head = table.tHead && table.tHead.rows[0];
        // Tick boxes (added once per render)
        if (pick && head && !head.querySelector('th.upc-pick')) {
          const th = document.createElement('th'); th.className = 'upc-pick';
          th.innerHTML = '<input type="checkbox" data-upc-tick data-upc-all aria-label="Tick all">';
          head.insertBefore(th, head.firstChild);
          [...body.rows].forEach((tr) => {
            const td = document.createElement('td'); td.className = 'upc-pick';
            const rid = tr.getAttribute('data-upc-id');
            if (rid !== null) {
              const no = tr.hasAttribute('data-upc-nopick');
              if (no) s.picked.delete(rid);
              td.innerHTML = '<input type="checkbox" data-upc-tick aria-label="Tick"' + (no ? ' disabled' : '') + (s.picked.has(rid) ? ' checked' : '') + '>';
            }
            tr.insertBefore(td, tr.firstChild);
          });
        }
        // Sortable headings
        if (head) [...head.cells].forEach((th, i) => {
          if (th.classList.contains('upc-pick') || th.hasAttribute('data-upc-nosort') || !clean(th.textContent)) return;
          th.setAttribute('data-upc-sort', String(i));
          if (s.col === i) th.setAttribute('aria-sort', s.dir > 0 ? 'ascending' : 'descending'); else th.removeAttribute('aria-sort');
        });
        let rows = [...body.rows];
        rows.forEach((tr, i) => { if (!tr.hasAttribute('data-upc-order')) tr.setAttribute('data-upc-order', String(i)); });
        if (s.col >= 0) {
          rows.sort((a, b) => {
            const x = sortKey(a.cells[s.col]), y = sortKey(b.cells[s.col]);
            const r = x.n !== undefined && y.n !== undefined ? x.n - y.n : String(x.s !== undefined ? x.s : x.n).localeCompare(String(y.s !== undefined ? y.s : y.n));
            return (r || (+a.getAttribute('data-upc-order') - +b.getAttribute('data-upc-order'))) * (r ? s.dir : 1);
          });
          rows.forEach((tr) => body.appendChild(tr));
        }
        // Search and rows shown
        const q = clean(s.q).toLowerCase();
        const match = rows.filter((tr) => !q || clean(tr.textContent).toLowerCase().includes(q));
        rows.forEach((tr) => { tr.style.display = 'none'; });
        match.slice(0, s.shown).forEach((tr) => { tr.style.display = ''; });
        const all = table.querySelector('input[data-upc-all]');
        if (all) {
          const showing = match.slice(0, s.shown).filter((tr) => tr.querySelector('input[data-upc-tick]:not(:disabled)'));
          all.checked = showing.length > 0 && showing.every((tr) => s.picked.has(tr.getAttribute('data-upc-id')));
        }
        // Tool row above the table: search when the list is long, and the page's bulk actions
        let tools = table.previousElementSibling && table.previousElementSibling.classList.contains('upc-list-tools') ? table.previousElementSibling : null;
        const min = +(table.getAttribute('data-upc-list-min') || 10);
        const bulk = root.querySelector('[data-upc-bulk-for="' + id + '"]');
        if (!tools && (rows.length > min || bulk)) {
          tools = document.createElement('div'); tools.className = 'upc-list-tools';
          if (rows.length > min) tools.innerHTML = '<input type="search" class="form-control" placeholder="Search" data-upc-search="' + esc(id) + '" aria-label="Search"><span class="text-muted" data-upc-count></span>';
          table.parentNode.insertBefore(tools, table);
          const box = tools.querySelector('input[data-upc-search]');
          if (box) { box.value = s.q; if (s.focus) { box.focus(); try { box.setSelectionRange(s.caret, s.caret); } catch (e) { /* fine */ } } }
        }
        if (tools && bulk && bulk.parentNode !== tools) { bulk.classList.add('upc-bulk'); tools.appendChild(bulk); }
        const count = tools && tools.querySelector('[data-upc-count]');
        if (count) count.textContent = q ? match.length + ' of ' + rows.length : '';
        // "Show 25 more"
        let more = table.nextElementSibling && table.nextElementSibling.classList.contains('upc-list-more') ? table.nextElementSibling : null;
        if (match.length > s.shown) {
          if (!more) { more = document.createElement('div'); more.className = 'upc-list-more'; table.parentNode.insertBefore(more, table.nextSibling); }
          more.innerHTML = '<button type="button" class="btn btn-outline-primary-light" data-upc-more="' + esc(id) + '">Show ' + Math.min(PAGE_ROWS, match.length - s.shown) + ' More</button> <span class="text-muted">' + s.shown + ' of ' + match.length + ' shown</span>';
        } else if (more) more.remove();
      });
    },
  };

  // ------------------------------------------------------------------ To do summaries (CH, 23 Nov 2026)
  // Each list page publishes its count and top rows when it paints its menu badge; the To do page shows a card for
  // each whose menu item is in this person's menu (so only lists they can open). Kept in this browser; written only
  // when it changes (the menu is repainted often).
  const todo = {
    publish(key, o) {
      try {
        const k = 'upc-todo:' + key, body = JSON.stringify(o);
        const old = JSON.parse(localStorage.getItem(k) || 'null');
        if (old && JSON.stringify(old.o) === body) return;
        localStorage.setItem(k, JSON.stringify({ at: Date.now(), o }));
      } catch (e) { /* storage blocked */ }
    },
    all() {
      const out = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (!k || !k.startsWith('upc-todo:')) continue;
          const v = JSON.parse(localStorage.getItem(k) || 'null');
          if (v && v.o) out.push(Object.assign({ key: k.slice(9), at: v.at }, v.o));
        }
      } catch (e) { /* storage blocked */ }
      return out;
    },
  };

  // Our menu items, in the order they appear under Halaxy's own in each section.
  const MENU_ORDER = ['To do', 'My tasks', 'Patient forms', 'Review requests', 'Missing details', 'Open-ended recalls',
    'Record retention', 'Cards on file', 'Ready to bill', 'Remittances', 'Bank statement', 'Insurer payments due', 'Old balances'];

  const ui = {
    nativeStyles,
    run,
    titleCase,
    batch,
    toast,
    page,
    list,
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
      title = titleCase(title);
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
      return { root, body, close, setTitle: (s) => { root.querySelector('.modal-title').textContent = titleCase(s); } };
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
        a.textContent = titleCase(label);
        // A fixed order after Halaxy's own items (CH, 23 Nov 2026: our items moved about with the scripts' load order).
        const at = MENU_ORDER.findIndex((m) => m.toLowerCase() === String(label).toLowerCase());
        const rank = at < 0 ? MENU_ORDER.length : at;
        copy.setAttribute('data-upc-menu-rank', String(rank));
        const after = [...host.parentNode.children].find((n) => n.hasAttribute && n.hasAttribute('data-upc-menu-rank') && +n.getAttribute('data-upc-menu-rank') > rank);
        host.parentNode.insertBefore(copy, after || null);
        return true;
      }
      const first = items[0];
      if (first && first.parentNode) {
        const li = document.createElement(first.tagName.toLowerCase());
        li.className = 'mainmenu-item';
        li.innerHTML = '<a class="mainmenu-link ' + esc(cls) + '" href="' + esc(href) + '"><span class="mainmenu-link-label">' + esc(titleCase(label)) + '</span></a>';
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
    // Opens one of Halaxy's own pop-ups (Edit task, add task...) the way its own links do: a link carrying Halaxy's
    // "ajax" behaviour class, clicked. The one deliberate use of a behaviour class (CH, 23 Nov 2026: Halaxy's own
    // pop-up is the native way to edit, with its date picker, assignees and search), so Halaxy's code acting on it is
    // the point. onClose runs once the pop-up has opened and closed. Halaxy may instead reload the page (it answers
    // some saves with REFRESH and an address): halaxyPopupReturn() then gives the page (#hash) that opened it.
    // Returns false if no pop-up opened within 5 seconds.
    halaxyPopup(path, onClose) {
      return new Promise((resolve) => {
        const a = document.createElement('a');
        a.className = 'ajax';
        a.href = url(path);
        a.style.display = 'none';
        a.setAttribute('data-upc-halaxy-popup', '');
        document.body.appendChild(a);
        try { sessionStorage.setItem('upc-halaxy-popup', JSON.stringify({ at: Date.now(), from: location.hash })); } catch (e) { /* fine */ }
        let seen = false;
        const t0 = Date.now();
        const isOpen = () => !!document.querySelector('.bootbox');
        const done = (ok) => { mo.disconnect(); clearInterval(timer); a.remove(); resolve(ok); };
        const look = () => {
          if (isOpen()) { if (!seen) { seen = true; } return; }
          if (seen) { done(true); if (onClose) onClose(); } else if (Date.now() - t0 > 5000) { try { sessionStorage.removeItem('upc-halaxy-popup'); } catch (e) { /* fine */ } done(false); }
        };
        const mo = new MutationObserver(look);
        mo.observe(document.body, { childList: true, subtree: true });
        const timer = setInterval(look, 500);
        const $ = window.jQuery;
        if ($ && $.fn) $(a).trigger('click'); else a.click();
      });
    },
    // Halaxy's date picker (flatpickr, which its pages load; CH, 23 Nov 2026) on one of our date boxes. The box is
    // written as <input type="date"> with an ISO value (and min), and keeps that ISO value, so code reading it is the
    // same either way; the person sees and picks dates as Halaxy shows them (05-Nov-2026). Without flatpickr (tests,
    // other pages) the browser's own date box stays. Returns the picker, or null.
    datePicker(input, opts) {
      const $ = window.jQuery;
      const fp = typeof window.flatpickr === 'function' ? (el, o) => window.flatpickr(el, o) : $ && $.fn && $.fn.flatpickr ? (el, o) => $(el).flatpickr(o) : null;
      if (!fp || !input || input.__upcPicker) return null;
      const value = input.value, min = input.getAttribute('min'), max = input.getAttribute('max');
      input.type = 'text';
      const p = fp(input, Object.assign({ dateFormat: 'Y-m-d', altInput: true, altFormat: 'd-M-Y', defaultDate: value || null, minDate: min || null, maxDate: max || null }, opts || {}));
      input.__upcPicker = p;
      return p;
    },
    halaxyPopupReturn() {
      try {
        const v = JSON.parse(sessionStorage.getItem('upc-halaxy-popup') || 'null');
        sessionStorage.removeItem('upc-halaxy-popup');
        return v && Date.now() - v.at < 10 * 60e3 ? v.from : null;
      } catch (e) { return null; }
    },
    mountPage(title, root, menuCls) {
      const undo = [];
      const shell = document.createElement('div');
      shell.setAttribute('data-upc-page', '');
      const bg = getComputedStyle(document.body).backgroundColor;
      shell.style.cssText = 'position:fixed;z-index:60;overflow:auto;box-sizing:border-box;padding:16px 20px;background:' +
        (bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg) ? bg : '#fff') + ';';
      root.classList.add('upc-page-root');
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
      // Halaxy's page underneath must not scroll while ours is shown: it would slide up under the top bar (CH,
      // 23 Nov 2026). Its scroll position is put back when ours closes; our page scrolls on its own and doesn't hand
      // the scroll on to Halaxy's when it reaches the end.
      const scrollY = window.scrollY, html = document.documentElement, body = document.body;
      const oldHtml = html.style.overflow, oldBody = body.style.overflow;
      window.scrollTo(0, 0);
      html.style.overflow = 'hidden'; body.style.overflow = 'hidden';
      shell.style.overscrollBehavior = 'contain';
      undo.push(() => { html.style.overflow = oldHtml; body.style.overflow = oldBody; window.scrollTo(0, scrollY); });
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
  // so they don't run on an exact clock (CH, 12 Nov 2026).
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
  // Tuned on six months of the clinic's notes (Heidi; 18 Nov 2026): see the project doc clinical-notes-structure.md.
  const IF_NEEDED = '(if|when|as) (needed|required|necessary|nec|req|reqd|appropriate)|if (any|further) (problems|issues|concerns|symptoms)|' +
    'if (it |things |symptoms? |pain |back |knee |hip |neck |shoulder )?(gets? worse|worsens?|returns?|recurs?|flares?( up)?|deteriorates?|persists?|(is |are )?not settl(ed|ing)|(does|do)n.?t settle)|prn|sos';
  const COMEBACK = '(come|coming|call|ring|get|getting|contact|be|return(ing)?|rtc|rebook(ing)?|book(ing)?) ?(back|in touch|us|again|in|to (the )?(clinic|physio))?';
  const wording = {
    // The note as it bears on this course of treatment: the past history section and any point about earlier problems
    // are taken out before the phrases are looked for (CH, 24 Nov 2026: "Previous scoliosis as child - treated with
    // physio, discharged" under Past Medical History read as this course being discharged). The text is one line
    // (notes.text), so a section runs from its heading to the next heading.
    current(text) {
      const HIST = /\b(past medical history|medical history|past history|pmh|social history|drug history|family history|previous history)\s*:/i;
      const NEXT = /\b(subjective|objective|assessment|plan|treatment|impression|diagnosis|goals?|advice|education|outcome|management|summary)\s*:/i;
      let t = String(text || ''), m;
      while ((m = HIST.exec(t))) {
        const rest = t.slice(m.index + m[0].length), n = NEXT.exec(rest);
        t = t.slice(0, m.index) + ' ' + (n ? rest.slice(n.index) : '');
      }
      // A point (from " - " or a sentence start) about earlier problems, up to the next point, full stop or heading.
      return t.replace(/(^|\s-\s|\.\s)[^-.:]*?\b(previous(ly)?|as a child|in childhood|years ago|in the past|history of|hx of)\b[^-.]*?(?=\s-\s|\.|\s[A-Za-z]+( [a-z]+)*\s*:|$)/gi, '$1 ');
    },
    NEGATION: /\b(not|no longer|never|isn'?t|wasn'?t|hasn'?t|without|unable to|not yet|before|no need to)\b[^.]{0,20}$/i,
    // Treatment has finished.
    FINISHED: [
      ['discharged', /\bdischarg(ed|e)\b(?! from (?!physio))|\bd\/?c(ed)? from physio/i],   // not "discharged from orthopaedics"
      ['goals met', /\bgoals? (met|achieved|reached)\b|\bachieved (all )?(his |her |their )?goals?\b/i],
      ['no further treatment', /\bno (further|more) (physio(therapy)? )?(treatment|physio|physiotherapy|sessions?|appointments?|appts?) (needed|required|necessary)\b/i],
      ['self-managing', /\bself[- ]?manag|\bindependent(ly)? (with|managing)|\bcontinue (with )?(home )?(exercises|hep|programme|program) independently\b/i],
      ['final session', /\bfinal (session|appointment|appt) today\b|\bagreed (to )?(a |the )?final (session|appointment)\b|\blast (session|appointment|appt) today\b/i],
    ],
    // Left open: the patient may come back.
    OPEN_ENDED: [
      ['open return', /\bopen (return|review|f\/?u|follow[- ]?up)\b|\bleft open\b|\bopen[- ]ended\b/i],
      ['open appointment', /\bopen (appointment|appt|booking)\b/i],
      ['book again if needed', new RegExp('\\b(re-?)?book (again|in|back|another( session| appointment| appt)?|a follow[- ]?up)?\\s*(' + IF_NEEDED + ')\\b', 'i')],
      ['come back if needed', new RegExp('\\b' + COMEBACK + '\\s*(' + IF_NEEDED + ')\\b|\\b(to |will )?(contact|call|ring|email|e-?mail|text|message) (us|clinic|the clinic|me)?\\s*(' + IF_NEEDED + ')\\b|\\bget in touch\\b', 'i')],
      ['see how things go', /\bsee how (things|it|he|she|they|pt|patient|symptoms|knee|back|shoulder|ankle|hip|neck)?\s*(go(es)?|get(s)? on|progress(es)?|settle(s)?)\b|\bwait and see\b/i],
      // PRN / SOS only next to a follow-up or review: on their own they are mostly about medication ("paracetamol PRN").
      ['see as needed', new RegExp('\\b(see|review|f\\/?u|follow[- ]?up|physio)( appointments?| sessions?| appts?)?\\b[^.;\\n]{0,25}?\\b(' + IF_NEEDED + ')\\b', 'i')],
    ],
    // Where a note says how treatment ends: from its Assessment (or Plan) heading on, when it has one. Heidi's notes
    // start with Subjective and past history ("discharged from orthopaedics"), which isn't about this course.
    outcome(text) {
      const t = '\n' + String(text || '');
      const m = /\n\s*(assessment|plan)\s*:?\s*(\n|$)/i.exec(t);
      return m ? t.slice(m.index) : t;
    },
    // The kinds in `list` ([[name, regex]]) found in text, in list order; with negatable (default), negated ones don't count,
    // nor do ones put off "until" something ("no further physio appointments until orthopaedic assessment").
    find(text, list, negatable) {
      const t = String(text || '');
      const found = [];
      list.forEach(([name, re]) => {
        const g = new RegExp(re.source, 'gi');
        let m;
        while ((m = g.exec(t))) {
          if (negatable !== false && wording.NEGATION.test(t.slice(Math.max(0, m.index - 30), m.index))) continue;
          if (negatable !== false && /\buntil\b/i.test(t.slice(m.index, m.index + 80).split(/[\n.;]/)[0])) continue;
          if (!found.includes(name)) found.push(name);
          break;
        }
      });
      return found;
    },
    finished(text) { return wording.find(wording.outcome(text), wording.FINISHED); },
    openEnded(text) { return wording.find(wording.outcome(text), wording.OPEN_ENDED); },
  };

  // Lists shared by every PC (CH, 16 Nov 2026): one PC works a list out and every PC shows it. One Admin Note per list
  // on UPC scripts (settings), "UPC shared list: <name>", whose last line is "data <the result as JSON>" (patient names
  // allowed: the note is inside Halaxy, Access All). Halaxy keeps at least 150,000 characters in a note (16 Nov 2026).
  // Who refreshes is claimed in the "UPC shared checks: Lists" note, so two PCs don't work the same list out at once.
  const LIST_HEAD = 'UPC shared list: ';
  const LIST_INFO = 'Kept by UPC scripts. Please do not edit: the list is worked out again if it is changed.';
  function sharedResult(name) {
    const head = LIST_HEAD + name, slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const st = storage('upc-list:' + slug + ':');
    const claims = () => shared('Lists', { keep: 7 * 86400e3, claimFor: 10 * 60e3 });
    async function ours() {
      return (await adminNotes.list('organisation', SHARED_ORG)).filter((n) => n.text.split('\n')[0] === head).sort((a, b) => Number(a.id) - Number(b.id));
    }
    const dataOf = (n) => {
      const line = n ? n.text.split('\n').reverse().find((l) => l.startsWith('data ')) : null;
      try { const d = line ? JSON.parse(line.slice(5)) : null; return d && typeof d === 'object' && d.at ? d : null; } catch (e) { return null; }
    };
    return {
      // The shared result into this PC's store (key 'result') when it is newer than this PC's; returns it (or null).
      // maxAge: use this PC's last read if younger (ms).
      async pull(store, maxAge) {
        let c = st.get('cache', null);
        if (!c || !(Date.now() - c.at < (maxAge || 0))) {
          // A note that can't be read counts as read (nothing), so the other tabs don't all ask again straight away.
          let data = null;
          try { data = dataOf((await ours())[0]); } catch (e) { st.set('cache', { at: Date.now(), data: c ? c.data : null }); throw e; }
          c = { at: Date.now(), data };
          st.set('cache', c);
        }
        const local = store.get('result', null);
        if (c.data && (!local || !(local.at >= c.data.at))) store.set('result', c.data);
        return c.data;
      },
      // True when this PC may work the list out now (nobody else is).
      async claim() { return (await claims().claim(['list.' + slug])).includes('list.' + slug); },
      // Shares the result with every PC and lets go of the claim.
      async push(result) {
        const text = [head, LIST_INFO, 'data ' + JSON.stringify(result)].join('\n');
        const all = await ours();
        if (!all.length) await adminNotes.add('organisation', SHARED_ORG, text);
        else await adminNotes.update('organisation', SHARED_ORG, all[0].id, text);
        for (const n of all.slice(1)) { try { await adminNotes.remove('organisation', SHARED_ORG, n.id); } catch (e) { /* tried again next time */ } }
        st.set('cache', { at: Date.now(), data: result });
        await claims().write({ ['list.' + slug]: 'done' }).catch(() => {});
      },
      release: () => claims().write({}).catch(() => {}),
    };
  }

  // ------------------------------------------------------------------ note facts

  // Note facts (core 0.1.67, CH, 20 Nov 2026): what a clinical note's wording says (which kinds of phrase it contains,
  // never its text), worked out once per note and reused by Open-ended recalls, Patient statuses and Review requests, on
  // every PC. Each kind has a function of the note's text and a version (with the wording lists' WORDING_V); a note is
  // read again only for a kind it hasn't got at the current version, and then every known kind is worked out at once.
  // Kept on this PC (local storage) and shared through one Admin Note, "UPC shared list: Note wording" (JSON, merged on
  // each save, 150 days, trimmed to fit), pulled at most every 15 minutes and saved a minute after new facts are found.
  // A published note doesn't change; a draft is read again after a day.
  const WORDING_V = 2;   // bump when wording.FINISHED / OPEN_ENDED / NEGATION or outcome() change
  const noteFacts = (() => {
    const kinds = { finished: { v: '1', fn: (t) => wording.finished(t) }, open: { v: '1', fn: (t) => wording.openEnded(t) } };
    const st = storage('upc-notefacts:');
    const KEEP = 150 * 864e5, MAX_CHARS = 110000, PULL_EVERY = 15 * 60e3, DRAFT_AGAIN = 864e5;
    const head = LIST_HEAD + 'Note wording';
    const ver = (k) => kinds[k].v + '.' + WORDING_V;
    let pulling = null, saveTimer = null;
    const map = () => st.get('map', {});
    function merge(into, from) {
      Object.keys(from || {}).forEach((id) => {
        const a = into[id], b = from[id];
        if (!b || !b.k) return;
        if (!a) { into[id] = b; return; }
        Object.keys(b.k).forEach((k) => { if (!a.k[k] || (b.at || 0) > (a.at || 0)) a.k[k] = b.k[k]; });
        a.at = Math.max(a.at || 0, b.at || 0);
        if ((b.at || 0) >= (a.at || 0)) a.draft = !!b.draft;
      });
      return into;
    }
    function trim(m) {
      const now = Date.now();
      let ids = Object.keys(m).filter((id) => now - (m[id].at || 0) < KEEP).sort((x, y) => (m[y].at || 0) - (m[x].at || 0));
      const out = {};
      let size = 0;
      for (const id of ids) {
        size += JSON.stringify(m[id]).length + id.length + 4;
        if (size > MAX_CHARS) break;
        out[id] = m[id];
      }
      return out;
    }
    async function noteOf() {
      return (await adminNotes.list('organisation', SHARED_ORG)).filter((n) => n.text.split('\n')[0] === head).sort((a, b) => Number(a.id) - Number(b.id));
    }
    const dataOf = (n) => {
      const line = n ? n.text.split('\n').reverse().find((l) => l.startsWith('data ')) : null;
      try { const d = line ? JSON.parse(line.slice(5)) : null; return d && d.notes ? d.notes : {}; } catch (e) { return {}; }
    };
    function pull() {
      if (Date.now() - st.get('pulled', 0) < PULL_EVERY) return Promise.resolve();
      if (!pulling) {
        pulling = noteOf().then((all) => { st.set('map', trim(merge(map(), dataOf(all[0])))); })
          .catch(() => { /* this PC's own facts until the next pull */ })
          .finally(() => { st.set('pulled', Date.now()); pulling = null; });
      }
      return pulling;
    }
    async function save() {
      saveTimer = null;
      try {
        const all = await noteOf();
        const m = trim(merge(dataOf(all[0]), map()));
        st.set('map', m);
        const text = [head, LIST_INFO, 'data ' + JSON.stringify({ at: Date.now(), notes: m })].join('\n');
        if (!all.length) await adminNotes.add('organisation', SHARED_ORG, text);
        else await adminNotes.update('organisation', SHARED_ORG, all[0].id, text);
        st.set('dirty', false);
      } catch (e) { /* saved with the next new facts */ }
    }
    const later = () => { st.set('dirty', true); if (!saveTimer) saveTimer = setTimeout(save, 60e3); };
    if (st.get('dirty', false)) setTimeout(() => { if (!saveTimer) later(); }, 5000);
    return {
      add(kind, version, fn) { kinds[kind] = { v: String(version), fn }; },
      // { kind: value } for the kinds asked (all known kinds if none given).
      async get(noteId, want, opts) {
        const id = String(noteId);
        want = want && want.length ? want : Object.keys(kinds);
        want.forEach((k) => { if (!kinds[k]) throw new UPCError('Unknown note fact: ' + k); });
        await pull();
        let m = map(), e = m[id];
        const fresh = (x) => x && !(x.draft && Date.now() - (x.at || 0) > DRAFT_AGAIN);
        if (!fresh(e) || want.some((k) => !e.k[k] || e.k[k][0] !== ver(k))) {
          const text = wording.current(await notes.text(id));
          e = { at: Date.now(), k: {}, draft: !!(opts && opts.draft) };
          Object.keys(kinds).forEach((k) => { e.k[k] = [ver(k), kinds[k].fn(text)]; });
          m = map();
          m[id] = e;
          st.set('map', m);
          later();
        }
        const out = {};
        want.forEach((k) => { out[k] = e.k[k][1]; });
        return out;
      },
      save,
    };
  })();

  // ------------------------------------------------------------------ clinic settings

  // Settings shared by every PC (CH, 15 Nov 2026): one Admin Note, "UPC clinic settings", on UPC scripts (settings),
  // one "key = value" line each, changed only through Script settings > Clinic settings by CLINIC_EDITORS. Each PC reads it
  // about hourly (visible tab, shared across tabs) and keeps a copy; a value missing, unreadable or outside its limits
  // falls back to its default, and the health check lists it.
  const CLINIC_HEAD = 'UPC clinic settings';
  const CLINIC_INFO = 'Changed in Script settings > Clinic settings. Please do not edit here: a line that is changed by hand is ignored.';
  const CLINIC_EDITORS = ['Carl Healy'];
  const CLINIC_EVERY = 3600e3;
  // { key, script, label, unit, def, min, max, type: 'number' (whole numbers) | 'time' ('HH:MM') | 'people' (names, at
  // least one) | 'person' (one name) | 'order' (names in order, at least one) | 'weekdays' ('Mon'..'Sun', may be none) |
  // 'dates' ('YYYY-MM-DD', may be none; '25-Dec-2026' and '25/12/2026' are read too) | 'words' (may be none) | 'text' (one
  // line matching def.re, up to def.max characters) | 'audience' ('everyone', or names, may be none: who a per-person
  // option is on for) | 'choice' (one of def.options' keys) }. Names are Halaxy users' full names, as signed in ('Carl Healy').
  // An empty list is kept in the note as "none".
  const CARL = 'Carl Healy', WENDY = 'Wendy Pritchard';
  const CLINIC_SETTINGS = [
    { key: 'readyToBill.maxExcess', script: 'Ready to bill', label: 'Ignore an excess over', unit: '£', def: 500, min: 50, max: 5000 },
    { key: 'readyToBill.rollingDays', script: 'Ready to bill', label: 'Bill once the oldest unbilled fee is', unit: 'days old', def: 28, min: 7, max: 90 },
    { key: 'readyToBill.soonDays', script: 'Ready to bill', label: 'Unless the next appointment is within', unit: 'days', def: 7, min: 0, max: 28 },
    { key: 'readyToBill.quietDays', script: 'Ready to bill', label: 'Bill when nothing is booked and no visit for', unit: 'days', def: 14, min: 3, max: 90 },
    { key: 'readyToBill.minFees', script: 'Ready to bill', label: 'With no excess known, hold a new claim until there are', unit: 'fees', def: 2, min: 1, max: 10 },
    { key: 'readyToBill.oldMonths', script: 'Ready to bill', label: 'Bill fees older than', unit: 'months', def: 3, min: 1, max: 12 },
    { key: 'readyToBill.windowMonths', script: 'Ready to bill', label: 'Leave out fees older than', unit: 'months', def: 6, min: 2, max: 24 },
    { key: 'insurerPayments.overdueDays', script: 'Insurer payments due', label: 'An insurer invoice is overdue after', unit: 'days', def: 30, min: 7, max: 180 },
    { key: 'openEnded.afterDays', script: 'Open-ended recalls', label: 'List patients last seen at least', unit: 'days ago', def: 21, min: 7, max: 90 },
    { key: 'openEnded.upToDays', script: 'Open-ended recalls', label: 'and at most', unit: 'days ago', def: 91, min: 30, max: 365 },
    { key: 'patientStatuses.gapDays', script: 'Patient statuses', label: 'Discharged when nothing is booked and no appointment for', unit: 'days', def: 42, min: 14, max: 365 },
    { key: 'patientStatuses.maxChanges', script: 'Patient statuses', label: 'Most status changes in one run', unit: 'changes', def: 15, min: 1, max: 50 },
    { key: 'reviewRequests.sendAt', script: 'Review requests', label: 'Send at (weekdays)', unit: '', def: '10:30', min: '07:00', max: '20:00', type: 'time' },
    { key: 'reviewRequests.quietDays', script: 'Review requests', label: 'Ask once there has been no visit for', unit: 'days', def: 14, min: 1, max: 60 },
    { key: 'reviewRequests.maxDays', script: 'Review requests', label: 'Stop asking after', unit: 'days since the last visit', def: 28, min: 7, max: 120 },
    { key: 'reviewRequests.minAge', script: 'Review requests', label: 'Leave out patients under', unit: 'years old', def: 16, min: 0, max: 25 },
    { key: 'apptReminders.cancel', script: 'Appointment reminders', label: 'Cancel the reminder after a late booking', type: 'choice', def: 'on', options: { on: 'On', off: 'Off' } },
    { key: 'apptReminders.cancelWithin', script: 'Appointment reminders', label: 'Late booking: confirmation sent within', unit: 'hours of the reminder', def: 24, min: 1, max: 72 },
    { key: 'apptReminders.add', script: 'Appointment reminders', label: 'Add a missing reminder', type: 'choice', def: 'on', options: { on: 'On', off: 'Off' } },
    { key: 'patientForms.send', script: 'Patient forms', label: 'Send forms for', type: 'choice', def: 'late', options: { late: 'Late bookings only', all: 'All bookings', off: 'Nobody' } },
    { key: 'patientForms.sendAt', script: 'Patient forms', label: 'Send at, the day before', type: 'time', def: '05:00', min: '00:00', max: '12:00' },
    { key: 'patientForms.chase', script: 'Patient forms', label: 'Reminders', type: 'choice', def: 'on', options: { on: 'On', off: 'Off' } },
    { key: 'patientForms.chaseAt', script: 'Patient forms', label: 'Reminder at, the day before', type: 'time', def: '18:00', min: '12:00', max: '22:00' },
    { key: 'missingDetails.aheadDays', script: 'Missing details', label: 'Check patients booked in the next', unit: 'days', def: 14, min: 1, max: 60 },
    { key: 'missingDetails.backDays', script: 'Missing details', label: 'and those seen in the last', unit: 'days', def: 30, min: 0, max: 180 },
    { key: 'bankStatement.lingerDays', script: 'Bank statement', label: 'Task when a deposit and its remittance are still not matched after', unit: 'days', def: 10, min: 3, max: 60 },
    { key: 'bankStatement.dueFromDay', script: 'Bank statement', label: 'Remind about last month\'s statement from day', unit: 'of the month', def: 15, min: 1, max: 28 },
    { key: 'storedCards.afterDays', script: 'Cards on file', label: 'Remove a card once the last appointment was', unit: 'days ago', def: 28, min: 7, max: 365 },
    // People (stage 2, CH 15 Nov 2026). A page's list also decides on whose sign-in its background checks run.
    { key: 'readyToBill.people', script: 'Who sees what', label: 'Ready to bill', type: 'people', def: [CARL, WENDY] },
    { key: 'missingDetails.people', script: 'Who sees what', label: 'Missing details list', type: 'people', def: [CARL, WENDY] },
    { key: 'apptReminders.people', script: 'Who sees what', label: 'Appointment reminders run for', type: 'people', def: [CARL, WENDY] },
    { key: 'patientForms.people', script: 'Who sees what', label: 'Patient forms list', type: 'people', def: [CARL, WENDY] },
    { key: 'insurerPayments.people', script: 'Who sees what', label: 'Insurer payments due', type: 'people', def: [CARL] },
    { key: 'openEnded.people', script: 'Who sees what', label: 'Open-ended recalls', type: 'people', def: [CARL] },
    { key: 'reviewRequests.people', script: 'Who sees what', label: 'Review requests', type: 'people', def: [CARL] },
    { key: 'feedbackAlerts.people', script: 'Who sees what', label: 'Feedback alerts', type: 'people', def: [CARL] },
    { key: 'patientStatuses.people', script: 'Who sees what', label: 'Patient statuses', type: 'people', def: [CARL] },
    { key: 'bankStatement.people', script: 'Who sees what', label: 'Bank statement', type: 'people', def: [CARL] },
    { key: 'recordRetention.people', script: 'Who sees what', label: 'Record retention', type: 'people', def: [CARL] },
    { key: 'storedCards.people', script: 'Who sees what', label: 'Cards on file', type: 'people', def: [CARL] },
    { key: 'feedbackAlerts.taskFor', script: 'Who gets tasks', label: 'Feedback to look at', type: 'person', def: CARL },
    { key: 'remittances.taskFor', script: 'Who gets tasks', label: 'Remittances', type: 'person', def: CARL },
    { key: 'bankStatement.taskFor', script: 'Who gets tasks', label: 'Bank statement', type: 'person', def: CARL },
    { key: 'portalFill.taskFor', script: 'Who gets tasks', label: 'Portal fill stopped', type: 'person', def: CARL },
    { key: 'rebateSync.taskFor', script: 'Who gets tasks', label: 'Rebate sync stopped', type: 'person', def: CARL },
    { key: 'forecourtLights.staff', script: 'Forecourt lights', label: 'Who can be reminded', type: 'people', def: [CARL, 'Diana Satalova', 'Lottie Harold', 'Roxanna Healy', 'Stephen Sharples', WENDY] },
    // Stage 3 (CH, 15 Nov 2026). Forecourt lights: until these are saved here, each PC keeps the schedule it had.
    { key: 'forecourtLights.days', script: 'Forecourt lights', label: 'Clinic evenings', type: 'weekdays', def: [] },
    { key: 'forecourtLights.offTime', script: 'Forecourt lights', label: 'Lights off at', type: 'time', def: '20:45', min: '17:00', max: '23:45' },
    { key: 'forecourtLights.offset', script: 'Forecourt lights', label: 'Lights on before sunset', unit: 'minutes', def: 30, min: 0, max: 120 },
    { key: 'forecourtLights.noticeTime', script: 'Forecourt lights', label: 'Show the reminder from', type: 'time', def: '09:00', min: '06:00', max: '20:00' },
    { key: 'forecourtLights.skip', script: 'Forecourt lights', label: 'Dates to skip', type: 'dates', def: [] },
    { key: 'scheduleExcess.template', script: 'Schedule excess', label: 'Email template', type: 'text', def: 'Chase - Excess Due', max: 80, re: /^[^<>\[\]]+$/ },
    { key: 'portalFill.payee', script: 'Portal fill: AXA payee', label: 'Name of payee', type: 'text', def: 'Urmston Physio Clinic', max: 60, re: /^[A-Za-z0-9][A-Za-z0-9 &'.,()-]*$/ },
    { key: 'portalFill.providerCode', script: 'Portal fill: AXA payee', label: 'AXA provider code', type: 'text', def: 'ZZ03779', max: 20, re: /^[A-Za-z0-9]+$/ },
    { key: 'portalFill.email', script: 'Portal fill: AXA payee', label: 'Payee email address', type: 'text', def: 'admin@urmstonphysioclinic.com', max: 80, re: /^[^\s@,]+@[^\s@,]+\.[A-Za-z]{2,}$/ },
    { key: 'portalFill.phone', script: 'Portal fill: AXA payee', label: 'Payee phone number', type: 'text', def: '01617484100', max: 20, re: /^\+?[0-9 ()]{6,20}$/ },
    { key: 'calendar.order', script: 'Calendar', label: 'Column order for All practitioners', type: 'order', def: ['Roxanna Healy', CARL, 'Diana Satalova', 'Stephen Sharples'] },
    { key: 'calendar.hideProfessions', script: 'Calendar', label: 'Professions left out of All practitioners', type: 'words', def: ['Administrator'] },
    // Per person (CH, 15 Nov 2026: settings follow the account, not the PC; only CH changes them). Until saved here,
    // each PC keeps its own switch.
    { key: 'forecourtLights.remind', script: 'Per person', label: 'Forecourt lights reminders for', type: 'audience', def: [] },
    { key: 'alerts.arrivalChime', script: 'Per person', label: 'Arrival chime for', type: 'audience', def: 'everyone' },
    { key: 'alerts.chatAlarm', script: 'Per person', label: 'Chat alarm for', type: 'audience', def: 'everyone' },
    { key: 'branding.on', script: 'Per person', label: 'Clinic branding for', type: 'audience', def: 'everyone' },
    { key: 'branding.polish', script: 'Per person', label: 'Modern look for', type: 'audience', def: 'everyone' },
    { key: 'branding.font', script: 'Per person', label: 'Branding font', type: 'choice', def: 'headings', options: { all: 'Website font everywhere', headings: 'Website font for headings only', halaxy: 'Halaxy\'s own font' } },
    { key: 'blockReporting.userpilot', script: 'Per person', label: 'Halaxy\'s tours and announcements (Userpilot) shown to', type: 'audience', def: [] },
  ];
  const NAME_RE = /^[A-Za-z][A-Za-z' .-]{0,39}$/;
  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // A typed date ('2026-12-25', '25-Dec-2026', '25/12/2026') as 'YYYY-MM-DD', or null.
  function isoDay(text) {
    const t = String(text || '').trim();
    let y, m, d, x;
    if ((x = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t))) [y, m, d] = [+x[1], +x[2], +x[3]];
    else if ((x = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(t))) [d, m, y] = [+x[1], +x[2], +x[3]];
    else if ((x = /^(\d{1,2})[\s-]+([A-Za-z]{3})[A-Za-z]*[\s-]+(\d{4})$/.exec(t))) { m = MONTH_NAMES.findIndex((n) => n.toLowerCase() === x[2].toLowerCase()) + 1; [d, y] = [+x[1], +x[3]]; }
    else return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return m >= 1 && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
  }
  const settings = {
    defs: CLINIC_SETTINGS,
    editors: CLINIC_EDITORS,
    store: storage('upc-settings:'),
    // The value as kept in the note, checked: a whole number within limits, or a time HH:MM within limits; else null.
    check(def, raw) {
      if (raw === null || raw === undefined) return null;
      if (def.type === 'choice') { const c = String(raw).trim(); return Object.prototype.hasOwnProperty.call(def.options, c) ? c : null; }
      if (def.type === 'audience') {
        if (!Array.isArray(raw) && /^\s*everyone\s*$/i.test(String(raw))) return 'everyone';
        const list = [...new Set((Array.isArray(raw) ? raw : /^\s*none\s*$/i.test(String(raw)) ? [] : String(raw).split(',')).map((x) => String(x).replace(/\s+/g, ' ').trim()).filter(Boolean))];
        if (list.length === 1 && list[0].toLowerCase() === 'everyone') return 'everyone';
        return list.length <= 30 && list.every((n) => NAME_RE.test(n)) ? list : null;
      }
      if (['order', 'weekdays', 'dates', 'words'].includes(def.type)) {
        const items = (Array.isArray(raw) ? raw : /^\s*none\s*$/i.test(String(raw)) ? [] : String(raw).split(/[,\n]/)).map((x) => String(x).replace(/\s+/g, ' ').trim()).filter(Boolean);
        let out;
        if (def.type === 'weekdays') {
          const idx = items.map((x) => WEEKDAYS.findIndex((w) => w.toLowerCase() === x.slice(0, 3).toLowerCase()));
          if (idx.some((i) => i < 0)) return null;
          out = [...new Set(idx)].sort((a, b) => a - b).map((i) => WEEKDAYS[i]);
        } else if (def.type === 'dates') {
          out = items.map(isoDay);
          if (out.some((x) => !x) || out.length > 100) return null;
          out = [...new Set(out)].sort();
        } else {
          out = [...new Set(items)];
          const re = def.type === 'order' ? NAME_RE : /^[A-Za-z][A-Za-z &'-]{0,39}$/;
          if (!out.every((x) => re.test(x)) || out.length > 20 || (def.type === 'order' && !out.length)) return null;
        }
        return out;
      }
      if (def.type === 'text') {
        const t = String(raw).replace(/\s+/g, ' ').trim();
        return t && t.length <= def.max && def.re.test(t) ? t : null;
      }
      if (def.type === 'people' || def.type === 'person') {
        const list = [...new Set((Array.isArray(raw) ? raw : String(raw).split(',')).map((x) => String(x).replace(/\s+/g, ' ').trim()).filter(Boolean))];
        if (!list.length || list.length > (def.type === 'person' ? 1 : 20) || !list.every((n) => NAME_RE.test(n))) return null;
        return def.type === 'person' ? list[0] : list;
      }
      const s = String(raw).trim();
      if (def.type === 'time') {
        const m = /^(\d{1,2}):(\d\d)$/.exec(s);
        if (!m || +m[1] > 23 || +m[2] > 59) return null;
        const t = String(m[1]).padStart(2, '0') + ':' + m[2];
        return t >= def.min && t <= def.max ? t : null;
      }
      if (!/^\d+$/.test(s)) return null;
      const n = Number(s);
      return n >= def.min && n <= def.max ? n : null;
    },
    def: (key) => CLINIC_SETTINGS.find((d) => d.key === key),
    same: (a, b) => (Array.isArray(a) || Array.isArray(b) ? String(a) === String(b) : a === b),
    text: (v) => (Array.isArray(v) ? (v.length ? v.join(', ') : 'none') : String(v)),   // 'everyone' stays as it is
    // For an 'audience' setting: true when it is on for the signed-in person (or for `name`).
    forMe(key, name) {
      const v = settings.get(key), me = String(name || user.name([]) || '').toLowerCase();
      return v === 'everyone' || (Array.isArray(v) && !!me && v.some((n) => n.toLowerCase() === me));
    },
    // What applies to whoever is signed in on this PC, kept for scripts that start before the page (and core) are
    // ready: { user, values: { key: true/false or the choice } } for per-person settings saved in Clinic settings.
    rememberMine() {
      const me = user.name([]);
      if (!me) return;
      const out = {};
      CLINIC_SETTINGS.filter((d) => (d.type === 'audience' || d.type === 'choice') && settings.isSet(d.key)).forEach((d) => { out[d.key] = d.type === 'choice' ? settings.get(d.key) : settings.forMe(d.key, me); });
      try { localStorage.setItem('upc-settings:mine', JSON.stringify({ user: me, values: out })); } catch (e) { /* storage blocked */ }
    },
    // True when the clinic has saved a usable value (not just the default), for scripts that fall back to their own.
    isSet(key) { const r = settings.all().find((x) => x.def.key === key); return !!r && r.raw !== null && !r.bad; },
    isoDay,
    // The value every script uses: the clinic's, or the default.
    get(key) {
      const def = settings.def(key);
      if (!def) throw new UPCError('No clinic setting called ' + key + '.');
      const v = settings.check(def, (settings.store.get('values', {}) || {})[key]);
      return v === null ? def.def : v;
    },
    // [{ def, value, raw, bad, changed, fromPc }] for the Script settings page and the health check. A setting not yet
    // saved for the clinic shows what this PC uses now, where its script offers it (fromPc), else the default.
    all() {
      const vals = settings.store.get('values', {}) || {};
      return CLINIC_SETTINGS.map((def) => {
        const raw = Object.prototype.hasOwnProperty.call(vals, def.key) ? vals[def.key] : null;
        const v = settings.check(def, raw);
        const offer = v === null ? settings.offered(def) : null;
        const value = v !== null ? v : offer !== null ? offer : def.def;
        return { def, raw, value, bad: raw !== null && v === null, changed: !settings.same(value, def.def), fromPc: offer !== null };
      });
    },
    // What this PC uses for a setting not yet saved for the clinic, offered by its script (window.__upcSettingOffers), or null.
    offered(def) {
      try {
        const f = (window.__upcSettingOffers || {})[def.key];
        const v = typeof f === 'function' ? settings.check(def, f()) : null;
        return v === null || v === undefined ? null : v;
      } catch (e) { return null; }
    },
    // Lines the scripts couldn't read (not "key = value" or not a known key), from the last read.
    problems: () => settings.store.get('problems', []),
    readAt: () => settings.store.get('at', 0),
    canEdit: () => user.is(CLINIC_EDITORS),
    parse(text) {
      const lines = String(text || '').split('\n');
      const values = {}, problems = [];
      lines.slice(1).forEach((l, i) => {
        if (i === 0 && l === CLINIC_INFO) return;
        const m = /^([A-Za-z]+\.[A-Za-z]+) = (.{1,400})$/.exec(l);
        if (!m || !settings.def(m[1])) { problems.push(l.slice(0, 60)); return; }
        values[m[1]] = m[2];
      });
      return { values, problems };
    },
    format(values) {
      return [CLINIC_HEAD, CLINIC_INFO].concat(CLINIC_SETTINGS.filter((d) => values[d.key] !== undefined && values[d.key] !== null && values[d.key] !== '')
        .map((d) => d.key + ' = ' + settings.text(values[d.key]))).join('\n');
    },
    // The newest settings note (the last save); any older copies are deleted on the next save.
    notes: (notes) => notes.filter((n) => n.text.split('\n')[0].trim() === CLINIC_HEAD).sort((a, b) => Number(b.id) - Number(a.id)),
    note: (notes) => settings.notes(notes)[0] || null,
    // Reads the note (force: now; otherwise only when an hour has passed, in the visible tab, Halaxy not busy).
    async refresh(force) {
      if (!force && (document.visibilityState !== 'visible' || http.pausedFor() > 0 || !background.due(settings.store.get('tried', 0), CLINIC_EVERY))) return false;
      settings.store.set('tried', Date.now());
      const note = settings.note(await adminNotes.list('organisation', SHARED_ORG));
      const got = note ? settings.parse(note.text) : { values: {}, problems: [] };
      settings.store.set('values', got.values);
      settings.store.set('problems', got.problems);
      settings.store.set('at', Date.now());
      settings.rememberMine();
      try { document.dispatchEvent(new CustomEvent('upc-settings-changed')); } catch (e) { /* ignore */ }
      return true;
    },
    // Saves the values ({ key: value }; empty means the default) to the note, for every PC. Only CLINIC_EDITORS.
    async save(values) {
      if (!settings.canEdit()) throw new UPCError('Only ' + CLINIC_EDITORS.join(' or ') + ' can change the clinic settings.');
      const clean = {};
      for (const def of CLINIC_SETTINGS) {
        // Every setting is written (CH, 16 Nov 2026), so after one save nothing falls back to a PC's own value: what was
        // given; if not given, what is in use (the clinic's, else what this PC offers, else the default); empty: the default.
        let raw = values[def.key];
        if (raw === undefined) { const cur = settings.all().find((x) => x.def.key === def.key); raw = cur ? cur.value : def.def; }
        if (raw === null || (!Array.isArray(raw) && String(raw).trim() === '')) raw = def.def;
        const v = settings.check(def, raw);
        if (v === null) {
          throw new UPCError(def.script + ': "' + def.label + '" must be ' + (def.type === 'audience' ? 'everyone, or people ticked' : def.type === 'choice' ? 'one of the choices' : def.type === 'time' ? 'a time from ' + def.min + ' to ' + def.max : def.type === 'people' || def.type === 'order' ? 'at least one person'
            : def.type === 'person' ? 'one person' : def.type === 'dates' ? 'dates such as 25-Dec-2026, one per line' : def.type === 'weekdays' ? 'days of the week'
              : def.type === 'words' ? 'words separated by commas' : def.type === 'text' ? 'filled in as expected (up to ' + def.max + ' characters)' : 'a whole number from ' + def.min + ' to ' + def.max) + '.');
        }
        clean[def.key] = v;
      }
      const text = settings.format(clean);
      const all = settings.notes(await adminNotes.list('organisation', SHARED_ORG));
      const note = all[0] || null;
      if (!note) await adminNotes.add('organisation', SHARED_ORG, text);
      else if (note.text !== text) await adminNotes.update('organisation', SHARED_ORG, note.id, text);
      for (const old of all.slice(1)) { try { await adminNotes.remove('organisation', SHARED_ORG, old.id); } catch (e) { console.warn('[UPC settings]', e); } }
      await settings.refresh(true);
      return clean;
    },
    // Names to offer for people settings: Halaxy's practitioner list, everyone named in a setting, and who is signed in.
    async names() {
      const out = new Set();
      try { (await http.json('/lookup/practitioner?clinic=&include_id=&type=') || []).forEach((x) => { const n = clean(x.name); if (NAME_RE.test(n)) out.add(n); }); } catch (e) { /* the lists below still apply */ }
      settings.all().forEach((r) => { if (['people', 'person', 'order', 'audience'].includes(r.def.type)) [].concat(r.def.def, r.value).forEach((n) => { if (n !== 'everyone') out.add(n); }); });
      const me = user.name([]);
      if (me && NAME_RE.test(me)) out.add(me);
      return [...out].sort((a, b) => a.localeCompare(b));
    },
  };

  // A read soon after the page opens, then about hourly (settings.refresh skips when not due).
  setTimeout(() => { settings.refresh().catch(() => {}); }, 6000);
  setTimeout(() => { settings.rememberMine(); }, 3000);   // who is signed in on this page, for the next page's early scripts
  setInterval(() => { settings.refresh().catch(() => {}); }, 10 * 60e3);
  window.addEventListener('storage', (e) => { if (e.key === 'upc-settings:values') { try { document.dispatchEvent(new CustomEvent('upc-settings-changed')); } catch (x) { /* ignore */ } } });

  // ------------------------------------------------------------------ counts like the bell's

  // Our counts look like Halaxy's own count on the bell (CH, 24 Nov 2026). Halaxy draws that as the bell link's ::after
  // from data-count (#btn-alert-notifications), so its size, font and colours are read from there when it shows a count
  // and kept on this PC for pages where it doesn't. Menu counts (ours: span.upc-...-badge in a menu item) take that look
  // but stay where they are, after the item's name; To do's count in the top bar also takes its place on the icon.
  // 3: with box-sizing (the bell's count is content-box, so its height and padding add up; read as border-box, ours were
  // squashed: CH, 24 Nov 2026, capture the same day). Where on the icon it goes is To do's (it measures the bell).
  const COUNT_KEY = 'upc-count-look3';
  const COUNT_LOOK = ['box-sizing', 'height', 'min-width', 'padding', 'border-radius', 'font-size', 'font-weight', 'line-height', 'color', 'background-color', 'font-family', 'letter-spacing'];
  const COUNT_PLACE = ['top', 'left'];
  // The bell only: the Inbox (first in the top bar) has its own grey count, placed differently (CH, 24 Nov 2026).
  function bellLink() { return document.getElementById('btn-alert-notifications') || document.querySelector('#alertNotifications a[data-count]'); }
  function countLook() {
    const bell = bellLink();
    if (bell && /[1-9]/.test(bell.getAttribute('data-count') || '')) {
      const cs = getComputedStyle(bell, '::after');
      if (cs.content && cs.content !== 'none' && cs.content !== 'normal' && cs.position === 'absolute') {
        const look = {};
        COUNT_LOOK.concat(COUNT_PLACE).forEach((k) => { look[k] = cs.getPropertyValue(k); });
        try { localStorage.setItem(COUNT_KEY, JSON.stringify(look)); } catch (e) { /* fine */ }
        return look;
      }
    }
    try { return JSON.parse(localStorage.getItem(COUNT_KEY) || 'null'); } catch (e) { return null; }
  }
  function paintCounts() {
    const look = countLook();
    if (!look) return;
    const decl = COUNT_LOOK.filter((k) => look[k]).map((k) => k + ': ' + look[k] + ';').join(' ') + (look['box-sizing'] ? '' : ' box-sizing: content-box;');
    const css = '#mainMenu a.mainmenu-sublink span[class^="upc-"][class$="-badge"] { ' + decl + ' display: inline-block; text-align: center; vertical-align: middle; }';
    let st = document.getElementById('upc-count-look');
    if (!st) { st = document.createElement('style'); st.id = 'upc-count-look'; (document.head || document.documentElement).appendChild(st); }
    if (st.textContent !== css) st.textContent = css;
  }
  ui.countLook = countLook;
  ui.bellLink = bellLink;
  setTimeout(paintCounts, 2500);
  setInterval(paintCounts, 15000);

  window.UPC = Object.freeze({
    version: VERSION, Error: UPCError, pg, base, sleep, clean, esc, htmlDoc, money, http, todo, invoice, appointment, forms, notes, followUps, patient, tasks, surveys, reports, dayLabel, parseDay, rebate, files, deposits, orgFiles, adminNotes, shared, sharedResult, settings, load, ui,
    user, storage, calendar, wording, background,
  });
})();
