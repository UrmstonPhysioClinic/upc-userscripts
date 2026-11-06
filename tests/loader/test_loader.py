"""
Test for the loader (loader/upc-loader.user.js), against a mock GitHub and a mock Halaxy page.

Tampermonkey's functions (GM_getValue, GM_xmlhttpRequest, GM_addElement and so on) are stood in
for by simple versions, so this tests the loader's own logic: what runs, when, and how updates,
channels, switches and failures behave. How real Tampermonkey in Firefox injects scripts can only
be checked on a real PC.

Run:  python3 tests/loader/test_loader.py
Needs: Python 3 with Playwright (Chromium).
"""
import asyncio, json, sys
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
LOADER = (ROOT / 'loader' / 'upc-loader.user.js').read_text()
RAW = 'https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/'


def script(name, version, body, run_at=None, match='https://*.halaxy.com/*', extra=''):
    head = ['// ==UserScript==', '// @name         ' + name, '// @version      ' + version, '// @match        ' + match]
    if run_at:
        head.append('// @run-at       ' + run_at)
    if extra:
        head.append(extra)
    return '\n'.join(head) + '\n// ==/UserScript==\n' + body + '\n'


def start_script(version, broken=False):
    return script('Start', version,
                  "window.__start = (window.__start || []).concat(['%s']);"
                  "window.__startBeforePage = !window.__pageScript;%s" % (version, ' this is not javascript(' if broken else ''),
                  run_at='document-start')


REPO = {}


def reset_repo():
    REPO.clear()
    stable = {
        'start.user.js': start_script('1.0'),
        'idle.user.js': script('Idle', '1.0', "window.__idle = !!document.body; document.body.setAttribute('data-idle', '1');"),
        'appsonly.user.js': script('Apps only', '1.0', 'window.__appsOnly = true;', match='https://eu.halaxy.com/*',
                                   extra='// @exclude      https://eu.halaxy.com/book/*'),
        'gm.user.js': script('GM', '1.0', "var c = GM_getValue('count', 0) + 1; GM_setValue('count', c); window.__count = c;"
                             "GM_registerMenuCommand('Fixture menu', function () { window.__menuClicked = true; });", run_at='document-start'),
        'throws.user.js': script('Throws', '1.0', "throw new Error('fixture failure');", run_at='document-start'),
        'zlast.user.js': script('Last', '1.0', 'window.__last = true;', run_at='document-start'),
    }
    beta = dict(stable)
    beta['betaonly.user.js'] = script('Beta only', '1.0', 'window.__betaOnly = true;', run_at='document-start')
    for ch, files in (('stable', stable), ('beta', beta)):
        REPO[ch] = files


def manifest(ch):
    out = []
    for f, code in sorted(REPO[ch].items()):
        ver = [l.split()[-1] for l in code.splitlines() if '@version' in l][0]
        out.append({'file': f, 'name': f, 'version': ver})
    return json.dumps({'scripts': out})


STUBS = r"""
(function () {
  const K = 'tm:';
  window.GM_getValue = (k, d) => { const v = localStorage.getItem(K + k); return v === null ? d : JSON.parse(v); };
  window.GM_setValue = (k, v) => localStorage.setItem(K + k, JSON.stringify(v));
  window.GM_deleteValue = (k) => localStorage.removeItem(K + k);
  window.__tmMenu = [];
  window.GM_registerMenuCommand = (label, fn) => { window.__tmMenu.push([label, fn]); };
  window.__injected = [];
  window.GM_addElement = (parent, tag, attrs) => {
    const el = document.createElement(tag);
    el.textContent = attrs.textContent;
    const m = /sourceURL=upc-scripts\/(\S+)/.exec(attrs.textContent);
    if (m) window.__injected.push(m[1]);
    parent.appendChild(el);
    return el;
  };
  window.GM_xmlhttpRequest = (o) => {
    fetch(o.url).then((r) => r.text().then((t) => o.onload({ status: r.status, responseText: t })))
      .catch(() => o.onerror());
  };
  window.__errs = [];
  document.addEventListener('upc-loader-error', (e) => window.__errs.push(JSON.parse(e.detail)));
})();
"""

PAGE = "<!doctype html><html><head><script>window.__pageScript = true;</script></head><body><h1>Mock Halaxy</h1></body></html>"

FAILS = []
def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)))
    if not ok:
        FAILS.append(name)


async def main():
    reset_repo()
    net = {'offline': False, 'real': False}

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context()

        async def github(route):
            if net['offline']:
                return await route.abort()
            path = route.request.url.split('?')[0][len(RAW):]
            ch, _, f = path.partition('/')
            if net['real']:
                fp = ROOT / path
                return await route.fulfill(status=200 if fp.exists() else 404, body=fp.read_text() if fp.exists() else 'not found')
            if f == 'scripts.json':
                return await route.fulfill(body=manifest(ch), content_type='application/json')
            if f in REPO.get(ch, {}):
                return await route.fulfill(body=REPO[ch][f], content_type='text/plain')
            await route.fulfill(status=404, body='not found')

        await ctx.route(RAW + '**', github)
        await ctx.route('https://eu.halaxy.com/**', lambda r: r.fulfill(body=PAGE, content_type='text/html'))
        await ctx.add_init_script(STUBS)
        await ctx.add_init_script(LOADER)
        pg = await ctx.new_page()

        async def load(path='/a/pr/1/calendar', wait=800):
            await pg.goto('https://eu.halaxy.com' + path)
            await pg.wait_for_timeout(wait)
            return await pg.evaluate("""() => ({ start: window.__start || [], startBefore: window.__startBeforePage, idle: window.__idle,
                appsOnly: !!window.__appsOnly, count: window.__count, last: !!window.__last, betaOnly: !!window.__betaOnly,
                injected: window.__injected, errs: window.__errs, menu: window.__tmMenu.map(m => m[0]) })""")

        async def expire_check():
            await pg.evaluate("Object.keys(localStorage).filter(k => k.startsWith('upc-loader:lastCheck')).forEach(k => localStorage.removeItem(k))")

        # 1. A PC with nothing saved yet: fetches everything and runs it on the same page.
        s = await load()
        check('fresh PC: runs every script on the first page', s['start'] == ['1.0'] and s['idle'] and s['appsOnly'] and s['count'] == 1 and s['last'], s)
        check('fresh PC: settings menu and script menu items', 'UPC scripts: settings and updates' in s['menu'] and 'Fixture menu' in s['menu'], s['menu'])
        check('a failing script is reported and does not stop the others', s['last'] and any(e['file'] == 'throws.user.js' for e in s['errs']), s['errs'])

        # 2. Next page: saved copies run, document-start ones before Halaxy's own scripts.
        s = await load()
        check('saved copy runs before the page', s['start'] == ['1.0'] and s['startBefore'] is True, s)
        check('each script runs once per page', sorted(s['injected']) == sorted(set(s['injected'])), s['injected'])
        check('idle script waits for the page body', s['idle'] is True)
        check('script storage persists (GM_setValue)', s['count'] == 2, s['count'])
        await pg.evaluate("window.__tmMenu.find(m => m[0] === 'Fixture menu')[1]()")
        check('script menu items reach the script', await pg.evaluate('window.__menuClicked === true'))

        # 3. @exclude honoured.
        s = await load('/book/abc')
        check('@exclude honoured', not s['appsOnly'] and s['start'] == ['1.0'], s)

        # 4. No check within 10 minutes of the last one.
        REPO['stable']['start.user.js'] = start_script('1.1')
        s = await load()
        await load()
        s = await load()
        check('no update check within 10 minutes', s['start'] == ['1.0'], s['start'])

        # 5. Update: the page that finds it keeps the old version; the next page runs the new one.
        await expire_check()
        s = await load()
        check('update found: this page keeps the old version', s['start'] == ['1.0'], s['start'])
        s = await load()
        check('update used from the next page', s['start'] == ['1.1'], s['start'])

        # 6. A broken update is refused; the working copy keeps running.
        REPO['stable']['start.user.js'] = start_script('1.2', broken=True)
        await expire_check()
        await load()
        s = await load()
        problems = await pg.evaluate("JSON.parse(localStorage.getItem('upc-loader:lastProblems:stable'))")
        check('broken update refused, working copy kept', s['start'] == ['1.1'] and any('syntax' in x for x in problems), (s['start'], problems))
        REPO['stable']['start.user.js'] = start_script('1.3')

        # 7. GitHub unreachable: saved copies still run.
        net['offline'] = True
        await expire_check()
        s = await load()
        problems = await pg.evaluate("JSON.parse(localStorage.getItem('upc-loader:lastProblems:stable'))")
        check('offline: saved copies still run', s['start'] == ['1.1'] and s['idle'] and s['last'], s)
        check('offline: problem recorded', any('reach GitHub' in x for x in problems), problems)
        net['offline'] = False

        # 8. Switching a script off on this PC.
        await pg.evaluate("localStorage.setItem('upc-loader:off', JSON.stringify({'idle.user.js': true}))")
        s = await load()
        check('switched-off script does not run', s['idle'] is None and s['last'], s)
        await pg.evaluate("localStorage.removeItem('upc-loader:off')")

        # 9. A script removed from the list stops running.
        del REPO['stable']['zlast.user.js']
        await expire_check()
        await load()
        s = await load()
        check('removed script stops running', not s['last'] and 'zlast.user.js' not in s['injected'], s['injected'])

        # 10. Beta channel on this PC only.
        await pg.evaluate("localStorage.setItem('upc-loader:channel', JSON.stringify('beta'))")
        s = await load()
        check('beta channel: fetches and runs beta scripts', s['betaOnly'] and s['start'] == ['1.0'], s)
        await pg.evaluate("localStorage.setItem('upc-loader:channel', JSON.stringify('stable'))")
        s = await load()
        check('back to stable: beta-only script gone', not s['betaOnly'] and s['start'] == ['1.3'], s)

        # 11. Settings panel.
        await pg.evaluate("window.__tmMenu.find(m => m[0] === 'UPC scripts: settings and updates')[1]()")
        panel = "document.getElementById('upc-loader-panel').shadowRoot"
        rows = await pg.evaluate("[..." + panel + ".querySelectorAll('.row')].map(r => r.textContent.replace(/\\s+/g, ' ').trim())")
        check('panel lists the scripts with versions', len(rows) == 5 and any(r.startswith('Start') and '1.3' in r and 'running on this page' in r for r in rows), rows)
        await pg.evaluate(panel + ".querySelector('input[data-file=\"idle.user.js\"]').click()")
        off = await pg.evaluate("JSON.parse(localStorage.getItem('upc-loader:off'))")
        note = await pg.evaluate(panel + ".querySelector('.note').hidden")
        check('panel switch saves and asks for a refresh', off == {'idle.user.js': True} and note is False, (off, note))
        await pg.evaluate("localStorage.removeItem('upc-loader:off')")
        await ctx.close()

        # 12. The real repository: every script loads on a Halaxy page with no syntax errors.
        net['real'] = True
        ctx = await browser.new_context()
        await ctx.route(RAW + '**', github)
        await ctx.route('https://eu.halaxy.com/**', lambda r: r.fulfill(body=PAGE, content_type='text/html'))
        await ctx.add_init_script(STUBS)
        await ctx.add_init_script(LOADER)
        pg = await ctx.new_page()
        page_errors = []
        pg.on('pageerror', lambda e: page_errors.append(str(e)))
        files = [x['file'] for x in json.loads((ROOT / 'stable' / 'scripts.json').read_text())['scripts']]
        for _ in range(2):
            await pg.goto('https://eu.halaxy.com/a/pr/555/calendar')
            await pg.wait_for_timeout(2500)
        injected = await pg.evaluate('window.__injected')
        errs = await pg.evaluate('window.__errs')
        check('real scripts: all run from saved copies', sorted(injected) == sorted(files), sorted(set(files) - set(injected)))
        syntax = [e for e in errs + [{'message': m} for m in page_errors] if 'SyntaxError' in e['message']]
        check('real scripts: no syntax errors', not syntax, syntax)
        if errs:
            print('     note: errors from scripts on the mock page (expected, no real Halaxy there):', errs)
        await browser.close()

    print('\n%d failed' % len(FAILS) if FAILS else '\nAll passed')
    sys.exit(1 if FAILS else 0)

asyncio.run(main())
