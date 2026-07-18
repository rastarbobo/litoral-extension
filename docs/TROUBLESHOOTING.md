# Troubleshooting FAQ

Short FAQ covering the most common operator and developer-facing
runtime/CI issues. Each entry links back to the source-of-truth file so
you can verify the claim and patch behavior.

---

## Q: Popup says "AUTH_REQUIRED" immediately after install

Open the popup, paste your Litoral Agency operator JWT in the CONNECT
card, and click **Connect**. The token must be valid against the
external backend at `https://litoral.agency` — verify by hitting
`https://litoral.agency/api/extension/queue` with `curl` (expect 200
with your `Authorization: Bearer <token>` header).

If the token is invalid, the background script will receive a 401 on
the first poll, `extensionAuthStorage.clearToken()` will fire, the
badge will flip to 🔑 orange (`BADGE_AUTH_REQUIRED`), and an
`AUTH_REQUIRED` message will broadcast to the popup. This is the
documented 401-`clearToken`+`🔑`+`AUTH_REQUIRED` path — see
`chrome-extension/src/background/index.ts` `handlePollError` (lines
~230-250) for the canonical implementation. Re-enter the token via the
popup's CONNECT card.

---

## Q: Badge is stuck on red `!`

6 consecutive poll failures have fired the
`litoral-connection-error` notification + the red `!` badge
(`MAX_CONSECUTIVE_FAILURES = 6` in `index.ts`). Two recovery paths:

- Click **Clear Errors** in the popup → bulk-reset telemetry, failure
  counter, and every per-platform breaker via `popupBreaker.resetAll()`
  (handler in `Popup.tsx`, message type `CLEAR_ERRORS`).
- Click **Retry Now** in the popup → kicks an immediate poll off the
  default cadence (handler in `Popup.tsx`, message type `RETRY_NOW`).

If neither holds, check the backend health:

```bash
curl -i https://litoral.agency/api/extension/queue
```

- **401** → your token expired; re-enter via the popup's CONNECT card.
- **5xx or network hang** → backend is down; the backoff cadence is
  `1` → `2` → `5` → `5` min capped (`POLL_BACKOFF_STEPS = [1, 2, 5]`,
  `POLL_BACKOFF_CAP_MINUTES = 5` in `index.ts:41-42`). 6 failures is
  the notification threshold; the 7th and later failures are
  **idempotent** — no duplicate notification (the path is gated on
  `failures >= MAX_CONSECUTIVE_FAILURES` hit, and `recordFailure`
  increments past it).

---

## Q: A campaign is "stuck" in the pending queue

The poll handler adds claimed campaigns to `pendingSchedules` in
`chrome.storage.local`; the orchestrator processes the queue with
`MAX_CAMPAIGNS_PER_CYCLE = 2` per invocation, sequential, with
`INTER_CAMPAIGN_DELAY_MS = 90_000` between platforms
(`scheduling-orchestrator.ts:37-39`).

If a campaign never reschedules, check the per-platform breaker in the
popup's per-platform status badges — `breaker_open` (the 🔴 icon) means
the platform has logged `BREAKER_THRESHOLD = 3` consecutive scheduling
failures and is OPEN for `BREAKER_OPEN_DURATION_MS = 15 * 60 * 1000`
(~15 min, see `circuit-breaker.ts`). Wait it out (lazy recovery on the
next `isOpen` read once `Date.now() >= openUntil[platform]`), or click
**Clear Errors** to force `popupBreaker.resetAll()`.

---

## Q: A platform tab opens but nothing happens

The content script attached to the scheduling page communicates with
the background via `chrome.tabs.sendMessage` using messages of type
`START_SCHEDULING` / `SCHEDULING_PROGRESS` / `SCHEDULE_COMPLETE` /
`SCHEDULE_FAILED`. If you don't see a `SCHEDULE_COMPLETE` within 90
seconds, the orchestrator times out with `SCHEDULING_TIMEOUT_MS =
90_000` (`scheduling-orchestrator.ts:37`) and marks the campaign failed
with reason `timeout`.

Open DevTools on the scheduling tab (right-click → Inspect) and check
the content-script console logs. All content-script logs are prefixed
with `[Litoral]` so they are easy to filter against the platform's own
noise.

---

## Q: The marker `fetch` hangs — campaign gets removed anyway?

Yes, since the Q9 fix landed in commit `d44e18c`. The orchestrator body
in `scheduling-orchestrator.ts:146-204`:

1. Runs `extensionPollStorage.removeCampaign(campaign.campaignId)` and
   per-platform telemetry (`recordPlatformSuccess` /
   `recordPlatformFailure`) BEFORE the `markScheduledOnServer` call —
   local-state convergence no longer gated on the marker fetch.
2. Detaches the marker via `void markScheduledOnServer(...)` with a
   `.catch(error => console.warn(...))` handler — a hung or thrown
   marker fetch no longer blocks the cycle's promise resolution.

The stale lock scanner on the external backend remains the auto-revert
path for any marker that truly never landed — the local state already
converged, so the next poll cycle will not see this campaign in
`pendingSchedules` even if the server-side stale-lock state lags.

See `ROADMAP.md` → Open Questions & Decisions → Q9 for the full audit
report and the test E2 that pinned the original behavior.

---

## Q: Firefox build doesn't match Chrome

Firefox is selected via the `CLI_CEB_FIREFOX=true` env flag. The flag
flows from `package.json`'s `"zip:firefox"` script →
`bash-scripts/set_global_env.sh` → `packages/env/lib/const.ts`'s
`IS_FIREFOX = process.env['CLI_CEB_FIREFOX'] === 'true'`. There is **NO
`chrome-extension/manifest.firefox.ts` file** — verify with:

```powershell
Test-Path chrome-extension/manifest.firefox.ts
# Expected: False
```

The Firefox manifest transformation lives in
`chrome-extension/utils/plugins/make-manifest-plugin.ts:61` (calls
`ManifestParser.convertManifestToString(manifest, IS_FIREFOX)`) and
the actual transformation in
`packages/dev-utils/lib/manifest-parser/impl.ts` (the
`convertToFirefoxCompatibleManifest` function does:
`service_worker` → `scripts: [...]`, `options_page` → `options_ui`,
CSP injection, and `sidePanel` filtering).

Verify the Firefox build shape inside the xpi:

```bash
unzip -p dist-zip/extension-v*.xpi manifest.json | jq '.background'
# Expected: { "scripts": ["background.js"], "type": "module" }
```

If you see `service_worker` instead of `scripts`, the env flag did not
propagate — re-run from a clean shell:

```bash
pnpm zip:firefox
```

**Known gap (honest-and-uncertain):** The current Firefox transformation
does NOT inject `browser_specific_settings.gecko.id`. So:

```bash
unzip -p dist-zip/extension-v*.xpi manifest.json | jq '.browser_specific_settings.gecko.id'
# Expected (current state): null
```

AMO accepts submissions without it (mints an ID server-side), but the
absence means a Firefox temporary add-on loaded via `about:debugging`
will get a different ID per browser profile and the ID will differ from
Chrome's `ajmoginkbgagpiap`. Flag to the project owner before the first
public Firefox submission — adding a stable gecko id is Phase 3.3
territory.

---

## Q: My test fails the 100% coverage gate on orchestrator+breaker

Read `chrome-extension/vitest.config.ts` `coverage.thresholds`:

```ts
thresholds: {
  branches: 100,
  lines: 100,
  functions: 100,
  statements: 100,
},
```

Every defensive branch in `scheduling-orchestrator.ts` and
`circuit-breaker.ts` is either exercised by a test OR marked with a `c8
ignore` fence:

```ts
/* c8 ignore start -- <honest reason this branch is unreachable by design> */
... defensive arm ...
/* c8 ignore stop */
```

If you added a new branch, either:

1. **Cover it with a test.** The existing `__tests__/` directory already
   contains 36 orchestrator tests + 9 circuit-breaker tests as of this
   writing; mirror the closest existing test's shape.
2. **OR (only for unreachable-by-design defensive guards) add a `c8
   ignore` fence** with an inline comment explaining WHY the branch is
   unreachable. The comment is mandatory — a bare `/* c8 ignore start */`
   without a justification will be rejected in review.

**Do NOT lower the threshold.** The 100% gate is the locked-in Phase
2.1 acceptance criterion (see `ROADMAP.md` Phase 2.1 row).

---

## Q: The `release.yml` workflow pushed a commit to `main` but the next run skipped the bump

This is the **intended idempotency path**. The `bump` job's
`Resolve next version` step in `.github/workflows/release.yml` (lines
~62-95) reads the currently-committed root `package.json#version`, then
compares it to the dry-run's parsed `Next version:` line. The
conditional resolves `bumped=false` when either:

- **No bumpable commits** — `bump_version.sh` exits with code 2
  ("no-bumpable-commits"), which is a valid no-op path
  (`continue-on-error: true` on the dry-run step).
- **`next == committed`** — the proposed bump already matches the
  committed version (e.g. the previous run already committed the bump).
  In this case the script outputs
  `"Proposed next version ($next) equals committed version; nothing to
  bump."` and skips the commit/push.

The downstream `build` and `release` jobs still consume
`needs.bump.outputs.version` (which falls back to the committed
version when `bumped=false`), so the matrix build still runs and the
GitHub Release still publishes if the tag doesn't exist yet. A re-run
on the same `main` SHA with no new commits is therefore a no-op for
the bump step and a no-op for the release step (the `tag-check` step
sees the existing `refs/tags/vX.Y.Z` and skips release creation).
