// ==UserScript==
// @name         UPC Patients: Patient forms (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.1.11
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
 * Patient forms (CH, 17 Nov 2026). Forms go out at 05:00 the day before an appointment, through Halaxy's own Send
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
 *  Reminders (CH: "include the original form link, so they don't lose their progress"): at 18:00 the day before, the
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

  const VERSION = '0.1.11';
  // Sending and reminders held (0.1.1): 0.1.0 read the form history as a table, but Halaxy lays it out in divs (live,
  // 17 Nov 2026), so it saw no forms and sent Progress Updates the campaign had already sent. 0.1.2 reads the divs and
  // stops if any sent form can't be read. While held, Check now works out what would happen (reads only).
  const HOLD = false;   // lifted 17 Nov 2026 (CH) after the held preview matched the live history
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
  // How long a recorded outcome waits before it is tried again: no fee yet 30 minutes, a temporary failure 15,
  // anything else (a failure, no email address) an hour.
  const retryAfter = (v) => (v.startsWith('wait') ? 30 : /^fail \d+ \d+ t\b/.test(v) ? 15 : 60) * MIN;
  const report = (msg) => { try { document.dispatchEvent(new CustomEvent('upc-loader-error', { detail: JSON.stringify({ file: 'patient-forms.user.js', message: String(msg) }) })); } catch (e) { /* ignore */ } };
  // Takes back this script's earlier errors that start with `prefix` once that try has worked (health check 1.1.64).
  const resolved = (prefix) => { try { document.dispatchEvent(new CustomEvent('upc-loader-error-clear', { detail: JSON.stringify({ file: 'patient-forms.user.js', prefix: String(prefix) }) })); } catch (e) { /* ignore */ } };

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
    cache = { at: Date.now(), pracs: new Map((Array.isArray(pracs) ? pracs : []).map((p) => [String(p.id), clean(p.name)])), fees: Array.isArray(fees) ? fees : [] };
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
    // History card (live, 17 Nov 2026): #card-prac-group-patient-form-invite-history, rows div.div-table-row of four div.col-3
    // (form, "17-Nov-2026 16:59 via email", completed date or "No (Access unique link)", expiry). Every sent form
    // must be read: if any "via email" isn't, stop rather than send again.
    const rowsOf = (el) => [...el.querySelectorAll('.div-table-row, tr')].filter((r) => /via (email|sms)/i.test(r.textContent) && !r.querySelector('.div-table-row, tr'));
    const history = rowsOf(doc).map((r) => {
      const c = [...r.children].filter((x) => /^(DIV|TD)$/.test(x.tagName));
      const link = r.querySelector('a[href*="/online/form/"]');
      return { form: clean(c[0] && c[0].textContent), sent: parseWhen(c[1] && c[1].textContent), completed: parseWhen(c[2] && c[2].textContent), link: link ? link.getAttribute('href') : '' };
    });
    const seen = (doc.body.textContent.match(/via (email|sms)/gi) || []).length;
    if (history.length !== seen || history.some((h) => !h.form || !h.sent)) throw new (U().Error)('The Send Patient form history has changed, so forms already sent can\'t be seen. Nothing was sent.');
    return { path, form, forms: options('form[intakeForm]'), senders: options('form[link_pr_g]'), templates: options('form[template]'), to: clean((form.querySelector('[name="form[toEmail]"]') || {}).value), history };
  }

  // A communication template as saved, with its tags unfilled: { subject, body }.
  // Core reads it (one retry, then the last good copy on this PC for a day; 25 Nov 2026). A copy used because the
  // page really changed is reported, so it gets fixed, but the form or reminder still goes.
  // ctx { patient, prac }: with it, a login that can't open Settings pages still gets the template (26 Nov 2026).
  // Read that way, Halaxy has already filled the patient's name, the Sender's name and the appointment tag (with the
  // patient's next appointment, as when the pop-up is used by hand; blank when none: capture 26 Nov 2026), leaving
  // [Action] and [Online Form Link]. So it is used only when this appointment's date is in it.
  async function template(id, ctx, a) {
    const t = await U().templates.get(id, ctx);
    if (t.rendered && a) {
      const txt = clean(U().htmlDoc(t.body).body.textContent);
      const d = new Date(a.start), mon = U().dayLabel(a.start).split('-')[1];
      if (!txt.includes(U().dayLabel(a.start)) && !new RegExp('\\b' + d.getDate() + '(st|nd|rd|th)?\\b[^0-9]{0,12}' + mon).test(txt)) {
        const e = new (U().Error)('This login can\'t open the template, and the wording Halaxy gave instead doesn\'t have this appointment\'s date.');
        e.noAccess = true;   // left to a login that can open it
        throw e;
      }
    }
    if (t.stale && !t.stale.temporary && !t.stale.noAccess) report('Communication template (using the copy read at ' + hhmm(t.at) + '): ' + t.stale.message);
    return t;
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
  async function sendOne(a, now, dry) {
    if (!a.invoiceId) return 'wait ' + now;   // no fee yet: nothing else is read
    const sf = await sendForm(a.patient);
    const had = sentFor(a, sf.history);
    if (had) return 'had ' + had.sent + ' ' + had.form;
    const c = await choose(a, sf);
    if (c.skip) return c.skip === 'wait' ? 'wait ' + now : 'none';
    const formId = pick(sf.forms, c.form), templateId = pick(sf.templates, c.template);
    if (!formId) throw new (U().Error)('"' + c.form + '" is not in the Send Patient form list.');
    if (!templateId) throw new (U().Error)('No "' + c.template + '" template in Halaxy\'s communication templates.');
    if (!sf.to) return 'noemail ' + now;   // looked at again in an hour (Missing details lists them)
    const pracName = (await lookups()).pracs.get(a.pracId) || '';
    const sender = pick(sf.senders, pracName);
    if (!pracName || !sender) throw new (U().Error)('The practitioner for ' + a.name + '\'s appointment isn\'t in the Sender list.');
    const t = await template(templateId, { patient: a.patient, prac: sender }, a);
    const due = sendTime(a.start);
    const later = due > now + 5 * MIN;
    const set = {
      'form[intakeForm]': formId, 'form[link_pr_g]': sender, 'form[template]': '',
      'form[subject]': fill(t.subject, a, pracName, false), 'form[body]': fill(t.body, a, pracName, true),
      'form[scheduleDetails][scheduleDate]': later ? U().dayLabel(due) : '',
      'form[scheduleDetails][scheduleTime][hour]': later ? String(new Date(due).getHours()) : '0',
      'form[scheduleDetails][scheduleTime][minute]': later ? String(new Date(due).getMinutes()) : '0',
    };
    if (dry) return 'would ' + c.form;
    const pairs = U().http.serialize(sf.form).map(([k, v]) => [k, k in set ? set[k] : v]);
    Object.keys(set).forEach((k) => { if (!pairs.some(([x]) => x === k)) pairs.push([k, set[k]]); });
    const res = await U().http.postForm(sf.path, pairs);
    if (!res || !['REFRESH', 'OK', 'POPUP'].includes(res.status)) U().http.expectRefresh(res, 'Sending ' + c.form);
    // Accepted by Halaxy: from here it is never sent again, even if it can't be seen afterwards.
    try {
      if (later) {
        const s = (await scheduledEmails(a.patient)).find((m) => m.at === due && m.subject === set['form[subject]']);
        if (s) return 'sched ' + due + ' ' + c.form;
      } else {
        const after = (await sendForm(a.patient)).history.find((h) => h.form === c.form && h.sent >= now - 10 * MIN);
        if (after) return 'sent ' + after.sent + ' ' + c.form;
      }
    } catch (e) { /* reported below */ }
    report(a.name + ': Halaxy accepted ' + c.form + ', but it can\'t be seen in Halaxy. Check their forms.');
    return 'check ' + now + ' ' + c.form;
  }

  // Schedules the reminder for one appointment's form; returns the outcome to record.
  async function remindOne(a, now, dry) {
    const sf = await sendForm(a.patient);
    const h = sentFor(a, sf.history);
    if (!h) return null;                       // nothing sent yet: try again later
    if (h.completed) return 'done';
    if (h.sent > chaseTime(a.start) - 6 * 3600e3) return 'late';     // sent after midday: a reminder that evening would only crowd it
    if (!h.link) return 'nolink';
    if (!sf.to) return 'noemail ' + now;   // no email address now (CH, 23 Nov 2026): looked at again in an hour
    const due = chaseTime(a.start);
    const pracName = (await lookups()).pracs.get(a.pracId) || '';
    const templateId = pick(sf.templates, TEMPLATE_FOR(h.form));
    if (!templateId || !pracName) return 'nolink';
    const t = await template(templateId, { patient: a.patient, prac: pick(sf.senders, pracName) || '' }, a);
    const link = /^https?:/.test(h.link) ? h.link : location.origin + h.link;
    const subject = 'Reminder: ' + fill(t.subject, a, pracName, false);
    const body = fill(t.body, a, pracName, true).replace(/(<span class="dynamicterm">)?\[Online Form Link\](<\/span>)?/g, '<a href="' + esc(link) + '" style="color:#7a33c7;">Open your form</a>');
    if (!/\/online\/form\//.test(body)) throw new (U().Error)('The "' + TEMPLATE_FOR(h.form) + '" template has no [Online Form Link], so the reminder would have no link.');
    if (dry) return 'would';
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
    const s = await scheduledEmails(a.patient).then((l) => l.find((m) => m.at === due && m.subject === subject)).catch(() => null);
    if (s) return 'sched ' + s.id + ' 0';
    report(a.name + ': Halaxy accepted the reminder, but it isn\'t in their scheduled emails. Check their emails.');
    return 'check ' + now;
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
  // retry (Check Now): try failed ones again at once, without waiting for their retry time.
  async function run(force, retry) {
    if (running) return running;
    running = (async () => {
      const now = Date.now();
      const mode = MODE();
      const sh = shared();
      const day0 = new Date(now); day0.setHours(0, 0, 0, 0);
      const list = await appointments(now, day0.getTime() + (mode === 'all' ? 3 : 2) * DAY);
      const recs = await sh.read(force ? 0 : 60e3);
      const val = (k) => (recs[k] && recs[k].value) || '';
      // A failed try is recorded as 'fail <when> <first failure> <t|x> <reason>'. A temporary one (Halaxy busy or
      // updating itself, 25 Nov 2026) is tried again after 15 minutes and reported once it has lasted 30 minutes (was
      // 2 hours: a late booking's form failed quietly for over an hour, 26 Nov 2026); anything else is reported at
      // once and tried again after an hour. The page shows the reason.
      const failed = (key, prefix, e) => {
        const prev = /^fail (\d+)(?: (\d+))?/.exec(val(key));
        const first = prev ? Number(prev[2] || prev[1]) : now;
        const temp = !!(e && e.temporary);
        const why = String((e && e.message) || e || '').replace(/[^A-Za-z0-9 _.:,-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);   // what a shared note line allows
        if (!temp || now - first >= 30 * MIN) report(prefix + ': ' + why);
        return 'fail ' + now + ' ' + first + (temp ? ' t ' : ' x ') + why;
      };
      const outcomes = {};
      let done = 0;

      // Held: what would happen, worked out by reading only, kept on this PC for the page.
      if (HOLD) {
        if (!force) return {};
        const preview = {};
        const forms = mode === 'off' ? [] : list.filter((a) => !/^(had|sent|sched|none|skip|check)/.test(val('a.' + a.id)) && (mode === 'all' || sendTime(a.start) <= now));
        for (const a of forms.slice(0, 40)) {
          try { preview['a.' + a.id] = await sendOne(a, now, true); } catch (e) { preview['a.' + a.id] = 'error ' + (e.message || e); }
        }
        const rem = CHASE() ? list.filter((a) => dayBefore(a.start) === day0.getTime() && !/^(sched|done|nolink|late|cancelled|check)/.test(val('r.' + a.id))) : [];
        for (const a of rem.slice(0, 40)) {
          try { preview['r.' + a.id] = (await remindOne(a, now, true)) || ''; } catch (e) { preview['r.' + a.id] = 'error ' + (e.message || e); }
        }
        store().set('preview', { at: now, values: preview });
        const pr = (await lookups().catch(() => null)) || { pracs: new Map() };
        store().set('last', { at: now, list: list.map((a) => ({ id: a.id, start: a.start, name: a.name, patient: a.patient, prac: pr.pracs.get(a.pracId) || '' })) });
        return preview;
      }

      // Forms: late bookings (the send time has passed), or every booking up to the day after tomorrow.
      let released = false;
      if (mode !== 'off' && !HOLD && !noAccess()) {
        const due = list.filter((a) => {
          const v = val('a.' + a.id);
          if (/^(had|sent|sched|none|skip|check)/.test(v)) return false;
          if (!retry && /^(wait|fail|noemail) (\d+)/.test(v) && now - Number(v.split(' ')[1]) < retryAfter(v)) return false;   // Check Now tries again at once
          return mode === 'all' || sendTime(a.start) <= now;
        });
        const mine = due.length ? await sh.claim(due.slice(0, PER_RUN).map((a) => 'a.' + a.id)) : [];
        for (const a of due.filter((x) => mine.includes('a.' + x.id))) {
          try { outcomes['a.' + a.id] = await sendOne(a, now); resolved(a.name + ': '); } catch (e) {
            if (e && e.noAccess) { setNoAccess(); released = true; break; }
            outcomes['a.' + a.id] = failed('a.' + a.id, a.name, e);
          }
          done += 1;
        }
      }

      // Reminders: tomorrow's appointments, before the reminder time.
      if (CHASE() && !HOLD) {
        const tomorrow = list.filter((a) => dayBefore(a.start) === day0.getTime() && now < chaseTime(a.start) - 5 * MIN);
        const toSchedule = noAccess() ? [] : tomorrow.filter((a) => {   // checking filled-in forms needs no template
          const v = val('r.' + a.id);
          if (/^(sched|done|nolink|late|cancelled|check)/.test(v)) return false;
          if (!retry && /^(fail|noemail) (\d+)/.test(v) && now - Number(v.split(' ')[1]) < retryAfter(v)) return false;
          return now >= sendTime(a.start) + 15 * MIN;   // the form has had time to go
        }).slice(0, Math.max(0, PER_RUN - done));
        const mineR = toSchedule.length ? await sh.claim(toSchedule.map((a) => 'r.' + a.id)) : [];
        for (const a of toSchedule.filter((x) => mineR.includes('r.' + x.id))) {
          try { const r = await remindOne(a, now); if (r) { outcomes['r.' + a.id] = r; resolved(a.name + ' (reminder): '); } } catch (e) {
            if (e && e.noAccess) { setNoAccess(); released = true; break; }
            outcomes['r.' + a.id] = failed('r.' + a.id, a.name + ' (reminder)', e);
          }
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

      if (Object.keys(outcomes).length || released) await sh.write(outcomes);   // writing also lets go of this PC's claims
      try { await refreshCopies(list); } catch (e) { /* tried again tomorrow */ }
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
    .upc-pf .card { margin-bottom: 24px; }
    .upc-pf .card-header h2 { margin: 0; }
    .upc-pf td.upc-pf-when { white-space: nowrap; }
  `;

  const previewOf = (k) => { const p = HOLD && store().get('preview', null); return (p && p.values && p.values[k]) || ''; };
  // The form's record; while held, what the history shows now in place of an empty, waiting or failed one.
  const formRec = (a, recs) => { const rec = (recs['a.' + a.id] || {}).value || ''; return (!rec || /^(fail|wait)/.test(rec)) && previewOf('a.' + a.id) || rec; };
  // A login that can't open the email templates (no Settings access, 26 Nov 2026), when Halaxy's filled-in wording
  // won't do either, leaves forms and reminders to a login that can: it claims none for an hour (kept per login on
  // this PC) and the page says so.
  const who = () => clean((window.HkUser && window.HkUser.pracName) || '');
  const noAccess = () => { const m = store().get('noAccess', {}) || {}; return Date.now() - (m[who()] || 0) < 3600e3; };
  const setNoAccess = () => { const m = store().get('noAccess', {}) || {}; m[who()] = Date.now(); store().set('noAccess', m); };
  // Once a day a login that can open the templates refreshes their clinic-wide copies (core UPC.templates), so the
  // other logins have them even when CH's login isn't used for a while (CH away two weeks in January, 26 Nov 2026).
  // Includes Open-ended recalls' template, which other logins may send by hand.
  const COPY_TEMPLATES = [IA_TEMPLATE, PU_TEMPLATE, FU_TEMPLATE, 'Recall - Open-ended'];
  async function refreshCopies(list) {
    if (HOLD || noAccess() || !list.length || !U().templates.publish) return;
    if (Date.now() - (store().get('copiesAt', 0) || 0) < 20 * 3600e3) return;
    store().set('copiesAt', Date.now());
    const sf = await sendForm(list[0].patient);
    for (const name of COPY_TEMPLATES) {
      const id = pick(sf.templates, name);
      if (!id) continue;
      try { await U().templates.get(id); } catch (e) { if (e && e.noAccess) { setNoAccess(); return; } }
    }
  }
  const failReason = (v) => { const m = /^fail \d+ \d+ [tx] (.+)$/.exec(v); return m ? ': ' + m[1] : ''; };
  function statusOf(a, recs) {
    const v = formRec(a, recs);
    const w = v.split(' ');
    const rest = w.slice(2).join(' ');
    if (/^had /.test(v)) return 'Sent ' + when(Number(w[1])) + (rest ? ': ' + rest : '');
    if (/^sent /.test(v)) return 'Sent ' + when(Number(w[1])) + (rest ? ': ' + rest : '');
    if (/^sched /.test(v)) return 'Scheduled for ' + when(Number(w[1])) + (rest ? ': ' + rest : '');
    if (/^check /.test(v)) return 'Check in Halaxy: ' + rest;
    if (/^would /.test(v)) return 'Would send: ' + v.slice(6);
    if (/^error /.test(v)) return v.slice(6);
    if (/^wait/.test(v)) return 'Waiting for a fee';
    if (v === 'none') return 'No form for this fee';
    if (v === 'skip') return 'Not sending';
    if (/^noemail/.test(v)) return 'No email address';
    if (/^fail/.test(v)) return 'Not sent yet' + failReason(v);
    const due = sendTime(a.start);
    return due > Date.now() ? 'Due ' + when(due) + (MODE() === 'late' ? ' (campaign)' : '') : '';
  }
  function reminderOf(a, recs) {
    const rec = (recs['r.' + a.id] || {}).value || '';
    const v = (!rec || /^fail/.test(rec)) && previewOf('r.' + a.id) || rec;
    if (/^sched /.test(v)) return 'Reminder ' + hhmm(chaseTime(a.start));
    if (v === 'done') return 'Filled in';
    if (v === 'cancelled') return 'Reminder cancelled';
    if (v === 'nolink') return 'No link to send';
    if (/^noemail/.test(v)) return 'No email address';
    if (v === 'late') return 'No reminder';
    if (/^check/.test(v)) return 'Check in Halaxy';
    if (v === 'would') return 'Would remind at ' + hhmm(chaseTime(a.start));
    if (/^error /.test(v)) return v.slice(6);
    if (/^fail/.test(v)) return 'Not sent yet' + failReason(v);
    return '';
  }

  function render() {
    if (!root) return;
    const last = store().get('last', null);
    const recs = shared().cached();
    let h = '' + U().ui.page.bar('Patient forms', '<button type="button" class="btn btn-outline-primary" data-a="refresh"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Checking...' : 'Check Now') + '</button>', (busy ? U().ui.run.inline('') : U().ui.page.checked(last && last.at)));
    if (error) h += '<div class="alert alert-danger upc-err">' + esc(error) + '</div>';
    if (HOLD) h += '<div class="alert alert-warning upc-warn">Sending is paused. Forms and reminders show what would happen.</div>';
    else if (noAccess()) h += '<div class="alert alert-warning upc-warn">This login can\'t open the email templates, so forms and reminders are sent by a login that can.</div>';
    if (last) {
      const day0 = new Date(); day0.setHours(0, 0, 0, 0);
      const groups = [['Today', day0.getTime()], ['Tomorrow', day0.getTime() + DAY]];
      groups.forEach(([title, d]) => {
        const rows = last.list.filter((a) => a.start >= d && a.start < d + DAY && a.start > Date.now() - 2 * 3600e3);
        h += '<div class="card"><div class="card-header"><h2>' + U().ui.titleCase(title) + ' (' + rows.length + ')</h2></div><div class="card-body p-0">' +
          (rows.length ? '<table class="table table-striped table-bordered w-100 m-0"><thead><tr><th>Appointment</th><th>Patient</th><th>Practitioner</th><th>Form</th><th>Reminder</th><th></th></tr></thead><tbody>' +
            rows.map((a) => {
              const v = formRec(a, recs);
              const canSkip = !/^(had|sent|sched|skip|none|check)/.test(v) && MODE() !== 'off';
              return '<tr><td class="upc-pf-when">' + esc(hhmm(a.start)) + '</td><td><a href="' + esc(U().base() + '/patient/' + a.patient) + '" target="_blank" rel="noopener">' + esc(a.name) + '</a></td>' +
                '<td>' + esc(a.prac || '') + '</td><td>' + esc(statusOf(a, recs)) + '</td><td>' + esc(reminderOf(a, recs)) + '</td>' +
                '<td>' + (canSkip ? '<button type="button" class="btn btn-sm btn-outline-primary-light" data-a="skip" data-id="' + esc(a.id) + '">Don\'t send</button>' : '') + '</td></tr>';
            }).join('') + '</tbody></table>' : '<p class="text-muted m-3">None.</p>') + '</div></div>';
      });
    }
    root.innerHTML = h;
    U().ui.list.enhance(root, { auto: true });
  }

  async function check() {
    busy = true; error = ''; render();
    try { U().calendar.forget(); await run(true, true); } catch (e) { error = e.message || String(e); }
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
