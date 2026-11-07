"""
Test for Bill funder, against a mock Halaxy with one invented patient whose invoices cover every rule.

Checks: which fees are suggested and ticked (past attended fees in the last 6 months, same claim,
unbilled, not Issued; DNA and £0 fees listed but not ticked, with the appointment comment; future,
old, other-claim and billed fees left out); nothing changes before confirming; fees are merged first
onto an invoice that holds only chosen fees, then the funder is invoiced once as a NEW organisation
invoice (never the existing one Halaxy pre-selects); the result is checked and reported.

Run:  python3 tests/bill-funder/test_bill_funder.py
Needs: Python 3 with Playwright (Chromium).
"""
import asyncio, datetime, json, re, sys, urllib.parse
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
CORE = (ROOT / 'beta' / 'core.user.js').read_text()
BILL = (ROOT / 'beta' / 'bill-funder.user.js').read_text()
PG, PATIENT, CLAIM, OTHER_CLAIM = '555', 500, 77, 88
TODAY = datetime.date.today()
d = lambda days: TODAY - datetime.timedelta(days=days)
hx = lambda day: day.strftime('%d-%b-%Y')


def fresh(extra_line_on_latest=False):
    S = {'invoices': {}, 'calls': [], 'next_org': 9001}
    def inv(iid, days, status='', note='', claim=CLAIM, billed=False, amount=4000, ref=None, lines=None):
        day = d(days)
        S['invoices'][iid] = {'id': iid, 'claim': claim, 'billed': billed, 'ref': ref,
                              'lines': lines or [{'lineId': iid + 1000, 'appt': iid + 2000, 'day': day, 'amount': amount, 'status': status, 'note': note}]}
    inv(1001, 60, ref=(1, 5))
    inv(1002, 45, status='did-not-attend', note='Late cancellation. Bill Bupa? Check policy first.')
    inv(1003, 30, ref=(2, 5))
    inv(1004, -20)                         # future booking
    inv(1005, 240)                         # older than 6 months
    inv(1006, 25, claim=OTHER_CLAIM)       # another claim
    inv(1007, 20, billed=True)             # already billed to the funder
    inv(1008, 15, amount=0)                # £0 fee
    inv(1009, 10, ref=(6, 5))              # beyond the authorisation
    if extra_line_on_latest:               # latest invoice also holds an unticked DNA fee
        S['invoices'][1009]['lines'].append({'lineId': 2010, 'appt': 3010, 'day': d(9), 'amount': 4000, 'status': 'did-not-attend', 'note': 'No show'})
    S['orgs'] = {7777: {'number': 'UPC-7777', 'lines': [], 'patient': 'Another Patient'}}
    return S

S = fresh()
gbp = lambda c: '£ %.2f' % (c / 100)


def invoice_html(iid):
    inv = S['invoices'][iid]
    lines = ''.join("<tr><td data-property='date'><a href='/a/pr/555/appointment/%d'>%s 09:00</a></td><td data-property='itemNumber'>Bup-FU</td>"
                    "<td data-property='tax'>£ 0.00</td><td data-property='amount' class='money number'>%s</td>"
                    "<td><a class='btn icon ajax' href='/a/pr/555/invoice/line/%d/edit'>e</a></td></tr>" % (l['appt'], hx(l['day']), gbp(l['amount']), l['lineId']) for l in inv['lines'])
    total = sum(l['amount'] for l in inv['lines'])
    pay = ''
    if inv['billed']:
        org = inv.get('org', 7777)
        pay += "<tr><td></td><td>Invoice UPC-%d</td><td>Issued</td><td><a href='/a/pr/555/invoice/%d'>%s</a></td></tr>" % (org, org, gbp(total))
    else:
        pay += "<tr><td></td><td>Funder Payment</td><td></td><td>%s</td><td><a class='ajax btn' data-modal-href='/a/pr/555/invoicefunctions/%d/claim/%d/' id='invoiceFunderBtn'>Invoice Funder</a></td></tr>" % (gbp(total), iid, inv['claim'])
    pay += "<tr><td></td><td></td><td>Outstanding</td><td>%s</td></tr>" % gbp(total)
    ref = "<span data-referral='1'>%s (%d%s of %d appts)</span>" % (hx(inv['lines'][0]['day']), inv['ref'][0], 'th' if inv['ref'][0] > 3 else ['st', 'nd', 'rd'][inv['ref'][0] - 1], inv['ref'][1]) if inv['ref'] else ''
    return ("<html><head><title>Invoice UPC-%d | Halaxy</title></head><body><div id='mainMenu'></div><div id='pageContent'>"
            "<div id='card-invoice-view-patient'><a href='/a/pr/555/patient/%d'>Patient Test</a></div>"
            "<div id='card-invoice-parts-claim-view'><a href='/a/pr/555/organisation/7364'>Bupa Healthcare</a>"
            "<a id='editClaimButton' href='/a/pr/555/patient/claim/18874/%d/%d/edit?invoice=%d'>e</a>%s</div>"
            "<table id='invoiceLines'><tbody>%s<tr class='totals'><td>Total</td><td>£ 0.00</td><td>%s</td></tr></tbody></table>"
            "<table id='invoicePayments'><tbody>%s</tbody></table></div></body></html>") % (iid, PATIENT, PATIENT, inv['claim'], iid, ref, lines, gbp(total), pay)


def merge_popup(target):
    rows = []
    for iid, inv in S['invoices'].items():
        if iid == target:
            continue
        for l in inv['lines']:
            rows.append({'invoiceLineId': l['lineId'], 'invoiceId': iid, 'invoiceDisplayId': 'UPC-%d' % iid,
                         'invoiceLineDate': l['day'].isoformat() + 'T09:00:00+00:00', 'clinicName': 'Clinic', 'practitionerName': 'Prac One',
                         'invoiceLineName': 'Bup-FU - Bupa: Follow-Up (£40)', 'tax': '0.00', 'total': str(l['amount'] / 100),
                         'balance': str(l['amount'] / 100), 'fromPastUnpaidInvoice': False, 'patientName': 'Patient Test'})
    lit = json.dumps(rows).replace('\\', '\\\\').replace('"', '\\"').replace("'", "\\'")
    return ("<form name='form' method='post' id='groupInvoiceLinesForm'><input type='radio' name='form[type]' value='1' checked>"
            "<input type='hidden' name='form[hasUnpaidInvoices]' value='1'></form><script>var allInvoiceGroupEditGridData = JSON.parse('%s').map(l => l);</script>" % lit)


def bill_popup(iid):
    return ("<form name='form' method='post' id='organisationBillForm'><input type='radio' name='form[switchPayer]' value='yes'>"
            "<input type='radio' name='form[switchPayer]' value='no' checked><table id='invoices'><tbody>"
            "<tr><td><input type='radio' name='form[orgInvoice]' value='0'></td><td>Create new invoice</td></tr>"
            "<tr><td><input type='radio' name='form[orgInvoice]' value='7777' checked></td><td>UPC-7777</td><td>Another Patient</td></tr></tbody></table></form>")


async def halaxy(route):
    req = route.request
    u = urllib.parse.urlparse(req.url)
    p = u.path
    form = urllib.parse.parse_qs(req.post_data or '', keep_blank_values=True) if req.method == 'POST' else {}
    js = lambda o: route.fulfill(body=json.dumps(o), content_type='application/json')
    if p.endswith('/lookup/practitioner'):
        return await js([{'id': 11, 'name': 'Prac One'}])
    if p.endswith('/calendar/json'):
        ev = [{'id': l['appt'], 'type': 'appointment', 'appointmentStatus': l['status'], 'note': l['note']} for inv in S['invoices'].values() for l in inv['lines']]
        return await js({'status': 'OK', 'payload': {'events': ev}})
    m = re.search(r'/invoice/(\d+)/group$', p)
    if m:
        target = int(m.group(1))
        if req.method == 'GET':
            return await js({'status': 'VIEW', 'title': 'Merge invoice fees', 'message': merge_popup(target)})
        S['calls'].append(('merge', target, sorted(int(x) for x in form.get('form[il][]', []))))
        moving = set(int(x) for x in form.get('form[il][]', []))
        for iid, inv in list(S['invoices'].items()):
            if iid == target:
                continue
            keep = [l for l in inv['lines'] if l['lineId'] not in moving]
            S['invoices'][target]['lines'] += [l for l in inv['lines'] if l['lineId'] in moving]
            if not keep:
                del S['invoices'][iid]
            else:
                inv['lines'] = keep
        return await js({'status': 'REFRESH'})
    m = re.search(r'/invoicefunctions/(\d+)/claim/(\d+)/$', p)
    if m:
        iid = int(m.group(1))
        if req.method == 'GET':
            return await js({'status': 'FORM', 'title': 'Bill Payment', 'message': bill_popup(iid)})
        choice = form.get('form[orgInvoice]', [''])[0]
        S['calls'].append(('bill', iid, choice, form.get('form[switchPayer]', [''])[0]))
        inv = S['invoices'][iid]
        if choice == '0':
            org = S['next_org']; S['next_org'] += 1
            S['orgs'][org] = {'number': 'UPC-%d' % org, 'lines': list(inv['lines']), 'patient': 'Patient Test'}
        else:
            org = int(choice); S['orgs'][org]['lines'] += inv['lines']
        inv['billed'], inv['org'] = True, org
        return await js({'status': 'REFRESH'})
    m = re.search(r'/invoice/(\d+)/?$', p)
    if m:
        iid = int(m.group(1))
        if iid in S['invoices']:
            return await route.fulfill(body=invoice_html(iid), content_type='text/html')
        if iid in S['orgs']:
            return await route.fulfill(body="<html><head><title>Invoice %s | Halaxy</title></head><body><table id='invoiceLines'></table></body></html>" % S['orgs'][iid]['number'], content_type='text/html')
        return await route.fulfill(status=404, body='gone')
    await route.fulfill(status=404, body='not mocked: ' + p)


FAILS = []
def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)[:500]))
    if not ok:
        FAILS.append(name)


async def open_panel(browser, iid):
    ctx = await browser.new_context(viewport={'width': 1300, 'height': 900})
    await ctx.route('https://eu.halaxy.com/**', halaxy)
    await ctx.add_init_script(CORE)
    await ctx.add_init_script("document.addEventListener('DOMContentLoaded', function () {\n" + BILL + "\n});")
    pg = await ctx.new_page()
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    await pg.goto('https://eu.halaxy.com/a/pr/555/invoice/%d' % iid)
    await pg.wait_for_timeout(300)
    btn = await pg.evaluate("(() => { const b = document.getElementById('upcBillFunderBtn'); return b && b.previousElementSibling && b.previousElementSibling.id; })()")
    await pg.click('#upcBillFunderBtn')
    root = "document.querySelector('[data-upc-bill-funder]').shadowRoot"
    await pg.wait_for_function(root + ".querySelector('tbody')", timeout=60000)
    return ctx, pg, root, btn, errors


async def main():
    global S
    async with async_playwright() as p:
        browser = await p.chromium.launch()

        # Scenario 1: the full rule set, then merge and bill
        ctx, pg, root, btn, errors = await open_panel(browser, 1003)
        check('Bill funder button sits next to Halaxy\'s Invoice Funder', btn == 'invoiceFunderBtn', btn)
        rows = await pg.evaluate("[..." + root + ".querySelectorAll('tbody tr')].map(r => ({ inv: r.querySelector('a').textContent, ticked: r.querySelector('input').checked, text: r.innerText.replace(/\\s+/g, ' ') }))")
        by = {r['inv']: r for r in rows}
        check('suggests past, unbilled, same-claim fees in the last 6 months', sorted(by) == ['UPC-1001', 'UPC-1002', 'UPC-1003', 'UPC-1008', 'UPC-1009'], sorted(by))
        check('attended fees ticked', by['UPC-1001']['ticked'] and by['UPC-1003']['ticked'] and by['UPC-1009']['ticked'])
        check('did-not-attend listed but not ticked, with its comment', not by['UPC-1002']['ticked'] and 'did not attend' in by['UPC-1002']['text'] and 'Late cancellation. Bill Bupa? Check policy first.' in by['UPC-1002']['text'], by['UPC-1002'])
        check('£0 fee listed but not ticked', not by['UPC-1008']['ticked'] and '£0 fee' in by['UPC-1008']['text'])
        check('beyond the authorisation flagged', 'Appointment 6 of 5 authorised: beyond the authorisation' in by['UPC-1009']['text'], by['UPC-1009']['text'])
        note = await pg.evaluate(root + ".textContent")
        check('says what was left out', 'Not shown: 1 future-dated, 1 older than 6 months, 1 already billed, 1 for another claim or self-funded.' in note, re.findall(r'Not shown:[^.]*\.', note))
        check('nothing changed before confirming', S['calls'] == [], S['calls'])
        await pg.evaluate(root + ".querySelector('[data-a=next]').click()")
        conf = await pg.evaluate(root + ".querySelector('.log').innerText")
        check('confirm step explains what will happen', 'Merge 3 fees (£120.00)' in conf and 'new organisation invoice' in conf, conf)
        await pg.evaluate(root + ".querySelector('[data-a=go]').click()")
        await pg.wait_for_function(root + ".querySelector('.ok') || " + root + ".querySelector('.log .err')", timeout=60000)
        done = await pg.evaluate(root + ".textContent")
        check('merged first, onto the latest chosen invoice, then billed once', [c[0] for c in S['calls']] == ['merge', 'bill'] and S['calls'][0][1] == 1009 and S['calls'][0][2] == [2001, 2003] and S['calls'][1][1] == 1009, S['calls'])
        check('billed as a NEW organisation invoice, keeping the patient invoice', S['calls'][1][2:] == ('0', 'no'), S['calls'])
        check('never used Halaxy\'s pre-selected invoice for another patient', S['orgs'][7777]['lines'] == [])
        org = S['orgs'].get(9001, {})
        check('organisation invoice holds exactly the chosen fees', sorted(l['lineId'] for l in org.get('lines', [])) == [2001, 2003, 2009], org)
        check('unticked fees left alone', 1002 in S['invoices'] and 1008 in S['invoices'] and not S['invoices'][1002]['billed'])
        check('reports the result with the new invoice number', 'Done.' in done and 'UPC-9001' in done and '£ 120.00'.replace(' ', '') in done.replace(' ', ''), done[-300:])
        check('no page errors', not errors, errors)
        await ctx.close()

        # Scenario 2: the latest invoice also holds an unticked fee -> merge onto another invoice instead
        S = fresh(extra_line_on_latest=True)
        ctx, pg, root, btn, errors = await open_panel(browser, 1003)
        await pg.evaluate(root + ".querySelector('[data-a=next]').click()")
        await pg.evaluate(root + ".querySelector('[data-a=go]').click()")
        await pg.wait_for_function(root + ".querySelector('.ok') || " + root + ".querySelector('.log .err')", timeout=60000)
        merge = [c for c in S['calls'] if c[0] == 'merge']
        check('never merges onto an invoice holding a fee you did not tick', merge and merge[0][1] == 1003 and merge[0][2] == [2001, 2009], S['calls'])
        check('the unticked fee stays unbilled on its own invoice', [l['lineId'] for l in S['invoices'][1009]['lines']] == [2010] and not S['invoices'][1009]['billed'], S['invoices'].get(1009))
        check('no page errors (scenario 2)', not errors, errors)
        await ctx.close()
        await browser.close()

    print('\n%d failed' % len(FAILS) if FAILS else '\nAll passed')
    sys.exit(1 if FAILS else 0)

asyncio.run(main())
