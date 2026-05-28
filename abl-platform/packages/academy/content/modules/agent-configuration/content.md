# Agent Configuration

> **Estimated time**: 30 minutes | **Prerequisites**: ABL Basics module

## Learning Objectives

After completing this module, you will be able to:

- Configure the EXECUTION block with model selection, temperature, token limits, and reasoning iteration caps
- Use the IDENTITY section as a compact alternative to separate GOAL/PERSONA/LIMITATIONS sections
- Set up per-operation model routing to optimize cost and performance across different agent tasks
- Implement ON_ERROR handlers with RETRY and RETRY_BACKOFF strategies for resilient agents
- Understand ACTION_HANDLERS resolution order (step-level, then agent-level, then fallthrough)

## The EXECUTION Block

The EXECUTION block configures how your agent runs at the platform level -- which LLM model to use, how creative its responses should be, how many reasoning cycles to allow, and timeout behavior. Every property is optional; when omitted, the platform applies sensible defaults.

```abl
EXECUTION:
  model: claude-sonnet-4-5-20250929
  temperature: 0.3
  max_tokens: 4096
  max_reasoning_iterations: 15
  tool_timeout: 10000
```

### Core Properties

| Property               | Type             | Default          | Description                                      |
| ---------------------- | ---------------- | ---------------- | ------------------------------------------------ |
| `model`                | string           | Platform default | Primary LLM model identifier                     |
| `temperature`          | number (0.0-1.0) | Platform default | Sampling temperature. Lower = more deterministic |
| `max_tokens`           | number           | Platform default | Maximum tokens in LLM response                   |
| `tool_timeout`         | number (ms)      | Platform default | Timeout for tool execution                       |
| `llm_timeout`          | number (ms)      | Platform default | Timeout for LLM inference calls                  |
| `session_idle_timeout` | number (ms)      | Platform default | Timeout before an idle session expires           |
| `fallback_model`       | string           | None             | Model to use when primary model is unavailable   |

### Preventing Runaway Loops with max_reasoning_iterations

When an agent operates in reasoning mode (no FLOW, or a step with `REASONING: true`), the LLM enters a loop: it reasons about the user's message, decides to call a tool, processes the result, reasons again, possibly calls another tool, and so on. Without a cap, a confused agent could loop indefinitely -- burning tokens and leaving the user waiting.

`max_reasoning_iterations` sets the maximum number of tool-call/response cycles the agent performs before forcing a final response:

```abl
EXECUTION:
  model: claude-sonnet-4-5-20250929
  max_reasoning_iterations: 15
```

> **Key Concept**: Always set `max_reasoning_iterations` in the EXECUTION block to prevent runaway loops. Without this cap, a reasoning agent could cycle through tool calls indefinitely. Start with 10-15 for most agents and tune based on observed behavior. If an agent consistently hits the limit, it may need better INSTRUCTIONS or more focused GOAL text to guide its reasoning.

### Practical Guidelines

- **For focused tasks** (single tool call, simple Q&A): `max_reasoning_iterations: 5`
- **For multi-step reasoning** (research, comparison, analysis): `max_reasoning_iterations: 10-15`
- **For complex orchestration** (multiple tools, chained decisions): `max_reasoning_iterations: 15-20`

### Extended Thinking

Extended thinking allows Claude models to perform internal reasoning before producing a response. This is useful for complex multi-step tasks where the agent needs to plan before acting:

```abl
EXECUTION:
  model: claude-sonnet-4-5-20250929
  enable_thinking: true
  thinking_budget: 8000
```

The `thinking_budget` controls how many tokens the model can use for internal chain-of-thought reasoning before producing the visible response.

### Context Compaction

As conversations grow, the context window fills with message history. Context compaction automatically summarizes older messages when usage exceeds a threshold:

```abl
EXECUTION:
  compaction_threshold: 0.75
```

When the ratio of used tokens to available tokens exceeds 0.75, the runtime compacts older conversation history into a summary, freeing space for new messages while preserving essential context.

## The IDENTITY Block: A Compact Alternative

The IDENTITY section is an alternative, structured format that combines role, persona, expertise, and limitations into a single block. When used, its fields are mapped to the equivalent top-level sections.

### Standard Style (Separate Sections)

```abl
AGENT: Hotel_Search

GOAL: |
  Help the customer find and book a hotel that matches their preferences,
  budget, and travel dates.

PERSONA: |
  Enthusiastic travel advisor who knows every major hotel chain and
  boutique property. Provides honest comparisons and highlights
  trade-offs between price, location, and amenities.

LIMITATIONS:
  - "Cannot guarantee room availability"
  - "Cannot process payments directly"
```

### Compact Style (Using IDENTITY)

```abl
AGENT: Hotel_Search

IDENTITY:
  role: "Help the customer find and book a hotel matching their preferences"
  persona: "Enthusiastic travel advisor with deep hotel industry knowledge"
  expertise: [hotel chains, boutique properties, price comparison]
  limitations:
    - "Cannot guarantee room availability"
    - "Cannot process payments directly"
```

> **Key Concept**: IDENTITY is an alternative to separate GOAL, PERSONA, and LIMITATIONS sections. When the parser encounters an IDENTITY block, it maps `role` to GOAL, `persona` to PERSONA, `expertise` is appended to the persona, and `limitations` populates LIMITATIONS. You can use either style, but do not mix both -- if both are present, the individual sections take the values set last in document order.

### IDENTITY Field Mapping

| IDENTITY Field | Maps To                | Description                    |
| -------------- | ---------------------- | ------------------------------ |
| `role`         | `GOAL:`                | Sets the goal description      |
| `persona`      | `PERSONA:`             | Sets the persona description   |
| `expertise`    | Appended to `PERSONA:` | Added as "Expertise: ..."      |
| `limitations`  | `LIMITATIONS:`         | Populates the limitations list |

The separate section style is recommended for clarity, especially in complex agents. The IDENTITY block is available as a compact alternative for simpler definitions.

## Per-Operation Model Routing

The `models:` sub-block within EXECUTION allows you to route different operations to different LLM models. This is a powerful cost optimization technique -- use faster, cheaper models for simple tasks and more capable models for complex reasoning.

```abl
EXECUTION:
  model: claude-sonnet-4-5-20250929
  fallback_model: claude-haiku-4-5-20251001
  models:
    extraction: claude-haiku-4-5-20251001
    response_gen: claude-sonnet-4-5-20250929
    reasoning: claude-sonnet-4-5-20250929
    coordination: claude-sonnet-4-5-20250929
```

> **Key Concept**: The `models:` sub-block within EXECUTION enables per-operation model routing. Each operation (extraction, response generation, reasoning, coordination) can use a different LLM model. The top-level `model` property serves as the default for any operation not explicitly listed. This lets you use a cheaper model like Haiku for simple extraction tasks while reserving Sonnet for complex reasoning.

### Recognized Operation Names

| Operation      | Description                                                               | Typical Model Choice  |
| -------------- | ------------------------------------------------------------------------- | --------------------- |
| `extraction`   | Extracting structured data from user messages (e.g., gather field values) | Fast/cheap (Haiku)    |
| `response_gen` | Generating user-facing responses                                          | Balanced (Sonnet)     |
| `reasoning`    | Complex reasoning, planning, and decision-making                          | Capable (Sonnet/Opus) |
| `coordination` | Multi-agent coordination and routing decisions                            | Balanced (Sonnet)     |

Custom operation names are also accepted and resolved at runtime.

### Cost Optimization Example

Consider an agent that collects user data, reasons about it, and responds:

```abl
EXECUTION:
  model: claude-sonnet-4-5-20250929
  models:
    extraction: claude-haiku-4-5-20251001      # Cheap for data extraction
    reasoning: claude-sonnet-4-5-20250929       # Capable for analysis
    response_gen: claude-haiku-4-5-20251001     # Cheap for templated responses
```

Most of this agent's LLM calls are extraction (pulling structured data from user messages) and response generation (formatting results). Only the reasoning step needs a more capable model. This configuration could reduce LLM costs significantly.

## ON_ERROR Handlers

The ON_ERROR block defines error handlers that the runtime routes through when errors occur during execution. These are not just documentation -- they actively intercept errors and determine the agent's recovery behavior.

```abl
ON_ERROR:
  tool_timeout:
    RESPOND: "The banking system is responding slowly. Retrying."
    RETRY: 2
    RETRY_BACKOFF: exponential
    THEN: CONTINUE

  tool_error:
    RESPOND: "I encountered an error. Let me try again."
    RETRY: 1
    THEN: CONTINUE

  llm_error:
    RESPOND: "I'm having trouble processing your request."
    THEN: ESCALATE
```

### Handler Properties

Each error handler can include:

| Property        | Description                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `RESPOND`       | Message sent to the user when the error occurs                                                                                      |
| `RETRY`         | Number of retry attempts before giving up                                                                                           |
| `RETRY_BACKOFF` | Backoff strategy for retries: `exponential`, `linear`, or fixed                                                                     |
| `THEN`          | Action after handling: `CONTINUE` (resume), `ESCALATE` (transfer to human), `HANDOFF` (transfer to agent), `COMPLETE` (end session) |

> **Key Concept**: ON_ERROR handlers with RETRY and RETRY_BACKOFF provide resilient error recovery. When a tool times out, the agent can automatically retry with exponential backoff (1s, 2s, 4s...) instead of immediately failing. The THEN clause determines what happens if all retries are exhausted: CONTINUE to keep going, ESCALATE to a human, or COMPLETE to end the session gracefully.

### Error Types

| Error Type     | Triggered When                                   |
| -------------- | ------------------------------------------------ |
| `tool_timeout` | A tool call exceeds its configured timeout       |
| `tool_error`   | A tool call fails (HTTP error, invalid response) |
| `llm_error`    | The LLM provider fails or returns an error       |

### RETRY_BACKOFF Strategies

| Strategy        | Behavior                                             |
| --------------- | ---------------------------------------------------- |
| `exponential`   | Wait 1s, 2s, 4s, 8s... (doubles each time)           |
| `linear`        | Wait 1s, 2s, 3s, 4s... (increases by a fixed amount) |
| Fixed (default) | Same delay between each retry                        |

### Error Handler Flow

When an error occurs at runtime:

1. The runtime catches the error and classifies it (tool_timeout, tool_error, llm_error)
2. It looks for a matching handler in the ON_ERROR block
3. If found, it executes the RESPOND message, attempts retries with the specified backoff
4. After retries are exhausted (or if RETRY is not set), it executes the THEN action
5. If no handler matches, the error propagates to the caller

## ACTION_HANDLERS

The ACTION_HANDLERS block defines agent-level fallback handlers for interactive actions (buttons, dropdowns, text inputs). When a user interacts with an action element (like clicking a "Confirm" button), the runtime follows a specific resolution order to find the right handler.

```abl
ACTION_HANDLERS:
  confirm_transfer:
    SET: transfer_confirmed = true
    RESPOND: "Transfer confirmed. Processing now."
    THEN: execute_transfer

  cancel_transfer:
    SET: transfer_cancelled = true
    RESPOND: "Transfer cancelled."
    THEN: COMPLETE

  show_details:
    RESPOND: "Here are the full transfer details: {{transfer_summary}}"
```

### Handler Properties

| Property    | Description                                                 |
| ----------- | ----------------------------------------------------------- |
| action ID   | Matches the ID of the interactive action element            |
| `SET`       | Variable assignments when the action fires                  |
| `RESPOND`   | Message sent to the user                                    |
| `THEN`      | Flow step to transition to                                  |
| `condition` | CEL expression -- handler only matches if condition is true |

### Conditional Handlers

You can define multiple handlers for the same action ID with different conditions:

```abl
ACTION_HANDLERS:
  approve:
    condition: "amount < 10000"
    SET: approval_status = "auto_approved"
    RESPOND: "Approved automatically for amounts under $10,000."
    THEN: process_payment

  approve:
    condition: "amount >= 10000"
    SET: approval_status = "pending_review"
    RESPOND: "This amount requires manager approval. Escalating."
    THEN: manager_review
```

### Resolution Order

> **Key Concept**: ACTION_HANDLERS follow a specific resolution order: (1) step-level `on_action` handlers are checked first, (2) agent-level ACTION_HANDLERS are checked if no step-level handler matches, (3) if no handler matches anywhere, the runtime falls through to normal step processing. This means step-level handlers always take priority over agent-level handlers, letting you override behavior for specific flow steps.

## Complete Agent Example

Here is a production-ready agent definition that uses all the configuration features covered in this module:

```abl
AGENT: Wire_Transfer_Specialist
VERSION: "2.0.0"
DESCRIPTION: |
  Processes outbound wire transfers for retail and commercial banking
  customers. Handles domestic and international transfers with
  full regulatory compliance.
LANGUAGE: "en"

GOAL: |
  Process the customer's outbound wire transfer request accurately
  and securely.

PERSONA: |
  Senior wire operations specialist at a large commercial bank -- precise
  with numbers, methodical about compliance steps, and transparent about
  processing times and fees.

LIMITATIONS:
  - "Cannot process wires to OFAC-sanctioned countries"
  - "Cannot override the daily wire transfer limit"
  - "Cannot reverse a wire after execution"

EXECUTION:
  model: claude-sonnet-4-5-20250929
  temperature: 0.1
  max_tokens: 4096
  max_reasoning_iterations: 8
  tool_timeout: 30000
  fallback_model: claude-haiku-4-5-20251001
  models:
    extraction: claude-haiku-4-5-20251001
    response_gen: claude-sonnet-4-5-20250929
    reasoning: claude-sonnet-4-5-20250929

ACTION_HANDLERS:
  confirm_wire:
    SET: wire_confirmed = true
    RESPOND: "Wire transfer confirmed. Processing now."
    THEN: execute_wire

  cancel_wire:
    SET: wire_cancelled = true
    RESPOND: "Wire transfer cancelled."
    THEN: COMPLETE

ON_ERROR:
  tool_timeout:
    RESPOND: "The banking system is responding slowly. Retrying."
    RETRY: 2
    RETRY_BACKOFF: exponential
    THEN: CONTINUE

  tool_error:
    RESPOND: "I encountered an error. Let me try again."
    RETRY: 1
    THEN: CONTINUE

  llm_error:
    RESPOND: "I'm having trouble processing your request."
    THEN: ESCALATE
```

## Common Patterns and Best Practices

**Start with clear GOAL and PERSONA.** The GOAL defines _what_ the agent accomplishes; the PERSONA defines _how_ it communicates. Keep both concise and specific -- vague instructions lead to inconsistent behavior.

**Always cap reasoning iterations.** Set `max_reasoning_iterations` in every agent that uses reasoning mode. Start with 10-15 and tune based on observed behavior.

**Use per-operation routing for cost control.** Route simple operations (extraction, templated responses) to cheaper models. Reserve expensive models for complex reasoning.

**Implement error handlers.** Production agents must handle tool failures gracefully. Always include ON_ERROR handlers with appropriate RETRY strategies for external service calls.

**Use LIMITATIONS for advisory boundaries.** Limitations tell the LLM what the agent cannot do. For hard enforcement, pair them with CONSTRAINTS that have REQUIRE conditions and ON_FAIL actions.

## Key Takeaways

- **max_reasoning_iterations** in the EXECUTION block prevents agents from looping indefinitely through tool-call cycles -- always set this for reasoning agents
- **IDENTITY** is a compact alternative to separate GOAL/PERSONA/LIMITATIONS sections, mapping `role` to GOAL, `persona` to PERSONA, and `limitations` to LIMITATIONS
- The **`models:` sub-block** enables per-operation model routing, letting you use cheaper models for extraction and response generation while reserving capable models for reasoning
- **ON_ERROR** handlers with **RETRY** and **RETRY_BACKOFF** provide automatic error recovery with configurable retry strategies (exponential, linear, fixed)
- **ACTION_HANDLERS** follow a resolution order: step-level first, then agent-level, then fallthrough to normal processing

## What's Next

Move to the **Conversation Flows** module to learn how to build structured step-by-step conversations with FLOW, GATHER, ON_INPUT branching, and tool result handling.
