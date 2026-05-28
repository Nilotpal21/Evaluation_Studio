import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

interface RootTsConfig {
  compilerOptions?: {
    paths?: Record<string, string[]>;
  };
}

describe('root tsconfig contract', () => {
  it('does not shadow Next runtime modules with repo-wide path aliases', async () => {
    const tsconfigPath = new URL('../../../../tsconfig.json', import.meta.url);
    const tsconfig = JSON.parse(await readFile(tsconfigPath, 'utf8')) as RootTsConfig;

    expect(tsconfig.compilerOptions?.paths?.['next/server']).toBeUndefined();
    expect(tsconfig.compilerOptions?.paths?.['next/headers']).toBeUndefined();
  });
});
