// ==UserScript==
// @name         Halaxy review requests (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.3.2
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/review-requests.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/review-requests.user.js
// @description  Patients > Review requests (Carl only): patients who have finished treatment with a good outcome in their notes or Progress Update form, ready to be sent the Review Request follow-up. Send it or mark "No review request" from the list, after confirming.
// @match        https://*.halaxy.com/a/pr/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * Review requests (agreed with Carl, 10 Nov 2026).
 *
 *  - Finished, asked while it's fresh (Carl, 10 Nov 2026: "2 to 8 weeks is a long time"): nothing
 *    booked, the last appointment wasn't cancelled or missed, and either the last notes say treatment
 *    has finished ("discharged", "goals met", "self-managing", "see as needed"), from the day after
 *    that visit, or 2 weeks have passed with nothing booked. Nobody last seen over 4 weeks ago.
 *    One calendar request for everyone.
 *  - Left out: anyone with a "Review Request" follow-up already (Tasks & Follow-Ups, one request),
 *    anyone labelled "No review request", under-16s, and anyone with an unpaid invoice of their own.
 *  - Good outcome: the latest Progress Update form ("How have your symptoms changed ... -5 to 5":
 *    +4 or +5) and phrases in the last two clinical notes ("100% better", "pain-free", "back to
 *    running", "goals met", "discharged" ...). Phrases such as "not 100%", "worse", "flare-up",
 *    "referred to GP" count against. Notes are read in the browser only: what's kept is the patient,
 *    the dates and which kinds of phrase matched, never the note text.
 *  - Send review request: Halaxy's Add Follow-Up with the Review Request template, by email, now.
 *    Don't ask: adds the "No review request" label on the patient's Edit page. Both ask first.
 *  - Shown only to Carl (by Halaxy sign-in). The menu count is refreshed at most every 12 hours in the
 *    visible tab, shared across tabs, skipped while Halaxy has asked scripts to pause. Each patient's
 *    result is kept for a week, so only newly finished patients are read again.
 */
(() => {
  'use strict';
  if (window.__hxReviewRequests) return;
  window.__hxReviewRequests = true;

  const VERSION = '0.3.2';
  const ROUTE = 'upc-review-requests';
  const MENU_CLS = 'upc-rr-menu';
  const ALLOWED = ['Carl Healy'];          // Carl, 10 Nov 2026: just me for now
  const TEMPLATE = 'Review Request';       // follow-up template and email template
  const LABEL = 'No review request';
  const DAY = 86400e3;
  const SAID_DAYS = 1, QUIET_DAYS = 14, MAX_DAYS = 28, MIN_AGE = 16;
  const FINISHED = ['discharged', 'goals met', 'self-managing'];   // phrase kinds that say treatment has finished
  const REFRESH_EVERY = 12 * 3600e3, PAGE_FRESH = 30 * 60e3, KEEP = 7 * DAY;
  const KEY = 'upc-rr:';

  const U = () => window.UPC;
  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(KEY + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
  };
  const label = (ms) => U().dayLabel(ms);
  const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

  function userName() {
    const h = window.HkUser || {};
    const named = String(h.pracName || (h.CalendarDefault || {}).pracName || '').trim();
    if (named) return named;
    const el = [...document.querySelectorAll('header *, nav *, .navbar *, #top *')]
      .find((e) => !e.children.length && ALLOWED.some((n) => n.toLowerCase() === e.textContent.trim().toLowerCase()));
    return el ? el.textContent.trim() : '';
  }
  const allowed = () => ALLOWED.some((n) => n.toLowerCase() === userName().toLowerCase());

  // ------------------------------------------------------------------ reading the notes

  // Kinds of phrase. Only these names are kept, never the words found.
  const GOOD = [
    ['100% better', /\b100\s*%\s*(better|improved|recovered|fine|resolved)|\bfully (recovered|resolved|better)|\bcompletely (better|recovered|resolved|pain[- ]?free)/i],
    ['pain-free', /\bpain[- ]?free\b|\bno (more |further )?(pain|symptoms)\b|\bsymptom[- ]?free\b|\bresolved\b/i],
    ['back to sport or work', /\b(back|returned|return(ed)?)( fully)? to (running|run|football|rugby|netball|hockey|cycling|the gym|gym|sport|sports|training|full training|tennis|golf|swimming|climbing|dancing|yoga|work|full duties|normal activities)\b/i],
    ['race or event done', /\b(ran|completed|finished|did)\b(\s+[\w'-]+){0,3}?\s+(race|marathon|half marathon|half|10k|5k|parkrun|ultra|triathlon)\b/i],
    ['goals met', /\bgoals? (met|achieved|reached)\b|\bachieved (all )?(his |her |their )?goals?\b/i],
    ['discharged', /\bdischarg(ed|e)\b|\bno (further|more) (treatment|physio|physiotherapy|sessions?|appointments?) (needed|required|necessary)\b|\bsee (as|when) (needed|required)\b|\bprn\b|\bsos\b/i],
    ['self-managing', /\bself[- ]?manag|\bindependent(ly)? (with|managing)|\bcontinue (with )?(home )?(exercises|hep|programme|program) independently\b/i],
  ];
  const NICE = [
    ['very happy', /\b(really|very|so) (pleased|happy)\b|\bdelighted\b|\bthrilled\b|\bfeeling great\b|\bmuch better\b|\b(massive|huge|great|significant)(ly)? (improvement|progress|improved)\b/i],
    ['thanks', /\bthank(s| you)\b/i],
    ['low pain score', /\b[01]\s*\/\s*10\b|\bnprs:?\s*[01]\b|\bvas:?\s*[01]\b/i],
  ];
  // Against: only what says this course went badly or isn't over. Notes describe symptoms all the time
  // ("worse on stairs", "no need for a scan"), so plain mentions don't count (live list, 10 Nov 2026).
  const RULES = 2;   // bump when the phrase lists change, so patients are read again
  const BAD = [
    ['not fully better', /\bnot (yet )?(100\s*%|fully|completely|quite)\s*(better|recovered|resolved|right|there|improved|pain[- ]?free)\b|\bno (better|improvement)\b|\bslow progress\b|\bminimal (change|improvement)\b/i],
    ['worse or flare-up', /\b(getting|feeling|feels|felt|been|is|was|now|much|slightly) worse\b|\b(has|have) (got|gotten|become) worse\b|\bworsen(ed|ing)\b|\b(had|having|has had|another) (a )?flare[- ]?up\b|\bflared( up)?\b|\bstill (painful|sore|struggling|symptomatic)\b|\bdeteriorat/i],
    ['referred on', /\b(re-?)?refer(red|ral)? (back )?(on(ward)? )?(to|for) (the |a |an |his |her |their )?(gp|doctor|consultant|orthopaedic|ortho|surgeon|specialist|msk|cats|mri|scan|x-?ray|ultrasound|injection|a&e|hospital|rheumatolog\w*|podiatr\w*)\b|\bonward referral\b|\bawaiting (an? |his |her |their )?(mri|scan|x-?ray|surgery|operation|consultant|injection|results)\b/i],
    ['unhappy or cost', /\bunhappy\b|\bdissatisfied\b|\bcomplain|\bcan(no|')t afford\b|\btoo expensive\b/i],
  ];
  const NEGATION = /\b(not|no longer|never|isn'?t|wasn'?t|hasn'?t|without|unable to)\b[^.]{0,20}$/i;
  function phrases(text) {
    const found = { good: [], nice: [], bad: [] };
    const scan = (list, into, negatable) => list.forEach(([name, re]) => {
      const g = new RegExp(re.source, 'gi');
      let m;
      while ((m = g.exec(text))) {
        if (negatable && NEGATION.test(text.slice(Math.max(0, m.index - 30), m.index))) continue;
        if (!into.includes(name)) into.push(name);
        break;
      }
    });
    scan(GOOD, found.good, true);
    scan(NICE, found.nice, true);
    scan(BAD, found.bad, true);
    return found;
  }
  const scoreFrom = (answer) => { const m = /^\s*([+-]?\d+)/.exec(String(answer || '')); return m ? +m[1] : null; };

  // ------------------------------------------------------------------ the check

  async function calendar(fromMs, toMs, say) {
    say('Reading the calendar...');
    const pracs = await U().http.json('/lookup/practitioner?clinic=&include_id=&type=');
    const qs = new URLSearchParams({ start: Math.floor(fromMs / 1000), end: Math.floor(toMs / 1000) });
    (Array.isArray(pracs) ? pracs : []).forEach((p, i) => qs.append('practitioners[' + i + '][id]', p.id));
    const cal = await U().http.json('/calendar/json?' + qs.toString());
    return ((cal && cal.payload && cal.payload.events) || []).filter((e) => e.type === 'appointment' && e.linkPaGId);
  }

  // One patient: read notes and the latest Progress Update form; then (only if it looks good) labels, age and invoices.
  async function assess(p, say) {
    say('Reading ' + p.name + '\'s notes...');
    const items = await U().notes.items(p.id);
    const since = p.firstSeen - 7 * DAY;
    const out = { good: [], nice: [], bad: [], progress: null, why: '', links: [] };   // links: the notes and form read, to check before sending
    const form = items.find((x) => x.category === 'form' && /progress update/i.test(x.label) && (x.date === null || x.date >= since));
    if (form) {
      const q = (await U().forms.answers(form.id)).find((a) => /symptoms changed/i.test(a.question));
      out.progress = q ? scoreFrom(q.answer) : null;
      out.links.push({ kind: 'form', id: form.id, date: form.date });
    }
    const recent = items.filter((x) => x.noteId && x.entity === 'note' && (x.category === 'appointment' || x.category === 'note') && (x.date === null || x.date >= since)).slice(0, 2);
    recent.forEach((n) => out.links.unshift({ kind: 'note', id: n.noteId, date: n.date }));
    for (const n of recent) {
      const f = phrases(await U().notes.text(n.noteId));
      ['good', 'nice', 'bad'].forEach((k) => f[k].forEach((x) => { if (!out[k].includes(x)) out[k].push(x); }));
    }
    if (out.progress !== null) {
      if (out.progress >= 4) out.good.unshift('Progress Update +' + out.progress);
      else if (out.progress <= 1) out.bad.unshift('Progress Update ' + (out.progress > 0 ? '+' : '') + out.progress);
    }
    out.verdict = out.good.length && !out.bad.length ? 'ready' : (out.good.length || out.nice.length) ? 'maybe' : 'none';
    if (out.verdict === 'none') return out;
    // Worth asking: check the label, age and money owed.
    const d = await U().patient.details(p.id);
    if (JSON.stringify(d.userLabels || []).toLowerCase().includes(LABEL.toLowerCase())) { out.verdict = 'left'; out.why = 'labelled ' + LABEL; return out; }
    const dob = U().parseDay(d.dob) !== null ? U().parseDay(d.dob) : Date.parse(d.dob);
    if (dob && !isNaN(dob) && Date.now() - dob < MIN_AGE * 365.25 * DAY) { out.verdict = 'left'; out.why = 'under ' + MIN_AGE; return out; }
    const owes = (await U().patient.invoices(p.id)).some((r) => /not yet paid|part/i.test(String(r.status || '')) && Number(String(r.balance).replace(/[^\d.-]/g, '')) > 0);
    if (owes) { out.verdict = 'left'; out.why = 'has an unpaid invoice'; }
    return out;
  }

  async function check(say) {
    say = say || (() => {});
    const now = Date.now(), day0 = today();
    const cache = store.get('cache', {});
    say('Reading Tasks & Follow-Ups...');
    const asked = new Set((await U().followUps.list()).filter((r) => new RegExp('^' + TEMPLATE + '$', 'i').test(U().clean(r.title))).map((r) => r.linkPaGId));
    const events = await calendar(day0 - (MAX_DAYS + 120) * DAY, day0 + 120 * DAY, say);
    const startMs = (e) => (typeof e.start === 'number' ? e.start * 1000 : Date.parse(e.start));
    const byPatient = new Map();
    events.forEach((e) => {
      const id = String(e.linkPaGId);
      if (!byPatient.has(id)) byPatient.set(id, []);
      byPatient.get(id).push(e);
    });
    const counts = { asked: 0, left: 0, none: 0, ended: 0, soon: 0 };
    const rows = [];
    const fresh = (r) => r && now - r.at <= KEEP && r.links && r.rules === RULES;
    const toRead = [...byPatient.values()].filter((evs) => { const last = evs.filter((e) => startMs(e) < now && !e.appointmentStatus).map(startMs); return last.length && Math.max(...last) >= now - MAX_DAYS * DAY; }).length;
    let read = 0;
    for (const [id, evs] of byPatient) {
      const past = evs.filter((e) => startMs(e) < now).sort((a, b) => startMs(b) - startMs(a));
      const attended = past.filter((e) => !e.appointmentStatus);
      const booked = evs.some((e) => startMs(e) >= now && !/cancel|reject|declin|did-not-attend/i.test(e.appointmentStatus || ''));
      if (!attended.length || booked) continue;
      const lastSeen = startMs(attended[0]);
      if (lastSeen > now - SAID_DAYS * DAY || lastSeen < now - MAX_DAYS * DAY) continue;
      if (past[0] && past[0].appointmentStatus) { counts.ended++; continue; }   // finished on a cancellation or missed appointment
      if (asked.has(id)) { counts.asked++; continue; }
      const name = U().clean(U().htmlDoc(attended[0].title || '').body.textContent).replace(/^[\s*★]+/, '') || 'Patient';
      const p = { id, name, lastSeen, firstSeen: startMs(attended[attended.length - 1]) };
      const ck = id + '|' + lastSeen;
      let r = cache[ck];
      read++;
      if (!fresh(r)) {
        const tell = (t) => say(t.replace(/\.\.\.$/, '') + ' (' + read + ' of about ' + toRead + ')...');
        try { r = Object.assign({ at: now, rules: RULES }, await assess(p, tell)); } catch (e) { r = { at: now, verdict: 'error', why: e.message || String(e), good: [], nice: [], bad: [] }; if (/has changed/.test(r.why)) tellHealthCheck(e); }
        if (r.verdict !== 'error') { cache[ck] = r; store.set('cache', cache); }   // kept as it goes, so a check that's stopped isn't wasted
      }
      if (r.verdict === 'none') { counts.none++; continue; }
      if (r.verdict === 'left') { counts.left++; continue; }
      // Seen in the last 2 weeks: only once the notes say treatment has finished (they may still book).
      if (lastSeen > now - QUIET_DAYS * DAY && !(r.good || []).some((x) => FINISHED.includes(x))) { counts.soon++; continue; }
      rows.push(Object.assign({ id, name, lastSeen }, r));
    }
    Object.keys(cache).forEach((k) => { if (now - cache[k].at > KEEP) delete cache[k]; });
    store.set('cache', cache);
    const order = { ready: 0, maybe: 1, error: 2 };
    rows.sort((a, b) => order[a.verdict] - order[b.verdict] || b.lastSeen - a.lastSeen);
    const result = { at: Date.now(), by: VERSION, ready: rows.filter((x) => x.verdict === 'ready').length, rows, counts };
    store.set('result', result);
    return result;
  }

  function tellHealthCheck(e) {
    const message = (e && e.message) || String(e);
    if (!/has changed/.test(message)) return;
    document.dispatchEvent(new CustomEvent('upc-loader-error', { detail: JSON.stringify({ file: 'review-requests.user.js', message }) }));
  }

  // ------------------------------------------------------------------ menu count

  // One check at a time across tabs. The checking tab renews its claim as it goes, so a tab that was
  // closed or reloaded mid-check only holds things up for 2 minutes.
  const locked = () => Date.now() - store.get('running', 0) < 2 * 60e3;
  async function checkLocked(say) {
    store.set('running', Date.now());
    const beat = (t) => { store.set('running', Date.now()); store.set('progress', t); if (say) say(t); };
    try { return await check(beat); } finally { store.set('running', 0); store.set('progress', ''); }
  }
  async function refreshCount() {
    if (!allowed() || document.visibilityState !== 'visible' || !U() || U().http.pausedFor() > 0 || locked()) return;
    const last = store.get('result', null);
    if (last && Date.now() - last.at < REFRESH_EVERY) return;
    try { await checkLocked(); } catch (e) { console.warn('[UPC review requests]', e); tellHealthCheck(e); }
    paintBadge();
  }
  function paintBadge() {
    const a = document.querySelector('a.' + MENU_CLS);
    if (!a) return;
    const r = store.get('result', null);
    const n = r ? r.rows.filter((x) => x.verdict === 'ready' && !done.has(x.id)).length : 0;
    let b = a.querySelector('.upc-rr-badge');
    if (!n) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('span'); b.className = 'upc-rr-badge'; a.appendChild(b); }
    const text = String(n);
    if (b.textContent !== text) b.textContent = text;
  }

  // ------------------------------------------------------------------ page

  const CSS = `
    .upc-rr-badge { display: inline-block; min-width: 18px; margin-left: 6px; padding: 0 5px; border-radius: 9px; font-size: .75em; line-height: 18px;
      text-align: center; font-weight: 600; color: #fff; background: var(--vs-notification-badge-bg-color, #ec6b65); vertical-align: middle; }
    .upc-rr { max-width: 1200px; }
    .upc-rr h1 { margin: 0 0 16px; }
    .upc-rr .card { margin-bottom: 24px; }
    .upc-rr .card-header h2 { margin: 0; }
    .upc-rr .upc-rr-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-bottom: 12px; }
    .upc-rr .upc-rr-bar .btn, .upc-rr td .btn { margin: 0; }
    .upc-rr td.upc-rr-acts { white-space: nowrap; }
    .upc-rr td.upc-rr-acts .upc-err { display: inline-block; white-space: normal; max-width: 340px; }
    .upc-rr td.upc-rr-acts .btn + .btn { margin-left: 6px; }
    .upc-rr td.upc-rr-date, .upc-rr td.upc-rr-links { white-space: nowrap; }
    .upc-rr tr.upc-off td, .upc-rr tr.upc-off a { color: var(--vs-viewData-label-color, #6c757d); }
    .upc-rr .upc-rr-why .upc-err { display: block; }
  `;
  const state = { unmount: null, running: false, status: '', error: '' };
  const done = new Map();   // patient id -> 'sent' | 'labelled' | { error }
  let root = null;

  // Links to the notes and Progress Update form behind the suggestion, newest first, to read before sending.
  function linksHtml(r) {
    const base = U().base() + '/patient/' + encodeURIComponent(r.id) + '/clinical/category/';
    const notes = (r.links || []).filter((x) => x.kind === 'note').sort((a, b) => (b.date || 0) - (a.date || 0));
    const forms = (r.links || []).filter((x) => x.kind === 'form');
    return notes.map((x, i) => '<a href="' + esc(base + 'note/id/' + x.id) + '" target="_blank" rel="noopener">' + (i ? 'Previous note' : 'Last note') + (x.date ? ' (' + esc(label(x.date)) + ')' : '') + '</a>')
      .concat(forms.map((x) => '<a href="' + esc(base + 'intake-form-invite/id/' + x.id) + '" target="_blank" rel="noopener">Progress Update' + (x.date ? ' (' + esc(label(x.date)) + ')' : '') + '</a>'))
      .join('<br>') || '<span class="text-muted">None found</span>';
  }

  function rowHtml(r) {
    const base = U().base();
    const d = done.get(r.id);
    const why = esc((r.good || []).concat(r.nice || []).join(', ')) + ((r.bad || []).length ? '<span class="upc-err">Against: ' + esc(r.bad.join(', ')) + '</span>' : '') +
      (r.verdict === 'error' ? '<span class="upc-err">Not read: ' + esc(r.why) + '</span>' : '');
    const acts = d === 'sent' ? '<span class="upc-ok">Review request sent</span>' : d === 'labelled' ? '<span class="upc-ok">Labelled ' + esc(LABEL) + '</span>' : d === 'busy' ? '<span class="text-muted">Working...</span>'
      : (d && d.error ? '<span class="upc-err">' + esc(d.error) + '</span><br>' : '') +
        '<button type="button" class="btn btn-outline-primary-light" data-send="' + esc(r.id) + '">Send review request</button>' +
        '<button type="button" class="btn btn-outline-primary" data-skip="' + esc(r.id) + '">Don\'t ask</button>';
    return '<tr class="' + (r.verdict === 'ready' ? '' : 'upc-off') + '"><td><a href="' + esc(base + '/patient/' + r.id) + '" target="_blank" rel="noopener">' + esc(r.name) + '</a></td>' +
      '<td class="upc-rr-date">' + esc(label(r.lastSeen)) + '</td><td class="upc-rr-why">' + why + '</td><td class="upc-rr-links">' + linksHtml(r) + '</td><td class="upc-rr-acts">' + acts + '</td></tr>';
  }

  function render() {
    if (!root) return;
    const r = store.get('result', null);
    const head = '<thead><tr><th>Patient</th><th>Last visit</th><th>Why</th><th>Check first</th><th></th></tr></thead>';
    let h = '<div class="upc-rr"><h1>Review requests</h1><div class="upc-rr-bar">' +
      '<button type="button" class="btn btn-outline-primary-light" data-a="refresh"' + (state.running ? ' disabled' : '') + '>' + (state.running ? 'Checking...' : 'Check again') + '</button>' +
      '<span class="text-muted">' + esc(state.running ? state.status : r ? 'Checked at ' + new Date(r.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + ' on ' + label(r.at) + '.' : '') + '</span></div>';
    if (state.error) h += '<p class="upc-err">' + esc(state.error) + '</p>';
    if (r) {
      const ready = r.rows.filter((x) => x.verdict === 'ready'), rest = r.rows.filter((x) => x.verdict !== 'ready');
      h += '<div class="card"><div class="card-header"><h2>Good outcome (' + ready.length + ')</h2></div><div class="card-body p-0">' +
        (ready.length ? '<table class="table table-striped table-bordered w-100 m-0">' + head + '<tbody>' + ready.map(rowHtml).join('') + '</tbody></table>' : '<p class="text-muted m-3">Nobody to ask at the moment.</p>') + '</div></div>';
      if (rest.length) h += '<div class="card"><div class="card-header"><h2>Worth a look (' + rest.length + ')</h2></div><div class="card-body p-0"><table class="table table-bordered w-100 m-0">' + head + '<tbody>' + rest.map(rowHtml).join('') + '</tbody></table></div></div>';
      const c = r.counts;
      h += '<p class="text-muted">Patients with nothing booked, from the day after their last visit when the notes say treatment has finished (discharged, goals met, self-managing), ' +
        'otherwise once ' + QUIET_DAYS / 7 + ' weeks have passed, and up to ' + MAX_DAYS / 7 + ' weeks after their last visit. Left out: ' + c.asked + ' already sent a review request, ' +
        c.left + ' labelled ' + esc(LABEL) + ', under ' + MIN_AGE + ' or owing money, ' + c.ended + ' whose last appointment was cancelled or missed, ' +
        (c.soon || 0) + ' seen in the last ' + QUIET_DAYS / 7 + ' weeks whose notes don\'t say they\'ve finished, and ' + c.none + ' with no good-outcome signs in their last two notes or Progress Update form.</p>';
    }
    h += '<div class="text-muted upc-version">Review requests ' + VERSION + '</div></div>';
    root.innerHTML = h;
  }

  function confirm(title, html, yes) {
    return new Promise((resolve) => {
      let answered = false;
      const doneWith = (v) => { if (!answered) { answered = true; resolve(v); } };
      const dlg = U().ui.dialog({ title, small: true, onClose: () => doneWith(false) });
      dlg.root.setAttribute('data-upc-rr-confirm', '');
      dlg.body.innerHTML = html + '<div class="upc-actions"><button type="button" class="btn btn-outline-primary" data-c="no">Cancel</button><button type="button" class="btn btn-primary" data-c="yes">' + esc(yes) + '</button></div>';
      dlg.body.addEventListener('click', (e) => { const b = e.target.closest('[data-c]'); if (!b) return; doneWith(b.dataset.c === 'yes'); dlg.close(); });
    });
  }

  async function act(kind, id) {
    const r = (store.get('result', { rows: [] }).rows || []).find((x) => x.id === id);
    if (!r || done.get(id) === 'busy') return;
    const ok = kind === 'send'
      ? await confirm('Send review request?', '<p>Add the ' + esc(TEMPLATE) + ' follow-up for ' + esc(r.name) + ', by email, in about 10 minutes?</p><p class="text-muted">It\'s added through Halaxy\'s Add Follow-Up with your ' + esc(TEMPLATE) + ' template, and shows in Tasks &amp; Follow-Ups.</p>', 'Send review request')
      : await confirm('Don\'t ask?', '<p>Add the label "' + esc(LABEL) + '" to ' + esc(r.name) + '?</p><p class="text-muted">It\'s added on their Edit page, with everything else left as it is, and they won\'t be suggested again.</p>', 'Add label');
    if (!ok) return;
    done.set(id, 'busy');
    render();
    try {
      if (kind === 'send') { await U().followUps.add(id, { template: TEMPLATE }); done.set(id, 'sent'); }
      else { await U().patient.addLabel(id, LABEL); done.set(id, 'labelled'); }
    } catch (e) {
      done.set(id, { error: e.message || String(e) });
      tellHealthCheck(e);
    }
    render();
    paintBadge();
  }

  async function run() {
    if (state.running) return;
    state.running = true;
    state.error = '';
    state.status = 'Checking...';
    render();
    try {
      if (locked()) {
        const t0 = Date.now();
        while (locked() && Date.now() - t0 < 30 * 60e3) {
          state.status = 'Checking in another tab: ' + (store.get('progress', '') || 'starting...');
          render();
          await U().sleep(1500);
        }
        const r = store.get('result', null);
        if (!r || Date.now() - r.at > PAGE_FRESH) await checkLocked((t) => { state.status = t; render(); });
      } else {
        await checkLocked((t) => { state.status = t; render(); });
      }
    } catch (e) {
      state.error = 'Could not check: ' + (e.message || e);
      tellHealthCheck(e);
    }
    state.running = false;
    render();
    paintBadge();
  }

  function styles() {
    if (document.getElementById('upc-review-requests-css')) return;
    const st = document.createElement('style');
    st.id = 'upc-review-requests-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  function mount() {
    if (state.unmount || !allowed()) return;
    styles();
    U().ui.nativeStyles();
    root = document.createElement('div');
    root.className = 'upc-native';
    root.setAttribute('data-upc-review-requests', '');
    root.addEventListener('click', (e) => {
      if (e.target.closest('[data-a=refresh]')) run();
      const s = e.target.closest('[data-send]');
      if (s) act('send', s.dataset.send);
      const k = e.target.closest('[data-skip]');
      if (k) act('skip', k.dataset.skip);
    });
    state.unmount = U().ui.mountPage('Review requests', root, MENU_CLS);
    render();
    const r = store.get('result', null);
    if (!r || Date.now() - r.at > PAGE_FRESH || r.by !== VERSION) run();
  }
  function unmount() {
    if (!state.unmount) return;
    state.unmount();
    state.unmount = null;
    root = null;
  }
  const route = () => (location.hash === '#' + ROUTE ? mount() : unmount());

  function start() {
    if (!U()) { console.error('[UPC review requests] needs the core library'); return; }
    if (!allowed()) return;
    styles();
    // Under Patients, opening over Halaxy's Patient List.
    U().ui.ensureMenuItem('Review requests', (section) => {
      const list = section && [...section.querySelectorAll('a.mainmenu-sublink')].find((a) => /^patient list$/i.test(U().clean(a.textContent)));
      return (list ? list.getAttribute('href').split('#')[0] : U().base() + '/patient/') + '#' + ROUTE;
    }, MENU_CLS, /^patients?$/i);
    new MutationObserver(paintBadge).observe(document.getElementById('mainMenu') || document.body, { childList: true, subtree: true });
    window.addEventListener('storage', (e) => { if (e.key === KEY + 'result') { paintBadge(); render(); } });
    document.addEventListener('visibilitychange', refreshCount);
    window.addEventListener('hashchange', route);
    paintBadge();
    route();
    setTimeout(refreshCount, 5000);
    setInterval(refreshCount, 30 * 60e3);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  window.upcReviewRequests = { version: VERSION, phrases, check, allowed };
})();
