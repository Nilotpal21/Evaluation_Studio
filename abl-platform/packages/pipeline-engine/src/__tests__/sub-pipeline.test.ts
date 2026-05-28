/**
 * Unit tests for the SubPipeline Restate activity service.
 *
 * Tests validation, depth guard, and input mapping.
 * The sub-pipeline service uses dynamic imports for PipelineDefinitionModel and
 * pipelineRun — these are mocked via vi.mock with factory functions.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { PipelineStepContext, StepOutput } from '../pipeline/types.js';

// ---------------------------------------------------------------------------
// Mock the dynamic imports used by sub-pipeline.service.ts
// The schema module is imported as '../../schemas/pipeline-definition.schema.js'
// relative to the service file — vitest resolves vi.mock paths from the test file,
// so we use '../schemas/pipeline-definition.schema.js'.
// ---------------------------------------------------------------------------

const mockFindOne = vi.fn();
const mockLean = vi.fn();
const mockRunWorkflow = vi.fn();

vi.mock('../schemas/pipeline-definition.schema.js', () => ({
  PipelineDefinitionModel: {
    findOne: (...args: any[]) => {
      mockFindOne(...args);
      return { lean: mockLean };
    },
  },
}));

vi.mock('../pipeline/handlers/pipeline-run.workflow.js', () => ({
  pipelineRun: { name: 'PipelineRun' },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockContext(): any {
  return {
    run: async (_label: string, fn: () => any) => fn(),
    serviceClient: () => ({ run: mockRunWorkflow }),
  };
}

function makeInput(overrides: Partial<PipelineStepContext> = {}): PipelineStepContext {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    config: {},
    previousSteps: {},
    pipelineInput: { tenantId: 'tenant-1', projectId: 'project-1' },
    ...overrides,
  };
}

function getExecute(svc: any): (ctx: any, input: PipelineStepContext) => Promise<StepOutput> {
  return (svc as any).service.execute;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SubPipelineService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLean.mockResolvedValue(null);
    mockRunWorkflow.mockResolvedValue({ status: 'completed', stepOutputs: {} });
  });

  test('returns fail when pipelineId is missing from config', async () => {
    const { subPipelineService } = await import('../pipeline/services/sub-pipeline.service.js');
    const execute = getExecute(subPipelineService);

    const ctx = createMockContext();
    const input = makeInput({ config: {} });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('pipelineId');
  });

  test('returns fail when _subPipelineDepth >= 3 (depth guard)', async () => {
    const { subPipelineService } = await import('../pipeline/services/sub-pipeline.service.js');
    const execute = getExecute(subPipelineService);

    const ctx = createMockContext();
    const input = makeInput({
      config: { pipelineId: 'some-pipeline' },
      pipelineInput: { tenantId: 'tenant-1', _subPipelineDepth: 3 },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('Max sub-pipeline depth');
    expect(result.data.depth).toBe(3);
  });

  test('returns fail when depth is exactly at max (boundary check)', async () => {
    const { subPipelineService } = await import('../pipeline/services/sub-pipeline.service.js');
    const execute = getExecute(subPipelineService);

    const ctx = createMockContext();
    const input = makeInput({
      config: { pipelineId: 'some-pipeline' },
      pipelineInput: { tenantId: 'tenant-1', _subPipelineDepth: 5 },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('Max sub-pipeline depth');
  });

  test('depth 2 passes the depth guard (just under limit)', async () => {
    // Depth 2 < 3, so depth guard should NOT trigger.
    // It will reach the model lookup — which returns null — so it fails with "not found"
    mockLean.mockResolvedValue(null);

    const { subPipelineService } = await import('../pipeline/services/sub-pipeline.service.js');
    const execute = getExecute(subPipelineService);

    const ctx = createMockContext();
    const input = makeInput({
      config: { pipelineId: 'non-existent-pipeline' },
      pipelineInput: { tenantId: 'tenant-1', _subPipelineDepth: 2 },
    });

    const result = await execute(ctx, input);

    // Should NOT be the depth guard error — will be "not found"
    expect(result.status).toBe('fail');
    expect(result.data.error).not.toContain('Max sub-pipeline depth');
    expect(result.data.error).toContain('not found or not active');
  });

  test('returns fail when sub-pipeline definition is not found', async () => {
    mockLean.mockResolvedValue(null);

    const { subPipelineService } = await import('../pipeline/services/sub-pipeline.service.js');
    const execute = getExecute(subPipelineService);

    const ctx = createMockContext();
    const input = makeInput({
      config: { pipelineId: 'missing-pipeline' },
      pipelineInput: { tenantId: 'tenant-1' },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('not found or not active');
  });

  test('happy path: found sub-pipeline returns success', async () => {
    mockLean.mockResolvedValue({
      _id: 'sub-pipe-1',
      name: 'Sub Pipeline',
      status: 'active',
      nodes: [],
    });
    mockRunWorkflow.mockResolvedValue({
      status: 'completed',
      stepOutputs: { result: 42 },
    });

    const { subPipelineService } = await import('../pipeline/services/sub-pipeline.service.js');
    const execute = getExecute(subPipelineService);

    const ctx = createMockContext();
    const input = makeInput({
      config: { pipelineId: 'sub-pipe-1' },
      pipelineInput: { tenantId: 'tenant-1', projectId: 'project-1' },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data).toEqual({ result: 42 });
  });

  test('applyMapping maps fields correctly from pipelineInput and previousSteps', async () => {
    mockLean.mockResolvedValue({
      _id: 'sub-pipe-1',
      name: 'Sub Pipeline',
      status: 'active',
      nodes: [],
    });
    mockRunWorkflow.mockResolvedValue({
      status: 'completed',
      stepOutputs: { result: 42 },
    });

    const { subPipelineService } = await import('../pipeline/services/sub-pipeline.service.js');
    const execute = getExecute(subPipelineService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        pipelineId: 'sub-pipe-1',
        inputMapping: {
          userId: 'input.userId',
          score: 'nodeOutputs.step1.data.score',
        },
      },
      previousSteps: {
        step1: { status: 'success', data: { score: 0.95 } },
      },
      pipelineInput: {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        userId: 'user-42',
        _subPipelineDepth: 0,
      },
    });

    const result = await execute(ctx, input);

    // The mapping should have been applied. The serviceClient().run receives the mapped input.
    expect(mockRunWorkflow).toHaveBeenCalled();
    const runArg = mockRunWorkflow.mock.calls[0][0];
    expect(runArg.pipelineInput.tenantId).toBe('tenant-1');
    expect(runArg.pipelineInput.projectId).toBe('project-1');
    expect(runArg.pipelineInput._subPipelineDepth).toBe(1);
    expect(runArg.pipelineInput.userId).toBe('user-42');
    expect(runArg.pipelineInput.score).toBe(0.95);
  });

  test('without inputMapping, passes pipelineInput with incremented depth', async () => {
    mockLean.mockResolvedValue({
      _id: 'sub-pipe-1',
      name: 'Sub Pipeline',
      status: 'active',
    });
    mockRunWorkflow.mockResolvedValue({
      status: 'completed',
      stepOutputs: {},
    });

    const { subPipelineService } = await import('../pipeline/services/sub-pipeline.service.js');
    const execute = getExecute(subPipelineService);

    const ctx = createMockContext();
    const input = makeInput({
      config: { pipelineId: 'sub-pipe-1' },
      pipelineInput: {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        customField: 'value',
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    const runArg = mockRunWorkflow.mock.calls[0][0];
    expect(runArg.pipelineInput._subPipelineDepth).toBe(1);
    expect(runArg.pipelineInput.customField).toBe('value');
  });

  test('returns fail when nested execution fails', async () => {
    mockLean.mockResolvedValue({
      _id: 'sub-pipe-1',
      name: 'Sub Pipeline',
      status: 'active',
    });
    mockRunWorkflow.mockRejectedValue(new Error('Workflow execution timeout'));

    const { subPipelineService } = await import('../pipeline/services/sub-pipeline.service.js');
    const execute = getExecute(subPipelineService);

    const ctx = createMockContext();
    const input = makeInput({
      config: { pipelineId: 'sub-pipe-1' },
      pipelineInput: { tenantId: 'tenant-1' },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    // Error message is sanitized — no raw error details exposed
    expect(result.data.error).toBe('Sub-pipeline execution failed');
  });

  test('queries with tenantId $in pattern including __platform__', async () => {
    mockLean.mockResolvedValue(null);

    const { subPipelineService } = await import('../pipeline/services/sub-pipeline.service.js');
    const execute = getExecute(subPipelineService);

    const ctx = createMockContext();
    const input = makeInput({
      config: { pipelineId: 'some-pipeline' },
      pipelineInput: { tenantId: 'my-tenant' },
    });

    await execute(ctx, input);

    // Verify the findOne call used the $in pattern for tenantId
    expect(mockFindOne).toHaveBeenCalledWith({
      _id: 'some-pipeline',
      tenantId: { $in: ['__platform__', 'my-tenant'] },
      status: 'active',
    });
  });
});
