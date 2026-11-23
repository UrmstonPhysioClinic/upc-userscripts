// ==UserScript==
// @name         UPC Schedule: To do (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.1.0
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/to-do.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/to-do.user.js
// @description  Schedule > To do: your Halaxy tasks by when they are due (Done, move to tomorrow or Monday, several at once, New task linked to a patient, invoice or organisation), then a card for each of our lists you can open.
// @match        https://*.halaxy.com/a/pr/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * To do (CH, 20 to 23 Nov 2026; plan in claude/my-tasks-plan.md, UI/UX audit step 2).
 *
 *  - Tasks: Halaxy's GET /task/data (every task, every person; what its Tasks page loads), the signed-in person's open
 *    ones grouped Overdue, Today, This week, Later, No date. Read when the page opens (kept on this PC for 5 minutes)
 *    and for the menu badge (overdue and due today) at most hourly, in the visible tab.
 *  - Done: Halaxy's Mark as completed (GET /task/{id}/complete, then its Complete link). Move to tomorrow or Monday: the
 *    task's Edit pop-up (/task/{id}) saved with only the due date changed (time and everything else as Halaxy filled
 *    it). Confirmed, then queued (Queue, don't block); ticked rows do several at once.
 *  - New task: our pop-up. Linked to nothing, a patient, an invoice or an organisation (the same lookups as Halaxy's
 *    top search); saved through Halaxy's own add-task form (/task/new, /task/new/linkPaG/{id}, /task/new/invoice/{id},
 *    /task/new/organisation/{id}); the comment starts with a stamp ("2026-11-23 15:50 CH"), as Task stamps does.
 *  - Lists: a card per list page this person can open (its menu item is in their menu), with the count and top rows
 *    each page publishes (core UPC.todo).
 */
(() => {
  'use strict';
  if (window.__hxToDo) return;
  window.__hxToDo = true;

  const VERSION = '0.1.0';
  const ROUTE = 'upc-to-do';
  const MENU_CLS = 'upc-todo-menu';
  const DAY = 864e5, MIN = 60e3;
  const FRESH = 5 * MIN, BADGE_EVERY = 60 * MIN;
  const U = () => window.UPC;
  const esc = (s) => U().esc(s);
  const clean = (s) => String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim();
  const two = (n) => String(n).padStart(2, '0');
  const label = (ms) => U().dayLabel(ms);
  const store = () => U().storage('upc-todo-tasks:');
  const me = () => U().user.name([]);
  const PRIORITY = { Low: 1, Medium: 2, High: 3 };
  const CSS = `
    .upc-todo .card { margin-bottom: 24px; }
    .upc-todo .card-header h2 { margin: 0; }
    .upc-todo td.upc-todo-due, .upc-todo td.upc-todo-act { white-space: nowrap; }
    .upc-todo td.upc-todo-act .btn { margin: 0 4px 0 0; }
    .upc-todo .upc-todo-late { color: var(--vs-balance-negative-color, #b3261e); }
    .upc-todo .upc-todo-lists { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 0 24px; }
    .upc-todo .upc-todo-lists .card-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .upc-todo .upc-todo-lists .card-header .btn { margin: 0; }
    .upc-todo .upc-todo-lists ul { margin: 0; padding-left: 18px; }
    .upc-todo-badge { display: inline-block; min-width: 18px; margin-left: 6px; padding: 0 5px; border-radius: 9px; font-size: .75em; line-height: 18px;
      text-align: center; font-weight: 600; color: #fff; background: var(--vs-notification-badge-bg-color, #ec6b65); vertical-align: middle; }
    .upc-todo-new .upc-todo-found { max-height: 220px; overflow: auto; margin-top: 4px; }
    .upc-todo-new .upc-todo-found button { display: block; width: 100%; text-align: left; margin: 0 0 2px; }
    .upc-todo-new label { display: block; margin: 12px 0 4px; font-weight: 600; }
  `;

  // ------------------------------------------------------------------ tasks

  const dayStart = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const dueOf = (t) => { const ms = Date.parse(t.due_date || ''); return isNaN(ms) ? null : ms; };
  const hasTime = (ms) => { const d = new Date(ms); return d.getHours() || d.getMinutes(); };
  const dueText = (ms) => (ms === null ? '' : label(ms) + (hasTime(ms) ? ' ' + two(new Date(ms).getHours()) + ':' + two(new Date(ms).getMinutes()) : ''));

  async function load(force) {
    const c = store().get('mine', null);
    if (!force && c && c.who === me() && Date.now() - c.at < FRESH) return c;
    const all = await U().http.json('/task/data');
    if (!Array.isArray(all)) throw new (U().Error)('Halaxy\'s task list has changed (/task/data is not a list).');
    const who = me().toLowerCase();
    const mine = all.filter((t) => t && t.status !== 'Completed' && Array.isArray(t.assignees) && t.assignees.some((a) => clean(a).toLowerCase() === who))
      .map((t) => ({ id: String(t.id), title: clean(t.title), type: clean(t.type), priority: clean(t.priority), due: dueOf(t), status: t.status }));
    const r = { at: Date.now(), who: me(), mine };
    store().set('mine', r);
    paintBadge();
    return r;
  }

  function groups(mine) {
    const today = dayStart(Date.now()), tomorrow = today + DAY;
    const sunday = (() => { const d = new Date(today); d.setDate(d.getDate() + ((7 - d.getDay()) % 7) + 1); return d.getTime(); })();   // the start of next Monday
    const g = { overdue: [], today: [], week: [], later: [], nodate: [] };
    mine.forEach((t) => {
      if (t.due === null) g.nodate.push(t);
      else if (t.due < today || t.status === 'Overdue') g.overdue.push(t);
      else if (t.due < tomorrow) g.today.push(t);
      else if (t.due < sunday) g.week.push(t);
      else g.later.push(t);
    });
    Object.values(g).forEach((l) => l.sort((a, b) => (a.due || 0) - (b.due || 0) || (PRIORITY[b.priority] || 0) - (PRIORITY[a.priority] || 0)));
    return g;
  }

  function paintBadge() {
    const a = document.querySelector('a.' + MENU_CLS);
    if (!a) return;
    const c = store().get('mine', null);
    const g = c && c.who === me() ? groups(c.mine) : null;
    const n = g ? g.overdue.concat(g.today).filter((t) => !t.completed).length : 0;
    let b = a.querySelector('.upc-todo-badge');
    if (!n) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('span'); b.className = 'upc-todo-badge'; a.appendChild(b); }
    const text = n > 99 ? '99+' : String(n);
    if (b.textContent !== text) b.textContent = text;
    const title = n + ' task' + (n === 1 ? '' : 's') + ' overdue or due today';
    if (b.title !== title) b.title = title;
  }

  // Done: Halaxy's Mark as completed pop-up, then its Complete link.
  async function complete(id) {
    const { json, doc } = await U().http.popup('/task/' + encodeURIComponent(id) + '/complete');
    const link = [...doc.querySelectorAll('a[href]')].find((a) => new RegExp('/task/' + id + '/complete/[^/?#]+').test(a.getAttribute('href')));
    if (!link) throw new (U().Error)('The Task Completion pop-up has changed (no Complete link' + (json && json.title ? ' in "' + json.title + '"' : '') + ').');
    const res = await U().http.json(link.getAttribute('href').replace(/^https?:\/\/[^/]+/, '').replace(/^\/a\/pr\/\d+/, ''));
    if (res && res.status === 'FORM') throw new (U().Error)('Halaxy did not mark the task completed.');
  }

  // Move: the task's Edit pop-up saved with only the due date changed.
  async function move(id, dayMs) {
    const path = '/task/' + encodeURIComponent(id);
    const { doc } = await U().http.popup(path);
    const form = doc.querySelector('form#form_task_edit');
    if (!form || !form.querySelector('[name="form[displayDueDate]"]') || !form.querySelector('[name="form[_token]"]')) throw new (U().Error)('The Edit task pop-up has changed (form[displayDueDate] not found).');
    const pairs = U().http.serialize(form).map(([k, v]) => [k, k === 'form[displayDueDate]' ? label(dayMs) : v]);
    U().http.expectRefresh(await U().http.postForm(path, pairs), 'The new due date');
  }

  // ------------------------------------------------------------------ queue

  const jobs = [];
  let busy = null;
  const done = new Map();   // task id -> 'done' | 'moved <ms>' | error text
  const state = { unmount: null, loading: false, error: '', errors: [] };
  let root = null;
  const queuedOf = (id) => (busy === id ? 'busy' : jobs.some((j) => j.id === id) ? 'queued' : null);
  async function pump() {
    if (busy !== null || !jobs.length) return;
    const j = jobs.shift();
    busy = j.id;
    render();
    try {
      if (j.kind === 'done') { await complete(j.id); done.set(j.id, 'done'); } else { await move(j.id, j.day); done.set(j.id, 'moved ' + j.day); }
      const c = store().get('mine', null);
      if (c) {
        // Kept on the page until the next read ("Completed" in its row), but no longer counted in the badge.
        c.mine = c.mine.map((t) => (t.id !== j.id ? t : j.kind === 'done' ? Object.assign(t, { completed: true }) : Object.assign(t, { due: j.day, status: 'Pending' })));
        store().set('mine', c);
      }
    } catch (e) { done.set(j.id, 'error'); state.errors.push('Not changed: ' + j.title + ' (' + (e.message || e) + ')'); }
    finally { busy = null; render(); paintBadge(); pump(); }
  }
  window.addEventListener('beforeunload', (e) => { if (busy !== null || jobs.length) { e.preventDefault(); e.returnValue = ''; } });

  function confirmBox(title, html, yes) {
    return new Promise((resolve) => {
      let answered = false;
      const end = (v) => { if (!answered) { answered = true; resolve(v); } };
      const dlg = U().ui.dialog({ title, small: true, onClose: () => end(false) });
      dlg.root.setAttribute('data-upc-todo-confirm', '');
      dlg.body.innerHTML = html + '<div class="upc-actions"><button type="button" class="btn btn-outline-primary" data-c="no">Cancel</button><button type="button" class="btn btn-primary" data-c="yes">' + esc(yes) + '</button></div>';
      dlg.body.addEventListener('click', (e) => { const b = e.target.closest('[data-c]'); if (!b) return; end(b.dataset.c === 'yes'); dlg.close(); });
    });
  }

  const tomorrowMs = () => dayStart(Date.now()) + DAY;
  const mondayMs = () => { const d = new Date(dayStart(Date.now())); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return d.getTime(); };

  async function act(kind, ids) {
    const c = store().get('mine', null);
    const ts = (c ? c.mine : []).filter((t) => ids.includes(t.id) && !queuedOf(t.id) && !done.has(t.id));
    if (!ts.length) return;
    const day = kind === 'tomorrow' ? tomorrowMs() : kind === 'monday' ? mondayMs() : null;
    const what = ts.length === 1 ? '"' + ts[0].title + '"' : ts.length + ' tasks';
    const q = kind === 'done' ? 'Mark ' + what + ' as completed?' : 'Move ' + what + ' to ' + label(day) + '?';
    const list = ts.length > 1 ? '<p class="text-muted">' + esc(ts.slice(0, 10).map((t) => t.title).join(', ') + (ts.length > 10 ? ' and ' + (ts.length - 10) + ' more' : '')) + '</p>' : '';
    if (!(await confirmBox(kind === 'done' ? 'Mark as completed?' : 'Move?', '<p>' + esc(q) + '</p>' + list, kind === 'done' ? 'Mark as completed' : 'Move'))) return;
    ts.forEach((t) => jobs.push({ id: t.id, title: t.title, kind: kind === 'done' ? 'done' : 'move', day }));
    ['overdue', 'today', 'week', 'later', 'nodate'].forEach((l) => U().ui.list.unpick(l, ts.map((t) => t.id)));
    render();
    pump();
  }

  // ------------------------------------------------------------------ New task

  const LINKS = { none: 'Nothing', patient: 'A patient', invoice: 'An invoice', organisation: 'An organisation' };
  async function lookup(kind, term) {
    const path = { patient: '/a/magic/lookup/patient?includeContacts=1&term=', invoice: '/a/magic/lookup/invoice?term=', organisation: '/a/magic/lookup/organisation?term=' }[kind];
    const j = await U().http.json(path + encodeURIComponent(term) + '&_locale=' + encodeURIComponent(U().pg()));
    return ((j && j.lookup) || []).slice(0, 10).map((x) => {
      const p = x.payload || {};
      const id = kind === 'patient' ? p.pag && p.pag.id : x.id;
      return { id: id ? String(id) : '', text: clean(U().htmlDoc(x.title || p.displayValue || '').body.textContent) };
    }).filter((x) => x.id);
  }

  async function newTask() {
    U().ui.nativeStyles();
    const dlg = U().ui.dialog({ title: 'New task', key: 'upc-todo-new' });
    if (!dlg) return;
    dlg.root.classList.add('upc-todo-new');
    dlg.root.setAttribute('data-upc-todo-new', '');
    let people = [];
    try {
      const { doc } = await U().http.popup('/task/new');
      people = [...doc.querySelectorAll('select[name="form[linkPrGs][]"] option')].map((o) => ({ v: o.value, n: clean(o.textContent) })).filter((o) => o.v);
    } catch (e) { dlg.body.innerHTML = '<div class="alert alert-danger upc-err">Could not open Halaxy\'s add-task form: ' + esc(e.message || e) + '</div>'; return; }
    const mine = people.find((p) => p.n.toLowerCase() === me().toLowerCase());
    const today = new Date(); const iso = today.getFullYear() + '-' + two(today.getMonth() + 1) + '-' + two(today.getDate());
    dlg.body.innerHTML = '<label for="upc-tn-title">Title</label><input id="upc-tn-title" class="form-control" maxlength="200">' +
      '<label for="upc-tn-link">Linked to</label><select id="upc-tn-link" class="form-control">' + Object.entries(LINKS).map(([k, v]) => '<option value="' + k + '">' + esc(v) + '</option>').join('') + '</select>' +
      '<div data-upc-tn-find hidden><input id="upc-tn-term" class="form-control upc-gap" placeholder="Type to search"><div class="upc-todo-found" data-upc-tn-found></div></div>' +
      '<label for="upc-tn-who">For</label><select id="upc-tn-who" class="form-control">' + people.map((p) => '<option value="' + esc(p.v) + '"' + (mine && mine.v === p.v ? ' selected' : '') + '>' + esc(p.n) + '</option>').join('') + '</select>' +
      '<label for="upc-tn-due">Due</label><input id="upc-tn-due" type="date" class="form-control" value="' + iso + '">' +
      '<label for="upc-tn-pri">Priority</label><select id="upc-tn-pri" class="form-control"><option value="1">Low</option><option value="2" selected>Medium</option><option value="3">High</option></select>' +
      '<label for="upc-tn-comment">Comment</label><textarea id="upc-tn-comment" class="form-control" rows="3"></textarea>' +
      '<div class="alert alert-danger upc-err upc-gap" data-upc-tn-err hidden></div>' +
      '<div class="upc-actions"><button type="button" class="btn btn-outline-primary" data-c="no">Cancel</button><button type="button" class="btn btn-primary" data-c="yes">Save</button></div>';
    const $ = (s) => dlg.body.querySelector(s);
    let picked = null, timer = null;
    const err = (m) => { const e = $('[data-upc-tn-err]'); e.textContent = m; e.hidden = !m; };
    $('#upc-tn-link').addEventListener('change', () => { picked = null; $('[data-upc-tn-find]').hidden = $('#upc-tn-link').value === 'none'; $('#upc-tn-term').value = ''; $('[data-upc-tn-found]').innerHTML = ''; });
    $('#upc-tn-term').addEventListener('input', () => {
      clearTimeout(timer); picked = null;
      const term = clean($('#upc-tn-term').value), kind = $('#upc-tn-link').value;
      if (term.length < 3) { $('[data-upc-tn-found]').innerHTML = ''; return; }
      timer = setTimeout(async () => {
        try {
          const found = await lookup(kind, term);
          if (clean($('#upc-tn-term').value) !== term) return;
          $('[data-upc-tn-found]').innerHTML = found.length ? found.map((x) => '<button type="button" class="btn btn-outline-primary-light" data-pick="' + esc(x.id) + '">' + esc(x.text) + '</button>').join('') : '<p class="text-muted">None.</p>';
        } catch (e) { err('Could not search: ' + (e.message || e)); }
      }, 400);
    });
    $('[data-upc-tn-found]').addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]');
      if (!b) return;
      picked = { id: b.dataset.pick, text: b.textContent };
      $('#upc-tn-term').value = picked.text;
      $('[data-upc-tn-found]').innerHTML = '';
    });
    dlg.body.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-c]');
      if (!b) return;
      if (b.dataset.c === 'no') { dlg.close(); return; }
      const title = clean($('#upc-tn-title').value), kind = $('#upc-tn-link').value;
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec($('#upc-tn-due').value);
      if (!title) { err('Enter a title.'); return; }
      if (kind !== 'none' && !picked) { err('Search for the ' + kind + ' and choose one.'); return; }
      if (!m) { err('Choose a due date.'); return; }
      err('');
      b.disabled = true; b.textContent = 'Saving...';
      try {
        await addTask({ title, kind, link: picked && picked.id, who: $('#upc-tn-who').value, due: new Date(+m[1], +m[2] - 1, +m[3]).getTime(), priority: $('#upc-tn-pri').value, comment: $('#upc-tn-comment').value });
        dlg.close();
        await refresh(true);
      } catch (x) { err(x.message || String(x)); b.disabled = false; b.textContent = 'Save'; }
    });
  }

  async function addTask(o) {
    const path = o.kind === 'patient' ? '/task/new/linkPaG/' + encodeURIComponent(o.link) : o.kind === 'invoice' ? '/task/new/invoice/' + encodeURIComponent(o.link)
      : o.kind === 'organisation' ? '/task/new/organisation/' + encodeURIComponent(o.link) : '/task/new';
    const { doc } = await U().http.popup(path);
    const form = doc.querySelector('form#form_task_edit');
    const need = ['form[title]', 'form[linkPrGs][]', 'form[priority]', 'form[displayDueDate]', 'form[comment]', 'form[_token]'];
    const missing = need.filter((k) => !form || !form.querySelector('[name="' + k + '"]'));
    if (missing.length) throw new (U().Error)('The add-task form has changed (' + missing.join(', ') + ' not found). Nothing was added.');
    form.querySelector('[name="form[title]"]').value = o.title;
    [...form.querySelector('[name="form[linkPrGs][]"]').options].forEach((op) => { op.selected = op.value === o.who; });
    form.querySelectorAll('[name="form[priority]"]').forEach((r) => { r.checked = r.value === String(o.priority); });
    form.querySelector('[name="form[displayDueDate]"]').value = label(o.due);
    const now = new Date();
    const stamp = now.getFullYear() + '-' + two(now.getMonth() + 1) + '-' + two(now.getDate()) + ' ' + two(now.getHours()) + ':' + two(now.getMinutes()) + ' ' + U().user.initials(me());
    form.querySelector('[name="form[comment]"]').value = clean(o.comment) ? stamp + '\n- ' + o.comment.trim().replace(/\n(?!- )/g, '\n- ') : '';
    const res = await U().http.postForm(path, U().http.serialize(form));
    if (!(res && /^(REFRESH|OK|POPUP|CLOSE)$/.test(res.status))) U().http.expectRefresh(res, 'The new task');
  }

  // ------------------------------------------------------------------ the page

  function table(listId, ts) {
    const base = U().base();
    const today = dayStart(Date.now());
    return '<table class="table table-striped table-bordered w-100 m-0" data-upc-list="' + listId + '" data-upc-pick><thead><tr><th>Task</th><th>Linked to</th><th>Due</th><th>Priority</th><th data-upc-nosort></th></tr></thead><tbody>' +
      ts.map((t) => {
        const q = queuedOf(t.id), d = done.get(t.id);
        const acts = q === 'busy' ? U().ui.run.inline('') : q === 'queued' ? 'Queued' : d === 'done' || t.completed ? '<span class="upc-ok">Completed</span>'
          : d && d.startsWith('moved') ? '<span class="upc-ok">Moved to ' + esc(label(+d.split(' ')[1])) + '</span>'
          : '<button type="button" class="btn btn-outline-primary-light" data-a="done" data-id="' + esc(t.id) + '">Done</button>' +
            '<button type="button" class="btn btn-outline-primary-light" data-a="tomorrow" data-id="' + esc(t.id) + '">Tomorrow</button>' +
            '<button type="button" class="btn btn-outline-primary-light" data-a="monday" data-id="' + esc(t.id) + '">Monday</button>';
        return '<tr data-upc-id="' + esc(t.id) + '"' + (q || d || t.completed ? ' data-upc-nopick' : '') + '><td><a href="' + esc(base + '/task/' + t.id) + '" target="_blank" rel="noopener">' + esc(t.title || 'Task') + '</a></td>' +
          '<td>' + esc(t.type) + '</td><td class="upc-todo-due' + (t.due !== null && t.due < today ? ' upc-todo-late' : '') + '" data-sort="' + esc(t.due === null ? '' : label(t.due)) + '">' + esc(dueText(t.due)) + '</td>' +
          '<td data-sort="' + (PRIORITY[t.priority] || 0) + '">' + esc(t.priority) + '</td><td class="upc-todo-act">' + acts + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function bulk(listId, ts) {
    const ids = U().ui.list.picked(listId), n = ts.filter((t) => ids.includes(t.id)).length;
    if (!n) return '';
    return '<span data-upc-bulk-for="' + listId + '"><span class="text-muted">' + n + ' ticked</span>' +
      '<button type="button" class="btn btn-primary" data-a="bulk-done" data-list="' + listId + '">Done</button>' +
      '<button type="button" class="btn btn-outline-primary" data-a="bulk-monday" data-list="' + listId + '">Move to Monday</button></span>';
  }

  function render() {
    if (!root) return;
    const c = store().get('mine', null);
    const actions = '<button type="button" class="btn btn-primary" data-a="new">New task</button>' +
      '<button type="button" class="btn btn-outline-primary" data-a="refresh"' + (state.loading ? ' disabled' : '') + '>' + (state.loading ? 'Checking...' : 'Check now') + '</button>';
    let h = '<div class="upc-todo">' + U().ui.page.bar('To do', actions, state.loading ? U().ui.run.inline('Reading your tasks...') : U().ui.page.checked(c && c.at));
    if (state.error) h += '<div class="alert alert-danger upc-err">' + esc(state.error) + '</div>';
    state.errors.forEach((m) => { h += '<div class="alert alert-danger upc-err">' + esc(m) + '</div>'; });
    if (c && c.who === me()) {
      const g = groups(c.mine);
      [['overdue', 'Overdue'], ['today', 'Today'], ['week', 'This week'], ['later', 'Later'], ['nodate', 'No date']].forEach(([id, title]) => {
        if (id === 'nodate' && !g.nodate.length) return;
        h += U().ui.page.card(title, g[id].length, '', bulk(id, g[id]) + table(id, g[id]));
      });
    }
    const lists = U().todo.all().filter((x) => x.cls && document.querySelector('#mainMenu a.' + x.cls) && x.key !== 'to-do');
    if (lists.length) {
      h += '<div class="upc-todo-lists">' + lists.sort((a, b) => String(a.title).localeCompare(String(b.title))).map((x) =>
        '<div class="card"><div class="card-header"><h2>' + esc(x.title) + ' (' + (x.count || 0) + ')</h2><a class="btn btn-outline-primary-light" href="' + esc(x.href) + '">Open</a></div><div class="card-body">' +
        ((x.rows || []).length ? '<ul>' + x.rows.map((r) => '<li>' + esc(r) + '</li>').join('') + '</ul>' + ((x.count || 0) > x.rows.length ? '<p class="text-muted m-0">and ' + (x.count - x.rows.length) + ' more</p>' : '') : '<p class="text-muted m-0">None.</p>') +
        '</div></div>').join('') + '</div>';
    }
    h += '</div>';
    root.innerHTML = h;
    U().ui.list.enhance(root, { onPick: render });
  }

  async function refresh(force) {
    if (state.loading) return;
    state.loading = true; state.error = '';
    if (!jobs.length && busy === null) { state.errors = []; done.clear(); }
    render();
    try { await load(force); } catch (e) { state.error = 'Could not read your tasks: ' + (e.message || e); }
    state.loading = false;
    render();
  }

  function mount() {
    if (state.unmount) return;
    U().ui.nativeStyles();
    root = document.createElement('div');
    root.className = 'upc-native';
    root.setAttribute('data-upc-to-do', '');
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-a]');
      if (!b || b.disabled) return;
      const a = b.dataset.a;
      if (a === 'refresh') refresh(true);
      else if (a === 'new') newTask();
      else if (a === 'done' || a === 'tomorrow' || a === 'monday') act(a, [b.dataset.id]);
      else if (a === 'bulk-done') act('done', U().ui.list.picked(b.dataset.list));
      else if (a === 'bulk-monday') act('monday', U().ui.list.picked(b.dataset.list));
    });
    state.unmount = U().ui.mountPage('To do', root, MENU_CLS);
    render();
    refresh(false);
  }
  function unmount() { if (!state.unmount) return; state.unmount(); state.unmount = null; root = null; }
  const route = () => (location.hash === '#' + ROUTE ? mount() : unmount());

  function background() {
    if (!U().background.ok() || !me()) return;
    const c = store().get('mine', null);
    if (c && c.who === me() && !U().background.due(c.at, BADGE_EVERY)) { paintBadge(); return; }
    load(true).catch((e) => console.warn('[UPC to do]', e));
  }

  function start() {
    if (!U() || !U().todo || !U().ui.list) { console.error('[UPC to do] needs the core library'); return; }
    if (!document.getElementById('upc-todo-css')) { const st = document.createElement('style'); st.id = 'upc-todo-css'; st.textContent = CSS; document.head.appendChild(st); }
    U().ui.ensureMenuItem('To do', (section) => {
      const t = section && [...section.querySelectorAll('a.mainmenu-sublink')].find((a) => /^tasks/i.test(clean(a.textContent)));
      return (t ? t.getAttribute('href').split('#')[0] : U().base() + '/task/') + '#' + ROUTE;
    }, MENU_CLS, /^schedule$/i);
    window.addEventListener('hashchange', route);
    window.addEventListener('storage', (e) => { if (e.key && e.key.startsWith('upc-todo')) { paintBadge(); if (root && !state.loading) render(); } });
    route();
    setTimeout(paintBadge, 3000);
    setTimeout(background, 30000);
    setInterval(background, 5 * MIN);
    document.addEventListener('visibilitychange', background);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  window.upcToDo = { version: VERSION, load, groups, complete, move, addTask, lookup };
})();
