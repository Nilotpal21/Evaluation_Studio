/**
 * ABL Validation Tests
 *
 * Tests for ABL content validation.
 */

import { describe, test, expect } from 'vitest';
import { validateABLContent } from '../../mcp/validate/index.js';

// =============================================================================
// VALID ABL CONTENT
// =============================================================================

describe('validateABLContent - valid content', () => {
  test('validates minimal valid agent', () => {
    const content = `
AGENT: Simple_Agent

GOAL: "Help users"
    `.trim();

    const result = validateABLContent(content, 'test.agent.abl');

    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test('validates minimal valid supervisor', () => {
    const content = `
SUPERVISOR: Main_Supervisor

GOAL: "Route to agents"
    `.trim();

    const result = validateABLContent(content, 'test.agent.abl');

    expect(result.errors).toHaveLength(0);
  });

  test('validates agent with tools', () => {
    const content = `
AGENT: Tool_Agent

GOAL: "Use tools"

TOOLS:
  search(query: string) -> {results: object[]}
  save(data: object) -> {success: boolean}
    `.trim();

    const result = validateABLContent(content, 'test.agent.abl');

    expect(result.errors).toHaveLength(0);
  });

  test('validates scripted mode agent', () => {
    const content = `
AGENT: Scripted_Agent

GOAL: "Follow steps"

FLOW:
  start -> step1

  start:
    REASONING: false
    RESPOND: "Welcome!"
    THEN: step1
    `.trim();

    const result = validateABLContent(content, 'test.agent.abl');

    expect(result.errors).toHaveLength(0);
  });
});

// =============================================================================
// MISSING REQUIRED ELEMENTS
// =============================================================================

describe('validateABLContent - missing required elements', () => {
  test('error when missing AGENT/SUPERVISOR declaration', () => {
    const content = `

GOAL: "Help users"
    `.trim();

    const result = validateABLContent(content, 'test.agent.abl');

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].message).toContain('Missing required AGENT: or SUPERVISOR:');
  });

  test('error when AGENT has no name', () => {
    const content = `
AGENT:

GOAL: "Help users"
    `.trim();

    const result = validateABLContent(content, 'test.agent.abl');

    expect(result.errors.some((e) => e.message.includes('must have a name'))).toBe(true);
  });

  test('error when SUPERVISOR has no name', () => {
    const content = `
SUPERVISOR:

GOAL: "Route"
    `.trim();

    const result = validateABLContent(content, 'test.agent.abl');

    expect(result.errors.some((e) => e.message.includes('must have a name'))).toBe(true);
  });

  test('warning when missing GOAL section', () => {
    const content = `
AGENT: No_Goal_Agent

    `.trim();

    const result = validateABLContent(content, 'test.agent.abl');

    expect(result.warnings.some((w) => w.message.includes('Missing GOAL:'))).toBe(true);
  });
});

// =============================================================================
// INVALID MODE VALUES
// =============================================================================

describe('validateABLContent - invalid MODE', () => {
  test('error for invalid mode value', () => {
    const content = `
AGENT: Test_Agent
MODE: invalid
GOAL: "Test"
    `.trim();

    const result = validateABLContent(content, 'test.agent.abl');

    expect(result.errors.some((e) => e.message.includes('Invalid MODE'))).toBe(true);
    expect(result.errors.some((e) => e.message.includes('"invalid"'))).toBe(true);
  });

  test('error for typo in mode', () => {
    const content = `
AGENT: Test_Agent
MODE: reasoninng
GOAL: "Test"
    `.trim();

    const result = validateABLContent(content, 'test.agent.abl');

    expect(result.errors.some((e) => e.message.includes('Invalid MODE'))).toBe(true);
  });

  test('accepts reasoning mode', () => {
    const content = `
AGENT: Test_Agent

GOAL: "Test"
    `.trim();

    const result = validateABLContent(content, 'test.agent.abl');

    expect(result.errors.filter((e) => e.message.includes('MODE'))).toHaveLength(0);
  });

  test('accepts scripted mode', () => {
    const content = `
AGENT: Test_Agent

GOAL: "Test"
    `.trim();

    const result = validateABLContent(content, 'test.agent.abl');

    expect(result.errors.filter((e) => e.message.includes('MODE'))).toHaveLength(0);
  });

  test('mode comparison is case-insensitive', () => {
    const content = `
AGENT: Test_Agent
MODE: REASONING
GOAL: "Test"
    `.trim();

    const result = validateABLContent(content, 'test.agent.abl');

    expect(result.errors.filter((e) => e.message.includes('MODE'))).toHaveLength(0);
  });
});

// =============================================================================
// TOOLS SYNTAX
// =============================================================================

describe('validateABLContent - TOOLS syntax', () => {
  test('error when tool missing return type', () => {
    const content = `
AGENT: Test_Agent

GOAL: "Test"

TOOLS:
  search(query: string)
    `.trim();

    const result = validateABLContent(content, 'test.agent.abl');

    expect(result.errors.some((e) => e.message.includes('missing return type'))).toBe(true);
  });

  test('accepts valid tool syntax', () => {
    const content = `
AGENT: Test_Agent

GOAL: "Test"

TOOLS:
  search(query: string) -> {results: object[]}
    `.trim();

    const result = validateABLContent(content, 'test.agent.abl');

    expect(result.errors.filter((e) => e.message.includes('return type'))).toHaveLength(0);
  });

  test('allows tool with no parameters', () => {
    const content = `
AGENT: Test_Agent

GOAL: "Test"

TOOLS:
  get_time() -> {time: string}
    `.trim();

    const result = validateABLContent(content, 'test.agent.abl');

    expect(result.errors.filter((e) => e.message.includes('TOOLS'))).toHaveLength(0);
  });
});

// =============================================================================
// HANDOFF SECTION
// =============================================================================

describe('validateABLContent - HANDOFF syntax', () => {
  test('warning when HANDOFF not on its own line', () => {
    const content = `
SUPERVISOR: Test_Supervisor

GOAL: "Route"

HANDOFF: - TO: Sales_Agent
    `.trim();

    const result = validateABLContent(content, 'test.agent.abl');

    expect(
      result.warnings.some((w) => w.message.includes('HANDOFF:') && w.message.includes('own line')),
    ).toBe(true);
  });

  test('accepts HANDOFF on its own line', () => {
    const content = `
SUPERVISOR: Test_Supervisor

GOAL: "Route"

HANDOFF:
  - TO: Sales_Agent
    WHEN: intent == "sales"
    `.trim();

    const result = validateABLContent(content, 'test.agent.abl');

    expect(result.warnings.filter((w) => w.message.includes('HANDOFF'))).toHaveLength(0);
  });
});

// =============================================================================
// ERROR LOCATIONS
// =============================================================================

describe('validateABLContent - error locations', () => {
  test('reports correct line number for missing AGENT', () => {
    const content = `

GOAL: "Test"
    `.trim();

    const result = validateABLContent(content, 'test.agent.abl');

    expect(result.errors[0].line).toBe(1);
  });

  test('reports correct line number for invalid MODE', () => {
    const content = `
AGENT: Test
MODE: invalid
GOAL: "Test"
    `.trim();

    const result = validateABLContent(content, 'test.agent.abl');

    const modeError = result.errors.find((e) => e.message.includes('MODE'));
    expect(modeError?.line).toBe(2);
  });

  test('includes filename in errors', () => {
    const content = 'invalid content';

    const result = validateABLContent(content, 'my_file.agent.abl');

    expect(result.errors[0].file).toBe('my_file.agent.abl');
  });
});

// =============================================================================
// EDGE CASES
// =============================================================================

describe('validateABLContent - edge cases', () => {
  test('handles empty content', () => {
    const result = validateABLContent('', 'test.agent.abl');

    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('handles content with only whitespace', () => {
    const result = validateABLContent('   \n\n  \t  ', 'test.agent.abl');

    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('handles content with comments', () => {
    const content = `
# This is a comment
AGENT: Test_Agent
# Another comment

GOAL: "Test"
    `.trim();

    const result = validateABLContent(content, 'test.agent.abl');

    expect(result.errors).toHaveLength(0);
  });

  test('handles multiline GOAL', () => {
    const content = `
AGENT: Test_Agent

GOAL: "This is a very long goal that spans
       multiple lines to describe what
       the agent should do"
    `.trim();

    const result = validateABLContent(content, 'test.agent.abl');

    // Should not error on multiline goal
    expect(result.errors.filter((e) => e.message.includes('GOAL'))).toHaveLength(0);
  });

  test('handles tabs and mixed indentation', () => {
    const content = `
AGENT: Test_Agent

GOAL: "Test"

TOOLS:
\tsearch(q: string) -> {r: object[]}
    `.trim();

    const result = validateABLContent(content, 'test.agent.abl');

    expect(result.errors).toHaveLength(0);
  });
});

// =============================================================================
// COMPLEX DOCUMENTS
// =============================================================================

describe('validateABLContent - complex documents', () => {
  test('validates full agent with all sections', () => {
    const content = `
AGENT: Full_Agent

GOAL: "Complete customer support agent"

PERSONA: |
  You are a helpful customer support agent.
  Always be polite and professional.

LIMITATIONS:
  - Never share customer data with third parties
  - Do not make promises about refunds

TOOLS:
  lookup_order(order_id: string) -> {order: object}
  create_ticket(description: string) -> {ticket_id: string}

GATHER:
  order_id:
    type: string
    prompt: "What is your order ID?"
  issue:
    type: string
    prompt: "Please describe your issue"

MEMORY:
  persistent:
    - customer_history
    - preferences

CONSTRAINTS:
  before_action:
    - REQUIRE: order_id IS SET

ESCALATE:
  TO: human_agent
  WHEN: sentiment == "angry" AND attempts > 3

ON_ERROR:
  tool_failure:
    RESPOND: "Let me try a different approach."
    RETRY: 2

COMPLETE:
  WHEN: issue_resolved == true
  RESPOND: "Your issue has been resolved!"
    `.trim();

    const result = validateABLContent(content, 'test.agent.abl');

    expect(result.errors).toHaveLength(0);
  });

  test('validates full supervisor', () => {
    const content = `
SUPERVISOR: Main_Supervisor

GOAL: "Route customers to the right agent"

HANDOFF:
  - TO: Sales_Agent
    WHEN: intent == "purchase"
    CONTEXT:
      pass: [customer_id, product_interest]
      summary: "Customer interested in purchasing"

  - TO: Support_Agent
    WHEN: intent == "support"
    CONTEXT:
      pass: [customer_id, order_id]
      summary: "Customer needs support"

ESCALATE:
  TO: human_supervisor
  WHEN: confidence < 0.5
    `.trim();

    const result = validateABLContent(content, 'test.agent.abl');

    expect(result.errors).toHaveLength(0);
  });
});
