// ==UserScript==
// @name         Halaxy unread count chime
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      1.4
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/stable/chat-alert.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/stable/chat-alert.user.js
// @description  Urgent repeating alert when the Halaxy chat unread count goes up
// @match        https://*.halaxy.com/*
// @grant        none
// ==/UserScript==
(function () {
  const BADGE_ID = 'btn-chat-popover-open';
  const REPEAT_EVERY_SECONDS = 15;   // how often to repeat if nobody responds
  const MAX_REPEATS = 10;            // set to 0 to sound once only

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

  // ---- The urgent alert: three bursts of alternating high beeps ----
  function scheduleUrgent(ctx) {
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -20;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;
    limiter.connect(ctx.destination);

    const tones = [1760.0, 2349.3]; // alternating A and D, a fourth apart
    [0, 1.1, 2.2].forEach(burstStart => {
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

  let urgentUrl = null;
  renderSound(3.2, scheduleUrgent).then(url => { urgentUrl = url; });
  const urgentAlert = () => playClip(urgentUrl);

  // ---- Repeat until someone responds or the limit is reached ----
  let repeatTimer = null;
  let repeats = 0;
  function stopNagging() {
    clearInterval(repeatTimer);
    repeatTimer = null;
  }
  function startNagging() {
    stopNagging();
    repeats = 0;
    if (MAX_REPEATS === 0) return;
    repeatTimer = setInterval(() => {
      if (++repeats > MAX_REPEATS) return stopNagging();
      urgentAlert();
    }, REPEAT_EVERY_SECONDS * 1000);
  }
  // Any click or keypress on the Halaxy page means someone is at the computer
  document.addEventListener('click', stopNagging);
  document.addEventListener('keydown', stopNagging);

  // ---- Watch the chat unread count ----
  function readCount() {
    const el = document.getElementById(BADGE_ID);
    if (!el) return null;
    return parseInt(el.getAttribute('data-count'), 10) || 0;
  }

  let lastCount = readCount();
  let lastAlert = 0;

  new MutationObserver(() => {
    const count = readCount();
    if (count === null) return;
    if (lastCount !== null && count > lastCount && Date.now() - lastAlert > 4000) {
      urgentAlert();
      lastAlert = Date.now();
      startNagging();
    }
    if (lastCount !== null && count < lastCount) stopNagging(); // message read
    lastCount = count;
  }).observe(document.body, {
    subtree: true, childList: true,
    attributes: true, attributeFilter: ['data-count']
  });
})();
