import { readFileSync } from 'node:fs';
import type { ManifestType } from '@extension/shared';

const packageJson = JSON.parse(readFileSync('./package.json', 'utf8'));

/**
 * Litoral Agency Publisher — Chrome Extension Manifest
 *
 * Architecture decisions:
 * - No domain allowlist in host_permissions — social platform support is dynamic
 * - Uses Alarms API for background polling (not setInterval)
 * - Thin client: polls API, stores payloads, executes UI interactions only
 */
const manifest = {
  manifest_version: 3,
  default_locale: 'en',
  name: 'Litoral Agency Publisher',
  version: packageJson.version,
  description: 'Publishes approved campaigns to social platforms from your own browser',
  host_permissions: [],
  permissions: ['alarms', 'storage', 'notifications', 'activeTab', 'scripting'],
  background: {
    service_worker: 'background.js',
    type: 'module',
  },
  action: {
    default_popup: 'popup/index.html',
    default_icon: 'icon-34.png',
  },
  icons: {
    '128': 'icon-128.png',
  },
  // Stable public key so the extension ID is deterministic regardless of where
  // the extension is loaded from (unpacked dev load, --load-extension E2E, base64
  // install via `goog:chromeOptions.extensions`, or the Chrome Web Store when
  // promoted there). Without this Chrome mints a fresh ID every session, which
  // breaks the chrome://extensions scrapers used by WDIO and forces every spec
  // to dynamically look up its own chrome-extension:// URL.
  // Derived ID: ajmoginkbgagpiap  -> chrome-extension://ajmoginkbgagpiap/...
  key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtVl1RBAv3R5Gdr9O1Hw3C1nxNkUXw6ozR4tfVwXn1ZzboOk9UCbmdUaU6nMCET57wQXo7HlvysepcTsLKq0GG9c/RskV6V2/D5qYtoUOpyfZoKKoioT4qrq6MurugJdWKkBCksZCaXEtyxi2LdXCtXoXb6KitlfMFwebh+kgjJysneiQq8K5nOZulkjkJ5XJ1iawC7QmeVaSyVnQOeBMYNZnp9t575UqFbsqwg1ZfK49K1hAUibmdoDXPcmfoAnvsgdr8g6O8LwkMnQFAaJYW05oUcrUEWwssW4dqeqFuHzrhWdQy8cOJhA4omuuBXj61BnFCRV1BCPQ66Hs4GtrGwIDAQAB',
} satisfies ManifestType;

export default manifest;
