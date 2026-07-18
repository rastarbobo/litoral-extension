import { resolve, dirname, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { zipBundle } from './lib/index.js';
import { IS_FIREFOX } from '@extension/env';

// Walk up from this file to find the repo root (the dir containing
// pnpm-workspace.yaml). Necessary because `pnpm -F zipper zip` invokes this
// script from packages/zipper/, so process.cwd() is NOT the repo root.
function findRepoRoot(start: string): string {
  let dir = start;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  return start;
}

// Version-derived filename keeps artifacts deterministic across re-runs of the
// same commit (timestamp-based names broke GitHub-Release attachment idempotency)
// and matches the vX.Y.Z GitHub-Release tag produced by release.yml.
let fileName: string;
try {
  const root = findRepoRoot(import.meta.dirname);
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  fileName = `extension-v${version}`;
} catch {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  process.stderr.write(`[zipper] fell back to timestamp filename: ${ts}\n`);
  fileName = `extension-${ts}`;
}

await zipBundle({
  distDirectory: resolve(import.meta.dirname, '..', '..', '..', 'dist'),
  buildDirectory: resolve(import.meta.dirname, '..', '..', '..', 'dist-zip'),
  archiveName: IS_FIREFOX ? `${fileName}.xpi` : `${fileName}.zip`,
});
