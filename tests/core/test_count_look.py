"""
Test for the core library's count look: our menu counts (span.upc-...-badge in a menu item) take the look of Halaxy's
own count on the bell (its ::after from data-count): size, font and colours, kept on the PC for pages without it; they
stay in place after the item's name. Invented page.

Run:  python3 tests/core/test_count_look.py
"""
import asyncio, sys
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
CORE = (ROOT / 'beta' / 'core.user.js').read_text()
FAILS = []


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)[:600]))
    if not ok:
        FAILS.append(name)


def page(bell):
    return ("<!doctype html><html><head><style>.upc-rr-badge{display:inline-block;min-width:18px;margin-left:6px;padding:0 5px;border-radius:9px;font-size:12px;line-height:18px;background:#ec6b65;color:#fff}"
            "a.alertIcon{position:relative}a.alertIcon[data-count]::after{content:attr(data-count);position:absolute;top:-12px;right:0;height:20px;font-size:12px;background-color:rgb(150,150,150);color:rgb(0,0,0)}"
            "#btn-alert-notifications{position:relative}#btn-alert-notifications[data-count]::after{content:attr(data-count);position:absolute;top:-3px;right:-5px;min-width:14px;height:14px;"
            "padding:0 3px;font-size:9px;line-height:14px;border-radius:7px;font-weight:700;background-color:rgb(10,20,30);color:rgb(250,250,250)}</style></head><body>"
            "<div id='alertHeader'><div id='alertIncomingMessages'><a id='btn-alert-incoming-messages' class='fa-stack alertIcon' href='javascript:' data-count='12'><i class='icon icon-inbox'></i></a></div>"
            "<div id='alertNotifications'><a id='btn-alert-notifications' class='fa-stack alertIcon' href='javascript:'" + (" data-count='9'" if bell else '') + "><i class='icon icon-alarm'></i></a></div></div>"
            "<ul id='mainMenu'><li><a class='mainmenu-sublink' href='#'>Review requests<span class='upc-rr-badge'>2</span></a></li></ul>"
            "<script>window.HkUser = { pracName: 'Carl Healy' };</script></body></html>")


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context()
        S = {'bell': True}
        await ctx.route('https://eu.halaxy.com/**', lambda route: route.fulfill(body=page(S['bell']), content_type='text/html'))
        await ctx.add_init_script(CORE)
        pg = await ctx.new_page()
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        look = "(() => { const b = getComputedStyle(document.querySelector('.upc-rr-badge')); return [b.fontSize, b.height, b.backgroundColor, b.color, b.fontWeight, b.position, b.marginLeft]; })()"
        await pg.goto('https://eu.halaxy.com/a/pr/555/calendar')
        await pg.wait_for_timeout(3200)
        got = await pg.evaluate(look)
        check("menu count takes the bell count's look (not the Inbox's, first in the bar), staying after the name", got == ['9px', '14px', 'rgb(10, 20, 30)', 'rgb(250, 250, 250)', '700', 'static', '6px'], got)
        S['bell'] = False
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/')
        await pg.wait_for_timeout(3200)
        got = await pg.evaluate(look)
        check('a page where the bell shows no count: the look kept from before', got[:4] == ['9px', '14px', 'rgb(10, 20, 30)', 'rgb(250, 250, 250)'], got)
        check('no page errors', not errors, errors)
        await browser.close()
    print('\n' + ('All passed' if not FAILS else '%d failed' % len(FAILS)))
    sys.exit(1 if FAILS else 0)


asyncio.run(main())
