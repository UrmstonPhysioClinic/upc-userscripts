"""
Test for the Arrived button, against a mock Halaxy calendar (invented appointments). Clock: 23-Nov-2026 10:00.

Checks: right-clicking a Booked appointment today puts "Arrived" at the top of Halaxy's menu, and choosing it clicks
Halaxy's own Update status > Arrived link (nothing else); an appointment already arrived, cancelled, or on another day
gets no extra item; the sidebar of a Booked appointment today has an "Arrived" button by Rebook appointment, which asks
Halaxy for /calendar/appointment/{id}/patient/{patientID}/status/1/edit (the event's patientID, not the sidebar's
patient link) and then shows it is done; a refusal is said in a toast and the button can be pressed again.

Run:  python3 tests/arrived-button/test_arrived_button.py
"""
import asyncio, datetime, json, re, sys, urllib.parse
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
CORE = (ROOT / 'beta' / 'core.user.js').read_text().replace('perMinute: 45,', 'perMinute: 100000,')
SCRIPT = (ROOT / 'beta' / 'arrived-button.user.js').read_text()
NOW = datetime.datetime(2026, 11, 23, 10, 0, tzinfo=datetime.timezone.utc)
FAILS = []
S = {}


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)[:600]))
    if not ok:
        FAILS.append(name)


EVENTS = [
    {'id': 7001, 'patientID': 4001, 'linkPaGId': 9001, 'appointmentStatus': '', 'start': '2026-11-23T10:30:00'},
    {'id': 7002, 'patientID': 4002, 'linkPaGId': 9002, 'appointmentStatus': 'arrived', 'start': '2026-11-23T11:00:00'},
    {'id': 7003, 'patientID': 4003, 'linkPaGId': 9003, 'appointmentStatus': 'cancelled', 'start': '2026-11-23T12:00:00'},
    {'id': 7004, 'patientID': 4004, 'linkPaGId': 9004, 'appointmentStatus': '', 'start': '2026-11-24T09:00:00'},
]

PAGE = """<!doctype html><html><head><title>Calendar | Halaxy</title></head><body>
<div id='headerWrapper'></div><div id='cal'></div><div id='context-menu-area' class='position-absolute d-none'></div><div id='RightHandPanel'></div>
<script>
window.HkUser = { linkPrG: 11, pracID: 11, pracName: 'Reception Person' };
const EVENTS = %s;
window.HkCalendar = { eventsView: { model: { models: EVENTS.map((e) => ({ id: e.id, attributes: e, get: (k) => e[k] })) } }, updated: [], updateSingleEvent(id) { this.updated.push(id); } };
window.halaxyClicks = [];
window.showMenu = function (id) {
  const e = EVENTS.find((x) => x.id === id);
  const st = [['Booked', 3], ['Confirmed', 2], ['Arrived', 1], ['Cancelled', 4]].map(([n, k]) =>
    "<li><a class='dropdown-item ajax event-update' href='/a/pr/555/calendar/appointment/" + id + "/patient/" + e.patientID + "/status/" + k + "/edit'>" + n + "</a></li>").join('');
  const m = document.getElementById('context-menu-area');
  m.innerHTML = "<ul class='dropdown-menu show'><li><a class='dropdown-item' href='/a/pr/555/patient/" + e.linkPaGId + "'>Patient " + id + "</a></li><li class='dropdown-divider'></li>" +
    "<li class='dropdown-submenu'><a class='dropdown-item' href='#'>Update status</a><ul class='dropdown-menu'>" + st + "</ul></li><li><a class='dropdown-item' href='#'>Edit appointment</a></li></ul>";
  m.classList.remove('d-none');
  m.querySelectorAll('a.event-update').forEach((a) => a.addEventListener('click', (ev) => { ev.preventDefault(); window.halaxyClicks.push(a.getAttribute('href')); }));
};
window.showSidebar = function (id) {
  const e = EVENTS.find((x) => x.id === id);
  document.getElementById('RightHandPanel').innerHTML = "<div><a class='editAppointment btn icon pr-0' href='/a/pr/555/calendar/appointment/11/" + id + "/edit' data-appointmentid='" + id + "'></a>" +
    "<a class='name-underline-only-text' href='/a/pr/555/patient/" + e.linkPaGId + "'>Patient " + id + "</a>" +
    "<div class='upc-t-details'><div>Gender: <span>Female</span></div><div>Status: <span>Booked</span></div></div>" +
    "<div class='footer'><button class='btn btn-outline-primary rebook-appointment'>Rebook appointment</button></div></div>";
};
</script></body></html>""" % json.dumps(EVENTS)


async def halaxy(route):
    req = route.request
    p = urllib.parse.urlparse(req.url).path
    m = re.search(r'/calendar/appointment/(\d+)/patient/(\d+)/status/(\d+)/edit$', p)
    if m:
        S['status'].append(m.groups())
        await asyncio.sleep(0.3)
        if S.get('refuse'):
            return await route.fulfill(body=json.dumps({'status': 'FORM', 'message': '<p>No</p>'}), content_type='application/json')
        return await route.fulfill(body=json.dumps({'status': 'OK'}), content_type='application/json')
    await route.fulfill(body=PAGE, content_type='text/html')


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        S.update({'status': []})
        ctx = await browser.new_context(viewport={'width': 1300, 'height': 900}, timezone_id='Europe/London')
        await ctx.clock.install(time=NOW.isoformat())
        await ctx.route('https://eu.halaxy.com/**', halaxy)
        await ctx.add_init_script(CORE)
        await ctx.add_init_script("document.addEventListener('DOMContentLoaded', function () {\n" + SCRIPT + "\n});")
        pg = await ctx.new_page()
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        await pg.goto('https://eu.halaxy.com/a/pr/555/calendar')
        await pg.wait_for_function('!!window.upcArrivedButton')

        async def menu(id):
            await pg.evaluate('showMenu(%d)' % id)
            await pg.dispatch_event('#cal', 'contextmenu')
            await pg.wait_for_timeout(400)
            return await pg.evaluate("[...document.querySelectorAll('#context-menu-area > ul > li')].map((li) => li.firstElementChild ? li.firstElementChild.textContent : '')")

        items = await menu(7001)
        check('right-click, Booked today: "Arrived" at the top, under the patient\'s name', items == ['Patient 7001', '', 'Arrived', 'Update status', 'Edit appointment'], items)
        await pg.click('.upc-arrived-item')
        clicks = await pg.evaluate('halaxyClicks')
        check('choosing it clicks Halaxy\'s own Arrived link, nothing else', clicks == ['/a/pr/555/calendar/appointment/7001/patient/4001/status/1/edit'] and not S['status'], (clicks, S['status']))
        for id, why in [(7002, 'already arrived'), (7003, 'cancelled'), (7004, 'tomorrow')]:
            items = await menu(id)
            check('no extra item when ' + why, 'Arrived' not in items, items)

        await pg.evaluate('showSidebar(7001)')
        await pg.wait_for_selector('#RightHandPanel .upc-arrived-btn')
        order = await pg.evaluate("[...document.querySelector('#RightHandPanel .footer').children].map((b) => b.textContent)")
        check('sidebar, Booked today: "Arrived" by Rebook appointment', order == ['Arrived', 'Rebook appointment'], order)
        await pg.click('#RightHandPanel .upc-arrived-btn')
        await pg.wait_for_function("document.querySelector('#RightHandPanel .upc-arrived-btn').classList.contains('btn-outline-primary')", timeout=10000)
        btn = await pg.evaluate("(() => { const b = document.querySelector('#RightHandPanel .upc-arrived-btn'); return [b.textContent, b.disabled]; })()")
        check('it asks Halaxy with the event\'s patientID (not the sidebar\'s patient link), then shows it is done', S['status'] == [('7001', '4001', '1')] and btn == ['Arrived', True], (S['status'], btn))
        side = await pg.evaluate("[document.querySelector('.upc-t-details').textContent, HkCalendar.updated]")
        check('then the sidebar\'s Status reads Arrived (nothing else changed) and the calendar reads the appointment again', side == ['Gender: FemaleStatus: Arrived', [7001]], side)
        for id in (7002, 7004):
            await pg.evaluate('showSidebar(%d)' % id)
            await pg.wait_for_timeout(300)
            check('no sidebar button for appointment %d' % id, not await pg.evaluate("!!document.querySelector('#RightHandPanel .upc-arrived-btn')"))

        S['refuse'] = True
        await pg.evaluate("EVENTS[0].appointmentStatus = ''; showSidebar(7001)")
        await pg.wait_for_selector('#RightHandPanel .upc-arrived-btn')
        await pg.click('#RightHandPanel .upc-arrived-btn')
        await pg.wait_for_function("document.querySelector('.upc-toast')", timeout=10000)
        t = await pg.evaluate("[document.querySelector('.upc-toast').textContent, document.querySelector('#RightHandPanel .upc-arrived-btn').disabled]")
        check('refused: said in a toast, the button can be pressed again', t[0].startswith('Not marked as arrived:') and t[1] is False, t)
        st = await pg.evaluate("document.querySelector('.upc-t-details').textContent")
        check('refused: the sidebar still says Booked', st == 'Gender: FemaleStatus: Booked', st)
        check('no page errors', not errors, errors)
        await browser.close()
    print('\n' + ('All passed' if not FAILS else '%d failed' % len(FAILS)))
    sys.exit(1 if FAILS else 0)


asyncio.run(main())
