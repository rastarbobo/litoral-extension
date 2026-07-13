# Phase 1 Foundation — Execution Plan

> **Created:** July 13, 2026
> **Scope:** ROADMAP Phase 1 sub-tasks **1.3**, **1.4**, **1.5**, plus the gap fixes identified during deep-dive.
> **Deferred:** 1.1 (TikTok — blocked on Q1, no test account) and 1.2 (GBP — Q2 answered: GBP Posts via Business Profile manager, but bundled with 1.1 in a follow-up phase).
> **Execution order:** Step 0 → 1.3 → 1.4 → 1.5 → gap fixes → final verification.

---

## Step 0 — Housekeeping commit

Land the working-tree state so the plan is versioned alongside the code.

- Commit `ROADMAP.md` (currently untracked) — it's the source of truth for phase status.
- Commit the 3 already-staged edits as a separate prep commit:
  - `pages/popup/src/Popup.tsx` — the `formatRelativeTime(null)` bugfix ("Never") is a real fix; commit as `fix(popup): handle null lastPollTime in formatRelativeTime`.
  - `packages/ui/lib/components/ToggleButton.tsx` and `error-display/ErrorDisplay.tsx` — alias→relative import refactor; commit as `refactor(ui): switch path-alias imports to relative in ui package`.
- Tick the ROADMAP changelog row `2026-07-13` noting the plan file was added and sub-tasks 1.3 / 1.4 / 1.5 / gap fixes are moving out of "Not Started".

**Files touched:** `ROADMAP.md`, the 3 already-modified files, new `ROADMAP_STEP.md`.
**Verify:** `pnpm lint`, `pnpm type-check` green; `git status` clean.

---

## Step 1 — Task 1.3: Shared DOM utils hardening

Foundational — everything else (1.1, 1.2, login detection, error telemetry) leans on this.

### 1.3.a — Typed error returns

- In `pages/content/src/shared/dom-utils.ts`, replace plain `throw new Error(msg)` with a small error class hierarchy exported from the same file:
  - `class DomUtilError extends Error { readonly code: DomUtilErrorCode; readonly selector?: string; readonly timeoutMs?: number }`
  - Codes enum: `'ELEMENT_NOT_FOUND' | 'ELEMENT_NOT_CLICKABLE' | 'TEXT_SET_FAILED' | 'DATETIME_SET_FAILED' | 'MEDIA_TOO_LARGE' | 'MEDIA_FETCH_FAILED' | 'MEDIA_PROCESSING_TIMEOUT' | 'TIMEOUT' | 'LOGIN_REQUIRED'`
  - All 8 functions throw the typed errors; keep message strings unchanged for back-compat.
- Update the two existing platforms (`facebook/index.ts`, `instagram/index.ts`) to read `err.code` in their `catch` blocks when building the `SCHEDULE_FAILED` message payload (so the orchestrator receives a structured `reason` instead of a free-form string).

### 1.3.b — `waitForElement` configurable retries

- Signature: `waitForElement(selector: string, opts?: { timeoutMs?: number; retryIntervalMs?: number; retries?: number; stateCheck?: (el: Element) => boolean })` — `timeoutMs` stays the default 10s path; `retries` lets callers opt into a bounded retry loop with a short sleep between attempts (defaults to 1 attempt to preserve current behavior).
- `stateCheck` lets callers require an element to be visible/interactive (e.g. `!el.closest('[aria-hidden="true"]')`), which is what the React-driven popovers on FB/IG need.

### 1.3.c — `setDateTimeInput` React edge cases

- Currently only sets value via the native value setter + `input`/`change` events. Harden to:
  - Detect `input[type="datetime-local"]` vs. the React-controlled custom date+time picker pattern seen on TikTok/GBP (two separate inputs). Branch on `el.getAttribute('type')` and `el.tagName` and dispatch the correct event set.
  - When the target is a contentEditable / div-based picker (TikTok/GBP likely path), fall back to focus + keyboard synthesis via `document.execCommand('insertText', ...)` and a `keydown` Enter to confirm.
- Keep the current fast-path for native inputs (FB/IG) — the new branches only kick in for non-native hosts.

### 1.3.d — `uploadMedia` waits for processing spinner

- Append a `waitForProcessing?: { indicatorSelector?: string; timeoutMs?: number }` option to `uploadMedia` that, *after* the `DataTransfer` dispatch, runs `await waitForMediaProcessing(...)` internally instead of leaving each caller to compensate with hardcoded `delay()`.
- Remove the compensating `delay(3000)` (FB) and `delay(5000) + waitForMediaProcessing(30_000)` (IG) at `facebook/index.ts:127` and `instagram/index.ts:115-116` — both now delegate to `uploadMedia`.
- `waitForMediaProcessing` already has a `throwOnTimeout` flag and a sensible default selector — keep it, just route it through `uploadMedia` automatically when the option is set.

### 1.3.e — Tests

- New file `pages/content/src/shared/__tests__/dom-utils.test.ts` using Vitest (need to add `vitest` to root devDeps; the monorepo doesn't have a test runner yet beyond WebdriverIO e2e). Cover:
  - `waitForElement` success / timeout / `retries` exhaustion / `stateCheck` mismatch.
  - `setDateTimeInput` native path and contentEditable fallback (jsdom + a fake React state holder).
  - `uploadMedia` size-check rejection (`MEDIA_TOO_LARGE`) and processing-spinner success/timeout paths (mock `fetch` + jsdom).
- Add a `test:unit` script to the root `package.json`: `turbo test:unit` and a `test:unit` task in `pages/content/package.json`.

**Files touched:** `pages/content/src/shared/dom-utils.ts`, `pages/content/src/shared/__tests__/dom-utils.test.ts`, `pages/content/src/matches/facebook/index.ts`, `pages/content/src/matches/instagram/index.ts`, `pages/content/package.json`, root `package.json`, `turbo.json`.
**Verify:** `pnpm test:unit` (new), `pnpm lint`, `pnpm type-check`; manually load the extension and schedule one FB + one IG campaign to confirm no regressions.

---

## Step 2 — Task 1.4: Error resilience

### 1.4.a — Per-platform error telemetry in storage

- Today `extension-poll-storage.ts` only stores poll-level `lastPollError` and a 20-entry `pollFailures` array. Extend the stored shape:

  ```ts
  type PlatformTelemetry = {
    lastSuccessAt: number | null;
    lastFailureAt: number | null;
    lastErrorCode: string | null;
    lastErrorReason: string | null;
    consecutiveFailures: number; // for circuit breaker
  };
  type TelemetryStore = Record<PlatformCode, PlatformTelemetry>;
  ```
  Lives alongside the existing `pendingSchedules` / `pollFailures` keys.
- Dedupe the existing local `PlatformCode` / `CampaignPayload` re-definitions (lines 8-19) — instead, move those types into `packages/shared/src/lib/types/extension-types.ts` (the canonical home for `PopupMessage` / `PollStatusPayload`) and import them from both `extension-poll-storage.ts` and `scheduling-orchestrator.ts`. Resolves the circular-dep smell without re-introducing it.
- `scheduling-orchestrator.ts` writes a telemetry entry on every `scheduleOneCampaign` outcome (success or `SCHEDULE_FAILED`).

### 1.4.b — Circuit breaker

- New module `chrome-extension/src/background/circuit-breaker.ts`:

  ```ts
  class CircuitBreaker {
    isOpen(platform): boolean;
    recordSuccess(platform): void;
    recordFailure(platform): void;
  }
  ```

  - Threshold: 3 consecutive failures per platform → open for 15 minutes; a successful run after the open window closes it.
  - State persisted in extension storage so it survives service worker restarts.
- `scheduling-orchestrator.ts` checks `breaker.isOpen(platform)` before launching `scheduleOneCampaign`; if open, it skips the campaign, marks it failed on the server with `reason: 'circuit_breaker_open'`, and records telemetry. Does **not** mark the campaign as scheduled (so the server requeues).

### 1.4.c — Exponential polling backoff

- Today the poll alarm fires every fixed 20 minutes (`index.ts:14`). Implement backoff in `handlePollError`:
  - After 3 consecutive poll failures, reschedule the next alarm at 1 min → 2 min → 5 min → cap 5 min.
  - On a successful poll, reset to the default 20-min cadence.
  - Implementation detail: clear the current alarm and recreate with `chrome.alarms.create(POLL_ALARM_NAME, { delayInMinutes: next })` on each error; on success, recreate with the default period.
- Store `pollBackoffMinutes` in storage so the popup can display it.

### 1.4.d — Tests

- New `chrome-extension/src/background/__tests__/scheduling-orchestrator.test.ts` (introduce the `__tests__/` dir the ROADMAP mentions):
  - 100% branch coverage on rate limiting (max 2 / 90s cycle).
  - Circuit breaker open/close transitions with fake timers.
  - Backoff escalation and reset.
  - Timeout path under fake timers (`vi.useFakeTimers()`) — both the 90s per-campaign timeout and the 30s tab-load timeout.
  - Retry: assert explicitly that same-campaign retry is **not** attempted today (locks in current behavior for a future phase).
- `chrome-extension/src/background/__tests__/circuit-breaker.test.ts` for the breaker in isolation.
- `chrome-extension/src/background/__tests__/extension-poll-storage.test.ts` for the new telemetry shape and round-trip write/read.

**Files touched:** new `circuit-breaker.ts`, `extension-poll-storage.ts`, `scheduling-orchestrator.ts`, `index.ts`, `packages/shared/src/lib/types/extension-types.ts`, 3 new test files, `chrome-extension/package.json`.
**Verify:** new unit tests pass; `pnpm lint` + `pnpm type-check`; manual smoke: induce 3 platform failures and confirm the breaker opens and recovers.

---

## Step 3 — Task 1.5: Popup UI improvements

Surfaces everything Step 2 wrote.

### 1.5.a — Extend the message contract

- In `packages/shared/src/lib/types/extension-types.ts`:
  - Add `'RETRY_NOW'` and `'CLEAR_ERRORS'` to the `PopupMessage` discriminated union.
  - Extend `PollStatusPayload` (lines 39-45 of the same file) with:
    ```ts
    platforms: Array<{
      code: PlatformCode;
      name: string;
      status: 'ok' | 'error' | 'idle' | 'breaker_open';
      lastSuccessAt: number | null;
      lastFailureAt: number | null;
      lastErrorReason: string | null;
      consecutiveFailures: number;
    }>;
    pollBackoffMinutes: number | null; // null when not in backoff
    ```

### 1.5.b — Background handlers

- `chrome-extension/src/background/index.ts` `GET_STATE` handler replies with the new `platforms` array sourced from telemetry storage and `pollBackoffMinutes` from storage.
- New `RETRY_NOW` handler: triggers an immediate `pollForCampaigns()` (clears the alarm, runs the poll, recreates the alarm with the default cadence).
- New `CLEAR_ERRORS` handler: clears `pollFailures`, resets per-platform `lastFailureAt` / `lastErrorReason` / `consecutiveFailures` to nulls / 0, and closes any open circuit breakers.

### 1.5.c — Popup component rewrite

- `pages/popup/src/Popup.tsx` gets a new "Platforms" section between the Status card and the Last Error card:
  - One row per platform, each showing an icon (✅ / ⚠️ / 🔴 / ⏸), platform name, last success (relative), last failure (relative, expandable to show `lastErrorReason`).
  - A `Retry Now` button at the bottom of the section (sends `RETRY_NOW`).
  - A `Clear Errors` button (sends `CLEAR_ERRORS`).
- Keep the existing 5-second polling interval; the new section reads from the same `GET_STATE` payload so no extra traffic.
- Reuse the existing `@extension/ui` `ErrorDisplay` and `ToggleButton` components where it makes sense (consistent with the earlier import-path refactor that just landed).

**Files touched:** `extension-types.ts`, `index.ts`, `Popup.tsx`, optionally new components under `pages/popup/src/components/`.
**Verify:** `pnpm lint`, `pnpm type-check`, manual smoke: trigger an error on one platform, confirm the row shows it; click Retry Now and Clear Errors and confirm state resets; confirm backoff minutes render.

---

## Step 4 — Gap fixes (interleaved with 1.3/1.4)

### 4.i — Login detection on Facebook + Instagram

- In `facebook/index.ts` and `instagram/index.ts`, before calling `waitForElement(SELECTORS.createPostButton)`, add a `detectLogin()` helper that checks for a known authenticated-state selector (e.g. presence of the user avatar / composer entry point). If absent, immediately send `SCHEDULE_FAILED` with the new typed code `'LOGIN_REQUIRED'` (added to the `DomUtilErrorCode` enum from 1.3.a so the orchestrator records it cleanly in telemetry).
- Wire the same check into TikTok (1.1) and GBP (1.2) when those land in the next phase.

### 4.ii — Wire up the dead `errorIndicator` SELECTOR

- Both `facebook/index.ts:64` and `instagram/index.ts:59` define `errorIndicator` but never read it. After the `successIndicator` check, add a parallel `errorIndicator` check (with `waitForElementToDisappear` inverted): if the error indicator appears before the success indicator does, send `SCHEDULE_FAILED` with `reason: err.message` from the now-typed DOM util. This gives real platform error strings to telemetry.

### 4.iii — Dedupe the dual type definitions

- Already covered in 1.4.a — move `PlatformCode` / `CampaignPayload` into `packages/shared/src/lib/types/extension-types.ts` and import everywhere. No separate step.

**Files touched:** `facebook/index.ts`, `instagram/index.ts`, `extension-types.ts` (already touched in 1.5.a).
**Verify:** extend the new `dom-utils.test.ts` and `scheduling-orchestrator.test.ts` to cover the `LOGIN_REQUIRED` and `errorIndicator` paths manually.

---

## Final verification (gates Phase 1 completion)

| Gate | Command / action |
|---|---|
| Lint clean | `pnpm lint` |
| Types clean | `pnpm type-check` |
| New unit tests green | `pnpm test:unit` (Vitest, newly introduced) |
| E2E smoke still green | `pnpm e2e` (existing 9 boilerplate specs must not regress) |
| Manual FB schedule | Run one end-to-end Facebook campaign; confirm telemetry row updates and no regression |
| Manual IG schedule | Same for Instagram |
| Force a platform failure | Manually navigate away mid-schedule; confirm the popup shows the failure, the per-platform telemetry updates, and after 3 such failures the circuit breaker opens and is reflected in the popup |
| Backoff verification | Trigger 3 poll failures; confirm alarm reschedules 1 → 2 → 5 min and resets on success |
| Retry / Clear Errors | Click both popup buttons; confirm storage state and UI react correctly |
| ROADMAP tick | Update `ROADMAP.md` — mark 1.3, 1.4, 1.5 ✅; add 2026-07-13 changelog row noting Step 0 plan + completed sub-tasks |

---

## Open decisions (still need your sign-off)

1. **Vitest as the unit test runner** — the monorepo only has WebdriverIO today. Vitest is the lowest-friction choice (works with Vite, jsdom, fake timers). Alternative: Jest with `ts-jest`. Proceeding with **Vitest** unless vetoed.
2. **Circuit breaker threshold** — 3 consecutive failures per platform, opens for 15 min. Keep as-is?
3. **Polling backoff caps** — 1 → 2 → 5 min, cap at 5 min. Keep these?
4. **Commit granularity** — separate Conventional Commits per sub-task (1.3 / 1.4 / 1.5 / gap fixes), or squash into one `feat(phase-1-foundation)` commit at the end?

---

## Out of scope (explicitly deferred)

- **1.1 TikTok content script** — blocked on Q1 (no test account). Re-plan when account lands.
- **1.2 GBP content script** — Q2 answered (GBP Posts via Business Profile manager). Bundled with 1.1 in a follow-up phase after foundation lands.
- **Phase 2 (testing) and Phase 3 (CI/CD)** — remain on their own roadmap timelines.

---

*This document is operational — it should be retired (or folded into ROADMAP.md changelog) once Step 0 + Steps 1-4 are complete.*
