# Deployment Runbook

This runbook walks an operator through shipping the Litoral Agency Publisher
extension to the **Chrome Web Store** and **Firefox AMO**. It is split into
two parallel browser tracks (Chrome: Sections A-B, Firefox: Sections C-D),
followed by shared sections on release cadence (E) and rollback (F).

> The top-level `README.md` already covers the build scripts table, CI/CD
> overview, and branch strategy at a high level. This file fills in the
> operator-step specifics and is honest about what is currently manual vs.
> what the CI workflow will do once Phase 3.2 / 3.3 secrets land (Q5 still
> open — see `ROADMAP.md`).

The extension is a **thin client** — it does not own campaign state or
auth identity. All `fetch` calls hit the external backend at
`https://litoral.agency/api/extension/*` (see `chrome-extension/src/config.ts`).
Deployment of the extension itself therefore does NOT touch the backend; the
backend lives in a separate Cloudflare-Worker repo.

## Prerequisites

- Node 22.15.1 (matches `.nvmrc`), pnpm 10.11.0 (matches
  `package.json#packageManager`; run `corepack enable` if your shell does
  not pick up pnpm after install).
- Operator Google account that owns the Chrome Web Store item.
- Operator AMO account that owns the slug `litoral-agency-publisher` (verify
  with the project owner if unknown — Q5-adjacent).
- For store-listing copy: `store-assets/{chrome,firefox}/listing.json`.
  Some `__TODO__` markers may still be present in the listing fields — when
  subagent Y's parallel Phase 4.1 work has merged, replace any remaining
  `__TODO__` with finalized operator-judgement copy before upload.

---

## Section A — Build (Chrome)

### A.1 Local build verification

Before producing the artifact the operator will upload, confirm the repo is
green locally:

```bash
pnpm lint && pnpm type-check && pnpm test:unit && pnpm e2e:firefox
```

Expected (as of this writing):

- `pnpm lint` → **19/19** turbo tasks (`turbo lint --continue`).
- `pnpm type-check` → **18/18** turbo tasks (`turbo type-check`).
- `pnpm test:unit` → **102/102** tests pass (73 background + 29 content).
- `pnpm e2e:firefox` → 6 extension-page specs pass on Firefox (Phase 2.3
  Firefox-only CI matrix per Q7 — see `TROUBLESHOOTING.md` for why Chrome
  E2E is not on CI).

If anything regresses, stop and file a `fix:` commit before continuing.

### A.2 Build the production artifact

```bash
pnpm zip
```

Outputs `dist-zip/extension-v${version}.zip`, where the filename is
deterministic — `${version}` is read from the root `package.json` by
`packages/zipper/index.mts`'s walk-up root-marker (it finds the directory
containing `pnpm-workspace.yaml`). Re-runs of the same commit produce
byte-identical archive filenames, which is what makes GitHub Release
attachments idempotent across re-runs.

### A.3 Verify the zip contents

```bash
unzip -l dist-zip/extension-v*.zip | head -30
```

Expected entries: `manifest.json`, `popup/index.html`, `popup/index.css`,
`popup/index.js`, content-script bundles per platform, `background.js`
(the compiled service worker — entry declared in
`chrome-extension/manifest.ts:23`), `icon-34.png`, `icon-128.png`, and the
injected `content.css`. No source maps or `src/` paths should appear.

### A.4 Verify the manifest inside the zip

```bash
unzip -p dist-zip/extension-v*.zip manifest.json | jq .version
```

Expected: a quoted semver string that matches `node -p
"require('./package.json').version"` exactly. If it does not match, the
build was run against a stale package.json — re-run after `pnpm install`
and a fresh `git pull`.

### A.5 Smoke-test the artifact as an unpacked extension

Point Chrome at the unpacked `dist/` directory, **NOT the zip** — Chrome
will not load a zip directly:

1. Open `chrome://extensions`.
2. Toggle **Developer Mode** on (top-right).
3. Click **Load unpacked**.
4. Select the `dist/` directory in the repo root.
5. The extension should load with a deterministic ID (`ajmoginkbgagpiap`)
   — the `key` field in `chrome-extension/manifest.ts:40` pins it.
6. Click the Litoral action icon → popup opens → paste your
   `litoral.agency` operator JWT token in the CONNECT card → click
   **Connect**. Backend `/api/extension/queue` must return 200 within one
   poll cycle (≤ 20 min default cadence).

---

## Section B — Upload to Chrome Web Store (currently manual; Phase 3.2 will automate)

### B.1 Open the DevConsole

Navigate to <https://chrome.google.com/webstore/devconsole>. Sign in with
the Litoral Agency operator Google account that owns the
`CHROME_EXTENSION_ID`.

### B.2 Select or create the item

- For an existing item: click the Litoral Agency Publisher row.
- For a first-time upload: click **New Item**. First-time upload requires
  `store-assets/chrome/icon-128.png` plus at least one screenshot dropped
  into `store-assets/chrome/screenshots/` per
  `store-assets/chrome/screenshots/README.md` (1-5 files, 1280×800
  recommended, ≤ 16 MB each).

### B.3 Upload the package file

Click **Package file** → upload `dist-zip/extension-v${version}.zip` from
A.2.

### B.4 Fill in / verify the listing fields

Pull the listing metadata from `store-assets/chrome/listing.json`:

| Field | Source | Notes |
|---|---|---|
| `name` | `listing.json#name` | Litoral Agency Publisher |
| `description` | `listing.json#description` | ≤ 132 chars per Chrome policy |
| `category` | `listing.json#category` | `PRODUCTIVITY` |
| `homepage_url` | `listing.json#homepage_url` | `__TODO__` if not yet finalized |
| `privacy_practice_notes` | `listing.json#privacy_practice_notes` | Document storage use honestly (`chrome.storage.sync` auth token + `chrome.storage.local` telemetry) |
| Screenshots | `store-assets/chrome/screenshots/*` | Drop PNG/JPG into the dir and update `screenshots/README.md` index |

Replace any remaining `__TODO__` placeholders if not already filled by the
parallel Phase 4.1 listing-copy work. If a `__TODO__` still remains at
upload time, the operator must decide: leave it un-filled (which will
cause Chrome's review to bounce) or fill with a first-draft value and
note the decision in the changelog.

### B.5 Submit for review

Click **Submit for review**. Typical Chrome Web Store review time is 1-3
business days, longer for the very first submission. The item stays in
"draft" until approved.

### B.6 Q5 deployment-mode decision (forward note for Phase 3.2)

Sub-Phase 3.2 will automate this entire Section B via the Chrome sub-step
of `release.yml` once the following all land:

- **Q5 decision** resolved: `publishTarget=trustedTesters` (draft /
  testers-only) vs `publishTarget=default` (public publish). Q5 is still
  open in `ROADMAP.md` as of this writing.
- **4 GitHub Secrets** injected into the repo:
  `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`, `CHROME_REFRESH_TOKEN`,
  `CHROME_EXTENSION_ID`.
- **`listing-sync.yml` Chrome step** rewritten from the current
  best-effort `Items.publish?publishTarget=trustedTesters` PATCH to the
  proper `items.update` / `chrome-webstore-upload` package surface for
  in-place listing edits. The Phase 3.5 caveat documenting this is in
  `AGENTS.md` → CI/CD and Deployment.

Until those three land, Section B is **manual** on every `main` push.

---

## Section C — Build (Firefox)

### C.1 Local build verification

Same as A.1 — `pnpm lint && pnpm type-check && pnpm test:unit && pnpm
e2e:firefox`. Same expected counts.

### C.2 Build the Firefox artifact

```bash
pnpm zip:firefox
```

Outputs `dist-zip/extension-v${version}.xpi`. Firefox is selected via the
`CLI_CEB_FIREFOX=true` env flag — verify propagation:

```powershell
Test-Path chrome-extension/manifest.firefox.ts
# Expected: False — there is NO per-browser manifest file.
```

The env flag flows from `package.json`'s `"zip:firefox": "pnpm build:firefox
&& pnpm -F zipper zip"` → `"build:firefox": "pnpm set-global-env
CLI_CEB_FIREFOX=true && pnpm base-build"` into
`bash-scripts/set_global_env.sh` → `packages/env/lib/const.ts`'s
`IS_FIREFOX = process.env['CLI_CEB_FIREFOX'] === 'true'`. The flag is then
read by the Vite manifest plugin
(`chrome-extension/utils/plugins/make-manifest-plugin.ts:2`), which calls
`ManifestParser.convertManifestToString(manifest, IS_FIREFOX)` from
`packages/dev-utils/lib/manifest-parser/impl.ts`.

The Firefox-specific manifest transformations (verified by reading
`impl.ts:4-29`) are:

- `background.service_worker` → `background.scripts: [...]` with
  `type: 'module'`.
- `options_page` → `options_ui.page` with `browser_style: false`.
- `content_security_policy` set to
  `{ extension_pages: "script-src 'self'; object-src 'self'" }`.
- `sidePanel` filtered out of `permissions` and `side_panel` deleted.

**Note — known gap:** The current Firefox transformation does **NOT** inject
`browser_specific_settings.gecko.id`. AMO accepts submissions without it
(AMO will mint an ID server-side), but the absence means a temporary
add-on loaded via `about:debugging` will get a fresh ID per browser
profile and the ID will differ between Chrome and Firefox. This is
honest-and-known; flag it to the project owner before the first public
Firefox submission — adding a stable gecko id is Phase 3.3 territory
(see the parallel AMO handoff in `ROADMAP.md` Q5).

### C.3 Verify the xpi contents

```bash
unzip -l dist-zip/extension-v*.xpi | head -30
```

Same expected file layout as the Chrome zip (A.3), modulo the manifest
transformation above. To confirm the Firefox build shape:

```bash
unzip -p dist-zip/extension-v*.xpi manifest.json | jq '.background'
```

Expected for Firefox: `{ "scripts": ["background.js"], "type": "module" }`
(NOT `service_worker`). The `service_worker` form would mean the env flag
did not propagate — restart from C.2.

### C.4 Smoke-test locally

Firefox does not (yet) load the `.xpi` as a permanent install without
signing, but a **temporary** add-on works:

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select the `.xpi` file at `dist-zip/extension-v*.xpi`.

> Temporary add-ons unload on browser restart. They are for smoke-test
> only, not for production use.

---

## Section D — Upload to AMO (currently manual; Phase 3.3 will automate)

### D.1 Open the AMO developer hub

Navigate to <https://addons.mozilla.org/developers/>. Sign in with the
Litoral Agency AMO account that owns the slug `litoral-agency-publisher`
(verify the slug with the project owner if unknown — Q5-adjacent).

### D.2 Pick the submission path

Click **Submit a New Add-on** → select **On this site** for the `.xpi`
upload path.

### D.3 Upload the artifact

Upload `dist-zip/extension-v${version}.xpi` from C.2.

### D.4 Fill in / verify the listing fields

Pull the listing metadata from `store-assets/firefox/listing.json`:

| Field | Source | Notes |
|---|---|---|
| `summary` | `listing.json#summary` | ≤ 250 chars per AMO |
| `description` | `listing.json#description` | Multi-paragraph; AMO renders a subset of markdown |
| `homepage.url` | `listing.json#homepage.url` | `__TODO__` if not yet finalized |
| `categories.firefox` | `listing.json#categories.firefox` | Currently `other` — consider `social-communication` if AMO exposes that path; verify with the AMO dashboard |
| `tags` | `listing.json#tags` | Comma-separated search keywords |
| `version.license` | `listing.json#version.license` | MIT (matches repo `LICENSE` + every `package.json`) |
| Screenshots | `store-assets/firefox/screenshots/*` | Drop PNG/JPG into the dir per `screenshots/README.md` (up to 10 files, 1280×800 or 1920×1080, ≤ 4 MB) |

Replace any remaining `__TODO__` placeholders if not already filled by the
parallel Phase 4.1 listing-copy work. Operator-judgement fields the
subagent had to leave open should be flagged in the changelog for the
project owner.

### D.5 Submit for review

Click **Submit for review**. AMO review time is typically < 1 business
day for listed signed versions once the metadata is filled; first-time
submission may take longer if a manual review queue is hit.

### D.6 Q5 + Phase 3.3 automation note

Sub-Phase 3.3 will automate this entire Section D via the Firefox
sub-step of `release.yml` once:

- **Q5 decision** resolved (same decision as B.6 — Q5 covers both
  browsers).
- **2 GitHub Secrets** injected into the repo: `AMO_API_KEY`,
  `AMO_API_SECRET`.

The `listing-sync.yml` Firefox sub-step's AMO REST PATCH endpoint
(`/api/v5/addons/addon/{slug}/` with HTTP Basic auth using
`AMO_API_KEY` / `AMO_API_SECRET`) is already correct per AMO docs.
Phase 3.5's Chrome-step caveat (B.6) does **NOT** apply to the Firefox
step — the AMO endpoint is officially supported for in-place listing
edits.

Until those land, Section D is **manual** on every `main` push.

---

## Section E — Release cadence

Every push to `main` triggers `.github/workflows/release.yml`. The
workflow:

1. **`bump` job** — derives the next version via
   `bash-scripts/bump_version.sh` from Conventional-Commit subjects in the
   range `<last v* tag | root commit>..HEAD`. `fix:` / `chore:` / `docs:`
   / `ci:` / `test:` / `style:` / `perf:` / `refactor:` → patch. `feat:`
   → minor. Any `BREAKING CHANGE:` footer or `!:` subject marker → major.
   The derived version is rewritten into all 24 non-`node_modules`
   `package.json` files by `bash-scripts/update_version.sh` (argv-only
   `perl -i -pe`), committed back to `main` as `github-actions[bot]` with
   `chore(release): bump version to <bare-version> [skip ci]`, and the
   `vX.Y.Z` tag is pushed.
2. **Matrix `build` job** — `chrome` and `firefox` in parallel (two
   separate jobs — Chrome and Firefox must not share a matrix because
   `pnpm clean:bundle` wipes `dist/` between builds AND Firefox's
   `set_global_env.sh` mutates `.env` in-place; a shared matrix would
   collide). Chrome job runs `pnpm zip`, Firefox runs `pnpm zip:firefox`.
   Each uploads `dist-zip/*` as `${matrix.browser}-build` workflow
   artifact.
3. **`release` job** — checks `git ls-remote --tags origin
   refs/tags/vX.Y.Z` for idempotent tag creation (no re-release of the same
   version), then `softprops/action-gh-release@v2` publishes the GitHub
   Release named `vX.Y.Z` with `dist-zip/extension-v${version}.zip` and
   `dist-zip/extension-v${version}.xpi` attached + `generate_release_notes:
   true` (auto-generates notes from PR titles).

### Manual operator action after each `main` push

Until Phase 3.2 / 3.3 land:

1. Wait for the `release.yml` run to complete and the `vX.Y.Z` GitHub
   Release to be published.
2. Download the two release attachments (`extension-v${version}.zip` and
   `extension-v${version}.xpi`).
3. Re-run **Section B** (Chrome) and **Section D** (Firefox) above.

### Idempotent re-runs

- The `release` job's `tag-check` step skips release creation if
  `refs/tags/vX.Y.Z` already exists, so a re-trigger of the workflow on
  the same commit is a no-op for the release.
- The artifact filenames are deterministic (`extension-v${version}.zip` /
  `.xpi`), so GitHub Release attaches don't churn across re-runs.
- The `bump` job's `Resolve next version` step sets `bumped=false` when
  the dry-run's `Next version:` line equals the committed version →
  skips the commit/push. A re-run with no new `main` commits will also
  see exit code 2 ("no bumpable commits") which is a valid no-op path
  (`continue-on-error: true` on the dry-run step).

---

## Section F — Rollback / unpublish

There is **no automatic rollback** in `release.yml` — the workflow
assumes monotonic forward versioning. A bad `main` commit that built +
released needs a follow-up `fix:` commit (NOT a `git revert`) as the
next semver-bump; the fix will land on the next `main` push and produce
the next `vX.(Y+1).Z` GitHub Release.

### Chrome Web Store

DevConsole → select the Litoral Agency Publisher item → **Remove from
store** (takes effect immediately; reinstatement requires re-review).

### Firefox AMO

Add-on page → **Disable this version** or **Delete add-on**:

- Disabled versions remain in the installed user's add-on manager.
- Deleted versions are uninstalled on the next browser restart for users
  who haven't pinned the add-on.

### Operator-decision checklist on a rollback

- Was the bad commit a code change or a listing-metadata change? If the
  former, ship a `fix:` commit and re-run Section B + D for the new
  version. If the latter, edit `store-assets/{chrome,firefox}/listing.json`,
  open a PR, merge to `main`, and let `listing-sync.yml` re-sync the
  metadata to the store dashboards (requires the 6 store-API secrets +
  `vars.ENABLE_LISTING_SYNC == 'true'`).
- Does the bad version need to be actively un-published in both stores
  (Sections B + D above), or is the forward-fix good enough? Default to
  un-publishing the bad version in both stores — installed users still
  get the old version but new installs will not.
- Notify the backend operator if the bad extension version was sending
  malformed marker POSTs to `/api/extension/queue/scheduled` — the stale
  lock scanner will auto-revert on the next cycle, but a heads-up avoids
  surprise alerting.
