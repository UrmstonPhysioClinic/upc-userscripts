// ==UserScript==
// @name         UPC Calendar: Alerts
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      1.0.1
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/stable/alerts.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/stable/alerts.user.js
// @description  Loud chime when a patient arrives, and an urgent alarm that repeats when a chat message comes in until someone clicks or types. Plays once per PC however many Halaxy tabs are open. Each sound can be switched off per PC from the Tampermonkey menu.
// @match        https://*.halaxy.com/*
// @grant        none
// @noframes
// ==/UserScript==

/*
 * Replaces two earlier scripts: "Halaxy notification chime" 1.2 (arrivals) and
 * "Halaxy unread count chime" 1.4 (chat). The sounds and timings are unchanged.
 *
 * New:
 * - With several Halaxy tabs open, each alert sounds once, not once per tab.
 *   Tabs on the same PC agree through this browser's storage.
 * - A click or keypress in any Halaxy tab stops the chat alarm in every tab.
 * - Arrival chime and chat alarm can each be switched off on a PC from the
 *   Tampermonkey menu (under "UPC Halaxy scripts").
 */

(function () {
  'use strict';
  if (window.__hxAlerts) return;
  window.__hxAlerts = true;

  const VERSION = '1.0.1';
  const CHAT_BADGE_ID = 'btn-chat-popover-open';
  const REPEAT_EVERY_SECONDS = (window.__hxAlertsTest && window.__hxAlertsTest.repeatSeconds) || 15;   // chat alarm repeat
  const MAX_REPEATS = 10;            // set to 0 to sound once only
  const SHARED = 'upc-alerts:';      // storage keys shared by this PC's Halaxy tabs
  const TAB = Math.random().toString(36).slice(2);

  // ---- Per-PC switches (Tampermonkey menu) ----
  const canStore = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
  const arrivalOn = canStore ? GM_getValue('arrivalChime', true) : true;
  const chatOn = canStore ? GM_getValue('chatAlarm', true) : true;
  if (canStore && typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Arrival chime: ' + (arrivalOn ? 'on (click to turn off)' : 'off (click to turn on)'), () => {
      GM_setValue('arrivalChime', !arrivalOn);
      location.reload();
    });
    GM_registerMenuCommand('Chat alarm: ' + (chatOn ? 'on (click to turn off)' : 'off (click to turn on)'), () => {
      GM_setValue('chatAlarm', !chatOn);
      location.reload();
    });
  }
  if (!arrivalOn && !chatOn) return;

  // ---- Turn a rendered sound into a playable audio clip ----
  function toWavUrl(buffer) {
    const data = buffer.getChannelData(0);
    const len = data.length;
    const out = new DataView(new ArrayBuffer(44 + len * 2));
    const str = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); out.setUint32(4, 36 + len * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
    out.setUint32(24, buffer.sampleRate, true); out.setUint32(28, buffer.sampleRate * 2, true);
    out.setUint16(32, 2, true); out.setUint16(34, 16, true);
    str(36, 'data'); out.setUint32(40, len * 2, true);
    for (let i = 0; i < len; i++) {
      const s = Math.max(-1, Math.min(1, data[i]));
      out.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return URL.createObjectURL(new Blob([out], { type: 'audio/wav' }));
  }

  async function renderSound(seconds, schedule) {
    const rate = 44100;
    const off = new OfflineAudioContext(1, Math.ceil(rate * seconds), rate);
    schedule(off);
    return toWavUrl(await off.startRendering());
  }

  function playClip(url) {
    if (!url) return;
    const a = new Audio(url);
    a.play().catch(() => {
      // Firefox refused: play on the next click or keypress instead
      const retry = () => {
        document.removeEventListener('pointerdown', retry, true);
        document.removeEventListener('keydown', retry, true);
        a.play().catch(() => {});
      };
      document.addEventListener('pointerdown', retry, true);
      document.addEventListener('keydown', retry, true);
    });
  }

  function limiterFor(ctx) {
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -20;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;
    limiter.connect(ctx.destination);
    return limiter;
  }

  // ---- Arrival chime: rising C, E, G, played three times ----
  function scheduleChime(ctx) {
    const limiter = limiterFor(ctx);
    const notes = [1046.5, 1318.5, 1568.0];
    [0, 1.3, 2.6].forEach((offset) => {
      notes.forEach((freq, i) => {
        const t = offset + i * 0.15;
        [[freq, 1.0, 'triangle'], [freq * 2, 0.3, 'sine']].forEach(([f, level, type]) => {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.type = type;
          o.frequency.value = f;
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(level, t + 0.01);
          g.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
          o.connect(g).connect(limiter);
          o.start(t);
          o.stop(t + 1.25);
        });
      });
    });
  }

  // ---- Chat alarm: three bursts of alternating high beeps ----
  function scheduleUrgent(ctx) {
    const limiter = limiterFor(ctx);
    const tones = [1760.0, 2349.3]; // alternating A and D, a fourth apart
    [0, 1.1, 2.2].forEach((burstStart) => {
      for (let i = 0; i < 6; i++) {
        const t = burstStart + i * 0.15;
        const f = tones[i % 2];
        [[f, 0.9, 'triangle'], [f * 2, 0.3, 'sine']].forEach(([freq, level, type]) => {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.type = type;
          o.frequency.value = freq;
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(level, t + 0.003);
          g.gain.setValueAtTime(level, t + 0.07);
          g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
          o.connect(g).connect(limiter);
          o.start(t);
          o.stop(t + 0.11);
        });
      }
    });
  }

  let chimeUrl = null;
  let urgentUrl = null;
  if (arrivalOn) renderSound(4.3, scheduleChime).then((url) => { chimeUrl = url; });
  if (chatOn) renderSound(3.2, scheduleUrgent).then((url) => { urgentUrl = url; });

  // ---- One sound per PC: the tabs agree which one plays ----
  // Each tab that sees the alert writes its own mark, waits a moment, then reads it back.
  // Only the tab whose mark is still there plays. If storage is blocked, every tab plays.
  function playOnce(kind, url, withinMs) {
    const key = SHARED + 'played:' + kind;
    try {
      const prev = String(localStorage.getItem(key) || '').split('|');
      if (Date.now() - (parseInt(prev[0], 10) || 0) < withinMs) return;
      localStorage.setItem(key, Date.now() + '|' + TAB);
      setTimeout(() => {
        if (String(localStorage.getItem(key) || '').split('|')[1] === TAB) playClip(url);
      }, 80 + Math.random() * 40);
    } catch (e) {
      playClip(url);
    }
  }

  // ---- Arrivals ----
  // Arrival toasts have a map marker icon and a heading like "Jane Smith has arrived".
  // Chat toasts use a bubble icon and the sender's name, so they're ignored.
  function isArrivalToast(node) {
    if (node.nodeType !== 1 || !node.matches('div.toast')) return false;
    const markerIcon = node.querySelector('.header-icon.icon-map-marker-solid');
    const heading = node.querySelector('.toast-header h3');
    return !!markerIcon || !!(heading && heading.textContent.toLowerCase().includes('has arrived'));
  }

  if (arrivalOn) {
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (isArrivalToast(node)) {
            playOnce('arrival', chimeUrl, 3000);
            return;
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  // ---- Chat: alarm, repeating until someone responds or the limit is reached ----
  if (chatOn) {
    let repeatTimer = null;
    let repeats = 0;
    const stopNagging = () => { clearInterval(repeatTimer); repeatTimer = null; };
    const startNagging = () => {
      stopNagging();
      repeats = 0;
      if (MAX_REPEATS === 0) return;
      repeatTimer = setInterval(() => {
        if (++repeats > MAX_REPEATS) return stopNagging();
        playOnce('chat-repeat', urgentUrl, REPEAT_EVERY_SECONDS * 1000 - 500);
      }, REPEAT_EVERY_SECONDS * 1000);
    };

    // Any click or keypress on a Halaxy page means someone is at the computer: stop every tab.
    const acknowledge = () => {
      if (!repeatTimer) return;
      stopNagging();
      try { localStorage.setItem(SHARED + 'ack', Date.now() + '|' + TAB); } catch (e) { /* ignore */ }
    };
    document.addEventListener('click', acknowledge);
    document.addEventListener('keydown', acknowledge);
    window.addEventListener('storage', (e) => { if (e.key === SHARED + 'ack') stopNagging(); });

    const readCount = () => {
      const el = document.getElementById(CHAT_BADGE_ID);
      if (!el) return null;
      return parseInt(el.getAttribute('data-count'), 10) || 0;
    };

    let lastCount = readCount();
    new MutationObserver(() => {
      const count = readCount();
      if (count === null) return;
      if (lastCount !== null && count > lastCount) {
        playOnce('chat', urgentUrl, 4000);
        startNagging();
      }
      if (lastCount !== null && count < lastCount) stopNagging(); // message read
      lastCount = count;
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-count'] });
  }

  window.hxAlerts = { version: VERSION };
})();
