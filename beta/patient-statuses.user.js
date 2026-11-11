// ==UserScript==
// @name         Halaxy patient statuses (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.2.1
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/patient-statuses.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/patient-statuses.user.js
// @description  Keeps patient statuses up to date by itself (Current, Claimant, Discharged; Contacts who book are moved over), in the background while Carl is signed in. Review and every other status are left alone. "Patient statuses: recent changes" lists what it changed.
// @match        https://*.halaxy.com/a/pr/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * Patient statuses (Carl, 11 Nov 2026). Housekeeping, done automatically (Carl, 11 Nov 2026: "lets just automate this
 * now and remove the menu"), after he checked 0.1.x's suggestions on real patients.
 *
 *  - Only Current, Claimant and Discharged are set. Review is set by hand (Carl: "not something that should be guessed
 *    at"), and Archived, Waiting List, Blocked and the rest are left alone. A Contact (only another patient's contact,
 *    hidden from searches) who has an appointment, say booked online, is moved to the usual statuses.
 *  - From one calendar request (6 months back, 4 months ahead):
 *    - Something booked: Current if self-funded, Claimant if funded (the next booked appointment).
 *      This also brings back a Discharged patient who has booked again.
 *    - Nothing booked, and no appointment for 6 weeks or more: Discharged (open-ended patients too).
 *    - Nothing booked, seen in the last 6 weeks: Discharged if their last note says so ("discharged", "goals met",
 *      "no further treatment needed", "self-managing"); otherwise Current or Claimant from their last appointment.
 *  - Funded or not (Carl: the latest fee): booked with an Insurance or Referral appointment type (the appointment's title
 *    starts with the type; its colour as a fallback), else the fee's own funder in Halaxy's fee list, or the invoice
 *    linked to an insurance claim.
 *  - Runs in the visible tab, at most every 30 minutes, shared across tabs, only while Carl is signed in (so the changes
 *    are his in Halaxy's status history), and skips while Halaxy is busy. Changed on the patient's Edit page (core
 *    UPC.patient.setStatus), only if the status still reads what was seen, at most 40 a run.
 *  - "Patient statuses: recent changes" (Script settings, or the Tampermonkey menu) lists the last 100 changes and any
 *    that failed. A layout change is passed to the health check.
 */
(() => {
  'use strict';
  if (window.__hxPatientStatuses) return;
  window.__hxPatientStatuses = true;

  const VERSION = '0.2.1';
  const ALLOWED = ['Carl Healy'];
  const DAY = 86400e3;
  const GAP_DAYS = 42;          // Carl, 11 Nov 2026: a gap counts; 6 weeks
  const BACK_DAYS = 183, AHEAD_DAYS = 122;
  const MANAGED = ['current', 'claimant', 'discharged'];
  const FROM = MANAGED.concat(['contact']);
  const SELF_FUNDED = /self|private/i;
  const FUNDED_TYPE = /insurance|referral/i;
  const KNOWN = MANAGED.concat(['review', 'archived', 'waiting list', 'blocked', 'deleted', 'deceased', 'contact', 'lead']);
  const NAME = { current: 'Current', claimant: 'Claimant', discharged: 'Discharged', contact: 'Contact' };
  const EVERY = 30 * 60e3, MAX_CHANGES = 40, LOG_SIZE = 100;
  const KEY = 'upc-ps:';

  const U = () => window.UPC;
  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(KEY + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
  };
  const label = (ms) => U().dayLabel(ms);
  const norm = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

  function userName() {
    const h = window.HkUser || {};
    const named = String(h.pracName || (h.CalendarDefault || {}).pracName || '').trim();
    if (named) return named;
    const btn = document.getElementById('activeUser');
    if (btn && btn.textContent.trim()) return btn.textContent.replace(/\s+/g, ' ').trim();
    const el = [...document.querySelectorAll('header *, nav *, .navbar *, #top *, #headerWrapper *')]
      .find((e) => !e.children.length && ALLOWED.some((n) => n.toLowerCase() === e.textContent.trim().toLowerCase()));
    return el ? el.textContent.trim() : '';
  }
  const allowed = () => ALLOWED.some((n) => n.toLowerCase() === userName().toLowerCase());
  // Halaxy may not have filled in who's signed in when this script starts (it starts early in the load order: live,
  // 11 Nov 2026), so keep looking for 20 seconds before deciding it isn't for this person.
  function whenAllowed(fn) {
    if (allowed()) return fn();
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (allowed()) { clearInterval(timer); fn(); } else if (Date.now() - t0 > 20000) clearInterval(timer);
    }, 500);
  }

  // Treatment finished, in the last note. "See as needed" and similar open-ended wording don't count: those patients
  // are discharged by the 6-week gap instead.
  const FINISHED = /\bdischarg(ed|e)\b|\bgoals? (met|achieved|reached)\b|\bno (further|more) (treatment|physio|physiotherapy|sessions?|appointments?) (needed|required|necessary)\b|\bself[- ]?manag/i;
  const NEGATION = /\b(not|no longer|never|isn'?t|wasn'?t|hasn'?t|without|unable to|not yet|before)\b[^.]{0,20}$/i;
  function saysFinished(text) {
    const g = new RegExp(FINISHED.source, 'gi');
    let m;
    while ((m = g.exec(text))) {
      if (!NEGATION.test(text.slice(Math.max(0, m.index - 30), m.index))) return m[0].toLowerCase();
    }
    return '';
  }

  async function calendar(fromMs, toMs, say) {
    say('Reading the calendar...');
    const pracs = await U().http.json('/lookup/practitioner?clinic=&include_id=&type=');
    const qs = new URLSearchParams({ start: Math.floor(fromMs / 1000), end: Math.floor(toMs / 1000) });
    (Array.isArray(pracs) ? pracs : []).forEach((p, i) => qs.append('practitioners[' + i + '][id]', p.id));
    const cal = await U().http.json('/calendar/json?' + qs.toString());
    return ((cal && cal.payload && cal.payload.events) || []).filter((e) => e.type === 'appointment' && e.linkPaGId);
  }

  async function check(say) {
    say = say || (() => {});
    const now = Date.now();
    const funded = store.get('funded2', {});     // invoice id -> true (funded) / false (self-funded)
    const finished = store.get('finished', {});  // note id -> wording found ('' if none)
    const events = await calendar(now - BACK_DAYS * DAY, now + AHEAD_DAYS * DAY, say);
    const startMs = (e) => (typeof e.start === 'number' ? e.start * 1000 : Date.parse(e.start));
    const byPatient = new Map();
    events.forEach((e) => { const id = String(e.linkPaGId); if (!byPatient.has(id)) byPatient.set(id, []); byPatient.get(id).push(e); });
    const counts = { other: 0, right: 0, unknown: 0 };
    // Appointment types (Halaxy's placeholders, booked online without a fee): an appointment booked with one has no
    // invoice and shows in the type's colour (capture, 11 Nov 2026; the calendar doesn't name the type). Active types
    // titled Insurance or Referral are funded. Archived ones ("Appointment Available") are ignored.
    say('Reading the appointment types...');
    const types = await U().http.json('/profile/group/appointmenttypes/data');
    if (!Array.isArray(types) || (types.length && !types.some((t) => t && 'backgroundColor' in t && 'title' in t))) throw new (U().Error)('Halaxy\'s appointment types list has changed (title or colour not found).');
    const typeColour = {};
    const active = types.filter((t) => t && /^active$/i.test(String(t.status || '')) && t.title);
    active.filter((t) => t.backgroundColor).forEach((t) => { typeColour[String(t.backgroundColor).toUpperCase()] = FUNDED_TYPE.test(String(t.title || '')); });
    // The appointment's title starts with its type ("2a. Insurance/Referral: ... - Patient Name", live 11 Nov 2026).
    const titleText = (e) => U().clean(U().htmlDoc(e.title || '').body.textContent);
    const typeOf = (e) => { const t = titleText(e).toLowerCase(); return active.find((x) => t.startsWith(U().clean(x.title).toLowerCase())) || null; };
    const nameOf = (e) => {
      const ty = typeOf(e);
      let t = titleText(e);
      if (ty) { const i = t.lastIndexOf(' - '); t = i >= 0 ? t.slice(i + 3) : t.slice(U().clean(ty.title).length); }   // "type - Patient Name (phone)"
      return t.replace(/\s*\(?\+?[\d ]{9,}\)?\s*$/, '').replace(/^[\s*★]+/, '').trim() || 'Patient';
    };
    const rows = [];
    // Funded: the fee's own funder (set by the fee, which the appointment type sets, so an online booking counts before
    // any claim exists), or the invoice being linked to an insurance claim.
    let feeFunder = null;
    let sharedColour = null;   // insurance type colours that a self-funded fee also uses (then colour alone can't tell)
    const loadFees = async () => {
      if (feeFunder) return;
      const fees = await U().http.json('/funder/fee/data');
      feeFunder = {};
      sharedColour = new Set();
      (Array.isArray(fees) ? fees : []).forEach((f) => {
        if (!f) return;
        if (f.feeNumber) feeFunder[U().clean(f.feeNumber).toLowerCase()] = String(f.funder || '');
        const c = String(f.feeColour || '').toUpperCase();
        if (typeColour[c] === true && SELF_FUNDED.test(String(f.funder || ''))) sharedColour.add(c);
      });
    };
    const fundedOf = async (e) => {
      const ty = typeOf(e);
      if (ty) return FUNDED_TYPE.test(String(ty.title));   // booked with an appointment type: the type says
      const c = String(e.colour || '').toUpperCase();
      const iid = e.invoiceID || e.invoiceId;
      if (!iid) return typeColour[c] === true ? true : c in typeColour ? false : null;   // booked with a type, no fee
      await loadFees();
      if (typeColour[c] === true && !sharedColour.has(c)) return true;   // an insurance type (its colour), fee added or not
      if (!(String(iid) in funded)) {
        const inv = await U().invoice.fetch(iid);
        const byFee = inv.lines.some((l) => { const f = feeFunder[U().clean(l.item).toLowerCase()]; return !!f && !SELF_FUNDED.test(f); });
        funded[iid] = byFee || !!inv.claimId;
        store.set('funded2', funded);
      }
      return funded[iid];
    };
    const list = [...byPatient.entries()];
    let n = 0;
    for (const [id, evs] of list) {
      n++;
      evs.sort((a, b) => startMs(a) - startMs(b));
      const name = nameOf(evs[evs.length - 1]);
      let status = norm(evs.map((e) => e.patientStatus).filter(Boolean).pop());
      const future = evs.filter((e) => startMs(e) >= now && !/cancel|reject|declin|did-not-attend/i.test(e.appointmentStatus || ''));
      const attended = evs.filter((e) => startMs(e) < now && !e.appointmentStatus);
      if (!future.length && !attended.length) continue;
      const tell = (t) => say(t + ' (' + n + ' of ' + list.length + ')...');
      try {
        // The calendar carries each patient's status; if it isn't one of Halaxy's status names, ask the patient's details.
        if (!KNOWN.includes(status)) { tell('Reading ' + name + '\'s status'); status = norm((await U().patient.details(id)).status); }
        if (!FROM.includes(status)) { counts.other++; continue; }
        let to = '', why = '';
        if (future.length) {
          tell('Reading the fee for ' + name);
          const f = await fundedOf(future[0]);
          if (f === null) { counts.unknown++; continue; }
          to = f ? 'claimant' : 'current';
          why = 'Booked ' + label(startMs(future[0])) + ', ' + (f ? 'funded' : 'self-funded');
        } else {
          const last = attended[attended.length - 1];
          const gap = Math.floor((now - startMs(last)) / DAY);
          if (gap >= GAP_DAYS) {
            to = 'discharged';
            why = 'No appointment for ' + Math.floor(gap / 7) + ' weeks (last ' + label(startMs(last)) + '), nothing booked';
          } else if (status !== 'discharged') {
            tell('Reading ' + name + '\'s last note');
            const items = await U().notes.items(id);
            const note = items.find((x) => x.noteId && x.entity === 'note' && (x.category === 'appointment' || x.category === 'note'));
            let said = '';
            if (note) {
              if (!(note.noteId in finished)) { finished[note.noteId] = saysFinished(await U().notes.text(note.noteId)); store.set('finished', finished); }
              said = finished[note.noteId];
            }
            if (said) { to = 'discharged'; why = 'Last note (' + label(note.date || startMs(last)) + ') says "' + said + '", nothing booked'; }
            else {
              const f = await fundedOf(last);
              if (f === null) { counts.unknown++; continue; }
              to = f ? 'claimant' : 'current';
              why = 'Seen ' + label(startMs(last)) + ', ' + (f ? 'funded' : 'self-funded') + ', treatment still going';
            }
          } else { counts.right++; continue; }   // discharged, seen recently, nothing booked: leave it
        }
        if (to === status) { counts.right++; continue; }
        rows.push({ id, name, from: status, to, why });
      } catch (e) {
        if (/has changed/.test(e.message || '')) tellHealthCheck(e);
        rows.push({ id, name, from: status, to: '', why: '', error: e.message || String(e) });
      }
    }
    const order = { discharged: 0, claimant: 1, current: 2, '': 3 };
    rows.forEach((r) => { if (r.from === 'contact' && r.to) r.why = 'Contact with an appointment (not found in searches). ' + r.why; });
    rows.sort((a, b) => order[a.to] - order[b.to] || a.name.localeCompare(b.name));
    const result = { at: Date.now(), by: VERSION, rows, counts, suggested: rows.filter((r) => r.to).length };
    store.set('result', result);
    return result;
  }

  function tellHealthCheck(e) {
    const message = (e && e.message) || String(e);
    if (!/has changed/.test(message)) return;
    document.dispatchEvent(new CustomEvent('upc-loader-error', { detail: JSON.stringify({ file: 'patient-statuses.user.js', message }) }));
  }

  // ------------------------------------------------------------------ automatic updates

  function log(entry) {
    const l = store.get('log', []);
    l.unshift(Object.assign({ at: Date.now() }, entry));
    store.set('log', l.slice(0, LOG_SIZE));
  }

  // One run at a time across tabs; the running tab renews its claim as it goes.
  const locked = () => Date.now() - store.get('running', 0) < 2 * 60e3;
  async function runOnce() {
    store.set('running', Date.now());
    const beat = () => store.set('running', Date.now());
    try {
      const r = await check(beat);
      let n = 0;
      for (const x of r.rows) {
        if (!x.to) { log({ id: x.id, name: x.name, error: x.error }); continue; }
        if (n >= MAX_CHANGES) break;   // the rest next time
        if (U().http.pausedFor() > 0) break;
        beat();
        try {
          if (await U().patient.setStatus(x.id, x.from, x.to)) log({ id: x.id, name: x.name, from: x.from, to: x.to, why: x.why });
          n++;
        } catch (e) {
          log({ id: x.id, name: x.name, from: x.from, to: x.to, why: x.why, error: e.message || String(e) });
          tellHealthCheck(e);
        }
      }
      store.set('lastRun', { at: Date.now(), by: VERSION, changed: n, counts: r.counts });
    } finally {
      store.set('running', 0);
    }
  }
  async function tick() {
    if (!allowed() || document.visibilityState !== 'visible' || !U() || U().http.pausedFor() > 0 || locked()) return;
    const last = store.get('lastRun', null);
    if (last && Date.now() - last.at < EVERY && last.by === VERSION) return;
    try { await runOnce(); } catch (e) { console.warn('[UPC patient statuses]', e); store.set('lastRun', { at: Date.now(), by: VERSION, error: e.message || String(e) }); tellHealthCheck(e); }
  }

  // ------------------------------------------------------------------ recent changes

  function showLog() {
    U().ui.nativeStyles();
    const dlg = U().ui.dialog({ title: 'Patient statuses: recent changes', key: 'upc-patient-statuses-log' });
    if (!dlg) return;
    const base = U().base();
    const l = store.get('log', []), last = store.get('lastRun', null);
    const when = (ms) => label(ms) + ' ' + new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    dlg.root.setAttribute('data-upc-ps-log', '');
    dlg.body.innerHTML = '<p class="text-muted">Statuses are kept up to date by themselves while ' + esc(ALLOWED[0]) + ' is signed in, every 30 minutes. ' +
      (last ? 'Last checked ' + esc(when(last.at)) + (last.error ? ': <span class="upc-err">' + esc(last.error) + '</span>' : ', ' + (last.changed || 0) + ' changed.') : 'Not checked yet.') + '</p>' +
      (l.length ? '<table class="table table-striped table-bordered w-100 m-0"><thead><tr><th>When</th><th>Patient</th><th>Change</th><th>Why</th></tr></thead><tbody>' +
        l.map((x) => '<tr><td>' + esc(when(x.at)) + '</td><td><a href="' + esc(base + '/patient/' + x.id) + '" target="_blank" rel="noopener">' + esc(x.name) + '</a></td>' +
          '<td>' + (x.to ? esc(NAME[x.from] || x.from) + ' to <b>' + esc(NAME[x.to]) + '</b>' : '') + (x.error ? ' <span class="upc-err">Not changed: ' + esc(x.error) + '</span>' : '') + '</td>' +
          '<td>' + esc(x.why || '') + '</td></tr>').join('') + '</tbody></table>' : '<p>No changes yet.</p>') +
      '<p class="text-muted">Review and statuses other than Current, Claimant, Discharged and Contact are never changed. Patient statuses ' + VERSION + '.</p>';
  }

  function start() {
    if (!U()) { console.error('[UPC patient statuses] needs the core library'); return; }
    if (!allowed()) return;
    if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('Patient statuses: recent changes', showLog);
    document.addEventListener('visibilitychange', tick);
    setTimeout(tick, 8000);
    setInterval(tick, 5 * 60e3);
  }
  const begin = () => { if (U()) whenAllowed(start); else start(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', begin, { once: true });
  else begin();

  window.upcPatientStatuses = { version: VERSION, saysFinished, check, runOnce, allowed };
})();
