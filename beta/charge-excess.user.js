// ==UserScript==
// @name         UPC Billing: Schedule excess (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.1.1
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/charge-excess.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/charge-excess.user.js
// @description  A "Schedule excess" button on patient invoices with an unpaid excess: sets the due date a week ahead, schedules the payment from the card on file for then, and emails the patient the "Insurance excess due" email. Asks first.
// @match        https://*.halaxy.com/a/pr/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * Schedule excess (Carl, 16 Nov 2026; file name from its first name, Charge excess). On a patient invoice that has been billed to its funder and still has something
 * outstanding (the excess), one button, after a confirm:
 *
 *  1. Invoice settings (cogwheel, /invoice/options/:id): Due Date = a week from today (core UPC.invoice.setSettings).
 *  2. Send Invoice Email (/email/document/invoice/:id, form#composeEmailForm; capture 16 Nov 2026): the form as Halaxy
 *     fills it (sender, recipient, BCC), with our subject and the "Insurance excess due" HTML as form[body]. The editor
 *     is never used, so the HTML keeps its inline styles (Halaxy's editor strips them only when a template is chosen
 *     from its list). Halaxy fills [Payment Link] and [Patient First Name] when it sends (its own rendered template
 *     still carries [Payment Link], capture 16 Nov 2026); the due date is written in by us.
 *  3. Schedule Payment (/invoicefunctions/payment/scheduled/new/invoice/:id, form#newScheduledPaymentForm; capture
 *     16 Nov 2026): one-off, the outstanding amount, from the card Halaxy picks (form[creditCard]), Halaxy's own time
 *     of day and its date plus 7 days. Checked afterwards (the pop-up's scheduledAmtTotal).
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

  const VERSION = '0.1.1';
  const U = () => window.UPC;
  if (!/^\/a\/pr\/\d+\//.test(location.pathname)) return;
  // A patient invoice: /invoice/{id} or /patient/invoice/{patient}/{id}; not the patient's Invoices tab.
  const m = location.pathname.match(/\/(?:patient\/invoice\/\d+|invoice)\/(\d+)\/?$/);
  if (!m || /\/patient\/invoice\/\d+\/?$/.test(location.pathname)) return;
  const invoiceId = m[1];

  const clean = (s) => String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim();
  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const SUBJECT = (due) => '[Action] Insurance Excess Due - Payment on ' + due;
  const tag = (t) => '<span class="dynamicterm">[' + t + ']</span>';

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
    return { form, to: clean(form.querySelector('[name="form[toEmail]"]').value) };
  }

  async function plan() {
    const inv = await U().invoice.fetch(invoiceId);
    if (!(inv.outstanding > 0)) throw new (U().Error)('Nothing is outstanding on ' + inv.number + '.');
    const s = await readSchedule();
    if (!s.card) throw new (U().Error)('No card on file for this patient. Use the "Chase - Excess Due (no card on file)" email instead.');
    if (s.already > 0) throw new (U().Error)('A payment of ' + U().money.fmt(Math.round(s.already * 100)) + ' is already scheduled on ' + inv.number + '.');
    const start = U().parseDay(s.day);
    if (!start) throw new (U().Error)('Could not read the date in the Schedule Payment pop-up. Nothing was changed.');
    const d = new Date(start);
    d.setDate(d.getDate() + 7);
    const due = U().dayLabel(d.getTime());
    const e = await readSend();
    if (!e.to) throw new (U().Error)('No email address for this patient. Add one, then try again.');
    return { inv, amount: inv.outstanding, card: s.card, due, time: String(s.hour).padStart(2, '0') + ':' + String(s.minute).padStart(2, '0'), to: e.to };
  }

  // ------------------------------------------------------------------ doing it

  async function sendEmail(p) {
    const { form } = await readSend();
    const set = { 'form[subject]': SUBJECT(p.due), 'form[body]': emailHtml(p.due), 'form[template]': '' };
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
    const set = { 'form[amount]': (p.amount / 100).toFixed(2), 'form[scheduleDate][date]': p.due };
    const pairs = U().http.serialize(s.form).map(([k, v]) => [k, k in set ? set[k] : (k === 'form[paymentScheduled]' && v === '1' ? '0' : v)]);
    const res = await U().http.postForm(SCHEDULE, pairs);
    if (res && res.status === 'FORM') U().http.expectRefresh(res, 'Scheduling the payment');
    const after = await readSchedule();
    if (Math.round(after.already * 100) < p.amount) throw new (U().Error)('Halaxy didn\'t show the payment as scheduled.');
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
        '<tr><th>Due date</th><td>' + esc(p.due) + '</td></tr>' +
        '<tr><th>Payment</th><td>' + esc(U().money.fmt(p.amount)) + ' from ' + esc(p.card) + ' on ' + esc(p.due) + ' at ' + esc(p.time) + '</td></tr>' +
        '<tr><th>Email</th><td>' + esc(SUBJECT(p.due)) + '<br><span class="text-muted">to ' + esc(p.to) + '</span></td></tr>' +
        '</tbody></table>' +
        '<div class="upc-actions"><button type="button" class="btn btn-outline-primary" data-upc-close>Cancel</button><button type="button" class="btn btn-primary" data-a="go">Schedule excess</button></div>';
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
    btn.textContent = 'Schedule excess';
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

  // ------------------------------------------------------------------ the email
  // "Insurance excess due", card layout v1 (Carl, 16 Nov 2026). Merge tags wrapped as Halaxy's own; the due date is
  // written in, as it is set just before sending.
  function emailHtml(due) {
    return `<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ece4f6" style="border-collapse:collapse; width:100%; margin:0; padding:0; border:none; background-color:#ece4f6; font-family:Arial, Helvetica, sans-serif;">
  <tbody><tr>
    <td align="center" style="border:none; margin:0; padding:18px 12px 0 12px;">
      <a href="https://www.urmstonphysioclinic.com/" style="text-decoration:none;"><img src="https://www.urmstonphysioclinic.com/images/logo-email.png" alt="Urmston Physio Clinic" width="92" height="92" style="display:block; width:92px; max-width:92px; height:92px; border:0; margin:0 auto; font-family:Arial, Helvetica, sans-serif; font-size:16px; font-weight:bold; color:#7a33c7;"></a>
    </td>
  </tr>
  <tr>
    <td align="center" style="border:none; margin:0; padding:12px 12px 24px 12px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate; width:100%; max-width:600px; margin:0 auto; padding:0; border:1px solid #e7e0f0; border-bottom:3px solid #e0d5ee; background-color:#ffffff; box-shadow:0 2px 10px rgba(60,20,110,0.08);">
        <tbody><tr>
          <td style="border:none; margin:0; padding:28px 28px 0 28px; font-family:Arial, Helvetica, sans-serif; font-size:16px; line-height:1.5; color:#1a1a1a;">
            <p style="margin:0 0 6px 0; padding:0;">Hi ${tag('Patient First Name')},</p>
            <p style="margin:0; padding:0; font-size:22px; line-height:28px; font-weight:bold; color:#1a1a1a;">Your insurance excess</p>
          </td>
        </tr>
        <tr>
          <td style="border:none; margin:0; padding:14px 28px 0 28px; font-family:Arial, Helvetica, sans-serif; font-size:15px; line-height:1.6; color:#333333;">
            <p style="margin:0; padding:0;">Your health insurer has told us there is an excess to pay on your recent claim. They should also have written to you separately with the details.</p>
          </td>
        </tr>
        <tr>
          <td style="border:none; margin:0; padding:20px 28px 0 28px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate; width:100%; margin:0; padding:0; background-color:#f8f4fd; border:1px solid #e6d9f7; border-left:4px solid #994de6;">
              <tbody><tr>
                <td style="border:none; margin:0; padding:16px 18px; font-family:Arial, Helvetica, sans-serif; font-size:15px; line-height:1.6; color:#333333;">
                  <p style="margin:0 0 6px 0; padding:0; font-size:16px; line-height:22px; font-weight:bold; color:#1a1a1a;">We'll take payment on ${esc(due)}</p>
                  <p style="margin:0 0 12px 0; padding:0;">The payment will come from the card we hold on file, so you don't need to do anything.</p>
                  <p style="margin:0 0 12px 0; padding:0;"><strong style="color:#1a1a1a;">Want to use a different card?</strong> Pay using the link below before that date. If you pay early, we won't take the automatic payment.</p>
                  <p style="margin:0; padding:0;"><strong style="color:#1a1a1a;">See the amount and pay:</strong> ${tag('Payment Link')}</p>
                </td>
              </tr>
            </tbody></table>
          </td>
        </tr>
        <tr>
          <td style="border:none; margin:0; padding:24px 28px 0 28px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate; width:100%; margin:0; padding:0; background-color:#faf9fb; border:1px solid #e5e1ea;">
              <tbody><tr>
                <td style="border:none; margin:0; padding:16px 18px; font-family:Arial, Helvetica, sans-serif; font-size:14px; line-height:1.6; color:#333333;">
                  <p style="margin:0 0 6px 0; padding:0; font-size:15px; line-height:20px; font-weight:bold; color:#1a1a1a;">Questions?</p>
                  <p style="margin:0 0 8px 0; padding:0;"><strong style="color:#1a1a1a;">About the excess amount:</strong> please contact your health insurer, as it's set by your policy.</p>
                  <p style="margin:0; padding:0;"><strong style="color:#1a1a1a;">About paying:</strong> call us on <a href="tel:01617484100" style="color:#7a33c7; text-decoration:underline; white-space:nowrap;">0161&nbsp;748&nbsp;4100</a> or reply to this email.</p>
                </td>
              </tr>
            </tbody></table>
          </td>
        </tr>
        <tr>
          <td style="border:none; margin:0; padding:24px 28px 0 28px; font-family:Arial, Helvetica, sans-serif; font-size:15px; line-height:1.6; color:#333333;">
            <p style="margin:0 0 4px 0; padding:0;">Kind regards,</p>
            <p style="margin:0; padding:0; font-weight:bold; color:#1a1a1a;">Urmston Physio Clinic</p>
          </td>
        </tr>
        <tr>
          <td style="border:none; margin:0; padding:26px 28px 0 28px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse; width:100%; margin:0; padding:0; border:none;">
              <tbody><tr>
                <td style="margin:0; padding:0; border:none; border-top:1px solid #e7e0f0; font-size:1px; line-height:1px;">&nbsp;</td>
              </tr>
            </tbody></table>
          </td>
        </tr>
        <tr>
          <td align="center" style="border:none; margin:0; padding:18px 28px 26px 28px; font-family:Arial, Helvetica, sans-serif; font-size:13px; line-height:1.7; color:#5c5c5c; text-align:center;">
            <p style="margin:0 0 4px 0; padding:0;">220 Higher Road, Urmston, Manchester M41&nbsp;9BH</p>
            <p style="margin:0 0 4px 0; padding:0;"><a href="tel:01617484100" style="color:#7a33c7; text-decoration:none;">0161 748 4100</a> &nbsp;|&nbsp; <a href="mailto:admin@urmstonphysioclinic.com" style="color:#7a33c7; text-decoration:none;">admin@urmstonphysioclinic.com</a></p>
            <p style="margin:0; padding:0;"><a href="https://www.urmstonphysioclinic.com/book" style="color:#7a33c7; text-decoration:none;">Book online</a> &nbsp;|&nbsp; <a href="https://www.urmstonphysioclinic.com/" style="color:#7a33c7; text-decoration:none;">Website</a> &nbsp;|&nbsp; <a href="https://www.facebook.com/UrmstonPhysioClinic" style="color:#7a33c7; text-decoration:none;">Facebook</a></p>
          </td>
        </tr>
      </tbody></table>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse; width:100%; max-width:600px; margin:0 auto; padding:0; border:none;">
        <tbody><tr>
          <td align="center" style="border:none; margin:0; padding:18px 20px 0 20px; font-family:Arial, Helvetica, sans-serif; font-size:12px; line-height:1.6; color:#5f5a66; text-align:center;">
            <p style="margin:0 0 8px 0; padding:0;">Urmston Physio Clinic Ltd. Registered in England and Wales, company number 17103261. Registered office: 220 Higher Road, Urmston, Manchester M41&nbsp;9BH.</p>
            <p style="margin:0; padding:0;">This email is confidential and meant only for the person it is addressed to. If you have received it by mistake, please call us on 0161 748 4100 and delete it.</p>
          </td>
        </tr>
      </tbody></table>
    </td>
  </tr>
</tbody></table>`;
  }

  window.upcChargeExcess = { version: VERSION, emailHtml, SUBJECT };
})();
