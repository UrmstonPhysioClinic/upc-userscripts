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
CORE = (ROOT / 'beta' / 'core.user.js').read_text()
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


def make_statement(path):
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
    for k, (d, t, desc, i, o) in enumerate(TX):
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
        941: ['Vitality', 'Vitality', '01-Oct-2026', 2500, [('Vitality remittance 2026-10-24', 'Remittance total £ 55.00 over 2 invoices')]],
        942: ['Vitality', 'Vitality', '02-Oct-2026', 3000, [('Vitality remittance 2026-10-24', 'Remittance total £ 55.00 over 2 invoices')]],
        944: ['Vitality', 'Vitality', '01-Jun-2026', 2000, [('Vitality remittance 2026-07-01', 'Remittance total £ 55.00 over 2 invoices')]],
        945: ['Vitality', 'Vitality', '02-Jun-2026', 3500, [('Vitality remittance 2026-07-01', 'Remittance total £ 55.00 over 2 invoices')]],
        # Simplyhealth: the only remittance that adds up is months away from the payment: offered, not ticked
        951: ['Simplyhealth', 'Simplyhealth', '01-May-2026', 3300, [('Simplyhealth remittance 2026-06-01', 'Remittance total £ 33.00 over 1 invoice')]],
    }


def report_html():
    head = "<thead><tr>%s</tr></thead>" % ''.join('<th>%s</th>' % c for c in COLS)
    body = ''
    for iid, (payer, funder, day, bal, _) in S['inv'].items():
        if bal <= 0:
            continue
        v = {'Invoice / Deposit': "<a href='/a/pr/555/invoice/%d'>UPC-0%d</a>" % (iid, iid), 'Date': day, 'Payer ID': str(iid), 'Payer': payer,
             'Funder': funder, 'Fee': 'Follow-Up', 'Appointment Status': 'Attended', 'Invoice Status': 'Issued', 'Amount': gbp(bal), 'Balance': gbp(bal)}
        body += '<tr>' + ''.join('<td>%s</td>' % (v.get(c, '') if c else '') for c in COLS) + '</tr>'
    return "<html><body><table class='table-report'>%s<tbody>%s</tbody></table></body></html>" % (head, body)


def invoice_html(iid):
    payer, funder, day, bal, att = S['inv'][iid]
    shown = bal - S['short'].get(iid, 0)
    rows = "<tr><td data-property='date'>%s</td><td data-property='itemNumber'>PHY</td><td data-property='amount'>%s</td><td><a href='/a/pr/555/invoice/line/%d/edit'>Edit</a></td></tr>" % (day, gbp(bal), iid * 10)
    atts = ''.join('<tr>\n<td>%s</td>\n<td>Payment</td>\n<td>%s</td>\n<td>%s</td>\n</tr>' % (day, t, c) for t, c in att)
    return ("<html><head><title>Invoice UPC-0%d | Halaxy</title></head><body><table id='invoiceLines'><tbody>%s<tr><td>Total</td><td>%s</td></tr></tbody></table>"
            "<table id='invoicePayments'><tbody><tr><td>Outstanding</td><td>%s</td></tr></tbody></table>"
            "<table id='invoiceAttachments'><tbody>%s</tbody></table></body></html>") % (iid, rows, gbp(bal), gbp(shown), atts)


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
        return await route.fulfill(body=report_html(), content_type='text/html')
    m = __import__('re').match(r'^/a/pr/555/invoicefunctions/(\d+)/pay/offline$', p)
    if m:
        iid = int(m.group(1))
        bal = S['inv'][iid][3]
        if req.method == 'GET':
            return await route.fulfill(body=json.dumps({'status': 'FORM', 'message': PAY_FORM % ('%.2f' % (bal / 100), '%.2f' % (bal / 100))}), content_type='application/json')
        f = dict(urllib.parse.parse_qsl(req.post_data or '', keep_blank_values=True))
        S['posts'].append((iid, f))
        S['inv'][iid][3] = bal - round(float(f['form[amount]']) * 100)
        return await route.fulfill(body=json.dumps({'status': 'REFRESH'}), content_type='application/json')
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
        S.update({'log': [], 'posts': [], 'inv': fresh(), 'short': {}, 'user': 'Carl Healy'})
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
        check('one invoice for the whole amount; one dated after the credit left out', 'UPC-0911' in by['AXA']['cells'][4] and 'UPC-0912' not in by['AXA']['cells'][4] and 'one invoice' in by['AXA']['cells'][4], by['AXA']['cells'])
        check('transfer from the old account naming WPA: the only set that adds up', 'UPC-0921' in by['WPA']['cells'][4] and 'UPC-0922' in by['WPA']['cells'][4] and 'UPC-0923' not in by['WPA']['cells'][4], by['WPA']['cells'])
        check('several answers: offered to choose, nothing ticked', by['Aviva']['radios'] == 2 and not by['Aviva']['rec'] and 'choose' in by['Aviva']['cells'][4], by['Aviva'])
        v = by['Vitality']['cells'][4]
        check('no reference: the remittance dated near the payment wins', 'UPC-0941' in v and 'UPC-0942' in v and 'UPC-0944' not in v and 'dated 24-Oct-2026, 4 days before the payment' in v and by['Vitality']['rec'], v)
        sh = by['Simplyhealth']
        check('remittance months from the payment: offered, not ticked', sh['radios'] == 1 and not sh['rec'] and 'check the date' in sh['cells'][4] and 'UPC-0951' in sh['cells'][4], sh)
        check('no answer: says so, greyed', by['Cigna']['off'] and 'Not matched' in by['Cigna']['cells'][4], by['Cigna'])
        ht = by['Health Trust']['cells']
        check('invoice number in the bank reference: matched, insurer taken from the invoice', 'UPC-0961' in ht[4] and 'invoice number in the bank reference' in ht[4] and by['Health Trust']['rec'], ht)
        reused = next((r['cells'] for r in rows if r['cells'][3] == '£ 35.00'), [])
        check('reused old reference: matched by amount and date instead, and says so', reused[1:2] == ['Bupa'] and 'UPC-0907' in reused[4] and 'UPC-0800, which doesn' in reused[4], reused)
        check('a patient paying by transfer (names a patient invoice) is left out', not any('£ 120.00' == r['cells'][3] and r['cells'][1] != 'Bupa' for r in rows) and len(rows) == 9, [r['cells'][:4] for r in rows])
        check('the patient\'s own invoice is never offered', not any('UPC-0905' in r['cells'][4] for r in rows), rows)
        btn = await pg.evaluate("document.querySelector('[data-upc-bank-statement] [data-a=all]').textContent")
        check('record button counts the matched ones', btn == 'Record 6 payments', btn)
        reads = [x for x in S['log'] if x[1].endswith('/report/finance/0')]
        check('one report request; nothing written while matching', len(reads) == 1 and not S['posts'] and not [x for x in S['log'] if x[0] == 'POST'], S['log'])

        # choose for Aviva, then cancel: nothing recorded
        await pg.click('[data-upc-bank-statement] input[data-pick="5:0"]')
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
        await pg.wait_for_function("[...document.querySelectorAll('[data-upc-bank-statement] tbody tr')].filter((tr) => /Recorded/.test(tr.textContent)).length === 7", timeout=60000)
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
        S.update({'log': [], 'posts': [], 'inv': fresh(), 'short': {911: 1000}, 'user': 'Carl Healy'})
        ctx = await context(browser)
        pg = await ctx.new_page()
        await pg.goto(URL)
        await open_statement(pg, pdf)
        await pg.click('[data-upc-bank-statement] tbody tr:nth-child(2) [data-rec]')
        await pg.wait_for_selector('[data-upc-bank-confirm]', timeout=10000)
        await pg.click('[data-upc-bank-confirm] [data-c=yes]')
        await pg.wait_for_function("document.querySelector('[data-upc-bank-statement] tbody tr:nth-child(2) .upc-err')", timeout=30000)
        err = await pg.evaluate("document.querySelector('[data-upc-bank-statement] tbody tr:nth-child(2) .upc-err').textContent")
        check('less outstanding than expected: nothing recorded, says so', not S['posts'] and 'only £ 65.00 outstanding' in err, (err, S['posts']))
        await ctx.close()

        # not Carl: nothing
        S.update({'log': [], 'posts': [], 'inv': fresh(), 'short': {}, 'user': 'Someone Else'})
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
