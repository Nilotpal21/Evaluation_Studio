import { describe, expect, it } from 'vitest';

import { scaffoldAblAgent } from '../scaffold-generator';
import type {
  AgentArchitecturePlan,
  AgentSpecInput,
  DomainContextInput,
  TopologyOutput,
} from '../types';

describe('scaffold generator tool contracts', () => {
  it('builds structured tool signatures from tool names instead of generic input/result stubs', () => {
    const result = scaffoldAblAgent(
      plan(),
      topology(),
      spec(['get_order', 'create_replacement']),
      domain(),
    );

    expect(result.skeleton.tools.map((tool) => tool.signatureLiteral)).toEqual([
      'get_order(order_id: string) -> { status: string, last_scan_at: string, promised_delivery_date: string, eligible_options: string }',
      'create_replacement(order_id: string, reason: string) -> { success: boolean, replacement_id: string, promised_delivery_date: string }',
    ]);
    expect(result.skeleton.tools.map((tool) => tool.signatureLiteral).join('\n')).not.toContain(
      '(input: string) -> { result: string }',
    );
  });

  it('uses source fixture shapes for tool signatures when available', () => {
    const result = scaffoldAblAgent(
      plan(),
      topology(),
      spec(['get_order']),
      domain({
        sourceToolFixtures: [
          {
            toolName: 'get_order',
            sampleInput: { order_id: 'VM-1001' },
            response: JSON.stringify({
              order_id: 'VM-1001',
              status: 'delayed',
              items: [{ sku: 'BATTERY' }],
              ship_to: { city: 'Austin' },
              carrier: 'UPS',
            }),
          },
          {
            toolName: 'get_order',
            sampleInput: { customer_id: 'CUST-42' },
            response: JSON.stringify({
              tracking_number: '1Z999',
              last_scan: 'Departed facility',
              last_scan_at: '2026-05-17T12:00:00Z',
              promised_delivery_date: '2026-05-18',
              payment_status: 'paid',
            }),
          },
        ],
      }),
    );

    expect(result.skeleton.tools[0]?.signatureLiteral).toBe(
      'get_order(order_id: string, customer_id: string) -> { order_id: string, status: string, items: object[], ship_to: object, carrier: string, tracking_number: string, last_scan: string, last_scan_at: string, promised_delivery_date: string, payment_status: string }',
    );
  });

  it('uses source catalog signatures and explicit call guidance for tool descriptions', () => {
    const result = scaffoldAblAgent(
      plan(),
      topology(),
      spec(['get_order']),
      domain({
        sourceTools: [
          {
            name: 'get_order',
            signature:
              'get_order(order_id: string, customer_id: string) -> { status: string, carrier: string }',
            description: 'Fetch the latest order state.',
            callWhen: ['customer asks about delivery status', 'policy needs order state'],
            doNotCallWhen: ['a fresh order lookup already exists this turn'],
          },
        ],
      }),
    );

    expect(result.skeleton.tools[0]?.signatureLiteral).toBe(
      'get_order(order_id: string, customer_id: string) -> { status: string, carrier: string }',
    );
    expect(result.skeleton.tools[0]?.descriptionLiteral).toBe(
      'Fetch the latest order state. Call when customer asks about delivery status; policy needs order state. Do not call when a fresh order lookup already exists this turn.',
    );
  });

  it('normalizes namespaced source catalog signatures before emission', () => {
    const result = scaffoldAblAgent(
      plan(),
      topology(),
      spec(['claims_core.get_status']),
      domain({
        sourceTools: [
          {
            name: 'claims_core.get_status',
            signature:
              'claims_core.get_status(claim_id: string, customer_id: string) -> { claim_id: string, status: string }',
            description: 'Fetch claim status from the claims core.',
          },
        ],
      }),
    );

    expect(result.skeleton.tools[0]?.signatureLiteral).toBe(
      'claims_core_get_status(claim_id: string, customer_id: string) -> { claim_id: string, status: string }',
    );
  });

  it('preserves optional, default, and non-object source signature shapes', () => {
    const result = scaffoldAblAgent(
      plan(),
      topology(),
      spec(['search_hotels', 'check_blackout_dates']),
      domain({
        sourceTools: [
          {
            name: 'search_hotels',
            signature:
              'search_hotels(destination: string, checkin: date, checkout: date, guests: number = 2) -> Hotel[]',
          },
          {
            name: 'check_blackout_dates',
            signature:
              'check_blackout_dates(destination: string, checkin: date, checkout: date) -> { allowed: boolean, reason?: string }',
          },
        ],
        sourceToolFixtures: [
          {
            toolName: 'search_hotels',
            sampleInput: { destination: 'Austin' },
            response: JSON.stringify({ hotels: [{ name: 'The Archer' }], total: 1 }),
          },
        ],
      }),
    );

    expect(result.skeleton.tools.map((tool) => tool.signatureLiteral)).toEqual([
      'search_hotels(destination: string, checkin: date, checkout: date, guests: number = 2) -> Hotel[]',
      'check_blackout_dates(destination: string, checkin: date, checkout: date) -> { allowed: boolean, reason?: string }',
    ]);
  });

  it('merges source catalog signatures with fixture-only fields and gathers required inputs', () => {
    const result = scaffoldAblAgent(
      plan({ agentName: 'RefundSpecialist' }),
      topology({
        agents: [
          {
            name: 'RefundSpecialist',
            role: 'refund specialist',
            executionMode: 'hybrid',
            tools: ['issue_refund'],
            gatherFields: ['order_id'],
          },
        ],
        edges: [],
        entryPoint: 'RefundSpecialist',
      }),
      spec(['issue_refund'], {
        name: 'RefundSpecialist',
        role: 'refund specialist',
        isEntry: true,
        gatherFields: ['order_id'],
      }),
      domain({
        sourceTools: [
          {
            name: 'issue_refund',
            signature:
              'issue_refund(order_id: string, refund_amount: number) -> { refund_id: string }',
          },
        ],
        sourceToolFixtures: [
          {
            toolName: 'issue_refund',
            sampleInput: { reason: 'lost_in_transit' },
            response: JSON.stringify({ status: 'issued', refund_eta: '3 business days' }),
          },
        ],
      }),
    );

    expect(result.skeleton.tools[0]?.signatureLiteral).toBe(
      'issue_refund(order_id: string, refund_amount: number, reason: string) -> { refund_id: string, status: string, refund_eta: string }',
    );
    expect(result.skeleton.tools[0]?.paramDescriptions).toEqual(
      expect.objectContaining({
        order_id: expect.any(String),
        refund_amount: expect.any(String),
        reason: expect.any(String),
      }),
    );
    expect(result.skeleton.gatherFields.map((field) => field.name)).toEqual([
      'order_id',
      'refund_amount',
      'reason',
    ]);
  });

  it('does not turn shared/session source fields from tool contracts into customer gather slots', () => {
    const result = scaffoldAblAgent(
      plan({
        gather: {
          required: true,
          reason: 'customer must identify the order',
          suggestedFields: ['order_id'],
        },
      }),
      topology(),
      spec(['get_order'], {
        gatherFields: ['order_id'],
      }),
      domain({
        sharedMemoryVariables: ['customer_id'],
        sourceTools: [
          {
            name: 'get_order',
            signature:
              'get_order(order_id: string, customer_id: string) -> { status: string, carrier: string }',
          },
        ],
      }),
    );

    expect(result.skeleton.tools[0]?.signatureLiteral).toBe(
      'get_order(order_id: string, customer_id: string) -> { status: string, carrier: string }',
    );
    expect(result.skeleton.gatherFields.map((field) => field.name)).toEqual(['order_id']);
  });

  it('does not emit delegation-as-tool stubs for represented handoff targets', () => {
    const result = scaffoldAblAgent(
      plan({
        agentName: 'SupportRouter',
        archetype: 'supervisor',
        keyword: 'SUPERVISOR',
        isEntry: true,
        handoffs: {
          targets: [
            {
              to: 'PolicyAdvisor',
              edgeType: 'delegate',
              returnExpected: true,
              condition: 'policy',
            },
            {
              to: 'FulfillmentSpecialist',
              edgeType: 'delegate',
              returnExpected: true,
              condition: 'fulfillment',
            },
          ],
          needsCatchAll: false,
          catchAllTarget: undefined,
        },
      }),
      topology({
        agents: [
          {
            name: 'SupportRouter',
            role: 'support router',
            executionMode: 'hybrid',
            description: 'Route support questions.',
            tools: ['consult_policy_advisor', 'delegate_to_fulfillment', 'get_order'],
            gatherFields: [],
          },
          {
            name: 'PolicyAdvisor',
            role: 'policy',
            executionMode: 'reasoning',
            description: 'Answer policy questions.',
          },
          {
            name: 'FulfillmentSpecialist',
            role: 'fulfillment',
            executionMode: 'reasoning',
            description: 'Resolve fulfillment questions.',
          },
        ],
        edges: [
          {
            from: 'SupportRouter',
            to: 'PolicyAdvisor',
            type: 'delegate',
            condition: 'policy',
            expectReturn: true,
          },
          {
            from: 'SupportRouter',
            to: 'FulfillmentSpecialist',
            type: 'delegate',
            condition: 'fulfillment',
            expectReturn: true,
          },
        ],
        entryPoint: 'SupportRouter',
      }),
      spec(['consult_policy_advisor', 'delegate_to_fulfillment', 'get_order'], {
        name: 'SupportRouter',
        role: 'support router',
        isEntry: true,
      }),
      domain(),
    );

    expect(result.skeleton.tools.map((tool) => tool.name)).toEqual(['get_order']);
  });

  it('uses topology edges as a fallback when filtering relationship tool stubs', () => {
    const result = scaffoldAblAgent(
      plan({
        agentName: 'SupportRouter',
        archetype: 'specialist',
        keyword: 'AGENT',
      }),
      topology({
        agents: [
          {
            name: 'SupportRouter',
            role: 'support router',
            executionMode: 'hybrid',
            description: 'Route support questions.',
            tools: ['consult_policy_advisor', 'get_order'],
            gatherFields: [],
          },
          {
            name: 'PolicyAdvisor',
            role: 'policy',
            executionMode: 'reasoning',
            description: 'Answer policy questions.',
          },
        ],
        edges: [
          {
            from: 'SupportRouter',
            to: 'PolicyAdvisor',
            type: 'delegate',
            condition: 'policy',
            expectReturn: true,
          },
        ],
        entryPoint: 'SupportRouter',
      }),
      spec(['consult_policy_advisor', 'get_order'], {
        name: 'SupportRouter',
        role: 'support router',
      }),
      domain(),
    );

    expect(result.skeleton.tools.map((tool) => tool.name)).toEqual(['get_order']);
  });

  it('does not scaffold context-provided fields as customer-facing GATHER prompts', () => {
    const result = scaffoldAblAgent(
      plan({
        gather: {
          required: true,
          reason: 'test',
          suggestedFields: ['order_id', 'resolution_choice'],
        },
      }),
      topology(),
      spec([], {
        gatherFields: ['order_id', 'resolution_choice'],
        gatherFieldSources: {
          order_id: 'context',
          resolution_choice: 'user',
        },
      }),
      domain(),
    );

    expect(result.skeleton.gatherFields.map((field) => field.name)).toEqual(['resolution_choice']);
    expect(result.skeleton.memorySessionVars).toEqual(['resolution_choice']);
  });

  it('does not scaffold customer-facing gather for silent delegate targets', () => {
    const result = scaffoldAblAgent(
      plan({
        agentName: 'PolicyAdvisor',
        complete: { required: true, reason: 'returns policy advice' },
        gather: {
          required: true,
          reason: 'would normally infer intake',
          suggestedFields: ['order_number', 'request_summary'],
        },
      }),
      topology({
        agents: [
          {
            name: 'Alex',
            role: 'support supervisor',
            executionMode: 'hybrid',
            description: 'Routes support questions.',
          },
          {
            name: 'PolicyAdvisor',
            role: 'internal policy advisor',
            executionMode: 'reasoning',
            description: 'Policy eligibility analysis.',
            tools: ['search_policies'],
            gatherFields: ['order_number', 'request_summary'],
          },
        ],
        edges: [
          {
            from: 'Alex',
            to: 'PolicyAdvisor',
            type: 'delegate',
            experienceMode: 'silent_delegate',
            condition: 'policy_needed',
            expectReturn: true,
          },
        ],
        entryPoint: 'Alex',
      }),
      spec(['search_policies'], {
        name: 'PolicyAdvisor',
        role: 'internal policy advisor',
        description: 'Policy eligibility analysis.',
        gatherFields: ['order_number', 'request_summary'],
      }),
      domain(),
    );

    expect(result.skeleton.gatherFields).toEqual([]);
    expect(result.skeleton.memorySessionVars).toEqual([]);
    expect(result.prompt).toContain('silent delegate target');
    expect(result.prompt).toContain('must not ask customer-facing intake questions');
  });

  it('uses reasoning runtime for read-only decision agents', () => {
    const result = scaffoldAblAgent(
      plan({
        agentName: 'PolicyAdvisor',
      }),
      topology(),
      spec(['search_policies'], {
        name: 'PolicyAdvisor',
        role: 'internal policy advisor',
        executionMode: 'reasoning',
        description: 'Analyze policy eligibility and recommend options.',
      }),
      domain(),
    );

    expect(result.skeleton.runtimePattern).toBe('reasoning');
  });

  it('disables side-effect confirmation when conversational consent is already established', () => {
    const result = scaffoldAblAgent(
      plan({
        agentName: 'FulfillmentSpecialist',
      }),
      topology({
        agents: [
          {
            name: 'Alex',
            role: 'support supervisor',
            executionMode: 'hybrid',
            description: 'Routes support questions.',
          },
          {
            name: 'FulfillmentSpecialist',
            role: 'fulfillment',
            executionMode: 'reasoning',
            description: 'Create replacement after customer confirms the replacement.',
            tools: ['create_replacement'],
          },
        ],
        edges: [
          {
            from: 'Alex',
            to: 'FulfillmentSpecialist',
            type: 'delegate',
            experienceMode: 'silent_delegate',
            condition: 'replacement_confirmed',
            expectReturn: true,
          },
        ],
        entryPoint: 'Alex',
      }),
      spec(['create_replacement'], {
        name: 'FulfillmentSpecialist',
        role: 'fulfillment',
        description: 'Create replacement after customer confirms the replacement.',
      }),
      domain(),
    );

    expect(result.skeleton.tools[0]?.confirmPolicy).toBe('never');
  });

  it('uses source consent policies instead of side-effect confirmation templates', () => {
    const result = scaffoldAblAgent(
      plan({
        agentName: 'FulfillmentSpecialist',
      }),
      topology({
        agents: [
          {
            name: 'FulfillmentSpecialist',
            role: 'fulfillment',
            executionMode: 'hybrid',
            description: 'Execute selected fulfillment actions.',
            tools: ['issue_refund'],
          },
        ],
        edges: [],
        entryPoint: 'FulfillmentSpecialist',
      }),
      spec(['issue_refund'], {
        name: 'FulfillmentSpecialist',
        role: 'fulfillment',
        description: 'Execute selected fulfillment actions.',
      }),
      domain({
        consentPolicies: [
          {
            toolName: 'issue_refund',
            action: 'issue refund',
            mode: 'when_side_effects',
            requiredIn: 'conversation',
            scopeFields: ['order_id', 'refund_amount'],
            fallback: 'explicit_prompt',
          },
        ],
      }),
    );

    expect(result.skeleton.tools[0]?.sideEffects).toBe(true);
    expect(result.skeleton.tools[0]?.confirmPolicy).toBe('never');
  });

  it('treats source consent policies as side-effect evidence when verbs are ambiguous', () => {
    const result = scaffoldAblAgent(
      plan({
        agentName: 'InventorySpecialist',
      }),
      topology({
        agents: [
          {
            name: 'InventorySpecialist',
            role: 'fulfillment',
            executionMode: 'hybrid',
            description: 'Reserve inventory after customer approval.',
            tools: ['reserve_inventory'],
          },
        ],
        edges: [],
        entryPoint: 'InventorySpecialist',
      }),
      spec(['reserve_inventory'], {
        name: 'InventorySpecialist',
        role: 'fulfillment',
        description: 'Reserve inventory after customer approval.',
      }),
      domain({
        consentPolicies: [
          {
            toolName: 'reserve_inventory',
            action: 'inventory reservation',
            mode: 'when_side_effects',
            requiredIn: 'explicit_prompt',
            scopeFields: ['order_id', 'sku'],
            fallback: 'block',
          },
        ],
      }),
    );

    expect(result.skeleton.tools[0]?.sideEffects).toBe(true);
    expect(result.skeleton.tools[0]?.confirmPolicy).toBe('when_side_effects');
  });

  it('keeps entry welcomes short and channel-shaped', () => {
    const chatResult = scaffoldAblAgent(
      plan({ isEntry: true }),
      topology(),
      spec([], { isEntry: true }),
      domain({ channels: ['web_chat'] }),
    );
    const voiceResult = scaffoldAblAgent(
      plan({ isEntry: true }),
      topology(),
      spec([], { isEntry: true }),
      domain({ channels: ['voice', 'web_chat'] }),
    );

    expect(chatResult.skeleton.onStartRespond).toBe('Hi. What can I help with?');
    expect(voiceResult.skeleton.onStartRespond).toBe('Hi, how can I help?');
    expect(chatResult.skeleton.onStartRespond?.split(/\s+/)).toHaveLength(6);
    expect(voiceResult.skeleton.onStartRespond?.split(/\s+/)).toHaveLength(5);
  });

  it('attaches generated channel and empathy profiles only to customer-facing agents', () => {
    const customerFacing = scaffoldAblAgent(
      plan({
        agentName: 'Alex',
        archetype: 'supervisor',
        keyword: 'SUPERVISOR',
        isEntry: true,
      }),
      topology({
        agents: [
          {
            name: 'Alex',
            role: 'support supervisor',
            executionMode: 'hybrid',
            description: 'Entry support agent.',
          },
          {
            name: 'PolicyAdvisor',
            role: 'policy advisor',
            executionMode: 'reasoning',
            description: 'Internal policy advice.',
          },
        ],
        edges: [
          {
            from: 'Alex',
            to: 'PolicyAdvisor',
            type: 'delegate',
            experienceMode: 'silent_delegate',
            condition: 'policy_needed',
            expectReturn: true,
          },
        ],
        entryPoint: 'Alex',
      }),
      spec([], { name: 'Alex', role: 'support supervisor', isEntry: true }),
      domain({
        channels: ['Web Chat', 'Voice'],
        universalRules: [
          'Use plain language and avoid jargon.',
          'Lead with empathy when the customer is frustrated.',
        ],
      }),
    );
    const silentDelegate = scaffoldAblAgent(
      plan({ agentName: 'PolicyAdvisor' }),
      topology({
        agents: [
          {
            name: 'Alex',
            role: 'support supervisor',
            executionMode: 'hybrid',
            description: 'Entry support agent.',
          },
          {
            name: 'PolicyAdvisor',
            role: 'policy advisor',
            executionMode: 'reasoning',
            description: 'Internal policy advice.',
          },
        ],
        edges: [
          {
            from: 'Alex',
            to: 'PolicyAdvisor',
            type: 'delegate',
            experienceMode: 'silent_delegate',
            condition: 'policy_needed',
            expectReturn: true,
          },
        ],
        entryPoint: 'Alex',
      }),
      spec([], { name: 'PolicyAdvisor', role: 'policy advisor' }),
      domain({
        channels: ['Web Chat', 'Voice'],
        universalRules: [
          'Use plain language and avoid jargon.',
          'Lead with empathy when the customer is frustrated.',
        ],
      }),
    );

    expect(customerFacing.skeleton.behaviorProfileUses).toEqual([
      'plain_language',
      'voice_compact',
      'frustration_empathy',
    ]);
    expect(silentDelegate.skeleton.behaviorProfileUses).toEqual([]);
  });

  it('keeps shared voice and handoff continuity out of specialist persona prose', () => {
    const result = scaffoldAblAgent(
      plan({
        complete: { required: true, reason: 'return after resolution' },
        gather: {
          required: true,
          reason: 'needs order context',
          suggestedFields: ['order_id'],
        },
      }),
      topology({
        agents: [
          {
            name: 'SupportRouter',
            role: 'support router',
            executionMode: 'hybrid',
            description: 'Routes support questions.',
          },
          {
            name: 'OrderSpecialist',
            role: 'orders',
            executionMode: 'reasoning',
            description: 'Resolve order questions.',
            tools: ['get_order'],
            gatherFields: ['order_id'],
          },
        ],
        edges: [
          {
            from: 'SupportRouter',
            to: 'OrderSpecialist',
            type: 'delegate',
            condition: 'orders',
            expectReturn: true,
          },
        ],
        entryPoint: 'SupportRouter',
      }),
      spec(['get_order'], { gatherFields: ['order_id'] }),
      domain(),
    );

    expect(result.prompt).toContain('should live in behavior profiles when authored');
    expect(result.prompt).toContain('instead of duplicating global voice rules');
    expect(result.prompt).not.toContain('do not introduce a new person');
  });
});

function plan(overrides: Partial<AgentArchitecturePlan> = {}): AgentArchitecturePlan {
  return {
    agentName: 'OrderSpecialist',
    archetype: 'specialist',
    keyword: 'AGENT',
    isEntry: false,
    gather: { required: false, reason: 'test', suggestedFields: [] },
    complete: { required: false, reason: 'test' },
    complexity: {
      selectedExecutionMode: 'reasoning',
      level: 'structured',
      reason: 'test',
      signals: [],
    },
    flow: { recommended: true, reason: 'test', executionMode: 'reasoning' },
    handoffs: { targets: [], needsCatchAll: false, catchAllTarget: undefined },
    allowedPassFields: [],
    blocked: [],
    localTopology: { agents: [], edges: [] },
    ...overrides,
  };
}

function topology(overrides: Partial<TopologyOutput> = {}): TopologyOutput {
  return {
    agents: [
      {
        name: 'OrderSpecialist',
        role: 'orders',
        executionMode: 'reasoning',
        description: 'Resolve order questions.',
        tools: ['get_order', 'create_replacement'],
        gatherFields: [],
      },
    ],
    edges: [],
    entryPoint: 'OrderSpecialist',
    ...overrides,
  };
}

function spec(tools: string[], overrides: Partial<AgentSpecInput> = {}): AgentSpecInput {
  return {
    name: 'OrderSpecialist',
    role: 'orders',
    executionMode: 'reasoning',
    description: 'Resolve order questions.',
    tools,
    gatherFields: [],
    isEntry: false,
    ...overrides,
  };
}

function domain(overrides: Partial<DomainContextInput> = {}): DomainContextInput {
  return {
    domain: 'VoltMart',
    channels: ['web_chat'],
    compliance: [],
    integrations: [],
    tone: 'warm',
    ...overrides,
  };
}
