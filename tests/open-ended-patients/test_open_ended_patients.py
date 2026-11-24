"""
Test for Check-ins against a mock Halaxy (calendar, notes list and note, follow-ups list; same shapes as Review
requests' test, confirmed live). Invented patients and notes only.

Checks: open-ended wording in the latest note, 3 weeks to 3 months after the last visit, nothing booked, last visit
not cancelled or missed; negations; only the latest note counts; Review Request marked; the menu count; note text
not stored; cached between checks; CH only. Send recall (0.2.0): confirm, Email patient scheduled for the next weekday
10:30 with the "Recall - Open-ended" template, the last visit's practitioner written in, Halaxy's tags left; recorded in
the shared note so it isn't offered again; a template with a tag the script can't fill isn't sent.

Run:  python3 tests/open-ended-patients/test_open_ended_patients.py
"""
import asyncio, datetime, json, re, sys, urllib.parse
from pathlib import Path
from playwright.async_api import async_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fakeclock import until, idle   # waits move the fake clock on instead of waiting in real time

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
    S.update({'patients': {}, 'events': [], 'followups': [], 'log': [], 'user': 'Carl Healy', 'nextNote': 5000, 'posts': [], 'scheduled': {}, 'notes': {},
              'template': ('How are you getting on, <span class="dynamicterm">[Patient First Name]</span>?',
                           '<table bgcolor="#f0f0f5"><tbody><tr><td><p>Hi <span class="dynamicterm">[Patient First Name]</span>,</p><p>It\'s been a few weeks since you last saw <span class="dynamicterm">[Practitioner First Name]</span>.</p></td></tr></tbody></table>')})

    def patient(pid, name, appts, notes=()):
        items = []
        for n, text in notes:
            S['nextNote'] += 1
            items.append({'id': str(S['nextNote']), 'category': 'appointment', 'entity': 'note', 'label': 'Appointment', 'date': hx(at(n)), 'text': text})
        S['patients'][pid] = {'name': name, 'items': items}
        for n, status in appts:
            S['events'].append({'id': len(S['events']) + 1, 'type': 'appointment', 'linkPaGId': pid, 'title': name, 'appointmentStatus': status, 'practitionerID': 12 if pid % 2 else 11,
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
    patient(213, 'Patient M', [(-35, ''), (-20, 'cancelled')], [(-35, 'Progressing well, next appt in 2 weeks.')])   # cancelled mid-treatment
    patient(214, 'Patient N', [(-35, ''), (-20, 'cancelled')], [(-35, 'Goals met, discharged.')])                    # cancelled after finishing
    patient(216, 'Patient P', [(-30, '')], [(-30, 'Plan:\n- Discharge from physiotherapy today\n- Return if symptoms recur')])   # finished, with the usual advice
    patient(215, 'Patient O', [(-35, ''), (-20, 'did-not-attend')], [(-35, 'Continue exercises.')])                  # missed, owes the fee
    S['invoices'] = {215: [{'id': 1, 'total': '£ 40.00', 'balance': '£ 40.00', 'status': 'Not yet paid'}]}
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
        return await js([{'id': 11, 'name': 'Carl Healy'}, {'id': 12, 'name': 'Diana Satalova'}])
    if p.endswith('/calendar/json'):
        q = urllib.parse.parse_qs(u.query)
        lo, hi = int(q['start'][0]), int(q['end'][0])
        return await js({'payload': {'events': [e for e in S['events'] if lo <= e['start'] < hi]}})
    m = re.search(r'/patient/invoice/(\d+)/list-data$', p)
    if m:
        return await js(S.get('invoices', {}).get(int(m.group(1)), []))
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
    form = dict(urllib.parse.parse_qsl(req.post_data or '', keep_blank_values=True)) if req.method == 'POST' else {}
    m = re.match(r'^/a/pr/555/email/compose/patient/(\d+)$', p)
    if m:
        pid = int(m.group(1))
        if req.method == 'GET':
            hours = ''.join("<option value='%d'>%02d</option>" % (h, h) for h in range(24))
            mins = ''.join("<option value='%d'>%02d</option>" % (x, x) for x in range(60))
            return await js({'status': 'FORM', 'title': 'Send Email', 'message': "<form id='composeEmailForm'><input name='form[fromName]' value='Urmston Physio Clinic'><textarea name='form[subject]'></textarea>"
                             "<input name='form[toEmail]' value='%s'><input name='form[bccEmail]' value='copies@example.com'><select name='form[template]'><option value=''>Select</option>"
                             "<option value='93132'>Chase - Excess Due</option><option value='99001'>Recall - Open-ended</option></select><textarea name='form[body]'></textarea>"
                             "<input type='hidden' name='form[_token]' value='tok'><input name='form[scheduleDetails][scheduleDate]' value=''>"
                             "<select name='form[scheduleDetails][scheduleTime][hour]'>%s</select><select name='form[scheduleDetails][scheduleTime][minute]'>%s</select></form>"
                             % ('' if pid == S.get('noemail') else 'p%d@example.com' % pid, hours, mins)})
        S['posts'].append((pid, form))
        at_ = '%s %02d:%02d' % (form['form[scheduleDetails][scheduleDate]'], int(form['form[scheduleDetails][scheduleTime][hour]']), int(form['form[scheduleDetails][scheduleTime][minute]']))
        S['scheduled'].setdefault(pid, []).append({'entityId': 80000 + len(S['posts']), 'sentDateLocal': at_, 'subject': form['form[subject]'], 'emailStatus': 'Scheduled'})
        return await js({'status': 'REFRESH'})
    if p == '/a/pr/555/communication/template/list/99001':
        subj, body = S['template']
        return await route.fulfill(body="<html><body><form id='editCommunicationTemplateForm'><textarea name='form[subject]'>%s</textarea><textarea name='form[contentForFormHandler]'>%s</textarea></form></body></html>"
                                   % (subj.replace('&', '&amp;').replace('<', '&lt;'), body.replace('&', '&amp;').replace('<', '&lt;')), content_type='text/html')
    if p == '/api/v2/practitioner/messaging/history/scheduled/emails':
        pid = int(urllib.parse.parse_qs(u.query)['linkPaG'][0])
        return await js({'data': {'emailMessages': S['scheduled'].get(pid, [])}})
    notes = S['notes']
    m = re.match(r'^/a/pr/555/communication-log/organisation/(\d+)/list-data$', p)
    if m:
        return await js({'data': [{'id': n['id'], 'date': '2026-11-11 10:00:00', 'privacy': 'All', 'creator': 'Carl Healy', 'isImportant': False, 'content': '\n<p class="font-weight-bold">Log Notes</p>\n' + n['html'] + '\n<div class="form-row mt-4">\n    </div>\n'}
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
    if p.startswith('/a/pr/555/'):
        return await route.fulfill(body=page_html(S['user']), content_type='text/html')
    await route.fulfill(status=404, body='not mocked')


async def context(browser):
    ctx = await browser.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/London')
    await ctx.clock.install(time=NOW.isoformat())
    await ctx.route('https://eu.halaxy.com/**', halaxy)
    # Halaxy's date picker (flatpickr), as a stand-in that records how it was set up.
    await ctx.add_init_script("window.fpCalls = []; window.flatpickr = (el, o) => { window.fpCalls.push({ type: el.type, value: el.value, o: { dateFormat: o.dateFormat, altInput: o.altInput, altFormat: o.altFormat, minDate: o.minDate, defaultDate: o.defaultDate } }); return {}; };")
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
        await until(pg, "document.querySelector('[data-upc-check-ins] table') && !document.querySelector('[data-upc-check-ins] [data-a=refresh]').disabled", timeout=90)
        rows = await pg.evaluate(ROWS)
        names = [r[0] for r in rows]
        cards = await pg.evaluate("[...document.querySelectorAll('[data-upc-check-ins] .card')].map((c) => [c.querySelector('h2').textContent, [...c.querySelectorAll('tbody tr')].map((tr) => [...tr.cells].map((x) => x.textContent.trim()))])")
        cd = dict(cards)
        check('open-ended, 3 weeks to 3 months, nothing booked: oldest visit first', [r[0] for r in cd.get('Open-Ended (5)', [])] == ['Patient C', 'Patient B', 'Patient L', 'Patient A', 'Patient D'], cards)
        canc = cd.get('Cancelled, Not Rebooked (2)', [])
        check('cancelled or missed after the last visit, nothing rebooked: own card, whatever the note says', [r[0] for r in canc] == ['Patient M', 'Patient H']
              and canc[0][4].startswith('Cancelled 22-Oct-2026') and canc[1][4].startswith('Missed 27-Oct-2026'), cards)
        check('left out: discharged with "return if", cancelled after finishing, missed and owing money', 'Patient P' not in names and 'Patient N' not in names and 'Patient O' not in names, names)
        muted = await pg.evaluate("[...document.querySelectorAll('[data-upc-check-ins] p.text-muted')].pop().textContent")
        check('line under the list counts them', '1 cancelled after finishing treatment' in muted and '1 cancelled and owing money' in muted, muted)
        by = {r[0]: r for r in rows}
        check('the wording found is named', by.get('Patient A', [''] * 6)[4].startswith('open return') and by.get('Patient B', [''] * 6)[4].startswith('book again if needed')
              and by.get('Patient C', [''] * 6)[4].startswith('see how things go') and by.get('Patient D', [''] * 6)[4].startswith('come back if needed'), rows)
        check('practitioner of the last visit', by.get('Patient A', [''] * 6)[3] == 'Diana Satalova' and by.get('Patient B', [''] * 6)[3] == 'Carl Healy', rows)
        check('last seen and whole weeks since', by.get('Patient A', [])[1:3] == ['17-Oct-2026', '3'], by.get('Patient A'))
        check('nothing about Review requests: no column, follow-ups not read', all(len(r) == 6 for r in rows) and not [x for x in S['log'] if 'followup' in x[1]], (rows, S['log']))
        check('left out: booked ahead, under 3 weeks, over 3 months, last one missed, not open-ended, negated, older note only',
              not any(n in names for n in ['Patient E', 'Patient F', 'Patient G', 'Patient I', 'Patient J', 'Patient K']), names)
        link = await pg.evaluate("document.querySelector('[data-upc-check-ins] tbody tr td:nth-child(5) a').getAttribute('href')")
        check('links to the note', re.fullmatch(r'/a/pr/555/patient/\d+/clinical/category/note/id/\d+', link or '') is not None, link)
        badge = await pg.evaluate("(document.querySelector('a.upc-ci-menu .upc-ci-badge') || {}).textContent")
        check('menu item under Patients with the count', badge == '7', badge)
        stored = await pg.evaluate("Object.keys(localStorage).filter((k) => k.startsWith('upc-ci:')).map((k) => localStorage.getItem(k)).join(' ')")
        check('note text never stored', not any(x in stored for x in ['Much improved', 'Exercises progressed', 'Pt to book', 'any problems', 'next few weeks']), stored[:300])
        notes_read = sorted({x[1] for x in S['log'] if x[1].startswith('/note/menu/')})
        check('notes read only for patients 3 weeks to 3 months quiet with nothing booked', notes_read == ['/note/menu/linkPaG/%d/items' % i for i in (201, 202, 203, 204, 208, 209, 210, 211, 212, 213, 214, 215, 216)], notes_read)
        before = len(S['log'])
        await pg.click('[data-upc-check-ins] [data-a=refresh]')
        await until(pg, "!document.querySelector('[data-upc-check-ins] [data-a=refresh]').disabled", timeout=60)
        again = [x[1] for x in S['log'][before:]]
        check('checking again reuses what was read (no notes re-read)', not [x for x in again if x.startswith('/note/')] and any(x.endswith('/calendar/json') for x in again), again)
        # The shared wording, tuned on the clinic's notes (invented sentences in Heidi's layout)
        W = [
            ('Plan:\n- Return if symptoms recur', ['come back if needed'], []),
            ('Plan:\n- RTC PRN if any concerns', ['come back if needed'], []),
            ('Plan:\n- Follow-up if symptoms persist', ['see as needed'], []),
            ('Plan:\n- Continue paracetamol PRN\n- Follow-up next week', [], []),
            ('Subjective:\n- Discharged from orthopaedics in May\n- Self-management: gel\nPlan:\n- Follow-up next week', [], []),
            ('Plan:\n- No further physio appointments required', [], ['no further treatment']),
            ('Plan:\n- No further physio appointments until orthopaedic assessment completed', [], []),
            ('Plan:\n- Final session today as requested', [], ['final session']),
            ('Plan:\n- dc from physio offered open if required', ['see as needed'], ['discharged']),
            ('Plan:\n- Discharge from physiotherapy today\n- Return if symptoms worsen', ['come back if needed'], ['discharged']),
        ]
        got = await pg.evaluate("(w) => w.map(([t]) => [UPC.wording.openEnded(t), UPC.wording.finished(t)])", W)
        bad = [(W[i][0], g) for i, g in enumerate(got) if g[0] != W[i][1] or g[1] != W[i][2]]
        check('wording: Heidi\'s phrasing read as the physios mean it', not bad, bad)

        # Send recall
        await pg.click("[data-upc-check-ins] [data-a=recall][data-id='201']")
        await pg.wait_for_selector('[data-upc-ci-confirm]')
        q = await pg.evaluate("document.querySelector('[data-upc-ci-confirm]').textContent")
        when = await pg.evaluate("document.querySelector('[data-upc-ci-confirm] #upc-ci-when').value")
        check('confirm: who and the practitioner named; send date chosen there, the next weekday by default', 'Patient A' in q and 'Diana' in q and 'at 10:30' in q and when == '2026-11-12', (q, when))
        fp = await pg.evaluate("window.fpCalls")
        check("the send date uses Halaxy's date picker, shown as Halaxy writes dates, from the first allowed day",
              len(fp) == 1 and fp[0]['o'] == {'dateFormat': 'Y-m-d', 'altInput': True, 'altFormat': 'd-M-Y', 'minDate': '2026-11-12', 'defaultDate': '2026-11-12'}, fp)
        await pg.click('[data-upc-ci-confirm] [data-c=yes]')
        await until(pg, "[...document.querySelectorAll('[data-upc-check-ins] .card h2')].some((h) => h.textContent === 'Recalled (1)')", timeout=30)
        f = S['posts'][0][1] if S['posts'] else {}
        check('scheduled for the next weekday 10:30', S['posts'] and S['posts'][0][0] == 201 and f.get('form[scheduleDetails][scheduleDate]') == '12-Nov-2026'
              and f.get('form[scheduleDetails][scheduleTime][hour]') == '10' and f.get('form[scheduleDetails][scheduleTime][minute]') == '30', f)
        check('subject as the template, Halaxy fills the name', f.get('form[subject]') == 'How are you getting on, [Patient First Name]?', f.get('form[subject]'))
        b = f.get('form[body]', '')
        check('body: practitioner written in, patient tag left, styling kept', 'last saw Diana.' in b and '[Patient First Name]' in b and '[Practitioner First Name]' not in b and 'bgcolor="#f0f0f5"' in b, b)
        rows = await pg.evaluate("[...document.querySelectorAll('[data-upc-check-ins] .card')].map((c) => [c.querySelector('h2').textContent, [...c.querySelectorAll('tbody tr')].map((tr) => [...tr.cells].map((x) => x.textContent.trim()))])")
        div = await pg.evaluate("(() => { const d = document.querySelector('[data-upc-check-ins] .upc-divider'); const next = d && d.nextElementSibling && d.nextElementSibling.querySelector('h2'); return d && [d.textContent, next && next.textContent]; })()")
        check('a "Done" line above the cards already acted on', div == ['Done', 'Recalled (1)'], div)
        rec = dict(rows).get('Recalled (1)', [])
        check('moved to Recalled with the time, no button', rec and rec[0][0] == 'Patient A' and rec[0][5] == 'Scheduled for 12-Nov-2026 10:30'
              and not await pg.evaluate("!!document.querySelector(\"[data-a=recall][data-id='201']\")"), rows)
        badge = await pg.evaluate("(document.querySelector('a.upc-ci-menu .upc-ci-badge') || {}).textContent")
        check('menu count: only those still to recall', badge == '6', badge)
        note = ' '.join(n['html'] for v in S['notes'].values() for n in v)
        check('recorded in the shared note', re.search(r'p\.201 \| [\d :-]+ \| sched \d+ 2026-10-17', re.sub(r'<[^>]+>', ' ', note)) is not None, note[:400])
        # Queue: the next patient can be pressed straight away; both go, one after the other
        await pg.click("[data-upc-check-ins] [data-a=recall][data-id='204']")
        await pg.click('[data-upc-ci-confirm] [data-c=yes]')
        await pg.click("[data-upc-check-ins] [data-a=recall][data-id='212']")
        await pg.click('[data-upc-ci-confirm] [data-c=yes]')
        queued = await pg.evaluate("[...document.querySelectorAll('[data-upc-check-ins] tbody tr')].filter((tr) => tr.cells[0].textContent.trim() === 'Patient L').map((tr) => tr.cells[5].textContent.trim())")
        await until(pg, "[...document.querySelectorAll('[data-upc-check-ins] .card h2')].some((h) => h.textContent === 'Recalled (3)')", timeout=60)
        check('queue: pressed while another runs, shown as Queued, both sent', queued == ['Queued'] and [x[0] for x in S['posts']] == [201, 204, 212], (queued, [x[0] for x in S['posts']]))
        # A template with a tag the script can't fill: not sent
        S['template'] = ('How are you getting on?', '<p>Your last visit was <span class="dynamicterm">[Appointment Date]</span>.</p>')
        await pg.click("[data-upc-check-ins] [data-a=recall][data-id='202']")
        await pg.click('[data-upc-ci-confirm] [data-c=yes]')
        await until(pg, "!!document.querySelector('[data-upc-check-ins] .alert-danger')", timeout=30)
        err = await pg.evaluate("document.querySelector('[data-upc-check-ins] .alert-danger').textContent")
        check('template with [Appointment Date]: not sent, says why', len(S['posts']) == 3 and '[Appointment Date]' in err and 'Nothing was sent' in err, (len(S['posts']), err))
        # Don't send: off the list for this visit, on every PC
        await pg.click("[data-upc-check-ins] [data-a=skip][data-id='213']")
        await pg.click('[data-upc-ci-confirm] [data-c=yes]')
        await until(pg, "[...document.querySelectorAll('[data-upc-check-ins] .card h2')].some((h) => h.textContent === 'Not Recalled (1)')", timeout=30)
        note = ' '.join(n['html'] for v in S['notes'].values() for n in v)
        cards = dict(await pg.evaluate("[...document.querySelectorAll('[data-upc-check-ins] .card')].map((c) => [c.querySelector('h2').textContent, [...c.querySelectorAll('tbody tr')].map((tr) => [...tr.cells].map((x) => x.textContent.trim()))])"))
        check("Don't send: recorded for this visit, listed under Not recalled with Undo", re.search(r'p\.213 \| [\d :-]+ \| skip 0 2026-10-07', re.sub(r'<[^>]+>', ' ', note)) is not None
              and [r[0] for r in cards.get('Not Recalled (1)', [])] == ['Patient M'] and cards['Not Recalled (1)'][0][5] == 'Undo'
              and await pg.evaluate("(document.querySelector('a.upc-ci-menu .upc-ci-badge') || {}).textContent") == '3', (cards, note[-300:]))
        # Undo: back on the list
        await pg.click("[data-upc-check-ins] [data-a=undo][data-id='213']")
        await pg.click('[data-upc-ci-confirm] [data-c=yes]')
        await until(pg, "!![...document.querySelectorAll('[data-upc-check-ins] .card')].find((c) => /Cancelled, Not Rebooked \\(2\\)/.test(c.textContent))", timeout=30)
        check('Undo: back to recall, Not recalled empty', await pg.evaluate("[...document.querySelectorAll('[data-upc-check-ins] .card h2')].some((h) => h.textContent === 'Not Recalled (0)')")
              and await pg.evaluate("(document.querySelector('a.upc-ci-menu .upc-ci-badge') || {}).textContent") == '4', cards)
        # Send date: a later date chosen in the pop-up
        S['template'] = ('How are you getting on?', '<p>Since you last saw <span class="dynamicterm">[Practitioner First Name]</span>.</p>')
        await pg.click("[data-upc-check-ins] [data-a=recall][data-id='213']")
        await pg.fill('[data-upc-ci-confirm] #upc-ci-when', '2026-11-11')
        await pg.click('[data-upc-ci-confirm] [data-c=yes]')
        err = await pg.evaluate("document.querySelector('[data-upc-ci-confirm] [data-c-err]').textContent")
        await pg.fill('[data-upc-ci-confirm] #upc-ci-when', '2026-11-30')
        await pg.click('[data-upc-ci-confirm] [data-c=yes]')
        await until(pg, "[...document.querySelectorAll('[data-upc-check-ins] .card h2')].some((h) => h.textContent === 'Recalled (4)')", timeout=60)
        f = S['posts'][-1][1]
        check('send date: earlier than allowed refused in the pop-up; a later one used', 'Choose 12-Nov-2026 or later.' == err and S['posts'][-1][0] == 213
              and f.get('form[scheduleDetails][scheduleDate]') == '30-Nov-2026' and f.get('form[scheduleDetails][scheduleTime][hour]') == '10', (err, f.get('form[scheduleDetails][scheduleDate]')))
        # A newer list from a PC still on an older version (no practitioners) doesn't replace this PC's
        for v in S['notes'].values():
            for n in v:
                if 'UPC shared list: Open-ended patients' in n['html']:
                    n['html'] = re.sub(r'<p>data .*?</p>', lambda m: '<p>data ' + json.dumps({'at': int(NOW.timestamp() * 1000) + 3600e3, 'by': '0.1.11', 'rows': [], 'counts': {}, 'listed': 0}).replace('"', '&quot;') + '</p>', n['html'])
        kept = await pg.evaluate("window.upcCheckIns.pullShared(0).then(() => JSON.parse(localStorage.getItem('upc-ci:result')).by)")
        check('an older version\'s list from another PC doesn\'t replace this one', kept != '0.1.11', kept)
        native = await pg.evaluate("document.querySelector('[data-upc-check-ins]').classList.contains('upc-native')")
        check('native look', native)
        check('no page errors', not errors, errors)
        await ctx.close()

        setup()
        S['user'] = 'Someone Else'
        ctx = await context(browser)
        pg = await ctx.new_page()
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/#upc-check-ins')
        await idle(pg, 25000)
        check('others see nothing and nothing is asked of Halaxy', await pg.evaluate("!document.querySelector('[data-upc-check-ins]') && !document.querySelector('a.upc-ci-menu')")
              and not [x for x in S['log'] if 'calendar' in x[1]], S['log'])
        await ctx.close()
        await browser.close()
    print('\n%d failed' % len(FAILS) if FAILS else '\nAll passed')
    sys.exit(1 if FAILS else 0)

asyncio.run(main())
