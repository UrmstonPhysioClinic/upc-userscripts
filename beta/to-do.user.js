// ==UserScript==
// @name         UPC Schedule: To do (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.2.16
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/to-do.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/to-do.user.js
// @description  Schedule > To do: Halaxy tasks by when they are due, or as a week to drag tasks between days. Done with Undo, several at once, edited and added in Halaxy's own pop-ups. Beside them, a card for each of our lists you can open.
// @match        https://*.halaxy.com/a/pr/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * To do (CH, 20 to 23 Nov 2026; plan in claude/my-tasks-plan.md; rebuilt 23 Nov 2026 after CH's review of 0.1.0).
 *
 *  - Tasks: Halaxy's GET /task/data (every task; what its Tasks page loads). Open tasks, filtered by who they are for
 *    (me by default, a person, or everyone) and what they are linked to; the filters are remembered for each person on
 *    this PC. Read when the page opens (kept for 5 minutes) and for the menu badge (mine, overdue or due today) at most
 *    hourly in the visible tab.
 *  - In Halaxy's top bar too, in place of the Inbox, with the same count (CH, 24 Nov 2026; see topBar).
 *  - Week view (CH, 24 Nov 2026): tasks with a purple edge; under each day's heading, the signed-in practitioner's
 *    appointments that day.
 *  - List view: cards Overdue, Today, This week, Later, No date (25 rows, then "Show 25 more"; search and sorting from
 *    the page kit). Week view: Monday to Friday of a week, tasks dragged between days, a tray of overdue and undated
 *    tasks to drag from.
 *  - Edit and New task open Halaxy's own pop-ups (core UPC.ui.halaxyPopup; CH, 23 Nov 2026: its date picker, several
 *    assignees, search and templates, exactly as Halaxy has them). New task asks first what it's linked to (a patient,
 *    an invoice, an organisation, or nothing), found with Halaxy's search, then opens Halaxy's add-task pop-up for it.
 *  - Done (Halaxy's Mark as completed) and Move (the Edit task form saved with only the due date changed) take effect
 *    straight away with Undo (CH, 23 Nov 2026: changes that can be put back exactly don't ask first). Undo uses
 *    Halaxy's Revert, or moves the date back. Ticked rows do several at once. One at a time at Halaxy's pace.
 *  - Beside the tasks: a card per list page this person can open (core UPC.todo).
 */
(() => {
  'use strict';
  if (window.__hxToDo) return;
  window.__hxToDo = true;

  const VERSION = '0.2.16';
  const ROUTE = 'upc-to-do';
  const MENU_CLS = 'upc-todo-menu';
  const DAY = 864e5, MIN = 60e3;
  const FRESH = 5 * MIN, BADGE_EVERY = 60 * MIN, UNDO_FOR = 15e3;
  const U = () => window.UPC;
  const esc = (s) => U().esc(s);
  const clean = (s) => String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim();
  const two = (n) => String(n).padStart(2, '0');
  const label = (ms) => U().dayLabel(ms);
  const store = () => U().storage('upc-todo-tasks:');
  const me = () => U().user.name([]);
  const PRIORITY = { Low: 1, Medium: 2, High: 3 };
  const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  const CSS = `
    .upc-todo .card { margin-bottom: 24px; }
    .upc-todo .card-header h2 { margin: 0; }
    .upc-todo .upc-todo-cols { display: grid; grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr); gap: 24px; align-items: start; }
    @media (max-width: 1100px) { .upc-todo .upc-todo-cols { grid-template-columns: minmax(0, 1fr); } }
    .upc-todo .upc-todo-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-bottom: 16px; }
    .upc-todo .upc-todo-filters .form-control { width: auto; }
    .upc-todo .upc-todo-filters .nav { margin-right: auto; }
    .upc-todo td.upc-todo-due, .upc-todo td.upc-todo-act { white-space: nowrap; }
    .upc-todo td.upc-todo-act .btn { margin: 0; }
    .upc-todo td.upc-todo-act .btn + .btn, .upc-todo td.upc-todo-act .upc-pill + .btn { margin-left: 8px; }
    .upc-todo td.upc-todo-act { white-space: nowrap; }
    .upc-todo .upc-todo-late { color: var(--vs-balance-negative-color, #b3261e); }
    .upc-todo .upc-todo-task { cursor: pointer; }
    .upc-todo .upc-bulk input.form-control { width: 150px; }
    .upc-todo .upc-todo-side .card-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .upc-todo .upc-todo-side .card-header .btn { margin: 0; }
    .upc-todo .upc-todo-side ul { margin: 0; padding-left: 18px; }
    .upc-todo .upc-todo-week { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; }
    .upc-todo .upc-todo-week .card { margin: 0; min-height: 160px; }
    .upc-todo .upc-todo-week .card-body { padding: 8px; }
    .upc-todo .upc-todo-week .upc-todo-dayhead { display: block; }
    .upc-todo .upc-todo-week .upc-todo-dayhead h2 { margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .upc-todo .upc-todo-week .upc-todo-dayhead .text-muted { font-size: .85em; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .upc-todo .upc-todo-week .upc-todo-drop.upc-todo-over { outline: 2px dashed #994DE6; outline-offset: -4px; }
    .upc-todo .upc-todo-chip { border: 1px solid var(--vs-card-border-color, #dee2e6); border-radius: 6px; box-shadow: inset 4px 0 0 #994DE6; padding: 6px 8px 6px 12px; margin-bottom: 6px; background: var(--vs-card-bg-color, #fff); cursor: grab; }
    .upc-todo .upc-todo-week .upc-todo-appts { border: 1px solid var(--vs-card-border-color, #dee2e6); border-radius: 6px; padding: 6px 8px; margin-bottom: 6px;
      background: var(--vs-card-bg-color, #fff); color: var(--vs-theme-body-color, #2d2d35); }
    .upc-todo .upc-todo-week .upc-todo-appts .icon { color: var(--vs-text-muted, #6c757d); margin-right: 4px; }
    .upc-todo .upc-todo-chip small { display: block; }
    .upc-todo .upc-todo-weeknav { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
    .upc-todo .upc-todo-weeknav .btn { margin: 0; }
    .upc-todo-headbox { position: relative; display: inline-flex; align-items: center; }
    a.upc-todo-head { position: relative; display: inline-flex; align-items: center; justify-content: center; color: inherit; font-size: 1.35em; text-decoration: none; }
    a.upc-todo-head:hover { text-decoration: none; opacity: .8; }
    a.upc-todo-head .upc-todo-headcount { position: absolute; top: -6px; right: -9px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px;
      font-size: 10px; line-height: 16px; font-weight: 600; text-align: center; color: #fff; background: var(--vs-notification-badge-bg-color, #ec6b65); pointer-events: none; }
    .upc-todo-badge { display: inline-block; min-width: 18px; margin-left: 6px; padding: 0 5px; border-radius: 9px; font-size: .75em; line-height: 18px;
      text-align: center; font-weight: 600; color: #fff; background: var(--vs-notification-badge-bg-color, #ec6b65); vertical-align: middle; }
    .upc-todo-new .upc-todo-find { position: relative; }
    .upc-todo-new .upc-todo-found { position: absolute; left: 0; right: 0; top: 100%; z-index: 5; max-height: 280px; overflow: auto; margin-top: 2px; padding: 4px 0;
      background: var(--vs-card-bg-color, #fff); border: 1px solid var(--vs-card-border-color, #ced4da); border-radius: 6px; box-shadow: 0 6px 16px rgba(0, 0, 0, .15); }
    .upc-todo-new .upc-todo-opt { padding: 6px 12px; cursor: pointer; }
    .upc-todo-new .upc-todo-opt-on, .upc-todo-new .upc-todo-opt[data-i]:hover { background: var(--purple-pale, #F3EAFD); }
    .upc-todo-new label { display: block; margin: 12px 0 4px; font-weight: 600; }
  `;

  // ------------------------------------------------------------------ tasks

  const dayStart = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const dueOf = (t) => { const ms = Date.parse(t.due_date || ''); return isNaN(ms) ? null : ms; };
  const hasTime = (ms) => { const d = new Date(ms); return d.getHours() || d.getMinutes(); };
  const dueText = (ms) => (ms === null ? '' : label(ms) + (hasTime(ms) ? ' ' + two(new Date(ms).getHours()) + ':' + two(new Date(ms).getMinutes()) : ''));
  const mondayOf = (ms) => { const d = new Date(dayStart(ms)); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };

  async function load(force) {
    const c = store().get('open', null);
    if (!force && c && Date.now() - c.at < FRESH) return c;
    // Asked afresh (a time in the address, no-store), so a task saved a moment ago is in it (as core does for lists).
    const all = await U().http.json('/task/data?_=' + Date.now(), { cache: 'no-store' });
    if (!Array.isArray(all)) throw new (U().Error)('Halaxy\'s task list has changed (/task/data is not a list).');
    const open = all.filter((t) => t && t.status !== 'Completed')
      .map((t) => ({ id: String(t.id), title: clean(t.title), type: clean(t.type), priority: clean(t.priority), due: dueOf(t), status: t.status, who: (t.assignees || []).map(clean) }));
    const r = { at: Date.now(), open };
    store().set('open', r);
    const st = store().get('staff', null);
    if (!st || Date.now() - st.at > DAY) {
      try {
        const { doc } = await U().http.popup('/task/new');
        const names = [...doc.querySelectorAll('select[name="form[linkPrGs][]"] option')].map((o) => clean(o.textContent)).filter(Boolean);
        if (names.length) store().set('staff', { at: Date.now(), names });
      } catch (e) { /* the names on the tasks will do */ }
    }
    paintBadge();
    return r;
  }

  // Tasks shown, by the filters.
  function shown(c, f) {
    const who = (f.who || 'me') === 'me' ? me().toLowerCase() : f.who === 'all' ? null : String(f.who).toLowerCase();
    return c.open.filter((t) => (!who || t.who.some((n) => n.toLowerCase() === who)) && (!f.type || f.type === 'all' || (f.type === 'none' ? !t.type : t.type === f.type)));
  }

  function groupOf(t) {
    const today = dayStart(Date.now()), tomorrow = today + DAY, nextMonday = mondayOf(today) + 7 * DAY;
    return t.due === null ? 'nodate' : t.due < today || t.status === 'Overdue' ? 'overdue' : t.due < tomorrow ? 'today' : t.due < nextMonday ? 'week' : 'later';
  }
  // held: keep moved tasks where they were (the list on screen; counts elsewhere go by the real dates).
  function groups(ts, held) {
    const g = { overdue: [], today: [], week: [], later: [], nodate: [] };
    const at = (t) => (held && stay.has(t.id) && before.has(t.id) ? before.get(t.id) : t.due);
    ts.forEach((t) => { g[held && stay.has(t.id) ? stay.get(t.id) : groupOf(t)].push(t); });
    Object.values(g).forEach((l) => l.sort((a, b) => (at(a) || 0) - (at(b) || 0) || (PRIORITY[b.priority] || 0) - (PRIORITY[a.priority] || 0)));
    return g;
  }

  function paintBadge() {
    const a = document.querySelector('a.' + MENU_CLS);
    const head = topBar();
    if (!a && !head) return;
    const c = store().get('open', null);
    const g = c && me() ? groups(shown(c, { who: 'me' })) : null;
    const n = g ? g.overdue.concat(g.today).filter((t) => !t.completed).length : 0;
    [a, head].filter(Boolean).forEach((el) => {
      const cls = el === head ? 'upc-todo-headcount' : 'upc-todo-badge';
      let b = el.querySelector('.' + cls);
      if (!n) { if (b) b.remove(); return; }
      if (!b) { b = document.createElement('span'); b.className = cls; el.appendChild(b); }
      if (el === head) countLook(b, head);
      const text = n > 99 ? '99+' : String(n);
      if (b.textContent !== text) b.textContent = text;
      const title = n + ' task' + (n === 1 ? '' : 's') + ' overdue or due today';
      if (b.title !== title) b.title = title;
    });
  }

  // To do in Halaxy's top bar, in place of the Inbox (CH, 24 Nov 2026: the clinic doesn't use the Inbox). The Inbox is
  // div#alertIncomingMessages.headIcon > a#btn-alert-incoming-messages (i.icon-inbox), beside div#alertNotifications
  // (the bell), in div#alertHeader (capture, 24 Nov 2026). Ours sits where the Inbox was and opens To do; its badge
  // counts the same as the menu's. The icon is Halaxy's own clipboard with a tick (its icon font), else a drawing of one in
  // the same grey.
  // Halaxy's font ("halaxy") is the Linearicons set (it has icon-linearicons; checked 24 Nov 2026): its clipboard with a
  // tick is icon-clipboard-check. The others are kept in case Halaxy changes the set.
  const ICONS = ['icon-clipboard-check', 'icon-clipboard-text', 'icon-check-square', 'icon-clipboard', 'icon-checklist'];
  const DRAWN = '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4.5V3h6v1.5"/><path d="M8.5 13l2.5 2.5 4.5-5"/></svg>';
  let iconFound;
  function iconOf(host) {
    if (iconFound !== undefined) return iconFound;
    iconFound = '';
    for (const c of ICONS) {
      const i = document.createElement('i');
      i.className = 'icon ' + c;
      host.appendChild(i);
      const content = getComputedStyle(i, '::before').content;
      i.remove();
      if (content && content !== 'none' && content !== 'normal' && content !== '""') { iconFound = c; break; }
    }
    return iconFound;
  }
  // The count on To do looks like the bell's and sits in the same place on its icon (CH, 24 Nov 2026). Core reads the
  // bell's count (its link's ::after, from data-count). Where it sits is measured: Halaxy places it from the nearest
  // positioned box around the bell (not the link itself, which is static), so the offset from the bell's icon is worked
  // out on screen and used from our icon, the same size (capture, 24 Nov 2026). Kept on the PC for pages without a count.
  const LOOK = ['box-sizing', 'min-width', 'height', 'padding', 'border-radius', 'font-size', 'font-weight', 'line-height', 'color', 'background-color', 'font-family', 'letter-spacing'];
  function bellSpot() {
    const bell = U().ui.bellLink ? U().ui.bellLink() : null;
    const icon = bell && bell.querySelector('i');
    if (!icon || !/[1-9]/.test(bell.getAttribute('data-count') || '')) return null;
    const cs = getComputedStyle(bell, '::after');
    if (cs.position !== 'absolute' || isNaN(parseFloat(cs.top)) || isNaN(parseFloat(cs.left))) return null;
    let p = bell;
    while (p && p !== document.body && getComputedStyle(p).position === 'static') p = p.parentElement;
    const pr = p.getBoundingClientRect(), ir = icon.getBoundingClientRect();
    if (!ir.width) return null;
    const ci = getComputedStyle(icon);
    return { top: pr.top + p.clientTop + parseFloat(cs.top) - ir.top, left: pr.left + p.clientLeft + parseFloat(cs.left) - ir.left, size: ci.fontSize, lh: ci.lineHeight };
  }
  function countLook(b, mine) {
    const look = U().ui.countLook ? U().ui.countLook() : null;
    let spot = bellSpot();
    if (spot) store().set('countSpot', spot); else spot = store().get('countSpot', null);
    const mi = mine.querySelector('i, svg');
    if (spot && mi) { mi.style.setProperty('font-size', spot.size); if (mi.tagName === 'I') mi.style.setProperty('line-height', spot.lh); }
    if (look) LOOK.forEach((k) => { if (look[k]) b.style.setProperty(k, look[k]); });
    if (look && !look['box-sizing']) b.style.setProperty('box-sizing', 'content-box');
    if (spot && mi) {
      const lr = mine.getBoundingClientRect(), ir = mi.getBoundingClientRect();
      if (!lr.width) return;
      const top = Math.round((spot.top + ir.top - lr.top) * 10) / 10 + 'px', left = Math.round((spot.left + ir.left - lr.left) * 10) / 10 + 'px';
      if (b.style.top !== top) b.style.top = top;
      if (b.style.left !== left) b.style.left = left;
      b.style.right = 'auto'; b.style.bottom = 'auto';
    }
  }
  // ------------------------------------------------------------------ the bell without tasks

  // With To do on, tasks leave Halaxy's bell, its list and its count (CH, 24 Nov 2026). Halaxy's own task notifications
  // stay switched on, for anyone using Halaxy without the scripts. Halaxy's bell (HkAlert; captures 24 Nov 2026): the
  // count is the number of entries in its list; the list is GET alert/get-teasers/2 (HkAlert.urlGetTeasers.notification),
  // payload.teasers.notification, one HTML string per entry, a task's being div.viewTeaser.alertType-task-*;
  // HkAlert.setAlertCount(zone, n) paints the count (on its own poll too) and HkAlert.getTeaserData(zone, cb) fills the
  // list. Both are wrapped. To know how many entries aren't tasks, the list is read once each time Halaxy's count changes
  // (kept on the PC for 10 minutes, shared by its tabs), about what opening the bell would cost.
  const isTask = (html) => /^\s*<[^>]*class=["'][^"']*\balertType-task/.test(String(html));
  let bellTasks = [];         // the bell's task entries (HTML), also used for Linked to
  let bellReading = null, bellSet = null, bellTold = false;
  function keepBell(list, total) {
    const others = list.filter((h) => !isTask(h)).length;
    bellTasks = list.filter(isTask);
    store().set('bell', { at: Date.now(), total, others });
    if (bellSet) bellSet(others);
  }
  function bellOthers(total) {
    if (!total) return 0;
    const c = store().get('bell', null);
    if (c && c.total === total && Date.now() - c.at < 10 * MIN) return c.others;
    const H = window.HkAlert, url = H && H.urlGetTeasers && H.urlGetTeasers.notification;
    if (url && !bellReading && !(U().http.pausedFor() > 0)) {
      bellReading = U().http.json(url).then((j) => {
        const p = (j && j.payload) || {};
        const list = (p.teasers && p.teasers.notification) || [];
        keepBell(list, p.counts && p.counts.notification !== undefined ? Number(p.counts.notification) : list.length);
      }).catch(() => {}).finally(() => { bellReading = null; });
    }
    return null;
  }
  function bell() {
    const H = window.HkAlert;
    if (!document.getElementById('alertNotifications')) return;
    if (!H || typeof H.setAlertCount !== 'function' || typeof H.getTeaserData !== 'function' || !H.urlGetTeasers) {
      if (!bellTold) {
        bellTold = true;
        document.dispatchEvent(new CustomEvent('upc-loader-error', { detail: JSON.stringify({ file: 'to-do.user.js', message: 'Halaxy\'s bell has changed (HkAlert.setAlertCount, getTeaserData or urlGetTeasers not found): tasks show in it again.' }) }));
      }
      return;
    }
    if (H.__upcToDo) return;
    H.__upcToDo = true;
    const set = H.setAlertCount, get = H.getTeaserData;
    bellSet = (n) => set.call(H, 'notification', n);
    H.setAlertCount = function (zone, n) {
      if (zone === 'notification' && !isNaN(Number(n))) {
        const others = bellOthers(Number(n));
        if (others !== null) n = others;
      }
      return set.call(this, zone, n);
    };
    H.getTeaserData = function (zone, cb) {
      if (zone !== 'notification') return get.call(this, zone, cb);
      return get.call(this, zone, (r) => {
        if (Array.isArray(r)) { keepBell(r, r.length); r = r.filter((h) => !isTask(h)); }
        cb(r);
      });
    };
    // The count already on the page, from before the wrap.
    const a = document.getElementById('btn-alert-notifications'), now = a ? Number(a.getAttribute('data-count')) : NaN;
    if (!isNaN(now)) H.setAlertCount('notification', now);
  }

  function topBar() {
    const inbox = document.getElementById('alertIncomingMessages');
    const bar = document.getElementById('alertHeader') || (inbox && inbox.parentElement);
    if (!bar) return null;
    let mine = bar.querySelector('a.upc-todo-head');
    const menu = document.querySelector('a.' + MENU_CLS);
    const href = (menu && menu.getAttribute('href')) || U().base() + '/task/#' + ROUTE;
    if (!mine) {
      const box = document.createElement('div');
      box.className = 'headIcon upc-todo-headbox';
      mine = document.createElement('a');
      mine.className = 'fa-stack upc-todo-head';
      mine.title = 'To do';
      mine.setAttribute('aria-label', 'To do');
      const ic = iconOf(bar);
      mine.innerHTML = ic ? '<i class="icon ' + ic + '"></i>' : DRAWN;
      box.appendChild(mine);
      bar.insertBefore(box, inbox || bar.firstChild);
    }
    if (mine.getAttribute('href') !== href) mine.setAttribute('href', href);
    if (inbox && inbox.style.display !== 'none') inbox.style.setProperty('display', 'none', 'important');
    return mine;
  }

  // Halaxy's two-step pop-ups (Mark as completed, Revert): the pop-up, then its one-time link.
  async function twoStep(id, step, what) {
    const { json, doc } = await U().http.popup('/task/' + encodeURIComponent(id) + '/' + step);
    const link = [...doc.querySelectorAll('a[href]')].find((a) => new RegExp('/task/' + id + '/' + step + '/[^/?#]+').test(a.getAttribute('href')));
    if (!link) throw new (U().Error)('The ' + what + ' pop-up has changed (no ' + what + ' link' + (json && json.title ? ' in "' + json.title + '"' : '') + ').');
    const res = await U().http.json(link.getAttribute('href'));
    if (res && res.status === 'FORM') throw new (U().Error)('Halaxy did not ' + (step === 'complete' ? 'mark the task completed' : 'reopen the task') + '.');
  }
  const complete = (id) => twoStep(id, 'complete', 'Task Completion');
  const revert = (id) => twoStep(id, 'revert', 'Revert Task');

  // Move: the task's Edit pop-up saved with only the due date changed.
  async function move(id, dayMs) {
    const path = '/task/' + encodeURIComponent(id);
    const { doc } = await U().http.popup(path);
    const form = doc.querySelector('form#form_task_edit');
    if (!form || !form.querySelector('[name="form[displayDueDate]"]') || !form.querySelector('[name="form[_token]"]')) throw new (U().Error)('The Edit task pop-up has changed (form[displayDueDate] not found).');
    const pairs = U().http.serialize(form).map(([k, v]) => [k, k === 'form[displayDueDate]' ? (dayMs === null ? '' : label(dayMs)) : v]);
    U().http.expectRefresh(await U().http.postForm(path, pairs), 'The new due date');
  }

  // ------------------------------------------------------------------ queue and Undo

  const jobs = [];
  let busy = null;
  const done = new Map();   // task id -> 'done' | 'moved' | 'back' | 'error'
  const before = new Map(); // task id -> its due day before it was moved (for the row's Undo)
  const movedTo = new Map(); // task id -> the day it was moved to
  // A moved task stays in the list it was in, at its old place, until Check now or To do is opened again (CH, 24 Nov
  // 2026: it vanished from where it was, so you had to look for it): task id -> that list.
  const stay = new Map();
  const state = { unmount: null, loading: false, error: '', errors: [], undo: null, view: 'list', week: 0 };
  // List or Week, and the week shown, kept for this person on this PC (CH, 24 Nov 2026: a save in one of Halaxy's
  // pop-ups reloads the page, which went back to List).
  const keepView = () => { store().set('view:' + me(), { view: state.view, week: state.week }); };
  const restoreView = () => { const v = store().get('view:' + me(), null); if (v && (v.view === 'list' || v.view === 'week')) { state.view = v.view; state.week = Number(v.week) || 0; } };
  let root = null;
  const queuedOf = (id) => (busy === id ? 'busy' : jobs.some((j) => j.id === id) ? 'queued' : null);
  const patch = (id, fn) => { const c = store().get('open', null); if (!c) return; c.open = c.open.map((t) => (t.id === id ? fn(t) : t)); store().set('open', c); };

  async function pump() {
    if (busy !== null || !jobs.length) return;
    const j = jobs.shift();
    busy = j.id;
    render();
    try {
      if (j.kind === 'done') { await complete(j.id); patch(j.id, (t) => Object.assign(t, { completed: true })); done.set(j.id, 'done'); }
      else if (j.kind === 'revert') { await revert(j.id); patch(j.id, (t) => Object.assign(t, { completed: false })); done.delete(j.id); }
      else { await move(j.id, j.day); patch(j.id, (t) => Object.assign(t, { due: j.day, status: 'Pending' })); done.set(j.id, j.undo ? 'back' : 'moved'); if (j.undo) stay.delete(j.id); else movedTo.set(j.id, j.day); }
    } catch (e) { done.set(j.id, 'error'); state.errors.push('Not changed: ' + j.title + ' (' + (e.message || e) + ')'); }
    finally { busy = null; settleUndo(); render(); paintBadge(); pump(); }
  }
  window.addEventListener('beforeunload', (e) => { if (busy !== null || jobs.length) { e.preventDefault(); e.returnValue = ''; } });

  function act(kind, ids, dayMs) {
    const c = store().get('open', null);
    const ts = (c ? c.open : []).filter((t) => ids.includes(t.id) && !queuedOf(t.id) && !t.completed);
    if (!ts.length) return;
    const undo = [];
    ts.forEach((t) => {
      if (kind === 'done') { jobs.push({ id: t.id, title: t.title, kind: 'done' }); undo.push({ id: t.id, title: t.title, kind: 'revert' }); }
      else { jobs.push({ id: t.id, title: t.title, kind: 'move', day: dayMs }); undo.push({ id: t.id, title: t.title, kind: 'move', day: t.due === null ? null : dayStart(t.due), undo: true }); }
    });
    if (kind !== 'done') ts.forEach((t) => { if (!stay.has(t.id)) { stay.set(t.id, groupOf(t)); before.set(t.id, t.due === null ? null : dayStart(t.due)); } });
    const what = ts.length === 1 ? '"' + ts[0].title + '"' : ts.length + ' tasks';
    if (state.undo && state.undo.toast) state.undo.toast.close();
    state.undo = { jobs: undo };
    // Undo in a toast (CH, 23 Nov 2026: not a bar across the page). It stays while the batch is still going, then for
    // UNDO_FOR (CH, 24 Nov 2026: it went before the last task was done); each row keeps its own Undo after that.
    state.undo.toast = U().ui.toast(kind === 'done' ? 'Marked as completed: ' + what + '.' : 'Moved ' + what + ' to ' + label(dayMs) + '.', { action: { label: 'Undo', fn: undoLast }, ms: 0 });
    ['overdue', 'today', 'week', 'later', 'nodate'].forEach((l) => U().ui.list.unpick(l, ts.map((t) => t.id)));
    render();
    pump();
  }
  // Once every task of the last batch is done, its toast goes UNDO_FOR later (and with it the batch Undo).
  function settleUndo() {
    const u = state.undo;
    if (!u || u.settling || u.jobs.some((j) => queuedOf(j.id))) return;
    u.settling = true;
    if (u.toast) u.toast.closeIn(UNDO_FOR);
    setTimeout(() => { if (state.undo === u) state.undo = null; }, UNDO_FOR + 50);
  }
  // Undo on one row: a task marked completed is reverted, a moved one goes back to its date before.
  function undoRow(id) {
    if (queuedOf(id)) return;
    const c = store().get('open', null), t = (c ? c.open : []).find((x) => x.id === id);
    if (!t) return;
    if (t.completed) jobs.push({ id, title: t.title, kind: 'revert' });
    else if (done.get(id) === 'moved' && before.has(id)) jobs.push({ id, title: t.title, kind: 'move', day: before.get(id), undo: true });
    else return;
    if (state.undo) state.undo.jobs = state.undo.jobs.filter((j) => j.id !== id);
    render();
    pump();
  }
  function undoLast() {
    const u = state.undo;
    if (!u) return;
    state.undo = null;
    u.jobs.forEach((j) => {
      const i = jobs.findIndex((x) => x.id === j.id);
      if (i >= 0) { jobs.splice(i, 1); done.delete(j.id); } else jobs.push(j);   // not started yet: just drop it
    });
    render();
    pump();
  }

  // ------------------------------------------------------------------ Halaxy's pop-ups

  async function openEdit(id) {
    const ok = await U().ui.halaxyPopup('/task/' + encodeURIComponent(id), () => refresh(true));
    if (!ok) window.open(U().base() + '/task/' + encodeURIComponent(id), '_blank', 'noopener');
  }

  const LINKS = { none: 'Nothing', patient: 'A patient', invoice: 'An invoice', organisation: 'An organisation' };
  async function lookup(kind, term) {
    const path = { patient: '/a/magic/lookup/patient?includeContacts=1&term=', invoice: '/a/magic/lookup/invoice?term=', organisation: '/a/magic/lookup/organisation?term=' }[kind];
    const j = await U().http.json(path + encodeURIComponent(term) + '&_locale=' + encodeURIComponent(U().pg()));
    return ((j && j.lookup) || []).slice(0, 12).map((x) => {
      const p = x.payload || {};
      const id = kind === 'patient' ? p.pag && p.pag.id : x.id;
      return { id: id ? String(id) : '', text: clean(U().htmlDoc(x.title || p.displayValue || '').body.textContent) };
    }).filter((x) => x.id);
  }

  function newTask() {
    U().ui.nativeStyles();
    const dlg = U().ui.dialog({ title: 'New task', key: 'upc-todo-new', small: true });
    if (!dlg) return;
    dlg.root.classList.add('upc-todo-new');
    dlg.root.setAttribute('data-upc-todo-new', '');
    dlg.body.innerHTML = '<label for="upc-tn-link">Linked to</label><select id="upc-tn-link" class="form-control">' + Object.entries(LINKS).map(([k, v]) => '<option value="' + k + '">' + esc(v) + '</option>').join('') + '</select>' +
      '<div data-upc-tn-find hidden><label for="upc-tn-term">Find</label><div class="upc-todo-find"><input id="upc-tn-term" class="form-control" placeholder="Type to search" autocomplete="off" role="combobox"><div class="upc-todo-found" data-upc-tn-found role="listbox" hidden></div></div></div>' +
      '<div class="alert alert-danger upc-err upc-gap" data-upc-tn-err hidden></div>' +
      '<div class="upc-actions"><button type="button" class="btn btn-outline-primary" data-c="no">Cancel</button><button type="button" class="btn btn-primary" data-c="yes">Continue</button></div>';
    const $q = (s) => dlg.body.querySelector(s);
    let picked = null, timer = null;
    const err = (m) => { const e = $q('[data-upc-tn-err]'); e.textContent = m; e.hidden = !m; };
    const kindNow = () => $q('#upc-tn-link').value;
    $q('#upc-tn-link').addEventListener('change', () => { picked = null; $q('[data-upc-tn-find]').hidden = kindNow() === 'none'; $q('#upc-tn-term').value = ''; $q('[data-upc-tn-found]').innerHTML = ''; $q('[data-upc-tn-found]').hidden = true; err(''); });
    // Search as you type, results in a dropdown under the box like Halaxy's top search: arrow keys and Enter, or click.
    const box = $q('#upc-tn-term'), list = $q('[data-upc-tn-found]');
    let found = [], active = -1;
    const show = () => {
      list.hidden = !found.length && !list.dataset.msg;
      list.innerHTML = found.length ? found.map((x, i) => '<div class="upc-todo-opt' + (i === active ? ' upc-todo-opt-on' : '') + '" role="option" data-i="' + i + '">' + esc(x.text) + '</div>').join('')
        : list.dataset.msg ? '<div class="upc-todo-opt text-muted">' + esc(list.dataset.msg) + '</div>' : '';
    };
    const pick = (i) => { const x = found[i]; if (!x) return; picked = x; box.value = x.text; found = []; active = -1; list.dataset.msg = ''; show(); };
    box.addEventListener('input', () => {
      clearTimeout(timer); picked = null; found = []; active = -1; list.dataset.msg = '';
      const term = clean(box.value);
      if (term.length < 3) { show(); return; }
      list.dataset.msg = 'Searching...'; show();
      timer = setTimeout(async () => {
        try {
          const xs = await lookup(kindNow(), term);
          if (clean(box.value) !== term) return;
          found = xs; active = xs.length ? 0 : -1; list.dataset.msg = xs.length ? '' : 'None.'; show();
        } catch (e) { list.dataset.msg = ''; show(); err('Could not search: ' + (e.message || e)); }
      }, 350);
    });
    box.addEventListener('keydown', (e) => {
      if (!found.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); active = (active + (e.key === 'ArrowDown' ? 1 : found.length - 1)) % found.length; show(); }
      else if (e.key === 'Enter') { e.preventDefault(); pick(active); }
      else if (e.key === 'Escape') { e.stopPropagation(); found = []; show(); }
    });
    list.addEventListener('mousedown', (e) => { const o = e.target.closest('[data-i]'); if (o) { e.preventDefault(); pick(+o.dataset.i); } });
    dlg.body.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-c]');
      if (!b) return;
      if (b.dataset.c === 'no') { dlg.close(); return; }
      const kind = kindNow();
      if (kind !== 'none' && !picked) { err('Search for the ' + kind + ' and choose one.'); return; }
      const path = kind === 'patient' ? '/task/new/linkPaG/' + encodeURIComponent(picked.id) : kind === 'invoice' ? '/task/new/invoice/' + encodeURIComponent(picked.id)
        : kind === 'organisation' ? '/task/new/organisation/' + encodeURIComponent(picked.id) : '/task/new';
      dlg.close();
      const ok = await U().ui.halaxyPopup(path, () => refresh(true));
      if (!ok) { state.errors.push('Halaxy\'s add-task pop-up did not open. Add the task from Tasks & Follow-Ups.'); render(); }
    });
  }

  // ------------------------------------------------------------------ the page

  const filters = () => Object.assign({ who: 'me', type: 'all' }, store().get('filters:' + me(), {}) || {});
  const setFilter = (k, v) => { const f = filters(); f[k] = v; store().set('filters:' + me(), f); };

  // What a task is linked to, by name (CH, 24 Nov 2026: "the invoice number or patient name, not just Patient").
  // Halaxy's task list gives only the kind (type); the task's Edit pop-up (GET /task/:id) links the record itself,
  // e.g. "Invoice UPC-012235" -> /invoice/:id, the patient's name -> /patient/:id, "Appointment: ..." -> /appointment/:id,
  // the organisation -> /organisation/:id, "Clinical note ..." -> /patient/:id/clinical/:id (capture 24 Nov 2026). Read
  // once per task, only for linked tasks on screen, one at a time at Halaxy's pace, and kept on this PC (a task's link
  // doesn't change). Tasks in the bell's list (Halaxy's own teasers, already on the page: "for <patient>") are taken from
  // there first, at no cost.
  const LINKED = /\/(invoice|patient|appointment|organisation)\/\d+/;
  const links = () => store().get('links', {});
  const linkOf = (id) => links()[id] || null;
  function keepLink(id, v) { const m = links(); m[id] = Object.assign({ at: Date.now() }, v); store().set('links', m); }
  function fromBell() {
    const kept = bellTasks.map((h) => { const d = document.createElement('div'); d.innerHTML = h; return d; });
    [...document.querySelectorAll('#alertHeader .viewTeaser')].concat(kept).forEach((teaser) => {
      const task = teaser.querySelector('a[href*="/task/"]');
      const id = task && (task.getAttribute('href').match(/\/task\/(\d+)/) || [])[1];
      if (!id || linkOf(id)) return;
      const rec = [...teaser.querySelectorAll('a[href]')].find((a) => a !== task && LINKED.test(a.getAttribute('href')));
      if (rec) keepLink(id, { t: clean(rec.textContent), h: rec.getAttribute('href').replace(/^.*\/a\/pr\/\d+/, '') });
    });
  }
  const linkWant = new Set();
  let linkBusy = false;
  async function readLinks() {
    if (linkBusy) return;
    linkBusy = true;
    try {
      while (linkWant.size && root) {
        const id = linkWant.values().next().value;
        linkWant.delete(id);
        if (linkOf(id)) continue;
        try {
          const { doc } = await U().http.popup('/task/' + encodeURIComponent(id));
          const a = [...doc.querySelectorAll('a[href]')].find((x) => LINKED.test(x.getAttribute('href')) && !/\/task\//.test(x.getAttribute('href')));
          keepLink(id, a ? { t: clean(a.textContent), h: a.getAttribute('href').replace(/^.*\/a\/pr\/\d+/, '') } : { t: '', h: '' });
        } catch (e) { /* shown by kind only; tried again next time the page opens */ }
        paintLinks();
      }
    } finally { linkBusy = false; }
  }
  // The linked records of the tasks on screen: shown where known, the rest asked for.
  function paintLinks() {
    if (!root) return;
    fromBell();
    const base = U().base();
    root.querySelectorAll('[data-upc-link]').forEach((el) => {
      const id = el.getAttribute('data-upc-link'), l = linkOf(id);
      if (l && l.t && l.h) {
        if (el.getAttribute('data-done') !== l.h) { el.innerHTML = '<a href="' + esc(base + l.h) + '" target="_blank" rel="noopener">' + esc(l.t) + '</a>'; el.setAttribute('data-done', l.h); }
      } else if (!l && el.offsetParent !== null) linkWant.add(id);   // only rows showing (not past "Show 25 more" or searched out)
    });
    if (linkWant.size) readLinks();
  }
  const linkCell = (t) => (t.type ? '<span data-upc-link="' + esc(t.id) + '">' + esc(t.type) + '</span>' : '');

  function row(t, today) {
    const q = queuedOf(t.id), d = done.get(t.id);
    const P = U().ui.page;
    const undoBtn = '<button type="button" class="btn btn-outline-primary-light upc-todo-undo" data-a="undo1" data-id="' + esc(t.id) + '">Undo</button>';
    const act = q === 'busy' ? U().ui.run.inline('') : q === 'queued' ? P.pill('Queued', 'wait')
      : t.completed ? P.pill('Completed') + undoBtn
      : (d === 'moved' ? P.pill('Moved to ' + label(movedTo.get(t.id))) + undoBtn : d === 'error' ? P.pill('Not changed', 'err') : '') + '<button type="button" class="btn btn-outline-primary-light" data-a="done" data-id="' + esc(t.id) + '">Done</button>';
    const f = filters();
    return '<tr data-upc-id="' + esc(t.id) + '"' + (q || t.completed ? ' data-upc-nopick' : '') + '><td><a class="upc-todo-task" href="' + esc(U().base() + '/task/' + t.id) + '" data-a="edit" data-id="' + esc(t.id) + '">' + esc(t.title || 'Task') + '</a></td>' +
      '<td>' + linkCell(t) + '</td><td class="upc-todo-due' + (t.due !== null && t.due < today ? ' upc-todo-late' : '') + '" data-sort="' + esc(t.due === null ? '' : label(t.due)) + '">' + esc(dueText(t.due)) + '</td>' +
      '<td data-sort="' + (PRIORITY[t.priority] || 0) + '">' + esc(t.priority) + '</td>' + (f.who === 'me' ? '' : '<td>' + esc(t.who.join(', ')) + '</td>') + '<td class="upc-todo-act">' + act + '</td></tr>';
  }

  function table(listId, ts) {
    const today = dayStart(Date.now()), f = filters();
    return '<table class="table table-striped table-bordered w-100 m-0" data-upc-list="' + listId + '" data-upc-pick><thead><tr><th>Task</th><th>Linked To</th><th>Due</th><th>Priority</th>' + (f.who === 'me' ? '' : '<th>For</th>') + '<th data-upc-nosort></th></tr></thead><tbody>' +
      ts.map((t) => row(t, today)).join('') + '</tbody></table>';
  }

  function bulk(listId, ts) {
    const ids = U().ui.list.picked(listId), n = ts.filter((t) => ids.includes(t.id)).length;
    if (!n) return '';
    return '<span data-upc-bulk-for="' + listId + '"><span class="text-muted">' + n + ' ticked</span>' +
      '<button type="button" class="btn btn-primary" data-a="bulk-done" data-list="' + listId + '">Done</button>' +
      '<input type="text" class="form-control" placeholder="Move to..." data-upc-move="' + listId + '" aria-label="Move to a date"></span>';
  }

  function listView(ts) {
    const g = groups(ts, true);
    let h = '';
    [['overdue', 'Overdue'], ['today', 'Today'], ['week', 'This week'], ['later', 'Later'], ['nodate', 'No date']].forEach(([id, title]) => {
      if (id === 'nodate' && !g.nodate.length) return;
      h += U().ui.page.card(title, g[id].length, '', bulk(id, g[id]) + table(id, g[id]));
    });
    return h;
  }

  function chip(t) {
    return '<div class="upc-todo-chip" draggable="true" data-chip="' + esc(t.id) + '"><a class="upc-todo-task" href="' + esc(U().base() + '/task/' + t.id) + '" data-a="edit" data-id="' + esc(t.id) + '">' + esc(t.title || 'Task') + '</a>' +
      (t.type ? '<small class="upc-todo-chiplink">' + linkCell(t) + '</small>' : '') +
      '<small class="text-muted">' + esc([t.priority, queuedOf(t.id) ? 'Queued' : ''].filter(Boolean).join(', ')) + '</small></div>';
  }

  // The signed-in practitioner's appointments each day of the week shown (CH, 24 Nov 2026: to plan workload). Not
  // counted: cancelled, did not attend, rejected, declined, rescheduled, waiting list.
  // Shown at once (0.2.16; CH, 24 Nov 2026: the counts came and went while the page loaded): each week's counts are kept
  // on the PC and shown straight away, then read again when over 15 minutes old or on Check now. The read is only this
  // practitioner's five days, as Halaxy's calendar asks for one person's week, not core's shared read of every
  // practitioner over months (slow, and queued behind Linked To's reads on a first open).
  const APPTS_FRESH = 15 * 60e3;
  const appts = { busy: null, stale: false, failedAt: 0 };
  const NOT_ON = /^(cancelled|did-not-attend|rejected|declined|rescheduled|waiting-list)$/i;
  const meIds = () => [window.HkUser && HkUser.pracID, window.HkUser && HkUser.linkPrG].filter((x) => x !== undefined && x !== null && x !== '').map(String);
  // Only for clinicians: the signed-in person is one of Halaxy's practitioners (the calendar's list), so administrators
  // see no counts (CH, 24 Nov 2026). Their practitioner number (or null), checked once a day on the PC, per person.
  async function practitionerId(me) {
    const key = 'clinician:' + me.join(','), kept = store().get(key, null);
    if (kept && 'id' in kept && Date.now() - kept.at < DAY) return kept.id;
    const pracs = await U().http.json('/lookup/practitioner?clinic=&include_id=&type=');
    const p = Array.isArray(pracs) ? pracs.find((x) => me.includes(String(x.id))) : null;
    const id = p ? String(p.id) : null;
    store().set(key, { at: Date.now(), id });
    return id;
  }
  // Kept counts: { [person]: { [monday]: { at, counts } } }, the last 8 weeks read per person.
  const keptCounts = (me, monday) => ((store().get('appts', {}) || {})[me.join(',')] || {})[monday] || null;
  function keepCounts(me, monday, counts) {
    const all = store().get('appts', {}) || {}, mine = all[me.join(',')] || {};
    mine[monday] = { at: Date.now(), counts };
    Object.keys(mine).sort((a, b) => mine[b].at - mine[a].at).slice(8).forEach((k) => delete mine[k]);
    all[me.join(',')] = mine;
    store().set('appts', all);
  }
  function apptCounts(monday) {
    const me = meIds(), kept = keptCounts(me, monday);
    const old = !kept || appts.stale || Date.now() - kept.at > APPTS_FRESH;
    if (old && appts.busy === null && Date.now() - appts.failedAt > 60e3 && !(U().http.pausedFor && U().http.pausedFor() > 0)) {
      appts.busy = monday;
      appts.stale = false;
      practitionerId(me).then(async (pid) => {
        if (!pid) return null;
        const qs = new URLSearchParams({ start: Math.floor(monday / 1000), end: Math.floor((monday + 5 * DAY) / 1000) });
        qs.append('practitioners[0][id]', pid);
        const cal = await U().http.json('/calendar/json?' + qs.toString());
        if (!cal || !cal.payload || !Array.isArray(cal.payload.events)) throw new (U().Error)('Halaxy\'s calendar data has changed (no events list).');
        return cal.payload.events.filter((e) => e.type === 'appointment');
      }).then((evs) => {
        let counts = null;
        if (evs) {
          counts = {};
          evs.filter((e) => me.includes(String(e.practitionerID)) && !NOT_ON.test(String(e.appointmentStatus || '').trim())).forEach((e) => {
            const d = dayStart(Number(e.start) * 1000);
            counts[d] = (counts[d] || 0) + 1;
          });
        }
        const was = keptCounts(me, monday);
        keepCounts(me, monday, counts);
        return !was || JSON.stringify(was.counts) !== JSON.stringify(counts);
      }).catch(() => { appts.failedAt = Date.now(); return false; }).then((changed) => { appts.busy = null; if (changed && root && state.view === 'week') render(); });
    }
    return kept ? kept.counts : null;
  }

  function weekView(ts) {
    const monday = mondayOf(Date.now()) + state.week * 7 * DAY, today = dayStart(Date.now());
    const tray = ts.filter((t) => !t.completed && (t.due === null || t.due < Math.max(today, monday)));
    let h = '<div class="upc-todo-weeknav"><button type="button" class="btn btn-outline-primary-light" data-a="week" data-step="-1">Previous Week</button>' +
      '<button type="button" class="btn btn-outline-primary-light" data-a="week" data-step="0">This Week</button><button type="button" class="btn btn-outline-primary-light" data-a="week" data-step="1">Next Week</button>' +
      '<span class="text-muted">' + esc(label(monday) + ' to ' + label(monday + 4 * DAY)) + '</span></div><div class="upc-todo-week">';
    // Headings on two lines, the same in every column (CH, 24 Nov 2026: some ran onto two lines, some didn't): the name,
    // then the date and how many tasks.
    const tasks = (n) => n + ' task' + (n === 1 ? '' : 's');
    const head = (title, sub) => '<div class="card-header upc-todo-dayhead"><h2 title="' + esc(title) + '">' + esc(title) + '</h2><div class="text-muted">' + esc(sub) + '</div></div>';
    h += '<div class="card">' + head('Overdue or No Date', tasks(tray.length)) + '<div class="card-body">' + (tray.slice(0, 40).map(chip).join('') || '<p class="text-muted m-0">None.</p>') +
      (tray.length > 40 ? '<p class="text-muted m-0">and ' + (tray.length - 40) + ' more</p>' : '') + '</div></div>';
    const counts = apptCounts(monday);
    WEEKDAYS.forEach((name, i) => {
      const day = monday + i * DAY;
      const list = ts.filter((t) => !t.completed && t.due !== null && dayStart(t.due) === day);
      const n = counts ? counts[day] || 0 : null;
      // The day's appointments as a card of its own at the top, without the task cards' purple edge (CH, 24 Nov 2026).
      h += '<div class="card upc-todo-drop" data-day="' + day + '">' + head(name, label(day).slice(0, 6) + ', ' + tasks(list.length)) + '<div class="card-body">' + (n === null ? '' : '<div class="upc-todo-appts"><i class="icon icon-calendar-full" aria-hidden="true"></i> ' + (n ? n + ' appointment' + (n === 1 ? '' : 's') : 'No appointments') + '</div>') +
        (list.map(chip).join('') || '') + '</div></div>';
    });
    return h + '</div>';
  }

  function side() {
    const lists = U().todo.all().filter((x) => x.cls && document.querySelector('#mainMenu a.' + x.cls));
    return lists.sort((a, b) => String(a.title).localeCompare(String(b.title))).map((x) =>
      '<div class="card"><div class="card-header"><h2>' + esc(U().ui.titleCase(x.title)) + ' (' + (x.count || 0) + ')</h2><a class="btn btn-outline-primary-light" href="' + esc(x.href) + '">Open</a></div><div class="card-body">' +
      ((x.rows || []).length ? '<ul>' + x.rows.map((r) => '<li>' + esc(r) + '</li>').join('') + '</ul>' + ((x.count || 0) > x.rows.length ? '<p class="text-muted m-0">and ' + (x.count - x.rows.length) + ' more</p>' : '') : '<p class="text-muted m-0">None.</p>') +
      '</div></div>').join('');
  }

  function render() {
    if (!root) return;
    const c = store().get('open', null), f = filters();
    const actions = '<button type="button" class="btn btn-primary" data-a="new">New Task</button>' +
      '<button type="button" class="btn btn-outline-primary" data-a="refresh"' + (state.loading ? ' disabled' : '') + '>' + (state.loading ? 'Checking...' : 'Check Now') + '</button>';
    const bq = U().ui.batch('to-do', 'Updating tasks', 'done', jobs.length + (busy !== null ? 1 : 0), state.errors.length);
    let h = '<div class="upc-todo">' + U().ui.page.bar('To do', actions, bq || (state.loading ? U().ui.run.inline('Reading tasks...') : U().ui.page.checked(c && c.at)));
    if (state.error) h += '<div class="alert alert-danger upc-err">' + esc(state.error) + '</div>';
    state.errors.forEach((m) => { h += '<div class="alert alert-danger upc-err">' + esc(m) + '</div>'; });
    // Who tasks can be for: Halaxy's own list of active users (the add-task form's assignees), not everyone named on an
    // old task (CH, 23 Nov 2026: staff who have left).
    const st = store().get('staff', null);
    const people = st && st.names.length ? st.names.slice().sort() : c ? [...new Set(c.open.flatMap((t) => t.who))].filter(Boolean).sort() : [];
    const types = c ? [...new Set(c.open.map((t) => t.type).filter(Boolean))].sort() : [];
    h += '<div class="upc-todo-cols"><div>' +
      '<div class="upc-todo-filters"><ul class="nav nav-tabs"><li class="nav-item"><a href="#' + ROUTE + '" class="nav-link' + (state.view === 'list' ? ' active' : '') + '" data-a="view" data-view="list">List</a></li>' +
      '<li class="nav-item"><a href="#' + ROUTE + '" class="nav-link' + (state.view === 'week' ? ' active' : '') + '" data-a="view" data-view="week">Week</a></li></ul>' +
      '<select class="form-control" data-f="who" aria-label="For"><option value="me">For me</option>' + people.filter((p) => p.toLowerCase() !== me().toLowerCase()).map((p) => '<option value="' + esc(p) + '"' + (f.who === p ? ' selected' : '') + '>For ' + esc(p) + '</option>').join('') + '<option value="all"' + (f.who === 'all' ? ' selected' : '') + '>For everyone</option></select>' +
      '<select class="form-control" data-f="type" aria-label="Linked to"><option value="all">Linked to anything</option>' + types.map((t) => '<option value="' + esc(t) + '"' + (f.type === t ? ' selected' : '') + '>' + esc(t) + '</option>').join('') + '<option value="none"' + (f.type === 'none' ? ' selected' : '') + '>Not linked</option></select></div>';
    if (c) h += state.view === 'week' ? weekView(shown(c, f)) : listView(shown(c, f));
    h += '</div><div class="upc-todo-side">' + side() + '</div></div></div>';
    root.innerHTML = h;
    U().ui.list.enhance(root, { onPick: render });
    paintLinks();
    // Move to: Halaxy's date picker (flatpickr, which its pages load), or the browser's where it isn't there.
    root.querySelectorAll('input[data-upc-move]').forEach((inp) => {
      const go = (ms) => { if (ms !== null) act('move', U().ui.list.picked(inp.dataset.upcMove), dayStart(ms)); };
      inp.type = 'date';
      const p = U().ui.datePicker(inp, { minDate: 'today', onChange: (sel) => { if (sel && sel[0]) go(sel[0].getTime()); } });
      if (!p) inp.addEventListener('change', () => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(inp.value); if (m) go(new Date(+m[1], +m[2] - 1, +m[3]).getTime()); });
    });
  }

  // fresh (Check now, To do opened): results and held places go; after Halaxy's own pop-ups they stay.
  async function refresh(force, fresh) {
    if (state.loading) return;
    state.loading = true; state.error = '';
    if (force && fresh) appts.stale = true;   // Check now: the appointment counts are read again too
    if (fresh && !jobs.length && busy === null) { state.errors = []; done.clear(); stay.clear(); before.clear(); movedTo.clear(); }
    render();
    try { await load(force); } catch (e) { state.error = 'Could not read the tasks: ' + (e.message || e); }
    state.loading = false;
    render();
  }

  function mount() {
    if (state.unmount) return;
    restoreView();
    U().ui.nativeStyles();
    root = document.createElement('div');
    root.className = 'upc-native upc-page-wide';
    root.setAttribute('data-upc-to-do', '');
    root.addEventListener('click', () => setTimeout(paintLinks, 60));   // "Show 25 more", search and sorting show other rows
    root.addEventListener('input', () => setTimeout(paintLinks, 300));
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-a]');
      if (!b || b.disabled) return;
      const a = b.dataset.a;
      if (a === 'edit' || a === 'view') e.preventDefault();
      if (a === 'refresh') refresh(true, true);
      else if (a === 'new') newTask();
      else if (a === 'edit') openEdit(b.dataset.id);
      else if (a === 'done') act('done', [b.dataset.id]);
      else if (a === 'bulk-done') act('done', U().ui.list.picked(b.dataset.list));
      else if (a === 'undo') undoLast();
      else if (a === 'undo1') undoRow(b.dataset.id);
      else if (a === 'view') { state.view = b.dataset.view; keepView(); render(); }
      else if (a === 'week') { state.week = b.dataset.step === '0' ? 0 : state.week + Number(b.dataset.step); keepView(); render(); }
    });
    root.addEventListener('change', (e) => { const s = e.target.closest('select[data-f]'); if (s) { setFilter(s.dataset.f, s.value); render(); } });
    // Week view: drag a task onto a day.
    root.addEventListener('dragstart', (e) => { const c = e.target.closest && e.target.closest('[data-chip]'); if (c) e.dataTransfer.setData('text/plain', c.dataset.chip); });
    root.addEventListener('dragover', (e) => { const d = e.target.closest && e.target.closest('.upc-todo-drop'); if (d) { e.preventDefault(); d.classList.add('upc-todo-over'); } });
    root.addEventListener('dragleave', (e) => { const d = e.target.closest && e.target.closest('.upc-todo-drop'); if (d) d.classList.remove('upc-todo-over'); });
    root.addEventListener('drop', (e) => {
      const d = e.target.closest && e.target.closest('.upc-todo-drop');
      if (!d) return;
      e.preventDefault();
      const id = e.dataTransfer.getData('text/plain');
      if (id) act('move', [id], Number(d.dataset.day));
    });
    state.unmount = U().ui.mountPage('To do', root, MENU_CLS);
    render();
    refresh(false, true);
  }
  function unmount() { if (!state.unmount) return; state.unmount(); state.unmount = null; root = null; }
  const route = () => (location.hash === '#' + ROUTE ? mount() : unmount());

  function background() {
    if (!U().background.ok() || !me()) return;
    const c = store().get('open', null);
    if (c && !U().background.due(c.at, BADGE_EVERY)) { paintBadge(); return; }
    load(true).catch((e) => console.warn('[UPC to do]', e));
  }

  function start() {
    if (!U() || !U().todo || !U().ui.list || !U().ui.halaxyPopup) { console.error('[UPC to do] needs the core library'); return; }
    if (!document.getElementById('upc-todo-css')) { const st = document.createElement('style'); st.id = 'upc-todo-css'; st.textContent = CSS; document.head.appendChild(st); }
    U().ui.ensureMenuItem('To do', (section) => {
      const t = section && [...section.querySelectorAll('a.mainmenu-sublink')].find((a) => /^tasks/i.test(clean(a.textContent)));
      return (t ? t.getAttribute('href').split('#')[0] : U().base() + '/task/') + '#' + ROUTE;
    }, MENU_CLS, /^schedule$/i);
    // Back to To do after one of Halaxy's pop-ups reloaded the page.
    // Halaxy reloads keeping the address, so the page may already be To do: either way the tasks are read afresh, so
    // the new or changed task shows straight away (CH, 24 Nov 2026: it needed Check now).
    if (U().ui.halaxyPopupReturn() === '#' + ROUTE) { store().set('open', null); if (location.hash !== '#' + ROUTE) location.hash = ROUTE; }
    window.addEventListener('hashchange', route);
    window.addEventListener('storage', (e) => { if (e.key && e.key.startsWith('upc-todo')) { paintBadge(); if (root && !state.loading) render(); } });
    route();
    setTimeout(paintBadge, 3000);
    bell();
    setTimeout(bell, 3000);   // in case Halaxy's alerts start after us
    setTimeout(background, 30000);
    setInterval(background, 5 * MIN);
    setInterval(paintBadge, 5000);   // Halaxy redraws its top bar on some pages: put To do back
    document.addEventListener('visibilitychange', background);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  window.upcToDo = { version: VERSION, load, groups, complete, revert, move, lookup };
})();
