import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '../../parser/agent-based-parser.js';

function parse(dsl: string) {
  const result = parseAgentBasedABL(dsl);
  expect(result.errors).toHaveLength(0);
  return result.document!;
}

describe('ACTIONS parsing', () => {
  test('parses BUTTON actions with arrow syntax', () => {
    const doc = parse(`
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

FLOW:
  step1:
    REASONING: false
    RESPOND: "Pick a size"
      ACTIONS:
        - BUTTON: "Small" -> select_small
        - BUTTON: "Large" -> select_large
    THEN: step2
  step2:
    REASONING: false
    RESPOND: "Done"
`);
    const step = doc.flow!.definitions['step1'];
    expect(step.actions).toBeDefined();
    expect(step.actions!.elements).toHaveLength(2);
    expect(step.actions!.elements[0]).toMatchObject({
      id: 'select_small',
      type: 'button',
      label: 'Small',
    });
    expect(step.actions!.elements[1]).toMatchObject({
      id: 'select_large',
      type: 'button',
      label: 'Large',
    });
  });

  test('parses BUTTON actions with block id and hidden value', () => {
    const doc = parse(`
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

FLOW:
  step1:
    REASONING: false
    RESPOND: "Pick an agent"
      ACTIONS:
        - BUTTON: "Agent A"
          ID: agent_a
          VALUE: "delegate_payload"
          DESCRIPTION: "Route to Agent A"
    THEN: done
  done:
    REASONING: false
    RESPOND: "OK"
`);
    const step = doc.flow!.definitions['step1'];
    expect(step.actions).toBeDefined();
    expect(step.actions!.elements).toHaveLength(1);
    expect(step.actions!.elements[0]).toMatchObject({
      id: 'agent_a',
      type: 'button',
      label: 'Agent A',
      value: 'delegate_payload',
      description: 'Route to Agent A',
    });
  });

  test('parses SELECT action with OPTIONS', () => {
    const doc = parse(`
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

FLOW:
  step1:
    REASONING: false
    RESPOND: "Choose"
      ACTIONS:
        - SELECT: "Pick color"
          OPTIONS:
            - "Red" -> color_red
            - "Blue" -> color_blue
    THEN: done
  done:
    REASONING: false
    RESPOND: "OK"
`);
    const step = doc.flow!.definitions['step1'];
    expect(step.actions).toBeDefined();
    const sel = step.actions!.elements[0];
    expect(sel.type).toBe('select');
    expect(sel.label).toBe('Pick color');
    expect(sel.options).toHaveLength(2);
    expect(sel.options![0]).toMatchObject({ id: 'color_red', label: 'Red' });
  });

  test('parses SELECT followed by BUTTON in same ACTIONS block', () => {
    const doc = parse(`
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

FLOW:
  step1:
    REASONING: false
    RESPOND: "Configure"
      ACTIONS:
        - SELECT: "Pick color"
          OPTIONS:
            - "Red" -> color_red
            - "Blue" -> color_blue
        - BUTTON: "Submit" -> submit
    THEN: done
  done:
    REASONING: false
    RESPOND: "OK"
`);
    const step = doc.flow!.definitions['step1'];
    expect(step.actions).toBeDefined();
    expect(step.actions!.elements).toHaveLength(2);
    expect(step.actions!.elements[0].type).toBe('select');
    expect(step.actions!.elements[0].label).toBe('Pick color');
    expect(step.actions!.elements[0].options).toHaveLength(2);
    expect(step.actions!.elements[1]).toMatchObject({
      id: 'submit',
      type: 'button',
      label: 'Submit',
    });
  });

  test('parses SELECT without OPTIONS block', () => {
    const doc = parse(`
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

FLOW:
  step1:
    REASONING: false
    RESPOND: "Choose"
      ACTIONS:
        - SELECT: "Pick size"
        - BUTTON: "Go" -> go
    THEN: done
  done:
    REASONING: false
    RESPOND: "OK"
`);
    const step = doc.flow!.definitions['step1'];
    expect(step.actions).toBeDefined();
    expect(step.actions!.elements).toHaveLength(2);
    expect(step.actions!.elements[0].type).toBe('select');
    expect(step.actions!.elements[0].label).toBe('Pick size');
    expect(step.actions!.elements[1]).toMatchObject({
      id: 'go',
      type: 'button',
      label: 'Go',
    });
  });
});

describe('ON_ACTION parsing', () => {
  test('parses ON_ACTION handlers with respond and transition', () => {
    const doc = parse(`
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
    ON_ACTION:
      confirm_yes:
        RESPOND: "Confirmed!"
        TRANSITION: next_step
      confirm_no:
        RESPOND: "Cancelled."
        TRANSITION: cancel_step
  next_step:
    REASONING: false
    RESPOND: "Moving on"
  cancel_step:
    REASONING: false
    RESPOND: "Cancelled"
`);
    const step = doc.flow!.definitions['step1'];
    expect(step.onAction).toBeDefined();
    expect(step.onAction).toHaveLength(2);
    expect(step.onAction![0]).toMatchObject({
      actionId: 'confirm_yes',
      respond: 'Confirmed!',
      transition: 'next_step',
    });
    expect(step.onAction![1]).toMatchObject({
      actionId: 'confirm_no',
      respond: 'Cancelled.',
      transition: 'cancel_step',
    });
  });

  test('parses hyphenated action IDs in ON_ACTION handlers', () => {
    const doc = parse(`
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

FLOW:
  step1:
    REASONING: false
    RESPOND: "Pick"
      ACTIONS:
        - BUTTON: "Buy" -> buy-now
    ON_ACTION:
      buy-now:
        RESPOND: "Bought!"
        TRANSITION: done
  done:
    REASONING: false
    RESPOND: "OK"
`);
    const step = doc.flow!.definitions['step1'];
    expect(step.onAction).toHaveLength(1);
    expect(step.onAction![0].actionId).toBe('buy-now');
  });

  test('parses ON_ACTION DO block with ordered orchestration actions', () => {
    const doc = parse(`
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

FLOW:
  step1:
    REASONING: false
    RESPOND: "Choose"
      ACTIONS:
        - BUTTON: "Agent A" -> agent_a
    ON_ACTION:
      agent_a:
        CONDITION: selected_agent != "Agent_A"
        DO:
          - SET: selected_agent = "Agent_A"
          - CLEAR: [draft_agent]
          - RESPOND: "Routing to Agent A for {{user_name}}..."
            VOICE:
              plain_text: "Routing by voice"
            FORMATS:
              MARKDOWN: "**Routing card**"
            ACTIONS:
              - BUTTON: "Confirm route {{user_name}}" -> confirm_route
          - CALL: audit_selection AS audit_result
          - HANDOFF: Agent_A
  done:
    REASONING: false
    RESPOND: "OK"
`);
    const step = doc.flow!.definitions['step1'];
    expect(step.onAction).toHaveLength(1);
    expect(step.onAction![0]).toMatchObject({
      actionId: 'agent_a',
      condition: 'selected_agent != "Agent_A"',
      do: [
        { set: { selected_agent: '"Agent_A"' } },
        { clear: ['draft_agent'] },
        {
          respond: 'Routing to Agent A for {{user_name}}...',
          voiceConfig: { plainText: 'Routing by voice' },
          richContent: { markdown: '**Routing card**' },
          actions: {
            elements: [
              {
                id: 'confirm_route',
                type: 'button',
                label: 'Confirm route {{user_name}}',
              },
            ],
          },
        },
        {
          call: 'audit_selection',
          resultKey: 'audit_result',
          callSpec: { tool: 'audit_selection', as: 'audit_result' },
        },
        { handoff: 'Agent_A' },
      ],
    });
  });

  test('parses ON_ACTION DO CALL WITH/AS into callSpec', () => {
    const doc = parse(`
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

FLOW:
  step1:
    REASONING: false
    RESPOND: "Choose"
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
`);

    const action = doc.flow!.definitions['step1'].onAction![0].do![0];
    expect(action).toMatchObject({
      call: 'audit_selection',
      resultKey: 'audit_result',
      callSpec: {
        tool: 'audit_selection',
        with: { selected: 'session.selected_agent' },
        as: 'audit_result',
      },
    });
  });

  test('parses direct ON_ACTION fields into canonical ordered actions', () => {
    const doc = parse(`
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

FLOW:
  step1:
    REASONING: false
    RESPOND: "Choose"
      ACTIONS:
        - BUTTON: "Agent A" -> agent_a
    ON_ACTION:
      agent_a:
        SET: selected_agent = "Agent_A"
        RESPOND: "Routing to Agent A..."
        HANDOFF: Agent_A
`);
    const handler = doc.flow!.definitions['step1'].onAction![0];
    expect(handler.set).toEqual({ selected_agent: '"Agent_A"' });
    expect(handler.respond).toBe('Routing to Agent A...');
    expect(handler.do).toEqual([
      { set: { selected_agent: '"Agent_A"' } },
      { respond: 'Routing to Agent A...' },
      { handoff: 'Agent_A' },
    ]);
  });

  test('rejects unknown ON_ACTION handler properties', () => {
    const result = parseAgentBasedABL(`
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

FLOW:
  step1:
    REASONING: false
    RESPOND: "Choose"
      ACTIONS:
        - BUTTON: "Go" -> go
    ON_ACTION:
      go:
        TELEPORT: elsewhere
`);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('Unknown ON_ACTION handler property'),
        }),
      ]),
    );
  });

  test('parses ON_ACTION DELEGATE RETURN case-insensitively', () => {
    const doc = parse(`
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

FLOW:
  step1:
    REASONING: false
    RESPOND: "Choose"
      ACTIONS:
        - BUTTON: "Worker" -> worker
    ON_ACTION:
      worker:
        DO:
          - DELEGATE: Worker_Agent
            RETURN: TRUE
`);

    const handler = doc.flow!.definitions['step1'].onAction![0];
    expect(handler.do).toEqual([{ delegate: 'Worker_Agent', return: true }]);
  });

  test('auto-generated IDs strip non-word characters for handler compatibility', () => {
    const doc = parse(`
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

FLOW:
  step1:
    REASONING: false
    RESPOND: "Pick"
      ACTIONS:
        - BUTTON: "Buy Now!"
    THEN: done
  done:
    REASONING: false
    RESPOND: "OK"
`);
    const step = doc.flow!.definitions['step1'];
    expect(step.actions!.elements[0].id).toBe('buy_now');
  });
});

describe('Lifecycle ACTIONS parsing', () => {
  test('parses ACTIONS under ON_START RESPOND', () => {
    const doc = parse(`
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

ON_START:
  RESPOND: "Welcome"
    ACTIONS:
      - BUTTON: "Start" -> start_flow
`);

    expect(doc.onStart?.actions).toMatchObject({
      elements: [
        {
          id: 'start_flow',
          type: 'button',
          label: 'Start',
          value: 'start_flow',
        },
      ],
    });
  });

  test('parses ACTIONS under COMPLETE RESPOND', () => {
    const doc = parse(`
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

COMPLETE:
  - WHEN: finished == true
    RESPOND: "Done"
      ACTIONS:
        - BUTTON: "Download" -> download_receipt
`);

    expect(doc.complete[0].actions).toMatchObject({
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

describe('CAROUSEL parsing', () => {
  test('parses carousel with cards and buttons', () => {
    const doc = parse(`
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

FLOW:
  step1:
    REASONING: false
    RESPOND: "Our products"
      CAROUSEL:
        - TITLE: "Product A"
          SUBTITLE: "Best seller - $9.99"
          IMAGE: "https://example.com/a.jpg"
          BUTTONS:
            - BUTTON: "Buy" -> buy_a
            - BUTTON: "Details"
              URL: "https://example.com/a"
        - TITLE: "Product B"
          SUBTITLE: "$14.99"
          BUTTONS:
            - BUTTON: "Buy" -> buy_b
    THEN: done
  done:
    REASONING: false
    RESPOND: "Thanks"
`);
    const step = doc.flow!.definitions['step1'];
    expect(step.richContent).toBeDefined();
    expect(step.richContent!.carousel).toBeDefined();
    const cards = step.richContent!.carousel!.cards;
    expect(cards).toHaveLength(2);

    expect(cards[0].title).toBe('Product A');
    expect(cards[0].subtitle).toBe('Best seller - $9.99');
    expect(cards[0].imageUrl).toBe('https://example.com/a.jpg');
    expect(cards[0].buttons).toHaveLength(2);
    expect(cards[0].buttons![0]).toMatchObject({ id: 'buy_a', type: 'button', label: 'Buy' });
    expect(cards[0].buttons![1].label).toBe('Details');
    expect(cards[0].buttons![1].value).toBe('https://example.com/a');

    expect(cards[1].title).toBe('Product B');
    expect(cards[1].subtitle).toBe('$14.99');
    expect(cards[1].buttons).toHaveLength(1);
  });

  test('parses carousel with template variables', () => {
    const doc = parse(`
AGENT: Test_Agent
GOAL: "Test"
PERSONA: "Test"

FLOW:
  step1:
    REASONING: false
    RESPOND: "Results"
      CAROUSEL:
        - TITLE: "{{results.0.name}}"
          SUBTITLE: "{{results.0.price}}"
          BUTTONS:
            - BUTTON: "Select" -> select_0
    THEN: done
  done:
    REASONING: false
    RESPOND: "OK"
`);
    const cards = doc.flow!.definitions['step1'].richContent!.carousel!.cards;
    expect(cards[0].title).toBe('{{results.0.name}}');
    expect(cards[0].subtitle).toBe('{{results.0.price}}');
  });
});
