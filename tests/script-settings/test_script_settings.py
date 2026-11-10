"""
Test for Script settings (beta/script-settings.user.js) with the real loader and core library.

Checks: "Script settings" sits in Halaxy's account menu above Log Out; scripts' options are listed in
its pop-up (grouped by script) and run from there; they stay out of the Tampermonkey menu, while the
loader's own entry stays; the scripts on this PC with their versions; switching a script off, stable
or beta, checking for updates; the Halaxy look; without the account menu the Tampermonkey menu is used.

Run:  python3 tests/script-settings/test_script_settings.py
Needs: Python 3 with Playwright (Chromium).
"""
import asyncio, json, sys
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
LOADER = (ROOT / 'loader' / 'upc-loader.user.js').read_text()
RAW = 'https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/'
FIXTURE = """// ==UserScript==
// @name         Fixture options (beta)
// @version      1.0
// @match        https://*.halaxy.com/*
// @run-at       document-start
// ==/UserScript==
GM_registerMenuCommand('Fixture: show results', function () { window.__fixtureRan = (window.__fixtureRan || 0) + 1; });
GM_registerMenuCommand('Fixture: on (click to turn off)', function () {});
"""
FILES = {'core.user.js': (ROOT / 'beta' / 'core.user.js').read_text(), 'fixture.user.js': FIXTURE,
         'script-settings.user.js': (ROOT / 'beta' / 'script-settings.user.js').read_text()}
ver = lambda code: [l.split()[-1] for l in code.splitlines() if '@version' in l][0]
name = lambda code: [l.split(None, 2)[2] for l in code.splitlines() if '@name' in l][0]

STUBS = r"""
(function () {
  const K = 'tm:';
  window.GM_getValue = (k, d) => { const v = localStorage.getItem(K + k); return v === null ? d : JSON.parse(v); };
  window.GM_setValue = (k, v) => localStorage.setItem(K + k, JSON.stringify(v));
  window.GM_deleteValue = (k) => localStorage.removeItem(K + k);
  window.__tmMenu = [];
  window.GM_registerMenuCommand = (label, fn) => { window.__tmMenu.push([label, fn]); };
  window.GM_addElement = (parent, tag, attrs) => { const el = document.createElement(tag); el.textContent = attrs.textContent; parent.appendChild(el); return el; };
  window.GM_xmlhttpRequest = (o) => { fetch(o.url).then((r) => r.text().then((t) => o.onload({ status: r.status, responseText: t }))).catch(() => o.onerror()); };
})();
"""
MENU = ("<div class='col-auto'><div id='practitioner-select' class='d-inline-block dropdown headerSegment ml-2'>"
        "<button id='activeUser' class='btn btn-practitioner dropdown-toggle' data-toggle='dropdown'>Carl Healy</button>"
        "<div class='dropdown-menu dropdown-menu-right'><a id='btn-user-select-logout' class='dropdown-item text-danger' href='/logout'>Log Out</a></div></div></div>")
PAGE = "<!doctype html><html><head><title>Calendar | Halaxy</title></head><body class='vs-theme'><div id='headerWrapper'>%s</div><ul id='mainMenu'></ul><h1>Calendar</h1></body></html>"

FAILS = []
def check(label, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + label + ('' if ok else '  ' + str(detail)[:600]))
    if not ok:
        FAILS.append(label)


async def setup(browser, with_menu=True):
    ctx = await browser.new_context(viewport={'width': 1300, 'height': 900})

    async def github(route):
        path = route.request.url.split('?')[0][len(RAW):]
        ch, _, f = path.partition('/')
        if f == 'scripts.json':
            return await route.fulfill(body=json.dumps({'scripts': [{'file': k, 'name': name(v), 'version': ver(v)} for k, v in FILES.items()]}), content_type='application/json')
        if f in FILES:
            return await route.fulfill(body=FILES[f], content_type='text/plain')
        await route.fulfill(status=404, body='not found')
    await ctx.route(RAW + '**', github)
    await ctx.route('https://eu.halaxy.com/**', lambda r: r.fulfill(body=PAGE % (MENU if with_menu else ''), content_type='text/html'))
    await ctx.add_init_script(STUBS)
    await ctx.add_init_script(LOADER)
    pg = await ctx.new_page()
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    for _ in range(2):   # first page fetches the scripts, the second runs the saved copies from the start
        await pg.goto('https://eu.halaxy.com/a/pr/555/calendar')
        await pg.wait_for_timeout(1500)
    await pg.wait_for_timeout(4500)   # the loader decides on the Tampermonkey menu 4 s after the page loads
    return ctx, pg, errors


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx, pg, errors = await setup(browser)

        menu = await pg.evaluate("[...document.querySelectorAll('#practitioner-select .dropdown-menu > *')].map(e => e.className + ':' + e.textContent)")
        check('Script settings in the account menu, above Log Out', menu[:3] == ['dropdown-item upc-script-settings:Script settings', 'dropdown-divider upc-script-settings-divider:',
                                                                              'dropdown-item text-danger:Log Out'], menu)
        tm = await pg.evaluate('window.__tmMenu.map(m => m[0])')
        check('scripts\' options left out of the Tampermonkey menu; the loader\'s own entry stays', tm == ['UPC scripts: settings and updates'], tm)

        await pg.click('.upc-script-settings')
        await pg.wait_for_selector('[data-upc-dialog="upc-script-settings"] table')
        root = "document.querySelector('[data-upc-dialog=\"upc-script-settings\"]')"
        groups = await pg.evaluate("[..." + root + ".querySelectorAll('.upc-ss-group')].map(g => g.innerText.replace(/\\s+/g, ' ').trim())")
        check('options grouped under the script name', groups == ['Fixture options Fixture: show results Fixture: on (click to turn off)'], groups)
        rows = await pg.evaluate("[..." + root + ".querySelectorAll('tbody tr')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())")
        check('scripts on this PC with versions', any('Fixture options' in r and '1.0 · running on this page' in r for r in rows) and len(rows) == 3, rows)
        look = await pg.evaluate("(() => { const r = " + root + "; return { native: r.classList.contains('upc-native'), shadow: !!r.shadowRoot, table: r.querySelector('table').className,"
                                 " radio: [...r.querySelectorAll('input[name=upc-ss-chan]')].filter(x => x.checked).map(x => x.value) }; })()")
        check('Halaxy look, stable ticked', look['native'] and not look['shadow'] and look['table'].startswith('table table-striped table-bordered') and look['radio'] == ['stable'], look)

        await pg.click('[data-upc-dialog="upc-script-settings"] [data-item]')
        check('an option runs from the pop-up', await pg.evaluate('window.__fixtureRan === 1') and await pg.evaluate("!" + root))

        await pg.click('.upc-script-settings')
        await pg.wait_for_selector('[data-upc-dialog="upc-script-settings"] table')
        await pg.click('[data-upc-dialog="upc-script-settings"] input[data-file="fixture.user.js"]')
        await pg.wait_for_selector('[data-upc-dialog="upc-script-settings"] .upc-warn')
        off = await pg.evaluate("JSON.parse(localStorage.getItem('upc-loader:off'))")
        check('switching a script off is saved and asks for a refresh', off == {'fixture.user.js': True}, off)
        await pg.click('[data-upc-dialog="upc-script-settings"] input[data-file="fixture.user.js"]')
        await pg.check('[data-upc-dialog="upc-script-settings"] input[value=beta]')
        await pg.wait_for_timeout(300)
        chan = await pg.evaluate("JSON.parse(localStorage.getItem('upc-loader:channel'))")
        check('beta chosen', chan == 'beta', chan)
        await pg.check('[data-upc-dialog="upc-script-settings"] input[value=stable]')
        await pg.wait_for_timeout(300)
        await pg.click('[data-upc-dialog="upc-script-settings"] [data-a=check]')
        await pg.wait_for_function(root + ".innerText.includes('Everything is up to date.')", timeout=20000)
        check('check for updates', True)
        check('no page errors', not errors, errors)
        await ctx.close()

        ctx, pg, errors = await setup(browser, with_menu=False)
        tm = await pg.evaluate('window.__tmMenu.map(m => m[0])')
        check('no account menu on the page: options go to the Tampermonkey menu', 'Fixture: show results' in tm, tm)
        await ctx.close()
        await browser.close()

    print('\n%d failed' % len(FAILS) if FAILS else '\nAll passed')
    sys.exit(1 if FAILS else 0)

asyncio.run(main())
