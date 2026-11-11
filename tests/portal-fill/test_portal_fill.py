"""
Test for Portal fill (beta/portal-fill.user.js) with the real loader (1.2.0) and core library, against a mock
Halaxy and mock AXA and Bupa provider sites built from the layouts captured on 11 Nov 2026. Invented
patient and claim only.

Tampermonkey's storage is stood in for by one store shared by every site (as Tampermonkey's is), so the
claim really travels from the Halaxy tab to the portal tab through the loader.

Checks: the button on Bupa and AXA funder invoices only; the claim read from Halaxy (fees, invoice number
without the leading 0, membership and authorisation numbers, name without title, date of birth, address
with postcode, condition from the notes); AXA: membership page, then every field and one fee per treatment
line, stopping before Submit; after Submit, Halaxy offers to mark the invoice Issued; Bupa: waits for the
log-in, closes the cookie box, Create an invoice, set-up, Pre-Auth Summary, provider check, removes the
pre-populated treatment, one fee per treatment, stops on Confirm and Submit; the claim is only given to the
portal it is for; the Bupa log-in left to the user; a fill that fails (a changed page) stops,
says Carl has been notified, and Halaxy adds a task for him on the funder invoice.

Run:  python3 tests/portal-fill/test_portal_fill.py
Needs: Python 3 with Playwright (Chromium).
"""
import asyncio, json, re, sys, urllib.parse
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
LOADER = (ROOT / 'loader' / 'upc-loader.user.js').read_text()
RAW = 'https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/'
FILES = {f: (ROOT / 'beta' / f).read_text() for f in ('core.user.js', 'portal-fill.user.js')}
ver = lambda code: [l.split()[-1] for l in code.splitlines() if '@version' in l][0]
name = lambda code: [l.split(None, 2)[2] for l in code.splitlines() if '@name' in l][0]
S = {}

STUBS = r"""
(function () {
  const call = (op, k, v) => { const x = new XMLHttpRequest(); x.open('POST', 'https://gm.test/' + op, false); x.send(JSON.stringify({ k: k, v: v })); return JSON.parse(x.responseText); };
  window.GM_getValue = (k, d) => { const r = call('get', k); return 'v' in r ? r.v : d; };
  window.GM_setValue = (k, v) => { call('set', k, v); };
  window.GM_deleteValue = (k) => { call('del', k); };
  window.__tmMenu = [];
  window.GM_registerMenuCommand = (label, fn) => { window.__tmMenu.push([label, fn]); };
  window.GM_addElement = (parent, tag, attrs) => { const el = document.createElement(tag); el.textContent = attrs.textContent; parent.appendChild(el); return el; };
  window.GM_xmlhttpRequest = (o) => { fetch(o.url).then((r) => r.text().then((t) => o.onload({ status: r.status, responseText: t }))).catch(() => o.onerror()); };
  // Pop-up windows open in the test's next page.
})();
"""


def fresh():
    S.clear()
    S.update({'gm': {}, 'log': [], 'axa': {}, 'bupa': {'logged': False, 'treatments': [], 'prepopulated': True, 'posted': []}, 'status': {9001: '', 9002: ''}, 'tasks': {9001: [], 9002: []}})


# ------------------------------------------------------------------ Halaxy

MENU = ("<div id='practitioner-select'><button id='activeUser'>Carl Healy</button><div class='dropdown-menu'><a id='btn-user-select-logout' class='dropdown-item'>Log Out</a></div></div>")


def funder_invoice(inv_id, funder, lines):
    rows = ''.join(
        "<tr><td data-property='date'><a href='/a/pr/555/invoice/8001'>%s</a></td><td data-property='description'><script>var x = 1;</script>Patient Test</td>"
        "<td data-property='practitioner'>A Physio</td><td data-property='itemNumber'>%s</td><td data-property='description'>%s</td><td data-property='tax'>£ 0.00</td>"
        "<td data-property='amount'>£ %s</td><td><a href='/a/pr/555/invoice/line/%d/edit'>e</a></td></tr>" % (d, code, desc, amt, 70 + i)
        for i, (d, code, desc, amt) in enumerate(lines))
    total = sum(float(x[3]) for x in lines)
    return ("<!doctype html><html><head><meta charset='utf-8'><title>Invoice UPC-0%d | Halaxy</title><script>window.HkUser = { pracName: 'Carl Healy' };</script></head><body><ul id='mainMenu'></ul>%s"
            "<div class='card' id='card-invoice-view-organisation'><div class='card-header'>Bill To</div><div class='card-body'><a href='/a/pr/555/organisation/12/edit'>Edit</a>"
            "<a href='/a/pr/555/organisation/12'>%s</a></div></div>"
            "<table id='invoiceLines'>%s<tr><td>Total</td><td>£ %.2f</td></tr></table><table id='invoicePayments'></table></body></html>" % (1111 if inv_id == 9001 else 2222, MENU, funder, rows, total))


PATIENT_INVOICE = ("<!doctype html><html><head><meta charset='utf-8'><title>Invoice UPC-01000</title></head><body><div id='card-invoice-view-patient'><a href='/a/magic/add/patient/987/invoice'>e</a>"
                   "<a href='/a/pr/555/patient/987'>Mrs Patient Test</a></div><div id='card-invoice-parts-claim-view'><a href='/a/pr/555/organisation/12'>AXA Health</a>"
                   "<a id='editClaimButton' href='/a/pr/555/patient/claim/1/987/44/edit?invoice=8001'>Edit</a></div><table id='invoiceLines'></table></body></html>")
CLAIM = ("<form><select name='claim[organisation]'><option selected>AXA Health</option></select><input name='claim[enc1]' value='AUTHTEST'><input name='claim[enc2]' value=''>"
         "<input name='claim[col1]' value='MEMBERTEST'><input name='claim[date1]' value=''><input type='hidden' name='claim[_token]' value='C'></form>")
EDIT = ("<html><body><form id='patientGeneralEditForm'><input name='patientdetailmain[linkPaG][linkpagaddresses][0][address][firstline]' value='1 Test Street'>"
        "<input name='patientdetailmain[linkPaG][linkpagaddresses][0][address][secondline]' value=''><input name='patientdetailmain[linkPaG][linkpagaddresses][0][address][city]' value='Testtown'>"
        "<input name='patientdetailmain[linkPaG][linkpagaddresses][0][address][postcode]' value='TE1 1ST'></form></body></html>")


def options(inv):
    st = S['status'][inv]
    return ("<form id='frmInvoiceType'><input name='form[displayDate]' value='11-Nov-2026'><select name='form[status]'><option value=''%s>Active</option>"
            "<option value='issued'%s>Issued</option></select><input type='hidden' name='form[_token]' value='O'></form>" % ('' if st else ' selected', ' selected' if st == 'issued' else ''))


async def halaxy(route):
    req = route.request
    u = urllib.parse.urlparse(req.url)
    p = u.path
    S['log'].append((req.method, p))
    js = lambda o: route.fulfill(body=json.dumps(o), content_type='application/json')
    if p == '/a/pr/555/invoice/9001':
        return await route.fulfill(body=funder_invoice(9001, 'AXA Health', [('20-Oct-2026', 'AXA-IA', 'AXA Health: Initial Physiotherapy Assessment - Patient Invoice UPC-01000', '60.00'),
                                                                           ('27-Oct-2026', 'AXA-FU', 'AXA Health: Follow-Up Physiotherapy Consultation', '40.00')]), content_type='text/html')
    if p == '/a/pr/555/invoice/9002':
        return await route.fulfill(body=funder_invoice(9002, 'Bupa', [('03-Nov-2026', 'Bup-IA (AA360)', 'Initial Physiotherapy Consultation - Patient Invoice UPC-01000', '60.00'),
                                                                      ('10-Nov-2026', 'Bup-FU (AA361)', 'Follow-Up Physiotherapy Consultation - Patient Invoice UPC-01000', '40.00')]), content_type='text/html')
    if p == '/a/pr/555/invoice/8001':
        return await route.fulfill(body=PATIENT_INVOICE, content_type='text/html')
    if p == '/a/pr/555/patient/claim/1/987/44/edit':
        return await js({'status': 'FORM', 'message': CLAIM})
    if p == '/a/pr/555/note/sidebar/linkPaG/987':
        return await js({'patientDetails': {'fullName': 'Mrs Patient (Pat) Test', 'dob': '05-May-1975 (51 yrs)', 'addresses': [{'type': 'Home', 'formatted': '1 Test Street, Testtown'}]}})
    if p == '/a/pr/555/patient/987/edit':
        return await route.fulfill(body=EDIT, content_type='text/html')
    m = re.search(r'/invoice/options/(\d+)$', p)
    if m:
        inv = int(m.group(1))
        if req.method == 'POST':
            f = urllib.parse.parse_qs(req.post_data or '', keep_blank_values=True)
            S['status'][inv] = f['form[status]'][0]
            return await js({'status': 'REFRESH'})
        return await js({'status': 'FORM', 'message': options(inv)})
    m = re.search(r'/task/invoice/(\d+)/list-data$', p)
    if m:
        return await js(S['tasks'][int(m.group(1))])
    m = re.search(r'/task/new/invoice/(\d+)$', p)
    if m:
        inv = int(m.group(1))
        if req.method == 'GET':
            return await js({'status': 'FORM', 'message': "<form id='form_task_edit'><input name='form[title]'><select name='form[linkPrGs][]'><option value='30'>Wendy Pritchard</option><option value='31'>Carl Healy</option></select>"
                                                          "<select name='form[priority]'><option value='2'>Medium</option></select><input name='form[displayDueDate]'><textarea name='form[comment]'></textarea><input type='hidden' name='form[_token]' value='T'></form>"})
        f = urllib.parse.parse_qs(req.post_data or '', keep_blank_values=True)
        S['tasks'][inv].append({'title': f['form[title]'][0], 'comment': f['form[comment]'][0], 'who': f['form[linkPrGs][]']})
        return await js({'status': 'POPUP'})
    if p == '/a/pr/555/note/menu/linkPaG/987/items':
        return await js({'payload': {'menuItems': [{'id': 'n1', 'linkId': 601, 'category': 'appointment', 'entity': 'note', 'label': 'Appointment', 'date': '20-Oct-2026'},
                                                   {'id': 'n2', 'linkId': 602, 'category': 'appointment', 'entity': 'note', 'label': 'Appointment', 'date': '27-Oct-2026'}]}})
    m = re.search(r'/note/(60\d)$', p)
    if m:
        body = {'601': '<p>Subjective:</p><ul><li>C/O right knee pain after running</li><li>Worse on stairs</li></ul>',
                '602': '<p><strong>Subjective:</strong> C/O right knee pain after running</p><p>Improving</p>'}[m.group(1)]
        return await js({'id': int(m.group(1)), 'content': body, 'final': body})
    await route.fulfill(status=404, body='not mocked ' + p)


# ------------------------------------------------------------------ AXA

AXA_MEMBER = ("<!doctype html><html><head><meta charset='utf-8'><title>Submit invoice</title></head><body><h1>I'm a healthcare provider and would like to submit an invoice</h1>"
              "<input type='text' id='member_id_v77' name='__field_112374'><button id='next_v77' type='button' onclick=\"sessionStorage.setItem('m', document.getElementById('member_id_v77').value); "
              "location.href='/payment-support-service/form/submit-invoice-updated/axa-health-new/'\">Submit invoice</button></body></html>")


def axa_form():
    f = []
    def text(fid, label, placeholder=''):
        f.append("<div><label for='%s'>%s</label><input type='text' id='%s' name='__field_%s' placeholder='%s'></div>" % (fid, label, fid, fid, placeholder))
    def radios(group, labels):
        f.append(''.join("<div><input type='radio' id='%s_%d' name='%s' value='%s'><label for='%s_%d'>%s</label></div>" % (group, i, group, l, group, i, l) for i, l in enumerate(labels)))
    radios('who', ['Therapist (physiotherapist, osteopath or other)', 'Specialist, anaesthetist, or other clinical practitioner', 'Hospital'])
    text('mem', 'Membership number (required)')
    text('name', 'Patient’s forename and surname (required)')
    text('dob', 'Patient’s date of birth (required)', 'Enter a date in the format dd/mm/yyyy')
    text('addr', 'Patient’s address (required)')
    text('payee', 'Name of payee (required)')
    text('code', 'The payee’s AXA provider code (required)', 'Expected formats: 01234')
    text('email', 'The payee’s email address, should we have a query about the payment request (required)')
    text('phone', 'The payee’s phone number, should we need to call you about the payment request (required)')
    text('auth', 'Authorisation number (if you don’t have this, please ensure you tell us the member’s medical condition below)')
    text('cond', 'Condition for which the treatment is carried out (required)', 'Example: back pain')
    text('total', 'Invoice total (required)')
    text('idate', 'Invoice date', 'Enter a date in the format dd/mm/yyyy')
    text('num', 'Invoice/account number (required)')
    text('notes', 'Additional notes')
    for n in range(1, 6):
        f.append("<div class='line' id='line%d' style='%s'>" % (n, '' if n == 1 else 'display:none'))
        text('ics%d' % n, 'If you are claiming for physiotherapy please enter the ICS code', 'This field must be completed to proceed.')
        text('desc%d' % n, 'Treatment description - line %d (required)' % n)
        radios('where%d' % n, ['Outpatient', 'Day case', 'Inpatient'])
        text('tdate%d' % n, 'Treatment date (required)', 'Enter a date in the format dd/mm/yyyy')
        text('units%d' % n, 'Number of treatments/sessions / units of time (required)')
        text('charge%d' % n, 'Charge per unit (required)')
        text('ltotal%d' % n, 'Total charge for treatment line %d (required)' % n)
        radios('more%d' % n, ['Yes', 'No'])
        f.append('</div>')
    script = ("<script>document.addEventListener('change', function (e) { var m = /^more(\\d)_0$/.exec(e.target.id); if (m && e.target.checked) { var nx = document.getElementById('line' + (+m[1] + 1)); if (nx) nx.style.display = ''; } });"
              "document.getElementById('mem').value = sessionStorage.getItem('m') || '';"
              "document.querySelector('form').addEventListener('submit', function (e) { e.preventDefault(); var d = {}; document.querySelectorAll('form input').forEach(function (i) { if (i.type === 'radio') { if (i.checked) d[i.name] = i.value; } else d[i.id] = i.value; });"
              "fetch('/record', { method: 'POST', body: JSON.stringify(d) }); document.querySelector('form').style.display = 'none'; document.getElementById('ok').style.display = ''; });</script>")
    return ("<!doctype html><html><head><meta charset='utf-8'><title>I would like to submit an invoice - AXA Health new</title></head><body><h2>I would like to submit an invoice</h2>"
            "<form class='EPiServerForms' method='post'>%s<button type='submit'>Submit</button></form><div id='ok' class='Form__Status__Message Form__Success__Message' style='display:none'>The form has been submitted successfully.</div>%s</body></html>"
            % (''.join(f), script))


async def axa(route):
    req = route.request
    p = urllib.parse.urlparse(req.url).path
    S['log'].append((req.method, 'axa' + p))
    if p == '/record':
        S['axa']['submitted'] = json.loads(req.post_data)
        return await route.fulfill(body='{}', content_type='application/json')
    if p == '/payment-support-service/form/submit-invoice-updated/':
        return await route.fulfill(body=AXA_MEMBER, content_type='text/html')
    if p == '/payment-support-service/form/submit-invoice-updated/axa-health-new/':
        return await route.fulfill(body=AXA_FORM_OVERRIDE.get('html') or axa_form(), content_type='text/html')
    await route.fulfill(status=404, body='not mocked')

AXA_FORM_OVERRIDE = {}


# ------------------------------------------------------------------ Bupa

NAV = ("<select id='nav' onchange=\"if (this.value) location.href = this.value\"><option value=''>Provider Home</option><option value='/providers-online/createClaims.do'>Create an invoice</option>"
       "<option value='/providers-online/statements.do'>View my statements</option></select>")
COOKIE = ("<div id='onetrust-banner-sdk'><h2>Cookies help us provide you with the best experience</h2><button id='onetrust-accept-btn-handler'>Accept all</button>"
          "<button id='onetrust-reject-all-handler' onclick=\"document.cookie='ot=1;path=/'; document.getElementById('onetrust-banner-sdk').remove()\">Reject all</button></div>")


def bupa_page(body, cookie=True):
    return "<!doctype html><html><head><meta charset='utf-8'><title>Providers online | Bupa UK</title></head><body>%s%s%s</body></html>" % (NAV, body, COOKIE if cookie else '')


def bupa_list():
    rows = ''.join("<tr><td>Treatment %d</td><td><form method='post' action='/providers-online/addClaimTreatment.do?method=confirmRemove'><input type='hidden' name='i' value='%d'><button type='submit'>Remove</button></form></td></tr>" % (i + 1, i)
                   for i, _ in enumerate(S['bupa']['treatments']))
    return bupa_page("<h2>Treatment details</h2><table>%s</table><form id='createClaimForm' method='post' action='/providers-online/addClaimTreatment.do?method=addClaimTreatment'>"
                     "<button type='submit' name='go' value='add'>Add treatment</button><button type='submit' name='go' value='previous'>Previous</button><button type='submit' name='go' value='next'>Next</button></form>" % rows, False)


BUPA_ADD = bupa_page("<h2>Treatment details</h2><form id='createClaimForm' method='post' action='/providers-online/addClaimTreatment.do?method=save'>"
                     "<label>Impairment / diagnosis <span class='error'>*</span></label><select name='impairmentPair'><option>Please select...</option><option>11111-Knee pain</option><option selected>22222-Knee sprain</option></select>"
                     "<label>Procedure <span class='mandatory-error'>*</span></label><select name='procedureCode'><option>Please select...</option><option>Physiotherapy group session (AA359)</option><option>Physio initial consultation - AA360</option>"
                     "<option>AA361 Physio follow up</option><option>Invented longer code AA3610</option></select>"
                     "<select name='typeOfService'><option>Outpatient</option></select><label for='place-of-service'>Place of service *</label><select id='place-of-service' name='placeOfService'>"
                     "<option value=''>Please select...</option><option value='HOME'>Home</option><option value='CR'>Consultant rooms</option><option value='OT'>Other</option></select>"
                     "<select name='providerId'><option>Urmston Physio Clinic</option></select><input name='treatmentFromDate'><input name='treatmentToDate'>"
                     "<input name='incidents' maxlength='3'><input name='chargeAmount' maxlength='8'><button type='submit' name='go' value='previous'>Previous</button><button type='submit' name='go' value='save'>Save</button></form>", False)


async def bupa(route):
    req = route.request
    u = urllib.parse.urlparse(req.url)
    p, q = u.path, urllib.parse.parse_qs(u.query)
    f = {k: v[0] for k, v in urllib.parse.parse_qs(req.post_data or '', keep_blank_values=True).items()}
    S['log'].append((req.method, 'bupa' + p + ('?' + u.query if u.query else '')))
    B = S['bupa']
    html = lambda b: route.fulfill(body=b, content_type='text/html')
    if p == '/providers-online/login.do':
        B['logins'] = B.get('logins', 0) + 1
        B['logged'] = not B.get('refuse')
        return await route.fulfill(body="<!doctype html><html><body><script>location.href = '/providers-online/';</script></body></html>", content_type='text/html')
    if not B['logged']:
        # Bupa's log-in is on another site (identity.provider.bupa.co.uk), where the script doesn't run: here, a page the user logs in on.
        return await html("<!doctype html><html><body><h1>Log in</h1><form method='post' action='/providers-online/login.do'><input name='u'><input type='password' name='pw'><button type='submit'>Log in</button></form></body></html>")
    if p == '/providers-online/':
        return await html(bupa_page('<h1>Provider Home</h1>'))
    if p == '/providers-online/createClaims.do' and req.method == 'GET':
        return await html(bupa_page("<h2>Set up your invoice</h2><form id='createClaimForm' method='post' action='/providers-online/claimSetup.do?method=createInvoice'>"
                                    "<input id='invoice-num' name='invoiceNumber' maxlength='30'><label for='datepicker'>First treatment date *</label><input id='datepicker' name='firstTreatmentDate'>"
                                    "<label for='billing-ref'>Provider Number *</label><select id='billing-ref' name='billingAccount'><option>12345678</option></select><input id='preauth' name='preAuthNumber' maxlength='14'>"
                                    "<button type='submit'>Next</button></form>", False))
    if p == '/providers-online/claimSetup.do':
        B['setup'] = f
        return await html(bupa_page("<h2>Pre-Auth Summary</h2><h3>Membership number: 0000000000</h3><form id='createClaimForm' method='post' action='/providers-online/memberSearch.do?method=search'%s>" % (" onsubmit='return false'" if B.get('stall') else '') +
                                    "<button type='submit' name='go' value='previous'>Previous</button><button type='submit' name='go' value='next'>Next</button></form>", False))
    if p == '/providers-online/memberSearch.do':
        if q.get('method') == ['search']:
            return await html(bupa_page("<h2>Provider Details</h2><form id='createClaimForm' method='post' action='/providers-online/memberSearch.do?method=addClaimsProvider'>"
                                        "<table><tr><td><input type='radio' name='specialist' id='specialist1' value='1' checked></td><td>%s</td></tr></table>"
                                        "<button type='submit' name='go' value='previous'>Previous</button><button type='submit' name='go' value='next'>Next</button></form>" % B.get('provider', 'Urmston Physio Clinic'), False))
        if B['prepopulated']:
            B['treatments'] = [{'pre': True}]
            B['prepopulated'] = False
        return await html(bupa_list())
    if p == '/providers-online/addClaimTreatment.do':
        m = q.get('method', [''])[0]
        if m == 'confirmRemove':
            return await html(bupa_page("<h2>Remove this treatment?</h2><form id='createClaimForm' method='post' action='/providers-online/addClaimTreatment.do?method=removeTreatment'>"
                                        "<input type='hidden' name='indexId' value='%s'><button type='submit' name='go' value='cancel'>Cancel</button><button type='submit' name='go' value='remove'>Remove treatment</button></form>" % f.get('i'), False))
        if m == 'removeTreatment':
            if f.get('go') == 'remove':
                B['treatments'].pop(int(f['indexId']))
                if not B['treatments']:   # as Bupa: once the last is removed, a new treatment opens
                    return await html(BUPA_ADD)
            return await html(bupa_list())
        if m == 'save' and (B.get('reopen') or B.get('reopenAlways')):   # the form comes back with no message (as after a refresh): the fill should fill it again
            B['reopen'] = False
            return await html(BUPA_ADD)
        if m == 'save' and B.get('refuseSave'):
            return await html(BUPA_ADD.replace("<h2>Treatment details</h2>", "<h2>Treatment details</h2><div class='errorMessage'>Please enter a valid fee</div>"))
        if m == 'save':
            B['treatments'].append({k: f.get(k) for k in ('placeOfService', 'treatmentFromDate', 'treatmentToDate', 'incidents', 'chargeAmount', 'impairmentPair', 'procedureCode')})
            return await html(bupa_list())
        if f.get('go') == 'add':
            return await html(BUPA_ADD)
        if f.get('go') == 'next':
            total = sum(float(t.get('chargeAmount') or 0) for t in B['treatments'])
            return await html(bupa_page("<h2>Confirm and Submit</h2><h3>Invoice total: £%.2f</h3><h3>Treatments</h3><form id='createClaimForm' action='/providers-online/createClaims.do' method='post'>"
                                        "<input type='checkbox' name='confirm' id='confirmation'><button type='submit' name='go' value='previous'>Previous</button><button type='submit' id='btn_next'>Submit</button></form>" % total, False))
        return await html(bupa_list())
    if p == '/providers-online/createClaims.do' and req.method == 'POST':
        B['submitted'] = True
        return await html(bupa_page('<h2>Your invoice has been submitted successfully</h2>', False))
    await route.fulfill(status=404, body='not mocked')


async def github(route):
    path = route.request.url.split('?')[0][len(RAW):]
    ch, _, f = path.partition('/')
    if f == 'scripts.json':
        return await route.fulfill(body=json.dumps({'scripts': [{'file': k, 'name': name(v), 'version': ver(v)} for k, v in FILES.items()]}), content_type='application/json')
    if f in FILES:
        return await route.fulfill(body=FILES[f], content_type='text/plain')
    await route.fulfill(status=404, body='not found')


async def gm(route):
    req = route.request
    op = req.url.rsplit('/', 1)[1]
    d = json.loads(req.post_data or '{}')
    out = {}
    if op == 'get' and d['k'] in S['gm']:
        out = {'v': S['gm'][d['k']]}
    elif op == 'set':
        S['gm'][d['k']] = d.get('v')
    elif op == 'del':
        S['gm'].pop(d['k'], None)
    await route.fulfill(body=json.dumps(out), content_type='application/json', headers={'Access-Control-Allow-Origin': '*'})


FAILS = []
def check(label, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + label + ('' if ok else '  ' + str(detail)[:900]))
    if not ok:
        FAILS.append(label)


async def setup(browser):
    ctx = await browser.new_context(viewport={'width': 1300, 'height': 900})
    await ctx.route(RAW + '**', github)
    await ctx.route('https://gm.test/**', gm)
    await ctx.route('https://eu.halaxy.com/**', halaxy)
    await ctx.route('https://provider.axahealth.co.uk/**', axa)
    await ctx.route('https://providersonline.bupa.co.uk/**', bupa)
    await ctx.add_init_script(STUBS)
    await ctx.add_init_script(LOADER)
    return ctx


async def open_halaxy(ctx, inv):
    pg = await ctx.new_page()
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    for _ in range(2):   # the first page fetches the scripts; the second runs the saved copies
        await pg.goto('https://eu.halaxy.com/a/pr/555/invoice/%d' % inv)
        await pg.wait_for_timeout(1200)
    return pg, errors


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        fresh()
        ctx = await setup(browser)
        pg, errors = await open_halaxy(ctx, 9001)
        btn = await pg.evaluate("(document.querySelector('[data-upc-portal-fill] button') || {}).textContent")
        check('AXA funder invoice: Fill on the AXA portal', btn == 'Fill on the AXA portal', btn)
        look = await pg.evaluate("(() => { const b = document.querySelector('[data-upc-portal-fill]'); return b.classList.contains('upc-native') && b.closest('#card-invoice-view-organisation') !== null && b.querySelector('button').className; })()")
        check('Halaxy look, in the Bill To box', look == 'btn btn-outline-primary-light', look)


        # Fill: the portal opens in a new tab
        async with ctx.expect_page() as newp:
            await pg.click('[data-upc-portal-fill] button')
        portal = await newp.value
        perr = []
        portal.on('pageerror', lambda e: perr.append(str(e)))
        await portal.wait_for_url('**/axa-health-new/', timeout=60000)
        await portal.wait_for_function("document.getElementById('upc-pf-panel') && /Filled:/.test(document.getElementById('upc-pf-panel').textContent)", timeout=60000)
        claim = S['gm'].get('shared:portal-claim') or {}
        check('the claim read from Halaxy', claim.get('number') == 'UPC-1111' and claim.get('membership') == 'MEMBERTEST' and claim.get('authorisation') == 'AUTHTEST'
              and claim.get('patient', {}).get('name') == 'Patient Test' and claim.get('patient', {}).get('dob') == '05/05/1975'
              and claim.get('patient', {}).get('address') == '1 Test Street, TE1 1ST' and claim.get('total') == '100.00' and claim.get('invoiceDate') == '11/11/2026'
              and claim.get('condition') == 'right knee pain after running' and claim.get('forHost') == 'provider.axahealth.co.uk', claim)
        vals = await portal.evaluate("(() => { const d = {}; document.querySelectorAll('form input').forEach(i => { if (i.type === 'radio') { if (i.checked) d[i.name] = i.value; } else d[i.id] = i.value; }); return d; })()")
        want = {'who': 'Therapist (physiotherapist, osteopath or other)', 'mem': 'MEMBERTEST', 'name': 'Patient Test', 'dob': '05/05/1975', 'addr': '1 Test Street, TE1 1ST',
                'payee': 'Urmston Physio Clinic', 'code': 'ZZ03779', 'email': 'admin@urmstonphysioclinic.com', 'phone': '01617484100', 'auth': 'AUTHTEST', 'cond': 'right knee pain after running',
                'total': '100.00', 'idate': '11/11/2026', 'num': 'UPC-1111', 'notes': '',
                'ics1': 'NA', 'desc1': 'Initial Physiotherapy Assessment', 'where1': 'Outpatient', 'tdate1': '20/10/2026', 'units1': '1', 'charge1': '60.00', 'ltotal1': '60.00', 'more1': 'Yes',
                'ics2': 'NA', 'desc2': 'Follow-Up Physiotherapy Consultation', 'where2': 'Outpatient', 'tdate2': '27/10/2026', 'units2': '1', 'charge2': '40.00', 'ltotal2': '40.00', 'more2': 'No'}
        wrong = {k: (vals.get(k), v) for k, v in want.items() if vals.get(k) != v}
        check('AXA: every field filled, one fee per treatment line', not wrong, wrong)
        check('AXA: lines after the last left empty', vals.get('desc3') == '' and 'more3' not in vals, (vals.get('desc3'), vals.get('more3')))
        check('AXA: the condition highlighted to check', await portal.evaluate("document.getElementById('cond').classList.contains('upc-pf-check')"))
        check('AXA: never submitted by the script', 'submitted' not in S['axa'])
        check('AXA: the page is uncovered once filled, for checking', await portal.evaluate("!document.getElementById('upc-pf-cover') && !document.getElementById('upc-pf-panel').classList.contains('upc-pf-busy')"))
        await portal.click('button[type=submit]')
        await portal.wait_for_function("document.getElementById('upc-pf-panel') && /Submitted to AXA/.test(document.getElementById('upc-pf-panel').textContent)", timeout=30000)
        check('AXA: submitted noted', (S['gm'].get('shared:portal-claim') or {}).get('status') == 'submitted')
        await pg.bring_to_front()
        await pg.wait_for_selector('[data-upc-pf-confirm]', timeout=30000)
        txt = await pg.evaluate("document.querySelector('[data-upc-pf-confirm]').innerText")
        check('Halaxy asks before marking Issued', 'The AXA portal says the invoice was submitted (UPC-1111, £ 100.00). Mark this funder invoice Issued?' in txt and S['status'][9001] == '', txt)
        await pg.click('[data-upc-pf-confirm] [data-c=yes]')
        await pg.wait_for_function("/marked Issued/.test(document.querySelector('[data-upc-portal-fill]').textContent)", timeout=30000)
        check('marked Issued, and the claim cleared from the PC', S['status'][9001] == 'issued' and 'shared:portal-claim' not in S['gm'], (S['status'], list(S['gm'])))
        check('no page errors (Halaxy, AXA)', not errors and not perr, errors + perr)
        await portal.close()

        # Bupa
        pg2, errors2 = await open_halaxy(ctx, 9002)
        S['bupa']['reopen'] = True   # the first Save brings the form back without a message, as a refresh would
        check('Bupa funder invoice: Fill on the Bupa portal', await pg2.evaluate("document.querySelector('[data-upc-portal-fill] button').textContent") == 'Fill on the Bupa portal')
        async with ctx.expect_page() as newp:
            await pg2.click('[data-upc-portal-fill] button')
        portal = await newp.value
        perr = []
        portal.on('pageerror', lambda e: perr.append(str(e)))
        await portal.wait_for_timeout(3000)
        check('Bupa: not covered while waiting for the log-in', await portal.evaluate("!document.getElementById('upc-pf-cover')"))
        check('Bupa: leaves the log-in to the user', S['bupa'].get('logins', 0) == 0 and await portal.evaluate("!document.getElementById('upc-pf-panel') || /Log in to Bupa/.test(document.getElementById('upc-pf-panel').textContent)"))
        await portal.fill('input[name=u]', 'tester')
        await portal.fill('input[name=pw]', 'not-a-real-password')
        await portal.click('button[type=submit]')
        # The claim is only for Bupa: an AXA page can't read it
        axa_tab = await ctx.new_page()
        await axa_tab.goto('https://provider.axahealth.co.uk/payment-support-service/form/submit-invoice-updated/')
        await axa_tab.wait_for_timeout(1500)
        seen = await axa_tab.evaluate("window.__upcLoader ? window.__upcLoader.shared('get', 'portal-claim') : 'no loader'")
        check('the claim is only given to the portal it is for', seen is None and not await axa_tab.evaluate("!!document.getElementById('upc-pf-panel')"), seen)
        await axa_tab.close()
        await portal.wait_for_function("document.getElementById('upc-pf-panel') && /Filled:/.test(document.getElementById('upc-pf-panel').textContent)", timeout=90000)
        B = S['bupa']
        check('Bupa: cookie box closed (Reject all)', any(c['name'] == 'ot' for c in await ctx.cookies('https://providersonline.bupa.co.uk')))
        check('Bupa: set-up (invoice number without the 0, first treatment date, pre-auth number)', B.get('setup', {}).get('invoiceNumber') == 'UPC-2222'
              and B['setup'].get('firstTreatmentDate') == '03/11/2026' and B['setup'].get('preAuthNumber') == 'AUTHTEST', B.get('setup'))
        check('Bupa: a form that comes back without a message is filled again; pre-populated treatment removed, Bupa opens a new treatment after removal, one fee per treatment, Consultant rooms, the procedure chosen by the fee\'s Item Code (Bupa\'s code), Bupa\'s impairment left as it came',
              B['treatments'] == [{'placeOfService': 'CR', 'treatmentFromDate': '03/11/2026', 'treatmentToDate': '03/11/2026', 'incidents': '1', 'chargeAmount': '60.00', 'impairmentPair': '22222-Knee sprain', 'procedureCode': 'Physio initial consultation - AA360'},
                                  {'placeOfService': 'CR', 'treatmentFromDate': '10/11/2026', 'treatmentToDate': '10/11/2026', 'incidents': '1', 'chargeAmount': '40.00', 'impairmentPair': '22222-Knee sprain', 'procedureCode': 'AA361 Physio follow up'}], B['treatments'])
        panel = await portal.evaluate("document.getElementById('upc-pf-panel').textContent")
        check('Bupa: stops on Confirm and Submit, total matches', 'Confirm and Submit' in await portal.evaluate("document.body.innerText") and 'Bupa shows a total' not in panel and not B.get('submitted')
              and await portal.evaluate("document.getElementById('confirmation').classList.contains('upc-pf-check') && !document.getElementById('confirmation').checked"), panel)
        await portal.check('#confirmation')
        await portal.click('#btn_next')
        await portal.wait_for_function("document.getElementById('upc-pf-panel') && /Submitted to Bupa/.test(document.getElementById('upc-pf-panel').textContent)", timeout=30000)
        await pg2.bring_to_front()
        await pg2.wait_for_selector('[data-upc-pf-confirm]', timeout=30000)
        await pg2.click('[data-upc-pf-confirm] [data-c=no]')
        await pg2.wait_for_function("/Not marked Issued/.test(document.querySelector('[data-upc-portal-fill]').textContent)", timeout=30000)
        check('Bupa: "Not now" leaves the invoice Active', S['status'][9002] == '')
        check('no page errors (Bupa)', not errors2 and not perr, errors2 + perr)
        await portal.close()

        # A changed AXA page: the fill stops and says so
        AXA_FORM_OVERRIDE['html'] = axa_form().replace('Charge per unit (required)', 'Unit price (required)')
        async with ctx.expect_page() as newp:
            await pg.click('[data-upc-portal-fill] button')
        portal = await newp.value
        await portal.wait_for_function("document.getElementById('upc-pf-panel') && /has stopped/.test(document.getElementById('upc-pf-panel').textContent)", timeout=60000)
        panel = await portal.evaluate("document.getElementById('upc-pf-panel').textContent")
        check('a changed portal page stops the fill, says what, and that Carl has been notified', 'treatment line 1: charge per unit not found' in panel and 'Carl has been notified' in panel, panel)
        await pg.wait_for_function("/Carl Healy has been sent a task/.test(document.querySelector('[data-upc-portal-fill]').textContent)", timeout=60000)
        t = S['tasks'][9001]
        check('a task for Carl on the funder invoice, with the reason', len(t) == 1 and t[0]['title'] == 'Portal fill stopped: AXA, UPC-01111' and t[0]['who'] == ['31']
              and 'charge per unit not found' in t[0]['comment'] and 'shared:portal-claim' not in S['gm'], t)
        AXA_FORM_OVERRIDE.clear()
        await portal.close()

        # While working, the page is covered and a real click doesn't reach it; after a minute stuck, the fill gives up
        S['bupa'].update({'logged': True, 'treatments': [], 'prepopulated': False, 'refuseSave': False, 'submitted': False, 'stall': True})
        S['tasks'][9002] = []
        await pg2.bring_to_front()
        async with ctx.expect_page() as newp:
            await pg2.click('[data-upc-portal-fill] button')
        portal = await newp.value
        await portal.wait_for_function("/Pre-Auth Summary/.test(document.body.innerText) && !!document.getElementById('upc-pf-cover')", timeout=60000)
        await portal.wait_for_timeout(1500)   # Next pressed; nothing happens
        blocked = await portal.evaluate("(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Next'); const r = b.getBoundingClientRect(); const top = document.elementFromPoint(r.left + 5, r.top + 5); return top && top.id; })()")
        check('while working: the page is covered and clicks land on the cover', blocked == 'upc-pf-cover', blocked)
        await portal.wait_for_function("document.getElementById('upc-pf-panel') && /got stuck/.test(document.getElementById('upc-pf-panel').textContent) && !document.getElementById('upc-pf-cover')", timeout=90000)
        check('stuck under the cover for a minute: the fill stops and uncovers', True)
        await pg2.wait_for_function("/has been sent a task/.test(document.querySelector('[data-upc-portal-fill]').textContent)", timeout=60000)
        S['bupa']['stall'] = False
        S['tasks'][9002] = []
        await portal.close()

        # Bupa refuses a treatment (an error message on the form): the fill stops with Bupa's words, and Carl gets a task
        S['bupa'].update({'logged': True, 'treatments': [], 'prepopulated': False, 'refuseSave': True, 'submitted': False})
        await pg2.bring_to_front()
        async with ctx.expect_page() as newp:
            await pg2.click('[data-upc-portal-fill] button')
        portal = await newp.value
        await portal.wait_for_function("document.getElementById('upc-pf-panel') && /has stopped/.test(document.getElementById('upc-pf-panel').textContent)", timeout=90000)
        panel = await portal.evaluate("document.getElementById('upc-pf-panel').textContent")
        check('Bupa: a refused treatment stops the fill, with Bupa\'s message', 'Please enter a valid fee' in panel, panel)
        await pg2.wait_for_function("/has been sent a task/.test(document.querySelector('[data-upc-portal-fill]').textContent)", timeout=60000)
        check('and Carl gets a task on that invoice', len(S['tasks'][9002]) == 1 and 'Please enter a valid fee' in S['tasks'][9002][0]['comment'], S['tasks'][9002])
        await portal.close()

        # Bupa keeps handing the form back with no message: the fill tries twice more, then stops rather than looping
        S['bupa'].update({'logged': True, 'treatments': [], 'prepopulated': False, 'refuseSave': False, 'reopenAlways': True, 'submitted': False})
        S['tasks'][9002] = []
        await pg2.bring_to_front()
        async with ctx.expect_page() as newp:
            await pg2.click('[data-upc-portal-fill] button')
        portal = await newp.value
        await portal.wait_for_function("document.getElementById('upc-pf-panel') && /has stopped/.test(document.getElementById('upc-pf-panel').textContent)", timeout=90000)
        panel = await portal.evaluate("document.getElementById('upc-pf-panel').textContent")
        saves = len([x for x in S['log'] if 'method=save' in x[1]])
        check('Bupa: a form returned again and again stops the fill (no loop)', 'keeps returning treatment 1' in panel and '"*"' not in panel, panel)
        S['bupa']['reopenAlways'] = False
        await portal.close()

        await ctx.close()
        await browser.close()

    print('\n%d failed' % len(FAILS) if FAILS else '\nAll passed')
    sys.exit(1 if FAILS else 0)

asyncio.run(main())
