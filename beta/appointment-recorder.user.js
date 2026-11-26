// ==UserScript==
// @name         UPC Patients: Appointment recorder (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.3.6
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/appointment-recorder.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/appointment-recorder.user.js
// @description  Start Appointment on a clinical note: records the session in a small window, saved on this PC every few seconds, with a sound level and a microphone choice. A copy goes to Halaxy for 2 days; Patients > Recordings lists this PC's recordings.
// @match        https://*.halaxy.com/a/pr/*
// @match        https://scribe.heidihealth.com/*
// @run-at       document-start
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

  const VERSION = '0.3.6';
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
    channel: CHANNEL, bars: BARS, chunkMs: 5000, bitrate: 16000, warnMs: 75 * 60e3, maxMs: 2 * 3600e3, heidi: true,
    // Heidi's own full-size window, opened by the Finish press itself (CH, 25 Nov 2026: Firefox on the PCs ignores
    // resizing, and Heidi draws the small recorder window without Upload session audio).
    heidiUrl: 'https://scribe.heidihealth.com/', heidiName: 'upc-heidi', heidiWin: 'popup=yes,width=1100,height=820',
    lowHz: 110, highHz: 4200, quietRms: 0.004, quietMs: 30e3, version: VERSION,
  };

  if (location.hostname === 'scribe.heidihealth.com') { heidiSide(); return; }

  const U = () => window.UPC;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = { get: (k, d) => U().storage(KEY).get(k, d), set: (k, v) => U().storage(KEY).set(k, v), del: (k) => U().storage(KEY).del(k) };
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const hm = (ms) => { const d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600); return (h ? h + ':' + pad(Math.floor(s / 60) % 60) : pad(Math.floor(s / 60))) + ':' + pad(s % 60); };
  const day = (ms) => (U() ? U().dayLabel(ms) : ymd(ms));
  const TAB = Math.random().toString(36).slice(2, 8);

  // ------------------------------------------------------------------ on Heidi (scribe.heidihealth.com)

  // Runs in every Heidi page (loader 1.5.0) but acts only in the window Halaxy sends a recording to: Halaxy offers it
  // (heidi-offer, every 2 seconds, to that window only), this page asks for it (heidi-want) and gets the file
  // (heidi-audio). Then, as a person would: New session, Upload session audio, the file chosen; Heidi transcribes and
  // writes the note by itself. Heidi's own answers are watched (its upload, then its consult note with status
  // COMPLETED), never asked for. The note (Heidi's markdown and its editor's HTML) goes back to Halaxy (heidi-note),
  // and once Halaxy has it (heidi-done) the window waits, loaded, for the next recording (CH, 26 Nov 2026: Heidi is slow to
  // load; one window kept open and reused, opened at Start). One recording at a time: an offer while busy is answered
  // heidi-busy, and Halaxy offers again (queued). Anything unexpected stops with a message (heidi-failed).
  // Elements found by Heidi's own test labels (recon 25 Nov 2026; project doc heidi-recorder.md).
  function heidiSide() {
    const HALAXY = /^https:\/\/([a-z0-9-]+\.)*halaxy\.com$/;
    const seen = { uploads: [], notes: [] };   // Heidi's own answers: { at, url, status } and { at, url, note }
    let job = null;
    const used = new Set();   // sessions this window has used: never reused for another recording
    const now = () => Date.now();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const q = (s) => document.querySelector(s);

    // Heidi's requests, watched only (XHR and fetch), from the page's start.
    const noted = (url, method, status, text) => {
      url = String(url || '');
      if (/\/ml-scribe\/sessions\/[^/]+\/upload-audio\b/.test(url) && /post/i.test(method)) seen.uploads.push({ at: now(), url, status });
      if (/\/ml-scribe\/sessions\/[^/]+\/consult-note\/?(\?|$)/.test(url) && status === 200 && text) {
        try {
          const j = JSON.parse(text);
          const c = j && Array.isArray(j.consult_notes) ? j.consult_notes[0] : null;
          if (c && c.status === 'COMPLETED' && c.note) seen.notes.push({ at: now(), url, note: String(c.note) });
        } catch (e) { /* not JSON */ }
      }
    };
    try {
      const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (m, u) { this.__upcRec = [m, u]; return XO.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function () {
        const x = this, i = x.__upcRec || [];
        x.addEventListener('loadend', () => { let t = ''; try { t = x.responseType === '' || x.responseType === 'text' ? x.responseText : x.responseType === 'json' ? JSON.stringify(x.response) : ''; } catch (e) { /* none */ } noted(i[1], i[0], x.status, t); });
        return XS.apply(this, arguments);
      };
      const F = window.fetch;
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const method = (init && init.method) || (input && input.method) || 'GET';
        const p = F.apply(this, arguments);
        if (/\/ml-scribe\/sessions\//.test(url)) p.then((r) => { const ct = r.headers.get('content-type') || ''; if (/json/.test(ct)) r.clone().text().then((t) => noted(url, method, r.status, t)).catch(() => {}); else noted(url, method, r.status, ''); }, () => {});
        return p;
      };
    } catch (e) { /* watched by the page instead */ }

    // ---- the cover over Heidi's page while the step runs (as Portal fill does on the portals)
    let cover = null;
    function show(text, kind, closeable) {
      if (!document.body) { document.addEventListener('DOMContentLoaded', () => show(text, kind, closeable), { once: true }); return; }
      if (!cover) {
        cover = document.createElement('div');
        cover.setAttribute('data-upc-heidi-cover', '');
        cover.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(255,255,255,.88);display:flex;align-items:center;justify-content:center;font:15px/1.5 system-ui,sans-serif;color:#2d2d35';
        cover.addEventListener('click', (e) => {
          const b = e.target.closest('button[data-a]');
          if (!b) return;
          if (b.dataset.a === 'stop') fail(new Error('Stopped in the Heidi window.'));
          if (b.dataset.a === 'close') hide();
        });
        document.body.appendChild(cover);
      }
      const colour = kind === 'err' ? '#a32d2d' : '#5c2899';
      cover.innerHTML = '<div style="background:#fff;border:1px solid #dcdce4;border-radius:8px;padding:24px 28px;max-width:440px;text-align:center;box-shadow:0 4px 16px rgba(0,0,0,.12)">' +
        '<div style="font-weight:700;font-size:17px;margin-bottom:8px;color:' + colour + '">' + (kind === 'err' ? 'Not Done' : 'Sending to Heidi') + '</div>' +
        '<div data-upc-heidi-step style="margin-bottom:16px"></div>' +
        '<button type="button" data-a="' + (closeable ? 'close' : 'stop') + '" style="padding:6px 16px;border-radius:4px;border:1px solid #5c2899;background:#fff;color:#5c2899;font-weight:700;cursor:pointer">' + (closeable ? 'Close' : 'Stop') + '</button></div>';
      cover.querySelector('[data-upc-heidi-step]').textContent = text;
    }
    function hide() { if (cover) { cover.remove(); cover = null; } }
    // To the Halaxy tab that sent the recording and to the tab that opened this window: after Finish the clinician may
    // move on in Halaxy (that tab's page changes, and its new page takes over).
    function post(msg) {
      const to = [job.src];
      try { if (window.opener && window.opener !== job.src) to.push(window.opener); } catch (e) { /* none */ }
      to.forEach((w) => { try { w.postMessage(msg, job.origin); } catch (e) { /* closed */ } });
    }
    let lastSaid = '';
    const say = (text) => { lastSaid = text; show(text); post({ upc: 'heidi-status', id: job.id, text }); };
    function fail(e) {
      if (!job || job.over) return;
      job.over = true;
      const error = (e && e.message) || String(e);
      show(error, 'err', true);
      post({ upc: 'heidi-failed', id: job.id, error });
    }
    async function waitFor(test, ms, what) {
      const t0 = now();
      for (;;) {
        if (job.over) throw new Error('Stopped.');
        const v = test();
        if (v) return v;
        if (now() - t0 > ms) throw new Error('Heidi\'s page has changed or is slow: ' + (typeof what === 'function' ? what() : what) + ' did not appear.');
        await sleep(250);
      }
    }
    // A press as a person's mouse makes it (Heidi's menus open on pointer down, their items act on click).
    function press(el) {
      const o = { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerType: 'mouse', isPrimary: true, view: window };
      try { el.dispatchEvent(new PointerEvent('pointerdown', o)); } catch (e) { /* older */ }
      el.dispatchEvent(new MouseEvent('mousedown', o));
      try { el.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, o, { buttons: 0 }))); } catch (e) { /* older */ }
      el.dispatchEvent(new MouseEvent('mouseup', Object.assign({}, o, { buttons: 0 })));
      el.click();
    }
    const sessionOf = () => (location.pathname.match(/\/sessions\/([^/?#]+)/) || [])[1] || null;
    function editorHtml() {
      const eds = [...document.querySelectorAll('.tiptap.ProseMirror, .ProseMirror')].filter((el) => !cover || !cover.contains(el))
        .sort((a, b) => (b.innerText || '').length - (a.innerText || '').length);
      return eds.length && (eds[0].innerText || '').trim().length > 5 ? eds[0].innerHTML : '';
    }

    // A session with nothing recorded yet: Transcribe and its menu, no Resume.
    // Transcribe's menu: by its test label, else by its accessible name (as Heidi labels it).
    const menu = () => q('[data-testid="start-recording-dropdown"]') || q('button[aria-label="Open transcription mode menu"]');
    const fresh = () => !!(sessionOf() && !used.has(sessionOf()) && q('[data-testid="start-recording-button"]') && menu() && !q('[data-testid="resume-recording-button"]'));
    // When it was started, from its date button ("Today 07:54 PM"); null if not shown.
    function startedAgo() {
      const b = [...document.querySelectorAll('button')].find((x) => /^Today \d\d?:\d\d [AP]M$/.test(x.textContent.trim()));
      if (!b) return null;
      const m = b.textContent.trim().match(/(\d\d?):(\d\d) ([AP])M/);
      const d = new Date(now());
      d.setHours((+m[1] % 12) + (m[3] === 'P' ? 12 : 0), +m[2], 0, 0);
      return now() - d.getTime();
    }
    const missing = (before) => 'the new session (' + [location.pathname === before ? 'address unchanged' : '', !sessionOf() ? 'not a session' : '',
      !q('[data-testid="start-recording-button"]') ? 'no Transcribe' : '', !menu() ? 'no menu (window ' + window.innerWidth + ' wide)' : '',
      q('[data-testid="resume-recording-button"]') ? 'Resume shown' : ''].filter(Boolean).join(', ') + ')';
    // Heidi's own moves on opening (it often goes straight to a new, empty session): wait until its address stays put.
    async function settle() {
      let p = location.pathname;
      let t = now();
      const end = now() + 10e3;
      while (now() < end && !job.over) {
        await sleep(250);
        if (location.pathname !== p) { p = location.pathname; t = now(); } else if (now() - t >= 2000) return;
      }
    }

    // Transcribe's menu opened and its "Upload session audio" item (CH, 26 Nov 2026: pressed while Heidi was still
    // loading, the menu stayed shut). Pressed only once it is active, and again if it didn't open.
    const off = (el) => !!(el.disabled || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('data-disabled'));
    const uploadItem = () => q('[data-testid="start-recording-dropdown-upload"]') ||
      [...document.querySelectorAll('[role="menuitem"]')].find((el) => (!cover || !cover.contains(el)) && /upload session audio/i.test(el.textContent));
    async function openUpload() {
      const t0 = now();
      let tries = 0;
      let last = 0;
      for (;;) {
        if (job.over) throw new Error('Stopped.');
        const item = uploadItem();
        if (item) return item;
        const m = menu();
        if (now() - t0 > 40e3) {
          const st = !m ? 'missing' : off(m) ? 'not active' : m.getAttribute('aria-expanded') === 'true' ? 'open, without the item' : 'not opening';
          throw new Error('Heidi\'s page has changed or is slow: Upload session audio did not appear (menu ' + st + ', pressed ' + tries + ' times).');
        }
        if (m && !off(m) && now() - last > 2500) {
          if (m.getAttribute('aria-expanded') === 'true') press(m);   // open without the item yet: shut, then open again
          else {
            tries++;
            last = now();
            press(m);
            if (tries > 1) { m.focus(); m.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })); }
          }
        }
        await sleep(250);
      }
    }

    async function run() {
      say('Starting a new Heidi session');
      await waitFor(() => q('[data-testid="session-toolbar-cta-main"]'), 90e3, 'the New session button');
      await settle();
      // Heidi opened a new, empty session itself (New session does nothing there): use it if it was started just now.
      const ago = fresh() ? startedAgo() : null;
      if (!(fresh() && (ago === null || (ago > -60e3 && ago < 5 * 60e3)))) {
        const before = location.pathname;
        press(q('[data-testid="session-toolbar-cta-main"]'));
        const t1 = now();
        await waitFor(() => fresh() && (location.pathname !== before || now() - t1 > 8e3), 45e3, () => missing(before));
      }
      const session = sessionOf();
      used.add(session);
      say('Uploading the recording');
      press(await openUpload());
      const input = await waitFor(() => q('input[type=file][data-testid="upload-audio-file-input-input"]'), 15e3, 'the upload box');
      const t0 = now();
      const dt = new DataTransfer();
      dt.items.add(new File([job.blob], job.name || 'recording.ogg', { type: 'audio/ogg' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const up = await waitFor(() => {
        if (/unsupported file type/i.test((document.body && document.body.innerText) || '')) throw new Error('Heidi refused the recording: "Unsupported file type".');
        return seen.uploads.find((u) => u.at >= t0);
      }, 15 * 60e3, 'the upload');
      if (up.status !== 200) throw new Error('Heidi refused the recording (' + up.status + ').');
      say('Waiting for Heidi\'s note');
      const n = await waitFor(() => seen.notes.find((x) => x.at >= t0 && (!session || x.url.includes(session))) || seen.notes.find((x) => x.at >= t0), 20 * 60e3, 'Heidi\'s note');
      await sleep(1500);   // Heidi draws the note in its editor
      say('Sending Heidi\'s note to Halaxy');
      post({ upc: 'heidi-note', id: job.id, markdown: n.note, html: editorHtml(), session: session || '' });
      const j = job;
      setTimeout(() => { if (job === j && !j.over) fail(new Error('Halaxy did not confirm it has Heidi\'s note. Check the note in Halaxy.')); }, 60e3);
    }

    window.addEventListener('message', (e) => {
      if (!HALAXY.test(e.origin)) return;
      const d = e.data;
      if (!d || typeof d !== 'object' || typeof d.upc !== 'string' || d.upc.indexOf('heidi-') !== 0) return;
      // A recording offered but never sent (its Halaxy tab gone) doesn't hold the window.
      if (job && !job.blob && !job.over && now() - job.at > 30e3) { job.over = true; job.settled = true; }
      if (d.upc === 'heidi-offer' && job && !(job.over && job.settled) && d.id !== job.id) {
        try { e.source.postMessage({ upc: 'heidi-busy', id: d.id }, e.origin); } catch (x) { /* closed */ }
        return;
      }
      if (d.upc === 'heidi-offer' && (!job || (job.over && job.settled))) {
        job = { id: d.id, src: e.source, origin: e.origin, over: false, settled: false, at: now() };
        // Full size, as Heidi draws a narrow window without the upload menu (allowed: a window a script opened).
        try { if (window.outerWidth < 1100 || window.outerHeight < 820) window.resizeTo(Math.max(window.outerWidth, 1100), Math.max(window.outerHeight, 820)); } catch (x) { /* as it is */ }
        show('Getting the recording from Halaxy');
        e.source.postMessage({ upc: 'heidi-want', id: d.id }, e.origin);
      }
      if (!job || d.id !== job.id) return;
      if (d.upc === 'heidi-audio' && !job.blob && d.blob instanceof Blob && e.source === job.src) {
        job.blob = d.blob;
        job.name = d.name;
        const beat = setInterval(() => { if (job.over) clearInterval(beat); else if (lastSaid) post({ upc: 'heidi-status', id: job.id, text: lastSaid }); }, 15e3);   // still working
        const j = job;
        run().catch(fail).finally(() => { j.settled = true; });
      }
      if (d.upc === 'heidi-done') { const j = job; j.over = true; show('Heidi\'s note is in Halaxy.'); setTimeout(() => { if (job === j) hide(); }, 1500); }
      if (d.upc === 'heidi-cancel') { job.over = true; if (!job.blob) job.settled = true; hide(); }
    });
    // Closing or reloading the window mid-step asks first (CH, 26 Nov 2026), as the recorder window does while recording.
    // Firefox asks only once the window has had a real click (sign-in, a press on the cover).
    window.addEventListener('beforeunload', (e) => { if (job && !job.over) { e.preventDefault(); e.returnValue = ''; } });
    window.upcHeidiStep = { version: VERSION, seen, job: () => job };
  }

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
      if (state === 'finished') h += '<div class="alert alert-success upc-ok">' + esc(rec && rec.stopped ? rec.stopped + ' ' : '') + 'Recording saved on this PC.' + (cfg.heidi ? ' Sending to Heidi...' : '') + '</div>';
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
      setTimeout(() => window.close(), 1500);   // Heidi has a window of its own
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
      if (a.dataset.a === 'finish') {
        if (cfg.heidi) {
          try {
            const h = window.open('', cfg.heidiName, cfg.heidiWin);   // the Heidi window kept open, or a new one
            if (h && h.location.href === 'about:blank') h.location.href = cfg.heidiUrl;
          } catch (x) { /* already on Heidi (another site): left as it is */ }
        }
        finish().catch(fail);
      }
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
  // One tab at a time, for sure: Firefox's own lock between tabs (CH, 25 Nov 2026: every open tab heard "finished" at
  // once and two attached the same recording; the check-then-write lock above can't stop tabs acting in the same instant).
  // Runs fn only if no other tab holds the lock; else returns undefined.
  async function exclusive(name, fn) {
    if (!(navigator.locks && navigator.locks.request)) return lockTake(name, 10 * 60e3) ? Promise.resolve().then(fn).finally(() => lockFree(name)) : undefined;
    return navigator.locks.request('upc-rec:' + name, { ifAvailable: true }, (l) => (l ? fn() : undefined));
  }
  // A tab still running an older version (opened before an update) leaves the work to the newer one.
  let outdated = false;
  const newer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };

  function tellHealthCheck(e) {
    const message = (e && e.message) || String(e);
    if (!/has changed/.test(message)) return;
    document.dispatchEvent(new CustomEvent('upc-loader-error', { detail: JSON.stringify({ file: 'appointment-recorder.user.js', message }) }));
  }

  // A recording whose window has gone quiet (closed, reloaded, crashed): marked stopped where its last chunk was saved.
  // The recorder window closed while recording (CH, 26 Nov 2026: closed by mistake; Firefox asks first only in a window
  // that has had a click): said at once in Halaxy, with Continue Recording (the same recording, a new part).
  async function stopNow(id) {
    const cur = await db.rec(id);
    if (!cur || cur.status !== 'recording') return cur;
    cur.status = 'stopped';
    cur.endedAt = cur.beat || cur.startedAt;
    (cur.parts || []).forEach((p) => { if (!p.endedAt) p.endedAt = cur.endedAt; });
    await db.putRec(cur);
    return cur;
  }
  async function askContinue(id) {
    if (outdated || document.visibilityState !== 'visible') return;
    await U().sleep(1500);   // the window's last chunk, saved as it closed
    if (live.has(id) && fresh(live.get(id))) return;   // it carries on after all
    await exclusive('gone-ask:' + id, () => new Promise((done) => {
      (async () => {
        if (store.get('goneAsked:' + id, 0)) return done();
        store.set('goneAsked:' + id, Date.now());
        const r = await stopNow(id);
        await loadRecs();
        if (!r) return done();
        const here = !!(noteIds() && noteIds().noteId === r.noteId);
        const dlg = U().ui.dialog({ title: 'Recorder Window Closed', small: true, key: 'upc-rec-gone', onClose: done });
        if (!dlg) return done();
        dlg.body.innerHTML = '<p>' + esc('Recording stopped' + (r.patient ? ': ' + r.patient : '') + '.') + '</p><div class="text-right">' +
          '<button type="button" class="btn btn-outline-primary" data-g="">Leave Stopped</button> ' +
          '<button type="button" class="btn btn-primary" data-g="go">' + (here ? 'Continue Recording' : 'Open Note') + '</button></div>';
        dlg.body.addEventListener('click', (e) => {
          const b = e.target.closest('[data-g]');
          if (!b) return;
          const go = b.getAttribute('data-g') === 'go';
          dlg.close();
          if (!go) return;
          if (here) { const st = stripState(); if (st) startRecording(st); } else location.href = noteUrl(r);
        });
      })().catch((e) => { done(); tellHealthCheck(e); });
    }));
  }
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
    if (!todo.length || outdated) return;
    await exclusive('upload', async () => {
    uploading = true;
    try {
      for (const [r, p] of todo) {
        if (outdated) break;
        const was = upOf(r, p);
        if (was.state === 'saved' || (was.state === 'saving' && Date.now() - (was.at || 0) < 10 * 60e3 && was.by !== TAB)) continue;   // another tab did it
        store.set(upKey(r, p), Object.assign({}, was, { state: 'saving', at: Date.now(), by: TAB }));
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
    }
    });
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
    if (outdated || !U().background.due(store.get('cleanAt', 0), 6 * 3600e3)) return;
    return exclusive('clean', () => cleanHalaxyNow());
  }
  async function cleanHalaxyNow() {
    if (!U().background.due(store.get('cleanAt', 0), 6 * 3600e3)) return;   // another tab just did it
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
    }
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
    .upc-rec-covered { position: relative; }
    .upc-rec-cover { position: absolute; inset: 0; z-index: 50; display: flex; align-items: flex-start; justify-content: center; padding-top: 48px;
      background: rgba(255, 255, 255, .85); }
    .upc-rec-cover .card-body { display: flex; align-items: center; gap: 16px; }
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
      saved ? [saved.id, saved.status, (saved.parts || []).length, copyPill(saved), heidiOf(saved.id), !!saved.heidiNote] : null]);
    coverEditor();
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
          (saved.status === 'stopped' ? U().ui.page.pill('Window closed', 'warn') : '') + copyPill(saved) + heidiBits(saved, 'strip') +
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

  function pendingHere() {
    const ids = noteIds();
    if (!ids || !editor()) return;
    const r = recs.find((x) => x.noteId === ids.noteId && x.heidiNote);
    if (r) insertHeidi(r);
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
    pendingHere();
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
    if (a.dataset.a === 'finish' && st.mine) {
      if (REC.heidi) { try { const w = heidiWindow(); if (w) preOpened = { w, id: st.mine.id, at: Date.now() }; } catch (x) { /* opened later */ } }
      bc.postMessage({ t: 'cmd', id: st.mine.id, do: 'finish' });
    }
    if (a.dataset.a === 'show') { const w = window.open('', WIN); if (w && !(ours(w) && w.__upcRecorder)) w.close(); else if (w) w.focus(); }
    if (st.saved && heidiClick(a, st.saved)) return;
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
  // A window of that name on another site (CH, 25 Nov 2026: up to 0.3.2 the recorder window itself went to Heidi, and one
  // left open stopped Start, as a page can't be written into another site's window): brought back to a blank page of ours.
  const ours = (w) => { try { return !!w.document; } catch (e) { return false; } };
  async function reclaim(w) {
    if (ours(w)) return true;
    try { w.location.href = 'about:blank'; } catch (e) { return false; }
    for (let i = 0; i < 40; i++) {
      await U().sleep(100);
      if (w.closed) return false;
      if (ours(w) && w.document.readyState === 'complete') return true;
    }
    return false;
  }
  async function startRecording(st) {
    try { await startRecordingNow(st); } catch (e) {
      U().ui.toast('The recorder window could not start: ' + (e.message || e), { kind: 'danger', ms: 0 });
      tellHealthCheck(e);
    }
  }
  async function startRecordingNow(st) {
    if (anyLive()) { U().ui.toast('Another appointment is being recorded on this PC.', { kind: 'warning' }); return; }
    const w = window.open('', WIN, 'popup=yes,width=540,height=460');
    if (!w) { U().ui.toast('Firefox blocked the recorder window. Allow pop-ups for Halaxy, then press Start Appointment again.', { kind: 'danger', ms: 0 }); return; }
    // Heidi's window opened now, so Heidi loads during the appointment (CH, 26 Nov 2026); an open one is left as it is.
    // Firefox may allow only one window per press unless pop-ups are allowed for Halaxy: then Finish opens it.
    if (REC.heidi) { try { heidiWindow(); w.focus(); } catch (e) { /* at Finish */ } }
    if (!(await reclaim(w))) { try { w.close(); } catch (e) { /* fine */ } U().ui.toast('Close the other recorder or Heidi window, then press Start Appointment again.', { kind: 'danger', ms: 0 }); return; }
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

  // ------------------------------------------------------------------ the Heidi step (stage 2; CH, 25 Nov 2026)

  // After Finish, the recorder window becomes the Heidi window (no extra window) and Halaxy offers it the recording as
  // one file. One tab runs the step (lock heidi:<id>, renewed every 2 seconds, so a closed tab's step shows as stopped).
  // Heidi's note comes back and is kept on this PC (in the recording's record) only until it is in the note: by this
  // tab if it has the note open, by another tab that has it open, or by a new tab opened on the note (CH: the script
  // opens the note and finishes). A note with text asks first: Replace, Add Below or Cancel (CH). The editor is
  // covered from Finish until the note is in, with Cancel. Heidi accounts are shared (CH): no check of who is signed in.
  const HEIDI_ORIGIN = 'https://scribe.heidihealth.com';
  const HEIDI_URL = REC.heidiUrl;
  const HEIDI_WIN = REC.heidiWin;
  const HEIDI_NAME = REC.heidiName;
  let preOpened = null;   // the Heidi window this tab opened at a Finish press
  const HEIDI_MAX_MS = 30 * 60e3;
  const jobs = new Map();       // recording id -> the step this tab runs
  const claims = new Set();     // recordings whose note another tab has open
  const tried = new Set();      // recordings this page has tried to put in
  const lockHeld = (name) => { const l = store.get('lock:' + name, null); return !!l && l.until > Date.now(); };
  // A step under way is alive while its tab runs it or Heidi's window reports (every 15 seconds while it works).
  function heidiOf(id) {
    const h = store.get('heidi:' + id, null);
    if (h && /^(sending|waiting)$/.test(h.state) && !jobs.has(id) && !lockHeld('heidi:' + id) && Date.now() - (h.beat || h.at || 0) > 60e3) {
      return Object.assign({}, h, { state: 'failed', error: 'The Heidi step stopped before Heidi\'s note came back.' });
    }
    return h;
  }
  function setHeidi(id, v) {
    const was = store.get('heidi:' + id, null);
    const next = Object.assign({ at: Date.now(), beat: Date.now() }, v);
    if (was && was.state === next.state && was.text === next.text && was.error === next.error) { store.set('heidi:' + id, Object.assign({}, was, { beat: Date.now() })); return; }
    store.set('heidi:' + id, next);
    paint();
  }
  function heidiFailed(id, error) {
    setHeidi(id, { state: 'failed', error });
    tellHealthCheck({ message: error });
    return false;
  }
  function endJob(job) {
    clearInterval(job.timer);
    jobs.delete(job.id);
    lockFree('heidi:' + job.id);
  }
  const noteUrl = (r) => U().base() + '/patient/' + r.patientId + '/clinical/category/note/id/' + r.noteId;
  const editor = () => { const el = [...document.querySelectorAll('.ck-editor__editable')].find((x) => x.ckeditorInstance); return el ? el.ckeditorInstance : null; };
  const hereFor = (r) => { const ids = noteIds(); return !!ids && ids.noteId === r.noteId && !!editor(); };

  // w: a window already opened on Heidi by a click (Send to Heidi); otherwise the recorder window is sent there.
  // The Heidi window: a window of its own, opened at Heidi's full size (Firefox keeps a new window's size but may ignore
  // resizing; Heidi draws a narrow window without Upload session audio). An open one (from the Finish press) is reused.
  // One Heidi window, kept open and reused (CH, 26 Nov 2026): a new one only if there isn't one, and one already on Heidi is
  // left as it is (it may be writing another recording's note; recordings queue for it).
  function heidiWindow() {
    const w = window.open('', HEIDI_NAME, HEIDI_WIN);
    if (!w) return null;
    let blank = false;
    try { blank = w.location.href === 'about:blank'; } catch (e) { /* on Heidi */ }
    if (blank) w.location.href = HEIDI_URL;
    return w;
  }
  async function sendToHeidi(r, w) {
    if (!(await exclusive('claim:' + r.id, () => !jobs.has(r.id) && lockTake('heidi:' + r.id, 30e3)))) return false;
    if (!w && preOpened && preOpened.id === r.id && !preOpened.w.closed && Date.now() - preOpened.at < 5 * 60e3) w = preOpened.w;
    preOpened = null;
    const job = { id: r.id, w: w || null, started: Date.now(), wanted: false, timer: null, signIn: false };
    jobs.set(r.id, job);
    setHeidi(r.id, { state: 'sending', text: 'Sending to Heidi' });
    try {
      job.blob = await joined(r);
      job.name = fileName(r, null);
    } catch (e) { endJob(job); return heidiFailed(r.id, 'The recording could not be prepared for Heidi: ' + (e.message || e)); }
    if (!job.w || job.w.closed) {
      try { job.w = heidiWindow(); } catch (e) { endJob(job); return heidiFailed(r.id, 'The Heidi window could not be opened: ' + (e.message || e)); }
      if (!job.w) { endJob(job); return heidiFailed(r.id, 'Firefox blocked the Heidi window. Allow pop-ups for Halaxy, then press Send to Heidi.'); }
    }
    job.timer = setInterval(() => tickJob(job), 2000);
    tickJob(job);
    return true;
  }
  function tickJob(job) {
    lockTake('heidi:' + job.id, 30e3);
    if (!job.w || job.w.closed) { endJob(job); heidiFailed(job.id, 'The Heidi window was closed before Heidi\'s note came back.'); return; }
    if (!job.wanted) {
      try { job.w.postMessage({ upc: 'heidi-offer', id: job.id }, HEIDI_ORIGIN); } catch (e) { /* not on Heidi yet */ }
      if (!job.signIn && Date.now() - job.started > 20e3 && Date.now() - (job.busyAt || 0) > 8e3) {
        job.signIn = true;
        loaderVersion().then((v) => {
          if (job.wanted || !jobs.has(job.id)) return;
          // The loader runs on Heidi's site from 1.5.0; Tampermonkey checks for its updates about once a day (CH, 26 Nov 2026).
          if (v && newer('1.5.0', v)) { cancelHeidi(job.id); heidiFailed(job.id, 'This PC\'s loader (' + v + ') doesn\'t run on Heidi yet. In Tampermonkey choose Utilities, then Check for userscript updates, reload Halaxy, then press Send to Heidi.'); return; }
          setHeidi(job.id, { state: 'sending', text: 'Waiting for the Heidi window (sign in there if Heidi asks)' });
        });
      }
    }
    if (Date.now() - job.started > HEIDI_MAX_MS) {
      endJob(job);
      try { job.w.postMessage({ upc: 'heidi-cancel', id: job.id }, HEIDI_ORIGIN); } catch (e) { /* closed */ }
      setTimeout(() => { try { job.w.close(); } catch (e) { /* fine */ } }, 500);   // stuck for half an hour: a fresh window next time
      heidiFailed(job.id, 'Heidi didn\'t finish within ' + Math.round(HEIDI_MAX_MS / 60e3) + ' minutes.');
    }
  }
  // The loader's version, from its state answer (as Script settings reads it); null if it doesn't answer.
  function loaderVersion() {
    return new Promise((resolve) => {
      const h = (e) => { document.removeEventListener('upc-loader-state', h); try { resolve(JSON.parse(e.detail).version || null); } catch (x) { resolve(null); } };
      document.addEventListener('upc-loader-state', h);
      document.dispatchEvent(new CustomEvent('upc-loader-get'));
      setTimeout(() => { document.removeEventListener('upc-loader-state', h); resolve(null); }, 1500);
    });
  }
  function cancelHeidi(id) {
    const job = jobs.get(id);
    if (job) {
      try { job.w.postMessage({ upc: 'heidi-cancel', id }, HEIDI_ORIGIN); } catch (e) { /* closed */ }
      endJob(job);   // the Heidi window stays open for the next recording
    } else if (bc) bc.postMessage({ t: 'heidi-cancel', id });
    setHeidi(id, { state: 'cancelled' });
  }
  // From Heidi's window: only the tab running the step hands over the recording; any tab of this PC takes Heidi's
  // progress, a failure and the note (the clinician may have moved on in Halaxy since Finish).
  const noted = new Set();
  window.addEventListener('message', async (e) => {
    if (e.origin !== HEIDI_ORIGIN) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || typeof d.upc !== 'string' || !d.id) return;
    const job = jobs.get(d.id);
    if (d.upc === 'heidi-busy') {   // Heidi's window is on another recording: offered again until it is free
      if (job && e.source === job.w && !job.wanted) { job.busyAt = Date.now(); if (!job.queued) { job.queued = true; setHeidi(job.id, { state: 'sending', text: 'Queued for Heidi' }); } }
      return;
    }
    if (d.upc === 'heidi-want') {
      if (!job || e.source !== job.w || job.wanted) return;
      job.wanted = true;
      job.w.postMessage({ upc: 'heidi-audio', id: job.id, blob: job.blob, name: job.name }, HEIDI_ORIGIN);
      setHeidi(job.id, { state: 'waiting', text: 'Sending to Heidi' });
      return;
    }
    const h = store.get('heidi:' + d.id, null);
    if (h && h.state === 'cancelled') { try { e.source.postMessage({ upc: 'heidi-cancel', id: d.id }, HEIDI_ORIGIN); } catch (x) { /* closed */ } return; }
    if (!job && !(h && /^(sending|waiting|ready)$/.test(h.state))) return;   // only a step under way
    if (d.upc === 'heidi-status') setHeidi(d.id, { state: 'waiting', text: String(d.text || '') });
    if (d.upc === 'heidi-failed') { if (job) endJob(job); heidiFailed(d.id, String(d.error || 'Heidi stopped.')); }
    if (d.upc === 'heidi-note') {
      try { e.source.postMessage({ upc: 'heidi-done', id: d.id }, HEIDI_ORIGIN); } catch (x) { /* closed */ }
      if (job) endJob(job);
      if (noted.has(d.id)) return;
      noted.add(d.id);
      const r = await db.rec(d.id);
      if (!r) return;
      if (!r.heidiNote) {
        r.heidiNote = { markdown: String(d.markdown || ''), html: String(d.html || ''), at: Date.now() };
        r.heidiSession = String(d.session || '');
        await db.putRec(r);
      }
      setHeidi(d.id, { state: 'ready', text: 'Heidi\'s note is ready' });
      await loadRecs();
      if (!outdated) exclusive('deliver:' + d.id, () => { if (lockTake('deliver:' + d.id, 20e3)) return deliver(d.id); });
    }
  });
  // Finished: the tab with the note open starts the step at once, any other a few seconds later if none has.
  async function autoHeidi(id) {
    await loadRecs();
    const r = recs.find((x) => x.id === id);
    if (outdated || !r || heidiOf(id)) return;
    if (!(noteIds() && noteIds().noteId === r.noteId)) await U().sleep(3000);
    if (outdated || heidiOf(id) || lockHeld('heidi:' + id)) return;
    sendToHeidi(r, null);
  }
  async function deliver(id) {
    const r = await db.rec(id);
    if (!r || !r.heidiNote) return;
    if (hereFor(r)) { insertHeidi(r); return; }
    claims.delete(id);
    if (bc) bc.postMessage({ t: 'heidi-ready', id, noteId: r.noteId });
    await U().sleep(1500);
    const h = heidiOf(id) || {};
    if (claims.has(id) || h.state === 'done' || h.state === 'cancelled') return;
    if (!window.open(noteUrl(r), '_blank')) setHeidi(id, { state: 'ready', text: 'Heidi\'s note is ready', error: 'Open the note to add Heidi\'s note (Firefox blocked a new tab).' });
  }

  // Heidi's note as HTML for Halaxy's editor: Heidi's own editor copy (its formatting, as a paste gives), tidied to plain
  // text formatting; else its markdown, line by line.
  function cleanHtml(html) {
    const root = U().htmlDoc('<div>' + html + '</div>').body.firstElementChild;
    const OK = /^(P|BR|STRONG|B|EM|I|U|UL|OL|LI|H1|H2|H3|H4|BLOCKQUOTE)$/;
    const walk = (el) => [...el.children].forEach((c) => {
      walk(c);
      if (OK.test(c.tagName)) [...c.attributes].forEach((a) => c.removeAttribute(a.name)); else c.replaceWith(...c.childNodes);
    });
    walk(root);
    return root.innerHTML.trim();
  }
  function mdHtml(md) {
    const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/__(.+?)__/g, '<strong>$1</strong>');
    return String(md || '').split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim())
      .map((l) => { const h = l.match(/^#{1,6}\s+(.*)$/); return '<p>' + (h ? '<strong>' + inline(h[1]) + '</strong>' : inline(l.replace(/^\s*[*•]\s+/, '- '))) + '</p>'; }).join('');
  }
  const noteHtml = (n) => (n.html && cleanHtml(n.html)) || mdHtml(n.markdown);
  const hasText = (ed) => !!U().clean(U().htmlDoc('<div>' + ed.getData() + '</div>').body.textContent.replace(/ /g, ' '));
  function askHow() {
    return new Promise((ok) => {
      let picked = null;
      const dlg = U().ui.dialog({ title: 'Heidi\'s Note', small: true, key: 'upc-rec-heidi-how', onClose: () => ok(picked) });
      if (!dlg) { ok(null); return; }
      dlg.body.innerHTML = '<p>This note already has text.</p><div class="text-right">' +
        '<button type="button" class="btn btn-outline-primary" data-how="">Cancel</button> ' +
        '<button type="button" class="btn btn-outline-primary" data-how="end">Add Below</button> ' +
        '<button type="button" class="btn btn-primary" data-how="replace">Replace</button></div>';
      dlg.body.addEventListener('click', (e) => { const b = e.target.closest('[data-how]'); if (!b) return; picked = b.getAttribute('data-how') || null; dlg.close(); });
    });
  }
  // Through the editor, as a paste is (so Halaxy saves it as usual): one change, which the editor's own Undo reverses.
  function putIn(ed, html, how) {
    const frag = ed.data.toModel(ed.data.processor.toView(html));
    ed.model.change((w) => {
      const root = ed.model.document.getRoot();
      if (how === 'replace') w.setSelection(w.createRangeIn(root)); else w.setSelection(root, 'end');
      ed.model.insertContent(frag);
    });
  }
  async function dropNote(r, state, extra) {
    delete r.heidiNote;
    await db.putRec(r);
    setHeidi(r.id, Object.assign({ state }, extra || {}));
    await loadRecs();
  }
  async function insertHeidi(r) {
    if (tried.has(r.id)) return;
    tried.add(r.id);
    const ran = await exclusive('insert:' + r.id, () => insertHeidiNow(r).then(() => true));
    if (!ran) tried.delete(r.id);   // another tab has it
  }
  async function insertHeidiNow(r) {
    try {
      const ed = editor();
      const cur = await db.rec(r.id);
      if (!ed || !cur || !cur.heidiNote) return;
      if (ed.isReadOnly) {
        tried.delete(r.id);
        setHeidi(r.id, { state: 'ready', text: 'Heidi\'s note is ready', error: 'The note is published, so Heidi\'s note can\'t go in. Revert it to draft, then press Add Heidi\'s Note.' });
        return;
      }
      const html = noteHtml(cur.heidiNote);
      if (!html) { await dropNote(cur, 'failed', { error: 'Heidi\'s note came back empty.' }); return; }
      let how = 'end';
      if (hasText(ed)) {
        how = await askHow();
        if (!how) { await dropNote(cur, 'cancelled'); return; }
      }
      putIn(ed, html, how);
      await dropNote(cur, 'done');
      U().ui.toast('Heidi\'s note added.', { ms: 30000, action: { label: 'Undo', fn: () => { try { ed.execute('undo'); } catch (e) { /* nothing to undo */ } } } });
    } catch (e) {
      tried.delete(r.id);
      setHeidi(r.id, { state: 'ready', text: 'Heidi\'s note is ready', error: 'Heidi\'s note couldn\'t go in: ' + (e.message || e) });
      tellHealthCheck(e);
    }
  }

  // The editor covered from Finish until Heidi's note is in, with Cancel (as Portal fill covers the portals).
  function coverEditor() {
    const host = editorHost();
    const st = stripState();
    const r = st && !st.mine && st.saved;
    const h = r && heidiOf(r.id);
    const on = !!h && /^(sending|waiting)$/.test(h.state);
    let c = host && host.querySelector(':scope > .upc-rec-cover');
    if (!on) { if (c) c.remove(); if (host) host.classList.remove('upc-rec-covered'); return; }
    if (!c) {
      host.classList.add('upc-rec-covered');
      c = document.createElement('div');
      c.className = 'upc-native upc-rec-cover';
      c.innerHTML = '<div class="card"><div class="card-body"><div class="upc-rec-cover-text"></div><button type="button" class="btn btn-outline-primary" data-a="heidi-cancel">Cancel</button></div></div>';
      c.addEventListener('click', (e) => { if (e.target.closest('[data-a=heidi-cancel]')) cancelHeidi(r.id); });
      host.appendChild(c);
    }
    const t = c.querySelector('.upc-rec-cover-text');
    const text = h.text || 'Sending to Heidi';
    if (t.textContent !== text) t.textContent = text;
  }
  // The Heidi step on the strip and Recordings.
  function heidiBits(r, where) {
    const h = heidiOf(r.id);
    const P = U().ui.page.pill;
    const send = '<button type="button" class="btn btn-outline-primary' + (where === 'page' ? '-light' : '') + '" data-a="heidi">Send to Heidi</button>';
    if (r.status === 'recording' || !(r.parts || []).some((p) => p.chunks || p.bytes)) return '';
    if (!h) return send;
    if (/^(sending|waiting)$/.test(h.state)) return P(h.text || 'Sending to Heidi', 'wait');
    if (h.state === 'ready') return '<button type="button" class="btn btn-primary" data-a="heidi-add">Add Heidi\'s Note</button>' + (h.error && where === 'strip' ? '<span class="text-muted">' + esc(h.error) + '</span>' : '');
    if (h.state === 'done') return P('Heidi\'s note added', 'ok');
    if (h.state === 'failed') return '<span title="' + esc(h.error || '') + '">' + P('Not sent to Heidi', 'err') + '</span>' + (where === 'strip' && h.error ? '<span class="text-muted">' + esc(h.error) + '</span>' : '') + send;
    return send;
  }
  function heidiClick(a, r) {
    if (a.dataset.a === 'heidi') {
      let w = null;
      try { w = heidiWindow(); } catch (e) { /* said below */ }   // from the click itself, so Firefox allows it
      if (!w) { U().ui.toast('Firefox blocked the Heidi window. Allow pop-ups for Halaxy, then press Send to Heidi again.', { kind: 'danger', ms: 0 }); return true; }
      store.del('heidi:' + r.id);
      sendToHeidi(r, w);
      return true;
    }
    if (a.dataset.a === 'heidi-add') {
      if (hereFor(r)) { tried.delete(r.id); insertHeidi(r); } else window.open(noteUrl(r), '_blank');
      return true;
    }
    return false;
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
      '<td>' + copyPill(r) + '</td><td>' + heidiBits(r, 'page') + '</td><td data-sort="' + (r.startedAt + KEEP_LOCAL_MS) + '">' + esc(day((r.endedAt || r.startedAt) + KEEP_LOCAL_MS)) + '</td>' +
      '<td class="text-nowrap">' + (r.status === 'recording' ? '' : '<button type="button" class="btn btn-outline-primary-light" data-a="download">Download</button> ' +
        '<button type="button" class="btn btn-outline-primary-light" data-a="delete">Delete</button>') + '</td></tr>').join('');
    root.innerHTML = '<div class="upc-rec">' + U().ui.page.bar('Recordings', '', '') +
      U().ui.page.card('Recordings on This PC', recs.length, '', '<table class="table table-striped table-bordered w-100 m-0" data-upc-list="upc-recordings"><thead><tr><th>Recorded</th><th>Length</th><th>Patient</th><th>Practitioner</th><th>Note</th><th>Copy in Halaxy</th><th>Heidi</th><th>Kept Until</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>') +
      '<p class="text-muted">Kept on this PC for 14 days; copies in Halaxy for 2 days.</p></div>';
    U().ui.list.enhance(root, { auto: true });
  }
  function onPageClick(e) {
    const a = e.target.closest('[data-a]');
    const tr = a && a.closest('tr[data-upc-id]');
    const r = tr && recs.find((x) => x.id === tr.getAttribute('data-upc-id'));
    if (!r) return;
    if (heidiClick(a, r)) return;
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

  function paint() { renderStrip(); renderPage(); pendingHere(); }

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
        if (m.t === 'ver') { if (newer(m.v, VERSION)) outdated = true; else if (newer(VERSION, m.v)) bc.postMessage({ t: 'ver', v: VERSION }); }
        if (m.t === 'part' || m.t === 'finished') loadRecs().then(() => uploads());
        if (m.t === 'finished') autoHeidi(m.id);
        if (m.t === 'heidi-cancel' && jobs.has(m.id)) cancelHeidi(m.id);
        if (m.t === 'heidi-claim') claims.add(m.id);
        if (m.t === 'heidi-ready') loadRecs().then(() => { const r = recs.find((x) => x.id === m.id); if (r && hereFor(r)) { bc.postMessage({ t: 'heidi-claim', id: m.id }); insertHeidi(r); } });
        if (m.t === 'gone') {
          const s = live.get(m.id);
          const was = !!(s && s.status === 'recording' && fresh(s));
          if (s) s.at = 0;
          setTimeout(() => housekeeping(), STALE_MS + 1000);
          loadRecs();
          if (was) askContinue(m.id);
        }
      };
      bc.postMessage({ t: 'ping' });
      bc.postMessage({ t: 'ver', v: VERSION });
    }
    U().ui.ensureMenuItem('Recordings', (section) => {
      const list = section && [...section.querySelectorAll('a.mainmenu-sublink')].find((a) => /^patient list$/i.test(U().clean(a.textContent)));
      return (list ? list.getAttribute('href').split('#')[0] : U().base() + '/patient/') + '#' + ROUTE;
    }, MENU_CLS, /^patients?$/i);
    window.addEventListener('hashchange', route);
    window.addEventListener('storage', (e) => { if (e.key && (e.key.startsWith(KEY + 'up:') || e.key.startsWith(KEY + 'heidi:'))) paint(); });
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

  window.upcAppointmentRecorder = { version: VERSION, outdated: () => outdated, db, loadRecs, housekeeping, uploads, cleanHalaxy, cleanLocal, fileTitle, fileName, joined, live, heidiOf, sendToHeidi, mdHtml, cleanHtml };
})();
