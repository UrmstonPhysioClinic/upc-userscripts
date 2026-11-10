"""
Test for the forecourt lights reminder.

Checks: sunset for Urmston against the astral library over a year (within 2 minutes); the on time is
sunset minus 30 minutes rounded down to 15; the reminders (on, adjust, set, clock change, heads-up,
off the next day and until done, nothing on a following clinic evening, summer said once, skipped
dates, nothing before the reminder time, nothing when switched off); the pop-up (Done records the
timer's on time, Remind me later hides it for an hour); the settings pop-up; no requests to Halaxy.

Run:  python3 tests/forecourt-lights/test_forecourt_lights.py
Needs: Python 3 with Playwright (Chromium) and astral (pip install astral).
"""
import asyncio, datetime, json, sys
from pathlib import Path
from zoneinfo import ZoneInfo
from astral import LocationInfo
from astral.sun import sun
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
CORE = (ROOT / 'beta' / 'core.user.js').read_text()
SCRIPT = (ROOT / 'beta' / 'forecourt-lights.user.js').read_text()
GM = """
window.GM_getValue = function (k, d) { var v = localStorage.getItem('upc-gm:fl:' + k); return v === null ? d : JSON.parse(v); };
window.GM_setValue = function (k, v) { localStorage.setItem('upc-gm:fl:' + k, JSON.stringify(v)); };
window.GM_registerMenuCommand = function () {};
"""
PAGE = ("<!doctype html><html><head><title>Calendar | Halaxy</title><script>window.HkUser = { pracName: 'Wendy Pritchard' };</script></head>"
        "<body><ul id='mainMenu'></ul><h1>Calendar</h1></body></html>")
LON = ZoneInfo('Europe/London')
URMSTON = LocationInfo('Urmston', 'England', 'Europe/London', 53.45, -2.35)

FAILS = []
def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)[:700]))
    if not ok:
        FAILS.append(name)

REQS = []
async def halaxy(route):
    REQS.append(route.request.url)
    await route.fulfill(body=PAGE, content_type='text/html')

def at(s):   # London wall time -> epoch ms
    return int(datetime.datetime.fromisoformat(s).replace(tzinfo=LON).timestamp() * 1000)

BASE = {'enabled': True, 'days': [False, True, False, False, False, False, False], 'offTime': '20:45', 'offset': 30, 'noticeTime': '09:00', 'skip': [], 'timerOn': '15:45'}
ST = {'lastOffset': 0, 'done': {}, 'snoozeUntil': 0, 'summerSaid': None}


async def due(pg, when, s=None, st=None, user='Wendy Pritchard'):
    s = dict(BASE, **(s or {}))
    st = dict(ST, **(st or {}))
    return await pg.evaluate("([t, s, st, u]) => window.upcForecourtLights.due(t, s, st, u)", [at(when), s, st, user])


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(timezone_id='Europe/London')
        await ctx.route('https://eu.halaxy.com/**', halaxy)
        await ctx.add_init_script(GM + CORE)
        await ctx.add_init_script(GM + SCRIPT)
        pg = await ctx.new_page()
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        await pg.goto('https://eu.halaxy.com/a/pr/555/calendar')
        await pg.wait_for_function('window.upcForecourtLights')

        # Sunset against astral, every 5 days for a year
        days = [datetime.date(2026, 11, 1) + datetime.timedelta(days=i) for i in range(0, 366, 5)]
        ours = await pg.evaluate("(ds) => ds.map((d) => window.upcForecourtLights.sunsetMinutes(d))", [d.isoformat() for d in days])
        worst = max(abs(o - (lambda t: t.hour * 60 + t.minute + t.second / 60)(sun(URMSTON.observer, date=d, tzinfo=LON)['sunset'])) for o, d in zip(ours, days))
        check('sunset within 2 minutes of astral all year (worst %.1f min)' % worst, worst <= 2, worst)
        plan = await pg.evaluate("window.upcForecourtLights.plan('2026-11-10', { offset: 30, offTime: '20:45' })")
        check('10-Nov-2026: sunset 16:20, lights on 15:45 (16:20 - 30 = 15:50, down to 15:45)', plan['sunset'] in (980, 981) and plan['on'] == 945 and plan['needed'], plan)

        # Reminders
        r = await due(pg, '2026-11-10T08:30', {'noticeTime': '09:00'})
        check('nothing before the reminder time', r is None, r)
        r = await due(pg, '2026-11-10T10:00')
        check('clinic evening: turn on, with the times', r and r['kind'] == 'on' and 'Lights on 15:45 to 20:45.' in r['lines'][0] and len(r['lines']) == 1, r)
        r = await due(pg, '2026-11-10T10:00', {'enabled': False})
        check('nothing when switched off on this PC', r is None, r)
        r = await due(pg, '2026-11-10T10:00', {'who': ['Wendy Pritchard']}, None, 'Stephen Sharples')
        check('only the people ticked are reminded', r is None, r)
        r = await due(pg, '2026-11-10T10:00', {'who': ['Wendy Pritchard']}, None, 'Wendy Pritchard')
        check('a ticked person is reminded', r and r['kind'] == 'on', r)
        r = await due(pg, '2026-11-10T10:00', {'timerOn': '16:00'})
        check('adjust when the on time has moved', r and 'move the on time from 16:00 to 15:45' in ' '.join(r['lines']), r)
        r = await due(pg, '2026-11-10T10:00', {'timerOn': None})
        check('set the on time when not known', r and "Set the timer's on time to 15:45" in ' '.join(r['lines']), r)
        r = await due(pg, '2026-11-10T10:00', None, {'lastOffset': 60})
        check('clock change since the last reminder', r and 'the clocks went back 1 hour on Sunday 25-Oct-2026' in ' '.join(r['lines']), r)
        r = await due(pg, '2026-10-22T10:00', {'days': [False, True, False, True, False, False, False], 'timerOn': None}, {'lastOffset': 60})
        check('heads-up on the last clinic evening before a change', r and 'the clocks go back 1 hour on Sunday 25-Oct-2026' in ' '.join(r['lines']), r)
        r = await due(pg, '2026-10-20T10:00', {'days': [False, True, False, True, False, False, False], 'timerOn': None}, {'lastOffset': 60})
        check('no heads-up when another clinic evening comes first', r and 'Heads-up' not in ' '.join(r['lines']), r)
        r = await due(pg, '2026-11-11T10:00')
        check('day after: turn off', r and r['kind'] == 'off' and r['key'] == '2026-11-10:off' and 'OFF' in r['lines'][0], r)
        r = await due(pg, '2026-11-12T10:00')
        check('off stays until done', r and r['key'] == '2026-11-10:off', r)
        r = await due(pg, '2026-11-12T10:00', None, {'done': {'2026-11-10:off': True}})
        check('nothing once turned off', r is None, r)
        r = await due(pg, '2026-11-11T10:00', {'days': [False, True, True, False, False, False, False]})
        check('no off when the next day is a clinic evening too', r and r['kind'] == 'on', r)
        r = await due(pg, '2026-11-10T10:00', {'skip': ['2026-11-10']}, {'done': {'2026-11-03:off': True}})
        check('skipped date: no reminder', r is None, r)
        r = await due(pg, '2026-06-16T10:00', None, {'lastOffset': 60})
        check('summer: lights not needed, said with when they are next needed', r and r['kind'] == 'summer' and 'aren\'t needed' in r['lines'][0] and 'next needed from' in r['lines'][1], r)
        r = await due(pg, '2026-06-16T10:00', None, {'lastOffset': 60, 'summerSaid': '2026-06-09'})
        check('summer: said only once', r is None, r)
        r = await due(pg, '2026-06-17T10:00', None, {'lastOffset': 60})
        check('summer: no off reminder', r is None, r)

        # Pop-up on the page
        await ctx.close()
        ctx = await browser.new_context(timezone_id='Europe/London')
        await ctx.clock.install(time=datetime.datetime(2026, 11, 10, 10, 0, tzinfo=LON))
        await ctx.route('https://eu.halaxy.com/**', halaxy)
        await ctx.add_init_script(GM + "localStorage.getItem('upc-gm:fl:settings') || localStorage.setItem('upc-gm:fl:settings', %s); localStorage.getItem('upc-gm:fl:state') || localStorage.setItem('upc-gm:fl:state', %s);"
                                  % (json.dumps(json.dumps(dict(BASE, timerOn='16:00'))), json.dumps(json.dumps(ST))))
        await ctx.add_init_script(GM + CORE)
        await ctx.add_init_script(GM + SCRIPT)
        pg = await ctx.new_page()
        pg.on('pageerror', lambda e: errors.append(str(e)))
        REQS.clear()
        await pg.goto('https://eu.halaxy.com/a/pr/555/calendar')
        await pg.wait_for_selector('[data-upc-dialog="upc-forecourt-lights"]', timeout=10000)
        txt = await pg.evaluate("document.querySelector('[data-upc-dialog=\"upc-forecourt-lights\"]').innerText")
        check('pop-up shows the reminder', 'Turn the forecourt lights timer ON today.' in txt and 'from 16:00 to 15:45' in txt, txt)
        look = await pg.evaluate("(() => { const r = document.querySelector('[data-upc-dialog=\"upc-forecourt-lights\"]'); return r.classList.contains('upc-native') && !r.shadowRoot && !!r.querySelector('.btn.btn-primary'); })()")
        check('native look', look)
        await pg.click('[data-upc-dialog="upc-forecourt-lights"] [data-a=later]')
        await pg.reload()
        await pg.wait_for_timeout(3000)
        check('Remind me later hides it', await pg.evaluate("!document.querySelector('[data-upc-dialog=\"upc-forecourt-lights\"]')"))
        await pg.clock.fast_forward('01:01:00')
        await pg.reload()
        await pg.wait_for_selector('[data-upc-dialog="upc-forecourt-lights"]', timeout=10000)
        check('back after an hour', True)
        await pg.click('[data-upc-dialog="upc-forecourt-lights"] [data-a=done]')
        stored = await pg.evaluate("[GM_getValue('settings', {}), GM_getValue('state', {})]")
        check('Done records the new on time and the clock', stored[0].get('timerOn') == '15:45' and stored[1]['done'].get('2026-11-10:on') and stored[1].get('lastOffset') == 0, stored)
        await pg.reload()
        await pg.wait_for_timeout(3000)
        check('not shown again once done', await pg.evaluate("!document.querySelector('[data-upc-dialog=\"upc-forecourt-lights\"]')"))

        # Settings
        await pg.evaluate("window.upcForecourtLights.showSettings()")
        await pg.wait_for_selector('[data-upc-dialog="upc-forecourt-settings"]')
        rows = await pg.evaluate("document.querySelectorAll('[data-upc-dialog=\"upc-forecourt-settings\"] tbody tr').length")
        check('settings show the next two weeks', rows == 14, rows)
        await pg.check('[data-day="3"]')
        await pg.check('[data-who="Wendy Pritchard"]')
        await pg.fill('#upc-fl-skip', '25-Dec-2026\nnot a date')
        await pg.click('[data-upc-dialog="upc-forecourt-settings"] [data-a=save]')
        err = await pg.evaluate("document.querySelector('[data-upc-dialog=\"upc-forecourt-settings\"] [data-err]').textContent")
        check('a wrong date is explained, not saved', 'not a date' in err, err)
        await pg.fill('#upc-fl-skip', '25-Dec-2026\n2026-12-28')
        await pg.select_option('#upc-fl-timer', '15:30')
        await pg.click('[data-upc-dialog="upc-forecourt-settings"] [data-a=save]')
        s = await pg.evaluate("GM_getValue('settings', {})")
        check('settings saved', s['who'] == ['Wendy Pritchard'] and s['days'][3] and s['days'][1] and s['skip'] == ['2026-12-25', '2026-12-28'] and s['timerOn'] == '15:30' and s['enabled'], s)
        check('no requests to Halaxy beyond the page itself', all(u.startswith('https://eu.halaxy.com/a/pr/555/calendar') for u in REQS), REQS)
        check('no page errors', not errors, errors)
        await ctx.close()
        await browser.close()

    print('\n%d failed' % len(FAILS) if FAILS else '\nAll passed')
    sys.exit(1 if FAILS else 0)

asyncio.run(main())
