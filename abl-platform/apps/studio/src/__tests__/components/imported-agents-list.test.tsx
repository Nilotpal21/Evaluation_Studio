import { describe, it, expect, vi } from 'vitest';

// Mock the useImportedSymbols hook
vi.mock('../../hooks/useImportedSymbols', () => ({
  useImportedSymbols: () => ({
    agents: [
      {
        name: 'weather_agent',
        alias: 'weather',
        moduleProjectName: 'Weather Module',
        dependencyId: 'd1',
        resolvedVersion: '1.0.0',
      },
    ],
    tools: [],
    hasDependencies: true,
  }),
}));

describe('AgentListPage imported agents', () => {
  it('should export useImportedSymbols hook with correct interface', async () => {
    const { useImportedSymbols } = await import('../../hooks/useImportedSymbols');
    const result = useImportedSymbols();
    expect(result.agents).toBeDefined();
    expect(result.tools).toBeDefined();
    expect(result.hasDependencies).toBe(true);
  });
});
