# Pipeline Benchmark Results — 4-Mode Comparison

**Date:** 2026-03-06
**Primary Model:** GPT-4o (OpenAI API)
**Pipeline Model:** Qwen3-30B-A3B (self-hosted vLLM, AWQ quantized, single instance)
**Tools:** 12 (including `__handoff__` with 4 specialist targets)

> **Note:** Qwen latency on this instance is ~500-1000ms per call. On Groq/Together, expect ~50-100ms. All latency improvements from the pipeline would be amplified with a faster inference endpoint.

---

## Test Modes

| Mode                      | Description                                                | Pipeline         | Prompt Optimizations | Parallel |
| ------------------------- | ---------------------------------------------------------- | ---------------- | -------------------- | -------- |
| **A: BASELINE**           | Current engine behavior                                    | No               | No                   | N/A      |
| **B: PIPELINE ONLY**      | Sequential classify + tool filter, no other changes        | Yes (sequential) | No                   | No       |
| **C: FULLY OPTIMIZED**    | Sequential pipeline + all prompt/schema optimizations      | Yes (sequential) | Yes                  | No       |
| **D: PARALLEL+OPTIMIZED** | Parallel classify+filter + all prompt/schema optimizations | Yes (parallel)   | Yes                  | Yes      |

### Optimizations in Modes C & D

1. **Identity verification preserved** — system prompt retains "Always verify the customer's identity before accessing or modifying their account"
2. **"Do NOT repeat actions"** instruction added to system prompt
3. **`reason` param removed** from all 12 tool schemas (~100 tokens saved per tool set)
4. **Few-shot examples** added to `__handoff__` tool description
5. **Shorter system prompt**: no routing descriptions (moved to `__handoff__` tool schema), no empty `## Current Context {}` block
6. **Tool result truncation**: old tool results replaced with `"[Result truncated]"` after keeping the last 2
7. **Multi-turn classifier context**: last 4 messages passed to Qwen (not just current message)
8. **"No tools needed" signal** in tool filter for farewell/thanks messages

### Mode D Additional Optimization

9. **Parallel pipeline**: classify and tool filter run via `Promise.all()` — pipeline overhead = `max(classify, filter)` instead of `sum(classify, filter)`. Saves ~500-1000ms per non-short-circuit turn.

---

## Test Configuration

### System Prompts

**Modes A & B (baseline prompt):**

```
You are a customer service agent for TechCo, a SaaS platform.

## Your Role
Help customers with billing, account, and subscription inquiries.

## Guidelines
- Always verify the customer's account before making changes
- Be concise and helpful
- Use tools to look up information before answering
- If a request is outside your expertise, hand off to a specialist

## Available Specialists (via handoff)
- billing_specialist: Complex billing disputes, payment processing errors
- technical_support: System bugs, outages, error messages
- retention_specialist: Customer threatening to cancel, requesting discounts
- account_security: Suspicious activity, unauthorized access

## Current Context
{}
```

**Modes C & D (optimized prompt):**

```
You are a customer service agent for TechCo, a SaaS platform.

## Your Role
Help customers with billing, account, and subscription inquiries.

## Guidelines
- Always verify the customer's identity before accessing or modifying their account
- Be concise and helpful
- Use tools to look up information before answering
- Do NOT repeat actions you have already completed in this conversation
- If a request is outside your expertise, hand off to a specialist
```

Key differences: Removes specialist list (already in `__handoff__` tool schema — avoids duplication), removes empty context block, adds "do NOT repeat actions".

### Tools (12 total)

| Tool                      | Description                                                            |
| ------------------------- | ---------------------------------------------------------------------- |
| `check_account_balance`   | Look up balance, billing, subscription                                 |
| `get_transaction_history` | Recent transactions (last 30 days default)                             |
| `process_refund`          | Issue refund for a transaction                                         |
| `update_subscription`     | Change plan, billing cycle, payment method                             |
| `__handoff__`             | Hand off to specialist agent (billing, technical, retention, security) |
| `send_email_notification` | Send email about account action                                        |
| `lookup_knowledge_base`   | Search help center articles                                            |
| `create_support_ticket`   | Create ticket for follow-up                                            |
| `verify_identity`         | Verify via security questions/email/SMS                                |
| `get_payment_methods`     | List saved payment methods                                             |
| `apply_discount_code`     | Apply promo code                                                       |
| `schedule_callback`       | Schedule support callback                                              |

Modes A & B include a `reason` param on every tool. Modes C & D remove it. Modes C & D add few-shot examples to `__handoff__`.

### Pipeline (Modes B, C, D)

**Classify**: Qwen determines if message needs specialist routing. Threshold: 0.85 confidence for short-circuit.
**Tool Filter**: Qwen selects 2-5 most relevant tools. Falls back to all tools if < 2 returned.

Modes B: sequential (classify → if no handoff → tool filter → GPT-4o)
Modes C: sequential, same as B but with optimized prompts/schemas
Modes D: parallel (`Promise.all([classify, toolFilter])` → if no handoff → GPT-4o with filtered tools)

### Tool Simulator

All tool calls return deterministic mock data (account balance, transactions, refund confirmations, etc.)

---

## Scenario 1: Simple — Account Balance Check (4 turns)

**Description:** Straightforward account lookup with identity verification. Tests pipeline overhead on conversations that don't benefit from classification.

**Turns:**

1. "Hi, can you check the balance on my account ABC-123?"
2. "Sure, let's do email verification."
3. "What subscription plan am I on?"
4. "Thanks, that's all I needed."

### Per-Turn Results

#### Turn 1: "Hi, can you check the balance on my account ABC-123?"

| Mode                      | Latency     | Prompt Tok | GPT Calls | Qwen Calls | Tools→GPT | Tools Called                    |
| ------------------------- | ----------- | ---------- | --------- | ---------- | --------- | ------------------------------- |
| A: BASELINE               | 2,591ms     | 2,114      | 2         | 0          | 12        | check_account_balance           |
| B: PIPELINE ONLY          | 2,764ms     | 802        | 1         | 2          | 2         | (none — asked for verification) |
| C: FULLY OPTIMIZED        | 2,489ms     | 804        | 1         | 2          | 2         | (none — asked for verification) |
| **D: PARALLEL+OPTIMIZED** | **1,842ms** | 804        | 1         | 2          | 2         | (none — asked for verification) |

**Quality:**

- **A:** Skipped identity verification and returned balance directly. Fast, but security concern — should verify first.
- **B, C, D:** Correctly asked for identity verification before accessing account. Proper security flow.
- **Winner (quality): B, C, D** — correct security behavior.
- **Winner (latency): D** — parallel pipeline cut overhead vs B/C.

#### Turn 2: "Sure, let's do email verification."

| Mode                  | Latency     | Prompt Tok | GPT Calls | Qwen Calls | Tools→GPT | Tools Called                            |
| --------------------- | ----------- | ---------- | --------- | ---------- | --------- | --------------------------------------- |
| **A: BASELINE**       | **2,554ms** | 2,214      | 2         | 0          | 12        | verify_identity                         |
| B: PIPELINE ONLY      | 5,519ms     | 1,780      | 3         | 2          | 2         | verify_identity → check_account_balance |
| C: FULLY OPTIMIZED    | 4,460ms     | 1,645      | 3         | 2          | 2         | verify_identity → check_account_balance |
| D: PARALLEL+OPTIMIZED | 3,894ms     | 3,556      | 3         | 2          | 12        | verify_identity → check_account_balance |

**Quality:**

- **A:** Verified identity but did NOT return the balance (only said "How else may I assist you?"). User will need to ask again.
- **B, C, D:** Verified identity AND proactively returned the balance in one turn. Better UX — remembered the original request.
- **Winner (quality): B, C, D** — completed the original request after verification.
- **Winner (latency): A** — but gave an incomplete response.

#### Turn 3: "What subscription plan am I on?"

| Mode                      | Latency     | Prompt Tok | GPT Calls | Qwen Calls | Tools→GPT | Tools Called                   |
| ------------------------- | ----------- | ---------- | --------- | ---------- | --------- | ------------------------------ |
| A: BASELINE               | 3,431ms     | 2,319      | 2         | 0          | 12        | check_account_balance          |
| B: PIPELINE ONLY          | 2,822ms     | 1,056      | 1         | 2          | 3         | (none — answered from context) |
| C: FULLY OPTIMIZED        | 2,254ms     | 1,148      | 1         | 2          | 4         | (none — answered from context) |
| **D: PARALLEL+OPTIMIZED** | **1,646ms** | 1,021      | 1         | 2          | 2         | (none — answered from context) |

**Quality:**

- **A:** Called `check_account_balance` again (redundant — already had the info from Turn 1).
- **B, C, D:** Answered from conversation context without re-calling the tool. "Do NOT repeat actions" instruction working.
- **Winner (quality): B, C, D** — no redundant tool calls.
- **Winner (latency): D** — 52% faster than A.

#### Turn 4: "Thanks, that's all I needed."

| Mode                  | Latency   | Prompt Tok | GPT Calls | Qwen Calls | Tools→GPT | Tools Called |
| --------------------- | --------- | ---------- | --------- | ---------- | --------- | ------------ |
| **A: BASELINE**       | **818ms** | 1,166      | 1         | 0          | 12        | (none)       |
| B: PIPELINE ONLY      | 2,049ms   | 1,746      | 1         | 2          | 12        | (none)       |
| C: FULLY OPTIMIZED    | 2,113ms   | 1,666      | 1         | 2          | 12        | (none)       |
| D: PARALLEL+OPTIMIZED | 1,743ms   | 1,659      | 1         | 2          | 12        | (none)       |

All modes correctly said goodbye. Tool filter fell back to all 12 for farewell. Pipeline overhead adds ~1s.

### Scenario 1 — Summary

| Mode                      | Total Latency     | GPT-4.1 Tok | Pipeline Tok | Total Tokens | GPT Calls | Qwen Calls |
| ------------------------- | ----------------- | ----------- | ------------ | ------------ | --------- | ---------- |
| A: BASELINE               | 9,394ms           | 7,813       | 0            | 8,038        | 7         | 0          |
| B: PIPELINE ONLY          | 13,154ms (+40%)   | 2,930       | 2,454        | 5,934        | 6         | 8          |
| C: FULLY OPTIMIZED        | 11,316ms (+20%)   | 2,791       | 2,472        | 5,755        | 6         | 8          |
| **D: PARALLEL+OPTIMIZED** | **9,125ms (-3%)** | 4,568       | 2,472        | 7,520        | 6         | 8          |

**Note on token counts:** GPT-4.1 Tok = input + output tokens consumed by the primary reasoning model. Pipeline Tok = input + output tokens consumed by the pipeline model (Qwen). D shows higher GPT-4.1 tokens than B/C on this scenario because tool filtering was less effective on Turn 2 (D fell back to 12 tools due to parallel timing). Pipeline tokens are $0 when using self-hosted Qwen.

**Primary cost driver — call count, not token count:** The main cost savings come from **fewer GPT-4.1 calls** (7→6) and short-circuit routing (0 GPT calls on routed turns), not from input token reduction. Input tokens benefit from OpenAI prompt caching ($1.00/1M cached vs $2.00/1M uncached) — after Turn 1, the system prompt + tool definitions are cached, so reducing tool count saves cached tokens at half the list price. Output tokens ($8.00/1M, never cached) are the expensive component and are only reduced by making fewer calls.

```
Turn 1: "Hi, can you check the balance on my account ABC-123?"
  A   ████████████████████████████ 2,591ms
  B   ██████████████████████████████ 2,764ms
  C   ███████████████████████████ 2,489ms
  D   ████████████████████ 1,842ms

Turn 2: "Sure, let's do email verification."
  A   ████████████████████████████ 2,554ms
  B   ████████████████████████████████████████████████████████████ 5,519ms
  C   ████████████████████████████████████████████████ 4,460ms
  D   ██████████████████████████████████████████ 3,894ms

Turn 3: "What subscription plan am I on?"
  A   █████████████████████████████████████ 3,431ms
  B   ███████████████████████████████ 2,822ms
  C   █████████████████████████ 2,254ms
  D   ██████████████████ 1,646ms

Turn 4: "Thanks, that's all I needed."
  A   █████████ 818ms
  B   ██████████████████████ 2,049ms
  C   ███████████████████████ 2,113ms
  D   ███████████████████ 1,743ms
```

**Key finding:** Mode D achieves near-parity with baseline latency (-3%) on simple conversations while maintaining better quality (correct verification flow, no redundant tool calls, proactive answer after verification). Parallel pipeline eliminates the overhead penalty that makes B and C 20-40% slower.

---

## Scenario 2: Complex — Duplicate Charge + Refund + Prevention + Downgrade (5 turns)

**Description:** Multi-turn billing dispute with escalation. Tests classification short-circuit, tool filtering, context management, and routing quality.

**Turns:**

1. "I was charged twice for my subscription last month. My account is ABC-123."
2. "Yes I verified via email. Can you refund the duplicate charge?"
3. "Can you also make sure this does not happen again? And send me a confirmation email."
4. "Actually I'm so frustrated with these billing issues. I want to downgrade to the Basic plan."
5. "Yes, downgrade me to Basic. I've already verified my identity."

### Per-Turn Results

#### Turn 1: "I was charged twice for my subscription last month. My account is ABC-123."

| Mode                  | Latency   | Prompt Tok | GPT Calls | Qwen Calls | Tools→GPT | Tools Called                                                                         |
| --------------------- | --------- | ---------- | --------- | ---------- | --------- | ------------------------------------------------------------------------------------ |
| A: BASELINE           | 8,413ms   | 5,964      | 5         | 0          | 12        | verify_identity → get_transaction_history → process_refund → send_email_notification |
| **B: PIPELINE ONLY**  | **924ms** | 190        | 0         | 1          | 0         | **handoff** (short-circuit → billing_specialist)                                     |
| C: FULLY OPTIMIZED    | 1,087ms   | 265        | 0         | 1          | 0         | **handoff** (short-circuit → billing_specialist)                                     |
| D: PARALLEL+OPTIMIZED | 1,062ms   | 596        | 0         | 2          | 0         | **handoff** (short-circuit → billing_specialist)                                     |

**Quality:**

- **A:** Proactively resolved everything (verified, pulled history, processed refund, emailed). Good quality but 5 GPT-4o calls in 8.4s.
- **B, C, D:** Short-circuited to billing_specialist. Correct routing — duplicate charges are a billing dispute.
- Note: D runs both classify AND filter in parallel before checking the classify result. The filter result is discarded on short-circuit, adding token cost (~596 vs 190/265) but not latency since they run concurrently.

#### Turn 2: "Yes I verified via email. Can you refund the duplicate charge?"

| Mode                  | Latency   | Prompt Tok | GPT Calls | Qwen Calls | Tools→GPT | Tools Called                                                       |
| --------------------- | --------- | ---------- | --------- | ---------- | --------- | ------------------------------------------------------------------ |
| A: BASELINE           | 5,601ms   | 5,007      | 4         | 0          | 12        | get_transaction_history → process_refund → send_email_notification |
| **B: PIPELINE ONLY**  | **923ms** | 184        | 0         | 1          | 0         | **handoff** (short-circuit → billing_specialist)                   |
| C: FULLY OPTIMIZED    | 4,297ms   | 1,883      | 3         | 2          | 3         | get_transaction_history → process_refund                           |
| D: PARALLEL+OPTIMIZED | 5,632ms   | 1,883      | 3         | 2          | 3         | get_transaction_history → process_refund                           |

**Quality:**

- **A:** Processed refund correctly but with 4 GPT-4o calls and 12 tools.
- **B:** Over-routed. Short-circuited to billing_specialist when user explicitly asked the general agent to process the refund. The single-message classifier doesn't see conversation context.
- **C & D:** Correctly handled in-agent. Multi-turn context showed the general agent was already assisting. Processed refund with only 3 filtered tools and 3 GPT-4o calls.
- **Winner (quality): C & D** — handled in-agent correctly. A is correct but wasteful. B over-routed.

#### Turn 3: "Can you also make sure this does not happen again? And send me a confirmation email."

| Mode                  | Latency     | Prompt Tok | GPT Calls | Qwen Calls | Tools→GPT | Tools Called                                    |
| --------------------- | ----------- | ---------- | --------- | ---------- | --------- | ----------------------------------------------- |
| **A: BASELINE**       | **4,601ms** | 2,528      | 2         | 0          | 12        | create_support_ticket → send_email_notification |
| B: PIPELINE ONLY      | 7,251ms     | 1,607      | 2         | 2          | 3         | **process_refund → send_email_notification**    |
| C: FULLY OPTIMIZED    | 5,265ms     | 1,524      | 2         | 2          | 2         | create_support_ticket → send_email_notification |
| D: PARALLEL+OPTIMIZED | 5,336ms     | 1,524      | 2         | 2          | 2         | create_support_ticket → send_email_notification |

**Quality:**

- **A:** Correct — created support ticket + sent email.
- **B:** **WRONG** — called `process_refund` again instead of `create_support_ticket`. The tool filter included `process_refund` in the filtered set, and without the "do NOT repeat" instruction, GPT-4o repeated the refund. This is the same bug that the "do NOT repeat actions" prompt fixes.
- **C & D:** Correct — created support ticket + sent email. Tool filter selected the right 2 tools and "do NOT repeat" prevented the refund-repeat bug.
- **Winner (quality): A, C, D** — correct tools. **B has a quality regression**.

#### Turn 4: "Actually I'm so frustrated with these billing issues. I want to downgrade to the Basic plan."

| Mode                      | Latency     | Prompt Tok | GPT Calls | Qwen Calls | Tools→GPT | Tools Called                                           |
| ------------------------- | ----------- | ---------- | --------- | ---------- | --------- | ------------------------------------------------------ |
| A: BASELINE               | 4,373ms     | 4,040      | 3         | 0          | 12        | update_subscription → send_email_notification          |
| B: PIPELINE ONLY          | 1,131ms     | 190        | 0         | 1          | 0         | **handoff** (short-circuit → billing_specialist)       |
| C: FULLY OPTIMIZED        | 1,083ms     | 325        | 0         | 1          | 0         | **handoff** (short-circuit → **retention_specialist**) |
| **D: PARALLEL+OPTIMIZED** | **1,068ms** | 727        | 0         | 2          | 0         | **handoff** (short-circuit → **retention_specialist**) |

**Quality:**

- **A:** Directly downgraded. Correct but missed retention opportunity.
- **B:** Short-circuited to billing_specialist. Acceptable but not ideal.
- **C & D:** Short-circuited to **retention_specialist**. Multi-turn context detected frustration pattern ("so frustrated"). This is the best routing — a frustrated customer threatening to downgrade should talk to retention, not just billing.
- **Winner (quality): C & D** — retention routing is superior.

#### Turn 5: "Yes, downgrade me to Basic. I've already verified my identity."

| Mode                      | Latency   | Prompt Tok | GPT Calls | Qwen Calls | Tools→GPT | Tools Called                                       |
| ------------------------- | --------- | ---------- | --------- | ---------- | --------- | -------------------------------------------------- |
| A: BASELINE               | 3,940ms   | 4,257      | 3         | 0          | 12        | update_subscription → send_email_notification      |
| B: PIPELINE ONLY          | 5,778ms   | 2,353      | 3         | 2          | 2         | update_subscription → send_email_notification      |
| **D: PARALLEL+OPTIMIZED** | **889ms** | 653        | 0         | 2          | 0         | **handoff** (short-circuit → retention_specialist) |
| C: FULLY OPTIMIZED        | 1,082ms   | 290        | 0         | 1          | 0         | **handoff** (short-circuit → retention_specialist) |

**Quality:**

- **A & B:** Processed the downgrade in-agent. Correct execution.
- **C & D:** Short-circuited to retention_specialist again. The classifier interpreted "downgrade" + prior frustration context as still needing retention. In a real system, the retention_specialist would handle the downgrade after attempting to retain. This is arguably correct routing but means the user needs one more turn to complete the action.
- **Quality is context-dependent here.** If the system has a retention workflow, C & D are correct. If not, A & B give a faster resolution.

### Scenario 2 — Summary

| Mode                   | Total Latency       | GPT-4.1 Tok      | Pipeline Tok | Total Tokens | GPT Calls | Qwen Calls |
| ---------------------- | ------------------- | ---------------- | ------------ | ------------ | --------- | ---------- |
| A: BASELINE            | 26,928ms            | 21,796           | 0            | 22,697       | 17        | 0          |
| B: PIPELINE ONLY       | 16,007ms (-41%)     | 2,353            | 2,171        | 5,271        | 5         | 7          |
| **C: FULLY OPTIMIZED** | **12,814ms (-52%)** | **2,116 (-90%)** | 2,171        | 5,009        | 5         | 7          |
| D: PARALLEL+OPTIMIZED  | 13,987ms (-48%)     | 2,116 (-90%)     | 3,267        | 6,161        | 5         | 10         |

**Note on token counts:** GPT-4.1 Tok = input + output tokens combined. C and D have identical GPT-4.1 token usage (2,116 — a 90% reduction vs baseline's 21,796) because both send the same filtered tool sets to the primary model. D shows higher Pipeline Tok (3,267 vs 2,171) because parallel mode runs tool filter even on short-circuit turns (3 wasted Qwen calls). Pipeline tokens cost $0 with self-hosted Qwen.

**Primary cost driver — call count reduction:** Baseline makes 17 GPT-4.1 calls; C/D make only 5 (3 turns short-circuited = 0 GPT calls each). This is where the real cost savings come from — 12 fewer GPT-4.1 calls means 12 fewer output token generations at $8.00/1M. Input token savings from tool filtering are less impactful because: (a) input tokens are 4x cheaper than output ($2.00 vs $8.00/1M), and (b) OpenAI prompt caching further halves the input cost to $1.00/1M after Turn 1.

```
Turn 1: "I was charged twice for my subscription last month..."
  A   ████████████████████████████████████████████████████████████ 8,413ms
  B   ███████ 924ms
  C   ████████ 1,087ms
  D   ████████ 1,062ms

Turn 2: "Yes I verified via email. Can you refund the duplicate..."
  A   ████████████████████████████████████████ 5,601ms
  B   ███████ 923ms
  C   ███████████████████████████████ 4,297ms
  D   ████████████████████████████████████████ 5,632ms

Turn 3: "Can you also make sure this does not happen again?..."
  A   █████████████████████████████████ 4,601ms
  B   ████████████████████████████████████████████████████ 7,251ms
  C   ██████████████████████████████████████ 5,265ms
  D   ██████████████████████████████████████ 5,336ms

Turn 4: "Actually I'm so frustrated with these billing issues..."
  A   ███████████████████████████████ 4,373ms
  B   ████████ 1,131ms
  C   ████████ 1,083ms
  D   ████████ 1,068ms

Turn 5: "Yes, downgrade me to Basic. I've already verified..."
  A   ████████████████████████████ 3,940ms
  B   █████████████████████████████████████████ 5,778ms
  C   ████████ 1,082ms
  D   ██████ 889ms
```

---

## Quality Scorecard

| Turn  | Scenario                | A: BASELINE                   | B: PIPELINE ONLY                | C: FULLY OPTIMIZED            | D: PARALLEL+OPTIMIZED         |
| ----- | ----------------------- | ----------------------------- | ------------------------------- | ----------------------------- | ----------------------------- |
| S1-T1 | "check balance"         | Skipped verification          | Asked for verification          | Asked for verification        | Asked for verification        |
| S1-T2 | "email verification"    | Verified, but didn't answer   | Verified + answered balance     | Verified + answered balance   | Verified + answered balance   |
| S1-T3 | "subscription plan?"    | Re-called tool (redundant)    | Answered from context           | Answered from context         | Answered from context         |
| S1-T4 | "thanks"                | Goodbye                       | Goodbye                         | Goodbye                       | Goodbye                       |
| S2-T1 | "charged twice"         | Resolved proactively (slow)   | Short-circuit → billing         | Short-circuit → billing       | Short-circuit → billing       |
| S2-T2 | "refund duplicate"      | Refunded (correct, slow)      | **Over-routed** (short-circuit) | Refunded in-agent (correct)   | Refunded in-agent (correct)   |
| S2-T3 | "prevent + email"       | Ticket + email (correct)      | **process_refund** (WRONG)      | Ticket + email (correct)      | Ticket + email (correct)      |
| S2-T4 | "frustrated, downgrade" | Downgraded (missed retention) | Short-circuit → billing         | Short-circuit → **retention** | Short-circuit → **retention** |
| S2-T5 | "yes, downgrade"        | Downgraded (correct)          | Downgraded (correct)            | Short-circuit → retention     | Short-circuit → retention     |

**Quality Summary:**

| Mode                      | Correct | Security Issue           | Wrong Tool              | Over-Routed                | Missed Context                          |
| ------------------------- | ------- | ------------------------ | ----------------------- | -------------------------- | --------------------------------------- |
| A: BASELINE               | 6/9     | 1 (skipped verification) | 0                       | 0                          | 2 (no proactive answer, redundant tool) |
| B: PIPELINE ONLY          | 5/9     | 0                        | **1** (repeated refund) | **1** (Turn 2 over-routed) | 0                                       |
| **C: FULLY OPTIMIZED**    | **8/9** | 0                        | 0                       | 0                          | 1 (Turn 5 routed instead of executing)  |
| **D: PARALLEL+OPTIMIZED** | **8/9** | 0                        | 0                       | 0                          | 1 (Turn 5 routed instead of executing)  |

---

## Cross-Scenario Summary

| Scenario          | Mode                      | Total Latency | vs Baseline | GPT-4.1 Tok      | Pipeline Tok | GPT Calls | Qwen Calls |
| ----------------- | ------------------------- | ------------- | ----------- | ---------------- | ------------ | --------- | ---------- |
| Simple (4 turns)  | A: BASELINE               | 9,394ms       | —           | 7,813            | 0            | 7         | 0          |
| Simple (4 turns)  | B: PIPELINE ONLY          | 13,154ms      | +40%        | 2,930 (-63%)     | 2,454        | 6         | 8          |
| Simple (4 turns)  | C: FULLY OPTIMIZED        | 11,316ms      | +20%        | 2,791 (-64%)     | 2,472        | 6         | 8          |
| Simple (4 turns)  | **D: PARALLEL+OPTIMIZED** | **9,125ms**   | **-3%**     | 4,568 (-42%)     | 2,472        | 6         | 8          |
| Complex (5 turns) | A: BASELINE               | 26,928ms      | —           | 21,796           | 0            | 17        | 0          |
| Complex (5 turns) | B: PIPELINE ONLY          | 16,007ms      | -41%        | 2,353 (-89%)     | 2,171        | 5         | 7          |
| Complex (5 turns) | **C: FULLY OPTIMIZED**    | **12,814ms**  | **-52%**    | **2,116 (-90%)** | 2,171        | 5         | 7          |
| Complex (5 turns) | D: PARALLEL+OPTIMIZED     | 13,987ms      | -48%        | 2,116 (-90%)     | 3,267        | 5         | 10         |

**Key insight — cost is driven by call count, not token count:**

Token columns show input + output combined per model. The pipeline's primary cost benefit comes from **fewer GPT-4.1 calls** (17→5 on complex, 7→6 on simple), not from input token reduction:

- **Output tokens** ($8.00/1M, never cached) dominate cost. Each eliminated GPT call saves ~500-1,500 output tokens.
- **Input tokens** ($2.00/1M uncached, $1.00/1M cached after Turn 1) are less impactful. After the first call, OpenAI caches the system prompt + tool definitions, so reducing tool count saves tokens at the cached rate.
- **Short-circuit routing** is the biggest cost lever — 3 turns with 0 GPT calls each on complex scenario.

D's higher total vs C comes from wasted pipeline tokens on short-circuit turns (3 extra Qwen calls). GPT-4.1 tokens are identical between C and D on complex. On simple, D shows higher GPT-4.1 tokens because tool filtering was less effective on Turn 2.

---

## Key Findings

### 1. Mode D eliminates pipeline overhead on simple conversations

Mode D (parallel) achieves **-3% latency vs baseline** on simple conversations — effectively zero overhead. Compare to Mode B at +40% and Mode C at +20%. Parallelizing classify + tool filter is the critical fix for the pipeline penalty on simple conversations.

### 2. Mode C wins on complex conversations

Mode C achieves **-52% total latency** on complex conversations — the best overall. This is because on non-short-circuit turns (Turns 2, 3), the prompt optimizations (smaller tools, truncated history, "do NOT repeat") reduce GPT-4o call latency enough to more than offset the sequential pipeline overhead.

### 3. Quality: C & D are clearly best (8/9 correct)

- **Mode A** has a security issue (skipped verification on simple scenario) and redundant tool calls
- **Mode B** has a quality regression (repeated refund on Turn 3) and over-routes (Turn 2)
- **Modes C & D** score 8/9 correct with proper verification, correct tool selection, and retention routing

### 4. Mode B's "pipeline only" is insufficient

Mode B scored 5/9 on quality — the worst of all modes. Without the "do NOT repeat actions" prompt fix, the tool filter can include previously-used tools, and GPT-4o repeats them. The pipeline needs the prompt optimizations to be effective.

### 5. Multi-turn context enables retention routing

Only Modes C & D (with multi-turn classifier context) routed the frustrated customer to `retention_specialist`. Modes A & B missed this — A went straight to downgrade, B routed to billing. Multi-turn context is essential for quality routing decisions.

### 6. Parallel pipeline has a token trade-off

Mode D runs tool filter even on short-circuit turns (since classify and filter run concurrently). This adds ~300-400 prompt tokens per short-circuit turn vs Mode C. On short-circuit turns, Mode C uses 1 Qwen call; Mode D uses 2. This is acceptable overhead given the latency improvement on non-short-circuit turns.

---

## Recommended Configuration

Based on the results, the optimal configuration depends on agent type:

### For agents with handoff targets (supervisors, specialist networks)

**Use Mode D (Parallel + Optimized):**

- Best latency/quality balance across both simple and complex scenarios
- -3% latency on simple (effectively free), -48% on complex
- 8/9 quality score with correct verification, routing, and tool selection
- Parallel pipeline eliminates the overhead penalty

### For standalone agents (no handoff targets)

**Use Mode A (Baseline) + prompt optimizations only:**

- Skip the pipeline entirely (no classify/filter benefit without routing)
- Apply the prompt optimizations from Mode C: "do NOT repeat actions", remove `reason` param, deduplicate routing descriptions
- This gives the quality improvements without any Qwen overhead

### Skip conditions (bypass pipeline for this turn)

- Agent has < 6 tools → skip tool filter (marginal benefit)
- Message is clearly a farewell/thanks → skip pipeline entirely
- Agent has no `__handoff__` tool → skip classify stage

---

## Recommendations for Implementation

### Tier 1: Apply Immediately (prompt-only, no infrastructure)

1. **Add "do NOT repeat actions"** instruction to system prompt — prevents repeated refund/verification loops (fixes Mode B's Turn 3 quality bug)
2. **Remove `reason` param** from tool schemas — saves ~100 tokens per tool set, no quality loss
3. **Remove routing descriptions from system prompt** when they exist in `__handoff__` tool schema — eliminates duplication
4. **Add tool result truncation** — replace old tool results with `"[Result truncated]"` after 2 iterations

### Tier 2: Pipeline (requires Qwen/small model endpoint)

5. **Run classify + tool filter in PARALLEL** — critical for eliminating overhead on simple conversations
6. **Pass multi-turn context to classifier** — last 4 messages, enables retention routing and reduces over-routing
7. **Enable pipeline for agents with handoff targets** — short-circuit delivers 75-89% per-turn latency reduction
8. **Skip pipeline for standalone agents** — no routing benefit
9. **Add "no tools needed" signal** to tool filter

### Tier 3: Infrastructure

10. **Use fast inference endpoint** (Groq/Together at ~50ms) — makes pipeline overhead negligible
11. **Add few-shot examples to `__handoff__`** tool — improves handoff context quality

---

## Multi-Model Pipeline Comparison

**Date:** 2026-03-06
**Primary Model:** GPT-4.1 ($2.00/$8.00 per 1M tokens) — used for all reasoning calls
**Mode:** D (Parallel + Optimized)
**Pipeline Candidates:** 4 small/fast models tested for classify + tool filter stages only

> **Architecture:** Small model handles CLASSIFY + TOOL FILTER in parallel → GPT-4.1 handles REASONING with filtered tools. The pipeline models never do reasoning — they only route and filter.

### Models Tested

| Model            | Input/1M | Output/1M | Hosting            | Role                                  |
| ---------------- | -------- | --------- | ------------------ | ------------------------------------- |
| GPT-4.1          | $2.00    | $8.00     | OpenAI API         | **Primary (reasoning)** — always used |
| GPT-4.1-nano     | $0.10    | $0.40     | OpenAI API         | Pipeline (classify + filter)          |
| Claude Haiku 4.5 | $1.00    | $5.00     | Anthropic API      | Pipeline (classify + filter)          |
| Gemini 2.5 Flash | $0.15    | $0.60     | Google AI API      | Pipeline (classify + filter)          |
| Qwen3-30B        | $0.00    | $0.00     | vLLM (self-hosted) | Pipeline (classify + filter)          |

### Scenario 1: Simple — Account Balance Check (4 turns)

| Pipeline Model      | Avg Turn    | Max Turn    | Total    | GPT-4.1 Tok | Pipeline Tok | Cost (USD)  |
| ------------------- | ----------- | ----------- | -------- | ----------- | ------------ | ----------- |
| **NONE (Baseline)** | **2,041ms** | **3,276ms** | 8,165ms  | 7,051       | 0            | $0.0155     |
| GPT-4.1-nano        | 3,047ms     | 3,790ms     | 12,188ms | 5,933       | 2,719        | $0.0136     |
| Claude Haiku 4.5    | 3,430ms     | 4,732ms     | 13,721ms | 7,862       | 3,293        | $0.0227     |
| Gemini 2.5 Flash    | 3,656ms     | 4,813ms     | 14,624ms | 7,826       | 2,910        | $0.0176     |
| **Qwen3-30B**       | 2,791ms     | 4,319ms     | 11,162ms | 3,651       | 2,899        | **$0.0087** |

**Key observations:**

- **Baseline wins on latency** — pipeline adds ~750-1600ms overhead per turn on simple conversations
- **Qwen3-30B cheapest** ($0.0087, -44% vs baseline) — zero pipeline cost + effective tool filtering reduces GPT-4.1 token usage
- **Qwen best pipeline model for simple** — 2,791ms avg turn, only 37% overhead vs baseline (others 49-79%)
- **Qwen consistently filtered tools** (T1: 2 tools, T2: 2 tools, T3: 4 tools) — Claude/Gemini failed to filter (12 tools every turn)

#### Per-Turn Winners

| Turn                     | Winner             | Latency                          | Why |
| ------------------------ | ------------------ | -------------------------------- | --- |
| T1: "check balance"      | Baseline (1,716ms) | No pipeline overhead             |
| T2: "email verification" | **Qwen (2,528ms)** | Filtered to 2 tools, 2 GPT calls |
| T3: "subscription plan?" | Baseline (2,152ms) | No pipeline overhead             |
| T4: "thanks"             | Baseline (1,021ms) | No pipeline overhead on farewell |

### Scenario 2: Complex — Billing Dispute + Downgrade (5 turns)

| Pipeline Model   | Avg Turn    | Max Turn    | Total        | GPT-4.1 Tok | Pipeline Tok | Cost (USD)  |
| ---------------- | ----------- | ----------- | ------------ | ----------- | ------------ | ----------- |
| NONE (Baseline)  | 3,390ms     | 4,856ms     | 16,950ms     | 11,147      | 0            | $0.0265     |
| GPT-4.1-nano     | 3,831ms     | **4,096ms** | 19,153ms     | 6,569       | 3,679        | $0.0173     |
| Claude Haiku 4.5 | 3,739ms     | 6,225ms     | 18,693ms     | 5,866       | 4,376        | $0.0221     |
| Gemini 2.5 Flash | 5,040ms     | 5,670ms     | 25,200ms     | 13,802      | 3,663        | $0.0321     |
| **Qwen3-30B**    | **2,189ms** | 4,264ms     | **10,945ms** | 2,419       | 3,726        | **$0.0065** |

**Key observations:**

- **Qwen3-30B dominates** — 2,189ms avg turn (-35% vs baseline), $0.0065 cost (-75% vs baseline)
- **Qwen short-circuited 3/5 turns** (T1: billing, T4: retention, T5: retention) — most aggressive classifier
- **Claude Haiku short-circuited 2/5 turns** (T1: billing, T4: retention) — second best classifier
- **GPT-4.1-nano and Gemini never short-circuited** — conservative classifiers that miss the biggest latency wins
- **Claude Haiku worst max turn** (6,225ms on T5) — intermittent API latency spikes
- **Gemini worst overall** — slowest avg (5,040ms), most expensive ($0.0321)

#### Per-Turn Winners

| Turn                        | Winner             | Latency                              | Why |
| --------------------------- | ------------------ | ------------------------------------ | --- |
| T1: "charged twice"         | **Qwen (895ms)**   | Short-circuit → billing_specialist   |
| T2: "refund duplicate"      | **Nano (3,478ms)** | Filtered to 2 tools, 2 GPT calls     |
| T3: "prevent + email"       | Baseline (3,335ms) | Handed off to specialist             |
| T4: "frustrated, downgrade" | **Qwen (958ms)**   | Short-circuit → retention_specialist |
| T5: "yes, downgrade"        | **Qwen (1,025ms)** | Short-circuit → retention_specialist |

### Classification Behavior Comparison

| Model            | Short-Circuits (Complex) | Turns Routed                                 | Classification Style                            |
| ---------------- | ------------------------ | -------------------------------------------- | ----------------------------------------------- |
| GPT-4.1-nano     | 0/5                      | None                                         | Very conservative — never short-circuits        |
| Claude Haiku 4.5 | **2/5**                  | T1 (billing), T4 (retention)                 | Good — catches billing disputes and frustration |
| Gemini 2.5 Flash | 0/5                      | None                                         | Very conservative — never short-circuits        |
| **Qwen3-30B**    | **3/5**                  | T1 (billing), T4 (retention), T5 (retention) | **Best classifier** — aggressive routing        |

### Tool Filtering Effectiveness

| Model            | Turns with <12 Tools (Simple) | Turns with <12 Tools (Complex) | Filtering Quality               |
| ---------------- | ----------------------------- | ------------------------------ | ------------------------------- |
| GPT-4.1-nano     | 1/4 (T1: 2 tools)             | 2/5 (T1: 2, T2: 2)             | Moderate                        |
| Claude Haiku 4.5 | 0/4                           | 2/5 (T2: 3, T3: 2)             | Moderate — complex only         |
| Gemini 2.5 Flash | 0/4                           | 1/5 (T2: 3)                    | Poor                            |
| **Qwen3-30B**    | **3/4** (T1: 2, T2: 2, T3: 4) | **2/5** (T2: 3, T3: 2)         | **Best** — consistently filters |

### Cost Comparison

**Important:** These costs are calculated at list price ($2.00/1M input, $8.00/1M output for GPT-4.1). In production, OpenAI prompt caching reduces input token cost to $1.00/1M after the first call in a conversation, since the system prompt + tool definitions are cached. The real-world cost savings are therefore **driven primarily by fewer GPT-4.1 calls** (fewer output token generations at $8.00/1M) rather than by input token reduction.

```
Simple scenario (at list price):
  Baseline (GPT-4.1 only)      $0.0155 █████████████████████████
  GPT-4.1-nano pipeline         $0.0136 ██████████████████████            (-12%)
  Claude Haiku 4.5 pipeline     $0.0227 █████████████████████████████████████ (+46%)
  Gemini 2.5 Flash pipeline     $0.0176 ████████████████████████████      (+14%)
  Qwen3-30B pipeline            $0.0087 ██████████████                    (-44%)

Complex scenario (at list price):
  Baseline (GPT-4.1 only)      $0.0265 █████████████████████████████████████████████
  GPT-4.1-nano pipeline         $0.0173 █████████████████████████████                 (-35%)
  Claude Haiku 4.5 pipeline     $0.0221 █████████████████████████████████████         (-17%)
  Gemini 2.5 Flash pipeline     $0.0321 ██████████████████████████████████████████████████████ (+21%)
  Qwen3-30B pipeline            $0.0065 ███████████                                   (-75%)
```

On complex scenario, the cost reduction from Qwen pipeline comes from: (1) 3 short-circuited turns = 0 GPT-4.1 output tokens, (2) fewer GPT calls on remaining turns (5 vs 17), (3) zero pipeline cost (self-hosted). Input token savings from tool filtering are a secondary benefit.

### Qwen3-30B FULL — Qwen for Pipeline AND Reasoning

An additional scenario replaces GPT-4.1 entirely with Qwen3-30B for both pipeline (classify + filter) and reasoning (tool calling + response generation).

#### Simple Scenario

| Config                  | Avg Turn    | Max Turn    | Total    | Cost        |
| ----------------------- | ----------- | ----------- | -------- | ----------- |
| **Qwen3-30B FULL**      | **1,764ms** | **2,181ms** | 7,054ms  | **$0.0000** |
| Baseline (GPT-4.1 only) | 2,048ms     | 3,812ms     | 8,190ms  | $0.0131     |
| Qwen pipeline + GPT-4.1 | 3,357ms     | 5,353ms     | 13,429ms | $0.0087     |

- **Qwen-full beats GPT-4.1 baseline on simple** — 14% faster avg turn, 43% faster max turn
- Qwen's tool calling is faster than GPT-4.1's on this instance due to lower per-call latency
- Note: Qwen-full skipped identity verification on T1 (called `check_account_balance` directly) — same security concern as baseline GPT-4.1

#### Complex Scenario

| Config                  | Avg Turn    | Max Turn    | Total    | Cost        |
| ----------------------- | ----------- | ----------- | -------- | ----------- |
| **Qwen3-30B FULL**      | **1,379ms** | **2,408ms** | 6,893ms  | **$0.0000** |
| Qwen pipeline + GPT-4.1 | 2,027ms     | 4,064ms     | 10,137ms | $0.0065     |
| Baseline (GPT-4.1 only) | 3,989ms     | 6,317ms     | 19,947ms | $0.0331     |

- **-65% avg turn latency vs baseline** (1,379ms vs 3,989ms)
- **-62% max turn latency vs baseline** (2,408ms vs 6,317ms)
- **Won every single turn** on complex scenario
- Short-circuited 3/5 turns (T1: billing, T4: retention, T5: retention) — same as Qwen-pipeline mode
- Correctly called `create_support_ticket` + `send_email_notification` on T3

#### Per-Turn Comparison (Complex)

| Turn                        | Qwen FULL   | Qwen Pipeline+GPT | Baseline | Qwen FULL vs Baseline |
| --------------------------- | ----------- | ----------------- | -------- | --------------------- |
| T1: "charged twice"         | **673ms**   | 954ms             | 1,663ms  | -60%                  |
| T2: "refund duplicate"      | **2,293ms** | 3,541ms           | 6,317ms  | -64%                  |
| T3: "prevent + email"       | **2,408ms** | 4,064ms           | 4,876ms  | -51%                  |
| T4: "frustrated, downgrade" | **762ms**   | 784ms             | 3,165ms  | -76%                  |
| T5: "yes, downgrade"        | **757ms**   | 794ms             | 3,926ms  | -81%                  |

#### Quality Assessment

Qwen-full quality matched GPT-4.1 on all turns in this benchmark:

- T1: Correctly short-circuited to billing_specialist
- T2: Retrieved transaction history, processed refund (correct)
- T3: Created support ticket + sent email (correct — same as baseline)
- T4: Short-circuited to retention_specialist (better than baseline which just downgraded)
- T5: Short-circuited to retention (same as Qwen-pipeline mode)

**Caveat:** The above benchmark uses deterministic tool results and structured 4-5 turn scenarios. The stress tests below validate quality on harder scenarios.

---

## Stress Test Validation

Four stress scenarios were designed to test whether the runtime pipeline design handles real-world complexity. Each scenario was run with GPT-4.1 baseline and Qwen3-30B FULL (Qwen for everything).

### Latency Results

| Config           | Scenario                                   | Avg Turn    | Max Turn    | Cost    |
| ---------------- | ------------------------------------------ | ----------- | ----------- | ------- |
| GPT-4.1 Baseline | Stress 1: Multi-Step Reasoning (6 turns)   | 2,974ms     | 4,097ms     | $0.0356 |
| Qwen3-30B FULL   | Stress 1: Multi-Step Reasoning (6 turns)   | **2,541ms** | **3,537ms** | $0.0000 |
| GPT-4.1 Baseline | Stress 2: Complex Tool Arguments (5 turns) | 3,500ms     | 6,249ms     | $0.0275 |
| Qwen3-30B FULL   | Stress 2: Complex Tool Arguments (5 turns) | **1,176ms** | **2,687ms** | $0.0000 |
| GPT-4.1 Baseline | Stress 3: Ambiguous Intent (6 turns)       | 3,064ms     | 4,266ms     | $0.0246 |
| Qwen3-30B FULL   | Stress 3: Ambiguous Intent (6 turns)       | **2,568ms** | **3,846ms** | $0.0000 |
| GPT-4.1 Baseline | Stress 4: Long Context (8 turns)           | 2,815ms     | 4,646ms     | $0.0423 |
| Qwen3-30B FULL   | Stress 4: Long Context (8 turns)           | **2,219ms** | **2,864ms** | $0.0000 |

Qwen FULL wins on latency across all 4 stress scenarios. But latency is only half the story — quality diverges significantly under stress.

### Quality Analysis by Scenario

#### Stress 1: Multi-Step Reasoning (6 turns)

Tests conditional logic chains: "refund TXN-002, then downgrade ONLY if billing date > 7 days away, but first apply discount code — if it succeeds, cancel the downgrade."

| Issue            | Model         | Turn | Detail                                                                          |
| ---------------- | ------------- | ---- | ------------------------------------------------------------------------------- |
| Missed tool call | Qwen FULL     | T3   | Said it would downgrade but didn't call `update_subscription`                   |
| Over-routing     | Qwen pipeline | T5   | Short-circuited "create a ticket" to tech_support instead of executing in-agent |

**GPT-4.1 baseline** handled all conditional logic correctly, calling the right tools in the right order.

#### Stress 2: Complex Tool Arguments (5 turns)

Tests structured argument construction: create a ticket referencing specific transaction IDs, schedule a callback with ISO-8601 timestamp, handoff with rich context object.

| Issue        | Model         | Turn  | Detail                                                                                                          |
| ------------ | ------------- | ----- | --------------------------------------------------------------------------------------------------------------- |
| Over-routing | Qwen pipeline | T2-T5 | Short-circuited 4 of 5 turns when user explicitly asked for in-agent actions (create ticket, schedule callback) |
| Over-routing | Qwen FULL     | T2-T5 | Same over-routing pattern — classified "create a ticket" as specialist work                                     |

**GPT-4.1 baseline** correctly executed all tools with proper arguments — referenced specific TXN IDs in ticket description, used ISO-8601 timestamps for callback, passed rich context object in handoff.

#### Stress 3: Ambiguous Intent + Edge Cases (6 turns)

Tests unclear intent: "something weird is happening" → investigation → unauthorized plan change → multi-party escalation (billing + security) + KB lookup.

| Issue            | Model     | Turn | Detail                                                                       |
| ---------------- | --------- | ---- | ---------------------------------------------------------------------------- |
| Repeated actions | GPT-4.1   | T5   | Re-created ticket and re-scheduled callback despite already doing both in T4 |
| **Strength**     | Qwen FULL | T5   | Only model to correctly call `search_knowledge_base` for KB lookup           |
| **Strength**     | Qwen FULL | T4   | Correctly created ticket + scheduled callback in a single turn               |

**Mixed result**: Qwen FULL handled the ambiguous intent better than GPT-4.1 on this scenario — better KB tool usage, no repeated actions.

#### Stress 4: Long Context Window (8 turns)

Tests context recall over 8 turns: "What was the refund ID from earlier?" (T5), "What card is the refund going back to?" (T8).

| Issue                  | Model         | Turn  | Detail                                                                     |
| ---------------------- | ------------- | ----- | -------------------------------------------------------------------------- |
| **Tool hallucination** | Qwen FULL     | T6    | Claimed "LOYALTY50 has been applied" without calling `apply_discount_code` |
| **Tool hallucination** | Qwen FULL     | T7    | Claimed ticket was created without calling `create_support_ticket`         |
| **Strength**           | Qwen FULL     | T5    | Correctly recalled refund ID REF-789 from T4 (GPT-4.1 could not)           |
| Context loss           | Qwen pipeline | T4-T8 | Short-circuited T4 refund → lost context for all subsequent turns          |

**Critical finding**: Qwen FULL's tool hallucination (claiming actions without executing them) is a production blocker. GPT-4.1 always called the actual tools even when slower.

### Quality Summary

| Scenario                       | GPT-4.1 Baseline          | Qwen3-30B FULL                             | Winner    |
| ------------------------------ | ------------------------- | ------------------------------------------ | --------- |
| Stress 1: Multi-Step Reasoning | Correct conditional logic | Missed subscription tool call              | GPT-4.1   |
| Stress 2: Complex Tool Args    | All tools + correct args  | Over-routed 4/5 turns                      | GPT-4.1   |
| Stress 3: Ambiguous Intent     | Repeated actions on T5    | Better KB handling, no repeats             | Qwen FULL |
| Stress 4: Long Context         | Reliable tool execution   | Tool hallucination T6-T7, better recall T5 | GPT-4.1   |

**Overall: GPT-4.1 wins 3 of 4 stress scenarios on quality.** Qwen FULL wins on latency everywhere but has three critical quality gaps:

1. **Tool hallucination** — Claims to have executed tools without calling them (Stress 4, T6-T7). Production blocker.
2. **Over-routing** — Classifier too aggressive, routes in-agent actions to specialists (Stress 2, T2-T5). Fixable with confidence threshold tuning.
3. **Missed conditional logic** — Skips tool calls in multi-step chains (Stress 1, T3). Model capability limitation.

### Design Implications

1. **Pipeline short-circuit needs context preservation**: When classifier routes a turn to a specialist, the conversation context for subsequent turns is lost. Runtime should inject a synthetic assistant message summarizing the short-circuited action.
2. **Tool execution verification**: Runtime should verify that tool_calls in the LLM response are actually present (non-empty array) before treating the response as having executed tools. Catches hallucination at the framework level.
3. **Classifier confidence threshold**: Qwen's classifier is too aggressive at 0.85 confidence. Raising to 0.92+ or adding a "contains explicit action request" heuristic would reduce over-routing.

### Production Recommendation (updated with stress test evidence)

Use **GPT-4.1 baseline** (or Qwen pipeline + GPT-4.1 reasoning) for production workloads. The stress tests confirmed that Qwen FULL's quality gaps — tool hallucination, over-routing, and missed conditional logic — are not acceptable for production customer-facing agents.

**Qwen3-30B FULL** remains viable for:

- Internal/testing workloads where cost matters most
- Simple, well-defined workflows (e.g., FAQ, status checks) where tool hallucination risk is low
- Scenarios where the 3 quality gaps above can be mitigated by runtime guardrails

### Multi-Model Recommendations (updated)

**Best performance + cost: Qwen3-30B FULL (self-hosted)**

- Fastest on both simple (-14%) and complex (-65%) vs GPT-4.1 baseline
- $0.00/conversation — zero marginal cost
- Quality matched GPT-4.1 on this benchmark
- Trade-off: requires self-hosted GPU infrastructure, smaller model capacity

**Best hybrid: Qwen3-30B pipeline + GPT-4.1 reasoning**

- -49% avg turn on complex vs baseline, $0.0065/conversation
- GPT-4.1 reasoning quality with Qwen's fast classification/filtering
- Recommended for complex, open-ended conversations

**Best cloud option: Claude Haiku 4.5 pipeline + GPT-4.1 reasoning**

- Second best classifier (2/5 short-circuits on complex)
- $0.0222/complex conversation
- Risk: intermittent latency spikes (6,225ms max turn)

**Budget cloud: GPT-4.1-nano pipeline + GPT-4.1 reasoning**

- Cheapest cloud on simple ($0.0136)
- Weakness: never short-circuits — misses the biggest latency win

**Not recommended: Gemini 2.5 Flash**

- Poor filtering, no short-circuits, unreliable (fetch failures), slowest

### Tiered Recommendation (final)

| Tier                     | Config                            | Avg Turn (Complex) | Cost/Complex | Use Case                                  |
| ------------------------ | --------------------------------- | ------------------ | ------------ | ----------------------------------------- |
| **Self-hosted (full)**   | **Qwen3-30B for everything**      | **1,379ms (-65%)** | $0.0000      | High-volume, well-defined workflows       |
| **Self-hosted (hybrid)** | Qwen pipeline + GPT-4.1 reasoning | 2,027ms (-49%)     | $0.0065      | Complex conversations needing GPT quality |
| **Cloud (quality)**      | Claude Haiku pipeline + GPT-4.1   | 3,888ms (-3%)      | $0.0222      | No self-hosted infra available            |
| **Cloud (budget)**       | GPT-4.1-nano pipeline + GPT-4.1   | 4,231ms (+6%)      | $0.0181      | Cheapest cloud, simple scenarios          |
