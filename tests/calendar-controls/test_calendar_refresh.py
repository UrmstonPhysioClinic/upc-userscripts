"""
Test for calendar controls' refresh (picking up changes made on other PCs), on a minimal mock
calendar. Checks that it refreshes when nothing else does, never duplicates a calendar load that
just happened (for example Halaxy's own refresh), and stays quiet while Halaxy has asked scripts
to pause. Other calendar features need the real Halaxy calendar and aren't covered here.

Run:  python3 tests/calendar-controls/test_calendar_refresh.py [path/to/calendar-controls.user.js]   (default: beta)
Needs: Python 3 with Playwright (Chromium); npm (installs jQuery on first run).
"""
import asyncio, subprocess, sys, urllib.parse
from pathlib import Path
from playwright.async_api import async_playwright

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SCRIPT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'beta' / 'calendar-controls.user.js'
if not (HERE / 'node_modules' / 'jquery').exists():
    subprocess.run(['npm', 'install', '--no-audit', '--no-fund', '--no-package-lock', '--silent'], cwd=HERE, check=True)
JQUERY = (HERE / 'node_modules' / 'jquery' / 'dist' / 'jquery.min.js').read_text()
CORE = (ROOT / 'beta' / 'core.user.js').read_text()

PAGE = """<!doctype html><html><head><script>JQUERY</script><script>
  var f = function () {};
  var attrs = { mode: 'week', SdDay: 900, SdWeek: 900, slotDelta: 900 };
  window.HkUser = { readOnly: false };
  window.hk_glob = { preferences: { timeFormat: 'H:i' } };
  window.HealthKit = { getThemeFontSize: function () { return 'regular'; }, swapPrac: f };
  window.HkCalendar = {
    PathForEventJSON: '/a/pr/555/calendar/json', PathForNewEvent: '/x', PathForNewAppointment: '/y',
    preferences: { calendar_view_time_from: '08:00:00', calendar_view_time_to: '21:00:00' },
    timeslotHeights: {}, defaultPXHeight: 25, PXHeight: 1,
    calendarModel: { get: function (k) { return attrs[k]; }, set: function (o) { Object.assign(attrs, o); }, on: f },
    getEventUrlQueryParams: function () { return { start: 1000, end: 2000 }; },
    eventsView: { model: { models: [], where: function () { return null; } }, render: f },
    Timeline: { position: f, tick: f }, Toolbar: { zoomIn: f, zoomOut: f }, updateSingleEvent: f,
    Grid: { getCalendarData: f }, calMenu: { refresh: f }, Render: { resizeCalendar: f },
    RenderPrac: { toggleMultiPrac: f, renderMultiPracCalendar: f }, initForPrac: f
  };
  document.addEventListener('DOMContentLoaded', function () {
    HkCalendar.initForPrac(new Date(), {
      calendar_view_time_from: '08:00:00', calendar_view_time_to: '21:00:00', calendar_hide_cancelled: '0', calendar_show_days: '1',
      calendar_start_week_on: '0', calendar_prac_selection: 1, show_status_colour: '0', show_note_status: '1', payment_status_label: '0',
      show_invoice_sent: '1', show_appointment_description: '0', show_patient_balance: '1', show_new_patient_icon: '1',
      show_patient_age: '0', show_patient_arrival_icon: '1', show_patient_name: '0' });
    if (location.search.indexOf('halaxyPolls') >= 0) {
      // Stand-in for Halaxy loading the calendar itself (its own refresh, or someone changing date).
      setInterval(function () { $.getJSON('/a/pr/555/calendar/json', { start: 1000, end: 2000, src: 'halaxy' }); }, 400);
    }
  });
</script></head><body><div id="calendarViewPort"><div class="cal"><div class="timeLabel">08:00</div><div class="timeslot" ts="28800"></div></div></div></body></html>"""

COUNT = {'ours': 0, 'halaxy': 0}
FAILS = []
def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)))
    if not ok:
        FAILS.append(name)


async def halaxy(route):
    u = urllib.parse.urlparse(route.request.url)
    if u.path.endswith('/calendar/json'):
        COUNT['halaxy' if 'src=halaxy' in u.query else 'ours'] += 1
        return await route.fulfill(body='{"status":"OK","payload":{"events":[]}}', content_type='application/json')
    if u.path.endswith('/calendar/preferences'):
        return await route.fulfill(body='{}', content_type='application/json')
    await route.fulfill(body=PAGE.replace('JQUERY', JQUERY), content_type='text/html')


async def run(browser, query='', core=False, paused=False, seconds=3.5):
    COUNT.update(ours=0, halaxy=0)
    ctx = await browser.new_context()
    await ctx.route('https://eu.halaxy.com/**', halaxy)
    await ctx.add_init_script('window.__upcCalendarTest = { refreshSeconds: 1 };')
    if paused:
        await ctx.add_init_script("localStorage.setItem('upc-pace:pausedUntil', JSON.stringify(Date.now() + 600000));")
    if core:
        await ctx.add_init_script(CORE)
    await ctx.add_init_script(SCRIPT.read_text())
    pg = await ctx.new_page()
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    await pg.goto('https://eu.halaxy.com/a/pr/555/calendar' + query)
    await pg.wait_for_timeout(int(seconds * 1000))
    await ctx.close()
    return dict(COUNT), errors


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        c, e = await run(browser)
        check('refreshes when nothing else loads the calendar', c['ours'] >= 2, c)
        check('no page errors', not e, e)
        c, e = await run(browser, '?halaxyPolls=1')
        check('never duplicates a calendar load that just happened', c['ours'] == 0 and c['halaxy'] >= 5, c)
        c, e = await run(browser, core=True)
        check('with the core library: still refreshes, through its pacing', c['ours'] >= 2 and not e, (c, e))
        c, e = await run(browser, core=True, paused=True)
        check('quiet while Halaxy has asked scripts to pause', c['ours'] == 0, c)
        await browser.close()
    print('\n%d failed' % len(FAILS) if FAILS else '\nAll passed')
    sys.exit(1 if FAILS else 0)

asyncio.run(main())
