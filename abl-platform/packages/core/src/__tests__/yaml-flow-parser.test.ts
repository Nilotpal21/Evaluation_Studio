import { describe, it, expect } from 'vitest';
import { parseYamlABL } from '../parser/yaml-parser.js';

describe('YAML flow parser', () => {
  it('parses a simple flow with steps and transitions', () => {
    const yaml = `
agent: booking_agent
goal: Help users book hotels

flow:
  entry_point: greeting
  steps:
    greeting:
      reasoning: false
      respond: "Welcome! How can I help?"
      then: search

    search:
      reasoning: false
      gather:
        fields:
          - name: destination
            type: string
            required: true
          - name: check_in
            type: string
      then: confirm

    confirm:
      reasoning: false
      respond: "Booking confirmed!"
`;
    const result = parseYamlABL(yaml);
    expect(result.errors).toHaveLength(0);
    expect(result.document).toBeDefined();
    expect(result.document!.flow).toBeDefined();
    expect(result.document!.flow!.entryPoint).toBe('greeting');
    expect(result.document!.flow!.steps).toEqual(['greeting', 'search', 'confirm']);
    expect(Object.keys(result.document!.flow!.definitions)).toHaveLength(3);

    const greeting = result.document!.flow!.definitions['greeting'];
    expect(greeting.respond).toBe('Welcome! How can I help?');
    expect(greeting.then).toBe('search');

    const search = result.document!.flow!.definitions['search'];
    expect(search.gather).toBeDefined();
    expect(search.gather!.fields).toHaveLength(2);
    expect(search.gather!.fields[0].name).toBe('destination');
    expect(search.gather!.fields[0].type).toBe('string');
    expect(search.gather!.fields[0].required).toBe(true);
    expect(search.then).toBe('confirm');
  });

  it('parses flow step with CALL and ON_SUCCESS/ON_FAILURE', () => {
    const yaml = `
agent: test_agent
goal: "Test goal"
flow:
  steps:
    do_search:
      reasoning: false
      call: search_hotels
      on_success:
        respond: "Found results!"
        then: present
      on_failure:
        respond: "Search failed, please try again."
        then: do_search
`;
    const result = parseYamlABL(yaml);
    expect(result.errors).toHaveLength(0);
    const step = result.document!.flow!.definitions['do_search'];
    expect(step.call).toBe('search_hotels');
    expect(step.onSuccess).toBeDefined();
    expect(step.onSuccess!.respond).toBe('Found results!');
    expect(step.onSuccess!.then).toBe('present');
    expect(step.onFailure).toBeDefined();
    expect(step.onFailure!.respond).toBe('Search failed, please try again.');
    expect(step.onFailure!.then).toBe('do_search');
  });

  it('parses flow step actions and ordered ON_ACTION handlers', () => {
    const yaml = `
agent: supervisor_agent
goal: "Route customers to specialists"
flow:
  steps:
    choose_agent:
      reasoning: false
      respond: "Choose an agent"
      actions:
        elements:
          - type: button
            id: agent_a
            label: "Agent A"
            value: "Agent_A"
            description: "Route to Agent A"
      on_action:
        agent_a:
          condition: '_action.value == "Agent_A"'
          do:
            - set:
                selected_agent: '"Agent_A"'
            - clear:
                - draft_agent
            - respond: "Routing to Agent A..."
            - call_spec:
                tool: audit_selection
                with:
                  selected: _action.value
                as: audit_result
            - handoff: Agent_A
        agent_b:
          do:
            - delegate: Agent_B
              return: true
              on_return:
                map:
                  answer: agent_b_answer
            - complete: true
`;

    const result = parseYamlABL(yaml);
    expect(result.errors).toHaveLength(0);

    const step = result.document!.flow!.definitions['choose_agent'];
    expect(step.actions).toEqual({
      elements: [
        {
          id: 'agent_a',
          type: 'button',
          label: 'Agent A',
          value: 'Agent_A',
          description: 'Route to Agent A',
        },
      ],
    });
    expect(step.onAction).toHaveLength(2);
    expect(step.onAction![0]).toMatchObject({
      actionId: 'agent_a',
      condition: '_action.value == "Agent_A"',
      do: [
        { set: { selected_agent: '"Agent_A"' } },
        { clear: ['draft_agent'] },
        { respond: 'Routing to Agent A...' },
        {
          callSpec: {
            tool: 'audit_selection',
            with: { selected: '_action.value' },
            as: 'audit_result',
          },
        },
        { handoff: 'Agent_A' },
      ],
    });
    expect(step.onAction![1]).toMatchObject({
      actionId: 'agent_b',
      do: [
        {
          delegate: 'Agent_B',
          return: true,
          onReturn: { map: { answer: 'agent_b_answer' } },
        },
        { complete: true },
      ],
    });
  });

  it('normalizes direct ON_ACTION handler fields into ordered actions', () => {
    const yaml = `
agent: supervisor_agent
goal: "Route customers"
flow:
  steps:
    choose_agent:
      respond: "Choose an agent"
      actions:
        elements:
          - type: button
            id: agent_a
            label: "Agent A"
      on_action:
        agent_a:
          set:
            selected_agent: '"Agent_A"'
          clear:
            - draft_agent
          respond: "Routing to Agent A..."
          call_spec:
            tool: audit_selection
            with:
              selected: _action.value
            as: audit_result
          handoff: Agent_A
        agent_b:
          delegate: Agent_B
          return: TRUE
          on_return:
            map:
              answer: agent_b_answer
          complete: true
`;

    const result = parseYamlABL(yaml);
    expect(result.errors).toHaveLength(0);

    const handlers = result.document!.flow!.definitions['choose_agent'].onAction!;
    expect(handlers[0]).toMatchObject({
      actionId: 'agent_a',
      set: { selected_agent: '"Agent_A"' },
      respond: 'Routing to Agent A...',
      do: [
        { set: { selected_agent: '"Agent_A"' } },
        { clear: ['draft_agent'] },
        { respond: 'Routing to Agent A...' },
        {
          callSpec: {
            tool: 'audit_selection',
            with: { selected: '_action.value' },
            as: 'audit_result',
          },
        },
        { handoff: 'Agent_A' },
      ],
    });
    expect(handlers[1].do).toEqual([
      {
        delegate: 'Agent_B',
        return: true,
        onReturn: { map: { answer: 'agent_b_answer' } },
      },
      { complete: true },
    ]);
  });

  it('parses digressions and sub_intents with canonical call_spec data', () => {
    const yaml = `
agent: booking_agent
goal: "Handle booking changes"
flow:
  steps:
    manage_booking:
      reasoning: false
      digressions:
        - intent: help
          respond: "I can help with that"
          call_spec:
            tool: audit_help
            with:
              source: user_request
            as: help_audit
          resume: true
      sub_intents:
        - intent: change_dates
          respond: "Let's update your dates"
          clear:
            - selected_dates
          set:
            pending_change: "dates"
          call_spec:
            tool: validate_dates
            with:
              bookingId: booking.id
`;

    const result = parseYamlABL(yaml);
    expect(result.errors).toHaveLength(0);

    const step = result.document!.flow!.definitions['manage_booking'];
    expect(step.digressions).toMatchObject([
      {
        intent: 'help',
        respond: 'I can help with that',
        callSpec: {
          tool: 'audit_help',
          with: {
            source: 'user_request',
          },
          as: 'help_audit',
        },
        resume: true,
      },
    ]);
    expect(step.subIntents).toMatchObject([
      {
        intent: 'change_dates',
        respond: "Let's update your dates",
        clear: ['selected_dates'],
        set: {
          pending_change: 'dates',
        },
        callSpec: {
          tool: 'validate_dates',
          with: {
            bookingId: 'booking.id',
          },
        },
      },
    ]);
  });

  it('preserves structured sub_intent and action handler response payloads from YAML', () => {
    const yaml = `
agent: structured_yaml_agent
goal: "Preserve structured response payloads"

action_handlers:
  confirm:
    respond: "Confirmed"
    voice_config:
      plain_text: "Confirmed"
    rich_content:
      markdown: "**Confirmed**"
    actions:
      elements:
        - id: confirm_next
          type: button
          label: "Confirm next"
    do:
      - respond: "Confirmed again"
        voice_config:
          plain_text: "Confirmed again"
        rich_content:
          markdown: "**Confirmed again**"
        actions:
          elements:
            - id: confirm_again
              type: button
              label: "Confirm again"

flow:
  steps:
    collect:
      reasoning: false
      sub_intents:
        - intent: change_destination
          message_key: change_destination
          respond: "Where should we search next?"
          voice_config:
            plain_text: "Where should we search next?"
          rich_content:
            markdown: "**Where next?**"
          actions:
            elements:
              - id: pick_city
                type: button
                label: "Pick city"
`;

    const result = parseYamlABL(yaml);
    expect(result.errors).toHaveLength(0);

    expect(result.document?.actionHandlers?.[0]).toMatchObject({
      actionId: 'confirm',
      respond: 'Confirmed',
      voiceConfig: { plain_text: 'Confirmed' },
      richContent: { markdown: '**Confirmed**' },
      actions: {
        elements: [{ id: 'confirm_next', type: 'button', label: 'Confirm next' }],
      },
      do: [
        {
          respond: 'Confirmed again',
          voiceConfig: { plain_text: 'Confirmed again' },
          richContent: { markdown: '**Confirmed again**' },
          actions: {
            elements: [{ id: 'confirm_again', type: 'button', label: 'Confirm again' }],
          },
        },
      ],
    });
    expect(result.document?.flow?.definitions['collect'].subIntents?.[0]).toMatchObject({
      intent: 'change_destination',
      messageKey: 'change_destination',
      respond: 'Where should we search next?',
      voiceConfig: { plain_text: 'Where should we search next?' },
      richContent: { markdown: '**Where next?**' },
      actions: {
        elements: [{ id: 'pick_city', type: 'button', label: 'Pick city' }],
      },
    });
  });

  it('parses reasoning step metadata and top-level action_handlers from YAML', () => {
    const yaml = `
agent: routing_agent
goal: "Route customer actions"

action_handlers:
  escalate:
    do:
      - respond: "Escalating to a specialist"
      - handoff: human_agent

flow:
  entry_point: choose
  steps:
    choose:
      reasoning: true
      goal: "Identify the correct resolution path"
      available_tools:
        - lookup_customer
        - lookup_case
      exit_when: "resolution_path != null"
      max_turns: 4
      respond: "How can I help?"
`;

    const result = parseYamlABL(yaml);

    expect(result.errors).toHaveLength(0);
    expect(result.document?.actionHandlers).toMatchObject([
      {
        actionId: 'escalate',
        do: [{ respond: 'Escalating to a specialist' }, { handoff: 'human_agent' }],
      },
    ]);

    const step = result.document!.flow!.definitions['choose'];
    expect(step.reasoning).toBe(true);
    expect(step.goal).toBe('Identify the correct resolution path');
    expect(step.availableTools).toEqual(['lookup_customer', 'lookup_case']);
    expect(step.exitWhen).toBe('resolution_path != null');
    expect(step.maxTurns).toBe(4);
  });

  it('parses flow step with SET assignments', () => {
    const yaml = `
agent: test_agent
goal: "Test goal"
flow:
  steps:
    init:
      reasoning: false
      set:
        - variable: greeting_count
          expression: "0"
        - variable: language
          expression: "'en'"
      then: greet
`;
    const result = parseYamlABL(yaml);
    expect(result.errors).toHaveLength(0);
    const step = result.document!.flow!.definitions['init'];
    expect(step.set).toHaveLength(2);
    expect(step.set![0].variable).toBe('greeting_count');
    expect(step.set![0].expression).toBe('0');
  });

  it('parses flow step with WHEN guard condition', () => {
    const yaml = `
agent: test_agent
goal: "Test goal"
flow:
  steps:
    vip_greeting:
      reasoning: false
      when: "context.user.tier == 'vip'"
      respond: "Welcome back, VIP member!"
      then: search
`;
    const result = parseYamlABL(yaml);
    expect(result.errors).toHaveLength(0);
    const step = result.document!.flow!.definitions['vip_greeting'];
    expect(step.when).toBe("context.user.tier == 'vip'");
  });

  it('returns flow as undefined when no flow section exists', () => {
    const yaml = `
agent: reasoning_agent
goal: Help users
`;
    const result = parseYamlABL(yaml);
    expect(result.document!.flow).toBeUndefined();
  });

  it('parses execution pipeline config for supervisor YAML', () => {
    const yaml = `
supervisor: travel_supervisor
goal: Route customers to the right specialist

execution:
  pipeline:
    enabled: true
    mode: parallel
    model: gpt-4.1-mini
    shortCircuit:
      enabled: true
      confidenceThreshold: 0.92
    toolFilter:
      enabled: true
      maxTools: 3
    keywordVeto:
      enabled: true
      keywords:
        - refund
        - fraud
    intentBridge:
      enabled: true
      programmaticThreshold: 0.8
      guidedThreshold: 0.65
      outOfScopeDecline: false
      multiIntentSignal: true
`;

    const result = parseYamlABL(yaml);

    expect(result.errors).toHaveLength(0);
    expect(result.document?.execution?.pipeline).toEqual({
      enabled: true,
      mode: 'parallel',
      model: 'gpt-4.1-mini',
      shortCircuit: {
        enabled: true,
        confidenceThreshold: 0.92,
      },
      toolFilter: {
        enabled: true,
        maxTools: 3,
      },
      keywordVeto: {
        enabled: true,
        keywords: ['refund', 'fraud'],
      },
      intentBridge: {
        enabled: true,
        programmaticThreshold: 0.8,
        guidedThreshold: 0.65,
        outOfScopeDecline: false,
        multiIntentSignal: true,
      },
    });
  });
});
