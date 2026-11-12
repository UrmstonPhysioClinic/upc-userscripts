// ==UserScript==
// @name         UPC Calendar: Calendar controls (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      2.12
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/calendar-controls.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/calendar-controls.user.js
// @description  Clinic default calendar preferences, compact 15-minute zoom, accurate current-time line, and "Just me" / "All practitioners" buttons.
// @match        https://*.halaxy.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const DEFAULT_ZOOM_MINUTES = 15;         // 5, 10, 15, 20, 30, 60, 75 or 90
  // 15-minute zoom shown at half row height, so it looks like the 30-minute view
  // but you can click to book on :15 and :45.
  const COMPACT_15_MINUTE_VIEW = true;
  const NOW_LINE_COLOUR = '#ec6b65';       // Halaxy coral red (Halaxy's default line is blue)
  const SHOW_HOVER_TIME = true;            // time label that follows the cursor over empty time boxes
  const AUTO_REFRESH_SECONDS = (window.__upcCalendarTest && window.__upcCalendarTest.refreshSeconds) || 30;   // check for changes made on other computers (0 = off)
  const ANIMATE_CHANGES = true;            // fade/grow appointments added or removed from elsewhere
  const FIX_DRAG_DROP = true;              // dragged appointments land where their top edge is
  const CURRENCY_SYMBOL = '£';             // replaces Halaxy's "$" invoice icon on appointments ('' = leave as $)
  const ZERO_LOOKS_PAID = true;            // £0 invoices (package follow-ups, cancellations) get the green paid icon, not the black unpaid one
  const RESIZE_PERSONAL = true;            // drag handle on the bottom of personal appointments to change their length
  const DURATION_STEP_MINUTES = 15;        // up/down arrows on the sidebar's Duration box (0 = off)
  const DEFAULT_NEW_DURATION_MINUTES = 30; // starting duration for new appointments (0 = Halaxy's default)
  const DURATION_FROM_FEES = true;         // adding/changing/removing a fee sets the duration to the fees' total
  const TIME_PICKER_24H = true;            // one 00-23 hour box instead of 1-12 + AM/PM on appointment forms
  const EXCLUDE_PROFESSIONS = ['Administrator'];

  // Column order for "All practitioners" (Halaxy practitioner IDs). Anyone not listed
  // follows in the order they joined (Halaxy IDs increase over time).
  const PRACTITIONER_ORDER = [
    313962, // Roxanna Healy
    313953, // Carl Healy
    417802, // Diana Satalova
    477442, // Steve Sharples
  ];

  // Clinic calendar preferences (Calendar > cog icon). Checked on every calendar load and
  // saved to the person's Halaxy account if anything differs. Time zone is left alone.
  const CLINIC_PREFS = {
    calendar_view_time_from: '08:00',      // Start time
    calendar_view_time_to: '21:00',        // End time
    calendar_hide_cancelled: '0',          // Appointment visibility: 0 Show all, 1 Hide cancelled / not-attended
    calendar_show_days: '1',               // Days to show: 0 All, 1 Weekdays only
    calendar_start_week_on: '0',           // Start week on: 0 Sunday, 1 Monday
    calendar_prac_selection: '1',          // 1 Keep my selection when I change view, 0 Separate per view
    show_status_colour: '0',               // Status colour: 1 Show, 0 Hide
    show_note_status: '1',                 // Clinical note status: 1 Show, 0 Hide
    payment_status_label: '0',             // Payment label: 0 Icon, 1 Text
    show_invoice_sent: '1',                // Invoice send status: 1 Show, 0 Hide
    show_appointment_description: '0',     // Appointment comment: 1 Show, 0 Hide
    show_patient_balance: '1',             // Patient fee balance: 1 Show, 0 Hide
    show_new_patient_icon: '1',            // New patient icon: 1 Show, 0 Hide
    show_patient_age: '0',                 // Patient age: 1 Show, 0 Hide
    show_patient_arrival_icon: '1',        // Patient arrival icon: 1 Show, 0 Hide
    show_patient_name: '0',                // Name format: 0 Full details, 4 + primary contact, 5 First + last, 3 First + initials, 1 Initials, 2 Anonymised
  };
  const TIME_KEYS = ['calendar_view_time_from', 'calendar_view_time_to'];

  // Week view: colour of the line between days (Halaxy's default is light grey #c7c7c7).
  const DAY_DIVIDER_COLOUR = '#8e94ad';

  // ---------- 0. Styles ----------
  const style = document.createElement('style');
  style.textContent = `
    /* Week view with practitioners: mark the start of each day after the first. Colour only,
       not border width, so Halaxy's column width calculations are unaffected. The grid border
       is 2px and the header border 1px, so the header gets an extra 1px inner shadow to match. */
    .cal.multiPractWeekView #grid > .colTab.DrawDel ~ .colTab.DrawDel {
      border-left-color: ${DAY_DIVIDER_COLOUR} !important;
      border-left-style: solid !important;
    }
    .cal.multiPractWeekView .colTab.DrawDel ~ .colTab.DrawDel > .colHead:not(.colDayEvents) {
      border-left-color: ${DAY_DIVIDER_COLOUR} !important;
      border-left-style: solid !important;
      box-shadow: inset 1px 0 0 ${DAY_DIVIDER_COLOUR};
    }
    /* Today's header colours its inner cells, which would cover the shadow above. */
    .cal.multiPractWeekView .colTab.DrawDel ~ .colTab.DrawDel > .colHead > .colHeadDate,
    .cal.multiPractWeekView .colTab.DrawDel ~ .colTab.DrawDel > .colHead .colPract-0 {
      box-shadow: inset 1px 0 0 ${DAY_DIVIDER_COLOUR};
    }

    /* Current-time line */
    .cal .theGrid .timeline {
      background: ${NOW_LINE_COLOUR} !important;
      height: 2px !important;
      margin-top: -1px;
    }

    /* Compact 15-minute view: fixed half-height rows. !important stops Halaxy stretching them
       to fill the screen, because it sizes appointments before it stretches rows, so stretched
       rows leave appointments short. Labels only on :00 and :30, centred on the half hour. */
    .cal.upc-compact .timeslot,
    .cal.upc-compact .timeLabel {
      height: var(--upc-row, 13px) !important;
      line-height: var(--upc-row, 13px);
    }
    .cal.upc-compact .timeLabel:not(.upc-q) {
      line-height: calc(var(--upc-row, 13px) * 2);
      overflow: visible;
      position: relative;
      z-index: 1;
    }
    /* No divider under :00 / :30 labels, so the line doesn't run through the time. */
    .cal.upc-compact .timeLabel:not(.upc-q) { border-bottom-color: transparent !important; }
    .cal.upc-compact .timeLabel.upc-q { color: transparent !important; }
    .cal.upc-compact .timeslot.upc-q { border-top: 1px dotted rgba(0, 0, 0, 0.12) !important; }

    /* Time under the cursor */
    /* Appointments added / removed on another computer */
    @keyframes upc-in  { from { opacity: 0; transform: scale(0.9); } to { opacity: 1; transform: none; } }
    @keyframes upc-out { from { opacity: 1; transform: none; } to { opacity: 0; transform: scale(0.9); } }
    .cal .event.upc-appear { animation: upc-in 350ms ease-out; }
    .cal .event.upc-leave  { animation: upc-out 300ms ease-in forwards; pointer-events: none; }
    @media (prefers-reduced-motion: reduce) {
      .cal .event.upc-appear, .cal .event.upc-leave { animation-duration: 1ms; }
    }

    /* Resize handle on personal appointments */
    .cal .event.personal .upc-resize {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 7px;
      cursor: ns-resize;
      z-index: 25;
    }
    /* White grip with a dark outline and shadow: visible on dark, light and coloured blocks */
    .cal .event.personal .upc-resize::after {
      content: '';
      position: absolute;
      left: 50%;
      bottom: 2px;
      width: 32px;
      height: 5px;
      margin-left: -16px;
      border-radius: 3px;
      background: #fff;
      border: 1px solid rgba(0, 0, 0, 0.45);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
      box-sizing: border-box;
      opacity: 0;
      transition: opacity 120ms;
    }
    .cal .event.personal:hover .upc-resize::after,
    .cal .event.personal.upc-resizing .upc-resize::after { opacity: 1; }
    .cal .event.personal.upc-resizing { z-index: 30 !important; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25); }
    .cal .event.personal.upc-saving { opacity: 0.6; }
    body.upc-resize-active, body.upc-resize-active * { cursor: ns-resize !important; user-select: none !important; }

    /* Up/down spinner inside the sidebar Duration box, styled like the browser's own
       number spinner (shown on hover / focus). It overlaps the right end of the box. */
    input.upc-has-stepper { padding-right: 26px !important; }
    .upc-dur-step {
      position: relative;
      z-index: 4;
      align-self: center;
      width: 15px;
      height: 22px;
      margin-left: -21px;
      margin-right: 6px;
      display: flex;
      flex-direction: column;
      border: 1px solid #c6c6c6;
      border-radius: 3px;
      background: #f3f3f3;
      overflow: hidden;
      opacity: 0;
      transition: opacity 100ms;
    }
    .input-group:hover > .upc-dur-step,
    .input-group:focus-within > .upc-dur-step { opacity: 1; }
    .upc-dur-step button {
      flex: 1 1 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      margin: 0;
      border: 0;
      background: transparent;
      color: #6b6b6b;
      cursor: default;
    }
    .upc-dur-step button:hover { background: #e2e2e2; color: #333; }
    .upc-dur-step button:active { background: #cfcfcf; }

    /* Styled like Halaxy's own appointment time chips */
    #upc-hover-time {
      display: none;
      position: fixed;
      z-index: 100000;
      pointer-events: none;
      padding: 0 5px;
      height: 18px;
      line-height: 16px;
      border: 1px solid var(--vs-theme-border-color, #c7c7c7);
      border-radius: .3rem;
      background: #fff;
      color: var(--vs-cal-colHead-color, #0e0793);
      font-family: Beatrice, sans-serif;
      font-weight: 500;
      font-size: .75rem;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
      white-space: nowrap;
    }
  `;
  (function addStyle() {
    const target = document.head || document.documentElement;
    if (target) target.appendChild(style);
    else setTimeout(addStyle, 10);
  })();

  const log = (...a) => console.log('[UPC calendar]', ...a);

  // ---------- Being a good Halaxy user ----------
  // Note when the calendar's appointments were last downloaded by anything other than our own
  // check (Halaxy redrawing, changing date, its own refresh). If that happened within the last
  // refresh period, our check is skipped: the calendar is already up to date.
  let lastOtherCalendarLoad = 0;
  let ownCheckRunning = false;
  const isCalendarJson = (method, url) => String(method || 'GET').toUpperCase() === 'GET' && /\/calendar\/json(\?|$)/.test(String(url || ''));
  (function watchCalendarLoads() {
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        if (isCalendarJson(method, url) && !ownCheckRunning) {
          this.addEventListener('load', () => { if (this.status === 200) lastOtherCalendarLoad = Date.now(); }, { once: true });
        }
        if (isCalendarJson(method, url)) {
          this.addEventListener('load', () => {
            try {
              if (this.status !== 200) return;
              const j = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
              zeroLook.note(j && j.payload && j.payload.events, url);
            } catch (e) { /* not ours to worry about */ }
          }, { once: true });
        }
      } catch (e) { /* never get in Halaxy's way */ }
      return open.apply(this, arguments);
    };
    const f = window.fetch;
    if (f) {
      window.fetch = function (input, init) {
        const p = f.apply(this, arguments);
        try {
          const url = typeof input === 'string' ? input : input && input.url;
          if (isCalendarJson((init && init.method) || (input && input.method), url) && !ownCheckRunning) {
            p.then((r) => { if (r && r.status === 200) lastOtherCalendarLoad = Date.now(); }, () => {});
          }
        } catch (e) { /* never get in Halaxy's way */ }
        return p;
      };
    }
  })();
  let zoomApplied = false;

  // ---------- 0a. £0 invoices look paid ----------
  // Carl, 10 Nov 2026: an appointment whose invoice is £0 (package follow-ups, cancelled appointments)
  // has nothing to pay, but Halaxy draws the black "unpaid" icon, which catches the eye. The calendar
  // data has the payment status but not the amount, so the amounts come from Halaxy's invoice list:
  // one request for the dates on screen, shared by all tabs, repeated at most every 30 minutes for those
  // dates, through the core library's pacing. Those appointments are then drawn exactly as a paid one
  // (the payment status and its icon class are taken from a paid appointment Halaxy sent). Display only:
  // nothing in Halaxy changes.
  const zeroLook = (() => {
    const KEY = 'upc-cal-zero';
    const RECHECK = 30 * 60e3, KEEP = 7 * 86400e3;
    let memo = null, memoAt = 0;   // read at most once a second: the template asks once per appointment
    const st = () => {
      if (memo && Date.now() - memoAt < 1000) return JSON.parse(JSON.stringify(memo));
      try { memo = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { memo = {}; }
      memoAt = Date.now();
      return JSON.parse(JSON.stringify(memo));
    };
    const put = (s) => { memo = s; memoAt = Date.now(); try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* storage blocked */ } };
    const isPaid = (e) => /paid in full/i.test(e.invoiceStatus || '');
    let running = false;
    const diag = { patched: 0, lookups: 0, lastError: '' };

    function isZero(id) {
      const s = st();
      const hit = id && s.inv && s.inv[id];
      return !!(hit && hit[0] === 1 && s.paid && s.paid.css !== undefined);
    }

    // Every calendar download comes through here (Halaxy's own and our refresh).
    function note(events, url) {
      if (!ZERO_LOOKS_PAID || !Array.isArray(events)) return;
      const s = st();
      const paidOne = events.find((e) => isPaid(e) && e.invStatusCss !== undefined);
      if (paidOne && (!s.paid || s.paid.css !== paidOne.invStatusCss || s.paid.status !== paidOne.invoiceStatus)) {
        s.paid = { status: paidOne.invoiceStatus, css: paidOne.invStatusCss };
        put(s);
      }
      const now = Date.now();
      const unknown = events.filter((e) => (!e.type || e.type === 'appointment') && e.invoiceID && !isPaid(e))
        .filter((e) => { const hit = s.inv && s.inv[e.invoiceID]; return !hit || now - hit[1] > RECHECK; });
      if (!unknown.length) return;
      let q = {};
      try { q = Object.fromEntries(new URL(String(url), location.href).searchParams); } catch (e) { /* use the view */ }
      const HC = window.HkCalendar;
      if ((!q.start || !q.end) && HC && HC.getEventUrlQueryParams) q = HC.getEventUrlQueryParams();
      const from = Number(q.start) * 1000, to = Number(q.end) * 1000;
      if (!from || !to) return;
      lookup(from, to, unknown.map((e) => String(e.invoiceID)));
    }

    async function lookup(from, to, ids) {
      const U = window.UPC;
      if (running || document.hidden || !U || !U.http || !U.http.list || (U.http.pausedFor && U.http.pausedFor() > 0)) return;
      const rangeKey = Math.floor(from / 86400e3) + '-' + Math.floor(to / 86400e3);
      const s0 = st();
      if (s0.ranges && Date.now() - (s0.ranges[rangeKey] || 0) < 2 * 60e3) return;   // just looked (here or in another tab)
      running = true;
      s0.ranges = Object.assign({}, s0.ranges, { [rangeKey]: Date.now() });
      put(s0);
      const day = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' 00:00:00'; };
      const found = {};
      try {
        diag.lookups++;
        const fm = { invoiceDate: { filterType: 'date', type: 'inRange', dateFrom: day(from - 86400e3), dateTo: day(to + 86400e3) } };
        const sort = [{ colId: 'invoiceDate', sort: 'desc' }];
        for (let start = 0; start < 1000; start += 200) {
          const j = await U.http.list('/invoice/list-data', fm, sort, start, start + 200);
          const rows = (j && j.rowData) || [];
          let older = false;
          rows.forEach((r) => {
            if (r && r.id !== undefined && r.total !== undefined && r.total !== null) found[String(r.id)] = Number(r.total) <= 0 ? 1 : 0;
            const d = U.parseDay ? U.parseDay(r && r.invoiceDate) : null;
            if (d !== null && d < from - 2 * 86400e3) older = true;   // in case Halaxy ignores the date filter
          });
          if (older || rows.length < 200 || (typeof j.lastRow === 'number' && j.lastRow >= 0 && start + 200 >= j.lastRow)) break;
        }
      } catch (e) {
        diag.lastError = e.message || String(e);
      } finally {
        running = false;
      }
      const s = st(), now = Date.now();
      s.inv = s.inv || {};
      let newZero = false;
      Object.keys(found).forEach((id) => { if (found[id] === 1 && !(s.inv[id] && s.inv[id][0] === 1)) newZero = true; s.inv[id] = [found[id], now]; });
      ids.forEach((id) => { if (!(id in found) && !s.inv[id]) s.inv[id] = [0, now]; });   // not in the list: leave it as Halaxy draws it
      Object.keys(s.inv).forEach((id) => { if (now - s.inv[id][1] > KEEP) delete s.inv[id]; });
      Object.keys(s.ranges || {}).forEach((k) => { if (now - s.ranges[k] > KEEP) delete s.ranges[k]; });
      put(s);
      if (newZero && ids.some((id) => found[id] === 1)) redraw();
    }

    function redraw() {
      const HC = window.HkCalendar;
      try { if (HC && HC.eventsView) HC.eventsView.render(); } catch (e) { /* the next redraw shows it */ }
    }

    // Halaxy draws each appointment with its compiled template, HkCalendar.tEvent. A £0 invoice's
    // appointment is handed to it with a paid appointment's payment status and icon class.
    function paidCopy(d) {
      const s = st();
      diag.patched++;
      return Object.assign({}, d, { invoiceStatus: s.paid.status, invStatusCss: s.paid.css });
    }
    function adjust(data) {
      try {
        if (!ZERO_LOOKS_PAID || !data || typeof data !== 'object') return data;
        if (data.invoiceID !== undefined) return !isPaid(data) && isZero(data.invoiceID) ? paidCopy(data) : data;
        if (data.attributes && data.attributes.invoiceID !== undefined) {
          const a = data.attributes;
          if (isPaid(a) || !isZero(a.invoiceID)) return data;
          const copy = Object.create(Object.getPrototypeOf(data));
          return Object.assign(copy, data, { attributes: paidCopy(a) });
        }
        const k = Object.keys(data).find((x) => data[x] && typeof data[x] === 'object' && data[x].invoiceID !== undefined);
        if (k && !isPaid(data[k]) && isZero(data[k].invoiceID)) return Object.assign({}, data, { [k]: paidCopy(data[k]) });
      } catch (e) { /* draw as Halaxy would */ }
      return data;
    }
    function wrapTemplate(HC) {
      if (!ZERO_LOOKS_PAID || !HC || HC.__upcZeroWrap) return;
      HC.__upcZeroWrap = true;
      let raw = HC.tEvent;
      const wrap = (fn) => (typeof fn === 'function' ? function (data) { return fn.call(this, adjust(data), ...[].slice.call(arguments, 1)); } : fn);
      let wrapped = wrap(raw);
      try {
        Object.defineProperty(HC, 'tEvent', {
          configurable: true, enumerable: true,
          get() { return wrapped; },
          set(v) { raw = v; wrapped = wrap(v); },
        });
      } catch (e) { log('£0 paid look not available:', e); }
    }
    return { note, wrapTemplate, isZero, diag };
  })();
  window.upcCalendarZero = zeroLook;   // diagnostics

  // ---------- 1. Hook Halaxy's calendar start-up ----------
  // Our DOMContentLoaded listener is registered before jQuery's, so it runs after Halaxy's
  // scripts have loaded but before the calendar initialises.
  function hookInit() {
    const HC = window.HkCalendar;
    if (!HC || typeof HC.initForPrac !== 'function' || HC.initForPrac.__upc) return;
    patchRowHeights(HC);
    poundSigns();                  // before Halaxy reads its appointment template
    zeroLook.wrapTemplate(HC);
    const orig = HC.initForPrac;
    HC.initForPrac = function (when, prefs, ...rest) {
      if (prefs && typeof prefs === 'object') {
        const diffs = prefDiffs(prefs);
        if (diffs.length) {
          log('preferences differ from clinic defaults:', diffs.join(', '));
          applyPrefsLocally(prefs);   // show the clinic defaults straight away
          savePrefsToAccount();       // and save them to this person's Halaxy account
        }
      }
      const result = orig.call(this, when, prefs, ...rest);
      afterInit();
      return result;
    };
    HC.initForPrac.__upc = true;
  }

  // ---------- 1a. Row heights, current-time line, compact 15-minute view ----------
  // Halaxy positions appointments and the time line using a fixed row height (25px), but
  // stretches the rows to fill the screen. The mismatch puts the time line too high, growing
  // through the day. Here Halaxy's row height always matches the rows actually drawn.
  function isCompact() {
    const m = window.HkCalendar && HkCalendar.calendarModel;
    return !!(COMPACT_15_MINUTE_VIEW && m && m.get('mode') !== 'month' && m.get('SdDay') === 900);
  }

  function secs(t) {
    const [h, m] = String(t || '0:0').split(':').map(Number);
    return h * 3600 + m * 60;
  }

  function expectedRows(slotDelta) {
    const p = HkCalendar.preferences;
    return Math.round((secs(p.calendar_view_time_to) - secs(p.calendar_view_time_from)) / slotDelta) + 1;
  }

  // Unstretched row height for the theme. Halaxy overwrites defaultPXHeight with the
  // stretched height after drawing, so the original value is captured once, up front.
  let BASE_ROW = null;
  function baseHeight() {
    const HC = window.HkCalendar;
    if (BASE_ROW === null) BASE_ROW = HC.defaultPXHeight || 25;
    const t = HC.timeslotHeights[HealthKit.getThemeFontSize()];
    return typeof t === 'number' ? t : BASE_ROW;
  }

  function patchRowHeights(HC) {
    if (HC.__upcRows) return;
    HC.__upcRows = true;
    if (BASE_ROW === null) BASE_ROW = HC.defaultPXHeight || 25;
    let storedPX = HC.PXHeight;

    function rowHeight() {
      const base = baseHeight();
      const m = HC.calendarModel;
      if (!m || m.get('mode') === 'month') return base;
      if (isCompact()) return Math.round(base / 2);   // fixed height, never stretched
      const b = base;
      const n = expectedRows(m.get('slotDelta'));
      // Rows already drawn for this zoom level: use their real height.
      const labels = document.querySelectorAll('.cal .timeLabel');
      if (labels.length === n && labels.length > 1) {
        const h = labels[1].getBoundingClientRect().height;
        if (h > 0) return h;
      }
      // Otherwise predict it the same way Halaxy's render does.
      const vp = document.getElementById('calendarViewPort');
      const c = vp ? vp.clientHeight : 0;
      return c > n * b + 1 ? Math.floor(c / n) : b;
    }

    HC.getTimeslotHeightForFontSize = rowHeight;
    Object.defineProperty(HC, 'PXHeight', {
      configurable: true,
      get() {
        const m = HC.calendarModel;
        if (!m || m.get('mode') === 'month') return storedPX;
        return rowHeight() / m.get('slotDelta');
      },
      set(v) { storedPX = v; },
    });

    // Current-time line from the real row positions.
    HC.Timeline.position = function (now) {
      const el = document.querySelector('.cal .timeline');
      const grid = document.getElementById('grid');
      const m = HC.calendarModel;
      const labels = document.querySelectorAll('.cal .timeLabel');
      if (!el || !grid || !m || labels.length < 2) return;
      const sd = m.get('slotDelta');
      const t = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds()
        - secs(HC.preferences.calendar_view_time_from);
      const i = Math.min(Math.floor(t / sd), labels.length - 1);
      if (i < 0) return;
      const r = labels[i].getBoundingClientRect();
      const top = r.top - grid.getBoundingClientRect().top - grid.clientTop + ((t - i * sd) / sd) * r.height;
      el.style.top = top + 'px';
    };
  }

  function syncCompact() {
    const on = isCompact();
    const base = baseHeight();
    document.querySelectorAll('.cal').forEach((c) => {
      c.classList.toggle('upc-compact', on);
      c.style.setProperty('--upc-row', Math.round(base / 2) + 'px');
    });
  }

  // Tag :15 / :45 rows after each render, and keep the time line in place.
  let tagQueued = false;
  function tagRows() {
    tagQueued = false;
    const labels = document.querySelectorAll('.cal .timeLabel');
    labels.forEach((l) => l.classList.toggle('upc-q', /:(15|45)\s*$/.test(l.textContent.trim())));
    document.querySelectorAll('.cal .timeslot[ts]').forEach((s) => {
      s.classList.toggle('upc-q', parseInt(s.getAttribute('ts'), 10) % 1800 !== 0);
    });
    try { HkCalendar.Timeline.tick(); } catch (e) { /* calendar not ready */ }
    animateAppear();
    addResizeHandles();
    addDurationStepper();
    watchFeeDurations();
  }
  function queueTag() {
    if (tagQueued) return;
    tagQueued = true;
    requestAnimationFrame(tagRows);
  }

  // ---------- 1b. Clinic preferences ----------
  const asTime = (v) => String(v || '').slice(0, 5).padStart(5, '0'); // "08:00:00" -> "08:00"

  function prefDiffs(prefs) {
    return Object.keys(CLINIC_PREFS).filter((k) => {
      const cur = TIME_KEYS.includes(k) ? asTime(prefs[k]) : String(prefs[k]);
      return cur !== CLINIC_PREFS[k];
    });
  }

  function applyPrefsLocally(prefs) {
    for (const k in CLINIC_PREFS) {
      prefs[k] = TIME_KEYS.includes(k) ? CLINIC_PREFS[k] + ':00' : CLINIC_PREFS[k];
    }
    prefs.calendar_prac_selection = parseInt(CLINIC_PREFS.calendar_prac_selection, 10);
  }

  let saveStarted = false;
  function savePrefsToAccount() {
    if (saveStarted) return;
    saveStarted = true;
    try { if (sessionStorage.getItem('upcPrefsSaveFailed')) return; } catch (e) { /* ignore */ }
    const $ = window.jQuery;
    const url = prefsUrl();
    if (!$ || !url) return log('cannot save preferences: page not ready');

    const fail = (why) => {
      log('could not save calendar preferences:', why);
      try { sessionStorage.setItem('upcPrefsSaveFailed', '1'); } catch (e) { /* ignore */ }
    };

    // Load the preferences form exactly as Halaxy's cog button does.
    $.ajax({ url, type: 'GET', dataType: 'json', cache: false }).done((resp) => {
      const html = findFormHtml(resp);
      if (!html) return fail('form not found in response');
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const form = doc.getElementById('frmCalendarPreferences');
      if (!form || !form.querySelector('[name="form[_token]"]')) return fail('form or token missing');

      // Fill in the clinic values, keep everything else (time zone, token) as Halaxy sent it.
      for (const k in CLINIC_PREFS) {
        if (TIME_KEYS.includes(k)) {
          const [h, m] = CLINIC_PREFS[k].split(':').map((n) => String(parseInt(n, 10)));
          setField(form, `form[${k}][hour]`, h);
          setField(form, `form[${k}][minute]`, m);
        } else {
          setField(form, `form[${k}]`, CLINIC_PREFS[k]);
        }
      }

      // Save it exactly as Halaxy's Save button does.
      $.ajax({ url, type: 'POST', dataType: 'json', data: $(form).serialize() }).done((r) => {
        if (r && r.status === 'REFRESH') log('calendar preferences saved to account');
        else fail(r && r.message ? $('<div>').html(r.message).text().trim() : 'unexpected response');
      }).fail((x) => fail('save request failed (' + x.status + ')'));
    }).fail((x) => fail('load request failed (' + x.status + ')'));
  }

  function prefsUrl() {
    const btn = document.getElementById('btnCalendarPreferences');
    if (btn && btn.dataset.modalHref) return btn.dataset.modalHref;
    const json = window.HkCalendar && HkCalendar.PathForEventJSON;
    return json ? json.replace(/\/json$/, '/preferences') : null;
  }

  function findFormHtml(resp) {
    if (typeof resp === 'string') return resp.includes('frmCalendarPreferences') ? resp : null;
    if (resp && typeof resp === 'object') {
      for (const v of Object.values(resp)) {
        const found = findFormHtml(v);
        if (found) return found;
      }
    }
    return null;
  }

  function setField(form, name, value) {
    const els = form.querySelectorAll(`[name="${name}"]`);
    if (!els.length) return log('field not found:', name);
    els.forEach((el) => {
      if (el.type === 'radio') {
        if (el.value === value) el.setAttribute('checked', 'checked');
        else el.removeAttribute('checked');
        el.checked = el.value === value;
      } else if (el.tagName === 'SELECT') {
        el.value = value;
        el.querySelectorAll('option').forEach((o) => o.toggleAttribute('selected', o.value === value));
      } else {
        el.value = value;
      }
    });
  }

  // Fallback if the calendar had already started before we could hook it.
  // Halaxy's appointment template hard-codes "$" for the invoice link and its popups.
  function poundSigns() {
    if (!CURRENCY_SYMBOL) return false;
    const t = document.getElementById('tpl-event');
    if (!t || t.__upc) return false;
    t.textContent = t.textContent.replace(/>\$</g, '>' + CURRENCY_SYMBOL + '<');
    t.__upc = true;
    return true;
  }

  function lateSetup() {
    const HC = window.HkCalendar;
    if (!HC || !HC.calendarModel || HC.__upcDone || HC.isRoomCalendar?.()) return;
    zeroLook.wrapTemplate(HC);
    if (poundSigns() && HC.eventsView) {   // calendar already started: recompile and redraw
      HC.tEvent = window._.template(window.jQuery('#tpl-event').html());
      try { HC.eventsView.render(); } catch (e) { /* next redraw will pick it up */ }
    }
    if (prefDiffs(HC.preferences).length) savePrefsToAccount(); // takes full effect on next load
    if (parseInt(HC.preferences.calendar_prac_selection, 10) !== 1) {
      HC.preferences.calendar_prac_selection = 1;
      const p = HC.parameters;
      const mode = HC.calendarModel.get('mode');
      const src = mode === 'week' ? p.calPractsWeek : p.calPractsDay;
      if (src && src.length) { p.calPractsDay = src.slice(); p.calPractsWeek = src.slice(); }
      try { window.CalendarSettingsPrac.savePracState(); } catch (e) { log(e); }
    }
    afterInit();
  }

  function afterInit() {
    const HC = window.HkCalendar;
    if (!HC || HC.__upcDone || HC.isRoomCalendar?.()) return;
    HC.__upcDone = true;
    patchRowHeights(HC);
    // Compact class must be set before Halaxy redraws. Halaxy's full redraw runs on the
    // model's 'change' event, which fires after these attribute events.
    HC.calendarModel.on('change:SdDay change:mode', syncCompact);
    syncCompact();
    patchZoomSteps(HC);
    patchSingleEventUpdate(HC);
    setupAutoRefresh(HC);
    patchDragDrop();
    patchNewAppointmentDuration(HC);
    waitFor(() => document.querySelector('.timeslot'), applyDefaultZoom);
    HC.calendarModel.on('change:mode', updateButtons);
    addButtons();
    new MutationObserver(queueTag).observe(document.body, { childList: true, subtree: true });
    setupHoverTime();
    setInterval(() => { try { HC.Timeline.tick(); } catch (e) { /* ignore */ } }, 15000);
  }

  // ---------- 2a. Half-width appointments after live updates ----------
  // Halaxy narrows an appointment when it counts more than one starting in the same time box.
  // When one appointment is refreshed live (edited, confirmed, paid, etc.) Halaxy removes it from
  // the overall count but not from the per-practitioner count used in multi-practitioner views,
  // so the refreshed appointment is counted twice and drawn at half width. Correct that count.
  function patchSingleEventUpdate(HC) {
    if (typeof HC.updateSingleEvent !== 'function' || HC.updateSingleEvent.__upc) return;
    const orig = HC.updateSingleEvent;
    HC.updateSingleEvent = function (id) {
      try {
        if (HC.fetchSingleIdInProgress !== id && HC.eventsView) {
          const ev = HC.eventsView.model.where({ id }, true);
          if (ev) {
            const a = ev.attributes;
            const pk = a.practitionerID + '-' + a.parentTimestamp;
            if (HC.PracEvents && HC.PracEvents[pk] > 0) HC.PracEvents[pk]--;
            const rk = a.roomId + '-' + a.parentTimestamp;
            if (HC.RoomEvents && HC.RoomEvents[rk] > 0) HC.RoomEvents[rk]--;
          }
        }
      } catch (e) { log('count fix skipped:', e); }
      return orig.apply(this, arguments);
    };
    HC.updateSingleEvent.__upc = true;
  }

  // ---------- 2c. Pick up changes made on other computers ----------
  // Every AUTO_REFRESH_SECONDS (while the tab is visible) download the appointments for the
  // current view, exactly as Halaxy does, and compare with what's on screen. Changes are only
  // applied when nobody is mid-task; otherwise they wait.
  let mouseDown = false;
  document.addEventListener('mousedown', () => { mouseDown = true; }, true);
  document.addEventListener('mouseup', () => { mouseDown = false; }, true);

  function isBusy(HC) {
    if (HC.Appointment && HC.Appointment.mode === 'edit') return 'booking/editing';
    if (mouseDown) return 'mouse down';
    if (document.querySelector('.ui-draggable-dragging')) return 'dragging';
    if ([...document.querySelectorAll('.bootbox.modal, .modal.show')].some((m) => m.offsetParent !== null || m.classList.contains('show'))) return 'pop-up open';
    const cm = document.getElementById('context-menu-area');
    if (cm && !cm.classList.contains('d-none')) return 'menu open';
    const a = document.activeElement;
    if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) && a.closest('#RHI, .modal, form')) return 'typing';
    return null;
  }

  function setupAutoRefresh(HC) {
    if (!AUTO_REFRESH_SECONDS || HC.__upcRefresh) return;
    HC.__upcRefresh = true;
    const $ = window.jQuery;
    let baseline = null;          // { key, sigs: Map(id -> signature) }
    let pending = null;           // changes waiting for a quiet moment
    let running = false;
    let ignoreRemoved = new Set();

    const viewKey = () => JSON.stringify(HC.getEventUrlQueryParams());
    const sig = (e) => JSON.stringify(e);
    const onScreen = () => new Map(HC.eventsView ? HC.eventsView.model.models.map((m) => [String(m.id), m]) : []);

    // Downloads the current view's appointments, through the core library's pacing when it is
    // loaded (so it pauses when Halaxy is busy), otherwise exactly as before.
    function download() {
      const params = HC.getEventUrlQueryParams();
      if (window.UPC && UPC.http && UPC.http.json) {
        ownCheckRunning = true;
        const q = $.param(Object.assign({}, params, { _: Date.now() }));
        return UPC.http.json(HC.PathForEventJSON + (HC.PathForEventJSON.includes('?') ? '&' : '?') + q)
          .finally(() => { ownCheckRunning = false; });
      }
      return Promise.resolve($.ajax({ url: HC.PathForEventJSON, type: 'GET', dataType: 'json', cache: false, data: params }));
    }

    function poll() {
      if (Date.now() - lastOtherCalendarLoad < AUTO_REFRESH_SECONDS * 1000) { baseline = null; return; }   // already up to date
      if (window.UPC && UPC.http && UPC.http.pausedFor && UPC.http.pausedFor() > 0) return;   // Halaxy asked us to wait
      if (running || document.hidden || !HC.calendarModel || HC.calendarModel.get('mode') === 'month') return;
      if (HC.isRoomCalendar && HC.isRoomCalendar()) return;
      running = true;
      const key = viewKey();
      download()
        .then((resp) => {
          if (key !== viewKey()) return;                       // view changed while loading
          const events = resp && resp.payload && resp.payload.events;
          zeroLook.note(events, null);
          if (!Array.isArray(events)) return;
          const fresh = new Map(events.map((e) => [String(e.id), e]));
          const shown = onScreen();
          const changes = { add: [], update: [], removed: [], other: false, appear: [] };

          for (const [id, e] of fresh) {
            const isAppt = !e.type || e.type === 'appointment';
            if (!shown.has(id)) {
              isAppt ? changes.add.push(e.id) : (changes.other = true);
              changes.appear.push(e.id);
            } else if (baseline && baseline.key === key && baseline.sigs.has(id) && baseline.sigs.get(id) !== sig(e)) {
              isAppt ? changes.update.push(e.id) : (changes.other = true);
              changes.appear.push(e.id);
            }
          }
          for (const id of shown.keys()) if (!fresh.has(id) && !ignoreRemoved.has(id)) changes.removed.push(id);

          baseline = { key, sigs: new Map([...fresh].map(([id, e]) => [id, sig(e)])) };
          const n = changes.add.length + changes.update.length + changes.removed.length + (changes.other ? 1 : 0);
          if (n) {
            pending = { key, changes };
            log('changes from elsewhere:', JSON.stringify({ add: changes.add.length, update: changes.update.length, removed: changes.removed.length, other: changes.other }));
            tryApply();
          }
        })
        .catch(() => { /* try again next time */ })
        .finally(() => { running = false; });
    }

    function tryApply() {
      if (!pending) return;
      if (pending.key !== viewKey()) { pending = null; return; }   // view changed: Halaxy reloaded anyway
      const busy = isBusy(HC);
      if (busy) { setTimeout(tryApply, 3000); return; }
      const { changes } = pending;
      pending = null;

      if (changes.removed.length || changes.other || changes.add.length + changes.update.length > 8) {
        // Full redraw, keeping the scroll position.
        const vp = document.getElementById('calendarViewPort');
        const top = vp ? vp.scrollTop : 0;
        // If the same appointments still look "missing" after this redraw, it's a quirk of
        // the comparison, not a real deletion: ignore them rather than redrawing again.
        ignoreRemoved = new Set(changes.removed);
        markAppear(changes.appear);
        const leaving = animateLeave(changes.removed);
        setTimeout(() => {
          HC.Grid.getCalendarData();   // Halaxy's own "reload appointments" (same as changing date)
          waitFor(() => document.querySelector('.cal .timeslot'), () => { if (vp) vp.scrollTop = top; });
        }, leaving ? LEAVE_MS : 0);
        baseline = null;
        return;
      }
      // One at a time through Halaxy's own single-appointment update.
      const ids = changes.add.concat(changes.update);
      markAppear(ids);
      (function next() {
        if (!ids.length) return;
        if (isBusy(HC)) { pending = { key: viewKey(), changes: { add: ids, update: [], removed: [], other: false } }; setTimeout(tryApply, 3000); return; }
        if (HC.fetchSingleIdInProgress !== null && HC.fetchSingleIdInProgress !== undefined) { setTimeout(next, 300); return; }
        HC.updateSingleEvent(ids.shift());
        setTimeout(next, 300);
      })();
    }

    setInterval(poll, AUTO_REFRESH_SECONDS * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(poll, 500); });
    HC.calendarModel.on('change', () => { baseline = null; });     // new view: start fresh
    HC.__upcPoll = poll;                                            // handy for testing
  }

  // ---------- 2d. Fade/grow animation for appointments changed elsewhere ----------
  const LEAVE_MS = 300;
  const appearIds = new Map();     // id -> time requested

  function markAppear(ids) {
    if (!ANIMATE_CHANGES) return;
    const now = Date.now();
    ids.forEach((id) => appearIds.set(String(id), now));
  }

  // Called after DOM changes (via queueTag): animate any newly drawn appointments we're expecting.
  function animateAppear() {
    if (!appearIds.size) return;
    const now = Date.now();
    for (const [id, t] of appearIds) {
      if (now - t > 15000) { appearIds.delete(id); continue; }
      const el = document.querySelector(`.cal .event[aid="${id}"]`);
      if (!el) continue;
      appearIds.delete(id);
      el.classList.remove('upc-appear');
      void el.offsetWidth;                          // restart animation if re-added
      el.classList.add('upc-appear');
      el.addEventListener('animationend', () => el.classList.remove('upc-appear'), { once: true });
    }
  }

  function animateLeave(ids) {
    if (!ANIMATE_CHANGES || !ids.length) return false;
    let any = false;
    ids.forEach((id) => {
      document.querySelectorAll(`.cal .event[aid="${id}"]`).forEach((el) => { el.classList.add('upc-leave'); any = true; });
    });
    return any;
  }

  // ---------- 2e. Drag and drop lands where the appointment is, not where the mouse is ----------
  // Halaxy's drop uses jQuery UI's "pointer" rule: the time box under the mouse wins, so an
  // appointment grabbed by its middle lands lower than where it's shown. For calendar
  // appointments only, use the time box nearest the appointment's top edge instead. Halaxy's
  // live time label while dragging uses the same rule, so it shows the time it will save at.
  let dragTargetTs = null;
  document.addEventListener('mouseup', () => { dragTargetTs = null; }, true);

  function patchDragDrop() {
    const $ = window.jQuery;
    if (!FIX_DRAG_DROP || !$ || !$.ui || typeof $.ui.intersect !== 'function' || $.ui.intersect.__upc) return;
    const orig = $.ui.intersect;
    $.ui.intersect = function (drag, drop, tolerance, event) {
      try {
        if (tolerance === 'pointer' && drag && drag.element && drag.element.hasClass('event') &&
            drop && drop.element && drop.element.hasClass('timeslot') && drop.offset) {
          const pos = drag.positionAbs || drag.position.absolute;
          const h = drop.proportions().height;
          const y = pos.top + drag.margins.top + h / 2;      // nearest box to the top edge
          const x = event.pageX;
          const hit = y >= drop.offset.top && y < drop.offset.top + h &&
                 x >= drop.offset.left && x < drop.offset.left + drop.proportions().width;
          if (hit) dragTargetTs = drop.element.attr('ts');   // shown in the hover label
          return hit;
        }
      } catch (e) { /* fall back to Halaxy's normal behaviour */ }
      return orig.apply(this, arguments);
    };
    $.ui.intersect.__upc = true;
  }

  // ---------- 2f. Resize personal appointments by dragging their bottom edge ----------
  // Saves the new length the same way the sidebar's Save button does: load the appointment's
  // edit form, change only the duration (minutes), and post it back to Halaxy.
  let tipOverride = null;

  function addResizeHandles() {
    if (!RESIZE_PERSONAL || (window.HkUser && window.HkUser.readOnly === true)) return;
    const m = window.HkCalendar && HkCalendar.calendarModel;
    if (!m || m.get('mode') === 'month') return;
    document.querySelectorAll('.cal .event.personal[aid]').forEach((el) => {
      if (el.querySelector(':scope > .upc-resize')) return;
      const h = document.createElement('div');
      h.className = 'upc-resize';
      h.title = 'Drag to change length';
      h.addEventListener('mousedown', startResize);
      el.appendChild(h);
    });
  }

  function fmtTime(ts) {
    try { return String(window.jQuery.hkTypes.Date(ts).format(hk_glob.preferences.timeFormat || 'H:i')).trim(); }
    catch (e) { const d = new Date(ts * 1000); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); }
  }
  function fmtLength(mins) {
    const h = Math.floor(mins / 60), m = mins % 60;
    return (h ? h + 'h' : '') + (h && m ? ' ' : '') + (m || !h ? m + 'm' : '');
  }

  function startResize(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();                       // don't start Halaxy's move-drag
    const HC = window.HkCalendar;
    const el = e.currentTarget.parentElement;
    const id = el.getAttribute('aid');
    const model = HC.eventsView && HC.eventsView.model.models.find((mm) => String(mm.id) === String(id));
    if (!model) return;
    if (HC.Appointment && HC.Appointment.mode === 'edit') {
      HkUI.flash.show('info', 'Finish or cancel the appointment you are editing first.');
      return;
    }
    const start = model.get('start').getTimestamp();
    const origEnd = model.get('end').getTimestamp();
    const sd = HC.calendarModel.get('slotDelta');
    const px = HC.PXHeight;                    // pixels per second
    const startY = e.clientY;
    const origHeight = el.offsetHeight;
    let newEnd = origEnd;

    el.classList.add('upc-resizing');
    document.body.classList.add('upc-resize-active');

    const onMove = (ev) => {
      const rawEnd = origEnd + (ev.clientY - startY) / px;
      newEnd = Math.max(start + sd, Math.round(rawEnd / sd) * sd);   // snap to the grid, at least one row
      el.style.height = Math.max((newEnd - start) * px, 4) + 'px';
      tipOverride = 'Ends ' + fmtTime(newEnd) + ' (' + fmtLength(Math.round((newEnd - start) / 60)) + ')';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      document.body.classList.remove('upc-resize-active');
      el.classList.remove('upc-resizing');
      tipOverride = null;
      // Swallow the click that immediately follows, so Halaxy doesn't open the appointment.
      const swallow = (c) => { c.stopPropagation(); c.preventDefault(); };
      document.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 250);
      if (newEnd === origEnd) { el.style.height = origHeight + 'px'; return; }
      saveDuration(model, el, start, newEnd, origHeight);
    };
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
  }

  function saveDuration(model, el, start, newEnd, origHeight) {
    const HC = window.HkCalendar;
    const $ = window.jQuery;
    const id = model.get('id');
    const prac = model.get('practitionerID');
    const minutes = Math.round((newEnd - start) / 60);
    const revert = (msg) => {
      el.classList.remove('upc-saving');
      el.style.height = origHeight + 'px';
      HkUI.flash.show('danger', msg);
    };
    el.classList.add('upc-saving');

    const slot = el.closest('.timeslot');
    const linkPrC = slot ? slot.getAttribute('data-timeslotlinkprc') || '' : '';
    const loadUrl = HkUtils.appendURL(HkUtils.appendURL(HC.PathForNewAppointment, prac), id) + '/edit' +
                    '?timestamp=' + start + '&linkPrC=' + encodeURIComponent(linkPrC);
    const saveUrl = HkUtils.appendURL(HkUtils.appendURL(HC.PathForNewEvent, prac), id) + '/edit';

    $.getJSON(loadUrl).done((resp) => {
      if (!resp || resp.status === 'ERROR' || typeof resp.message !== 'string') {
        return revert('Could not load that appointment to change its length.');
      }
      const doc = new DOMParser().parseFromString(resp.message, 'text/html');
      const form = doc.getElementById('pr-appointment');
      const dur = form && form.querySelector('[name="form[duration]"]');
      const type = form && form.querySelector('[name="form[type]"]');
      if (!form || !dur || !type || type.value !== 'event') {
        return revert('Could not change the length here. Please use the sidebar.');
      }
      const rec = form.querySelector('[name="form[schedule][enabled]"]');
      if (rec && rec.value === '1') {
        return revert('This is a repeating appointment. Please change its length in the sidebar.');
      }
      dur.value = String(minutes);
      dur.setAttribute('value', String(minutes));
      // Exactly as Halaxy's Save button: location dropdowns are cleared before sending.
      form.querySelectorAll('.location-type').forEach((s) => { s.value = ''; });

      $.ajax({ url: saveUrl, type: 'POST', dataType: 'json', data: $(form).serialize() })
        .done((r) => {
          if (r && r.status === 'OK') {
            HkUI.flash.show('success', 'Length changed to ' + fmtLength(minutes) + ', ending at ' + fmtTime(newEnd) + '.');
            const vp = document.getElementById('calendarViewPort');
            const top = vp ? vp.scrollTop : 0;
            HC.Grid.getCalendarData();       // reload appointments (as when changing date)
            waitFor(() => document.querySelector('.cal .timeslot'), () => { if (vp) vp.scrollTop = top; });
          } else {
            revert((r && (r.message || r.title)) ? $('<div>').html(r.message || r.title).text().trim() : 'Halaxy did not accept the change.');
          }
        })
        .fail((x) => revert('Could not save the new length (' + x.status + ').'));
    }).fail((x) => revert('Could not load that appointment (' + x.status + ').'));
  }

  // ---------- 2g. Up/down arrows on the sidebar's Duration box ----------
  function stepDuration(input, dir) {
    const step = DURATION_STEP_MINUTES;
    const cur = parseFloat(String(input.value).replace(',', '.')) || 0;
    let next = dir > 0 ? Math.floor(cur / step) * step + step : Math.ceil(cur / step) * step - step;
    next = Math.max(step, next);
    if (next === cur) return;
    input.value = String(next);
    // Tell Halaxy, as if it had been typed.
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  }

  function addDurationStepper() {
    if (!DURATION_STEP_MINUTES) return;
    document.querySelectorAll('input[name="form[duration]"]').forEach((input) => {
      if (input.dataset.upcStepper || input.readOnly || input.disabled) return;
      input.dataset.upcStepper = '1';
      const group = input.closest('.input-group');
      if (!group) return;
      const box = document.createElement('div');
      box.className = 'upc-dur-step';
      const tri = (pts) => `<svg width="7" height="4" viewBox="0 0 7 4" aria-hidden="true"><polygon points="${pts}" fill="currentColor"/></svg>`;
      box.innerHTML =
        `<button type="button" tabindex="-1" title="Add ${DURATION_STEP_MINUTES} minutes" aria-label="Add ${DURATION_STEP_MINUTES} minutes">${tri('0,4 3.5,0 7,4')}</button>` +
        `<button type="button" tabindex="-1" title="Remove ${DURATION_STEP_MINUTES} minutes" aria-label="Remove ${DURATION_STEP_MINUTES} minutes">${tri('0,0 7,0 3.5,4')}</button>`;
      const [up, down] = box.querySelectorAll('button');
      // mousedown, not click: keeps focus in the box, like the native spinner
      up.addEventListener('mousedown', (e) => { e.preventDefault(); input.focus(); stepDuration(input, +1); });
      down.addEventListener('mousedown', (e) => { e.preventDefault(); input.focus(); stepDuration(input, -1); });
      input.classList.add('upc-has-stepper');
      input.after(box);                        // overlaps the right end of the box
      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          stepDuration(input, e.key === 'ArrowUp' ? +1 : -1);
        }
      });
    });
  }

  // ---------- 2j. 24-hour time picker on appointment forms ----------
  // Halaxy's appointment time is three boxes (#js_time_hours 1-12, #js_time_minutes, #js_time_m
  // AM/PM) which it converts into the saved timestamp (form[FakeUTCStart]) on change. Show one
  // 00-23 hour box instead; keep Halaxy's boxes hidden and in step, so Halaxy's own conversion
  // still produces what's saved. Halaxy always fires 'chosen:updated' after setting the time
  // itself, which is used to keep the 24-hour box in step the other way.
  function setup24hPicker() {
    if (!TIME_PICKER_24H) return;
    const $ = window.jQuery;
    if (!$) return;
    const hours = document.getElementById('js_time_hours');
    const ampm = document.getElementById('js_time_m');
    if (!hours || !ampm) return;
    if (hours.dataset.upc24) { hideHalaxyHourBoxes(); return; }   // already set up: keep Halaxy's boxes hidden
    hours.dataset.upc24 = '1';

    const sel = document.createElement('select');
    sel.id = 'upc_time_hours24';
    sel.className = hours.className.replace(/\bevt_ReadFormTime\b/, '').trim();   // look, not Halaxy's listener
    sel.setAttribute('aria-label', 'Hour (24-hour)');
    for (let h = 0; h < 24; h++) {
      const o = document.createElement('option');
      o.value = String(h);
      o.textContent = String(h).padStart(2, '0');
      sel.appendChild(o);
    }

    const read24 = () => {                     // Halaxy's 12h boxes -> 0-23
      const h12 = parseInt(hours.value, 10) || 12;
      const pm = String(ampm.value) === '1';
      return (h12 % 12) + (pm ? 12 : 0);
    };
    const syncFromHalaxy = () => {
      sel.value = String(read24());
      if ($.fn.chosen && $(sel).data('chosen')) $(sel).trigger('chosen:updated');
    };
    let pushing = false;
    const pushToHalaxy = () => {               // 0-23 -> Halaxy's 12h boxes, then let Halaxy convert
      const h = parseInt(sel.value, 10);
      pushing = true;                          // don't echo our own update straight back
      try {
        hours.value = String(h % 12 || 12);
        ampm.value = h >= 12 ? '1' : '0';
        $(hours).add(ampm).trigger('chosen:updated');
        $(hours).trigger('change');            // Halaxy's evt_ReadFormTime handler recalculates the start
      } finally { pushing = false; }
    };

    // Insert before Halaxy's hour box (or its "chosen" replacement) and hide Halaxy's hour and AM/PM.
    const hoursUi = document.getElementById('js_time_hours_chosen') || hours;
    hoursUi.parentNode.insertBefore(sel, hoursUi);
    const hide = hideHalaxyHourBoxes;
    hide();
    if ($.fn.chosen) {
      // Same dropdown style as Halaxy's minutes box, including its search box; same width
      // as Halaxy's own hour box.
      const mins = document.getElementById('js_time_minutes_chosen');
      const width = (hoursUi.style && hoursUi.style.width) || (mins && mins.style.width) || '82px';
      $(sel).chosen({ width });
    }
    syncFromHalaxy();
    $(sel).on('change', pushToHalaxy);
    $(hours).add(ampm).on('chosen:updated', () => { if (!pushing) syncFromHalaxy(); hide(); });
  }

  // Halaxy's hour and AM/PM boxes, and any dropdown UI built for them (now or later).
  function hideHalaxyHourBoxes() {
    document.querySelectorAll('#js_time_hours, #js_time_m, [id="js_time_hours_chosen"], [id="js_time_m_chosen"]')
      .forEach((e) => { if (e.style.display !== 'none') e.style.display = 'none'; });
  }

  function watch24hPickers() {
    if (!TIME_PICKER_24H || document.__upc24Watch) return;
    document.__upc24Watch = true;
    let queued = false;
    const run = () => { queued = false; setup24hPicker(); };
    new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(run); } })
      .observe(document.body, { childList: true, subtree: true });
    run();
  }

  // ---------- 2i. Duration follows the selected fees ----------
  // When a fee is picked, Halaxy stores its default length on the fee field (data-duration),
  // but only changes the appointment duration in limited cases (never for the first fee unless
  // the duration is 0, never when editing). Here, whenever a fee is added, changed or removed,
  // the duration becomes the total of the first patient's fees, as Halaxy counts them.
  // If any selected fee has no known length (chosen before the form opened), leave it alone.
  function feeTotal(form) {
    const firstPatient = form.querySelector('#form_linkaprpags .collection-item');
    const pid = firstPatient && firstPatient.id;
    if (!pid) return null;
    let total = 0, count = 0;
    for (const set of form.querySelectorAll('.invoice-line .me-Set')) {
      if (!set.id || !set.id.includes(pid)) continue;              // first patient only, as Halaxy does
      if (!/^\d+$/.test(String(set.value).trim())) continue;       // no fee chosen on this line
      const d = set.getAttribute('data-duration');
      if (d === null || d === '' || isNaN(parseFloat(d))) return null;   // unknown length: don't guess
      total += parseFloat(d);
      count++;
    }
    return count ? Math.round(total) : null;
  }

  function applyFeeDuration(form) {
    const input = form.querySelector('#form_duration');
    const total = feeTotal(form);
    if (!input || !total || String(input.value) === String(total)) return;
    input.value = String(total);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function watchFeeDurations() {
    if (!DURATION_FROM_FEES) return;
    document.querySelectorAll('form#pr-appointment').forEach((form) => {
      if (form.__upcFees) return;
      form.__upcFees = true;
      let queued = false;
      const run = () => { queued = false; applyFeeDuration(form); };
      new MutationObserver((muts) => {
        const relevant = muts.some((m) =>
          (m.type === 'attributes' && m.attributeName === 'data-duration') ||
          (m.type === 'childList' && [...m.removedNodes].some((n) =>
            n.nodeType === 1 && (n.matches('.invoice-line, .collection-item') || n.querySelector?.('.invoice-line')))));
        if (relevant && !queued) { queued = true; setTimeout(run, 0); }   // after Halaxy's own handler finishes
      }).observe(form, { attributes: true, attributeFilter: ['data-duration'], childList: true, subtree: true });
    });
  }

  // ---------- 2h. Default duration for new appointments ----------
  // Halaxy puts the appointment form into the sidebar with jQuery's .html(). For new (not
  // rebooked) appointments, change the duration in that HTML before it's inserted, so Halaxy's
  // own form scripts see 30 as the starting value (they use it to decide whether you've changed
  // the duration yourself, e.g. before auto-filling it from a personal appointment's title).
  function patchNewAppointmentDuration(HC) {
    const $ = window.jQuery;
    if (!DEFAULT_NEW_DURATION_MINUTES || !$ || $.fn.html.__upc) return;
    const orig = $.fn.html;
    $.fn.html = function (value) {
      try {
        if (typeof value === 'string' && HC.Appointment && HC.Appointment.id === 'new' &&
            value.includes('id="form_duration"') &&
            !/<input\b[^>]*\bname="rebookFrom"/.test(value) &&   // a real rebook field, not Halaxy's script mentioning it
            this.is && this.is('#RHI .content')) {
          value = value.replace(/<input\b[^>]*\bid="form_duration"[^>]*>/, (tag) =>
            /\bvalue="[^"]*"/.test(tag)
              ? tag.replace(/\bvalue="[^"]*"/, `value="${DEFAULT_NEW_DURATION_MINUTES}"`)
              : tag.replace(/>$/, ` value="${DEFAULT_NEW_DURATION_MINUTES}">`));
          arguments[0] = value;
        }
      } catch (e) { /* leave Halaxy's value */ }
      return orig.apply(this, arguments);
    };
    $.fn.html.__upc = true;
  }

  // ---------- 2b. Time under the cursor ----------
  // Small label that follows the mouse over empty time boxes, showing the start time that a
  // click would book. Uses the same formatting Halaxy uses when you click a box.
  function setupHoverTime() {
    if (!SHOW_HOVER_TIME || document.getElementById('upc-hover-time')) return;
    const tip = document.createElement('div');
    tip.id = 'upc-hover-time';
    document.body.appendChild(tip);

    let pending = null;
    let queued = false;
    let lastTs = null;
    const hide = () => { tip.style.display = 'none'; lastTs = null; };

    document.addEventListener('mousemove', (e) => {
      pending = e;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        const ev = pending;
        // While resizing a personal appointment: show the new end time and length.
        if (tipOverride) {
          tip.textContent = tipOverride;
          lastTs = null;
          tip.style.display = 'block';
          tip.style.left = ev.clientX + 14 + 'px';
          tip.style.top = ev.clientY + 16 + 'px';
          return;
        }
        // While dragging an appointment: show the time it will be saved at.
        const dragging = dragTargetTs && document.querySelector('.cal .ui-draggable-dragging');
        // Appointments sit inside the time box they start in, so check for those first.
        const overAppt = ev.target.closest && ev.target.closest('.cal .event');
        const slot = !dragging && !overAppt && ev.target.closest && ev.target.closest('.cal .timeslot[ts]');
        if (!dragging && !slot) return hide();
        const ts = dragging ? dragTargetTs : slot.getAttribute('ts');
        if (ts !== lastTs) {
          lastTs = ts;
          let text;
          try {
            text = window.jQuery.hkTypes.Date(ts).format(window.hk_glob.preferences.timeFormat || 'H:i');
          } catch (err) {
            const d = new Date(parseInt(ts, 10) * 1000);
            text = String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
          }
          tip.textContent = String(text).trim();
        }
        tip.style.display = 'block';
        tip.style.left = ev.clientX + 14 + 'px';
        tip.style.top = ev.clientY + 16 + 'px';
      });
    }, { passive: true });
    document.addEventListener('mouseleave', hide);
    document.addEventListener('scroll', hide, true);
    document.addEventListener('mousedown', hide, true);
    document.addEventListener('mouseup', hide, true);
  }

  // Compact 15 already looks like the 30-minute view, so the zoom buttons skip 20 and 30:
  // ... 10 <-> compact 15 <-> 60 ...
  function patchZoomSteps(HC) {
    if (!COMPACT_15_MINUTE_VIEW || HC.Toolbar.__upc) return;
    HC.Toolbar.__upc = true;
    const step = (orig, map) => function () {
      const m = HC.calendarModel;
      const cur = m.get('SdDay') / 60;
      if (m.get('mode') === 'month' || !(cur in map)) return orig.apply(this, arguments);
      const s = map[cur] * 60;
      m.set({ SdDay: s, SdWeek: s, slotDelta: s });
      HC.Render.resizeCalendar();
    };
    HC.Toolbar.zoomOut = step(HC.Toolbar.zoomOut, { 15: 60, 20: 60, 30: 60 });
    HC.Toolbar.zoomIn = step(HC.Toolbar.zoomIn, { 60: 15, 30: 15, 20: 15 });
    const outBtn = document.getElementById('btn-calendar-zoom-out');
    if (outBtn) outBtn.title = 'Zoom out';
    const inBtn = document.getElementById('btn-calendar-zoom-in');
    if (inBtn) inBtn.title = 'Zoom in';
  }

  // ---------- 2. Default zoom ----------
  function applyDefaultZoom() {
    if (zoomApplied) return;
    zoomApplied = true;
    const HC = window.HkCalendar;
    const m = HC.calendarModel;
    const s = DEFAULT_ZOOM_MINUTES * 60;
    if (m.get('mode') === 'month') {
      // Month view has no zoom; set it quietly so day/week open at the default.
      m.set({ SdDay: s, SdWeek: s }, { silent: true });
      return;
    }
    // Same as Halaxy's own zoom buttons do.
    m.set({ SdDay: s, SdWeek: s, slotDelta: s });
    syncCompact();
    HC.calMenu.refresh();          // redraw so row heights match (also covers "already at this zoom")
    HC.Render.resizeCalendar();
    log('zoom set to', DEFAULT_ZOOM_MINUTES, 'min');
  }

  // ---------- 3. Practitioner buttons ----------
  function me() {
    const btn = document.getElementById('activeUser');
    const def = window.HkUser && HkUser.CalendarDefault;
    const id = btn?.dataset.pracid || def?.pracID;
    const name = btn?.dataset.pracname || def?.pracName;
    return id ? { id: parseInt(id, 10), name } : null;
  }

  function clinicians() {
    const seen = new Set();
    const out = [];
    document.querySelectorAll('#swapPracList .profession-prac-list .toggle-prac').forEach((cb) => {
      const id = parseInt(cb.dataset.pracid, 10);
      if (EXCLUDE_PROFESSIONS.includes(cb.dataset.profession) || seen.has(id)) return;
      seen.add(id);
      out.push({ id, name: cb.dataset.pracname });
    });
    const rank = (id) => {
      const i = PRACTITIONER_ORDER.indexOf(id);
      return i === -1 ? PRACTITIONER_ORDER.length : i;
    };
    return out.sort((a, b) => rank(a.id) - rank(b.id) || a.id - b.id);
  }

  function showPractitioners(list) {
    const HC = window.HkCalendar;
    const $ = window.jQuery;
    if (!HC || !list.length) return;
    const mode = HC.calendarModel.get('mode');

    if (mode === 'month') {
      // Month view shows one practitioner: use Halaxy's single-practitioner switch.
      const link = $('#swapPracList .swapprac[data-pracid="' + list[0].id + '"]').first();
      if (!link.length) return;
      HC.parameters.calPractitioners = [];
      window.HealthKit.swapPrac(link);
      return;
    }

    // Same steps Halaxy uses when you tick a profession heading.
    window.CalendarSettingsPrac.setModePracts(mode, []);
    HC.parameters.calPractitioners = [];
    $('.toggle-prac, .toggle-profession').prop('checked', false);
    list.forEach((p) => {
      HC.RenderPrac.toggleMultiPrac(p.id, p.name, true);
      $('.toggle-prac[data-pracid="' + p.id + '"]').prop('checked', true);
    });
    HC.RenderPrac.renderMultiPracCalendar();
  }

  function addButtons() {
    // Place after the loading wheel: start of the column holding Location / Practitioner buttons.
    const findSpot = () => {
      const col = document.querySelector('#calToolbar .loading')?.closest('.col')?.nextElementSibling;
      return col && col.querySelector('#activeLocation, #btn-swap-prac') ? col : null;
    };
    waitFor(findSpot, (col) => {
      if (document.getElementById('upc-prac-buttons')) return;
      const group = document.createElement('div');
      group.id = 'upc-prac-buttons';
      group.className = 'btn-group ml-2';
      group.innerHTML =
        '<button type="button" id="upc-just-me" class="btn btn-sm btn-outline-primary" title="Show only my calendar">Just me</button>' +
        '<button type="button" id="upc-all-pracs" class="btn btn-sm btn-outline-primary" title="Show all practitioners (not administrators)">All practitioners</button>';
      col.prepend(group);
      group.querySelector('#upc-just-me').addEventListener('click', () => { const m = me(); if (m) showPractitioners([m]); });
      group.querySelector('#upc-all-pracs').addEventListener('click', () => showPractitioners(clinicians()));
      updateButtons();
    });
  }

  function updateButtons() {
    const all = document.getElementById('upc-all-pracs');
    if (all) all.style.display = window.HkCalendar.calendarModel.get('mode') === 'month' ? 'none' : '';
  }

  // ---------- helpers ----------
  function waitFor(test, cb, timeout = 15000) {
    const t0 = Date.now();
    (function poll() {
      const r = test();
      if (r) return cb(r);
      if (Date.now() - t0 < timeout) setTimeout(poll, 100);
    })();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hookInit);
    window.addEventListener('load', lateSetup);
    window.addEventListener('load', watch24hPickers);       // appointment forms on any Halaxy page
  } else {
    hookInit();
    lateSetup();
    watch24hPickers();
  }
})();
