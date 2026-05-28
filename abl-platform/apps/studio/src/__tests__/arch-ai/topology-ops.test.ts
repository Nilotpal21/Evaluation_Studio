import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../lib/arch-ai/guards', () => ({
  checkToolPermission: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock('@/services/project-service', () => ({
  getProjectAgents: vi.fn(),
}));

import { executeTopologyOps } from '../../lib/arch-ai/tools/topology-ops';
import { getProjectAgents } from '@/services/project-service';

describe('topology-ops', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes action-handler routing edges in read topology results', async () => {
    vi.mocked(getProjectAgents).mockResolvedValue([
      {
        name: 'RouterAgent',
        description: 'Routes via action handlers',
        dslContent: `AGENT: RouterAgent
GOAL: "Handle action-based routing"

FLOW:
  entry_point: choose
  steps:
    - choose

choose:
  REASONING: false
  RESPOND: "Choose a route"
    ACTIONS:
      - BUTTON: "Delegate" -> delegate_btn
  ON_ACTION:
    delegate_btn:
      DO:
        - DELEGATE: StepDelegate
          RETURN: true

ACTION_HANDLERS:
  escalate_btn:
    DO:
      - HANDOFF: GlobalEscalation`,
      },
    ] as never);

    const result = await executeTopologyOps(
      { action: 'read' },
      {
        projectId: 'proj-1',
        user: {
          permissions: ['agent:read'],
          tenantId: 'tenant-1',
          userId: 'user-1',
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      edges: expect.arrayContaining([
        { from: 'RouterAgent', to: 'StepDelegate', type: 'delegate' },
        { from: 'RouterAgent', to: 'GlobalEscalation', type: 'handoff' },
      ]),
    });
  });
});
