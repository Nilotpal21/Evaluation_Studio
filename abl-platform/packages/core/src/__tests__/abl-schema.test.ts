import { describe, test, expect, beforeAll } from 'vitest';
import Ajv from 'ajv';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const schemaPath = resolve(__dirname, '../schema/abl-schema.json');
const ablSchema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
const ajv = new Ajv({ allErrors: true });
let validate: ReturnType<typeof ajv.compile>;

beforeAll(() => {
  validate = ajv.compile(ablSchema);
});

describe('ABL YAML JSON Schema', () => {
  // =========================================================================
  // MINIMAL VALID AGENTS
  // =========================================================================

  test('validates a minimal reasoning agent', () => {
    const result = validate({ agent: 'TestAgent', mode: 'reasoning', goal: 'Help users' });
    expect(result).toBe(true);
  });

  test('validates a minimal scripted agent', () => {
    const result = validate({ agent: 'FlowAgent', mode: 'scripted' });
    expect(result).toBe(true);
  });

  test('validates a supervisor mode agent', () => {
    const result = validate({ agent: 'Router', mode: 'supervisor' });
    expect(result).toBe(true);
  });

  // =========================================================================
  // REQUIRED FIELDS VALIDATION
  // =========================================================================

  test('rejects missing agent name', () => {
    const result = validate({ mode: 'reasoning', goal: 'Help' });
    expect(result).toBe(false);
    expect(validate.errors).toBeDefined();
    const missingAgent = validate.errors!.some(
      (e) => e.keyword === 'required' && e.params?.missingProperty === 'agent',
    );
    expect(missingAgent).toBe(true);
  });

  test('rejects missing mode', () => {
    const result = validate({ agent: 'Test', goal: 'Help' });
    expect(result).toBe(false);
    const missingMode = validate.errors!.some(
      (e) => e.keyword === 'required' && e.params?.missingProperty === 'mode',
    );
    expect(missingMode).toBe(true);
  });

  test('rejects invalid mode', () => {
    const result = validate({ agent: 'Test', mode: 'invalid', goal: 'Help' });
    expect(result).toBe(false);
    const enumError = validate.errors!.some((e) => e.keyword === 'enum');
    expect(enumError).toBe(true);
  });

  test('rejects empty agent name', () => {
    const result = validate({ agent: '', mode: 'reasoning' });
    expect(result).toBe(false);
  });

  // =========================================================================
  // GOAL + PERSONA
  // =========================================================================

  test('validates goal as string', () => {
    expect(validate({ agent: 'A', mode: 'reasoning', goal: 'Help users find hotels' })).toBe(true);
  });

  test('validates goal as object with description', () => {
    expect(
      validate({
        agent: 'A',
        mode: 'reasoning',
        goal: { description: 'Help users', measurable: true },
      }),
    ).toBe(true);
  });

  test('validates persona as string', () => {
    expect(
      validate({
        agent: 'A',
        mode: 'reasoning',
        persona: 'Friendly hotel assistant',
      }),
    ).toBe(true);
  });

  test('validates persona as object', () => {
    expect(
      validate({
        agent: 'A',
        mode: 'reasoning',
        persona: { description: 'Professional assistant' },
      }),
    ).toBe(true);
  });

  // =========================================================================
  // TOOLS
  // =========================================================================

  test('validates tools with all fields', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      goal: 'Help',
      tools: [
        {
          name: 'search_hotels',
          description: 'Search for available hotels',
          type: 'http',
          parameters: [
            { name: 'destination', type: 'string', required: true, description: 'City name' },
            { name: 'guests', type: 'number', required: false, default: 1 },
          ],
          returns: { type: 'object', fields: { hotels: { type: 'array' } } },
          hints: { cacheable: true, latency: 'medium', side_effects: false },
        },
      ],
    });
    expect(result).toBe(true);
  });

  test('validates tool with HTTP binding', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      tools: [
        {
          name: 'api_call',
          description: 'Call external API',
          type: 'http',
          http_binding: {
            endpoint: 'https://api.example.com/search',
            method: 'POST',
            timeout: 5000,
            retry: 3,
            headers: { 'Content-Type': 'application/json' },
          },
          parameters: [{ name: 'query', type: 'string' }],
        },
      ],
    });
    expect(result).toBe(true);
  });

  test('validates tool with MCP binding', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      tools: [
        {
          name: 'mcp_tool',
          type: 'mcp',
          mcp_binding: { server: 'my-server', tool: 'my-tool' },
          parameters: [],
        },
      ],
    });
    expect(result).toBe(true);
  });

  test('validates tool with lambda binding', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      tools: [
        {
          name: 'lambda_fn',
          type: 'lambda',
          lambda_binding: { function: 'my-function', runtime: 'nodejs20' },
          parameters: [],
        },
      ],
    });
    expect(result).toBe(true);
  });

  test('validates tool with sandbox binding', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      tools: [
        {
          name: 'code_runner',
          type: 'sandbox',
          sandbox_binding: { runtime: 'python', timeout: 10000, memory_mb: 256 },
          parameters: [],
        },
      ],
    });
    expect(result).toBe(true);
  });

  test('rejects tool with invalid type', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      tools: [{ name: 'bad', type: 'graphql', parameters: [] }],
    });
    expect(result).toBe(false);
  });

  test('rejects tool missing name', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      tools: [{ description: 'A tool', parameters: [] }],
    });
    expect(result).toBe(false);
  });

  // =========================================================================
  // GATHER
  // =========================================================================

  test('validates gather as array of fields', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      goal: 'Collect info',
      gather: [
        { name: 'email', type: 'string', prompt: 'Enter email', required: true },
        { name: 'age', type: 'number', required: false, default: 18 },
      ],
    });
    expect(result).toBe(true);
  });

  test('validates gather as object with fields', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      gather: {
        fields: [{ name: 'city', type: 'string', prompt: 'Which city?', required: true }],
      },
    });
    expect(result).toBe(true);
  });

  test('validates gather field with all options', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      gather: [
        {
          name: 'destination',
          type: 'string',
          prompt: 'Where would you like to go?',
          required: true,
          validate: 'destination.length >= 2',
          validation_process: 'LLM',
          retry_prompt: 'Please enter a valid destination',
          max_retries: 3,
          infer: true,
          range: false,
          list: false,
          preferences: false,
          depends_on: ['travel_type'],
          prompt_mode: 'ask',
          activation: 'progressive',
          semantics: { format: 'city_name', unit: 'location' },
          extraction_hints: ['Look for city names', 'Check for airport codes'],
        },
      ],
    });
    expect(result).toBe(true);
  });

  test('validates gather field with semantics.enum_set', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      gather: [
        {
          name: 'size',
          type: 'string',
          semantics: { enum_set: ['small', 'medium', 'large'] },
        },
      ],
    });
    expect(result).toBe(true);
  });

  test('validates semantics.enum_set coexisting with other semantics keys', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      gather: [
        {
          name: 'currency_choice',
          type: 'string',
          semantics: {
            format: 'currency_code',
            enum_set: ['USD', 'EUR', 'GBP'],
            locale: 'en-US',
          },
        },
      ],
    });
    expect(result).toBe(true);
  });

  test('rejects non-array semantics.enum_set', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      gather: [
        {
          name: 'size',
          type: 'string',
          semantics: { enum_set: 'small,medium,large' },
        },
      ],
    });
    expect(result).toBe(false);
  });

  test('validates gather field with data-driven activation', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      gather: [
        {
          name: 'special_request',
          activation: { when: 'vip_customer == true' },
        },
      ],
    });
    expect(result).toBe(true);
  });

  // =========================================================================
  // CONSTRAINTS
  // =========================================================================

  test('validates flat constraints (condition + on_fail string)', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      goal: 'Secure',
      constraints: [
        { condition: 'age >= 18', on_fail: 'Must be 18 or older' },
        { condition: 'verified == true', on_fail: 'Account must be verified' },
      ],
    });
    expect(result).toBe(true);
  });

  test('validates constraints with structured on_fail action', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      constraints: [
        {
          condition: 'age >= 18',
          on_fail: { action: 'respond', message: 'Must be 18+' },
        },
        {
          condition: 'amount <= 5000',
          on_fail: { action: 'escalate', reason: 'High value transaction' },
        },
        {
          condition: 'has_destination',
          on_fail: { action: 'collect_field', collect_fields: ['destination'], then: 'retry' },
        },
        {
          condition: 'hotel_selected',
          on_fail: { action: 'goto_step', step: 'select_hotel' },
        },
        {
          condition: 'blacklisted == false',
          on_fail: { action: 'block' },
        },
      ],
    });
    expect(result).toBe(true);
  });

  test('validates phased constraints', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      constraints: [
        {
          name: 'pre_booking',
          requirements: [
            { condition: 'guests <= 10', on_fail: 'Too many guests' },
            { condition: 'dates_valid', on_fail: { action: 'respond', message: 'Invalid dates' } },
          ],
        },
      ],
    });
    expect(result).toBe(true);
  });

  // =========================================================================
  // GUARDRAILS
  // =========================================================================

  test('validates guardrails', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      guardrails: [
        {
          name: 'pii_check',
          kind: 'input',
          check: 'contains_pii(input)',
          action: 'redact',
          message: 'PII detected and redacted',
          priority: 1,
        },
        {
          name: 'toxicity_check',
          kind: 'output',
          check: 'toxicity_score(output) < 0.3',
          action: 'block',
        },
      ],
    });
    expect(result).toBe(true);
  });

  test('rejects guardrail with invalid action', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      guardrails: [{ name: 'g1', check: 'true', action: 'delete' }],
    });
    expect(result).toBe(false);
  });

  // =========================================================================
  // COMPLETE
  // =========================================================================

  test('validates complete conditions', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      complete: [
        { when: 'booking_confirmed == true', respond: 'Your booking is confirmed!' },
        { when: 'task_done', respond: 'Done!', store: 'completed_tasks' },
      ],
    });
    expect(result).toBe(true);
  });

  // =========================================================================
  // HANDOFF
  // =========================================================================

  test('validates handoff configurations', () => {
    const result = validate({
      agent: 'Supervisor',
      mode: 'supervisor',
      handoff: [
        {
          to: 'Hotel_Search',
          when: 'intent contains "hotel"',
          priority: 1,
          context: {
            pass: ['destination', 'dates'],
            summary: 'User needs hotel search',
            memory_grants: [{ path: 'user.preferences' }],
            history: 'auto',
          },
          return: true,
          on_return: {
            handler: 'review_results',
          },
        },
        {
          to: 'Farewell',
          when: 'intent contains "bye"',
          context: { pass: [], summary: 'Ending conversation' },
          return: false,
        },
        {
          to: 'PaymentAgent',
          when: 'needs_payment',
          context: { pass: ['order_id'] },
          return: true,
          on_return: {
            handler: 'await_next_request',
            map: {
              confirmation_id: 'payment_confirmation_id',
            },
          },
        },
      ],
      return_handlers: {
        await_next_request: {
          respond: 'Anything else?',
          continue: true,
        },
      },
    });
    expect(result).toBe(true);
  });

  test('validates handoff history last_N shorthand', () => {
    const result = validate({
      agent: 'Supervisor',
      mode: 'supervisor',
      handoff: [
        {
          to: 'Specialist',
          when: 'needs_specialist',
          context: {
            summary: 'Resume the latest context',
            history: 'last_5',
          },
          return: false,
        },
      ],
    });

    expect(result).toBe(true);
  });

  test('validates typed handoff history object for last_n', () => {
    const result = validate({
      agent: 'Supervisor',
      mode: 'supervisor',
      handoff: [
        {
          to: 'Specialist',
          when: 'needs_specialist',
          context: {
            summary: 'Resume the latest context',
            history: {
              mode: 'last_n',
              count: 8,
            },
          },
          return: false,
        },
      ],
    });

    expect(result).toBe(true);
  });

  test('rejects invalid handoff history strategy strings', () => {
    const result = validate({
      agent: 'Supervisor',
      mode: 'supervisor',
      handoff: [
        {
          to: 'Specialist',
          when: 'needs_specialist',
          context: {
            history: 'recent',
          },
          return: false,
        },
      ],
    });

    expect(result).toBe(false);
  });

  test('rejects typed handoff history last_n without count', () => {
    const result = validate({
      agent: 'Supervisor',
      mode: 'supervisor',
      handoff: [
        {
          to: 'Specialist',
          when: 'needs_specialist',
          context: {
            history: {
              mode: 'last_n',
            },
          },
          return: false,
        },
      ],
    });

    expect(result).toBe(false);
  });

  test('validates execution_tree memory scope and memory_grants in handoff context', () => {
    const result = validate({
      agent: 'Supervisor',
      mode: 'supervisor',
      memory: {
        persistent: [
          {
            path: 'workflow.auth_token',
            scope: 'execution_tree',
            access: 'readwrite',
            type: 'string',
          },
        ],
      },
      handoff: [
        {
          to: 'Specialist',
          when: 'needs_specialist',
          context: {
            pass: ['customer_id'],
            summary: 'Resume specialist work',
            memory_grants: [
              { path: 'workflow.auth_token', access: 'readwrite' },
              { path: 'user.preference', access: 'read' },
            ],
          },
          return: false,
        },
      ],
    });

    expect(result).toBe(true);
  });

  test('validates handoff with remote agent', () => {
    const result = validate({
      agent: 'Router',
      mode: 'supervisor',
      handoff: [
        {
          to: 'External_Agent',
          when: 'needs_external',
          context: { pass: ['data'] },
          return: true,
          remote: {
            location: 'remote',
            endpoint: 'https://agent.example.com',
            protocol: 'a2a',
            auth: { type: 'bearer' },
            timeout: '30s',
          },
        },
      ],
    });
    expect(result).toBe(true);
  });

  // =========================================================================
  // DELEGATE
  // =========================================================================

  test('validates delegate configurations', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      delegate: [
        {
          agent: 'Price_Calculator',
          when: 'need_price_quote',
          purpose: 'Calculate final price',
          input: { hotel: 'selected_hotel', nights: 'num_nights' },
          returns: { final_price: 'estimated_total' },
          use_result: 'pricing_result',
          timeout: '10s',
          on_failure: 'Unable to calculate pricing',
        },
      ],
    });
    expect(result).toBe(true);
  });

  test('validates delegate with structured on_failure', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      delegate: [
        {
          agent: 'SubAgent',
          when: 'condition',
          on_failure: { type: 'retry', count: 3 },
        },
      ],
    });
    expect(result).toBe(true);
  });

  // =========================================================================
  // ESCALATE
  // =========================================================================

  test('validates escalation configuration', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      escalate: {
        triggers: [
          {
            when: 'frustration_level > 3',
            reason: 'Customer frustrated',
            priority: 'high',
            tags: ['urgent'],
          },
          { when: 'amount > 10000', reason: 'High value', priority: 'critical' },
        ],
        context_for_human: [
          { name: 'conversation_summary', template: 'Summary: {{summary}}' },
          { name: 'customer_info', include: ['name', 'email', 'account_id'] },
        ],
        on_human_complete: [
          { condition: 'resolved == true', action: 'COMPLETE' },
          { condition: 'resolved == false', action: 'RETRY' },
        ],
      },
    });
    expect(result).toBe(true);
  });

  // =========================================================================
  // MEMORY
  // =========================================================================

  test('validates memory configuration', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      memory: {
        session: [
          'search_count',
          { name: 'last_query', description: 'Most recent search query' },
          { name: 'total', initial_value: 0 },
        ],
        persistent: [
          'user.preferences',
          { path: 'user.history', description: 'Search history', access: 'read' },
        ],
        remember: [
          {
            when: 'booking_complete',
            store: { value: 'destination', target: 'user.last_destination' },
            ttl: '30d',
          },
        ],
        recall: [{ event: 'ON_START', instruction: 'Load user preferences' }],
      },
    });
    expect(result).toBe(true);
  });

  // =========================================================================
  // EXECUTION
  // =========================================================================

  test('validates execution configuration', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      execution: {
        model: 'gpt-4o',
        temperature: 0.7,
        max_tokens: 4096,
        tool_timeout: 30000,
        llm_timeout: 60000,
        session_idle_timeout: 300000,
        max_reasoning_iterations: 10,
        max_flow_iterations: 50,
        fallback_model: 'gpt-3.5-turbo',
        operation_models: {
          extraction: 'gpt-4o-mini',
          summarization: 'claude-3-haiku',
        },
      },
    });
    expect(result).toBe(true);
  });

  test('rejects invalid temperature', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      execution: { temperature: 3.0 },
    });
    expect(result).toBe(false);
  });

  // =========================================================================
  // MESSAGES + TEMPLATES
  // =========================================================================

  test('validates messages configuration', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      messages: {
        error_default: 'Something went wrong, please try again.',
        gather_prompt: 'Please provide the following information:',
        conversation_complete: 'Thank you for using our service!',
      },
    });
    expect(result).toBe(true);
  });

  test('validates templates', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      templates: [
        {
          name: 'booking_confirmation',
          content: 'Booking {{booking_id}} confirmed for {{guest_name}}.',
        },
        {
          name: 'search_results',
          content: 'Found {{count}} results.',
          formats: { markdown: '**Found {{count}} results.**' },
        },
      ],
    });
    expect(result).toBe(true);
  });

  // =========================================================================
  // ERROR HANDLING
  // =========================================================================

  test('validates on_error handlers', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      on_error: [
        { type: 'tool_timeout', respond: 'The service timed out.', retry: 2, retry_delay: 1000 },
        { type: 'tool_error', respond: 'Tool failed.', retry_backoff: 'exponential' },
        { type: 'invalid_input', respond: 'Invalid input.', then: 'retry_step' },
      ],
    });
    expect(result).toBe(true);
  });

  // =========================================================================
  // ON_START
  // =========================================================================

  test('validates on_start handler', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      on_start: {
        respond: 'Welcome! How can I help you?',
        call: 'check_returning_user',
        set: { session_initialized: 'true' },
      },
    });
    expect(result).toBe(true);
  });

  // =========================================================================
  // HOOKS
  // =========================================================================

  test('validates hooks configuration', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      hooks: {
        before_agent: { call: 'init_context' },
        after_agent: { respond: 'Session ended.' },
        before_turn: { set: { turn_count: 'turn_count + 1' } },
        after_turn: { call: 'log_turn' },
      },
    });
    expect(result).toBe(true);
  });

  // =========================================================================
  // FLOW (scripted mode)
  // =========================================================================

  test('validates flow configuration', () => {
    const result = validate({
      agent: 'FlowAgent',
      mode: 'scripted',
      flow: {
        entry_point: 'welcome',
        steps: ['welcome', 'collect_info', 'confirm'],
      },
    });
    expect(result).toBe(true);
  });

  // =========================================================================
  // IDENTITY BLOCK
  // =========================================================================

  test('validates identity block', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      identity: {
        role: 'Travel booking assistant',
        persona: 'Friendly and professional',
        expertise: ['hotels', 'flights', 'car rentals'],
        limitations: ['Cannot process payments', 'Cannot modify existing bookings'],
      },
    });
    expect(result).toBe(true);
  });

  // =========================================================================
  // SYSTEM PROMPT + LANGUAGE
  // =========================================================================

  test('validates system_prompt', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      system_prompt: 'You are a helpful assistant.',
    });
    expect(result).toBe(true);
  });

  test('validates language directive', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      language: 'es-EC',
    });
    expect(result).toBe(true);
  });

  // =========================================================================
  // FULL AGENT DEFINITION
  // =========================================================================

  test('validates a comprehensive agent definition', () => {
    const fullAgent = {
      agent: 'Hotel_Booking',
      mode: 'scripted',
      version: '1.2.0',
      description: 'Full-featured hotel booking agent',
      language: 'en',
      goal: 'Help users find and book hotels',
      persona: 'Professional and friendly hotel booking assistant',
      limitations: ['Cannot process refunds', 'Cannot modify existing bookings'],
      tools: [
        {
          name: 'search_hotels',
          description: 'Search for available hotels',
          type: 'http',
          parameters: [
            { name: 'destination', type: 'string', required: true },
            { name: 'checkin', type: 'date', required: true },
            { name: 'checkout', type: 'date', required: true },
            { name: 'guests', type: 'number', required: false, default: 1 },
          ],
          returns: { type: 'object', fields: { hotels: { type: 'array' } } },
          http_binding: {
            endpoint: 'https://api.hotels.com/v2/search',
            method: 'POST',
            timeout: 10000,
          },
        },
        {
          name: 'create_booking',
          description: 'Create a hotel booking',
          parameters: [
            { name: 'hotel_id', type: 'string', required: true },
            { name: 'guest_name', type: 'string', required: true },
          ],
          returns: { type: 'object', fields: { booking_id: { type: 'string' } } },
        },
      ],
      gather: [
        { name: 'destination', type: 'string', prompt: 'Where?', required: true },
        { name: 'checkin_date', type: 'date', prompt: 'Check-in?', required: true },
        { name: 'checkout_date', type: 'date', prompt: 'Check-out?', required: true },
        { name: 'num_guests', type: 'number', prompt: 'Guests?', required: true, default: 1 },
      ],
      constraints: [
        { condition: 'num_guests <= 10', on_fail: { action: 'respond', message: 'Max 10 guests' } },
        { condition: 'destination != ""', on_fail: 'Destination required' },
      ],
      complete: [
        {
          when: 'booking_confirmed == true',
          respond: 'Booking confirmed!',
          store: 'completed_bookings',
        },
      ],
      memory: {
        session: [
          'search_count',
          { name: 'selected_hotel', description: 'Currently selected hotel' },
        ],
        persistent: [{ path: 'user.preferences', access: 'read' }],
        remember: [],
        recall: [],
      },
      execution: {
        model: 'gpt-4o',
        temperature: 0.3,
        max_tokens: 2048,
        tool_timeout: 15000,
      },
      messages: {
        error_default: 'Something went wrong. Please try again.',
      },
      on_error: [{ type: 'tool_timeout', respond: 'Service timed out.', retry: 2 }],
      on_start: { respond: 'Welcome to hotel booking!' },
      flow: {
        entry_point: 'welcome',
        steps: ['welcome', 'search', 'select', 'book', 'confirm'],
      },
    };

    const result = validate(fullAgent);
    if (!result) {
      console.error('Validation errors:', JSON.stringify(validate.errors, null, 2));
    }
    expect(result).toBe(true);
  });

  // =========================================================================
  // ADDITIONAL PROPERTIES REJECTION
  // =========================================================================

  test('rejects unknown top-level properties', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      unknown_section: 'should fail',
    });
    expect(result).toBe(false);
  });

  // =========================================================================
  // NLU
  // =========================================================================

  test('validates NLU configuration', () => {
    const result = validate({
      agent: 'Test',
      mode: 'reasoning',
      nlu: {
        models: { fast: 'gpt-4o-mini', balanced: 'gpt-4o' },
        languages: ['en', 'es'],
        default_language: 'en',
        intents: [
          { name: 'greet', patterns: ['hello', 'hi', 'hey'] },
          {
            name: 'book_hotel',
            patterns: ['book a hotel', 'find accommodation'],
            examples: ['I want to book a room'],
            entities: ['location', 'date'],
          },
        ],
        categories: [{ name: 'travel', patterns: ['flight', 'hotel', 'car'] }],
        entities: [
          { name: 'location', type: 'enum', values: ['New York', 'London', 'Tokyo'] },
          { name: 'date', type: 'date' },
        ],
        glossary: ['booking', 'reservation'],
        evaluation: { log_predictions: true, confidence_threshold: 0.8 },
        embeddings: { enabled: true, provider: 'openai', model: 'text-embedding-3-small' },
      },
    });
    expect(result).toBe(true);
  });
});
