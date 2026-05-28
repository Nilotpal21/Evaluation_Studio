/**
 * Discover Activepieces Pieces
 *
 * Queries npm registry for all @activepieces/piece-* packages
 * and generates a manifest file. Also outputs a pnpm add command
 * to install all discovered pieces.
 *
 * Usage: pnpm connectors:discover-pieces
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(
  __dirname,
  '..',
  'packages',
  'connectors',
  'src',
  'adapters',
  'activepieces',
  'generated',
);
const OUTPUT_FILE = join(OUTPUT_DIR, 'piece-manifest.json');

interface NpmSearchResult {
  objects: Array<{
    package: {
      name: string;
      version: string;
      description: string;
    };
  }>;
  total: number;
}

interface PieceManifestEntry {
  name: string;
  version: string;
  description: string;
}

async function fetchAllPieces(): Promise<PieceManifestEntry[]> {
  const pieces: PieceManifestEntry[] = [];
  let from = 0;
  const size = 250;
  let hasMore = true;

  while (hasMore) {
    const url = `https://registry.npmjs.org/-/v1/search?text=@activepieces/piece-&size=${size}&from=${from}`;
    console.log(`Fetching from npm registry (offset: ${from})...`);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`npm registry returned ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as NpmSearchResult;

    for (const obj of data.objects) {
      const pkg = obj.package;
      // Only include actual piece packages (not framework, common, etc.)
      if (pkg.name.startsWith('@activepieces/piece-')) {
        pieces.push({
          name: pkg.name,
          version: pkg.version,
          description: pkg.description,
        });
      }
    }

    from += size;
    hasMore = data.objects.length === size && from < data.total;
  }

  return pieces;
}

async function main(): Promise<void> {
  console.log('Discovering Activepieces pieces from npm registry...');

  const pieces = await fetchAllPieces();
  console.log(`Discovered ${pieces.length} pieces`);

  // Sort alphabetically for stable output
  pieces.sort((a, b) => a.name.localeCompare(b.name));

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(OUTPUT_FILE, JSON.stringify(pieces, null, 2) + '\n');
  console.log(`Manifest written to ${OUTPUT_FILE}`);

  // Output install command for convenience
  const pkgNames = pieces.map((p) => p.name).join(' ');
  console.log(`\nTo install all pieces, run:\n  cd packages/connectors && pnpm add ${pkgNames}`);
}

main().catch((err) => {
  console.error(
    'Failed to discover Activepieces pieces:',
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
