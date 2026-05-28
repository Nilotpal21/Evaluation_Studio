import { describe, expect, it } from 'vitest';

import { validateCrossAgent } from '@/lib/arch-ai/cross-agent-validator';

const ROUTER_WITH_MISSING_ACTION_HANDLER_ROUTE = `AGENT: RouterAgent
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
        - DELEGATE: MissingAgent
          RETURN: true
`;

describe('cross-agent-validator routing parity', () => {
  it('flags missing action-handler routing targets', () => {
    const result = validateCrossAgent(
      {
        nodes: [
          {
            id: 'RouterAgent',
            name: 'RouterAgent',
            type: 'agent',
            isEntry: true,
          },
        ],
        edges: [],
      },
      [
        {
          name: 'RouterAgent',
          ablContent: ROUTER_WITH_MISSING_ACTION_HANDLER_ROUTE,
          constructsUsed: ['FLOW', 'ON_ACTION'],
        },
      ],
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetAgent: 'MissingAgent',
          message: expect.stringContaining('MissingAgent'),
        }),
      ]),
    );
  });
});
