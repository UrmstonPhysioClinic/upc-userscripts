"""
Test for Check-ins against a mock Halaxy (calendar, notes list and note, follow-ups list; same shapes as Review
requests' test, confirmed live). Invented patients and notes only.

Checks: open-ended wording in the latest note, 3 weeks to 3 months after the last visit, nothing booked, last visit
not cancelled or missed; negations; only the latest note counts; Review Request marked; the menu count; note text
not stored; cached between checks; Carl only.

Run:  python3 tests/open-ended-patients/test_open_ended_patients.py
"""
import asyncio, datetime, json, re, sys, urllib.parse
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
CORE = (ROOT / 'beta' / 'core.user.js').read_text().replace('perMinute: 45,', 'perMinute: 100000,')   # tests: no 45-a-minute wait (the 300 ms gap stays)
CI = (ROOT / 'beta' / 'open-ended-patients.user.js').read_text()
MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
hx = lambda d: '%02d-%s-%d' % (d.day, MON[d.month - 1], d.year)
NOW = datetime.datetime(2026, 11, 11, 12, 0, tzinfo=datetime.timezone.utc)
at = lambda n: (NOW + datetime.timedelta(days=n)).date()
FAILS = []
S = {}


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)))
    if not ok:
        FAILS.append(name)


def setup():
    S.clear()
    S.update({'patients': {}, 'events': [], 'followups': [], 'log': [], 'user': 'Carl Healy', 'nextNote': 5000})

    def patient(pid, name, appts, notes=()):
        items = []
        for n, text in notes:
            S['nextNote'] += 1
            items.append({'id': str(S['nextNote']), 'category': 'appointment', 'entity': 'note', 'label': 'Appointment', 'date': hx(at(n)), 'text': text})
        S['patients'][pid] = {'name': name, 'items': items}
        for n, status in appts:
            S['events'].append({'id': len(S['events']) + 1, 'type': 'appointment', 'linkPaGId': pid, 'title': name, 'appointmentStatus': status,
                                'start': int((NOW + datetime.timedelta(days=n)).replace(hour=10).timestamp())})

    patient(201, 'Patient A', [(-40, ''), (-25, '')], [(-40, 'Initial assessment.'), (-25, 'Much improved. Open return.')])
    patient(202, 'Patient B', [(-30, '')], [(-30, 'Exercises progressed. Pt to book again if needed.')])
    patient(203, 'Patient C', [(-50, '')], [(-50, 'Good progress, see how things go over the next few weeks.')])
    patient(204, 'Patient D', [(-22, '')], [(-22, 'Happy to come back if any problems.')])
    patient(205, 'Patient E', [(-25, ''), (5, '')], [(-25, 'Open return.')])                       # booked ahead
    patient(206, 'Patient F', [(-10, '')], [(-10, 'Open return.')])                                 # under 3 weeks
    patient(207, 'Patient G', [(-120, '')], [(-120, 'Open return.')])                               # over 3 months
    patient(208, 'Patient H', [(-30, ''), (-15, 'did-not-attend')], [(-30, 'Open return.')])        # last one missed
    patient(209, 'Patient I', [(-30, '')], [(-30, 'Continue exercises, next appt in 2 weeks.')])    # not open-ended
    patient(210, 'Patient J', [(-30, '')], [(-30, 'No need to book again if needed is not the plan; discharged.')])  # negated
    patient(211, 'Patient K', [(-45, ''), (-28, '')], [(-45, 'Open appointment.'), (-28, 'Next session booked for review.')])  # only the latest note
    patient(212, 'Patient L', [(-26, '')], [(-26, 'SOS. See as needed.')])
    S['followups'].append({'id': 1, 'title': 'Review Request', 'status': 'Sent', 'assignedTo': 'Patient L', 'assignedToUrl': '/a/pr/555/patient/212'})


def page_html(user):
    return ("<!doctype html><html><head><title>Patients | Halaxy</title></head><body style='margin:0 0 0 230px'>"
            "<div style='position:fixed;left:0;top:0;bottom:0;width:218px'><nav id='side'><ul id='mainMenu'>"
            "<li class='mainmenu-item active'><a class='mainmenu-link'><span class='mainmenu-link-label'>Patients</span></a>"
            "<ul><li class='active'><a class='mainmenu-sublink active' href='/a/pr/555/patient/'>Patient List</a></li></ul></li></ul></nav></div>"
            "<div id='headerWrapper' style='height:50px'></div><h1>Patients</h1>"
            "<script>window.HkUser = { linkPrG: 11, pracID: 11, pracName: %s };</script></body></html>") % json.dumps(user)


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
    m = re.search(r'/note/menu/linkPaG/(\d+)/items$', p)
    if m:
        items = [{k: v for k, v in it.items() if k != 'text'} for it in S['patients'][int(m.group(1))]['items']]
        return await js({'payload': {'menuItems': items}})
    m = re.search(r'/note/(\d+)$', p)
    if m:
        it = next(i for pt in S['patients'].values() for i in pt['items'] if i['id'] == m.group(1))
        return await js({'id': int(m.group(1)), 'content': '<p>%s</p>' % it['text'], 'final': '', 'contentQuestions': ''})
    if p.startswith('/a/pr/555/'):
        return await route.fulfill(body=page_html(S['user']), content_type='text/html')
    await route.fulfill(status=404, body='not mocked')


async def context(browser):
    ctx = await browser.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/London')
    await ctx.clock.install(time=NOW.isoformat())
    await ctx.route('https://eu.halaxy.com/**', halaxy)
    await ctx.add_init_script(CORE)
    await ctx.add_init_script("document.addEventListener('DOMContentLoaded', function () {\n" + CI + "\n});")
    return ctx

ROWS = "[...document.querySelectorAll('[data-upc-check-ins] tbody tr')].map((tr) => [...tr.cells].map((c) => c.textContent.trim()))"


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        setup()
        ctx = await context(browser)
        pg = await ctx.new_page()
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/#upc-check-ins')
        await pg.wait_for_function("document.querySelector('[data-upc-check-ins] table') && !document.querySelector('[data-upc-check-ins] [data-a=refresh]').disabled", timeout=90000)
        rows = await pg.evaluate(ROWS)
        names = [r[0] for r in rows]
        check('open-ended, 3 weeks to 3 months, nothing booked: oldest visit first', names == ['Patient C', 'Patient B', 'Patient L', 'Patient A', 'Patient D'], rows)
        by = {r[0]: r for r in rows}
        check('the wording found is named', by.get('Patient A', [''] * 4)[3].startswith('open return') and by.get('Patient B', [''] * 4)[3].startswith('book again if needed')
              and by.get('Patient C', [''] * 4)[3].startswith('see how things go') and by.get('Patient D', [''] * 4)[3].startswith('come back if needed'), rows)
        check('last seen and days', by.get('Patient A', [])[1:3] == ['17-Oct-2026', '25'], by.get('Patient A'))
        check('nothing about Review requests: no column, follow-ups not read', all(len(r) == 4 for r in rows) and not [x for x in S['log'] if 'followup' in x[1]], (rows, S['log']))
        check('left out: booked ahead, under 3 weeks, over 3 months, last one missed, not open-ended, negated, older note only',
              not any(n in names for n in ['Patient E', 'Patient F', 'Patient G', 'Patient H', 'Patient I', 'Patient J', 'Patient K']), names)
        link = await pg.evaluate("document.querySelector('[data-upc-check-ins] tbody tr td:nth-child(4) a').getAttribute('href')")
        check('links to the note', re.fullmatch(r'/a/pr/555/patient/\d+/clinical/category/note/id/\d+', link or '') is not None, link)
        badge = await pg.evaluate("(document.querySelector('a.upc-ci-menu .upc-ci-badge') || {}).textContent")
        check('menu item under Patients with the count', badge == '5', badge)
        stored = await pg.evaluate("Object.keys(localStorage).filter((k) => k.startsWith('upc-ci:')).map((k) => localStorage.getItem(k)).join(' ')")
        check('note text never stored', not any(x in stored for x in ['Much improved', 'Exercises progressed', 'Pt to book', 'any problems', 'next few weeks']), stored[:300])
        notes_read = sorted({x[1] for x in S['log'] if x[1].startswith('/note/menu/')})
        check('notes read only for patients 3 weeks to 3 months quiet with nothing booked', notes_read == ['/note/menu/linkPaG/%d/items' % i for i in (201, 202, 203, 204, 209, 210, 211, 212)], notes_read)
        before = len(S['log'])
        await pg.click('[data-upc-check-ins] [data-a=refresh]')
        await pg.wait_for_function("!document.querySelector('[data-upc-check-ins] [data-a=refresh]').disabled", timeout=60000)
        again = [x[1] for x in S['log'][before:]]
        check('checking again reuses what was read (no notes re-read)', not [x for x in again if x.startswith('/note/')] and any(x.endswith('/calendar/json') for x in again), again)
        native = await pg.evaluate("document.querySelector('[data-upc-check-ins]').classList.contains('upc-native')")
        check('native look', native)
        check('no page errors', not errors, errors)
        await ctx.close()

        setup()
        S['user'] = 'Someone Else'
        ctx = await context(browser)
        pg = await ctx.new_page()
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/#upc-check-ins')
        await pg.wait_for_timeout(7000)
        check('others see nothing and nothing is asked of Halaxy', await pg.evaluate("!document.querySelector('[data-upc-check-ins]') && !document.querySelector('a.upc-ci-menu')")
              and not [x for x in S['log'] if 'calendar' in x[1]], S['log'])
        await ctx.close()
        await browser.close()
    print('\n%d failed' % len(FAILS) if FAILS else '\nAll passed')
    sys.exit(1 if FAILS else 0)

asyncio.run(main())
