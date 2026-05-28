import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildSliceContextPacket } from '../pipeline/slice-context-packet.js';
import type { Session, Slice } from '../types.js';

describe('slice-context-packet', () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('preloads direct files, required tests, dependent excerpts, and relevant package instructions', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-slice-context-'));

    await mkdir(join(tempDir, 'packages/helix/src'), { recursive: true });
    await writeFile(
      join(tempDir, 'packages/helix/src/shared.ts'),
      [
        'export function makeValue(input: string): string {',
        '  return input.toUpperCase();',
        '}',
      ].join('\n'),
      'utf-8',
    );
    await writeFile(
      join(tempDir, 'packages/helix/src/auth.schema.ts'),
      [
        "import { z } from 'zod';",
        '',
        'export const AuthConfigSchema = z.object({',
        '  password: z.string(),',
        "  strategy: z.enum(['local', 'sso']).default('local'),",
        '  retries: z.number().default(3),',
        '});',
      ].join('\n'),
      'utf-8',
    );
    await writeFile(
      join(tempDir, 'packages/helix/src/direct.ts'),
      [
        "import { makeValue } from './shared';",
        "import { AuthConfigSchema } from './auth.schema';",
        '',
        'export function useThing(): string {',
        '  void AuthConfigSchema;',
        "  return makeValue('ok');",
        '}',
      ].join('\n'),
      'utf-8',
    );
    await writeFile(
      join(tempDir, 'packages/helix/src/direct.test.ts'),
      [
        "import { describe, expect, it } from 'vitest';",
        "import { useThing } from './direct';",
        '',
        "it('uses the direct seam', () => {",
        "  expect(useThing()).toBe('ok');",
        '});',
      ].join('\n'),
      'utf-8',
    );
    await writeFile(
      join(tempDir, 'packages/helix/src/dependent.ts'),
      [
        "import { useThing } from './direct';",
        '',
        'export function consumeThing(): string {',
        '  return useThing();',
        '}',
      ].join('\n'),
      'utf-8',
    );

    const slice = createSlice();
    const session = createSession(slice);
    const packet = await buildSliceContextPacket(tempDir, session, slice);

    expect(packet).toContain('## SLICE CONTEXT PACKET');
    expect(packet).toContain('### Work Item Design Inputs');
    expect(packet).toContain('### Test Spec');
    expect(packet).toContain('### LLD');
    expect(packet).toContain('### Invariant, Coverage, and Acceptance Obligations');
    expect(packet).toContain(
      'For every changed invariant or contract, prove at least one happy-path and one negative-path regression.',
    );
    expect(packet).toContain('Historical replay seam obligations');
    expect(packet).toContain('### Relevant Package Instructions');
    expect(packet).toContain('packages/helix/AGENTS.md');
    expect(packet).toContain('### Direct Files (full source)');
    expect(packet).toContain('packages/helix/src/direct.ts');
    expect(packet).toContain('export function useThing(): string');
    expect(packet).toContain('### Verification Commands');
    expect(packet).toContain(
      'Treat these commands as the authoritative minimal proof set for this slice.',
    );
    expect(packet).toContain('Once these commands are green, stop and hand control back to HELIX');
    expect(packet).toContain('pnpm --filter ./packages/helix exec tsc --noEmit');
    expect(packet).toContain('npx prettier --check');
    expect(packet).toContain('pnpm --filter ./packages/helix test -- "src/direct.test.ts"');
    expect(packet).toContain('### Relevant Schemas and Validation Contracts');
    expect(packet).toContain('packages/helix/src/auth.schema.ts :: AuthConfigSchema');
    expect(packet).toContain('- Kind: zod-object');
    expect(packet).toContain('- password: string (required)');
    expect(packet).toContain(
      '- strategy: "local" | "sso" (optional; default "local"; enum local, sso)',
    );
    expect(packet).toContain('### Required Tests (full source)');
    expect(packet).toContain("expect(useThing()).toBe('ok');");
    expect(packet).toContain('### Dependent Excerpts');
    expect(packet).toContain("1: import { useThing } from './direct';");
    expect(packet).toContain('### Imported Signatures');
    expect(packet).toContain('packages/helix/src/shared.ts');
    expect(packet).toContain('- makeValue: function makeValue(input: string): string');
  });
});

function createSession(slice: Slice): Session {
  return {
    id: 'session-slice-context',
    workItem: {
      id: 'work-item-1',
      type: 'feature-audit',
      title: 'Slice Context Packet',
      description: 'Test slice context packet preloading',
      scope: ['packages/helix/src'],
      targetBranch: 'develop',
      createdAt: '2026-04-10T00:00:00.000Z',
    },
    pipelineName: 'test',
    pipelineVersion: '1',
    promptContext: {
      builtAt: '2026-04-10T00:00:00.000Z',
      instructionDocs: [
        {
          path: 'packages/helix/AGENTS.md',
          title: 'packages/helix/AGENTS.md',
          excerpt: 'Use the shared direct seam instead of reimplementing the helper contract.',
        },
      ],
      codeMap: {
        scope: ['packages/helix/src'],
        totalSourceFiles: 4,
        totalTestFiles: 1,
        keyFiles: [],
      },
      featureSpecDoc: {
        path: 'docs/features/direct-seam.md',
        title: 'Feature Spec',
        excerpt: 'Support direct seam stabilization.',
      },
      testSpecDoc: {
        path: 'docs/testing/direct-seam.md',
        title: 'Test Spec',
        excerpt: 'Cover both positive and negative seam validation paths.',
      },
      lldPlanDoc: {
        path: 'docs/plans/direct-seam.md',
        title: 'LLD',
        excerpt: 'Preserve the direct seam and dependent imports while fixing invariants.',
      },
    },
    replayContext: {
      changedFiles: ['packages/database/src/models/project-member.model.ts'],
      tags: ['rbac'],
    },
    state: 'executing',
    currentStageIndex: 0,
    currentSliceIndex: 0,
    totalSlices: 1,
    slices: [slice],
    findings: [
      {
        id: 'finding-direct',
        title: 'Use direct seam',
        description: 'Use the direct seam consistently.',
        severity: 'medium',
        category: 'bug',
        files: ['packages/helix/src/direct.ts'],
        status: 'open',
      },
    ],
    decisions: [],
    commits: [],
    journal: [],
    stageHistory: [],
    startedAt: '2026-04-10T00:00:00.000Z',
    updatedAt: '2026-04-10T00:00:00.000Z',
  };
}

function createSlice(): Slice {
  return {
    index: 0,
    title: 'Preload direct seam',
    description: 'Use the direct seam with the required test and dependent context.',
    status: 'pending',
    findings: ['finding-direct'],
    dependencies: [],
    manifest: {
      entryConditions: [],
      fileContracts: [
        {
          path: 'packages/helix/src/direct.ts',
          action: 'modify',
          reason: 'Stabilize the direct seam',
          expectedExports: ['useThing'],
          dependents: ['packages/helix/src/dependent.ts'],
        },
      ],
      exportContracts: [
        {
          sourceFile: 'packages/helix/src/direct.ts',
          exportName: 'useThing',
          consumers: ['packages/helix/src/dependent.ts'],
          isNew: false,
        },
      ],
    },
    testLock: {
      requiredTests: [
        {
          testFile: 'packages/helix/src/direct.test.ts',
          description: 'Direct seam regression',
          status: 'passing',
          coversFindings: ['finding-direct'],
          isNew: false,
        },
      ],
      regressionSuite: [],
      locked: false,
    },
    impactAnalysis: {
      directFiles: ['packages/helix/src/direct.ts'],
      dependentFiles: ['packages/helix/src/dependent.ts'],
      affectedTests: ['packages/helix/src/direct.test.ts'],
      riskLevel: 'medium',
      notes: 'Dependent file still imports the direct seam.',
    },
    legacyPaths: [],
    exitCriteria: [],
  };
}
