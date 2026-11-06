// ==UserScript==
// @name         Halaxy remittances (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.1.0
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

  const VERSION = '0.1.0';
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
  const fmt = (c) => (c === null || c === undefined ? '' : (c < 0 ? '-£' : '£') + (Math.abs(c) / 100).toFixed(2));
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
        out.items.push({
          invoice: 'UPC-' + digits, claimed: charge, paid: credit, previouslyPaid: previous, insurerTotal: payable,
          patientShare: share > 0 && code ? share : 0, providerShortfall: share > 0 && !code ? share : 0, dates, lines: null,
          reason: share > 0 ? (code ? 'excess' : 'other') : null,
          reasonText: code ? 'Note ' + code + (noteText[code] ? ': ' + noteText[code].slice(0, 90) + (noteText[code].length > 90 ? '...' : '') : '') : '',
        });
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

  // ================================================================== matching with Halaxy

  const halaxyDateIso = (s) => isoDate(String(s || '').replace(/-/g, ' ')) || isoDate(s);

  // Works out what to change on an organisation invoice so the funder lines total what the insurer paid.
  // Uses per-line figures when the remittance gives them, otherwise takes the shortfall from the
  // earliest lines first.
  function proposeLines(funder, item, shortfall) {
    const lines = funder.lines.slice().sort((a, b) => (halaxyDateIso(a.date) || '').localeCompare(halaxyDateIso(b.date) || ''));
    const changes = [];
    if (item.lines && item.lines.length) {
      const pool = lines.slice();
      for (const rl of item.lines) {
        if (rl.paid === null || rl.invoiced === null || rl.paid === rl.invoiced) {
          const idx = pool.findIndex((l) => halaxyDateIso(l.date) === rl.date);
          if (idx >= 0) pool.splice(idx, 1);
          continue;
        }
        const idx = pool.findIndex((l) => halaxyDateIso(l.date) === rl.date && l.amount === rl.invoiced);
        if (idx < 0) return { error: 'No line on ' + funder.number + ' for ' + rl.date + ' at ' + fmt(rl.invoiced) + '.' };
        const l = pool.splice(idx, 1)[0];
        changes.push({ lineId: l.lineId, date: l.date, from: l.amount, to: rl.paid });
      }
      if (sum(changes.map((c) => c.from - c.to)) !== shortfall) return { error: 'The per-line deductions do not add up to the shortfall of ' + fmt(shortfall) + '.' };
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
    if (item.claimed !== null && item.claimed !== undefined && item.claimed !== total) {
      res.message = 'Insurer was billed ' + fmt(item.claimed) + ' but the Halaxy invoice is ' + fmt(total) + '.';
      return res;
    }
    const shortfall = total - insurerPays;
    res.shortfall = shortfall;
    if (shortfall === 0) { res.status = 'ok'; res.message = 'Paid in full.'; return res; }
    if (shortfall < 0) { res.message = 'Insurer paid ' + fmt(-shortfall) + ' more than the invoice.'; return res; }
    if (item.reason === 'provider') { res.status = 'manual'; res.message = 'Provider shortfall of ' + fmt(shortfall) + ': not chargeable to the patient. Decide by hand.'; return res; }
    if (item.reason !== 'excess') { res.message = 'Paid ' + fmt(shortfall) + ' less, with no excess or patient share given. Check by hand.'; return res; }
    if (item.patientShare && item.patientShare !== shortfall) { res.message = 'Patient share ' + fmt(item.patientShare) + ' does not match the shortfall of ' + fmt(shortfall) + '. Check by hand.'; return res; }
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

  const CSS = `
    :host { all: initial; }
    .wrap { font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Arial, sans-serif; color: #1d2433; padding: 16px; max-width: 1100px; }
    h2 { font-size: 18px; margin: 0 0 4px; }
    .muted { color: #5b6478; font-size: 12.5px; }
    .drop { border: 2px dashed #b9c0d0; border-radius: 10px; padding: 28px; text-align: center; margin: 14px 0; background: #fafbfd; cursor: pointer; }
    .drop.on { border-color: #1d4ed8; background: #eef3ff; }
    .status { margin: 10px 0; }
    .notes { background: #fff8db; border: 1px solid #e0b400; border-radius: 6px; padding: 8px 12px; margin: 10px 0; }
    .notes li { margin: 2px 0; }
    table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e6e8ef; vertical-align: top; }
    th { font-size: 12px; color: #5b6478; font-weight: 600; }
    td.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .tag { display: inline-block; border-radius: 999px; padding: 1px 8px; font-size: 12px; font-weight: 600; }
    .t-ok { background: #dcf3e3; color: #14532d; } .t-fix { background: #e3e9ff; color: #1e3a8a; }
    .t-manual { background: #fde7d3; color: #7c2d12; } .t-check { background: #fbd5d5; color: #7a1229; }
    .t-done { background: #dcf3e3; color: #14532d; } .t-failed { background: #fbd5d5; color: #7a1229; }
    .chg { font-size: 12px; color: #374151; }
    .btns { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 12px 0; }
    button { font: inherit; border-radius: 6px; padding: 7px 14px; cursor: pointer; border: 1px solid #c9cfdc; background: #fff; color: #1d2433; }
    button.p { background: #1d4ed8; border-color: #1d4ed8; color: #fff; }
    button[disabled] { opacity: .5; cursor: default; }
    a { color: #1d4ed8; }
    .log { font-size: 12.5px; background: #f6f7fa; border-radius: 6px; padding: 8px 12px; max-height: 260px; overflow: auto; }
    .log .err { color: #b3261e; }
    .modal { position: fixed; inset: 0; background: rgba(20,24,35,.45); display: flex; align-items: center; justify-content: center; z-index: 2147483000; }
    .dlg { background: #fff; border-radius: 10px; padding: 20px; width: min(560px, calc(100vw - 32px)); max-height: 80vh; overflow: auto; box-shadow: 0 12px 40px rgba(0,0,0,.25); }
  `;

  const $ = (s) => sh.querySelector(s);
  const esc = (s) => UPC.esc(s);
  const status = (t) => { const el = sh && $('.status'); if (el) el.textContent = t || ''; };

  function render() {
    const r = state.remit;
    const fixes = state.results.filter((x) => x.status === 'fix');
    let html = '<style>' + CSS + '</style><div class="wrap"><h2>Remittances</h2>' +
      '<div class="muted">Read a remittance, check it against Halaxy, and move excesses to the patient. Payments are never recorded here. Remittances are read on this computer and not uploaded anywhere, except as an attachment to the invoices they cover.</div>' +
      '<div class="drop" tabindex="0" role="button">Drop a remittance PDF here, or click to choose one<input type="file" accept="application/pdf" hidden></div>' +
      '<div class="status" aria-live="polite"></div>';
    if (r) {
      html += '<div><b>' + esc(r.insurer || 'Unknown insurer') + '</b>' + (r.date ? ' remittance dated ' + esc(r.date) : '') + (r.reference ? ', reference ' + esc(r.reference) : '') +
        '. ' + r.items.length + ' invoice' + (r.items.length === 1 ? '' : 's') + ' read' + (r.checks && r.checks.paidTotal !== null ? ', total paid ' + fmt(r.checks.paidTotal) : '') + '.</div>';
      if (r.notes.length) html += '<div class="notes"><b>Check before applying</b><ul>' + r.notes.map((n) => '<li>' + esc(n) + '</li>').join('') + '</ul></div>';
    }
    if (state.results.length) {
      html += '<table><thead><tr><th></th><th>Invoice</th><th class="n">Halaxy</th><th class="n">Insurer paid</th><th class="n">Difference</th><th>Result</th></tr></thead><tbody>';
      state.results.forEach((x, i) => {
        const it = x.item;
        const label = { ok: 'Paid in full', fix: 'Excess', manual: 'By hand', check: 'Check', done: 'Done', failed: 'Failed' }[x.status];
        let link = x.invoiceId ? '<a href="' + esc(UPC.base() + '/invoice/' + x.invoiceId) + '" target="_blank" rel="noopener">' + esc(it.invoice) + '</a>' : esc(it.invoice);
        if (r.scanned && !['done', 'failed'].includes(x.status) && !state.busy) {
          link += '<div class="chg">Read as ' + esc(it.invoice) + '. Wrong? <input data-num="' + i + '" value="' + esc(it.invoice) + '" size="10" aria-label="Correct invoice number"> <button data-act="recheck" data-i="' + i + '">Re-check</button></div>';
        }
        html += '<tr><td>' + (x.status === 'fix' ? '<input type="checkbox" data-i="' + i + '" ' + (x.selected !== false ? 'checked' : '') + ' aria-label="Apply to ' + esc(it.invoice) + '">' : '') + '</td>' +
          '<td>' + link + '</td><td class="n">' + fmt(x.halaxyTotal) + '</td><td class="n">' + fmt(it.insurerTotal !== undefined && it.insurerTotal !== null ? it.insurerTotal : it.paid) + '</td>' +
          '<td class="n">' + (x.shortfall ? fmt(x.shortfall) : '') + '</td>' +
          '<td><span class="tag t-' + x.status + '">' + label + '</span> ' + esc(x.message) +
          (x.changes.length ? '<div class="chg">' + x.changes.map((c) => esc(c.date) + ': funder ' + fmt(c.from) + ' to ' + fmt(c.to) + ', patient pays ' + fmt(c.from - c.to)).join('<br>') + '</div>' : '') +
          (x.error ? '<div class="chg" style="color:#b3261e">' + esc(x.error) + '</div>' : '') + '</td></tr>';
      });
      html += '</tbody></table>';
      const n = fixes.filter((x) => x.selected !== false).length;
      html += '<div class="btns"><button class="p" data-act="apply" ' + (n && !state.busy ? '' : 'disabled') + '>Apply ' + n + ' excess fix' + (n === 1 ? '' : 'es') + '</button>' +
        '<label><input type="checkbox" data-act="attach" ' + (state.attach !== false ? 'checked' : '') + '> Attach the remittance to each matched invoice</label></div>';
    }
    if (state.log.length) html += '<div class="log">' + state.log.map((l) => '<div class="' + (l.err ? 'err' : '') + '">' + esc(l.t) + '</div>').join('') + '</div>';
    html += '<div class="muted" style="margin-top:16px">Remittances ' + VERSION + '</div></div>';
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
      status(state.results.length ? 'Checked. Review the results, then apply the excess fixes you want.' : $('.status').textContent);
    }
  }

  // A scanned invoice number was misread: try the corrected one.
  async function recheck(i) {
    const input = sh.querySelector('input[data-num="' + i + '"]');
    const digits = input && String(input.value).replace(/\D/g, '');
    if (!digits || state.busy) return;
    const item = state.results[i].item;
    item.invoice = 'UPC-' + digits;
    item.corrected = true;
    state.busy = true;
    status('Checking ' + item.invoice + ' in Halaxy...');
    try { state.results[i] = await matchItem(item); } finally { state.busy = false; render(); status('Checked ' + item.invoice + '.'); }
  }

  function confirmApply(list) {
    return new Promise((resolve) => {
      const m = document.createElement('div');
      m.className = 'modal';
      const total = sum(list.map((x) => x.shortfall));
      m.innerHTML = '<div class="dlg" role="dialog" aria-label="Apply excess fixes"><h2>Apply ' + list.length + ' excess fix' + (list.length === 1 ? '' : 'es') + '?</h2>' +
        '<p>For each invoice below, the funder line is reverted to the patient invoice, the rebate is lowered, and the rest is re-billed to the same organisation invoice. ' +
        'Patients will owe ' + fmt(total) + ' in total. No payments are recorded.</p><ul>' +
        list.map((x) => '<li>' + esc(x.item.invoice) + ': ' + x.changes.map((c) => esc(c.date) + ' ' + fmt(c.from) + ' to ' + fmt(c.to)).join(', ') + '</li>').join('') +
        '</ul>' + (state.attach !== false ? '<p class="muted">The remittance will also be attached to each matched invoice.</p>' : '') +
        '<div class="btns" style="justify-content:flex-end"><button data-a="no">Cancel</button><button class="p" data-a="yes">Apply</button></div></div>';
      sh.appendChild(m);
      m.addEventListener('click', (e) => {
        const a = e.target.closest('[data-a]');
        if (!a) return;
        m.remove();
        resolve(a.dataset.a === 'yes');
      });
    });
  }

  async function apply() {
    const list = state.results.filter((x) => x.status === 'fix' && x.selected !== false);
    if (!list.length || state.busy) return;
    if (!(await confirmApply(list))) return;
    state.busy = true;
    const say = (t, err) => { state.log.push({ t, err }); render(); };
    for (const x of list) {
      say(x.item.invoice + ':');
      try {
        for (const c of x.changes) {
          const plan = await UPC.rebate.plan(x.invoiceId, c.lineId, c.to);
          await UPC.rebate.apply(plan, (t) => say('  ' + t));
        }
        x.status = 'done';
        x.message = 'Moved ' + fmt(x.shortfall) + ' to the patient.';
      } catch (e) {
        x.status = 'failed';
        x.error = e.message || String(e);
        say('  Stopped: ' + x.error, true);
      }
    }
    if (state.attach !== false) {
      for (const x of state.results.filter((r) => r.invoiceId && r.funder && r.funder.isFunder)) {
        try {
          await UPC.files.attachToInvoice(x.invoiceId, state.file, {
            title: (state.remit.insurer || 'Insurer') + ' remittance' + (state.remit.date ? ' ' + state.remit.date : ''),
            comments: state.remit.reference ? 'Insurer reference ' + state.remit.reference : '',
            category: UPC.files.CATEGORY.payment,
          });
          say('Attached the remittance to ' + x.item.invoice + '.');
        } catch (e) {
          say('Could not attach the remittance to ' + x.item.invoice + ': ' + (e.message || e), true);
        }
      }
    }
    state.busy = false;
    say('Finished. Open the invoices to check, then record the payments once the money is in the bank.');
  }

  function bind() {
    sh.addEventListener('click', (e) => {
      if (e.target.closest('.drop')) { $('.drop input').click(); return; }
      const act = e.target.closest('[data-act]');
      if (act && act.dataset.act === 'apply') apply();
      if (act && act.dataset.act === 'recheck') recheck(+act.dataset.i);
    });
    sh.addEventListener('keydown', (e) => { if (e.target.classList && e.target.classList.contains('drop') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); $('.drop input').click(); } });
    sh.addEventListener('change', (e) => {
      const t = e.target;
      if (t.type === 'file') handleFile(t.files[0]);
      else if (t.dataset.i) { state.results[+t.dataset.i].selected = t.checked; render(); }
      else if (t.dataset.act === 'attach') { state.attach = t.checked; }
    });
    sh.addEventListener('dragover', (e) => { if (e.target.closest('.drop')) { e.preventDefault(); e.target.closest('.drop').classList.add('on'); } });
    sh.addEventListener('dragleave', (e) => { const d = e.target.closest('.drop'); if (d) d.classList.remove('on'); });
    sh.addEventListener('drop', (e) => { if (e.target.closest('.drop')) { e.preventDefault(); handleFile(e.dataTransfer.files[0]); } });
  }

  function mount() {
    if (state.unmount) return;
    if (!window.UPC) { console.error('[UPC remittances] needs the core library'); return; }
    root = document.createElement('div');
    root.setAttribute('data-upc-remittances', '');
    sh = root.attachShadow({ mode: 'open' });
    bind();
    render();
    state.unmount = UPC.ui.mountPage('Remittances', root, MENU_CLS);
  }
  function unmount() {
    if (!state.unmount) return;
    state.unmount();
    state.unmount = null;
  }
  const route = () => (location.hash === '#' + ROUTE ? mount() : unmount());

  function start() {
    if (!window.UPC) { console.error('[UPC remittances] needs the core library'); return; }
    UPC.ui.ensureMenuItem('Remittances', UPC.base() + '/report/finance/#' + ROUTE, MENU_CLS);
    window.addEventListener('hashchange', route);
    route();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  // For tests and diagnostics: the reading and matching steps on their own.
  window.upcRemittances = { version: VERSION, readPdf, toRows, understand, detect, matchItem, proposeLines, isoDate };
})();
