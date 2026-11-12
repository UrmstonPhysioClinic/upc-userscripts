"""
Invented remittances in each insurer's layout, built at test time (never stored in the repository).
Typed layouts (WPA, Bupa) are real text PDFs; scanned layouts (AXA, Aviva) are image-only PDFs so the
test exercises text recognition the way a scanner's output would. No real patients or amounts.
"""
import io
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from PIL import Image, ImageDraw, ImageFont

W, H = A4
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
MONO = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'


def _text_pdf(draw):
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    draw(c)
    c.save()
    return buf.getvalue()


def wpa():
    def d(c):
        c.setFont('Helvetica', 9)
        c.drawString(330, H - 90, 'Unique Payment Reference Date: 08-Oct-2026')
        c.drawString(330, H - 104, 'Provider No: 900000001')
        c.drawString(40, H - 104, 'Test Clinic')
        c.drawString(40, H - 118, '1 Test Street')
        c.drawString(40, H - 132, 'Testtown')
        y = H - 200
        heads = [(40, 'Your Reference'), (120, "Patient's Initials"), (200, 'Invoice Date'), (270, 'WPA Invoice ID'),
                 (340, 'Amount Claimed'), (400, "Patient's Liability"), (460, 'Provider Shortfall'), (510, 'Amount Paid'), (560, 'Code')]
        for x, t in heads:
            c.drawString(x, y, t)
        rows = [('UPC-40001', 'AA', '01/10/2026', '931000001', '£60.00', '£0.00', '£0.00', '£60.00', ''),
                ('UPC-40002', 'BB', '02/10/2026', '931000002', '£180.00', '£36.00', '£0.00', '£144.00', '(1)'),
                ('UPC-40003', 'CC', '02/10/2026', '931000003', '£60.00', '£0.00', '£10.00', '£50.00', '(4)')]
        for i, r in enumerate(rows):
            yy = y - 22 - i * 18
            for (x, _), t in zip(heads, r):
                c.drawString(x, yy, t)
        c.drawString(40, y - 100, 'Balance:')
        c.drawString(510, y - 100, '£254.00')
        c.drawString(40, y - 140, 'Please read our privacy policy at www.wpa.org.uk/privacy')
    return _text_pdf(d)


def bupa():
    def d(c):
        c.setFont('Helvetica', 9)
        c.drawString(40, H - 60, 'Bupa Provider Service Centre')
        c.drawString(40, H - 90, 'Provider Statement')
        c.drawString(40, H - 105, 'Provider number: 80000001')
        c.drawString(300, H - 105, 'BACS reference: 1234567')
        c.drawString(40, H - 120, 'Payment date: 9 October 2026')
        y = H - 170
        cols = [40, 110, 210, 280, 330, 390, 440, 490, 540]
        for x, t in zip(cols, ['Your invoice', 'Patient name', 'Treatment', 'Charge', 'Benefit', 'Benefit prev', 'Credit', 'Debit', '']):
            c.drawString(x, y, t)
        rows = [('UPC-400', '11', 'Patient, One', ['10/09/26', '24/09/26'], ['120.00', '80.00', '0.00', '80.00', '0.00'], '2'),
                ('UPC-400', '12', 'Patient, Two', ['15/09/26'], ['60.00', '60.00', '0.00', '60.00', '0.00'], ''),
                # one invoice over three rows, as Bupa does (live, 12 Nov 2026)
                ('UPC-400', '13', 'Patient, Three', ['24/09/26'], ['50.00', '40.00', '0.00', '40.00', '0.00'], '1'),
                ('UPC-400', '13', 'Patient, Three', ['01/10/26', '09/10/26'], ['80.00', '64.00', '0.00', '64.00', '0.00'], '1'),
                ('UPC-400', '13', 'Patient, Three', ['16/10/26'], ['40.00', '32.00', '0.00', '32.00', '0.00'], '1')]
        yy = y - 22
        for inv, tail, name, dates, money, note in rows:
            c.drawString(cols[0], yy, inv)
            c.drawString(cols[0], yy - 11, tail)
            c.drawString(cols[1], yy, name)
            c.drawString(cols[2], yy, dates[0])
            if len(dates) > 1:
                c.drawString(cols[2] + 10, yy - 11, '-')
                c.drawString(cols[2], yy - 22, dates[1])
            for x, m in zip(cols[3:8], money):
                c.drawRightString(x + 35, yy, m)
            if note:
                c.drawString(cols[8], yy, note)
            yy -= 40
        c.drawString(40, yy - 10, 'Balance payable')
        c.drawString(480, yy - 10, '£ 276.00')
        c.drawString(40, yy - 40, 'Notes:')
        c.drawString(40, yy - 54, '1      This account has been assessed under the terms of the patient\'s scheme. Any outstanding treatment costs are due from the patient.')
        c.drawString(40, yy - 68, '2      The unpaid balance of the invoice includes the patient\'s excess due under the terms of their scheme.')
    return _text_pdf(d)


def _scan_pdf(lines):
    """lines: [(x_pt, y_pt_from_top, text, mono)] drawn at 300 dpi into an image-only PDF."""
    scale = 300 / 72
    img = Image.new('RGB', (int(W * scale), int(H * scale)), 'white')
    dr = ImageDraw.Draw(img)
    sans = ImageFont.truetype(FONT, int(9 * scale))
    mono = ImageFont.truetype(MONO, int(9 * scale))
    for x, y, t, m in lines:
        dr.text((x * scale, y * scale), t, fill='black', font=mono if m else sans)
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    ib = io.BytesIO()
    img.save(ib, format='JPEG', quality=90)
    ib.seek(0)
    from reportlab.lib.utils import ImageReader
    c.drawImage(ImageReader(ib), 0, 0, W, H)
    c.save()
    return buf.getvalue()


def axa():
    L = [(40, 60, 'AXA Health', False), (330, 100, 'Date 11.10.2026', False), (330, 114, 'Document 1900000001', False),
         (40, 170, 'Patient name / Membership   Claim      Invoice     Amount', False),
         (40, 184, 'Your reference              Number     Amount      Paid', False),
         (40, 214, 'PATIENT THREE   1000001A   F11/01                30.00', True),
         (40, 228, 'UPC-40021', True),
         (52, 244, 'We have been unable to pay this claim in full, because of a member contribution.', False),
         (40, 274, 'PATIENT FOUR    1000002B   F12/02               120.00', True),
         (40, 288, 'UPC-40022', True),
         (40, 330, 'Total GBP', False), (420, 330, '150.00', True)]
    return _scan_pdf(L)


def aviva():
    L = [(40, 50, 'Aviva Health UK', False), (40, 90, 'STATEMENT OF ACCOUNT', False), (40, 110, '11 October 2026', False),
         (330, 110, 'Our Ref: A10001', False), (40, 140, 'Invoice Number: UPC-40031', False),
         (40, 190, 'Description', False), (135, 190, 'Dates of Service', False), (245, 190, 'Units', False),
         (285, 190, 'Amount', False), (337, 190, 'Amount', False), (385, 190, 'Deduction/s', False),
         (140, 203, 'From', False), (190, 203, 'To', False), (283, 203, 'Invoiced', False), (340, 203, 'Paid', False),
         (383, 203, 'Amount', False), (428, 203, 'Reason', False)]
    rows = [('Professional Fee', '05/09/26', '55.00', '55.00', '', ''), ('Professional Fee', '12/09/26', '45.00', '', '45.00', 'A*'),
            ('Professional Fee', '19/09/26', '45.00', '35.00', '10.00', 'A*')]
    y = 225
    for d, dt, inv, paid, ded, rs in rows:
        L.append((40, y, d, False))
        L.append((135, y, dt + ' ' + dt, True))
        L.append((248, y, '1', True))
        L.append((285, y, inv, True))
        if paid:
            L.append((337, y, paid, True))
        if ded:
            L.append((385, y + 3, ded, True))   # deductions sit a little low, as on the real statements
            L.append((428, y + 3, rs, True))
        y += 16
    L += [(40, y + 20, 'Total Invoiced  145.00', True), (40, y + 36, 'Total Paid      90.00', True), (40, y + 52, 'Total Deducted  55.00', True),
          (40, y + 80, '*A An excess has been deducted from this invoice.', False)]
    return _scan_pdf(L)


if __name__ == '__main__':
    import sys, pathlib
    out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '.')
    for n, f in (('wpa', wpa), ('bupa', bupa), ('axa', axa), ('aviva', aviva)):
        (out / (n + '.pdf')).write_bytes(f())
