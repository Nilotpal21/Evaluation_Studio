import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('Pipeline routes manifest', () => {
  it('does not re-register manual trigger endpoints owned by pipeline-triggers', async () => {
    const sourcePath = fileURLToPath(new URL('../pipelines.ts', import.meta.url));
    const source = await readFile(sourcePath, 'utf8');

    expect(source).not.toContain('/trigger-pipeline');
  });
});
