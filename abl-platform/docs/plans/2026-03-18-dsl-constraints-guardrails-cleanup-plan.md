# Implementation Plan: DSL Constraints & Guardrails Cleanup

**Date:** 2026-03-18
**Source:** [DSL Feedback Review](../audit/dsl-feedback-review-2026-03-18.md) + Prasanna's directives
**Goal:** Fix confirmed bugs, remove legacy runtime evaluator, preserve developer-friendly DSL syntax, use purpose-built code for each concern (not everything through CEL), remove misleading examples/docs, deprecate legacy guardrail paths.

## Status Update — 2026-03-19

Completed in the current working tree:

- Phase 1.1: inline `ON_FAIL: BLOCK`, `RESPOND`, and `REDACT` now compile correctly.
- Phase 1.2: `CONSTRAINT_KEYWORDS` and variable extraction now handle legacy operator/function forms and method-call receivers correctly.
- Phase 1.3: compiler warning `W822` now flags `required: false` + `default` for both top-level and flow-step gathers.
- Targeted runtime fix: post-extraction constraint failures now clear only the referenced offending fields.
- Phase 5.2: compiler warning `W823` now flags named constraint phases as labels-only. Runtime phase gating is intentionally not part of this cleanup slice.
- Workstream D: `IMPLEMENTED_GUARDRAIL_ADAPTER_TYPES` extracted to `@agent-platform/database/constants/guardrail-adapters` as single source of truth. All 3 consumers (runtime route, Studio route, Studio form) import from the shared constant.

Still explicitly deferred:

- Broad Phase 2 legacy-evaluator removal. The audit passes confirmed that expression normalization coverage is not yet complete enough to safely remove the CEL fallback path in one step.

---

## Architecture: Separate Code for Separate Concerns

### Principle: CEL for expressions, purpose-built code for everything else

Not everything is a CEL expression. Forcing template interpolation, temporal constraints, and constraint keywords through CEL creates unnecessary complexity. Instead:

| Concern                                      | Owner                                   | Why Not CEL?                                                  |
| -------------------------------------------- | --------------------------------------- | ------------------------------------------------------------- |
| **Condition evaluation**                     | CEL (via migrator)                      | This IS what CEL is for                                       |
| **Value resolution**                         | CEL (via migrator)                      | Same — evaluating `abl.upper(name)`                           |
| **Template interpolation**                   | Standalone `interpolateMessage` utility | String templating `${...}` is not boolean logic               |
| **Temporal constraints (`BEFORE`)**          | Parser → IR → Runtime checkpoint        | Scheduling concern — CEL has no concept of "before step X"    |
| **Constraint keywords (`LIMIT`/`RESTRICT`)** | Parser → Compiler                       | Section-level keywords like `REQUIRE`/`WARN`, not expressions |
| **Guardrail functions**                      | Already CEL (`cel-functions.ts`)        | These ARE CEL — just need to be spec'd                        |

### What we're removing

The legacy runtime evaluator (`evaluator.ts`, 1,100+ lines) — the fallback when CEL failed.

### What we're keeping

- The ABL parser (all developer-facing syntax)
- The expression migrator (ABL surface syntax → CEL)
- `interpolateMessage` (extracted as standalone utility)
- Purpose-built handlers for `BEFORE`, `LIMIT`, `RESTRICT` (new code, not evaluator)

### What we're fixing

Migrator gaps for spec'd operators (lowercase `contains`, `IN`/`NOT IN`, `EMPTY`, `EXISTS`).

### What needs spec/doc alignment

- `BEFORE` — document the current split between supported structural checkpoints and retained warning-only compatibility forms
- `IMPLIES` — document it as retained logical sugar with compiler lowering
- `LIMIT`/`RESTRICT` — document their retained IR kinds and current runtime aliasing semantics
- 9 guardrail CEL functions — spec them

### Target Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Agent Developer writes ABL syntax                              │
│  (IS SET, AND, OR, contains, BEFORE, IMPLIES, LIMIT, RESTRICT) │
└──────────────┬──────────────────────────────────────────────────┘
               ↓
┌──────────────────────────────────────────────────────────────────┐
│  Parser: recognizes all ABL keywords and structural operators    │
│  (BEFORE → temporal modifier, LIMIT/RESTRICT → constraint kind, │
│   IMPLIES → condition operator, WHEN → applicability field)     │
└──────────────┬──────────────────────────────────────────────────┘
               ↓
┌──────────────────────────────────────────────────────────────────┐
│  Compiler normalizes expressions to CEL in IR                    │
│  (IMPLIES → !(A)||B, IS SET → !=null, contains → .contains())  │
│  Emits separate IR fields for non-expression concerns:           │
│  (before_step, constraint_kind: limit|restrict|require|warn)    │
└──────────────┬──────────────────────────────────────────────────┘
               ↓
┌──────────────────────────────────────────────────────────────────┐
│  Runtime: CEL evaluator for expressions (no legacy fallback)     │
│           interpolateMessage for templates                       │
│           Checkpoint logic for BEFORE temporal guards             │
│           Severity routing for LIMIT/RESTRICT/REQUIRE/WARN      │
└──────────────────────────────────────────────────────────────────┘
```

---

## Developer Experience: ABL Surface Syntax vs CEL Runtime

### Decision: Keep ABL syntax for developers, compile to CEL for runtime

Agent developers write business rules, not code:

```yaml
# What developers write (ABL surface syntax — KEEP THIS):
REQUIRE destination IS SET
REQUIRE refund_amount <= 1000 OR manager_approved == true
REQUIRE desired_action == "cancel" IMPLIES cancellation_confirmed == true
REQUIRE dispute_type == "card" IMPLIES card_unique_id != ""
REQUIRE cart_contents IS NOT EMPTY
IF: input contains "change destination"

# What CEL would force them to write (DON'T DO THIS):
REQUIRE destination != null
REQUIRE refund_amount <= 1000 || manager_approved == true
REQUIRE ???                                    # BEFORE has no CEL equivalent
REQUIRE dispute_type != "card" || card_unique_id != ""  # IMPLIES is unreadable
REQUIRE cart_contents.size() > 0
IF: input.contains("change destination")
```

### Spec'd operators (source of truth: `rich-content-and-expressions.mdx`)

| Operator                         | Spec'd? | Migrator Status                  | CEL Equivalent                                           |
| -------------------------------- | ------- | -------------------------------- | -------------------------------------------------------- |
| `==`, `!=`, `>`, `<`, `>=`, `<=` | Yes     | Pass-through (already valid CEL) | Same                                                     |
| `AND` / `OR` / `NOT`             | Yes     | Handled ✅                       | `&&` / `\|\|` / `!`                                      |
| `IS SET` / `IS NOT SET`          | Yes     | Handled ✅                       | `has(x)` / `!has(x)` → preprocessed to `!=null`/`==null` |
| `contains` (infix)               | Yes     | **Gap** — lowercase not detected | `.contains()`                                            |
| `matches` (infix)                | Yes     | **Gap** — lowercase not detected | `.matches()`                                             |
| `IN`                             | Yes     | **Gap** — not handled at all     | `in` (lowercase)                                         |
| `NOT IN`                         | Yes     | **Gap** — not handled at all     | `!(x in [...])`                                          |
| `EXISTS`                         | Yes     | **Gap** — not handled at all     | `has(x)`                                                 |
| `EMPTY` / `IS NOT EMPTY`         | Yes     | **Gap** — not handled at all     | `size(x) == 0` / `size(x) > 0`                           |

### Retained constructs that needed explicit spec coverage

| Construct              | In Spec? | In Parser? | Current Direction                                                                                                         |
| ---------------------- | -------- | ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| `BEFORE`               | Partial  | Yes        | Retain all forms in parser/docs/examples; support structural checkpoints, warn on non-structural compatibility forms      |
| `IMPLIES`              | Partial  | Yes        | Retain and document as logical sugar lowered by the compiler                                                              |
| `WHEN` (on constraint) | Partial  | Yes        | Retain and document as applicability gating lowered by the compiler                                                       |
| `LIMIT`                | Partial  | Yes        | Retain in docs/examples; preserve as a distinct constraint kind in IR, with initial runtime aliasing to existing handling |
| `RESTRICT`             | Partial  | Yes        | Retain in docs/examples; preserve as a distinct constraint kind in IR, with initial runtime aliasing to existing handling |

### Spec'd built-in functions (36 total)

All 36 functions from the spec are implemented in `cel-functions.ts` and mapped via `ABL_NAMESPACE_FUNCTIONS` in the migrator. **Gap:** migrator only detects UPPERCASE calls. Lowercase `is_number(x)` is not detected as legacy.

### Guardrail CEL functions (9 implemented, 0 spec'd)

| Function                         | Implemented | Spec'd? |
| -------------------------------- | ----------- | ------- |
| `abl.contains_pii(text)`         | Yes         | No      |
| `abl.detect_pii(text)`           | Yes         | No      |
| `abl.redact_pii(text)`           | Yes         | No      |
| `abl.matches_pattern(text, pat)` | Yes         | No      |
| `abl.word_count(text)`           | Yes         | No      |
| `abl.sentence_count(text)`       | Yes         | No      |
| `abl.contains_url(text)`         | Yes         | No      |
| `abl.contains_email(text)`       | Yes         | No      |
| `abl.contains_code(text)`        | Yes         | No      |

**Action:** Add to spec under "Guardrail Functions" section.

---

## Constraints Design Summary (for context)

### How Constraints Are Validated

Constraints are **purely deterministic** — no LLM involvement in condition evaluation.

**Current evaluation chain (with legacy fallback):**

```
User input → LLM extracts entities → entities stored in session.data.values
                                              ↓
                              checkConstraints(session)
                                              ↓
                              checkConstraintsCore(constraintConfig, context)
                                              ↓
                              evaluateWithGuardSemantics(condition, context)
                                              ↓
                              evaluateConditionDual(condition, context)
                                  ├─ CEL evaluator (primary)
                                  └─ Legacy ABL evaluator (fallback) ← REMOVING
```

**Target evaluation chain (CEL-only for expressions):**

```
DSL source → compiler normalizes expressions to CEL → IR stores CEL + metadata
                                              ↓
                              evaluateCondition(celExpression, context)  ← expressions
                                  └─ CEL evaluator (only path)
                              interpolateMessage(template, context)      ← templates
                                  └─ standalone utility using resolveValue
                              checkBeforeGuard(constraint, currentStep)  ← temporal
                                  └─ purpose-built checkpoint logic
```

**Key files:**

- Entry: `apps/runtime/src/services/execution/constraint-checker.ts`
- Core: `packages/compiler/src/platform/constructs/executors/constraint-executor.ts`
- CEL: `packages/compiler/src/platform/constructs/cel-evaluator.ts`
- Dual (to be simplified): `packages/compiler/src/platform/constructs/dual-evaluator.ts`
- Legacy (to be deleted): `packages/compiler/src/platform/constructs/evaluator.ts`
- Migrator: `packages/compiler/src/platform/constructs/expression-migrator.ts`
- Functions: `packages/compiler/src/platform/constructs/cel-functions.ts`

### Role of LLM

The LLM has **two indirect roles** in the constraint system:

1. **Entity extraction** — The LLM extracts field values from user messages (via `_extract_entities` tool call). These values populate `session.data.values`, which constraints then evaluate against deterministically.
2. **Warning communication** — Constraint warnings (`severity: 'warning'`) are injected into the system prompt so the LLM can inform the user naturally:
   ```handlebars
   {{#if constraint_warnings}}
     ⚠️ ACTIVE WARNINGS (inform the user about these, but do not block their request):
     {{constraint_warnings}}
   {{/if}}
   ```
   (See `packages/shared/src/prompts/prompt-catalog.ts`)

### Without LLM (Pure Scripted Flow)

Constraints work fully without LLM. In flow mode:

- Entity extraction uses regex/JS-library extraction (`extractWithJSLibs`)
- Conditions evaluate against session context deterministically
- Violation messages use static templates with `{{variable}}` interpolation via `interpolateMessage`
- Control flow actions (collect, goto, retry) operate without LLM

### Constraint Check Points (6 locations)

| #   | Location                      | When                                      | File:Line                     |
| --- | ----------------------------- | ----------------------------------------- | ----------------------------- |
| A   | Pre-message (non-gather)      | Before processing user message            | `runtime-executor.ts:~2223`   |
| B   | Pre-extraction (flow)         | Before entity extraction in flow step     | `flow-step-executor.ts:~2619` |
| C   | Post-extraction (flow)        | After entity extraction in flow step      | `flow-step-executor.ts:~3464` |
| D   | Post-extraction (reasoning)   | After entity extraction in reasoning loop | `reasoning-executor.ts:~561`  |
| E   | Inline extraction (reasoning) | After `_extract_entities` tool call       | `reasoning-executor.ts:~1698` |
| F   | Post-tool (reasoning)         | After any tool execution                  | `reasoning-executor.ts:~2540` |

### Auto-Guard Mechanism (compile-time + runtime)

**Compile-time** (`compiler.ts:1209` — `autoGuardConstraint()`):

```
'destination != origin'  →  'destination IS NOT SET OR origin IS NOT SET OR destination != origin'
```

**Runtime** (`constraint-executor.ts` — `evaluateWithGuardSemantics()`):

- In AND chains, `IS SET`/`has()` clauses act as preconditions
- If any guard fails → constraint is "not applicable" (passed=true, guardSkipped=true)

---

## Phase 1: Critical Bug Fixes (compiler/parser)

### 1.1 Fix ON_FAIL: BLOCK prefix detection

Status: Completed in current working tree. Keep this section as implementation notes/regression scope, not as an open item.

**File:** `packages/compiler/src/platform/ir/compiler.ts:1470-1478`

Add BLOCK prefix handling in `parseOnFail()` before the default fallthrough.

**IMPORTANT:** The construct executor (`constraint-executor.ts:471`) uses `irAction.reason` as the block reason and `irAction.message` as a secondary field: `blockAction(irAction.reason || 'Action blocked by constraint', irAction.message)`. Custom BLOCK text must go in `reason`, not `message`.

```typescript
// After HANDOFF check, before default return:
if (onFail === 'BLOCK' || onFail.startsWith('BLOCK ')) {
  const customReason = onFail
    .replace(/^BLOCK\s*/, '')
    .replace(/^"|"$/g, '')
    .trim();
  return { type: 'block', reason: customReason || undefined };
}
```

Also add RESPOND prefix handling:

```typescript
if (onFail.startsWith('RESPOND ') || onFail.startsWith('RESPOND "')) {
  const msg = onFail
    .replace(/^RESPOND\s*/, '')
    .replace(/^"|"$/g, '')
    .trim();
  return { type: 'respond', message: msg };
}
```

And REDACT:

```typescript
if (onFail === 'REDACT' || onFail.startsWith('REDACT ')) {
  return { type: 'redact', message: onFail.replace(/^REDACT\s*/, '').trim() || undefined };
}
```

**Verify downstream mapping:** After this change, confirm that the `ConstraintAction` type definition (`types.ts`) includes `reason` on the `block` variant. If not, extend the type.

**Tests:** Add to `packages/compiler/src/__tests__/` — test `parseOnFail` with all prefix variants:

- `ON_FAIL: BLOCK` → `{ type: 'block' }`
- `ON_FAIL: BLOCK "Custom message"` → `{ type: 'block', message: 'Custom message' }`
- `ON_FAIL: RESPOND "Sorry, max 10"` → `{ type: 'respond', message: 'Sorry, max 10' }`
- `ON_FAIL: REDACT` → `{ type: 'redact' }`
- `ON_FAIL: ESCALATE reason` → `{ type: 'escalate', reason: 'reason' }` (existing, verify)
- `ON_FAIL: HANDOFF agent_x` → `{ type: 'handoff', target: 'agent_x' }` (existing, verify)

**Acceptance:** All ON_FAIL action keywords produce correct IR types. No keyword text leaks to user.

### 1.2 Fix CONSTRAINT_KEYWORDS set

Status: Completed in current working tree. Keep the tests below as regression coverage.

**File:** `packages/compiler/src/platform/ir/compiler.ts:1137-1155`

Add missing legacy condition operators:

```typescript
const CONSTRAINT_KEYWORDS = new Set([
  // Boolean operators
  'AND',
  'OR',
  'NOT',
  'IS',
  'SET',
  // Literals
  'true',
  'false',
  'null',
  'undefined',
  'now',
  // DSL keywords
  'REQUIRE',
  'WARN',
  'ON_FAIL',
  // Action keywords
  'RESPOND',
  'ESCALATE',
  'HANDOFF',
  'BLOCK',
  'REDACT',
  // Comparison/condition operators (legacy ABL syntax)
  'contains',
  'startsWith',
  'endsWith',
  'matches',
  'has',
  'equals',
  'includes',
  'in',
  // Case variants
  'CONTAINS',
  'STARTS_WITH',
  'ENDS_WITH',
  'MATCHES',
  'HAS',
  'EQUALS',
  'INCLUDES',
  'IN',
  // Spec'd unary operators
  'EMPTY',
  'EXISTS',
  // Spec'd list operators
  'NOT_IN',
]);
```

**Tests:** Verify `autoGuardConstraint('input contains "booking"')` does NOT generate `contains IS NOT SET OR ...`.

**Acceptance:** Conditions using `contains`, `startsWith`, etc. are no longer broken by auto-guard.

### 1.3 Add compile-time warning for `required: false` + `default`

Status: Completed in current working tree via warning `W822` for both top-level and flow-step gathers.

**File:** `packages/compiler/src/platform/ir/compiler.ts` (in gather field compilation, ~line 2049-2090)

When compiling GATHER fields, emit a diagnostic warning if both `required === false` and `default !== undefined` are explicitly set.

**Acceptance:** `pnpm build` emits warning. No behavior change.

---

## Phase 2: Legacy Evaluator Removal (Separate Concerns)

### Rationale

The dual-evaluator architecture (CEL primary + legacy fallback) hides bugs via silent fallback and maintains 1,100+ lines of redundant code. But **not everything should go through CEL**. We remove the legacy evaluator by:

1. Fixing migrator gaps so all spec'd operators compile to CEL
2. Extracting `interpolateMessage` as a standalone template utility
3. Normalizing **all 22 expression surfaces** at compile time (not just constraints)
4. Removing the legacy fallback — CEL errors become hard errors
5. Keeping purpose-built code for non-expression concerns (BEFORE, LIMIT, RESTRICT)

### CRITICAL: Full Expression Surface Inventory (22 call sites)

The dual-evaluator is called from **22 distinct production sites**, not just constraints. ALL must be normalized at compile time before the fallback can be removed:

| #   | Expression Type                  | File:Line                    | Compile-Time Surface                       |
| --- | -------------------------------- | ---------------------------- | ------------------------------------------ |
| 1   | Constraint CHECK                 | constraint-executor.ts:216   | `constraints[].condition`                  |
| 2   | Constraint CHECK (runtime entry) | constraint-checker.ts:66,155 | Same IR                                    |
| 3   | Step inline CHECK                | flow-step-executor.ts:2668   | `step.check`                               |
| 4   | Reasoning zone exit              | flow-step-executor.ts:3740   | `step.reasoning_zone.exit_when`            |
| 5   | Branch condition (IF/ELSE)       | flow-step-executor.ts:4313   | `branch.condition`                         |
| 6   | Call success_when                | flow-step-executor.ts:4119   | `step.success_when`                        |
| 7   | Call parameter resolution        | flow-step-executor.ts:4050   | `step.call_with[].value` (resolveValue)    |
| 8   | Transform FILTER                 | flow-step-executor.ts:4224   | `step.transform.filter`                    |
| 9   | Transform MAP                    | flow-step-executor.ts:4235   | `step.transform.map[].expr` (resolveValue) |
| 10  | Action handler condition         | flow-step-executor.ts:2475   | `on_action[].condition`                    |
| 11  | Flow next-step branch            | flow-step-executor.ts:4369   | `on_success/on_failure[].condition`        |
| 12  | Delegate WHEN (runtime)          | routing-executor.ts:1962     | `delegate.when`                            |
| 13  | Handoff WHEN (runtime)           | routing-executor.ts:3366     | `handoff.when`                             |
| 14  | Tool/routing rule WHEN gating    | prompt-builder.ts:845        | `rule.when`                                |
| 15  | Handoff coordination WHEN        | prompt-builder.ts:871        | `handoff.when`                             |
| 16  | Delegate WHEN (construct)        | delegate-executor.ts:134     | `delegateConfig.when`                      |
| 17  | Completion detection             | complete-executor.ts:61      | `completion.conditions[].when`             |
| 18  | Behavior profile WHEN            | profile-resolver.ts:226      | Already CEL — no migration needed          |
| 19  | Digression intent condition      | utils.ts:71                  | `intent.condition`                         |
| 20  | Gather complete_when             | utils.ts:184                 | `gather.complete_when`                     |
| 21  | Gather field validation          | utils.ts:267                 | `field.validation.condition`               |
| 22  | Branch routing (detailed)        | utils.ts:491                 | Same as #5, with trace detail              |

**If Phase 2.3 removes fallback before normalizing all 22 surfaces, existing ABL expressions in step exit, branch, transform, prompt gating, and delegate conditions will fail.**

### 2.1 Fix expression migrator gaps (spec'd operators only)

**File:** `packages/compiler/src/platform/constructs/expression-migrator.ts`

**2.1a — `contains` — string AND array membership (spec'd):**

The spec defines `contains` as: "String contains substring, **or array contains element**." Current migrator only handles quoted RHS (string substring). Must also handle variable/number RHS (array membership).

```typescript
// isLegacyExpression() — case-insensitive detection:
if (/\b(?:CONTAINS|contains)\b/.test(stripped) || /\b(?:MATCHES|matches)\b/.test(stripped))
  return true;

// migrateExpression() — handle BOTH string and non-string RHS:
// String RHS: input contains "hello" → input.contains("hello")
result = result.replace(
  /(\w+(?:\.\w+)*)\s+(?:CONTAINS|contains)\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gi,
  '$1.contains($2)',
);
// Variable/number RHS (array membership): items contains item_id → abl.array_contains(items, item_id)
// This needs a CEL helper because CEL .contains() is string-only.
// Register abl.array_contains(list, element) in cel-functions.ts.
result = result.replace(
  /(\w+(?:\.\w+)*)\s+(?:CONTAINS|contains)\s+(\w+(?:\.\w+)*)/gi,
  'abl.array_contains($1, $2)',
);
```

**New CEL function needed:** `abl.array_contains(list, element)` — returns true if array contains element, or string contains substring. This is a polymorphic helper that handles both spec'd meanings.

**2.1b — `matches` — regex literal support (spec'd):**

The spec allows regex literals (not just quoted strings). Must handle both.

```typescript
// migrateExpression() — handle quoted AND bare regex:
// Quoted: input matches "\\d+" → input.matches("\\d+")
result = result.replace(
  /(\w+(?:\.\w+)*)\s+(?:MATCHES|matches)\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gi,
  '$1.matches($2)',
);
// Bare regex: input matches /\\d+/ → input.matches("\\d+")
result = result.replace(
  /(\w+(?:\.\w+)*)\s+(?:MATCHES|matches)\s+\/([^/]+)\//gi,
  '$1.matches("$2")',
);
// Variable RHS: input matches pattern_var → input.matches(pattern_var)
result = result.replace(
  /(\w+(?:\.\w+)*)\s+(?:MATCHES|matches)\s+(\w+(?:\.\w+)*)/gi,
  '$1.matches($2)',
);
```

**2.1c — `IN` / `NOT IN` (spec'd operators):**

```typescript
// isLegacyExpression():
if (/\bNOT\s+IN\b/.test(stripped) || /\bIN\b/.test(stripped)) return true;

// migrateExpression() — NOT IN before IN to avoid partial match:
result = result.replace(/(\w+(?:\.\w+)*)\s+NOT\s+IN\s+(\[.*?\])/g, '!($1 in $2)');
result = replaceOutsideQuotes(result, /\bIN\b/g, 'in');
```

**2.1d — `EMPTY` / `EXISTS` (spec'd PREFIX unary operators):**

**IMPORTANT CORRECTION:** The spec defines these as PREFIX operators:

- `EMPTY var` (NOT `var EMPTY`) — true if null, "", [], {}
- `EXISTS var` (NOT `var EXISTS`) — true if variable exists in context

The previous plan had these as postfix (`var EMPTY`), which is wrong per the spec.

**EMPTY semantic complexity:** `EMPTY x` is true for null, "", [], AND {}. A plain `size(x) == 0` misses the null case and the empty-object case. This needs a CEL helper.

```typescript
// isLegacyExpression():
if (/\bEMPTY\b/.test(stripped) || /\bEXISTS\b/.test(stripped)) return true;

// migrateExpression() — PREFIX unary:
// EMPTY var → abl.is_empty(var)  (CEL helper needed — handles null/""/[]/{}]
result = result.replace(/\bEMPTY\s+(\w+(?:\.\w+)*)/gi, 'abl.is_empty($1)');
// NOT EMPTY var or var IS NOT EMPTY → !abl.is_empty(var)
result = result.replace(/(\w+(?:\.\w+)*)\s+IS\s+NOT\s+EMPTY\b/gi, '!abl.is_empty($1)');
result = result.replace(/\bNOT\s+EMPTY\s+(\w+(?:\.\w+)*)/gi, '!abl.is_empty($1)');
// EXISTS var → has(var)  (PREFIX)
result = result.replace(/\bEXISTS\s+(\w+(?:\.\w+)*)/gi, 'has($1)');
```

**New CEL function needed:** `abl.is_empty(val)` — returns true if val is null, undefined, "", [], or {}. Register in `cel-functions.ts`.

**2.1e — Lowercase function calls (spec'd functions):**

Add `i` flag to `ABL_FUNCTION_CALL_PATTERN` and all migration patterns:

```typescript
const ABL_FUNCTION_CALL_PATTERN = new RegExp(
  `\\b(?:${[...ALL_ABL_FUNCTIONS].join('|')})\\s*\\(`,
  'i',
);
```

**2.1f — `IMPLIES` detection and lowering:**

Detect `IMPLIES` as retained ABL syntax and lower it explicitly instead of treating it as an unresolved fallback case:

```typescript
if (/\bIMPLIES\b/.test(stripped)) {
  return true; // routed through the explicit IMPLIES lowering path
}
```

**2.1g — `WHEN` on constraints (compiler-level, not migrator):**

`WHEN` is not an expression operator — it's a constraint modifier. The compiler (not migrator) handles it:

```typescript
// In compileConstraints():
// Parser yields: { condition: "merchant_name != ''", when: "channel_type == 'ivr'" }
// Compiler emits: { condition: normalizeExpression(`!(${when}) || (${condition})`) }
```

This keeps `WHEN` as a parser/compiler concern, not a CEL concern.

**Tests:** See T2.1 in test checklist below.

### 2.2 Compile-time normalization — ALL 22 expression surfaces

**File:** `packages/compiler/src/platform/ir/compiler.ts`

**CRITICAL: The order must be auto-guard FIRST (in ABL), THEN normalize to CEL.** The auto-guard tokenizes ABL-style identifiers and checks `CONSTRAINT_KEYWORDS`. It cannot parse CEL forms like `size(...)`, `.contains()`, or `||`. So:

```typescript
// CORRECT ORDER: guard in ABL, then normalize the guarded expression to CEL
condition: normalizeExpression(autoGuardConstraint(req.condition));

// WRONG (was in previous plan): normalizing first breaks auto-guard
// condition: autoGuardConstraint(normalizeExpression(req.condition))
```

**All expression surfaces that must be normalized in IR compilation:**

| IR Field                                    | Compiler Location             | Notes                                |
| ------------------------------------------- | ----------------------------- | ------------------------------------ |
| `constraints[].condition`                   | `compileConstraints()`        | Auto-guard first, then normalize     |
| `complete_when`                             | completion config compilation | Normalize only                       |
| `steps[].check`                             | step compilation              | Normalize only                       |
| `steps[].reasoning_zone.exit_when`          | step compilation              | Normalize only                       |
| `steps[].success_when`                      | step compilation              | Normalize only                       |
| `steps[].call_with[].value`                 | step compilation              | Normalize (resolveValue expressions) |
| `steps[].transform.filter`                  | step compilation              | Normalize only                       |
| `steps[].transform.map[].expr`              | step compilation              | Normalize (resolveValue expressions) |
| `steps[].on_input[].condition`              | step compilation              | Normalize only                       |
| `steps[].branches[].condition`              | step compilation              | Normalize only                       |
| `steps[].on_action[].condition`             | step compilation              | Normalize only                       |
| `steps[].on_success/on_failure[].condition` | step compilation              | Normalize only                       |
| `delegate[].when`                           | delegate compilation          | Normalize only                       |
| `handoff[].when`                            | handoff compilation           | Normalize only                       |
| `routing_rules[].when`                      | routing compilation           | Normalize only                       |
| `completion.conditions[].when`              | completion compilation        | Normalize only                       |
| `gather.complete_when`                      | gather compilation            | Normalize only                       |
| `gather.fields[].validation.condition`      | gather field compilation      | Normalize only                       |
| `intents[].condition`                       | intent/digression compilation | Normalize only                       |
| `activation.when`                           | activation compilation        | Normalize only                       |

**Implementation approach:** Rather than adding `normalizeExpression()` calls in 20 places, add a **post-compilation IR walker** that traverses the compiled IR and normalizes every string field that contains an expression. This is less error-prone than modifying each compilation function:

```typescript
function normalizeIRExpressions(ir: CompiledAgent): CompiledAgent {
  // Walk all known expression fields and normalize
  // This ensures no surface is missed when new fields are added
}
```

**Benefit:** Runtime only ever sees CEL. Single normalization point. No `isLegacyExpression()` check on every evaluation.

### 2.3 Remove legacy fallback from evaluator

**File:** `packages/compiler/src/platform/constructs/dual-evaluator.ts`

Replace fallback with hard error:

```typescript
// BEFORE:
} catch (err) {
  celMetrics.celFallback++;
  log.debug('CEL evaluation failed, falling back to legacy', { ... });
  return legacyEvaluateCondition(expression, context);
}

// AFTER:
} catch (err) {
  log.error('CEL evaluation failed', {
    expression: expression.slice(0, 200),
    error: err instanceof Error ? err.message : String(err),
  });
  throw new Error(`Constraint evaluation failed: ${err instanceof Error ? err.message : String(err)}`);
}
```

### 2.4 Extract template utility, delete legacy evaluator

This is the key "separate concerns" step:

1. **Extract `interpolateMessage` and `interpolateWithFallback`** from `evaluator.ts` to `packages/compiler/src/platform/constructs/template-utils.ts`
   - These use `resolveValue` internally — point them at `resolveValueDual` (soon renamed to `resolveValue`)
   - ~50 lines of useful code, not 1,100
2. **Move `splitByOperator`** to `dual-evaluator.ts` (only consumer)
3. **Delete `evaluator.ts`** (1,100+ lines)
4. **Rename** `dual-evaluator.ts` → `evaluator.ts`, drop `Dual` suffix from exports:
   - `evaluateConditionDual` → `evaluateCondition`
   - `evaluateConditionDetailedDual` → `evaluateConditionDetailed`
   - `resolveValueDual` → `resolveValue`
5. **Update all imports** across the codebase

### 2.5 Update `evaluateConditionDetailed` trace parsing for CEL syntax

The detailed evaluator does structural regex parsing for trace metadata. Update patterns:

| Current (legacy) | New (CEL)                                             |
| ---------------- | ----------------------------------------------------- |
| `x CONTAINS "y"` | `x.contains("y")`                                     |
| `x MATCHES "y"`  | `x.matches("y")`                                      |
| `x IS SET`       | `x != null` (already preprocessed by `preprocessHas`) |
| `x IS NOT SET`   | `x == null`                                           |

### 2.6 Remove legacy guardrail handling from `checkConstraintsCore`

**File:** `packages/compiler/src/platform/constructs/executors/constraint-executor.ts:220-260`

Per Prasanna: "We should be removing support for legacy and throw error on compile."

1. Remove the guardrail evaluation block (lines 221-260) that downgrades `warn`/`fix`/`reask`/`filter` to `respond`
2. Guardrails should ONLY go through the `GuardrailPipeline` path
3. If `constraintConfig.guardrails` is non-empty in `checkConstraintsCore`, log a deprecation warning
4. Keep flat constraint evaluation unchanged

### 2.7 Document fire-and-forget in construct executor

Add JSDoc explaining:

- `checkConstraintsCore` is synchronous
- `onCheck` callback is called synchronously; if the callback returns a Promise it is NOT awaited
- Trace logging is best-effort in this path

---

## Phase 3: Examples & Documentation Cleanup

### Scope: 26 files with fake functions, 95 files with legacy syntax, 14 files with non-spec'd constructs, 9 files with unimplemented providers

This is the largest phase by file count. Organized into 4 workstreams that can be parallelized.

---

### Workstream A: Remove Fake/Nonexistent Guardrail Functions (26 files)

**Replacement strategy:** Every fake function must be replaced with one of:

- **Tier 1 CEL:** Real `abl.*` functions for deterministic checks
- **Tier 2 Provider:** OpenAI Moderation / custom HTTP for model-based checks
- **Tier 3 LLM:** `llm_check: "prompt"` for semantic checks (toxicity, empathy, tone)

Per Prasanna: "Be explicit about the LLM prompt based guardrails on how one can achieve this kind of behavior."

```yaml
# Pattern for replacing semantic checks that don't have CEL functions:
GUARDRAILS:
  toxicity_check:
    kind: output
    llm_check: 'Does this response contain toxic, harmful, or offensive language? Respond YES if toxic, NO if safe.'
    action: block
    message: 'Response flagged for safety review.'
```

#### A.1 — Example `.abl` files (2 files)

| File                                                  | Fake Functions                                                                                                   | Replacement                                                                                               |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `examples/guardrails/agents/content_safety.agent.abl` | `not_contains_blocked_words(input)`, `toxicity_score(response) < 0.5`, `not_contains_harmful_instructions(text)` | `abl.matches_pattern()` for blocked words, `llm_check` for toxicity, `llm_check` for harmful instructions |
| `examples/guardrails/agents/pii_protection.agent.abl` | `not_matches_pattern` without `abl.` prefix                                                                      | Fix to `abl.not_matches_pattern()` or `abl.contains_pii()`                                                |
| `examples/guardrails/README.md`                       | References the above                                                                                             | Update to match corrected examples                                                                        |

#### A.2 — docs-internal guides, tutorials, and getting-started (10 files)

| File                                                                    | Fake Functions                                                                                                                                                                                                           | Lines                                                                        |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `apps/docs-internal/content/guides/safety-and-guardrails.mdx`           | `not_contains_blocked_words`, `toxicity_score`, `not_contains_harmful_instructions`, `not_contains_html_tags`, unimplemented providers                                                                                   | 27, 95, 113, 119, 207, 235, 720-727                                          |
| `apps/docs-internal/content/tutorials/safety-testing-publishing.mdx`    | `toxicity_score`, `not_contains_harmful_instructions`                                                                                                                                                                    | 69, 118, 231, 262                                                            |
| `apps/docs-internal/content/examples/by-pattern.mdx`                    | `not_contains_harmful_instructions`, `not_contains_full_account_number`, `not_contains_credentials`                                                                                                                      | 671, 1235, 1242                                                              |
| `apps/docs-internal/content/examples/by-industry.mdx`                   | Legacy syntax in guardrail examples                                                                                                                                                                                      | Check for fake functions                                                     |
| `apps/docs-internal/content/abl-reference/guardrails.mdx`               | `not_contains_blocked_words`, `not_contains_ssn`, `toxicity_score`, `not_contains_full_account_number`, `not_contains_credentials`, `not_contains_html_tags`, `not_contains_excessive_whitespace`, `collapse_whitespace` | 26, 35, 167, 170, 252, 259, 270                                              |
| `apps/docs-internal/content/admin/workspace-configuration.mdx`          | References unimplemented provider types                                                                                                                                                                                  | Check and fix                                                                |
| `apps/docs-internal/content/getting-started/platform-overview.mdx`      | `not_contains_blocked_words(input)` at line 183                                                                                                                                                                          | **Previously missing** — replace with `abl.matches_pattern()` or `llm_check` |
| `apps/docs-internal/content/getting-started/platform-overview-user.mdx` | `not_contains_blocked_words(input)` at line 155, `toxicity_score(response)` at line 161                                                                                                                                  | **Previously missing** — replace with real functions                         |

#### A.3 — Reference/architecture docs (5 files)

| File                                    | Fake Functions                                                                         | Lines                           |
| --------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------- |
| `docs/reference/CONSTRAINTS.md`         | `shows_empathy`, `use_system_timelines`, `no_competitor_mentions`, `end_positively`    | 187, 193, 199, 205, 428, 434    |
| `docs/reference/ABL_SPEC.md`            | `no_pii_patterns`, `content_safety`, `valid_parameters`, `no_competitor_mentions`      | 635, 641, 647, 656              |
| `docs/architecture/AGENT_ABL_DESIGN.md` | `shows_empathy`, `use_system_timelines`                                                | 306, 312                        |
| `docs/architecture/GUARDRAILS_SPEC.md`  | `not_contains_patterns([...])` at line 226, example Bedrock provider code at 1198-1210 | **Line 226 previously missing** |

#### A.4 — Built-in templates correction

**File:** `apps/docs-internal/content/abl-reference/guardrails.mdx`

Fix the built-in templates list. Actual built-ins (from code) are:

- `detect_instruction_override`
- `detect_role_manipulation`
- `detect_system_prompt_extraction`
- `detect_encoding_tricks`
- `detect_credential_leak`

Remove any references to non-existent templates (account masking, profanity filter, etc.).

---

### Workstream B: Validate Retained ABL Syntax (95 files)

#### B.1 — Example `.abl` files (69 files)

**IMPORTANT: Do NOT migrate `.abl` source files to CEL syntax.** The decision is to keep ABL syntax for developers. The compiler normalizes to CEL at compile time. These files keep `IS SET`, `AND`, `OR`, `contains` as-is.

**What B.1 actually does:** Verify all 69 files compile correctly through the updated compiler (Phase 2.2 normalization). No source changes needed unless a file uses a construct that the parser/compiler can't handle.

Representative files (verify compilation — do NOT change syntax):

| Directory                               | Files                                                                                     | Key Patterns                       |
| --------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------- |
| `examples/travel/agents/`               | `authentication.agent.abl`, `booking_manager.agent.abl` + others                          | `AND`, `OR`, `IS SET`              |
| `examples/retail/agents/`               | `sales_agent.agent.abl`, `order_tracking.agent.abl` + others                              | `IS SET`, `OR`                     |
| `examples/afg-blue-advisory/agents/`    | `advisor_agent.agent.abl` + others                                                        | `IS SET`, `OR`                     |
| `examples/banknexus/agents/`            | `fund_transfer.agent.abl` + others                                                        | `IS SET`                           |
| `examples/apple-care/agents/`           | `account_support.agent.abl`, `device_support.agent.abl`, `subscription_support.agent.abl` | `AND`, `IS SET`, `BEFORE`          |
| `examples/DisputeTransaction/agents/`   | `dispute.agent.abl`                                                                       | `AND`, `IS SET`, `IMPLIES`, `WHEN` |
| `examples/search-ai-strategies/agents/` | `aggregation-agent.agent.abl`, `list-query-agent.agent.abl`                               | `IS SET`, `BEFORE`                 |
| `examples/flow-test/agents/`            | `hotel_booking.agent.abl` + others                                                        | `AND`, `IS SET`, phase names       |
| `examples/guardrails/agents/`           | Already covered in Workstream A                                                           | —                                  |

**`BEFORE` and `IMPLIES` in examples:** Keep the syntax in examples. `IMPLIES` is now implemented, and structural `BEFORE` is implemented for `BEFORE calling <tool>` and `BEFORE returning results`. Non-structural `BEFORE` is retained for compatibility, but current examples should use `IMPLIES` or `WHEN` instead of relying on the warning-only compatibility path.

#### B.2 — docs-internal `.mdx` files (14 files)

These contain inline ABL code examples that developers follow step-by-step. **ABL syntax stays in the code examples.** The only change is adding a "Compiles to" annotation showing the CEL equivalent where it aids understanding.

| File                                                                        | ABL Patterns (KEEP)                                                               | Change Needed                              |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------ |
| `apps/docs-internal/content/abl-reference/full-specification.mdx`           | `AND`, `OR`, `NOT`, `IS SET`, `CONTAINS`, `MATCHES` — pervasive                   | Add "Compiles to" annotations              |
| `apps/docs-internal/content/abl-reference/rich-content-and-expressions.mdx` | `AND`, `OR`, `NOT`, `CONTAINS`, `MATCHES`, `IS SET` — this IS the expression spec | Add "Compiles to" column in operator table |
| `apps/docs-internal/content/abl-reference/memory-and-constraints.mdx`       | `IS SET`, `AND`, `LIMIT`, `RESTRICT`                                              | High — constraint reference                |
| `apps/docs-internal/content/abl-reference/flow.mdx`                         | `AND`, `OR`, `IS SET`                                                             | Medium                                     |
| `apps/docs-internal/content/abl-reference/language-overview.mdx`            | `IS SET`, `AND`                                                                   | Medium — first doc new devs read           |
| `apps/docs-internal/content/guides/building-reasoning-agents.mdx`           | `IS SET`, `AND`                                                                   | Medium                                     |
| `apps/docs-internal/content/guides/building-scripted-flows.mdx`             | `IS SET`, `AND`, `OR`                                                             | Medium                                     |
| `apps/docs-internal/content/guides/data-collection-with-gather.mdx`         | `IS SET`                                                                          | Low                                        |
| `apps/docs-internal/content/guides/memory-and-state.mdx`                    | `IS SET`                                                                          | Low                                        |
| `apps/docs-internal/content/tutorials/build-a-scripted-flow.mdx`            | `AND`, `IS SET`                                                                   | High — step-by-step tutorial               |
| `apps/docs-internal/content/tutorials/safety-testing-publishing.mdx`        | `BEFORE`, fake functions                                                          | High — covered in A.2 + BEFORE             |
| `apps/docs-internal/content/getting-started/platform-overview.mdx`          | `IS SET`                                                                          | Medium — first impression                  |
| `apps/docs-internal/content/examples/by-industry.mdx`                       | `IS SET`, `AND`                                                                   | Low                                        |
| `apps/docs-internal/content/examples/by-pattern.mdx`                        | `IS SET`, `AND`                                                                   | Low — covered in A.2 for fake functions    |

**Resolved direction for B.2:** Developer-facing docs keep ABL syntax. Where helpful, add a "Compiled Form" or equivalent note that shows the CEL lowering for reference, but do not rewrite the surface language into CEL.

#### B.3 — Reference docs `.md` (3 files)

| File                                    | Legacy Patterns                                                      |
| --------------------------------------- | -------------------------------------------------------------------- |
| `docs/reference/ABL_SPEC.md`            | `AND`, `OR`, `NOT`, `IS SET`, `CONTAINS`, `MATCHES` — canonical spec |
| `docs/reference/CONSTRAINTS.md`         | `IS SET`, `AND`                                                      |
| `docs/reference/ABL_QUICK_REFERENCE.md` | `IS SET`, `AND`, `OR` — **not mentioned in previous plan**           |

**Resolved direction for B.3:** Reference docs keep ABL syntax, then add CEL-equivalent annotations only where they help explain the runtime lowering.

---

### Workstream C: Fix Non-Spec'd Constructs in Docs/Examples (14 files)

#### C.1 — `BEFORE` references (8 example files + 2 docs)

| File                                                                 | Line               | Usage                                                                                               |
| -------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------- |
| `examples/apple-care/agents/account_support.agent.abl`               | 169                | Legacy non-structural `BEFORE` replaced with explicit `WHEN` / `IMPLIES` guards                     |
| `examples/apple-care/agents/device_support.agent.abl`                | 183                | Legacy non-structural `BEFORE` replaced with `IMPLIES`                                              |
| `examples/apple-care/agents/subscription_support.agent.abl`          | 192                | Legacy non-structural `BEFORE` replaced with explicit `WHEN` / `IMPLIES` guards                     |
| `examples/DisputeTransaction/agents/dispute.agent.abl`               | 215                | Legacy non-structural `BEFORE` replaced with `IMPLIES`                                              |
| `examples/search-ai-strategies/agents/aggregation-agent.agent.abl`   | 39                 | `REQUIRE measure_field IS SET BEFORE calling search_aggregate`                                      |
| `examples/search-ai-strategies/agents/list-query-agent.agent.abl`    | 38                 | `REQUIRE resolved_fields IS SET BEFORE calling search_structured`                                   |
| `apps/docs-internal/content/tutorials/safety-testing-publishing.mdx` | 142                | `REQUIRE action == "view_account" IMPLIES user_verified == true`                                    |
| `apps/docs-internal/content/guides/knowledge-bases.mdx`              | 368, 474, 499, 500 | `REQUIRE measure_field IS SET BEFORE calling search_aggregate` and similar — **previously missing** |

**Action:** Structural `BEFORE` examples stay as-is. Executable non-structural examples should use `IMPLIES` / `WHEN`; any remaining compatibility-form `BEFORE` references are legacy cleanup items and compile as warning-only no-ops.

#### C.2 — `IMPLIES` references (1 file)

| File                                                   | Line | Usage                                                         |
| ------------------------------------------------------ | ---- | ------------------------------------------------------------- |
| `examples/DisputeTransaction/agents/dispute.agent.abl` | 219  | `REQUIRE dispute_type == "card" IMPLIES card_unique_id != ""` |

**Action:** Keep and document `IMPLIES` as the preferred readable form for conditional constraints. The compiler lowers it to `NOT A OR B`.

#### C.3 — `LIMIT`/`RESTRICT` as constraint keywords (1 file)

| File                                                                  | Lines   | Usage                                                                          |
| --------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------ |
| `apps/docs-internal/content/abl-reference/memory-and-constraints.mdx` | 315-331 | Formally documents `LIMIT` and `RESTRICT` as constraint keywords with examples |

**Action:** Keep both constructs in docs/examples and document the current runtime story accurately: they are preserved as distinct parser/IR kinds today and initially reuse the standard constraint handling path until specialized semantics are expanded.

#### C.4 — Constraint phase names in examples

| Directory                     | Files Affected                     |
| ----------------------------- | ---------------------------------- |
| `examples/travel/agents/`     | Phase headers in constraint blocks |
| `examples/apple-care/agents/` | Phase headers in constraint blocks |
| `examples/telco/agents/`      | Phase headers in constraint blocks |
| `examples/retail/agents/`     | Phase headers in constraint blocks |
| `examples/flow-test/agents/`  | Phase headers in constraint blocks |

**Action:** Retain phase headers as label-only authoring structure. Add explicit `WHEN` or structural `BEFORE` where runtime gating matters, and document that labels do not act as executable selectors by themselves.

---

### Workstream D: Remove Unimplemented Provider References (9 files)

Only 4 tenant-configurable provider adapters are implemented: `openai_moderation`, `custom_http`, `custom_webhook`, `custom_llm`.

#### D.0 — Reconcile provider inventory FIRST (prerequisite bug fix)

**The plan previously claimed 4 implemented providers. This is wrong.** There are 3 inconsistent provider lists:

| Adapter Type        | DB Schema (15) | Studio UI (14) | Route Allowlist (4) | Factory Switch (4)                  |
| ------------------- | -------------- | -------------- | ------------------- | ----------------------------------- |
| `custom_http`       | YES            | YES            | YES                 | YES                                 |
| `custom_webhook`    | YES            | YES            | YES                 | YES                                 |
| `custom_llm`        | YES            | YES            | YES                 | YES                                 |
| `builtin_pii`       | YES            | YES            | **NO**              | **NO** (auto-registered separately) |
| `openai_moderation` | YES            | YES            | YES                 | YES                                 |
| `openai_compatible` | YES            | YES            | NO                  | NO                                  |
| 8 others            | YES            | YES            | NO                  | NO                                  |

**Critical bug:** `openai_moderation` has a working factory implementation and must stay in the route/studio allowlists, but `builtin_pii` must not. The built-in PII provider is auto-registered separately as `builtin-pii`, not loaded from tenant DB config.

**Fix:** Keep `openai_moderation` in `IMPLEMENTED_ADAPTER_TYPES`, remove `builtin_pii`, and update the Studio form to only show tenant-configurable adapters.

- `apps/runtime/src/routes/guardrail-providers.ts:47`
- `apps/studio/src/app/api/admin/guardrail-providers/route.ts:177`

**Corrected implemented set:** `custom_http`, `custom_webhook`, `custom_llm`, `openai_moderation` (4 tenant-configurable adapters). The built-in provider `builtin-pii` still exists, but as an auto-registered runtime singleton rather than a tenant-configured adapter.

**Follow-up:** `openai_moderation` still needs a credential UX cleanup. The factory can use `authProfileId` or `apiKeyCredentialId`, but the raw Studio `apiKey` field is not persisted into a runtime-consumable credential reference yet.

#### D.1 — Studio UI (1 file)

| File                                                         | Change                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/components/admin/GuardrailProviderForm.tsx` | Hide/disable: `openai_compatible`, `huggingface_inference`, `anthropic`, `google_cloud`, `vertex_ai`, `bedrock`, `azure_content_safety`, `lakera`, `aporia`, `other`, `builtin_pii`. Show: `custom_http`, `custom_webhook`, `custom_llm`, `openai_moderation`. |

#### D.2 — docs-internal (3 files)

| File                                                                          | Issue                                             | Change                          |
| ----------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------- |
| `apps/docs-internal/content/guides/safety-and-guardrails.mdx` (lines 720-727) | Lists unimplemented providers as available        | Remove or mark as "Coming Soon" |
| `apps/docs-internal/content/admin/workspace-configuration.mdx`                | References unimplemented providers                | Same                            |
| `apps/docs-internal/content/abl-reference/guardrails.mdx`                     | May reference unimplemented providers in examples | Verify and fix                  |

#### D.3 — Architecture/design docs (5 files)

| File                                                              | Issue                                           | Change                                  |
| ----------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------- |
| `docs/architecture/GUARDRAILS_SPEC.md` (lines 444-448, 1198-1210) | Bedrock/Azure/Vertex defined with example code  | Mark as "Planned — not yet implemented" |
| `docs/plans/2026-03-08-guardrails-ui-design.md`                   | Lists all adapter types including unimplemented | Mark as "Planned" in the table          |
| `docs/plans/2026-03-08-guardrails-ui-plan.md`                     | Same                                            | Same                                    |
| `docs/plans/2026-03-10-guardrails-hardening-plan.md`              | References unimplemented providers              | Add status column                       |
| `docs/audit/guardrails-coverage-matrix-2026-03-09.md`             | Already marks them correctly                    | No change needed                        |

---

### Workstream E: COLLECT/ON_INPUT Example Fixes

**Files affected:** Any example using COLLECT + ON_INPUT with ELSE that implies catch-all behavior.

Update examples to clarify the actual two-point ON_INPUT behavior: ELSE is the fallback branch both when zero fields were extracted during gather recovery and after COLLECT succeeds.

```yaml
get_destination:
  COLLECT: destination
  PROMPT: 'Where would you like to stay?'
  ON_INPUT:
    - IF: input == "back"
      RESPOND: 'Going back...'
      THEN: welcome
    - IF: input.contains("help")
      RESPOND: 'I need to know your destination city.'
      THEN: get_destination
    # ELSE is the fallback when no prior ON_INPUT branch matches
    - ELSE:
      THEN: get_dates
```

---

### Phase 3 Summary

| Workstream                               | Files                                                         | Effort                  | Blocked?                |
| ---------------------------------------- | ------------------------------------------------------------- | ----------------------- | ----------------------- |
| **A — Fake guardrail functions**         | 26 files                                                      | 2 days                  | No                      |
| **B — "Compiles to" annotations**        | 17 `.mdx`/`.md` files (ABL syntax stays, add CEL annotations) | 1.5 days (manual)       | No                      |
| **B — Example compilation verification** | 69 `.abl` files (no source changes — verify compilation)      | 0.5 day                 | No — depends on Phase 2 |
| **C — Deferred construct comments**      | 14 files                                                      | 0.5 day (comments only) | No — just adding notes  |
| **D — Unimplemented providers**          | 9 files                                                       | 0.5 day                 | No                      |
| **E — COLLECT/ON_INPUT**                 | ~5 files                                                      | 0.5 day                 | No                      |
| **Total**                                | **~130 files**                                                | **~5.5 days**           |                         |

### Phase 3 Decisions (RESOLVED)

1. **Developer-facing docs keep ABL syntax**, add "Compiles to" column showing CEL equivalents. ABL is the developer-facing language; CEL is the runtime. Docs should reflect what developers write.

2. **Retained constructs stay in parser/docs/examples.** `IMPLIES` is implemented. Structural `BEFORE` is implemented for tool-call and final-response checkpoints. `LIMIT` / `RESTRICT` are retained as distinct parser/IR kinds and currently alias standard constraint handling at runtime. Follow-up work is limited to legacy non-structural `BEFORE` cleanup and any future expansion beyond the supported checkpoint shapes.

---

## Phase 4: Constraint Behavior Fixes

### 4.1 Fix post-extraction violation — only clear violating field

**File:** `apps/runtime/src/services/execution/flow-step-executor.ts:3508-3512`

Currently clears ALL extracted fields on any constraint violation. Should only clear the field(s) referenced in the violating condition.

**Approach:**

1. Parse the constraint condition to extract referenced variable names (reuse `extractVariableReferences()` from compiler)
2. Intersect with `Object.keys(extractedData)` to find which extracted fields are in the condition
3. Clear only those fields
4. If intersection is empty (condition references fields not in extractedData), fall back to clearing all

```typescript
// Instead of: for (const field of Object.keys(extractedData)) { deleteSessionValue(...) }
const conditionVars = extractVariableReferences(postExtractionViolation.condition);
const violatingFields = Object.keys(extractedData).filter((f) => conditionVars.has(f));
const fieldsToClear = violatingFields.length > 0 ? violatingFields : Object.keys(extractedData);
for (const field of fieldsToClear) {
  deleteSessionValue(session, field);
}
session.waitingForInput = fieldsToClear;
```

**Tests:** User provides `destination=NYC, origin=LAX, guests=50`. Constraint `guests <= 10` fails. Only `guests` is cleared; `destination` and `origin` are retained.

### 4.2 Holistic constraint handoff review

Per Prasanna: "This need to be reviewed holistically and needs to be redesigned to be more explicit and clear."

**Current state:** Active runtime checkpoint paths now execute real `ON_FAIL: HANDOFF` transfers through the shared constraint-violation executor, and they fall back to a compatibility response only if routing rejects the handoff. This removes the previous warning-only/runtime-signal mismatch for the main flow and reasoning paths.

**What still needs review:** The remaining design work is now about consistency and clarity, not whether handoff is wired at all:

Option A — Standardize every constraint failure path on the shared immediate-execution model
Option B — Keep immediate execution, but further clarify docs/spec around when constraint handoff vs flow routing should be used
Option C — Reduce the surface area later if we decide constraint handoff is too implicit, but do not regress current runtime support

**Follow-up:** Audit any remaining legacy/special-case paths and align docs/spec language with the shared executor behavior.

---

## Deferred: Follow-Up Work (Not Part of This Exercise)

The following items need spec decisions and are tracked separately:

### BEFORE temporal constraints

- Structural `BEFORE` is implemented for `BEFORE calling <tool>` and `BEFORE returning results`.
- Legacy non-structural `BEFORE` is retained in parser/compiler for compatibility, but it now compiles with `W824` and no runtime effect.
- **Action for now:** Keep structural `BEFORE` examples as-is, and rewrite any new non-structural usages to `IMPLIES` / `WHEN` instead of relying on compatibility behavior.

### LIMIT / RESTRICT constraint keywords

- Both constructs are now retained in parser/docs/examples and preserved as distinct kinds in IR.
- Runtime currently aliases them to the existing constraint violation handling path.
- **Action for now:** Add specialized semantics later only if product behavior needs to diverge from standard `REQUIRE`.

### IMPLIES logical operator

- `IMPLIES` is implemented as compiler lowering: `A IMPLIES B` → `!(A) || (B)`.
- **Action for now:** Prefer `IMPLIES` for logical dependency examples that were previously expressed with non-structural `BEFORE`.

---

## Phase 5: Compile-Time Validation + Spec Updates

### 5.1 Warn on unregistered CEL functions in guardrail checks

**File:** `packages/compiler/src/platform/ir/guardrail-validator.ts`

Add validation that parses the `check` expression and warns if it references functions not in the registered CEL function list.

If a check like `toxicity_score(response)` references an unregistered function, emit:

```
⚠ Guardrail "content_safety": check references unknown function "toxicity_score".
  Available functions: abl.contains_pii, abl.matches_pattern, ...
  For semantic checks (toxicity, empathy), use llm_check instead.
```

### 5.2 Warn on phase names in CONSTRAINTS

**File:** `packages/compiler/src/platform/ir/compiler.ts` (in `compileConstraints`)

When a constraint phase has a name other than `"always"` or `""`, emit a compile-time warning:

```
⚠ Constraint phase "pre_booking" has no runtime effect — all constraints evaluate every turn.
  Phase names are treated as labels for readability only.
```

Status: Completed in current working tree as warning-only behavior. Do not add runtime phase gating in this cleanup slice.

### 5.3 Spec updates (ABL_SPEC.md) — this exercise only

| Item                      | Action                                                             |
| ------------------------- | ------------------------------------------------------------------ |
| 9 guardrail CEL functions | Add "Guardrail Functions" section to spec                          |
| `WHEN` on constraints     | Clarify as a block-level applicability field on a constraint entry |
| EBNF grammar              | Update to include all spec'd operators (currently incomplete)      |

**Spec/doc alignment items**: finalize retained-construct wording for `BEFORE`, `IMPLIES`, `LIMIT`, and `RESTRICT` across examples, reference docs, and compiler notes.

---

## Execution Order

| Phase                                                | Sprint    | Effort   | Risk                                                                      |
| ---------------------------------------------------- | --------- | -------- | ------------------------------------------------------------------------- |
| **Phase 1** — Critical bug fixes                     | Current   | 2 days   | Low — isolated compiler changes with clear test cases                     |
| **Phase 2** — Legacy evaluator removal               | Current   | 3 days   | Medium — requires migrator gap fixes, parity testing, template extraction |
| **Phase 3A** — Remove fake guardrail functions       | Current+1 | 2 days   | Low — 26 files, replace with real `abl.*` or `llm_check`                  |
| **Phase 3B** — Add "Compiles to" annotations in docs | Current+1 | 1.5 days | Low — 17 `.mdx`/`.md` files, ABL syntax stays                             |
| **Phase 3B** — Verify example compilation            | Current+1 | 0.5 day  | Low — no source changes, just verify 69 files compile                     |
| **Phase 3C** — Retained construct docs alignment     | Current+1 | 0.5 day  | Low — clarify BEFORE/LIMIT/RESTRICT/IMPLIES without removing syntax       |
| **Phase 3D** — Unimplemented provider cleanup        | Current+1 | 0.5 day  | Low — UI + docs                                                           |
| **Phase 3E** — COLLECT/ON_INPUT fixes                | Current+1 | 0.5 day  | Low                                                                       |
| **Phase 4** — Constraint behavior fixes              | Next      | 1.5 days | Low — 4.1 field clearing + 4.2 handoff TODO                               |
| **Phase 5** — Compile-time validation + spec         | Next      | 2 days   | Low — additive warnings + documentation                                   |

**Total:** ~14 days across 2-3 sprints. Phase 3 workstreams (A-E) can run in parallel.

**Dependencies:**

- Phase 2 depends on Phase 1 (bug fixes needed before removing fallback)
- Phase 3 depends on Phase 2 only for runtime parity work; examples and docs keep ABL syntax throughout
- Phase 4 and Phase 5 can run in parallel
- BEFORE/LIMIT/RESTRICT/IMPLIES stay retained throughout; follow-up work is semantics/spec alignment, not syntax removal

---

## Files Inventory

### Code Changes

| File                                                                         | Phase                   | Change                                                                 |
| ---------------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------- |
| `packages/compiler/src/platform/ir/compiler.ts`                              | 1.1, 1.2, 1.3, 2.2, 5.2 | parseOnFail prefixes, CONSTRAINT_KEYWORDS, normalize-to-CEL, warnings  |
| `packages/compiler/src/platform/ir/guardrail-validator.ts`                   | 5.1                     | CEL function validation                                                |
| `packages/compiler/src/platform/constructs/expression-migrator.ts`           | 2.1                     | Add all spec'd operator migrations                                     |
| `packages/compiler/src/platform/constructs/dual-evaluator.ts`                | 2.3, 2.4, 2.5           | Remove fallback, rename to evaluator.ts                                |
| `packages/compiler/src/platform/constructs/evaluator.ts`                     | 2.4                     | **DELETE** (1,100+ lines)                                              |
| `packages/compiler/src/platform/constructs/template-utils.ts`                | 2.4                     | **NEW** — `interpolateMessage` extracted from evaluator.ts (~50 lines) |
| `packages/compiler/src/platform/constructs/executors/constraint-executor.ts` | 2.6, 2.7                | Remove legacy guardrail eval, add docs                                 |
| `apps/runtime/src/services/execution/constraint-checker.ts`                  | 2.6                     | Verify guardrail routing                                               |
| `apps/runtime/src/services/execution/flow-step-executor.ts`                  | 4.1                     | Targeted field clearing                                                |
| `apps/studio/src/components/admin/GuardrailProviderForm.tsx`                 | 3.6                     | Hide unimplemented providers                                           |

### Example Files (69 `.abl` files + README)

| File                                                         | Workstream    | Change                                                                             |
| ------------------------------------------------------------ | ------------- | ---------------------------------------------------------------------------------- |
| `examples/guardrails/agents/content_safety.agent.abl`        | A.1           | Replace 3 fake functions with real `abl.*` or `llm_check`                          |
| `examples/guardrails/agents/pii_protection.agent.abl`        | A.1           | Fix `abl.` prefix                                                                  |
| `examples/guardrails/README.md`                              | A.1           | Update to match corrected examples                                                 |
| `examples/apple-care/agents/*.agent.abl` (3 files)           | B.1, C.1, C.4 | Verify retained syntax compiles, add BEFORE comments, retain phase labels          |
| `examples/DisputeTransaction/agents/dispute.agent.abl`       | B.1, C.1, C.2 | Verify retained syntax compiles, document BEFORE + IMPLIES usage                   |
| `examples/search-ai-strategies/agents/*.agent.abl` (2 files) | B.1, C.1      | Verify retained syntax compiles, add BEFORE comments where helpful                 |
| `examples/travel/agents/*.agent.abl`                         | B.1, C.4      | Verify retained syntax compiles, retain phase labels                               |
| `examples/retail/agents/*.agent.abl`                         | B.1, C.4      | Verify retained syntax compiles, retain phase labels                               |
| `examples/telco/agents/*.agent.abl`                          | B.1, C.4      | Verify retained syntax compiles, retain phase labels                               |
| `examples/banknexus/agents/*.agent.abl`                      | B.1           | Verify retained syntax compiles                                                    |
| `examples/afg-blue-advisory/agents/*.agent.abl`              | B.1           | Verify retained syntax compiles                                                    |
| `examples/flow-test/agents/*.agent.abl`                      | B.1, C.4, E   | Verify retained syntax compiles, retain phase labels, fix ON_INPUT                 |
| `examples/**/*.agent.abl` (remaining ~55 files)              | B.1           | Verify compiler coverage for retained syntax; patch only files that do not compile |

### Documentation — docs-internal (14 `.mdx` files)

| File                                                                        | Workstream    | Change                                                                                 |
| --------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------- |
| `apps/docs-internal/content/abl-reference/guardrails.mdx`                   | A.2, A.4, D.2 | Replace 8+ fake functions, fix built-in templates, remove unimplemented providers      |
| `apps/docs-internal/content/abl-reference/full-specification.mdx`           | B.2           | Keep ABL syntax, add CEL-equivalent notes/examples where they clarify runtime lowering |
| `apps/docs-internal/content/abl-reference/rich-content-and-expressions.mdx` | B.2           | Add "Compiles to" column — this IS the expression spec                                 |
| `apps/docs-internal/content/abl-reference/memory-and-constraints.mdx`       | B.2, C.3      | Clarify LIMIT/RESTRICT status; add compiled-form notes where helpful                   |
| `apps/docs-internal/content/abl-reference/flow.mdx`                         | B.2           | Add compiled-form notes where helpful                                                  |
| `apps/docs-internal/content/abl-reference/language-overview.mdx`            | B.2           | Add compiled-form notes where helpful                                                  |
| `apps/docs-internal/content/guides/safety-and-guardrails.mdx`               | A.2, D.2      | Replace fake functions, remove unimplemented providers                                 |
| `apps/docs-internal/content/guides/building-reasoning-agents.mdx`           | B.2           | Add compiled-form notes where helpful                                                  |
| `apps/docs-internal/content/guides/building-scripted-flows.mdx`             | B.2           | Add compiled-form notes where helpful                                                  |
| `apps/docs-internal/content/guides/data-collection-with-gather.mdx`         | B.2           | Add compiled-form notes where helpful                                                  |
| `apps/docs-internal/content/guides/memory-and-state.mdx`                    | B.2           | Add compiled-form notes where helpful                                                  |
| `apps/docs-internal/content/tutorials/build-a-scripted-flow.mdx`            | B.2           | Add compiled-form notes where helpful                                                  |
| `apps/docs-internal/content/tutorials/safety-testing-publishing.mdx`        | A.2, C.1      | Replace fake functions, add BEFORE comment                                             |
| `apps/docs-internal/content/getting-started/platform-overview.mdx`          | A.2, B.2      | Replace fake functions, add compiled-form notes where helpful                          |
| `apps/docs-internal/content/getting-started/platform-overview-user.mdx`     | A.2           | Replace `not_contains_blocked_words`, `toxicity_score` — **previously missing**        |
| `apps/docs-internal/content/guides/knowledge-bases.mdx`                     | C.1           | Add BEFORE comments (4 occurrences) — **previously missing**                           |
| `apps/docs-internal/content/examples/by-pattern.mdx`                        | A.2, B.2      | Replace 3 fake functions, add compiled-form notes where helpful                        |
| `apps/docs-internal/content/examples/by-industry.mdx`                       | B.2           | Add compiled-form notes where helpful                                                  |
| `apps/docs-internal/content/admin/workspace-configuration.mdx`              | D.2           | Remove unimplemented provider references                                               |

### Documentation — reference docs (4 `.md` files)

| File                                    | Workstream    | Change                                                                                          |
| --------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------- |
| `docs/reference/ABL_SPEC.md`            | A.3, B.3, 5.3 | Remove 4 fake functions, add guardrail functions section, clarify BEFORE/IMPLIES/LIMIT/RESTRICT |
| `docs/reference/CONSTRAINTS.md`         | A.3, B.3      | Remove 4 fake functions                                                                         |
| `docs/reference/ABL_QUICK_REFERENCE.md` | B.3           | Add compiled-form notes where helpful — **previously missing from plan**                        |
| `docs/architecture/AGENT_ABL_DESIGN.md` | A.3           | Remove 2 fake functions                                                                         |

### Documentation — architecture/design docs (5 files, provider cleanup)

| File                                                  | Workstream | Change                                                       |
| ----------------------------------------------------- | ---------- | ------------------------------------------------------------ |
| `docs/architecture/GUARDRAILS_SPEC.md`                | D.3        | Mark Bedrock/Azure/Vertex as "Planned — not yet implemented" |
| `docs/plans/2026-03-08-guardrails-ui-design.md`       | D.3        | Add status column to provider table                          |
| `docs/plans/2026-03-08-guardrails-ui-plan.md`         | D.3        | Add status column                                            |
| `docs/plans/2026-03-10-guardrails-hardening-plan.md`  | D.3        | Add status column                                            |
| `docs/audit/guardrails-coverage-matrix-2026-03-09.md` | —          | Already correct, no change                                   |

### Studio UI (1 file)

| File                                                         | Workstream | Change                              |
| ------------------------------------------------------------ | ---------- | ----------------------------------- |
| `apps/studio/src/components/admin/GuardrailProviderForm.tsx` | D.1        | Hide 11 unimplemented adapter types |

---

## Comprehensive E2E & Integration Test Checklist

### Current Test Baseline

| Area                               | Files   | Tests     | Notes                                                             |
| ---------------------------------- | ------- | --------- | ----------------------------------------------------------------- |
| Compiler — Evaluator/Expression    | 12      | 800       | Heavy legacy evaluator coverage (265 tests) that must be migrated |
| Compiler — Constraint Control Flow | 5       | 75        | Good parseOnFail coverage, weak auto-guard (8 tests)              |
| Compiler — Guardrails              | 32      | 422       | Comprehensive pipeline/provider unit tests                        |
| Runtime — Constraints              | 14      | 254       | Good unit coverage, no real HTTP E2E                              |
| Runtime — Guardrails               | 38      | 389       | Comprehensive unit coverage, no real HTTP E2E                     |
| **Total**                          | **103** | **1,950** |                                                                   |

### Test Gap Analysis

| Gap                                     | Current State                                                              | Risk if Untested                                         |
| --------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------- |
| No HTTP E2E for constraints             | All tests mock at unit level                                               | Auth/middleware/serialization bugs missed                |
| No multi-turn constraint flow E2E       | No test verifies collect → re-extract → re-evaluate → goto through runtime | Control flow regressions in complex conversations        |
| No HTTP E2E for guardrails              | All tests mock pipeline/providers                                          | Same as above — the A2A lesson                           |
| `parseOnFail` prefix coverage           | 5 parser tests only                                                        | BLOCK/RESPOND/REDACT prefixes already broken             |
| Auto-guard with operators               | 8 tests                                                                    | `contains` already breaks auto-guard                     |
| Post-extraction field clearing          | Mini-collect test only                                                     | Blanket clearing loses valid user data                   |
| Reask action loop                       | Pipeline-level only                                                        | No runtime verification of correction loop               |
| Policy scoping E2E                      | Resolver tests only                                                        | Tenant → project → agent override not tested through API |
| CEL-only migration parity               | 61 parity tests                                                            | Must verify ALL 800 legacy tests pass via CEL            |
| Lowercase `contains` migration          | Zero tests                                                                 | 91 expressions in 26 files would break                   |
| Template interpolation after extraction | Zero tests                                                                 | `interpolateMessage` standalone utility untested         |

---

### Phase 1 Tests: Critical Bug Fixes

#### T1.1 — `parseOnFail` prefix detection (NEW: `packages/compiler/src/__tests__/parse-on-fail-prefixes.test.ts`)

```
Unit Tests (12):
☐ ON_FAIL: "plain message" → { type: 'respond', message: 'plain message' }
☐ ON_FAIL: BLOCK → { type: 'block', message: undefined }
☐ ON_FAIL: BLOCK "Custom blocked" → { type: 'block', message: 'Custom blocked' }
☐ ON_FAIL: RESPOND "Sorry, max 10" → { type: 'respond', message: 'Sorry, max 10' }
☐ ON_FAIL: RESPOND 'single quotes' → { type: 'respond', message: 'single quotes' }
☐ ON_FAIL: REDACT → { type: 'redact', message: undefined }
☐ ON_FAIL: REDACT "PII detected" → { type: 'redact', message: 'PII detected' }
☐ ON_FAIL: ESCALATE urgent → { type: 'escalate', reason: 'urgent' } (existing, verify)
☐ ON_FAIL: HANDOFF billing_agent → { type: 'handoff', target: 'billing_agent' } (runtime execution verified; add explicit regression coverage)
☐ ON_FAIL: HANDOFF billing_agent Please help → { type: 'handoff', target: 'billing_agent', message: 'Please help' }
☐ Structured ON_FAIL block with COLLECT/GOTO/RETRY → correct typed actions
☐ ON_FAIL: | (multiline) → correct message
```

#### T1.2 — `CONSTRAINT_KEYWORDS` auto-guard (NEW: `packages/compiler/src/__tests__/constraint-keywords-autoguard.test.ts`)

```
Unit Tests (10):
☐ 'input contains "booking"' → does NOT generate 'contains IS NOT SET OR ...'
☐ 'name startsWith "Dr"' → does NOT generate 'startsWith IS NOT SET OR ...'
☐ 'email endsWith ".gov"' → does NOT generate 'endsWith IS NOT SET OR ...'
☐ 'pattern matches "\\d+"' → does NOT generate 'matches IS NOT SET OR ...'
☐ 'items has "widget"' → does NOT generate 'has IS NOT SET OR ...'
☐ 'status equals "active"' → does NOT generate 'equals IS NOT SET OR ...'
☐ 'role in ["admin","user"]' → does NOT generate 'in IS NOT SET OR ...'
☐ 'num_guests > 10' → DOES generate 'num_guests IS NOT SET OR num_guests > 10' (variable, not keyword)
☐ 'destination != origin' → DOES generate guards for both variables
☐ Mixed: 'input contains "x" AND guests > 5' → guards only 'guests', not 'input' or 'contains'
```

#### T1.3 — Compile-time `required + default` warning (ADD to existing compilation tests)

```
Unit Tests (3):
☐ Field with required:false + default → emits diagnostic warning
☐ Field with required:true + default → no warning (valid but redundant — default satisfies)
☐ Field with required:false + no default → no warning
```

---

### Phase 2 Tests: Legacy Evaluator Removal

#### T2.1 — Expression migrator gaps (EXTEND: `packages/compiler/src/__tests__/constructs/expression-migrator.test.ts`)

```
Unit Tests (30):

Lowercase contains/matches:
☐ 'input contains "hello"' → 'input.contains("hello")'
☐ 'input contains "x" OR input contains "y"' → 'input.contains("x") || input.contains("y")'
☐ '(a contains "x" OR b contains "y") AND c == true' → parentheses preserved, contains migrated
☐ 'field matches "\\d+"' (lowercase) → 'field.matches("\\d+")'
☐ 'user.role contains "admin"' → 'user.role.contains("admin")'
☐ 'input contains "BLOCK"' → keyword in string literal not mangled

IN / NOT IN:
☐ 'status IN ["active", "pending"]' → 'status in ["active", "pending"]'
☐ 'status NOT IN ["draft", "archived"]' → '!(status in ["draft", "archived"])'
☐ 'x IN [1,2,3] AND y NOT IN [4,5]' → compound with both

EMPTY / IS NOT EMPTY (PREFIX unary per spec):
☐ 'EMPTY cart_contents' → 'abl.is_empty(cart_contents)' (prefix, not postfix)
☐ 'cart_contents IS NOT EMPTY' → '!abl.is_empty(cart_contents)' (also valid per spec)
☐ 'NOT EMPTY items' → '!abl.is_empty(items)' (prefix NOT EMPTY)
☐ 'EMPTY items AND total > 0' → compound with EMPTY
☐ abl.is_empty(null) → true
☐ abl.is_empty("") → true
☐ abl.is_empty([]) → true
☐ abl.is_empty({}) → true
☐ abl.is_empty("hello") → false
☐ abl.is_empty([1]) → false

EXISTS (PREFIX unary per spec):
☐ 'EXISTS user.email' → 'has(user.email)' (prefix, not postfix)
☐ 'EXISTS phone AND phone matches "\\d+"' → compound

contains (string AND array membership per spec):
☐ 'items contains item_id' → 'abl.array_contains(items, item_id)' (variable RHS = array membership)
☐ 'input contains "hello"' → 'input.contains("hello")' (string RHS = string substring)
☐ 'tags contains "urgent"' → 'tags.contains("urgent")' (quoted = string .contains())

matches (regex literal support):
☐ 'input matches /\\d+/' → 'input.matches("\\d+")' (bare regex literal)
☐ 'input matches pattern_var' → 'input.matches(pattern_var)' (variable RHS)

Lowercase functions:
☐ 'is_number(age)' → 'abl.is_number(age)' (lowercase detected and migrated)
☐ 'upper(name)' → 'abl.upper(name)' (lowercase detected and migrated)
☐ 'format_currency(amount, "USD")' → 'abl.format_currency(amount, "USD")'

IMPLIES:
☐ 'dispute_type == "card" IMPLIES card_unique_id != ""' → '!(dispute_type == "card") || (card_unique_id != "")'
☐ 'a == true IMPLIES b == true AND c == true' → '!(a == true) || (b == true && c == true)'

Detection:
☐ isLegacyExpression('input contains "x"') → true (lowercase)
☐ isLegacyExpression('x IS NOT EMPTY') → true
☐ isLegacyExpression('x NOT IN [...]') → true
☐ isLegacyExpression('x EXISTS') → true
☐ isLegacyExpression('is_number(x)') → true (lowercase function)
☐ isLegacyExpression('A IMPLIES B') → true
☐ isLegacyExpression('input.contains("x")') → false (already CEL)

Edge cases:
☐ Already-CEL expressions pass through unchanged
☐ Mixed: 'name CONTAINS "Dr" AND age >= 18' → 'name.contains("Dr") && age >= 18'
☐ Empty string → empty string
☐ 'true' → 'true' (unchanged)
☐ NOT IN in parens: '(status NOT IN ["a"]) AND x > 5' → '(!(status in ["a"])) && x > 5'
☐ EMPTY on dotted path: 'user.cart EMPTY' → 'size(user.cart) == 0'
☐ IN with single value: 'x IN ["only"]' → 'x in ["only"]'
☐ NOT IN with nested expressions: 'x NOT IN [1, 2, 3]' → '!(x in [1, 2, 3])' (array literal preserved)
☐ Multiple operators: 'a IS SET AND b IS NOT EMPTY AND c NOT IN ["x"]' → compound migration
```

#### T2.2 — CEL parity: migrate ALL 265 legacy evaluator tests (EXTEND: `packages/compiler/src/__tests__/constructs/cel-parity.test.ts`)

**This is the critical safety net.** Every test in `evaluator.test.ts` must have a corresponding CEL parity test:

```
Parity Tests (migrate from evaluator.test.ts — 265 tests):
☐ Basic comparisons: ==, !=, >, <, >=, <= with numbers, strings, booleans
☐ Boolean operators: AND/&&, OR/||, NOT/!
☐ Nested property access: obj.nested.value
☐ CONTAINS → .contains() (case-insensitive string matching)
☐ startsWith/endsWith
☐ matches (regex)
☐ is_number
☐ Type coercion: string "42" compared to number 42
☐ Null/undefined handling: null == null, null != "value", null comparisons
☐ Parenthesized expressions: (a OR b) AND c
☐ IS SET / IS NOT SET → has()/!has() or != null/== null
☐ resolveValue: string literals, number literals, nested paths, boolean parsing
☐ Edge cases: empty expression, whitespace-only, single boolean
```

**Strategy:** Don't rewrite 265 tests. Instead:

1. Create a test harness that runs each expression through `normalizeExpression()` + `evaluateCondition()` (new CEL-only path)
2. Assert same result as the legacy evaluator for each case
3. Any discrepancy = migration bug that must be fixed

#### T2.3 — Template utility extraction (NEW: `packages/compiler/src/__tests__/constructs/template-utils.test.ts`)

```
Unit Tests (10):
☐ interpolateMessage('Hello {{name}}', { name: 'John' }) → 'Hello John'
☐ interpolateMessage('Total: {{FORMAT_CURRENCY(amount, "USD")}}', { amount: 42 }) → 'Total: $42.00'
☐ interpolateMessage('{{UPPER(name)}}', { name: 'john' }) → 'JOHN'
☐ interpolateMessage with missing variable → preserves {{variable}} or returns empty
☐ interpolateMessage with nested path: '{{user.name}}' → resolved
☐ interpolateMessage with no templates → returns string unchanged
☐ interpolateMessage with multiple templates in one string
☐ interpolateMessage with escaped braces
☐ interpolateWithFallback returns fallback on error
☐ interpolateMessage uses resolveValue (CEL) for expression evaluation inside ${}
```

#### T2.4 — Compile-time normalization verification (NEW: `packages/compiler/src/__tests__/constraint-cel-normalization.test.ts`)

```
Integration Tests (12):
☐ Compile a DSL with 'guests > 10 AND destination IS SET' → IR contains CEL: 'guests > 10 && destination != null'
☐ Compile a DSL with 'input contains "booking"' → IR contains CEL: 'input.contains("booking")'
☐ Compile a DSL with 'UPPER(name) == "JOHN"' → IR contains CEL: 'abl.upper(name) == "JOHN"'
☐ Compile a DSL with already-CEL syntax → IR unchanged
☐ complete_when with legacy syntax → normalized in IR
☐ on_input IF condition with legacy syntax → normalized in IR
☐ activation.when with legacy syntax → normalized in IR
☐ Guardrail check expression → NOT normalized (CEL function names, not legacy)
☐ WHEN on constraint: 'REQUIRE merchant_name != "" WHEN channel_type == "ivr"' → IR condition: '!(channel_type == "ivr") || (merchant_name != "")'
☐ IMPLIES: 'REQUIRE a == "card" IMPLIES b != ""' → IR condition: '!(a == "card") || (b != "")'
☐ IN: 'REQUIRE status IN ["active"]' → IR condition: 'status in ["active"]'
☐ IS NOT EMPTY: 'REQUIRE cart IS NOT EMPTY' → IR condition: 'size(cart) > 0'
```

#### T2.4b — Auto-guard + normalization order (NEW: `packages/compiler/src/__tests__/autoguard-normalization-order.test.ts`)

**The correct order is: auto-guard in ABL FIRST, then normalize the result to CEL.** Auto-guard cannot parse CEL forms. These tests verify the COMBINED pipeline: `normalizeExpression(autoGuardConstraint(ablExpr))`.

```
Unit Tests (12):
☐ Pipeline: 'cart IS NOT EMPTY' → guard('cart IS NOT EMPTY') = 'cart IS NOT SET OR cart IS NOT EMPTY' → normalize → 'cart == null || !abl.is_empty(cart)'
☐ Pipeline: 'status NOT IN ["draft"]' → guard produces ABL guards → normalize → CEL with guards
☐ Pipeline: 'EXISTS user.email' → guard detects IS SET/IS NOT SET in expression (via EXISTS → has) — but guard runs first on ABL → should NOT add redundant guard
☐ Pipeline: 'input contains "hello"' → guard skips 'input' and 'contains' (both in CONSTRAINT_KEYWORDS) → normalize → 'input.contains("hello")'
☐ Pipeline: 'guests > 10' → guard('guests > 10') = 'guests IS NOT SET OR guests > 10' → normalize → 'guests == null || guests > 10'
☐ Pipeline: 'destination != origin' → guard adds both → normalize → 'destination == null || origin == null || destination != origin'
☐ Pipeline: 'UPPER(name) == "JOHN"' → guard('UPPER(name) == "JOHN"') = 'name IS NOT SET OR UPPER(name) == "JOHN"' → normalize → 'name == null || abl.upper(name) == "JOHN"'
☐ Pipeline: 'items contains item_id' → guard skips 'items' and 'contains' (keywords) → normalize → 'abl.array_contains(items, item_id)'
☐ evaluateWithGuardSemantics with CEL 'x == null || ...' pattern → guard recognized
☐ evaluateWithGuardSemantics with CEL 'x == null && y == null && ...' pattern → both guards recognized
☐ evaluateWithGuardSemantics with 'abl.is_empty(cart)' → NOT a guard (it's the condition itself)
☐ Full round-trip: ABL expression → autoGuard → normalize → evaluateWithGuardSemantics → correct boolean result
```

#### T2.4c — Real-expression regression (NEW: `packages/compiler/src/__tests__/real-expression-regression.test.ts`)

**Take actual complex expressions from example `.abl` files and verify end-to-end:** compile → migrate → auto-guard → evaluate.

```
Integration Tests (15):
☐ 'destination IS SET AND origin IS SET AND destination != origin' (travel/booking_manager)
☐ 'guests > 0 AND guests <= 10' (flow-test/hotel_booking)
☐ 'verified == true AND two_factor_risk_acknowledged == true' (apple-care/account_support)
☐ 'icloud_backup_confirmed == true' (apple-care/device_support — simple but with BEFORE stripped)
☐ 'last_get_card_list_result != null' (DisputeTransaction — complex field name)
☐ 'measure_field IS SET' (search-ai-strategies — simple IS SET)
☐ 'refund_amount <= 1000 OR manager_approved == true' (common pattern — OR with comparison)
☐ 'input contains "cancel" OR input contains "stop"' (common pattern — OR with contains)
☐ 'age >= 18 AND UPPER(country) == "US"' (mixed comparison + function)
☐ 'items IS NOT EMPTY AND total > 0' (compound with IS NOT EMPTY — new operator)
☐ 'status NOT IN ["draft", "archived"] AND active == true' (compound with NOT IN — new operator)
☐ 'user.email EXISTS AND user.email matches ".*@company\\.com"' (EXISTS + matches — new operator)
☐ 'x is_number AND x >= 1 AND x <= 5' (is_number — lowercase function)
☐ '(a contains "x" OR b contains "y") AND c == true' (parenthesized + contains)
☐ 'name IS SET AND role IN ["admin", "user"]' (IS SET + IN — two migrated operators)
```

#### T2.4d — New CEL helper functions (NEW: `packages/compiler/src/__tests__/constructs/cel-helpers.test.ts`)

```
Unit Tests (12):
☐ abl.is_empty(null) → true
☐ abl.is_empty(undefined) → true (if applicable)
☐ abl.is_empty("") → true
☐ abl.is_empty([]) → true
☐ abl.is_empty({}) → true
☐ abl.is_empty("hello") → false
☐ abl.is_empty([1, 2]) → false
☐ abl.is_empty({ a: 1 }) → false
☐ abl.is_empty(0) → false (0 is not empty)
☐ abl.array_contains([1, 2, 3], 2) → true
☐ abl.array_contains([1, 2, 3], 4) → false
☐ abl.array_contains("hello world", "world") → true (polymorphic: falls back to string contains)
```

#### T2.4e — IR expression walker (NEW: `packages/compiler/src/__tests__/ir-expression-walker.test.ts`)

```
Integration Tests (8):
☐ Walker normalizes constraint conditions
☐ Walker normalizes step.check
☐ Walker normalizes step.reasoning_zone.exit_when
☐ Walker normalizes step.success_when
☐ Walker normalizes branch conditions
☐ Walker normalizes delegate.when
☐ Walker normalizes gather.complete_when
☐ Walker does NOT normalize non-expression string fields (step names, messages, etc.)
```

#### T2.5 — Runtime evaluation without fallback (EXTEND: `apps/runtime/src/__tests__/cel-runtime-integration.test.ts`)

```
Integration Tests (12):
☐ CEL constraint with nested paths evaluates correctly
☐ abl.* functions work in constraints at runtime
☐ Legacy syntax in existing sessions (compiled before migration) — should still have CEL in IR
☐ Missing variables → null injection, not crash
☐ IS SET / IS NOT SET guard semantics still work via has() preprocessing
☐ String methods: .contains(), .startsWith(), .endsWith(), .matches()
☐ 'in' operator for list membership
☐ Arithmetic expressions
☐ Boolean logic with short-circuit
☐ Comparison with type coercion (string "42" vs number 42)
☐ Empty/null/undefined context values
☐ CEL error → hard error (not silent fallback) — verify error propagation
```

#### T2.6 — Legacy evaluator removal safety (NEW: `packages/compiler/src/__tests__/no-legacy-evaluator.test.ts`)

```
Verification Tests (5):
☐ Import from old 'evaluator.js' path → module not found error
☐ celMetrics.celFallback counter never increments during full test suite run
☐ evaluateCondition (new name) rejects invalid CEL and throws (not silently passes)
☐ All constraint check points (6 locations) use the new evaluateCondition
☐ interpolateMessage importable from template-utils.ts
```

---

### Phase 3 Tests: Examples & Documentation

#### T3.1 — Example compilation verification (NEW: `packages/compiler/src/__tests__/example-compilation.test.ts`)

```
Integration Tests (compile every example):
☐ All .abl files in examples/ compile without errors after migration
☐ No guardrail check references an unregistered CEL function (per 5.1 validator)
☐ All constraint conditions in IR are valid CEL (parse-test via CEL parser)
☐ Phase labels retained intentionally; example constraints use explicit `WHEN` / structural `BEFORE` where runtime gating matters
```

#### T3.2 — Replacement guardrail functions actually work (NEW: `packages/compiler/src/__tests__/guardrail-replacement-functions.test.ts`)

After replacing fake functions with real `abl.*` functions in examples, verify the replacements evaluate correctly:

```
Unit Tests (8):
☐ abl.contains_pii("my SSN is 123-45-6789") → true (detects SSN)
☐ abl.contains_pii("hello world") → false (no PII)
☐ abl.contains_email("contact me at foo@bar.com") → true
☐ abl.contains_email("no email here") → false
☐ abl.matches_pattern("damn this", "(?i)\\b(damn|hell)\\b") → true (blocked words pattern)
☐ abl.matches_pattern("hello", "(?i)\\b(damn|hell)\\b") → false
☐ abl.word_count("hello world foo") == 3 → true
☐ abl.contains_url("visit http://evil.com") → true
```

#### T3.3 — llm_check guardrail compilation (ADD to example-compilation tests)

```
Unit Tests (3):
☐ Guardrail with llm_check field compiles to IR with correct tier-3 config
☐ Guardrail with llm_check + action: block → IR has action type 'block'
☐ Guardrail with llm_check but no action → compile-time error or default action
```

---

### Phase 4 Tests: Constraint Behavior Fixes

#### T4.1 — Targeted field clearing (NEW: `apps/runtime/src/__tests__/constraint-field-clearing.test.ts`)

```
Unit Tests (8):
☐ Constraint 'guests <= 10' fails → only 'guests' cleared, 'destination' and 'origin' retained
☐ Constraint 'destination != origin' fails → both 'destination' and 'origin' cleared
☐ Constraint referencing no extracted fields → all extracted fields cleared (fallback)
☐ Single field extracted, constraint fails → that field cleared
☐ Constraint with auto-guard: 'guests == null || guests <= 10' (CEL form) → extracts 'guests' as violating field
☐ Constraint with nested path: 'booking.guests <= 10' → 'booking' not in extractedData → fallback clear all
☐ Multiple constraints fail → first failure's fields cleared (short-circuit)
☐ session.waitingForInput set to only the cleared fields
```

#### T4.2 — Multi-turn constraint flow E2E (NEW: `apps/runtime/src/__tests__/constraint-multiturn-e2e.test.ts`)

```
Integration Tests (6):
☐ Turn 1: User provides 3 fields, 1 violates → violation response, only bad field cleared
☐ Turn 2: User provides corrected field → constraint passes, gather completes
☐ Turn 1: collect_field action → system asks for specific field
☐ Turn 2: User provides field → constraint re-evaluated, passes → continue
☐ Turn 1: goto_step action → step transition
☐ Backtrack limit: 3 goto_step violations → falls through to terminal action
```

---

### Phase 5 Tests: Compile-Time Validation

#### T5.1 — Unregistered CEL function warning (NEW: `packages/compiler/src/__tests__/guardrail-function-validation.test.ts`)

```
Unit Tests (6):
☐ 'abl.contains_pii(input)' → no warning (registered)
☐ 'toxicity_score(response)' → warning: unknown function
☐ 'shows_empathy' → warning: unknown function (bare identifier, not a function call)
☐ 'not_contains_blocked_words(input)' → warning: unknown function
☐ 'abl.matches_pattern(input, "\\d+")' → no warning
☐ 'input.contains("hello")' → no warning (CEL string method, not custom function)
```

#### T5.2 — Phase name warning (ADD to existing compilation tests)

```
Unit Tests (3):
☐ Phase 'pre_booking' → warning emitted
☐ Phase 'always' → no warning
☐ Phase '' (unnamed/default) → no warning
```

---

### Cross-Cutting E2E Tests (NEW — highest priority gap)

These are the tests that would have caught the original feedback issues:

#### TC.1 — HTTP E2E: Constraint violation through full middleware (NEW: `apps/runtime/src/__tests__/e2e/constraint-http-e2e.test.ts`)

```
E2E Tests (start real Express server, full middleware chain):
☐ Send message that triggers BLOCK constraint → HTTP response contains block message (not literal "BLOCK")
☐ Send message that triggers RESPOND constraint → response contains user-friendly message (no "RESPOND" prefix)
☐ Send message that triggers ESCALATE constraint → session marked as escalated
☐ Send message that triggers REDACT constraint → response redacted (not just a message)
☐ Send message with valid input → constraint passes, normal response
☐ Send message that triggers constraint warning → warning in system prompt, LLM-informed response
☐ Auth middleware executes before constraint check (not bypassed)
☐ Tenant isolation: constraint violation for tenant A doesn't affect tenant B
```

#### TC.2 — HTTP E2E: Guardrail through full middleware (NEW: `apps/runtime/src/__tests__/e2e/guardrail-http-e2e.test.ts`)

```
E2E Tests (start real Express server):
☐ Input guardrail blocks PII (SSN in message) → block response before LLM
☐ Output guardrail redacts PII in LLM response → user sees redacted content
☐ Input guardrail with Tier 1 CEL check → correct evaluation
☐ Guardrail with action: warn → warning logged, response continues
☐ Multiple guardrails: input block + output redact → both fire at correct points
☐ No guardrails configured → passthrough, no overhead
☐ Fail-open: CEL error in guardrail → request continues (not 500)
```

#### TC.3 — HTTP E2E: Policy scoping (NEW: `apps/runtime/src/__tests__/e2e/guardrail-policy-http-e2e.test.ts`)

```
E2E Tests:
☐ Tenant policy disables a guardrail → guardrail skipped for all projects
☐ Project policy overrides tenant threshold → uses project threshold
☐ Agent DSL guardrails always included regardless of policy
☐ Project policy action override → overridden action used at runtime
```

#### TC.4 — HTTP E2E: ON_FAIL actions end-to-end (NEW: `apps/runtime/src/__tests__/e2e/constraint-actions-http-e2e.test.ts`)

```
E2E Tests:
☐ ON_FAIL: BLOCK → user sees DEFAULT_MESSAGES.constraint_blocked (not "BLOCK")
☐ ON_FAIL: RESPOND "Max 10 guests" → user sees "Max 10 guests" (not "RESPOND Max 10 guests")
☐ ON_FAIL: ESCALATE "Policy violation" → session.isEscalated = true
☐ ON_FAIL with COLLECT → system asks for field, user provides → constraint re-evaluated
☐ ON_FAIL with GOTO → step transition occurs
☐ ON_FAIL: REDACT → content modification occurs (not just message)
```

---

### Test Summary

| Category                                                                                                                    | New Tests        | Existing to Migrate | Total |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------- | ----- |
| Phase 1 — Bug fixes                                                                                                         | 25               | 0                   | 25    |
| Phase 2 — Legacy removal (migrator + parity + template + normalization + auto-guard + regression + CEL helpers + IR walker) | 129 + 265 parity | 265 legacy → CEL    | 394   |
| Phase 3 — Example compilation + replacement functions + llm_check                                                           | 15               | 0                   | 15    |
| Phase 4 — Field clearing + multi-turn                                                                                       | 14               | 0                   | 14    |
| Phase 5 — Compile-time validation                                                                                           | 9                | 0                   | 9     |
| Cross-cutting E2E                                                                                                           | 28               | 0                   | 28    |
| **Total new/migrated**                                                                                                      | **485**          |                     |       |

---

## AI Agent Implementation Controls

### Why This Section Exists

AI agents (Claude Code) implementing this plan will encounter specific failure modes. This section defines controls to catch them. Each control maps to a known failure pattern from prior work on this codebase.

### Control 1: Mandatory Wiring Checklist per Task

**Failure:** Agent writes a component but doesn't wire it into callers.

**Control:** Every task prompt MUST include a wiring checklist. The agent cannot mark the task complete until every item is verified.

Example for Phase 2.4 (delete legacy evaluator):

```
WIRING CHECKLIST — do not mark complete until ALL are verified:
☐ template-utils.ts exports interpolateMessage AND interpolateWithFallback
☐ Every file that imported from evaluator.ts now imports from template-utils.ts or evaluator.ts (renamed)
☐ Run: grep -r "from.*evaluator" --include="*.ts" — zero hits for old path
☐ Run: grep -r "evaluateConditionDual\|resolveValueDual\|evaluateConditionDetailedDual" --include="*.ts" — zero hits (renamed)
☐ Run: pnpm build — succeeds across all packages
☐ Run: pnpm test --filter=compiler --filter=runtime — all pass
```

### Control 2: Read-Before-Write Enforcement

**Failure:** Agent imagines API signatures and writes code against them.

**Control:** Include in every agent prompt:

```
BEFORE using any existing function, type, or component:
1. READ its source file to verify the actual signature
2. READ its test file to understand expected behavior
3. If it doesn't exist, READ the module where it SHOULD exist to verify
Never guess. Never assume. If you can't find it, ask.
```

For Phase 4.1 specifically: "READ `extractVariableReferences` source — verify it exists, its signature, and what it returns. If it doesn't exist, you must implement it."

### Control 3: Adversarial Migrator Tests

**Failure:** Regex migration works for clean inputs but corrupts edge cases.

**Control:** Before implementing the migrator fix, the agent MUST write the T2.4c real-expression regression tests FIRST (test-driven). These tests use actual expressions from the codebase, not synthetic examples. The migrator fix must pass all 15 before proceeding.

Additionally, after running automated migration on the 69 `.abl` files:

```
VERIFICATION STEPS — run AFTER migration:
☐ pnpm build --filter=compiler — compiles all examples
☐ Diff every migrated file: git diff examples/ | grep -c "^+" — review line count is reasonable
☐ Spot-check 5 files manually: pick the most complex expressions and verify correctness
☐ Run T3.1 (example compilation verification) — all examples compile
```

### Control 4: Build After Every File Change

**Failure:** Type errors accumulate silently and cascade.

**Control:** Include in every agent prompt:

```
After EVERY file you create or modify:
  pnpm build --filter=<affected-package>
If it fails, fix it NOW. Do not proceed to the next file.
```

This is especially critical for Phase 2.4 (rename cascade) — build after each import update, not at the end.

### Control 5: Integration-Level Acceptance Criteria

**Failure:** Agent writes tests that compile but don't exercise the real path (the A2A pattern).

**Control:** Every E2E test file MUST include a "smoke preamble" that verifies the test infrastructure is real:

```typescript
// SMOKE PREAMBLE — if any of these fail, the test infrastructure is fake
it('middleware chain is complete', async () => {
  // Verify auth middleware is present
  const unauthResponse = await request(app).post('/message').send({});
  expect(unauthResponse.status).toBe(401); // NOT 200

  // Verify tenant isolation is present
  const crossTenantResponse = await request(app)
    .post('/message')
    .set('Authorization', `Bearer ${tenantAToken}`)
    .send({ sessionId: tenantBSessionId });
  expect(crossTenantResponse.status).toBe(404); // NOT 200 or 403
});
```

If the smoke preamble passes with 200, the test server is missing middleware and the E2E test is worthless.

### Control 6: Delete-Then-Build Gate for Legacy Removal

**Failure:** Agent deletes `evaluator.ts` but `template-utils.ts` is incomplete.

**Control:** Phase 2.4 MUST be executed in this exact order:

```
Step 1: Create template-utils.ts with ALL dependencies extracted
Step 2: pnpm build — MUST PASS (both old and new paths exist)
Step 3: Update ALL imports from evaluator.ts → template-utils.ts / new evaluator.ts
Step 4: pnpm build — MUST PASS
Step 5: Delete old evaluator.ts
Step 6: pnpm build — MUST PASS
Step 7: pnpm test --filter=compiler --filter=runtime — MUST PASS
```

The agent CANNOT combine steps. Each step has a build gate.

### Control 7: Example Files Stay in ABL Syntax

**Failure:** Agent migrates `.abl` examples to CEL syntax, but the parser doesn't accept CEL.

**Control:** Phase 3B decision is clear: **developer-facing files keep ABL syntax**. The migration tool normalizes at compile time, not in the source files. Agent prompt must include:

```
DO NOT change ABL syntax (IS SET, AND, OR, contains) in .abl example files or .mdx docs.
The compiler normalizes to CEL at compile time.
Developer-facing files KEEP ABL syntax.
Only add a "Compiles to: ..." comment or column showing the CEL equivalent.
```

**Exception:** Phase 3A (fake guardrail functions) — these DO need to be replaced in source files because the functions don't exist. But the replacement uses ABL-compatible syntax (`abl.contains_pii(input)`), not raw CEL.

### Control 8: Parallel Agent Isolation

**Failure:** Two agents working on Phase 3 workstreams A and B both edit the same file and create merge conflicts.

**Control:** Phase 3 workstreams MUST declare file ownership. No two agents touch the same file:

| Workstream                  | Owns                                               | Does NOT Touch              |
| --------------------------- | -------------------------------------------------- | --------------------------- |
| A (fake functions)          | Guardrail-related files only                       | Non-guardrail example files |
| B (legacy syntax docs)      | docs-internal guides/tutorials                     | Guardrail docs              |
| C (non-spec'd comments)     | apple-care, DisputeTransaction, search-ai examples | All other files             |
| D (unimplemented providers) | Studio UI, admin docs                              | Example files               |

If a file needs changes from two workstreams (e.g., `guardrails.mdx` needs both fake function removal AND provider cleanup), assign it to ONE agent.

### Control 9: Parity Test Harness Before Legacy Deletion

**Failure:** Agent deletes legacy evaluator before verifying CEL parity, discovers 30 failing tests, can't easily debug because the reference implementation is gone.

**Control:** T2.2 (parity tests) MUST run and pass BEFORE Phase 2.3 (remove legacy fallback). The harness runs each of the 265 expressions through BOTH evaluators and compares results. Any discrepancy is a migration bug. Only after 0 discrepancies does the agent proceed to remove the fallback.

```
ORDER ENFORCEMENT:
1. Run parity harness → 0 discrepancies required
2. Log celMetrics.celFallback across full test suite → must be 0
3. THEN remove fallback (Phase 2.3)
4. THEN delete evaluator.ts (Phase 2.4)
Never reverse this order.
```

### Control 10: Human Review Gates

**Failure:** Agent produces plausible-looking code that has subtle logic errors no test catches.

**Control:** Certain changes require human review before merge:

| Change                                 | Why                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| `autoGuardConstraint()` modifications  | Guard logic affects every constraint evaluation — subtle bugs affect all agents |
| `evaluateWithGuardSemantics()` changes | Same — guard semantics are safety-critical                                      |
| NOT IN / IMPLIES migrator regex        | Complex regex on untested operator — high corruption risk                       |
| `interpolateMessage` extraction        | Must preserve exact behavior for all template patterns                          |
| Any change to `constraint-checker.ts`  | Runtime entry point — affects all 6 check points                                |

### Summary: Control-to-Risk Matrix

| Risk                        | Control                       | Gate                             |
| --------------------------- | ----------------------------- | -------------------------------- |
| Wiring gaps                 | #1 Mandatory wiring checklist | Agent can't mark complete        |
| Imagined APIs               | #2 Read-before-write          | Hook blocks unread files         |
| Regex corruption            | #3 Adversarial tests first    | T2.4c must pass before migration |
| Type cascade                | #4 Build after every file     | Build failure blocks next step   |
| Fake E2E tests              | #5 Smoke preamble             | Auth/tenant check in every E2E   |
| Incomplete extraction       | #6 Delete-then-build order    | 7-step sequence with build gates |
| Parser vs compiler mismatch | #7 ABL syntax stays in source | Agent prompt forbids CEL in .abl |
| Merge conflicts             | #8 File ownership             | Workstream file assignment       |
| Premature deletion          | #9 Parity before deletion     | 0 discrepancies required         |
| Subtle logic errors         | #10 Human review gates        | PR review on critical paths      |

### Test Execution Gates

Before merging each phase:

| Phase         | Gate                                                                                                                                                                                                                                                                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 1       | All 25 new tests pass. Existing 1,950 tests still pass.                                                                                                                                                                                                                                                                                 |
| Phase 2       | All 265 parity tests pass. `celMetrics.celFallback` = 0 across full suite. Template utility tests pass. Auto-guard + normalization order tests pass. All 15 real-expression regression tests pass. CEL helpers (abl.is_empty, abl.array_contains) pass. IR walker normalizes all 20 expression surfaces. All 138 example files compile. |
| Phase 3       | All example files compile. Replacement guardrail functions evaluate correctly. `llm_check` compilation works.                                                                                                                                                                                                                           |
| Phase 4       | Multi-turn E2E tests pass. Existing constraint tests still pass.                                                                                                                                                                                                                                                                        |
| Phase 5       | Compile-time warnings emit correctly. No false positives on valid expressions.                                                                                                                                                                                                                                                          |
| Cross-cutting | All 28 HTTP E2E tests pass with real Express servers.                                                                                                                                                                                                                                                                                   |
