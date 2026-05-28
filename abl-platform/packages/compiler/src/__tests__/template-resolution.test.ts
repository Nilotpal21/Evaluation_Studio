/**
 * Template Resolution Tests
 *
 * Tests compile-time inlining of TEMPLATE(name) references into respond fields.
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '../platform/ir/compiler.js';

/** Helper: parse + compile a single DSL string, return the first agent IR */
function compileOne(dsl: string) {
  const parsed = parseAgentBasedABL(dsl);
  if (parsed.errors.length > 0) {
    throw new Error(`Parse errors: ${JSON.stringify(parsed.errors)}`);
  }
  const output = compileABLtoIR([parsed.document!]);
  // If compilation errors exist, throw with the error details
  if (output.compilation_errors && output.compilation_errors.length > 0) {
    throw new Error(output.compilation_errors.map((e) => e.message).join('\n'));
  }
  const agents = Object.values(output.agents);
  if (agents.length === 0) throw new Error('No agents compiled');
  return agents[0];
}

describe('Template Resolution', () => {
  test('TEMPLATE(name) in flow step RESPOND resolves to content', () => {
    const ir = compileOne(`
AGENT: Test_Agent

GOAL: "Help users"

TEMPLATES:
  greeting: "Hello, welcome to our service!"

FLOW:
  steps: welcome
  welcome:
    REASONING: false
    RESPOND: TEMPLATE(greeting)
`);
    expect(ir.flow?.definitions['welcome']?.respond).toBe('Hello, welcome to our service!');
  });

  test('TEMPLATE(name) carries VOICE INSTRUCTIONS into flow step voice_config', () => {
    const ir = compileOne(`
AGENT: Test_Agent

GOAL: "Help users"

TEMPLATES:
  greeting:
    DEFAULT: "Hello, welcome to our service!"
    VOICE INSTRUCTIONS: "Speak warmly with a short pause after hello."

FLOW:
  steps: welcome
  welcome:
    REASONING: false
    RESPOND: TEMPLATE(greeting)
`);
    expect(ir.flow?.definitions['welcome']?.respond).toBe('Hello, welcome to our service!');
    expect(ir.flow?.definitions['welcome']?.voice_config?.instructions).toBe(
      'Speak warmly with a short pause after hello.',
    );
  });

  test('TEMPLATE(name) does not override explicit response VOICE block', () => {
    const ir = compileOne(`
AGENT: Test_Agent

GOAL: "Help users"

TEMPLATES:
  greeting:
    DEFAULT: "Hello, welcome to our service!"
    VOICE INSTRUCTIONS: "Speak warmly."

FLOW:
  steps: welcome
  welcome:
    REASONING: false
    RESPOND: TEMPLATE(greeting)
      VOICE:
        INSTRUCTIONS: "Use a neutral tone."
`);
    expect(ir.flow?.definitions['welcome']?.respond).toBe('Hello, welcome to our service!');
    expect(ir.flow?.definitions['welcome']?.voice_config?.instructions).toBe('Use a neutral tone.');
  });

  test('TEMPLATE(name) carries nested template VOICE block into ON_START', () => {
    const ir = compileOne(`
AGENT: Test_Agent

GOAL: "Help users"

TEMPLATES:
  greeting:
    DEFAULT: "Hello, welcome to our service!"
    VOICE:
      INSTRUCTIONS: "Speak warmly."
      PLAIN_TEXT: "Hello and welcome."

ON_START:
  RESPOND: TEMPLATE(greeting)
`);
    expect(ir.on_start?.respond).toBe('Hello, welcome to our service!');
    expect(ir.on_start?.voice_config).toEqual({
      instructions: 'Speak warmly.',
      plain_text: 'Hello and welcome.',
    });
  });

  test('TEMPLATE(name) in COMPLETE respond resolves', () => {
    const ir = compileOne(`
AGENT: Test_Agent

GOAL: "Help users"

TEMPLATES:
  done_msg: "Your request is complete. Thank you!"

COMPLETE:
  - WHEN: task_done == true
    RESPOND: TEMPLATE(done_msg)
`);
    expect(ir.completion.conditions[0].respond).toBe('Your request is complete. Thank you!');
  });

  test('TEMPLATE(name) in ON_INPUT branch resolves', () => {
    const ir = compileOne(`
AGENT: Test_Agent

GOAL: "Help users"

TEMPLATES:
  yes_response: "Great, proceeding!"

FLOW:
  steps: ask
  ask:
    REASONING: false
    COLLECT: answer
    PROMPT: "Do you want to proceed?"
    ON_INPUT:
      - IF: answer == "yes"
        RESPOND: TEMPLATE(yes_response)
        THEN: ask
      - ELSE:
        RESPOND: "Okay, never mind."
        THEN: ask
`);
    expect(ir.flow?.definitions['ask']?.on_input?.[0]?.respond).toBe('Great, proceeding!');
    expect(ir.flow?.definitions['ask']?.on_input?.[1]?.respond).toBe('Okay, never mind.');
  });

  test('TEMPLATE(name) in ON_SUCCESS branch resolves', () => {
    const ir = compileOne(`
AGENT: Test_Agent

GOAL: "Help users"

TEMPLATES:
  success_msg: "Operation succeeded!"

TOOLS:
  do_thing() -> {status: string}
    description: "Do a thing"

FLOW:
  steps: action
  action:
    REASONING: false
    CALL: do_thing()
    ON_SUCCESS:
      REASONING: false
      RESPOND: TEMPLATE(success_msg)
      THEN: action
    ON_FAIL:
      RESPOND: "It failed."
      THEN: action
`);
    expect(ir.flow?.definitions['action']?.on_success?.respond).toBe('Operation succeeded!');
    expect(ir.flow?.definitions['action']?.on_failure?.respond).toBe('It failed.');
  });

  test('TEMPLATE(name) in MESSAGES resolves', () => {
    const ir = compileOne(`
AGENT: Test_Agent

GOAL: "Help users"

TEMPLATES:
  custom_error: "Oops, something went wrong. Please try again."

MESSAGES:
  error_default: TEMPLATE(custom_error)
`);
    expect(ir.messages?.error_default).toBe('Oops, something went wrong. Please try again.');
  });

  test('TEMPLATE(name) in ON_START resolves', () => {
    const ir = compileOne(`
AGENT: Test_Agent

GOAL: "Help users"

TEMPLATES:
  welcome: "Welcome! How can I help you today?"

ON_START:
  RESPOND: TEMPLATE(welcome)
`);
    expect(ir.on_start?.respond).toBe('Welcome! How can I help you today?');
  });

  test('TEMPLATE(name) in step-level digression resolves', () => {
    const ir = compileOne(`
AGENT: Test_Agent

GOAL: "Help users"

TEMPLATES:
  help_msg: "I can help with booking, cancellation, and inquiries."

FLOW:
  steps: main
  main:
    REASONING: false
    RESPOND: "What would you like to do?"
    DIGRESSIONS:
      - INTENT: help
        RESPOND: TEMPLATE(help_msg)
        RESUME: true
`);
    expect(ir.flow?.definitions['main']?.digressions?.[0]?.respond).toBe(
      'I can help with booking, cancellation, and inquiries.',
    );
  });

  test('undefined template reference produces compile error', () => {
    expect(() =>
      compileOne(`
AGENT: Test_Agent

GOAL: "Help users"

TEMPLATES:
  greeting: "Hello!"

FLOW:
  steps: welcome
  welcome:
    REASONING: false
    RESPOND: TEMPLATE(nonexistent)
`),
    ).toThrow(/E601.*nonexistent/);
  });

  test('unused template produces warning (does not throw)', () => {
    // Unused templates should not prevent compilation
    const ir = compileOne(`
AGENT: Test_Agent

GOAL: "Help users"

TEMPLATES:
  greeting: "Hello!"
  unused_tmpl: "This is never referenced"

FLOW:
  steps: welcome
  welcome:
    REASONING: false
    RESPOND: TEMPLATE(greeting)
`);
    expect(ir.flow?.definitions['welcome']?.respond).toBe('Hello!');
    // ir.templates should contain both
    expect(ir.templates).toHaveProperty('greeting');
    expect(ir.templates).toHaveProperty('unused_tmpl');
  });

  test('duplicate template name: last definition wins', () => {
    const ir = compileOne(`
AGENT: Test_Agent

GOAL: "Help users"

TEMPLATES:
  greeting: "First version"
  greeting: "Second version"

FLOW:
  steps: welcome
  welcome:
    REASONING: false
    RESPOND: TEMPLATE(greeting)
`);
    expect(ir.flow?.definitions['welcome']?.respond).toBe('Second version');
  });

  test('no templates: ir.templates is undefined', () => {
    const ir = compileOne(`
AGENT: Test_Agent

GOAL: "Help users"
`);
    expect(ir.templates).toBeUndefined();
  });

  test('RESPOND without TEMPLATE() passes through unchanged', () => {
    const ir = compileOne(`
AGENT: Test_Agent

GOAL: "Help users"

TEMPLATES:
  greeting: "Hello!"

FLOW:
  steps: welcome
  welcome:
    REASONING: false
    RESPOND: "Just a plain string"
`);
    expect(ir.flow?.definitions['welcome']?.respond).toBe('Just a plain string');
  });

  test('multi-line template content is preserved', () => {
    const ir = compileOne(`
AGENT: Test_Agent

GOAL: "Help users"

TEMPLATES:
  multi: |
    Line one.
    Line two.
    Line three.

FLOW:
  steps: welcome
  welcome:
    REASONING: false
    RESPOND: TEMPLATE(multi)
`);
    const content = ir.flow?.definitions['welcome']?.respond;
    expect(content).toContain('Line one.');
    expect(content).toContain('Line two.');
    expect(content).toContain('Line three.');
  });

  // =========================================================================
  // REASONING AGENT TESTS
  // =========================================================================

  test('reasoning agent: TEMPLATE in error handler respond', () => {
    const ir = compileOne(`
AGENT: Support_Bot

GOAL: "Help users with support requests"

TEMPLATES:
  timeout_msg: "Sorry, that took too long. Please try again."
  generic_err: "Something went wrong. Let me try a different approach."

ON_ERROR:
  tool_timeout:
    RESPOND: TEMPLATE(timeout_msg)
    RETRY: 1
  tool_error:
    RESPOND: TEMPLATE(generic_err)
`);
    expect(ir.error_handling.handlers[0].respond).toBe(
      'Sorry, that took too long. Please try again.',
    );
    expect(ir.error_handling.handlers[1].respond).toBe(
      'Something went wrong. Let me try a different approach.',
    );
  });

  test('reasoning agent: TEMPLATE in hooks respond', () => {
    const ir = compileOne(`
AGENT: Support_Bot

GOAL: "Help users"

TEMPLATES:
  turn_start: "Let me look into that for you..."
  turn_end: "Is there anything else you need?"

HOOKS:
  before_turn:
    RESPOND: TEMPLATE(turn_start)
  after_turn:
    RESPOND: TEMPLATE(turn_end)
`);
    expect(ir.hooks?.before_turn?.respond).toBe('Let me look into that for you...');
    expect(ir.hooks?.after_turn?.respond).toBe('Is there anything else you need?');
  });

  test('reasoning agent: TEMPLATE in COMPLETE + ON_START + MESSAGES combined', () => {
    const ir = compileOne(`
AGENT: Full_Agent

GOAL: "Comprehensive agent"
PERSONA: "Helpful assistant"

TEMPLATES:
  welcome: "Hello! I'm your personal assistant."
  goodbye: "Thanks for chatting! Have a great day."
  err_msg: "Oops, I encountered an issue."

ON_START:
  RESPOND: TEMPLATE(welcome)

COMPLETE:
  - WHEN: user_says_goodbye == true
    RESPOND: TEMPLATE(goodbye)

MESSAGES:
  error_default: TEMPLATE(err_msg)
`);
    expect(ir.on_start?.respond).toBe("Hello! I'm your personal assistant.");
    expect(ir.completion.conditions[0].respond).toBe('Thanks for chatting! Have a great day.');
    expect(ir.messages?.error_default).toBe('Oops, I encountered an issue.');
    // All 3 templates should be stored in the IR
    expect(Object.keys(ir.templates!)).toHaveLength(3);
  });

  test('reasoning agent: MESSAGES.error_default seeds the default error handler respond', () => {
    const ir = compileOne(`
AGENT: Localized_Error_Agent

GOAL: "Validate default error localization wiring"

TEMPLATES:
  err_msg: "Mensaje predeterminado del agente."

MESSAGES:
  error_default: TEMPLATE(err_msg)
`);

    expect(ir.messages?.error_default).toBe('Mensaje predeterminado del agente.');
    expect(ir.error_handling.default_handler.respond).toBe('Mensaje predeterminado del agente.');
  });

  test('reasoning agent: TEMPLATE with {{}} interpolation vars preserved in content', () => {
    const ir = compileOne(`
AGENT: Greeter

GOAL: "Greet users"

TEMPLATES:
  personal_greeting: |
    Hello {{user.name}}!
    Your account status is {{account.status}}.
    {{#if user.is_premium}}You have premium access.{{/if}}

ON_START:
  RESPOND: TEMPLATE(personal_greeting)
`);
    const content = ir.on_start?.respond;
    expect(content).toContain('{{user.name}}');
    expect(content).toContain('{{account.status}}');
    expect(content).toContain('{{#if user.is_premium}}');
  });

  // =========================================================================
  // SCRIPTED + REASONING EDGE CASES
  // =========================================================================

  test('scripted: TEMPLATE in ON_RESULT branches resolves', () => {
    const ir = compileOne(`
AGENT: Lookup_Agent

GOAL: "Look up information"

TEMPLATES:
  found_msg: "Found the result!"
  not_found_msg: "Nothing found. Try again."

TOOLS:
  search(query: string) -> {results: string[]}
    description: "Search for information"

FLOW:
  steps: do_search
  do_search:
    REASONING: false
    CALL: search(query)
      AS: search_result
    ON_RESULT:
      REASONING: false
      - IF: search_result.results.length > 0
        RESPOND: TEMPLATE(found_msg)
        THEN: do_search
      - ELSE:
        RESPOND: TEMPLATE(not_found_msg)
        THEN: do_search
`);
    expect(ir.flow?.definitions['do_search']?.on_result?.[0]?.respond).toBe('Found the result!');
    expect(ir.flow?.definitions['do_search']?.on_result?.[1]?.respond).toBe(
      'Nothing found. Try again.',
    );
  });

  test('scripted: TEMPLATE in sub_intent resolves', () => {
    const ir = compileOne(`
AGENT: Booking_Agent

GOAL: "Book hotels"

TEMPLATES:
  change_dest: "Sure, where would you like to go instead?"

FLOW:
  steps: collect_info
  collect_info:
    REASONING: false
    COLLECT: destination
    PROMPT: "Where would you like to stay?"
    SUB_INTENTS:
      - INTENT: change_destination
        RESPOND: TEMPLATE(change_dest)
        CLEAR: [destination]
`);
    expect(ir.flow?.definitions['collect_info']?.sub_intents?.[0]?.respond).toBe(
      'Sure, where would you like to go instead?',
    );
  });

  test('scripted: TEMPLATE in ON_ERROR default_handler populates template rich_content', () => {
    const ir = compileOne(`
AGENT: Default_Error_Template_Agent

GOAL: "Handle errors"

TEMPLATES:
  fallback:
    DEFAULT: "Something went wrong."
    MARKDOWN: "**Something went wrong.**"

ON_ERROR:
  DEFAULT:
    RESPOND: TEMPLATE(fallback)
    THEN: CONTINUE
`);

    expect(ir.error_handling?.default_handler.respond).toBe('Something went wrong.');
    expect(ir.error_handling?.default_handler.rich_content?.markdown).toBe(
      '**Something went wrong.**',
    );
  });

  test('scripted: TEMPLATE in sub_intent populates template rich_content', () => {
    const ir = compileOne(`
AGENT: Sub_Intent_Template_Agent

GOAL: "Handle booking changes"

TEMPLATES:
  change_dest:
    DEFAULT: "Sure, where would you like to go instead?"
    MARKDOWN: "**Where should we search next?**"

FLOW:
  steps: collect_info
  collect_info:
    REASONING: false
    COLLECT: destination
    PROMPT: "Where would you like to stay?"
    SUB_INTENTS:
      - INTENT: change_destination
        RESPOND: TEMPLATE(change_dest)
        CLEAR: [destination]
`);

    expect(ir.flow?.definitions['collect_info']?.sub_intents?.[0]?.respond).toBe(
      'Sure, where would you like to go instead?',
    );
    expect(ir.flow?.definitions['collect_info']?.sub_intents?.[0]?.rich_content?.markdown).toBe(
      '**Where should we search next?**',
    );
  });

  test('scripted: TEMPLATE in ON_SUCCESS conditional branches resolves', () => {
    const ir = compileOne(`
AGENT: Payment_Agent

GOAL: "Process payments"

TEMPLATES:
  pay_ok: "Payment processed successfully!"
  pay_partial: "Partial payment applied."

TOOLS:
  process_payment(amount: number) -> {status: string}
    description: "Process a payment"

FLOW:
  steps: pay
  pay:
    REASONING: false
    CALL: process_payment(amount)
      AS: pay_result
    ON_SUCCESS:
      REASONING: false
      - IF: pay_result.status == "full"
        RESPOND: TEMPLATE(pay_ok)
        THEN: pay
      - IF: pay_result.status == "partial"
        RESPOND: TEMPLATE(pay_partial)
        THEN: pay
    ON_FAIL:
      RESPOND: "Payment failed."
      THEN: pay
`);
    expect(ir.flow?.definitions['pay']?.on_success?.branches?.[0]?.respond).toBe(
      'Payment processed successfully!',
    );
    expect(ir.flow?.definitions['pay']?.on_success?.branches?.[1]?.respond).toBe(
      'Partial payment applied.',
    );
  });

  test('standalone TEMPLATE syntax compiles correctly', () => {
    const ir = compileOne(`
AGENT: Test_Agent

GOAL: "Help users"

TEMPLATE greeting: "Hello from standalone!"

FLOW:
  steps: welcome
  welcome:
    REASONING: false
    RESPOND: TEMPLATE(greeting)
`);
    expect(ir.flow?.definitions['welcome']?.respond).toBe('Hello from standalone!');
    expect(ir.templates).toHaveProperty('greeting', 'Hello from standalone!');
  });

  // =========================================================================
  // GATHER field prompts
  // =========================================================================

  test('TEMPLATE(name) in top-level GATHER field prompt resolves', () => {
    const ir = compileOne(`
AGENT: Test_Agent

GOAL: "Help users"

TEMPLATES:
  budget_q: "What is your maximum monthly budget?"

GATHER:
  budget:
    type: number
    prompt: TEMPLATE(budget_q)
`);
    expect(ir.gather?.fields[0]?.prompt).toBe('What is your maximum monthly budget?');
  });

  test('TEMPLATE with formats populates rich_content on GATHER field', () => {
    const ir = compileOne(`
AGENT: Test_Agent

GOAL: "Help users"

TEMPLATES:
  budget_q:
    DEFAULT: "What is your budget?"
    MARKDOWN: "**What is your budget?**"

GATHER:
  budget:
    type: number
    prompt: TEMPLATE(budget_q)
`);
    expect(ir.gather?.fields[0]?.prompt).toBe('What is your budget?');
    expect(ir.gather?.fields[0]?.rich_content?.markdown).toBe('**What is your budget?**');
  });

  test('undefined TEMPLATE in GATHER produces E601 error', () => {
    expect(() =>
      compileOne(`
AGENT: Test_Agent

GOAL: "Help users"

TEMPLATES:
  other: "Some other template"

GATHER:
  budget:
    type: number
    prompt: TEMPLATE(nonexistent)
`),
    ).toThrow(/E601.*nonexistent/);
  });

  test('GATHER usage marks template as used (no W602 warning)', () => {
    const parsed = parseAgentBasedABL(`
AGENT: Test_Agent

GOAL: "Help users"

TEMPLATES:
  ask_name: "What is your name?"

GATHER:
  name:
    type: string
    prompt: TEMPLATE(ask_name)
`);
    const output = compileABLtoIR([parsed.document!]);
    // No compilation errors
    expect(output.compilation_errors ?? []).toHaveLength(0);
    // Template should be resolved
    const agents = Object.values(output.agents);
    expect(agents[0].gather?.fields[0]?.prompt).toBe('What is your name?');
  });

  test('TEMPLATE(name) in FLOW step GATHER field prompt resolves', () => {
    const ir = compileOne(`
AGENT: Test_Agent

GOAL: "Help users"

TEMPLATES:
  name_q: "What is your full name?"

FLOW:
  steps: collect_info
  collect_info:
    REASONING: false
    GATHER:
      - name
        TYPE: string
        PROMPT: TEMPLATE(name_q)
    RESPOND: "Thanks!"
`);
    expect(ir.flow?.definitions['collect_info']?.gather?.fields[0]?.prompt).toBe(
      'What is your full name?',
    );
  });

  // =========================================================================
  // ON_ACTION handler responds
  // =========================================================================

  test('TEMPLATE(name) in ON_ACTION handler respond resolves', () => {
    const ir = compileOne(`
AGENT: Test_Agent

GOAL: "Help users"

TEMPLATES:
  confirmed: "Your selection has been confirmed!"

FLOW:
  interact:
    REASONING: false
    RESPOND: "Please confirm your choice."
      ACTIONS:
        - BUTTON: "Confirm" -> btn_confirm
    ON_ACTION:
      btn_confirm:
        RESPOND: TEMPLATE(confirmed)
  done:
    REASONING: false
    RESPOND: "Done"
`);
    expect(ir.flow?.definitions['interact']?.on_action?.[0]?.respond).toBe(
      'Your selection has been confirmed!',
    );
  });

  test('TEMPLATE(name) in ON_ACTION DO respond resolves and populates rich_content', () => {
    const parsed = parseAgentBasedABL(`
AGENT: Test_Agent

GOAL: "Help users"

TEMPLATES:
  confirmed:
    DEFAULT: "Your selection has been confirmed!"
    MARKDOWN: "**Your selection has been confirmed!**"

FLOW:
  interact:
    REASONING: false
    RESPOND: "Please confirm your choice."
      ACTIONS:
        - BUTTON: "Confirm" -> btn_confirm
    ON_ACTION:
      btn_confirm:
        DO:
          - RESPOND: TEMPLATE(confirmed)
          - GOTO: done
  done:
    REASONING: false
    RESPOND: "Done"
`);
    expect(parsed.errors).toHaveLength(0);

    const output = compileABLtoIR([parsed.document!]);
    expect(output.compilation_errors ?? []).toHaveLength(0);
    expect(
      (output.compilation_warnings ?? []).some(
        (warning) => warning.message.includes('W602') && warning.message.includes('"confirmed"'),
      ),
    ).toBe(false);

    const agent = Object.values(output.agents)[0];
    const handler = agent.flow?.definitions['interact']?.on_action?.[0];
    const action = agent.flow?.definitions['interact']?.on_action?.[0]?.do?.[0];
    expect(action?.respond).toBe('Your selection has been confirmed!');
    expect(action?.rich_content?.markdown).toBe('**Your selection has been confirmed!**');
    expect(handler?.respond).toBe('Your selection has been confirmed!');
    expect(handler?.rich_content?.markdown).toBe('**Your selection has been confirmed!**');
  });

  test('TEMPLATE(name) in ACTION_HANDLERS DO respond resolves and marks template used', () => {
    const parsed = parseAgentBasedABL(`
AGENT: Test_Agent

GOAL: "Help users"

TEMPLATES:
  confirmed:
    DEFAULT: "Global confirmation"
    MARKDOWN: "**Global confirmation**"

ACTION_HANDLERS:
  btn_confirm:
    DO:
      - RESPOND: TEMPLATE(confirmed)
      - COMPLETE
`);
    expect(parsed.errors).toHaveLength(0);

    const output = compileABLtoIR([parsed.document!]);
    expect(output.compilation_errors ?? []).toHaveLength(0);
    expect(
      (output.compilation_warnings ?? []).some(
        (warning) => warning.message.includes('W602') && warning.message.includes('"confirmed"'),
      ),
    ).toBe(false);

    const agent = Object.values(output.agents)[0];
    const handler = agent.action_handlers?.[0];
    const action = agent.action_handlers?.[0]?.do?.[0];
    expect(action?.respond).toBe('Global confirmation');
    expect(action?.rich_content?.markdown).toBe('**Global confirmation**');
    expect(handler?.respond).toBe('Global confirmation');
    expect(handler?.rich_content?.markdown).toBe('**Global confirmation**');
  });
});
