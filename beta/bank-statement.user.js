// ==UserScript==
// @name         UPC Billing: Bank statement (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.2.1
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/bank-statement.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/bank-statement.user.js
// @description  Finances > Bank statement (Carl only for now): open a Starling statement PDF, add each insurer payment as a deposit on the insurer's profile (Direct Deposit, the bank date) and apply it to the invoices its remittance names, after confirming. The only place insurer money enters Halaxy.
// @match        https://*.halaxy.com/a/pr/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * Bank statement (Carl, 10 and 11 Nov 2026). Carl's rule: an insurer payment is recorded only once the bank statement
 * shows the money arrived. This is where that happens.
 *
 *  - The statement: a Starling Bank business statement PDF (layout from the September 2026 statement), read in the
 *    browser with pdf.js; nothing is uploaded (only the register below is kept). The parse is checked against the statement's running balance.
 *  - Insurer credits: money in whose details name an insurer (Bupa, AXA, WPA, Aviva and others), or name one of our
 *    unpaid insurer invoices (UPC-...). A transfer from the clinic's old account whose reference names an insurer counts
 *    as that insurer's (Carl, 11 Nov 2026). Patients' invoices are not used.
 *  - Candidates: the insurer's unpaid invoices billed to it (Halaxy's Unpaid Invoices report, one request), dated on or
 *    before the credit. Remittances has already settled any excess, so their balances are what was paid.
 *  - Match, in this order: the invoice(s) whose number (UPC-...) is in the bank reference, if they add up to it (Carl:
 *    a reused old reference doesn't fit, so it falls through to the rest); invoices sharing the same remittance (Remittances attaches it to every invoice it covers,
 *    with the comment "Insurer reference ...; remittance total ... over N invoices") that add up to it, preferring the
 *    one whose reference is the bank reference, then one dated within a few days of the payment (Carl: the strongest
 *    sign; a remittance far from the bank date is offered to tick, not ticked); else one invoice whose balance is the credit; else any set of invoices
 *    that adds up to it. One answer is ticked; several are offered to choose from; none says so.
 *  - Record (after confirming; Carl, 13 Nov 2026): each insurer payment becomes a Direct Deposit on the insurer's profile
 *    (the profile its invoices are billed to), dated the bank date, with the note "Bupa, bank 05-Oct-2026, ref 2455419,
 *    Starling statement 01-Oct-2026 to 31-Oct-2026" (core UPC.deposits.add, which checks it is listed). When a remittance
 *    put through Remittances names its invoices and they add up exactly, the deposit is applied to them (core
 *    UPC.deposits.apply, whole balances) and the remittance's copies on the invoices and the profile say so. Otherwise it
 *    waits on the profile and Remittances applies it when the remittance comes; after 10 days a task says it is waiting.
 *  - Never twice: a bank line already recorded the old way (Halaxy's Income report: payments straight onto invoices,
 *    dated 10 days before to 3 days after the bank date, adding up to it) is shown as "Already in Halaxy"; one whose
 *    deposit is on the profile (its note names the bank date) is shown as added or applied. A deposit of the same amount
 *    with no note (by hand) is shown to check.
 *  - Tasks for Carl on what needs him: on the insurer's profile, or a general task when the profile isn't known.
 *  - Register: each statement read leaves one small file on the "Starling Bank (statements)" profile (period, balances,
 *    number of lines, a fingerprint, who read it and when, the insurer payments and what became of them), so a statement
 *    read again, or one overlapping it, is recognised.
 */
(() => {
  'use strict';
  if (window.__hxBankStatement) return;
  window.__hxBankStatement = true;

  const VERSION = '0.2.1';
  const ROUTE = 'upc-bank-statement';
  const MENU_CLS = 'upc-bank-menu';
  const ALLOWED = ['Carl Healy'];
  const METHOD = 'Direct Deposit';
  const TASK_FOR = 'Carl Healy';
  const LOOK_BACK_MONTHS = 18;
  const NEAR_BEFORE = 3, NEAR_AFTER = 14;   // days the bank date may be before / after the remittance's date
  const USUAL_DAYS = 5;   // Carl, 12 Nov 2026: Bupa (and AXA) almost always pay 2 days after the remittance date
  const MAX_AGE_DAYS = 120;   // invoices dated more than this before a payment are not matched to it
  // A payment recorded in Halaxy counts as this bank line's if dated up to this many days before the bank date (recorded
  // on the remittance's date, say) or after it.
  const RECORDED_BEFORE = 10, RECORDED_AFTER = 3;
  // A payment recorded by hand (no note naming its bank line) only counts if dated this close to the bank date: on it,
  // or on the remittance's date a few days before.
  const HAND_BEFORE = 5, HAND_AFTER = 1;
  // Bank lines before this were recorded the old way (payments straight onto invoices). Reading an older statement again
  // only fills in its register: a line not found as recorded is shown to check, never added as a deposit by Record all
  // (Carl, 13 Nov 2026: going back over old statements must not count money twice).
  const CHANGEOVER = '2026-11-01';
  const LINGER_DAYS = 10;   // a deposit with no remittance this long after it reached the bank gets a task (Carl, 13 Nov 2026)
  const REGISTER_ORG = '78812';   // the "Starling Bank (statements)" profile, which keeps a register of each statement read
  const PATIENT_METHODS = /^(card|online payment|discount|stripe|gift card|debt written off|cash)\b/i;   // not how insurers pay
  const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/';
  const INSURERS = [
    ['Bupa', /\bbupa\b/i], ['AXA', /\baxa\b/i], ['WPA', /\bwpa\b/i], ['Aviva', /\baviva\b/i], ['Vitality', /\bvitality\b/i],
    ['Cigna', /\bcigna\b/i], ['Simplyhealth', /\bsimply ?health\b/i], ['Allianz', /\ballianz\b/i], ['Healix', /\bhealix\b/i],
    ['Benenden', /\bbenenden\b/i], ['Westfield', /\bwestfield\b/i], ['Health Shield', /\bhealth ?shield\b/i],
  ];

  const U = () => window.UPC;
  const esc = (s) => U().esc(s);

  const fmt = (c) => U().money.fmt(c);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const isoLabel = (iso) => { const [y, m, d] = iso.split('-'); return d + '-' + MON[Number(m) - 1] + '-' + y; };
  const isoMs = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
  const insurerOf = (text) => (INSURERS.find(([, re]) => re.test(String(text || ''))) || [])[0] || '';
  const refOf = (desc) => { const m = String(desc).match(/\(([^()]*)\)/g); return m ? m[m.length - 1].slice(1, -1).trim() : ''; };
  // Our invoice numbers in a bank reference ("UPC-" then digits, with or without the dash, or a space), as digits without leading zeros.
  const numbersIn = (text) => [...String(text || '').matchAll(/\bUPC[\s-]?0*(\d{2,})\b/gi)].map((m) => m[1]);
  const numberOf = (inv) => (String(inv || '').match(/UPC-?0*(\d+)/i) || [])[1] || '';
  const payerIsFunder = (payer, funder) => { const p = String(payer).toLowerCase(), f = String(funder).toLowerCase(); return !!p && !!f && (p.includes(f) || f.includes(p)); };

  // Who's signed in: the core library's check (Halaxy can fill the name in late, so it keeps looking for 20 seconds).
  const allowed = () => !!U() && U().user.is(ALLOWED);
  const whenAllowed = (fn) => U().user.whenAllowed(ALLOWED, fn);

  // ------------------------------------------------------------------ reading the statement

  // Reads a Starling Bank business statement (PDF) from pdf.js text items. Layout (Sept 2026 statement):
  // columns DATE | TYPE | TRANSACTION | IN | OUT | ACCOUNT BALANCE; amounts like "£1234.56", right-aligned under IN / OUT /
  // ACCOUNT BALANCE; the balance is shown only on some rows; later pages repeat no header.
  function parseStarling(pages) {
    const money = (s) => { const m = String(s).replace(/,/g, '').match(/^(-)?£(\d+)\.(\d\d)$/); return m ? (m[1] ? -1 : 1) * (Number(m[2]) * 100 + Number(m[3])) : null; };
    let cols = null;
    const rows = [];
    let last = null;
    pages.forEach((items) => {
      const words = items.filter((it) => it.str && it.str.trim()).map((it) => ({ s: it.str.trim(), x: it.transform[4], r: it.transform[4] + (it.width || 0), y: Math.round(it.transform[5]) }));
      const lines = [];
      words.sort((a, b) => b.y - a.y || a.x - b.x).forEach((w) => {
        const l = lines.find((x) => Math.abs(x.y - w.y) <= 2);
        if (l) l.words.push(w); else lines.push({ y: w.y, words: [w] });
      });
      lines.forEach((l) => l.words.sort((a, b) => a.x - b.x));
      for (const l of lines) {
        const t = l.words.map((w) => w.s);
        if (t.includes('DATE') && t.includes('TRANSACTION') && t.includes('IN') && t.includes('OUT')) {
          const at = (s) => l.words.find((w) => w.s === s);
          cols = { type: at('TYPE') ? at('TYPE').x : 90, desc: at('TRANSACTION').x, in: at('IN').r, out: at('OUT').r, bal: at('ACCOUNT') ? at('ACCOUNT').r : at('OUT').r + 60 };
          continue;
        }
        if (!cols) continue;
        const first = l.words[0];
        const isDate = /^\d\d\/\d\d\/\d{4}$/.test(first.s) && first.x < cols.type;
        if (!isDate) {
          // a wrapped description line belongs to the row above
          const more = l.words.filter((w) => w.x >= cols.desc - 4 && w.r < cols.in - 30 && money(w.s) === null);
          if (last && more.length && more.length === l.words.length) last.desc += ' ' + more.map((w) => w.s).join(' ');
          continue;
        }
        const [d, m, yy] = first.s.split('/');
        const row = { date: yy + '-' + m + '-' + d, type: '', desc: '', in: null, out: null, balance: null };
        for (const w of l.words.slice(1)) {
          const v = money(w.s);
          if (v !== null) {
            const near = [['in', cols.in], ['out', cols.out], ['balance', cols.bal]].sort((a, b) => Math.abs(a[1] - w.r) - Math.abs(b[1] - w.r))[0][0];
            row[near] = v;
          } else if (w.x < cols.desc - 4) row.type += (row.type ? ' ' : '') + w.s;
          else row.desc += (row.desc ? ' ' : '') + w.s;
        }
        rows.push(row);
        last = row;
      }
    });
    return { rows, found: !!cols };
  }

  async function readStatement(file) {
    const lib = await U().load.script(PDFJS + 'pdf.min.js', 'pdfjsLib');
    if (lib.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) lib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
    const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) pages.push((await (await doc.getPage(i)).getTextContent()).items);
    const st = statementFrom(pages);
    st.fp = await fingerprint(st.list);
    return st;
  }
  // Rows, insurer credits, and a check of the parse against the statement's running balance.
  function statementFrom(pages) {
    const { rows, found } = parseStarling(pages);
    if (!found || !rows.length) throw new (U().Error)('This doesn\'t look like a Starling statement (no DATE / TYPE / TRANSACTION / IN / OUT columns found).');
    let bal = null, bad = 0, checked = 0, opening = null, moved = 0;
    rows.forEach((r) => {
      moved += (r.in || 0) - (r.out || 0);
      if (bal !== null && r.balance !== null) { checked++; if (bal + (r.in || 0) - (r.out || 0) !== r.balance) bad++; }
      if (r.balance !== null && opening === null) opening = r.balance - moved;
      if (r.balance !== null) bal = r.balance; else if (bal !== null) bal += (r.in || 0) - (r.out || 0);
    });
    // Insurer credits, and credits naming one of our invoice numbers (kept only if it's an insurer invoice; see match).
    const credits = rows.filter((r) => r.in > 0 && (insurerOf(r.desc) || numbersIn(r.desc).length))
      .map((r) => ({ key: r.date + '|' + r.in + '|' + refOf(r.desc), date: r.date, insurer: insurerOf(r.desc), desc: r.desc, ref: refOf(r.desc), amount: r.in, numbers: numbersIn(r.desc) }));
    const dates = rows.map((r) => r.date).sort();
    return { rows: rows.length, from: dates[0], to: dates[dates.length - 1], checked, bad, credits, opening, closing: bal, list: rows };
  }

  // ------------------------------------------------------------------ matching

  // Every set of balances (pence) that adds up to `target`, smallest sets first, up to `max` answers.
  function subsets(items, target, max) {
    const out = [];
    const list = items.slice().sort((a, b) => b.balance - a.balance);
    const walk = (i, left, picked) => {
      if (out.length >= max * 4) return;
      if (left === 0) { out.push(picked.slice()); return; }
      if (i >= list.length || left < 0 || picked.length >= 12) return;
      for (let j = i; j < list.length; j++) {
        if (list[j].balance > left) continue;
        picked.push(list[j]); walk(j + 1, left - list[j].balance, picked); picked.pop();
        if (out.length >= max * 4) return;
      }
    };
    walk(0, target, []);
    return out.sort((a, b) => a.length - b.length).slice(0, max);
  }

  // The remittances attached to an invoice, as keys that are the same on every invoice one remittance covers. Remittances
  // attaches the remittance to each invoice with the comment "Insurer reference 2455419; remittance total £ 120.00 over
  // 3 invoices" (0.3.3; earlier versions wrote only the reference) and the title "Bupa remittance 05-Oct-2026".
  const attachments = new Map();   // invoice id -> [{ key, ref }] (this page only)
  const normRef = (s) => String(s || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
  function remitKeys(rows) {
    const out = [];
    rows.forEach((row) => {
      const ref = (row.match(/insurer reference\s+([\w\/-]+)/i) || [])[1];
      const title = (row.match(/\b([A-Za-z]+ remittance(?: \d{4}-\d\d-\d\d| \d\d-[A-Za-z]{3}-\d{4})?)/) || [])[1];
      const file = (row.match(/\bpayment\b.*?([\w .()-]+\.pdf)\b/i) || [])[1];
      const key = ref ? 'reference ' + ref : title || (file && file.trim());
      // The remittance's payment date: from Remittances' comment ("payment date 28-Oct-2026", 0.3.6), else the date in
      // its title ("Bupa remittance 2026-10-08") or in a file name attached by hand ("2026-09-30.pdf").
      const toIso = (t) => {
        const iso = String(t || '').match(/(\d{4})-(\d\d)-(\d\d)/);
        if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];
        const hx = String(t || '').match(/(\d\d)-([A-Za-z]{3})-(\d{4})/);
        return hx && MON.indexOf(hx[2]) >= 0 ? hx[3] + '-' + String(MON.indexOf(hx[2]) + 1).padStart(2, '0') + '-' + hx[1] : '';
      };
      const date = toIso((row.match(/payment date\s+(\d\d-[A-Za-z]{3}-\d{4})/i) || [])[1]) || toIso(title) || toIso(file);
      // What the insurer paid on this invoice ("this invoice billed £ 170.00, paid £ 136.00", 0.3.6).
      const pm = row.match(/this invoice billed £\s?([\d,]+\.\d\d),\s*paid £\s?([\d,]+\.\d\d)/i);
      const paid = pm ? Math.round(parseFloat(pm[2].replace(/,/g, '')) * 100) : null;
      // Every invoice the remittance covers ("invoices UPC-38023, UPC-37981", Remittances 0.3.10), as digits.
      const im = row.match(/\binvoices\s+((?:UPC-?\d+(?:,\s*)?)+)/i);
      const numbers = im ? numbersIn(im[1]) : [];
      if (key && !out.some((x) => x.key === key)) out.push({ key, ref: ref || '', date, paid, numbers });
    });
    return out;
  }
  const orgOfInvoice = new Map();   // invoice id -> the profile it is billed to (its Bill To), this page only
  async function remittancesOf(inv) {
    if (!attachments.has(inv.id)) {
      const full = await U().invoice.fetch(inv.id);
      if (full.billToOrgId) { orgOfInvoice.set(inv.id, full.billToOrgId); U().deposits.rememberOrg(full.billToOrgId, full.billToName, inv.insurer); }
      attachments.set(inv.id, remitKeys(full.attachments));
    }
    return attachments.get(inv.id);
  }

  async function match(statement, say) {
    say('Reading Halaxy\'s Unpaid Invoices report...');
    const from = new Date(); from.setMonth(from.getMonth() - LOOK_BACK_MONTHS);
    const lines = await U().reports.unpaidLines(U().dayLabel(from.getTime()));
    const byId = new Map();
    lines.forEach((l) => {
      if (!l.invoiceId || !payerIsFunder(l.payer, l.funder) || /self.?fund/i.test(l.funder)) return;
      if (!byId.has(l.invoiceId)) byId.set(l.invoiceId, { id: String(l.invoiceId), number: l.invoice, when: U().parseDay(l.date), insurer: insurerOf(l.funder + ' ' + l.payer) || l.funder, balance: l.balance, status: l.invoiceStatus });
    });
    const open = [...byId.values()].filter((i) => i.balance > 0 && i.when !== null);
    // Payments already recorded in Halaxy around the statement's dates (Halaxy's Income report, one request), so a
    // bank line recorded by hand or on another PC shows as already recorded, not matched again (Carl, 12 Nov 2026).
    let pays = [];
    say('Reading the payments recorded in Halaxy...');
    try {
      const day = 86400e3;
      pays = (await U().reports.paymentLines(U().dayLabel(isoMs(statement.from) - RECORDED_BEFORE * day - 3 * day), U().dayLabel(isoMs(statement.to) + RECORDED_AFTER * day)))
        .filter((p) => !PATIENT_METHODS.test(p.method) && U().parseDay(p.date) !== null)
        .map((p, k) => ({ k, invoiceId: p.invoiceId, number: p.invoice, amount: p.amount, method: p.method, date: p.date, when: U().parseDay(p.date),
          insurer: payerIsFunder(p.payer, p.funder) ? insurerOf(p.funder + ' ' + p.payer) || p.funder : '' }));
    } catch (e) {
      state.warn = 'Couldn\'t check which payments are already recorded in Halaxy (' + (e.message || e) + '), so check each one before recording.';
      if (/has changed/.test(e.message || '')) document.dispatchEvent(new CustomEvent('upc-loader-error', { detail: JSON.stringify({ file: 'bank-statement.user.js', message: e.message }) }));
    }
    const usedPay = new Set();
    // Which bank line a recorded payment belongs to, from its note on the invoice: Bank statement writes "Bupa, bank
    // 05-Oct-2026, ref 2455419" (the payment row reads "Direct Deposit (<note>)"). { bank, ref }, or null when the
    // payment has no such note (recorded by hand). Read only for payments that look like a match.
    const notes = new Map();   // invoice id -> its payment rows
    const bankOf = async (p) => {
      if (!p.invoiceId) return null;
      if (!notes.has(p.invoiceId)) { let rows = []; try { rows = (await U().invoice.fetch(p.invoiceId)).paymentRows || []; } catch (e) { rows = []; } notes.set(p.invoiceId, rows); }
      // A payment made by applying a deposit ("Direct Deposit deposit paid on 30-Oct-2026"): the deposit is the record
      // of its bank line, so it is never taken as an old-style payment.
      const amt0 = fmt(p.amount).replace(/^£\s*/, '');
      if (notes.get(p.invoiceId).some((t) => /deposit paid on/i.test(t) && (t.includes(p.date) || t.includes(amt0)))) return { deposit: true };
      const rows = notes.get(p.invoiceId).map((t) => { const m = t.match(/\bbank (\d\d-[A-Za-z]{3}-\d{4})(?:, ref ([^)]*))?/i); return { t, bank: m ? m[1] : '', ref: m && m[2] ? m[2].trim() : '' }; });
      const amt = fmt(p.amount).replace(/^£\s*/, '');
      let mine = rows.filter((r) => r.t.includes(p.date) && r.t.includes(amt));
      if (!mine.length) mine = rows.filter((r) => r.t.includes(p.date));
      if (!mine.length && rows.length === 1) mine = rows;
      const tags = [...new Set(mine.map((r) => r.bank + '|' + r.ref))];
      if (tags.length !== 1 || !mine[0].bank) return null;
      return { bank: mine[0].bank, ref: mine[0].ref };
    };
    const belongs = (tag, c) => tag.bank === isoLabel(c.date) && (!tag.ref || !c.ref || normRef(tag.ref) === normRef(c.ref));
    // The payments that look like this bank line already recorded: our invoice numbers in the bank reference, or the
    // insurer's payments dated from RECORDED_BEFORE days before to RECORDED_AFTER days after it that add up to it (one
    // day's payments first, the nearest day first; else the only set that adds up). `skip`: payments known to be another
    // bank line's.
    const candidateFor = (c, sameDay, skip) => {
      const free = pays.filter((p) => !usedPay.has(p.k) && !skip.has(p.k));
      if (c.numbers.length) {
        const named = free.filter((p) => c.numbers.includes(numberOf(p.number)));
        if (named.length && named.reduce((t, p) => t + p.amount, 0) === c.amount) return named;
      }
      if (!c.insurer) return null;
      const gap = (p) => Math.round((isoMs(c.date) - p.when) / 86400e3);
      const pool = free.filter((p) => p.insurer === c.insurer && (sameDay ? gap(p) === 0 : gap(p) >= -RECORDED_AFTER && gap(p) <= RECORDED_BEFORE))
        .sort((x, y) => Math.abs(gap(x)) - Math.abs(gap(y)) || gap(x) - gap(y));
      const days = [...new Set(pool.map((p) => p.date))];
      for (const d of days) { const g = pool.filter((p) => p.date === d); if (g.reduce((t, p) => t + p.amount, 0) === c.amount) return g; }
      const sets = subsets(pool.slice(0, 12).map((p) => Object.assign({}, p, { balance: p.amount })), c.amount, 2);
      return sets.length === 1 ? sets[0] : null;
    };
    // A candidate, checked against the payments' notes: every payment's note names this bank line (sure); a payment
    // whose note names another bank line is set aside and it looks again; payments with no note (by hand) are taken
    // only if dated close to the bank date (HAND_BEFORE / HAND_AFTER days), and then checked for clashes below.
    const recordedFor = async (c, sameDay) => {
      const skip = new Set();
      for (let tries = 0; tries < 6; tries++) {
        const cand = candidateFor(c, sameDay, skip);
        if (!cand) return null;
        let elsewhere = false, hand = false;
        for (const p of cand) {
          if (p.tag === undefined) p.tag = await bankOf(p);
          if (p.tag && (p.tag.deposit || !belongs(p.tag, c))) { skip.add(p.k); elsewhere = true; }
          else if (!p.tag) hand = true;
        }
        if (elsewhere) continue;
        if (hand) {
          const gap = (p) => Math.round((isoMs(c.date) - p.when) / 86400e3);
          if (cand.some((p) => !p.tag && (gap(p) > HAND_BEFORE || gap(p) < -HAND_AFTER))) return null;
        }
        return { list: cand, hand };
      }
      return null;
    };
    // Payments dated the bank date are settled first, for every bank line, then the rest of the window: so a payment
    // recorded on its own bank date is never taken by a neighbouring line of the same amount.
    const recorded = new Map();
    const lines0 = statement.credits.slice().sort((a, b) => a.date.localeCompare(b.date));
    for (const sameDay of [true, false]) {
      for (const c of lines0) {
        if (recorded.has(c.key)) continue;
        if (!sameDay) say('Checking what is already recorded in Halaxy...');
        const rec = await recordedFor(c, sameDay);
        if (rec) { rec.list.forEach((p) => usedPay.add(p.k)); recorded.set(c.key, rec); }
      }
    }
    // A match made only from payments recorded by hand (no note) is not certain when another bank line could be the
    // same payment: one on this statement from the same insurer for the same amount, dated close to those payments and
    // not itself recorded for sure; or one on last month's statement (a payment dated before this statement starts).
    // Neither is marked; both say to check which is recorded (Carl, 12 Nov 2026).
    const doubt = new Map();   // credit key -> text
    recorded.forEach((rec, key) => {
      if (!rec.hand) return;
      const c = statement.credits.find((x) => x.key === key);
      const near = (d) => rec.list.some((p) => { const g = Math.round((isoMs(d.date) - p.when) / 86400e3); return g <= HAND_BEFORE && g >= -HAND_AFTER; });
      const rivals = statement.credits.filter((d) => d.key !== key && d.insurer === c.insurer && d.amount === c.amount && near(d) && !(recorded.has(d.key) && !recorded.get(d.key).hand));
      const early = rec.list.some((p) => p.when < isoMs(statement.from));
      if (!rivals.length && !early) return;
      const what = rec.list.map((p) => p.number + ' ' + fmt(p.amount) + ' (' + p.date + ')').join(', ');
      const why = rivals.length ? 'recorded by hand in Halaxy: ' + what + ', but ' + (rivals.length === 1 ? 'the ' + isoLabel(rivals[0].date) + ' payment' : rivals.length + ' other payments') + ' of the same amount could be that one too: check which is recorded'
        : 'recorded by hand in Halaxy: ' + what + ', dated before this statement starts, so it may be last month\'s payment: check';
      doubt.set(key, why);
      rivals.forEach((d) => { if (!doubt.has(d.key)) doubt.set(d.key, 'the ' + isoLabel(c.date) + ' payment of the same amount may be the one recorded by hand in Halaxy (' + what + '): check which is recorded'); });
    });
    doubt.forEach((t, key) => recorded.delete(key));

    // The insurer's profile in Halaxy, where the deposit goes: the profile the matched invoices are billed to; else the
    // one profile known for the insurer (seen on its invoices); else the profile of one of its unpaid invoices.
    const orgByInsurer = new Map();
    const orgFor = async (r) => {
      const set = r.remit && r.options.length === 1 ? r.options[0] : null;
      if (set) {
        const ids = [...new Set(set.map((i) => orgOfInvoice.get(i.id)).filter(Boolean))];
        if (ids.length === 1) return { id: ids[0] };
        if (ids.length > 1) return { why: 'its invoices are billed to different profiles' };
      }
      if (orgByInsurer.has(r.insurer)) return orgByInsurer.get(r.insurer);
      let known = U().deposits.orgsFor(r.insurer);
      if (!known.length) {
        const one = open.find((i) => i.insurer === r.insurer);
        if (one) {
          try {
            const inv = await U().invoice.fetch(one.id);
            if (inv.billToOrgId) { U().deposits.rememberOrg(inv.billToOrgId, inv.billToName, r.insurer); known = [inv.billToOrgId]; }
          } catch (e) { /* said below */ }
        }
      }
      const found = known.length === 1 ? { id: known[0] } : { why: known.length ? 'more than one ' + r.insurer + ' profile is in use' : 'no ' + r.insurer + ' invoice to find it from' };
      orgByInsurer.set(r.insurer, found);
      return found;
    };
    // This bank line's deposit on the profile: the one whose note names its bank date (and reference), as Bank
    // statement writes it; or a deposit of the same amount added by hand near the bank date (to check).
    const depLists = new Map(), usedDep = new Set();
    const depositFor = async (r, orgId) => {
      if (!depLists.has(orgId)) depLists.set(orgId, await U().deposits.list(orgId));
      const same = depLists.get(orgId).filter((d) => d.amount === r.amount && !usedDep.has(d.id));
      for (const d of same) if (d.note === undefined) Object.assign(d, await U().deposits.details(d.id));
      const own = same.filter((d) => d.note.includes('bank ' + isoLabel(r.date)) && (!r.ref || d.note.includes('ref ' + r.ref)));
      if (own.length) { usedDep.add(own[0].id); return { own: own[0] }; }
      const hand = same.filter((d) => !/\bbank \d\d-[A-Za-z]{3}-\d{4}/.test(d.note) && Math.abs((U().parseDay(d.date || d.day) || 0) - isoMs(r.date)) <= HAND_BEFORE * 86400e3);
      return hand.length ? { hand } : {};
    };

    const used = new Set();
    const results = [];
    const credits = statement.credits.slice().sort((a, b) => a.date.localeCompare(b.date));
    let n = 0;
    for (const c of credits) {
      n++;
      const r = Object.assign({}, c, { state: 'none', options: [], remit: false });
      // 0. The bank reference names our invoice(s) and they add up to the payment. A named invoice that doesn't fit (an
      //    old reference reused, Carl 11 Nov 2026) is set aside and the payment matched by amount and date as usual.
      const named = c.numbers.map((n) => open.find((i) => numberOf(i.number) === n && !used.has(i.id))).filter(Boolean);
      const namedFits = named.length === c.numbers.length && named.length && named.reduce((t, i) => t + i.balance, 0) === c.amount &&
        named.every((i) => i.when <= isoMs(c.date) + 86400e3) && (!c.insurer || named.every((i) => i.insurer === c.insurer));
      if (!c.insurer && namedFits) r.insurer = named[0].insurer;
      // Already recorded in Halaxy the old way (payments straight onto invoices, by hand or by Bank statement before
      // 0.2.0): nothing more to do, and no deposit is added for it (Carl, 13 Nov 2026: never counted twice).
      const rec = recorded.get(c.key) && recorded.get(c.key).list;
      if (rec && (r.insurer || rec.some((p) => p.insurer))) {
        if (!r.insurer) r.insurer = (rec.find((p) => p.insurer) || {}).insurer;
        const dates = [...new Set(rec.map((p) => p.date))], methods = [...new Set(rec.map((p) => p.method))];
        r.state = 'recorded';
        r.invoices = rec.map((p) => ({ id: p.invoiceId, number: p.number, amount: p.amount }));
        r.how = 'already recorded in Halaxy: ' + methods.join(', ') + ', ' + dates.join(', ') + (recorded.get(c.key).hand ? ' (by hand)' : ' (its note names this payment)');
        results.push(r);
        continue;
      }
      if (!r.insurer) continue;   // names an invoice that isn't an unpaid insurer invoice (a patient paying, say): not ours here
      results.push(r);
      if (doubt.has(c.key)) { r.state = 'check'; r.how = doubt.get(c.key); continue; }
      say('Matching ' + r.insurer + ' ' + fmt(c.amount) + ' (' + n + ' of ' + credits.length + ')...');
      if (namedFits) {
        r.state = 'matched'; r.options = [named];
        r.how = 'the invoice number' + (named.length === 1 ? '' : 's') + ' in the bank reference';
      } else {
        const setAside = c.numbers.length ? 'the bank reference names ' + (String(c.desc).match(/\bUPC[\s-]?\d{2,}\b/gi) || []).join(', ') + ', which doesn\'t fit (paid already, or another amount); ' : '';
        // Only invoices dated in the few months before the payment: an older unpaid invoice that happens to add up is
        // not evidence (Carl, 12 Nov 2026: once a payment's own invoices are paid, it reached further back).
        const cand = open.filter((i) => i.insurer === c.insurer && !used.has(i.id) && i.when <= isoMs(c.date) + 86400e3 && i.when >= isoMs(c.date) - MAX_AGE_DAYS * 86400e3).sort((a, b) => b.when - a.when);
        // 1. The invoices covered by one remittance (Remittances attaches the same PDF to each) that add up to it: the
        //    strongest evidence. 2. One invoice for the whole amount. 3. Any set of invoices that adds up to it.
        const recent = cand.slice(0, 30);
        const groups = new Map();   // key -> { ref, list }
        for (const i of recent) {
          let keys = [];
          try { keys = await remittancesOf(i); } catch (e) { keys = []; }
          keys.forEach((k) => { if (!groups.has(k.key)) groups.set(k.key, { key: k.key, ref: k.ref, date: k.date, numbers: k.numbers, list: [], paid: [] }); groups.get(k.key).list.push(i); groups.get(k.key).paid.push(k.paid); });
        }
        // A remittance that lists its invoices gathers all of them, even one outside the recent invoices looked at.
        for (const g of groups.values()) {
          if (!g.numbers || !g.numbers.length) continue;
          open.filter((i) => i.insurer === c.insurer && !used.has(i.id) && g.numbers.includes(numberOf(i.number)) && !g.list.includes(i)).forEach((i) => { g.list.push(i); g.paid.push(null); });
        }
        for (const g of groups.values()) for (const i of g.list) if (!orgOfInvoice.has(i.id)) { try { await remittancesOf(i); } catch (e) { /* no profile: checked when recording */ } }
        const target = c.amount;
        let byRemit = [...groups.values()].filter((g) => g.list.reduce((t, i) => t + i.balance, 0) === target);
        // The remittance says these invoices were paid this amount, but Halaxy still shows more on them: the excess has
        // not been moved to the patient yet (a remittance attached by hand, before Remittances).
        const notMoved = !byRemit.length ? [...groups.values()].filter((g) => g.paid.every((x) => x !== null) && g.paid.reduce((t, x) => t + x, 0) === target) : [];
        // The bank reference being the remittance's own reference settles it. Otherwise the payment usually reaches the
        // bank within a few days of the remittance's date (Carl, 11 Nov 2026): a remittance in that window is preferred,
        // and one far from it is only offered, not ticked.
        byRemit.forEach((g) => { g.gap = g.date ? Math.round((isoMs(c.date) - isoMs(g.date)) / 86400e3) : null; g.near = g.gap !== null && g.gap >= -NEAR_BEFORE && g.gap <= NEAR_AFTER; });
        const sameRef = byRemit.filter((g) => g.ref && c.ref && normRef(c.ref).includes(normRef(g.ref)));
        const near = byRemit.filter((g) => g.near);
        const usual = byRemit.filter((g) => g.gap !== null && g.gap >= 0 && g.gap <= USUAL_DAYS);   // Bupa and AXA: usually 2 days after
        if (sameRef.length === 1) byRemit = sameRef;
        else if (near.length === 1) byRemit = near;
        else if (usual.length === 1) byRemit = usual;
        const dated = (g) => g.date ? ', dated ' + isoLabel(g.date) + (g.gap === 0 ? ', the day of the payment' : ', ' + Math.abs(g.gap) + ' day' + (Math.abs(g.gap) === 1 ? '' : 's') + (g.gap > 0 ? ' before' : ' after') + ' the payment') : '';
        const single = cand.filter((i) => i.balance === target);
        if (byRemit.length === 1) {
          const g = byRemit[0];
          const sure = sameRef.length === 1 || g.near || !g.date;
          r.state = sure ? 'matched' : 'choose';
          r.how = (sure ? '' : 'check the date: ') + 'the invoices on the remittance with ' + g.key + dated(g) + (sameRef.length === 1 ? ' (the same reference as the bank)' : '');
          r.options = [g.list]; r.remit = true; r.remits = [g];
        } else if (byRemit.length > 1) { r.state = 'choose'; r.how = 'more than one remittance adds up to it'; r.options = byRemit.map((g) => g.list); r.labels = byRemit.map((g) => g.key + dated(g)); r.remit = true; r.remits = byRemit; }
        // Amount alone is weak evidence (£ 40.00 fits many invoices), and without a remittance the deposit is only added,
        // not applied (Carl, 13 Nov 2026): these are shown as the invoices it may be for.
        else if (single.length === 1) { r.how = 'one invoice for the whole amount, but no remittance links them'; r.options = [single]; }
        else {
          const sets = single.length > 1 ? single.map((i) => [i]) : subsets(recent.slice(0, 24), target, 4);
          if (sets.length === 1) { r.how = 'the only set of ' + c.insurer + ' invoices that adds up to it, but no remittance links them'; r.options = sets; }
          else if (sets.length) { r.how = 'more than one set of invoices adds up to it'; r.options = sets; }
          else if (notMoved.length === 1) {
            const g = notMoved[0];
            r.how = 'the remittance with ' + g.key + ' paid this on ' + g.list.map((i) => i.number).join(', ') + ', but Halaxy still shows ' +
              fmt(g.list.reduce((t, i) => t + i.balance, 0)) + ' on them: move the excess to the patient with Remittances, and it applies the deposit then';
          } else r.how = 'no unpaid ' + c.insurer + ' invoices add up to it (has the remittance been through Remittances? An excess not yet moved to the patient leaves the invoice showing more than the insurer paid)';
        }
        if (setAside) r.how = setAside + (r.how || '');
      }
      // The deposit, on the insurer's profile.
      const org = await orgFor(r);
      r.org = org.id || null;
      if (!r.org) { r.state = 'noorg'; r.how = 'Couldn\'t tell which ' + r.insurer + ' profile in Halaxy this goes on (' + org.why + ')'; r.pick = null; continue; }
      let dep = {};
      try { dep = await depositFor(r, r.org); } catch (e) { r.state = 'check'; r.how = 'Couldn\'t read the deposits on the ' + r.insurer + ' profile: ' + (e.message || e); r.pick = null; continue; }
      const withRemit = r.remit && (r.state === 'matched' || r.state === 'choose');
      if (dep.own) {
        r.deposit = dep.own;
        if (dep.own.balance === 0) { r.state = 'applied'; r.pick = null; continue; }
        if (dep.own.balance !== dep.own.amount) { r.state = 'check'; r.how = 'its deposit (' + fmt(dep.own.amount) + ') is partly applied, ' + fmt(dep.own.balance) + ' left: check it on the ' + r.insurer + ' profile'; r.pick = null; continue; }
        if (!withRemit) { r.state = 'waiting'; r.pick = null; continue; }
        if (r.state === 'matched') r.state = 'apply';
      } else if (dep.hand) {
        r.state = 'check'; r.pick = null;
        r.how = 'a ' + fmt(r.amount) + ' deposit with no bank note is already on the ' + r.insurer + ' profile (' + dep.hand.map((d) => d.date || isoLabel(d.day)).join(', ') + '), perhaps added by hand: check whether it is this payment';
        continue;
      } else if (r.date < CHANGEOVER) {
        r.old = r.state; r.state = 'old';
        r.pick = r.old === 'matched' ? 0 : r.old === 'choose' ? null : null;
        continue;
      } else if (!withRemit) r.state = 'deposit';
      if (r.state === 'matched' || r.state === 'apply') r.options[0].forEach((i) => used.add(i.id));
      r.pick = r.state === 'matched' || r.state === 'apply' ? 0 : null;
    }
    return results;
  }

  // ------------------------------------------------------------------ recording

  // The deposit's note: the bank line it came from (Bank statement finds its own deposits by this).
  const noteFor = (r, st) => r.insurer + ', bank ' + isoLabel(r.date) + (r.ref ? ', ref ' + r.ref : '') + (st ? ', Starling statement ' + isoLabel(st.from) + ' to ' + isoLabel(st.to) : '');
  const today = () => U().dayLabel(Date.now());

  // Adds the bank line's deposit on the insurer's profile, and applies it when a remittance names its invoices. The
  // money is in the bank, so the deposit is added even when the invoices have changed; it is then left to apply.
  async function record(r, say) {
    const set = r.pick !== null && r.pick !== undefined ? r.options[r.pick] : null;
    const applyTo = r.remit && set ? set : null;
    let why = '';
    if (applyTo) {
      const total = applyTo.reduce((t, i) => t + i.balance, 0);
      if (total !== r.amount) why = 'the invoices add up to ' + fmt(total) + ', not ' + fmt(r.amount);
      for (const i of applyTo) {
        if (why) break;
        say('Checking ' + i.number + '...');
        const inv = await U().invoice.fetch(i.id);
        if (inv.outstanding !== i.balance) why = i.number + ' now shows ' + (inv.outstanding === null || inv.outstanding === 0 ? 'nothing' : fmt(inv.outstanding)) + ' outstanding, not ' + fmt(i.balance);
        else if (inv.billToOrgId && inv.billToOrgId !== r.org) why = i.number + ' is billed to another profile';
      }
    }
    if (!r.deposit) {
      say('Adding the ' + r.insurer + ' deposit of ' + fmt(r.amount) + ' (bank ' + isoLabel(r.date) + ')...');
      r.deposit = await U().deposits.add(r.org, { method: METHOD, date: isoLabel(r.date), amount: r.amount, note: noteFor(r, state.statement) });
      r.added = true;
    }
    r.state = 'waiting';
    if (!applyTo) return;
    if (why) {
      r.error = 'Deposit added, not applied: ' + why + '.';
      await taskFor(r, r.insurer + ' deposit ' + isoLabel(r.date) + ' ' + fmt(r.amount) + ': not applied, please check',
        ['The deposit from the bank (' + isoLabel(r.date) + (r.ref ? ', ref ' + r.ref : '') + ') is on the profile, but Bank statement did not apply it to ' + applyTo.map((i) => i.number).join(', ') + ': ' + why + '.', 'Check the invoices and apply the deposit by hand.']);
      return;
    }
    say('Applying it to ' + applyTo.map((i) => i.number).join(', ') + '...');
    try { await U().deposits.apply(r.org, r.deposit.id, applyTo.map((i) => i.id), r.amount); }
    catch (e) {
      r.error = 'Deposit ' + (r.added ? 'added' : 'there') + ', not applied: ' + (e.message || e);
      await taskFor(r, r.insurer + ' deposit ' + isoLabel(r.date) + ' ' + fmt(r.amount) + ': applying it stopped, please check',
        ['Applying the deposit from the bank (' + isoLabel(r.date) + ') to ' + applyTo.map((i) => i.number).join(', ') + ' stopped: ' + (e.message || e), 'Check the profile\'s deposits and the invoices.']);
      return;
    }
    r.state = 'applied'; r.applied = Date.now();
    r.invoices = applyTo.map((i) => ({ id: i.id, number: i.number, amount: i.balance }));
    // The remittance's copies say which deposit paid them: on each invoice and on the profile (not essential).
    const g = r.remits && r.remits[r.pick];
    const text = 'deposit ' + fmt(r.amount) + ' from the bank ' + isoLabel(r.date) + ', applied ' + today();
    const ours = (title, comments) => g && ((g.ref && comments.includes('Insurer reference ' + g.ref)) || (!g.ref && title.startsWith(g.key)));
    for (const i of applyTo) {
      try {
        const inv = await U().invoice.fetch(i.id);
        for (const at of inv.attachmentList.filter((a) => a.editUrl && ours(a.title, a.comments))) await U().files.updateAttachment(i.id, at.editUrl, { append: text });
      } catch (e) { say('The deposit is applied, but the remittance on ' + i.number + ' does not say so yet (' + (e.message || e) + ').', true); }
    }
    try {
      if (g) for (const f of await U().orgFiles.find(r.org, (d) => ours(d.title, d.comments), g.ref || r.insurer + ' remittance')) await U().orgFiles.update(f.id, { append: text });
    } catch (e) { say('The deposit is applied, but the remittance on the profile does not say so yet (' + (e.message || e) + ').', true); }
  }

  // A task for Carl: on the insurer's profile, or a general one when the profile isn't known.
  async function taskFor(r, title, comment) {
    const task = { title, assignee: TASK_FOR, priority: 3, due: today(), by: 'Bank statement', comment };
    try {
      if (r.org) await U().tasks.addToOrganisation(r.org, task);
      else await U().tasks.addGeneral(task);
      r.tasked = true;
      return true;
    } catch (e) { r.error = (r.error ? r.error + ' ' : '') + 'The task could not be added (' + (e.message || e) + ').'; return false; }
  }
  const checkTask = (r) => taskFor(r, 'Bank statement: ' + r.insurer + ' ' + fmt(r.amount) + ' (' + isoLabel(r.date) + ') needs checking',
    ['The ' + r.insurer + ' payment of ' + fmt(r.amount) + ' (bank ' + isoLabel(r.date) + (r.ref ? ', ref ' + r.ref : '') + ', ' + r.desc + ') was not recorded: ' + r.how + '.',
      'Record it by hand once checked' + (r.org ? ', as a Direct Deposit on this profile.' : ', as a Direct Deposit on the insurer\'s profile.')]);

  // ------------------------------------------------------------------ the statement register

  // Each statement read leaves one small record on the "Starling Bank (statements)" profile (Carl, 13 Nov 2026): its
  // period, balances, number of lines and fingerprint, who read it and when, and each insurer payment and what became
  // of it. Nothing else from the statement. A statement read again (or one overlapping it) is recognised from it.
  const outcome = (r) => ({ recorded: 'already recorded in Halaxy', applied: 'deposit applied' + (r.invoices ? ' to ' + r.invoices.map((i) => i.number).join(', ') : ''),
    waiting: 'deposit added, waiting for the remittance', old: 'before the switch to deposits, not found as recorded: to check', deposit: 'not recorded yet', matched: 'not recorded yet', choose: 'not recorded yet', apply: 'deposit not applied yet',
    check: 'needs checking' + (r.tasked ? ' (task added)' : ''), noorg: 'insurer profile not known' + (r.tasked ? ' (task added)' : ''), none: 'not recorded' }[r.state] || r.state);
  const lineOf = (r) => isoLabel(r.date) + ' ' + r.insurer + ' ' + fmt(r.amount) + (r.ref ? ' ref ' + r.ref : '') + ': ' + outcome(r);
  const spanOf = (t) => { const m = String(t || '').match(/(\d{4}-\d\d-\d\d) to (\d{4}-\d\d-\d\d)/); return m ? [m[1], m[2]] : null; };
  async function fingerprint(rows) {
    const text = rows.map((r) => [r.date, r.type, r.desc, r.in, r.out, r.balance].join('|')).join('\n');
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // The registers already on the profile whose period overlaps this statement's: { id, title, comments }.
  async function registersFor(st) {
    const files = await U().orgFiles.list(REGISTER_ORG);
    const dated = files.filter((f) => spanOf(f.text));
    const overlaps = (sp) => sp && sp[0] <= st.to && sp[1] >= st.from;
    const look = dated.length ? dated.filter((f) => overlaps(spanOf(f.text))) : files.slice(0, 25);
    const out = [];
    for (const f of look) { const d = await U().orgFiles.details(f.id); if (/^starling statement/i.test(d.title) && overlaps(spanOf(d.title))) out.push(d); }
    return out;
  }
  // A plain one-font PDF of text lines (A4, Helvetica 9 pt), enough for a register anyone can open.
  function makePdf(lines) {
    const wrap = [];
    lines.forEach((l) => { let t = String(l); do { wrap.push(t.slice(0, 105)); t = t.slice(105); } while (t); });
    const enc = (t) => t.replace(/[^\x20-\x7e£]/g, '-').replace(/[\\()]/g, (ch) => '\\' + ch);
    const pages = [];
    for (let i = 0; i < wrap.length; i += 62) pages.push(wrap.slice(i, i + 62));
    const objs = [null, '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [' + pages.map((p, k) => (4 + k * 2) + ' 0 R').join(' ') + '] /Count ' + pages.length + ' >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'];
    pages.forEach((ls, k) => {
      const body = 'BT /F1 9 Tf 12 TL 40 800 Td ' + ls.map((l) => '(' + enc(l) + ') Tj T*').join(' ') + ' ET';
      objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ' + (5 + k * 2) + ' 0 R >>');
      objs.push('<< /Length ' + body.length + ' >>\nstream\n' + body + '\nendstream');
    });
    let out = '%PDF-1.4\n';
    const at = [];
    for (let i = 1; i < objs.length; i++) { at[i] = out.length; out += i + ' 0 obj\n' + objs[i] + '\nendobj\n'; }
    const xref = out.length;
    out += 'xref\n0 ' + objs.length + '\n0000000000 65535 f \n' + at.slice(1).map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('') +
      'trailer\n<< /Size ' + objs.length + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
    return Uint8Array.from(out, (ch) => ch.charCodeAt(0) & 255);
  }
  // Writes (or updates) this statement's register after a run.
  async function writeRegister(st, results) {
    const me = U().user.name(ALLOWED) || 'unknown';
    const title = 'Starling statement ' + st.from + ' to ' + st.to;
    const was = state.register && (state.register.comments.match(/first read ([^;]+)/) || [])[1];
    const comments = ['Fingerprint ' + st.fp, st.rows + ' transactions', 'opening ' + fmt(st.opening) + ', closing ' + fmt(st.closing),
      'first read ' + (was || today() + ' by ' + me), 'last run ' + today() + ' by ' + me, 'insurer payments: ' + (results.length ? results.map(lineOf).join(', ') : 'none')].join('; ');
    if (state.register) { await U().orgFiles.update(state.register.id, { title, comments }); state.register.comments = comments; return; }
    const pdf = makePdf(['Starling Bank statement register', '', 'Statement: ' + isoLabel(st.from) + ' to ' + isoLabel(st.to),
      'Opening balance ' + fmt(st.opening) + ', closing balance ' + fmt(st.closing) + ', ' + st.rows + ' transactions', 'Fingerprint ' + st.fp,
      'Read ' + today() + ' by ' + me + ' (Bank statement ' + VERSION + ')', '', 'Insurer payments (only these are kept here) and what Bank statement did:', '']
      .concat(results.length ? results.map(lineOf) : ['None']).concat(['', 'Later runs are noted in this file\'s comments.']));
    const id = await U().orgFiles.attach(REGISTER_ORG, new File([pdf], title + '.pdf', { type: 'application/pdf' }), { title, comments });
    state.register = { id, title, comments };
  }

  // ------------------------------------------------------------------ page

  const CSS = `
    .upc-bank { max-width: 1200px; }
    .upc-bank h1 { margin: 0 0 16px; }
    .upc-bank .card { margin-bottom: 24px; }
    .upc-bank .card-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .upc-bank .card-header h2 { margin: 0; }
    .upc-bank .btn { margin: 0; }
    .upc-bank .upc-bank-drop { border: 2px dashed var(--vs-theme-border-color, #ced4da); border-radius: 4.8px; padding: 28px; text-align: center; margin-top: 12px;
      background: var(--vs-card-standout-bg-color, #f0f0f5); cursor: pointer; }
    .upc-bank .upc-bank-drop.on { border-color: var(--vs-theme-primary, #0e0793); }
    .upc-bank td.upc-bank-date, .upc-bank td.number { white-space: nowrap; }
    .upc-bank .upc-bank-set { margin: 2px 0; }
    .upc-bank .upc-bank-set a { margin-right: 6px; white-space: nowrap; }
    .upc-bank tr.upc-off td { color: var(--vs-viewData-label-color, #6c757d); }
  `;
  const state = { unmount: null, busy: false, status: '', error: '', warn: '', seen: '', statement: null, results: null, run: null, register: null };
  let root = null;

  function setHtml(r, k) {
    const base = U().base();
    return r.options[k].map((i) => '<a href="' + esc(base + '/invoice/' + i.id) + '" target="_blank" rel="noopener">' + esc(i.number) + '</a> ' + fmt(i.balance)).join(', ');
  }
  const actionable = (r) => ['deposit', 'matched', 'apply'].includes(r.state) || (r.state === 'choose' && r.pick !== null);
  const needsTask = (r) => (r.state === 'check' || r.state === 'noorg') && !r.tasked;
  function render() {
    if (!root) return;
    const st = state.statement, rs = state.results;
    // Laid out as Remittances (Carl, 13 Nov 2026): a "Read ..." card with what it does, the drop box, progress and notes.
    let h = '<div class="upc-bank"><h1>Bank statement</h1>' +
      '<div class="card"><div class="card-header"><h2>Read a bank statement</h2></div><div class="card-body">' +
      '<div class="text-muted">Read the month\'s Starling statement and, once you confirm, add each insurer payment as a deposit on the insurer\'s profile (' + METHOD + ', dated the day it reached the bank). A deposit whose remittance has been through Remittances is applied to its invoices straight away; the rest are applied by Remittances when the remittance comes. Other money in and money out are not used. The statement is read on this computer; only a short register (dates, balances and the insurer payments) is kept on the Starling Bank profile.</div>' +
      '<div class="upc-bank-drop" tabindex="0" role="button" data-a="choose">' + (state.busy ? 'Working...' : 'Drop a Starling statement PDF here, or click to choose one') + '<input type="file" accept="application/pdf" hidden></div>';
    // While it works: a progress bar and the current step; the results once it has finished (Carl, 13 Nov 2026).
    if (state.run) h += U().ui.run.html(state.run);
    const working = state.busy && state.run && !state.run.finished;
    if (state.error) h += '<p class="upc-err">' + esc(state.error) + '</p>';
    if (state.warn) h += '<p class="upc-err">' + esc(state.warn) + '</p>';
    if (state.seen) h += '<p class="text-muted">' + esc(state.seen) + '</p>';
    // Not in the register yet, or its entry is out of date (Carl, 13 Nov 2026: reading old statements again should fill
    // the register in, even when there is nothing to record).
    const reg = registerNeed();
    if (reg && !(state.busy && state.run && !state.run.finished)) h += '<p class="upc-gap">' + esc(reg.why) + ' <button type="button" class="btn btn-outline-primary-light" data-a="register"' + (state.busy ? ' disabled' : '') + '>' + esc(reg.label) + '</button></p>';
    if (st) {
      h += '<p class="text-muted upc-gap mb-0">' + st.rows + ' transactions, ' + esc(isoLabel(st.from)) + ' to ' + esc(isoLabel(st.to)) + '. ' +
        (st.bad ? '<span class="upc-err">The running balance didn\'t add up on ' + st.bad + ' of ' + st.checked + ' rows, so the statement may not have been read correctly: check before recording.</span>' : 'Read correctly (checked against the running balance on ' + st.checked + ' rows).') + '</p>';
    }
    h += '</div></div>';
    if (rs && !working) {
      const todo = rs.filter(actionable), tasks = rs.filter(needsTask);
      const label = todo.length ? 'Record ' + todo.length + ' payment' + (todo.length === 1 ? '' : 's') + (tasks.length ? ', add ' + tasks.length + ' task' + (tasks.length === 1 ? '' : 's') : '')
        : tasks.length ? 'Add ' + tasks.length + ' task' + (tasks.length === 1 ? '' : 's') : '';
      h += '<div class="card"><div class="card-header"><h2>Insurer payments (' + rs.length + ')</h2>' +
        (label ? '<button type="button" class="btn btn-primary" data-a="all"' + (state.busy ? ' disabled' : '') + '>' + label + '</button>' : '') + '</div><div class="card-body p-0">' +
        (rs.length ? '<table class="table table-striped table-bordered w-100 m-0"><thead><tr><th>Bank date</th><th>Insurer</th><th>Reference</th><th class="number">Amount</th><th>Invoices</th><th></th></tr></thead><tbody>' +
          rs.map((r, k) => {
            let inv = '', act = '';
            const dis = state.busy ? ' disabled' : '';
            const btn = (text) => '<button type="button" class="btn btn-outline-primary-light" data-rec="' + k + '"' + dis + '>' + text + '</button>';
            const linked = () => (r.invoices || []).map((i) => (i.id ? '<a href="' + esc(U().base() + '/invoice/' + i.id) + '" target="_blank" rel="noopener">' + esc(i.number) + '</a>' : esc(i.number)) + ' ' + fmt(i.amount)).join(', ');
            const profile = r.org ? '<a href="' + esc(U().base() + '/organisation/' + r.org) + '" target="_blank" rel="noopener">' + esc(r.insurer) + ' profile</a>' : esc(r.insurer) + ' profile';
            const maybe = () => r.options.length ? '<div class="upc-bank-set">May be for: ' + r.options.map((o, j) => setHtml(r, j)).join(' <span class="text-muted">or</span> ') + '</div>' : '';
            if (r.state === 'recorded') { inv = linked() + '<div class="text-muted">' + esc(r.how) + '</div>'; act = '<span class="upc-ok">Already in Halaxy</span>'; }
            else if (r.state === 'applied') { inv = (r.invoices ? linked() : '') + '<div class="text-muted">Deposit on the ' + profile + ', applied' + (r.applied ? ' ' + esc(U().dayLabel(r.applied)) : '') + '</div>'; act = '<span class="upc-ok">Deposit applied</span>'; }
            else if (r.state === 'waiting') { inv = maybe() + '<div class="text-muted">Deposit on the ' + profile + ', waiting for its remittance: Remittances applies it when the remittance is put through.</div>'; act = '<span class="upc-ok">Deposit added</span>'; }
            else if (r.state === 'deposit') { inv = maybe() + '<div class="text-muted">' + esc(r.how || '') + '. Added as a deposit on the ' + profile + ' and applied when its remittance is put through Remittances.</div>'; act = btn('Add deposit'); }
            else if (r.state === 'matched' || r.state === 'apply') { inv = '<div class="upc-bank-set">' + setHtml(r, 0) + '</div><div class="text-muted">' + esc(r.how) + (r.deposit ? '; its deposit is on the ' + profile + ' already' : '') + '</div>'; act = btn(r.deposit ? 'Apply' : 'Record'); }
            else if (r.state === 'choose') {
              inv = '<div class="text-muted">' + esc(r.how) + ': choose one</div>' + r.options.map((o, j) => '<label class="upc-bank-set d-block"><input type="radio" name="upc-bank-' + k + '" data-pick="' + k + ':' + j + '"' + (r.pick === j ? ' checked' : '') + '> ' + setHtml(r, j) + (r.labels && r.labels[j] ? ' <span class="text-muted">(' + esc(r.labels[j]) + ')</span>' : '') + '</label>').join('');
              act = r.pick !== null ? btn(r.deposit ? 'Apply' : 'Record') : '';
            } else if (r.state === 'old') {
              inv = (r.options.length ? (r.remit ? '<div class="upc-bank-set">' + setHtml(r, r.pick || 0) + '</div>' : maybe()) : '') + '<div class="upc-err">Before ' + esc(isoLabel(CHANGEOVER)) +
                ' (when insurer payments became deposits), and not found in Halaxy as recorded: check it. Record it here only if it was never recorded.</div><div class="text-muted">' + esc(r.how || '') + '</div>';
              act = btn(r.remit && r.pick !== null ? 'Record' : 'Add deposit');
            } else if (r.state === 'check' || r.state === 'noorg') { inv = '<span class="upc-err">' + esc(r.how) + '</span>'; act = r.tasked ? '<span class="text-muted">Task added</span>' : btn('Add task'); }
            else inv = '<span class="text-muted">Not matched: ' + esc(r.how || '') + '</span>';
            if (r.error) act += '<div class="upc-err">' + esc(r.error) + '</div>';
            return '<tr class="' + (['recorded', 'applied', 'waiting', 'none'].includes(r.state) ? 'upc-off' : '') + '"><td class="upc-bank-date">' + esc(isoLabel(r.date)) + '</td><td>' + esc(r.insurer) + '</td><td>' + esc(r.ref) + '</td>' +
              '<td class="number">' + fmt(r.amount) + '</td><td>' + inv + '</td><td>' + act + '</td></tr>';
          }).join('') + '</tbody></table>' : '<p class="text-muted m-3">No insurer payments on this statement.</p>') + '</div></div>';
    }
    h += '<div class="text-muted upc-version">Bank statement ' + VERSION + '</div></div>';
    root.innerHTML = h;
  }

  async function open(file) {
    if (state.busy || !file) return;
    state.busy = true; state.error = ''; state.warn = ''; state.seen = ''; state.results = null; state.statement = null; state.register = null;
    const run = state.run = U().ui.run.start(0);
    U().ui.run.step(run, 'Reading the statement...');
    render();
    try {
      state.statement = await readStatement(file);
      state.register = null; state.seen = ''; state.regError = false;
      render();
      // Read before? The register on the Starling Bank profile (Carl, 13 Nov 2026).
      U().ui.run.step(run, 'Checking the statement register...');
      try {
        const st = state.statement, regs = await registersFor(st);
        state.register = regs.find((d) => d.comments.includes('Fingerprint ' + st.fp)) || null;
        const others = regs.filter((d) => d !== state.register);
        const first = state.register && (state.register.comments.match(/first read ([^;]+)/) || [])[1];
        state.seen = [state.register ? 'This statement was read before' + (first ? ' (' + first + ')' : '') + '. What is already in Halaxy is shown as such, so nothing is recorded twice.' : '',
          others.length ? 'It overlaps ' + others.map((d) => d.title).join(', ') + ', read before: payments on both are checked against Halaxy, so none is recorded twice.' : ''].filter(Boolean).join(' ');
      } catch (e) { state.regError = true; state.warn = 'Couldn\'t check the statement register on the Starling Bank profile (' + (e.message || e) + '). Payments already in Halaxy are still found.'; }
      state.results = await match(state.statement, (t) => { U().ui.run.step(run, t); render(); });
      U().ui.run.end(run);
    } catch (e) {
      U().ui.run.end(run);
      state.error = 'Could not read it: ' + (e.message || e);
      if (/has changed/.test(e.message || '')) document.dispatchEvent(new CustomEvent('upc-loader-error', { detail: JSON.stringify({ file: 'bank-statement.user.js', message: e.message }) }));
    }
    state.busy = false;
    render();
  }

  function confirmDlg(title, html, yes) {
    return new Promise((resolve) => {
      let answered = false;
      const end = (v) => { if (!answered) { answered = true; resolve(v); } };
      const dlg = U().ui.dialog({ title, small: true, onClose: () => end(false) });
      if (!dlg) { end(false); return; }
      dlg.root.setAttribute('data-upc-bank-confirm', '');
      dlg.body.innerHTML = html + '<div class="upc-actions"><button type="button" class="btn btn-outline-primary" data-c="no">Cancel</button><button type="button" class="btn btn-primary" data-c="yes">' + esc(yes) + '</button></div>';
      dlg.body.addEventListener('click', (e) => { const b = e.target.closest('[data-c]'); if (!b) return; end(b.dataset.c === 'yes'); dlg.close(); });
    });
  }
  const plan = (r) => {
    const set = r.pick !== null && r.pick !== undefined ? r.options[r.pick] : null;
    const inv = set ? set.map((i) => esc(i.number) + ' ' + fmt(i.balance)).join(', ') : '';
    if (needsTask(r)) return 'a task for ' + esc(TASK_FOR) + ' to check it';
    if (r.deposit) return 'apply its deposit to ' + inv;
    if (r.remit && set) return 'add the deposit and apply it to ' + inv;
    return 'add the deposit (applied when its remittance comes)';
  };
  // Whether this statement's register entry is missing or behind what the page now shows.
  function registerNeed() {
    if (!state.statement || !state.results || state.regError) return null;
    if (!state.register) return { label: 'Save to register', why: 'This statement is not in the register on the Starling Bank profile yet.' };
    const now = 'insurer payments: ' + (state.results.length ? state.results.map(lineOf).join(', ') : 'none');
    return state.register.comments.includes(now) ? null : { label: 'Update register', why: 'The register entry for this statement is out of date.' };
  }
  async function saveRegister() {
    if (state.busy || !registerNeed()) return;
    if (!(await confirmDlg('Save to the register?', '<p>Keeps a short record of this statement on the Starling Bank profile: its dates, balances, number of lines, and each insurer payment with what has happened to it. No money is recorded and nothing else is changed.</p>', 'Save'))) return;
    state.busy = true;
    const run = state.run = U().ui.run.start(1);
    U().ui.run.step(run, 'Saving the statement register...');
    render();
    try { await writeRegister(state.statement, state.results); U().ui.run.tick(run); U().ui.run.end(run, 'Saved to the register.'); }
    catch (e) { U().ui.run.step(run, 'The statement register could not be saved (' + (e.message || e) + ').', true); U().ui.run.end(run, 'Not saved.'); }
    state.busy = false;
    render();
  }
  async function recordSome(list) {
    if (!list.length || state.busy) return;
    const lines = list.map((r) => '<li>' + esc(r.insurer) + ' ' + fmt(r.amount) + ', ' + esc(isoLabel(r.date)) + ': ' + plan(r) + '</li>').join('');
    const pays = list.filter(actionable).length;
    if (!(await confirmDlg(pays ? 'Record payment' + (pays === 1 ? '' : 's') + '?' : 'Add task' + (list.length === 1 ? '' : 's') + '?',
      (pays ? '<p>Deposits go on each insurer\'s profile as ' + METHOD + ', dated the day the money reached the bank.</p>' : '') + '<ul>' + lines + '</ul>', pays ? 'Record' : 'Add'))) return;
    state.busy = true;
    const run = state.run = U().ui.run.start(list.length);
    render();
    for (const r of list) {
      r.error = '';
      const say = (t, err) => { U().ui.run.step(run, t, err); render(); };
      if (needsTask(r)) {
        say('Adding a task for ' + r.insurer + ' ' + fmt(r.amount) + ' (' + isoLabel(r.date) + ')...');
        if (await checkTask(r)) say('Task added for ' + TASK_FOR + '.');
        else say(r.insurer + ' ' + fmt(r.amount) + ': ' + r.error, true);
      } else {
        try {
          await record(r, say);
          if (r.error) say(r.insurer + ' ' + fmt(r.amount) + ' (' + isoLabel(r.date) + '): ' + r.error, true);
        } catch (e) {
          // Nothing added (a deposit is added whole or not at all): a task for Carl to record it by hand.
          r.error = 'Not recorded: ' + (e.message || e);
          await taskFor(r, 'Bank statement could not record ' + r.insurer + ' ' + fmt(r.amount) + ' (' + isoLabel(r.date) + ')',
            ['Adding the deposit for the ' + r.insurer + ' payment of ' + fmt(r.amount) + ' (bank ' + isoLabel(r.date) + (r.ref ? ', ref ' + r.ref : '') + ') stopped: ' + (e.message || e), 'Check the profile\'s deposits, then open the statement again or add it by hand.']);
          if (r.tasked) r.error += ' Task added for ' + TASK_FOR + '.';
          say(r.insurer + ' ' + fmt(r.amount) + ' (' + isoLabel(r.date) + '): ' + r.error, true);
        }
      }
      U().ui.run.tick(run);
      render();
    }
    // The statement register: what this statement was and what became of each insurer payment.
    try { U().ui.run.step(run, 'Updating the statement register...'); await writeRegister(state.statement, state.results); }
    catch (e) { U().ui.run.step(run, 'The statement register on the Starling Bank profile could not be updated (' + (e.message || e) + ').', true); }
    const bad = list.filter((r) => r.error).length;
    U().ui.run.end(run, 'Finished: ' + (list.length - bad) + ' of ' + list.length + ' done' + (bad ? ', ' + bad + ' to check' : '') + '.');
    state.busy = false;
    render();
  }

  function mount() {
    if (state.unmount || !allowed()) return;
    U().ui.nativeStyles();
    root = document.createElement('div');
    root.className = 'upc-native';
    root.setAttribute('data-upc-bank-statement', '');
    const pickFile = () => { const inp = root.querySelector('.upc-bank-drop input'); if (inp) inp.click(); };
    root.addEventListener('click', (e) => {
      if (e.target.closest('[data-a=choose]') && e.target.type !== 'file') pickFile();
      if (e.target.closest('[data-a=register]')) saveRegister();
      if (e.target.closest('[data-a=all]') && state.results) recordSome(state.results.filter((r) => actionable(r) || needsTask(r)));
      const b = e.target.closest('[data-rec]');
      if (b && state.results) recordSome([state.results[Number(b.dataset.rec)]]);
    });
    root.addEventListener('change', (e) => {
      if (e.target.type === 'file') { open(e.target.files[0]); return; }
      const p = e.target.dataset && e.target.dataset.pick;
      if (p && state.results) { const [k, j] = p.split(':').map(Number); state.results[k].pick = j; render(); }
    });
    root.addEventListener('dragover', (e) => { const d = e.target.closest('.upc-bank-drop'); if (d) { e.preventDefault(); d.classList.add('on'); } });
    root.addEventListener('dragleave', (e) => { const d = e.target.closest('.upc-bank-drop'); if (d) d.classList.remove('on'); });
    root.addEventListener('drop', (e) => { if (e.target.closest('.upc-bank-drop')) { e.preventDefault(); open(e.dataTransfer.files[0]); } });
    root.addEventListener('keydown', (e) => { if (e.target.classList && e.target.classList.contains('upc-bank-drop') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pickFile(); } });
    state.unmount = U().ui.mountPage('Bank statement', root, MENU_CLS);
    render();
    // Deposits still not applied 10 days on: a task on the insurer's profile (once a day).
    U().deposits.lingering({ days: LINGER_DAYS, assignee: TASK_FOR, by: 'Bank statement' }).catch(() => {});
  }
  function unmount() {
    if (!state.unmount) return;
    state.unmount();
    state.unmount = null;
    root = null;
  }
  const route = () => (location.hash === '#' + ROUTE ? mount() : unmount());

  function start() {
    if (!U()) { console.error('[UPC bank statement] needs the core library'); return; }
    if (!document.getElementById('upc-bank-css')) { const st = document.createElement('style'); st.id = 'upc-bank-css'; st.textContent = CSS; document.head.appendChild(st); }
    U().ui.ensureMenuItem('Bank statement', (section) => {
      const inv = section && [...section.querySelectorAll('a.mainmenu-sublink')].find((a) => /^invoices$/i.test(U().clean(a.textContent)));
      return (inv ? inv.getAttribute('href').split('#')[0] : U().base() + '/invoice/') + '#' + ROUTE;
    }, MENU_CLS, /^finances?$/i);
    window.addEventListener('hashchange', route);
    route();
  }
  const begin = () => { if (U()) whenAllowed(start); else start(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', begin, { once: true });
  else begin();

  window.upcBankStatement = { version: VERSION, parseStarling, statementFrom, subsets, remitKeys, match, allowed, makePdf };
})();
