import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectTool, updateProjectTool } from '../repos/project-tool-repo.js';
import { computeSourceHash } from '../utils/hash.js';

const projectToolModel = vi.hoisted(() => ({
  create: vi.fn(),
  findOne: vi.fn(),
  findOneAndUpdate: vi.fn(),
}));

vi.mock('@agent-platform/database/models', () => ({
  ProjectTool: projectToolModel,
}));

const ctx = {
  tenantId: 'tenant-test',
  projectId: 'project-test',
};

function httpDsl(name: string): string {
  return `${name}() -> object
  description: "Fetch data"
  type: http
  endpoint: "https://api.example.com/data"
  method: GET`;
}

describe('project-tool-repo persistence guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('derives sourceHash from dslContent on create instead of trusting caller input', async () => {
    const dslContent = httpDsl('fetch_data');
    projectToolModel.create.mockImplementation(async (doc: Record<string, unknown>) => ({
      toObject: () => ({ _id: 'tool-1', ...doc }),
    }));

    await createProjectTool({
      ...ctx,
      name: 'fetch_data',
      slug: 'fetch_data',
      toolType: 'http',
      description: 'Fetch data',
      dslContent,
      sourceHash: 'c'.repeat(64),
      createdBy: 'user-test',
    });

    expect(projectToolModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        dslContent,
        sourceHash: computeSourceHash(dslContent),
      }),
    );
  });

  it('rewrites rename-only updates so DB name and DSL signature stay synchronized', async () => {
    const existingDsl = httpDsl('old_tool');
    projectToolModel.findOne.mockReturnValue({
      lean: async () => ({
        _id: 'tool-1',
        ...ctx,
        name: 'old_tool',
        slug: 'old_tool',
        toolType: 'http',
        description: 'Old tool',
        dslContent: existingDsl,
        sourceHash: computeSourceHash(existingDsl),
        variableNamespaceIds: [],
        createdBy: 'user-test',
        lastEditedBy: null,
        _v: 1,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
    });
    projectToolModel.findOneAndUpdate.mockReturnValue({
      lean: async () => ({
        _id: 'tool-1',
        ...ctx,
        name: 'new_tool',
        slug: 'old_tool',
        toolType: 'http',
        description: 'Old tool',
        dslContent: httpDsl('new_tool'),
        sourceHash: computeSourceHash(httpDsl('new_tool')),
        variableNamespaceIds: [],
        createdBy: 'user-test',
        lastEditedBy: 'user-test',
        _v: 1,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
    });

    await updateProjectTool('tool-1', ctx.tenantId, ctx.projectId, {
      name: 'new_tool',
      lastEditedBy: 'user-test',
    });

    const update = projectToolModel.findOneAndUpdate.mock.calls[0]?.[1] as {
      $set?: Record<string, unknown>;
    };
    const dslContent = update.$set?.dslContent;
    expect(dslContent).toBe(httpDsl('new_tool'));
    expect(update.$set?.sourceHash).toBe(computeSourceHash(httpDsl('new_tool')));
  });
});
