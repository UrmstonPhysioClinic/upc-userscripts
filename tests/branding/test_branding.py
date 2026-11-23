"""
Branding's modern look (UI/UX audit, 23 Nov 2026), against a mock Halaxy page.

Checks: capitals off on buttons (also Halaxy's .text-uppercase ones), tabs and card headings; buttons whose text
Halaxy typed in capitals become "Add appointment"; short capitals ("SMS") and names left alone; the footer link too;
card headings keep their own background; amounts with even-width digits; the focus ring; the modern look's own
switch (off: Branding's colours stay, the modern look goes).

Run:  python3 tests/branding/test_branding.py
"""
import asyncio, sys
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = (ROOT / 'beta' / 'branding.user.js').read_text()
FAILS = []


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)[:600]))
    if not ok:
        FAILS.append(name)


PAGE = """<!doctype html><html><head><style>
.btn { text-transform: uppercase; letter-spacing: .1em; } .text-uppercase { text-transform: uppercase !important; }
.card-header { background: rgb(240, 240, 245); text-transform: uppercase; } .nav-link { text-transform: uppercase; }
</style></head><body class='vs-theme vs-theme-milky-way'>
<ul class='nav nav-tabs'><li><a class='nav-link' href='#'>General</a></li></ul>
<a class='btn btn-primary text-uppercase' id='b1' href='#'>Add Appointment</a>
<a class='btn btn-outline-danger' id='b2' href='#'>DELETE</a>
<a class='btn btn-outline-primary' id='b3' href='#'>SMS</a>
<a class='btn btn-outline-primary' id='b4' href='#'>Carl Healy</a>
<div class='card'><div class='card-header' id='ch'>Practitioner Access</div><div class='card-body'><table class='table'><tbody><tr><td id='amt'>£ 1,111.00</td></tr></tbody></table></div></div>
<footer><a href='#' id='f1'>CONTACT US</a></footer>
</body></html>"""

STUBS = """window.__gm = JSON.parse(localStorage.getItem('gm') || '{}');
window.GM_getValue = (k, d) => (k in window.__gm ? window.__gm[k] : d);
window.GM_setValue = (k, v) => { window.__gm[k] = v; localStorage.setItem('gm', JSON.stringify(window.__gm)); };
window.GM_registerMenuCommand = () => {};"""


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context()
        await ctx.route('https://eu.halaxy.com/**', lambda r: r.fulfill(body=PAGE, content_type='text/html'))
        await ctx.add_init_script(STUBS)
        # As Tampermonkey's document-start: once <html> exists, before the page's content.
        await ctx.add_init_script("new MutationObserver((m, o) => { if (document.documentElement) { o.disconnect(); (function () {\n" + SCRIPT + "\n})(); } }).observe(document, { childList: true });")
        pg = await ctx.new_page()
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/9')
        await pg.wait_for_timeout(500)
        cs = lambda sel, prop: pg.evaluate("getComputedStyle(document.querySelector('%s'))['%s']" % (sel, prop))
        text = lambda sel: pg.evaluate("document.querySelector('%s').innerText" % sel)
        check('modern look on by default', await pg.evaluate("!!document.getElementById('upc-branding-polish')"))
        check("capitals off on Halaxy's .text-uppercase buttons", await cs('#b1', 'textTransform') == 'none' and await text('#b1') == 'Add Appointment', await text('#b1'))
        check('tabs and card headings in normal case', await cs('.nav-link', 'textTransform') == 'none' and await cs('#ch', 'textTransform') == 'none')
        check('a button typed in capitals reads "Delete"', await text('#b2') == 'Delete', await text('#b2'))
        check('short capitals and names left alone', await text('#b3') == 'SMS' and await text('#b4') == 'Carl Healy', (await text('#b3'), await text('#b4')))
        check('the footer link reads "Contact us"', await text('#f1') == 'Contact us', await text('#f1'))
        check("card headings keep their own background", await cs('#ch', 'backgroundColor') == 'rgb(240, 240, 245)', await cs('#ch', 'backgroundColor'))
        check('amounts with even-width digits', 'tabular-nums' in await cs('#amt', 'fontVariantNumeric'))
        await pg.keyboard.press('Tab')
        ring = await pg.evaluate("(() => { const a = document.activeElement; const s = getComputedStyle(a); return [a.tagName, s.outlineStyle, s.outlineWidth]; })()")
        check('a purple focus ring on what has keyboard focus', ring[1] == 'solid' and ring[2] == '2px', ring)
        check('no page errors', not errors, errors)

        await pg.evaluate("GM_setValue('polish', false)")
        await pg.reload()
        await pg.wait_for_timeout(500)
        check('modern look switched off: gone, Branding still on', not await pg.evaluate("!!document.getElementById('upc-branding-polish')") and await pg.evaluate("!!document.getElementById('upc-branding')") and await text('#b2') == 'DELETE', await text('#b2'))
        await browser.close()
    print('\n' + ('All passed' if not FAILS else '%d failed' % len(FAILS)))
    sys.exit(1 if FAILS else 0)


asyncio.run(main())
