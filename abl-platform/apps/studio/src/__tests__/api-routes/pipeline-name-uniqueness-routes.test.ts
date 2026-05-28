/**
 * Route-level wiring tests for the pipeline name uniqueness feature.
 *
 * Verifies that the 409 / 400 / duplicate-key handling we added to:
 *   - POST   /api/pipelines
 *   - PATCH  /api/pipelines/:id
 *
 * are actually wired correctly — response shape, status code, error code,
 * and that the duplicate-key safety net (E11000) translates to 409.
 *
 * Library-level uniqueness logic is covered by assert-unique-pipeline-name.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const {
  mockRequireTenantAuth,
  mockPipelineFindOne,
  mockPipelineFind,
  mockPipelineFindOneAndUpdate,
  mockPipelineSave,
  mockAssertUnique,
  mockValidatePipeline,
  mockValidateGraphPipeline,
  mockValidateNodeModels,
  mockResolveTriggerSelections,
  mockGetNodeRegistry,
} = vi.hoisted(() => ({
  mockRequireTenantAuth: vi.fn(),
  mockPipelineFindOne: vi.fn(),
  mockPipelineFind: vi.fn(),
  mockPipelineFindOneAndUpdate: vi.fn(),
  mockPipelineSave: vi.fn(),
  mockAssertUnique: vi.fn(),
  mockValidatePipeline: vi.fn(() => []),
  mockValidateGraphPipeline: vi.fn(() => ({ errors: [], warnings: [] })),
  mockValidateNodeModels: vi.fn(async () => []),
  mockResolveTriggerSelections: vi.fn(async () => null),
  mockGetNodeRegistry: vi.fn(async () => ({})),
}));

vi.mock('@/lib/auth', () => ({
  requireTenantAuth: (...args: unknown[]) => mockRequireTenantAuth(...args),
  isAuthError: (value: unknown) => value instanceof NextResponse,
  formatUserLabel: (user: { email?: string; id: string }) => user.email ?? user.id,
}));

vi.mock('@/lib/api-response', () => ({
  handleApiError: (err: unknown) =>
    NextResponse.json({ error: 'Server error', detail: String(err) }, { status: 500 }),
}));

vi.mock('@/lib/invalidate-definition-cache', () => ({
  invalidateDefinitionCache: vi.fn(async () => {}),
}));

vi.mock('@agent-platform/pipeline-engine/schemas', () => {
  function PipelineDefinitionModelCtor(
    this: Record<string, unknown>,
    doc: Record<string, unknown>,
  ) {
    Object.assign(this, doc);
    this.save = mockPipelineSave;
    this.toObject = () => doc;
  }
  // Static methods
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (PipelineDefinitionModelCtor as any).findOne = (...args: unknown[]) =>
    mockPipelineFindOne(...args);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (PipelineDefinitionModelCtor as any).find = (...args: unknown[]) => mockPipelineFind(...args);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (PipelineDefinitionModelCtor as any).findOneAndUpdate = (...args: unknown[]) =>
    mockPipelineFindOneAndUpdate(...args);
  return { PipelineDefinitionModel: PipelineDefinitionModelCtor };
});

vi.mock('@agent-platform/pipeline-engine/validation', () => ({
  validatePipeline: (...args: unknown[]) => mockValidatePipeline(...args),
  validateGraphPipeline: (...args: unknown[]) => mockValidateGraphPipeline(...args),
  validateNodeModels: (...args: unknown[]) => mockValidateNodeModels(...args),
}));

vi.mock('@agent-platform/pipeline-engine/contracts', () => ({
  ContractRegistry: class {
    getNode() {
      return null;
    }
  },
}));

vi.mock('@/lib/assert-unique-pipeline-name', async () => {
  const actual = await vi.importActual<typeof import('@/lib/assert-unique-pipeline-name')>(
    '@/lib/assert-unique-pipeline-name',
  );
  return {
    ...actual,
    // Real normalizePipelineName, isPipelineNameDuplicateKeyError, PipelineNameTakenError.
    // Mock only the assertion so we control collision behavior per-test.
    assertUniquePipelineName: (...args: unknown[]) => mockAssertUnique(...args),
    // generateUniquePipelineName stays real; will use mockAssertUnique internally.
  };
});

// Sub-route _shared modules
vi.mock(
  '/Users/Rakshak.Kundarapu/Documents/Projects/abl-platform/apps/studio/src/app/api/pipelines/_shared/registry',
  () => ({
    getNodeRegistry: (...args: unknown[]) => mockGetNodeRegistry(...args),
  }),
);
vi.mock(
  '/Users/Rakshak.Kundarapu/Documents/Projects/abl-platform/apps/studio/src/app/api/pipelines/_shared/resolve-triggers',
  () => ({
    resolveTriggerSelections: (...args: unknown[]) => mockResolveTriggerSelections(...args),
  }),
);

// Imports under test — must come after vi.mock declarations
const user = { id: 'user-1', email: 'dev@example.com', tenantId: 'tenant-1' };

beforeEach(() => {
  mockRequireTenantAuth.mockReset().mockResolvedValue(user);
  mockPipelineFindOne.mockReset();
  mockPipelineFind.mockReset();
  mockPipelineFindOneAndUpdate.mockReset();
  mockPipelineSave.mockReset().mockResolvedValue(undefined);
  mockAssertUnique.mockReset().mockResolvedValue(undefined);
  mockValidatePipeline.mockReset().mockReturnValue([]);
  mockValidateGraphPipeline.mockReset().mockReturnValue({ errors: [], warnings: [] });
  mockValidateNodeModels.mockReset().mockResolvedValue([]);
  mockResolveTriggerSelections.mockReset().mockResolvedValue(null);
  mockGetNodeRegistry.mockReset().mockResolvedValue({});
});

describe('POST /api/pipelines — name uniqueness wiring', () => {
  it('returns 409 with code PIPELINE_NAME_TAKEN when assertUniquePipelineName throws', async () => {
    const { POST } = await import('../../app/api/pipelines/route');
    const { PipelineNameTakenError } = await import('@/lib/assert-unique-pipeline-name');
    mockAssertUnique.mockRejectedValueOnce(new PipelineNameTakenError('Test', 'builtin'));

    const req = new NextRequest('http://localhost/api/pipelines', {
      method: 'POST',
      body: JSON.stringify({ name: 'Test', projectId: 'p1', trigger: 'manual', steps: [] }),
    });

    const res = await POST(req);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('PIPELINE_NAME_TAKEN');
    expect(body.collidesWith).toBe('builtin');
  });

  it('returns 400 when the name is whitespace-only', async () => {
    const { POST } = await import('../../app/api/pipelines/route');

    const req = new NextRequest('http://localhost/api/pipelines', {
      method: 'POST',
      body: JSON.stringify({ name: '   ', projectId: 'p1', trigger: 'manual', steps: [] }),
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/empty/i);
  });

  it('returns 409 when save() throws a duplicate-key error (race window)', async () => {
    const { POST } = await import('../../app/api/pipelines/route');
    mockPipelineSave.mockRejectedValueOnce(
      Object.assign(new Error('E11000 duplicate key error: index tenantId_1_projectId_1_name_1'), {
        code: 11000,
      }),
    );

    const req = new NextRequest('http://localhost/api/pipelines', {
      method: 'POST',
      body: JSON.stringify({ name: 'Racy', projectId: 'p1', trigger: 'manual', steps: [] }),
    });

    const res = await POST(req);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('PIPELINE_NAME_TAKEN');
  });

  it('trims and collapses whitespace in the persisted name', async () => {
    const { POST } = await import('../../app/api/pipelines/route');
    let captured: Record<string, unknown> | undefined;
    mockPipelineSave.mockImplementationOnce(function (this: Record<string, unknown>) {
      captured = this;
      return Promise.resolve();
    });

    const req = new NextRequest('http://localhost/api/pipelines', {
      method: 'POST',
      body: JSON.stringify({
        name: '  My   Custom   Pipeline  ',
        projectId: 'p1',
        trigger: 'manual',
        steps: [],
      }),
    });

    const res = await POST(req);

    expect(res.status).toBe(201);
    expect(captured?.name).toBe('My Custom Pipeline');
  });
});

describe('PATCH /api/pipelines/:id — name uniqueness wiring', () => {
  it('returns 409 when renaming to a name that collides', async () => {
    const { PATCH } = await import('../../app/api/pipelines/[pipelineId]/route');
    const { PipelineNameTakenError } = await import('@/lib/assert-unique-pipeline-name');

    // existing pipeline
    mockPipelineFindOne.mockResolvedValueOnce({
      _id: 'pipe-1',
      tenantId: user.tenantId,
      projectId: 'p1',
      name: 'Old Name',
      createdBy: user.email,
      toObject() {
        return {
          _id: 'pipe-1',
          tenantId: user.tenantId,
          projectId: 'p1',
          name: 'Old Name',
        };
      },
    });
    mockAssertUnique.mockRejectedValueOnce(new PipelineNameTakenError('Taken', 'custom'));

    const req = new NextRequest('http://localhost/api/pipelines/pipe-1', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Taken' }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ pipelineId: 'pipe-1' }) });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('PIPELINE_NAME_TAKEN');
    expect(body.collidesWith).toBe('custom');
  });

  it('returns 400 when renaming to whitespace-only', async () => {
    const { PATCH } = await import('../../app/api/pipelines/[pipelineId]/route');
    mockPipelineFindOne.mockResolvedValueOnce({
      _id: 'pipe-1',
      tenantId: user.tenantId,
      projectId: 'p1',
      name: 'Old',
      toObject() {
        return { _id: 'pipe-1', tenantId: user.tenantId, projectId: 'p1', name: 'Old' };
      },
    });

    const req = new NextRequest('http://localhost/api/pipelines/pipe-1', {
      method: 'PATCH',
      body: JSON.stringify({ name: '   ' }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ pipelineId: 'pipe-1' }) });

    expect(res.status).toBe(400);
  });

  it('skips uniqueness check on a no-op rename (cleaned name === existing name)', async () => {
    const { PATCH } = await import('../../app/api/pipelines/[pipelineId]/route');
    mockPipelineFindOne.mockResolvedValueOnce({
      _id: 'pipe-1',
      tenantId: user.tenantId,
      projectId: 'p1',
      name: 'My Pipeline',
      toObject() {
        return { _id: 'pipe-1', tenantId: user.tenantId, projectId: 'p1', name: 'My Pipeline' };
      },
    });
    mockPipelineFindOneAndUpdate.mockResolvedValueOnce({ _id: 'pipe-1', name: 'My Pipeline' });

    const req = new NextRequest('http://localhost/api/pipelines/pipe-1', {
      method: 'PATCH',
      body: JSON.stringify({ name: '  My Pipeline  ' }), // normalizes back to existing
    });

    const res = await PATCH(req, { params: Promise.resolve({ pipelineId: 'pipe-1' }) });

    expect(res.status).toBe(200);
    expect(mockAssertUnique).not.toHaveBeenCalled();
  });
});
