# Working in this repository

Tampermonkey userscripts for Halaxy (eu.halaxy.com), used at Urmston Physio Clinic on Firefox PCs that share one Firefox account. Repository is PUBLIC.

## Hard rules

- Never commit patient data: recon exports, screenshots, remittance PDFs, saved Halaxy HTML, real names in tests. Test fixtures use invented labels ("Patient 09:00").
- No secrets. Scripts use the user's logged-in Halaxy session; no API keys.
- Work on a branch and open a pull request. Never push to `main` directly.
- Changes go to `beta/` first. Promote to `stable/` only when Carl confirms beta works on live Halaxy. Stable and beta files differ only in `@name` (" (beta)" suffix) and `@updateURL`/`@downloadURL`.
- Bump `@version` (and the `VERSION` constant) in every changed script; Tampermonkey only updates on a higher version.
- Run `python3 tests/check_scripts.py` and the relevant test in `tests/` before opening a PR.

## Conventions

- `@grant none`, `@inject-into page`, `@run-at document-start` when hooking requests; guard against double runs with a `window.__hx...` flag.
- UI in a shadow root. Pinned layers stay below Halaxy's overlays (z-index under 100; Halaxy overlays start at 100+).
- Reads only, unless a feature explicitly needs writes. Writes drive Halaxy's own pop-ups (GET form, read `form[_token]`, POST) and ask the user to confirm first.
- User-facing text: plain British English, no em dashes.
- Data facts (endpoints, field meanings) live in the Halaxy reference doc in the Claude project. Key ones:
  - `calendar/json`: `appointmentStatus` blank for normal appointments, filled only for exceptions (`cancelled`, `did-not-attend`). `requestStatus` is the online booking request status, not the appointment status.
  - `noteStatusCss`: `empty-` / `draft-` / `published-clinical-note`.
  - Funder is not in calendar events; classify by fee colour via `funder/fee/data`.
