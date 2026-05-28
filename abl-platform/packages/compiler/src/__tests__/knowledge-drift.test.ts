import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CURRENT_FILE = fileURLToPath(import.meta.url);
const CURRENT_DIR = dirname(CURRENT_FILE);
const REPO_ROOT = join(CURRENT_DIR, '..', '..', '..', '..');
const CATALOG_PATH = join(
  CURRENT_DIR,
  '..',
  'platform',
  'contracts',
  'knowledge',
  'catalog.generated.ts',
);

function stripGeneratedAt(value: string): string {
  return value
    .replace(/"generatedAt": "[^"]+"/, '"generatedAt": "<stripped>"')
    .replace(/generatedAt: '[^']+'/, "generatedAt: '<stripped>'");
}

describe('Knowledge Spine drift gate', () => {
  it('committed catalog matches a fresh generator run', () => {
    const committedCatalog = readFileSync(CATALOG_PATH, 'utf8');
    const tempDir = mkdtempSync(join(tmpdir(), 'abl-knowledge-catalog-'));
    const generatedCatalogPath = join(tempDir, 'catalog.generated.ts');

    try {
      execFileSync('pnpm', ['--filter', '@abl/compiler', 'build:knowledge'], {
        cwd: REPO_ROOT,
        stdio: 'pipe',
        env: {
          ...process.env,
          KNOWLEDGE_CATALOG_OUTPUT_PATH: generatedCatalogPath,
        },
      });

      const generatedCatalog = readFileSync(generatedCatalogPath, 'utf8');
      expect(stripGeneratedAt(generatedCatalog)).toBe(stripGeneratedAt(committedCatalog));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('per-context CEL allowlist covers every compiler builtin field variable', async () => {
    const { unionAllContexts } =
      await import('../platform/contracts/knowledge/per-context-cel-allowlist.js');
    const { BUILTIN_FIELD_REFERENCE_VARS } =
      await import('../platform/contracts/contract-source-data.js');

    const union = unionAllContexts();
    for (const variable of BUILTIN_FIELD_REFERENCE_VARS) {
      expect(union.has(variable), `Missing CEL variable in allowlist: ${variable}`).toBe(true);
    }
  });
});
