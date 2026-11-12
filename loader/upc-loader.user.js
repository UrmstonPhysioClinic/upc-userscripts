// ==UserScript==
// @name         UPC Halaxy scripts
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      1.3.0
// @description  Runs all of the clinic's Halaxy scripts from GitHub (and the insurer portal fill on the Bupa and AXA provider sites). Install once per PC: new and updated scripts arrive by themselves.
// @match        https://*.halaxy.com/*
// @match        https://provider.axahealth.co.uk/*
// @match        https://providersonline.bupa.co.uk/*
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/loader/upc-loader.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/loader/upc-loader.user.js
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addElement
// @grant        GM_registerMenuCommand
// @connect      raw.githubusercontent.com
// ==/UserScript==

/*
 * How it works
 * ------------
 * The repository lists the scripts for each channel in stable/scripts.json and
 * beta/scripts.json. This loader keeps a copy of every listed script on the PC
 * and runs each one on the Halaxy pages its own header asks for (@match,
 * @exclude, @run-at, @noframes), straight from that copy, so scripts that must
 * start before Halaxy still do.
 *
 * Every CHECK_EVERY_MINUTES (and from the settings panel) it fetches the list
 * from GitHub in the background. Changed scripts are downloaded, checked, and
 * used from the next page load. A script the PC has never had runs straight
 * away. If GitHub can't be reached, the saved copies keep running.
 *
 * Per-PC settings (channel, scripts switched off) live in this browser's
 * storage for halaxy.com, so Firefox Sync never copies them between PCs.
 *
 * Scripts run in the page, as they did when installed one by one. The few
 * Tampermonkey functions they use (GM_getValue, GM_setValue, GM_deleteValue,
 * GM_registerMenuCommand) are provided. Scripts' menu items appear in Halaxy, under
 * Script settings in the account menu (script-settings.user.js), which also shows
 * and changes this loader's settings through the upc-loader-get / upc-loader-do
 * events. Where Script settings isn't running, they appear in the Tampermonkey
 * menu under this script, as before. The Tampermonkey menu keeps "UPC scripts:
 * settings and updates": a self-contained panel that works even when no page
 * script does, so it doesn't use Halaxy's look.
 *
 * Insurer portals (1.2.0): the loader also runs on the Bupa and AXA provider sites, where only scripts whose
 * own @match names those sites run (Portal fill). There, the PC's channel and switched-off scripts come from a
 * copy the loader keeps whenever Halaxy is open, and it doesn't check for updates. Scripts pass a claim from
 * Halaxy to the portal through window.__upcLoader.shared(op, key, value) (op 'get', 'set' or 'del'), kept in
 * the loader's own storage on this PC: a value set with forHost is only given back on Halaxy and that site.
 */

(function () {
  'use strict';

  const VERSION = '1.3.0';
  const RAW = 'https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/';
  const CHECK_EVERY_MINUTES = 10;
  const RETRY_STALE_MINUTES = 2;   // GitHub can serve an old file for a few minutes after a change
  const LS = 'upc-loader:';
  const TAG = '[UPC loader]';
  const isTop = window.top === window;
  const onHalaxy = /(^|\.)halaxy\.com$/.test(location.hostname);

  // At document-start the page may not have its <html> element yet. Wait for it: the observer
  // fires as soon as it is created, before any of the page's own scripts run.
  if (document.documentElement) main();
  else {
    new MutationObserver((m, obs) => {
      if (document.documentElement) { obs.disconnect(); main(); }
    }).observe(document, { childList: true });
  }

  function main() {
  // Never run twice in the same document.
  const root = document.documentElement;
  if (root.hasAttribute('data-upc-loader')) return;
  root.setAttribute('data-upc-loader', VERSION);

  // ------------------------------------------------------------------ per-PC settings

  const local = {
    get(k, d) {
      try { const v = localStorage.getItem(LS + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set(k, v) {
      try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (e) { /* storage blocked */ }
    },
  };
  // Off Halaxy (the insurer portals) the PC's settings come from the copy kept while Halaxy is open.
  const pcCopy = () => { try { GM_setValue('pc', { channel: local.get('channel', 'stable'), off: local.get('off', {}) }); } catch (e) { /* ignore */ } };
  const pc = onHalaxy ? null : GM_getValue('pc', { channel: 'stable', off: {} });
  if (onHalaxy) pcCopy();
  const channel = (pc ? pc.channel : local.get('channel', 'stable')) === 'beta' ? 'beta' : 'stable';
  const isOff = (file) => !!(pc ? pc.off || {} : local.get('off', {}))[file];

  // ------------------------------------------------------------------ saved copies

  // index:<channel> = { checked, scripts: [{ file, name, version, meta }] }   code:<channel>:<file> = source
  const indexKey = 'index:' + channel;
  const codeKey = (file) => 'code:' + channel + ':' + file;
  const readIndex = () => GM_getValue(indexKey, null);

  // ------------------------------------------------------------------ script headers

  function parseMeta(code) {
    const m = String(code).match(/\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/);
    if (!m) return null;
    const meta = { name: '', version: '', match: [], include: [], exclude: [], runAt: 'document-idle', noframes: false };
    m[1].split('\n').forEach((line) => {
      const x = line.match(/^\s*\/\/\s*@(\S+)(?:\s+(.*?))?\s*$/);
      if (!x) return;
      const k = x[1];
      const v = x[2] || '';
      if (k === 'name') meta.name = v;
      else if (k === 'version') meta.version = v;
      else if (k === 'match') meta.match.push(v);
      else if (k === 'include') meta.include.push(v);
      else if (k === 'exclude' || k === 'exclude-match') meta.exclude.push(v);
      else if (k === 'run-at') meta.runAt = v;
      else if (k === 'noframes') meta.noframes = true;
    });
    return meta;
  }

  const globRe = (p) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  function applies(meta, url) {
    if (meta.noframes && !isTop) return false;
    const inc = meta.match.concat(meta.include);
    if (!inc.some((p) => globRe(p).test(url))) return false;
    return !meta.exclude.some((p) => globRe(p).test(url));
  }

  // ------------------------------------------------------------------ running scripts in the page

  // Page-side helper: storage and menu for scripts, and error reporting back to the loader.
  const PAGE_HELPER = `(function () {
    if (window.__upcLoader) return;
    var P = 'upc-gm:', cbs = {}, n = 0, items = [];
    window.__upcLoader = {
      items: items,
      run: function (id) { var fn = cbs[id]; if (fn) { try { fn(); } catch (x) { console.error(x); } } },
      get: function (s, k, d) { try { var v = localStorage.getItem(P + s + ':' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
      set: function (s, k, v) { try { localStorage.setItem(P + s + ':' + k, JSON.stringify(v)); } catch (e) {} },
      del: function (s, k) { try { localStorage.removeItem(P + s + ':' + k); } catch (e) {} },
      menu: function (s, label, fn) {
        var id = s + '#' + (++n); cbs[id] = fn;
        items.push({ id: id, script: s, label: String(label) });
        document.dispatchEvent(new CustomEvent('upc-loader-menu', { detail: JSON.stringify({ id: id, label: String(label) }) }));
        document.dispatchEvent(new CustomEvent('upc-menu-changed'));
        return id;
      },
      shared: function (op, key, value) {
        return new Promise(function (resolve) {
          var id = 'x' + (++n) + Math.random().toString(36).slice(2);
          var done = false;
          var h = function (e) { var d; try { d = JSON.parse(e.detail); } catch (x) { return; } if (d.id !== id) return; done = true; document.removeEventListener('upc-loader-shared-reply', h); resolve(d.value === undefined ? null : d.value); };
          document.addEventListener('upc-loader-shared-reply', h);
          document.dispatchEvent(new CustomEvent('upc-loader-shared', { detail: JSON.stringify({ id: id, op: op, key: key, value: value === undefined ? null : value }) }));
          setTimeout(function () { if (!done) { document.removeEventListener('upc-loader-shared-reply', h); resolve(null); } }, 3000);
        });
      },
      error: function (s, e) {
        console.error('[UPC loader] ' + s + ' failed:', e);
        document.dispatchEvent(new CustomEvent('upc-loader-error', { detail: JSON.stringify({ file: s, message: String(e && e.message || e) }) }));
      }
    };
    document.addEventListener('upc-loader-menu-click', function (e) { window.__upcLoader.run(e.detail); });
  })();`;

  function addScript(text) {
    const parent = document.head || document.documentElement;
    let el = null;
    try {
      // Tampermonkey's own way of adding a script, which works even where the page restricts inline scripts.
      el = GM_addElement(parent, 'script', { textContent: text });
    } catch (e) {
      el = document.createElement('script');
      el.textContent = text;
      parent.appendChild(el);
    }
    try { if (el) el.remove(); } catch (e) { /* already gone */ }
  }

  let helperAdded = false;
  const ran = {};          // file -> version running on this page
  const errors = [];       // { file, message }

  function wrap(file, code) {
    const s = JSON.stringify(file);
    return '(function () { var __u = window.__upcLoader;\n' +
      'var GM_getValue = function (k, d) { return __u.get(' + s + ', k, d); };\n' +
      'var GM_setValue = function (k, v) { __u.set(' + s + ', k, v); };\n' +
      'var GM_deleteValue = function (k) { __u.del(' + s + ', k); };\n' +
      'var GM_registerMenuCommand = function (l, f) { return __u.menu(' + s + ', l, f); };\n' +
      'try {\n' + code + '\n} catch (e) { __u.error(' + s + ', e); }\n})();\n' +
      '//# sourceURL=upc-scripts/' + file;
  }

  function runScript(entry, code) {
    if (ran[entry.file]) return;
    if (!helperAdded) { addScript(PAGE_HELPER); helperAdded = true; }
    ran[entry.file] = entry.version;
    addScript(wrap(entry.file, code));
  }

  // Start a script at the point its header asks for: document-start now, document-end at
  // DOMContentLoaded, anything else (Tampermonkey's default, document-idle) just after it.
  function schedule(entry, code) {
    const runAt = entry.meta.runAt;
    const go = () => runScript(entry, code);
    if (runAt === 'document-start') return go();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', runAt === 'document-end' || runAt === 'document-body' ? go : () => setTimeout(go, 0), { once: true });
    } else {
      go();
    }
  }

  function wanted(entry) {
    return !isOff(entry.file) && applies(entry.meta, location.href);
  }

  // Bridges for scripts' menu items and errors.
  // Scripts' menu items go in Halaxy's Script settings when that's running on the page (it marks the
  // page with data-upc-script-settings); otherwise, after the page has loaded, in the Tampermonkey menu.
  const tmItems = [];
  let tmDecided = false, tmUsed = false;
  const toTampermonkey = (d) => GM_registerMenuCommand(d.label, () => document.dispatchEvent(new CustomEvent('upc-loader-menu-click', { detail: d.id })));
  function decideMenu() {
    if (tmDecided) return;
    tmDecided = true;
    tmUsed = !root.hasAttribute('data-upc-script-settings');
    if (tmUsed) tmItems.forEach(toTampermonkey);
  }
  document.addEventListener('upc-script-settings-ready', () => { if (!tmDecided) { tmDecided = true; tmUsed = false; } });
  window.addEventListener('load', () => setTimeout(decideMenu, 4000));
  document.addEventListener('upc-loader-menu', (e) => {
    if (!isTop) return;
    try {
      const d = JSON.parse(e.detail);
      if (!tmDecided) tmItems.push(d);
      else if (tmUsed) toTampermonkey(d);
    } catch (x) { /* ignore */ }
  });
  document.addEventListener('upc-loader-error', (e) => {
    try { errors.push(JSON.parse(e.detail)); } catch (x) { /* ignore */ }
  });
  // Shared values (Halaxy to an insurer portal on this PC). A value with forHost goes back only to Halaxy and that site.
  document.addEventListener('upc-loader-shared', (e) => {
    let d;
    try { d = JSON.parse(e.detail); } catch (x) { return; }
    if (!d || typeof d.key !== 'string' || !/^[a-z0-9:-]{1,60}$/.test(d.key)) return;
    const key = 'shared:' + d.key;
    const mayRead = (v) => !v || !v.forHost || onHalaxy || v.forHost === location.hostname;
    let value = null;
    try {
      const was = GM_getValue(key, null);
      if (d.op === 'get') value = mayRead(was) ? was : null;
      else if (d.op === 'set' && mayRead(was)) { GM_setValue(key, d.value); value = d.value; }
      else if (d.op === 'del' && mayRead(was)) GM_deleteValue(key);
    } catch (x) { /* storage unavailable */ }
    document.dispatchEvent(new CustomEvent('upc-loader-shared-reply', { detail: JSON.stringify({ id: d.id, value }) }));
  });

  // ------------------------------------------------------------------ start: run the saved copies

  (readIndex() || { scripts: [] }).scripts.forEach((entry) => {
    if (!wanted(entry)) return;
    const code = GM_getValue(codeKey(entry.file), null);
    if (code) schedule(entry, code);
  });

  // ------------------------------------------------------------------ updates from GitHub

  function get(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        nocache: true,
        timeout: 20000,
        onload: (r) => (r.status === 200 ? resolve(r.responseText) : reject(new Error('GitHub returned ' + r.status + ' for ' + url))),
        onerror: () => reject(new Error('Could not reach GitHub')),
        ontimeout: () => reject(new Error('GitHub took too long to answer')),
      });
    });
  }

  function syntaxOk(code) {
    try { new Function(code); return true; } catch (e) { return !(e instanceof SyntaxError); }   // eval may be blocked: then trust it
  }

  // Moves a renamed script's switch (on or off on this PC) and its saved settings (GM_* values) to its new file name.
  function moveScript(from, to) {
    try {
      const off = local.get('off', {});
      if (off[from]) { off[to] = true; delete off[from]; local.set('off', off); pcCopy(); }
      const pre = 'upc-gm:' + from + ':', now = 'upc-gm:' + to + ':';
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(pre)) keys.push(k); }
      keys.forEach((k) => {
        const nk = now + k.slice(pre.length);
        if (localStorage.getItem(nk) === null) localStorage.setItem(nk, localStorage.getItem(k));
        localStorage.removeItem(k);
      });
    } catch (e) { /* storage blocked: the script starts with its defaults */ }
  }

  // Scripts are named "UPC <Group>: <Name>"; lists show them under their group, in this order.
  const GROUPS = ['Billing', 'Patients', 'Calendar', 'Look', 'System'];
  function grouped(list) {
    const parse = (n) => { const m = String(n || '').replace(/\s*\(beta\)\s*$/i, '').match(/^UPC (\w+): (.+)$/); return m ? { group: m[1], short: m[2] } : { group: 'Other', short: String(n || '').replace(/\s*\(beta\)\s*$/i, '') }; };
    const rank = (g) => { const i = GROUPS.indexOf(g); return i < 0 ? GROUPS.length : i; };
    const rows = list.map((s) => Object.assign({ short: parse(s.name).short, group: parse(s.name).group }, s));
    rows.sort((a, b) => rank(a.group) - rank(b.group) || a.short.localeCompare(b.short));
    return rows;
  }

  let checking = null;
  function checkForUpdates() {
    if (checking) return checking;
    checking = (async () => {
      const result = { updated: [], added: [], removed: [], problems: [] };
      try {
        const manifest = JSON.parse(await get(RAW + channel + '/scripts.json?t=' + Date.now()));
        if (!manifest || !Array.isArray(manifest.scripts)) throw new Error('The script list on GitHub is not readable');
        const old = readIndex() || { scripts: [] };
        const oldBy = {};
        old.scripts.forEach((s) => { oldBy[s.file] = s; });
        const next = [];
        let stale = false;

        for (const item of manifest.scripts) {
          // A renamed script ("was" in the list): keep this PC's switch and the script's saved settings.
          if (item.was && !oldBy[item.file] && oldBy[item.was] && onHalaxy) moveScript(item.was, item.file);
          const have = oldBy[item.file];
          if (have && have.version === item.version && GM_getValue(codeKey(item.file), null)) {
            next.push(have);
            continue;
          }
          try {
            const code = await get(RAW + channel + '/' + item.file + '?v=' + encodeURIComponent(item.version));
            const meta = parseMeta(code);
            if (!meta) throw new Error('no script header');
            if (meta.version !== item.version) { stale = true; throw new Error('GitHub is still serving version ' + meta.version); }
            if (!syntaxOk(code)) throw new Error('the new version has a syntax error');
            GM_setValue(codeKey(item.file), code);
            const entry = { file: item.file, name: meta.name || item.name, version: meta.version, meta };
            next.push(entry);
            (have ? result.updated : result.added).push(entry);
          } catch (e) {
            result.problems.push((item.name || item.file) + ': ' + e.message);
            if (have) next.push(have);   // keep the copy that works
          }
        }
        const keep = new Set(next.map((s) => s.file));
        old.scripts.forEach((s) => {
          if (!keep.has(s.file)) { result.removed.push(s); try { GM_deleteValue(codeKey(s.file)); } catch (e) { /* ignore */ } }
        });
        GM_setValue(indexKey, { checked: Date.now(), scripts: next });
        local.set('lastCheck:' + channel, stale ? Date.now() - (CHECK_EVERY_MINUTES - RETRY_STALE_MINUTES) * 60000 : Date.now());

        // A script this PC has never had: start it now rather than on the next page.
        result.added.forEach((entry) => { if (wanted(entry)) schedule(entry, GM_getValue(codeKey(entry.file), '')); });
        if (result.updated.length || result.added.length || result.removed.length) {
          console.info(TAG, 'scripts updated:', result.updated.map((s) => s.name + ' ' + s.version).join(', ') || 'none',
            '| added:', result.added.map((s) => s.name).join(', ') || 'none', '| removed:', result.removed.map((s) => s.name).join(', ') || 'none');
        }
      } catch (e) {
        result.problems.push(e.message);
        local.set('lastCheck:' + channel, Date.now() - (CHECK_EVERY_MINUTES - RETRY_STALE_MINUTES) * 60000);
      }
      local.set('lastProblems:' + channel, result.problems);
      if (result.problems.length) console.warn(TAG, result.problems.join('; '));
      checking = null;
      return result;
    })();
    return checking;
  }

  // ------------------------------------------------------------------ Script settings in Halaxy

  // The page's Script settings asks for the loader's state (upc-loader-get) and changes it
  // (upc-loader-do); the answer comes back as upc-loader-state.
  function state(extra) {
    const idx = readIndex();
    const off = local.get('off', {});
    return Object.assign({
      version: VERSION, channel, chosen: local.get('channel', 'stable') === 'beta' ? 'beta' : 'stable',
      lastCheck: local.get('lastCheck:' + channel, 0),
      scripts: grouped(idx ? idx.scripts : []).map((x) => ({ file: x.file, name: x.name, group: x.group, short: x.short, version: x.version, on: !off[x.file],
        status: ran[x.file] ? 'running' : applies(x.meta, location.href) ? (off[x.file] ? 'off' : 'next') : 'unused' })),
      problems: local.get('lastProblems:' + channel, []).concat(errors.map((x) => x.file + ' stopped with an error: ' + x.message)),
    }, extra || {});
  }
  const reply = (extra) => document.dispatchEvent(new CustomEvent('upc-loader-state', { detail: JSON.stringify(state(extra)) }));
  if (isTop) {
    document.addEventListener('upc-loader-get', () => reply());
    document.addEventListener('upc-loader-do', async (e) => {
      let d;
      try { d = JSON.parse(e.detail); } catch (x) { return; }
      if (d.act === 'channel' && (d.value === 'stable' || d.value === 'beta')) { local.set('channel', d.value); pcCopy(); }
      else if (d.act === 'switch' && d.file) {
        const off = local.get('off', {});
        if (d.on) delete off[d.file]; else off[d.file] = true;
        local.set('off', off);
        pcCopy();
      } else if (d.act === 'panel') { openPanel(); return; }
      else if (d.act === 'check') {
        if (local.get('channel', 'stable') !== channel) { reply({ reloadNeeded: true }); return; }   // new channel: fetched on load
        const r = await checkForUpdates();
        reply({ checked: { updated: r.updated.length, added: r.added.length, removed: r.removed.length, problems: r.problems.length } });
        return;
      }
      reply();
    });
  }

  if (isTop && onHalaxy) {
    const last = local.get('lastCheck:' + channel, 0);
    if (!readIndex() || Date.now() - last > CHECK_EVERY_MINUTES * 60000) checkForUpdates();
    GM_registerMenuCommand('UPC scripts: settings and updates', openPanel);
  }

  // ------------------------------------------------------------------ settings panel

  function openPanel() {
    if (document.getElementById('upc-loader-panel')) return;
    const host = document.createElement('div');
    host.id = 'upc-loader-panel';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483000;';
    const sh = host.attachShadow({ mode: 'open' });
    sh.innerHTML = `
      <style>
        .bg { position: fixed; inset: 0; background: rgba(20,24,35,.45); display: flex; align-items: center; justify-content: center; }
        .d { font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Arial, sans-serif; color: #1d2433; background: #fff; border-radius: 10px;
             box-shadow: 0 12px 40px rgba(0,0,0,.25); width: min(560px, calc(100vw - 32px)); max-height: calc(100vh - 48px); overflow: auto; padding: 20px; }
        h2 { font-size: 16px; margin: 0 0 4px; }
        .muted { color: #5b6478; font-size: 12.5px; }
        .row { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-top: 1px solid #eceef3; }
        .grp { margin-top: 12px; padding-bottom: 2px; font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: #5b6478; }
        .row:first-child { border-top: 0; }
        .row label { flex: 1; display: flex; align-items: center; gap: 8px; cursor: pointer; }
        .ver { color: #5b6478; font-variant-numeric: tabular-nums; font-size: 12.5px; white-space: nowrap; }
        .chan { display: flex; gap: 16px; margin: 12px 0; }
        .chan label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
        .list { margin: 8px 0 4px; }
        .err { color: #b3261e; font-size: 12.5px; }
        .note { background: #fff8db; border: 1px solid #e0b400; border-radius: 6px; padding: 8px 10px; margin-top: 10px; font-size: 13px; }
        .btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
        button { font: inherit; border-radius: 6px; padding: 7px 14px; cursor: pointer; border: 1px solid #c9cfdc; background: #fff; color: #1d2433; }
        button.p { background: #1d4ed8; border-color: #1d4ed8; color: #fff; }
        button[disabled] { opacity: .5; cursor: default; }
      </style>
      <div class="bg"><div class="d" role="dialog" aria-label="UPC Halaxy scripts">
        <h2>UPC Halaxy scripts</h2>
        <div class="muted status"></div>
        <div class="chan">
          <label><input type="radio" name="ch" value="stable"> Stable (clinic PCs)</label>
          <label><input type="radio" name="ch" value="beta"> Beta (testing new changes)</label>
        </div>
        <div class="list"></div>
        <div class="problems"></div>
        <div class="note" hidden>Refresh Halaxy to apply these changes.</div>
        <div class="btns">
          <button type="button" data-act="check">Check for updates now</button>
          <button type="button" data-act="refresh" hidden>Refresh Halaxy</button>
          <button type="button" class="p" data-act="close">Close</button>
        </div>
      </div></div>`;
    document.documentElement.appendChild(host);
    const $ = (s) => sh.querySelector(s);
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const needRefresh = () => { $('.note').hidden = false; $('[data-act="refresh"]').hidden = false; };
    const time = (t) => (t ? new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never');

    function render() {
      const idx = readIndex();
      const off = local.get('off', {});
      $('.status').textContent = 'Loader ' + VERSION + '. Last checked for updates: ' + time(local.get('lastCheck:' + channel, 0)) + '.';
      sh.querySelectorAll('input[name="ch"]').forEach((r) => { r.checked = r.value === channel; });
      const list = idx && idx.scripts.length ? idx.scripts : null;
      let last = '';
      const rows = list ? grouped(list) : [];
      if (rows.every((r) => r.group === 'Other')) last = 'Other';   // no grouped names yet (stable before promotion): no headings
      $('.list').innerHTML = list ? rows.map((s) => {
        const here = ran[s.file] ? 'running on this page' : (applies(s.meta, location.href) ? (off[s.file] ? 'switched off' : 'starts on next page') : 'not used on this page');
        const head = s.group !== last ? `<div class="grp">${esc(s.group)}</div>` : '';
        last = s.group;
        return head + `<div class="row"><label><input type="checkbox" data-file="${esc(s.file)}" ${off[s.file] ? '' : 'checked'}> ${esc(s.short)}</label>` +
          `<span class="ver">${esc(s.version)} · ${here}</span></div>`;
      }).join('') : '<p class="muted">No scripts saved yet. Check for updates to fetch them.</p>';
      const probs = local.get('lastProblems:' + channel, []).concat(errors.map((e) => e.file + ' stopped with an error: ' + e.message));
      $('.problems').innerHTML = probs.map((p) => '<div class="err">' + esc(p) + '</div>').join('');
    }

    sh.addEventListener('change', (e) => {
      const t = e.target;
      if (t.name === 'ch') {
        local.set('channel', t.value);
        pcCopy();
        needRefresh();
      } else if (t.dataset.file) {
        const off = local.get('off', {});
        if (t.checked) delete off[t.dataset.file]; else off[t.dataset.file] = true;
        local.set('off', off);
        pcCopy();
        needRefresh();
      }
    });
    sh.addEventListener('click', async (e) => {
      const act = e.target.closest && e.target.closest('[data-act]');
      if (!act) return;
      const a = act.dataset.act;
      if (a === 'close') host.remove();
      else if (a === 'refresh') location.reload();
      else if (a === 'check') {
        if (local.get('channel', 'stable') !== channel) { location.reload(); return; }   // new channel: fetched on load
        act.disabled = true;
        act.textContent = 'Checking...';
        const r = await checkForUpdates();
        act.disabled = false;
        act.textContent = 'Check for updates now';
        if (r.updated.length || r.removed.length) needRefresh();
        render();
        if (!r.updated.length && !r.added.length && !r.removed.length && !r.problems.length) $('.status').textContent += ' Everything is up to date.';
      }
    });
    render();
  }
  }
})();
