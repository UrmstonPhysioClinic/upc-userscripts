// ==UserScript==
// @name         UPC System: Script settings
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.1.1
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/stable/script-settings.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/stable/script-settings.user.js
// @description  "Script settings" in Halaxy's account menu (your name, top right): every script's options, which scripts run on this PC, stable or beta, and updates. Replaces the Tampermonkey menu.
// @match        https://*.halaxy.com/a/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * Script settings (Carl, 10 Nov 2026: "not keen on this Tampermonkey menu at all").
 *
 *  - Adds "Script settings" to Halaxy's account menu (#practitioner-select, above Log Out).
 *  - Its pop-up lists each script's options (the items scripts register with GM_registerMenuCommand,
 *    kept by the loader in window.__upcLoader.items) and the loader's own settings: stable or beta,
 *    scripts switched on or off on this PC, updates. The loader answers upc-loader-get and
 *    upc-loader-do with upc-loader-state (loader 1.1.0).
 *  - Once the menu item is in place the page is marked data-upc-script-settings, so the loader leaves
 *    scripts' items out of the Tampermonkey menu. The loader's own "UPC scripts: settings and updates"
 *    stays there as a way in if Halaxy's menu ever changes.
 */
(() => {
  'use strict';
  if (window.__hxScriptSettings) return;
  window.__hxScriptSettings = true;

  const VERSION = '0.1.1';
  const U = () => window.UPC;
  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const STATUS = { running: 'running on this page', next: 'starts on next page', off: 'switched off', unused: 'not used on this page' };

  const CSS = `
    .upc-ss h5 { margin: 0 0 8px; }
    .upc-ss .upc-ss-section { margin-bottom: 20px; }
    .upc-ss .upc-ss-group { margin-bottom: 10px; }
    .upc-ss .upc-ss-group .text-muted { font-size: .9em; margin-bottom: 4px; }
    .upc-ss .upc-ss-items { display: flex; flex-wrap: wrap; gap: 6px; }
    .upc-ss .upc-ss-items .btn { margin: 0; text-align: left; white-space: normal; }
    .upc-ss .upc-ss-chan { display: flex; gap: 18px; margin-bottom: 8px; }
    .upc-ss .upc-ss-chan label, .upc-ss td label { font-weight: normal; margin: 0; cursor: pointer; }
    .upc-ss td.upc-ss-ver { white-space: nowrap; }
    .upc-ss tr.upc-ss-grp th { font-weight: 600; }
    .upc-ss .upc-ss-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 12px; }
    .upc-ss .upc-ss-actions .btn { margin: 0; }
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

  // ------------------------------------------------------------------ the pop-up

  let dlg = null, st = null, needRefresh = false, busy = '', notice = '';

  function render() {
    if (!dlg) return;
    const names = {};
    (st ? st.scripts : []).forEach((x) => { names[x.file] = shortName(x.name); });
    const groups = [];
    items().forEach((it) => {
      let g = groups.find((x) => x.script === it.script);
      if (!g) { g = { script: it.script, items: [] }; groups.push(g); }
      g.items.push(it);
    });
    const fullNames = {};
    (st ? st.scripts : []).forEach((x) => { fullNames[x.file] = x.name; });
    const ordered = sortGrouped(groups, (g) => fullNames[g.script] || g.script).map((o) => o.x);
    let h = '<div class="upc-ss-section"><h5>Options</h5>';
    h += ordered.length ? ordered.map((g) => '<div class="upc-ss-group"><div class="text-muted">' + esc(names[g.script] || g.script.replace(/\.user\.js$/, '')) + '</div><div class="upc-ss-items">' +
      g.items.map((it) => '<button type="button" class="btn btn-outline-primary-light" data-item="' + esc(it.id) + '">' + esc(it.label) + '</button>').join('') + '</div></div>').join('')
      : '<p class="text-muted">No script has options on this page.</p>';
    h += '</div><div class="upc-ss-section"><h5>Scripts on this PC</h5>';
    if (!st) {
      h += '<p class="text-muted">This PC\'s script loader doesn\'t answer yet, so its settings are in the Tampermonkey menu (UPC scripts: settings and updates). It updates itself within a day; Tampermonkey\'s "Check for userscript updates" does it now.</p>';
    } else {
      h += '<div class="upc-ss-chan">' + ['stable', 'beta'].map((c) => '<label><input type="radio" name="upc-ss-chan" value="' + c + '"' + (st.chosen === c ? ' checked' : '') + '> ' +
        (c === 'stable' ? 'Stable (clinic PCs)' : 'Beta (testing new changes)') + '</label>').join('') + '</div>';
      let last = st.scripts.every((x) => parseName(x.name).group === 'Other') ? 'Other' : '';   // no grouped names: no headings
      h += st.scripts.length ? '<table class="table table-striped table-bordered w-100"><tbody>' + sortGrouped(st.scripts, (x) => x.name).map((o) => o.x).map((x) =>
        ((parseName(x.name).group !== last && (last = parseName(x.name).group)) ? '<tr class="upc-ss-grp"><th colspan="2">' + esc(last) + '</th></tr>' : '') +
        '<tr><td><label><input type="checkbox" data-file="' + esc(x.file) + '"' + (x.on ? ' checked' : '') + '> ' + esc(shortName(x.name)) + '</label></td>' +
        '<td class="upc-ss-ver text-muted">' + esc(x.version) + ' · ' + esc(STATUS[x.status] || x.status) + '</td></tr>').join('') + '</tbody></table>'
        : '<p class="text-muted">No scripts saved yet. Check for updates to fetch them.</p>';
      h += (st.problems || []).map((p) => '<p class="upc-err">' + esc(p) + '</p>').join('');
      if (needRefresh) h += '<p class="upc-warn">Refresh Halaxy to apply these changes.</p>';
      if (notice) h += '<p class="text-muted">' + esc(notice) + '</p>';
      const when = st.lastCheck ? new Date(st.lastCheck).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never';
      h += '<div class="text-muted">Loader ' + esc(st.version) + '. Last checked for updates: ' + esc(when) + '. Script settings ' + VERSION + '.</div>';
    }
    h += '</div><div class="upc-ss-actions">' +
      (st ? '<button type="button" class="btn btn-outline-primary" data-a="check"' + (busy ? ' disabled' : '') + '>' + (busy || 'Check for updates now') + '</button>' : '') +
      (needRefresh ? '<button type="button" class="btn btn-outline-primary" data-a="reload">Refresh Halaxy</button>' : '') +
      '<button type="button" class="btn btn-primary" data-a="close">Close</button></div>';
    dlg.body.innerHTML = h;
  }

  async function open() {
    if (!U() || dlg) return;
    styles();
    dlg = U().ui.dialog({ title: 'Script settings', key: 'upc-script-settings', onClose: () => { dlg = null; } });
    if (!dlg) return;
    dlg.root.classList.add('upc-ss');
    notice = '';
    render();
    dlg.body.addEventListener('click', async (e) => {
      const it = e.target.closest('[data-item]');
      if (it) { const id = it.dataset.item; dlg.close(); dlg = null; if (window.__upcLoader && window.__upcLoader.run) window.__upcLoader.run(id); return; }
      const a = e.target.closest('[data-a]');
      if (!a) return;
      if (a.dataset.a === 'close') { dlg.close(); dlg = null; }
      else if (a.dataset.a === 'reload') location.reload();
      else if (a.dataset.a === 'check') {
        busy = 'Checking...';
        render();
        const r = await ask('upc-loader-do', { act: 'check' }, 60000);
        busy = '';
        if (r) {
          st = r;
          if (r.reloadNeeded) needRefresh = true;
          if (r.checked) {
            if (r.checked.updated || r.checked.removed) needRefresh = true;
            notice = r.checked.updated || r.checked.added || r.checked.removed || r.checked.problems ? '' : 'Everything is up to date.';
          }
        }
        render();
      }
    });
    dlg.body.addEventListener('change', async (e) => {
      const t = e.target;
      let r = null;
      if (t.name === 'upc-ss-chan') r = await ask('upc-loader-do', { act: 'channel', value: t.value });
      else if (t.dataset.file) r = await ask('upc-loader-do', { act: 'switch', file: t.dataset.file, on: t.checked });
      if (r) { st = r; needRefresh = true; notice = ''; render(); }
    });
    st = await ask('upc-loader-get');
    render();
  }

  // ------------------------------------------------------------------ the account menu

  function addMenuItem() {
    const menu = document.querySelector('#practitioner-select .dropdown-menu');
    if (!menu) return false;
    if (menu.querySelector('.upc-script-settings')) return true;
    const a = document.createElement('a');
    a.className = 'dropdown-item upc-script-settings';
    a.href = '#';
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
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  window.upcScriptSettings = { version: VERSION, open };
})();
