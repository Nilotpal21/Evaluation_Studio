import { describe, test, expect, beforeEach } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../services/runtime-executor';

describe('YAML Style Flow', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  test('should parse and execute YAML-style flow with steps list', async () => {
    const dsl = `
AGENT: Yaml_Flow_Test

GOAL: "Test YAML style flow"

FLOW:
  steps:
    - welcome
    - get_name
    - greet

  welcome:
    REASONING: false
    RESPOND: |
      Welcome to the test!
      This is a multiline welcome message.
    THEN: get_name

  get_name:
    REASONING: false
    GATHER:
      - name: required
    THEN: greet

  greet:
    REASONING: false
    RESPOND: "Hello, {{name}}!"
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Yaml_Flow_Test'),
    );

    console.log('Flow entry_point:', session.agentIR?.flow?.entry_point);
    console.log('Flow steps:', session.agentIR?.flow?.steps);
    console.log(
      'Welcome respond:',
      session.agentIR?.flow?.definitions['welcome']?.respond?.substring(0, 50),
    );

    const chunks: string[] = [];
    const result = await executor.initializeSession(session.id, (c) => chunks.push(c));

    const fullOutput = chunks.join('');
    console.log('Full output:', fullOutput);

    expect(fullOutput).toContain('Welcome to the test!');
    // GATHER block auto-generates a prompt for the required fields
    expect(fullOutput).toContain('name');
    expect(session.currentFlowStep).toBe('get_name');
    expect(session.waitingForInput).toEqual(['name']);
  });
});
