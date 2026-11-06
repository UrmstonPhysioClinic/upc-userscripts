// ==UserScript==
// @name         Halaxy health check (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      1.0.2
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/health-check.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/health-check.user.js
// @description  Checks that what the clinic's scripts rely on in Halaxy is still there, notices Halaxy updates, and collects script errors. Shows a small notice only when something needs looking at. Read-only.
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

  const VERSION = '1.0.2';
  const KEY = 'upc-health:';
  const DATA_EVERY_HOURS = 24;
  const ERRORS_KEEP_HOURS = 24;

  const NAMES = {
    'alerts.user.js': 'Alerts', 'arrival-chime.user.js': 'Arrival chime', 'chat-alert.user.js': 'Chat alert',
    'branding.user.js': 'Branding', 'calendar-controls.user.js': 'Calendar controls', 'custom-reports.user.js': 'Custom Reports',
    'email-html-source.user.js': 'HTML source for emails', 'health-check.user.js': 'Health check',
    'outstanding-actions.user.js': 'Outstanding Actions', 'rebate-sync.user.js': 'Rebate Sync',
    'textarea-autogrow.user.js': 'Auto-expanding text boxes', 'toast-alerts.user.js': 'Toast alerts',
  };
  // Same rule as Outstanding Actions: these appointment statuses mean "not attended".
  const NOT_ATTENDED = /cancel|did-not-attend|dna|reject|declin|reschedul|wait|pending/;

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
      scripts: ['Toast alerts', 'Custom Reports', 'Alerts', 'Branding'],
      applies: onCalendar,
      test: () => missingEls(['#alerts', '#mainMenu', '#footer', '#btn-chat-popover-open'])
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
        'HkCalendar.Grid.getCalendarData()', 'HkCalendar.getEventUrlQueryParams()', 'HkCalendar.RenderPrac.toggleMultiPrac()',
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
      scripts: ['Rebate Sync'],
      applies: () => /\/invoice\/(\d+\/)?\d+\/?$/.test(location.pathname),
      test: () => missingEls(['#invoiceLines', '#invoicePayments']),
    },
    {
      id: 'reports', title: "Halaxy's table builder",
      scripts: ['Custom Reports'],
      applies: () => /\/report\//.test(location.pathname),
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
            'appointmentStatus', 'noteStatusCss', 'invoiceStatus', 'isRequest', 'isGroupAppointment', 'title']).map((k) => 'field ' + k);
          if (appts.some((e) => typeof e.start !== 'number' || e.start > 1e11)) problems.push('start is no longer Unix seconds');
          const statuses = new Set(appts.map((e) => String(e.appointmentStatus || '').toLowerCase()).filter(Boolean));
          const unknownStatus = [...statuses].filter((s) => !NOT_ATTENDED.test(s));
          unknownStatus.forEach((s) => problems.push('new appointment status "' + s + '": Outstanding Actions treats it as attended'));
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
    host = document.createElement('div');
    host.setAttribute('data-hx-health', '');
    sh = host.attachShadow({ mode: 'open' });
    document.body.appendChild(host);
    sh.addEventListener('click', onClick);
    return true;
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const CSS = `
    .wrap { position: fixed; left: var(--hx-health-left, 16px); bottom: 16px; z-index: 90; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Arial, sans-serif; color: #1d2433; }
    .pill { border: 0; border-radius: 999px; padding: 6px 12px; background: #b45309; color: #fff; font: inherit; font-weight: 600; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.2); }
    .panel { position: absolute; left: 0; bottom: 40px; width: min(440px, calc(100vw - 32px)); max-height: 70vh; overflow: auto; background: #fff;
             border-radius: 8px; box-shadow: 0 8px 30px rgba(0,0,0,.25); padding: 12px 14px; }
    h3 { margin: 0 0 8px; font-size: 14px; }
    .item { border-top: 1px solid #eee; padding: 8px 0; }
    .item:first-of-type { border-top: 0; }
    .t { font-weight: 600; }
    .aff, .muted { color: #5b6478; font-size: 12px; }
    ul { margin: 4px 0 0; padding-left: 18px; }
    .ok { color: #1e7a3c; font-weight: 600; }
    .btns { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    button.b { font: inherit; font-size: 12px; border-radius: 6px; padding: 4px 10px; border: 1px solid #c9cfdc; background: #fff; color: #1d2433; cursor: pointer; }
  `;

  // Sit just to the right of Halaxy's side menu, which is drawn above our layer.
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
    if (host) host.style.setProperty('--hx-health-left', Math.round(sidebarRight() + 16) + 'px');
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
    watchMenu();
    place();
    const list = problems();
    const halaxy = store.get('halaxy', null);
    if (!list.length && !open) { sh.innerHTML = ''; return; }
    let html = '<style>' + CSS + '</style><div class="wrap">';
    if (open) {
      html += '<div class="panel" role="dialog" aria-label="Clinic scripts health check"><h3>Clinic scripts health check</h3>';
      if (!list.length) html += '<p class="ok">All checks passed.</p>';
      list.forEach((p) => {
        html += '<div class="item"><div class="t">' + esc(p.title) + '</div>' +
          '<div class="aff">Affects: ' + esc(p.scripts.join(', ')) + (p.at ? '. Seen ' + esc(when(p.at)) : '') + '</div>' +
          '<ul>' + p.lines.map((l) => '<li>' + esc(l) + '</li>').join('') + '</ul></div>';
      });
      if (list.length) html += '<p class="muted">The scripts may not work properly until this is fixed. Copy the details and send them to Claude.</p>';
      const info = Object.values(store.get('results', {})).filter((r) => r.info).map((r) => r.title + ': ' + r.info);
      html += '<p class="muted">Halaxy version ' + esc(halaxy ? halaxy.version : 'unknown') +
        (halaxy && halaxy.previous ? ' (updated from ' + esc(halaxy.previous) + ' on ' + esc(when(halaxy.since)) + ')' : '') +
        '. Last data check: ' + esc(when(store.get('dataAt', 0))) + '.' + (info.length ? '<br>' + info.map(esc).join('<br>') : '') + '</p>';
      html += '<div class="btns"><button class="b" data-act="run">Check again</button><button class="b" data-act="copy">Copy details</button>' +
        (list.some((p) => p.error) ? '<button class="b" data-act="clear">Clear script errors</button>' : '') +
        '<button class="b" data-act="close">Close</button></div></div>';
    }
    if (list.length) html += '<button class="pill" data-act="toggle">Clinic scripts: ' + list.length + (list.length === 1 ? ' problem' : ' problems') + '</button>';
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
      await runPageChecks();
      const due = Date.now() - store.get('dataAt', 0) > DATA_EVERY_HOURS * 3600e3;
      if (forceData || changed || due) {
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

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Health check: show results', () => { open = true; render(); });
  }

  const start = () => setTimeout(() => runAll(false), (window.__hxHealthTest && window.__hxHealthTest.delay) || 3000);
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
  document.addEventListener('DOMContentLoaded', render, { once: true });

  window.hxHealth = {
    version: VERSION,
    run: (forceData) => runAll(forceData !== false),
    problems,
    open: () => { open = true; render(); },
  };
})();
