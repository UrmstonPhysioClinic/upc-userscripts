"""
Test for Rebate sync (on the core library's rebate steps), against a mock Halaxy with invented invoices.

Checks: changing a billed fee's rebate on the patient invoice updates the funder line (revert, rebate, re-bill to the
same funder invoice, the fee's date put back); changing a funder line's amount to £ 0.00 leaves a £ 0.00 line; a fee
not billed yet saves normally through Halaxy; Cancel changes nothing; invoices that already disagree are refused with
nothing changed; requests are paced.

Run:  python3 tests/rebate-sync/test_rebate_sync.py
"""
import asyncio, datetime, json, re, sys, time, urllib.parse
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
CORE = (ROOT / 'beta' / 'core.user.js').read_text()
SYNC = (ROOT / 'beta' / 'rebate-sync.user.js').read_text()
FAILS = []
S = {}
gbp = lambda c: '£%.2f' % (c / 100)


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)))
    if not ok:
        FAILS.append(name)


def fresh(disagree=False):
    s = {'next_line': 950, 'log': [], 'funders': {}, 'patients': {}}
    # Patient 201: one fee billed to funder invoice 101. Patient 202: a fee not billed yet.
    s['patients'][201] = {'id': 201, 'number': 'UPC-30001', 'pending': [], 'lines': [{'lineId': 901, 'date': '02-Oct-2026', 'item': 'PHY', 'fee': 6000, 'rebate': 5000 if disagree else 6000}]}
    s['patients'][202] = {'id': 202, 'number': 'UPC-30002', 'pending': [], 'lines': [{'lineId': 911, 'date': '05-Oct-2026', 'item': 'PHY', 'fee': 6000, 'rebate': 6000}]}
    s['funders'][101] = {'id': 101, 'number': 'UPC-40001', 'lines': [{'lineId': 902, 'pid': 201, 'plineId': 901, 'date': '02-Oct-2026', 'item': 'PHY', 'amount': 6000}]}
    return s


HARNESS = """<script>
document.addEventListener('click', function (e) {
  var a = e.target.closest && e.target.closest('a.edit-line');
  if (!a) return;
  e.preventDefault();
  var x = new XMLHttpRequest();
  x.open('GET', a.getAttribute('href'));
  x.onload = function () {
    var j = JSON.parse(x.responseText);
    var box = document.createElement('div');
    box.id = 'lineDlg';
    box.innerHTML = j.message.replace('</form>', "<button type='button' id='invoiceLineSaveBtn'>Save</button></form>");
    document.body.appendChild(box);
  };
  x.send();
});
// Halaxy's own Save (the normal route)
document.addEventListener('click', function (e) { if (e.target.id === 'invoiceLineSaveBtn') window.__halaxySaved = (window.__halaxySaved || 0) + 1; });
window.HkUser = { pracName: 'Carl Healy' };
</script>"""


def funder_html(f):
    rows = ''.join("<tr><td data-property='date'><a href='/a/pr/555/invoice/%d'>%s</a></td><td data-property='itemNumber'>%s</td><td data-property='amount'>%s</td>"
                   "<td><a class='edit-line' href='/a/pr/555/invoice/line/%d/edit'>Edit</a></td></tr>" % (l['pid'], l['date'], l['item'], gbp(l['amount']), l['lineId']) for l in f['lines'])
    total = sum(l['amount'] for l in f['lines'])
    return ("<html><head><title>Invoice %s | Halaxy</title></head><body><table id='invoiceLines'><tbody>%s<tr><td>Total</td><td>%s</td></tr></tbody></table>"
            "<table id='invoicePayments'><tbody><tr><td>Outstanding</td><td>%s</td></tr></tbody></table>%s</body></html>") % (f['number'], rows, gbp(total), gbp(total), HARNESS)


def patient_html(p):
    rows = ''.join("<tr><td data-property='date'>%s</td><td data-property='itemNumber'>%s</td><td data-property='amount'>%s</td>"
                   "<td><a class='edit-line' href='/a/pr/555/invoice/line/%d/edit'>Edit</a></td></tr>" % (l['date'], l['item'], gbp(l['fee']), l['lineId']) for l in p['lines'])
    pays = ''
    for f in S['funders'].values():
        for l in f['lines']:
            if l['pid'] == p['id']:
                pays += "<tr><td>%s</td><td>Invoice %s</td><td>Issued</td><td><a href='/a/pr/555/invoice/%d'>%s</a></td></tr>" % (l['date'], f['number'], f['id'], gbp(l['amount']))
    for pend in p['pending']:
        pays += "<tr><td><a data-modal-href='/a/pr/555/invoicefunctions/%d/claim/77/'>Invoice Funder</a></td><td>%s</td></tr>" % (p['id'], gbp(pend['amount']))
    billed = sum(l['amount'] for f in S['funders'].values() for l in f['lines'] if l['pid'] == p['id'])
    owed = sum(l['fee'] for l in p['lines']) - billed
    return ("<html><head><title>Invoice %s | Halaxy</title></head><body><table id='invoiceLines'><tbody>%s<tr><td>Total</td><td>%s</td></tr></tbody></table>"
            "<table id='invoicePayments'><tbody>%s<tr><td>Outstanding</td><td>%s</td></tr></tbody></table>%s</body></html>") % (
        p['number'], rows, gbp(sum(l['fee'] for l in p['lines'])), pays, gbp(owed), HARNESS)


def find_line(lid):
    for f in S['funders'].values():
        for l in f['lines']:
            if l['lineId'] == lid:
                return 'f', f, l
    for p in S['patients'].values():
        for l in p['lines']:
            if l['lineId'] == lid:
                return 'p', p, l
    return None, None, None


async def halaxy(route):
    req = route.request
    path = urllib.parse.urlparse(req.url).path
    S['log'].append((time.time(), req.method, path))
    js = lambda o: route.fulfill(body=json.dumps(o), content_type='application/json')
    form = dict(urllib.parse.parse_qsl(req.post_data or '', keep_blank_values=True)) if req.method == 'POST' else {}
    m = re.search(r'/invoice/line/(\d+)/edit$', path)
    if m:
        kind, owner, line = find_line(int(m.group(1)))
        if req.method == 'GET':
            fee, reb = (line['fee'], line['rebate']) if kind == 'p' else (line['amount'], 0)
            return await js({'status': 'FORM', 'message': "<form id='invoiceLineForm'><input name='form[date]' value='%s'><input name='form[amount]' value='%.2f'><input name='form[rebate]' value='%.2f'>"
                                                          "<input name='form[feeItemNumber]' value='PHY'><input name='form[comment]' value=''><input name='form[_token]' value='tok-line'></form>" % (line['date'], fee / 100, reb / 100)})
        assert form.get('form[_token]') == 'tok-line', form
        S.setdefault('edits', []).append((int(m.group(1)), form))
        if kind != 'p':
            line['date'] = form['form[date]']
            return await js({'status': 'REFRESH'})
        line['rebate'] = round(float(form['form[rebate]']) * 100)
        line['fee'] = round(float(form['form[amount]']) * 100)
        for pend in owner['pending']:
            if pend['plineId'] == line['lineId']:
                pend['amount'] = line['rebate']
        return await js({'status': 'REFRESH'})
    m = re.search(r'/invoice/line/(\d+)/remove$', path)
    if m:
        lid = int(m.group(1))
        return await js({'status': 'FORM', 'message': "<form id='formInvoiceLineDelete'></form><script>switch (a) { case 'void': url = \"/a/pr/555/invoice/line/%d/void/x\"; break; "
                                                      "case 'delete': url = \"/a/pr/555/invoice/line/%d/delete/ab12cd\"; break; }</script>" % (lid, lid)})
    m = re.search(r'/invoice/line/(\d+)/delete/ab12cd$', path)
    if m:
        kind, f, line = find_line(int(m.group(1)))
        f['lines'].remove(line)
        S['patients'][line['pid']]['pending'].append({'amount': line['amount'], 'plineId': line['plineId'], 'date': line['date']})
        return await js({'status': 'REFRESH'})
    m = re.search(r'/invoicefunctions/(\d+)/claim/77/?$', path)
    if m:
        p = S['patients'][int(m.group(1))]
        if req.method == 'GET':
            radios = ''.join("<input type='radio' name='form[orgInvoice]' value='%d'>" % fid for fid in S['funders'])
            return await js({'status': 'FORM', 'message': "<form id='organisationBillForm'>%s</form>" % radios})
        fid = int(form['form[orgInvoice]'])
        pend = p['pending'].pop(0)
        S['next_line'] += 1
        slipped = (datetime.datetime.strptime(pend['date'], '%d-%b-%Y') + datetime.timedelta(days=1)).strftime('%d-%b-%Y')   # Halaxy slips the date
        S['funders'][fid]['lines'].append({'lineId': S['next_line'], 'pid': p['id'], 'plineId': pend['plineId'], 'date': slipped, 'item': 'PHY', 'amount': pend['amount']})
        return await js({'status': 'REFRESH'})
    m = re.search(r'/invoice/(?:\d+/)?(\d+)/?$', path)
    if m and req.method == 'GET':
        i = int(m.group(1))
        if i in S['funders']:
            return await route.fulfill(body=funder_html(S['funders'][i]), content_type='text/html')
        if i in S['patients']:
            return await route.fulfill(body=patient_html(S['patients'][i]), content_type='text/html')
    await route.fulfill(status=404, body='not mocked')


async def context(browser):
    ctx = await browser.new_context(viewport={'width': 1300, 'height': 900})
    await ctx.route('https://eu.halaxy.com/**', halaxy)
    await ctx.add_init_script(CORE)
    await ctx.add_init_script(SYNC)
    return ctx


async def edit(pg, line, field, value):
    await pg.click("a.edit-line[href$='/line/%d/edit']" % line)
    await pg.wait_for_selector('#invoiceLineForm #invoiceLineSaveBtn')
    await pg.fill("#invoiceLineForm input[name='form[%s]']" % field, value)
    await pg.click('#invoiceLineSaveBtn')


DLG = '.upc-dialog, [data-upc-dialog]'


async def dialog_text(pg):
    await pg.wait_for_function("[...document.querySelectorAll('.modal-title')].some((t) => t.textContent.trim())", timeout=20000)
    return await pg.evaluate("[...document.querySelectorAll('.modal-content')].map((m) => m.textContent.replace(/\\s+/g, ' ')).join(' | ')")


async def press(pg, label):
    await pg.click("xpath=//button[normalize-space()='%s']" % label)


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()

        # 1. Patient invoice: rebate 60.00 -> 45.00
        S.clear(); S.update(fresh())
        ctx = await context(browser)
        pg = await ctx.new_page()
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        await pg.goto('https://eu.halaxy.com/a/pr/555/invoice/201')
        await edit(pg, 901, 'rebate', '45.00')
        txt = await dialog_text(pg)
        check('asks first, showing both invoices', 'Update both invoices?' in txt and 'UPC-30001' in txt and 'UPC-40001' in txt and '£ 45.00' in txt, txt)
        n_before = len([x for x in S['log'] if x[1] == 'POST' or '/delete/' in x[2]])
        check('nothing changed before confirming', n_before == 0, S['log'])
        await press(pg, 'Update both')
        await pg.wait_for_function("document.body.textContent.includes('Done.') || !!document.querySelector('.upc-err')", timeout=60000)
        txt = await pg.evaluate("document.body.textContent")
        f = S['funders'][101]['lines']
        check('done, without an error', 'Done.' in txt and not await pg.evaluate("!!document.querySelector('.upc-err')"), txt[-300:])
        check('funder line now £ 45.00, on the fee\'s own date', len(f) == 1 and f[0]['amount'] == 4500 and f[0]['date'] == '02-Oct-2026', f)
        check('patient rebate £ 45.00, nothing left waiting to bill', S['patients'][201]['lines'][0]['rebate'] == 4500 and not S['patients'][201]['pending'], S['patients'][201])
        # The script's own requests: from the plan (after Halaxy's page load and its own edit pop-up) onwards.
        first = next(i for i, x in enumerate(S['log']) if x[1] == 'GET' and re.search(r'/invoice/101$', x[2]))
        api = [t for t, m, pth in S['log'][first:] if pth.startswith('/a/pr/')]
        gaps = [round(b - a, 3) for a, b in zip(api, api[1:])]
        check('requests paced by the core library (at least 0.25 s apart)', gaps and min(gaps) >= 0.25, gaps)
        check('no page errors', not errors, errors)
        await ctx.close()

        # 2. Funder invoice: line 60.00 -> 0.00 leaves a £ 0.00 line
        S.clear(); S.update(fresh())
        ctx = await context(browser)
        pg = await ctx.new_page()
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/invoice/201/101')
        await edit(pg, 902, 'amount', '0.00')
        await dialog_text(pg)
        await press(pg, 'Update both')
        await pg.wait_for_function("document.body.textContent.includes('Done.') || !!document.querySelector('.upc-err')", timeout=60000)
        f = S['funders'][101]['lines']
        check('funder line set to £ 0.00: a £ 0.00 line stays (never a missing one)', len(f) == 1 and f[0]['amount'] == 0 and f[0]['date'] == '02-Oct-2026', f)
        check('patient rebate £ 0.00', S['patients'][201]['lines'][0]['rebate'] == 0, S['patients'][201])
        await ctx.close()

        # 3. A fee not billed yet: Halaxy's normal save
        S.clear(); S.update(fresh())
        ctx = await context(browser)
        pg = await ctx.new_page()
        await pg.goto('https://eu.halaxy.com/a/pr/555/invoice/202')
        await edit(pg, 911, 'rebate', '45.00')
        await pg.wait_for_function("window.__halaxySaved >= 1", timeout=20000)
        check('not billed yet: Halaxy saves it as usual, nothing else done', not [x for x in S['log'] if '/remove' in x[2] or x[1] == 'POST'], S['log'])
        await ctx.close()

        # 4. Cancel
        S.clear(); S.update(fresh())
        ctx = await context(browser)
        pg = await ctx.new_page()
        await pg.goto('https://eu.halaxy.com/a/pr/555/invoice/201')
        await edit(pg, 901, 'rebate', '45.00')
        await dialog_text(pg)
        await press(pg, 'Cancel')
        await pg.wait_for_timeout(800)
        check('Cancel: nothing changed', not [x for x in S['log'] if '/remove' in x[2] or x[1] == 'POST'] and S['funders'][101]['lines'][0]['amount'] == 6000 and not await pg.evaluate("window.__halaxySaved || 0"), S['log'])
        await ctx.close()

        # 5. Invoices already disagree: refused
        S.clear(); S.update(fresh(disagree=True))
        ctx = await context(browser)
        pg = await ctx.new_page()
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/invoice/201/101')
        await edit(pg, 902, 'amount', '45.00')
        txt = await dialog_text(pg)
        check('invoices already disagree: not saved, says why, nothing changed', 'Not saved' in txt and 'disagree' in txt and not [x for x in S['log'] if '/remove' in x[2] or x[1] == 'POST'], (txt, S['log']))
        await ctx.close()
        await browser.close()
    print('\n%d failed' % len(FAILS) if FAILS else '\nAll passed')
    sys.exit(1 if FAILS else 0)

asyncio.run(main())
