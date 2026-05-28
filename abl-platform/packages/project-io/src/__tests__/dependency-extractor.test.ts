import { describe, it, expect } from 'vitest';
import { extractDependencies } from '../dependencies/dependency-extractor.js';

const SUPERVISOR_DSL = `SUPERVISOR: TravelDesk_Supervisor
VERSION: "2.0"

GOAL: "Route customers to the right specialist"

HANDOFF:
  - TO: Live_Agent_Transfer
    WHEN: intent.category == "escalation"
    RETURN: false

  - TO: Booking_Manager
    WHEN: user.is_authenticated == true
    RETURN: false

  - TO: Sales_Agent
    WHEN: intent.category == "new_booking"
    RETURN: false

  - TO: Fallback_Handler
    WHEN: intent.unclear == true
    RETURN: true

ESCALATE:
  triggers:
    - WHEN: routing_failures >= 3
      REASON: "Multiple routing failures"
      PRIORITY: high

ON_ERROR:
  routing_failure:
    RESPOND: "I'm having trouble"
    RETRY: 1
    THEN: HANDOFF Live_Agent_Transfer`;

const AGENT_WITH_DELEGATE = `AGENT: Booking_Manager
GOAL: "Handle agent tasks"
VERSION: "2.0"

DELEGATE:
  - AGENT: Fee_Calculator
    WHEN: action_type == "modify"
    PURPOSE: "Calculate fees"

  - AGENT: Refund_Processor
    WHEN: action_type == "cancel"
    PURPOSE: "Process refund"

HANDOFF:
  - TO: Live_Agent_Transfer
    WHEN: user.requests_agent == true
    RETURN: false

  - TO: Sales_Agent
    WHEN: user.wants_new_booking == true
    RETURN: false

CONSTRAINTS:
  always:
    - REQUIRE user.is_authenticated == true
      ON_FAIL: HANDOFF Authentication_Agent`;

const AGENT_WITH_TOOL_IMPORT = `AGENT: HotelSearch
GOAL: "Handle agent tasks"

TOOLS:
  FROM "./tools/hotels-api.tools.abl" USE: search_hotels, get_hotel

  format_results(hotels: Hotel[]) -> string
    description: "Format results"`;

const AGENT_WITH_ACTION_HANDLER_ROUTING = `AGENT: RouterAgent
GOAL: "Handle action-based routing"

FLOW:
  entry_point: choose
  steps:
    - choose

choose:
  REASONING: false
  RESPOND: "Choose a route"
    ACTIONS:
      - BUTTON: "Delegate" -> delegate_btn
  ON_ACTION:
    delegate_btn:
      DO:
        - DELEGATE: StepDelegate
          RETURN: true

ACTION_HANDLERS:
  escalate_btn:
    DO:
      - HANDOFF: GlobalEscalation`;

describe('extractDependencies', () => {
  it('should extract HANDOFF dependencies from supervisor', () => {
    const deps = extractDependencies(SUPERVISOR_DSL);
    const handoffs = deps.filter((d) => d.type === 'handoff');

    expect(handoffs).toHaveLength(4);
    const targets = handoffs.map((d) => d.targetAgent);
    expect(targets).toContain('Live_Agent_Transfer');
    expect(targets).toContain('Booking_Manager');
    expect(targets).toContain('Sales_Agent');
    expect(targets).toContain('Fallback_Handler');
  });

  it('should extract inline HANDOFF from ON_ERROR THEN', () => {
    const deps = extractDependencies(SUPERVISOR_DSL);
    const inlineHandoffs = deps.filter((d) => d.type === 'inline_handoff');

    expect(inlineHandoffs).toHaveLength(1);
    expect(inlineHandoffs[0].targetAgent).toBe('Live_Agent_Transfer');
    expect(inlineHandoffs[0].sourceSection).toBe('ON_ERROR');
  });

  it('should extract DELEGATE dependencies', () => {
    const deps = extractDependencies(AGENT_WITH_DELEGATE);
    const delegates = deps.filter((d) => d.type === 'delegate');

    expect(delegates).toHaveLength(2);
    expect(delegates[0].targetAgent).toBe('Fee_Calculator');
    expect(delegates[1].targetAgent).toBe('Refund_Processor');
  });

  it('should extract HANDOFF from CONSTRAINTS ON_FAIL', () => {
    const deps = extractDependencies(AGENT_WITH_DELEGATE);
    const inlineHandoffs = deps.filter((d) => d.type === 'inline_handoff');

    expect(inlineHandoffs).toHaveLength(1);
    expect(inlineHandoffs[0].targetAgent).toBe('Authentication_Agent');
    expect(inlineHandoffs[0].sourceSection).toBe('CONSTRAINTS');
  });

  it('should extract tool imports', () => {
    const deps = extractDependencies(AGENT_WITH_TOOL_IMPORT);
    const toolImports = deps.filter((d) => d.type === 'tool_import');

    expect(toolImports).toHaveLength(1);
    expect(toolImports[0].sourcePath).toBe('./tools/hotels-api.tools.abl');
    expect(toolImports[0].toolNames).toEqual(['search_hotels', 'get_hotel']);
  });

  it('should extract HANDOFF and DELEGATE dependencies from action handlers', () => {
    const deps = extractDependencies(AGENT_WITH_ACTION_HANDLER_ROUTING);

    expect(deps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'delegate',
          targetAgent: 'StepDelegate',
          sourceSection: 'FLOW',
        }),
        expect.objectContaining({
          type: 'handoff',
          targetAgent: 'GlobalEscalation',
          sourceSection: 'ACTION_HANDLERS',
        }),
      ]),
    );
  });

  it('should deduplicate same-target handoffs', () => {
    // Live_Agent_Transfer appears twice in HANDOFF section of AGENT_WITH_DELEGATE
    const deps = extractDependencies(AGENT_WITH_DELEGATE);
    const handoffToLive = deps.filter(
      (d) => d.type === 'handoff' && d.targetAgent === 'Live_Agent_Transfer',
    );
    expect(handoffToLive).toHaveLength(1);
  });

  it('should extract USE BEHAVIOR_PROFILE references', () => {
    const dsl = `AGENT: Greeter
GOAL: "Greet users"

USE BEHAVIOR_PROFILE: friendly_support

COMPLETE:
  - WHEN: true
    RESPOND: "Hello!"`;

    const deps = extractDependencies(dsl);
    const profileUses = deps.filter((d) => d.type === 'profile_use');

    expect(profileUses).toHaveLength(1);
    expect(profileUses[0].targetAgent).toBe('friendly_support');
  });

  it('should NOT extract HANDOFF-like text from ESCALATE on_human_complete', () => {
    const dsl = `AGENT: Support_Agent
GOAL: "Handle support"

ESCALATE:
  triggers:
    - WHEN: frustration_score > 0.8
      REASON: "High frustration"
      PRIORITY: high
  context_for_human:
    - conversation_summary
  on_human_complete:
    - "HANDOFF to Original_Agent"
    - "RESPOND Thank you for waiting"`;

    const deps = extractDependencies(dsl);

    // No dependencies at all — triggers/context_for_human have no refs,
    // and on_human_complete actions are opaque strings, not real agent refs.
    const handoffs = deps.filter((d) => d.type === 'handoff' || d.type === 'inline_handoff');
    expect(handoffs).toHaveLength(0);
    expect(deps).toHaveLength(0);
  });

  it('should return empty array for agent with no dependencies', () => {
    const simpleDsl = `AGENT: Simple

GOAL: "Do nothing"
COMPLETE:
  - WHEN: true
    RESPOND: "Done"`;

    const deps = extractDependencies(simpleDsl);
    expect(deps).toHaveLength(0);
  });
});
