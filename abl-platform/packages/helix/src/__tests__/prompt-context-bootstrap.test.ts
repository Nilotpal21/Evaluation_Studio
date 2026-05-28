/**
 * Unit tests for buildPromptContext — bootstrapMeta propagation (Slice 4).
 *
 * Verifies that session.bootstrapMeta is threaded into PromptContextSnapshot
 * and that the session-scoped loadPriorDoc lookup is used correctly.
 *
 * These tests are isolated from the module-level mocks in
 * pipeline-engine-context.test.ts.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildPromptContext } from '../pipeline/prompt-context.js';
import { SessionManager } from '../session/session-manager.js';
import type { BootstrapMeta, HelixConfig, PipelineTemplate, WorkItem } from '../types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createConfig(workDir: string): HelixConfig {
  return {
    workDir,
    sessionDir: join(workDir, '.helix', 'sessions'),
    journalDir: join(workDir, '.helix', 'journal'),
    defaultModel: {
      engine: 'codex-cli',
      model: 'gpt-5.5',
    },
    codexPath: 'codex',
    claudePath: 'claude',
    maxConcurrentOracles: 1,
    maxSliceRetries: 1,
    autoCommit: false,
    autoApprove: true,
    budgetLimitUsd: 25,
    verbose: false,
  };
}

function createWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'work-item-ctx-1',
    type: 'feature-audit',
    title: 'Bootstrap Context Test',
    description: 'Ensure bootstrapMeta is threaded into prompt context',
    scope: ['src'],
    targetBranch: 'current',
    createdAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

function createMinimalPipeline(): PipelineTemplate {
  return {
    name: 'Minimal',
    description: 'Minimal pipeline for prompt-context unit tests',
    applicableTo: ['feature-audit'],
    stages: [
      {
        name: 'Approval',
        type: 'user-checkpoint',
        description: 'Checkpoint',
        model: { primary: { engine: 'claude-code', model: 'sonnet' } },
        canLoop: false,
        maxLoopIterations: 1,
        checkpoint: 'user-approval',
      },
    ],
  };
}

async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'helix-prompt-ctx-bootstrap-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'index.ts'), 'export const x = 1;\n', 'utf-8');
  return dir;
}

// ─── bootstrapMeta propagation tests ─────────────────────────────────────────

describe('buildPromptContext — bootstrapMeta propagation (Slice 4)', () => {
  let workDir: string | null = null;

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
      workDir = null;
    }
  });

  it('threads session.bootstrapMeta into the returned PromptContextSnapshot', async () => {
    workDir = await createWorkspace();
    const config = createConfig(workDir);
    const sessionManager = new SessionManager(config);

    const bootstrapMeta: BootstrapMeta = {
      jiraKey: 'ABLP-778',
      jiraFetchSuccess: true,
      jiraFetchLatencyMs: 120,
      scopeInferenceMethod: 'deterministic',
      inferredScope: ['src'],
      acceptanceCriteria: ['Session expires after 30 minutes', 'Invalid input returns 400'],
    };

    const session = await sessionManager.create(createWorkItem(), createMinimalPipeline(), {
      bootstrapMeta,
    });

    const snapshot = await buildPromptContext(session, config);

    expect(snapshot.bootstrapMeta).toMatchObject({
      jiraKey: 'ABLP-778',
      jiraFetchSuccess: true,
      scopeInferenceMethod: 'deterministic',
      inferredScope: ['src'],
      acceptanceCriteria: ['Session expires after 30 minutes', 'Invalid input returns 400'],
    });
  });

  it('omits bootstrapMeta from snapshot when session has none', async () => {
    workDir = await createWorkspace();
    const config = createConfig(workDir);
    const sessionManager = new SessionManager(config);

    // Create session without bootstrapMeta
    const session = await sessionManager.create(createWorkItem(), createMinimalPipeline());

    const snapshot = await buildPromptContext(session, config);

    expect(snapshot.bootstrapMeta).toBeUndefined();
  });

  it('includes bootstrapMeta with fallbackReason when Jira fetch failed', async () => {
    workDir = await createWorkspace();
    const config = createConfig(workDir);
    const sessionManager = new SessionManager(config);

    const bootstrapMeta: BootstrapMeta = {
      jiraKey: 'ABLP-999',
      jiraFetchSuccess: false,
      scopeInferenceMethod: 'empty',
      inferredScope: [],
      fallbackReason: 'not-found',
    };

    const session = await sessionManager.create(createWorkItem(), createMinimalPipeline(), {
      bootstrapMeta,
    });

    const snapshot = await buildPromptContext(session, config);

    expect(snapshot.bootstrapMeta).toMatchObject({
      jiraKey: 'ABLP-999',
      jiraFetchSuccess: false,
      fallbackReason: 'not-found',
    });
  });

  it('session-scoped loadPriorDoc: uses slug-only path when session-scoped path does not exist', async () => {
    // Verifies that the session-scoped loadPriorDoc falls back to slug-only
    // path gracefully when no session-scoped file exists (pre-existing content
    // from earlier sessions).
    workDir = await createWorkspace();
    const config = createConfig(workDir);
    const sessionManager = new SessionManager(config);
    const session = await sessionManager.create(createWorkItem(), createMinimalPipeline());

    // Write a prior findings doc at the slug-only path (legacy location)
    const slug = 'bootstrap-context-test'; // slugified from title
    const journalDir = join(workDir, '.helix', 'journal', slug);
    await mkdir(journalDir, { recursive: true });
    await writeFile(
      join(journalDir, 'findings.md'),
      '# Prior Findings\n\n- Finding one\n',
      'utf-8',
    );

    const snapshot = await buildPromptContext(session, config);

    // The prior findings doc should be loaded from the slug-only fallback path
    expect(snapshot.priorFindingsDoc).toBeDefined();
    expect(snapshot.priorFindingsDoc?.title).toBe('Prior Findings');
  });
});
