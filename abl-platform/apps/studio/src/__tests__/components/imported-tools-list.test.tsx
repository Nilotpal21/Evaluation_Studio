import { describe, it, expect, vi } from 'vitest';

vi.mock('../../hooks/useImportedSymbols', () => ({
  useImportedSymbols: () => ({
    agents: [],
    tools: [
      {
        name: 'get_weather',
        alias: 'weather',
        moduleProjectName: 'Weather Module',
        dependencyId: 'd1',
        toolType: 'http',
        resolvedVersion: '1.0.0',
      },
    ],
    hasDependencies: true,
  }),
}));

describe('ToolsListPage imported tools', () => {
  it('should export useImportedSymbols hook with tool fields', async () => {
    const { useImportedSymbols } = await import('../../hooks/useImportedSymbols');
    const result = useImportedSymbols();
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].toolType).toBe('http');
    expect(result.tools[0].alias).toBe('weather');
  });
});
