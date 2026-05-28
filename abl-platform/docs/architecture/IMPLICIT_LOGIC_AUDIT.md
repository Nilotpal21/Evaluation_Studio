# Implicit Logic Audit: Parser, Compiler & Runtime

> **Date**: February 6, 2026
> **Scope**: Full audit of hardcoded/implicit behavior across the ABL stack
> **Benchmark**: Kore.ai Saludsa production export (`tmp/app-saludsa_app_temp-05-02-2026-20-19-52.json`)
> **Total findings**: 189 implicit behaviors across 3 layers

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Kore.ai Gap Analysis](#2-koreai-gap-analysis)
3. [Implicit Logic by Category](#3-implicit-logic-by-category)
   - [3.1 Hardcoded Defaults with No Override](#31-hardcoded-defaults-with-no-override)
   - [3.2 Magic Strings & Hardcoded Identifiers](#32-magic-strings--hardcoded-identifiers)
   - [3.3 Implicit Inference Rules](#33-implicit-inference-rules)
   - [3.4 Hardcoded Behavioral Logic](#34-hardcoded-behavioral-logic)
   - [3.5 English-Only Intent & Correction Matching](#35-english-only-intent--correction-matching)
   - [3.6 Hardcoded Error & Response Messages](#36-hardcoded-error--response-messages)
   - [3.7 Type Coercion & Evaluation Inconsistencies](#37-type-coercion--evaluation-inconsistencies)
   - [3.8 Domain-Specific Mock Contamination](#38-domain-specific-mock-contamination)
   - [3.9 Auto-Generated System Prompts](#39-auto-generated-system-prompts)
   - [3.10 Auto-Injected Tools](#310-auto-injected-tools)
4. [Implementation Plan](#4-implementation-plan)
5. [Priority Matrix](#5-priority-matrix)

---

## 1. Executive Summary

ABL is declarative at the language level, but **approximately 40% of actual agent behavior** comes from hardcoded logic in the compiler and runtime rather than from the user's ABL spec. This audit catalogs every instance where the system "decides" behavior implicitly.

The findings fall into three severity tiers:

| Tier         | Description                                                      | Count | Impact                                                  |
| ------------ | ---------------------------------------------------------------- | ----- | ------------------------------------------------------- |
| **Critical** | Blocks production deployment for non-English, non-trivial agents | 48    | Users cannot configure model, timeouts, or localization |
| **High**     | Limits customization; behavior differs from what user declared   | 67    | Silent defaults override or supplement user intent      |
| **Medium**   | Technical debt; fragile conventions; inconsistencies             | 74    | Maintenance burden; subtle bugs                         |

**Key insight**: The Kore.ai Saludsa export (a production Spanish healthcare agent) configures per-agent models, temperatures, max tokens, pre-processors, channel-specific behavior, and environment secrets — none of which ABL can express today. The implicit logic in our stack would silently override or ignore much of what a production deployment needs.

---

## 2. Kore.ai Gap Analysis

### What ABL Handles Well

| Kore.ai Feature                     | ABL Equivalent                       | Coverage |
| ----------------------------------- | ------------------------------------ | -------- |
| Multi-agent system (5 REACT agents) | `SUPERVISOR`, `DELEGATE`, `HANDOFF`  | 90%      |
| Agent goals & persona prompts       | `GOAL`, `PERSONA`, `LIMITATIONS`     | 95%      |
| Tool definitions with typed schemas | `TOOLS` section with typed params    | 90%      |
| Information gathering               | `GATHER` / `COLLECT` with validation | 85%      |
| Agent handoff with context          | `HANDOFF` with context passing       | 90%      |
| Escalation to human                 | `ESCALATE` with priority levels      | 85%      |
| Conditional branching               | `ON_INPUT`, `IF/THEN/ELSE`           | 95%      |
| Conversation completion             | `COMPLETE` with conditions           | 90%      |
| Error handling                      | `ON_ERROR` with retry                | 80%      |
| Digression handling                 | `DIGRESSIONS` (global + step-level)  | 95%      |

### Clear Gaps (Not in ABL)

| Gap                                 | Kore.ai Capability                                                     | ABL Status                                   | Severity |
| ----------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------- | -------- |
| **Channel-specific behavior**       | WhatsApp gets extra security questions; Web/iOS skip them              | No channel awareness at all                  | Critical |
| **Pre/post processors**             | JavaScript runs before each agent (API calls, memory injection)        | No lifecycle hooks                           | Critical |
| **Per-agent model config**          | GPT-4.1 for some agents, GPT-4o-Mini for fallback; temperature 0.3-1.0 | No model configuration                       | Critical |
| **Environment variables & secrets** | Named variables with `secured` flag, namespace grouping                | No env/config management                     | Critical |
| **Inline code execution**           | Embedded JavaScript functions (OTP generation, queue routing)          | No SCRIPT blocks (proposed, not implemented) | High     |
| **Contact center / queue routing**  | Region-based queue selection, operation hours API                      | Generic ESCALATE only                        | High     |
| **Voice / real-time config**        | VAD, filler messages, voice persona, streaming                         | Zero voice support                           | High     |
| **Events / lifecycle hooks**        | End-of-conversation events with conditional triggers                   | No event system beyond COMPLETE              | Medium   |
| **Knowledge / RAG**                 | `knowledgeTools` array (capability exists)                             | No RAG primitives                            | Medium   |
| **User role/type awareness**        | Broker, Business Rep, Holder, Beneficiary routing                      | No role-based routing                        | Medium   |
| **Feature flags**                   | Enable/disable individual tools and agents                             | No toggle mechanism                          | Medium   |
| **Deployment packaging**            | Single JSON export with all config, agents, tools, code                | No export format                             | Medium   |
| **Consent / compliance gating**     | LPD privacy policy consent check before proceeding                     | No consent primitives                        | Medium   |
| **Conversation summary**            | Auto-generated summary in end-of-conversation event                    | No summary generation                        | Low      |

---

## 3. Implicit Logic by Category

### 3.1 Hardcoded Defaults with No Override

These are values the system assumes when the ABL spec is silent. The user has **no mechanism** to change them.

#### Parser Defaults

| Default                       | Value                                                   | File                                             | Line      |
| ----------------------------- | ------------------------------------------------------- | ------------------------------------------------ | --------- |
| Execution mode                | `'reasoning'`                                           | `packages/core/src/parser/agent-based-parser.ts` | 121       |
| Gather field type             | `'string'`                                              | `packages/core/src/parser/agent-based-parser.ts` | 1267      |
| Gather field required         | `true`                                                  | `packages/core/src/parser/agent-based-parser.ts` | 1268      |
| Guardrail kind                | `'output'`                                              | `packages/core/src/parser/agent-based-parser.ts` | 2328      |
| Guardrail action              | `'warn'`                                                | `packages/core/src/parser/agent-based-parser.ts` | 2330      |
| Escalation priority           | `'medium'`                                              | `packages/core/src/parser/agent-based-parser.ts` | 1762      |
| Signal type                   | `'COMPLETE'`                                            | `packages/core/src/parser/agent-parser.ts`       | 1863      |
| Handoff return                | `false`                                                 | `packages/core/src/parser/agent-based-parser.ts` | 1623      |
| Supervisor language           | `'en'`                                                  | `packages/core/src/parser/supervisor-parser.ts`  | 1165      |
| Supervisor formality          | `'neutral'`                                             | `packages/core/src/parser/supervisor-parser.ts`  | 1166      |
| Supervisor canRespondDirectly | `false`                                                 | `packages/core/src/parser/supervisor-parser.ts`  | 1190      |
| Contract signal enum          | `['CONTINUE', 'COMPLETE', 'HANDOFF_READY', 'ESCALATE']` | `packages/core/src/parser/agent-parser.ts`       | 1405-1406 |
| Identity properties           | Empty strings/arrays                                    | `packages/core/src/parser/agent-parser.ts`       | 1395-1400 |
| READS → persistent memory     | Implicit mapping                                        | `packages/core/src/parser/agent-based-parser.ts` | 1384-1391 |

#### Compiler Defaults

| Default                          | Value                  | File                                                                        | Line |
| -------------------------------- | ---------------------- | --------------------------------------------------------------------------- | ---- |
| Tool timeout                     | `30,000ms`             | `packages/compiler/src/platform/ir/compiler.ts`                             | 100  |
| LLM timeout                      | `30,000ms`             | `packages/compiler/src/platform/ir/compiler.ts`                             | 101  |
| Session idle timeout             | `1,800,000ms` (30 min) | `packages/compiler/src/platform/ir/compiler.ts`                             | 102  |
| Voice latency (scripted)         | `500ms`                | `packages/compiler/src/platform/ir/compiler.ts`                             | 103  |
| Voice latency (reasoning)        | `1,000ms`              | `packages/compiler/src/platform/ir/compiler.ts`                             | 104  |
| Tool cacheable                   | `false`                | `packages/compiler/src/platform/ir/compiler.ts`                             | 201  |
| Tool latency                     | `'medium'`             | `packages/compiler/src/platform/ir/compiler.ts`                             | 202  |
| Tool side_effects                | `true`                 | `packages/compiler/src/platform/ir/compiler.ts`                             | 204  |
| Tool requires_auth               | `false`                | `packages/compiler/src/platform/ir/compiler.ts`                             | 205  |
| Persistent memory access         | `'readwrite'`          | `packages/compiler/src/platform/ir/compiler.ts`                             | 243  |
| Error retry count                | `1`                    | `packages/compiler/src/platform/ir/compiler.ts`                             | 414  |
| Error retry delay                | `1,000ms`              | `packages/compiler/src/platform/ir/compiler.ts`                             | 405  |
| Intent classification confidence | `0.5`                  | `packages/compiler/src/platform/ir/compiler.ts`                             | 168  |
| Flow max iterations              | `100`                  | `packages/compiler/src/platform/constructs/executors/flow-executor.ts`      | 119  |
| Reasoning max iterations         | `10`                   | `packages/compiler/src/platform/constructs/executors/reasoning-executor.ts` | 88   |

#### Runtime Defaults

| Default                    | Value                          | File                                             | Line     |
| -------------------------- | ------------------------------ | ------------------------------------------------ | -------- |
| LLM model                  | `'claude-3-5-haiku-20241022'`  | `apps/platform/src/services/runtime-executor.ts` | 353, 438 |
| LLM max_tokens             | `2048`                         | `apps/platform/src/services/runtime-executor.ts` | 372      |
| Initial conversation phase | `'start'`                      | `apps/platform/src/services/runtime-executor.ts` | 537      |
| Default gather prompt      | `"Please provide: {{fields}}"` | `apps/platform/src/services/runtime-executor.ts` | 2003     |
| Reasoning max iterations   | `10`                           | `apps/platform/src/services/runtime-executor.ts` | 2903     |

**Mismatch detected**: Guardrail action defaults to `'warn'` in the parser (`agent-based-parser.ts:2330`) but `'block'` in the compiler (`compiler.ts` guardrail mapping). These are inconsistent.

---

### 3.2 Magic Strings & Hardcoded Identifiers

Strings that control execution flow but aren't declared in any schema:

| Magic String                               | Effect                                                     | File                     | Line      |
| ------------------------------------------ | ---------------------------------------------------------- | ------------------------ | --------- |
| `'COMPLETE'` (step name)                   | Terminates flow execution                                  | `runtime-executor.ts`    | 903, 1637 |
| `'Fallback_Handler'`                       | Default supervisor fallback agent name                     | `compiler.ts`            | 164       |
| `'always'` (phase label)                   | Conventional label authors use for broad constraint groups | `constraint-executor.ts` | 114-121   |
| `'true'` (applies_when)                    | Constraint condition that always passes                    | `constraint-executor.ts` | 117       |
| `'_summary'`                               | Handoff context summary storage key                        | `handoff-executor.ts`    | 242       |
| `'_stored_{{key}}'`                        | Completion store context key pattern                       | `runtime-executor.ts`    | 3927      |
| `'_error'`                                 | Tool failure flag in result objects                        | `runtime-executor.ts`    | 1544      |
| `'_correction'`                            | Unknown field correction fallback key                      | `runtime-executor.ts`    | 1923      |
| `'greeting'`, `'farewell'`, `'escalation'` | Auto-injected supervisor intent categories                 | `compiler.ts`            | 695-697   |
| `'hotels'`, `'results'`                    | Empty array = tool failure                                 | `runtime-executor.ts`    | 1545-1547 |
| `'supervisor'`                             | Default handoff escalation target                          | `constraint-executor.ts` | 264       |

---

### 3.3 Implicit Inference Rules

Places where the system infers behavior from heuristics rather than explicit declaration:

#### 3.3.1 Model Selection (fully implicit)

**File**: `packages/compiler/src/platform/constructs/model-selector.ts`

Complexity score calculated with hardcoded weights:

| Factor                                                                                                               | Score Range | Lines   |
| -------------------------------------------------------------------------------------------------------------------- | ----------- | ------- |
| Tool count: 0 → 0, 1-2 → 10, 3-5 → 15, 6+ → 25                                                                       | 0-25        | 112-116 |
| Gather fields: 0-3 → 5, 4-6 → 10, 7+ → 15                                                                            | 5-15        | 118-121 |
| Constraints: 0-2 → 5, 3-5 → 10, 6+ → 15                                                                              | 5-15        | 123-126 |
| Coordination present → 20                                                                                            | 0-20        | 128-129 |
| Operation type: extraction(5), validation(10), response_gen(10), tool_selection(15), reasoning(20), coordination(25) | 5-25        | 131-151 |

Tier thresholds (lines 176-181):

- Score ≤ 30 → `haiku`
- Score ≤ 60 → `sonnet`
- Score > 60 → `opus`

**No ABL signal exists to override model selection.**

#### 3.3.2 Runtime Deployment Recommendations (fully implicit)

**File**: `packages/compiler/src/platform/ir/compiler.ts`, lines 638-681

```
HITL capable    → 'workflow'
Voice optimized → 'voice'
Otherwise       → 'digital'
```

#### 3.3.3 Voice Optimization Inference

**File**: `packages/compiler/src/platform/ir/compiler.ts`, lines 623-636

```
voice_optimized    = scripted mode AND no complex coordination
requires_persistence = persistent memory OR returning handoffs
complexity         = delegates or >2 handoffs ? 'complex' : >2 constraints ? 'moderate' : 'simple'
```

#### 3.3.4 Entry Point Inference

**Files**: `agent-parser.ts:1432-1434`, `compiler.ts:609`

Defaults to first step in flow definition if not explicitly declared.

#### 3.3.5 Routing Priority Inference

**File**: `compiler.ts:145-151`

Priority = `index + 1` (order of appearance in HANDOFF declarations). No explicit `PRIORITY` keyword exists.

#### 3.3.6 Entity Type Detection by Field Name

**File**: `runtime-executor.ts:2067-2084`

| Field name contains               | Inferred type |
| --------------------------------- | ------------- |
| `destination`, `city`, `location` | string (city) |
| `checkin`, `check_in`             | date          |
| `checkout`, `check_out`           | date          |
| `guest`, `people`, `person`       | number        |
| `room`                            | number        |
| `night`, `day`                    | number        |
| `email`                           | email         |
| `phone`                           | phone number  |

This is pure heuristic matching, not driven by GATHER field declarations.

---

### 3.4 Hardcoded Behavioral Logic

#### 3.4.1 Executor Pipeline Order (fixed, not configurable)

**File**: `packages/compiler/src/platform/constructs/executor.ts`, lines 113-124, 168-327

```
Memory Recall
  → Gather
    → [Scripted: Flow] OR [Reasoning: Constraints → Reasoning → Delegates → Escalation → Handoffs → Completion]
      → Memory Remember
```

This order is identical for every agent. Kore.ai supports pre-processors and post-processors that run custom code at each stage.

#### 3.4.2 Supervisor "Never Respond Directly" Enforcement

**File**: `runtime-executor.ts:3244-3275, 4031-4051`

Supervisors receive hardcoded instructions injected into the system prompt:

- `"ROUTING-ONLY supervisor"`
- `"NEVER respond without using __handoff__"`
- Hardcoded routing examples (greeting/travel/manage/human/goodbye/unclear)

While `canRespondDirectly: false` is in the parser, the enforcement is entirely through hardcoded prompt text, not through action filtering.

#### 3.4.3 Terminal Action Detection

**File**: `executor.ts:489-491`

```typescript
return ['complete', 'escalate', 'handoff', 'block'].includes(action.type);
```

Hardcoded list. Not extensible from ABL.

#### 3.4.4 Action Response Requirement

**File**: `executor.ts:496-498`

```typescript
return ['respond', 'collect', 'complete', 'escalate', 'block'].includes(action.type);
```

Hardcoded list of actions that require user response.

#### 3.4.5 Call Success Detection

**File**: `runtime-executor.ts:1544-1547`

```typescript
if (callResult._error) {
  callSuccess = false;
} else if (callResult.hotels !== undefined && callResult.hotels.length === 0) {
  callSuccess = false;
} else if (callResult.results !== undefined && callResult.results.length === 0) {
  callSuccess = false;
}
```

The field names `hotels` and `results` are literally hardcoded as failure detection heuristics. This is domain-specific (hotel booking) contamination in the generic runtime.

#### 3.4.6 Flow Auto-Advancement

**File**: `runtime-executor.ts:1637-1647`

After executing CALL/response/transition, the system auto-advances to the next step with an empty message. This implicit behavior is not documented or configurable.

#### 3.4.7 Handoff Validation

**File**: `runtime-executor.ts:3176-3191`

Self-handoff prevention and target validation are hardcoded in the runtime, not expressed as constraints in the IR.

---

### 3.5 English-Only Intent & Correction Matching

#### 3.5.1 Intent Keywords

**File**: `runtime-executor.ts:2678-2684`

| Intent   | Hardcoded English Keywords                              |
| -------- | ------------------------------------------------------- |
| `back`   | back, go back, previous, return                         |
| `cancel` | cancel, nevermind, forget it, stop                      |
| `change` | change, modify, update, edit, different                 |
| `help`   | help, assist, support, confused, assistance             |
| `yes`    | yes, yeah, yep, sure, ok, okay, correct, right, confirm |
| `no`     | no, nope, nah, not, wrong, incorrect                    |

**37 keywords total, all English**. The Kore.ai Saludsa agent operates entirely in Spanish.

#### 3.5.2 Correction Detection Patterns

**File**: `runtime-executor.ts:1896-1902`

```regex
/^actually[,]?\s+(.+)$/i
/^no[,]?\s+(?:it'?s?|make it|change (?:it )?to)?\s*(.+)$/i
/^(?:i meant|change (?:it )?to|make it)\s+(.+)$/i
/^not\s+\w+[,]?\s+(.+)$/i
/^(\d+)\s+(?:guests?|people|rooms?|nights?)\s+(?:instead|not\s+\d+)$/i
```

All 5 patterns are English-only. Pattern 5 contains domain-specific terms (`guests`, `rooms`, `nights`).

#### 3.5.3 Hardcoded Field Name Assumptions

**File**: `runtime-executor.ts:2059`

```typescript
('nights', 'num_nights', 'checkin_date', 'checkout_date', 'num_guests', 'num_rooms');
```

Hotel-booking field names hardcoded as "common fields" for entity extraction.

---

### 3.6 Hardcoded Error & Response Messages

| Message                                                  | File                     | Line |
| -------------------------------------------------------- | ------------------------ | ---- |
| `"An error occurred. Please try again."`                 | `compiler.ts`            | 413  |
| `"I cannot proceed with that request."`                  | `constraint-executor.ts` | 251  |
| `"Constraint violation"` (escalation reason)             | `constraint-executor.ts` | 256  |
| `"Please provide: {{fields}}"`                           | `runtime-executor.ts`    | 2003 |
| `"Escalated to Human Agent\nReason: ...\nPriority: ..."` | `runtime-executor.ts`    | 3594 |
| `"Invalid handoff target: '{{target}}'"`                 | `runtime-executor.ts`    | 3181 |
| `"Cannot hand off to yourself"`                          | `runtime-executor.ts`    | 3189 |
| `"This conversation has been completed"`                 | `runtime-executor.ts`    | 785  |
| `"Execute the {{toolName}} tool"` (fallback desc)        | `runtime-executor.ts`    | 4177 |

All English. No localization mechanism.

---

### 3.7 Type Coercion & Evaluation Inconsistencies

**Both the compiler and runtime implement condition evaluation independently.**

#### Compiler Evaluator (`evaluator.ts`)

| Rule                                                                   | Lines   |
| ---------------------------------------------------------------------- | ------- |
| Empty condition = `true`                                               | 164     |
| `null != null` = `true` (both undefined are "different")               | -       |
| Arrays coerce to `.length` for numeric comparison                      | -       |
| Truthy: null/undefined → false, 0 → false, '' → false, 'false' → false | 435-443 |
| Template truthy: same rules, separate implementation                   | 724-732 |

#### Runtime Evaluator (`runtime-executor.ts`)

| Rule                                                                                                                     | Lines     |
| ------------------------------------------------------------------------------------------------------------------------ | --------- |
| `==` is case-insensitive for strings                                                                                     | 2501-2722 |
| `undefined` variables in constraints **silently pass** (e.g., `num_guests <= 10` is `true` if `num_guests` is undefined) | 2650      |
| Numeric coercion: `"5" == 5` is `true`                                                                                   | 2632-2645 |

#### Gather Type Normalization (`gather-executor.ts:252-284`)

| Type    | Coercion                                                                 |
| ------- | ------------------------------------------------------------------------ |
| boolean | 'yes'/'no'/'true'/'false'/'si'/'correct'/'affirmative'/'1'/'0' → boolean |
| number  | Strip non-numeric chars, parseFloat                                      |
| date    | Trim only (no parsing)                                                   |
| string  | Trim, toString                                                           |

**Risk**: The compiler and runtime have overlapping but **not identical** evaluation logic. The boolean coercion in the gather executor accepts 'si'/'sí' but the compiler evaluator does not.

---

### 3.8 Domain-Specific Mock Contamination

**File**: `runtime-executor.ts:171-230+`

9 hardcoded mock tools with hotel/travel/medical domain data embedded in the production runtime path:

| Mock Tool            | Hardcoded Data                                                                  |
| -------------------- | ------------------------------------------------------------------------------- |
| `greet_user`         | Template: `"Hello, {{name \|\| 'there'}}! Nice to meet you!"`                   |
| `search_hotels`      | 3 hotels: "Grand Hotel Paris" ($180), "City Inn" ($95), "Comfort Suites" ($120) |
| `get_hotel_details`  | "Grand Hotel Paris", 4.8 rating, 1247 reviews                                   |
| `check_availability` | Always available, $180/night                                                    |
| `book_hotel`         | Confirmation prefix `HTL-`                                                      |
| `search_flights`     | United ($320), Delta ($285), American ($299)                                    |
| `book_flight`        | Confirmation prefix `FLT-`                                                      |
| `check_symptoms`     | Urgency: 'low', hardcoded conditions                                            |
| Generic bookings     | Confirmation prefix `BK-`                                                       |

These are not behind a test flag. They execute in the production code path as fallbacks.

---

### 3.9 Auto-Generated System Prompts

**Files**: `compiler.ts:702-726`, `runtime-executor.ts:3989-4098`

Both layers construct system prompts with hardcoded structure:

```
"You are {{name}}, an AI assistant."
+ GOAL section
+ PERSONA section (default: "Professional and helpful")
+ LIMITATIONS list (if defined)
+ Tools availability notice
+ GATHER instructions: "you need to gather..." / "once you have all...use __complete__"
+ Supervisor routing: "ROUTING-ONLY" instructions with hardcoded examples
+ Escalation triggers
+ Completion conditions
+ Current context as JSON dump
```

**Problems**:

1. No way for ABL to customize prompt structure or ordering
2. Default persona "Professional and helpful" overrides empty persona declarations
3. Supervisor examples are hardcoded English ("greeting", "travel", "manage booking")
4. Entity extraction prompt (`runtime-executor.ts:2118`) contains hardcoded instructions with domain examples ("Barcelona", "3 nights")

---

### 3.10 Auto-Injected Tools

**File**: `runtime-executor.ts:4243-4326`

Four tools are auto-injected into every agent without any ABL declaration:

| Tool           | Condition                                        | Lines     |
| -------------- | ------------------------------------------------ | --------- |
| `__handoff__`  | Agent has handoff targets                        | 4243-4260 |
| `__delegate__` | Agent has delegate configs                       | 4271-4288 |
| `__complete__` | Agent has completion conditions or gather fields | 4297-4313 |
| `__escalate__` | Always injected                                  | 4318-4326 |

`__escalate__` has a hardcoded priority enum: `['low', 'medium', 'high', 'critical']`.

The descriptions and parameter schemas of these tools are all hardcoded English strings.

---

## 4. Implementation Plan

### Phase 1: Declarative Configuration Surface (P0 — Critical)

Expose configuration knobs that are currently hardcoded. This doesn't change behavior — it makes existing defaults overridable.

#### 1.1 Add EXECUTION Block to ABL Grammar

**Files to modify**:

- `packages/core/src/parser/agent-based-parser.ts` — Add EXECUTION section parsing
- `packages/core/src/parser/lexer.ts` — Add tokens if needed
- `packages/compiler/src/platform/ir/schema.ts` — Add execution config to IR
- `packages/compiler/src/platform/ir/compiler.ts` — Wire parsed values to IR

**ABL syntax**:

```
EXECUTION:
  model: "claude-sonnet-4-5-20250929"
  temperature: 0.3
  max_tokens: 4096
  tool_timeout: 45000
  llm_timeout: 60000
  session_idle_timeout: 3600000
  max_reasoning_iterations: 15
  max_flow_iterations: 200
  voice_latency_target: 600
  fallback_model: "claude-haiku-4-5-20251001"
```

**Defaults preserved**: Current hardcoded values become the defaults when EXECUTION block is absent.

**Estimated scope**: ~200 lines parser, ~50 lines compiler, ~30 lines schema. Tests: ~40.

#### 1.2 Add HINTS to Tool Declarations

**Files to modify**:

- `packages/core/src/parser/agent-based-parser.ts` — Parse HINTS sub-block in TOOLS
- `packages/compiler/src/platform/ir/compiler.ts` — Pass through instead of hardcoding

**ABL syntax**:

```
TOOLS:
  search_database:
    description: "Search the database"
    cacheable: true
    latency: low
    parallelizable: true
    side_effects: false
    requires_auth: true
    timeout: 10000
    params:
      query: string
```

**Estimated scope**: ~60 lines parser, ~20 lines compiler. Tests: ~15.

#### 1.3 Add ON_ERROR Retry Delay and Defaults Override

**Files to modify**:

- `packages/core/src/parser/agent-based-parser.ts` — Parse `retry_delay` in ON_ERROR
- `packages/compiler/src/platform/ir/compiler.ts` — Pass through to IR

**ABL syntax**:

```
ON_ERROR:
  default:
    respond: "Lo sentimos, ocurrió un error. Por favor intente de nuevo."
    retry: 3
    retry_delay: 2000
    then: escalate
  tool_timeout:
    respond: "El servicio está tardando. Un momento..."
    retry: 2
    retry_delay: 5000
    then: continue
```

**Estimated scope**: ~30 lines parser, ~15 lines compiler. Tests: ~10.

#### 1.4 Add CONFIDENCE_THRESHOLD to Supervisor

**Files to modify**:

- `packages/core/src/parser/supervisor-parser.ts` — Parse confidence setting
- `packages/compiler/src/platform/ir/compiler.ts` — Wire to IR

**ABL syntax**:

```
SUPERVISOR my_supervisor:
  ROUTING:
    confidence_threshold: 0.7
    use_llm: true
    ...
```

**Estimated scope**: ~20 lines parser, ~10 lines compiler. Tests: ~8.

---

### Phase 2: Eliminate Magic Strings & Domain Contamination (P0)

#### 2.1 Remove Domain-Specific Mock Tools from Runtime

**File to modify**: `apps/platform/src/services/runtime-executor.ts`, lines 171-315

**Action**:

1. Extract mock tools into a separate `mock-tools.ts` module
2. Gate behind a `NODE_ENV === 'test'` or explicit `enableMocks: true` config flag
3. Remove hotel/flight/symptom hardcoded data from production path
4. Replace the `hotels` and `results` empty-array failure check (line 1544-1547) with a generic `_error` flag check or a declarative `success_condition` on the tool

**Estimated scope**: ~150 lines moved, ~20 lines runtime changes. Tests: update ~10 existing.

#### 2.2 Replace Magic String Constants with Enum/Config

**Files to modify**: Multiple across compiler and runtime

| Magic String                                             | Replacement                                                           |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| `'COMPLETE'` step name                                   | Export constant `TERMINAL_STEP = 'COMPLETE'` from shared types        |
| `'Fallback_Handler'`                                     | Read from supervisor IR config, default in schema                     |
| `'always'` phase                                         | Export constant `ALWAYS_PHASE = 'always'`                             |
| `'_summary'`, `'_stored_*'`, `'_error'`, `'_correction'` | Export from shared constants module                                   |
| `'greeting'`, `'farewell'`, `'escalation'`               | Move to supervisor IR config with explicit `default_categories` field |
| `'supervisor'` (handoff target)                          | Read from IR escalation config                                        |

**Estimated scope**: ~40 lines new constants file, ~80 lines refactoring across files. Tests: ~15.

---

### Phase 3: Externalize Intent & Correction Patterns (P0)

#### 3.1 Make Intent Keywords Declarative

**Current**: Hardcoded English keywords in `runtime-executor.ts:2678-2684`

**Target**: Intent keywords come from the IR, populated from ABL DIGRESSIONS or a new INTENTS section.

**Files to modify**:

- `packages/core/src/parser/agent-based-parser.ts` — Allow intent keyword customization
- `packages/compiler/src/platform/ir/schema.ts` — Add intent keywords to IR
- `packages/compiler/src/platform/ir/compiler.ts` — Compile keywords from DIGRESSIONS or defaults
- `apps/platform/src/services/runtime-executor.ts` — Read from IR instead of hardcoded map

**ABL syntax** (extends existing DIGRESSIONS):

```
DIGRESSIONS:
  cancel:
    keywords: ["cancelar", "olvidalo", "detener", "no quiero"]
    RESPOND: "Entendido, cancelamos la operación."
  help:
    keywords: ["ayuda", "no entiendo", "soporte"]
    RESPOND: "Estoy aquí para ayudarte..."
```

**Fallback**: If no keywords specified, use current English defaults (backward compatible).

**Estimated scope**: ~40 lines parser, ~30 lines compiler, ~50 lines runtime. Tests: ~20.

#### 3.2 Make Correction Patterns Configurable

**Current**: 5 hardcoded English regex patterns in `runtime-executor.ts:1896-1902`

**Target**: Correction patterns come from IR, with language-aware defaults.

**Files to modify**:

- `packages/compiler/src/platform/ir/schema.ts` — Add correction config to IR
- `packages/compiler/src/platform/ir/compiler.ts` — Compile correction patterns
- `apps/platform/src/services/runtime-executor.ts` — Read from IR

**ABL syntax** (in GATHER or top-level):

```
GATHER:
  corrections: true
  correction_patterns:
    - "^en realidad[,]?\s+(.+)$"
    - "^no[,]?\s+(?:es|son|quiero)\s*(.+)$"
    - "^(?:quise decir|cambiar a)\s+(.+)$"
```

**Estimated scope**: ~20 lines schema, ~20 lines compiler, ~30 lines runtime. Tests: ~12.

#### 3.3 Remove Hardcoded Field Name Heuristics

**Current**: `runtime-executor.ts:2059, 2067-2084` — Field type inferred from name substring

**Target**: Field types come exclusively from GATHER declarations in the IR. Remove all name-based heuristics.

**Files to modify**:

- `apps/platform/src/services/runtime-executor.ts` — Remove lines 2059-2084
- Ensure GATHER compilation passes explicit type and extraction hints to IR

**Estimated scope**: ~30 lines removed, ~15 lines added to compiler. Tests: ~10.

---

### Phase 4: Externalize Messages & Prompts (P1)

#### 4.1 Make Error/Response Messages Configurable

**Target**: All hardcoded messages come from IR with defaults in a messages config.

**Files to modify**:

- `packages/compiler/src/platform/ir/schema.ts` — Add `messages` config to IR
- `packages/compiler/src/platform/ir/compiler.ts` — Populate messages section
- All consumers — Read from IR messages

**IR schema addition**:

```typescript
interface AgentMessages {
  error_default: string; // "An error occurred. Please try again."
  constraint_blocked: string; // "I cannot proceed with that request."
  gather_prompt: string; // "Please provide: {{fields}}"
  escalation_format: string; // "Escalated to Human Agent..."
  conversation_complete: string; // "This conversation has been completed"
  invalid_handoff: string; // "Invalid handoff target: {{target}}"
  self_handoff: string; // "Cannot hand off to yourself"
  tool_fallback_desc: string; // "Execute the {{toolName}} tool"
}
```

**ABL syntax** (optional MESSAGES block):

```
MESSAGES:
  error_default: "Lo sentimos, ocurrió un error. Intente nuevamente."
  gather_prompt: "Por favor proporcione: {{fields}}"
  escalation_format: "Transferido a un agente humano. Razón: {{reason}}"
  conversation_complete: "Esta conversación ha finalizado."
```

**Estimated scope**: ~30 lines schema, ~40 lines compiler, ~60 lines runtime refactoring. Tests: ~15.

#### 4.2 Make System Prompt Template Customizable

**Current**: Hardcoded template in `compiler.ts:702-726` and `runtime-executor.ts:3989-4098`

**Target**: System prompt assembled from a configurable template. User can override sections or provide a full custom template.

**ABL syntax**:

```
SYSTEM_PROMPT:
  template: |
    Eres {{name}}, un asistente virtual de Saludsa.
    {{goal}}
    {{persona}}
    {{#if limitations}}
    RESTRICCIONES:
    {{limitations}}
    {{/if}}
    {{tools_section}}
    {{gather_section}}
    {{context_section}}
```

**Fallback**: If no SYSTEM_PROMPT block, use current hardcoded template.

**Estimated scope**: ~50 lines parser, ~40 lines compiler, ~80 lines runtime. Tests: ~20.

#### 4.3 Remove Domain-Specific Entity Extraction Prompts

**Current**: `runtime-executor.ts:2118+` contains extraction prompts with "Barcelona", "3 nights" examples

**Target**: Extraction prompt is generic or assembled from GATHER field metadata.

**Estimated scope**: ~30 lines runtime. Tests: ~8.

---

### Phase 5: Unify Evaluation Logic (P1)

#### 5.1 Single Condition Evaluator

**Current**: Both `packages/compiler/src/platform/constructs/evaluator.ts` and `apps/platform/src/services/runtime-executor.ts` implement condition evaluation independently with overlapping but inconsistent rules.

**Target**: Single evaluator in `@abl/compiler` used by both compiler constructs and runtime.

**Action**:

1. Consolidate into `packages/compiler/src/platform/constructs/evaluator.ts`
2. Runtime imports and uses the compiler evaluator
3. Document coercion rules explicitly
4. Decide: should undefined variables in constraints pass or fail? (Currently they silently pass — this is likely a bug)

**Estimated scope**: ~100 lines runtime removed, ~20 lines imports added. Tests: ~15 to verify parity.

#### 5.2 Document and Test Coercion Rules

Create explicit test suite for:

- Boolean string parsing (what strings are truthy?)
- Numeric coercion (when does string become number?)
- Undefined variable behavior in comparisons
- Case sensitivity in comparisons
- Array-to-number coercion

**Estimated scope**: ~80 lines of tests.

---

### Phase 6: Lifecycle Hooks & Channel Awareness (P1)

#### 6.1 Add Pre/Post Processor Hooks

**Target**: ABL supports declaring hooks that run before/after agent execution.

**ABL syntax**:

```
HOOKS:
  before_agent:
    CALL: validate_user(session.channel, session.phone)
    SET: userInfo = result
  after_agent:
    CALL: log_interaction(session.id, session.summary)
```

**Files to modify**:

- `packages/core/src/parser/agent-based-parser.ts` — Parse HOOKS section
- `packages/compiler/src/platform/ir/schema.ts` — Add hooks to IR
- `packages/compiler/src/platform/ir/compiler.ts` — Compile hooks
- `packages/compiler/src/platform/constructs/executor.ts` — Execute hooks in pipeline
- `apps/platform/src/services/runtime-executor.ts` — Wire hook execution

**Estimated scope**: ~100 lines parser, ~40 lines schema, ~50 lines compiler, ~80 lines runtime. Tests: ~25.

#### 6.2 Add Channel Context Variable

**Target**: Runtime provides a `session.channel` variable that agents can use in conditions.

**ABL syntax**:

```
FLOW:
  STEP validate_user:
    ON_INPUT:
      IF session.channel == "whatsapp":
        CALL: validate_security_questions(user.id)
        THEN: security_check
      ELSE:
        THEN: main_flow
```

**Files to modify**:

- `apps/platform/src/services/runtime-executor.ts` — Accept channel in session init
- `packages/compiler/src/platform/ir/schema.ts` — Add channel to session context

**Estimated scope**: ~20 lines runtime, ~10 lines schema. Tests: ~10.

---

### Phase 7: Expose Remaining Hidden Logic (P2)

#### 7.1 Make Executor Pipeline Order Configurable

**Current**: Fixed order in `executor.ts:113-124`

**Target**: Pipeline stages are declared in IR, with current order as default.

This is a larger architectural change. The executor should read stage order from the IR rather than having a hardcoded sequence.

**Estimated scope**: ~150 lines executor refactoring. Tests: ~30.

#### 7.2 Make Auto-Injected Tools Visible in IR

**Current**: `__handoff__`, `__delegate__`, `__complete__`, `__escalate__` injected at runtime

**Target**: These tools are generated during compilation and visible in the IR output. Users can customize descriptions and parameter schemas.

**Estimated scope**: ~60 lines compiler, ~40 lines runtime removed. Tests: ~15.

#### 7.3 Make Guardrail Action Mapping Explicit

**Current**: `'warn'` and `'redact'` both silently map to `'respond'` in compiler

**Target**: Each guardrail action has distinct behavior, or mapping is documented and configurable.

**Estimated scope**: ~30 lines compiler. Tests: ~10.

#### 7.4 Make Complexity Scoring Configurable

**Current**: Hardcoded weights in `model-selector.ts:109-154`

**Target**: Scoring weights configurable via platform config, not ABL (this is a platform concern, not per-agent).

**Estimated scope**: ~40 lines model-selector. Tests: ~10.

---

## 5. Priority Matrix

| Phase                                                 | Priority | Effort            | Impact                                                             | Dependencies | Status       |
| ----------------------------------------------------- | -------- | ----------------- | ------------------------------------------------------------------ | ------------ | ------------ |
| **Phase 1**: Declarative Configuration Surface        | P0       | Medium (2-3 days) | High — unblocks per-agent model config, timeouts, iteration limits | None         | **Complete** |
| **Phase 2**: Eliminate Magic Strings & Mocks          | P0       | Small (1 day)     | High — removes domain contamination, improves reliability          | None         | **Complete** |
| **Phase 3**: Externalize Intent & Correction Patterns | P0       | Medium (2 days)   | Critical — unblocks non-English deployment                         | None         | **Complete** |
| **Phase 4**: Externalize Messages & Prompts           | P1       | Medium (2-3 days) | High — unblocks localization                                       | Phase 3      | **Complete** |
| **Phase 5**: Unify Evaluation Logic                   | P1       | Medium (2 days)   | Medium — eliminates inconsistency bugs                             | None         | **Complete** |
| **Phase 6**: Lifecycle Hooks & Channel Awareness      | P1       | Large (3-4 days)  | High — unblocks Kore.ai feature parity                             | Phase 1      | **Complete** |
| **Phase 7**: Expose Remaining Hidden Logic            | P2       | Large (4-5 days)  | Medium — architectural cleanliness                                 | Phase 1-5    | **Complete** |

All 7 phases have been implemented. Key deliverables:

- **Phase 1**: EXECUTION block (model, temperature, timeouts), tool HINTS parsing, ON_ERROR retry_delay, supervisor confidence_threshold wired through IR
- **Phase 2**: Magic strings extracted to `constants.ts`, mock tools gated behind config flag
- **Phase 3**: Digression keywords configurable, correction patterns configurable, field name heuristics removed
- **Phase 4**: MESSAGES block (configurable error/prompt/completion messages), system prompt template, domain-specific examples replaced with generic ones
- **Phase 5**: `is_number` operator added, `evaluateConditionWithInput`/`evaluateConditionDetailed` exported, runtime's ~407-line duplicate evaluateCondition removed in favor of compiler's unified evaluator, 20 new tests (372 total)
- **Phase 6**: `before_turn`/`after_turn` hooks with call/set/respond actions, `channel` context variable in session init
- **Phase 7**: Configurable pipeline order via `pipeline_order` in IR, system tools (`__handoff__`, `__delegate__`, `__complete__`, `__escalate__`) generated at compile time, `redact` constraint action, complexity weights configurable

---

## Appendix: Files Referenced

### Parser

- `packages/core/src/parser/agent-based-parser.ts`
- `packages/core/src/parser/agent-parser.ts`
- `packages/core/src/parser/supervisor-parser.ts`
- `packages/core/src/parser/expression-parser.ts`
- `packages/core/src/parser/lexer.ts`

### Compiler

- `packages/compiler/src/platform/ir/compiler.ts`
- `packages/compiler/src/platform/ir/schema.ts`
- `packages/compiler/src/platform/ir/graph-extractor.ts`
- `packages/compiler/src/platform/ir/app-graph-extractor.ts`
- `packages/compiler/src/platform/constructs/executor.ts`
- `packages/compiler/src/platform/constructs/evaluator.ts`
- `packages/compiler/src/platform/constructs/model-selector.ts`
- `packages/compiler/src/platform/constructs/executors/flow-executor.ts`
- `packages/compiler/src/platform/constructs/executors/reasoning-executor.ts`
- `packages/compiler/src/platform/constructs/executors/gather-executor.ts`
- `packages/compiler/src/platform/constructs/executors/constraint-executor.ts`
- `packages/compiler/src/platform/constructs/executors/handoff-executor.ts`
- `packages/compiler/src/platform/constructs/executors/complete-executor.ts`

### Runtime

- `apps/platform/src/services/runtime-executor.ts`

### Kore.ai Export

- `tmp/app-saludsa_app_temp-05-02-2026-20-19-52.json`
