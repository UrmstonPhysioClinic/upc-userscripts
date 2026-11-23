// ==UserScript==
// @name         UPC Calendar: Task stamps (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.2.0
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/task-stamps.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/task-stamps.user.js
// @description  Date, time and initials stamps ("2026-11-11 15:49 CH") and "- " bullets in task comments and appointment comments, added when you click into the box. Hides the task page's broken top Mark as completed. Every task needs a due date: new ones start on today, and none saves without one.
// @match        https://*.halaxy.com/a/pr/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * Task stamps (CH, 11 Nov 2026): "whenever I create a task (or add to a task) manually, it would be really useful
 * if it automatically added a date, time, author stamp for me (or any user) (we use initials)".
 *
 *  - Halaxy's add-task and edit-task pop-ups are form#form_task_edit, with a plain text box form[comment]
 *    (line breaks kept; capture, 11 Nov 2026).
 *  - Also an appointment's Comments in the calendar (CH, 11 Nov 2026: "we use the same system there").
 *  - When the box is first clicked into: an empty box gets "2026-11-11 15:49 CH" and a new line starting "- ";
 *    one with text gets a blank line and a new stamp under what's there. The cursor goes under the stamp.
 *  - "- " bullets behave like a rich text list (see bullets()).
 *  - Saved without anything typed after the stamp (say only the status changed): the empty stamp is taken off first.
 *  - Not stamped again if the comment already ends with this person's stamp from the last 5 minutes (Halaxy
 *    redrawing the pop-up, or a quick second edit).
 *  - Initials: the first letters of the signed-in user's first and last names (Carl Healy: CH).
 *  - Tasks the scripts add carry the script's name instead (core's UPC.tasks.comment).
 *  - The task page (/task/{id}, opened from the bell) has two Mark as completed links to /task/{id}/complete. The
 *    lower one is Halaxy's ajax link (Task Completion pop-up, then Complete). The top one is a plain link that opens a
 *    bare page whose buttons do nothing useful (CH, 23 Nov 2026: "please can we remove it"). The plain one is hidden,
 *    only while the working ajax one is there.
 *  - Due dates (CH, 23 Nov 2026: "tasks without due dates do not get done"): in every task form (form#form_task_edit,
 *    pop-up or page, anywhere in Halaxy) the Task Due Date is marked required like Title; a new task (no Delete or
 *    Mark as completed for it yet) starts on today; Save is stopped with "Task Due Date is required." while it's empty,
 *    for new and existing tasks alike.
 */

(function () {
  'use strict';
  if (window.__hxTaskStamps) return;
  window.__hxTaskStamps = true;

  const VERSION = '0.2.0';
  const RECENT = 5 * 60e3;
  // Task comments (add-task and edit-task pop-ups), and an appointment's Comments in the calendar (form#pr-appointment,
  // a plain box form[description]; capture, 11 Nov 2026). Both plain text, line breaks kept.
  const FIELD = 'form#form_task_edit textarea[name="form[comment]"], form#pr-appointment textarea[name="form[description]"]';

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
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ' ' + who;
  }
  // This person's most recent stamp in the text, and when it was made.
  function lastStampBy(text, who) {
    // A stamp on a line of its own: "2026-11-11 15:45 CH" (and 11 Nov 2026's first style, "2026-11-11 15-45 CH:").
    const re = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})[:-](\d{2}) ([A-Za-z][A-Za-z .-]{0,40}?):?[ \t]*$/gm;
    let m, last = null;
    while ((m = re.exec(text))) last = m;
    if (!last || last[6] !== who) return null;
    return new Date(+last[1], +last[2] - 1, +last[3], +last[4], +last[5]).getTime();
  }
  const fire = (el) => el.dispatchEvent(new Event('input', { bubbles: true }));

  // Bullets, like a rich text list (CH, 11 Nov 2026): Enter on a "- " line starts a new "- " line; Enter on an
  // empty "- " line ends the list (the "- " goes, leaving a plain new line); Enter after a stamp starts the list;
  // Shift+Enter is a plain new line; Backspace on an empty "- " takes the "- " off.
  const BULLET = /^-[ \t]?/;
  const STAMP_LINE = /^\d{4}-\d{2}-\d{2}( \d{2}[:.-]\d{2})? [A-Za-z][A-Za-z .-]{0,30}:?[ \t]*$/;
  function insert(box, text, from, to) {
    box.focus();
    box.setSelectionRange(from, to);
    let ok = false;
    try { ok = text ? document.execCommand('insertText', false, text) : (from === to || document.execCommand('delete')); } catch (e) { ok = false; }   // keeps Undo working
    if (ok && box.value.slice(from, from + text.length) !== text) ok = false;
    if (!ok) { box.setRangeText(text, from, to, 'end'); fire(box); }
  }
  function bullets(box) {
    box.addEventListener('keydown', (e) => {
      if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      const v = box.value, at = box.selectionStart, end = box.selectionEnd;
      const lineStart = v.lastIndexOf('\n', at - 1) + 1;
      const lineEnd = v.indexOf('\n', at) < 0 ? v.length : v.indexOf('\n', at);
      const line = v.slice(lineStart, lineEnd);
      if (e.key === 'Enter' && !e.shiftKey) {
        if (BULLET.test(line)) {
          e.preventDefault();
          if (/^-[ \t]*$/.test(line) && at === end) return insert(box, '', lineStart, lineEnd);   // empty bullet: end the list
          return insert(box, '\n- ', at, end);
        }
        if (STAMP_LINE.test(v.slice(lineStart, at)) && at === end && at === lineEnd) { e.preventDefault(); return insert(box, '\n- ', at, end); }
      } else if (e.key === 'Backspace' && at === end && /^-[ \t]?$/.test(v.slice(lineStart, at)) && /^-[ \t]*$/.test(line)) {
        e.preventDefault();
        insert(box, '', lineStart, lineEnd);
      }
    });
  }

  // The stamp goes in when the box is first clicked or tabbed into (not when the pop-up opens), so a task or
  // appointment that's only opened, moved or given a new status is left as it was.
  function prepare(box) {
    box.setAttribute('data-upc-stamp-done', '1');
    bullets(box);
    let armed = true, toEndOnUp = false;
    const toEnd = () => { try { box.setSelectionRange(box.value.length, box.value.length); } catch (e) { /* ignore */ } };
    box.addEventListener('focus', () => {
      if (!armed) return;
      armed = false;
      box.setAttribute('data-upc-touched', '1');
      const who = initials(userName());
      if (!who) return;
      const text = box.value || '';
      const before = lastStampBy(text, who);
      if (before === null || Date.now() - before >= RECENT || Date.now() < before - 60e3) {
        const s = stamp(who);
        box.value = (text.replace(/\s+$/, '') ? text.replace(/\s+$/, '') + '\n\n' : '') + s + '\n- ';
        box.setAttribute('data-upc-stamp', s);
        fire(box);
      }
      toEnd();
      toEndOnUp = true;   // a click places the cursor after focus: put it back at the end, under the stamp
    });
    box.addEventListener('mouseup', () => { if (toEndOnUp) { toEndOnUp = false; toEnd(); } });
    box.addEventListener('keydown', () => { toEndOnUp = false; });
  }

  // ------------------------------------------------------------------ due dates

  const DUE = 'form#form_task_edit [name="form[displayDueDate]"]';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const todayLabel = () => { const d = new Date(); return p2(d.getDate()) + '-' + MONTHS[d.getMonth()] + '-' + d.getFullYear(); };
  const holder = (form) => form.closest('.modal-content, .bootbox, [role=dialog]') || document.body;
  const isNewTask = (form) => !holder(form).querySelector('a[href*="/task/"][href$="/delete"], a[href*="/task/"][href*="/complete"], a[href*="/task/"][href*="/revert"]');
  function setDue(input, text) {
    if (input._flatpickr && typeof input._flatpickr.setDate === 'function') input._flatpickr.setDate(text, true, 'd-M-Y');
    else { input.value = text; fire(input); input.dispatchEvent(new Event('change', { bubbles: true })); }
  }
  function prepareDue(form) {
    if (form.hasAttribute('data-upc-due')) return;
    const due = form.querySelector('[name="form[displayDueDate]"]');
    if (!due) return;
    form.setAttribute('data-upc-due', '');
    due.required = true;
    // Marked required as Halaxy marks Title: the same label classes and its "*".
    const tl = form.querySelector('label[for="form_title"]'), dl = form.querySelector('label[for="' + due.id + '"]');
    if (tl && dl && !dl.hasAttribute('data-upc-req')) {
      dl.setAttribute('data-upc-req', '');
      tl.classList.forEach((c) => dl.classList.add(c));
      const star = [...tl.childNodes].find((n) => n.nodeType === 1 && n.textContent.trim() === '*');
      if (star && !dl.textContent.trim().startsWith('*')) dl.insertBefore(star.cloneNode(true), dl.firstChild);
    }
    if (isNewTask(form) && !due.value.trim()) setDue(due, todayLabel());
    const clear = () => { if (due.value.trim()) dueError(form, false); };
    due.addEventListener('change', clear);
    due.addEventListener('input', clear);
  }
  function dueError(form, on) {
    const due = form.querySelector('[name="form[displayDueDate]"]');
    let el = form.querySelector('.upc-due-err');
    if (!on) { if (el) el.remove(); if (due) due.classList.remove('is-invalid'); return; }
    if (due) due.classList.add('is-invalid');
    if (!el) {
      el = document.createElement('div');
      el.className = 'text-danger upc-due-err';
      el.setAttribute('role', 'alert');
      el.textContent = 'Task Due Date is required.';
      const group = due && (due.closest('.input-group, .form-group, .row') || due.parentElement);
      if (group && group.parentNode) group.parentNode.insertBefore(el, group.nextSibling); else form.appendChild(el);
    }
  }
  // Save (or Enter) with no due date: stopped before Halaxy sees it.
  function guardDue(e) {
    const t = e.target;
    let form = null;
    if (e.type === 'submit') form = t.matches && t.matches('form#form_task_edit') ? t : null;
    else {
      const b = t && t.closest && t.closest('button, input[type=submit], a');
      if (!b || !(b.classList.contains('btn-submit') || /^\s*save\b/i.test(b.textContent || b.value || ''))) return;
      form = b.closest('form#form_task_edit') || holder(b).querySelector('form#form_task_edit');
    }
    if (!form) return;
    const due = form.querySelector('[name="form[displayDueDate]"]');
    if (!due || due.value.trim()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    dueError(form, true);
    due.focus();
  }
  document.addEventListener('click', guardDue, true);
  document.addEventListener('submit', guardDue, true);

  // Before Halaxy reads the form on Save: empty "- " lines at the end go, and so does a stamp with nothing after it.
  // Only boxes this script has been in are touched.
  function tidy(box) {
    if (!box.hasAttribute('data-upc-touched')) return;
    const s = box.getAttribute('data-upc-stamp');
    let v = box.value.replace(/(\n[ \t]*-?[ \t]*)+$/, '').replace(/\s+$/, '');
    if (s && v.endsWith(s)) v = v.slice(0, v.length - s.length).replace(/\s+$/, '');
    if (v === '-' ) v = '';
    if (v !== box.value) { box.value = v; fire(box); }
  }
  const tidyAll = () => document.querySelectorAll(FIELD).forEach(tidy);
  // The appointment pop-up's Save sits outside its form (capture, 11 Nov 2026), so any Save / Book / Update tidies them all.
  document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest && e.target.closest('button, input[type=submit], a');
    if (b && /^\s*(save|book|update)\b/i.test(b.textContent || b.value || '')) tidyAll();
  }, true);
  document.addEventListener('submit', tidyAll, true);

  let queued = false;
  // The appointment pop-up opens long after page load, so the health check can't look for its Comments box: this
  // script tells it (once a page) if the pop-up turns up without one.
  let told = false;
  function checkLayout() {
    if (told) return;
    const appt = document.querySelector('form#pr-appointment');
    if (appt && appt.querySelector('select, input:not([type=hidden])') && !appt.querySelector('textarea[name="form[description]"]')) {
      told = true;
      document.dispatchEvent(new CustomEvent('upc-loader-error', { detail: JSON.stringify({ file: 'task-stamps.user.js', message: 'The appointment pop-up has changed (its Comments box, form[description], was not found).' }) }));
    }
  }
  function hideBrokenComplete() {
    const m = location.pathname.match(/\/task\/(\d+)\/?$/);
    if (!m) return;
    const links = [...document.querySelectorAll('a[href]')].filter((a) => new RegExp('/task/' + m[1] + '/complete/?$').test(a.getAttribute('href')));
    if (!links.some((a) => a.classList.contains('ajax'))) return;
    links.filter((a) => !a.classList.contains('ajax') && !a.hidden).forEach((a) => { a.hidden = true; a.style.setProperty('display', 'none', 'important'); });
  }
  const scan = () => { queued = false; document.querySelectorAll(FIELD + ':not([data-upc-stamp-done])').forEach(prepare); document.querySelectorAll('form#form_task_edit:not([data-upc-due])').forEach(prepareDue); checkLayout(); hideBrokenComplete(); };
  new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(scan); } }).observe(document.body, { childList: true, subtree: true });
  scan();

  window.upcTaskStamps = { version: VERSION, initials, stamp, lastStampBy };
})();
