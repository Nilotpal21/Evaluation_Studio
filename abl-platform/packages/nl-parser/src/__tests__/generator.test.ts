/**
 * ABLGenerator Tests
 */

import { describe, test, expect } from 'vitest';
import {
  ABLGenerator,
  createGenerator,
  generateAgentABL,
  generateSupervisorABL,
  // Legacy exports
  DSLGenerator,
  generateAgentDSL,
  generateSupervisorDSL,
} from '../generator.js';
import type { AgentExtraction, SupervisorExtraction } from '../types.js';

describe('ABLGenerator', () => {
  // =============================================================================
  // TEST FIXTURES
  // =============================================================================

  const createAgentExtraction = (overrides?: Partial<AgentExtraction>): AgentExtraction => ({
    agent_name: 'Test_Agent',
    description: 'A test agent for unit testing',
    confidence: 0.95,
    identity: {
      role: 'Test Assistant',
      persona: 'Helpful and professional',
      expertise: ['testing', 'validation'],
      limitations: ['Cannot access production systems'],
    },
    steps: [],
    guardrails: [],
    inferred_tools: [],
    ...overrides,
  });

  const createSupervisorExtraction = (
    overrides?: Partial<SupervisorExtraction>,
  ): SupervisorExtraction => ({
    name: 'Test_Supervisor',
    description: 'A test supervisor for routing',
    confidence: 0.9,
    state_variables: [],
    routing_rules: [],
    intent_mappings: [],
    policies: [],
    ...overrides,
  });

  // =============================================================================
  // BASIC GENERATION TESTS
  // =============================================================================

  describe('generateAgentABL', () => {
    test('should generate basic agent ABL with required sections', () => {
      const extraction = createAgentExtraction();
      const abl = generateAgentABL(extraction);

      expect(abl).toContain('AGENT: Test_Agent');
      expect(abl).toContain('GOAL: "A test agent for unit testing"');
      expect(abl).toContain('PERSONA:');
      expect(abl).toContain('Test Assistant');
      expect(abl).toContain('COMPLETE:');
    });

    test('should include LIMITATIONS when present', () => {
      const extraction = createAgentExtraction({
        identity: {
          role: 'Test Role',
          expertise: [],
          limitations: ['Cannot do X', 'Cannot do Y'],
        },
      });
      const abl = generateAgentABL(extraction);

      expect(abl).toContain('LIMITATIONS:');
      expect(abl).toContain('- "Cannot do X"');
      expect(abl).toContain('- "Cannot do Y"');
    });

    test('should include TOOLS when inferred', () => {
      const extraction = createAgentExtraction({
        inferred_tools: [
          {
            name: 'search_database',
            description: 'Search the database',
            parameters: [
              { name: 'query', type: 'string', required: true },
              { name: 'limit', type: 'number', required: false },
            ],
            returns: 'array',
          },
        ],
      });
      const abl = generateAgentABL(extraction);

      expect(abl).toContain('TOOLS:');
      expect(abl).toContain('search_database(query: string, limit: number?) -> array');
    });

    test('should include GATHER from wait_input steps', () => {
      const extraction = createAgentExtraction({
        steps: [
          {
            number: 1,
            name: 'Get User Name',
            description: 'Please enter your name',
            action_type: 'wait_input',
            action_details: {},
            branches: [],
          },
        ],
      });
      const abl = generateAgentABL(extraction);

      expect(abl).toContain('GATHER:');
      expect(abl).toContain('get_user_name:');
      expect(abl).toContain('prompt: "Please enter your name"');
      expect(abl).toContain('type: string');
      expect(abl).toContain('required: true');
    });

    test('should include MEMORY from set_state steps', () => {
      const extraction = createAgentExtraction({
        steps: [
          {
            number: 1,
            name: 'Set Status',
            description: 'Set the current status',
            action_type: 'set_state',
            action_details: { variable: 'current_status' },
            branches: [],
          },
        ],
      });
      const abl = generateAgentABL(extraction);

      expect(abl).toContain('MEMORY:');
      expect(abl).toContain('session:');
      expect(abl).toContain('- current_status');
    });

    test('should include CONSTRAINTS from behavioral guardrails', () => {
      const extraction = createAgentExtraction({
        guardrails: [
          {
            name: 'validate_input',
            type: 'behavioral',
            check: 'input.length > 0',
            action: 'block',
          },
        ],
      });
      const abl = generateAgentABL(extraction);

      expect(abl).toContain('CONSTRAINTS:');
      expect(abl).toContain('validation:');
      expect(abl).toContain('REQUIRE: input.length > 0');
    });

    test('should include GUARDRAILS from input/output guardrails', () => {
      const extraction = createAgentExtraction({
        guardrails: [
          {
            name: 'pii_check',
            type: 'input',
            check: 'contains_pii(input)',
            action: 'redact',
          },
          {
            name: 'profanity_filter',
            type: 'output',
            check: 'contains_profanity(output)',
            action: 'block',
          },
        ],
      });
      const abl = generateAgentABL(extraction);

      expect(abl).toContain('GUARDRAILS:');
      expect(abl).toContain('name: pii_check');
      expect(abl).toContain('kind: input');
      expect(abl).toContain('name: profanity_filter');
      expect(abl).toContain('kind: output');
    });

    test('should include ESCALATE from block guardrails', () => {
      const extraction = createAgentExtraction({
        guardrails: [
          {
            name: 'safety_violation',
            type: 'behavioral',
            check: 'is_unsafe(input)',
            action: 'block',
          },
        ],
      });
      const abl = generateAgentABL(extraction);

      expect(abl).toContain('ESCALATE:');
      expect(abl).toContain('triggers:');
      expect(abl).toContain('WHEN: is_unsafe(input)');
      expect(abl).toContain('REASON: "safety_violation"');
      expect(abl).toContain('PRIORITY: high');
    });

    test('should include ON_ERROR with default handlers', () => {
      const extraction = createAgentExtraction();
      const abl = generateAgentABL(extraction);

      expect(abl).toContain('ON_ERROR:');
      expect(abl).toContain('TYPE: tool_error');
      expect(abl).toContain('RETRY: 2');
      expect(abl).toContain('TYPE: invalid_input');
    });

    test('should generate FLOW section when steps are present', () => {
      const extraction = createAgentExtraction({
        steps: [
          {
            number: 1,
            name: 'Welcome',
            description: 'Welcome the user',
            action_type: 'respond',
            action_details: { message: 'Hello!' },
            branches: [],
          },
        ],
      });
      const abl = generateAgentABL(extraction);

      expect(abl).toContain('FLOW:');
    });

    test('should generate FLOW for scripted mode', () => {
      const extraction = createAgentExtraction({
        steps: [
          {
            number: 1,
            name: 'Welcome',
            description: 'Welcome the user',
            action_type: 'respond',
            action_details: { message: 'Hello!' },
            branches: [],
          },
          {
            number: 2,
            name: 'Process',
            description: 'Process request',
            action_type: 'call_tool',
            action_details: { tool: 'process_request' },
            branches: [],
          },
        ],
      });
      const abl = generateAgentABL(extraction);

      expect(abl).toContain('FLOW:');
      expect(abl).toContain('STEPS: [welcome, process]');
      expect(abl).toContain('- welcome:');
      expect(abl).toContain('RESPOND: "Hello!"');
      expect(abl).toContain('- process:');
      expect(abl).toContain('CALL: process_request()');
    });

    test('should include COMPLETE conditions from signal steps', () => {
      const extraction = createAgentExtraction({
        steps: [
          {
            number: 1,
            name: 'Complete',
            description: 'Complete the task',
            action_type: 'signal',
            action_details: { when: 'task_done == true', message: 'All done!' },
            branches: [],
          },
        ],
      });
      const abl = generateAgentABL(extraction);

      expect(abl).toContain('COMPLETE:');
      expect(abl).toContain('WHEN: task_done == true');
      expect(abl).toContain('RESPOND: "All done!"');
    });
  });

  // =============================================================================
  // SUPERVISOR GENERATION TESTS
  // =============================================================================

  describe('generateSupervisorABL', () => {
    test('should generate basic supervisor ABL', () => {
      const extraction = createSupervisorExtraction();
      const abl = generateSupervisorABL(extraction);

      expect(abl).toContain('AGENT: Test_Supervisor');
      expect(abl).toContain('GOAL: "A test supervisor for routing"');
      expect(abl).toContain('PERSONA:');
      expect(abl).toContain('ESCALATE:');
      expect(abl).toContain('COMPLETE:');
    });

    test('should include MEMORY from state variables', () => {
      const extraction = createSupervisorExtraction({
        state_variables: [
          { namespace: 'session', name: 'current_agent', type: 'string' },
          { namespace: 'persistent', name: 'user_preferences', type: 'object' },
        ],
      });
      const abl = generateSupervisorABL(extraction);

      expect(abl).toContain('MEMORY:');
      expect(abl).toContain('session:');
      expect(abl).toContain('- current_agent');
      expect(abl).toContain('persistent:');
      expect(abl).toContain('- user_preferences');
    });

    test('should include HANDOFF from routing rules', () => {
      const extraction = createSupervisorExtraction({
        routing_rules: [
          {
            priority: 1,
            condition: 'intent == "booking"',
            target: 'Booking_Agent',
            context_fields: ['customer_id', 'booking_date'],
            flags: ['return'],
          },
          {
            priority: 2,
            condition: 'intent == "support"',
            target: 'Support_Agent',
          },
        ],
      });
      const abl = generateSupervisorABL(extraction);

      expect(abl).toContain('HANDOFF:');
      expect(abl).toContain('TO: Booking_Agent');
      expect(abl).toContain('WHEN: intent == "booking"');
      expect(abl).toContain('PASS: [customer_id, booking_date]');
      expect(abl).toContain('RETURN: true');
      expect(abl).toContain('TO: Support_Agent');
    });

    test('should include GATHER when intent mappings exist', () => {
      const extraction = createSupervisorExtraction({
        intent_mappings: [{ intents: ['book', 'reserve'], target_agent: 'Booking_Agent' }],
      });
      const abl = generateSupervisorABL(extraction);

      expect(abl).toContain('GATHER:');
      expect(abl).toContain('user_intent:');
      expect(abl).toContain('prompt: "How can I help you today?"');
    });

    test('should include default ESCALATE triggers', () => {
      const extraction = createSupervisorExtraction();
      const abl = generateSupervisorABL(extraction);

      expect(abl).toContain('ESCALATE:');
      expect(abl).toContain('user.frustrated == true');
      expect(abl).toContain('no_matching_agent == true');
    });

    test('should include ON_ERROR for handoff failures', () => {
      const extraction = createSupervisorExtraction();
      const abl = generateSupervisorABL(extraction);

      expect(abl).toContain('ON_ERROR:');
      expect(abl).toContain('TYPE: handoff_failed');
    });
  });

  // =============================================================================
  // CLASS TESTS
  // =============================================================================

  describe('ABLGenerator class', () => {
    test('should create generator with createGenerator()', () => {
      const generator = createGenerator();
      expect(generator).toBeInstanceOf(ABLGenerator);
    });

    test('should generate agent ABL via class method', () => {
      const generator = new ABLGenerator();
      const extraction = createAgentExtraction();
      const abl = generator.generateAgentABL(extraction);

      expect(abl).toContain('AGENT: Test_Agent');
    });

    test('should generate supervisor ABL via class method', () => {
      const generator = new ABLGenerator();
      const extraction = createSupervisorExtraction();
      const abl = generator.generateSupervisorABL(extraction);

      expect(abl).toContain('AGENT: Test_Supervisor');
    });

    test('should generate via generic method with type', () => {
      const generator = new ABLGenerator();
      const agentExtraction = createAgentExtraction();
      const supervisorExtraction = createSupervisorExtraction();

      const agentABL = generator.generate(agentExtraction, 'agent');
      const supervisorABL = generator.generate(supervisorExtraction, 'supervisor');

      expect(agentABL).toContain('AGENT: Test_Agent');
      expect(supervisorABL).toContain('AGENT: Test_Supervisor');
    });
  });

  // =============================================================================
  // TEMPLATE TESTS
  // =============================================================================

  describe('Template generation', () => {
    test('should generate simple-agent template', () => {
      const generator = new ABLGenerator();
      const abl = generator.generateFromTemplate('simple-agent', 'My_Agent');

      expect(abl).toContain('AGENT: My_Agent');
      expect(abl).toContain('GOAL:');
      expect(abl).toContain('PERSONA:');
      expect(abl).toContain('LIMITATIONS:');
      expect(abl).toContain('TOOLS:');
      expect(abl).toContain('GATHER:');
      expect(abl).toContain('COMPLETE:');
    });

    test('should generate supervisor template', () => {
      const generator = new ABLGenerator();
      const abl = generator.generateFromTemplate('supervisor', 'My_Supervisor');

      expect(abl).toContain('AGENT: My_Supervisor');
      expect(abl).toContain('HANDOFF:');
      expect(abl).toContain('ESCALATE:');
      expect(abl).toContain('COMPLETE:');
    });

    test('should generate scripted-agent template', () => {
      const generator = new ABLGenerator();
      const abl = generator.generateFromTemplate('scripted-agent', 'My_Flow');

      expect(abl).toContain('AGENT: My_Flow');
      expect(abl).toContain('FLOW:');
      expect(abl).toContain('STEPS:');
      expect(abl).toContain('- welcome:');
      expect(abl).toContain('RESPOND:');
      expect(abl).toContain('THEN:');
      expect(abl).toContain('ON_ERROR:');
      expect(abl).toContain('COMPLETE:');
    });

    test('should throw for unknown template', () => {
      const generator = new ABLGenerator();
      expect(() => {
        generator.generateFromTemplate('unknown' as any, 'Test');
      }).toThrow('Unknown template: unknown');
    });
  });

  // =============================================================================
  // BACKWARD COMPATIBILITY TESTS
  // =============================================================================

  describe('Backward compatibility', () => {
    test('DSLGenerator should be an alias for ABLGenerator', () => {
      expect(DSLGenerator).toBe(ABLGenerator);
    });

    test('generateAgentDSL should be an alias for generateAgentABL', () => {
      expect(generateAgentDSL).toBe(generateAgentABL);
    });

    test('generateSupervisorDSL should be an alias for generateSupervisorABL', () => {
      expect(generateSupervisorDSL).toBe(generateSupervisorABL);
    });

    test('legacy DSLGenerator should work the same', () => {
      const generator = new DSLGenerator();
      const extraction = createAgentExtraction();
      const abl = generator.generateAgentABL(extraction);

      expect(abl).toContain('AGENT: Test_Agent');
    });
  });

  // =============================================================================
  // EDGE CASES
  // =============================================================================

  describe('Edge cases', () => {
    test('should handle empty extraction gracefully', () => {
      const extraction = createAgentExtraction({
        identity: {
          role: '',
          expertise: [],
          limitations: [],
        },
        steps: [],
        guardrails: [],
        inferred_tools: [],
      });

      const abl = generateAgentABL(extraction);
      expect(abl).toContain('AGENT: Test_Agent');
      expect(abl).toContain('COMPLETE:');
    });

    test('should handle special characters in strings', () => {
      const extraction = createAgentExtraction({
        description: 'Agent for "special" tasks & more',
      });

      const abl = generateAgentABL(extraction);
      expect(abl).toContain('GOAL: "Agent for "special" tasks & more"');
    });

    test('should handle tool with no parameters', () => {
      const extraction = createAgentExtraction({
        inferred_tools: [
          {
            name: 'get_time',
            description: 'Get current time',
            parameters: [],
            returns: 'string',
          },
        ],
      });

      const abl = generateAgentABL(extraction);
      expect(abl).toContain('get_time() -> string');
    });

    test('should handle step with branches', () => {
      const extraction = createAgentExtraction({
        steps: [
          {
            number: 1,
            name: 'Check Input',
            description: 'Check user input',
            action_type: 'condition',
            action_details: { condition: 'input.valid == true' },
            branches: [
              { condition: 'input.type == "A"', target_step: 2 },
              { condition: 'input.type == "B"', target_step: 3 },
            ],
          },
        ],
      });

      const abl = generateAgentABL(extraction);
      expect(abl).toContain('ON_INPUT:');
      expect(abl).toContain('IF: input.type == "A"');
      expect(abl).toContain('THEN: 2');
    });
  });
});
