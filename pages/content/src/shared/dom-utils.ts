/**
 * Shared DOM Utilities for Platform Content Scripts
 *
 * These utilities are used by Instagram, Facebook, TikTok, and GBP content scripts
 * to navigate social platform DOMs and inject campaign media/captions.
 *
 * Key considerations:
 * - Social platforms use React — inputs need native setters + synthetic events
 * - File inputs need DataTransfer objects to trigger React's change handler
 * - All selectors use aria-label where possible (more stable than class names)
 *
 * Architecture: Shared module imported by all platform-specific content scripts.
 * Each platform module is isolated per Story 6.4 boundary.
 */

/** Codes returned by each DOM util failure mode. */
type DomUtilErrorCode =
  | 'ELEMENT_NOT_FOUND'
  | 'ELEMENT_NOT_CLICKABLE'
  | 'TEXT_SET_FAILED'
  | 'DATETIME_SET_FAILED'
  | 'MEDIA_TOO_LARGE'
  | 'MEDIA_FETCH_FAILED'
  | 'MEDIA_PROCESSING_TIMEOUT'
  | 'TIMEOUT'
  | 'LOGIN_REQUIRED';

/** Error type thrown by all DOM utilities. Carries a typed `code`
 *  so callers can dispatch on failure reason. */
class DomUtilError extends Error {
  readonly code: DomUtilErrorCode;
  readonly selector?: string;
  readonly timeoutMs?: number;

  constructor(code: DomUtilErrorCode, message: string, meta?: { selector?: string; timeoutMs?: number }) {
    super(message);
    this.name = 'DomUtilError';
    this.code = code;
    this.selector = meta?.selector;
    this.timeoutMs = meta?.timeoutMs;
  }
}

/**
 * Options for {@link waitForElement} / {@link waitForElementToDisappear}.
 */
interface WaitForElementOptions {
  /** Total wall-clock budget in ms. */
  timeoutMs?: number;
  /** Poll interval between attempts (ms). Default 500. */
  retryIntervalMs?: number;
  /** Total attempts allowed within `timeoutMs`. Default 1 (current behavior). */
  retries?: number;
  /** Optional check that the matched element is "ready" (e.g., visible / interactive). */
  stateCheck?: (el: Element) => boolean;
}

/** Options for {@link waitForMediaProcessing}. */
interface MediaProcessingOptions {
  indicatorSelectors?: string[];
  timeoutMs?: number;
  throwOnTimeout?: boolean;
}

/** Options for {@link uploadMedia}. */
interface UploadMediaOptions {
  /** When set, uploadMedia will await `waitForMediaProcessing` after dispatching the change event. */
  waitForProcessing?: MediaProcessingOptions;
}

/**
 * Simple delay (used by content scripts — no setTimeout in some contexts).
 */
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Wait for a DOM element matching the selector to appear.
 * Retries every 500ms until found or timeout.
 */
const waitForElement = async (selector: string, timeoutMsOrOpts?: number | WaitForElementOptions): Promise<Element> => {
  const opts: WaitForElementOptions =
    typeof timeoutMsOrOpts === 'number' || timeoutMsOrOpts === undefined
      ? { timeoutMs: typeof timeoutMsOrOpts === 'number' ? timeoutMsOrOpts : 10_000 }
      : timeoutMsOrOpts;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const retryIntervalMs = opts.retryIntervalMs ?? 500;
  const retries = opts.retries ?? 1;
  const stateCheck = opts.stateCheck;

  const start = Date.now();
  let lastMatched: Element | null = null;
  for (let attempt = 0; attempt < retries && Date.now() - start < timeoutMs; attempt++) {
    const el = document.querySelector(selector);
    if (el) {
      if (stateCheck && !stateCheck(el)) {
        lastMatched = el;
      } else {
        return el;
      }
    }
    await delay(retryIntervalMs);
  }
  throw new DomUtilError(
    'ELEMENT_NOT_FOUND',
    `Element not found after ${timeoutMs}ms: ${selector}${lastMatched && stateCheck ? ' (stateCheck failed)' : ''}`,
    { selector, timeoutMs },
  );
};

/**
 * Wait for a DOM element matching the selector to DISAPPEAR.
 * Retries every 500ms until gone or timeout.
 */
const waitForElementToDisappear = async (
  selector: string,
  timeoutMsOrOpts?: number | WaitForElementOptions,
): Promise<void> => {
  const opts: WaitForElementOptions =
    typeof timeoutMsOrOpts === 'number' || timeoutMsOrOpts === undefined
      ? { timeoutMs: typeof timeoutMsOrOpts === 'number' ? timeoutMsOrOpts : 10_000 }
      : timeoutMsOrOpts;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const retryIntervalMs = opts.retryIntervalMs ?? 500;
  const retries = opts.retries ?? 1;

  const start = Date.now();
  for (let attempt = 0; attempt < retries && Date.now() - start < timeoutMs; attempt++) {
    const el = document.querySelector(selector);
    if (!el) return;
    await delay(retryIntervalMs);
  }
  throw new DomUtilError('ELEMENT_NOT_FOUND', `Element still present after ${timeoutMs}ms: ${selector}`, {
    selector,
    timeoutMs,
  });
};

/**
 * Click a DOM element.
 * Uses native .click() — dispatches MouseEvent as fallback for elements that block programmatic clicks.
 */
const clickElement = (selector: string): void => {
  const el = document.querySelector(selector);
  if (!el) {
    throw new DomUtilError('ELEMENT_NOT_CLICKABLE', `Cannot click — element not found: ${selector}`, { selector });
  }

  const htmlEl = el as HTMLElement;
  try {
    htmlEl.click();
  } catch {
    // If native click is blocked, dispatch a MouseEvent
    htmlEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }
};

/**
 * Set text content in an editable field (textarea, input, or contentEditable).
 *
 * Social platforms use React-controlled inputs. Setting .value directly is not enough —
 * we use the native property setter and dispatch synthetic input/change events.
 */
const setTextContent = (selector: string, text: string): void => {
  const el = document.querySelector(selector);
  if (!el) {
    throw new DomUtilError('TEXT_SET_FAILED', `Cannot set text — element not found: ${selector}`, {
      selector,
    });
  }

  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    // React-controlled inputs: use native value setter + input event
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(el, text);
    } else {
      // Fallback for non-React inputs
      (el as HTMLInputElement).value = text;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else if ((el as HTMLElement).contentEditable === 'true' || (el as HTMLElement).isContentEditable) {
    // ContentEditable div (common in rich text editors like Facebook)
    el.textContent = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    // Plain DOM element — set innerText
    (el as HTMLElement).innerText = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
};

/**
 * Set a datetime-local input value (React-controlled).
 *
 * Converts ISO 8601 to datetime-local format (YYYY-MM-DDTHH:mm) using local time.
 * Branches on element type to handle React-controlled custom date+time pickers
 * and contentEditable fallbacks.
 */
const setDateTimeInput = (selector: string, isoString: string): void => {
  const el = document.querySelector(selector);
  if (!el) {
    throw new DomUtilError('DATETIME_SET_FAILED', `Cannot set datetime — element not found: ${selector}`, { selector });
  }

  // Format ISO 8601 → datetime-local string (YYYY-MM-DDTHH:mm) using LOCAL time, not UTC.
  const local = new Date(isoString);
  const pad = (n: number) => String(n).padStart(2, '0');
  const formatted = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}T${pad(local.getHours())}:${pad(local.getMinutes())}`;

  const tag = el.tagName;
  const typeAttr = (el as Element).getAttribute('type');

  if (tag === 'INPUT' && typeAttr === 'datetime-local') {
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(el, formatted);
    } else {
      (el as HTMLInputElement).value = formatted;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }

  if (tag === 'INPUT') {
    // React-controlled text input picker (TikTok/GBP-style custom date+time picker).
    (el as HTMLElement).focus();
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(el, formatted);
    } else {
      (el as HTMLInputElement).value = formatted;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return;
  }

  // contentEditable / div-based picker
  (el as HTMLElement).focus();
  try {
    document.execCommand('insertText', false, formatted);
  } catch {
    el.textContent = formatted;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
};

/** Maximum asset size in bytes (50 MB for images, 200 MB for videos) */
const MAX_ASSET_SIZE_BYTES = 200 * 1024 * 1024;

/** Default selectors checked by {@link waitForMediaProcessing}. */
const DEFAULT_PROCESSING_SELECTORS = [
  '[role="progressbar"]',
  '[data-testid="media-upload-progress"]',
  '[aria-label="Processing"]',
  '[aria-label*="Uploading"]',
];

/**
 * Wait for media processing to complete.
 *
 * Instagram/Facebook show a progress indicator while processing uploaded media.
 * Check for common processing selectors.
 *
 * @param timeoutOrOpts — timeout in ms (default 30s) or options object
 * @param throwOnTimeout — (legacy) whether to throw if timeout is reached; only used when `timeoutOrOpts` is a number
 * @returns `true` if processing completed, `false` if timeout was reached (only when `throwOnTimeout=false`)
 * @throws DomUtilError('MEDIA_PROCESSING_TIMEOUT') if timeout is reached and `throwOnTimeout=true`
 */
const waitForMediaProcessing = async (
  timeoutOrOpts: number | MediaProcessingOptions = 30_000,
  throwOnTimeout: boolean = true,
): Promise<boolean> => {
  const opts: MediaProcessingOptions =
    typeof timeoutOrOpts === 'number' ? { timeoutMs: timeoutOrOpts, throwOnTimeout } : timeoutOrOpts;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const shouldThrow = opts.throwOnTimeout ?? true;
  const selectors = opts.indicatorSelectors ?? DEFAULT_PROCESSING_SELECTORS;

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const anyProcessing = selectors.some(sel => document.querySelector(sel));
    if (!anyProcessing) return true;
    await delay(1000);
  }
  if (shouldThrow) {
    throw new DomUtilError(
      'MEDIA_PROCESSING_TIMEOUT',
      `Media processing timeout — no completion signal after ${timeoutMs}ms`,
      { timeoutMs },
    );
  }
  return false;
};

/**
 * Upload a media file via a file input element.
 *
 * Fetches the file from the signed R2 URL, creates a File object,
 * and dispatches to the input using DataTransfer (required for React file inputs).
 *
 * When `opts.waitForProcessing` is provided, awaits {@link waitForMediaProcessing}
 * after dispatching the change event.
 *
 * @throws DomUtilError if the asset exceeds {@link MAX_ASSET_SIZE_BYTES} or fetch fails
 */
const uploadMedia = async (inputSelector: string, assetUrl: string, opts?: UploadMediaOptions): Promise<void> => {
  const input = document.querySelector(inputSelector);
  if (!input) {
    throw new DomUtilError('ELEMENT_NOT_FOUND', `File input not found: ${inputSelector}`, {
      selector: inputSelector,
    });
  }

  const response = await fetch(assetUrl);
  if (!response.ok) {
    throw new DomUtilError('MEDIA_FETCH_FAILED', `Failed to fetch asset from ${assetUrl}: ${response.status}`);
  }

  // Guard against oversized media files before downloading into memory
  const contentLength = response.headers.get('content-length');
  if (contentLength) {
    const size = parseInt(contentLength, 10);
    if (size > MAX_ASSET_SIZE_BYTES) {
      throw new DomUtilError(
        'MEDIA_TOO_LARGE',
        `Asset too large (${(size / 1024 / 1024).toFixed(1)} MB). Maximum allowed: ${MAX_ASSET_SIZE_BYTES / 1024 / 1024} MB.`,
      );
    }
  }

  const blob = await response.blob();

  // Determine file extension from MIME type
  const ext =
    blob.type === 'video/mp4'
      ? '.mp4'
      : blob.type === 'image/png'
        ? '.png'
        : blob.type === 'image/webp'
          ? '.webp'
          : '.jpg';
  const file = new File([blob], `litoral_campaign${ext}`, { type: blob.type });

  // React file inputs need DataTransfer for programmatic file setting
  const dt = new DataTransfer();
  dt.items.add(file);
  (input as HTMLInputElement).files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));

  if (opts?.waitForProcessing) {
    await waitForMediaProcessing(opts.waitForProcessing);
  }
};

export {
  delay,
  waitForElement,
  waitForElementToDisappear,
  clickElement,
  setTextContent,
  setDateTimeInput,
  uploadMedia,
  waitForMediaProcessing,
  DomUtilError,
};
export type { DomUtilErrorCode, WaitForElementOptions, MediaProcessingOptions, UploadMediaOptions };
