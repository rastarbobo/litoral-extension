import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export const getContentScriptEntries = (matchesDir: string) => {
  const entryPoints: Record<string, string> = {};
  const entries = readdirSync(matchesDir);

  entries.forEach((folder: string) => {
    const filePath = resolve(matchesDir, folder);

    // `matches/` may contain non-entry content — README files, co-located test
    // directories (e.g. `__tests__/`), or future support dirs. Skip any entry
    // that isn't a directory; otherwise `readdirSync` below throws ENOTDIR on
    // files like README.md. Only directories carrying index.ts/tsx are real
    // content-script matches; the rest are intentionally ignored.
    if (!statSync(filePath).isDirectory()) {
      return;
    }

    const siblings = readdirSync(filePath);
    const haveIndexTsFile = siblings.includes('index.ts');
    const haveIndexTsxFile = siblings.includes('index.tsx');

    if (!(haveIndexTsFile || haveIndexTsxFile)) {
      // A sub-directory with no entry point (e.g. test fixtures) isn't a
      // content-script match — skip it rather than failing the whole build.
      return;
    }
    entryPoints[folder] = resolve(filePath, haveIndexTsFile ? 'index.ts' : 'index.tsx');
  });

  return entryPoints;
};
