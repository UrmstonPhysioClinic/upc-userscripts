"""
Test for Missing details against a mock Halaxy (calendar, practitioner list, patient Edit pages in the shape captured on
15 Nov 2026). Invented patients only.

Checks: mandatory details (first and last name, date of birth, an address with a postcode, a phone number) read from
the Edit page; email mentioned but not counted; who is checked (booked in the next 14 days or seen in the last 30, not
cancelled, not deleted); the list for Carl and Wendy, soonest appointment first, with the practitioner; the menu count;
the banner on every page of a patient for everyone, whether booked or not, gone once the details are saved; complete
patients not read again; the ids kept for Calendar controls; nothing saved to Halaxy except the shared note.

Shared between PCs (UPC.shared, Admin Note on organisation 78842): the first PC claims and checks, and notes what it found
(ids and codes, no names); a second PC (its own storage) takes that and reads no Edit pages; a patient another PC is
checking is left alone; a damaged line is dropped when the note is next saved; a patient read on their own page is noted
when the outcome differs from the note.

Run:  python3 tests/missing-details/test_missing_details.py
"""
import asyncio, datetime, json, re, sys, urllib.parse
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
CORE = (ROOT / 'beta' / 'core.user.js').read_text().replace('perMinute: 45,', 'perMinute: 100000,')   # tests: no 45-a-minute wait (the 300 ms gap stays)
MD = (ROOT / 'beta' / 'missing-details.user.js').read_text()
NOW = datetime.datetime(2026, 11, 16, 9, 0, tzinfo=datetime.timezone.utc)
FAILS = []
S = {}


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)))
    if not ok:
        FAILS.append(name)


def setup(user='Carl Healy', notes=None):
    S.clear()
    S.update({'patients': {}, 'events': [], 'log': [], 'user': user, 'notes': notes if notes is not None else {}})

    def patient(pid, name, appts, status='current', first=None, last=None, dob=True, line1='1 Test Street', postcode='M41 0AA', phone='0161 000 0000', email='a@b.c'):
        S['patients'][pid] = {'name': name, 'status': status, 'first': name.split()[0] if first is None else first, 'last': name.split()[1] if last is None else last, 'dob': dob, 'line1': line1, 'postcode': postcode, 'phone': phone, 'email': email}
        for n, st, prac in appts:
            S['events'].append({'id': len(S['events']) + 1, 'type': 'appointment', 'linkPaGId': pid, 'title': name, 'appointmentStatus': st, 'practitionerID': prac,
                                'start': int((NOW + datetime.timedelta(days=n)).replace(hour=10).timestamp())})

    patient(301, 'Patient A', [(3, '', 11)])                                         # complete, booked
    patient(302, 'Patient B', [(-20, '', 11), (2, '', 12)], dob=False, phone='')     # no date of birth or phone, booked in 2 days
    patient(303, 'Patient C', [(-10, '', 11)], postcode='')                          # address without a postcode, seen 10 days ago
    patient(304, 'Patient D', [(5, '', 11)], email='')                               # only the email missing
    patient(305, 'Patient E', [(-60, '', 11)], phone='12')                           # outside the window, a phone number too short
    patient(306, 'Patient F', [(1, '', 11)], status='deleted', dob=False, phone='')   # Deleted: never listed
    patient(307, 'Patient G', [(4, 'cancelled', 11)], phone='')                      # only a cancelled appointment
    patient(308, 'Patient H', [(6, '', 12)], first='', last='')                      # no name


def edit_form(pid):
    p = S['patients'][pid]
    sel = lambda n, v: "<select name='patientdetailmain[dob][%s]'><option value=''></option><option value='%s' %s>x</option></select>" % (n, v, 'selected' if p['dob'] else '')
    return ("<form id='patientGeneralEditForm' name='patientdetailmain'>"
            "<input name='patientdetailmain[name][forename]' value='%s'><input name='patientdetailmain[name][surname]' value='%s'>"
            "<input type='email' name='patientdetailmain[contactEmail]' value='%s'>%s%s%s"
            "<select name='patientdetailmain[linkPaG][customStatus]'><option value='%s' selected>x</option></select>"
            "<select name='patientdetailmain[linkPaG][linkpagaddresses][0][address][addressType]'><option value='1' selected>Home</option></select>"
            "<input name='patientdetailmain[linkPaG][linkpagaddresses][0][address][firstline]' value='%s'>"
            "<input name='patientdetailmain[linkPaG][linkpagaddresses][0][address][postcode]' value='%s'>"
            "<input name='patientdetailmain[linkPaG][linkphonepas][0][phone][number]' value='%s'>"
            "<input type='checkbox' name='patientdetailmain[linkPaG][linkphonepas][0][main]' checked>"
            "<input type='hidden' name='patientdetailmain[_token]' value='t'></form>") % (
        p['first'], p['last'], p['email'], sel('day', '1'), sel('month', '2'), sel('year', '1980'), p['status'], p['line1'], p['postcode'], p['phone'])


def page_html(user, body=''):
    return ("<!doctype html><html><head><title>Patients | Halaxy</title></head><body style='margin:0 0 0 230px'>"
            "<div style='position:fixed;left:0;top:0;bottom:0;width:218px'><nav id='side'><ul id='mainMenu'>"
            "<li class='mainmenu-item active'><a class='mainmenu-link'><span class='mainmenu-link-label'>Patients</span></a>"
            "<ul><li class='active'><a class='mainmenu-sublink active' href='/a/pr/555/patient/'>Patient List</a></li></ul></li></ul></nav></div>"
            "<div id='headerWrapper' style='height:50px'></div><div id='toolbar-wrapper'></div><div id='pageContent'><h1>Patient</h1>%s</div>"
            "<script>window.HkUser = { linkPrG: 11, pracID: 11, pracName: %s };</script></body></html>") % (body, json.dumps(user))


async def halaxy(route):
    req = route.request
    u = urllib.parse.urlparse(req.url)
    p = u.path
    S['log'].append((req.method, re.sub(r'^/a/pr/555', '', p)))
    js = lambda o: route.fulfill(body=json.dumps(o), content_type='application/json')
    if p.endswith('/lookup/practitioner'):
        return await js([{'id': 11, 'name': 'Physio One'}, {'id': 12, 'name': 'Physio Two'}])
    if p.endswith('/calendar/json'):
        q = urllib.parse.parse_qs(u.query)
        lo, hi = int(q['start'][0]), int(q['end'][0])
        return await js({'payload': {'events': [e for e in S['events'] if lo <= e['start'] < hi]}})
    # Admin Notes (capture 14 Nov 2026): list-data with the whole text, Add and Edit pop-ups (form#adminNoteForm)
    notes = S['notes']
    m = re.match(r'^/a/pr/555/communication-log/organisation/(\d+)/list-data$', p)
    if m:
        return await js({'data': [{'id': n['id'], 'date': '2026-11-15 10:00:00', 'privacy': 'All', 'creator': S['user'], 'isImportant': False, 'content': n['html']}
                                  for n in reversed(notes.get(int(m.group(1)), []))]})
    m = re.match(r'^/a/pr/555/communication-log/organisation/(\d+)/(new|(\d+)/edit)$', p)
    if m:
        org = int(m.group(1))
        if req.method == 'GET':
            old = next((n for n in notes.get(org, []) if str(n['id']) == m.group(3)), None)
            return await js({'status': 'FORM', 'title': 'Add Admin Note', 'message': "<form id='adminNoteForm'><input type='hidden' name='form[_token]' value='tn'>"
                             "<select name='form[privacy]'><option value='3' selected>All</option></select><textarea name='form[logContent]'>%s</textarea></form>" % (old['html'] if old else '')})
        g = dict(urllib.parse.parse_qsl(req.post_data or '', keep_blank_values=True))
        html = g['form[logContent]'].replace('<p>', '<p class="ck-text">')
        if m.group(3):
            next(n for n in notes[org] if str(n['id']) == m.group(3))['html'] = html
        else:
            notes.setdefault(org, []).append({'id': 33000 + sum(len(v) for v in notes.values()), 'html': html})
        return await js({'status': 'CLOSE', 'url': '/a/pr/555/communication-log'})
    m = re.match(r'^/a/pr/555/patient/(\d+)/edit$', p)
    if m:
        return await route.fulfill(body=page_html(S['user'], edit_form(int(m.group(1)))), content_type='text/html')
    if p.startswith('/a/pr/555/'):
        return await route.fulfill(body=page_html(S['user']), content_type='text/html')
    await route.fulfill(status=404, body='not mocked')


async def context(browser):
    ctx = await browser.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/London')
    await ctx.clock.install(time=NOW.isoformat())
    await ctx.route('https://eu.halaxy.com/**', halaxy)
    await ctx.add_init_script(CORE)
    await ctx.add_init_script("document.addEventListener('DOMContentLoaded', function () {\n" + MD + "\n});")
    return ctx

ROWS = "[...document.querySelectorAll('[data-upc-missing-details] .card')].map((c) => [c.querySelector('h2').textContent, [...c.querySelectorAll('tbody tr')].map((tr) => [...tr.cells].map((x) => x.textContent.trim()))])"
BANNER = "(document.querySelector('#pageContent > .upc-md-banner') || {}).textContent || ''"
edits = lambda pid: len([x for x in S['log'] if x == ('GET', '/patient/%d/edit' % pid)])


def note_text(notes=None):
    ns = (notes if notes is not None else S['notes']).get(78842, [])
    return [re.sub(r'<[^>]+>', '', x).replace('&#39;', "'").replace('&amp;', '&') for x in re.split(r'</p>', ns[-1]['html']) if x.strip()] if ns else []


def note_lines(notes=None):
    return {l.split(' | ')[0]: l.split(' | ')[2:] for l in note_text(notes)[2:]}


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        setup()
        ctx = await context(browser)
        pg = await ctx.new_page()
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.on('console', lambda m: print('CONSOLE', m.text[:300]) if m.type in ('warning', 'error') else None)
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/#upc-missing-details')
        await pg.wait_for_function("document.querySelector('[data-upc-missing-details] .card') && !document.querySelector('[data-upc-missing-details] [data-a=refresh]').disabled", timeout=90000)
        cards = await pg.evaluate(ROWS)
        need = cards[0][1] if cards else []
        names = [r[0] for r in need]
        check('missing mandatory details: soonest appointment first, then those seen recently', names == ['Patient B', 'Patient H', 'Patient C'], cards)
        by = {r[0]: r for r in need}
        check('what is missing, and the email as well where it is missing', by.get('Patient B', ['', ''])[1].startswith('date of birth, phone number') and by['Patient C'][1].startswith('address')
              and by['Patient H'][1].startswith('first name, last name'), need)
        check('next appointment with the practitioner, or last seen', '18-Nov-2026 10:00 with Physio Two' in by.get('Patient B', ['', '', ''])[2] and by.get('Patient C', ['', '', ''])[2] == 'last seen 06-Nov-2026', need)
        check('only the email missing: a separate list, not counted', len(cards) == 2 and cards[1][0] == 'No email address (1)' and [r[0] for r in cards[1][1]] == ['Patient D'], cards)
        check('left out: complete, outside the window, Deleted, only a cancelled appointment', not any(n in names for n in ['Patient A', 'Patient E', 'Patient F', 'Patient G']), names)
        link = await pg.evaluate("document.querySelector('[data-upc-missing-details] tbody tr td:nth-child(4) a').getAttribute('href')")
        check('links to the Edit page', link == '/a/pr/555/patient/302/edit', link)
        badge = await pg.evaluate("(document.querySelector('a.upc-md-menu .upc-md-badge') || {}).textContent")
        check('menu item under Patients with the count (not email)', badge == '3', badge)
        read = sorted({int(x[1].split('/')[2]) for x in S['log'] if x[1].endswith('/edit') and x[1].startswith('/patient/')})
        check('Edit pages read only for patients in the window', read == [301, 302, 303, 304, 306, 308], read)
        posts = [x for x in S['log'] if x[0] == 'POST']
        check('nothing saved except the shared note', posts and all(x[1].startswith('/communication-log/organisation/78842/') for x in posts), posts)
        txt = note_text()
        lines = note_lines()
        check('shared note: our heading, one line per patient checked, claims let go', txt[:1] == ['UPC shared checks: Missing details'] and sorted(lines) == ['301', '302', '303', '304', '306', '308']
              and all(len(v) == 1 for v in lines.values()), txt)
        check('shared note: codes only, no names', lines.get('302') == ['dob phone'] and lines.get('301') == ['ok'] and lines.get('304') == ['ok noemail'] and lines.get('306') == ['dob phone off']
              and lines.get('308') == ['first last'] and not any('Patient' in l for l in txt), txt)
        ids = await pg.evaluate("JSON.parse(localStorage.getItem('upc-md:ids') || '[]')")
        check('the patients with gaps kept for the calendar marker (not Deleted or complete)', sorted(ids) == ['302', '303', '308'], ids)

        # The banner: on every page of a patient with gaps, for everyone, booked or not
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/302/clinical/category/note/id/9')
        await pg.wait_for_function(BANNER, timeout=20000)
        text = await pg.evaluate(BANNER)
        check('banner on a note page: what to collect, and a link to the Edit page', 'Missing details: date of birth, phone number. Please collect these from the patient.' in text and 'Edit details' in text, text)
        n302 = edits(302)
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/invoice/302/')
        await pg.wait_for_function(BANNER, timeout=20000)
        await pg.wait_for_timeout(1000)
        check('another page of the same patient: banner still there, not read again', edits(302) == n302, (n302, edits(302)))
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/305')
        await pg.wait_for_function(BANNER, timeout=20000)
        text = await pg.evaluate(BANNER)
        check('a patient outside the window, not booked: read when their page opens, banner shown', 'Missing details: phone number. Please collect this from the patient.' in text and edits(305) == 1, (text, edits(305)))
        for _ in range(40):
            if note_lines().get('305'):
                break
            await pg.wait_for_timeout(250)
        check('read on their page, with gaps: noted for the other PCs', note_lines().get('305') == ['phone'], note_text())
        n301 = edits(301)
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/301')
        await pg.wait_for_timeout(1500)
        check('a complete patient: no banner, not read again', await pg.evaluate(BANNER) == '' and edits(301) == n301, (await pg.evaluate(BANNER), edits(301)))
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/appointment/304/')
        await pg.wait_for_timeout(1500)
        check('only the email missing: no banner', await pg.evaluate(BANNER) == '')

        # Details saved: the banner goes on the next page of that patient
        S['patients'][305]['phone'] = '07700 900000'
        await pg.clock.fast_forward(31000)
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/305/edit')
        await pg.wait_for_function("!document.querySelector('#pageContent > .upc-md-banner')", timeout=20000)
        await pg.wait_for_timeout(500)
        ids = await pg.evaluate("JSON.parse(localStorage.getItem('upc-md:ids') || '[]')")
        check('details saved: on the Edit page itself, read from the page (no extra request), banner gone, no longer marked', await pg.evaluate(BANNER) == '' and '305' not in ids and edits(305) == 2, (edits(305), ids))
        for _ in range(40):
            if note_lines().get('305') == ['ok']:
                break
            await pg.wait_for_timeout(250)
        check('details saved: the note says so for the other PCs', note_lines().get('305') == ['ok'], (note_text(), S['log'][-12:]))
        # Back from the Edit page: read once more (the details may have just been saved)
        S['patients'][303]['postcode'] = ''
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/303/edit')
        await pg.wait_for_function(BANNER, timeout=20000)
        S['patients'][303]['postcode'] = 'M41 0AA'
        n303 = edits(303)
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/303')
        await pg.wait_for_function("!document.querySelector('#pageContent > .upc-md-banner')", timeout=20000)
        check('after a visit to the Edit page, the next page reads the details again and the banner goes', edits(303) == n303 + 1, (n303, edits(303)))
        check('no page errors', not errors, errors)
        await ctx.close()

        # A second PC (its own storage), sharing the note: another PC is checking 303, and someone typed into the note
        notes = S['notes']
        setup('Wendy Pritchard', notes)
        n = notes[78842][-1]
        n['html'] = re.sub(r'<p class="ck-text">303 \|[^<]*</p>', '<p class="ck-text">303 | - | - | checking zzzz until 2026-11-16 09:30</p>', n['html']) + '<p class="ck-text">Remember to ring Bob</p>'
        before = len(notes[78842])
        ctx = await context(browser)
        pg = await ctx.new_page()
        repaired = []
        await pg.expose_function('upcRepaired', lambda m: repaired.append(m))
        await pg.add_init_script("document.addEventListener('upc-loader-error', (e) => window.upcRepaired(e.detail))")
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/#upc-missing-details')
        await pg.wait_for_function("document.querySelector('[data-upc-missing-details] .card') && !document.querySelector('[data-upc-missing-details] [data-a=refresh]').disabled", timeout=90000)
        cards = await pg.evaluate(ROWS)
        names = [r[0] for r in (cards[0][1] if cards else [])]
        read = sorted({int(x[1].split('/')[2]) for x in S['log'] if x[1].endswith('/edit') and x[0] == 'GET' and x[1].startswith('/patient/')})
        check('second PC: takes what the first found, no Edit pages read, same list (names from the calendar)', read == [] and names == ['Patient B', 'Patient H'], (read, cards))
        check('second PC: leaves alone a patient another PC is checking', edits(303) == 0 and note_lines().get('303') == ['-', 'checking zzzz until 2026-11-16 09:30'], note_text())
        check('a line typed into the note is dropped when it is next saved, the health check told, no second note', 'Remember to ring Bob' not in note_text() and len(notes[78842]) == before
              and any('could not be read' in m for m in repaired), (note_text(), repaired))
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/302/clinical')
        await pg.wait_for_function(BANNER, timeout=20000)
        check('second PC: banner from the note, no Edit page read', 'date of birth, phone number' in await pg.evaluate(BANNER) and edits(302) == 0, edits(302))
        ids = await pg.evaluate("JSON.parse(localStorage.getItem('upc-md:ids') || '[]')")
        check('second PC: calendar marks from the note', sorted(ids) == ['302', '308'], ids)
        await ctx.close()

        # A PC that checked everyone before the note existed: what it knew goes into the note, with the time it was found
        setup('Carl Healy', {})
        ctx = await context(browser)
        two_h = int((NOW - datetime.timedelta(hours=2)).timestamp() * 1000)
        old = {str(i): {'at': two_h, 'name': 'x', 'status': 'current', 'missing': m, 'email': True} for i, m in
               [(301, []), (302, ['dob', 'phone']), (303, ['address']), (304, []), (306, []), (308, ['first', 'last'])]}
        await ctx.add_init_script("if (!localStorage.getItem('upc-md:patients')) localStorage.setItem('upc-md:patients', %s)" % json.dumps(json.dumps(old)))
        pg = await ctx.new_page()
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/#upc-missing-details')
        await pg.wait_for_function("document.querySelector('[data-upc-missing-details] .card') && !document.querySelector('[data-upc-missing-details] [data-a=refresh]').disabled", timeout=90000)
        lines = note_lines()
        read = [x for x in S['log'] if x[1].endswith('/edit') and x[1].startswith('/patient/')]
        check('a PC\'s earlier checks are shared, with when they were found (no Edit pages read)', not read and sorted(lines) == ['301', '302', '303', '304', '306', '308']
              and lines['302'] == ['dob phone'] and all(l.split(' | ')[1] == '2026-11-16 07:00' for l in note_text()[2:]), (read, note_text()))
        await ctx.close()

        # Three PCs each made a note at the same moment (live, 15 Nov 2026): the oldest is used, the others' lines taken in,
        # and the others relabelled as spare copies
        head = '<p class="ck-text">UPC shared checks: Missing details</p><p class="ck-text">Kept by UPC scripts. Please do not edit: a line that is changed is dropped and checked again.</p>'
        setup('Carl Healy', {78842: [{'id': 40001, 'html': head},
                                     {'id': 40002, 'html': head + '<p class="ck-text">301 | 2026-11-16 08:00 | ok</p><p class="ck-text">302 | 2026-11-16 08:00 | dob phone</p>'},
                                     {'id': 40003, 'html': head}]})
        ctx = await context(browser)
        pg = await ctx.new_page()
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/#upc-missing-details')
        await pg.wait_for_function("document.querySelector('[data-upc-missing-details] .card') && !document.querySelector('[data-upc-missing-details] [data-a=refresh]').disabled", timeout=90000)
        by_id = {n['id']: [re.sub(r'<[^>]+>', '', x) for x in n['html'].split('</p>') if x.strip()] for n in S['notes'][78842]}
        kept = {l.split(' | ')[0]: l.split(' | ')[2:] for l in by_id[40001][2:]}
        read = sorted({int(x[1].split('/')[2]) for x in S['log'] if x[1].endswith('/edit') and x[1].startswith('/patient/')})
        check('two PCs made a note at once: the oldest used, with the other copy\'s lines (those not read again)', len(S['notes'][78842]) == 3 and kept.get('301') == ['ok']
              and kept.get('302') == ['dob phone'] and sorted(kept) == ['301', '302', '303', '304', '306', '308'] and 301 not in read and 302 not in read, (by_id, read))
        check('the other copies relabelled, so nothing uses them again', all(by_id[i] == ['Spare copy of UPC shared checks: Missing details (two PCs started it at the same moment). It can be deleted.'] for i in (40002, 40003)), by_id)
        await ctx.close()

        # Someone else (a physio): no page or menu item, but the banner still shows
        setup('Physio One')
        ctx = await context(browser)
        pg = await ctx.new_page()
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/302')
        await pg.wait_for_function(BANNER, timeout=20000)
        menu = await pg.evaluate("!!document.querySelector('a.upc-md-menu')")
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/#upc-missing-details')
        await pg.wait_for_timeout(2500)
        page = await pg.evaluate("!!document.querySelector('[data-upc-missing-details]')")
        check('others: banner shown, no menu item or page', not menu and not page, (menu, page))
        await ctx.close()
        await browser.close()
    print('\n%d failed' % len(FAILS) if FAILS else '\nAll passed')
    sys.exit(1 if FAILS else 0)

asyncio.run(main())
