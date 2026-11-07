// ==UserScript==
// @name         Halaxy: HTML source for emails (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.4
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/email-html-source.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/email-html-source.user.js
// @description  Adds a <> button to Halaxy email editors (compose pop-up, reminder templates, communication templates) to edit the body as raw HTML with a live preview. The HTML is saved or sent as written, not filtered by the editor.
// @match        https://eu.halaxy.com/a/pr/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const TAG = '[HX raw HTML]';

  // Editors that hold an email body. Subject and SMS editors are left alone.
  //   form[body]                     email compose pop-up
  //   form[emailNewAppointment] etc. Settings > Reminders
  //   form[contentForFormHandler]    Edit Email Communication Template
  // Other editors are logged to the console as "editor skipped: <field>",
  // so a new page only needs its field name adding here.
  const isEmailBodyField = (name) =>
    name === 'form[body]' ||
    name === 'form[contentForFormHandler]' ||
    /^form\[email[A-Za-z]*\]$/.test(name);

  // field name -> textarea, for every editor currently in HTML mode
  const actives = new Map();

  // ---------- 1. Fallback: put the raw HTML into outgoing XHRs ----------
  // The main mechanism is the data.get override in attach(). This catches
  // any request that was serialised another way.
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._hxRaw = { method: String(method).toUpperCase(), url: String(url) };
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try {
      const m = this._hxRaw;
      if (m && m.method === 'POST' && actives.size) {
        for (const [field, ta] of actives) {
          if (!document.contains(ta)) continue;
          if (typeof body === 'string' && body.includes(encodeURIComponent(field) + '=')) {
            const p = new URLSearchParams(body);
            p.set(field, ta.value);
            body = p.toString();
            console.info(TAG, 'request:', field, 'sent as raw HTML,', ta.value.length, 'characters');
          } else if (typeof FormData !== 'undefined' && body instanceof FormData && body.has(field)) {
            body.set(field, ta.value);
            console.info(TAG, 'request (FormData):', field, 'sent as raw HTML,', ta.value.length, 'characters');
          }
        }
      }
    } catch (e) {
      console.error(TAG, e);
    }
    return origSend.call(this, body);
  };

  // ---------- 2. Styles ----------
  const css = document.createElement('style');
  css.textContent = `
    .hx-raw-panel{display:flex;flex-wrap:wrap;gap:8px;padding:8px;border:1px solid var(--ck-color-base-border,#c4c4c4);border-top:0;background:var(--vs-form-bg-color,#fff)}
    .hx-raw-panel textarea,.hx-raw-panel iframe{flex:1 1 300px;min-height:420px;box-sizing:border-box}
    .hx-raw-panel textarea.form-control{height:auto;font-family:ui-monospace,Consolas,"Liberation Mono",monospace;white-space:pre;tab-size:2;resize:vertical}
    .hx-raw-panel iframe{border:1px solid var(--vs-form-border-color,#ced4da);border-radius:4.8px;background:#fff}
    .hx-raw-bar{flex-basis:100%;display:flex;flex-wrap:wrap;align-items:center;gap:8px}
    .hx-raw-panel .btn{margin:0}
    .hx-raw-bar .hx-raw-note{flex:1 1 auto}
    .hx-raw-warn{flex-basis:100%;color:var(--vs-balance-negative-color,#ec6b65)}
    .hx-raw-warn:empty{display:none}
    .hx-raw-confirm{flex-basis:100%;padding:8px 12px;border:1px solid #e0b400;border-radius:4.8px;background:#fff8db}
    .hx-raw-confirm button{margin-left:8px}
    .hx-raw-btn .ck-button__label{font-family:ui-monospace,Consolas,monospace;font-weight:bold}
    .hx-raw-btn.hx-raw-flag .ck-button__label{color:#c05600}
  `;
  document.head.appendChild(css);

  // ---------- 3. Helpers ----------
  // Put each block-level tag on its own line so the source is readable.
  const tidy = (h) =>
    h.replace(/>\s*(<\/?(?:p|h[1-6]|ul|ol|li|table|thead|tbody|tr|td|th|blockquote|figure|hr|div|br)\b)/gi, '>\n$1').trim();

  const norm = (h) => h.replace(/&nbsp;|\s+/g, '').toLowerCase();

  // Things Halaxy's server is known to strip (from testing). Extend as more are found.
  const STRIPPED = [
    [/display\s*:/i, 'display (use a table cell for button boxes)'],
    [/border-radius\s*:/i, 'border-radius'],
    [/\srole\s*=/i, 'role attribute'],
  ];

  // The form field an editor writes to: its source textarea, or the field just before it.
  function sourceOf(ed) {
    const s = ed.sourceElement;
    if (s && s.name) return s;
    const prev = ed.ui.view.element && ed.ui.view.element.previousElementSibling;
    return prev && prev.name ? prev : null;
  }

  // ---------- 4. Attach to one editor ----------
  function attach(ed, src) {
    const field = src.name;
    const root = ed.ui.view.element;
    const main = root.querySelector('.ck-editor__main');
    const items = ed.ui.view.toolbar.element.querySelector('.ck-toolbar__items');
    if (!main || !items) return;

    // The field still holds the HTML as stored, before the editor filtered it.
    // If it holds more than the editor shows, HTML mode starts from the stored version.
    const original = src.value;
    const origGet = ed.data.get.bind(ed.data);
    const loaded = origGet();
    let useOriginal = norm(original) !== '' && norm(original) !== norm(loaded);
    let raw = false;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ck ck-button ck-button_with-text ck-off hx-raw-btn';
    btn.innerHTML = '<span class="ck ck-button__label">&lt;&gt;</span>';
    const setIdleTitle = () => {
      btn.classList.toggle('hx-raw-flag', useOriginal);
      btn.title = useOriginal
        ? 'This content has HTML the editor cannot show. Open HTML mode before editing to keep it.'
        : 'Edit HTML source';
    };
    setIdleTitle();
    items.appendChild(btn);

    const panel = document.createElement('div');
    panel.className = 'upc-native hx-raw-panel';
    panel.style.display = 'none';
    panel.innerHTML =
      '<textarea class="form-control" spellcheck="false" aria-label="HTML source"></textarea>' +
      '<iframe sandbox="" title="Email preview"></iframe>' +
      '<div class="hx-raw-bar">' +
        '<span class="hx-raw-note text-muted">HTML mode: this HTML is saved or sent as written (Halaxy still filters some CSS).</span>' +
        '<button type="button" class="btn btn-outline-primary-light hx-raw-act" data-act="back">Back to editor</button>' +
        '<div class="hx-raw-warn"></div>' +
      '</div>' +
      '<div class="hx-raw-confirm" style="display:none">' +
        'The editor will remove formatting it does not support, such as layout divs, inline styles, padding, borders and table styling.' +
        '<button type="button" class="btn btn-outline-primary-light hx-raw-act" data-act="yes">Switch to editor</button>' +
        '<button type="button" class="btn btn-outline-primary-light hx-raw-act" data-act="no">Stay in HTML</button>' +
      '</div>';
    main.after(panel);

    const ta = panel.querySelector('textarea');
    const frame = panel.querySelector('iframe');
    const warn = panel.querySelector('.hx-raw-warn');
    const confirmBox = panel.querySelector('.hx-raw-confirm');
    let timer = null;

    // While in HTML mode, anything that reads this editor (Halaxy's send code,
    // the form's own submit, autosave) gets the raw HTML, not the editor's version.
    ed.data.get = function (options) {
      return raw && document.contains(ta) ? ta.value : origGet(options);
    };

    const lint = () => {
      const hits = STRIPPED.filter(([re]) => re.test(ta.value)).map(([, label]) => label);
      warn.textContent = hits.length ? 'Halaxy will strip: ' + hits.join(', ') + '.' : '';
    };
    const preview = () => { frame.srcdoc = ta.value; lint(); };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(preview, 300); };

    ta.addEventListener('input', schedule);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
        schedule();
      }
    });

    // If Halaxy changes the body while in HTML mode (e.g. a template is picked),
    // reload the source from the editor.
    ed.model.document.on('change:data', () => {
      if (raw) {
        ta.value = tidy(origGet());
        preview();
      }
    });

    const setReadOnly = (on) => {
      if (ed.enableReadOnlyMode) {
        on ? ed.enableReadOnlyMode('hx-raw') : ed.disableReadOnlyMode('hx-raw');
      } else {
        ed.isReadOnly = on;
      }
    };

    function enter() {
      const current = origGet();
      ta.value = tidy(useOriginal && current === loaded ? original : current);
      preview();
      main.style.display = 'none';
      panel.style.display = '';
      setReadOnly(true);
      raw = true;
      actives.set(field, ta);
      btn.classList.remove('hx-raw-flag');
      btn.classList.replace('ck-off', 'ck-on');
      btn.title = 'Back to the editor';
      ta.focus();
    }

    function leave() {
      confirmBox.style.display = '';
    }

    function doLeave() {
      confirmBox.style.display = 'none';
      clearTimeout(timer);
      raw = false;
      actives.delete(field);
      useOriginal = false;
      try { ed.setData(ta.value); } catch (e) { console.error(TAG, e); }
      setReadOnly(false);
      panel.style.display = 'none';
      main.style.display = '';
      btn.classList.replace('ck-on', 'ck-off');
      setIdleTitle();
    }

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      console.debug(TAG, '<> clicked on', field, ', HTML mode was', raw);
      raw ? leave() : enter();
    });

    panel.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]');
      if (!act) return;
      e.preventDefault();
      e.stopPropagation();
      if (act.dataset.act === 'back') leave();
      else if (act.dataset.act === 'yes') doLeave();
      else if (act.dataset.act === 'no') confirmBox.style.display = 'none';
    });

    ed.on('destroy', () => { raw = false; actives.delete(field); });

    console.info(TAG, 'attached to', field, useOriginal ? '(stored HTML is richer than the editor shows)' : '');
  }

  // ---------- 5. Find editors as they appear ----------
  const seen = new WeakSet();
  function scan() {
    for (const el of document.querySelectorAll('.ck-editor__editable')) {
      const ed = el.ckeditorInstance;
      if (!ed || seen.has(ed)) continue;
      seen.add(ed);
      const src = sourceOf(ed);
      const name = src ? src.name : '(no form field)';
      if (src && isEmailBodyField(name)) attach(ed, src);
      else console.debug(TAG, 'editor skipped:', name);
    }
  }

  let t = null;
  new MutationObserver(() => {
    clearTimeout(t);
    t = setTimeout(scan, 200);
  }).observe(document.body, { childList: true, subtree: true });
  scan();
})();
