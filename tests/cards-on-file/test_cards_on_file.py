"""
Test for Cards on file, against a mock Halaxy (invented patients and cards). Clock: 22-Nov-2026.

Checks: the Credit Card Expiry report, the patient list and the Unpaid Invoices report are read; a card comes off the
list only when its patient has nothing booked, no unpaid invoice of their own (by patient number), no unpaid insurer
invoice (by name in the payer, title and preferred name ignored) and was last seen more than 28 days ago; never-seen
patients and patients not in the patient list are left out; the line under the list gives the rule and the counts;
ticking and "Remove 2" asks once, then each card is removed through Halaxy's Delete credit card pop-up and the Funding
tab is read again; a card no longer on the Funding tab is reported, not guessed; only CH sees the page.

Run:  python3 tests/cards-on-file/test_cards_on_file.py
"""
import asyncio, datetime, json, re, sys, urllib.parse
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
CORE = (ROOT / 'beta' / 'core.user.js').read_text().replace('perMinute: 45,', 'perMinute: 100000,')
SCRIPT = (ROOT / 'beta' / 'cards-on-file.user.js').read_text()
NOW = datetime.datetime(2026, 11, 22, 12, 0, tzinfo=datetime.timezone.utc)
FAILS = []
S = {}


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)[:600]))
    if not ok:
        FAILS.append(name)


# id, report name, patient number, given, surname, last, next, cards [(card id, last4, type, expiry)]
PEOPLE = [
    (201, 'Mrs Alice (Ali) Done', 'P-000201', 'Alice', 'Done', '01/06/2026 10:00', '', [(901, '1111', 'Visa', 'Mar 2029'), (902, '2222', 'Mastercard', 'Jan 2027')]),
    (202, 'Mr Bob Booked', 'P-000202', 'Bob', 'Booked', '01/06/2026 10:00', '01/12/2026 10:00', [(903, '3333', 'Visa', 'Apr 2028')]),
    (203, 'Ms Cara Owes', 'P-000203', 'Cara', 'Owes', '01/06/2026 10:00', '', [(904, '4444', 'Visa', 'May 2028')]),
    (204, 'Dr Dan (Danny) Insured', 'P-000204', 'Dan', 'Insured', '01/06/2026 10:00', '', [(905, '5555', 'Visa', 'Jun 2028')]),
    (205, 'Mr Eve Recent', 'P-000205', 'Eve', 'Recent', '10/11/2026 10:00', '', [(906, '6666', 'Visa', 'Jul 2028')]),
    (206, 'Mr Finn Never', 'P-000206', 'Finn', 'Never', '', '', [(907, '7777', 'Visa', 'Aug 2028')]),
    (207, 'Mrs Gail Gone', 'P-000207', 'Gail', 'Gone', '01/01/2025 10:00', '', [(908, '8888', 'Amex', 'Feb 2027')]),
]
NOT_LISTED = (299, 'Mr Hidden Patient', [(909, '9999', 'Visa', 'Jan 2030')])


def card_report():
    rows = []
    for pid, name, _, _, _, _, _, cards in PEOPLE:
        for cid, last4, typ, exp in cards:
            rows.append((pid, name, 'Current', last4, typ, exp))
    for cid, last4, typ, exp in NOT_LISTED[2]:
        rows.append((NOT_LISTED[0], NOT_LISTED[1], 'Deleted', last4, typ, exp))
    body = ''.join("<tr><td><a href='/a/pr/555/patient/%d/funding'>%s</a></td><td>%s</td><td>XXXX-XXXX-XXXX-%s</td><td>%s</td><td>%s</td></tr>" % r for r in rows)
    return "<html><body><table class='table table-report'><thead><tr><th>Patient</th><th>Status</th><th>Card</th><th>Type</th><th>Expiry</th></tr></thead><tbody>%s</tbody></table></body></html>" % body


COLS = ['Invoice / Deposit', 'Date', 'Due Date', 'Practitioner', 'Payer ID', 'Payer', 'Funder', 'Category', 'Fee', 'Quantity', 'Appointment Status', 'Invoice Status', 'Tax', 'Amount', 'Payments', 'Date', 'Method', 'Payments Inc. Fees', 'Balance']


def unpaid_report():
    def row(iid, payer_id, payer, funder, balance):
        return ("<a href='/a/pr/555/invoice/%d'>UPC-0%d</a>" % (iid, iid), '01-Jun-2026', '', 'Prac One', payer_id, payer, funder, 'Treatment', 'Fee', '1', 'Attended', 'Active', '£0.00', balance, '', '', '', '', balance)
    rows = [row(5001, 'P-000203', 'Cara Owes', 'Self-Funded', '£40.00'),
            row(5002, '7364', 'Bupa Healthcare / (Daniel Insured)', 'Bupa', '£60.00'),
            row(5003, '7364', 'Bupa Healthcare / (Dan Insured)', 'Bupa', '£60.00'),
            row(5004, 'P-000201', 'Alice Done', 'Self-Funded', '£0.00')]
    body = ''.join('<tr>%s</tr>' % ''.join('<td>%s</td>' % x for x in r) for r in rows)
    return ("<html><body><table class='table-report'><thead><tr><th colspan='13'>Fees &amp; Charges</th><th colspan='6'>Payments</th></tr><tr>%s</tr></thead><tbody>%s</tbody></table></body></html>"
            % (''.join('<th>%s</th>' % c for c in COLS), body))


def patient_rows():
    return [{'id': pid, 'givenName': g, 'surname': sn, 'preferredName': '', 'patientNum': num, 'status': 'Current', 'dateOfBirth': '01/01/1980',
             'lastAppointment': last, 'nextAppointment': nxt, 'created': '01/01/2020'} for pid, _, num, g, sn, last, nxt, _ in PEOPLE] + \
           [{'id': 3000 + i, 'givenName': 'Filler', 'surname': str(i), 'preferredName': '', 'patientNum': 'P-9%05d' % i, 'status': 'Current', 'dateOfBirth': '',
             'lastAppointment': '01/01/2024 10:00', 'nextAppointment': '', 'created': '01/01/2020'} for i in range(120)]


def funding(pid):
    cards = next((c for p in PEOPLE if p[0] == pid for c in [p[7]]), [])
    left = [c for c in cards if c[0] not in S['deleted'] and c[0] not in S['vanished']]
    items = ''.join("<div class='card'><div class='card-body'><div>Visa</div><div>Number XXXX-XXXX-XXXX-%s</div><div>Expiry %s</div>"
                    "<a id='replaceCardBtn' class='ajax btn icon' href='/a/pr/555/patient/linkpag/%d/creditcard/%d'><i></i></a><a id='deleteCreditCardBtn' class='ajax btn icon' title='Remove credit card' href='/a/pr/555/patient/%d/creditcard/%d/delete'><i class='icon-trash'></i></a></div></div>"
                    % (last4, exp, pid, cid, pid, cid) for cid, last4, typ, exp in left)
    return ("<html><body><div id='pageContent'><h1>Funding</h1>%s<a id='createCreditCardDetailsBtn' class='btn btn-outline-primary-light ajax' href='/a/pr/555/patient/linkpag/%d/creditcard'>Add card</a></div></body></html>"
            % (items, pid))


def page_html(user):
    return ("<!doctype html><html><head><title>Patient List | Halaxy</title></head><body style='margin:0 0 0 230px'>"
            "<div style='position:fixed;left:0;top:0;bottom:0;width:218px'><nav id='side'><ul id='mainMenu'>"
            "<li class='mainmenu-item active'><a class='mainmenu-link'><span class='mainmenu-link-label'>Patients</span></a>"
            "<ul><li class='active'><a class='mainmenu-sublink active' href='/a/pr/555/patient/'>Patient List</a></li></ul></li></ul></nav></div>"
            "<div id='headerWrapper' style='height:50px'></div><div id='pageContent'><h1>Patient List</h1></div>"
            "<script>window.HkUser = { linkPrG: 11, pracID: 11, pracName: %s };</script></body></html>") % json.dumps(user)


async def halaxy(route):
    req = route.request
    u = urllib.parse.urlparse(req.url)
    p, q = u.path, urllib.parse.parse_qs(u.query)
    js = lambda o: route.fulfill(body=json.dumps(o), content_type='application/json')
    if p.endswith('/report/finance/0'):
        t = q.get('type', [''])[0]
        S['reports'].append(t)
        if t == '26':
            S['expiry'] = (q.get('startExpiry', [''])[0], q.get('stopExpiry', [''])[0])
            return await route.fulfill(body=card_report(), content_type='text/html')
        return await route.fulfill(body=unpaid_report(), content_type='text/html')
    if p.endswith('/patient/list-data') and req.method == 'POST':
        b = json.loads(req.post_data or '{}')
        rows = patient_rows()
        S['lists'] += 1
        return await js({'rowData': rows[b['startRow']:b['endRow']], 'lastRow': len(rows)})
    m = re.search(r'/patient/(\d+)/funding$', p)
    if m:
        S['fundings'].append(int(m.group(1)))
        return await route.fulfill(body=funding(int(m.group(1))), content_type='text/html')
    m = re.search(r'/patient/(\d+)/creditcard/(\d+)/delete$', p)
    if m:
        return await js({'status': 'FORM', 'title': 'Delete credit card', 'message': "<p>Delete this card?</p><a class='btn btn-outline-primary btn-cancel'>Cancel</a>"
                         "<a class='btn btn-danger' href='/a/pr/555/patient/%s/creditcard/%s/delete/ab12cd'>Delete</a>" % m.groups()})
    m = re.search(r'/patient/(\d+)/creditcard/(\d+)/delete/ab12cd$', p)
    if m:
        await asyncio.sleep(0.5)
        S['deleted'].append(int(m.group(2)))
        return await js({'status': 'REFRESH'})
    await route.fulfill(body=page_html(S['user']), content_type='text/html')


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        S.update({'reports': [], 'lists': 0, 'fundings': [], 'deleted': [], 'vanished': [], 'user': 'Carl Healy'})
        ctx = await browser.new_context(viewport={'width': 1400, 'height': 900}, timezone_id='Europe/London')
        await ctx.clock.install(time=NOW.isoformat())
        await ctx.route('https://eu.halaxy.com/**', halaxy)
        await ctx.add_init_script(CORE)
        await ctx.add_init_script("document.addEventListener('DOMContentLoaded', function () {\n" + SCRIPT + "\n});")
        pg = await ctx.new_page()
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/')
        await pg.wait_for_selector('a.upc-sc-menu', timeout=20000)
        await pg.click('a.upc-sc-menu')
        await pg.wait_for_selector('[data-upc-stored-cards] .card', timeout=20000)
        rows = await pg.evaluate("[...document.querySelectorAll('[data-upc-list=due] tbody tr')].map((tr) => [...tr.cells].map((x) => x.textContent.trim()))")
        head = await pg.evaluate("document.querySelector('[data-upc-stored-cards] .card h2').textContent")
        check('read: the card report (every expiry), the patient list, the Unpaid Invoices report', S['reports'] == ['26', '5'] and S['expiry'] == ('01-2000', '12-2060') and S['lists'] == 2, (S['reports'], S.get('expiry'), S['lists']))
        check('no longer needed: last seen over 28 days ago, nothing booked or owed (oldest first; both of a patient\'s cards)',
              head == 'No Longer Needed (3)' and [r[1] for r in rows] == ['Mrs Gail Gone', 'Mrs Alice (Ali) Done', 'Mrs Alice (Ali) Done'], (head, rows))
        check('a row: status, card, expiry, last appointment', rows[0][2:6] == ['Current', 'Amex ending 8888', 'Feb 2027', '01-Jan-2025'], rows[:1])
        text = json.dumps(rows)
        check('kept: booked, owing on their own invoice, an unpaid insurer invoice in their name (title and preferred name ignored), seen recently, never seen, not in the patient list',
              not any(n in text for n in ['Bob Booked', 'Cara Owes', 'Dan', 'Eve Recent', 'Finn Never', 'Hidden']), text)
        line = await pg.evaluate("[...document.querySelectorAll('[data-upc-stored-cards] p.text-muted')].pop().textContent")
        check('the line under the list: the rule and the counts', line == 'Nothing booked or owed, last appointment before 25-Oct-2026. 5 of 9 cards kept; 1 for patients not in the patient list left out.', line)
        check('nothing removed without asking', not S['deleted'] and not S['fundings'])

        S['vanished'].append(902)   # removed by hand meanwhile
        ids = await pg.evaluate("[...document.querySelectorAll('[data-upc-list=due] tbody tr')].map((tr) => tr.dataset.upcId)")
        for k in ids:
            await pg.check("[data-upc-list=due] tr[data-upc-id='%s'] input[data-upc-tick]" % k)
        await pg.click('[data-a=bulk]')
        await pg.wait_for_selector('[data-upc-sc-confirm]')
        conf = await pg.evaluate("document.querySelector('[data-upc-sc-confirm]').innerText")
        check('asks once: how many cards, how many patients, whose', "Remove 3 cards from 2 patients?" in conf and 'Mrs Gail Gone (8888)' in conf, conf)
        await pg.click('[data-upc-sc-confirm] [data-c=yes]')
        await pg.wait_for_function("[...document.querySelectorAll('[data-upc-list=due] tbody tr')].filter((tr) => /Removed|Not changed/.test(tr.textContent)).length === 3", timeout=30000)
        check('removed through the Delete credit card pop-up, one at a time, the Funding tab read before and after', sorted(S['deleted']) == [901, 908] and S['fundings'].count(207) == 2, (S['deleted'], S['fundings']))
        errs = await pg.evaluate("[...document.querySelectorAll('[data-upc-stored-cards] .alert-danger')].map((x) => x.textContent)")
        check('a card no longer on the Funding tab: said, nothing guessed', errs == ['Not changed: Mrs Alice (Ali) Done, card ending 2222 (the card is no longer on the Funding tab)'], errs)
        await pg.wait_for_function("document.querySelector('.upc-toast')", timeout=10000)
        msg = await pg.evaluate("document.querySelector('.upc-toast').textContent")
        check('a toast when the batch is over', msg == '2 removed. 1 not changed.', msg)
        look = await pg.evaluate("(() => { const r = document.querySelector('[data-upc-stored-cards]'); return r.classList.contains('upc-native') && !r.shadowRoot && r.querySelector('table').className.startsWith('table table-striped table-bordered'); })()")
        check('Halaxy look', look)
        check('no page errors', not errors, errors)
        await ctx.close()

        S.update({'reports': [], 'user': 'Physio One'})
        ctx = await browser.new_context(timezone_id='Europe/London')
        await ctx.route('https://eu.halaxy.com/**', halaxy)
        await ctx.add_init_script(CORE)
        await ctx.add_init_script("document.addEventListener('DOMContentLoaded', function () {\n" + SCRIPT + "\n});")
        pg = await ctx.new_page()
        await pg.goto('https://eu.halaxy.com/a/pr/555/patient/#upc-cards-on-file')
        await pg.wait_for_timeout(3000)
        check('someone else: no menu item, no page, nothing read', not await pg.evaluate("!!document.querySelector('a.upc-sc-menu, [data-upc-stored-cards]')") and not S['reports'])
        await browser.close()
    print('\n' + ('All passed' if not FAILS else '%d failed' % len(FAILS)))
    sys.exit(1 if FAILS else 0)


asyncio.run(main())
