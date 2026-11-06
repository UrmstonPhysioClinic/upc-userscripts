"""
Regression test for Outstanding Actions, run against a mock Halaxy.

The mock reproduces the structure of a real clinic day (6 Nov 2026): statuses, note and
invoice states, fee colours. It contains NO patient data: patients are named by time.

Run:  python3 tests/outstanding-actions/test_outstanding_actions.py [path/to/script.user.js]
Needs: Python 3 with Playwright (Chromium). Defaults to beta/outstanding-actions.user.js.
"""
import asyncio, datetime, http.server, json, sys, threading, urllib.parse
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'beta' / 'outstanding-actions.user.js'
PORT = 8790
PG = '555'

SELF_A, SELF_B, INSURER, SHARED = '#FEF2C0', '#FBCA04', '#FAD8C7', '#0E0793'

# time, requestStatus, appointmentStatus, isRequest, invoiceStatus, noteStatusCss, colour, patient id
DAY = [
    ('09:00', '', '', False, 'Manual Payments', 'empty-clinical-note', SELF_A, 401),       # expect: note + unpaid
    ('09:30', 'Attended', '', True, 'Paid In Full', 'published-clinical-note', SELF_B, 402),
    ('10:00', '', '', False, 'Paid In Full', 'published-clinical-note', SELF_A, 403),
    ('11:00', '', '', False, 'Paid In Full', 'published-clinical-note', SELF_A, 404),
    ('11:30', 'Attended', '', True, 'Paid In Full', 'published-clinical-note', SELF_B, 405),
    ('11:30', '', '', False, 'Stored Creditcard', 'published-clinical-note', INSURER, 406),  # insurer: ignored
    ('13:00', 'Attended', '', True, 'Paid In Full', 'published-clinical-note', SELF_B, 407),
    ('13:30', 'Attended', '', True, 'Paid In Full', 'published-clinical-note', SELF_A, 408),
    ('10:30', '', 'cancelled', False, 'Stored Creditcard', 'empty-clinical-note', SELF_A, 409),
    ('11:00', '', 'did-not-attend', False, 'Stored Creditcard', 'empty-clinical-note', SELF_A, 410),
    ('12:00', '', 'cancelled', False, 'Stored Creditcard', 'empty-clinical-note', SELF_A, 411),
    ('12:00', '', 'did-not-attend', False, 'Manual Payments', 'empty-clinical-note', SELF_A, 412),
    ('14:00', '', 'did-not-attend', False, 'Stored Creditcard', 'draft-clinical-note', SELF_A, 413),  # DNA draft: ignored
    ('08:00', '', '', False, 'Manual Payments', 'published-clinical-note', SHARED, 414),    # expect: funder unclear
    ('08:30', '', '', False, 'Manual Payments', 'published-clinical-note', SELF_A, 415),    # £0 package FU: ignored
]
FEES = [
    {'funder': 'Self-Funded', 'feeColour': SELF_A, 'status': 'current'},
    {'funder': 'Self-Funded', 'feeColour': SELF_B, 'status': 'current'},
    {'funder': 'AXA Health', 'feeColour': INSURER, 'status': 'current'},
    {'funder': 'Self-Funded', 'feeColour': SHARED, 'status': 'current'},
    {'funder': 'Bupa', 'feeColour': SHARED, 'status': 'current'},
]
STATE = {'paid': set(), 'mode': 'normal', 'cal': 0}


def events():
    day = datetime.datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    out = []
    for i, (hm, rs, ap, req, inv, css, col, pid) in enumerate(DAY):
        if STATE['mode'] == 'clear' and pid in (401, 414):
            continue
        h, m = map(int, hm.split(':'))
        start = int((day + datetime.timedelta(hours=h, minutes=m)).timestamp())
        if pid in STATE['paid']:
            inv = 'Paid In Full'
        out.append({'id': i + 1, 'type': 'appointment', 'start': start, 'end': start + 1800,
                    'patientID': pid, 'linkPaG': pid, 'linkPaGId': pid, 'practitionerID': 11,
                    'invoiceID': pid + 100, 'noteID': pid + 200, 'colour': col,
                    'title': "<span class='name-text'>Patient " + hm + '</span>',
                    'requestStatus': rs, 'appointmentStatus': ap, 'isRequest': req,
                    'invoiceStatus': inv, 'noteStatusCss': css, 'isGroupAppointment': False})
    out.append({'id': 99, 'type': 'personal', 'start': out[0]['start'], 'end': out[0]['start'] + 1800, 'title': 'Lunch'})
    return out


def invoices(pid):
    rows = {401: [{'id': 501, 'invoiceId': 'UPC-1', 'total': 45, 'balance': 45, 'status': 'Not yet paid'}],
            415: [{'id': 515, 'invoiceId': 'UPC-2', 'total': 0, 'balance': 0, 'status': 'Not yet paid'}]}.get(pid, [])
    for r in rows:
        if pid in STATE['paid']:
            r['balance'], r['status'] = 0, 'Paid In Full'
    return rows


PAGE = ("<!doctype html><html><body style='margin:0;height:900px'><h1>Mock Halaxy</h1>"
        "<button id='pay'>Pay</button><script>window.HkUser={linkPrG:11,pracID:11};"
        "document.getElementById('pay').onclick=()=>{const x=new XMLHttpRequest();"
        "x.open('POST','/a/pr/" + PG + "/invoicefunctions/501/pay/offline');x.send('a=1');};</script></body></html>")


class Mock(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def send(self, body, ct='application/json'):
        b = (body if isinstance(body, str) else json.dumps(body)).encode()
        self.send_response(200); self.send_header('Content-Type', ct); self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        p = urllib.parse.urlparse(self.path).path
        if STATE['mode'] == 'logged-out' and p.endswith('/calendar/json'):
            return self.send('<html>login</html>', 'text/html')
        if p.endswith('/lookup/practitioner'): return self.send([{'id': 11, 'name': 'Prac One'}])
        if p.endswith('/funder/fee/data'): return self.send(FEES)
        if p.endswith('/calendar/json'):
            STATE['cal'] += 1
            return self.send({'status': 'OK', 'payload': {'events': events()}})
        if '/patient/invoice/' in p and p.endswith('/list-data'): return self.send(invoices(int(p.split('/')[-2])))
        if '/note/' in p: return self.send({'status': 'draft', 'content': ''})
        return self.send(PAGE, 'text/html')

    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length', 0) or 0))
        if '/invoicefunctions/501/pay' in self.path: STATE['paid'].add(401)
        return self.send({'status': 'OK'})


FAILS = []
def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)))
    if not ok: FAILS.append(name)


async def main():
    threading.Thread(target=http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Mock).serve_forever, daemon=True).start()
    code = SCRIPT.read_text()
    async with async_playwright() as p:
        browser = await p.chromium.launch()

        async def page():
            ctx = await browser.new_context(viewport={'width': 1280, 'height': 800})
            async def route(r):
                resp = await r.fetch(url=r.request.url.replace('https://eu.halaxy.com', 'http://127.0.0.1:%d' % PORT))
                await r.fulfill(response=resp)
            await ctx.route('https://eu.halaxy.com/**', route)
            await ctx.add_init_script(code)
            pg = await ctx.new_page()
            errors = []
            pg.on('pageerror', lambda e: errors.append(str(e)))
            await pg.goto('https://eu.halaxy.com/a/pr/%s/calendar' % PG)
            await pg.wait_for_timeout(1500)
            return pg, errors

        shadow = "document.querySelector('[data-hx-outstanding]').shadowRoot"

        # 1. Normal day
        pg, errors = await page()
        st = await pg.evaluate('hxOutstanding.state()')
        flagged = sorted((i['patient'], i['label']) for i in st['items'])
        check('flags 09:00 note and payment only', flagged == [('Patient 09:00', 'Note not started'), ('Patient 09:00', 'Unpaid £45.00')], flagged)
        unchecked = [(i['patient'], i['label']) for i in st['unchecked']]
        check('shared colour reported as unclear', unchecked == [('Patient 08:00', 'Funder unclear: check invoice')], unchecked)
        pill = await pg.evaluate(shadow + ".querySelector('.pill').textContent")
        check('pill summary', pill == 'Outstanding today: 1 note · 1 unpaid · 1 to check', pill)
        await pg.evaluate(shadow + ".querySelector('.pill').click()")
        links = await pg.evaluate("[..." + shadow + ".querySelectorAll('.acts a')].map(a => a.getAttribute('href'))")
        check('note link format', '/a/pr/555/patient/401/clinical/category/note/id/601' in links, links)
        check('invoice link format', '/a/pr/555/invoice/501' in links, links)
        await pg.click('#pay')
        await pg.wait_for_timeout(2500)
        st = await pg.evaluate('hxOutstanding.state()')
        check('payment clears unpaid tag', [i['label'] for i in st['items']] == ['Note not started'], st['items'])
        check('no page errors', not errors, errors)
        await pg.context.close()

        # 2. All clear
        STATE['mode'] = 'clear'
        pg, errors = await page()
        dot = await pg.evaluate(shadow + ".querySelector('.dot') !== null")
        check('all clear shows the dot', dot)
        await pg.context.close()

        # 3. Logged out
        STATE['mode'] = 'logged-out'
        pg, errors = await page()
        pill = await pg.evaluate(shadow + ".querySelector('.pill').textContent")
        check('failure shows warning pill', pill == 'Outstanding check not working', pill)
        await pg.context.close()

        # 4. Two tabs on one PC: one checks, the other is sent its result (0.3.0 and later)
        if 'BroadcastChannel' not in code:
            print('SKIP tab sharing: this copy predates it')
            await browser.close()
            print('\n%d failed' % len(FAILS) if FAILS else '\nAll passed')
            sys.exit(1 if FAILS else 0)
        STATE['mode'] = 'normal'
        STATE['paid'] = set()
        ctx = await browser.new_context(viewport={'width': 1280, 'height': 800})
        async def route(r):
            resp = await r.fetch(url=r.request.url.replace('https://eu.halaxy.com', 'http://127.0.0.1:%d' % PORT))
            await r.fulfill(response=resp)
        await ctx.route('https://eu.halaxy.com/**', route)
        await ctx.add_init_script(code)
        t1 = await ctx.new_page()
        await t1.goto('https://eu.halaxy.com/a/pr/%s/calendar' % PG)
        await t1.wait_for_timeout(1500)
        STATE['cal'] = 0
        t2 = await ctx.new_page()
        await t2.goto('https://eu.halaxy.com/a/pr/%s/patient' % PG)
        await t2.wait_for_timeout(1500)
        pill2 = await t2.evaluate(shadow + ".querySelector('.pill').textContent")
        check('second tab reuses the first tab\'s result', STATE['cal'] == 0 and pill2 == 'Outstanding today: 1 note · 1 unpaid · 1 to check', (STATE['cal'], pill2))
        await t2.evaluate(shadow + ".querySelector('.pill').click()")
        await t2.evaluate("[..." + shadow + ".querySelectorAll('button')].find(b => b.textContent === 'Check now').click()")
        await t2.wait_for_timeout(1500)
        a1, a2 = await t1.evaluate('hxOutstanding.state().at'), await t2.evaluate('hxOutstanding.state().at')
        check('Check now in one tab updates the other', STATE['cal'] == 1 and a1 == a2, (STATE['cal'], a1, a2))
        await t1.reload()
        await t1.wait_for_timeout(1500)
        check('moving between pages within a minute does not re-check', STATE['cal'] == 1, STATE['cal'])
        await ctx.close()

        await browser.close()
    print('\n%d failed' % len(FAILS) if FAILS else '\nAll passed')
    sys.exit(1 if FAILS else 0)

asyncio.run(main())
