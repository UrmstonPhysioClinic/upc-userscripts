"""
Test for Funder chaser against a mock Halaxy Unpaid Invoices report (same layout as Ready to bill's test;
columns confirmed live 10 Nov 2026). Invented invoices only.

Checks: insurer invoices marked Issued and unpaid 30+ days are listed, oldest first, part-paid with what's left;
newer ones, patients' own invoices and self-funded are left out; Active ones after 30 days are greyed and not
counted; the menu count; Carl only; a changed report is an error passed to the health check.

Run:  python3 tests/insurer-payments-due/test_insurer_payments_due.py
"""
import asyncio, datetime, json, sys, urllib.parse
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
CORE = (ROOT / 'beta' / 'core.user.js').read_text()
FC = (ROOT / 'beta' / 'insurer-payments-due.user.js').read_text()
MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
hx = lambda d: '%02d-%s-%d' % (d.day, MON[d.month - 1], d.year)
gbp = lambda c: '£%.2f' % (c / 100)
COLS = ['Invoice / Deposit', 'Date', 'Due Date', 'Practitioner', 'Payer ID', 'Payer', 'Funder', 'Category', 'Fee', 'Quantity',
        'Appointment Status', 'Invoice Status', 'Tax', 'Amount', 'Payments', '', 'Date', 'Method', 'Payments Inc. Fees', 'Balance', '']
TODAY = datetime.date(2026, 11, 11)
d = lambda n: TODAY + datetime.timedelta(days=n)
FAILS = []
S = {}


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)))
    if not ok:
        FAILS.append(name)


def invoices():
    # (id, payer, funder, invoice day, status, line amounts, balance)
    return [
        (801, 'Bupa', 'Bupa', -45, 'Issued', [4000, 4000], 8000),          # overdue
        (802, 'AXA Health', 'AXA Health', -31, 'Issued', [5000, 4000], 4000),   # overdue, part-paid
        (803, 'Bupa', 'Bupa', -10, 'Issued', [4000], 4000),                 # not yet 30 days
        (804, 'AXA Health', 'AXA Health', -40, 'Active', [4000], 4000),     # never marked Issued: greyed
        (805, 'Patient X', 'Bupa', -60, 'Active', [4000], 4000),            # the patient's own invoice: left out
        (806, 'Patient Y', 'Self-Funded', -90, 'Issued', [5000], 5000),     # self-funded: left out
        (807, 'WPA', 'WPA', -30, 'Issued', [3500], 3500),                   # exactly 30 days: overdue
    ]


def report_html():
    cols = [c for c in COLS if c != S.get('drop')]
    head = "<thead><tr>%s</tr></thead>" % ''.join('<th>%s</th>' % c for c in cols)
    body = ''
    for iid, payer, funder, day, status, amounts, bal in invoices():
        for k, a in enumerate(amounts):
            # As live (12 Nov 2026): an invoice's later fee rows leave the invoice-level cells blank, and its balance
            # is on its last row.
            first, lastrow = k == 0, k == len(amounts) - 1
            v = {'Invoice / Deposit': "<a href='/a/pr/555/invoice/%d'>UPC-0%d</a>" % (iid, iid) if first else '', 'Date': hx(d(day)) if first else '',
                 'Payer ID': str(iid) if first else '', 'Payer': payer if first else '', 'Funder': funder if first else '', 'Fee': 'Follow-Up', 'Appointment Status': 'Attended',
                 'Invoice Status': status if first else '', 'Amount': gbp(a), 'Balance': gbp(bal) if lastrow else ''}
            body += '<tr>' + ''.join('<td>%s</td>' % (v.get(c, '') if c else '') for c in cols) + '</tr>'
    body += "<tr><td colspan='13'>Total</td><td>£999.00</td></tr>"
    return "<html><body><table class='table-report'>%s<tbody>%s</tbody></table></body></html>" % (head, body)


def page_html(user):
    return ("<!doctype html><html><head><title>Invoices | Halaxy</title></head><body style='margin:0 0 0 230px'>"
            "<div style='position:fixed;left:0;top:0;bottom:0;width:218px'><nav id='side'><ul id='mainMenu'>"
            "<li class='mainmenu-item active'><a class='mainmenu-link'><span class='mainmenu-link-label'>Finances</span></a>"
            "<ul><li><a class='mainmenu-sublink' href='/a/pr/555/expense/'>Expenses</a></li><li class='active'><a class='mainmenu-sublink active' href='/a/pr/555/invoice/'>Invoices</a></li></ul></li></ul></nav></div>"
            "<div id='headerWrapper' style='height:50px'></div><h1>Invoices</h1>"
            "<script>setTimeout(function () { window.HkUser = { linkPrG: 11, pracID: 11, pracName: %s }; }, S.get('lateUser', 0));</script></body></html>").replace("S.get('lateUser', 0)", str(S.get('lateUser', 0))) % json.dumps(user)


async def halaxy(route):
    req = route.request
    p = urllib.parse.urlparse(req.url).path
    S['log'].append((req.method, p))
    if p.endswith('/report/finance/0'):
        S['reportStart'] = urllib.parse.parse_qs(urllib.parse.urlparse(req.url).query).get('start')
        return await route.fulfill(body=report_html(), content_type='text/html')
    if p.startswith('/a/pr/555/'):
        return await route.fulfill(body=page_html(S['user']), content_type='text/html')
    await route.fulfill(status=404, body='not mocked')


async def context(browser):
    ctx = await browser.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/London')
    await ctx.clock.install(time='2026-11-11T12:00:00Z')
    await ctx.route('https://eu.halaxy.com/**', halaxy)
    await ctx.add_init_script(CORE)
    await ctx.add_init_script("document.addEventListener('DOMContentLoaded', function () {\n" + FC + "\n});")
    await ctx.add_init_script("document.addEventListener('upc-loader-error', (e) => { (window.__healthErrors = window.__healthErrors || []).push(JSON.parse(e.detail)); });")
    return ctx


ROWS = """[...document.querySelectorAll('[data-upc-funder-chaser] tbody tr')].map((tr) => ({ off: tr.classList.contains('upc-off'),
  cells: [...tr.cells].map((c) => c.textContent.trim()), link: tr.cells[1].querySelector('a').getAttribute('href') }))"""


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        S.update({'log': [], 'user': 'Carl Healy'})
        ctx = await context(browser)
        pg = await ctx.new_page()
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        await pg.goto('https://eu.halaxy.com/a/pr/555/invoice/#upc-funder-chaser')
        await pg.wait_for_function("document.querySelector('[data-upc-funder-chaser] table')", timeout=60000)
        await pg.wait_for_function("!document.querySelector('[data-upc-funder-chaser] [data-a=refresh]').disabled", timeout=60000)
        rows = await pg.evaluate(ROWS)
        due = [r['cells'][1] for r in rows if not r['off']]
        check('Issued and unpaid 30 days or more, oldest first', due == ['UPC-0801', 'UPC-0802', 'UPC-0807'], rows)
        r802 = next((r for r in rows if r['cells'][1] == 'UPC-0802'), {'cells': []})
        check('part-paid: amount and what\'s still to pay', r802['cells'][2:] == ['11-Oct-2026', '31', '2', '£ 90.00', '£ 40.00'], r802)
        check('linked to the invoice', rows[0]['link'] == '/a/pr/555/invoice/801', rows[0])
        off = [r['cells'][1] for r in rows if r['off']]
        check('Active after 30 days: greyed, separately', off == ['UPC-0804'], rows)
        check('left out: under 30 days, the patient\'s own invoice, self-funded', not any(x in due + off for x in ['UPC-0803', 'UPC-0805', 'UPC-0806']), rows)
        head = await pg.evaluate("document.querySelector('[data-upc-funder-chaser] .card-header h2').textContent")
        check('heading with count and total still to pay', head == 'Unpaid after 30 days (3, £ 155.00)', head)
        check('one report request, reading back 18 months', len([x for x in S['log'] if x[1].endswith('/report/finance/0')]) == 1 and S.get('reportStart') == ['11-May-2025'], (S['log'], S.get('reportStart')))
        badge = await pg.evaluate("(document.querySelector('a.upc-fc-menu .upc-fc-badge') || {}).textContent")
        check('menu item under Finances with the count (Issued only)', badge == '3', badge)
        native = await pg.evaluate("document.querySelector('[data-upc-funder-chaser]').classList.contains('upc-native') && !!document.querySelector('[data-upc-funder-chaser] table.table.table-bordered')")
        check('native look', native)
        check('no page errors', not errors, errors)
        await ctx.close()

        # Halaxy fills in who's signed in late (live, 11 Nov 2026): the menu item still appears
        S.update({'log': [], 'user': 'Carl Healy', 'lateUser': 3000})
        ctx = await context(browser)
        pg = await ctx.new_page()
        await pg.goto('https://eu.halaxy.com/a/pr/555/invoice/')
        await pg.wait_for_timeout(6000)
        check('signed-in name filled in late: the menu item still appears', await pg.evaluate("!!document.querySelector('a.upc-fc-menu')"))
        await ctx.close()
        S['lateUser'] = 0

        # Not Carl: nothing
        S.update({'log': [], 'user': 'Someone Else'})
        ctx = await context(browser)
        pg = await ctx.new_page()
        await pg.goto('https://eu.halaxy.com/a/pr/555/invoice/#upc-funder-chaser')
        await pg.wait_for_timeout(5000)
        nothing = await pg.evaluate("!document.querySelector('[data-upc-funder-chaser]') && !document.querySelector('a.upc-fc-menu')")
        check('others see nothing and nothing is asked of Halaxy', nothing and not [x for x in S['log'] if x[1].endswith('/report/finance/0')], S['log'])
        await ctx.close()

        # Report changed: error shown and passed to the health check
        S.update({'log': [], 'user': 'Carl Healy', 'drop': 'Invoice Status'})
        ctx = await context(browser)
        pg = await ctx.new_page()
        await pg.goto('https://eu.halaxy.com/a/pr/555/invoice/#upc-funder-chaser')
        await pg.wait_for_function("document.querySelector('[data-upc-funder-chaser] .upc-err')", timeout=60000)
        err = await pg.evaluate("document.querySelector('[data-upc-funder-chaser] .upc-err').textContent")
        health = await pg.evaluate("window.__healthErrors || []")
        check('changed report: says so, and tells the health check', 'Invoice Status not found' in err and any(h.get('file') == 'insurer-payments-due.user.js' for h in health), (err, health))
        await ctx.close()
        await browser.close()
    print('\n%d failed' % len(FAILS) if FAILS else '\nAll passed')
    sys.exit(1 if FAILS else 0)

asyncio.run(main())
