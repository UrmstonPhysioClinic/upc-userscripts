# Changelog

## Bill funder

### 0.3.1 (7 Nov 2026, beta)
- Closer to Halaxy's own pop-ups: same width, table with lines between rows only, dates as 05-Nov-2026 and amounts as £ 40.00, version shown at the left of the buttons.

### 0.3.0 (7 Nov 2026, beta)
- Looks like Halaxy: the button matches Invoice Funder next to it, and the pop-up is built from Halaxy's own pop-up, table and button styles, so it follows Halaxy's theme and the clinic branding. Escape or the cross closes it (not while it is working).

### 0.2.1 (7 Nov 2026, beta)
- Safety stops now show their own message (they showed "U is not a constructor").

### 0.2.0 (7 Nov 2026, beta)
- Marks the merged patient invoice Issued after billing (the cogwheel's Status), so nothing more merges into it. If that step fails, billing is still reported as done, with a note to set Issued with the cogwheel.
- Leaves out fees on invoices whose cogwheel status is Issued (or anything other than Active), read from the settings rather than the page.

### 0.1.0 (7 Nov 2026, beta)
- "Bill funder" button next to Halaxy's Invoice Funder on patient invoices.
- Suggests this patient's fees for the same claim: dated today or earlier and within 6 months, not already billed, not on an Issued invoice. Did-not-attend/cancelled and £0 fees are listed with the appointment's comments but not ticked. Flags fees beyond the authorisation.
- After one confirmation: merges the chosen fees onto the latest of their invoices that holds only chosen fees (Halaxy's Merge invoice fees), checks the result, then uses Invoice Funder once to create a new organisation invoice while keeping the patient invoice. Never uses the existing organisation invoice Halaxy pre-selects.

## Custom Reports

### 0.6.1 (6 Nov 2026, beta)
- Its menu item no longer shows as highlighted on the Finance reports page (it copied Finance's highlight).

## Calendar controls

### 2.10 (6 Nov 2026, beta)
- The 30-second check for changes made on other PCs is skipped whenever the calendar was loaded in the last 30 seconds by anything else (Halaxy redrawing, changing date, or a refresh of its own), so the calendar is never loaded twice for nothing.
- The check goes through the core library's pacing and waits while Halaxy has asked scripts to pause.

## Remittances

### 0.1.0 (6 Nov 2026, beta)
- Reports > Remittances. Reads Bupa and WPA PDFs directly and AXA and Aviva scans by in-browser text recognition; cross-checks every remittance against its own totals.
- Matches each UPC number to its organisation invoice; classifies paid in full, excess (moved to the patient), provider shortfall (left for a person) or check.
- Applies excess fixes after one confirmation (revert, rebate, re-bill to the same invoice) and attaches the remittance to each matched invoice as Payment. Never records payments.
- Scanned invoice numbers can be corrected and re-checked on the review screen.

## Core library

### 0.1.6 (7 Nov 2026, beta)
- Pop-up close cross sized and placed by Halaxy's own style.

### 0.1.5 (7 Nov 2026, beta)
- `UPC.ui.dialog` and `UPC.ui.btn`: pop-ups and buttons built from Halaxy's own classes, with a small stylesheet scoped to our elements.

### 0.1.4 (7 Nov 2026, beta)
- The invoice reader finds the patient from the patient's own page link, not the edit link that comes first on the card. Bill funder stopped on live invoices because of this.

### 0.1.3 (7 Nov 2026, beta)
- `UPC.invoice.status(id)` and `UPC.invoice.setStatus(id, status)`: read and set an invoice's status through its settings pop-up (cogwheel), sending every other setting unchanged and checking the result.

### 0.1.2 (7 Nov 2026, beta)
- The invoice reader also returns, for patient invoices: patient, claim, funder, whether Invoice Funder is still available, the appointment behind each fee, and the authorisation position ("3rd of 5 appts").

### 0.1.1 (6 Nov 2026, beta)
- Pages such as Remittances now cover the whole content area between the side menu, top bar and footer, so nothing from the Halaxy page underneath shows through (the Finance reports title, banner and controls did before). The menu highlights only the tool, not the page underneath, and puts Halaxy's highlight back on leaving. Menu items added by scripts no longer copy Halaxy's highlight.

### 0.1.0 (6 Nov 2026, beta)
- window.UPC: Halaxy requests, invoice reading and lookup, rebate moves, invoice attachments, CDN loading, menu and page helpers.
- Request pacing shared by all scripts on a PC, with a pause when Halaxy says it is busy.

## Alerts

### 1.0.0 (6 Nov 2026, beta)
- Replaces Arrival chime 1.2 and Chat alert 1.4, same sounds and timings.
- Each alert sounds once per PC however many Halaxy tabs are open; a click or keypress in any tab stops the chat alarm in all of them.
- Arrival chime and chat alarm can be switched off per PC from the Tampermonkey menu.

## Health check

### 1.0.5 (7 Nov 2026, beta)
- Daily check of the invoice settings pop-up (cogwheel) that Bill funder uses to mark invoices Issued.

### 1.0.4 (7 Nov 2026, beta)
- Knows Bill funder; the invoice page check covers what it reads.

### 1.0.3 (6 Nov 2026, beta)
- Knows the core library and Remittances by name; the reports page check covers Remittances too.

### 1.0.2 (6 Nov 2026, beta)
- Results are saved one at a time, so two Halaxy tabs checking at once no longer overwrite each other (the daily data results went missing this way on first live use).
- If the data check itself stops with an error, that is shown as a problem.

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

### 0.3.0 (6 Nov 2026, beta)
- With several Halaxy tabs open, only one checks at a time and the others are sent its result, tab to tab (nothing is kept after the tabs close).
- Page changes within a minute of a check, and the 2-minute timer within 2 minutes, reuse the last result instead of checking again. "Check now" and your own saves always check.
- Changes seen on another PC are checked by the tab you're looking at only.
- Requests go through the core library's pacing, and background checks wait while Halaxy has asked scripts to pause.

### 0.2.0 (6 Nov 2026)
- Attendance now uses `appointmentStatus` (blank = normal; cancelled, did-not-attend and similar are excluded). 0.1.0 wrongly used the online booking request status.
- Note status read from the calendar data (`noteStatusCss`), so no request per note.
- Small green dot when nothing is outstanding, so the panel and diagnostics stay reachable.

### 0.1.0 (6 Nov 2026)
- First version: attended appointments with an unpublished note, unpaid self-funded invoices (over £0), grouped per appointment, on every Halaxy page.
