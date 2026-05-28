import { describe, expect, test } from 'vitest';

import { parseAgentBasedABL } from '../parser/agent-based-parser.js';

describe('ON_START parser', () => {
  test('parses bullet-list lifecycle directives', () => {
    const result = parseAgentBasedABL(`
AGENT: Welcome_Agent
GOAL: "Welcome the user"

ON_START:
  - RESPOND: "Hi!"
  - SET: session_ready = true
  - CALL: preload_member
  - DELEGATE: Welcome_Helper
`);

    expect(result.errors).toHaveLength(0);
    expect(result.document?.onStart).toEqual({
      respond: 'Hi!',
      set: { session_ready: 'true' },
      call: 'preload_member',
      callSpec: { tool: 'preload_member' },
      delegate: 'Welcome_Helper',
    });
  });

  test('parses ON_START CALL WITH and AS into the canonical invocation shape', () => {
    const result = parseAgentBasedABL(`
AGENT: Welcome_Agent
GOAL: "Welcome the user"

ON_START:
  CALL: preload_member
    WITH:
      memberId: session.member_id
      includeHistory: true
    AS: memberProfile
`);

    expect(result.errors).toHaveLength(0);
    expect(result.document?.onStart).toMatchObject({
      call: 'preload_member',
      callSpec: {
        tool: 'preload_member',
        with: {
          memberId: 'session.member_id',
          includeHistory: 'true',
        },
        as: 'memberProfile',
      },
    });
  });
});
