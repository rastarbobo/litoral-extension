/**
 * Stable, deterministic extension ID for the Litoral Agency Publisher.
 *
 * Derived from the public key persisted in `chrome-extension/manifest.ts`'s
 * `key` field — Chrome maps the SHA-256 of that key to this exact 32-char ID.
 * Because the ID is no longer randomized per session, neither E2E specs nor
 * the harness needs to scrape `chrome://extensions/` to discover it; the
 * scrape-based discovery in `extension-path.ts` is still attempted first so
 * the harness stays key-agnostic, but the stable ID is the fallback when the
 * scraper hits Chrome-version regressions on the extensions-page DOM.
 *
 * If you regenerate the manifest `key`, recompute the ID and update both this
 * file and the comment in `manifest.ts` together — they MUST stay in sync.
 */
export const STABLE_EXTENSION_ID = 'ajmoginkbgagpiap';
