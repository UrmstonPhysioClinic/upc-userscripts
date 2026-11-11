// ==UserScript==
// @name         Halaxy insurer portal fill (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.1.4
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/portal-fill.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/portal-fill.user.js
// @description  "Fill on the Bupa portal" / "Fill on the AXA portal" on a Bupa or AXA funder invoice: fills the claim on the insurer's provider site from Halaxy and stops before submitting, for Carl or Wendy to check and submit. Once the portal says it was submitted, offers to mark the funder invoice Issued. Needs loader 1.2.0.
// @match        https://*.halaxy.com/a/pr/*
// @match        https://provider.axahealth.co.uk/*
// @match        https://providersonline.bupa.co.uk/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * Portal fill (agreed with Carl, 11 Nov 2026; layouts captured live the same day).
 *
 *  In Halaxy, on a Bupa or AXA funder (organisation) invoice, and as the last step of Invoice Funder:
 *   - Reads the claim: the fees on the funder invoice (date, description, amount), the funder invoice's number
 *     (without the leading 0: UPC-01111 is entered as UPC-1111) and date, the claim's membership and
 *     authorisation numbers (the claim's edit pop-up on the patient invoice), the patient's name, date of birth and
 *     address (notes sidebar and Edit page, read only), and for AXA a suggested condition from the first lines
 *     under "Subjective:" in the notes for that claim.
 *   - Passes it to the portal tab through the loader's storage on this PC (loader 1.2.0), only for that portal's
 *     site, and opens the portal. Cleared once done, or after 4 hours.
 *   - When the portal says the invoice was submitted, asks whether to mark the funder invoice Issued (only then:
 *     Carl, 10 Nov 2026).
 *  On the portal, following Carl's steps (portal-fill.md):
 *   - AXA: membership number, "Submit invoice", then the form: Therapist; payee details (Script settings, Portal
 *     fill: settings); ICS code NA; one fee per treatment line, Outpatient, 1 unit; "add another treatment line"
 *     for each further fee. The condition is highlighted to check.
 *   - Bupa: you log in (on Bupa's separate log-in site, identity.provider.bupa.co.uk, where the script doesn't run; Carl,
 *     11 Nov 2026: simpler and safer than pressing it for you), then it carries on from Providers Online: closes the cookie box, Create an invoice, invoice number,
 *     first treatment date and pre-auth number, Next on the Pre-Auth Summary, checks Urmston Physio Clinic is the
 *     provider, removes any pre-populated treatment, then adds one fee per treatment (Consultant rooms, 1 session,
 *     the fee), leaving Bupa's impairment and procedure code as they come.
 *   - Stops before submitting, and stops (saying why) at anything it doesn't expect. It never presses Submit.
 *   - A fill that fails, in Halaxy or on the portal, sends Carl a task on the funder invoice, and the person filling is
 *     told he has been notified (Carl, 11 Nov 2026). Stopping it with the Stop button doesn't.
 */
(() => {
  'use strict';
  if (window.__hxPortalFill) return;
  window.__hxPortalFill = true;

  const VERSION = '0.1.4';
  const KEY = 'portal-claim';
  const MAX_AGE = 4 * 3600e3;
  const PORTALS = {
    axa: { name: 'AXA', host: 'provider.axahealth.co.uk', start: 'https://provider.axahealth.co.uk/payment-support-service/form/submit-invoice-updated/' },
    bupa: { name: 'Bupa', host: 'providersonline.bupa.co.uk', start: 'https://providersonline.bupa.co.uk/providers-online/' },
  };
  // The clinic's own payee details for AXA (Carl, 11 Nov 2026: "there is nothing secret"). Can be changed per PC in Script settings.
  const DEFAULTS = { payee: 'Urmston Physio Clinic', providerCode: 'ZZ03779', email: 'admin@urmstonphysioclinic.com', phone: '01617484100' };
  const OWNER = 'Carl Healy';   // gets a task in Halaxy when a fill fails (Carl, 11 Nov 2026)
  const clean = (s) => String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim();
  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const shared = (op, key, value) => (window.__upcLoader && window.__upcLoader.shared ? window.__upcLoader.shared(op, key, value) : Promise.resolve(null));
  const kindOf = (s) => (/bupa/i.test(s || '') ? 'bupa' : /\baxa\b/i.test(s || '') ? 'axa' : '');
  const slash = (ms) => { const d = new Date(ms); return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear(); };
  const pounds = (pence) => (pence / 100).toFixed(2);

  const onPortal = Object.keys(PORTALS).find((k) => location.hostname === PORTALS[k].host);
  if (onPortal) portal(onPortal); else halaxy();

  // ================================================================== Halaxy

  function halaxy() {
    const U = () => window.UPC;
    const m = location.pathname.match(/\/invoice\/(?:\d+\/)?(\d+)\/?$/);
    if (!m || !/^\/a\/pr\/\d+\//.test(location.pathname)) return;
    const invoiceId = m[1];
    const settings = () => Object.assign({}, DEFAULTS, GM_getValue('settings', {}));

    function tellHealthCheck(e) {
      const message = (e && e.message) || String(e);
      if (!/has changed/.test(message)) return;
      document.dispatchEvent(new CustomEvent('upc-loader-error', { detail: JSON.stringify({ file: 'portal-fill.user.js', message }) }));
    }

    // ---------------------------------------------------------------- reading the claim

    const nameOnly = (s) => clean(String(s || '').replace(/\([^)]*\)/g, ' ').replace(/^(mr|mrs|ms|miss|mx|dr|master|prof)\.?\s+/i, ''));
    const noLeadingZero = (n) => String(n || '').replace(/^(UPC-)0+(?=\d)/i, '$1');
    const funderPrefix = /^(axa( health| ppp)?|bupa)\s*:\s*/i;

    // The first line under "Subjective:" ("C/O ongoing shoulder pain post-fall 7/52 ago"), without "C/O".
    function conditionFrom(html) {
      const doc = U().htmlDoc('<div>' + (html || '') + '</div>');
      doc.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
      doc.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, tr').forEach((e) => e.append('\n'));
      const lines = doc.body.textContent.split('\n').map((l) => clean(l)).filter(Boolean);
      const i = lines.findIndex((l) => /^subjective\b/i.test(l));
      if (i < 0) return '';
      const same = lines[i].replace(/^subjective\s*:?\s*/i, '');
      const first = same || lines[i + 1] || '';
      return clean(first.replace(/^[-*•\s]+/, '').replace(/^c\s*\/\s*o\s*:?\s*/i, '')).slice(0, 120);
    }
    async function suggestCondition(lpg, fromMs, toMs) {
      const items = (await U().notes.items(lpg)).filter((x) => x.noteId && x.entity === 'note' && (x.category === 'appointment' || x.category === 'note')
        && x.date && x.date >= fromMs - 90 * 86400e3 && x.date <= toMs + 86400e3).sort((a, b) => a.date - b.date).slice(0, 4);
      const found = [];
      for (const n of items) {
        const j = await U().http.json('/note/' + encodeURIComponent(n.noteId));
        const c = conditionFrom((j && (j.content || j.final)) || '');
        if (c) found.push(c);
      }
      if (!found.length) return '';
      const count = {};
      found.forEach((c) => { const k = c.toLowerCase(); count[k] = (count[k] || 0) + 1; });
      return found.slice().sort((a, b) => count[b.toLowerCase()] - count[a.toLowerCase()])[0];
    }

    async function readClaim(say) {
      say('Reading the funder invoice...');
      const inv = U().invoice.parse(document, invoiceId);
      const kind = kindOf(inv.billToName || clean((document.querySelector('#card-invoice-view-organisation') || {}).textContent));
      if (!kind) throw new (U().Error)('This isn\'t a Bupa or AXA funder invoice.');
      const lines = inv.lines.filter((l) => l.amount > 0);
      if (!lines.length) throw new (U().Error)('There are no fees above £ 0.00 on this invoice.');
      const days = lines.map((l) => U().parseDay(l.date));
      if (days.some((d) => d === null)) throw new (U().Error)('A fee date on this invoice couldn\'t be read.');
      const pInv = lines[0].patientInvoiceId;
      if (!pInv) throw new (U().Error)('The fees don\'t link back to a patient invoice, so the claim couldn\'t be read.');
      say('Reading the claim...');
      const pDoc = await U().http.html('/invoice/' + pInv);
      const pinv = U().invoice.parse(pDoc, pInv);
      const edit = pDoc.querySelector('#editClaimButton');
      if (!pinv.patientId || !edit) throw new (U().Error)('The patient invoice layout has changed (patient or claim not found), so the claim couldn\'t be read.');
      const claim = (await U().http.popup(edit.getAttribute('href').replace(/^https?:\/\/[^/]+/, ''))).doc;
      const field = (n) => { const el = claim.querySelector('[name="' + n + '"]'); return el ? clean(el.value) : null; };
      const membership = field('claim[col1]'), authorisation = field('claim[enc1]');
      if (membership === null || authorisation === null) throw new (U().Error)('The claim pop-up has changed (membership or authorisation number not found), so the claim couldn\'t be read.');
      say('Reading the patient\'s details...');
      const det = await U().patient.details(pinv.patientId);
      const dob = U().parseDay(det.dob);
      const ed = await U().http.html('/patient/' + encodeURIComponent(pinv.patientId) + '/edit');
      const addr = (part) => { const el = ed.querySelector('[name="patientdetailmain[linkPaG][linkpagaddresses][0][address][' + part + ']"]'); return el ? clean(el.value) : ''; };
      if (!ed.querySelector('[name^="patientdetailmain[linkPaG][linkpagaddresses][0][address]"]')) throw new (U().Error)('The patient Edit page has changed (address not found), so the claim couldn\'t be read.');
      const settingsForm = (await U().http.popup('/invoice/options/' + invoiceId)).doc.querySelector('[name="form[displayDate]"]');
      const invDate = settingsForm ? U().parseDay(settingsForm.value) : null;
      let condition = '';
      if (kind === 'axa') {
        say('Reading the notes for the condition...');
        try { condition = await suggestCondition(pinv.patientId, Math.min(...days), Math.max(...days)); } catch (e) { condition = ''; }
      }
      const s = settings();
      const out = {
        v: 1, kind, forHost: PORTALS[kind].host, at: Date.now(), status: 'ready', progress: {},
        invoiceId, invoiceUrl: location.origin + U().base() + '/invoice/' + invoiceId, number: noLeadingZero(inv.number),
        invoiceDate: invDate ? slash(invDate) : '', total: pounds(lines.reduce((t, l) => t + l.amount, 0)),
        membership, authorisation, condition,
        patient: { name: nameOnly(det.fullName), dob: dob ? slash(dob) : '', address: [addr('firstline'), addr('secondline'), addr('postcode')].filter(Boolean).join(', '),
          hasPostcode: !!addr('postcode') },
        lines: lines.map((l, i) => ({ date: slash(days[i]), code: clean(l.item), description: clean(l.description).replace(funderPrefix, ''), amount: pounds(l.amount) })),
        payee: { name: s.payee, providerCode: s.providerCode, email: s.email, phone: s.phone },
      };
      const missing = [];
      if (!out.patient.name) missing.push('the patient\'s name');
      if (kind === 'axa') {
        if (!membership) missing.push('the membership number (claim)');
        if (!out.patient.dob) missing.push('the date of birth');
        if (!out.patient.hasPostcode) missing.push('the patient\'s postcode');
        if (!s.email || !s.phone) missing.push('the payee email and phone (Script settings, Portal fill: settings)');
      } else if (!authorisation) missing.push('the pre-auth (authorisation) number (claim)');
      if (missing.length) throw new (U().Error)('Not filled: Halaxy doesn\'t have ' + missing.join(', ') + '.');
      return out;
    }

    // ---------------------------------------------------------------- page furniture

    const CSS = `
      .upc-pf { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 8px 0; }
      .upc-pf .btn { margin: 0; }
    `;
    let box = null, busy = false, note = '', noteErr = false;
    function draw() {
      if (!box) return;
      const k = box.getAttribute('data-kind');
      box.innerHTML = '<button type="button" class="btn btn-outline-primary-light" data-a="fill"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Reading the claim...' : 'Fill on the ' + PORTALS[k].name + ' portal') + '</button>' +
        (note ? '<span class="' + (noteErr ? 'upc-err' : 'text-muted') + '">' + esc(note) + '</span>' : '');
    }
    function mount(kind) {
      if (!document.getElementById('upc-portal-fill-css')) {
        const st = document.createElement('style');
        st.id = 'upc-portal-fill-css';
        st.textContent = CSS;
        document.head.appendChild(st);
      }
      U().ui.nativeStyles();
      box = document.createElement('div');
      box.className = 'upc-native upc-pf';
      box.setAttribute('data-kind', kind);
      box.setAttribute('data-upc-portal-fill', '');
      const card = document.querySelector('#card-invoice-view-organisation');
      const at = card && (card.querySelector('.card-body') || card);
      if (at) at.appendChild(box); else (document.querySelector('#invoiceLines') || document.body).insertAdjacentElement('beforebegin', box);
      box.addEventListener('click', (e) => { if (e.target.closest('[data-a=fill]')) fill(); });
      draw();
    }

    async function fill() {
      if (busy) return;
      const s = settings();
      if (box.getAttribute('data-kind') === 'axa' && (!s.email || !s.phone)) { showSettings(); return; }
      const kindName = PORTALS[box.getAttribute('data-kind')].name;
      busy = true; note = ''; noteErr = false; draw();
      // The portal opens straight away (pop-up blockers allow it only from the click), and fills once the claim is ready.
      const tab = window.open('about:blank', '_blank');
      try {
        const claim = await readClaim((t) => { note = t; draw(); });
        await shared('set', KEY, claim);
        const back = await shared('get', KEY);
        if (!back || back.invoiceId !== invoiceId) throw new (U().Error)('The claim couldn\'t be passed to the portal (loader 1.2.0 needed: update it in Tampermonkey).');
        if (tab) tab.location.href = PORTALS[claim.kind].start; else window.open(PORTALS[claim.kind].start, '_blank');
        note = 'Filling on the ' + PORTALS[claim.kind].name + ' portal. Check it there and submit. Once it\'s submitted, you\'ll be asked here whether to mark this invoice Issued.';
        watch();
      } catch (e) {
        if (tab) tab.close();
        tellHealthCheck(e);
        note = (e.message || String(e)) + ' ' + await notifyOwner(kindName, e.message || String(e), 'Halaxy, before the portal was opened');
        noteErr = true;
      }
      busy = false; draw();
    }

    // A fill that fails: a task for Carl on the funder invoice (once per fill), so it's picked up.
    async function notifyOwner(portalName, reason, where, key) {
      const number = clean(document.title).match(/UPC-?\d+/i);
      try {
        await U().tasks.addToInvoice(invoiceId, {
          title: 'Portal fill stopped: ' + portalName + (number ? ', ' + number[0] : ''), assignee: OWNER, priority: 2, due: U().dayLabel(Date.now()),
          comment: 'The ' + portalName + ' portal fill stopped (' + where + '): ' + reason + '\nThe claim needs submitting by hand, or the fill trying again once the cause is fixed.\nPortal fill ' + VERSION + (key ? ', ' + key : '') + '.',
          key: key || undefined,
        });
        return OWNER + ' has been sent a task in Halaxy and will pick it up.';
      } catch (x) {
        tellHealthCheck(x);
        return 'A task for ' + OWNER + ' couldn\'t be added (' + (x.message || x) + '): please tell him.';
      }
    }

    // Once the portal says it was submitted: offer to mark the funder invoice Issued.
    let watching = null, asking = false;
    function watch() {
      if (watching) return;
      watching = setInterval(check, 5000);
      check();
    }
    async function check() {
      if (asking) return;
      const c = await shared('get', KEY);
      if (!c || c.invoiceId !== invoiceId) { clearInterval(watching); watching = null; return; }
      if (c.status === 'stopped') { clearInterval(watching); watching = null; await shared('del', KEY); note = 'The fill on the ' + PORTALS[c.kind].name + ' portal was stopped.'; noteErr = false; draw(); return; }
      if (c.status === 'failed') {
        // Reported from whichever Halaxy tab sees it first; the task's key stops a second one.
        asking = true;
        c.status = 'reporting';
        await shared('set', KEY, c);
        const told = await notifyOwner(PORTALS[c.kind].name, c.reason || 'no reason given', 'on the portal', 'fill ' + c.at);
        await shared('del', KEY);
        clearInterval(watching); watching = null;
        note = 'The fill on the ' + PORTALS[c.kind].name + ' portal stopped: ' + (c.reason || '') + ' ' + told; noteErr = true;
        asking = false;
        draw();
        return;
      }
      if (c.status !== 'submitted' || document.visibilityState !== 'visible') return;
      asking = true;
      clearInterval(watching); watching = null;
      const ok = await confirm('Mark Issued?', '<p>The ' + esc(PORTALS[c.kind].name) + ' portal says the invoice was submitted (' + esc(c.number) + ', £ ' + esc(c.total) + '). Mark this funder invoice Issued?</p>', 'Mark Issued');
      if (ok) {
        try { await U().invoice.setStatus(invoiceId, 'issued'); note = 'Submitted to ' + PORTALS[c.kind].name + ' and marked Issued.'; noteErr = false; }
        catch (e) { note = 'Submitted, but not marked Issued: ' + (e.message || e) + ' Set it with the cogwheel.'; noteErr = true; tellHealthCheck(e); }
      } else note = 'Submitted to ' + PORTALS[c.kind].name + '. Not marked Issued.';
      await shared('del', KEY);
      asking = false;
      draw();
    }
    function confirm(title, html, yes) {
      return new Promise((resolve) => {
        let answered = false;
        const end = (v) => { if (!answered) { answered = true; resolve(v); } };
        const dlg = U().ui.dialog({ title, small: true, onClose: () => end(false) });
        if (!dlg) { end(false); return; }
        dlg.root.setAttribute('data-upc-pf-confirm', '');
        dlg.body.innerHTML = html + '<div class="upc-actions"><button type="button" class="btn btn-outline-primary" data-c="no">Not now</button><button type="button" class="btn btn-primary" data-c="yes">' + esc(yes) + '</button></div>';
        dlg.body.addEventListener('click', (e) => { const b = e.target.closest('[data-c]'); if (!b) return; end(b.dataset.c === 'yes'); dlg.close(); });
      });
    }

    function showSettings() {
      U().ui.nativeStyles();
      const dlg = U().ui.dialog({ title: 'Portal fill: settings', key: 'upc-portal-fill-settings', small: true });
      if (!dlg) return;
      const s = settings();
      const row = (k, label, help) => '<div class="form-group"><label for="upc-pf-' + k + '">' + esc(label) + '</label><input class="form-control" id="upc-pf-' + k + '" data-k="' + k + '" value="' + esc(s[k]) + '">' +
        (help ? '<small class="text-muted">' + esc(help) + '</small>' : '') + '</div>';
      dlg.body.innerHTML = '<p>The payee details AXA asks for on every invoice. Kept on this PC.</p>' + row('payee', 'Name of payee') + row('providerCode', 'AXA provider code') +
        row('email', 'Payee email address', 'For AXA\'s queries about the payment.') + row('phone', 'Payee phone number') +
        '<div class="upc-actions"><button type="button" class="btn btn-outline-primary" data-c="no">Cancel</button><button type="button" class="btn btn-primary" data-c="yes">Save</button></div>';
      dlg.body.addEventListener('click', (e) => {
        const b = e.target.closest('[data-c]');
        if (!b) return;
        if (b.dataset.c === 'yes') {
          const v = {};
          dlg.body.querySelectorAll('[data-k]').forEach((i) => { v[i.dataset.k] = clean(i.value); });
          GM_setValue('settings', v);
        }
        dlg.close();
      });
    }

    function start() {
      if (!U()) { console.error('[UPC portal fill] needs the core library'); return; }
      if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('Portal fill: settings', showSettings);
      const inv = U().invoice.parse(document, invoiceId);
      const kind = inv.isFunder ? kindOf(inv.billToName || clean((document.querySelector('#card-invoice-view-organisation') || {}).textContent)) : '';
      if (!kind) return;
      mount(kind);
      shared('get', KEY).then((c) => { if (c && c.invoiceId === invoiceId && c.status !== 'stopped') watch(); });
      if (location.hash === '#upc-portal-fill') {
        history.replaceState(null, '', location.pathname + location.search);
        note = 'Press the button to fill the claim on the ' + PORTALS[kind].name + ' portal.';
        draw();
      }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
    window.upcPortalFill = { version: VERSION, conditionFrom, readClaim };
  }

  // ================================================================== the insurer's portal

  function portal(kind) {
    const P = PORTALS[kind];
    let claim = null, panel = null, acted = false;
    const txt = (e) => clean(e ? e.textContent : '');
    const visible = (e) => !!(e && (e.offsetWidth || e.offsetHeight || e.getClientRects().length));
    const heads = () => [...document.querySelectorAll('h1, h2, h3, h4, legend')].filter(visible).map(txt);
    const save = () => shared('set', KEY, claim);

    // ---------------------------------------------------------------- the panel
    const PANEL_CSS = `
      #upc-pf-panel { position: fixed; right: 16px; top: 16px; z-index: 2147483000; width: 340px; max-width: calc(100vw - 32px); background: #fff; color: #1d2433;
        border: 1px solid #c9cfdc; border-left: 4px solid #7b3fe4; border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,.2); font: 14px/1.4 Arial, sans-serif; padding: 12px 14px; }
      #upc-pf-panel b { display: block; margin-bottom: 4px; }
      #upc-pf-panel .upc-pf-err { color: #b3261e; }
      #upc-pf-panel button { margin-top: 8px; font: inherit; padding: 4px 10px; border: 1px solid #c9cfdc; border-radius: 4px; background: #fff; cursor: pointer; }
      .upc-pf-check { outline: 3px solid #f0ad4e !important; outline-offset: 2px; }
    `;
    function say(message, error, done) {
      if (!panel) {
        const st = document.createElement('style');
        st.textContent = PANEL_CSS;
        document.head.appendChild(st);
        panel = document.createElement('div');
        panel.id = 'upc-pf-panel';
        panel.addEventListener('click', async (e) => {
          if (e.target.closest('[data-a=stop]')) { if (claim) { claim.status = 'stopped'; await save(); } say('Stopped. Nothing more will be filled.', false, true); }
        });
        document.body.appendChild(panel);
      }
      panel.innerHTML = '<b>Fill from Halaxy' + (claim ? ': ' + esc(claim.number) + ', ' + esc(claim.patient.name) : '') + '</b><div class="' + (error ? 'upc-pf-err' : '') + '">' + esc(message) + '</div>' +
        (done ? '' : '<button type="button" data-a="stop">Stop</button>');
    }
    // Anything unexpected: the fill stops and Halaxy sends Carl a task (Carl, 11 Nov 2026).
    const stop = async (message) => {
      if (claim) { claim.status = 'failed'; claim.reason = message; await save(); }
      say(message + ' The fill has stopped. ' + OWNER.split(' ')[0] + ' has been notified (a task in Halaxy) and will pick it up.', true, true);
    };

    // ---------------------------------------------------------------- filling fields
    function setValue(el, v) {
      const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      el.focus();
      setter.call(el, String(v));
      ['input', 'change', 'keyup', 'blur'].forEach((t) => el.dispatchEvent(new Event(t, { bubbles: true })));
      if (window.jQuery) { try { window.jQuery(el).trigger('change'); } catch (e) { /* ignore */ } }
    }
    function tick(el) { if (!el.checked) el.click(); }
    function labelOf(el) {
      const id = el.getAttribute('id');
      let l = null;
      try { l = id ? document.querySelector('label[for="' + CSS.escape(id) + '"]') : null; } catch (e) { l = null; }
      return txt(l || el.closest('label'));
    }
    const inputs = (root) => [...(root || document).querySelectorAll('input, select, textarea')].filter((e) => e.type !== 'hidden');
    const byLabel = (re, list) => (list || inputs()).find((e) => re.test(labelOf(e)));
    const buttonByText = (re, root) => [...(root || document).querySelectorAll('button, input[type=submit], input[type=button], a')].find((b) => visible(b) && re.test(clean(b.textContent || b.value)));
    const optionByText = (sel, re) => [...sel.options].find((o) => re.test(clean(o.textContent)));

    // ---------------------------------------------------------------- AXA
    async function axa() {
      const done = document.querySelector('.Form__Success__Message');
      if (visible(done) && /submitted successfully/i.test(txt(done))) return submitted();
      if (/\/axa-health-new\/?$/.test(location.pathname)) return axaForm();
      if (/\/submit-invoice-updated\/?$/.test(location.pathname)) {
        const member = document.querySelector('input[id^="member_id_v"]') || byLabel(/membership/i);
        const go = document.querySelector('[id^="next_v"]') || buttonByText(/^submit invoice$/i);
        if (!member || !go) return stop('The AXA membership number page has changed.');
        if (!claim.membership) return stop('Halaxy has no membership number for this claim.');
        setValue(member, claim.membership);
        claim.status = 'filling'; claim.progress.member = true; await save();
        say('Membership number entered. Opening the invoice form...');
        await sleep(300);
        go.click();
        return;
      }
      say('Waiting for AXA\'s "Submit an invoice" page. If it doesn\'t open, go to Payment support and submit an invoice.');
    }

    async function axaForm() {
      const all = inputs(document.querySelector('form') || document);
      const who = all.find((e) => e.type === 'radio' && /^therapist\b/i.test(labelOf(e)));
      if (!who) return stop('The AXA form has changed ("Therapist" not found).');
      tick(who);
      await sleep(400);
      const list = () => inputs(document.querySelector('form') || document);
      const need = [
        ['Membership number', /^membership number/i, claim.membership, true], ['Patient\'s forename and surname', /^patient.{1,3}s forename and surname/i, claim.patient.name, true],
        ['Patient\'s date of birth', /^patient.{1,3}s date of birth/i, claim.patient.dob, true], ['Patient\'s address', /^patient.{1,3}s address/i, claim.patient.address, true],
        ['Name of payee', /^name of payee/i, claim.payee.name, true], ['AXA provider code', /provider code/i, claim.payee.providerCode, true],
        ['Payee email', /payee.{1,3}s email/i, claim.payee.email, true], ['Payee phone', /payee.{1,3}s phone/i, claim.payee.phone, true],
        ['Authorisation number', /^authorisation number/i, claim.authorisation, false], ['Condition', /^condition for which/i, claim.condition, true],
        ['Invoice total', /^invoice total/i, claim.total, true], ['Invoice date', /^invoice date/i, claim.invoiceDate, false],
        ['Invoice/account number', /^invoice\/account number/i, claim.number, true],
      ];
      for (const [name, re, value, required] of need) {
        const el = byLabel(re, list());
        if (!el) { if (required) return stop('The AXA form has changed ("' + name + '" not found).'); continue; }
        if (value) setValue(el, value);
      }
      // Treatment lines: one fee each. Later lines appear once "add another treatment line" is Yes.
      const descs = () => list().filter((e) => /^treatment description - line \d+/i.test(labelOf(e)))
        .sort((a, b) => +labelOf(a).match(/line (\d+)/i)[1] - +labelOf(b).match(/line (\d+)/i)[1]);
      if (claim.lines.length > descs().length) return stop('AXA\'s form takes ' + descs().length + ' treatment lines and this invoice has ' + claim.lines.length + '.');
      for (let i = 0; i < claim.lines.length; i++) {
        const now = list();
        const d = descs();
        const from = now.indexOf(d[i]), to = d[i + 1] ? now.indexOf(d[i + 1]) : now.length;
        const before = now.slice(d[i - 1] ? now.indexOf(d[i - 1]) + 1 : 0, from);
        const slice = now.slice(from, to);
        const ics = before.filter((e) => /must be completed to proceed/i.test(e.getAttribute('placeholder') || '')).pop();
        const out = slice.find((e) => e.type === 'radio' && /^outpatient/i.test(labelOf(e)));
        const date = byLabel(/^treatment date/i, slice), units = byLabel(/^number of/i, slice), charge = byLabel(/^charge per unit/i, slice), total = byLabel(/^total/i, slice);
        const more = slice.filter((e) => e.type === 'radio' && /^(yes|no)$/i.test(labelOf(e)));
        const miss = [['outpatient', out], ['treatment date', date], ['number of treatments', units], ['charge per unit', charge], ['total', total]].filter((x) => !x[1]).map((x) => x[0]);
        if (miss.length) return stop('The AXA form has changed (treatment line ' + (i + 1) + ': ' + miss.join(', ') + ' not found).');
        const l = claim.lines[i];
        if (ics) setValue(ics, 'NA');
        setValue(d[i], l.description);
        tick(out);
        setValue(date, l.date);
        setValue(units, '1');
        setValue(charge, l.amount);
        setValue(total, l.amount);
        const answer = more.find((e) => (i < claim.lines.length - 1 ? /^yes$/i : /^no$/i).test(labelOf(e)));
        if (answer) { tick(answer); await sleep(400); } else if (i < claim.lines.length - 1) return stop('The AXA form has changed ("add another treatment line" not found).');
      }
      const cond = byLabel(/^condition for which/i, list());
      if (cond) cond.classList.add('upc-pf-check');
      claim.status = 'filled'; claim.progress.filled = true; await save();
      const submit = buttonByText(/^submit$/i);
      if (submit) submit.scrollIntoView({ block: 'center' });
      say('Filled: ' + claim.lines.length + ' treatment line' + (claim.lines.length === 1 ? '' : 's') + ', £ ' + claim.total + '. Check everything, especially the condition (highlighted' +
        (claim.condition ? ', from the notes' : ', not found in the notes: please type it') + '), then press Submit yourself.', false, true);
      // AXA shows its "submitted" message in the same page: watch for it once (our own panel changing is ignored).
      const obs = new MutationObserver((list) => {
        if (list.every((m) => panel && panel.contains(m.target))) return;
        const s = document.querySelector('.Form__Success__Message');
        if (visible(s) && /submitted successfully/i.test(txt(s))) { obs.disconnect(); submitted(); }
      });
      obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
    }

    // ---------------------------------------------------------------- Bupa
    async function bupa() {
      const h = heads();
      const has = (re) => h.some((x) => re.test(x));
      if (has(/invoice has been submitted successfully/i)) return submitted();
      const pw = [...document.querySelectorAll('input[type=password]')].find(visible);
      if (pw) return say('Log in to Bupa. The fill carries on once you\'re in.');
      const cookie = document.getElementById('onetrust-reject-all-handler');
      if (visible(cookie)) { cookie.click(); await sleep(500); }
      const pr = claim.progress;
      const form = document.getElementById('createClaimForm');
      // Remove a pre-populated treatment: confirm.
      if (has(/^remove this treatment\?$/i)) {
        const b = buttonByText(/^remove treatment$/i);
        if (pr.stage !== 'removing' || !b) return stop('Bupa asked to remove a treatment unexpectedly.');
        pr.stage = 'list'; await save();
        return b.click();
      }
      // Add a treatment: one fee.
      const imp = document.querySelector('select[name="impairmentPair"]');
      if (imp) {
        // Back on the form after Save: Bupa didn't take the treatment.
        if (pr.stage === 'saving') return stop('Bupa didn\'t accept treatment ' + ((pr.added || 0) + 1) + ' (it\'s still open).');
        // Bupa opens a new treatment by itself once the last pre-populated one is removed (Carl, 11 Nov 2026).
        if (pr.stage !== 'adding') { pr.cleared = true; pr.stage = 'adding'; await save(); }
        const l = claim.lines[pr.added || 0];
        if (!l) return stop('Bupa opened another treatment after all ' + claim.lines.length + ' were added.');
        const proc = document.querySelector('select[name="procedureCode"]');
        const place = document.querySelector('select[name="placeOfService"]');
        const from = document.querySelector('input[name="treatmentFromDate"]'), to = document.querySelector('input[name="treatmentToDate"]');
        const count = document.querySelector('input[name="incidents"]'), charge = document.querySelector('input[name="chargeAmount"]');
        const saveBtn = buttonByText(/^save$/i, form || document);
        if (!place || !from || !to || !count || !charge || !saveBtn) return stop('Bupa\'s treatment form has changed.');
        const cr = optionByText(place, /^consultant rooms$/i);
        if (!cr) return stop('Bupa\'s place of service list has no "Consultant rooms".');
        setValue(place, cr.value);
        setValue(from, l.date);
        setValue(to, l.date);
        setValue(count, '1');
        setValue(charge, l.amount);
        // The procedure is the fee (Carl, 11 Nov 2026): the Halaxy fee's Item Code is Bupa's procedure code (AA360 ...),
        // which starts each procedure in Bupa's list ("AA360-...").
        if (proc) {
          const code = String(l.code || '').toUpperCase();
          const fits = code ? [...proc.options].filter((o) => o.index > 0 && clean(o.textContent).toUpperCase().split(/[\s-]/)[0] === code) : [];
          if (fits.length === 1) setValue(proc, fits[0].value);
          else if (proc.selectedIndex > 0) setValue(proc, proc.options[0].value);   // pre-selected, but not this fee's code
        }
        const missing = [[imp, 'impairment'], [proc, 'procedure']].filter(([x]) => x && x.selectedIndex <= 0);
        if (missing.length) {
          pr.stage = 'saving'; await save();
          missing.forEach(([x]) => x.classList.add('upc-pf-check'));
          return say('Choose the ' + missing.map((x) => x[1]).join(' and ') + ' for this fee (' + (l.code ? l.code + ' ' : '') + l.description + ', ' + l.date + ', £ ' + l.amount + '; highlighted' +
            (missing.some((x) => x[1] === 'procedure') && l.code ? ': ' + l.code + ' isn\'t in Bupa\'s list' : '') + '), then press Save. The fill carries on.');
        }
        pr.stage = 'saving'; await save();
        say('Adding treatment ' + ((pr.added || 0) + 1) + ' of ' + claim.lines.length + '...');
        await sleep(300);
        return saveBtn.click();
      }
      // The treatment list.
      const addBtn = buttonByText(/^add treatment$/i);
      if (has(/^treatment details$/i) && addBtn) {
        if (pr.stage === 'saving') { pr.added = (pr.added || 0) + 1; pr.stage = 'list'; await save(); }
        if (!pr.cleared) {
          const remove = [...document.querySelectorAll('a, button, input[type=submit]')].find((b) => visible(b) && /^remove( treatment)?$/i.test(clean(b.textContent || b.value)));
          if (remove) { pr.stage = 'removing'; await save(); say('Removing a pre-populated treatment...'); return remove.click(); }
          pr.cleared = true; await save();
        }
        if ((pr.added || 0) < claim.lines.length) {
          pr.stage = 'adding'; await save();
          say('Adding treatment ' + ((pr.added || 0) + 1) + ' of ' + claim.lines.length + '...');
          return addBtn.click();
        }
        const next = buttonByText(/^next$/i);
        if (!next) return stop('Bupa\'s treatment list has changed ("Next" not found).');
        pr.stage = 'confirm'; await save();
        return next.click();
      }
      // Confirm and Submit: stop here.
      if (has(/^confirm and submit$/i) || document.getElementById('confirmation')) {
        claim.status = 'filled'; await save();
        const shown = (document.body.textContent.match(/total[^£]{0,30}£\s*([\d,]+\.\d{2})/i) || [])[1];
        const differs = shown && shown.replace(/,/g, '') !== claim.total;
        const box = document.getElementById('confirmation');
        if (box) { box.classList.add('upc-pf-check'); box.scrollIntoView({ block: 'center' }); }
        return say('Filled: ' + claim.lines.length + ' treatment' + (claim.lines.length === 1 ? '' : 's') + ', £ ' + claim.total + '.' +
          (differs ? ' Bupa shows a total of £ ' + shown + ': check the treatments.' : '') + ' Check everything, tick the confirmation and press Submit yourself.', !!differs, true);
      }
      // Provider details: Urmston Physio Clinic must be the one chosen.
      const spec = [...document.querySelectorAll('input[type=radio][name="specialist"]')];
      if (spec.length && has(/^provider details$/i)) {
        const chosen = spec.find((r) => r.checked);
        const row = chosen && (chosen.closest('tr, li, .row, div, label') || chosen.parentElement);
        if (!chosen || !/urmston physio/i.test(txt(row))) return stop('Urmston Physio Clinic isn\'t the chosen provider.');
        const next = buttonByText(/^next$/i, chosen.form || document);
        if (!next) return stop('Bupa\'s provider page has changed ("Next" not found).');
        pr.stage = 'provider'; await save();
        return next.click();
      }
      // Set up your invoice.
      const num = document.querySelector('input[name="invoiceNumber"]');
      if (num) {
        const first = document.querySelector('input[name="firstTreatmentDate"]'), pre = document.querySelector('input[name="preAuthNumber"]');
        const next = buttonByText(/^next$/i, num.form || document);
        if (!first || !pre || !next) return stop('Bupa\'s invoice set-up page has changed.');
        setValue(num, claim.number);
        setValue(first, claim.lines[0].date);
        setValue(pre, claim.authorisation);
        claim.status = 'filling'; pr.stage = 'setup'; await save();
        say('Invoice number, first treatment date and pre-auth number entered...');
        await sleep(300);
        return next.click();
      }
      // Pre-Auth Summary.
      if (/claimSetup\.do/i.test(location.pathname) && form && /memberSearch\.do/i.test(form.getAttribute('action') || '')) {
        const next = buttonByText(/^next$/i, form);
        if (!next) return stop('Bupa\'s Pre-Auth Summary has changed ("Next" not found).');
        pr.stage = 'preauth'; await save();
        return next.click();
      }
      // Anywhere else with Bupa's menu: Create an invoice.
      if (!pr.stage || pr.stage === 'start') {
        const sel = [...document.querySelectorAll('select')].find((s) => optionByText(s, /^create an invoice$/i));
        const link = buttonByText(/^create an invoice$/i);
        if (sel) { const o = optionByText(sel, /^create an invoice$/i); pr.stage = 'start'; await save(); setValue(sel, o.value); await sleep(800); if (/^(https?:|\/)/.test(o.value) && document.visibilityState === 'visible') location.href = o.value; return; }
        if (link) { pr.stage = 'start'; await save(); return link.click(); }
      }
      say('Waiting for Bupa\'s Create an invoice page.');
    }

    async function submitted() {
      if (claim.status !== 'submitted') { claim.status = 'submitted'; claim.submittedAt = Date.now(); await save(); }
      say('Submitted to ' + P.name + '. Back in Halaxy you\'ll be asked whether to mark ' + claim.number + ' Issued.', false, true);
    }

    async function run() {
      if (acted) return;
      acted = true;
      claim = await shared('get', KEY);
      if (!claim || claim.kind !== kind || Date.now() - claim.at > MAX_AGE || !/^(ready|filling|filled|submitted)$/.test(claim.status)) return;
      if (claim.status === 'submitted') return say('Submitted to ' + P.name + '. Back in Halaxy you\'ll be asked whether to mark ' + claim.number + ' Issued.', false, true);
      claim.progress = claim.progress || {};
      try { await (kind === 'axa' ? axa() : bupa()); } catch (e) { console.error('[UPC portal fill]', e); await stop('Something went wrong: ' + (e.message || e) + '.'); }
    }
    const go = () => setTimeout(run, 700);
    if (document.readyState === 'complete') go(); else window.addEventListener('load', go, { once: true });
  }
})();
