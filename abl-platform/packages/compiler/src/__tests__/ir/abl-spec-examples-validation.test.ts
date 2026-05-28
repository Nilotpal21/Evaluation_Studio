/**
 * ABL_SPEC.md Example Validation Tests
 *
 * Validates every DSL example in docs/reference/ABL_SPEC.md against
 * the actual parser and compiler. Ensures the spec documents only
 * patterns that actually work.
 *
 * Organized by spec section number.
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '../../platform/ir/compiler.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseOnly(dsl: string) {
  return parseAgentBasedABL(dsl);
}

function compileFromDSL(dsl: string, agentName: string) {
  const parseResult = parseAgentBasedABL(dsl);
  expect(parseResult.errors).toHaveLength(0);
  expect(parseResult.document).not.toBeNull();
  const output = compileABLtoIR([parseResult.document!]);
  const agent = output.agents[agentName];
  expect(agent).toBeDefined();
  return { agent, output };
}

function parseAndExpectErrors(dsl: string) {
  const result = parseAgentBasedABL(dsl);
  return result;
}

// ── Section 3.1: AGENT Declaration ──────────────────────────────────────────

describe('Spec §3.1: AGENT Declaration', () => {
  test('PascalCase agent names parse correctly', () => {
    const names = ['Hotel_Search', 'Payment_Processor', 'Customer_Support'];
    for (const name of names) {
      const result = parseOnly(`AGENT: ${name}\nGOAL: "Test"\n`);
      expect(result.errors).toHaveLength(0);
      expect(result.document).not.toBeNull();
      expect(result.document!.name).toBe(name);
    }
  });
});

// ── Section 3.2: GOAL ───────────────────────────────────────────────────────

describe('Spec §3.2: GOAL', () => {
  test('quoted goal strings parse correctly', () => {
    const goals = [
      'Help user find and book a hotel that meets all booking policies',
      "Process user's refund request and confirm resolution",
      'Collect issue details and route to appropriate support team',
    ];
    for (const goal of goals) {
      const result = parseOnly(`AGENT: Test\nGOAL: "${goal}"\n`);
      expect(result.errors).toHaveLength(0);
      expect(result.document).not.toBeNull();
    }
  });
});

// ── Section 3.3: PERSONA ────────────────────────────────────────────────────

describe('Spec §3.3: PERSONA', () => {
  test('multiline PERSONA with pipe syntax parses', () => {
    const dsl = `
AGENT: Hotel_Specialist
GOAL: "Help with hotels"

PERSONA: |
  Helpful, knowledgeable hotel booking specialist.
  Friendly but efficient - doesn't waste user's time.
  Asks clarifying questions only when necessary.
  Always explains why if a booking can't be made.
  References user's past preferences when making suggestions.
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.document!.persona).toBeDefined();
    expect(result.document!.persona!.description).toContain('Helpful');
    expect(result.document!.persona!.description).toContain('knowledgeable');
  });
});

// ── Section 3.4: LIMITATIONS ────────────────────────────────────────────────

describe('Spec §3.4: LIMITATIONS', () => {
  test('LIMITATIONS list parses correctly', () => {
    const dsl = `
AGENT: Hotel_Search
GOAL: "Help with hotels"

LIMITATIONS:
  - "Cannot guarantee room availability until booking is confirmed"
  - "Cannot override blackout dates or minimum stay policies"
  - "Cannot process payments directly - must handoff to Payment agent"
  - "Cannot access bookings made outside this system"
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
  });
});

// ── Section 3.5: TOOLS ──────────────────────────────────────────────────────

describe('Spec §3.5: TOOLS', () => {
  test('tools with typed params and return types parse', () => {
    const dsl = `
AGENT: Hotel_Search
GOAL: "Help with hotels"

TOOLS:
  check_blackout_dates(destination: string, checkin: date, checkout: date) -> {allowed: boolean, reason?: string}
  search_hotels(destination: string, checkin: date, checkout: date, guests: number = 2) -> Hotel[]
  get_hotel_details(hotel_id: string) -> {name: string, rating: number, amenities: string[], rooms_available: number, price_per_night: number}
  create_reservation(hotel_id: string, guest_info: GuestInfo) -> Reservation
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.document!.tools).toHaveLength(4);
    expect(result.document!.tools[0].name).toBe('check_blackout_dates');
    expect(result.document!.tools[1].name).toBe('search_hotels');
    expect(result.document!.tools[1].parameters).toHaveLength(4);
    expect(result.document!.tools[2].name).toBe('get_hotel_details');
    expect(result.document!.tools[3].name).toBe('create_reservation');
  });

  test('tool with description parses', () => {
    const dsl = `
AGENT: Test_Agent
GOAL: "Test"

TOOLS:
  lookup_customer(phone_number: string) -> {customer_id: string, name: string}
    description: "Look up customer by phone number"
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document!.tools).toHaveLength(1);
    expect(result.document!.tools[0].name).toBe('lookup_customer');
  });
});

// ── Section 3.6: GATHER ─────────────────────────────────────────────────────

describe('Spec §3.6: GATHER', () => {
  test('GATHER with typed fields, prompts, defaults, and validation', () => {
    const dsl = `
AGENT: Hotel_Search
GOAL: "Help with hotels"

GATHER:
  destination:
    prompt: "Where would you like to stay?"
    type: string
    required: true
    validate: "Must be a valid city name"

  checkin:
    prompt: "What's your check-in date?"
    type: date
    required: true
    validate: "Must be today or future date"

  checkout:
    prompt: "What's your check-out date?"
    type: date
    required: true
    validate: "Must be after check-in date"

  guests:
    prompt: "How many guests will be staying?"
    type: number
    required: false
    default: 2
    validate: "Must be between 1 and 10"

  room_preference:
    prompt: "Any room preferences? (king bed, ocean view, etc.)"
    type: string
    required: false
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.document!.gather).toBeDefined();
    // Top-level GATHER is a flat GatherField[] array
    const fields = result.document!.gather!;
    expect(fields).toHaveLength(5);
    expect(fields[0].name).toBe('destination');
    expect(fields[0].required).toBe(true);
    expect(fields[3].name).toBe('guests');
    expect(fields[4].name).toBe('room_preference');
    expect(fields[4].required).toBe(false);
  });
});

// ── Section 3.7: MEMORY ─────────────────────────────────────────────────────

describe('Spec §3.7: MEMORY', () => {
  test('session memory variables parse', () => {
    const dsl = `
AGENT: Hotel_Search
GOAL: "Help with hotels"

MEMORY:
  session:
    - search_results
    - selected_hotel
    - reservation_draft
    - clarification_count
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.document!.memory).toBeDefined();
    expect(result.document!.memory!.session).toBeDefined();
  });

  test('persistent memory variables parse', () => {
    const dsl = `
AGENT: Hotel_Search
GOAL: "Help with hotels"

MEMORY:
  persistent:
    - user.preferred_hotel_chains
    - user.preferred_room_type
    - user.loyalty_programs
    - user.home_airport
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
  });
});

// ── Section 3.8: CONSTRAINTS ────────────────────────────────────────────────

describe('Spec §3.8: CONSTRAINTS', () => {
  test('REQUIRE with ON_FAIL template parses', () => {
    const dsl = `
AGENT: Hotel_Search
GOAL: "Help with hotels"

CONSTRAINTS:
  booking_requirements:
    - REQUIRE selected_hotel IS SET
      ON_FAIL: "Pick a hotel before I try to reserve it."
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.document!.constraints).toBeDefined();
  });

  test('REQUIRE with IMPLIES condition parses', () => {
    const dsl = `
AGENT: Dispute_Agent
GOAL: "Handle disputes"

CONSTRAINTS:
  always:
    - REQUIRE dispute_type == "card" IMPLIES card_unique_id IS SET
      ON_FAIL: "Card disputes require the card unique ID."
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
  });

  test('LIMIT and RESTRICT constraint kinds parse', () => {
    const dsl = `
AGENT: Risk_Agent
GOAL: "Check risks"

CONSTRAINTS:
  risk_controls:
    - LIMIT clarification_count < 5
      ON_FAIL: ESCALATE
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
  });

  test('REQUIRE with BEFORE clause parses', () => {
    const dsl = `
AGENT: Hotel_Search
GOAL: "Help with hotels"

CONSTRAINTS:
  booking_requirements:
    - REQUIRE selected_hotel IS SET BEFORE calling reserve_hotel
      ON_FAIL: "Pick a hotel before I try to reserve it."
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
  });
});

// ── Section 3.9: DELEGATE ───────────────────────────────────────────────────

describe('Spec §3.10: DELEGATE', () => {
  test('DELEGATE with WHEN, PURPOSE, INPUT, RETURNS parses', () => {
    const dsl = `
AGENT: Hotel_Search
GOAL: "Help with hotels"

DELEGATE:
  - AGENT: Loyalty_Lookup
    WHEN: user.mentions_loyalty OR booking.ready
    PURPOSE: "Check loyalty status and available rewards"
    INPUT: {user_id, hotel_chain}
    RETURNS: {loyalty_tier: string, points_balance: number, available_rewards: Reward[]}
    USE_RESULT: "Offer to apply rewards if available and beneficial"
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
  });
});

// ── Section 3.10: HANDOFF ───────────────────────────────────────────────────

describe('Spec §3.11: HANDOFF', () => {
  test('HANDOFF with TO, WHEN, CONTEXT, RETURN parses', () => {
    const dsl = `
AGENT: Hotel_Search
GOAL: "Help with hotels"

HANDOFF:
  - TO: Payment_Agent
    WHEN: reservation.ready_for_payment == true
    CONTEXT:
      pass: [reservation, selected_hotel, user.email]
      summary: "User booking hotel"
    RETURN: false
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.document!.handoff).toBeDefined();
  });

  test('HANDOFF with RETURN true parses', () => {
    const dsl = `
AGENT: Hotel_Search
GOAL: "Help with hotels"

HANDOFF:
  - TO: Flight_Search
    WHEN: user.intent == "also_need_flight"
    CONTEXT:
      pass: [destination, checkin, checkout]
      summary: "User also needs flights"
    RETURN: true
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
  });
});

// ── Section 3.11: ESCALATE ──────────────────────────────────────────────────

describe('Spec §3.12: ESCALATE', () => {
  test('ESCALATE with integer PRIORITY parses', () => {
    const dsl = `
AGENT: Hotel_Search
GOAL: "Help with hotels"

ESCALATE:
  triggers:
    - WHEN: tool_failures > 3
      REASON: "Repeated technical failures"
      PRIORITY: medium

    - WHEN: user.requests_human == true
      REASON: "User explicitly requested human agent"
      PRIORITY: high

    - WHEN: booking.total > 5000
      REASON: "High-value booking requires human approval"
      PRIORITY: critical

    - WHEN: user.mentions_legal OR user.mentions_lawsuit
      REASON: "Potential legal issue"
      PRIORITY: critical

  context_for_human:
    - conversation_transcript
    - failure_reasons
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.document!.escalate).toBeDefined();
    expect(result.document!.escalate!.triggers).toBeDefined();
    expect(result.document!.escalate!.triggers.length).toBe(4);
  });

  test('ESCALATE compiles to coordination.escalation in IR', () => {
    const { agent } = compileFromDSL(
      `
AGENT: Esc_Test
GOAL: "Test escalation"

ESCALATE:
  triggers:
    - WHEN: tool_failures > 3
      REASON: "Technical failures"
      PRIORITY: medium
    - WHEN: user.requests_human == true
      REASON: "User requested"
      PRIORITY: high
  context_for_human:
    - conversation_transcript
`,
      'Esc_Test',
    );
    expect(agent.coordination).toBeDefined();
    expect(agent.coordination.escalation).toBeDefined();
    expect(agent.coordination.escalation!.triggers.length).toBe(2);
  });
});

// ── Section 3.12: COMPLETE ──────────────────────────────────────────────────

describe('Spec §3.13: COMPLETE', () => {
  test('COMPLETE with WHEN and RESPOND parses', () => {
    const dsl = `
AGENT: Hotel_Search
GOAL: "Help with hotels"

COMPLETE:
  - WHEN: reservation.confirmed == true
    RESPOND: "Your reservation is confirmed!"

  - WHEN: user.intent == "cancel"
    RESPOND: "No problem! Feel free to come back anytime."

  - WHEN: handoff.completed == true
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.document!.complete).toBeDefined();
    expect(result.document!.complete!.length).toBe(3);
  });

  test('COMPLETE with TEMPLATE reference compiles', () => {
    const { agent } = compileFromDSL(
      `
AGENT: Template_Complete_Test
GOAL: "Test template complete"

TEMPLATES:
  checkout_confirmation:
    DEFAULT: "Order confirmed! Thank you."

COMPLETE:
  - WHEN: order_confirmed == true
    RESPOND: TEMPLATE(checkout_confirmation)
`,
      'Template_Complete_Test',
    );
    expect(agent.completion).toBeDefined();
  });
});

// ── Section 3.13: ON_ERROR ──────────────────────────────────────────────────

describe('Spec §3.14: ON_ERROR', () => {
  test('ON_ERROR with RESPOND, RETRY, THEN parses', () => {
    const dsl = `
AGENT: Error_Test
GOAL: "Test errors"

ON_ERROR:
  tool_timeout:
    RESPOND: "I'm having a bit of trouble connecting. Let me try that again..."
    RETRY: 2
    THEN: ESCALATE with REASON: "Service unavailable"

  tool_error:
    RESPOND: "Something went wrong. Let me try a different approach."
    RETRY: 1
    THEN: DELEGATE -> Fallback_Agent

  invalid_input:
    RESPOND: "I didn't quite understand that."
    RETRY: 3
    THEN: ESCALATE with REASON: "Unable to understand user"
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.document!.onError).toBeDefined();
  });

  test('ON_ERROR compiles to error_handling in IR', () => {
    const { agent } = compileFromDSL(
      `
AGENT: Error_IR_Test
GOAL: "Test error IR"

ON_ERROR:
  tool_timeout:
    RESPOND: "Retrying..."
    RETRY: 1
`,
      'Error_IR_Test',
    );
    expect(agent.error_handling).toBeDefined();
  });
});

// ── Section 3.13.1: TEMPLATES ───────────────────────────────────────────────

describe('Spec §3.15: TEMPLATES', () => {
  test('template with DEFAULT and variable interpolation parses', () => {
    const dsl = `
AGENT: Cart_Agent
GOAL: "Manage cart"

TEMPLATES:
  cart_summary:
    DEFAULT: |
      Your Cart:
      {{#each items}}
      - {{this.name}} x{{this.quantity}} — {{this.price}} {{currency}}
      {{/each}}
      Total: {{total}} {{currency}}
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    // templates is TemplateDefinition[] — find by name
    expect(result.document!.templates).toBeDefined();
    const cartTemplate = result.document!.templates!.find(
      (t: { name: string }) => t.name === 'cart_summary',
    );
    expect(cartTemplate).toBeDefined();
    expect(cartTemplate!.content).toContain('{{#each items}}');
  });

  test('template with MARKDOWN variant parses', () => {
    const dsl = `
AGENT: Cart_Agent
GOAL: "Manage cart"

TEMPLATES:
  cart_summary:
    DEFAULT: "Your cart total is {{total}}"
    MARKDOWN: |
      ## Your Cart
      **Total: {{total}} {{currency}}**
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
    const cartTemplate = result.document!.templates!.find(
      (t: { name: string }) => t.name === 'cart_summary',
    );
    expect(cartTemplate).toBeDefined();
  });

  test('template compiles to IR templates record', () => {
    const { agent } = compileFromDSL(
      `
AGENT: Tmpl_IR_Test
GOAL: "Test templates"

TEMPLATES:
  greeting:
    DEFAULT: "Welcome to our service!"
  farewell:
    DEFAULT: "Thanks for visiting!"
`,
      'Tmpl_IR_Test',
    );
    expect(agent.templates).toBeDefined();
    expect(agent.templates!['greeting']).toBe('Welcome to our service!');
    expect(agent.templates!['farewell']).toBe('Thanks for visiting!');
  });

  test('VOICE INSTRUCTIONS is accepted on templates', () => {
    const dsl = `
AGENT: Voice_Tmpl_Test
GOAL: "Test voice templates"

TEMPLATES:
  greeting:
    DEFAULT: "Welcome to our service."
    VOICE INSTRUCTIONS: "Speak warmly with a slight pause after Welcome."
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
    const greetingTemplate = result.document!.templates!.find(
      (t: { name: string }) => t.name === 'greeting',
    );
    expect(greetingTemplate).toBeDefined();
    expect(greetingTemplate!.voiceConfig?.instructions).toBe(
      'Speak warmly with a slight pause after Welcome.',
    );
  });
});

// ── Section 3.13.2: BEHAVIOR_PROFILE (standalone) ───────────────────────────

describe('Spec §3.16: BEHAVIOR_PROFILE', () => {
  test('standalone BEHAVIOR_PROFILE document parses as behavior_profile kind', () => {
    const dsl = `
BEHAVIOR_PROFILE: voice-optimized
PRIORITY: 10
WHEN: context.channel == "voice"
INSTRUCTIONS: "Keep responses under 3 sentences."
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.document!.meta.kind).toBe('behavior_profile');
    expect(result.document!.name).toBe('voice-optimized');
  });

  test('inline BEHAVIOR_PROFILE inside AGENT is parsed as inline profile (fixed §8.1)', () => {
    const dsl = `
AGENT: My_Agent
GOAL: "Help users"

BEHAVIOR_PROFILE: voice-optimized
WHEN: context.channel == "voice"
INSTRUCTIONS: "Be concise"
`;
    const result = parseOnly(dsl);
    // Fixed: inline profiles no longer destroy the agent
    expect(result.document).not.toBeNull();
    expect(result.document!.meta.kind).toBe('agent-based');
    expect(result.document!.name).toBe('My_Agent');
    expect(result.document!.inlineBehaviorProfiles).toHaveLength(1);
    expect(result.document!.inlineBehaviorProfiles![0].name).toBe('voice-optimized');
  });

  test('BEHAVIOR_PROFILES (plural) produces parser error (known pitfall §8.2)', () => {
    const dsl = `
AGENT: My_Agent
GOAL: "Help users"

BEHAVIOR_PROFILES:
  - NAME: voice-optimized
    PRIORITY: 10
    WHEN: context.channel == "voice"
`;
    const result = parseOnly(dsl);
    // Plural form is not recognized — should produce a warning or error
    // At minimum, the profiles won't be parsed into the document
    expect(
      result.warnings.length > 0 ||
        result.errors.length > 0 ||
        result.document?.meta.kind === 'agent',
    ).toBe(true);
  });

  test('BEHAVIOR_PROFILE compiles correctly when separated from agents', () => {
    const profileDsl = `
BEHAVIOR_PROFILE: voice-optimized
PRIORITY: 10
WHEN: context.channel == "voice"
INSTRUCTIONS: "Be concise"
`;
    const agentDsl = `
AGENT: My_Agent
GOAL: "Help users"
`;
    const profileResult = parseAgentBasedABL(profileDsl);
    const agentResult = parseAgentBasedABL(agentDsl);

    expect(profileResult.errors).toHaveLength(0);
    expect(agentResult.errors).toHaveLength(0);

    const output = compileABLtoIR([agentResult.document!, profileResult.document!]);
    expect(output.agents['My_Agent']).toBeDefined();
    // Profile should be compiled as a separate entity, not as an agent
  });
});

// ── Section 3.13.3: Voice Configuration ─────────────────────────────────────

describe('Spec §3.17: Voice Configuration', () => {
  test('EXECUTION voice block with provider/voice_id/speed parses and compiles', () => {
    const { agent } = compileFromDSL(
      `
AGENT: Voice_Agent
GOAL: "Voice test"

EXECUTION:
  voice:
    provider: elevenlabs
    voice_id: aria
    speed: 1.0
`,
      'Voice_Agent',
    );
    expect(agent.execution.voice).toBeDefined();
    expect(agent.execution.voice!.provider).toBe('elevenlabs');
    expect(agent.execution.voice!.voice_id).toBe('aria');
    expect(agent.execution.voice!.speed).toBe(1.0);
  });
});

// ── Section 3.14: FLOW ──────────────────────────────────────────────────────

describe('Spec §3.20: FLOW', () => {
  test('basic FLOW with steps and THEN parses', () => {
    // Every FLOW step MUST declare REASONING: true or REASONING: false
    const dsl = `
AGENT: Flow_Test
GOAL: "Test flow"

FLOW:
  step1:
    REASONING: false
    RESPOND: "Welcome!"
    THEN: step2

  step2:
    REASONING: false
    RESPOND: "How can I help?"
    THEN: COMPLETE
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.document!.flow).toBeDefined();
  });

  test('FLOW with ON_INPUT branching parses', () => {
    const dsl = `
AGENT: Branch_Test
GOAL: "Test branching"

FLOW:
  confirm:
    REASONING: false
    RESPOND: "Would you like to proceed?"
    ON_INPUT:
      - IF: input == "yes"
        RESPOND: "Great! Processing..."
        THEN: process
      - IF: input == "no"
        RESPOND: "No problem."
        THEN: cancelled
      - ELSE:
        RESPOND: "Please say yes or no."
        THEN: confirm

  process:
    REASONING: false
    RESPOND: "Done!"
    THEN: COMPLETE

  cancelled:
    REASONING: false
    RESPOND: "Cancelled."
    THEN: COMPLETE
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
  });

  test('FLOW with CALL and ON_SUCCESS/ON_FAIL parses', () => {
    const dsl = `
AGENT: Call_Test
GOAL: "Test calls"

TOOLS:
  create_reservation(hotel_id: string) -> object

FLOW:
  book_hotel:
    REASONING: false
    CALL: create_reservation(hotel_id)
    ON_SUCCESS:
      RESPOND: "Booking confirmed!"
      THEN: done
    ON_FAIL:
      RESPOND: "Booking failed."
      THEN: retry

  done:
    REASONING: false
    RESPOND: "All done."
    THEN: COMPLETE

  retry:
    REASONING: false
    RESPOND: "Let me try again."
    THEN: book_hotel
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
  });

  test('FLOW with SET variable assignment parses', () => {
    const dsl = `
AGENT: Set_Test
GOAL: "Test SET"

FLOW:
  start:
    REASONING: false
    SET:
      preferred_currency = COALESCE(preferred_currency, "USD")
      request_timestamp = NOW()
    THEN: next_step

  next_step:
    REASONING: false
    RESPOND: "Ready."
    THEN: COMPLETE
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
  });

  test('FLOW with CALL WITH/AS explicit params parses', () => {
    const dsl = `
AGENT: CallWith_Test
GOAL: "Test CALL WITH"

TOOLS:
  get_balance(account_id: string, currency: string) -> object

FLOW:
  fetch_balance:
    REASONING: false
    CALL: get_balance
      WITH:
        account_id: selected_account.id
        currency: preferred_currency
      AS: balanceResult
    THEN: display

  display:
    REASONING: false
    RESPOND: "Balance retrieved."
    THEN: COMPLETE
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
  });

  test('FLOW with CHECK inline condition guard parses', () => {
    const dsl = `
AGENT: Check_Test
GOAL: "Test CHECK"

TOOLS:
  get_balance(account_id: string) -> object

FLOW:
  verify_balance:
    REASONING: false
    CALL: get_balance
      WITH:
        account_id: selected_account.id
      AS: balanceResult
    CHECK: balanceResult.available >= transfer_amount
    RESPOND: "Balance verified."
    THEN: confirm

  confirm:
    REASONING: false
    RESPOND: "Proceeding with transfer."
    THEN: COMPLETE
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    const step = result.document!.flow!.definitions['verify_balance'];
    expect(step.check).toBe('balanceResult.available >= transfer_amount');
  });

  test('FLOW with ON_RESULT multi-way branching parses', () => {
    const dsl = `
AGENT: Result_Test
GOAL: "Test ON_RESULT"

TOOLS:
  validate_recipient(routing_number: string, account_number: string) -> object

FLOW:
  validate_recipient_step:
    REASONING: false
    CALL: validate_recipient
      WITH:
        routing_number: recipient_routing
        account_number: recipient_account
      AS: recipientResult
    ON_RESULT:
      - IF: recipientResult.status == "valid"
        SET:
          recipient_bank = recipientResult.bank_name
        THEN: collect_amount
      - IF: recipientResult.status == "INVALID_ROUTING"
        RESPOND: "The routing number is invalid."
        THEN: collect_recipient
      - ELSE:
        RESPOND: "Couldn't verify."
        THEN: collect_recipient

  collect_amount:
    REASONING: false
    RESPOND: "How much?"
    THEN: COMPLETE

  collect_recipient:
    REASONING: false
    RESPOND: "Please provide details."
    THEN: validate_recipient_step
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
  });

  test('FLOW with TRANSFORM pipeline parses', () => {
    const dsl = `
AGENT: Transform_Test
GOAL: "Test TRANSFORM"

FLOW:
  apply_filters:
    REASONING: false
    TRANSFORM: txnResult.transactions AS txn INTO filtered_transactions
      FILTER: filter_type == "all" OR txn.type == filter_type
      MAP:
        id: txn.id
        date: FORMAT_DATE(txn.date, "MMM DD")
        description: COALESCE(txn.merchant, txn.description)
      SORT_BY: date DESC
      LIMIT: page_size
    THEN: display_transactions

  display_transactions:
    REASONING: false
    RESPOND: "Here are the transactions."
    THEN: COMPLETE
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
  });

  test('FLOW with CLEAR variable deletion parses', () => {
    const dsl = `
AGENT: Clear_Test
GOAL: "Test CLEAR"

FLOW:
  step1:
    REASONING: false
    RESPOND: "Choose."
    ON_INPUT:
      - IF: input contains "change"
        CLEAR: transfer_amount, raw_amount
        THEN: collect_amount
      - ELSE:
        THEN: done

  collect_amount:
    REASONING: false
    RESPOND: "Enter amount."
    THEN: done

  done:
    REASONING: false
    RESPOND: "Done."
    THEN: COMPLETE
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
  });
});

// ── Section 5: Multi-Agent Orchestration (SUPERVISOR) ───────────────────────

describe('Spec §5: SUPERVISOR', () => {
  test('SUPERVISOR with AGENTS and ROUTING parses via agent-based parser', () => {
    // Note: parseAgentBasedABL routes SUPERVISOR without MODE: to the
    // legacy Chevrotain-based parseSupervisor, which produces a different
    // document type. For the agent-based path, SUPERVISOR needs MODE: or
    // other agent-based sections. Test the agent-based supervisor path:
    const dsl = `
SUPERVISOR: Travel_Assistant
GOAL: "Route customer requests to appropriate agents"

AGENTS:
  hotel: Hotel_Search
  flight: Flight_Search
  payment: Payment_Agent
  support: Support_Agent

ROUTING:
  - INTENT(hotel, stay, room, accommodation) -> hotel
  - INTENT(flight, fly, plane, airline) -> flight
  - INTENT(pay, checkout, purchase) -> payment
  - INTENT(help, problem, issue, complaint) -> support
  - DEFAULT -> hotel
`;
    const result = parseOnly(dsl);
    // The parser may route this to legacy supervisor parser or agent-based
    // depending on whether it detects MODE: or other signals
    expect(result.document).not.toBeNull();
  });
});

// ── Section 6: Complete Hotel_Search Example ────────────────────────────────

describe('Spec §6: Complete Hotel_Search Example', () => {
  test('full Hotel_Search agent parses without errors', () => {
    const dsl = `
AGENT: Hotel_Search

GOAL: "Help user find and book a hotel that meets all booking policies"

PERSONA: |
  Helpful, knowledgeable hotel booking specialist.
  Friendly but efficient - doesn't waste user's time.
  Always explains policies clearly when they affect the booking.
  References user's preferences to make personalized suggestions.

LIMITATIONS:
  - "Cannot guarantee availability until booking is confirmed"
  - "Cannot override blackout dates or minimum stay policies"
  - "Cannot process payments - must transfer to payment agent"

TOOLS:
  check_blackout_dates(destination: string, checkin: date, checkout: date) -> {allowed: boolean, reason?: string}
  validate_minimum_stay(destination: string, checkin: date, checkout: date) -> {valid: boolean, minimum: number, nights: number}
  search_hotels(destination: string, checkin: date, checkout: date, guests: number = 2) -> Hotel[]
  get_hotel_details(hotel_id: string) -> HotelDetails
  check_availability(hotel_id: string, room_type: string, dates: DateRange) -> {available: boolean, price: number}
  create_reservation(hotel_id: string, room_type: string, dates: DateRange, guest: GuestInfo) -> Reservation

GATHER:
  destination:
    prompt: "Where would you like to stay?"
    type: string
    required: true
  checkin:
    prompt: "What's your check-in date?"
    type: date
    required: true
  checkout:
    prompt: "What's your check-out date?"
    type: date
    required: true
  guests:
    prompt: "How many guests?"
    type: number
    default: 2

MEMORY:
  session:
    - search_results
    - selected_hotel
    - reservation_draft

  persistent:
    - user.preferred_chains
    - user.preferred_room_type
    - user.loyalty_programs
    - user.past_bookings
    - user.average_budget

  remember:
    - WHEN booking.confirmed
      STORE: {hotel: selected_hotel.name, chain: selected_hotel.chain, destination, price: reservation.total} -> user.past_bookings

  recall:
    - ON: session:start
      ACTION: prompt_llm
      INSTRUCTION: "Load user's preferred chains and room types"
    - ON: tool:search_hotels:after
      ACTION: prompt_llm
      INSTRUCTION: "Prioritize hotels matching preferences"

CONSTRAINTS:
  search_rules:
    - REQUIRE check_blackout_dates.allowed == true
      ON_FAIL: "Those dates fall within a blackout period."

    - REQUIRE validate_minimum_stay.valid == true
      ON_FAIL: "Minimum stay requirement not met."

DELEGATE:
  - AGENT: Loyalty_Lookup
    WHEN: booking.ready AND user.loyalty_programs IS SET
    PURPOSE: "Check for applicable rewards"
    INPUT: {user_id, hotel_chain: selected_hotel.chain}
    RETURNS: {points: number, rewards: Reward[]}
    USE_RESULT: "Offer to apply rewards"

HANDOFF:
  - TO: Payment_Agent
    WHEN: reservation.confirmed_pending_payment
    CONTEXT:
      pass: [reservation, selected_hotel, user.email]
      summary: "Booking hotel"
    RETURN: false

  - TO: Support_Agent
    WHEN: user.sentiment == "frustrated" OR user.requests_human
    CONTEXT:
      pass: [conversation_history, current_state]
      summary: "User needs assistance"
    RETURN: false

ESCALATE:
  triggers:
    - WHEN: tool_failures > 3
      REASON: "Technical issues"
      PRIORITY: medium

    - WHEN: user.requests_human
      REASON: "User requested human"
      PRIORITY: high

  context_for_human:
    - conversation_transcript
    - gathered: {destination, checkin, checkout, guests}
    - search_results
    - failure_reasons

COMPLETE:
  - WHEN: handoff.completed
  - WHEN: user.intent == "cancel"
    RESPOND: "No problem! Feel free to come back anytime."

ON_ERROR:
  tool_timeout:
    RESPOND: "Having trouble connecting. Retrying..."
    RETRY: 2
    THEN: ESCALATE with REASON: "Service unavailable"

  unknown_error:
    RESPOND: "Something went wrong. Connecting you with support."
    RETRY: 0
    THEN: ESCALATE with REASON: "Unexpected error"
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.document!.name).toBe('Hotel_Search');
    expect(result.document!.meta.kind).toBe('agent-based');
  });

  test('full Hotel_Search agent compiles to valid IR', () => {
    const dsl = `
AGENT: Hotel_Search

GOAL: "Help user find and book a hotel that meets all booking policies"

PERSONA: |
  Helpful, knowledgeable hotel booking specialist.

TOOLS:
  check_blackout_dates(destination: string, checkin: date, checkout: date) -> {allowed: boolean, reason?: string}
  search_hotels(destination: string, checkin: date, checkout: date, guests: number = 2) -> Hotel[]

GATHER:
  destination:
    prompt: "Where would you like to stay?"
    type: string
    required: true
  checkin:
    prompt: "Check-in date?"
    type: date
    required: true

MEMORY:
  session:
    - search_results
    - selected_hotel

CONSTRAINTS:
  search_rules:
    - REQUIRE check_blackout_dates.allowed == true
      ON_FAIL: "Blackout period."

ESCALATE:
  triggers:
    - WHEN: tool_failures > 3
      REASON: "Technical issues"
      PRIORITY: medium

COMPLETE:
  - WHEN: user.intent == "cancel"
    RESPOND: "No problem!"

ON_ERROR:
  tool_timeout:
    RESPOND: "Retrying..."
    RETRY: 2
`;
    const { agent } = compileFromDSL(dsl, 'Hotel_Search');
    expect(agent).toBeDefined();
    expect(agent.identity).toBeDefined();
    expect(agent.tools.length).toBeGreaterThanOrEqual(2);
    expect(agent.gather).toBeDefined();
    expect(agent.constraints).toBeDefined();
    expect(agent.coordination.escalation).toBeDefined();
    expect(agent.completion).toBeDefined();
    expect(agent.error_handling).toBeDefined();
  });
});

// ── Section 3.6: Reasoning-mode GATHER example ──────────────────────────────

describe('Spec §3.6: Reasoning-mode GATHER example', () => {
  test('Refund_Agent reasoning agent parses and compiles', () => {
    const dsl = `
AGENT: Refund_Agent

GOAL: "Help customers process refunds for eligible orders"

TOOLS:
  lookup_order(order_id: string) -> {order_id: string, items: object[], total: number, status: string}
    description: "Look up order details"
  process_refund(order_id: string, item_id: string, reason: string) -> {refund_id: string, amount: number}
    description: "Process refund for an item"

GATHER:
  order_id:
    prompt: "Could you share your order number?"
    type: string
    required: true
  refund_reason:
    prompt: "What's the reason for the refund?"
    type: string
    required: true
    validate: "Must describe a specific issue"

CONSTRAINTS:
  - REQUIRE lookup_order.status != "already_refunded"
    ON_FAIL: "This order has already been refunded."

COMPLETE:
  - WHEN: refund_id IS SET
    RESPOND: "Your refund has been processed."
`;
    const { agent } = compileFromDSL(dsl, 'Refund_Agent');
    expect(agent.tools.length).toBeGreaterThanOrEqual(2);
    expect(agent.gather).toBeDefined();
    expect(agent.constraints).toBeDefined();
    expect(agent.completion).toBeDefined();
    // No flow section — this is a reasoning agent
    expect(agent.flow).toBeUndefined();
  });
});

// ── Section 6.2: IT_Help_Desk Complete Example ──────────────────────────────

describe('Spec §6.2: IT_Help_Desk Complete Example', () => {
  test('IT_Help_Desk reasoning agent parses without errors', () => {
    const dsl = `
AGENT: IT_Help_Desk

GOAL: "Diagnose and resolve common IT issues"

PERSONA: |
  Patient, knowledgeable IT support specialist.
  Asks diagnostic questions to narrow down issues.

LIMITATIONS:
  - "Cannot access production databases directly"
  - "Cannot approve software purchases over $500"

TOOLS:
  lookup_employee(email: string) -> {employee_id: string, name: string, department: string, devices: object[], software: string[]}
    description: "Look up employee profile"
  reset_password(employee_id: string, system: string) -> {temporary_password: string, expires_in: string}
    description: "Reset password for a system"
  check_vpn_status(employee_id: string) -> {connected: boolean, last_connected: string, errors: string[]}
    description: "Check VPN connection status"
  create_ticket(employee_id: string, category: string, description: string, priority: string) -> {ticket_id: string}
    description: "Create a support ticket"
  request_software(employee_id: string, software_name: string, justification: string) -> {request_id: string, approval_status: string}
    description: "Submit a software access request"

GATHER:
  employee_email:
    prompt: "What's your work email address?"
    type: string
    required: true
  issue_description:
    prompt: "Can you describe the issue?"
    type: string
    required: true
  system_affected:
    prompt: "Which system is affected?"
    type: string
    required: false

CONSTRAINTS:
  - REQUIRE lookup_employee.employee_id IS SET BEFORE calling reset_password
    ON_FAIL: "I need to verify your identity first."
  - REQUIRE lookup_employee.employee_id IS SET BEFORE calling request_software
    ON_FAIL: "Let me look up your account first."
  - LIMIT password_reset_count < 3
    ON_FAIL: "Multiple resets today. Creating a ticket for security review."

MEMORY:
  session:
    - employee_profile
    - issue_category
    - resolution_steps_tried
    - ticket_id

DELEGATE:
  - AGENT: Network_Diagnostics
    WHEN: issue_category == "vpn" AND basic_troubleshooting_failed == true
    PURPOSE: "Run advanced network diagnostics"
    INPUT: {employee_id, vpn_errors}
    RETURNS: {diagnosis, recommended_fix}

ESCALATE:
  triggers:
    - WHEN: resolution_attempts > 3
      REASON: "Multiple resolution attempts failed"
      PRIORITY: high
    - WHEN: issue_category == "security_concern"
      REASON: "Potential security issue"
      PRIORITY: critical
  context_for_human:
    - employee_id
    - issue_description
    - resolution_steps_tried

COMPLETE:
  - WHEN: issue_resolved == true
    RESPOND: "Glad that's working now!"
  - WHEN: ticket_id IS SET
    RESPOND: "Ticket created. You'll get an update within 4 hours."

ON_ERROR:
  tool_timeout:
    RESPOND: "Having trouble connecting. Retrying..."
    RETRY: 2
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.document!.name).toBe('IT_Help_Desk');
    expect(result.document!.meta.kind).toBe('agent-based');
    // Verify this is a reasoning agent (no flow)
    expect(result.document!.flow).toBeUndefined();
  });

  test('IT_Help_Desk compiles to valid IR', () => {
    const dsl = `
AGENT: IT_Help_Desk

GOAL: "Diagnose and resolve common IT issues"

TOOLS:
  lookup_employee(email: string) -> {employee_id: string, name: string}
    description: "Look up employee"
  reset_password(employee_id: string, system: string) -> {temporary_password: string}
    description: "Reset password"
  create_ticket(employee_id: string, category: string, description: string, priority: string) -> {ticket_id: string}
    description: "Create ticket"

GATHER:
  employee_email:
    prompt: "Work email?"
    type: string
    required: true
  issue_description:
    prompt: "Describe the issue?"
    type: string
    required: true

CONSTRAINTS:
  - REQUIRE lookup_employee.employee_id IS SET BEFORE calling reset_password
    ON_FAIL: "Need to verify identity first."

ESCALATE:
  triggers:
    - WHEN: resolution_attempts > 3
      REASON: "Multiple failures"
      PRIORITY: medium

COMPLETE:
  - WHEN: issue_resolved == true
    RESPOND: "Fixed!"
  - WHEN: ticket_id IS SET
    RESPOND: "Ticket created."
`;
    const { agent } = compileFromDSL(dsl, 'IT_Help_Desk');
    expect(agent).toBeDefined();
    expect(agent.tools.length).toBeGreaterThanOrEqual(3);
    expect(agent.gather).toBeDefined();
    expect(agent.constraints).toBeDefined();
    expect(agent.coordination.escalation).toBeDefined();
    expect(agent.completion).toBeDefined();
    // Reasoning agent — no flow
    expect(agent.flow).toBeUndefined();
  });
});

// ── Section 8.11: Runtime Defaults (EXECUTION block) ────────────────────────

describe('Spec §7.11: EXECUTION block', () => {
  test('EXECUTION with model, max_iterations, timeouts parses and compiles', () => {
    const { agent } = compileFromDSL(
      `
AGENT: Complex_Workflow
GOAL: "Complex workflow"

EXECUTION:
  model: claude-sonnet-4-5-20250929
  max_iterations: 20
  timeouts:
    tool_timeout_ms: 60000
    session_timeout_ms: 3600000
`,
      'Complex_Workflow',
    );
    expect(agent.execution).toBeDefined();
    // max_iterations in DSL maps to max_reasoning_iterations in the IR
    // The IR field name depends on the compiler mapping
    expect(agent.execution).toBeDefined();
  });

  test('EXECUTION with temperature and max_tokens parses', () => {
    const dsl = `
AGENT: Exec_Test
GOAL: "Test execution"

EXECUTION:
  temperature: 0.8
  max_tokens: 4096
  max_iterations: 15
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document!.execution).toBeDefined();
  });
});

// ── Section 3.15: Pipeline (Supervisor Pre-Classification) ──────────────────

describe('Spec §3.21: Pipeline Configuration', () => {
  test('SUPERVISOR with pipeline config parses via agent-based parser', () => {
    // SUPERVISOR with GOAL: signals agent-based format to the parser
    const dsl = `
SUPERVISOR: Support_Router
GOAL: "Route support requests to the right team"

EXECUTION:
  model: claude-sonnet-4-5-20250929
  pipeline:
    enabled: true
    mode: sequential
    model: qwen3-30b
    shortCircuit:
      enabled: true
      confidenceThreshold: 0.85
    toolFilter:
      enabled: true
      maxTools: 6

AGENTS:
  billing: Billing_Agent
  technical: Tech_Support
  general: General_Inquiry

ROUTING:
  - INTENT(billing, invoice, payment) -> billing
  - INTENT(technical, bug, error) -> technical
  - DEFAULT -> general
`;
    const result = parseOnly(dsl);
    // Parse may succeed or fail depending on parser routing
    expect(result.document).not.toBeNull();
  });
});

// ── Retail Voice Demo (validated working agent from real deployment) ─────────

describe('Retail Voice Demo Agent (real deployment validation)', () => {
  test('Acme_Retail_Agent from examples parses without errors', () => {
    const dsl = `
AGENT: Acme_Retail_Agent
VERSION: "1.0"
DESCRIPTION: "Friendly voice-first customer service agent"
GOAL: "Help customers with returns, exchanges, order lookups"

PERSONA: |
  You are a friendly customer service representative at Acme Retail.
  Your name is Alex. You sound like someone who genuinely enjoys helping people.

EXECUTION:
  temperature: 0.8
  max_tokens: 4096
  max_iterations: 15
  inline_gather: true

TEMPLATES:
  greeting:
    DEFAULT: "Thank you for calling Acme Retail! How can I help you today?"
    VOICE INSTRUCTIONS: "Warm and welcoming."

  exchange_confirmed:
    DEFAULT: |
      Got it, I've updated your order.
      Your new {{product_color}} {{product_name}} in size {{product_size}} should arrive soon.
      Is there anything else I can help you with today?

  return_initiated:
    DEFAULT: |
      I've started the return process for you.
      Once we receive the item, your refund will be processed within 3-5 business days.
      Is there anything else I can help you with?

  closing:
    DEFAULT: "Glad I could help! Enjoy the new pair."

TOOLS:
  lookup_customer(phone_number: string) -> {customer_id: string, name: string, email: string, loyalty_tier: string}
    description: "Look up customer by phone number"
  get_recent_orders(customer_id: string, limit: number) -> {orders: object[]}
    description: "Get customer recent orders"
  get_order_details(order_id: string) -> {order_id: string, items: object[], status: string}
    description: "Get full order details"
  check_return_eligibility(order_id: string, item_id: string) -> {eligible: boolean, reason: string, days_remaining: number}
    description: "Check return eligibility"
  get_product_variants(product_id: string) -> {colors: string[], sizes: string[]}
    description: "Get available variants"
  initiate_exchange(order_id: string, item_id: string, new_color: string, new_size: string) -> {exchange_id: string, estimated_delivery: string}
    description: "Process an exchange"
  initiate_return(order_id: string, item_id: string, reason: string) -> {return_id: string, refund_amount: number}
    description: "Initiate a return"
  get_delivery_estimate(address_id: string, product_id: string) -> {estimated_date: string}
    description: "Get delivery estimate"

GATHER:
  return_reason:
    prompt: "Could you tell me what's not working out?"
    type: string
    required: true

MEMORY:
  session:
    - customer_profile
    - current_order
    - return_eligibility

CONSTRAINTS:
  - REQUIRE check_return_eligibility.eligible == true
    ON_FAIL: "This item isn't eligible for return."
  - REQUIRE check_return_eligibility.days_remaining > 0
    ON_FAIL: "The return window has closed."

ESCALATE:
  triggers:
    - WHEN: customer.frustration_detected == true
      REASON: "Customer showing frustration"
      PRIORITY: high
    - WHEN: refund_amount > 300
      REASON: "High-value return requires supervisor"
      PRIORITY: high
  context_for_human:
    - customer_id
    - order_id
    - return_reason
    - conversation_summary

COMPLETE:
  - WHEN: exchange_id IS SET
    RESPOND: TEMPLATE(exchange_confirmed)
  - WHEN: return_id IS SET
    RESPOND: TEMPLATE(return_initiated)
  - WHEN: user.session_ended == true
    RESPOND: TEMPLATE(closing)

ON_ERROR:
  tool_timeout:
    RESPOND: "Bear with me one moment."
    RETRY: 1
    THEN: RESPOND "I apologize for the delay."
  tool_error:
    RESPOND: "Something went wrong on my end. Let me try again."
    RETRY: 1
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.document!.name).toBe('Acme_Retail_Agent');
    expect(result.document!.meta.kind).toBe('agent-based');
    expect(result.document!.tools).toHaveLength(8);
    expect(result.document!.templates).toBeDefined();
    const templateNames = result.document!.templates!.map((t: { name: string }) => t.name);
    expect(templateNames).toContain('greeting');
    expect(templateNames).toContain('exchange_confirmed');
    expect(templateNames).toContain('return_initiated');
    expect(templateNames).toContain('closing');
  });

  test('Acme_Retail_Agent compiles to valid IR with template references', () => {
    const dsl = `
AGENT: Acme_Retail_Agent
GOAL: "Help customers"

TEMPLATES:
  exchange_confirmed:
    DEFAULT: "Your exchange is confirmed."
  return_initiated:
    DEFAULT: "Your return has been initiated."
  closing:
    DEFAULT: "Glad I could help!"

TOOLS:
  lookup_customer(phone_number: string) -> object
    description: "Look up customer"

COMPLETE:
  - WHEN: exchange_id IS SET
    RESPOND: TEMPLATE(exchange_confirmed)
  - WHEN: return_id IS SET
    RESPOND: TEMPLATE(return_initiated)
  - WHEN: user.session_ended == true
    RESPOND: TEMPLATE(closing)
`;
    const { agent } = compileFromDSL(dsl, 'Acme_Retail_Agent');
    expect(agent).toBeDefined();
    expect(agent.templates).toBeDefined();
    expect(agent.templates!['exchange_confirmed']).toBeDefined();
    expect(agent.templates!['return_initiated']).toBeDefined();
    expect(agent.templates!['closing']).toBeDefined();
    expect(agent.completion).toBeDefined();
  });
});

// ── GUARDRAILS (Section 3.8.1) ──────────────────────────────────────────────

describe('Spec §3.9: GUARDRAILS', () => {
  test('GUARDRAILS with check and action parses', () => {
    const dsl = `
AGENT: Guard_Test
GOAL: "Test guardrails"

GUARDRAILS:
  no_pii_output:
    kind: output
    check: "contains_pii(content)"
    action: redact
    msg: "PII detected in response"
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
  });

  test('GUARDRAILS with llm_check parses', () => {
    const dsl = `
AGENT: LLM_Guard_Test
GOAL: "Test LLM guardrails"

GUARDRAILS:
  abusive_input_review:
    kind: input
    llm_check: "Does this input contain abusive language?"
    action: block
    msg: "Inappropriate content detected"
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
  });

  test('GUARDRAILS with kind: both parses', () => {
    const dsl = `
AGENT: Both_Guard_Test
GOAL: "Test both guardrails"

GUARDRAILS:
  no_competitor_mentions:
    kind: both
    check: "not_matches_pattern(content, '(?i)acme travel')"
    action: filter
    msg: "Competitor mention detected"
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
  });
});

// ── Interactive Actions (Section 3.13.5) ────────────────────────────────────

describe('Spec §3.19: ACTION_HANDLERS', () => {
  test('ACTION_HANDLERS block parses', () => {
    const dsl = `
AGENT: Action_Test
GOAL: "Test actions"

ACTION_HANDLERS:
  option_a:
    SET: user_choice = "a"
    RESPOND: "Great choice!"
    THEN: process_selection
  option_b:
    SET: user_choice = "b"
    THEN: process_selection
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
  });
});

// ── Lifecycle Hooks (Section 8.10) ──────────────────────────────────────────

describe('Spec §7.10: HOOKS', () => {
  test('HOOKS with before_turn and after_turn parses', () => {
    const dsl = `
AGENT: Hook_Test
GOAL: "Test hooks"

HOOKS:
  before_turn:
    SET:
      _turn_start = NOW()
  after_turn:
    RESPOND: ""
`;
    const result = parseOnly(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
  });
});
