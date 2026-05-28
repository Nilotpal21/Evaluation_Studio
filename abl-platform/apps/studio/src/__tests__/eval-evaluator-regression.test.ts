// @vitest-environment node
/**
 * Regression tests for ABLP-868 eval evaluator bugs:
 *
 * 1. findEvaluatorsByProject was missing judgeModel (and other fields) from the
 *    .select() projection — GET /evaluators returned evaluators without judgeModel.
 *
 * 2. Deleting a model config did not clear stale judgeModel references on
 *    evaluators — evaluators retained a dead modelId that failed preflight.
 *
 * These tests call the repo functions directly against a real MongoMemoryServer
 * instance so no platform packages need to be mocked.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

const TEST_MASTER_KEY = '4'.repeat(64);
const MONGOMS_VERSION = process.env.MONGOMS_VERSION ?? '7.0.20';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({
    binary: { version: MONGOMS_VERSION },
    instance: { launchTimeout: 30_000 },
  });
  const mongoUri = mongod.getUri();
  process.env.MONGODB_URL = mongoUri;
  process.env.MONGODB_URI = mongoUri;
  process.env.MONGODB_MANAGED = 'false';
  process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY;
  process.env.ENCRYPTION_ENABLED = 'true';

  // Connect Mongoose to the in-memory DB before any test inserts documents.
  const { ensureConnected } = await import('@agent-platform/database/models');
  await ensureConnected(mongoUri);
}, 40_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
}, 15_000);

// ── helpers ──────────────────────────────────────────────────────────────────

function uid() {
  return `test-${Math.random().toString(36).slice(2, 10)}`;
}

async function insertEvaluator(overrides: Record<string, unknown> = {}) {
  const { EvalEvaluator } = await import('@agent-platform/database/models');
  const doc = await EvalEvaluator.create({
    tenantId: 't-1',
    projectId: 'p-1',
    name: `evaluator-${uid()}`,
    type: 'llm_judge',
    category: 'quality',
    isBuiltIn: false,
    version: 1,
    createdBy: 'test-user',
    ...overrides,
  });
  return doc.toObject() as Record<string, unknown>;
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe('findEvaluatorsByProject — projection includes judgeModel (ABLP-868)', () => {
  it('returns judgeModel when the evaluator has one set', async () => {
    const { findEvaluatorsByProject } = await import('@/repos/eval-repo');
    const modelId = `gpt-4o-${uid()}`;

    await insertEvaluator({ judgeModel: modelId });

    const results = await findEvaluatorsByProject('p-1', 't-1');
    const found = results.find((e: Record<string, unknown>) => e.judgeModel === modelId);
    expect(found, 'evaluator with judgeModel should appear in list').toBeDefined();
    expect(found?.judgeModel).toBe(modelId);
  });

  it('returns undefined judgeModel when none is set', async () => {
    const { findEvaluatorsByProject } = await import('@/repos/eval-repo');
    const name = `no-model-${uid()}`;

    await insertEvaluator({ name });

    const results = await findEvaluatorsByProject('p-1', 't-1');
    const found = results.find((e: Record<string, unknown>) => e.name === name);
    expect(found).toBeDefined();
    expect(found?.judgeModel).toBeUndefined();
  });

  it('returns judgePrompt and temperature alongside judgeModel', async () => {
    const { findEvaluatorsByProject } = await import('@/repos/eval-repo');
    const modelId = `gpt-4o-${uid()}`;

    await insertEvaluator({
      judgeModel: modelId,
      judgePrompt: 'Rate the response quality.',
      temperature: 0.5,
    });

    const results = await findEvaluatorsByProject('p-1', 't-1');
    const found = results.find((e: Record<string, unknown>) => e.judgeModel === modelId);
    expect(found?.judgePrompt).toBe('Rate the response quality.');
    expect(found?.temperature).toBe(0.5);
  });
});

describe('clearStaleJudgeModelRefs — cascade-clear on model config delete (ABLP-868)', () => {
  it('clears judgeModel on evaluators that reference the deleted modelId', async () => {
    const { clearStaleJudgeModelRefs, findEvaluatorsByProject } = await import('@/repos/eval-repo');
    const modelId = `to-delete-${uid()}`;

    const created = await insertEvaluator({
      tenantId: 't-2',
      projectId: 'p-2',
      judgeModel: modelId,
    });

    await clearStaleJudgeModelRefs('t-2', 'p-2', modelId);

    const results = await findEvaluatorsByProject('p-2', 't-2');
    const after = results.find((e: Record<string, unknown>) => e.id === String(created._id));
    expect(after, 'evaluator should still exist').toBeDefined();
    expect(after?.judgeModel).toBeUndefined();
  });

  it('returns the count of modified evaluators', async () => {
    const { clearStaleJudgeModelRefs } = await import('@/repos/eval-repo');
    const modelId = `bulk-${uid()}`;

    await insertEvaluator({ tenantId: 't-3', projectId: 'p-3', judgeModel: modelId });
    await insertEvaluator({ tenantId: 't-3', projectId: 'p-3', judgeModel: modelId });

    const count = await clearStaleJudgeModelRefs('t-3', 'p-3', modelId);
    expect(count).toBe(2);
  });

  it('does not clear evaluators with a different modelId', async () => {
    const { clearStaleJudgeModelRefs, findEvaluatorsByProject } = await import('@/repos/eval-repo');
    const deletedModelId = `deleted-${uid()}`;
    const keepModelId = `keep-${uid()}`;

    await insertEvaluator({ tenantId: 't-4', projectId: 'p-4', judgeModel: deletedModelId });
    await insertEvaluator({ tenantId: 't-4', projectId: 'p-4', judgeModel: keepModelId });

    await clearStaleJudgeModelRefs('t-4', 'p-4', deletedModelId);

    const results = await findEvaluatorsByProject('p-4', 't-4');
    const keeper = results.find((e: Record<string, unknown>) => e.judgeModel === keepModelId);
    expect(keeper?.judgeModel).toBe(keepModelId);
  });

  it('is scoped to tenant+project — does not clear across tenants', async () => {
    const { clearStaleJudgeModelRefs, findEvaluatorsByProject } = await import('@/repos/eval-repo');
    const sharedModelId = `cross-tenant-${uid()}`;

    await insertEvaluator({ tenantId: 't-5a', projectId: 'p-5', judgeModel: sharedModelId });
    await insertEvaluator({ tenantId: 't-5b', projectId: 'p-5', judgeModel: sharedModelId });

    // Clear only for tenant t-5a
    await clearStaleJudgeModelRefs('t-5a', 'p-5', sharedModelId);

    // t-5b evaluator should be untouched
    const t5b = await findEvaluatorsByProject('p-5', 't-5b');
    const t5bEval = t5b.find((e: Record<string, unknown>) => e.judgeModel === sharedModelId);
    expect(t5bEval?.judgeModel).toBe(sharedModelId);
  });
});
