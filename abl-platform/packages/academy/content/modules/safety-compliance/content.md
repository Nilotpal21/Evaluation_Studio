# Safety & Compliance

> **Estimated time**: 35 minutes | **Prerequisites**: Agent Configuration, Identity & Authentication

## Learning Objectives

After completing this module, you will be able to:

- Distinguish between CONSTRAINT and GUARDRAIL and choose the right one for a given use case
- Create custom regex recognizers for domain-specific PII patterns like American Express card numbers
- Explain how guardrail priority works and why a blocking guardrail prevents lower-priority checks from running
- Describe the platform's SOC 2 Type II compliance posture and what it covers
- Apply the responsible disclosure process including the 2-business-day acknowledgment commitment

## Two Layers of Safety

The Agent Platform provides two distinct mechanisms for enforcing safety and business rules. Understanding which to use when is essential for building robust agent systems.

### Guardrails vs. Constraints

| Feature         | Guardrails                                          | Constraints                                                    |
| --------------- | --------------------------------------------------- | -------------------------------------------------------------- |
| **Purpose**     | Enforce safety and content policies                 | Enforce business rules                                         |
| **Scope**       | LLM input/output content                            | Agent logic and tool execution                                 |
| **Evaluation**  | Against message text                                | Against session variables and data                             |
| **Actions**     | block, warn, redact, escalate, fix, reask, filter   | RESPOND, ESCALATE, HANDOFF, GOTO                               |
| **When to use** | Content moderation, PII detection, prompt injection | Policy limits, eligibility checks, authentication requirements |

> **Key Concept**: Use **GUARDRAIL** for content-level safety -- is this text appropriate? Does it contain PII? Is it a prompt injection attempt? Use **CONSTRAINT** for business-logic safety -- does this user have permission? Is the amount within limits? Has the required data been collected? A GUARDRAIL inspects the text of messages. A CONSTRAINT inspects the state of the conversation (variables, tool results, user attributes).

Here is the distinction in practice:

```abl
# GUARDRAIL: Content-level check -- is the response safe?
GUARDRAILS:
  pii_filter:
    kind: output
    check: not_matches_pattern(response, "\\b\\d{3}-\\d{2}-\\d{4}\\b")
    action: redact
    message: "SSN pattern redacted from response."

# CONSTRAINT: Business-logic check -- is the action allowed?
CONSTRAINTS:
  - REQUIRE estimated_total <= 5000
    ON_FAIL: ESCALATE "Booking exceeds $5000 limit - requires manager approval"
```

The guardrail checks whether the response text contains an SSN pattern. The constraint checks whether a session variable exceeds a business threshold.

## Input Guardrails

Input guardrails intercept user messages before they reach the LLM. They protect against prompt injection, inappropriate content, PII exposure, and off-topic requests.

### Basic Input Guardrail

```abl
GUARDRAILS:
  profanity_filter:
    kind: input
    check: not_contains_blocked_words(input)
    action: block
    message: "Please keep our conversation respectful."
    priority: 1
```

The `check` expression evaluates the incoming message. When it returns `false`, the guardrail fires and the configured action executes.

### Pattern-Based Detection

Use regex patterns to detect specific content:

```abl
GUARDRAILS:
  ssn_detection:
    kind: input
    check: not_matches_pattern(input, "\\b\\d{3}-\\d{2}-\\d{4}\\b")
    action: warn
    message: "Please avoid sharing sensitive information like Social Security numbers."

  credit_card_detection:
    kind: input
    check: not_matches_pattern(input, "\\b\\d{4}[- ]?\\d{4}[- ]?\\d{4}[- ]?\\d{4}\\b")
    action: redact
    message: "Credit card number has been automatically redacted for your security."
```

### Model-Based Content Moderation

Use a moderation provider for AI-powered content classification:

```abl
GUARDRAILS:
  content_safety:
    kind: input
    provider: openai_moderation
    category: hate
    threshold: 0.7
    action: block
    message: "Your message was flagged for potentially harmful content."
    priority: 0
```

### LLM-Based Input Check

Use natural language instructions to have an LLM judge content:

```abl
GUARDRAILS:
  topic_relevance:
    kind: input
    llm_check: |
      Determine if the user's message is related to our product support
      domain. Reject messages about competitors, political topics, or
      requests to generate creative fiction.
    action: block
    message: "I can only help with product-related questions."
    priority: 2
```

## Guardrail Priority and Blocking

Guardrails use the same "lower number = higher precedence" model as routing rules.

> **Key Concept**: When a guardrail with a higher priority (lower number) **blocks** the message, lower-priority guardrails do not execute. This is critical for designing your guardrail stack. A priority-0 harmful content check that blocks will prevent the priority-1 profanity filter and priority-2 topic check from running. Design your priorities so that the most critical safety checks run first, and understand that a blocking action terminates the evaluation chain.

```abl
GUARDRAILS:
  harmful_content:
    kind: input
    check: not_contains_harmful_instructions(text)
    action: escalate
    priority: 0          # Runs first -- if this blocks, nothing else runs

  profanity_filter:
    kind: input
    check: not_contains_blocked_words(input)
    action: block
    priority: 1          # Runs second

  topic_check:
    kind: input
    llm_check: "Is this message related to customer support?"
    action: block
    priority: 2          # Runs third -- only if nothing above blocked
```

If the harmful content check fires at priority 0, the profanity and topic checks are skipped entirely. This makes priority ordering a critical design decision.

## Output Guardrails

Output guardrails inspect the agent's response before it reaches the user, catching PII leaks, toxic content, or policy violations.

```abl
GUARDRAILS:
  ssn_output_filter:
    kind: output
    check: not_matches_pattern(response, "\\b\\d{3}-\\d{2}-\\d{4}\\b")
    action: redact
    message: "SSN pattern redacted from response."
    priority: 0

  credit_card_output_filter:
    kind: output
    check: not_matches_pattern(response, "\\b\\d{4}[- ]?\\d{4}[- ]?\\d{4}[- ]?\\d{4}\\b")
    action: redact
    message: "Credit card number redacted from response."
    priority: 0
```

### Fix Strategy

Instead of blocking, the `fix` action automatically cleans up responses:

```abl
GUARDRAILS:
  pii_auto_redact:
    kind: output
    check: not_contains_pii(response)
    action: fix
    fix_strategy: redact_pii
    priority: 0
```

### Bidirectional Guardrails

Use `kind: both` to apply the same check to input and output:

```abl
GUARDRAILS:
  phone_number_check:
    kind: both
    check: not_matches_pattern(text, "\\b\\d{3}[-.]?\\d{3}[-.]?\\d{4}\\b")
    action: warn
    message: "Phone numbers detected - handle with care."
```

## Custom PII Recognizers

The built-in PII detector covers email, SSN, standard credit cards (with Luhn validation), US phone numbers, and IPv4 addresses. For additional PII patterns, you use the pluggable recognizer registry.

> **Key Concept**: To detect domain-specific PII like American Express card numbers (15 digits starting with 34 or 37), you register a custom regex recognizer in the recognizer registry. The registry accepts three tiers of recognizers: `regex` (built-in, fast pattern matching), `ml` (NER-based machine learning), and `custom` (domain-specific logic). A custom regex recognizer for AmEx cards would match the pattern `\b3[47]\d{13}\b` -- starting with 34 or 37, followed by 13 digits.

The registry supports:

| Tier     | Type             | Best For                                              |
| -------- | ---------------- | ----------------------------------------------------- |
| `regex`  | Pattern matching | Known formats like card numbers, IDs, phone numbers   |
| `ml`     | NER-based        | Names, addresses, and other context-dependent PII     |
| `custom` | Domain-specific  | Proprietary ID formats, industry-specific identifiers |

Additional patterns you can register include E.164 international phone numbers, IPv6 addresses, and IBAN account numbers.

## Business Constraints

Constraints enforce business rules at runtime, preventing the agent from performing actions that violate policies.

### Basic Constraint

```abl
CONSTRAINTS:
  - REQUIRE num_guests <= 10
    ON_FAIL: RESPOND "Sorry, we cannot accommodate more than 10 guests per booking."
  - REQUIRE destination != ""
    ON_FAIL: RESPOND "Please provide a destination first."
```

### Escalation Constraint

```abl
CONSTRAINTS:
  - REQUIRE estimated_total <= 5000
    ON_FAIL: ESCALATE "Booking exceeds $5000 limit - requires manager approval"
```

### Phased Constraints

Organize constraints by conversation phase:

```abl
CONSTRAINTS:
  pre_change:
    - REQUIRE check_trip_status.departure_in_hours > 24
      ON_FAIL: "Changes cannot be made within 24 hours of departure."
    - REQUIRE check_change_eligibility.eligible == true
      ON_FAIL: "This booking cannot be modified."

  always:
    - REQUIRE user.is_authenticated == true
      ON_FAIL: HANDOFF Authentication_Agent
```

The `always` phase runs on every turn. Named phases (like `pre_change`) run when explicitly invoked via `CHECK: pre_change` in a flow step.

### Warning Constraints (Non-Blocking)

Use `WARN` instead of `REQUIRE` to log without blocking:

```abl
CONSTRAINTS:
  - WARN estimated_total > 1000
    ON_FAIL: "Note: this booking exceeds $1,000. Proceeding with reservation."
```

## Compliance Posture

### SOC 2 Type II

> **Key Concept**: The Agent Platform maintains **SOC 2 Type II** compliance, independently audited against the Trust Services Criteria for security, availability, and confidentiality. SOC 2 Type II is significant because it verifies not just that controls exist (Type I) but that they operated effectively over a sustained period. Audit reports are available to customers under NDA upon request.

### GDPR Compliance

The platform is designed to comply with GDPR through:

- **Data minimization** -- Configurable retention periods control how long conversation data is stored
- **Right to erasure** -- Deletion requests cascade through all services, removing user data from active stores, cold storage, knowledge base indexes, and backups
- **Data portability** -- Tenant data can be exported in standard formats through the API
- **DPA availability** -- A Data Processing Agreement is available upon request

### Additional Frameworks

| Framework | Status                                                      |
| --------- | ----------------------------------------------------------- |
| ISO 27001 | Aligned with information security management practices      |
| CCPA      | Compliant with California Consumer Privacy Act requirements |
| HIPAA     | Readiness available on Enterprise plans with BAA            |

## Responsible Disclosure

The platform has a formal vulnerability disclosure program for security researchers.

### Reporting Process

1. Email security@ablplatform.com with a detailed description
2. Include steps to reproduce, potential impact, and any proof-of-concept
3. Do not publicly disclose until a fix is confirmed and disclosure is coordinated

### Platform Commitments

> **Key Concept**: The platform acknowledges receipt of vulnerability reports within **2 business days** and provides an initial assessment within 5 business days. This commitment is part of the responsible disclosure policy. The platform does not pursue legal action against researchers who follow responsible disclosure practices, and credits reporters (with permission) in security advisories.

## Data Protection Practices

### PII Handling in Agents

Agents that handle PII can be configured with redaction policies:

- **PII detection** -- Configurable patterns detect PII in messages and responses
- **PII redaction** -- Detected PII is automatically redacted before storage or display
- **PII audit logging** -- Access to PII-containing data is logged for compliance
- **Output filtering** -- Output guardrails filter PII from responses before delivery

PII redaction is configurable per environment -- disable in development for debugging, enforce in production.

### Data Retention

Each tenant configures a retention period for session data. After the retention window, data is permanently deleted:

- Conversation histories
- Session variables and gathered data
- Trace events and execution logs
- Cold-stored session snapshots

### LLM Provider Data Handling

| Provider     | Data Handling                                       |
| ------------ | --------------------------------------------------- |
| Anthropic    | Does not use API data for training by default       |
| OpenAI       | Enterprise and API accounts have data usage opt-out |
| Azure OpenAI | Data stays within your Azure tenant                 |
| AWS Bedrock  | Data stays within your AWS account                  |

## Workspace Guardrail Policies

For organization-wide enforcement, create guardrail policies managed centrally:

```bash
curl -X POST /api/projects/:projectId/guardrail-policies \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Production Safety Policy",
    "settings": {
      "enableInputGuardrails": true,
      "enableOutputGuardrails": true,
      "rules": [
        {
          "name": "pii_ssn",
          "kind": "input",
          "pattern": "\\b\\d{3}-\\d{2}-\\d{4}\\b",
          "action": "redact"
        }
      ]
    }
  }'
```

When both workspace and project guardrails exist:

- Workspace policies evaluate first
- Project policies add specificity
- The most restrictive action wins

## Key Takeaways

- Use GUARDRAIL for content safety (text inspection) and CONSTRAINT for business rules (variable/state checks) -- they serve different purposes
- Custom regex recognizers extend PII detection for domain-specific patterns like AmEx cards (`\b3[47]\d{13}\b`)
- A blocking guardrail at a higher priority (lower number) prevents all lower-priority guardrails from executing
- SOC 2 Type II compliance means controls are independently verified as effective over time, not just documented
- The responsible disclosure program acknowledges vulnerability reports within 2 business days

## What's Next

Continue to [Encryption & KMS](../encryption-kms/content.md) for data-at-rest protection, or explore [API Fundamentals](../api-fundamentals/content.md) for integrating safety controls into your API workflows.
