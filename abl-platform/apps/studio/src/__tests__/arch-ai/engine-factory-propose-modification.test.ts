import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { buildV1CoreRefsMock, proposeModificationMock } = vi.hoisted(() => ({
  buildV1CoreRefsMock: vi.fn(),
  proposeModificationMock: vi.fn(),
}));

vi.mock('@/lib/arch-ai/compat/v1-core-refs', () => ({
  buildV1CoreRefs: buildV1CoreRefsMock,
}));

import { buildOnboardingToolRegistry } from '@/lib/arch-ai/engine-factory';

describe('buildOnboardingToolRegistry propose_modification', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    proposeModificationMock.mockResolvedValue({
      success: true,
      proposal: { agentName: 'LeadIntake', reviewStatus: 'pending' },
    });
    buildV1CoreRefsMock.mockResolvedValue({
      proposeModification: proposeModificationMock,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delegates the live registry tool to the compat v4 proposal implementation', async () => {
    const registry = buildOnboardingToolRegistry();
    const tool = registry.get('propose_modification');

    expect(tool?.kind).toBe('internal');
    expect(tool?.execute).toBeTypeOf('function');

    const ctx = {
      sessionId: 'session-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      projectId: 'project-1',
      signal: new AbortController().signal,
      emit: vi.fn(),
      services: {
        permissions: ['agent:write'],
        authToken: 'token-123',
      },
    };

    const input = {
      agentName: 'LeadIntake',
      change: 'Qualify leads and sound more professional',
      sections: [
        {
          construct: 'PERSONA',
          content: 'PERSONA: |\n  Be friendly and professional.',
        },
      ],
    };

    await expect(tool!.execute!(input, ctx)).resolves.toEqual({
      success: true,
      proposal: { agentName: 'LeadIntake', reviewStatus: 'pending' },
    });

    expect(buildV1CoreRefsMock).toHaveBeenCalledOnce();
    expect(proposeModificationMock).toHaveBeenCalledWith(ctx, 'project-1', input);
  });
});
