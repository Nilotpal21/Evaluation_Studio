/**
 * IR Compiler Tests for ABL Spec-Implementation Parity (Phase 1)
 *
 * Verifies that new IR extensions compile correctly:
 * - VoiceConfigIR.provider/voice_id/speed
 * - HookAction.critical
 * - EscalationConfig.connector_action
 * - Agent-level action_handlers
 * - ExecutionConfig.voice
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '../../platform/ir/compiler.js';

function compileFromDSL(dsl: string, agentName: string) {
  const parseResult = parseAgentBasedABL(dsl);
  expect(parseResult.errors).toHaveLength(0);
  expect(parseResult.document).not.toBeNull();
  const output = compileABLtoIR([parseResult.document!]);
  const agent = output.agents[agentName];
  expect(agent).toBeDefined();
  return agent;
}

describe('ABL Spec Parity: VoiceConfigIR extension', () => {
  test('should compile EXECUTION: voice: block with provider, voice_id, speed to IR', () => {
    const agent = compileFromDSL(
      `
AGENT: VoiceIRTest

GOAL: "Test voice IR fields"

EXECUTION:
  model: gpt-4o
  voice:
    provider: elevenlabs
    voice_id: aria
    speed: 1.2
`,
      'VoiceIRTest',
    );

    expect(agent.execution.voice).toBeDefined();
    expect(agent.execution.voice!.provider).toBe('elevenlabs');
    expect(agent.execution.voice!.voice_id).toBe('aria');
    expect(agent.execution.voice!.speed).toBe(1.2);
  });

  test('should compile voice block with ssml and instructions', () => {
    const agent = compileFromDSL(
      `
AGENT: VoiceSSMLTest

GOAL: "Test voice SSML"

EXECUTION:
  voice:
    ssml: "<speak>Hello</speak>"
    instructions: "Speak warmly"
    plain_text: "Hello there"
    provider: google
`,
      'VoiceSSMLTest',
    );

    expect(agent.execution.voice).toBeDefined();
    expect(agent.execution.voice!.ssml).toBe('<speak>Hello</speak>');
    expect(agent.execution.voice!.instructions).toBe('Speak warmly');
    expect(agent.execution.voice!.plain_text).toBe('Hello there');
    expect(agent.execution.voice!.provider).toBe('google');
  });

  test('should handle missing voice block gracefully', () => {
    const agent = compileFromDSL(
      `
AGENT: NoVoiceTest

GOAL: "Test no voice"

EXECUTION:
  model: gpt-4o
`,
      'NoVoiceTest',
    );

    expect(agent.execution.voice).toBeUndefined();
  });
});

describe('ABL Spec Parity: HookAction.critical', () => {
  test('should compile HOOKS with critical: true', () => {
    const agent = compileFromDSL(
      `
AGENT: HookCriticalTest

GOAL: "Test hook critical flag"

HOOKS:
  before_turn:
    call: audit_logger
    critical: true
`,
      'HookCriticalTest',
    );

    expect(agent.hooks).toBeDefined();
    expect(agent.hooks!.before_turn).toBeDefined();
    expect(agent.hooks!.before_turn!.call).toBe('audit_logger');
    expect(agent.hooks!.before_turn!.critical).toBe(true);
  });

  test('should default critical to undefined when not specified', () => {
    const agent = compileFromDSL(
      `
AGENT: HookNoCriticalTest

GOAL: "Test hook without critical"

HOOKS:
  after_turn:
    respond: "Turn done"
`,
      'HookNoCriticalTest',
    );

    expect(agent.hooks).toBeDefined();
    expect(agent.hooks!.after_turn!.respond).toBe('Turn done');
    expect(agent.hooks!.after_turn!.critical).toBeUndefined();
  });

  test('should compile hook structured respond payloads including actions', () => {
    const agent = compileFromDSL(
      `
AGENT: HookStructuredRespondTest

GOAL: "Test hook structured respond payloads"

HOOKS:
  after_turn:
    RESPOND: "Choose next step"
      VOICE:
        plain_text: "Choose next step"
      FORMATS:
        markdown: "### Choose next step"
      ACTIONS:
        - BUTTON: "Done" -> done
`,
      'HookStructuredRespondTest',
    );

    expect(agent.hooks).toBeDefined();
    expect(agent.hooks!.after_turn).toBeDefined();
    expect(agent.hooks!.after_turn!.respond).toBe('Choose next step');
    expect(agent.hooks!.after_turn!.actions).toMatchObject({
      elements: [{ id: 'done', type: 'button', label: 'Done' }],
    });
    expect(agent.hooks!.after_turn!.rich_content).toEqual({
      markdown: '### Choose next step',
    });
    expect(agent.hooks!.after_turn!.voice_config).toEqual({
      plain_text: 'Choose next step',
    });
  });
});

describe('ABL Spec Parity: lifecycle structured metadata', () => {
  test('should compile COMPLETE and ON_ERROR structured payload metadata', () => {
    const agent = compileFromDSL(
      `
AGENT: LifecycleStructuredCompileTest

GOAL: "Test lifecycle structured metadata compilation"

ON_ERROR:
  tool_timeout:
    SUBTYPES: [transient]
    RESPOND: "Retrying your request."
      VOICE:
        plain_text: "Retrying your request."
      FORMATS:
        markdown: "### Retrying your request."
      ACTIONS:
        - BUTTON: "Retry now" -> retry_now
    RETRY: 2
    RETRY_DELAY: 2500
    RETRY_BACKOFF: exponential
    RETRY_MAX_DELAY: 10000
    THEN: HANDOFF human_support

COMPLETE:
  - WHEN: task_complete == true
    RESPOND: "All done!"
      VOICE:
        plain_text: "All done!"
      FORMATS:
        markdown: "### All done!"
      ACTIONS:
        - BUTTON: "Done" -> done
    STORE: {task_complete} -> user.last_completion
`,
      'LifecycleStructuredCompileTest',
    );

    expect(agent.error_handling?.handlers?.[0]).toMatchObject({
      type: 'tool_timeout',
      subtypes: ['transient'],
      respond: 'Retrying your request.',
      voice_config: {
        plain_text: 'Retrying your request.',
      },
      rich_content: {
        markdown: '### Retrying your request.',
      },
      actions: {
        elements: [{ id: 'retry_now', type: 'button', label: 'Retry now' }],
      },
      retry: 2,
      retry_delay_ms: 2500,
      retry_backoff: 'exponential',
      retry_max_delay_ms: 10000,
      then: 'handoff',
      handoff_target: 'human_support',
    });
    expect(agent.completion?.conditions?.[0]).toMatchObject({
      when: 'task_complete == true',
      respond: 'All done!',
      voice_config: {
        plain_text: 'All done!',
      },
      rich_content: {
        markdown: '### All done!',
      },
      actions: {
        elements: [{ id: 'done', type: 'button', label: 'Done' }],
      },
      store: '{task_complete} -> user.last_completion',
    });
  });
});

describe('ABL Spec Parity: Flow branch structured payloads', () => {
  test('should compile ON_INPUT and ON_RESULT structured respond payloads including actions', () => {
    const agent = compileFromDSL(
      `
AGENT: BranchStructuredCompileTest

GOAL: "Test structured branch compilation"

TOOLS:
  validate_pin() -> object

FLOW:
  start -> verify

start:
  REASONING: false
  ON_INPUT:
    - IF: input contains "choose"
      RESPOND: "Choose next step"
        VOICE:
          plain_text: "Choose next step"
        FORMATS:
          MARKDOWN: "### Choose next step"
        ACTIONS:
          - BUTTON: "Done" -> done
      THEN: verify

verify:
  REASONING: false
  CALL: validate_pin()
    AS: pinResult
  ON_RESULT:
    - IF: pinResult.status == "expired"
      RESPOND: "Session expired"
        ACTIONS:
          - BUTTON: "Sign in again" -> sign_in_again
      THEN: complete
`,
      'BranchStructuredCompileTest',
    );

    expect(agent.flow?.definitions.start.on_input?.[0]).toMatchObject({
      respond: 'Choose next step',
      voice_config: {
        plain_text: 'Choose next step',
      },
      rich_content: {
        markdown: '### Choose next step',
      },
      actions: {
        elements: [{ id: 'done', type: 'button', label: 'Done' }],
      },
    });
    expect(agent.flow?.definitions.verify.on_result?.[0]).toMatchObject({
      respond: 'Session expired',
      actions: {
        elements: [{ id: 'sign_in_again', type: 'button', label: 'Sign in again' }],
      },
    });
  });

  test('should compile ON_SUCCESS and ON_FAILURE branch actions', () => {
    const agent = compileFromDSL(
      `
AGENT: CallResultStructuredCompileTest

GOAL: "Test call result branch structured compilation"

TOOLS:
  validate_pin() -> object

FLOW:
  start -> verify

start:
  REASONING: false
  RESPOND: "Checking"
  THEN: verify

verify:
  REASONING: false
  CALL: validate_pin()
    AS: pinResult
  ON_SUCCESS:
    RESPOND: "Approved"
      ACTIONS:
        - BUTTON: "Continue" -> continue
    THEN: done
    - IF: pinResult.status == "needs_confirmation"
      RESPOND: "Need confirmation"
        ACTIONS:
          - BUTTON: "Confirm" -> confirm
      THEN: confirm
  ON_FAILURE:
    RESPOND: "Try again"
      ACTIONS:
        - BUTTON: "Retry" -> retry
    THEN: retry
`,
      'CallResultStructuredCompileTest',
    );

    expect(agent.flow?.definitions.verify.on_success).toMatchObject({
      actions: {
        elements: [{ id: 'continue', type: 'button', label: 'Continue' }],
      },
    });
    expect(agent.flow?.definitions.verify.on_success?.branches?.[0]).toMatchObject({
      actions: {
        elements: [{ id: 'confirm', type: 'button', label: 'Confirm' }],
      },
    });
    expect(agent.flow?.definitions.verify.on_failure).toMatchObject({
      actions: {
        elements: [{ id: 'retry', type: 'button', label: 'Retry' }],
      },
    });
  });
});

describe('ABL Spec Parity: ON_ERROR default handler compilation', () => {
  test('should compile DEFAULT ON_ERROR blocks into error_handling.default_handler', () => {
    const agent = compileFromDSL(
      `
AGENT: DefaultHandlerCompileTest

GOAL: "Test DEFAULT ON_ERROR compilation"

ON_ERROR:
  tool_timeout:
    RESPOND: "Retrying"
    THEN: CONTINUE
  DEFAULT:
    RESPOND: "Catch-all fallback"
      ACTIONS:
        - BUTTON: "Retry" -> retry
    THEN: COMPLETE
`,
      'DefaultHandlerCompileTest',
    );

    expect(agent.error_handling?.handlers).toHaveLength(1);
    expect(agent.error_handling?.handlers[0]).toMatchObject({
      type: 'tool_timeout',
      respond: 'Retrying',
      then: 'continue',
    });
    expect(agent.error_handling?.default_handler).toMatchObject({
      type: 'DEFAULT',
      respond: 'Catch-all fallback',
      then: 'complete',
      actions: {
        elements: [{ id: 'retry', type: 'button', label: 'Retry' }],
      },
    });
  });
});

describe('ABL Spec Parity: EscalationConfig.connector_action', () => {
  test('should compile ESCALATE with connector_action', () => {
    const agent = compileFromDSL(
      `
AGENT: EscalationITSMTest

GOAL: "Test escalation ITSM"

ESCALATE:
  CONNECTOR_ACTION: servicenow_create_incident
  triggers:
    - WHEN: user.requests_human == true
      REASON: "User requests human"
      PRIORITY: high
  context_for_human:
    - reason
    - sentiment
  on_human_complete:
    - IF resolution == "resolved": continue
`,
      'EscalationITSMTest',
    );

    const escalation = agent.coordination.escalation;
    expect(escalation).toBeDefined();
    expect(escalation!.connector_action).toBe('servicenow_create_incident');
    expect(escalation!.triggers).toHaveLength(1);
    expect(escalation!.on_human_complete).toHaveLength(1);
  });
});

describe('ABL Spec Parity: Agent-level action_handlers', () => {
  test('should compile ACTION_HANDLERS block to IR', () => {
    const agent = compileFromDSL(
      `
AGENT: ActionHandlerTest

GOAL: "Test action handlers"

ACTION_HANDLERS:
  btn_confirm:
    RESPOND: "Confirmed!"
    SET: confirmed = true
    TRANSITION: next_step

  btn_cancel:
    RESPOND: "Cancelled."
`,
      'ActionHandlerTest',
    );

    expect(agent.action_handlers).toBeDefined();
    expect(agent.action_handlers).toHaveLength(2);

    const confirm = agent.action_handlers!.find((h) => h.action_id === 'btn_confirm');
    expect(confirm).toBeDefined();
    expect(confirm!.respond).toBe('Confirmed!');
    expect(confirm!.set).toBeDefined();
    expect(confirm!.transition).toBe('next_step');

    const cancel = agent.action_handlers!.find((h) => h.action_id === 'btn_cancel');
    expect(cancel).toBeDefined();
    expect(cancel!.respond).toBe('Cancelled.');
  });

  test('should return undefined action_handlers when not specified', () => {
    const agent = compileFromDSL(
      `
AGENT: NoHandlerTest

GOAL: "Test no action handlers"
`,
      'NoHandlerTest',
    );

    expect(agent.action_handlers).toBeUndefined();
  });
});
