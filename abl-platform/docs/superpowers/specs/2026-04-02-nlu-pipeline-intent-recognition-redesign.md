# NLU Pipeline Intent Recognition Redesign

**Date:** 2026-04-02
**Status:** Design Approved
**Branch:** `feature/nlu-pipeline-enhancements`
**Prerequisite reading:** `/Users/Thiru/researchWS/abl-review/NLU/pipeline-intent-recognition-gaps.md`

---

## 1. Problem Statement

The NLU pipeline's intent recognition has 11 identified gaps (documented in the prerequisite gap analysis). The root cause is a wrong separation of concerns: the LLM evaluates boolean logic (CEL expressions in WHEN conditions) that the system should handle deterministically, while the system reverse-engineers semantic information (intent categories) that the LLM already knows.

### Core issues

1. **Classifier prompt sends raw WHEN conditions** — The LLM receives `Use when: intent.category == "device_issue" OR intent.category == "troubleshooting"` and interprets programmatic boolean logic. This is non-deterministic and degrades with scale.
2. **Classifier returns target, not category** — The output schema asks for `target: "Device_Support"` but discards the LLM's category-level understanding.
3. **Intent bridge reverse-engineers category from target** — `resolveIntentCategory()` picks `categories[0]` from a regex-built reverse map. Lossy and order-dependent.
4. **Tools not rebuilt after intent bridge** — `session.data.values.intent` is set but `buildTools()` is never re-called, so WHEN pre-filtering never uses the classified intent.
5. **Triple parsing waste** — Categories are extracted independently by the compiler, intent bridge, and prompt builder. None produce a usable result.
6. **`resolveIntentCategory()` output is dead data** — Stored in session but zero functional consumers read it.
7. **Multiple WHENs to same target are suppressed** — `buildTools()` deduplicates by tool name, so only the first rule's description reaches the LLM. Common pattern in production agents (travel, saludsa examples).

### Design principle

**The LLM classifies. The system routes.**

The classifier's job is purely semantic: "given the user message, which category label best matches?" The system's job is deterministic: "given the category, which routing rule's WHEN condition evaluates to true?" This separation plays to each component's strength.

---

## 2. Decisions Log

| #   | Question                                                                         | Decision                                                                                            | Rationale                                                                                                                                                                        |
| --- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Scope                                                                            | Full redesign — all 11 gaps + ABL language extension                                                | Gaps are deeply interconnected; incremental fixes would break the existing (broken) flow                                                                                         |
| 2   | Mixed WHEN variables (`intent.category == "billing" AND user.tier == "premium"`) | Evaluate fully via `evaluateConditionDual()`                                                        | Simpler, correct behavior — if non-intent vars aren't set, null injection handles it. A rule requiring both conditions SHOULD fail if one isn't met                              |
| 3   | IR schema for categories                                                         | Fix flat extraction (`matchAll`, all sources) → `IntentCategory[]` with name + optional description | Target→categories map not needed — classifier returns category, system evaluates WHEN to find target                                                                             |
| 4   | Target/category mismatch from classifier                                         | Moot                                                                                                | Classifier doesn't return target — only category. No mismatch possible                                                                                                           |
| 5   | Classifier output                                                                | Category only — no target in prompt or output                                                       | Target is an application routing concern, not a classification concern. Should not influence LLM's intent recognition                                                            |
| 6   | Category descriptions in prompt                                                  | Names only for now. Future `INTENTS:` ABL section adds descriptions                                 | Description-to-category mapping is many-to-many (same category in multiple rules, same rule with multiple categories). Flat names avoid this. Semantic names are self-describing |
| 7   | Multi-intent support                                                             | Classifier returns multiple categories                                                              | Existing multi-intent infrastructure (fan-out, disambiguation, queuing) consumes the results. Each category independently evaluated against routing rules                        |
| 8   | `use_llm` field in IR                                                            | Remove — dead data                                                                                  | Always hardcoded to `true`. Pipeline enabled/disabled controlled by project runtime config, not IR                                                                               |

---

## 3. ABL Language Extension — `INTENTS:` Section

### 3.1 Syntax

A new optional top-level block in supervisor `.agent.abl` files:

```
INTENTS:
  device_issue: "Customer has a hardware or software problem with their device"
  troubleshooting: "Customer needs step-by-step help diagnosing an issue"
  setup: "Customer needs help setting up a new device or feature"
  billing: "Customer asking about charges, invoices, or payment methods"
  escalation: "Customer wants to speak to a human agent"
```

### 3.2 Rules

- Each entry is `category_name: "description"` (description is a quoted string)
- Category names must be valid identifiers (alphanumeric + underscore)
- Descriptions are optional — `setup` without a description is valid (falls back to name-as-description)
- The block is **optional** — if omitted, the compiler falls back to extracting categories from WHEN conditions. This ensures full backward compatibility with all existing ABL files.
- Only valid on supervisor agents (where routing happens). Ignored on regular agents.

### 3.3 Interaction with WHEN conditions

If `INTENTS:` is declared, the compiler validates that every `intent.category == "X"` referenced in WHEN conditions uses a category defined in the `INTENTS:` block. Unknown categories produce a **compile warning** (not error — to avoid breaking existing projects during migration).

If `INTENTS:` is NOT declared, the compiler extracts categories from WHEN conditions as today (but fixed with `matchAll` + all sources).

---

## 4. Compiler Changes

### 4.1 `extractIntentCategories()` — Rewrite

**Current behavior (broken):**

- Uses `.match()` — first match only per WHEN string
- Only parses handoffs, not routing rules or delegates
- Returns flat `string[]`

**New behavior:**

- **If `INTENTS:` block exists**: Parse the block, produce `IntentCategory[]` with names and descriptions. Set `source: 'explicit'`.
- **If no `INTENTS:` block (fallback)**: Use `.matchAll()` regex on ALL WHEN conditions (routing rules + handoffs + delegates). Produce `IntentCategory[]` with names only (no descriptions). Merge with `DEFAULT_INTENT_CATEGORIES`. Set `source: 'inferred'`.

### 4.2 ABL Parser Addition

The parser recognizes the `INTENTS:` keyword and parses key-value pairs. This follows the same indented-entries pattern used by existing blocks like `LIMITATIONS:` and `MEMORY:`.

### 4.3 Validation

When `source: 'explicit'`, the compiler walks all WHEN conditions across routing rules, handoffs, and delegates. Every `intent.category == "X"` reference is checked against the declared categories. Undeclared categories produce a **warning** in compiler output (visible in Studio), not a hard error.

### 4.4 IR Schema Change

```typescript
// Before
interface IntentConfig {
  use_llm: boolean;
  categories: string[];
  min_confidence: number;
}

// After
interface IntentConfig {
  categories: IntentCategory[];
  min_confidence: number;
  source: 'explicit' | 'inferred';
}

interface IntentCategory {
  name: string;
  description?: string;
}
```

**Changes:**

- `use_llm` removed — dead data. Always `true`, never read at runtime. Pipeline enabled/disabled is controlled by project runtime config (`pipeline.enabled`), not the IR.
- `categories` changes from `string[]` to `IntentCategory[]` — carries optional descriptions from `INTENTS:` block.
- `source` added — tells the runtime whether categories came from explicit declaration or WHEN inference.

### 4.5 Backward-Compatible Migration Shim

For agents compiled before this change, the runtime applies a one-liner migration:

```typescript
const categories: IntentCategory[] = agentIR.routing.intent_classification.categories.map((c) =>
  typeof c === 'string' ? { name: c } : c,
);
```

Old `string[]` IR works. New `IntentCategory[]` IR works. No forced recompilation.

---

## 5. Classifier Prompt & Output Schema

### 5.1 New Classifier Prompt

When `source: 'explicit'` (categories have descriptions):

```
You are an intent classifier. Identify the user's intent from the categories below.

Categories:
  device_issue — "Customer has a hardware or software problem with their device"
  troubleshooting — "Customer needs step-by-step help diagnosing an issue"
  setup — "Customer needs help setting up a new device or feature"
  billing — "Customer asking about charges, invoices, or payment methods"
  escalation — "Customer wants to speak to a human agent"

Rules:
- Return the category that best matches the user message
- If NONE match, set category to null
- If MULTIPLE distinct intents are detected, return one entry per intent
- Confidence 0.0-1.0

User message: "How do I set up Face ID?"

Respond with ONLY valid JSON (no markdown):
{"intents":[{"category":"<category or null>","confidence":<0.0-1.0>,"summary":"<the specific sub-request>"}]}
```

When `source: 'inferred'` (no descriptions):

```
You are an intent classifier. Identify the user's intent from the categories below.

Categories: device_issue, troubleshooting, setup, billing, escalation

Rules:
- Return the category that best matches the user message
- If NONE match, set category to null
- If MULTIPLE distinct intents are detected, return one entry per intent
- Confidence 0.0-1.0

User message: "How do I set up Face ID?"

Respond with ONLY valid JSON (no markdown):
{"intents":[{"category":"<category or null>","confidence":<0.0-1.0>,"summary":"<the specific sub-request>"}]}
```

**Key changes from current prompt:**

- No targets — no `Available agent targets:` line
- No raw WHEN strings — no `Use when: intent.category == "X" OR ...`
- No `should_execute_in_agent` or `matched_tools` in output — those are tool-filter concerns, not classifier concerns
- Categories with descriptions when `source: 'explicit'`, names only when `source: 'inferred'`

### 5.2 New Output Types

```typescript
// Before
interface ClassifiedIntent {
  target: string | null;
  confidence: number;
  summary: string;
}

// After
interface ClassifiedIntent {
  category: string | null;
  confidence: number;
  summary: string;
}
```

`target` replaced by `category`.

```typescript
// Before
interface ClassifierResult {
  intents: ClassifiedIntent[];
  shouldExecuteInAgent: boolean;
  matchedTools: string[];
}

// After
interface ClassifierResult {
  intents: ClassifiedIntent[];
}
```

`shouldExecuteInAgent` and `matchedTools` removed — those were tool-filter output, not classifier output.

### 5.3 `classify()` Function Signature

```typescript
// Before
classify(model, userMessage, targets, toolNames, config, onTraceEvent, routingDescriptions)

// After
classify(model, userMessage, categories: IntentCategory[], config, onTraceEvent)
```

No more `targets`, `toolNames`, or `routingDescriptions` — the classifier only needs the category vocabulary.

### 5.4 `parseClassifierResponse()` Changes

- Parses `category` instead of `target`
- Validates the returned category exists in the known categories list via `Set.has()` — if not, sets category to `null` (LLM hallucinated a category)
- No longer parses `should_execute_in_agent` or `matched_tools`

---

## 6. Routing Resolver — System-Side WHEN Evaluation

This is the new component that replaces "LLM interprets WHEN conditions." A thin function that connects classifier output → session state → existing CEL evaluator → routing decision.

### 6.1 New Function: `resolveRouting()`

Lives in a new file: `apps/runtime/src/services/pipeline/routing-resolver.ts`

```typescript
interface RoutingMatch {
  target: string;
  rule: RoutingRule;
}

function resolveRouting(
  intents: ClassifiedIntent[],
  rules: RoutingRule[],
  sessionValues: Record<string, unknown>,
  onTraceEvent?: OnTraceEvent,
): RoutingMatch[];
```

### 6.2 Algorithm

1. For each classified intent (sorted by confidence descending):
   a. Set `sessionValues.intent = { category: intent.category, confidence: intent.confidence }` temporarily for evaluation
   b. Iterate routing rules sorted by priority (lower number = higher priority)
   c. For each rule, call `evaluateConditionDual(rule.when, sessionValues)` — the existing CEL evaluator
   d. First matching rule → produce a `RoutingMatch` for this intent
   e. No match → this intent has no routable target (stays with supervisor)
2. Return all `RoutingMatch` results
3. Emit trace event with evaluation details (which rules were checked, which matched, which failed and why)

### 6.3 Key Properties

- **Uses existing `evaluateConditionDual()`** — no new evaluator needed. The platform's 4-layer CEL evaluation stack (raw CEL → legacy ABL → dual evaluator → null-safe wrapper) handles all WHEN patterns.
- **Evaluates the complete WHEN** including non-intent variables. If `user.tier` is missing, the dual evaluator's `injectMissingAsNull` handles it — `null == "premium"` evaluates to `false`, so the AND fails. This is correct behavior: a rule requiring both conditions should fail if one isn't met.
- **Handles multiple WHENs to same target** naturally — each rule is evaluated independently, first match by priority wins. No deduplication bug.
- **Handles multi-intent** — each classified category is evaluated against all rules independently, producing independent `RoutingMatch` results.

### 6.4 Relationship to `checkDeterministicRouting()`

`checkDeterministicRouting()` in `routing-executor.ts` currently skips intent-based rules:

```typescript
// routing-executor.ts:4484-4485
const vars = extractVariableReferences(rule.when);
if (vars.includes('intent')) continue; // Skip intent-based rules — the LLM decides these
```

With the routing resolver as a separate function, `checkDeterministicRouting()` stays unchanged. It continues to handle non-intent deterministic routing (e.g., `user.wants_human == true`). The routing resolver handles intent-based routing. Clean separation — no modification to existing routing code.

### 6.5 What It Replaces

- `buildTargetCategoryMap()` — deleted
- `resolveIntentCategory()` — deleted
- `extractCategoriesFromWhen()` — deleted
- The reverse-engineering flow in `bridgeIntentsToSessionState()` — replaced by direct category from classifier + `resolveRouting()`

---

## 7. Intent Bridge Cleanup & Session State

### 7.1 What `bridgeIntentsToSessionState()` Becomes

**Before:** classifier result → reverse-engineer category from target via regex map → build `PipelineIntentState`
**After:** classifier result + routing matches → use category directly from classifier, target from routing resolver → build `PipelineIntentState`

### 7.2 `PipelineIntentState` — Same Shape, Different Sources

```typescript
interface PipelineIntentState {
  category: string | null;
  confidence: number;
  out_of_scope: boolean;
  target: string | null;
  summary: string;
  intent_count: number;
}
```

The shape is unchanged — downstream consumers (`session.data.values.intent`) see the same interface. The difference is how fields are populated:

| Field          | Before                                                           | After                                                 |
| -------------- | ---------------------------------------------------------------- | ----------------------------------------------------- |
| `category`     | Reverse-engineered from target via regex map, always picks `[0]` | Directly from classifier output                       |
| `target`       | Directly from classifier                                         | From `resolveRouting()` — system-side WHEN evaluation |
| `out_of_scope` | `target === null`                                                | `category === null` + confidence above threshold      |
| `confidence`   | From classifier                                                  | From classifier (unchanged)                           |
| `summary`      | From classifier                                                  | From classifier (unchanged)                           |
| `intent_count` | Count of classifier intents                                      | Count of classifier intents (unchanged)               |

### 7.3 What Gets Deleted from `intent-bridge.ts`

- `extractCategoriesFromWhen()` — dead; WHEN parsing moves to compiler
- `buildTargetCategoryMap()` — dead; no reverse map needed
- `resolveIntentCategory()` — dead; category comes from classifier
- `toDetectedIntent()` internal helper — rewritten to use classifier category directly instead of calling `resolveIntentCategory()`

### 7.4 What Stays (with modifications)

- `bridgeIntentsToSessionState()` — simplified; takes classifier result + routing matches, no reverse engineering
- `bridgeToDetectedMultiIntent()` — adapted to use classifier categories + routing matches
- `bridgeToMultiIntentResult()` — same adaptation

### 7.5 `session.data.values.intent` Lifecycle

1. **Before pipeline**: `intent` doesn't exist in session values
2. **After classifier + routing resolver**: Set to `{ category, confidence, target, out_of_scope, summary, intent_count }`
3. **After tool rebuild**: `buildTools()` evaluates WHEN conditions — now `intent` exists in session values, so `allVarsPresent` is `true` and pre-filtering works correctly (Gap 1 fixed)
4. **After routing**: Stays in session for observability / trace events
5. **Child sessions**: Not propagated — child threads start with fresh `data: { values: {} }`. Unchanged behavior.

---

## 8. Reasoning Executor Wiring & Tool Rebuild

### 8.1 Current Flow (lines 747-982 of `reasoning-executor.ts`)

```
1. resolvePipelineConfig()
2. resolvePipelineModel()
3. runPipeline(model, userMessage, tools, config) → pipelineResult
4. bridgeIntentsToSessionState(classifierResult, agentIR) → intentState
5. session.data.values.intent = intentState
6. [short-circuit paths: single handoff, fan-out]
7. [tiered actions: decline, guided, autonomous]
8. systemPrompt = buildSystemPrompt(session)  ← only in Tier 2
9. [fall through to supervisor LLM loop]
```

**Problems:** Tools not rebuilt (Gap 1). Prompt only rebuilt in Tier 2. `runPipeline()` receives tools but classifier only needs categories.

### 8.2 New Flow

```
1.  resolvePipelineConfig()
2.  resolvePipelineModel()
3.  Extract categories from agentIR.routing.intent_classification.categories
        (with migration shim for old string[] IR)
4.  classify(model, userMessage, categories, config) → classifierResult
5.  Run tool filter (if enabled, parallel with step 4) — unchanged, still operates on tools
6.  resolveRouting(classifierResult.intents, agentIR.routing.rules, session.data.values)
        → routingMatches
7.  Build intentState from classifierResult + routingMatches
8.  session.data.values.intent = intentState
9.  tools = buildTools(session)              ← ALWAYS rebuild (fixes Gap 1)
10. systemPrompt = buildSystemPrompt(session) ← ALWAYS rebuild
11. [short-circuit: single match with high confidence → handleHandoff()]
12. [multi-intent: multiple matches → fan-out / disambiguate]
13. [tiered actions adapted to use routing matches instead of classifier targets]
14. [fall through to supervisor LLM loop with filtered tools + rebuilt prompt]
```

### 8.3 Key Changes

- **Steps 3-4**: `runPipeline()` is split — classification and tool filtering become separate calls. Classification only needs categories, tool filter still needs tools. This is cleaner than passing both through one function.
- **Step 5**: Tool filter runs in parallel with classification (when `mode: 'parallel'`). Sequential mode runs classification first, skips tool filter on short-circuit. Same as today.
- **Step 6**: New `resolveRouting()` call between classification and session state.
- **Steps 9-10**: Tools AND prompt rebuilt unconditionally after intent state is set — not just in Tier 2. This fixes Gap 1.
- **Step 11**: Short-circuit now based on routing match + confidence, not classifier target. Same logic, different source for the target.
- **Step 13**: `resolveTieredAction()` adapts to receive routing matches. Tier 1 (short-circuit/decline) uses routing match. Tier 2 (guided) uses routing matches to hide irrelevant tools. Tier 3 unchanged.

### 8.4 `runPipeline()` Changes

The function currently orchestrates both classification and tool filtering. With classification needing categories (from IR) and tool filtering needing tools (from `buildTools()`), the cleanest approach is to split `runPipeline()` into its two constituent calls and orchestrate them directly in the reasoning executor. `runPipeline()` is deleted — its orchestration logic moves into the reasoning executor's pipeline block. The `parallel` vs `sequential` mode config still applies — it determines whether `classify()` and `filterTools()` run concurrently (`Promise.all`) or sequentially in the reasoning executor.

---

## 9. Backward Compatibility & Migration

### 9.1 No Breaking Changes for ABL Authors

- **No `INTENTS:` block?** → Compiler falls back to WHEN extraction (fixed `matchAll`, all sources). Everything works as before, just better.
- **Has `INTENTS:` block?** → Compiler uses explicit declarations. Validates WHEN references against them (warning only).
- Existing ABL files need zero changes.

### 9.2 IR Schema Migration Shim

The IR `categories` field changes from `string[]` to `IntentCategory[]`. For agents compiled before this change:

```typescript
const categories: IntentCategory[] = agentIR.routing.intent_classification.categories.map((c) =>
  typeof c === 'string' ? { name: c } : c,
);
```

One-liner in the reasoning executor. Old `string[]` IR works. New `IntentCategory[]` IR works. No forced recompilation.

### 9.3 Pipeline Disabled (Default State)

When `pipelineConfig.enabled === false` (the default), none of this code runs. The supervisor LLM loop works exactly as today — `buildTools()` constructs handoff tools with WHEN descriptions, the LLM picks which tool to invoke. Zero behavioral change for projects not using the pipeline.

### 9.4 Pipeline Enabled, No Routing Rules

If a supervisor has no routing rules (edge case), `resolveRouting()` returns empty matches. Falls through to Tier 3 (autonomous) — the supervisor LLM handles it. Same as today.

### 9.5 Gradual Rollout

The pipeline is already opt-in per project via MongoDB config (`pipeline.enabled`). No additional feature flag needed. Projects enable it when ready.

---

## 10. Error Handling

### 10.1 Classifier Fails (LLM Timeout, Parse Error, Hallucinated Category)

Same graceful degradation pattern as today:

```typescript
// LLM call fails → fall through to autonomous
catch (err) {
  recordPipelineFailure(tenantId);
  return { intents: [{ category: null, confidence: 0, summary: 'llm_error' }] };
}

// LLM returns category not in known set → treat as null
if (!knownCategories.has(intent.category)) {
  intent.category = null;
}
```

Category `null` + low confidence → `resolveRouting()` finds no match → Tier 3 autonomous → supervisor LLM handles it with full tool set. The system never breaks — it falls back to the pre-pipeline behavior.

### 10.2 Routing Resolver Finds No Match

Classified category is valid but no WHEN condition evaluates to true. Example: `intent.category == "billing" AND user.tier == "premium"` but `user.tier` is missing → null injection → `null == "premium"` → `false` → AND fails.

This is not an error — it means the routing conditions aren't met yet. Fall through to Tier 3 autonomous. The supervisor LLM sees the rebuilt tools (with WHEN pre-filtering now working since `intent` is populated) and handles routing itself.

### 10.3 Multiple Rules Match

`resolveRouting()` returns the first match by priority. This is deterministic — same priority-based semantics as `checkDeterministicRouting()` today. No ambiguity.

### 10.4 Circuit Breaker

Existing circuit breaker (`isPipelineCircuitOpen`, `recordPipelineSuccess`, `recordPipelineFailure`) stays unchanged. Pipeline failures trip the breaker, subsequent requests skip the pipeline entirely until it recovers.

### 10.5 Trace Events

Every decision point emits a trace event for observability:

| Event                      | Data                                                               |
| -------------------------- | ------------------------------------------------------------------ |
| `pipeline_classify`        | Categories sent, category returned, confidence, latency, model     |
| `pipeline_routing_resolve` | Rules evaluated, which matched, which failed and why, final target |
| `pipeline_intent_bridge`   | Final intent state written to session                              |
| `pipeline_tiered_action`   | Which tier, what action taken, details                             |

All observable in Studio session debug view.

---

## 11. Testing Strategy

### 11.1 Unit Tests

**Compiler — `extractIntentCategories()`:**

- WHEN with single category → extracts it
- WHEN with OR'd categories → extracts all (`matchAll` fix)
- Multiple rules to same target → deduplicates categories
- Routing rules + handoffs + delegates → extracts from all sources
- `INTENTS:` block present → uses explicit declarations, ignores WHEN extraction
- `INTENTS:` block + undeclared category in WHEN → compile warning emitted
- No `INTENTS:` block → falls back to WHEN extraction
- `source` field set correctly (`'explicit'` vs `'inferred'`)

**Classifier — `buildClassifierPrompt()` & `parseClassifierResponse()`:**

- Categories with descriptions → prompt formatted with `name — "description"` lines
- Categories without descriptions → comma-separated names
- Parse valid response → extracts category + confidence
- Parse response with unknown category → sets category to `null`
- Parse multi-intent response → returns multiple entries
- Malformed JSON → graceful fallback with `category: null`

**Routing resolver — `resolveRouting()`:**

- Single intent, single matching rule → returns match with correct target
- Single intent, no matching rule → returns empty
- Single intent, multiple rules match → returns first by priority
- Same category routes to different targets based on non-intent vars → correct match per session state
- Multi-intent, each matches different rule → returns multiple independent matches
- Missing non-intent variables in WHEN → null injection, condition evaluates correctly
- `rule.when` is `"true"` (fallback) → matches when nothing else does
- Trace events emitted for each evaluation

**Intent bridge — `bridgeIntentsToSessionState()`:**

- Single intent with routing match → correct `PipelineIntentState` with category from classifier and target from routing match
- Null category (out of scope) → `out_of_scope: true`
- Multi-intent → `intent_count` reflects count
- No routing match for valid category → `target: null`

### 11.2 Integration Tests

- **Full pipeline flow**: classifier → routing resolver → intent bridge → session state → tool rebuild → WHEN pre-filtering works. Verify tools are correctly filtered after pipeline runs.
- **Backward compat**: IR with old `string[]` categories → migration shim → classification works
- **Pipeline disabled**: verify zero behavioral change, no pipeline code executes
- **Circuit breaker**: classifier failure → breaker opens → subsequent calls skip pipeline → breaker recovers

### 11.3 E2E Tests

- **Apple Care scenario**: User says "How do I set up Face ID?" → classifier returns `category: "setup"` → WHEN evaluation matches `Device_Support` → handoff executes
- **Multi-intent scenario**: "Set up Face ID and check my billing" → two categories → two routing matches → fan-out or disambiguation
- **Out-of-scope**: "What's the weather?" → classifier returns `null` → no routing match → supervisor handles gracefully
- **Fallback**: Classifier times out → circuit breaker → supervisor LLM handles routing directly
- **Same category, different targets**: Category "A" with `var == 1` routes to T1, `var == 2` routes to T2 → correct target selected based on session state

---

## 12. End-to-End Data Flow

```
ABL File (authoring time)
  │
  ├── INTENTS: setup, billing, escalation...   ← NEW (optional)
  ├── HANDOFF TO: Device_Support WHEN: intent.category == "setup"
  └── HANDOFF TO: Account_Support WHEN: intent.category == "billing" AND user.tier == "premium"

Compiler
  │
  └── IR.routing.intent_classification:
        categories: [
          { name: "setup", description: "..." },
          { name: "billing", description: "..." },
          { name: "escalation", description: "..." },
        ]
        source: "explicit"
        min_confidence: 0.7
        (or source: "inferred" with names only if no INTENTS block)

Runtime — Pipeline (per user message)
  │
  ├── 1. Classifier LLM call
  │     Prompt: "Categories: setup, billing, escalation..."
  │     Input: user message
  │     Output: { category: "setup", confidence: 0.92, summary: "..." }
  │
  ├── 2. Tool Filter LLM call (parallel, unchanged)
  │     Output: filtered tool list
  │
  ├── 3. Routing Resolver (deterministic, no LLM)
  │     Input: category "setup" + routing rules + session state
  │     Evaluates: intent.category == "setup" → true (Rule for Device_Support)
  │     Output: RoutingMatch { target: "Device_Support", rule }
  │
  ├── 4. Intent Bridge (simplified)
  │     Writes: session.data.values.intent = {
  │       category: "setup",
  │       target: "Device_Support",
  │       confidence: 0.92,
  │       out_of_scope: false,
  │       summary: "set up Face ID",
  │       intent_count: 1
  │     }
  │
  ├── 5. Rebuild tools + prompt (ALWAYS)
  │     buildTools(session) → WHEN pre-filtering now works (intent exists)
  │     buildSystemPrompt(session) → intent-aware prompt
  │
  └── 6. Tiered Action
        Tier 1: High confidence + match → short-circuit handoff to Device_Support
        Tier 2: Medium confidence → guided (irrelevant tools hidden, supervisor LLM decides)
        Tier 3: Low confidence / no match → autonomous (full tool set, supervisor LLM decides)

Fallback (pipeline disabled or failed)
  └── Supervisor LLM loop with all tools — exactly as today
```

**What the LLM does:** Semantic classification — "set up Face ID" → `setup`
**What the system does:** Boolean routing — `intent.category == "setup"` → `Device_Support`

---

## 13. Files Affected

| File                                                        | Change                                                                                                                                                        | Complexity |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `packages/compiler/src/platform/ir/compiler.ts`             | Rewrite `extractIntentCategories()`: `matchAll`, all sources, `INTENTS:` block support                                                                        | Medium     |
| `packages/compiler/src/platform/ir/schema.ts`               | `IntentConfig` schema: remove `use_llm`, `categories` → `IntentCategory[]`, add `source`                                                                      | Low        |
| `packages/compiler/src/platform/constants.ts`               | `DEFAULT_INTENT_CATEGORIES` may need update to `IntentCategory[]` format                                                                                      | Low        |
| `packages/compiler/src/platform/parser/`                    | ABL parser: recognize `INTENTS:` keyword, parse key-value entries                                                                                             | Medium     |
| `apps/runtime/src/services/pipeline/classifier.ts`          | New prompt (flat categories), new output schema (`category` not `target`), simplified signature                                                               | Medium     |
| `apps/runtime/src/services/pipeline/types.ts`               | `ClassifiedIntent.target` → `.category`, remove `shouldExecuteInAgent`/`matchedTools` from `ClassifierResult`                                                 | Low        |
| `apps/runtime/src/services/pipeline/routing-resolver.ts`    | **New file**: `resolveRouting()` — evaluates WHEN conditions via `evaluateConditionDual()`                                                                    | Medium     |
| `apps/runtime/src/services/pipeline/intent-bridge.ts`       | Delete `buildTargetCategoryMap`, `resolveIntentCategory`, `extractCategoriesFromWhen`. Simplify bridge functions to use classifier category + routing matches | Medium     |
| `apps/runtime/src/services/pipeline/index.ts`               | Split `runPipeline()` — classification and tool filtering become separate calls. Update re-exports                                                            | Medium     |
| `apps/runtime/src/services/execution/reasoning-executor.ts` | New wiring: separate classify/filter calls, add `resolveRouting()`, unconditional tool+prompt rebuild, adapt tiered actions                                   | High       |
| `apps/runtime/src/services/pipeline/tiered-resolver.ts`     | Adapt `resolveTieredAction()` to use routing matches instead of classifier targets                                                                            | Low        |

---

## 14. Out of Scope

- **`checkDeterministicRouting()` modification** — stays unchanged, handles non-intent routing. No overlap with the routing resolver.
- **Tool filter redesign** — the tool filter is independent of intent classification. It continues to operate on the full tool list.
- **`prompt-builder.ts` WHEN humanization** — `buildHandoffDescription()` still transforms `intent.category == "X"` to `user intent is "X"` for the supervisor LLM's tool descriptions. This is cosmetic and unrelated to classification.
- **Child session intent propagation** — child threads start fresh. If future use cases need parent intent in child agents, that's a separate design.
- **Dynamic categories** — categories that change at runtime (not compile time). The `INTENTS:` block handles all current patterns. Dynamic categories would require a different mechanism.
