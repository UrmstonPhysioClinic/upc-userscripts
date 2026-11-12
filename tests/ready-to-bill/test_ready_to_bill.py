"""
Test for Ready to bill and core's report readers, against a mock Halaxy.

The mock has invented insurer patients ("Patient A" ...), each built to hit one rule: authorisation
used up, no visit for 14 days with nothing booked, fees 3 months old, held for the excess on a new
claim, not due yet, only a did-not-attend fee. Others must be left out: billed (Pending), Issued, on
the insurer's own invoice, self-funded, older than 6 months.

Checks: who is due and why; the greyed rows with their invoice links; the Invoice Funder link; the
count on the Finances menu item; the count shared with a second tab without asking Halaxy again;
invoice details cached; only Carl and Wendy see it; the last working day of the month; a changed
report is shown as an error and passed to the health check; the native look.

Run:  python3 tests/ready-to-bill/test_ready_to_bill.py
Needs: Python 3 with Playwright (Chromium).
"""
import asyncio, datetime, json, re, sys, urllib.parse
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
CORE = (ROOT / 'beta' / 'core.user.js').read_text()
RTB = (ROOT / 'beta' / 'ready-to-bill.user.js').read_text()
PG = '555'
MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
hx = lambda d: '%02d-%s-%d' % (d.day, MON[d.month - 1], d.year)
gbp = lambda c: '£%.2f' % (c / 100)

COLS = ['Invoice / Deposit', 'Date', 'Due Date', 'Practitioner', 'Payer ID', 'Payer', 'Funder', 'Category', 'Fee', 'Quantity',
        'Appointment Status', 'Invoice Status', 'Tax', 'Amount', 'Payments', '', 'Date', 'Method', 'Payments Inc. Fees', 'Balance', '']


def fresh(today, drop_column=None):
    T = today
    d = lambda n: T + datetime.timedelta(days=n)
    S = {'today': T, 'invoices': {}, 'pending': set(), 'events': [], 'log': [], 'drop': drop_column, 'forms': {}}

    def form(pid, fid, label, n, excess):
        S['forms'].setdefault(pid, []).append({'id': fid, 'label': label, 'day': d(n), 'excess': excess})

    def inv(iid, pid, payer, funder, lines, ref=None, status='Active', payer_id=None):
        S['invoices'][iid] = {'id': iid, 'pid': pid, 'payer': payer, 'payerId': str(payer_id or pid), 'funder': funder, 'ref': ref,
                              'status': status, 'lines': lines}

    def appt(pid, n, status=''):
        S['events'].append({'id': len(S['events']) + 1, 'type': 'appointment', 'linkPaGId': pid, 'appointmentStatus': status,
                            'start': int(datetime.datetime.combine(d(n), datetime.time(10)).timestamp())})

    def att(n, amt=4000, st='Attended', note=''):
        S['nextLine'] = S.get('nextLine', 7000) + 1
        return {'day': d(n), 'amount': amt, 'rebate': amt, 'status': st, 'lineId': S['nextLine'], 'appt': S['nextLine'] + 1000, 'note': note}
    # A: authorisation used up (5 of 5), two invoices, the second with two fees; booked next week
    inv(501, 301, 'Patient A', 'Bupa', [att(-20)], ref=(4, 5))
    inv(502, 301, 'Patient A', 'Bupa', [att(-6), att(-3)], ref=(5, 5))
    appt(301, -20); appt(301, -6); appt(301, -3); appt(301, 7)
    # B: last seen 20 days ago, nothing booked
    inv(511, 302, 'Patient B', 'AXA Health', [att(-20)], ref=(3, 6))
    appt(302, -20)
    # C: new claim, one fee so far, seen 2 days ago, nothing booked -> held for the excess
    inv(521, 303, 'Patient C', 'Bupa', [att(-2)], ref=(1, 5))
    appt(303, -2)
    # D: Bupa fee 100 days old, booked again -> due (old fees)
    inv(531, 304, 'Patient D', 'Bupa', [att(-100)], ref=(2, 10))
    appt(304, -100); appt(304, 5)
    # M: 3rd Party Funded fee 100 days old, booked again -> not due: billed only at the end
    inv(621, 313, 'Patient M', '3rd Party Funded', [att(-100)], ref=(2, 10))
    appt(313, -100); appt(313, 5)
    # N: 3rd Party Funded new claim, one fee, seen 2 days ago, nothing booked -> no excess hold, not due yet
    inv(631, 314, 'Patient N', '3rd Party Funded', [att(-2)], ref=(1, 10))
    appt(314, -2)
    # O: Aviva fee 100 days old, booked again -> due (Aviva is billed mid-treatment too)
    inv(641, 315, 'Patient O', 'Aviva', [att(-100)], ref=(2, 10))
    appt(315, -100); appt(315, 5)
    # P: Aviva new claim, one fee, seen 2 days ago, nothing booked -> held for the excess
    inv(651, 316, 'Patient P', 'Aviva', [att(-2)], ref=(1, 10))
    appt(316, -2)
    # E: seen yesterday, booked next week -> not due yet
    inv(541, 305, 'Patient E', 'Bupa', [att(-1)], ref=(3, 8))
    appt(305, -1); appt(305, 7)
    # F: only a did-not-attend fee
    inv(551, 306, 'Patient F', 'Bupa', [att(-5, st='Did not attend', note='No show. | Do not bill.')], ref=(2, 5))
    appt(306, -5, 'did-not-attend'); appt(306, 3)
    # Left out: billed (Pending), Issued, the insurer's own invoice, self-funded, older than 6 months
    inv(561, 307, 'Patient G', 'Bupa', [att(-30)], ref=(5, 5)); S['pending'].add(561)
    inv(571, 308, 'Patient H', 'AXA Health', [att(-30)], ref=(5, 5), status='Issued')
    inv(581, 309, 'Bupa Healthcare', 'Bupa', [att(-30)], payer_id='Bupa-1')
    inv(591, 310, 'Patient J', '', [att(-30)])
    inv(601, 311, 'Patient K', 'Bupa', [att(-200)], ref=(5, 5))
    # Q: Bupa new claim, one fee, intake form says no excess -> not held (the 2-fee fallback would hold)
    inv(661, 317, 'Patient Q', 'Bupa', [att(-2)], ref=(1, 5))
    appt(317, -2)
    form(317, 9001, 'Initial Assessment Form - Bupa', -9, 'None')
    # R: Bupa new claim, two fees (£ 80.00), intake form says £250 -> held (the fallback would not hold).
    #    An older Bupa form from a past claim (excess 50) and an AXA form must be ignored.
    inv(671, 318, 'Patient R', 'Bupa', [att(-6), att(-2)], ref=(1, 5))
    appt(318, -6); appt(318, -2)
    form(318, 9002, 'Initial Assessment Form - Bupa', -10, '250')
    form(318, 9003, 'Initial Assessment Form - AXA', -12, '10')
    form(318, 9004, 'Initial Assessment Form - Bupa', -300, '50')
    # L: "3rd Party Funded" counts as a funder; seen 3 days ago, booked
    inv(611, 312, 'Patient L', '3rd Party Funded', [att(-3)])
    appt(312, -3); appt(312, 4)
    return S


S = None


def report_html():
    cols = [c for c in COLS if c != S['drop']]
    head = ("<thead><tr><th colspan='%d'>Fees &amp; Charges</th><th></th><th colspan='6'>Payments</th><th></th><th></th></tr><tr>%s</tr></thead>"
            % (len(cols) - 9, ''.join('<th>%s</th>' % c for c in cols)))
    body = ''
    for iid, inv in S['invoices'].items():
        for k, l in enumerate(inv['lines']):
            # As live (12 Nov 2026): later fee rows leave the invoice-level cells blank; the balance is on the last row.
            first, lastrow = k == 0, k == len(inv['lines']) - 1
            v = {'Invoice / Deposit': "<a href='/a/pr/555/invoice/%d'>UPC-%d</a>" % (iid, iid) if first else '', 'Date': hx(l['day']) if first else '',
                 'Due Date': '', 'Practitioner': 'Prac One', 'Payer ID': inv['payerId'] if first else '', 'Payer': inv['payer'] if first else '', 'Funder': inv['funder'] if first else '',
                 'Category': 'Treatment', 'Fee': 'Follow-Up Physiotherapy Consultation', 'Quantity': '', 'Appointment Status': l['status'],
                 'Invoice Status': inv['status'] if first else '', 'Tax': '£0.00', 'Amount': gbp(l['amount']),
                 'Balance': gbp(sum(x['amount'] for x in inv['lines'])) if lastrow else ''}
            body += '<tr>' + ''.join('<td>%s</td>' % (v.get(c, '') if c else '') for c in cols) + '</tr>'
    body += "<tr><td colspan='13'>Total</td><td>£999.00</td></tr>"
    return "<html><body><table class='table-report'>%s<tbody>%s</tbody></table></body></html>" % (head, body)


def invoice_html(iid):
    inv = S['invoices'][iid]
    ref = ''
    if inv['ref']:
        n = inv['ref'][0]
        ref = "<span data-referral='1'>%s (%d%s of %d appts)</span>" % (hx(inv['lines'][0]['day']), n, 'th' if n > 3 else ['st', 'nd', 'rd'][n - 1], inv['ref'][1])
    lines = ''.join("<tr><td data-property='date'><a href='/a/pr/555/appointment/%d'>%s 09:00</a></td><td data-property='itemNumber'>Bup-FU</td>"
                    "<td data-property='amount' class='money number'>%s</td><td><a class='btn icon ajax' href='/a/pr/555/invoice/line/%d/edit'>e</a></td></tr>"
                    % (l['appt'], hx(l['day']), gbp(l['amount']), l['lineId']) for l in inv['lines'])
    btn = "<a class='ajax btn' id='invoiceFunderBtn' data-modal-href='/a/pr/555/invoicefunctions/%d/claim/77/'>Invoice Funder</a>" % iid
    return ("<html><head><title>Invoice UPC-%d | Halaxy</title></head><body><div id='card-invoice-view-patient'>"
            "<a href='/a/magic/add/patient/%d/invoice'>Edit</a><a href='/a/pr/555/patient/%d'>%s</a></div>"
            "<div id='card-invoice-parts-claim-view'><a href='/a/pr/555/organisation/1'>%s</a>%s</div>"
            "<table id='invoiceLines'><tbody>%s</tbody></table><table id='invoicePayments'><tbody><tr><td>%s</td></tr></tbody></table></body></html>"
            % (iid, inv['pid'], inv['pid'], inv['payer'], inv['funder'], ref, lines, btn))


def page_html(user):
    return ("<!doctype html><html><head><title>Invoices | Halaxy</title></head><body style='margin:0 0 0 230px'>"
            "<div style='position:fixed;left:0;top:0;bottom:0;width:218px'><nav id='side'><ul id='mainMenu'>"
            "<li class='mainmenu-item active'><a class='mainmenu-link'><span class='mainmenu-link-label'>Finances</span></a>"
            "<ul><li><a class='mainmenu-sublink' href='/a/pr/555/expense/'>Expenses</a></li><li class='active'><a class='mainmenu-sublink active' href='/a/pr/555/invoice/'>Invoices</a></li></ul></li>"
            "<li class='mainmenu-item'><a class='mainmenu-link'><span class='mainmenu-link-label'>Reports</span></a>"
            "<ul><li><a class='mainmenu-sublink' href='/a/pr/555/report/finance/'>Finance</a></li></ul></li></ul></nav></div>"
            "<div id='headerWrapper' style='height:50px'></div><h1>Invoices</h1>"
            "<script>window.HkUser = { linkPrG: 11, pracID: 11, pracName: %s };</script></body></html>") % json.dumps(user)


async def halaxy(route):
    req = route.request
    p = urllib.parse.urlparse(req.url).path
    S['log'].append((req.method, p))
    js = lambda o: route.fulfill(body=json.dumps(o), content_type='application/json')
    if p.endswith('/report/finance/0'):
        return await route.fulfill(body=report_html(), content_type='text/html')
    if p.endswith('/invoice/list-data') and req.method == 'POST':
        body = json.loads(req.post_data or '{}')
        S['listBody'] = body
        ids = sorted(S['pending']) if 'Pending' in json.dumps(body.get('filterModel')) else []
        return await js({'rowData': [{'id': i, 'status': 'Pending'} for i in ids], 'lastRow': len(ids)})
    if p.endswith('/lookup/practitioner'):
        return await js([{'id': 11, 'name': 'Prac One'}, {'id': 12, 'name': 'Prac Two'}])
    if p.endswith('/calendar/json'):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(req.url).query)
        lo, hi = int(q['start'][0]), int(q['end'][0])
        return await js({'status': 'OK', 'payload': {'events': [e for e in S['events'] if lo <= e['start'] < hi]}})
    m = re.search(r'/note/menu/linkPaG/(\d+)/items$', p)
    if m:
        pid = int(m.group(1))
        S.setdefault('formReads', []).append(('menu', pid))
        items = [{'id': 'a1', 'category': 'appointment', 'entity': 'note', 'label': 'Appointment', 'date': hx(S['today']), 'items': []}]
        for f in S['forms'].get(pid, []):
            items.append({'id': str(f['id']), 'parentId': None, 'category': 'form', 'entity': 'intake-form-invite', 'label': f['label'], 'status': 'published',
                          'date': hx(f['day']), 'items': [{'id': '7' + str(f['id']), 'parentId': str(f['id']), 'category': 'tool', 'entity': 'note', 'label': f['label'], 'items': None}]})
        return await js({'status': 'OK', 'payload': {'menuItems': items, 'total': len(items), 'page': 0, 'pageSize': 250}})
    m = re.search(r'/setting/clinical/patient/intake/(\d+)$', p)
    if m:
        f = next(f for fs in S['forms'].values() for f in fs if f['id'] == int(m.group(1)))
        S.setdefault('formReads', []).append(('form', f['id']))
        q = lambda name, ans: ("<div class='depth-level-1 published col-12'><p class='answerContainer mb-1'><span class='answerName font-weight-bold text-break'>%s</span></p>%s</div>"
                               % (name, "<span class='answer-wrap'>%s</span>" % ans if ans is not None else ''))
        html = ("<div class='viewRow'><div class='data full-data-width'><div class='metabox'><fieldset>" + q('What would you like to discuss during your appointment?', None)
                + q('Excess amount:', f['excess']) + q('Please enter the number of sessions you have had authorised:', '6') + '</fieldset></div></div></div>')
        return await js({'status': 'FORM', 'title': f['label'], 'message': html})
    m = re.search(r'/invoice/line/(\d+)/edit$', p)
    if m:
        lid = int(m.group(1))
        line = next(l for inv in S['invoices'].values() for l in inv['lines'] if l['lineId'] == lid)
        if req.method == 'GET':
            form = ("<form id='invoiceLineForm' method='post'><input name='form[date]' value='%s'><input name='form[amount]' value='%.2f'>"
                    "<input name='form[rebate]' value='%.2f'><input type='hidden' name='form[_token]' value='LT-%d'></form>") % (hx(line['day']), line['amount'] / 100, line['rebate'] / 100, lid)
            return await js({'status': 'FORM', 'title': 'Edit fee', 'message': form})
        f = urllib.parse.parse_qs(req.post_data or '', keep_blank_values=True)
        S.setdefault('writes', []).append((lid, f['form[amount]'][0], f['form[rebate]'][0]))
        line['amount'] = int(round(float(f['form[amount]'][0]) * 100)); line['rebate'] = int(round(float(f['form[rebate]'][0]) * 100))
        return await js({'status': 'REFRESH'})
    m = re.search(r'/appointment/(\d+)$', p)
    if m:
        line = next((l for inv in S['invoices'].values() for l in inv['lines'] if l['appt'] == int(m.group(1))), None)
        if req.headers.get('x-requested-with') != 'XMLHttpRequest':
            return await route.fulfill(body='<html><body></body></html>', content_type='text/html')
        notes = ''.join('%s<br>' % x for x in (line['note'].split(' | ') if line and line['note'] else []))
        return await route.fulfill(body="<div class='appointment-details-popup'><div class='subTitle'>Notes</div><div>%s</div></div>" % notes, content_type='text/html')
    m = re.search(r'/invoice/(\d+)/?$', p)
    if m and int(m.group(1)) in S['invoices']:
        return await route.fulfill(body=invoice_html(int(m.group(1))), content_type='text/html')
    if re.search(r'/invoice/?$', p):
        return await route.fulfill(body=page_html(S['user']), content_type='text/html')
    await route.fulfill(status=404, body='not mocked: ' + p)


FAILS = []
def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)[:600]))
    if not ok:
        FAILS.append(name)


async def context(browser, now):
    ctx = await browser.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/London')
    await ctx.clock.install(time=now)   # runs on from this time (requests are paced by the clock)
    await ctx.route('https://eu.halaxy.com/**', halaxy)
    await ctx.add_init_script(CORE)
    await ctx.add_init_script("document.addEventListener('DOMContentLoaded', function () {\n" + RTB + "\n});")
    await ctx.add_init_script("document.addEventListener('upc-loader-error', (e) => { (window.__healthErrors = window.__healthErrors || []).push(JSON.parse(e.detail)); });")
    return ctx


async def open_page(ctx, path='/a/pr/555/invoice/#upc-ready-to-bill'):
    pg = await ctx.new_page()
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    await pg.goto('https://eu.halaxy.com' + path)
    return pg, errors


ROOT_JS = "document.querySelector('[data-upc-ready-to-bill]')"
ROWS_JS = """[...document.querySelectorAll('[data-upc-ready-to-bill] tbody tr')].map((tr) => ({
  off: tr.classList.contains('upc-off'), who: tr.cells[0].textContent, funder: tr.cells[1].textContent, unbilled: tr.cells[2].textContent,
  why: tr.cells[4].textContent, invs: [...tr.cells[5].querySelectorAll('a')].map((a) => a.getAttribute('href')),
  btn: tr.cells[6] && tr.cells[6].querySelector('a') ? tr.cells[6].querySelector('a').getAttribute('href') : null,
  btnCls: tr.cells[6] && tr.cells[6].querySelector('a') ? tr.cells[6].querySelector('a').className : null,
  patient: tr.cells[0].querySelector('a') ? tr.cells[0].querySelector('a').getAttribute('href') : null }))"""


async def main():
    global S
    async with async_playwright() as p:
        browser = await p.chromium.launch()

        # Scenario 1: Tuesday 10 Nov 2026, Carl signed in
        S = fresh(datetime.date(2026, 11, 10)); S['user'] = 'Carl Healy'
        ctx = await context(browser, '2026-11-10T12:00:00Z')
        pg, errors = await open_page(ctx)
        await pg.wait_for_function(ROOT_JS + " && " + ROOT_JS + ".querySelector('table')", timeout=60000)
        await pg.wait_for_function("!document.querySelector('[data-a=refresh]').disabled", timeout=60000)
        rows = await pg.evaluate(ROWS_JS)
        by = {r['who']: r for r in rows}
        due = [r['who'] for r in rows if not r['off']]
        check('due: authorisation used up, 14 days quiet, old fees', sorted(due) == ['Patient A', 'Patient B', 'Patient D', 'Patient O'], rows)
        check('authorisation reason', 'Authorisation used up (5 of 5)' in by.get('Patient A', {}).get('why', ''), by.get('Patient A'))
        check('quiet reason names the last visit', 'No visit for 14 days (last 21-Oct-2026), nothing booked' in by.get('Patient B', {}).get('why', ''), by.get('Patient B'))
        check('old fees reason', 'Fees from 02-Aug-2026, over 3 months old' in by.get('Patient D', {}).get('why', ''), by.get('Patient D'))
        check('3rd Party Funded: old fees are not due, billed at the end', by.get('Patient M', {}).get('off') and 'Billed at the end of treatment (3rd Party Funded' in by['Patient M']['why'], by.get('Patient M'))
        check('3rd Party Funded: no excess hold on a new claim', by.get('Patient N', {}).get('off') and 'Held' not in by['Patient N']['why'], by.get('Patient N'))
        check('Aviva: old fees are due', not by.get('Patient O', {}).get('off', True) and 'over 3 months old' in by['Patient O']['why'], by.get('Patient O'))
        check('Aviva: new claim held for the excess', by.get('Patient P', {}).get('off') and 'Held for the excess' in by['Patient P']['why'], by.get('Patient P'))
        check('not the last working day, so no month-end reason', not any('Last working day' in r['why'] for r in rows), rows)
        check('fees from both of a patient\'s invoices are counted', by.get('Patient A', {}).get('unbilled') == '3 fees£ 120.00', by.get('Patient A'))
        check('Invoice Funder button opens the latest invoice with Invoice Funder', by.get('Patient A', {}).get('btn') == '/a/pr/555/invoice/502#upc-invoice-funder', by.get('Patient A'))
        check('the button is Halaxy\'s', by.get('Patient A', {}).get('btnCls') == 'btn btn-outline-primary-light', by.get('Patient A'))
        check('every invoice is linked', by.get('Patient A', {}).get('invs') == ['/a/pr/555/invoice/501', '/a/pr/555/invoice/502'], by.get('Patient A'))
        check('patient name links to the patient', by.get('Patient A', {}).get('patient') == '/a/pr/555/patient/301', by.get('Patient A'))
        off = [r['who'] for r in rows if r['off']]
        check('greyed at the bottom: did-not-attend only, held, not due yet', off[:4] == ['Patient F', 'Patient R', 'Patient C', 'Patient P'] and set(off) == {'Patient F', 'Patient C', 'Patient P', 'Patient R', 'Patient M', 'Patient L', 'Patient N', 'Patient Q', 'Patient E'} and rows[-9:] == [by[w] for w in off] == [by[w] for w in off], [r['who'] for r in rows])
        check('held for the excess, explained', 'Held for the excess' in by.get('Patient C', {}).get('why', ''), by.get('Patient C'))
        check('greyed rows link to their invoices but have no button', by.get('Patient C', {}).get('invs') == ['/a/pr/555/invoice/521'] and not by.get('Patient C', {}).get('btn'), by.get('Patient C'))
        check('not due yet shows the next booking', 'next booked 17-Nov-2026' in by.get('Patient E', {}).get('why', ''), by.get('Patient E'))
        check('excess from the intake form: holds until the fees cover it', by.get('Patient R', {}).get('off') and
              'patient-reported excess £ 250.00 (unconfirmed), fees so far £ 80.00' in by['Patient R']['why'], by.get('Patient R'))
        check('excess "None" on the form: not held', 'Held' not in by.get('Patient Q', {}).get('why', 'Held'), by.get('Patient Q'))
        check('no intake form: falls back to 2 fees', 'excess not found on the intake form, so waiting for 2 fees' in by.get('Patient C', {}).get('why', ''), by.get('Patient C'))
        check('Aviva: its form doesn\'t ask, so 2 fees', 'Aviva\'s form doesn\'t ask for the excess' in by.get('Patient P', {}).get('why', ''), by.get('Patient P'))
        reads = S.get('formReads', [])
        check('forms read only for Bupa and AXA new claims, one form each', sorted(x for x in reads if x[0] == 'form') == [('form', 9001), ('form', 9002)]
              and sorted(x[1] for x in reads if x[0] == 'menu') == [303, 317, 318], reads)
        check('did-not-attend only: asks to check', 'Only cancelled or did-not-attend' in by.get('Patient F', {}).get('why', ''), by.get('Patient F'))
        check('did-not-attend only: shows the not-attended fee, not "0 fees"', by.get('Patient F', {}).get('unbilled') == '1 not attended£ 40.00', by.get('Patient F'))
        await pg.wait_for_function("document.querySelector('[data-upc-ready-to-bill] [data-zero]')", timeout=60000)
        ftxt = await pg.evaluate("[...document.querySelectorAll('[data-upc-ready-to-bill] tbody tr')].find((tr) => tr.cells[0].textContent === 'Patient F').cells[4].innerText")
        check('did-not-attend fee shown with its appointment comments', 'No show.' in ftxt and 'Do not bill.' in ftxt and '05-Nov-2026' in ftxt, ftxt)
        heads = await pg.evaluate("[...document.querySelectorAll('[data-upc-ready-to-bill] table')].map((t) => t.tHead.rows[0].cells.length)")
        check('no empty column on the not-due table', heads == [7, 6], heads)
        check('"3rd Party Funded" counts as a funder', 'Patient L' in by, rows)
        check('left out: billed, Issued, insurer\'s own, self-funded, over 6 months', not any(w in by for w in ['Patient G', 'Patient H', 'Bupa Healthcare', 'Patient J', 'Patient K']), list(by))
        check('Pending list asked with Halaxy\'s status filter', S.get('listBody', {}).get('filterModel', {}).get('status', {}).get('filter') == 'Pending', S.get('listBody'))
        # Set to £ 0.00: confirm first, then fee and rebate together
        await pg.click('[data-upc-ready-to-bill] [data-zero]')
        await pg.wait_for_selector('[data-upc-rtb-confirm]')
        conf = await pg.evaluate("document.querySelector('[data-upc-rtb-confirm]').innerText")
        check('Set to £ 0.00 asks first, naming the fee', 'Set the 05-Nov-2026 fee on UPC-551' in conf and not S.get('writes'), conf)
        await pg.click('[data-upc-rtb-confirm] [data-a=yes]')
        await pg.wait_for_function("document.querySelector('[data-upc-ready-to-bill] .upc-rtb-fee .upc-ok')", timeout=60000)
        check('fee and its funder rebate set to £ 0.00', S.get('writes') == [(S['invoices'][551]['lines'][0]['lineId'], '0.00', '0.00')], S.get('writes'))
        zero_words = await pg.evaluate("/\\bzero\\b/i.test(document.querySelector('[data-upc-ready-to-bill]').innerText)")
        check('worded "Set to £ 0.00", never "zero"', not zero_words)
        reqs = [x for x in S['log'] if not x[1].endswith('/invoice/')]
        reports = [x for x in reqs if x[1].endswith('/report/finance/0')]
        invs = [x for x in reqs if re.search(r'/invoice/\d+$', x[1])]
        cal = [x for x in reqs if x[1].endswith('/calendar/json')]
        check('one report and one calendar per check', len(reports) == 1 and len(cal) == 1, reqs)
        badge = await pg.evaluate("(document.querySelector('a.upc-rtb-menu .upc-rtb-badge') || {}).textContent")
        check('count on the menu item', badge == '4', badge)
        menu = await pg.evaluate("[...document.querySelectorAll('#mainMenu a.mainmenu-sublink')].map(a => a.getAttribute('href'))")
        check('menu item under Finances, over the Invoices page', '/a/pr/555/invoice/#upc-ready-to-bill' in menu and await pg.evaluate(
            "document.querySelector('.upc-rtb-menu').closest('.mainmenu-item').querySelector('.mainmenu-link-label').textContent") == 'Finances', menu)
        look = await pg.evaluate("(() => { const r = " + ROOT_JS + "; return { native: r.classList.contains('upc-native'), shadow: !!r.shadowRoot, tables: [...r.querySelectorAll('table')].map(t => t.className), css: !!document.getElementById('upc-rtb-css') }; })()")
        check('native look', look['native'] and not look['shadow'] and look['css'] and look['tables'][0].startswith('table table-striped table-bordered'), look)
        check('no page errors', not errors, errors)

        # A second tab: the count comes from the first tab's check, without asking Halaxy again
        n = len(S['log'])
        pg2, errors2 = await open_page(ctx, '/a/pr/555/invoice/')
        await pg2.wait_for_selector('a.upc-rtb-menu', timeout=10000)
        await pg2.wait_for_timeout(3500)
        badge2 = await pg2.evaluate("(document.querySelector('a.upc-rtb-menu .upc-rtb-badge') || {}).textContent")
        check('second tab shows the count without asking Halaxy', badge2 == '4' and [x for x in S['log'][n:] if not x[1].endswith('/invoice/')] == [], (badge2, S['log'][n:]))

        # Check again: invoice details come from the cache
        n = len(S['log'])
        await pg.click('[data-a=refresh]')
        await pg.wait_for_function("!document.querySelector('[data-a=refresh]').disabled", timeout=60000)
        again = S['log'][n:]
        check('checking again reuses invoice details', not [x for x in again if re.search(r'/invoice/\d+$', x[1])] and any(x[1].endswith('/report/finance/0') for x in again), again)
        await ctx.close()

        # Scenario 2: Monday 30 Nov 2026 (the last working day): everything not held or unclear is due
        S = fresh(datetime.date(2026, 11, 30)); S['user'] = 'Wendy Pritchard'
        ctx = await context(browser, '2026-11-30T12:00:00Z')
        pg, errors = await open_page(ctx)
        await pg.wait_for_function(ROOT_JS + " && " + ROOT_JS + ".querySelector('table')", timeout=60000)
        await pg.wait_for_function("!document.querySelector('[data-a=refresh]').disabled", timeout=60000)
        rows = await pg.evaluate(ROWS_JS)
        by = {r['who']: r for r in rows}
        check('Wendy sees it too', bool(rows), rows)
        check('last working day: not-due-yet patients are due', not by.get('Patient E', {}).get('off', True) and 'Last working day of the month' in by['Patient E']['why'], by.get('Patient E'))
        check('last working day: held and did-not-attend stay greyed', by.get('Patient C', {}).get('off') and by.get('Patient F', {}).get('off'), rows)
        check('last working day: 3rd Party Funded still waits for the end', by.get('Patient M', {}).get('off') and by.get('Patient L', {}).get('off'), rows)
        lwd = await pg.evaluate("[['2026-11-27', 0], ['2026-11-30', 1], ['2027-01-29', 1], ['2027-01-31', 0], ['2027-02-26', 1]].every(([d, want]) => window.upcReadyToBill.isLastWorkingDay(new Date(d + 'T12:00:00').getTime()) === !!want)")
        check('last working day skips weekends', lwd)
        check('no page errors (scenario 2)', not errors, errors)
        await ctx.close()

        # Scenario 3: someone else signed in sees nothing and nothing is asked of Halaxy
        S = fresh(datetime.date(2026, 11, 10)); S['user'] = 'Lottie Harold'
        ctx = await context(browser, '2026-11-10T12:00:00Z')
        pg, errors = await open_page(ctx)
        await pg.wait_for_timeout(4000)
        check('others: no menu item and no page', await pg.evaluate("!document.querySelector('.upc-rtb-menu') && !" + ROOT_JS), await pg.evaluate("document.body.innerHTML.slice(0, 200)"))
        check('others: no requests', [x for x in S['log'] if not x[1].endswith('/invoice/')] == [], S['log'])
        await ctx.close()

        # Scenario 4: Halaxy changes the report: a clear error, passed to the health check
        S = fresh(datetime.date(2026, 11, 10), drop_column='Funder'); S['user'] = 'Carl Healy'
        ctx = await context(browser, '2026-11-10T12:00:00Z')
        pg, errors = await open_page(ctx)
        await pg.wait_for_function("document.querySelector('[data-upc-ready-to-bill] .upc-err')", timeout=60000)
        err = await pg.evaluate("document.querySelector('[data-upc-ready-to-bill] .upc-err').textContent")
        check('changed report gives a clear message', 'Unpaid Invoices report has changed (Funder not found)' in err, err)
        health = await pg.evaluate("window.__healthErrors || []")
        check('and the health check is told', any(h['file'] == 'ready-to-bill.user.js' and 'Funder not found' in h['message'] for h in health), health)
        check('no page errors (scenario 4)', not errors, errors)
        await ctx.close()
        await browser.close()

    print('\n%d failed' % len(FAILS) if FAILS else '\nAll passed')
    sys.exit(1 if FAILS else 0)

asyncio.run(main())
