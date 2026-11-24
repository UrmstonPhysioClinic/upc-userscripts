// ==UserScript==
// @name         UPC Billing: Schedule excess (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.2.2
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/charge-excess.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/charge-excess.user.js
// @description  A "Schedule excess" button on patient invoices with an unpaid excess: sets the due date a week ahead, schedules the payment from the card on file for then, and emails the patient Halaxy's "Chase - Excess Due" template (or the one named in Clinic settings). Asks first.
// @match        https://*.halaxy.com/a/pr/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * Schedule excess (CH, 16 Nov 2026; file name from its first name, Charge excess). On a patient invoice that has been billed to its funder and still has something
 * outstanding (the excess), one button, after a confirm:
 *
 *  1. Invoice settings (cogwheel, /invoice/options/:id): Due Date = a week from today (core UPC.invoice.setSettings).
 *  2. Send Invoice Email (/email/document/invoice/:id, form#composeEmailForm; capture 16 Nov 2026): the form as Halaxy
 *     fills it (sender, recipient, BCC), with the template's subject and body as Halaxy's own Send box gets them when
 *     the template is chosen: GET /communication/template/render/:template/invoice/:id, after the due date is set so
 *     [Invoice Due Date] is filled. The template is the one in Halaxy (CH edits it there, 16 Nov 2026): "Chase -
 *     Excess Due" unless Clinic settings names another. The editor is never used, so its inline styles are kept. Merge
 *     tags left for sending, such as [Payment Link], are wrapped as Halaxy's own (span.dynamicterm).
 *  3. Schedule Payment (/invoicefunctions/payment/scheduled/new/invoice/:id, form#newScheduledPaymentForm; capture
 *     16 Nov 2026): one-off, the outstanding amount, from the card Halaxy picks (form[creditCard]), exactly a week
 *     from when the button is pressed (Halaxy fills a time an hour ahead). Checked on the invoice afterwards: its
 *     "Available" link becomes "Scheduled (23-Nov-2026 22:57)", linking /invoicefunctions/payment/scheduled/:id/edit
 *     (live, 16 Nov 2026; the pop-up's scheduledAmtTotal stays 0).
 *
 *  The email goes before the payment is scheduled: if scheduling fails, the patient has been told and nothing is
 *  charged; the message says to schedule it by hand. Stops before changing anything if there is no card on file, a
 *  payment is already scheduled, or the patient has no email address.
 *  The email's HTML lives here (from claude/email-excess-due.html in the Claude project); merge tags as Halaxy's own.
 */
(() => {
  'use strict';
  if (window.__hxChargeExcess) return;
  window.__hxChargeExcess = true;

  const VERSION = '0.2.2';
  const U = () => window.UPC;
  if (!/^\/a\/pr\/\d+\//.test(location.pathname)) return;
  // A patient invoice: /invoice/{id} or /patient/invoice/{patient}/{id}; not the patient's Invoices tab.
  const m = location.pathname.match(/\/(?:patient\/invoice\/\d+|invoice)\/(\d+)\/?$/);
  if (!m || /\/patient\/invoice\/\d+\/?$/.test(location.pathname)) return;
  const invoiceId = m[1];

  const clean = (s) => String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim();
  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TEMPLATE = () => (U() && U().settings && U().settings.def('scheduleExcess.template') ? U().settings.get('scheduleExcess.template') : 'Chase - Excess Due');
  const textOf = (html) => clean(U().htmlDoc(String(html || '')).body.textContent);

  const SEND = '/email/document/invoice/' + invoiceId;
  const SCHEDULE = '/invoicefunctions/payment/scheduled/new/invoice/' + invoiceId;

  // ------------------------------------------------------------------ reading what will happen

  // The Schedule Payment pop-up: the card, Halaxy's default date and time, and whether a payment is already scheduled.
  async function readSchedule() {
    const { doc } = await U().http.popup(SCHEDULE);
    const form = doc.querySelector('form#newScheduledPaymentForm') || doc.querySelector('form');
    const need = ['form[creditCard]', 'form[amount]', 'form[scheduleDate][date]', 'form[scheduleDate][time][hour]', 'form[scheduleDate][time][minute]', 'form[_token]'];
    const missing = need.filter((k) => !form || !form.querySelector('[name="' + k + '"]'));
    if (missing.length) throw new (U().Error)('The Schedule Payment pop-up has changed (' + missing.join(', ') + ' not found). Nothing was changed.');
    const card = form.querySelector('select[name="form[creditCard]"]');
    const opt = card.options[card.selectedIndex] || null;
    const script = [...doc.querySelectorAll('script')].map((s) => s.textContent).join('\n');
    const already = Number((script.match(/scheduledAmtTotal\s*=\s*([\d.]+)/) || [])[1] || 0);
    return {
      form,
      card: opt && opt.value ? clean(opt.textContent).replace(/\s*Exp:.*$/, '') : '',
      already,
      day: clean(form.querySelector('[name="form[scheduleDate][date]"]').value),
      hour: form.querySelector('[name="form[scheduleDate][time][hour]"]').value,
      minute: form.querySelector('[name="form[scheduleDate][time][minute]"]').value,
    };
  }

  async function readSend() {
    const { doc } = await U().http.popup(SEND);
    const form = doc.querySelector('form#composeEmailForm');
    const need = ['form[subject]', 'form[body]', 'form[toEmail]', 'form[fromEmail]', 'form[_token]'];
    const missing = need.filter((k) => !form || !form.querySelector('[name="' + k + '"]'));
    if (missing.length) throw new (U().Error)('The Send Invoice Email pop-up has changed (' + missing.join(', ') + ' not found). Nothing was changed.');
    const name = TEMPLATE().toLowerCase();
    const opt = [...form.querySelectorAll('select[name="form[template]"] option')].find((o) => o.value && clean(o.textContent).toLowerCase() === name);
    return { form, to: clean(form.querySelector('[name="form[toEmail]"]').value), templateId: opt ? opt.value : null };
  }

  // The template filled in for this invoice, as Halaxy's Send box gets it: { subject, body }. The JSON's shape isn't
  // documented, so the body is its longest HTML and the subject any field named "subject".
  async function rendered(templateId) {
    const json = await U().http.json('/communication/template/render/' + templateId + '/invoice/' + invoiceId);
    let body = '', subject = '';
    const walk = (v, key, depth) => {
      if (typeof v === 'string') {
        if (/subject/i.test(key) && !subject) subject = textOf(v);
        else if (/<\w[^>]*>/.test(v) && v.length > body.length) body = v;
      } else if (v && typeof v === 'object' && depth < 4) Object.entries(v).forEach(([k, x]) => walk(x, k, depth + 1));
    };
    walk(json, '', 0);
    if (!body) throw new (U().Error)('Halaxy sent back no email for the "' + TEMPLATE() + '" template.');
    // Merge tags still to be filled when sending, wrapped as Halaxy's own templates have them.
    body = body.replace(/(<span class="dynamicterm">)?\[([A-Z][A-Za-z ]{2,40})\](<\/span>)?/g, (m, open, t) => (open ? m : '<span class="dynamicterm">[' + t + ']</span>'));
    return { subject, body };
  }

  // The invoice's "Scheduled (23-Nov-2026 22:57)" link, if a payment is scheduled: its text, or ''. A cancelled one
  // keeps its link, reading "Scheduled payment cancelled" (live, 16 Nov 2026), and doesn't count.
  function scheduledOn(doc) {
    const a = [...doc.querySelectorAll('a[href*="/payment/scheduled/"], [data-modal-href*="/payment/scheduled/"]')]
      .find((x) => /^scheduled\s*\(/i.test(clean(x.textContent)));
    return a ? clean(a.textContent) : '';
  }

  async function plan() {
    const page = await U().http.html('/invoice/' + invoiceId);
    const inv = U().invoice.parse(page, invoiceId);
    const onPage = scheduledOn(page);
    if (onPage) throw new (U().Error)('A payment is already scheduled on ' + inv.number + ': ' + onPage + '.');
    if (!(inv.outstanding > 0)) throw new (U().Error)('Nothing is outstanding on ' + inv.number + '.');
    const s = await readSchedule();
    if (!s.card) throw new (U().Error)('No card on file for this patient. Use the "Chase - Excess Due (no card on file)" email instead.');
    if (s.already > 0) throw new (U().Error)('A payment of ' + U().money.fmt(Math.round(s.already * 100)) + ' is already scheduled on ' + inv.number + '.');
    // Exactly a week from now, to the minute.
    const now = new Date();
    const d = new Date(now);
    d.setDate(d.getDate() + 7);
    const due = U().dayLabel(d.getTime());
    const e = await readSend();
    if (!e.to) throw new (U().Error)('No email address for this patient. Add one, then try again.');
    if (!e.templateId) throw new (U().Error)('No "' + TEMPLATE() + '" template in Halaxy\'s communication templates. Nothing was changed.');
    return { inv, amount: inv.outstanding, card: s.card, due, hour: now.getHours(), minute: now.getMinutes(), time: String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'), to: e.to };
  }

  // ------------------------------------------------------------------ doing it

  async function sendEmail(p) {
    const { form, templateId } = await readSend();
    if (!templateId) throw new (U().Error)('No "' + TEMPLATE() + '" template in Halaxy\'s communication templates.');
    const t = await rendered(templateId);
    const set = { 'form[subject]': t.subject || clean(form.querySelector('[name="form[subject]"]').value), 'form[body]': t.body, 'form[template]': '' };
    const pairs = U().http.serialize(form).map(([k, v]) => [k, k in set ? set[k] : v]);
    Object.keys(set).forEach((k) => { if (!pairs.some(([x]) => x === k)) pairs.push([k, set[k]]); });
    // Halaxy answers a send with its own status; only the form coming back (with what was wrong) means not sent.
    const res = await U().http.postForm(SEND, pairs);
    if (res && res.status === 'FORM') U().http.expectRefresh(res, 'Sending the email');
  }

  async function schedulePayment(p) {
    const s = await readSchedule();
    if (s.already > 0) throw new (U().Error)('A payment is already scheduled on ' + p.inv.number + '.');
    // One-off (the radio; Halaxy's hidden empty field of the same name stays as it is), the outstanding amount, the date.
    const set = { 'form[amount]': (p.amount / 100).toFixed(2), 'form[scheduleDate][date]': p.due, 'form[scheduleDate][time][hour]': String(p.hour), 'form[scheduleDate][time][minute]': String(p.minute) };
    const pairs = U().http.serialize(s.form).map(([k, v]) => [k, k in set ? set[k] : (k === 'form[paymentScheduled]' && v === '1' ? '0' : v)]);
    const res = await U().http.postForm(SCHEDULE, pairs);
    if (res && res.status === 'FORM') U().http.expectRefresh(res, 'Scheduling the payment');
    const after = scheduledOn(await U().http.html('/invoice/' + invoiceId));
    if (!after) throw new (U().Error)('Halaxy didn\'t show the payment as scheduled on the invoice.');
    if (!after.includes(p.due)) throw new (U().Error)('The invoice shows "' + after + '", not ' + p.due + '.');
  }

  // ------------------------------------------------------------------ page furniture

  let btn = null, busy = false;

  function ask() {
    if (busy) return;
    busy = true;
    const dlg = U().ui.dialog({ title: 'Schedule excess', key: 'charge-excess', canClose: () => !busy });
    if (!dlg) { busy = false; return; }
    dlg.body.innerHTML = U().ui.run.inline('Reading the invoice');
    plan().then((p) => {
      busy = false;
      dlg.body.innerHTML = '<p>Schedule the ' + esc(U().money.fmt(p.amount)) + ' excess on ' + esc(p.inv.number) + '?</p>' +
        '<table class="table table-striped table-bordered w-100"><tbody>' +
        '<tr><th>Due Date</th><td>' + esc(p.due) + '</td></tr>' +
        '<tr><th>Payment</th><td>' + esc(U().money.fmt(p.amount)) + ' from ' + esc(p.card) + ' on ' + esc(p.due) + ' at ' + esc(p.time) + '</td></tr>' +
        '<tr><th>Email</th><td>' + esc(TEMPLATE()) + '<br><span class="text-muted">to ' + esc(p.to) + '</span></td></tr>' +
        '</tbody></table>' +
        '<div class="upc-actions"><button type="button" class="btn btn-outline-primary" data-upc-close>Cancel</button><button type="button" class="btn btn-primary" data-a="go">Schedule Excess</button></div>';
      dlg.body.querySelector('[data-a=go]').addEventListener('click', () => go(dlg, p));
    }).catch((e) => {
      busy = false;
      dlg.body.innerHTML = '<div class="alert alert-danger upc-err">' + esc(e.message || e) + '</div><div class="upc-actions"><button type="button" class="btn btn-primary" data-upc-close>Close</button></div>';
    });
  }

  async function go(dlg, p) {
    busy = true;
    const done = [];
    const step = (t) => { dlg.body.innerHTML = (done.length ? '<ul>' + done.map((d) => '<li>' + esc(d) + '</li>').join('') + '</ul>' : '') + U().ui.run.inline(t); };
    let stage = 'due';
    try {
      step('Setting the due date');
      await U().invoice.setSettings(invoiceId, { 'form[dueDate]': p.due }, 'the due date');
      done.push('Due date set to ' + p.due + '.');
      stage = 'email';
      step('Sending the email');
      await sendEmail(p);
      done.push('Email sent to ' + p.to + '.');
      stage = 'payment';
      step('Scheduling the payment');
      await schedulePayment(p);
      done.push(U().money.fmt(p.amount) + ' scheduled from ' + p.card + ' on ' + p.due + ' at ' + p.time + '.');
      busy = false;
      dlg.body.innerHTML = '<div class="alert alert-success upc-ok">' + done.map(esc).join(' ') + '</div><div class="upc-actions"><button type="button" class="btn btn-primary" data-a="reload">Close</button></div>';
    } catch (e) {
      busy = false;
      const what = { due: 'Nothing was changed.', email: 'The email was not sent and no payment was scheduled.', payment: 'The payment was not scheduled: schedule it by hand (Available, under the invoice\'s payments) for ' + p.due + '.' }[stage];
      dlg.body.innerHTML = (done.length ? '<div class="alert alert-success upc-ok">' + done.map(esc).join(' ') + '</div>' : '') +
        '<div class="alert alert-danger upc-err">' + esc(e.message || e) + ' ' + esc(what) + '</div><div class="upc-actions"><button type="button" class="btn btn-primary" data-a="reload">Close</button></div>';
      try { document.dispatchEvent(new CustomEvent('upc-loader-error', { detail: JSON.stringify({ file: 'charge-excess.user.js', message: String(e.message || e) }) })); } catch (x) { /* ignore */ }
    }
    const r = dlg.body.querySelector('[data-a=reload]');
    if (r) r.addEventListener('click', () => location.reload());
  }

  function mount() {
    const inv = U().invoice.parse(document, invoiceId);
    // A patient invoice billed to its funder (an "Invoice UPC-..." payment row), nothing still waiting to be billed,
    // and something outstanding: the excess.
    if (inv.isFunder || !(inv.outstanding > 0) || inv.pending.length || !inv.payments.length) return;
    U().ui.nativeStyles();
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-outline-primary-light upc-charge-excess';
    btn.textContent = 'Schedule Excess';
    btn.addEventListener('click', ask);
    // Next to Process Now (with its drop-down; live 16 Nov 2026 the buttons carry data-modal-href, not href), else
    // next to Mark as Paid, else under the payments.
    const by = (part) => document.querySelector('#invoicePayments [href*="' + part + '"], #invoicePayments [data-modal-href*="' + part + '"]') ||
      document.querySelector('#pageContent a[href*="' + part + '"], #pageContent [data-modal-href*="' + part + '"]');
    const process = by('/pay/securepay');
    const at = process ? (process.closest('.btn-group') || process) : by('/pay/offline');
    if (at) { at.insertAdjacentElement('afterend', btn); btn.style.marginLeft = '4px'; }
    else {
      const box = document.createElement('div');
      box.className = 'upc-native my-2';
      box.appendChild(btn);
      (document.querySelector('#invoicePayments') || document.querySelector('#invoiceLines')).insertAdjacentElement('afterend', box);
    }
  }

  function start() {
    if (!U() || !U().invoice || !document.querySelector('#invoicePayments')) return;
    try { mount(); } catch (e) { console.error('[UPC charge excess]', e); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  window.upcChargeExcess = { version: VERSION };
})();
