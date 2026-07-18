# Litoral Agency Publisher Extension — AI Assistant Guidelines

Use this file for repo-specific rules. For product overview, features, setup, and deployment details, refer to `README.md` (being rewritten by Phase 4.2; if it still reads as a Chrome-extension-boilerplate README, treat it as stale).

## Agent Model: Orchestrator + Subagents

The main agent operates as an **orchestrator and a task reviewer/fixer**:

- It delegates work by spawning **subagents** to execute tasks and subtasks.
- When a task is too long or complex, it splits the task into **multiple subtasks** and delegates each to separate subagents.
- After subagents complete their work, the main agent reviews the results, fixes issues, and verifies correctness before considering the work done.
- The main agent should prefer delegation to subagents over doing large tasks directly, while still performing review, integration, and corrections itself.

## Project Context

Monorepo for **Litoral Agency Publisher** — a Chrome MV3 + Firefox WebExtension that polls an external backend for approved marketing campaigns and schedules them onto social platforms (Instagram, Facebook, TikTok, Google Business Profile) by driving each platform's logged-in browser tab via content scripts. The extension is a thin client: it does not own campaign state, scheduling rules, or auth identity.

Primary stack (verified in `package.json`):

- Package manager: **pnpm 10.11** + **Turborepo 2.5** (workspaces rooted by `pnpm-workspace.yaml`: `chrome-extension`, `pages/*`, `packages/*`, `tests/*`)
- Language: **TypeScript 5.8** strict
- Build: **Vite 6.3** (per-package; Chrome and Firefox share one Vite config gated by `CLI_CEB_FIREFOX=true`)
- Frontend: **React 19.1**, **Tailwind 3.4** (popup UI only; no app shell)
- Test: **Vitest** (unit, in co-located `*/__tests__/*.test.ts`), **WebdriverIO v9.29.1** (E2E under `tests/e2e/`)
- Lint: **Oxlint via ESLint 9** through `turbo lint`
- Node: pinned via `.nvmrc` (22.15.1); `engines.node >= 22.15.1`
- Commit convention: Conventional Commits (`feat:`, `fix:`, `chore:`, `ci:`, `docs:`, `refactor:`, `perf:`, `test:`, `style:`; `!:` for breaking; `BREAKING CHANGE:` footer when applicable)
- Versioning: `bash-scripts/bump_version.sh` derives next semver from Conventional-Commit messages in range `<last v* tag | root commit>..HEAD`; composes with `bash-scripts/update_version.sh` (argv-only `perl -i -pe` rewriter that touches all 24 non-`node_modules` `package.json` files).
- Active branch: `fix/e2e-2.3-unblock`.
- Phase state (see `ROADMAP.md`): Phase 1 ✅; Phase 2 ✅ (Q9 pinned but deferred); Phase 3.1 ✅ / 3.2 🔴 (Q5-blocked) / 3.3 🔴 (Q5-blocked) / 3.4 ✅ / 3.5 ✅; Phase 4.1 ?? ((un-touched) / 4.2 ✅ (this rewrite).

**There is no Next.js, no React Server Components, no server actions, no Drizzle, no D1/KV/R2, no Lucia auth, no Vinext/Vite-based Next.js, no `pnpm deploy:all`, no `worker-entrypoint.ts`, no `wrangler.jsonc`, no Cloudflare bindings in this repo.** A prior version of this file hallucinated all of the above from a SaaS-template prompt; do not reintroduce it.

## Architecture Compass

| Concern | Location |
| --- | --- |
| Background service-worker poll/claim/auth pipeline | `chrome-extension/src/background/index.ts` |
| Scheduling orchestrator (Q9 finding site) | `chrome-extension/src/background/scheduling-orchestrator.ts:124` |
| Per-platform circuit breaker (OPEN/RECOVERY/CLOSED) | `chrome-extension/src/background/circuit-breaker.ts` |
| Shared `fetch` mocking harness | `chrome-extension/src/background/__tests__/fetch-harness.ts` (`mockFetchJson` / `mockFetchReject` / `mockFetchHang` / `mockFetchSequence` / `installFetchSequence` / `assertFetchedUrl`) |
| Background test setup (`chrome` shim, no `fetch` mock) | `chrome-extension/src/background/__tests__/setup.ts` |
| Vitest config with 100% coverage gate on orchestrator+breaker | `chrome-extension/vitest.config.ts` |
| Chrome MV3 manifest (reads root `package.json` at build) | `chrome-extension/manifest.ts` (+ compiled `chrome-extension/manifest.js`) |
| API base URL | `chrome-extension/src/config.ts` (`https://litoral.agency`) |
| Cross-package shared types/constants | `packages/shared/` (consumed via `@extension/shared`) |
| Cross-package storage helpers | `packages/storage/` (consumed via `@extension/storage`; see `lib/impl/extension-auth-storage.ts`, `lib/impl/extension-poll-storage.ts`) |
| Archive builder (deterministic `extension-v${version}.{zip,xpi}`) | `packages/zipper/index.mts` |
| Version bumper (Conventional-Commit semver) | `bash-scripts/bump_version.sh` |
| Version rewriter (argv-only, 24 `package.json` files) | `bash-scripts/update_version.sh` |
| Release pipeline (bump → matrix build → GitHub Release) | `.github/workflows/release.yml` |
| Store-listing metadata sync (dark-by-default) | `.github/workflows/listing-sync.yml` |
| Store listing JSON + screenshots | `store-assets/{chrome,firefox}/` (still has `__TODO__` markers) |
| Roadmap / Q-items / changelog | `ROADMAP.md` (source of truth; Phase 1 execution history in `ROADMAP_STEP.md`) |
| E2E specs + helpers (WebdriverIO v9) | `tests/e2e/` (`specs/*.test.ts`, `config/wdio.*.conf.ts`, `utils/`) |
| Content scripts (Instagram/Facebook/TikTok/GBP matchers + DOM utils + telemetry) | `pages/content/` |
| Popup UI | `pages/popup/` |

## Coding Rules

- Write concise, technical TypeScript code.
- Prefer functional and declarative patterns. Avoid classes.
- Prefer iteration and modularization over duplication.
- Use descriptive names such as `isLoading` and `hasError`.
- Favor named exports.
- Use lowercase with dashes for directories.
- Structure files as: exported component, subcomponents, helpers, static content, types.
- Never delete comments unless they are no longer relevant.

## Comments

- Do not comment obvious code.
- Add comments only for non-trivial logic, edge cases, workarounds, or business rules.
- Comments should explain why, not what.
- Keep TODO comments unless the work is actually completed and verified.

## Functions and Types

- When a function has more than one parameter, pass a named object.
- Use the `function` keyword for pure functions.
- Prefer interfaces over types when practical.
- Avoid enums; use maps or const objects instead.
- Do not edit generated type files by hand. This repo has no `worker-configuration.d.ts` (that was SaaS-template drift); the equivalent generated surface is `chrome-extension/manifest.js` (compiled from `manifest.ts`) and the typegen under `@extension/shared` / `@chrome-types`. Regenerate via the build, not by hand.

## Imports and Packages

- Use `pnpm` for all package management (no npm, no yarn). `pnpm` is pinned to 10.11.0 in `package.json#packageManager`; use `corepack` if your shell does not pick it up.
- Before adding a package, check `package.json` (root and the relevant workspace) first. Prefer reusing `@extension/shared`, `@extension/storage`, `@extension/ui`, etc. before introducing a new external_dep.
- Cross-workspace imports use the `@extension/*` package names (e.g. `import type { CampaignPayload } from '@extension/shared'`; `import { extensionAuthStorage } from '@extension/storage'`). Type-only imports MUST use `import type` (this is enforced by Oxlint's `import/consistent-type-specifier-style`).
- Do not add `import "server-only"` — that is Next.js/RSC and does not apply.

## Verification

Actual scripts in root `package.json` (verified):

- `pnpm lint` — Oxlint via `turbo lint --continue` (19 turbo tasks, repo-wide).
- `pnpm type-check` — `turbo type-check` (18 turbo tasks). Note: the command is `type-check`, NOT `typecheck`.
- `pnpm test:unit` — `turbo test:unit` (Vitest, co-located `__tests__/*.test.ts`). Background service-worker coverage alone: 36 orchestrator + 9 circuit-breaker + 8 poll-storage + 19 index + scheduling E1-E3 = ~72 tests; `chrome-extension/vitest.config.ts` enforces branch/line/function/statement 100% on `scheduling-orchestrator.ts` + `circuit-breaker.ts`.
- `pnpm e2e` — runs the Chrome E2E matrix (`pnpm zip && turbo e2e`).
- `pnpm e2e:firefox` — runs the Firefox E2E matrix (`pnpm zip:firefox && turbo e2e`).

Notes:

- The **E2E CI matrix is Firefox-only** per Q7 resolution. Chrome 150 + chromedriver 150 silently reject MV3 `extensions: [base64]` under WDIO v9.29.1; Chrome E2E continues to work locally on headed Windows but is not wired into `e2e.yml`.
- **The following commands DO NOT exist** as scripts in this repo (and were hallucinated by the previous AGENTS.md): `pnpm run test:integration`, `pnpm run test:e2e` (the actual script is `pnpm e2e` / `pnpm e2e:firefox`), `pnpm run check:vinext`, `pnpm run typecheck`, `pnpm deploy:all`, `pnpm deploy`, `pnpx fallow audit`, `pnpm db:generate`, `pnpm run cf-typegen`. Do not invoke them. (`pnpx fallow audit` is not a script in this repo and the package is not a dependency; do not run it as part of verification.)
- Run lint + type-check + test:unit after code changes when feasible, especially before handing work back.

## DRY Rules

- Extract repeated values into constants, especially validation limits, badge strings, storage keys, and API path fragments.
- Extract repeated formatting / repeated code paths into utility helpers.
- Reuse existing types, helpers, and constants before creating new ones.
- Prefer clear code over premature abstraction for simple one-off patterns.

Honest homes in this repo (verified — this repo has NO top-level `src/` directory at all):

- Cross-package shared types and constants: `packages/shared/lib/utils/` — see `extension-types.ts` (live message/payload types), `const.ts` (terminal color codes), `helpers.ts`, `types.ts`. Re-exported via `packages/shared/lib/utils/index.ts` and consumed through `@extension/shared`.
- Cross-package storage helpers (auth token, poll state, telemetry, breaker state, claimed campaigns): `packages/storage/lib/impl/` — `extension-auth-storage.ts`, `extension-poll-storage.ts`, plus base abstractions in `packages/storage/lib/base/`. Consumed through `@extension/storage`.
- Chrome-extension-internal constants: `chrome-extension/src/background/index.ts` (top-of-file constants block; e.g. `POLL_ALARM_NAME`, `MAX_CONSECUTIVE_FAILURES`, `BADGE_AUTH_REQUIRED`, `BADGE_ERROR`, `POLL_BACKOFF_STEPS`, `POLL_BACKOFF_CAP_MINUTES`) and `chrome-extension/src/config.ts` (`API_BASE_URL`). There is no `src/constants.ts` or `chrome-extension/src/shared/` directory; do not invent one. Inline constants near their use site is the established pattern.
- Per-package utilities live next to the consumer (e.g. `chrome-extension/src/background/__tests__/fetch-harness.ts`); there is no central `src/utils/` or `src/lib/` directory at the repo root.

## Browser Extension Architecture

This section replaces the previous "Frontend and Next.js" section. The repository contains a Chrome MV3 + Firefox WebExtension, not a web app.

- **MV3 service-worker lifecycle.** The background script (`chrome-extension/src/background/index.ts`) is an ephemeral service worker (Chrome MV3 default idle timeout ≈ 30s when not actively processing). Polling is woken by `chrome.alarms` (alarm name `campaign-queue-poll`), one-shot `delayInMinutes` during backoff or 20-minute `periodInMinutes` at default cadence. `chrome.runtime.onInstalled` registers content scripts (4 IDs: `litoral-{instagram,facebook,tiktok,gbp}-scheduler`) and triggers the initial poll; duplicate-script-ID errors are swallowed (idempotent). `chrome.runtime.onStartup` re-arms the alarm after a browser restart. `persistAcrossSessions` for the alarm is intentionally omitted (it is not in the `@types/chrome` schema).
- **Backoff and circuit breaker.** Per-platform breaker (`circuit-breaker.ts`) tracks consecutive scheduling failures per platform and short-circuits future attempts by opening the breaker. **Threshold: 3 failures → OPEN for 15 min** (`BREAKER_THRESHOLD = 3`, `BREAKER_OPEN_DURATION_MS = 15 * 60 * 1000`); auto-recovers lazily on the next `isOpen` read once `Date.now() >= openUntil[platform]`. State persists under `litoral-circuit-breaker` in `chrome.storage.local`. The **poll-level backoff is separate**: 1 → 2 → 5 → 5 min capped (`POLL_BACKOFF_STEPS = [1, 2, 5]`, `POLL_BACKOFF_CAP_MINUTES = 5`); after **6 consecutive poll failures** a red `!` badge is set and the `litoral-connection-error` notification fires once (idempotent — the 7th failure does not re-notify because the path is gated on `failures >= MAX_CONSECUTIVE_FAILURES` hit, and `recordFailure` increments past it).
- **Message passing.** Popup ↔ background via `chrome.runtime.sendMessage` / `chrome.runtime.onMessage`. Background-bound message types (`PopupMessage`): `GET_STATE` (returns `POLL_STATUS` + full per-platform telemetry + breaker state + backoff minutes), `CONNECT` (carries `token`), `RETRY_NOW` (clear current alarm, poll immediately, recreate alarm), `CLEAR_ERRORS` (bulk-reset telemetry, failure counter, and every per-platform breaker via `popupBreaker.resetAll()`). Background→popup broadcast: `AUTH_REQUIRED` (best-effort; swallowed if popup is closed). Background returns `true` from the listener to keep the message channel open across the async body; a private `sendResponse._called` guard prevents double-response.
- **Auth.** Bearer JWT lives in `chrome.storage.sync` (via `extensionAuthStorage`'s `setToken` / `getToken` / `hasToken` / `clearToken` — syncs across the user's signed-in browsers, smaller quota than `local`). Requests attach `Authorization: Bearer ${token}`. A 401 from `/api/extension/queue` or `/api/extension/queue/claim` clears the token, sets the orange `🔑` badge (`BADGE_AUTH_REQUIRED`), and broadcasts `AUTH_REQUIRED` to the popup. The popup `CONNECT` handler is the only writer of the token (see `pages/popup/src/Popup.tsx:105` `chrome.runtime.sendMessage({ type: 'CONNECT', token: token.trim() }, ...)`); there is no OAuth flow, no Lucia, no session cookies.
- **Extension storage surface.** `chrome.storage.sync` holds the auth token. `chrome.storage.local` (via `extensionPollStorage`) holds: claimed campaigns, per-platform telemetry (last success/failure time, last error code+reason, per-platform consecutive failures), pending schedules, poll-level last error + consecutive failures, poll backoff minutes. **`chrome.storage` does not support multi-key transactions** — read-modify-write is unprotected across concurrent writers; the producer/consumer design in the orchestrator keeps each write to a single key.
- **External backend.** The endpoints `/api/extension/queue` (GET), `/api/extension/queue/claim` (POST), and `/api/extension/queue/scheduled` (POST, called by `markScheduledOnServer` in `scheduling-orchestrator.ts`) are NOT in this repository — they are served by an external Cloudflare-Worker-backed API at `https://litoral.agency` (see `chrome-extension/src/config.ts`). The extension is the scheduling client / TikTok Publishing API proxy surface lives server-side. Document this honestly; do not invent server code here.

## State, Security, and Performance

- Server-state reads happen via `fetch` from the background script to `https://litoral.agency/api/extension/*`. The popup only sees a sanitized snapshot via the `GET_STATE` → `POLL_STATUS` exchange; the popup never makes `fetch` calls directly.
- Rate limiting is enforced two ways: client-side via the poll backoff cadence (1 → 2 → 5 → 5 min) plus the per-platform circuit breaker, and server-side by the external backend (out of this repo's scope). Preserve both.
- Input validation: popup `CONNECT` input is validated in `handleConnect` (`if (!token.trim()) return setConnectError(...)`) before sending to the background; the background `CONNECT` handler (`chrome-extension/src/background/index.ts:363`) persists the token as-is (the trust boundary is the bearer-token verification on the external backend, not here). There is no Zod, no `react-hook-form`, no `zodResolver`, no `next-safe-action` in this repo (verified: zero matches for any of those package names across all `package.json` files). New validation should follow the manual-runtime-guards idiom: `if (typeof x !== 'string' || !x.trim()) return { error: 'INVALID_X' }`.
- Web Vitals do not directly apply to chrome-extension popup/sidepanel pages. The closer analog is keeping the service worker alive long enough to complete in-flight claims; this is mitigated by `chrome.alarms` waking the worker and by writing to `chrome.storage` (which is async-resolved on the next wake). Avoid calling `chrome.runtime.lastError`-sensitive APIs after a long `await` chain without re-checking context.
- Sanitization: prefer `chrome.storage` over `localStorage`/`sessionStorage` (the latter are not available in service workers). Never log secrets; the popup is the only token-entry surface and the background never logs token values.

## Forms, Validation, and Message Passing

This section replaces the previous "Forms, Validation, and Server Actions" section. This repo has no server actions, no Zod, no `next-safe-action`, no `react-hook-form`.

- Popup form → `chrome.runtime.sendMessage({ type: 'CONNECT', token: token.trim() }, cb)` to background → background `onMessage` handler validates + persists via `extensionAuthStorage.setToken` → background `fetch` to external backend on next poll → background broadcasts response/`AUTH_REQUIRED` to popup via `chrome.runtime.sendMessage` (or callback reply, see `sendResponse._called` guard).
- Validation idiom (no Zod): inline runtime type/value guards in the popup before send and in the background handler after receive. Return structured `{ success: boolean }` or `{ success: boolean, error?: string }` envelopes; never throw across `sendMessage` (the callback would not receive the error).
- Schemas are NOT centralized in `src/schemas/` (such a directory does not exist). Live message types live in `packages/shared/lib/utils/extension-types.ts` and are consumed through `@extension/shared`; add new message types there and re-export so both popup and background import them as `PopupMessage` / `BackgroundMessage` types.

## Storage Surface

Replaces the previous "Database and Migrations" section. **This repository has no database, no SQL, no Drizzle, no migrations.**

- `chrome.storage.sync` — auth token only (syncs across the user's browsers; small quota, ~100 KB / 8 KB per item). Read/write via `extensionAuthStorage.setToken` / `getToken` / `hasToken` / `clearToken` (`packages/storage/lib/impl/extension-auth-storage.ts`).
- `chrome.storage.local` — everything else (per-browser, larger quota, ~10 MB): claimed campaigns, pending schedules, per-platform telemetry (last success/failure time, last error code+reason, consecutive failures), poll-level last error + consecutive failures + backoff minutes, breaker state (`litoral-circuit-breaker` key with `openUntil[]` + `consecutiveFailures[]` + `lastUpdatedAt`). Read/write via `extensionPollStorage` (`packages/storage/lib/impl/extension-poll-storage.ts`) and `CircuitBreaker` (`chrome-extension/src/background/circuit-breaker.ts`).
- **No migrations.** Bump schema additively: new fields are read with `?? defaultValue` in the loader (see how `BreakerState.consecutiveFailures[code]` and `openUntil[code]` tolerate missing keys in `circuit-breaker.ts:30-39`). Never rename an existing storage key without a forward-migration read step.
- **No multi-key transactions.** `chrome.storage` only guarantees atomicity at the single-key write level. Read-modify-write sequences are unprotected across concurrent writers — design producers (poll handler) and consumers (orchestrator) so each owns a disjoint key set, or accept last-writer-wins.

## Authentication

JWT bearer-token auth in `chrome.storage.sync`. No Lucia, no session cookies, no OAuth, no `getSessionFromCookie`.

- The popup `CONNECT` form (`pages/popup/src/Popup.tsx:98` `handleConnect`) sends the operator-pasted token via `chrome.runtime.sendMessage({ type: 'CONNECT', token })` to the background.
- The background's `onMessage` listener (`chrome-extension/src/background/index.ts:363`) calls `extensionAuthStorage.setToken(msg.token)`, then non-blocking `void checkAuthAndPoll()` to kick the first poll, then `sendResponse({ success: true })`.
- The poll loop reads the token via `extensionAuthStorage.hasToken()` / `getToken()` and attaches `Authorization: Bearer ${token}` to every backend fetch (`fetchQueue`, `claimCampaign`, `markScheduledOnServer`).
- A 401 from any endpoint triggers `extensionAuthStorage.clearToken()` + orange `🔑` badge + `AUTH_REQUIRED` broadcast to the popup (see `handlePollError` at `chrome-extension/src/background/index.ts:230-250`). The popup then re-renders the `CONNECT` card on its next `GET_STATE` poll (5s cadence via `setInterval` in `Popup.tsx:93`).
- Token validity verification is the external backend's responsibility, not the extension's. The extension only checks presence.

## CI/CD and Deployment

This section replaces the previous "Cloudflare Rules" section. **There is no Cloudflare integration in this repository** (the external backend is on Cloudflare Workers, but it lives in a separate repo).

### Workflows (`.github/workflows/`)

Run on `pull_request`: `lint.yml`, `build-zip.yml`, `prettier.yml`, `test-unit.yml`, `e2e.yml`.
Run on `push: [main]`: `release.yml`.
Run on `push: [main]: paths: ['store-assets/**']`: `listing-sync.yml` — dark-by-default, gated on `vars.ENABLE_LISTING_SYNC == 'true'` plus per-browser secret presence (`CHROME_*` / `FIREFOX_*`).

`release.yml` is a 3-job pipeline:
1. **`bump`** — runs `bash-scripts/bump_version.sh` (Conventional-Commit semver derivation over `<last v* tag | root commit>..HEAD`), composes with `bash-scripts/update_version.sh` to rewrite all 24 non-`node_modules` `package.json` files via `perl -i -pe`, commits the bump back to `main`, tags `v${newVersion}`.
2. **`build`** — matrix `chrome` / `firefox` — runs `pnpm zip` / `pnpm zip:firefox` and uploads the archive as a workflow artifact.
3. **`release`** — idempotent tag-check, then `softprops/action-gh-release@v2` publishes the GitHub Release with the matrix-built `extension-v${version}.{zip,xpi}` artifacts.

`bump_version.sh` derives from Conventional-Commit subjects in range; `fix:` / `chore:` / `docs:` / `ci:` / `test:` / `style:` / `perf:` / `refactor:` trigger a patch bump, `feat:` triggers a minor bump, any `BREAKING CHANGE:` footer or `!:` marker triggers a major bump.

### Local build

- `pnpm zip` — Chrome MV3 archive → `dist-zip/extension-v${version}.zip` (deterministic filename derived from root `package.json#version` via the zipper walk-up root-marker (`pnpm-workspace.yaml`)).
- `pnpm zip:firefox` — Firefox WebExtension archive → `dist-zip/extension-v${version}.xpi`.
- `pnpm build` / `pnpm build:firefox` — Vite build only (no zip), output under `dist/`.
- `pnpm dev` / `pnpm dev:firefox` — Vite watch dev build with HMR.

### Auto-publish to stores

Phase 3.2 (Chrome Web Store) and 3.3 (Firefox Add-ons / AMO) are pending — blocked on Q5 (deploy-to-draft vs publish-to-public decision) plus 6 GitHub Actions secrets (Chrome Web Store refresh token + ZIP path; AMO JWT + signing key + ZIP path). Until those land, the GitHub Release artifacts are manually uploaded to the Chrome Web Store / AMO dashboards.

### Wrangler / Cloudflare

Do not introduce in this repo. The backend at `https://litoral.agency` is a separate Cloudflare-Worker project; any `wrangler.jsonc`, D1, KV, R2, or Queue changes belong in that backend repo, not here.

## Release Workflow on Branch

- Active development branch: `fix/e2e-2.3-unblock` (verified: this is the current `git branch --show-current`).
- Commits MUST follow Conventional Commits. Observed subject prefixes in recent history: `feat(store-assets):`, `refactor(zipper):`, `docs(roadmap):`, `ci(release):`, `ci: switch …`, `fix(e2e):`, `test(background):`. Multi-paragraph commits use a short subject line + blank line + body + optional `BREAKING CHANGE:` footer; the `!:` marker on the subject (e.g. `feat(api)!: drop v1`) indicates a breaking change at the API surface.
- **Do not commit unless the orchestrator explicitly asks you to.** The orchestrator decides commit boundaries per the Orchestrator + Subagents rule above. Leave changes in the working tree unless instructed otherwise.

## Known Production Findings

Only Q9 is tracked here. For the full Q-item list, see `ROADMAP.md` → "Open Questions & Decisions".

- **Q9 — `markScheduledOnServer` await ordering.** In `chrome-extension/src/background/scheduling-orchestrator.ts:124`, the `await markScheduledOnServer(campaign.campaignId, result.scheduledAt)` call runs BEFORE `extensionPollStorage.removeCampaign(campaign.campaignId)` (line 152) and `recordPlatformSuccess` (line 159+). The 90s `SCHEDULING_TIMEOUT_MS` outer timeout is cleared by the `done()` callback on `SCHEDULE_COMPLETE`, so a never-resolving marker `fetch` would hang `processPendingSchedules` indefinitely (the outer timeout fires but `await markScheduledOnServer` is still pending on the call stack). The code comments at lines 121-123 present the order as intentional ("Mark scheduled on server BEFORE removing from local storage. … If the server call fails, we keep the campaign in pendingSchedules so the stale lock scanner can auto-revert it on the next cycle"), but the Q9 audit pins this as production-risky and it remains deferred post-Phase 2.4.
  - **Fix candidate (a):** move the server mark AFTER the local `removeCampaign` + `recordPlatformSuccess` updates so a hang on the marker call does not block local-state convergence. Tradeoff: server-side staleness scanner briefly disagrees with extension local state between the local write and the eventual marker POST.
  - **Fix candidate (b):** detach the marker call with `void markScheduledOnServer(...)` plus a bounded per-call timeout (e.g. `Promise.race([...])` against a 10s budget) and let the stale lock scanner auto-revert if the marker truly never landed. Tradeoff: introduces a fire-and-forget code path that needs separate observability.

## Conventional Commit Conventions

Lifted from the prior "Coding Rules" spirit and verified against `git log`:

- Subject line: `<type>(<scope>)?: <imperative summary>`; lower-case, no trailing period, ≤ 72 chars.
- Types observed in this repo: `feat:`, `fix:`, `chore:`, `ci:`, `docs:`, `refactor:`, `perf:`, `test:`, `style:`, `debug:` (the last one is informal; prefer `chore:` or `fix:` for new work).
- Breaking change: either `feat(scope)!: …` marker on the subject OR a `BREAKING CHANGE: <description>` footer. Both are correctly parsed by `bump_version.sh` to a major-version bump.
- Scopes observed: `roadmap`, `store-assets`, `zipper`, `release`, `background`, `e2e`, `ci`, `popup`, `content`, `manifest`. Reuse an existing scope when one fits; invented scopes should be lower-case single-word and match the file-area being changed.
- Multi-purpose commits: prefer splitting into multiple smaller commits over a single commit touching disparate areas. The release pipeline parses each commit subject independently for semver impact, so a `feat:` buried in a `chore:` commit will be misclassified as patch.
