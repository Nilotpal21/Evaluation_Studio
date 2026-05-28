/**
 * Fix templates — ABL code examples keyed by diagnostic code.
 *
 * These serve dual purpose:
 * 1. Returned in FixSuggestion when a finding has a known fix pattern
 * 2. Used as ABL construct knowledge for specialist prompts
 */

import type { FixSuggestion } from './types.js';

const FIX_MAP = new Map<string, FixSuggestion>([
  [
    'CO-01',
    {
      description: 'Add COMPLETION conditions so the agent knows when it is done',
      template: `COMPLETE:
  - WHEN: all_required_gathered == true
    RESPOND: ""`,
      effort: 'S',
    },
  ],
  [
    'CO-02',
    {
      description:
        'Reference only declared gather fields, session variables, tool results, or runtime variables in COMPLETION',
      template: `GATHER:
  confirmation:
    TYPE: boolean
    PROMPT: "Should I go ahead?"

COMPLETE:
  - WHEN: confirmation == true
    RESPOND: ""`,
      effort: 'S',
    },
  ],
  [
    'CO-03',
    {
      description: 'Drive COMPLETION from required state, not optional-only gather fields',
      template: `GATHER:
  confirmation:
    TYPE: boolean
    REQUIRED: true
    PROMPT: "Should I go ahead?"

COMPLETE:
  - WHEN: confirmation == true
    RESPOND: ""`,
      effort: 'S',
    },
  ],
  [
    'CO-04',
    {
      description:
        'Add COMPLETE to the return target, remove child handoffs back to the source, or remove RETURN: true from the source handoff',
      template: `# In target agent:
COMPLETE:
  - WHEN: task_complete == true
    RESPOND: ""`,
      effort: 'M',
    },
  ],
  [
    'H-02',
    {
      description: 'Add the missing field to GATHER or use an existing field name in PASS',
      template: `GATHER:
  <field_name>:
    TYPE: text
    PROMPT: "Please provide <field_name>"`,
      effort: 'S',
    },
  ],
  [
    'H-03',
    {
      description:
        'Seed the session variable with an initial_value or populate it before the handoff',
      template: `MEMORY:
  session:
    - customer_id
      TYPE: string
      initial_value: "guest"

HANDOFF:
  - TO: SupportAgent
    WHEN: customer_id != ""
    CONTEXT:
      pass: [customer_id]`,
      effort: 'S',
    },
  ],
  [
    'H-04',
    {
      description:
        'Add a matching GATHER field or MEMORY.session declaration in the target agent to receive the passed data',
      template: `# In target agent:
GATHER:
  <field_name>:
    TYPE: text
    PROMPT: "Confirm <field_name>"

# Or declare it in MEMORY.session if it is handoff context, not user input:
MEMORY:
  session:
    - <field_name>
      TYPE: string`,
      effort: 'M',
    },
  ],
  [
    'H-07',
    {
      description:
        'Map only child fields the target agent actually gathers or populates before returning to the parent',
      template: `# Parent agent
HANDOFF:
  - TO: BookingAgent
    WHEN: booking_requested == true
    RETURN: true
    ON_RETURN:
      map:
        booking_ref: parent_booking_ref

# Child agent
GATHER:
  booking_ref:
    TYPE: string
    REQUIRED: true
    PROMPT: "What booking reference should I use?"`,
      effort: 'M',
    },
  ],
  [
    'H-08',
    {
      description:
        'Align the source PASS field type with the target declaration so the handoff contract is unambiguous',
      template: `# Source agent
MEMORY:
  session:
    - customer_id
      TYPE: string

HANDOFF:
  - TO: SupportAgent
    WHEN: route_to_support == true
    CONTEXT:
      pass: [customer_id]

# Target agent
MEMORY:
  session:
    - customer_id
      TYPE: string`,
      effort: 'M',
    },
  ],
  [
    'H-05',
    {
      description:
        'Declare the HANDOFF WHEN variable in GATHER or MEMORY.session, or use a real runtime variable',
      template: `MEMORY:
  session:
    - route_flag
      TYPE: boolean
      initial_value: false

HANDOFF:
  - TO: BillingAgent
    WHEN: route_flag == true
    CONTEXT:
      pass: []`,
      effort: 'S',
    },
  ],
  [
    'H-06',
    {
      description:
        'When you use history: summary_only, provide a real CONTEXT.summary so the child receives narrative continuity',
      template: `HANDOFF:
  - TO: BillingAgent
    WHEN: route_to_billing == true
    CONTEXT:
      summary: "User needs billing help for invoice {{invoice_id}}."
      history: summary_only`,
      effort: 'S',
    },
  ],
  [
    'H-15',
    {
      description:
        'Map non-gather child outputs back to the parent when the parent completion or routing logic depends on them',
      template: `# Parent agent
MEMORY:
  session:
    - booking_status
      TYPE: string

HANDOFF:
  - TO: BookingAgent
    WHEN: booking_requested == true
    RETURN: true
    ON_RETURN:
      map:
        booking_status: booking_status

# Child agent
FLOW:
  steps: [lookup_booking]

STEPS:
  lookup_booking:
    CALL: get_booking_status
    SET:
      - booking_status = last_get_booking_status_result.status`,
      effort: 'M',
    },
  ],
  [
    'T-01',
    {
      description: 'Add a description that tells the LLM when and why to call this tool',
      template: `TOOLS:
  <tool_name>:
    DESCRIPTION: "Call this when the user needs <purpose>. Returns <output>."`,
      effort: 'S',
    },
  ],
  [
    'T-04',
    {
      description: 'Add an HTTP, MCP, or sandbox binding to make the tool executable',
      template: `TOOLS:
  <tool_name>:
    DESCRIPTION: "<purpose>"
    HTTP:
      URL: "<endpoint>"
      METHOD: POST`,
      effort: 'M',
    },
  ],
  [
    'T-08',
    {
      description: 'Add confirmation to prevent the tool from executing without user approval',
      template: `TOOLS:
  <tool_name>:
    CONFIRMATION: "This will <action>. Proceed?"`,
      effort: 'S',
    },
  ],
  [
    'G-01',
    {
      description: 'Add a prompt that tells the agent how to ask for this field',
      template: `GATHER:
  <field_name>:
    PROMPT: "What is your <field_name>?"`,
      effort: 'S',
    },
  ],
  [
    'G-07',
    {
      description: 'Add mask_config to prevent sensitive data from being logged or displayed',
      template: `GATHER:
  <field_name>:
    SENSITIVE: true
    SENSITIVE_DISPLAY: mask
    MASK_CONFIG:
      CHARACTER: "*"
      VISIBLE: 4`,
      effort: 'S',
    },
  ],
  [
    'GR-01',
    {
      description: 'Add input/output guardrails to filter unsafe content',
      template: `GUARDRAILS:
  content_safety:
    KIND: input
    TIER: 1
    CHECK: "Reject harmful, violent, or illegal content"
    ACTION: block
    THRESHOLD: 0.8`,
      effort: 'M',
    },
  ],
  [
    'O-02',
    {
      description: 'Add a GOAL that defines what the agent is trying to achieve',
      template: `GOAL: "Help the user with <purpose> by collecting information and providing solutions."`,
      effort: 'S',
    },
  ],
  [
    'C-04',
    {
      description: 'Add an on_fail action to handle constraint violations',
      template: `CONSTRAINTS:
  <constraint_name>:
    CONDITION: "<expression>"
    ON_FAIL: respond
    MESSAGE: "I cannot do that because <reason>."`,
      effort: 'S',
    },
  ],
]);

/** Get a fix suggestion for a diagnostic code. Returns undefined if no template exists. */
export function getFixTemplate(code: string): FixSuggestion | undefined {
  return FIX_MAP.get(code);
}

/** Get all codes that have fix templates. */
export function getCodesWithFixes(): string[] {
  return [...FIX_MAP.keys()];
}
