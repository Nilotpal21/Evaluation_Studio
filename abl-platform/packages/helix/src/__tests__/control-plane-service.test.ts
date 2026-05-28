import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { HelixControlPlaneService } from '../mcp/control-plane-service.js';
import type { PipelineTemplate, Session, Slice } from '../types.js';

describe('HelixControlPlaneService', () => {
  let workDir: string | null = null;

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
      workDir = null;
    }
  });

  it('lists HELIX sessions with structured summaries and filters', async () => {
    workDir = await createWorkspaceWithSessions();
    const service = new HelixControlPlaneService({ workDir });

    const allSessions = await service.listSessions();
    const waitingSessions = await service.listSessions({ state: 'awaiting-input' });
    const titleMatches = await service.listSessions({ titleQuery: 'control plane' });

    expect(allSessions).toHaveLength(2);
    expect(allSessions[0]).toMatchObject({
      id: 'session-failed',
      title: 'HELIX control plane MCP foundation',
      state: 'awaiting-input',
      currentStageName: 'Implement',
      currentSliceNumber: 1,
      openFindings: 1,
      unresolvedDecisions: 1,
      harnessDefects: 1,
    });
    expect(waitingSessions).toEqual([
      expect.objectContaining({
        id: 'session-failed',
      }),
    ]);
    expect(titleMatches).toEqual([
      expect.objectContaining({
        id: 'session-failed',
      }),
    ]);
  });

  it('returns slice packets and gate summaries with cached verification context', async () => {
    workDir = await createWorkspaceWithSessions();
    const service = new HelixControlPlaneService({ workDir });

    const slicePacket = await service.getSlicePacket('session-failed', 1);
    const gateResults = await service.listGateResults('session-failed', 1);

    expect(slicePacket).toMatchObject({
      sliceNumber: 1,
      title: 'Add read-only HELIX control-plane service',
      status: 'failed',
      dependencies: [],
      dependentSlices: [2],
      findings: [
        expect.objectContaining({
          id: 'finding-typecheck',
        }),
      ],
      proofPacket: expect.objectContaining({
        sliceNumber: 1,
        proofHash: expect.any(String),
        artifacts: expect.objectContaining({
          verificationDiffHash: 'diff-hash-1',
        }),
      }),
      verificationCheckpoint: expect.objectContaining({
        diffHash: 'diff-hash-1',
      }),
    });
    expect(gateResults).toEqual([
      expect.objectContaining({
        sliceNumber: 1,
        gates: expect.arrayContaining([
          expect.objectContaining({
            criterionId: 'typecheck',
            passed: false,
            cached: true,
          }),
          expect.objectContaining({
            criterionId: 'test-lock',
            passed: true,
            cached: false,
          }),
        ]),
      }),
    ]);
  });

  it('explains blockers, returns dependency DAGs, and searches findings', async () => {
    workDir = await createWorkspaceWithSessions();
    const service = new HelixControlPlaneService({ workDir });

    const blocker = await service.explainBlocker('session-failed');
    const sliceBlocker = await service.explainBlocker('session-failed', 2);
    const dag = await service.getDependencyDag('session-failed');
    const findings = await service.searchFindings('typecheck');

    expect(blocker).toMatchObject({
      blockerType: 'decision',
      message: expect.stringContaining('unresolved decision'),
      unresolvedDecisions: [expect.objectContaining({ id: 'decision-1' })],
    });
    expect(sliceBlocker).toMatchObject({
      blockerType: 'dependency',
      unmetDependencies: [
        expect.objectContaining({
          sliceNumber: 1,
          status: 'failed',
        }),
      ],
    });
    expect(dag).toMatchObject({
      nodes: [
        expect.objectContaining({ sliceNumber: 1, status: 'failed' }),
        expect.objectContaining({ sliceNumber: 2, status: 'pending' }),
      ],
      edges: [{ from: 1, to: 2 }],
    });
    expect(findings).toEqual([
      expect.objectContaining({
        sessionId: 'session-failed',
        findingId: 'finding-typecheck',
        assignedSlice: 1,
      }),
    ]);
  });
});

async function createWorkspaceWithSessions(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'helix-control-plane-'));
  await mkdir(join(root, '.helix', 'sessions', 'session-failed'), { recursive: true });
  await mkdir(join(root, '.helix', 'sessions', 'session-complete'), { recursive: true });

  await writeFile(
    join(root, '.helix', 'sessions', 'session-failed', 'session.json'),
    `${JSON.stringify(createFailedSession(), null, 2)}\n`,
    'utf-8',
  );
  await writeFile(
    join(root, '.helix', 'sessions', 'session-complete', 'session.json'),
    `${JSON.stringify(createCompletedSession(), null, 2)}\n`,
    'utf-8',
  );

  return root;
}

function createFailedSession(): Session {
  const timestamp = '2026-04-06T15:00:00.000Z';
  const pipelineSnapshot: PipelineTemplate = {
    name: 'HELIX MCP Foundation',
    description: 'Add read-only control-plane MCP access',
    applicableTo: ['feature-audit'],
    stages: [
      {
        name: 'Plan',
        type: 'plan-generation',
        description: 'Plan the MCP tools',
        model: { primary: { engine: 'codex-cli', model: 'gpt-5.5' } },
        canLoop: false,
        maxLoopIterations: 1,
      },
      {
        name: 'Implement',
        type: 'implementation',
        description: 'Implement the MCP service',
        model: { primary: { engine: 'codex-cli', model: 'gpt-5.5' } },
        canLoop: false,
        maxLoopIterations: 1,
      },
    ],
  };

  const slices: Slice[] = [
    {
      index: 0,
      title: 'Add read-only HELIX control-plane service',
      description: 'Expose persisted session state through typed queries.',
      status: 'failed',
      findings: ['finding-typecheck'],
      dependencies: [],
      manifest: {
        entryConditions: [],
        fileContracts: [
          {
            path: 'packages/helix/src/mcp/control-plane-service.ts',
            action: 'create',
            reason: 'Implements the read-only control-plane query surface.',
          },
        ],
        exportContracts: [],
      },
      testLock: {
        requiredTests: [
          {
            testFile: 'packages/helix/src/__tests__/control-plane-service.test.ts',
            description: 'Control-plane session query coverage',
            status: 'passing',
            coversFindings: ['finding-typecheck'],
            isNew: true,
          },
        ],
        regressionSuite: [],
        locked: false,
      },
      impactAnalysis: {
        directFiles: ['packages/helix/src/mcp/control-plane-service.ts'],
        dependentFiles: ['packages/helix/src/mcp/server.ts'],
        affectedTests: ['packages/helix/src/__tests__/control-plane-service.test.ts'],
        riskLevel: 'medium',
        notes: 'The MCP wrapper depends on the new service layer.',
      },
      legacyPaths: [],
      exitCriteria: [
        {
          id: 'typecheck',
          type: 'typecheck',
          description: 'TypeScript compiles',
          passed: false,
          detail: 'PASS — reused prior passing verification for unchanged diff',
        },
        {
          id: 'test-lock',
          type: 'test-lock',
          description: 'Required tests pass and lock the slice',
          passed: true,
          detail: 'PASS — control-plane service tests are green.',
        },
      ],
      verificationCheckpoint: {
        diffHash: 'diff-hash-1',
        capturedAt: timestamp,
        criteria: [
          {
            criterionId: 'typecheck',
            criterionType: 'typecheck',
            detail: 'PASS — reused prior passing verification for unchanged diff',
            capturedAt: timestamp,
          },
        ],
      },
    },
    {
      index: 1,
      title: 'Wrap the control-plane service in MCP tools',
      description: 'Expose structured MCP tools for sessions and blockers.',
      status: 'pending',
      findings: [],
      dependencies: [0],
      manifest: {
        entryConditions: [],
        fileContracts: [
          {
            path: 'packages/helix/src/mcp/server.ts',
            action: 'create',
            reason: 'Depends on the control-plane service abstractions.',
          },
        ],
        exportContracts: [],
      },
      testLock: {
        requiredTests: [],
        regressionSuite: [],
        locked: false,
      },
      impactAnalysis: {
        directFiles: ['packages/helix/src/mcp/server.ts'],
        dependentFiles: [],
        affectedTests: [],
        riskLevel: 'low',
        notes: 'Blocked on slice 1.',
      },
      legacyPaths: [],
      exitCriteria: [],
    },
  ];

  return {
    id: 'session-failed',
    workItem: {
      id: 'work-1',
      type: 'feature-audit',
      title: 'HELIX control plane MCP foundation',
      description: 'Expose HELIX state through MCP tools.',
      scope: ['packages/helix/src'],
      jiraKey: 'ABLP-215',
      targetBranch: 'current',
      createdAt: timestamp,
    },
    pipelineName: pipelineSnapshot.name,
    pipelineVersion: `${pipelineSnapshot.name}@123456789abc`,
    pipelineSnapshot,
    state: 'awaiting-input',
    currentStageIndex: 1,
    currentSliceIndex: 0,
    totalSlices: slices.length,
    slices,
    findings: [
      {
        id: 'finding-typecheck',
        category: 'bug',
        severity: 'high',
        status: 'open',
        title: 'Scoped typecheck false negative still needs a durable fix',
        description: 'The control-plane service should surface recurring harness defects.',
        files: [{ path: 'packages/helix/src/mcp/control-plane-service.ts' }],
        discoveredBy: 'Deep Scan',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    decisions: [
      {
        id: 'decision-1',
        classification: 'AMBIGUOUS',
        question: 'Should the first MCP slice stay read-only?',
        context: 'Need a decision before the next slice.',
        oracleVotes: [],
        stage: 'Implement',
      },
    ],
    commits: [],
    journal: [],
    stageHistory: [
      {
        stageName: 'Plan',
        stageType: 'plan-generation',
        status: 'passed',
        output: 'Initial MCP plan approved.',
        findings: [],
        decisions: [],
        durationMs: 1,
        iterations: 1,
        model: 'gpt-5.5',
      },
    ],
    checkpointApprovals: [
      {
        stageName: 'Plan Approval',
        artifactHash: 'artifact-1',
        message: 'Approved the read-only MCP plan.',
        approvedAt: timestamp,
      },
    ],
    oracleCheckpoints: [],
    harnessDefects: [
      {
        id: 'defect-1',
        kind: 'quality-gate',
        stageName: 'Implement',
        actor: 'typecheck',
        signature: 'typecheck:TS6307',
        sample: 'error TS6307: File is not listed within the file list of project.',
        occurrences: 2,
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
      },
    ],
    startedAt: timestamp,
    updatedAt: timestamp,
    error: 'Waiting on a scope decision before continuing.',
  };
}

function createCompletedSession(): Session {
  const timestamp = '2026-04-06T14:00:00.000Z';

  return {
    id: 'session-complete',
    workItem: {
      id: 'work-2',
      type: 'feature-audit',
      title: 'HELIX deterministic verification follow-up',
      description: 'A completed follow-up session.',
      scope: ['packages/helix/src'],
      targetBranch: 'current',
      createdAt: timestamp,
    },
    pipelineName: 'Deterministic Verification',
    pipelineVersion: 'Deterministic Verification@123456789abc',
    state: 'completed',
    currentStageIndex: 1,
    currentSliceIndex: 0,
    totalSlices: 0,
    slices: [],
    findings: [],
    decisions: [],
    commits: [],
    journal: [],
    stageHistory: [
      {
        stageName: 'Implement',
        stageType: 'implementation',
        status: 'passed',
        output: 'Completed cleanly.',
        findings: [],
        decisions: [],
        durationMs: 1,
        iterations: 1,
        model: 'gpt-5.5',
      },
    ],
    checkpointApprovals: [],
    oracleCheckpoints: [],
    harnessDefects: [],
    startedAt: timestamp,
    updatedAt: timestamp,
    completedAt: timestamp,
  };
}
