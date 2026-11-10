// ==UserScript==
// @name         Halaxy forecourt lights reminder
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.2.1
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/stable/forecourt-lights.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/stable/forecourt-lights.user.js
// @description  Reminds reception to turn the forecourt lights timer on for evening clinics and off afterwards, when to move its on time as sunset shifts, and when to change its clock for BST/GMT. Off until switched on per PC (Tampermonkey menu: Forecourt lights: settings). Makes no requests to Halaxy.
// @match        https://*.halaxy.com/a/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * Forecourt lights timer reminder (Carl, 10 Nov 2026).
 *
 *  - The forecourt and sign floodlights run on a timer that moves in 15-minute steps, used on evening
 *    clinic days only. Sunset for Urmston (53.45 N, 2.35 W) is worked out here (NOAA formulae), so
 *    nothing is fetched from anywhere.
 *  - On each clinic evening, from the reminder time: "Turn the timer ON today. Lights on 16:00 to 20:45."
 *    The on time is sunset minus the offset (30 minutes), rounded down to the timer's 15-minute steps.
 *    When that differs from what the timer is set to: "Adjust timer: move the on time from 16:15 to
 *    16:00"; Done records the new setting. After a clock change: "Change the timer's clock". On the last
 *    clinic day before a change, a heads-up.
 *  - After a clinic evening (from the reminder time the next day, until done): "Turn the timer OFF",
 *    unless that day is a clinic evening too, or the lights weren't needed.
 *  - When the on time reaches the off time (about May to July) the lights aren't needed: said once,
 *    with the date they're next needed, and no reminders until then.
 *  - Shown only on PCs where it's switched on, and only to the people ticked (by who is signed in to
 *    Halaxy; nobody ticked means anyone), as a Halaxy-style pop-up in the tab being used.
 *    "Remind me later" hides it for an hour. Settings and what's been done are kept on this PC.
 */
(() => {
  'use strict';
  if (window.__hxForecourtLights) return;
  window.__hxForecourtLights = true;

  const VERSION = '0.2.1';
  const LAT = 53.45, LON = -2.35, TZ = 'Europe/London';
  const STEP = 15;                      // the timer's segments, minutes
  const SNOOZE = 60 * 60e3;
  const DAY = 86400e3;
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DEFAULTS = { enabled: false, days: [false, false, false, false, false, false, false], offTime: '20:45', offset: 30, noticeTime: '09:00', skip: [], timerOn: null, who: [] };
  const STAFF = ['Carl Healy', 'Diana Satalova', 'Lottie Harold', 'Roxanna Healy', 'Stephen Sharples', 'Wendy Pritchard'];

  const U = () => window.UPC;
  const canStore = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
  const get = (k, d) => (canStore ? GM_getValue(k, d) : d);
  const set = (k, v) => { if (canStore) GM_setValue(k, v); };
  const settings = () => Object.assign({}, DEFAULTS, get('settings', {}));
  const state = () => Object.assign({ lastOffset: null, done: {}, snoozeUntil: 0, summerSaid: null }, get('state', {}));
  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Who is signed in to Halaxy on this page.
  function userName() {
    const h = window.HkUser || {};
    const named = String(h.pracName || (h.CalendarDefault || {}).pracName || '').trim();
    if (named) return named;
    const el = [...document.querySelectorAll('header *, nav *, .navbar *, #top *')]
      .find((e) => !e.children.length && STAFF.some((n) => n.toLowerCase() === e.textContent.trim().toLowerCase()));
    return el ? el.textContent.trim() : '';
  }
  const isFor = (s, user) => !(s.who || []).length || (s.who || []).some((n) => n.toLowerCase() === String(user || '').toLowerCase());

  // ------------------------------------------------------------------ dates in Urmston

  // A "day" is a London calendar date, kept as 'YYYY-MM-DD'.
  const fmtParts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  function london(ms) {
    const p = {};
    fmtParts.formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
    const y = +p.year, m = +p.month, d = +p.day, hh = +p.hour, mm = +p.minute;
    const offset = Math.round((Date.UTC(y, m - 1, d, hh, mm) - Math.floor(ms / 60e3) * 60e3) / 60e3);   // minutes ahead of UTC
    return { day: y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'), y, m, d, minutes: hh * 60 + mm, offset };
  }
  const dayToUtc = (day) => { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const addDays = (day, n) => new Date(dayToUtc(day) + n * DAY).toISOString().slice(0, 10);
  const weekday = (day) => (new Date(dayToUtc(day)).getUTCDay() + 6) % 7;   // 0 = Monday
  const offsetOn = (day) => london(dayToUtc(day) + 12 * 3600e3).offset;     // at midday
  const label = (day) => { const [y, m, d] = day.split('-').map(Number); return String(d).padStart(2, '0') + '-' + MONTHS[m - 1] + '-' + y; };
  const longLabel = (day) => ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][weekday(day)] + ' ' + label(day);
  // A typed date ('25-Dec-2026', '25/12/2026' or '2026-12-25') as 'YYYY-MM-DD', or null.
  function parseDate(text) {
    const t = String(text || '').trim();
    let y, m, d, x;
    if ((x = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t))) [y, m, d] = [+x[1], +x[2], +x[3]];
    else if ((x = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(t))) [d, m, y] = [+x[1], +x[2], +x[3]];
    else if ((x = /^(\d{1,2})[\s-]+([A-Za-z]{3})[A-Za-z]*[\s-]+(\d{4})$/.exec(t))) {
      m = MONTHS.findIndex((n) => n.toLowerCase() === x[2].toLowerCase()) + 1;
      [d, y] = [+x[1], +x[3]];
    } else return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return m >= 1 && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
  }
  const hhmm = (min) => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
  const toMin = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim()); return m ? +m[1] * 60 + +m[2] : null; };

  // UK clocks change at 01:00 UTC on the last Sunday of March (forward) and of October (back).
  function lastSunday(y, month) { const d = new Date(Date.UTC(y, month + 1, 0)); d.setUTCDate(d.getUTCDate() - d.getUTCDay()); return d.toISOString().slice(0, 10); }
  function clockChanges(y) { return [{ day: lastSunday(y, 2), dir: 'forward' }, { day: lastSunday(y, 9), dir: 'back' }]; }
  // The most recent change on or before `day`, and the next one after it.
  function lastChange(day) { const y = +day.slice(0, 4); return [...clockChanges(y - 1), ...clockChanges(y)].filter((c) => c.day <= day).pop(); }
  function nextChange(day) { const y = +day.slice(0, 4); return [...clockChanges(y), ...clockChanges(y + 1)].find((c) => c.day > day); }

  // ------------------------------------------------------------------ sunset (NOAA)

  // Sunset in minutes after local midnight for a London date, to about a minute.
  function sunsetMinutes(day) {
    const r = Math.PI / 180;
    const base = dayToUtc(day);
    let utcMin = 720 - 4 * LON + 4 * 90;   // first guess, then refine at that time
    for (let i = 0; i < 3; i++) {
      const jd = (base + utcMin * 60e3) / DAY + 2440587.5;
      const T = (jd - 2451545) / 36525;
      const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
      const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
      const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
      const C = Math.sin(M * r) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(2 * M * r) * (0.019993 - 0.000101 * T) + Math.sin(3 * M * r) * 0.000289;
      const omega = 125.04 - 1934.136 * T;
      const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * r);
      const eps = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60 + 0.00256 * Math.cos(omega * r);
      const decl = Math.asin(Math.sin(eps * r) * Math.sin(lambda * r));
      const y = Math.tan(eps * r / 2) ** 2;
      const eqTime = 4 / r * (y * Math.sin(2 * L0 * r) - 2 * e * Math.sin(M * r) + 4 * e * y * Math.sin(M * r) * Math.cos(2 * L0 * r) -
        0.5 * y * y * Math.sin(4 * L0 * r) - 1.25 * e * e * Math.sin(2 * M * r));
      const ha = Math.acos(Math.cos(90.833 * r) / (Math.cos(LAT * r) * Math.cos(decl)) - Math.tan(LAT * r) * Math.tan(decl)) / r;
      utcMin = 720 - 4 * LON - eqTime + 4 * ha;
    }
    return Math.round(utcMin + offsetOn(day));
  }

  // ------------------------------------------------------------------ what's due

  function isClinic(day, s) { return !!s.days[weekday(day)] && !(s.skip || []).includes(day); }
  function plan(day, s) {
    const sunset = sunsetMinutes(day);
    const on = Math.floor((sunset - s.offset) / STEP) * STEP;
    const off = toMin(s.offTime);
    return { sunset, on, needed: off === null || on < off };
  }
  function nextNeeded(day, s) {
    for (let i = 1; i < 200; i++) { const d = addDays(day, i); if (plan(d, s).needed) return d; }
    return null;
  }

  // The reminder for now, or null. kind 'on' | 'off' | 'summer'.
  function due(nowMs, s, st, user) {
    if (!s.enabled || !isFor(s, user)) return null;
    const now = london(nowMs);
    const today = now.day;
    const noticeAt = toMin(s.noticeTime);
    if (noticeAt !== null && now.minutes < noticeAt) return null;
    if (isClinic(today, s)) {
      const p = plan(today, s);
      if (!p.needed) {
        if (st.summerSaid) return null;   // said once: no reminders until the lights are needed again
        const back = nextNeeded(today, s);
        return { kind: 'summer', key: today + ':summer', day: today,
          lines: ['The forecourt lights aren\'t needed this evening: sunset is ' + hhmm(p.sunset) + ', so the on time (' + hhmm(p.on) + ') would be after the ' + s.offTime + ' off time.',
            'Leave the timer off. ' + (back ? 'They\'re next needed from ' + longLabel(back) + '; reminders start again then.' : '')] };
      }
      if (st.done[today + ':on']) return null;
      const lines = ['<b>Turn the forecourt lights timer ON today.</b> Lights on ' + hhmm(p.on) + ' to ' + esc(s.offTime) + '.'];
      const current = toMin(s.timerOn);
      if (current === null) lines.push('<b>Set the timer\'s on time to ' + hhmm(p.on) + '.</b>');
      else if (current !== p.on) lines.push('<b>Adjust the timer:</b> move the on time from ' + hhmm(current) + ' to ' + hhmm(p.on) + '.');
      if (st.lastOffset !== null && st.lastOffset !== now.offset) {
        const c = lastChange(today);
        lines.push('<b>Change the timer\'s clock:</b> the clocks went ' + c.dir + ' 1 hour on ' + longLabel(c.day) + '. Set the timer\'s clock to match.');
      }
      const nc = nextChange(today);
      let nextClinic = null;
      for (let i = 1; i <= 14 && !nextClinic; i++) if (isClinic(addDays(today, i), s)) nextClinic = addDays(today, i);
      if (nc && nc.day <= (nextClinic || addDays(today, 7))) lines.push('Heads-up: the clocks go ' + nc.dir + ' 1 hour on ' + longLabel(nc.day) + ', so the timer\'s clock will need changing at the next clinic evening.');
      return { kind: 'on', key: today + ':on', day: today, on: p.on, offset: now.offset, lines };
    }
    // Not a clinic evening: the last clinic evening in the past week, if its lights were on and not yet turned off.
    for (let i = 1; i <= 7; i++) {
      const d = addDays(today, -i);
      if (!isClinic(d, s)) continue;
      if (!plan(d, s).needed || st.done[d + ':off']) return null;
      return { kind: 'off', key: d + ':off', day: d, lines: ['<b>Turn the forecourt lights timer OFF.</b> (It was on for ' + longLabel(d) + ' evening.)'] };
    }
    return null;
  }

  function markDone(r) {
    const st = state(), s = settings();
    st.done[r.key] = true;
    if (r.kind === 'on') {
      st.lastOffset = r.offset;
      st.summerSaid = null;
      if (s.timerOn !== hhmm(r.on)) set('settings', Object.assign(s, { timerOn: hhmm(r.on) }));
    }
    if (r.kind === 'summer') st.summerSaid = r.day;
    const cutoff = addDays(london(Date.now()).day, -30);
    Object.keys(st.done).forEach((k) => { if (k.slice(0, 10) < cutoff) delete st.done[k]; });
    st.snoozeUntil = 0;
    set('state', st);
  }

  // ------------------------------------------------------------------ pop-ups

  const CSS = `
    .upc-fl p { margin: 0 0 10px; }
    .upc-fl .upc-fl-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
    .upc-fl .upc-fl-actions .btn { margin: 0; }
    .upc-fl .upc-fl-days { display: flex; flex-wrap: wrap; gap: 4px 14px; }
    .upc-fl .upc-fl-days label { font-weight: normal; margin: 0; }
    .upc-fl .upc-fl-grid { display: grid; grid-template-columns: 220px 1fr; gap: 10px 12px; align-items: center; }
    .upc-fl .upc-fl-grid .form-control { max-width: 180px; }
    .upc-fl textarea.form-control { max-width: 260px; min-height: 70px; }
    .upc-fl table { margin-top: 12px; }
    @media (max-width: 600px) { .upc-fl .upc-fl-grid { grid-template-columns: 1fr; } }
  `;
  function styles() {
    if (document.getElementById('upc-forecourt-lights-css')) return;
    const st = document.createElement('style');
    st.id = 'upc-forecourt-lights-css';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  let open = null;   // { dialog, key }
  function showReminder() {
    if (!U() || document.hidden) return;
    const s = settings(), st = state();
    const r = due(Date.now(), s, st, userName());
    if (open && (!r || r.key !== open.key)) { const o = open; open = null; o.dialog.close(); }   // done in another tab
    if (!r || open || Date.now() < st.snoozeUntil) return;
    styles();
    const d = U().ui.dialog({ title: 'Forecourt lights', key: 'upc-forecourt-lights', small: true, onClose: () => { if (open && open.dialog === d) { open = null; snooze(); } } });
    if (!d) return;
    d.root.classList.add('upc-fl');
    d.body.innerHTML = r.lines.map((l) => '<p>' + l + '</p>').join('') +
      '<div class="upc-fl-actions"><button type="button" class="btn btn-outline-primary" data-a="later">Remind me later</button>' +
      '<button type="button" class="btn btn-primary" data-a="done">' + (r.kind === 'summer' ? 'OK' : 'Done') + '</button></div>';
    open = { dialog: d, key: r.key };
    d.body.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]');
      if (!a) return;
      if (a.dataset.a === 'done') markDone(r);
      open = null;
      if (a.dataset.a === 'later') snooze();
      d.close();
    });
  }
  function snooze() { const st = state(); st.snoozeUntil = Date.now() + SNOOZE; set('state', st); }

  function showSettings() {
    if (!U()) return;
    styles();
    const s = settings();
    const d = U().ui.dialog({ title: 'Forecourt lights: settings', key: 'upc-forecourt-settings' });
    if (!d) return;
    d.root.classList.add('upc-fl');
    const times = ['<option value="">Not known</option>'];
    for (let m = 12 * 60; m <= 21 * 60; m += STEP) times.push('<option' + (s.timerOn === hhmm(m) ? ' selected' : '') + '>' + hhmm(m) + '</option>');
    const today = london(Date.now()).day;
    const rows = [];
    for (let i = 0; i < 14; i++) {
      const day = addDays(today, i), p = plan(day, s);
      rows.push('<tr><td>' + esc(DAYS[weekday(day)] + ' ' + label(day)) + '</td><td>' + hhmm(p.sunset) + '</td><td>' + (p.needed ? hhmm(p.on) : 'Not needed') + '</td><td>' +
        (isClinic(day, s) ? 'Yes' : (s.skip || []).includes(day) ? 'Skipped' : '') + '</td></tr>');
    }
    d.body.innerHTML =
      '<div class="upc-fl-grid">' +
      '<label for="upc-fl-on">Reminders on this PC</label><div><label class="mb-0"><input type="checkbox" id="upc-fl-on"' + (s.enabled ? ' checked' : '') + '> Show forecourt light reminders here</label></div>' +
      '<span>Remind</span><div class="upc-fl-days">' + [...new Set([...STAFF, ...(s.who || []), userName()].filter(Boolean))].map((n) =>
        '<label><input type="checkbox" data-who="' + esc(n) + '"' + ((s.who || []).includes(n) ? ' checked' : '') + '> ' + esc(n) + '</label>').join('') +
        '<div class="text-muted w-100">Whoever is signed in to Halaxy on this PC. None ticked: anyone.</div></div>' +
      '<span>Clinic evenings</span><div class="upc-fl-days">' + DAYS.map((n, i) => '<label><input type="checkbox" data-day="' + i + '"' + (s.days[i] ? ' checked' : '') + '> ' + n + '</label>').join('') + '</div>' +
      '<label for="upc-fl-off">Lights off at</label><input class="form-control" id="upc-fl-off" type="time" step="900" value="' + esc(s.offTime) + '">' +
      '<label for="upc-fl-offset">Lights on, minutes before sunset</label><input class="form-control" id="upc-fl-offset" type="number" min="0" max="120" step="5" value="' + esc(s.offset) + '">' +
      '<label for="upc-fl-notice">Show the reminder from</label><input class="form-control" id="upc-fl-notice" type="time" value="' + esc(s.noticeTime) + '">' +
      '<label for="upc-fl-timer">The timer\'s on time is set to</label><select class="form-control" id="upc-fl-timer">' + times.join('') + '</select>' +
      '<label for="upc-fl-skip">Dates to skip (bank holidays, closures), one per line, e.g. 25-Dec-2026</label><textarea class="form-control" id="upc-fl-skip">' + esc((s.skip || []).map(label).join('\n')) + '</textarea>' +
      '</div><p class="upc-err" data-err></p>' +
      '<h6 class="mt-3">The next two weeks</h6><table class="table table-striped table-bordered w-100"><thead><tr><th>Date</th><th>Sunset</th><th>Lights on</th><th>Clinic evening</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>' +
      '<div class="text-muted">Sunset for Urmston, worked out on this PC. Lights on is rounded down to the timer\'s 15-minute steps. Settings are kept on this PC only. Forecourt lights ' + VERSION + '</div>' +
      '<div class="upc-fl-actions"><button type="button" class="btn btn-outline-primary" data-upc-close>Cancel</button><button type="button" class="btn btn-primary" data-a="save">Save</button></div>';
    d.body.querySelector('[data-a=save]').addEventListener('click', () => {
      const q = (id) => d.body.querySelector('#' + id);
      const bad = [];
      const off = q('upc-fl-off').value, notice = q('upc-fl-notice').value, offset = parseInt(q('upc-fl-offset').value, 10);
      if (toMin(off) === null) bad.push('Lights off at needs a time such as 20:45.');
      if (toMin(notice) === null) bad.push('Show the reminder from needs a time such as 09:00.');
      if (!(offset >= 0 && offset <= 120)) bad.push('Minutes before sunset needs a number from 0 to 120.');
      const skip = [];
      q('upc-fl-skip').value.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean).forEach((x) => {
        const day = parseDate(x);
        if (day === null) bad.push('"' + x + '" isn\'t a date (use e.g. 25-Dec-2026).');
        else skip.push(day);
      });
      if (bad.length) { d.body.querySelector('[data-err]').textContent = bad.join(' '); return; }
      set('settings', { enabled: q('upc-fl-on').checked, days: DAYS.map((_, i) => d.body.querySelector('[data-day="' + i + '"]').checked), offTime: off, offset, noticeTime: notice,
        skip: [...new Set(skip)].sort(), timerOn: q('upc-fl-timer').value || null,
        who: [...d.body.querySelectorAll('[data-who]')].filter((x) => x.checked).map((x) => x.dataset.who) });
      const st = state(); st.snoozeUntil = 0; set('state', st);
      d.close();
      setTimeout(showReminder, 300);
    });
  }

  if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('Forecourt lights: settings', showSettings);

  function start() {
    if (!U()) { console.error('[UPC forecourt lights] needs the core library'); return; }
    setTimeout(showReminder, 2000);   // after Halaxy has settled
    document.addEventListener('visibilitychange', () => { if (!document.hidden) showReminder(); });
    setInterval(showReminder, 5 * 60e3);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  // For tests and diagnostics.
  window.upcForecourtLights = { version: VERSION, userName, sunsetMinutes, plan, due, lastChange, nextChange, london, settings, state, showSettings };
})();
