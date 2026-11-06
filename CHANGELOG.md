# Changelog

## Alerts

### 1.0.0 (6 Nov 2026, beta)
- Replaces Arrival chime 1.2 and Chat alert 1.4, same sounds and timings.
- Each alert sounds once per PC however many Halaxy tabs are open; a click or keypress in any tab stops the chat alarm in all of them.
- Arrival chime and chat alarm can be switched off per PC from the Tampermonkey menu.

## Health check

### 1.0.1 (6 Nov 2026, beta)
- Notice and panel sit to the right of Halaxy's side menu instead of underneath it, and follow it when the menu is collapsed or the window resized.

### 1.0.0 (6 Nov 2026, beta)
- Page checks for what calendar controls, Rebate Sync, Custom Reports, the editor scripts, toast alerts, Alerts and branding rely on, run on the pages where they apply.
- Daily data checks (and straight after a Halaxy update) for the fields Outstanding Actions reads, and for appointment or note statuses it doesn't know.
- Records the Halaxy version, collects errors from our scripts and the loader's update problems. Notice bottom left only when something is wrong; Copy details gives structure only.

## Loader

### 1.0.0 (6 Nov 2026)
- One script per PC that runs every script in the repository and picks up new and changed ones by itself, with a per-PC channel (stable or beta), per-script switches, saved copies for offline use, and refusal of broken updates.

## Added to the repository (6 Nov 2026)
Existing scripts moved here from earlier chats, code unchanged. Only the header changed: repository namespace and update URLs, plus "(beta)" on the beta copies.
- Calendar controls 2.9
- Custom Reports 0.6
- Rebate Sync 0.1.0
- Branding 2.9.1
- Auto-expanding text boxes 1.1
- Toast alerts 1.1
- Arrival chime 1.2
- Chat alert 1.4
- HTML source for emails 0.3

## Outstanding Actions

### 0.2.0 (6 Nov 2026)
- Attendance now uses `appointmentStatus` (blank = normal; cancelled, did-not-attend and similar are excluded). 0.1.0 wrongly used the online booking request status.
- Note status read from the calendar data (`noteStatusCss`), so no request per note.
- Small green dot when nothing is outstanding, so the panel and diagnostics stay reachable.

### 0.1.0 (6 Nov 2026)
- First version: attended appointments with an unpublished note, unpaid self-funded invoices (over £0), grouped per appointment, on every Halaxy page.
