import { config as baseConfig } from './wdio.conf.js';
import { getChromeExtensionPath, getFirefoxExtensionPath } from '../utils/extension-path.js';
import { IS_CI, IS_FIREFOX } from '@extension/env';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

import { STABLE_EXTENSION_ID } from '../utils/extension-id.js';

export { STABLE_EXTENSION_ID };

/**
 * Absolute path to the built extension root (the directory that contains the
 * Vite-emitted `manifest.json` + all page bundles + background.js). This is the
 * directory `chrome-extension/vite.config.mts` writes into (`outDir = ../../dist`)
 * and what `--load-extension=<path>` expects as its argument.
 *
 * Resolved from `tests/e2e/config/` upward: tests/e2e/config → tests/e2e → tests → <root>/dist.
 */
const DIST_DIR = resolve(import.meta.dirname, '../../../dist');
const MANIFEST_PATH = join(DIST_DIR, 'manifest.json');

if (!existsSync(MANIFEST_PATH)) {
  throw new Error(
    `[wdio.browser.conf] ${MANIFEST_PATH} is missing — run \`pnpm build\` (or \`pnpm zip\`) before \`pnpm e2e\`. ` +
    `Chrome's --load-extension flag needs a built manifest directory; it cannot load a non-existent extension.`,
  );
}

/**
 * Firefox keeps the bundled-base64 mechanism: `installAddOn` in `before` requires
 * the .xpi bytes, so we still read the latest dist-zip artifact here. Chrome no
 * longer uses bundled base64 — see WHY note in chromeCapabilities below.
 */
const extName = IS_FIREFOX ? '.xpi' : '.zip';
const extensions = await readdir(join(import.meta.dirname, '../../../dist-zip'));
const latestExtension = extensions.filter(file => extname(file) === extName).at(-1);
if (!latestExtension) {
  throw new Error(
    `[wdio.browser.conf] No ${extName} file found under dist-zip/ — run \`pnpm zip${IS_FIREFOX ? ':firefox' : ''}\` first.`,
  );
}
const extPath = join(import.meta.dirname, `../../../dist-zip/${latestExtension}`);
const bundledExtension = (await readFile(extPath)).toString('base64');

/**
 * WHY --load-extension instead of `goog:chromeOptions.extensions: [base64]`:
 *
 * Since Chrome ~138 the bundled-base64 install path silently fails to register
 * the unpacked MV3 extension in WDIO v9 / puppeteer-CDP sessions on both local
 * Windows (Chrome 150) and `ubuntu-latest` CI — `chrome://extensions/` shows the
 * empty `#no-items` state, and the scraper in `tests/e2e/utils/extension-path.ts`
 * throws `Can't call getAttribute on element with selector "extensions-item"`.
 * Upstream boilerplate's own issue #786 covers the same symptom.
 *
 * `--load-extension=<dir>` is the documented unpacked-load mechanism. It requires:
 *  - The directory to contain a valid `manifest.json` (verified above).
 *  - `--headless=new` (Chrome 138+ dropped `--headless` legacy support that
 *    honored `--load-extension`; the new headless mode treats the browser like a
 *    real window and therefore still loads unpacked extensions).
 *  - A persistent `--user-data-dir` (Chrome refuses to install extensions into
 *    the throwaway temp profile WDIO/puppeteer uses by default).
 *  - The companion manifest to carry a `key` field so the extension ID is
 *    deterministic across sessions (otherwise Chrome mints a per-load ID and
 *    every spec has to scrape `chrome://extensions/` to discover it).
 *
 * See ROADMAP.md Q7 for the full diagnostic trail that led here.
 */
/**
 * Resolve the Chrome binary path to hand to puppeteer/WDIO. Without this,
 * WDIO/puppeteer tends to pick `chrome-headless-shell` (a separate, older,
 * MV3-hostile build) for `--headless=new` while falling back to system Chrome
 * for headed runs — producing inexplicable headless-only failures (e.g.
 * `chrome-extension://…` pages are served but their `<title>` reads as the
 * URL itself, because chrome-headless-shell doesn't fully render the page).
 *
 * Precedence: explicit env override (CHROME_BIN / CHB_CHROME_BIN) > a hardcoded
 * Windows Program Files path > the conventional Linux CI path
 * (`/usr/bin/google-chrome`). Returns `undefined` when nothing resolves.
 */
function resolveChromeBinary(): string | undefined {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  if (process.env.CHB_CHROME_BIN) return process.env.CHB_CHROME_BIN;
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const CHROME_BINARY = resolveChromeBinary();

const chromeCapabilities = {
  browserName: 'chrome',
  acceptInsecureCerts: true,
  'goog:chromeOptions': {
    args: [
      '--disable-web-security',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // Unpacked MV3 extension load — path MUST be absolute on Windows.
      `--load-extension=${DIST_DIR}`,
      // Persistent profile dir so Chrome accepts the unpacked extension.
      `--user-data-dir=${join(DIST_DIR, '..', '.wdio-chrome-profile')}`,
      // Suppress the per-ColdStart setup that races when multiple WDIO workers
      // reuse the same profile dir — known to throw `session not created: failed
      // to write first run file` on Windows / parallel-cap runs.
      '--no-first-run',
      '--no-default-browser-check',
      // Chrome 138+ dropped `--headless` legacy mode's honors for --load-extension;
      // `--headless=new` keeps full chrome behavior, including unpacked ext load.
      ...(IS_CI ? ['--headless=new'] : []),
      // Safety net for any future Chrome build that gates --load-extension behind
      // the DisableLoadExtensionCommandLineSwitch feature (announced then unlanded
      // through 2024-2025). Harmless when the flag is already enabled.
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
    ],
    prefs: { 'extensions.ui.developer_mode': true },
    // Pin the Chrome binary so headed and headless modes use the same chrome
    // build — see resolveChromeBinary() above. `undefined` lets WDIO fall back
    // to its own discovery when no candidate is found.
    ...(CHROME_BINARY ? { binary: CHROME_BINARY } : {}),
    // NOTE: `extensions: [base64]` intentionally absent for Chrome. The bundled
    // base64 mechanism has been broken since Chrome ~138 in WDIO v9 sessions.
  },
};

const firefoxCapabilities = {
  browserName: 'firefox',
  acceptInsecureCerts: true,
  'moz:firefoxOptions': {
    args: [...(IS_CI ? ['--headless'] : [])],
  },
};

export const config: WebdriverIO.Config = {
  ...baseConfig,
  capabilities: IS_FIREFOX ? [firefoxCapabilities] : [chromeCapabilities],

  maxInstances: IS_CI ? 10 : 1,
  logLevel: 'error',
  execArgv: IS_CI ? [] : ['--inspect'],
  before: async ({ browserName }: WebdriverIO.Capabilities, _specs, browser: WebdriverIO.Browser) => {
    if (browserName === 'firefox') {
      await browser.installAddOn(bundledExtension, true);

      browser.addCommand('getExtensionPath', async () => getFirefoxExtensionPath(browser));
    } else if (browserName === 'chrome') {
      browser.addCommand('getExtensionPath', async () => getChromeExtensionPath(browser));
    }
  },
  afterTest: async () => {
    if (!IS_CI) {
      await browser.pause(500);
    }
  },
};
