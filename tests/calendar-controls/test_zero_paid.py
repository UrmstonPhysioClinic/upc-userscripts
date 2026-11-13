"""
Test for calendar controls' paid look on £0 invoices (Carl, 10 Nov 2026), on a minimal mock calendar.

Checks: an appointment whose invoice is £0 is drawn exactly as a paid one (payment status and icon class
taken from a paid appointment); unpaid appointments with something to pay and paid ones are untouched;
the amounts come from one invoice list request for the dates on screen; another tab uses the saved
answer without asking Halaxy again; nothing is asked while Halaxy has asked scripts to pause.

Run:  python3 tests/calendar-controls/test_zero_paid.py [path/to/calendar-controls.user.js]   (default: beta)
Needs: Python 3 with Playwright (Chromium); npm (installs jQuery on first run).
"""
import asyncio, json, subprocess, sys, urllib.parse
from pathlib import Path
from playwright.async_api import async_playwright

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SCRIPT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'beta' / 'calendar-controls.user.js'
if not (HERE / 'node_modules' / 'jquery').exists():
    subprocess.run(['npm', 'install', '--no-audit', '--no-fund', '--no-package-lock', '--silent'], cwd=HERE, check=True)
JQUERY = (HERE / 'node_modules' / 'jquery' / 'dist' / 'jquery.min.js').read_text()
CORE = (ROOT / 'beta' / 'core.user.js').read_text().replace('perMinute: 45,', 'perMinute: 100000,')   # tests: no 45-a-minute wait (the 300 ms gap stays)

EVENTS = [
    {'id': 11, 'type': 'appointment', 'invoiceID': 1, 'invoiceStatus': 'Paid In Full', 'invStatusCss': 'inv-paid', 'start': 1000, 'end': 1900},
    {'id': 12, 'type': 'appointment', 'invoiceID': 2, 'invoiceStatus': 'Manual Payments', 'invStatusCss': 'inv-unpaid', 'start': 1000, 'end': 1900},   # £0
    {'id': 13, 'type': 'appointment', 'invoiceID': 3, 'invoiceStatus': 'Stored Creditcard', 'invStatusCss': 'inv-unpaid', 'start': 1000, 'end': 1900},  # £40 due
    {'id': 14, 'type': 'personal', 'start': 1000, 'end': 1900},
]
ROWS = [{'id': 1, 'total': '40.00', 'invoiceDate': '01/01/1970'}, {'id': 2, 'total': '0.00', 'invoiceDate': '01/01/1970'},
        {'id': 3, 'total': '40.00', 'invoiceDate': '01/01/1970'}]

PAGE = """<!doctype html><html><head><script>JQUERY</script><script>
  var f = function () {};
  var attrs = { mode: 'week', SdDay: 900, SdWeek: 900, slotDelta: 900 };
  var models = [];
  window.HkUser = { readOnly: false };
  window.hk_glob = { preferences: { timeFormat: 'H:i' } };
  window.HealthKit = { getThemeFontSize: function () { return 'regular'; }, swapPrac: f };
  window.HkCalendar = {
    PathForEventJSON: '/a/pr/555/calendar/json', PathForNewEvent: '/x', PathForNewAppointment: '/y',
    preferences: { calendar_view_time_from: '08:00:00', calendar_view_time_to: '21:00:00' },
    timeslotHeights: {}, defaultPXHeight: 25, PXHeight: 1,
    calendarModel: { get: function (k) { return attrs[k]; }, set: function (o) { Object.assign(attrs, o); }, on: f },
    getEventUrlQueryParams: function () { return { start: 1000, end: 2000 }; },
    eventsView: { model: { models: models, where: function () { return null; } },
      render: function () { document.getElementById('ev').innerHTML = models.filter(function (m) { return m.type === 'appointment'; }).map(function (m) { return HkCalendar.tEvent(m); }).join(''); } },
    Timeline: { position: f, tick: f }, Toolbar: { zoomIn: f, zoomOut: f }, updateSingleEvent: f,
    Grid: { getCalendarData: f }, calMenu: { refresh: f }, Render: { resizeCalendar: f },
    RenderPrac: { toggleMultiPrac: f, renderMultiPracCalendar: f },
    initForPrac: function () {
      // As Halaxy: compile the appointment template at start-up, then load and draw the appointments.
      HkCalendar.tEvent = function (d) { return '<i data-id="' + d.id + '" class="' + d.invStatusCss + '" title="' + d.invoiceStatus + '">£</i>'; };
      $.getJSON('/a/pr/555/calendar/json', { start: 1000, end: 2000 }, function (j) { models.length = 0; j.payload.events.forEach(function (e) { models.push(e); }); HkCalendar.eventsView.render(); });
    }
  };
  document.addEventListener('DOMContentLoaded', function () { HkCalendar.initForPrac(new Date(), {}); });
</script></head><body><div id="ev"></div><div id="calendarViewPort"><div class="cal"><div class="timeLabel">08:00</div><div class="timeslot" ts="28800"></div></div></div></body></html>"""

LOG = []
FAILS = []
def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)))
    if not ok:
        FAILS.append(name)


async def halaxy(route):
    req = route.request
    u = urllib.parse.urlparse(req.url)
    if u.path.endswith('/calendar/json'):
        return await route.fulfill(body=json.dumps({'status': 'OK', 'payload': {'events': EVENTS}}), content_type='application/json')
    if u.path.endswith('/invoice/list-data'):
        LOG.append(json.loads(req.post_data or '{}'))
        return await route.fulfill(body=json.dumps({'rowData': ROWS, 'lastRow': len(ROWS)}), content_type='application/json')
    if u.path.endswith('/calendar/preferences'):
        return await route.fulfill(body='{}', content_type='application/json')
    await route.fulfill(body=PAGE.replace('JQUERY', JQUERY), content_type='text/html')


ICONS = "[...document.querySelectorAll('#ev i')].map((i) => i.dataset.id + ':' + i.className + ':' + i.title)"


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()

        ctx = await browser.new_context()
        await ctx.route('https://eu.halaxy.com/**', halaxy)
        await ctx.add_init_script(CORE)
        await ctx.add_init_script(SCRIPT.read_text())
        pg = await ctx.new_page()
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        await pg.goto('https://eu.halaxy.com/a/pr/555/calendar')
        await pg.wait_for_function("document.querySelector('#ev i[data-id=\"12\"]') && document.querySelector('#ev i[data-id=\"12\"]').className === 'inv-paid'", timeout=15000)
        icons = await pg.evaluate(ICONS)
        check('£0 appointment drawn as paid', '12:inv-paid:Paid In Full' in icons, icons)
        check('appointment with something to pay stays unpaid', '13:inv-unpaid:Stored Creditcard' in icons, icons)
        check('paid appointment unchanged', '11:inv-paid:Paid In Full' in icons, icons)
        check('one invoice list request, for the dates on screen', len(LOG) == 1 and LOG[0]['filterModel']['invoiceDate']['type'] == 'inRange', LOG)
        check('no page errors', not errors, errors)

        pg2 = await ctx.new_page()
        await pg2.goto('https://eu.halaxy.com/a/pr/555/calendar')
        await pg2.wait_for_selector('#ev i[data-id="12"]')
        await pg2.wait_for_timeout(1500)
        icons2 = await pg2.evaluate(ICONS)
        check('another tab draws it paid straight away, without asking Halaxy again', '12:inv-paid:Paid In Full' in icons2 and len(LOG) == 1, (icons2, LOG))
        await ctx.close()

        LOG.clear()
        ctx = await browser.new_context()
        await ctx.route('https://eu.halaxy.com/**', halaxy)
        await ctx.add_init_script("localStorage.setItem('upc-pace:pausedUntil', JSON.stringify(Date.now() + 600000));")
        await ctx.add_init_script(CORE)
        await ctx.add_init_script(SCRIPT.read_text())
        pg = await ctx.new_page()
        await pg.goto('https://eu.halaxy.com/a/pr/555/calendar')
        await pg.wait_for_selector('#ev i[data-id="12"]')
        await pg.wait_for_timeout(1500)
        check('nothing asked while Halaxy has asked scripts to pause', LOG == [] and '12:inv-unpaid:Manual Payments' in await pg.evaluate(ICONS), LOG)
        await ctx.close()
        await browser.close()

    print('\n%d failed' % len(FAILS) if FAILS else '\nAll passed')
    sys.exit(1 if FAILS else 0)

asyncio.run(main())
