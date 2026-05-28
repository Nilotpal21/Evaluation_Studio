/**
 * YAML Parser Tests
 *
 * Tests for the YAML-format ABL parser that produces AgentBasedDocument objects.
 */

import { describe, test, expect, it } from 'vitest';
import { parseYamlABL, isYamlFormat } from '../parser/yaml-parser.js';

// =============================================================================
// FORMAT DETECTION
// =============================================================================

describe('isYamlFormat', () => {
  test('should detect YAML format with lowercase agent key', () => {
    const content = `agent: MyAgent\ngoal: "Help users"`;
    expect(isYamlFormat(content)).toBe(true);
  });

  test('should detect YAML format with lowercase goal key', () => {
    const content = `goal: "Do things"\nagent: TestBot`;
    expect(isYamlFormat(content)).toBe(true);
  });

  test('should detect YAML format with leading comments', () => {
    const content = `# This is a comment\n# Another comment\nagent: MyAgent\ngoal: "Help users"`;
    expect(isYamlFormat(content)).toBe(true);
  });

  test('should detect YAML format with YAML document separator', () => {
    const content = `---\nagent: MyAgent\ngoal: "Help users"`;
    expect(isYamlFormat(content)).toBe(true);
  });

  test('should reject legacy ABL format with uppercase AGENT', () => {
    const content = `AGENT: MyAgent\n
GOAL: "Handle agent tasks"
`;
    expect(isYamlFormat(content)).toBe(false);
  });

  test('should reject legacy ABL format with uppercase SUPERVISOR', () => {
    const content = `SUPERVISOR: MySupervisor\n
GOAL: "Route requests to appropriate agents"
`;
    expect(isYamlFormat(content)).toBe(false);
  });

  test('should reject empty content', () => {
    expect(isYamlFormat('')).toBe(false);
  });

  test('should reject content with only comments', () => {
    const content = `# just a comment\n# another`;
    expect(isYamlFormat(content)).toBe(false);
  });

  test('should detect supervisor key as YAML format', () => {
    const content = `supervisor: MySupervisor\ngoal: "Route requests"`;
    expect(isYamlFormat(content)).toBe(true);
  });
});

// =============================================================================
// BASIC PARSING
// =============================================================================

describe('parseYamlABL', () => {
  describe('basic agent parsing', () => {
    test('should parse a minimal agent', () => {
      const yaml = `
agent: SimpleBot
goal: "Help users with questions"
persona: "A friendly assistant"
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);
      expect(result.document).not.toBeNull();
      expect(result.document?.name).toBe('SimpleBot');
      expect(result.document?.goal.description).toBe('Help users with questions');
      expect(result.document?.persona.description).toBe('A friendly assistant');
      expect(result.document?.meta.kind).toBe('agent-based');
    });

    test('should parse an agent without mode field', () => {
      const yaml = `
agent: ScriptedBot
goal: "Process orders"
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);
      expect(result.document).not.toBeNull();
      expect(result.document?.name).toBe('ScriptedBot');
      expect(result.document?.goal.description).toBe('Process orders');
    });

    test('should parse object-form agent name', () => {
      const yaml = `
agent:
  name: ObjectBot
goal: "Handle object form"
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.name).toBe('ObjectBot');
      expect(result.document?.goal.description).toBe('Handle object form');
    });

    test('should reject mode field with an error', () => {
      const yaml = `
agent: ModeBot
mode: reasoning
goal: "Do things"
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('MODE is no longer supported');
    });

    test('should parse supervisor document kind', () => {
      const yaml = `
supervisor: MainSupervisor
goal: "Route requests"
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.name).toBe('MainSupervisor');
      expect(result.document?.meta.kind).toBe('supervisor');
    });

    test('should set meta fields correctly', () => {
      const yaml = `
agent: MetaBot
version: "2.0.0"
description: "A test bot"
goal: "Test"
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.meta.version).toBe('2.0.0');
      expect(result.document?.meta.description).toBe('A test bot');
      expect(result.document?.meta.name).toBe('MetaBot');
      expect(result.document?.meta.id).toBeTruthy();
      expect(result.document?.meta.createdAt).toBeInstanceOf(Date);
    });

    test('should handle goal as object with measurable flag', () => {
      const yaml = `
agent: GoalBot
goal:
  description: "Increase customer satisfaction"
  measurable: true
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.goal.description).toBe('Increase customer satisfaction');
      expect(result.document?.goal.measurable).toBe(true);
    });

    test('should handle language directive', () => {
      const yaml = `
agent: SpanishBot
language: "es-EC"
goal: "Ayudar a los usuarios"
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.language).toBe('es-EC');
    });
  });

  // =============================================================================
  // TOOLS
  // =============================================================================

  describe('tools parsing', () => {
    test('should parse tools with parameters and returns', () => {
      const yaml = `
agent: ToolBot
goal: "Search things"
tools:
  - name: search
    description: "Search for information"
    type: http
    parameters:
      - name: query
        type: string
        required: true
      - name: limit
        type: number
        required: false
        default: 10
    returns:
      type: object
      fields:
        results:
          type: array
          items:
            type: object
        total:
          type: number
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);

      const tools = result.document?.tools;
      expect(tools).toHaveLength(1);
      expect(tools?.[0].name).toBe('search');
      expect(tools?.[0].description).toBe('Search for information');
      expect(tools?.[0].type).toBe('http');

      // Parameters
      expect(tools?.[0].parameters).toHaveLength(2);
      expect(tools?.[0].parameters[0].name).toBe('query');
      expect(tools?.[0].parameters[0].type).toBe('string');
      expect(tools?.[0].parameters[0].required).toBe(true);
      expect(tools?.[0].parameters[1].name).toBe('limit');
      expect(tools?.[0].parameters[1].required).toBe(false);
      expect(tools?.[0].parameters[1].default).toBe(10);

      // Returns
      expect(tools?.[0].returns.type).toBe('object');
      expect(tools?.[0].returns.fields?.['results'].type).toBe('array');
      expect(tools?.[0].returns.fields?.['results'].items?.type).toBe('object');
      expect(tools?.[0].returns.fields?.['total'].type).toBe('number');
    });

    test('should parse multiple tools', () => {
      const yaml = `
agent: MultiToolBot
goal: "Do many things"
tools:
  - name: tool_a
    description: "First tool"
    parameters: []
    returns:
      type: string
  - name: tool_b
    description: "Second tool"
    parameters:
      - name: input
        type: string
        required: true
    returns:
      type: void
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.tools).toHaveLength(2);
      expect(result.document?.tools[0].name).toBe('tool_a');
      expect(result.document?.tools[1].name).toBe('tool_b');
    });

    test('should parse tool compaction hints', () => {
      const yaml = `
agent: CompactionToolBot
goal: "Use compact tool results"
tools:
  - name: search_hotels
    description: "Search hotels"
    parameters:
      - name: destination
        type: string
    returns:
      type: object
    compaction:
      essential_fields: [name, price, availability]
      max_description_length: 160
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.tools[0].compaction).toEqual({
        essential_fields: ['name', 'price', 'availability'],
        max_description_length: 160,
      });
    });

    test('should parse tools with hints', () => {
      const yaml = `
agent: HintBot
goal: "Use tools"
tools:
  - name: cached_search
    description: "Cacheable search"
    hints:
      cacheable: true
      latency: fast
      side_effects: false
      timeout: 5000
    parameters: []
    returns:
      type: object
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.tools[0].hints?.cacheable).toBe(true);
      expect(result.document?.tools[0].hints?.latency).toBe('fast');
      expect(result.document?.tools[0].hints?.timeout).toBe(5000);
    });

    test('should default parameters to required when not specified', () => {
      const yaml = `
agent: DefaultReqBot
goal: "Test"
tools:
  - name: my_tool
    parameters:
      - name: input
        type: string
    returns:
      type: void
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.tools[0].parameters[0].required).toBe(true);
    });

    test('should default returns to void when missing', () => {
      const yaml = `
agent: NoReturnBot
goal: "Test"
tools:
  - name: fire_and_forget
    parameters: []
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.tools[0].returns.type).toBe('void');
    });
  });

  // =============================================================================
  // GATHER
  // =============================================================================

  describe('gather parsing', () => {
    test('should parse gather fields with fields wrapper', () => {
      const yaml = `
agent: GatherBot
goal: "Collect info"
gather:
  fields:
    - name: email
      type: string
      prompt: "What is your email?"
      required: true
    - name: age
      type: number
      prompt: "How old are you?"
      required: false
      default: 0
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);

      const gather = result.document?.gather;
      expect(gather).toHaveLength(2);
      expect(gather?.[0].name).toBe('email');
      expect(gather?.[0].type).toBe('string');
      expect(gather?.[0].prompt).toBe('What is your email?');
      expect(gather?.[0].required).toBe(true);
      expect(gather?.[1].name).toBe('age');
      expect(gather?.[1].required).toBe(false);
      expect(gather?.[1].default).toBe(0);
    });

    test('should parse gather with validation', () => {
      const yaml = `
agent: ValidateBot
goal: "Validate input"
gather:
  fields:
    - name: phone
      type: string
      prompt: "Enter phone number"
      validate: "matches('^[0-9]{10}$')"
      validation_process: REGEX
      retry_prompt: "Please enter a valid 10-digit phone number"
      max_retries: 3
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);

      const field = result.document?.gather[0];
      expect(field?.validate).toBe("matches('^[0-9]{10}$')");
      expect(field?.validationProcess).toBe('REGEX');
      expect(field?.retryPrompt).toBe('Please enter a valid 10-digit phone number');
      expect(field?.maxRetries).toBe(3);
    });

    test('should default gather field required to true when not specified', () => {
      const yaml = `
agent: DefaultReqGatherBot
goal: "Test"
gather:
  fields:
    - name: name
      type: string
      prompt: "Your name?"
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.gather[0].required).toBe(true);
    });

    test('should parse gather as direct array', () => {
      const yaml = `
agent: DirectGatherBot
goal: "Test"
gather:
  - name: city
    type: string
    prompt: "Your city?"
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.gather).toHaveLength(1);
      expect(result.document?.gather[0].name).toBe('city');
    });
  });

  // =============================================================================
  // CONSTRAINTS
  // =============================================================================

  describe('constraints parsing', () => {
    test('should parse flat constraints with string on_fail', () => {
      const yaml = `
agent: ConstraintBot
goal: "Check constraints"
constraints:
  - condition: "user.age >= 18"
    on_fail: "Must be 18 or older"
  - condition: "user.verified == true"
    on_fail: "Account must be verified"
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);

      const constraints = result.document?.constraints;
      expect(constraints).toHaveLength(1);
      expect(constraints?.[0].name).toBe('always');
      expect(constraints?.[0].requirements).toHaveLength(2);
      expect(constraints?.[0].requirements[0].condition).toBe('user.age >= 18');
      expect(constraints?.[0].requirements[0].onFail).toBe('Must be 18 or older');
    });

    test('should parse constraints with structured on_fail action', () => {
      const yaml = `
agent: ActionConstraintBot
goal: "Enforce rules"
constraints:
  - condition: "balance > 0"
    on_fail:
      action: respond
      message: "Insufficient balance"
  - condition: "is_business_hours()"
    on_fail:
      action: escalate
      reason: "Outside business hours"
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);

      const reqs = result.document?.constraints[0].requirements;
      expect(reqs?.[0].onFail).toEqual({
        type: 'respond',
        message: 'Insufficient balance',
      });
      expect(reqs?.[1].onFail).toEqual({
        type: 'escalate',
        reason: 'Outside business hours',
      });
    });

    test('should parse phased constraints', () => {
      const yaml = `
agent: PhasedConstraintBot
goal: "Multi-phase"
constraints:
  - name: pre_booking
    requirements:
      - condition: "dates.valid == true"
        on_fail: "Invalid dates"
  - name: pre_payment
    requirements:
      - condition: "payment.authorized == true"
        on_fail: "Payment not authorized"
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);

      const constraints = result.document?.constraints;
      expect(constraints).toHaveLength(2);
      expect(constraints?.[0].name).toBe('pre_booking');
      expect(constraints?.[1].name).toBe('pre_payment');
    });

    test('should parse constraint kind and when metadata', () => {
      const yaml = `
agent: ConditionalConstraintBot
goal: "Retain constraint metadata"
constraints:
  - condition: "daily_wire_used + amount <= daily_wire_limit"
    kind: limit
    on_fail: "Limit exceeded"
  - condition: 'beneficiary_country in ["CU","IR"]'
    kind: restrict
    when: 'channel == "wire"'
    severity: warning
    on_fail: "Destination prohibited"
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);

      const reqs = result.document?.constraints[0].requirements;
      expect(reqs?.[0].kind).toBe('limit');
      expect(reqs?.[1].kind).toBe('restrict');
      expect(reqs?.[1].when).toBe('channel == "wire"');
      expect(reqs?.[1].severity).toBe('warning');
    });

    test('should parse constraint before metadata from YAML', () => {
      const yaml = `
agent: BeforeConstraintBot
goal: "Retain structural BEFORE metadata"
constraints:
  - condition: "measure_field IS SET"
    before: "calling search_aggregate"
    on_fail: "Choose a measure first"
  - condition: "aggregation_validated == true"
    before:
      kind: respond
      raw: "returning results"
    on_fail: "Validate before responding"
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);

      const reqs = result.document?.constraints[0].requirements;
      expect(reqs?.[0].before).toEqual({
        kind: 'tool_call',
        raw: 'calling search_aggregate',
        target: 'search_aggregate',
      });
      expect(reqs?.[1].before).toEqual({
        kind: 'respond',
        raw: 'returning results',
      });
    });
  });

  // =============================================================================
  // COMPLETE
  // =============================================================================

  describe('complete parsing', () => {
    test('should parse completion conditions', () => {
      const yaml = `
agent: CompleteBot
goal: "Complete tasks"
complete:
  - when: "task_done == true"
    respond: "Task completed successfully!"
  - when: "user_cancelled == true"
    respond: "Task was cancelled."
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);

      const complete = result.document?.complete;
      expect(complete).toHaveLength(2);
      expect(complete?.[0].when).toBe('task_done == true');
      expect(complete?.[0].respond).toBe('Task completed successfully!');
      expect(complete?.[1].when).toBe('user_cancelled == true');
    });

    test('should parse completion with store', () => {
      const yaml = `
agent: StoreBot
goal: "Store results"
complete:
  - when: "order_placed == true"
    respond: "Order placed."
    store: "order_confirmation"
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.complete[0].store).toBe('order_confirmation');
    });
  });

  // =============================================================================
  // HANDOFF & DELEGATE
  // =============================================================================

  describe('handoff and delegate parsing', () => {
    test('should parse handoff configuration', () => {
      const yaml = `
agent: HandoffBot
goal: "Route to agents"
return_handlers:
  await_next_request:
    respond: "What else can I help with?"
    continue: true
handoff:
  - to: PaymentAgent
    when: "needs_payment == true"
    context:
      pass:
        - order_id
        - amount
      summary: "User needs to make a payment"
    return: true
    on_return:
      handler: await_next_request
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);

      expect(result.document?.returnHandlers).toEqual({
        await_next_request: {
          respond: 'What else can I help with?',
          continue: true,
        },
      });
      const handoff = result.document?.handoff;
      expect(handoff).toHaveLength(1);
      expect(handoff?.[0].to).toBe('PaymentAgent');
      expect(handoff?.[0].when).toBe('needs_payment == true');
      expect(handoff?.[0].context.pass).toEqual(['order_id', 'amount']);
      expect(handoff?.[0].context.summary).toBe('User needs to make a payment');
      expect(handoff?.[0].return).toBe(true);
      expect(handoff?.[0].onReturn).toEqual({ handler: 'await_next_request' });
    });

    test('should preserve legacy inline on_return shorthand as a compatibility string', () => {
      const yaml = `
agent: HandoffBot
goal: "Route to agents"
handoff:
  - to: PaymentAgent
    when: "needs_payment == true"
    context:
      pass:
        - order_id
      summary: "User needs to make a payment"
    return: true
    on_return: await_next_request
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.handoff[0].onReturn).toBe('await_next_request');
    });

    test('should parse execution_tree memory scope and handoff memory grants', () => {
      const yaml = `
agent: MemoryGrantBot
goal: "Route with workflow-scoped memory"
memory:
  persistent:
    - path: workflow.auth_token
      scope: execution_tree
      access: readwrite
handoff:
  - to: SpecialistAgent
    when: "needs_specialist == true"
    context:
      pass:
        - customer_id
      summary: "Resume specialist work"
      memory_grants:
        - path: workflow.auth_token
          access: readwrite
        - path: user.preference
          access: read
    return: false
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);

      expect(result.document?.memory.persistent).toEqual([
        expect.objectContaining({
          path: 'workflow.auth_token',
          scope: 'execution_tree',
          access: 'readwrite',
        }),
      ]);
      expect(result.document?.handoff?.[0].context.memoryGrants).toEqual([
        { path: 'workflow.auth_token', access: 'readwrite' },
        { path: 'user.preference', access: 'read' },
      ]);
    });

    test('should parse typed handoff history authoring for last_n', () => {
      const yaml = `
agent: HistoryBot
goal: "Route with bounded raw history"
handoff:
  - to: SpecialistAgent
    when: "needs_specialist == true"
    context:
      summary: "Resume with recent context"
      history:
        mode: last_n
        count: 6
    return: false
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.handoff?.[0].context.history).toEqual({
        mode: 'last_n',
        count: 6,
      });
    });

    test('should parse delegate configuration', () => {
      const yaml = `
agent: DelegateBot
goal: "Delegate work"
delegate:
  - agent: SearchAgent
    when: "needs_search == true"
    purpose: "Search for products"
    input:
      query: "search_query"
      category: "product_category"
    returns:
      results: "search_results"
    use_result: "Display search results to user"
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);

      const delegate = result.document?.delegate;
      expect(delegate).toHaveLength(1);
      expect(delegate?.[0].agent).toBe('SearchAgent');
      expect(delegate?.[0].when).toBe('needs_search == true');
      expect(delegate?.[0].purpose).toBe('Search for products');
      expect(delegate?.[0].input).toEqual({ query: 'search_query', category: 'product_category' });
      expect(delegate?.[0].returns).toEqual({ results: 'search_results' });
      expect(delegate?.[0].useResult).toBe('Display search results to user');
    });
  });

  // =============================================================================
  // ESCALATE
  // =============================================================================

  describe('escalate parsing', () => {
    test('should parse escalation config', () => {
      const yaml = `
agent: EscalateBot
goal: "Handle escalations"
escalate:
  triggers:
    - when: "user.frustrated == true"
      reason: "User is frustrated"
      priority: high
      tags:
        - urgent
        - support
  context_for_human:
    - name: conversation_summary
      template: "User asked about {topic}"
  on_human_complete:
    - condition: "resolved == true"
      action: "complete"
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);

      const escalate = result.document?.escalate;
      expect(escalate).toBeDefined();
      expect(escalate?.triggers).toHaveLength(1);
      expect(escalate?.triggers[0].priority).toBe('high');
      expect(escalate?.triggers[0].tags).toEqual(['urgent', 'support']);
      expect(escalate?.contextForHuman).toHaveLength(1);
      expect(escalate?.onHumanComplete).toHaveLength(1);
    });
  });

  // =============================================================================
  // EXECUTION CONFIG
  // =============================================================================

  describe('execution config parsing', () => {
    test('should parse execution settings', () => {
      const yaml = `
agent: ExecutionBot
goal: "Test execution"
execution:
  model: "gpt-4o"
  temperature: 0.7
  max_tokens: 4096
  tool_timeout: 30000
  max_reasoning_iterations: 10
  fallback_model: "gpt-3.5-turbo"
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);

      const exec = result.document?.execution;
      expect(exec?.model).toBe('gpt-4o');
      expect(exec?.temperature).toBe(0.7);
      expect(exec?.max_tokens).toBe(4096);
      expect(exec?.tool_timeout).toBe(30000);
      expect(exec?.max_reasoning_iterations).toBe(10);
      expect(exec?.fallback_model).toBe('gpt-3.5-turbo');
    });

    test('should parse execution compaction policy', () => {
      const yaml = `
agent: ExecutionCompactionBot
goal: "Test execution compaction"
execution:
  compaction:
    model: "gpt-4o-mini"
    tool_results:
      strategy: structured
      max_chars: 4096
      structured_threshold: 1024
      keep_recent: 1
      essential_fields:
        search_hotels: [name, price]
      max_description_length: 120
      summarize_prompt: "Keep IDs and prices."
    prior_turns:
      strategy: compact
      assistant_preview_chars: 80
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.execution?.compaction).toEqual({
        model: 'gpt-4o-mini',
        tool_results: {
          strategy: 'structured',
          max_chars: 4096,
          structured_threshold: 1024,
          keep_recent: 1,
          essential_fields: {
            search_hotels: ['name', 'price'],
          },
          max_description_length: 120,
          summarize_prompt: 'Keep IDs and prices.',
        },
        prior_turns: {
          strategy: 'compact',
          assistant_preview_chars: 80,
        },
      });
    });
  });

  // =============================================================================
  // ON_ERROR & ON_START
  // =============================================================================

  describe('error and start handlers', () => {
    test('should parse on_error handlers', () => {
      const yaml = `
agent: ErrorBot
goal: "Handle errors"
on_error:
  - type: tool_timeout
    respond: "The tool took too long. Please try again."
    retry: 2
    retry_delay: 1000
  - type: tool_error
    respond: "Something went wrong."
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);

      const onError = result.document?.onError;
      expect(onError).toHaveLength(2);
      expect(onError?.[0].type).toBe('tool_timeout');
      expect(onError?.[0].retry).toBe(2);
      expect(onError?.[0].retryDelay).toBe(1000);
      expect(onError?.[1].type).toBe('tool_error');
    });

    test('should parse on_start handler', () => {
      const yaml = `
agent: StartBot
goal: "Greet users"
on_start:
  respond: "Welcome! How can I help you?"
  call: check_returning_user
  set:
    session_initialized: "true"
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);

      const onStart = result.document?.onStart;
      expect(onStart?.respond).toBe('Welcome! How can I help you?');
      expect(onStart?.call).toBe('check_returning_user');
      expect(onStart?.set).toEqual({ session_initialized: 'true' });
    });

    test('should parse on_start structured respond payloads from YAML', () => {
      const yaml = `
agent: StartStructuredBot
goal: "Greet users with structured content"
on_start:
  respond: "Welcome! Choose an option."
  voice_config:
    plain_text: "Welcome. Choose an option."
  rich_content:
    markdown: "### Welcome"
  actions:
    - id: start
      type: button
      label: "Start"
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);

      const onStart = result.document?.onStart;
      expect(onStart).toMatchObject({
        respond: 'Welcome! Choose an option.',
        voiceConfig: {
          plain_text: 'Welcome. Choose an option.',
        },
        richContent: {
          markdown: '### Welcome',
        },
        actions: {
          elements: [{ id: 'start', type: 'button', label: 'Start' }],
        },
      });
    });
  });

  describe('flow structured branch parsing', () => {
    test('should parse ON_INPUT structured respond payloads from YAML', () => {
      const yaml = `
agent: BranchYamlBot
goal: "Parse branch payloads"
flow:
  entry_point: start
  steps:
    start:
      reasoning: false
      on_input:
        - condition: input contains "check"
          respond: "Choose an option"
          voice_config:
            plain_text: "Choose an option"
          rich_content:
            markdown: "### Choose an option"
          actions:
            - id: done
              type: button
              label: "Done"
          then: done
        - then: complete
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);

      const branch = result.document?.flow?.definitions['start']?.onInput?.[0];
      expect(branch).toMatchObject({
        respond: 'Choose an option',
        voiceConfig: {
          plain_text: 'Choose an option',
        },
        richContent: {
          markdown: '### Choose an option',
        },
        actions: {
          elements: [{ id: 'done', type: 'button', label: 'Done' }],
        },
      });
    });

    test('should parse ON_SUCCESS and ON_FAILURE structured payloads from YAML', () => {
      const yaml = `
agent: CallResultYamlBot
goal: "Parse call result payloads"
flow:
  entry_point: verify
  steps:
    verify:
      reasoning: false
      call: validate_pin
      on_success:
        respond: "Approved"
        voice_config:
          plain_text: "Approved"
        rich_content:
          markdown: "### Approved"
        actions:
          - id: continue
            type: button
            label: "Continue"
        then: done
        branches:
          - condition: pinResult.status == "needs_confirmation"
            respond: "Need confirmation"
            voice_config:
              plain_text: "Need confirmation"
            rich_content:
              markdown: "### Need confirmation"
            actions:
              - id: confirm
                type: button
                label: "Confirm"
            then: confirm
      on_failure:
        respond: "Try again"
        rich_content:
          markdown: "### Try again"
        actions:
          - id: retry
            type: button
            label: "Retry"
        then: retry
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);

      const step = result.document?.flow?.definitions['verify'];
      expect(step?.onSuccess).toMatchObject({
        respond: 'Approved',
        voiceConfig: {
          plain_text: 'Approved',
        },
        richContent: {
          markdown: '### Approved',
        },
        actions: {
          elements: [{ id: 'continue', type: 'button', label: 'Continue' }],
        },
        then: 'done',
      });
      expect(step?.onSuccess?.branches?.[0]).toMatchObject({
        respond: 'Need confirmation',
        voiceConfig: {
          plain_text: 'Need confirmation',
        },
        richContent: {
          markdown: '### Need confirmation',
        },
        actions: {
          elements: [{ id: 'confirm', type: 'button', label: 'Confirm' }],
        },
        then: 'confirm',
      });
      expect(step?.onFailure).toMatchObject({
        respond: 'Try again',
        richContent: {
          markdown: '### Try again',
        },
        actions: {
          elements: [{ id: 'retry', type: 'button', label: 'Retry' }],
        },
        then: 'retry',
      });
    });
  });

  // =============================================================================
  // IDENTITY (SHORTHAND)
  // =============================================================================

  describe('identity section', () => {
    test('should map identity to goal, persona, and limitations', () => {
      const yaml = `
agent: IdentityBot
identity:
  role: "Customer Support Specialist"
  persona: "Professional and empathetic"
  expertise:
    - "order management"
    - "returns processing"
  limitations:
    - "cannot process refunds over $500"
    - "cannot access financial records"
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);

      expect(result.document?.goal.description).toBe('Customer Support Specialist');
      expect(result.document?.persona.description).toContain('Professional and empathetic');
      expect(result.document?.persona.description).toContain(
        'Expertise: order management, returns processing',
      );
      expect(result.document?.limitations).toHaveLength(2);
      expect(result.document?.limitations[0].description).toBe('cannot process refunds over $500');
    });
  });

  // =============================================================================
  // LIMITATIONS (STANDALONE)
  // =============================================================================

  describe('limitations parsing', () => {
    test('should parse standalone limitations', () => {
      const yaml = `
agent: LimitBot
goal: "Test"
limitations:
  - "Cannot access external APIs"
  - "Cannot process payments"
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.limitations).toHaveLength(2);
      expect(result.document?.limitations[0].description).toBe('Cannot access external APIs');
    });
  });

  // =============================================================================
  // GUARDRAILS
  // =============================================================================

  describe('guardrails parsing', () => {
    test('should parse guardrail definitions', () => {
      const yaml = `
agent: GuardBot
goal: "Stay safe"
guardrails:
  - name: no_pii
    kind: output
    check: "not contains_pii(response)"
    action: redact
    message: "PII detected in response"
  - name: no_harmful
    kind: both
    check: "not is_harmful(content)"
    action: block
    priority: 0
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);

      const guardrails = result.document?.guardrails;
      expect(guardrails).toHaveLength(2);
      expect(guardrails?.[0].name).toBe('no_pii');
      expect(guardrails?.[0].kind).toBe('output');
      expect(guardrails?.[0].action).toBe('redact');
      expect(guardrails?.[0].message).toBe('PII detected in response');
      expect(guardrails?.[1].kind).toBe('both');
      expect(guardrails?.[1].action).toBe('block');
    });
  });

  // =============================================================================
  // MESSAGES & TEMPLATES
  // =============================================================================

  describe('messages and templates', () => {
    test('should parse messages config', () => {
      const yaml = `
agent: MsgBot
goal: "Test"
messages:
  error_default: "Oops, something went wrong."
  gather_prompt: "Please provide the following:"
  conversation_complete: "Thank you!"
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.messages?.error_default).toBe('Oops, something went wrong.');
      expect(result.document?.messages?.gather_prompt).toBe('Please provide the following:');
    });

    test('should parse templates', () => {
      const yaml = `
agent: TemplateBot
goal: "Test"
templates:
  - name: greeting
    content: "Hello {{user.name}}, welcome!"
  - name: farewell
    content: "Goodbye {{user.name}}!"
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.templates).toHaveLength(2);
      expect(result.document?.templates?.[0].name).toBe('greeting');
      expect(result.document?.templates?.[0].content).toBe('Hello {{user.name}}, welcome!');
    });
  });

  // =============================================================================
  // MEMORY
  // =============================================================================

  describe('memory parsing', () => {
    test('should parse session and persistent memory', () => {
      const yaml = `
agent: MemoryBot
goal: "Remember things"
memory:
  session:
    - name: cart_items
      description: "Items in the shopping cart"
      initial_value: []
    - name: visit_count
  persistent:
    - path: "user.preferences"
      description: "User preferences"
      access: read
    - "user.name"
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);

      const memory = result.document?.memory;
      expect(memory?.session).toHaveLength(2);
      expect(memory?.session[0].name).toBe('cart_items');
      expect(memory?.session[0].description).toBe('Items in the shopping cart');
      expect(memory?.session[1].name).toBe('visit_count');

      expect(memory?.persistent).toHaveLength(2);
      expect(memory?.persistent[0].path).toBe('user.preferences');
      expect(memory?.persistent[0].access).toBe('read');
      expect(memory?.persistent[1].path).toBe('user.name');
    });
  });

  // =============================================================================
  // SYSTEM PROMPT
  // =============================================================================

  describe('system prompt parsing', () => {
    test('should parse system_prompt', () => {
      const yaml = `
agent: PromptBot
goal: "Custom prompt"
system_prompt: "You are a highly specialized financial advisor."
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.systemPrompt).toBe('You are a highly specialized financial advisor.');
    });
  });

  // =============================================================================
  // ERROR CASES
  // =============================================================================

  describe('error handling', () => {
    test('should return error for invalid YAML syntax', () => {
      const yaml = `
agent: BadBot
goal: [invalid yaml
  persona: "this is broken
`;
      const result = parseYamlABL(yaml);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.document).toBeNull();
    });

    test('should return error for missing agent name', () => {
      const yaml = `
goal: "No agent name"
`;
      const result = parseYamlABL(yaml);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].message).toContain('agent');
      expect(result.document).toBeNull();
    });

    test('should return error for non-object YAML', () => {
      const yaml = `"just a string"`;
      const result = parseYamlABL(yaml);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.document).toBeNull();
    });

    test('should return error for null YAML content', () => {
      const yaml = ``;
      const result = parseYamlABL(yaml);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.document).toBeNull();
    });

    test('should error when mode field is present', () => {
      const yaml = `
agent: WarnBot
mode: unknown_mode
goal: "Test"
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('MODE is no longer supported');
    });
  });

  // =============================================================================
  // COMPREHENSIVE AGENT
  // =============================================================================

  describe('comprehensive agent parsing', () => {
    test('should parse a full agent with all sections', () => {
      const yaml = `
agent: FullAgent
version: "1.5.0"
description: "A comprehensive test agent"
language: "en"
goal: "Handle all customer requests"
persona: "Professional and knowledgeable"
limitations:
  - "Cannot process refunds"
execution:
  model: gpt-4o
  temperature: 0.5
  max_tokens: 2048
tools:
  - name: lookup_order
    description: "Look up an order"
    parameters:
      - name: order_id
        type: string
        required: true
    returns:
      type: object
gather:
  fields:
    - name: customer_id
      type: string
      prompt: "What is your customer ID?"
      required: true
constraints:
  - condition: "customer_id != ''"
    on_fail: "Customer ID is required"
complete:
  - when: "request_fulfilled == true"
    respond: "Is there anything else I can help you with?"
on_error:
  - type: tool_error
    respond: "Something went wrong, please try again."
    retry: 1
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);
      expect(result.document).not.toBeNull();

      const doc = result.document!;
      expect(doc.name).toBe('FullAgent');
      expect(doc.language).toBe('en');
      expect(doc.meta.version).toBe('1.5.0');
      expect(doc.goal.description).toBe('Handle all customer requests');
      expect(doc.persona.description).toBe('Professional and knowledgeable');
      expect(doc.limitations).toHaveLength(1);
      expect(doc.execution?.model).toBe('gpt-4o');
      expect(doc.tools).toHaveLength(1);
      expect(doc.gather).toHaveLength(1);
      expect(doc.constraints).toHaveLength(1);
      expect(doc.complete).toHaveLength(1);
      expect(doc.onError).toHaveLength(1);
    });
  });

  // =============================================================================
  // EMPTY/MISSING OPTIONAL SECTIONS
  // =============================================================================

  describe('missing optional sections', () => {
    test('should produce empty arrays for missing sections', () => {
      const yaml = `
agent: MinimalBot
goal: "Be minimal"
`;
      const result = parseYamlABL(yaml);
      expect(result.errors).toHaveLength(0);

      const doc = result.document!;
      expect(doc.tools).toEqual([]);
      expect(doc.gather).toEqual([]);
      expect(doc.constraints).toEqual([]);
      expect(doc.delegate).toEqual([]);
      expect(doc.handoff).toEqual([]);
      expect(doc.complete).toEqual([]);
      expect(doc.onError).toEqual([]);
      expect(doc.limitations).toEqual([]);
      expect(doc.memory).toEqual({
        session: [],
        persistent: [],
        remember: [],
        recall: [],
      });
    });
  });
});
