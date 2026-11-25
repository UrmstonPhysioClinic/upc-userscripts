// ==UserScript==
// @name         UPC scripts
// @namespace    upc-starter
// @version      1.0.1
// @description  Starts the clinic's scripts. Install once per PC, then add the access key from its menu.
// @match        https://*.halaxy.com/*
// @match        https://provider.axahealth.co.uk/*
// @match        https://providersonline.bupa.co.uk/*
// @match        https://scribe.heidihealth.com/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addElement
// @grant        GM_registerMenuCommand
// @connect      raw.githubusercontent.com
// @connect      api.github.com
// ==/UserScript==

/*
 * The starter (CH, 20 Nov 2026: the repository goes private).
 *
 * Tampermonkey can't update a script from a private repository, so this small script is what's installed on each
 * PC, and it should hardly ever change. It keeps a copy of the loader (loader/upc-loader.user.js), runs it at
 * document-start with the Tampermonkey functions it needs, and fetches a new copy from GitHub every 10 minutes,
 * sending the PC's access key (a read-only GitHub token for this one repository). The loader then fetches every
 * other script the same way. A loader on GitHub with a syntax error is never saved: the old copy keeps running.
 *
 * Tampermonkey menu, under this script:
 *  - "UPC starter: access key": paste or clear the key (kept in this script's Tampermonkey storage, never in code).
 *  - "UPC starter: status": versions, last check, and any problem (also passed to the health check via the loader).
 *  - "UPC starter: fetch the loader again": throws away the saved copy and fetches it now.
 * Once a day it asks GitHub when the key expires; the loader shows a warning from 30 days before.
 * If the key is missing or wrong, everything already saved keeps running; only updates stop.
 */

(function () {
  'use strict';

  const STARTER = '1.0.0';
  const REPO = 'UrmstonPhysioClinic/upc-userscripts';
  const LOADER_URL = 'https://raw.githubusercontent.com/' + REPO + '/main/loader/upc-loader.user.js';
  const EVERY = 10 * 60e3, DAY = 864e5;
  const TAG = '[UPC starter]';

  const key = () => String(GM_getValue('github-token', '') || '').trim();
  const versionOf = (code) => (/\/\/\s*@version\s+(\S+)/.exec(String(code)) || [])[1] || '';
  const setError = (m) => { try { GM_setValue('starter:error', m || ''); } catch (e) { /* storage unavailable */ } };

  function get(url, wantHeaders) {
    return new Promise((resolve, reject) => {
      const headers = { Accept: 'application/vnd.github.raw' };
      if (key()) headers.Authorization = 'token ' + key();
      GM_xmlhttpRequest({
        method: 'GET', url, headers, nocache: true, timeout: 20000,
        onload: (r) => {
          if (r.status === 200) return resolve(wantHeaders ? r : r.responseText);
          if ([401, 403, 404].includes(r.status)) return reject(new Error(key() ? 'GitHub refused the access key (it may have expired). Add a new one from the Tampermonkey menu: UPC starter: access key.' : 'No access key on this PC. Add one from the Tampermonkey menu: UPC starter: access key.'));
          reject(new Error('GitHub answered ' + r.status + '.'));
        },
        onerror: () => reject(new Error('GitHub could not be reached.')),
        ontimeout: () => reject(new Error('GitHub took too long to answer.')),
      });
    });
  }

  function run(code) {
    try {
      // eslint-disable-next-line no-new-func
      new Function('GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_xmlhttpRequest', 'GM_addElement', 'GM_registerMenuCommand', 'UPC_STARTER',
        code + '\n//# sourceURL=upc-loader.user.js')(GM_getValue, GM_setValue, GM_deleteValue, GM_xmlhttpRequest, GM_addElement, GM_registerMenuCommand, { version: STARTER });
      return true;
    } catch (e) {
      setError('The loader stopped with an error: ' + (e && e.message || e));
      console.error(TAG, e);
      return false;
    }
  }

  let checking = null;
  function check(runNow) {
    if (checking) return checking;
    checking = (async () => {
      GM_setValue('starter:checked', Date.now());
      try {
        const code = await get(LOADER_URL + '?t=' + Date.now());
        if (!/==UserScript==/.test(code) || !versionOf(code)) throw new Error('The loader on GitHub could not be read.');
        const saved = GM_getValue('starter:loader', null);
        if (code !== saved) {
          try { new Function(code); } catch (e) { if (e instanceof SyntaxError) throw new Error('The loader on GitHub (' + versionOf(code) + ') has a mistake in it; the saved copy keeps running.'); }
          GM_setValue('starter:loader', code);
          if (runNow) run(code);
        }
        setError('');
      } catch (e) {
        setError(e.message);
        console.warn(TAG, e.message);
      }
      // Once a day: when the access key expires (GitHub says so in a header on its API).
      if (key() && Date.now() - GM_getValue('starter:expiryChecked', 0) > DAY) {
        try {
          const r = await get('https://api.github.com/repos/' + REPO, true);
          const m = /github-authentication-token-expiration:\s*([^\r\n]+)/i.exec(r.responseHeaders || '');
          GM_setValue('starter:expires', m ? Date.parse(m[1].replace(/ UTC$/, 'Z').replace(' ', 'T')) || 0 : 0);
          GM_setValue('starter:expiryChecked', Date.now());
        } catch (e) { /* tried again next time */ }
      }
    })().finally(() => { checking = null; });
    return checking;
  }

  // ---------------------------------------------------------------- start

  const saved = GM_getValue('starter:loader', null);
  const ran = saved ? run(saved) : false;
  if (window.top === window && /(^|\.)halaxy\.com$/.test(location.hostname)) {
    if (!saved || !ran || Date.now() - GM_getValue('starter:checked', 0) > EVERY) check(!saved);
  }

  // ---------------------------------------------------------------- Tampermonkey menu

  if (window.top === window) {
    GM_registerMenuCommand('UPC starter: access key', () => {
      const v = window.prompt('Access key for this PC (paste it in; leave empty to remove it).', '');
      if (v === null) return;
      GM_setValue('github-token', v.trim());
      GM_setValue('starter:expiryChecked', 0);
      check(!GM_getValue('starter:loader', null)).then(() => {
        const err = GM_getValue('starter:error', '');
        window.alert(err ? err : v.trim() ? 'Access key saved. The scripts will update from GitHub.' : 'Access key removed.');
      });
    });
    GM_registerMenuCommand('UPC starter: status', () => {
      const code = GM_getValue('starter:loader', null), exp = GM_getValue('starter:expires', 0), when = GM_getValue('starter:checked', 0);
      const err = GM_getValue('starter:error', '');
      window.alert(['Starter ' + STARTER + '.', 'Loader ' + (code ? versionOf(code) : 'not fetched yet') + '.',
        'Access key: ' + (key() ? 'added' + (exp ? ', expires ' + new Date(exp).toDateString() : '') : 'none') + '.',
        'Last checked: ' + (when ? new Date(when).toLocaleString() : 'never') + '.', err ? 'Problem: ' + err : 'No problems.'].join('\n'));
    });
    GM_registerMenuCommand('UPC starter: fetch the loader again', () => {
      GM_deleteValue('starter:loader');
      check(false).then(() => window.alert(GM_getValue('starter:error', '') || 'Fetched. Reload the page to use it.'));
    });
  }
})();
