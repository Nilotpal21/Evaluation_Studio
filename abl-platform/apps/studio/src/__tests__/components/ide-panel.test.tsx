import { beforeEach, describe, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDEPanel } from '@/lib/arch-ai/components/arch/panels/IDEPanel';
import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';

describe('IDEPanel resume restore behavior', () => {
  beforeEach(() => {
    useArchAIStore.getState().reset();
  });

  test('creates an agent_code tab when a resumed agent file is clicked', async () => {
    const user = userEvent.setup();
    useArchAIStore
      .getState()
      .addFile(
        'ServiceTriage',
        ['SUPERVISOR: ServiceTriage', 'GUARDRAILS:', '  - Keep routing safe'].join('\n'),
      );

    render(<IDEPanel />);

    await user.click(screen.getByRole('button', { name: 'ServiceTriage.abl.yaml' }));

    const state = useArchAIStore.getState();
    expect(state.artifactTabs).toHaveLength(1);
    expect(state.artifactTabs[0]).toMatchObject({
      type: 'agent_code',
      label: 'ServiceTriage',
      data: {
        name: 'ServiceTriage',
        content: ['SUPERVISOR: ServiceTriage', 'GUARDRAILS:', '  - Keep routing safe'].join('\n'),
      },
    });
    expect(state.activeTabId).toBe(state.artifactTabs[0].id);
  });

  test('creates a mock file tab with isMock metadata when a resumed mock file is clicked', async () => {
    const user = userEvent.setup();
    useArchAIStore.getState().addFile('mock:server.ts', 'export const server = true;', {
      fileType: 'mock',
      displayName: 'mock/server.ts',
    });

    render(<IDEPanel />);

    await user.click(screen.getByRole('button', { name: 'mock/server.ts' }));

    const state = useArchAIStore.getState();
    expect(state.artifactTabs).toHaveLength(1);
    expect(state.artifactTabs[0]).toMatchObject({
      type: 'agent_code',
      label: 'mock/server.ts',
      data: {
        name: 'mock/server.ts',
        content: 'export const server = true;',
        isMock: true,
      },
    });
  });
});
