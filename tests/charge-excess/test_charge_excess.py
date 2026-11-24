"""
Test for Charge excess, against a mock Halaxy with invented invoices (forms as captured on live Halaxy, 16 Nov 2026).

Checks: the button shows only on a patient invoice billed to its funder with something outstanding; nothing changes
before confirming; the confirm shows the amount, card, date and time, and recipient; on confirm, in this order, the due
date is set a week ahead (every other settings field unchanged), the email is sent from Halaxy's own template (inline
styles kept, merge tags wrapped as Halaxy's, the due date written in, Halaxy's sender and recipient fields as filled),
and a one-off payment of the outstanding amount is scheduled from the card on file for the same date at Halaxy's time;
it stops before changing anything with no card, a payment already scheduled or no email address; a refused schedule
says the email went and to schedule it by hand.

Run:  python3 tests/charge-excess/test_charge_excess.py
"""
import asyncio, datetime, json, re, sys, urllib.parse
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
CORE = (ROOT / 'beta' / 'core.user.js').read_text().replace('perMinute: 45,', 'perMinute: 100000,')
SCRIPT = (ROOT / 'beta' / 'charge-excess.user.js').read_text()
TODAY = datetime.date.today()
hx = lambda day: day.strftime('%d-%b-%Y')
DUE = hx(TODAY + datetime.timedelta(days=7))
FAILS = []


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  ' + str(detail)[:600]))
    if not ok:
        FAILS.append(name)


def fresh(**kw):
    S = {'calls': [], 'card': True, 'scheduled': 0, 'scheduled_at': '', 'email': 'patient@example.com', 'refuse_schedule': False, 'due': ''}
    S.update(kw)
    return S


S = fresh()


def invoice_html(iid):
    # 3001: patient invoice billed to Bupa, £ 40.00 outstanding (the excess). 3002: paid in full. 3003: still to bill.
    # 3004: an organisation (funder) invoice.
    lines = ("<tr><td data-property='date'><a href='/a/pr/555/appointment/1'>02-Nov-2026 09:00</a></td><td data-property='itemNumber'>Bup-FU</td>"
             "<td data-property='amount'>£ 60.00</td><td><a class='btn icon ajax' href='/a/pr/555/invoice/line/7%d/edit'>e</a></td></tr>" % iid)
    if iid == 3004:
        lines = lines.replace("/appointment/1'", "/invoice/3001'")
    pay = ''
    if iid in (3001, 3002):
        pay += "<tr><td></td><td>Invoice UPC-9001</td><td>Issued</td><td><a href='/a/pr/555/invoice/9001'>£ 20.00</a></td></tr>"
    if iid == 3003:
        pay += "<tr><td></td><td>Funder Payment</td><td></td><td>£ 20.00</td><td><a class='ajax btn' data-modal-href='/a/pr/555/invoicefunctions/3003/claim/77/' id='invoiceFunderBtn'>Invoice Funder</a></td></tr>"
    if iid != 3002:
        link = ("<a class='ajax link-text' data-modal-href='/a/pr/555/invoicefunctions/payment/scheduled/1866732/edit'>%s</a>" % ('Scheduled payment cancelled' if S['scheduled_at'] == 'cancelled' else 'Scheduled (%s)' % S['scheduled_at'])) if S['scheduled_at'] \
            else "<a class='ajax link-text' data-modal-href='/a/pr/555/invoicefunctions/payment/scheduled/new/invoice/%d'>Available</a>" % iid
        pay += ("<tr><td></td><td>Stored Payment Method</td><td>" + link + "</td><td>£ 40.00</td>"
                "<td><div class='btn-group'><a class='ajax btn btn-outline-primary-light' data-modal-href='/a/pr/555/invoicefunctions/%d/pay/securepay/1?bundle=prac'>Process Now</a><button class='btn dropdown-toggle'></button></div></td></tr>"
                "<tr><td></td><td></td><td>Outstanding</td><td>£ 40.00</td><td><a class='ajax btn btn-outline-primary-light' data-modal-href='/a/pr/555/invoicefunctions/%d/pay/offline'>Mark as Paid</a></td></tr>") % (iid, iid)
    title = 'Receipt' if iid == 3002 else 'Invoice'
    return ("<html><head><title>%s UPC-%d | Halaxy</title></head><body><div id='mainMenu'></div><div id='pageContent'>"
            "<div id='card-invoice-view-patient'><a href='/a/pr/555/patient/500'>Patient Test</a></div>"
            "<div id='card-invoice-parts-claim-view'><a href='/a/pr/555/organisation/7364'>Bupa Healthcare</a></div>"
            "<table id='invoiceLines'><tbody>%s<tr><td>Total</td><td>£ 60.00</td></tr></tbody></table>"
            "<table id='invoicePayments'><tbody>%s</tbody></table>"
            "<a id='btn-email-invoice' class='btn icon ajax' href='/a/pr/555/email/document/invoice/%d'>e</a></div></body></html>") % (title, iid, lines, pay, iid)


def options_popup():
    return ("<form id='frmInvoiceType' class='dialogBoxForm' method='post'><input name='form[prefix]' value='UPC'><input name='form[number]' value='3001'>"
            "<select name='form[status]'><option value='' selected>Active</option><option value='issued'>Issued</option></select>"
            "<input name='form[displayDate]' value='02-Nov-2026'><input name='form[dueDate]' value='%s'>"
            "<select name='form[template]'><option value='75272' selected>Urmston Physio Clinic</option></select>"
            "<input type='radio' name='form[showOrganisationPatientDetails]' value='1' checked><input type='radio' name='form[showOrganisationPatientDetails]' value='2'>"
            "<input type='hidden' name='form[_token]' value='tok-o'></form>") % S['due']


def schedule_popup():
    card = "<option value='667422' selected>Mastercard: Patient Test (**** 6429) Exp: Mar-2029</option>" if S['card'] else ''
    hours = ''.join("<option value='%d'%s>%02d</option>" % (h, ' selected' if h == 22 else '', h) for h in range(24))
    mins = ''.join("<option value='%d'%s>%02d</option>" % (m, ' selected' if m == 24 else '', m) for m in range(60))
    return ("<form id='newScheduledPaymentForm' method='post'><select name='form[creditCard]'>%s</select>"
            "<input type='hidden' name='form[paymentScheduled]' value=''>"
            "<input type='radio' name='form[paymentScheduled]' value='0' checked><input type='radio' name='form[paymentScheduled]' value='1'>"
            "<input name='form[amount]' value='40.00'><input name='form[scheduleDate][date]' value='%s'>"
            "<select name='form[scheduleDate][time][hour]'>%s</select><select name='form[scheduleDate][time][minute]'>%s</select>"
            "<input type='hidden' name='form[_token]' value='tok-s'><input type='hidden' name='form[isDeleted]' value=''>"
            "<input type='hidden' name='form[frequency]' value=''><select name='form[frequency]'><option value='1' selected>Manual</option></select>"
            "<input name='form[cycleAmount]' value=''><input name='form[numberOfPayments]' value=''>"
            "<input name='form[startDate][date]' value='%s'></form>"
            "<script>var isOneOffPayment = true; var balance = 0; var scheduledAmtTotal = %s; var maxCycles = 12;</script>") % (card, hx(TODAY), hours, mins, hx(TODAY), S['scheduled'])


def send_popup():
    return ("<form id='composeEmailForm' method='post'><input name='form[fromName]' value='Urmston Physio Clinic'>"
            "<select name='form[fromEmail]'><option value=''>Select sender email</option><option value='admin@urmstonphysioclinic.com' selected>admin</option></select>"
            "<textarea name='form[subject]'>Your receipt - Urmston Physio Clinic</textarea>"
            "<select name='form[recipientType]'><option value='LinkPaG' selected>Patient</option><option value='Other'>Other</option></select>"
            "<select name='form[toLinkPaGPaG]'><option value='' selected>Please select one</option></select>"
            "<input name='form[toEmail]' value='%s'><input name='form[ccEmail]' value=''><input name='form[bccEmail]' value='copies@example.com'>"
            "<select name='form[template]'><option value='' selected></option>" + ("" if S.get('no_template') else "<option value='93132'>Chase - Excess Due</option>") + "<option value='11972'>Chase - Excess Due (no card on file)</option></select>"
            "<textarea name='form[body]' class='form-control d-none'>&lt;p&gt;Hi Patient, Here's your receipt&lt;/p&gt;</textarea>"
            "<input type='hidden' name='form[_token]' value='tok-e'><input name='form[scheduleDetails][scheduleDate]' value=''></form>") % S['email']


async def halaxy(route):
    req = route.request
    p = urllib.parse.urlparse(req.url).path
    form = urllib.parse.parse_qs(req.post_data or '', keep_blank_values=True) if req.method == 'POST' else {}
    js = lambda o: route.fulfill(body=json.dumps(o), content_type='application/json')
    if re.search(r'/invoice/options/\d+$', p):
        if req.method == 'GET':
            return await js({'status': 'FORM', 'message': options_popup()})
        S['calls'].append(('options', form))
        S['due'] = form.get('form[dueDate]', [''])[0]
        return await js({'status': 'REFRESH'})
    if re.search(r'/invoicefunctions/payment/scheduled/new/invoice/\d+$', p):
        if req.method == 'GET':
            return await js({'status': 'FORM', 'title': 'Schedule Payment', 'message': schedule_popup()})
        S['calls'].append(('schedule', form))
        if S['refuse_schedule']:
            return await js({'status': 'FORM', 'message': schedule_popup().replace('</form>', "<div class='invalid-feedback'>The card was declined for scheduling.</div></form>")})
        # As live: the invoice then shows "Scheduled (date time)"; the pop-up's scheduledAmtTotal stays 0.
        S['scheduled_at'] = '%s %02d:%02d' % (form.get('form[scheduleDate][date]', [''])[0], int(form.get('form[scheduleDate][time][hour]', ['0'])[0]), int(form.get('form[scheduleDate][time][minute]', ['0'])[0]))
        return await js({'status': 'REFRESH'})
    m = re.search(r'/communication/template/render/(\d+)/invoice/(\d+)$', p)
    if m:
        # As Halaxy's Send box gets it: the template filled in for the invoice (name, due date), [Payment Link] and
        # [Action] left for sending (capture 16 Nov 2026). The due date is whatever the invoice has at that moment.
        S['calls'].append(('render', m.group(1)))
        body = ('<table width="100%%" bgcolor="#f0f0f5" style="background-color:#f0f0f5;"><tbody><tr><td bgcolor="#5c2899" style="padding:22px 12px 0 12px;">'
                '<p style="margin:0 0 6px 0;">Hi Patient,</p><p style="margin:0;">We\'ll take payment on %s</p>'
                '<p style="margin:0;"><strong>See the amount and pay:</strong> [Payment Link]</p></td></tr></tbody></table>') % S['due']
        return await js({'status': 'OK', 'title': 'Template', 'message': body, 'payload': {'subject': '<p>[Action] Insurance Excess Due - Payment on %s&nbsp;</p>' % S['due']}})
    if re.search(r'/email/document/invoice/\d+$', p):
        if req.method == 'GET':
            return await js({'status': 'FORM', 'title': 'Send Invoice Email', 'message': send_popup()})
        S['calls'].append(('email', form))
        return await js({'status': 'OK'})
    m = re.search(r'/invoice/(\d+)/?$', p)
    if m:
        return await route.fulfill(body=invoice_html(int(m.group(1))), content_type='text/html')
    await route.fulfill(status=404, body='not mocked: ' + p)


async def open_invoice(browser, iid):
    ctx = await browser.new_context(viewport={'width': 1300, 'height': 900})
    await ctx.route('https://eu.halaxy.com/**', halaxy)
    await ctx.add_init_script(CORE)
    await ctx.add_init_script("document.addEventListener('DOMContentLoaded', function () {\n" + SCRIPT + "\n});")
    pg = await ctx.new_page()
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    await pg.goto('https://eu.halaxy.com/a/pr/555/invoice/%d' % iid)
    await pg.wait_for_timeout(300)
    return ctx, pg, errors


DLG = "document.querySelector('[data-upc-dialog=charge-excess]')"


async def ask(pg):
    await pg.click('.upc-charge-excess')
    await pg.wait_for_function(DLG + " && !" + DLG + ".querySelector('.upc-run-inline')", timeout=30000)
    return await pg.evaluate(DLG + ".querySelector('.modal-body').innerText")


async def finish(pg):
    await pg.click("[data-upc-dialog=charge-excess] [data-a=go]")
    await pg.wait_for_function(DLG + " && " + DLG + ".querySelector('[data-a=reload]')", timeout=30000)
    return await pg.evaluate(DLG + ".querySelector('.modal-body').innerText")


async def main():
    global S
    async with async_playwright() as p:
        browser = await p.chromium.launch()

        # Where the button shows
        shown = {}
        for iid in (3001, 3002, 3003, 3004):
            S = fresh()
            ctx, pg, errors = await open_invoice(browser, iid)
            shown[iid] = await pg.evaluate("!!document.querySelector('.upc-charge-excess')")
            if iid == 3001:
                place = await pg.evaluate("(() => { const b = document.querySelector('.upc-charge-excess'); return [b.className, b.previousElementSibling && b.previousElementSibling.classList.contains('btn-group') && b.previousElementSibling.textContent, b.textContent]; })()")
            await ctx.close()
        check('button on a patient invoice billed to its funder with something outstanding', shown[3001], shown)
        check('no button when paid in full, still to bill, or on a funder invoice', not shown[3002] and not shown[3003] and not shown[3004], shown)
        check('"Schedule Excess" next to Process Now (after its drop-down), in Halaxy\'s style', place[1] == 'Process Now' and place[2] == 'Schedule Excess' and 'btn-outline-primary-light' in place[0], place)

        # Confirm, then the three steps in order
        S = fresh()
        ctx, pg, errors = await open_invoice(browser, 3001)
        text = await ask(pg)
        now = datetime.datetime.now()
        check('confirm: amount, invoice, due date, card and time now, template and recipient',
              'Schedule the £ 40.00 excess on UPC-3001?' in text and DUE in text and 'Mastercard: Patient Test (**** 6429)' in text and ' at %02d:' % now.hour in text
              and 'Chase - Excess Due' in text and 'patient@example.com' in text and 'Exp:' not in text, text)
        check('nothing changed before confirming', S['calls'] == [], S['calls'])
        text = await finish(pg)
        order = [c[0] for c in S['calls']]
        check('due date, then the template (filled with the new due date), then email, then payment', order == ['options', 'render', 'email', 'schedule'] and S['calls'][1][1] == '93132', S['calls'])
        o = dict((k, v[0]) for k, v in S['calls'][0][1].items())
        check('due date a week ahead, every other setting as Halaxy filled it', o.get('form[dueDate]') == DUE and o.get('form[status]') == '' and o.get('form[displayDate]') == '02-Nov-2026'
              and o.get('form[template]') == '75272' and o.get('form[showOrganisationPatientDetails]') == '1' and o.get('form[_token]') == 'tok-o', o)
        e = dict((k, v[0]) for k, v in S['calls'][2][1].items())
        body = e.get('form[body]', '')
        check('email: the template\'s subject as plain text, with the due date', e.get('form[subject]') == '[Action] Insurance Excess Due - Payment on ' + DUE, e.get('form[subject]'))
        check('email: the template as Halaxy filled it, inline styles kept, [Payment Link] wrapped as Halaxy\'s',
              'bgcolor="#5c2899"' in body and 'background-color:#f0f0f5' in body and '<span class="dynamicterm">[Payment Link]</span>' in body
              and 'Hi Patient,' in body and "We'll take payment on " + DUE in body and 'receipt' not in body, body[:400])
        check('email: Halaxy\'s sender, recipient and copies as filled; no template chosen', e.get('form[fromEmail]') == 'admin@urmstonphysioclinic.com' and e.get('form[recipientType]') == 'LinkPaG'
              and e.get('form[toEmail]') == 'patient@example.com' and e.get('form[bccEmail]') == 'copies@example.com' and e.get('form[template]') == '' and e.get('form[_token]') == 'tok-e', e)
        s = S['calls'][3][1]
        check('payment: one-off, the outstanding amount, the card, exactly a week ahead (not Halaxy\'s 22:24)',
              s.get('form[paymentScheduled]') == ['', '0'] and s.get('form[amount]') == ['40.00'] and s.get('form[creditCard]') == ['667422']
              and s.get('form[scheduleDate][date]') == [DUE] and s.get('form[scheduleDate][time][hour]') == [str(now.hour)] and abs(int(s.get('form[scheduleDate][time][minute]', ['-9'])[0]) - now.minute) <= 1, s)
        check('done: says what happened', 'Due date set to ' + DUE in text and 'Email sent to patient@example.com' in text and '£ 40.00 scheduled from' in text, text)
        check('no page errors', not errors, errors)
        await ctx.close()

        # Stops before changing anything
        for name, kw, want in [('no card on file', {'card': False}, 'No card on file'), ('already scheduled (pop-up)', {'scheduled': 40}, 'already scheduled'),
                               ('already scheduled (on the invoice)', {'scheduled_at': DUE + ' 10:00'}, 'already scheduled on UPC-3001: Scheduled (' + DUE + ' 10:00)'), ('no email address', {'email': ''}, 'No email address'), ('no such template', {'no_template': True}, 'No "Chase - Excess Due" template')]:
            S = fresh(**kw)
            ctx, pg, errors = await open_invoice(browser, 3001)
            text = await ask(pg)
            check(name + ': says so, changes nothing', want in text and S['calls'] == [] and not await pg.evaluate(DLG + ".querySelector('[data-a=go]')"), (text, S['calls']))
            await ctx.close()

        # A cancelled scheduled payment (Halaxy keeps the link, "Scheduled payment cancelled"): schedules again
        S = fresh(scheduled_at='cancelled')
        ctx, pg, errors = await open_invoice(browser, 3001)
        text = await ask(pg)
        check('after a cancelled schedule: asks as normal', 'Schedule the £ 40.00 excess on UPC-3001?' in text, text)
        text = await finish(pg)
        check('after a cancelled schedule: schedules and finds it', [c[0] for c in S['calls']] == ['options', 'render', 'email', 'schedule'] and '£ 40.00 scheduled from' in text, (text, [c[0] for c in S['calls']]))
        await ctx.close()

        # Scheduling refused after the email went
        S = fresh(refuse_schedule=True)
        ctx, pg, errors = await open_invoice(browser, 3001)
        await ask(pg)
        text = await finish(pg)
        check('schedule refused: email sent, says to schedule by hand', 'Email sent' in text and 'declined' in text and 'schedule it by hand' in text and DUE in text, text)
        await ctx.close()
        await browser.close()

    print('\n' + ('All passed' if not FAILS else '%d failed' % len(FAILS)))
    sys.exit(1 if FAILS else 0)


asyncio.run(main())
