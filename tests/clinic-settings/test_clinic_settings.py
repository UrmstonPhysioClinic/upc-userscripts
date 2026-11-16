"""
Test for clinic settings: core's UPC.settings (the Admin Note "UPC clinic settings" on UPC scripts (settings)) and the
Clinic settings section of Script settings, against a mock Halaxy (Admin Notes as captured on 14 Nov 2026).

Checks: defaults with no note; Carl changes values in Script settings and they are saved to the note (only those that
differ from the default) and used straight away; a value outside its limits is refused and nothing saved; an empty box
means the default; everyone else sees the values but can't change them; a value changed by hand outside its limits, or a
line that can't be read, falls back to the default and is listed; the scripts' rules read the settings.

Run:  python3 tests/clinic-settings/test_clinic_settings.py
"""
import asyncio, html, json, re, sys, urllib.parse
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
CORE = (ROOT / 'beta' / 'core.user.js').read_text().replace('perMinute: 45,', 'perMinute: 100000,')
SS = (ROOT / 'beta' / 'script-settings.user.js').read_text()
RTB = (ROOT / 'beta' / 'ready-to-bill.user.js').read_text()
FAILS = []
S = {}


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)[:800]))
    if not ok:
        FAILS.append(name)


def page(user):
    return ("<!doctype html><html><head><title>Calendar | Halaxy</title></head><body class='vs-theme'><div id='headerWrapper'>"
            "<div id='practitioner-select' class='dropdown'><button id='activeUser'>%s</button><div class='dropdown-menu'>"
            "<a id='btn-user-select-logout' class='dropdown-item' href='/logout'>Log Out</a></div></div></div><ul id='mainMenu'></ul>"
            "<div id='pageContent'><h1>Calendar</h1></div><script>window.HkUser = { pracName: %s };</script></body></html>") % (user, json.dumps(user))


async def halaxy(route):
    req = route.request
    p = urllib.parse.urlparse(req.url).path
    S['log'].append((req.method, re.sub(r'^/a/pr/555', '', p)))
    js = lambda o: route.fulfill(body=json.dumps(o), content_type='application/json')
    notes = S['notes']
    if p.endswith('/lookup/practitioner'):
        return await js([{'id': 11, 'name': 'Carl Healy'}, {'id': 12, 'name': 'Physio One'}, {'id': 13, 'name': '<b>Bad</b>'}])
    m = re.match(r'^/a/pr/555/communication-log/organisation/(\d+)/list-data$', p)
    if m:
        # Halaxy's list can lag just after a save (live, 15 Nov 2026): S['lag'] leaves a new note out of the next list
        hide = S.pop('hideOnce', None)
        return await js({'data': [{'id': n['id'], 'date': '2026-11-15 10:00:00', 'privacy': 'All', 'creator': 'Carl Healy', 'isImportant': False, 'content': '\n<p class="font-weight-bold">Log Notes</p>\n' + n['html'] + '\n<div class="form-row mt-4">\n    </div>\n'}
                                  for n in reversed(notes.get(int(m.group(1)), [])) if n['id'] != hide]})
    m = re.match(r'^/a/pr/555/communication-log/organisation/(\d+)/(\d+)/delete(/([0-9a-f]+))?$', p)
    if m:
        org, nid = int(m.group(1)), int(m.group(2))
        if not m.group(3):
            return await js({'status': 'FORM', 'title': 'Delete Admin Note', 'message': "<div><a class='btn btn-outline-danger ajax' href='/a/pr/555/communication-log/organisation/%d/%d/delete/ab12'>Delete</a></div>" % (org, nid)})
        notes[org] = [n for n in notes.get(org, []) if n['id'] != nid]
        S.setdefault('deleted', []).append(nid)
        return await js({'status': 'CLOSE', 'url': '/a/pr/555/communication-log/organisation/%d' % org})
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
            nid = 50000 + len(notes.get(org, [])) + len(S.get('deleted', []))
            notes.setdefault(org, []).append({'id': nid, 'html': html})
            if S.get('lag'):
                S['hideOnce'] = nid
        return await js({'status': 'CLOSE', 'url': '/a/pr/555/communication-log'})
    if p.startswith('/a/pr/555/'):
        return await route.fulfill(body=page(S['user']), content_type='text/html')
    await route.fulfill(status=404, body='not mocked')


def note_lines():
    ns = S['notes'].get(78842, [])
    return [html.unescape(re.sub(r'<[^>]+>', '', x)) for x in ns[0]['html'].split('</p>') if x.strip()] if ns else []


async def open_pg(browser, user):
    S['user'] = user
    ctx = await browser.new_context(viewport={'width': 1300, 'height': 1000})
    await ctx.route('https://eu.halaxy.com/**', halaxy)
    await ctx.add_init_script(CORE)
    await ctx.add_init_script("document.addEventListener('DOMContentLoaded', function () {\n" + SS + "\n});")
    pg = await ctx.new_page()
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    await pg.goto('https://eu.halaxy.com/a/pr/555/calendar')
    await pg.wait_for_function("!!document.querySelector('.upc-script-settings')", timeout=15000)
    return ctx, pg, errors


async def open_clinic(pg):
    await pg.evaluate("window.upcScriptSettings.open()")
    await pg.wait_for_selector("[data-a=clinic]", timeout=10000)
    await pg.click("[data-a=clinic]")
    await pg.wait_for_selector(".upc-ss-clinic", timeout=10000)

GET = "Object.fromEntries(['readyToBill.maxExcess', 'readyToBill.rollingDays', 'reviewRequests.sendAt', 'missingDetails.aheadDays'].map((k) => [k, UPC.settings.get(k)]))"


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        S.update({'notes': {}, 'log': []})

        # No note yet: defaults
        ctx, pg, errors = await open_pg(browser, 'Carl Healy')
        await pg.wait_for_function("UPC.settings.readAt() > 0", timeout=20000)
        got = await pg.evaluate(GET)
        check('no note: the defaults', got == {'readyToBill.maxExcess': 500, 'readyToBill.rollingDays': 28, 'reviewRequests.sendAt': '10:30', 'missingDetails.aheadDays': 14}, got)
        check('read from the settings organisation once, nothing saved', [x for x in S['log'] if 'communication-log' in x[1]] == [('GET', '/communication-log/organisation/78842/list-data')], S['log'])

        # Carl: Script settings > Clinic settings (this PC's own value for a setting not yet saved is offered by its script)
        await pg.evaluate("window.__upcSettingOffers = { 'portalFill.payee': () => 'Urmston Physio Clinic Ltd' }")
        await open_clinic(pg)
        pc = await pg.evaluate("[document.querySelector(\"input[data-key='portalFill.payee']\").value, document.querySelector(\"input[data-key='portalFill.payee']\").closest('tr').textContent]")
        check('not yet saved: this PC\'s value shown, marked "from this PC"', pc[0] == 'Urmston Physio Clinic Ltd' and 'from this PC' in pc[1], pc)
        boxes = await pg.evaluate("[...document.querySelectorAll('.upc-ss-clinic input[type=number][data-key], .upc-ss-clinic input[type=time][data-key]')].map((i) => [i.dataset.key, i.value, i.placeholder])")
        check('Carl: a box per number or time, empty (default shown)', len(boxes) >= 20 and all(v == '' for _, v, _ in boxes) and dict((k, ph) for k, _, ph in boxes)['readyToBill.maxExcess'] == '500', boxes[:3])
        await pg.wait_for_function("document.querySelectorAll('[data-people=\"forecourtLights.staff\"] input').length >= 6", timeout=10000)
        fit = await pg.evaluate("(() => { const t = document.querySelector('.upc-ss-clinic table'); return [t.scrollWidth, t.parentElement.clientWidth]; })()")
        check('the table fits the pop-up (long lists wrap)', fit[0] <= fit[1] + 1, fit)
        check('Halaxy look: inside the dialog, Halaxy table and form classes', await pg.evaluate("!!document.querySelector('.upc-ss-clinic table.table.table-striped.table-bordered input.form-control')"))
        # A value outside its limits: refused, nothing saved
        await pg.fill("input[data-key='readyToBill.rollingDays']", '500')
        await pg.click("[data-a=save]")
        await pg.wait_for_function("document.querySelector('.upc-ss-clinic .upc-err[data-msg]')", timeout=10000)
        err = await pg.evaluate("document.querySelector('.upc-ss-clinic .upc-err[data-msg]').textContent")
        check('a value outside its limits: refused, saying the limits, nothing saved', 'whole number from 7 to 90' in err and not S['notes'].get(78842), err)
        # Valid values (Halaxy's list lags once just after the note is made)
        S['lag'] = True
        await pg.fill("input[data-key='readyToBill.rollingDays']", '28')
        await pg.fill("input[data-key='readyToBill.maxExcess']", '300')
        await pg.fill("input[data-key='reviewRequests.sendAt']", '09:15')
        await pg.click("[data-a=save]")
        await pg.wait_for_function("document.querySelector('.upc-ss-clinic .upc-ok')", timeout=15000)
        lines = note_lines()
        ndefs = await pg.evaluate("UPC.settings.defs.length")
        check('saved to the note: heading, then every setting (so no PC falls back to its own)', lines[:2] == ['UPC clinic settings', 'Changed in Script settings > Clinic settings. Please do not edit here: a line that is changed by hand is ignored.']
              and len(lines) == 2 + ndefs and 'readyToBill.maxExcess = 300' in lines and 'reviewRequests.sendAt = 09:15' in lines and 'readyToBill.rollingDays = 28' in lines, lines)
        check('and saved with the rest', 'portalFill.payee = Urmston Physio Clinic Ltd' in lines, lines)
        unsaved = await pg.evaluate("[...document.querySelectorAll('.upc-ss-clinic .upc-err, .upc-ss-clinic .upc-warn')].map((x) => x.textContent).join(' ')")
        check('after saving: no "not saved yet" notice', 'not saved yet' not in unsaved, unsaved)
        got = await pg.evaluate(GET)
        check('used straight away on this PC', got['readyToBill.maxExcess'] == 300 and got['reviewRequests.sendAt'] == '09:15', got)
        rule = await pg.evaluate("(() => { const m = %s.match(/const MAX_EXCESS = \\(\\) => ([^;]+);/); const rule = (k, d) => (window.UPC && UPC.settings && UPC.settings.def(k) ? UPC.settings.get(k) : d); return eval(m[1]); })()" % json.dumps(RTB))
        check('Ready to bill\'s excess limit follows it (pence)', rule == 30000, rule)
        # Back to the default by emptying the box
        await pg.fill("input[data-key='readyToBill.maxExcess']", '')
        await pg.click("[data-a=save]")
        await pg.wait_for_function("document.querySelector('.upc-ss-clinic .upc-ok')", timeout=15000)
        check('an empty box: back to the default', 'readyToBill.maxExcess = 500' in note_lines() and 'reviewRequests.sendAt = 09:15' in note_lines() and await pg.evaluate("UPC.settings.get('readyToBill.maxExcess')") == 500, note_lines())
        check('one note only, although Halaxy\'s list lagged after it was made', len(S['notes'][78842]) == 1, S['notes'])
        S['lag'] = False
        lists = [x for x in S['log'] if x[1].endswith('/list-data')]
        check('the notes list is asked afresh each time', len(lists) >= 3, lists)

        # People (stage 2): ticks for who sees a page, a list for who gets tasks
        await pg.wait_for_function("document.querySelectorAll('[data-people=\"readyToBill.people\"] input').length >= 3", timeout=10000)
        ticks = await pg.evaluate("[...document.querySelectorAll('[data-people=\"readyToBill.people\"] input')].map((i) => [i.value, i.checked])")
        t = dict(ticks)
        check('who sees Ready to bill: everyone offered (Halaxy\'s list and the names in settings), Carl and Wendy ticked', t.get('Carl Healy') and t.get('Wendy Pritchard') and t.get('Physio One') is False
              and 'Stephen Sharples' in t and not any('<' in n or 'Bad' in n for n in t), ticks)
        await pg.uncheck("[data-people='readyToBill.people'] input[value='Wendy Pritchard']")
        await pg.check("[data-people='readyToBill.people'] input[value='Physio One']")
        await pg.select_option("select[data-key='remittances.taskFor']", 'Physio One')
        for n in ['Carl Healy']:
            await pg.uncheck("[data-people='openEnded.people'] input[value='%s']" % n)
        await pg.click("[data-a=save]")
        await pg.wait_for_function("document.querySelector('.upc-ss-clinic .upc-err[data-msg]')", timeout=10000)
        err = await pg.evaluate("document.querySelector('.upc-ss-clinic .upc-err[data-msg]').textContent")
        kept = await pg.evaluate("[document.querySelector(\"[data-people='readyToBill.people'] input[value='Physio One']\").checked, document.querySelector(\"select[data-key='remittances.taskFor']\").value]")
        check('a refused save keeps the changes on screen', kept == [True, 'Physio One'], kept)
        check('nobody ticked: refused, nothing saved', 'Open-ended patients" must be at least one person' in err and 'readyToBill.people = Carl Healy, Wendy Pritchard' in note_lines(), err)
        await pg.check("[data-people='openEnded.people'] input[value='Carl Healy']")
        await pg.click("[data-a=save]")
        await pg.wait_for_function("document.querySelector('.upc-ss-clinic .upc-ok')", timeout=15000)
        lines = note_lines()[2:]
        check('people saved as names', 'readyToBill.people = Carl Healy, Physio One' in lines and 'remittances.taskFor = Physio One' in lines and 'openEnded.people = Carl Healy' in lines, lines)
        got = await pg.evaluate("[UPC.settings.get('readyToBill.people'), UPC.settings.get('remittances.taskFor'), UPC.settings.get('openEnded.people')]")
        check('read back as lists and names', got == [['Carl Healy', 'Physio One'], 'Physio One', ['Carl Healy']], got)
        allowed = await pg.evaluate("(() => { const m = %s.match(/const ALLOWED = \(\) => ([^;]+);/); const rule = (k, d) => (window.UPC && UPC.settings && UPC.settings.def(k) ? UPC.settings.get(k) : d); return eval(m[1]); })()" % json.dumps(RTB))
        check('Ready to bill follows it (Wendy no longer sees it)', allowed == ['Carl Healy', 'Physio One'], allowed)

        # Stage 3: days of the week, dates, text, an order, words
        await pg.check("[data-list='forecourtLights.days'] input[value='Tue']")
        await pg.check("[data-list='forecourtLights.days'] input[value='Thu']")
        await pg.fill("[data-lines='forecourtLights.skip']", '25-Dec-2026\nnot a date')
        await pg.fill("input[data-key='portalFill.email']", 'admin@urmstonphysioclinic.com')
        await pg.click("[data-a=save]")
        await pg.wait_for_function("document.querySelector('.upc-ss-clinic .upc-err[data-msg]')", timeout=10000)
        err = await pg.evaluate("document.querySelector('.upc-ss-clinic .upc-err[data-msg]').textContent")
        check('a date that can\'t be read: refused, saying how to write one', 'dates such as 25-Dec-2026' in err, err)
        await pg.fill("[data-lines='forecourtLights.skip']", '25-Dec-2026\n01/01/2027')
        await pg.fill("input[data-key='portalFill.email']", 'not an email')
        await pg.click("[data-a=save]")
        await pg.wait_for_function("document.querySelector('.upc-ss-clinic .upc-err[data-msg]') && /email/.test(document.querySelector('.upc-ss-clinic .upc-err[data-msg]').textContent)", timeout=10000)
        check('an email that isn\'t one: refused', True)
        await pg.fill("input[data-key='portalFill.email']", 'office@urmstonphysioclinic.com')
        await pg.fill("input[data-key='calendar.hideProfessions']", 'Administrator, Receptionist')
        order = await pg.evaluate("[...document.querySelectorAll('[data-order=\"calendar.order\"] [data-name]')].map((x) => x.dataset.name)")
        check('calendar order: the clinic\'s order first, then others offered', order[:4] == ['Roxanna Healy', 'Carl Healy', 'Diana Satalova', 'Stephen Sharples'], order)
        await pg.click("[data-order='calendar.order'] [data-name='Carl Healy'] [data-a=up]")
        await pg.click("[data-a=save]")
        await pg.wait_for_function("document.querySelector('.upc-ss-clinic .upc-ok')", timeout=15000)
        got = await pg.evaluate("['forecourtLights.days', 'forecourtLights.skip', 'portalFill.email', 'calendar.hideProfessions', 'calendar.order'].map((k) => UPC.settings.get(k))")
        check('saved and read back: days, dates (as dates), text, words, order', got[0] == ['Tue', 'Thu'] and got[1] == ['2026-12-25', '2027-01-01'] and got[2] == 'office@urmstonphysioclinic.com'
              and got[3] == ['Administrator', 'Receptionist'] and got[4][:2] == ['Carl Healy', 'Roxanna Healy'], got)
        lines = note_lines()
        check('in the note as plain lines', 'forecourtLights.days = Tue, Thu' in lines and 'forecourtLights.skip = 2026-12-25, 2027-01-01' in lines, lines)
        shownv = await pg.evaluate("document.querySelector(\"[data-lines='forecourtLights.skip']\").value")
        check('dates shown as Halaxy writes them', shownv == '25-Dec-2026\n01-Jan-2027', shownv)
        # Per person: Everyone, or people ticked; a choice
        evr = await pg.evaluate("[document.querySelector(\"[data-audience='alerts.arrivalChime'] [data-everyone]\").checked, document.querySelector(\"[data-audience='alerts.arrivalChime'] input[value='Carl Healy']\").disabled]")
        check('per person: Everyone ticked by default, names then fixed', evr == [True, True], evr)
        await pg.uncheck("[data-audience='alerts.arrivalChime'] [data-everyone]")
        await pg.uncheck("[data-audience='alerts.arrivalChime'] input[value='Carl Healy']")
        await pg.check("[data-audience='forecourtLights.remind'] input[value='Carl Healy']")
        await pg.select_option("select[data-key='branding.font']", 'halaxy')
        await pg.click("[data-a=save]")
        await pg.wait_for_function("document.querySelector('.upc-ss-clinic .upc-ok')", timeout=15000)
        lines = note_lines()
        check('per person saved: names (Carl left out of the chime), the choice', any(l.startswith('alerts.arrivalChime = ') and 'Carl Healy' not in l and 'Wendy Pritchard' in l for l in lines)
              and 'forecourtLights.remind = Carl Healy' in lines and 'branding.font = halaxy' in lines and 'alerts.chatAlarm = everyone' in lines, lines)
        mine = await pg.evaluate("[UPC.settings.forMe('alerts.arrivalChime'), UPC.settings.forMe('alerts.chatAlarm'), UPC.settings.forMe('forecourtLights.remind'), JSON.parse(localStorage.getItem('upc-settings:mine'))]")
        check('for whoever is signed in (Carl): chime off, chat alarm on, forecourt on; kept for early scripts', mine[:3] == [False, True, True] and mine[3]['user'] == 'Carl Healy'
              and mine[3]['values'] == {'forecourtLights.remind': True, 'alerts.arrivalChime': False, 'alerts.chatAlarm': True, 'branding.on': True, 'branding.font': 'halaxy', 'blockReporting.userpilot': False}, mine)
        # A script saving one value leaves the others as they are
        res = await pg.evaluate("UPC.settings.save({ 'readyToBill.maxExcess': 400 }).then(() => [UPC.settings.get('readyToBill.maxExcess'), UPC.settings.get('forecourtLights.days'), UPC.settings.get('readyToBill.people')], (e) => e.message)")
        check('saving one value keeps the rest', res == [400, ['Tue', 'Thu'], ['Carl Healy', 'Physio One']], res)
        await pg.evaluate("UPC.settings.save({ 'readyToBill.maxExcess': '' })")
        await pg.click("[data-a=back]")
        await pg.click("[data-a=clinic]")
        await pg.wait_for_selector(".upc-ss-clinic input[data-key='readyToBill.maxExcess']", timeout=10000)
        check('no page errors (Carl)', not errors, errors)
        await ctx.close()

        # Two settings notes (one made while the list lagged): the newest is used; the older is deleted on the next save
        S['notes'][78842].insert(0, {'id': 49000, 'html': '<p>UPC clinic settings</p><p>readyToBill.maxExcess = 999</p>'})
        S['log'] = []
        ctx, pg, errors = await open_pg(browser, 'Carl Healy')
        await pg.wait_for_function("UPC.settings.readAt() > 0", timeout=20000)
        check('two settings notes: the newest is used', await pg.evaluate("UPC.settings.get('readyToBill.maxExcess')") == 500 and await pg.evaluate("UPC.settings.get('reviewRequests.sendAt')") == '09:15')
        res = await pg.evaluate("UPC.settings.save(Object.fromEntries(UPC.settings.all().map((r) => [r.def.key, r.changed ? r.value : '']))).then(() => 'ok', (e) => e.message)")
        check('and the older one is deleted on the next save', res == 'ok' and S.get('deleted') == [49000] and len(S['notes'][78842]) == 1, (res, S.get('deleted'), S['notes']))
        await ctx.close()

        # Someone else: sees the values, can't change them; a hand-edited note
        n = S['notes'][78842][0]
        n['html'] += '<p class="ck-text">readyToBill.quietDays = 400</p><p class="ck-text">Wendy says hello</p>'
        S['log'] = []
        ctx, pg, errors = await open_pg(browser, 'Wendy Pritchard')
        await pg.wait_for_function("UPC.settings.readAt() > 0", timeout=20000)
        await open_clinic(pg)
        view = await pg.evaluate("({ inputs: document.querySelectorAll('.upc-ss-clinic input').length, save: !!document.querySelector('[data-a=save]'), text: document.querySelector('.upc-ss-clinic').textContent })")
        check('others: values shown, no boxes or Save', view['inputs'] == 0 and not view['save'] and '09:15' in view['text'] and 'Only Carl Healy can change these' in view['text'], view)
        check('others: people shown as names', 'Carl Healy, Physio One' in view['text'], view['text'][:600])
        check('a value changed by hand outside its limits: default used, and said', await pg.evaluate("UPC.settings.get('readyToBill.quietDays')") == 14 and 'saved value 400 is outside 3 to 90' in view['text'], view['text'][:300])
        check('a line that can\'t be read: ignored, and listed', 'Wendy says hello' in view['text'] and await pg.evaluate("UPC.settings.problems()") == ['Wendy says hello'], view['text'][-400:])
        res = await pg.evaluate("UPC.settings.save({}).then(() => 'saved', (e) => e.message)")
        check('others can\'t save, even from the console', res == 'Only Carl Healy can change the clinic settings.', res)
        check('nothing saved by others', not [x for x in S['log'] if x[0] == 'POST'], S['log'])
        check('no page errors (others)', not errors, errors)
        await ctx.close()
        await browser.close()
    print('\n%d failed' % len(FAILS) if FAILS else '\nAll passed')
    sys.exit(1 if FAILS else 0)

asyncio.run(main())
