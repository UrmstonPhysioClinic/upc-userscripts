// ==UserScript==
// @name         UPC Calendar: Outstanding actions (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.5.5
// @description  Persistent notice of today's outstanding actions: attended appointments without a published note, and unpaid self-funded invoices.
// @match        https://*.halaxy.com/a/*
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/outstanding-actions.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/outstanding-actions.user.js
// @run-at       document-start
// @grant        none
// @inject-into  page
// @sandbox      raw
// ==/UserScript==

/*
 * RULES
 *  "Attended": the appointment has finished and is not cancelled, did-not-attend, rejected,
 *            declined, rescheduled, waiting list or a pending online request. (Halaxy's calendar
 *            data only records those exception statuses; normal appointments have none.)
 *  Notes:    attended appointments whose clinical note is not published (empty or draft).
 *  Invoices: attended appointments with a self-funded fee,
 *            whose invoice total is above £0 and still has a balance.
 *            (Package follow-ups at £0 and insurer-funded appointments are never flagged.)
 *
 * HOW IT DECIDES "SELF-FUNDED"
 *  Your fees are colour-coded self-funded vs insurer. The script reads Halaxy's fee list,
 *  learns which colours belong to self-funded fees (funder name matching SELF_FUNDED_RE),
 *  and classifies each appointment by its calendar colour. If a colour is used by both
 *  self-funded and insurer fees, that appointment can't be classified and is reported
 *  as "couldn't check" rather than silently skipped.
 *
 * DATA
 *  Reads only, using your logged-in Halaxy session. Nothing is sent anywhere else.
 *  Today's list is cached in this tab's sessionStorage (cleared when the tab closes)
 *  so it shows instantly as you move between pages.
 *
 * BEING A GOOD HALAXY USER
 *  With several Halaxy tabs open on a PC, only one checks at a time and the others are sent its
 *  result (tab to tab, never written to lasting storage). Background checks skip when a check is
 *  less than a minute old (two for the timed check), and while Halaxy has asked scripts to pause.
 *  Requests go through the core library's pacing when it is loaded.
 */

(function () {
  'use strict';
  if (window.__hxOutstanding) return;
  window.__hxOutstanding = true;

  const VERSION = '0.5.5';
  const m = location.pathname.match(/^\/a\/pr\/(\d+)\//);
  if (!m) return;
  const PG = m[1];
  const BASE = '/a/pr/' + PG;

  // ------------------------------------------------------------------ settings (no patient data)
  const SET_KEY = 'hxOutstanding.settings';
  const settings = Object.assign({
    showEveryone: false,      // false: only the logged-in practitioner's appointments
    graceMinutes: 0,          // flag this many minutes after the appointment ends
    pollMinutes: 2,
    selfFundedPattern: 'self|private',
    collapsed: true
  }, readJSON(localStorage, SET_KEY) || {});
  delete settings.mineOnly;   // replaced by showEveryone (7 Nov 2026): yours only is now the default
  const saveSettings = () => writeJSON(localStorage, SET_KEY, settings);
  const SELF_FUNDED_RE = () => new RegExp(settings.selfFundedPattern, 'i');

  function readJSON(store, k) { try { return JSON.parse(store.getItem(k) || 'null'); } catch (e) { return null; } }
  function writeJSON(store, k, v) { try { store.setItem(k, JSON.stringify(v)); } catch (e) {} }

  // ------------------------------------------------------------------ refresh triggers (installed at document-start)
  let refreshTimer = null;
  function scheduleRefresh(ms, why) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refresh(why || 'trigger'), ms);
  }
  // Writes that can resolve an item: note save/publish, payments, appointment status, invoice edits
  const RELEVANT = /\/(note\/note\/save|note\/\d+\/(publish|revert)|invoicefunctions\/|calendar\/appointment\/\d+|appointment\/\d+\/cancel|invoice\/line\/)/;
  const oOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      if (String(method).toUpperCase() !== 'GET' && RELEVANT.test(String(url))) {
        this.addEventListener('loadend', () => scheduleRefresh(1500), { once: true });
      }
    } catch (e) {}
    return oOpen.apply(this, arguments);
  };
  const oFetch = window.fetch;
  if (oFetch) {
    window.fetch = function (input, init) {
      const p = oFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : input && input.url;
        const method = (init && init.method) || (input && input.method) || 'GET';
        if (String(method).toUpperCase() !== 'GET' && RELEVANT.test(String(url))) p.then(() => scheduleRefresh(1500), () => {});
      } catch (e) {}
      return p;
    };
  }
  // Halaxy's live channel (Mercure): "appointment" messages mean something changed on the calendar
  const OES = window.EventSource;
  if (OES) {
    const HxES = function (url, opts) {
      const es = new OES(url, opts);
      try {
        if (/mercure/.test(String(url))) {
          // Every open tab hears these; only the one being looked at checks, and shares its result.
          es.addEventListener('message', ev => { if (/"appointment"/.test(String(ev.data)) && document.visibilityState === 'visible') scheduleRefresh(4000, 'remote'); });
        }
      } catch (e) {}
      return es;
    };
    HxES.prototype = OES.prototype;
    Object.setPrototypeOf(HxES, OES);
    window.EventSource = HxES;
  }

  // ------------------------------------------------------------------ helpers
  const CACHE_KEY = 'hxOutstanding.cache';
  // Appointment statuses that mean the patient wasn't seen
  const NOT_ATTENDED = /cancel|did-not-attend|dna|reject|declin|reschedul|wait|pending/;
  const todayKey = () => { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };
  const toMs = t => (t > 1e12 ? t : t * 1000);
  const money = n => '£' + Number(n).toFixed(2);
  const hhmm = ms => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const normColour = c => {
    c = String(c || '').trim().toLowerCase().replace(/\s+/g, '');
    const s = c.match(/^#?([0-9a-f]{3})$/);
    if (s) return '#' + s[1].split('').map(x => x + x).join('');
    const h = c.match(/^#?([0-9a-f]{6})$/);
    if (h) return '#' + h[1];
    const r = c.match(/^rgba?\((\d+),(\d+),(\d+)/);
    if (r) return '#' + [r[1], r[2], r[3]].map(x => (+x).toString(16).padStart(2, '0')).join('');
    return c;
  };
  const textOf = html => { const d = document.createElement('div'); d.innerHTML = String(html || ''); const n = d.querySelector('.name-text'); return (n || d).textContent.trim(); };

  class FetchError extends Error {}
  // Through the core library's pacing when it is loaded (beta), otherwise straight to Halaxy.
  const doFetch = (url, init) => (window.UPC && UPC.http && UPC.http.fetch ? UPC.http.fetch(url, init) : oFetch.call(window, url, init));
  async function getJSON(path) {
    const res = await doFetch(BASE + path, {
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json' }
    });
    if (!res.ok) throw new FetchError(res.status + ' on ' + path.split('?')[0]);
    const text = await res.text();
    try { return JSON.parse(text); } catch (e) { throw new FetchError(/<html|login/i.test(text) ? 'not logged in' : 'unexpected response on ' + path.split('?')[0]); }
  }

  // ------------------------------------------------------------------ state
  const memo = {
    practitioners: null, practitionersAt: 0,
    colourMap: null, feesAt: 0,
    noteDone: new Set(),      // note IDs seen as published today
    invoiceDone: new Set()    // invoice IDs seen as paid (or £0) today
  };
  let state = readJSON(sessionStorage, CACHE_KEY);
  if (!state || state.day !== todayKey()) state = null;
  let running = false;
  let diag = {};

  // ------------------------------------------------------------------ sharing between this PC's Halaxy tabs
  const FRESH_MS = { load: 60e3, focus: 60e3, poll: Math.max(60e3, settings.pollMinutes * 60e3 - 5e3) };
  const bc = typeof BroadcastChannel === 'function' ? new BroadcastChannel('hx-outstanding') : null;
  function adopt(s) {
    if (!s || s.day !== todayKey() || !!s.everyone !== !!settings.showEveryone) return false;
    if (state && (state.at || 0) >= (s.at || 0)) return false;
    state = s;
    writeJSON(sessionStorage, CACHE_KEY, state);
    render();
    return true;
  }
  if (bc) {
    bc.onmessage = (e) => {
      const d = e.data || {};
      if (d.type === 'state') adopt(d.state);
      else if (d.type === 'want' && state && state.at && !state.error && !!state.everyone === !!settings.showEveryone) bc.postMessage({ type: 'state', state });
    };
  }
  const share = () => { if (bc && state && !state.error) bc.postMessage({ type: 'state', state }); };

  // Background checks (page load, timer, coming back to the tab, a change seen on another PC) are
  // skipped when a fresh result exists or Halaxy has asked scripts to pause. "Check now" and this
  // tab's own saves always check. Only one tab on the PC checks at a time.
  function refresh(why) {
    if (running) return Promise.resolve();
    if (why !== 'manual' && why !== 'trigger' && why !== 'setting') {
      const fresh = FRESH_MS[why];
      if (fresh && state && !state.error && !!state.everyone === !!settings.showEveryone && Date.now() - (state.at || 0) < fresh) return Promise.resolve();
      if (window.UPC && UPC.http && UPC.http.pausedFor && UPC.http.pausedFor() > 0) return Promise.resolve();
      if (why === 'poll' && window.UPC && UPC.background && !UPC.background.active()) return Promise.resolve();   // nobody at this PC for 30 minutes
    }
    if (navigator.locks && navigator.locks.request) {
      return navigator.locks.request('hx-outstanding-check', { ifAvailable: true }, (lock) => (lock ? doRefresh(why) : null));
    }
    return doRefresh(why);
  }

  async function loadPractitioners() {
    if (memo.practitioners && Date.now() - memo.practitionersAt < 3600e3) return memo.practitioners;
    const list = await getJSON('/lookup/practitioner?clinic=&include_id=&type=');
    memo.practitioners = (Array.isArray(list) ? list : []).map(p => ({ id: String(p.id), name: p.name }));
    memo.practitionersAt = Date.now();
    return memo.practitioners;
  }

  async function loadColourMap() {
    if (memo.colourMap && Date.now() - memo.feesAt < 3600e3) return memo.colourMap;
    const fees = await getJSON('/funder/fee/data');
    const re = SELF_FUNDED_RE();
    const map = {}; // colour -> { sf: n, ins: n }
    (Array.isArray(fees) ? fees : []).forEach(f => {
      if (f.status && String(f.status).toLowerCase() !== 'current') return;
      const c = normColour(f.feeColour);
      if (!c) return;
      map[c] = map[c] || { sf: 0, ins: 0 };
      if (re.test(String(f.funder || ''))) map[c].sf++; else map[c].ins++;
    });
    memo.colourMap = map;
    memo.feesAt = Date.now();
    return map;
  }

  function classify(colour, map) {
    const e = map[normColour(colour)];
    if (!e) return 'unknown';
    if (e.sf && !e.ins) return 'self';
    if (e.ins && !e.sf) return 'insurer';
    return 'ambiguous';
  }

  // ------------------------------------------------------------------ main check
  async function doRefresh(why) {
    if (running) return;
    running = true;
    setBusy(true);
    try {
      const [pracs, cmap] = await Promise.all([loadPractitioners(), loadColourMap()]);
      const now = Date.now();
      const d0 = new Date(); d0.setHours(0, 0, 0, 0);
      const dayStart = d0.getTime(), dayEnd = dayStart + 86400e3;
      // Wide window (noon yesterday to noon tomorrow) so time-zone handling can't drop events
      const qs = new URLSearchParams({ start: Math.floor((dayStart - 12 * 3600e3) / 1000), end: Math.floor((dayEnd + 12 * 3600e3) / 1000) });
      pracs.forEach((p, i) => qs.append('practitioners[' + i + '][id]', p.id));
      qs.append('_', String(now));
      const cal = await getJSON('/calendar/json?' + qs.toString());
      const events = (cal && cal.payload && cal.payload.events) || [];

      const me = [String(window.HkUser && HkUser.linkPrG || ''), String(window.HkUser && HkUser.pracID || '')];
      const pracName = id => (pracs.find(p => p.id === String(id)) || {}).name || '';
      // Someone with no calendar of their own (reception) sees everyone's appointments.
      const isPrac = pracs.some(p => me.includes(String(p.id)));
      const mineOnly = !settings.showEveryone && isPrac;
      const grace = settings.graceMinutes * 60e3;

      diag = {
        version: VERSION, at: new Date().toISOString(), why,
        practitioners: pracs.length, events: events.length,
        requestStatuses: {}, appointmentStatuses: {}, noteStatuses: {}, invoiceStatuses: {}, colourClasses: {},
        attendedFinished: 0, notesChecked: 0, invoicesChecked: 0, unclassified: 0,
        practitionerIdsMatched: 0, patientInvoiceStatusesByClass: {}
      };

      const todays = events.filter(ev => {
        if (ev.type !== 'appointment') return false;
        const s = toMs(ev.start);
        diag.requestStatuses[ev.requestStatus || '(empty)'] = (diag.requestStatuses[ev.requestStatus || '(empty)'] || 0) + 1;
        diag.invoiceStatuses[ev.invoiceStatus || '(empty)'] = (diag.invoiceStatuses[ev.invoiceStatus || '(empty)'] || 0) + 1;
        if (pracs.some(p => p.id === String(ev.practitionerID))) diag.practitionerIdsMatched++;
        return s >= dayStart && s < dayEnd;
      });

      const items = [];
      const unchecked = [];
      const invoiceLists = {}; // per patient, this refresh only

      for (const ev of todays) {
        // Halaxy leaves appointmentStatus blank for normal appointments and fills it only for
        // exceptions (cancelled, did-not-attend, ...). requestStatus belongs to online booking requests.
        const apptStatus = String(ev.appointmentStatus || '').toLowerCase();
        diag.appointmentStatuses[apptStatus || '(blank)'] = (diag.appointmentStatuses[apptStatus || '(blank)'] || 0) + 1;
        if (NOT_ATTENDED.test(apptStatus)) continue;
        if (ev.isRequest && /pending|reject|declin/i.test(String(ev.requestStatus || ''))) continue;
        if (toMs(ev.end) + grace > now) continue;
        if (ev.isGroupAppointment === true) continue;
        if (mineOnly && !me.includes(String(ev.practitionerID))) continue;
        diag.attendedFinished++;

        const lpg = ev.linkPaGId || ev.linkPaG;
        const base = {
          apptId: ev.id, start: toMs(ev.start), patient: textOf(ev.title), practitioner: pracName(ev.practitionerID),
          lpg, noteID: ev.noteID, invoiceID: ev.invoiceID
        };

        // --- note: the calendar data carries the note status as a CSS class
        const noteCss = String(ev.noteStatusCss || '').toLowerCase();
        diag.noteStatuses[noteCss || '(none)'] = (diag.noteStatuses[noteCss || '(none)'] || 0) + 1;
        if (!ev.noteID) {
          items.push(Object.assign({ kind: 'note', label: 'No clinical note' }, base));
        } else if (/published|locked/.test(noteCss)) {
          memo.noteDone.add(ev.noteID);
        } else if (/empty/.test(noteCss)) {
          items.push(Object.assign({ kind: 'note', label: 'Note not started' }, base));
        } else if (/draft/.test(noteCss)) {
          items.push(Object.assign({ kind: 'note', label: 'Note in draft' }, base));
        } else if (!memo.noteDone.has(ev.noteID)) {
          // Unknown or missing class: ask the note itself
          diag.notesChecked++;
          const note = await getJSON('/note/' + ev.noteID);
          const status = String(note && note.status || '').toLowerCase();
          if (status === 'published' || status === 'locked') memo.noteDone.add(ev.noteID);
          else {
            const empty = !textOf(note && note.content).replace(/\s+/g, '');
            items.push(Object.assign({ kind: 'note', label: empty ? 'Note not started' : 'Note in draft' }, base));
          }
        }

        // --- invoice (self-funded only)
        const cls = classify(ev.colour, cmap);
        diag.colourClasses[cls] = (diag.colourClasses[cls] || 0) + 1;
        if (cls === 'insurer') continue;
        if (!ev.invoiceID) continue;
        if (memo.invoiceDone.has(ev.invoiceID)) continue;
        if (/paid in full/i.test(ev.invoiceStatus || '')) { memo.invoiceDone.add(ev.invoiceID); continue; }
        if (cls !== 'self') {
          diag.unclassified++;
          unchecked.push(Object.assign({ kind: 'unchecked', label: 'Funder unclear: check invoice' }, base));
          continue;
        }
        diag.invoicesChecked++;
        if (!invoiceLists[lpg]) invoiceLists[lpg] = await getJSON('/patient/invoice/' + lpg + '/list-data');
        const row = (invoiceLists[lpg] || []).find(r => String(r.id) === String(ev.invoiceID));
        if (row) {
          const k = cls + ':' + (row.status || '?');
          diag.patientInvoiceStatusesByClass[k] = (diag.patientInvoiceStatusesByClass[k] || 0) + 1;
        }
        if (!row) {
          unchecked.push(Object.assign({ kind: 'unchecked', label: 'Invoice not found: check' }, base));
        } else if (Number(row.total) <= 0 || Number(row.balance) <= 0) {
          memo.invoiceDone.add(ev.invoiceID);
        } else {
          items.push(Object.assign({ kind: 'invoice', label: 'Unpaid ' + money(row.balance), invoiceNum: row.invoiceId }, base));
        }
      }

      items.sort((a, b) => a.start - b.start || a.kind.localeCompare(b.kind));
      state = { day: todayKey(), at: Date.now(), items, unchecked, error: null, everyone: !!settings.showEveryone, notPrac: !isPrac };
    } catch (e) {
      state = Object.assign({}, state || { day: todayKey(), items: [], unchecked: [] }, {
        error: e instanceof FetchError ? e.message : 'check failed (' + (e && e.message || e) + ')',
        errorAt: Date.now()
      });
      diag.error = String(e && e.message || e);
    } finally {
      writeJSON(sessionStorage, CACHE_KEY, state);
      running = false;
      setBusy(false);
      render();
      share();
    }
  }

  // ------------------------------------------------------------------ UI
  let host, root;
  // Halaxy's own classes (card, card-header, btn) style the panel; these rules only place it and
  // lay out its rows, scoped to our element, using Halaxy's colour variables.
  const CSS = `
    /* Bottom centre of the content area: clear of the patient side panel and the booking panel's Save. */
    .upc-oa { position: fixed; left: var(--upc-oa-centre, 50%); transform: translateX(-50%); bottom: 12px; z-index: 90; display: flex; flex-direction: column; align-items: center; gap: 8px; }
    /* Halaxy's red button is filled, and an unfilled outline on hover. A white backing that Halaxy's
       styles never touch sits behind it, so the page never shows through, whatever Halaxy does on hover. */
    .upc-oa .upc-oa-back { display: inline-flex; background: #fff; border-radius: 4.8px; box-shadow: 0 4px 14px rgba(0,0,0,.25); }
    .upc-oa .upc-oa-back > .btn { margin: 0; }

    .upc-oa .upc-oa-panel { width: 380px; max-width: calc(100vw - 32px); max-height: 60vh; display: flex; flex-direction: column; margin: 0;
      box-shadow: 0 8px 16px rgba(0,0,0,.2); overflow: hidden; }
    .upc-oa .card-header { display: flex; align-items: center; justify-content: space-between; }
    .upc-oa .card-header h2 { margin: 0; }
    .upc-oa .upc-oa-list { overflow-y: auto; }
    .upc-oa .upc-oa-row { display: grid; grid-template-columns: 44px 1fr auto; gap: 4px 8px; align-items: center; padding: 8px 12px;
      border-bottom: 1px solid var(--vs-table-border-color, #ced4da); }
    .upc-oa .upc-oa-row:nth-child(odd) { background: var(--vs-div-table-row-odd-bg-color, #f8f9fa); }
    .upc-oa .upc-oa-time { font-variant-numeric: tabular-nums; }
    .upc-oa .upc-oa-who { min-width: 0; }
    .upc-oa .upc-oa-who b { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .upc-oa .upc-oa-tags { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
    .upc-oa .upc-oa-tag { font-size: .86em; font-weight: 600; border-radius: 4.8px; padding: 1px 6px; white-space: nowrap; border: 1px solid transparent; }
    .upc-oa .upc-oa-tag.note { background: #fff3e0; border-color: #ffd8a8; color: #8a4b00; }
    .upc-oa .upc-oa-tag.invoice { background: #fdecea; border-color: var(--vs-balance-negative-color, #ec6b65); color: #a01818; }
    .upc-oa .upc-oa-tag.unchecked { background: var(--vs-status-badge-neutral-bg-color, #f0f0f5); border-color: var(--vs-status-badge-neutral-border-color, #dee2e6); color: var(--vs-status-badge-color, #333); }
    .upc-oa .upc-oa-acts { display: flex; gap: 10px; grid-column: 2 / 4; }
    .upc-oa .upc-oa-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 12px; background: var(--vs-card-header-bg-color, #f0f0f5);
      border-top: 1px solid var(--vs-card-border-color, #ced4da); }
    .upc-oa .upc-oa-foot .upc-oa-scope { margin-right: auto; }
    .upc-oa .upc-oa-foot label { display: flex; align-items: center; gap: 4px; margin: 0 auto 0 0; cursor: pointer; }
    .upc-oa .upc-oa-foot .btn { margin: 0; }
    .upc-oa .upc-oa-dot { width: 14px; height: 14px; border-radius: 50%; border: 2px solid #fff; background: var(--success, #28a745); opacity: .55; cursor: pointer;
      box-shadow: 0 1px 4px rgba(0,0,0,.3); padding: 0; }
    .upc-oa .upc-oa-dot:hover, .upc-oa .upc-oa-dot[aria-expanded="true"] { opacity: 1; }
    .upc-oa .upc-oa-none { padding: 14px 12px; color: var(--success, #28a745); }
    .upc-oa .upc-oa-err { padding: 8px 12px; color: #a01818; background: #fdecea; }
    .upc-oa.upc-oa-busy { opacity: .6; }
  `;

  function el(tag, attrs, kids) {
    const e = document.createElement(tag);
    for (const k in (attrs || {})) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(c => c && e.appendChild(c));
    return e;
  }

  // Centre of the content area, between Halaxy's side menu and the right edge.
  function sidebarRight() {
    const menu = document.getElementById('mainMenu');
    if (!menu) return 0;
    let right = 0;
    for (let e = menu; e && e !== document.body; e = e.parentElement) {
      const r = e.getBoundingClientRect();
      if (r.width && r.left <= 1 && r.width < window.innerWidth / 2) right = Math.max(right, r.right);
    }
    return right;
  }
  function place() {
    if (host) host.style.setProperty('--upc-oa-centre', Math.round((sidebarRight() + window.innerWidth) / 2) + 'px');
  }
  window.addEventListener('resize', place);
  let watchedMenu = null;
  function watchMenu() {
    const menu = document.getElementById('mainMenu');
    if (!menu || menu === watchedMenu || typeof ResizeObserver !== 'function') return;
    watchedMenu = menu;
    new ResizeObserver(place).observe(menu.parentElement || menu);   // menu collapsed or expanded
  }

  function buildUi() {
    if (host || window.top !== window) return;
    if (!document.getElementById('upc-oa-css')) document.head.appendChild(el('style', { id: 'upc-oa-css', text: CSS }));
    host = el('div', { class: 'upc-native upc-oa', 'data-hx-outstanding': VERSION });
    root = host;
    document.body.appendChild(host);
    render();
  }

  function setBusy(b) { if (root) root.classList.toggle('upc-oa-busy', b); }

  function render() {
    watchMenu();
    place();
    if (!root) return;
    const wrap = root;
    wrap.textContent = '';
    if (!state) return;
    const items = state.items || [];
    const unchecked = state.unchecked || [];
    const nNotes = items.filter(i => i.kind === 'note').length;
    const nInv = items.filter(i => i.kind === 'invoice').length;
    const total = items.length + unchecked.length;

    const clear = !total && !state.error;
    if (!settings.collapsed) wrap.appendChild(buildPanel(items, unchecked));
    const toggle = () => { settings.collapsed = !settings.collapsed; saveSettings(); render(); };

    if (clear) {
      // All clear: a small, quiet dot so the panel and diagnostics stay reachable
      wrap.appendChild(el('button', {
        class: 'upc-oa-dot', type: 'button', 'aria-expanded': String(!settings.collapsed),
        title: 'Nothing outstanding today' + (state.at ? ' (checked ' + hhmm(state.at) + ')' : ''),
        'aria-label': 'Nothing outstanding today', onclick: toggle
      }));
      return;
    }

    const parts = [];
    if (nNotes) parts.push(nNotes + ' note' + (nNotes > 1 ? 's' : ''));
    if (nInv) parts.push(nInv + ' unpaid');
    if (unchecked.length) parts.push(unchecked.length + ' to check');
    const label = total ? 'Outstanding today: ' + parts.join(' · ') : 'Outstanding check not working';
    const pill = el('button', {
      class: 'btn upc-oa-pill ' + (total ? 'btn-danger' : 'btn-outline-primary'), type: 'button', title: state.error ? 'Last check failed: ' + state.error : 'Click to ' + (settings.collapsed ? 'show' : 'hide'),
      'aria-expanded': String(!settings.collapsed),
      onclick: toggle
    }, [el('span', { text: label })]);
    wrap.appendChild(el('span', { class: 'upc-oa-back' }, [pill]));
  }

  function buildPanel(items, unchecked) {
    const checked = state.at ? 'Checked ' + hhmm(state.at) : '';
    const panel = el('div', { class: 'card upc-oa-panel', role: 'region', 'aria-label': 'Outstanding actions today' }, [
      el('div', { class: 'card-header' }, [el('h2', { text: settings.showEveryone || state.notPrac ? 'Outstanding today' : 'Your outstanding today' }), el('span', { class: 'text-muted', text: checked })])
    ]);
    if (state.error) panel.appendChild(el('div', { class: 'upc-oa-err', text: 'Last check failed: ' + state.error + '. Showing the previous result.' }));
    const list = el('div', { class: 'upc-oa-list' });
    // One row per appointment, with every outstanding issue on it
    const groups = [];
    items.concat(unchecked).forEach(it => {
      let g = groups.find(x => x.apptId === it.apptId);
      if (!g) groups.push(g = { apptId: it.apptId, first: it, issues: [] });
      g.issues.push(it);
    });
    groups.sort((a, b) => a.first.start - b.first.start);
    groups.forEach(g => {
      const it = g.first;
      const acts = [];
      if (g.issues.some(i => i.kind === 'note') && it.noteID && it.lpg) acts.push(el('a', { href: BASE + '/patient/' + it.lpg + '/clinical/category/note/id/' + it.noteID, text: 'Open note' }));
      if (g.issues.some(i => i.kind !== 'note') && it.invoiceID) acts.push(el('a', { href: BASE + '/invoice/' + it.invoiceID, text: 'Open invoice' }));
      acts.push(el('a', { href: BASE + '/appointment/' + it.apptId, text: 'Appointment' }));
      const order = { note: 0, invoice: 1, unchecked: 2 };
      const tags = g.issues.slice().sort((a, b) => order[a.kind] - order[b.kind]).map(i => el('span', { class: 'upc-oa-tag ' + i.kind, text: i.label }));
      list.appendChild(el('div', { class: 'upc-oa-row' }, [
        el('span', { class: 'upc-oa-time', text: hhmm(it.start) }),
        el('div', { class: 'upc-oa-who' }, [el('b', { text: it.patient || 'Patient' }), el('span', { class: 'text-muted', text: it.practitioner })]),
        el('div', { class: 'upc-oa-tags' }, tags),
        el('div', { class: 'upc-oa-acts' }, acts)
      ]));
    });
    if (!groups.length) list.appendChild(el('div', { class: 'upc-oa-none', text: state.error ? 'No result yet.' : 'Nothing outstanding today.' }));
    panel.appendChild(list);
    panel.appendChild(el('div', { class: 'upc-oa-foot' }, [
      state.notPrac
        ? el('span', { class: 'text-muted upc-oa-scope', text: 'Everyone\'s appointments (you have none of your own)' })
        : el('label', {}, [
          (() => { const c = el('input', { type: 'checkbox' }); c.checked = !!settings.showEveryone; c.addEventListener('change', () => { settings.showEveryone = c.checked; saveSettings(); refresh('setting'); }); return c; })(),
          el('span', { text: 'Show everyone' })
        ]),
      el('button', { type: 'button', class: 'btn btn-outline-primary-light', text: 'Check now', onclick: () => refresh('manual') }),
      el('button', { type: 'button', class: 'btn btn-outline-primary-light', text: 'Copy diagnostics', title: 'Copies counts and status codes only, no patient details', onclick: copyDiag })
    ]));
    return panel;
  }

  function copyDiag() {
    const out = JSON.stringify(Object.assign({}, diag, { colourMap: memo.colourMap, settings }), null, 1);
    try { navigator.clipboard.writeText(out); } catch (e) {}
    console.log('[Halaxy Outstanding] diagnostics', out);
  }

  // ------------------------------------------------------------------ start
  function start() {
    buildUi();
    // Ask the other tabs for their result first; check only if none is fresh.
    if (bc) { bc.postMessage({ type: 'want' }); setTimeout(() => refresh('load'), 400); } else refresh('load');
    setInterval(() => { if (document.visibilityState === 'visible') refresh('poll'); }, settings.pollMinutes * 60e3);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && (!state || Date.now() - (state.at || 0) > 60e3)) refresh('focus');
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.hxOutstanding = { version: VERSION, refresh, state: () => state, diag: () => diag, settings };
})();
