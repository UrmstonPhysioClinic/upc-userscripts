// ==UserScript==
// @name         Halaxy Outstanding Actions (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.2.0
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
 */

(function () {
  'use strict';
  if (window.__hxOutstanding) return;
  window.__hxOutstanding = true;

  const VERSION = '0.2.0';
  const m = location.pathname.match(/^\/a\/pr\/(\d+)\//);
  if (!m) return;
  const PG = m[1];
  const BASE = '/a/pr/' + PG;

  // ------------------------------------------------------------------ settings (no patient data)
  const SET_KEY = 'hxOutstanding.settings';
  const settings = Object.assign({
    mineOnly: false,          // show only my appointments
    graceMinutes: 0,          // flag this many minutes after the appointment ends
    pollMinutes: 2,
    selfFundedPattern: 'self|private',
    collapsed: true
  }, readJSON(localStorage, SET_KEY) || {});
  const saveSettings = () => writeJSON(localStorage, SET_KEY, settings);
  const SELF_FUNDED_RE = () => new RegExp(settings.selfFundedPattern, 'i');

  function readJSON(store, k) { try { return JSON.parse(store.getItem(k) || 'null'); } catch (e) { return null; } }
  function writeJSON(store, k, v) { try { store.setItem(k, JSON.stringify(v)); } catch (e) {} }

  // ------------------------------------------------------------------ refresh triggers (installed at document-start)
  let refreshTimer = null;
  function scheduleRefresh(ms) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refresh('trigger'), ms);
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
          es.addEventListener('message', ev => { if (/"appointment"/.test(String(ev.data))) scheduleRefresh(4000); });
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
  async function getJSON(path) {
    const res = await oFetch.call(window, BASE + path, {
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
  async function refresh(why) {
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
        if (settings.mineOnly && !me.includes(String(ev.practitionerID))) continue;
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
      state = { day: todayKey(), at: Date.now(), items, unchecked, error: null };
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
    }
  }

  // ------------------------------------------------------------------ UI
  let host, root;
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .wrap { position: fixed; right: 16px; bottom: 16px; z-index: 90; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
    .pill { display: flex; align-items: center; gap: 8px; border: 0; border-radius: 999px; padding: 8px 14px; font-size: 13px; font-weight: 600;
            color: #fff; background: #c62828; box-shadow: 0 4px 14px rgba(0,0,0,.25); cursor: pointer; }
    .pill.warn { background: #6b6b6b; }
    .pill .n { background: rgba(255,255,255,.25); border-radius: 999px; padding: 1px 8px; }
    .pill:focus-visible, button:focus-visible, a:focus-visible { outline: 2px solid #1565c0; outline-offset: 2px; }
    .panel { width: 380px; max-width: calc(100vw - 32px); max-height: 60vh; display: flex; flex-direction: column; background: #fff; color: #222;
             border: 1px solid #d0d0d0; border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.22); overflow: hidden; }
    .hd { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid #eee; font-size: 14px; font-weight: 700; }
    .hd .sub { font-weight: 400; color: #666; font-size: 12px; }
    .list { overflow-y: auto; }
    .row { display: grid; grid-template-columns: 44px 1fr auto; gap: 8px; align-items: center; padding: 8px 12px; border-bottom: 1px solid #f1f1f1; font-size: 13px; }
    .t { color: #555; font-variant-numeric: tabular-nums; }
    .who { min-width: 0; }
    .who b { display: block; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .who span { color: #666; font-size: 12px; }
    .tags { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
    .tag { font-size: 11px; font-weight: 600; border-radius: 4px; padding: 2px 6px; white-space: nowrap; }
    .tag.note { background: #fff3e0; color: #8a4b00; }
    .tag.invoice { background: #ffebee; color: #a01818; }
    .tag.unchecked { background: #eceff1; color: #455a64; }
    .acts { display: flex; gap: 6px; grid-column: 2 / 4; }
    .acts a { font-size: 12px; color: #1565c0; text-decoration: none; }
    .acts a:hover { text-decoration: underline; }
    .ft { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 8px 12px; font-size: 12px; color: #555; background: #fafafa; }
    .ft label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
    .ft button { font: inherit; font-size: 12px; padding: 3px 8px; border: 1px solid #ccc; border-radius: 5px; background: #fff; cursor: pointer; }
    .dot { width: 14px; height: 14px; border-radius: 50%; border: 2px solid #fff; background: #2e7d32; opacity: .55; cursor: pointer;
           box-shadow: 0 1px 4px rgba(0,0,0,.3); padding: 0; }
    .dot:hover, .dot[aria-expanded="true"] { opacity: 1; }
    .none { padding: 14px 12px; font-size: 13px; color: #2e7d32; }
    .err { padding: 8px 12px; font-size: 12px; color: #a01818; background: #ffebee; }
    .busy { opacity: .6; }
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

  function buildUi() {
    if (host || window.top !== window) return;
    host = document.createElement('div');
    host.setAttribute('data-hx-outstanding', VERSION);
    root = host.attachShadow({ mode: 'open' });
    root.appendChild(el('style', { text: CSS }));
    root.appendChild(el('div', { class: 'wrap' }));
    document.body.appendChild(host);
    render();
  }

  function setBusy(b) { if (root) root.querySelector('.wrap').classList.toggle('busy', b); }

  function render() {
    if (!root) return;
    const wrap = root.querySelector('.wrap');
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
        class: 'dot', type: 'button', 'aria-expanded': String(!settings.collapsed),
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
      class: 'pill' + (total ? '' : ' warn'), type: 'button', title: state.error ? 'Last check failed: ' + state.error : 'Click to ' + (settings.collapsed ? 'show' : 'hide'),
      'aria-expanded': String(!settings.collapsed),
      onclick: toggle
    }, [el('span', { text: label })]);
    wrap.appendChild(pill);
  }

  function buildPanel(items, unchecked) {
    const checked = state.at ? 'Checked ' + hhmm(state.at) : '';
    const panel = el('div', { class: 'panel', role: 'region', 'aria-label': 'Outstanding actions today' }, [
      el('div', { class: 'hd' }, [el('span', { text: 'Outstanding today' }), el('span', { class: 'sub', text: checked })])
    ]);
    if (state.error) panel.appendChild(el('div', { class: 'err', text: 'Last check failed: ' + state.error + '. Showing the previous result.' }));
    const list = el('div', { class: 'list' });
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
      const tags = g.issues.slice().sort((a, b) => order[a.kind] - order[b.kind]).map(i => el('span', { class: 'tag ' + i.kind, text: i.label }));
      list.appendChild(el('div', { class: 'row' }, [
        el('span', { class: 't', text: hhmm(it.start) }),
        el('div', { class: 'who' }, [el('b', { text: it.patient || 'Patient' }), el('span', { text: it.practitioner })]),
        el('div', { class: 'tags' }, tags),
        el('div', { class: 'acts' }, acts)
      ]));
    });
    if (!groups.length) list.appendChild(el('div', { class: 'none', text: state.error ? 'No result yet.' : 'Nothing outstanding today.' }));
    panel.appendChild(list);
    panel.appendChild(el('div', { class: 'ft' }, [
      el('label', {}, [
        (() => { const c = el('input', { type: 'checkbox' }); c.checked = settings.mineOnly; c.addEventListener('change', () => { settings.mineOnly = c.checked; saveSettings(); refresh('setting'); }); return c; })(),
        el('span', { text: 'Only mine' })
      ]),
      el('button', { type: 'button', text: 'Check now', onclick: () => refresh('manual') }),
      el('button', { type: 'button', text: 'Copy diagnostics', title: 'Copies counts and status codes only, no patient details', onclick: copyDiag })
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
    refresh('load');
    setInterval(() => { if (document.visibilityState === 'visible') refresh('poll'); }, settings.pollMinutes * 60e3);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && (!state || Date.now() - (state.at || 0) > 60e3)) refresh('focus');
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.hxOutstanding = { version: VERSION, refresh, state: () => state, diag: () => diag, settings };
})();
