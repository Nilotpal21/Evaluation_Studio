# Error Handling Guide — Customizing Agent Error Behavior

This guide shows agent authors how to customize what users see (and how the agent recovers) when something goes wrong. The platform produces sensible defaults out of the box; this guide is for authors who want domain-specific or branded error UX.

There are three places to customize, in order of specificity:

1. **`MESSAGES:`** — override the user-facing fallback text. The lightest customization.
2. **Agent-level `ON_ERROR:`** — handler list that matches by error type AND optional subtype, with actions: respond, retry, hand off, escalate, backtrack.
3. **Step-level `ON_ERROR:`** — same shape, scoped to one flow step. Most specific.

For handing off to another agent or escalating to a human from inside an error handler, see also the [Handoff Guide](handoff-guide.md).

---

## Table of Contents

1. [The error taxonomy — types and subtypes](#1-the-error-taxonomy)
2. [Layer 1 — `MESSAGES:` block](#2-layer-1--messages-block-lightweight-per-error-fallback)
3. [Layer 2 — Agent-level `ON_ERROR:`](#3-layer-2--agent-level-on_error-typed-handlers-with-actions)
4. [Layer 3 — Step-level `ON_ERROR:`](#4-layer-3--step-level-on_error-per-flow-step-overrides)
5. [The `default_handler` — agent-wide catch-all](#5-the-default_handler--agent-wide-catch-all)
6. [Retry strategies](#6-retry-strategies)
7. [Resolution precedence — the full chain](#7-resolution-precedence--the-full-chain)
8. [Worked examples](#8-worked-examples)
9. [What stays the same (zero-regression promise)](#9-what-stays-the-same-zero-regression-promise)

---

## 1. The error taxonomy

When the runtime catches an exception during an agent turn, it classifies the error into a **type** and (often) a **subtype**. Authors match against these in `ON_ERROR:` handlers and `MESSAGES:` keys.

### Type: `llm_error`

The LLM provider returned an error or a non-success stop reason. Subtypes:

| Subtype                | Real-world cause                                                                                                        | Message key (overridable)        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `content_filter`       | Provider's content safety policy blocked the prompt or output (Azure OpenAI, OpenAI moderation, Anthropic safety, etc.) | `error_llm_content_filter`       |
| `rate_limited`         | Provider returned 429 / quota / billing limit                                                                           | `error_llm_rate_limited`         |
| `timeout`              | Provider didn't respond in time                                                                                         | `error_llm_timeout`              |
| `context_exceeded`     | Conversation history exceeds the model's context window                                                                 | `error_llm_context_exceeded`     |
| `api_error`            | Generic provider error (5xx, malformed responses)                                                                       | `error_llm_api_error`            |
| `credential_not_found` | API key invalid, missing, or expired                                                                                    | `error_llm_credential_not_found` |

### Type: `tool_error`

A tool invocation failed. Subtypes are emitted by the platform's tool error classifier (`tool-error-classifier.ts`):

| Subtype         | Real-world cause                                                  | Retryable?                   |
| --------------- | ----------------------------------------------------------------- | ---------------------------- |
| `rate_limit`    | HTTP 429 from the tool / "too many requests" / rate-limit text    | Yes                          |
| `auth_failure`  | HTTP 401/403, "unauthorized", "forbidden"                         | No                           |
| `network_error` | DNS, ECONNREFUSED, socket error, network unreachable              | Yes                          |
| `tool_timeout`  | Tool didn't respond within its configured timeout                 | Yes                          |
| _(no subtype)_  | Anything else (generic 4xx, 5xx, schema mismatch, internal error) | Varies — depends on producer |

Per-tool message keys: `error_tool_timeout`, `error_tool_error` (existing platform defaults).

### Type: `validation_error`

User input didn't match a `GATHER` schema (wrong format, missing required field, regex mismatch). Common subtype:

| Subtype                | Real-world cause                                                    |
| ---------------------- | ------------------------------------------------------------------- |
| `max_retries_exceeded` | The user repeatedly failed validation past the field's retry budget |

Message key: `error_validation` (existing platform default).

### Type: `constraint_violation`

A `CONSTRAINTS:` rule failed. Example: the agent tried to dispatch a payment without first collecting confirmation, and a CONSTRAINTS rule blocks the action.

Message key: `error_constraint` (existing platform default).

### Type: `memory_error`

The session memory subsystem failed (Redis unavailable, vault unreachable, etc.).

Message key: `error_memory` (existing platform default).

### Type: `unknown_error`

Anything that doesn't match the above. The platform tries to never reach this — but as a safety net, authors can always write an `unknown_error` handler to catch everything.

Message key: `error_unknown` (existing platform default).

### Backwards compatibility note

Agents that pre-date the LLM-subtype taxonomy may have an `unknown_error` handler that implicitly caught LLM errors. **That continues to work.** When an LLM error fires and no `llm_error` handler matches, the runtime falls through to `unknown_error` handler lookup before reaching the default. Nothing existing breaks.

---

## 2. Layer 1 — `MESSAGES:` block (lightweight per-error fallback)

The `MESSAGES:` block is the existing top-level agent section for overriding user-facing text. It has supported many generic keys for some time (`error_default`, `voice_error`, `greeting`, `gather_prompt`, etc.); this guide also describes the **subtype-aware keys** the platform now resolves when an error has a subtype.

### Syntax

```abl
AGENT Payment_Details_Agent:
  GOAL: "Help users update their payment information."

  MESSAGES:
    # Generic fallback for any error not handled elsewhere
    error_default:               "Sorry, something went wrong. Could you try that again?"

    # Per-error-class overrides
    error_validation:            "That doesn't look right. Could you double-check the format?"
    error_constraint:            "I can't proceed with that request right now."
    error_memory:                "I'm having trouble accessing some context — let's continue anyway."
    error_unknown:               "An unexpected issue came up. Let me try another way."

    # LLM error subtype overrides (matched when type=llm_error has a subtype)
    error_llm_content_filter:    "I can't help with that specific request. Could you rephrase it?"
    error_llm_rate_limited:      "I'm getting a lot of requests right now. Please try again in a moment."
    error_llm_timeout:           "That took longer than expected. Could you try again?"
    error_llm_context_exceeded:  "We've covered a lot — let's start a new session to continue."
    error_llm_api_error:         "I'm having some technical difficulties. Please try again."

    # Tool error overrides (existing keys, not subtype-specific)
    error_tool_timeout:          "One of our systems is slow right now. Let me try a different approach."
    error_tool_error:            "I encountered an issue. Let me try again."

    # Voice-channel fallbacks
    voice_error:                 "Sorry, please repeat that."
    voice_repeat:                "Could you say that again?"
    voice_nomatch:               "I didn't understand. Could you rephrase?"
    voice_noinput:               "I didn't hear anything. Are you still there?"
```

### Full inventory of error-related platform message keys

These keys are recognized by the platform today (defaults in `packages/compiler/src/platform/constants.ts`):

| Key                              | Used when                                                      |
| -------------------------------- | -------------------------------------------------------------- |
| `error_default`                  | No more specific handler matched and no subtype key is defined |
| `error_validation`               | A `validation_error` falls through to defaults                 |
| `error_constraint`               | A `constraint_violation` falls through to defaults             |
| `error_delegation`               | A delegate-to-agent call failed                                |
| `error_handoff`                  | A handoff failed                                               |
| `error_memory`                   | A `memory_error` falls through to defaults                     |
| `error_tool_timeout`             | A tool call timed out and falls through to defaults            |
| `error_tool_error`               | A tool call failed with a non-timeout error                    |
| `error_llm_content_filter`       | LLM content-filter (NEW; opt-in subtype key)                   |
| `error_llm_rate_limited`         | LLM rate limit (NEW; opt-in subtype key)                       |
| `error_llm_timeout`              | LLM timeout                                                    |
| `error_llm_context_exceeded`     | LLM context exceeded (NEW; opt-in subtype key)                 |
| `error_llm_api_error`            | LLM generic API error (NEW; opt-in subtype key)                |
| `error_llm_credential_not_found` | LLM credentials invalid (NEW; opt-in subtype key)              |
| `error_llm_error`                | LLM error fallback (pre-subtype; still used)                   |
| `error_unknown`                  | Truly unclassified errors                                      |
| `voice_error`                    | Voice-channel error fallback                                   |

If you customize **nothing**, the platform defaults apply unchanged.

---

## 3. Layer 2 — Agent-level `ON_ERROR:` (typed handlers with actions)

The `ON_ERROR:` block matches errors by type / subtype and lets you pick an action.

### Syntax — match by type only

```abl
AGENT Payment_Details_Agent:
  GOAL: "..."

  ON_ERROR:
    tool_error:
      RESPOND: "Let me try that another way."
      RETRY: 1
      THEN: CONTINUE

    validation_error:
      RESPOND: "That doesn't look right. Could you double-check the format?"
      THEN: CONTINUE

    constraint_violation:
      RESPOND: "I can't do that under our policies. Let me know how else I can help."
      THEN: CONTINUE

    llm_error:
      RESPOND: "I'm having trouble responding. Please try again."
      THEN: CONTINUE
```

### Syntax — match by type + subtype

Use the `SUBTYPE:` (single) or `SUBTYPES:` (list) field. The runtime picks the most specific match first.

```abl
ON_ERROR:
  # Most specific — content filter
  llm_error:
    SUBTYPE: content_filter
    RESPOND: "I can't help with that. Could you ask in a different way?"
    THEN: CONTINUE

  # Match either rate-limit OR timeout
  llm_error:
    SUBTYPES: [rate_limited, timeout]
    RESPOND: "I'm a bit slow right now. Give me a moment and try again."
    RETRY: 1
    RETRY_DELAY: 2000
    THEN: CONTINUE

  # Context exceeded — hand off to a fresh-session agent
  llm_error:
    SUBTYPE: context_exceeded
    HANDOFF: New_Session_Greeter

  # Catch-all for any other LLM error
  llm_error:
    RESPOND: "Something went wrong on the AI side. Please try again."
    THEN: CONTINUE

  # Tool subtypes
  tool_error:
    SUBTYPE: rate_limit
    RESPOND: "One of our systems is throttled. One moment."
    RETRY: 2
    RETRY_DELAY: 1000
    RETRY_MAX_DELAY: 8000
    THEN: CONTINUE

  tool_error:
    SUBTYPE: auth_failure
    ESCALATE: "tool credentials need refresh"

  tool_error:
    SUBTYPE: tool_timeout
    RESPOND: "That took too long. Let me try a different approach."
    RETRY: 1
    THEN: CONTINUE
```

### Actions

Inside any handler, you can use:

| Field                                           | Effect                                                                                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `RESPOND:` (text)                               | Reply to the user with the given text. Often combined with `THEN:`.                                                                          |
| `RETRY:` (integer)                              | Retry the failed operation N times. Combine with `RETRY_DELAY:` for backoff.                                                                 |
| `RETRY_DELAY:` (ms)                             | Initial delay between retries.                                                                                                               |
| `RETRY_MAX_DELAY:` (ms)                         | Cap for exponential backoff. With `RETRY:` and `RETRY_DELAY:`, delays grow `delay * 2^attempt` capped at `RETRY_MAX_DELAY`.                  |
| `HANDOFF:` (agent name)                         | Route the user to a different agent. See [Handoff Guide](handoff-guide.md).                                                                  |
| `ESCALATE:` (reason text)                       | Mark the session for human pickup. See [Handoff Guide](handoff-guide.md).                                                                    |
| `BACKTRACK_TO:` (step name)                     | Return to a prior flow step and re-execute. Valid inside step-level `ON_ERROR:` only.                                                        |
| `THEN:` (`CONTINUE` / `COMPLETE` / `BACKTRACK`) | What the runtime does after the action. `CONTINUE` keeps the turn going; `COMPLETE` ends the conversation; `BACKTRACK` goes to a prior step. |

---

## 4. Layer 3 — Step-level `ON_ERROR:` (per-flow-step overrides)

For scripted (FLOW-based) agents, each step can declare its own `ON_ERROR:` that **overrides** the agent-level handlers for errors raised inside that step.

```abl
FLOW:
  STEPS:
    - name: lookup_account
      CALL: account_lookup_tool
      ON_ERROR:
        tool_error:
          SUBTYPE: tool_timeout
          RESPOND: "Account lookup is slow today. Let me check on this manually."
          HANDOFF: Live_Agent

        tool_error:
          SUBTYPE: auth_failure
          ESCALATE: "account-lookup credentials need refresh"

        tool_error:
          RESPOND: "I'm having trouble pulling up your account."
          RETRY: 2
          RETRY_DELAY: 1500
          THEN: BACKTRACK
          BACKTRACK_TO: collect_account_id

    - name: confirm_payment
      RESPOND: "Confirm payment of {{amount}}?"
      ...
```

Step-level handlers are scoped: an `ON_ERROR:` on `lookup_account` doesn't affect errors that arise in `confirm_payment`.

Step-level handlers take precedence over agent-level handlers for errors that occur during that step.

---

## 5. The `default_handler` — agent-wide catch-all

`ON_ERROR:` lets you also define a `default_handler` that fires when no other handler matches. Useful when you want a richer fallback than `MESSAGES.error_default` (e.g., a handoff or retry).

```abl
AGENT Payment_Details_Agent:
  ON_ERROR:
    llm_error:
      SUBTYPE: content_filter
      RESPOND: "I can't help with that. Could you rephrase?"
      THEN: CONTINUE

    # Catch-all when nothing more specific matched
    default_handler:
      RESPOND: "Something unexpected came up. Let me transfer you to a teammate."
      HANDOFF: Live_Agent
```

If both a typed handler and `default_handler` could match, typed wins.

---

## 6. Retry strategies

Many tool and LLM errors are retryable (rate-limits, timeouts, transient network errors). Configure retries inside any handler with three fields:

| Field              | Default  | Notes                                                                                   |
| ------------------ | -------- | --------------------------------------------------------------------------------------- |
| `RETRY:`           | 0        | Maximum number of retry attempts before giving up.                                      |
| `RETRY_DELAY:`     | 1000ms   | Initial delay before the first retry.                                                   |
| `RETRY_MAX_DELAY:` | 60_000ms | Upper bound for exponential backoff (delays double each attempt, capped at this value). |

### Examples

**Linear retry, 1 second apart:**

```abl
tool_error:
  SUBTYPE: rate_limit
  RETRY: 3
  RETRY_DELAY: 1000
  THEN: CONTINUE
```

**Exponential backoff (1s → 2s → 4s → 8s, capped at 10s):**

```abl
tool_error:
  SUBTYPE: tool_timeout
  RETRY: 4
  RETRY_DELAY: 1000
  RETRY_MAX_DELAY: 10000
  THEN: CONTINUE
```

**Fail-fast on auth errors (don't retry — they're not transient):**

```abl
tool_error:
  SUBTYPE: auth_failure
  RETRY: 0
  ESCALATE: "credentials need refresh"
```

### Retryable vs non-retryable subtypes

The platform marks subtypes as retryable or not — but author intent always wins. If you set `RETRY: 3` on `tool_error.auth_failure` (default: non-retryable), the runtime honors your retry count. Use this carefully.

---

## 7. Resolution precedence — the full chain

When an error is caught:

```
                         ┌─────────────────────────────────────────┐
Error thrown ─────────►  │ Classify into { type, subtype }         │
                         │   e.g. type: llm_error,                 │
                         │        subtype: content_filter          │
                         │        type: tool_error,                │
                         │        subtype: rate_limit              │
                         └──────────────────┬──────────────────────┘
                                            │
                  ┌─────────────────────────▼──────────────────────────┐
                  │ Step-level ON_ERROR (current flow step)?           │
                  │   - (type + subtype) exact match     → fire        │
                  │   - (type) match, no SUBTYPE field   → fire        │
                  └─────────────────────────┬──────────────────────────┘
                                            │  (no match)
                  ┌─────────────────────────▼──────────────────────────┐
                  │ Agent-level ON_ERROR handlers?                     │
                  │   - (type + subtype) exact match     → fire        │
                  │   - (type) match                     → fire        │
                  │   - Backwards-compat for llm_error:                │
                  │     retry lookup with type:'unknown_error'         │
                  └─────────────────────────┬──────────────────────────┘
                                            │  (no match)
                  ┌─────────────────────────▼──────────────────────────┐
                  │ Agent-level default_handler?                       │
                  │   → fire                                           │
                  └─────────────────────────┬──────────────────────────┘
                                            │  (no match)
                  ┌─────────────────────────▼──────────────────────────┐
                  │ MESSAGES → error_<type>_<subtype>?                 │
                  │   (e.g. error_llm_content_filter)                  │
                  │   → respond with that text                         │
                  └─────────────────────────┬──────────────────────────┘
                                            │  (no key)
                  ┌─────────────────────────▼──────────────────────────┐
                  │ MESSAGES → error_<type>? (e.g. error_validation)   │
                  │   → respond with that text                         │
                  └─────────────────────────┬──────────────────────────┘
                                            │  (no key)
                  ┌─────────────────────────▼──────────────────────────┐
                  │ MESSAGES → error_default?                          │
                  │   → respond with that text                         │
                  └─────────────────────────┬──────────────────────────┘
                                            │  (no key)
                  ┌─────────────────────────▼──────────────────────────┐
                  │ Platform default:                                  │
                  │   "An error occurred. Please try again."           │
                  └────────────────────────────────────────────────────┘
```

---

## 8. Worked examples

### Example A — Financial agent on voice (LLM content filter)

A user on a voice call asks the bank's agent a question that trips Azure OpenAI's content filter.

```abl
AGENT Banking_Agent:
  MESSAGES:
    error_llm_content_filter: "I'm not able to help with that specific question. Let me know how else I can help."
    voice_error:              "Sorry, please rephrase that."

  ON_ERROR:
    llm_error:
      SUBTYPE: content_filter
      RESPOND: "I'm not able to help with that specific question. Let me know how else I can help."
      THEN: CONTINUE

    llm_error:
      SUBTYPE: rate_limited
      RESPOND: "I'm a bit slow right now — give me one moment."
      RETRY: 1
      RETRY_DELAY: 2000
      THEN: CONTINUE
```

**Operator's view (Studio trace):** ERROR event with `code: MODEL_CONTENT_FILTERED` and structured `contentFilterCategories` (jailbreak / hate / violence / etc.).

**User's view (voice):** "I'm not able to help with that specific question. Let me know how else I can help."

### Example B — Customer-service agent with a flaky external system (tool retry + escalation)

```abl
AGENT Order_Lookup_Agent:
  ON_ERROR:
    # Transient — retry quickly
    tool_error:
      SUBTYPES: [rate_limit, network_error, tool_timeout]
      RETRY: 3
      RETRY_DELAY: 1000
      RETRY_MAX_DELAY: 8000
      THEN: CONTINUE

    # Auth — don't retry, escalate immediately
    tool_error:
      SUBTYPE: auth_failure
      ESCALATE: "order-system credentials need refresh"

    # Generic catch-all
    tool_error:
      RESPOND: "Our order system is having trouble. Let me transfer you to a teammate."
      HANDOFF: Live_Agent
```

### Example C — Healthcare intake (validation feedback)

```abl
AGENT Intake_Agent:
  MESSAGES:
    error_validation: "That doesn't match the expected format. Please check and try again."

  ON_ERROR:
    validation_error:
      SUBTYPE: max_retries_exceeded
      RESPOND: "Let me get someone who can help collect this information."
      ESCALATE: "user couldn't provide valid input after multiple attempts"

  FLOW:
    STEPS:
      - name: collect_dob
        GATHER:
          fields: [date_of_birth]
          ON_ERROR:
            validation_error:
              RESPOND: "Please provide your date of birth in MM/DD/YYYY format."
              THEN: BACKTRACK
              BACKTRACK_TO: collect_dob
```

### Example D — Default handler as a graceful net

```abl
AGENT Concierge_Agent:
  ON_ERROR:
    llm_error:
      SUBTYPE: content_filter
      RESPOND: "I can't help with that. Could you rephrase?"
      THEN: CONTINUE

    # Anything else — be honest and offer a human
    default_handler:
      RESPOND: "Something unexpected came up. Let me transfer you to a teammate."
      HANDOFF: Live_Agent
```

---

## 9. What stays the same (zero-regression promise)

If you do not customize anything — no `MESSAGES:` keys, no `ON_ERROR:` handlers — your agent's behavior is exactly the same as before this guide existed:

- Users see `"An error occurred. Please try again."` when an error reaches the default fallback.
- Operators see structured ERROR trace events with classified error codes (and now, for content-filter errors, the structured category data).
- Existing `ON_ERROR:` handlers using legacy `type: tool_error`, `type: validation_error`, `type: unknown_error`, etc. continue to fire as they always did.
- An existing `unknown_error` handler that implicitly caught LLM errors continues to fire for them via the backwards-compatibility fallback pass.

The customization layers above are **opt-in**. They give you finer control when you need domain-specific UX without forcing you to write boilerplate when you don't.

---

## See also

- **[Agent Anatomy](../features/agent-anatomy.md)** — overview of all top-level agent sections, including `MESSAGES:` and `ON_ERROR:`.
- **[Handoff Guide](handoff-guide.md)** — using `HANDOFF:` and `ESCALATE:` actions inside error handlers; agent-to-agent coordination patterns.
- **[Structured Error Framework](../features/structured-error-framework.md)** — platform-wide error taxonomy, trace-event integration, and the ratchet metrics that drive error-handling improvements.
- **[Gather Fields Guide](gather-fields-guide.md)** — validation retry budgets and `max_retries_exceeded` triggering.
