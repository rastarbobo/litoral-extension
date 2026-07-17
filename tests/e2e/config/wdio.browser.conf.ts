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
 * directory `chrome-extension/vite.config.mts` writes into (`outDir = ../../dist`).
 * We only need it for the early `manifest.json` existence guard below — the
 * actual extension bytes loaded by Chrome come from the zipped `dist-zip/*.zip`
 * via `goog:chromeOptions.extensions: [base64]` (see chromeCapabilities below).
 *
 * Resolved from `tests/e2e/config/` upward: tests/e2e/config → tests/e2e → tests → <root>/dist.
 */
const DIST_DIR = resolve(import.meta.dirname, '../../../dist');
const MANIFEST_PATH = join(DIST_DIR, 'manifest.json');

if (!existsSync(MANIFEST_PATH)) {
  throw new Error(
    `[wdio.browser.conf] ${MANIFEST_PATH} is missing — run \`pnpm build\` (or \`pnpm zip\`) before \`pnpm e2e\`. ` +
    `The early-fail guard needs a built manifest to confirm the zip step ran.`,
  );
}

/**
 * Firefox keeps the bundled-base64 mechanism: `installAddOn` in `before` requires
 * the .xpi bytes. Chrome now uses the same base64-zip mechanism via
 * `goog:chromeOptions.extensions` — see WHY note in chromeCapabilities below.
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
 * WHY goog:chromeOptions.extensions: [base64] (and why not --load-extension):
 *
 * The base64 install mechanism routes through chromedriver's extension-install
 * path, which writes a fresh per-session user-data-dir. That avoids the
 * shared-profile contention that maxInstances > 1 would otherwise hit, and it
 * works on Chrome 150 headless on Linux CI (the upstream boilerplate's
 * mechanism, unchanged since v0.5.0).
 *
 * `--load-extension=<dir>` + `--headless=new` silently fails to register MV3
 * unpacked extensions on Chrome 150 Linux headless — `chrome://extensions/`
 * shows itemCount=0 and any chrome-extension:// URL returns ERR_BLOCKED_BY_CLIENT.
 * Upstream tracked this as their own open issue #1013 when they archived the repo.
 *
 * We pin `--headless` (legacy) instead of `--headless=new`. The new headless mode
 * dropped several legacy behaviors including reliable extension loading.
 */
const chromeCapabilities = {
  browserName: 'chrome',
  acceptInsecureCerts: true,
  'goog:chromeOptions': {
    extensions: [bundledExtension],
    args: [
      '--disable-web-security',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      ...(IS_CI ? ['--headless'] : []),
    ],
    prefs: { 'extensions.ui.developer_mode': true },
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

  // WHY 1 not 10: defense-in-depth. The chromedriver extension-install path
  // (goog:chromeOptions.extensions base64) uses a fresh user-data-dir per
  // session, so it should tolerate maxInstances>1, but we have a 6-spec suite
  // that finishes in well under a minute regardless, so no reason to risk
  // re-introducing the `invalid session id` regression we previously saw with
  // the shared --user-data-dir mechanism.
  maxInstances: 1,
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
