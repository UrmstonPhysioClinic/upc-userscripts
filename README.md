# UPC userscripts

Tampermonkey userscripts that improve Halaxy for Urmston Physio Clinic.

## Scripts

| Script | What it does | Install (stable) | Install (beta) |
|---|---|---|---|
| Outstanding Actions | Persistent notice of today's attended appointments with an unpublished note, and unpaid self-funded invoices. | [stable](https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/stable/outstanding-actions.user.js) | [beta](https://raw.githubusercontent.com/UrmstonPhysioClinic/upc-userscripts/main/beta/outstanding-actions.user.js) |

Open an install link in Firefox with Tampermonkey installed, then click **Install**.

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
python3 tests/outstanding-actions/test_outstanding_actions.py              # beta
python3 tests/outstanding-actions/test_outstanding_actions.py stable/outstanding-actions.user.js
```

Needs Python 3 and Playwright with Chromium. The tests run each script against a mock Halaxy that copies the structure of a real clinic day, with no patient data.

## Background

How Halaxy works under the hood (endpoints, data fields, write flows) is documented in the Halaxy reference in the Urmston Physio Clinic Claude project.
