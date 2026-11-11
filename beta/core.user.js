// ==UserScript==
// @name         UPC core library (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.1.27
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

  const VERSION = '0.1.27';
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
    const inv = { id: String(id), number: num || title, lines: [], payments: [], pending: [], attachments: [], total: null, outstanding: null };
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
      });
    }
    const att = doc.querySelector('#invoiceAttachments');
    if (att) {
      // Each attachment as its whole row (created date, type, file name, comment): the first cell is
      // the date, not the name.
      att.querySelectorAll('tbody tr').forEach((tr) => {
        const row = clean(tr.textContent);
        if (row && tr.querySelector('td')) inv.attachments.push(row);
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

  // Works out the steps for one funder line: which patient invoice line it came from, and checks
  // both invoices agree. Read-only.
  async function planMove(funderInvoiceId, funderLineId, newRebate) {
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
    const fee = money.cents(pFields['form[amount]']);
    if (newRebate < 0) throw new UPCError('The new funder amount cannot be negative.');
    if (fee !== null && newRebate > fee) throw new UPCError('The new funder amount (' + money.fmt(newRebate) + ') is more than the fee (' + money.fmt(fee) + ').');
    return { funderInvoiceId: funder.id, funderNumber: funder.number, funderLineId: line.lineId, patientInvoiceId: patient.id, patientNumber: patient.number,
      patientLineId: cands[0].lineId, date: line.date, patientDate: cands[0].date, item: line.item, fee, origRebate, newRebate };
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
    let patient = await invoice.fetch(patientInvoiceId);
    if (patient.pending.length) throw new UPCError(patient.number + ' already has an amount waiting to be billed to a funder. Nothing was changed.');

    say('Reverting the ' + plan.date + ' line to ' + plan.patientNumber);
    const removeJson = await http.json('/invoice/line/' + funderLineId + '/remove?clicked=' + Date.now());
    const m = String(removeJson && removeJson.message).match(/case\s+'delete'\s*:[\s\S]*?url\s*=\s*"([^"]+)"/);
    if (!m) throw new UPCError('Could not find Halaxy\'s revert option for this line. Nothing was changed.');
    http.expectRefresh(await http.json(m[1]), 'Reverting the funder line');

    patient = await invoice.fetch(patientInvoiceId);
    if (patient.pending.length !== 1 || patient.pending[0].amount !== origRebate) {
      throw new UPCError('After reverting, ' + patient.number + ' does not show ' + money.fmt(origRebate) + ' waiting to bill. Open it and use Invoice Funder to re-bill it to ' + plan.funderNumber + '.');
    }

    say('Setting the rebate to ' + money.fmt(newRebate));
    try {
      const fresh = await lineForm(patientLineId);
      const pairs = fresh.map(([k, v]) => [k, k === 'form[rebate]' ? money.plain(newRebate) : v]);
      if (!fresh.some(([k]) => k === 'form[rebate]')) pairs.push(['form[rebate]', money.plain(newRebate)]);
      http.expectRefresh(await http.postForm('/invoice/line/' + patientLineId + '/edit', pairs), 'Saving the new rebate');
    } catch (e) {
      say('Saving the rebate failed, putting the original back on ' + plan.funderNumber);
      await rebill(patientInvoiceId, funderInvoiceId, origRebate).catch(() => {});
      throw e;
    }

    // Re-bill what the funder now owes, £0 included, so the fee stays on the funder invoice at that
    // amount (Carl, 9 Nov 2026: a £0.00 line, never a missing one). Halaxy offers £0 to bill like any amount.
    say('Re-billing ' + money.fmt(newRebate) + ' to ' + plan.funderNumber);
    await rebill(patientInvoiceId, funderInvoiceId, newRebate);

    let fAfter = await invoice.fetch(funderInvoiceId);
    const before = new Set(funder.lines.map((l) => l.lineId));
    const added = fAfter.lines.filter((l) => !before.has(l.lineId) && l.patientInvoiceId === patientInvoiceId && l.item === plan.item);
    const problems = [];
    if (fAfter.lines.some((l) => l.lineId === funderLineId)) problems.push('the original line is still on ' + fAfter.number);
    {
      const nl = added.filter((l) => l.amount === newRebate);
      if (nl.length !== 1) problems.push('no new ' + money.fmt(newRebate) + ' line found on ' + fAfter.number);
      else if (plan.patientDate && nl[0].date !== plan.patientDate) {
        // Halaxy can give the re-billed line the wrong date too: set it to the patient fee's date.
        say('Correcting the date Halaxy gave the re-billed line: ' + nl[0].date + ' to ' + plan.patientDate);
        try { await invoice.setLineDate(nl[0].lineId, plan.patientDate); fAfter = await invoice.fetch(funderInvoiceId); }
        catch (e) { problems.push('the re-billed line on ' + fAfter.number + ' is dated ' + nl[0].date + ' instead of ' + plan.patientDate + ' (' + (e.message || e) + ')'); }
      }
    }
    const pAfter = await invoice.fetch(patientInvoiceId);
    if (fAfter.total !== funder.total - origRebate + newRebate) problems.push(fAfter.number + ' total is ' + money.fmt(fAfter.total) + ', expected ' + money.fmt(funder.total - origRebate + newRebate));
    if (pAfter.pending.length) problems.push(pAfter.number + ' still has an amount waiting to bill');
    if (problems.length) throw new UPCError('Changes were made but the result looks wrong: ' + problems.join('; ') + '. Check ' + plan.patientNumber + ' and ' + fAfter.number + ' before trying again.');
    return { funderTotal: fAfter.total, patientOutstanding: pAfter.outstanding };
  }

  const rebate = { plan: planMove, apply: applyMove };

  // ------------------------------------------------------------------ files

  // Halaxy's attach categories on invoices (radio values in the attach pop-up).
  const ATTACH_CATEGORY = { other: '0', authoriseBenefit: '1', payment: '2' };

  const files = {
    CATEGORY: ATTACH_CATEGORY,
    // Attaches a file to an invoice the way the attach button does: open the pop-up, upload the
    // file to Halaxy's file store, then save it against the invoice with a title and category.
    // Checks the invoice lists one more attachment afterwards.
    // Returns false, attaching nothing, when opts.skipIfAttached and a file with this title is already on the invoice.
    async attachToInvoice(invoiceId, file, opts) {
      opts = opts || {};
      const before = await invoice.fetch(invoiceId);
      const wanted = String(opts.title || file.name || 'Attachment').replace(/\.pdf$/i, '');
      if (opts.skipIfAttached && before.attachments.some((r) => r.includes(wanted))) return false;
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

  const reports = {
    // Halaxy's Unpaid Invoices report (Reports > Finance, type 5) from `start` ('09-May-2026'): one row per
    // fee line of every unpaid invoice, active or issued. Columns confirmed live 10 Nov 2026. Invoice-level
    // cells (date, status, balance) are only on an invoice's first line; they are carried to its other lines.
    async unpaidLines(start) {
      const p = new URLSearchParams([['type', '5'], ['start', start], ['unpaid', '0'], ['overdue', 'all'], ['showTotalMode', '0'],
        ['incomeType', 'paymentMethods'], ['invoicestatuses', 'active'], ['invoicestatuses', 'issued'], ['displayNames', '1'],
        ['plTaxTypeStatus', 'exclusive'], ['lineStatus', 'write-off'], ['lineStatus', 'voided'],
        ['usedDepositOption', 'all'], ['creditSummaryOption', 'summary'], ['clicked', String(Date.now())]]);
      const doc = await http.html('/report/finance/0?' + p.toString());
      const table = doc.querySelector('table.table-report');
      if (!table) throw new UPCError('Halaxy\'s Unpaid Invoices report has changed (its table was not found).');
      const all = [...table.rows];
      const head = table.tHead ? [...table.tHead.rows] : all.filter((r) => r.cells.length && [...r.cells].every((c) => c.tagName === 'TH'));
      const body = all.filter((r) => !head.includes(r));
      const hg = cellGrid(head);
      const names = (hg[hg.length - 1] || []).map((c) => clean(c && c.textContent));
      const col = (n) => names.indexOf(n);
      const need = ['Invoice / Deposit', 'Date', 'Payer ID', 'Payer', 'Funder', 'Fee', 'Appointment Status', 'Invoice Status', 'Amount'];
      const missing = need.filter((n) => col(n) < 0);
      if (missing.length) throw new UPCError('Halaxy\'s Unpaid Invoices report has changed (' + missing.join(', ') + ' not found).');
      const balanceCol = names.lastIndexOf('Balance');
      const grid = cellGrid(body);
      const out = [];
      let last = null;
      grid.forEach((row, ri) => {
        if ([...body[ri].cells].some((td) => (td.colSpan || 1) > 3)) return;   // totals and headings
        const cell = (n) => { const i = typeof n === 'number' ? n : col(n); return i < 0 ? '' : clean(row[i] && row[i].textContent); };
        const link = row[col('Invoice / Deposit')] && row[col('Invoice / Deposit')].querySelector('a[href*="/invoice/"]');
        const invoiceId = link ? (link.getAttribute('href').match(/\/invoice\/(\d+)/) || [])[1] || null : null;
        const same = last && last.invoiceId === invoiceId && last.invoice === cell('Invoice / Deposit');
        const line = {
          invoiceId, invoice: cell('Invoice / Deposit'),
          date: cell('Date') || (same ? last.date : ''), invoiceStatus: cell('Invoice Status') || (same ? last.invoiceStatus : ''),
          balance: balanceCol >= 0 && cell(balanceCol) ? money.cents(cell(balanceCol)) : (same ? last.balance : null),
          payerId: cell('Payer ID') || (same ? last.payerId : ''), payer: cell('Payer') || (same ? last.payer : ''),
          funder: cell('Funder') || (same ? last.funder : ''), category: cell('Category'), fee: cell('Fee'),
          apptStatus: cell('Appointment Status'), amount: money.cents(cell('Amount')),
        };
        out.push(line);
        last = line;
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
    // A stamp as Carl writes them (11 Nov 2026): "2026-11-11 15-45 Portal fill:" (the date, the time, and who: a script's name or a person's initials).
    stamp(by, when) {
      const d = new Date(when || Date.now());
      const p2 = (n) => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + '-' + p2(d.getMinutes()) + ' ' + by + ':';
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
  };
  async function addTask(path, list, task, where) {
    const mark = String(task.key || task.title).replace(/["\\]/g, '');
    const listed = (rows) => JSON.stringify(rows || '').includes(mark);
    if (listed(await list().catch(() => null))) return false;
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
    if (!listed(await list())) throw new UPCError('Halaxy accepted the task, but it does not show ' + where + '.');
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

  const ui = {
    nativeStyles,
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

  window.UPC = Object.freeze({
    version: VERSION, Error: UPCError, pg, base, sleep, clean, esc, htmlDoc, money, http, invoice, appointment, forms, notes, followUps, patient, tasks, surveys, reports, dayLabel, parseDay, rebate, files, load, ui,
  });
})();
