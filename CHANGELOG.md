# Changelog

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
