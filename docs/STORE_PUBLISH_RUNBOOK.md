# Store Publish — Credential Provisioning + Activation Runbook

This runbook walks the operator of `rastarbobo/litoral-extension` through
provisioning the 6 GitHub Actions secrets and 1 repository variable required
to turn on the dark-by-default store-publish workflows
(`publish-chrome.yml`, `publish-amo.yml`). Intended audience: the project
owner or operator who already has Chrome Web Store + AMO dashboard access and
the `litoral.agency` backend JWT in hand.

This file does NOT cover the manual upload fallback (that lives in
[`DEPLOYMENT.md`](./DEPLOYMENT.md) Sections B + D), the dark-by-default
workflow design (see `.github/workflows/publish-chrome.yml` and
`.github/workflows/publish-amo.yml`), or the Q5 draft-vs-public decision
rationale (see [`ROADMAP.md`](../ROADMAP.md) → Q5). It is purely the
operator-action-side companion to the workflow scaffolds: cred provision,
Q5 train/channel selection, switch flip, dry-run, real release, rollback.

## 1. Activation overview

| Resource | Where to provision | Where to paste in GitHub | What workflow reads it |
|---|---|---|---|
| `CHROME_CLIENT_ID` | Google Cloud Console → OAuth client ID | `Settings → Secrets and variables → Actions → New repository secret` | `publish-chrome.yml` |
| `CHROME_CLIENT_SECRET` | Google Cloud Console → OAuth client secret | same | `publish-chrome.yml` |
| `CHROME_REFRESH_TOKEN` | Google offline-grant consent flow (browser) | same | `publish-chrome.yml` |
| `CHROME_EXTENSION_ID` | derived from `chrome-extension/manifest.ts` `key:` (value: `ajmoginkbgagpiap`) | same | `publish-chrome.yml` |
| `AMO_API_KEY` | AMO Developer Hub → API Credentials panel | same | `publish-amo.yml` |
| `AMO_API_SECRET` | AMO Developer Hub → API Credentials panel | same | `publish-amo.yml` |
| `ENABLE_STORE_PUBLISH` (variable, not secret) | n/a — repo-side switch | `Settings → Secrets and variables → Actions → Variables tab → New repository variable` | both workflows' top-level `if:` gate |
| `CHROME_PUBLISH_TARGET` (optional variable) | n/a — Q5 train selector | same Variables tab | `publish-chrome.yml` `env:` |
| `AMO_CHANNEL` (optional variable) | n/a — Q5 channel selector | same Variables tab | `publish-amo.yml` `env:` |

All names are case-sensitive. Secrets are redacted in logs; variables are
not — do NOT paste a secret value into the Variables tab by mistake.

## 2. Provision Chrome Web Store credentials

### 2.1 Open Google Cloud Console

Navigate to <https://console.cloud.google.com>. Sign in with the Litoral
Agency operator Google account that owns (or will own) the Chrome Web Store
item. Either reuse an existing project named for the publisher (e.g.
`litoral-extension`) or create a new one:

```
Create Project → Project name: litoral-extension → CREATE
```

Note the **Project number** — you do not strictly need it for the workflow,
but Google Cloud Support will ask for it if a token exchange start failing.

### 2.2 Enable the Chrome Web Store Publish API

In the project selected above:

```
 ☰ → APIs & Services → Library → search "Chrome Web Store Publish API" → ENABLE
```

The API identifier is `chromewebstore.googleapis.com`. If the ENABLE button
is greyed out, the project is not yet on a billable account — link a
billing account (the Publish API is free at publisher scale, but Google
requires the link to enable any API).

### 2.3 Configure the OAuth consent screen

```
 ☰ → APIs & Services → OAuth consent screen → User type: External → CREATE APP
```

Fill in the mandatory fields:

- App name: `litoral-extension`.
- User support email: operator address.
- Developer contact information: operator address (used for
  re-verification reminders — keep it monitored).
- Scopes: add `https://www.googleapis.com/auth/chromewebstore` ONLY.
  Do not add `userinfo.email` or any other scope — the Publish API flow
  does not need them and reviewers will bounce over-broad scopes.

Click **SAVE AND CONTINUE**. The app stays in "Testing" — you do NOT need
to push it to "In production". The `chromewebstore` scope is restricted, so
you must add the operator account to the **Test users** list (same page,
bottom section → **+ ADD USERS** → paste the operator address → **SAVE**).

### 2.4 Create OAuth client credentials

```
 ☰ → APIs & Services → Credentials → + CREATE CREDENTIALS → OAuth client ID
  → Application type: Web application
  → Name: litoral-extension-publish
  → Authorized redirect URIs: https://developers.google.com/oauthplayground/
  → CREATE
```

The redirect URI is the OAuth2 Playground, used once in 2.5 to obtain the
offline refresh token. You can remove this redirect URI after the grant —
the refresh token remains valid for the lifetime of this OAuth client.

Note down the resulting **Client ID** and **Client secret** — these map to
GitHub secrets `CHROME_CLIENT_ID` and `CHROME_CLIENT_SECRET` respectively.

### 2.5 Run the offline-grant consent flow

Open <https://developers.google.com/oauthplayground/> in a browser where the
operator Google account is signed in. In the top-right gear icon, enable
**Use your own OAuth credentials** and paste the Client ID + Client Secret
from 2.4.

In the step-1 panel:

- Enter this exact scope: `https://www.googleapis.com/auth/chromewebstore`.
- Click **Authorize APIs**. The browser redirects to Google consent.
  Approve the prompt.

The URL the playground opens will look like:

```
https://accounts.google.com/o/oauth2/v2/auth?...&access_type=offline&prompt=consent&...
```

The query-string parameters matter — the playground appends them for you,
but note what they do:

- `access_type=offline` — instructs Google to return a `refresh_token`
  alongside the access token. Without it, you only get a short-lived
  access token.
- `prompt=consent` — forces the consent screen even if the user has
  previously granted the scope. This is what makes Google issue a NEW
  refresh token (refresh tokens are issued once per consent; without
  `prompt=consent`, a re-grant silently reuses the existing token's owner
  record and you may see no refresh token returned).

After consenting, click **Exchange authorization code for tokens** in
step-2 of the playground. The response includes both an `access_token`
(short-lived, ~1h) and a `refresh_token` (long-lived, no expiry unless
explicitly revoked). Copy the `refresh_token` — this is the value for
GitHub secret `CHROME_REFRESH_TOKEN`.

> If step-2 returns an `access_token` but no `refresh_token`, you reused
> an existing grant. Revoke at <https://myaccount.google.com/permissions>,
> wait ~5 minutes, and re-run 2.5 with `prompt=consent` confirmed in the
> URL.

### 2.6 Map credentials to GitHub secrets

You should now have three values from 2.4 and 2.5:

| Value | GitHub secret name |
|---|---|
| OAuth client ID (from 2.4) | `CHROME_CLIENT_ID` |
| OAuth client secret (from 2.4) | `CHROME_CLIENT_SECRET` |
| Long-lived refresh token (from 2.5) | `CHROME_REFRESH_TOKEN` |

Keep them on hand for 2.8.

### 2.7 Look up the Chrome extension ID

For the Litoral extension the ID is deterministic and already known:

```
ajmoginkbgagpiap
```

This ID is the lowercase first-128-bits-of-SHA256 of the public key
declared in the `key:` field of `chrome-extension/manifest.ts:40` (refer to
[`DEPLOYMENT.md`](./DEPLOYMENT.md) A.5 step 5 for the verification path).
The operator does NOT generate this ID by uploading a packed `.crx` or
shipping via `chrome://extensions`; the ID is fixed for the lifetime of
this project.

You must register a store item with THIS exact ID before the workflow can
upload to it:

1. Navigate to <https://chrome.google.com/webstore/devconsole>.
2. Sign in with the same operator Google account that owns the OAuth client
   from 2.4.
3. Click **New Item** → upload any zip built off the current `main`
   (e.g. `dist-zip/extension-v0.6.4.zip` from `pnpm zip`).
4. After the upload, the dashboard shows the new item's ID — it MUST be
   `ajmoginkbgagpiap`. If it is different, the manifest `key:` field was
   edited or removed; stop and reconcile the manifest before continuing.

### 2.8 Paste the four Chrome secrets into GitHub

Navigate to the repo on GitHub:

```
rastarbobo/litoral-extension → Settings → Secrets and variables → Actions → New repository secret
```

Create four secrets, one per value. Names are case-sensitive:

1. Name: `CHROME_CLIENT_ID` — Value: paste from 2.4.
2. Name: `CHROME_CLIENT_SECRET` — Value: paste from 2.4.
3. Name: `CHROME_REFRESH_TOKEN` — Value: paste from 2.5.
4. Name: `CHROME_EXTENSION_ID` — Value: `ajmoginkbgagpiap` (literal).

After all four are present, the Chrome workflow will no longer skip on the
secrets-gate. The `ENABLE_STORE_PUBLISH` variable gate still applies (see
Section 5).

## 3. Provision Firefox AMO credentials

### 3.1 Sign in to AMO Developer Hub

Navigate to <https://addons.mozilla.org/developers/>. Sign in with the
Litoral Agency AMO account that owns the slug `litoral-agency-publisher`.
If you cannot see the add-on on the dashboard, the operator account is the
wrong one — confirm with the project owner before continuing.

### 3.2 Open the add-on edit page

From the developer dashboard, click the **litoral-agency-publisher** row.
The URL fragment of the edit page should be:

```
https://addons.mozilla.org/developers/addon/litoral-agency-publisher/edit
```

If the slug in the URL differs from `litoral-agency-publisher`, the slug
was renamed — confirm against `store-assets/firefox/listing.json` and the
AMO workflow's slug input; do not proceed with a stale slug or the
`web-ext sign` step will fail with `UNAUTHENTICATED` (see Section 9).

### 3.3 Generate an API key + secret pair

On the add-on edit page:

```
(left sidebar) → API Credentials / JWT Authentication → Generate new key
```

AMO issues pairs as `_key` (a UUID, lowercase, hyphen-separated) and
`_secret` (a long string of URL-safe characters). The pair is bound to the
operator account, NOT to the add-on — the same key/secret can sign any
add-on that the account owns.

> AMO shows the secret ONCE at generation time. If you lose it, you must
> regenerate (the old key is invalidated immediately). Store it before
> leaving the panel.

### 3.4 Map credentials to GitHub secrets

| Value | GitHub secret name |
|---|---|
| API key (UUID format) | `AMO_API_KEY` |
| API secret (long string) | `AMO_API_SECRET` |

### 3.5 Paste the two AMO secrets into GitHub

Same path as 2.8 — `Settings → Secrets and variables → Actions → New
repository secret`. Names are case-sensitive:

1. Name: `AMO_API_KEY` — Value: paste the UUID from 3.3.
2. Name: `AMO_API_SECRET` — Value: paste the long string from 3.3.

After both are present, the AMO workflow will no longer skip on the
secrets-gate. The `ENABLE_STORE_PUBLISH` variable gate still applies (see
Section 5).

## 4. Decide Q5: draft vs full-public publish

Q5 is the open decision on whether the first release goes to a
testers-only audience (draft) or to the full public. The workflows default
to **draft** so a fresh fork cannot accidentally publish publicly — you
must opt-in explicitly.

For the purposes of this runbook:

- **Draft** for Chrome = `publishTarget=trustedTesters`. The item is
  visible only to accounts you add to the testers list in the DevConsole.
- **Draft** for AMO = `--channel=unlisted`. The signed add-on installs
  via direct URL but does not appear in AMO search.
- **Public** for Chrome = `publishTarget=default`. The item is
  discoverable in the Chrome Web Store search and listings.
- **Public** for AMO = `--channel=listed`. The signed add-on appears in
  AMO search and is the channel AMO reviews for listed submissions.

| Train/Channel | Visibility | When to choose |
|---|---|---|
| Chrome `trustedTesters` | testers-only (named list) | First publish; smoke-test with internal accounts before public review. |
| Chrome `default` | full public | After reviewer approval on the testers build and an operator smoke-test pass. |
| AMO `unlisted` | install-via-link only | First publish; no AMO search exposure, lower review friction. |
| AMO `listed` | full public + AMO search | After the unlisted build is signed cleanly and an operator smoke-test pass. |

Recommended default for the first publish: **draft both** (Chrome
`trustedTesters`, AMO `unlisted`). Flip to public on a subsequent release
after reviewer approval + a manual smoke-test on the testers / unlisted
build.

### 4.1 How to choose once decided

The workflows read their train/channel from the job-level `env:` block,
falling back to a repo variable if present, falling back to the fail-safe
draft default otherwise.

For Chrome — pick ONE of:

- Add a repo variable `CHROME_PUBLISH_TARGET` with value `default` to go
  public (or `trustedTesters` to be explicit). Path: `Settings → Secrets
  and variables → Actions → Variables tab → New repository variable`.
- OR edit `.github/workflows/publish-chrome.yml` and set the `env:
  CHROME_PUBLISH_TARGET:` value inline. This is the right choice when you
  want the choice pinned to the workflow file rather than the repo
  settings.
- OR do nothing — the workflow defaults to `trustedTesters`.

For AMO — pick ONE of:

- Add a repo variable `AMO_CHANNEL` with value `listed` to go public (or
  `unlisted` to be explicit).
- OR edit `.github/workflows/publish-amo.yml` and set the `env:
  AMO_CHANNEL:` value inline.
- OR do nothing — the workflow defaults to `unlisted`.

Both fail-safe to draft. You cannot accidentally publish publicly by
omitting the variable.

## 5. Flip the dark-by-default switch

Until the `ENABLE_STORE_PUBLISH` repository variable is set, BOTH
workflows guarantee a no-op on every push and every release event — only
the per-step skip-notices fire and the `publish` job does not run.

To turn it on:

```
rastarbobo/litoral-extension → Settings → Secrets and variables → Actions → Variables tab → New repository variable
  Name:  ENABLE_STORE_PUBLISH
  Value: true
```

Notes:

- The value is the literal string `true`. No quotes, no whitespace, no
  trailing newline. GitHub Variables panel strips surrounding whitespace
  but copy-paste from a quoted document can sneak in a newline — paste,
  then re-open the variable to confirm.
- The workflow gate is `if: vars.ENABLE_STORE_PUBLISH == 'true'` — this is
  a string comparison, so `True`, `TRUE`, or `1` will NOT match. Match
  the literal exactly.
- This is a variable (visible in logs and in the UI to anyone with read
  access) — do NOT paste a secret value into the Variables tab. Variables
  exist precisely because they are not redacted.

## 6. Verify on a dry-run trigger

Both workflows expose a `workflow_dispatch` input `dry_run` for an
operator-triggered test that does NOT call the publish endpoint.

### 6.1 Chrome dry-run

```
rastarbobo/litoral-extension → Actions tab → "Publish to Chrome Web Store" workflow → Run workflow
  → dry_run: true
  → branch: main
  → Run workflow
```

The Chrome workflow will, in order:

1. Pass the `if: ENABLE_STORE_PUBLISH == 'true'` top-level gate (otherwise
   the whole run is skipped).
2. Checkout the repo + install pnpm + `pnpm install --frozen-lockfile`.
3. `pnpm zip` — deterministic rebuild of
   `dist-zip/extension-v0.6.4.zip` (replace `0.6.4` with the current
   version; verify via `node -p "require('./package.json').version"`).
4. Resolve the artifact path under `dist-zip/`.
5. OAuth2 token exchange: POST to
   `https://oauth2.googleapis.com/token` with the refresh token + client
   credentials → on success emits
   `::notice::Chrome OAuth2 token exchange OK`.
6. `Items.upload` PUT to
   `https://chromewebstore.googleapis.com/upload/v1.1/items/{extensionId}`
   → on success emits `::notice::Chrome Items upload OK`.
7. `DRY_RUN=true` SKIPS the `Items.publish` call and emits a notice
   instead. The upload itself is NOT rolled back — the new package is
   sitting on the DevConsole as a draft version after this run.

### 6.2 AMO dry-run

```
Actions tab → "Publish to Firefox AMO" workflow → Run workflow
  → dry_run: true
  → branch: main
  → Run workflow
```

The AMO workflow will:

1. Pass the same `if: ENABLE_STORE_PUBLISH == 'true'` gate.
2. Checkout + install + `pnpm zip:firefox` →
   `dist-zip/extension-v0.6.4.xpi`.
3. Resolve artifact path.
4. `web-ext sign --api-key … --api-secret … --channel=unlisted` — this
   ALWAYS signs for real. AMO has no real dry-run; the `dry_run=true`
   input only suppresses the post-sign `web-ext` listing PATCH, it does
   NOT suppress the `sign` call.

After the AMO dry-run, you MUST manually unlist / remove the signed
version on the AMO Developer Hub so a reviewers eyes do not see a stray
build. Path:

```
https://addons.mozilla.org/developers/addon/litoral-agency-publisher/versions
  → click the version just signed → "Delete version" or set status to "Disabled"
```

## 7. Verify on a real release trigger

Once Sections 2-5 are done and a dry-run has gone green, the workflow will
fire automatically on the next release. End-to-end flow:

1. A conventional-commit lands on `main` (e.g. `feat: …`, `fix: …`).
2. `.github/workflows/release.yml` fires on `push: [main]`.
3. The `release.yml` `bump` job derives the next version, commits the
   package.json bump, tags `vX.Y.Z`.
4. The `release.yml` `build` matrix job runs in parallel for `chrome` +
   `firefox`, uploads the zips as workflow artifacts.
5. The `release.yml` `release` job publishes the GitHub Release with the
   `extension-vX.Y.Z.zip` and `extension-vX.Y.Z.xpi` attached.
6. The GitHub `release.published` event fires BOTH publish workflows in
   parallel — they pick up the same Release assets and call the store
   APIs.

Watch the run logs for `::error::` lines — every error line in the
publish workflows is operator-actionable (see Section 9). When in doubt,
re-run the failed job in isolation:

```
Actions tab → the failed workflow run → Re-run failed jobs
```

or re-run the entire run from the top:

```
Actions tab → the failed workflow run → ↻ Re-run all jobs
```

Re-runs are safe — both workflows are idempotent at the upload + publish
level (the store APIs treat an upload of the same version as an update in
place, and a publish of an already-published version as a no-op).

## 8. Rollback / disable

To turn the workflows back off for any reason (cred rotation, bad release,
store-policy review pause):

```
rastarbobo/litoral-extension → Settings → Secrets and variables → Actions → Variables tab
  → ENABLE_STORE_PUBLISH → Delete (or set to any value other than the literal string "true")
```

Future runs of both workflows will skip the `publish` job entirely. Each
workflow still emits per-step skip-notices in the run log so you can
confirm the gate is what skipped them (and not an unrelated failure).

The 6 secrets remain valid and can be re-activated by re-adding the
variable — you do NOT need to re-provision credentials to roll forward
again. If you are rotating the underlying Google Cloud OAuth client or the
AMO key/secret (rather than just pausing), follow Sections 2 and 3 again
and overwrite the existing GitHub secret values in-place (use the same
secret names; do NOT delete-and-recreate, since workflow YAMLs reference
the names).

## 9. Troubleshooting

- **401 from OAuth2 token exchange** — wrong `CHROME_CLIENT_ID`,
  `CHROME_CLIENT_SECRET`, or `CHROME_REFRESH_TOKEN`. Refresh tokens are
  scoped to the OAuth client that issued them; if the OAuth client was
  deleted and recreated in Google Cloud Console (even with the same
  client ID), the refresh token from the old client is invalid. Re-run
  Section 2.5 with the new client to mint a new refresh token.
- **403 from `Items.upload`** — wrong `CHROME_EXTENSION_ID`. Verify the
  value in GitHub secrets against the ID shown in `chrome://extensions`
  with Developer Mode on after loading `dist/` unpacked. For Litoral the
  expected value is `ajmoginkbgagpiap` (see Section 2.7).
- **403 / 412 from `Items.publish`** — the package was uploaded but is
  not yet publishable for this user. Either the item is still in draft
  review, or the previous version was rejected. Open the Chrome Web Store
  Developer Dashboard and resolve the review state before re-running.
- **`web-ext sign` failing with `INVALID_JWT`** — secret mismatch. The
  `AMO_API_KEY` / `AMO_API_SECRET` pair must match exactly the pair shown
  when you generated the key in Section 3.3. If the secret was lost, the
  only fix is to regenerate a new pair and overwrite both GitHub secrets
  (the old key is invalidated automatically on regeneration).
- **`web-ext sign` failing with `UNAUTHENTICATED` for
  `litoral-agency-publisher`** — slug mismatch. The slug the workflow
  sends and the slug AMO knows must match byte-for-byte. Verify at
  <https://addons.mozilla.org/developers/addon/litoral-agency-publisher/edit>
  — if the URL 404s, the slug was renamed; re-provision against the new
  slug or rename it back.
- **Workflow does not fire on release event** — most likely
  `ENABLE_STORE_PUBLISH` was set AFTER the release tag was created. The
  gate is evaluated at workflow-pickup time, not at tag time — if the
  variable was missing when the `release.published` event fired, the
  workflow never starts. Test in isolation with a `workflow_dispatch`
  run (Section 6) to confirm cred/gate state, then push a new `chore:`
  commit to `main` to trigger a fresh release.
- **Job appears as `failure` with no `::error::` lines** — was the
  `if: ENABLE_STORE_PUBLISH == 'true'` gate tripped? GitHub Actions reports
  a workflow as `failure` even when all jobs were skipped due to a job
  `if:` that evaluated false. Open the run → click the skipped job →
  click "Set up job" → the log line "Skip job due to: if expression
  evaluated to false" confirms the gate tripped. Add the variable (Section
  5) and re-run.

## 10. Cross-references

- `.github/workflows/publish-chrome.yml` — Chrome Web Store publish workflow definition.
- `.github/workflows/publish-amo.yml` — Firefox AMO publish workflow definition.
- [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md) Sections B + D — manual fallback
  for Chrome and AMO uploads while Phase 3.2 / 3.3 secrets are still
  being provisioned.
- [`ROADMAP.md`](../ROADMAP.md) Phase 3.2 (Chrome) / Phase 3.3 (AMO) /
  Q5 (draft-vs-public decision).
- `chrome-extension/manifest.ts` — the `key:` field that produces the
  deterministic Chrome extension ID `ajmoginkbgagpiap`.
- `packages/dev-utils/lib/manifest-parser/impl.ts` — Firefox gecko id
  auto-injection on the `CLI_CEB_FIREFOX=true` build path (gecko id:
  `litoral-publisher@litoral.agency`).
