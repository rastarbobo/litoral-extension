import { DomUtilError, setDateTimeInput, uploadMedia, waitForElement } from '../dom-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('waitForElement', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves immediately when the element already exists', async () => {
    const node = document.createElement('div');
    node.id = 'already-here';
    node.classList.add('target');
    document.body.appendChild(node);

    const result = await waitForElement('.target', { timeoutMs: 100, retryIntervalMs: 5 });
    expect(result).toBe(node);
  });

  it('throws DomUtilError(ELEMENT_NOT_FOUND) when the timeout expires before the element appears', async () => {
    await expect(waitForElement('.never-renders', { timeoutMs: 25, retryIntervalMs: 5 })).rejects.toBeInstanceOf(
      DomUtilError,
    );

    await expect(waitForElement('.never-renders', { timeoutMs: 25, retryIntervalMs: 5 })).rejects.toMatchObject({
      name: 'DomUtilError',
      code: 'ELEMENT_NOT_FOUND',
      selector: '.never-renders',
      timeoutMs: 25,
    });
  });

  it('throws after exhausting retries even if the timeout window has not elapsed', async () => {
    const elapsedSpy = vi.spyOn(Date, 'now').mockReturnValue(0);

    try {
      await expect(
        waitForElement('.still-missing', { retries: 2, retryIntervalMs: 5, timeoutMs: 5_000 }),
      ).rejects.toBeInstanceOf(DomUtilError);

      // Two body iterations × one querySelector spy call each = 2 attempts, no more.
      const calls = elapsedSpy.mock.calls.length;
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      elapsedSpy.mockRestore();
    }
  });

  it('throws ELEMENT_NOT_FOUND when stateCheck rejects the matched element', async () => {
    const node = document.createElement('span');
    node.id = 'present-but-not-ready';
    document.body.appendChild(node);

    await expect(
      waitForElement('#present-but-not-ready', {
        timeoutMs: 25,
        retryIntervalMs: 5,
        stateCheck: () => false,
      }),
    ).rejects.toMatchObject({
      code: 'ELEMENT_NOT_FOUND',
      selector: '#present-but-not-ready',
    });
  });
});

describe('setDateTimeInput', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sets value and dispatches input/change on a native input[type="datetime-local"]', async () => {
    const input = document.createElement('input');
    input.type = 'datetime-local';
    input.id = 'schedule';
    document.body.appendChild(input);

    const onInput = vi.fn();
    const onChange = vi.fn();
    input.addEventListener('input', onInput);
    input.addEventListener('change', onChange);

    // Use a local-time Date so the expected formatted output is timezone-stable.
    const localWallClock = new Date(2026, 11, 15, 10, 30, 0); // Dec 15, 2026, 10:30 LOCAL
    const iso = localWallClock.toISOString();

    setDateTimeInput('#schedule', iso);

    expect(input.value).toBe('2026-12-15T10:30');
    expect(onInput).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('falls back to textContent on a contentEditable div when document.execCommand is a no-op', () => {
    const div = document.createElement('div');
    div.id = 'rich-picker';
    div.contentEditable = 'true';
    document.body.appendChild(div);

    const onInput = vi.fn();
    const onChange = vi.fn();
    div.addEventListener('input', onInput);
    div.addEventListener('change', onChange);

    // Build the ISO string from local-time components so the formatted output is TZ-stable.
    const localWallClock = new Date(2026, 11, 15, 10, 30, 0);
    const iso = localWallClock.toISOString();

    setDateTimeInput('#rich-picker', iso);

    expect(onInput).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(div.textContent).toBe('2026-12-15T10:30');
  });

  it('uses local time components when computing the YYYY-MM-DDTHH:mm output (not UTC)', () => {
    // Construct a `Date` from a defined local wall clock so the expected formatted string is
    // stable across CI machines regardless of timezone.
    const localWallClock = new Date(2026, 6, 13, 9, 30, 0); // July 13, 2026, 09:30 LOCAL
    const iso = localWallClock.toISOString();

    const input = document.createElement('input');
    input.id = 'tz-probe';
    input.type = 'datetime-local';
    document.body.appendChild(input);

    setDateTimeInput('#tz-probe', iso);

    expect(input.value).toBe('2026-07-13T09:30');
  });
});

const buildFetchResponse = (init: {
  ok?: boolean;
  status?: number;
  contentLength?: number | null;
  body?: BodyInit;
  contentType?: string;
}): Response => {
  const headers = new Headers();
  if (init.contentLength !== undefined && init.contentLength !== null) {
    headers.set('content-length', String(init.contentLength));
  }
  if (init.contentType) {
    headers.set('content-type', init.contentType);
  }
  return new Response(init.body ?? new Uint8Array([1, 2, 3, 4]), {
    status: init.status ?? 200,
    statusText: init.ok === false ? 'Internal Server Error' : 'OK',
    headers,
  });
};

describe('uploadMedia', () => {
  beforeEach(() => {
    document.body.innerHTML = '';

    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'file-picker';
    document.body.appendChild(input);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('rejects with DomUtilError(MEDIA_TOO_LARGE) when content-length exceeds MAX_ASSET_SIZE_BYTES', async () => {
    const oversized = 300 * 1024 * 1024; // 300 MB, above the 200 MB cap
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(buildFetchResponse({ contentLength: oversized })));

    await expect(uploadMedia('#file-picker', 'https://example.test/big.jpg')).rejects.toBeInstanceOf(DomUtilError);

    await expect(uploadMedia('#file-picker', 'https://example.test/big.jpg')).rejects.toMatchObject({
      code: 'MEDIA_TOO_LARGE',
    });
  });

  it('returns normally when no processing indicators are observed after the change event', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(buildFetchResponse({ contentLength: 10, contentType: 'image/png' })),
    );

    // Force every processing-indicator selector to resolve to null so waitForMediaProcessing
    // returns true on its first loop iteration.
    const querySpy = vi.spyOn(document, 'querySelector').mockImplementation(selector => {
      if (
        selector === '[role="progressbar"]' ||
        selector === '[data-testid="media-upload-progress"]' ||
        selector === '[aria-label="Processing"]' ||
        selector === '[aria-label*="Uploading"]'
      ) {
        return null;
      }
      // Defer to real querySelector for non-indicator selectors (e.g. the file input match).
      return Document.prototype.querySelector.call(document, selector);
    });

    await flushMicrotasks();

    const onChange = vi.fn();
    const fileInput = document.querySelector('#file-picker') as HTMLInputElement;
    fileInput.addEventListener('change', onChange);

    await expect(
      uploadMedia('#file-picker', 'https://example.test/small.png', {
        waitForProcessing: { timeoutMs: 50 },
      }),
    ).resolves.toBeUndefined();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect((fileInput.files?.length ?? 0) === 1).toBe(true);
    querySpy.mockRestore();
  });

  it('throws DomUtilError(MEDIA_PROCESSING_TIMEOUT) when processing indicators never clear', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(buildFetchResponse({ contentLength: 10, contentType: 'image/png' })),
    );

    // Always return a truthy element for every processing indicator selector.
    const fakeIndicator = document.createElement('div');
    const querySpy = vi.spyOn(document, 'querySelector').mockImplementation(selector => {
      if (
        selector === '[role="progressbar"]' ||
        selector === '[data-testid="media-upload-progress"]' ||
        selector === '[aria-label="Processing"]' ||
        selector === '[aria-label*="Uploading"]'
      ) {
        return fakeIndicator;
      }
      return Document.prototype.querySelector.call(document, selector);
    });

    await flushMicrotasks();

    await expect(
      uploadMedia('#file-picker', 'https://example.test/small.png', {
        waitForProcessing: { timeoutMs: 25, throwOnTimeout: true },
      }),
    ).rejects.toMatchObject({
      code: 'MEDIA_PROCESSING_TIMEOUT',
      timeoutMs: 25,
    });

    querySpy.mockRestore();
  });
});
