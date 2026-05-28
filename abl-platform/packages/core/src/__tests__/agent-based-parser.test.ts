/**
 * Agent-Based Parser Tests
 */

import { describe, test, expect, it } from 'vitest';
import { parseAgentBasedABL } from '../parser/agent-based-parser.js';

describe('AgentBasedParser', () => {
  test('should parse basic agent', () => {
    const dsl = `
AGENT: Test_Agent

GOAL: "Help users with their questions"

PERSONA: "Friendly and helpful assistant"
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.document?.name).toBe('Test_Agent');
  });

  test('should parse agent with GOAL and PERSONA', () => {
    const dsl = `
AGENT: Greeter

GOAL: "Welcome users"

PERSONA: "Enthusiastic greeter"
`;

    const result = parseAgentBasedABL(dsl);
    if (result.errors.length > 0) {
      console.log('Errors:', JSON.stringify(result.errors, null, 2));
    }
    expect(result.errors).toHaveLength(0);
  });

  test('parses consent-aware tool confirmation properties', () => {
    const dsl = `
AGENT: Refund_Agent

GOAL: "Refund eligible orders"

TOOLS:
  issue_refund(order_id: string, refund_amount: number) -> { refund_id: string }
    description: "Issue an approved refund"
    side_effects: true
    confirm: when_side_effects
    immutable: [order_id, refund_amount]
    consent_required_in: conversation
    consent_scope: [order_id, refund_amount]
    consent_action: "refund"
    consent_fallback: explicit_prompt
`;

    const result = parseAgentBasedABL(dsl);

    expect(result.errors).toHaveLength(0);
    expect(result.document?.tools[0]?.confirmation).toEqual({
      require: 'when_side_effects',
      immutableParams: ['order_id', 'refund_amount'],
      consentRequiredIn: 'conversation',
      consentScope: ['order_id', 'refund_amount'],
      consentAction: 'refund',
      consentFallback: 'explicit_prompt',
    });
  });

  test('should parse IDENTITY section', () => {
    const dsl = `
AGENT: Farewell
GOAL: "Handle agent tasks"

IDENTITY:
  role: "Customer Experience Closer"
  persona: "Warm and appreciative"
  expertise: ["conversation closing", "satisfaction check"]
  limitations: ["cannot process new requests"]
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.document?.goal.description).toBe('Customer Experience Closer');
    expect(result.document?.limitations).toHaveLength(1);
  });

  test('should parse MEMORY with READS and WRITES', () => {
    const dsl = `
AGENT: Support
GOAL: "Handle agent tasks"

IDENTITY:
  role: "Support Specialist"

MEMORY:
  READS:
    - user.id
    - user.name
    - user.loyalty_tier
  WRITES:
    - session.case_id
    - session.issue_type
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    // READS (3) + WRITES (2) both go to persistent memory with access markers
    expect(result.document?.memory.persistent).toHaveLength(5);
    const reads = result.document?.memory.persistent.filter((p) => p.access === 'read');
    const writes = result.document?.memory.persistent.filter((p) => p.access === 'write');
    expect(reads).toHaveLength(3);
    expect(writes).toHaveLength(2);
    expect(result.document?.memory.session).toHaveLength(0);
  });

  test('should parse TOOLS section', () => {
    const dsl = `
AGENT: Trip_Manager
GOAL: "Handle agent tasks"

IDENTITY:
  role: "Booking Specialist"

TOOLS:
  get_booking(confirmation: string) -> object
  list_user_bookings(user_id: string, status: string) -> array
  modify_booking(booking_id: string, change_type: string, new_value: object) -> object
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document?.tools).toHaveLength(3);
    expect(result.document?.tools[0].name).toBe('get_booking');
    expect(result.document?.tools[0].parameters).toHaveLength(1);
  });

  test('should parse STEPS section', () => {
    const dsl = `
AGENT: Greeter
GOAL: "Handle agent tasks"

IDENTITY:
  role: "Welcome Specialist"

STEPS:
  1. Welcome
     RESPOND "Hello! Welcome to our service."
     WAIT_INPUT
       DEFAULT -> 2

  2. ClassifyNeed
     RESPOND "What can I help you with?"
     WAIT_INPUT
       INTENT(flights, fly) -> 3
       DEFAULT -> 4

  3. FlightIntent
     RESPOND "Let me help with flights!"
     SIGNAL: COMPLETE

  4. Other
     RESPOND "I can help with that too!"
     SIGNAL: COMPLETE
`;

    const result = parseAgentBasedABL(dsl);
    // STEPS format is legacy — REASONING validation is not applied to it
    expect(result.errors).toHaveLength(0);
    expect(result.document?.flow).not.toBeUndefined();
    expect(result.document?.flow?.steps).toHaveLength(4);
    expect(result.document?.flow?.definitions['Welcome']).toBeDefined();
    expect(result.document?.flow?.definitions['Welcome'].respond).toBe(
      'Hello! Welcome to our service.',
    );
  });

  test('should parse GUARDRAILS section', () => {
    const dsl = `
AGENT: Support
GOAL: "Handle agent tasks"

IDENTITY:
  role: "Support Agent"

GUARDRAILS:
  empathy_required:
    kind: output
    check: "shows_empathy"
    action: warn
    msg: "Always acknowledge customer frustration with empathy"

  accurate_timelines:
    kind: output
    check: "use_system_timelines"
    action: ensure
    msg: "Only quote processing times from system"
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document?.guardrails).toHaveLength(2);
  });

  test('should skip comments', () => {
    const dsl = `
// This is a comment
AGENT: Test_Agent

# Another comment

// Comment before GOAL
GOAL: "Help users"
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document?.name).toBe('Test_Agent');
  });

  test('should parse complete traveldesk-style agent', () => {
    const dsl = `
// =============================================================================
// Farewell Agent - Closing Conversations
// (simple closing flow)
// =============================================================================

AGENT: Farewell
GOAL: "Handle agent tasks"

IDENTITY:
  role: "Customer Experience Closer"
  persona: "Warm and appreciative, leaves customers with positive last impression"
  expertise: ["conversation closing", "satisfaction check", "next steps"]
  limitations: ["cannot process new requests"]

// =============================================================================
// MEMORY ACCESS
// =============================================================================

MEMORY:
  READS:
    - user.name
    - user.loyalty_tier
    - session.booking_reference
    - session.case_id

// =============================================================================
// SCRIPTED FLOW
// =============================================================================

STEPS:
  1. CheckMoreHelp
     RESPOND "Before you go, is there anything else I can help you with today?"
     WAIT_INPUT
       INTENT(no, nothing, done, good, all set) -> 2
       INTENT(yes, actually, one more, wait) -> 6
       DEFAULT -> 2

  2. CheckContext
     IF session.booking_reference EXISTS THEN
       GOTO 3
     ELSE IF session.case_id EXISTS THEN
       GOTO 4
     ELSE
       GOTO 5

  3. FarewellWithBooking
     IF memory.user.loyalty_tier IN ["gold", "platinum"] THEN
       RESPOND "Thanks for booking with traveldesk.example.com!"
     ELSE
       RESPOND "Thanks for booking!"
     SIGNAL: COMPLETE

  4. FarewellWithCase
     RESPOND "Thanks for your patience."
     SIGNAL: COMPLETE

  5. SimpleFarewell
     RESPOND "Thanks for visiting!"
     SIGNAL: COMPLETE

  6. RedirectToHelp
     RESPOND "Of course! What else can I help you with?"
     SIGNAL: COMPLETE

// =============================================================================
// GUARDRAILS
// =============================================================================

GUARDRAILS:
  positive_closing:
    kind: output
    check: "end_positively"
    action: ensure
    msg: "Always end on a positive, travel-excited note"

  loyalty_appreciation:
    kind: output
    check: "acknowledge_loyalty"
    action: recommend
    msg: "Acknowledge and appreciate loyalty members"
`;

    const result = parseAgentBasedABL(dsl);
    // STEPS format is legacy — REASONING validation is not applied to it
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.document?.name).toBe('Farewell');

    expect(result.document?.memory.persistent.length).toBeGreaterThan(0);
    expect(result.document?.flow).toBeDefined();
    expect(result.document?.flow?.steps.length).toBeGreaterThan(0);
    expect(result.document?.guardrails?.length).toBe(2);
  });

  describe('FLOW with ON_INPUT', () => {
    test('should parse FLOW with steps sequence', () => {
      const dsl = `
AGENT: Flow_Test

GOAL: "Test flow parsing"

FLOW:
  step1 -> step2 -> step3

  step1:
    REASONING: false
    RESPOND: "Welcome!"
    THEN: step2

  step2:
    REASONING: false
    COLLECT: name
    PROMPT: "What is your name?"
    THEN: step3

  step3:
    REASONING: false
    RESPOND: "Goodbye, {{name}}!"
    THEN: COMPLETE
`;

      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.flow?.steps).toEqual(['step1', 'step2', 'step3']);
      expect(result.document?.flow?.definitions['step1']).toBeDefined();
    });

    test('should parse ON_INPUT with IF conditions', () => {
      const dsl = `
AGENT: OnInput_Test

GOAL: "Test ON_INPUT parsing"

FLOW:
  start -> get_input

  start:
    REASONING: false
    RESPOND: "Hello!"
    THEN: get_input

  get_input:
    REASONING: false
    COLLECT: user_input
    PROMPT: "Enter something:"
    ON_INPUT:
      - IF: input == "back"
        RESPOND: "Going back..."
        THEN: start
      - IF: input contains "help"
        RESPOND: "Here's help!"
        THEN: start
      - ELSE:
        THEN: COMPLETE
`;

      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.flow?.definitions['get_input'].onInput).toBeDefined();
      expect(result.document?.flow?.definitions['get_input'].onInput).toHaveLength(3);

      const onInput = result.document?.flow?.definitions['get_input'].onInput!;
      expect(onInput[0].condition).toBe('input == "back"');
      expect(onInput[0].respond).toBe('Going back...');
      expect(onInput[0].then).toBe('start');

      expect(onInput[1].condition).toBe('input contains "help"');
      expect(onInput[1].respond).toBe("Here's help!");

      // ELSE branch has no condition
      expect(onInput[2].condition).toBeUndefined();
      expect(onInput[2].then).toBe('COMPLETE');
    });

    test('should parse ON_INPUT with SET assignments', () => {
      const dsl = `
AGENT: Set_Test

GOAL: "Test SET in ON_INPUT"

FLOW:
  start -> get_choice

  start:
    REASONING: false
    RESPOND: "Choose an option"
    THEN: get_choice

  get_choice:
    REASONING: false
    COLLECT: choice
    PROMPT: "1 or 2?"
    ON_INPUT:
      - IF: input == "1"
        SET: option = "first"
        THEN: COMPLETE
      - IF: input == "2"
        SET: option = "second"
        RESPOND: "You chose option 2"
        THEN: COMPLETE
      - ELSE:
        SET: option = "unknown"
        THEN: get_choice
`;

      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      const onInput = result.document?.flow?.definitions['get_choice'].onInput!;
      expect(onInput[0].set).toEqual({ option: '"first"' });
      expect(onInput[1].set).toEqual({ option: '"second"' });
      expect(onInput[1].respond).toBe('You chose option 2');
      expect(onInput[2].set).toEqual({ option: '"unknown"' });
    });

    test('should parse ON_INPUT with CALL', () => {
      const dsl = `
AGENT: Call_Test

GOAL: "Test CALL in ON_INPUT"

TOOLS:
  process_input(value: string) -> object

FLOW:
  start -> get_value

  start:
    REASONING: false
    RESPOND: "Enter a value"
    THEN: get_value

  get_value:
    REASONING: false
    COLLECT: value
    PROMPT: "Value:"
    ON_INPUT:
      - IF: input != "skip"
        CALL: process_input(value)
        RESPOND: "Processed!"
        THEN: COMPLETE
      - ELSE:
        THEN: COMPLETE
`;

      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      const onInput = result.document?.flow?.definitions['get_value'].onInput!;
      expect(onInput[0].call).toBe('process_input(value)');
      expect(onInput[0].respond).toBe('Processed!');
    });

    test('should parse complex multi-step flow with navigation', () => {
      const dsl = `
AGENT: Navigation_Test

GOAL: "Test complex navigation patterns"

FLOW:
  welcome -> step1 -> step2 -> step3 -> complete

  welcome:
    REASONING: false
    RESPOND: "Welcome! Say 'back' at any point to go back."
    THEN: step1

  step1:
    REASONING: false
    COLLECT: field1
    PROMPT: "Enter field 1:"
    ON_INPUT:
      - IF: input == "back"
        RESPOND: "You're at the first step."
        THEN: step1
      - IF: input == "cancel"
        THEN: welcome
      - ELSE:
        THEN: step2

  step2:
    REASONING: false
    COLLECT: field2
    PROMPT: "Enter field 2:"
    ON_INPUT:
      - IF: input == "back"
        THEN: step1
      - IF: input contains "change field1"
        THEN: step1
      - ELSE:
        THEN: step3

  step3:
    REASONING: false
    COLLECT: field3
    PROMPT: "Enter field 3:"
    ON_INPUT:
      - IF: input == "back"
        THEN: step2
      - IF: input == "start over"
        THEN: welcome
      - ELSE:
        THEN: complete

  complete:
    REASONING: false
    RESPOND: "All done! Fields: {{field1}}, {{field2}}, {{field3}}"
    THEN: COMPLETE
`;

      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.flow?.steps).toEqual([
        'welcome',
        'step1',
        'step2',
        'step3',
        'complete',
      ]);

      // Verify step2 navigation
      const step2 = result.document?.flow?.definitions['step2'];
      expect(step2?.onInput).toHaveLength(3);
      expect(step2?.onInput?.[0].condition).toBe('input == "back"');
      expect(step2?.onInput?.[0].then).toBe('step1');
      expect(step2?.onInput?.[1].condition).toBe('input contains "change field1"');
    });

    test('should not confuse ON_INPUT with step definition', () => {
      const dsl = `
AGENT: Confusion_Test

GOAL: "Test ON_INPUT is not parsed as step"

FLOW:
  step1 -> step2

  step1:
    REASONING: false
    COLLECT: name
    PROMPT: "Name?"
    ON_INPUT:
      - IF: input == "back"
        THEN: step1
      - ELSE:
        THEN: step2

  step2:
    REASONING: false
    RESPOND: "Hello {{name}}"
    THEN: COMPLETE
`;

      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      // ON_INPUT should NOT appear as a step definition
      const stepNames = Object.keys(result.document?.flow?.definitions || {});
      expect(stepNames).toEqual(['step1', 'step2']);
      expect(stepNames).not.toContain('ON_INPUT');

      // step1 should have onInput property
      expect(result.document?.flow?.definitions['step1'].onInput).toBeDefined();
    });

    test('should parse YAML-style steps list format', () => {
      const dsl = `
AGENT: YAML_Steps_Test

GOAL: "Test YAML-style steps list parsing"

FLOW:
  steps:
    - welcome
    - get_name
    - get_email
    - confirm

  welcome:
    REASONING: false
    RESPOND: "Welcome!"
    THEN: get_name

  get_name:
    REASONING: false
    COLLECT: name
    PROMPT: "What is your name?"
    ON_INPUT:
      - IF: input == "back"
        THEN: welcome
      - ELSE:
        THEN: get_email

  get_email:
    REASONING: false
    COLLECT: email
    PROMPT: "What is your email?"
    ON_INPUT:
      - IF: input == "back"
        THEN: get_name
      - ELSE:
        THEN: confirm

  confirm:
    REASONING: false
    RESPOND: "Thanks {{name}}! We'll contact you at {{email}}."
    THEN: COMPLETE
`;

      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      // Verify steps list is parsed correctly
      expect(result.document?.flow?.steps).toEqual(['welcome', 'get_name', 'get_email', 'confirm']);

      // Verify step definitions are parsed
      expect(Object.keys(result.document?.flow?.definitions || {})).toHaveLength(4);
      expect(result.document?.flow?.definitions['welcome']).toBeDefined();
      expect(result.document?.flow?.definitions['get_name']).toBeDefined();
      expect(result.document?.flow?.definitions['get_email']).toBeDefined();
      expect(result.document?.flow?.definitions['confirm']).toBeDefined();

      // Verify step content
      expect(result.document?.flow?.definitions['get_name'].onInput).toHaveLength(2);
    });

    it('should parse GATHER with FIELDS block format', () => {
      const dsl = `
AGENT: GatherFieldsTest
GOAL: "Test GATHER with FIELDS"

FLOW:
  start -> collect_info -> end

  start:
    REASONING: false
    RESPOND: "Welcome!"
    THEN: collect_info

  collect_info:
    REASONING: false
    PROMPT: "Please provide your travel details"
    GATHER:
      FIELDS:
        - checkin_date: required
        - checkout_date: required
        - num_guests: required
      STRATEGY: llm
    THEN: end

  end:
    REASONING: false
    RESPOND: "Thanks!"
    THEN: COMPLETE
`;

      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      const collectStep = result.document?.flow?.definitions['collect_info'];
      expect(collectStep?.gather).toBeDefined();
      expect(collectStep?.gather?.fields).toHaveLength(3);
      expect(collectStep?.gather?.fields?.map((f) => f.name)).toEqual([
        'checkin_date',
        'checkout_date',
        'num_guests',
      ]);
      expect(collectStep?.gather?.fields?.[0].required).toBe(true);
      expect(collectStep?.gather?.strategy).toBe('llm');
    });

    it('should parse GATHER with direct field list (no FIELDS keyword)', () => {
      const dsl = `
AGENT: GatherDirectTest
GOAL: "Test GATHER with direct fields"

FLOW:
  start -> end

  start:
    REASONING: false
    PROMPT: "Enter details"
    GATHER:
      - name: required
      - email: required
    THEN: end

  end:
    REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;

      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      const startStep = result.document?.flow?.definitions['start'];
      expect(startStep?.gather).toBeDefined();
      expect(startStep?.gather?.fields).toHaveLength(2);
      expect(startStep?.gather?.fields?.map((f) => f.name)).toEqual(['name', 'email']);
    });

    it('should parse GATHER with inline format', () => {
      const dsl = `
AGENT: GatherInlineTest
GOAL: "Test inline GATHER"

FLOW:
  start -> end

  start:
    REASONING: false
    PROMPT: "Enter name and age"
    GATHER: name, age: required
    THEN: end

  end:
    REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;

      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      const startStep = result.document?.flow?.definitions['start'];
      expect(startStep?.gather).toBeDefined();
      expect(startStep?.gather?.fields?.map((f) => f.name)).toEqual(['name', 'age']);
    });

    test('COLLECT keyword is not recognized in flow steps', () => {
      const input = `
AGENT: Test_Agent
VERSION: "1.0"
GOAL: Test agent

FLOW:
  entry_point: start

  start:
    REASONING: false
    COLLECT: name
    THEN: done

  done:
    REASONING: false
    RESPOND: "Done"
`;
      const result = parseAgentBasedABL(input);
      const startStep = result.document?.flow?.definitions['start'];
      expect((startStep as any)?.collect).toBeUndefined();
    });
  });

  // ===========================================================================
  // TOOL BINDING TYPES
  // ===========================================================================

  describe('Tool parameters: block', () => {
    it('parses parameters: block with nested items in agent DSL', () => {
      const dsl = `
AGENT: TestAgent
VERSION: "1.0"
DESCRIPTION: "Test"
GOAL: "Test nested params"

TOOLS:
  search(queries: object[]) -> {results: object[]}
    description: "Search with structured queries"
    parameters:
      queries:
        type: object[]
        description: "Array of search queries"
        required: true
        items:
          query:
            type: string
            description: "Search text"
            required: true
          namespace:
            type: string
            description: "Target namespace"
            required: true

FLOW:
  STEP main:
    ACTION: respond
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      const tool = result.document.tools[0];
      expect(tool.name).toBe('search');
      expect(tool.description).toBe('Search with structured queries');

      const queriesParam = tool.parameters[0];
      expect(queriesParam.name).toBe('queries');
      expect(queriesParam.description).toBe('Array of search queries');
      expect(queriesParam.items).toBeDefined();
      expect(queriesParam.items!.properties).toHaveLength(2);
      expect(queriesParam.items!.properties![0].name).toBe('query');
      expect(queriesParam.items!.properties![1].name).toBe('namespace');
    });
  });

  describe('Tool Binding Types', () => {
    test('should reject HTTP implementation properties in agent DSL TOOLS section', () => {
      const dsl = `
AGENT: HttpToolAgent
GOAL: "Handle agent tasks"

TOOLS:
  verify_email(email: string) -> {valid: boolean}
    description: "Verify email address"
    type: http
    endpoint: "https://api.verify.com/check"
    method: POST
    auth: api_key
    timeout: 3000
    retry: 2
`;

      const result = parseAgentBasedABL(dsl);
      // Should emit E720 warnings for each implementation property: endpoint, method, auth, timeout, retry
      const e720Warnings = result.warnings.filter((e) => e.message.startsWith('E720:'));
      expect(e720Warnings).toHaveLength(5);
      expect(e720Warnings.map((e) => e.message)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("'endpoint'"),
          expect.stringContaining("'method'"),
          expect.stringContaining("'auth'"),
          expect.stringContaining("'timeout'"),
          expect.stringContaining("'retry'"),
        ]),
      );

      // Tool signature and allowed properties should still be parsed
      expect(result.document?.tools).toHaveLength(1);
      const tool = result.document!.tools[0];
      expect(tool.name).toBe('verify_email');
      expect(tool.type).toBe('http');
      expect(tool.description).toBe('Verify email address');
      // Implementation bindings should NOT be applied
      expect(tool.httpBinding).toBeUndefined();
    });

    test('should reject MCP implementation properties in agent DSL TOOLS section', () => {
      const dsl = `
AGENT: McpToolAgent
GOAL: "Handle agent tasks"

TOOLS:
  get_weather(location: string) -> {temp: number, conditions: string}
    description: "Get current weather"
    type: mcp
    server: "weather-service"
`;

      const result = parseAgentBasedABL(dsl);
      const e720Warnings = result.warnings.filter((e) => e.message.startsWith('E720:'));
      expect(e720Warnings).toHaveLength(1);
      expect(e720Warnings[0].message).toContain("'server'");

      expect(result.document?.tools).toHaveLength(1);
      const tool = result.document!.tools[0];
      expect(tool.name).toBe('get_weather');
      expect(tool.type).toBe('mcp');
      // Implementation bindings should NOT be applied
      expect(tool.mcpBinding).toBeUndefined();
    });

    test('should reject Lambda implementation properties in agent DSL TOOLS section', () => {
      const dsl = `
AGENT: LambdaAgent
GOAL: "Handle agent tasks"

TOOLS:
  process_document(doc_url: string) -> {summary: string}
    description: "Process document with ML pipeline"
    type: lambda
    function: "doc-processor"
    runtime: "nodejs20"
    timeout: 30000
`;

      const result = parseAgentBasedABL(dsl);
      // runtime and timeout are in the implementation set; function is not
      const e720Warnings = result.warnings.filter((e) => e.message.startsWith('E720:'));
      expect(e720Warnings).toHaveLength(2);
      expect(e720Warnings.map((e) => e.message)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("'runtime'"),
          expect.stringContaining("'timeout'"),
        ]),
      );

      const tool = result.document!.tools[0];
      expect(tool.name).toBe('process_document');
      expect(tool.type).toBe('lambda');
      // Implementation bindings should NOT be applied
      expect(tool.lambdaBinding).toBeUndefined();
    });

    test('should reject Sandbox implementation properties in agent DSL TOOLS section', () => {
      const dsl = `
AGENT: SandboxAgent
GOAL: "Handle agent tasks"

TOOLS:
  calculate_risk(data: object) -> {score: number, factors: string[]}
    description: "Custom risk scoring model"
    type: sandbox
    runtime: "javascript"
    code: "calculateRisk"
    timeout: 5000
    memory_mb: 128
`;

      const result = parseAgentBasedABL(dsl);
      // runtime, code, timeout, memory_mb are all implementation properties
      const e720Warnings = result.warnings.filter((e) => e.message.startsWith('E720:'));
      expect(e720Warnings).toHaveLength(4);
      expect(e720Warnings.map((e) => e.message)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("'runtime'"),
          expect.stringContaining("'code'"),
          expect.stringContaining("'timeout'"),
          expect.stringContaining("'memory_mb'"),
        ]),
      );

      const tool = result.document!.tools[0];
      expect(tool.name).toBe('calculate_risk');
      expect(tool.type).toBe('sandbox');
      // Implementation bindings should NOT be applied
      expect(tool.sandboxBinding).toBeUndefined();
    });

    test('should reject implementation properties in mixed tools but allow contract-only tools', () => {
      const dsl = `
AGENT: MixedAgent
GOAL: "Handle agent tasks"

TOOLS:
  format_results(hotels: object[]) -> string
    description: "Format hotel results for display"

  search_hotels(destination: string, checkin: string) -> object[]
    description: "Search available hotels"
    type: http
    endpoint: "https://api.hotels.com/search"
    method: POST
    auth: bearer

  get_weather(location: string) -> {temp: number}
    type: mcp
    server: "weather-service"
`;

      const result = parseAgentBasedABL(dsl);
      // E720 warnings for: endpoint, method, auth (HTTP) + server (MCP)
      const e720Warnings = result.warnings.filter((e) => e.message.startsWith('E720:'));
      expect(e720Warnings).toHaveLength(4);
      expect(result.document?.tools).toHaveLength(3);

      // Contract-only tool (no type) — no warnings, all properties allowed
      const formatTool = result.document!.tools[0];
      expect(formatTool.name).toBe('format_results');
      expect(formatTool.type).toBeUndefined();
      expect(formatTool.httpBinding).toBeUndefined();

      // HTTP tool — signature props parsed, bindings stripped
      const searchTool = result.document!.tools[1];
      expect(searchTool.name).toBe('search_hotels');
      expect(searchTool.type).toBe('http');
      expect(searchTool.httpBinding).toBeUndefined();

      // MCP tool — signature props parsed, bindings stripped
      const weatherTool = result.document!.tools[2];
      expect(weatherTool.name).toBe('get_weather');
      expect(weatherTool.type).toBe('mcp');
      expect(weatherTool.mcpBinding).toBeUndefined();
    });

    test('should reject FROM/USE tool import syntax with E720', () => {
      const dsl = `
AGENT: ImportAgent
GOAL: "Handle agent tasks"

TOOLS:
  FROM "./tools/hotels-api.tools.abl" USE: search_hotels, get_hotel

  format_results(hotels: object[]) -> string
    description: "Format hotel results"
`;

      const result = parseAgentBasedABL(dsl);
      // FROM...USE syntax has been removed — should emit E720
      const e720Errors = result.errors.filter((e) => e.message.startsWith('E720:'));
      expect(e720Errors).toHaveLength(1);
      expect(e720Errors[0].message).toContain('FROM...USE');

      // The inline tool should still be parsed
      expect(result.document?.tools).toHaveLength(1);
      expect(result.document?.tools[0].name).toBe('format_results');
    });

    test('should reject implementation properties but still parse hints', () => {
      const dsl = `
AGENT: HintsAgent
GOAL: "Handle agent tasks"

TOOLS:
  search_api(query: string) -> object
    description: "Search API"
    type: http
    endpoint: "https://api.example.com/search"
    method: GET
    cacheable: true
    latency: slow
    side_effects: false
`;

      const result = parseAgentBasedABL(dsl);
      // E720 warnings for endpoint and method
      const e720Warnings = result.warnings.filter((e) => e.message.startsWith('E720:'));
      expect(e720Warnings).toHaveLength(2);
      expect(e720Warnings.map((e) => e.message)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("'endpoint'"),
          expect.stringContaining("'method'"),
        ]),
      );

      const tool = result.document!.tools[0];
      expect(tool.type).toBe('http');
      expect(tool.httpBinding).toBeUndefined();
      // Hints should still be parsed
      expect(tool.hints?.cacheable).toBe(true);
      expect(tool.hints?.latency).toBe('slow');
      expect(tool.hints?.side_effects).toBe(false);
    });

    test('should allow description and type without errors', () => {
      const dsl = `
AGENT: SignatureOnlyAgent
GOAL: "Handle agent tasks"

TOOLS:
  get_data(id: string) -> object
    description: "Retrieve data by ID"
    type: http
`;

      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);

      const tool = result.document!.tools[0];
      expect(tool.name).toBe('get_data');
      expect(tool.description).toBe('Retrieve data by ID');
      expect(tool.type).toBe('http');
    });

    test('should NOT flag implementation properties nested inside hints block', () => {
      const dsl = `
AGENT: WeatherAgent
GOAL: "Help users get weather"

TOOLS:
  get_current_weather(city: string) -> object
    description: "Get current weather conditions"
    type: http
    hints:
      timeout: 15000
      side_effects: true

  get_forecast(city: string) -> object
    description: "Get weather forecast"
    type: http
    hints:
      timeout: 15000
`;

      const result = parseAgentBasedABL(dsl);
      // No E720 errors or warnings — timeout is nested inside hints (allowed)
      const e720Messages = [
        ...result.errors.filter((e) => e.message.startsWith('E720:')),
        ...result.warnings.filter((w) => w.message.startsWith('E720:')),
      ];
      expect(e720Messages).toHaveLength(0);

      expect(result.document?.tools).toHaveLength(2);
      expect(result.document!.tools[0].hints?.timeout).toBe(15000);
      expect(result.document!.tools[0].hints?.side_effects).toBe(true);
      expect(result.document!.tools[1].hints?.timeout).toBe(15000);
    });

    test('should flag top-level timeout but NOT nested timeout under hints', () => {
      const dsl = `
AGENT: MixedTimeoutAgent
GOAL: "Test mixed timeout locations"

TOOLS:
  tool_a(x: string) -> object
    type: http
    timeout: 5000

  tool_b(x: string) -> object
    type: http
    hints:
      timeout: 15000
`;

      const result = parseAgentBasedABL(dsl);
      // tool_a has top-level timeout → E720 warning
      const e720Warnings = result.warnings.filter((w) => w.message.startsWith('E720:'));
      expect(e720Warnings).toHaveLength(1);
      expect(e720Warnings[0].message).toContain("'timeout'");

      // tool_b's hints.timeout should be parsed correctly, no E720
      expect(result.document!.tools[1].hints?.timeout).toBe(15000);
    });
  });

  // ===========================================================================
  // HANDOFF PARSER SAFETY (infinite loop prevention + syntax validation)
  // ===========================================================================

  describe('HANDOFF parsing safety', () => {
    test('should parse valid HANDOFF with correct TO: syntax', () => {
      const dsl = `
AGENT: Supervisor

GOAL: "Route conversations"

HANDOFF:
  - TO: Sales_Agent
    WHEN: intent.type == "sales"
    CONTEXT:
      pass: [customer_id, query]
      summary: "Customer wants to buy"

  - TO: Support_Agent
    WHEN: intent.type == "support"
    PRIORITY: 1
    PASS: [ticket_id]
    SUMMARY: "Customer needs help"
`;

      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document).not.toBeNull();
      expect(result.document?.handoff).toHaveLength(2);
      expect(result.document!.handoff![0].to).toBe('Sales_Agent');
      expect(result.document!.handoff![0].when).toBe('intent.type == "sales"');
      expect(result.document!.handoff![0].context.pass).toEqual(['customer_id', 'query']);
      expect(result.document!.handoff![0].context.summary).toBe('Customer wants to buy');
      expect(result.document!.handoff![1].to).toBe('Support_Agent');
      expect(result.document!.handoff![1].priority).toBe(1);
    });

    test('should not infinite loop on malformed lowercase handoff syntax (- agent: instead of - TO:)', () => {
      const dsl = `
AGENT: Bad_Supervisor

GOAL: "Route conversations"

HANDOFF:
  - agent: Intent_Analyzer
    when: intent.unclear
    context:
      pass: [raw_message]

  - agent: Product_Discovery
    when: intent.type == "product_search"

TOOLS:
  some_tool(x: string) -> object
`;

      // This must complete without hanging — previously caused infinite loop
      const result = parseAgentBasedABL(dsl);

      // Should parse without fatal errors (handoff entries are skipped with warnings)
      expect(result.document).not.toBeNull();
      // No handoffs should be parsed (all entries are malformed)
      expect(result.document?.handoff).toHaveLength(0);
      // Should produce warnings about invalid syntax
      expect(result.warnings.length).toBeGreaterThan(0);
      const handoffWarnings = result.warnings.filter((w) =>
        w.message.includes('Invalid HANDOFF entry'),
      );
      expect(handoffWarnings.length).toBeGreaterThan(0);
      // The TOOLS section after HANDOFF should still be parsed
      expect(result.document?.tools).toHaveLength(1);
      expect(result.document?.tools[0].name).toBe('some_tool');
    });

    test('should not infinite loop on - TO: with agent name containing spaces', () => {
      const dsl = `
AGENT: Supervisor

GOAL: "Route"

HANDOFF:
  - TO: My Agent Name With Spaces
    WHEN: always

TOOLS:
  helper(x: string) -> string
`;

      // The regex expects a single word: /^-\s*TO:\s*(\w+)$/
      // "My Agent Name With Spaces" won't match — must not infinite loop
      const result = parseAgentBasedABL(dsl);
      expect(result.document).not.toBeNull();
      // Should produce a warning about invalid format
      expect(result.warnings.length).toBeGreaterThan(0);
      // TOOLS section should still parse correctly
      expect(result.document?.tools).toHaveLength(1);
    });

    test('should enforce iteration limit on extremely malformed HANDOFF', () => {
      // Generate a large block of nonsense under HANDOFF that won't break out
      const lines = ['AGENT: Test', 'GOAL: "test"', '', 'HANDOFF:'];
      for (let i = 0; i < 100; i++) {
        lines.push(`  - invalid_entry_${i}: something`);
      }
      lines.push('');
      lines.push('TOOLS:');
      lines.push('  my_tool(x: string) -> object');

      const dsl = lines.join('\n');
      const result = parseAgentBasedABL(dsl);

      // Must complete without hanging
      expect(result.document).not.toBeNull();
      // Handoff should be empty (all entries invalid)
      expect(result.document?.handoff).toHaveLength(0);
      // Should have warnings for each invalid entry
      expect(result.warnings.length).toBeGreaterThanOrEqual(100);
    });

    test('should parse valid handoff entries and skip invalid ones in same block', () => {
      const dsl = `
AGENT: MixedSupervisor

GOAL: "Route"

HANDOFF:
  - TO: Valid_Agent
    WHEN: intent == "valid"
  - agent: Invalid_Agent
    when: intent == "invalid"
  - TO: Another_Valid
    WHEN: intent == "another"
`;

      const result = parseAgentBasedABL(dsl);
      expect(result.document).not.toBeNull();
      // Both valid TO: entries should be parsed as handoffs
      expect(result.document?.handoff).toHaveLength(2);
      expect(result.document!.handoff![0].to).toBe('Valid_Agent');
      expect(result.document!.handoff![1].to).toBe('Another_Valid');
      // The "- agent:" line is consumed harmlessly within the first handoff config block
      // (parseHandoffConfig ignores unrecognized lines while reading the config)
    });

    test('should warn on standalone invalid handoff entries not consumed by valid handoffs', () => {
      const dsl = `
AGENT: InvalidOnly

GOAL: "Route"

HANDOFF:
  - agent: Bad_Agent
  - name: Another_Bad

TOOLS:
  tool1(x: string) -> string
`;

      const result = parseAgentBasedABL(dsl);
      expect(result.document).not.toBeNull();
      expect(result.document?.handoff).toHaveLength(0);
      // Standalone invalid entries produce warnings
      const handoffWarnings = result.warnings.filter((w) =>
        w.message.includes('Invalid HANDOFF entry'),
      );
      expect(handoffWarnings.length).toBe(2);
      // TOOLS section after HANDOFF should still parse
      expect(result.document?.tools).toHaveLength(1);
    });
  });

  // ===========================================================================
  // DELEGATE PARSER SAFETY (infinite loop prevention + syntax validation)
  // ===========================================================================

  describe('DELEGATE parsing safety', () => {
    test('should parse valid DELEGATE with correct AGENT: syntax', () => {
      const dsl = `
AGENT: Orchestrator

GOAL: "Coordinate tasks"

DELEGATE:
  - AGENT: Research_Agent
    WHEN: needs_research == true
    PURPOSE: "Research the topic"
    INPUT: {topic: user_query}
    RETURNS: {findings: research_results}

  - AGENT: Summary_Agent
    WHEN: research_complete == true
    PURPOSE: "Summarize findings"
`;

      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document).not.toBeNull();
      expect(result.document?.delegate).toHaveLength(2);
      expect(result.document!.delegate![0].agent).toBe('Research_Agent');
      expect(result.document!.delegate![0].purpose).toBe('Research the topic');
      expect(result.document!.delegate![1].agent).toBe('Summary_Agent');
    });

    test('should not infinite loop on malformed delegate syntax (- name: instead of - AGENT:)', () => {
      const dsl = `
AGENT: Bad_Orchestrator

GOAL: "Coordinate"

DELEGATE:
  - name: Worker
    task: "do something"
  - name: Another_Worker

TOOLS:
  helper(x: string) -> string
`;

      const result = parseAgentBasedABL(dsl);
      expect(result.document).not.toBeNull();
      expect(result.document?.delegate).toHaveLength(0);
      expect(result.warnings.length).toBeGreaterThan(0);
      const delegateWarnings = result.warnings.filter((w) =>
        w.message.includes('Invalid DELEGATE entry'),
      );
      expect(delegateWarnings.length).toBeGreaterThan(0);
      // TOOLS section should still parse
      expect(result.document?.tools).toHaveLength(1);
    });

    test('should not infinite loop on - AGENT: with name containing spaces', () => {
      const dsl = `
AGENT: Orchestrator

GOAL: "Coordinate"

DELEGATE:
  - AGENT: My Agent With Spaces
    WHEN: always

TOOLS:
  tool1(x: string) -> string
`;

      const result = parseAgentBasedABL(dsl);
      expect(result.document).not.toBeNull();
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.document?.tools).toHaveLength(1);
    });

    test('should parse valid delegate entries and skip invalid ones', () => {
      const dsl = `
AGENT: MixedOrchestrator

GOAL: "Coordinate"

DELEGATE:
  - AGENT: Valid_Worker
    WHEN: task == "valid"
  - name: Bad_Worker
    task: "invalid"
  - AGENT: Another_Valid
    WHEN: task == "another"
`;

      const result = parseAgentBasedABL(dsl);
      expect(result.document).not.toBeNull();
      expect(result.document?.delegate).toHaveLength(2);
      expect(result.document!.delegate![0].agent).toBe('Valid_Worker');
      expect(result.document!.delegate![1].agent).toBe('Another_Valid');
    });
  });

  // ===========================================================================
  // ESCALATE PARSER SAFETY (infinite loop prevention + syntax validation)
  // ===========================================================================

  describe('ESCALATE parsing safety', () => {
    test('should parse valid ESCALATE with correct WHEN: syntax', () => {
      const dsl = `
AGENT: Support_Agent

GOAL: "Help customers"

ESCALATE:
  triggers:
    - WHEN: customer.frustration > 0.8
      REASON: "Customer is very frustrated"
      PRIORITY: high
    - WHEN: issue.complexity == "critical"
      REASON: "Critical issue needs human"
      PRIORITY: critical
  context_for_human:
    - conversation_history
    - customer.account_info
`;

      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document).not.toBeNull();
      expect(result.document?.escalate).toBeDefined();
      expect(result.document!.escalate!.triggers).toHaveLength(2);
      expect(result.document!.escalate!.triggers[0].when).toBe('customer.frustration > 0.8');
      expect(result.document!.escalate!.triggers[0].reason).toBe('Customer is very frustrated');
      expect(result.document!.escalate!.triggers[0].priority).toBe('high');
      expect(result.document!.escalate!.triggers[1].priority).toBe('critical');
      expect(result.document!.escalate!.contextForHuman).toHaveLength(2);
    });

    test('should not infinite loop on malformed ESCALATE trigger (- WHEN without colon)', () => {
      const dsl = `
AGENT: Support

GOAL: "Help"

ESCALATE:
  triggers:
    - WHEN customer is angry
    - WHEN no colon here either

TOOLS:
  help_tool(x: string) -> string
`;

      // "- WHEN customer is angry" starts with "- WHEN" but regex expects "- WHEN: ..."
      const result = parseAgentBasedABL(dsl);
      expect(result.document).not.toBeNull();
      expect(result.document?.escalate).toBeDefined();
      // No valid triggers (all missing colon after WHEN)
      expect(result.document!.escalate!.triggers).toHaveLength(0);
      // Should have warnings
      expect(result.warnings.length).toBeGreaterThan(0);
      const escalateWarnings = result.warnings.filter((w) =>
        w.message.includes('Invalid ESCALATE trigger'),
      );
      expect(escalateWarnings.length).toBeGreaterThan(0);
      // TOOLS section should still parse
      expect(result.document?.tools).toHaveLength(1);
    });

    test('should parse valid triggers and skip malformed ones', () => {
      const dsl = `
AGENT: Support

GOAL: "Help"

ESCALATE:
  triggers:
    - WHEN: frustration > 0.9
      REASON: "Very frustrated"
    - WHEN no_colon
    - WHEN: issue.critical == true
      REASON: "Critical issue"
`;

      const result = parseAgentBasedABL(dsl);
      expect(result.document).not.toBeNull();
      // Only valid triggers should be parsed
      expect(result.document!.escalate!.triggers).toHaveLength(2);
      expect(result.document!.escalate!.triggers[0].when).toBe('frustration > 0.9');
      expect(result.document!.escalate!.triggers[1].when).toBe('issue.critical == true');
    });
  });

  // ===========================================================================
  // REGRESSION: Complete supervisor with HANDOFF doesn't hang runtime
  // ===========================================================================

  describe('Supervisor regression tests', () => {
    test('should parse complete supervisor agent with HANDOFF without hanging', () => {
      const dsl = `
SUPERVISOR: Travel_Supervisor

GOAL: "Route customer inquiries to the right specialist agent"

PERSONA: "Professional travel coordinator"

HANDOFF:
  - TO: Sales_Agent
    WHEN: intent.type == "booking" || intent.type == "purchase"
    CONTEXT:
      pass: [customer_id, destination, travel_dates]
      summary: "Customer wants to make a booking"
    RETURN: true

  - TO: Support_Agent
    WHEN: intent.type == "support" || intent.type == "complaint"
    PRIORITY: 1
    PASS: [ticket_id, customer_history]
    SUMMARY: "Customer needs support"

  - TO: Farewell_Agent
    WHEN: intent.type == "goodbye"
    RETURN: false

TOOLS:
  classify_intent(message: string) -> {type: string, confidence: number}
    description: "Classify user intent"
`;

      const start = Date.now();
      const result = parseAgentBasedABL(dsl);
      const elapsed = Date.now() - start;

      // Should complete in under 1 second (was hanging indefinitely before fix)
      expect(elapsed).toBeLessThan(1000);
      expect(result.errors).toHaveLength(0);
      expect(result.document).not.toBeNull();
      expect(result.document?.name).toBe('Travel_Supervisor');
      expect(result.document?.handoff).toHaveLength(3);
      expect(result.document!.handoff![0].to).toBe('Sales_Agent');
      expect(result.document!.handoff![0].return).toBe(true);
      expect(result.document!.handoff![1].to).toBe('Support_Agent');
      expect(result.document!.handoff![1].priority).toBe(1);
      expect(result.document!.handoff![2].to).toBe('Farewell_Agent');
      expect(result.document!.handoff![2].return).toBe(false);
      expect(result.document?.tools).toHaveLength(1);
    });

    test('should handle completely malformed supervisor without hanging', () => {
      const dsl = `
SUPERVISOR: Bad_Supervisor

GOAL: "Route"

HANDOFF:
  - agent: Intent_Analyzer
    when: intent.unclear
    context:
      pass: [raw_message]
  - agent: Product_Discovery
    when: intent.type == "product_search"
    context:
      pass: [user_query]
      summary: "User searching for product"
  - agent: Savings_Engine
    when: intent.type == "savings"

DELEGATE:
  - name: Some_Worker
    task: "process something"

ESCALATE:
  triggers:
    - WHEN customer is very frustrated

TOOLS:
  route(msg: string) -> string
`;

      const start = Date.now();
      const result = parseAgentBasedABL(dsl);
      const elapsed = Date.now() - start;

      // Must complete quickly without hanging
      expect(elapsed).toBeLessThan(1000);
      expect(result.document).not.toBeNull();
      // All handoffs, delegates, and escalate triggers are malformed
      expect(result.document?.handoff).toHaveLength(0);
      expect(result.document?.delegate).toHaveLength(0);
      expect(result.document!.escalate!.triggers).toHaveLength(0);
      // Warnings should be generated for all malformed entries
      expect(result.warnings.length).toBeGreaterThan(0);
      // But tools should still parse fine
      expect(result.document?.tools).toHaveLength(1);
      expect(result.document?.tools[0].name).toBe('route');
    });

    test('should parse supervisor execution pipeline config without losing later sections', () => {
      const dsl = `
SUPERVISOR: Travel_Supervisor

GOAL: "Route customer inquiries to the right specialist agent"

EXECUTION:
  pipeline:
    enabled: true
    mode: parallel
    model: "gpt-4.1-mini"
    shortCircuit:
      enabled: true
      confidenceThreshold: 0.92
    toolFilter:
      enabled: true
      maxTools: 3
    keywordVeto:
      enabled: true
      keywords: ["refund", "fraud"]
    intentBridge:
      enabled: true
      programmaticThreshold: 0.8
      guidedThreshold: 0.65
      outOfScopeDecline: false
      multiIntentSignal: true

AGENTS:
  billing:
    file: "billing.abl"
  support:
    file: "support.abl"

INTENTS:
  refund:
    agent: billing
  support:
    agent: support

HANDOFF:
  - TO: Billing_Agent
    WHEN: intent.type == "refund"

  - TO: Support_Agent
    WHEN: intent.type == "support"
`;

      const result = parseAgentBasedABL(dsl);

      expect(result.errors).toHaveLength(0);
      expect(result.document?.execution?.pipeline).toEqual({
        enabled: true,
        mode: 'parallel',
        model: 'gpt-4.1-mini',
        shortCircuit: {
          enabled: true,
          confidenceThreshold: 0.92,
        },
        toolFilter: {
          enabled: true,
          maxTools: 3,
        },
        keywordVeto: {
          enabled: true,
          keywords: ['refund', 'fraud'],
        },
        intentBridge: {
          enabled: true,
          programmaticThreshold: 0.8,
          guidedThreshold: 0.65,
          outOfScopeDecline: false,
          multiIntentSignal: true,
        },
      });
      expect(result.document?.handoff).toHaveLength(2);
      expect(result.document?.handoff?.[0].to).toBe('Billing_Agent');
      expect(result.document?.handoff?.[1].to).toBe('Support_Agent');
    });

    test('should parse partial supervisor execution pipeline config without swallowing later sections', () => {
      const dsl = `
SUPERVISOR: Travel_Supervisor

GOAL: "Route customer inquiries to the right specialist agent"

EXECUTION:
  pipeline:
    shortCircuit:
      enabled: true

HANDOFF:
  - TO: Billing_Agent
    WHEN: intent.type == "refund"
`;

      const result = parseAgentBasedABL(dsl);

      expect(result.errors).toHaveLength(0);
      expect(result.document?.execution?.pipeline).toMatchObject({
        shortCircuit: {
          enabled: true,
        },
      });
      expect(result.document?.handoff).toHaveLength(1);
      expect(result.document?.handoff?.[0].to).toBe('Billing_Agent');
    });
  });

  // ===========================================================================
  // TEMPLATES PARSER TESTS
  // ===========================================================================

  describe('TEMPLATES parsing', () => {
    test('should parse TEMPLATES: block with multiple named templates', () => {
      const dsl = `
AGENT: Test_Agent

GOAL: "Help users"

TEMPLATES:
  greeting: "Hello, welcome!"
  farewell: "Goodbye, see you soon!"
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.templates).toHaveLength(2);
      expect(result.document?.templates?.[0].name).toBe('greeting');
      expect(result.document?.templates?.[0].content).toBe('Hello, welcome!');
      expect(result.document?.templates?.[1].name).toBe('farewell');
      expect(result.document?.templates?.[1].content).toBe('Goodbye, see you soon!');
    });

    test('should parse multi-line template with |', () => {
      const dsl = `
AGENT: Test_Agent

GOAL: "Help users"

TEMPLATES:
  greeting: |
    Hello {{user.name}}.
    Welcome to our service!
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.templates).toHaveLength(1);
      expect(result.document?.templates?.[0].name).toBe('greeting');
      expect(result.document?.templates?.[0].content).toContain('Hello {{user.name}}.');
      expect(result.document?.templates?.[0].content).toContain('Welcome to our service!');
    });

    test('should parse inline single-line template', () => {
      const dsl = `
AGENT: Test_Agent

GOAL: "Help users"

TEMPLATES:
  short_msg: "Thanks for using our service!"
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.templates).toHaveLength(1);
      expect(result.document?.templates?.[0].content).toBe('Thanks for using our service!');
    });

    test('should parse standalone TEMPLATE directive', () => {
      const dsl = `
AGENT: Test_Agent

GOAL: "Help users"

TEMPLATE greeting: "Hello there!"
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.templates).toHaveLength(1);
      expect(result.document?.templates?.[0].name).toBe('greeting');
      expect(result.document?.templates?.[0].content).toBe('Hello there!');
    });

    test('should accumulate mixed standalone + block templates', () => {
      const dsl = `
AGENT: Test_Agent

GOAL: "Help users"

TEMPLATE standalone_one: "First standalone"

TEMPLATES:
  block_one: "From block"

TEMPLATE standalone_two: "Second standalone"
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.templates).toHaveLength(3);
      expect(result.document?.templates?.[0].name).toBe('standalone_one');
      expect(result.document?.templates?.[1].name).toBe('block_one');
      expect(result.document?.templates?.[2].name).toBe('standalone_two');
    });

    test('should produce warning for empty template', () => {
      const dsl = `
AGENT: Test_Agent

GOAL: "Help users"

TEMPLATES:
  empty_one:
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.templates).toHaveLength(1);
      expect(result.document?.templates?.[0].content).toBe('');
      expect(result.warnings.some((w) => w.message.includes('empty_one'))).toBe(true);
    });

    test('should store RESPOND: TEMPLATE(name) as literal string (parser does not resolve)', () => {
      const dsl = `
AGENT: Test_Agent

GOAL: "Help users"

TEMPLATES:
  greeting: "Hello there!"

FLOW:
  steps: welcome
  welcome:
    REASONING: false
    RESPOND: TEMPLATE(greeting)
`;
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      // Parser stores the literal string, not the resolved content
      const step = result.document?.flow?.definitions['welcome'];
      expect(step?.respond).toBe('TEMPLATE(greeting)');
    });
  });
});
