import { describe, it, expect } from 'vitest';
import { parseAgentBasedABL } from '../../parser/agent-based-parser.js';

describe('CALL result block parser', () => {
  it('parses simple ON_SUCCESS and ON_FAIL SET assignments', () => {
    const input = `AGENT: Call_Result_Set_Test
GOAL: Test

TOOLS:
  verify_user(token: string) -> object

FLOW:
  entry_point: verify
  steps:
    - verify

verify:
  REASONING: false
  CALL: verify_user(token)
  ON_SUCCESS:
    SET: user.status.authenticated = true
    RESPOND: "Verified!"
    THEN: COMPLETE
  ON_FAIL:
    SET:
      user.status.failure_code = "VERIFY_FAILED"
    RESPOND: "Verification failed."
    THEN: COMPLETE
`;

    const result = parseAgentBasedABL(input);
    expect(result.errors).toHaveLength(0);

    const step = result.document?.flow?.definitions.verify;
    expect(step?.onSuccess?.set).toEqual({ 'user.status.authenticated': 'true' });
    expect(step?.onFailure?.set).toEqual({ 'user.status.failure_code': 'VERIFY_FAILED' });
  });
});
