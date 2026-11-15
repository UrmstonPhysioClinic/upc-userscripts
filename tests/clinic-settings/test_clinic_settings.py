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
    m = re.match(r'^/a/pr/555/communication-log/organisation/(\d+)/list-data$', p)
    if m:
        return await js({'data': [{'id': n['id'], 'date': '2026-11-15 10:00:00', 'privacy': 'All', 'creator': 'Carl Healy', 'isImportant': False, 'content': n['html']}
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
            notes.setdefault(org, []).append({'id': 50000 + len(notes.get(org, [])), 'html': html})
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

        # Carl: Script settings > Clinic settings
        await open_clinic(pg)
        boxes = await pg.evaluate("[...document.querySelectorAll('.upc-ss-clinic input[data-key]')].map((i) => [i.dataset.key, i.value, i.placeholder])")
        check('Carl: a box per setting, empty (default shown)', len(boxes) >= 20 and all(v == '' for _, v, _ in boxes) and dict((k, ph) for k, _, ph in boxes)['readyToBill.maxExcess'] == '500', boxes[:3])
        check('Halaxy look: inside the dialog, Halaxy table and form classes', await pg.evaluate("!!document.querySelector('.upc-ss-clinic table.table.table-striped.table-bordered input.form-control')"))
        # A value outside its limits: refused, nothing saved
        await pg.fill("input[data-key='readyToBill.rollingDays']", '500')
        await pg.click("[data-a=save]")
        await pg.wait_for_function("document.querySelector('.upc-ss-clinic .upc-err')", timeout=10000)
        err = await pg.evaluate("document.querySelector('.upc-ss-clinic .upc-err').textContent")
        check('a value outside its limits: refused, saying the limits, nothing saved', 'whole number from 7 to 90' in err and not S['notes'].get(78842), err)
        # Valid values
        await pg.fill("input[data-key='readyToBill.rollingDays']", '28')
        await pg.fill("input[data-key='readyToBill.maxExcess']", '300')
        await pg.fill("input[data-key='reviewRequests.sendAt']", '09:15')
        await pg.click("[data-a=save]")
        await pg.wait_for_function("document.querySelector('.upc-ss-clinic .upc-ok')", timeout=15000)
        lines = note_lines()
        check('saved to the note: heading, then only what differs from the default', lines == ['UPC clinic settings', 'Changed in Script settings > Clinic settings. Please do not edit here: a line that is changed by hand is ignored.',
              'readyToBill.maxExcess = 300', 'reviewRequests.sendAt = 09:15'], lines)
        got = await pg.evaluate(GET)
        check('used straight away on this PC', got['readyToBill.maxExcess'] == 300 and got['reviewRequests.sendAt'] == '09:15', got)
        rule = await pg.evaluate("(() => { const m = %s.match(/const MAX_EXCESS = \\(\\) => ([^;]+);/); const rule = (k, d) => (window.UPC && UPC.settings && UPC.settings.def(k) ? UPC.settings.get(k) : d); return eval(m[1]); })()" % json.dumps(RTB))
        check('Ready to bill\'s excess limit follows it (pence)', rule == 30000, rule)
        # Back to the default by emptying the box
        await pg.fill("input[data-key='readyToBill.maxExcess']", '')
        await pg.click("[data-a=save]")
        await pg.wait_for_function("document.querySelector('.upc-ss-clinic .upc-ok')", timeout=15000)
        check('an empty box: back to the default (line removed)', note_lines()[2:] == ['reviewRequests.sendAt = 09:15'] and await pg.evaluate("UPC.settings.get('readyToBill.maxExcess')") == 500, note_lines())
        check('one note only', len(S['notes'][78842]) == 1, S['notes'])
        check('no page errors (Carl)', not errors, errors)
        await ctx.close()

        # Someone else: sees the values, can't change them; a hand-edited note
        n = S['notes'][78842][0]
        n['html'] += '<p class="ck-text">readyToBill.quietDays = 400</p><p class="ck-text">Wendy says hello</p>'
        S['log'] = []
        ctx, pg, errors = await open_pg(browser, 'Wendy Pritchard')
        await pg.wait_for_function("UPC.settings.readAt() > 0", timeout=20000)
        await open_clinic(pg)
        view = await pg.evaluate("({ inputs: document.querySelectorAll('.upc-ss-clinic input').length, save: !!document.querySelector('[data-a=save]'), text: document.querySelector('.upc-ss-clinic').textContent })")
        check('others: values shown, no boxes or Save', view['inputs'] == 0 and not view['save'] and '09:15' in view['text'] and 'Only Carl Healy can change them' in view['text'], view)
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
