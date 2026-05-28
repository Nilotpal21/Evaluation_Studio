import { describe, expect, test } from 'vitest';
import { buildAgentDetails } from '../services/dsl-utils.js';

const POLICY_AGENT_DSL = `AGENT: Policy_Agent
GOAL: "Validate expression parsing through runtime compilation"

CONSTRAINTS:
  always:
    - REQUIRE message.title == "A OR B" AND ticket.status == "ready AND waiting"
      ON_FAIL: "Need the ready title."
    - RESTRICT user.role NOT IN ["admin", "moderator"]
      ON_FAIL: "Restricted role."
`;

describe('dsl-utils expression parser integration', () => {
  test('builds compiled IR that preserves NOT IN and quoted logical tokens', () => {
    const details = buildAgentDetails(POLICY_AGENT_DSL, 'Policy_Agent');

    expect(details).not.toBeNull();
    expect(details?.name).toBe('Policy_Agent');
    expect(details?.ir).toMatchObject({
      constraints: {
        constraints: [
          {
            kind: 'require',
            condition:
              '(message.title IS NOT SET AND ticket.status IS NOT SET) OR (message.title == "A OR B" AND ticket.status == "ready AND waiting")',
          },
          {
            kind: 'restrict',
            condition: 'user.role IS NOT SET OR NOT (user.role NOT IN ["admin", "moderator"])',
          },
        ],
      },
    });
  });

  test('keeps runtime identity on the persisted record name when DSL declares a stale name', () => {
    const details = buildAgentDetails(
      'AGENT: stale_declared_name\nGOAL: "Legacy split identity"',
      'booking_agent',
    );

    expect(details).not.toBeNull();
    expect(details?.id).toBe('booking_agent');
    expect(details?.name).toBe('booking_agent');
    expect(details?.declaredName).toBe('stale_declared_name');
  });
});
