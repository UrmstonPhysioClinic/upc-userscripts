"""
Appointment reminders, against a mock Halaxy (invented appointments). Clock: 20:00 on Monday 23-Nov-2026 (UK).

Checks: a late booking (confirmation 30 minutes ago, reminder due 06:00 on Wednesday) has its reminder cancelled; an
older booking's reminder is left alone; an appointment with no reminder gets Halaxy's own one added at 06:00 two days
before (12-hour clock, Halaxy's subject, body and token kept); none added when that time has passed or there is no
email address; cancelled appointments ignored; a second run reads nothing again; a moved appointment is looked at
again; the outcomes shared with other PCs; the recent changes list; someone not listed: nothing.

Run:  python3 tests/appointment-reminders/test_appointment_reminders.py
"""
import asyncio, datetime, json, re, sys, urllib.parse
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
CORE = (ROOT / 'beta' / 'core.user.js').read_text().replace('perMinute: 45,', 'perMinute: 100000,')
SCRIPT = (ROOT / 'beta' / 'appointment-reminders.user.js').read_text()
NOW = datetime.datetime(2026, 11, 23, 20, 0, tzinfo=datetime.timezone.utc)
FAILS = []
S = {}


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)[:700]))
    if not ok:
        FAILS.append(name)


def ts(y, mo, d, h, mi=0):
    return int(datetime.datetime(y, mo, d, h, mi, tzinfo=datetime.timezone.utc).timestamp())


def ev(i, start, status=''):
    return {'id': i, 'type': 'appointment', 'start': start, 'end': start + 1800, 'linkPaGId': 500 + i, 'patientID': 600 + i, 'practitionerID': 11,
            'title': '<span class="name-text">Patient %d</span> (07700900%03d)' % (i, i), 'appointmentStatus': status, 'isGroupAppointment': False, 'isRequest': False}


def setup():
    S.clear()
    S.update({'posts': [], 'cancels': [], 'views': [], 'notes': {}, 'user': 'Carl Healy',
              'events': [ev(901, ts(2026, 11, 26, 10)), ev(902, ts(2026, 11, 26, 11)), ev(903, ts(2026, 11, 27, 9)), ev(904, ts(2026, 11, 24, 15)),
                         ev(905, ts(2026, 11, 26, 12), 'cancelled'), ev(906, ts(2026, 11, 27, 10))],
              # reminders pop-up rows per linkAPrPaG: [section, type, 'dd-Mon-yyyy at HH:MM', id, scheduled]
              'rem': {3901: [['reminders', 'Email', '25-Nov-2026 at 06:00', 4901, True], ['notifications', 'Email', '23-Nov-2026 at 19:30', 4801, False]],
                      3902: [['reminders', 'Email', '24-Nov-2026 at 06:00', 4902, True], ['notifications', 'Email', '10-Nov-2026 at 12:00', 4802, False]],
                      3903: [], 3904: [], 3906: []},
              'email': {3903: 'p903@example.com', 3906: ''}})
    S['rem'][3901][0][2] = '24-Nov-2026 at 06:00'


def view(lid):
    rows = S['rem'][lid]
    if not rows:
        return ("<div class='row'><div id='card-appointment-reminder-details'><div class='alert alert-warning'>No reminders have been setup for this appointment.</div>"
                "<table class='table'><tr><th>Reminders</th><th>Actions</th></tr><tr><td><div>Email</div></td><td><a href='/a/pr/555/appointment/reminder/%d/new/email'>Add Reminder</a></td></tr></table></div></div>") % lid
    h = "<div class='row'><div id='card-appointment-reminder-details'><table class='table'>"
    sec = None
    for s, t, at, rid, live in rows:
        if s != sec:
            sec = s
            h += "<tr><th>%s</th><th>Status</th><th></th><th>Actions</th></tr>" % ('Reminders' if s == 'reminders' else 'Notifications')
        h += ("<tr><td class='reminderType'><div>%s</div></td><td class='reminderStatusAndTime'><em>Send %s </em></td><td></td><td>"
              "<a class='btn ajax' href='/a/pr/555/patient/1/contact-history/email/%d'></a><a href='/a/pr/555/appointment/reminder/%d/edit'></a>"
              "<a href='/a/pr/555/appointment/reminder/%d/resend/email'></a>%s</td></tr>") % (t, at, rid, rid, rid, "<a class='ajax btn' href='/a/pr/555/appointment/reminder/%d/cancel'></a>" % rid if live else '')
    return h + '</table></div></div>'


def add_form(lid):
    return ("<form name='form' id='frmEditReminder'><input name='form[recipientName]' value='Patient'><input type='email' name='form[email]' value='%s'>"
            "<input name='dateToSend[date]' value=''><select name='dateToSend[hour]'>%s</select><select name='dateToSend[min]'>%s</select>"
            "<select name='dateToSend[isPM]'><option value='0'>AM</option><option value='1'>PM</option></select><input type='hidden' name='form[subtype]' value='reminder'>"
            "<textarea name='form[subject]'>Appointment Reminder ([Appointment Day / Date / Time])</textarea><textarea name='form[body]'>&lt;p&gt;Manage: [Appointment Link]&lt;/p&gt;</textarea>"
            "<input type='hidden' name='form[_token]' value='rt'></form>") % (S['email'][lid], ''.join("<option value='%d'>%d</option>" % (i, i) for i in range(1, 13)),
                                                                             ''.join("<option value='%d'>%02d</option>" % (i, i) for i in range(60)))


PAGE = ("<!doctype html><html><head><title>Calendar | Halaxy</title></head><body><div id='headerWrapper'></div><div id='pageContent'><h1>Calendar</h1></div>"
        "<script>window.HkUser = { linkPrG: 11, pracID: 11, pracName: %s }; window.Hk = { jwt: 'jwt' };</script></body></html>")


async def halaxy(route):
    req = route.request
    u = urllib.parse.urlparse(req.url)
    p = u.path
    js = lambda o: route.fulfill(body=json.dumps(o), content_type='application/json')
    form = dict(urllib.parse.parse_qsl(req.post_data or '', keep_blank_values=True)) if req.method == 'POST' else {}
    if p.endswith('/lookup/practitioner'):
        return await js([{'id': 11, 'name': 'Carl Healy'}])
    if p.endswith('/calendar/json'):
        q = urllib.parse.parse_qs(u.query)
        lo, hi = int(q['start'][0]), int(q['end'][0])
        return await js({'payload': {'events': [e for e in S['events'] if lo <= e['start'] < hi]}})
    m = re.match(r'^/a/pr/555/calendar/appointment/11/(\d+)$', p)
    if m:
        return await js({'status': 'VIEW', 'message': "<form id='pr-appointment'><a class='ajax btn icon' href='/a/pr/555/appointment/reminder/%d'></a></form>" % (3000 + int(m.group(1)))})
    m = re.match(r'^/a/pr/555/appointment/reminder/(\d+)$', p)
    if m:
        S['views'].append(int(m.group(1)))
        return await js({'status': 'VIEW', 'title': 'Appointment reminders: Patient', 'message': view(int(m.group(1)))})
    m = re.match(r'^/a/pr/555/appointment/reminder/(\d+)/cancel$', p)
    if m:
        rid = int(m.group(1))
        S['cancels'].append(rid)
        for rows in S['rem'].values():
            for r in rows:
                if r[3] == rid:
                    r[4] = False
        return await js({'status': 'CUSTOMPOPUPRETURN', 'title': 'This reminder is cancelled', 'message': 'You have successfully cancelled this reminder.'})
    m = re.match(r'^/a/pr/555/appointment/reminder/(\d+)/new/email$', p)
    if m:
        lid = int(m.group(1))
        if req.method == 'GET':
            return await js({'status': 'FORM', 'title': 'Add email reminder', 'message': add_form(lid)})
        S['posts'].append((lid, form))
        h = int(form['dateToSend[hour]']) % 12 + (12 if form['dateToSend[isPM]'] == '1' else 0)
        S['rem'][lid] = [['reminders', 'Email', '%s at %02d:%02d' % (form['dateToSend[date]'], h, int(form['dateToSend[min]'])), 4000 + lid, True]]
        return await js({'status': 'OK'})
    notes = S['notes']
    m = re.match(r'^/a/pr/555/communication-log/organisation/(\d+)/list-data$', p)
    if m:
        return await js({'data': [{'id': n['id'], 'date': '2026-11-23 10:00:00', 'privacy': 'All', 'creator': 'Carl Healy', 'isImportant': False, 'content': '\n<p class="font-weight-bold">Log Notes</p>\n' + n['html'] + '\n<div class="form-row mt-4">\n    </div>\n'}
                                  for n in reversed(notes.get(int(m.group(1)), []))]})
    m = re.match(r'^/a/pr/555/communication-log/organisation/(\d+)/(new|(\d+)/edit)$', p)
    if m:
        org = int(m.group(1))
        if req.method == 'GET':
            old = next((n for n in notes.get(org, []) if str(n['id']) == m.group(3)), None)
            return await js({'status': 'FORM', 'message': "<form id='adminNoteForm'><input type='hidden' name='form[_token]' value='tn'><select name='form[privacy]'><option value='3' selected>All</option></select><textarea name='form[logContent]'>%s</textarea></form>" % (old['html'] if old else '')})
        if m.group(3):
            next(n for n in notes[org] if str(n['id']) == m.group(3))['html'] = form['form[logContent]']
        else:
            notes.setdefault(org, []).append({'id': 33000 + sum(len(v) for v in notes.values()), 'html': form['form[logContent]']})
        return await js({'status': 'CLOSE', 'url': '/a/pr/555/communication-log'})
    await route.fulfill(body=PAGE % json.dumps(S['user']), content_type='text/html')


def shared_values():
    out = {}
    for n in S['notes'].get(78842, []):
        if 'Appointment reminders' not in n['html']:
            continue
        for line in re.split(r'</p>', n['html']):
            f = re.sub(r'<[^>]+>', '', line).strip().split(' | ')
            if len(f) >= 3:
                out[f[0]] = f[2]
    return out


async def page(browser):
    ctx = await browser.new_context(timezone_id='Europe/London')
    await ctx.clock.install(time=NOW.isoformat())
    await ctx.route('https://eu.halaxy.com/**', halaxy)
    await ctx.add_init_script(CORE)
    await ctx.add_init_script("document.addEventListener('DOMContentLoaded', function () {\n" + SCRIPT + "\n});")
    pg = await ctx.new_page()
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    await pg.goto('https://eu.halaxy.com/a/pr/555/calendar')
    await pg.wait_for_function('!!(window.upcApptReminders && window.UPC && UPC.user)')
    return ctx, pg, errors


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        setup()
        ctx, pg, errors = await page(browser)
        out = await pg.evaluate('upcApptReminders.run()')
        word = {k: v.split(' ')[0] for k, v in out.items()}
        check('outcomes: late booking cancelled, older one left, missing one added, too late, no email; cancelled appointment ignored',
              word == {'a.901': 'cancelled', 'a.902': 'ok', 'a.903': 'added', 'a.904': 'late', 'a.906': 'noemail'}, out)
        check('only the late booking\'s reminder cancelled', S['cancels'] == [4901], S['cancels'])
        post = S['posts'][0][1] if S['posts'] else {}
        check("added at 06:00 two days before, Halaxy's subject, body and token kept",
              [x[0] for x in S['posts']] == [3903] and post.get('dateToSend[date]') == '25-Nov-2026' and post.get('dateToSend[hour]') == '6' and post.get('dateToSend[min]') == '0'
              and post.get('dateToSend[isPM]') == '0' and post.get('form[subject]', '').startswith('Appointment Reminder (') and '[Appointment Link]' in post.get('form[body]', '') and post.get('form[_token]') == 'rt', S['posts'])
        sv = shared_values()
        check('outcomes shared with other PCs', all(k in sv for k in ['a.901', 'a.902', 'a.903', 'a.904', 'a.906']), sv)
        n = len(S['views'])
        out2 = await pg.evaluate('upcApptReminders.run()')
        check('a second run reads nothing again', out2 == {} and len(S['views']) == n, (out2, S['views'][n:]))
        S['events'][1]['start'] = ts(2026, 11, 27, 11)
        await pg.evaluate('UPC.calendar.forget()')
        out3 = await pg.evaluate('upcApptReminders.run()')
        check('a moved appointment is looked at again', list(out3) == ['a.902'], out3)
        log = await pg.evaluate("JSON.parse(localStorage.getItem('upc-appt-reminders:log') || '[]').map((x) => x.text)")
        check('recent changes kept', any('cancelled: confirmation sent 23-Nov-2026 19:30' in t for t in log) and any('Reminder added for 25-Nov-2026 06:00' == t for t in log) and any('No email address' in t for t in log), log)
        check('no page errors', not errors, errors)
        await ctx.close()

        for who in ['Physio One', 'Carl Healy']:
            setup()
            S['user'] = who
            ctx, pg, errors = await page(browser)
            await pg.evaluate("localStorage.setItem('upc-core:active', String(Date.now()))")
            await ctx.clock.run_for(70000)
            await pg.wait_for_timeout(1500)
            if who == 'Carl Healy':
                await pg.wait_for_function("!!localStorage.getItem('upc-appt-reminders:lastRun')", timeout=30000)
                check('in the background for someone listed (CH): runs by itself', S['cancels'] == [4901] and [x[0] for x in S['posts']] == [3903], (S['cancels'], S['posts']))
            else:
                check('someone not listed: nothing read in the background', not S['views'] and not S['posts'] and not S['cancels'], S['views'])
            await ctx.close()
        await browser.close()
    print('\n' + ('All passed' if not FAILS else '%d failed' % len(FAILS)))
    sys.exit(1 if FAILS else 0)


asyncio.run(main())
