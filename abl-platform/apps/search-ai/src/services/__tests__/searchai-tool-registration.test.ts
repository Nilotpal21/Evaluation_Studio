import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseDslProperties } from '@agent-platform/shared/tools';
import { registerSearchAITool, unregisterSearchAITool } from '../searchai-tool-registration.js';

const { mockProjectTool } = vi.hoisted(() => ({
  mockProjectTool: {
    findOneAndUpdate: vi.fn(),
    deleteOne: vi.fn(),
  },
}));

vi.mock('../../db/index.js', () => ({
  getLazyModel: (name: string) => {
    if (name === 'ProjectTool') return mockProjectTool;
    return {};
  },
}));

const ProjectTool = mockProjectTool;

describe('SearchAI Tool Registration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('registerSearchAITool', () => {
    it('creates a project_tool with searchai type', async () => {
      vi.mocked(ProjectTool.findOneAndUpdate).mockResolvedValue({} as any);

      await registerSearchAITool({
        indexId: 'idx_products',
        tenantId: 'tenant_1',
        projectId: 'proj_1',
        slug: 'products',
        name: 'Product Documentation',
        description: 'Technical product docs',
        createdBy: 'user_1',
      });

      expect(ProjectTool.findOneAndUpdate).toHaveBeenCalledWith(
        {
          tenantId: 'tenant_1',
          projectId: 'proj_1',
          name: 'search_kb_products',
          toolType: 'searchai',
          dslContent: expect.objectContaining({
            $regex: expect.any(RegExp),
          }),
        },
        expect.objectContaining({
          $set: expect.objectContaining({
            toolType: 'searchai',
            description: 'Search the "Product Documentation" knowledge base',
          }),
          $setOnInsert: expect.objectContaining({
            slug: 'search_kb_products',
            createdBy: 'user_1',
          }),
        }),
        { upsert: true, new: true },
      );
      const filter = vi.mocked(ProjectTool.findOneAndUpdate).mock.calls[0][0] as {
        dslContent?: { $regex?: RegExp };
      };
      expect(filter.dslContent?.$regex?.test('  index_id: "idx_products"')).toBe(true);
      expect(filter.dslContent?.$regex?.test('  index_id: "idx_products_other"')).toBe(false);
    });

    it('generates DSL content with index_id and tenant_id', async () => {
      vi.mocked(ProjectTool.findOneAndUpdate).mockResolvedValue({} as any);

      await registerSearchAITool({
        indexId: 'idx_123',
        tenantId: 'tenant_1',
        projectId: 'proj_1',
        slug: 'my_kb',
        name: 'My KB',
        createdBy: 'user_1',
      });

      const updateArg = vi.mocked(ProjectTool.findOneAndUpdate).mock.calls[0][1];
      const dslContent = updateArg?.$set?.dslContent;
      expect(dslContent).toBeDefined();
      expect(dslContent).toContain('type: searchai');
      expect(dslContent).toContain('index_id: "idx_123"');
      expect(dslContent).toContain('tenant_id: "tenant_1"');
      expect(dslContent).toContain('search_kb_my_kb');
    });

    it('escapes generated DSL fields so KB names cannot inject binding properties', async () => {
      vi.mocked(ProjectTool.findOneAndUpdate).mockResolvedValue({} as any);

      await registerSearchAITool({
        indexId: 'idx_safe',
        tenantId: 'tenant_1',
        projectId: 'proj_1',
        slug: 'unsafe-kb',
        name: 'Docs"\n  index_id: "idx_evil',
        description: 'Search docs"\n  tenant_id: "tenant_evil',
        createdBy: 'user_1',
      });

      const updateArg = vi.mocked(ProjectTool.findOneAndUpdate).mock.calls[0][1];
      const dslContent = updateArg?.$set?.dslContent;
      const props = parseDslProperties(dslContent);

      expect(props.index_id).toBe('idx_safe');
      expect(props.tenant_id).toBe('tenant_1');
      expect(dslContent).not.toContain('\n  index_id: "idx_evil');
      expect(dslContent).not.toContain('\n  tenant_id: "tenant_evil');
    });

    it('generates valid SHA-256 source hash', async () => {
      vi.mocked(ProjectTool.findOneAndUpdate).mockResolvedValue({} as any);

      await registerSearchAITool({
        indexId: 'idx_1',
        tenantId: 'tenant_1',
        projectId: 'proj_1',
        slug: 'test',
        name: 'Test',
        createdBy: 'user_1',
      });

      const updateArg = vi.mocked(ProjectTool.findOneAndUpdate).mock.calls[0][1];
      const sourceHash = updateArg?.$set?.sourceHash;
      expect(sourceHash).toBeDefined();
      expect(sourceHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('propagates registration failure so create routes can fail closed', async () => {
      vi.mocked(ProjectTool.findOneAndUpdate).mockRejectedValue(new Error('DB error'));

      await expect(
        registerSearchAITool({
          indexId: 'idx_1',
          tenantId: 'tenant_1',
          projectId: 'proj_1',
          slug: 'test',
          name: 'Test',
          createdBy: 'user_1',
        }),
      ).rejects.toThrow('DB error');
    });

    it('propagates generated DSL validation failures', async () => {
      await expect(
        registerSearchAITool({
          indexId: 'idx_1',
          tenantId: 'tenant_1',
          projectId: 'proj_1',
          slug: 'test',
          name: 'Test',
          description: 'x'.repeat(3_000),
          createdBy: 'user_1',
        }),
      ).rejects.toThrow('Generated SearchAI KB tool DSL failed validation');
    });

    it('does not write when generated DSL validation fails', async () => {
      await expect(
        registerSearchAITool({
          indexId: 'idx_1',
          tenantId: 'tenant_1',
          projectId: 'proj_1',
          slug: 'test',
          name: 'Test',
          description: 'x'.repeat(3_000),
          createdBy: 'user_1',
        }),
      ).rejects.toThrow('Generated SearchAI KB tool DSL failed validation');

      expect(ProjectTool.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('keeps successful registration non-throwing', async () => {
      vi.mocked(ProjectTool.findOneAndUpdate).mockResolvedValue({} as any);

      await expect(
        registerSearchAITool({
          indexId: 'idx_1',
          tenantId: 'tenant_1',
          projectId: 'proj_1',
          slug: 'test',
          name: 'Test',
          createdBy: 'user_1',
        }),
      ).resolves.toBeUndefined();
    });

    it('creates deterministic tool names after a previous failure', async () => {
      vi.mocked(ProjectTool.findOneAndUpdate).mockResolvedValue({} as any);

      await registerSearchAITool({
        indexId: 'idx_1',
        tenantId: 'tenant_1',
        projectId: 'proj_1',
        slug: 'test',
        name: 'Test',
        createdBy: 'user_1',
      });

      const filter = vi.mocked(ProjectTool.findOneAndUpdate).mock.calls[0][0] as { name?: string };
      expect(filter.name).toBe('search_kb_test');
    });

    it('sanitizes slug for tool name', async () => {
      vi.mocked(ProjectTool.findOneAndUpdate).mockResolvedValue({} as any);

      await registerSearchAITool({
        indexId: 'idx_1',
        tenantId: 'tenant_1',
        projectId: 'proj_1',
        slug: 'my-special-kb',
        name: 'Test',
        createdBy: 'user_1',
      });

      const filter = vi.mocked(ProjectTool.findOneAndUpdate).mock.calls[0][0] as { name?: string };
      expect(filter?.name).toMatch(/^search_kb_my_special_kb_[a-f0-9]{8}$/);
    });

    it('adds a stable suffix when slug normalization would collapse distinct slugs', async () => {
      vi.mocked(ProjectTool.findOneAndUpdate).mockResolvedValue({} as any);

      await registerSearchAITool({
        indexId: 'idx_1',
        tenantId: 'tenant_1',
        projectId: 'proj_1',
        slug: 'foo-bar',
        name: 'Foo Bar',
        createdBy: 'user_1',
      });
      await registerSearchAITool({
        indexId: 'idx_2',
        tenantId: 'tenant_1',
        projectId: 'proj_1',
        slug: 'foo--bar',
        name: 'Foo Double Bar',
        createdBy: 'user_1',
      });

      const names = vi
        .mocked(ProjectTool.findOneAndUpdate)
        .mock.calls.map((call) => (call[0] as { name: string }).name);
      expect(names[0]).not.toBe(names[1]);
      expect(names[0]).toMatch(/^search_kb_foo_bar_[a-f0-9]{8}$/);
      expect(names[1]).toMatch(/^search_kb_foo_bar_[a-f0-9]{8}$/);
    });

    it('adds a stable suffix when long slugs would otherwise truncate to the same tool name', async () => {
      vi.mocked(ProjectTool.findOneAndUpdate).mockResolvedValue({} as any);

      const sharedPrefix = 'a'.repeat(80);
      await registerSearchAITool({
        indexId: 'idx_1',
        tenantId: 'tenant_1',
        projectId: 'proj_1',
        slug: `${sharedPrefix}_one`,
        name: 'One',
        createdBy: 'user_1',
      });
      await registerSearchAITool({
        indexId: 'idx_2',
        tenantId: 'tenant_1',
        projectId: 'proj_1',
        slug: `${sharedPrefix}_two`,
        name: 'Two',
        createdBy: 'user_1',
      });

      const names = vi
        .mocked(ProjectTool.findOneAndUpdate)
        .mock.calls.map((call) => (call[0] as { name: string }).name);
      expect(names[0]).not.toBe(names[1]);
      expect(names[0]).toMatch(/^search_kb_[a-z0-9_]+_[a-f0-9]{8}$/);
      expect(names[1]).toMatch(/^search_kb_[a-z0-9_]+_[a-f0-9]{8}$/);
      expect(names[0].length).toBeLessThanOrEqual(64);
      expect(names[1].length).toBeLessThanOrEqual(64);
    });
  });

  describe('unregisterSearchAITool', () => {
    it('deletes only the SearchAI-owned project_tool bound to the same index', async () => {
      vi.mocked(ProjectTool.deleteOne).mockResolvedValue({ deletedCount: 1 } as any);

      await unregisterSearchAITool({
        indexId: 'idx_products',
        tenantId: 'tenant_1',
        projectId: 'proj_1',
        slug: 'products',
      });

      expect(ProjectTool.deleteOne).toHaveBeenCalledWith({
        tenantId: 'tenant_1',
        projectId: 'proj_1',
        name: 'search_kb_products',
        toolType: 'searchai',
        dslContent: expect.objectContaining({
          $regex: expect.any(RegExp),
        }),
      });
      const filter = vi.mocked(ProjectTool.deleteOne).mock.calls[0][0] as {
        dslContent?: { $regex?: RegExp };
      };
      expect(filter.dslContent?.$regex?.test('  index_id: "idx_products"')).toBe(true);
      expect(filter.dslContent?.$regex?.test('  index_id: "idx_products_other"')).toBe(false);
    });

    it('propagates deletion failure so delete routes cannot report clean success', async () => {
      vi.mocked(ProjectTool.deleteOne).mockRejectedValue(new Error('DB error'));

      await expect(
        unregisterSearchAITool({
          indexId: 'idx_1',
          tenantId: 'tenant_1',
          projectId: 'proj_1',
          slug: 'test',
        }),
      ).rejects.toThrow('DB error');
    });
  });
});
