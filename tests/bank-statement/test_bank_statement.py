"""
Test for Bank statement and core's UPC.deposits / UPC.orgFiles, against a mock Halaxy and an invented statement in the
Starling layout (columns DATE | TYPE | TRANSACTION | IN | OUT | ACCOUNT BALANCE, second page without a header).

Checks: the statement is read and checked against the running balance; only insurer credits are used (a transfer
from the old account naming an insurer counts as that insurer); matching by shared remittance first, then one invoice,
then the only set that adds up; invoices dated after the credit and patients' own invoices are left out; several
remittances are offered to choose from; nothing is written until confirmed; each payment becomes a Direct Deposit on
the insurer's profile (bank date, amount, note), applied to its invoices only when a remittance names them and they
agree; the remittance's copies say so; the statement register is written on the Starling Bank profile and recognises
the statement next time; a deposit already there is never added twice; payments recorded the old way are never
counted again; tasks for what needs Carl; Carl only.

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
BANK_REAL = (ROOT / 'beta' / 'bank-statement.user.js').read_text()
# The invented statement is October 2026; most tests treat it as after the switch to deposits
BANK = BANK_REAL.replace("const CHANGEOVER = '2026-11-01';", "const CHANGEOVER = '2026-09-01';")
assert BANK != BANK_REAL
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
# Each insurer's profile (organisation id); 78812 is the Starling Bank profile that keeps the statement register
ORGS = {'Bupa': 501, 'AXA Health': 502, 'WPA': 503, 'Aviva': 504, 'Health Trust': 505, 'Vitality': 506, 'Simplyhealth': 507, 'Cigna': 508}
TODAY = '11-Nov-2026'



def income_html(q):
    # Halaxy's Income report (capture 12 Nov 2026): payments by payment date, one row per fee, the payment on its
    # invoice's first row (a second payment on a later row that repeats the number unlinked).
    import datetime as dt
    day = lambda t: dt.datetime.strptime(t, '%d-%b-%Y')
    pays = [(i, f['form[paymentDate]'], round(float(f['form[amount]']) * 100), 'Direct Deposit') for i, f in S['posts_all']] + [h[:4] for h in S.get('hand', [])] + [a[:4] for a in S.get('applied', [])]
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
    atts = ''.join("<tr>\n<td>%s</td>\n<td>Payment</td>\n<td>%s</td>\n<td>%s</td>\n<td><a href='/a/file/get/f%d.pdf'>Download</a> <a href='/a/pr/555/invoice/attachment/%d'>Edit</a></td>\n</tr>" % (day, t, c, iid * 100 + k, iid * 100 + k) for k, (t, c) in enumerate(att))
    org = ORGS.get(funder) if payer == funder else None
    bill = "<div id='card-invoice-view-organisation'><a href='/a/pr/555/organisation/%d'>%s</a></div>" % (org, funder) if org else ''
    pays_dep = ''.join("<tr><td>%s</td><td>Direct Deposit deposit paid on %s</td><td>Paid</td><td>%s</td></tr>" % (a[1], a[4], gbp(a[2])) for a in S.get('applied', []) if a[0] == iid)
    pays = ''.join("<tr><td>%s</td><td>Direct Deposit (%s)</td><td>Paid</td><td>%s</td></tr>" % (f['form[paymentDate]'], f['form[note]'], gbp(round(float(f['form[amount]']) * 100))) for i, f in S['posts_all'] if i == iid)
    pays += ''.join("<tr><td>%s</td><td>%s%s</td><td>Paid</td><td>%s</td></tr>" % (h[1], h[3], ' (%s)' % h[4] if len(h) > 4 else '', gbp(h[2])) for h in S.get('hand', []) if h[0] == iid)
    # As live (12 Nov 2026): paid in full, the page is a "Receipt" with no Outstanding row.
    kind = 'Receipt' if shown <= 0 else 'Invoice'
    outst = '' if shown <= 0 else "<tr><td></td><td></td><td>Outstanding</td><td>%s</td></tr>" % gbp(shown)
    return ("<html><head><title>%s UPC-0%d | Halaxy</title></head><body>%s<table id='invoiceLines'><tbody>%s<tr><td>Total</td><td>%s</td></tr></tbody></table>"
            "<table id='invoicePayments'><tbody>%s%s</tbody></table>"
            "<table id='invoiceAttachments'><tbody>%s</tbody></table></body></html>") % (kind, iid, bill, rows, gbp(bal), pays + pays_dep, outst, atts)


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


TASK_FORM = ("<form id='form_task_edit' name='form' method='post'><input name='form[title]' value=''>"
             "<input type='radio' name='form[actionerType]' value='1' checked><select name='form[linkPrGs][]' multiple><option value='31'>Carl Healy</option></select>"
             "<input type='radio' name='form[priority]' value='1'><input type='radio' name='form[priority]' value='2' checked><input type='radio' name='form[priority]' value='3'>"
             "<input name='form[displayDueDate]' value=''><textarea name='form[comment]'></textarea><input type='hidden' name='form[_token]' value='tok-task'></form>")


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
        if q.get('type') == '5' and S.get('reportMiss', 0) > 0:   # Halaxy sends a page without the report (a hiccup)
            S['reportMiss'] -= 1
            S['missed'] = S.get('missed', 0) + 1
            return await route.fulfill(body="<html><head><title>Reports | Halaxy</title></head><body><p>Please try again</p></body></html>", content_type='text/html')
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
    re_ = __import__('re')
    form = lambda: dict(urllib.parse.parse_qsl(req.post_data or '', keep_blank_values=True))
    pairs = lambda: urllib.parse.parse_qsl(req.post_data or '', keep_blank_values=True)
    js = lambda o: route.fulfill(body=json.dumps(o), content_type='application/json')
    deps = S.setdefault('deps', {})
    m = re_.match(r'^/a/pr/555/organisation/(\d+)/balance/data$', p)
    if m:
        return await js({'data': [{'id': d['id'], 'type': 'Direct Deposit', 'date': d['iso'], 'amount': d['amount'] / 100, 'balance': d['balance'] / 100} for d in deps.get(int(m.group(1)), [])]})
    m = re_.match(r'^/a/pr/555/invoicefunctions/0/pay/offline/0/(\d+)$', p)
    if m:
        org = int(m.group(1))
        if req.method == 'GET':
            return await js({'status': 'FORM', 'message': PAY_FORM % ('0.00', '0.00')})
        f = form()
        if org in S.get('failDeposit', set()):
            return await js({'status': 'FORM', 'errors': ['Payment could not be saved']})
        import datetime as dt
        iso = dt.datetime.strptime(f['form[paymentDate]'], '%d-%b-%Y').strftime('%Y-%m-%dT00:00:00')
        a = round(float(f['form[amount]']) * 100)
        d = {'id': 7000 + len(S['added']), 'iso': iso, 'date': f['form[paymentDate]'], 'amount': a, 'balance': a, 'note': f['form[note]'], 'method': f['form[paymentMethod]']}
        deps.setdefault(org, []).append(d)
        S['added'].append((org, f))
        return await js({'status': 'REFRESH'})
    m = re_.match(r'^/a/pr/555/invoicefunctions/payment/(\d+)/edit$', p)
    if m:
        d = next(d for ds in deps.values() for d in ds if d['id'] == int(m.group(1)))
        return await js({'status': 'FORM', 'message': "<form id='paymentForm'><input name='form[paymentDate]' value='%s'><input name='form[note]' value='%s'><input name='form[_token]' value='t'></form>" % (d['date'], d['note'])})
    m = re_.match(r'^/a/pr/555/invoicefunctions/payment/(\d+)/allocate$', p)
    if m:
        did = int(m.group(1))
        if req.method == 'GET':
            return await js({'status': 'FORM', 'message': "<form id='allocatePaymentForm'><input type='hidden' name='form[_token]' value='tok-alloc'></form>"})
        ids = [int(v) for k, v in pairs() if k == 'form[invoices][]']
        d = next(d for ds in deps.values() for d in ds if d['id'] == did)
        S['allocs'].append((did, ids))
        for i in ids:
            take = min(S['inv'][i][3], d['balance'])
            S['inv'][i][3] -= take; d['balance'] -= take
            S.setdefault('applied', []).append((i, TODAY, take, 'Direct Deposit', d['date']))
        return await js({'status': 'REFRESH'})
    files = S.setdefault('orgfiles', {})
    m = re_.match(r'^/a/pr/555/organisation/(\d+)/?$', p)
    if m:
        cards = ''.join("<div class='card attachment-file-card' data-href='/a/file/get/o%d.pdf'><div class='card-body'>%s</div></div>"
                        "<div class='dropdown-menu'><a class='dropdown-item' href='/a/file/get/o%d.pdf'>Download</a><a class='dropdown-item ajax btnEditFile file-edit-link' data-modal-href='/a/pr/555/file/edit/%d'>Edit</a></div>"
                        % (f['id'], f['title'], f['id'], f['id']) for f in reversed(files.get(int(m.group(1)), [])))
        return await route.fulfill(body="<html><body><div class='card'><div class='card-header'><h2>Attachments</h2></div><div class='card-body'>%s</div></div></body></html>" % cards, content_type='text/html')
    m = re_.match(r'^/a/pr/555/file/edit/(\d+)$', p)
    if m:
        f = next(f for fs in files.values() for f in fs if f['id'] == int(m.group(1)))
        if req.method == 'GET':
            return await js({'status': 'FORM', 'message': "<form id='fileupload'><input name='form[title]' value=\"%s\"><textarea name='form[comments]'>%s</textarea><input type='hidden' name='form[_token]' value='tf'></form>" % (f['title'], f['comments'])})
        g = form(); f['title'] = g['form[title]']; f['comments'] = g['form[comments]']
        S['fileEdits'].append(f['id'])
        return await js({'status': 'REFRESH'})
    m = re_.match(r'^/a/pr/555/file/upload/organisation/(\d+)$', p)
    if m:
        org = int(m.group(1))
        if req.method == 'GET':
            return await js({'status': 'FORM', 'message': "<form id='fileupload' data-upload-url='/api/v2/practitioner/file/upload/files?_locale=555'><input type='hidden' name='form[_token]' value='tu'></form>"})
        g = form()
        files.setdefault(org, []).append({'id': 8000 + sum(len(v) for v in files.values()), 'title': g['form[files][1][title]'], 'comments': g['form[files][1][comments]'], 'entity': g['form[files][1][fileEntity]']})
        return await js({'status': 'REFRESH'})
    if p == '/api/v2/practitioner/file/upload/files':
        S['uploads'].append(req.post_data_buffer or b'')
        return await js({'files': [{'id': 9000 + len(S['uploads'])}]})
    m = re_.match(r'^/a/pr/555/invoice/attachment/(\d+)$', p)
    if m:
        iid, k = divmod(int(m.group(1)), 100)
        t, c = S['inv'][iid][4][k]
        if req.method == 'GET':
            return await js({'status': 'FORM', 'message': "<form id='frmInvoiceFile'><input name='form[title]' value='%s'><textarea name='form[comments]'>%s</textarea><input name='form[invoiceFileType]' value='2'><input type='hidden' name='form[_token]' value='ta'></form>" % (t, c)})
        g = form(); S['inv'][iid][4][k] = (g['form[title]'], g['form[comments]'])
        return await js({'status': 'REFRESH'})
    m = re_.match(r'^/a/pr/555/task/organisation/(\d+)/list-data$', p)
    if m:
        return await js([{'id': k, 'title': t.get('form[title]'), 'status': 'Open'} for k, t in enumerate(S.setdefault('orgtasks', {}).get(int(m.group(1)), []))])
    m = re_.match(r'^/a/pr/555/task/new(?:/organisation/(\d+))?$', p)
    if m:
        if req.method == 'GET':
            return await js({'status': 'FORM', 'message': TASK_FORM})
        S.setdefault('orgtasks', {}).setdefault(int(m.group(1) or 0), []).append(form())
        return await js({'status': 'POPUP', 'url': '/a/pr/555/task/list'})
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


async def context(browser, bank=None):
    ctx = await browser.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/London')
    await ctx.clock.install(time='2026-11-11T12:00:00Z')
    await ctx.route('https://eu.halaxy.com/**', halaxy)
    await ctx.route('https://cdn.jsdelivr.net/**', cdn)
    await ctx.add_init_script(CORE)
    await ctx.add_init_script("document.addEventListener('DOMContentLoaded', function () {\n" + (bank or BANK) + "\n});")
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


def reset(**kw):
    S.clear()
    S.update({'log': [], 'posts': [], 'posts_all': [], 'inv': fresh(), 'short': {}, 'user': 'Carl Healy', 'tasks': {}, 'reports': [],
              'added': [], 'allocs': [], 'fileEdits': [], 'uploads': [], 'deps': {}, 'orgfiles': {}, 'orgtasks': {}, 'applied': [], 'hand': []})
    S.update(kw)


async def record_all(pg):
    await pg.click('[data-upc-bank-statement] [data-a=all]')
    await pg.wait_for_selector('[data-upc-bank-confirm]', timeout=10000)
    await pg.click('[data-upc-bank-confirm] [data-c=yes]')
    await pg.wait_for_function("/^Finished:/.test((document.querySelector('[data-upc-bank-statement] .upc-run-now') || {}).textContent || '') && !!document.querySelector('[data-upc-bank-statement] table')", timeout=240000)


async def main():
    FIX.mkdir(exist_ok=True)
    pdf = FIX / 'statement.pdf'
    make_statement(pdf)
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        reset()
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
        check('one invoice for the whole amount, no remittance: a deposit only, the invoice shown as what it may be for; one dated after the credit left out',
              'May be for: UPC-0911' in by['AXA']['cells'][4] and 'UPC-0912' not in by['AXA']['cells'][4] and 'one invoice' in by['AXA']['cells'][4] and by['AXA']['cells'][5] == 'Add deposit' and by['AXA']['radios'] == 0, by['AXA'])
        check('an old unpaid invoice for the same amount (over 120 days before) is never offered', 'UPC-0981' not in by['Aviva']['cells'][4], by['Aviva']['cells'])
        check('transfer from the old account naming WPA: the only set that adds up', 'UPC-0921' in by['WPA']['cells'][4] and 'UPC-0922' in by['WPA']['cells'][4] and 'UPC-0923' not in by['WPA']['cells'][4], by['WPA']['cells'])
        check('several sets, no remittance: both shown, a deposit only', by['Aviva']['radios'] == 0 and by['Aviva']['cells'][5] == 'Add deposit' and 'more than one set' in by['Aviva']['cells'][4] and ' or ' in by['Aviva']['cells'][4], by['Aviva'])
        v = by['Vitality']['cells'][4]
        check('no reference: the remittance dated near the payment wins', 'UPC-0941' in v and 'UPC-0942' in v and 'UPC-0944' not in v and 'dated 24-Oct-2026, 4 days before the payment' in v and by['Vitality']['rec'], v)
        sh = by['Simplyhealth']
        check('remittance months from the payment: offered, not ticked', sh['radios'] == 1 and not sh['rec'] and 'check the date' in sh['cells'][4] and 'UPC-0951' in sh['cells'][4], sh)
        check('remittance paid it but the excess was never moved: a deposit, and says Remittances applies it once the excess is moved', 'UPC-0971' in by['Cigna']['cells'][4] and 'UPC-0972' in by['Cigna']['cells'][4]
              and 'but Halaxy still shows £ 60.00' in by['Cigna']['cells'][4] and 'move the excess' in by['Cigna']['cells'][4] and by['Cigna']['cells'][5] == 'Add deposit', by['Cigna']['cells'])
        ht = by['Health Trust']['cells']
        check('invoice number in the bank reference, no remittance: insurer taken from the invoice, a deposit only', 'UPC-0961' in ht[4] and 'invoice number in the bank reference' in ht[4] and ht[5] == 'Add deposit', ht)
        reused = next((r['cells'] for r in rows if r['cells'][3] == '£ 35.00'), [])
        check('reused old reference: matched by amount and date instead, and says so', reused[1:2] == ['Bupa'] and 'UPC-0907' in reused[4] and 'UPC-0800, which doesn' in reused[4], reused)
        check('a patient paying by transfer (names a patient invoice) is left out', not any('£ 120.00' == r['cells'][3] and r['cells'][1] != 'Bupa' for r in rows) and len(rows) == 9, [r['cells'][:4] for r in rows])
        check('the patient\'s own invoice is never offered', not any('UPC-0905' in r['cells'][4] for r in rows), rows)
        btn = await pg.evaluate("document.querySelector('[data-upc-bank-statement] [data-a=all]').textContent")
        check('record button: every payment ready (remittance matches to add and apply, the rest as deposits)', btn == 'Record 8 payments', btn)
        reads = [x for x in S['log'] if x[1].endswith('/report/finance/0')]
        check('two report requests (unpaid invoices, payments recorded); nothing written while matching', len(reads) == 2 and sorted(S['reports']) == ['1', '5'] and not [x for x in S['log'] if x[0] == 'POST'], [x for x in S['log'] if x[0] == 'POST'])

        # choose Simplyhealth's remittance, then cancel: nothing written
        await pg.click('[data-upc-bank-statement] input[data-pick="8:0"]')
        btn = await pg.evaluate("document.querySelector('[data-upc-bank-statement] [data-a=all]').textContent")
        check('a chosen remittance joins the button', btn == 'Record 9 payments', btn)
        await pg.click('[data-upc-bank-statement] [data-a=all]')
        await pg.wait_for_selector('[data-upc-bank-confirm]', timeout=10000)
        conf = await pg.evaluate("document.querySelector('[data-upc-bank-confirm]').textContent")
        check('confirm says what happens to each', 'Direct Deposit' in conf and 'add the deposit and apply it to UPC-0902 £ 80.00, UPC-0901 £ 40.00' in conf and 'AXA £ 75.00, 12-Oct-2026: add the deposit (applied when its remittance comes)' in conf, conf)
        await pg.click('[data-upc-bank-confirm] [data-c=no]')
        await pg.wait_for_timeout(500)
        check('cancel: nothing written', not [x for x in S['log'] if x[0] == 'POST'], S['log'])

        # confirm: nine deposits, three applied
        try:
            await record_all(pg)
        except Exception:
            print("rows when recording stalled:", S['added'], await pg.evaluate("[...document.querySelectorAll('[data-upc-bank-statement] tbody tr')].map((tr) => tr.innerText.replace(/\\s+/g, ' ').slice(0, 300))"))
            raise
        rows = await pg.evaluate(ROWS)
        acts = {(r['cells'][1], r['cells'][3]): r['cells'][5] for r in rows}
        check('applied where a remittance names the invoices, added elsewhere', acts.get(('Bupa', '£ 120.00')) == 'Deposit applied' and acts.get(('Vitality', '£ 55.00')) == 'Deposit applied' and acts.get(('Simplyhealth', '£ 33.00')) == 'Deposit applied'
              and all(acts.get(k) == 'Deposit added' for k in [('AXA', '£ 75.00'), ('Health Trust', '£ 45.00'), ('Bupa', '£ 35.00'), ('WPA', '£ 90.00'), ('Aviva', '£ 60.00'), ('Cigna', '£ 44.00')]), acts)
        added = {(org, f['form[amount]']): f for org, f in S['added']}
        f = added.get((501, '120.00'), {})
        check('nine deposits, each on its insurer\'s profile', len(S['added']) == 9 and sorted(set(o for o, _ in S['added'])) == [501, 502, 503, 504, 505, 506, 507, 508], S['added'])
        check('Direct Deposit, bank date, amount, note naming the bank line and statement', f.get('form[paymentMethod]') == '9' and f.get('form[paymentDate]') == '05-Oct-2026'
              and f.get('form[note]') == 'Bupa, bank 05-Oct-2026, ref 2455419, Starling statement 01-Oct-2026 to 30-Oct-2026' and f.get('form[_token]') == 'tok123', f)
        check('applied to exactly the remittance invoices', sorted(sorted(ids) for _, ids in S['allocs']) == [[901, 902], [941, 942], [951]], S['allocs'])
        check('balances: applied ones nil, the rest untouched', all(S['inv'][i][3] == 0 for i in (901, 902, 941, 942, 951)) and S['inv'][911][3] == 7500 and S['inv'][921][3] == 5000, {i: S['inv'][i][3] for i in (901, 911, 921, 951)})
        check('nothing paid straight onto an invoice', not S['posts'], S['posts'])
        check('the remittance on each invoice says which deposit paid it', all('deposit £ 120.00 from the bank 05-Oct-2026, applied 11-Nov-2026' in S['inv'][i][4][0][1] for i in (901, 902))
              and 'deposit £ 33.00 from the bank 29-Oct-2026' in S['inv'][951][4][0][1] and S['inv'][901][4][0][1].startswith('Insurer reference 2455419'), [S['inv'][i][4] for i in (901, 951)])
        reg = S['orgfiles'].get(78812, [])
        rc = reg[0]['comments'] if reg else ''
        check('statement register on the Starling Bank profile: one file, period in its title, fingerprint, balances and each insurer payment',
              len(reg) == 1 and reg[0]['title'] == 'Starling statement 2026-10-01 to 2026-10-30' and 'Fingerprint ' in rc and '14 transactions' in rc and 'opening £ 1000.00, closing ' in rc
              and 'first read 11-Nov-2026 by Carl Healy' in rc and '05-Oct-2026 Bupa £ 120.00 ref 2455419: deposit applied to UPC-0902, UPC-0901' in rc and '12-Oct-2026 AXA £ 75.00 ref GB33AXA0001: deposit added, waiting for the remittance' in rc
              and 'Energy' not in rc and 'Landlord' not in rc, reg)
        pdfs = [b for b in S['uploads'] if b'%PDF-1.4' in b]
        check('the register file is a PDF holding only the insurer payments', len(pdfs) == 1 and b'Starling Bank statement register' in pdfs[0] and b'Bupa \xa3 120.00' in pdfs[0] and b'Landlord' not in pdfs[0] and b'Software Co' not in pdfs[0], pdfs[:1])
        check('no page errors', not errors, errors)

        # the same statement again: the deposits are found, nothing added twice, the register recognises it
        S['log'] = []; S['added'] = []; S['allocs'] = []
        await pg.goto(URL)
        await pg.reload()
        rows = await open_statement(pg, pdf)
        acts = [r['cells'][5] for r in rows]
        check('opened again: every payment shown as added or applied, nothing to record', acts.count('Deposit applied') == 3 and acts.count('Deposit added') == 6
              and not await pg.evaluate("!!document.querySelector('[data-upc-bank-statement] [data-a=all]')"), acts)
        seen = await pg.evaluate("document.querySelector('[data-upc-bank-statement]').textContent")
        check('the register says it was read before', 'This statement was read before (11-Nov-2026 by Carl Healy)' in seen, seen[:400])
        check('nothing written on opening again', not S['added'] and not S['allocs'] and not [x for x in S['log'] if x[0] == 'POST'], [x for x in S['log'] if x[0] == 'POST'])
        # 10 days on, deposits still waiting get a task on their profile (once a day)
        lin = await pg.evaluate("(async () => { localStorage.removeItem('upc-funder-orgs:lingerDay'); const a = await UPC.deposits.lingering({ days: 10, assignee: 'Carl Healy', by: 'Bank statement' }); const b = await UPC.deposits.lingering({ days: 10, assignee: 'Carl Healy', by: 'Bank statement' }); return [a, b]; })()")
        check('deposits waiting over 10 days: a task each on the profile, applied ones left, once a day', len(lin[0]) == 6 and 'AXA deposit 12-Oct-2026 £ 75.00: not applied after 10 days' in lin[0] and not lin[1]
              and any('not applied after 10 days' in t.get('form[title]', '') for t in S['orgtasks'].get(502, [])) and not S['orgtasks'].get(506), (lin, S['orgtasks']))
        await ctx.close()

        # an invoice shows less outstanding than the report (paid meanwhile): the deposit is added, not applied, and a task
        reset(short={901: 1000})
        ctx = await context(browser)
        pg = await ctx.new_page()
        await pg.goto(URL)
        await open_statement(pg, pdf)
        await pg.click('[data-upc-bank-statement] tbody tr:nth-child(1) [data-rec]')
        await pg.wait_for_selector('[data-upc-bank-confirm]', timeout=10000)
        await pg.click('[data-upc-bank-confirm] [data-c=yes]')
        await pg.wait_for_function("document.querySelector('[data-upc-bank-statement] tbody tr:nth-child(1) .upc-err')", timeout=60000)
        err = await pg.evaluate("document.querySelector('[data-upc-bank-statement] tbody tr:nth-child(1) .upc-err').textContent")
        tk = S['orgtasks'].get(501, [])
        check('less outstanding than expected: deposit added, not applied, says why', len(S['added']) == 1 and not S['allocs'] and 'Deposit added, not applied: UPC-0901 now shows £ 30.00 outstanding, not £ 40.00' in err, (err, S['added'], S['allocs']))
        check('and a task on the Bupa profile', len(tk) == 1 and tk[0].get('form[title]') == 'Bupa deposit 05-Oct-2026 £ 120.00: not applied, please check' and tk[0].get('form[priority]') == '3' and tk[0].get('form[linkPrGs][]') == '31', tk)
        await ctx.close()

        # Halaxy refuses the deposit: nothing added, says so, a task
        reset(failDeposit={501})
        ctx = await context(browser)
        pg = await ctx.new_page()
        await pg.goto(URL)
        await open_statement(pg, pdf)
        await pg.click('[data-upc-bank-statement] tbody tr:nth-child(1) [data-rec]')
        await pg.wait_for_selector('[data-upc-bank-confirm]', timeout=10000)
        await pg.click('[data-upc-bank-confirm] [data-c=yes]')
        await pg.wait_for_function("document.querySelector('[data-upc-bank-statement] tbody tr:nth-child(1) .upc-err')", timeout=60000)
        err = await pg.evaluate("document.querySelector('[data-upc-bank-statement] tbody tr:nth-child(1) .upc-err').textContent")
        tk = S['orgtasks'].get(501, [])
        check('deposit refused: nothing added or applied, a task for Carl', not S['added'] and not S['allocs'] and 'Not recorded: Halaxy did not accept the deposit: Payment could not be saved' in err and 'Task added for Carl Healy' in err
              and len(tk) == 1 and tk[0].get('form[title]', '').startswith('Bank statement could not record Bupa £ 120.00'), (err, tk))
        await ctx.close()

        # The deposit is already on the profile (an earlier read stopped before applying), and a deposit of AXA's amount
        # was added by hand: Bupa's is applied, never added again; AXA's says to check, with a task
        reset(deps={501: [{'id': 6001, 'iso': '2026-10-05T00:00:00', 'date': '05-Oct-2026', 'amount': 12000, 'balance': 12000, 'note': 'Bupa, bank 05-Oct-2026, ref 2455419, Starling statement 01-Oct-2026 to 30-Oct-2026'}],
                    502: [{'id': 6002, 'iso': '2026-10-12T00:00:00', 'date': '12-Oct-2026', 'amount': 7500, 'balance': 7500, 'note': ''}]})
        ctx = await context(browser)
        pg = await ctx.new_page()
        await pg.goto(URL)
        rows = await open_statement(pg, pdf)
        bu, ax = rows[0], rows[1]
        check('deposit already there: Apply, not add', bu['cells'][5] == 'Apply' and 'its deposit is on the Bupa profile already' in bu['cells'][4], bu)
        check('a deposit of the same amount with no bank note: check, with Add task', ax['cells'][5] == 'Add task' and 'perhaps added by hand' in ax['cells'][4] and '12-Oct-2026' in ax['cells'][4], ax)
        await record_all(pg)
        check('applied the deposit already there; none added for it', (6001, [902, 901]) in S['allocs'] and not [1 for o, f in S['added'] if o == 501 and f['form[amount]'] == '120.00'], (S['allocs'], S['added']))
        tk = S['orgtasks'].get(502, [])
        check('a task on the AXA profile to check', len(tk) == 1 and tk[0].get('form[title]') == 'Bank statement: AXA £ 75.00 (12-Oct-2026) needs checking' and 'perhaps added by hand' in tk[0].get('form[comment]', ''), tk)
        check('nothing added on AXA', not [1 for o, f in S['added'] if o == 502], S['added'])
        await ctx.close()

        # Recorded in Halaxy by hand (Carl, 12 Nov 2026): Aviva's £ 60.00 on its bank date, Simplyhealth's £ 33.00 on its
        # remittance's date 2 days before; a card payment the same day is not an insurer's. Shown as already recorded.
        inv = fresh()
        inv[931][3] = 0; inv[932][3] = 0; inv[951][3] = 0
        reset(inv=inv, hand=[(931, '25-Oct-2026', 2000, 'Direct Deposit'), (932, '25-Oct-2026', 4000, 'Direct Deposit'), (933, '25-Oct-2026', 6000, 'Card'),
                           (951, '27-Oct-2026', 3300, 'Direct Deposit')])
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
        check('the record button leaves them out (and adds no deposit for them)', btn == 'Record 7 payments', btn)
        await ctx.close()
        S['hand'] = []

        # A payment whose note names another bank line is never this one's (Aviva: notes say 25-Sep); a payment by hand
        # dated before the statement starts may be last month's (Bupa: 30-Sep)
        inv = fresh()
        for i in (931, 932, 901, 902):
            inv[i][3] = 0
        reset(inv=inv, hand=[(931, '25-Oct-2026', 2000, 'Direct Deposit', 'Aviva, bank 25-Sep-2026, ref AV0001'), (932, '25-Oct-2026', 4000, 'Direct Deposit', 'Aviva, bank 25-Sep-2026, ref AV0001'),
                           (901, '30-Sep-2026', 4000, 'Direct Deposit'), (902, '30-Sep-2026', 8000, 'Direct Deposit')])
        ctx = await context(browser)
        pg = await ctx.new_page()
        await pg.goto(URL)
        rows = await open_statement(pg, pdf)
        by = {}
        for r in rows:
            by.setdefault(r['cells'][1], r)
        check('a payment whose note names another bank line is not this one', 'Already in Halaxy' not in by['Aviva']['cells'][5], by['Aviva'])
        bu = by['Bupa']
        check('recorded by hand before the statement starts: not marked, says to check (a task, no deposit)', 'Already in Halaxy' not in bu['cells'][5] and 'last month' in bu['cells'][4] and bu['cells'][5] == 'Add task', bu)
        await ctx.close()

        # Two Simplyhealth payments of £ 33.00 two days apart, one recorded by hand: neither is marked, both say check
        pdf2 = FIX / 'statement2.pdf'
        make_statement(pdf2, TX + [('31/10/2026', 'DIRECT CREDIT', 'Simplyhealth (SH13)', 3300, None)])
        inv = fresh()
        inv[951][3] = 0
        reset(inv=inv, hand=[(951, '29-Oct-2026', 3300, 'Direct Deposit')])
        ctx = await context(browser)
        pg = await ctx.new_page()
        await pg.goto(URL)
        rows = await open_statement(pg, pdf2)
        sh = [r for r in rows if r['cells'][1] == 'Simplyhealth']
        check('same insurer, same amount, one recorded by hand: neither marked, both say check which',
              len(sh) == 2 and all('Already in Halaxy' not in r['cells'][5] and 'check which is recorded' in r['cells'][4] and r['cells'][5] == 'Add task' for r in sh), sh)
        await ctx.close()
        pdf2.unlink()

        # An old statement read again (before the switch to deposits): what is found recorded is shown so; the rest is
        # shown to check, never added by Record all; one can still be recorded on its own
        reset()
        ctx = await context(browser, BANK_REAL)
        pg = await ctx.new_page()
        await pg.goto(URL)
        rows = await open_statement(pg, pdf)
        check('old statement: every unrecorded line says to check, nothing in Record all', all('Before 01-Nov-2026' in r['cells'][4] for r in rows)
              and not await pg.evaluate("!!document.querySelector('[data-upc-bank-statement] [data-a=all]')") and rows[0]['cells'][5] == 'Record' and rows[1]['cells'][5] == 'Add deposit', [r['cells'][4:] for r in rows[:2]])
        reg_btn = lambda: pg.evaluate("(document.querySelector('[data-upc-bank-statement] [data-a=register]') || {}).textContent || ''")
        check('nothing to record, not in the register: Save to register offered', await reg_btn() == 'Save to register' and not S['orgfiles'], await reg_btn())
        await pg.click('[data-upc-bank-statement] [data-a=register]')
        await pg.wait_for_selector('[data-upc-bank-confirm]', timeout=10000)
        await pg.click('[data-upc-bank-confirm] [data-c=yes]')
        await pg.wait_for_function("/Saved to the register/.test((document.querySelector('[data-upc-bank-statement] .upc-run-now') || {}).textContent || '')", timeout=60000)
        reg = S['orgfiles'].get(78812, [])
        check('saved to the register: one file, no money recorded, the button gone', len(reg) == 1 and 'to check' in reg[0]['comments'] and not S['added'] and not S['allocs'] and await reg_btn() == '', (reg, await reg_btn()))
        await pg.click('[data-upc-bank-statement] tbody tr:nth-child(2) [data-rec]')
        await pg.wait_for_selector('[data-upc-bank-confirm]', timeout=10000)
        await pg.click('[data-upc-bank-confirm] [data-c=yes]')
        await pg.wait_for_function("/^Finished:/.test((document.querySelector('[data-upc-bank-statement] .upc-run-now') || {}).textContent || '')", timeout=60000)
        check('old line recorded on its own when asked: one deposit, the same register entry updated', [(o, f['form[amount]']) for o, f in S['added']] == [(502, '75.00')] and len(S['orgfiles'].get(78812, [])) == 1
              and 'AXA £ 75.00 ref GB33AXA0001: deposit added' in S['orgfiles'][78812][0]['comments']
              and 'before the switch to deposits, not found as recorded: to check' in S['orgfiles'][78812][0]['comments'], (S['added'], S['orgfiles']))
        await ctx.close()

        # Halaxy sends the report page without its table once (a hiccup): asked again 20 seconds later, read as normal;
        # every time: the error says what came back
        for miss in (1, 5):
            reset(reportMiss=miss)
            ctx = await context(browser)
            pg = await ctx.new_page()
            await pg.goto(URL)
            await pg.wait_for_selector('[data-upc-bank-statement] .upc-bank-drop', state='attached', timeout=20000)
            await pg.set_input_files('[data-upc-bank-statement] input[type=file]', str(pdf))
            for want in range(1, min(miss, 2) + 1):
                for _ in range(200):
                    if S.get('missed', 0) >= want:
                        break
                    await asyncio.sleep(0.1)
                await pg.wait_for_timeout(300)
                await pg.clock.fast_forward(21000)
            await pg.wait_for_function("document.querySelector('[data-upc-bank-statement] table') || document.querySelector('[data-upc-bank-statement] .upc-err')", timeout=60000)
            if miss == 1:
                rows = await pg.evaluate(ROWS)
                check('report page without its table once: asked again, read as normal', S['missed'] == 1 and len(rows) == 9, (S.get('missed'), len(rows)))
            else:
                err = await pg.evaluate("document.querySelector('[data-upc-bank-statement] .upc-err').textContent")
                check('report page without its table twice: stops, saying what Halaxy sent', S['missed'] == 2 and 'not found twice; Halaxy sent a page titled "Reports | Halaxy"' in err, (S.get('missed'), err))
            await ctx.close()

        # not Carl: nothing
        reset(user='Someone Else')
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
