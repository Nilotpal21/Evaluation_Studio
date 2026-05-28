import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { ESLint } from 'eslint';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const STUDIO_ROOT = path.resolve(THIS_DIR, '..', '..');

async function lintFile(target: string) {
  const eslint = new ESLint({
    cwd: STUDIO_ROOT,
    overrideConfigFile: path.join(STUDIO_ROOT, 'eslint.config.mjs'),
  });

  const [result] = await eslint.lintFiles([target]);
  return result;
}

describe('studio tenant-scoped mongoose lint rule', () => {
  test('flags tenant-scoped queries that omit tenantId', async () => {
    const result = await lintFile('eslint-rules/fixtures/no-unscoped-mongoose-query.unsafe.ts');

    expect(result.errorCount).toBe(5);
    expect(result.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: 'studio-tenant/no-unscoped-mongoose-query',
        }),
      ]),
    );
  });

  test('allows tenant-scoped queries with explicit tenantId', async () => {
    const result = await lintFile('eslint-rules/fixtures/no-unscoped-mongoose-query.safe.ts');

    expect(result.errorCount).toBe(0);
  });

  test('allows approved project-join patterns for project-scoped models', async () => {
    const result = await lintFile(
      'eslint-rules/fixtures/no-unscoped-mongoose-query.project-join.ts',
    );

    expect(result.errorCount).toBe(0);
  });
});
