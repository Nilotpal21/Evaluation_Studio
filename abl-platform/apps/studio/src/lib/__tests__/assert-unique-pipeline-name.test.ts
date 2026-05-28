/**
 * Tests for assertUniquePipelineName / generateUniquePipelineName.
 *
 * Verifies:
 *   - Names collide with built-in pipelines (case-insensitive)
 *   - Names collide with existing custom pipelines in the same (tenantId, projectId)
 *   - Different (tenantId, projectId) scopes do NOT collide
 *   - excludeId allows a pipeline to keep its own name on rename
 *   - generateUniquePipelineName appends (2), (3), etc. on conflict
 *   - Archived pipelines do not block name reuse
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mongoose query chain mock — supports .select().lean()
const mockFindOne = vi.fn();
vi.mock('@agent-platform/pipeline-engine/schemas', () => ({
  PipelineDefinitionModel: {
    findOne: (...args: unknown[]) => ({
      select: () => ({
        lean: () => mockFindOne(...args),
      }),
    }),
  },
}));

// Built-in definitions — minimal stub matching the shape the utility reads (.definition.name)
vi.mock('@agent-platform/pipeline-engine', () => ({
  BUILTIN_DEFINITIONS: [
    { id: 'builtin:sentiment-analysis', definition: { name: 'Sentiment Analysis' } },
    { id: 'builtin:quality-evaluation', definition: { name: 'Quality Evaluation' } },
  ],
}));

import {
  assertUniquePipelineName,
  generateUniquePipelineName,
  PipelineNameTakenError,
} from '../assert-unique-pipeline-name';

describe('assertUniquePipelineName', () => {
  beforeEach(() => {
    mockFindOne.mockReset();
    mockFindOne.mockResolvedValue(null); // default: no custom collision
  });

  it('rejects a name that exactly matches a built-in pipeline name', async () => {
    await expect(
      assertUniquePipelineName('Sentiment Analysis', 'tenant-1', 'proj-1'),
    ).rejects.toThrow(PipelineNameTakenError);
    await expect(
      assertUniquePipelineName('Sentiment Analysis', 'tenant-1', 'proj-1'),
    ).rejects.toMatchObject({ collidesWith: 'builtin' });
  });

  it('rejects a name that case-insensitively matches a built-in (e.g. "quality evaluation")', async () => {
    await expect(
      assertUniquePipelineName('quality evaluation', 'tenant-1', 'proj-1'),
    ).rejects.toMatchObject({ collidesWith: 'builtin' });
    await expect(
      assertUniquePipelineName('  QUALITY EVALUATION  ', 'tenant-1', 'proj-1'),
    ).rejects.toMatchObject({ collidesWith: 'builtin' });
  });

  it('rejects a name that collides with an existing custom pipeline in the same project', async () => {
    mockFindOne.mockResolvedValueOnce({ _id: 'pipeline-existing-123' });

    await expect(
      assertUniquePipelineName('My Custom Pipeline', 'tenant-1', 'proj-1'),
    ).rejects.toMatchObject({ collidesWith: 'custom' });
  });

  it('allows the same custom name in a different project', async () => {
    // mockFindOne returns null by default → no collision found in the OTHER project
    await expect(
      assertUniquePipelineName('My Custom Pipeline', 'tenant-1', 'proj-2'),
    ).resolves.toBeUndefined();
  });

  it('allows reusing the same name when excludeId matches (no-op rename)', async () => {
    // findOne should be called with _id: { $ne: 'pipeline-self' } → returns null
    mockFindOne.mockResolvedValueOnce(null);

    await expect(
      assertUniquePipelineName('My Custom Pipeline', 'tenant-1', 'proj-1', 'pipeline-self'),
    ).resolves.toBeUndefined();
  });

  it('does not reject an empty or whitespace-only name (other validators handle that)', async () => {
    await expect(assertUniquePipelineName('', 'tenant-1', 'proj-1')).resolves.toBeUndefined();
    await expect(assertUniquePipelineName('   ', 'tenant-1', 'proj-1')).resolves.toBeUndefined();
  });

  it('passes the archived-filter to MongoDB query', async () => {
    let capturedFilter: Record<string, unknown> | undefined;
    mockFindOne.mockImplementationOnce((filter: Record<string, unknown>) => {
      capturedFilter = filter;
      return Promise.resolve(null);
    });

    await assertUniquePipelineName('Some Name', 'tenant-1', 'proj-1');

    expect(capturedFilter).toMatchObject({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      status: { $ne: 'archived' },
    });
  });
});

describe('generateUniquePipelineName', () => {
  beforeEach(() => {
    mockFindOne.mockReset();
  });

  it('returns the base name when no collision exists', async () => {
    mockFindOne.mockResolvedValue(null);

    const result = await generateUniquePipelineName('My Pipeline', 'tenant-1', 'proj-1');
    expect(result).toBe('My Pipeline');
  });

  it('appends (2) when base name collides with a custom pipeline', async () => {
    mockFindOne
      .mockResolvedValueOnce({ _id: 'p1' }) // 'My Pipeline' collides
      .mockResolvedValueOnce(null); // 'My Pipeline (2)' is free

    const result = await generateUniquePipelineName('My Pipeline', 'tenant-1', 'proj-1');
    expect(result).toBe('My Pipeline (2)');
  });

  it('keeps incrementing the suffix until a free name is found', async () => {
    mockFindOne
      .mockResolvedValueOnce({ _id: 'p1' }) // 'My Pipeline'
      .mockResolvedValueOnce({ _id: 'p2' }) // 'My Pipeline (2)'
      .mockResolvedValueOnce({ _id: 'p3' }) // 'My Pipeline (3)'
      .mockResolvedValueOnce(null); // 'My Pipeline (4)' free

    const result = await generateUniquePipelineName('My Pipeline', 'tenant-1', 'proj-1');
    expect(result).toBe('My Pipeline (4)');
  });

  it('skips a base name that collides with a built-in and uses (2)', async () => {
    mockFindOne.mockResolvedValue(null); // no custom collisions

    // 'Sentiment Analysis' collides with builtin → tries 'Sentiment Analysis (2)' which is free
    const result = await generateUniquePipelineName('Sentiment Analysis', 'tenant-1', 'proj-1');
    expect(result).toBe('Sentiment Analysis (2)');
  });
});
