// ==UserScript==
// @name         Halaxy health check (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      1.1.27
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/health-check.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/health-check.user.js
// @description  Checks that what the clinic's scripts rely on in Halaxy is still there, notices Halaxy updates, and collects script errors. Shows a small notice only when something needs looking at, and only to Carl Healy. Read-only.
// @match        https://*.halaxy.com/a/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

/*
 * What it checks
 * - Page checks, on the pages where each script works: Halaxy's own code and page
 *   elements that our scripts use (calendar, invoice pages, reports, editors, layout).
 * - Data checks, once a day per PC and straight after a Halaxy update: the fields
 *   Outstanding Actions reads from the calendar, fee list and patient invoices, and
 *   any appointment or note status it doesn't know.
 * - Errors thrown by any of our scripts, and problems the loader had fetching updates.
 * - Halaxy's version (from its file paths), so an update is noted with its date.
 *
 * Results are kept in this browser. Nothing is sent anywhere. "Copy details" copies
 * structure only: field names, statuses and error messages, no patient details.
 */

(function () {
  'use strict';
  if (window.__hxHealth) return;
  window.__hxHealth = true;

  const VERSION = '1.1.27';
  const KEY = 'upc-health:';
  const DATA_EVERY_HOURS = 24;
  const ERRORS_KEEP_HOURS = 24;

  const NAMES = {
    'alerts.user.js': 'Alerts', 'bill-funder.user.js': 'Bill funder', 'arrival-chime.user.js': 'Arrival chime', 'chat-alert.user.js': 'Chat alert',
    'branding.user.js': 'Branding', 'calendar-controls.user.js': 'Calendar controls', 'core.user.js': 'Core library', 'custom-reports.user.js': 'Custom Reports',
    'forecourt-lights.user.js': 'Forecourt lights', 'script-settings.user.js': 'Script settings', 'review-requests.user.js': 'Review requests', 'survey-feedback.user.js': 'Feedback alerts', 'portal-fill.user.js': 'Portal fill', 'task-stamps.user.js': 'Task stamps', 'halaxy-mobile.user.js': 'Mobile layout', 'funder-chaser.user.js': 'Insurer payments due', 'check-ins.user.js': 'Check-ins', 'email-html-source.user.js': 'HTML source for emails', 'health-check.user.js': 'Health check',
    'outstanding-actions.user.js': 'Outstanding Actions', 'ready-to-bill.user.js': 'Ready to bill', 'rebate-sync.user.js': 'Rebate Sync', 'remittances.user.js': 'Remittances',
    'textarea-autogrow.user.js': 'Auto-expanding text boxes', 'toast-alerts.user.js': 'Toast alerts',
  };
  // Same rule as Outstanding Actions: these appointment statuses mean "not attended".
  const NOT_ATTENDED = /cancel|did-not-attend|dna|reject|declin|reschedul|wait|pending/;
  const KNOWN_ATTENDED = /^(booked|confirmed|arrived|attended|check-response)$/;

  const store = {
    get(k, d) { try { const v = localStorage.getItem(KEY + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
  };
  // Save one result. Read and written in one step, so several Halaxy tabs checking at the
  // same time can't overwrite each other's results.
  function saveResult(id, value) {
    const all = store.get('results', {});
    all[id] = value;
    store.set('results', all);
  }
  const group = () => (location.pathname.match(/\/a\/pr\/(\d+)\//) || [])[1];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Who sees it (Carl, 11 Nov 2026: "just show health check on my account"). The checks and error
  // collection still run for everyone: results stay on this PC, so they show when Carl signs in here.
  const SHOW_TO = ['Carl Healy'];
  function signedInAs() {
    try {
      const h = window.HkUser || {};
      const named = String(h.pracName || (h.CalendarDefault || {}).pracName || '').trim();
      if (named) return named;
    } catch (e) { /* fall back to the account menu */ }
    const btn = document.getElementById('activeUser');
    return btn ? btn.textContent.replace(/\s+/g, ' ').trim() : '';
  }
  function shown() {
    const who = signedInAs().toLowerCase();
    if (!who) return true;   // the sign-in can't be read: Halaxy may have changed, so show rather than hide
    return SHOW_TO.some((n) => who.includes(n.toLowerCase()));
  }
  const when = (t) => (t ? new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never');

  // ------------------------------------------------------------------ script errors (listen from the start)

  function recordError(file, message) {
    const now = Date.now();
    const list = store.get('errors', []).filter((e) => now - e.at < ERRORS_KEEP_HOURS * 3600e3);
    const msg = String(message || 'unknown error').slice(0, 200);
    const same = list.find((e) => e.file === file && e.message === msg);
    if (same) { same.count++; same.at = now; } else list.push({ file, message: msg, at: now, count: 1 });
    store.set('errors', list.slice(-20));
    render();
  }
  window.addEventListener('error', (e) => {
    const where = String(e.filename || '') + ' ' + String(e.error && e.error.stack || '');
    const m = where.match(/upc-scripts\/([\w.-]+\.user\.js)/);
    if (m) recordError(m[1], e.message);
  }, true);
  document.addEventListener('upc-loader-error', (e) => {
    try { const d = JSON.parse(e.detail); recordError(d.file, d.message); } catch (x) { /* ignore */ }
  });

  // ------------------------------------------------------------------ helpers for checks

  function lookup(path) {
    let o = window;
    for (const k of path.split('.')) {
      if (o === null || o === undefined) return undefined;
      try { o = o[k]; } catch (e) { return undefined; }
    }
    return o;
  }
  // 'a.b.c' must exist; 'a.b.c()' must be a function.
  const missingIn = (paths) => paths.filter((p) => {
    const fn = p.endsWith('()');
    const v = lookup(fn ? p.slice(0, -2) : p);
    return fn ? typeof v !== 'function' : (v === undefined || v === null);
  });
  const missingEls = (sels) => sels.filter((s) => !document.querySelector(s)).map((s) => 'page element ' + s);

  async function waitFor(test, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if (test()) return true; } catch (e) { /* not ready */ }
      await sleep(250);
    }
    return false;
  }

  // ------------------------------------------------------------------ page checks

  const onCalendar = () => /\/calendar\/?$/.test(location.pathname);
  const PAGE_CHECKS = [
    {
      id: 'core', title: "Halaxy's page basics",
      scripts: ['Outstanding Actions', 'Calendar controls', 'Custom Reports', 'Rebate Sync'],
      applies: () => !!group(),
      test: () => missingIn(['jQuery()', 'HkUser.linkPrG', 'HkUser.pracID', 'hk_glob.preferences']),
    },
    {
      id: 'layout', title: "Halaxy's page layout",
      scripts: ['Toast alerts', 'Custom Reports', 'Alerts', 'Branding', 'Script settings'],
      applies: onCalendar,
      test: () => missingEls(['#alerts', '#mainMenu', '#footer', '#btn-chat-popover-open', '#practitioner-select .dropdown-menu'])
        .concat(document.body && document.body.classList.contains('vs-theme') ? [] : ['theme classes on the page (vs-theme)']),
    },
    {
      id: 'calendar', title: "Halaxy's calendar code",
      scripts: ['Calendar controls'],
      applies: onCalendar,
      ready: () => window.HkCalendar && window.HkCalendar.calendarModel && document.querySelector('.cal .timeLabel'),
      test: () => missingIn([
        'HkCalendar.initForPrac()', 'HkCalendar.calendarModel.get()', 'HkCalendar.PathForEventJSON', 'HkCalendar.PathForNewEvent',
        'HkCalendar.PathForNewAppointment', 'HkCalendar.preferences', 'HkCalendar.timeslotHeights', 'HkCalendar.Timeline.position()',
        'HkCalendar.Timeline.tick()', 'HkCalendar.Toolbar.zoomIn()', 'HkCalendar.Toolbar.zoomOut()', 'HkCalendar.updateSingleEvent()',
        'HkCalendar.Grid.getCalendarData()', 'HkCalendar.getEventUrlQueryParams()', 'HkCalendar.tEvent()', 'HkCalendar.eventsView.render()', 'HkCalendar.RenderPrac.toggleMultiPrac()',
        'HkCalendar.RenderPrac.renderMultiPracCalendar()', 'HkCalendar.Render.resizeCalendar()', 'HkCalendar.calMenu.refresh()',
        'HealthKit.swapPrac()', 'HealthKit.getThemeFontSize()', 'CalendarSettingsPrac.setModePracts()', 'CalendarSettingsPrac.savePracState()',
        'jQuery.ui.intersect()', 'jQuery.hkTypes.Date()', 'HkUtils.appendURL()', 'HkUI.flash.show()',
      ]),
    },
    {
      id: 'calendar-page', title: 'Calendar page layout',
      scripts: ['Calendar controls'],
      applies: onCalendar,
      ready: () => document.querySelector('.cal .timeLabel'),
      test: () => missingEls(['#tpl-event', '#btnCalendarPreferences', '#calToolbar', '#calendarViewPort', '#swapPracList .toggle-prac', '.cal .timeLabel', '.cal .timeslot[ts]']),
    },
    {
      id: 'invoice-page', title: 'Invoice page layout',
      scripts: ['Rebate Sync', 'Remittances', 'Bill funder'],
      // An invoice: /invoice/{id} or /patient/invoice/{patient}/{id}. Not /patient/invoice/{patient}/, the patient's Invoices tab (a list).
      applies: () => /\/invoice\/\d+\/?$/.test(location.pathname) && !/\/patient\/invoice\/\d+\/?$/.test(location.pathname) || /\/patient\/invoice\/\d+\/\d+\/?$/.test(location.pathname),
      test: () => missingEls(['#invoiceLines', '#invoicePayments'])
        // Bill funder reads the patient, claim and authorisation from patient invoices that can still be billed.
        .concat(document.getElementById('invoiceFunderBtn') ? missingEls(['#card-invoice-view-patient a[href*="/patient/"]', '#card-invoice-parts-claim-view', '#btn-group-outstanding-charges']) : []),
    },
    {
      id: 'reports', title: "Halaxy's table builder",
      scripts: ['Custom Reports'],
      // Only the Finance report page, where Custom Reports opens: other report pages (such as the form
      // at /report/appointment/new) don't load the table builder (false alarm, 9 Nov 2026).
      applies: () => /\/report\/finance(\/|$)/.test(location.pathname),
      test: () => missingIn(['HxGridTable()', 'Hk.jwt']),
    },
    {
      id: 'editor', title: "Halaxy's text editor",
      scripts: ['HTML source for emails', 'Auto-expanding text boxes'],
      applies: () => !!document.querySelector('.ck-editor__editable'),
      test: () => {
        const ed = document.querySelector('.ck-editor__editable').ckeditorInstance;
        return ed && ed.data && typeof ed.data.get === 'function' && ed.ui && ed.ui.view ? [] : ['editor instance on .ck-editor__editable'];
      },
    },
  ];

  async function runPageChecks() {
    for (const c of PAGE_CHECKS) {
      let applies = false;
      try { applies = c.applies(); } catch (e) { /* treat as not applicable */ }
      if (!applies) continue;
      if (c.ready) await waitFor(c.ready, 20000);
      let problems;
      try { problems = c.test(); } catch (e) { problems = ['check failed: ' + e.message]; }
      saveResult(c.id, { title: c.title, scripts: c.scripts, problems, at: Date.now(), page: location.pathname.replace(/\d+/g, ':n') });
      render();
    }
  }

  // ------------------------------------------------------------------ data checks (daily)

  async function getJSON(path) {
    const res = await fetch('/a/pr/' + group() + path, { credentials: 'same-origin', headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' } });
    const text = await res.text();
    if (!res.ok) throw new Error('Halaxy returned ' + res.status + ' for ' + path.split('?')[0]);
    try { return JSON.parse(text); } catch (e) { throw new Error('not JSON from ' + path.split('?')[0] + ' (signed out?)'); }
  }
  const keysMissing = (rows, keys) => keys.filter((k) => !rows.some((r) => r && Object.prototype.hasOwnProperty.call(r, k)));

  async function runDataChecks() {
    if (!group()) return;
    store.set('dataAt', Date.now());   // claim it, so other tabs don't run it too
    const put = (id, title, scripts, problems, info) => {
      saveResult(id, { title, scripts, problems, info: info || '', at: Date.now(), page: 'data' });
    };
    const OA = ['Outstanding Actions'];

    let pracs = [];
    try {
      pracs = await getJSON('/lookup/practitioner?clinic=&include_id=&type=');
      const ok = Array.isArray(pracs) && pracs.length;
      put('data-practitioners', 'Practitioner list', OA, ok ? keysMissing(pracs, ['id', 'name']).map((k) => 'field ' + k) : ['no practitioners returned']);
      if (!ok) pracs = [];
    } catch (e) { put('data-practitioners', 'Practitioner list', OA, [e.message]); }

    try {
      const fees = await getJSON('/funder/fee/data');
      const ok = Array.isArray(fees) && fees.length;
      put('data-fees', 'Fee list', OA, ok ? keysMissing(fees, ['feeColour', 'funder', 'status']).map((k) => 'field ' + k) : ['no fees returned']);
    } catch (e) { put('data-fees', 'Fee list', OA, [e.message]); }

    let appts = [];
    try {
      const now = Math.floor(Date.now() / 1000);
      const qs = new URLSearchParams({ start: now - 7 * 86400, end: now + 7 * 86400 });
      pracs.forEach((p, i) => qs.append('practitioners[' + i + '][id]', p.id));
      const cal = await getJSON('/calendar/json?' + qs.toString());
      const events = cal && cal.payload && cal.payload.events;
      if (!Array.isArray(events)) {
        put('data-calendar', 'Calendar data', OA.concat(['Calendar controls']), ['payload.events missing']);
      } else {
        appts = events.filter((e) => !e.type || e.type === 'appointment');
        if (!appts.length) {
          put('data-calendar', 'Calendar data', OA, [], 'No appointments in the last or next week, so fields could not be checked.');
        } else {
          const problems = keysMissing(appts, ['start', 'end', 'linkPaGId', 'practitionerID', 'invoiceID', 'noteID', 'colour',
            'appointmentStatus', 'noteStatusCss', 'invoiceStatus', 'invStatusCss', 'isRequest', 'isGroupAppointment', 'title']).map((k) => 'field ' + k);
          if (appts.some((e) => typeof e.start !== 'number' || e.start > 1e11)) problems.push('start is no longer Unix seconds');
          const statuses = new Set(appts.map((e) => String(e.appointmentStatus || '').toLowerCase()).filter(Boolean));
          // Halaxy statuses we know and treat as attended once finished. "check-response" first seen on live
          // data 9 Nov 2026; Halaxy's help ties it to text reminder replies, but the clinic sends no texts,
          // so what sets it is not yet known.
          const unknownStatus = [...statuses].filter((s) => !NOT_ATTENDED.test(s) && !KNOWN_ATTENDED.test(s));
          unknownStatus.forEach((s) => {
            const ex = appts.find((e) => String(e.appointmentStatus || '').toLowerCase() === s);
            const when = ex && typeof ex.start === 'number' ? new Date(ex.start * 1000) : null;
            const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            const label = when ? ' (for example the appointment at ' + String(when.getHours()).padStart(2, '0') + ':' + String(when.getMinutes()).padStart(2, '0') + ' on ' +
              String(when.getDate()).padStart(2, '0') + '-' + MON[when.getMonth()] + '-' + when.getFullYear() + ')' : '';
            problems.push('new appointment status "' + s + '"' + label + ': Outstanding Actions treats it as attended');
          });
          const notes = new Set(appts.map((e) => String(e.noteStatusCss || '')).filter(Boolean));
          [...notes].filter((s) => !/(empty|draft|published|locked)-clinical-note/.test(s))
            .forEach((s) => problems.push('new note status "' + s + '": Outstanding Actions will look it up note by note'));
          put('data-calendar', 'Calendar data', OA, problems, appts.length + ' appointments checked. Statuses seen: ' + ([...statuses].join(', ') || 'none') + '.');
        }
      }
    } catch (e) { put('data-calendar', 'Calendar data', OA, [e.message]); }

    const withPatient = appts.find((e) => e.linkPaGId);
    if (withPatient) {
      try {
        const rows = await getJSON('/patient/invoice/' + encodeURIComponent(withPatient.linkPaGId) + '/list-data');
        const list = Array.isArray(rows) ? rows : (rows && (rows.rows || rows.data));
        if (!Array.isArray(list)) put('data-invoices', 'Patient invoice list', OA, ['not a list']);
        else put('data-invoices', 'Patient invoice list', OA, list.length ? keysMissing(list, ['id', 'total', 'balance', 'status']).map((k) => 'field ' + k) : []);
      } catch (e) { put('data-invoices', 'Patient invoice list', OA, [e.message]); }
    }

    // Appointment details pop-up: Bill funder reads cancellation comments from its "Notes" box.
    if (appts.length) {
      try {
        const res = await fetch('/a/pr/' + group() + '/appointment/' + encodeURIComponent(appts[0].id), { credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
        if (!res.ok) throw new Error('Halaxy returned ' + res.status + ' for /appointment');
        const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
        const box = doc.querySelector('.appointment-details-popup');
        put('data-appointment-details', 'Appointment details pop-up', ['Bill funder'], box ? [] : ['details layout missing (div.appointment-details-popup)']);
      } catch (e) { put('data-appointment-details', 'Appointment details pop-up', ['Bill funder'], [e.message]); }
    }

    // Add-task pop-up for an invoice: Remittances adds a task to bill the patient's excess. Opening it adds nothing.
    const forTask = appts.find((e) => e.invoiceID);
    if (forTask) {
      try {
        const res = await getJSON('/task/new/invoice/' + encodeURIComponent(forTask.invoiceID) + '?clicked=' + Date.now());
        const doc = new DOMParser().parseFromString(String((res && res.message) || ''), 'text/html');
        const form = doc.querySelector('form#form_task_edit');
        const need = ['form[title]', 'form[linkPrGs][]', 'form[priority]', 'form[displayDueDate]', 'form[comment]', 'form[_token]'];
        const problems = !form ? ['add-task form missing'] : need.filter((k) => !form.querySelector('[name="' + k + '"]')).map((k) => 'field ' + k + ' missing');
        if (form && ![...form.querySelectorAll('select[name="form[linkPrGs][]"] option')].some((o) => /carl healy/i.test(o.textContent))) problems.push('Carl Healy is not in the Assign to list');
        put('data-task-form', 'Add-task pop-up', ['Remittances', 'Task stamps', 'Portal fill'], problems);
      } catch (e) { put('data-task-form', 'Add-task pop-up', ['Remittances', 'Task stamps', 'Portal fill'], [e.message]); }
    }

    // Follow-ups list: Review requests reads who has already had a Review Request.
    try {
      const fu = await getJSON('/task/task-followup/list/data');
      put('data-followups', 'Follow-ups list', ['Review requests'], !Array.isArray(fu) ? ['not a list'] : fu.length ? keysMissing(fu, ['title', 'status', 'assignedToUrl']).map((k) => 'field ' + k) : []);
    } catch (e) { put('data-followups', 'Follow-ups list', ['Review requests'], [e.message]); }

    // Survey responses: Feedback alerts and Review requests read the list and each response's score.
    const FB = ['Feedback alerts', 'Review requests'];
    try {
      const list = await getJSON('/report/survey/feedback-data');
      if (!Array.isArray(list)) put('data-surveys', 'Survey responses list', FB, ['not a list']);
      else {
        const problems = list.length ? keysMissing(list, ['id', 'template', 'patientName', 'answeredDate']).map((k) => 'field ' + k) : [];
        const newest = list.slice().sort((a, b) => b.id - a.id)[0];
        if (newest) {
          const v = await getJSON('/report/survey/view/' + encodeURIComponent(newest.id));
          const doc = new DOMParser().parseFromString(String((v && v.message) || ''), 'text/html');
          if (!doc.querySelector('#note_total_score')) problems.push('a response no longer shows its total (span#note_total_score)');
          if (!doc.querySelector('.score-level-name')) problems.push('a response no longer shows its level (span.score-level-name)');
          if (!doc.querySelector('.answerName')) problems.push('a response no longer shows its questions (span.answerName)');
        }
        put('data-surveys', 'Survey responses', FB, problems);
      }
    } catch (e) { put('data-surveys', 'Survey responses', FB, [e.message]); }
    // Patient search (Feedback alerts finds the patient by name) and a patient's tasks (where it adds them).
    try {
      const q = new URLSearchParams({ includeContacts: '1', term: 'zzqx' });
      q.set('_locale', String(group()));   // the practice number from the page address, as the search box sends it
      const res = await fetch('/a/magic/lookup/patient?' + q.toString(), { credentials: 'same-origin', headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' } });
      const j = res.ok ? await res.json().catch(() => null) : null;
      put('data-patient-search', 'Patient search', ['Feedback alerts'], j && Array.isArray(j.lookup) ? [] : ['the search no longer answers with a lookup list' + (res.ok ? '' : ' (' + res.status + ')')]);
    } catch (e) { put('data-patient-search', 'Patient search', ['Feedback alerts'], [e.message]); }
    if (withPatient) {
      try {
        const res = await getJSON('/task/new/linkPaG/' + encodeURIComponent(withPatient.linkPaGId) + '?clicked=' + Date.now());
        const doc = new DOMParser().parseFromString(String((res && res.message) || ''), 'text/html');
        const form = doc.querySelector('form#form_task_edit');
        const need = ['form[title]', 'form[linkPrGs][]', 'form[priority]', 'form[displayDueDate]', 'form[comment]', 'form[_token]'];
        const problems = !form ? ['add-task form missing'] : need.filter((k) => !form.querySelector('[name="' + k + '"]')).map((k) => 'field ' + k + ' missing');
        const list = await getJSON('/task/linkPaG/' + encodeURIComponent(withPatient.linkPaGId) + '/list-data');
        if (!Array.isArray(list)) problems.push('the patient\'s task list is not a list');
        else if (list.length) keysMissing(list, ['title', 'comment', 'status']).forEach((k) => problems.push('task list field ' + k));
        put('data-patient-tasks', 'Patient tasks', ['Feedback alerts'], problems);
      } catch (e) { put('data-patient-tasks', 'Patient tasks', ['Feedback alerts'], [e.message]); }
      // The patient's Edit page (read only): Portal fill takes the legal name, address and postcode from it.
      try {
        const res = await fetch('/a/pr/' + group() + '/patient/' + encodeURIComponent(withPatient.linkPaGId) + '/edit', { credentials: 'same-origin' });
        if (!res.ok) throw new Error('Halaxy returned ' + res.status + ' for the patient Edit page');
        const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
        const need = ['firstline', 'postcode'].map((k) => 'patientdetailmain[linkPaG][linkpagaddresses][0][address][' + k + ']')
          .concat(['forename', 'surname'].map((k) => 'patientdetailmain[name][' + k + ']'));
        put('data-patient-edit', 'Patient Edit page', ['Portal fill', 'Review requests'], need.filter((n) => !doc.querySelector('[name="' + n + '"]')).map((n) => 'field ' + n + ' missing'));
      } catch (e) { put('data-patient-edit', 'Patient Edit page', ['Portal fill', 'Review requests'], [e.message]); }
    }

    // Invoice settings (cogwheel): Bill funder reads and sets the status here.
    const withInvoice = appts.find((e) => e.invoiceID);
    if (withInvoice) {
      try {
        const res = await getJSON('/invoice/options/' + encodeURIComponent(withInvoice.invoiceID));
        const doc = new DOMParser().parseFromString(String((res && res.message) || ''), 'text/html');
        const form = doc.querySelector('form#frmInvoiceType');
        const sel = form && form.querySelector('select[name="form[status]"]');
        const values = sel ? [...sel.options].map((o) => o.value) : [];
        const problems = !form ? ['settings form missing'] : []
          .concat(sel ? [] : ['status list missing'])
          .concat(sel && !values.includes('issued') ? ['no Issued status'] : [])
          .concat(sel && !values.includes('') ? ['no Active status'] : [])
          .concat(form.querySelector('[name="form[_token]"]') ? [] : ['form token missing']);
        put('data-invoice-settings', 'Invoice settings (cogwheel)', ['Bill funder'], problems);
      } catch (e) { put('data-invoice-settings', 'Invoice settings (cogwheel)', ['Bill funder'], [e.message]); }
    }
  }

  // ------------------------------------------------------------------ Halaxy version

  function halaxyVersion() {
    for (const s of document.querySelectorAll('script[src], link[href]')) {
      const m = String(s.src || s.href).match(/\/z\/version\/([^/]+)\/build\//);
      if (m) return m[1];
    }
    const b = lookup('hk_glob.variables.bundle');
    return b ? String(b) : null;
  }

  // Returns true when Halaxy has changed version since this PC last looked.
  function noteVersion() {
    const v = halaxyVersion();
    if (!v) return false;
    const known = store.get('halaxy', null);
    if (!known) { store.set('halaxy', { version: v, since: Date.now() }); return false; }
    if (known.version === v) return false;
    store.set('halaxy', { version: v, since: Date.now(), previous: known.version });
    return true;
  }

  // ------------------------------------------------------------------ problems

  function loaderProblems() {
    let ch = 'stable';
    try { ch = JSON.parse(localStorage.getItem('upc-loader:channel')) === 'beta' ? 'beta' : 'stable'; } catch (e) { /* default */ }
    try { return JSON.parse(localStorage.getItem('upc-loader:lastProblems:' + ch)) || []; } catch (e) { return []; }
  }

  function problems() {
    const out = [];
    const results = store.get('results', {});
    Object.keys(results).forEach((id) => {
      const r = results[id];
      if (r.problems && r.problems.length) out.push({ title: r.title + ' has changed', scripts: r.scripts, lines: r.problems, at: r.at });
    });
    const now = Date.now();
    store.get('errors', []).filter((e) => now - e.at < ERRORS_KEEP_HOURS * 3600e3).forEach((e) => {
      out.push({ title: (NAMES[e.file] || e.file) + ' stopped with an error', scripts: [NAMES[e.file] || e.file],
        lines: [e.message + (e.count > 1 ? ' (' + e.count + ' times)' : '')], at: e.at, error: true });
    });
    const lp = loaderProblems();
    if (lp.length) out.push({ title: 'Updates could not be fetched', scripts: ['All scripts (they keep running from saved copies)'], lines: lp, at: null });
    return out;
  }

  // ------------------------------------------------------------------ notice and panel

  let host = null;
  let sh = null;
  let open = false;

  function ensureHost() {
    if (host || !document.body) return !!host;
    // In the page with Halaxy's own classes, so it looks like Halaxy. It does not rely on the core
    // library (it loads first, to catch every script's errors), so it adds its own scoped rules.
    if (!document.getElementById('upc-hc-css')) {
      const st = document.createElement('style');
      st.id = 'upc-hc-css';
      st.textContent = CSS;
      (document.head || document.documentElement).appendChild(st);
    }
    host = document.createElement('div');
    host.className = 'upc-native upc-hc';
    host.setAttribute('data-hx-health', '');
    sh = host;
    document.body.appendChild(host);
    sh.addEventListener('click', onClick);
    return true;
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const CSS = `
    /* Bottom centre of the content area, just above Outstanding Actions' notice: clear of Halaxy's side
       panels (patient notes list, patient side panel). While its panel is open it comes to the front,
       still below Halaxy's own pop-ups (3000). */
    .upc-hc .upc-hc-wrap { position: fixed; left: var(--hx-health-centre, 50%); transform: translateX(-50%); bottom: 48px; z-index: 90; }
    .upc-hc .upc-hc-wrap.upc-hc-open { z-index: 2980; }
    /* White backing behind Halaxy's red button, which is unfilled on hover, so the page never shows through. */
    .upc-hc .upc-hc-back { display: inline-flex; background: #fff; border-radius: 4.8px; box-shadow: 0 4px 14px rgba(0,0,0,.25); }
    .upc-hc .upc-hc-back > .btn { margin: 0; }
    .upc-hc .upc-hc-panel { position: absolute; left: 50%; transform: translateX(-50%); bottom: 40px; width: min(440px, calc(100vw - 32px)); max-height: 70vh; overflow: auto; margin: 0;
      box-shadow: 0 8px 16px rgba(0,0,0,.2); }
    .upc-hc .card-header h2 { margin: 0; }
    .upc-hc .upc-hc-item { border-top: 1px solid var(--vs-card-border-color, #ced4da); padding: 8px 0; }
    .upc-hc .upc-hc-item:first-child { border-top: 0; padding-top: 0; }
    .upc-hc ul { margin: 4px 0 0; padding-left: 18px; }
    .upc-hc .upc-hc-ok { color: var(--success, #28a745); font-weight: 600; }
    .upc-hc .upc-hc-btns { display: flex; flex-wrap: wrap; gap: 4.8px; margin-top: 10px; }
    .upc-hc .upc-hc-btns .btn { margin: 0; }
  `;

  // Centre on the content area, between Halaxy's side menu and the right edge.
  function sidebarRight() {
    const menu = document.getElementById('mainMenu');
    if (!menu) return 0;
    let right = 0;
    for (let el = menu; el && el !== document.body; el = el.parentElement) {
      const r = el.getBoundingClientRect();
      if (r.width && r.left <= 1 && r.width < window.innerWidth / 2) right = Math.max(right, r.right);
    }
    return right;
  }
  function place() {
    if (host) host.style.setProperty('--hx-health-centre', Math.round((sidebarRight() + window.innerWidth) / 2) + 'px');
  }
  window.addEventListener('resize', place);
  let watchedMenu = null;
  function watchMenu() {
    const menu = document.getElementById('mainMenu');
    if (!menu || menu === watchedMenu || typeof ResizeObserver !== 'function') return;
    watchedMenu = menu;
    new ResizeObserver(place).observe(menu.parentElement || menu);   // menu collapsed or expanded
  }

  function render() {
    if (!ensureHost()) return;
    if (!shown()) { open = false; sh.innerHTML = ''; return; }
    watchMenu();
    place();
    const list = problems();
    const halaxy = store.get('halaxy', null);
    if (!list.length && !open) { sh.innerHTML = ''; return; }
    let html = '<div class="upc-hc-wrap' + (open ? ' upc-hc-open' : '') + '">';
    if (open) {
      html += '<div class="card upc-hc-panel" role="dialog" aria-label="Clinic scripts health check"><div class="card-header"><h2>Clinic scripts health check</h2></div><div class="card-body">';
      if (!list.length) html += '<p class="upc-hc-ok">All checks passed.</p>';
      list.forEach((p) => {
        html += '<div class="upc-hc-item"><b>' + esc(p.title) + '</b>' +
          '<div class="text-muted">Affects: ' + esc(p.scripts.join(', ')) + (p.at ? '. Seen ' + esc(when(p.at)) : '') + '</div>' +
          '<ul>' + p.lines.map((l) => '<li>' + esc(l) + '</li>').join('') + '</ul></div>';
      });
      if (list.length) html += '<p class="text-muted">The scripts may not work properly until this is fixed. Copy the details and send them to Claude.</p>';
      const info = Object.values(store.get('results', {})).filter((r) => r.info).map((r) => r.title + ': ' + r.info);
      html += '<p class="text-muted">Halaxy version ' + esc(halaxy ? halaxy.version : 'unknown') +
        (halaxy && halaxy.previous ? ' (updated from ' + esc(halaxy.previous) + ' on ' + esc(when(halaxy.since)) + ')' : '') +
        '. Last data check: ' + esc(when(store.get('dataAt', 0))) + '.' + (info.length ? '<br>' + info.map(esc).join('<br>') : '') + '</p>';
      const B = '<button type="button" class="btn btn-outline-primary-light" data-act=';
      html += '<div class="upc-hc-btns">' + B + '"run">Check again</button>' + B + '"copy">Copy details</button>' +
        (list.some((p) => p.error) ? B + '"clear">Clear script errors</button>' : '') +
        B + '"close">Close</button></div></div></div>';
    }
    if (list.length) html += '<span class="upc-hc-back"><button type="button" class="btn btn-danger upc-hc-pill" data-act="toggle">Clinic scripts: ' + list.length + (list.length === 1 ? ' problem' : ' problems') + '</button></span>';
    sh.innerHTML = html + '</div>';
  }

  function details() {
    const halaxy = store.get('halaxy', null);
    return JSON.stringify({
      healthCheck: VERSION, at: new Date().toISOString(), halaxy,
      loaderChannel: (() => { try { return JSON.parse(localStorage.getItem('upc-loader:channel')) || 'stable'; } catch (e) { return 'stable'; } })(),
      problems: problems(), results: store.get('results', {}), lastDataCheck: store.get('dataAt', 0),
    }, null, 1);
  }

  async function onClick(e) {
    const el = e.target.closest && e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'toggle') { open = !open; render(); }
    else if (act === 'close') { open = false; render(); }
    else if (act === 'clear') { store.set('errors', []); render(); }
    else if (act === 'copy') {
      const text = details();
      try { await navigator.clipboard.writeText(text); el.textContent = 'Copied'; } catch (x) { console.log(text); el.textContent = 'Copied to console'; }
    } else if (act === 'run') {
      el.textContent = 'Checking...';
      el.disabled = true;
      await runAll(true);
    }
  }

  // ------------------------------------------------------------------ start

  let runningAll = null;
  function runAll(forceData) {
    if (runningAll) return runningAll;
    runningAll = (async () => {
      const changed = noteVersion();
      // A new version of this health check starts from a clean slate: the previous version's results
      // (some from checks it no longer makes, or makes on other pages) would otherwise linger until
      // their page is visited again. Page checks re-run as pages are opened; data checks re-run below.
      if (store.get('resultsBy', '') !== VERSION) {
        store.set('results', {});
        store.set('resultsBy', VERSION);
      }
      await runPageChecks();
      const due = Date.now() - store.get('dataAt', 0) > DATA_EVERY_HOURS * 3600e3;
      // A new version of this health check may judge Halaxy's data differently, so it re-checks
      // straight away instead of showing the previous version's results until the next daily check.
      const updated = store.get('dataBy', '') !== VERSION;
      if (forceData || changed || due || updated) {
        store.set('dataBy', VERSION);
        try {
          await runDataChecks();
          saveResult('data-run', { title: 'The data check', scripts: ['Health check'], problems: [], at: Date.now(), page: 'data' });
        } catch (e) {
          console.warn('[UPC health]', e);
          saveResult('data-run', { title: 'The data check', scripts: ['Health check'], problems: ['stopped: ' + e.message], at: Date.now(), page: 'data' });
        }
      }
      render();
      runningAll = null;
    })();
    return runningAll;
  }

  // Added once the page shows who is signed in, and only for them (Script settings lists it).
  let menuAdded = false;
  function addMenu() {
    if (menuAdded || typeof GM_registerMenuCommand !== 'function' || !shown()) return;
    menuAdded = true;
    GM_registerMenuCommand('Health check: show results', () => { open = true; render(); });
  }

  const start = () => setTimeout(() => runAll(false), (window.__hxHealthTest && window.__hxHealthTest.delay) || 3000);
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
  const ready = () => { render(); addMenu(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true });
  else ready();

  window.hxHealth = {
    version: VERSION,
    run: (forceData) => runAll(forceData !== false),
    problems,
    open: () => { open = true; render(); },
  };
})();
