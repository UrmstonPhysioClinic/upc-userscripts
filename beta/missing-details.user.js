// ==UserScript==
// @name         UPC Patients: Missing details (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.2.10
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/missing-details.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/missing-details.user.js
// @description  Patients missing their mandatory details (first and last name, date of birth, address, a phone number): a banner on every page of that patient for everyone until the details are saved, a marker on their appointments in the calendar, and Patients > Missing details for CH and WP (a list with a count). Reads only.
// @match        https://*.halaxy.com/a/pr/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * Missing details (CH, 15 Nov 2026). Details should be taken at booking, on the intake form or at the first appointment,
 * but sometimes are missed.
 *
 *  - Mandatory: first name, last name, date of birth, an address (first line and postcode) and at least one phone
 *    number. Email is ideal but not required (some older patients don't use it): it is mentioned, never counted.
 *  - Read from the patient's Edit page (GET /patient/:id/edit, form#patientGeneralEditForm; one request, nothing saved).
 *  - Banner: on every page of a patient (profile, notes, invoices, edit) for everyone, whether or not they are booked,
 *    until the details are in. A patient known to be complete (checked in the last 30 days) costs nothing; one with gaps
 *    is read again on their next page after a visit to their Edit page (so the banner goes once the details are saved),
 *    or after 10 minutes. On the Edit page itself the details are read from the page (no request).
 *  - In the background (each PC, visible tab, clinic hours, shared across tabs, every 3 hours): everyone booked in the
 *    next 14 days or seen in the last 30. Complete patients are read again after 30 days, those with gaps after a day,
 *    at most 40 a run. The patients with gaps are kept on this PC for Calendar controls, which marks their appointments.
 *  - Patients > Missing details (CH and WP): who is missing what, their next appointment and with whom (or when
 *    they were last seen), and a link to their Edit page. Soonest appointment first. A count on the menu (not email).
 *  - No pop-ups (CH, 15 Nov 2026: the banner first; a pop-up only if it proves too easy to miss).
 *  - Shared between the PCs (CH, 15 Nov 2026; core's UPC.shared): what each PC finds goes in the Admin Note
 *    "UPC shared checks: Missing details" on UPC scripts (settings), as patient id | when | codes (never names). Before
 *    checking, a PC reads the note, takes what the others found, and claims the patients it is about to check, so the
 *    clinic reads each patient once rather than once per PC. A PC notes a patient's outcome there when it differs from
 *    the note (details just saved, new gaps). Every PC reads the note every 30 minutes, so banners and calendar marks
 *    follow. If the note can't be read, each PC checks for itself as before.
 *  - Two groups (CH, 16 Nov 2026): "ongoing" (seen in the last 18 months: worth a call for the details) and "not seen
 *    yet" (no attended appointment in that time: they fill in the online form before their first visit, so no chasing).
 *    The menu count is the ongoing ones only; the banner and the calendar mark stay for everyone with gaps.
 */
(() => {
  'use strict';
  if (window.__hxMissingDetails) return;
  window.__hxMissingDetails = true;

  const VERSION = '0.2.10';
  const ROUTE = 'upc-missing-details';
  const MENU_CLS = 'upc-md-menu';
  const ADMINS = () => rule('missingDetails.people', ['Carl Healy', 'Wendy Pritchard']);   // who sees the page (CH, 15 Nov 2026: CH and WP)
  const DAY = 86400e3;
  // Clinic settings (Script settings > Clinic settings; core's UPC.settings), with the defaults if core is older.
  const rule = (k, d) => (window.UPC && UPC.settings && UPC.settings.def(k) ? UPC.settings.get(k) : d);
  const AHEAD_DAYS = () => rule('missingDetails.aheadDays', 14), BACK_DAYS = () => rule('missingDetails.backDays', 30);    // CH, 15 Nov 2026
  const KEEP_COMPLETE = 30 * DAY, KEEP_GAPS = DAY, RECHECK_GAPS = 10 * 60e3;
  const SWEEP_EVERY = 3 * 3600e3, PER_RUN = 40;
  const SKIP_STATUS = /^(deleted|archived|deceased|off)$/i;
  const SHARE_EVERY = 30 * 60e3;
  const SEEN_MONTHS = 18;   // an attended appointment in this time: an ongoing (or recent) patient
  const KEY = 'upc-md:';

  const U = () => window.UPC;
  const esc = (s) => U().esc(s);
  const clean = (s) => U().clean(s);
  const store = { get: (k, d) => U().storage(KEY).get(k, d), set: (k, v) => U().storage(KEY).set(k, v) };
  const label = (ms) => U().dayLabel(ms);
  const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const isAdmin = () => !!U() && U().user.is(ADMINS());

  // ------------------------------------------------------------------ reading a patient

  const PLACES = new Set(['urmston', 'flixton', 'davyhulme', 'stretford', 'sale', 'trafford', 'partington', 'carrington', 'altrincham', 'eccles', 'irlam', 'cadishead',
    'manchester', 'salford', 'chorlton', 'didsbury', 'timperley', 'hale', 'bowdon', 'ashton', 'swinton', 'worsley', 'stockport', 'warrington', 'cheshire', 'lancashire']);
  const FIELD_NAMES = { first: 'first name', last: 'last name', dob: 'date of birth', address: 'address', phone: 'phone number' };
  // What the Edit page has: { name, status, missing: ['dob', ...], email: bool }.
  function detailsFrom(doc) {
    const form = doc.querySelector('form#patientGeneralEditForm');
    if (!form || !form.querySelector('[name="patientdetailmain[name][forename]"]')) throw new (U().Error)('Halaxy\'s patient Edit page has changed (the details form was not found), so missing details could not be checked.');
    const v = (n) => { const el = form.querySelector('[name="' + n + '"]'); return el ? clean(el.value) : ''; };
    const all = (re) => [...form.querySelectorAll('input, select, textarea')].filter((el) => re.test(el.name || ''));
    const first = v('patientdetailmain[name][forename]'), last = v('patientdetailmain[name][surname]');
    const dob = ['day', 'month', 'year'].every((p) => v('patientdetailmain[dob][' + p + ']'));
    // Any address with a real first line and a postcode; any phone number with at least 6 digits. A first line that is
    // only a place name (CH, 20 Nov 2026: "Urmston", with the town in the next field) doesn't count: a single word that
    // is one of the address's own town/region fields or a local place. Single-word house names still count.
    const lines = all(/\[linkpagaddresses\]\[\d+\]\[address\]\[firstline\]$/);
    const address = lines.some((el) => {
      const line = clean(el.value), part = (f) => clean(v(el.name.replace(/\[firstline\]$/, '[' + f + ']'))).toLowerCase();
      if (!line || !part('postcode')) return false;
      const word = line.toLowerCase().replace(/[.,]/g, '').trim();
      return !(/^[a-z' -]+$/.test(word) && !/\s/.test(word) && (PLACES.has(word) || ['secondline', 'city', 'region'].some((f) => part(f) === word)));
    });
    const phone = all(/\[linkphonepas\]\[\d+\]\[phone\]\[number\]$/).some((el) => (el.value.match(/\d/g) || []).length >= 6);
    const missing = [];
    if (!first) missing.push('first');
    if (!last) missing.push('last');
    if (!dob) missing.push('dob');
    if (!address) missing.push('address');
    if (!phone) missing.push('phone');
    return { name: [first, last].filter(Boolean).join(' ') || clean(v('patientdetailmain[preferredName]')), status: v('patientdetailmain[linkPaG][customStatus]'),
      missing, email: /@/.test(v('patientdetailmain[contactEmail]')) };
  }
  async function readPatient(id) {
    const doc = await U().http.html('/patient/' + encodeURIComponent(id) + '/edit');
    return Object.assign(detailsFrom(doc), { at: Date.now() });
  }
  // The per-PC record of each patient checked; the ids with gaps are kept apart for Calendar controls.
  const known = () => store.get('patients', {});
  function rememberAll(found) {
    const all = known();
    Object.keys(found).forEach((id) => { const r = found[id]; all[id] = { at: r.at, name: r.name || (all[id] && all[id].name) || '', status: r.status, missing: r.missing, email: r.email }; });
    Object.keys(all).forEach((k) => { if (Date.now() - all[k].at > 2 * KEEP_COMPLETE) delete all[k]; });
    store.set('patients', all);
    store.set('ids', Object.keys(all).filter((k) => all[k].missing.length && !SKIP_STATUS.test(all[k].status || '')));
  }
  const remember = (id, r) => rememberAll({ [id]: r });

  // ------------------------------------------------------------------ shared with the other PCs

  // In the note: what is missing ('ok' if nothing), 'noemail', and 'off' for a Deleted, Archived or Deceased patient.
  const toValue = (r) => (r.missing.length ? r.missing : ['ok']).concat(r.email ? [] : ['noemail'], SKIP_STATUS.test(r.status || '') ? ['off'] : []).join(' ');
  function fromValue(v, at) {
    const t = String(v || '').split(' ');
    return { at, name: '', status: t.includes('off') ? 'off' : '', missing: t.filter((x) => FIELD_NAMES[x]), email: !t.includes('noemail') };
  }
  const shared = () => (U().shared ? U().shared('Missing details', { keep: KEEP_COMPLETE, file: 'missing-details.user.js' }) : null);
  // Takes what the other PCs found when it is newer than this PC's own (times in the note are to the minute).
  function takeShared(recs) {
    const mine = known(), found = {};
    Object.keys(recs || {}).forEach((id) => {
      const r = recs[id];
      if (r.at !== null && /^\d+$/.test(id) && (!mine[id] || r.at > mine[id].at + 60e3)) found[id] = fromValue(r.value, r.at);
    });
    if (Object.keys(found).length) rememberAll(found);
    store.set('sharedAt', Date.now());
  }
  // A patient read on their own page: noted for the others when it differs from what the note says.
  async function share(id, r) {
    const sh = shared();
    if (!sh) return;
    try {
      const now = toValue(r);
      const differs = (recs) => { const was = recs[id] && recs[id].at !== null ? recs[id].value : null; return was !== now && (was !== null || r.missing.length > 0); };
      // This PC's copy of the note first; if that differs, the note itself (a save may not have finished).
      if (differs(await sh.read(SHARE_EVERY)) && differs(await sh.read(0))) await sh.write({ [id]: now });
    } catch (e) { console.warn('[UPC missing details] shared note', e); }
  }
  // Results from before the address rule changed (0.2.6) are read again.
  const RULES_AT = Date.UTC(2026, 10, 20, 12);
  const fresh = (r) => r && r.at >= RULES_AT && Date.now() - r.at < (r.missing.length ? KEEP_GAPS : KEEP_COMPLETE);
  const missingText = (r) => r.missing.map((m) => FIELD_NAMES[m]).join(', ');

  function tellHealthCheck(e) {
    const message = (e && e.message) || String(e);
    if (!/has changed/.test(message)) return;
    document.dispatchEvent(new CustomEvent('upc-loader-error', { detail: JSON.stringify({ file: 'missing-details.user.js', message }) }));
  }

  // ------------------------------------------------------------------ the banner on a patient's pages

  // /patient/:id/... and the tabs addressed the other way round, /patient/invoice/:id/ and /patient/appointment/:id/
  // (capture 15 Nov 2026).
  const patientId = () => (location.pathname.match(/\/a\/pr\/\d+\/patient\/(?:[a-z-]+\/)?(\d+)(?:\/|$)/i) || [])[1] || null;
  let shownFor = null, reading = null;
  function paintBanner() {
    const id = patientId();
    const host = document.getElementById('pageContent');
    let el = document.querySelector('.upc-md-banner');
    const r = id && known()[id];
    if (!id || !host || !r || !r.missing.length || SKIP_STATUS.test(r.status || '')) { if (el) el.remove(); return; }
    const text = 'Missing details: ' + missingText(r) + (r.email ? '' : ', email') + '.';
    const html = '<strong>' + esc(text) + '</strong> <a href="' + esc(U().base() + '/patient/' + id + '/edit') + '">Edit details</a>';
    if (!el || el.parentNode !== host) {
      if (el) el.remove();
      el = document.createElement('div');
      el.className = 'upc-native upc-md-banner alert alert-warning';
      el.setAttribute('role', 'alert');
      host.insertBefore(el, host.firstChild);
    }
    if (el.innerHTML !== html) el.innerHTML = html;
  }
  async function checkOpenPatient() {
    const id = patientId();
    if (!id) { shownFor = null; paintBanner(); return; }
    paintBanner();
    // On the Edit page itself the details are already on screen (as saved): read from there, no request, and note the
    // visit, so the next page of this patient reads them again (in case they were just saved).
    const onEdit = /\/patient\/\d+\/edit\/?$/.test(location.pathname) && document.querySelector('form#patientGeneralEditForm');
    const edited = store.get('edited', {});
    // Known complete: nothing to do. With gaps: read again only after a visit to their Edit page, or every 10 minutes.
    const settled = (r) => !onEdit && r && (r.missing.length ? !(edited[id] > r.at) && Date.now() - r.at < RECHECK_GAPS : fresh(r));
    if (settled(known()[id])) { shownFor = id; return; }
    if (reading === id || (U().http.pausedFor && U().http.pausedFor() > 0)) return;
    reading = id;
    try {
      // What the other PCs found may do (this PC's copy of the note, read again if older than 30 minutes).
      const r0 = known()[id];
      if (!onEdit && !(r0 && edited[id] > r0.at) && shared()) {
        try { takeShared(await shared().read(SHARE_EVERY)); } catch (e) { /* the note can't be read: check here */ }
        if (settled(known()[id])) { shownFor = id; return; }
      }
      const r = onEdit ? Object.assign(detailsFrom(document), { at: Date.now() }) : await readPatient(id);
      // Marked as visited just after this reading (same clock), so the next page of this patient reads again.
      if (onEdit) { edited[id] = r.at + 1; Object.keys(edited).forEach((k) => { if (Date.now() - edited[k] > DAY) delete edited[k]; }); store.set('edited', edited); }
      remember(id, r);
      shownFor = id;
      share(id, r);
    } catch (e) { tellHealthCheck(e); }
    finally { reading = null; paintBanner(); }
  }

  // ------------------------------------------------------------------ the background check

  const startMs = (e) => (typeof e.start === 'number' ? e.start * 1000 : Date.parse(e.start));
  const live = (e) => !/cancel|reject|declin|did-not-attend/i.test(e.appointmentStatus || '');
  async function sweep(say) {
    say = say || (() => {});
    const now = Date.now(), day0 = today();
    say('Reading the calendar...');
    // One request either way; the longer look back tells patients already seen from those not seen yet.
    const events = await U().calendar.appointments(day0 - Math.max(BACK_DAYS(), SEEN_MONTHS * 31) * DAY, day0 + (AHEAD_DAYS() + 1) * DAY);
    const people = new Map();   // id -> { next, nextPrac, lastSeen, name }
    events.forEach((e) => {
      if (!e.linkPaGId || (e.type && e.type !== 'appointment')) return;
      const id = String(e.linkPaGId), t = startMs(e);
      const p = people.get(id) || { id, next: null, nextPrac: null, lastSeen: null, seen: false, name: clean(U().htmlDoc(e.title || '').body.textContent).replace(/^[\s*★⚠]+/, '') };
      if (t >= now && t <= day0 + (AHEAD_DAYS() + 1) * DAY && live(e) && (p.next === null || t < p.next)) { p.next = t; p.nextPrac = e.practitionerID; }
      if (t < now && t >= day0 - BACK_DAYS() * DAY && !e.appointmentStatus && (p.lastSeen === null || t > p.lastSeen)) p.lastSeen = t;
      if (t < now && !e.appointmentStatus) p.seen = true;   // attended (no exception) at some point in the last 18 months
      people.set(id, p);
    });
    const list = [...people.values()].filter((p) => p.next !== null || p.lastSeen !== null);
    // What the other PCs have found, and whom they are checking now.
    let sh = shared(), others = {};
    if (sh) {
      say('Reading what the other PCs found...');
      try { const recs = await sh.read(0); takeShared(recs); others = recs; } catch (e) { sh = null; console.warn('[UPC missing details] shared note', e); }
    }
    const busy = (id) => { const c = others[id] && others[id].claim; return !!(c && c.by !== sh.me && c.until > Date.now()); };
    let todo = list.filter((p) => !fresh(known()[p.id]) && !(sh && busy(p.id))).sort((a, b) => (a.next || Infinity) - (b.next || Infinity)).slice(0, PER_RUN);
    if (sh && todo.length) {
      try { const mine = await sh.claim(todo.map((p) => p.id)); todo = todo.filter((p) => mine.includes(p.id)); }
      catch (e) { sh = null; console.warn('[UPC missing details] shared note', e); }
    }
    const outcomes = {};
    let n = 0;
    try {
      for (const p of todo) {
        if (U().http.pausedFor && U().http.pausedFor() > 0) break;
        say('Checking ' + (p.name || 'a patient') + ' (' + (++n) + ' of ' + todo.length + ')...');
        try { const r = await readPatient(p.id); remember(p.id, r); outcomes[p.id] = toValue(r); } catch (e) { tellHealthCheck(e); if (/has changed/.test(e.message || '')) throw e; }
      }
    } finally {
      // Noted for the other PCs, and this PC's claims let go (also when stopped part way). What this PC already knew
      // and the note lacks (or has older) goes in too, with its own time, so a PC's earlier checks are shared.
      if (sh) {
        const mine = known();
        list.forEach((p) => {
          const r = mine[p.id], o = others[p.id];
          if (!outcomes[p.id] && fresh(r) && !(o && o.at !== null && o.at >= r.at - 60e3)) outcomes[p.id] = { value: toValue(r), at: r.at };
        });
        say('Noting what was found for the other PCs...');
        try { await sh.write(outcomes); } catch (e) { console.warn('[UPC missing details] shared note', e); }
      }
    }
    let pracs = {};
    try { (await U().http.json('/lookup/practitioner?clinic=&include_id=&type=') || []).forEach((x) => { pracs[String(x.id)] = clean(x.name); }); } catch (e) { pracs = {}; }
    const k = known();
    const rows = list.map((p) => Object.assign({}, p, k[p.id] || {}, { id: p.id, name: (k[p.id] && k[p.id].name) || p.name, prac: pracs[String(p.nextPrac)] || '' }))
      .filter((p) => p.missing && !SKIP_STATUS.test(p.status || '') && (p.missing.length || !p.email))
      .sort((a, b) => (a.next || Infinity) - (b.next || Infinity) || (b.lastSeen || 0) - (a.lastSeen || 0));
    const result = { at: Date.now(), by: VERSION, rows, unchecked: list.filter((p) => !k[p.id]).length, count: rows.filter((r) => r.missing.length && r.seen).length };
    store.set('result', result);
    return result;
  }
  const locked = () => Date.now() - store.get('running', 0) < 2 * 60e3;
  async function sweepLocked(say) {
    store.set('running', Date.now());
    const beat = (t) => { store.set('running', Date.now()); if (say) say(t); };
    try { return await sweep(beat); } finally { store.set('running', 0); }
  }
  async function background() {
    if (!U() || !U().background.ok() || locked()) return;
    const last = store.get('result', null);
    if (last && last.by === VERSION && !U().background.due(last.at, SWEEP_EVERY)) {
      // Between checks: what the other PCs found, every 30 minutes (one request), for the banner and calendar marks.
      const sh = shared();
      if (sh && U().background.due(store.get('sharedAt', 0), SHARE_EVERY)) {
        store.set('sharedAt', Date.now());
        try { takeShared(await sh.read(0)); } catch (e) { /* tried again in 30 minutes */ }
        paintBanner();
      }
      return;
    }
    try { await sweepLocked(); } catch (e) { console.warn('[UPC missing details]', e); }
    paintBadge();
    paintBanner();
  }

  // ------------------------------------------------------------------ Patients > Missing details (CH and WP)

  function paintBadge() {
    const a = document.querySelector('a.' + MENU_CLS);
    if (!a) return;
    const r = store.get('result', null);
    const n = r ? r.count : 0;
    if (U().todo) U().todo.publish('missing-details', { title: 'Missing details', cls: MENU_CLS, href: a.getAttribute('href'), count: n, rows: r ? r.rows.filter((x) => x.missing.length && x.seen !== false).slice(0, 3).map((x) => (x.name || 'Patient') + ': ' + missingText(x)) : [] });
    let b = a.querySelector('.upc-md-badge');
    if (!n) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('span'); b.className = 'upc-md-badge'; a.appendChild(b); }
    const text = n > 99 ? '99+' : String(n);
    if (b.textContent !== text) b.textContent = text;
    const title = n + ' ongoing patient' + (n === 1 ? '' : 's') + ' missing mandatory details';
    if (b.title !== title) b.title = title;
  }

  const CSS = `
    .upc-md-badge { display: inline-block; min-width: 18px; margin-left: 6px; padding: 0 5px; border-radius: 9px; font-size: .75em; line-height: 18px;
      text-align: center; font-weight: 600; color: #fff; background: var(--vs-notification-badge-bg-color, #ec6b65); vertical-align: middle; }
    .upc-native.upc-md-banner { margin: 12px 24px 16px; }
    .upc-native.upc-md-banner a { margin-left: 8px; }
    .upc-md .card { margin-bottom: 24px; }
    .upc-md .card-header h2 { margin: 0; }
    .upc-md td.upc-md-date { white-space: nowrap; }
  `;
  const state = { unmount: null, running: false, status: '', error: '' };
  let root = null;

  function render() {
    if (!root) return;
    const r = store.get('result', null);
    const base = U().base();
    const next = (x) => x.next ? label(x.next) + ' ' + new Date(x.next).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + (x.prac ? ' with ' + x.prac : '') : '';
    const row = (x, seenCol) => '<tr><td><a href="' + esc(base + '/patient/' + x.id) + '" target="_blank" rel="noopener">' + esc(x.name || 'Patient') + '</a></td>' +
      '<td>' + esc(x.missing.length ? missingText(x) + (x.email ? '' : ', email') : 'email') + '</td>' +
      '<td class="upc-md-date">' + esc(next(x)) + '</td>' + (seenCol ? '<td class="upc-md-date">' + esc(x.lastSeen ? label(x.lastSeen) : '') + '</td>' : '') +
      '<td><a href="' + esc(base + '/patient/' + x.id + '/edit') + '" target="_blank" rel="noopener">Edit details</a></td></tr>';
    let h = '<div class="upc-md">' + U().ui.page.bar('Missing details', '<button type="button" class="btn btn-outline-primary" data-a="refresh" ' + (state.running ? 'disabled' : '') + '>' + (state.running ? 'Checking...' : 'Check Now') + '</button>', (state.running ? U().ui.run.inline(state.status) : U().ui.page.checked(r && r.at)));
    if (state.error) h += '<div class="alert alert-danger upc-err">' + esc(state.error) + '</div>';
    if (r) {
      const seen = (x) => x.seen !== false;   // results from before the split: treated as ongoing
      const need = r.rows.filter((x) => x.missing.length && seen(x)), notYet = r.rows.filter((x) => x.missing.length && !seen(x)), email = r.rows.filter((x) => !x.missing.length);
      // Not seen yet: no Last seen column (always empty there; UI/UX audit, 23 Nov 2026).
      const table = (rows, seenCol = true) => '<table class="table table-striped table-bordered w-100 m-0"><thead><tr><th>Patient</th><th>Missing</th><th>Next Appointment</th>' + (seenCol ? '<th>Last Seen</th>' : '') + '<th></th></tr></thead><tbody>' + rows.map((x) => row(x, seenCol)).join('') + '</tbody></table>';
      h += '<div class="card"><div class="card-header"><h2>Ongoing patients (' + need.length + ')</h2></div><div class="card-body p-0">' +
        (need.length ? table(need) : '<p class="text-muted m-3">None.</p>') + '</div></div>';
      if (notYet.length) h += '<div class="card"><div class="card-header"><h2>Not seen yet (' + notYet.length + ')</h2></div><div class="card-body p-0">' + table(notYet, false) + '</div></div>';
      if (email.length) h += '<div class="card"><div class="card-header"><h2>No email address (' + email.length + ')</h2></div><div class="card-body p-0">' + table(email) + '</div></div>';
      h += '<p class="text-muted">Booked in the next ' + AHEAD_DAYS() + ' days' + (BACK_DAYS() ? ' or seen in the last ' + BACK_DAYS() + ' days' : '') + '.' + (r.unchecked ? ' ' + r.unchecked + ' still to check.' : '') + '</p>';
    }
    h += '</div>';
    root.innerHTML = h;
    U().ui.list.enhance(root, { auto: true });
  }
  async function run() {
    if (state.running) return;
    state.running = true; state.error = ''; state.status = 'Checking...';
    render();
    try {
      if (locked()) {
        state.status = 'Checking in another tab...';
        render();
        const t0 = Date.now();
        while (locked() && Date.now() - t0 < 10 * 60e3) await U().sleep(1000);
      } else await sweepLocked((t) => { state.status = t; render(); });
    } catch (e) { state.error = 'Could not check: ' + (e.message || e); tellHealthCheck(e); }
    state.running = false;
    render();
    paintBadge();
  }
  function mount() {
    if (state.unmount || !isAdmin()) return;
    U().ui.nativeStyles();
    root = document.createElement('div');
    root.className = 'upc-native';
    root.setAttribute('data-upc-missing-details', '');
    root.addEventListener('click', (e) => { if (e.target.closest('[data-a=refresh]')) { U().calendar.forget(); store.set('result', null); run(); } });
    state.unmount = U().ui.mountPage('Missing details', root, MENU_CLS);
    render();
    const r = store.get('result', null);
    if (!r || Date.now() - r.at > 30 * 60e3 || r.by !== VERSION) run();
  }
  function unmount() {
    if (!state.unmount) return;
    state.unmount();
    state.unmount = null;
    root = null;
  }
  const route = () => (location.hash === '#' + ROUTE ? mount() : unmount());

  // ------------------------------------------------------------------ start

  function start() {
    if (!U()) { console.error('[UPC missing details] needs the core library'); return; }
    if (!document.getElementById('upc-missing-details-css')) { const st = document.createElement('style'); st.id = 'upc-missing-details-css'; st.textContent = CSS; document.head.appendChild(st); }
    // Everyone: the banner, kept in place as Halaxy redraws the page and moves between a patient's pages.
    let lastUrl = '';
    const onPage = () => { if (location.href !== lastUrl) { lastUrl = location.href; checkOpenPatient(); } else paintBanner(); };
    new MutationObserver(() => { if (!document.querySelector('.upc-md-banner') || patientId() !== shownFor) onPage(); }).observe(document.body, { childList: true, subtree: true });
    setInterval(onPage, 1500);
    window.addEventListener('storage', (e) => { if (e.key === KEY + 'patients') paintBanner(); if (e.key === KEY + 'result') { paintBadge(); render(); } });
    onPage();
    // Everyone: the background check (so every PC's calendar knows whom to mark).
    document.addEventListener('visibilitychange', background);
    setTimeout(background, 8000);
    setInterval(background, 30 * 60e3);
    // CH and WP: the page under Patients, opening over Halaxy's Patient List (as Open-ended patients does).
    U().user.whenAllowed(ADMINS(), () => {
      U().ui.ensureMenuItem('Missing details', (section) => {
        const list = section && [...section.querySelectorAll('a.mainmenu-sublink')].find((a) => /^patient list$/i.test(clean(a.textContent)));
        return (list ? list.getAttribute('href').split('#')[0] : U().base() + '/patient/') + '#' + ROUTE;
      }, MENU_CLS, /^patients?$/i);
      new MutationObserver(paintBadge).observe(document.getElementById('mainMenu') || document.body, { childList: true, subtree: true });
      window.addEventListener('hashchange', route);
      paintBadge();
      route();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  window.upcMissingDetails = { version: VERSION, detailsFrom, sweep, isAdmin };
})();
