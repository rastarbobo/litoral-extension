/**
 * Phase 2.4 Error Injection Tests — shared `fetch` mocking harness for the
 * background service-worker API surface.
 *
 * This module complements `./setup.ts`, which installs an in-memory
 * `globalThis.chrome` shim but provides NO `fetch` mocking. The background
 * service worker hits two fetch surfaces against `https://litoral.agency/api/extension/...`:
 *  - `index.ts` calls `/queue` (GET) and `/queue/claim` (POST) and branches on
 *    `res.status === 401`, `!res.ok`, and `res.json()`.
 *  - `scheduling-orchestrator.ts` calls `/queue/scheduled` (POST) and branches
 *    on `!res.ok` and `res.json()` only.
 *
 * Every helper here RETURNS a Vitest mock (`vi.fn`); helpers do NOT install
 * themselves as `globalThis.fetch`. Tests own installation/teardown so isolation
 * matches the existing per-test `vi.resetModules()` + `vi.unstubAllGlobals()`
 * convention used across `scheduling-orchestrator.test.ts`. Install with
 * `vi.stubGlobal('fetch', returnedFn)` and restore via `vi.unstubAllGlobals()`
 * / `vi.restoreAllMocks()` in the test's `afterEach`.
 *
 * Side-effect-free on import — no top-level `vi.stubGlobal` calls.
 */
import { expect, vi } from 'vitest';

/** Plain response-descriptor shape returned by the success/status builders. */
interface FetchResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

/**
 * Build a 2xx happy-path response. The same envelope serves both surfaces:
 * `fetchQueue`/`claimCampaign` receive `{status:'success', data:{...}}`, while
 * `markScheduledOnServer` only inspects `body.status === 'success'`. Production
 * never reads `status` from a 2xx response (the success arm checks `res.ok`),
 * so `status: 200` is present for completeness only.
 */
const mockFetchJson = (body: unknown): FetchResponse => ({
  ok: true,
  status: 200,
  json: async () => body,
});

/**
 * Build a status-coded response. `ok` is derived from the 2xx range to mirror
 * the real `Response.ok` contract. Targets the `res.status === 401` / `!res.ok`
 * branches in `fetchQueue`/`claimCampaign`. For 401 specifically, production
 * returns early WITHOUT calling `res.json()`, so `json` is provided but is
 * expected to remain uncalled for the 401 path.
 */
const mockFetchStatus = (status: number, body: unknown = {}): FetchResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/**
 * Build a mock that rejects with `error` on EVERY call. Targets the
 * `markScheduledOnServer` catch arm (`error instanceof Error ? error.message :
 * primitive`). For `pollForCampaigns`'s outer offline catch, tests pass
 * `new TypeError('Failed to fetch')` — Chrome's actual offline sentinel.
 */
const mockFetchReject = (error: unknown) => vi.fn().mockRejectedValue(error);

/**
 * Build a mock whose every call resolves to a never-settling Promise. Models a
 * network black-hole: the request neither resolves nor rejects. Tests pair
 * this with fake timers to drive a higher-level scheduling timeout
 * (`SCHEDULING_TIMEOUT_MS` / `TAB_LOAD_TIMEOUT_MS`).
 */
const mockFetchHang = () => vi.fn().mockImplementation(() => new Promise(() => {}));

/**
 * Build a sequence mock that returns `responses[i]` for the i-th call and
 * `responses[responses.length-1]` (sticky last) for every call past the end.
 * Models "fail N times then recover" cadences (e.g. 2.4's backoff test: three
 * failures then a success).
 *
 * CONTRACT (Option A): each entry is a RAW response descriptor, NOT a `vi.fn`
 * from the other builders. Accept three entry shapes:
 *  - `{ ok, status, json }` plain object (e.g. `mockFetchJson`/`mockFetchStatus`
 *    OUTPUTS — note those builders return objects, not vi.fns) → returned as-is
 *    via a resolved Promise.
 *  - an `Error` instance (or any non-object-with-ok truthy value) → returned as
 *    a REJECTED Promise via `Promise.reject(error)` so production's
 *    `await fetch(...)` hits the catch arm naturally. Never thrown synchronously.
 *  - a never-settling `Promise` (e.g. the result of `mockFetchHang()()` — call
 *    the hang mock to obtain its promise) → returned as-is so the call hangs.
 *
 * Mixing resolved/rejected/hung entries in one sequence is supported: each
 * entry is classified by runtime shape, not by builder origin.
 */
const mockFetchSequence = (responses: unknown[]) => {
  const bound = responses.length;
  // Per-instance call counter captured in closure scope — every call advances
  // `i`; calls past `bound` reuse the final entry (sticky-last semantics).
  let i = 0;
  return vi.fn(() => {
    const entry = bound === 0 ? undefined : responses[Math.min(i, bound - 1)];
    i += 1;
    if (entry instanceof Promise) return entry;
    if (
      entry !== null &&
      typeof entry === 'object' &&
      'ok' in (entry as Record<string, unknown>) &&
      'status' in (entry as Record<string, unknown>)
    ) {
      return Promise.resolve(entry);
    }
    // Reject (don't throw synchronously) so `await fetch(...)` hits the catch.
    return Promise.reject(entry);
  });
};

/**
 * Convenience wrapper: build the sequence mock via `mockFetchSequence` and
 * install it as `globalThis.fetch` via `vi.stubGlobal`, returning the fn so the
 * test can assert `toHaveBeenCalledWith(url, init)`. Auto-restoration is the
 * test's responsibility (call `vi.unstubAllGlobals()` in `afterEach`/inline —
 * keep the existing pattern).
 */
const installFetchSequence = (responses: unknown[]) => {
  const fn = mockFetchSequence(responses);
  vi.stubGlobal('fetch', fn);
  return fn;
};

/**
 * Ergonomic assertion: walks `mockFn.mock.calls` and confirms some call's first
 * arg (a string URL) includes `expectedUrlSubstring`, and (when provided) the
 * second arg's `init.method === expectedMethod`. Throws a Vitest-style
 * assertion error with a descriptive message on mismatch (or when the mock has
 * no recorded calls). Example: `assertFetchedUrl(fetchMock, '/queue/claim', 'POST')`.
 */
const assertFetchedUrl = (
  mockFn: { mock: { calls: unknown[][] } },
  expectedUrlSubstring: string,
  expectedMethod?: string,
): true => {
  const calls = mockFn.mock.calls;
  expect(calls.length, 'assertFetchedUrl: fetch was never called').toBeGreaterThan(0);
  const hit = calls.some(call => {
    const url = call[0];
    if (typeof url !== 'string' || !url.includes(expectedUrlSubstring)) return false;
    if (expectedMethod === undefined) return true;
    const init = call[1];
    return init !== null && typeof init === 'object' && (init as { method?: string }).method === expectedMethod;
  });
  expect(
    hit,
    `assertFetchedUrl: no fetch call matched substring "${expectedUrlSubstring}"` +
      (expectedMethod ? ` with method "${expectedMethod}"` : ''),
  ).toBe(true);
  return true;
};

export {
  assertFetchedUrl,
  installFetchSequence,
  mockFetchHang,
  mockFetchJson,
  mockFetchReject,
  mockFetchSequence,
  mockFetchStatus,
};
export type { FetchResponse };
