// ==UserScript==
// @name         UPC System: Block error reporting (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.1.0
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/block-error-reporting.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/block-error-reporting.user.js
// @description  Stops Halaxy's error reporting service (Sentry) loading or sending anything from this PC, so errors and activity from our scripts stay on the PC. Halaxy works as before.
// @match        https://*.halaxy.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * Block error reporting (Carl, 12 Nov 2026): "is there anything we can implement to robustly block Sentry and our
 * scripts leaking to Halaxy from our end?"
 *
 * Halaxy's pages load Sentry, a service that sends JavaScript errors (with the page address, the last clicks and
 * requests, and the code that failed) to Halaxy's developers. On a PC where the browser doesn't already block it, an
 * error in one of our scripts, or a list of our requests attached to one of Halaxy's own errors, would reach them.
 * This script stops that in three ways, each enough on its own:
 *  1. Sentry's script never runs: Firefox's beforescriptexecute stops it, and any script tag pointing at Sentry is
 *     disabled as it is added (other browsers).
 *  2. A do-nothing stand-in takes the name Sentry, so Halaxy's own calls to it ("Sentry.init", "Sentry.setUser") work
 *     quietly and the real Sentry, if it arrived some other way, can't take its place.
 *  3. Nothing reaches Sentry's servers: requests to them (fetch, XMLHttpRequest, sendBeacon) are answered here and
 *     never sent.
 * It runs before the page on every Halaxy page, including frames, whichever other scripts are switched on. The cost:
 * Halaxy's developers don't get crash reports from this PC (browsers' tracking protection often does the same).
 */
(function () {
  'use strict';
  if (window.__upcBlockErrorReporting) return;
  window.__upcBlockErrorReporting = true;
  const VERSION = '0.1.0';

  const HOST = /(^|\.)(sentry\.io|sentry-cdn\.com|sentry\.halaxy\.com)$/i;
  const SRC = /sentry/i;   // script addresses: Sentry's CDN, or a copy Halaxy serves itself (".../sentry.min.js")
  const blocked = { scripts: 0, requests: 0 };
  window.__upcBlockErrorReporting = { version: VERSION, blocked };

  const isSentryUrl = (u) => {
    try { return HOST.test(new URL(String(u), location.href).hostname); } catch (e) { return false; }
  };

  // ---- 2. The stand-in: every property is a function that does nothing and returns the stand-in, so chains such as
  //         Sentry.getCurrentScope().setTag(...) work too. Fixed in place before any page script runs.
  const noop = function () { return stub; };
  const stub = new Proxy(noop, {
    get(target, prop) {
      if (prop === Symbol.toPrimitive) return () => '';
      if (prop === 'then') return undefined;   // never looks like a promise
      if (prop === 'SDK_VERSION') return '0';
      return stub;
    },
    apply() { return stub; },
    construct() { return stub; },
    set() { return true; },
  });
  ['Sentry', '__SENTRY__'].forEach((name) => {
    try { Object.defineProperty(window, name, { get: () => stub, set: () => {}, configurable: false }); } catch (e) { /* already fixed */ }
  });

  // ---- 1. Sentry's script never runs.
  // Only scripts loaded from a Sentry address: Halaxy's own inline code (which may call Sentry.init among other things)
  // must run, and the stand-in answers its calls.
  const isSentryScript = (el) => !!el && el.tagName === 'SCRIPT' && SRC.test(el.getAttribute('src') || '');
  const disable = (el) => {
    blocked.scripts++;
    el.type = 'javascript/blocked';   // a script of an unknown type is never run
    el.removeAttribute('src');
    if (el.parentNode) el.parentNode.removeChild(el);
  };
  document.addEventListener('beforescriptexecute', (e) => {   // Firefox: stops even scripts already in the page's HTML
    if (isSentryScript(e.target)) { e.preventDefault(); e.stopPropagation(); disable(e.target); }
  }, true);
  new MutationObserver((list) => {
    list.forEach((m) => m.addedNodes.forEach((n) => {
      if (isSentryScript(n)) disable(n);
      else if (n.querySelectorAll) n.querySelectorAll('script').forEach((x) => { if (isSentryScript(x)) disable(x); });
    }));
  }).observe(document.documentElement || document, { childList: true, subtree: true });
  // Scripts added by code: refuse a Sentry address before the browser starts fetching it.
  try {
    const desc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
    Object.defineProperty(HTMLScriptElement.prototype, 'src', {
      configurable: true, enumerable: desc.enumerable, get() { return desc.get.call(this); },
      set(v) { if (SRC.test(String(v))) { blocked.scripts++; this.type = 'javascript/blocked'; return; } desc.set.call(this, v); },
    });
    const setAttr = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      if (this.tagName === 'SCRIPT' && String(name).toLowerCase() === 'src' && SRC.test(String(value))) { blocked.scripts++; this.type = 'javascript/blocked'; return; }
      return setAttr.call(this, name, value);
    };
  } catch (e) { /* the other layers still apply */ }

  // ---- 3. Nothing reaches Sentry's servers.
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      const url = input && typeof input === 'object' && 'url' in input ? input.url : input;
      if (isSentryUrl(url)) { blocked.requests++; return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })); }
      return origFetch.apply(this, arguments);
    };
  }
  const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__upcSentry = isSentryUrl(url);
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (this.__upcSentry) { blocked.requests++; return; }   // never sent
    return XS.apply(this, arguments);
  };
  if (navigator.sendBeacon) {
    const beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      if (isSentryUrl(url)) { blocked.requests++; return true; }
      return beacon(url, data);
    };
  }
})();
