"""
Test for Patient statuses and core's UPC.patient.setStatus, against a mock Halaxy (calendar, invoices with or without
a claim box, notes, the patient Edit page with patientdetailmain[linkPaG][customStatus] as captured 11 Nov 2026).
Invented patients only.

Run:  python3 tests/patient-statuses/test_patient_statuses.py
"""
import asyncio, datetime, json, re, sys, urllib.parse
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
CORE = (ROOT / 'beta' / 'core.user.js').read_text()
PS = (ROOT / 'beta' / 'patient-statuses.user.js').read_text()
MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
hx = lambda d: '%02d-%s-%d' % (d.day, MON[d.month - 1], d.year)
NOW = datetime.datetime(2026, 11, 11, 12, 0, tzinfo=datetime.timezone.utc)
at = lambda n: (NOW + datetime.timedelta(days=n)).date()
FAILS = []
S = {}
STATUSES = ['', 'current', 'deleted', 'archived', 'waiting list', 'deceased', 'review', 'claimant', 'discharged', 'blocked', 'contact']


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)))
    if not ok:
        FAILS.append(name)


def setup():
    S.clear()
    S.update({'patients': {}, 'events': [], 'invoices': {}, 'log': [], 'writes': [], 'user': 'Carl Healy', 'next': 5000})

    def patient(pid, name, status, appts, notes=(), cal_status=True):
        items = []
        for n, text in notes:
            S['next'] += 1
            items.append({'id': str(S['next']), 'category': 'appointment', 'entity': 'note', 'label': 'Appointment', 'date': hx(at(n)), 'text': text})
        S['patients'][pid] = {'name': name, 'status': status, 'items': items}
        for n, st, funded in appts:
            S['next'] += 1
            S['invoices'][S['next']] = {'pid': pid, 'funded': funded}
            S['events'].append({'id': len(S['events']) + 1, 'type': 'appointment', 'linkPaGId': pid, 'title': name, 'appointmentStatus': st,
                                'invoiceID': S['next'], 'patientStatus': status.title() if cal_status else '',
                                'start': int((NOW + datetime.timedelta(days=n)).replace(hour=10).timestamp())})

    patient(301, 'Patient A', 'current', [(-60, '', False)])                                   # 8 weeks quiet -> Discharged
    patient(302, 'Patient B', 'claimant', [(-20, '', True)], [(-20, 'Goals met. Discharged.')])  # note says finished -> Discharged
    patient(303, 'Patient C', 'current', [(-10, '', True), (7, '', True)])                     # booked, funded -> Claimant
    patient(304, 'Patient D', 'discharged', [(-200, '', False), (5, '', False)])               # discharged, booked again, self-funded -> Current
    patient(305, 'Patient E', 'claimant', [(-10, '', True), (14, '', True)])                   # right already
    patient(306, 'Patient F', 'review', [(-90, '', True)])                                     # Review: left alone
    patient(307, 'Patient G', 'current', [(-15, '', False)], [(-15, 'Open return, see how things go.')])  # open-ended, under 6 weeks: stays Current
    patient(308, 'Patient H', 'claimant', [(-15, '', False)], [(-15, 'Progressing well, continue exercises.')])  # self-funded fee -> Current
    patient(309, 'Patient I', 'current', [(-12, '', False)], [(-12, 'Not discharged yet, review in 2 weeks.')])  # negated: stays Current
    patient(310, 'Patient J', 'archived', [(-100, '', False)])                                 # Archived: left alone
    patient(311, 'Patient K', 'current', [(-50, '', False)], cal_status=False)                 # status not on the calendar: read from details
    patient(312, 'Patient L', 'contact', [(9, '', 'fee')])                                     # Contact booked online, funded fee, no claim yet -> Claimant
    patient(313, 'Patient M', 'contact', [])                                                   # just a contact: no appointments, left alone


def page_html(user):
    return ("<!doctype html><html><head><title>Patients | Halaxy</title></head><body style='margin:0 0 0 230px'>"
            "<div style='position:fixed;left:0;top:0;bottom:0;width:218px'><nav id='side'><ul id='mainMenu'>"
            "<li class='mainmenu-item active'><a class='mainmenu-link'><span class='mainmenu-link-label'>Patients</span></a>"
            "<ul><li class='active'><a class='mainmenu-sublink active' href='/a/pr/555/patient/'>Patient List</a></li></ul></li></ul></nav></div>"
            "<div id='headerWrapper' style='height:50px'></div><h1>Patients</h1>"
            "<script>window.HkUser = { linkPrG: 11, pracID: 11, pracName: %s };</script></body></html>") % json.dumps(user)


def edit_page(pid):
    p = S['patients'][pid]
    opts = ''.join("<option value='%s'%s>%s</option>" % (v, ' selected' if v == p['status'] else '', v.title()) for v in STATUSES)
    return ("<html><body><form id='patientGeneralEditForm' method='post'><input type='hidden' name='save_patient' value='1'>"
            "<input name='patientdetailmain[name][forename]' value='%s'><select name='patientdetailmain[linkPaG][customStatus]'>%s</select>"
            "<textarea name='patientdetailmain[linkPaG][note]'>Likes mornings</textarea><input type='hidden' name='patientdetailmain[_token]' value='ET'>"
            "<button class='btn btn-primary btn-submit'>Save</button></form></body></html>" % (p['name'], opts))


def invoice_html(iid):
    inv = S['invoices'][iid]
    claim = ("<div id='card-invoice-parts-claim-view'><a href='/a/pr/555/organisation/1'>Bupa</a>"
             "<a id='editClaimButton' href='/a/pr/555/patient/claim/1/%d/77/edit?invoice=%d'>Edit</a></div>" % (inv['pid'], iid)) if inv['funded'] is True else ''
    item = 'Bup-IA (AA360)' if inv['funded'] else 'IA-IA'
    line = ("<tr><td data-property='date'>01-Nov-2026</td><td data-property='itemNumber'>%s</td><td data-property='description'>Fee</td>"
            "<td data-property='amount' class='money number'>£40.00</td><td><a href='/a/pr/555/invoice/line/%d/edit'>e</a></td></tr>" % (item, iid + 90000))
    return ("<html><head><title>Invoice UPC-%d | Halaxy</title></head><body><div id='card-invoice-view-patient'><a href='/a/pr/555/patient/%d'>P</a></div>%s"
            "<table id='invoiceLines'><tbody>%s</tbody></table></body></html>" % (iid, inv['pid'], claim, line))


async def halaxy(route):
    req = route.request
    u = urllib.parse.urlparse(req.url)
    p = u.path
    S['log'].append((req.method, re.sub(r'^/a/pr/555', '', p)))
    js = lambda o: route.fulfill(body=json.dumps(o), content_type='application/json')
    if p.endswith('/lookup/practitioner'):
        return await js([{'id': 11}])
    if p.endswith('/funder/fee/data'):
        return await js([{'feeNumber': 'Bup-IA (AA360)', 'funder': 'Bupa', 'status': 'Current'}, {'feeNumber': 'IA-IA', 'funder': 'Self-Funded', 'status': 'Current'}])
    if p.endswith('/calendar/json'):
        q = urllib.parse.parse_qs(u.query)
        lo, hi = int(q['start'][0]), int(q['end'][0])
        return await js({'payload': {'events': [e for e in S['events'] if lo <= e['start'] < hi]}})
    m = re.search(r'/note/menu/linkPaG/(\d+)/items$', p)
    if m:
        return await js({'payload': {'menuItems': [{k: v for k, v in it.items() if k != 'text'} for it in S['patients'][int(m.group(1))]['items']]}})
    m = re.search(r'/note/(\d+)$', p)
    if m:
        it = next(i for pt in S['patients'].values() for i in pt['items'] if i['id'] == m.group(1))
        return await js({'id': int(m.group(1)), 'content': '<p>%s</p>' % it['text'], 'final': '', 'contentQuestions': ''})
    m = re.search(r'/note/sidebar/linkPaG/(\d+)$', p)
    if m:
        pt = S['patients'][int(m.group(1))]
        return await js({'patientDetails': {'fullName': pt['name'], 'status': pt['status'].title(), 'userLabels': []}})
    m = re.search(r'/invoice/(\d+)$', p)
    if m and int(m.group(1)) in S['invoices']:
        return await route.fulfill(body=invoice_html(int(m.group(1))), content_type='text/html')
    m = re.search(r'/patient/(\d+)/edit$', p)
    if m:
        pid = int(m.group(1))
        if req.method == 'POST':
            f = urllib.parse.parse_qs(req.post_data, keep_blank_values=True)
            S['writes'].append((pid, f))
            S['patients'][pid]['status'] = f['patientdetailmain[linkPaG][customStatus]'][0]
            return await route.fulfill(body=edit_page(pid), content_type='text/html')
        return await route.fulfill(body=edit_page(pid), content_type='text/html')
    if p.startswith('/a/pr/555/'):
        return await route.fulfill(body=page_html(S['user']), content_type='text/html')
    await route.fulfill(status=404, body='not mocked')


async def context(browser):
    ctx = await browser.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/London')
    await ctx.clock.install(time=NOW.isoformat())
    await ctx.route('https://eu.halaxy.com/**', halaxy)
    await ctx.add_init_script(CORE)
    await ctx.add_init_script("document.addEventListener('DOMContentLoaded', function () {\n" + PS + "\n});")
    return ctx

ROWS = "[...document.querySelectorAll('[data-upc-patient-statuses] tbody tr')].map((tr) => [...tr.cells].map((c) => c.textContent.trim()))"


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        setup()
        ctx = await context(browser)
        pg = await ctx.new_page()
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/#upc-patient-statuses')
        await pg.wait_for_function("document.querySelector('[data-upc-patient-statuses] table') && !document.querySelector('[data-upc-patient-statuses] [data-a=refresh]').disabled", timeout=90000)
        rows = await pg.evaluate(ROWS)
        by = {r[0]: r for r in rows}
        check('8 weeks without an appointment, nothing booked: Discharged', by.get('Patient A', [''] * 3)[1:3] == ['Current', 'Discharged'] and 'No appointment for 8 weeks' in by['Patient A'][3], by.get('Patient A'))
        check('last note says finished, nothing booked: Discharged', by.get('Patient B', [''] * 3)[2] == 'Discharged' and 'goals met' in by['Patient B'][3], by.get('Patient B'))
        check('booked with a funded fee: Claimant', by.get('Patient C', [''] * 3)[2] == 'Claimant', by.get('Patient C'))
        check('discharged patient booked again, self-funded: Current', by.get('Patient D', [''] * 3)[1:3] == ['Discharged', 'Current'], by.get('Patient D'))
        check('self-funded last fee, still going: Current', by.get('Patient H', [''] * 3)[1:3] == ['Claimant', 'Current'], by.get('Patient H'))
        check('status not on the calendar: read from the patient\'s details', by.get('Patient K', [''] * 3)[2] == 'Discharged', by.get('Patient K'))
        check('Contact booked online with a funded fee (no claim yet): Claimant, saying why', by.get('Patient L', [''] * 4)[1:3] == ['Contact', 'Claimant']
              and 'Contact with an appointment' in by['Patient L'][3] and 'funded fee' in by['Patient L'][3], by.get('Patient L'))
        check('a Contact with no appointments is left alone', 'Patient M' not in by, list(by))
        check('left alone: already right, Review, Archived, open-ended under 6 weeks, "not discharged yet"',
              not any(n in by for n in ['Patient E', 'Patient F', 'Patient G', 'Patient I', 'Patient J']), list(by))
        check('nothing changed before asking', not S['writes'], S['writes'])
        badge = await pg.evaluate("(document.querySelector('a.upc-ps-menu .upc-ps-badge') || {}).textContent")
        check('menu item under Patients with the count', badge == str(len(rows)), (badge, len(rows)))
        # Change one: asks first, then only the status changes
        await pg.click("[data-upc-patient-statuses] [data-change='301']")
        await pg.wait_for_selector('[data-upc-ps-confirm]')
        conf = await pg.evaluate("document.querySelector('[data-upc-ps-confirm]').innerText")
        check('Change asks first, naming the patient and the new status', 'Change Patient A from Current to Discharged' in conf and not S['writes'], conf)
        await pg.click('[data-upc-ps-confirm] [data-c=yes]')
        await pg.wait_for_function("[...document.querySelectorAll('[data-upc-patient-statuses] .upc-ok')].length === 1", timeout=60000)
        w = S['writes'][-1] if S['writes'] else (None, {})
        check('status sent with every other field as Halaxy filled it', w[0] == 301 and w[1].get('patientdetailmain[linkPaG][customStatus]') == ['discharged']
              and w[1].get('patientdetailmain[name][forename]') == ['Patient A'] and w[1].get('patientdetailmain[linkPaG][note]') == ['Likes mornings']
              and w[1].get('patientdetailmain[_token]') == ['ET'] and w[1].get('save_patient') == ['1'], w)
        # Someone changed a status meanwhile: left alone
        S['patients'][302]['status'] = 'review'
        await pg.click('[data-upc-patient-statuses] [data-a=all]')
        await pg.wait_for_selector('[data-upc-ps-confirm]')
        conf = await pg.evaluate("document.querySelector('[data-upc-ps-confirm]').innerText")
        await pg.click('[data-upc-ps-confirm] [data-c=yes]')
        await pg.wait_for_function("!document.querySelector('[data-upc-patient-statuses] [data-a=all]') || !document.querySelector('[data-upc-patient-statuses] [data-a=all]').disabled", timeout=90000)
        final = {pid: S['patients'][pid]['status'] for pid in (301, 302, 303, 304, 308, 311, 312, 313)}
        check('Change all: asks first with the numbers, then changes the rest', 'Change' in conf and final == {301: 'discharged', 302: 'review', 303: 'claimant', 304: 'current', 308: 'current', 311: 'discharged', 312: 'claimant', 313: 'contact'}, (conf, final))
        txt = await pg.evaluate("document.querySelector('[data-upc-patient-statuses]').innerText")
        check('the one changed meanwhile says why it was left', 'The status is now review, not claimant, so it was left alone' in txt, txt[:500])
        check('no page errors', not errors, errors)
        await ctx.close()

        setup()
        S['user'] = 'Someone Else'
        ctx = await context(browser)
        pg = await ctx.new_page()
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/#upc-patient-statuses')
        await pg.wait_for_timeout(8000)
        check('others see nothing and nothing is asked of Halaxy', await pg.evaluate("!document.querySelector('[data-upc-patient-statuses]') && !document.querySelector('a.upc-ps-menu')")
              and not [x for x in S['log'] if 'calendar' in x[1]], S['log'])
        await ctx.close()
        await browser.close()
    print('\n%d failed' % len(FAILS) if FAILS else '\nAll passed')
    sys.exit(1 if FAILS else 0)

asyncio.run(main())
