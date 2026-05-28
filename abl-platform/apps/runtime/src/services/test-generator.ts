/**
 * Test Generator Service
 *
 * Generates test case suggestions based on agent IR/ABL structure.
 */

import type { TestCase, AgentDetails } from '../types/index.js';

// =============================================================================
// TEST GENERATION
// =============================================================================

/**
 * Generate comprehensive test cases for an agent
 */
export function generateTestSuggestions(agent: AgentDetails): TestCase[] {
  const tests: TestCase[] = [];
  let testId = 1;

  // Parse ABL to extract structure
  const structure = parseAgentStructure(agent.dsl);

  // Happy path tests
  tests.push(...generateHappyPathTests(structure, testId));
  testId += tests.length;

  // Edge case tests
  tests.push(...generateEdgeCaseTests(structure, testId));
  testId += tests.length - testId + 1;

  // Constraint violation tests
  tests.push(...generateConstraintTests(structure, testId));
  testId += tests.length - testId + 1;

  // Handoff/escalation tests
  tests.push(...generateCoordinationTests(structure, testId));
  testId += tests.length - testId + 1;

  // Error handling tests
  tests.push(...generateErrorTests(structure, testId));

  return tests;
}

// =============================================================================
// STRUCTURE PARSING
// =============================================================================

interface AgentStructure {
  name: string;
  goal: string;
  gatherFields: Array<{
    name: string;
    prompt: string;
    required: boolean;
    type: string;
    validation?: string;
  }>;
  tools: Array<{
    name: string;
    params: string[];
  }>;
  constraints: Array<{
    phase: string;
    condition: string;
    onFail: string;
  }>;
  handoffs: Array<{
    to: string;
    when: string;
  }>;
  escalations: Array<{
    when: string;
    reason: string;
    priority: string;
  }>;
  completeConditions: Array<{
    when: string;
    respond?: string;
  }>;
}

/**
 * Parse agent ABL to extract structure
 */
function parseAgentStructure(dsl: string): AgentStructure {
  const structure: AgentStructure = {
    name: '',
    goal: '',
    gatherFields: [],
    tools: [],
    constraints: [],
    handoffs: [],
    escalations: [],
    completeConditions: [],
  };

  const lines = dsl.split('\n');

  // Extract name
  const nameMatch = dsl.match(/^AGENT:\s*(\w+)/m);
  if (nameMatch) structure.name = nameMatch[1];

  // Extract goal
  const goalMatch = dsl.match(/^GOAL:\s*"?([^"\n]+)"?/m);
  if (goalMatch) structure.goal = goalMatch[1];

  // Extract gather fields (simplified parsing)
  const gatherSection = dsl.match(/GATHER:\n([\s\S]*?)(?=\n[A-Z_]+:|$)/);
  if (gatherSection) {
    const fieldMatches = gatherSection[1].matchAll(/^\s{2}(\w+):\n([\s\S]*?)(?=^\s{2}\w+:|$)/gm);
    for (const match of fieldMatches) {
      const fieldName = match[1];
      const fieldContent = match[2];
      const prompt = fieldContent.match(/prompt:\s*"?([^"\n]+)"?/)?.[1] || '';
      const required = !fieldContent.includes('required: false');
      const type = fieldContent.match(/type:\s*(\w+)/)?.[1] || 'string';
      const validation = fieldContent.match(/validate:\s*"?([^"\n]+)"?/)?.[1];

      structure.gatherFields.push({ name: fieldName, prompt, required, type, validation });
    }
  }

  // Extract tools
  const toolsSection = dsl.match(/TOOLS:\n([\s\S]*?)(?=\n[A-Z_]+:|$)/);
  if (toolsSection) {
    const toolMatches = toolsSection[1].matchAll(/^\s+(\w+)\(/gm);
    for (const match of toolMatches) {
      structure.tools.push({ name: match[1], params: [] });
    }
  }

  // Extract handoffs
  const handoffSection = dsl.match(/HANDOFF:\n([\s\S]*?)(?=\n[A-Z_]+:|$)/);
  if (handoffSection) {
    const handoffMatches = handoffSection[1].matchAll(/TO:\s*(\w+)[\s\S]*?WHEN:\s*(.+)/g);
    for (const match of handoffMatches) {
      structure.handoffs.push({ to: match[1], when: match[2].trim() });
    }
  }

  // Extract escalations
  const escalateSection = dsl.match(/ESCALATE:\n([\s\S]*?)(?=\n[A-Z_]+:|$)/);
  if (escalateSection) {
    const triggerMatches = escalateSection[1].matchAll(
      /WHEN:\s*(.+)[\s\S]*?REASON:\s*"?([^"\n]+)"?[\s\S]*?PRIORITY:\s*(\w+)/g,
    );
    for (const match of triggerMatches) {
      structure.escalations.push({
        when: match[1].trim(),
        reason: match[2],
        priority: match[3],
      });
    }
  }

  // Extract complete conditions
  const completeSection = dsl.match(/COMPLETE:\n([\s\S]*?)(?=\n[A-Z_]+:|$)/);
  if (completeSection) {
    const condMatches = completeSection[1].matchAll(
      /WHEN:\s*(.+)(?:[\s\S]*?RESPOND:\s*"?([^"\n]+)"?)?/g,
    );
    for (const match of condMatches) {
      structure.completeConditions.push({
        when: match[1].trim(),
        respond: match[2],
      });
    }
  }

  return structure;
}

// =============================================================================
// TEST GENERATORS
// =============================================================================

function generateHappyPathTests(structure: AgentStructure, startId: number): TestCase[] {
  const tests: TestCase[] = [];

  if (structure.gatherFields.length > 0) {
    // Test with all required fields
    const requiredFields = structure.gatherFields.filter((f) => f.required);
    const fieldPrompts = requiredFields.map((f) => f.prompt || f.name).join(', then ');

    tests.push({
      id: `test-${startId}`,
      name: 'Happy Path - Complete All Fields',
      description: `Provide all required information to complete the flow: ${requiredFields.map((f) => f.name).join(', ')}`,
      category: 'happy_path',
      inputs: [
        `I want to ${structure.goal || 'get help'}`,
        ...requiredFields.map((f) => `My ${f.name} is test_value`),
      ],
      expectations: [{ type: 'action', value: 'complete' }],
    });

    // Test natural conversation flow
    if (requiredFields.length >= 2) {
      tests.push({
        id: `test-${startId + 1}`,
        name: 'Happy Path - Natural Conversation',
        description: 'Complete the flow with natural multi-turn conversation',
        category: 'happy_path',
        inputs: [
          'Hello, I need assistance',
          'Yes, please proceed',
          ...requiredFields.map((f) => {
            switch (f.type) {
              case 'date':
                return 'Tomorrow';
              case 'number':
                return '5';
              case 'boolean':
                return 'Yes';
              default:
                return `The ${f.name} is test_value`;
            }
          }),
        ],
        expectations: [{ type: 'action', value: 'complete' }],
      });
    }
  }

  return tests;
}

function generateEdgeCaseTests(structure: AgentStructure, startId: number): TestCase[] {
  const tests: TestCase[] = [];
  let id = startId;

  // Missing required fields
  for (const field of structure.gatherFields.filter((f) => f.required)) {
    tests.push({
      id: `test-${id++}`,
      name: `Edge Case - Missing ${field.name}`,
      description: `Verify agent prompts for missing ${field.name}`,
      category: 'edge_case',
      inputs: ['Start the process', 'I dont have that information'],
      expectations: [
        { type: 'response_contains', value: field.prompt || field.name },
        { type: 'action', value: 'collect' },
      ],
    });
  }

  // Invalid input types
  for (const field of structure.gatherFields.filter((f) => f.type !== 'string')) {
    tests.push({
      id: `test-${id++}`,
      name: `Edge Case - Invalid ${field.name} Type`,
      description: `Provide invalid type for ${field.name} (expected ${field.type})`,
      category: 'edge_case',
      inputs: [
        'Start the process',
        field.type === 'date'
          ? 'not a valid date'
          : field.type === 'number'
            ? 'abc'
            : 'invalid_value',
      ],
      expectations: [{ type: 'response_contains', value: 'valid' }],
    });
  }

  // User confusion/off-topic
  tests.push({
    id: `test-${id++}`,
    name: 'Edge Case - Off-Topic Query',
    description: 'Handle off-topic questions gracefully',
    category: 'edge_case',
    inputs: ['Whats the weather like today?'],
    expectations: [{ type: 'response_contains', value: structure.goal || 'help' }],
  });

  return tests;
}

function generateConstraintTests(structure: AgentStructure, startId: number): TestCase[] {
  const tests: TestCase[] = [];
  let id = startId;

  for (const constraint of structure.constraints) {
    tests.push({
      id: `test-${id++}`,
      name: `Constraint - ${constraint.phase}`,
      description: `Test constraint violation: ${constraint.condition}`,
      category: 'constraint',
      inputs: ['Trigger: ' + constraint.condition],
      expectations: [
        { type: 'action', value: 'block' },
        { type: 'response_contains', value: constraint.onFail },
      ],
    });
  }

  return tests;
}

function generateCoordinationTests(structure: AgentStructure, startId: number): TestCase[] {
  const tests: TestCase[] = [];
  let id = startId;

  // Handoff tests
  for (const handoff of structure.handoffs) {
    tests.push({
      id: `test-${id++}`,
      name: `Handoff - To ${handoff.to}`,
      description: `Trigger handoff when: ${handoff.when}`,
      category: 'handoff',
      inputs: [`I need help with ${handoff.to}`, 'Yes, please transfer me'],
      expectations: [
        { type: 'action', value: 'handoff' },
        { type: 'trace_event', value: 'handoff' },
      ],
    });
  }

  // Escalation tests
  for (const escalation of structure.escalations) {
    tests.push({
      id: `test-${id++}`,
      name: `Escalation - ${escalation.reason}`,
      description: `Trigger escalation (${escalation.priority}): ${escalation.when}`,
      category: 'handoff',
      inputs: ['I need to speak to a human agent', 'This is very urgent'],
      expectations: [
        { type: 'action', value: 'escalate' },
        { type: 'trace_event', value: 'escalation' },
      ],
    });
  }

  return tests;
}

function generateErrorTests(structure: AgentStructure, startId: number): TestCase[] {
  const tests: TestCase[] = [];
  let id = startId;

  // Tool failure test (if tools exist)
  if (structure.tools.length > 0) {
    tests.push({
      id: `test-${id++}`,
      name: 'Error - Tool Failure',
      description: 'Test graceful handling when tool execution fails',
      category: 'error',
      inputs: ['Execute the action that uses a tool'],
      expectations: [{ type: 'trace_event', value: 'error' }],
    });
  }

  // Timeout simulation
  tests.push({
    id: `test-${id++}`,
    name: 'Error - User Timeout',
    description: 'Test handling of user timeout/abandonment',
    category: 'error',
    inputs: ['Start a process', '...'], // Simulated non-response
  });

  return tests;
}

// =============================================================================
// EXPORTS
// =============================================================================

export const TestGenerator = {
  generateTestSuggestions,
};
