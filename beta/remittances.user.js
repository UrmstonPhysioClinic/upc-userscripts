// ==UserScript==
// @name         UPC Billing: Remittances (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.3.12
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/remittances.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/remittances.user.js
// @description  Reports > Remittances: read an insurer remittance (Bupa, WPA, AXA, Aviva; typed or scanned PDF), match each line to its Halaxy invoice, flag differences, and move excesses to the patient after one confirmation. Never records payments.
// @match        https://*.halaxy.com/a/pr/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * How it works
 * 1. Read: the PDF is opened in the browser (pdf.js). Typed PDFs give their words and positions
 *    directly; scanned pages are recognised in the browser (Tesseract.js). Nothing is uploaded.
 * 2. Understand: each insurer's layout has its own reader, which produces invoice numbers, what was
 *    claimed and paid, and why anything wasn't. The result is checked against the remittance's
 *    own totals; anything that doesn't add up is flagged rather than guessed.
 * 3. Match: each UPC number is looked up in Halaxy and compared with the organisation invoice.
 * 4. Apply (after one confirmation): for an excess or patient share, the funder line is reverted,
 *    the rebate lowered and the rest re-billed to the same organisation invoice (UPC.rebate).
 *    The remittance PDF is attached to each matched invoice. No payments are recorded.
 * Needs the core library (core.user.js).
 */

(function () {
  'use strict';
  if (window.__upcRemittances) return;
  window.__upcRemittances = true;

  const VERSION = '0.3.12';
  const ROUTE = 'upc-remittances';
  const MENU_CLS = 'upc-remit-menu';
  const CDN = 'https://cdn.jsdelivr.net/npm/';
  const LIBS = {
    pdf: CDN + 'pdfjs-dist@3.11.174/build/pdf.min.js',
    pdfWorker: CDN + 'pdfjs-dist@3.11.174/build/pdf.worker.min.js',
    tesseract: CDN + 'tesseract.js@5.1.1/dist/tesseract.min.js',
    tessWorker: CDN + 'tesseract.js@5.1.1/dist/worker.min.js',
    tessCore: CDN + 'tesseract.js-core@5.1.1',
    tessLang: CDN + '@tesseract.js-data/eng@1.0.0/4.0.0_best_int',
  };
  const SCAN_SCALE = 3;           // render scans at 216 dpi for recognition
  const MIN_TEXT_ITEMS = 15;      // fewer words than this on a page means it is a scan

  // ================================================================== reading a PDF into positioned words

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const pad = (n) => String(n).padStart(2, '0');
  // '05/06/26', '05/06/2026', '05-Jun-2026', '5 June 2026' -> '2026-06-05'
  function isoDate(s) {
    s = String(s || '').trim();
    let m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2}|\d{4})$/);
    if (m) return (m[3].length === 2 ? '20' + m[3] : m[3]) + '-' + pad(m[2]) + '-' + pad(m[1]);
    m = s.match(/^(\d{1,2})[- ]([A-Za-z]{3})[A-Za-z]*[- ](\d{4})$/);
    if (m && MONTHS[m[2].toLowerCase()]) return m[3] + '-' + pad(MONTHS[m[2].toLowerCase()]) + '-' + pad(m[1]);
    return null;
  }
  const DATE_RE = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;
  const MONEY_RE = /^£?-?\d{1,6}\.\d{2}$/;
  const cents = (t) => Math.round(parseFloat(String(t).replace(/[£,]/g, '')) * 100);
  const fmt = (c) => UPC.money.fmt(c);   // £ 40.00, as Halaxy
  // OCR reads UPC-37536 as 'UPC=37536', 'UPC-375 36', 'UPC—37536' and so on.
  const UPC_RE = /U\s*P\s*C\s*[-=+–—_.:~]?\s*(\d{3,6})/i;

  // Splits a text item into words, sharing its width out by character count.
  function splitItem(str, x, y, w, h, page) {
    const out = [];
    const total = str.length || 1;
    let pos = 0;
    str.split(/(\s+)/).forEach((part) => {
      if (part && !/^\s+$/.test(part)) {
        const x0 = x + (pos / total) * w;
        out.push({ text: part, x0, x1: x0 + (part.length / total) * w, y0: y - h, y1: y, page });
      }
      pos += part.length;
    });
    return out;
  }

  // Groups words into rows: words whose vertical centres are within half a line of each other.
  function toRows(words) {
    const sorted = words.slice().sort((a, b) => a.page - b.page || (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
    const rows = [];
    for (const w of sorted) {
      const yc = (w.y0 + w.y1) / 2;
      const h = Math.max(4, w.y1 - w.y0);
      const row = rows.length && rows[rows.length - 1];
      if (row && row.page === w.page && Math.abs(yc - row.yc) < Math.max(h, row.h) * 0.55) {
        row.words.push(w);
        row.yc = (row.yc * (row.words.length - 1) + yc) / row.words.length;
      } else {
        rows.push({ page: w.page, yc, h, words: [w] });
      }
    }
    rows.forEach((r) => {
      r.words.sort((a, b) => a.x0 - b.x0);
      r.text = r.words.map((w) => w.text).join(' ');
    });
    return rows;
  }

  // Common recognition slips in amounts: '$5.00' for 55.00, '35,00' for 35.00, 'O' for 0.
  function fixOcr(t) {
    let s = String(t || '');
    if (/^[$S][\d,]*\d[.,]\d{2}$/.test(s)) s = '5' + s.slice(1);
    if (/^\d{1,5},\d{2}$/.test(s)) s = s.replace(',', '.');
    if (/^[\dO]{1,5}\.[\dO]{2}$/.test(s)) s = s.replace(/O/g, '0');
    return s;
  }

  let ocrWorker = null;
  async function ocr(canvas, status) {
    const T = await UPC.load.script(LIBS.tesseract, 'Tesseract');
    if (!ocrWorker) {
      status('Preparing text recognition (first time takes a little longer)...');
      ocrWorker = await T.createWorker('eng', 1, { workerPath: LIBS.tessWorker, corePath: LIBS.tessCore, langPath: LIBS.tessLang, workerBlobURL: true });
      await ocrWorker.setParameters({ preserve_interword_spaces: '1' });
    }
    const { data } = await ocrWorker.recognize(canvas);
    return (data.words || []).map((w) => ({ text: w.text, x0: w.bbox.x0, x1: w.bbox.x1, y0: w.bbox.y0, y1: w.bbox.y1, conf: w.confidence }));
  }

  async function readPdf(file, status) {
    status = status || (() => {});
    const lib = await UPC.load.script(LIBS.pdf, 'pdfjsLib');
    if (lib.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) lib.GlobalWorkerOptions.workerSrc = LIBS.pdfWorker;
    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await lib.getDocument({ data }).promise;
    const words = [];
    let scanned = 0;
    for (let p = 1; p <= doc.numPages; p++) {
      status('Reading page ' + p + ' of ' + doc.numPages + '...');
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const items = tc.items.filter((it) => it.str && it.str.trim());
      if (items.length >= MIN_TEXT_ITEMS) {
        items.forEach((it) => {
          const h = Math.abs(it.height || it.transform[3]) || 8;
          words.push(...splitItem(it.str, it.transform[4], vp.height - it.transform[5], it.width, h, p));
        });
      } else {
        scanned++;
        status('Recognising scanned page ' + p + ' of ' + doc.numPages + '...');
        const v2 = page.getViewport({ scale: SCAN_SCALE });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(v2.width);
        canvas.height = Math.ceil(v2.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: v2 }).promise;
        (await ocr(canvas, status)).forEach((w) => words.push({ text: fixOcr(w.text), x0: w.x0 / SCAN_SCALE, x1: w.x1 / SCAN_SCALE, y0: w.y0 / SCAN_SCALE, y1: w.y1 / SCAN_SCALE, page: p, conf: w.conf }));
      }
    }
    return { words, pages: doc.numPages, scanned };
  }

  // ================================================================== insurer layouts

  const moneyIn = (row) => row.words.filter((w) => MONEY_RE.test(w.text.replace(/[,]/g, '')));
  const datesIn = (row) => row.words.map((w) => w.text.replace(/[^\d/]/g, '')).filter((t) => DATE_RE.test(t)).map(isoDate);
  const upcIn = (text) => { const m = String(text).match(UPC_RE); return m ? m[1] : null; };
  const sum = (a) => a.reduce((s, x) => s + (x || 0), 0);

  function detect(rows) {
    const all = rows.map((r) => r.text).join(' ');
    if (/wpa\.org\.uk|\bWPA\b/i.test(all)) return 'WPA';
    if (/\bBupa\b/i.test(all)) return 'Bupa';
    if (/\bAviva\b/i.test(all)) return 'Aviva';
    if (/\bAXA\b/i.test(all)) return 'AXA';
    return null;
  }

  // Each reader returns { reference, date, items: [...], totals: { paid }, notes: [] }.
  // An item: { invoice: 'UPC-12345', claimed, paid, patientShare, providerShortfall, reason, reasonText, dates, lines }
  //   reason: 'excess' (patient pays the difference), 'provider' (not chargeable to the patient), 'other', or null.
  //   lines (when the remittance gives them): [{ date, invoiced, paid, deduction, reason }]

  const READERS = {
    // Typed PDF, one row per invoice: Your Reference, Patient's Initials, Invoice Date, WPA Invoice ID,
    // Amount Claimed, Patient's Liability, Provider Shortfall, Amount Paid by WPA, Shortfall Code.
    WPA(rows, all) {
      const out = { items: [], totals: {}, notes: [] };
      const d = all.match(/Date:?\s*(\d{1,2})\s*[-\s]\s*([A-Za-z]{3})\s*[-\s]\s*(\d{4})/);
      if (d) out.date = isoDate(d[1] + '-' + d[2] + '-' + d[3]);
      rows.forEach((r) => {
        const bal = r.text.match(/^Balance:?\s*£?([\d,]+\.\d{2})/);
        if (bal) out.totals.paid = cents(bal[1]);
        const upc = upcIn(r.text);
        if (!upc) return;
        const m = moneyIn(r).map((w) => cents(w.text));
        if (m.length < 4) { out.notes.push('Could not read the amounts for UPC-' + upc + '.'); return; }
        const [claimed, liability, provider, paid] = m.slice(-4);
        const code = (r.text.match(/\((\d+)\)\s*$/) || [])[1] || '';
        out.items.push({
          invoice: 'UPC-' + upc, claimed, paid, patientShare: liability, providerShortfall: provider, dates: datesIn(r), lines: null,
          reason: liability ? 'excess' : (provider ? 'provider' : (paid < claimed ? 'other' : null)),
          reasonText: liability ? "Patient's liability" + (code ? ' (shortfall code ' + code + ')' : '') : (provider ? 'Provider shortfall' + (code ? ' (code ' + code + ')' : '') : ''),
        });
      });
      return out;
    },

    // Typed PDF, invoice number wrapped over two lines (UPC-375 / 12), treatment date range below,
    // then Charge, Benefit payable, Benefit previously paid, Credit, Debit and a note number.
    Bupa(rows) {
      const out = { items: [], totals: {}, notes: [] };
      const noteText = {};
      rows.forEach((r, i) => {
        const pd = r.text.match(/Payment date:?\s*(\d{1,2} [A-Za-z]+ \d{4})/);
        if (pd) out.date = isoDate(pd[1]);
        const ref = r.text.match(/BACS reference:?\s*(\d+)/);
        if (ref) out.reference = ref[1];
        const bp = r.text.match(/Balance payable\s*£?\s*([\d,]+\.\d{2})/);
        if (bp) out.totals.paid = cents(bp[1]);
        const note = r.text.match(/^(\d)\s+(This account|The unpaid balance)(.*)$/);
        if (note) noteText[note[1]] = note[2] + note[3];
      });
      rows.forEach((r, i) => {
        const w0 = r.words.find((w) => /^UPC-?\d*$/i.test(w.text));
        if (!w0) return;
        let digits = w0.text.replace(/\D/g, '');
        const next = rows[i + 1];
        const cont = next && next.page === r.page && next.words.find((w) => /^\d{1,4}$/.test(w.text) && Math.abs(w.x0 - w0.x0) < 25);
        if (cont && digits.length < 5) digits += cont.text ? cont.text : '';
        if (cont && digits.length < 5) digits = w0.text.replace(/\D/g, '') + cont.text;
        if (!/^\d{4,6}$/.test(digits)) { out.notes.push('Could not read an invoice number near "' + r.text.slice(0, 40) + '".'); return; }
        const m = moneyIn(r).map((w) => cents(w.text));
        if (m.length < 5) { out.notes.push('Could not read the amounts for UPC-' + digits + '.'); return; }
        const [charge, payable, previous, credit] = m.slice(0, 4);
        const lastMoney = moneyIn(r).slice(-1)[0];
        const noteW = r.words.find((w) => /^\d$/.test(w.text) && w.x0 > lastMoney.x1);
        const code = noteW ? noteW.text : '';
        const dates = datesIn(r);
        for (let j = i + 1; j < Math.min(rows.length, i + 4); j++) {
          if (rows[j].words.some((w) => /^UPC/i.test(w.text))) break;
          dates.push(...datesIn(rows[j]));
        }
        const share = charge - payable;
        const sorted = dates.slice().sort();
        const range = { from: sorted[0] || null, to: sorted[sorted.length - 1] || null, invoiced: charge, paid: payable };
        const item = {
          invoice: 'UPC-' + digits, claimed: charge, paid: credit, previouslyPaid: previous, insurerTotal: payable,
          patientShare: share > 0 && code ? share : 0, providerShortfall: share > 0 && !code ? share : 0, dates, lines: null, ranges: [range],
          reason: share > 0 ? (code ? 'excess' : 'other') : null, codes: code ? [code] : [],
          reasonText: code ? 'Note ' + code + (noteText[code] ? ': ' + noteText[code].slice(0, 90) + (noteText[code].length > 90 ? '...' : '') : '') : '',
        };
        // Bupa gives each treatment, or run of treatments, of an invoice its own row (live, 12 Nov 2026: UPC-38023 on
        // three rows): the rows of one invoice are added together, keeping each row's dates and amounts.
        const same = out.items.find((x) => x.invoice === item.invoice);
        if (!same) { out.items.push(item); return; }
        ['claimed', 'paid', 'previouslyPaid', 'insurerTotal', 'patientShare', 'providerShortfall'].forEach((k) => { same[k] = (same[k] || 0) + (item[k] || 0); });
        same.dates.push(...item.dates);
        same.ranges.push(range);
        if (code && !same.codes.includes(code)) { same.codes.push(code); }
        const owed = same.patientShare > 0, prov = same.providerShortfall > 0;
        same.reason = prov && owed ? 'other' : owed ? 'excess' : prov ? 'other' : null;   // a mix of the two is left to a person
        same.reasonText = same.codes.map((c) => 'Note ' + c + (noteText[c] ? ': ' + noteText[c].slice(0, 90) + (noteText[c].length > 90 ? '...' : '') : '')).join('; ');
      });
      return out;
    },

    // Scanned. Per patient: name, membership, claim number, invoice amount (often blank), amount paid,
    // then "Your reference" (UPC) underneath and an optional explanation ("member contribution").
    AXA(rows) {
      const out = { items: [], totals: {}, notes: [] };
      rows.forEach((r) => {
        const d = r.text.match(/\bDate\s+(\d{1,2})\.(\d{1,2})\.(\d{4})/);
        if (d) out.date = d[3] + '-' + pad(d[2]) + '-' + pad(d[1]);
        const doc = r.text.match(/\bDocument\s+(\d{6,})/);
        if (doc) out.reference = doc[1];
        if (/Total\s+GBP/i.test(r.text)) {
          const nx = rows[rows.indexOf(r) + 1];
          const m = moneyIn(r).length ? moneyIn(r) : (nx ? moneyIn(nx) : []);
          if (m.length) out.totals.paid = cents(m[m.length - 1].text);
        }
      });
      rows.forEach((r, i) => {
        const upc = upcIn(r.text);
        if (!upc || /Your reference/i.test(r.text)) return;
        let money = moneyIn(r);
        let src = r;
        if (!money.length && i > 0) { src = rows[i - 1]; money = moneyIn(src); }
        if (!money.length) { out.notes.push('Could not read the amount paid for UPC-' + upc + '.'); return; }
        const paid = cents(money[money.length - 1].text);
        const invoiced = money.length > 1 ? cents(money[money.length - 2].text) : null;
        let reasonText = '';
        for (let j = i + 1; j < Math.min(rows.length, i + 5); j++) {
          if (upcIn(rows[j].text) || moneyIn(rows[j]).length || /Total\s+GBP/i.test(rows[j].text)) break;
          reasonText += ' ' + rows[j].text;
        }
        const contribution = /contribution|excess/i.test(reasonText);
        out.items.push({
          invoice: 'UPC-' + upc, claimed: invoiced, paid, patientShare: null, providerShortfall: null, dates: [], lines: null,
          reason: contribution ? 'excess' : null, reasonText: contribution ? 'Member contribution' : UPC.clean(reasonText).slice(0, 120),
        });
      });
      return out;
    },

    // Scanned, one statement per invoice (usually a page each): Invoice Number (UPC), then lines with
    // dates of service, Amount Invoiced, Amount Paid, Deduction amount and reason, then totals.
    Aviva(rows, all) {
      const out = { items: [], totals: { paid: 0 }, notes: [] };
      const pages = [...new Set(rows.map((r) => r.page))];
      let anyTotal = false;
      const sd = all.match(/\b(\d{1,2}) (January|February|March|April|May|June|July|August|September|October|November|December) (\d{4})\b/i);
      if (sd) out.date = isoDate(sd[1] + ' ' + sd[2].slice(0, 3) + ' ' + sd[3]);
      const ref = all.match(/Our\s+Ref:?\s*([A-Z0-9]+)/i);
      if (ref) out.reference = ref[1];
      pages.forEach((p) => {
        const pr = rows.filter((r) => r.page === p);
        const upcRow = pr.find((r) => /Invoice\s*Number/i.test(r.text) && upcIn(r.text));
        if (!upcRow) return;
        const invoice = 'UPC-' + upcIn(upcRow.text);
        // Column centres from the header row "Invoiced  Paid  Amount  Reason".
        const head = pr.find((r) => /Invoiced/i.test(r.text) && /Paid/i.test(r.text));
        if (!head) { out.notes.push(invoice + ': could not find the column headings.'); return; }
        const col = (re) => { const w = head.words.find((x) => re.test(x.text)); return w ? (w.x0 + w.x1) / 2 : null; };
        const cInv = col(/^Invoiced$/i), cPaid = col(/^Paid$/i), cDed = col(/^Amount$/i), cReason = col(/^Reason$/i);
        const lines = [];
        pr.forEach((r, k) => {
          if (r.yc <= head.yc) return;
          const dates = datesIn(r);
          if (!dates.length || /^Total/i.test(r.text)) return;
          const line = { date: dates[0], invoiced: null, paid: null, deduction: null, reason: '' };
          // Deduction figures often sit a little lower than the rest of their line.
          const words = r.words.slice();
          const nx = pr[k + 1];
          if (nx && !datesIn(nx).length && !/^Total/i.test(nx.text) && nx.yc - r.yc < Math.max(9, r.h * 1.2)) words.push(...nx.words);
          moneyIn({ words }).forEach((w) => {
            const c = (w.x0 + w.x1) / 2;
            const near = [[cInv, 'invoiced'], [cPaid, 'paid'], [cDed, 'deduction']].filter(([x]) => x !== null)
              .sort((a, b) => Math.abs(a[0] - c) - Math.abs(b[0] - c))[0];
            if (near) line[near[1]] = cents(w.text);
          });
          const rw = words.find((w) => /^[*]?[A-Z][*x]?$/.test(w.text) && cDed !== null && w.x0 > cDed + 15);
          if (rw) line.reason = rw.text.replace(/[*x]/g, '');
          if (line.paid === null && line.invoiced !== null) line.paid = line.invoiced - (line.deduction || 0);
          lines.push(line);
        });
        const tot = (re) => { const r = pr.find((x) => re.test(x.text)); const m = r && moneyIn(r)[0]; return m ? cents(m.text) : null; };
        const tInv = tot(/Total\s+Invoiced/i), tPaid = tot(/Total\s+Paid/i), tDed = tot(/Total\s+Deducted/i);
        const legendA = pr.some((r) => /\*?A\*?\s+An\s+excess/i.test(r.text));
        const claimed = tInv !== null ? tInv : sum(lines.map((l) => l.invoiced));
        const paid = tPaid !== null ? tPaid : sum(lines.map((l) => l.paid));
        if (tPaid !== null) { out.totals.paid += tPaid; anyTotal = true; }
        if (tInv !== null && sum(lines.map((l) => l.invoiced)) !== tInv) out.notes.push(invoice + ': the lines read do not add up to Total Invoiced ' + fmt(tInv) + '. Check this statement by eye.');
        if (tPaid !== null && sum(lines.map((l) => l.paid)) !== tPaid) out.notes.push(invoice + ': the lines read do not add up to Total Paid ' + fmt(tPaid) + '. Check this statement by eye.');
        const deducted = tDed !== null ? tDed : claimed - paid;
        const excess = legendA && lines.some((l) => l.deduction && /A/.test(l.reason));
        out.items.push({
          invoice, claimed, paid, patientShare: excess ? deducted : null, providerShortfall: excess ? 0 : null, dates: lines.map((l) => l.date), lines,
          reason: deducted > 0 ? (excess ? 'excess' : 'other') : null, reasonText: excess ? 'Excess deducted (A)' : '',
        });
      });
      if (!anyTotal) delete out.totals.paid;
      return out;
    },
  };

  // Reads positioned words into a remittance and checks it against its own totals.
  function understand(words) {
    const rows = toRows(words);
    const insurer = detect(rows);
    if (!insurer) return { insurer: null, items: [], notes: ['This does not look like a Bupa, WPA, AXA or Aviva remittance.'] };
    const r = READERS[insurer](rows, rows.map((x) => x.text).join(' '));
    r.insurer = insurer;
    // Same invoice listed twice (e.g. a statement repeated): keep the first.
    const seen = new Set();
    r.items = r.items.filter((it) => (seen.has(it.invoice) ? (r.notes.push(it.invoice + ' appears more than once; only the first is used.'), false) : seen.add(it.invoice)));
    const paidSum = sum(r.items.map((it) => it.paid));
    r.checks = { paidRead: paidSum, paidTotal: r.totals.paid === undefined ? null : r.totals.paid };
    if (r.totals.paid === undefined) r.notes.push('No total found on the remittance, so the amounts read could not be cross-checked.');
    else if (paidSum !== r.totals.paid) r.notes.push('The amounts read add up to ' + fmt(paidSum) + ' but the remittance total is ' + fmt(r.totals.paid) + '. Something was misread: check each line by eye.');
    return r;
  }

  // A scanned remittance corrected by hand (Carl, 12 Nov 2026: "in case the OCR misreads a 3 as an 8"): the invoice
  // number, and what the insurer paid, either in total or per line (Aviva). Deductions, the patient's share and the
  // reason follow from the corrected amounts.
  function correctItem(item, fix) {
    if (fix.invoice) item.invoice = fix.invoice;
    if (Array.isArray(fix.lines) && item.lines && item.lines.length) {
      const wasExcess = item.reason === 'excess' || (item.patientShare !== null && item.patientShare !== undefined);
      item.lines.forEach((l, k) => {
        if (fix.lines[k] === undefined || fix.lines[k] === null) return;
        l.paid = fix.lines[k];
        const d = l.invoiced !== null && l.invoiced !== undefined ? l.invoiced - l.paid : null;
        l.deduction = d ? d : null;
      });
      item.paid = sum(item.lines.map((l) => l.paid || 0));
      const deducted = sum(item.lines.map((l) => l.deduction || 0));
      item.patientShare = wasExcess && deducted > 0 ? deducted : null;
      item.reason = deducted > 0 ? (wasExcess ? 'excess' : 'other') : null;
    } else if (fix.paid !== undefined && fix.paid !== null) {
      item.paid = fix.paid;
      if (item.lines && item.lines.length === 1) item.lines[0].paid = fix.paid;
    }
    delete item.insurerTotal;
    item.corrected = true;
    return item;
  }
  // The amounts read against the remittance's own total, again (after a correction).
  function checkTotals(r) {
    if (!r || !r.checks) return r;
    r.checks.paidRead = sum(r.items.map((it) => it.paid));
    r.notes = r.notes.filter((n) => !/^The amounts read add up to /.test(n));
    if (r.checks.paidTotal !== null && r.checks.paidRead !== r.checks.paidTotal) {
      r.notes.push('The amounts read add up to ' + fmt(r.checks.paidRead) + ' but the remittance total is ' + fmt(r.checks.paidTotal) + '. Something was misread: check each line by eye.');
    }
    return r;
  }
  const amountIn = (v) => { const t = String(v || '').replace(/[£,\s]/g, ''); return /^\d+(\.\d{1,2})?$/.test(t) ? Math.round(parseFloat(t) * 100) : null; };
  const plain = (c) => (c === null || c === undefined ? '' : (c / 100).toFixed(2));

  // ================================================================== matching with Halaxy

  const halaxyDateIso = (s) => isoDate(String(s || '').replace(/-/g, ' ')) || isoDate(s);

  // Works out what to change on an organisation invoice so the funder lines total what the insurer paid.
  // Uses per-line figures when the remittance gives them, otherwise takes the shortfall from the
  // earliest lines first.
  // Days between two ISO dates (2026-09-09); Infinity if either is missing.
  const isoShift = (iso, days) => { const d = new Date(Date.parse(iso) + days * 86400e3); return d.toISOString().slice(0, 10); };
  const isoGap = (a, b) => (a && b ? Math.round(Math.abs(Date.parse(a) - Date.parse(b)) / 86400e3) : Infinity);
  // A funder line for a remittance line: the same date first, otherwise the one within two days
  // (Halaxy sometimes dates a fee a day out on the funder invoice, and the date is corrected afterwards).
  const findLine = (pool, date, test) => {
    const exact = pool.findIndex((l) => halaxyDateIso(l.date) === date && test(l));
    if (exact >= 0) return exact;
    const near = pool.map((l, i) => i).filter((i) => isoGap(halaxyDateIso(pool[i].date), date) <= 2 && test(pool[i]));
    return near.length === 1 ? near[0] : -1;
  };

  function proposeLines(funder, item, shortfall) {
    const lines = funder.lines.slice().sort((a, b) => (halaxyDateIso(a.date) || '').localeCompare(halaxyDateIso(b.date) || ''));
    const changes = [];
    if (item.lines && item.lines.length) {
      const pool = lines.slice();
      for (const rl of item.lines) {
        if (rl.paid === null || rl.invoiced === null || rl.paid === rl.invoiced) {
          const idx = findLine(pool, rl.date, () => true);
          if (idx >= 0) pool.splice(idx, 1);
          continue;
        }
        let idx = findLine(pool, rl.date, (l) => l.amount === rl.invoiced);
        if (idx < 0) {
          // Already done (an earlier run, or by hand): the line already shows what the insurer paid.
          const done = findLine(pool, rl.date, (l) => l.amount === rl.paid);
          if (done >= 0) { pool.splice(done, 1); continue; }
          return { error: 'No line on ' + funder.number + ' for ' + rl.date + ' at ' + fmt(rl.invoiced) + ' (or already at ' + fmt(rl.paid) + ').' };
        }
        const l = pool.splice(idx, 1)[0];
        changes.push({ lineId: l.lineId, date: l.date, from: l.amount, to: rl.paid });
      }
      if (sum(changes.map((c) => c.from - c.to)) !== shortfall) return { error: 'The per-line deductions do not add up to the shortfall of ' + fmt(shortfall) + '.' };
      return { changes };
    }
    // Bupa: each row gives its own shortfall for a date or run of dates: shared over the funder lines in that run, in
    // proportion to their amounts.
    if (item.ranges && item.ranges.length > 1) {
      const pool = lines.slice();
      for (const rg of item.ranges) {
        const sf = (rg.invoiced || 0) - (rg.paid || 0);
        const inRun = pool.filter((l) => { const d = halaxyDateIso(l.date); return d && rg.from && d >= isoShift(rg.from, -2) && d <= isoShift(rg.to || rg.from, 2); });
        inRun.forEach((l) => pool.splice(pool.indexOf(l), 1));
        if (sf <= 0) continue;
        const total = sum(inRun.map((l) => l.amount));
        if (inRun.length && total === rg.paid) continue;   // already moved
        if (!inRun.length || total !== rg.invoiced) return { error: 'The lines on ' + funder.number + ' from ' + rg.from + ' to ' + (rg.to || rg.from) + ' don\'t add up to the ' + fmt(rg.invoiced) + ' Bupa was billed for them.' };
        let left = sf;
        inRun.forEach((l, k) => {
          const take = k === inRun.length - 1 ? left : Math.round(sf * l.amount / total);
          if (take > 0) changes.push({ lineId: l.lineId, date: l.date, from: l.amount, to: l.amount - take });
          left -= take;
        });
      }
      if (sum(changes.map((c) => c.from - c.to)) !== shortfall) return { error: 'The rows\' shortfalls do not add up to the shortfall of ' + fmt(shortfall) + '.' };
      return { changes };
    }
    let left = shortfall;
    for (const l of lines) {
      if (left <= 0) break;
      const take = Math.min(left, l.amount);
      if (take > 0) changes.push({ lineId: l.lineId, date: l.date, from: l.amount, to: l.amount - take });
      left -= take;
    }
    if (left > 0) return { error: 'The shortfall is more than the lines on ' + funder.number + '.' };
    return { changes };
  }

  // Each Bupa row's fees on the funder invoice: 'todo' (still what was billed), 'done' (already what was paid) or 'bad'.
  function rangeStates(funder, item) {
    if (!item.ranges || !item.ranges.length || item.ranges.some((r) => !r.from)) return null;
    const pool = funder.lines.slice().sort((a, b) => (halaxyDateIso(a.date) || '').localeCompare(halaxyDateIso(b.date) || ''));
    return item.ranges.map((rg) => {
      const inRun = pool.filter((l) => { const d = halaxyDateIso(l.date); return d && d >= isoShift(rg.from, -2) && d <= isoShift(rg.to || rg.from, 2); });
      inRun.forEach((l) => pool.splice(pool.indexOf(l), 1));
      const t = sum(inRun.map((l) => l.amount));
      return { invoiced: rg.invoiced, paid: rg.paid, state: inRun.length && t === rg.invoiced ? 'todo' : inRun.length && t === rg.paid ? 'done' : 'bad' };
    });
  }
  // Amounts waiting on the patient invoices of this funder invoice for a fee within the remittance's dates that is
  // no longer on the funder invoice: a move that stopped after taking the fee off.
  async function waitingFees(funder, item) {
    const ids = [...new Set(funder.lines.map((l) => l.patientInvoiceId).filter(Boolean))];
    const ds = (item.dates || []).filter(Boolean).sort();
    const from = ds[0], to = ds[ds.length - 1];
    const out = [];
    for (const id of ids) {
      let p;
      try { p = await UPC.invoice.fetch(id); } catch (e) { continue; }
      if (p.pending.length !== 1) continue;
      const onFunder = funder.lines.filter((l) => l.patientInvoiceId === String(id));
      const missing = p.lines.filter((pl) => { const d = halaxyDateIso(pl.date); return (!from || (d >= isoShift(from, -2) && d <= isoShift(to, 2))) && !onFunder.some((fl) => fl.item === pl.item && Math.abs(isoGap(halaxyDateIso(fl.date), d)) <= 2); });
      if (missing.length === 1) out.push({ patientInvoiceId: String(id), number: p.number, amount: p.pending[0].amount, date: missing[0].date, from, to });
    }
    return out;
  }

  async function matchItem(item) {
    const res = { item, status: 'check', message: '', invoiceId: null, funder: null, changes: [] };
    let row;
    try { row = await UPC.invoice.findByNumber(item.invoice); } catch (e) { res.message = 'Could not search Halaxy: ' + e.message; return res; }
    if (!row) { res.message = 'Not found in Halaxy.'; return res; }
    res.invoiceId = String(row.id);
    let funder;
    try { funder = await UPC.invoice.fetch(row.id); } catch (e) { res.message = e.message; return res; }
    res.funder = funder;
    if (!funder.isFunder) { res.message = item.invoice + ' is not an organisation invoice.'; return res; }
    const total = funder.total;
    res.halaxyTotal = total;
    const insurerPays = item.insurerTotal !== undefined && item.insurerTotal !== null ? item.insurerTotal : item.paid;
    // Rows already moved (a run that stopped part way, or by hand): each Bupa row's fees show either what was billed
    // (still to do) or what was paid (done).
    const rs = rangeStates(funder, item);
    const doneShare = rs ? sum(rs.filter((r) => r.state === 'done').map((r) => r.invoiced - r.paid)) : 0;
    const explained = rs && rs.every((r) => r.state !== 'bad') && sum(rs.map((r) => (r.state === 'done' ? r.paid : r.invoiced))) === total;
    if (item.claimed !== null && item.claimed !== undefined && item.claimed !== total && !explained) {
      // Stopped part way last time: a fee taken off this invoice is still waiting on its patient invoice.
      const waiting = await waitingFees(funder, item);
      if (waiting.length) {
        res.status = 'resume';
        res.resume = waiting;
        res.message = 'Stopped part way last time: ' + waiting.map((w) => fmt(w.amount) + ' is waiting on ' + w.number).join(', ') + ' to go back on ' + funder.number + '. Apply finishes it, then checks this invoice again.';
        return res;
      }
      // Moved already (an earlier upload, or by hand), however it was split over the fees: the invoice now asks the
      // insurer for exactly what it paid. Nothing to move; said plainly (Carl, 13 Nov 2026: re-uploading old remittances).
      if (total === insurerPays && item.claimed > total) {
        res.status = 'ok'; res.shortfall = 0; res.already = item.claimed - total;
        res.message = 'Excess of ' + fmt(item.claimed - total) + ' already moved to the patient (billed ' + fmt(item.claimed) + ', now ' + fmt(total) + ', what was paid). Nothing to move.';
        return res;
      }
      if (item.claimed > total && total > insurerPays) {
        res.message = 'Part of the excess is already moved: ' + fmt(item.claimed - total) + ' of ' + fmt(item.claimed - insurerPays) + ', so ' + fmt(total - insurerPays) + ' is still on ' + funder.number + '. Not changed: check by hand.';
        return res;
      }
      if (item.claimed > total && total < insurerPays) {
        res.message = 'More than the excess is already moved: ' + funder.number + ' is ' + fmt(total) + ' but the insurer paid ' + fmt(insurerPays) + '. Not changed: check by hand.';
        return res;
      }
      res.message = 'Insurer was billed ' + fmt(item.claimed) + ' but the Halaxy invoice is ' + fmt(total) + '.';
      return res;
    }
    const shortfall = total - insurerPays;
    res.shortfall = shortfall;
    if (shortfall === 0) { res.status = 'ok'; res.message = 'Paid in full.'; return res; }
    if (shortfall < 0) { res.message = 'Insurer paid ' + fmt(-shortfall) + ' more than the invoice.'; return res; }
    if (item.reason === 'provider') { res.status = 'manual'; res.message = 'Provider shortfall of ' + fmt(shortfall) + ': not chargeable to the patient. Decide by hand.'; return res; }
    if (item.reason !== 'excess') { res.message = 'Paid ' + fmt(shortfall) + ' less, with no excess or patient share given. Check by hand.'; return res; }
    if (item.patientShare && item.patientShare - doneShare !== shortfall) { res.message = 'Patient share ' + fmt(item.patientShare) + ' does not match the shortfall of ' + fmt(shortfall) + '. Check by hand.'; return res; }
    if (funder.outstanding !== total) { res.status = 'manual'; res.message = 'A payment is already recorded on ' + funder.number + ', so it will not be changed automatically.'; return res; }
    const p = proposeLines(funder, item, shortfall);
    if (p.error) { res.message = p.error; return res; }
    res.changes = p.changes;
    res.status = 'fix';
    res.message = 'Move ' + fmt(shortfall) + ' to the patient (' + (item.reasonText || 'excess') + ').';
    return res;
  }

  // ================================================================== page

  const state = { file: null, remit: null, results: [], busy: false, unmount: null, log: [] };
  let root = null;
  let sh = null;

  // Halaxy's own classes (cards, tables, buttons, form controls) style the page; these rules only
  // cover what Halaxy has no class for, scoped to our page and using Halaxy's colour variables.
  const CSS = `
    .upc-rem { max-width: 1200px; }
    .upc-rem h1 { margin: 0 0 16px; }
    .upc-rem .card { margin-bottom: 24px; }
    .upc-rem .upc-rem-drop { border: 2px dashed var(--vs-theme-border-color, #ced4da); border-radius: 4.8px; padding: 28px; text-align: center; margin-top: 12px;
      background: var(--vs-card-standout-bg-color, #f0f0f5); cursor: pointer; }
    .upc-rem .upc-rem-drop.on { border-color: var(--vs-theme-primary, #0e0793); }
    .upc-rem .upc-rem-status { margin-top: 10px; }
    .upc-rem .upc-rem-notes { border: 1px solid #e0b400; background: #fff8db; border-radius: 4.8px; padding: 8px 12px; margin-top: 12px; }
    .upc-rem .upc-rem-notes ul { margin: 4px 0 0; padding-left: 20px; }
    .upc-rem .upc-tag { display: inline-block; border-radius: 4.8px; padding: 0 6px; font-weight: 600; border: 1px solid transparent; }
    .upc-rem .t-ok, .upc-rem .t-done { background: #e3f4e8; border-color: #9fd3ad; color: #14532d; }
    .upc-rem .t-resume { background: #fff8db; border-color: #e0b400; color: #6b5200; }
    .upc-rem .t-fix { background: var(--vs-status-badge-neutral-bg-color, #f0f0f5); border-color: var(--vs-theme-primary, #0e0793); color: var(--vs-theme-primary, #0e0793); }
    .upc-rem .t-manual { background: #fff3e0; border-color: #ffd8a8; color: #8a4b00; }
    .upc-rem .t-check, .upc-rem .t-failed { background: #fdecea; border-color: var(--vs-balance-negative-color, #ec6b65); color: #a01818; }
    .upc-rem .upc-rem-chg { margin-top: 2px; }
    .upc-rem .upc-rem-fix { display: inline-flex; align-items: center; gap: 4px; }
    .upc-rem .upc-rem-fix .form-control { width: 110px; height: auto; padding: 1px 6px; }
    .upc-rem .upc-rem-amt { display: flex; align-items: center; justify-content: flex-end; gap: 6px; margin: 0 0 3px; font-weight: normal; }
    .upc-rem .upc-rem-amt .form-control, .upc-rem .upc-rem-amt-one { width: 90px; height: auto; padding: 1px 6px; text-align: right; display: inline-block; }
    .upc-rem .upc-rem-apply { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px; }
    .upc-rem .upc-rem-apply .btn { margin: 0; }
    .upc-rem .upc-rem-apply label { margin: 0; display: flex; align-items: center; gap: 4px; }
    .upc-rem .upc-log { max-height: 260px; overflow: auto; margin-top: 0; }
  `;

  const $ = (s) => sh.querySelector(s);
  const esc = (s) => UPC.esc(s);
  const status = (t) => { const el = sh && $('.upc-rem-status'); if (el) el.textContent = t || ''; };

  function render() {
    const r = state.remit;
    const fixes = state.results.filter((x) => x.status === 'fix');
    let html = '<div class="upc-rem"><h1>Remittances</h1>' +
      '<div class="card"><div class="card-header"><h2>Read a remittance</h2></div><div class="card-body">' +
      '<div class="text-muted">Read a remittance, check it against Halaxy, and move excesses to the patient. Payments are never recorded here. Remittances are read on this computer and not uploaded anywhere, except as an attachment to the invoices they cover.</div>' +
      '<div class="upc-rem-drop" tabindex="0" role="button">Drop a remittance PDF here, or click to choose one<input type="file" accept="application/pdf" hidden></div>' +
      '<div class="upc-rem-status" aria-live="polite"></div>';
    if (r) {
      html += '<div class="upc-gap"><b>' + esc(r.insurer || 'Unknown insurer') + '</b>' + (r.date ? ' remittance dated ' + esc(r.date) : '') + (r.reference ? ', reference ' + esc(r.reference) : '') +
        '. ' + r.items.length + ' invoice' + (r.items.length === 1 ? '' : 's') + ' read' + (r.checks && r.checks.paidTotal !== null ? ', total paid ' + fmt(r.checks.paidTotal) : '') + '.</div>';
      if (r.notes.length) html += '<div class="upc-rem-notes"><b>Check before applying</b><ul>' + r.notes.map((n) => '<li>' + esc(n) + '</li>').join('') + '</ul></div>';
    }
    html += '</div></div>';
    if (state.results.length) {
      html += '<div class="card"><div class="card-header"><h2>Invoices on this remittance</h2></div><div class="card-body p-0 table-responsive-sm">' +
        '<table class="table table-striped table-bordered w-100 m-0"><thead><tr><th></th><th>Invoice</th><th class="number">Halaxy</th><th class="number">Insurer paid</th><th class="number">Difference</th><th>Result</th></tr></thead><tbody>';
      state.results.forEach((x, i) => {
        const it = x.item;
        const label = x.status === 'ok' && x.already ? 'Excess moved' : { ok: 'Paid in full', fix: 'Excess', resume: 'Finish', manual: 'By hand', check: 'Check', done: 'Done', failed: 'Failed' }[x.status];
        let link = x.invoiceId ? '<a href="' + esc(UPC.base() + '/invoice/' + x.invoiceId) + '" target="_blank" rel="noopener">' + esc(it.invoice) + '</a>' : esc(it.invoice);
        const paidShown = fmt(it.insurerTotal !== undefined && it.insurerTotal !== null ? it.insurerTotal : it.paid);
        let paidCell = paidShown;
        if (r.scanned && !['done', 'failed'].includes(x.status) && !state.busy) {
          // Scanned: the invoice number and the amounts can be corrected against the paper copy, then checked again.
          link += '<div class="upc-rem-chg text-muted">Read as ' + esc(it.invoice) + '. Wrong? Correct the number or the amounts, then <span class="upc-rem-fix"><input class="form-control" data-num="' + i + '" value="' + esc(it.invoice) + '" aria-label="Correct invoice number"> <button type="button" class="btn btn-outline-primary-light" data-act="recheck" data-i="' + i + '">Re-check</button></span></div>';
          paidCell = it.lines && it.lines.length > 1
            ? it.lines.map((l, k) => '<label class="upc-rem-amt"><span class="text-muted">' + esc(l.date ? UPC.dayLabel(Date.parse(l.date)) : 'Line ' + (k + 1)) + '</span> <input class="form-control" data-line="' + i + ':' + k + '" value="' + esc(plain(l.paid || 0)) + '" inputmode="decimal" aria-label="Paid for ' + esc(l.date || 'line ' + (k + 1)) + '"></label>').join('') +
              '<div class="text-muted">' + paidShown + '</div>'
            : '<input class="form-control upc-rem-amt-one" data-paid="' + i + '" value="' + esc(plain(it.paid)) + '" inputmode="decimal" aria-label="Correct the amount paid for ' + esc(it.invoice) + '">';
        }
        html += '<tr><td>' + (x.status === 'fix' || x.status === 'resume' ? '<input type="checkbox" data-i="' + i + '" ' + (x.selected !== false ? 'checked' : '') + ' aria-label="Apply to ' + esc(it.invoice) + '">' : '') + '</td>' +
          '<td>' + link + '</td><td class="number">' + fmt(x.halaxyTotal) + '</td><td class="number">' + paidCell + '</td>' +
          '<td class="number">' + (x.shortfall ? fmt(x.shortfall) : '') + '</td>' +
          '<td><span class="upc-tag t-' + x.status + '">' + label + '</span> ' + esc(x.message) +
          (x.changes.length ? '<div class="upc-rem-chg">' + x.changes.map((c) => esc(c.date) + ': funder ' + fmt(c.from) + ' to ' + fmt(c.to) + ', patient pays ' + fmt(c.from - c.to)).join('<br>') + '</div>' : '') +
          (x.error ? '<div class="upc-rem-chg upc-err">' + esc(x.error) + '</div>' : '') + '</td></tr>';
      });
      html += '</tbody></table>';
      const n = fixes.filter((x) => x.selected !== false).length;
      const nr = state.results.filter((x) => x.status === 'resume' && x.selected !== false).length;
      const toAttach = attachable().length;
      // Part-way moves are finished first, on their own; then the excess fixes; with nothing to fix, the button attaches.
      const label = nr ? 'Finish ' + nr + ' invoice' + (nr === 1 ? '' : 's') + ' left part-way' : n ? 'Apply ' + n + ' excess fix' + (n === 1 ? '' : 'es') : 'Attach remittance to ' + toAttach + ' invoice' + (toAttach === 1 ? '' : 's');
      const can = !state.busy && !state.applied && (nr || n || (state.attach !== false && toAttach));
      html += '<div class="upc-rem-apply"><button type="button" class="btn btn-primary" data-act="apply" ' + (can ? '' : 'disabled') + '>' + label + '</button>' +
        '<label><input type="checkbox" data-act="attach" ' + (state.attach !== false ? 'checked' : '') + '> Attach the remittance to each matched invoice</label></div></div></div>';
    }
    if (state.log.length) html += '<div class="upc-box upc-log">' + state.log.map((l) => '<div class="' + (l.err ? 'upc-err' : '') + '">' + esc(l.t) + '</div>').join('') + '</div>';
    html += '<div class="text-muted upc-version">Remittances ' + VERSION + '</div></div>';
    sh.innerHTML = html;
  }

  async function handleFile(file) {
    if (!file || state.busy) return;
    if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) { status('That is not a PDF.'); return; }
    state.busy = true;
    state.file = file;
    state.remit = null;
    state.results = [];
    state.log = [];
    state.applied = false;
    render();
    try {
      const read = await readPdf(file, status);
      state.remit = understand(read.words);
      state.remit.scanned = read.scanned > 0;
      if (read.scanned) state.remit.notes.unshift('This remittance was scanned, so it was read by text recognition. Check each invoice number and amount against the paper copy before applying.');
      render();
      for (let i = 0; i < state.remit.items.length; i++) {
        status('Checking ' + state.remit.items[i].invoice + ' in Halaxy (' + (i + 1) + ' of ' + state.remit.items.length + ')...');
        state.results.push(await matchItem(state.remit.items[i]));
        render();
      }
      status(state.results.length ? 'Checked. Review the results, then apply the excess fixes you want.' : 'No invoices found on this remittance.');
    } catch (e) {
      console.error('[UPC remittances]', e);
      status('Could not read this remittance: ' + (e.message || e));
    } finally {
      state.busy = false;
      render();
      status(state.results.length ? 'Checked. Review the results, then apply the excess fixes you want.' : $('.upc-rem-status').textContent);
    }
  }

  // A scanned line was misread: check it again with the corrected invoice number and amounts.
  async function recheck(i) {
    if (state.busy) return;
    const input = sh.querySelector('input[data-num="' + i + '"]');
    const digits = input && String(input.value).replace(/\D/g, '');
    if (!digits) { status('Enter the invoice number, for example UPC-37536.'); return; }
    const item = state.results[i].item;
    const fix = { invoice: 'UPC-' + digits };
    const one = sh.querySelector('input[data-paid="' + i + '"]');
    const many = [...sh.querySelectorAll('input[data-line^="' + i + ':"]')];
    const bad = [one, ...many].filter((el) => el && amountIn(el.value) === null);
    if (bad.length) { status('"' + bad[0].value + '" is not an amount. Enter it as on the paper copy, for example 35.00.'); bad[0].focus(); return; }
    if (one) fix.paid = amountIn(one.value);
    if (many.length) { fix.lines = []; many.forEach((el) => { fix.lines[+el.dataset.line.split(':')[1]] = amountIn(el.value); }); }
    correctItem(item, fix);
    checkTotals(state.remit);
    state.busy = true;
    status('Checking ' + item.invoice + ' in Halaxy...');
    try { state.results[i] = await matchItem(item); } finally {
      state.busy = false;
      render();
      const r = state.remit;
      status('Checked ' + item.invoice + ' at ' + fmt(item.paid) + '.' + (r.checks && r.checks.paidTotal !== null ? (r.checks.paidRead === r.checks.paidTotal ? ' The amounts now add up to the remittance total.' : ' The amounts still don\'t add up to the remittance total.') : ''));
    }
  }

  function confirmApply(list) {
    return new Promise((resolve) => {
      let answered = false;
      const done = (v) => { if (!answered) { answered = true; resolve(v); } };
      const total = sum(list.map((x) => x.shortfall));
      const dlg = UPC.ui.dialog({ title: 'Apply ' + list.length + ' excess fix' + (list.length === 1 ? '' : 'es') + '?', small: true, onClose: () => done(false) });
      dlg.root.setAttribute('data-upc-remit-confirm', '');
      dlg.body.innerHTML = '<p>For each invoice below, the funder line is reverted to the patient invoice, the rebate is lowered, and the rest is re-billed to the same organisation invoice. ' +
        'Patients will owe ' + fmt(total) + ' in total. No payments are recorded.</p><ul>' +
        list.map((x) => '<li>' + esc(x.item.invoice) + ': ' + x.changes.map((c) => esc(c.date) + ' ' + fmt(c.from) + ' to ' + fmt(c.to)).join(', ') + '</li>').join('') +
        '</ul>' + (state.attach !== false ? '<p class="text-muted">The remittance will also be attached to each matched invoice.</p>' : '') +
        '<div class="upc-actions"><button type="button" class="btn btn-outline-primary" data-a="no">Cancel</button><button type="button" class="btn btn-primary" data-a="yes">Apply</button></div>';
      dlg.body.addEventListener('click', (e) => {
        const a = e.target.closest('[data-a]');
        if (!a) return;
        done(a.dataset.a === 'yes');
        dlg.close();
      });
    });
  }

  // Who bills the patient for an excess (Carl, 9 Nov 2026). Matched by name in the task's Assign to list.
  const TASK_FOR = 'Carl Healy';
  const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const todayLabel = () => { const d = new Date(); return String(d.getDate()).padStart(2, '0') + '-' + MON3[d.getMonth()] + '-' + d.getFullYear(); };

  const isoLabel = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d\d)-(\d\d)$/); return m ? m[3] + '-' + MON3[+m[2] - 1] + '-' + m[1] : String(iso || ''); };
  const attachable = () => state.results.filter((r) => r.invoiceId && r.funder && r.funder.isFunder);

  // Finishes moves that stopped part way, then checks those invoices again; the rest of their fix is applied with
  // Apply after that, as usual.
  async function finishResumes(list) {
    const lines = list.map((x) => '<li>' + esc(x.item.invoice) + ': ' + x.resume.map((w) => 'bill ' + fmt(w.amount) + ' (the ' + esc(w.date) + ' fee) on ' + esc(w.number) + ' back to it').join(', ') + '</li>').join('');
    if (!(await confirmSimple('Finish ' + list.length + ' invoice' + (list.length === 1 ? '' : 's') + ' left part-way?', '<p>These were stopped part way last time. Each fee waiting on the patient invoice is billed back to its funder invoice (set back to Active for the change if it is Issued, then Issued again) and given its own date. Nothing else is changed.</p><ul>' + lines + '</ul>'))) return;
    state.busy = true;
    const say = (t, err) => { state.log.push({ t, err }); render(); };
    for (const x of list) {
      say(x.item.invoice + ':');
      try {
        for (const w of x.resume) await UPC.rebate.resume(x.invoiceId, w.patientInvoiceId, { from: w.from, to: w.to }, (t) => say('  ' + t));
        say('  Finished. Checking ' + x.item.invoice + ' again...');
        const i = state.results.indexOf(x);
        state.results[i] = await matchItem(x.item);
        say('  ' + state.results[i].message);
      } catch (e) {
        x.status = 'failed';
        x.error = e.message || String(e);
        say('  Stopped: ' + x.error, true);
      }
    }
    state.busy = false;
    say('Done. Apply the remaining fixes when you are ready.');
  }
  function confirmSimple(title, html) {
    return new Promise((resolve) => {
      let answered = false;
      const done = (v) => { if (!answered) { answered = true; resolve(v); } };
      const dlg = UPC.ui.dialog({ title, small: true, onClose: () => done(false) });
      dlg.root.setAttribute('data-upc-remit-confirm', '');
      dlg.body.innerHTML = html + '<div class="upc-actions"><button type="button" class="btn btn-outline-primary" data-a="no">Cancel</button><button type="button" class="btn btn-primary" data-a="yes">Finish</button></div>';
      dlg.body.addEventListener('click', (e) => { const a = e.target.closest('[data-a]'); if (!a) return; done(a.dataset.a === 'yes'); dlg.close(); });
    });
  }

  async function apply() {
    const list = state.results.filter((x) => x.status === 'fix' && x.selected !== false);
    const resumes = state.results.filter((x) => x.status === 'resume' && x.selected !== false);
    if (state.busy || state.applied) return;
    if (resumes.length) { await finishResumes(resumes); return; }
    if (!list.length && (state.attach === false || !attachable().length)) return;
    // Excess fixes ask first; attaching alone is what the button says it does.
    if (list.length && !(await confirmApply(list))) return;
    state.busy = true;
    const say = (t, err) => { state.log.push({ t, err }); render(); };
    for (const x of list) {
      say(x.item.invoice + ':');
      const moved = {};   // per patient invoice: { number, lines, owes }
      const doneMoves = [];   // this invoice's fees moved so far, to put back if a later one fails
      try {
        for (const c of x.changes) {
          const plan = await UPC.rebate.plan(x.invoiceId, c.lineId, c.to);
          const res = await UPC.rebate.apply(plan, (t) => say('  ' + t));
          doneMoves.push({ c, plan, res });
          const m = moved[plan.patientInvoiceId] || (moved[plan.patientInvoiceId] = { number: plan.patientNumber, lines: [], owes: null });
          m.lines.push((plan.patientDate || plan.date) + ' ' + fmt(c.from - c.to) + ' (' + (state.remit.insurer || 'insurer') + ' paid ' + fmt(c.to) + ')');
          if (res && res.patientOutstanding !== null && res.patientOutstanding !== undefined) m.owes = res.patientOutstanding;
        }
        x.status = 'done';
        x.message = 'Moved ' + fmt(x.shortfall) + ' to the patient.';
        // A task for Carl to bill the patient (Carl, 9 Nov 2026: always assigned to him, due today).
        for (const id of Object.keys(moved)) {
          const m = moved[id];
          const remit = (state.remit.insurer || 'Insurer') + ' remittance' + (state.remit.date ? ' ' + state.remit.date : '') + (state.remit.reference ? ', ref ' + state.remit.reference : '');
          try {
            const added = await UPC.tasks.addToInvoice(id, {
              title: 'Bill excess: ' + m.number + ' (' + remit + ')', assignee: TASK_FOR, priority: 2, due: todayLabel(),
              by: 'Remittances', comment: [(m.owes !== null ? 'Patient owes ' + fmt(m.owes) + ' on ' + m.number : ''), 'Moved to the patient: ' + m.lines.join(', '), 'From the ' + remit, 'Bill the patient for the excess'],
            });
            say('  ' + (added ? 'Task added for ' + TASK_FOR + ' to bill the patient on ' + m.number + '.' : 'A task to bill the patient is already on ' + m.number + '.'));
          } catch (e) {
            say('  The excess is moved, but the task to bill the patient was not added (' + (e.message || e) + '). Add it on ' + m.number + ' by hand.', true);
          }
        }
      } catch (e) {
        // All or nothing for each invoice (Carl, 12 Nov 2026): the fee that failed was put back by the core library;
        // the fees already moved on this invoice are moved back too, newest first. Then a task for Carl.
        const failed = e.message || String(e);
        const left = e.undone === false ? [failed] : [];
        for (const d of doneMoves.slice().reverse()) {
          try {
            say('  Moving the ' + (d.plan.patientDate || d.plan.date) + ' fee back to ' + fmt(d.c.from) + ' on ' + x.item.invoice);
            const back = await UPC.rebate.plan(x.invoiceId, d.res.newLineId, d.c.from);
            await UPC.rebate.apply(back, (t) => say('    ' + t));
          } catch (u) {
            left.push('the ' + (d.plan.patientDate || d.plan.date) + ' fee is still at ' + fmt(d.c.to) + ' on ' + x.item.invoice + ' (should be ' + fmt(d.c.from) + '; ' + (u.message || u) + ')');
          }
        }
        const putBack = !left.length;
        x.status = 'failed';
        x.error = failed.replace(/ Everything was put back as it was\.$/, '') + (putBack ? ' Everything on ' + x.item.invoice + ' was put back as it was.' : ' Not everything could be put back: see the task on ' + x.item.invoice + '.');
        say('  Stopped: ' + x.error, true);
        try {
          await UPC.tasks.addToInvoice(x.invoiceId, {
            title: 'Remittances stopped on ' + x.item.invoice + ': please check', assignee: TASK_FOR, priority: 3, due: todayLabel(), by: 'Remittances',
            comment: ['Moving the excess (' + fmt(x.shortfall) + ') stopped: ' + failed,
              putBack ? 'Everything was put back as it was before Remittances started on this invoice.' : 'Not put back: ' + left.join('; '),
              'From the ' + (state.remit.insurer || 'insurer') + ' remittance' + (state.remit.date ? ' ' + state.remit.date : '') + (state.remit.reference ? ', ref ' + state.remit.reference : '')],
          });
          say('  Task added for ' + TASK_FOR + ' on ' + x.item.invoice + '.');
        } catch (te) { say('  The task could not be added (' + (te.message || te) + '). Please note this one by hand.', true); }
      }
    }
    // A fixed comment Bank statement reads (Carl, 11 and 12 Nov 2026): the reference (Bupa's BACS reference is the bank
    // reference), the payment date (the money usually reaches the bank about 2 days later), the remittance total, and
    // what was billed and paid on this invoice. "Insurer reference 2662551; payment date 28-Oct-2026; remittance total
    // £ 216.00 over 3 invoices; this invoice billed £ 170.00, paid £ 136.00; invoices UPC-38023, UPC-37981, UPC-37990".
    const remitComment = (x) => {
      const n = attachable().length, paid = state.remit.totals && state.remit.totals.paid;
      const it = x.item;
      const thisPaid = it.insurerTotal !== undefined && it.insurerTotal !== null ? it.insurerTotal : it.paid;
      // What the insurer was billed: the remittance's figure (after any correction), as Halaxy's total is lower once the
      // excess has been moved.
      const billed = typeof it.claimed === 'number' ? it.claimed : x.halaxyTotal;
      return [state.remit.reference ? 'Insurer reference ' + state.remit.reference : '',
        state.remit.date ? 'payment date ' + isoLabel(state.remit.date) : '',
        (typeof paid === 'number' ? 'remittance total ' + fmt(paid) : 'remittance') + ' over ' + n + ' invoice' + (n === 1 ? '' : 's'),
        typeof billed === 'number' && typeof thisPaid === 'number' ? 'this invoice billed ' + fmt(billed) + ', paid ' + fmt(thisPaid) : '',
        // Every invoice the remittance covers (Carl, 12 Nov 2026), so Bank statement can gather the whole remittance from
        // any one of them.
        'invoices ' + attachable().map((y) => y.item.invoice).join(', ')]
        .filter(Boolean).join('; ').replace(/^r/, 'R').replace(/^p/, 'P');
    };
    if (state.attach !== false) {
      const title = (state.remit.insurer || 'Insurer') + ' remittance' + (state.remit.date ? ' ' + state.remit.date : '');
      const dateName = state.remit.date ? state.remit.date + '.pdf' : '';
      for (const x of attachable()) {
        const comments = remitComment(x);
        const attach = () => UPC.files.attachToInvoice(x.invoiceId, state.file, { title, comments, category: UPC.files.CATEGORY.payment });
        try {
          // This remittance already attached: by Remittances (its title) or by hand (named by its date, "2026-09-30.pdf").
          const inv = await UPC.invoice.fetch(x.invoiceId);
          const there = inv.attachmentList.filter((at) => at.title.includes(title) || (dateName && at.title.includes(dateName)));
          if (!there.length) { await attach(); say('Attached the remittance to ' + x.item.invoice + '.'); continue; }
          if (there.some((at) => /payment date/i.test(at.comments) && /\binvoices UPC/i.test(at.comments))) { say('The remittance is already attached to ' + x.item.invoice + '.'); continue; }
          // Attached without the full details (Carl, 13 Nov 2026): if it is this very file, the details are added to it;
          // if it is a different file (the wrong document under the right name, say), it is left alone, this remittance
          // is attached as well, and Carl gets a task to check the other one.
          let same = null, unsure = false;
          for (const at of there) {
            if (!at.fileUrl) { unsure = true; continue; }
            try { if (await UPC.files.sameFile(at.fileUrl, state.file)) { same = at; break; } } catch (e) { unsure = true; }
          }
          if (same && same.editUrl) {
            await UPC.files.updateAttachment(x.invoiceId, same.editUrl, { title, comments, category: UPC.files.CATEGORY.payment });
            say('Added the full details to the remittance already attached to ' + x.item.invoice + '.');
            continue;
          }
          await attach();
          const other = there.map((at) => '"' + at.title + '"').join(', ');
          say((unsure ? 'Could not compare it with ' + other + ' already on ' + x.item.invoice : x.item.invoice + ' already has a different file called ' + other) + ': attached this remittance with its details as well. Check the other one.', true);
          try {
            await UPC.tasks.addToInvoice(x.invoiceId, {
              title: 'Check the remittance attached to ' + x.item.invoice, assignee: TASK_FOR, priority: 2, due: todayLabel(), by: 'Remittances',
              comment: [(unsure ? 'Remittances could not compare ' : 'Remittances found a different file in ') + other + ' (attached ' + there.map((at) => at.created).join(', ') + ').',
                'It attached the ' + title + ' with its details as well. If the other file is the wrong document, delete it.'],
            });
          } catch (e) { /* said in the log */ }
        } catch (e) {
          say('Could not attach the remittance to ' + x.item.invoice + ': ' + (e.message || e), true);
        }
      }
    }
    state.busy = false;
    state.applied = true;   // load the remittance again to run it again
    say('Finished. Open the invoices to check, then record the payments once the money is in the bank.');
  }

  function bind() {
    sh.addEventListener('click', (e) => {
      if (e.target.closest('.upc-rem-drop') && e.target.type !== 'file') { $('.upc-rem-drop input').click(); return; }
      const act = e.target.closest('[data-act]');
      if (act && act.dataset.act === 'apply') apply();
      if (act && act.dataset.act === 'recheck') recheck(+act.dataset.i);
    });
    sh.addEventListener('keydown', (e) => {
      if (e.target.classList && e.target.classList.contains('upc-rem-drop') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); $('.upc-rem-drop input').click(); }
      const ds = e.target.dataset || {};
      const idx = ds.num !== undefined ? ds.num : ds.paid !== undefined ? ds.paid : ds.line !== undefined ? ds.line.split(':')[0] : null;
      if (idx !== null && e.key === 'Enter') { e.preventDefault(); recheck(+idx); }   // Enter in a correction box checks again
    });
    sh.addEventListener('change', (e) => {
      const t = e.target;
      if (t.type === 'file') handleFile(t.files[0]);
      else if (t.dataset.i) { state.results[+t.dataset.i].selected = t.checked; render(); }
      else if (t.dataset.act === 'attach') { state.attach = t.checked; }
    });
    sh.addEventListener('dragover', (e) => { if (e.target.closest('.upc-rem-drop')) { e.preventDefault(); e.target.closest('.upc-rem-drop').classList.add('on'); } });
    sh.addEventListener('dragleave', (e) => { const d = e.target.closest('.upc-rem-drop'); if (d) d.classList.remove('on'); });
    sh.addEventListener('drop', (e) => { if (e.target.closest('.upc-rem-drop')) { e.preventDefault(); handleFile(e.dataTransfer.files[0]); } });
  }

  function mount() {
    if (state.unmount) return;
    if (!window.UPC) { console.error('[UPC remittances] needs the core library'); return; }
    UPC.ui.nativeStyles();
    if (!document.getElementById('upc-rem-css')) { const st = document.createElement('style'); st.id = 'upc-rem-css'; st.textContent = CSS; document.head.appendChild(st); }
    root = document.createElement('div');
    root.className = 'upc-native';
    root.setAttribute('data-upc-remittances', '');
    sh = root;
    bind();
    render();
    state.unmount = UPC.ui.mountPage('Remittances', root, MENU_CLS);
  }
  function unmount() {
    if (!state.unmount) return;
    state.unmount();
    state.unmount = null;
  }
  const route = () => (location.hash === '#' + ROUTE ? (mount(), loadPending()) : unmount());

  // "Check remittance" on each remittance attached to an invoice (Carl, 13 Nov 2026): opens Remittances with that file,
  // to move an excess not moved yet, or add the full details to an older copy. Shown on titles Remittances gives
  // ("Bupa remittance 2026-10-28") and on remittances attached by hand named by their date ("2026-10-28.pdf").
  const PENDING = 'upc-remit-pending';
  const REMIT_TITLE = /remittance|^\d{4}-\d\d-\d\d(\.pdf)?$/i;
  function decorateInvoice() {
    if (!/\/invoice\/\d+\/?$/.test(location.pathname) || location.hash === '#' + ROUTE) return;
    document.querySelectorAll('#invoiceAttachments tbody tr').forEach((tr) => {
      if (tr.querySelector('.upc-remit-check')) return;
      const td = tr.querySelectorAll('td');
      const get = tr.querySelector('a[href*="/file/get/"]');
      if (td.length < 3 || !get || !/\.pdf(\?|$)/i.test(get.getAttribute('href')) || !REMIT_TITLE.test(UPC.clean(td[2].textContent))) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-outline-primary btn-sm upc-remit-check';
      b.textContent = 'Check remittance';
      b.addEventListener('click', () => {
        try { sessionStorage.setItem(PENDING, JSON.stringify({ url: get.getAttribute('href'), name: UPC.clean(td[2].textContent).replace(/\.pdf$/i, '') + '.pdf' })); } catch (e) { return; }
        location.hash = ROUTE;
      });
      const span = document.createElement('span');
      span.className = 'upc-native';
      span.appendChild(b);
      td[td.length - 1].appendChild(span);
    });
  }
  async function loadPending() {
    let p = null;
    try { p = JSON.parse(sessionStorage.getItem(PENDING) || 'null'); sessionStorage.removeItem(PENDING); } catch (e) { p = null; }
    if (!p || !p.url || state.busy) return;
    status('Opening the attached remittance...');
    try {
      const res = await UPC.http.fetch(p.url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Halaxy returned ' + res.status);
      const blob = await res.blob();
      await handleFile(new File([blob], p.name, { type: 'application/pdf' }));
    } catch (e) { status('Could not open the attached remittance (' + (e.message || e) + '). Download it and load it here instead.'); }
  }

  function start() {
    if (!window.UPC) { console.error('[UPC remittances] needs the core library'); return; }
    // Under Finances (Carl, 9 Nov 2026), opening over Halaxy's Invoices page so Halaxy highlights Finances.
    // Remittances opens on any page with its address, so older links to the Finance report still work.
    UPC.ui.ensureMenuItem('Remittances', (section) => {
      const inv = section && [...section.querySelectorAll('a.mainmenu-sublink')].find((a) => /^invoices$/i.test(UPC.clean(a.textContent)));
      return (inv ? inv.getAttribute('href').split('#')[0] : UPC.base() + '/invoice/') + '#' + ROUTE;
    }, MENU_CLS, /^finances?$/i);
    window.addEventListener('hashchange', route);
    route();
    decorateInvoice();
    setInterval(decorateInvoice, 2000);   // Halaxy redraws the attachments after changes (DOM only, no requests)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  // For tests and diagnostics: the reading and matching steps on their own.
  window.upcRemittances = { version: VERSION, readPdf, toRows, understand, detect, matchItem, proposeLines, isoDate, correctItem, checkTotals, amountIn, rangeStates };
})();
