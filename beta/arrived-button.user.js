// ==UserScript==
// @name         UPC Calendar: Arrived button (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      0.1.0
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/arrived-button.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/arrived-button.user.js
// @description  Arrived in one click: at the top of an appointment's right-click menu, and a button in its sidebar.
// @match        https://*.halaxy.com/a/pr/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * Arrived button (CH, 23 Nov 2026: easier for reception to tell clinicians a patient has arrived).
 *
 *  - Halaxy marks a patient Arrived from the appointment's right-click menu, Update status > Arrived: a link
 *    /calendar/appointment/{event id}/patient/{event patientID}/status/1/edit (classes ajax event-update), answering
 *    status OK (capture 23 Nov 2026). Halaxy then tells every PC (its arrival toast, and our arrival chime).
 *  - Right-click menu (#context-menu-area): "Arrived" at the top, under the patient's name. It clicks Halaxy's own
 *    Arrived link in the submenu, so Halaxy does exactly what it does now.
 *  - Sidebar (#RightHandPanel, an appointment open): an "Arrived" button by Rebook appointment. The appointment is
 *    a.editAppointment[data-appointmentid]; its patientID comes from the calendar's own event (the sidebar's patient
 *    link is a different number, checked 23 Nov 2026). It asks for the same link as Halaxy's menu; the calendar then
 *    shows the change with its next refresh (Halaxy's own, or Calendar controls' every 30 seconds).
 *  - Both only for an appointment today that is Booked or Confirmed (not already arrived, attended, cancelled ...).
 */
(() => {
  'use strict';
  if (window.__hxArrivedButton) return;
  window.__hxArrivedButton = true;

  const VERSION = '0.1.0';
  const ARRIVED = 1;   // Halaxy's status number for Arrived
  const OPEN = /^(|booked|confirmed|check-response)$/i;
  const U = () => window.UPC;

  function eventOf(id) {
    const HC = window.HkCalendar;
    const list = HC && HC.eventsView && HC.eventsView.model ? HC.eventsView.model.models : [];
    const m = list.find((x) => String(x.id) === String(id) || String(x.get && x.get('id')) === String(id));
    return m ? (m.attributes || m) : null;
  }
  // The appointment's day, read both ways (Halaxy keeps clinic times as if they were UTC): today either way counts.
  function isToday(start) {
    if (start === null || start === undefined || start === '') return true;
    const d = typeof start === 'number' ? new Date(start < 1e12 ? start * 1000 : start) : new Date(start && start.toDate ? start.toDate() : start);
    if (isNaN(d)) return true;
    const t = new Date();
    const local = d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate();
    const utc = d.getUTCFullYear() === t.getFullYear() && d.getUTCMonth() === t.getMonth() && d.getUTCDate() === t.getDate();
    return local || utc;
  }
  const canArrive = (e) => !e || (OPEN.test(String(e.appointmentStatus || '').trim()) && isToday(e.start));

  // ------------------------------------------------------------------ right-click menu

  function addToMenu() {
    const menu = document.getElementById('context-menu-area');
    if (!menu || menu.querySelector('.upc-arrived-item')) return;
    const own = menu.querySelector('a[href*="/status/' + ARRIVED + '/edit"]');
    if (!own) return;
    const m = own.getAttribute('href').match(/\/calendar\/appointment\/(\d+)\//);
    if (!canArrive(m ? eventOf(m[1]) : null)) return;
    const status = own.closest('li.dropdown-submenu');
    if (!status || !status.parentElement) return;
    const li = document.createElement('li');
    li.className = 'upc-arrived-li';
    const a = document.createElement('a');
    a.className = 'dropdown-item upc-arrived-item';
    a.href = '#';
    a.textContent = 'Arrived';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const $ = window.jQuery;
      if ($ && $.fn) $(own).trigger('click'); else own.click();
    });
    li.appendChild(a);
    status.parentElement.insertBefore(li, status);
  }

  // ------------------------------------------------------------------ sidebar

  function addToSidebar() {
    const panel = document.getElementById('RightHandPanel');
    if (!panel) return;
    const edit = panel.querySelector('a.editAppointment[data-appointmentid]');
    const rebook = panel.querySelector('button.rebook-appointment');
    const have = panel.querySelector('.upc-arrived-btn');
    const id = edit && edit.getAttribute('data-appointmentid');
    if (have && have.dataset.id === id) return;
    if (have) have.remove();
    if (!id || !rebook) return;
    const ev = eventOf(id);
    if (!ev || !ev.patientID || !canArrive(ev)) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-primary upc-arrived-btn';
    b.dataset.id = id;
    b.textContent = 'Arrived';
    b.style.marginRight = '8px';
    b.addEventListener('click', async () => {
      if (!U()) return;
      b.disabled = true;
      b.textContent = 'Marking...';
      try {
        const j = await U().http.json('/calendar/appointment/' + encodeURIComponent(id) + '/patient/' + encodeURIComponent(ev.patientID) + '/status/' + ARRIVED + '/edit');
        if (!j || (j.status !== 'OK' && j.status !== 'REFRESH')) throw new (U().Error)('Halaxy did not accept it.');
        b.textContent = 'Arrived';
        b.className = 'btn btn-outline-primary upc-arrived-btn';
      } catch (e) {
        b.disabled = false;
        b.textContent = 'Arrived';
        U().ui.toast('Not marked as arrived: ' + (e.message || e) + ' Use the right-click menu instead.', { kind: 'danger' });
      }
    });
    rebook.parentElement.insertBefore(b, rebook);
  }

  let queued = false;
  const scan = () => { queued = false; addToMenu(); addToSidebar(); };
  function start() {
    // The sidebar is drawn into the page; the right-click menu is shown by Halaxy on right-click.
    new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(scan); } }).observe(document.body, { childList: true, subtree: true });
    document.addEventListener('contextmenu', () => { setTimeout(addToMenu, 50); setTimeout(addToMenu, 300); }, true);
    scan();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

  window.upcArrivedButton = { version: VERSION, canArrive, isToday };
})();
