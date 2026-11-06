// ==UserScript==
// @name         Halaxy Custom Reports
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.6
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/stable/custom-reports.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/stable/custom-reports.user.js
// @description  Adds "Custom Reports" to Halaxy's Reports menu: report on invoices, appointments or patients with any combination of filters, linked patient details, chosen columns and saved views. Read-only, runs only when you press Run, data stays in this browser.
// @match        https://*.halaxy.com/a/pr/*
// @run-at       document-idle
// @grant        none
// @sandbox      raw
// @inject-into  page
// ==/UserScript==

/*
  Custom Reports for Halaxy (Urmston Physio Clinic)

  - Menu: adds "Custom Reports" under Reports in Halaxy's sidebar.
  - Page: lives at .../report/finance/#hx-reports, inside Halaxy's own layout.
  - Sources: invoices, unpaid invoices (with funder), unpaid invoice lines,
    appointments, patients.
  - Filters: any field, nested And/Or groups, relative dates.
  - Linked patient fields: next/last appointment, booked ahead, DNAs,
    unpaid balance and more, on any source.
  - Views: saved per PC, and every view has its own link. Bookmark the
    link in Firefox and it syncs to the other PCs.

  Read-only. Runs only when Run is pressed. Paces its requests.
  Nothing leaves the browser.
*/

(function () {
  'use strict';

  const VERSION = '0.6';
  const prMatch = location.pathname.match(/^\/a\/pr\/(\d+)\//);
  if (!prMatch || window.top !== window.self) return;
  const BASE = '/a/pr/' + prMatch[1];
  const ROUTE = 'hx-reports';
  const HOST_PATH = BASE + '/report/finance/';
  const VIEWS_KEY = 'hxReports.views';
  const LAST_KEY = 'hxReports.last';
  const PAUSE_MS = 250;
  const BLOCK = 500;
  const CAP = 8000;

  // ======================================================================
  // Helpers
  // ======================================================================
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const txt = el => el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  const clone = o => JSON.parse(JSON.stringify(o));
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dayStart = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const today = () => dayStart(new Date());
  const isoDay = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const toHalaxyDate = iso => { const [y, m, d] = iso.split('-'); return d + '-' + MONTHS[+m - 1] + '-' + y; };
  const daysBetween = (a, b) => Math.round((dayStart(b) - dayStart(a)) / 86400000);

  function parseDT(s) {
    if (s == null || s === '') return null;
    if (s instanceof Date) return isNaN(s) ? null : s;
    const t = String(s).trim();
    let m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0));
    m = t.match(/^(\d{1,2})[- ]([A-Za-z]{3})[a-z]*[- ](\d{4})(?:,?\s+(\d{1,2}):(\d{2}))?/);
    if (m) { const mi = MONTHS.findIndex(x => x.toLowerCase() === m[2].toLowerCase()); if (mi >= 0) return new Date(+m[3], mi, +m[1], +(m[4] || 0), +(m[5] || 0)); }
    m = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    return null;
  }
  const money = s => {
    if (typeof s === 'number') return s;
    let t = String(s ?? '').trim();
    const neg = /^\(.*\)$/.test(t);
    const n = parseFloat(t.replace(/[^0-9.\-]/g, ''));
    return isNaN(n) ? null : (neg ? -Math.abs(n) : n);
  };
  const gbp = n => n == null ? '' : (n < 0 ? '-£' : '£') + Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDate = d => d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const fmtDT = d => d ? d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: '2-digit' }) + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';

  function encodeView(v) {
    const s = btoa(unescape(encodeURIComponent(JSON.stringify(v))));
    return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function decodeView(s) {
    try {
      const b = s.replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(escape(atob(b + '==='.slice((b.length + 3) % 4)))));
    } catch (e) { return null; }
  }
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } };

  const APPT_CANCELLED = /cancel/i;
  const APPT_DNA = /did not attend|\bdna\b|no show/i;
  const APPT_ATTENDED = /attended|arrived|completed/i;

  // ======================================================================
  // Halaxy data access (read-only)
  // ======================================================================
  const net = { requests: 0, serverDateFilter: {} };
  async function listData(path, startRow, endRow, filterModel, sortModel) {
    const headers = { 'Content-Type': 'application/json' };
    if (window.Hk && window.Hk.jwt) headers.Authorization = 'Bearer ' + window.Hk.jwt;
    const body = { startRow, endRow, rowGroupCols: [], valueCols: [], pivotCols: [], pivotMode: false, groupKeys: [], filterModel: filterModel || {}, sortModel: sortModel || [] };
    net.requests++;
    const res = await fetch(BASE + path, { method: 'POST', headers, body: JSON.stringify(body), credentials: 'same-origin' });
    if (!res.ok) throw new Error('Halaxy ' + path + ' returned ' + res.status);
    return res.json();
  }

  // Pages through a Halaxy list. Stops at lastRow, an empty page, or when stop(row) says so.
  async function readList(path, filterModel, sortModel, label, status, notes, onRows, cap) {
    const limit = cap || CAP;
    let start = 0, total = null;
    for (;;) {
      status('Loading ' + label + (total != null ? ': ' + start + ' of ' + total : '...'));
      const j = await listData(path, start, start + BLOCK, filterModel, sortModel);
      const rows = j.rowData || [];
      if (typeof j.lastRow === 'number' && j.lastRow >= 0) total = j.lastRow;
      const stop = onRows(rows, start);
      start += rows.length;
      if (stop || !rows.length || (total != null && start >= total)) break;
      if (start >= limit) { notes.push('Stopped reading ' + label + ' at ' + limit + ' rows. Narrow the date window for complete results.'); break; }
      await sleep(PAUSE_MS);
    }
    return { read: start, total };
  }

  const agDate = d => isoDay(d) + ' 00:00:00';

  // Rows whose dateField falls in [from, to). Asks Halaxy to filter by date, sorted newest first,
  // and still checks every row here, so results are right whichever of those Halaxy honours.
  async function fetchByDate(path, dateField, from, to, label, status, notes) {
    const fm = {};
    fm[dateField] = to
      ? { filterType: 'date', type: 'inRange', dateFrom: agDate(addDays(from, -1)), dateTo: agDate(addDays(to, 1)) }
      : { filterType: 'date', type: 'greaterThan', dateFrom: agDate(addDays(from, -1)) };
    const sort = [{ colId: dateField, sort: 'desc' }];
    const out = [];
    let outside = 0, sorted = null;
    const wFrom = addDays(from, -1), wTo = to ? addDays(to, 1) : null;
    const take = rows => {
      let reachedPast = false;
      if (sorted === null && rows.length > 1) {
        const a = parseDT(rows[0][dateField]), b = parseDT(rows[rows.length - 1][dateField]);
        sorted = !(a && b && a < b);
      }
      for (const r of rows) {
        const d = parseDT(r[dateField]);
        if (d && (d < wFrom || (wTo && d > wTo))) outside++;
        if (d && d < from) { if (sorted) reachedPast = true; continue; }
        if (to && d && d >= to) continue;
        out.push(r);
      }
      return reachedPast;
    };
    try {
      await readList(path, fm, sort, label, status, notes, take);
      net.serverDateFilter[label] = outside ? 'ignored by Halaxy (' + outside + ' rows outside window)' : 'used';
    } catch (e) {
      // Halaxy refused the filter: fall back to reading newest first and stopping at the window start.
      net.serverDateFilter[label] = 'rejected (' + e.message + '), read newest first instead';
      out.length = 0; outside = 0; sorted = null;
      await readList(path, {}, sort, label, status, notes, take);
      if (sorted === false) notes.push('Halaxy did not sort ' + label + ' by date, so reading was capped at ' + CAP + ' rows.');
    }
    return out;
  }

  // All unpaid invoices: Halaxy's own status filter, read fully.
  async function fetchUnpaid(status, notes) {
    const seen = new Map();
    for (const term of ['Not yet paid', 'Pending']) {
      await readList('/invoice/list-data', { status: { filterType: 'text', type: 'contains', filter: term } }, [], 'unpaid invoices (' + term + ')', status, notes, rows => { rows.forEach(r => seen.set(String(r.id), r)); return false; });
      await sleep(PAUSE_MS);
    }
    return [...seen.values()];
  }

  // Halaxy's patient list (the same list as Patients > Patient List), read fully.
  async function fetchPatientList(status, notes) {
    const out = [];
    await readList('/patient/list-data', {}, [], 'patient list', status, notes, rows => { out.push(...rows); return false; }, 30000);
    return out;
  }

  // Halaxy's Unpaid Invoices report (all funders, all payers), one row per line.
  function cellGrid(rows) {
    const grid = [], carry = [];
    for (const tr of rows) {
      const out = [];
      let col = 0;
      const fill = () => { while (carry[col] && carry[col].left > 0) { out[col] = carry[col].cell; carry[col].left--; col++; } };
      for (const td of tr.cells) {
        fill();
        const cs = Math.max(1, td.colSpan || 1), rs = Math.max(1, td.rowSpan || 1);
        for (let k = 0; k < cs; k++) { out[col] = td; carry[col] = rs > 1 ? { cell: td, left: rs - 1 } : null; col++; }
      }
      fill();
      grid.push(out);
    }
    return grid;
  }

  const cleanNum = x => String(x).replace(/GBP|£|\$|€|,|\s/gi, '').replace(/^\((.*)\)$/, '-$1');
  function sniffType(values) {
    const v = values.filter(x => x !== '' && x !== '-');
    if (!v.length) return 'text';
    if (v.every(x => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(x) || /^\d{1,2}-[A-Za-z]{3}-\d{4}$/.test(x))) return 'date';
    const nums = v.map(cleanNum);
    if (nums.every(x => /^-?\d*\.?\d+$/.test(x))) {
      if (nums.every(x => /^-?\d+$/.test(x))) return 'number';
      return nums.every(x => /\.\d{2}$/.test(x)) ? 'money' : 'number';
    }
    const distinct = new Set(v).size;
    if (distinct <= 40 && distinct * 2 <= v.length) return 'enum';
    return 'text';
  }

  async function fetchLines(fromIso, status, diag) {
    status('Loading Halaxy\'s Unpaid Invoices report...');
    const p = new URLSearchParams([
      ['type', '5'], ['start', toHalaxyDate(fromIso)], ['unpaid', '0'], ['overdue', 'all'], ['showTotalMode', '0'],
      ['incomeType', 'paymentMethods'], ['invoicestatuses', 'active'], ['invoicestatuses', 'issued'], ['displayNames', '1'],
      ['plTaxTypeStatus', 'exclusive'], ['lineStatus', 'write-off'], ['lineStatus', 'voided'],
      ['usedDepositOption', 'all'], ['creditSummaryOption', 'summary'], ['clicked', String(Date.now())]
    ]);
    const res = await fetch(BASE + '/report/finance/0?' + p.toString(), { credentials: 'same-origin' });
    if (!res.ok) throw new Error('Halaxy report returned ' + res.status);
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const table = doc.querySelector('table.table-report');
    if (!table) throw new Error('Halaxy\'s Unpaid Invoices report table was not found. Has its layout changed?');
    const all = [...table.rows];
    const head = table.tHead ? [...table.tHead.rows] : all.filter(r => r.cells.length && [...r.cells].every(c => c.tagName === 'TH'));
    const body = all.filter(r => !head.includes(r));
    const hg = cellGrid(head);
    const names = (hg[hg.length - 1] || []).map(txt);
    const groups = hg.length > 1 ? (hg[0] || []).map(txt) : [];
    const cols = [];
    names.forEach((n, i) => {
      if (!n) return;
      let label = n;
      if (cols.some(c => c.label === label)) label = n + ' (' + (groups[i] && groups[i] !== n ? groups[i] : '2') + ')';
      let k = 2;
      while (cols.some(c => c.label === label)) label = n + ' (' + (++k) + ')';
      cols.push({ idx: i, label, name: n });
    });
    const rowsGrid = cellGrid(body);
    const lines = [];
    let current = null, continued = 0, skipped = 0;
    const feeCol = cols.find(c => c.label === 'Fee'), amtCol = cols.find(c => c.label === 'Amount');
    rowsGrid.forEach((row, ri) => {
      const tr = body[ri];
      if ([...tr.cells].some(td => (td.colSpan || 1) > 3)) { skipped++; return; } // total / heading rows
      let link = null;
      for (const c of row) { if (c && c.querySelector) { link = c.querySelector('a[href*="/invoice/"]'); if (link) break; } }
      const m = link && (link.getAttribute('href') || '').match(/\/invoice\/(\d+)/);
      const cells = {};
      cols.forEach(c => { cells[c.label] = txt(row[c.idx]); });
      if (m) current = { invoiceId: m[1], invoiceLabel: txt(link), carry: cells };
      else {
        // A further line of the invoice above: Halaxy leaves the invoice cells blank on these rows.
        const hasLine = (feeCol && cells[feeCol.label]) || (amtCol && cells[amtCol.label]);
        if (!current || !hasLine) { skipped++; return; }
        cols.forEach(c => { if (!cells[c.label] && /^(Invoice|Date$|Due Date|Practitioner|Payer|Funder|Invoice Status)/.test(c.label)) cells[c.label] = current.carry[c.label]; });
        continued++;
      }
      lines.push({ invoiceId: current.invoiceId, invoiceLabel: current.invoiceLabel, cells });
    });
    cols.forEach(c => { c.type = sniffType(lines.map(l => l.cells[c.label])); });
    diag.report = { headers: cols.map(c => c.label + ':' + c.type), bodyRows: body.length, lines: lines.length, continuationLines: continued, otherRows: skipped, invoices: new Set(lines.map(l => l.invoiceId)).size };
    return { cols, lines };
  }

  // ======================================================================
  // Patient summaries (keyed by Halaxy's patient link ID)
  // ======================================================================
  function buildPatients(appts, unpaid, linesByInvoice) {
    const t0 = today();
    const P = new Map();
    const get = id => {
      const k = String(id);
      let p = P.get(k);
      if (!p) { p = { id: k, name: '', appts: [], unpaid: [], funders: new Set(), practitioners: new Set() }; P.set(k, p); }
      return p;
    };
    (appts || []).forEach(a => {
      if (a.linkPaGId == null) return;
      const p = get(a.linkPaGId);
      p.appts.push(a);
      if (a.patName && !p.name) p.name = a.patName;
    });
    (unpaid || []).forEach(i => {
      if (i.linkPaGId == null) return;
      const p = get(i.linkPaGId);
      p.unpaid.push(i);
      (linesByInvoice && linesByInvoice.get(String(i.id)) || []).forEach(l => {
        const f = l.cells.Funder;
        if (f) p.funders.add(f);
      });
    });
    P.forEach(p => {
      const live = p.appts.filter(a => !APPT_CANCELLED.test(a.statusText || '') && !APPT_DNA.test(a.statusText || ''));
      const withDate = live.map(a => ({ a, d: parseDT(a.startTime) })).filter(x => x.d);
      const future = withDate.filter(x => x.d >= t0).sort((x, y) => x.d - y.d);
      const past = withDate.filter(x => x.d < t0).sort((x, y) => y.d - x.d);
      p.next = future[0] ? future[0].d : null;
      p.nextWith = future[0] ? future[0].a.practitionerName || '' : '';
      p.nextDays = p.next ? daysBetween(t0, p.next) : null;
      p.ahead = future.length;
      p.last = past[0] ? past[0].d : null;
      p.lastWith = past[0] ? past[0].a.practitionerName || '' : '';
      p.lastDays = p.last ? daysBetween(p.last, t0) : null;
      p.attended = p.appts.filter(a => APPT_ATTENDED.test(a.statusText || '')).length;
      p.dna = p.appts.filter(a => APPT_DNA.test(a.statusText || '')).length;
      p.cancelled = p.appts.filter(a => APPT_CANCELLED.test(a.statusText || '')).length;
      p.unpaidCount = p.unpaid.length;
      p.unpaidBalance = p.unpaid.reduce((s, i) => s + (money(i.balance) || 0), 0);
      p.fundersText = [...p.funders].join(', ');
      p.appts.forEach(a => { if (a.practitionerName) p.practitioners.add(a.practitionerName); });
      p.practitionersText = [...p.practitioners].join(', ');
      if (!p.name) { const pi = p.unpaid.find(i => i.payerName); if (pi) p.name = pi.payerName; }
    });
    return P;
  }

  // ======================================================================
  // Fields
  // ======================================================================
  // type: text | enum | number | money | date | datetime
  const F = (key, label, type, get, group, extra) => Object.assign({ key, label, type, get, group }, extra || {});
  const invOf = row => row.inv || null;
  const invLink = row => row.inv && row.inv.id ? BASE + '/invoice/' + row.inv.id : (row.r && row.r.invoiceId ? BASE + '/invoice/' + row.r.invoiceId : null);

  const INVOICE_FIELDS = [
    F('inv.num', 'Invoice no.', 'text', r => invOf(r) ? invOf(r).invoiceNum : (r.r && r.r.invoiceLabel) || '', 'Invoice', { link: invLink }),
    F('inv.status', 'Payment status', 'enum', r => invOf(r) && invOf(r).status, 'Invoice'),
    F('inv.date', 'Invoice date', 'date', r => invOf(r) && parseDT(invOf(r).invoiceDate), 'Invoice'),
    F('inv.due', 'Due date', 'date', r => invOf(r) && parseDT(invOf(r).dueDate), 'Invoice'),
    F('inv.created', 'Created', 'date', r => invOf(r) && parseDT(invOf(r).created), 'Invoice'),
    F('inv.sent', 'Sent', 'date', r => invOf(r) && parseDT(invOf(r).sentDate), 'Invoice'),
    F('inv.payer', 'Payer', 'text', r => invOf(r) && invOf(r).payerName, 'Invoice'),
    F('inv.pract', 'Practitioner', 'enum', r => invOf(r) && invOf(r).practitionerName, 'Invoice'),
    F('inv.type', 'Invoice type', 'enum', r => invOf(r) && invOf(r).invoiceLabel, 'Invoice'),
    F('inv.amount', 'Amount', 'money', r => invOf(r) && money(invOf(r).amount), 'Invoice'),
    F('inv.tax', 'Tax', 'money', r => invOf(r) && money(invOf(r).tax), 'Invoice'),
    F('inv.total', 'Total', 'money', r => invOf(r) && money(invOf(r).total), 'Invoice'),
    F('inv.paid', 'Paid', 'money', r => invOf(r) && money(invOf(r).paid), 'Invoice'),
    F('inv.balance', 'Balance', 'money', r => invOf(r) && money(invOf(r).balance), 'Invoice')
  ];

  const lineSummary = row => row.lines || [];
  const firstCell = (row, name) => { for (const l of lineSummary(row)) if (l.cells[name]) return l.cells[name]; return ''; };
  const UNPAID_EXTRA_FIELDS = [
    F('inv.funder', 'Funder', 'enum', r => firstCell(r, 'Funder'), 'Invoice'),
    F('inv.billedTo', 'Billed to', 'enum', r => billedTo(firstCell(r, 'Payer'), firstCell(r, 'Funder')), 'Invoice'),
    F('inv.stage', 'Invoice status (Active/Issued)', 'enum', r => firstCell(r, 'Invoice Status'), 'Invoice'),
    F('inv.fees', 'Fees', 'text', r => feeSummary(lineSummary(r)), 'Invoice'),
    F('inv.lines', 'Lines', 'number', r => lineSummary(r).length || null, 'Invoice'),
    F('inv.lineApptStatus', 'Line appointment status', 'text', r => [...new Set(lineSummary(r).map(l => l.cells['Appointment Status']).filter(Boolean))].join(', '), 'Invoice')
  ];
  function billedTo(payer, funder) {
    if (!payer || !funder) return '';
    if (/self/i.test(funder)) return 'Patient';
    const p = payer.toLowerCase(), f = funder.toLowerCase();
    return (p.includes(f) || f.includes(p)) ? 'Insurer' : 'Patient';
  }
  function feeSummary(lines) {
    const c = {};
    lines.forEach(l => { const f = l.cells.Fee || l.cells.Category; if (f) c[f] = (c[f] || 0) + 1; });
    return Object.entries(c).map(([f, n]) => n > 1 ? f + ' ×' + n : f).join(', ');
  }

  const APPT_FIELDS = [
    F('ap.start', 'Start', 'datetime', r => parseDT(r.r.startTime), 'Appointment'),
    F('ap.end', 'End', 'datetime', r => parseDT(r.r.endTime), 'Appointment'),
    F('ap.day', 'Day', 'enum', r => r.r.day, 'Appointment'),
    F('ap.pract', 'Practitioner', 'enum', r => r.r.practitionerName, 'Appointment'),
    F('ap.location', 'Location', 'enum', r => r.r.location, 'Appointment'),
    F('ap.locType', 'Location type', 'enum', r => r.r.locationType, 'Appointment'),
    F('ap.patient', 'Patient', 'text', r => r.r.patName, 'Appointment'),
    F('ap.status', 'Status', 'enum', r => r.r.statusText, 'Appointment'),
    F('ap.notes', 'Notes', 'text', r => r.r.notes, 'Appointment')
  ];

  const pl = r => r.pl || null;
  const plDate = k => r => (pl(r) ? parseDT(pl(r)[k]) || (pl(r)[k] || null) : null);
  const plName = r => { const x = pl(r); if (!x) return ''; return [x.givenName, x.preferredName && x.preferredName !== x.givenName ? '(' + x.preferredName + ')' : '', x.surname].filter(Boolean).join(' '); };
  const ageOf = r => { const d = pl(r) && parseDT(pl(r).dateOfBirth); if (!d) return null; const t = new Date(); let a = t.getFullYear() - d.getFullYear(); if (t < new Date(t.getFullYear(), d.getMonth(), d.getDate())) a--; return a; };
  const PATIENT_LIST_FIELDS = [
    F('pl.name', 'Name', 'text', plName, 'Patient list', { link: r => pl(r) && pl(r).id != null ? BASE + '/patient/' + pl(r).id : null }),
    F('pl.given', 'Given name', 'text', r => pl(r) && pl(r).givenName, 'Patient list'),
    F('pl.preferred', 'Preferred name', 'text', r => pl(r) && pl(r).preferredName, 'Patient list'),
    F('pl.surname', 'Surname', 'text', r => pl(r) && pl(r).surname, 'Patient list'),
    F('pl.primary', 'Primary contact', 'text', r => pl(r) && pl(r).primaryContact, 'Patient list'),
    F('pl.num', 'Patient number', 'text', r => pl(r) && pl(r).patientNum, 'Patient list'),
    F('pl.status', 'Status', 'enum', r => pl(r) && pl(r).status, 'Patient list'),
    F('pl.created', 'Created', 'date', plDate('created'), 'Patient list'),
    F('pl.dob', 'Date of birth', 'date', plDate('dateOfBirth'), 'Patient list'),
    F('pl.age', 'Age', 'number', ageOf, 'Patient list'),
    F('pl.email', 'Email', 'text', r => pl(r) && pl(r).email, 'Patient list'),
    F('pl.phone', 'Phone', 'text', r => pl(r) && pl(r).phoneNumber, 'Patient list'),
    F('pl.address', 'Address', 'text', r => pl(r) && pl(r).addressFull, 'Patient list'),
    F('pl.location', 'Location', 'enum', r => pl(r) && pl(r).location, 'Patient list'),
    F('pl.main', 'Main', 'enum', r => pl(r) && pl(r).main, 'Patient list'),
    F('pl.labels', 'Labels', 'text', r => pl(r) && pl(r).label ? String(pl(r).label).split('|').join(', ') : '', 'Patient list'),
    F('pl.review', 'Review date', 'date', plDate('dateOfReview'), 'Patient list'),
    F('pl.reviewNotes', 'Review notes', 'text', r => pl(r) && pl(r).comment, 'Patient list'),
    F('pl.last', 'Last appointment (Halaxy)', 'datetime', plDate('lastAppointment'), 'Patient list'),
    F('pl.next', 'Next appointment (Halaxy)', 'datetime', plDate('nextAppointment'), 'Patient list')
  ];
  const pt = r => r.pt || null;
  const PATIENT_FIELDS = [
    F('pt.name', 'Patient name', 'text', r => pt(r) && pt(r).name, 'Patient'),
    F('pt.next', 'Next appointment', 'datetime', r => pt(r) && pt(r).next, 'Patient'),
    F('pt.nextDays', 'Days to next appointment', 'number', r => pt(r) && pt(r).nextDays, 'Patient'),
    F('pt.nextWith', 'Next appointment with', 'enum', r => pt(r) && pt(r).nextWith, 'Patient'),
    F('pt.ahead', 'Appointments booked ahead', 'number', r => pt(r) ? pt(r).ahead : 0, 'Patient'),
    F('pt.last', 'Last appointment', 'datetime', r => pt(r) && pt(r).last, 'Patient'),
    F('pt.lastDays', 'Days since last appointment', 'number', r => pt(r) && pt(r).lastDays, 'Patient'),
    F('pt.lastWith', 'Last appointment with', 'enum', r => pt(r) && pt(r).lastWith, 'Patient'),
    F('pt.attended', 'Attended (in window)', 'number', r => pt(r) ? pt(r).attended : 0, 'Patient'),
    F('pt.dna', 'Did not attend (in window)', 'number', r => pt(r) ? pt(r).dna : 0, 'Patient'),
    F('pt.cancelled', 'Cancelled (in window)', 'number', r => pt(r) ? pt(r).cancelled : 0, 'Patient'),
    F('pt.practs', 'Seen by', 'text', r => pt(r) && pt(r).practitionersText, 'Patient'),
    F('pt.unpaidCount', 'Unpaid invoices', 'number', r => pt(r) ? pt(r).unpaidCount : 0, 'Patient'),
    F('pt.unpaidBalance', 'Unpaid balance', 'money', r => pt(r) ? pt(r).unpaidBalance : 0, 'Patient'),
    F('pt.funders', 'Funders (unpaid lines)', 'text', r => pt(r) && pt(r).fundersText, 'Patient', { needsLines: true })
  ];

  // ======================================================================
  // Sources
  // ======================================================================
  const SOURCES = {
    unpaid: {
      label: 'Unpaid invoices (with funder)',
      window: ['reportFrom'],
      fields: () => [...INVOICE_FIELDS, ...UNPAID_EXTRA_FIELDS],
      patientId: row => row.inv && row.inv.linkPaGId,
      async load(ctx, v, status, notes, diag) {
        ctx.unpaid = ctx.unpaid || await fetchUnpaid(status, notes);
        await sleep(PAUSE_MS);
        ctx.report = ctx.report || await fetchLines(v.window.reportFrom, status, diag);
        const byInv = linesByInvoice(ctx.report.lines);
        ctx.linesByInvoice = byInv;
        return ctx.unpaid.map(i => ({ inv: i, lines: byInv.get(String(i.id)) || [] }));
      }
    },
    lines: {
      label: 'Unpaid invoice lines',
      window: ['reportFrom'],
      fields: ctx => [
        ...(ctx && ctx.report ? ctx.report.cols.map(c => F('ln:' + c.label, c.label, c.type, r => {
          const val = r.r.cells[c.label];
          if (c.type === 'money' || c.type === 'number') return money(val);
          if (c.type === 'date') return parseDT(val);
          return val;
        }, 'Line', /^invoice/i.test(c.name) ? { link: invLink } : {})) : []),
        ...INVOICE_FIELDS.filter(f => f.key !== 'inv.num').map(f => Object.assign({}, f, { label: f.label + ' (invoice)' }))
      ],
      patientId: row => row.inv && row.inv.linkPaGId,
      async load(ctx, v, status, notes, diag) {
        ctx.unpaid = ctx.unpaid || await fetchUnpaid(status, notes);
        await sleep(PAUSE_MS);
        ctx.report = ctx.report || await fetchLines(v.window.reportFrom, status, diag);
        ctx.linesByInvoice = linesByInvoice(ctx.report.lines);
        const map = new Map(ctx.unpaid.map(i => [String(i.id), i]));
        return ctx.report.lines.map(l => ({ r: l, inv: map.get(l.invoiceId) || null }));
      }
    },
    invoices: {
      label: 'Invoices (by date)',
      window: ['invFrom', 'invTo'],
      fields: () => INVOICE_FIELDS,
      patientId: row => row.inv && row.inv.linkPaGId,
      async load(ctx, v, status, notes) {
        const from = addDays(today(), -Math.abs(+v.window.invFrom || 0));
        const to = v.window.invTo === '' || v.window.invTo == null ? null : addDays(today(), +v.window.invTo + 1);
        const rows = await fetchByDate('/invoice/list-data', 'invoiceDate', from, to, 'invoices', status, notes);
        return rows.map(i => ({ inv: i }));
      }
    },
    appointments: {
      label: 'Appointments',
      window: ['apFrom', 'apTo'],
      fields: () => APPT_FIELDS,
      patientId: row => row.r.linkPaGId,
      async load(ctx, v, status, notes) {
        const from = addDays(today(), -Math.abs(+v.window.apFrom || 0));
        const to = v.window.apTo === '' || v.window.apTo == null ? null : addDays(today(), +v.window.apTo + 1);
        const ptFrom = addDays(today(), -Math.abs(+v.window.ptPast || 180));
        const rows = await getAppts(ctx, from < ptFrom ? from : ptFrom, status, notes);
        return rows.filter(a => { const d = parseDT(a.startTime); return d && d >= from && (!to || d < to); }).map(a => ({ r: a }));
      }
    },
    patients: {
      label: 'Patients',
      window: [],
      fields: () => PATIENT_LIST_FIELDS,
      patientId: row => row.pt && row.pt.id,
      async load(ctx, v, status, notes, diag, needLines) {
        const list = await fetchPatientList(status, notes);
        await sleep(PAUSE_MS);
        await loadPatientData(ctx, v, status, notes, diag, needLines);
        // Which patient-list ID matches the appointment/invoice patient link? Counted, never shown.
        const linkIds = ctx.patients;
        const cand = ['linkPaGId', 'linkPaG', 'id', 'patientId', 'patientID'];
        const hits = {};
        cand.forEach(k => { hits[k] = list.filter(r => r[k] != null && linkIds.has(String(r[k]))).length; });
        const key = cand.reduce((best, k) => (hits[k] > (hits[best] || 0) ? k : best), 'id');
        diag.patientList = { rows: list.length, fields: list[0] ? Object.keys(list[0]) : [], linkMatches: hits, linkedBy: key };
        const rows = list.map(r => ({ pl: r, pt: r[key] != null ? linkIds.get(String(r[key])) || null : null }));
        // Patients seen or owing money who are not in the list (for example archived) still appear.
        const listed = new Set(rows.filter(r => r.pt).map(r => r.pt.id));
        linkIds.forEach((p, id) => { if (!listed.has(id)) rows.push({ pl: null, pt: p }); });
        return rows;
      }
    }
  };

  function linesByInvoice(lines) {
    const m = new Map();
    lines.forEach(l => { const k = String(l.invoiceId); if (!m.has(k)) m.set(k, []); m.get(k).push(l); });
    return m;
  }

  async function getAppts(ctx, from, status, notes) {
    if (ctx.appts && ctx.apptsFrom <= from) return ctx.appts;
    ctx.appts = await fetchByDate('/appointment/list-data', 'startTime', from, null, 'appointments', status, notes);
    ctx.apptsFrom = from;
    return ctx.appts;
  }

  async function loadPatientData(ctx, v, status, notes, diag, needLines) {
    const ptFrom = addDays(today(), -Math.abs(+v.window.ptPast || 180));
    let from = ptFrom;
    if (v.source === 'appointments') {
      const srcFrom = addDays(today(), -Math.abs(+v.window.apFrom || 0));
      if (srcFrom < from) from = srcFrom;
    }
    await getAppts(ctx, from, status, notes);
    await sleep(PAUSE_MS);
    ctx.unpaid = ctx.unpaid || await fetchUnpaid(status, notes);
    if (needLines && !ctx.report) {
      await sleep(PAUSE_MS);
      ctx.report = await fetchLines(v.window.reportFrom, status, diag);
      ctx.linesByInvoice = linesByInvoice(ctx.report.lines);
    }
    const ptAppts = ctx.appts.filter(a => { const d = parseDT(a.startTime); return d && d >= ptFrom; });
    ctx.patients = buildPatients(ptAppts, ctx.unpaid, ctx.linesByInvoice);
  }

  // ======================================================================
  // Filters
  // ======================================================================
  const OPS = {
    text: [['contains', 'contains'], ['notcontains', 'does not contain'], ['is', 'is'], ['isnot', 'is not'], ['starts', 'starts with'], ['empty', 'is empty'], ['notempty', 'is not empty']],
    enum: [['in', 'is any of'], ['notin', 'is none of'], ['contains', 'contains'], ['notcontains', 'does not contain'], ['empty', 'is empty'], ['notempty', 'is not empty']],
    number: [['eq', '='], ['ne', 'is not'], ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['between', 'is between'], ['empty', 'is empty'], ['notempty', 'is not empty']],
    date: [['on', 'is on'], ['before', 'is before'], ['after', 'is after'], ['between', 'is between'], ['next', 'is in the next'], ['last', 'is in the last'], ['rel', 'is between, in days from today'], ['period', 'is in'], ['empty', 'is empty'], ['notempty', 'is not empty']]
  };
  const PERIODS = [['thisweek', 'this week'], ['lastweek', 'last week'], ['nextweek', 'next week'], ['thismonth', 'this month'], ['lastmonth', 'last month'], ['nextmonth', 'next month'], ['thisquarter', 'this quarter'], ['lastquarter', 'last quarter'], ['nextquarter', 'next quarter'], ['thisyear', 'this year'], ['lastyear', 'last year']];
  const opType = t => (t === 'money' ? 'number' : t === 'datetime' ? 'date' : t);

  function periodRange(p) {
    const t = today();
    const shift = /^last/.test(p) ? -1 : /^next/.test(p) ? 1 : 0;
    if (/week$/.test(p)) { const s = addDays(t, -((t.getDay() + 6) % 7) + 7 * shift); return [s, addDays(s, 7)]; }
    if (/month$/.test(p)) { const s = new Date(t.getFullYear(), t.getMonth() + shift, 1); return [s, new Date(s.getFullYear(), s.getMonth() + 1, 1)]; }
    if (/quarter$/.test(p)) { const q = Math.floor(t.getMonth() / 3) + shift; const s = new Date(t.getFullYear(), q * 3, 1); return [s, new Date(s.getFullYear(), s.getMonth() + 3, 1)]; }
    const s = new Date(t.getFullYear() + shift, 0, 1);
    return [s, new Date(s.getFullYear() + 1, 0, 1)];
  }

  function isEmpty(v) { return v == null || v === '' || (v instanceof Date && isNaN(v)); }
  const num = x => (x === '' || x == null || isNaN(+x)) ? null : +x;

  function evalCond(c, row, fmap) {
    const f = fmap.get(c.field);
    if (!f || !c.op) return true;
    const v = f.get(row);
    const t = opType(f.type);
    if (c.op === 'empty') return isEmpty(v);
    if (c.op === 'notempty') return !isEmpty(v);
    if (isEmpty(v)) return ['notcontains', 'isnot', 'notin', 'ne'].includes(c.op);
    if (t === 'text' || t === 'enum') {
      const s = String(v).toLowerCase(), q = String(c.value ?? '').toLowerCase().trim();
      switch (c.op) {
        case 'contains': return s.includes(q);
        case 'notcontains': return !s.includes(q);
        case 'is': return s === q;
        case 'isnot': return s !== q;
        case 'starts': return s.startsWith(q);
        case 'in': return !(c.values || []).length || (c.values || []).includes(String(v));
        case 'notin': return !(c.values || []).includes(String(v));
      }
      return true;
    }
    if (t === 'number') {
      const n = +v, a = num(c.value), b = num(c.value2);
      if (a == null && c.op !== 'between') return true;
      switch (c.op) {
        case 'eq': return n === a;
        case 'ne': return n !== a;
        case 'gt': return n > a;
        case 'gte': return n >= a;
        case 'lt': return n < a;
        case 'lte': return n <= a;
        case 'between': return (a == null || n >= a) && (b == null || n <= b);
      }
      return true;
    }
    if (t === 'date') {
      const d = dayStart(v), t0 = today();
      const A = c.value ? parseDT(c.value) : null, B = c.value2 ? parseDT(c.value2) : null;
      switch (c.op) {
        case 'on': return !A || +d === +dayStart(A);
        case 'before': return !A || d < dayStart(A);
        case 'after': return !A || d > dayStart(A);
        case 'between': return (!A || d >= dayStart(A)) && (!B || d <= dayStart(B));
        case 'next': { const n = num(c.value); return n == null || (d >= t0 && d <= addDays(t0, n)); }
        case 'last': { const n = num(c.value); return n == null || (d <= t0 && d >= addDays(t0, -n)); }
        case 'rel': { const a = num(c.value), b = num(c.value2); return (a == null || d >= addDays(t0, a)) && (b == null || d <= addDays(t0, b)); }
        case 'period': { if (!c.value) return true; const [s, e] = periodRange(c.value); return d >= s && d < e; }
      }
      return true;
    }
    return true;
  }
  function evalNode(n, row, fmap) {
    if (n.type === 'group') {
      if (!n.items.length) return true;
      return n.join === 'or' ? n.items.some(i => evalNode(i, row, fmap)) : n.items.every(i => evalNode(i, row, fmap));
    }
    return evalCond(n, row, fmap);
  }
  function walkConds(n, fn) { if (n.type === 'group') n.items.forEach(i => walkConds(i, fn)); else fn(n); }

  // ======================================================================
  // Views
  // ======================================================================
  const newGroup = (join) => ({ type: 'group', join: join || 'and', items: [] });
  const DEFAULT_WINDOW = () => ({ reportFrom: isoDay(addDays(today(), -365)), invFrom: 90, invTo: '', apFrom: 30, apTo: 60, ptPast: 180 });
  function blankView() {
    return { name: '', source: 'unpaid', window: DEFAULT_WINDOW(), filters: newGroup('and'), columns: ['inv.num', 'inv.date', 'inv.payer', 'inv.funder', 'inv.balance'], sort: { key: 'inv.date', dir: -1 }, gridState: null };
  }
  const STARTERS = [
    { name: 'Unbilled insurer invoices + next appointment', source: 'unpaid', window: DEFAULT_WINDOW(),
      filters: { type: 'group', join: 'and', items: [
        { field: 'inv.funder', op: 'notempty' },
        { field: 'inv.funder', op: 'notcontains', value: 'self' },
        { field: 'inv.billedTo', op: 'in', values: ['Patient'] }] },
      columns: ['inv.num', 'inv.date', 'inv.payer', 'inv.funder', 'inv.pract', 'inv.fees', 'inv.balance', 'pt.next', 'pt.nextDays', 'pt.nextWith', 'pt.ahead'],
      sort: { key: 'pt.next', dir: 1 } },
    { name: 'Seen in last 30 days, nothing booked', source: 'patients', window: DEFAULT_WINDOW(),
      filters: { type: 'group', join: 'and', items: [
        { field: 'pt.last', op: 'last', value: '30' },
        { field: 'pt.ahead', op: 'eq', value: '0' }] },
      columns: ['pl.name', 'pt.last', 'pt.lastWith', 'pt.lastDays', 'pt.attended', 'pt.dna', 'pt.unpaidBalance'],
      sort: { key: 'pt.last', dir: -1 } },
    { name: 'DNAs and cancellations, last 30 days', source: 'appointments', window: Object.assign(DEFAULT_WINDOW(), { apFrom: 30, apTo: 0 }),
      filters: { type: 'group', join: 'and', items: [
        { type: 'group', join: 'or', items: [
          { field: 'ap.status', op: 'contains', value: 'not attend' },
          { field: 'ap.status', op: 'contains', value: 'cancel' }] }] },
      columns: ['ap.start', 'ap.patient', 'ap.pract', 'ap.status', 'pt.next', 'pt.dna'],
      sort: { key: 'ap.start', dir: -1 } },
    { name: 'Unpaid invoices over 60 days old', source: 'unpaid', window: DEFAULT_WINDOW(),
      filters: { type: 'group', join: 'and', items: [{ field: 'inv.date', op: 'rel', value: '-3650', value2: '-60' }] },
      columns: ['inv.num', 'inv.date', 'inv.payer', 'inv.funder', 'inv.billedTo', 'inv.balance', 'pt.next'],
      sort: { key: 'inv.date', dir: 1 } }
  ];

  // ======================================================================
  // State
  // ======================================================================
  const state = {
    view: null, savedName: null, data: null, running: false, mounted: false, root: null,
    diag: { version: VERSION, menu: 'not attempted', container: 'not mounted' }
  };

  function allFields() {
    if (state.view.source === 'patients') return [...PATIENT_LIST_FIELDS, ...PATIENT_FIELDS];
    return [...SOURCES[state.view.source].fields(state.data && state.data.ctx), ...PATIENT_FIELDS];
  }
  const fieldMap = () => new Map(allFields().map(f => [f.key, f]));
  function usedKeys(v) {
    const keys = new Set(v.columns);
    walkConds(v.filters, c => keys.add(c.field));
    if (v.sort && v.sort.key) keys.add(v.sort.key);
    return keys;
  }

  function byYear(list, pred) {
    const o = {};
    list.forEach(i => { if (!pred(i)) return; const d = parseDT(i.invoiceDate); const y = d ? d.getFullYear() : 'unknown'; o[y] = (o[y] || 0) + 1; });
    return o;
  }

  // ======================================================================
  // Run
  // ======================================================================
  async function run() {
    if (state.running) return;
    state.running = true;
    setBusy(true);
    const v = state.view;
    const notes = [];
    const diag = {};
    const ctx = {};
    const t0 = Date.now();
    net.requests = 0; net.serverDateFilter = {};
    try {
      const src = SOURCES[v.source];
      const keys = usedKeys(v);
      const needPatient = true;
      const needLines = keys.has('pt.funders');
      const base = await src.load(ctx, v, setStatus, notes, diag, needLines);
      if (needPatient && v.source !== 'patients') {
        await sleep(PAUSE_MS);
        await loadPatientData(ctx, v, setStatus, notes, diag, needLines);
        base.forEach(row => { const id = src.patientId(row); row.pt = id != null ? ctx.patients.get(String(id)) || null : null; });
      }
      state.data = { rows: base, ctx, notes, loadedAt: new Date(), ms: Date.now() - t0 };
      state.diag.lastRun = Object.assign({
        source: v.source, rows: base.length, seconds: Math.round((Date.now() - t0) / 100) / 10,
        unpaidInvoices: ctx.unpaid ? ctx.unpaid.length : '-', appointments: ctx.appts ? ctx.appts.length : '-',
        patients: ctx.patients ? ctx.patients.size : '-',
        rowsLinkedToPatient: needPatient ? base.filter(r => r.pt).length : '-',
        unpaidWithPatientLink: ctx.unpaid ? ctx.unpaid.filter(i => i.linkPaGId != null).length : '-',
        unpaidWithReportLines: ctx.unpaid && ctx.linesByInvoice ? ctx.unpaid.filter(i => ctx.linesByInvoice.has(String(i.id))).length : '-',
        unpaidByYear: ctx.unpaid ? byYear(ctx.unpaid, i => true) : '-',
        unpaidWithLinesByYear: ctx.unpaid && ctx.linesByInvoice ? byYear(ctx.unpaid, i => ctx.linesByInvoice.has(String(i.id))) : '-',
        unpaidNoPatientLinkByYear: ctx.unpaid ? byYear(ctx.unpaid, i => i.linkPaGId == null) : '-',
        requests: net.requests,
        serverDateFilter: net.serverDateFilter
      }, diag);
      renderAll();
    } catch (e) {
      console.error('[Custom Reports]', e);
      setStatus('Could not load: ' + e.message);
    } finally {
      state.running = false;
      setBusy(false);
    }
  }

  // ======================================================================
  // UI
  // ======================================================================
  function css() {
    if (document.getElementById('hxr-style')) return;
    const s = document.createElement('style');
    s.id = 'hxr-style';
    s.textContent = `
      #hxr{padding:4px 0 32px;max-width:100%;box-sizing:border-box}
      #hxr .hxr-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:12px}
      #hxr .hxr-bar select.hxr-views{min-width:280px;width:auto}
      #hxr .hxr-dirty{font-size:12px;opacity:.75}
      #hxr .card{margin-bottom:12px}
      #hxr .card-body{padding:12px 14px}
      #hxr .hxr-h{font-weight:600;margin:0 0 6px}
      #hxr .hxr-row{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center}
      #hxr .hxr-row label{display:flex;align-items:center;gap:6px;margin:0;font-weight:normal}
      #hxr .form-control{width:auto;display:inline-block}
      #hxr input[type=number].form-control{width:80px}
      #hxr .hxr-lvl{border-left:1px solid var(--vs-theme-body-color,#666);margin:2px 0 2px 10px;padding:2px 0 2px 12px}
      #hxr [data-part="filters"] > .hxr-lvl{margin-left:0}
      #hxr .hxr-cond{display:flex;align-items:center;gap:6px;margin:6px 0}
      #hxr .hxr-cond-fields{display:flex;flex-wrap:wrap;gap:6px;align-items:center;flex:1 1 auto;min-width:0}
      #hxr .hxr-cond select[multiple]{min-width:200px}
      #hxr .hxr-del{margin-left:auto;flex:0 0 auto;line-height:1;padding:4px 7px}
      #hxr .hxr-join{display:flex;gap:4px;align-items:center;margin:0 0 0 10px}
      #hxr .hxr-chip{font-size:11px;font-weight:700;line-height:16px;border:1px solid;border-radius:4px;padding:0 6px;background:transparent;cursor:pointer}
      #hxr .hxr-chip.hxr-and{color:#b02a37;border-color:#e4a1a8}
      #hxr .hxr-chip.hxr-or{color:#1e7e34;border-color:#9fd3ab}
      #hxr .hxr-mini{font-size:12px;line-height:16px;border:1px solid var(--vs-theme-border-color,#ccc);border-radius:4px;background:transparent;color:inherit;padding:0 5px;cursor:pointer;flex:0 0 auto}
      #hxr .hxr-add{display:flex;gap:4px;margin:6px 0 2px}
      #hxr .hxr-add .btn{padding:0 8px;line-height:20px;font-weight:700}
      #hxr .hxr-empty{margin:4px 0}
      #hxr .hxr-warn{color:var(--vs-balance-negative-color,#c0392b)}
      #hxr .hxr-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:4px 0 8px}
      #hxr .hxr-actions input[type=search]{min-width:240px}
      #hxr .hxr-status{margin:6px 0;white-space:pre-wrap}
      #hxr .hxr-notes{white-space:pre-wrap;margin-bottom:6px;color:var(--vs-balance-negative-color,#c0392b)}
      #hxr .hxr-sub{font-size:12px;opacity:.75}
      #hxr .hxr-grid{width:100%}
      #hxr .hxr-plain{overflow-x:auto}
      #hxr .hxr-plain table{width:100%}
      #hxr .hxr-plain th{cursor:pointer;white-space:nowrap}
      #hxr .num{text-align:right;white-space:nowrap}
    `;
    document.head.appendChild(s);
  }

  function setStatus(t) { const el = state.root && state.root.querySelector('.hxr-status'); if (el) el.textContent = t; }
  function setBusy(b) { const el = state.root && state.root.querySelector('[data-a="run"]'); if (el) { el.disabled = b; el.textContent = b ? 'Running...' : 'Run'; } }
  function markDirty() { const el = state.root && state.root.querySelector('.hxr-dirty'); if (el) el.textContent = state.savedName ? 'Unsaved changes' : ''; lsSet(LAST_KEY, state.view); }

  function shell() {
    const el = document.createElement('div');
    el.id = 'hxr';
    el.innerHTML = `
      <div class="hxr-bar">
        <select class="form-control hxr-views" data-a="views"></select>
        <button type="button" class="btn btn-sm btn-outline-primary" data-a="new">New</button>
        <button type="button" class="btn btn-sm btn-outline-primary" data-a="save">Save</button>
        <button type="button" class="btn btn-sm btn-outline-primary" data-a="saveas">Save as</button>
        <button type="button" class="btn btn-sm btn-outline-primary" data-a="delete">Delete</button>
        <button type="button" class="btn btn-sm btn-outline-primary" data-a="link" title="Copies a link to this view. Bookmark it in Firefox to have it on every PC.">Copy link</button>
        <span class="hxr-dirty"></span>
      </div>
      <div class="card"><div class="card-body"><div class="hxr-row" data-part="source"></div></div></div>
      <div class="card"><div class="card-body"><div class="hxr-h">Filters</div><div data-part="filters"></div></div></div>
      <div class="hxr-actions">
        <button type="button" class="btn btn-primary" data-a="run">Run</button>
        <input type="search" class="form-control" data-a="quick" placeholder="Search keywords">
        <button type="button" class="btn btn-outline-primary" data-a="export">Export</button>
        <button type="button" class="btn btn-sm btn-link" data-a="diag">Diagnostics</button>
        <span class="hxr-sub">Read-only. Fetches data only when you press Run. Use the Columns tab beside the table to add, remove or group columns.</span>
      </div>
      <div class="hxr-status">Choose what to report on, add filters, then press Run.</div>
      <div class="hxr-notes"></div>
      <div data-part="grid"></div>
      <div class="hxr-sub" style="margin-top:12px">Custom Reports v${VERSION}</div>`;
    el.addEventListener('click', onClick);
    el.querySelector('[data-a="views"]').addEventListener('change', e => loadNamed(e.target.value));
    el.querySelector('[data-a="quick"]').addEventListener('input', e => quickFilter(e.target.value));
    return el;
  }

  function onClick(e) {
    const a = e.target.closest('[data-a]');
    if (!a || a.tagName === 'SELECT' || a.tagName === 'INPUT') return;
    const act = a.dataset.a;
    if (act === 'run') run();
    else if (act === 'diag') diagnostics();
    else if (act === 'export') exportData();
    else if (act === 'new') { state.view = blankView(); state.savedName = null; state.data = null; renderAll(); markDirty(); }
    else if (act === 'save') saveView(false);
    else if (act === 'saveas') saveView(true);
    else if (act === 'delete') deleteView();
    else if (act === 'link') copyLink();
  }

  // ---------- saved views ----------
  const savedViews = () => lsGet(VIEWS_KEY, []);
  function renderViewsSelect() {
    const sel = state.root.querySelector('[data-a="views"]');
    const saved = savedViews();
    sel.innerHTML = '<option value="">' + (state.savedName ? 'Unsaved view' : 'Choose a view...') + '</option>' +
      (saved.length ? '<optgroup label="Saved views">' + saved.map(s => '<option value="s:' + esc(s.name) + '">' + esc(s.name) + '</option>').join('') + '</optgroup>' : '') +
      '<optgroup label="Starter views">' + STARTERS.map((s, i) => '<option value="t:' + i + '">' + esc(s.name) + '</option>').join('') + '</optgroup>';
    sel.value = state.savedName ? 's:' + state.savedName : '';
  }
  function loadNamed(val) {
    if (!val) return;
    let v = null;
    if (val.startsWith('s:')) { const s = savedViews().find(x => x.name === val.slice(2)); if (s) { v = clone(s.view); state.savedName = s.name; } }
    else if (val.startsWith('t:')) { v = clone(STARTERS[+val.slice(2)]); state.savedName = null; }
    if (!v) return;
    state.view = normaliseView(v);
    state.data = null;
    renderAll();
    lsSet(LAST_KEY, state.view);
    setStatus('Loaded "' + (state.view.name || 'view') + '". Press Run.');
  }
  function saveView(asNew) {
    let name = state.savedName;
    if (asNew || !name) {
      name = prompt('Name this view', state.view.name || '');
      if (!name) return;
      name = name.trim();
    }
    const list = savedViews().filter(s => s.name !== name);
    state.view.name = name;
    list.push({ name, view: clone(state.view) });
    list.sort((a, b) => a.name.localeCompare(b.name));
    lsSet(VIEWS_KEY, list);
    state.savedName = name;
    renderViewsSelect();
    markDirty();
    state.root.querySelector('.hxr-dirty').textContent = 'Saved';
  }
  function deleteView() {
    if (!state.savedName) { setStatus('This view is not saved, so there is nothing to delete.'); return; }
    if (!confirm('Delete the saved view "' + state.savedName + '" from this PC?')) return;
    lsSet(VIEWS_KEY, savedViews().filter(s => s.name !== state.savedName));
    state.savedName = null;
    renderViewsSelect();
    markDirty();
  }
  function viewLink() { return location.origin + HOST_PATH + '#' + ROUTE + '=' + encodeView(state.view); }
  function copyLink() {
    const link = viewLink();
    const done = () => setStatus('Link copied. Paste it into a Firefox bookmark to keep this view on every PC.');
    try { navigator.clipboard.writeText(link).then(done, () => prompt('Copy this link', link)); } catch (e) { prompt('Copy this link', link); }
  }
  function normaliseView(v) {
    const b = blankView();
    const out = Object.assign(b, v);
    out.window = Object.assign(DEFAULT_WINDOW(), v.window || {});
    if (!out.filters || out.filters.type !== 'group') out.filters = newGroup('and');
    if (!SOURCES[out.source]) out.source = 'unpaid';
    if (!Array.isArray(out.columns)) out.columns = [];
    if (!out.gridState || typeof out.gridState !== 'object') out.gridState = null;
    return out;
  }

  // ---------- source and window ----------
  function renderSource() {
    const box = state.root.querySelector('[data-part="source"]');
    const v = state.view;
    const w = v.window;
    const parts = [];
    parts.push('<label>Report on <select class="form-control" data-w="source">' + Object.entries(SOURCES).map(([k, s]) => '<option value="' + k + '"' + (k === v.source ? ' selected' : '') + '>' + esc(s.label) + '</option>').join('') + '</select></label>');
    const srcWin = SOURCES[v.source].window;
    if (srcWin.includes('reportFrom')) parts.push('<label>Lines from invoices dated <input type="date" class="form-control" data-w="reportFrom" value="' + esc(w.reportFrom) + '"></label>');
    if (srcWin.includes('invFrom')) parts.push('<label>Invoice date from <input type="number" min="0" class="form-control" data-w="invFrom" value="' + esc(w.invFrom) + '"> days ago</label><label>to <input type="number" class="form-control" data-w="invTo" value="' + esc(w.invTo) + '" placeholder="today"> days ahead</label>');
    if (srcWin.includes('apFrom')) parts.push('<label>Appointments from <input type="number" min="0" class="form-control" data-w="apFrom" value="' + esc(w.apFrom) + '"> days ago</label><label>to <input type="number" min="0" class="form-control" data-w="apTo" value="' + esc(w.apTo) + '" placeholder="all"> days ahead</label>');
    parts.push('<label title="How far back appointment history goes for patient fields such as Last appointment and DNAs. Future appointments are always included.">Patient history <input type="number" min="0" class="form-control" data-w="ptPast" value="' + esc(w.ptPast) + '"> days</label>');
    box.innerHTML = parts.join('');
    box.querySelectorAll('[data-w]').forEach(inp => inp.addEventListener('change', () => {
      const k = inp.dataset.w;
      if (k === 'source') {
        v.source = inp.value;
        v.columns = defaultColumns(v.source);
        v.sort = { key: v.columns[0], dir: 1 };
        v.gridState = null;
        state.data = null;
        renderAll();
      } else {
        v.window[k] = inp.type === 'number' ? (inp.value === '' ? '' : +inp.value) : inp.value;
        setStatus('Data window changed. Press Run to reload.');
      }
      markDirty();
    }));
  }
  function defaultColumns(source) {
    return {
      unpaid: ['inv.num', 'inv.date', 'inv.payer', 'inv.funder', 'inv.billedTo', 'inv.balance'],
      lines: ['ln:Invoice / Deposit', 'ln:Date', 'ln:Payer', 'ln:Funder', 'ln:Fee', 'ln:Amount', 'ln:Balance'],
      invoices: ['inv.num', 'inv.date', 'inv.payer', 'inv.pract', 'inv.status', 'inv.total', 'inv.balance'],
      appointments: ['ap.start', 'ap.patient', 'ap.pract', 'ap.status'],
      patients: ['pl.name', 'pl.status', 'pt.last', 'pt.next', 'pt.ahead', 'pt.unpaidBalance']
    }[source] || [];
  }

  // ---------- filter builder ----------
  function enumOptions(f) {
    if (!state.data) return [];
    const s = new Set();
    state.data.rows.forEach(r => { const v = f.get(r); if (!isEmpty(v)) s.add(String(v)); });
    return [...s].sort((a, b) => a.localeCompare(b, 'en-GB', { numeric: true }));
  }
  function fieldSelect(selected) {
    const fields = allFields();
    const groups = {};
    fields.forEach(f => { (groups[f.group] = groups[f.group] || []).push(f); });
    let html = '<select class="form-control" data-c="field"><option value="">Choose a field...</option>';
    Object.entries(groups).forEach(([g, fs]) => {
      html += '<optgroup label="' + esc(g) + '">' + fs.map(f => '<option value="' + esc(f.key) + '"' + (f.key === selected ? ' selected' : '') + '>' + esc(f.label) + '</option>').join('') + '</optgroup>';
    });
    if (selected && !fields.some(f => f.key === selected)) html += '<option value="' + esc(selected) + '" selected>' + esc(selected.replace(/^ln:/, '')) + ' (loads on Run)</option>';
    return html + '</select>';
  }
  function condValueHtml(c, f) {
    if (!f || !c.op || c.op === 'empty' || c.op === 'notempty') return '';
    const t = opType(f.type);
    const inp = (k, type, ph, extra) => '<input type="' + type + '" class="form-control" data-c="' + k + '" value="' + esc(c[k] ?? '') + '"' + (ph ? ' placeholder="' + esc(ph) + '"' : '') + (extra || '') + '>';
    if (t === 'enum' && (c.op === 'in' || c.op === 'notin')) {
      const opts = enumOptions(f);
      const chosen = new Set(c.values || []);
      chosen.forEach(x => { if (!opts.includes(x)) opts.push(x); });
      if (!opts.length) return '<span class="hxr-sub">Press Run to load the choices</span>';
      return '<select multiple class="form-control" data-c="values" size="' + Math.min(6, Math.max(2, opts.length)) + '">' + opts.map(o => '<option' + (chosen.has(o) ? ' selected' : '') + '>' + esc(o) + '</option>').join('') + '</select>';
    }
    if (t === 'text' || t === 'enum') return inp('value', 'text', 'text');
    if (t === 'number') return c.op === 'between' ? inp('value', 'number', 'from') + ' and ' + inp('value2', 'number', 'to') : inp('value', 'number', '');
    if (t === 'date') {
      if (c.op === 'between') return inp('value', 'date') + ' and ' + inp('value2', 'date');
      if (c.op === 'next' || c.op === 'last') return inp('value', 'number', '', ' min="0"') + ' days';
      if (c.op === 'rel') return inp('value', 'number', '-30') + ' and ' + inp('value2', 'number', '7') + ' <span class="hxr-sub">(minus = past)</span>';
      if (c.op === 'period') return '<select class="form-control" data-c="value"><option value="">choose...</option>' + PERIODS.map(([k, l]) => '<option value="' + k + '"' + (c.value === k ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>';
      return inp('value', 'date');
    }
    return '';
  }
  // Filter builder, laid out like myClubhouse: one line per level, AND/OR chips between
  // conditions, → to indent a condition into a sub-group, ← to bring it back out.
  const TRASH = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M5.5 5.5a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0z"/><path fill="currentColor" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1 0-2H5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1h2.5a1 1 0 0 1 1 1M4 4v9a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4z"/></svg>';
  const flip = j => (j === 'and' ? 'or' : 'and');
  function indentItem(g, i) {
    const item = g.items[i];
    const prev = g.items[i - 1];
    if (prev && prev.type === 'group') { g.items.splice(i, 1); prev.items.push(item); }
    else g.items[i] = { type: 'group', join: flip(g.join), items: [item] };
  }
  function outdentItem(g, parent, i) {
    const item = g.items.splice(i, 1)[0];
    const j = parent.items.indexOf(g);
    parent.items.splice(j + 1, 0, item);
    if (!g.items.length) parent.items.splice(j, 1);
  }
  function pruneEmpty(g) {
    g.items = g.items.filter(it => it.type !== 'group' || (pruneEmpty(it), it.items.length));
    return g;
  }
  function renderFilters() {
    const box = state.root.querySelector('[data-part="filters"]');
    const fmap = fieldMap();
    const redraw = () => { renderFilters(); changed(); };
    const btn = (cls, html, title, fn) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = cls; b.innerHTML = html; if (title) b.title = title;
      b.addEventListener('click', fn);
      return b;
    };
    const build = (g, parent) => {
      const lvl = document.createElement('div');
      lvl.className = 'hxr-lvl';
      if (!g.items.length && !parent) {
        const empty = document.createElement('div');
        empty.className = 'hxr-sub hxr-empty';
        empty.textContent = 'No filters: every row is shown.';
        lvl.appendChild(empty);
      }
      g.items.forEach((item, i) => {
        if (item.type === 'group') {
          lvl.appendChild(build(item, g));
        } else {
          const f = fmap.get(item.field);
          const ops = f ? OPS[opType(f.type)] : [];
          if (!item.op && f) item.op = ops[0][0];
          const row = document.createElement('div');
          row.className = 'hxr-cond';
          if (parent) row.appendChild(btn('hxr-mini', '&larr;', 'Move out of this group', () => { outdentItem(g, parent, i); redraw(); }));
          const fields = document.createElement('span');
          fields.className = 'hxr-cond-fields';
          fields.innerHTML = fieldSelect(item.field) +
            (f ? '<select class="form-control" data-c="op">' + ops.map(([k, l]) => '<option value="' + k + '"' + (item.op === k ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select>' : '') +
            condValueHtml(item, f) +
            (item.field && !f ? '<span class="hxr-warn" title="Not available for this source, so it is ignored">⚠ ignored</span>' : '');
          row.appendChild(fields);
          row.appendChild(btn('btn btn-sm btn-outline-danger hxr-del', TRASH, 'Remove', () => { g.items.splice(i, 1); pruneEmpty(state.view.filters); redraw(); }));
          fields.querySelector('[data-c="field"]').addEventListener('change', e => {
            item.field = e.target.value;
            const nf = fmap.get(item.field);
            item.op = nf ? OPS[opType(nf.type)][0][0] : '';
            delete item.value; delete item.value2; delete item.values;
            redraw();
          });
          const opSel = fields.querySelector('[data-c="op"]');
          if (opSel) opSel.addEventListener('change', e => { item.op = e.target.value; delete item.value; delete item.value2; redraw(); });
          fields.querySelectorAll('[data-c="value"],[data-c="value2"]').forEach(inp => inp.addEventListener('input', () => { item[inp.dataset.c] = inp.value; changedSoon(); }));
          const multi = fields.querySelector('[data-c="values"]');
          if (multi) multi.addEventListener('change', () => { item.values = [...multi.selectedOptions].map(o => o.value); changed(); });
          lvl.appendChild(row);
        }
        if (i < g.items.length - 1) {
          const join = document.createElement('div');
          join.className = 'hxr-join';
          join.appendChild(btn('hxr-chip hxr-' + g.join, g.join.toUpperCase(), 'Click to switch every condition at this level between AND and OR', () => { g.join = flip(g.join); redraw(); }));
          if (item.type !== 'group') join.appendChild(btn('hxr-mini', '&rarr;', 'Indent: move this condition into a sub-group', () => { indentItem(g, i); redraw(); }));
          lvl.appendChild(join);
        }
      });
      const add = document.createElement('div');
      add.className = 'hxr-add';
      add.appendChild(btn('btn btn-sm btn-primary', '+', 'Add a condition at this level', () => { g.items.push({ field: '', op: '' }); renderFilters(); markDirty(); }));
      add.appendChild(btn('btn btn-sm btn-primary', '(&hellip;)', 'Add a bracketed group at this level', () => { g.items.push({ type: 'group', join: flip(g.join), items: [{ field: '', op: '' }] }); renderFilters(); markDirty(); }));
      lvl.appendChild(add);
      return lvl;
    };
    box.innerHTML = '';
    box.appendChild(build(state.view.filters, null));
  }
  let soonTimer = null;
  function changedSoon() { clearTimeout(soonTimer); soonTimer = setTimeout(changed, 300); }
  function changed() { markDirty(); refreshFilter(); }

  // ---------- results: Halaxy's grid, with a plain table as fallback ----------
  const grid = { api: null, el: null, mode: 'none', error: '', fmap: new Map() };
  // Halaxy's own table builder (it creates the grid with Halaxy's licensed copy). Note that
  // window.agGrid on Halaxy pages is Halaxy's list object, not the grid library.
  const gridLib = () => (typeof window.HxGridTable === 'function' ? window.HxGridTable : null);
  const QUIET_SOURCES = new Set(['gridInitializing', 'scroll', 'focusedCell', 'pagination', 'cellSelection', 'rowSelection', 'sideBar', 'rowGroupExpansion']);
  const STATE_SKIP = ['scroll', 'focusedCell', 'cellSelection', 'rowSelection', 'pagination', 'sideBar', 'rowGroupExpansion', 'version'];
  const cleanState = st => { const o = Object.assign({}, st || {}); STATE_SKIP.forEach(k => delete o[k]); return o; };
  const hasConds = g => { let n = 0; walkConds(g, c => { if (c.field && c.op) n++; }); return n > 0; };

  function fmtCell(f, val) {
    if (isEmpty(val)) return '';
    switch (f.type) {
      case 'money': return gbp(val);
      case 'date': return val instanceof Date ? fmtDate(val) : String(val);
      case 'datetime': return val instanceof Date ? fmtDT(val) : String(val);
      default: return String(val);
    }
  }

  function exportCell(p) {
    const f = p.column && grid.fmap.get(p.column.getColId());
    if (!f) return p.value;
    if (f.type === 'money' || f.type === 'number') return p.value == null ? '' : p.value;
    return fmtCell(f, p.value);
  }

  function colDef(f, visible, ent) {
    const numeric = f.type === 'money' || f.type === 'number';
    const isDate = f.type === 'date' || f.type === 'datetime';
    const d = {
      colId: f.key, headerName: f.label, headerTooltip: f.group + ': ' + f.label, hide: !visible,
      valueGetter: p => (p.data ? f.get(p.data) : undefined),
      valueFormatter: p => fmtCell(f, p.value),
      getQuickFilterText: p => fmtCell(f, p.value),
      cellDataType: false, sortable: true, resizable: true,
      enableRowGroup: true, enablePivot: true, enableValue: numeric,
      filterParams: { buttons: ['reset'] }
    };
    if (numeric) {
      d.filter = 'agNumberColumnFilter';
      d.type = 'rightAligned';
      d.useValueFormatterForExport = false;
      if (f.type === 'money') d.aggFunc = 'sum';
    } else if (isDate) {
      d.filter = 'agDateColumnFilter';
      d.filterParams = { buttons: ['reset'], comparator: (filterDate, cell) => { if (!(cell instanceof Date)) return -1; const x = dayStart(cell); return x < filterDate ? -1 : x > filterDate ? 1 : 0; } };
      d.keyCreator = p => (p.value instanceof Date ? (f.type === 'date' ? isoDay(p.value) : fmtDate(p.value)) : '');
    } else if (f.type === 'enum') {
      d.filter = ent ? 'agSetColumnFilter' : 'agTextColumnFilter';
      if (ent) d.filterParams = { buttons: ['reset'], valueFormatter: p => (isEmpty(p.value) ? '(Blank)' : String(p.value)) };
    } else {
      d.filter = ent ? 'agMultiColumnFilter' : 'agTextColumnFilter';
    }
    if (f.link) {
      d.cellRenderer = p => {
        const text = p.valueFormatted != null ? p.valueFormatted : (p.value == null ? '' : String(p.value));
        const href = p.data && f.link(p.data);
        if (!href || !text) return text;
        const a = document.createElement('a');
        a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = text;
        return a;
      };
    }
    return d;
  }

  function gridOptions(fields, ent) {
    const v = state.view;
    const visible = new Set(v.columns);
    // The grid treats a starting state without column visibility as "show every column",
    // so visibility is always stated, from the view's chosen columns.
    const initial = v.gridState ? cleanState(v.gridState)
      : (v.sort && v.sort.key ? { sort: { sortModel: [{ colId: v.sort.key, sort: v.sort.dir < 0 ? 'desc' : 'asc' }] } } : {});
    initial.columnVisibility = { hiddenColIds: fields.filter(f => !visible.has(f.key)).map(f => f.key) };
    if (!v.gridState) initial.columnOrder = { orderedColIds: v.columns.concat(fields.map(f => f.key).filter(k => !visible.has(k))) };
    const opts = {
      theme: 'legacy',
      columnDefs: fields.map(f => colDef(f, visible.has(f.key), ent)),
      rowData: state.data ? state.data.rows : [],
      defaultColDef: { minWidth: 90 },
      autoSizeStrategy: v.gridState ? undefined : { type: 'fitCellContents' },
      initialState: initial,
      pagination: true, paginationPageSize: 100, paginationPageSizeSelector: [50, 100, 500, 1000],
      domLayout: 'autoHeight',
      tooltipShowDelay: 300,
      suppressMenuHide: true,
      overlayNoRowsTemplate: state.data ? 'No rows match these filters.' : 'Press Run to load data.',
      isExternalFilterPresent: () => hasConds(state.view.filters),
      doesExternalFilterPass: node => !node.data || evalNode(state.view.filters, node.data, grid.fmap),
      onModelUpdated: () => updateCount(),
      onStateUpdated: e => {
        if (!grid.api || e.api !== grid.api) return;
        const meaningful = (e.sources || []).some(x => !QUIET_SOURCES.has(x));
        state.view.gridState = cleanState(e.state);
        state.view.columns = grid.api.getColumnState().filter(c => !c.hide && grid.fmap.has(c.colId)).map(c => c.colId);
        if (meaningful) markDirty();
      },
      defaultExcelExportParams: { processCellCallback: exportCell },
      defaultCsvExportParams: { processCellCallback: exportCell },
      processCellForClipboard: exportCell,
      getContextMenuItems: p => {
        const items = [];
        const href = p.node && p.node.data && invLink(p.node.data);
        if (href) items.push({ name: 'Open invoice in a new tab', action: () => window.open(href, '_blank', 'noopener') });
        if (items.length) items.push('separator');
        return items.concat(['copy', 'copyWithHeaders', 'separator', 'export']);
      }
    };
    if (ent) Object.assign(opts, {
      sideBar: { toolPanels: [
        { id: 'columns', labelDefault: 'Columns', labelKey: 'columns', iconKey: 'columns', toolPanel: 'agColumnsToolPanel' },
        { id: 'filters', labelDefault: 'Filters', labelKey: 'filters', iconKey: 'filter', toolPanel: 'agFiltersToolPanel' }] },
      rowGroupPanelShow: 'always',
      groupDisplayType: 'singleColumn',
      grandTotalRow: 'bottom',
      alwaysAggregateAtRootLevel: true,
      suppressAggFuncInHeader: true,
      cellSelection: true,
      statusBar: { statusPanels: [{ statusPanel: 'agTotalAndFilteredRowCountComponent', align: 'left' }, { statusPanel: 'agAggregationComponent' }] }
    });
    return opts;
  }

  function destroyGrid() {
    const api = grid.api;
    grid.api = null;
    if (api) { try { api.destroy(); } catch (e) { /* ignore */ } }
    grid.el = null;
  }

  function buildGrid() {
    if (!state.root) return;
    destroyGrid();
    const box = state.root.querySelector('[data-part="grid"]');
    box.innerHTML = '';
    const fields = allFields();
    grid.fmap = new Map(fields.map(f => [f.key, f]));
    const lib = gridLib();
    if (!lib) { grid.mode = 'plain'; grid.error = 'Halaxy\'s table builder (HxGridTable) is not on this page'; renderPlain(); return; }
    const make = ent => {
      box.innerHTML = '';
      const el = document.createElement('div');
      el.id = 'hxr-grid';
      el.className = 'my-grid ag-theme-alpine hxr-grid';
      box.appendChild(el);
      grid.el = el;
      // isInDetailsRow: Halaxy merges its defaults and creates the grid, but skips its header
      // menu, saved size preferences and page-wide button bindings.
      const inst = new lib({
        gridContainerSelector: '#hxr-grid', cssSelector: '#hxr-grid', pageUID: '@urmstonphysio/custom-reports',
        isInDetailsRow: true, datePrefs: { dateFormat: 'd-M-Y', timeFormat: 'H:i' },
        gridOptions: gridOptions(fields, ent)
      });
      grid.api = inst.agGrid;
      if (!grid.api || typeof grid.api.forEachNodeAfterFilter !== 'function') throw new Error('HxGridTable did not return a grid');
    };
    try {
      make(true);
      if (grid.el.querySelector('.ag-side-bar')) { grid.mode = 'advanced'; grid.error = ''; }
      else { destroyGrid(); make(false); grid.mode = 'standard (advanced features not available)'; }
    } catch (e) {
      console.error('[Custom Reports] grid', e);
      destroyGrid();
      grid.mode = 'plain'; grid.error = e.message;
      renderPlain();
    }
    const q = state.root.querySelector('[data-a="quick"]');
    if (q && q.value) quickFilter(q.value);
    updateCount();
  }

  function refreshFilter() {
    if (grid.api) grid.api.onFilterChanged();
    else renderPlain();
  }
  function quickFilter(text) {
    if (grid.api) grid.api.setGridOption('quickFilterText', text);
    else renderPlain();
  }
  function matchingRows() {
    if (!state.data) return [];
    if (grid.api) { const out = []; grid.api.forEachNodeAfterFilter(n => { if (n.data) out.push(n.data); }); return out; }
    return plainRows();
  }
  function updateCount() {
    if (!state.data || !state.root) return;
    const shown = matchingRows().length;
    setStatus(shown + ' of ' + state.data.rows.length + ' rows match · loaded ' +
      state.data.loadedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + ' in ' + Math.round(state.data.ms / 100) / 10 + 's');
  }

  function exportData() {
    const name = 'custom-report-' + (state.view.name || state.view.source).replace(/[^\w-]+/g, '-').toLowerCase() + '-' + isoDay(new Date());
    if (!state.data) { setStatus('Run the report first, then export.'); return; }
    if (grid.api && grid.mode === 'advanced') { grid.api.exportDataAsExcel({ fileName: name + '.xlsx' }); return; }
    if (grid.api) { grid.api.exportDataAsCsv({ fileName: name + '.csv' }); return; }
    const cols = state.view.columns.map(k => grid.fmap.get(k)).filter(Boolean);
    const q = x => '"' + String(x ?? '').replace(/"/g, '""') + '"';
    const csv = [cols.map(f => q(f.label)).join(',')].concat(plainRows().map(r => cols.map(f => q(f.type === 'money' ? (f.get(r) ?? '') : fmtCell(f, f.get(r)))).join(','))).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = name + '.csv';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // Plain table: used only if Halaxy's grid can't be created.
  function sortVal(f, val) {
    if (isEmpty(val)) return null;
    if (val instanceof Date) return val.getTime();
    if (f.type === 'money' || f.type === 'number') return +val;
    return String(val).toLowerCase();
  }
  function plainRows() {
    if (!state.data) return [];
    const v = state.view;
    const term = ((state.root && state.root.querySelector('[data-a="quick"]').value) || '').trim().toLowerCase();
    const cols = v.columns.map(k => grid.fmap.get(k)).filter(Boolean);
    let rows = state.data.rows.filter(r => evalNode(v.filters, r, grid.fmap));
    if (term) rows = rows.filter(r => cols.some(f => fmtCell(f, f.get(r)).toLowerCase().includes(term)));
    const sf = v.sort && grid.fmap.get(v.sort.key);
    if (sf) {
      const dir = v.sort.dir || 1;
      rows = rows.map(r => ({ r, s: sortVal(sf, sf.get(r)) })).sort((a, b) => {
        if (a.s === null && b.s === null) return 0;
        if (a.s === null) return 1;
        if (b.s === null) return -1;
        return (a.s < b.s ? -1 : a.s > b.s ? 1 : 0) * dir;
      }).map(x => x.r);
    }
    return rows;
  }
  function renderPlain() {
    if (!state.root) return;
    const box = state.root.querySelector('[data-part="grid"]');
    const v = state.view;
    const cols = v.columns.map(k => grid.fmap.get(k)).filter(Boolean);
    const rows = plainRows();
    const shown = rows.slice(0, 2000);
    const sums = cols.map(f => f.type === 'money' ? rows.reduce((s, r) => s + (+f.get(r) || 0), 0) : null);
    box.innerHTML = '<div class="hxr-plain"><table class="table table-sm table-striped"><thead><tr>' +
      cols.map(f => '<th data-k="' + esc(f.key) + '" class="' + (f.type === 'money' || f.type === 'number' ? 'num' : '') + '">' + esc(f.label) + (v.sort && v.sort.key === f.key ? (v.sort.dir > 0 ? ' ▲' : ' ▼') : '') + '</th>').join('') +
      '</tr></thead><tbody>' +
      (state.data ? (shown.length ? shown.map(r => '<tr>' + cols.map(f => {
        let html = esc(fmtCell(f, f.get(r)));
        const href = f.link && f.link(r);
        if (href && html) html = '<a href="' + esc(href) + '" target="_blank" rel="noopener">' + html + '</a>';
        return '<td class="' + (f.type === 'money' || f.type === 'number' ? 'num' : '') + '">' + html + '</td>';
      }).join('') + '</tr>').join('') : '<tr><td colspan="' + Math.max(1, cols.length) + '">No rows match these filters.</td></tr>') : '') +
      '</tbody>' + (state.data && sums.some(x => x !== null) ? '<tfoot><tr>' + sums.map((x, i) => '<td class="' + (x !== null ? 'num' : '') + '"><strong>' + (x !== null ? esc(gbp(x)) : i === 0 ? 'Total' : '') + '</strong></td>').join('') + '</tr></tfoot>' : '') +
      '</table></div>';
    box.querySelectorAll('th').forEach(th => th.addEventListener('click', () => {
      const k = th.dataset.k;
      v.sort = { key: k, dir: v.sort && v.sort.key === k ? -v.sort.dir : 1 };
      markDirty(); renderPlain();
    }));
    updateCount();
  }

  function renderAll() {
    renderViewsSelect();
    renderSource();
    renderFilters();
    buildGrid();
    const notes = state.root.querySelector('.hxr-notes');
    notes.textContent = state.data && state.data.notes.length ? state.data.notes.join('\n') : '';
  }

  // Structure and counts only. No patient data. Safe to paste into a chat.
  function diagnostics() {
    const d = state.diag;
    const lines = ['CUSTOM REPORTS DIAGNOSTICS v' + VERSION + ' (structure and counts only)', 'Menu: ' + d.menu, 'Page container: ' + d.container,
      'Table: ' + grid.mode + (grid.error ? ' (' + grid.error + ')' : '') + ' | HxGridTable on page: ' + (gridLib() ? 'yes' : 'no'),
      'Page context: Hk=' + (typeof window.Hk) + ', jQuery=' + (typeof window.jQuery) + ', HxGridTable=' + (typeof window.HxGridTable)];
    if (d.lastRun) Object.entries(d.lastRun).forEach(([k, v]) => lines.push(k + ': ' + (typeof v === 'object' ? JSON.stringify(v) : v)));
    else lines.push('No run yet.');
    if (state.data && state.data.notes.length) lines.push('Notes: ' + state.data.notes.join(' | '));
    const text = lines.join('\n');
    setStatus(text);
    try { navigator.clipboard.writeText(text).catch(() => { /* clipboard not allowed; text is on screen */ }); } catch (e) { /* ignore */ }
  }

  // ======================================================================
  // Halaxy integration: menu item and page
  // ======================================================================
  function addMenuItem() {
    const menu = document.getElementById('mainMenu');
    if (!menu) { state.diag.menu = 'sidebar #mainMenu not found'; return false; }
    if (menu.querySelector('.hxr-menu')) return true;
    const href = HOST_PATH + '#' + ROUTE;
    const items = [...menu.querySelectorAll('.mainmenu-item')];
    const reports = items.find(li => /^reports?$/i.test(txt(li.querySelector('.mainmenu-link-label') || li.querySelector('.mainmenu-link'))));
    const sub = reports && reports.querySelector('a.mainmenu-sublink');
    if (sub) {
      const host = sub.parentElement && sub.parentElement.tagName === 'LI' ? sub.parentElement : sub;
      const copy = host.cloneNode(true);
      copy.removeAttribute('id');
      copy.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
      const a = copy.tagName === 'A' ? copy : copy.querySelector('a.mainmenu-sublink');
      a.setAttribute('href', href);
      a.removeAttribute('onclick');
      a.classList.remove('active');
      a.classList.add('hxr-menu');
      a.textContent = 'Custom Reports';
      host.parentNode.appendChild(copy);
      state.diag.menu = 'added under Reports';
      return true;
    }
    const first = items[0];
    if (first && first.parentNode) {
      const li = document.createElement(first.tagName.toLowerCase());
      li.className = 'mainmenu-item';
      li.innerHTML = '<a class="mainmenu-link hxr-menu" href="' + esc(href) + '"><span class="mainmenu-link-label">Custom Reports</span></a>';
      first.parentNode.appendChild(li);
      state.diag.menu = 'added as its own item (Reports group not found)';
      return true;
    }
    state.diag.menu = 'menu items not found';
    return false;
  }

  const undo = [];
  function hideEl(n) { const prev = n.style.display; undo.push(() => { n.style.display = prev; }); n.style.display = 'none'; }
  function mount() {
    if (state.mounted) return;
    css();
    state.root = shell();
    const content = document.getElementById('pageContent');
    if (content) {
      [...content.children].forEach(n => { if (!['SCRIPT', 'STYLE', 'LINK', 'TEMPLATE'].includes(n.tagName)) hideEl(n); });
      content.appendChild(state.root);
      const tt = document.getElementById('toolbar-text');
      if (tt) {
        const h = tt.querySelector('h1,h2,h3') || tt;
        const before = h.innerHTML;
        undo.push(() => { h.innerHTML = before; });
        h.textContent = 'Custom Reports';
      }
      const tr = document.getElementById('toolbar-right');
      if (tr) [...tr.children].forEach(hideEl);
      state.diag.container = '#pageContent, Halaxy toolbar reused';
    } else {
      const host = document.querySelector('.layout-wrapper') || document.querySelector('.layout-container') || document.body;
      [...host.children].forEach(n => {
        const keep = n.id === 'headerWrapper' || n.id === 'mainMenu' || n.id === 'footer' || (n.querySelector && (n.querySelector('#headerWrapper') || n.querySelector('#mainMenu'))) || ['SCRIPT', 'STYLE', 'LINK'].includes(n.tagName);
        if (!keep) hideEl(n);
      });
      host.appendChild(state.root);
      state.diag.container = 'fallback container (#pageContent not found)';
    }
    state.mounted = true;
    const title = document.title;
    undo.push(() => { document.title = title; });
    document.title = 'Custom Reports | Halaxy';
    document.querySelectorAll('.hxr-menu').forEach(a => a.classList.add('active'));
    const m = location.hash.match(new RegExp('^#' + ROUTE + '=(.+)$'));
    const fromLink = m && decodeView(m[1]);
    state.view = normaliseView(fromLink || lsGet(LAST_KEY, null) || clone(STARTERS[0]));
    state.savedName = null;
    renderAll();
    if (fromLink) setStatus('Opened "' + (state.view.name || 'shared view') + '" from a link. Press Run.');
  }
  function unmount() {
    if (!state.mounted) return;
    destroyGrid();
    while (undo.length) undo.pop()();
    state.root.remove();
    state.root = null;
    state.mounted = false;
    document.querySelectorAll('.hxr-menu').forEach(a => a.classList.remove('active'));
  }
  const isRoute = () => location.hash === '#' + ROUTE || location.hash.startsWith('#' + ROUTE + '=');
  function route() { if (isRoute()) mount(); else unmount(); }

  // ======================================================================
  // Start
  // ======================================================================
  function start() {
    if (!addMenuItem()) {
      const mo = new MutationObserver(() => { if (addMenuItem()) mo.disconnect(); });
      mo.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => mo.disconnect(), 15000);
    }
    window.addEventListener('hashchange', route);
    route();
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);

  // Exposed only in test mode (?hxtest=1), never during normal use.
  if (/[?&]hxtest=1\b/.test(location.search)) window.__hxReportsTest = { state, grid, evalNode, periodRange, encodeView, decodeView, buildPatients, sniffType, run };
})();
