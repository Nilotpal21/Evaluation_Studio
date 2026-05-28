import { describe, expect, it } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { DEFAULT_SESSION_TIMEOUT_MS } from '../../platform/constants.js';
import { compileABLtoIR } from '../../platform/ir/compiler.js';

function compileAgent(dsl: string, agentName: string) {
  const parseResult = parseAgentBasedABL(dsl);
  expect(parseResult.document).toBeDefined();
  expect(parseResult.errors).toHaveLength(0);

  const output = compileABLtoIR([parseResult.document!]);
  const agent = output.agents[agentName];

  expect(agent).toBeDefined();
  return agent;
}

describe('session lifecycle IR normalization', () => {
  it('normalizes session_idle_timeout into execution.sessionLifecycle while preserving legacy timeout fields', () => {
    const agent = compileAgent(
      `
AGENT: TimeoutAgent
GOAL: "Handle support conversations"
EXECUTION:
  session_idle_timeout: 125000
`,
      'TimeoutAgent',
    );

    expect(agent.execution.timeouts.session_timeout_ms).toBe(125000);
    expect(agent.execution.sessionLifecycle).toEqual({
      idleSeconds: 125,
    });
  });

  it('keeps sessionLifecycle undefined when no explicit agent override is configured', () => {
    const agent = compileAgent(
      `
AGENT: DefaultAgent
GOAL: "Handle support conversations"
`,
      'DefaultAgent',
    );

    expect(agent.execution.timeouts.session_timeout_ms).toBe(DEFAULT_SESSION_TIMEOUT_MS);
    expect(agent.execution.sessionLifecycle).toBeUndefined();
  });
});
