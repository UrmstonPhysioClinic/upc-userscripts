"""
Test for Review requests and core's notes, follow-ups and patient helpers, against a mock Halaxy.

Invented patients ("Patient A" ...), each built to hit one rule: good outcome (Progress Update +5 and
"discharged, goals met, back to running"), mixed ("100% better" but "referred to GP"), nothing good,
still booked, seen too recently, seen too long ago, already sent a review request, last appointment
cancelled, labelled "No review request", under 16, owing money, "not 100% better" (negated), Progress
Update +1.

Checks: who is listed and where; what's left out and counted; the menu count; note text never kept;
notes read only for finished patients, and not again on the next check; Send review request (Halaxy's
Add Follow-Up with the Review Request templates, by email, confirmed first, checked afterwards); Don't
ask (the label added on the Edit page with every other field sent back unchanged, checked afterwards);
only Carl sees it; the Halaxy look.

Run:  python3 tests/review-requests/test_review_requests.py
Needs: Python 3 with Playwright (Chromium).
"""
import asyncio, datetime, json, re, sys, urllib.parse
from pathlib import Path
from zoneinfo import ZoneInfo
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
CORE = (ROOT / 'beta' / 'core.user.js').read_text()
RR = (ROOT / 'beta' / 'review-requests.user.js').read_text()
LON = ZoneInfo('Europe/London')
NOW = datetime.datetime(2026, 11, 10, 12, 0, tzinfo=LON)
MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
hx = lambda d: '%02d-%s-%d' % (d.day, MON[d.month - 1], d.year)
at = lambda n: NOW + datetime.timedelta(days=n)
S = {}


def fresh():
    S.clear()
    S.update({'patients': {}, 'events': [], 'followups': [], 'log': [], 'writes': [], 'user': 'Carl Healy', 'nextNote': 5000})

    def patient(pid, name, appts, notes=(), progress=None, labels=(), dob='01/01/1980', owes=False):
        items = []
        for n, text in notes:
            S['nextNote'] += 1
            items.append({'id': str(S['nextNote']), 'category': 'appointment', 'entity': 'note', 'label': 'Appointment', 'date': hx(at(n)), 'text': text})
        if progress is not None:
            items.append({'id': str(9000 + pid), 'category': 'form', 'entity': 'intake-form-invite', 'label': 'Progress Update', 'date': hx(at(progress[0])), 'score': progress[1]})
        S['patients'][pid] = {'name': name, 'items': items, 'labels': list(labels), 'dob': dob, 'owes': owes, 'phone': '07700 900%03d' % (pid % 1000)}
        for n, status in appts:
            S['events'].append({'id': len(S['events']) + 1, 'type': 'appointment', 'linkPaGId': pid, 'title': name, 'appointmentStatus': status,
                                'start': int((NOW + datetime.timedelta(days=n)).replace(hour=10).timestamp())})

    patient(101, 'Patient A', [(-40, ''), (-20, '')], [(-40, 'Initial assessment. Knee pain.'), (-20, 'Discharged, goals met. Back to running pain free.')], progress=(-21, 5))
    patient(102, 'Patient B', [(-30, ''), (-21, '')], [(-21, 'Feels 100% better. Referred to GP for bloods.')])
    patient(103, 'Patient C', [(-20, '')], [(-20, 'Still sore. Continue exercises.')])
    patient(104, 'Patient D', [(-20, ''), (7, '')], [(-20, 'Discharged.')])
    patient(105, 'Patient E', [(-5, ''), (3, '')], [(-5, 'Discharged.')])
    patient(106, 'Patient F', [(-35, '')], [(-35, 'Discharged.')])
    patient(107, 'Patient G', [(-20, '')], [(-20, 'Discharged.')])
    S['followups'].append({'id': 1, 'title': 'Review Request', 'status': 'Sent', 'scheduledOrSentDate': '2026-11-01T09:00:00+00:00', 'linkedToId': 107,
                           'assignedTo': 'Patient G', 'assignedToUrl': '/a/pr/555/patient/107', 'linkedTo': 'Clinical Note', 'linkedToUrl': '/a/pr/555/patient/107/', 'method': 'Email'})
    patient(108, 'Patient H', [(-25, ''), (-10, 'cancelled')], [(-25, 'Discharged.')])
    patient(109, 'Patient I', [(-20, '')], [(-20, 'Discharged, goals met.')], labels=['No review request'])
    patient(110, 'Patient J', [(-20, '')], [(-20, 'Discharged, goals met.')], dob='01/06/2014')
    patient(111, 'Patient K', [(-20, '')], [(-20, 'Discharged, goals met.')], owes=True)
    patient(112, 'Patient L', [(-20, '')], [(-20, 'Not 100% better yet, continue exercises.')])
    patient(113, 'Patient M', [(-20, '')], [(-20, 'Continue exercises.')], progress=(-21, 1))
    # N: seen 2 days ago, discharged: asked straight away. O: seen 3 days ago, much better but not discharged: waits.
    patient(114, 'Patient N', [(-9, ''), (-2, '')], [(-2, 'Discharged, goals met. Pain free.')])
    patient(115, 'Patient O', [(-3, '')], [(-3, 'Pain free, much better. Continue exercises.')])
    # Seen today: not yet (from the day after).
    patient(116, 'Patient P', [(0, '')], [(0, 'Discharged.')])


PAGE = ("<!doctype html><html><head><title>Patients | Halaxy</title><script>window.HkUser = { pracName: %s }; window.Hk = { jwt: 'x' };</script></head>"
        "<body style='margin:0 0 0 230px'><div style='position:fixed;left:0;top:0;width:218px'><ul id='mainMenu'>"
        "<li class='mainmenu-item active'><a class='mainmenu-link'><span class='mainmenu-link-label'>Patients</span></a>"
        "<ul><li class='active'><a class='mainmenu-sublink active' href='/a/pr/555/patient/'>Patient List</a></li><li><a class='mainmenu-sublink' href='/a/pr/555/patient/new'>Add Patient</a></li></ul></li>"
        "</ul></div><h1>Patient List</h1></body></html>")


def followup_form():
    rem_follow = "<option value='32'>Review Reminder</option>" if S.get('reminder') else ''
    rem_email = "<option value='46'>Review Reminder</option>" if S.get('reminder') else ''
    hours = ''.join("<option value='%d'>%02d</option>" % (h, h) for h in range(24))
    minutes = ''.join("<option value='%d'>%02d</option>" % (m, m) for m in range(60))
    return ("<form id='form-recall-template'><select name='form[recallTemplate]'><option value=''>Select follow-up template</option><option value='31'>Review Request</option>" + rem_follow + "</select>"
            "<input name='form[title]' value=''><input type='checkbox' name='form[isEmailMethod]' value='1' checked><input type='checkbox' name='form[isSmsMethod]' value='1'>"
            "<input name='form[scheduleAt][date]' value='" + hx(NOW) + "'><select name='form[scheduleAt][time][hour]'>" + hours + "</select><select name='form[scheduleAt][time][minute]'>" + minutes + "</select>"
            "<select name='form[intakeFormTemplate]'><option value=''>Select form</option><option value='7'>Progress Update</option></select>"
            "<select name='form[emailTemplate]'><option value=''></option><option value='44'>Blank Email</option><option value='45'>Review Request</option>" + rem_email + "</select>"
            "<select name='form[smsTemplate]'><option value=''></option></select><input type='hidden' name='form[_token]' value='FT'><button class='btn-submit'>Save</button></form>")


def edit_page(pid):
    p = S['patients'][pid]
    opts = ''.join("<option value='%d'%s>%s</option>" % (v, ' selected' if n in p['labels'] else '', n) for v, n in ((201, 'Created via Form Link'), (202, 'No review request')))
    return ("<html><body><form id='patientGeneralEditForm' method='post' action=''><input type='hidden' name='save_patient' value='1'>"
            "<input name='patientdetailmain[name][forename]' value='%s'><select name='patientdetailmain[dob][day]'><option value='1' selected>1</option><option value='2'>2</option></select>"
            "<select name='patientdetailmain[linkPaG][userLabels][]' multiple>%s</select>"
            "<input name='patientdetailmain[linkPaG][linkphonepas][0][phone][number]' value='%s'><textarea name='patientdetailmain[linkPaG][note]'>Likes mornings</textarea>"
            "<input type='hidden' name='patientdetailmain[_token]' value='ET'><button class='btn btn-primary btn-submit'>Save</button></form></body></html>"
            % (p['name'], opts, p['phone']))


async def halaxy(route):
    req = route.request
    u = urllib.parse.urlparse(req.url)
    p = u.path
    S['log'].append((req.method, re.sub(r'^/a/pr/555', '', p)))
    js = lambda o: route.fulfill(body=json.dumps(o), content_type='application/json')
    if p.endswith('/lookup/practitioner'):
        return await js([{'id': 11}, {'id': 12}])
    if p.endswith('/calendar/json'):
        q = urllib.parse.parse_qs(u.query)
        lo, hi = int(q['start'][0]), int(q['end'][0])
        return await js({'payload': {'events': [e for e in S['events'] if lo <= e['start'] < hi]}})
    if p.endswith('/task/task-followup/list/data'):
        return await js(S['followups'])
    m = re.search(r'/task/patient/(\d+)/task-followup/create$', p)
    if m:
        pid = int(m.group(1))
        if req.method == 'GET':
            return await js({'status': 'FORM', 'title': 'Add Follow-Up', 'message': followup_form()})
        f = urllib.parse.parse_qs(req.post_data or '', keep_blank_values=True)
        d = datetime.datetime.strptime(f['form[scheduleAt][date]'][0], '%d-%b-%Y').replace(hour=int(f['form[scheduleAt][time][hour]'][0]),
                                                                                       minute=int(f['form[scheduleAt][time][minute]'][0]), tzinfo=LON)
        if d <= NOW or S.get('rejectFollowup'):   # as Halaxy: the form comes back with its hints and a list of errors
            return await js({'status': 'FORM', 'message': followup_form() + "<div class='invalid-feedback'>* Title is required</div><div class='text-danger'>* Method is required</div>",
                             'errors': ['Scheduled date must be in the future']})
        S['writes'].append(('followup', pid, f))
        # As live (10 Nov 2026): added from the patient's profile, so the patient is in assignedTo and Linked To is empty.
        S['followups'].append({'id': len(S['followups']) + 1, 'title': f['form[title]'][0], 'status': 'Scheduled', 'assignedTo': S['patients'][pid]['name'],
                               'assignedToUrl': '/a/pr/555/patient/%d' % pid, 'linkedToId': None, 'linkedTo': '', 'linkedToUrl': '', 'method': 'Email'})
        return await js({'status': 'REFRESH'})
    m = re.search(r'/note/menu/linkPaG/(\d+)/items$', p)
    if m:
        items = [{k: v for k, v in it.items() if k not in ('text', 'score')} for it in S['patients'][int(m.group(1))]['items']]
        return await js({'payload': {'menuItems': items}})
    m = re.search(r'/note/(\d+)$', p)
    if m:
        it = next(i for pt in S['patients'].values() for i in pt['items'] if i['id'] == m.group(1))
        return await js({'id': int(m.group(1)), 'content': '<p>%s</p>' % it['text'], 'final': '<p>%s</p>' % it['text'], 'contentQuestions': '', 'status': 'published'})
    m = re.search(r'/setting/clinical/patient/intake/(\d+)$', p)
    if m:
        it = next(i for pt in S['patients'].values() for i in pt['items'] if i['id'] == m.group(1))
        q = ("<p class='answerContainer'><span class='answerName'>How have your symptoms changed since you first saw us for this on a scale of -5 to 5?</span></p>"
             "<span class='answer-wrap'>%d (Recorded on %s 10:00 am)</span>" % (it['score'], it['date']))
        return await js({'status': 'FORM', 'title': 'Progress Update', 'message': "<div class='viewRow'>%s</div>" % q})
    m = re.search(r'/note/sidebar/linkPaG/(\d+)$', p)
    if m:
        pt = S['patients'][int(m.group(1))]
        return await js({'patientDetails': {'fullName': pt['name'], 'dob': pt['dob'], 'userLabels': [{'name': n} for n in pt['labels']], 'status': 'Current'}})
    m = re.search(r'/patient/invoice/(\d+)/list-data$', p)
    if m:
        pt = S['patients'][int(m.group(1))]
        return await js([{'id': 1, 'total': '50.00', 'balance': '50.00' if pt['owes'] else '0.00', 'status': 'Not yet paid' if pt['owes'] else 'Paid In Full'}])
    m = re.search(r'/patient/(\d+)/edit$', p)
    if m:
        pid = int(m.group(1))
        if req.method == 'POST':
            f = urllib.parse.parse_qs(req.post_data or '', keep_blank_values=True)
            S['writes'].append(('edit', pid, f))
            vals = f.get('patientdetailmain[linkPaG][userLabels][]', [])
            S['patients'][pid]['labels'] = [n for v, n in (('201', 'Created via Form Link'), ('202', 'No review request')) if v in vals]
            return await js({'status': 'REFRESH'})
        return await route.fulfill(body=edit_page(pid), content_type='text/html')
    if re.search(r'/patient/?$', p):
        return await route.fulfill(body=PAGE % json.dumps(S['user']), content_type='text/html')
    await route.fulfill(status=404, body='not mocked ' + p)


FAILS = []
def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)[:700]))
    if not ok:
        FAILS.append(name)


ROOT_JS = "document.querySelector('[data-upc-review-requests]')"
ROWS = """[...document.querySelectorAll('[data-upc-review-requests] tbody tr')].map((tr) => ({ who: tr.cells[0].textContent, off: tr.classList.contains('upc-off'),
  when: tr.cells[1].textContent, why: tr.cells[2].innerText, acts: tr.cells[4].innerText,
  links: [...tr.cells[3].querySelectorAll('a')].map((a) => a.textContent + ' ' + a.getAttribute('href') + ' ' + a.target) }))"""


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        fresh()
        ctx = await browser.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/London')
        await ctx.clock.install(time=NOW)
        await ctx.route('https://eu.halaxy.com/**', halaxy)
        await ctx.add_init_script(CORE)
        await ctx.add_init_script("document.addEventListener('DOMContentLoaded', function () {\n" + RR + "\n});")
        pg = await ctx.new_page()
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/#upc-review-requests')
        await pg.wait_for_function(ROOT_JS + " && " + ROOT_JS + ".querySelector('table') && !" + ROOT_JS + ".querySelector('[data-a=refresh]').disabled", timeout=90000)
        rows = await pg.evaluate(ROWS)
        by = {r['who']: r for r in rows}
        check('good outcome: listed first, with the reasons', by.get('Patient A') and not by['Patient A']['off'] and rows[1]['who'] == 'Patient A'
              and 'Progress Update +5' in by['Patient A']['why'] and 'discharged' in by['Patient A']['why'] and 'goals met' in by['Patient A']['why'] and 'back to sport or work' in by['Patient A']['why'], rows)
        a = S['patients'][101]['items']
        check('links to the notes and Progress Update form behind it, newest first, in a new tab', by.get('Patient A', {}).get('links') == [
            'Last note (%s) /a/pr/555/patient/101/clinical/category/note/id/%s _blank' % (a[1]['date'], a[1]['id']),
            'Previous note (%s) /a/pr/555/patient/101/clinical/category/note/id/%s _blank' % (a[0]['date'], a[0]['id']),
            'Progress Update (%s) /a/pr/555/patient/101/clinical/category/intake-form-invite/id/%s _blank' % (a[2]['date'], a[2]['id'])], by.get('Patient A'))
        check('mixed signs: greyed under Worth a look, with what counts against', by.get('Patient B', {}).get('off') and 'Against: referred on' in by['Patient B']['why'], by.get('Patient B'))
        check('only A, B and N listed', sorted(by) == ['Patient A', 'Patient B', 'Patient N'], sorted(by))
        check('discharged 2 days ago: asked straight away', by.get('Patient N', {}).get('off') is False and 'discharged' in by['Patient N']['why'], by.get('Patient N'))
        foot = await pg.evaluate(ROOT_JS + ".querySelector('.upc-rr > p.text-muted').textContent")
        check('left out and counted: asked, labelled/under 16/owing, cancelled, no good signs', "Left out: 1 already sent a review request, 3 labelled No review request, under 16 or owing money, 1 whose last appointment was cancelled or missed, 1 seen in the last 2 weeks whose notes don't say they've finished, and 3 with no good-outcome signs" in foot, foot)
        check('menu count', await pg.evaluate("(document.querySelector('a.upc-rr-menu .upc-rr-badge') || {}).textContent") == '2')
        menu = await pg.evaluate("[...document.querySelectorAll('#mainMenu a.mainmenu-sublink')].map(a => a.getAttribute('href'))")
        check('menu item under Patients, over the Patient List', '/a/pr/555/patient/#upc-review-requests' in menu, menu)
        notes_read = sorted({x[1] for x in S['log'] if x[1].startswith('/note/menu/')})
        check('notes read only for finished patients not yet asked', notes_read == ['/note/menu/linkPaG/%d/items' % i for i in (101, 102, 103, 109, 110, 111, 112, 113, 114, 115)], notes_read)
        details = sorted({x[1] for x in S['log'] if '/note/sidebar/' in x[1] or '/patient/invoice/' in x[1]})
        check('labels, age and invoices read only for good-looking patients', all(re.search(r'/(101|102|109|110|111|114|115)(/|$)', x) for x in details) and len(details) >= 5, details)
        kept = await pg.evaluate("Object.keys(localStorage).filter(k => k.startsWith('upc-rr:')).map(k => localStorage.getItem(k)).join(' ')")
        check('note text never kept', not any(t in kept for t in ['Back to running', 'Referred to GP', 'Still sore', 'Knee pain']), kept[:300])
        look = await pg.evaluate("(() => { const r = " + ROOT_JS + "; return r.classList.contains('upc-native') && !r.shadowRoot && r.querySelector('table').className.startsWith('table table-striped table-bordered'); })()")
        check('Halaxy look', look)

        # Send review request for Patient A
        await pg.click("[data-send='101']")
        await pg.wait_for_selector('[data-upc-rr-confirm]')
        conf = await pg.evaluate("document.querySelector('[data-upc-rr-confirm]').innerText")
        check('asks first', 'Schedule the Review Request email for Patient A on Wednesday 11-Nov-2026 at 10:30?' in conf and not S['writes'], conf)
        await pg.click('[data-upc-rr-confirm] [data-c=yes]')
        await pg.wait_for_function("[...document.querySelectorAll('[data-upc-review-requests] tbody tr')].some(tr => tr.innerText.includes('Review request scheduled for Wednesday 11-Nov-2026 at 10:30'))", timeout=90000)
        w = [x for x in S['writes'] if x[0] == 'followup']
        f = w[0][2] if w else {}
        check('follow-up sent with the Review Request email template (not the follow-up template), for the next weekday at 10:30', len(w) == 1 and w[0][1] == 101 and f.get('form[recallTemplate]') == [''] and f.get('form[emailTemplate]') == ['45']
              and f.get('form[title]') == ['Review Request'] and f.get('form[isEmailMethod]') == ['1'] and 'form[isSmsMethod]' not in f and f.get('form[scheduleAt][date]') == ['11-Nov-2026']
              and f.get('form[scheduleAt][time][hour]') == ['10'] and f.get('form[scheduleAt][time][minute]') == ['30'] and f.get('form[_token]') == ['FT'], f)
        check('count drops once sent', await pg.evaluate("(document.querySelector('a.upc-rr-menu .upc-rr-badge') || {}).textContent") == '1')

        # Halaxy refuses: only its own reason is shown, not the form's hints
        S['rejectFollowup'] = True
        await pg.click("[data-send='114']")
        await pg.wait_for_selector('[data-upc-rr-confirm]')
        await pg.click('[data-upc-rr-confirm] [data-c=yes]')
        await pg.wait_for_function("[...document.querySelectorAll('[data-upc-review-requests] tbody tr')].some(tr => tr.innerText.includes('not accepted'))", timeout=90000)
        err = await pg.evaluate("[...document.querySelectorAll('[data-upc-review-requests] .upc-rr-acts .upc-err')].map(e => e.textContent).join(' | ')")
        check('a refusal shows Halaxy\'s reason only', err == 'Adding the follow-up was not accepted by Halaxy: Scheduled date must be in the future', err)
        S['rejectFollowup'] = False

        # With a Review Reminder follow-up set up in Halaxy: a reminder a week later, same time
        S['reminder'] = True
        await pg.click("[data-send='114']")
        await pg.wait_for_selector('[data-upc-rr-confirm]')
        await pg.click('[data-upc-rr-confirm] [data-c=yes]')
        await pg.wait_for_function("[...document.querySelectorAll('[data-upc-review-requests] tbody tr')].some(tr => tr.innerText.includes('reminder Wednesday 18-Nov-2026 at 10:30'))", timeout=90000)
        w = [x for x in S['writes'] if x[0] == 'followup' and x[1] == 114]
        check('reminder added a week later from the Review Reminder templates', len(w) == 2 and w[1][2].get('form[recallTemplate]') == [''] and w[1][2].get('form[emailTemplate]') == ['46']
              and w[1][2].get('form[scheduleAt][date]') == ['18-Nov-2026'] and w[1][2].get('form[title]') == ['Review Reminder'], [x[2] for x in w])
        S['reminder'] = False

        # Don't ask for Patient B
        await pg.click("[data-skip='102']")
        await pg.wait_for_selector('[data-upc-rr-confirm]')
        await pg.click('[data-upc-rr-confirm] [data-c=yes]')
        # (up to a minute: by now the check has used this minute's 45 requests, and the pacing waits its turn)
        await pg.wait_for_function("[...document.querySelectorAll('[data-upc-review-requests] tbody tr')].some(tr => tr.innerText.includes('Labelled No review request'))", timeout=90000)
        w = [x for x in S['writes'] if x[0] == 'edit']
        f = w[0][2] if w else {}
        check('label added on the Edit page, everything else sent back as it was', len(w) == 1 and f.get('patientdetailmain[linkPaG][userLabels][]') == ['202']
              and f.get('patientdetailmain[name][forename]') == ['Patient B'] and f.get('patientdetailmain[dob][day]') == ['1'] and f.get('patientdetailmain[linkPaG][note]') == ['Likes mornings']
              and f.get('patientdetailmain[linkPaG][linkphonepas][0][phone][number]') == [S['patients'][102]['phone']] and f.get('patientdetailmain[_token]') == ['ET'] and f.get('save_patient') == ['1'], f)
        check('no page errors', not errors, errors)

        # Check again: results kept, notes not read again
        n = len(S['log'])
        await pg.click('[data-a=refresh]')
        await pg.wait_for_function("!document.querySelector('[data-a=refresh]').disabled", timeout=60000)
        again = [x[1] for x in S['log'][n:]]
        check('checking again reuses what was read', not any('/note/' in x or '/patient/invoice/' in x for x in again) and any('task-followup/list/data' in x for x in again), again)
        rows = await pg.evaluate(ROWS)
        check('after sending, A is left out as already asked', 'Patient A' not in {r['who'] for r in rows}, rows)
        await ctx.close()

        # Someone else signed in
        fresh()
        S['user'] = 'Wendy Pritchard'
        ctx = await browser.new_context(timezone_id='Europe/London')
        await ctx.clock.install(time=NOW)
        await ctx.route('https://eu.halaxy.com/**', halaxy)
        await ctx.add_init_script(CORE)
        await ctx.add_init_script("document.addEventListener('DOMContentLoaded', function () {\n" + RR + "\n});")
        pg = await ctx.new_page()
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/#upc-review-requests')
        await pg.wait_for_timeout(6000)
        check('others: no menu item, no page, no requests', await pg.evaluate("!document.querySelector('.upc-rr-menu') && !" + ROOT_JS)
              and [x for x in S['log'] if not re.search(r'/patient/?$', x[1])] == [], S['log'])
        await ctx.close()

        # The phrase reader
        fresh()
        ctx = await browser.new_context()
        await ctx.route('https://eu.halaxy.com/**', halaxy)
        await ctx.add_init_script(CORE)
        await ctx.add_init_script("document.addEventListener('DOMContentLoaded', function () {\n" + RR + "\n});")
        pg = await ctx.new_page()
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/')
        cases = await pg.evaluate("""[
          'Patient reports 100% improvement, fully recovered.', 'Not 100% better yet.', 'No longer pain free after the weekend.', 'Pain free. Ran the Manchester half marathon.',
          'Has returned to full training. NPRS 1/10. Really pleased.', 'Had a flare-up after gardening.', 'Self-managing with home exercises; see as needed.',
          'Pain worse on stairs at first assessment. No need for a scan. Discussed injection options. Discharged.', 'Referred to GP for bloods.', 'No flare-up since last session.'
        ].map((t) => window.upcReviewRequests.phrases(t))""")
        check('"100% improvement, fully recovered" counts', '100% better' in cases[0]['good'], cases[0])
        check('"not 100% better" counts against, not for', not cases[1]['good'] and 'not fully better' in cases[1]['bad'], cases[1])
        check('"no longer pain free" is not pain-free', 'pain-free' not in cases[2]['good'], cases[2])
        check('pain-free and a race', 'pain-free' in cases[3]['good'] and 'race or event done' in cases[3]['good'], cases[3])
        check('back to training, low pain score, pleased', 'back to sport or work' in cases[4]['good'] and 'low pain score' in cases[4]['nice'] and 'very happy' in cases[4]['nice'], cases[4])
        check('flare-up counts against', 'worse or flare-up' in cases[5]['bad'], cases[5])
        check('self-managing, see as needed', 'self-managing' in cases[6]['good'] and 'discharged' in cases[6]['good'], cases[6])
        check('plain mentions (worse on stairs, a scan, injection options) don\'t count against', not cases[7]['bad'] and 'discharged' in cases[7]['good'], cases[7])
        check('referred to GP counts against', 'referred on' in cases[8]['bad'], cases[8])
        check('"no flare-up" doesn\'t count against', not cases[9]['bad'], cases[9])
        await ctx.close()
        await browser.close()

    print('\n%d failed' % len(FAILS) if FAILS else '\nAll passed')
    sys.exit(1 if FAILS else 0)

asyncio.run(main())
