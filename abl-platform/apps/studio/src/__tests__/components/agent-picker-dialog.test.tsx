import { describe, it, expect, vi } from 'vitest';

vi.mock('../../hooks/useImportedSymbols', () => ({
  useImportedSymbols: () => ({
    agents: [
      {
        name: 'weather_agent',
        alias: 'weather',
        moduleProjectName: 'Weather Module',
        dependencyId: 'd1',
      },
    ],
    tools: [],
    hasDependencies: true,
  }),
}));

describe('AgentPickerDialog', () => {
  it('should be importable', async () => {
    const mod = await import('../../components/abl/pickers/AgentPickerDialog');
    expect(mod.AgentPickerDialog).toBeDefined();
  });
});
