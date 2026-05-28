/**
 * Actions & Carousel IR Compilation Tests
 *
 * Verifies that ACTIONS, ON_ACTION, and CAROUSEL AST nodes are correctly
 * compiled into their IR counterparts (ActionSetIR, ActionHandlerIR, CarouselIR).
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

describe('Actions IR compilation', () => {
  test('compiles ACTIONS with buttons to ActionSetIR', () => {
    const ir = compileFromDSL(
      `
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

FLOW:
  step1:
    REASONING: false
    RESPOND: "Choose"
      ACTIONS:
        - BUTTON: "Yes" -> confirm_yes
        - BUTTON: "No" -> confirm_no
    THEN: step2
  step2:
    REASONING: false
    RESPOND: "Done"
`,
      'Test_Agent',
    );

    const step = ir.flow!.definitions['step1'];
    expect(step.actions).toBeDefined();
    expect(step.actions!.elements).toHaveLength(2);
    expect(step.actions!.elements[0].id).toBe('confirm_yes');
    expect(step.actions!.elements[0].type).toBe('button');
    expect(step.actions!.elements[0].label).toBe('Yes');
    expect(step.actions!.elements[1].id).toBe('confirm_no');
    expect(step.actions!.elements[1].type).toBe('button');
    expect(step.actions!.elements[1].label).toBe('No');
  });

  test('compiles block button id and hidden value to ActionSetIR', () => {
    const ir = compileFromDSL(
      `
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

FLOW:
  step1:
    REASONING: false
    RESPOND: "Choose"
      ACTIONS:
        - BUTTON: "Agent A"
          ID: agent_a
          VALUE: "delegate_payload"
          DESCRIPTION: "Route to Agent A"
    THEN: done
  done:
    REASONING: false
    RESPOND: "Done"
`,
      'Test_Agent',
    );

    const step = ir.flow!.definitions['step1'];
    expect(step.actions).toBeDefined();
    expect(step.actions!.elements).toEqual([
      expect.objectContaining({
        id: 'agent_a',
        type: 'button',
        label: 'Agent A',
        value: 'delegate_payload',
        description: 'Route to Agent A',
      }),
    ]);
  });

  test('compiles ON_ACTION handlers to on_action IR', () => {
    const ir = compileFromDSL(
      `
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

FLOW:
  step1:
    REASONING: false
    RESPOND: "Choose"
      ACTIONS:
        - BUTTON: "Yes" -> yes
    ON_ACTION:
      yes:
        RESPOND: "Great!"
        TRANSITION: done
  done:
    REASONING: false
    RESPOND: "Bye"
`,
      'Test_Agent',
    );

    const step = ir.flow!.definitions['step1'];
    expect(step.on_action).toBeDefined();
    expect(step.on_action).toHaveLength(1);
    expect(step.on_action![0].action_id).toBe('yes');
    expect(step.on_action![0].respond).toBe('Great!');
    expect(step.on_action![0].transition).toBe('done');
  });

  test('compiles ON_ACTION handler with SET', () => {
    const ir = compileFromDSL(
      `
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

FLOW:
  step1:
    REASONING: false
    RESPOND: "Pick"
      ACTIONS:
        - BUTTON: "A" -> pick_a
        - BUTTON: "B" -> pick_b
    ON_ACTION:
      pick_a:
        RESPOND: "You chose A"
        SET: choice = "a"
        TRANSITION: next
      pick_b:
        RESPOND: "You chose B"
        SET: choice = "b"
        TRANSITION: next
  next:
    REASONING: false
    RESPOND: "OK"
`,
      'Test_Agent',
    );

    const step = ir.flow!.definitions['step1'];
    expect(step.on_action).toHaveLength(2);
    expect(step.on_action![0].action_id).toBe('pick_a');
    expect(step.on_action![0].set).toEqual({ choice: '"a"' });
    expect(step.on_action![1].action_id).toBe('pick_b');
    expect(step.on_action![1].set).toEqual({ choice: '"b"' });
  });

  test('compiles ON_ACTION DO block to ordered handler actions', () => {
    const ir = compileFromDSL(
      `
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

FLOW:
  step1:
    REASONING: false
    RESPOND: "Pick"
      ACTIONS:
        - BUTTON: "Agent A" -> agent_a
    ON_ACTION:
      agent_a:
        DO:
          - SET: selected_agent = "Agent_A"
          - CLEAR: [draft_agent]
          - RESPOND: "Routing to Agent A..."
            VOICE:
              plain_text: "Routing by voice"
            FORMATS:
              MARKDOWN: "**Routing card**"
            ACTIONS:
              - BUTTON: "Confirm route" -> confirm_route
          - CALL: audit_selection AS audit_result
          - HANDOFF: Agent_A
  done:
    REASONING: false
    RESPOND: "OK"
`,
      'Test_Agent',
    );

    const handler = ir.flow!.definitions['step1'].on_action![0];
    expect(handler.do).toMatchObject([
      { set: { selected_agent: '"Agent_A"' } },
      { clear: ['draft_agent'] },
      {
        respond: 'Routing to Agent A...',
        voice_config: { plain_text: 'Routing by voice' },
        rich_content: { markdown: '**Routing card**' },
        actions: {
          elements: [
            {
              id: 'confirm_route',
              type: 'button',
              label: 'Confirm route',
            },
          ],
        },
      },
      {
        call: 'audit_selection',
        result_key: 'audit_result',
        call_spec: { tool: 'audit_selection', as: 'audit_result' },
      },
      { handoff: 'Agent_A' },
    ]);
    expect(handler.set).toEqual({ selected_agent: '"Agent_A"' });
    expect(handler.respond).toBe('Routing to Agent A...');
  });

  test('compiles ON_ACTION DO GOTO to ordered actions and transition mirror', () => {
    const ir = compileFromDSL(
      `
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

FLOW:
  step1:
    REASONING: false
    RESPOND: "Pick"
      ACTIONS:
        - BUTTON: "Done" -> done_btn
    ON_ACTION:
      done_btn:
        DO:
          - SET: completed = true
          - RESPOND: "Done now"
          - GOTO: done
  done:
    REASONING: false
    RESPOND: "OK"
`,
      'Test_Agent',
    );

    const handler = ir.flow!.definitions['step1'].on_action![0];
    expect(handler.do).toEqual([
      { set: { completed: 'true' } },
      { respond: 'Done now' },
      { goto: 'done' },
    ]);
    expect(handler.set).toEqual({ completed: 'true' });
    expect(handler.respond).toBe('Done now');
    expect(handler.transition).toBe('done');
  });

  test('compiles ON_ACTION DO CALL WITH/AS to call_spec', () => {
    const ir = compileFromDSL(
      `
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

FLOW:
  step1:
    REASONING: false
    RESPOND: "Pick"
      ACTIONS:
        - BUTTON: "Audit" -> audit
    ON_ACTION:
      audit:
        DO:
          - CALL: audit_selection
            WITH:
              selected: session.selected_agent
            AS: audit_result
          - TRANSITION: done
  done:
    REASONING: false
    RESPOND: "OK"
`,
      'Test_Agent',
    );

    expect(ir.flow!.definitions['step1'].on_action![0].do![0]).toEqual({
      call: 'audit_selection',
      result_key: 'audit_result',
      call_spec: {
        tool: 'audit_selection',
        with: { selected: 'session.selected_agent' },
        as: 'audit_result',
      },
    });
  });

  test('lowers legacy ON_ACTION fields into ordered handler actions', () => {
    const ir = compileFromDSL(
      `
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

FLOW:
  step1:
    REASONING: false
    RESPOND: "Pick"
      ACTIONS:
        - BUTTON: "A" -> pick_a
    ON_ACTION:
      pick_a:
        SET: choice = "a"
        RESPOND: "You chose A"
        TRANSITION: next
  next:
    REASONING: false
    RESPOND: "OK"
`,
      'Test_Agent',
    );

    const handler = ir.flow!.definitions['step1'].on_action![0];
    expect(handler.do).toEqual([
      { set: { choice: '"a"' } },
      { respond: 'You chose A' },
      { goto: 'next' },
    ]);
  });

  test('preserves direct ON_ACTION handoff ordering with legacy fields', () => {
    const ir = compileFromDSL(
      `
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

FLOW:
  step1:
    REASONING: false
    RESPOND: "Pick"
      ACTIONS:
        - BUTTON: "Agent A" -> agent_a
    ON_ACTION:
      agent_a:
        SET: selected_agent = "Agent_A"
        RESPOND: "Routing to Agent A..."
        HANDOFF: Agent_A
`,
      'Test_Agent',
    );

    const handler = ir.flow!.definitions['step1'].on_action![0];
    expect(handler.do).toEqual([
      { set: { selected_agent: '"Agent_A"' } },
      { respond: 'Routing to Agent A...' },
      { handoff: 'Agent_A' },
    ]);
  });

  test('step without ACTIONS has undefined actions and on_action', () => {
    const ir = compileFromDSL(
      `
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

FLOW:
  step1:
    REASONING: false
    RESPOND: "Plain"
`,
      'Test_Agent',
    );

    const step = ir.flow!.definitions['step1'];
    expect(step.actions).toBeUndefined();
    expect(step.on_action).toBeUndefined();
  });

  test('compiles lifecycle response ACTIONS for ON_START and COMPLETE', () => {
    const ir = compileFromDSL(
      `
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

ON_START:
  RESPOND: "Welcome"
    ACTIONS:
      - BUTTON: "Start" -> start_flow

COMPLETE:
  - WHEN: finished == true
    RESPOND: "Done"
      ACTIONS:
        - BUTTON: "Download" -> download_receipt
`,
      'Test_Agent',
    );

    expect(ir.on_start?.actions).toMatchObject({
      elements: [{ id: 'start_flow', type: 'button', label: 'Start', value: 'start_flow' }],
    });
    expect(ir.completion?.conditions[0].actions).toMatchObject({
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
});

describe('Carousel IR compilation', () => {
  test('compiles CAROUSEL to CarouselIR in rich_content', () => {
    const ir = compileFromDSL(
      `
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

FLOW:
  step1:
    REASONING: false
    RESPOND: "Products"
      CAROUSEL:
        - TITLE: "Product A"
          SUBTITLE: "$9.99"
          IMAGE: "https://example.com/a.jpg"
          BUTTONS:
            - BUTTON: "Buy" -> buy_a
        - TITLE: "Product B"
          SUBTITLE: "$14.99"
          BUTTONS:
            - BUTTON: "Buy" -> buy_b
    THEN: done
  done:
    REASONING: false
    RESPOND: "OK"
`,
      'Test_Agent',
    );

    const step = ir.flow!.definitions['step1'];
    expect(step.rich_content).toBeDefined();
    expect(step.rich_content!.carousel).toBeDefined();
    const cards = step.rich_content!.carousel!.cards;
    expect(cards).toHaveLength(2);
    expect(cards[0].title).toBe('Product A');
    expect(cards[0].subtitle).toBe('$9.99');
    expect(cards[0].image_url).toBe('https://example.com/a.jpg');
    expect(cards[0].buttons).toHaveLength(1);
    expect(cards[0].buttons![0].id).toBe('buy_a');
    expect(cards[0].buttons![0].label).toBe('Buy');
    expect(cards[1].title).toBe('Product B');
    expect(cards[1].subtitle).toBe('$14.99');
    expect(cards[1].image_url).toBeUndefined();
    expect(cards[1].buttons).toHaveLength(1);
    expect(cards[1].buttons![0].id).toBe('buy_b');
  });

  test('carousel card without buttons has undefined buttons', () => {
    const ir = compileFromDSL(
      `
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

FLOW:
  step1:
    REASONING: false
    RESPOND: "Info"
      CAROUSEL:
        - TITLE: "Item"
          SUBTITLE: "Description"
    THEN: done
  done:
    REASONING: false
    RESPOND: "OK"
`,
      'Test_Agent',
    );

    const step = ir.flow!.definitions['step1'];
    expect(step.rich_content!.carousel!.cards).toHaveLength(1);
    expect(step.rich_content!.carousel!.cards[0].buttons).toBeUndefined();
  });

  test('carousel with FORMATS combines both in rich_content', () => {
    const ir = compileFromDSL(
      `
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

FLOW:
  step1:
    REASONING: false
    RESPOND: "Products"
      FORMATS:
        MARKDOWN: "**Products**"
      CAROUSEL:
        - TITLE: "Item A"
    THEN: done
  done:
    REASONING: false
    RESPOND: "OK"
`,
      'Test_Agent',
    );

    const step = ir.flow!.definitions['step1'];
    expect(step.rich_content).toBeDefined();
    expect(step.rich_content!.markdown).toBe('**Products**');
    expect(step.rich_content!.carousel).toBeDefined();
    expect(step.rich_content!.carousel!.cards[0].title).toBe('Item A');
  });
});
