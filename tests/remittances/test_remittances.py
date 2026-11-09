"""
Test for Remittances and the core library, against a mock Halaxy and invented remittances.

Checks: the four layouts are read (typed and scanned) and cross-checked against their totals;
each invoice is matched and classified; applying an excess fix runs revert, rebate and re-bill
and leaves both invoices right; the remittance is attached to every matched invoice with the
Payment category; no payment is ever recorded; requests are paced; Halaxy saying "busy" pauses
the scripts.

Run:  python3 tests/remittances/test_remittances.py
Needs: Python 3 with Playwright (Chromium), reportlab and Pillow; npm (installs the PDF and text
recognition libraries into tests/remittances/node_modules on first run).
"""
import datetime
import asyncio, json, re, subprocess, sys, time, urllib.parse
from pathlib import Path
from playwright.async_api import async_playwright

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
import make_fixtures  # noqa: E402

if not (HERE / 'node_modules' / 'tesseract.js').exists():
    subprocess.run(['npm', 'install', '--no-audit', '--no-fund', '--no-package-lock', '--silent'], cwd=HERE, check=True)
LIBS = HERE / 'node_modules'
CORE = (ROOT / 'beta' / 'core.user.js').read_text()
REMIT = (ROOT / 'beta' / 'remittances.user.js').read_text()
PG = '555'

# ------------------------------------------------------------------ mock Halaxy

def fresh_state():
    s = {'next_line': 900, 'funders': {}, 'patients': {}, 'attachments': {}, 'log': [], 'busy_once': False, 'slip': {}, 'tasks': {}}
    def add(fid, num, pid, pnum, dates, amount=6000):
        s['funders'][fid] = {'id': fid, 'number': num, 'lines': []}
        s['patients'][pid] = {'id': pid, 'number': pnum, 'lines': [], 'pending': []}
        for d in dates:
            s['next_line'] += 1
            pl = s['next_line']
            s['next_line'] += 1
            fl = s['next_line']
            s['patients'][pid]['lines'].append({'lineId': pl, 'date': s['slip'].get((pid, d), d), 'item': 'PHY', 'fee': amount, 'rebate': amount})
            s['funders'][fid]['lines'].append({'lineId': fl, 'pid': pid, 'plineId': pl, 'date': d, 'item': 'PHY', 'amount': amount})
    # Halaxy's date slip, as seen live 9 Nov 2026: patient 202's 01-Oct fee was copied onto the funder
    # invoice (and so billed and paid by the insurer) as 02-Oct.
    s['slip'] = {(202, '02-Oct-2026'): '01-Oct-2026'}
    add(101, 'UPC-40001', 201, 'UPC-30001', ['01-Oct-2026'])
    add(102, 'UPC-40002', 202, 'UPC-30002', ['02-Oct-2026', '09-Oct-2026', '16-Oct-2026'])
    add(103, 'UPC-40003', 203, 'UPC-30003', ['02-Oct-2026'])
    return s

S = fresh_state()
gbp = lambda c: '£%.2f' % (c / 100)


def funder_html(f):
    rows = ''.join("<tr><td data-property='date'><a href='/a/pr/%s/invoice/%d'>%s</a></td><td data-property='itemNumber'>%s</td>"
                   "<td data-property='amount'>%s</td><td><a href='/a/pr/%s/invoice/line/%d/edit'>Edit</a> <a href='/a/pr/%s/invoice/line/%d/remove'>Remove</a></td></tr>"
                   % (PG, l['pid'], l['date'], l['item'], gbp(l['amount']), PG, l['lineId'], PG, l['lineId']) for l in f['lines'])
    total = sum(l['amount'] for l in f['lines'])
    att = ''.join('<tr><td>%s</td></tr>' % a['title'] for a in S['attachments'].get(f['id'], []))
    return ("<html><head><title>Invoice %s | Halaxy</title></head><body><table id='invoiceLines'><tbody>%s<tr><td>Total</td><td>%s</td></tr></tbody></table>"
            "<table id='invoicePayments'><tbody><tr><td>Outstanding</td><td>%s</td></tr></tbody></table>"
            "<table id='invoiceAttachments'><tbody>%s</tbody></table></body></html>") % (f['number'], rows, gbp(total), gbp(total), att)


def patient_html(p):
    rows = ''.join("<tr><td data-property='date'>%s</td><td data-property='itemNumber'>%s</td><td data-property='amount'>%s</td>"
                   "<td><a href='/a/pr/%s/invoice/line/%d/edit'>Edit</a></td></tr>" % (l['date'], l['item'], gbp(l['fee']), PG, l['lineId']) for l in p['lines'])
    pays = ''
    for f in S['funders'].values():
        for l in f['lines']:
            if l['pid'] == p['id']:
                pays += "<tr><td>%s</td><td>Invoice %s</td><td>Issued</td><td><a href='/a/pr/%s/invoice/%d'>%s</a></td></tr>" % (l['date'], f['number'], PG, f['id'], gbp(l['amount']))
    for i, amt in enumerate(p['pending']):
        pays += "<tr><td><a data-modal-href='/a/pr/%s/invoicefunctions/%d/claim/77/'>Invoice Funder</a></td><td>%s</td></tr>" % (PG, p['id'], gbp(amt['amount']))
    owed = sum(l['fee'] for l in p['lines']) - sum(l['amount'] for f in S['funders'].values() for l in f['lines'] if l['pid'] == p['id'])
    return ("<html><head><title>Invoice %s | Halaxy</title></head><body><table id='invoiceLines'><tbody>%s<tr><td>Total</td><td>%s</td></tr></tbody></table>"
            "<table id='invoicePayments'><tbody>%s<tr><td>Outstanding</td><td>%s</td></tr></tbody></table></body></html>") % (
            p['number'], rows, gbp(sum(l['fee'] for l in p['lines'])), pays, gbp(owed))


PAGE = ("<!doctype html><html><head><title>Finance report | Halaxy</title><script>window.Hk = { jwt: 'jwt-test' };</script>"
        "<style>body{margin:0;background:#fff;font:14px sans-serif} #side{position:fixed;left:0;top:0;bottom:0;width:218px;background:#222;z-index:1000}"
        "#top{position:fixed;left:218px;right:0;top:0;height:55px;background:#eee;z-index:500} #footer{position:fixed;left:218px;right:0;bottom:0;height:34px;background:#ddd}"
        "#main{margin-left:218px;padding-top:55px}</style></head><body>"
        "<nav id='side'><ul id='mainMenu'><li class='mainmenu-item active'><a class='mainmenu-link'><span class='mainmenu-link-label'>Reports</span></a>"
        "<ul><li class='active'><a class='mainmenu-sublink active' href='/a/pr/555/report/finance/'>Finance</a></li><li><a class='mainmenu-sublink' href='/a/pr/555/report/patient/'>Patient</a></li></ul></li></ul></nav>"
        "<div id='top'><input placeholder='Search by patient name / email / phone / patient number' style='width:60%'></div>"
        "<div id='main'><h1 id='halaxy-title'>Finance reports</h1><div id='halaxy-banner' style='background:#bcd;padding:20px'>After you create a report...</div>"
        "<div id='toolbar-text'></div><div id='pageContent'><p id='halaxy-content'>Halaxy report form</p></div></div>"
        "<div id='footer'>COPYRIGHT</div></body></html>")
ATTACH_POPUP = ("<div id='multi-file-upload-content'><form method='post' class='file-upload'></form>"
                "<form name='form' method='post' id='fileupload' class='js-file-edit-form' data-upload-url='/api/v2/practitioner/file/upload/files?_locale=1'>"
                "<input type='hidden' id='form__token' name='form[_token]' value='tok-attach'></form></div>")


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
    u = urllib.parse.urlparse(req.url)
    path = u.path
    S['log'].append((time.time(), req.method, path))
    js = lambda o, status=200: route.fulfill(status=status, body=json.dumps(o), content_type='application/json')
    form = dict(urllib.parse.parse_qsl(req.post_data or '', keep_blank_values=True)) if req.method == 'POST' and 'urlencoded' in (req.headers.get('content-type') or '') else {}

    if path.endswith('/busy-test'):
        return await js({}, 429)
    if path.endswith('/invoice/list-data') and req.method == 'POST':
        q = json.loads(req.post_data)['filterModel']['serverQuickFilter']['filter']
        rows = [{'id': f['id'], 'invoiceNum': f['number'], 'total': sum(l['amount'] for l in f['lines']) / 100} for f in S['funders'].values() if q in f['number']]
        return await js({'rowData': rows, 'lastRow': len(rows)})
    m = re.search(r'/file/upload/invoice/(\d+)$', path)
    if m:
        i = int(m.group(1))
        if req.method == 'GET':
            return await js({'status': 'FORM', 'message': ATTACH_POPUP})
        assert form.get('form[_token]') == 'tok-attach' and form.get('form[files][0][fileEntity]') == '9001', form
        S['attachments'].setdefault(i, []).append({'title': form['form[files][0][title]'], 'category': form['form[files][0][invoiceCategory]'], 'comments': form['form[files][0][invoiceComments]']})
        return await js({'status': 'REFRESH'})
    m = re.search(r'/task/invoice/(\d+)/list-data$', path)
    if m:
        return await js([{'id': i, 'title': t['form[title]'], 'status': 'Open'} for i, t in enumerate(S['tasks'].get(int(m.group(1)), []))])
    m = re.search(r'/task/new/invoice/(\d+)$', path)
    if m:
        iid = int(m.group(1))
        if req.method == 'GET':
            staff = ''.join("<option value='%d'>%s</option>" % (v, n) for v, n in [(31, 'Carl Healy'), (32, 'Diana Satalova'), (36, 'Wendy Pritchard')])
            form_html = ("<form id='form_task_edit' name='form' method='post'><input name='form[title]' value=''><select name='form[taskTemplates]'><option value=''></option><option>Check payment</option></select>"
                         "<input type='radio' name='form[actionerType]' value='1' checked><select name='form[linkPrGs][]' multiple>%s</select>"
                         "<input type='radio' name='form[priority]' value='1'><input type='radio' name='form[priority]' value='2' checked><input type='radio' name='form[priority]' value='3'>"
                         "<input name='form[displayDueDate]' value=''><select name='form[displayDueTime][hour]'><option value='0' selected>00</option></select>"
                         "<select name='form[displayDueTime][minute]'><option value='0' selected>00</option></select><input type='hidden' name='form[isTimeSet]' value='false'>"
                         "<textarea name='form[comment]'></textarea><input type='hidden' name='form[_token]' value='tok-task'></form>") % staff
            return await js({'status': 'FORM', 'title': 'Add task for invoice', 'message': form_html})
        assert form.get('form[_token]') == 'tok-task', form
        S['tasks'].setdefault(iid, []).append({k: form.get(k) for k in form})
        S['task_posts'] = S.get('task_posts', 0) + 1
        return await js({'status': 'POPUP', 'url': '/a/pr/%s/task/list/invoice/%d' % (PG, iid), 'modalSize': 'xl'})
    m = re.search(r'/invoice/(\d+)/?$', path)
    if m and req.method == 'GET':
        i = int(m.group(1))
        if i in S['funders']:
            return await route.fulfill(body=funder_html(S['funders'][i]), content_type='text/html')
        if i in S['patients']:
            return await route.fulfill(body=patient_html(S['patients'][i]), content_type='text/html')
        return await route.fulfill(status=404, body='no')
    m = re.search(r'/invoice/line/(\d+)/edit$', path)
    if m:
        kind, owner, line = find_line(int(m.group(1)))
        if req.method == 'GET':
            fee, reb = (line['fee'], line['rebate']) if kind == 'p' else (line['amount'], 0)
            return await js({'status': 'FORM', 'message': "<form id='invoiceLineForm'><input name='form[date]' value='%s'><input name='form[amount]' value='%.2f'><input name='form[rebate]' value='%.2f'>"
                                                          "<input name='form[feeItemNumber]' value='PHY'><input name='form[_token]' value='tok-line'></form>" % (line['date'], fee / 100, reb / 100)})
        assert form.get('form[_token]') == 'tok-line', form
        if kind != 'p':
            S['linedates'] = S.get('linedates', 0) + 1
            line['date'] = form['form[date]']
            return await js({'status': 'REFRESH'})
        line['rebate'] = round(float(form['form[rebate]']) * 100)
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
        S['patients'][line['pid']]['pending'].append({'amount': line['amount'], 'plineId': line['plineId'], 'date': line['date'], 'fid': f['id']})
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
        slipped = (datetime.datetime.strptime(pend['date'], '%d-%b-%Y') + datetime.timedelta(days=1)).strftime('%d-%b-%Y')   # Halaxy slips the re-billed line too
        S['funders'][fid]['lines'].append({'lineId': S['next_line'], 'pid': p['id'], 'plineId': pend['plineId'], 'date': slipped, 'item': 'PHY', 'amount': pend['amount']})
        return await js({'status': 'REFRESH'})
    if path.endswith('/practitioner/file/upload/files'):
        ok = req.headers.get('authorization') == 'Bearer jwt-test' and 'name="file"' in (req.post_data_buffer or b'').decode('latin-1')
        return await js({'files': [{'id': '9001'}]} if ok else {'files': [{'error': 'bad upload'}]})
    if '/pay' in path:
        S['log'].append((time.time(), 'PAYMENT', path))
        return await js({'status': 'OK'})
    await route.fulfill(body=PAGE, content_type='text/html')


async def cdn(route):
    path = route.request.url.split('cdn.jsdelivr.net/npm/')[1].split('?')[0]
    if path.startswith('@'):
        scope, rest = path[1:].split('/', 1)
        name, _, sub = rest.partition('/')
        pkg = '@' + scope + '/' + name.split('@')[0]
    else:
        name, _, sub = path.partition('/')
        pkg = name.split('@')[0]
    f = LIBS / pkg / sub
    if not f.is_file():
        return await route.fulfill(status=404, body='not found')
    ct = {'.js': 'application/javascript', '.wasm': 'application/wasm'}.get(f.suffix, 'application/octet-stream')
    await route.fulfill(body=f.read_bytes(), content_type=ct, headers={'Access-Control-Allow-Origin': '*'})


FAILS = []
def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)[:600]))
    if not ok:
        FAILS.append(name)


async def main():
    tmp = HERE / '.fixtures'
    tmp.mkdir(exist_ok=True)
    pdfs = {}
    for n in ('wpa', 'bupa', 'axa', 'aviva'):
        pdfs[n] = tmp / (n + '.pdf')
        pdfs[n].write_bytes(getattr(make_fixtures, n)())

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={'width': 1300, 'height': 900})
        await ctx.route('https://eu.halaxy.com/**', halaxy)
        await ctx.route('https://cdn.jsdelivr.net/**', cdn)
        await ctx.add_init_script(CORE)
        await ctx.add_init_script("document.addEventListener('DOMContentLoaded', function () {\n" + REMIT + "\n});")
        pg = await ctx.new_page()
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        await pg.goto('https://eu.halaxy.com/a/pr/555/report/finance/')
        await pg.wait_for_timeout(500)

        menu = await pg.evaluate("[...document.querySelectorAll('#mainMenu a.mainmenu-sublink')].map(a => a.textContent + ' ' + a.getAttribute('href'))")
        check('menu item added under Reports', 'Remittances /a/pr/555/report/finance/#upc-remittances' in menu, menu)
        await pg.click('text=Remittances')
        await pg.wait_for_timeout(300)
        cover = await pg.evaluate("""() => {
            const page = document.querySelector('[data-upc-page]');
            const at = (el) => { const r = el.getBoundingClientRect(); return document.elementFromPoint(r.left + 20, r.top + r.height / 2); };
            return {
                title: page.contains(at(document.getElementById('halaxy-title'))),
                banner: page.contains(at(document.getElementById('halaxy-banner'))),
                menu: document.getElementById('side').contains(document.elementFromPoint(100, 300)),
                top: document.getElementById('top').contains(document.elementFromPoint(800, 20)),
                footer: document.getElementById('footer').contains(document.elementFromPoint(800, window.innerHeight - 10)),
                financeActive: document.querySelector('a[href="/a/pr/555/report/finance/"]:not(.upc-remit-menu)').classList.contains('active'),
                ourActive: document.querySelector('.upc-remit-menu').classList.contains('active'),
                title2: document.title };
        }""")
        check('page covers Halaxy\'s title, banner and controls underneath', cover['title'] and cover['banner'], cover)
        check('side menu, top bar and footer stay visible', cover['menu'] and cover['top'] and cover['footer'], cover)
        check('menu highlights Remittances, not Finance', cover['ourActive'] and not cover['financeActive'] and cover['title2'] == 'Remittances | Halaxy', cover)
        lit = await pg.evaluate("[...document.querySelectorAll('#mainMenu ul .active')].map(n => n.tagName + ':' + n.textContent.trim())")
        check('only Remittances is highlighted (link and its line)', sorted(lit) == ['A:Remittances', 'LI:Remittances'], lit)
        await pg.evaluate("location.hash = ''")
        await pg.wait_for_timeout(200)
        lit = await pg.evaluate("[...document.querySelectorAll('#mainMenu ul .active')].map(n => n.tagName + ':' + n.textContent.trim())")
        check('leaving the page puts Halaxy\'s highlight back', sorted(lit) == ['A:Finance', 'LI:Finance'], lit)
        await pg.click('text=Remittances')
        await pg.wait_for_timeout(300)

        # Read, match and classify a typed WPA remittance
        await pg.set_input_files('[data-upc-remittances] input[type=file]', str(pdfs['wpa']))
        await pg.wait_for_function("document.querySelector('[data-upc-remittances]').querySelectorAll('tbody tr').length === 3", timeout=60000)
        await pg.wait_for_timeout(300)
        rows = await pg.evaluate("[...document.querySelector('[data-upc-remittances]').querySelectorAll('tbody tr')].map(r => r.innerText.replace(/\\s+/g, ' '))")
        check('fully paid invoice marked paid in full', 'Paid in full' in rows[0], rows[0])
        check('excess proposed on earliest line', 'Excess' in rows[1] and '02-Oct-2026: funder £ 60.00 to £ 24.00, patient pays £ 36.00' in rows[1], rows[1])
        check('provider shortfall left for a person', 'By hand' in rows[2] and 'Provider shortfall' in rows[2], rows[2])

        # Apply
        S['log'].clear()
        await pg.evaluate("document.querySelector('[data-upc-remittances]').querySelector('[data-act=apply]').click()")
        dlg = await pg.evaluate("document.querySelector('[data-upc-remit-confirm]').textContent")
        check('asks before changing anything', 'Patients will owe £ 36.00' in dlg and 'No payments are recorded' in dlg, dlg)
        await pg.evaluate("document.querySelector('[data-upc-remit-confirm] [data-a=yes]').click()")
        await pg.wait_for_function("(document.querySelector('[data-upc-remittances]').querySelector('.upc-log') || {}).innerText && document.querySelector('[data-upc-remittances]').querySelector('.upc-log').innerText.includes('Finished')", timeout=300000)
        f2 = S['funders'][102]
        amounts = sorted(l['amount'] for l in f2['lines'])
        check('funder invoice now totals what the insurer paid', sum(amounts) == 14400 and amounts == [2400, 6000, 6000], amounts)
        check('patient line rebate lowered, found despite Halaxy\'s date slip', [l['rebate'] for l in S['patients'][202]['lines'] if l['date'] == '01-Oct-2026'] == [2400])
        newl = [l for l in S['funders'][102]['lines'] if l['amount'] == 2400]
        check('re-billed funder line dated as the patient fee (Halaxy\'s slip corrected)', [l['date'] for l in newl] == ['01-Oct-2026'] and S.get('linedates') == 1, newl)
        check('nothing left waiting to bill', not S['patients'][202]['pending'])
        tk = S['tasks'].get(202, [])
        today = datetime.date.today().strftime('%d-%b-%Y')
        t0 = tk[0] if tk else {}
        check('task added on the patient invoice to bill the excess', len(tk) == 1 and str(t0.get('form[title]', '')).startswith('Bill excess: UPC-30002 (WPA remittance 2026-10-08'), tk)
        check('task assigned to Carl, due today, medium priority', t0.get('form[linkPrGs][]') == '31' and t0.get('form[displayDueDate]') == today and t0.get('form[priority]') == '2' and t0.get('form[actionerType]') == '1', t0)
        check('task comment says what moved and what the patient owes', 'Moved to the patient: 01-Oct-2026 £ 36.00 (WPA paid £ 24.00)' in str(t0.get('form[comment]')) and 'Patient owes' in str(t0.get('form[comment]')), t0.get('form[comment]'))
        check('no tasks on invoices without an excess', sorted(S['tasks']) == [202], sorted(S['tasks']))
        check('other invoices untouched', [l['amount'] for l in S['funders'][101]['lines']] == [6000] and [l['amount'] for l in S['funders'][103]['lines']] == [6000])
        atts = {k: v for k, v in S['attachments'].items()}
        check('remittance attached to every matched invoice', sorted(atts) == [101, 102, 103] and all(len(v) == 1 for v in atts.values()), atts)
        check('attached as Payment with a clear title', all(a['category'] == '2' and a['title'] == 'WPA remittance 2026-10-08' for v in atts.values() for a in v), atts)
        check('no payment recorded', not any(m == 'PAYMENT' for _, m, _ in S['log']))
        api = [t for t, m, pth in S['log'] if '/a/pr/' in pth or '/api/' in pth]
        gaps = [round(b - a, 3) for a, b in zip(api, api[1:])]
        check('requests are paced (at least 0.25 s apart)', gaps and min(gaps) >= 0.25, min(gaps) if gaps else None)
        status = await pg.evaluate("[...document.querySelector('[data-upc-remittances]').querySelectorAll('tbody tr')][1].innerText")
        check('result shown as done', 'Done' in status, status)

        # The insurer paid nothing for a fee: it stays on the funder invoice at £0.00, never removed (Carl, 9 Nov 2026)
        res = await pg.evaluate("""(async () => { try { const f = await UPC.invoice.fetch('103'); const l = f.lines[0];
            const plan = await UPC.rebate.plan('103', l.lineId, 0); await UPC.rebate.apply(plan); return 'ok'; } catch (e) { return e.message; } })()""")
        f3, p3 = S['funders'][103]['lines'], S['patients'][203]
        check('fee the insurer paid nothing for stays on the funder invoice at £0.00, correctly dated',
              res == 'ok' and [l['amount'] for l in f3] == [0] and [l['date'] for l in f3] == ['02-Oct-2026'], (res, f3))
        check('patient owes the fee, nothing left waiting to bill', not p3['pending'] and [l['rebate'] for l in p3['lines']] == [0], p3)
        posts = S.get('task_posts', 0)
        again = await pg.evaluate("""(async () => { const t = await (await fetch('/a/pr/555/task/invoice/202/list-data')).json();
            return UPC.tasks.addToInvoice('202', { title: t[0].title, assignee: 'Carl Healy', priority: 2, due: '09-Nov-2026', comment: 'x' }); })()""")
        check('the same task is not added twice', again is False and S.get('task_posts') == posts and len(S['tasks'][202]) == 1, (again, S.get('task_posts'), posts))

        # Reading the other layouts
        async def read(name):
            import base64
            b64 = base64.b64encode(pdfs[name].read_bytes()).decode()
            return await pg.evaluate("""async (b64) => {
                const f = new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], 'r.pdf', { type: 'application/pdf' });
                const read = await upcRemittances.readPdf(f);
                const r = upcRemittances.understand(read.words);
                return { scanned: read.scanned, insurer: r.insurer, date: r.date, checks: r.checks, notes: r.notes, items: r.items };
            }""", b64)

        b = await read('bupa')
        inv = {i['invoice']: i for i in b['items']}
        check('Bupa: wrapped invoice numbers joined', sorted(inv) == ['UPC-40011', 'UPC-40012'], sorted(inv))
        check('Bupa: excess read with its note', inv.get('UPC-40011', {}).get('patientShare') == 4000 and inv['UPC-40011']['reason'] == 'excess' and inv['UPC-40011']['dates'] == ['2026-09-10', '2026-09-24'], inv.get('UPC-40011'))
        check('Bupa: totals cross-check', b['checks']['paidRead'] == b['checks']['paidTotal'] == 14000 and not b['notes'], b)

        a = await read('axa')
        inv = {i['invoice']: i for i in a['items']}
        check('AXA (scanned): read by text recognition', a['scanned'] == 1 and a['insurer'] == 'AXA')
        check('AXA: amounts and member contribution', inv.get('UPC-40021', {}).get('paid') == 3000 and inv['UPC-40021']['reason'] == 'excess' and inv.get('UPC-40022', {}).get('paid') == 12000 and inv['UPC-40022']['reason'] is None, inv)
        check('AXA: totals cross-check', a['checks']['paidRead'] == a['checks']['paidTotal'] == 15000, a['checks'])

        v = await read('aviva')
        it = v['items'][0] if v['items'] else {}
        check('Aviva (scanned): invoice and totals', it.get('invoice') == 'UPC-40031' and it.get('claimed') == 14500 and it.get('paid') == 9000 and it.get('reason') == 'excess', it)
        lines = [(l['date'], l['invoiced'], l['paid'], l['deduction']) for l in it.get('lines', [])]
        check('Aviva: per-line paid and deductions in the right columns', lines == [('2026-09-05', 5500, 5500, None), ('2026-09-12', 4500, 0, 4500), ('2026-09-19', 4500, 3500, 1000)], lines)
        prop = await pg.evaluate("""(item) => upcRemittances.proposeLines({ number: 'UPC-40031', lines: [
            { lineId: '1', date: '05-Sep-2026', amount: 5500 }, { lineId: '2', date: '12-Sep-2026', amount: 4500 }, { lineId: '3', date: '19-Sep-2026', amount: 4500 }] }, item, 5500)""", it)
        check('Aviva: changes follow the per-line deductions', [(c['lineId'], c['to']) for c in prop.get('changes', [])] == [('2', 0), ('3', 3500)], prop)

        # Halaxy says it is busy: everything pauses
        busy = await pg.evaluate("UPC.http.json('/busy-test').then(() => 'ok', e => e.message)")
        paused = await pg.evaluate('UPC.http.pausedFor()')
        check('busy answer pauses all scripts', 'returned 429' in busy and paused > 170000, (busy, paused))
        check('no page errors', not errors, errors)
        await browser.close()

    for f in tmp.glob('*.pdf'):
        f.unlink()
    print('\n%d failed' % len(FAILS) if FAILS else '\nAll passed')
    sys.exit(1 if FAILS else 0)

asyncio.run(main())
