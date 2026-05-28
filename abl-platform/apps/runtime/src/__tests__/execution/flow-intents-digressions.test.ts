/**
 * Flow Intents & Digressions Tests
 *
 * Tests for global digressions, step-level digressions, and sub-intents.
 * These features detect user intent during flow execution and handle
 * out-of-flow requests without losing the main flow context.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { InMemoryFactStore } from '@abl/compiler/platform/stores/fact-store.js';
import type { AgentIR } from '@abl/compiler';
import { isGatherInterruptTrace, type GatherInterruptTrace } from '@agent-platform/shared-kernel';
import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor';
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

function extractGatherInterruptTrace(data: Record<string, unknown>): GatherInterruptTrace {
  return {
    detectionMode: data.detectionMode as GatherInterruptTrace['detectionMode'],
    candidateSurface: data.candidateSurface as GatherInterruptTrace['candidateSurface'],
    ...(typeof data.lexicalMatchType === 'string'
      ? {
          lexicalMatchType: data.lexicalMatchType as GatherInterruptTrace['lexicalMatchType'],
        }
      : {}),
    ...(typeof data.policyApplied === 'string'
      ? { policyApplied: data.policyApplied as GatherInterruptTrace['policyApplied'] }
      : {}),
    ...(typeof data.classifierConfidence === 'number'
      ? { classifierConfidence: data.classifierConfidence }
      : {}),
  };
}

describe('Flow Intents & Digressions', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  // ===========================================================================
  // GLOBAL DIGRESSIONS
  // ===========================================================================

  describe('Global digressions', () => {
    test('Digression with GOTO navigates to target step', async () => {
      const dsl = `
AGENT: Digression_Goto_Test

GOAL: "Test digression GOTO"

FLOW:
  entry_point: collect_name
  steps:
    - collect_name
    - confirm
    - cancelled

  global_digressions:
    REASONING: false
    - INTENT: cancel_request
      KEYWORDS: [cancel]
      RESPOND: "Booking cancelled."
      GOTO: cancelled

collect_name:
  GATHER:
    - name: required
  THEN: confirm

confirm:
  RESPOND: "Thanks {{name}}!"
  THEN: COMPLETE

cancelled:
  RESPOND: "Session cancelled. Goodbye!"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Digression_Goto_Test'),
      );
      await executor.initializeSession(session.id);

      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'I want to cancel', (c) => chunks.push(c));

      const output = chunks.join('');
      expect(output).toContain('Booking cancelled');
      expect(output).toContain('Session cancelled. Goodbye!');
      expect(session.isComplete).toBe(true);
    });

    test('Digression with RESPOND only (no GOTO) returns response', async () => {
      const dsl = `
AGENT: Digression_Respond_Test

GOAL: "Test digression respond-only"

FLOW:
  entry_point: collect
  steps:
    - collect

  global_digressions:
    REASONING: false
    - INTENT: help_request
      KEYWORDS: [help]
      RESPOND: "Available commands: book, cancel, help"

collect:
  GATHER:
    - choice: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Digression_Respond_Test'),
      );
      await executor.initializeSession(session.id);

      const chunks: string[] = [];
      const result = await executor.executeMessage(session.id, 'help please', (c) =>
        chunks.push(c),
      );

      expect(chunks.join('')).toContain('Available commands');
      expect(result.action?.type).toBe('digression');
    });

    test('Digression SET batches trigger REMEMBER once', async () => {
      const dsl = `
AGENT: Digression_Remember_Test

GOAL: "Test digression remember"

FLOW:
  entry_point: collect
  steps:
    - collect

  global_digressions:
    REASONING: false
    - INTENT: help_request
      KEYWORDS: [help]
      RESPOND: "Available commands: book, cancel, help"
      RESUME: true

collect:
  GATHER:
    - choice: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Digression_Remember_Test'),
      );
      attachRememberMemory(session);
      const digression = session.agentIR?.flow?.global_digressions?.[0];
      if (digression) {
        digression.do = [
          {
            set: {
              remembered_flag: 'gold',
              remembered_note: 'priority',
            },
          },
          {
            respond: 'Available commands: book, cancel, help',
          },
          {
            resume: true,
          },
        ];
      }

      const { factStore, setSpy } = attachFactStore(session);

      try {
        await executor.initializeSession(session.id);
        setSpy.mockClear();

        const chunks: string[] = [];
        await executor.executeMessage(session.id, 'help please', (c) => chunks.push(c));

        expect(chunks.join('')).toContain('Available commands');
        expect(session.data.values.remembered_flag).toBe('gold');
        expect(setSpy).toHaveBeenCalledTimes(1);
        expect(setSpy).toHaveBeenCalledWith(
          expect.objectContaining({ key: 'user.remembered_flag', value: 'gold' }),
        );
      } finally {
        factStore.stop();
      }
    });

    test('Digression with RESUME re-executes current step', async () => {
      const dsl = `
AGENT: Digression_Resume_Test

GOAL: "Test digression resume"

FLOW:
  entry_point: collect
  steps:
    - collect

  global_digressions:
    REASONING: false
    - INTENT: help_request
      KEYWORDS: [help]
      RESPOND: "Just enter your name."
      RESUME: true

collect:
  GATHER:
    - name: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Digression_Resume_Test'),
      );
      await executor.initializeSession(session.id);

      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'help', (c) => chunks.push(c));

      const output = chunks.join('');
      expect(output).toContain('Just enter your name');
      // Should still be on collect step (resumed)
      expect(session.currentFlowStep).toBe('collect');
      expect(session.isComplete).not.toBe(true);
    });

    test('Digression emits trace event', async () => {
      const dsl = `
AGENT: Digression_Trace_Test

GOAL: "Test digression traces"

FLOW:
  entry_point: step1
  steps:
    - step1

  global_digressions:
    REASONING: false
    - INTENT: quit_request
      KEYWORDS: [quit]
      RESPOND: "Quitting"

step1:
  GATHER:
    - value: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Digression_Trace_Test'),
      );
      await executor.initializeSession(session.id);

      const traces: Array<{ type: string; data: Record<string, unknown> }> = [];
      await executor.executeMessage(session.id, 'quit now', undefined, (e) => traces.push(e));

      const digressionTrace = traces.find((t) => t.type === 'digression');
      expect(digressionTrace).toBeDefined();
      expect(digressionTrace!.data.intent).toBe('quit_request');
      expect(digressionTrace!.data.action).toBe('respond');

      const gatherTrace = extractGatherInterruptTrace(digressionTrace!.data);
      expect(isGatherInterruptTrace(gatherTrace)).toBe(true);
      expect(gatherTrace).toMatchObject({
        detectionMode: 'lexical',
        lexicalMatchType: 'exact',
        policyApplied: 'when_unavailable',
        candidateSurface: {
          kind: 'digression',
          size: 1,
          candidates: ['quit_request'],
        },
      });
    });

    test('No digression match → normal flow continues', async () => {
      const dsl = `
AGENT: No_Digression_Test

GOAL: "Test no digression match"

FLOW:
  entry_point: collect
  steps:
    - collect

  global_digressions:
    REASONING: false
    - INTENT: cancel_request
      KEYWORDS: [cancel]
      RESPOND: "Cancelled"
      GOTO: collect

collect:
  GATHER:
    - name: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'No_Digression_Test'),
      );
      await executor.initializeSession(session.id);

      // "Alice" doesn't match "cancel" digression → normal collection
      await executor.executeMessage(session.id, 'Alice');
      expect(session.data.values.name).toBeDefined();
      expect(session.isComplete).toBe(true);
    });

    test('Digression with CLEAR removes specified fields', async () => {
      const dsl = `
AGENT: Digression_Clear_Test

GOAL: "Test digression CLEAR"

FLOW:
  entry_point: collect
  steps:
    - collect
    - start_over

  global_digressions:
    REASONING: false
    - INTENT: restart_request
      KEYWORDS: [start over]
      RESPOND: "Starting fresh!"
      CLEAR: [name, destination]
      GOTO: start_over

collect:
  GATHER:
    - name: required
  THEN: COMPLETE

start_over:
  RESPOND: "Clean slate"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Digression_Clear_Test'),
      );
      await executor.initializeSession(session.id);
      // Set values AFTER init so GATHER doesn't auto-complete
      session.data.values.name = 'Alice';
      session.data.values.destination = 'Paris';

      await executor.executeMessage(session.id, 'start over please');

      // CLEAR should have removed these
      expect(session.data.values.name).toBeUndefined();
      expect(session.data.values.destination).toBeUndefined();
    });

    test('Global digression CONDITION blocks lexical fallback when the gate fails', async () => {
      const dsl = `
AGENT: Digression_Global_Condition_Test

GOAL: "Test global digression condition"

FLOW:
  entry_point: collect
  steps:
    - collect

  global_digressions:
    REASONING: false
    - INTENT: help_request
      KEYWORDS: [help]
      CONDITION: support_mode == "enabled"
      RESPOND: "Support is available."

collect:
  GATHER:
    - name: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Digression_Global_Condition_Test'),
      );
      await executor.initializeSession(session.id);
      session.data.values.support_mode = 'disabled';

      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'help please', (c) => chunks.push(c));

      expect(chunks.join('')).not.toContain('Support is available.');
      expect(session.data.values.name).toBeDefined();
      expect(session.isComplete).toBe(true);
    });
  });

  describe('Step digressions', () => {
    test('Step digression KEYWORDS trigger within the active step', async () => {
      const dsl = `
AGENT: Step_Digression_Keywords_Test

GOAL: "Test step digression keywords"

FLOW:
  entry_point: collect
  steps:
    - collect

collect:
  REASONING: false
  GATHER:
    - destination: required
  DIGRESSIONS:
    - INTENT: pricing_breakdown
      KEYWORDS: [price breakdown]
      RESPOND: "I can explain the price breakdown."
      RESUME: true
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Step_Digression_Keywords_Test'),
      );
      await executor.initializeSession(session.id);

      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'can you give me a price breakdown?', (c) =>
        chunks.push(c),
      );

      expect(chunks.join('')).toContain('price breakdown');
      expect(session.currentFlowStep).toBe('collect');
      expect(session.isComplete).not.toBe(true);
    });

    test('Step digression lexical fallback matches plural keyword variants within gather', async () => {
      const dsl = `
AGENT: Step_Digression_Plural_Keywords_Test

GOAL: "Test step digression lexical variants"

FLOW:
  entry_point: collect
  steps:
    - collect

collect:
  REASONING: false
  GATHER:
    - destination: required
  DIGRESSIONS:
    - INTENT: branch_locator
      KEYWORDS: [branch]
      RESPOND: "I can help find branches nearby."
      RESUME: true
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Step_Digression_Plural_Keywords_Test'),
      );
      await executor.initializeSession(session.id);

      const chunks: string[] = [];
      const traces: Array<{ type: string; data: Record<string, unknown> }> = [];
      await executor.executeMessage(
        session.id,
        'show me nearby branches',
        (c) => chunks.push(c),
        (event) => traces.push(event),
      );

      expect(chunks.join('')).toContain('find branches nearby');
      expect(session.currentFlowStep).toBe('collect');
      expect(session.isComplete).not.toBe(true);
      const digressionTrace = traces.find((trace) => trace.type === 'digression');
      expect(digressionTrace).toBeDefined();
      expect(digressionTrace?.data.intent).toBe('branch_locator');
      expect(digressionTrace?.data.matched).toBe('branch');

      const gatherTrace = extractGatherInterruptTrace(digressionTrace!.data);
      expect(isGatherInterruptTrace(gatherTrace)).toBe(true);
      expect(gatherTrace).toMatchObject({
        detectionMode: 'lexical',
        lexicalMatchType: 'normalized',
        policyApplied: 'when_unavailable',
        candidateSurface: {
          kind: 'digression',
          size: 1,
          candidates: ['branch_locator'],
        },
      });
    });

    test('Step digression CONDITION blocks lexical fallback when the gate fails', async () => {
      const dsl = `
AGENT: Step_Digression_Condition_Test

GOAL: "Test step digression condition"

FLOW:
  entry_point: collect
  steps:
    - collect

collect:
  REASONING: false
  GATHER:
    - destination: required
  DIGRESSIONS:
    - INTENT: pricing_breakdown
      KEYWORDS: [price breakdown]
      CONDITION: can_interrupt == true
      RESPOND: "Here is the price breakdown."
      RESUME: true
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Step_Digression_Condition_Test'),
      );
      await executor.initializeSession(session.id);
      session.data.values.can_interrupt = false;

      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'price breakdown please', (c) => chunks.push(c));

      expect(chunks.join('')).not.toContain('price breakdown');
      expect(session.data.values.destination).toBeDefined();
      expect(session.isComplete).toBe(true);
    });

    test('legacy duplicate digression labels prefer the step-local match and emit a warning trace', async () => {
      const dsl = `
AGENT: Legacy_Duplicate_Digression_Test

GOAL: "Test legacy duplicate digressions"

FLOW:
  entry_point: collect
  steps:
    - collect

  global_digressions:
    REASONING: false
    - INTENT: global_help
      KEYWORDS: [help]
      RESPOND: "Global help response"

collect:
  REASONING: false
  GATHER:
    - destination: required
  DIGRESSIONS:
    - INTENT: step_help
      KEYWORDS: [help]
      RESPOND: "Step help response"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Legacy_Duplicate_Digression_Test'),
      );
      await executor.initializeSession(session.id);

      session.agentIR!.flow!.global_digressions![0].intent = 'help_request';
      session.agentIR!.flow!.definitions.collect.digressions![0].intent = 'help_request';

      const chunks: string[] = [];
      const traces: Array<{ type: string; data: Record<string, unknown> }> = [];
      await executor.executeMessage(
        session.id,
        'help',
        (chunk) => chunks.push(chunk),
        (event) => traces.push(event),
      );

      expect(chunks.join('')).toContain('Step help response');
      expect(
        traces.some(
          (trace) =>
            trace.type === 'warning' &&
            Array.isArray(trace.data.intents) &&
            trace.data.intents.includes('help_request'),
        ),
      ).toBe(true);
    });
  });

  // ===========================================================================
  // SUB-INTENTS (step-scoped)
  // ===========================================================================

  describe('Sub-intents', () => {
    test('Sub-intent with SET + RESPOND modifies state and stays in step', async () => {
      const dsl = `
AGENT: SubIntent_Set_Test

GOAL: "Test sub-intent SET"

FLOW:
  entry_point: collect
  steps:
    - collect

collect:
  REASONING: false
  GATHER:
    - destination: required
  SUB_INTENTS:
    - INTENT: "prefer luxury"
      SET: preference = luxury
      RESPOND: "Noted, luxury preference saved."
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'SubIntent_Set_Test'),
      );
      await executor.initializeSession(session.id);

      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'I prefer luxury hotels', (c) => chunks.push(c));

      expect(chunks.join('')).toContain('luxury preference saved');
      expect(session.data.values.preference).toBe('luxury');
      // Should still be on collect step
      expect(session.currentFlowStep).toBe('collect');
    });

    test('Sub-intent response returns structured payloads', async () => {
      const dsl = `
AGENT: SubIntent_Structured_Test

GOAL: "Test structured sub-intent responses"

FLOW:
  entry_point: collect
  steps:
    - collect

collect:
  REASONING: false
  GATHER:
    - destination: required
  SUB_INTENTS:
    - INTENT: "prefer luxury"
      RESPOND: "Sure, where should we search next?"
        VOICE:
          plain_text: "Where should we search next?"
        FORMATS:
          markdown: "**Where next?**"
        ACTIONS:
          - BUTTON: "Pick city" -> pick_city
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'SubIntent_Structured_Test'),
      );
      await executor.initializeSession(session.id);

      const chunks: string[] = [];
      const result = await executor.executeMessage(session.id, 'I prefer luxury hotels', (c) =>
        chunks.push(c),
      );

      expect(chunks.join('')).toContain('where should we search next');
      expect(result.response).toContain('where should we search next');
      expect(result.voiceConfig).toMatchObject({
        plain_text: 'Where should we search next?',
      });
      expect(result.richContent).toMatchObject({
        markdown: '**Where next?**',
      });
      expect(result.actions).toMatchObject({
        elements: [{ id: 'pick_city', type: 'button', label: 'Pick city' }],
      });
    });

    test('ON_START response returns structured actions', async () => {
      const dsl = `
AGENT: OnStart_Actions_Test

GOAL: "Test ON_START actions"

ON_START:
  RESPOND: "Welcome"
    ACTIONS:
      - BUTTON: "Start" -> start_flow
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'OnStart_Actions_Test'),
      );

      const chunks: string[] = [];
      const result = await executor.initializeSession(session.id, (c) => chunks.push(c));

      expect(chunks.join('')).toContain('Welcome');
      expect(result?.actions).toMatchObject({
        elements: [{ id: 'start_flow', type: 'button', label: 'Start', value: 'start_flow' }],
      });
    });

    test('COMPLETE response returns structured actions', async () => {
      const dsl = `
AGENT: Complete_Actions_Test

GOAL: "Test COMPLETE actions"

FLOW:
  entry_point: collect
  steps:
    - collect

collect:
  GATHER:
    - name: required
  THEN: COMPLETE

COMPLETE:
  - WHEN: name IS SET
    RESPOND: "Done {{name}}"
      ACTIONS:
        - BUTTON: "Download" -> download_receipt
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Complete_Actions_Test'),
      );
      await executor.initializeSession(session.id);

      const chunks: string[] = [];
      const result = await executor.executeMessage(session.id, 'Ada', (c) => chunks.push(c));

      expect(chunks.join('')).toContain('Done Ada');
      expect(result.actions).toMatchObject({
        elements: [
          {
            id: 'download_receipt',
            type: 'button',
            label: 'Download',
            value: 'download_receipt',
          },
        ],
      });
    });

    test('Sub-intent SET batches trigger REMEMBER once', async () => {
      const dsl = `
AGENT: SubIntent_Remember_Test

GOAL: "Test sub-intent remember"

FLOW:
  entry_point: collect
  steps:
    - collect

collect:
  REASONING: false
  GATHER:
    - destination: required
  SUB_INTENTS:
    - INTENT: "prefer luxury"
      SET: preference = luxury
      SET: remembered_flag = gold
      SET: remembered_note = priority
      RESPOND: "Noted, luxury preference saved."
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'SubIntent_Remember_Test'),
      );
      attachRememberMemory(session);
      const { factStore, setSpy } = attachFactStore(session);

      try {
        await executor.initializeSession(session.id);
        setSpy.mockClear();

        const chunks: string[] = [];
        await executor.executeMessage(session.id, 'I prefer luxury hotels', (c) => chunks.push(c));

        expect(chunks.join('')).toContain('luxury preference saved');
        expect(session.data.values.preference).toBe('luxury');
        expect(session.data.values.remembered_flag).toBe('gold');
        expect(setSpy).toHaveBeenCalledTimes(1);
        expect(setSpy).toHaveBeenCalledWith(
          expect.objectContaining({ key: 'user.remembered_flag', value: 'gold' }),
        );
      } finally {
        factStore.stop();
      }
    });

    test('Sub-intent with CLEAR triggers re-collection', async () => {
      const dsl = `
AGENT: SubIntent_Clear_Test

GOAL: "Test sub-intent CLEAR"

FLOW:
  entry_point: collect
  steps:
    - collect

collect:
  REASONING: false
  GATHER:
    - destination: required
  SUB_INTENTS:
    - INTENT: "change destination"
      CLEAR: [destination]
      RESPOND: "OK, what's the new destination?"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'SubIntent_Clear_Test'),
      );
      await executor.initializeSession(session.id);
      // Set values AFTER init so GATHER doesn't auto-complete
      session.data.values.destination = 'Paris';

      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'change destination please', (c) => chunks.push(c));

      expect(chunks.join('')).toContain("what's the new destination");
      expect(session.data.values.destination).toBeUndefined();
    });

    test('Sub-intent emits trace event', async () => {
      const dsl = `
AGENT: SubIntent_Trace_Test

GOAL: "Test sub-intent traces"

FLOW:
  entry_point: step1
  steps:
    - step1

step1:
  REASONING: false
  GATHER:
    - value: required
  SUB_INTENTS:
    - INTENT: "reset"
      RESPOND: "Reset!"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'SubIntent_Trace_Test'),
      );
      await executor.initializeSession(session.id);

      const traces: Array<{ type: string; data: Record<string, unknown> }> = [];
      await executor.executeMessage(session.id, 'reset everything', undefined, (e) =>
        traces.push(e),
      );

      const subIntentTrace = traces.find((t) => t.type === 'sub_intent');
      expect(subIntentTrace).toBeDefined();
      expect(subIntentTrace!.data.intent).toBe('reset');

      const gatherTrace = extractGatherInterruptTrace(subIntentTrace!.data);
      expect(isGatherInterruptTrace(gatherTrace)).toBe(true);
      expect(gatherTrace).toMatchObject({
        detectionMode: 'lexical',
        lexicalMatchType: 'exact',
        policyApplied: 'when_unavailable',
        candidateSurface: {
          kind: 'sub_intent',
          size: 1,
          candidates: ['reset'],
        },
      });
    });
  });
});
