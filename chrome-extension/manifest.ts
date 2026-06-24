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
} satisfies ManifestType;

export default manifest;
