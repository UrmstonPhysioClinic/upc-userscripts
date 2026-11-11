# Changelog

## Moved to the clinic PCs (stable), 10 Nov 2026 (night)
Carl confirmed on live Halaxy: Script settings 0.1.0 (in the account menu; stable PCs need loader 1.1.0, which Tampermonkey fetches by itself) and health check 1.1.15.

## Moved to the clinic PCs (stable), 10 Nov 2026 (evening)
Carl confirmed on live Halaxy: core library 0.1.19, Invoice Funder (bill-funder) 0.7.3, Remittances 0.3.1, Ready to bill 0.3.0, calendar controls 2.11, Rebate Sync 0.2.0 and health check 1.1.13.

## Moved to the clinic PCs (stable), 9 Nov 2026 (evening)
Health check 1.1.9 (Carl), which also brings 1.1.8's add-task check and the table builder false alarm fix.

## Moved to the clinic PCs (stable), 9 Nov 2026 (afternoon)
Health check 1.1.6, then 1.1.7, at Carl's request, so the clinic PCs stop reporting the check-response status as a problem.

## Moved to the clinic PCs (stable), 9 Nov 2026
Confirmed by Carl on live Halaxy: core library 0.1.7, health check 1.1.4, Outstanding Actions 0.5.3, calendar controls 2.10, Alerts 1.0.0, Custom Reports 0.7.0, HTML source for emails 0.4. Arrival chime and Chat alert retired from stable (replaced by Alerts). `tools/promote.py` added for promotions.

## Portal fill

### 0.1.6 (11 Nov 2026, beta)
- Bupa: a treatment form that comes back while saving only counts as refused when Bupa shows an error message; the fill then stops quoting it (and Carl gets a task). Without a message (the page refreshed or reopened), the form is filled again and the fill carries on. On the live run, a refresh was wrongly taken for a refusal ("Bupa didn't accept treatment 1").

### 0.1.5 (11 Nov 2026, beta)
- Bupa: the procedure is found by Bupa's code anywhere in its wording (Carl: "make sure AA360 that appears in the Halaxy invoice also appears somewhere in one of the dropdown options"). The code is taken from the fee's Item Code, which reads like "Bup-IA (AA360)"; 0.1.4 compared the whole Item Code and found nothing on the first live run.
- Fee descriptions lose Halaxy's " - Patient Invoice UPC-..." ending (seen live), so AXA's treatment description is just the fee's name.

### 0.1.4 (11 Nov 2026, beta)
- Bupa: the procedure is chosen by code (Carl, 11 Nov 2026): the Halaxy fee's Item Code is Bupa's procedure code (AA360, AA361 ...), so the procedure starting with that code is picked. If the code isn't in Bupa's list, the box is highlighted for you to choose, saying so. Matching by wording (0.1.3) is gone.

### 0.1.3 (11 Nov 2026, beta)
- Bupa: once the last pre-populated treatment is removed, Bupa opens a new treatment by itself; the fill now carries on from there (it stopped with "A treatment is open" on the first live run).
- Bupa: the procedure is the fee (Carl, 11 Nov 2026). For each Halaxy fee, the procedure whose wording matches it (initial consultation or assessment; follow-up) is chosen. If none, or more than one, fits, the box is highlighted for you to choose, then you press Save and the fill carries on.
- Bupa: if Bupa doesn't accept a saved treatment, the fill stops (and Carl gets a task) instead of waiting.

### 0.1.2 (11 Nov 2026, beta)
- Bupa: you log in yourself again. Bupa's log-in is on a separate site (identity.provider.bupa.co.uk), and Carl agreed logging in by hand is simpler and safer than having the script press it there. Once you're in, the fill carries on by itself from Providers Online.

### 0.1.1 (11 Nov 2026, beta)
- Bupa: presses Log in once Firefox has filled in the saved log-in (Carl: "can you log in as part of the flow"). The password is never read or kept, only whether the box has something in it. If Bupa refuses it, the fill stops rather than trying again.
- A fill that fails, in Halaxy or on the portal, now sends Carl a task on the funder invoice ("Portal fill stopped: ...", with the reason), and the person filling is told he has been notified and will pick it up (Carl, 11 Nov 2026). The Stop button doesn't.
- The AXA payee email and phone are the clinic's own, so they're built in (Carl: "there is nothing secret"); Script settings > Portal fill: settings can still change them on a PC. The repository check now allows the clinic's own email domain.

### 0.1.0 (11 Nov 2026, beta, with core 0.1.26 and loader 1.2.0)
- New (Carl's steps, 11 Nov 2026). "Fill on the AXA portal" / "Fill on the Bupa portal" in the Bill To box of a Bupa or AXA funder invoice, and at the end of Invoice Funder. Reads the claim from Halaxy (the funder invoice's fees, number without the leading 0 and date; the claim's membership and authorisation numbers; the patient's name without title, date of birth, and address with postcode from the Edit page, read only; for AXA a condition from the first line under "Subjective:" in the notes for that claim), passes it to the portal tab through the loader on this PC, and opens the portal.
- AXA: membership number, Submit invoice, then the form: Therapist, payee details (Script settings > Portal fill: settings, asked for the first time), ICS code NA, one fee per treatment line (Outpatient, 1 unit), "add another treatment line" for each further fee. The condition is highlighted to check.
- Bupa: waits for the log-in, Reject all on the cookie box, Create an invoice, set-up (invoice number, first treatment date, pre-auth number), Pre-Auth Summary, checks Urmston Physio Clinic is the provider, removes pre-populated treatments, adds one fee per treatment (Consultant rooms, 1 session) leaving Bupa's impairment and procedure code, and stops on Confirm and Submit (warning if Bupa's total differs).
- Never presses Submit. Stops, saying what, at anything it doesn't expect. Once the portal shows its "submitted" message, Halaxy asks whether to mark the funder invoice Issued; the claim is then cleared from the PC (and after 4 hours in any case).

## Feedback alerts

### 0.1.0 (11 Nov 2026, beta, with core 0.1.24)
- New (Carl, 11 Nov 2026: "less than positive Feedback Request survey submissions flagged to me"). Every 2 hours on Carl's sign-in, new responses to the Feedback Request survey ("How Was Your Appointment?") from the last 14 days are read. Below expected (25 or less), or Satisfactory (26 to 31) with a comment, becomes a task for Carl on the patient's profile, added without asking: titled with the level and score, High for Below expected, due that day, with the answers (as 1 to 5), the comment and the response number. Completing the task marks it dealt with, on every PC.
- The patient is found with Halaxy's patient search by name, and the response's date of birth picks the right one. If that isn't certain, no task is added; the response is counted on Reports > Surveys and listed in Script settings > Feedback alerts: show results, with a link to the Responses page.
- Never twice: the patient's tasks are checked for the response number first. Only the response number, score band and outcome are kept on the PC; names and answers are read from Halaxy when needed.

## Review requests

### 0.5.0 (11 Nov 2026, beta, with core 0.1.24)
- Feedback Request survey (Carl, 11 Nov 2026): the patient's latest response from this course of treatment, matched by name and checked against their date of birth. Excellent (32 to 35) counts for a review request; Below expected (25 or less) counts against. Shown in the reasons, with a Feedback survey link under Check first. Everyone is read again once, as the signs have changed.

### 0.4.2 (10 Nov 2026, beta, with core 0.1.23)
- Review requests now go at 10:30 UK time. Halaxy reads a follow-up's date and time as Sydney time, whatever the practice's time zone: 11-Nov 10:30 entered went out at 23:30 UK time on 10-Nov (Carl confirmed they go at the time the list shows). The time is now entered as Sydney's clock reads at 10:30 UK time (21:30 in winter), and the time on the list is checked afterwards: if it isn't 10:30 UK time, the page says so.

### 0.4.1 (10 Nov 2026, beta, with core 0.1.22)
- A sent request said "Halaxy accepted the follow-up, but it does not show in Tasks & Follow-Ups" although it did: follow-ups added from the patient's profile have no "Linked To" note, and the patient is in Assigned To. The patient now comes from assignedToUrl, so the check passes and anyone already sent one is left out.
- The follow-up template is no longer imported, only the Review Request email template: with the template, Halaxy set its own send time (a request sent at 21:30 was scheduled for 23:30). The reminder now needs only a "Review Reminder" email template.

### 0.4.0 (10 Nov 2026, beta)
- Review requests are scheduled for the next weekday at 10:30 (at least 15 minutes ahead), the late-morning weekday slot review sellers' data favours (Carl: "whatever creates the least work and drives the most conversions"). The confirmation says when, and the row shows it.
- Optional reminder: if Halaxy has a follow-up template and an email template called "Review Reminder", a reminder is added for a week later at the same time. Without them, nothing more is sent. Both can be cancelled in Tasks & Follow-Ups before they go.

### 0.3.2 (10 Nov 2026, beta, with core 0.1.21)
- Send review request was refused live ("Scheduled date must be in the future"): the follow-up is now scheduled for the next 5 minutes from 10 minutes' time. When Halaxy refuses something, only its own reason is shown, not the form's list of required fields.

### 0.3.1 (10 Nov 2026, beta)
- A tab closed or reloaded mid-check no longer holds the page on "Checking in another tab" for up to 10 minutes: the checking tab renews its claim as it goes, and a lapsed one is taken over after 2 minutes. Each patient's result is kept as soon as it's read, so a stopped check isn't wasted. The waiting tab shows the other tab's progress ("12 of about 60").
- Against narrowed after the first live list (25 under Worth a look): only "referred to GP/consultant/for a scan...", "awaiting an MRI/surgery", "getting/feeling worse", "had a flare-up", "still painful", "not fully better", "no better". Plain mentions such as "worse on stairs", "no need for a scan" or "discussed injection options" no longer count, and "no flare-up" doesn't either. Patients are read again once with the new rules.

### 0.3.0 (10 Nov 2026, beta)
- A "Check first" column with links to the notes and Progress Update form behind each suggestion (Last note, Previous note, Progress Update, with their dates), opening in a new tab, so they can be read before sending (Carl).

### 0.2.0 (10 Nov 2026, beta)
- Asks while it's fresh (Carl): from the day after the last visit when the notes say treatment has finished (discharged, goals met, self-managing, see as needed), otherwise once 2 weeks have passed with nothing booked. Nobody last seen over 4 weeks ago (was 2 to 8 weeks).

### 0.1.0 (10 Nov 2026, beta)
- New: Patients > Review requests, for Carl only, with a count on the menu item. Patients last seen 2 to 8 weeks ago with nothing booked, whose latest Progress Update form (+4 or +5) or last two clinical notes show a good outcome ("100% better", "pain-free", "back to running", "goals met", "discharged" and so on). Mixed signs ("not 100%", "flare-up", "referred to GP", a scan or injection) are listed greyed under Worth a look.
- Left out: anyone already sent a Review Request follow-up, labelled No review request, under 16, owing money on their own invoices, or whose last appointment was cancelled or missed.
- Send review request: Halaxy's Add Follow-Up with the Review Request templates, by email, now, after confirming; checked in Tasks & Follow-Ups afterwards. Don't ask: adds the No review request label on the patient's Edit page, sending everything else back unchanged, and checks it afterwards.
- Notes are read in the browser only; only the kinds of phrase found are kept, never the note text. Each patient's result is kept for a week; the count refreshes at most every 12 hours.

## Core library

### 0.1.26 (11 Nov 2026, beta)
- UPC.invoice.parse: each fee's description (on an organisation invoice, the last description cell, without the Patient column's script) and `billToName` (the funder in an organisation invoice's Bill To box).

### 0.1.25 (11 Nov 2026, beta)
- Patient search sends the practice number from the page address, as Halaxy's search box does (live check: the number tried first before got an HTML page back, costing a wasted request).

### 0.1.24 (11 Nov 2026, beta)
- UPC.surveys: list() (Reports > Surveys > Responses: /report/survey/feedback-data), response(id) (/report/survey/view/{id}: total, level, date of birth, answers) and band() (Excellent, Satisfactory, Below expected).
- UPC.patient.find(name, dob): Halaxy's patient search (/a/magic/lookup/patient); the date of birth picks between patients with the same name; null unless certain. UPC.patient.nameKey().
- UPC.tasks.forPatient() and addToPatient() (the profile's Add Task: /task/new/linkPaG/{id}, tasks at /task/linkPaG/{id}/list-data), sharing addToInvoice's steps; a task can carry a `key` it is recognised by.

### 0.1.23 (10 Nov 2026, beta)
- `UPC.followUps.add` enters the time as Sydney time (Halaxy's follow-up quirk) and checks the listed time against the one asked for.

### 0.1.21 (10 Nov 2026, beta)
- `UPC.followUps.add` schedules 10 minutes ahead by default (Halaxy refuses a time that isn't in the future). `expectRefresh` reports Halaxy's own error list when there is one.

### 0.1.20 (10 Nov 2026, beta)
- `UPC.notes.items` and `UPC.notes.text` (a patient's notes list and a note's text), `UPC.followUps.list` and `UPC.followUps.add` (Tasks & Follow-Ups), `UPC.patient.details`, `UPC.patient.invoices` and `UPC.patient.addLabel`. Confirmed against live captures, 10 Nov 2026.

## Health check

### 1.1.20 (11 Nov 2026, beta)
- Daily check of the patient Edit page's address and postcode fields (Portal fill). Portal fill added to the script names.

### 1.1.19 (11 Nov 2026, beta)
- The patient search check asks as Halaxy's search box does (with the page's practice number). 1.1.18 reported "Patient search has changed" wrongly.

### 1.1.18 (11 Nov 2026, beta)
- Daily data checks for Feedback alerts: the survey responses list and a response's total, level and questions; Halaxy's patient search; a patient's add-task pop-up and task list. Feedback alerts added to the script names.

### 1.1.17 (11 Nov 2026, beta)
- Shown only to Carl Healy (Carl: "just show health check on my account"): the notice and "Health check: show results" in Script settings appear only on his sign-in. The checks and script errors are still collected on every sign-in and kept on that PC, so they show when Carl next signs in there. If the page doesn't say who is signed in (Halaxy may have changed), it shows rather than hides.

### 1.1.16 (10 Nov 2026, beta)
- The follow-ups check looks for assignedToUrl (the patient), which Review requests now reads.

### 1.1.15 (10 Nov 2026, beta)
- Checks the follow-ups list daily (Review requests), and knows Review requests by name.

## Loader

### 1.2.0 (11 Nov 2026)
- Also runs on the Bupa and AXA provider sites, for Portal fill. Only scripts whose own @match names those sites run there; the PC's channel and switched-off scripts come from a copy kept while Halaxy is open, and no update checks are made there.
- `window.__upcLoader.shared(op, key, value)`: passes a value between Halaxy and a portal on this PC through the loader's storage. A value with `forHost` is given back only on Halaxy and that site.

### 1.1.0 (10 Nov 2026, all PCs)
- Scripts' menu items are kept for Script settings in Halaxy (window.__upcLoader.items, run(id)); the Tampermonkey menu gets them only on pages where Script settings isn't running (checked 4 seconds after the page loads). The loader's own "UPC scripts: settings and updates" stays in the Tampermonkey menu.
- Answers Script settings' upc-loader-get and upc-loader-do (switch a script, stable or beta, check for updates) with upc-loader-state.

## Script settings

### 0.1.0 (10 Nov 2026, beta)
- New: "Script settings" in Halaxy's account menu (your name, top right), above Log Out (Carl). Its pop-up lists every script's options, grouped by script, and the scripts on this PC with their versions, switches, stable or beta, and Check for updates now. Replaces the Tampermonkey menu, which keeps only the loader's own entry as a way in.

## Health check

### 1.1.14 (10 Nov 2026, beta)
- Checks Halaxy's account menu (#practitioner-select), where Script settings goes, and knows Script settings by name.

## Forecourt lights

### 0.2.1 (10 Nov 2026, stable and beta)
- Reads typed skip dates itself (25-Dec-2026, 25/12/2026 or 2026-12-25), so it runs with the stable core library. Moved to the clinic PCs (Carl confirmed it on live Halaxy).

### 0.2.0 (10 Nov 2026, beta)
- Settings choose who is reminded, by who is signed in to Halaxy on that PC (Carl). Nobody ticked means anyone.

### 0.1.0 (10 Nov 2026, beta)
- New: reminders for the forecourt and sign floodlights timer (Carl). On clinic evenings, from the reminder time: turn the timer on, with the times (sunset for Urmston minus 30 minutes, rounded down to the timer's 15-minute steps, off at 20:45); move the timer's on time when it changes; change the timer's clock after the clocks go forward or back, with a heads-up on the last clinic evening before. The day after a clinic evening, until done: turn the timer off (not when that day is a clinic evening too). In summer, when the lights aren't needed, it says so once, with the date they're next needed.
- Off until switched on per PC from the Tampermonkey menu (Forecourt lights: settings): clinic evenings, off time, minutes before sunset, reminder time, the timer's current on time, dates to skip, and a two-week preview. Halaxy-style pop-up with Done and Remind me later (an hour). Sunset is worked out on the PC: nothing is fetched.

## Ready to bill

### 0.3.0 (10 Nov 2026, beta)
- Excess hold reads the patient's answer to "Excess amount:" on their Bupa or AXA Initial Assessment Form (the form nearest the start of the claim) and holds a new claim until the unbilled fees cover it. Shown as "patient-reported excess £ 250.00 (unconfirmed)" and used only to time billing. "None" or 0 means no hold. Aviva and WPA forms don't ask, and a missing or unreadable answer falls back to 2 fees. Two requests per new Bupa or AXA claim, cached for a day.

### 0.2.1 (10 Nov 2026, beta)
- Aviva can be billed mid-treatment too (Carl): month end, 3-month-old fees and the excess hold now apply to Bupa, AXA, WPA and Aviva.

### 0.2.0 (10 Nov 2026, beta)
- Only Bupa, AXA and WPA are billed mid-treatment (Carl): the month-end and 3-month rules and the excess hold apply to them only. Other funders (Aviva, OPM, 3rd Party Funded and so on) are due when the authorisation is used up or treatment has finished, and otherwise show "Billed at the end of treatment".
- Patients with only cancelled or did-not-attend fees: each fee is listed with its appointment comments and a Set to £ 0.00 button (fee and funder rebate together, after confirming). The Unbilled column shows those fees instead of "0 fees".
- The empty column on the right of the Not due yet table is gone, and dates no longer wrap.

### 0.1.0 (10 Nov 2026, beta)
- New: Finances > Ready to bill, for Carl and Wendy only. Lists insurer patients with unbilled fees (on an Active patient invoice that Halaxy doesn't show as Pending, last 6 months) and says which are due to bill and why: authorisation used up, no visit for 14 days with nothing booked, the last working day of the month, or fees 3 months old or more. Each due patient has an Invoice Funder button that opens their latest invoice with Invoice Funder.
- Not due yet, held for the excess (a new claim with fewer than 2 fees, until the intake form's excess can be read) and did-not-attend-only patients are greyed at the bottom, with links to their invoices.
- A count of due patients on the menu item, refreshed at most every 2 hours in the visible tab and shared by all tabs. One report, one list and one calendar request per check, plus each patient's first and latest invoice (cached for a week). Read-only.

## Bill funder

### 0.8.0 (11 Nov 2026, beta)
- After billing Bupa or AXA: a "Fill on the Bupa portal" / "Fill on the AXA portal" button opens the new funder invoice, where Portal fill does the rest.

### 0.7.3 (10 Nov 2026, beta)
- "Zero" is now worded "Set to £ 0.00" throughout (Carl).

### 0.7.2 (10 Nov 2026, beta)
- Opens by itself on an invoice opened from Ready to bill (address ending #upc-invoice-funder), once.

### 0.7.1 (9 Nov 2026, beta)
- After invoicing the funder: checks each fee's date on the new funder invoice against the patient fee it came from and corrects dates a day or two out (Halaxy copied 13-Oct as 14-Oct on a live run). Fees it can't pair, or further out, are reported for a manual check.
- Sets the funder invoice's date to the day it was created and its due date to 3 months later (Halaxy copies the patient invoice's date and leaves the due date empty).

### 0.6.2 (9 Nov 2026, beta)
- Fix: Zero failed on live Halaxy because a fee on a claim carries its funder rebate before any billing. Zero now sets the fee and its funder rebate to £ 0.00 together (which also clears the funder's row in Payments), but only while the fee's invoice still shows Invoice Funder; a fee on a billed invoice is refused.
- First live billing run (9 Nov): merged three fees, invoiced Bupa on a new organisation invoice, marked the patient invoice Issued.

### 0.6.1 (9 Nov 2026, beta)
- Fix: on an invoice opened from the patient's Invoices tab (/patient/invoice/{patient}/{invoice}), Invoice Funder let Halaxy's own pop-up open instead of this flow. The invoice is now taken from the button itself.

### 0.6.0 (9 Nov 2026, beta)
- One button: Halaxy's own Invoice Funder now opens this flow (titled Invoice Funder), and the separate Bill funder button is gone. Use Halaxy's Invoice Funder, at the bottom left of the pop-up (and on any error), opens Halaxy's original pop-up instead. Without the clinic scripts the button works as Halaxy's.

### 0.5.0 (9 Nov 2026, beta)
- After billing, cancelled and did-not-attend fees that were left out are listed with their comments, each with Keep or Zero (Keep by default). Zero sets the fee to £ 0.00 in its fee edit pop-up, every other field unchanged, after one confirmation, and checks the invoice shows it.

### 0.4.0 (9 Nov 2026, beta)
- Fees already on the open invoice are marked "On this invoice".
- When nothing needs merging, the button reads Bill funder and the confirmation says there is nothing to merge.
- "Not shown" lists each left-out invoice with its date and reason, to match against Halaxy's merge menu.

### 0.3.3 (9 Nov 2026, beta)
- Shows the appointment's comments (cancellation reason, billing notes) under cancelled and did-not-attend fees. They are read from the appointment's details pop-up, as the calendar data leaves them out. Line breaks are kept.

### 0.3.2 (7 Nov 2026, beta)
- Amounts use the core library's Halaxy format.

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

### 0.7.0 (7 Nov 2026, beta)
- Halaxy card headers on the Report and Filters sections, and Halaxy's page buttons in the toolbar.

### 0.6.1 (6 Nov 2026, beta)
- Its menu item no longer shows as highlighted on the Finance reports page (it copied Finance's highlight).

## Calendar controls

### 2.11 (10 Nov 2026, beta)
- Appointments whose invoice is £0 (package follow-ups, cancelled appointments) show the green paid £ instead of the black unpaid one (Carl). The amounts come from one invoice list request for the dates on screen, shared by all tabs and repeated at most every 30 minutes, through the core library's pacing. Display only.

### 2.10 (6 Nov 2026, beta)
- The 30-second check for changes made on other PCs is skipped whenever the calendar was loaded in the last 30 seconds by anything else (Halaxy redrawing, changing date, or a refresh of its own), so the calendar is never loaded twice for nothing.
- The check goes through the core library's pacing and waits while Halaxy has asked scripts to pause.

## Remittances

### 0.3.1 (9 Nov 2026, beta)
- With nothing to fix (all paid in full), the button reads "Attach remittance to n invoices" and attaches it, instead of being greyed out.
- Never attaches the same remittance twice: an invoice that already has it is skipped.
- After a run the button is disabled until the remittance is loaded again.
- Moved to Finances in the menu, opening over Halaxy's Invoices page. Older links still work.

### 0.3.0 (9 Nov 2026, beta)
- After an excess fix, adds a task on the patient invoice to bill the patient: assigned to Carl Healy, due today, medium priority, titled "Bill excess: UPC-n (insurer remittance date, ref)", with what the patient owes and which fees moved. Not added twice for the same remittance. If it can't be added, the fix still stands and the log says to add the task by hand.

### 0.2.1 (9 Nov 2026, beta)
- Lines already showing what the insurer paid (done earlier, or by hand) are skipped, so a remittance can be run again safely.
- A remittance line matches a funder line a day or two out when there is no exact date, as Halaxy sometimes dates funder fees a day out and the date is then corrected.

### 0.2.0 (7 Nov 2026, beta)
- Looks like Halaxy: page title, Halaxy cards, tables, buttons and text boxes, and Halaxy's pop-up to confirm. Amounts as £ 40.00.

### 0.1.0 (6 Nov 2026, beta)
- Reports > Remittances. Reads Bupa and WPA PDFs directly and AXA and Aviva scans by in-browser text recognition; cross-checks every remittance against its own totals.
- Matches each UPC number to its organisation invoice; classifies paid in full, excess (moved to the patient), provider shortfall (left for a person) or check.
- Applies excess fixes after one confirmation (revert, rebate, re-bill to the same invoice) and attaches the remittance to each matched invoice as Payment. Never records payments.
- Scanned invoice numbers can be corrected and re-checked on the review screen.

## Core library

### 0.1.19 (10 Nov 2026, beta)
- `UPC.forms.list(linkPaGId)` (a patient's filled forms, from their notes list) and `UPC.forms.answers(id)` (question and answer pairs), confirmed live 10 Nov 2026.

### 0.1.18 (10 Nov 2026, beta)
- `UPC.reports.unpaidLines(start)`: Halaxy's Unpaid Invoices report as one row per fee line (columns confirmed live 10 Nov 2026), invoice-level cells carried to every line. `UPC.reports.pendingInvoiceIds()`: invoices Halaxy lists as Pending. `UPC.dayLabel` and `UPC.parseDay` for Halaxy's dates.

### 0.1.17 (9 Nov 2026, beta)
- The invoice reader keeps each attachment's whole row (the first cell is the date, not the file name). `files.attachToInvoice(..., { skipIfAttached })`.
- `ui.menuItem` / `ensureMenuItem` take a section (default Reports) and an href function.

### 0.1.16 (9 Nov 2026, beta)
- `UPC.tasks.addToInvoice(id, task)` and `UPC.tasks.forInvoice(id)`, through Halaxy's own add-task pop-up (`task/new/invoice/{id}`); confirms the task shows on the invoice's task list.

### 0.1.15 (9 Nov 2026, beta)
- Fix: when the insurer paid nothing for a fee, the excess fix removed the fee from the funder invoice and then stopped on the £0.00 Halaxy left waiting to bill (live, UPC-37794 / UPC-37382). It now re-bills £0.00, so the fee stays on the funder invoice at £0.00, dated as the patient fee.

### 0.1.14 (9 Nov 2026, beta)
- Excess fixes (Remittances): when Halaxy copied a fee onto the funder invoice a day or two out, the patient fee is still found (the one same-item fee within two days that no other funder line claims); anything ambiguous still stops. The error now lists the patient invoice's fee dates. Live failure 9 Nov: "Could not find the matching line on UPC-37382".
- After re-billing part of a fee, the new funder line's date is corrected to the patient fee's date if Halaxy slipped it.

### 0.1.13 (9 Nov 2026, beta)
- `UPC.invoice.setSettings(id, changes)`: any invoice settings fields through the cogwheel, others unchanged, confirmed by re-reading.
- `UPC.invoice.setLineDate(lineId, date)`: a fee's date (`form[date]`, confirmed live), confirmed by re-reading.

### 0.1.11 (9 Nov 2026, beta)
- `UPC.invoice.setLineAmount(..., { lowerRebate: true })` lowers the funder rebate with the amount, only while the invoice still shows Invoice Funder; confirms by re-reading the fee's form.

### 0.1.10 (9 Nov 2026, beta)
- Version label sits after a left-hand button in pop-up button rows.

### 0.1.9 (9 Nov 2026, beta)
- `UPC.invoice.setLineAmount(invoiceId, lineId, pence)`: sets a fee's amount through its edit pop-up, other fields unchanged; refuses a fee with a funder rebate above the new amount; checks the result.

### 0.1.8 (9 Nov 2026, beta)
- `UPC.http.fragment` (HTML as Halaxy's pop-ups request it) and `UPC.appointment.notes(id)` (the appointment's comments).

### 0.1.7 (7 Nov 2026, beta)
- Amounts written as Halaxy writes them (£ 40.00) everywhere.
- Pop-ups can sit above Halaxy's own pop-ups (for steps that start from one) and come in Halaxy's narrower size.

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

### 1.1.13 (10 Nov 2026, beta)
- Knows Forecourt lights by name.

### 1.1.12 (10 Nov 2026, beta)
- Checks the calendar's appointment template and redraw, and the payment icon class in the calendar data (used by calendar controls 2.11).

### 1.1.11 (10 Nov 2026, beta)
- Knows Ready to bill by name, and shows its message when Halaxy's Unpaid Invoices report changes.

### 1.1.10 (10 Nov 2026, beta and stable)
- A new version clears all of the previous version's results, page checks included. Before, a page result (such as 1.1.8's table builder false alarm on a referral report page) stayed until that kind of page was opened again.

### 1.1.9 (9 Nov 2026, beta)
- Halaxy's table builder is only checked on the Finance report page, where Custom Reports uses it. Other report pages, such as the new appointment report form, don't load it, which gave a false alarm. Remittances no longer listed as relying on it.

### 1.1.8 (9 Nov 2026, beta)
- Daily check of the add-task pop-up (fields, and Carl Healy in the Assign to list). Opening it adds nothing.

### 1.1.7 (9 Nov 2026, beta and stable)
- Re-runs the data check as soon as a new version of the health check arrives, instead of showing the previous version's results until the next daily check. Moved to the clinic PCs at once, so the old check-response notice clears there without anyone pressing Check again.

### 1.1.6 (9 Nov 2026, beta)
- "check-response" is a known appointment status (treated as attended, as before), so it is no longer reported.
- A genuinely new status is reported with the time and date of an example appointment, so it can be found.

### 1.1.5 (9 Nov 2026, beta)
- Daily check of the appointment details pop-up that Bill funder reads comments from.

### 1.1.4 (9 Nov 2026, beta)
- Notice moved to the bottom centre, just above Outstanding Actions' notice, so Halaxy's side panels (such as the patient notes list) no longer hide it. Its panel comes to the front while open.

### 1.1.3 (9 Nov 2026, beta)
- Same fix as Outstanding Actions 0.5.3 for its notice.

### 1.1.2 (9 Nov 2026, beta)
- Same fix as Outstanding Actions 0.5.2 for its notice.

### 1.1.1 (9 Nov 2026, beta)
- The notice has a solid fill, so the page no longer shows through it.

### 1.1.0 (7 Nov 2026, beta)
- Looks like Halaxy: the panel is a Halaxy card with Halaxy buttons; the notice is a Halaxy button.

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

### 0.5.3 (9 Nov 2026, beta)
- The hover state is no longer see-through on live Halaxy: a white backing sits behind the notice, out of reach of Halaxy's button styles (0.5.2's fill lost to Halaxy's hover style).

### 0.5.2 (9 Nov 2026, beta)
- Fix to 0.5.1: the notice is Halaxy's filled red again; only its hover state (an outline) gets a solid fill, so the page no longer shows through when you hover.

### 0.5.1 (9 Nov 2026, beta)
- The notice sits at the bottom centre of the page, clear of the patient side panel and the booking panel's Save button. Its panel opens upwards from there.
- The notice has a solid fill, so the page no longer shows through it.

### 0.5.0 (7 Nov 2026, beta)
- Shows only your own appointments by default ("Your outstanding today"). Tick Show everyone for the whole clinic; each PC remembers it. Replaces Only mine.
- Someone with no appointments of their own, such as reception, sees everyone's, and the panel says so.

### 0.4.0 (7 Nov 2026, beta)
- Looks like Halaxy: the panel is a Halaxy card with Halaxy buttons; the notice is a Halaxy button.

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

## Rebate Sync

### 0.2.0 (7 Nov 2026, beta)
- Its confirmation and progress use Halaxy's pop-up, shown above the fee edit pop-up. Amounts as £ 40.00. Now uses the core library.

## HTML source for emails

### 0.4 (7 Nov 2026, beta)
- Halaxy buttons and text box in the HTML panel.
