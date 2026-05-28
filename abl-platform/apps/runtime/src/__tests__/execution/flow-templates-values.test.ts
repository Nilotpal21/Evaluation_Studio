/**
 * Flow Templates & Value Resolution Tests
 *
 * Tests for template interpolation ({{variable}}, {{#if}}, {{#each}}),
 * resolveSetValue (quote stripping, boolean/number parsing),
 * and value path resolution.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor';

type CapturedTrace = {
  type: string;
  data: Record<string, unknown>;
};

const ABLP_376_PIN_FLOW = `
AGENT: ABLP_376_Pin_Flow

GOAL: "Validate step-entry SET and arithmetic SET semantics"

FLOW:
  entry_point: init_auth
  steps:
    - init_auth
    - ask_pin
    - verify_pin
    - auth_fail
    - ask_confirm
    - compare_pin
    - confirm_retry
    - locked

init_auth:
  REASONING: false
  SET: auth_attempts = 0
  SET: is_authenticated = false
  SET: status_note = "verifying"
  RESPOND: "Let's verify your PIN. status={{status_note}}, attempts={{auth_attempts}}, authenticated={{is_authenticated}}"
  THEN: ask_pin

ask_pin:
  REASONING: false
  SET: pin = ""
  GATHER:
    - pin:
        required: true
        type: string
        prompt: "Enter your PIN."
  THEN: verify_pin

verify_pin:
  REASONING: false
  CHECK: pin == "1234"
  ON_FAIL: auth_fail
  RESPOND: "PIN accepted."
  THEN: ask_confirm

auth_fail:
  REASONING: false
  SET: auth_attempts = auth_attempts + 1
  CHECK: auth_attempts < 2
  ON_FAIL: locked
  RESPOND: "PIN mismatch. Attempts={{auth_attempts}}. Try again."
  THEN: ask_pin

ask_confirm:
  REASONING: false
  SET: confirm_pin = ""
  GATHER:
    - confirm_pin:
        required: true
        type: string
        prompt: "Re-enter PIN to confirm."
  THEN: compare_pin

compare_pin:
  REASONING: false
  CHECK: confirm_pin == pin
  ON_FAIL: confirm_retry
  SET: is_authenticated = true
  SET: status_note = "confirmed"
  RESPOND: "PIN confirmed. status={{status_note}}, authenticated={{is_authenticated}}"
  THEN: COMPLETE

confirm_retry:
  REASONING: false
  RESPOND: "Mismatch. Let's try confirmation again."
  THEN: ask_confirm

locked:
  REASONING: false
  SET: status_note = "locked"
  RESPOND: "Account locked after 2 attempts. status={{status_note}}"
  THEN: COMPLETE
`;

describe('Flow Templates & Value Resolution', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  // ===========================================================================
  // TEMPLATE INTERPOLATION
  // ===========================================================================

  describe('Template interpolation', () => {
    test('Simple {{variable}} replacement', async () => {
      const dsl = `
AGENT: Template_Simple_Test

GOAL: "Test simple template"

FLOW:
  entry_point: greet
  steps:
    - greet

greet:
  RESPOND: "Hello, {{name}}! Welcome to {{city}}."
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Template_Simple_Test'),
      );
      session.data.values.name = 'Alice';
      session.data.values.city = 'Paris';

      const chunks: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks.push(c));

      expect(chunks.join('')).toContain('Hello, Alice! Welcome to Paris.');
    });

    test('Nested {{object.property}} paths', async () => {
      const dsl = `
AGENT: Template_Nested_Test

GOAL: "Test nested paths"

FLOW:
  entry_point: show
  steps:
    - show

show:
  RESPOND: "User: {{user.name}}, Tier: {{user.tier}}"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Template_Nested_Test'),
      );
      session.data.values.user = { name: 'Bob', tier: 'gold' };

      const chunks: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks.push(c));

      expect(chunks.join('')).toContain('User: Bob, Tier: gold');
    });

    test('{{#if variable}} conditional block', async () => {
      const dsl = `
AGENT: Template_If_Test

GOAL: "Test if blocks"

FLOW:
  entry_point: show
  steps:
    - show

show:
  RESPOND: "Result: {{#if premium}}Premium member!{{/if}}{{#if basic}}Basic member.{{/if}}"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Template_If_Test'),
      );
      session.data.values.premium = true;
      session.data.values.basic = false;

      const chunks: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks.push(c));

      const output = chunks.join('');
      expect(output).toContain('Premium member!');
      expect(output).not.toContain('Basic member.');
    });

    test('{{#if}} with falsy value hides block', async () => {
      const dsl = `
AGENT: Template_If_Falsy_Test

GOAL: "Test if falsy"

FLOW:
  entry_point: show
  steps:
    - show

show:
  RESPOND: "Before{{#if hidden}}HIDDEN CONTENT{{/if}}After"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Template_If_Falsy_Test'),
      );
      // hidden is not set → falsy

      const chunks: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks.push(c));

      const output = chunks.join('');
      expect(output).toContain('BeforeAfter');
      expect(output).not.toContain('HIDDEN CONTENT');
    });

    test('{{#each array}} iterates over items', async () => {
      const dsl = `
AGENT: Template_Each_Test

GOAL: "Test each blocks"

FLOW:
  entry_point: show
  steps:
    - show

show:
  RESPOND: |
    Hotels:
    {{#each hotels}}{{add @index 1}}. {{name}} - \${{price}}/night
    {{/each}}
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Template_Each_Test'),
      );
      session.data.values.hotels = [
        { name: 'Grand Hotel', price: 200 },
        { name: 'Budget Inn', price: 80 },
        { name: 'Beach Resort', price: 350 },
      ];

      const chunks: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks.push(c));

      const output = chunks.join('');
      expect(output).toContain('1. Grand Hotel - $200/night');
      expect(output).toContain('2. Budget Inn - $80/night');
      expect(output).toContain('3. Beach Resort - $350/night');
    });

    test('{{@index}} in each loop gives zero-based index', async () => {
      const dsl = `
AGENT: Template_Index_Test

GOAL: "Test index"

FLOW:
  entry_point: show
  steps:
    - show

show:
  RESPOND: "{{#each items}}[{{@index}}]={{name}} {{/each}}"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Template_Index_Test'),
      );
      session.data.values.items = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];

      const chunks: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks.push(c));

      const output = chunks.join('');
      expect(output).toContain('[0]=A');
      expect(output).toContain('[1]=B');
      expect(output).toContain('[2]=C');
    });

    test('Undefined variable keeps {{variable}} placeholder', async () => {
      const dsl = `
AGENT: Template_Missing_Test

GOAL: "Test missing variable"

FLOW:
  entry_point: show
  steps:
    - show

show:
  RESPOND: "Name: {{name}}, Unknown: {{missing_var}}"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Template_Missing_Test'),
      );
      session.data.values.name = 'Alice';

      const chunks: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks.push(c));

      const output = chunks.join('');
      expect(output).toContain('Name: Alice');
      expect(output).toContain('{{missing_var}}');
    });
  });

  // ===========================================================================
  // resolveSetValue (via ON_INPUT SET)
  // ===========================================================================

  describe('resolveSetValue via ON_INPUT SET', () => {
    test('SET with double-quoted string strips quotes', async () => {
      const dsl = `
AGENT: Set_Quoted_Test

GOAL: "Test SET quote stripping"

FLOW:
  entry_point: step1
  steps:
    - step1

step1:
  GATHER:
    - input: required
  ON_INPUT:
    - IF: input contains "book"
      SET: intent = "booking"
      THEN: COMPLETE
    - ELSE:
      THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Set_Quoted_Test'),
      );
      await executor.initializeSession(session.id);
      await executor.executeMessage(session.id, 'I want to book');

      // resolveSetValue should strip quotes
      expect(session.data.values.intent).toBe('booking');
    });

    test('SET with boolean literal parses to boolean', async () => {
      const dsl = `
AGENT: Set_Bool_Test

GOAL: "Test SET boolean"

FLOW:
  entry_point: step1
  steps:
    - step1

step1:
  GATHER:
    - input: required
  ON_INPUT:
    - IF: input contains "yes"
      SET: confirmed = true
      THEN: COMPLETE
    - ELSE:
      SET: confirmed = false
      THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Set_Bool_Test'),
      );
      await executor.initializeSession(session.id);
      await executor.executeMessage(session.id, 'yes please');

      expect(session.data.values.confirmed).toBe(true);
    });

    test('SET with numeric literal parses to number', async () => {
      const dsl = `
AGENT: Set_Number_Test

GOAL: "Test SET number"

FLOW:
  entry_point: step1
  steps:
    - step1

step1:
  GATHER:
    - input: required
  ON_INPUT:
    - IF: input contains "premium"
      SET: tier_level = 3
      THEN: COMPLETE
    - ELSE:
      SET: tier_level = 1
      THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Set_Number_Test'),
      );
      await executor.initializeSession(session.id);
      await executor.executeMessage(session.id, 'premium access');

      expect(session.data.values.tier_level).toBe(3);
    });

    test('SET values work correctly in subsequent condition evaluation', async () => {
      const dsl = `
AGENT: Set_Condition_Test

GOAL: "Test SET then condition"

FLOW:
  entry_point: detect
  steps:
    - detect

detect:
  GATHER:
    - input: required
  ON_INPUT:
    - IF: input contains "book"
      SET: detected_intent = "new_booking"
      THEN: COMPLETE
    - ELSE:
      SET: detected_intent = "general"
      THEN: COMPLETE

HANDOFF:
  - TO: Booking_Agent
    WHEN: detected_intent == "new_booking"
    CONTEXT:
      pass: [detected_intent]
      summary: "Booking request"
    RETURN: false
`;
      // Register target agent
      const bookingDsl = `
AGENT: Booking_Agent

GOAL: "Handle bookings"
FLOW:
  entry_point: start
  steps:
    - start
start:
  RESPOND: "I'll handle your booking!"
  THEN: COMPLETE
`;
      executor.registerAgent('Booking_Agent', bookingDsl);
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Set_Condition_Test'),
      );
      await executor.initializeSession(session.id);

      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'I want to book a hotel', (c) => chunks.push(c));

      // The SET value "new_booking" (without quotes) should match the HANDOFF condition
      // Handoff message is suppressed for non-voice channels; verify the child agent responded
      expect(chunks.join('')).toContain("I'll handle your booking!");
    });
  });

  // ===========================================================================
  // ON_START SET value types
  // ===========================================================================

  describe('ON_START SET value parsing', () => {
    test('ON_START SET parses booleans and numbers', async () => {
      const dsl = `
AGENT: OnStart_Types_Test

GOAL: "Test ON_START value types"

ON_START:
  set: is_active = true
  set: is_admin = false
  set: max_items = 10
  set: label = hello

FLOW:
  entry_point: show
  steps:
    - show

show:
  RESPOND: "Done"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'OnStart_Types_Test'),
      );
      await executor.initializeSession(session.id);

      expect(session.data.values.is_active).toBe(true);
      expect(session.data.values.is_admin).toBe(false);
      expect(session.data.values.max_items).toBe(10);
      expect(session.data.values.label).toBe('hello');
    });
  });

  // ===========================================================================
  // STEP-ENTRY SET + numeric normalization
  // ===========================================================================

  describe('step-entry execution semantics', () => {
    test('step-level SET executes on step entry and supports computed expressions', async () => {
      const dsl = `
AGENT: Step_Set_Test

GOAL: "Test step entry SET execution"

FLOW:
  entry_point: increment
  steps:
    - increment
    - show

increment:
  SET: total = base + tax
  THEN: show

show:
  RESPOND: "Total {{total}}"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Step_Set_Test'),
      );
      session.data.values.base = 100;
      session.data.values.tax = 25;

      const chunks: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks.push(c));

      expect(session.data.values.total).toBe(125);
      expect(chunks.join('')).toContain('Total 125');
    });

    test('ABLP-376: step-entry SET runs once per transition while a gather step stays active', async () => {
      const dsl = `
AGENT: Step_Set_Transition_Guard_Test

GOAL: "Run step-entry SET only once per step transition"

FLOW:
  entry_point: initialize
  steps:
    - initialize
    - collect_profile
    - done

initialize:
  REASONING: false
  SET: entry_count = 0
  THEN: collect_profile

collect_profile:
  REASONING: false
  SET: entry_count = entry_count + 1
  GATHER:
    - age:
        type: number
        required: true
        prompt: "What is your age?"
    - email:
        type: email
        required: true
        prompt: "What is your email?"
  RESPOND: "Collected age {{age}} email {{email}} (entry_count={{entry_count}})"
  THEN: done

done:
  REASONING: false
  RESPOND: "Done with entry_count={{entry_count}}"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Step_Set_Transition_Guard_Test'),
      );
      const traces: CapturedTrace[] = [];
      const onTraceEvent = (event: CapturedTrace) => traces.push(event);

      await executor.initializeSession(session.id, undefined, onTraceEvent);

      expect(session.currentFlowStep).toBe('collect_profile');
      expect(session.data.values.entry_count).toBe(1);

      const firstChunks: string[] = [];
      await executor.executeMessage(
        session.id,
        '42',
        (chunk) => firstChunks.push(chunk),
        onTraceEvent,
      );

      expect(session.currentFlowStep).toBe('collect_profile');
      expect(session.data.values.entry_count).toBe(1);
      expect(session.data.values.age).toBe(42);
      expect(firstChunks.join('')).toContain('What is your email?');

      const secondChunks: string[] = [];
      await executor.executeMessage(
        session.id,
        'ada@example.com',
        (chunk) => secondChunks.push(chunk),
        onTraceEvent,
      );

      expect(session.data.values.entry_count).toBe(1);
      expect(session.data.values.email).toBe('ada@example.com');
      expect(secondChunks.join('')).toContain(
        'Collected age 42 email ada@example.com (entry_count=1)',
      );
      expect(secondChunks.join('')).toContain('Done with entry_count=1');

      const collectProfileEntrySets = traces.filter((event) => {
        if (event.type !== 'dsl_set') {
          return false;
        }

        const { data } = event;
        return (
          data.source === 'step_enter' &&
          data.stepName === 'collect_profile' &&
          data.assignments !== null &&
          typeof data.assignments === 'object' &&
          Object.prototype.hasOwnProperty.call(data.assignments, 'entry_count')
        );
      });

      expect(collectProfileEntrySets).toHaveLength(1);
    });

    test('ABLP-376: arithmetic SET increments numerically and lockout triggers at the threshold', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([ABLP_376_PIN_FLOW], 'ABLP_376_Pin_Flow'),
      );

      const initChunks: string[] = [];
      await executor.initializeSession(session.id, (c) => initChunks.push(c));

      const firstChunks: string[] = [];
      await executor.executeMessage(session.id, '9999', (c) => firstChunks.push(c));

      const secondChunks: string[] = [];
      await executor.executeMessage(session.id, '9999', (c) => secondChunks.push(c));

      expect(initChunks.join('')).toContain(
        "Let's verify your PIN. status=verifying, attempts=0, authenticated=false",
      );
      expect(firstChunks.join('')).toContain('PIN mismatch. Attempts=1. Try again.');
      expect(firstChunks.join('')).not.toContain('auth_attempts + 1');
      expect(secondChunks.join('')).toContain('Account locked after 2 attempts. status=locked');
      expect(typeof session.data.values.auth_attempts).toBe('number');
      expect(session.data.values.auth_attempts).toBe(2);
      expect(session.data.values.status_note).toBe('locked');
    });

    test('ABLP-376: step-entry SET clears stale values when the confirmation step is re-entered', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([ABLP_376_PIN_FLOW], 'ABLP_376_Pin_Flow'),
      );
      const traces: CapturedTrace[] = [];
      const onTraceEvent = (event: CapturedTrace) => traces.push(event);

      await executor.initializeSession(session.id, undefined, onTraceEvent);

      const firstChunks: string[] = [];
      await executor.executeMessage(session.id, '1234', (c) => firstChunks.push(c), onTraceEvent);

      const secondChunks: string[] = [];
      await executor.executeMessage(session.id, '1111', (c) => secondChunks.push(c), onTraceEvent);

      expect(firstChunks.join('')).toContain('PIN accepted.');
      expect(firstChunks.join('')).toContain('Re-enter PIN to confirm.');
      expect(secondChunks.join('')).toContain("Mismatch. Let's try confirmation again.");
      expect(secondChunks.join('')).toContain('Re-enter PIN to confirm.');
      expect(session.data.values.pin).toBe('1234');
      expect(session.data.values.confirm_pin).toBe('');
      expect(session.currentFlowStep).toBe('ask_confirm');

      const askConfirmSetTraces = traces.filter((event) => {
        if (event.type !== 'dsl_set') {
          return false;
        }

        const { data } = event;
        const assignments = data.assignments;
        return (
          data.source === 'step_enter' &&
          data.stepName === 'ask_confirm' &&
          assignments !== null &&
          typeof assignments === 'object' &&
          Object.prototype.hasOwnProperty.call(assignments, 'confirm_pin')
        );
      });

      expect(askConfirmSetTraces).toHaveLength(2);
    });

    test('spoken number normalization feeds phone extraction for numeric-like gather fields', async () => {
      const dsl = `
AGENT: Spoken_Number_Phone_Test

GOAL: "Capture a phone number"

FLOW:
  entry_point: collect_phone
  steps:
    - collect_phone

collect_phone:
  GATHER:
    - phone:
        type: phone
        required: true
        prompt: "What is your phone number?"
  RESPOND: "Captured {{phone}}"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Spoken_Number_Phone_Test'),
      );
      await executor.initializeSession(session.id);

      const chunks: string[] = [];
      // libphonenumber-js requires 10 digits for a US number to be
      // `isPossible()`, so the spoken input covers the full area-code +
      // subscriber sequence. Regression note: 7-digit inputs fall through
      // extractPhoneFromText since libphonenumber rejects them.
      await executor.executeMessage(
        session.id,
        'my number is five five five one two three four five six seven',
        (c) => chunks.push(c),
      );

      expect(session.data.values.phone).toBe('+15551234567');
      expect(chunks.join('')).toContain('Captured +15551234567');
    });
  });
});
