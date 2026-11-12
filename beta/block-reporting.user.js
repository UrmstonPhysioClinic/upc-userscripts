// ==UserScript==
// @name         UPC System: Block reporting to Halaxy (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.2.0
// @upc-was      block-error-reporting.user.js
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/block-reporting.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/block-reporting.user.js
// @description  Stops the services Halaxy's pages report through (Sentry error reports, Userpilot analytics) loading or sending anything from this PC, so errors, clicks and requests from our scripts stay on the PC. Halaxy works as before.
// @match        https://*.halaxy.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * Block reporting to Halaxy (Carl, 12 Nov 2026): "is there anything we can implement to robustly block Sentry and our
 * scripts leaking to Halaxy from our end?" and "Userpilot can go too".
 *
 * Halaxy's pages load two services that report what happens in the browser:
 *  - Sentry: JavaScript errors, with the page address, the last clicks and requests, and the code that failed, sent to
 *    Halaxy's developers. An error in one of our scripts, or a list of our requests attached to one of Halaxy's own
 *    errors, would reach them.
 *  - Userpilot: product analytics (pages visited, clicks, which could include clicks on our own buttons), and Halaxy's
 *    in-app tours, announcements and possibly its help panel.
 * For each, three layers, each enough on its own:
 *  1. Its script never runs: Firefox's beforescriptexecute stops it, any script tag pointing at it is disabled as it is
 *     added, and a script address set by code is refused.
 *  2. A do-nothing stand-in takes its name (Sentry, userpilot), so Halaxy's own calls work quietly and the real
 *     service, if it arrived some other way, can't take its place.
 *  3. Nothing reaches its servers: requests (fetch, XMLHttpRequest, sendBeacon, WebSocket) are answered here and
 *     never sent.
 * Runs before the page on every Halaxy page, including frames, whichever other scripts are switched on. The cost:
 * Halaxy's developers get no crash reports from this PC, and Halaxy's tours and announcements don't show. Userpilot
 * can be let through again on a PC from Script settings ("Halaxy's tours and announcements").
 */
(function () {
  'use strict';
  if (window.__upcBlockReporting) return;
  const VERSION = '0.2.0';
  const blocked = { scripts: 0, requests: 0 };
  window.__upcBlockReporting = { version: VERSION, blocked };

  const canStore = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
  const allowUserpilot = canStore ? GM_getValue('allowUserpilot', false) : false;
  if (canStore && typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Halaxy\'s tours and announcements (Userpilot): ' + (allowUserpilot ? 'shown (click to block)' : 'blocked (click to show)'), () => {
      GM_setValue('allowUserpilot', !allowUserpilot);
      location.reload();
    });
  }

  const services = [
    { name: 'Sentry', hosts: /(^|\.)(sentry\.io|sentry-cdn\.com)$/i, src: /sentry/i, globals: ['Sentry', '__SENTRY__'] },
  ];
  if (!allowUserpilot) services.push({ name: 'Userpilot', hosts: /(^|\.)(userpilot\.io|userpilot\.com)$/i, src: /userpilot/i, globals: ['userpilot'] });

  const blockedHost = (u) => {
    try { const h = new URL(String(u), location.href).hostname; return services.some((s) => s.hosts.test(h)); } catch (e) { return false; }
  };
  const blockedSrc = (v) => !!v && services.some((s) => s.src.test(String(v)));

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
  services.forEach((s) => s.globals.forEach((name) => {
    try { Object.defineProperty(window, name, { get: () => stub, set: () => {}, configurable: false }); } catch (e) { /* already fixed */ }
  }));

  // ---- 1. Their scripts never run. Only scripts loaded from their addresses: Halaxy's own inline code (which may call
  //         Sentry.init or userpilot.identify among other things) must run, and the stand-in answers it.
  const isBlockedScript = (el) => !!el && el.tagName === 'SCRIPT' && blockedSrc(el.getAttribute('src'));
  const disable = (el) => {
    blocked.scripts++;
    el.type = 'javascript/blocked';   // a script of an unknown type is never run
    el.removeAttribute('src');
    if (el.parentNode) el.parentNode.removeChild(el);
  };
  document.addEventListener('beforescriptexecute', (e) => {   // Firefox: stops even scripts already in the page's HTML
    if (isBlockedScript(e.target)) { e.preventDefault(); e.stopPropagation(); disable(e.target); }
  }, true);
  new MutationObserver((list) => {
    list.forEach((m) => m.addedNodes.forEach((n) => {
      if (isBlockedScript(n)) disable(n);
      else if (n.querySelectorAll) n.querySelectorAll('script[src]').forEach((x) => { if (isBlockedScript(x)) disable(x); });
    }));
  }).observe(document.documentElement || document, { childList: true, subtree: true });
  try {
    const desc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
    Object.defineProperty(HTMLScriptElement.prototype, 'src', {
      configurable: true, enumerable: desc.enumerable, get() { return desc.get.call(this); },
      set(v) { if (blockedSrc(v)) { blocked.scripts++; this.type = 'javascript/blocked'; return; } desc.set.call(this, v); },
    });
    const setAttr = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      if (this.tagName === 'SCRIPT' && String(name).toLowerCase() === 'src' && blockedSrc(value)) { blocked.scripts++; this.type = 'javascript/blocked'; return; }
      return setAttr.call(this, name, value);
    };
  } catch (e) { /* the other layers still apply */ }

  // ---- 3. Nothing reaches their servers.
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      const url = input && typeof input === 'object' && 'url' in input ? input.url : input;
      if (blockedHost(url)) { blocked.requests++; return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })); }
      return origFetch.apply(this, arguments);
    };
  }
  const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__upcBlocked = blockedHost(url);
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (this.__upcBlocked) { blocked.requests++; return; }   // never sent
    return XS.apply(this, arguments);
  };
  if (navigator.sendBeacon) {
    const beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      if (blockedHost(url)) { blocked.requests++; return true; }
      return beacon(url, data);
    };
  }
  // A connection to them never opens: it stays "connecting", so nothing retries in a loop.
  const WS = window.WebSocket;
  if (WS) {
    const Quiet = function (url) {
      if (!blockedHost(String(url).replace(/^ws/i, 'http'))) return new WS(...arguments);
      blocked.requests++;
      return { url: String(url), readyState: 0, bufferedAmount: 0, protocol: '', extensions: '', binaryType: 'blob',
        send() {}, close() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
        onopen: null, onmessage: null, onerror: null, onclose: null };
    };
    Quiet.prototype = WS.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach((k) => { Quiet[k] = WS[k]; });
    window.WebSocket = Quiet;
  }
})();
