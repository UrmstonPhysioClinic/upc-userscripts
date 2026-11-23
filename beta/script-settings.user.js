// ==UserScript==
// @name         UPC System: Script settings (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.3.0
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/script-settings.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/script-settings.user.js
// @description  "Script settings" in Halaxy's account menu (your name, top right) opens a page: every script's options, which scripts run on this PC, stable or beta, updates, and the clinic settings every PC shares (CH changes them). Replaces the Tampermonkey menu.
// @match        https://*.halaxy.com/a/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * Script settings (CH, 10 Nov 2026: "not keen on this Tampermonkey menu at all").
 *
 *  - Adds "Script settings" to Halaxy's account menu (#practitioner-select, above Log Out).
 *  - A page of ours over the current page (#upc-script-settings; CH, 23 Nov 2026, UI/UX audit step 3), with tabs.
 *  - It lists each script's options (the items scripts register with GM_registerMenuCommand,
 *    kept by the loader in window.__upcLoader.items) and the loader's own settings: stable or beta,
 *    scripts switched on or off on this PC, updates. The loader answers upc-loader-get and
 *    upc-loader-do with upc-loader-state (loader 1.1.0).
 *  - Once the menu item is in place the page is marked data-upc-script-settings, so the loader leaves
 *    scripts' items out of the Tampermonkey menu. The loader's own "UPC scripts: settings and updates"
 *    stays there as a way in if Halaxy's menu ever changes.
 *  - Clinic settings (CH, 15 Nov 2026): the rules every PC shares (core's UPC.settings, kept in an Admin Note on
 *    UPC scripts (settings)). Everyone can see them; only CH can change them. Each PC uses a change within the hour.
 */
(() => {
  'use strict';
  if (window.__hxScriptSettings) return;
  window.__hxScriptSettings = true;

  const VERSION = '0.3.0';
  const U = () => window.UPC;
  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const STATUS = { running: 'running on this page', next: 'starts on next page', off: 'switched off', unused: 'not used on this page' };

  const CSS = `
    .upc-ss .upc-ss-tabs { margin-bottom: 16px; }
    .upc-ss .card { margin-bottom: 16px; }
    .upc-ss .upc-ss-items { display: flex; flex-wrap: wrap; gap: 6px; padding: 12px; }
    .upc-ss .upc-ss-items .btn { margin: 0; text-align: left; white-space: normal; }
    .upc-ss .upc-ss-chan { display: flex; gap: 18px; margin-bottom: 8px; }
    .upc-ss .upc-ss-chan label, .upc-ss td label { font-weight: normal; margin: 0; cursor: pointer; }
    .upc-ss td.upc-ss-ver { white-space: nowrap; }
    .upc-ss .upc-ss-clinic table { table-layout: fixed; width: 100%; }
    .upc-ss .upc-ss-clinic td, .upc-ss .upc-ss-clinic th { vertical-align: middle; overflow-wrap: anywhere; }
    .upc-ss .upc-ss-clinic col.upc-ss-c1 { width: 36%; } .upc-ss .upc-ss-clinic col.upc-ss-c2 { width: 40%; } .upc-ss .upc-ss-clinic col.upc-ss-c3 { width: 24%; }
    .upc-ss .upc-ss-clinic select.form-control { max-width: 100%; }
    .upc-ss .upc-ss-clinic input.upc-ss-wide { width: 100%; }
    .upc-ss .upc-ss-clinic textarea.form-control { width: 100%; min-height: 70px; }
    .upc-ss .upc-ss-clinic .upc-ss-ord { display: flex; align-items: center; gap: 6px; margin: 2px 0; }
    .upc-ss .upc-ss-clinic .upc-ss-ord span { flex: 1; }
    .upc-ss .upc-ss-clinic .upc-ss-ord .btn { margin: 0; padding: 0 8px; }
    .upc-ss .upc-ss-clinic input.form-control { display: inline-block; width: 96px; margin-right: 6px; }
    .upc-ss .upc-ss-clinic .upc-ss-people { display: flex; flex-wrap: wrap; gap: 4px 14px; }
    .upc-ss .upc-ss-clinic .upc-ss-people label { font-weight: normal; margin: 0; cursor: pointer; white-space: nowrap; }
    .upc-ss .upc-ss-clinic select.form-control { display: inline-block; width: auto; min-width: 200px; }
  `;
  function styles() {
    if (document.getElementById('upc-script-settings-css')) return;
    const st = document.createElement('style');
    st.id = 'upc-script-settings-css';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  // ------------------------------------------------------------------ the loader

  function ask(type, detail, waitMs) {
    return new Promise((resolve) => {
      let done = false;
      const on = (e) => { if (done) return; done = true; document.removeEventListener('upc-loader-state', on); try { resolve(JSON.parse(e.detail)); } catch (x) { resolve(null); } };
      document.addEventListener('upc-loader-state', on);
      setTimeout(() => { if (!done) { done = true; document.removeEventListener('upc-loader-state', on); resolve(null); } }, waitMs || 1500);
      document.dispatchEvent(new CustomEvent(type, { detail: detail ? JSON.stringify(detail) : '' }));
    });
  }
  const items = () => ((window.__upcLoader && window.__upcLoader.items) || []);
  // Scripts are named "UPC <Group>: <Name>" and listed under their group, in this order (loader 1.3.0 sends them
  // sorted with group and short name; older loaders send the names only).
  const GROUPS = ['Billing', 'Patients', 'Calendar', 'Look', 'System'];
  const parseName = (n) => {
    const plain = String(n || '').replace(/\s*\(beta\)\s*$/i, '');
    const m = plain.match(/^UPC (\w+): (.+)$/);
    return m ? { group: m[1], short: m[2] } : { group: 'Other', short: plain };
  };
  const shortName = (n) => parseName(n).short;
  const rank = (g) => { const i = GROUPS.indexOf(g); return i < 0 ? GROUPS.length : i; };
  const sortGrouped = (list, nameOf) => list.map((x) => Object.assign({ g: parseName(nameOf(x)) }, { x }))
    .sort((a, b) => rank(a.g.group) - rank(b.g.group) || a.g.short.localeCompare(b.g.short));

  // ------------------------------------------------------------------ the page (CH, 23 Nov 2026: UI/UX step 3)
  //
  // A page of ours (core's page kit) instead of a pop-up: Halaxy's title bar with the tab's buttons on the right,
  // three tabs (This PC, Clinic settings, Options), each group as a card. Opened from the account menu on whatever
  // page is showing (#upc-script-settings); Close goes back to that page.

  const ROUTE = 'upc-script-settings';
  let root = null, unmountPage = null, st = null, needRefresh = false, busy = '', clinicErr = '', names = null, draft = null;
  let tab = 'pc';
  try { tab = sessionStorage.getItem('upc-ss-tab') || 'pc'; } catch (e) { /* fine */ }
  const setTab = (t) => { tab = t; try { sessionStorage.setItem('upc-ss-tab', t); } catch (e) { /* fine */ } };
  const btn = (a, text, cls, off) => '<button type="button" class="btn ' + (cls || 'btn-outline-primary') + '" data-a="' + a + '"' + (off ? ' disabled' : '') + '>' + esc(text) + '</button>';
  const at = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + ' on ' + U().dayLabel(ms);

  // ------------------------------------------------------------------ clinic settings (every PC)

  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dayText = (iso) => { const [y, m, d] = String(iso).split('-'); return d + '-' + MON[+m - 1] + '-' + y; };
  const shown = (def, v) => (def.type === 'choice' ? def.options[v] || v : v === 'everyone' ? 'Everyone' : def.type === 'dates' ? (v.length ? v.map(dayText).join(', ') : 'none') : Array.isArray(v) ? (v.length ? v.join(', ') : 'none')
    : def.unit === '£' ? '£ ' + v : v + (def.unit ? ' ' + def.unit : ''));
  // The box for one setting: a number or time, ticks for people, a list for one person.
  // What is in the boxes is kept (draft) while saving, so a refused save keeps the changes on screen.
  function field(r) {
    const d = r.def;
    if (draft && Object.prototype.hasOwnProperty.call(draft, d.key)) {
      r = Object.assign({}, r, { value: draft[d.key], changed: true });
    }
    if (d.type === 'people') {
      const list = [...new Set((names || []).concat(r.value))];
      return '<div class="upc-ss-people" data-people="' + esc(d.key) + '">' + list.map((n) => '<label><input type="checkbox" value="' + esc(n) + '"' + (r.value.includes(n) ? ' checked' : '') + '> ' + esc(n) + '</label>').join('') + '</div>';
    }
    if (d.type === 'audience') {
      const all = r.value === 'everyone';
      const picked = Array.isArray(r.value) ? r.value : [];
      return '<div class="upc-ss-people" data-audience="' + esc(d.key) + '"><label><input type="checkbox" data-everyone' + (all ? ' checked' : '') + '> <strong>Everyone</strong></label>' +
        [...new Set((names || []).concat(picked))].map((n) => '<label><input type="checkbox" value="' + esc(n) + '"' + (all || picked.includes(n) ? ' checked' : '') + (all ? ' disabled' : '') + '> ' + esc(n) + '</label>').join('') + '</div>';
    }
    if (d.type === 'choice') {
      return '<select class="form-control" data-key="' + esc(d.key) + '">' + Object.entries(d.options).map(([k, l]) => '<option value="' + esc(k) + '"' + (k === r.value ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select>';
    }
    if (d.type === 'weekdays') {
      return '<div class="upc-ss-people" data-list="' + esc(d.key) + '">' + ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((n) => '<label><input type="checkbox" value="' + n + '"' + (r.value.includes(n) ? ' checked' : '') + '> ' + n + '</label>').join('') + '</div>';
    }
    if (d.type === 'dates') {
      return '<textarea class="form-control" data-lines="' + esc(d.key) + '" placeholder="e.g. 25-Dec-2026, one per line">' + esc((Array.isArray(r.value) ? r.value : []).map((x) => (/^\d{4}-/.test(x) ? dayText(x) : x)).join('\n')) + '</textarea>';
    }
    if (d.type === 'words' || d.type === 'text') {
      return '<input class="form-control upc-ss-wide" type="text" data-key="' + esc(d.key) + '" value="' + esc(Array.isArray(r.value) ? r.value.join(', ') : r.value) + '"' + (d.type === 'words' ? ' placeholder="none"' : '') + '>';
    }
    if (d.type === 'order') {
      const row = (n) => '<div class="upc-ss-ord" data-name="' + esc(n) + '"><span>' + esc(n) + '</span>' +
        '<button type="button" class="btn btn-outline-primary-light" data-a="up" title="Move up">&uarr;</button><button type="button" class="btn btn-outline-primary-light" data-a="down" title="Move down">&darr;</button></div>';
      const others = (names || []).filter((n) => !r.value.includes(n));
      return '<div data-order="' + esc(d.key) + '">' + r.value.map(row).join('') +
        '<div class="text-muted upc-ss-ord-rest" data-rest>Not in the order</div>' + others.map(row).join('') + '</div>';
    }
    if (d.type === 'person') {
      const list = [...new Set((names || []).concat([r.value]))];
      return '<select class="form-control" data-key="' + esc(d.key) + '">' + list.map((n) => '<option' + (n === r.value ? ' selected' : '') + '>' + esc(n) + '</option>').join('') + '</select>';
    }
    const val = r.changed ? r.value : '';   // empty: the default
    return (d.unit === '£' ? '£ ' : '') + '<input class="form-control" type="' + (d.type === 'time' ? 'time' : 'number') + '" data-key="' + esc(d.key) + '" value="' + esc(val) + '" placeholder="' + esc(d.def) + '"' +
      (d.type === 'time' ? '' : ' min="' + d.min + '" max="' + d.max + '" step="1"') + '>' + (d.unit && d.unit !== '£' ? esc(d.unit) : '');
  }
  function clinicBody() {
    const S = U().settings;
    const edit = S.canEdit();
    const rows = S.all();
    let h = '<div class="upc-ss-clinic">';
    if (clinicErr) h += '<div class="alert alert-danger upc-err" data-msg>' + esc(clinicErr) + '</div>';
    const unsaved = rows.filter((r) => r.raw === null).length;
    if (unsaved && edit) h += '<div class="alert alert-warning upc-warn">' + unsaved + ' setting' + (unsaved === 1 ? '' : 's') + ' not saved yet. Check those marked "from this PC", then save.</div>';
    const probs = S.problems();
    if (probs.length) h += '<div class="alert alert-danger upc-err">Lines in the settings note that could not be read (ignored): ' + probs.map(esc).join('; ') + '</div>';
    const groups = [];
    rows.forEach((r) => { let g = groups.find((x) => x.name === r.def.script); if (!g) { g = { name: r.def.script, rows: [] }; groups.push(g); } g.rows.push(r); });
    groups.forEach((g) => {
      h += '<div class="card"><div class="card-header"><h2>' + esc(g.name) + '</h2></div><div class="card-body p-0">' +
        '<table class="table table-striped table-bordered w-100 mb-0"><colgroup><col class="upc-ss-c1"><col class="upc-ss-c2"><col class="upc-ss-c3"></colgroup>' +
        '<thead><tr><th>Setting</th><th>Value</th><th>Default</th></tr></thead><tbody>' +
        g.rows.map((r) => {
          const d = r.def;
          return '<tr><td>' + esc(d.label) + (r.fromPc && r.raw === null ? ' <span class="text-muted">(from this PC)</span>' : '') + '</td><td>' + (edit ? field(r) : '<strong>' + esc(shown(d, r.value)) + '</strong>') +
            (r.bad ? ' <span class="upc-err">(saved value ' + esc(r.raw) + (d.min === undefined ? ' can\'t be used' : ' is outside ' + esc(d.min) + ' to ' + esc(d.max)) + ': default used)</span>' : '') + '</td>' +
            '<td class="upc-ss-def text-muted">' + esc(shown(d, d.def)) + '</td></tr>';
        }).join('') + '</tbody></table></div></div>';
    });
    if (!edit) h += '<p class="text-muted">Only ' + esc(S.editors.join(' or ')) + ' can change these.</p>';
    return h + '</div>';
  }
  function collect() {
    const values = {};
    root.querySelectorAll('.upc-ss-clinic input[data-key], .upc-ss-clinic select[data-key]').forEach((el) => { values[el.dataset.key] = el.value; });
    root.querySelectorAll('[data-people]').forEach((el) => { values[el.dataset.people] = [...el.querySelectorAll('input:checked')].map((x) => x.value); });
    root.querySelectorAll('[data-audience]').forEach((el) => {
      values[el.dataset.audience] = el.querySelector('[data-everyone]').checked ? 'everyone' : [...el.querySelectorAll('input[value]:checked')].map((x) => x.value);
    });
    root.querySelectorAll('[data-list]').forEach((el) => { values[el.dataset.list] = [...el.querySelectorAll('input:checked')].map((x) => x.value); });
    root.querySelectorAll('[data-lines]').forEach((el) => { values[el.dataset.lines] = el.value.split(/\n+/).map((x) => x.trim()).filter(Boolean); });
    root.querySelectorAll('[data-order]').forEach((el) => {
      const rows = [...el.children], cut = rows.findIndex((x) => x.hasAttribute('data-rest'));
      values[el.dataset.order] = rows.slice(0, cut < 0 ? rows.length : cut).filter((x) => x.dataset.name).map((x) => x.dataset.name);
    });
    root.querySelectorAll('.upc-ss-clinic input[type=text][data-key]').forEach((el) => { const d = U().settings.def(el.dataset.key); if (d && d.type === 'words') values[el.dataset.key] = el.value.trim() ? el.value : []; });
    return values;
  }
  async function clinicAction(a) {
    const S = U().settings;
    clinicErr = '';
    if (a === 'reread') {
      draft = null;
      busy = 'Reading...'; render();
      try { await S.refresh(true); U().ui.toast('Read again.'); } catch (e) { clinicErr = 'Could not read the settings: ' + (e.message || e); }
    } else if (a === 'save') {
      draft = collect();
      busy = 'Saving...'; render();
      try { await S.save(draft); draft = null; U().ui.toast('Saved.'); } catch (e) { clinicErr = 'Not saved: ' + (e.message || e); }
    }
    busy = '';
    render();
  }

  // ------------------------------------------------------------------ this PC and options

  function pcBody() {
    if (!st) return '<div class="alert alert-warning upc-warn">This PC\'s loader is out of date: its settings are in the Tampermonkey menu until it updates.</div>';
    let h = (st.problems || []).map((p) => '<div class="alert alert-danger upc-err">' + esc(p) + '</div>').join('');
    if (needRefresh) h += '<div class="alert alert-warning upc-warn">Refresh Halaxy to apply these changes.</div>';
    h += '<div class="card"><div class="card-header"><h2>This PC</h2></div><div class="card-body"><div class="upc-ss-chan">' + ['stable', 'beta'].map((c) => '<label><input type="radio" name="upc-ss-chan" value="' + c + '"' + (st.chosen === c ? ' checked' : '') + '> ' +
      (c === 'stable' ? 'Stable (clinic PCs)' : 'Beta (testing new changes)') + '</label>').join('') + '</div><div class="text-muted">Loader ' + esc(st.version) + ', Script settings ' + VERSION + '.</div></div></div>';
    if (!st.scripts.length) return h + '<div class="card"><div class="card-header"><h2>Scripts (0)</h2></div><div class="card-body p-0"><p class="text-muted m-3">None. Check for updates to fetch them.</p></div></div>';
    const groups = [];
    sortGrouped(st.scripts, (x) => x.name).map((o) => o.x).forEach((x) => {
      const g = parseName(x.name).group;
      let gr = groups.find((y) => y.name === g);
      if (!gr) { gr = { name: g, list: [] }; groups.push(gr); }
      gr.list.push(x);
    });
    groups.forEach((g) => {
      h += U().ui.page.card(g.name, g.list.length, '', '<table class="table table-striped table-bordered w-100 mb-0"><thead><tr><th>Script</th><th>Version</th><th>Status</th></tr></thead><tbody>' +
        g.list.map((x) => '<tr><td><label><input type="checkbox" data-file="' + esc(x.file) + '"' + (x.on ? ' checked' : '') + '> ' + esc(shortName(x.name)) + '</label></td>' +
          '<td class="upc-ss-ver">' + esc(x.version) + '</td><td class="text-muted">' + esc(STATUS[x.status] || x.status) + '</td></tr>').join('') + '</tbody></table>');
    });
    return h;
  }
  function optionsBody() {
    const shortOf = {}, fullOf = {};
    (st ? st.scripts : []).forEach((x) => { shortOf[x.file] = shortName(x.name); fullOf[x.file] = x.name; });
    const groups = [];
    items().forEach((it) => {
      let g = groups.find((x) => x.script === it.script);
      if (!g) { g = { script: it.script, items: [] }; groups.push(g); }
      g.items.push(it);
    });
    const ordered = sortGrouped(groups, (g) => fullOf[g.script] || g.script).map((o) => o.x);
    if (!ordered.length) return U().ui.page.card('Options', 0, '', '');
    return ordered.map((g) => U().ui.page.card(shortOf[g.script] || g.script.replace(/\.user\.js$/, ''), g.items.length, '',
      '<div class="upc-ss-items">' + g.items.map((it) => '<button type="button" class="btn btn-outline-primary-light" data-item="' + esc(it.id) + '">' + esc(it.label) + '</button>').join('') + '</div>')).join('');
  }

  // ------------------------------------------------------------------ drawing

  function render() {
    if (!root) return;
    const P = U().ui.page;
    const hasClinic = !!U().settings;
    if (tab === 'clinic' && !hasClinic) tab = 'pc';
    let actions = '', sub = '';
    if (tab === 'pc') {
      if (needRefresh) actions += btn('reload', 'Refresh Halaxy', 'btn-primary');
      if (st) actions += btn('check', busy ? 'Checking...' : 'Check for updates now', '', !!busy);
      sub = busy ? U().ui.run.inline('Checking for updates...') : st && st.lastCheck ? '<span class="text-muted">Checked for updates at ' + esc(at(st.lastCheck)) + '.</span>' : '';
    } else if (tab === 'clinic') {
      const S = U().settings;
      actions += btn('reread', 'Read again now', '', !!busy);
      if (S.canEdit()) actions += btn('save', busy === 'Saving...' ? 'Saving...' : 'Save for every PC', 'btn-primary', !!busy);
      const t = S.readAt();
      sub = busy ? U().ui.run.inline(busy) : '<span class="text-muted">' + (t ? 'Read from Halaxy at ' + esc(at(t)) + '.' : 'Not read from Halaxy yet on this PC: defaults shown.') + '</span>';
    }
    actions += btn('close', 'Close');
    const tabs = [['pc', 'This PC']].concat(hasClinic ? [['clinic', 'Clinic settings']] : []).concat([['options', 'Options']]);
    root.innerHTML = P.bar('Script settings', actions, sub) +
      '<ul class="nav nav-tabs upc-ss-tabs">' + tabs.map(([k, l]) => '<li class="nav-item"><a href="#' + ROUTE + '" class="nav-link' + (tab === k ? ' active' : '') + '" data-a="' + k + '">' + esc(l) + '</a></li>').join('') + '</ul>' +
      (tab === 'clinic' ? clinicBody() : tab === 'options' ? optionsBody() : pcBody());
  }

  async function act(a, el) {
    if (a === 'pc' || a === 'clinic' || a === 'options') {
      draft = null; clinicErr = ''; setTab(a); render();
      if (a === 'clinic' && U().settings.canEdit() && U().settings.names && !names) { names = await U().settings.names(); if (root && tab === 'clinic') render(); }
    } else if (a === 'close') close();
    else if (a === 'reread' || a === 'save') clinicAction(a);
    else if (a === 'up' || a === 'down') {
      const row = el.closest('[data-name]');
      const to = a === 'up' ? row.previousElementSibling : row.nextElementSibling;   // past the "Not in the order" line too
      if (to && (to.dataset.name || to.hasAttribute('data-rest'))) { if (a === 'up') to.before(row); else to.after(row); }
    } else if (a === 'reload') location.reload();
    else if (a === 'check') {
      busy = 'Checking...';
      render();
      const r = await ask('upc-loader-do', { act: 'check' }, 60000);
      busy = '';
      if (r) {
        st = r;
        if (r.reloadNeeded) needRefresh = true;
        if (r.checked) {
          if (r.checked.updated || r.checked.removed) needRefresh = true;
          if (!(r.checked.updated || r.checked.added || r.checked.removed || r.checked.problems)) U().ui.toast('Everything is up to date.');
        }
      }
      render();
    }
  }

  async function mount() {
    if (!U()) return;
    if (root) { render(); return; }
    styles();
    root = document.createElement('div');
    root.className = 'upc-native upc-ss';
    clinicErr = ''; draft = null;
    // "Everyone" ticked: the names are ticked too and can't be changed (untick it to choose people).
    root.addEventListener('change', async (e) => {
      const t = e.target;
      const ev = t.closest('[data-everyone]');
      if (ev) { ev.closest('[data-audience]').querySelectorAll('input[value]').forEach((x) => { x.disabled = ev.checked; if (ev.checked) x.checked = true; }); return; }
      let r = null;
      if (t.name === 'upc-ss-chan') r = await ask('upc-loader-do', { act: 'channel', value: t.value });
      else if (t.dataset.file) r = await ask('upc-loader-do', { act: 'switch', file: t.dataset.file, on: t.checked });
      if (r) { st = r; needRefresh = true; render(); }
    });
    root.addEventListener('click', (e) => {
      const it = e.target.closest('[data-item]');
      if (it) {
        if (window.__upcLoader && window.__upcLoader.run) window.__upcLoader.run(it.dataset.item);
        setTimeout(render, 300);   // an option may change its own label ("on" / "off")
        return;
      }
      const a = e.target.closest('[data-a]');
      if (!a) return;
      e.preventDefault();
      act(a.dataset.a, a);
    });
    unmountPage = U().ui.mountPage('Script settings', root);
    render();
    st = await ask('upc-loader-get');
    render();
    if (tab === 'clinic' && U().settings && U().settings.canEdit() && U().settings.names && !names) { names = await U().settings.names(); if (root && tab === 'clinic') render(); }
  }
  function unmount() { if (!unmountPage) return; unmountPage(); unmountPage = null; root = null; busy = ''; }
  function close() {
    history.replaceState(null, '', location.pathname + location.search);
    unmount();
  }
  const route = () => (location.hash === '#' + ROUTE ? mount() : unmount());
  function open(which) {
    if (which) setTab(which);
    if (location.hash === '#' + ROUTE) mount(); else location.hash = ROUTE;
  }

  // ------------------------------------------------------------------ the account menu

  function addMenuItem() {
    const menu = document.querySelector('#practitioner-select .dropdown-menu');
    if (!menu) return false;
    if (menu.querySelector('.upc-script-settings')) return true;
    const a = document.createElement('a');
    a.className = 'dropdown-item upc-script-settings';
    a.href = '#' + ROUTE;
    a.textContent = 'Script settings';
    a.addEventListener('click', (e) => { e.preventDefault(); open(); });
    const div = document.createElement('div');
    div.className = 'dropdown-divider upc-script-settings-divider';
    const logout = menu.querySelector('#btn-user-select-logout');
    if (logout) { menu.insertBefore(a, logout); menu.insertBefore(div, logout); } else menu.appendChild(a);
    return true;
  }

  function start() {
    if (!U()) { console.error('[UPC script settings] needs the core library'); return; }
    const hosted = () => {
      document.documentElement.setAttribute('data-upc-script-settings', VERSION);
      document.dispatchEvent(new CustomEvent('upc-script-settings-ready'));
    };
    if (addMenuItem()) hosted();
    else {
      // Halaxy may draw its header a little later; give up after 10 seconds (the loader then uses Tampermonkey).
      const t0 = Date.now();
      const obs = new MutationObserver(() => {
        if (addMenuItem()) { obs.disconnect(); hosted(); } else if (Date.now() - t0 > 10000) obs.disconnect();
      });
      obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
    }
    // Halaxy redraws its header on some pages: put the item back.
    setInterval(addMenuItem, 5000);
    window.addEventListener('hashchange', route);
    route();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  window.upcScriptSettings = { version: VERSION, open };
})();
