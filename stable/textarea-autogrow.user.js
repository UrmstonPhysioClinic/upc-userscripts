// ==UserScript==
// @name         Halaxy: auto-expanding text boxes
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      1.1
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/stable/textarea-autogrow.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/stable/textarea-autogrow.user.js
// @description  Makes multi-line text boxes and rich text editors in Halaxy grow to fit their content instead of scrolling.
// @match        https://*.halaxy.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // Optional cap in pixels (e.g. 600). Leave as 0 for no cap: the box always fits its text.
  const MAX_HEIGHT = 0;

  const SKIP = 'textarea[readonly], textarea[aria-hidden="true"], .cke textarea';

  // Rich text editors (CKEditor 5): Halaxy caps them at 350px (800px in the composer) and
  // scrolls. Remove the cap so they grow with their content. Minimum heights and full-screen
  // mode are left as Halaxy has them; CKEditor keeps its toolbar pinned while you scroll.
  const editorCss = `
    div.ck-editor:not(.fullscreen) .ck-editor__editable,
    div.ck-editor:not(.fullscreen) .ck-editor__editable_inline {
      max-height: ${MAX_HEIGHT > 0 ? MAX_HEIGHT + 'px' : 'none'} !important;
    }
  `;
  const editorStyle = document.createElement('style');
  editorStyle.textContent = editorCss;
  (function addStyle() {
    const target = document.head || document.documentElement;
    if (target) target.appendChild(editorStyle);
    else setTimeout(addStyle, 10);
  })();

  function fit(ta) {
    if (!(ta instanceof HTMLTextAreaElement) || ta.matches(SKIP)) return;
    if (!ta.offsetParent && getComputedStyle(ta).position !== 'fixed') return; // hidden: fit later when shown

    // Remember scroll positions so the page (or a modal) doesn't jump while we measure.
    const scrollers = [];
    for (let el = ta.parentElement; el; el = el.parentElement) {
      if (el.scrollTop) scrollers.push([el, el.scrollTop]);
    }
    const winY = window.scrollY;

    const cs = getComputedStyle(ta);
    const borders = cs.boxSizing === 'border-box'
      ? parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)
      : -(parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom));

    ta.style.setProperty('height', 'auto', 'important'); // natural height, never smaller than its rows
    let h = ta.scrollHeight + borders;
    const capped = MAX_HEIGHT > 0 && h > MAX_HEIGHT;
    if (capped) h = MAX_HEIGHT;

    ta.style.setProperty('height', h + 'px', 'important');
    ta.style.setProperty('overflow-y', capped ? 'auto' : 'hidden', 'important');
    ta.dataset.hxAutogrow = h;

    scrollers.forEach(([el, top]) => { el.scrollTop = top; });
    if (window.scrollY !== winY) window.scrollTo(window.scrollX, winY);
  }

  // Re-fit when a hidden box (e.g. in a modal or tab) becomes visible or changes width.
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      const ta = e.target;
      if (e.contentRect.width && ta.dataset.hxWidth !== String(e.contentRect.width)) {
        ta.dataset.hxWidth = e.contentRect.width;
        fit(ta);
      }
    }
  });

  // Halaxy (or another script) resetting the inline height: put ours back.
  const styleWatch = new MutationObserver((muts) => {
    for (const m of muts) {
      const ta = m.target;
      if (ta.dataset.hxAutogrow && ta.style.height !== ta.dataset.hxAutogrow + 'px') fit(ta);
    }
  });

  function attach(ta) {
    if (ta.dataset.hxAttached) return;
    ta.dataset.hxAttached = '1';
    ro.observe(ta);
    styleWatch.observe(ta, { attributes: true, attributeFilter: ['style'] });
    fit(ta);
  }

  function scan(root) {
    if (root.tagName === 'TEXTAREA') attach(root);
    else if (root.querySelectorAll) root.querySelectorAll('textarea').forEach(attach);
  }

  // Typing, pasting, focus.
  document.addEventListener('input', (e) => fit(e.target), true);
  document.addEventListener('focusin', (e) => fit(e.target), true);

  // Text set by code (Halaxy loading a saved note, other userscripts inserting text) fires no input event.
  const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  Object.defineProperty(HTMLTextAreaElement.prototype, 'value', {
    configurable: true,
    enumerable: desc.enumerable,
    get: desc.get,
    set(v) {
      desc.set.call(this, v);
      if (this.dataset.hxAttached) requestAnimationFrame(() => fit(this));
    },
  });

  function start() {
    scan(document.body);
    new MutationObserver((muts) => {
      for (const m of muts) m.addedNodes.forEach((n) => n.nodeType === 1 && scan(n));
    }).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', () => document.querySelectorAll('textarea[data-hx-attached]').forEach(fit));
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
