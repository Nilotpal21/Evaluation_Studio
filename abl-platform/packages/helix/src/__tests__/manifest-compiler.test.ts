import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { compileSliceArtifacts } from '../pipeline/manifest-compiler.js';
import type { Session, Slice } from '../types.js';

describe('manifest-compiler', () => {
  let workDir: string | null = null;

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
      workDir = null;
    }
  });

  it('enriches slices with entry conditions, export contracts, and impact data', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'helix-manifest-compiler-'));
    await mkdir(join(workDir, 'src'), { recursive: true });
    await writeFile(
      join(workDir, 'src/service.ts'),
      "export const fetchData = () => 'ok';\n",
      'utf-8',
    );
    await writeFile(
      join(workDir, 'src/consumer.ts'),
      "import { fetchData } from './service';\nexport const read = () => fetchData();\n",
      'utf-8',
    );
    await writeFile(
      join(workDir, 'src/service.test.ts'),
      "import { fetchData } from './service';\ndescribe('fetchData', () => { expect(fetchData()).toBe('ok'); });\n",
      'utf-8',
    );
    await writeFile(
      join(workDir, 'src/consumer.test.ts'),
      "import { read } from './consumer';\ndescribe('read', () => { expect(read()).toBe('ok'); });\n",
      'utf-8',
    );

    const session = createSession();
    const compiled = await compileSliceArtifacts(session.slices[0], session, workDir);

    expect(compiled.manifest.entryConditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'slice-committed',
          reference: '0',
        }),
        expect.objectContaining({
          type: 'file-exists',
          reference: 'src/service.ts',
        }),
      ]),
    );
    expect(compiled.manifest.fileContracts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'src/service.ts',
          action: 'modify',
        }),
        expect.objectContaining({
          path: 'src/service.test.ts',
        }),
      ]),
    );
    expect(compiled.manifest.exportContracts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceFile: 'src/service.ts',
          exportName: 'fetchData',
          consumers: expect.arrayContaining(['src/consumer.ts']),
        }),
      ]),
    );
    expect(compiled.testLock.requiredTests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          testFile: 'src/service.test.ts',
          isNew: false,
          status: 'written',
          coversFindings: ['finding-service'],
        }),
      ]),
    );
    expect(compiled.impactAnalysis).toMatchObject({
      dependentFiles: ['src/consumer.ts'],
      affectedTests: expect.arrayContaining(['src/service.test.ts', 'src/consumer.test.ts']),
      riskLevel: 'medium',
    });
    expect(compiled.exitCriteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'workspace-scope-clean',
          type: 'workspace-scope-clean',
        }),
        expect.objectContaining({
          id: 'architecture-reviewed',
          type: 'architecture-reviewed',
        }),
        expect.objectContaining({
          id: 'exports-wired',
          type: 'exports-wired',
        }),
      ]),
    );
    const scopeCleanIndex = compiled.exitCriteria.findIndex(
      (criterion) => criterion.type === 'workspace-scope-clean',
    );
    const archReviewedIndex = compiled.exitCriteria.findIndex(
      (criterion) => criterion.type === 'architecture-reviewed',
    );
    expect(scopeCleanIndex).toBeGreaterThanOrEqual(0);
    expect(archReviewedIndex).toBeGreaterThanOrEqual(0);
    expect(scopeCleanIndex).toBeLessThan(archReviewedIndex);
  });

  it('tracks dependents that import source files through transpiled .js specifiers', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'helix-manifest-compiler-'));
    await mkdir(join(workDir, 'src'), { recursive: true });
    await writeFile(
      join(workDir, 'src/service.ts'),
      "export const fetchData = () => 'ok';\n",
      'utf-8',
    );
    await writeFile(
      join(workDir, 'src/consumer.ts'),
      "import { fetchData } from './service.js';\nexport const read = () => fetchData();\n",
      'utf-8',
    );
    await writeFile(
      join(workDir, 'src/service.test.ts'),
      "import { fetchData } from './service.js';\ndescribe('fetchData', () => { expect(fetchData()).toBe('ok'); });\n",
      'utf-8',
    );

    const session = createSession();
    const compiled = await compileSliceArtifacts(session.slices[0], session, workDir);

    expect(compiled.manifest.fileContracts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'src/service.ts',
          dependents: expect.arrayContaining(['src/consumer.ts']),
        }),
      ]),
    );
    expect(compiled.manifest.exportContracts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceFile: 'src/service.ts',
          consumers: expect.arrayContaining(['src/consumer.ts', 'src/service.test.ts']),
        }),
      ]),
    );
    expect(compiled.impactAnalysis).toMatchObject({
      dependentFiles: ['src/consumer.ts'],
      affectedTests: expect.arrayContaining(['src/service.test.ts']),
    });
  });

  it('surfaces manifest completeness hints for likely consumers, barrels, and unlocked tests', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'helix-manifest-compiler-'));
    await mkdir(join(workDir, 'src'), { recursive: true });
    await writeFile(
      join(workDir, 'src/service.ts'),
      "export const fetchData = () => 'ok';\n",
      'utf-8',
    );
    await writeFile(
      join(workDir, 'src/consumer.ts'),
      "import { fetchData } from './service';\nexport const read = () => fetchData();\n",
      'utf-8',
    );
    await writeFile(
      join(workDir, 'src/index.ts'),
      "export { fetchData } from './service';\n",
      'utf-8',
    );
    await writeFile(
      join(workDir, 'src/service.test.ts'),
      "import { fetchData } from './service';\ndescribe('fetchData', () => { expect(fetchData()).toBe('ok'); });\n",
      'utf-8',
    );

    const session = createSession();
    session.slices[0]!.testLock.requiredTests = [];
    const compiled = await compileSliceArtifacts(session.slices[0], session, workDir);

    expect(compiled.manifest.completeness?.summary).toContain(
      'Manifest completeness preflight flagged',
    );
    expect(compiled.manifest.completeness?.hints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'src/consumer.ts',
          kind: 'consumer',
          suggestedAction: 'review',
        }),
        expect.objectContaining({
          path: 'src/index.ts',
          kind: 'consumer',
          suggestedAction: 'review',
        }),
        expect.objectContaining({
          path: 'src/service.test.ts',
          kind: 'test',
          suggestedAction: 'promote-test',
        }),
      ]),
    );
  });

  it('promotes path-relevant regressions into affected tests and omits unrelated inherited tests', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'helix-manifest-compiler-'));
    await mkdir(join(workDir, 'src/auth'), { recursive: true });
    await mkdir(join(workDir, 'src/channels'), { recursive: true });
    await writeFile(
      join(workDir, 'src/auth/feature.ts'),
      "export const feature = () => 'ok';\n",
      'utf-8',
    );
    await writeFile(
      join(workDir, 'src/auth/consumer.ts'),
      "import { feature } from './feature';\nexport const useFeature = () => feature();\n",
      'utf-8',
    );
    await writeFile(
      join(workDir, 'src/auth/feature.test.ts'),
      "import { feature } from './feature';\ndescribe('feature', () => { expect(feature()).toBe('ok'); });\n",
      'utf-8',
    );
    await writeFile(
      join(workDir, 'src/auth/feature.regression.test.ts'),
      "describe('feature regression', () => { expect(true).toBe(true); });\n",
      'utf-8',
    );
    await writeFile(
      join(workDir, 'src/channels/channel-authz.test.ts'),
      "describe('channel authz regression', () => { expect(true).toBe(true); });\n",
      'utf-8',
    );

    const session = createSession();
    session.slices[0]!.manifest.fileContracts = [
      {
        path: 'src/auth/feature.ts',
        action: 'modify',
        reason: 'Planned auth feature update',
      },
    ];
    session.slices[0]!.impactAnalysis.directFiles = ['src/auth/feature.ts'];
    session.slices[0]!.testLock.requiredTests = [
      {
        testFile: 'src/auth/feature.test.ts',
        description: '',
        status: 'pending',
        coversFindings: [],
        isNew: true,
      },
    ];
    session.slices[0]!.testLock.regressionSuite = [
      'src/auth/feature.regression.test.ts',
      'src/channels/channel-authz.test.ts',
    ];
    session.findings[0]!.files = [{ path: 'src/auth/feature.ts' }];

    const compiled = await compileSliceArtifacts(session.slices[0], session, workDir);

    expect(compiled.testLock.regressionSuite).toEqual(['src/auth/feature.regression.test.ts']);
    expect(compiled.impactAnalysis.affectedTests).toEqual(
      expect.arrayContaining(['src/auth/feature.regression.test.ts']),
    );
    expect(compiled.impactAnalysis.notes).toContain(
      'Omitted 1 low-affinity inherited regression test(s).',
    );
  });

  it('treats deleted tracked tests as delete contracts instead of required test lock entries', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'helix-manifest-compiler-'));
    await mkdir(join(workDir, 'src'), { recursive: true });
    await writeFile(
      join(workDir, 'src/service.ts'),
      "export const fetchData = () => 'ok';\n",
      'utf-8',
    );
    await writeFile(
      join(workDir, 'src/legacy.e2e.test.ts'),
      "describe('legacy e2e', () => { expect(true).toBe(true); });\n",
      'utf-8',
    );

    execFileSync('git', ['init'], { cwd: workDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workDir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: workDir });
    execFileSync('git', ['add', 'src'], { cwd: workDir });
    execFileSync('git', ['commit', '-m', 'seed tracked test'], { cwd: workDir });

    await rm(join(workDir, 'src/legacy.e2e.test.ts'));

    const session = createSession();
    session.slices[0]!.testLock.requiredTests = [
      {
        testFile: 'src/legacy.e2e.test.ts',
        description: 'Legacy gather interrupt E2E',
        status: 'pending',
        coversFindings: ['finding-service'],
        isNew: false,
      },
    ];

    const compiled = await compileSliceArtifacts(session.slices[0], session, workDir);

    expect(compiled.manifest.fileContracts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'src/legacy.e2e.test.ts',
          action: 'delete',
        }),
      ]),
    );
    expect(compiled.testLock.requiredTests).toEqual([]);
  });
});

function createSession(): Session {
  const timestamp = '2026-04-01T00:00:00.000Z';
  const slice: Slice = {
    index: 1,
    title: 'Update service wiring',
    description: 'Compile service manifest',
    status: 'pending',
    findings: ['finding-service'],
    dependencies: [0],
    manifest: {
      entryConditions: [],
      fileContracts: [
        {
          path: 'src/service.ts',
          action: 'modify',
          reason: 'Planned service update',
        },
      ],
      exportContracts: [],
    },
    testLock: {
      requiredTests: [
        {
          testFile: 'src/service.test.ts',
          description: '',
          status: 'pending',
          coversFindings: [],
          isNew: true,
        },
      ],
      regressionSuite: [],
      locked: false,
    },
    impactAnalysis: {
      directFiles: ['src/service.ts'],
      dependentFiles: [],
      affectedTests: [],
      riskLevel: 'medium',
      notes: '',
    },
    legacyPaths: [],
    exitCriteria: [
      {
        id: 'typecheck',
        type: 'typecheck',
        description: 'TypeScript compiles',
        passed: false,
      },
      {
        id: 'lint',
        type: 'lint',
        description: 'Changed files are formatted',
        passed: false,
      },
      {
        id: 'test-lock',
        type: 'test-lock',
        description: 'Required tests pass and lock the slice',
        passed: false,
      },
      {
        id: 'impact-reviewed',
        type: 'impact-reviewed',
        description: 'Impact analysis complete',
        passed: false,
      },
    ],
  };

  return {
    id: 'session-1',
    workItem: {
      id: 'work-1',
      type: 'feature-audit',
      title: 'Manifest compiler',
      description: 'Compile manifest',
      scope: ['src'],
      targetBranch: 'current',
      createdAt: timestamp,
    },
    pipelineName: 'test',
    pipelineVersion: 'test@123456789abc',
    state: 'planning',
    currentStageIndex: 0,
    currentSliceIndex: 0,
    totalSlices: 1,
    slices: [slice],
    findings: [
      {
        id: 'finding-service',
        category: 'bug',
        severity: 'high',
        status: 'planned',
        title: 'Service wiring needs update',
        description: 'Service export needs wiring review',
        files: [{ path: 'src/service.ts' }],
        discoveredBy: 'Deep Scan',
        assignedSlice: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    decisions: [],
    commits: [],
    journal: [],
    stageHistory: [],
    startedAt: timestamp,
    updatedAt: timestamp,
  };
}
