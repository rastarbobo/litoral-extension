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

/**
 * Simple delay (used by content scripts — no setTimeout in some contexts).
 */
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Wait for a DOM element matching the selector to appear.
 * Retries every 500ms until found or timeout.
 */
const waitForElement = async (selector: string, timeoutMs: number): Promise<Element> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const el = document.querySelector(selector);
    if (el) return el;
    await delay(500);
  }
  throw new Error(`Element not found after ${timeoutMs}ms: ${selector}`);
};

/**
 * Wait for a DOM element matching the selector to DISAPPEAR.
 * Retries every 500ms until gone or timeout.
 */
const waitForElementToDisappear = async (selector: string, timeoutMs: number): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const el = document.querySelector(selector);
    if (!el) return;
    await delay(500);
  }
  throw new Error(`Element still present after ${timeoutMs}ms: ${selector}`);
};

/**
 * Click a DOM element.
 * Uses native .click() — dispatches MouseEvent as fallback for elements that block programmatic clicks.
 */
const clickElement = (selector: string): void => {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`Cannot click — element not found: ${selector}`);

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
  if (!el) throw new Error(`Cannot set text — element not found: ${selector}`);

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
 * Converts ISO 8601 to datetime-local format (YYYY-MM-DDTHH:mm).
 */
const setDateTimeInput = (selector: string, isoString: string): void => {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`Cannot set datetime — element not found: ${selector}`);

  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

  // Convert ISO 8601 to datetime-local format (YYYY-MM-DDTHH:mm)
  const local = new Date(isoString);
  const formatted = local.toISOString().slice(0, 16);
  if (nativeSetter) {
    nativeSetter.call(el, formatted);
  } else {
    (el as HTMLInputElement).value = formatted;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
};

/** Maximum asset size in bytes (50 MB for images, 200 MB for videos) */
const MAX_ASSET_SIZE_BYTES = 200 * 1024 * 1024;

/**
 * Upload a media file via a file input element.
 *
 * Fetches the file from the signed R2 URL, creates a File object,
 * and dispatches to the input using DataTransfer (required for React file inputs).
 *
 * @throws Error if the asset exceeds {@link MAX_ASSET_SIZE_BYTES} or fetch fails
 */
const uploadMedia = async (inputSelector: string, assetUrl: string): Promise<void> => {
  const input = document.querySelector(inputSelector) as HTMLInputElement;
  if (!input) throw new Error(`File input not found: ${inputSelector}`);

  const response = await fetch(assetUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch asset from ${assetUrl}: ${response.status}`);
  }

  // Guard against oversized media files before downloading into memory
  const contentLength = response.headers.get('content-length');
  if (contentLength) {
    const size = parseInt(contentLength, 10);
    if (size > MAX_ASSET_SIZE_BYTES) {
      throw new Error(
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
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
};

/**
 * Wait for media processing to complete.
 *
 * Instagram/Facebook show a progress indicator while processing uploaded media.
 * Check for common processing selectors.
 *
 * @param timeoutMs — max time to wait (default: 30s)
 * @param throwOnTimeout — whether to throw if timeout is reached (default: true)
 * @returns `true` if processing completed, `false` if timeout was reached (only when `throwOnTimeout=false`)
 * @throws Error if timeout is reached and `throwOnTimeout=true`
 */
const waitForMediaProcessing = async (timeoutMs = 30_000, throwOnTimeout = true): Promise<boolean> => {
  const start = Date.now();
  const processingSelectors = [
    '[role="progressbar"]',
    '[data-testid="media-upload-progress"]',
    '[aria-label="Processing"]',
    '[aria-label*="Uploading"]',
  ];

  while (Date.now() - start < timeoutMs) {
    const anyProcessing = processingSelectors.some(sel => document.querySelector(sel));
    if (!anyProcessing) return true; // No processing indicator = done
    await delay(1000);
  }

  // Timeout reached
  if (throwOnTimeout) {
    throw new Error(`Media processing timeout — no completion signal after ${timeoutMs}ms`);
  }
  return false;
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
};
