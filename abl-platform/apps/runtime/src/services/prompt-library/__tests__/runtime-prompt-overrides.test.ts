import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetVersion = vi.fn();
const mockRenderPromptTemplate = vi.fn();

vi.mock('../prompt-library-service.js', () => ({
  getPromptLibraryService: () => ({
    getVersion: (...args: unknown[]) => mockGetVersion(...args),
  }),
}));

vi.mock('../template-renderer.js', () => ({
  renderPromptTemplate: (...args: unknown[]) => mockRenderPromptTemplate(...args),
}));

describe('resolveRuntimePromptOverride', () => {
  beforeEach(() => {
    mockGetVersion.mockReset();
    mockRenderPromptTemplate.mockReset();
  });

  it('returns null for archived prompt versions', async () => {
    const { resolveRuntimePromptOverride } = await import('../runtime-prompt-overrides.js');
    mockGetVersion.mockResolvedValue({
      _id: 'version-1',
      promptId: 'prompt-1',
      template: 'Hello {{name}}',
      status: 'archived',
    });

    const result = await resolveRuntimePromptOverride(
      { promptId: 'prompt-1', versionId: 'version-1' },
      { tenantId: 'tenant-1', projectId: 'project-1' },
      { name: 'Ada' },
    );

    expect(result).toBeNull();
    expect(mockRenderPromptTemplate).not.toHaveBeenCalled();
  });

  it('renders active prompt versions', async () => {
    const { resolveRuntimePromptOverride } = await import('../runtime-prompt-overrides.js');
    mockGetVersion.mockResolvedValue({
      _id: 'version-2',
      promptId: 'prompt-1',
      template: 'Hello {{name}}',
      status: 'active',
    });
    mockRenderPromptTemplate.mockReturnValue('Hello Ada');

    const result = await resolveRuntimePromptOverride(
      { promptId: 'prompt-1', versionId: 'version-2' },
      { tenantId: 'tenant-1', projectId: 'project-1' },
      { name: 'Ada' },
    );

    expect(result).toBe('Hello Ada');
    expect(mockRenderPromptTemplate).toHaveBeenCalledWith('Hello {{name}}', { name: 'Ada' });
  });
});
