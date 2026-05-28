/**
 * Flow Action Dispatch Integration Tests
 *
 * Tests the full executor-level roundtrip:
 *   DSL with ACTIONS/CAROUSEL + ON_ACTION
 *   → compile → initializeSession (sends actions, pauses)
 *   → executeMessage with actionEvent
 *   → ON_ACTION handler fires (respond, transition, set)
 *
 * This covers the gap that parser/compiler/adapter unit tests miss:
 * the runtime execution path where action callbacks are dispatched.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { SESSION_KEY_ACTION_EVENT } from '../../services/execution/flow-step-executor';
import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor';

describe('Flow action dispatch', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  test('THEN ESCALATE is handled as a terminal flow keyword', async () => {
    const dsl = `
AGENT: Terminal_Escalate_Test
GOAL: "Test terminal escalation"
PERSONA: "Test"

ESCALATE:
  triggers:
    - WHEN: user.requests_human == true
      REASON: "User requested human support"
      PRIORITY: high

FLOW:
  entry_point: request_support
  steps:
    - request_support

request_support:
  REASONING: false
  RESPOND: "Connecting you with support."
  THEN: ESCALATE
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Terminal_Escalate_Test'),
    );

    const result = await executor.initializeSession(session.id);

    expect(session.isEscalated).toBe(true);
    expect(result?.action?.type).toBe('escalate');
  });

  test('ON_INPUT THEN ESCALATE uses the same terminal flow handler', async () => {
    const dsl = `
AGENT: Branch_Terminal_Escalate_Test
GOAL: "Test branch terminal escalation"
PERSONA: "Test"

ESCALATE:
  triggers:
    - WHEN: user.requests_human == true
      REASON: "User requested human support"
      PRIORITY: high

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  REASONING: false
  RESPOND: "How can I help?"
  ON_INPUT:
    - IF: input contains "human"
      RESPOND: "Routing you now."
      THEN: ESCALATE
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Branch_Terminal_Escalate_Test'),
    );

    await executor.initializeSession(session.id);
    const result = await executor.executeMessage(session.id, 'human please');

    expect(session.isEscalated).toBe(true);
    expect(session.currentFlowStep).toBe('ESCALATE');
    expect(result.action.type).toBe('escalate');
  });

  test('failed terminal escalation restores the source flow step', async () => {
    const dsl = `
AGENT: Failed_Terminal_Escalate_Test
GOAL: "Test failed terminal escalation"
PERSONA: "Test"

ESCALATE:
  triggers:
    - WHEN: user.requests_human == true
      REASON: "User requested human support"
      PRIORITY: high
  on_human_complete:
    - IF resolution == "resolved": complete

FLOW:
  entry_point: request_support
  steps:
    - request_support

request_support:
  REASONING: false
  RESPOND: "Connecting you with support."
  THEN: ESCALATE
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Failed_Terminal_Escalate_Test'),
    );

    const result = await executor.initializeSession(session.id);

    expect(session.isEscalated).toBe(false);
    expect(session.currentFlowStep).toBe('request_support');
    expect(result?.action?.type).toBe('error');
    expect(result?.action?.failedAction).toBe('escalate');
  });

  test('standalone ACTIONS + ON_ACTION: button click dispatches handler', async () => {
    const dsl = `
AGENT: Action_Test
GOAL: "Test action dispatch"
PERSONA: "Test"

FLOW:
  entry_point: ask
  steps:
    - ask
    - confirmed
    - cancelled

ask:
  REASONING: false
  RESPOND: "Confirm order?"
    ACTIONS:
      - BUTTON: "Yes" -> confirm_yes
      - BUTTON: "No" -> confirm_no
  ON_ACTION:
    confirm_yes:
      SET: choice = yes
      RESPOND: "Order confirmed!"
      TRANSITION: confirmed
    confirm_no:
      RESPOND: "Order cancelled."
      TRANSITION: cancelled

confirmed:
  REASONING: false
  RESPOND: "Processing your order. choice={{choice}}"
  THEN: COMPLETE

cancelled:
  REASONING: false
  RESPOND: "Goodbye."
  THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Action_Test'),
    );

    // Step 1: Initialize — should send the RESPOND + ACTIONS and pause
    const initChunks: string[] = [];
    const initResult = await executor.initializeSession(session.id, (c) => initChunks.push(c));
    expect(initChunks.join('')).toContain('Confirm order?');
    expect(initResult?.actions).toBeDefined();
    expect(initResult?.actions?.elements).toHaveLength(2);
    expect(initResult?.action?.type).toBe('waiting_for_action');

    // Step 2: Send action event (simulate button click)
    const actionChunks: string[] = [];
    const actionResult = await executor.executeMessage(
      session.id,
      '', // empty text — action callbacks have no text
      (c) => actionChunks.push(c),
      undefined,
      { actionEvent: { actionId: 'confirm_yes' } },
    );

    // ON_ACTION handler should have fired
    const actionOutput = actionChunks.join('');
    expect(actionOutput).toContain('Order confirmed!');
    expect(session.data.values.choice).toBe('yes');

    // Should have transitioned to 'confirmed' step and executed it
    const fullOutput = actionResult.response;
    expect(fullOutput).toContain('Processing your order');
    expect(fullOutput).toContain('choice=yes');
  });

  test('ON_ACTION DO CALL WITH/AS passes params and binds result before subsequent actions', async () => {
    const dsl = `
AGENT: Action_CallSpec_Test
GOAL: "Test action call_spec dispatch"
PERSONA: "Test"

TOOLS:
  audit_selection(selected: string) -> {approved: boolean}
    description: "Audit a selection"

FLOW:
  entry_point: ask
  steps:
    - ask
    - done

ask:
  REASONING: false
  RESPOND: "Choose an action"
    ACTIONS:
      - BUTTON: "Audit" -> audit
  ON_ACTION:
    audit:
      DO:
        - CALL: audit_selection
          WITH:
            selected: session.selected_agent
          AS: audit_result
        - RESPOND: "Approved={{audit_result.approved}}"
        - TRANSITION: done

done:
  REASONING: false
  RESPOND: "Stored={{audit_result.approved}}"
  THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Action_CallSpec_Test'),
    );
    session.data.values.session = { selected_agent: 'Agent_A' };

    let capturedArgs: Record<string, unknown> | undefined;
    session.toolExecutor = {
      execute: async (_name: string, args: Record<string, unknown>) => {
        capturedArgs = args;
        return { approved: true };
      },
    } as any;

    await executor.initializeSession(session.id);

    const actionChunks: string[] = [];
    const actionResult = await executor.executeMessage(
      session.id,
      '',
      (chunk) => actionChunks.push(chunk),
      undefined,
      { actionEvent: { actionId: 'audit' } },
    );

    expect(capturedArgs).toEqual({ selected: 'Agent_A' });
    expect(session.data.values.audit_result).toEqual({ approved: true });
    expect(actionChunks.join('')).toContain('Approved=true');
    expect(actionResult.response).toContain('Stored=true');
  });

  test('carousel BUTTONS + ON_ACTION: carousel button click dispatches handler', async () => {
    const dsl = `
AGENT: Carousel_Action_Test
GOAL: "Test carousel action dispatch"
PERSONA: "Test"

FLOW:
  entry_point: products
  steps:
    - products
    - checkout

products:
  REASONING: false
  RESPOND: "Our top picks"
    CAROUSEL:
      - TITLE: "Product A"
        SUBTITLE: "$9.99"
        BUTTONS:
          - BUTTON: "Buy A" -> buy_a
      - TITLE: "Product B"
        SUBTITLE: "$14.99"
        BUTTONS:
          - BUTTON: "Buy B" -> buy_b
  ON_ACTION:
    buy_a:
      SET: selected = product_a
      RESPOND: "Added Product A to cart."
      TRANSITION: checkout
    buy_b:
      SET: selected = product_b
      RESPOND: "Added Product B to cart."
      TRANSITION: checkout

checkout:
  REASONING: false
  RESPOND: "Checking out {{selected}}"
  THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Carousel_Action_Test'),
    );

    // Step 1: Initialize — should send carousel and pause
    const initChunks: string[] = [];
    const initResult = await executor.initializeSession(session.id, (c) => initChunks.push(c));
    expect(initChunks.join('')).toContain('Our top picks');
    expect(initResult?.richContent?.carousel).toBeDefined();
    expect(initResult?.richContent?.carousel?.cards).toHaveLength(2);
    expect(initResult?.action?.type).toBe('waiting_for_action');
    expect(initResult?.actions?.renderId).toMatch(/^action-render-/);
    expect(initResult?.actions?.elements).toEqual([]);

    // Step 2: Click "Buy B" carousel button
    const actionChunks: string[] = [];
    const actionResult = await executor.executeMessage(
      session.id,
      '',
      (c) => actionChunks.push(c),
      undefined,
      { actionEvent: { actionId: 'buy_b' } },
    );

    expect(actionChunks.join('')).toContain('Added Product B to cart.');
    expect(session.data.values.selected).toBe('product_b');
    expect(actionResult.response).toContain('Checking out product_b');
  });

  test('non-action message while waiting re-processes step and re-arms', async () => {
    const dsl = `
AGENT: Clear_Wait_Test
GOAL: "Test clearing wait state"
PERSONA: "Test"

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  REASONING: false
  RESPOND: "Click a button"
    ACTIONS:
      - BUTTON: "Go" -> go
  ON_ACTION:
    go:
      RESPOND: "Going!"
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Clear_Wait_Test'),
    );

    // Initialize — pauses for action
    const initResult = await executor.initializeSession(session.id);
    expect(initResult?.action?.type).toBe('waiting_for_action');

    // Send a regular text message (no actionEvent) — clears waiting state,
    // re-processes the step, and re-arms since the step still has actions
    const chunks: string[] = [];
    const result = await executor.executeMessage(session.id, 'hello', (c) => chunks.push(c));
    // The step re-sends its RESPOND and re-arms
    expect(chunks.join('')).toContain('Click a button');
    expect(result.action?.type).toBe('waiting_for_action');
    // The user's text was added to conversation history
    expect(
      session.conversationHistory.some((m) => m.role === 'user' && m.content === 'hello'),
    ).toBe(true);
  });

  test('ACTIONS + ON_ACTION + ON_INPUT fallback: button click dispatches handler instead of looping', async () => {
    const dsl = `
SUPERVISOR: Supervisor
  GOAL: "Show two buttons and confirm which one was clicked."
  FLOW:
    entry_point: main_menu
    steps:
      - main_menu
      - selection_result
  main_menu:
    REASONING: false
    RESPOND: "Welcome to HandoffTest staging. Choose your preferred option:"
      ACTIONS:
        - BUTTON: "Agent A" -> agent_a
        - BUTTON: "Agent B" -> agent_b
    ON_ACTION:
      agent_a:
        SET: selected_agent = "Agent_A"
        RESPOND: "Agent A button clicked."
        TRANSITION: selection_result
      agent_b:
        SET: selected_agent = "Agent_B"
        RESPOND: "Agent B button clicked."
        TRANSITION: selection_result
    ON_INPUT:
      - ELSE:
          RESPOND: "Please click Agent A or Agent B."
          THEN: main_menu
  selection_result:
    REASONING: false
    RESPOND: "Selected: {{selected_agent}}"
`;

    const session = executor.createSessionFromResolved(compileToResolvedAgent([dsl], 'Supervisor'));

    const initResult = await executor.initializeSession(session.id);
    expect(initResult?.action?.type).toBe('waiting_for_action');
    expect(initResult?.actions?.elements).toHaveLength(2);

    const actionChunks: string[] = [];
    const actionResult = await executor.executeMessage(
      session.id,
      '',
      (chunk) => actionChunks.push(chunk),
      undefined,
      { actionEvent: { actionId: 'agent_a', value: 'agent_a' } },
    );

    expect(actionChunks.join('')).toContain('Agent A button clicked.');
    expect(actionChunks.join('')).not.toContain('Please click Agent A or Agent B.');
    expect(session.data.values.selected_agent).toBe('Agent_A');
    expect(actionResult.response).toContain('Selected: Agent_A');
    expect(session.currentFlowStep).toBe('selection_result');
  });

  test('direct ON_ACTION can hand off directly to a declared agent', async () => {
    const parentDsl = `
AGENT: Button_Handoff_Parent
GOAL: "Route from a button"
PERSONA: "Parent"

HANDOFF:
  - TO: Button_Handoff_Child
    WHEN: always
    RETURN: false

FLOW:
  entry_point: menu
  steps:
    - menu

menu:
  REASONING: false
  RESPOND: "Choose an agent"
    ACTIONS:
      - BUTTON: "Child" -> child
  ON_ACTION:
    child:
      SET: selected_agent = "Button_Handoff_Child"
      RESPOND: "Routing to child..."
      HANDOFF: Button_Handoff_Child
`;
    const childDsl = `
AGENT: Button_Handoff_Child
GOAL: "Handle child route"
PERSONA: "Child"

FLOW:
  start:
    REASONING: false
    RESPOND: "Child agent ready."
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([parentDsl, childDsl], 'Button_Handoff_Parent'),
    );

    const initResult = await executor.initializeSession(session.id);
    expect(initResult?.action?.type).toBe('waiting_for_action');

    const actionChunks: string[] = [];
    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const actionResult = await executor.executeMessage(
      session.id,
      '',
      (chunk) => actionChunks.push(chunk),
      (event) => traceEvents.push(event),
      { actionEvent: { actionId: 'child' } },
    );

    expect(actionChunks.join('')).toContain('Routing to child...');
    expect(actionResult.action).toEqual({ type: 'handoff', target: 'Button_Handoff_Child' });
    expect(actionResult.response).toBe('Child agent ready.');
    expect(session.agentName).toBe('Button_Handoff_Child');
    expect(session.data.values.selected_agent).toBe('Button_Handoff_Child');
    expect(traceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'action_handler_action_executed',
          data: expect.objectContaining({
            actionId: 'child',
            actionType: 'handoff',
            target: 'Button_Handoff_Child',
            forwardedMessageSource: 'action_id',
          }),
        }),
        expect.objectContaining({
          type: 'action_handler_action_result',
          data: expect.objectContaining({
            actionId: 'child',
            actionType: 'handoff',
            target: 'Button_Handoff_Child',
            success: true,
          }),
        }),
      ]),
    );
  });

  test('ON_ACTION DELEGATE forwards button value when action text is empty', async () => {
    const parentDsl = `
AGENT: Button_Delegate_Parent
GOAL: "Delegate from a button"
PERSONA: "Parent"

DELEGATE:
  - AGENT: Button_Delegate_Child
    PURPOSE: "Handle selected button"

FLOW:
  entry_point: menu
  steps:
    - menu

menu:
  REASONING: false
  RESPOND: "Choose an agent"
    ACTIONS:
      - BUTTON: "Child"
        ID: child
        VALUE: "delegate_payload"
  ON_ACTION:
    child:
      DO:
        - RESPOND: "Delegating to child..."
        - DELEGATE: Button_Delegate_Child
`;
    const childDsl = `
AGENT: Button_Delegate_Child
GOAL: "Handle delegated work"
PERSONA: "Child"

FLOW:
  start:
    REASONING: false
    RESPOND: "Child delegated."
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([parentDsl, childDsl], 'Button_Delegate_Parent'),
    );

    const initResult = await executor.initializeSession(session.id);
    expect(initResult?.action?.type).toBe('waiting_for_action');

    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const actionResult = await executor.executeMessage(
      session.id,
      '',
      undefined,
      (event) => traceEvents.push(event),
      { actionEvent: { actionId: 'child', value: 'delegate_payload' } },
    );

    expect(actionResult.action).toEqual({
      type: 'delegate',
      target: 'Button_Delegate_Child',
      success: true,
    });
    const delegateStart = traceEvents.find((event) => event.type === 'delegate_start');
    const delegationId = delegateStart?.data.delegationId;
    expect(typeof delegationId).toBe('string');
    expect(delegationId).toMatch(/^exec-/);
    expect(traceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'delegate_start',
          data: expect.objectContaining({
            to: 'Button_Delegate_Child',
            message: 'delegate_payload',
            delegationId,
            parentSessionId: session.id,
            childSessionId: expect.stringContaining('__delegate__'),
          }),
        }),
        expect.objectContaining({
          type: 'delegated_message',
          data: expect.objectContaining({
            message: 'delegate_payload',
            delegationId,
            parentSessionId: session.id,
            sourceAgent: 'Button_Delegate_Parent',
          }),
        }),
        expect.objectContaining({
          type: 'agent_enter',
          data: expect.objectContaining({
            agentName: 'Button_Delegate_Child',
            delegationId,
            parentSessionId: session.id,
            sourceAgent: 'Button_Delegate_Parent',
          }),
        }),
        expect.objectContaining({
          type: 'thread_return',
          data: expect.objectContaining({
            returnType: 'delegate',
            delegationId,
            parentSessionId: session.id,
            childSessionId: expect.stringContaining('__delegate__'),
          }),
        }),
        expect.objectContaining({
          type: 'delegate_complete',
          data: expect.objectContaining({
            success: true,
            delegationId,
            parentSessionId: session.id,
            childSessionId: expect.stringContaining('__delegate__'),
          }),
        }),
        expect.objectContaining({
          type: 'action_handler_action_executed',
          data: expect.objectContaining({
            actionId: 'child',
            actionType: 'delegate',
            target: 'Button_Delegate_Child',
            forwardedMessageSource: 'action_value',
          }),
        }),
      ]),
    );
  });

  test('ON_ACTION rich response payload survives terminal handoff fallback', async () => {
    const parentDsl = `
AGENT: Rich_Button_Handoff_Parent
GOAL: "Route from a rich button"
PERSONA: "Parent"

HANDOFF:
  - TO: Rich_Button_Handoff_Child
    WHEN: always
    RETURN: false

FLOW:
  entry_point: menu
  steps:
    - menu

menu:
  REASONING: false
  RESPOND: "Choose an agent"
    ACTIONS:
      - BUTTON: "Child" -> child
  ON_ACTION:
    child:
      DO:
        - RESPOND: "Routing to child..."
          FORMATS:
            MARKDOWN: "**Routing card**"
        - HANDOFF: Rich_Button_Handoff_Child
`;
    const childDsl = `
AGENT: Rich_Button_Handoff_Child
GOAL: "Handle child route"
PERSONA: "Child"

FLOW:
  start:
    REASONING: false
    RESPOND: "Child agent ready."
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([parentDsl, childDsl], 'Rich_Button_Handoff_Parent'),
    );

    await executor.initializeSession(session.id);
    const actionResult = await executor.executeMessage(session.id, '', undefined, undefined, {
      actionEvent: { actionId: 'child' },
    });

    expect(actionResult.response).toBe('Child agent ready.');
    expect(actionResult.richContent?.markdown).toBe('**Routing card**');
  });

  test('ON_ACTION rich response payload survives terminal complete fallback', async () => {
    const dsl = `
AGENT: Rich_Action_Complete
GOAL: "Complete from a rich button"
PERSONA: "Test"

FLOW:
  entry_point: menu
  steps:
    - menu

menu:
  REASONING: false
  RESPOND: "Finish?"
    ACTIONS:
      - BUTTON: "Finish" -> finish
  ON_ACTION:
    finish:
      DO:
        - RESPOND: "Finishing..."
          FORMATS:
            MARKDOWN: "**Complete card**"
        - COMPLETE
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Rich_Action_Complete'),
    );

    await executor.initializeSession(session.id);
    const actionResult = await executor.executeMessage(session.id, '', undefined, undefined, {
      actionEvent: { actionId: 'finish' },
    });

    expect(actionResult.action.type).toBe('complete');
    expect(actionResult.richContent?.markdown).toBe('**Complete card**');
  });

  test('ON_ACTION voice response payload survives pending rendered payload path', async () => {
    const dsl = `
AGENT: Voice_Action_Response
GOAL: "Return voice metadata from an action"
PERSONA: "Test"

FLOW:
  entry_point: menu
  steps:
    - menu

menu:
  REASONING: false
  RESPOND: "Choose"
    ACTIONS:
      - BUTTON: "Speak" -> speak
  ON_ACTION:
    speak:
      DO:
        - RESPOND: "Speaking now"
          VOICE:
            plain_text: "Speaking now for voice"
            provider: "elevenlabs"
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Voice_Action_Response'),
    );

    await executor.initializeSession(session.id);
    const actionResult = await executor.executeMessage(session.id, '', undefined, undefined, {
      actionEvent: { actionId: 'speak' },
    });

    expect(actionResult.response).toBe('Speaking now');
    expect(actionResult.voiceConfig).toMatchObject({
      plain_text: 'Speaking now for voice',
    });
    expect(session.pendingResponse).toBe('Speaking now');
    expect(session.pendingVoiceConfig).toMatchObject({
      plain_text: 'Speaking now for voice',
    });
  });

  test('ON_ACTION response can return interpolated follow-up actions', async () => {
    const dsl = `
AGENT: Followup_Action_Response
GOAL: "Return actions from an action handler"
PERSONA: "Test"

FLOW:
  entry_point: menu
  steps:
    - menu

menu:
  REASONING: false
  RESPOND: "Choose"
    ACTIONS:
      - BUTTON: "Start" -> start
  ON_ACTION:
    start:
      DO:
        - RESPOND: "Next for {{user_name}}"
          ACTIONS:
            - BUTTON: "Continue {{user_name}}" -> continue_next
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Followup_Action_Response'),
    );
    session.data.values.user_name = 'Alice';

    await executor.initializeSession(session.id);
    const actionResult = await executor.executeMessage(session.id, '', undefined, undefined, {
      actionEvent: { actionId: 'start' },
    });

    expect(actionResult.response).toBe('Next for Alice');
    expect(actionResult.action.type).toBe('waiting_for_action');
    expect(actionResult.actions?.elements).toHaveLength(1);
    expect(actionResult.actions?.elements[0]).toMatchObject({
      id: 'continue_next',
      type: 'button',
      label: 'Continue Alice',
    });
    expect(actionResult.actions?.renderId).toMatch(/^action-render-/);
    expect(session.pendingActions?.elements[0]?.label).toBe('Continue Alice');
    expect(session.pendingActions?.renderId).toBe(actionResult.actions?.renderId);
  });

  test('ON_ACTION DO can clear values and go to another step', async () => {
    const dsl = `
AGENT: Action_Clear_Test
GOAL: "Test clear action"
PERSONA: "Test"

FLOW:
  entry_point: menu
  steps:
    - menu
    - done

menu:
  REASONING: false
  RESPOND: "Reset?"
    ACTIONS:
      - BUTTON: "Reset" -> reset
  ON_ACTION:
    reset:
      DO:
        - CLEAR: [draft_agent]
        - RESPOND: "Reset complete."
        - GOTO: done

done:
  REASONING: false
  RESPOND: "Draft={{draft_agent}}"
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Action_Clear_Test'),
    );
    session.data.values.draft_agent = 'temporary';
    await executor.initializeSession(session.id);

    const actionChunks: string[] = [];
    const actionResult = await executor.executeMessage(
      session.id,
      '',
      (chunk) => actionChunks.push(chunk),
      undefined,
      { actionEvent: { actionId: 'reset' } },
    );

    expect(actionChunks.join('')).toContain('Reset complete.');
    expect(session.data.values.draft_agent).toBeUndefined();
    expect(actionResult.response).toContain('Draft=');
    expect(session.currentFlowStep).toBe('done');
  });

  test('ON_ACTION with CONDITION: only fires when condition is true', async () => {
    const dsl = `
AGENT: Condition_Action_Test
GOAL: "Test conditional action"
PERSONA: "Test"

FLOW:
  entry_point: ask
  steps:
    - ask
    - done

ask:
  REASONING: false
  RESPOND: "Confirm?"
    ACTIONS:
      - BUTTON: "Yes" -> confirm
  ON_ACTION:
    confirm:
      CONDITION: "premium == true"
      SET: tier = premium
      RESPOND: "Premium confirmed!"
      TRANSITION: done
    confirm:
      RESPOND: "Standard confirmed."
      TRANSITION: done

done:
  REASONING: false
  RESPOND: "Done. tier={{tier}}"
  THEN: COMPLETE
`;

    // Test 1: condition is false — second handler (no condition) fires
    const session1 = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Condition_Action_Test'),
    );
    await executor.initializeSession(session1.id);

    const chunks1: string[] = [];
    await executor.executeMessage(session1.id, '', (c) => chunks1.push(c), undefined, {
      actionEvent: { actionId: 'confirm' },
    });
    expect(chunks1.join('')).toContain('Standard confirmed.');

    // Test 2: condition is true — first handler fires
    const session2 = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Condition_Action_Test'),
    );
    session2.data.values.premium = true;
    await executor.initializeSession(session2.id);

    const chunks2: string[] = [];
    await executor.executeMessage(session2.id, '', (c) => chunks2.push(c), undefined, {
      actionEvent: { actionId: 'confirm' },
    });
    expect(chunks2.join('')).toContain('Premium confirmed!');
    expect(session2.data.values.tier).toBe('premium');
  });

  test('ON_ACTION receives full channel action envelope for conditions and SET values', async () => {
    const dsl = `
AGENT: Action_Envelope_Test
GOAL: "Test channel action payloads"
PERSONA: "Test"

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  REASONING: false
  RESPOND: "Choose a route"
    ACTIONS:
      - BUTTON: "Route" -> route
  ON_ACTION:
    route:
      CONDITION: _action.formData.target == "Agent_A"
      DO:
        - SET: selected_agent = _action.formData.target
        - SET: action_source = _action.source
        - SET: action_value = _action.value
        - RESPOND: "Routing {{selected_agent}} from {{action_source}}"
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Action_Envelope_Test'),
    );

    await executor.initializeSession(session.id);
    const actionResult = await executor.executeMessage(session.id, '', undefined, undefined, {
      actionEvent: {
        actionId: 'route',
        value: 'button-value',
        formData: { target: 'Agent_A' },
        source: 'teams',
      },
    });

    expect(actionResult.response).toContain('Routing Agent_A from teams');
    expect(session.data.values.selected_agent).toBe('Agent_A');
    expect(session.data.values.action_source).toBe('teams');
    expect(session.data.values.action_value).toBe('button-value');
  });

  test('malformed channel action envelopes are rejected before handlers see _action.formData', async () => {
    const dsl = `
AGENT: Invalid_Action_Envelope_Test
GOAL: "Test invalid channel action payloads"
PERSONA: "Test"

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  REASONING: false
  RESPOND: "Choose a route"
    ACTIONS:
      - BUTTON: "Route" -> route
  ON_ACTION:
    route:
      SET: selected_agent = _action.formData.target
      RESPOND: "Routing {{selected_agent}}"
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Invalid_Action_Envelope_Test'),
    );
    const initResult = await executor.initializeSession(session.id);
    expect(initResult?.action?.type).toBe('waiting_for_action');

    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const actionResult = await executor.executeMessage(
      session.id,
      '',
      undefined,
      (event) => traceEvents.push(event),
      {
        actionEvent: {
          actionId: 'route',
          formData: ['not', 'object'] as unknown as Record<string, unknown>,
          source: 'slack',
        },
      },
    );

    expect(actionResult.response).toContain('action payload is invalid');
    expect(actionResult.action?.type).toBe('waiting_for_action');
    expect(session.data.values.selected_agent).toBeUndefined();
    expect(session.data.values[SESSION_KEY_ACTION_EVENT]).toBeUndefined();
    expect(traceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'action_submit_rejected',
          data: expect.objectContaining({
            actionId: 'route',
            reason: 'invalid_action_event',
          }),
        }),
      ]),
    );
  });

  test('stale action render ids are rejected without firing the handler', async () => {
    const dsl = `
AGENT: Action_Render_Correlation_Test
GOAL: "Test action render correlation"
PERSONA: "Test"

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  REASONING: false
  RESPOND: "Choose"
    ACTIONS:
      - BUTTON: "Go" -> go
  ON_ACTION:
    go:
      SET: fired = true
      RESPOND: "Handler fired."
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'Action_Render_Correlation_Test'),
    );

    const initResult = await executor.initializeSession(session.id);
    const renderId = initResult?.actions?.renderId;

    expect(initResult?.action?.type).toBe('waiting_for_action');
    expect(renderId).toMatch(/^action-render-/);

    const staleResult = await executor.executeMessage(session.id, '', undefined, undefined, {
      actionEvent: { actionId: 'go', renderId: 'action-render-stale' },
    });

    expect(staleResult.response).toContain('no longer available');
    expect(staleResult.action?.type).toBe('waiting_for_action');
    expect(session.data.values.fired).toBeUndefined();
    expect(session.data.values[SESSION_KEY_ACTION_EVENT]).toBeUndefined();

    const textResult = await executor.executeMessage(session.id, 'hello');

    expect(textResult.response).toContain('Choose');
    expect(textResult.response).not.toContain('no longer available');
    expect(textResult.action?.type).toBe('waiting_for_action');
    const refreshedRenderId = textResult.actions?.renderId;
    expect(refreshedRenderId).toMatch(/^action-render-/);
    expect(refreshedRenderId).not.toBe(renderId);
    expect(session.data.values.fired).toBeUndefined();

    const validResult = await executor.executeMessage(session.id, '', undefined, undefined, {
      actionEvent: { actionId: 'go', renderId: refreshedRenderId },
    });

    expect(validResult.response).toContain('Handler fired.');
    expect(session.data.values.fired).toBe(true);
  });
});
