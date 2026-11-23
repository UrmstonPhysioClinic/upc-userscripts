// ==UserScript==
// @name         UPC Calendar: Appointment reminders (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.1.0
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/appointment-reminders.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/appointment-reminders.user.js
// @description  Tidies Halaxy's own appointment reminder emails, in the background: cancels the reminder when the booking confirmation has only just gone, and adds one where an appointment has none. "Appointment reminders: recent changes" lists what it did.
// @match        https://*.halaxy.com/a/pr/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * Appointment reminders (CH, 23 Nov 2026; comms audit). Halaxy emails a confirmation when someone books and a reminder
 * at 06:00 two days before. Only these official emails carry the manage-booking link, so we tidy them rather than
 * replace them.
 *
 *  - Duplicates: when the confirmation went less than 24 hours (Clinic settings) before the reminder is due, the
 *    reminder is cancelled (CH: "yes").
 *  - Missing: an upcoming appointment with no email reminder gets Halaxy's own one added, at 06:00 two days before.
 *    If that time has passed, nothing is added (the confirmation has only just gone). Email only (CH: "we never use
 *    SMS").
 *  - Halaxy's reminders pop-up (capture, 23 Nov 2026): GET /appointment/reminder/{linkAPrPaG} returns a VIEW with
 *    #card-appointment-reminder-details: a "Reminders" section, then a "Notifications" section (the confirmation),
 *    each row td.reminderType ("Email" / "SMS/Text") and td.reminderStatusAndTime ("Send 24-Nov-2026 at 06:00", the
 *    same wording sent or not); a row still to go has a cancel link /appointment/reminder/{id}/cancel. Cancel takes
 *    effect at once, with no confirmation, and a cancelled reminder can't be scheduled again (only a new one added).
 *    Add: /appointment/reminder/{linkAPrPaG}/new/email, form#frmEditReminder with dateToSend[date|hour|min|isPM]
 *    (12-hour clock), Halaxy's own subject and body; Save answers OK. The linkAPrPaG id is in the appointment's view
 *    (/calendar/appointment/{prac}/{id}), on its reminders button.
 *  - Appointments starting in the next 4 days, each looked at once (again if it moves), 8 a run, every 10 minutes, in
 *    the visible tab while someone listed in Clinic settings is signed in. Shared across PCs ("UPC shared checks:
 *    Appointment reminders"): a.{appointment} = ok | cancelled | added | late | noemail | nolink | fail, then the time
 *    and the appointment's start.
 */
(() => {
  'use strict';
  if (window.__hxApptReminders) return;
  window.__hxApptReminders = true;

  const VERSION = '0.1.0';
  const DAY = 864e5, MIN = 60e3, HOUR = 3600e3;
  const EVERY = 10 * MIN, PER_RUN = 8, AHEAD = 4 * DAY, LOG_SIZE = 100;
  const U = () => window.UPC;
  const setting = (k, d) => { try { return U().settings.def(k) ? U().settings.get(k) : d; } catch (e) { return d; } };
  const PEOPLE = () => setting('apptReminders.people', ['Carl Healy', 'Wendy Pritchard']);
  const WITHIN = () => setting('apptReminders.cancelWithin', 24);
  const CANCEL = () => setting('apptReminders.cancel', 'on') === 'on';
  const ADD = () => setting('apptReminders.add', 'on') === 'on';
  const clean = (s) => String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim();
  const esc = (s) => U().esc(s);
  const two = (n) => String(n).padStart(2, '0');
  const when = (ms) => U().dayLabel(ms) + ' ' + two(new Date(ms).getHours()) + ':' + two(new Date(ms).getMinutes());
  const report = (msg) => { try { document.dispatchEvent(new CustomEvent('upc-loader-error', { detail: JSON.stringify({ file: 'appointment-reminders.user.js', message: String(msg) }) })); } catch (e) { /* ignore */ } };
  const shared = () => U().shared('Appointment reminders', { keep: 14 * DAY, claimFor: 10 * MIN, file: 'appointment-reminders.user.js' });
  const store = () => U().storage('upc-appt-reminders:');
  const LIVE = (e) => !e.appointmentStatus || /^check-response$/i.test(e.appointmentStatus);
  const nameOf = (e) => { let t = clean(U().htmlDoc(e.title || '').body.textContent); const i = t.lastIndexOf(' - '); if (i >= 0) t = t.slice(i + 3); return t.replace(/\s*\(?\+?[\d ]{9,}\)?\s*$/, '').replace(/^[\s*★]+/, '').trim() || 'Patient'; };
  // 06:00 two days before the appointment (Halaxy's own reminder time).
  const reminderTime = (start) => { const d = new Date(start); d.setHours(6, 0, 0, 0); d.setDate(d.getDate() - 2); return d.getTime(); };

  // ------------------------------------------------------------------ reading Halaxy

  async function appointments(now) {
    const list = await U().calendar.appointments(now, now + AHEAD);
    return list.filter((e) => e.type === 'appointment' && e.linkPaGId && !e.isGroupAppointment && !e.isRequest && LIVE(e) && Number(e.start) * 1000 > now)
      .map((e) => ({ id: String(e.id), start: Number(e.start) * 1000, sec: String(e.start), prac: String(e.practitionerID || ''), patient: String(e.linkPaGId), name: nameOf(e) }))
      .sort((a, b) => a.start - b.start);
  }

  // The appointment's reminders id (its linkAPrPaG), from its view.
  async function reminderId(a) {
    const j = await U().http.json('/calendar/appointment/' + encodeURIComponent(a.prac) + '/' + encodeURIComponent(a.id) + '?timestamp=' + encodeURIComponent(a.sec));
    const link = U().htmlDoc(j && j.message).querySelector('a[href*="/appointment/reminder/"]');
    const m = link && /\/appointment\/reminder\/(\d+)/.exec(link.getAttribute('href'));
    return m ? m[1] : null;
  }

  // The reminders pop-up's rows: { section: 'reminders' | 'notifications', type: 'email' | 'sms', at, id, canCancel }.
  async function reminders(lid) {
    const j = await U().http.json('/appointment/reminder/' + encodeURIComponent(lid));
    const doc = U().htmlDoc(j && j.message);
    const card = doc.querySelector('#card-appointment-reminder-details');
    if (!card) throw new (U().Error)('The appointment reminders pop-up has changed (#card-appointment-reminder-details not found).');
    const rows = [];
    let section = 'reminders';
    card.querySelectorAll('tr').forEach((tr) => {
      const th = tr.querySelector('th');
      if (th) { section = /notification/i.test(clean(th.textContent)) ? 'notifications' : 'reminders'; return; }
      const typeCell = tr.querySelector('td.reminderType');
      if (!typeCell) return;
      const m = /(\d{2}-[A-Za-z]{3}-\d{4})\s+at\s+(\d{1,2}):(\d{2})/.exec(clean((tr.querySelector('td.reminderStatusAndTime') || {}).textContent));
      const day = m ? U().parseDay(m[1]) : null;
      const at = day === null ? null : (() => { const d = new Date(day); d.setHours(+m[2], +m[3], 0, 0); return d.getTime(); })();
      const any = tr.querySelector('a[href*="/appointment/reminder/"]');
      const idm = any && /\/appointment\/reminder\/(\d+)\//.exec(any.getAttribute('href'));
      rows.push({ section, type: /sms|text/i.test(clean(typeCell.textContent)) ? 'sms' : 'email', at, id: idm ? idm[1] : null, canCancel: !!tr.querySelector('a[href$="/cancel"]') });
    });
    return rows;
  }

  async function cancelReminder(lid, rid) {
    const j = await U().http.json('/appointment/reminder/' + encodeURIComponent(rid) + '/cancel?modalSize=lg');
    if (!(j && (j.status === 'CUSTOMPOPUPRETURN' || /cancel/i.test(clean(j.title) + ' ' + clean(j.message))))) throw new (U().Error)('Halaxy did not confirm cancelling the reminder.');
    const after = await reminders(lid);
    if (after.some((r) => r.id === rid && r.canCancel)) throw new (U().Error)('The reminder still shows as due after cancelling it.');
  }

  async function addReminder(lid, at) {
    const path = '/appointment/reminder/' + encodeURIComponent(lid) + '/new/email';
    const { doc } = await U().http.popup(path);
    const form = doc.querySelector('form#frmEditReminder');
    const need = ['form[email]', 'dateToSend[date]', 'dateToSend[hour]', 'dateToSend[min]', 'dateToSend[isPM]', 'form[subject]', 'form[body]', 'form[_token]'];
    const missing = need.filter((k) => !form || !form.querySelector('[name="' + k + '"]'));
    if (missing.length) throw new (U().Error)('The Add email reminder pop-up has changed (' + missing.join(', ') + ' not found).');
    if (!clean(form.querySelector('[name="form[email]"]').value)) return 'noemail';
    const d = new Date(at), h = d.getHours();
    const set = { 'dateToSend[date]': U().dayLabel(at), 'dateToSend[hour]': String(h % 12 || 12), 'dateToSend[min]': String(d.getMinutes()), 'dateToSend[isPM]': h >= 12 ? '1' : '0' };
    const pairs = U().http.serialize(form).map(([k, v]) => [k, Object.prototype.hasOwnProperty.call(set, k) ? set[k] : v]);
    U().http.expectRefresh(await U().http.postForm(path, pairs), 'The new reminder');
    const after = await reminders(lid);
    if (!after.some((r) => r.section === 'reminders' && r.type === 'email' && r.at === at)) throw new (U().Error)('The new reminder did not show after saving it.');
    return 'added';
  }

  // What to do for one appointment, and doing it. Returns the outcome word.
  async function one(a, now) {
    const lid = await reminderId(a);
    if (!lid) return 'nolink';
    const rows = await reminders(lid);
    const rem = rows.find((r) => r.section === 'reminders' && r.type === 'email');
    const conf = rows.find((r) => r.section === 'notifications' && r.type === 'email');
    if (rem) {
      if (CANCEL() && rem.canCancel && rem.id && conf && conf.at !== null && rem.at !== null && conf.at <= now && rem.at - conf.at < WITHIN() * HOUR) {
        await cancelReminder(lid, rem.id);
        log(a, 'cancelled', 'Reminder ' + when(rem.at) + ' cancelled: confirmation sent ' + when(conf.at));
        return 'cancelled';
      }
      return 'ok';
    }
    if (!ADD()) return 'ok';
    const at = reminderTime(a.start);
    if (at <= now + 15 * MIN) return 'late';
    const r = await addReminder(lid, at);
    log(a, r, r === 'added' ? 'Reminder added for ' + when(at) : 'No email address: no reminder added');
    return r;
  }

  function log(a, what, text) {
    const l = store().get('log', []);
    l.unshift({ at: Date.now(), id: a.id, patient: a.patient, name: a.name, start: a.start, what, text });
    store().set('log', l.slice(0, LOG_SIZE));
  }

  // ------------------------------------------------------------------ the run

  let running = null;
  function run() {
    if (running) return running;
    running = (async () => {
      const now = Date.now();
      const sh = shared();
      const list = await appointments(now);
      const recs = await sh.read(60e3);
      const val = (k) => (recs[k] && recs[k].value) || '';
      const due = list.filter((a) => {
        const v = val('a.' + a.id).split(' ');
        if (!v[0]) return true;
        if (v[v.length - 1] !== a.sec) return true;   // moved since
        return v[0] === 'fail' && now - Number(v[1]) > 60 * MIN;
      }).slice(0, PER_RUN);
      const mine = due.length ? await sh.claim(due.map((a) => 'a.' + a.id)) : [];
      const outcomes = {};
      for (const a of due.filter((x) => mine.includes('a.' + x.id))) {
        if (U().http.pausedFor() > 0) break;
        try { outcomes['a.' + a.id] = (await one(a, now)) + ' ' + now + ' ' + a.sec; } catch (e) {
          outcomes['a.' + a.id] = 'fail ' + now + ' ' + a.sec;
          log(a, 'error', 'Not changed: ' + (e.message || e));
          if (/has changed/.test(e.message || '')) report(e.message);
        }
      }
      if (Object.keys(outcomes).length) await sh.write(outcomes);
      store().set('lastRun', { at: now, by: VERSION, looked: Object.keys(outcomes).length });
      return outcomes;
    })().finally(() => { running = null; });
    return running;
  }

  function background() {
    if (!U() || !U().background || !U().background.ok() || !U().user.is(PEOPLE())) return;
    if (!CANCEL() && !ADD()) return;
    const last = store().get('ran', 0);
    if (!U().background.due(last, EVERY)) return;
    store().set('ran', Date.now());
    run().catch((e) => { console.warn('[UPC appointment reminders]', e); store().set('lastRun', { at: Date.now(), by: VERSION, error: e.message || String(e) }); });
  }

  // ------------------------------------------------------------------ recent changes

  function showLog() {
    U().ui.nativeStyles();
    const dlg = U().ui.dialog({ title: 'Appointment reminders: recent changes', key: 'upc-appt-reminders-log' });
    if (!dlg) return;
    const base = U().base();
    const l = store().get('log', []), last = store().get('lastRun', null);
    const at = (ms) => two(new Date(ms).getHours()) + ':' + two(new Date(ms).getMinutes()) + ' on ' + U().dayLabel(ms);
    dlg.root.setAttribute('data-upc-ar-log', '');
    dlg.body.innerHTML = '<p class="text-muted">' + (last ? 'Checked at ' + esc(at(last.at)) + '.' : 'Not checked yet.') + '</p>' +
      (last && last.error ? '<div class="alert alert-danger upc-err">' + esc(last.error) + '</div>' : '') +
      (l.length ? '<table class="table table-striped table-bordered w-100 m-0"><thead><tr><th>When</th><th>Patient</th><th>Appointment</th><th>Change</th></tr></thead><tbody>' +
        l.map((x) => '<tr><td>' + esc(when(x.at)) + '</td><td><a href="' + esc(base + '/patient/' + x.patient) + '" target="_blank" rel="noopener">' + esc(x.name) + '</a></td>' +
          '<td>' + esc(when(x.start)) + '</td><td' + (x.what === 'error' ? ' class="upc-err"' : '') + '>' + esc(x.text) + '</td></tr>').join('') + '</tbody></table>'
        : '<p class="text-muted">None.</p>');
  }

  function start() {
    if (!U() || !U().shared || !U().calendar) { console.error('[UPC appointment reminders] needs the core library'); return; }
    U().user.whenAllowed(PEOPLE(), () => {
      if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('Appointment reminders: recent changes', showLog);
      document.addEventListener('visibilitychange', background);
      setTimeout(background, 25000);
      setInterval(background, 60e3);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  window.upcApptReminders = { version: VERSION, run, one, reminders, reminderTime };
})();
