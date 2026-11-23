"""
Test for Old balances, against a mock Halaxy (invented invoices). Clock: 22-Nov-2026.

Checks: one Unpaid Invoices report from 2000; one row per invoice with its balance from its last line; invoices under
6 months old and paid-off ones left out; "Over 6 years" and "6 months to 6 years" cards with counts and totals;
Write off asks first, then sets the invoice's status to Write-off in its settings (every other field as Halaxy filled
it); a second Write off pressed straight away waits its turn ("Queued"); the page kit (title bar, search, sorting,
Show 25 more); ticking rows and "Write off 2" asks once and queues both; only CH sees the page; Halaxy look.

Run:  python3 tests/old-balances/test_old_balances.py
"""
import asyncio, datetime, json, re, sys, urllib.parse
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
CORE = (ROOT / 'beta' / 'core.user.js').read_text().replace('perMinute: 45,', 'perMinute: 100000,')
SCRIPT = (ROOT / 'beta' / 'old-balances.user.js').read_text()
NOW = datetime.datetime(2026, 11, 22, 12, 0, tzinfo=datetime.timezone.utc)
FAILS = []
S = {}


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)[:600]))
    if not ok:
        FAILS.append(name)


COLS = ['Invoice / Deposit', 'Date', 'Due Date', 'Practitioner', 'Payer ID', 'Payer', 'Funder', 'Category', 'Fee', 'Quantity', 'Appointment Status', 'Invoice Status', 'Tax', 'Amount', 'Payments', 'Date', 'Method', 'Payments Inc. Fees', 'Balance']


def row(iid, date, payer, funder, amount, balance, first=True):
    cell = "<a href='/a/pr/555/invoice/%d'>UPC-0%d</a>" % (iid, iid) if first else ''
    return (cell, date if first else '', '', 'Prac One', 'P-000%d' % iid if first else '', payer if first else '', funder if first else '', 'Treatment', 'Fee', '1', 'Attended', 'Active' if first else '', '£0.00', amount, '', '', '', '', balance)


def report():
    rows = [row(1001, '03-Mar-2019', 'Patient Old', 'Self-Funded', '£40.00', '£40.00'),                 # over 6 years
            row(1002, '10-Jan-2020', 'Patient Two', 'Self-Funded', '£30.00', ''),                       # two fees, over 6 years
            row(1002, '', '', '', '£30.00', '£60.00', first=False),
            row(1003, '01-Feb-2025', 'Bupa', 'Bupa', '£50.00', '£50.00'),                               # 6 months to 6 years
            row(1004, '01-Oct-2026', 'Patient New', 'Self-Funded', '£40.00', '£40.00'),                 # under 6 months
            row(1005, '01-Jan-2024', 'Patient Paid', 'Self-Funded', '£40.00', '£0.00')]                 # nothing to pay
    rows += [row(2000 + i, '01-Mar-2023', 'Patient X%04d' % (2000 + i), 'Self-Funded', '£%.2f' % (i + 1), '£%.2f' % (i + 1)) for i in range(60)]
    body = ''.join('<tr>%s</tr>' % ''.join('<td>%s</td>' % x for x in r) for r in rows)
    return ("<html><body><table class='table-report'><thead><tr><th colspan='13'>Fees &amp; Charges</th><th colspan='6'>Payments</th></tr><tr>%s</tr></thead><tbody>%s"
            "<tr><td colspan='13'>Total</td><td>£250.00</td></tr></tbody></table></body></html>") % (''.join('<th>%s</th>' % c for c in COLS), body)


def settings(iid):
    st = S['status'].get(iid, '')
    opts = ''.join("<option value='%s'%s>%s</option>" % (v, ' selected' if v == st else '', n) for v, n in [('', 'Active'), ('issued', 'Issued'), ('deleted', 'Deleted'), ('write-off', 'Write-off')])
    return ("<form id='frmInvoiceType'><input name='form[prefix]' value='UPC-'><input name='form[number]' value='%d'><select name='form[status]'>%s</select>"
            "<input name='form[displayDate]' value='03-Mar-2019'><input name='form[dueDate]' value=''><input type='hidden' name='form[_token]' value='T'></form>") % (iid, opts)


def page_html(user):
    return ("<!doctype html><html><head><title>Invoices | Halaxy</title></head><body style='margin:0 0 0 230px'>"
            "<div style='position:fixed;left:0;top:0;bottom:0;width:218px'><nav id='side'><ul id='mainMenu'>"
            "<li class='mainmenu-item active'><a class='mainmenu-link'><span class='mainmenu-link-label'>Finances</span></a>"
            "<ul><li class='active'><a class='mainmenu-sublink active' href='/a/pr/555/invoice/'>Invoices</a></li></ul></li></ul></nav></div>"
            "<div id='headerWrapper' style='height:50px'></div><div id='pageContent'><h1>Invoices</h1></div>"
            "<script>window.HkUser = { linkPrG: 11, pracID: 11, pracName: %s };</script></body></html>") % json.dumps(user)


async def halaxy(route):
    req = route.request
    p = urllib.parse.urlparse(req.url).path
    js = lambda o: route.fulfill(body=json.dumps(o), content_type='application/json')
    if p.endswith('/report/finance/0'):
        S['reports'].append(urllib.parse.parse_qs(urllib.parse.urlparse(req.url).query).get('start', [''])[0])
        return await route.fulfill(body=report(), content_type='text/html')
    m = re.search(r'/invoice/options/(\d+)$', p)
    if m:
        iid = int(m.group(1))
        if req.method == 'GET':
            return await js({'status': 'FORM', 'title': 'Invoice Settings', 'message': settings(iid)})
        f = dict(urllib.parse.parse_qsl(req.post_data or '', keep_blank_values=True))
        S['posts'].append((iid, f))
        await asyncio.sleep(0.8)
        S['status'][iid] = f.get('form[status]', '')
        return await js({'status': 'REFRESH'})
    await route.fulfill(body=page_html(S['user']), content_type='text/html')


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        S.update({'reports': [], 'posts': [], 'status': {}, 'user': 'Carl Healy'})
        ctx = await browser.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/London')
        await ctx.clock.install(time=NOW.isoformat())
        await ctx.route('https://eu.halaxy.com/**', halaxy)
        await ctx.add_init_script(CORE)
        await ctx.add_init_script("document.addEventListener('DOMContentLoaded', function () {\n" + SCRIPT + "\n});")
        pg = await ctx.new_page()
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        await pg.goto('https://eu.halaxy.com/a/pr/555/invoice/')
        await pg.wait_for_selector('a.upc-ob-menu', timeout=20000)
        await pg.click('a.upc-ob-menu')
        await pg.wait_for_selector('[data-upc-old-balances] .card', timeout=20000)
        cards = await pg.evaluate("[...document.querySelectorAll('[data-upc-old-balances] .card')].map((c) => [c.querySelector('h2').textContent, [...c.querySelectorAll('tbody tr')].map((tr) => [...tr.cells].map((x) => x.textContent.trim()))])")
        cd = dict(cards)
        check('one Unpaid Invoices report from 2000', S['reports'] == ['01-Jan-2000'], S['reports'])
        check('over 6 years: one row per invoice, balance from its last line, total', [r[1:6] for r in cd.get('Over 6 years (2, £ 100.00)', [])] == [
            ['UPC-01001', '03-Mar-2019', 'Patient Old', 'Self-Funded', '£ 40.00'], ['UPC-01002', '10-Jan-2020', 'Patient Two', 'Self-Funded', '£ 60.00']], cards)
        mid = [r[1] for r in cd.get('6 months to 6 years (61, £ 1,880.00)', [])]
        check('6 months to 6 years; under 6 months and paid off left out; thousands with a comma', len(mid) == 61 and 'UPC-01003' in mid and 'UPC-01004' not in mid and 'UPC-01005' not in mid, list(cd))
        q = await pg.evaluate("[...document.querySelectorAll('[data-upc-old-balances] p.text-muted')].pop().textContent")
        check('the line under the list gives the range', q == 'Active and Issued invoices dated before 22-May-2026 with a balance.', q)

        bar = await pg.evaluate("(() => { const b = document.querySelector('[data-upc-old-balances] .upc-page-bar'); return b && [b.querySelector('h1').textContent, b.querySelector('.upc-page-actions .btn').textContent]; })()")
        check('title bar: title left, Check now right; checked line under it', bar == ['Old balances', 'Check now'] and 'Checked at ' in await pg.evaluate("document.querySelector('[data-upc-old-balances] .upc-page-sub').textContent"), bar)
        vis = "[...document.querySelectorAll('[data-upc-list=mid] tbody tr')].filter((tr) => tr.style.display !== 'none').map((tr) => tr.cells[1].textContent.trim())"
        shown = await pg.evaluate(vis)
        more = await pg.evaluate("(document.querySelector('[data-upc-more=mid]') || {}).textContent")
        check('a long list shows 25 rows, then "Show 25 more"', len(shown) == 25 and more == 'Show 25 more', (len(shown), more))
        await pg.fill('input[data-upc-search=mid]', 'X2007')
        shown = await pg.evaluate(vis)
        cnt = await pg.evaluate("document.querySelector('[data-upc-list=mid]').previousElementSibling.querySelector('[data-upc-count]').textContent")
        check('search filters the rows: "1 of 61"', shown == ['UPC-02007'] and cnt == '1 of 61', (shown, cnt))
        await pg.fill('input[data-upc-search=mid]', '')
        await pg.click("[data-upc-list=mid] th:has-text('Balance')")
        await pg.click("[data-upc-list=mid] th:has-text('Balance')")
        shown = await pg.evaluate(vis)
        check('sorting by Balance, highest first, amounts as numbers', shown[:3] == ['UPC-02059', 'UPC-02058', 'UPC-02057'] and shown.index('UPC-02049') < shown.index('UPC-01003') < shown.index('UPC-02048'), shown[:3])

        await pg.click("[data-a=off][data-id='1001']")
        await pg.wait_for_selector('[data-upc-ob-confirm]')
        conf = await pg.evaluate("document.querySelector('[data-upc-ob-confirm]').innerText")
        check('asks first: which invoice, amount, who', 'Write off UPC-01001 (£ 40.00, Patient Old, 03-Mar-2019)?' in conf and not S['posts'], conf)
        await pg.click('[data-upc-ob-confirm] [data-c=yes]')
        await pg.click("[data-a=off][data-id='1002']")
        await pg.click('[data-upc-ob-confirm] [data-c=yes]')
        queued = await pg.evaluate("[...document.querySelectorAll('[data-upc-old-balances] tbody tr')].filter((tr) => tr.cells[1].textContent.trim() === 'UPC-01002').map((tr) => tr.cells[6].textContent.trim())")
        check('a second Write off pressed straight away waits its turn', queued == ['Queued'], queued)
        bar = await pg.evaluate("(document.querySelector('[data-upc-old-balances] .upc-batch') || {}).textContent")
        sub = await pg.evaluate("!!document.querySelector('[data-upc-old-balances] .upc-page-sub .upc-batch')")
        check('two queued: one bar for the batch in the line under the title bar (nothing moves)', bar == 'Writing off (0 of 2)' and sub, (bar, sub))
        await pg.wait_for_function("[...document.querySelectorAll('[data-upc-old-balances] tbody tr .upc-ok')].length === 2", timeout=30000)
        await pg.wait_for_function("document.querySelector('.upc-toast')", timeout=10000)
        msg = await pg.evaluate("document.querySelector('.upc-toast').textContent")
        check('the batch over: a toast saying how it went; the line under the title back to "Checked at"', msg == '2 written off.' and not await pg.evaluate("!!document.querySelector('[data-upc-old-balances] .upc-batch')")
              and 'Checked at' in await pg.evaluate("document.querySelector('[data-upc-old-balances] .upc-page-sub').textContent"), msg)
        check('status set to Write-off in the invoice settings, other fields as Halaxy filled them, one after the other',
              [x[0] for x in S['posts']] == [1001, 1002] and all(x[1].get('form[status]') == 'write-off' and x[1].get('form[_token]') == 'T' and x[1].get('form[displayDate]') == '03-Mar-2019' for x in S['posts']), S['posts'])
        await pg.check("[data-upc-list=mid] tr[data-upc-id='2059'] input[data-upc-tick]")
        await pg.check("[data-upc-list=mid] tr[data-upc-id='2058'] input[data-upc-tick]")
        tick = await pg.evaluate("(document.querySelector('[data-upc-bulk-for=mid]') || {}).textContent")
        check('ticked rows: count, total and "Write off 2" in the tool row', tick == '2 ticked, £ 119.00Write off 2', tick)
        await pg.click('[data-a=bulk][data-list=mid]')
        await pg.wait_for_selector('[data-upc-ob-confirm]')
        conf = await pg.evaluate("document.querySelector('[data-upc-ob-confirm]').innerText")
        check('asks once: how many, the total, which invoices', 'Write off 2 invoices, £ 119.00 in all?' in conf and 'UPC-02058, UPC-02059' in conf and len(S['posts']) == 2, conf)
        await pg.click('[data-upc-ob-confirm] [data-c=yes]')
        await pg.wait_for_function("[...document.querySelectorAll('[data-upc-old-balances] tbody tr .upc-ok')].length === 4", timeout=30000)
        check('both written off, one after the other; ticks cleared', [x[0] for x in S['posts']][2:] == [2058, 2059] and not await pg.evaluate("!!document.querySelector('[data-upc-bulk-for=mid]')"), S['posts'])
        look = await pg.evaluate("(() => { const r = document.querySelector('[data-upc-old-balances]'); return r.classList.contains('upc-native') && !r.shadowRoot && r.querySelector('table').className.startsWith('table table-striped table-bordered'); })()")
        check('Halaxy look', look)
        check('no page errors', not errors, errors)
        await ctx.close()

        S.update({'reports': [], 'user': 'Physio One'})
        ctx = await browser.new_context(timezone_id='Europe/London')
        await ctx.route('https://eu.halaxy.com/**', halaxy)
        await ctx.add_init_script(CORE)
        await ctx.add_init_script("document.addEventListener('DOMContentLoaded', function () {\n" + SCRIPT + "\n});")
        pg = await ctx.new_page()
        await pg.goto('https://eu.halaxy.com/a/pr/555/invoice/#upc-old-balances')
        await pg.wait_for_timeout(3000)
        check('someone else: no menu item, no page, nothing read', not await pg.evaluate("!!document.querySelector('a.upc-ob-menu, [data-upc-old-balances]')") and not S['reports'])
        await browser.close()
    print('\n' + ('All passed' if not FAILS else '%d failed' % len(FAILS)))
    sys.exit(1 if FAILS else 0)


asyncio.run(main())
