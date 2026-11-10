"""
Test for the health check, against a mock Halaxy that can be broken in specific ways.

Checks: a healthy Halaxy shows nothing; a missing calendar function, a missing invoice page
element, a missing calendar data field, a new appointment status, a script error and an update
problem are each reported with the scripts they affect; a Halaxy version change is noted and
triggers the data checks; nothing stored contains patient details.

Run:  python3 tests/health-check/test_health_check.py [path/to/health-check.user.js]   (default: beta)
Needs: Python 3 with Playwright (Chromium).
"""
import re
import asyncio, json, sys, time, urllib.parse
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'beta' / 'health-check.user.js'
STATE = {'version': '4.12', 'break': set()}

GLOBALS = r"""
<script>
  var f = function () {};
  window.jQuery = function () {}; jQuery.ui = { intersect: f }; jQuery.hkTypes = { Date: f };
  window.HkUser = { linkPrG: 11, pracID: 11 };
  window.hk_glob = { preferences: { timeFormat: 'H:i' }, variables: {} };
  window.HkCalendar = {
    initForPrac: f, calendarModel: { get: f }, PathForEventJSON: '/a/pr/555/calendar/json', PathForNewEvent: 'x', PathForNewAppointment: 'y',
    preferences: {}, timeslotHeights: {}, Timeline: { position: f, tick: f }, Toolbar: { zoomIn: f, zoomOut: f },
    updateSingleEvent: f, Grid: { getCalendarData: f }, getEventUrlQueryParams: f, tEvent: f, eventsView: { render: f },
    RenderPrac: { toggleMultiPrac: f, renderMultiPracCalendar: f }, Render: { resizeCalendar: f }, calMenu: { refresh: f }
  };
  window.HealthKit = { swapPrac: f, getThemeFontSize: f };
  window.CalendarSettingsPrac = { setModePracts: f, savePracState: f };
  window.HkUtils = { appendURL: f }; window.HkUI = { flash: { show: f } };
  BREAK
</script>"""
SIDEBAR = ("<nav id='sidebar' style='position:fixed;left:0;top:0;bottom:0;width:210px;z-index:1000;background:#222'>"
           "<ul id='mainMenu'><li>Reports</li></ul></nav>"
           # Like Halaxy's patient notes list: a panel at the bottom left, above the page's own layer
           "<div id='mockNotesList' style='position:fixed;left:210px;bottom:0;width:420px;height:520px;z-index:100;background:#eee'></div>")
CAL_BODY = (SIDEBAR + "<div id='alerts'></div><span id='btn-chat-popover-open'></span><div id='practitioner-select'><div class='dropdown-menu'></div></div>"
            "<div id='calToolbar'></div><button id='btnCalendarPreferences'></button><script type='text/template' id='tpl-event'></script>"
            "<div id='swapPracList'><input class='toggle-prac'></div><div id='calendarViewPort'><div class='cal'>"
            "<div class='timeLabel'>08:00</div><div class='timeslot' ts='1'></div></div></div><div id='footer'></div>")


def page(path):
    brk = ''
    if 'timeline' in STATE['break']:
        brk = 'delete HkCalendar.Timeline;'
    head = "<script src='https://cdn.halaxy.com/z/version/%s/build/app.js'></script>" % STATE['version'] + GLOBALS.replace('BREAK', brk)
    body = CAL_BODY if path.endswith('/calendar') else SIDEBAR
    if path.endswith('/calendar') and 'slow' in STATE['break']:   # calendar takes 2 s to draw
        body = body.replace("<div class='timeLabel'>08:00</div>", "") + ("<script>setTimeout(function () { document.querySelector('.cal')"
                ".insertAdjacentHTML('afterbegin', \"<div class='timeLabel'>08:00</div>\"); }, 2000);</script>")
    if '/invoice/' in path:
        body += "<table id='invoiceLines'></table>" + ('' if 'invoice' in STATE['break'] else "<table id='invoicePayments'></table>")
    return "<!doctype html><html><head>%s</head><body class='vs-theme vs-theme-milky-way'>%s</body></html>" % (head, body)


def events():
    now = int(time.time())
    out = []
    for i, (status, note) in enumerate([('', 'published-clinical-note'), ('cancelled', 'empty-clinical-note'), ('', 'draft-clinical-note'), ('check-response', 'published-clinical-note')]):
        if 'status' in STATE['break'] and i == 2:
            status = 'no-show'
        e = {'id': i, 'type': 'appointment', 'start': now - 3600 * i, 'end': now - 3600 * i + 1800, 'linkPaGId': 400 + i,
             'practitionerID': 11, 'invoiceID': 500 + i, 'noteID': 600 + i, 'colour': '#FEF2C0', 'appointmentStatus': status,
             'noteStatusCss': note, 'invoiceStatus': 'Paid In Full', 'invStatusCss': 'paid', 'isRequest': False, 'isGroupAppointment': False,
             'title': "<span class='name-text'>Patient 09:0%d</span>" % i}
        if 'field' in STATE['break']:
            del e['noteStatusCss']
        out.append(e)
    return out


async def halaxy(route):
    u = urllib.parse.urlparse(route.request.url)
    p = u.path
    if u.netloc == 'cdn.halaxy.com':
        return await route.fulfill(body='', content_type='application/javascript')
    j = lambda o: route.fulfill(body=json.dumps(o), content_type='application/json')
    if p.endswith('/lookup/practitioner'):
        return await j([{'id': 11, 'name': 'Prac One'}])
    if p.endswith('/funder/fee/data'):
        return await j([{'funder': 'Self-Funded', 'feeColour': '#FEF2C0', 'status': 'current'}])
    if p.endswith('/calendar/json'):
        return await j({'status': 'OK', 'payload': {'events': events()}})
    if '/patient/invoice/' in p and p.endswith('/list-data'):
        return await j([{'id': 501, 'total': 45, 'balance': 0, 'status': 'Paid In Full'}])
    if p.endswith('/task/task-followup/list/data'):
        return await j([{'id': 1, 'title': 'Review Request', 'status': 'Sent', 'linkedToUrl': '/a/pr/555/patient/1/'}])
    if re.search(r'/task/new/invoice/\d+$', p):
        f = "<form id='form_task_edit'><input name='form[title]'><select name='form[linkPrGs][]'><option value='31'>Carl Healy</option></select><input type='radio' name='form[priority]' value='2'>"
        f += ("" if 'task' in STATE['break'] else "<input name='form[displayDueDate]'>") + "<textarea name='form[comment]'></textarea><input type='hidden' name='form[_token]' value='t'></form>"
        return await j({'status': 'FORM', 'message': f})
    if re.search(r'/appointment/\d+$', p):
        good = "<div class='appointment-details-popup'><div class='subTitle'>Notes</div><div class='px-2'>x</div></div>"
        return await route.fulfill(body='<div></div>' if 'details' in STATE['break'] else good, content_type='text/html')
    if '/invoice/options/' in p:
        opts = "<option value=''>Active</option>" + ('' if 'settings' in STATE['break'] else "<option value='issued'>Issued</option>")
        return await j({'status': 'FORM', 'title': 'Invoice Settings', 'message': "<form id='frmInvoiceType'><select name='form[status]'>%s</select>"
                        "<input type='hidden' name='form[_token]' value='T'></form>" % opts})
    await route.fulfill(body=page(p), content_type='text/html')


FAILS = []
def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)))
    if not ok:
        FAILS.append(name)


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context()
        await ctx.route('https://eu.halaxy.com/**', halaxy)
        await ctx.route('https://cdn.halaxy.com/**', halaxy)
        await ctx.add_init_script("window.__hxHealthTest = { delay: 50 }; window.__menu = [];"
                                  "window.GM_registerMenuCommand = (l, f) => window.__menu.push([l, f]);")
        await ctx.add_init_script(SCRIPT.read_text())
        pg = await ctx.new_page()
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))

        async def load(path='/a/pr/555/calendar'):
            await pg.goto('https://eu.halaxy.com' + path)
            await pg.wait_for_timeout(1200)
            probs = await pg.evaluate('hxHealth.problems()')
            pill = await pg.evaluate("(document.querySelector('[data-hx-health]').querySelector('.upc-hc-pill') || {}).textContent || ''")
            return probs, pill

        # 1. Healthy
        probs, pill = await load()
        check('healthy Halaxy: no problems, no notice', probs == [] and pill == '', (probs, pill))
        # An older health check's saved result (a data problem, checked just now) is replaced at once by the new version
        await pg.evaluate("""(() => {
            const r = JSON.parse(localStorage.getItem('upc-health:results') || '{}');
            r['data-calendar'] = { title: 'Calendar data', scripts: ['Outstanding Actions'], problems: ['old version complaint'], at: Date.now(), page: 'data' };
            r['reports'] = { title: "Halaxy's table builder", scripts: ['Custom Reports', 'Remittances'], problems: ['HxGridTable()'], at: Date.now(), page: '/a/pr/:n/report/referral/:n' };
            localStorage.setItem('upc-health:resultsBy', JSON.stringify('0.0.1'));
            localStorage.setItem('upc-health:results', JSON.stringify(r));
            localStorage.setItem('upc-health:dataAt', JSON.stringify(Date.now()));
            localStorage.setItem('upc-health:dataBy', JSON.stringify('0.0.1'));
        })()""")
        probs2, pill2 = await load()
        check('new health check version re-checks at once, clearing the old results (data and page)', probs2 == [] and pill2 == '', (probs2, pill2))
        probs3, pill3 = await load()
        check('and then waits for the daily check again', await pg.evaluate("JSON.parse(localStorage.getItem('upc-health:dataBy'))") != '0.0.1' and probs3 == [], probs3)
        stored = await pg.evaluate("JSON.parse(localStorage.getItem('upc-health:halaxy'))")
        check('Halaxy version recorded', stored and stored['version'] == '4.12', stored)
        results = await pg.evaluate("JSON.parse(localStorage.getItem('upc-health:results'))")
        check('data checks ran', all(k in results for k in ('data-calendar', 'data-fees', 'data-practitioners', 'data-invoices')), list(results))
        await pg.evaluate("window.__menu.find(m => m[0] === 'Health check: show results')[1]()")
        txt = await pg.evaluate("document.querySelector('[data-hx-health]').textContent")
        check('menu opens results: all passed', 'All checks passed' in txt and 'Halaxy version 4.12' in txt, txt[:200])

        # 1b. Halaxy's table builder: checked only on the Finance report page (the mock pages don't have it)
        probs, pill = await load('/a/pr/555/report/appointment/new')
        check('no false alarm about the table builder on other report pages', not [p for p in probs if 'table builder' in p['title']], probs)
        probs, pill = await load('/a/pr/555/report/finance/')
        tb = [p for p in probs if 'table builder' in p['title']]
        check('missing table builder still reported on the Finance report page, for Custom Reports only', tb and tb[0]['scripts'] == ['Custom Reports'], tb)
        await pg.evaluate("(() => { const r = JSON.parse(localStorage.getItem('upc-health:results')); delete r.reports; localStorage.setItem('upc-health:results', JSON.stringify(r)); })()")

        # 2. Halaxy calendar code changed
        STATE['break'] = {'timeline'}
        probs, pill = await load()
        check('missing calendar function reported', any(x['title'] == "Halaxy's calendar code has changed" and 'HkCalendar.Timeline.position()' in x['lines']
                                                        and 'Calendar controls' in x['scripts'] for x in probs), probs)
        check('notice shown', pill == 'Clinic scripts: 1 problem', pill)
        await pg.evaluate("document.querySelector('[data-hx-health]').querySelector('.upc-hc-pill').click()")
        clear = await pg.evaluate("""() => {
            const sh = document.querySelector('[data-hx-health]');
            return ['.upc-hc-pill', '.upc-hc-panel'].map(s => {
                const r = sh.querySelector(s).getBoundingClientRect();
                return [[r.left + 2, r.top + 10], [r.left + r.width / 2, r.top + r.height / 2]]
                    .every(([x, y]) => sh.contains(document.elementFromPoint(x, y)));
            });
        }""")
        check('notice and panel are not hidden behind the side menu or side panels', clear == [True, True], clear)
        mid = await pg.evaluate("(() => { const r = document.querySelector('[data-hx-health] .upc-hc-pill').getBoundingClientRect(); return [r.left + r.width / 2, (210 + innerWidth) / 2]; })()")
        check('notice at the bottom centre of the content area', abs(mid[0] - mid[1]) <= 2, mid)
        STATE['break'] = set()
        probs, pill = await load()
        check('fixed on next calendar visit', probs == [] and pill == '', probs)

        # 3. Page checks only run where they apply
        STATE['break'] = {'invoice'}
        probs, _ = await load('/a/pr/555/invoice/123')
        check('invoice page element reported for Rebate Sync', any(x['title'] == 'Invoice page layout has changed' and 'Rebate Sync' in x['scripts'] for x in probs), probs)
        probs, _ = await load('/a/pr/555/patient/9')
        check('result kept until that page is visited again', len(probs) == 1, probs)
        STATE['break'] = set()
        await load('/a/pr/555/invoice/123')

        # 4. Halaxy update: data checks run straight away and catch data changes
        STATE['version'] = '4.13'
        STATE['break'] = {'field', 'status', 'settings', 'details', 'task'}
        probs, pill = await load()
        stored = await pg.evaluate("JSON.parse(localStorage.getItem('upc-health:halaxy'))")
        check('Halaxy update noted', stored['version'] == '4.13' and stored['previous'] == '4.12', stored)
        cal = [x for x in probs if x['title'] == 'Calendar data has changed']
        lines = cal[0]['lines'] if cal else []
        check('missing data field reported', 'field noteStatusCss' in lines, lines)
        check('new appointment status reported, with an example time to find it', any('no-show' in l and re.search(r'for example the appointment at \d\d:\d\d on \d\d-[A-Z][a-z]{2}-\d{4}', l) for l in lines), lines)
        check('check-response is a known status', not any('check-response' in l for l in lines), lines)
        tsk = [x for x in probs if x['title'] == 'Add-task pop-up has changed']
        check('add-task pop-up change reported for Remittances', tsk and 'Remittances' in tsk[0]['scripts'] and any('displayDueDate' in l for l in tsk[0]['lines']), tsk)
        det = [x for x in probs if x['title'] == 'Appointment details pop-up has changed']
        check('appointment details layout change reported for Bill funder', det and 'Bill funder' in det[0]['scripts'], det)
        sett = [x for x in probs if x['title'] == 'Invoice settings (cogwheel) has changed']
        check('cogwheel status change reported for Bill funder', sett and sett[0]['lines'] == ['no Issued status'] and 'Bill funder' in sett[0]['scripts'], sett)
        STATE['break'] = set()
        await pg.evaluate('hxHealth.run(true)')
        await pg.wait_for_timeout(500)
        check('cleared after a healthy check', await pg.evaluate('hxHealth.problems()') == [])

        # 5. Script errors and update problems
        await pg.evaluate("document.dispatchEvent(new CustomEvent('upc-loader-error', { detail: JSON.stringify({ file: 'calendar-controls.user.js', message: 'x is undefined' }) }))")
        probs = await pg.evaluate('hxHealth.problems()')
        check('script error reported by name', any(x['title'] == 'Calendar controls stopped with an error' for x in probs), probs)
        await pg.evaluate("localStorage.setItem('upc-loader:lastProblems:stable', JSON.stringify(['Could not reach GitHub']))")
        probs, pill = await load()
        check('update problem reported', any(x['title'] == 'Updates could not be fetched' for x in probs), probs)
        check('errors persist across pages', any(x['title'] == 'Calendar controls stopped with an error' for x in probs))
        await pg.evaluate("document.querySelector('[data-hx-health]').querySelector('.upc-hc-pill').click()")
        await pg.evaluate("document.querySelector('[data-hx-health]').querySelector('[data-act=clear]').click()")
        probs = await pg.evaluate('hxHealth.problems()')
        check('clear script errors', [x['title'] for x in probs] == ['Updates could not be fetched'], probs)

        # 6. Two tabs checking at once keep each other's results
        await pg.evaluate("Object.keys(localStorage).filter(k => k.startsWith('upc-health:')).forEach(k => localStorage.removeItem(k))")
        STATE['break'] = {'slow'}
        pg2 = await ctx.new_page()
        await pg.goto('https://eu.halaxy.com/a/pr/555/calendar')       # page checks wait for the calendar
        await pg2.goto('https://eu.halaxy.com/a/pr/555/patient/9')     # data checks run meanwhile
        await pg.wait_for_timeout(3500)
        keys = sorted((await pg.evaluate("JSON.parse(localStorage.getItem('upc-health:results'))")).keys())
        check('two tabs at once: page and data results both kept', 'calendar' in keys and 'data-calendar' in keys and 'data-run' in keys, keys)
        await pg2.close()
        STATE['break'] = set()

        # 6. No patient details stored
        dump = await pg.evaluate("JSON.stringify(Object.keys(localStorage).filter(k => k.startsWith('upc-health:')).map(k => localStorage.getItem(k)))")
        check('nothing stored contains patient details', 'Patient 09' not in dump and 'name-text' not in dump, dump[:300])
        check('no page errors', not errors, errors)
        await browser.close()

    print('\n%d failed' % len(FAILS) if FAILS else '\nAll passed')
    sys.exit(1 if FAILS else 0)

asyncio.run(main())
