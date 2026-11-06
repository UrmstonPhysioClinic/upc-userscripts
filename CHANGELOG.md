# Changelog

## Outstanding Actions

### 0.2.0 (6 Nov 2026)
- Attendance now uses `appointmentStatus` (blank = normal; cancelled, did-not-attend and similar are excluded). 0.1.0 wrongly used the online booking request status.
- Note status read from the calendar data (`noteStatusCss`), so no request per note.
- Small green dot when nothing is outstanding, so the panel and diagnostics stay reachable.

### 0.1.0 (6 Nov 2026)
- First version: attended appointments with an unpublished note, unpaid self-funded invoices (over £0), grouped per appointment, on every Halaxy page.
