"""
Test for Block error reporting: a mock Halaxy page that loads Sentry from its CDN, sets it up, and sends reports by
fetch, XMLHttpRequest and sendBeacon, plus a Sentry script added by code.

Checks: Sentry's script never runs; Halaxy's own calls to Sentry work quietly (no page errors) and the real Sentry
can't replace the stand-in; nothing reaches Sentry's servers; Halaxy's own requests still work.
Chromium only here (Firefox's extra beforescriptexecute layer isn't covered).

Run:  python3 tests/block-error-reporting/test_block_error_reporting.py
"""
import asyncio, sys
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
CODE = (ROOT / 'beta' / 'block-error-reporting.user.js').read_text()
FAILS = []


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)))
    if not ok:
        FAILS.append(name)


SENTRY_JS = "window.__sentryRan = (window.__sentryRan || 0) + 1; window.Sentry = { init: function () { window.__realInit = true; } };"

PAGE = """<!doctype html><html><head>
<script src="https://browser.sentry-cdn.com/7.99.0/bundle.tracing.min.js" crossorigin="anonymous"></script>
<script>
  window.__errors = [];
  window.addEventListener('error', function (e) { window.__errors.push(String(e.message)); });
  Sentry.init({ dsn: 'https://abc@o1.ingest.sentry.io/1', release: 'x' });
  Sentry.setUser({ id: 1 });
  Sentry.getCurrentScope().setTag('a', 'b');
  window.__afterInit = true;
</script>
</head><body><h1>Mock Halaxy</h1>
<script>
  fetch('https://o1.ingest.sentry.io/api/1/envelope/', { method: 'POST', body: 'x' }).then(function (r) { window.__fetchStatus = r.status; });
  fetch(new Request('https://o1.ingest.de.sentry.io/api/1/envelope/', { method: 'POST', body: 'x' })).then(function (r) { window.__fetchReq = r.status; });
  var x = new XMLHttpRequest(); x.open('POST', 'https://o1.ingest.sentry.io/api/1/store/'); x.send('y');
  window.__beacon = navigator.sendBeacon('https://o1.ingest.sentry.io/api/1/envelope/', 'z');
  fetch('/a/pr/1/ok').then(function (r) { return r.text(); }).then(function (t) { window.__normal = t; });
  var y = new XMLHttpRequest(); y.open('GET', '/a/pr/1/ok'); y.onload = function () { window.__normalXhr = y.responseText; }; y.send();
  var s = document.createElement('script'); s.src = 'https://js.sentry-cdn.com/abc123.min.js'; document.head.appendChild(s);
  var t = document.createElement('script'); t.setAttribute('src', 'https://browser.sentry-cdn.com/7.99.0/bundle.min.js'); document.head.appendChild(t);
  window.Sentry = { init: function () { window.__replaced = true; } };
  Sentry.init({});
</script>
</body></html>"""


async def main():
    hits = []
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context()

        async def sentry(route):
            hits.append(route.request.url)
            if 'sentry-cdn.com' in route.request.url:
                return await route.fulfill(body=SENTRY_JS, content_type='application/javascript')
            await route.fulfill(body='{}', content_type='application/json')

        async def halaxy(route):
            if route.request.url.endswith('/a/pr/1/ok'):
                return await route.fulfill(body='fine', content_type='text/plain')
            await route.fulfill(body=PAGE, content_type='text/html')

        await ctx.route('**/*sentry*/**', sentry)
        await ctx.route('https://*.sentry.io/**', sentry)
        await ctx.route('https://eu.halaxy.com/**', halaxy)
        await ctx.add_init_script(CODE)
        pg = await ctx.new_page()
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        await pg.goto('https://eu.halaxy.com/a/pr/1/calendar')
        await pg.wait_for_function("window.__normal && window.__normalXhr && window.__fetchStatus && window.__fetchReq", timeout=10000)
        await pg.wait_for_timeout(800)
        r = await pg.evaluate("""({ ran: window.__sentryRan || 0, realInit: !!window.__realInit, replaced: !!window.__replaced, after: !!window.__afterInit,
            fetch: window.__fetchStatus, fetchReq: window.__fetchReq, beacon: window.__beacon, normal: window.__normal, normalXhr: window.__normalXhr,
            errs: window.__errors, blocked: window.__upcBlockErrorReporting.blocked, typeofSentry: typeof Sentry })""")
        ingest = [h for h in hits if 'ingest' in h]
        check("Sentry's script never runs (in the page's HTML, or added by code)", r['ran'] == 0 and not r['realInit'], (r, hits))
        check("Halaxy's own calls to Sentry work quietly", r['after'] and not errors and not r['errs'] and r['typeofSentry'] == 'function', (errors, r['errs']))
        check('the real Sentry cannot replace the stand-in', not r['replaced'], r)
        check("nothing reaches Sentry's servers (fetch, XMLHttpRequest, sendBeacon)", not ingest and r['fetch'] == 200 and r['fetchReq'] == 200 and r['beacon'] is True and r['blocked']['requests'] >= 4, (ingest, r))
        check("Halaxy's own requests still work", r['normal'] == 'fine' and r['normalXhr'] == 'fine', r)
        check('nothing fetched from Sentry\'s CDN for scripts added by code', not [h for h in hits if 'js.sentry-cdn.com' in h or h.endswith('/bundle.min.js')], hits)
        await browser.close()
    print('\n%d failed' % len(FAILS) if FAILS else '\nAll passed')
    sys.exit(1 if FAILS else 0)

asyncio.run(main())
