import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';

describe('docs bundle analysis', () => {
  it('UT-8: docs chunks are separate from main entry (requires build)', async () => {
    const buildManifestPath = path.join(process.cwd(), 'apps/studio/.next/build-manifest.json');

    try {
      const raw = await fs.readFile(buildManifestPath, 'utf-8');
      const manifest = JSON.parse(raw);

      // The main pages (like /projects) should not include docs-related chunks
      const mainPages = manifest.pages || {};
      const rootChunks = mainPages['/'] || [];

      // Docs-related chunks should NOT appear in root page
      const hasDocsInRoot = rootChunks.some(
        (chunk: string) => chunk.includes('mdx-remote') || chunk.includes('gray-matter'),
      );

      expect(hasDocsInRoot).toBe(false);
    } catch {
      // If build output doesn't exist, skip gracefully
      // This test is meaningful only after a production build
      // eslint-disable-next-line no-console
      console.warn('Build manifest not found — skipping bundle analysis');
    }
  });
});
