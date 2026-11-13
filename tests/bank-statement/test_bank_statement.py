"""
Test for Bank statement and core's UPC.invoice.payOffline, against a mock Halaxy and an invented statement in the
Starling layout (columns DATE | TYPE | TRANSACTION | IN | OUT | ACCOUNT BALANCE, second page without a header).

Checks: the statement is read and checked against the running balance; only insurer credits are used (a transfer
from the old account naming an insurer counts as that insurer); matching by shared remittance first, then one invoice,
then the only set that adds up; invoices dated after the credit and patients' own invoices are left out; several
answers are offered to choose from; no answer says so; nothing is recorded until confirmed; each payment is recorded
as Direct Deposit on the bank date with the amount and a note; a recorded credit is remembered; an invoice with less
outstanding than expected is not paid; Carl only.

Run:  python3 tests/bank-statement/test_bank_statement.py
Needs: Python 3 with Playwright (Chromium) and reportlab; npm (installs pdf.js into tests/bank-statement/node_modules
on first run).
"""
import asyncio, json, subprocess, sys, urllib.parse
from pathlib import Path
from playwright.async_api import async_playwright
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
if not (HERE / 'node_modules' / 'pdfjs-dist').exists():
    subprocess.run(['npm', 'install', '--no-audit', '--no-fund', '--no-package-lock', '--silent'], cwd=HERE, check=True)
LIBS = HERE / 'node_modules'
CORE = (ROOT / 'beta' / 'core.user.js').read_text().replace('perMinute: 45,', 'perMinute: 100000,')   # tests: no 45-a-minute wait (the 300 ms gap stays)
BANK = (ROOT / 'beta' / 'bank-statement.user.js').read_text()
FIX = HERE / '.fixtures'
FAILS = []
S = {}
gbp = lambda c: '£%.2f' % (c / 100)


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)))
    if not ok:
        FAILS.append(name)

# ------------------------------------------------------------------ invented statement (Starling layout)

# (date, type, details, in, out); the balance is worked out and shown on every other row, as on the real thing
TX = [
    ('01/10/2026', 'CARD SUBSCRIPTION', 'Software Co', None, 2500),
    ('03/10/2026', 'FASTER PAYMENT', 'Card Takings Ltd (SETTLEMENT)', 31000, None),
    ('05/10/2026', 'DIRECT CREDIT', 'Bupa (2455419)', 12000, None),
    ('08/10/2026', 'DIRECT DEBIT', 'Energy Supplier', None, 9000),
    ('12/10/2026', 'DIRECT CREDIT', 'Axa Health Service (GB33AXA0001)', 7500, None),
    ('15/10/2026', 'FASTER PAYMENT', 'HEALTH TRUST PAYMENTS (UPC-0961)', 4500, None),
    ('16/10/2026', 'FASTER PAYMENT', 'J SMITH (UPC0905)', 12000, None),
    ('18/10/2026', 'DIRECT CREDIT', 'Bupa (UPC-0800)', 3500, None),
    ('20/10/2026', 'FASTER PAYMENT', 'URMSTON PHYSIO CLINIC (WPA)', 9000, None),
    ('25/10/2026', 'DIRECT CREDIT', 'Aviva Health (AV778812)', 6000, None),
    ('28/10/2026', 'DIRECT CREDIT', 'Vitality Health (VH1001)', 5500, None),
    ('29/10/2026', 'DIRECT CREDIT', 'Cigna Healthcare (CG55)', 4400, None),
    ('29/10/2026', 'DIRECT CREDIT', 'Simplyhealth (SH12)', 3300, None),
    ('30/10/2026', 'ONLINE PAYMENT', 'Landlord Rent October', None, 80000),
]


def make_statement(path, tx=None):
    tx = tx or TX
    c = canvas.Canvas(str(path), pagesize=A4)
    c.setFont('Helvetica', 8)
    def header(y):
        for x, s in [(40, 'DATE'), (100, 'TYPE'), (190, 'TRANSACTION')]:
            c.drawString(x, y, s)
        c.drawRightString(445, y, 'IN')
        c.drawRightString(500, y, 'OUT')
        c.drawString(512, y, 'ACCOUNT')
        c.drawRightString(562, y, 'BALANCE')
    c.drawString(40, 800, 'Business account statement')
    header(760)
    y, bal = 740, 100000
    for k, (d, t, desc, i, o) in enumerate(tx):
        if k == 6:   # page 2: no header
            c.showPage(); c.setFont('Helvetica', 8); y = 800
        bal += (i or 0) - (o or 0)
        c.drawString(40, y, d); c.drawString(100, y, t); c.drawString(190, y, desc)
        if i: c.drawRightString(445, y, gbp(i))
        if o: c.drawRightString(500, y, gbp(o))
        if k % 2 == 0: c.drawRightString(562, y, gbp(bal))
        if k == 2:   # a wrapped detail line belongs to the row above
            y -= 10; c.drawString(190, y, 'REMITTANCE')
        y -= 18
    c.save()

# ------------------------------------------------------------------ mock Halaxy

COLS = ['Invoice / Deposit', 'Date', 'Due Date', 'Practitioner', 'Payer ID', 'Payer', 'Funder', 'Category', 'Fee', 'Quantity',
        'Appointment Status', 'Invoice Status', 'Tax', 'Amount', 'Payments', '', 'Date', 'Method', 'Payments Inc. Fees', 'Balance', '']


def fresh():
    # id: [payer, funder, invoice date, balance, attachments]
    return {
        901: ['Bupa', 'Bupa', '20-Sep-2026', 4000, [('Bupa remittance 2026-09-30', 'Insurer reference 2455419; remittance total £ 120.00 over 2 invoices')]],
        902: ['Bupa', 'Bupa', '22-Sep-2026', 8000, [('Bupa remittance 2026-09-30', 'Insurer reference 2455419; remittance total £ 120.00 over 2 invoices')]],
        903: ['Bupa', 'Bupa', '24-Sep-2026', 12000, []],               # one invoice for the amount, but the remittance wins
        904: ['Bupa', 'Bupa', '10-Sep-2026', 6000, [('Bupa remittance 2026-09-28', 'Insurer reference 2455001')]],      # another remittance (comment from before 0.3.3) that also adds
        906: ['Bupa', 'Bupa', '11-Sep-2026', 6000, [('Bupa remittance 2026-09-28', 'Insurer reference 2455001')]],      #   up to 120.00: the one with the bank's reference wins
        905: ['Patient X', 'Bupa', '01-Sep-2026', 12000, []],          # the patient's own invoice: never used
        911: ['AXA Health', 'AXA Health', '01-Oct-2026', 7500, []],    # one invoice for the amount
        912: ['AXA Health', 'AXA Health', '20-Oct-2026', 7500, []],    # dated after the credit: left out
        921: ['WPA', 'WPA', '01-Sep-2026', 5000, []],                  # 921 + 922 the only set for 90.00
        922: ['WPA', 'WPA', '02-Sep-2026', 4000, []],
        923: ['WPA', 'WPA', '03-Sep-2026', 3000, []],
        931: ['Aviva', 'Aviva', '01-Sep-2026', 2000, []],              # 931 + 932 or 931 + 933: choose
        932: ['Aviva', 'Aviva', '02-Sep-2026', 4000, []],
        933: ['Aviva', 'Aviva', '03-Sep-2026', 4000, []],
        961: ['Health Trust', 'Health Trust', '01-Oct-2026', 4500, []],   # named in the bank reference; an insurer not on our list
        907: ['Bupa', 'Bupa', '10-Oct-2026', 3500, []],                   # paid with a reused old reference (UPC-0800, paid long ago)
        # Vitality: two remittances without a reference add up; the one dated 4 days before the payment wins
        # (its comment's payment date, 24-Oct, is used rather than the date in its title)
        941: ['Vitality', 'Vitality', '01-Oct-2026', 2500, [('Vitality remittance 2026-10-20', 'Payment date 24-Oct-2026; remittance total £ 55.00 over 2 invoices; this invoice billed £ 25.00, paid £ 25.00')]],
        942: ['Vitality', 'Vitality', '02-Oct-2026', 3000, [('Vitality remittance 2026-10-20', 'Payment date 24-Oct-2026; remittance total £ 55.00 over 2 invoices; this invoice billed £ 30.00, paid £ 30.00')]],
        944: ['Vitality', 'Vitality', '01-Jun-2026', 2000, [('Vitality remittance 2026-07-01', 'Remittance total £ 55.00 over 2 invoices')]],
        945: ['Vitality', 'Vitality', '02-Jun-2026', 3500, [('Vitality remittance 2026-07-01', 'Remittance total £ 55.00 over 2 invoices')]],
        # Simplyhealth: the only remittance that adds up is months away from the payment: offered, not ticked
        # (attached by hand, named by its date, no comment: the date comes from the file name)
        951: ['Simplyhealth', 'Simplyhealth', '15-Jul-2026', 3300, [('2026-06-01.pdf', '')]],
        # An old unpaid Aviva invoice for exactly £ 60.00: more than 120 days before the payment, never offered
        981: ['Aviva', 'Aviva', '01-Jan-2026', 6000, []],
        # Cigna: the remittance paid £ 44.00 on these, but the excesses were never moved, so Halaxy still shows £ 60.00
        971: ['Cigna', 'Cigna', '01-Oct-2026', 3000, [('Cigna remittance 2026-10-27', 'Insurer reference ZZ1; payment date 27-Oct-2026; remittance total £ 44.00 over 2 invoices; this invoice billed £ 30.00, paid £ 24.00')]],
        972: ['Cigna', 'Cigna', '02-Oct-2026', 3000, [('Cigna remittance 2026-10-27', 'Insurer reference ZZ1; payment date 27-Oct-2026; remittance total £ 44.00 over 2 invoices; this invoice billed £ 30.00, paid £ 20.00')]],
    }


def report_html():
    head = "<thead><tr>%s</tr></thead>" % ''.join('<th>%s</th>' % c for c in COLS)
    body = ''
    for iid, (payer, funder, day, bal, _) in S['inv'].items():
        if bal <= 0:
            continue
        # As live (12 Nov 2026): an invoice with two fees has a second row with the invoice-level cells blank and the
        # balance on the last row. Every invoice of £ 50.00 or more is shown as two fees.
        parts = [bal - 2000, 2000] if bal >= 5000 else [bal]
        for k, a in enumerate(parts):
            first, lastrow = k == 0, k == len(parts) - 1
            v = {'Invoice / Deposit': "<a href='/a/pr/555/invoice/%d'>UPC-0%d</a>" % (iid, iid) if first else '', 'Date': day if first else '',
                 'Payer ID': str(iid) if first else '', 'Payer': payer if first else '', 'Funder': funder if first else '', 'Fee': 'Follow-Up',
                 'Appointment Status': 'Attended', 'Invoice Status': 'Issued' if first else '', 'Amount': gbp(a), 'Balance': gbp(bal) if lastrow else ''}
            body += '<tr>' + ''.join('<td>%s</td>' % (v.get(c, '') if c else '') for c in COLS) + '</tr>'
    return "<html><body><table class='table-report'>%s<tbody>%s</tbody></table></body></html>" % (head, body)


INC_COLS = [c for c in COLS if c != 'Invoice Status']


def income_html(q):
    # Halaxy's Income report (capture 12 Nov 2026): payments by payment date, one row per fee, the payment on its
    # invoice's first row (a second payment on a later row that repeats the number unlinked).
    import datetime as dt
    day = lambda t: dt.datetime.strptime(t, '%d-%b-%Y')
    pays = [(i, f['form[paymentDate]'], round(float(f['form[amount]']) * 100), 'Direct Deposit') for i, f in S['posts_all']] + [h[:4] for h in S.get('hand', [])]
    pays = [x for x in pays if day(q['start']) <= day(x[1]) <= day(q['stop'])]
    head = "<thead><tr><th colspan='12'>Fees &amp; Charges</th><th></th><th colspan='6'>Payments</th></tr><tr>%s</tr></thead>" % ''.join('<th>%s</th>' % c for c in INC_COLS)
    body, seen = '', set()
    for iid, when, amt, method in pays:
        payer, funder = S['inv'][iid][0], S['inv'][iid][1]
        first = iid not in seen
        seen.add(iid)
        v = {'Invoice / Deposit': ("<a href='/a/pr/555/invoice/%d'>UPC-0%d</a>" if first else 'UPC-0%d') % ((iid, iid) if first else (iid,)), 'Date': '01-Sep-2026' if first else '',
             'Payer': payer if first else '', 'Funder': funder if first else '', 'Amount': '£ 40.00' if first else '', 'Payments': gbp(amt), 'Method': method, 'Payments Inc. Fees': gbp(amt)}
        cells, dates = [], 0
        for c in INC_COLS:
            if c == 'Date':
                dates += 1
                cells.append(v['Date'] if dates == 1 else when)
            else:
                cells.append(v.get(c, '') if c else '')
        body += '<tr>' + ''.join('<td>%s</td>' % x for x in cells) + '</tr>'
        if first:   # a second fee row with no payment
            body += '<tr>' + ''.join('<td>%s</td>' % ('UPC-0%d' % iid if c == 'Invoice / Deposit' else '£ 10.00' if c == 'Amount' else '') for c in INC_COLS) + '</tr>'
    return "<html><body><table class='table table-report'>%s<tbody>%s</tbody></table></body></html>" % (head, body)


def invoice_html(iid):
    payer, funder, day, bal, att = S['inv'][iid]
    shown = bal - S['short'].get(iid, 0)
    rows = "<tr><td data-property='date'>%s</td><td data-property='itemNumber'>PHY</td><td data-property='amount'>%s</td><td><a href='/a/pr/555/invoice/line/%d/edit'>Edit</a></td></tr>" % (day, gbp(bal), iid * 10)
    atts = ''.join('<tr>\n<td>%s</td>\n<td>Payment</td>\n<td>%s</td>\n<td>%s</td>\n</tr>' % (day, t, c) for t, c in att)
    pays = ''.join("<tr><td>%s</td><td>Direct Deposit (%s)</td><td>Paid</td><td>%s</td></tr>" % (f['form[paymentDate]'], f['form[note]'], gbp(round(float(f['form[amount]']) * 100))) for i, f in S['posts_all'] if i == iid)
    pays += ''.join("<tr><td>%s</td><td>%s%s</td><td>Paid</td><td>%s</td></tr>" % (h[1], h[3], ' (%s)' % h[4] if len(h) > 4 else '', gbp(h[2])) for h in S.get('hand', []) if h[0] == iid)
    # As live (12 Nov 2026): paid in full, the page is a "Receipt" with no Outstanding row.
    kind = 'Receipt' if shown <= 0 else 'Invoice'
    outst = '' if shown <= 0 else "<tr><td></td><td></td><td>Outstanding</td><td>%s</td></tr>" % gbp(shown)
    return ("<html><head><title>%s UPC-0%d | Halaxy</title></head><body><table id='invoiceLines'><tbody>%s<tr><td>Total</td><td>%s</td></tr></tbody></table>"
            "<table id='invoicePayments'><tbody>%s%s</tbody></table>"
            "<table id='invoiceAttachments'><tbody>%s</tbody></table></body></html>") % (kind, iid, rows, gbp(bal), pays, outst, atts)


PAY_FORM = """<form id="paymentForm" method="post">
<select name="form[paymentMethod]"><option value="592" selected>Card</option><option value="1">Cash</option><option value="9">Direct Deposit</option>
<option value="732">Gift Card</option><option value="18">Other</option><option value="332">Debt Written Off</option><option value="3">Cheque</option><option value="99">Discount</option></select>
<input type="text" name="form[paymentDate]" value="11-Nov-2026">
<input type="radio" name="form[discountType]" value="1" checked><input type="radio" name="form[discountType]" value="2">
<select name="form[invoiceDiscount]"><option value="" selected></option><option value="32">CLAN10 (10%% OFF)</option></select>
<input type="text" name="form[invoiceOutstandingAmount]" value="%s"><input type="text" name="form[amount]" value="%s">
<input type="text" name="form[discountPercentage]" value=""><input type="text" name="form[note]" value="">
<input type="radio" name="form[overPaymentDepositSelect]" value="1" checked><input type="radio" name="form[overPaymentDepositSelect]" value="2">
<input type="hidden" name="form[_token]" value="tok123"></form>"""


def page_html(user):
    return ("<!doctype html><html><head><title>Invoices | Halaxy</title></head><body style='margin:0 0 0 230px'>"
            "<div style='position:fixed;left:0;top:0;bottom:0;width:218px'><nav id='side'><ul id='mainMenu'>"
            "<li class='mainmenu-item active'><a class='mainmenu-link'><span class='mainmenu-link-label'>Finances</span></a>"
            "<ul><li><a class='mainmenu-sublink' href='/a/pr/555/expense/'>Expenses</a></li><li class='active'><a class='mainmenu-sublink active' href='/a/pr/555/invoice/'>Invoices</a></li></ul></li></ul></nav></div>"
            "<div id='headerWrapper' style='height:50px'></div><h1>Invoices</h1>"
            "<script>window.HkUser = { linkPrG: 11, pracID: 11, pracName: %s };</script></body></html>") % json.dumps(user)


async def halaxy(route):
    req = route.request
    u = urllib.parse.urlparse(req.url)
    p = u.path
    S['log'].append((req.method, p))
    if p.endswith('/report/finance/0'):
        q = dict(urllib.parse.parse_qsl(u.query))
        S.setdefault('reports', []).append(q.get('type'))
        return await route.fulfill(body=income_html(q) if q.get('type') == '1' else report_html(), content_type='text/html')
    m = __import__('re').match(r'^/a/pr/555/invoicefunctions/(\d+)/pay/offline$', p)
    if m:
        iid = int(m.group(1))
        bal = S['inv'][iid][3]
        if req.method == 'GET':
            return await route.fulfill(body=json.dumps({'status': 'FORM', 'message': PAY_FORM % ('%.2f' % (bal / 100), '%.2f' % (bal / 100))}), content_type='application/json')
        f = dict(urllib.parse.parse_qsl(req.post_data or '', keep_blank_values=True))
        if iid in S.get('failOnce', set()):   # Halaxy refuses it once
            S['failOnce'].discard(iid)
            return await route.fulfill(body=json.dumps({'status': 'FORM', 'errors': ['Payment could not be saved']}), content_type='application/json')
        S['posts'].append((iid, f))
        S['posts_all'].append((iid, f))
        S['inv'][iid][3] = bal - round(float(f['form[amount]']) * 100)
        # As live (12 Nov 2026): recorded, but the answer is neither OK nor REFRESH.
        return await route.fulfill(body=json.dumps({'status': 'POPUP', 'url': '/a/pr/555/invoice/%d' % iid}), content_type='text/html')
    m = __import__('re').match(r'^/a/pr/555/task/invoice/(\d+)/list-data$', p)
    if m:
        return await route.fulfill(body=json.dumps([{'id': k, 'title': t.get('form[title]'), 'status': 'Open'} for k, t in enumerate(S.setdefault('tasks', {}).get(int(m.group(1)), []))]), content_type='application/json')
    m = __import__('re').match(r'^/a/pr/555/task/new/invoice/(\d+)$', p)
    if m:
        iid = int(m.group(1))
        if req.method == 'GET':
            form_html = ("<form id='form_task_edit' name='form' method='post'><input name='form[title]' value=''>"
                         "<input type='radio' name='form[actionerType]' value='1' checked><select name='form[linkPrGs][]' multiple><option value='31'>Carl Healy</option></select>"
                         "<input type='radio' name='form[priority]' value='1'><input type='radio' name='form[priority]' value='2' checked><input type='radio' name='form[priority]' value='3'>"
                         "<input name='form[displayDueDate]' value=''><textarea name='form[comment]'></textarea><input type='hidden' name='form[_token]' value='tok-task'></form>")
            return await route.fulfill(body=json.dumps({'status': 'FORM', 'title': 'Add task for invoice', 'message': form_html}), content_type='application/json')
        f = dict(urllib.parse.parse_qsl(req.post_data or '', keep_blank_values=True))
        S.setdefault('tasks', {}).setdefault(iid, []).append(f)
        return await route.fulfill(body=json.dumps({'status': 'POPUP', 'url': '/a/pr/555/task/list/invoice/%d' % iid}), content_type='application/json')
    m = __import__('re').match(r'^/a/pr/555/invoice/(\d+)/?$', p)
    if m:
        return await route.fulfill(body=invoice_html(int(m.group(1))), content_type='text/html')
    if p.startswith('/a/pr/555/'):
        return await route.fulfill(body=page_html(S['user']), content_type='text/html')
    await route.fulfill(status=404, body='not mocked')


async def cdn(route):
    path = route.request.url.split('cdn.jsdelivr.net/npm/')[1].split('?')[0]
    name, _, sub = path.partition('/')
    f = LIBS / name.split('@')[0] / sub
    if not f.is_file():
        return await route.fulfill(status=404, body='not found')
    await route.fulfill(body=f.read_bytes(), content_type='application/javascript', headers={'Access-Control-Allow-Origin': '*'})


async def context(browser):
    ctx = await browser.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/London')
    await ctx.clock.install(time='2026-11-11T12:00:00Z')
    await ctx.route('https://eu.halaxy.com/**', halaxy)
    await ctx.route('https://cdn.jsdelivr.net/**', cdn)
    await ctx.add_init_script(CORE)
    await ctx.add_init_script("document.addEventListener('DOMContentLoaded', function () {\n" + BANK + "\n});")
    return ctx


ROWS = """[...document.querySelectorAll('[data-upc-bank-statement] tbody tr')].map((tr) => ({ off: tr.classList.contains('upc-off'),
  cells: [...tr.cells].map((c) => c.textContent.replace(/\\s+/g, ' ').trim()), radios: tr.querySelectorAll('input[type=radio]').length,
  rec: !!tr.querySelector('[data-rec]') }))"""
URL = 'https://eu.halaxy.com/a/pr/555/invoice/#upc-bank-statement'


async def open_statement(pg, pdf):
    await pg.wait_for_selector('[data-upc-bank-statement] .upc-bank-drop', state='attached', timeout=20000)
    await pg.set_input_files('[data-upc-bank-statement] input[type=file]', str(pdf))
    await pg.wait_for_function("document.querySelector('[data-upc-bank-statement] table') || document.querySelector('[data-upc-bank-statement] .upc-err')", timeout=60000)
    return await pg.evaluate(ROWS)


async def main():
    FIX.mkdir(exist_ok=True)
    pdf = FIX / 'statement.pdf'
    make_statement(pdf)
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        S.update({'log': [], 'posts': [], 'posts_all': [], 'inv': fresh(), 'short': {}, 'user': 'Carl Healy', 'tasks': {}})
        ctx = await context(browser)
        pg = await ctx.new_page()
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        await pg.goto(URL)
        rows = await open_statement(pg, pdf)
        info = await pg.evaluate("document.querySelector('[data-upc-bank-statement] p.text-muted').textContent")
        check('statement read and checked against the running balance', '14 transactions, 01-Oct-2026 to 30-Oct-2026' in info and 'Read correctly' in info, info)
        by = {}
        for r in rows:
            by.setdefault(r['cells'][1], r)
        check('only insurer credits, in date order', [r['cells'][1] for r in rows] == ['Bupa', 'AXA', 'Health Trust', 'Bupa', 'WPA', 'Aviva', 'Vitality', 'Cigna', 'Simplyhealth'], [r['cells'][:4] for r in rows])
        check('reference and amount shown', by['Bupa']['cells'][2:4] == ['2455419', '£ 120.00'], by['Bupa']['cells'])
        check('shared remittance first, the one with the bank\'s reference (not another remittance or the single £ 120.00 invoice)', 'UPC-0901' in by['Bupa']['cells'][4] and 'UPC-0902' in by['Bupa']['cells'][4]
              and 'UPC-0903' not in by['Bupa']['cells'][4] and 'reference 2455419, dated 30-Sep-2026, 5 days before the payment (the same reference as the bank)' in by['Bupa']['cells'][4], by['Bupa']['cells'])
        check('one invoice for the whole amount (offered, not ticked: amount alone); one dated after the credit left out', 'UPC-0911' in by['AXA']['cells'][4] and 'UPC-0912' not in by['AXA']['cells'][4] and 'one invoice' in by['AXA']['cells'][4] and by['AXA']['radios'] == 1 and not by['AXA']['rec'], by['AXA'])
        check('an old unpaid invoice for the same amount (over 120 days before) is never offered', 'UPC-0981' not in by['Aviva']['cells'][4], by['Aviva']['cells'])
        check('transfer from the old account naming WPA: the only set that adds up', 'UPC-0921' in by['WPA']['cells'][4] and 'UPC-0922' in by['WPA']['cells'][4] and 'UPC-0923' not in by['WPA']['cells'][4], by['WPA']['cells'])
        check('several answers: offered to choose, nothing ticked', by['Aviva']['radios'] == 2 and not by['Aviva']['rec'] and 'choose' in by['Aviva']['cells'][4], by['Aviva'])
        v = by['Vitality']['cells'][4]
        check('no reference: the remittance dated near the payment wins', 'UPC-0941' in v and 'UPC-0942' in v and 'UPC-0944' not in v and 'dated 24-Oct-2026, 4 days before the payment' in v and by['Vitality']['rec'], v)
        sh = by['Simplyhealth']
        check('remittance months from the payment: offered, not ticked', sh['radios'] == 1 and not sh['rec'] and 'check the date' in sh['cells'][4] and 'UPC-0951' in sh['cells'][4], sh)
        check('no answer: says so, greyed', by['Cigna']['off'] and 'Not matched' in by['Cigna']['cells'][4], by['Cigna'])
        check('remittance paid it but the excess was never moved: says to run Remittances first', 'UPC-0971' in by['Cigna']['cells'][4] and 'UPC-0972' in by['Cigna']['cells'][4] and 'but Halaxy still shows £ 60.00' in by['Cigna']['cells'][4] and 'Remittances first' in by['Cigna']['cells'][4], by['Cigna']['cells'])
        ht = by['Health Trust']['cells']
        check('invoice number in the bank reference: matched, insurer taken from the invoice', 'UPC-0961' in ht[4] and 'invoice number in the bank reference' in ht[4] and by['Health Trust']['rec'], ht)
        reused = next((r['cells'] for r in rows if r['cells'][3] == '£ 35.00'), [])
        check('reused old reference: matched by amount and date instead, and says so', reused[1:2] == ['Bupa'] and 'UPC-0907' in reused[4] and 'UPC-0800, which doesn' in reused[4], reused)
        check('a patient paying by transfer (names a patient invoice) is left out', not any('£ 120.00' == r['cells'][3] and r['cells'][1] != 'Bupa' for r in rows) and len(rows) == 9, [r['cells'][:4] for r in rows])
        check('the patient\'s own invoice is never offered', not any('UPC-0905' in r['cells'][4] for r in rows), rows)
        btn = await pg.evaluate("document.querySelector('[data-upc-bank-statement] [data-a=all]').textContent")
        check('record button counts only the ones matched by evidence (invoice number, remittance)', btn == 'Record 3 payments', btn)
        reads = [x for x in S['log'] if x[1].endswith('/report/finance/0')]
        check('two report requests (unpaid invoices, payments recorded); nothing written while matching', len(reads) == 2 and sorted(S['reports']) == ['1', '5'] and not S['posts'] and not [x for x in S['log'] if x[0] == 'POST'], S['log'])

        # choose for Aviva, then cancel: nothing recorded
        for k in (1, 3, 4, 5):   # AXA, Bupa (reused reference), WPA, Aviva: amount only, ticked by hand
            await pg.click('[data-upc-bank-statement] input[data-pick="%d:0"]' % k)
        btn = await pg.evaluate("document.querySelector('[data-upc-bank-statement] [data-a=all]').textContent")
        check('a chosen answer joins the button', btn == 'Record 7 payments', btn)
        await pg.click('[data-upc-bank-statement] [data-a=all]')
        await pg.wait_for_selector('[data-upc-bank-confirm]', timeout=10000)
        conf = await pg.evaluate("document.querySelector('[data-upc-bank-confirm]').textContent")
        check('confirm lists each payment and its invoices', 'Direct Deposit' in conf and 'UPC-0921' in conf and 'Aviva' in conf, conf)
        await pg.click('[data-upc-bank-confirm] [data-c=no]')
        await pg.wait_for_timeout(500)
        check('cancel: nothing recorded', not S['posts'], S['posts'])

        # confirm: all four recorded
        await pg.click('[data-upc-bank-statement] [data-a=all]')
        await pg.wait_for_selector('[data-upc-bank-confirm]', timeout=10000)
        await pg.click('[data-upc-bank-confirm] [data-c=yes]')
        try:
            await pg.wait_for_function("[...document.querySelectorAll('[data-upc-bank-statement] tbody tr')].filter((tr) => /Recorded/.test(tr.textContent)).length === 7", timeout=180000)
        except Exception:
            print("rows when recording stalled:", [i for i, _ in S['posts']], await pg.evaluate("[...document.querySelectorAll('[data-upc-bank-statement] tbody tr')].map((tr) => tr.innerText.replace(/\\s+/g, ' ').slice(0, 300))"))
            raise
        paid = {iid: f for iid, f in S['posts']}
        check('paid exactly the matched invoices', sorted(paid)[:7] == [901, 902, 907, 911, 921, 922, 931] and len(paid) == 11 and sorted(paid)[7] in (932, 933) and sorted(paid)[8:] == [941, 942, 961], sorted(paid))
        f = paid.get(902, {})
        check('Direct Deposit, bank date, amount, note', f.get('form[paymentMethod]') == '9' and f.get('form[paymentDate]') == '05-Oct-2026' and f.get('form[amount]') == '80.00'
              and f.get('form[note]') == 'Bupa, bank 05-Oct-2026, ref 2455419', f)
        check('no discount; everything else as Halaxy filled it', f.get('form[invoiceDiscount]') == '' and f.get('form[discountPercentage]') == '' and f.get('form[_token]') == 'tok123'
              and f.get('form[overPaymentDepositSelect]') == '1' and f.get('form[discountType]') == '1', f)
        check('WPA transfer recorded on its bank date', paid.get(921, {}).get('form[paymentDate]') == '20-Oct-2026' and 'WPA, bank 20-Oct-2026' in paid.get(921, {}).get('form[note]', ''), paid.get(921))
        check('balances now nil', all(S['inv'][i][3] == 0 for i in paid), {i: S['inv'][i][3] for i in paid})
        check('no page errors', not errors, errors)

        # the same statement again: recorded credits remembered
        S['log'] = []; S['posts'] = []
        await pg.goto(URL)
        await pg.reload()
        rows = await open_statement(pg, pdf)
        done = [r['cells'][1] for r in rows if 'Recorded' in r['cells'][5]]
        check('opened again: recorded credits shown as done, nothing to record', done == ['Bupa', 'AXA', 'Health Trust', 'Bupa', 'WPA', 'Aviva', 'Vitality'] and not await pg.evaluate("!!document.querySelector('[data-upc-bank-statement] [data-a=all]')"), rows)
        await ctx.close()

        # an invoice shows less outstanding than the report (paid meanwhile): not paid, error on its row
        S.update({'log': [], 'posts': [], 'posts_all': [], 'inv': fresh(), 'short': {911: 1000}, 'user': 'Carl Healy', 'tasks': {}})
        ctx = await context(browser)
        pg = await ctx.new_page()
        await pg.goto(URL)
        await open_statement(pg, pdf)
        await pg.click('[data-upc-bank-statement] input[data-pick="1:0"]')   # AXA: amount only, ticked by hand
        await pg.click('[data-upc-bank-statement] tbody tr:nth-child(2) [data-rec]')
        await pg.wait_for_selector('[data-upc-bank-confirm]', timeout=10000)
        await pg.click('[data-upc-bank-confirm] [data-c=yes]')
        await pg.wait_for_function("document.querySelector('[data-upc-bank-statement] tbody tr:nth-child(2) .upc-err')", timeout=30000)
        err = await pg.evaluate("document.querySelector('[data-upc-bank-statement] tbody tr:nth-child(2) .upc-err').textContent")
        check('less outstanding than expected: nothing recorded, says so', not S['posts'] and 'now shows £ 65.00 outstanding' in err and 'Nothing was recorded' in err, (err, S['posts']))
        check('nothing recorded: no task needed', not S.get('tasks'), S.get('tasks'))
        await ctx.close()

        # Recording stops part way (Halaxy refuses the second invoice, UPC-0901, once): nothing twice, and it carries on
        S.update({'log': [], 'posts': [], 'posts_all': [], 'inv': fresh(), 'short': {}, 'user': 'Carl Healy', 'failOnce': {901}, 'tasks': {}})
        ctx = await context(browser)
        pg = await ctx.new_page()
        await pg.goto(URL)
        await open_statement(pg, pdf)
        await pg.click('[data-upc-bank-statement] tbody tr:nth-child(1) [data-rec]')
        await pg.wait_for_selector('[data-upc-bank-confirm]', timeout=10000)
        await pg.click('[data-upc-bank-confirm] [data-c=yes]')
        try:
            await pg.wait_for_function("document.querySelector('[data-upc-bank-statement] tbody tr:nth-child(1) .upc-err')", timeout=30000)
        except Exception:
            print("row when the stop was expected:", S['posts'], await pg.evaluate("document.querySelector('[data-upc-bank-statement] tbody tr:nth-child(1)').innerText"))
            raise
        check('stopped part way: the first invoice recorded, the second not', [i for i, _ in S['posts']] == [902], S['posts'])
        err = await pg.evaluate("document.querySelector('[data-upc-bank-statement] tbody tr:nth-child(1) .upc-err').textContent")
        tk = [t for ts in S.get('tasks', {}).values() for t in ts]
        check('part way: says which were recorded, and a task for Carl', 'Stopped part way' in err and 'UPC-0902 £ 80.00' in err and 'Task added for Carl Healy' in err
              and len(tk) == 1 and tk[0].get('form[title]', '').startswith('Bank statement stopped on') and tk[0].get('form[linkPrGs][]') == '31' and tk[0].get('form[priority]') == '3', (err, tk))
        # Opened again later: the rest is matched and recorded, the first never twice
        perr = []
        pg.on('pageerror', lambda e: perr.append(str(e)))
        await pg.goto(URL)
        await pg.reload()
        try:
            rows = await open_statement(pg, pdf)
        except Exception as e:
            print("on opening again:", perr, await pg.evaluate("document.querySelector('[data-upc-bank-statement]') && document.querySelector('[data-upc-bank-statement]').innerText.slice(0, 600)"))
            raise
        b = rows[0]['cells'][4]
        check('opened again: says what was recorded, matches the rest', '£ 80.00 already recorded on UPC-0902' in b and 'UPC-0901 £ 40.00' in b and rows[0]['rec'], b)
        await pg.click('[data-upc-bank-statement] tbody tr:nth-child(1) [data-rec]')
        await pg.wait_for_selector('[data-upc-bank-confirm]', timeout=10000)
        await pg.click('[data-upc-bank-confirm] [data-c=yes]')
        try:
            await pg.wait_for_function("/Recorded/.test(document.querySelector('[data-upc-bank-statement] tbody tr:nth-child(1)').textContent)", timeout=90000)
        except Exception:
            print("row when the rest was expected:", S['posts'], await pg.evaluate("document.querySelector('[data-upc-bank-statement] tbody tr:nth-child(1)').innerText"))
            raise
        check('the rest recorded, nothing twice', [i for i, _ in S['posts']] == [902, 901] and S['inv'][901][3] == 0 and S['inv'][902][3] == 0, S['posts'])
        await ctx.close()

        # Recorded in Halaxy by hand (Carl, 12 Nov 2026): Aviva's £ 60.00 on its bank date, Simplyhealth's £ 33.00 on its
        # remittance's date 2 days before; a card payment the same day is not an insurer's. Shown as already recorded.
        inv = fresh()
        inv[931][3] = 0; inv[932][3] = 0; inv[951][3] = 0
        S.update({'log': [], 'posts': [], 'posts_all': [], 'inv': inv, 'short': {}, 'user': 'Carl Healy', 'tasks': {}, 'reports': [],
                  'hand': [(931, '25-Oct-2026', 2000, 'Direct Deposit'), (932, '25-Oct-2026', 4000, 'Direct Deposit'), (933, '25-Oct-2026', 6000, 'Card'),
                           (951, '27-Oct-2026', 3300, 'Direct Deposit')]})
        ctx = await context(browser)
        pg = await ctx.new_page()
        await pg.goto(URL)
        rows = await open_statement(pg, pdf)
        by = {r['cells'][1]: r for r in rows}
        av, sh = by.get('Aviva', {'cells': [''] * 6}), by.get('Simplyhealth', {'cells': [''] * 6})
        check('recorded by hand on the bank date: already in Halaxy, nothing to do', 'UPC-0931 £ 20.00' in av['cells'][4] and 'UPC-0932 £ 40.00' in av['cells'][4]
              and 'Already in Halaxy' in av['cells'][5] and av['off'] and not av['rec'] and 'UPC-0933' not in av['cells'][4], av)
        check('recorded by hand 2 days before the bank date: already in Halaxy', 'UPC-0951 £ 33.00' in sh['cells'][4] and 'Already in Halaxy' in sh['cells'][5] and 'Direct Deposit, 27-Oct-2026' in sh['cells'][4], sh)
        others = [r['cells'][1] for r in rows if 'Already in Halaxy' in r['cells'][5]]
        check('nothing else counts as recorded', sorted(others) == ['Aviva', 'Simplyhealth'] and by['WPA']['radios'] + (1 if by['WPA']['rec'] else 0) >= 1, others)
        btn = await pg.evaluate("(document.querySelector('[data-upc-bank-statement] [data-a=all]') || {}).textContent")
        check('the record button leaves them out', btn == 'Record 3 payments', btn)
        await ctx.close()
        S['hand'] = []

        # A payment whose note names another bank line is never this one's (Aviva: notes say 25-Sep); a payment by hand
        # dated before the statement starts may be last month's (Bupa: 30-Sep)
        inv = fresh()
        for i in (931, 932, 901, 902):
            inv[i][3] = 0
        S.update({'log': [], 'posts': [], 'posts_all': [], 'inv': inv, 'short': {}, 'user': 'Carl Healy', 'tasks': {}, 'reports': [],
                  'hand': [(931, '25-Oct-2026', 2000, 'Direct Deposit', 'Aviva, bank 25-Sep-2026, ref AV0001'), (932, '25-Oct-2026', 4000, 'Direct Deposit', 'Aviva, bank 25-Sep-2026, ref AV0001'),
                           (901, '30-Sep-2026', 4000, 'Direct Deposit'), (902, '30-Sep-2026', 8000, 'Direct Deposit')]})
        ctx = await context(browser)
        pg = await ctx.new_page()
        await pg.goto(URL)
        rows = await open_statement(pg, pdf)
        by = {}
        for r in rows:
            by.setdefault(r['cells'][1], r)
        check('a payment whose note names another bank line is not this one', 'Already in Halaxy' not in by['Aviva']['cells'][5], by['Aviva'])
        bu = by['Bupa']
        check('recorded by hand before the statement starts: not marked, says to check, nothing ticked', 'Already in Halaxy' not in bu['cells'][5] and 'last month' in bu['cells'][4] and not bu['rec'], bu)
        await ctx.close()

        # Two Simplyhealth payments of £ 33.00 two days apart, one recorded by hand: neither is marked, both say check
        pdf2 = FIX / 'statement2.pdf'
        make_statement(pdf2, TX + [('31/10/2026', 'DIRECT CREDIT', 'Simplyhealth (SH13)', 3300, None)])
        inv = fresh()
        inv[951][3] = 0
        S.update({'log': [], 'posts': [], 'posts_all': [], 'inv': inv, 'short': {}, 'user': 'Carl Healy', 'tasks': {}, 'reports': [],
                  'hand': [(951, '29-Oct-2026', 3300, 'Direct Deposit')]})
        ctx = await context(browser)
        pg = await ctx.new_page()
        await pg.goto(URL)
        rows = await open_statement(pg, pdf2)
        sh = [r for r in rows if r['cells'][1] == 'Simplyhealth']
        check('same insurer, same amount, one recorded by hand: neither marked, both say check which',
              len(sh) == 2 and all('Already in Halaxy' not in r['cells'][5] and 'check which is recorded' in r['cells'][4] and not r['rec'] for r in sh), sh)
        await ctx.close()
        S['hand'] = []
        pdf2.unlink()

        # not Carl: nothing
        S.update({'log': [], 'posts': [], 'posts_all': [], 'inv': fresh(), 'short': {}, 'user': 'Someone Else'})
        ctx = await context(browser)
        pg = await ctx.new_page()
        await pg.goto(URL)
        await pg.wait_for_timeout(3000)
        check('others see nothing', await pg.evaluate("!document.querySelector('[data-upc-bank-statement]') && !document.querySelector('a.upc-bank-menu')"))
        await ctx.close()
        await browser.close()
    print('\n%d failed' % len(FAILS) if FAILS else '\nAll passed')
    sys.exit(1 if FAILS else 0)

asyncio.run(main())
