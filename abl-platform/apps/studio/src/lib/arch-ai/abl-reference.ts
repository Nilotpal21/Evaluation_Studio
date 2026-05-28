/**
 * ABL syntax reference for the Arch AI system prompt.
 *
 * IMPORTANT: This is a standalone reference. We do NOT import from
 * PromptCatalog.arch.shared.abl_syntax_reference because that reference
 * teaches MODE: and DOMAIN: which the compiler rejects. This reference
 * only teaches syntax that the compiler actually accepts.
 */
export const ABL_SYNTAX_REFERENCE = `
ABL (Agent Blueprint Language) Syntax Reference

DOCUMENT HEADERS (choose one):
  AGENT: <Name>           — standard agent
  SUPERVISOR: <Name>      — supervisor/router agent

REQUIRED on every agent:
  GOAL: "<objective>"     — what the agent does (mandatory)

OPTIONAL sections:
  PERSONA: |
    Multi-line personality description.
    Defines how the agent communicates.

  LIMITATIONS:
    - "limitation 1"
    - "limitation 2"

  TOOLS:
    tool_name(param: type, param2: type) -> {return_field: type}
      description: "what this tool does"
    another_tool(input: string) -> {result: object}

  GATHER:
    field_name:
      type: string
      required: true
      prompt: "Question to ask the user"
    another_field:
      type: number
      required: false
      prompt: "Optional question"
    Valid types: string, number, boolean, date, email, phone, enum(a,b,c)
    CRITICAL: Each field MUST be a multi-line block. NEVER use single-line format.

  CONSTRAINTS:
    - REQUIRE: "booking_date != null"
      ON_FAIL: RESPOND "Please share the booking date first."
    - REQUIRE: "num_guests > 0"
      ON_FAIL: RESPOND "Please specify at least one guest."
    Expressions must reference declared GATHER or MEMORY.session fields.
    Never invent variables like user_authenticated.
    Valid operators: ==, !=, >, <, >=, <=, IS SET, IS NOT SET, IN, CONTAINS, AND, OR, NOT
    Valid ON_FAIL actions: RESPOND, ESCALATE, HANDOFF, BLOCK

  HANDOFF:
    - TO: Agent_Name
      WHEN: condition for routing
    - TO: Another_Agent
      WHEN: different condition
    For supervisors: this is how you route to specialists.

  ESCALATE:
    triggers:
      - WHEN: condition
        REASON: "why escalating"
        PRIORITY: high

  COMPLETE:
    - WHEN: booking_confirmed == true AND booking_reference != null
      RESPOND: "Your booking is confirmed."

  ON_ERROR:
    - TOOL: tool_name
      RETRY: 2
      BACKOFF: exponential
      RESPOND: "error message"

FLOW (scripted agents ONLY — omit entirely for reasoning agents):
  FLOW:
    steps:
      - step1
      - step2
    step1:
      REASONING: false
      RESPOND: "Hello!"
      THEN: step2
    step2:
      REASONING: false
      RESPOND: "Let me gather the final detail."
      THEN: COMPLETE

INVALID KEYWORDS — NEVER use these:
  - MODE: — NOT supported. Agents default to reasoning. For scripted, use FLOW with REASONING: per step.
  - DOMAIN: — NOT a valid section.
  - ROUTING: — Use HANDOFF: instead.
  - AGENTS: (bare names) — Use HANDOFF: with "- TO:" entries.
  - COORDINATOR: — Use SUPERVISOR: instead.

EXAMPLES:

Supervisor (routes to specialists, NO TOOLS, NO GATHER):
  SUPERVISOR: Order_Supervisor
  GOAL: "Route customer requests to the right specialist"
  PERSONA: |
    You are a friendly routing supervisor.
  HANDOFF:
    - TO: Booking_Agent
      WHEN: intent.category == "booking"
    - TO: FAQ_Agent
      WHEN: intent.category == "faq"
    - TO: Complaints_Agent
      WHEN: intent.category == "complaint"
  ESCALATE:
    triggers:
      - WHEN: intent.confidence < 0.5 OR human_requested == true
        REASON: "Cannot determine intent"
        PRIORITY: medium

Reasoning agent (HAS TOOLS and GATHER, NO FLOW, NO MODE):
  AGENT: Booking_Agent
  GOAL: "Help users make bookings"
  PERSONA: |
    You are a booking specialist. Friendly and efficient.
  TOOLS:
    search_availability(date: string, guests: number) -> {available: boolean}
    create_booking(date: string, guests: number, name: string) -> {booking_id: string}
  GATHER:
    booking_date:
      type: date
      required: true
      prompt: "What date would you like to book?"
    num_guests:
      type: number
      required: true
      prompt: "How many guests?"
  CONSTRAINTS:
    - REQUIRE: "num_guests > 0"
      ON_FAIL: RESPOND "Please specify at least one guest."
  HANDOFF:
    - TO: Order_Supervisor
      WHEN: booking_complete == true OR handoff_requested == true

RULES:
1. GOAL is mandatory on every agent.
2. Supervisors should have HANDOFF but NOT TOOLS or GATHER (they route, not process).
3. Reasoning agents can have TOOLS, GATHER, CONSTRAINTS — but NOT FLOW.
4. Only scripted agents have FLOW sections with REASONING: true/false per step.
5. Every GATHER field must be multi-line (name: on own line, properties indented below).
6. COMPLETE WHEN expressions must reference declared GATHER or MEMORY.session fields.
7. Section keywords are UPPERCASE followed by colon: AGENT:, TOOLS:, GATHER:, etc.
8. Conditions use == not = for equality.
`;
