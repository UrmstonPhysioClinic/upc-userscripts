// ==UserScript==
// @name         Halaxy task stamps (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.1.0
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/task-stamps.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/task-stamps.user.js
// @description  Starts each new entry in a task's comment with the date, time and your initials ("2026-11-11 15-49 CH:"), when adding a task or adding to one.
// @match        https://*.halaxy.com/a/pr/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * Task stamps (Carl, 11 Nov 2026): "whenever I create a task (or add to a task) manually, it would be really useful
 * if it automatically added a date, time, author stamp for me (or any user) (we use initials)".
 *
 *  - Halaxy's add-task and edit-task pop-ups are form#form_task_edit, with a plain text box form[comment]
 *    (line breaks kept; capture, 11 Nov 2026).
 *  - A new task's comment starts "2026-11-11 15-49 CH:" and a new line. On an existing task, a blank line and a new
 *    stamp go under what's there. The cursor goes to the end when the box is first clicked.
 *  - Saved without anything typed after the stamp (say only the status changed): the empty stamp is taken off first.
 *  - Not stamped again if the comment already ends with this person's stamp from the last 5 minutes (Halaxy
 *    redrawing the pop-up, or a quick second edit).
 *  - Initials: the first letters of the signed-in user's first and last names (Carl Healy: CH).
 *  - Tasks the scripts add carry the script's name instead (core's UPC.tasks.comment).
 */

(function () {
  'use strict';
  if (window.__hxTaskStamps) return;
  window.__hxTaskStamps = true;

  const VERSION = '0.1.0';
  const RECENT = 5 * 60e3;
  const FIELD = 'form#form_task_edit textarea[name="form[comment]"]';

  function userName() {
    try {
      const h = window.HkUser || {};
      const named = String(h.pracName || (h.CalendarDefault || {}).pracName || '').trim();
      if (named) return named;
    } catch (e) { /* fall back to the account menu */ }
    const btn = document.getElementById('activeUser');
    return btn ? btn.textContent.replace(/\s+/g, ' ').trim() : '';
  }
  function initials(name) {
    const words = String(name || '').replace(/\([^)]*\)/g, ' ').split(/\s+/).filter((w) => /^[A-Za-z]/.test(w))
      .filter((w, i, all) => !(i === 0 && all.length > 2 && /^(dr|mr|mrs|ms|miss|mx|prof)\.?$/i.test(w)));
    if (!words.length) return '';
    return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
  }
  const p2 = (n) => String(n).padStart(2, '0');
  function stamp(who, when) {
    const d = new Date(when || Date.now());
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + '-' + p2(d.getMinutes()) + ' ' + who + ':';
  }
  // This person's most recent stamp in the text, and when it was made.
  function lastStampBy(text, who) {
    const re = /(\d{4})-(\d{2})-(\d{2}) (\d{2})-(\d{2}) ([A-Za-z][A-Za-z .-]{0,40}):/g;
    let m, last = null;
    while ((m = re.exec(text))) last = m;
    if (!last || last[6] !== who) return null;
    return new Date(+last[1], +last[2] - 1, +last[3], +last[4], +last[5]).getTime();
  }
  const fire = (el) => el.dispatchEvent(new Event('input', { bubbles: true }));

  function prepare(box) {
    box.setAttribute('data-upc-stamp-done', '1');
    const who = initials(userName());
    if (!who) return;
    const text = box.value || '';
    const before = lastStampBy(text, who);
    if (before !== null && Date.now() - before < RECENT && Date.now() >= before - 60e3) return;
    const s = stamp(who);
    box.value = text.replace(/\s+$/, '') ? text.replace(/\s+$/, '') + '\n\n' + s + '\n' : s + '\n';
    box.setAttribute('data-upc-stamp', s);
    fire(box);
    // The first click (or tab) into the box puts the cursor at the end, under the stamp; later clicks work as usual.
    const toEnd = () => { try { box.setSelectionRange(box.value.length, box.value.length); } catch (e) { /* ignore */ } };
    const done = () => { box.removeEventListener('focus', toEnd); box.removeEventListener('mouseup', onUp); box.removeEventListener('keydown', done); };
    const onUp = () => { toEnd(); done(); };
    box.addEventListener('focus', toEnd);
    box.addEventListener('mouseup', onUp);
    box.addEventListener('keydown', done);
  }

  // Saving with nothing typed after the stamp: take the empty stamp off first (before Halaxy reads the form).
  function tidy(form) {
    const box = form && form.querySelector('textarea[name="form[comment]"][data-upc-stamp]');
    if (!box) return;
    const s = box.getAttribute('data-upc-stamp');
    const v = box.value.replace(/\s+$/, '');
    if (v.endsWith(s)) { box.value = v.slice(0, v.length - s.length).replace(/\s+$/, ''); fire(box); }
  }
  document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest && e.target.closest('button, input[type=submit], a');
    const form = b && (b.closest('form#form_task_edit') || (b.closest('.modal, .bootbox, .modal-dialog') || document.createElement('div')).querySelector('form#form_task_edit'));
    if (form && /^\s*save\b/i.test(b.textContent || b.value || '')) tidy(form);
  }, true);
  document.addEventListener('submit', (e) => { if (e.target && e.target.matches && e.target.matches('form#form_task_edit')) tidy(e.target); }, true);

  let queued = false;
  const scan = () => { queued = false; document.querySelectorAll(FIELD + ':not([data-upc-stamp-done])').forEach(prepare); };
  new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(scan); } }).observe(document.body, { childList: true, subtree: true });
  scan();

  window.upcTaskStamps = { version: VERSION, initials, stamp, lastStampBy };
})();
