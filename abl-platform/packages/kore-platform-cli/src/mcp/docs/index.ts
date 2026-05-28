/**
 * Agent ABL Documentation
 *
 * Embedded documentation for Claude Code to understand agent ABL syntax,
 * trace events, and debugging techniques.
 */

// =============================================================================
// ABL OVERVIEW
// =============================================================================

export const ABL_OVERVIEW = `# Agent ABL Overview

The Agent Blueprint Language (ABL) is a declarative language for defining AI agents — conversational, system-driven, or hybrid.
It supports three agent types, each with different execution models.

## Agent Types

| Type | Description | Use Case |
|------|-------------|----------|
| **scripted** | Follows predefined flow with explicit steps | Forms, wizards, structured conversations |
| **reasoning** | Uses LLM judgment to decide actions | Open-ended tasks, problem-solving |
| **supervisor** | Delegates to specialized child agents | Complex systems, multi-domain support |

## Basic Structure

\`\`\`yaml
agent:
  name: my_agent
  type: scripted | reasoning | supervisor
  model: claude-3-5-sonnet

  # Type-specific configuration follows...
\`\`\`

## Key Concepts

- **Context**: Persistent state stored during conversation
- **Tools**: External functions the agent can call
- **Constraints**: Rules that limit agent behavior
- **Transitions**: Conditions for moving between states
`;

// =============================================================================
// SCRIPTED AGENTS
// =============================================================================

export const ABL_SCRIPTED = `# Scripted Agents

Scripted agents follow a predefined flow with explicit steps and transitions.
They are ideal for structured conversations like booking flows, forms, or wizards.

## Structure

\`\`\`yaml
agent:
  name: booking_agent
  type: scripted
  model: claude-3-5-sonnet

  system_prompt: |
    You are a helpful booking assistant.

  flow:
    greeting:
      prompt: "Welcome! How can I help you today?"
      transitions:
        - to: collect_info
          when: user_wants_booking

    collect_info:
      collect:
        - name: { type: string, required: true }
        - email: { type: string, format: email, required: true }
        - date: { type: date, required: true }
      on_complete: process_booking
      on_error: handle_error

    process_booking:
      call: create_booking
      with:
        name: "{{context.name}}"
        email: "{{context.email}}"
        date: "{{context.date}}"
      transitions:
        - to: confirmation
          when: booking_success
        - to: handle_error
          when: booking_failed

    confirmation:
      respond: |
        Your booking is confirmed!
        Reference: {{context.booking_id}}
      terminal: true
\`\`\`

## Flow Steps

### prompt
Displays a message and waits for user input.
\`\`\`yaml
step_name:
  prompt: "What would you like to do?"
\`\`\`

### collect
Gathers multiple fields from the user.
\`\`\`yaml
collect_info:
  collect:
    - field_name: { type: string, required: true, description: "Help text" }
    - another_field: { type: number, min: 1, max: 100 }
\`\`\`

### call
Invokes a tool/function.
\`\`\`yaml
process:
  call: tool_name
  with:
    param: "{{context.value}}"
\`\`\`

### respond
Sends a response to the user.
\`\`\`yaml
finish:
  respond: "Thank you for your request!"
  terminal: true  # Marks conversation end
\`\`\`

### delegate
Hands off to another agent.
\`\`\`yaml
escalate:
  delegate: support_agent
  context:
    reason: "{{context.escalation_reason}}"
\`\`\`

## Transitions

Transitions define how to move between steps:

\`\`\`yaml
transitions:
  - to: next_step
    when: condition_name
  - to: fallback_step  # No condition = default
\`\`\`

### Built-in Conditions
- \`user_wants_*\`: Intent detection
- \`context.field\`: Check if field is set
- \`context.field == value\`: Equality check
- \`tool_success\`: Last tool call succeeded
- \`tool_failed\`: Last tool call failed

## Common Issues

### Infinite Loop in Collect Step
**Symptom**: Same step repeating indefinitely
**Cause**: Required fields never set in context
**Debug**: Check trace events for \`dsl_collect\` and verify fields are being stored
`;

// =============================================================================
// REASONING AGENTS
// =============================================================================

export const ABL_REASONING = `# Reasoning Agents

Reasoning agents use LLM judgment to decide which actions to take.
They are ideal for open-ended tasks and problem-solving.

## Structure

\`\`\`yaml
agent:
  name: research_agent
  type: reasoning
  model: claude-3-5-sonnet

  system_prompt: |
    You are a research assistant. Help users find information
    and answer questions accurately.

  tools:
    - name: search_web
      description: Search the web for information
      parameters:
        query: { type: string, required: true }

    - name: read_document
      description: Read and analyze a document
      parameters:
        url: { type: string, required: true }

  constraints:
    - name: cite_sources
      description: Always cite sources for claims
      enforcement: strict

    - name: no_harmful_content
      description: Never generate harmful content
      enforcement: block

  goals:
    - Provide accurate, well-researched answers
    - Cite sources for all factual claims
    - Ask clarifying questions when needed
\`\`\`

## Tools

Tools define actions the agent can take:

\`\`\`yaml
tools:
  - name: tool_name
    description: What the tool does (shown to LLM)
    parameters:
      param1: { type: string, required: true }
      param2: { type: number, default: 10 }
    returns: { type: object }
\`\`\`

### Parameter Types
- \`string\`: Text value
- \`number\`: Numeric value
- \`boolean\`: True/false
- \`array\`: List of values
- \`object\`: Structured data

## Constraints

Constraints limit what the agent can do:

\`\`\`yaml
constraints:
  - name: constraint_name
    description: Human-readable description
    condition: "context.value < 1000"  # Optional condition
    enforcement: strict | warn | block
\`\`\`

### Enforcement Levels
- **strict**: Fail if violated
- **warn**: Log warning but continue
- **block**: Prevent action entirely

## Goals

Goals guide the agent's reasoning:

\`\`\`yaml
goals:
  - Primary objective description
  - Secondary objective
  - Behavioral guidance
\`\`\`

## Debugging Tips

### Tool Not Being Called
- Check tool description - LLM must understand when to use it
- Verify parameters match what tool expects
- Look for \`decision\` trace events to see LLM reasoning

### Constraint Violations
- Check \`constraint_check\` trace events
- Review constraint conditions
- Verify context has expected values
`;

// =============================================================================
// SUPERVISOR AGENTS
// =============================================================================

export const ABL_SUPERVISOR = `# Supervisor Agents

Supervisor agents manage and delegate to specialized child agents.
They are ideal for complex systems with multiple domains.

## Structure

\`\`\`yaml
agent:
  name: customer_service_supervisor
  type: supervisor
  model: claude-3-5-sonnet

  system_prompt: |
    You are a customer service supervisor. Route customer
    requests to the appropriate specialist.

  agents:
    - name: billing_agent
      path: ./billing-agent.yaml
      description: Handles billing and payment issues

    - name: technical_agent
      path: ./technical-agent.yaml
      description: Handles technical support

    - name: sales_agent
      path: ./sales-agent.yaml
      description: Handles sales inquiries

  routing:
    strategy: llm | rules | hybrid

    rules:
      - pattern: "bill|payment|charge|invoice"
        delegate_to: billing_agent
      - pattern: "error|bug|crash|not working"
        delegate_to: technical_agent
      - pattern: "buy|purchase|pricing|plan"
        delegate_to: sales_agent

    default: technical_agent

  escalation:
    - condition: agent_stuck
      action: retry_with_context
    - condition: user_frustrated
      action: human_handoff
\`\`\`

## Child Agent Configuration

\`\`\`yaml
agents:
  - name: unique_name
    path: ./path/to/agent.yaml  # Or inline definition
    description: When to use this agent
    context_mapping:
      # Pass context to child
      customer_id: "{{context.user.id}}"
\`\`\`

## Routing Strategies

### llm (Default)
LLM decides which agent to use based on descriptions.
\`\`\`yaml
routing:
  strategy: llm
\`\`\`

### rules
Pattern matching routes to agents.
\`\`\`yaml
routing:
  strategy: rules
  rules:
    - pattern: "regex pattern"
      delegate_to: agent_name
\`\`\`

### hybrid
Rules first, LLM as fallback.
\`\`\`yaml
routing:
  strategy: hybrid
  rules:
    - pattern: "known pattern"
      delegate_to: agent_name
  fallback: llm
\`\`\`

## Escalation Handling

\`\`\`yaml
escalation:
  - condition: agent_stuck
    action: retry_with_context | escalate_up | human_handoff
  - condition: max_turns_exceeded
    action: summarize_and_handoff
\`\`\`

### Conditions
- \`agent_stuck\`: Child agent cannot progress
- \`user_frustrated\`: Detected user frustration
- \`max_turns_exceeded\`: Too many back-and-forth
- \`constraint_violated\`: Child violated constraint

## Debugging Tips

### Wrong Agent Selected
- Check \`delegate_start\` trace events
- Review routing rules and patterns
- Verify agent descriptions are clear

### Escalation Cascade
- Look for multiple \`escalation\` events
- Check if any agent can handle the request
- May need to add fallback handling
`;

// =============================================================================
// TRACE EVENTS
// =============================================================================

export const TRACE_EVENTS = `# Trace Event Reference

Trace events record everything that happens during agent execution.
Understanding these events is key to effective debugging.

## Event Types

### Agent Lifecycle

| Event | Description |
|-------|-------------|
| \`agent_enter\` | Agent started processing |
| \`agent_exit\` | Agent finished processing |

### Flow Events (Scripted Agents)

| Event | Description |
|-------|-------------|
| \`flow_step_enter\` | Entered a flow step |
| \`flow_step_exit\` | Exited a flow step |
| \`flow_transition\` | Transitioned between steps |

### ABL Operations

| Event | Description |
|-------|-------------|
| \`dsl_collect\` | Collecting field from user |
| \`dsl_prompt\` | Sending prompt to user |
| \`dsl_respond\` | Sending response to user |
| \`dsl_set\` | Setting context value |
| \`dsl_call\` | Calling a tool |
| \`dsl_on_input\` | Processing user input |

### LLM Interactions

| Event | Description |
|-------|-------------|
| \`llm_call\` | Called the language model |
| \`decision\` | LLM made a decision |

### Tool Operations

| Event | Description |
|-------|-------------|
| \`tool_call\` | Tool was invoked |

### Delegation (Supervisors)

| Event | Description |
|-------|-------------|
| \`delegate_start\` | Started delegating to child agent |
| \`delegate_complete\` | Child agent finished |
| \`handoff\` | Handed off to another agent |
| \`escalation\` | Escalated from child agent |

### Engine Decisions

| Event | Description |
|-------|-------------|
| \`completion_check\` | Evaluated a COMPLETE condition. Fields: \`condition\`, \`result\`, \`source\` (loop_back_pre_advance, terminal_step, explicit_complete_step, post_turn_eval), \`currentStep\`, \`nextStep\` |
| \`engine_decision\` | Engine made a routing decision. Fields: \`decision\` (auto_advance, skip_completion_check), \`reason\`, \`fromStep\`, \`toStep\`, \`chainDepth\` |
| \`handoff_condition_check\` | Evaluated a handoff routing condition |
| \`thread_return\` | Child agent returned control to parent |

### Validation

| Event | Description |
|-------|-------------|
| \`constraint_check\` | Validated a constraint |
| \`constraint_violation\` | A constraint was violated |
| \`error\` | An error occurred |
| \`warning\` | A non-fatal warning |

### Runtime Events

| Event | Description |
|-------|-------------|
| \`user_message\` | Incoming user message |
| \`data_stored\` | Data persisted to context |
| \`digression\` | Intent-based digression triggered |
| \`sub_intent\` | Sub-intent detected |
| \`correction\` | User corrected a previously set value |

## Event Structure

\`\`\`json
{
  "type": "flow_step_enter",
  "timestamp": "2024-01-15T12:34:56.789Z",
  "sessionId": "session_abc123",
  "agentName": "booking_agent",
  "data": {
    "stepName": "collect_info",
    "previousStep": "greeting"
  },
  "spanId": "span_xyz",
  "parentSpanId": "span_parent"
}
\`\`\`

## Debugging Patterns

### Finding Why Agent Is Stuck

1. Filter for \`flow_step_enter\` events
2. Look for repeating step names
3. Check \`dsl_collect\` events - are fields being captured?
4. Check transitions - what condition is failing?

### Tracking Tool Failures

1. Filter for \`tool_call\` events
2. Check the \`success\` field
3. Look for following \`error\` events
4. Review tool input parameters

### Understanding LLM Decisions

1. Filter for \`decision\` events
2. Review \`reasoning\` field
3. Check what context was available
4. Compare with \`llm_call\` prompts

### Diagnosing Premature Completion

When an agent completes before executing all expected steps:

1. Filter for \`completion_check\` events where \`result: true\`
2. Check the \`source\` field — tells you WHERE the completion fired:
   - \`loop_back_pre_advance\`: Fired during a loop-back transition (expected)
   - \`terminal_step\`: Fired at a step with no THEN (may be premature)
   - \`explicit_complete_step\`: Fired at a COMPLETE step
   - \`post_turn_eval\`: Fired after a reasoning turn
3. Check \`currentStep\` — the step where completion triggered
4. Use \`kore_analyze_session\` — it detects premature completion automatically via \`flowPath.skippedSteps\`

**Common cause**: A COMPLETE condition like \`x IS SET OR true\` evaluates to true immediately, firing before later steps execute. The engine skips completion checks during forward-progressing transitions to mitigate this, but loop-back and terminal steps still check.

### Understanding Engine Decisions

Filter for \`engine_decision\` events to see the engine's routing logic:
- \`skip_completion_check\`: Engine skipped completion check because the flow is progressing forward (not looping back)
- \`auto_advance\`: Engine auto-advanced from one step to the next. \`chainDepth\` shows how many steps in the current chain
`;

// =============================================================================
// DEBUGGING GUIDE
// =============================================================================

export const DEBUGGING_GUIDE = `# Agent Debugging Guide

This guide covers common issues and how to diagnose them using trace analysis.

## Quick Diagnosis Checklist

1. **What type of agent?** (scripted/reasoning/supervisor)
2. **What's the current state?** (flow step, context values)
3. **What was the last action?** (trace events)
4. **Are there errors?** (error events, constraint failures)

## Common Issues by Agent Type

### Scripted Agents

#### Issue: Agent stuck in loop
**Symptoms:**
- Same \`flow_step_enter\` event repeating
- User keeps getting same prompt

**Diagnosis:**
1. Check which step is repeating
2. Look at \`dsl_collect\` events - are fields being captured?
3. Check transition conditions

**Solution:**
- Ensure all required fields are being set
- Verify transition conditions can be satisfied
- Add timeout/fallback transition

#### Issue: Skipping steps
**Symptoms:**
- Expected step never entered
- Context missing expected values

**Diagnosis:**
1. Check \`flow_transition\` events
2. Review transition conditions
3. Verify previous step completed

**Solution:**
- Add explicit transitions
- Check condition logic
- Verify on_complete handlers

### Reasoning Agents

#### Issue: Tool not being called
**Symptoms:**
- Agent responds without using tools
- Missing expected data in response

**Diagnosis:**
1. Check \`decision\` events for reasoning
2. Review tool descriptions
3. Verify tool parameters

**Solution:**
- Improve tool descriptions
- Add examples to system prompt
- Check if constraints are blocking

#### Issue: Wrong tool called
**Symptoms:**
- Unexpected tool in traces
- Incorrect results

**Diagnosis:**
1. Review \`tool_call\` events
2. Check \`decision\` reasoning
3. Compare tool descriptions

**Solution:**
- Make tool descriptions more distinct
- Add negative examples
- Improve system prompt guidance

### Supervisor Agents

#### Issue: Wrong agent selected
**Symptoms:**
- \`delegate_start\` shows unexpected agent
- User complaint about wrong handling

**Diagnosis:**
1. Check routing configuration
2. Review agent descriptions
3. Look at \`decision\` events

**Solution:**
- Improve agent descriptions
- Add routing rules for common patterns
- Consider hybrid routing

#### Issue: Escalation loop
**Symptoms:**
- Multiple \`escalation\` events
- No agent handling request

**Diagnosis:**
1. Track escalation chain
2. Check each agent's capabilities
3. Review escalation conditions

**Solution:**
- Add catch-all agent
- Improve individual agent handling
- Add human handoff fallback

## Using Trace Analysis

### Finding Patterns
\`\`\`
# Look for repeating events
traces.filter(t => t.type === 'flow_step_enter')
      .map(t => t.data.stepName)

# Expected: [greeting, collect_info, process, confirm]
# Problem:  [greeting, collect_info, collect_info, collect_info, ...]
\`\`\`

### Checking Context Evolution
\`\`\`
# Track dsl_set events to see how context changes
traces.filter(t => t.type === 'dsl_set')
      .map(t => ({ field: t.data.field, value: t.data.value }))
\`\`\`

### Measuring Performance
\`\`\`
# Check LLM call durations
traces.filter(t => t.type === 'llm_call')
      .map(t => ({ duration: t.data.duration, tokens: t.data.totalTokens }))
\`\`\`

## Best Practices

1. **Start with the error** - Look for \`error\` and \`constraint_check\` failures first
2. **Follow the flow** - Trace step-by-step from entry to issue
3. **Check context** - Many issues stem from missing/wrong context values
4. **Review decisions** - LLM reasoning often reveals the root cause
5. **Compare with expected** - Know what the happy path should look like
`;

// =============================================================================
// CONTEXT REFERENCE
// =============================================================================

export const CONTEXT_REFERENCE = `# Context Reference

Context is the persistent state that agents maintain during a conversation.
Understanding context is essential for debugging.

## Context Structure

\`\`\`json
{
  "user": {
    "input": "latest user message",
    "history": ["previous", "messages"]
  },
  "agent": {
    "name": "agent_name",
    "currentStep": "step_name"
  },
  "collected": {
    "field1": "value1",
    "field2": "value2"
  },
  "tools": {
    "lastResult": { ... },
    "lastError": null
  },
  "custom": {
    // Agent-defined values
  }
}
\`\`\`

## Accessing Context in ABL

### In Templates
\`\`\`yaml
respond: "Hello {{context.collected.name}}!"
\`\`\`

### In Conditions
\`\`\`yaml
transitions:
  - to: next
    when: context.collected.email
\`\`\`

### In Tool Calls
\`\`\`yaml
call: send_email
with:
  to: "{{context.collected.email}}"
  subject: "Confirmation"
\`\`\`

## Context Operations

### Setting Values
\`\`\`yaml
set:
  - key: custom.preference
    value: "{{user.input}}"
\`\`\`

### Checking Values
\`\`\`yaml
when: context.custom.preference == "premium"
\`\`\`

### Clearing Values
\`\`\`yaml
set:
  - key: collected.temp_data
    value: null
\`\`\`

## Common Context Issues

### Field Not Being Set
- Check \`dsl_collect\` events
- Verify field name matches exactly
- Check for validation failures

### Wrong Value Type
- Verify type in collect definition
- Check transformation logic
- Review tool return values

### Context Lost Between Steps
- Context persists across steps
- Check for explicit clearing
- Verify delegate context mapping
`;

// =============================================================================
// YAML FORMAT REFERENCE
// =============================================================================

const YAML_FORMAT = `# YAML Format Reference

ABL supports two source formats: legacy (custom DSL syntax) and YAML.

## File Extensions

- \`.agent.yaml\` — YAML format (recommended)
- \`.agent.abl\` — Legacy format (still supported)

## Structure

A YAML agent file has these top-level keys:

\`\`\`yaml
AGENT: agent_name
DESCRIPTION: What this agent does
GOAL: The agent's primary objective
MODE: reasoning | scripted

TOOLS:
  - name: tool_name
    type: http | lambda | sandbox | mcp
    description: What this tool does
    endpoint: https://api.example.com/action
    method: POST
    parameters:
      param1:
        type: string
        description: Parameter description
        required: true

CONSTRAINTS:
  - Never share sensitive information
  - Always confirm before making changes

FLOW:
  greeting:
    prompt: Welcome the user
    transitions:
      - target: gather_info
        condition: "true"

  gather_info:
    collect:
      - name: user_name
        type: string
        prompt: What is your name?
    transitions:
      - target: process
        condition: context.user_name != ""
\`\`\`

## YAML vs Legacy Syntax

| Feature | YAML | Legacy |
|---------|------|--------|
| Indentation | 2-space YAML standard | Custom section markers |
| Multi-line strings | YAML block scalars (\`|\`, \`>\`) | Backtick blocks |
| Comments | \`#\` prefix | \`//\` prefix |
| Lists | YAML sequences (\`-\`) | Comma-separated or newline |
| Nesting | YAML maps | Indented blocks |

## Auto-Detection

The language service auto-detects format based on content:
- Files starting with \`AGENT:\` followed by YAML structure → YAML
- Files with custom section markers (\`TOOLS:\`, \`FLOW:\` without YAML indentation) → Legacy

Both formats compile to the same intermediate representation (IR).
`;

// =============================================================================
// EXTENSIONS
// =============================================================================

const EXTENSIONS = `# Extensions

ABL agents can be extended through several mechanisms.

## Tool Binding Types

Tools connect agents to external capabilities:

| Type | Description | Use Case |
|------|-------------|----------|
| \`http\` | REST API call | External services, databases |
| \`lambda\` | Serverless function | Custom compute, transformations |
| \`sandbox\` | Isolated code execution | User-provided scripts, code eval |
| \`mcp\` | Model Context Protocol | AI tool ecosystems, IDE integration |

### HTTP Tool Example

\`\`\`yaml
TOOLS:
  - name: get_weather
    type: http
    endpoint: https://api.weather.com/v1/current
    method: GET
    parameters:
      city:
        type: string
        required: true
    headers:
      Authorization: "Bearer \${env.WEATHER_API_KEY}"
\`\`\`

### MCP Tool Example

\`\`\`yaml
TOOLS:
  - name: search_docs
    type: mcp
    server: documentation-server
    description: Search internal documentation
\`\`\`

## Custom CEL Functions

ABL includes built-in CEL functions (see cel-functions topic). Custom functions
can be registered at the platform level for domain-specific operations.

## Middleware Hooks

The runtime supports middleware hooks at these points:
- **Pre-tool**: Before tool execution (validation, logging)
- **Post-tool**: After tool execution (result transformation)
- **Pre-LLM**: Before LLM calls (prompt augmentation)
- **Post-LLM**: After LLM responses (filtering, compliance)

## Guardrails

Input and output guardrails can be configured per agent:
- **Input guardrails**: Validate user messages before processing
- **Output guardrails**: Filter agent responses before delivery
- **Tool guardrails**: Validate tool inputs/outputs
`;

// =============================================================================
// TOOL PATTERNS
// =============================================================================

const TOOL_PATTERNS = `# Tool Patterns

Common patterns for defining and using tools in ABL agents.

## REST API Tool

The most common pattern — call an external HTTP API:

\`\`\`yaml
TOOLS:
  - name: create_ticket
    type: http
    description: Create a support ticket
    endpoint: https://api.ticketing.com/tickets
    method: POST
    parameters:
      title:
        type: string
        required: true
      description:
        type: string
        required: true
      priority:
        type: string
        enum: [low, medium, high]
        default: medium
\`\`\`

## Tool with Result Validation

Use \`success_when\` to define what constitutes a successful tool call:

\`\`\`yaml
TOOLS:
  - name: lookup_order
    type: http
    endpoint: https://api.orders.com/v1/orders/\${orderId}
    method: GET
    success_when: result.status != "not_found"
    parameters:
      orderId:
        type: string
        required: true
\`\`\`

## Tool Error Handling

Define fallback behavior when tools fail:

\`\`\`yaml
FLOW:
  process_payment:
    action: charge_card
    on_error:
      - target: retry_payment
        condition: error.retryable == true
      - target: escalate_to_human
        condition: error.retryable == false
\`\`\`

## Chained Tool Calls

Use flow steps to chain tool calls sequentially:

\`\`\`yaml
FLOW:
  lookup:
    action: find_customer
    transitions:
      - target: enrich
        condition: result.found == true

  enrich:
    action: get_customer_history
    transitions:
      - target: respond
\`\`\`

## Tool Parameter Types

| Type | JSON Schema | ABL Usage |
|------|-------------|-----------|
| \`string\` | \`type: string\` | Text input |
| \`number\` | \`type: number\` | Numeric input |
| \`boolean\` | \`type: boolean\` | True/false flags |
| \`array\` | \`type: array\` | Lists of items |
| \`object\` | \`type: object\` | Nested structures |
| \`enum\` | \`enum: [...]\` | Fixed set of values |

## Security Considerations

- Never embed API keys in DSL — use \`\${env.KEY_NAME}\` references
- Tool endpoints are validated against SSRF blocklists (private IPs blocked)
- Tool execution runs in an isolated context from the engine
- All tool calls are traced with caller identity for audit
`;

// =============================================================================
// BEST PRACTICES
// =============================================================================

const BEST_PRACTICES = `# Best Practices

Guidelines for authoring effective ABL agents.

## Agent Design

**Define a clear GOAL.** The GOAL drives LLM behavior. Be specific:
- Bad: \`Help users\`
- Good: \`Help users troubleshoot network connectivity issues by diagnosing symptoms and suggesting solutions\`

**Choose the right MODE.**
- \`reasoning\`: Agent decides what to do via LLM (most flexible)
- \`scripted\`: Agent follows a predefined flow (most predictable)
- Use \`scripted\` when the conversation has a known structure (forms, wizards, intake flows)
- Use \`reasoning\` when the agent needs to adapt dynamically

## Constraints

**Always add constraints to reasoning agents.** Constraints define boundaries:

\`\`\`yaml
CONSTRAINTS:
  - Only discuss topics related to the agent's domain
  - Never share customer data with unauthorized parties
  - Always confirm destructive actions before executing
  - Limit tool calls to 3 per turn to prevent runaway loops
\`\`\`

## Flow Design

**Keep flows shallow.** Deep nesting makes agents hard to debug:
- Aim for 3-7 flow steps
- Use handoffs to other agents instead of adding more steps

**Always define error transitions:**

\`\`\`yaml
transitions:
  - target: success_step
    condition: result.success == true
  - target: error_step
    condition: result.success == false
\`\`\`

## Gather Fields

**Add validation to every gather field:**

\`\`\`yaml
collect:
  - name: email
    type: string
    prompt: What is your email address?
    validation:
      pattern: "^[^@]+@[^@]+\\\\.[^@]+$"
      message: Please enter a valid email address
\`\`\`

**Use extraction hints for better parsing:**

\`\`\`yaml
collect:
  - name: date
    type: string
    prompt: When would you like to schedule?
    extraction_hints:
      - Accept formats like "tomorrow", "next Monday", "March 15"
      - Convert to ISO 8601 format
\`\`\`

## Handoffs

**Define clear handoff conditions:**

\`\`\`yaml
HANDOFFS:
  - target: billing_agent
    condition: context.topic == "billing"
    description: Transfer to billing specialist

  - target: escalation_agent
    condition: context.sentiment == "frustrated"
    description: Escalate to human support
\`\`\`

## Testing

**Test each flow path.** For scripted agents, verify:
1. Happy path completes successfully
2. Error transitions fire correctly
3. Gather field validation rejects bad input
4. Handoffs route to the correct agent

**Use the test_agent tool** to verify compilation before deployment.

## Performance

- Keep conversation history bounded (configure \`max_messages\`)
- Use specific tool descriptions (helps LLM choose the right tool faster)
- Minimize gather fields per step (1-3 fields, not 10)
- Use \`success_when\` on tools to avoid re-calling failed tools
`;

// =============================================================================
// EXPORTS
// =============================================================================

import { ARCHITECT_DOCS } from './architect.js';
import { CEL_FUNCTIONS_DOCS } from './cel-functions-generated.js';

export const ABL_DOCS: Record<string, string> = {
  overview: ABL_OVERVIEW,
  'yaml-format': YAML_FORMAT,
  scripted: ABL_SCRIPTED,
  reasoning: ABL_REASONING,
  supervisor: ABL_SUPERVISOR,
  context: CONTEXT_REFERENCE,
  'cel-functions': CEL_FUNCTIONS_DOCS,
  extensions: EXTENSIONS,
  'tool-patterns': TOOL_PATTERNS,
  'best-practices': BEST_PRACTICES,
  'trace-events': TRACE_EVENTS,
  debugging: DEBUGGING_GUIDE,
  architect: ARCHITECT_DOCS,
};

/** @deprecated Use ABL_DOCS instead */
export const DSL_DOCS = ABL_DOCS;

export const DOC_TOPICS = Object.keys(ABL_DOCS);

/**
 * Get documentation for a specific topic
 */
export function getDocumentation(topic: string): string | null {
  return ABL_DOCS[topic] || null;
}

/**
 * Search documentation for a term
 */
export function searchDocumentation(query: string): Array<{ topic: string; excerpt: string }> {
  const results: Array<{ topic: string; excerpt: string }> = [];
  const lowerQuery = query.toLowerCase();

  for (const [topic, content] of Object.entries(ABL_DOCS)) {
    const lowerContent = content.toLowerCase();
    const index = lowerContent.indexOf(lowerQuery);

    if (index !== -1) {
      // Extract surrounding context
      const start = Math.max(0, index - 100);
      const end = Math.min(content.length, index + query.length + 100);
      const excerpt =
        (start > 0 ? '...' : '') +
        content.slice(start, end).trim() +
        (end < content.length ? '...' : '');

      results.push({ topic, excerpt });
    }
  }

  return results;
}
