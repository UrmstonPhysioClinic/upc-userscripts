"""
Test for Alerts, with two Halaxy tabs open on a mock page.

Checks: an arrival chimes once across both tabs; chat toasts don't chime; a chat message sounds
once and repeats once per cycle across both tabs; a click in one tab stops the alarm in both;
switching a sound off from the menu works.

Run:  python3 tests/alerts/test_alerts.py [path/to/alerts.user.js]   (default: beta)
Needs: Python 3 with Playwright (Chromium).
"""
import asyncio, sys
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'beta' / 'alerts.user.js'

STUBS = r"""
window.GM_getValue = (k, d) => { const v = localStorage.getItem('tm:' + k); return v === null ? d : JSON.parse(v); };
window.GM_setValue = (k, v) => localStorage.setItem('tm:' + k, JSON.stringify(v));
window.__menu = [];
window.GM_registerMenuCommand = (l, f) => window.__menu.push(l);
window.__hxAlertsTest = { repeatSeconds: 1 };
window.__plays = 0;
HTMLMediaElement.prototype.play = function () { window.__plays++; return Promise.resolve(); };
"""
PAGE = "<!doctype html><html><body><span id='btn-chat-popover-open' data-count='0'></span><div id='toasts'></div></body></html>"
ARRIVAL = ("document.getElementById('toasts').insertAdjacentHTML('beforeend', \"<div class='toast'><div class='toast-header'>"
           "<i class='header-icon icon-map-marker-solid'></i><h3>Patient has arrived</h3></div></div>\")")
CHAT_TOAST = ("document.getElementById('toasts').insertAdjacentHTML('beforeend', \"<div class='toast'><div class='toast-header'>"
              "<i class='header-icon icon-comment'></i><h3>Prac One</h3></div></div>\")")

FAILS = []
def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)))
    if not ok:
        FAILS.append(name)


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context()
        await ctx.route('https://eu.halaxy.com/**', lambda r: r.fulfill(body=PAGE, content_type='text/html'))
        await ctx.add_init_script(STUBS)
        # Started after the page loads, as the loader does for scripts without @run-at.
        await ctx.add_init_script("document.addEventListener('DOMContentLoaded', function () {\n" + SCRIPT.read_text() + "\n});")
        tabs = [await ctx.new_page(), await ctx.new_page()]
        for t in tabs:
            await t.goto('https://eu.halaxy.com/a/pr/1/calendar')
        await tabs[0].wait_for_timeout(1200)   # sounds are rendered on load

        async def plays():
            return sum([await t.evaluate('window.__plays') for t in tabs])

        async def both(js):
            await asyncio.gather(*[t.evaluate(js) for t in tabs])

        await both(ARRIVAL)
        await tabs[0].wait_for_timeout(500)
        check('arrival chimes once across two tabs', await plays() == 1, await plays())

        await both(CHAT_TOAST)
        await tabs[0].wait_for_timeout(500)
        check('chat toast does not chime', await plays() == 1, await plays())

        await both("document.getElementById('btn-chat-popover-open').setAttribute('data-count', '1')")
        await tabs[0].wait_for_timeout(500)
        check('chat message sounds once across two tabs', await plays() == 2, await plays())
        await tabs[0].wait_for_timeout(1000)
        n = await plays()
        check('alarm repeats once per cycle, not once per tab', n == 3, n)
        await tabs[0].wait_for_timeout(1000)
        n = await plays()
        check('alarm keeps repeating until someone responds', n == 4, n)

        await tabs[0].click('body')
        await tabs[0].wait_for_timeout(2500)
        n2 = await plays()
        check('a click in one tab stops the alarm in both', n2 <= n + 1, (n, n2))

        menu = await tabs[0].evaluate('window.__menu')
        check('menu shows both switches', 'Arrival chime: on (click to turn off)' in menu and 'Chat alarm: on (click to turn off)' in menu, menu)

        await tabs[1].close()
        tabs = tabs[:1]
        await tabs[0].evaluate("localStorage.setItem('tm:arrivalChime', 'false')")
        await tabs[0].reload()
        await tabs[0].wait_for_timeout(1200)
        await tabs[0].evaluate(ARRIVAL)
        await tabs[0].wait_for_timeout(500)
        check('arrival chime switched off', await plays() == 0, await plays())
        check('menu shows it off', 'Arrival chime: off (click to turn on)' in await tabs[0].evaluate('window.__menu'))
        await tabs[0].evaluate("document.getElementById('btn-chat-popover-open').setAttribute('data-count', '1')")
        await tabs[0].wait_for_timeout(400)
        check('chat alarm still on', await plays() == 1, await plays())
        await browser.close()

    print('\n%d failed' % len(FAILS) if FAILS else '\nAll passed')
    sys.exit(1 if FAILS else 0)

asyncio.run(main())
