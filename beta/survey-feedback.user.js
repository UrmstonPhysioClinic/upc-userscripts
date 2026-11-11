// ==UserScript==
// @name         Halaxy feedback alerts (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.1.0
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/survey-feedback.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/survey-feedback.user.js
// @description  Feedback Request survey responses that need a look (Below expected, or Satisfactory with a comment) become a Halaxy task for Carl on the patient's profile. Carl only.
// @match        https://*.halaxy.com/a/pr/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * Feedback alerts (agreed with Carl, 11 Nov 2026).
 *
 *  - The clinic's Feedback Request survey ("How Was Your Appointment?") is scored by Halaxy: Excellent 32 to 35
 *    (no action needed), Satisfactory 26 to 31 (no action unless the comment indicates concern), Below expected
 *    0 to 25 (consider patient follow-up).
 *  - Below expected, or Satisfactory with a comment, becomes a task for Carl on the patient's profile, added
 *    without asking (Carl: "adding the tasks automatically without user interaction would be best"). Completing
 *    the task is how it's marked dealt with, so it shows on every PC. The task carries the answers and comment,
 *    inside Halaxy; the script keeps only the response's id, score band and the outcome, never names or answers.
 *  - Survey responses have no patient id: the patient is found with Halaxy's patient search by name, and the date
 *    of birth on the response picks the right one. If that isn't certain, nothing is added and the response is
 *    listed in Feedback alerts: show results (Script settings), with a count on Reports > Surveys.
 *  - A task is never added twice: the patient's tasks are checked first for the response's number.
 *  - Checked at most every 2 hours, on Carl's sign-in, in the visible tab, one tab at a time, skipped while
 *    Halaxy has asked scripts to pause. Only responses from the last 14 days are looked at, so a PC that starts
 *    checking doesn't go back through old ones. One request for the list, one for each new response.
 */
(() => {
  'use strict';
  if (window.__hxSurveyFeedback) return;
  window.__hxSurveyFeedback = true;

  const VERSION = '0.1.0';
  const ALLOWED = ['Carl Healy'];   // Carl, 11 Nov 2026
  const ASSIGNEE = 'Carl Healy';
  const MAX_SCORE = 35;             // the Feedback Request template: 3 x 5 + 2 x 5 + 2 x 5
  const DAY = 86400e3;
  const CHECK_EVERY = 2 * 3600e3, WINDOW = 14 * DAY, KEEP = 60 * DAY, RETRY_UNMATCHED = 3;
  const KEY = 'upc-fb:';
  const COMMENT_Q = /anything you.?d like us to know|do differently/i;
  // Comments that say nothing (a Satisfactory response with one of these isn't flagged).
  const NOTHING = /^(no|nope|none|nothing|nil|n\/?a|na|-+|\.+|no thanks?( you)?|no comments?|nothing (to add|else)|not really|all good|all fine|fine|ok(ay)?)[.!]*$/i;

  const U = () => window.UPC;
  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(KEY + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
  };
  const label = (ms) => U().dayLabel(ms);
  const time = (ms) => label(ms) + ' ' + new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const BAND = { excellent: 'Excellent', satisfactory: 'Satisfactory', below: 'Below expected' };

  function userName() {
    const h = window.HkUser || {};
    const named = String(h.pracName || (h.CalendarDefault || {}).pracName || '').trim();
    if (named) return named;
    const btn = document.getElementById('activeUser');
    return btn ? btn.textContent.replace(/\s+/g, ' ').trim() : '';
  }
  const allowed = () => ALLOWED.some((n) => n.toLowerCase() === userName().toLowerCase());

  function tellHealthCheck(e) {
    const message = (e && e.message) || String(e);
    if (!/has changed/.test(message)) return;
    document.dispatchEvent(new CustomEvent('upc-loader-error', { detail: JSON.stringify({ file: 'survey-feedback.user.js', message }) }));
  }

  // Halaxy shows a scored answer as "weighted score - choice" ("15 - 5" for 5 on a question that counts triple: live,
  // 11 Nov 2026), so the second number is the 1 to 5 choice. Anything else as Halaxy shows it.
  function answerText(a) {
    const m = String(a).match(/^\s*\d+\s*-\s*(\d+)\s*$/);
    return m && +m[1] >= 1 && +m[1] <= 5 ? m[1] + ' of 5' : a;
  }
  const commentOf = (r) => { const q = r.answers.find((x) => COMMENT_Q.test(x.question)); return q ? q.answer : ''; };
  const meaningful = (c) => !!c && !NOTHING.test(c.trim());

  function taskFor(row, r, band) {
    const lines = [row.template + ' survey, answered ' + time(row.answered) + (row.appointment ? ', for the appointment on ' + time(row.appointment) : '') + '.',
      'Score: ' + r.total + ' of ' + MAX_SCORE + ', ' + (r.level || BAND[band]) + '.', ''];
    r.answers.forEach((x) => lines.push(x.question + ' ' + (x.answer ? answerText(x.answer) : '(not answered)')));
    lines.push('', 'Survey response ' + row.id + '. Completing this task marks it dealt with.');
    return { title: 'Feedback to look at: ' + (r.level || BAND[band]) + ' (' + r.total + ' of ' + MAX_SCORE + ')', assignee: ASSIGNEE, priority: band === 'below' ? 3 : 2,
      due: label(Date.now()), comment: lines.join('\n'), key: 'Survey response ' + row.id };
  }

  // ------------------------------------------------------------------ the check

  async function check(say) {
    say = say || (() => {});
    const now = Date.now();
    const done = store.get('done', {});
    say('Reading the survey responses...');
    const rows = (await U().surveys.list()).filter((x) => x.answered && x.answered >= now - WINDOW);
    for (const row of rows.sort((a, b) => a.answered - b.answered)) {
      const d = done[row.id];
      if (d && (d.outcome !== 'unmatched' || d.tries >= RETRY_UNMATCHED)) continue;
      say('Reading the response from ' + time(row.answered) + '...');
      try {
        const r = await U().surveys.response(row.id);
        const band = U().surveys.band(r);
        const flag = band === 'below' || (band === 'satisfactory' && meaningful(commentOf(r)));
        const rec = { at: row.answered, checked: now, band, total: r.total, outcome: 'ok' };
        if (flag) {
          const id = await U().patient.find(row.name, r.dob);
          if (!id) Object.assign(rec, { outcome: 'unmatched', tries: ((d && d.tries) || 0) + 1 });
          else {
            say('Adding a task...');
            rec.patient = id;
            rec.outcome = (await U().tasks.addToPatient(id, taskFor(row, r, band))) ? 'task' : 'had';
          }
        }
        done[row.id] = rec;
      } catch (e) {
        tellHealthCheck(e);
        console.warn('[UPC feedback alerts]', e);
        store.set('lastError', { at: now, message: e.message || String(e) });
      }
      store.set('done', done);   // kept as it goes, so a check that's stopped isn't wasted
    }
    Object.keys(done).forEach((k) => { if (now - (done[k].at || 0) > KEEP) delete done[k]; });
    store.set('done', done);
    store.set('last', Date.now());
    return done;
  }

  // One check at a time across tabs; the checking tab renews its claim as it goes.
  const locked = () => Date.now() - store.get('running', 0) < 2 * 60e3;
  async function checkLocked(say) {
    store.set('running', Date.now());
    const beat = (t) => { store.set('running', Date.now()); if (say) say(t); };
    try { return await check(beat); } finally { store.set('running', 0); paintBadge(); }
  }
  async function background() {
    if (!allowed() || document.visibilityState !== 'visible' || !U() || U().http.pausedFor() > 0 || locked()) return;
    if (Date.now() - store.get('last', 0) < CHECK_EVERY) return;
    try { await checkLocked(); } catch (e) { tellHealthCheck(e); console.warn('[UPC feedback alerts]', e); store.set('lastError', { at: Date.now(), message: e.message || String(e) }); }
  }

  // ------------------------------------------------------------------ count on Reports > Surveys

  const unmatched = () => Object.entries(store.get('done', {})).filter(([, v]) => v.outcome === 'unmatched');
  function paintBadge() {
    const a = [...document.querySelectorAll('#mainMenu a.mainmenu-sublink')].find((x) => /^surveys\b/i.test(U().clean(x.textContent)));
    if (!a) return;
    const n = allowed() ? unmatched().length : 0;
    let b = a.querySelector('.upc-fb-badge');
    if (!n) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('span'); b.className = 'upc-fb-badge'; b.title = 'Survey responses to look at by hand (Script settings, Feedback alerts)'; a.appendChild(b); }
    if (b.textContent !== String(n)) b.textContent = String(n);
  }

  // ------------------------------------------------------------------ results pop-up

  const CSS = `
    .upc-fb-badge { display: inline-block; min-width: 18px; margin-left: 6px; padding: 0 5px; border-radius: 9px; font-size: .75em; line-height: 18px;
      text-align: center; font-weight: 600; color: #fff; background: var(--vs-notification-badge-bg-color, #ec6b65); vertical-align: middle; }
    .upc-fb .upc-fb-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-bottom: 12px; }
    .upc-fb .upc-fb-bar .btn { margin: 0; }
    .upc-fb td { white-space: nowrap; }
  `;
  function styles() {
    if (document.getElementById('upc-survey-feedback-css')) return;
    const st = document.createElement('style');
    st.id = 'upc-survey-feedback-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  async function showResults() {
    if (!allowed()) return;
    U().ui.nativeStyles();
    const dlg = U().ui.dialog({ title: 'Feedback alerts', key: 'upc-survey-feedback', wide: true });
    if (!dlg) return;
    const box = document.createElement('div');
    box.className = 'upc-native upc-fb';
    dlg.body.appendChild(box);
    let busy = false, status = '', names = {};
    const draw = () => {
      const done = store.get('done', {});
      const all = Object.entries(done);
      const counts = { excellent: 0, satisfactory: 0, below: 0 };
      all.filter(([, v]) => v.at >= Date.now() - WINDOW).forEach(([, v]) => { if (v.band in counts) counts[v.band]++; });
      const shown = all.filter(([, v]) => v.outcome !== 'ok').sort((a, b) => b[1].at - a[1].at);
      const last = store.get('last', 0), err = store.get('lastError', null);
      const base = U().base();
      let h = '<div class="upc-fb-bar"><button type="button" class="btn btn-outline-primary-light" data-a="check"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Checking...' : 'Check now') + '</button>' +
        '<span class="text-muted">' + esc(busy ? status : last ? 'Checked ' + time(last) + '.' : 'Not checked yet.') + '</span></div>';
      if (err && err.at >= last - 60e3) h += '<p class="upc-err">Last check: ' + esc(err.message) + '</p>';
      h += '<p>Responses in the last 14 days: ' + counts.excellent + ' Excellent, ' + counts.satisfactory + ' Satisfactory, ' + counts.below + ' Below expected. ' +
        'Below expected, and Satisfactory with a comment, become a task for you on the patient\'s profile.</p>';
      if (!shown.length) h += '<p class="text-muted">No responses have needed a task.</p>';
      else {
        h += '<table class="table table-striped table-bordered w-100"><thead><tr><th>Answered</th><th>Patient</th><th>Score</th><th>Task</th></tr></thead><tbody>' + shown.map(([id, v]) => {
          const who = v.patient ? '<a href="' + esc(base + '/patient/' + v.patient) + '" target="_blank" rel="noopener">' + esc(names[id] || 'Open profile') + '</a>' : esc(names[id] || 'Response ' + id);
          const task = v.outcome === 'task' ? 'Added' : v.outcome === 'had' ? 'Already there' :
            '<span class="upc-err">Not added: the patient couldn\'t be found for certain.</span> <a href="' + esc(base + '/report/survey/feedback') + '" target="_blank" rel="noopener">Open Responses</a>';
          return '<tr><td>' + esc(time(v.at)) + '</td><td>' + who + '</td><td>' + esc(BAND[v.band] + ' (' + v.total + ' of ' + MAX_SCORE + ')') + '</td><td>' + task + '</td></tr>';
        }).join('') + '</tbody></table>';
      }
      h += '<div class="text-muted upc-version">Feedback alerts ' + VERSION + '</div>';
      box.innerHTML = h;
    };
    const loadNames = async () => {   // names come from Halaxy each time, never kept
      try { (await U().surveys.list()).forEach((x) => { names[x.id] = x.name; }); } catch (e) { tellHealthCheck(e); }
      draw();
    };
    box.addEventListener('click', async (e) => {
      if (!e.target.closest('[data-a=check]') || busy) return;
      if (locked()) { status = 'Checking in another tab...'; busy = true; draw(); while (locked()) await U().sleep(1500); busy = false; draw(); return; }
      busy = true; draw();
      try { await checkLocked((t) => { status = t; draw(); }); } catch (err) { store.set('lastError', { at: Date.now(), message: err.message || String(err) }); }
      busy = false;
      await loadNames();
    });
    draw();
    loadNames();
  }

  // ------------------------------------------------------------------ start

  function start() {
    if (!U()) { console.error('[UPC feedback alerts] needs the core library'); return; }
    if (!allowed()) return;
    styles();
    if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('Feedback alerts: show results', showResults);
    new MutationObserver(paintBadge).observe(document.getElementById('mainMenu') || document.body, { childList: true, subtree: true });
    window.addEventListener('storage', (e) => { if (e.key === KEY + 'done') paintBadge(); });
    document.addEventListener('visibilitychange', background);
    paintBadge();
    setTimeout(background, 8000);
    setInterval(background, 15 * 60e3);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  window.upcSurveyFeedback = { version: VERSION, check, allowed, answerText, meaningful };
})();
