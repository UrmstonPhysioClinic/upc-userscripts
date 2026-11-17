"""
Test for Patient forms, against a mock Halaxy with invented patients (pop-ups and lists as captured live, 17 Nov 2026).
The clock is set to 14:00 on Tuesday 17-Nov-2026 (UK); forms are due at 05:00 the day before, reminders at 18:00.

Checks:
 - late bookings get the right form through Send Patient form, sent now: Initial Assessment Form - Bupa for a Bupa IA
   fee, Standard for a self-funded IA, the Follow-up Form for the last funded FU (10th of 10), with the treating
   practitioner as Sender, their first name and the appointment written in, and Halaxy's own tags left;
 - a form a campaign already sent isn't sent again; no fee yet waits; other fees get none; cancelled appointments
   are left out;
 - a reminder is scheduled for 18:00 with "Reminder: " and the original link for an unfilled form; none for a form
   already filled in; it is cancelled when the form is filled in before it goes;
 - a template with a practitioner tag the script can't fill isn't sent;
 - the shared note records each appointment once; a second run sends nothing more;
 - Patients > Patient forms lists today and tomorrow with each form's state.

Run:  python3 tests/patient-forms/test_patient_forms.py
"""
import asyncio, datetime, json, re, sys, urllib.parse
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
CORE = (ROOT / 'beta' / 'core.user.js').read_text().replace('perMinute: 45,', 'perMinute: 100000,')
HELD = (ROOT / 'beta' / 'patient-forms.user.js').read_text()
SCRIPT = HELD.replace('const HOLD = true;', 'const HOLD = false;')   # sending is held on beta; tested both ways
NOW = datetime.datetime(2026, 11, 17, 14, 0, tzinfo=datetime.timezone.utc)   # Tuesday; UK is UTC in November
FAILS = []
S = {}


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)[:700]))
    if not ok:
        FAILS.append(name)


def ts(days, hour, minute=0):
    return int((NOW + datetime.timedelta(days=days)).replace(hour=hour, minute=minute).timestamp())


def setup():
    S.clear()
    S.update({'log': [], 'posts': [], 'notes': {}, 'history': {}, 'scheduled': {}, 'cancelled': [], 'templates': {}})
    ev = lambda i, pid, name, start, prac, inv='', status='': {'id': i, 'type': 'appointment', 'linkPaGId': pid, 'title': '<b>Physio - %s (07000 000000)</b>' % name,
                                                              'appointmentStatus': status, 'practitionerID': prac, 'invoiceID': inv, 'start': start, 'end': start + 2700}
    S['events'] = [
        ev(9001, 501, 'Patient One', ts(1, 10), 11, 7001),            # Bupa IA, booked late: Initial Assessment Form - Bupa
        ev(9002, 502, 'Patient Two', ts(1, 11), 12, 7002),            # FU, 10th of 10: Follow-up Form
        ev(9003, 503, 'Patient Three', ts(1, 12), 11, 7003),          # FU: campaign sent the Progress Update at 05:04, unfilled
        ev(9004, 504, 'Patient Four', ts(1, 13), 11),                 # no fee yet (2a booking)
        ev(9005, 505, 'Patient Five', ts(0, 16), 12, 7005),           # self-funded IA today
        ev(9006, 506, 'Patient Six', ts(1, 14), 11, 7006, 'cancelled'),
        ev(9007, 507, 'Patient Seven', ts(1, 15), 12, 7007),          # an MOT fee: no form
        ev(9008, 508, 'Patient Eight', ts(1, 16), 12, 7008),          # FU: campaign form already filled in
    ]
    S['invoices'] = {7001: ('Bup-IA (AA360)', ''), 7002: ('AXA-FU', '(10th of 10 appts)'), 7003: ('Bup-FU', '(3rd of 10 appts)'), 7005: ('IA-IA', ''),
                     7006: ('IA-IA', ''), 7007: ('MOT-1', ''), 7008: ('FU-FU', '')}
    S['history'] = {503: [('Progress Update', '17-Nov-2026 05:04', 'No', 'https://eu.halaxy.com/a/online/form/503/AbCdEfGhIjKlMnOpQrStUvWx')],
                    508: [('Progress Update', '17-Nov-2026 05:06', '17-Nov-2026 07:40', '')],
                    501: [('Initial Assessment Form - Standard', '05-Oct-2022 14:02', '05-Oct-2022 14:06', '')]}
    S['templates'] = {
        3752: ('Before your appointment', '<p>Hi <span class="dynamicterm">[Patient First Name]</span>,</p><p style="margin:0;">With me on <strong><span class="dynamicterm">[Appointment Day / Date / Time]</span></strong>.</p>'
                                          '<table bgcolor="#f8f4fd"><tbody><tr><td style="padding:16px;"><span class="dynamicterm">[Online Form Link]</span></td></tr></tbody></table><p><span class="dynamicterm">[Practitioner First Name]</span></p>'),
        26152: ('Your progress update', '<p>Hi <span class="dynamicterm">[Patient First Name]</span>, before <span class="dynamicterm">[Appointment Day / Date / Time]</span>: <span class="dynamicterm">[Online Form Link]</span> <span class="dynamicterm">[Practitioner First Name]</span></p>'),
        13912: ('Your follow-up form', '<p>Hi <span class="dynamicterm">[Patient First Name]</span>, before <span class="dynamicterm">[Appointment Day / Date / Time]</span>: <span class="dynamicterm">[Online Form Link]</span> <span class="dynamicterm">[Practitioner First Name]</span></p>'),
    }


FORMS = [(101252, 'Card Details'), (13562, 'Follow-up Form'), (101922, 'Initial Assessment Form - Aviva'), (4032, 'Initial Assessment Form - AXA Health'),
         (3772, 'Initial Assessment Form - Bupa'), (2542, 'Initial Assessment Form - Standard'), (22352, 'Progress Update')]
TEMPLATES = [(3752, 'Form - Initial Assessment'), (26152, 'Form - Progress Update'), (13912, 'Form - Follow-up Form'), (93132, 'Chase - Excess Due')]
SENDERS = [(313949, 'Carl Healy'), (481952, 'Steve Physio')]


def sel(name, opts, selected=''):
    return "<select name='%s'><option value=''>Select</option>%s</select>" % (name, ''.join("<option value='%s'%s>%s</option>" % (v, ' selected' if str(v) == str(selected) else '', t) for v, t in opts))


def compose(pid, patient_form):
    hours = ''.join("<option value='%d'>%02d</option>" % (h, h) for h in range(24))
    mins = ''.join("<option value='%d'>%02d</option>" % (m, m) for m in range(60))
    hist = ''
    if patient_form:
        # As live (17 Nov 2026): divs, not a table.
        rows = ''.join('<div class="row p-2 div-table-row"> <div class="col-3"> %s </div> <div class="col-3"> %s via email </div> <div class="col-3"> %s </div> <div class="col-3">01-Dec-2026 12:59</div> </div>'
                       % (f if done == 'No' else '<a class="ajax" href="/a/pr/555/setting/patient/intake/1">%s</a>' % f, sent, ('No (<a href="%s" target="_blank">Access unique link</a>)' % link if link else 'No') if done == 'No' else done)
                       for f, sent, done, link in S['history'].get(pid, []))
        hist = ('<div class="card mb-2" id="card-prac-group-patient-form-invite-history"><div class="card-header"><h2>History</h2></div><div id="card-invite-history" class="collapse"><div class="card-body p-0">'
                '<div class="col-12 div-table"><div class="row p-2 div-table-row-header font-weight-bold"><div class="col-3">Form</div><div class="col-3">Sent</div><div class="col-3">Completed</div><div class="col-3">Expiry</div></div>'
                '<div class="div-table-body">%s</div></div></div></div></div>') % rows
        if S.get('odd_history') and pid in S['odd_history']:
            hist += '<ul><li>Progress Update, 17-Nov-2026 05:04 via email</li></ul>'

    top = (sel('form[intakeForm]', FORMS) + "<input name='form[expiry]' value='01-Dec-2026'>" + sel('form[link_pr_g]', SENDERS, 313949)) if patient_form else ''
    return ("<form id='composeEmailForm' method='post'>%s<input name='form[fromName]' value='Urmston Physio Clinic'>%s<textarea name='form[subject]'></textarea>"
            "<select name='form[recipientType]'><option value='LinkPaG' selected>Patient</option></select><select name='form[toLinkPaGPaG]'><option value=''>Please select one</option></select>"
            "<input name='form[toEmail]' value='%s'><input name='form[ccEmail]' value=''><input name='form[bccEmail]' value='copies@example.com'>%s"
            "<textarea name='form[body]'></textarea><input type='hidden' name='form[_token]' value='tok'>"
            "<input name='form[scheduleDetails][scheduleDate]' value=''><select name='form[scheduleDetails][scheduleTime][hour]'>%s</select>"
            "<select name='form[scheduleDetails][scheduleTime][minute]'>%s</select></form>%s") % (
        top, sel('form[fromEmail]', [('admin@urmstonphysioclinic.com', 'admin')], 'admin@urmstonphysioclinic.com'), 'p%d@example.com' % pid, sel('form[template]', TEMPLATES), hours, mins, hist)


def invoice_html(iid):
    item, ref = S['invoices'][iid]
    return ("<html><head><title>Invoice UPC-%d | Halaxy</title></head><body><div id='pageContent'><table id='invoiceLines'><tbody>"
            "<tr><td data-property='date'><a href='/a/pr/555/appointment/1'>18-Nov-2026 10:00</a></td><td data-property='itemNumber'>%s</td><td data-property='description'>Fee</td>"
            "<td data-property='amount'>£ 60.00</td><td><a href='/a/pr/555/invoice/line/8%d/edit'>e</a></td></tr></tbody></table>"
            "<span data-referral>%s</span><table id='invoicePayments'><tbody></tbody></table></div></body></html>") % (iid, item, iid, ref)


def page_html(body=''):
    return ("<!doctype html><html><head><title>Patients | Halaxy</title></head><body style='margin:0 0 0 230px'>"
            "<div style='position:fixed;left:0;top:0;bottom:0;width:218px'><nav id='side'><ul id='mainMenu'>"
            "<li class='mainmenu-item active'><a class='mainmenu-link'><span class='mainmenu-link-label'>Patients</span></a>"
            "<ul><li class='active'><a class='mainmenu-sublink active' href='/a/pr/555/patient/'>Patient List</a></li></ul></li></ul></nav></div>"
            "<div id='headerWrapper' style='height:50px'></div><div id='toolbar-wrapper'></div><div id='pageContent'><h1>Patient</h1>%s</div>"
            "<script>window.HkUser = { linkPrG: 11, pracID: 11, pracName: 'Carl Healy' }; window.Hk = { jwt: 'jwt' };</script></body></html>") % body


async def halaxy(route):
    req = route.request
    u = urllib.parse.urlparse(req.url)
    p = u.path
    S['log'].append((req.method, re.sub(r'^/a/pr/555', '', p)))
    js = lambda o: route.fulfill(body=json.dumps(o), content_type='application/json')
    form = dict(urllib.parse.parse_qsl(req.post_data or '', keep_blank_values=True)) if req.method == 'POST' else {}
    if p.endswith('/lookup/practitioner'):
        return await js([{'id': 11, 'name': 'Carl Healy'}, {'id': 12, 'name': 'Steve Physio'}])
    if p.endswith('/calendar/json'):
        q = urllib.parse.parse_qs(u.query)
        lo, hi = int(q['start'][0]), int(q['end'][0])
        return await js({'payload': {'events': [e for e in S['events'] if lo <= e['start'] < hi]}})
    if p.endswith('/funder/fee/data'):
        return await js([{'feeNumber': 'Bup-IA (AA360)', 'funder': 'Bupa'}, {'feeNumber': 'IA-IA', 'funder': 'Self-funded'}, {'feeNumber': 'AXA-FU', 'funder': 'AXA Health'}])
    m = re.match(r'^/a/pr/555/invoice/(\d+)$', p)
    if m:
        return await route.fulfill(body=invoice_html(int(m.group(1))), content_type='text/html')
    m = re.match(r'^/a/pr/555/communication/template/list/(\d+)$', p)
    if m:
        subj, body = S['templates'][int(m.group(1))]
        return await route.fulfill(body=page_html("<form id='editCommunicationTemplateForm'><input name='form[title]' value='x'><textarea name='form[subject]'>%s</textarea>"
                                                  "<textarea name='form[contentForFormHandler]'>%s</textarea></form>" % (subj, body.replace('&', '&amp;').replace('<', '&lt;'))), content_type='text/html')
    m = re.match(r'^/a/pr/555/email/(patient-form|compose)/patient/(\d+)(/patientForm)?$', p)
    if m:
        pid, pf = int(m.group(2)), m.group(1) == 'patient-form'
        if req.method == 'GET':
            return await js({'status': 'FORM', 'title': 'Send Patient form' if pf else 'Send Email', 'message': compose(pid, pf)})
        S['posts'].append((('form' if pf else 'email'), pid, form))
        when = form.get('form[scheduleDetails][scheduleDate]', '')
        if when:
            at = '%s %02d:%02d' % (when, int(form['form[scheduleDetails][scheduleTime][hour]']), int(form['form[scheduleDetails][scheduleTime][minute]']))
            S['scheduled'].setdefault(pid, []).append({'entityId': 70000 + len(S['posts']), 'sentDateLocal': at, 'subject': form['form[subject]'], 'emailStatus': 'Scheduled',
                                                       'emailCancelUrl': '/a/pr/555/email/cancel/%d' % (70000 + len(S['posts']))})
        elif pf and not S.get('hide_new'):
            name = next(t for v, t in FORMS if str(v) == form['form[intakeForm]'])
            S['history'].setdefault(pid, []).append((name, '17-Nov-2026 14:00', 'No', 'https://eu.halaxy.com/a/online/form/%d/NewLinkNewLinkNewLinkNewLink' % pid))
        return await js({'status': 'REFRESH'})
    m = re.match(r'^/a/pr/555/email/cancel/(\d+)$', p)
    if m:
        S['cancelled'].append(int(m.group(1)))
        for lst in S['scheduled'].values():
            lst[:] = [x for x in lst if x['entityId'] != int(m.group(1))]
        return await route.fulfill(body='<div>ok</div>', content_type='text/html')
    if p == '/api/v2/practitioner/messaging/history/scheduled/emails':
        q = urllib.parse.parse_qs(u.query)
        pid = int(q['linkPaG'][0])
        return await js({'_metadata': {'totalCount': 0}, 'data': {'linkPaGId': pid, 'emailMessages': S['scheduled'].get(pid, [])}})
    notes = S['notes']
    m = re.match(r'^/a/pr/555/communication-log/organisation/(\d+)/list-data$', p)
    if m:
        return await js({'data': [{'id': n['id'], 'date': '2026-11-17 10:00:00', 'privacy': 'All', 'creator': 'Carl Healy', 'isImportant': False, 'content': '\n<p class="font-weight-bold">Log Notes</p>\n' + n['html'] + '\n<div class="form-row mt-4">\n    </div>\n'}
                                  for n in reversed(notes.get(int(m.group(1)), []))]})
    m = re.match(r'^/a/pr/555/communication-log/organisation/(\d+)/(new|(\d+)/edit)$', p)
    if m:
        org = int(m.group(1))
        if req.method == 'GET':
            old = next((n for n in notes.get(org, []) if str(n['id']) == m.group(3)), None)
            return await js({'status': 'FORM', 'message': "<form id='adminNoteForm'><input type='hidden' name='form[_token]' value='tn'><select name='form[privacy]'><option value='3' selected>All</option></select><textarea name='form[logContent]'>%s</textarea></form>" % (old['html'] if old else '')})
        html = form['form[logContent]']
        if m.group(3):
            next(n for n in notes[org] if str(n['id']) == m.group(3))['html'] = html
        else:
            notes.setdefault(org, []).append({'id': 33000 + sum(len(v) for v in notes.values()), 'html': html})
        return await js({'status': 'CLOSE', 'url': '/a/pr/555/communication-log'})
    if p.startswith('/a/pr/555/'):
        return await route.fulfill(body=page_html(), content_type='text/html')
    await route.fulfill(status=404, body='not mocked')


def note_values():
    ns = S['notes'].get(78842, [])
    out = {}
    for n in ns:
        if 'Patient forms' not in n['html']:
            continue
        for line in re.split(r'</p>', n['html']):
            t = re.sub(r'<[^>]+>', '', line).replace('&amp;', '&').strip()
            f = t.split(' | ')
            if len(f) >= 3:
                out[f[0]] = f[2]
    return out


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        setup()
        ctx = await browser.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/London')
        await ctx.clock.install(time=NOW.isoformat())
        await ctx.route('https://eu.halaxy.com/**', halaxy)
        await ctx.add_init_script(CORE)
        await ctx.add_init_script("document.addEventListener('DOMContentLoaded', function () {\n" + SCRIPT + "\n});")
        pg = await ctx.new_page()
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/')
        await pg.wait_for_timeout(300)

        # Halaxy's own wording for the appointment
        check('appointment written as Halaxy does', await pg.evaluate("window.upcPatientForms.apptText(new Date(2026, 10, 18, 10, 0).getTime())") == 'Wednesday 18-Nov-2026 10:00')

        for _ in range(4):
            await pg.evaluate("window.upcPatientForms.run(true)")
        sent = {pid: f for kind, pid, f in S['posts'] if kind == 'form'}
        name = lambda f: next((t for v, t in FORMS if str(v) == f.get('form[intakeForm]')), None)
        check('Bupa IA booked late: Initial Assessment Form - Bupa, sent now', 501 in sent and name(sent[501]) == 'Initial Assessment Form - Bupa' and sent[501]['form[scheduleDetails][scheduleDate]'] == '', sent.get(501))
        check('self-funded IA today: Initial Assessment Form - Standard', 505 in sent and name(sent[505]) == 'Initial Assessment Form - Standard', sent.get(505))
        check('last funded FU (10th of 10): Follow-up Form, not Progress Update', 502 in sent and name(sent[502]) == 'Follow-up Form', sent.get(502))
        f = sent.get(501, {})
        check('Sender: the treating practitioner', f.get('form[link_pr_g]') == '313949' and sent.get(502, {}).get('form[link_pr_g]') == '481952', (f.get('form[link_pr_g]'), sent.get(502, {}).get('form[link_pr_g]')))
        body = f.get('form[body]', '')
        check('the practitioner\'s first name and the appointment written in; Halaxy\'s tags left; styling kept',
              'Wednesday 18-Nov-2026 10:00' in body and '<p>Carl</p>' in body.replace('<span class="dynamicterm">', '').replace('</span>', '') and '[Patient First Name]' in body and '[Online Form Link]' in body
              and '[Practitioner First Name]' not in body and 'bgcolor="#f8f4fd"' in body and '<td style="padding:16px;">' in body, body[:400])
        check('Steve\'s patient: Steve\'s name', 'Steve' in sent.get(502, {}).get('form[body]', ''), sent.get(502, {}).get('form[body]', '')[:200])
        check('subject from the template; no template chosen in the pop-up', f.get('form[subject]') == 'Before your appointment' and f.get('form[template]') == '', (f.get('form[subject]'), f.get('form[template]')))
        check('not sent: campaign form already gone, no fee yet, MOT fee, cancelled', not any(x in sent for x in (503, 504, 506, 507, 508)), sorted(sent))
        v = note_values()
        check('shared note: what happened to each', v.get('a.9001', '').startswith('sent ') and v.get('a.9003', '').startswith('had ') and v.get('a.9004', '').startswith('wait ')
              and v.get('a.9007') == 'none' and 'a.9006' not in v, v)

        # Reminders at 18:00 today for tomorrow's unfilled forms, with the original link
        emails = [(pid, f) for kind, pid, f in S['posts'] if kind == 'email']
        r = dict(emails)
        check('reminder for the campaign form: 18:00 today, "Reminder: ", original link', 503 in r and r[503]['form[scheduleDetails][scheduleDate]'] == '17-Nov-2026'
              and r[503]['form[scheduleDetails][scheduleTime][hour]'] == '18' and r[503]['form[subject]'] == 'Reminder: Your progress update'
              and 'https://eu.halaxy.com/a/online/form/503/AbCdEfGhIjKlMnOpQrStUvWx' in r[503]['form[body]'] and 'Wednesday 18-Nov-2026 12:00' in r[503]['form[body]'], r.get(503))
        check('no reminder for a form already filled in, or one sent after midday', 508 not in r and 501 not in r and 502 not in r, sorted(r))
        check('shared note: reminders', v.get('r.9003', '').startswith('sched ') and v.get('r.9008') == 'done' and v.get('r.9001') == 'late', v)

        # A second run sends nothing more
        before = len(S['posts'])
        await pg.evaluate("window.upcPatientForms.run(true)")
        check('second run: nothing sent twice', len(S['posts']) == before, S['posts'][before:])

        # Filled in before 18:00: the reminder is cancelled (checked in the 90 minutes before it goes)
        S['history'][503] = [('Progress Update', '17-Nov-2026 05:04', '17-Nov-2026 16:40', '')]
        await ctx.clock.set_system_time((NOW + datetime.timedelta(hours=3)).isoformat())
        await pg.evaluate("window.upcPatientForms.run(true)")
        check('filled in before it went: reminder cancelled', S['cancelled'] and not S['scheduled'].get(503) and note_values().get('r.9003') == 'done', (S['cancelled'], note_values().get('r.9003')))

        # Patients > Patient forms
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/#upc-patient-forms')
        await pg.wait_for_selector('[data-upc-patient-forms] table', timeout=20000)
        await pg.wait_for_function("!document.querySelector('[data-upc-patient-forms] [data-a=refresh]').disabled", timeout=30000)
        rows = await pg.evaluate("[...document.querySelectorAll('[data-upc-patient-forms] .card')].map((c) => [c.querySelector('h2').textContent, [...c.querySelectorAll('tbody tr')].map((tr) => [...tr.cells].map((x) => x.textContent.trim()))])")
        tom = dict((r[1], r) for r in (rows[1][1] if len(rows) > 1 else []))
        check('page: tomorrow listed with each form\'s state', len(rows) == 2 and rows[1][0].startswith('Tomorrow') and 'Patient Six' not in tom
              and tom.get('Patient One', [''] * 5)[3].startswith('Sent') and 'Initial Assessment Form - Bupa' in tom.get('Patient One', [''] * 5)[3]
              and tom.get('Patient Four', [''] * 5)[3] == 'Waiting for a fee' and tom.get('Patient Seven', [''] * 5)[3] == 'No form for this fee'
              and tom.get('Patient Three', [''] * 5)[4] == 'Filled in' and tom.get('Patient One', [''] * 5)[2] == 'Carl Healy', rows)
        check('page: "Don\'t send" only where nothing has gone', await pg.evaluate("[...document.querySelectorAll('[data-upc-patient-forms] [data-a=skip]')].length") == 1, rows)
        check('no page errors', not errors, errors)
        await ctx.close()

        # A template with a practitioner tag the script can't fill: not sent
        setup()
        S['events'] = [e for e in S['events'] if e['id'] == 9005]
        S['templates'][3752] = ('Before your appointment', '<p>[Practitioner Title] [Online Form Link]</p>')
        ctx = await browser.new_context(timezone_id='Europe/London')
        await ctx.clock.install(time=NOW.isoformat())
        await ctx.route('https://eu.halaxy.com/**', halaxy)
        await ctx.add_init_script(CORE)
        await ctx.add_init_script("document.addEventListener('DOMContentLoaded', function () {\n" + SCRIPT + "\n});")
        pg = await ctx.new_page()
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/')
        await pg.wait_for_timeout(300)
        await pg.evaluate("window.upcPatientForms.run(true)")
        check('template with [Practitioner Title]: not sent, recorded to try again', not [x for x in S['posts'] if x[0] == 'form'] and note_values().get('a.9005', '').startswith('fail '), (S['posts'], note_values()))
        await ctx.close()

        async def only(ids, script=SCRIPT, path='/a/pr/555/patient/'):
            ctx = await browser.new_context(timezone_id='Europe/London')
            await ctx.clock.install(time=NOW.isoformat())
            await ctx.route('https://eu.halaxy.com/**', halaxy)
            await ctx.add_init_script(CORE)
            await ctx.add_init_script("document.addEventListener('DOMContentLoaded', function () {\n" + script + "\n});")
            pg = await ctx.new_page()
            await pg.goto('https://eu.halaxy.com' + path)
            await pg.wait_for_timeout(300)
            return ctx, pg

        # A sent form the script can't read in the history: nothing sent
        setup()
        S['events'] = [e for e in S['events'] if e['id'] in (9003, 9005)]
        S['odd_history'] = {505}
        ctx, pg = await only(None)
        await pg.evaluate("window.upcPatientForms.run(true)")
        check('a history entry it can\'t read: nothing sent', not [x for x in S['posts'] if x[0] == 'form'] and note_values().get('a.9005', '').startswith('fail '), (S['posts'], note_values()))
        await ctx.close()

        # Halaxy accepts the form but it doesn't show in the history: recorded, never sent again
        setup()
        S['events'] = [e for e in S['events'] if e['id'] == 9005]
        S['hide_new'] = True
        ctx, pg = await only(None)
        await pg.evaluate("window.upcPatientForms.run(true)")
        await ctx.clock.set_system_time((NOW + datetime.timedelta(minutes=90)).isoformat())
        await pg.evaluate("window.upcPatientForms.run(true)")
        n = len([x for x in S['posts'] if x[0] == 'form'])
        check('accepted but not in the history: sent once, not again', n == 1 and note_values().get('a.9005', '').startswith('check '), (n, note_values()))
        await ctx.close()

        # Held (as on beta): Check now shows what would happen and sends nothing
        setup()
        ctx, pg = await only(None, HELD, '/a/pr/555/patient/#upc-patient-forms')
        await pg.wait_for_selector('[data-upc-patient-forms] table', timeout=20000)
        await pg.wait_for_function("!document.querySelector('[data-upc-patient-forms] [data-a=refresh]').disabled", timeout=60000)
        rows = await pg.evaluate("[...document.querySelectorAll('[data-upc-patient-forms] tbody tr')].map((tr) => [...tr.cells].map((x) => x.textContent.trim()))")
        r = dict((x[1], x) for x in rows)
        await pg.evaluate("window.upcPatientForms.run(false)")
        check('held: nothing sent or scheduled, even by the background run', not S['posts'], S['posts'])
        check('held: the page says what would happen', r.get('Patient One', [''] * 5)[3] == 'Would send: Initial Assessment Form - Bupa' and r.get('Patient Three', [''] * 5)[3].startswith('Sent 17-Nov-2026 05:04')
              and r.get('Patient Three', [''] * 5)[4] == 'Would remind at 18:00' and r.get('Patient Eight', [''] * 5)[4] == 'Filled in'
              and await pg.evaluate("!!document.querySelector('[data-upc-patient-forms] .alert-warning')"), rows)
        await ctx.close()
        await browser.close()
    print('\n' + ('All passed' if not FAILS else '%d failed' % len(FAILS)))
    sys.exit(1 if FAILS else 0)


asyncio.run(main())
