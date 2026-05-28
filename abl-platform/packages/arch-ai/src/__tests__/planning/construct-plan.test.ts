import { describe, expect, it } from 'vitest';

import { BLUEPRINT_BATTLE_TEST_FIXTURES } from '../../blueprint/index.js';
import {
  deriveProjectConstructPlanFromBlueprint,
  deriveProjectIntelligencePlanFromBlueprint,
  validateProjectConstructPlan,
  validateProjectIntelligenceFit,
  type AgentConstructPlan,
  type ProjectConstructPlan,
} from '../../planning/index.js';

describe('construct-aware generation planning', () => {
  it('derives valid baseline construct plans from all blueprint battle fixtures', () => {
    for (const blueprint of BLUEPRINT_BATTLE_TEST_FIXTURES) {
      const plan = deriveProjectConstructPlanFromBlueprint(blueprint);
      const result = validateProjectConstructPlan(plan);

      expect(plan.projectName).toBe(blueprint.metadata.projectName);
      expect(plan.entryAgentName).toBe(blueprint.topology.entryPoint);
      expect(Object.keys(plan.agents).sort()).toEqual([...blueprint.buildOrder].sort());
      expect(result.issues, blueprint.metadata.projectName).toEqual([]);
      expect(result.valid, blueprint.metadata.projectName).toBe(true);
    }
  });

  it('flags undeclared handoff conditions before ABL rendering', () => {
    const plan = projectPlan({
      Router: {
        ...agentPlan('Router'),
        handoffs: [
          {
            to: 'Specialist',
            when: 'known_issue == true',
            pass: [],
            returnExpected: true,
          },
        ],
      },
      Specialist: {
        ...agentPlan('Specialist'),
        completion: [{ when: 'done == true' }],
        state: [{ name: 'done', value: 'false', source: 'literal' }],
      },
    });

    const result = validateProjectConstructPlan(plan);

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'HANDOFF_WHEN_UNDECLARED_VARIABLE',
          path: 'handoffs.0.when',
        }),
      ]),
    );
  });

  it('requires reusable tool results to declare AS aliases', () => {
    const plan = projectPlan({
      ToolAgent: {
        ...agentPlan('ToolAgent'),
        tools: [
          {
            ref: 'lookup_order',
            signature: 'lookup_order(order_id: string) -> { status: string }',
            purpose: 'Look up order status',
            outputFields: ['status'],
          },
        ],
        gathers: [
          {
            name: 'order_id',
            type: 'string',
            required: true,
            prompt: 'Order?',
            source: 'user',
          },
        ],
        toolCalls: [
          {
            step: 'lookup',
            tool: 'lookup_order',
            with: { order_id: 'order_id' },
            resultFieldsUsed: ['status'],
            onResult: [{ condition: 'orderResult.status == "shipped"', then: 'done' }],
          },
        ],
        flow: [{ name: 'lookup', reasoning: false, call: 'lookup_order', then: 'done' }],
        completion: [{ when: 'order_id != null' }],
      },
    });

    const result = validateProjectConstructPlan(plan);

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('TOOL_RESULT_REUSED_WITHOUT_ALIAS');
  });

  it('allows declared tool aliases, set variables, and ON_RESULT result-field branches', () => {
    const plan = projectPlan({
      ToolAgent: {
        ...agentPlan('ToolAgent'),
        tools: [
          {
            ref: 'lookup_order',
            signature: 'lookup_order(order_id: string) -> { status: string, eta: string }',
            purpose: 'Look up order status',
            outputFields: ['status', 'eta'],
          },
        ],
        gathers: [
          {
            name: 'order_id',
            type: 'string',
            required: true,
            prompt: 'Order?',
            source: 'user',
          },
        ],
        toolCalls: [
          {
            step: 'lookup',
            tool: 'lookup_order',
            with: { order_id: 'order_id' },
            as: 'orderResult',
            resultFieldsUsed: ['orderResult.status', 'orderResult.eta'],
            onResult: [
              {
                condition: 'orderResult.status == "shipped"',
                set: { shipment_eta: 'orderResult.eta' },
                respond: 'Order ships by {{shipment_eta}}',
                then: 'done',
              },
            ],
          },
        ],
        state: [{ name: 'shipment_eta', value: 'orderResult.eta', source: 'tool_result' }],
        flow: [
          { name: 'lookup', reasoning: false, call: 'lookup_order', then: 'done' },
          {
            name: 'done',
            reasoning: false,
            respond: 'Order ships by {{shipment_eta}}',
            complete: true,
          },
        ],
        completion: [{ when: 'shipment_eta != null' }],
      },
    });

    const result = validateProjectConstructPlan(plan);

    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('validates tool branch set expressions and branch targets', () => {
    const plan = projectPlan({
      ToolAgent: {
        ...agentPlan('ToolAgent'),
        tools: [
          {
            ref: 'lookup_ticket',
            signature: 'lookup_ticket(ticket_id: string) -> { status: string }',
            purpose: 'Look up ticket state',
            outputFields: ['status'],
          },
        ],
        gathers: [
          {
            name: 'ticket_id',
            type: 'string',
            required: true,
            prompt: 'Ticket?',
            source: 'user',
          },
        ],
        toolCalls: [
          {
            step: 'lookup',
            tool: 'lookup_ticket',
            with: { ticket_id: 'ticket_id' },
            as: 'ticketResult',
            onSuccess: {
              set: { ticket_status: 'ticketResult.status', broken_field: 'missing_value' },
              then: 'missing_step',
            },
          },
        ],
        flow: [{ name: 'lookup', reasoning: false, call: 'lookup_ticket', then: 'COMPLETE' }],
        completion: [{ when: 'ticket_status != null' }],
      },
    });

    const result = validateProjectConstructPlan(plan);

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'ON_SUCCESS_SET_UNDECLARED_VARIABLE',
          path: 'toolCalls.0.onSuccess.set.broken_field',
        }),
        expect.objectContaining({
          code: 'FLOW_THEN_UNKNOWN_STEP',
          path: 'toolCalls.0.onSuccess.then',
        }),
      ]),
    );
  });

  it('blocks unsupported constructs such as unproven human approval', () => {
    const plan = projectPlan({
      Agent: {
        ...agentPlan('Agent'),
        unsupportedConstructs: [
          {
            construct: 'human_approval',
            reason: 'Runtime path is not proven for generated onboarding agents.',
            alternative: 'Use ESCALATE or human handoff agent.',
          },
        ],
      },
    });

    const result = validateProjectConstructPlan(plan);

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNSUPPORTED_CONSTRUCT',
          path: 'unsupportedConstructs.0.construct',
        }),
      ]),
    );
  });

  it('flags returnable handoffs whose child has no completion path', () => {
    const plan = projectPlan({
      Parent: {
        ...agentPlan('Parent'),
        handoffs: [
          {
            to: 'Child',
            when: 'needs_child == true',
            pass: [],
            returnExpected: true,
          },
        ],
        state: [{ name: 'needs_child', value: 'true', source: 'literal' }],
      },
      Child: {
        ...agentPlan('Child'),
        completion: [],
      },
    });

    const result = validateProjectConstructPlan(plan);

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'RETURN_TARGET_MISSING_COMPLETION',
          path: 'handoffs.0.returnExpected',
        }),
      ]),
    );
  });

  it('derives intelligence profiles and tool-backed construct defaults from blueprints', () => {
    const blueprint = BLUEPRINT_BATTLE_TEST_FIXTURES.find((item) =>
      item.integrations.tools.some((tool) =>
        /lookup|score|create|book|send|submit/i.test(tool.name),
      ),
    );

    expect(blueprint).toBeDefined();
    if (!blueprint) return;

    const intelligence = deriveProjectIntelligencePlanFromBlueprint(blueprint);
    const constructPlan = deriveProjectConstructPlanFromBlueprint(blueprint);
    const result = validateProjectIntelligenceFit(intelligence, constructPlan);

    expect(intelligence.projectName).toBe(blueprint.metadata.projectName);
    expect(Object.keys(intelligence.agents).sort()).toEqual([...blueprint.buildOrder].sort());
    expect(intelligence.orchestration.requiredRuntimeCapabilities).toContain('tool_call_planning');
    expect(Object.values(constructPlan.agents).some((agent) => agent.toolCalls.length > 0)).toBe(
      true,
    );
    expect(result.issues.map((issue) => issue.code)).not.toContain(
      'INTELLIGENCE_TOOL_REQUIRED_BUT_NOT_CALLED',
    );
  });

  it('does not derive canned customer-facing responses for tool-backed defaults', () => {
    const blueprint = BLUEPRINT_BATTLE_TEST_FIXTURES.find((item) =>
      item.integrations.tools.some((tool) =>
        /lookup|score|create|book|send|submit/i.test(tool.name),
      ),
    );

    expect(blueprint).toBeDefined();
    if (!blueprint) return;

    const constructPlan = deriveProjectConstructPlanFromBlueprint(blueprint);
    const normalPathResponses = Object.values(constructPlan.agents)
      .filter((agent) => agent.toolCalls.length > 0)
      .flatMap((agent) => agent.flow.map((step) => step.respond).filter(Boolean));

    expect(normalPathResponses).not.toContain(
      'I will use the available project tools to work on this request.',
    );
    expect(normalPathResponses).not.toContain(
      'I have completed the tool-backed step and saved the result for this case.',
    );
  });

  it('omits default failure responses for tool-backed defaults', () => {
    const blueprint = BLUEPRINT_BATTLE_TEST_FIXTURES.find((item) =>
      item.integrations.tools.some((tool) =>
        /lookup|score|create|book|send|submit/i.test(tool.name),
      ),
    );

    expect(blueprint).toBeDefined();
    if (!blueprint) return;

    const constructPlan = deriveProjectConstructPlanFromBlueprint(blueprint);
    const toolCalls = Object.values(constructPlan.agents).flatMap((agent) => agent.toolCalls);
    const failureBranches = toolCalls
      .map((call) => call.onFailure)
      .filter((branch): branch is NonNullable<(typeof toolCalls)[number]['onFailure']> =>
        Boolean(branch),
      );
    const serializedPlan = JSON.stringify(constructPlan);

    expect(toolCalls.length).toBeGreaterThan(0);
    expect(failureBranches.length).toBeGreaterThan(0);
    expect(failureBranches.every((branch) => branch.respond === undefined)).toBe(true);
    expect(serializedPlan).not.toMatch(/get someone to help|right person|moving this forward/i);
  });

  it('does not plan tool calls for relationships already represented by handoffs', () => {
    const blueprint = structuredClone(BLUEPRINT_BATTLE_TEST_FIXTURES[0]);
    const agentName = blueprint.topology.entryPoint;
    blueprint.perAgent[agentName]!.tools = [
      {
        ref: 'consult_claim_intake',
        purpose: 'Consult the claim intake agent.',
        signature: 'consult_claim_intake(claim_id: string) -> { summary: string }',
        description: 'Duplicate relationship surface.',
      },
      {
        ref: 'delegate_to_fraud_review',
        purpose: 'Delegate to the fraud review agent.',
        signature: 'delegate_to_fraud_review(claim_id: string) -> { summary: string }',
        description: 'Duplicate relationship surface.',
      },
      {
        ref: 'lookup_claim',
        purpose: 'Look up claim status.',
        signature: 'lookup_claim(claim_id: string) -> { status: string }',
        description: 'Look up claim status.',
      },
    ];

    const constructPlan = deriveProjectConstructPlanFromBlueprint(blueprint);
    const agent = constructPlan.agents[agentName];

    expect(agent.tools.map((tool) => tool.ref)).toEqual(['lookup_claim']);
    expect(agent.toolCalls.map((call) => call.tool)).toEqual(['lookup_claim']);
  });

  it('maps transfer edges to handoffs and reserves delegate edges for silent delegation', () => {
    const blueprint = structuredClone(BLUEPRINT_BATTLE_TEST_FIXTURES[0]);
    const edge = blueprint.topology.edges[0];

    expect(edge).toBeDefined();
    if (!edge) return;

    edge.type = 'transfer';
    edge.experienceMode = 'shared_voice_handoff';

    const sharedVoicePlan = deriveProjectConstructPlanFromBlueprint(blueprint).agents[edge.from];

    expect(sharedVoicePlan.handoffs.map((handoff) => handoff.to)).toContain(edge.to);
    expect(sharedVoicePlan.delegates.map((delegate) => delegate.to)).not.toContain(edge.to);

    edge.type = 'delegate';
    edge.experienceMode = 'silent_delegate';
    blueprint.perAgent[edge.from]!.handoffs = [];

    const silentDelegatePlan = deriveProjectConstructPlanFromBlueprint(blueprint).agents[edge.from];

    expect(silentDelegatePlan.handoffs.map((handoff) => handoff.to)).not.toContain(edge.to);
    expect(silentDelegatePlan.delegates.map((delegate) => delegate.to)).toContain(edge.to);
  });

  it('marks fields passed by a parent handoff as context-provided instead of user gather', () => {
    const blueprint = structuredClone(BLUEPRINT_BATTLE_TEST_FIXTURES[0]);
    const edge = blueprint.topology.edges[0];

    expect(edge).toBeDefined();
    if (!edge) return;

    blueprint.perAgent[edge.from]!.handoffs = [
      {
        to: edge.to,
        when: 'intent.category == "claim"',
        context: {
          pass: ['order_id'],
          summary: 'Pass the known order identifier to the specialist.',
        },
        return: true,
      },
    ];
    blueprint.perAgent[edge.to]!.gather.fields = [
      {
        name: 'order_id',
        type: 'string',
        required: true,
        prompt: 'What is the order number?',
      },
      {
        name: 'resolution_choice',
        type: 'string',
        required: true,
        prompt: 'Which resolution would you prefer?',
      },
    ];

    const constructPlan = deriveProjectConstructPlanFromBlueprint(blueprint);
    const target = constructPlan.agents[edge.to];

    expect(target.gathers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'order_id', source: 'context' }),
        expect.objectContaining({ name: 'resolution_choice', source: 'user' }),
      ]),
    );
  });

  it('flags manual construct plans that declare tools but omit tool call behavior', () => {
    const constructPlan = projectPlan({
      ToolAgent: {
        ...agentPlan('ToolAgent'),
        tools: [
          {
            ref: 'lookup_order',
            signature: 'lookup_order(order_id: string) -> { status: string }',
            purpose: 'Look up order status',
            outputFields: ['status'],
          },
        ],
      },
    });

    const result = validateProjectIntelligenceFit(
      {
        projectName: 'ToolProject',
        orchestration: {
          primaryPattern: 'tool_lookup',
          secondaryPatterns: [],
          requiredRuntimeCapabilities: ['tool_call_planning'],
          riskLevel: 'medium',
          rationale: ['test'],
        },
        agents: {
          ToolAgent: {
            agentName: 'ToolAgent',
            responsibility: 'lookup',
            executionMode: 'scripted',
            mustUseFlow: true,
            mustUseTool: true,
            mustConfirmAction: false,
            mustReturnToParent: false,
            mustMaintainState: false,
            mustCreateAuditTrail: false,
            unsupportedNotes: [],
            rationale: ['test'],
          },
        },
      },
      constructPlan,
    );

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'INTELLIGENCE_TOOL_REQUIRED_BUT_NOT_CALLED' }),
        expect.objectContaining({ code: 'INTELLIGENCE_FLOW_REQUIRED_BUT_MISSING' }),
      ]),
    );
  });

  it('accepts a tool-backed scripted agent when flow, call, state, confirmation, and audit signals exist', () => {
    const plan = projectPlan({
      RefundAgent: {
        ...agentPlan('RefundAgent'),
        executionMode: 'scripted',
        gathers: [
          {
            name: 'order_id',
            type: 'string',
            required: true,
            prompt: 'Order?',
            source: 'user',
          },
          {
            name: 'refund_confirmed',
            type: 'boolean',
            required: true,
            prompt: 'Confirm refund?',
            source: 'user',
          },
        ],
        tools: [
          {
            ref: 'apply_refund',
            signature: 'apply_refund(order_id: string) -> { refund_id: string }',
            purpose: 'Apply refund and write audit log',
            outputFields: ['refund_id'],
          },
        ],
        toolCalls: [
          {
            step: 'apply_refund',
            tool: 'apply_refund',
            with: { order_id: 'order_id' },
            as: 'refundResult',
            resultFieldsUsed: ['refundResult.refund_id'],
            onSuccess: {
              set: { refund_id: 'refundResult.refund_id' },
              then: 'done',
            },
          },
        ],
        state: [
          { name: 'refund_id', value: 'refundResult.refund_id', source: 'tool_result' },
          { name: 'audit_log_id', value: '"pending"', source: 'literal' },
        ],
        flow: [
          { name: 'confirm', reasoning: false, then: 'apply_refund' },
          { name: 'apply_refund', reasoning: false, call: 'apply_refund', then: 'done' },
          { name: 'done', reasoning: false, complete: true },
        ],
        completion: [{ when: 'refund_id != null' }],
      },
    });

    const profile = {
      agentName: 'RefundAgent',
      responsibility: 'transact' as const,
      executionMode: 'scripted' as const,
      mustUseFlow: true,
      mustUseTool: true,
      mustConfirmAction: true,
      mustReturnToParent: false,
      mustMaintainState: true,
      mustCreateAuditTrail: true,
      unsupportedNotes: [],
      rationale: ['test'],
    };

    const result = validateProjectIntelligenceFit(
      {
        projectName: 'RefundProject',
        orchestration: {
          primaryPattern: 'transactional_action',
          secondaryPatterns: [],
          requiredRuntimeCapabilities: ['tool_call_planning', 'confirmation_gate'],
          riskLevel: 'high',
          rationale: ['test'],
        },
        agents: { RefundAgent: profile },
      },
      plan,
    );

    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

function projectPlan(agents: Record<string, AgentConstructPlan>): ProjectConstructPlan {
  return {
    projectName: 'TestProject',
    entryAgentName: Object.keys(agents)[0],
    agents,
  };
}

function agentPlan(agentName: string): AgentConstructPlan {
  return {
    agentName,
    executionMode: 'reasoning',
    gathers: [],
    tools: [],
    toolCalls: [],
    state: [],
    flow: [],
    handoffs: [],
    delegates: [],
    escalations: [],
    completion: [{ when: 'true' }],
    unsupportedConstructs: [],
    rationale: ['test'],
  };
}
