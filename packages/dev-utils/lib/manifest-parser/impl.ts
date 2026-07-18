import type { IManifestParser } from './types.js';
import type { ManifestType } from '@extension/shared';

const DEFAULT_FIREFOX_GECKO_ID = 'litoral-publisher@litoral.agency';
const FIREFOX_STRICT_MIN_VERSION = '109.0';

const convertToFirefoxCompatibleManifest = (manifest: ManifestType) => {
  const manifestCopy = {
    ...manifest,
  } as { [key: string]: unknown };

  if (manifest.background?.service_worker) {
    manifestCopy.background = {
      scripts: [manifest.background.service_worker],
      type: 'module',
    };
  }
  if (manifest.options_page) {
    manifestCopy.options_ui = {
      page: manifest.options_page,
      browser_style: false,
    };
  }
  manifestCopy.content_security_policy = {
    extension_pages: "script-src 'self'; object-src 'self'",
  };
  manifestCopy.permissions = (manifestCopy.permissions as string[]).filter(value => value !== 'sidePanel');

  // Firefox WebExtension-specific settings. `browser_specific_settings.gecko.id`
  // is REQUIRED by AMO at sign time — it's Mozilla's analog of Chrome's stable
  // `key:` field (a deterministic add-on UUID). The id follows Mozilla's
  // email-style convention (`<extension-name>@<domain>`); override via
  // `FIREFOX_GECKO_ID` env var if AMO has already issued a different UUID for
  // an existing listing. `strict_min_version` is set to "109.0" because that's
  // the first Firefox release where MV3 WebExtensions became generally
  // available (matches the `background.scripts` shape the transformation above
  // already produces). See Phase 4.1 follow-up (a) in ROADMAP.md.
  manifestCopy.browser_specific_settings = {
    gecko: {
      id: process.env.FIREFOX_GECKO_ID || DEFAULT_FIREFOX_GECKO_ID,
      strict_min_version: FIREFOX_STRICT_MIN_VERSION,
    },
  };

  delete manifestCopy.options_page;
  delete manifestCopy.side_panel;
  return manifestCopy as ManifestType;
};

export const ManifestParserImpl: IManifestParser = {
  convertManifestToString: (manifest, isFirefox) => {
    if (isFirefox) {
      manifest = convertToFirefoxCompatibleManifest(manifest);
    }

    return JSON.stringify(manifest, null, 2);
  },
};
