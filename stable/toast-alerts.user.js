// ==UserScript==
// @name         Halaxy: toast alerts
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      1.1
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/stable/toast-alerts.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/stable/toast-alerts.user.js
// @description  Shows Halaxy's alert banners as floating toasts in the corner, so they no longer push the page up and down.
// @match        https://*.halaxy.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // 'bottom-right', 'bottom-left', 'top-right' or 'top-left'
  const POSITION = 'bottom-right';
  const TOP_OFFSET = 70;   // px below the top of the window when using a top position (clears Halaxy's header)

  const [v, h] = POSITION.split('-');
  // Bottom positions sit just above Halaxy's footer (kept up to date by keepAboveFooter below).
  const vertical = v === 'top' ? `top: ${TOP_OFFSET}px; bottom: auto;` : 'bottom: var(--upc-toast-bottom, 20px); top: auto;';
  const horizontal = h === 'left' ? 'left: 20px; right: auto;' : 'right: 20px; left: auto;';

  const css = `
    /* Halaxy's alert container: lift it out of the page so it never changes the layout. */
    #alerts.flashbang-alerts,
    #alerts {
      position: fixed !important;
      ${vertical}
      ${horizontal}
      z-index: 100001;
      width: 380px;
      max-width: calc(100vw - 40px);
      max-height: calc(100vh - 100px);
      min-height: 0 !important;
      margin: 0 !important;
      padding: 0 !important;
      display: flex;
      flex-direction: column;
      gap: 8px;
      overflow: hidden;
      pointer-events: none;        /* empty space in the stack doesn't block clicks */
    }
    #alerts > .alert {
      pointer-events: auto;
      margin: 0 !important;
      padding: 10px 36px 10px 14px;
      border-radius: .4rem;
      border-width: 0 0 0 4px;
      border-style: solid;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
      font-size: .85rem;
      line-height: 1.35;
      position: relative;
      animation: upc-toast-in 220ms ease-out;
    }
    #alerts > .alert .close {
      position: absolute;
      top: 6px;
      right: 10px;
      float: none;
      padding: 0;
      line-height: 1;
    }
    #alerts > .alert-success { border-left-color: #28a745; }
    #alerts > .alert-info    { border-left-color: #17a2b8; }
    #alerts > .alert-warning { border-left-color: #ffc107; }
    #alerts > .alert-danger,
    #alerts > .alert-error,
    #alerts > .alert-bad     { border-left-color: #dc3545; }

    @keyframes upc-toast-in {
      from { opacity: 0; transform: translateY(${v === 'top' ? '-8px' : '8px'}); }
      to   { opacity: 1; transform: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      #alerts > .alert { animation: none; }
    }
  `;

  const style = document.createElement('style');
  style.textContent = css;
  (function add() {
    const target = document.head || document.documentElement;
    if (target) target.appendChild(style);
    else setTimeout(add, 10);
  })();

  // Keep bottom toasts clear of the footer (copyright / CONTACT US bar) wherever it is on screen.
  function keepAboveFooter() {
    if (v === 'top') return;
    const f = document.getElementById('footer');
    let gap = 20;
    if (f && f.offsetParent !== null) {
      const top = f.getBoundingClientRect().top;
      if (top < window.innerHeight) gap = Math.max(20, window.innerHeight - top + 12);
    }
    document.documentElement.style.setProperty('--upc-toast-bottom', gap + 'px');
  }
  let queued = false;
  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; keepAboveFooter(); });
  };
  window.addEventListener('resize', queue);
  window.addEventListener('scroll', queue, true);
  window.addEventListener('load', queue);
  document.addEventListener('DOMContentLoaded', () => {
    queue();
    // Re-check when an alert appears, in case the layout changed since the last check.
    const alerts = document.getElementById('alerts');
    if (alerts) new MutationObserver(queue).observe(alerts, { childList: true });
  });
})();
