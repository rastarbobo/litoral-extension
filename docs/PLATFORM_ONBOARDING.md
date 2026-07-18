# Platform Onboarding Guide

Step-by-step guide for adding a new social platform to the Litoral Agency
Publisher extension. This doc assumes you have already read the general
[`ONBOARDING.md`](./ONBOARDING.md) and have a local unpacked build running.
Whereas `ONBOARDING.md` covers repo layout, local setup, and the recommended
code-reading order for a new engineer, this doc zooms in on the single task
of wiring a new platform — e.g. `'twitter'`, `'linkedin'`, `'youtube'` — into
the scheduler end-to-end.

The guide uses `'twitter'` as a concrete worked example throughout so you can
copy-paste and substitute. Pick your platform's actual code (lowercase, no
spaces — `'twitter'` not `'Twitter'`), its scheduling-page URL, and its
content-script `matches:` URL, then follow the seven edits in order.

---

## 1. What you will be building

A new platform requires **seven touch-points** across five files. TypeScript
will refuse to compile if you miss the first four — the rest are runtime-only.

| # | File | Edit | Enforced by |
|---|------|------|-------------|
| 1 | `packages/shared/lib/utils/extension-types.ts:2` | add `'twitter'` to `PlatformCode` union | TypeScript |
| 2 | `packages/shared/lib/utils/extension-types.ts:5` | add `'twitter'` to `SUPPORTED_PLATFORMS` array | TypeScript (used by background `GET_STATE` enumeration) |
| 3 | `packages/shared/lib/utils/extension-types.ts:39` | add `twitter: 'Twitter'` to `PLATFORM_NAMES` | TypeScript — `Record<PlatformCode, string>` refuses to compile without all keys |
| 4 | `chrome-extension/src/background/scheduling-orchestrator.ts:43` | add `twitter: 'https://twitter.com/compose/post'` to `PLATFORM_SCHEDULE_URLS` | TypeScript — same `Record<PlatformCode, string>` constraint |
| 5a | `packages/storage/lib/impl/extension-poll-storage.ts:14` | add `'twitter'` to the LOCAL `PlatformCode` union | Runtime — storage seeds telemetry for each platform in `SUPPORTED_PLATFORMS_LOCAL` |
| 5b | `packages/storage/lib/impl/extension-poll-storage.ts:16` | add `'twitter'` to `SUPPORTED_PLATFORMS_LOCAL` array | Runtime — drives `INITIAL_TELEMETRY` seeding |
| 6 | `chrome-extension/src/background/index.ts:421-450` | add a 5th record to `registerContentScripts([...])` array | Runtime — task `T18` in `chrome-extension/src/background/__tests__/index.test.ts:795` asserts the exact 4-element array; MUST extend to 5 |
| 7 | `pages/content/src/matches/twitter/index.ts` | create new content-script file | Runtime — `js: ['content/twitter.js']` in the `registerContentScripts` record must match the Vite-built output filename |

**What you will NOT edit:**

- **The popup (`pages/popup/src/Popup.tsx`) needs no changes** — it renders
  per-platform rows via `status.platforms.map(...)` over the
  `PollStatusPayload.platforms` array, which the background's `GET_STATE`
  handler at `chrome-extension/src/background/index.ts:305-359` builds from
  `SUPPORTED_PLATFORMS.map(...)`. Adding to `SUPPORTED_PLATFORMS` automatically
  surfaces the new platform in the popup.
- **The manifest (`chrome-extension/manifest.ts`) needs no changes** — there
  is no `content_scripts` array in the manifest. All content-script
  registration is dynamic, via `chrome.scripting.registerContentScripts()`
  invoked from `chrome-extension/src/background/index.ts:419-461`.
- **The circuit breaker (`chrome-extension/src/background/circuit-breaker.ts`)
  needs no changes** — its per-platform state maps are
  `Record<string, ...>`, not `Record<PlatformCode, ...>`, so adding a
  platform code is forward-compatible at the storage layer automatically.

The seven edits below MUST all land in the same commit (or a coherent
short-stack) — partial wiring will break `pnpm type-check` or leave the
extension in a state where the orchestrator opens a tab to a URL whose
content script isn't yet registered.

---

## 2. Start from the stub template

The TikTok stub at `pages/content/src/matches/tiktok/index.ts` (26 lines) is
the canonical "minimum viable platform" — fully plumbed but functionally a
no-op. Copy it verbatim with your platform substituted:

```ts
// file: pages/content/src/matches/twitter/index.ts

/**
 * Twitter Content Script — Native UI Scheduling (Placeholder)
 *
 * Twitter scheduling is NOT yet implemented. This placeholder exists so the
 * scheduling orchestrator's dynamic dispatch for 'twitter' doesn't fail at
 * runtime. A real implementation will replace this (see
 * pages/content/src/matches/instagram/index.ts for the canonical example).
 *
 * Architecture:
 * - NFR-7: Uses the restaurant owner's authenticated session only
 * - Registered dynamically via chrome.scripting.registerContentScripts in
 *   the background worker, matches: ['https://twitter.com/*']
 */

import type { ContentScriptMessage, BackgroundToContentMessage } from '@extension/shared';

chrome.runtime.onMessage.addListener((message: BackgroundToContentMessage) => {
  if (message.type === 'START_SCHEDULING') {
    chrome.runtime.sendMessage({
      type: 'SCHEDULE_FAILED',
      campaignId: message.campaign.campaignId,
      reason: 'Platform not yet supported',
    } satisfies ContentScriptMessage);
  }
  return false;
});
```

**Why the stub design is dispatch-safe:** the orchestrator's `scheduleOneCampaign`
catches the returned `SCHEDULE_FAILED` message at
`chrome-extension/src/background/scheduling-orchestrator.ts:281-301` and calls
`breaker.recordFailure(platform)` at line 363. After 3 stub failures the
per-platform breaker opens for 15 minutes (`BREAKER_THRESHOLD = 3`,
`BREAKER_OPEN_DURATION_MS = 15 * 60 * 1000` — see
`chrome-extension/src/background/circuit-breaker.ts:28-39`), so the operator's
client will not keep hammering a known-stubbed platform. A stub-`SCHEDULE_FAILED`
and a real-implementation `SCHEDULE_FAILED` are indistinguishable to the
orchestrator's failure path — this is the safety guarantee that lets you ship
a stub first and grow it into a real implementation incrementally.

---

## 3. The seven edits, in order

### Edit 1 — `PlatformCode` union

```ts
// file: packages/shared/lib/utils/extension-types.ts
// line: 2

// BEFORE:
export type PlatformCode = 'instagram' | 'facebook' | 'tiktok' | 'gbp';

// AFTER:
export type PlatformCode = 'instagram' | 'facebook' | 'tiktok' | 'gbp' | 'twitter';
```

The `PlatformCode` union is the canonical list of platforms the scheduling
engine knows about. Adding the code here cascades the TypeScript compiler
requirement to edits 3 and 4 (the `Record<PlatformCode, string>` maps).

### Edit 2 — `SUPPORTED_PLATFORMS` array

```ts
// file: packages/shared/lib/utils/extension-types.ts
// line: 5

// BEFORE:
export const SUPPORTED_PLATFORMS: readonly PlatformCode[] = ['instagram', 'facebook', 'tiktok', 'gbp'];

// AFTER:
export const SUPPORTED_PLATFORMS: readonly PlatformCode[] = ['instagram', 'facebook', 'tiktok', 'gbp', 'twitter'];
```

The background's `GET_STATE` handler at
`chrome-extension/src/background/index.ts:319` enumerates this array to build
the per-platform rows the popup renders. A platform absent from this array
will not appear in the popup UI even if every other piece is wired.

### Edit 3 — `PLATFORM_NAMES` map

```ts
// file: packages/shared/lib/utils/extension-types.ts
// line: 39

// BEFORE:
export const PLATFORM_NAMES: Record<PlatformCode, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  gbp: 'Google Business Profile',
};

// AFTER:
export const PLATFORM_NAMES: Record<PlatformCode, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  gbp: 'Google Business Profile',
  twitter: 'Twitter',
};
```

TypeScript enforces `Record<PlatformCode, string>` — if you skip this edit,
`pnpm type-check` fails with `TS2741: Property 'twitter' is missing in type
...`. Run `pnpm type-check` after every edit to catch this early.

### Edit 4 — `PLATFORM_SCHEDULE_URLS` map

```ts
// file: chrome-extension/src/background/scheduling-orchestrator.ts
// line: 43

// BEFORE:
const PLATFORM_SCHEDULE_URLS: Record<PlatformCode, string> = {
  instagram: 'https://www.instagram.com/creator/manage_schedule/',
  facebook: 'https://business.facebook.com/latest/publishing_tools/composer/',
  tiktok: 'https://www.tiktok.com/creator-center/upload',
  gbp: 'https://business.google.com/posts/create',
};

// AFTER:
const PLATFORM_SCHEDULE_URLS: Record<PlatformCode, string> = {
  instagram: 'https://www.instagram.com/creator/manage_schedule/',
  facebook: 'https://business.facebook.com/latest/publishing_tools/composer/',
  tiktok: 'https://www.tiktok.com/creator-center/upload',
  gbp: 'https://business.google.com/posts/create',
  twitter: 'https://twitter.com/compose/post',
};
```

This URL is what `chrome.tabs.create({ url: ..., active: false })` at
`chrome-extension/src/background/scheduling-orchestrator.ts:307` will open
when a campaign with `platform: 'twitter'` is dispatched. The user must be
already authenticated on that URL in their logged-in browser tab — NFR-7
(uses the operator's authenticated session only).

### Edit 5a — storage-package local `PlatformCode` redeclaration

```ts
// file: packages/storage/lib/impl/extension-poll-storage.ts
// line: 14

// BEFORE:
type PlatformCode = 'instagram' | 'facebook' | 'tiktok' | 'gbp';

// AFTER:
type PlatformCode = 'instagram' | 'facebook' | 'tiktok' | 'gbp' | 'twitter';
```

The header comment at `extension-poll-storage.ts:3-12` documents the intent:
this is an INTENTIONAL local redeclaration rather than an `import type {
PlatformCode } from '@extension/shared'`. Reason: avoiding a circular
workspace-dependency edge between `@extension/storage` and `@extension/shared`.
You MUST update both local declarations whenever you add a platform code to
the shared union — TypeScript will NOT catch the divergence because the
local `PlatformCode` is structurally typed, not imported.

### Edit 5b — storage-package local `SUPPORTED_PLATFORMS_LOCAL`

```ts
// file: packages/storage/lib/impl/extension-poll-storage.ts
// line: 16

// BEFORE:
const SUPPORTED_PLATFORMS_LOCAL: readonly PlatformCode[] = ['instagram', 'facebook', 'tiktok', 'gbp'];

// AFTER:
const SUPPORTED_PLATFORMS_LOCAL: readonly PlatformCode[] = ['instagram', 'facebook', 'tiktok', 'gbp', 'twitter'];
```

`SUPPORTED_PLATFORMS_LOCAL` drives `INITIAL_TELEMETRY` seed computation at
`extension-poll-storage.ts:38-44` — for each platform in the array, an
`EMPTY_TELEMETRY` entry is created with all fields `null`/0. Without this
edit, the new platform's telemetry slot will be lazily created via the
spread operator at `recordPlatformSuccess`/`recordPlatformFailure` (lines
147-185), and the GET_STATE handler at `index.ts:333` tolerates the
missing seed via `telemetry[code] ?? { ...EMPTY_TELEMETRY }` — but this is
accidental-tolerance, not by-design. Add it.

### Edit 6 — `registerContentScripts` 5th record

```ts
// file: chrome-extension/src/background/index.ts
// lines: 421-450 (inside the registerContentScripts function)

// Append AFTER the existing litoral-gbp-scheduler record:

{
  id: 'litoral-twitter-scheduler',
  matches: ['https://twitter.com/*'],
  js: ['content/twitter.js'],
  runAt: 'document_idle',
  persistAcrossSessions: true,
},
```

The `id` string MUST be unique across all registered scripts (Chrome enforces
this; duplicates are swallowed by the `Duplicate`-substring catch arm at
`index.ts:455-459`). The `js: ['content/twitter.js']` path MUST match the
Vite-built output filename, which Vite derives from
`pages/content/src/matches/twitter/index.ts` (the file you create in Edit 7).
`runAt: 'document_idle'` mirrors the existing four scripts — the content
script runs after the platform's page has finished its initial load. The
`matches:` URL pattern should be as narrow as possible while still covering
every URL the orchestrator might open — `https://twitter.com/*` is broad
because Twitter's compose UI lives on `twitter.com/compose/post` but auth
redirects may transiently land on `twitter.com/login` or similar.

### Edit 7 — The content-script file

Create `pages/content/src/matches/twitter/index.ts` — copy the stub from
Section 2 above verbatim. Do not implement real DOM automation yet; stub
first, ship the seven edits end-to-end, verify the popup renders `Twitter
•` as a 5th-row `idle`-status platform, then come back to Section 5 to grow
the stub.

---

## 4. The content-script message protocol

The wire-protocol types live at
`packages/shared/lib/utils/extension-types.ts:84-92`:

```ts
export type ContentScriptMessage =
  | { type: 'SCHEDULE_COMPLETE'; campaignId: string; scheduledAt: string }
  | { type: 'SCHEDULE_FAILED'; campaignId: string; reason: string }
  | { type: 'SCHEDULING_PROGRESS'; campaignId: string; step: string };

export type BackgroundToContentMessage =
  | { type: 'START_SCHEDULING'; campaign: CampaignPayload }
  | { type: 'CANCEL_SCHEDULING'; campaignId: string };
```

The orchestrator's message listener at
`chrome-extension/src/background/scheduling-orchestrator.ts:281-301` routes
incoming `SCHEDULE_COMPLETE` / `SCHEDULE_FAILED` / `SCHEDULING_PROGRESS`
messages by `campaignId` — NOT by platform code. This means your new
content script's `chrome.runtime.onMessage.addListener` only needs to:

1. Filter on `message.type === 'START_SCHEDULING'` — return `false`
   (synchronous) for any other type to keep the listener pipeline cheap.
2. Emit a `SCHEDULE_COMPLETE` message when scheduling succeeds, with
   `campaignId` matching the incoming `campaign.campaignId` and
   `scheduledAt` as an ISO-8601 string.
3. Emit `SCHEDULE_FAILED` with a human-readable `reason` string when any
   step throws. The orchestrator's `parseReason` at
   `scheduling-orchestrator.ts:61-69` parses the reason — see Section 5
   for the conventional reason format.
4. Optionally emit `SCHEDULING_PROGRESS` messages with a `step` string
   (e.g. `'login_detected'`, `'media_uploaded'`, `'datetime_set'`) for
   richer popup-debug displays — the orchestrator logs these to `console.log`
   and forwards via the telemetry snapshot. Optional but recommended for
   observability of mid-schedule failures.

Minimal listener skeleton (the TikTok stub is the canonical example):

```ts
import type { ContentScriptMessage, BackgroundToContentMessage } from '@extension/shared';

chrome.runtime.onMessage.addListener((message: BackgroundToContentMessage) => {
  if (message.type === 'START_SCHEDULING') {
    // ... real or stub work happens here ...
    chrome.runtime.sendMessage({
      type: 'SCHEDULE_FAILED',               // or 'SCHEDULE_COMPLETE'
      campaignId: message.campaign.campaignId,
      reason: 'Platform not yet supported',  // omit for SCHEDULE_COMPLETE; use scheduledAt instead
    } satisfies ContentScriptMessage);
  }
  return false;
});
```

The background-side `chrome.tabs.sendMessage(tab.id, { type:
'START_SCHEDULING', campaign }, ...)` dispatch happens at
`chrome-extension/src/background/scheduling-orchestrator.ts:336-352`. If your
content script is not yet registered (Edit 6 omitted) or the tab failed to
load, `sendMessage` rejects with `"Could not establish connection. Receiving
end does not exist."` — the orchestrator catches this at line 347 but does
not immediately fail; the 90-second `SCHEDULING_TIMEOUT_MS` outer timeout
eventually fires `done({ success: false, reason: 'tab_timeout' })`.

---

## 5. Growing the stub into a real implementation

`pages/content/src/matches/instagram/index.ts` (230 lines) is the canonical
"real" reference implementation. Walk it top-to-bottom; it follows this
8-step sequence — and that sequence covers all 10 rows of the existing
"Platform Integration Checklist" at `ROADMAP.md:199-213` (Login Detection,
Navigation, Media Upload, Caption/Text, Date/Time, Schedule/Submit,
Success Detection, Error Handling, Rate Limiting, Cleanup):

1. **Login detection** — `detectLogin({ authenticatedSelector: '...', timeoutMs: 5_000 })`
   from `dom-utils.ts:369`. Returns `false` (does NOT throw) on timeout —
   the script then sends `SCHEDULE_FAILED` with reason `LOGIN_REQUIRED:
   < selector>`.
2. **Create-post button** — `waitForElement('...', 10_000)` then
   `clickElement('...')`.
3. **File input** — `waitForElement('input[type=file]', 10_000)`; then the
   heavy `uploadMedia('input[type=file]', campaign.assetUrl)` call from
   `dom-utils.ts:313`. This throws `MEDIA_TOO_LARGE` when the platform's
   `Content-Length` response header exceeds 200 MB (`MAX_ASSET_SIZE_BYTES`
   at `dom-utils.ts:255`) or `MEDIA_FETCH_FAILED` when the fetch returns
   non-2xx.
4. **Media processing** — `waitForMediaProcessing(...)` from
   `dom-utils.ts:276` polling until none of the
   `DEFAULT_PROCESSING_SELECTORS` (`role=progressbar`, `data-testid=
   media-upload-progress`, `aria-label=Processing`, `aria-label*=Uploading`)
   remain visible.
5. **Caption/text** — `setTextContent('textarea[aria-label="..."]', campaign.caption)`
   from `dom-utils.ts:163` — React-aware native setter dispatch so React
   picks up the value.
6. **Date/time (skip if `campaign.scheduledTime` is undefined)** —
   `setDateTimeInput('input[type=datetime-local]', campaign.scheduledTime)`
   from `dom-utils.ts:201` — converts ISO-8601 to local `YYYY-MM-DDTHH:mm`
   and dispatches synthetic `input` + `change` + `keydown` events (React
   is sensitive to the event type and the input/sliders vs. contentEditable
   branch).
7. **Schedule button + submit** — open the platform's "Schedule" menu
   (Instagram opens a dropdown; Facebook opens a "Publish" SplitButton),
   set the datetime, then `clickElement('button[aria-label="Schedule"]')`.
8. **Success detection** — `waitForOutcome({ successSelector: '...',
   failureSelector: '...', timeoutMs: 30_000, extractFailureReason })` from
   `dom-utils.ts:386`. Raced poll on both selectors; throws
   `TEXT_SET_FAILED` if the failure selector wins, `TIMEOUT` if neither
   wins within 30s. On success, emit `SCHEDULE_COMPLETE` with `scheduledAt =
   campaign.scheduledTime ?? new Date().toISOString()`.

The shared `dom-utils.ts` export surface (consumed by your real platform
implementation):

```ts
// file: pages/content/src/shared/dom-utils.ts

export type DomUtilErrorCode =
  | 'ELEMENT_NOT_FOUND'
  | 'ELEMENT_NOT_CLICKABLE'
  | 'TEXT_SET_FAILED'
  | 'DATETIME_SET_FAILED'
  | 'MEDIA_TOO_LARGE'
  | 'MEDIA_FETCH_FAILED'
  | 'MEDIA_PROCESSING_TIMEOUT'
  | 'TIMEOUT'
  | 'LOGIN_REQUIRED';

export class DomUtilError extends Error { code: DomUtilErrorCode; selector?: string; timeoutMs?: number; }
export const delay: (ms: number) => Promise<void>;
export const waitForElement: (selector: string, timeoutMs?: number) => Promise<Element>;
export const waitForElementToDisappear: (selector: string, timeoutMs?: number) => Promise<void>;
export const clickElement: (selector: string) => void;
export const setTextContent: (selector: string, text: string) => void;
export const setDateTimeInput: (selector: string, isoString: string) => void;
export const waitForMediaProcessing: (timeoutMs?: number, throwOnTimeout?: boolean) => Promise<boolean>;
export const uploadMedia: (inputSelector: string, assetUrl: string, opts?: UploadMediaOptions) => Promise<void>;
export const detectLogin: (opts: { authenticatedSelector: string; timeoutMs?: number }) => Promise<boolean>;
export const waitForOutcome: (opts: WaitForOutcomeOptions) => Promise<{ success: true }>;
```

The `orchestrator-parseReason` contract: the orchestrator's `parseReason` at
`chrome-extension/src/background/scheduling-orchestrator.ts:61-69` parses
`SCHEDULE_FAILED` reasons that begin with a `SCREAMING_SNAKE_CASE` code
prefix into structured `{ code, message }` telemetry entries it writes to
`chrome.storage.local`. Your content script should format its reasons as
``${DomUtilError.code}: ${human-readable detail}`` — e.g.
`'MEDIA_TOO_LARGE: assetUrl is 280 MB but cap is 200 MB'`,
`'TEXT_SET_FAILED: [role="dialog"][aria-label*="error"], [role="alert"]'`,
`'LOGIN_REQUIRED: [aria-label="Notifications"], [data-testid="not-found"]'`.
Any non-`DomUtilErrorCode`-prefixed reason is treated as an opaque
platform-error string and surfaces in the popup as the platform's
`lastErrorReason` field verbatim.

---

## 6. Testing your platform

Three tiers. Ship Tier 1 with the initial stub branch; ship Tier 2 with
the real implementation; ship Tier 3 always (stub or real — required by
the existing `T18` assertion).

### Tier 1 — Stub contract test

`pages/content/src/matches/__tests__/stubs.test.ts` currently has 2 `it`
blocks — one for TikTok, one for GBP — asserting each stub replies with
`SCHEDULE_FAILED` and reason `"Platform not yet supported (Story 6.4)"`.
Add a 3rd for your platform:

```ts
// file: pages/content/src/matches/__tests__/stubs.test.ts
// append to the existing describe('stubs', ...) block

it('twitter stub replies with SCHEDULE_FAILED for START_SCHEDULING', async () => {
  // Mirror the existing tiktok stub test at lines 47-60; substitute 'twitter'
  // for 'tiktok' and adjust the import path to '../twitter/index'.
  // ...
});
```

Run: `pnpm --filter @extension/content-script test:unit` (4 tests in the
content package, currently 2 stubs + 8 instagram + 9 facebook + 10
dom-utils = 29 tests; your new stub test makes it 30).

### Tier 2 — Real-implementation unit tests

Mirror `pages/content/src/matches/__tests__/instagram.test.ts` (227 lines,
8 `it` blocks I1-I8). The shared `beforeEach` boilerplate:

```ts
// file: pages/content/src/matches/__tests__/twitter.test.ts

import {
  __dispatchStartScheduling,
  __getLastOfType,
  __getSent,
  __resetShim,
  isolateWindowBeforeUnload,
} from './chrome-shim';
import { buildTwitterFixture } from './fixtures/twitter-fixture';  // you will need to write this too
import { installMockAssetFetch } from './fixtures/mock-asset';
import { useFakeTimers } from './timer-harness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CampaignPayload } from '@extension/shared';

describe('twitter content script', () => {
  beforeEach(async () => {
    __resetShim();
    document.body.innerHTML = '';
    isolateWindowBeforeUnload(window);
    installMockAssetFetch();
    vi.resetModules();
    vi.useFakeTimers();
    // The imported binding is unused: the import exists for its top-level
    // side effect (installing the onMessage listener).
    await import('../twitter/index');
  });

  // I1: happy path with scheduledTime sends SCHEDULE_COMPLETE and mutates the composer DOM
  // I2: happy path without scheduledTime skips the datetime sub-step
  // I3: no authenticatedMarker -> bails fast with SCHEDULE_FAILED(LOGIN_REQUIRED)
  // I4: create-post button never appears -> ELEMENT_NOT_FOUND
  // I5: error indicator wins waitForOutcome race -> TEXT_SET_FAILED
  // I6: MEDIA_TOO_LARGE
  // I7: MEDIA_FETCH_FAILED
  // I8: beforeunload mid-schedule emits exactly one SCHEDULE_FAILED(tab_closed)
});
```

You will also need a `pages/content/src/matches/__tests__/fixtures/twitter-fixture.ts`
mirroring `instagram-fixture.ts` (83 lines) — building the mock DOM
`{ createPostButton, fileInput, textarea, datetimeInput, scheduleButton,
successDialog, errorDialog }` and exposing an `Outcome` switch.

### Tier 3 — Background-side integration tests

The load-bearing assertion is `T18` at
`chrome-extension/src/background/__tests__/index.test.ts:795`:

```ts
// file: chrome-extension/src/background/__tests__/index.test.ts
// lines: 824-827

// BEFORE:
expect(ids).toEqual([
  'litoral-instagram-scheduler',
  'litoral-facebook-scheduler',
  'litoral-tiktok-scheduler',
  'litoral-gbp-scheduler',
]);

// AFTER: add the 5th element at the end (or wherever you placed the new
// record in registerContentScripts):
expect(ids).toEqual([
  'litoral-instagram-scheduler',
  'litoral-facebook-scheduler',
  'litoral-tiktok-scheduler',
  'litoral-gbp-scheduler',
  'litoral-twitter-scheduler',
]);
```

`toEqual` is order-sensitive. The order in the registration array at
`index.ts:421-450` MUST match the order in the expected-array — record
position N in `registerContentScripts([...])` corresponds to position N in
the assertion. Add your record at the END of the array AND at the END of
the expected-array to keep the diff minimal.

Recommended additional tests:
- **T20 (new):** `GET_STATE` payload `platforms` array has 5 entries including
  `code: 'twitter'`, mirroring the existing `T14` (line 595) per-platform
  status assertions. Verify `telemetry['twitter'].lastSuccessAt === null`
  on first GET_STATE so the seed in Edit 5b is exercised.
- **Orchestrator:** Add one `makeCampaign({ platform: 'twitter' })` test
  to `chrome-extension/src/background/__tests__/scheduling-orchestrator.test.ts`
  that drives the URL-lookup through `getPlatformScheduleUrl('twitter')`
  and asserts the returned URL matches `PLATFORM_SCHEDULE_URLS.twitter`.
  This is a forward-protection guard against accidentally removing your
  new entry from the map.

**Coverage gate:** `chrome-extension/vitest.config.ts:23-41` enforces 100%
line/branch/function/statement coverage on `scheduling-orchestrator.ts` and
`circuit-breaker.ts`. Adding a platform DOES NOT add new branch arms to
either file — `scheduleOneCampaign` is lookup-driven via
`getPlatformScheduleUrl` (single `if/throw` arm at lines 461-467), and
`CircuitBreaker.isOpen`/`recordFailure`/`recordSuccess` use
`Record<string, ...>` keyed by platform string (no per-platform branch).
Your new platform therefore does NOT require new orchestrator tests for
the coverage gate to stay green — but the recommended test above is good
hygiene.

### Commands

```bash
pnpm --filter @extension/content-script test:unit                 # Tier 1 + 2
pnpm --filter chrome-extension test:unit -- --coverage            # Tier 3 + coverage gate
pnpm type-check                                                  # catches TS2741 if you missed an edit
pnpm lint                                                        # 19 turbo tasks (ESLint does NOT lint markdown)
```

ESLint's file-glob is `**/*.{ts,tsx}` and `.prettierignore` explicitly
excludes `*.md`, so neither markdown nor your new TS file's surrounding
documentation is mechanically linted. The TypeScript compiler is your
single gate — `pnpm type-check` MUST pass before commit.

---

## 7. Manual end-to-end verification

After the seven edits + the Tier 1 + Tier 3 tests land:

- [ ] `pnpm zip` → load `dist/` as unpacked extension in Chrome via
  `chrome://extensions` (Developer Mode → Load unpacked). Confirm the
  extension loads without console errors.
- [ ] Open the popup, click CONNECT, paste an operator JWT (the external
  backend at `https://litoral.agency` must accept it — out of scope for this
  guide, see `docs/ONBOARDING.md#3`).
- [ ] Wait for the popup's "Platforms" section to show your new platform as
  the 5th row with `status: idle` (bullet `•`) and `consecutiveFailures: 0`.
- [ ] Open DevTools on the popup → Console → confirm a `GET_STATE` debug
  log iterates `['instagram','facebook','tiktok','gbp','twitter']`. If
  your platform is missing from the enumeration, Edit 2 (`SUPPORTED_PLATFORMS`)
  was skipped.
- [ ] Manually navigate to your platform's scheduling URL from
  `PLATFORM_SCHEDULE_URLS` — open DevTools → Sources → Content scripts,
  confirm `litoral-<platform>-scheduler.js` is in the script list and
  registered against the URL you opened. If missing, Edit 6 was skipped
  or the `matches:` URL pattern does not cover this URL.
- [ ] Trigger a real scheduling attempt via the popup (or wait for the
  backend to push a campaign with `platform: '<platform>'`). Watch the
  popup's per-platform row transition:
  - stub: `idle` → `error` after 1 attempt → `error` → `error` →
    `breaker_open` 🔴 after 3 attempts (15-minute cooldown before further
    dispatch attempts). The platform's `lastErrorReason` field should
    show `"Platform not yet supported"`.
  - real: `idle` → `ok` ✅ on success; `idle` → `error` on failure. Verify
    `lastSuccessAt` advances on success, `lastFailureAt` advances + the
    reason string populates on failure, `consecutiveFailures` resets to 0
    on success.

The popup auto-refreshes every 5 seconds via `setInterval` in the `useEffect`
hook at `pages/popup/src/Popup.tsx:93` — you should see the per-platform row
transition within ~5 seconds of the scheduling attempt completing.

---

## 8. Common pitfalls

- **Forgot the second `PlatformCode` redeclaration** at
  `extension-poll-storage.ts:14,16`. `INITIAL_TELEMETRY` is computed from
  `SUPPORTED_PLATFORMS_LOCAL`, so storage seeds the new platform's
  telemetry slot only if you update the LOCAL list. TypeScript does NOT
  catch this — the local `PlatformCode` is structurally typed, not imported
  from `@extension/shared`. The first scheduling attempt will write
  `telemetry['<newplatform>']` via the spread operator at
  `extension-poll-storage.ts:147-185`, and the GET_STATE handler at
  `index.ts:333` tolerates the missing seed via `telemetry[code] ??
  EMPTY_TELEMETRY` — popup rendering works by accident, not by design.
  Add to both lists.
- **MISMATCHED `<platform>` vs `<platform-id>` strings** — the content
  script file at `pages/content/src/matches/<platform>/index.ts` is built
  by Vite to `content/<platform>.js`. The `chrome.scripting
  .registerContentScripts` record's `js: ['content/<platform>.js']` MUST
  match exactly. A typo registers an empty script silently — the
  orchestrator's `chrome.tabs.sendMessage` then rejects with "Could not
  establish connection" and the campaign hangs until the 90-second
  `SCHEDULING_TIMEOUT_MS` timeout fires.
- **`matches:` pattern too broad or too narrow** — e.g.
  `https://www.instagram.com/*` covers all of instagram including the
  user's home feed; this is intentional because the orchestrator opens the
  specific creator-studio URL and the content script runs at the right
  place. Mis-scoping creates either duplicate-registration attempts
  (swallowed by the `Duplicate`-message idempotent catch at
  `index.ts:455-459`) OR missing registration entirely (silent — relies on
  manual DevTools verification per the Section 7 checklist).
- **Test `T18` array order matters** — `toEqual` is order-sensitive. The
  registration records iterate in the order they appear in the
  `registerContentScripts([...])` argument, so add your new record at the
  END of the array AND at the END of the expected-order in `T18`.
- **Don't edit the popup** — popup is data-driven via
  `status.platforms.map(...)`. Hardcoding a 5th platform row in the popup
  is a regression — the popup is the wrong touch-point.
- **`SUPPORTED_PLATFORMS` is `readonly`** — attempts to `.push()` will
  fail at compile time. Edit the array literal in place.
- **`BREAKER_THRESHOLD` is 3** — three consecutive `SCHEDULE_FAILED` from
  your new stub will open the per-platform breaker for 15 minutes (see
  `circuit-breaker.ts:28-39`). During manual verification the operator
  can hit this quickly — the popup's "Clear Errors" button calls
  `popupBreaker.resetAll()` and clears the per-platform breaker state.
  This is normal debugging behavior, not a bug in your platform.

---

## 9. Reference: the existing TikTok stub pattern

`pages/content/src/matches/tiktok/index.ts` (26 lines, quoted in full in
Section 2 above) is the canonical minimal-stub reference. Its structural
twin is `pages/content/src/matches/gbp/index.ts` (26 lines). Both ship
today as no-op stubs with `SCHEDULE_FAILED` + `"Platform not yet supported
(Story 6.4)"` reasons — covered by `stubs.test.ts`.

For the canonical real implementation, study in this order:

1. **`pages/content/src/matches/instagram/index.ts`** (230 lines) — the
   simpler real implementation. 8 ordered steps from login detection to
   outcome waiting. Uses every `dom-utils.ts` helper. Start here.
2. **`pages/content/src/matches/facebook/index.ts`** (248 lines) — the
   more complex real implementation. Facebook's Meta Business Suite has a
   SplitButton "Publish" dropdown that requires an extra sub-step to
   reveal the "Schedule" menu item before the datetime picker becomes
   interactable. Read this only after Instagram makes sense.
3. **`pages/content/src/shared/dom-utils.ts`** (432 lines) — the full
   helper surface. Read its exports once at the start of your real
   implementation; re-read it incrementally once your platform's flow
   hits each helper's branch.

For cross-references:

- The orchestrator's full dispatch path:
  `chrome-extension/src/background/scheduling-orchestrator.ts:229-367`
  (`scheduleOneCampaign`). Read once at the start so you know what the
  background expects from your content script.
- The `CampaignPayload` shape your content script consumes:
  `packages/shared/lib/utils/extension-types.ts:7-16`.
- The `PollStatusPayload` shape the popup renders (your platform's row
  flows through here):
  `packages/shared/lib/utils/extension-types.ts:47-67`.
- The Q9 marker-detach behavior (your content script's `SCHEDULE_COMPLETE`
  no longer blocks the orchestrator cycle's local-state convergence — see
  `docs/TROUBLESHOOTING.md`'s Q9 FAQ entry).
