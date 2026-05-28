import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { InMemoryFactStore } from '@abl/compiler/platform/stores/fact-store.js';
import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor.js';
import type { AgentIR } from '@abl/compiler';
import type { RuntimeSession } from '../../services/execution/types.js';

function attachRememberMemory(session: RuntimeSession) {
  if (!session.agentIR) {
    throw new Error('Expected compiled agent IR on session');
  }

  session.agentIR = {
    ...session.agentIR,
    execution: {
      ...session.agentIR.execution,
      pipeline: {
        ...session.agentIR.execution?.pipeline,
        enabled: false,
      },
    },
    memory: {
      session: [],
      persistent: [
        {
          path: 'user.remembered_flag',
          scope: 'user',
          access: 'readwrite',
        },
      ],
      remember: [
        {
          when: 'remembered_flag IS SET',
          store: {
            value: 'remembered_flag',
            target: 'user.remembered_flag',
          },
        },
      ],
      recall: [],
    },
  } as AgentIR;
}

function attachFactStore(session: RuntimeSession) {
  const factStore = new InMemoryFactStore({ type: 'memory' });
  const setSpy = vi.spyOn(factStore, 'set');
  session.factStore = factStore;
  session.tenantId = 'tenant-1';
  session.projectId = 'project-1';
  session.userId = 'user-1';
  session.callerContext = {
    customerId: 'user-1',
    tenantId: 'tenant-1',
    channel: 'test',
    initiatedById: 'user-1',
  };
  return { factStore, setSpy };
}

describe('flow SET -> REMEMBER regressions', () => {
  let executor: RuntimeExecutor;
  const factStores: InMemoryFactStore[] = [];

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  afterEach(() => {
    for (const store of factStores.splice(0)) {
      store.stop();
    }
  });

  test('ON_START SET batches trigger REMEMBER once', async () => {
    const dsl = `
AGENT: OnStart_Remember_Test

GOAL: "Test ON_START remember"

ON_START:
  set: remembered_flag = ready
  set: remembered_note = booted

FLOW:
  entry_point: done
  steps:
    - done

done:
  REASONING: false
  RESPOND: "Ready"
  THEN: COMPLETE
`;
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'OnStart_Remember_Test'),
    );
    attachRememberMemory(session);
    const { factStore, setSpy } = attachFactStore(session);
    factStores.push(factStore);

    await executor.initializeSession(session.id);

    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'user.remembered_flag', value: 'ready' }),
    );
  });

  test('ON_INPUT SET batches trigger REMEMBER once', async () => {
    const dsl = `
AGENT: OnInput_Remember_Test

GOAL: "Test ON_INPUT remember"

FLOW:
  entry_point: collect
  steps:
    - collect
    - done

collect:
  REASONING: false
  GATHER:
    - choice: required
  ON_INPUT:
    - IF: input contains "vip"
      SET: remembered_flag = gold
      SET: remembered_note = priority
      THEN: done

done:
  REASONING: false
  RESPOND: "Done"
  THEN: COMPLETE
`;
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'OnInput_Remember_Test'),
    );
    attachRememberMemory(session);
    const { factStore, setSpy } = attachFactStore(session);
    factStores.push(factStore);
    await executor.initializeSession(session.id);
    setSpy.mockClear();

    await executor.executeMessage(session.id, 'vip choice');

    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'user.remembered_flag', value: 'gold' }),
    );
  });

  test('step-entry SET batches trigger REMEMBER once', async () => {
    const dsl = `
AGENT: StepSet_Remember_Test

GOAL: "Test step-entry SET remember"

FLOW:
  entry_point: ready
  steps:
    - ready

ready:
  REASONING: false
  SET: remembered_flag = step_ready
  SET: remembered_note = entered_once
  RESPOND: "Ready"
  THEN: COMPLETE
`;
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'StepSet_Remember_Test'),
    );
    attachRememberMemory(session);
    const { factStore, setSpy } = attachFactStore(session);
    factStores.push(factStore);
    await executor.initializeSession(session.id);

    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'user.remembered_flag', value: 'step_ready' }),
    );
  });

  test('navigation SET batches trigger REMEMBER once', async () => {
    const dsl = `
AGENT: Navigation_Remember_Test

GOAL: "Test navigation remember"

FLOW:
  entry_point: collect
  steps:
    - collect
    - previous

collect:
  REASONING: false
  GATHER:
    - amount:
        type: number
        required: true
  ON_INPUT:
    - IF: input contains "back"
      SET: remembered_flag = rewound
      SET: remembered_note = navigation
      THEN: previous

previous:
  REASONING: false
  RESPOND: "Moved back"
  THEN: COMPLETE
`;
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Navigation_Remember_Test'),
    );
    attachRememberMemory(session);
    const { factStore, setSpy } = attachFactStore(session);
    factStores.push(factStore);
    await executor.initializeSession(session.id);
    setSpy.mockClear();

    await executor.executeMessage(session.id, 'back please');

    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'user.remembered_flag', value: 'rewound' }),
    );
  });

  test('ACTION handler SET batches trigger REMEMBER once', async () => {
    const dsl = `
AGENT: Action_Remember_Test

GOAL: "Test action handler remember"

FLOW:
  entry_point: ask
  steps:
    - ask
    - done

ask:
  REASONING: false
  RESPOND: "Choose"
    ACTIONS:
      - BUTTON: "Go" -> go_now
  ON_ACTION:
    go_now:
      SET: remembered_flag = selected
      SET: remembered_note = action
      TRANSITION: done

done:
  REASONING: false
  RESPOND: "Done"
  THEN: COMPLETE
`;
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Action_Remember_Test'),
    );
    attachRememberMemory(session);
    const { factStore, setSpy } = attachFactStore(session);
    factStores.push(factStore);
    await executor.initializeSession(session.id);
    setSpy.mockClear();

    await executor.executeMessage(session.id, '', undefined, undefined, {
      actionEvent: { actionId: 'go_now' },
    });

    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'user.remembered_flag', value: 'selected' }),
    );
  });
});
