// ==UserScript==
// @name         UPC Patients: Patient forms (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.1.1
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/patient-forms.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/patient-forms.user.js
// @description  Pre-appointment forms: sends the right form (Initial Assessment by insurer, Progress Update, or the Follow-up Form for the last funded appointment) to bookings Halaxy's 05:00 campaigns miss, and an 18:00 reminder with the original link for any form not yet filled in. Patients > Patient forms lists today's and tomorrow's appointments.
// @match        https://*.halaxy.com/a/pr/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * Patient forms (Carl, 17 Nov 2026). Forms go out at 05:00 the day before an appointment, through Halaxy's own Send
 * Patient form (so the form is linked to the patient and the email is Halaxy's), never twice.
 *
 *  Which form (Clinic settings decide whether this script sends: late bookings only while the 05:00 campaigns still
 *  run, all bookings once they are retired, or nobody):
 *   - Fee item code with "IA": "Initial Assessment Form - <insurer>" when a form matches the fee's funder by name,
 *     else "Initial Assessment Form - Standard"; template "Form - Initial Assessment".
 *   - "FU": "Progress Update" / "Form - Progress Update", or for the last funded appointment (the invoice's
 *     "(10th of 10 appts)"; the side panel's "9 / 10 appointments attended" says the same) the "Follow-up Form" /
 *     "Form - Follow-up Form" instead.
 *   - No fee yet (2a / 2b bookings): left until one is added. Other fees: no form.
 *  How it is sent (captures 17 Nov 2026):
 *   - Send Patient form: GET/POST /email/patient-form/patient/:linkPaG/patientForm (form#composeEmailForm):
 *     form[intakeForm], form[expiry], form[link_pr_g] (Sender: the treating practitioner), form[fromName|fromEmail],
 *     form[subject], form[recipientType], form[toLinkPaGPaG], form[toEmail|ccEmail|bccEmail], form[template],
 *     form[body], form[_token], form[scheduleDetails][scheduleDate] + [scheduleTime][hour|minute] (empty: now).
 *     Answers REFRESH. Its History (form, "dd-Mon-yyyy HH:MM via email", completed date or "No (Access unique
 *     link)" with the patient's own link /a/online/form/..., expiry) says what has gone and what is filled in.
 *   - The template as saved, tags unfilled: /communication/template/list/:id, textarea form[contentForFormHandler] and
 *     form[subject]. Halaxy fills [Practitioner First Name] and the appointment tags with the signed-in person's
 *     details, so the script writes them in from the appointment ("Tuesday 18-Nov-2026 10:00", Halaxy's style) and
 *     leaves [Patient First Name] and [Online Form Link] for Halaxy. A template with any other practitioner or
 *     appointment tag isn't sent.
 *   - Scheduled emails: GET /api/v2/practitioner/messaging/history/scheduled/emails?_locale=:pg&linkPaG=:id
 *     (bearer token) -> data.emailMessages [{ sentDateLocal 'dd-Mon-yyyy HH:MM' (UK time), subject, entityId,
 *     emailCancelUrl, emailStatus }]; the cancel link is followed to cancel one.
 *  Reminders (Carl: "include the original form link, so they don't lose their progress"): at 18:00 the day before, the
 *  same email with "Reminder: " before the subject and the original link, sent with Email patient (/email/compose/
 *  patient/:id, the same form with Schedule). Scheduled once the form has gone (campaign or ours) and cancelled when a
 *  PC sees the form filled in. None for a form sent less than 6 hours before. A Monday appointment's form goes on Sunday, so its reminder needs a PC on that afternoon.
 *  Shared note "UPC shared checks: Patient forms": a.<appointment> what happened to the form, r.<appointment> the
 *  reminder. One PC at a time works each appointment (claims). Background: the visible tab, every 10 minutes.
 */
(() => {
  'use strict';
  if (window.__hxPatientForms) return;
  window.__hxPatientForms = true;

  const VERSION = '0.1.1';
  // 0.1.1: sending and reminders held. 0.1.0 couldn't read the form history on live Halaxy (17 Nov 2026) and sent
  // Progress Updates the campaign had already sent. Held until the history is read correctly.
  const HOLD = true;
  const U = () => window.UPC;
  const ROUTE = 'upc-patient-forms';
  const MENU_CLS = 'upc-pf-menu';
  const DAY = 86400e3, MIN = 60e3;
  const EVERY = 10 * MIN;
  const SEEN_WINDOW = 18 * 3600e3;   // a form sent this long before the send time counts as this appointment's
  const PER_RUN = 4;                 // sends or reminders scheduled in one run, at most
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const IA_TEMPLATE = 'Form - Initial Assessment', PU_FORM = 'Progress Update', PU_TEMPLATE = 'Form - Progress Update';
  const FU_FORM = 'Follow-up Form', FU_TEMPLATE = 'Form - Follow-up Form', IA_PREFIX = 'Initial Assessment Form - ', IA_STANDARD = 'Initial Assessment Form - Standard';
  const PRE_FORM = (name) => name.startsWith(IA_PREFIX) || name === PU_FORM || name === FU_FORM;
  const TEMPLATE_FOR = (form) => (form.startsWith(IA_PREFIX) ? IA_TEMPLATE : form === FU_FORM ? FU_TEMPLATE : PU_TEMPLATE);

  const setting = (k, d) => { try { return U().settings.def(k) ? U().settings.get(k) : d; } catch (e) { return d; } };
  const MODE = () => setting('patientForms.send', 'late');
  const SEND_AT = () => setting('patientForms.sendAt', '05:00');
  const CHASE = () => setting('patientForms.chase', 'on') === 'on';
  const CHASE_AT = () => setting('patientForms.chaseAt', '18:00');
  const PEOPLE = () => setting('patientForms.people', ['Carl Healy', 'Wendy Pritchard']);

  const clean = (s) => String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim();
  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const two = (n) => String(n).padStart(2, '0');
  const hhmm = (ms) => { const d = new Date(ms); return two(d.getHours()) + ':' + two(d.getMinutes()); };
  const when = (ms) => U().dayLabel(ms) + ' ' + hhmm(ms);
  const apptText = (ms) => WEEKDAYS[new Date(ms).getDay()] + ' ' + when(ms);   // as Halaxy writes [Appointment Day / Date / Time]
  const at = (dayMs, time) => { const d = new Date(dayMs); const [h, m] = String(time).split(':').map(Number); d.setHours(h, m, 0, 0); return d.getTime(); };
  const dayBefore = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 1); return d.getTime(); };
  const sendTime = (start) => at(dayBefore(start), SEND_AT());
  const chaseTime = (start) => at(dayBefore(start), CHASE_AT());
  const parseWhen = (s) => { const m = /(\d{2}-[A-Za-z]{3}-\d{4})\s+(\d{1,2}):(\d{2})/.exec(s || ''); if (!m) return null; const d = U().parseDay(m[1]); return d === null ? null : at(d, m[2] + ':' + m[3]); };
  const report = (msg) => { try { document.dispatchEvent(new CustomEvent('upc-loader-error', { detail: JSON.stringify({ file: 'patient-forms.user.js', message: String(msg) }) })); } catch (e) { /* ignore */ } };

  const shared = () => U().shared('Patient forms', { keep: 14 * DAY, claimFor: 10 * MIN, file: 'patient-forms.user.js' });
  const store = () => U().storage('upc-patient-forms:');

  // ------------------------------------------------------------------ reading Halaxy

  const titleText = (e) => clean(U().htmlDoc(e.title || '').body.textContent);
  const nameOf = (e) => { let t = titleText(e); const i = t.lastIndexOf(' - '); if (i >= 0) t = t.slice(i + 3); return t.replace(/\s*\(?\+?[\d ]{9,}\)?\s*$/, '').replace(/^[\s*★]+/, '').trim() || 'Patient'; };
  const LIVE = (e) => !e.appointmentStatus || /^check-response$/i.test(e.appointmentStatus);

  async function appointments(fromMs, toMs) {
    const list = await U().calendar.appointments(fromMs, toMs);
    return list.filter((e) => e.type === 'appointment' && e.linkPaGId && !e.isGroupAppointment && !e.isRequest && LIVE(e))
      .map((e) => ({ id: String(e.id), start: Number(e.start) * 1000, patient: String(e.linkPaGId), name: nameOf(e), pracId: String(e.practitionerID || ''), invoiceId: e.invoiceID ? String(e.invoiceID) : '' }))
      .sort((a, b) => a.start - b.start);
  }

  let cache = null;   // per run: practitioners, fees, templates
  async function lookups() {
    if (cache && Date.now() - cache.at < 5 * MIN) return cache;
    const [pracs, fees] = await Promise.all([U().http.json('/lookup/practitioner?clinic=&include_id=&type='), U().http.json('/funder/fee/data')]);
    cache = { at: Date.now(), pracs: new Map((Array.isArray(pracs) ? pracs : []).map((p) => [String(p.id), clean(p.name)])), fees: Array.isArray(fees) ? fees : [], templates: {} };
    return cache;
  }

  // The Send Patient form pop-up: the form, its choices and the patient's form History.
  async function sendForm(patientId) {
    const path = '/email/patient-form/patient/' + encodeURIComponent(patientId) + '/patientForm';
    const { doc } = await U().http.popup(path);
    const form = doc.querySelector('form#composeEmailForm');
    const need = ['form[intakeForm]', 'form[link_pr_g]', 'form[subject]', 'form[body]', 'form[toEmail]', 'form[_token]', 'form[scheduleDetails][scheduleDate]'];
    const missing = need.filter((k) => !form || !form.querySelector('[name="' + k + '"]'));
    if (missing.length) throw new (U().Error)('The Send Patient form pop-up has changed (' + missing.join(', ') + ' not found).');
    const options = (name) => [...form.querySelectorAll('select[name="' + name + '"] option')].filter((o) => o.value).map((o) => ({ value: o.value, text: clean(o.textContent) }));
    const history = [...doc.querySelectorAll('tr')].filter((tr) => /via (email|sms)/i.test(tr.textContent)).map((tr) => {
      const td = tr.querySelectorAll('td');
      const link = tr.querySelector('a[href*="/online/form/"]');
      return { form: clean(td[0] && td[0].textContent), sent: parseWhen(td[1] && td[1].textContent), completed: parseWhen(td[2] && td[2].textContent), link: link ? link.getAttribute('href') : '' };
    }).filter((h) => h.form && h.sent);
    return { path, form, forms: options('form[intakeForm]'), senders: options('form[link_pr_g]'), templates: options('form[template]'), to: clean((form.querySelector('[name="form[toEmail]"]') || {}).value), history };
  }

  // A communication template as saved, with its tags unfilled: { subject, body }.
  async function template(id) {
    const c = await lookups();
    if (c.templates[id]) return c.templates[id];
    const doc = await U().http.html('/communication/template/list/' + encodeURIComponent(id));
    const body = doc.querySelector('textarea[name="form[contentForFormHandler]"]');
    const subject = doc.querySelector('[name="form[subject]"]');
    if (!body || !clean(body.value || body.textContent)) throw new (U().Error)('A communication template couldn\'t be read (its edit page has changed).');
    c.templates[id] = { subject: clean(U().htmlDoc(subject ? (subject.value || subject.textContent) : '').body.textContent), body: body.value || body.textContent };
    return c.templates[id];
  }

  // Fills the practitioner and appointment tags from the appointment; Halaxy fills the patient's and the form link.
  const BLOCKED = /^(Practitioner\b|Appointment (Date|Time|Day|Practitioner))/;
  function fill(text, a, pracName, html) {
    const first = pracName.split(' ')[0];
    const map = { 'Practitioner First Name': first, 'Practitioner Name': pracName, 'Practitioner Surname': pracName.split(' ').slice(1).join(' '), 'Appointment Practitioner': pracName,
      'Appointment Day / Date / Time': apptText(a.start), 'Appointment Date': U().dayLabel(a.start), 'Appointment Time': hhmm(a.start) };
    const left = [];
    const out = String(text).replace(/(<span class="dynamicterm">)?\[([A-Za-z][A-Za-z /]{1,40})\](<\/span>)?/g, (m, open, tag) => {
      if (Object.prototype.hasOwnProperty.call(map, tag)) return html ? esc(map[tag]) : map[tag];
      if (BLOCKED.test(tag)) left.push('[' + tag + ']');
      return m;
    });
    if (left.length) throw new (U().Error)('The template has ' + left.join(', ') + ', which Halaxy fills with the signed-in person\'s details. Nothing was sent.');
    return out;
  }

  async function scheduledEmails(patientId) {
    const headers = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
    if (window.Hk && window.Hk.jwt) headers.Authorization = 'Bearer ' + window.Hk.jwt;
    const j = await U().http.json(location.origin + '/api/v2/practitioner/messaging/history/scheduled/emails?_locale=' + U().pg() + '&linkPaG=' + encodeURIComponent(patientId) + '&dateFrom=&dateTo=&term=&contacts=false', { headers });
    const list = j && j.data && j.data.emailMessages;
    if (!Array.isArray(list)) throw new (U().Error)('Halaxy\'s scheduled emails list has changed.');
    return list.map((m) => ({ id: String(m.entityId), at: parseWhen(m.sentDateLocal), subject: clean(m.subject), cancel: m.emailCancelUrl || '', status: clean(m.emailStatus) }));
  }

  // ------------------------------------------------------------------ deciding

  // { form, template } for the appointment, or { skip: 'wait' | 'none' }.
  async function choose(a, sf) {
    if (!a.invoiceId) return { skip: 'wait' };
    const inv = await U().invoice.fetch(a.invoiceId);
    const line = inv.lines.find((l) => l.appointmentId === a.id) || inv.lines.find((l) => l.date === U().dayLabel(a.start)) || inv.lines[0];
    if (!line || !line.item) return { skip: 'wait' };
    const has = (code) => new RegExp('(^|[^A-Za-z])' + code + '([^A-Za-z]|$)').test(line.item);
    const names = sf.forms.map((f) => f.text);
    if (has('IA')) {
      const fee = (await lookups()).fees.find((f) => clean(f.feeNumber) === line.item);
      const funder = clean(fee && fee.funder).toLowerCase();
      const own = funder && names.filter((n) => n.startsWith(IA_PREFIX) && n !== IA_STANDARD)
        .find((n) => { const x = n.slice(IA_PREFIX.length).toLowerCase(); return funder.includes(x) || x.includes(funder); });
      return { form: own || IA_STANDARD, template: IA_TEMPLATE };
    }
    if (has('FU')) {
      const last = inv.referral && inv.referral.limit > 0 && inv.referral.position >= inv.referral.limit;
      return last ? { form: FU_FORM, template: FU_TEMPLATE } : { form: PU_FORM, template: PU_TEMPLATE };
    }
    return { skip: 'none' };
  }

  // The pre-appointment form already sent for this appointment (campaign, a person or this script), if any.
  const sentFor = (a, history) => history.filter((h) => PRE_FORM(h.form) && h.sent >= sendTime(a.start) - SEEN_WINDOW && h.sent <= a.start).sort((x, y) => y.sent - x.sent)[0] || null;

  const pick = (list, text) => { const o = list.find((x) => x.text.toLowerCase() === String(text).toLowerCase()); return o ? o.value : null; };

  // Sends (or schedules) the form for one appointment; returns the outcome to record.
  async function sendOne(a, now) {
    if (!a.invoiceId) return 'wait ' + now;   // no fee yet: nothing else is read
    const sf = await sendForm(a.patient);
    const had = sentFor(a, sf.history);
    if (had) return 'had ' + had.sent + ' ' + had.form;
    const c = await choose(a, sf);
    if (c.skip) return c.skip === 'wait' ? 'wait ' + now : 'none';
    const formId = pick(sf.forms, c.form), templateId = pick(sf.templates, c.template);
    if (!formId) throw new (U().Error)('"' + c.form + '" is not in the Send Patient form list.');
    if (!templateId) throw new (U().Error)('No "' + c.template + '" template in Halaxy\'s communication templates.');
    if (!sf.to) throw new (U().Error)('No email address for ' + a.name + '.');
    const pracName = (await lookups()).pracs.get(a.pracId) || '';
    const sender = pick(sf.senders, pracName);
    if (!pracName || !sender) throw new (U().Error)('The practitioner for ' + a.name + '\'s appointment isn\'t in the Sender list.');
    const t = await template(templateId);
    const due = sendTime(a.start);
    const later = due > now + 5 * MIN;
    const set = {
      'form[intakeForm]': formId, 'form[link_pr_g]': sender, 'form[template]': '',
      'form[subject]': fill(t.subject, a, pracName, false), 'form[body]': fill(t.body, a, pracName, true),
      'form[scheduleDetails][scheduleDate]': later ? U().dayLabel(due) : '',
      'form[scheduleDetails][scheduleTime][hour]': later ? String(new Date(due).getHours()) : '0',
      'form[scheduleDetails][scheduleTime][minute]': later ? String(new Date(due).getMinutes()) : '0',
    };
    const pairs = U().http.serialize(sf.form).map(([k, v]) => [k, k in set ? set[k] : v]);
    Object.keys(set).forEach((k) => { if (!pairs.some(([x]) => x === k)) pairs.push([k, set[k]]); });
    const res = await U().http.postForm(sf.path, pairs);
    if (!res || !['REFRESH', 'OK', 'POPUP'].includes(res.status)) U().http.expectRefresh(res, 'Sending ' + c.form);
    if (later) {
      const s = (await scheduledEmails(a.patient)).find((m) => m.at === due && m.subject === set['form[subject]']);
      if (!s) throw new (U().Error)('Halaxy accepted ' + c.form + ' for ' + a.name + ', but it isn\'t in their scheduled emails.');
      return 'sched ' + due + ' ' + c.form;
    }
    const after = (await sendForm(a.patient)).history.find((h) => h.form === c.form && h.sent >= now - 10 * MIN);
    if (!after) throw new (U().Error)('Halaxy accepted ' + c.form + ' for ' + a.name + ', but it isn\'t in their form history.');
    return 'sent ' + after.sent + ' ' + c.form;
  }

  // Schedules the reminder for one appointment's form; returns the outcome to record.
  async function remindOne(a, now) {
    const sf = await sendForm(a.patient);
    const h = sentFor(a, sf.history);
    if (!h) return null;                       // nothing sent yet: try again later
    if (h.completed) return 'done';
    if (h.sent > chaseTime(a.start) - 6 * 3600e3) return 'late';     // sent after midday: a reminder that evening would only crowd it
    if (!h.link) return 'nolink';
    const due = chaseTime(a.start);
    const pracName = (await lookups()).pracs.get(a.pracId) || '';
    const templateId = pick(sf.templates, TEMPLATE_FOR(h.form));
    if (!templateId || !pracName) return 'nolink';
    const t = await template(templateId);
    const link = /^https?:/.test(h.link) ? h.link : location.origin + h.link;
    const subject = 'Reminder: ' + fill(t.subject, a, pracName, false);
    const body = fill(t.body, a, pracName, true).replace(/(<span class="dynamicterm">)?\[Online Form Link\](<\/span>)?/g, '<a href="' + esc(link) + '" style="color:#7a33c7;">Open your form</a>');
    if (!/\/online\/form\//.test(body)) throw new (U().Error)('The "' + TEMPLATE_FOR(h.form) + '" template has no [Online Form Link], so the reminder would have no link.');
    const path = '/email/compose/patient/' + encodeURIComponent(a.patient);
    const { doc } = await U().http.popup(path);
    const form = doc.querySelector('form#composeEmailForm');
    if (!form || !form.querySelector('[name="form[body]"]') || !form.querySelector('[name="form[scheduleDetails][scheduleDate]"]')) throw new (U().Error)('The Email patient pop-up has changed.');
    const set = { 'form[subject]': subject, 'form[body]': body, 'form[template]': '', 'form[scheduleDetails][scheduleDate]': U().dayLabel(due),
      'form[scheduleDetails][scheduleTime][hour]': String(new Date(due).getHours()), 'form[scheduleDetails][scheduleTime][minute]': String(new Date(due).getMinutes()) };
    const pairs = U().http.serialize(form).map(([k, v]) => [k, k in set ? set[k] : v]);
    Object.keys(set).forEach((k) => { if (!pairs.some(([x]) => x === k)) pairs.push([k, set[k]]); });
    const res = await U().http.postForm(path, pairs);
    if (!res || !['REFRESH', 'OK', 'POPUP'].includes(res.status)) U().http.expectRefresh(res, 'Scheduling the reminder');
    const s = (await scheduledEmails(a.patient)).find((m) => m.at === due && m.subject === subject);
    if (!s) throw new (U().Error)('Halaxy accepted the reminder for ' + a.name + ', but it isn\'t in their scheduled emails.');
    return 'sched ' + s.id + ' 0';
  }

  // Cancels a scheduled reminder (Halaxy's own cancel link from the scheduled list).
  async function cancelReminder(a, entityId) {
    const s = (await scheduledEmails(a.patient)).find((m) => m.id === String(entityId));
    if (!s) return;                             // already gone
    if (!s.cancel) throw new (U().Error)('The reminder for ' + a.name + ' has no cancel link.');
    await U().http.fragment(s.cancel);
    if ((await scheduledEmails(a.patient)).some((m) => m.id === String(entityId) && /scheduled/i.test(m.status || 'scheduled'))) throw new (U().Error)('The reminder for ' + a.name + ' couldn\'t be cancelled.');
  }

  // ------------------------------------------------------------------ the run

  let running = null;
  async function run(force) {
    if (running) return running;
    running = (async () => {
      const now = Date.now();
      const mode = MODE();
      const sh = shared();
      const day0 = new Date(now); day0.setHours(0, 0, 0, 0);
      const list = await appointments(now, day0.getTime() + (mode === 'all' ? 3 : 2) * DAY);
      const recs = await sh.read(force ? 0 : 60e3);
      const val = (k) => (recs[k] && recs[k].value) || '';
      const outcomes = {};
      let done = 0;

      // Forms: late bookings (the send time has passed), or every booking up to the day after tomorrow.
      if (mode !== 'off' && !HOLD) {
        const due = list.filter((a) => {
          const v = val('a.' + a.id);
          if (/^(had|sent|sched|none|skip)/.test(v)) return false;
          if (/^(wait|fail) (\d+)/.test(v) && now - Number(v.split(' ')[1]) < (v.startsWith('fail') ? 60 : 30) * MIN) return false;
          return mode === 'all' || sendTime(a.start) <= now;
        });
        const mine = due.length ? await sh.claim(due.slice(0, PER_RUN).map((a) => 'a.' + a.id)) : [];
        for (const a of due.filter((x) => mine.includes('a.' + x.id))) {
          try { outcomes['a.' + a.id] = await sendOne(a, now); } catch (e) { outcomes['a.' + a.id] = 'fail ' + now; report(a.name + ': ' + (e.message || e)); }
          done += 1;
        }
      }

      // Reminders: tomorrow's appointments, before the reminder time.
      if (CHASE() && !HOLD) {
        const tomorrow = list.filter((a) => dayBefore(a.start) === day0.getTime() && now < chaseTime(a.start) - 5 * MIN);
        const toSchedule = tomorrow.filter((a) => {
          const v = val('r.' + a.id);
          if (/^(sched|done|nolink|late|cancelled)/.test(v)) return false;
          if (/^fail (\d+)/.test(v) && now - Number(v.split(' ')[1]) < 60 * MIN) return false;
          return now >= sendTime(a.start) + 15 * MIN;   // the form has had time to go
        }).slice(0, Math.max(0, PER_RUN - done));
        const mineR = toSchedule.length ? await sh.claim(toSchedule.map((a) => 'r.' + a.id)) : [];
        for (const a of toSchedule.filter((x) => mineR.includes('r.' + x.id))) {
          try { const r = await remindOne(a, now); if (r) outcomes['r.' + a.id] = r; } catch (e) { outcomes['r.' + a.id] = 'fail ' + now; report(a.name + ' (reminder): ' + (e.message || e)); }
        }
        // Filled in since? Checked once in the last 90 minutes before the reminder goes.
        const toCheck = tomorrow.filter((a) => /^sched \S+ (\d+)$/.test(val('r.' + a.id)) && now >= chaseTime(a.start) - 90 * MIN && Number(val('r.' + a.id).split(' ')[2]) < chaseTime(a.start) - 90 * MIN);
        const mineC = toCheck.length ? await sh.claim(toCheck.map((a) => 'r.' + a.id)) : [];
        for (const a of toCheck.filter((x) => mineC.includes('r.' + x.id))) {
          const entity = val('r.' + a.id).split(' ')[1];
          try {
            const h = sentFor(a, (await sendForm(a.patient)).history);
            if (h && h.completed) { await cancelReminder(a, entity); outcomes['r.' + a.id] = 'done'; } else outcomes['r.' + a.id] = 'sched ' + entity + ' ' + now;
          } catch (e) { outcomes['r.' + a.id] = 'sched ' + entity + ' ' + now; report(a.name + ' (reminder check): ' + (e.message || e)); }
        }
      }
      // A reminder for an appointment that has gone (cancelled, moved or marked) is cancelled.
      const live = new Set(list.map((a) => a.id));
      const gone = Object.keys(recs).filter((k) => /^r\.\d+$/.test(k) && /^sched /.test(val(k)) && !live.has(k.slice(2)) && now - (recs[k].at || 0) < 2 * DAY);
      if (gone.length) {
        const fresh = await appointments(now - DAY, day0.getTime() + 3 * DAY).catch(() => null);
        for (const k of gone.slice(0, 3)) {
          const id = k.slice(2);
          if (fresh && fresh.some((a) => a.id === id && a.start > now)) continue;
          const pat = (store().get('patients', {}) || {})[id];
          if (!pat) continue;
          try { await cancelReminder({ patient: pat, name: 'a patient' }, val(k).split(' ')[1]); outcomes[k] = 'cancelled'; } catch (e) { report('Reminder for a cancelled appointment: ' + (e.message || e)); }
        }
      }
      // Which patient each appointment belongs to, for cancelling after the appointment has left the calendar.
      const pats = store().get('patients', {}) || {};
      list.forEach((a) => { pats[a.id] = a.patient; });
      Object.keys(pats).slice(0, -400).forEach((k) => delete pats[k]);
      store().set('patients', pats);

      if (Object.keys(outcomes).length) await sh.write(outcomes);
      const pr = (await lookups().catch(() => null)) || { pracs: new Map() };
      store().set('last', { at: now, list: list.map((a) => ({ id: a.id, start: a.start, name: a.name, patient: a.patient, prac: pr.pracs.get(a.pracId) || '' })) });
      return outcomes;
    })().finally(() => { running = null; });
    return running;
  }

  function background() {
    if (HOLD || !U() || !U().background || MODE() === 'off' && !CHASE()) return;
    if (!U().background.ok()) return;
    const last = store().get('ran', 0);
    if (!U().background.due(last, EVERY)) return;
    store().set('ran', Date.now());
    run(false).then(() => { if (root) render(); }).catch((e) => console.warn('[UPC patient forms]', e));
  }

  // ------------------------------------------------------------------ Patients > Patient forms

  let root = null, unmount = null, busy = false, error = '';
  const CSS = `
    .upc-pf td.upc-pf-when { white-space: nowrap; }
  `;

  function statusOf(a, recs) {
    const v = (recs['a.' + a.id] || {}).value || '';
    const w = v.split(' ');
    const rest = w.slice(2).join(' ');
    if (/^had /.test(v)) return 'Sent ' + when(Number(w[1])) + (rest ? ': ' + rest : '');
    if (/^sent /.test(v)) return 'Sent ' + when(Number(w[1])) + (rest ? ': ' + rest : '');
    if (/^sched /.test(v)) return 'Scheduled for ' + when(Number(w[1])) + (rest ? ': ' + rest : '');
    if (/^wait/.test(v)) return 'Waiting for a fee';
    if (v === 'none') return 'No form for this fee';
    if (v === 'skip') return 'Not sending';
    if (/^fail/.test(v)) return 'Not sent yet';
    const due = sendTime(a.start);
    return due > Date.now() ? 'Due ' + when(due) + (MODE() === 'late' ? ' (campaign)' : '') : '';
  }
  function reminderOf(a, recs) {
    const v = (recs['r.' + a.id] || {}).value || '';
    if (/^sched /.test(v)) return 'Reminder ' + hhmm(chaseTime(a.start));
    if (v === 'done') return 'Filled in';
    if (v === 'cancelled') return 'Reminder cancelled';
    if (v === 'nolink') return 'No link to send';
    if (v === 'late') return 'No reminder';
    return '';
  }

  function render() {
    if (!root) return;
    const last = store().get('last', null);
    const recs = shared().cached();
    let h = '<div class="d-flex align-items-center mb-3"><h1 class="mb-0 mr-auto">Patient forms</h1>' +
      '<button type="button" class="btn btn-outline-primary" data-a="refresh"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Checking...' : 'Check now') + '</button></div>';
    if (busy) h += U().ui.run.inline('');
    if (error) h += '<div class="alert alert-danger upc-err">' + esc(error) + '</div>';
    if (last) {
      const day0 = new Date(); day0.setHours(0, 0, 0, 0);
      const groups = [['Today', day0.getTime()], ['Tomorrow', day0.getTime() + DAY]];
      groups.forEach(([title, d]) => {
        const rows = last.list.filter((a) => a.start >= d && a.start < d + DAY && a.start > Date.now() - 2 * 3600e3);
        h += '<div class="card"><div class="card-header"><h2>' + title + ' (' + rows.length + ')</h2></div><div class="card-body p-0">' +
          (rows.length ? '<table class="table table-striped table-bordered w-100 m-0"><thead><tr><th>Appointment</th><th>Patient</th><th>Practitioner</th><th>Form</th><th>Reminder</th><th></th></tr></thead><tbody>' +
            rows.map((a) => {
              const v = (recs['a.' + a.id] || {}).value || '';
              const canSkip = !/^(had|sent|sched|skip|none)/.test(v) && MODE() !== 'off';
              return '<tr><td class="upc-pf-when">' + esc(hhmm(a.start)) + '</td><td><a href="' + esc(U().base() + '/patient/' + a.patient) + '" target="_blank" rel="noopener">' + esc(a.name) + '</a></td>' +
                '<td>' + esc(a.prac || '') + '</td><td>' + esc(statusOf(a, recs)) + '</td><td>' + esc(reminderOf(a, recs)) + '</td>' +
                '<td>' + (canSkip ? '<button type="button" class="btn btn-sm btn-outline-primary-light" data-a="skip" data-id="' + esc(a.id) + '">Don\'t send</button>' : '') + '</td></tr>';
            }).join('') + '</tbody></table>' : '<p class="text-muted m-3">None.</p>') + '</div></div>';
      });
      h += '<p class="text-muted">Checked at ' + esc(hhmm(last.at) + ' on ' + U().dayLabel(last.at)) + '.</p>';
    }
    root.innerHTML = h;
  }

  async function check() {
    busy = true; error = ''; render();
    try { U().calendar.forget(); await run(true); } catch (e) { error = e.message || String(e); }
    busy = false; render();
  }

  function mount() {
    if (unmount || !U().user.is(PEOPLE())) return;
    U().ui.nativeStyles();
    if (!document.getElementById('upc-patient-forms-css')) { const st = document.createElement('style'); st.id = 'upc-patient-forms-css'; st.textContent = CSS; document.head.appendChild(st); }
    root = document.createElement('div');
    root.className = 'upc-native upc-pf';
    root.setAttribute('data-upc-patient-forms', '');
    root.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      if (b.dataset.a === 'refresh') check();
      if (b.dataset.a === 'skip') { b.disabled = true; try { await shared().write({ ['a.' + b.dataset.id]: 'skip' }); } catch (x) { error = x.message || String(x); } render(); }
    });
    unmount = U().ui.mountPage('Patient forms', root, MENU_CLS);
    render();
    const last = store().get('last', null);
    if (!last || Date.now() - last.at > 15 * MIN) check();
    else shared().read(60e3).then(render).catch(() => {});
  }
  function leave() { if (!unmount) return; unmount(); unmount = null; root = null; }
  const route = () => (location.hash === '#' + ROUTE ? mount() : leave());

  function start() {
    if (!U() || !U().shared || !U().calendar) { console.error('[UPC patient forms] needs the core library'); return; }
    document.addEventListener('visibilitychange', background);
    setTimeout(background, 20000);
    setInterval(background, 60e3);
    U().user.whenAllowed(PEOPLE(), () => {
      U().ui.ensureMenuItem('Patient forms', (section) => {
        const list = section && [...section.querySelectorAll('a.mainmenu-sublink')].find((a) => /^patient list$/i.test(clean(a.textContent)));
        return (list ? list.getAttribute('href').split('#')[0] : U().base() + '/patient/') + '#' + ROUTE;
      }, MENU_CLS, /^patients?$/i);
      window.addEventListener('hashchange', route);
      route();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  window.upcPatientForms = { version: VERSION, run, fill, apptText, choose, sentFor, sendTime, chaseTime };
})();
