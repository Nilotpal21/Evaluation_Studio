import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildRepoIndex,
  listScopedSourceFiles,
  loadScopedRepoIndex,
} from '../pipeline/repo-index.js';

describe('repo-index', () => {
  let workDir: string | null = null;

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
      workDir = null;
    }
  });

  it('lists scoped source files for both directory and file scopes', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'helix-repo-index-'));
    await mkdir(join(workDir, 'src', 'nested'), { recursive: true });
    await writeFile(join(workDir, 'src', 'main.ts'), 'export const main = true;\n', 'utf-8');
    await writeFile(
      join(workDir, 'src', 'nested', 'helper.tsx'),
      'export const helper = true;\n',
      'utf-8',
    );
    await writeFile(join(workDir, 'README.md'), '# not source\n', 'utf-8');

    await expect(listScopedSourceFiles(workDir, ['src'])).resolves.toEqual([
      'src/main.ts',
      'src/nested/helper.tsx',
    ]);
    await expect(listScopedSourceFiles(workDir, ['src/main.ts'])).resolves.toEqual(['src/main.ts']);
  });

  it('resolves transpiled ESM imports back to source files in the repo index', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'helix-repo-index-'));
    await mkdir(join(workDir, 'src', 'helper'), { recursive: true });
    await writeFile(
      join(workDir, 'src', 'service.ts'),
      "export const fetchData = () => 'ok';\n",
      'utf-8',
    );
    await writeFile(
      join(workDir, 'src', 'consumer.ts'),
      "import { fetchData } from './service.js';\nexport const read = () => fetchData();\n",
      'utf-8',
    );
    await writeFile(
      join(workDir, 'src', 'helper', 'index.ts'),
      'export const helper = () => true;\n',
      'utf-8',
    );
    await writeFile(
      join(workDir, 'src', 'consumer-index.ts'),
      "import { helper } from './helper/index.js';\nexport const useHelper = () => helper();\n",
      'utf-8',
    );
    await writeFile(
      join(workDir, 'src', 'service.test.ts'),
      "import { fetchData } from './service.js';\nexport const verify = () => fetchData();\n",
      'utf-8',
    );

    const repoFiles = await listScopedSourceFiles(workDir, ['src']);
    const repoIndex = await buildRepoIndex(workDir, repoFiles);

    expect(repoIndex.importersByTarget.get('src/service.ts')).toEqual(
      new Set(['src/consumer.ts', 'src/service.test.ts']),
    );
    expect(repoIndex.importersByTarget.get('src/helper/index.ts')).toEqual(
      new Set(['src/consumer-index.ts']),
    );
    expect(repoIndex.exportsByFile.get('src/service.ts')).toEqual(['fetchData']);
    expect(repoIndex.testFiles).toEqual(new Set(['src/service.test.ts']));
  });

  it('extracts exports and import targets from AST-based analysis', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'helix-repo-index-'));
    await mkdir(join(workDir, 'src'), { recursive: true });
    await writeFile(
      join(workDir, 'src', 'service.ts'),
      [
        "export { helper as renamed } from './helper';",
        'export interface Shape { x: number }',
        "export type Mode = 'strict' | 'loose';",
        'export enum Status { Ready }',
        'export default class Service {}',
        "const req = require('./dep');",
        "const dyn = import('./dynamic');",
      ].join('\n'),
      'utf-8',
    );
    await writeFile(join(workDir, 'src', 'helper.ts'), 'export const helper = true;\n', 'utf-8');
    await writeFile(join(workDir, 'src', 'dep.ts'), 'export const dep = true;\n', 'utf-8');
    await writeFile(join(workDir, 'src', 'dynamic.ts'), 'export const dynamic = true;\n', 'utf-8');

    const repoFiles = await listScopedSourceFiles(workDir, ['src']);
    const repoIndex = await buildRepoIndex(workDir, repoFiles);

    expect(repoIndex.exportsByFile.get('src/service.ts')).toEqual([
      'default',
      'Mode',
      'renamed',
      'Shape',
      'Status',
    ]);
    expect(repoIndex.importersByTarget.get('src/helper.ts')).toEqual(new Set(['src/service.ts']));
    expect(repoIndex.importersByTarget.get('src/dep.ts')).toEqual(new Set(['src/service.ts']));
    expect(repoIndex.importersByTarget.get('src/dynamic.ts')).toEqual(new Set(['src/service.ts']));
    expect(repoIndex.filesByPath.get('src/service.ts')?.lineCount).toBe(7);
  });

  it('reuses cached scoped repo indexes until the scope diff hash changes', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'helix-repo-index-'));
    await mkdir(join(workDir, 'src'), { recursive: true });
    const servicePath = join(workDir, 'src', 'service.ts');
    await writeFile(servicePath, 'export const versionOne = true;\n', 'utf-8');

    const firstLoad = await loadScopedRepoIndex(workDir, ['src']);
    expect(firstLoad.repoIndex.cacheStatus).toBe('miss');
    expect(firstLoad.repoIndex.loadDurationMs).toEqual(expect.any(Number));
    expect(firstLoad.repoIndex.loadDurationMs).toBeGreaterThanOrEqual(0);
    expect(firstLoad.repoIndex.exportsByFile.get('src/service.ts')).toEqual(['versionOne']);

    const secondLoad = await loadScopedRepoIndex(workDir, ['src']);
    expect(secondLoad.repoIndex.cacheStatus).toBe('hit');
    expect(secondLoad.repoIndex.loadDurationMs).toEqual(expect.any(Number));
    expect(secondLoad.repoIndex.loadDurationMs).toBeGreaterThanOrEqual(0);
    expect(secondLoad.repoIndex.diffHash).toBe(firstLoad.repoIndex.diffHash);

    await writeFile(servicePath, 'export const versionTwo = true;\n', 'utf-8');
    const nextTimestamp = new Date(Date.now() + 1500);
    await utimes(servicePath, nextTimestamp, nextTimestamp);

    const thirdLoad = await loadScopedRepoIndex(workDir, ['src']);
    expect(thirdLoad.repoIndex.cacheStatus).toBe('miss');
    expect(thirdLoad.repoIndex.loadDurationMs).toEqual(expect.any(Number));
    expect(thirdLoad.repoIndex.loadDurationMs).toBeGreaterThanOrEqual(0);
    expect(thirdLoad.repoIndex.diffHash).not.toBe(firstLoad.repoIndex.diffHash);
    expect(thirdLoad.repoIndex.exportsByFile.get('src/service.ts')).toEqual(['versionTwo']);
  });
});
