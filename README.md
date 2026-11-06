# UPC userscripts

Tampermonkey userscripts that improve Halaxy for Urmston Physio Clinic.

## Scripts

| Script | What it does | Install (stable) | Install (beta) |
|---|---|---|---|
| Outstanding Actions | Persistent notice of today's attended appointments with an unpublished note, and unpaid self-funded invoices. | [stable](https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/stable/outstanding-actions.user.js) | [beta](https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/outstanding-actions.user.js) |
| Calendar controls | Clinic calendar defaults, compact 15-minute zoom, accurate time line, Just me / All practitioners, live refresh from other PCs, drag fixes, resizable personal appointments, 24-hour time picker, durations from fees. | [stable](https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/stable/calendar-controls.user.js) | [beta](https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/calendar-controls.user.js) |
| Custom Reports | Reports menu item: invoices, appointments or patients with any filters, chosen columns and saved views. Read-only. | [stable](https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/stable/custom-reports.user.js) | [beta](https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/custom-reports.user.js) |
| Rebate Sync | Change a rebate on the patient or funder invoice and the linked line on the other follows. Asks before changing anything. | [stable](https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/stable/rebate-sync.user.js) | [beta](https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/rebate-sync.user.js) |
| Branding | Clinic colours, logo, favicon and font in Halaxy. | [stable](https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/stable/branding.user.js) | [beta](https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/branding.user.js) |
| Auto-expanding text boxes | Text boxes and rich text editors grow to fit their content instead of scrolling. | [stable](https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/stable/textarea-autogrow.user.js) | [beta](https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/textarea-autogrow.user.js) |
| Toast alerts | Halaxy's alert banners float in the corner instead of pushing the page about. | [stable](https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/stable/toast-alerts.user.js) | [beta](https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/toast-alerts.user.js) |
| Arrival chime | Loud chime when a patient arrival notification appears. | [stable](https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/stable/arrival-chime.user.js) | [beta](https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/arrival-chime.user.js) |
| Chat alert | Urgent repeating alert when the chat unread count goes up, until someone clicks or types. | [stable](https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/stable/chat-alert.user.js) | [beta](https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/chat-alert.user.js) |
| HTML source for emails | A `<>` button on email editors to edit the body as raw HTML with a live preview. | [stable](https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/stable/email-html-source.user.js) | [beta](https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/email-html-source.user.js) |

Open an install link in Firefox with Tampermonkey installed, then click **Install**.

**Moving from pasted copies:** a script installed from here is a separate script in Tampermonkey from a copy pasted in earlier, even with the same name. Delete the old pasted copy, or both will run (double chimes, double saves).

## Channels

- **stable/**: what the clinic PCs run.
- **beta/**: what Carl's PC runs first. Changes land here, get tested on live Halaxy, then are copied to `stable/`.

Install **one channel per PC**, never both. The beta copies have "(beta)" in their name.

## How updates reach the PCs

- Each script's `@updateURL` points at its file in this repository. Tampermonkey checks it on a schedule and installs the new version when `@version` goes up. Set the interval in Tampermonkey: Settings > Script Update > Check Interval. "Check for userscript updates" in the Tampermonkey menu forces it.
- The clinic PCs share one Firefox account. With Tampermonkey's script sync switched on (Settings, config mode Advanced, Script Sync), a script installed from a link here on one PC appears on the others. Pasted scripts never sync.
- GitHub caches these files for about 5 minutes, so an update is live within minutes of merging, then reaches each PC at its next check.

## Rules

- **Never commit patient data**: no recon exports, screenshots, remittances or copied Halaxy pages. This repository is public. `.gitignore` blocks the common cases, but check every change.
- No passwords, keys or tokens. Scripts use the logged-in Halaxy session only.
- Every change goes through a pull request. Bump `@version` in every file you change, or the PCs won't update.
- Run the tests in `tests/` before merging.

## Tests

```
python3 tests/check_scripts.py                                             # every script: headers, channels, syntax
python3 tests/outstanding-actions/test_outstanding_actions.py              # beta
python3 tests/outstanding-actions/test_outstanding_actions.py stable/outstanding-actions.user.js
```

Needs Python 3 and Node.js; the Outstanding Actions test also needs Playwright with Chromium. It runs the script against a mock Halaxy that copies the structure of a real clinic day, with no patient data.

## Background

How Halaxy works under the hood (endpoints, data fields, write flows) is documented in the Halaxy reference in the Urmston Physio Clinic Claude project.
