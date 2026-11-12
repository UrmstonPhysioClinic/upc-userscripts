"""
Test for Feedback alerts (beta/feedback-alerts.user.js) and core's surveys, patient search and patient tasks,
against a mock Halaxy. Invented patients only ("Patient A" ...).

Responses: A Excellent; B Below expected with a comment; C Satisfactory with a comment; D Satisfactory with
"No"; E Below expected, two patients called E (the date of birth picks one); F Below expected, nobody with
that date of birth; G Below expected but 20 days old.

Checks: tasks added (without asking) for B, C and E only, on the right profile, for Carl, with the score,
answers and response number; nothing for A, D, F or G; F counted on Reports > Surveys and listed as not
added; nothing stored holds names or answers; a second PC adds no duplicates; a second check opens only new
responses; the results pop-up; only Carl's sign-in makes any requests.

Run:  python3 tests/feedback-alerts/test_feedback_alerts.py
Needs: Python 3 with Playwright (Chromium).
"""
import asyncio, datetime, json, re, sys, urllib.parse
from pathlib import Path
from zoneinfo import ZoneInfo
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
CORE = (ROOT / 'beta' / 'core.user.js').read_text()
FB = (ROOT / 'beta' / 'feedback-alerts.user.js').read_text()
LON = ZoneInfo('Europe/London')
NOW = datetime.datetime(2026, 11, 11, 12, 0, tzinfo=LON)
MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
hx = lambda d: '%02d-%s-%d' % (d.day, MON[d.month - 1], d.year)
hxt = lambda d: hx(d) + d.strftime(' %H:%M')
S = {}

QS = ["How helpful was today’s appointment?", "Did you feel listened to and understood during your appointment?",
      "How satisfied were you with your overall experience at the clinic today? (including environment, staff attitude, communication, and appointment flow)",
      "Is there anything you'd like us to know or do differently next time?"]


def fresh():
    S.clear()
    S.update({'log': [], 'tasks': {}, 'user': 'Carl Healy', 'responses': [], 'patients': []})

    def patient(lpg, name, dob):
        S['patients'].append({'id': lpg, 'name': name, 'dob': dob})
        S['tasks'].setdefault(lpg, [])

    patient(201, 'Patient A', '1980-01-01')
    patient(202, 'Patient B', '1975-05-05')
    patient(203, 'Patient C', '1990-02-02')
    patient(204, 'Patient D', '1985-03-03')
    patient(205, 'Patient E', '1970-07-07')
    patient(206, 'Patient E', '2001-01-11')    # same name, other date of birth
    patient(207, 'Patient F', '1960-06-06')
    patient(208, 'Patient G', '1966-06-06')

    def response(rid, title, name, dob, days, total, level, answers, comment=None):
        when = NOW - datetime.timedelta(days=days, hours=1)
        S['responses'].append({'id': rid, 'template': 'How Was Your Appointment?', 'patientName': title + ' ' + name, 'answeredDate': hxt(when),
                               'appointmentDateAndTime': hxt(when - datetime.timedelta(hours=3)), 'dob': dob, 'total': total, 'level': level, 'answers': answers, 'comment': comment})

    response(7001, 'Mr', 'Patient A', '01-Jan-1980', 2, 35, 'Excellent', (5, 5, 5), 'Brilliant, thank you')
    response(7002, 'Mrs', 'Patient B', '05-May-1975', 3, 22, 'Below expected', (3, 3, 2), 'Waited a long time to be seen')
    response(7003, 'Ms', 'Patient C', '02-Feb-1990', 1, 28, 'Satisfactory', (4, 4, 4), 'Parking was hard')
    response(7004, 'Mr', 'Patient D', '03-Mar-1985', 1, 29, 'Satisfactory', (4, 4, 5), 'No')
    response(7005, 'Mr', 'Patient E', '11-Jan-2001', 4, 20, 'Below expected', (2, 3, 3))
    response(7006, 'Mr', 'Patient F', '09-Sep-1999', 5, 18, 'Below expected', (2, 2, 2), 'Not great')
    response(7007, 'Mr', 'Patient G', '06-Jun-1966', 20, 15, 'Below expected', (1, 2, 2), 'Old one')


def view(r):
    w = (3, 2, 2)
    qa = ''.join("<div class='depth-level-0 published col-12'><p class='answerContainer mb-3'><span class='sortOrder'>%d.</span><span class='answerName'>%s</span></p>"
                 "<p class='answerSubText'><em>1 = Not at all → 5 = Completely</em></p><span class='answer-wrap'>%d - %d</span></div>" % (i + 1, QS[i], a * w[i], a)
                 for i, a in enumerate(r['answers']))
    if r['comment'] is not None:
        qa += "<div class='depth-level-0 published col-12'><p class='answerContainer mb-3'><span class='sortOrder'>4.</span><span class='answerName'>%s</span></p><span class='answer-wrap'>%s</span></div>" % (QS[3], r['comment'])
    return ("<div class='section'><h3>Patient</h3><div class='viewRow'><div class='label'>Name</div><div class='data full-data-width'>%s</div></div>"
            "<div class='viewRow'><div class='label'>Date of Birth</div><div class='data full-data-width'>%s</div></div></div>"
            "<div class='card-header'><h2>Score (per note)</h2></div><div class='card-body standout border-bottom'><h3>Total: <span id='note_total_score'>%d</span> "
            "<span class='score-level-name'> - <span>%s</span></span></h3></div>%s" % (r['patientName'], r['dob'], r['total'], r['level'], qa))


PAGE = ("<!doctype html><html><head><title>Surveys | Halaxy</title><script>window.HkUser = { pracName: %s, linkPrG: 308963 }; window.Hk = { jwt: 'x' };</script></head>"
        "<body><ul id='mainMenu'><li class='mainmenu-item'><a class='mainmenu-link'><span class='mainmenu-link-label'>Reports</span></a>"
        "<ul><li><a class='mainmenu-sublink' href='/a/pr/555/report/finance/'>Finance</a></li><li><a class='mainmenu-sublink' href='/a/pr/555/report/survey/results'>Surveys</a></li></ul></li></ul>"
        "<h1>Surveys</h1></body></html>")


def task_form():
    return ("<form id='form_task_edit'><input name='form[title]' value=''><select name='form[taskTemplates]'><option value=''></option></select>"
            "<input type='radio' name='form[actionerType]' value='1' checked><select name='form[linkPrGs][]' multiple><option value='30'>Wendy Pritchard</option><option value='31'>Carl Healy</option></select>"
            "<select name='form[priority]'><option value='1'>Low</option><option value='2' selected>Medium</option><option value='3'>High</option></select>"
            "<input name='form[displayDueDate]' value=''><select name='form[displayDueTime][hour]'><option>0</option></select><select name='form[displayDueTime][minute]'><option>0</option></select>"
            "<input type='hidden' name='form[isTimeSet]' value='false'><textarea name='form[comment]'></textarea><input type='hidden' name='form[_token]' value='TT'></form>")


async def halaxy(route):
    req = route.request
    u = urllib.parse.urlparse(req.url)
    p = u.path
    S['log'].append((req.method, re.sub(r'^/a/pr/555', '', p) + ('?' + u.query if 'lookup' in p else '')))
    js = lambda o: route.fulfill(body=json.dumps(o), content_type='application/json')
    if p.endswith('/report/survey/feedback-data'):
        return await js([{k: r[k] for k in ('id', 'template', 'patientName', 'answeredDate', 'appointmentDateAndTime')} for r in S['responses']])
    m = re.search(r'/report/survey/view/(\d+)$', p)
    if m:
        r = next(x for x in S['responses'] if x['id'] == int(m.group(1)))
        return await js({'id': None, 'status': 'FORM', 'title': r['patientName'] + ' - How Was Your Appointment?', 'message': view(r), 'payload': None})
    if p == '/a/magic/lookup/patient':
        q = urllib.parse.parse_qs(u.query)
        if q.get('_locale') != ['555']:   # as live: anything but the page's practice number gets an HTML page
            return await route.fulfill(body='<html><body>Halaxy</body></html>', content_type='text/html')
        term = q['term'][0].lower()
        hits = [{'id': 900 + x['id'], 'title': x['name'], 'payload': {'id': 900 + x['id'], 'quickAddValue': x['name'], 'displayValue': x['name'],
                 'pag': {'id': x['id'], 'status': 'Current'}, 'detail': {'id': 1, 'dob': {'uDate': x['dob'], 'date': ''}}}} for x in S['patients'] if term in x['name'].lower()]
        return await js({'suggest': {}, 'lookup': hits, 'imports': [], 'addtype': 'patient'})
    m = re.search(r'/task/linkPaG/(\d+)/list-data$', p)
    if m:
        return await js(S['tasks'][int(m.group(1))])
    m = re.search(r'/task/new/linkPaG/(\d+)$', p)
    if m:
        lpg = int(m.group(1))
        if req.method == 'GET':
            return await js({'status': 'FORM', 'title': 'Add Task', 'message': task_form()})
        f = urllib.parse.parse_qs(req.post_data or '', keep_blank_values=True)
        S['tasks'][lpg].append({'id': 50 + len(S['log']), 'title': f['form[title]'][0], 'comment': f['form[comment]'][0], 'priority': f['form[priority]'][0],
                                'assignees': f.get('form[linkPrGs][]'), 'status': 'Pending', 'dueDate': f['form[displayDueDate]'][0], 'token': f['form[_token]'][0]})
        return await js({'status': 'POPUP', 'url': '/task/list/linkpag/%d' % lpg})
    if p.startswith('/a/pr/555/report/survey'):
        return await route.fulfill(body=PAGE % json.dumps(S['user']), content_type='text/html')
    await route.fulfill(status=404, body='not mocked ' + p)


FAILS = []
def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)[:900]))
    if not ok:
        FAILS.append(name)


async def page(browser, keep=None):
    ctx = await browser.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/London', storage_state=keep)
    await ctx.clock.install(time=NOW)
    await ctx.route('https://eu.halaxy.com/**', halaxy)
    await ctx.add_init_script("window.__menu = []; window.GM_registerMenuCommand = (l, f) => window.__menu.push([l, f]);")
    await ctx.add_init_script(CORE)
    await ctx.add_init_script("document.addEventListener('DOMContentLoaded', function () {\n" + FB + "\n});")
    pg = await ctx.new_page()
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    await pg.goto('https://eu.halaxy.com/a/pr/555/report/survey/results')
    return ctx, pg, errors

DONE = "(() => { try { return JSON.parse(localStorage.getItem('upc-fb:last') || '0') > 0 && !(Date.now() - JSON.parse(localStorage.getItem('upc-fb:running') || '0') < 120000); } catch (e) { return false; } })()"


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        fresh()
        ctx, pg, errors = await page(browser)
        await pg.wait_for_function(DONE, timeout=120000)
        t = S['tasks']
        added = {k: v for k, v in t.items() if v}
        check('tasks added for B, C and E (the E with the matching date of birth) only', sorted(added) == [202, 203, 206], {k: [x['title'] for x in v] for k, v in added.items()})
        b = (t[202] or [{}])[0]
        check('Below expected: title, High, due today, for Carl, form token', b.get('title') == 'Feedback to look at: Below expected (22 of 35)' and b.get('priority') == '3'
              and b.get('dueDate') == '11-Nov-2026' and b.get('assignees') == ['31'] and b.get('token') == 'TT', b)
        c = b.get('comment', '')
        check('the task holds when, the score, each answer as 1 to 5, the comment and the response number', 'answered 08-Nov-2026 11:00' in c and '- Score: 22 of 35, Below expected' in c and re.match(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2} Feedback alerts\n- ", c)
              and QS[0] + ' 3 of 5' in c and QS[1] + ' 3 of 5' in c and QS[2] + ' 2 of 5' in c and 'Waited a long time to be seen' in c and 'Survey response 7002.' in c, c)
        cc = (t[203] or [{}])[0]
        check('Satisfactory with a comment: Medium', cc.get('title') == 'Feedback to look at: Satisfactory (28 of 35)' and cc.get('priority') == '2' and 'Parking was hard' in cc.get('comment', ''), cc)
        e = (t[206] or [{}])[0]
        check('a skipped comment question is left out', "next time?" not in e.get('comment', '') and 'Survey response 7005.' in e.get('comment', ''), e.get('comment'))
        views = sorted(int(x[1].rsplit('/', 1)[1]) for x in S['log'] if '/report/survey/view/' in x[1])
        check('only responses from the last 14 days are opened', views == [7001, 7002, 7003, 7004, 7005, 7006], views)
        searches = [x[1] for x in S['log'] if 'lookup' in x[1]]
        check('patients searched for only for flagged responses, by name without the title, with the page\'s practice number', len(searches) == 4
              and all('term=patient+' in s and 'mrs' not in s and '_locale=555' in s for s in searches), searches)
        badge = await pg.evaluate("(document.querySelector('#mainMenu a.mainmenu-sublink .upc-fb-badge') || {}).textContent")
        check('F (not found for certain) counted on Reports > Surveys', badge == '1', badge)
        kept = await pg.evaluate("Object.keys(localStorage).filter(k => k.startsWith('upc-fb:')).map(k => localStorage.getItem(k)).join(' ')")
        check('nothing stored holds names, dates of birth or answers', not any(w in kept for w in ['Patient', 'Waited', 'Parking', '1975', 'May-', 'helpful']), kept[:400])

        # The results pop-up (Script settings: Feedback alerts: show results)
        await pg.evaluate("window.__menu.find(m => m[0] === 'Feedback alerts: show results')[1]()")
        await pg.wait_for_function("document.querySelector('[data-upc-dialog=upc-survey-feedback] table') && document.querySelector('[data-upc-dialog=upc-survey-feedback]').innerText.includes('Patient F')")
        txt = await pg.evaluate("document.querySelector('[data-upc-dialog=upc-survey-feedback]').innerText")
        check('results: counts and each flagged response', 'Responses in the last 14 days: 1 Excellent, 2 Satisfactory, 3 Below expected.' in txt and 'Not added: the patient couldn\'t be found for certain.' in txt
              and txt.count('Added') >= 3 and 'Patient B' in txt, txt)
        look = await pg.evaluate("(() => { const r = document.querySelector('[data-upc-dialog=upc-survey-feedback]'); return r.classList.contains('upc-native') && !r.shadowRoot && r.querySelector('table').className.startsWith('table table-striped table-bordered'); })()")
        check('Halaxy look', look)

        # A new response, then Check now: only it is opened
        S['responses'].append({'id': 7008, 'template': 'How Was Your Appointment?', 'patientName': 'Mr Patient A', 'answeredDate': hxt(NOW - datetime.timedelta(minutes=30)),
                               'appointmentDateAndTime': '', 'dob': '01-Jan-1980', 'total': 24, 'level': 'Below expected', 'answers': (2, 3, 3), 'comment': None})
        n = len(S['log'])
        await pg.click('[data-upc-dialog=upc-survey-feedback] [data-a=check]')
        await pg.wait_for_function("!document.querySelector('[data-upc-dialog=upc-survey-feedback] [data-a=check]').disabled", timeout=120000)
        again = [x[1] for x in S['log'][n:] if '/report/survey/view/' in x[1]]
        check('a second check opens only the new response (and F again, not yet found)', sorted(again) == ['/report/survey/view/7006', '/report/survey/view/7008'], again)
        check('task for the new response', [x['title'] for x in t[201]] == ['Feedback to look at: Below expected (24 of 35)'], t[201])
        check('no page errors', not errors, errors)
        await ctx.close()

        # Another PC (nothing stored): no duplicates
        before = {k: len(v) for k, v in t.items()}
        ctx, pg, errors = await page(browser)
        await pg.wait_for_function(DONE, timeout=120000)
        check('another PC adds no duplicate tasks', {k: len(v) for k, v in t.items()} == before, {k: len(v) for k, v in t.items()})
        await ctx.close()

        # Someone else signed in: nothing at all
        fresh()
        S['user'] = 'Wendy Pritchard'
        ctx, pg, errors = await page(browser)
        await pg.wait_for_timeout(10000)
        check('others: no requests, no menu entry, no count', [x for x in S['log'] if '/report/survey/' in x[1] and not x[1].endswith('/results')] == []
              and await pg.evaluate("window.__menu.length") == 0 and not any(S['tasks'].values()), S['log'])
        await ctx.close()

        # Helpers
        fresh()
        ctx, pg, errors = await page(browser)
        r = await pg.evaluate("[window.upcSurveyFeedback.answerText('15 - 5'), window.upcSurveyFeedback.answerText('4 - 2'), window.upcSurveyFeedback.answerText('4 - 8'), window.upcSurveyFeedback.answerText('Lovely'), "
                              "window.upcSurveyFeedback.meaningful('No.'), window.upcSurveyFeedback.meaningful('Nothing to add'), window.upcSurveyFeedback.meaningful('Room was cold')]")
        check('answer and comment reading', r == ['5 of 5', '2 of 5', '4 - 8', 'Lovely', False, False, True], r)
        await ctx.close()
        await browser.close()

    print('\n%d failed' % len(FAILS) if FAILS else '\nAll passed')
    sys.exit(1 if FAILS else 0)

asyncio.run(main())
