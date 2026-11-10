# UPC userscripts

Tampermonkey userscripts that improve Halaxy for Urmston Physio Clinic.

## Install (once per PC)

1. In Firefox, with Tampermonkey installed, open **[the UPC Halaxy scripts loader](https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/loader/upc-loader.user.js)** and click **Install**.
2. Delete any Halaxy scripts installed or pasted in earlier (calendar controls, chimes, branding and so on). The loader runs all of them, so old copies would run twice.
3. Open Halaxy. The first page fetches every script and starts them.

That is the only install. Scripts added to this repository later reach every PC by themselves.

## Scripts

| Script | What it does |
|---|---|
| Outstanding Actions | Notice at the bottom centre of today's attended appointments with an unpublished note, and unpaid self-funded invoices. Your own appointments by default; Show everyone for the whole clinic. Reception sees everyone. |
| Calendar controls | Clinic calendar defaults, compact 15-minute zoom, accurate time line, Just me / All practitioners, live refresh from other PCs, drag fixes, resizable personal appointments, 24-hour time picker, durations from fees, green paid £ on £0 invoices. |
| Custom Reports | Reports menu item: invoices, appointments or patients with any filters, chosen columns and saved views. Read-only. |
| Rebate Sync | Change a rebate on the patient or funder invoice and the linked line on the other follows. Asks before changing anything. |
| Branding | Clinic colours, logo, favicon and font in Halaxy. |
| Auto-expanding text boxes | Text boxes and rich text editors grow to fit their content instead of scrolling. |
| Toast alerts | Halaxy's alert banners float in the corner instead of pushing the page about. |
| Alerts | Arrival chime and chat alarm in one script. Sounds once per PC however many tabs are open; a click in any tab stops the alarm; each sound can be switched off per PC in Script settings. |
| Remittances | Finances > Remittances: read a Bupa, WPA, AXA or Aviva remittance (typed or scanned PDF), match each line to its Halaxy invoice, flag differences, move excesses to the patient after one confirmation, and attach the remittance to each invoice. Never records payments. |
| Invoice Funder | Halaxy's own Invoice Funder button on a patient invoice opens the clinic's flow: picks this patient's unbilled fees for the claim (past, last 6 months, not Issued; did-not-attend and £0 fees listed with their comments but not ticked), merges them onto one invoice, invoices the funder once as a new organisation invoice and marks the patient invoice Issued. Afterwards, left-out cancelled fees can be kept or set to £ 0.00. Halaxy's original is one click away in the pop-up (Use Halaxy's Invoice Funder). Asks first, checks every step. Script file: bill-funder.user.js. |
| Ready to bill | Finances > Ready to bill, for Carl and Wendy: insurer patients whose unbilled fees are due to be billed (authorisation used up, no visit for 14 days and nothing booked, last working day of the month, fees 3 months old), each with an Invoice Funder button (month end, old fees and the excess hold apply to Bupa, AXA, WPA and Aviva only; the hold uses the excess from the Bupa or AXA intake form); patients not due yet or held for the excess greyed below with links to their invoices; cancelled or did-not-attend fees shown with their comments and Set to £ 0.00. A count on the menu item. |
| Forecourt lights | Reminders for the forecourt lights timer on clinic evenings: turn it on (with the times from Urmston's sunset), move its on time, change its clock for BST/GMT, and turn it off the next day. Off until switched on per PC in Script settings (Forecourt lights: settings). No requests to Halaxy. |
| Script settings | "Script settings" in Halaxy's account menu: every script's options (instead of the Tampermonkey menu), which scripts run on this PC, stable or beta, and updates. Needs loader 1.1.0. |
| Review requests (beta only for now) | Patients > Review requests, for Carl: finished patients (nothing booked; from the day after a visit whose notes say discharged or goals met, otherwise after 2 weeks; up to 4 weeks) with a good outcome in their notes or Progress Update form, ready for the Review Request follow-up. Send it, or label No review request, from the list (asks first). Leaves out anyone already asked, labelled, under 16 or owing money. |
| Core library | Shared helpers the other scripts use, including request pacing so our traffic stays modest. Does nothing on its own. |
| Health check | Checks that what our scripts rely on in Halaxy is still there, notes Halaxy updates, and collects script errors and update problems. Shows a small notice at the bottom centre only when something needs looking at; Script settings > Health check: show results at any time. |
| HTML source for emails | A `<>` button on email editors to edit the body as raw HTML with a live preview. |

## How it works

- `loader/upc-loader.user.js` is the only script installed on the PCs. It keeps a copy of every script listed in `stable/scripts.json` (or `beta/scripts.json`) and runs each one on the Halaxy pages its header asks for, before Halaxy's own scripts when the header says `@run-at document-start`.
- Every 10 minutes it checks GitHub in the background. New scripts start straight away; changed ones are used from the next page load. A new version with a syntax error is refused and the working copy kept. If GitHub can't be reached, the saved copies keep running.
- **Settings:** Halaxy's account menu (your name, top right) > **Script settings**. Shows every script's options, each script's version, lets a PC switch individual scripts off, choose its channel, and check for updates now. The Tampermonkey menu keeps **UPC scripts: settings and updates** as a way in if Halaxy's menu ever changes (and on PCs without Script settings yet).
- The loader itself updates through Tampermonkey's normal update check (Settings > Script Update).
- GitHub can serve the old copy of a file for about 5 minutes after a change, so an update reaches the PCs within about 15 minutes of merging.

## Channels

- **stable/**: what the clinic PCs run (the default).
- **beta/**: what Carl's PC runs, chosen in the loader's settings. Changes land here, get tested on live Halaxy, then are copied to `stable/` once Carl says beta works.

The channel is saved on each PC, not synced, so Firefox Sync never moves a clinic PC onto beta.

## Rules

- **Never commit patient data**: no recon exports, screenshots, remittances or copied Halaxy pages. This repository is public. `.gitignore` blocks the common cases, but check every change.
- No passwords, keys or tokens. Scripts use the logged-in Halaxy session only.
- Every change goes through a pull request, merged once the checks pass. Bump `@version` in every file you change and run `python3 tools/build_manifest.py`, or the PCs won't update.
- Run the tests in `tests/` before merging.

## Tests

```
python3 tests/check_scripts.py                                             # every script: headers, channels, syntax, script lists
python3 tests/loader/test_loader.py                                        # the loader, against a mock GitHub and Halaxy
python3 tests/alerts/test_alerts.py                                        # Alerts, two tabs
python3 tests/health-check/test_health_check.py                            # health check, against a breakable mock Halaxy
python3 tests/remittances/test_remittances.py                              # remittances and core, invented remittances and a mock Halaxy
python3 tests/calendar-controls/test_calendar_refresh.py                   # calendar controls' refresh, on a minimal mock calendar
python3 tests/bill-funder/test_bill_funder.py                              # bill funder, one invented patient covering every rule
python3 tests/outstanding-actions/test_outstanding_actions.py              # beta
python3 tests/outstanding-actions/test_outstanding_actions.py stable/outstanding-actions.user.js
```

Needs Python 3 and Node.js; the other tests also need Playwright with Chromium. The remittances test also needs reportlab and Pillow, and installs its PDF and text recognition libraries with npm on first run. The mocks contain no patient data.

## Background

How Halaxy works under the hood (endpoints, data fields, write flows) is documented in the Halaxy reference in the Urmston Physio Clinic Claude project.
