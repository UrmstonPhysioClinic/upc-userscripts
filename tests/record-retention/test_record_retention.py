"""
Test for Record retention, against a mock Halaxy (invented patients). Clock: 22-Nov-2026.

Checks: the whole patient list is read in blocks; an adult last seen over 8 years ago is due, one seen since is not;
a child is kept until their 25th birthday, or 26th if 17 at the last appointment, when that is later; no date of
birth, Deceased and never-seen patients have their own cards; booked, Deleted and Contact records are left out; dates
read whichever way Halaxy writes them; ticking and "Set 2 to Deleted" asks once, then the Case Load report is read
once and both go to Halaxy in one Update patient status (with every practitioner pairing), then the Deleted patients
are read back; "Set all N to Deleted" on Due does the rest: a patient not in the Case Load report is changed on their
Edit page (every other field as Halaxy filled it), and one Halaxy didn't change shows Not changed; the batch bar and a
toast; only CH sees the page; Halaxy look.

Run:  python3 tests/record-retention/test_record_retention.py
"""
import asyncio, datetime, json, re, sys, urllib.parse
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
CORE = (ROOT / 'beta' / 'core.user.js').read_text().replace('perMinute: 45,', 'perMinute: 100000,')
SCRIPT = (ROOT / 'beta' / 'record-retention.user.js').read_text()
NOW = datetime.datetime(2026, 11, 22, 12, 0, tzinfo=datetime.timezone.utc)
FAILS = []
S = {}


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)[:600]))
    if not ok:
        FAILS.append(name)


def pt(i, given, status='Current', dob='', last='', nxt='', created='01/01/2014'):
    return {'id': i, 'givenName': given, 'surname': 'Test', 'preferredName': '', 'patientNum': str(i), 'status': status,
            'dateOfBirth': dob, 'lastAppointment': last, 'nextAppointment': nxt, 'created': created}


PATIENTS = [
    pt(101, 'Adult Old', dob='12/03/1980', last='01/05/2017 10:00'),                     # due
    pt(102, 'Adult Recent', dob='12/03/1980', last='01/01/2019 10:00'),                  # kept
    pt(103, 'Child Eleven', dob='01/06/2005', last='01/03/2017 10:00'),                  # 25th birthday 2030: kept
    pt(104, 'Teen Seventeen', status='Discharged', dob='01-Jun-1999', last='2016-07-01 09:30:00'),   # 26th birthday 01-Jun-2025: due
    pt(105, 'Child Ten', dob='2000-01-01', last='10-Jan-2010 14:00'),                    # 25th birthday 01-Jan-2025: due
    pt(106, 'No Birthday', dob='', last='01/02/2016 10:00'),                             # no date of birth
    pt(107, 'Late Patient', status='Deceased', dob='01/01/1930', last='01/02/2015 10:00'),
    pt(108, 'Never Seen', dob='01/01/1970', created='05/05/2015'),                       # never seen, made 2015
    pt(109, 'Never Recent', dob='01/01/1970', created='05/05/2021'),                     # never seen, made 2021: kept
    pt(110, 'Booked Ahead', dob='01/01/1970', last='01/02/2016 10:00', nxt='01/12/2026 10:00'),
    pt(111, 'Gone Already', status='Deleted', dob='01/01/1970', last='01/02/2016 10:00'),
    pt(112, 'Only Contact', status='Contact', dob='01/01/1970', last='01/02/2016 10:00'),
    pt(113, 'Adult Older', status='Claimant', dob='01/01/1960', last='03/03/2016 10:00'),  # due
] + [pt(1000 + i, 'Filler %03d' % i, dob='01/01/1990', last='01/01/2024 10:00') for i in range(150)]


# Case Load pairings (patient -> practitioner pairings); 113 is not in the report, Halaxy ignores 105's change.
CASELOAD = {101: [50101, 60101], 104: [50104], 105: [50105], 102: [50102]}
IGNORED = {105}


def edit_form(pid):
    st = S['status'].get(pid, next(p['status'] for p in PATIENTS if p['id'] == pid).lower())
    opts = ''.join("<option value='%s'%s>%s</option>" % (v, ' selected' if v == st else '', v.title()) for v in
                   ['current', 'deleted', 'archived', 'waiting list', 'deceased', 'review', 'claimant', 'discharged', 'blocked', 'contact'])
    return ("<html><body><form id='patientGeneralEditForm' method='post'><input name='patientdetailmain[name][forename]' value='Given'>"
            "<select name='patientdetailmain[linkPaG][customStatus]'>%s</select><input name='patientdetailmain[contactEmail]' value='a@example.com'>"
            "<input type='hidden' name='patientdetailmain[_token]' value='T'><button name='save_patient' value='1'>Save</button></form></body></html>") % opts


def page_html(user):
    return ("<!doctype html><html><head><title>Patient List | Halaxy</title></head><body style='margin:0 0 0 230px'>"
            "<div style='position:fixed;left:0;top:0;bottom:0;width:218px'><nav id='side'><ul id='mainMenu'>"
            "<li class='mainmenu-item active'><a class='mainmenu-link'><span class='mainmenu-link-label'>Patients</span></a>"
            "<ul><li class='active'><a class='mainmenu-sublink active' href='/a/pr/555/patient/'>Patient List</a></li></ul></li></ul></nav></div>"
            "<div id='headerWrapper' style='height:50px'></div><div id='pageContent'><h1>Patient List</h1></div>"
            "<script>window.HkUser = { linkPrG: 11, pracID: 11, pracName: %s };</script></body></html>") % json.dumps(user)


async def halaxy(route):
    req = route.request
    p = urllib.parse.urlparse(req.url).path
    if p.endswith('/patient/list-data') and req.method == 'POST':
        b = json.loads(req.post_data or '{}')
        S['lists'].append((b['startRow'], b['endRow']))
        # Halaxy leaves Deleted patients out of the list, whatever the filter (live, 23 Nov 2026).
        allp = [dict(x, status=S['status'].get(x['id'], x['status'].lower())) for x in PATIENTS]
        allp = [x for x in allp if x['status'].lower() != 'deleted']
        if b.get('filterModel', {}).get('status'):
            S['filtered'] += 1
        rows = allp[b['startRow']:b['endRow']]
        return await route.fulfill(body=json.dumps({'rowData': rows, 'lastRow': len(allp)}), content_type='application/json')
    if p.endswith('/report/patient/0') and urllib.parse.parse_qs(urllib.parse.urlparse(req.url).query).get('type') == ['12']:
        q = urllib.parse.parse_qs(urllib.parse.urlparse(req.url).query)
        S['deletedReads'].append(q.get('patientStatusMulti', [''])[0])
        gone = [x for x in PATIENTS if S['status'].get(x['id'], x['status'].lower()) == 'deleted']
        body = ''.join("<tr><td><a href='/a/pr/555/patient/%d'>%s</a></td><td>17-Aug-2015</td><td></td><td></td><td></td><td>Deleted</td></tr>" % (x['id'], x['givenName']) for x in gone)
        return await route.fulfill(body="<html><body><table class='table'><thead><tr><th>Patient</th><th>Created</th><th>Introduction Source</th><th>Phone</th><th>Email</th><th>Status</th></tr></thead><tbody>%s</tbody></table></body></html>" % body, content_type='text/html')
    if p.endswith('/report/patient/0'):
        S['caseloads'] += 1
        rows = ''.join("<tr><td><div class='custom-control custom-checkbox'><input type='checkbox' class='custom-control-input' name='link-pr-pa-g' value='%d'></div></td>"
                       "<td><a href='/a/pr/555/patient/%d'>Patient</a></td><td>Current</td></tr>" % (lp, pid) for pid, lps in CASELOAD.items() for lp in lps)
        return await route.fulfill(body="<html><body><table class='table'><thead><tr><th><input type='checkbox' class='custom-control-input'></th><th>Patient</th></tr></thead><tbody>"
                                   "<tr><td colspan='3'>Carl Healy</td></tr>%s</tbody></table></body></html>" % rows, content_type='text/html')
    if p.endswith('/patient/bulk-update-status/LinkPaG'):
        if req.method == 'GET':
            ids = urllib.parse.parse_qs(urllib.parse.urlparse(req.url).query).get('linkPrPaGs[]', [])
            opts = ''.join("<option value='%s' selected>%s</option>" % (x, x) for x in ids)
            st = ''.join("<option value='%s'>%s</option>" % (v, v.title()) for v in ['', 'current', 'deleted', 'archived', 'deceased', 'discharged'])
            return await route.fulfill(body=json.dumps({'status': 'FORM', 'message': "<form id='patient-bulk-update' method='post'><input type='hidden' name='form[_token]' value='B'>"
                                                        "<select name='form[patientStatus]'>%s</select><select name='form[linkPrPaGs][]' multiple>%s</select><button>Save</button></form>" % (st, opts)}), content_type='application/json')
        f = urllib.parse.parse_qs(req.post_data or '')
        S['bulk'].append((f.get('form[patientStatus]', [''])[0], sorted(f.get('form[linkPrPaGs][]', [])), f.get('form[_token]', [''])[0]))
        await asyncio.sleep(0.5)
        for lp in f.get('form[linkPrPaGs][]', []):
            pid = next(k for k, v in CASELOAD.items() if int(lp) in v)
            if pid not in IGNORED:
                S['status'][pid] = f['form[patientStatus]'][0]
        return await route.fulfill(body=json.dumps({'status': 'REFRESH'}), content_type='application/json')
    m = re.search(r'/patient/(\d+)/edit$', p)
    if m:
        pid = int(m.group(1))
        if req.method == 'POST':
            f = dict(urllib.parse.parse_qsl(req.post_data or '', keep_blank_values=True))
            S['posts'].append((pid, f))
            await asyncio.sleep(0.6)
            S['status'][pid] = f.get('patientdetailmain[linkPaG][customStatus]', '')
            return await route.fulfill(body='<html><body>saved</body></html>', content_type='text/html')
        return await route.fulfill(body=edit_form(pid), content_type='text/html')
    await route.fulfill(body=page_html(S['user']), content_type='text/html')


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        S.update({'lists': [], 'posts': [], 'status': {}, 'bulk': [], 'caseloads': 0, 'filtered': 0, 'deletedReads': [], 'user': 'Carl Healy'})
        ctx = await browser.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/London')
        await ctx.clock.install(time=NOW.isoformat())
        await ctx.route('https://eu.halaxy.com/**', halaxy)
        await ctx.add_init_script(CORE)
        await ctx.add_init_script("document.addEventListener('DOMContentLoaded', function () {\n" + SCRIPT + "\n});")
        pg = await ctx.new_page()
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/')
        await pg.wait_for_selector('a.upc-rr8-menu', timeout=20000)
        await pg.click('a.upc-rr8-menu')
        await pg.wait_for_selector('[data-upc-record-retention] .card', timeout=20000)
        cards = await pg.evaluate("[...document.querySelectorAll('[data-upc-record-retention] .card')].map((c) => [c.querySelector('h2').textContent, [...c.querySelectorAll('tbody tr')].map((tr) => [...tr.cells].map((x) => x.textContent.trim()))])")
        cd = dict(cards)
        check('the whole patient list read in blocks', S['lists'] == [(0, 100), (100, 200)], S['lists'])
        due = cd.get('Due (4)', [])
        check('due: adults last seen over 8 years ago, a child past their 25th birthday, a 17-year-old past their 26th (oldest first)',
              [r[1] for r in due] == ['Child Ten Test', 'Adult Older Test', 'Teen Seventeen Test', 'Adult Old Test'], cards)
        teen = next((r for r in due if r[1] == 'Teen Seventeen Test'), [])
        check('a row: status, date of birth, last appointment, kept until (dates as Halaxy writes them, whichever way they came)',
              teen[2:6] == ['Discharged', '01-Jun-1999', '01-Jul-2016', '01-Jun-2025'], teen)
        check('kept: seen within 8 years, a child not yet 25, booked ahead, Deleted and Contact records',
              not any(n in json.dumps(cards) for n in ['Adult Recent', 'Child Eleven', 'Booked Ahead', 'Gone Already', 'Only Contact', 'Never Recent', 'Filler']), list(cd))
        check('own cards: no date of birth, Deceased, never seen', [r[1] for r in cd.get('No Date of Birth (1)', [])] == ['No Birthday Test']
              and [r[1] for r in cd.get('Deceased (1)', [])] == ['Late Patient Test'] and [r[1] for r in cd.get('No appointments (1)', [])] == ['Never Seen Test'], list(cd))
        line = await pg.evaluate("[...document.querySelectorAll('[data-upc-record-retention] p.text-muted')].pop().textContent")
        check('the line under the list gives the range', line == "Last appointment before 22-Nov-2018; children's records until their 25th or 26th birthday. Booked patients left out.", line)
        bar = await pg.evaluate("(() => { const b = document.querySelector('[data-upc-record-retention] .upc-page-bar'); return b && [b.querySelector('h1').textContent, b.querySelector('.upc-page-actions .btn').textContent]; })()")
        check('title bar: title left, Check now right', bar == ['Record Retention', 'Check Now'], bar)
        check('nothing changed without asking', not S['posts'], S['posts'])

        allbtn = await pg.evaluate("(document.querySelector('[data-upc-bulk-for=due]') || {}).textContent")
        check('nothing ticked: "Set all 4 to Deleted" on Due', allbtn == 'Set all 4 to Deleted', allbtn)
        await pg.check("[data-upc-list=due] tr[data-upc-id='101'] input[data-upc-tick]")
        await pg.check("[data-upc-list=due] tr[data-upc-id='104'] input[data-upc-tick]")
        tick = await pg.evaluate("(document.querySelector('[data-upc-bulk-for=due]') || {}).textContent")
        check('ticked rows: "Set 2 to Deleted" in the tool row', tick == '2 tickedSet 2 to Deleted', tick)
        await pg.click('[data-a=bulk][data-list=due]')
        await pg.wait_for_selector('[data-upc-ret-confirm]')
        conf = await pg.evaluate("document.querySelector('[data-upc-ret-confirm]').innerText")
        check('asks once: how many and who', 'Set 2 patients to Deleted?' in conf and 'Teen Seventeen Test' in conf and 'Adult Old Test' in conf and not S['bulk'], conf)
        await pg.click('[data-upc-ret-confirm] [data-c=yes]')
        await pg.wait_for_timeout(300)
        bq = await pg.evaluate("(document.querySelector('[data-upc-record-retention] .upc-page-sub .upc-batch') || {}).textContent")
        check('the batch bar in the line under the title bar', bool(bq) and bq.startswith('Setting to Deleted ('), bq)
        await pg.wait_for_function("[...document.querySelectorAll('[data-upc-record-retention] tbody tr .upc-ok')].length === 2", timeout=30000)
        check('one Update patient status for both, with every practitioner pairing; the Case Load report read once', S['bulk'] == [('deleted', ['50101', '50104', '60101'], 'B')] and S['caseloads'] == 1 and not S['posts'], (S['bulk'], S['caseloads']))
        check('then the Deleted patients read from the Introduction Source report (the patient list leaves them out)', S['deletedReads'] == ['deleted'] and S['lists'] == [(0, 100), (100, 200)], (S['deletedReads'], S['lists']))
        await pg.wait_for_function("document.querySelector('.upc-toast')", timeout=10000)
        msg = await pg.evaluate("document.querySelector('.upc-toast').textContent")
        check('a toast when the batch is over', msg == '2 set to Deleted.', msg)
        await pg.evaluate("document.querySelectorAll('.upc-toast').forEach((t) => t.remove())")

        allbtn = await pg.evaluate("(document.querySelector('[data-upc-bulk-for=due]') || {}).textContent")
        check('"Set all" now counts only those left', allbtn == 'Set all 2 to Deleted', allbtn)
        await pg.click('[data-a=all][data-list=due]')
        await pg.wait_for_selector('[data-upc-ret-confirm]')
        conf = await pg.evaluate("document.querySelector('[data-upc-ret-confirm]').innerText")
        check('Set all asks once too', 'Set 2 patients to Deleted?' in conf, conf)
        await pg.click('[data-upc-ret-confirm] [data-c=yes]')
        await pg.wait_for_function("[...document.querySelectorAll('[data-upc-record-retention] tbody tr')].filter((tr) => /Deleted|Not changed/.test(tr.cells[6].textContent)).length === 4", timeout=30000)
        res = await pg.evaluate("Object.fromEntries([...document.querySelectorAll('[data-upc-list=due] tbody tr')].map((tr) => [tr.dataset.upcId, tr.cells[6].textContent.trim()]))")
        check('a patient not in the Case Load report: changed on their Edit page; one Halaxy did not change: Not changed',
              res.get('113') == 'Deleted' and res.get('105') == 'Not changed' and [x[0] for x in S['posts']] == [113] and S['bulk'][1][1] == ['50105'] and S['caseloads'] == 1, (res, S['posts'], S['bulk']))
        errs = await pg.evaluate("[...document.querySelectorAll('[data-upc-record-retention] .alert-danger')].map((x) => x.textContent)")
        check('said above the list', errs == ['Not changed: 1 patient (Halaxy still shows the old status). Check now lists them again.'], errs)
        await pg.wait_for_function("document.querySelector('.upc-toast')", timeout=10000)
        msg = await pg.evaluate("document.querySelector('.upc-toast').textContent")
        check('the toast says how it went', msg == '1 set to Deleted. 1 not changed.', msg)
        check('the Edit page change: other fields as Halaxy filled them', all(x[1].get('patientdetailmain[linkPaG][customStatus]') == 'deleted' and x[1].get('patientdetailmain[_token]') == 'T'
                                                                                and x[1].get('patientdetailmain[contactEmail]') == 'a@example.com' for x in S['posts']), S['posts'])
        look = await pg.evaluate("(() => { const r = document.querySelector('[data-upc-record-retention]'); return r.classList.contains('upc-native') && !r.shadowRoot && r.querySelector('table').className.startsWith('table table-striped table-bordered'); })()")
        check('Halaxy look', look)
        check('no page errors', not errors, errors)
        await ctx.close()

        S.update({'lists': [], 'user': 'Physio One'})
        ctx = await browser.new_context(timezone_id='Europe/London')
        await ctx.route('https://eu.halaxy.com/**', halaxy)
        await ctx.add_init_script(CORE)
        await ctx.add_init_script("document.addEventListener('DOMContentLoaded', function () {\n" + SCRIPT + "\n});")
        pg = await ctx.new_page()
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/#upc-record-retention')
        await pg.wait_for_timeout(3000)
        check('someone else: no menu item, no page, nothing read', not await pg.evaluate("!!document.querySelector('a.upc-rr8-menu, [data-upc-record-retention]')") and not S['lists'])
        await browser.close()
    print('\n' + ('All passed' if not FAILS else '%d failed' % len(FAILS)))
    sys.exit(1 if FAILS else 0)


asyncio.run(main())
