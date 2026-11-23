"""
Core's progress bars (UPC.ui.run): a status that says how far along it is ("(6 of 10)", "(6 of about 10)") gives a bar
filled that far, and each redraw starts where the last bar was and slides to the new point over about a step's time
(at most 2 seconds); a status without a count is a moving "working" bar; run.html with a total fills the same way.

Run:  python3 tests/core/test_progress.py
"""
import asyncio, sys
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
CORE = (ROOT / 'beta' / 'core.user.js').read_text()
FAILS = []


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)[:500]))
    if not ok:
        FAILS.append(name)


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        pg = await browser.new_page()
        await pg.route('https://eu.halaxy.com/**', lambda r: r.fulfill(body="<!doctype html><html><body><div id='headerWrapper'></div><div class='upc-native' id='box'></div><script>window.HkUser = { pracName: 'Carl Healy' };</script></body></html>", content_type='text/html'))
        await pg.add_init_script(CORE)
        await pg.goto('https://eu.halaxy.com/a/pr/555/calendar')
        await pg.wait_for_function('!!(window.UPC && UPC.ui && UPC.ui.run)')
        bar = "(() => { const b = document.querySelector('#box .progress-bar'); return [b.className, b.style.width, b.style.transition]; })()"
        await pg.evaluate("document.getElementById('box').innerHTML = UPC.ui.run.inline('Reading notes (3 of 10)...')")
        await pg.wait_for_timeout(100)
        b1 = await pg.evaluate(bar)
        check('a count fills the bar that far', 'progress-bar-striped' not in b1[0] and b1[1] == '30%', b1)
        await pg.wait_for_timeout(600)
        await pg.evaluate("document.getElementById('box').innerHTML = UPC.ui.run.inline('Reading notes (6 of about 10)...')")
        start = await pg.evaluate("document.querySelector('#box .progress-bar').style.width")
        await pg.wait_for_timeout(100)
        b2 = await pg.evaluate(bar)
        check('the next step starts where the last bar was and slides on over about a step\'s time', b2[1] == '60%' and b2[2].startswith('width') and 'linear' in b2[2]
              and 300 <= int(b2[2].split(' ')[1].rstrip('ms')) <= 2000, (start, b2))
        # A redraw mid-step (same count) carries on from where the slide has got to, not from its end.
        mid = await pg.evaluate("(() => { document.getElementById('box').innerHTML = UPC.ui.run.inline('Reading notes (6 of about 10)...'); return document.querySelector('#box .progress-bar').style.width; })()")
        await pg.wait_for_timeout(50)
        b2b = await pg.evaluate(bar)
        check('a redraw mid-step carries on the slide rather than snapping to its end', 30 < float(mid.rstrip('%')) < 60 and b2b[1] == '60%'
              and b2b[2].startswith('width') and 0 < int(b2b[2].split(' ')[1].rstrip('ms')) < 2000, (mid, b2b))
        await pg.wait_for_timeout(2100)
        done = await pg.evaluate("(() => { const b = document.querySelector('#box .progress-bar'); b.parentElement.style.cssText = 'display:block;width:200px'; return Math.round(100 * b.getBoundingClientRect().width / b.parentElement.getBoundingClientRect().width); })()")
        check('the slide ends at the step\'s point', done == 60, done)
        await pg.evaluate("document.getElementById('box').innerHTML = UPC.ui.run.inline('Reading the report...')")
        b3 = await pg.evaluate(bar)
        check('no count: a moving working bar', 'progress-bar-striped' in b3[0] and b3[1] == '100%', b3)
        await pg.evaluate("window.r = UPC.ui.run.start(4); UPC.ui.run.tick(r); document.getElementById('box').innerHTML = UPC.ui.run.html(r)")
        await pg.wait_for_timeout(100)
        b4 = await pg.evaluate(bar)
        check('a run with a total fills the same way', 'upc-bar' in b4[0] and b4[1] == '25%', b4)
        await browser.close()
    print('\n' + ('All passed' if not FAILS else '%d failed' % len(FAILS)))
    sys.exit(1 if FAILS else 0)


asyncio.run(main())
