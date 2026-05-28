/**
 * Supervisor Composition Tests
 *
 * Verifies that the unified AgentIR design enables:
 * - Supervisors and agents in one registry
 * - Supervisor-to-supervisor delegation (hierarchical composition)
 * - Config-driven supervisor detection (routing rules, not metadata.type)
 * - Entry agent designation via CompilationOutput.entry_agent
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '../../platform/ir/compiler.js';
import type { AgentIR, SupervisorIR, CompilationOutput } from '../../platform/ir/schema.js';

// =============================================================================
// TEST DSL FIXTURES
// =============================================================================

const SUPERVISOR_A_DSL = `
SUPERVISOR: Travel_Supervisor

GOAL: "Route travel requests to specialist supervisors or agents"
PERSONA: "Top-level travel orchestrator"

HANDOFF:
  - TO: Hotel_Supervisor
    WHEN: intent contains "hotel" OR intent contains "stay"
    CONTEXT:
      pass: [destination, dates]
      summary: "Hotel booking request"
    RETURN: true

  - TO: Flight_Agent
    WHEN: intent contains "flight" OR intent contains "fly"
    CONTEXT:
      pass: [destination, date]
      summary: "Flight booking request"
    RETURN: true

  - TO: Support_Agent
    WHEN: intent contains "help" OR intent contains "problem"
    CONTEXT:
      pass: [issue]
      summary: "Support request"
    RETURN: false

COMPLETE:
  - WHEN: handoff.completed == true
    RESPOND: "Anything else I can help with?"
`;

const SUPERVISOR_B_DSL = `
SUPERVISOR: Hotel_Supervisor

GOAL: "Route hotel requests to search or booking agents"
PERSONA: "Hotel department coordinator"

HANDOFF:
  - TO: Hotel_Search_Agent
    WHEN: intent contains "search" OR intent contains "find"
    CONTEXT:
      pass: [destination, checkin, checkout, guests]
      summary: "Hotel search request"
    RETURN: true

  - TO: Hotel_Booking_Agent
    WHEN: intent contains "book" OR intent contains "reserve"
    CONTEXT:
      pass: [hotel_id, checkin, checkout, guests]
      summary: "Hotel booking request"
    RETURN: true

COMPLETE:
  - WHEN: handoff.completed == true
    RESPOND: "Hotel request handled."
`;

const AGENT_C_DSL = `
AGENT: Hotel_Search_Agent

GOAL: "Search for hotels based on user criteria"
PERSONA: "Hotel search specialist"

GATHER:
  destination:
    prompt: "Where would you like to stay?"
    type: string
    required: true
  checkin:
    prompt: "Check-in date?"
    type: date
    required: true

TOOLS:
  search_hotels(destination: string, checkin: string) -> {hotels: array}
    description: "Search for available hotels"

COMPLETE:
  - WHEN: all_fields_gathered == true
    RESPOND: "Here are the available hotels."
`;

const FLIGHT_AGENT_DSL = `
AGENT: Flight_Agent

GOAL: "Search and book flights"
PERSONA: "Flight specialist"

GATHER:
  destination:
    prompt: "Where to?"
    type: string
    required: true

COMPLETE:
  - WHEN: all_fields_gathered == true
    RESPOND: "Flight results ready."
`;

const SUPPORT_AGENT_DSL = `
AGENT: Support_Agent

GOAL: "Handle support requests"
PERSONA: "Support specialist"

COMPLETE:
  - WHEN: issue_resolved == true
    RESPOND: "Issue resolved."
`;

const HOTEL_BOOKING_AGENT_DSL = `
AGENT: Hotel_Booking_Agent

GOAL: "Complete hotel bookings"
PERSONA: "Booking specialist"

COMPLETE:
  - WHEN: booking_confirmed == true
    RESPOND: "Booking confirmed."
`;

// =============================================================================
// HELPERS
// =============================================================================

function parseDSL(dsl: string) {
  const result = parseAgentBasedABL(dsl);
  if (!result.document) {
    throw new Error(`Parse failed: ${result.errors?.join(', ')}`);
  }
  return result.document;
}

function compileAll(...dsls: string[]): CompilationOutput {
  const docs = dsls.map(parseDSL);
  return compileABLtoIR(docs);
}

// =============================================================================
// TESTS
// =============================================================================

describe('Supervisor Composition (Unified AgentIR)', () => {
  // ---------------------------------------------------------------------------
  // 1. UNIFIED AGENTS MAP
  // ---------------------------------------------------------------------------

  describe('1. Unified agents map', () => {
    test('1.1 All agents (including supervisors) are in the agents map', () => {
      const output = compileAll(
        SUPERVISOR_A_DSL,
        SUPERVISOR_B_DSL,
        AGENT_C_DSL,
        FLIGHT_AGENT_DSL,
        SUPPORT_AGENT_DSL,
        HOTEL_BOOKING_AGENT_DSL,
      );

      // All 6 agents should be in the map
      expect(Object.keys(output.agents)).toHaveLength(6);
      expect(output.agents['Travel_Supervisor']).toBeDefined();
      expect(output.agents['Hotel_Supervisor']).toBeDefined();
      expect(output.agents['Hotel_Search_Agent']).toBeDefined();
      expect(output.agents['Flight_Agent']).toBeDefined();
      expect(output.agents['Support_Agent']).toBeDefined();
      expect(output.agents['Hotel_Booking_Agent']).toBeDefined();
    });

    test('1.2 No separate supervisor field on CompilationOutput', () => {
      const output = compileAll(SUPERVISOR_A_DSL, AGENT_C_DSL);
      // The old supervisor field should not exist
      expect((output as any).supervisor).toBeUndefined();
    });

    test('1.3 entry_agent points to the first supervisor', () => {
      const output = compileAll(SUPERVISOR_A_DSL, SUPERVISOR_B_DSL, AGENT_C_DSL);
      expect(output.entry_agent).toBe('Travel_Supervisor');
      expect(output.agents['Travel_Supervisor']).toBeDefined();
      expect(output.agents['Travel_Supervisor'].routing).toBeDefined();
    });

    test('1.4 Multiple supervisors emit an ambiguity compilation error', () => {
      const output = compileAll(SUPERVISOR_A_DSL, SUPERVISOR_B_DSL, AGENT_C_DSL);
      const ambiguityError = output.compilation_errors?.find((error) => {
        return (
          error.type === 'compilation' &&
          error.severity === 'error' &&
          error.message.includes('Multiple supervisors found')
        );
      });

      expect(ambiguityError).toEqual(
        expect.objectContaining({
          agent: 'Travel_Supervisor',
          type: 'compilation',
          severity: 'error',
        }),
      );
      expect(ambiguityError?.message).toContain(
        'Using first supervisor "Travel_Supervisor" deterministically',
      );
      expect(ambiguityError?.message).toContain('Travel_Supervisor, Hotel_Supervisor');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. SUPERVISOR AS AgentIR WITH ROUTING
  // ---------------------------------------------------------------------------

  describe('2. Supervisor is AgentIR with routing config', () => {
    test('2.1 Supervisor has routing rules from HANDOFF definitions', () => {
      const output = compileAll(SUPERVISOR_A_DSL);
      const ir = output.agents['Travel_Supervisor'];

      expect(ir.routing).toBeDefined();
      expect(ir.routing!.rules).toHaveLength(3);
      expect(ir.routing!.rules[0].to).toBe('Hotel_Supervisor');
      expect(ir.routing!.rules[1].to).toBe('Flight_Agent');
      expect(ir.routing!.rules[2].to).toBe('Support_Agent');
    });

    test('2.2 Supervisor has available_agents from handoff targets', () => {
      const output = compileAll(SUPERVISOR_A_DSL);
      const ir = output.agents['Travel_Supervisor'];

      expect(ir.available_agents).toBeDefined();
      expect(ir.available_agents).toContain('Hotel_Supervisor');
      expect(ir.available_agents).toContain('Flight_Agent');
      expect(ir.available_agents).toContain('Support_Agent');
    });

    test('2.3 Routing rules preserve return flag', () => {
      const output = compileAll(SUPERVISOR_A_DSL);
      const ir = output.agents['Travel_Supervisor'];

      // Hotel_Supervisor: RETURN true
      expect(ir.routing!.rules[0].return).toBe(true);
      // Flight_Agent: RETURN true
      expect(ir.routing!.rules[1].return).toBe(true);
      // Support_Agent: RETURN false
      expect(ir.routing!.rules[2].return).toBe(false);
    });

    test('2.4 Routing rules have priority order', () => {
      const output = compileAll(SUPERVISOR_A_DSL);
      const ir = output.agents['Travel_Supervisor'];

      expect(ir.routing!.rules[0].priority).toBe(1);
      expect(ir.routing!.rules[1].priority).toBe(2);
      expect(ir.routing!.rules[2].priority).toBe(3);
    });

    test('2.5 Supervisor has intent_classification config', () => {
      const output = compileAll(SUPERVISOR_A_DSL);
      const ir = output.agents['Travel_Supervisor'];

      expect(ir.routing!.intent_classification).toBeDefined();
      expect(ir.routing!.intent_classification.source).toBe('inferred');
      expect(ir.routing!.intent_classification.categories.length).toBeGreaterThan(0);
    });

    test('2.6 metadata.type is "supervisor" for cosmetic/tooling use', () => {
      const output = compileAll(SUPERVISOR_A_DSL);
      const ir = output.agents['Travel_Supervisor'];
      expect(ir.metadata.type).toBe('supervisor');
    });

    test('2.7 Regular agents have no routing config', () => {
      const output = compileAll(AGENT_C_DSL);
      const ir = output.agents['Hotel_Search_Agent'];

      expect(ir.routing).toBeUndefined();
      expect(ir.available_agents).toBeUndefined();
      expect(ir.metadata.type).toBe('agent');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. SUPERVISOR-TO-SUPERVISOR DELEGATION (KEY UNLOCK)
  // ---------------------------------------------------------------------------

  describe('3. Hierarchical supervisor composition', () => {
    test('3.1 Both supervisors and agents are in one unified registry', () => {
      const output = compileAll(
        SUPERVISOR_A_DSL,
        SUPERVISOR_B_DSL,
        AGENT_C_DSL,
        HOTEL_BOOKING_AGENT_DSL,
      );

      // All four should be accessible by name
      const names = Object.keys(output.agents);
      expect(names).toContain('Travel_Supervisor');
      expect(names).toContain('Hotel_Supervisor');
      expect(names).toContain('Hotel_Search_Agent');
      expect(names).toContain('Hotel_Booking_Agent');
    });

    test('3.2 Top-level supervisor can target another supervisor', () => {
      const output = compileAll(SUPERVISOR_A_DSL, SUPERVISOR_B_DSL);
      const topSupervisor = output.agents['Travel_Supervisor'];

      // Travel_Supervisor → Hotel_Supervisor (which is also a supervisor)
      const hotelRule = topSupervisor.routing!.rules.find((r) => r.to === 'Hotel_Supervisor');
      expect(hotelRule).toBeDefined();
      expect(hotelRule!.return).toBe(true);

      // Hotel_Supervisor is in the same agents map and has its own routing
      const hotelSupervisor = output.agents['Hotel_Supervisor'];
      expect(hotelSupervisor.routing).toBeDefined();
      expect(hotelSupervisor.routing!.rules).toHaveLength(2);
    });

    test('3.3 Nested supervisor has its own handoff targets', () => {
      const output = compileAll(
        SUPERVISOR_A_DSL,
        SUPERVISOR_B_DSL,
        AGENT_C_DSL,
        HOTEL_BOOKING_AGENT_DSL,
      );
      const hotelSupervisor = output.agents['Hotel_Supervisor'];

      expect(hotelSupervisor.available_agents).toContain('Hotel_Search_Agent');
      expect(hotelSupervisor.available_agents).toContain('Hotel_Booking_Agent');
    });

    test('3.4 Full delegation chain is structurally sound', () => {
      const output = compileAll(
        SUPERVISOR_A_DSL,
        SUPERVISOR_B_DSL,
        AGENT_C_DSL,
        HOTEL_BOOKING_AGENT_DSL,
        FLIGHT_AGENT_DSL,
        SUPPORT_AGENT_DSL,
      );

      // Chain: Travel_Supervisor → Hotel_Supervisor → Hotel_Search_Agent
      const travel = output.agents['Travel_Supervisor'];
      const hotel = output.agents['Hotel_Supervisor'];
      const search = output.agents['Hotel_Search_Agent'];

      // Travel can reach Hotel_Supervisor
      expect(travel.routing!.rules.some((r) => r.to === 'Hotel_Supervisor')).toBe(true);
      // Hotel can reach Hotel_Search_Agent
      expect(hotel.routing!.rules.some((r) => r.to === 'Hotel_Search_Agent')).toBe(true);
      // Search is a leaf agent
      expect(search.routing).toBeUndefined();

      // All three are in the same registry
      expect(Object.keys(output.agents)).toContain('Travel_Supervisor');
      expect(Object.keys(output.agents)).toContain('Hotel_Supervisor');
      expect(Object.keys(output.agents)).toContain('Hotel_Search_Agent');
    });
  });

  // ---------------------------------------------------------------------------
  // 4. CONFIG-DRIVEN SUPERVISOR DETECTION
  // ---------------------------------------------------------------------------

  describe('4. Config-driven detection (no type checks needed)', () => {
    test('4.1 Supervisor detected by routing rules presence', () => {
      const output = compileAll(SUPERVISOR_A_DSL);
      const ir = output.agents['Travel_Supervisor'];

      // Config-driven check (what runtime uses)
      const isSupervisor = !!(ir.routing?.rules && ir.routing.rules.length > 0);
      expect(isSupervisor).toBe(true);
    });

    test('4.2 Regular agent NOT detected as supervisor', () => {
      const output = compileAll(AGENT_C_DSL);
      const ir = output.agents['Hotel_Search_Agent'];

      const isSupervisor = !!(ir.routing?.rules && ir.routing.rules.length > 0);
      expect(isSupervisor).toBe(false);
    });

    test('4.3 SupervisorIR type alias narrows correctly', () => {
      const output = compileAll(SUPERVISOR_A_DSL);
      const ir = output.agents['Travel_Supervisor'];

      // Cast to SupervisorIR (type alias) — verifies the narrowing works
      if (ir.routing && ir.available_agents) {
        const supervisorIR = ir as SupervisorIR;
        expect(supervisorIR.routing.rules.length).toBeGreaterThan(0);
        expect(supervisorIR.available_agents.length).toBeGreaterThan(0);
      } else {
        throw new Error('Expected routing and available_agents on supervisor');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 5. DEPLOYMENT AND GRAPH
  // ---------------------------------------------------------------------------

  describe('5. Deployment hints', () => {
    test('5.1 Supervisors get digital runtime recommendation', () => {
      const output = compileAll(SUPERVISOR_A_DSL, AGENT_C_DSL);
      expect(output.deployment.runtime_recommendations['Travel_Supervisor']).toBe('digital');
    });

    test('5.2 Regular agents get appropriate recommendations', () => {
      const output = compileAll(SUPERVISOR_A_DSL, AGENT_C_DSL);
      // Search agent is digital by default (reasoning mode, no voice/hitl hints)
      expect(output.deployment.runtime_recommendations['Hotel_Search_Agent']).toBe('digital');
    });
  });

  // ---------------------------------------------------------------------------
  // 6. BACKWARD COMPATIBILITY
  // ---------------------------------------------------------------------------

  describe('6. Backward compatibility', () => {
    test('6.1 Single agent compilation still works', () => {
      const output = compileAll(AGENT_C_DSL);
      expect(Object.keys(output.agents)).toHaveLength(1);
      expect(output.entry_agent).toBeUndefined();
      expect(output.agents['Hotel_Search_Agent']).toBeDefined();
    });

    test('6.2 Supervisor-only compilation works', () => {
      const output = compileAll(SUPERVISOR_A_DSL);
      expect(Object.keys(output.agents)).toHaveLength(1);
      expect(output.entry_agent).toBe('Travel_Supervisor');
    });

    test('6.3 compileABLtoIR returns version 1.0', () => {
      const output = compileAll(SUPERVISOR_A_DSL, AGENT_C_DSL);
      expect(output.version).toBe('1.0');
      expect(output.compiled_at).toBeDefined();
    });
  });
});
