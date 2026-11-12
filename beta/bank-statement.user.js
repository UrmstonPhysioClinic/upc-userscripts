// ==UserScript==
// @name         UPC Billing: Bank statement (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.1.4
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/bank-statement.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/bank-statement.user.js
// @description  Finances > Bank statement (Carl only for now): open a Starling statement PDF, match each insurer credit to the insurer's unpaid invoices, and record the payments (Direct Deposit, the bank date) after confirming. The only place payments are recorded.
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
 *    browser with pdf.js; nothing is uploaded or kept. The parse is checked against the statement's running balance.
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
 *  - Record (after confirming): each invoice is marked paid with its balance, "Direct Deposit" (Carl), the bank date,
 *    and a note naming the insurer, bank date and reference (core UPC.invoice.payOffline, which checks the result).
 *    Credits already recorded on this PC are remembered and shown as done.
 */
(() => {
  'use strict';
  if (window.__hxBankStatement) return;
  window.__hxBankStatement = true;

  const VERSION = '0.1.4';
  const ROUTE = 'upc-bank-statement';
  const MENU_CLS = 'upc-bank-menu';
  const ALLOWED = ['Carl Healy'];
  const METHOD = 'Direct Deposit';
  const LOOK_BACK_MONTHS = 18;
  const NEAR_BEFORE = 3, NEAR_AFTER = 14;   // days the bank date may be before / after the remittance's date
  const USUAL_DAYS = 5;   // Carl, 12 Nov 2026: Bupa (and AXA) almost always pay 2 days after the remittance date
  const MAX_AGE_DAYS = 120;   // invoices dated more than this before a payment are not matched to it
  const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/';
  const KEY = 'upc-bank:';
  const INSURERS = [
    ['Bupa', /\bbupa\b/i], ['AXA', /\baxa\b/i], ['WPA', /\bwpa\b/i], ['Aviva', /\baviva\b/i], ['Vitality', /\bvitality\b/i],
    ['Cigna', /\bcigna\b/i], ['Simplyhealth', /\bsimply ?health\b/i], ['Allianz', /\ballianz\b/i], ['Healix', /\bhealix\b/i],
    ['Benenden', /\bbenenden\b/i], ['Westfield', /\bwestfield\b/i], ['Health Shield', /\bhealth ?shield\b/i],
  ];

  const U = () => window.UPC;
  const esc = (s) => U().esc(s);
  const store = { get: (k, d) => U().storage(KEY).get(k, d), set: (k, v) => U().storage(KEY).set(k, v), del: (k) => U().storage(KEY).del(k) };   // core's per-PC storage

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
    return statementFrom(pages);
  }
  // Rows, insurer credits, and a check of the parse against the statement's running balance.
  function statementFrom(pages) {
    const { rows, found } = parseStarling(pages);
    if (!found || !rows.length) throw new (U().Error)('This doesn\'t look like a Starling statement (no DATE / TYPE / TRANSACTION / IN / OUT columns found).');
    let bal = null, bad = 0, checked = 0;
    rows.forEach((r) => {
      if (bal !== null && r.balance !== null) { checked++; if (bal + (r.in || 0) - (r.out || 0) !== r.balance) bad++; }
      if (r.balance !== null) bal = r.balance; else if (bal !== null) bal += (r.in || 0) - (r.out || 0);
    });
    // Insurer credits, and credits naming one of our invoice numbers (kept only if it's an insurer invoice; see match).
    const credits = rows.filter((r) => r.in > 0 && (insurerOf(r.desc) || numbersIn(r.desc).length))
      .map((r) => ({ key: r.date + '|' + r.in + '|' + refOf(r.desc), date: r.date, insurer: insurerOf(r.desc), desc: r.desc, ref: refOf(r.desc), amount: r.in, numbers: numbersIn(r.desc) }));
    const dates = rows.map((r) => r.date).sort();
    return { rows: rows.length, from: dates[0], to: dates[dates.length - 1], checked, bad, credits };
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
      if (key && !out.some((x) => x.key === key)) out.push({ key, ref: ref || '', date, paid });
    });
    return out;
  }
  async function remittancesOf(inv) {
    if (!attachments.has(inv.id)) attachments.set(inv.id, remitKeys((await U().invoice.fetch(inv.id)).attachments));
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
    const done = store.get('done', {});
    const used = new Set();
    const results = [];
    const credits = statement.credits.slice().sort((a, b) => a.date.localeCompare(b.date));
    let n = 0;
    for (const c of credits) {
      n++;
      const r = Object.assign({}, c, { state: 'none', options: [] });
      // 0. The bank reference names our invoice(s) and they add up to the payment. A named invoice that doesn't fit (an
      //    old reference reused, Carl 11 Nov 2026) is set aside and the payment matched by amount and date as usual.
      const named = c.numbers.map((n) => open.find((i) => numberOf(i.number) === n && !used.has(i.id))).filter(Boolean);
      const namedFits = named.length === c.numbers.length && named.length && named.reduce((t, i) => t + i.balance, 0) === c.amount &&
        named.every((i) => i.when <= isoMs(c.date) + 86400e3) && (!c.insurer || named.every((i) => i.insurer === c.insurer));
      if (!c.insurer && namedFits) r.insurer = named[0].insurer;
      if (!r.insurer && !done[c.key]) continue;   // names an invoice that isn't an unpaid insurer invoice (a patient paying, say): not ours here
      results.push(r);
      const prev = done[c.key];
      if (prev && !prev.partial) { r.state = 'done'; r.doneAt = prev.at; r.invoices = prev.invoices; if (!r.insurer) r.insurer = (prev.insurer || ''); continue; }
      // Recording stopped part way last time: match what is still to record.
      const already = prev && prev.partial ? prev.invoices.reduce((t, i) => t + i.amount, 0) : 0;
      if (prev && prev.partial) { r.recorded = prev.invoices; if (!r.insurer) r.insurer = prev.insurer || ''; }
      if (namedFits) {
        r.state = 'matched'; r.pick = 0; r.options = [named];
        r.how = 'the invoice number' + (named.length === 1 ? '' : 's') + ' in the bank reference';
        named.forEach((i) => used.add(i.id));
        continue;
      }
      const setAside = c.numbers.length ? 'the bank reference names ' + (String(c.desc).match(/\bUPC[\s-]?\d{2,}\b/gi) || []).join(', ') + ', which doesn\'t fit (paid already, or another amount); ' : '';
      say('Matching ' + c.insurer + ' ' + fmt(c.amount) + ' (' + n + ' of ' + credits.length + ')...');
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
        keys.forEach((k) => { if (!groups.has(k.key)) groups.set(k.key, { key: k.key, ref: k.ref, date: k.date, list: [], paid: [] }); groups.get(k.key).list.push(i); groups.get(k.key).paid.push(k.paid); });
      }
      const target = c.amount - already;
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
        r.options = [g.list];
      } else if (byRemit.length > 1) { r.state = 'choose'; r.how = 'more than one remittance adds up to it'; r.options = byRemit.map((g) => g.list); r.labels = byRemit.map((g) => g.key + dated(g)); }
      // Amount alone is weak evidence (£ 40.00 fits many invoices): offered to tick, never ticked.
      else if (single.length === 1) { r.state = 'choose'; r.how = 'one invoice for the whole amount, but no remittance links them: tick it only if it is right'; r.options = [single]; }
      else {
        const sets = single.length > 1 ? single.map((i) => [i]) : subsets(recent.slice(0, 24), target, 4);
        if (sets.length === 1) { r.state = 'choose'; r.how = 'the only set of ' + c.insurer + ' invoices that adds up to it, but no remittance links them: tick it only if it is right'; r.options = sets; }
        else if (sets.length) { r.state = 'choose'; r.how = 'more than one set of invoices adds up to it'; r.options = sets; }
        else if (notMoved.length === 1) {
          const g = notMoved[0];
          r.how = 'the remittance with ' + g.key + ' paid this on ' + g.list.map((i) => i.number).join(', ') + ', but Halaxy still shows ' +
            fmt(g.list.reduce((t, i) => t + i.balance, 0)) + ' on them: move the excess to the patient with Remittances first, then open the statement again';
        } else r.how = 'no unpaid ' + c.insurer + ' invoices add up to it (has the remittance been through Remittances? An excess not yet moved to the patient leaves the invoice showing more than the insurer paid)';
      }
      if (setAside) r.how = setAside + (r.how || '');
      if (already) r.how = fmt(already) + ' already recorded on ' + r.recorded.map((i) => i.number).join(', ') + '; the rest: ' + (r.how || '');
      if (r.state === 'matched') r.options[0].forEach((i) => used.add(i.id));
      r.pick = r.state === 'matched' ? 0 : null;
    }
    return results;
  }

  // ------------------------------------------------------------------ recording

  async function record(r, say) {
    const set = r.options[r.pick];
    const before = (r.recorded || []).slice();
    const target = r.amount - before.reduce((t, i) => t + i.amount, 0);
    if (!set || set.reduce((t, i) => t + i.balance, 0) !== target) throw new (U().Error)('The invoices chosen don\'t add up to ' + fmt(target) + '.');
    const note = r.insurer + ', bank ' + isoLabel(r.date) + (r.ref ? ', ref ' + r.ref : '');
    const paid = before;
    // Progress is saved after each invoice, so a stop part way can carry on from where it stopped.
    const save = (partial) => { const d = store.get('done', {}); d[r.key] = { at: Date.now(), invoices: paid, insurer: r.insurer, partial }; store.set('done', d); };
    for (const i of set) {
      // Already recorded from this bank line (an earlier try that stopped part way): don't record it twice.
      const now = await U().invoice.fetch(i.id);
      if (now.paymentRows.some((t) => t.includes(note))) { paid.push({ id: i.id, number: i.number, amount: i.balance, already: true }); save(true); continue; }
      say('Recording ' + fmt(i.balance) + ' on ' + i.number + '...');
      await U().invoice.payOffline(i.id, { method: METHOD, date: isoLabel(r.date), amount: i.balance, note, before: now });
      paid.push({ id: i.id, number: i.number, amount: i.balance });
      save(true);
    }
    save(false);
    r.state = 'done'; r.doneAt = Date.now(); r.invoices = paid;
  }

  // ------------------------------------------------------------------ page

  const CSS = `
    .upc-bank { max-width: 1200px; }
    .upc-bank h1 { margin: 0 0 16px; }
    .upc-bank .card { margin-bottom: 24px; }
    .upc-bank .card-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .upc-bank .card-header h2 { margin: 0; }
    .upc-bank .btn { margin: 0; }
    .upc-bank .upc-bank-drop { border: 2px dashed var(--vs-theme-border-color, #ced4da); border-radius: 4.8px; padding: 28px; text-align: center; cursor: pointer; }
    .upc-bank td.upc-bank-date, .upc-bank td.number { white-space: nowrap; }
    .upc-bank .upc-bank-set { margin: 2px 0; }
    .upc-bank .upc-bank-set a { margin-right: 6px; white-space: nowrap; }
    .upc-bank tr.upc-off td { color: var(--vs-viewData-label-color, #6c757d); }
  `;
  const state = { unmount: null, busy: false, status: '', error: '', statement: null, results: null };
  let root = null;

  function setHtml(r, k) {
    const base = U().base();
    return r.options[k].map((i) => '<a href="' + esc(base + '/invoice/' + i.id) + '" target="_blank" rel="noopener">' + esc(i.number) + '</a> ' + fmt(i.balance)).join(', ');
  }
  function render() {
    if (!root) return;
    const st = state.statement, rs = state.results;
    let h = '<div class="upc-bank"><h1>Bank statement</h1>';
    h += '<div class="upc-bank-drop" tabindex="0" role="button" data-a="choose">' + (state.busy ? esc(state.status) : 'Drop the month\'s Starling statement (PDF) here, or click to choose it') + '<input type="file" accept="application/pdf" hidden></div>';
    if (state.error) h += '<p class="upc-err">' + esc(state.error) + '</p>';
    if (st) {
      h += '<p class="text-muted">' + st.rows + ' transactions, ' + esc(isoLabel(st.from)) + ' to ' + esc(isoLabel(st.to)) + '. ' +
        (st.bad ? '<span class="upc-err">The running balance didn\'t add up on ' + st.bad + ' of ' + st.checked + ' rows, so the statement may not have been read correctly: check before recording.</span>' : 'Read correctly (checked against the running balance on ' + st.checked + ' rows).') + '</p>';
    }
    if (rs) {
      const ready = rs.filter((r) => r.state === 'matched' || (r.state === 'choose' && r.pick !== null));
      h += '<div class="card"><div class="card-header"><h2>Insurer payments (' + rs.length + ')</h2>' +
        (ready.length ? '<button type="button" class="btn btn-primary" data-a="all"' + (state.busy ? ' disabled' : '') + '>Record ' + ready.length + ' payment' + (ready.length === 1 ? '' : 's') + '</button>' : '') + '</div><div class="card-body p-0">' +
        (rs.length ? '<table class="table table-striped table-bordered w-100 m-0"><thead><tr><th>Bank date</th><th>Insurer</th><th>Reference</th><th class="number">Amount</th><th>Invoices</th><th></th></tr></thead><tbody>' +
          rs.map((r, k) => {
            let inv = '', act = '';
            if (r.state === 'done') { inv = (r.invoices || []).map((i) => esc(i.number) + ' ' + fmt(i.amount)).join(', '); act = '<span class="upc-ok">Recorded ' + esc(U().dayLabel(r.doneAt)) + '</span>'; }
            else if (r.state === 'matched') { inv = '<div class="upc-bank-set">' + setHtml(r, 0) + '</div><div class="text-muted">' + esc(r.how) + '</div>'; act = '<button type="button" class="btn btn-outline-primary-light" data-rec="' + k + '"' + (state.busy ? ' disabled' : '') + '>Record</button>'; }
            else if (r.state === 'choose') {
              inv = '<div class="text-muted">' + esc(r.how) + ': choose one</div>' + r.options.map((o, j) => '<label class="upc-bank-set d-block"><input type="radio" name="upc-bank-' + k + '" data-pick="' + k + ':' + j + '"' + (r.pick === j ? ' checked' : '') + '> ' + setHtml(r, j) + (r.labels && r.labels[j] ? ' <span class="text-muted">(' + esc(r.labels[j]) + ')</span>' : '') + '</label>').join('');
              act = r.pick !== null ? '<button type="button" class="btn btn-outline-primary-light" data-rec="' + k + '"' + (state.busy ? ' disabled' : '') + '>Record</button>' : '';
            } else inv = '<span class="text-muted">Not matched: ' + esc(r.how || '') + '</span>';
            if (r.error) act += '<div class="upc-err">' + esc(r.error) + '</div>';
            return '<tr class="' + (r.state === 'done' || r.state === 'none' ? 'upc-off' : '') + '"><td class="upc-bank-date">' + esc(isoLabel(r.date)) + '</td><td>' + esc(r.insurer) + '</td><td>' + esc(r.ref) + '</td>' +
              '<td class="number">' + fmt(r.amount) + '</td><td>' + inv + '</td><td>' + act + '</td></tr>';
          }).join('') + '</tbody></table>' : '<p class="text-muted m-3">No insurer payments on this statement.</p>') + '</div></div>';
      h += '<p class="text-muted">Each payment is recorded on its invoices as ' + METHOD + ', dated the day it reached the bank, with a note of the insurer, date and reference. Nothing is recorded until you confirm. ' +
        'Other money in (card takings, Halaxy payments) and money out are not used.</p>';
    }
    h += '<div class="text-muted upc-version">Bank statement ' + VERSION + '</div></div>';
    root.innerHTML = h;
  }

  async function open(file) {
    if (state.busy || !file) return;
    state.busy = true; state.error = ''; state.results = null; state.statement = null; state.status = 'Reading the statement...';
    render();
    try {
      state.statement = await readStatement(file);
      render();
      state.results = await match(state.statement, (t) => { state.status = t; render(); });
    } catch (e) {
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
  async function recordSome(list) {
    if (!list.length || state.busy) return;
    const lines = list.map((r) => '<li>' + esc(r.insurer) + ' ' + fmt(r.amount) + ', ' + esc(isoLabel(r.date)) + ': ' + r.options[r.pick].map((i) => esc(i.number) + ' ' + fmt(i.balance)).join(', ') + '</li>').join('');
    if (!(await confirmDlg('Record payment' + (list.length === 1 ? '' : 's') + '?', '<p>Record these as paid (' + METHOD + ', on the bank date)?</p><ul>' + lines + '</ul>', 'Record'))) return;
    state.busy = true;
    for (const r of list) {
      r.error = '';
      try { await record(r, (t) => { state.status = t; render(); }); }
      catch (e) { r.error = 'Not all recorded: ' + (e.message || e) + ' Check the invoices before trying again.'; }
      render();
    }
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
      if (e.target.closest('[data-a=all]') && state.results) recordSome(state.results.filter((r) => r.state === 'matched' || (r.state === 'choose' && r.pick !== null)));
      const b = e.target.closest('[data-rec]');
      if (b && state.results) recordSome([state.results[Number(b.dataset.rec)]]);
    });
    root.addEventListener('change', (e) => {
      if (e.target.type === 'file') { open(e.target.files[0]); return; }
      const p = e.target.dataset && e.target.dataset.pick;
      if (p && state.results) { const [k, j] = p.split(':').map(Number); state.results[k].pick = j; render(); }
    });
    root.addEventListener('dragover', (e) => { if (e.target.closest('.upc-bank-drop')) e.preventDefault(); });
    root.addEventListener('drop', (e) => { if (e.target.closest('.upc-bank-drop')) { e.preventDefault(); open(e.dataTransfer.files[0]); } });
    root.addEventListener('keydown', (e) => { if (e.target.classList && e.target.classList.contains('upc-bank-drop') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pickFile(); } });
    state.unmount = U().ui.mountPage('Bank statement', root, MENU_CLS);
    render();
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

  window.upcBankStatement = { version: VERSION, parseStarling, statementFrom, subsets, remitKeys, match, allowed };
})();
