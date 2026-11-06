// ==UserScript==
// @name         Halaxy notification chime (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      1.2
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/arrival-chime.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/arrival-chime.user.js
// @description  Plays a loud chime when a Halaxy patient arrival toast appears
// @match        https://*.halaxy.com/*
// @grant        none
// ==/UserScript==
(function () {
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

  // ---- The chime: rising C, E, G, played three times ----
  function scheduleChime(ctx) {
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -20;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;
    limiter.connect(ctx.destination);

    const notes = [1046.5, 1318.5, 1568.0];
    [0, 1.3, 2.6].forEach(offset => {
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

  let chimeUrl = null;
  renderSound(4.3, scheduleChime).then(url => { chimeUrl = url; });

  // ---- Detect arrival toasts ----
  // Arrival toasts have a map marker icon and a heading like "Jane Smith has arrived".
  // Chat toasts use a bubble icon and the sender's name, so they're ignored.
  function isArrivalToast(node) {
    if (node.nodeType !== 1 || !node.matches('div.toast')) return false;
    const markerIcon = node.querySelector('.header-icon.icon-map-marker-solid');
    const heading = node.querySelector('.toast-header h3');
    return !!markerIcon || (heading && heading.textContent.toLowerCase().includes('has arrived'));
  }

  new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (isArrivalToast(node)) {
          playClip(chimeUrl);
          return;
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
})();
