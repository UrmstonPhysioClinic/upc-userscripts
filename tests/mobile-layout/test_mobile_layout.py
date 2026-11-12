"""Mobile layout: switched on only on phone-sized screens (or with ?hxm=1), once, and never on a PC. Invented page."""
import asyncio, pathlib, sys
from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = (ROOT / 'beta' / 'mobile-layout.user.js').read_text()
FAILS = []
def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)))
    if not ok:
        FAILS.append(name)

PAGE = "<!doctype html><html><head><meta charset='utf-8'></head><body><div id='headerWrapper'><div class='row'></div></div><nav id='mainMenu'><a href='#x'>Calendar</a></nav><div id='pageContent'></div></body></html>"

async def run(p, **ctx_opts):
    browser = await p.chromium.launch()
    ctx = await browser.new_context(**ctx_opts)
    await ctx.add_init_script(SCRIPT)
    await ctx.add_init_script(SCRIPT)   # a second copy (old stand-alone install left on) must not double up
    pg = await ctx.new_page()
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    await ctx.route('https://eu.halaxy.com/**', lambda r: r.fulfill(body=PAGE, content_type='text/html'))
    return browser, pg, errors

async def main():
    async with async_playwright() as p:
        browser, pg, errors = await run(p, viewport={'width': 1600, 'height': 900}, screen={'width': 1920, 'height': 1080})
        await pg.goto('https://eu.halaxy.com/a/pr/555/calendar')
        await pg.wait_for_timeout(300)
        check('PC: nothing changed', await pg.evaluate("!document.documentElement.classList.contains('hxl') && !document.getElementById('hxl-burger') && !document.getElementById('hxl-style')"))
        await pg.goto('https://eu.halaxy.com/a/pr/555/calendar?hxm=1')
        await pg.wait_for_timeout(300)
        check('PC with ?hxm=1: mobile layout for testing', await pg.evaluate("document.documentElement.classList.contains('hxl')"))
        check('no page errors (PC)', not errors, errors)
        await browser.close()

        browser, pg, errors = await run(p, **p.devices['iPhone 13'])
        await pg.goto('https://eu.halaxy.com/a/pr/555/calendar')
        await pg.wait_for_timeout(300)
        check('phone: mobile layout on, with the menu button', await pg.evaluate("document.documentElement.classList.contains('hxl') && !!document.getElementById('hxl-burger')"))
        check('phone: set up once even with two copies running', await pg.evaluate("document.querySelectorAll('#hxl-style').length === 1 && document.querySelectorAll('#hxl-burger').length === 1"))
        await pg.click('#hxl-burger')
        check('phone: the menu opens', await pg.evaluate("document.documentElement.classList.contains('hxl-menu-open')"))
        check('no page errors (phone)', not errors, errors)
        await browser.close()
    print('\n%d failed' % len(FAILS) if FAILS else '\nAll passed')
    sys.exit(1 if FAILS else 0)

asyncio.run(main())
