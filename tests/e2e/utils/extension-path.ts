import { STABLE_EXTENSION_ID } from './extension-id.js';

/**
 * Returns the Chrome extension path.
 *
 * Primary path: scrape `chrome://extensions/` shadow DOM for the `<extensions-item id="…">`.
 * Fallback: short-circuit to the deterministic `STABLE_EXTENSION_ID` derived from
 * the manifest `key` field (see `chrome-extension/manifest.ts`); bypasses the
 * scrape entirely so tests stay resilient to chrome://extensions DOM shifts.
 *
 * @param browser
 * @returns path to the Chrome extension (e.g. `chrome-extension://…`)
 */
export const getChromeExtensionPath = async (browser: WebdriverIO.Browser) => {
  await browser.url('chrome://extensions/');

  /**
   * WDIO shadow-root piercing for `extensions-item` was unreliable on Chrome
   * 130+ (see upstream webdriverio#13521 + boilerplate#786). The current
   * selector chain — `extensions-manager` → `viewManager` → `extensions-item-list`
   * → `extensions-item` — worked briefly in late 2024 then regressed again
   * under Chrome 150 / WDIO v9.19. Since the manifest now exposes a stable
   * `key` we no longer need the scrape for correctness; it's still attempted
   * first so the harness stays key-agnostic and proves the extension really
   * did load. If the scrape times out, fall back to the known ID.
   */
  let scrapedId: string | null = null;
  try {
    const extensionItem = await (async () => {
      const extensionsManager = await $('extensions-manager').getElement();
      const itemList = await extensionsManager.shadow$('#container > #viewManager > extensions-item-list');
      return itemList.shadow$('extensions-item');
    })();

    scrapedId = await extensionItem.getAttribute('id');
  } catch {
    // Expected on Chrome 150+ where the shadow-DOM pierce fails; fall through to the
    // stable derived ID below. The extension is still loaded (via --load-extension +
    // a deterministic manifest `key`), so chrome-extension://<stable-id>/... resolves.
    scrapedId = null;
  }

  const extensionId = scrapedId || STABLE_EXTENSION_ID;

  if (!extensionId) {
    throw new Error('Extension ID not found');
  }

  return `chrome-extension://${extensionId}`;
};

/**
 * Returns the Firefox extension path.
 * @param browser
 * @returns path to the Firefox extension
 */
export const getFirefoxExtensionPath = async (browser: WebdriverIO.Browser) => {
  await browser.url('about:debugging#/runtime/this-firefox');
  const uuidElement = await browser.$('//dt[contains(text(), "Internal UUID")]/following-sibling::dd').getElement();
  const internalUUID = await uuidElement.getText();

  if (!internalUUID) {
    throw new Error('Internal UUID not found');
  }

  return `moz-extension://${internalUUID}`;
};
