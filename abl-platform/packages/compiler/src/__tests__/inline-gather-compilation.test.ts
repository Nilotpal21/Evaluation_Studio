import { describe, test, expect } from 'vitest';
import { compileABLtoIR } from '../platform/ir/compiler.js';
import { parseAgentBasedABL } from '@abl/core';

function compileAgent(dsl: string, agentName: string) {
  const parseResult = parseAgentBasedABL(dsl);
  expect(parseResult.document).toBeDefined();
  expect(parseResult.errors).toHaveLength(0);
  const output = compileABLtoIR([parseResult.document!]);
  const agent = output.agents[agentName];
  expect(agent).toBeDefined();
  return agent;
}

describe('inline_gather compilation', () => {
  test('EXECUTION.inline_gather: true sets flag in IR', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
EXECUTION:
  inline_gather: true
GATHER:
  - name: city
    type: string
    prompt: "What city?"
    required: true
`;
    const agent = compileAgent(dsl, 'TestAgent');
    expect(agent.execution.inline_gather).toBe(true);
  });

  test('inline_gather defaults to undefined when not specified', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
GATHER:
  - name: city
    type: string
    prompt: "What city?"
    required: true
`;
    const agent = compileAgent(dsl, 'TestAgent');
    expect(agent.execution.inline_gather).toBeUndefined();
  });

  test('inline_gather: true without GATHER fields is allowed (no-op)', () => {
    const dsl = `
AGENT: TestAgent
GOAL: "Test agent"
EXECUTION:
  inline_gather: true
`;
    const agent = compileAgent(dsl, 'TestAgent');
    expect(agent.execution.inline_gather).toBe(true);
  });
});
