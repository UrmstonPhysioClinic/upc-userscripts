# Working in this repository

Tampermonkey userscripts for Halaxy (eu.halaxy.com), used at Urmston Physio Clinic on Firefox PCs that share one Firefox account. Repository is PUBLIC.

## Hard rules

- Never commit patient data: recon exports, screenshots, remittance PDFs, saved Halaxy HTML, real names in tests. Test fixtures use invented labels ("Patient 09:00").
- No secrets. Scripts use the user's logged-in Halaxy session; no API keys.
- Work on a branch and open a pull request. Never push to `main` directly. Claude merges its own pull requests once the checks pass; Carl does not handle pull requests or merges.
- Changes go to `beta/` first. Promote to `stable/` only when Carl confirms beta works on live Halaxy. Stable and beta files differ only in `@name` (" (beta)" suffix) and `@updateURL`/`@downloadURL`.
- Bump `@version` (and the `VERSION` constant) in every changed script, then run `python3 tools/build_manifest.py`. The loader only fetches a script when its version in `scripts.json` changes.
- Run `python3 tests/check_scripts.py` and the relevant test in `tests/` before opening a PR (`tests/loader/test_loader.py` for any loader change); `python3 tools/run_tests.py` runs everything. GitHub runs all tests on every PR, in five groups at once (add a new test folder to a group in `.github/workflows/tests.yml`; a check fails otherwise): merge only when they pass.
- The PCs install only `loader/upc-loader.user.js`. Never ask Carl to install a script individually: adding it to `stable/` and `beta/` (and the manifests) is the install.

## Conventions

- Scripts run in the page through the loader. The only Tampermonkey functions available are `GM_getValue`, `GM_setValue`, `GM_deleteValue` and `GM_registerMenuCommand` (provided by the loader); anything else must be added to the loader first. `tests/check_scripts.py` enforces this.
- The loader honours each script's `@match`, `@include`, `@exclude`, `@run-at` and `@noframes`.
- **Insurer portals** (loader 1.2.0): the loader also runs on `provider.axahealth.co.uk` and `providersonline.bupa.co.uk`, where only scripts whose `@match` names them run (Portal fill). There the core library isn't loaded and the PC's channel and switched-off scripts come from a copy the loader keeps while Halaxy is open. Pass data from Halaxy to a portal with `window.__upcLoader.shared('set' | 'get' | 'del', key, value)` (the loader's own storage on that PC); a value with `forHost` is only given back on Halaxy and that site. Portal scripts never press Submit, and stop with a message at anything unexpected.
- **Health check** (`health-check.user.js`): when a script starts relying on a new Halaxy global, page element, endpoint or data field, add it to the health check's checks, and add new script files to its `NAMES` map. `tools/build_manifest.py` keeps the health check first in the load order so it catches every script's errors.
- **Core library** (`core.user.js`, `window.UPC`): new scripts use it for Halaxy requests (`UPC.http`), invoices (`UPC.invoice`), rebate moves (`UPC.rebate`), attachments (`UPC.files`) and menu/page furniture (`UPC.ui`). All requests go through its pacing (300 ms gap, 45 a minute per PC across tabs, 3-minute pause if Halaxy answers 429/502/503/504). Background checks must skip while `UPC.http.pausedFor()` is above 0. Never add headers that label requests as scripts.
- **Being a good Halaxy user**: keep traffic close to what a person clicking would generate. Background polling only in the visible tab and shared across tabs; no duplicate polling of what Halaxy already refreshes. Halaxy's terms allow suspension "for any reason".
- **Remittances**: payments are never recorded (Carl's rule: only after the bank statement confirms the money). Remittance PDFs are patient data: real samples are used only outside the repository; tests build invented ones.
- Retiring a script: remove it from `beta/` first; remove it from `stable/` when the replacement is promoted.

- `@grant none`, `@inject-into page`, `@run-at document-start` when hooking requests; guard against double runs with a `window.__hx...` flag.
- **Native look** (Carl, 7 Nov 2026): everything we add must look like Halaxy. Build it in the page with Halaxy's own classes (`btn btn-primary`, `btn btn-outline-primary`, `btn btn-outline-primary-light`, `card`/`card-header`, `table table-striped table-bordered`, `form-control`, `text-muted`) inside an element with class `upc-native`, using `UPC.ui.dialog` for pop-ups. Halaxy's theme and the branding script then style it exactly like Halaxy. Our own CSS covers only what Halaxy has no class for: shared rules in core's stylesheet (`.upc-native`/`.upc-dialog`), script-specific rules in one `<style id="upc-<script>-css">` scoped to that script's own root class, using Halaxy's `--vs-*` colour variables. Prefix our own class names (`upc-...`), as Halaxy's generic ones (`row`, `list`, `tag`) would clash. Write amounts and dates as Halaxy does (`£ 40.00`, `05-Nov-2026`; `UPC.money.fmt`). Never use Halaxy's behaviour classes: `ajax`, `btn-submit`, `btn-cancel`, `bootbox`, `bootbox-close-button`, `modal` on the outer layer, `dialogBoxForm`, `datepicker`, `popoverTarget`, `chosen`. No shadow roots (`tests/check_scripts.py` enforces this and the behaviour classes for `beta/`). The loader's own Tampermonkey panel ("UPC scripts: settings and updates") stays self-contained on purpose: it's the way in when page scripts fail. Day to day, its settings and every script's `GM_registerMenuCommand` items are shown in Halaxy by Script settings (`script-settings.user.js`, account menu), through the loader's `upc-loader-get` / `upc-loader-do` / `upc-loader-state` events (loader 1.1.0).
- Pinned layers stay below Halaxy's overlays (z-index under 100; Halaxy overlays start at 100+). Our pop-ups use 2990, just below Halaxy's own pop-ups (3000).
- Reads only, unless a feature explicitly needs writes. Writes drive Halaxy's own pop-ups (GET form, read `form[_token]`, POST) and ask the user to confirm first.
- User-facing text: plain British English, no em dashes.
- Data facts (endpoints, forms, field meanings) live in `halaxy-mappings.md` in the Claude project (confirmed on live Halaxy; add to it whenever a script relies on something new); background in `halaxy-reference.md`; the whole system in `upc-scripts-spec.md`. Key ones:
  - `calendar/json`: `appointmentStatus` blank for normal appointments, filled only for exceptions (`cancelled`, `did-not-attend`). `requestStatus` is the online booking request status, not the appointment status.
  - `noteStatusCss`: `empty-` / `draft-` / `published-clinical-note`.
  - Funder is not in calendar events; classify by fee colour via `funder/fee/data`.
