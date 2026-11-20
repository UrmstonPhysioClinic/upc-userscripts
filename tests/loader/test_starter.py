"""
Test for the starter (loader/upc-starter.user.js) with the loader, against a mock private GitHub (files only with the
access key) and a mock Halaxy page. Tampermonkey's functions are stood in for, as in test_loader.py.

Checks: with no key, nothing is fetched and the problem says so; with a key, the loader is fetched with it and run
straight away, and fetches the scripts with it too; on the next page the saved loader runs at document-start, before
the page; a loader on GitHub with a syntax error isn't saved and the old copy keeps running; a key expiring within 30
days, or refused, shows in the loader's problems (which the health check reads); the Tampermonkey menu has the
starter's items and the loader's panel.

Run:  python3 tests/loader/test_starter.py
"""
import asyncio, json, sys
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
STARTER = (ROOT / 'loader' / 'upc-starter.user.js').read_text()
LOADER = (ROOT / 'loader' / 'upc-loader.user.js').read_text()
RAW = 'https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/'
KEY = 'github_pat_TESTKEY'
FAILS = []
S = {'loader': LOADER, 'auth': [], 'expires': '2027-11-01 00:00:00 UTC'}


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)[:600]))
    if not ok:
        FAILS.append(name)


SCRIPT = ("// ==UserScript==\n// @name         UPC Billing: Hello\n// @version      1.0\n// @match        https://*.halaxy.com/*\n// ==/UserScript==\n"
          "window.__hello = true;\n")

STUBS = r"""
(function () {
  const K = 'tm:';
  window.GM_getValue = (k, d) => { const v = localStorage.getItem(K + k); return v === null ? d : JSON.parse(v); };
  window.GM_setValue = (k, v) => localStorage.setItem(K + k, JSON.stringify(v));
  window.GM_deleteValue = (k) => localStorage.removeItem(K + k);
  window.__tmMenu = [];
  window.GM_registerMenuCommand = (label, fn) => { window.__tmMenu.push(label); };
  window.GM_addElement = (parent, tag, attrs) => { const el = document.createElement(tag); el.textContent = attrs.textContent; parent.appendChild(el); return el; };
  window.GM_xmlhttpRequest = (o) => {
    fetch(o.url, { headers: o.headers || {} }).then((r) => r.text().then((t) => o.onload({ status: r.status, responseText: t,
      responseHeaders: [...r.headers.entries()].map(([k, v]) => k + ': ' + v).join('\r\n') }))).catch(() => o.onerror());
  };
})();
"""

PAGE = "<!doctype html><html><head><script>window.__pageScript = true; window.__loaderBeforePage = !!document.documentElement.getAttribute('data-upc-loader');</script></head><body>Mock Halaxy</body></html>"


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context()

        async def github(route):
            auth = route.request.headers.get('authorization', '')
            path = route.request.url.split('?')[0][len(RAW):]
            S['auth'].append((path, auth))
            if auth != 'token ' + KEY:
                return await route.fulfill(status=404, body='Not Found')
            if path == 'loader/upc-loader.user.js':
                return await route.fulfill(body=S['loader'], content_type='text/plain')
            if path == 'stable/scripts.json':
                return await route.fulfill(body=json.dumps({'scripts': [{'file': 'hello.user.js', 'name': 'Hello', 'version': '1.0'}]}), content_type='application/json')
            if path == 'stable/hello.user.js':
                return await route.fulfill(body=SCRIPT, content_type='text/plain')
            await route.fulfill(status=404, body='Not Found')

        async def api(route):
            ok = route.request.headers.get('authorization', '') == 'token ' + KEY
            await route.fulfill(status=200 if ok else 401, body='{}', content_type='application/json',
                                headers={'github-authentication-token-expiration': S['expires'], 'access-control-expose-headers': 'github-authentication-token-expiration'})

        await ctx.route(RAW + '**', github)
        await ctx.route('https://api.github.com/**', api)
        await ctx.route('https://eu.halaxy.com/**', lambda r: r.fulfill(body=PAGE, content_type='text/html'))
        await ctx.add_init_script(STUBS)
        await ctx.add_init_script(STARTER)
        pg = await ctx.new_page()
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))

        async def load(wait=1200):
            await pg.goto('https://eu.halaxy.com/a/pr/1/calendar')
            await pg.wait_for_timeout(wait)
            return await pg.evaluate("""() => ({ hello: !!window.__hello, before: window.__loaderBeforePage, menu: window.__tmMenu,
                err: JSON.parse(localStorage.getItem('tm:starter:error') || '""'), saved: !!localStorage.getItem('tm:starter:loader'),
                problems: JSON.parse(localStorage.getItem('upc-loader:lastProblems:stable') || '[]') })""")

        r = await load()
        check('no access key: nothing fetched, the problem says what to do', not r['saved'] and not r['hello'] and 'No access key' in r['err'], r)
        check('Tampermonkey menu: the starter\'s items', all(m in r['menu'] for m in ['UPC starter: access key', 'UPC starter: status', 'UPC starter: fetch the loader again']), r['menu'])

        await pg.evaluate("localStorage.setItem('tm:github-token', JSON.stringify(%s))" % json.dumps(KEY))
        S['auth'].clear()
        r = await load(2500)
        sent = {path: a for path, a in S['auth']}
        check('with a key: loader fetched and run straight away; the scripts fetched with the key too', r['saved'] and r['hello'] and r['err'] == ''
              and sent.get('loader/upc-loader.user.js') == 'token ' + KEY and sent.get('stable/hello.user.js') == 'token ' + KEY, (r, S['auth']))
        check('the loader\'s panel is in the menu, under the starter', 'UPC scripts: settings and updates' in r['menu'], r['menu'])

        r = await load()
        check('next page: the saved loader runs at document-start, before the page', r['hello'] and r['before'] is True, r)

        S['loader'] = LOADER.replace("const VERSION = '", "this is not javascript( const VERSION = '", 1)
        await pg.evaluate("localStorage.setItem('tm:starter:checked', '0')")
        r = await load(2500)
        check('a loader with a syntax error on GitHub: not saved, the old copy keeps running', r['hello'] and 'mistake' in r['err']
              and await pg.evaluate("JSON.parse(localStorage.getItem('tm:starter:loader')).indexOf('this is not javascript') < 0"), r)
        S['loader'] = LOADER

        S['expires'] = '2026-12-01 00:00:00 UTC'
        await pg.evaluate("localStorage.setItem('tm:starter:checked', '0'); localStorage.setItem('tm:starter:expiryChecked', '0'); localStorage.setItem('upc-loader:lastCheck:stable', '0')")
        await load(2500)
        await pg.evaluate("localStorage.setItem('upc-loader:lastCheck:stable', '0')")
        r = await load(2500)
        check('access key expiring within 30 days: shown in the loader\'s problems', any('expires on' in m for m in r['problems']), r['problems'])

        await pg.evaluate("localStorage.setItem('tm:github-token', JSON.stringify('wrong')); localStorage.setItem('tm:starter:checked', '0'); localStorage.setItem('upc-loader:lastCheck:stable', '0')")
        r = await load(2500)
        check('a refused key: saved scripts keep running; the problem says to add a new key', r['hello'] and 'refused the access key' in r['err']
              and any('Starter: GitHub refused' in m for m in r['problems']), r)
        check('no page errors', not errors, errors)
        await browser.close()
    print('\n' + ('All passed' if not FAILS else '%d failed' % len(FAILS)))
    sys.exit(1 if FAILS else 0)


asyncio.run(main())
