/**
 * `fetch` stub for `uploadMedia` content-script tests.
 *
 * `dom-utils.uploadMedia` calls `fetch(assetUrl)` expecting a JSend-style
 * success: a `200` with a populated `content-length` and a `blob()`. The
 * shared stub serves a small JPEG so `uploadMedia` can build a `File` and
 * dispatch it via `DataTransfer` (the permissive `files` setter is installed
 * by `pages/content/src/shared/__tests__/setup.ts`).
 *
 * Three knobs let negative-path tests opt into failure modes without touching
 * the fixture DOM:
 *  - `installMockAssetFetch()`                          → 200 / 1024 bytes / image/jpeg (happy path)
 *  - `installMockAssetFetch({ status: 404 })`           → `MEDIA_FETCH_FAILED`
 *  - `installMockAssetFetch({ contentLength: hugeN })`  → `MEDIA_TOO_LARGE` (size check fires pre-blob)
 *
 * Teardown is the test file's job (`afterEach(() => vi.restoreAllMocks())`).
 */
import { vi } from 'vitest';

const DEFAULT_CONTENT_LENGTH = '1024';

const buildOkResponse = (contentLength = DEFAULT_CONTENT_LENGTH) => ({
  ok: true,
  status: 200,
  headers: {
    get: (name: string) => (name.toLowerCase() === 'content-length' ? contentLength : null),
  },
  blob: async () => new Blob([new Uint8Array(Number(contentLength) || 0)], { type: 'image/jpeg' }),
});

export interface MockAssetOptions {
  /** HTTP status for the asset fetch. Anything non-2xx is treated as a failure by `uploadMedia`. */
  status?: number;
  /** Override `Content-Length` header (bytes). >200MB trips `MEDIA_TOO_LARGE`. */
  contentLength?: string;
}

/**
 * Install a global `fetch` mock returning the configured asset response.
 * The original `fetch` is restored by the importing test file's
 * `afterEach(() => vi.restoreAllMocks())` — kept in the test file so the
 * lifecycle registration lives with the test, not here.
 */
export const installMockAssetFetch = (opts: MockAssetOptions = {}): void => {
  const { status = 200, contentLength = DEFAULT_CONTENT_LENGTH } = opts;

  const response =
    status >= 200 && status < 300
      ? buildOkResponse(contentLength)
      : { ok: false, status, headers: { get: () => contentLength }, blob: async () => new Blob() };

  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response as Response);
};
