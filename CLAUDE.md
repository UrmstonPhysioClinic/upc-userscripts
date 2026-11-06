# Working in this repository

Tampermonkey userscripts for Halaxy (eu.halaxy.com), used at Urmston Physio Clinic on Firefox PCs that share one Firefox account. Repository is PUBLIC.

## Hard rules

- Never commit patient data: recon exports, screenshots, remittance PDFs, saved Halaxy HTML, real names in tests. Test fixtures use invented labels ("Patient 09:00").
- No secrets. Scripts use the user's logged-in Halaxy session; no API keys.
- Work on a branch and open a pull request. Never push to `main` directly. Claude merges its own pull requests once the checks pass; Carl does not handle pull requests or merges.
- Changes go to `beta/` first. Promote to `stable/` only when Carl confirms beta works on live Halaxy. Stable and beta files differ only in `@name` (" (beta)" suffix) and `@updateURL`/`@downloadURL`.
- Bump `@version` (and the `VERSION` constant) in every changed script, then run `python3 tools/build_manifest.py`. The loader only fetches a script when its version in `scripts.json` changes.
- Run `python3 tests/check_scripts.py` and the relevant test in `tests/` before opening a PR (`tests/loader/test_loader.py` for any loader change).
- The PCs install only `loader/upc-loader.user.js`. Never ask Carl to install a script individually: adding it to `stable/` and `beta/` (and the manifests) is the install.

## Conventions

- Scripts run in the page through the loader. The only Tampermonkey functions available are `GM_getValue`, `GM_setValue`, `GM_deleteValue` and `GM_registerMenuCommand` (provided by the loader); anything else must be added to the loader first. `tests/check_scripts.py` enforces this.
- The loader honours each script's `@match`, `@include`, `@exclude`, `@run-at` and `@noframes`.
- **Health check** (`health-check.user.js`): when a script starts relying on a new Halaxy global, page element, endpoint or data field, add it to the health check's checks, and add new script files to its `NAMES` map. `tools/build_manifest.py` keeps the health check first in the load order so it catches every script's errors.
- Retiring a script: remove it from `beta/` first; remove it from `stable/` when the replacement is promoted.

- `@grant none`, `@inject-into page`, `@run-at document-start` when hooking requests; guard against double runs with a `window.__hx...` flag.
- UI in a shadow root. Pinned layers stay below Halaxy's overlays (z-index under 100; Halaxy overlays start at 100+).
- Reads only, unless a feature explicitly needs writes. Writes drive Halaxy's own pop-ups (GET form, read `form[_token]`, POST) and ask the user to confirm first.
- User-facing text: plain British English, no em dashes.
- Data facts (endpoints, field meanings) live in the Halaxy reference doc in the Claude project. Key ones:
  - `calendar/json`: `appointmentStatus` blank for normal appointments, filled only for exceptions (`cancelled`, `did-not-attend`). `requestStatus` is the online booking request status, not the appointment status.
  - `noteStatusCss`: `empty-` / `draft-` / `published-clinical-note`.
  - Funder is not in calendar events; classify by fee colour via `funder/fee/data`.
