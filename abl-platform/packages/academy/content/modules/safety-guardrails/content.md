# Safety & Guardrails

> **Estimated time**: 30 minutes | **Prerequisites**: Basic ABL agent structure, constraints fundamentals

## Learning Objectives

After completing this module, you will be able to:

- Configure input and output guardrails with appropriate actions (block, warn, redact, escalate)
- Understand the three-tier evaluation model: CEL-based, model-based, and LLM-based checks
- Distinguish between guardrails (content safety) and constraints (business rules)
- Use the pluggable recognizer registry for custom PII detection
- Control guardrail evaluation order with priority settings
- Apply the `redact` action to replace PII in user input before it reaches the LLM

## Why Safety Matters

An agent without safety controls is a liability. Users may inadvertently share sensitive information. The LLM may generate harmful content or leak data it should not reveal. Business rules may be violated if left to the LLM's judgment alone. ABL provides two complementary safety systems: **guardrails** that protect at the content level, and **constraints** that enforce business rules at the logic level.

## Guardrails vs. Constraints

Before diving into the details, it is important to understand the fundamental distinction:

| Feature         | Guardrails                                        | Constraints                        |
| --------------- | ------------------------------------------------- | ---------------------------------- |
| **Purpose**     | Enforce safety and content policies               | Enforce business rules             |
| **Scope**       | LLM input/output content                          | Agent logic and tool execution     |
| **Evaluation**  | Against message text                              | Against session variables and data |
| **Actions**     | block, warn, redact, escalate, fix, reask, filter | RESPOND, ESCALATE, HANDOFF, GOTO   |
| **When to use** | Content moderation, PII detection                 | Policy limits, eligibility checks  |

> **Key Concept**: Guardrails and constraints solve different problems. Guardrails inspect message content (what the user says, what the agent responds) for safety violations. Constraints check session state and business data (account balance, user verification status) for rule violations. A production agent typically needs both: guardrails to protect content, constraints to enforce business logic.

## The Three-Tier Evaluation Model

ABL guardrails use three tiers of evaluation, each with different tradeoffs between speed, cost, and sophistication:

### Tier 1: CEL-Based Checks (Fast, Deterministic)

CEL (Common Expression Language) checks are pattern-based rules that execute instantly without calling any external service. They are ideal for regex-based PII detection, length limits, and blocked-word lists.

```abl
GUARDRAILS:
  ssn_detection:
    kind: input
    check: not_matches_pattern(input, "\\b\\d{3}-\\d{2}-\\d{4}\\b")
    action: redact
    message: "SSN detected and redacted for your security."
    priority: 0

  length_limit:
    kind: output
    check: length(response) < 10000
    action: warn
    message: "Response exceeds recommended length."
    priority: 2
```

### Tier 2: Model-Based Checks (Pre-Trained Safety Models)

Model-based checks use pre-trained classification models (like OpenAI Moderation) to score content against safety categories. They catch nuanced violations that regex cannot detect.

```abl
GUARDRAILS:
  toxicity_detection:
    kind: input
    provider: openai_moderation
    category: hate
    threshold: 0.7
    action: block
    message: "Content flagged for hateful language."
    priority: 1
```

### Tier 3: LLM-Based Checks (Natural Language Evaluation)

LLM-based checks use a natural language prompt evaluated by an LLM. They are the most flexible but also the slowest and most expensive tier.

```abl
GUARDRAILS:
  medical_advice_check:
    kind: output
    llm_check: "Does this response provide specific medical diagnoses or prescribe medication?"
    action: block
    message: "I cannot provide medical diagnoses. Please consult a healthcare professional."
    priority: 3
```

> **Key Concept**: The three tiers form a layered defense. Use CEL checks (Tier 1) as the first line of defense -- they are fast and free. Add model-based checks (Tier 2) for nuanced content classification. Reserve LLM-based checks (Tier 3) for complex, context-dependent evaluations. Stack them by priority so fast checks run first and expensive checks only run when needed.

## The Redact Action: Replacing PII in Input

The `redact` action is particularly powerful for input guardrails. Instead of blocking the message entirely (which frustrates users), it replaces the detected content with a redaction marker and lets the conversation continue:

```abl
GUARDRAILS:
  credit_card_detection:
    kind: input
    check: not_matches_pattern(input, "\\b\\d{4}[- ]?\\d{4}[- ]?\\d{4}[- ]?\\d{4}\\b")
    action: redact
    message: "Credit card number detected and redacted for your security."
    priority: 0
```

> **Key Concept**: When the `redact` action fires on an input guardrail, the PII is **replaced in the input before it reaches the LLM**. The LLM never sees the original credit card number or SSN -- it receives the sanitized version. This protects against both data leakage to the model provider and accidental reflection of sensitive data in responses.

The full set of guardrail actions:

| Action     | Behavior                                                                             |
| ---------- | ------------------------------------------------------------------------------------ |
| `block`    | Reject the content entirely -- message is discarded (input) or withheld (output)     |
| `warn`     | Allow the content through but emit a warning event for monitoring                    |
| `redact`   | Replace offending content with a redaction marker and continue                       |
| `escalate` | Trigger human escalation for review                                                  |
| `fix`      | Automatically repair content using a fix strategy (truncate, strip_html, redact_pii) |
| `reask`    | Reject LLM output and re-prompt with additional guidance                             |
| `filter`   | Remove offending portions while preserving the rest                                  |

## Priority Ordering for Guardrails

Guardrails are evaluated in order of `priority` -- lower values run first. A `block` action from any guardrail stops further evaluation. `warn` actions do not stop evaluation; subsequent guardrails continue to run.

```abl
GUARDRAILS:
  harmful_content:
    kind: input
    check: not_contains_harmful_instructions(text)
    action: escalate
    priority: 0

  profanity_filter:
    kind: input
    check: not_contains_blocked_words(input)
    action: block
    message: "Please keep our conversation respectful."
    priority: 1

  topic_check:
    kind: input
    llm_check: "Is this message related to customer support?"
    action: block
    message: "I can only help with support questions."
    priority: 2
```

> **Key Concept**: Priority ordering determines evaluation sequence. In this example, harmful content detection (priority 0) runs first as the most critical check. If it escalates, the other guardrails still run. Profanity filtering (priority 1) runs next -- if it blocks, the topic check (priority 2) never executes. Design your priority chain so that fast, critical checks run first and expensive LLM-based checks run last.

## Application Points

The `kind` property determines when the guardrail evaluates:

| Kind          | Evaluation Point                                                  |
| ------------- | ----------------------------------------------------------------- |
| `input`       | Before the user's message reaches the LLM                         |
| `output`      | After the LLM generates a response, before it is sent to the user |
| `both`        | Evaluated on both input and output                                |
| `tool_input`  | Before parameters are sent to a tool call                         |
| `tool_output` | After a tool returns its result                                   |
| `handoff`     | Before context is passed to another agent                         |

Use `kind: both` when the same pattern (like phone numbers) should be detected regardless of direction:

```abl
GUARDRAILS:
  phone_number_check:
    kind: both
    check: not_matches_pattern(text, "\\b\\d{3}[-.]?\\d{3}[-.]?\\d{4}\\b")
    action: warn
    message: "Phone numbers detected. Handle with care."
```

## Output Guardrails

Output guardrails inspect the LLM's response before it reaches the user. They are your last line of defense against data leakage and inappropriate content:

```abl
GUARDRAILS:
  ssn_output_prevention:
    kind: output
    check: not_matches_pattern(response, "\\b\\d{3}-\\d{2}-\\d{4}\\b")
    action: block
    message: "Response blocked: cannot include SSN-like patterns."
    priority: 0

  toxicity_check:
    kind: output
    check: toxicity_score(response) < 0.5
    action: block
    message: "Response blocked due to potential harmful content."
    priority: 1
```

### Fix Strategies for Output Cleanup

Instead of blocking responses outright, use `fix` strategies to automatically repair them:

```abl
GUARDRAILS:
  pii_auto_redact:
    kind: output
    check: not_contains_pii(response)
    action: fix
    fix_strategy: redact_pii
    priority: 0

  html_cleanup:
    kind: output
    check: not_contains_html_tags(response)
    action: fix
    fix_strategy: strip_html
    priority: 1
```

Available fix strategies: `truncate`, `strip_html`, `redact_pii`, `normalize`, and `custom` (with a CEL expression).

## Pluggable Recognizer Registry for Custom PII

The built-in PII detector covers common patterns: email, SSN, credit card (with Luhn validation), US phone numbers, and IPv4 addresses. But your domain may have additional PII patterns that need detection.

> **Key Concept**: The pluggable recognizer registry lets you register custom PII recognizers beyond the built-in patterns. The registry accepts three tiers: `regex` (built-in, fast pattern matching), `ml` (NER-based machine learning models), and `custom` (domain-specific patterns). This is how you add detection for formats like American Express cards (15-digit starting with 34/37), E.164 international phone numbers, IPv6 addresses, or IBAN account numbers.

Custom recognizers are configured through the `builtin_pii` adapter type in your guardrail provider settings. This allows organizations to extend PII detection without modifying the core platform.

## Graduated Severity Actions

For nuanced enforcement, use `severity_actions` to apply different actions based on violation severity:

```abl
GUARDRAILS:
  content_safety:
    kind: output
    provider: openai_moderation
    threshold: 0.5
    action: warn
    severity_actions:
      low: warn
      medium: reask
      high: block
    message: "Content flagged by safety model."
```

Low-severity violations get warnings (logged but not shown). Medium violations trigger a re-prompt. High-severity violations are blocked entirely.

## Streaming Guardrails

For streaming responses, guardrails can evaluate content as it is generated rather than waiting for the complete response:

```abl
GUARDRAILS:
  realtime_safety:
    kind: output
    provider: openai_moderation
    threshold: 0.8
    action: block
    streaming: true
    streaming_interval: sentence
    message: "Response generation halted due to safety concern."
```

When a streaming guardrail triggers, response generation stops immediately and the `message` is sent to the user.

## Constraints: Business Rule Enforcement

While guardrails protect content, constraints enforce business rules. They are deterministic checks evaluated by the runtime -- not suggestions to the LLM.

```abl
CONSTRAINTS:
  always:
    - REQUIRE customer_verified == true
      ON_FAIL: "Please verify your identity first."

  pre_booking:
    - REQUIRE amount <= available_balance
      ON_FAIL: "Insufficient funds. Available: {{available_balance}}."

    - RESTRICT beneficiary_country IN ["CU", "IR", "KP", "SY"]
      ON_FAIL: "Transfers to that destination are prohibited."
```

`REQUIRE` asserts a condition must be true (fails when false). `RESTRICT` asserts something is forbidden (fails when true). Constraints can respond with messages, escalate to humans, hand off to other agents, or redirect to specific flow steps.

## Layered Defense: Putting It All Together

A production agent combines guardrails and constraints into multiple layers:

```abl
AGENT: Safe_Assistant
GOAL: "Help customers with account inquiries"

GUARDRAILS:
  # Layer 1: Block harmful instructions (CEL, fast)
  prompt_injection:
    kind: input
    check: not_contains_harmful_instructions(input)
    action: block
    message: "Message blocked for security reasons."
    priority: 0

  # Layer 2: Redact PII from input (CEL, fast)
  ssn_detection:
    kind: input
    check: not_matches_pattern(input, "\\b\\d{3}-\\d{2}-\\d{4}\\b")
    action: redact
    message: "SSN redacted for your security."
    priority: 0

  # Layer 3: Block PII in output (CEL, fast)
  ssn_output_prevention:
    kind: output
    check: not_matches_pattern(response, "\\b\\d{3}-\\d{2}-\\d{4}\\b")
    action: block
    message: "Response blocked: contains sensitive data."
    priority: 0

  # Layer 4: Content moderation (Model-based)
  toxicity_check:
    kind: output
    check: toxicity_score(response) < 0.5
    action: block
    message: "Response blocked due to harmful content."
    priority: 1

CONSTRAINTS:
  always:
    - REQUIRE user_verified == true
      ON_FAIL: "Please verify your identity first."

  pre_action:
    - REQUIRE request_count <= 100
      ON_FAIL: "Maximum requests reached for this session."
```

## Guardrail Policies

For organization-wide enforcement, create guardrail policies that apply across agents:

```bash
curl -X POST /api/projects/:projectId/guardrail-policies \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "name": "Production Safety Policy",
    "settings": {
      "enableInputGuardrails": true,
      "enableOutputGuardrails": true,
      "rules": [
        {"name": "pii_ssn", "kind": "input", "pattern": "...", "action": "redact"},
        {"name": "credit_card", "kind": "input", "pattern": "...", "action": "redact"}
      ]
    },
    "budget": {
      "maxEvalsPerMinute": 100,
      "maxCostPerDay": 10.0
    }
  }'
```

Budget controls prevent runaway costs -- when exceeded, guardrails fall back to pattern-based checks only.

## Key Takeaways

- The `redact` action replaces PII in input before it reaches the LLM, protecting against data leakage without blocking the conversation
- The three-tier evaluation model (CEL, model-based, LLM-based) provides layered defense -- use fast CEL checks first, expensive LLM checks last
- Guardrails protect content (input/output text); constraints enforce business rules (session state and data) -- a production agent needs both
- The pluggable recognizer registry extends built-in PII detection with custom regex, ML, and domain-specific recognizers
- Priority ordering controls evaluation sequence -- lower values run first, and a `block` action stops further evaluation

## What's Next

With safety controls in place, learn how to systematically measure your agent's quality in the **Testing & Evaluation** module, or explore how constraints interact with memory in the **Memory & State** module.
