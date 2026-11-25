// ==UserScript==
// @name         UPC Patients: Appointment recorder (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.2.1
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/appointment-recorder.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/appointment-recorder.user.js
// @description  Start Appointment on a clinical note: records the session in a small window, saved on this PC every few seconds, with a sound level and a microphone choice. A copy goes to Halaxy for 2 days; Patients > Recordings lists this PC's recordings.
// @match        https://*.halaxy.com/a/pr/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * Appointment recorder (CH, 25 Nov 2026; plan and Heidi facts in the project doc heidi-recorder.md). Stage 1: recording
 * and keeping it safe. Stage 2 (later): the recording goes to Heidi by itself and Heidi's note comes back into the note.
 *
 *  - The note page (/patient/:id/clinical/category/note/id/:noteId) gets a strip above the editor: a microphone list and
 *    Start Appointment. Recording, it shows the time, the microphone, a sound level and Finish Appointment.
 *  - The recording runs in a small window of its own, so moving around Halaxy doesn't stop it. The window is a blank page
 *    the note page writes (same site, so it shares this PC's storage), not a Halaxy page: Halaxy's own code (its
 *    inactivity log-out, pop-ups, autosave) never runs there. The note page and the window talk over a BroadcastChannel.
 *  - Audio: Opus in Ogg (Heidi refuses webm: recon 25 Nov 2026), mono, 16 kbit/s (about 7 MB an hour). Saved to
 *    IndexedDB every 5 seconds, so a crash or a closed window loses seconds, not the session. Patient audio on the PC is
 *    agreed by CH (25 Nov 2026): kept 14 days, then deleted. One file per session (CH, 25 Nov 2026: Heidi takes one
 *    file per session): a change of microphone carries on in the same file (the microphone feeds the recorder through
 *    the AudioContext). A recording only comes in parts when its window was closed and Continue Recording pressed (or the
 *    AudioContext wasn't running); Download then joins the parts into one file. A warning after 75 minutes, finished
 *    by itself after two hours (about 14 MB; Halaxy is known to take 15.7 MB and to refuse 31.5 MB).
 *  - Finished parts are attached to the "UPC scripts (recordings)" organisation (ORG) by whichever Halaxy tab is open
 *    (one at a time across tabs), titled "Recording 25-Nov-2026 10:00, <patient>, <practitioner>, note <id>" (", part n"
 *    after the first; CH, 25 Nov 2026). Copies there are deleted after 2 days (CH agreed, 25 Nov 2026): only files with
 *    that title and the "Appointment recorder" comment, so nothing else on the profile is touched. Downloads, which go
 *    to Heidi, are named by date and time only.
 *  - Patients > Recordings lists this PC's recordings with the note's patient, practitioner and date: Download, Delete. One
 *    recording at a time per PC.
 *  - The bars: each is a band of pitch, low to high, as tall as that band is loud, drawn up and down from a centre line
 *    (like Heidi's; CH, 25 Nov 2026). "No sound" (amber) when the level has been near zero for 30 seconds.
 */
(() => {
  'use strict';
  if (window.__hxAppointmentRecorder) return;
  window.__hxAppointmentRecorder = true;

  const VERSION = '0.2.1';
  const ORG = '78972';                          // "UPC scripts (recordings)" (CH, 25 Nov 2026)
  const KEEP_LOCAL_MS = 14 * 86400e3;           // on this PC (CH, 25 Nov 2026)
  const KEEP_HALAXY_MS = 2 * 86400e3;           // the copy in Halaxy (CH, 25 Nov 2026)
  const CONTINUE_MS = 12 * 3600e3;              // Start on the same note within this time carries on the same recording
  const STALE_MS = 60e3;                        // a recording with no sign of its window for this long has stopped
  const CHANNEL = 'upc-recorder';
  const WIN = 'upc-recorder';
  const RELOADED = 'upc-recorder-reloaded';
  const ROUTE = 'upc-recordings';
  const MENU_CLS = 'upc-rec-menu';
  const KEY = 'upc-rec:';
  const BARS = 7;
  const COMMENT = 'Appointment recorder';
  // "Recording 25-Nov-2026 10:00, <patient>, <practitioner>, note <id>" (0.2.0); "Recording 2026-11-25 10:00 CH" (0.1.0).
  const TITLE_RX = /\bRecording (?:(\d{4})-(\d{2})-(\d{2})|(\d{2})-([A-Z][a-z]{2})-(\d{4})) (\d{2}):(\d{2})\b/;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const ENCODER_URL = 'https://cdn.jsdelivr.net/npm/opus-recorder@8.0.5/dist/encoderWorker.min.js';   // MIT; Ogg Opus encoder (WebAssembly inside)
  const JOIN_MAX_MS = 150 * 60e3;   // joining decodes the whole recording into memory
  const REC = {   // passed to the recorder window
    channel: CHANNEL, bars: BARS, chunkMs: 5000, bitrate: 16000, warnMs: 75 * 60e3, maxMs: 2 * 3600e3,
    lowHz: 110, highHz: 4200, quietRms: 0.004, quietMs: 30e3, version: VERSION,
  };

  const U = () => window.UPC;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = { get: (k, d) => U().storage(KEY).get(k, d), set: (k, v) => U().storage(KEY).set(k, v), del: (k) => U().storage(KEY).del(k) };
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const hm = (ms) => { const d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600); return (h ? h + ':' + pad(Math.floor(s / 60) % 60) : pad(Math.floor(s / 60))) + ':' + pad(s % 60); };
  const day = (ms) => (U() ? U().dayLabel(ms) : ymd(ms));
  const TAB = Math.random().toString(36).slice(2, 8);

  // ------------------------------------------------------------------ storage on this PC (shared with the window)

  // IndexedDB "upc-recorder": recs (one per recording, no audio) and chunks (the audio, 5 seconds each, in order).
  // Written as one function so the recorder window gets the same code (makeDb.toString()).
  function makeDb(idb) {
    let opening = null;
    const open = () => opening || (opening = new Promise((ok, no) => {
      const q = idb.open('upc-recorder', 1);
      q.onupgradeneeded = () => {
        const d = q.result;
        if (!d.objectStoreNames.contains('recs')) d.createObjectStore('recs', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('chunks')) d.createObjectStore('chunks', { keyPath: 'k' });
      };
      q.onsuccess = () => ok(q.result);
      q.onerror = () => { opening = null; no(q.error); };
    }));
    const req = (r) => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
    const tx = async (stores, mode, fn) => {
      const d = await open();
      return new Promise((ok, no) => {
        const t = d.transaction(stores, mode);
        let out;
        Promise.resolve(fn(t)).then((v) => { out = v; });
        t.oncomplete = () => ok(out);
        t.onerror = () => no(t.error);
        t.onabort = () => no(t.error || new Error('Storage on this PC refused the change.'));
      });
    };
    const key = (id, part, seq) => id + '|' + String(part).padStart(3, '0') + '|' + String(seq).padStart(6, '0');
    const range = (id, part) => (part === undefined ? IDBKeyRange.bound(id + '|', id + '|￿') : IDBKeyRange.bound(key(id, part, 0), key(id, part, 999999)));
    return {
      recs: () => tx(['recs'], 'readonly', (t) => req(t.objectStore('recs').getAll())),
      rec: (id) => tx(['recs'], 'readonly', (t) => req(t.objectStore('recs').get(id))),
      putRec: (r) => tx(['recs'], 'readwrite', (t) => { t.objectStore('recs').put(JSON.parse(JSON.stringify(r))); }),
      addChunk: (id, part, seq, blob) => tx(['chunks'], 'readwrite', (t) => { t.objectStore('chunks').put({ k: key(id, part, seq), blob }); }),
      async partBlob(id, part, mime) {
        const rows = await tx(['chunks'], 'readonly', (t) => req(t.objectStore('chunks').getAll(range(id, part))));
        return new Blob(rows.map((r) => r.blob), { type: mime || 'audio/ogg' });
      },
      delRec: (id) => tx(['recs', 'chunks'], 'readwrite', (t) => { t.objectStore('recs').delete(id); t.objectStore('chunks').delete(range(id)); }),
    };
  }

  // ------------------------------------------------------------------ the recorder window

  // Runs inside the recorder window (written into it as text: nothing from outside this function is used, apart from
  // cfg and makeDb). It records, saves every chunk to IndexedDB, draws the level, and reports to Halaxy's tabs.
  function RECORDER(cfg, makeDb) {
    'use strict';
    const db = makeDb(window.indexedDB);
    const bc = new BroadcastChannel(cfg.channel);
    const root = document.getElementById('upc-rec-root');
    const now = () => Date.now();
    const pad = (n) => String(n).padStart(2, '0');
    const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600); return (h ? h + ':' + pad(Math.floor(s / 60) % 60) : pad(Math.floor(s / 60))) + ':' + pad(s % 60); };
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    let rec = null, part = null, mr = null, stream = null, ctx = null, meter = null, chain = Promise.resolve();
    let seq = 0, quietSince = now(), quiet = false, levelsOk = false, state = 'starting', error = '', devices = [], long = false;
    const levels = new Array(cfg.bars).fill(0);
    window.__upcRecorder = { id: cfg.id, noteId: cfg.noteId };

    const MIME = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus'];
    const pickMime = () => MIME.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';

    function snapshot() {
      return { t: 'st', id: rec ? rec.id : cfg.id, noteId: cfg.noteId, patientId: cfg.patientId, startedAt: rec ? rec.startedAt : now(),
        status: state, mic: part ? part.mic : '', micId: part ? part.micId : '', devices, quiet: quiet && levelsOk, ok: levelsOk, error, part: part ? part.n : 0, long };
    }
    const tell = () => { try { bc.postMessage(snapshot()); } catch (e) { /* channel closed */ } };

    // ---- drawing (Halaxy's own classes: the opener's styles are copied into this window)
    function draw() {
      const recording = state === 'recording';
      let h = '<div class="upc-page-bar"><h1>Appointment Recording</h1><div class="upc-page-actions">' +
        (state === 'finished' ? '' : '<button type="button" class="btn btn-primary" data-a="finish"' + (recording ? '' : ' disabled') + '><i class="icon icon-stop-circle"></i> ' + (state === 'finishing' ? 'Finishing...' : 'Finish Appointment') + '</button>') +
        '</div></div><div class="upc-page-sub"><span class="text-muted">' + esc([cfg.patient, cfg.practitioner].filter(Boolean).join(', ')) + (cfg.patient || cfg.practitioner ? ', started ' : 'Started ') + esc(new Date(rec ? rec.startedAt : now()).toTimeString().slice(0, 5)) + '</span></div>';
      if (error) h += '<div class="alert alert-danger upc-err">' + esc(error) + '</div>';
      if (state === 'finished') h += '<div class="alert alert-success upc-ok">' + esc(rec && rec.stopped ? rec.stopped + ' ' : '') + 'Recording saved on this PC.</div>';
      if (long && state === 'recording') h += '<div class="alert alert-warning upc-warn">Still recording after ' + Math.round(cfg.warnMs / 60e3) + ' minutes. Finish Appointment when the session is over.</div>';
      h += '<div class="upc-rec-big"><div class="upc-rec-bars" aria-hidden="true">' + '<span></span>'.repeat(cfg.bars) + '</div>' +
        '<div class="upc-rec-time"></div></div>';
      if (state !== 'finished') {
        h += '<div class="form-group"><select class="form-control upc-rec-mic" aria-label="Microphone">' +
          (devices.length ? devices : [{ id: part ? part.micId : '', label: part ? part.mic : 'Default microphone' }]).map((d) => '<option value="' + esc(d.id) + '"' + (part && d.id === part.micId ? ' selected' : '') + '>' + esc(d.label) + '</option>').join('') + '</select></div>';
        h += '<div class="upc-rec-quiet">' + (quiet && levelsOk ? '<div class="alert alert-warning upc-warn">No sound</div>' : '') + '</div>';
        if (recording && !levelsOk) h += '<button type="button" class="btn btn-outline-primary-light" data-a="level">Show Sound Level</button>';
      }
      root.innerHTML = h;
      bars();
      tick();
    }
    function bars() {
      const el = root.querySelector('.upc-rec-bars');
      if (!el) return;
      const kind = !levelsOk ? 'bg-secondary' : quiet ? 'bg-warning' : 'bg-success';
      [...el.children].forEach((s, i) => { s.className = kind; s.style.height = Math.round(6 + levels[i] * 66) + 'px'; });
      const q = root.querySelector('.upc-rec-quiet');
      if (q && (!!q.firstChild) !== (quiet && levelsOk)) q.innerHTML = quiet && levelsOk ? '<div class="alert alert-warning upc-warn">No sound</div>' : '';
    }
    function tick() {
      const t = root.querySelector('.upc-rec-time');
      const ms = rec ? (rec.parts || []).reduce((a, p) => a + ((p.endedAt || now()) - p.startedAt), 0) : 0;
      if (t) t.textContent = clock(ms);
      document.title = (state === 'finished' ? 'Recording saved' : 'Recording ' + clock(ms)) + ' | Halaxy';
    }

    // ---- the sound graph: each microphone feeds the level meter and, when the AudioContext runs, the recorder too, so
    // a change of microphone carries on in the same file (CH, 25 Nov 2026: Heidi takes one file per session). If the
    // AudioContext isn't running, the recorder takes the microphone directly and a change of microphone starts a new part.
    let an = null, dest = null, src = null, mode = 'direct';
    async function ensureCtx() {
      try {
        if (!ctx) {
          ctx = new (window.AudioContext || window.webkitAudioContext)();
          an = ctx.createAnalyser();
          an.fftSize = 1024;
          an.smoothingTimeConstant = 0.5;
        }
        if (ctx.state === 'suspended') await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 1000))]);
      } catch (e) { ctx = null; an = null; }
      return !!ctx && ctx.state === 'running';
    }
    function plug(s) {
      if (!ctx) return;
      try {
        const n = ctx.createMediaStreamSource(s);
        if (an) n.connect(an);
        if (mode === 'mixed' && dest) n.connect(dest);
        if (src) try { src.disconnect(); } catch (e) { /* gone */ }
        src = n;
      } catch (e) { /* no level */ }
    }
    function startMeter() {
      if (meter || !ctx || !an) return;
      const freq = new Float32Array(an.frequencyBinCount), wave = new Float32Array(an.fftSize);
      const edges = [];
      for (let i = 0; i <= cfg.bars; i++) edges.push(cfg.lowHz * Math.pow(cfg.highHz / cfg.lowHz, i / cfg.bars));
      const hz = (ctx.sampleRate || 48000) / an.fftSize;
      meter = setInterval(() => {
        const ok = ctx.state === 'running';
        if (ok !== levelsOk) { levelsOk = ok; quietSince = now(); draw(); }
        // The recorder hears the microphone through the AudioContext: if that stops, carry on directly in a new part.
        if (!ok && mode === 'mixed' && state === 'recording') { state = 'switching'; roll().catch(fail); }
        if (ok) {
          an.getFloatFrequencyData(freq);
          an.getFloatTimeDomainData(wave);
          let ss = 0;
          for (let i = 0; i < wave.length; i++) ss += wave[i] * wave[i];
          if (Math.sqrt(ss / wave.length) > cfg.quietRms) quietSince = now();
          for (let b = 0; b < cfg.bars; b++) {
            const lo = Math.max(1, Math.floor(edges[b] / hz)), hi = Math.max(lo + 1, Math.ceil(edges[b + 1] / hz));
            let sum = 0, n = 0;
            for (let k = lo; k < hi && k < freq.length; k++) if (isFinite(freq[k])) { sum += freq[k]; n++; }
            const v = Math.min(1, Math.max(0, ((n ? sum / n : -120) + 90) / 55));
            levels[b] += (v - levels[b]) * (v > levels[b] ? 0.6 : 0.25);
          }
        } else levels.fill(0);
        const q = state === 'recording' && now() - quietSince > cfg.quietMs;
        if (q !== quiet) { quiet = q; tell(); }
        bars();
        try { bc.postMessage({ t: 'lv', id: rec ? rec.id : cfg.id, lv: levels.map((x) => Math.round(x * 100) / 100), quiet: quiet && levelsOk, ok: levelsOk }); } catch (e) { /* closed */ }
      }, 80);
    }

    // ---- recording
    async function listDevices() {
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        const seen = new Set();
        devices = all.filter((d) => d.kind === 'audioinput' && !/^monitor of /i.test(d.label || ''))
          .filter((d) => { const k = d.groupId + '|' + d.label; if (d.deviceId !== 'default' && seen.has(k)) return false; seen.add(k); return true; })
          .map((d) => ({ id: d.deviceId, label: d.label || 'Microphone' }));
      } catch (e) { devices = []; }
      try { localStorage.setItem('upc-rec:devices', JSON.stringify(devices)); } catch (e) { /* fine */ }
    }
    function remember() {
      if (part && part.micId) try { localStorage.setItem('upc-rec:mic', JSON.stringify({ id: part.micId, label: part.mic })); } catch (e) { /* fine */ }
    }
    function save(p, blob) {
      const s = seq++;
      chain = chain.then(() => db.addChunk(rec.id, p.n, s, blob)).then(() => {
        p.bytes += blob.size;
        p.chunks += 1;
        rec.beat = now();
        return db.putRec(rec);
      }).catch((e) => { error = 'Not saved on this PC: ' + ((e && e.message) || e) + '. Download it from Patients > Recordings before closing this window.'; draw(); tell(); });
    }
    async function openMic(device) {
      const base = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
      if (device && device.id) {
        try { return await navigator.mediaDevices.getUserMedia({ audio: Object.assign({ deviceId: { exact: device.id } }, base) }); } catch (e) { /* the default instead */ }
      }
      return navigator.mediaDevices.getUserMedia({ audio: base });
    }
    const micOf = (s, device) => {
      const track = s.getAudioTracks()[0];
      const settings = track && track.getSettings ? track.getSettings() : {};
      return { mic: (track && track.label) || 'Microphone', micId: settings.deviceId || (device && device.id) || '' };
    };
    async function startPart(device) {
      const s = await openMic(device);
      stream = s;
      const running = await ensureCtx();
      mode = running ? 'mixed' : 'direct';
      dest = null;
      if (running) { try { dest = ctx.createMediaStreamDestination(); } catch (e) { mode = 'direct'; } }
      plug(s);
      startMeter();
      const mime = pickMime();
      const input = mode === 'mixed' ? dest.stream : s;
      mr = new MediaRecorder(input, mime ? { mimeType: mime, audioBitsPerSecond: cfg.bitrate } : { audioBitsPerSecond: cfg.bitrate });
      const type = String(mr.mimeType || mime || 'audio/ogg').split(';')[0];
      const n = (rec.parts.length ? rec.parts[rec.parts.length - 1].n : 0) + 1;
      const m = micOf(s, device);
      part = { n, mime: type, ext: /webm/.test(type) ? 'webm' : 'ogg', mic: m.mic, micId: m.micId, mics: [m.mic], startedAt: now(), endedAt: null, bytes: 0, chunks: 0 };
      rec.parts.push(part);
      seq = 0;
      rec.beat = now();
      await db.putRec(rec);
      const p = part;
      mr.ondataavailable = (e) => { if (e.data && e.data.size) save(p, e.data); };
      mr.start(cfg.chunkMs);
      await listDevices();
      remember();
    }
    async function endPart() {
      const r = mr, p = part;
      if (r && r.state !== 'inactive') await new Promise((ok) => { r.addEventListener('stop', ok, { once: true }); try { r.stop(); } catch (e) { ok(); } });
      await chain;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (src) { try { src.disconnect(); } catch (e) { /* gone */ } src = null; }
      if (p && !p.endedAt) {
        p.endedAt = now();
        await db.putRec(rec);
        try { bc.postMessage({ t: 'part', id: rec.id, n: p.n }); } catch (e) { /* closed */ }
      }
      mr = null;
      stream = null;
    }
    async function roll() { const d = part ? { id: part.micId, label: part.mic } : null; await endPart(); await startPart(d); state = 'recording'; draw(); tell(); }
    async function switchMic(device) {
      if (state !== 'recording' || !device || (part && device.id === part.micId)) return;
      if (mode === 'mixed' && ctx && ctx.state === 'running') {
        let s = null;
        try { s = await openMic(device); } catch (e) { error = 'That microphone is not available: ' + ((e && (e.message || e.name)) || e) + '.'; draw(); tell(); return; }
        const old = stream;
        stream = s;
        plug(s);
        if (old) old.getTracks().forEach((t) => t.stop());
        const m = micOf(s, device);
        part.mic = m.mic;
        part.micId = m.micId;
        part.mics.push(m.mic);
        error = '';
        await db.putRec(rec);
        await listDevices();
        remember();
        draw();
        tell();
        return;
      }
      state = 'switching';
      draw();
      await endPart();
      try { await startPart(device); } catch (e) { await startPart(null); }
      state = 'recording';
      draw();
      tell();
    }
    const total = () => (rec ? (rec.parts || []).reduce((a, p) => a + ((p.endedAt || now()) - p.startedAt), 0) : 0);
    async function finish(why) {
      if (state !== 'recording') return;
      state = 'finishing';
      draw();
      tell();
      await endPart();
      rec.status = 'finished';
      rec.endedAt = now();
      rec.beat = now();
      if (why) rec.stopped = why;
      await db.putRec(rec);
      state = 'finished';
      levels.fill(0);
      clearInterval(meter);
      draw();
      tell();
      try { bc.postMessage({ t: 'finished', id: rec.id }); } catch (e) { /* closed */ }
      try { if (ctx) ctx.close(); } catch (e) { /* fine */ }
      setTimeout(() => window.close(), 1500);
    }
    // A session left running (CH, 25 Nov 2026: a practitioner may forget to finish): a warning after 75 minutes (some
    // appointments are an hour), finished after two hours (about 14 MB at 16 kbit/s, under the 15.7 MB Halaxy is known to take).
    function guard() {
      if (state !== 'recording') return;
      const t = total();
      const l = t >= cfg.warnMs;
      if (l !== long) { long = l; draw(); tell(); }
      if (t >= cfg.maxMs) finish('Stopped after ' + Math.round(cfg.maxMs / 3600e3) + ' hours.').catch(fail);
    }
    function fail(e) {
      error = 'Microphone not available: ' + ((e && (e.message || e.name)) || e) + '. Close this window and try again.';
      state = 'failed';
      draw();
      tell();
    }

    root.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]');
      if (!a) return;
      if (a.dataset.a === 'finish') finish().catch(fail);
      if (a.dataset.a === 'level' && ctx) ctx.resume().then(() => draw()).catch(() => {});
    });
    root.addEventListener('change', (e) => {
      const sel = e.target.closest('select.upc-rec-mic');
      if (sel) switchMic({ id: sel.value, label: sel.options[sel.selectedIndex].text }).catch(fail);
    });
    bc.onmessage = (e) => {
      const m = e.data || {};
      if (m.t === 'ping') tell();
      if (m.t === 'cmd' && rec && m.id === rec.id) {
        if (m.do === 'finish') finish().catch(fail);
        if (m.do === 'mic') switchMic(m.device).catch(fail);
      }
    };
    window.addEventListener('beforeunload', (e) => { if (state === 'recording' || state === 'finishing') { e.preventDefault(); e.returnValue = ''; } });
    window.addEventListener('pagehide', () => {
      try { if (mr && mr.state === 'recording') mr.requestData(); } catch (e) { /* closing */ }
      try { bc.postMessage({ t: 'gone', id: rec ? rec.id : cfg.id }); } catch (e) { /* closing */ }
    });
    setInterval(() => { tick(); guard(); tell(); }, 1000);

    (async () => {
      draw();
      rec = await db.rec(cfg.id);
      if (!rec) rec = { id: cfg.id, noteId: cfg.noteId, patientId: cfg.patientId, patient: cfg.patient, practitioner: cfg.practitioner, noteDate: cfg.noteDate, by: cfg.by, startedAt: now(), parts: [], v: cfg.version };
      else ['patient', 'practitioner', 'noteDate'].forEach((k) => { if (!rec[k] && cfg[k]) rec[k] = cfg[k]; });
      rec.status = 'recording';
      rec.endedAt = null;
      rec.beat = now();
      await db.putRec(rec);
      await startPart(cfg.device);
      state = 'recording';
      quietSince = now();
      draw();
      tell();
    })().catch(async (e) => {
      fail(e);
      if (rec && !rec.parts.length) { try { await db.delRec(rec.id); } catch (x) { /* nothing saved */ } }
      else if (rec) { rec.status = 'stopped'; rec.endedAt = rec.beat; try { await db.putRec(rec); } catch (x) { /* fine */ } }
      try { bc.postMessage({ t: 'gone', id: cfg.id }); } catch (x) { /* closed */ }
    });
  }

  // ------------------------------------------------------------------ this PC's recordings, seen from Halaxy

  const db = makeDb(window.indexedDB);
  const bc = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;
  const live = new Map();     // recording id -> its window's last report { ..., at }
  let recs = [];              // from IndexedDB
  const fresh = (s) => !!s && Date.now() - s.at < 4000 && !/^(finished|failed)$/.test(s.status);
  const liveFor = (noteId) => [...live.values()].find((s) => fresh(s) && (!noteId || s.noteId === noteId)) || null;
  const anyLive = () => [...live.values()].find(fresh) || null;
  const upKey = (r, p) => 'up:' + r.id + '|' + p.n;   // the Halaxy copy of each part, per PC (localStorage, not IndexedDB:
  const upOf = (r, p) => store.get(upKey(r, p), { state: 'waiting', tries: 0 });   // the recorder window writes recs)
  const lengthOf = (r) => (r.parts || []).reduce((a, p) => a + ((p.endedAt || r.beat || Date.now()) - p.startedAt), 0);

  let recsSig = '';
  async function loadRecs() {
    try { recs = (await db.recs()).sort((a, b) => b.startedAt - a.startedAt); } catch (e) { recs = []; }
    const sig = JSON.stringify(recs);
    if (sig !== recsSig) { recsSig = sig; paint(); }
    return recs;
  }

  // Locks between this PC's Halaxy tabs (localStorage), so one tab uploads or cleans up at a time.
  function lockTake(name, ms) {
    const k = 'lock:' + name, l = store.get(k, null);
    if (l && l.by !== TAB && l.until > Date.now()) return false;
    store.set(k, { by: TAB, until: Date.now() + ms });
    return store.get(k, null).by === TAB;
  }
  const lockFree = (name) => { const l = store.get('lock:' + name, null); if (l && l.by === TAB) store.del('lock:' + name); };

  function tellHealthCheck(e) {
    const message = (e && e.message) || String(e);
    if (!/has changed/.test(message)) return;
    document.dispatchEvent(new CustomEvent('upc-loader-error', { detail: JSON.stringify({ file: 'appointment-recorder.user.js', message }) }));
  }

  // A recording whose window has gone quiet (closed, reloaded, crashed): marked stopped where its last chunk was saved.
  async function markStopped() {
    for (const r of recs) {
      if (r.status !== 'recording' || live.has(r.id) && fresh(live.get(r.id))) continue;
      if (Date.now() - (r.beat || r.startedAt) < STALE_MS) continue;
      const cur = await db.rec(r.id);
      if (!cur || cur.status !== 'recording' || Date.now() - (cur.beat || cur.startedAt) < STALE_MS) continue;
      cur.status = 'stopped';
      cur.endedAt = cur.beat || cur.startedAt;
      (cur.parts || []).forEach((p) => { if (!p.endedAt) p.endedAt = cur.endedAt; });
      await db.putRec(cur);
    }
  }

  // ------------------------------------------------------------------ copies in Halaxy

  // In Halaxy: who and which note, so a lost session is easy to find (CH, 25 Nov 2026). Downloads (what Heidi sees)
  // carry no names.
  const fileTitle = (r, p) => ['Recording ' + day(r.startedAt) + ' ' + hm(r.startedAt), r.patient, r.practitioner || r.who, 'note ' + r.noteId].filter(Boolean).join(', ') + (p.n > 1 ? ', part ' + p.n : '');
  const fileName = (r, p) => 'recording-' + day(r.startedAt) + '-' + hm(r.startedAt).replace(':', '') + (p && p.n > 1 ? '-part' + p.n : '') + '.' + ((p && p.ext) || 'ogg');
  const fileComments = (r, p) => COMMENT + '; note ' + r.noteId + '; patient ' + r.patientId + '; ' + clock(p.endedAt - p.startedAt) + ', ' + hm(p.startedAt) + ' to ' + hm(p.endedAt);

  let uploading = false;
  async function uploads() {
    if (uploading || !U() || U().http.pausedFor() > 0) return;
    const todo = [];
    recs.forEach((r) => (r.parts || []).forEach((p) => {
      if (!p.endedAt || !p.chunks) return;
      const u = upOf(r, p);
      if (u.state === 'saved') return;
      if (u.state === 'failed' && Date.now() - (u.at || 0) < Math.min(6, u.tries || 1) * 10 * 60e3) return;   // 10, 20 ... 60 minutes apart
      todo.push([r, p]);
    }));
    if (!todo.length || !lockTake('upload', 3 * 60e3)) return;
    uploading = true;
    try {
      for (const [r, p] of todo) {
        lockTake('upload', 3 * 60e3);
        const was = upOf(r, p);
        store.set(upKey(r, p), Object.assign({}, was, { state: 'saving' }));
        paint();
        try {
          const title = fileTitle(r, p);
          // Already there (a tab closed half way through last time): not attached twice.
          const have = (await U().orgFiles.list(ORG)).find((f) => new RegExp('\\b' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?!,? part)').test(U().clean(f.text)));
          let fileId = have ? have.id : null;
          if (!fileId) {
            const blob = await db.partBlob(r.id, p.n, p.mime);
            fileId = await U().orgFiles.attach(ORG, new File([blob], fileName(r, p), { type: p.mime || 'audio/ogg' }), { title, comments: fileComments(r, p) });
          }
          store.set(upKey(r, p), { state: 'saved', fileId: String(fileId), at: Date.now(), tries: (was.tries || 0) + 1 });
        } catch (e) {
          store.set(upKey(r, p), { state: 'failed', error: (e && e.message) || String(e), at: Date.now(), tries: (was.tries || 0) + 1 });
          tellHealthCheck(e);
        }
        paint();
      }
    } finally {
      uploading = false;
      lockFree('upload');
    }
  }

  // Copies in Halaxy older than 2 days, deleted (CH agreed, 25 Nov 2026): only the recorder's own files (title and comment).
  function oldTitle(text) {
    const m = TITLE_RX.exec(String(text || ''));
    if (!m) return false;
    const t = m[1] ? new Date(+m[1], +m[2] - 1, +m[3], +m[7], +m[8]) : new Date(+m[6], MONTHS.indexOf(m[5]), +m[4], +m[7], +m[8]);
    return !isNaN(t) && Date.now() - t.getTime() > KEEP_HALAXY_MS;
  }
  async function removeFile(id) {
    const path = '/file/delete/' + encodeURIComponent(id);
    const { doc } = await U().http.popup(path);
    const link = [...doc.querySelectorAll('a[href]')].find((a) => a.getAttribute('href').split('?')[0].replace(/^.*\/a\/pr\/\d+/, '').startsWith(path + '/'));
    if (!link) throw new (U().Error)('Halaxy\'s Delete file pop-up has changed, so old recordings were not deleted.');
    await U().http.json(link.getAttribute('href').replace(/^.*\/a\/pr\/\d+/, ''));
    if ((await U().orgFiles.list(ORG)).some((f) => f.id === String(id))) throw new (U().Error)('Halaxy still lists a recording after deleting it.');
  }
  async function cleanHalaxy() {
    if (!U() || !U().background.ok()) return;
    if (!U().background.due(store.get('cleanAt', 0), 6 * 3600e3) || !lockTake('clean', 10 * 60e3)) return;
    store.set('cleanAt', Date.now());
    try {
      const all = await U().orgFiles.list(ORG);
      // The card shows the title; if Halaxy stops showing it there, each file's details are read instead.
      const named = all.some((f) => /\bRecording\b/.test(f.text));
      const look = named ? all.filter((f) => oldTitle(f.text)) : all.slice(0, 60);
      let n = 0;
      for (const f of look) {
        if (n >= 20) break;
        const d = await U().orgFiles.details(f.id);
        if (!oldTitle(d.title) || !String(d.comments).startsWith(COMMENT)) continue;
        await removeFile(f.id);
        n++;
        await U().background.pause(3000, 6000);
      }
    } catch (e) {
      console.warn('[UPC appointment recorder] clean-up', e);
      tellHealthCheck(e);
    } finally { lockFree('clean'); }
  }

  // Recordings on this PC older than 14 days, deleted.
  async function cleanLocal() {
    if (!U().background.due(store.get('localCleanAt', 0), 3600e3)) return;
    store.set('localCleanAt', Date.now());
    for (const r of recs) {
      if (r.status === 'recording' || Date.now() - (r.endedAt || r.beat || r.startedAt) < KEEP_LOCAL_MS) continue;
      await db.delRec(r.id);
      (r.parts || []).forEach((p) => store.del(upKey(r, p)));
    }
    await loadRecs();
  }

  // ------------------------------------------------------------------ downloads

  // One file per recording (CH, 25 Nov 2026: Heidi takes one file per session). A recording in parts (its window was
  // closed and Continue Recording pressed) is joined: each part decoded, end to end, and encoded again as one Ogg Opus
  // file (16 kHz mono, 16 kbit/s) by opus-recorder's encoder, loaded from jsDelivr when first needed.
  let encoderUrl = null;
  async function encoder() {
    if (!encoderUrl) {
      const res = await fetch(ENCODER_URL, { credentials: 'omit' });
      if (!res.ok) throw new (U().Error)('The audio encoder could not be loaded (' + res.status + ').');
      encoderUrl = URL.createObjectURL(new Blob([await res.text()], { type: 'text/javascript' }));
    }
    return new Worker(encoderUrl);
  }
  async function joined(r) {
    const parts = (r.parts || []).filter((p) => p.chunks || p.bytes);
    if (!parts.length) throw new (U().Error)('Nothing was recorded.');
    if (parts.length === 1) return db.partBlob(r.id, parts[0].n, parts[0].mime);
    if (lengthOf(r) > JOIN_MAX_MS) throw new (U().Error)('This recording is too long to join here.');
    const RATE = 16000, SIZE = 4096;
    const w = await encoder();
    const pages = [];
    let ready, done, fail;
    const isReady = new Promise((ok) => { ready = ok; });
    const isDone = new Promise((ok, no) => { done = ok; fail = no; });
    w.onmessage = (e) => { const d = e.data || {}; if (d.message === 'ready') ready(); else if (d.message === 'page') pages.push(d.page); else if (d.message === 'done') done(); };
    w.onerror = (e) => { fail(new (U().Error)('The audio encoder stopped: ' + (e.message || 'unknown') + '.')); ready(); };
    try {
      w.postMessage({ command: 'init', encoderSampleRate: RATE, originalSampleRate: RATE, numberOfChannels: 1, encoderApplication: 2048, encoderBitRate: 16000, encoderComplexity: 5 });
      await isReady;
      w.postMessage({ command: 'getHeaderPages' });
      for (const p of parts) {
        const blob = await db.partBlob(r.id, p.n, p.mime);
        const audio = await new OfflineAudioContext(1, RATE, RATE).decodeAudioData(await blob.arrayBuffer());
        const ch = audio.getChannelData(0);
        for (let i = 0; i < ch.length; i += SIZE) {
          const c = new Float32Array(SIZE);
          c.set(ch.subarray(i, i + SIZE));
          w.postMessage({ command: 'encode', buffers: [c] }, [c.buffer]);
        }
      }
      w.postMessage({ command: 'done' });
      await isDone;
    } finally { w.terminate(); }
    return new Blob(pages, { type: 'audio/ogg' });
  }
  async function download(r) {
    const several = (r.parts || []).filter((p) => p.chunks || p.bytes).length > 1;
    const busy = several ? U().ui.toast('Joining the parts into one file...', { kind: 'info', ms: 0 }) : null;
    try {
      const blob = await joined(r);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fileName(r, null);
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    } finally { if (busy) busy.close(); }
  }

  // A recording's copy in Halaxy, as a pill.
  function copyPill(r) {
    const parts = (r.parts || []).filter((p) => p.chunks || p.bytes);
    if (!parts.length) return U().ui.page.pill('Nothing recorded', 'info');
    if (r.status === 'recording') return U().ui.page.pill('Recording', 'info');
    const ups = parts.map((p) => upOf(r, p));
    if (ups.every((u) => u.state === 'saved')) return Date.now() - r.startedAt > KEEP_HALAXY_MS ? U().ui.page.pill('Removed from Halaxy', 'info') : U().ui.page.pill('In Halaxy', 'ok');
    const bad = ups.find((u) => u.state === 'failed');
    if (bad) return '<span title="' + esc(bad.error || '') + '">' + U().ui.page.pill('Not in Halaxy', 'err') + '</span>';
    return U().ui.page.pill(ups.some((u) => u.state === 'saving') ? 'Saving to Halaxy' : 'Waiting', 'wait');
  }

  // ------------------------------------------------------------------ the note page

  const CSS = `
    .upc-rec-strip { margin: 0 0 8px; }
    .upc-rec-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; min-height: 38px; }
    .upc-rec .upc-rec-mic { display: inline-block; width: auto; max-width: 260px; }
    .upc-rec-time { display: inline-flex; align-items: center; gap: 4px; font-variant-numeric: tabular-nums; }
    .upc-rec-bars { display: inline-flex; align-items: center; gap: 3px; height: 24px; }
    .upc-rec-bars > span { display: block; width: 4px; height: 4px; border-radius: 2px; transition: height .1s linear; }
    .upc-rec-big { display: flex; flex-direction: column; align-items: center; gap: 8px; margin: 20px 0 16px; }
    .upc-rec-big .upc-rec-bars { height: 76px; gap: 6px; }
    .upc-rec-big .upc-rec-bars > span { width: 8px; border-radius: 4px; }
    .upc-rec-big .upc-rec-time { font-size: 28px; }
    .upc-rec-window { padding: 16px 20px; }
    .upc-rec-body { background: var(--vs-body-bg, #fff); }
  `;
  let strip = null, stripKey = '', stripTimer = null;

  function noteIds() {
    const m = location.pathname.match(/\/patient\/(\d+)\/clinical\/category\/note\/id\/(\d+)/) || location.pathname.match(/\/patient\/(\d+)\/clinical\/(\d+)\/?$/);
    return m ? { patientId: m[1], noteId: m[2] } : null;
  }
  function editorHost() {
    const ed = [...document.querySelectorAll('.ck-editor__editable')].find((el) => el.ckeditorInstance);
    return ed ? ed.closest('.ck-editor') : null;
  }
  const savedMic = () => { try { return JSON.parse(localStorage.getItem('upc-rec:mic') || 'null'); } catch (e) { return null; } };
  const savedDevices = () => { try { return JSON.parse(localStorage.getItem('upc-rec:devices') || '[]'); } catch (e) { return []; } };

  function micSelect(devices, selected) {
    const list = devices.length ? devices.slice() : [{ id: '', label: 'Default microphone' }];
    if (selected && selected.id && !list.some((d) => d.id === selected.id)) list.unshift(selected);
    return '<select class="form-control upc-rec-mic" aria-label="Microphone">' + list.map((d) =>
      '<option value="' + esc(d.id) + '"' + (selected && d.id === selected.id ? ' selected' : '') + '>' + esc(d.label) + '</option>').join('') + '</select>';
  }
  const barsHtml = () => '<span class="upc-rec-bars" aria-hidden="true">' + '<span class="bg-success"></span>'.repeat(BARS) + '</span>';

  function stripState() {
    const ids = noteIds();
    if (!ids) return null;
    const mine = liveFor(ids.noteId);
    const other = !mine && anyLive();
    const saved = recs.find((r) => r.noteId === ids.noteId) || null;
    return { ids, mine, other, saved };
  }
  function renderStrip(force) {
    if (!strip) return;
    const st = stripState();
    if (!st) return;
    const { mine, other, saved } = st;
    const key = JSON.stringify([mine ? [mine.id, mine.status, mine.micId, mine.devices, mine.quiet, mine.ok, mine.error, mine.long] : null, other ? other.id : null,
      saved ? [saved.id, saved.status, (saved.parts || []).length, copyPill(saved)] : null]);
    if (!force && key === stripKey) { timeNow(); return; }
    stripKey = key;
    let h = '<div class="upc-rec-row">';
    if (mine) {
      h += '<span class="upc-rec-time"><i class="icon icon-timer"></i> <span data-upc-rec-time></span></span>' +
        micSelect(mine.devices || savedDevices(), { id: mine.micId, label: mine.mic }) + barsHtml() +
        (mine.quiet ? U().ui.page.pill('No sound', 'warn') : '') + (mine.long ? U().ui.page.pill('Still recording after ' + Math.round(REC.warnMs / 60e3) + ' minutes', 'warn') : '') + (!mine.ok && mine.status === 'recording' ? U().ui.page.pill('Level in the recorder window', 'info') : '') +
        '<button type="button" class="btn btn-outline-primary" data-a="finish"' + (mine.status === 'recording' ? '' : ' disabled') + '><i class="icon icon-stop-circle"></i> ' +
        (mine.status === 'finishing' ? 'Finishing...' : 'Finish Appointment') + '</button>';
      if (mine.error) h += '</div><div class="alert alert-danger upc-err">' + esc(mine.error) + '</div><div>';
    } else if (other) {
      h += '<span class="text-muted">Another appointment is being recorded on this PC.</span><button type="button" class="btn btn-outline-primary" data-a="show">Show Recorder</button>';
    } else {
      h += micSelect(savedDevices(), savedMic()) +
        '<button type="button" class="btn btn-primary" data-a="start"><i class="icon icon-mic"></i> ' + (saved && Date.now() - saved.startedAt < CONTINUE_MS ? 'Continue Recording' : 'Start Appointment') + '</button>';
      if (saved) {
        h += '<span class="text-muted">Recorded ' + esc(clock(lengthOf(saved))) + (saved.status === 'stopped' ? ', stopped at ' + esc(hm(saved.endedAt)) : '') + '</span>' +
          (saved.status === 'stopped' ? U().ui.page.pill('Window closed', 'warn') : '') + copyPill(saved) +
          '<button type="button" class="btn btn-outline-primary-light" data-a="download">Download Recording</button>';
      }
    }
    strip.innerHTML = h + '</div>';
    timeNow();
    if (lastLv) drawBars(lastLv);
  }
  function timeNow() {
    const el = strip && strip.querySelector('[data-upc-rec-time]');
    const st = el && stripState();
    if (!el || !st || !st.mine) return;
    const r = recs.find((x) => x.id === st.mine.id);
    const done = r ? (r.parts || []).filter((p) => p.endedAt && p.n !== st.mine.part).reduce((a, p) => a + (p.endedAt - p.startedAt), 0) : 0;
    const cur = r && (r.parts || []).find((p) => p.n === st.mine.part);
    el.textContent = clock(done + (cur ? Date.now() - cur.startedAt : Date.now() - st.mine.startedAt));
  }
  let lastLv = null;
  function drawBars(m) {
    if (!strip) return;
    const st = stripState();
    if (!st || !st.mine || st.mine.id !== m.id) return;
    const el = strip.querySelector('.upc-rec-bars');
    if (!el) return;
    const kind = !m.ok ? 'bg-secondary' : m.quiet ? 'bg-warning' : 'bg-success';
    [...el.children].forEach((s, i) => { if (s.className !== kind) s.className = kind; s.style.height = Math.round(4 + (m.lv[i] || 0) * 20) + 'px'; });
  }

  function ensureStrip() {
    const ids = noteIds();
    const host = ids && editorHost();
    if (!host) { if (strip) { strip.remove(); strip = null; stripKey = ''; } return; }
    if (!strip) {
      strip = document.createElement('div');
      strip.className = 'upc-native upc-rec upc-rec-strip';
      strip.addEventListener('click', onStripClick);
      strip.addEventListener('change', onStripChange);
    }
    if (strip.isConnected && strip.nextElementSibling === host) return;
    host.parentNode.insertBefore(strip, host);
    renderStrip(true);
  }

  function onStripChange(e) {
    const sel = e.target.closest('select.upc-rec-mic');
    if (!sel) return;
    const device = { id: sel.value, label: sel.options[sel.selectedIndex].text };
    const st = stripState();
    if (st && st.mine) { bc.postMessage({ t: 'cmd', id: st.mine.id, do: 'mic', device }); return; }
    try { localStorage.setItem('upc-rec:mic', JSON.stringify(device)); } catch (x) { /* fine */ }
  }
  function onStripClick(e) {
    const a = e.target.closest('[data-a]');
    if (!a) return;
    const st = stripState();
    if (!st) return;
    if (a.dataset.a === 'start') startRecording(st);
    if (a.dataset.a === 'finish' && st.mine) bc.postMessage({ t: 'cmd', id: st.mine.id, do: 'finish' });
    if (a.dataset.a === 'show') { const w = window.open('', WIN); if (w && !w.__upcRecorder) w.close(); else if (w) w.focus(); }
    if (a.dataset.a === 'download' && st.saved) download(st.saved).catch((x) => U().ui.toast('Not downloaded: ' + (x.message || x), { kind: 'danger' }));
  }

  // Start Appointment: the window is opened straight away (Firefox only allows a pop-up from the click itself).
  // The note's patient, practitioner and date (GET /note/:id; live 25 Nov 2026: patient.name, notePractitionerName or
  // assignedPractitionerName, date.date and date.time as the page shows them). Empty if Halaxy doesn't say.
  async function noteFacts(noteId) {
    try {
      const j = await Promise.race([U().http.json('/note/' + encodeURIComponent(noteId)), new Promise((ok) => setTimeout(() => ok(null), 8000))]);
      if (!j) return {};
      const d = j.date || (j.note && j.note.date) || {};
      return { patient: U().clean((j.patient && j.patient.name) || ''), practitioner: U().clean(j.notePractitionerName || j.assignedPractitionerName || ''),
        noteDate: d.date ? d.date + (d.time ? ' ' + d.time : '') : '' };
    } catch (e) { return {}; }
  }
  // Start Appointment: the window is opened straight away (Firefox only allows a pop-up from the click itself).
  async function startRecording(st) {
    if (anyLive()) return;
    const w = window.open('', WIN, 'popup=yes,width=540,height=460');
    if (!w) { U().ui.toast('Firefox blocked the recorder window. Allow pop-ups for Halaxy, then press Start Appointment again.', { kind: 'danger', ms: 0 }); return; }
    if (w.__upcRecorder || w.__upcStarting) { w.focus(); return; }   // already recording (its report not seen yet)
    w.__upcStarting = true;
    const prev = st.saved && Date.now() - st.saved.startedAt < CONTINUE_MS && st.saved.status !== 'recording' ? st.saved : null;
    const facts = prev && prev.patient ? prev : await noteFacts(st.ids.noteId);
    const cfg = Object.assign({}, REC, { id: prev ? prev.id : 'r' + Date.now().toString(36), noteId: st.ids.noteId, patientId: st.ids.patientId,
      patient: facts.patient || '', practitioner: facts.practitioner || U().user.name(), noteDate: facts.noteDate || '', by: U().user.name(), device: savedMic() });
    try {
      if (w.closed) return;
      openRecorder(w, cfg);
    } catch (e) {
      try { w.close(); } catch (x) { /* fine */ }
      U().ui.toast('The recorder window could not start: ' + (e.message || e), { kind: 'danger', ms: 0 });
    }
  }
  function openRecorder(w, cfg) {
    const d = w.document;
    const links = [...document.querySelectorAll('link[rel~="stylesheet"][href]')].map((l) => '<link rel="stylesheet" href="' + esc(l.href) + '">').join('');
    d.open();
    d.write('<!doctype html><html class="' + esc(document.documentElement.className) + '"><head><meta charset="utf-8"><title>Recording | Halaxy</title>' + links + '</head>' +
      '<body class="' + esc(document.body.className) + ' upc-rec-body"><div id="upc-rec-root" class="upc-native upc-rec upc-rec-window"></div></body></html>');
    d.close();
    [...document.querySelectorAll('style')].forEach((s) => { const c = d.createElement('style'); c.textContent = s.textContent; d.head.appendChild(c); });
    // Reloading the window must not open the note there (two copies of a note overwrite each other): it opens the
    // recordings organisation, which says the recording stopped.
    try { w.history.replaceState(null, '', U().base() + '/organisation/' + ORG + '#' + RELOADED); } catch (e) { /* stays as it is */ }
    const s = d.createElement('script');
    s.textContent = 'const makeDb = ' + makeDb.toString() + ';\n(' + RECORDER.toString() + ')(' + JSON.stringify(cfg) + ', makeDb);';
    d.head.appendChild(s);
    try { w.focus(); } catch (e) { /* fine */ }
  }

  // The recorder window reloaded: it is now a Halaxy page, and the recording has stopped.
  function reloaded() {
    if (location.hash !== '#' + RELOADED) return;
    const dlg = U().ui.dialog({ title: 'Recording Stopped', small: true, key: 'upc-rec-reloaded' });
    if (!dlg) return;
    dlg.body.innerHTML = '<div class="alert alert-warning upc-warn">The recording stopped when this window was reloaded. Press Continue Recording on the note to carry on.</div>' +
      '<div class="text-right"><button type="button" class="btn btn-primary" data-a="close">Close Window</button></div>';
    dlg.body.addEventListener('click', (e) => { if (e.target.closest('[data-a=close]')) { window.close(); dlg.close(); } });
  }

  // ------------------------------------------------------------------ Patients > Recordings

  const page = { unmount: null, root: null };
  function renderPage() {
    const root = page.root;
    if (!root) return;
    const base = U().base();
    const rows = recs.map((r) => '<tr data-upc-id="' + esc(r.id) + '"><td data-sort="' + r.startedAt + '">' + esc(day(r.startedAt) + ' ' + hm(r.startedAt)) + '</td>' +
      '<td>' + esc(clock(lengthOf(r))) + (r.status === 'stopped' ? ' ' + U().ui.page.pill('Window closed', 'warn') : '') + '</td><td>' + esc(r.patient || '') + '</td><td>' + esc(r.practitioner || r.who || '') + '</td>' +
      '<td><a href="' + esc(base + '/patient/' + r.patientId + '/clinical/category/note/id/' + r.noteId) + '">' + esc(r.noteDate ? r.noteDate.split(' ')[0] : 'Open Note') + '</a></td>' +
      '<td>' + copyPill(r) + '</td><td data-sort="' + (r.startedAt + KEEP_LOCAL_MS) + '">' + esc(day((r.endedAt || r.startedAt) + KEEP_LOCAL_MS)) + '</td>' +
      '<td class="text-nowrap">' + (r.status === 'recording' ? '' : '<button type="button" class="btn btn-outline-primary-light" data-a="download">Download</button> ' +
        '<button type="button" class="btn btn-outline-primary-light" data-a="delete">Delete</button>') + '</td></tr>').join('');
    root.innerHTML = '<div class="upc-rec">' + U().ui.page.bar('Recordings', '', '') +
      U().ui.page.card('Recordings on This PC', recs.length, '', '<table class="table table-striped table-bordered w-100 m-0" data-upc-list="upc-recordings"><thead><tr><th>Recorded</th><th>Length</th><th>Patient</th><th>Practitioner</th><th>Note</th><th>Copy in Halaxy</th><th>Kept Until</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>') +
      '<p class="text-muted">Kept on this PC for 14 days; copies in Halaxy for 2 days.</p></div>';
    U().ui.list.enhance(root, { auto: true });
  }
  function onPageClick(e) {
    const a = e.target.closest('[data-a]');
    const tr = a && a.closest('tr[data-upc-id]');
    const r = tr && recs.find((x) => x.id === tr.getAttribute('data-upc-id'));
    if (!r) return;
    if (a.dataset.a === 'download') download(r).catch((x) => U().ui.toast('Not downloaded: ' + (x.message || x), { kind: 'danger' }));
    if (a.dataset.a === 'delete') {
      const dlg = U().ui.dialog({ title: 'Delete Recording', small: true, key: 'upc-rec-delete' });
      if (!dlg) return;
      const ups = (r.parts || []).map((p) => upOf(r, p));
      const inHalaxy = ups.length && ups.every((u) => u.state === 'saved') && Date.now() - r.startedAt < KEEP_HALAXY_MS;
      dlg.body.innerHTML = '<p>Delete the recording of ' + esc(day(r.startedAt) + ' ' + hm(r.startedAt)) + ' (' + esc(clock(lengthOf(r))) + ') from this PC?' +
        (inHalaxy ? ' Its copy in Halaxy stays until ' + esc(day(r.startedAt + KEEP_HALAXY_MS)) + '.' : '') + '</p>' +
        '<div class="text-right"><button type="button" class="btn btn-outline-primary" data-upc-close>Cancel</button> <button type="button" class="btn btn-primary" data-a="yes">Delete</button></div>';
      dlg.body.addEventListener('click', async (ev) => {
        if (!ev.target.closest('[data-a=yes]')) return;
        dlg.close();
        await db.delRec(r.id);
        (r.parts || []).forEach((p) => store.del(upKey(r, p)));
        await loadRecs();
      });
    }
  }
  function mountPage() {
    if (page.unmount) return;
    U().ui.nativeStyles();
    page.root = document.createElement('div');
    page.root.className = 'upc-native';
    page.root.addEventListener('click', onPageClick);
    page.unmount = U().ui.mountPage('Recordings', page.root, MENU_CLS);
    renderPage();
    loadRecs().then(renderPage);
  }
  function unmountPage() { if (page.unmount) { page.unmount(); page.unmount = null; page.root = null; } }
  const route = () => (location.hash === '#' + ROUTE ? mountPage() : unmountPage());

  function paint() { renderStrip(); renderPage(); }

  // ------------------------------------------------------------------ start

  async function housekeeping() {
    await loadRecs();
    await markStopped();
    await loadRecs();
    uploads().catch((e) => console.warn('[UPC appointment recorder] upload', e));
    cleanLocal().catch((e) => console.warn('[UPC appointment recorder] local clean-up', e));
    cleanHalaxy();
  }

  function start() {
    if (!U()) { console.error('[UPC appointment recorder] needs the core library'); return; }
    if (!window.indexedDB) return;
    if (!document.getElementById('upc-appointment-recorder-css')) {
      const st = document.createElement('style');
      st.id = 'upc-appointment-recorder-css';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    U().ui.nativeStyles();
    if (bc) {
      bc.onmessage = (e) => {
        const m = e.data || {};
        if (m.t === 'st') {
          const was = live.get(m.id);
          live.set(m.id, Object.assign({ at: Date.now() }, m));
          if (!was || was.status !== m.status || was.part !== m.part) loadRecs(); else renderStrip();
        }
        if (m.t === 'lv') { lastLv = m; drawBars(m); }
        if (m.t === 'part' || m.t === 'finished') loadRecs().then(() => uploads());
        if (m.t === 'gone') { const s = live.get(m.id); if (s) s.at = 0; setTimeout(() => housekeeping(), STALE_MS + 1000); loadRecs(); }
      };
      bc.postMessage({ t: 'ping' });
    }
    U().ui.ensureMenuItem('Recordings', (section) => {
      const list = section && [...section.querySelectorAll('a.mainmenu-sublink')].find((a) => /^patient list$/i.test(U().clean(a.textContent)));
      return (list ? list.getAttribute('href').split('#')[0] : U().base() + '/patient/') + '#' + ROUTE;
    }, MENU_CLS, /^patients?$/i);
    window.addEventListener('hashchange', route);
    window.addEventListener('storage', (e) => { if (e.key && e.key.startsWith(KEY + 'up:')) paint(); });
    new MutationObserver(() => { if (!stripTimer) stripTimer = setTimeout(() => { stripTimer = null; ensureStrip(); }, 200); }).observe(document.body, { childList: true, subtree: true });
    setInterval(() => { timeNow(); if (strip) renderStrip(); }, 1000);
    setInterval(() => housekeeping().catch(() => {}), 15e3);
    ensureStrip();
    route();
    reloaded();
    housekeeping().catch(() => {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  window.upcAppointmentRecorder = { version: VERSION, db, loadRecs, housekeeping, uploads, cleanHalaxy, cleanLocal, fileTitle, fileName, joined, live };
})();
