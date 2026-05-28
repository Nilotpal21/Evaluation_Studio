/**
 * Remote Agent Coordination Tests
 *
 * Tests parsing and compilation of remote agent configuration on HANDOFF and DELEGATE blocks,
 * including the remote_agents registry and project coordination_defaults on CompilationOutput.
 */

import { describe, it, expect } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '../platform/ir/compiler.js';
import type { AgentBasedDocument } from '@abl/core';
import type { CompilationOutput, RemoteAgentLocation } from '../platform/ir/schema.js';

// =============================================================================
// HELPERS
// =============================================================================

function parseDSL(dsl: string) {
  const result = parseAgentBasedABL(dsl);
  expect(result.document).toBeDefined();
  expect(result.errors).toHaveLength(0);
  return result.document!;
}

function compileDSL(
  dsl: string,
  options?: Parameters<typeof compileABLtoIR>[1],
): CompilationOutput {
  const doc = parseDSL(dsl);
  return compileABLtoIR([doc], options);
}

function compileDocs(
  docs: AgentBasedDocument[],
  options?: Parameters<typeof compileABLtoIR>[1],
): CompilationOutput {
  return compileABLtoIR(docs, options);
}

// =============================================================================
// TEST FIXTURES
// =============================================================================

const SUPERVISOR_WITH_REMOTE_HANDOFF = `
SUPERVISOR: Route_Supervisor
  GOAL: Route users to the right agent
  PERSONA: A helpful routing bot

HANDOFF:
  - TO: PaymentAgent
    WHEN: user.wants_payment == true
    LOCATION: remote
    ENDPOINT: "https://payments.example.com/a2a"
    PROTOCOL: a2a
    CONTEXT:
      pass: [user_id, amount]
      summary: "User wants to pay"
    RETURN: true

  - TO: LocalAgent
    WHEN: user.wants_help == true
    CONTEXT:
      pass: [user_id]
      summary: "User needs help"
`;

const AGENT_WITH_LOCAL_HANDOFF = `
AGENT: Support_Agent
  GOAL: Help users with support requests
  PERSONA: A friendly support agent

HANDOFF:
  - TO: BillingAgent
    WHEN: user.billing_issue == true
    CONTEXT:
      pass: [user_id]
      summary: "User has billing issue"
    RETURN: false
`;

const AGENT_WITH_REMOTE_DELEGATE = `
AGENT: Booking_Agent
  GOAL: Help users book flights
  PERSONA: A travel booking specialist

DELEGATE:
  - AGENT: PricingService
    WHEN: needs_pricing == true
    PURPOSE: "Get pricing information"
    INPUT: { route: "route", date: "date" }
    RETURNS: { price: "price", currency: "currency" }
    USE_RESULT: "Use the pricing to inform the user"
    LOCATION: remote
    ENDPOINT: "https://pricing.example.com/api"
    PROTOCOL: rest
`;

const SUPERVISOR_WITH_FULL_REMOTE_FIELDS = `
SUPERVISOR: Full_Remote_Supervisor
  GOAL: Route to remote agents
  PERSONA: A routing bot with full remote config

HANDOFF:
  - TO: RemoteAgent
    WHEN: needs_remote == true
    LOCATION: remote
    ENDPOINT: "https://remote.example.com/a2a"
    PROTOCOL: a2a
    CONTEXT:
      pass: [session_id]
      summary: "Routing to remote agent"
    RETURN: true
`;

const SUPERVISOR_ENDPOINT_AUTO_LOCATION = `
SUPERVISOR: Auto_Location_Supervisor
  GOAL: Route users
  PERSONA: A routing bot

HANDOFF:
  - TO: AutoRemoteAgent
    WHEN: always == true
    ENDPOINT: "https://auto.example.com/agent"
    CONTEXT:
      pass: [user_id]
      summary: "Auto-detected remote"
    RETURN: false
`;

const SUPERVISOR_WITH_UNCONDITIONAL_HANDOFF = `
SUPERVISOR: Unconditional_Handoff_Supervisor
  GOAL: Route users to a specialist
  PERSONA: A routing bot

HANDOFF:
  - TO: ResearchAgent
    RETURN: true
`;

const SUPERVISOR_MIXED_HANDOFFS = `
SUPERVISOR: Mixed_Supervisor
  GOAL: Route to local and remote agents
  PERSONA: A flexible routing bot

HANDOFF:
  - TO: RemotePayments
    WHEN: user.wants_payment == true
    LOCATION: remote
    ENDPOINT: "https://payments.example.com/a2a"
    PROTOCOL: a2a
    CONTEXT:
      pass: [user_id, amount]
      summary: "Process payment remotely"
    RETURN: true

  - TO: LocalSupport
    WHEN: user.wants_support == true
    CONTEXT:
      pass: [user_id]
      summary: "Local support"

  - TO: RemoteAnalytics
    WHEN: user.wants_analytics == true
    LOCATION: remote
    ENDPOINT: "https://analytics.example.com/api"
    PROTOCOL: rest
    CONTEXT:
      pass: [user_id, query]
      summary: "Run analytics remotely"
    RETURN: false
`;

const SUPERVISOR_REMOTE_WITH_HISTORY = `
SUPERVISOR: History_Supervisor
  GOAL: Route with history strategy
  PERSONA: A routing bot

HANDOFF:
  - TO: RemoteWithHistory
    WHEN: needs_context == true
    LOCATION: remote
    ENDPOINT: "https://context.example.com/a2a"
    PROTOCOL: a2a
    CONTEXT:
      pass: [user_id]
      summary: "Handoff with history"
      history: full
    RETURN: true
`;

const SUPERVISOR_REMOTE_WITH_ON_RETURN = `
SUPERVISOR: Return_Supervisor
  GOAL: Route and map return values
  PERSONA: A routing bot

HANDOFF:
  - TO: RemoteWithReturn
    WHEN: needs_result == true
    LOCATION: remote
    ENDPOINT: "https://result.example.com/a2a"
    PROTOCOL: a2a
    CONTEXT:
      pass: [order_id]
      summary: "Process order remotely"
    RETURN: true
    ON_RETURN:
      ACTION: continue
      MAP: { status: order_status, total: order_total }
`;

// =============================================================================
// TESTS: Remote Agent Parsing
// =============================================================================

describe('Remote Agent Coordination', () => {
  describe('Remote Agent Parsing', () => {
    it('should parse HANDOFF with LOCATION: remote, ENDPOINT, PROTOCOL', () => {
      const doc = parseDSL(SUPERVISOR_WITH_REMOTE_HANDOFF);

      const paymentHandoff = doc.handoff.find((h) => h.to === 'PaymentAgent');
      expect(paymentHandoff).toBeDefined();
      expect(paymentHandoff!.remote).toBeDefined();
      expect(paymentHandoff!.remote!.location).toBe('remote');
      expect(paymentHandoff!.remote!.endpoint).toBe('https://payments.example.com/a2a');
      expect(paymentHandoff!.remote!.protocol).toBe('a2a');
    });

    it('should parse HANDOFF without LOCATION (local agent) with no remote field', () => {
      const doc = parseDSL(SUPERVISOR_WITH_REMOTE_HANDOFF);

      const localHandoff = doc.handoff.find((h) => h.to === 'LocalAgent');
      expect(localHandoff).toBeDefined();
      expect(localHandoff!.remote).toBeUndefined();
    });

    it('should parse DELEGATE with LOCATION: remote, ENDPOINT', () => {
      const doc = parseDSL(AGENT_WITH_REMOTE_DELEGATE);

      expect(doc.delegate).toHaveLength(1);
      const delegate = doc.delegate[0];
      expect(delegate.agent).toBe('PricingService');
      expect(delegate.remote).toBeDefined();
      expect(delegate.remote!.location).toBe('remote');
      expect(delegate.remote!.endpoint).toBe('https://pricing.example.com/api');
      expect(delegate.remote!.protocol).toBe('rest');
    });

    it('should parse HANDOFF with all remote fields populated', () => {
      const doc = parseDSL(SUPERVISOR_WITH_FULL_REMOTE_FIELDS);

      const handoff = doc.handoff[0];
      expect(handoff.remote).toBeDefined();
      expect(handoff.remote!.location).toBe('remote');
      expect(handoff.remote!.endpoint).toBe('https://remote.example.com/a2a');
      expect(handoff.remote!.protocol).toBe('a2a');
    });

    it('should auto-set location to remote when ENDPOINT is provided', () => {
      const doc = parseDSL(SUPERVISOR_ENDPOINT_AUTO_LOCATION);

      const handoff = doc.handoff[0];
      expect(handoff.remote).toBeDefined();
      expect(handoff.remote!.location).toBe('remote');
      expect(handoff.remote!.endpoint).toBe('https://auto.example.com/agent');
    });

    it('should parse mixed local and remote handoffs in same agent', () => {
      const doc = parseDSL(SUPERVISOR_MIXED_HANDOFFS);

      expect(doc.handoff).toHaveLength(3);

      const remotePayments = doc.handoff.find((h) => h.to === 'RemotePayments');
      expect(remotePayments!.remote).toBeDefined();
      expect(remotePayments!.remote!.location).toBe('remote');
      expect(remotePayments!.remote!.protocol).toBe('a2a');

      const localSupport = doc.handoff.find((h) => h.to === 'LocalSupport');
      expect(localSupport!.remote).toBeUndefined();

      const remoteAnalytics = doc.handoff.find((h) => h.to === 'RemoteAnalytics');
      expect(remoteAnalytics!.remote).toBeDefined();
      expect(remoteAnalytics!.remote!.location).toBe('remote');
      expect(remoteAnalytics!.remote!.protocol).toBe('rest');
    });
  });

  // =============================================================================
  // TESTS: Remote Agent Compilation
  // =============================================================================

  describe('Remote Agent Compilation', () => {
    it('should compile remote handoff with remote field on IR HandoffConfig', () => {
      const output = compileDSL(SUPERVISOR_WITH_REMOTE_HANDOFF);
      const agent = output.agents['Route_Supervisor'];
      expect(agent).toBeDefined();

      const paymentHandoff = agent.coordination.handoffs.find((h) => h.to === 'PaymentAgent');
      expect(paymentHandoff).toBeDefined();
      expect(paymentHandoff!.remote).toBeDefined();
      expect(paymentHandoff!.remote!.location).toBe('remote');
      expect(paymentHandoff!.remote!.endpoint).toBe('https://payments.example.com/a2a');
      expect(paymentHandoff!.remote!.protocol).toBe('a2a');
    });

    it('should not emit missing-agent compilation errors for remote-only supervisor targets', () => {
      const output = compileDSL(SUPERVISOR_ENDPOINT_AUTO_LOCATION);

      expect(output.compilation_errors ?? []).toEqual([]);
    });

    it('should compile local handoff with no remote field on IR HandoffConfig', () => {
      const output = compileDSL(SUPERVISOR_WITH_REMOTE_HANDOFF);
      const agent = output.agents['Route_Supervisor'];

      const localHandoff = agent.coordination.handoffs.find((h) => h.to === 'LocalAgent');
      expect(localHandoff).toBeDefined();
      expect(localHandoff!.remote).toBeUndefined();
    });

    it('should compile remote delegate with remote field on IR DelegateConfig', () => {
      const output = compileDSL(AGENT_WITH_REMOTE_DELEGATE);
      const agent = output.agents['Booking_Agent'];
      expect(agent).toBeDefined();

      expect(agent.coordination.delegates).toHaveLength(1);
      const delegate = agent.coordination.delegates[0];
      expect(delegate.remote).toBeDefined();
      expect(delegate.remote!.location).toBe('remote');
      expect(delegate.remote!.endpoint).toBe('https://pricing.example.com/api');
      expect(delegate.remote!.protocol).toBe('rest');
    });

    it('should include remote_agents registry in CompilationOutput when remote agents exist', () => {
      const output = compileDSL(SUPERVISOR_WITH_REMOTE_HANDOFF);

      expect(output.remote_agents).toBeDefined();
      expect(output.remote_agents!['PaymentAgent']).toBeDefined();
      expect(output.remote_agents!['PaymentAgent'].location).toBe('remote');
      expect(output.remote_agents!['PaymentAgent'].endpoint).toBe(
        'https://payments.example.com/a2a',
      );
      expect(output.remote_agents!['PaymentAgent'].protocol).toBe('a2a');
    });

    it('should not include remote_agents when all agents are local', () => {
      const output = compileDSL(AGENT_WITH_LOCAL_HANDOFF);

      expect(output.remote_agents).toBeUndefined();
    });

    it('should compile unconditional handoffs without requiring intent-category extraction', () => {
      const output = compileDSL(SUPERVISOR_WITH_UNCONDITIONAL_HANDOFF);
      const agent = output.agents['Unconditional_Handoff_Supervisor'];
      expect(agent).toBeDefined();

      const handoff = agent.coordination.handoffs.find((entry) => entry.to === 'ResearchAgent');
      expect(handoff).toBeDefined();
      expect(handoff!.return).toBe(true);

      expect(agent.routing).toBeDefined();
      expect(agent.routing!.rules).toHaveLength(1);
      expect(agent.routing!.rules[0].to).toBe('ResearchAgent');
    });
  });

  // =============================================================================
  // TESTS: Project Coordination Defaults
  // =============================================================================

  describe('Project Coordination Defaults', () => {
    it('should pass coordination_defaults in CompilerOptions to CompilationOutput', () => {
      const output = compileDSL(AGENT_WITH_LOCAL_HANDOFF, {
        coordination_defaults: {
          defaultHistoryStrategy: 'auto',
          autoHistoryFallbackLastN: 7,
          defaultContextValidation: false,
        },
      });

      expect(output.coordination_defaults).toBeDefined();
      expect(output.coordination_defaults!.defaultHistoryStrategy).toBe('auto');
      expect(output.coordination_defaults!.autoHistoryFallbackLastN).toBe(7);
      expect(output.coordination_defaults!.defaultContextValidation).toBe(false);
    });

    it('should not include coordination_defaults when not provided in options', () => {
      const output = compileDSL(AGENT_WITH_LOCAL_HANDOFF);

      expect(output.coordination_defaults).toBeUndefined();
    });

    it('should round-trip coordination_defaults with defaultHistoryStrategy: full', () => {
      const output = compileDSL(AGENT_WITH_LOCAL_HANDOFF, {
        coordination_defaults: {
          defaultHistoryStrategy: 'full',
        },
      });

      expect(output.coordination_defaults).toBeDefined();
      expect(output.coordination_defaults!.defaultHistoryStrategy).toBe('full');
    });

    it('should round-trip coordination_defaults with defaultHistoryStrategy: auto', () => {
      const output = compileDSL(AGENT_WITH_LOCAL_HANDOFF, {
        coordination_defaults: {
          defaultHistoryStrategy: 'auto',
        },
      });

      expect(output.coordination_defaults).toBeDefined();
      expect(output.coordination_defaults!.defaultHistoryStrategy).toBe('auto');
    });

    it('should round-trip coordination_defaults with defaultHistoryStrategy: { last_n: 5 }', () => {
      const output = compileDSL(AGENT_WITH_LOCAL_HANDOFF, {
        coordination_defaults: {
          defaultHistoryStrategy: { last_n: 5 },
        },
      });

      expect(output.coordination_defaults).toBeDefined();
      expect(output.coordination_defaults!.defaultHistoryStrategy).toEqual({ last_n: 5 });
    });

    it('should round-trip coordination_defaults with autoHistoryFallbackLastN', () => {
      const output = compileDSL(AGENT_WITH_LOCAL_HANDOFF, {
        coordination_defaults: {
          autoHistoryFallbackLastN: 12,
        },
      });

      expect(output.coordination_defaults).toBeDefined();
      expect(output.coordination_defaults!.autoHistoryFallbackLastN).toBe(12);
    });

    it('should round-trip coordination_defaults with defaultContextValidation: true', () => {
      const output = compileDSL(AGENT_WITH_LOCAL_HANDOFF, {
        coordination_defaults: {
          defaultContextValidation: true,
        },
      });

      expect(output.coordination_defaults).toBeDefined();
      expect(output.coordination_defaults!.defaultContextValidation).toBe(true);
    });
  });

  // =============================================================================
  // TESTS: Combined Scenarios
  // =============================================================================

  describe('Combined Scenarios', () => {
    it('should compile remote handoff with HISTORY strategy preserving both remote and history fields', () => {
      const output = compileDSL(SUPERVISOR_REMOTE_WITH_HISTORY);
      const agent = output.agents['History_Supervisor'];
      expect(agent).toBeDefined();

      const handoff = agent.coordination.handoffs.find((h) => h.to === 'RemoteWithHistory');
      expect(handoff).toBeDefined();

      // Remote config is present
      expect(handoff!.remote).toBeDefined();
      expect(handoff!.remote!.location).toBe('remote');
      expect(handoff!.remote!.endpoint).toBe('https://context.example.com/a2a');

      // History strategy is present
      expect(handoff!.context.history).toBe('full');
    });

    it('should compile remote handoff with ON_RETURN MAP preserving both remote and on_return fields', () => {
      const output = compileDSL(SUPERVISOR_REMOTE_WITH_ON_RETURN);
      const agent = output.agents['Return_Supervisor'];
      expect(agent).toBeDefined();

      const handoff = agent.coordination.handoffs.find((h) => h.to === 'RemoteWithReturn');
      expect(handoff).toBeDefined();

      // Remote config is present
      expect(handoff!.remote).toBeDefined();
      expect(handoff!.remote!.location).toBe('remote');
      expect(handoff!.remote!.endpoint).toBe('https://result.example.com/a2a');

      // ON_RETURN mapping is present
      expect(handoff!.on_return).toBeDefined();
      expect(typeof handoff!.on_return).toBe('object');
      const returnMapping = handoff!.on_return as { action?: string; map?: Record<string, string> };
      expect(returnMapping.map).toBeDefined();
      expect(returnMapping.map!['status']).toBe('order_status');
      expect(returnMapping.map!['total']).toBe('order_total');
    });

    it('should create full remote_agents registry from multiple remote agents', () => {
      const output = compileDSL(SUPERVISOR_MIXED_HANDOFFS);

      expect(output.remote_agents).toBeDefined();

      // RemotePayments should be in the registry
      expect(output.remote_agents!['RemotePayments']).toBeDefined();
      expect(output.remote_agents!['RemotePayments'].location).toBe('remote');
      expect(output.remote_agents!['RemotePayments'].endpoint).toBe(
        'https://payments.example.com/a2a',
      );
      expect(output.remote_agents!['RemotePayments'].protocol).toBe('a2a');

      // RemoteAnalytics should be in the registry
      expect(output.remote_agents!['RemoteAnalytics']).toBeDefined();
      expect(output.remote_agents!['RemoteAnalytics'].location).toBe('remote');
      expect(output.remote_agents!['RemoteAnalytics'].endpoint).toBe(
        'https://analytics.example.com/api',
      );
      expect(output.remote_agents!['RemoteAnalytics'].protocol).toBe('rest');

      // LocalSupport should NOT be in the registry
      expect(output.remote_agents!['LocalSupport']).toBeUndefined();
    });
  });
});
