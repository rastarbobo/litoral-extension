# Onboarding Guide

Welcome to the Litoral Agency Publisher extension. This guide walks a new
engineer from a fresh clone to a working unpacked-extension dev install,
then points you at the code paths that actually do the work.

The top-level [`README.md`](../README.md) is the canonical source for the
feature list, the workspace-layout table, the development-scripts table,
and the CI/CD overview. This file fills in the operator-facing specifics
that the README intentionally kept short.

## 1. Repo layout

One paragraph: this is a pnpm + Turborepo monorepo (workspaces declared in
`pnpm-workspace.yaml`: `chrome-extension`, `pages/*`, `packages/*`,
`tests/*`). For the canonical workspace-layout table, read
[`README.md#architecture`](../README.md#architecture). The short version:

- `chrome-extension/src/background/` is where the orchestration lives —
  the poll/claim/auth pipeline (`index.ts`), the scheduling engine
  (`scheduling-orchestrator.ts`), and the per-platform circuit breaker
  (`circuit-breaker.ts`).
- `pages/content/` is the per-platform DOM-automation surface — Facebook,
  Instagram, and Google Business Profile matchers live under
  `pages/content/src/matches/{facebook,instagram,gbp}/index.ts`, with
  shared DOM utils in `pages/content/src/shared/dom-utils.ts`. TikTok is
  still a stub.
- `pages/popup/` is the popup UI (React 19 + Tailwind 3.4 — see
  `pages/popup/src/Popup.tsx` for the 5s-interval `GET_STATE` poll + the
  `CONNECT` / `RETRY_NOW` / `CLEAR_ERRORS` handlers).
- `packages/{shared,storage,zipper,i18n,ui,env,dev-utils,hmr,tsconfig,
  vite-config,tailwindcss-config,module-manager}/` are cross-package
  shared utilities. The ones that actually matter for the publisher flow:
  `@extension/shared` (types, e.g. `CampaignPayload`, `PopupMessage`),
  `@extension/storage` (`chrome.storage` abstractions: auth + poll),
  `@extension/zipper` (deterministic archive builder), `@extension/env`
  (`IS_FIREFOX`, `IS_DEV`, `IS_PROD`, `IS_CI` from env flags).
- `bash-scripts/` is the version-bump tooling (`bump_version.sh` +
  `update_version.sh`; see the [Conventional commits cheat
  sheet](#9-conventional-commits-cheat-sheet) below).
- `.github/workflows/` is CI/CD — see [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md)
  for the deployment runbook that consumes those workflows.

## 2. Local setup

For the 5 numbered quick-start steps (prereqs, clone, install, Chrome dev
build, Firefox dev build), see
[`README.md#quick-start`](../README.md#quick-start). Add these notes:

- If your shell does not pick up `pnpm` after `pnpm install`, run
  `corepack enable` once (pnpm is pinned to `10.11.0` in
  `package.json#packageManager`; `corepack` is the official proxy).
- Verify the version matches:
  ```bash
  pnpm --version
  # Expected: 10.11.0
  ```
- Verify Node:
  ```bash
  node --version
  # Expected: v22.15.1 (matches .nvmrc; engines.node >= 22.15.1)
  ```

## 3. First-time build + load

Walk through literally:

```bash
pnpm install
pnpm zip
```

`pnpm zip` runs `pnpm build && pnpm -F zipper zip` → produces
`dist-zip/extension-v${version}.zip` AND the unpacked build at `dist/`.

Then load it into Chrome:

1. Open `chrome://extensions`.
2. Toggle **Developer Mode** on (top-right).
3. Click **Load unpacked**.
4. Select the `dist/` directory at the repo root (NOT the `.zip`).
5. The extension should load with ID `ajmoginkbgagpiap` (deterministic —
   pinned by `chrome-extension/manifest.ts:40`'s `key` field).
6. Click the Litoral action icon → popup opens. The Laundry List card is
   the **CONNECT** card. Paste your `litoral.agency` operator JWT token
   in the input and click **Connect**.

The token must be valid against the external backend at
`https://litoral.agency` (see `chrome-extension/src/config.ts`). If the
token is invalid, the background will get a 401 on the first poll,
`clearToken()` will fire, the badge will flip to 🔑 orange
(`BADGE_AUTH_REQUIRED`), and an `AUTH_REQUIRED` message will broadcast to
the popup — which re-renders the CONNECT card. See
[`docs/TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) for the full auth
loop.

## 4. Where to start reading code

Recommended order, from highest-traffic to lowest:

### (a) `chrome-extension/src/background/index.ts`

The poll/claim/auth loop + badge/notification state machine. Read the
top-of-file constants block first — every magic number lives there
inline (there is no `src/constants.ts`):

```ts
const POLL_ALARM_NAME = 'campaign-queue-poll';
const MAX_CONSECUTIVE_FAILURES = 6;
const BADGE_AUTH_REQUIRED = '🔑';
const BADGE_ERROR = '!';

const POLL_BACKOFF_STEPS = [1, 2, 5] as const;
const POLL_BACKOFF_CAP_MINUTES = 5;
const POLL_DEFAULT_PERIOD_MINUTES = 20;
```

Then walk through `chrome.alarms.onAlarm` → `checkAuthAndPoll` →
`pollForCampaigns` → `handlePollError` (the 401-`clearToken`+`🔑` path)
→ the `chrome.runtime.onMessage` listener (handles `GET_STATE`,
`CONNECT`, `RETRY_NOW`, `CLEAR_ERRORS` from the popup) →
`registerContentScripts` (registering the 4 platform content scripts
`litoral-{instagram,facebook,tiktok,gbp}-scheduler` idempotently).

### (b) `chrome-extension/src/background/scheduling-orchestrator.ts`

The scheduling engine — and the Q9 finding site. Read the top-of-file
constants block here too:

```ts
const SCHEDULING_TIMEOUT_MS = 90_000;        // 90s per campaign
const MAX_CAMPAIGNS_PER_CYCLE = 2;           // ADR-003 cap
const INTER_CAMPAIGN_DELAY_MS = 90_000;      // 90s between platforms
const TAB_LOAD_TIMEOUT_MS = 30_000;          // 30s for page load
```

Then skip ahead to lines ~146-204 in `processPendingSchedules` — the Q9
fix landed in commit `d44e18c` ("fix(orchestrator): reorder local-state
convergence before marker"). The body now runs `removeCampaign` +
per-platform telemetry (`recordPlatformSuccess` /
`recordPlatformFailure`) BEFORE the `markScheduledOnServer` call, AND
detaches the marker via `void markScheduledOnServer(...).catch(error =>
console.warn(...))` so a hung or thrown marker no longer blocks the
cycle's promise resolution. Read the inline comments at lines 146-192
— they explain WHY the reordering matters (the 90s outer timeout is
already cleared by `done()` on `SCHEDULE_COMPLETE`, so without the
reorder + detach a never-resolving marker would hang the cycle
indefinitely, the E2 test's central assertion).

### (c) `chrome-extension/src/background/circuit-breaker.ts`

Per-platform breaker with lazy-recovery semantics. `isOpen(platform)`
reads lazily — once `Date.now() >= openUntil[platform]` the breaker is
treated as CLOSED again (the recovery happens at read time, no explicit
`half-open` state). Thresholds (verified inline):

```
BREAKER_THRESHOLD = 3 consecutive failures → OPEN
BREAKER_OPEN_DURATION_MS = 15 * 60 * 1000  (~15 min)
```

State persists in `chrome.storage.local` under the `litoral-circuit-breaker`
key with `openUntil[]` + `consecutiveFailures[]` + `lastUpdatedAt`. The
constructor tolerates missing keys (forward-compat schema bumps — see
`AGENTS.md` Storage Surface).

### (d) `pages/content/src/matches/{instagram,facebook,gbp}/index.ts`

Per-platform automation grammars. Each matcher registers a
`chrome.runtime.onMessage` listener for `BackgroundToContentMessage` of
type `START_SCHEDULING`, walks the platform's scheduling page DOM,
sends back `SCHEDULING_PROGRESS` / `SCHEDULE_COMPLETE` / `SCHEDULE_FAILED`
messages. The tiktok matcher (under `pages/content/src/matches/tiktok/`)
is still a stub — see `__tests__/stubs.test.ts` for the pinned
`SCHEDULE_FAILED("Platform not yet supported (Story 6.4)")` contract.

### (e) `pages/popup/src/Popup.tsx`

Popup UI — read the 5s-interval `fetchState` callback (line ~80), the
`handleConnect` (line ~98), `handleRetryNow` (line ~117), and
`handleClearErrors` (line ~124) handlers. The popup never makes `fetch`
calls directly; it only sends `chrome.runtime.sendMessage` to the
background and renders the resulting `PollStatusPayload` snapshot.

## 5. Conventions

- [`AGENTS.md`](../AGENTS.md) is the source of truth for the
  orchestrator + subagent model this project uses for AI-assisted
  development. Read it before writing code.
- Conventional Commits is the commit convention (see the [cheat
  sheet](#9-conventional-commits-cheat-sheet) below). Do NOT commit
  unless the orchestrator explicitly asks — per the `AGENTS.md` →
  Release Workflow on Branch section.
- The `release.yml` `bump` job derives the next semver from the commit
  types in the range `<last v* tag | root commit>..HEAD` via
  `bash-scripts/bump_version.sh`, so a buried `feat:` in a `chore:`
  commit will be misclassified as patch — split commits by intent.

## 6. Testing

- `pnpm test:unit` runs Vitest in co-located `__tests__/*.test.ts` files
  via `turbo test:unit`. **102/102 tests** across two packages as of
  this writing:
  - `chrome-extension`: 73 tests (orchestrator + breaker + index.ts poll
    loop + poll-storage + scheduling E1-E3 error-injection tests).
  - `@extension/content-script`: 29 tests (facebook + instagram + tiktok
    + gbp stubs + dom-utils).
- For orchestrator + circuit-breaker specifically,
  `chrome-extension/vitest.config.ts` enforces **100% line / branch /
  function / statement coverage** on `scheduling-orchestrator.ts` and
  `circuit-breaker.ts`. The threshold block reads:
  ```ts
  coverage: {
    provider: 'v8',
    include: ['src/background/scheduling-orchestrator.ts', 'src/background/circuit-breaker.ts'],
    exclude: ['src/**/__tests__/**', 'src/**/*.d.ts'],
    reporter: ['text', 'json', 'html'],
    reportsDirectory: 'coverage',
    thresholds: {
      branches: 100,
      lines: 100,
      functions: 100,
      statements: 100,
    },
  },
  ```
  Every defensive arm in those two files is either exercised by a test
  OR marked `/* c8 ignore start -- ... */ /* c8 ignore stop */` with an
  inline comment explaining why. When adding a feature to
  orchestrator+breaker, run:
  ```bash
  pnpm --filter chrome-extension test:unit -- --coverage
  ```
  to confirm the gate still passes. **Do NOT lower the threshold.**
- `pnpm e2e:firefox` runs the Firefox E2E matrix (6 extension-page
  specs). Chrome E2E continues to work locally on headed Windows — see
  `ROADMAP.md` Q7 row for why Chrome is not on CI (Chrome 150 +
  chromedriver 150 silently rejects MV3 `extensions: [base64]` under
  WDIO v9.29.1).

## 7. Common pitfalls

- **Cross-workspace imports use `@extension/*` package names** (e.g.
  `import type { CampaignPayload } from '@extension/shared'`). Type-only
  imports MUST use `import type` — Oxlint's
  `import/consistent-type-specifier-style` rule enforces this and the
  lint job fails CI if violated.
- **`chrome.storage` does NOT support multi-key transactions.**
  Read-modify-write is unprotected across concurrent writers; the
  producer/consumer design in the orchestrator keeps each write to a
  single key (see `AGENTS.md` Storage Surface section). If you add a new
  read-modify-write over an existing key, audit concurrent readers first.
- **The external backend at `https://litoral.agency` is NOT in this
  repo** — see `chrome-extension/src/config.ts`:
  ```ts
  /** Litoral API backend base URL — Cloudflare Worker at litoral.agency. */
  export const API_BASE_URL = 'https://litoral.agency';
  ```
  Do NOT add server-side `/api/extension/queue` handler code to this
  repo; that lives in a separate Cloudflare-Worker repository. The
  endpoints `/api/extension/queue`, `/api/extension/queue/claim`, and
  `/api/extension/queue/scheduled` are called by the extension but
  served by the external backend.
- **The Chrome MV3 service-worker idle timeout is ~30s when idle.**
  `chrome.alarms` wakes the worker (alarm name
  `campaign-queue-poll`); long-running `await` chains should be
  designed so a worker restart re-runs the same path idempotently (the
  poll loop is re-entrant; the orchestrator's `isSchedulingInProgress`
  guard prevents overlapping cycles even across a restart).

## 8. Known production findings

[`ROADMAP.md`](../ROADMAP.md) → Open Questions & Decisions → **Q9** is
now ✅ Resolved (commit `d44e18c`). Read it as a learning example of
how the project pins production behavior with error-injection tests:

- Q9 documented a `markScheduledOnServer` await-ordering production
  hazard: the marker call ran BEFORE `removeCampaign` and
  `recordPlatformSuccess`, and `done()` cleared the 90s outer timeout
  on `SCHEDULE_COMPLETE`, so a never-resolving marker fetch would hang
  the cycle indefinitely.
- Q9 was **pinned, not fixed**, by test E2 in
  `chrome-extension/src/background/__tests__/scheduling-orchestrator.test.ts`
  — the test asserted the bad behavior so a future regression would be
  caught.
- Q9 was then **resolved** by fixing the orchestrator body in
  `scheduling-orchestrator.ts:146-204` — reorder local-state
  convergence before the marker + detach the marker via
  `void markScheduledOnServer(...).catch(...)`. The stale lock scanner
  on the external backend remains the auto-revert path for any marker
  that truly never landed.

This pattern — "find a production risk, pin it with a test, then split
the fix from the test" — is the project's idiom for risky behavior
changes. Follow it when you find the next one.

## 9. Conventional commits cheat sheet

Commit subject format: `<type>(<scope>)?: <imperative summary>` —
lowercase, no trailing period, ≤ 72 chars. Types observed in `git log`
on this repo:

| Type | Bump | Used for |
|---|---|---|
| `feat:` | minor | New user-facing feature |
| `fix:` | patch | Bug fix |
| `perf:` | minor | Performance improvement (treated like `feat:` by `bump_version.sh`) |
| `refactor:` | (no bump) | Internal code restructure |
| `docs:` | (no bump) | Documentation only |
| `test:` | (no bump) | Test additions or fixes |
| `ci:` | (no bump) | CI/CD config (`release.yml`, `e2e.yml`, etc.) |
| `chore:` | (no bump) | Tooling, deps, releases |
| `style:` | (no bump) | Formatting / whitespace |

### Breaking changes

Two ways to mark a breaking change — `bump_version.sh` will derive a
**major** bump from either:

- **`!:` marker on the subject**: `feat(api)!: drop v1`
- **`BREAKING CHANGE:` footer**: any commit body containing a
  `BREAKING CHANGE: <description>` footer line.

### Examples

(a) Regular fix:

```
fix(orchestrator): reorder local-state convergence before marker

removeCampaign + recordPlatformSuccess now run BEFORE markScheduledOnServer
so a hung marker fetch can no longer block local-state convergence. The
marker is detached via `void markScheduledOnServer(...).catch(...)`.
```

(b) Breaking change:

```
feat(api)!: drop v1

BREAKING CHANGE: the v1 /api/extension/queue surface is removed;
all callers must move to v2.
```

### Version derivation

`bash-scripts/bump_version.sh` parses every commit subject + body in
the range `<last v* tag | root commit>..HEAD`. Non-bumpable types
(`refactor:` / `style:` / `docs:` / `test:` / `ci:` / `chore:`) are
skipped. **Highest bump in range wins**: a `feat:` anywhere in the range
forces a minor bump even if everything else is `fix:`. When you commit,
split by intent — a `feat:` buried in a `chore:` commit will be
misclassified as patch.
