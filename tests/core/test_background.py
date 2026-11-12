"""
Test for the core library's background rule (UPC.background): background checks run only in clinic hours (7 am to
9 pm) while someone has used the PC in the last 30 minutes, fall due at their interval give or take 15%, and a
check outside those times asks Halaxy for nothing.

Run:  python3 tests/core/test_background.py
"""
import asyncio, datetime, sys
from pathlib import Path
from zoneinfo import ZoneInfo
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
CORE = (ROOT / 'beta' / 'core.user.js').read_text()
IPD = (ROOT / 'beta' / 'insurer-payments-due.user.js').read_text()
LON = ZoneInfo('Europe/London')
FAILS = []


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)))
    if not ok:
        FAILS.append(name)


PAGE = "<!doctype html><html><body><div id='headerWrapper'></div><script>window.HkUser = { pracName: 'Carl Healy' };</script></body></html>"


async def page_at(browser, when, log):
    ctx = await browser.new_context(timezone_id='Europe/London')
    await ctx.clock.install(time=when)

    async def halaxy(route):
        log.append(route.request.url)
        await route.fulfill(body=PAGE, content_type='text/html')
    await ctx.route('https://eu.halaxy.com/**', halaxy)
    await ctx.add_init_script(CORE)
    await ctx.add_init_script("document.addEventListener('DOMContentLoaded', function () {\n" + IPD + "\n});")
    pg = await ctx.new_page()
    await pg.goto('https://eu.halaxy.com/a/pr/555/calendar')
    return ctx, pg


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        log = []
        ctx, pg = await page_at(browser, datetime.datetime(2026, 11, 11, 12, 0, tzinfo=LON), log)
        r = await pg.evaluate("({ active: UPC.background.active(), hours: UPC.background.inHours(), ok: UPC.background.ok() })")
        check('nobody has used the PC: not active, so no background checks', r == {'active': False, 'hours': True, 'ok': False}, r)
        await pg.mouse.move(50, 50)
        await pg.mouse.move(80, 90)
        r = await pg.evaluate("({ active: UPC.background.active(), ok: UPC.background.ok() })")
        check('after using the PC: background checks allowed', r == {'active': True, 'ok': True}, r)
        await pg.clock.fast_forward(31 * 60 * 1000)
        r = await pg.evaluate("UPC.background.active()")
        check('30 minutes untouched: quiet again', r is False, r)
        due = await pg.evaluate("""(() => { const now = Date.now(), every = 3600e3; const f = [];
            for (let i = 1; i < 400; i++) { const last = now - i * 1000 * 37 - 1; let lo = 0, hi = 2 * every;
              // the shortest wait after last that counts as due
              while (hi - lo > 1000) { const mid = (lo + hi) / 2; const real = Date.now; Date.now = () => last + mid; const d = UPC.background.due(last, every); Date.now = real; if (d) hi = mid; else lo = mid; }
              f.push(hi / every); }
            return { min: Math.min(...f), max: Math.max(...f), spread: new Set(f.map((x) => x.toFixed(2))).size, never: UPC.background.due(0, every) }; })()""")
        check('due at the interval give or take 15%, varying from run to run', 0.85 <= due['min'] < 0.9 and 1.1 < due['max'] <= 1.151 and due['spread'] > 10 and due['never'] is True, due)
        await ctx.close()

        log = []
        ctx, pg = await page_at(browser, datetime.datetime(2026, 11, 11, 22, 30, tzinfo=LON), log)
        await pg.mouse.move(50, 50)
        r = await pg.evaluate("({ hours: UPC.background.inHours(), ok: UPC.background.ok() })")
        await pg.clock.fast_forward(20 * 1000)
        reads = [u for u in log if 'report/finance' in u]
        check('10.30 pm: outside clinic hours, no background reading of Halaxy', r == {'hours': False, 'ok': False} and not reads, (r, reads))
        await ctx.close()
        await browser.close()
    print('\n%d failed' % len(FAILS) if FAILS else '\nAll passed')
    sys.exit(1 if FAILS else 0)

asyncio.run(main())
