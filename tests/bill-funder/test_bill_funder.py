"""
Test for Bill funder, against a mock Halaxy with one invented patient whose invoices cover every rule.

Checks: which fees are suggested and ticked (past attended fees in the last 6 months, same claim,
unbilled, not Issued in the cogwheel; DNA and £0 fees listed but not ticked, with the appointment comment; future,
old, other-claim and billed fees left out); nothing changes before confirming; fees are merged first
onto an invoice that holds only chosen fees, then the funder is invoiced once as a NEW organisation
invoice (never the existing one Halaxy pre-selects); the merged invoice is marked Issued through the
cogwheel settings form with every other field unchanged; the result is checked and reported.

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


def fresh(extra_line_on_latest=False, refuse_status=False, broken_merge=False):
    S = {'invoices': {}, 'calls': [], 'calls_read': [], 'next_org': 9001, 'refuse_status': refuse_status, 'broken_merge': broken_merge}
    def inv(iid, days, status='', note='', claim=CLAIM, billed=False, amount=4000, ref=None, lines=None, inv_status=''):
        day = d(days)
        S['invoices'][iid] = {'id': iid, 'claim': claim, 'billed': billed, 'ref': ref, 'status': inv_status,
                              'lines': lines or [{'lineId': iid + 1000, 'appt': iid + 2000, 'day': day, 'amount': amount, 'status': status, 'note': note}]}
    inv(1001, 60, ref=(1, 5))
    inv(1002, 45, status='did-not-attend', note='Late cancellation. | Bill Bupa? Check policy first.')
    inv(1003, 30, ref=(2, 5))
    inv(1004, -20)                         # future booking
    inv(1005, 240)                         # older than 6 months
    inv(1006, 25, claim=OTHER_CLAIM)       # another claim
    inv(1007, 20, billed=True)             # already billed to the funder
    inv(1008, 15, amount=0)                # £0 fee
    inv(1009, 10, ref=(6, 5))              # beyond the authorisation
    inv(1010, 35, inv_status='issued')     # Issued in the cogwheel, not yet billed
    if extra_line_on_latest:               # latest invoice also holds an unticked DNA fee
        S['invoices'][1009]['lines'].append({'lineId': 2099, 'appt': 3099, 'day': d(9), 'amount': 4000, 'status': 'did-not-attend', 'note': 'No show'})
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
            "<div id='card-invoice-view-patient'><a class='ajax' id='invoicePatientEditLink' href='/a/magic/add/patient/9%d/invoice'>Edit</a><a href='/a/pr/555/patient/%d'>Patient Test</a></div>"
            "<div id='card-invoice-parts-claim-view'><a href='/a/pr/555/organisation/7364'>Bupa Healthcare</a>"
            "<a id='editClaimButton' href='/a/pr/555/patient/claim/18874/%d/%d/edit?invoice=%d'>e</a>%s</div>"
            "<table id='invoiceLines'><tbody>%s<tr class='totals'><td>Total</td><td>£ 0.00</td><td>%s</td></tr></tbody></table>"
            "<table id='invoicePayments'><tbody>%s</tbody></table></div></body></html>") % (iid, PATIENT, PATIENT, PATIENT, inv['claim'], iid, ref, lines, gbp(total), pay)


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


SETTINGS_FIXED = [('form[prefix]', 'UPC-'), ('form[number]', None), ('form[suffix]', ''), ('form[issuerType]', '2'), ('form[displayDate]', '05-Nov-2026'),
                  ('form[dueDate]', ''), ('form[template]', '75272'), ('form[type]', ''), ('form[payer]', '33'), ('form[relatedLinkPaG]', ''),
                  ('form[showOrganisationPatientDetails]', '1'), ('form[_token]', 'TOKEN-%d')]


def settings_popup(iid):
    st = S['invoices'][iid]['status'] if iid in S['invoices'] else ''
    opts = ''.join("<option value='%s'%s>%s</option>" % (v, ' selected' if v == st else '', n) for v, n in [('', 'Active'), ('issued', 'Issued'), ('deleted', 'Deleted'), ('write-off', 'Write-off')])
    return ("<form name='form' method='post' id='frmInvoiceType'><input type='text' name='form[prefix]' value='UPC-'><input type='number' name='form[number]' value='%d'>"
            "<input type='text' name='form[suffix]'><select name='form[issuerType]'><option value='1'>A</option><option value='2' selected>B</option></select>"
            "<select name='form[status]' required>%s</select><input type='text' name='form[displayDate]' value='05-Nov-2026'><input type='text' name='form[dueDate]'>"
            "<select name='form[template]'><option value='23876'>A</option><option value='75272' selected>C</option></select>"
            "<select name='form[type]'><option value='' selected>Invoice</option><option value='quote'>Quote</option></select>"
            "<select name='form[payer]'><option value='33' selected>Patient</option><option value='34'>Organisation</option></select>"
            "<select name='form[relatedLinkPaG]'><option value=''></option><option value='4031012'>X</option></select>"
            "<input type='radio' name='form[showOrganisationPatientDetails]' value='1' checked><input type='radio' name='form[showOrganisationPatientDetails]' value='2'>"
            "<input type='hidden' name='form[_token]' value='TOKEN-%d'>"
            "<a class='ajax merge-invoices' href='/a/pr/555/invoice/%d/group' id='mergeInvoices'>Merge</a>"
            "<button id='invoiceOptionsSubmitBtn' type='submit'>Save</button></form>") % (iid, opts, iid, iid)


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
        ev = [{'id': l['appt'], 'type': 'appointment', 'appointmentStatus': l['status'], 'note': None} for inv in S['invoices'].values() for l in inv['lines']]   # as live: empty
        return await js({'status': 'OK', 'payload': {'events': ev}})
    m = re.search(r'/appointment/(\d+)$', p)
    if m:
        appt = int(m.group(1))
        S['calls_read'].append(('appointment', appt))
        line = next((l for inv in S['invoices'].values() for l in inv['lines'] if l['appt'] == appt), None)
        if req.headers.get('x-requested-with') != 'XMLHttpRequest':   # as live: the plain page has no details
            return await route.fulfill(body='<html><body><div id="page"></div></body></html>', content_type='text/html')
        notes = ''.join('%s<br>' % part for part in (line['note'].split(' | ') if line and line['note'] else []))
        body = ('<div class="appointment-details-popup"><div class="row pb-1"><div class="col-12 p-1"><div class="subTitle p-2">Details</div><div class="px-2">Booked</div></div></div>'
                '<div class="row pb-1"><div class="col-12 p-1"><div class="subTitle p-2 border-top">Notes</div><div class="px-2">%s</div></div></div></div>') % notes
        return await route.fulfill(body=body, content_type='text/html')
    m = re.search(r'/invoice/(\d+)/group$', p)
    if m:
        target = int(m.group(1))
        if req.method == 'GET':
            return await js({'status': 'VIEW', 'title': 'Merge invoice fees', 'message': '<form></form>' if S['broken_merge'] else merge_popup(target)})
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
    m = re.search(r'/invoice/options/(\d+)$', p)
    if m:
        iid = int(m.group(1))
        if req.method == 'GET':
            return await js({'status': 'FORM', 'title': 'Invoice Settings', 'message': settings_popup(iid)})
        S['calls'].append(('status', iid, form.get('form[status]', [''])[0], {k: v[0] for k, v in form.items()}))
        if not S['refuse_status']:
            S['invoices'][iid]['status'] = form.get('form[status]', [''])[0]
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


async def open_panel(browser, iid, wait='tbody'):
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
    root = "document.querySelector('[data-upc-bill-funder]')"
    await pg.wait_for_function(root + ".querySelector('" + wait + "')", timeout=60000)
    return ctx, pg, root, btn, errors


async def main():
    global S
    async with async_playwright() as p:
        browser = await p.chromium.launch()

        # Scenario 1: the full rule set, then merge and bill
        ctx, pg, root, btn, errors = await open_panel(browser, 1003)
        check('Bill funder button sits next to Halaxy\'s Invoice Funder', btn == 'invoiceFunderBtn', btn)
        look = await pg.evaluate("""(() => { const d = document.querySelector('[data-upc-bill-funder]'); const b = document.getElementById('upcBillFunderBtn');
          return { btn: b.className, shadow: !!d.shadowRoot, native: d.classList.contains('upc-native'),
            parts: ['.modal-dialog', '.modal-content', '.modal-header .modal-title', '.modal-body', 'table.table'].every((q) => d.querySelector(q)),
            buttons: [...d.querySelectorAll('.upc-actions button')].map((x) => x.className), dates: [...d.querySelectorAll('tbody tr td:nth-child(2)')].map((x) => x.textContent), amounts: [...d.querySelectorAll('tbody td.number')].map((x) => x.textContent),
            behaviour: !!d.querySelector('.ajax, .btn-submit, .btn-cancel, .bootbox, .datepicker, .popoverTarget') || d.classList.contains('modal'),
            css: (document.getElementById('upc-native-css') || {}).textContent || '' }; })()""")
        check('page button styled like Invoice Funder', look['btn'] == 'btn btn-outline-primary-light ml-1', look['btn'])
        check('pop-up built from Halaxy\'s own classes, in the page', look['native'] and look['parts'] and not look['shadow'], look)
        check('pop-up buttons are Halaxy buttons', look['buttons'] == ['btn btn-outline-primary', 'btn btn-primary'], look['buttons'])
        check('no Halaxy behaviour classes used', not look['behaviour'])
        check('dates and amounts written as Halaxy writes them', all(re.fullmatch(r'\d\d-[A-Z][a-z]{2}-\d{4}', x) for x in look['dates']) and all(x.startswith('£ ') for x in look['amounts']), (look['dates'], look['amounts']))
        rules = [r.split('{')[0].strip() for r in look['css'].split('}') if '{' in r]
        check('our styles only touch our own elements', rules and all(all(x.strip().startswith(('.upc-native', '.upc-dialog')) for x in r.split(',')) for r in rules), [r for r in rules if not r.startswith(('.upc-native', '.upc-dialog'))])
        rows = await pg.evaluate("[..." + root + ".querySelectorAll('tbody tr')].map(r => ({ inv: r.querySelector('a').textContent, ticked: r.querySelector('input').checked, text: r.innerText.replace(/\\s+/g, ' ') }))")
        by = {r['inv']: r for r in rows}
        check('suggests past, unbilled, same-claim fees in the last 6 months', sorted(by) == ['UPC-1001', 'UPC-1002', 'UPC-1003', 'UPC-1008', 'UPC-1009'], sorted(by))
        check('attended fees ticked', by['UPC-1001']['ticked'] and by['UPC-1003']['ticked'] and by['UPC-1009']['ticked'])
        check('did-not-attend listed but not ticked, with its comment', not by['UPC-1002']['ticked'] and 'did not attend' in by['UPC-1002']['text'] and 'Late cancellation.' in by['UPC-1002']['text'] and 'Bill Bupa? Check policy first.' in by['UPC-1002']['text'], by['UPC-1002'])
        note_lines = await pg.evaluate("[...document.querySelectorAll('[data-upc-bill-funder] .upc-note')].map((n) => n.innerText)")
        check('comment keeps its line breaks', any(n.split('\n') == ['Late cancellation.', 'Bill Bupa? Check policy first.'] for n in note_lines), note_lines)
        reads = [c for c in S['calls_read'] if c[0] == 'appointment']
        check('details read only for cancelled or did-not-attend fees', reads == [('appointment', 3002)], reads)
        check('£0 fee listed but not ticked', not by['UPC-1008']['ticked'] and '£0 fee' in by['UPC-1008']['text'])
        check('beyond the authorisation flagged', 'Appointment 6 of 5 authorised: beyond the authorisation' in by['UPC-1009']['text'], by['UPC-1009']['text'])
        note = await pg.evaluate(root + ".textContent")
        left = await pg.evaluate("[...document.querySelectorAll('[data-upc-bill-funder] .text-muted li')].map((li) => li.textContent)")
        want = {'UPC-1004': 'future-dated', 'UPC-1005': 'older than 6 months', 'UPC-1006': 'another claim or self-funded', 'UPC-1007': 'already billed to the funder', 'UPC-1010': 'invoice is Issued'}
        check('lists each left-out invoice with its date and reason', len(left) == 5 and all(any(li.startswith(k + ', ') and re.search(r'\d\d-[A-Z][a-z]{2}-\d{4}: ' + v + '$', li) for li in left) for k, v in want.items()), left)
        check('fees on the open invoice say so', 'On this invoice' in by['UPC-1003']['text'] and 'On this invoice' not in by['UPC-1001']['text'], by['UPC-1003']['text'])
        check('button says Merge and bill when fees come from several invoices', await pg.evaluate(root + ".querySelector('[data-a=next]').textContent") == 'Merge and bill')
        check('nothing changed before confirming', S['calls'] == [], S['calls'])
        check('Issued invoice left out', 'UPC-1010' not in by and S['invoices'][1010]['status'] == 'issued')
        await pg.evaluate(root + ".querySelector('[data-a=next]').click()")
        conf = await pg.evaluate(root + ".querySelector('.upc-log').innerText")
        check('confirm step explains what will happen', 'Merge 3 fees (£ 120.00)' in conf and 'new organisation invoice' in conf, conf)
        await pg.evaluate(root + ".querySelector('[data-a=go]').click()")
        await pg.wait_for_function(root + ".querySelector('.upc-ok') || " + root + ".querySelector('.upc-log .upc-err')", timeout=60000)
        done = await pg.evaluate(root + ".textContent")
        check('merged first, onto the latest chosen invoice, then billed once, then marked Issued', [c[0] for c in S['calls']] == ['merge', 'bill', 'status'] and S['calls'][0][1] == 1009 and S['calls'][0][2] == [2001, 2003] and S['calls'][1][1] == 1009, S['calls'])
        check('billed as a NEW organisation invoice, keeping the patient invoice', S['calls'][1][2:] == ('0', 'no'), S['calls'])
        check('never used Halaxy\'s pre-selected invoice for another patient', S['orgs'][7777]['lines'] == [])
        org = S['orgs'].get(9001, {})
        check('organisation invoice holds exactly the chosen fees', sorted(l['lineId'] for l in org.get('lines', [])) == [2001, 2003, 2009], org)
        check('unticked fees left alone', 1002 in S['invoices'] and 1008 in S['invoices'] and not S['invoices'][1002]['billed'])
        st = S['calls'][2] if len(S['calls']) > 2 else ('status', None, None, {})
        check('marks the merged patient invoice Issued', st[1] == 1009 and st[2] == 'issued' and S['invoices'][1009]['status'] == 'issued', st[:3])
        sent = st[3]
        want = {k: (v if v is not None else '1009') for k, v in SETTINGS_FIXED}
        want['form[_token]'] = 'TOKEN-1009'
        check('cogwheel form sent with every other setting unchanged', all(sent.get(k) == v for k, v in want.items()), {k: (sent.get(k), v) for k, v in want.items() if sent.get(k) != v})
        check('other invoices keep their status', all(S['invoices'][i]['status'] == '' for i in (1002, 1008)))
        check('result says the invoice is marked Issued', 'UPC-1009 is marked Issued' in done, done[-300:])
        check('reports the result with the new invoice number', 'Done.' in done and 'UPC-9001' in done and '£ 120.00'.replace(' ', '') in done.replace(' ', ''), done[-300:])
        check('no page errors', not errors, errors)
        await ctx.close()

        # Only the open invoice's own fee chosen: nothing to merge, and the pop-up says so
        S = fresh()
        ctx, pg, root, btn, errors = await open_panel(browser, 1003)
        # Each tick redraws the table, so look the boxes up again after every click.
        await pg.evaluate("""(() => { for (let n = 0; n < 20; n++) {
            const c = [...document.querySelectorAll('[data-upc-bill-funder] tbody input[type=checkbox]')].find((b) => b.checked !== b.closest('tr').textContent.includes('UPC-1003'));
            if (!c) return; c.click(); } })()""")
        lbl = await pg.evaluate(root + ".querySelector('[data-a=next]').textContent")
        check('button says Bill funder when nothing needs merging', lbl == 'Bill funder', lbl)
        await pg.evaluate(root + ".querySelector('[data-a=next]').click()")
        conf = await pg.evaluate(root + ".querySelector('.upc-log').innerText")
        check('confirmation says there is nothing to merge', 'Nothing to merge' in conf and 'already on UPC-1003' in conf, conf)
        await pg.evaluate(root + ".querySelector('[data-a=go]').click()")
        await pg.wait_for_function(root + ".querySelector('.upc-ok') || " + root + ".querySelector('.upc-log .upc-err')", timeout=60000)
        check('billed without a merge', [c[0] for c in S['calls']] == ['bill', 'status'], [c[0] for c in S['calls']])
        await ctx.close()

        # Escape closes it while nothing is running
        S = fresh()
        ctx, pg, root, btn, errors = await open_panel(browser, 1003)
        await pg.keyboard.press('Escape')
        check('Escape closes the pop-up', await pg.evaluate("!document.querySelector('[data-upc-bill-funder]')"))
        await ctx.close()

        # Scenario 2: the latest invoice also holds an unticked fee -> merge onto another invoice instead
        S = fresh(extra_line_on_latest=True)
        ctx, pg, root, btn, errors = await open_panel(browser, 1003)
        await pg.evaluate(root + ".querySelector('[data-a=next]').click()")
        await pg.evaluate(root + ".querySelector('[data-a=go]').click()")
        await pg.wait_for_function(root + ".querySelector('.upc-ok') || " + root + ".querySelector('.upc-log .upc-err')", timeout=60000)
        merge = [c for c in S['calls'] if c[0] == 'merge']
        check('never merges onto an invoice holding a fee you did not tick', merge and merge[0][1] == 1003 and merge[0][2] == [2001, 2009], S['calls'])
        check('the unticked fee stays unbilled on its own invoice', [l['lineId'] for l in S['invoices'][1009]['lines']] == [2099] and not S['invoices'][1009]['billed'], S['invoices'].get(1009))
        check('no page errors (scenario 2)', not errors, errors)
        await ctx.close()

        # Scenario 3: Halaxy does not apply the status change -> billing still reported, with a warning
        S = fresh(refuse_status=True)
        ctx, pg, root, btn, errors = await open_panel(browser, 1003)
        await pg.evaluate(root + ".querySelector('[data-a=next]').click()")
        await pg.evaluate(root + ".querySelector('[data-a=go]').click()")
        await pg.wait_for_function(root + ".querySelector('.upc-ok') || " + root + ".querySelector('.upc-log .upc-err')", timeout=60000)
        done = await pg.evaluate(root + ".textContent")
        check('billing still reported when the status does not stick', 'Done.' in done and 'UPC-9001' in done, done[-300:])
        check('warns to set Issued with the cogwheel', 'could not be marked Issued' in done and 'Set it with the cogwheel' in done, done[-300:])
        check('no page errors (scenario 3)', not errors, errors)
        await ctx.close()

        # Scenario 4: a safety stop shows its own message and changes nothing
        S = fresh(broken_merge=True)
        ctx, pg, root, btn, errors = await open_panel(browser, 1003, wait='p.upc-warn')
        msg = await pg.evaluate(root + ".querySelector('p.upc-warn').textContent")
        check('safety stop shows its own message', "merge pop-up has changed" in msg and 'constructor' not in msg, msg)
        check('nothing changed after a safety stop', S['calls'] == [], S['calls'])
        await ctx.close()
        await browser.close()

    print('\n%d failed' % len(FAILS) if FAILS else '\nAll passed')
    sys.exit(1 if FAILS else 0)

asyncio.run(main())
