// ==UserScript==
// @name         Halaxy mobile layout (beta)
// @namespace    https://github.com/UrmstonPhysioClinic/upc-userscripts
// @version      2.18
// @homepageURL  https://github.com/UrmstonPhysioClinic/upc-userscripts
// @updateURL    https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/halaxy-mobile.user.js
// @downloadURL  https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/halaxy-mobile.user.js
// @description  Makes Halaxy usable on a phone: fitted layout on every page, slide-out menu, phone-sized calendar. Does nothing on screens wider than a phone (add ?hxm=1 to a Halaxy address to try it on a PC).
// @match        https://*.halaxy.com/a/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==
(function () {
  'use strict';

  // Phone-sized screens only, never inside iframes. Add ?hxm=1 to a Halaxy URL to force it on for testing.
  // 2.18: part of the clinic's script set (the loader), so it's on every device; it switches itself on only on phones.
  const IS_PHONE = Math.min(screen.width, screen.height) <= 600 || /[?&]hxm=1\b/.test(location.search);
  if (!IS_PHONE || window.top !== window.self || window.__hxMobile) return;
  window.__hxMobile = true;
  const VERSION = '2.18';

  const KEY = 'hxl.desktop';
  let wantDesktop = false;
  try { wantDesktop = sessionStorage.getItem(KEY) === '1'; } catch (e) { /* ignore */ }

  function setViewport(mobile) {
    let m = document.querySelector('meta[name="viewport"]');
    if (!m) {
      m = document.createElement('meta');
      m.name = 'viewport';
      (document.head || document.documentElement).appendChild(m);
    }
    m.content = mobile ? 'width=device-width, initial-scale=1' : 'width=980';
  }

  const css = `
  html.hxl, html.hxl body { overflow-x: hidden !important; max-width: 100vw; }
  html.hxl body { -webkit-text-size-adjust: 100%; }

  /* Main menu becomes a slide-out drawer */
  html.hxl #mainMenu { position: fixed !important; top: 0 !important; bottom: 0 !important; left: 0 !important; width: 270px !important;
    max-width: 85vw; z-index: 1036 !important; transform: translateX(-105%); transition: transform .22s ease; overflow-y: auto !important; }
  html.hxl.hxl-menu-open #mainMenu { transform: none; box-shadow: 0 0 40px rgba(0,0,0,.35); }
  html.hxl #mainMenu .mainmenu-menu { display: block; }
  html.hxl .layout-container { margin-left: 0 !important; padding-left: 0 !important; width: 100% !important; min-width: 0 !important; }
  html.hxl .layout-inner, html.hxl .layout-wrapper { min-width: 0 !important; width: 100% !important; }
  #hxl-scrim { position: fixed; inset: 0; background: rgba(10,10,30,.4); z-index: 1035; display: none; }
  html.hxl.hxl-menu-open #hxl-scrim { display: block; }

  /* Header: burger on the left, search fills the row, icons kept */
  html.hxl #headerWrapper { width: 100% !important; min-width: 0 !important; padding: 6px 8px 6px 56px !important; height: auto !important; position: relative; }
  html.hxl #headerWrapper > .row { flex-wrap: nowrap; align-items: center; }
  html.hxl #headerSearchContainer { min-width: 0; }
  html.hxl #headerSearchForm { flex-wrap: nowrap; margin: 0; }
  html.hxl #headerSearchForm .search-type-container { display: none !important; }
  html.hxl #headerSearchForm .magicEntity { margin-right: 6px !important; }
  html.hxl #headerSearchForm .me-Text { font-size: 16px !important; }
  html.hxl #headerWrapper .col-auto { flex: none; }
  html.hxl #user-select-user-name, html.hxl #practitioner-select .caret { display: none !important; }
  #hxl-burger { position: absolute; left: 8px; top: 50%; transform: translateY(-50%); width: 42px; height: 42px; border: 0; border-radius: 10px;
    background: transparent; display: grid; place-items: center; z-index: 2; color: inherit; padding: 0; }
  #hxl-burger:active { background: rgba(0,0,0,.08); }
  /* Header pop-ups (inbox, notifications, chat): above the calendar's pinned rows, fitted to the screen, just under the header */
  html.hxl #headerWrapper div.alertIconsContainer div.popover.alertPopoverContainer { z-index: 1030 !important; }
  html.hxl #headerWrapper div.alertIconsContainer div.alertPopover { position: fixed !important; top: var(--hxl-pop-top, 58px) !important; left: 8px !important; right: 8px !important;
    width: auto !important; min-width: 0 !important; max-width: none !important; transform: none !important; margin: 0 !important; }
  html.hxl #headerWrapper div.alertIconsContainer div.alertPopover > .arrow { display: none !important; }
  html.hxl #headerWrapper div.alertIconsContainer div.alertPopover div.alertPopoverInner div.teasers { max-height: calc(100vh - var(--hxl-pop-top, 58px) - 90px) !important; }
  html.hxl #headerWrapper div.alertIconsContainer div.alertPopover div.alertPopoverInner div.teasers div.viewTeaser,
  html.hxl #headerWrapper div.alertIconsContainer div.alertPopover div.alertPopoverInner div.teasers div.message { width: auto !important; max-width: 100%; overflow-wrap: anywhere; }
  #hxl-burger svg { width: 24px; height: 24px; }

  /* Page toolbar: patient tabs scroll sideways, buttons wrap */
  html.hxl #toolbar-wrapper, html.hxl #toolbar { width: 100% !important; min-width: 0 !important; height: auto !important; }
  html.hxl #toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 8px !important; text-align: left !important; }
  html.hxl #toolbar .page-title { display: none !important; }
  html.hxl #tabbedMenu { float: none !important; display: block !important; width: 100% !important; order: -1; }
  html.hxl #tabbedMenu .container-fluid { padding: 0 !important; }
  html.hxl #tabbedMenu .nav-tabs { flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
  html.hxl #tabbedMenu .nav-tabs::-webkit-scrollbar { display: none; }
  html.hxl #tabbedMenu .nav-link { white-space: nowrap; padding: 8px 12px !important; }
  html.hxl #toolbar-text, html.hxl #toolbar-right { display: flex !important; gap: 6px; align-items: center; margin: 0 !important; }
  html.hxl #toolbar-right { margin-left: auto !important; }
  html.hxl #toolbar .btn { white-space: nowrap; }
  html.hxl #toolbar .context-help { display: none !important; }
  /* White page bar: no empty tabs row, everything vertically centred */
  html.hxl #tabbedMenu:not(:has(.nav-link)) { display: none !important; }
  html.hxl #toolbar-wrapper { padding-top: 6px !important; padding-bottom: 6px !important; height: auto !important; min-height: 0 !important; display: flex; align-items: center; }
  html.hxl #toolbar { align-items: center !important; }
  html.hxl #toolbar-icons { padding-top: 0 !important; display: flex !important; align-items: center; }
  html.hxl #toolbar-icons .btn-group, html.hxl #toolbar-icons .btn { display: inline-flex; align-items: center; }

  /* Page body */
  html.hxl #pageContent, html.hxl .overall-content-container, html.hxl #frame { width: 100% !important; min-width: 0 !important; padding-left: 0 !important; padding-right: 0 !important; }
  html.hxl #clinical-wrap { padding: 6px !important; }
  html.hxl #clinical-wrap > .row { margin: 0 !important; flex-direction: column !important; height: auto !important; }
  html.hxl #clinical-left-hand-menu, html.hxl #card-patient-clinical { flex: none !important; max-width: 100% !important; width: 100% !important; padding: 0 !important; }
  /* The note list scrolls in its own box (Halaxy draws it into a fixed-height box); it shrinks away when closed with its menu button */
  html.hxl #clinical-left-hand-menu { height: auto !important; max-height: none !important; overflow: visible !important; margin-bottom: 8px; }
  html.hxl #clinical-left-hand-menu #clinicalNoteMenu { height: 50vh !important; }
  html.hxl #clinical-left-hand-menu #lhs-menu-body { max-height: none !important; }
  html.hxl #clinical-left-hand-menu:not(:has(.hamburger-active)) #clinicalNoteMenu { height: auto !important; }
  html.hxl #clinical-left-hand-menu.hxl-collapsed { max-height: none; }
  html.hxl #clinical-left-hand-menu.hxl-collapsed #lhs-menu-body { display: none !important; }
  html.hxl #card-patient-clinical > .card > .card-body { padding: 8px !important; }
  html.hxl .patient-clinic-note.d-flex { flex-direction: column; flex-wrap: nowrap !important; }
  html.hxl .patient-clinic-note.d-flex > * { width: 100% !important; max-width: 100% !important; min-width: 0 !important; flex: none !important; }
  html.hxl #viewer { width: 100% !important; max-width: 100% !important; }

  /* Note header and details: stack the two-column rows */
  html.hxl #card-note-ajax-view-note > .card-header .row > [class*="col-"] { flex: 0 0 100%; max-width: 100%; }
  html.hxl #card-note-ajax-view-note > .card-header .float-right { float: none !important; display: flex; justify-content: flex-end; }
  html.hxl #card-note-ajax-view-note > .card-body > .row > .col-6 { flex: 0 0 100%; max-width: 100%; }
  html.hxl #card-note-ajax-view-note .viewData.col-8 { flex: 0 0 100%; max-width: 100%; }
  html.hxl #card-note-ajax-view-note .viewRow.float-right { float: none !important; }
  html.hxl #note-version-dropdown, html.hxl #note-version-dropdown-menu, html.hxl #btn-general-actions-menu { max-width: calc(100vw - 16px); }
  html.hxl #note-version-dropdown .dropdown-item { white-space: normal; }

  /* Editor: full width, comfortable typing size, toolbar wraps instead of hiding */
  html.hxl .cke-two-row, html.hxl #editor, html.hxl .ck.ck-editor { width: 100% !important; max-width: 100% !important; min-width: 0 !important; }
  html.hxl .ck.ck-editor__main > .ck-editor__editable { font-size: 16px !important; padding: 0 10px !important; min-height: 40vh;
    height: auto !important; max-height: none !important; overflow: visible !important; }
  html.hxl .ck.ck-editor__main, html.hxl .cke-two-row, html.hxl #viewer, html.hxl #viewer > .card, html.hxl #card-patient-clinical > .card,
  html.hxl #clinical-wrap .full-height-page-content { height: auto !important; max-height: none !important; }
  html.hxl .ck.ck-toolbar { max-width: 100%; }
  html.hxl .ck.ck-toolbar:not(.ck-toolbar_grouping) > .ck-toolbar__items { flex-wrap: wrap; }
  html.hxl .ck.ck-sticky-panel__content_sticky { max-width: 100vw !important; left: 0 !important; width: 100% !important; }
  html.hxl .ck-content figure.table { max-width: 100% !important; overflow-x: auto; overflow-y: hidden; display: block; margin: 8px 0 !important; }
  html.hxl .ck-content figure.table table { min-width: 100%; }
  html.hxl .ck-content figure.image, html.hxl .ck-content img { max-width: 100% !important; height: auto !important; }
  html.hxl .hx-summary-container .chosen-container { max-width: 100%; }

  /* Right-hand side bar (patient details, history etc.) goes below the note */
  html.hxl hx-clinical-note-sticky-wrapper, html.hxl #clinical-note-side-bar { position: static !important; width: 100% !important; max-width: 100% !important; height: auto !important; }
  html.hxl #clinical-note-side-bar #sidebar-content { width: 100% !important; }
  html.hxl #clinical-note-side-bar #sidebar-tab-content { width: 100% !important; max-height: none !important; }

  /* ---------- Calendar page ---------- */
  html.hxl body.calendar #WRAP { padding: 0 !important; }
  html.hxl body.calendar #calToolbar .TopMenu { flex-wrap: wrap; margin: 0 !important; }
  html.hxl body.calendar #calToolbar .DayMenu,
  html.hxl body.calendar #calToolbar .TopMenu > .col-5 { flex: 0 0 100% !important; max-width: 100% !important; padding: 0 6px !important; }
  html.hxl body.calendar #calToolbar .DayMenu > .row { margin: 0 !important; align-items: center; }
  html.hxl body.calendar #calToolbar .DayMenu > .row > [class*="col"] { flex: 0 0 auto; max-width: 100%; width: auto; padding: 4px 4px 0 0 !important; }
  html.hxl body.calendar #calToolbar .TopMenu > .col-5 > .row { justify-content: flex-start !important; margin: 0 !important; flex-wrap: nowrap; align-items: center; }
  html.hxl body.calendar #calToolbar .TopMenu > .col-5 > .row > [class*="col"] { flex: 0 1 auto !important; max-width: none; padding: 4px 4px 0 0 !important; text-align: left !important; }
  html.hxl body.calendar #calToolbar .DateLabel { text-align: left !important; font-weight: 600; white-space: nowrap; }
  html.hxl body.calendar #calToolbar .btn-group.ml-2 { margin-left: 0 !important; margin-right: 6px; }
  html.hxl body.calendar #activeLocation, html.hxl body.calendar #btn-swap-prac { max-width: 40vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  html.hxl body.calendar #calToolbar { position: relative; z-index: 60; } /* above the grid (appointments 20, names row 50), below every Halaxy overlay (100+) */
  /* When pinned, the controls' background (and shadow) runs edge to edge across the screen */
  html.hxl body.calendar #calToolbar.hxl-pinned::before { content: ""; position: absolute; top: 0; bottom: 0; z-index: -1;
    left: var(--hxl-tb-left, 0px); right: var(--hxl-tb-right, 0px); bottom: calc(-1 * var(--hxl-tb-gap, 0px));
    background: inherit; box-shadow: 0 2px 6px rgba(0,0,0,.15); pointer-events: none; }
  html.hxl body.calendar #calToolbar .dropdown-menu { max-width: calc(100vw - 16px); max-height: 70vh; overflow-y: auto; z-index: 2000; }
  html.hxl body.calendar #calToolbar .btn { min-height: 32px; font-size: 12px !important; padding: 4px 8px !important; letter-spacing: .02em; }
  html.hxl body.calendar #calToolbar .btn-Zoom, html.hxl body.calendar #calToolbar .btn.icon { padding: 2px 4px !important; }
  /* One vertical scroll: the page scrolls, not a box inside it */
  html.hxl body.calendar #WRAP, html.hxl body.calendar .cal { height: auto !important; }
  html.hxl body.calendar #calendarViewPort { height: auto !important; overflow: visible !important; }
  /* On phones Halaxy's date picker swaps in the phone's own date box; make it an invisible tap area over the calendar icon */
  html.hxl body.calendar #btn-calendar-date-select { position: relative !important; display: inline-flex !important; align-items: center; min-width: 36px; }
  html.hxl body.calendar #calToolbar input.flatpickr-mobile { position: absolute !important; top: 0 !important; left: 0 !important; width: 100% !important; height: 100% !important;
    opacity: 0 !important; margin: 0 !important; padding: 0 !important; border: 0 !important; font-size: 16px !important; z-index: 2; }
  /* The date picker's text box is meant to be invisible (Halaxy relies on 0-size text, which phones with a minimum text size ignore) */
  html.hxl body.calendar #DP { color: transparent !important; text-shadow: none !important; caret-color: transparent; }
  html.hxl body.calendar #calToolbar .calMenu.d-block { display: inline-flex !important; vertical-align: middle; position: relative; margin-right: 4px; }
  /* Row 1: Today, This week, view. Row 2: previous/next under Today, then date picker icon, date and spinner */
  html.hxl body.calendar #calToolbar .DayMenu > .row > div:first-child { display: grid !important; grid-template-columns: auto auto auto auto;
    column-gap: 6px; row-gap: 6px; align-items: center; justify-content: start; }
  html.hxl body.calendar #calToolbar .DayMenu > .row > div:first-child > * { margin: 0 !important; }
  html.hxl body.calendar #calToolbar .DayMenu > .row > div:first-child > .d-lg-none:not(.calMenu) { grid-column: 1; grid-row: 2; }
  html.hxl body.calendar #calToolbar .DayMenu > .row > div:first-child > .hxl-datebox { grid-column: 2 / span 3; grid-row: 2; display: flex !important;
    align-items: center; gap: 6px; padding: 0 !important; min-width: 0; max-width: none; flex: none !important; white-space: nowrap; }
  html.hxl body.calendar #calToolbar .hxl-datebox > .calMenu.d-block { margin: 0 !important; flex: none; }
  html.hxl body.calendar #calToolbar .hxl-datebox #btn-calendar-date-select { height: 32px; padding: 0 !important; justify-content: center; }
  html.hxl body.calendar #calToolbar .hxl-datebox .DateLabel { width: auto !important; text-align: left !important; margin: 0 !important; padding: 0 !important; }
  /* Halaxy's spinner is a 130px image shrunk to 15% with desktop offsets; give it a fixed 20px slot after the date and centre it there.
     The slot is kept while nothing is loading so the date doesn't jump. */
  html.hxl body.calendar #calToolbar .hxl-datebox .loading { position: relative !important; display: block !important; flex: none;
    width: 20px; height: 20px; margin: 0 !important; top: 0 !important; left: 0 !important; overflow: visible; order: 2; }
  html.hxl body.calendar #calToolbar .hxl-datebox .loading.d-none { visibility: hidden; }
  html.hxl body.calendar #calToolbar .hxl-datebox #loadingPositiveVersionInsideRescaleSmlCalendar { position: absolute !important;
    left: 10px !important; top: 10px !important; width: 0 !important; height: 0 !important; margin: 0 !important; transform: scale(.15); transform-origin: 0 0; }
  html.hxl body.calendar #calToolbar .hxl-datebox #loadingPositiveVersionInside { position: absolute !important; left: 0 !important; top: 0 !important;
    margin: -65px 0 0 -65px !important; }
  /* Zoom and waiting-list buttons line up with Today on the first row */
  html.hxl body.calendar #calToolbar .DayMenu > .row { align-items: flex-start !important; }
  html.hxl body.calendar #calToolbar .DayMenu > .row > div:nth-child(2) { display: flex !important; align-items: center; gap: 2px; }
  html.hxl body.calendar #calToolbar .DayMenu > .row > div:nth-child(2) > .calMenu { display: inline-flex !important; align-items: center; margin: 0 !important; }
  html.hxl body.calendar #calToolbar .DayMenu > .row > div:nth-child(2) .btn { height: 32px; min-height: 32px; display: inline-flex !important; align-items: center; margin: 0 !important; }
  html.hxl body.calendar #calToolbar .DayMenu > .row > div:nth-child(2) .btn i { display: block; line-height: 1 !important; margin: 0 !important; }
  /* The waiting-list glyph sits low in its icon box (and the magnifiers slightly), so nudge them to look centred */
  html.hxl body.calendar #btn-calendar-waiting-list i { transform: translateY(-2px); }
  html.hxl body.calendar .btn-Zoom i { transform: translateY(-1px); }
  html.hxl body.calendar #calToolbar .DayMenu > .row > div:first-child .prevNextBtnGroup { margin: 0 !important; }
  html.hxl body.calendar #calToolbar .DayMenu .calMenu > .btn, html.hxl body.calendar #calToolbar .DayMenu .calMenu .dropdown > .btn { margin-left: 0 !important; margin-right: 0 !important; }
  /* Date label on its own line, location and practitioner filters side by side */
  html.hxl body.calendar #calToolbar .TopMenu > .col-5 > .row { flex-wrap: wrap !important; }
  html.hxl body.calendar #calToolbar .TopMenu > .col-5 > .row > .col:first-child { flex: 0 0 100% !important; }
  html.hxl body.calendar #calToolbar .TopMenu > .col-5 > .row > .col:last-child { flex: 0 0 100% !important; display: flex !important; gap: 6px; padding-top: 4px !important; }
  html.hxl body.calendar #calToolbar .TopMenu > .col-5 > .row > .col:last-child > * { flex: 1 1 0; min-width: 0; margin: 0 !important; }
  html.hxl body.calendar #calToolbar .TopMenu > .col-5 > .row > .col:last-child .btn-group { width: 100%; }
  html.hxl body.calendar #activeLocation, html.hxl body.calendar #btn-swap-prac { width: 100%; max-width: none; }
  html.hxl body.calendar #toolbar { padding: 2px 8px !important; min-height: 0 !important; }
  /* Appointment blocks: smaller text so names fit; zoom in (magnifier +) for taller blocks */
  html.hxl body.calendar .event { font-size: 12px !important; line-height: 1.25 !important; }
  html.hxl body.calendar .event .e-time { font-size: 11px !important; padding: 0 3px !important; margin: 1px !important; }
  html.hxl body.calendar .colHead, html.hxl body.calendar .colHeadDate { font-size: 13px !important; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Keep the name clear of the three-dot menu Halaxy pins to the right of each header cell; long names end in ... before it */
  html.hxl body.calendar .colHeadRow > .colTab:has(> .calendarDayConfigOptionsDropDown) .colHeadDate { padding: 0 20px 0 4px !important; box-sizing: border-box; }
  /* Several practitioners or days: give each column a readable width and scroll the grid sideways, toolbar stays put */
  html.hxl.hxl-widecal body.calendar #pageContent { overflow-x: auto !important; overflow-y: hidden !important; -webkit-overflow-scrolling: touch; padding-left: 0 !important; padding-right: 0 !important; }
  html.hxl.hxl-widecal body.calendar #WRAP { overflow: visible !important; }
  html.hxl.hxl-widecal body.calendar #calToolbar { position: sticky; left: 0; width: 100vw !important; max-width: 100vw; z-index: 60; }
  /* Appointment panel (new / edit / view) opens full screen instead of beside the grid */
  html.hxl body.calendar #RightHandPanel { position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important;
    width: 100% !important; max-width: 100% !important; height: 100% !important; margin: 0 !important; border-radius: 0 !important;
    z-index: 1040 !important; overflow-y: auto !important; -webkit-overflow-scrolling: touch; }
  html.hxl body.calendar #RightHandPanelHeader { position: sticky; top: 0; z-index: 2; background: var(--vs-card-header-bg-color, #f7f7fb); }
  html.hxl body.calendar #RightHandPanelFooter { position: sticky; bottom: 0; z-index: 2; background: var(--vs-card-bg-color, #fff); border-top: 1px solid rgba(0,0,0,.1); }
  html.hxl body.calendar #RHI { width: 100% !important; max-width: 100% !important; max-height: none !important; height: auto !important; overflow: visible !important; }
  html.hxl body.calendar #RHI .controls, html.hxl body.calendar #RHI .content, html.hxl body.calendar #RHI form,
  html.hxl body.calendar #RHI .row, html.hxl body.calendar #RHI table { max-width: 100% !important; }
  html.hxl body.calendar #RHI .controls { width: auto !important; }
  html.hxl body.calendar #RightHandPanel .RHPClose { left: auto !important; right: 8px !important; }
  html.hxl body.calendar #RHI input, html.hxl body.calendar #RHI select, html.hxl body.calendar #RHI textarea { font-size: 16px !important; }

  /* ---------- Any page ---------- */
  /* Side-by-side columns holding cards or sections are stacked by the script (see stackRows) */
  html.hxl .row.hxl-stack { flex-wrap: wrap !important; }
  html.hxl .row.hxl-stack > [class*="col"] { flex: 0 0 100% !important; max-width: 100% !important; width: 100% !important; }
  /* Once stacked, a column that had its inner padding removed for the side-by-side layout gets it back, so cards line up */
  html.hxl .row.hxl-stack:not(.no-gutters) > .pl-0 { padding-left: 15px !important; }
  html.hxl .row.hxl-stack:not(.no-gutters) > .pr-0 { padding-right: 15px !important; }
  /* Wide tables scroll sideways inside their box instead of widening the page */
  html.hxl .hxl-xscroll { overflow-x: auto !important; overflow-y: hidden !important; -webkit-overflow-scrolling: touch; max-width: 100%; }
  html.hxl textarea.hxl-grow { overflow-y: hidden; resize: none; }
  html.hxl #pageContent img { max-width: 100%; height: auto; }
  html.hxl #pageContent .card { min-width: 0; }
  /* Same left and right edge for every card (some Halaxy cards add their own side margins on small screens) */
  html.hxl #pageContent .card.mx-3 { margin-left: 0 !important; margin-right: 0 !important; }
  html.hxl #pageContent { padding: 0 4px !important; }

  /* Halaxy lists (patients, appointments, tasks...): search on its own row, size controls side by side */
  html.hxl .ag-grid-quick-filter-and-controls-wrapper { display: flex !important; flex-wrap: wrap !important; gap: 6px; align-items: center; padding: 6px 2px !important; }
  html.hxl .ag-grid-quick-filter-and-controls-wrapper > * { margin: 0 !important; float: none !important; }
  html.hxl .ag-grid-quick-filter-and-controls-wrapper .has-search { flex: 1 1 100% !important; width: 100% !important; }
  html.hxl .ag-grid-quick-filter-and-controls-wrapper .has-search input { width: 100% !important; font-size: 16px !important; }
  html.hxl .ag-grid-quick-filter-and-controls-wrapper .size-controls { flex: 1 1 40% !important; width: auto !important; min-width: 0 !important; flex-wrap: nowrap; }
  html.hxl .ag-grid-quick-filter-and-controls-wrapper .size-controls .input-group-text { font-size: 12px; padding: 4px 6px; }
  html.hxl .ag-grid-quick-filter-and-controls-wrapper .size-controls select,
  html.hxl .ag-grid-quick-filter-and-controls-wrapper .size-controls .chosen-container { min-width: 0 !important; width: auto !important; flex: 1 1 auto; max-width: 100%; }
  html.hxl .ag-root-wrapper { max-width: 100%; }
  html.hxl .hxl-proxied select.layout-controller, html.hxl .hxl-proxied .chosen-container, html.hxl .hxl-proxied .input-group-prepend { display: none !important; }
  html.hxl .hxl-layout { display: flex; gap: 6px; width: 100%; }
  html.hxl .hxl-layout label { flex: 1 1 0; min-width: 0; margin: 0; display: flex; align-items: center; border: 1px solid #ced4da; border-radius: 4px; background: #fff; overflow: hidden; }
  html.hxl .hxl-layout label span { padding: 0 6px; font-size: 12px; color: #555; background: #e9ecef; align-self: stretch; display: flex; align-items: center; }
  html.hxl .hxl-layout select { flex: 1 1 auto; min-width: 0; border: 0; background: transparent; font-size: 14px; height: 36px; padding: 0 4px; }
  html.hxl .ag-grid-quick-filter-and-controls-wrapper .layout-controls { flex: 1 1 100% !important; }

  /* Halaxy's own pop-ups fit the screen */
  html.hxl .modal-dialog { max-width: calc(100vw - 16px) !important; margin: 8px auto !important; }
  html.hxl .modal-body { overflow-x: auto; }
  html.hxl #footer { display: none !important; }

  /* Switch layouts: inside the drawer in mobile layout, floating button in desktop layout */
  #hxl-toggle { display: block; width: calc(100% - 24px); margin: 12px; border: 1px solid rgba(255,255,255,.5); border-radius: 10px; padding: 12px;
    font: 600 15px/1 system-ui, sans-serif; background: transparent; color: #fff; letter-spacing: 0; text-transform: none; text-align: center; }
  #hxl-pill { display: none; position: fixed; right: 24px; bottom: 24px; z-index: 1040; border: 0; border-radius: 999px; padding: 24px 32px;
    font: 600 34px/1 system-ui, sans-serif; background: #0e0793; color: #fff; box-shadow: 0 6px 24px rgba(0,0,0,.35); letter-spacing: 0; text-transform: none; }
  html:not(.hxl) #hxl-pill { display: block; }
  html:not(.hxl) #hxl-toggle { display: none; }
  `;

  function addStyle() {
    const s = document.createElement('style');
    s.id = 'hxl-style';
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  function apply(mobile) {
    setViewport(mobile);
    document.documentElement.classList.toggle('hxl', mobile);
    document.documentElement.classList.remove('hxl-menu-open');
    try { sessionStorage.setItem(KEY, mobile ? '0' : '1'); } catch (e) { /* ignore */ }
    if (mobile) { lastCalMin = null; scheduleFixes(); }
    else { const w = document.getElementById('WRAP'); if (w) w.style.minWidth = ''; document.documentElement.classList.remove('hxl-widecal'); lastCalMin = null; pinTimeColumn(); placeCalendarDate(false); }
    window.dispatchEvent(new CustomEvent('hxm:mode', { detail: { mobile } }));
    // Let Halaxy's components and the editor recalculate their sizes
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
  }

  // ---------- page fixes that need measuring ----------
  const SKIP = '#calToolbar, #WRAP, #headerWrapper, #mainMenu, #toolbar, .ag-root-wrapper, .ck-editor, .ck-content, .dropdown-menu, table, #hxm, .chosen-container, .modal-footer, .input-group';
  const BLOCK = '.card, table, .row, h1, h2, h3, form, .ag-root-wrapper, .list-group, .viewRow, .view-row, .table';
  const PLAIN_COL = /(^|\s)col(-\d{1,2}|-auto)?(\s|$)/;
  // Plain "col-N" columns stay side by side at any width; stack the ones that hold whole sections and have become too narrow.
  function stackRows() {
    document.querySelectorAll('#pageContent .row:not(.hxl-stack), .modal-body .row:not(.hxl-stack)').forEach(row => {
      if (row.closest(SKIP)) return;
      const cols = [...row.children].filter(c => PLAIN_COL.test(c.className));
      if (cols.length < 2) return;
      const cramped = cols.some(c => c.querySelector(BLOCK) && c.getBoundingClientRect().width < 260);
      if (cramped) row.classList.add('hxl-stack');
    });
  }
  // Tables wider than their box scroll sideways in place
  function scrollTables() {
    document.querySelectorAll('#pageContent table, .modal-body table').forEach(t => {
      if (t.closest('.ag-root-wrapper, .ck-editor, .ck-content, #WRAP')) return;
      const box = t.parentElement;
      if (!box || box.classList.contains('hxl-xscroll')) return;
      if (t.scrollWidth > box.clientWidth + 4) box.classList.add('hxl-xscroll');
    });
  }
  // Calendar: when several practitioners (or days) share the screen, widen the grid so each column stays readable.
  // Halaxy sizes its columns from the width of #WRAP whenever the window resizes, so we set a minimum width and let it redo the maths.
  const MIN_COL = 120, MIN_SUB = 95, TIME_COL = 60;
  let lastCalMin = null;
  function fitCalendarColumns() {
    const wrap = document.getElementById('WRAP');
    if (!wrap || !document.body.classList.contains('calendar')) return;
    const cols = document.querySelectorAll('.colHeadRow > .colTab:not(.colTab-G)').length;
    // Week view with several practitioners splits each day into one narrow column per practitioner
    const firstDay = document.querySelector('#grid > .colTab:not(.colTab-G)');
    const subs = firstDay ? firstDay.querySelectorAll(':scope > .eventsCol').length : 0;
    const perCol = subs > 1 ? Math.max(MIN_COL, subs * MIN_SUB) : MIN_COL;
    const need = TIME_COL + cols * perCol;
    const avail = document.documentElement.clientWidth - 8;
    const min = cols > 1 && need > avail ? need : 0;
    if (min === lastCalMin) return;
    lastCalMin = min;
    wrap.style.minWidth = min ? min + 'px' : '';
    document.documentElement.classList.toggle('hxl-widecal', !!min);
    setTimeout(() => { window.dispatchEvent(new Event('resize')); pinTimeColumn(); }, 0);
    const pc = document.getElementById('pageContent');
    if (pc && !pc.dataset.hxlPin) { pc.dataset.hxlPin = '1'; pc.addEventListener('scroll', pinTimeColumn, { passive: true }); }
  }
  // Keep the practitioner (or day) name row at the top of the screen once it has been scrolled past.
  // CSS "sticky" can't do this because the calendar sits in a sideways-scrolling box, so the row is moved with the scroll.
  let headTicking = false;
  // The calendar controls hide while you scroll down and slide back in (pinned above the name row) when you scroll up.
  let reveal = 0, revealTarget = 0, lastRef = null, accUp = 0, accDown = 0, revealAnim = null, tbBgColour = null;
  const REVEAL_AFTER = 12, REVEAL_MS = 180;
  function animateReveal() {
    if (revealAnim) return;
    let last = performance.now();
    const step = (now) => {
      const dt = now - last; last = now;
      const dir = Math.sign(revealTarget - reveal);
      reveal = dir > 0 ? Math.min(revealTarget, reveal + dt / REVEAL_MS) : Math.max(revealTarget, reveal - dt / REVEAL_MS);
      layoutCalSticky();
      revealAnim = reveal !== revealTarget ? requestAnimationFrame(step) : null;
    };
    revealAnim = requestAnimationFrame(step);
  }
  function pageBg(el) {
    for (let e = el.parentElement; e; e = e.parentElement) {
      const c = getComputedStyle(e).backgroundColor;
      if (c && c !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(c)) return c;
    }
    return '#fff';
  }
  function stickCalHeader() {
    headTicking = false;
    const wrap = document.getElementById('WRAP'), tb = document.getElementById('calToolbar');
    if (!wrap) return;
    if (!document.documentElement.classList.contains('hxl')) { layoutCalSticky(); return; }
    // Which way is the page moving? (works whichever box is doing the scrolling)
    const ref = wrap.getBoundingClientRect().top;
    if (lastRef !== null && ref !== lastRef) {
      const d = ref - lastRef;
      if (d > 0) { accUp += d; accDown = 0; } else { accDown -= d; accUp = 0; }
    }
    lastRef = ref;
    if (tb) {
      const tbNatural = tb.getBoundingClientRect().top - Number(tb.dataset.hxlY || 0);
      let target = revealTarget;
      if (tbNatural >= 0) { target = 0; reveal = 0; }          // back at the top: controls sit in their normal place
      else if (accUp > REVEAL_AFTER) target = 1;              // scrolling up: bring the controls in
      else if (accDown > REVEAL_AFTER) target = 0;            // scrolling down: tuck them away
      if (target !== revealTarget) { revealTarget = target; animateReveal(); }
    }
    layoutCalSticky();
  }
  function layoutCalSticky() {
    const row = document.querySelector('#WRAP .colHeadRow');
    const cal = document.querySelector('#WRAP .cal');
    const tb = document.getElementById('calToolbar');
    const on = document.documentElement.classList.contains('hxl');
    // Controls
    let tbBottom = 0;
    if (tb) {
      const cur = Number(tb.dataset.hxlY || 0);
      const natural = tb.getBoundingClientRect().top - cur;
      const h = tb.offsetHeight;
      // Smoothly between "where it naturally is" and "pinned at the top of the screen"
      const visualTop = on ? Math.max(natural, -(1 - reveal) * h) : natural;
      const y = Math.round(visualTop - natural);
      if (y !== cur) {
        tb.dataset.hxlY = String(y);
        tb.style.transform = y ? `translateY(${y}px)` : '';
        tb.classList.toggle('hxl-pinned', !!y && reveal > 0);
        if (y && !tbBgColour) tbBgColour = pageBg(tb);
        tb.style.backgroundColor = y && reveal > 0 ? tbBgColour : '';
      }
      if (y) {
        // Stretch the background to the screen edges only where the page has side margins. In the sideways-scrolling
        // calendar the controls are already exactly screen width, and stretching would make the page scroll further.
        const wide = document.documentElement.classList.contains('hxl-widecal');
        const r = tb.getBoundingClientRect();
        tb.style.setProperty('--hxl-tb-left', wide ? '0px' : Math.min(0, -r.left) + 'px');
        tb.style.setProperty('--hxl-tb-right', wide ? '0px' : Math.min(0, r.right - document.documentElement.clientWidth) + 'px');
      }
      // keep the same gap under the controls as at the top of the page (it's the box's bottom margin, so not part of its height)
      const gap = parseFloat(getComputedStyle(tb).marginBottom) || 0;
      tb.style.setProperty('--hxl-tb-gap', gap + 'px');
      tbBottom = Math.max(0, visualTop + h + (visualTop + h > 0 ? gap : 0));
    }
    // Name row: stays just below the controls (or at the very top when they're tucked away)
    if (!row || !cal) return;
    const current = Number(row.dataset.hxlY || 0);
    const naturalTop = row.getBoundingClientRect().top - current;
    const maxShift = cal.getBoundingClientRect().bottom - current - row.offsetHeight - naturalTop;
    const y = Math.max(0, Math.min(tbBottom - naturalTop, maxShift));
    // While the name row is pinned, the blank corner above the times must be as tall as the name cells
    // (names + all-day events strip), or time labels show through underneath it. Left alone otherwise.
    const corner = row.querySelector(':scope > .colTab-G');
    if (corner) {
      const tall = Math.max(0, ...[...row.querySelectorAll(':scope > .colTab:not(.colTab-G)')].map(c => c.offsetHeight));
      const want = on && y && tall ? tall + 'px' : '';
      if (corner.style.height !== want) {
        corner.style.height = want;
        const inner = corner.querySelector('.colHead');
        if (inner) inner.style.height = want;
      }
    }
    if (!on) { row.style.transform = ''; row.style.zIndex = ''; row.style.boxShadow = ''; row.dataset.hxlY = '0'; return; }
    if (y !== current) {
      row.dataset.hxlY = String(y);
      row.style.transform = y ? `translateY(${y}px)` : '';
      row.style.zIndex = y ? '55' : '';
      row.style.boxShadow = y ? '0 2px 6px rgba(0,0,0,.15)' : '';
    }
  }
  function onCalScroll() {
    if (headTicking) return;
    headTicking = true;
    requestAnimationFrame(stickCalHeader);
  }

  // Halaxy leaves ~20px spare on the right of the grid for a scrollbar the calendar no longer has. Share it out between the columns.
  function fillCalendarGap() {
    const wrap = document.getElementById('WRAP');
    if (!wrap || !document.body.classList.contains('calendar')) return;
    const sets = ['.colHeadRow > .colTab', '#grid > .colTab'].map(sel =>
      [...wrap.querySelectorAll(sel)].filter(c => !c.classList.contains('colTab-G') && c.style.width && c.style.left));
    const cols = sets[1].length ? sets[1] : sets[0];
    if (!cols.length) return;
    const idx = (c) => Number((c.className.match(/colTab-(\d+)/) || [])[1]);
    const right = (c) => parseFloat(c.style.left) + parseFloat(c.style.width);
    const last = cols.filter(c => isFinite(idx(c)) && c.offsetWidth > 0).sort((a, b) => right(b) - right(a))[0];
    if (!last) return;
    // measured on screen, because the columns sit inside a box that is itself offset slightly within #WRAP
    const extra = Math.floor(wrap.getBoundingClientRect().right - last.getBoundingClientRect().right);
    if (extra < 1 || extra > 60) return; // nothing to do, or not Halaxy's usual spacing
    const each = extra / (idx(last) + 1);
    sets.forEach(set => {
      set.forEach(c => {
        const i = Number((c.className.match(/colTab-(\d+)/) || [])[1]);
        if (!isFinite(i)) return;
        c.style.width = (parseFloat(c.style.width) + each) + 'px';
        c.style.left = (parseFloat(c.style.left) + i * each) + 'px';
      });
    });
    const line = wrap.querySelector('.timeline');
    if (line && line.style.width) line.style.width = (parseFloat(line.style.width) + extra) + 'px';
  }

  // Keep the times column visible while the grid scrolls sideways
  function pinTimeColumn() {
    const pc = document.getElementById('pageContent');
    const x = document.documentElement.classList.contains('hxl-widecal') && pc ? pc.scrollLeft : 0;
    document.querySelectorAll('#WRAP .colTab-G').forEach(el => {
      el.style.transform = x ? `translateX(${x}px)` : '';
      el.style.zIndex = x ? (el.closest('.colHeadRow') ? '32' : '30') : '';
      el.style.boxShadow = x ? '-8px 0 0 #fff, 2px 0 4px rgba(0,0,0,.08)' : '';
    });
  }

  // Lists: make each Halaxy data grid fill the screen below its controls, so the page itself doesn't also scroll
  function fitGrids() {
    const boxes = [...document.querySelectorAll('#pageContent .ag-root-wrapper')].filter(w => !w.closest('.modal')).map(w => w.closest('[class*="ag-theme-"]') || w.parentElement).filter(Boolean);
    if (boxes.length !== 1) return; // pages with several lists keep Halaxy's own sizing
    const box = boxes[0];
    const setH = (h) => { h = Math.max(320, Math.round(h)); if (box.dataset.hxlH !== String(h)) { box.dataset.hxlH = String(h); box.style.setProperty('height', h + 'px', 'important'); } return h; };
    const top = box.getBoundingClientRect().top + window.scrollY;
    let h = setH(window.innerHeight - top - 4);
    // Anything below the list (padding, pager margins) would make the page scroll too; take that off the list's height
    const scroller = document.getElementById('frame');
    const extra = Math.max(document.documentElement.scrollHeight - window.innerHeight,
      scroller && scroller.scrollHeight > scroller.clientHeight + 2 ? scroller.scrollHeight - scroller.clientHeight : 0);
    if (extra > 0) setH(h - extra);
  }

  // Lists: Halaxy's "Layout" control is a tall multi-pick box on phones. Show it as two small drop-downs
  // (Columns, Rows) that drive Halaxy's own control, and switch columns to "Auto fit" once so they aren't squashed.
  function setupListLayout() {
    document.querySelectorAll('select.layout-controller').forEach(orig => {
      const group = orig.closest('.layout-controls') || orig.parentElement;
      if (!group) return;
      const opt = (g) => [...orig.options].filter(o => (o.dataset.group || (Number(o.value) <= 3 ? 'width' : 'row')) === g);
      const current = (g) => (opt(g).find(o => o.selected) || {}).value || '';
      let proxy = group.querySelector('.hxl-layout');
      if (!proxy) {
        proxy = document.createElement('div');
        proxy.className = 'hxl-layout';
        const mk = (g, label) => `<label><span>${label}</span><select data-g="${g}">${opt(g).map(o => `<option value="${o.value}">${o.textContent.trim()}</option>`).join('')}</select></label>`;
        proxy.innerHTML = mk('width', 'Columns') + mk('row', 'Rows');
        group.appendChild(proxy);
        group.classList.add('hxl-proxied');
        proxy.addEventListener('change', (e) => {
          const g = e.target.dataset.g;
          const keep = g === 'width' ? current('row') : current('width');
          [...orig.options].forEach(o => { o.selected = o.value === e.target.value || o.value === keep; });
          orig.dispatchEvent(new Event('change', { bubbles: true }));
        });
      }
      // keep the drop-downs showing what Halaxy has selected
      proxy.querySelectorAll('select').forEach(sel => { const v = current(sel.dataset.g); if (v && sel.value !== v) sel.value = v; });

      // One-off: change Halaxy's default "Distribute equally" to "Auto fit" for this list (remembered on this phone only)
      if (!orig.dataset.hxlFit && document.querySelector('.ag-root-wrapper .ag-row')) {
        orig.dataset.hxlFit = '1';
        const key = 'hxl.autofit:' + location.pathname.replace(/\d+/g, '#');
        let done = true;
        try { done = !!localStorage.getItem(key); if (!done) localStorage.setItem(key, '1'); } catch (e) { /* ignore */ }
        if (!done && current('width') === '1' && opt('width').some(o => o.value === '2')) {
          const sel = proxy.querySelector('select[data-g="width"]');
          sel.value = '2';
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    });
  }

  // Text boxes grow with what's typed instead of scrolling inside the page
  function growTextareas(root) {
    (root || document).querySelectorAll('textarea:not(.hxl-grow)').forEach(t => {
      if (t.closest('.ck-editor, #RHI .ck')) return;
      t.classList.add('hxl-grow');
      const grow = () => { t.style.height = 'auto'; t.style.height = (t.scrollHeight + 2) + 'px'; };
      t.addEventListener('input', grow);
      grow();
    });
  }

  // Calendar: put the date (and Halaxy's loading spinner) beside the previous/next buttons
  let dateHome = null, pickerHome = null;
  function placeCalendarDate(mobile) {
    const grid = document.querySelector('#calToolbar .DayMenu > .row > div:first-child');
    const box = document.querySelector('#calToolbar .hxl-datebox') ||
      [...document.querySelectorAll('#calToolbar .TopMenu > .col-5 > .row > .col')].find(c => c.querySelector('.DateLabel'));
    if (!grid || !box) return;
    const picker = (document.getElementById('btn-calendar-date-select') || {}).parentElement;
    if (mobile) {
      if (box.parentElement !== grid) {
        dateHome = { parent: box.parentElement, next: box.nextSibling };
        box.classList.add('hxl-datebox');
        grid.appendChild(box);
      }
      if (picker && picker.parentElement !== box) {
        pickerHome = { parent: picker.parentElement, next: picker.nextSibling };
        box.insertBefore(picker, box.firstChild);
      }
    } else {
      if (pickerHome && picker && picker.parentElement === box) pickerHome.parent.insertBefore(picker, pickerHome.next);
      if (dateHome && box.parentElement === grid) {
        dateHome.parent.insertBefore(box, dateHome.next);
        box.classList.remove('hxl-datebox');
      }
    }
  }

  let fixTimer = null;
  function scheduleFixes() {
    if (fixTimer) return;
    fixTimer = setTimeout(() => {
      fixTimer = null;
      if (!document.documentElement.classList.contains('hxl')) return;
      try { stackRows(); scrollTables(); fitCalendarColumns(); fillCalendarGap(); fitGrids(); setupListLayout(); growTextareas(); stickCalHeader(); placeCalendarDate(true); } catch (e) { console.warn('[Halaxy mobile] layout fix failed', e); }
    }, 150);
  }

  // Start before the page draws, so the phone doesn't flash the desktop layout
  // (Very early, the page may not even have its <html> element yet: wait for it.)
  const early = () => { addStyle(); if (!wantDesktop) { setViewport(true); document.documentElement.classList.add('hxl'); } };
  if (document.documentElement) early();
  else new MutationObserver((m, o) => { if (document.documentElement) { o.disconnect(); early(); } }).observe(document, { childList: true });

  function build() {
    if (document.getElementById('hxl-burger')) return;
    const header = document.getElementById('headerWrapper');
    if (header) {
      const b = document.createElement('button');
      b.id = 'hxl-burger';
      b.type = 'button';
      b.setAttribute('aria-label', 'Menu');
      b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
      b.addEventListener('click', () => document.documentElement.classList.toggle('hxl-menu-open'));
      header.appendChild(b);
      // Pop-ups are pinned to the screen, so open them just below wherever the header bar is now
      header.addEventListener('click', e => {
        if (!e.target.closest('.alertIcon')) return;
        const bottom = header.getBoundingClientRect().bottom;
        document.documentElement.style.setProperty('--hxl-pop-top', Math.max(8, Math.round(bottom) + 6) + 'px');
      }, true);
    }
    const scrim = document.createElement('div');
    scrim.id = 'hxl-scrim';
    scrim.addEventListener('click', () => document.documentElement.classList.remove('hxl-menu-open'));
    document.body.appendChild(scrim);

    // Tapping a link in the drawer closes it
    const menu = document.getElementById('mainMenu');
    if (menu) menu.addEventListener('click', (e) => {
      const a = e.target.closest('a[href]');
      if (a && !/^javascript:/i.test(a.getAttribute('href') || '')) document.documentElement.classList.remove('hxl-menu-open');
    });

    const toggle = document.createElement('button');
    toggle.id = 'hxl-toggle';
    toggle.type = 'button';
    toggle.textContent = 'Switch to desktop layout';
    toggle.addEventListener('click', () => apply(false));
    if (menu) menu.insertBefore(toggle, menu.firstChild); else document.body.appendChild(toggle);

    const pill = document.createElement('button');
    pill.id = 'hxl-pill';
    pill.type = 'button';
    pill.textContent = '📱 Mobile layout';
    pill.addEventListener('click', () => apply(true));
    document.body.appendChild(pill);

    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.documentElement.classList.remove('hxl-menu-open'); });

    // Halaxy loads a lot of content after the page opens, so re-check whenever the page changes
    scheduleFixes();
    new MutationObserver(scheduleFixes).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('load', scheduleFixes);
    window.addEventListener('resize', scheduleFixes);
    if (document.body.classList.contains('calendar')) document.addEventListener('scroll', onCalScroll, { passive: true, capture: true });

  }


  // Start once the page has been read
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
