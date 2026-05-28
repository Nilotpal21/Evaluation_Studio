# DSL Feedback Review — 2026-03-18

Detailed code-level review of feedback covering REQUIRED/DEFAULT, GUARDRAILS, COLLECT, and CONSTRAINTS.

## Status Update — 2026-03-19

Review/fix/review passes against the current working tree changed the status of several findings:

- `required: false` + `default` now emits compiler warning `W822`.
- Inline `ON_FAIL: BLOCK`, `RESPOND`, and `REDACT` now compile to the correct IR actions.
- `CONSTRAINT_KEYWORDS` and auto-guard extraction now handle legacy operator/function forms that were previously misclassified.
- Post-extraction constraint violations now clear only the offending gathered field instead of wiping all extracted values.
- Constraint phase names are still labels only; the right fix is a compiler warning, not runtime phase semantics.
- The earlier `COLLECT`/`ON_INPUT` ELSE description below was too narrow and has been corrected.

---

## 1. REQUIRED/DEFAULT Redundancy

**Verdict: Valid — documentation gap**

When a field has a `default` value, `required: false` is redundant. Two reasons:

**Reason A — Parser auto-sets required.** Inline syntax `field: default=X` auto-sets `required = false`:

```
// packages/core/src/parser/agent-based-parser.ts:724-726
// (inline gather parsing — sets required=false when default is present)
```

**Reason B — `checkGatherComplete` never marks fields with defaults as missing:**

```typescript
// packages/compiler/src/platform/constructs/utils.ts:199-246
for (const field of gather.fields) {
  const isRequired = field.required !== false; // Default to required
  if (!isRequired) continue;
  // ...activation checks...
  const hasValue =
    collectedData[field.name] !== undefined &&
    collectedData[field.name] !== null &&
    collectedData[field.name] !== '';
  if (!hasValue && field.default === undefined) {
    // ← default satisfies requirement
    missing.push(field.name);
  }
}
```

Even with `required: true` (default), a field with `default` is never added to `missing`. The `required` flag is effectively irrelevant when `default` is set.

**Recommendation:** Add a compile-time warning when both `required: false` and `default` are explicitly set. Clarify in DSL docs that `default` implicitly satisfies the requirement.

**Prasanna input:** Lets be explicit with warning. Update any references to examples or docs -- to be correct.

---

## 2. GUARDRAILS — Message Audience Ambiguity

**Verdict: Valid — design gap**

The `message` field serves different purposes depending on the action, but the DSL doesn't make this clear:

```yaml
GUARDRAILS:
  empathy_required:
    kind: output
    check: 'shows_empathy'
    action: warn
    msg: 'Acknowledge customer frustration'
```

At runtime, the message is routed differently per action type:

```typescript
// apps/runtime/src/services/execution/constraint-checker.ts:379-393
case 'respond': {
  const message = interpolateTemplate(
    action.message || /* ...template fallback... */,
    context,
  );
  if (onChunk) onChunk(message);  // ← sent to user
  session.conversationHistory.push({ role: 'assistant', content: message });
  // ...
}
```

- `action: block` → message goes to the **user** via respond
- `action: warn` → message is logged/traced, not necessarily shown to user
- `action: reask` → message is injected into the **LLM prompt** as correction guidance

**The DSL provides no way to distinguish the target audience.** A message like "Acknowledge customer frustration" reads like an LLM instruction but would be sent to the user if the action were `block`.

**Recommendation:** Either (a) add an explicit `target: user | llm | trace` field, or (b) document the behavior per action type clearly.

## **Prasanna input:** Is there a pre-built guardrail called empathy required? There can be pre-built guardrails and custom gaurdrails.This is NOT a good example. We need to be explicit about waht we suport, how ewe support etc. use enterprise use case guardrails -- toxicity/ bias/ Data leakage/ Toxicity/

## 3. GUARDRAILS — `shows_empathy` Is Not a Function

**Verdict: Valid — examples reference nonexistent functions**

The check expression `"shows_empathy"` would need to be a registered CEL function. Here are the **actually implemented** CEL functions:

```typescript
// packages/compiler/src/platform/constructs/cel-functions.ts:439-494
env.registerFunction('AblNamespace.contains_pii(dyn): bool', ...);
env.registerFunction('AblNamespace.detect_pii(dyn): dyn', ...);
env.registerFunction('AblNamespace.redact_pii(dyn): string', ...);
env.registerFunction('AblNamespace.matches_pattern(dyn, dyn): bool', ...);
env.registerFunction('AblNamespace.not_matches_pattern(dyn, dyn): bool', ...);
env.registerFunction('AblNamespace.word_count(dyn): int', ...);
env.registerFunction('AblNamespace.sentence_count(dyn): int', ...);
env.registerFunction('AblNamespace.contains_url(dyn): bool', ...);
env.registerFunction('AblNamespace.contains_email(dyn): bool', ...);
env.registerFunction('AblNamespace.contains_code(dyn): bool', ...);
```

**Not implemented** (but used in examples/docs):

- `shows_empathy` — no implementation anywhere
- `toxicity_score()` — exists only in example files (e.g., `examples/guardrails/agents/content_safety.agent.abl`)
- `not_contains_pii()` — must use `abl.contains_pii()` instead
- `not_contains_blocked_words()` — no implementation

Unregistered CEL functions **fail-open** at Tier 1 evaluation — they silently pass, giving false confidence.

**Recommendation:** Remove non-functional examples from docs/examples. Add a compile-time warning when a check expression references an unregistered function.
**Prasanna input:** Remove such examples from docs/exmaples and be explicit about the LLM prompt based guardrails on how one can achaieve this kind of behavior.

---

## 4. COLLECT in Scripted Mode — ELSE Branch Semantics

**Verdict: Valid — example is misleading**

The feedback asks: "if input does not contain a destination, why would we go to `get_dates`?"

```yaml
get_destination:
  COLLECT: destination
  ON_INPUT:
    - IF: input == "back"
      THEN: welcome
    - IF: input contains "help"
      THEN: get_destination
    - ELSE:
      THEN: get_dates
```

The ELSE branch is **not limited to post-collection success**. ON_INPUT is evaluated at **two points**, and ELSE remains the fallback branch in both contexts:

**Point 1 — Navigation escape** (`flow-step-executor.ts:3237-3315`): ON_INPUT is only evaluated when GATHER has missing fields AND **zero fields were extracted**. If the LLM extracts zero fields and no ON_INPUT branch matches → re-prompt for missing fields. If a branch matches → navigate.

**Point 2 — Post-collection** (`flow-step-executor.ts:3522+`): ON_INPUT is also evaluated **after** GATHER succeeds (field collected). The ELSE branch can fire here too when no earlier branch matches.

The actual flow for "I like pizza" (not a destination):

1. LLM tries to extract `destination` from "I like pizza"
2. If extraction fails and zero fields are extracted → ON_INPUT runs, so ELSE can fire and re-prompt or navigate depending on the branch definition
3. If extraction succeeds → ON_INPUT runs again, and ELSE can still act as the fallback branch

**Recommendation:** The example is still misleading, but the fix is to document the two evaluation points correctly: ON_INPUT can run both during the zero-extraction navigation path and after collection succeeds, and ELSE is the fallback in either case.

## **Prasanna input:** Fix the examples to be more appropriate

## 5. GUARDRAILS — Output Guardrails Don't Work

**Verdict: INCORRECT — fixed in the modern pipeline path; legacy path still input-only**

The modern guardrail pipeline correctly filters by kind:

```typescript
// packages/compiler/src/platform/guardrails/pipeline.ts:148-160
async execute(
  guardrails: Guardrail[],
  content: string,
  kind: GuardrailKind,   // ← 'input' | 'output' | 'tool_input' | 'tool_output' | 'handoff'
  context: GuardrailContext,
  onTraceEvent?: (event: unknown) => void,
  policy?: PipelinePolicy,
): Promise<GuardrailPipelineResult> {
  const allGuardrails = [...guardrails, ...(policy?.additionalGuardrails ?? [])];
  let applicable = allGuardrails.filter((g) => g.kind === kind);  // ← filters by kind
  // ...
}
```

Output guardrails are evaluated after LLM response generation via a dedicated helper:

```typescript
// apps/runtime/src/services/execution/output-guardrails.ts:39-68
export async function checkOutputGuardrails(
  text: string,
  guardrails: Guardrail[] | undefined,
  context: GuardrailContext,
  // ...
): Promise<OutputGuardrailResult> {
  // ...
  const pipeline = createGuardrailPipeline(llmEval, tenantId);
  const result = await pipeline.execute(
    dslGuardrails,
    text,
    'output', // ← explicitly evaluates output kind
    context,
    undefined,
    policy,
  );
  // ...
  return {
    passed: true,
    text: result.modifiedContent ?? text, // ← modified content flows through
    // ...
  };
}
```

**However**, the legacy constraint-checker path still filters to input-only:

```typescript
// apps/runtime/src/services/execution/constraint-checker.ts:141-148
// Filter guardrails to only 'input' kind for pre-message check.
const constraintConfig = {
  ...baseConstraints,
  constraints: [...(baseConstraints.constraints ?? []), ...profileConstraints],
  guardrails: baseConstraints.guardrails?.filter((g) => !g.kind || g.kind === 'input'), // ← input only
};
```

This is correct for the constraint-checker (pre-message check). Output guardrails are handled separately by `checkOutputGuardrails()` called from `reasoning-executor.ts`.

**Status:** Output guardrails work in the modern pipeline. The feedback was accurate for the legacy path but the system has been updated.

**Prasanna input:** We should be removing support for legacy and throw error on compile;

---

## 6. GUARDRAILS — `redact` Action Doesn't Redact

**Verdict: Partially correct — depends on code path**

### Modern pipeline path — redact WORKS

```typescript
// packages/compiler/src/platform/guardrails/action-executors.ts:15-27
export function executeRedact(content: string, mode: 'pii' | 'pattern', pattern?: string): string {
  if (mode === 'pii') {
    return redactPII(content); // ← replaces emails, SSNs, cards, phones, IPs
  }
  if (mode === 'pattern' && pattern) {
    try {
      return content.replace(new RegExp(pattern, 'gi'), '[REDACTED]');
    } catch {
      return content;
    }
  }
  return content;
}
```

Modified content flows through the output guardrails helper:

```typescript
// apps/runtime/src/services/execution/output-guardrails.ts:101-104
// Even when passed, modifiedContent may be set (e.g. redact action that doesn't block)
return {
  passed: true,
  text: result.modifiedContent ?? text, // ← redacted content replaces original
  // ...
};
```

### Legacy constraint-executor path — redact is COSMETIC

```typescript
// packages/compiler/src/platform/constructs/executors/constraint-executor.ts:234-244
const adaptedAction: ConstraintAction = {
  type:
    guardrail.action.type === 'warn'
      ? 'respond'
      : guardrail.action.type === 'fix'
        ? 'respond'
        : guardrail.action.type === 'reask'
          ? 'respond'
          : guardrail.action.type === 'filter'
            ? 'respond'
            : (guardrail.action.type as ConstraintAction['type']),
  // ← warn, fix, reask, filter ALL downgraded to 'respond'
  message: guardrail.action.message,
};
```

### Runtime constraint-checker path — redact is COSMETIC

```typescript
// apps/runtime/src/services/execution/constraint-checker.ts:472-483
case 'redact': {
  const message =
    action.message || /* ...template fallback... */;
  if (onChunk) onChunk(message);  // ← just sends a message
  session.conversationHistory.push({ role: 'assistant', content: message });
  return {
    response: message,
    action: { type: 'redacted', reason: violation.condition },
    // ← no actual content modification
  };
}
```

**Recommendation:** Align the legacy paths with the pipeline's actual redaction behavior, or deprecate the legacy paths.

## **Prasanna input:** The legacy paths are confusing. We should remove referencs. We should remove examples.

## 7. GUARDRAILS — `priority` Field

**Verdict: INCORRECT — priority works in the modern pipeline**

The pipeline sorts guardrails by priority within each tier:

```typescript
// packages/compiler/src/platform/guardrails/pipeline.ts:10-12 (header comment)
//   2. Group by tier and sort each group by priority (lower = first)
```

The legacy `checkConstraintsCore` does evaluate in definition order (no priority sorting), so priority is dead **only in that path**.

## **Prasanna input:** Legacy is creating confusion. Lets fix it.

## 8. GUARDRAILS — `kind` Field

**Verdict: INCORRECT for modern pipeline, CORRECT for legacy path**

See Issue #5 above. The pipeline filters `allGuardrails.filter((g) => g.kind === kind)`. The legacy `checkConstraintsCore` does not filter by kind.

## **Prasanna input:** Legacy is creating confusion. Lets fix it.

## 9. GUARDRAILS — No External Provider Integration

**Verdict: INCORRECT — provider registry is implemented**

The Tier 2 evaluator dispatches to registered providers via `GuardrailProviderRegistry`:

```
packages/compiler/src/platform/guardrails/tier2-evaluator.ts   — dispatches to providers
packages/compiler/src/platform/guardrails/provider-registry.ts — registry with circuit breakers
apps/runtime/src/services/guardrails/pipeline-factory.ts       — factory with tenant-scoped providers
```

Built-in PII provider is auto-registered. Custom providers load from MongoDB `TenantGuardrailProviderConfig`. Circuit breaker protection prevents cascade failures.

**Prasanna input:** Add clear documentation on what is available and not supported. ADD TODOs in the document and code and Comment remove references from UI until is wired and tested.

---

## 10. CONSTRAINTS — Phase Names Silently Discarded

**Verdict: CONFIRMED — High severity**

```typescript
// packages/compiler/src/platform/ir/compiler.ts:1115-1124
// Flatten all constraint phase requirements into a single list.
// All constraints are checked every turn. The compiler auto-adds IS NOT SET
// guards so authors don't need to write them manually.
const constraints = doc.constraints.flatMap((phase) =>
  phase.requirements.map((req) => ({
    condition: autoGuardConstraint(req.condition),
    on_fail: parseOnFail(req.onFail),
    ...(req.severity === 'warning' ? { severity: 'warning' as const } : {}),
  })),
);
```

The `phase.name` (e.g., `pre_booking`, `pre_cancel`, `always`) is **completely discarded** by the `flatMap`. All constraints fire every turn. The `autoGuardConstraint()` compensates by adding IS-NOT-SET guards for referenced variables, but this is a poor substitute for explicit phase gating.

**Impact:** Every DSL example using named phases has no runtime effect. A constraint like `pre_cancel: REQUIRE cancellation_reason IS SET` fires every turn (with auto-guard making it pass when `cancellation_reason` is not set), but semantically the author intended it to only run during the cancel phase.

**Recommendation:** Keep phase syntax in the DSL as label-only authoring structure. If runtime scoping is needed, use explicit `WHEN` guards or structural `BEFORE` checkpoints instead of treating phase names as executable selectors.

**Prasanna input:** These phase names are confusing. We decided to treat them more like labels. The examples are destructive as it is confusing everyone.

---

## 11. CONSTRAINTS — ON_FAIL: BLOCK Shows "BLOCK" as Text

**Verdict: CONFIRMED — High severity**

The `parseOnFail` function handles strings starting with `ESCALATE` and `HANDOFF` as special prefixes, but has **no case for BLOCK**:

```typescript
// packages/compiler/src/platform/ir/compiler.ts:1470-1478
if (typeof onFail === 'string') {
  if (onFail.startsWith('ESCALATE')) {
    return { type: 'escalate', reason: onFail.replace('ESCALATE', '').trim() };
  }
  if (onFail.startsWith('HANDOFF ')) {
    const parts = onFail.replace('HANDOFF ', '').split(' ');
    return { type: 'handoff', target: parts[0], message: parts.slice(1).join(' ') };
  }
  return { type: 'respond', message: onFail }; // ← "BLOCK" falls through here
}
```

**Trace:**

1. DSL: `ON_FAIL: BLOCK`
2. Parser: `req.onFail = "BLOCK"` (inline string)
3. Compiler `parseOnFail("BLOCK")`: doesn't match ESCALATE or HANDOFF → `{ type: 'respond', message: 'BLOCK' }`
4. Runtime: sends literal `"BLOCK"` to the user

The runtime **does** have a `block` handler that works correctly — the bug is that the compiler never produces `{ type: 'block' }` from the string `"BLOCK"`:

```typescript
// apps/runtime/src/services/execution/constraint-checker.ts:485-502
case 'block':
default: {
  const message =
    action.message ||
    session.agentIR?.messages?.constraint_blocked ||
    DEFAULT_MESSAGES.constraint_blocked;
  // ← this works, but never reached because compiler produces type:'respond'
}
```

**Fix:** Add `BLOCK` prefix detection in `parseOnFail`:

```typescript
if (onFail === 'BLOCK' || onFail.startsWith('BLOCK ')) {
  return { type: 'block', message: onFail.replace(/^BLOCK\s*/, '').trim() || undefined };
}
```

**Prasanna input:** Fix this. Make it explicit. Do we really need it? Add test cases

---

## 12. CONSTRAINTS — ON_FAIL: RESPOND Includes "RESPOND" in Message

**Verdict: CONFIRMED — High severity**

**Trace:**

1. DSL: `ON_FAIL: RESPOND "Sorry, max 10 guests"`
2. Parser extracts inline value: `onFailContent = 'RESPOND "Sorry, max 10 guests"'`

```typescript
// packages/core/src/parser/agent-based-parser.ts:2938-2946
if (nextLine.startsWith('ON_FAIL:')) {
  const onFailContent = nextLine.substring(8).trim();
  // onFailContent = 'RESPOND "Sorry, max 10 guests"'
  // ...
} else if (onFailContent) {
  // Inline string value: ON_FAIL: "message"
  req.onFail = onFailContent.replace(/^"|"$/g, '');
  // ↑ only strips leading/trailing quotes — "RESPOND" prefix is NOT stripped
  // req.onFail = 'RESPOND "Sorry, max 10 guests"'
}
```

3. Compiler: `parseOnFail('RESPOND "Sorry, max 10 guests"')` → no ESCALATE/HANDOFF prefix match → `{ type: 'respond', message: 'RESPOND "Sorry, max 10 guests"' }`
4. User sees: `RESPOND "Sorry, max 10 guests"` (with RESPOND prefix and quotes)

**Note:** The structured block path (`ON_FAIL:` on its own line, then `RESPOND: "msg"` indented below) works correctly — the RESPOND keyword is a property name, and the value is correctly extracted at `agent-based-parser.ts:1338-1339`.

**Fix:** Add `RESPOND` prefix detection in `parseOnFail`:

```typescript
if (onFail.startsWith('RESPOND ') || onFail.startsWith('RESPOND "')) {
  const msg = onFail
    .replace(/^RESPOND\s*/, '')
    .replace(/^"|"$/g, '')
    .trim();
  return { type: 'respond', message: msg };
}
```

---

## 13. CONSTRAINTS — AND/OR Operator Precedence Inverted

**Verdict: INCORRECT — precedence is standard**

The legacy evaluator splits by AND first (giving AND higher precedence), which is standard boolean algebra:

```typescript
// packages/compiler/src/platform/constructs/evaluator.ts:113-132
// (simplified flow)
// 1. Split by OR → parts evaluated with some() (any true = true)
// 2. Within each OR-part, split by AND → sub-parts evaluated with every() (all true = true)
```

`A OR B AND C` evaluates as `A OR (B AND C)` — correct. The dual evaluator (`dual-evaluator.ts`) tries CEL first (which has standard `&&`/`||` precedence), falling back to the legacy evaluator.

---

## 14. CONSTRAINTS — Post-Extraction Violation Clears ALL Fields

**Verdict: Valid for flow-step path, fixed in reasoning path**

### Flow-step path — clears ALL extracted fields

```typescript
// apps/runtime/src/services/execution/flow-step-executor.ts:3508-3512
// Fallback: existing terminal handling
for (const field of Object.keys(extractedData)) {
  deleteSessionValue(session, field);
}
session.waitingForInput = Object.keys(extractedData);
```

If a user provides `destination=NYC, origin=LAX, guests=50` in one message and `guests=50` violates a constraint, ALL THREE fields (`destination`, `origin`, `guests`) are cleared.

### Reasoning path — clears only extracted fields (more targeted)

```typescript
// apps/runtime/src/services/execution/reasoning-executor.ts:560-567
if (postExtractionViolation) {
  // Clear only the fields extracted in this round so user can re-enter
  for (const field of justExtractedFields) {
    deleteSessionValue(session, field);
  }
  return handleConstraintViolation(session, postExtractionViolation, onChunk, onTraceEvent);
}
```

Still clears all fields from this round, but the comment says "this round" — which could be narrower than extractedData in the flow path.

**Recommendation:** The flow-step path should identify which specific field caused the violation and only clear that field. The constraint result already contains the condition — parse it to identify the violating field(s).

---

## 15. CONSTRAINTS — `handoff` Action Needed Runtime Execution Wiring

**Verdict: Mostly fixed on active runtime paths; legacy consistency review remains**

The previous signal-only behavior is no longer the main runtime story. Active flow and reasoning checkpoint paths now route `ON_FAIL: HANDOFF <agent>` through the shared async constraint-violation executor, which can call the real handoff implementation and only falls back to a compatibility response if routing rejects the transfer.

That means the old “returns a signal, does not actually hand off” finding is stale for the primary flow/reasoning execution paths. The remaining review work is to make sure any older or special-case paths and all docs/specs describe the shared executor behavior consistently.

**Recommendation:** Keep auditing legacy/special-case constraint-failure entry points, but document active runtime handoff support as implemented rather than warning-only.

## **Prasanna input:** This can be confusing. This need to be reviewed holistaclly and needs to be redesigned to be more explicit and clear.

## 16. CONSTRAINTS — Async onCheck Callback Fire-and-Forgets

**Verdict: Confirmed in construct executor, not an issue in runtime constraint-checker**

### Construct executor — fire-and-forget gap

```typescript
// packages/compiler/src/platform/constructs/executors/constraint-executor.ts:210-289
// checkConstraintsCore is synchronous
// onCheck callback may be async but the returned Promise is never awaited
// Comment in code: "Fire-and-forget: trace is best-effort."
```

### Runtime constraint-checker — synchronous, no gap

```typescript
// apps/runtime/src/services/execution/constraint-checker.ts:156-168
onCheck: (info) => {
  if (!info.passed && info.severity === 'warning') {
    warnings.push(info);
  }
  emitDecisionEvent(onTraceEvent, session.traceVerbosity, 'constraint_check', {
    // ...all synchronous operations
  });
};
```

**Impact:** Trace events in the construct executor path may be lost under backpressure. Low severity since the runtime path is synchronous.

**Prasanna input:** Lets document the code.

---

## 17. CONSTRAINTS — CONSTRAINT_KEYWORDS Set Is Incomplete

**Verdict: Valid — causes bogus auto-guards**

```typescript
// packages/compiler/src/platform/ir/compiler.ts:1137-1155
const CONSTRAINT_KEYWORDS = new Set([
  'AND',
  'OR',
  'NOT',
  'IS',
  'SET',
  'true',
  'false',
  'null',
  'undefined',
  'now',
  'REQUIRE',
  'WARN',
  'ON_FAIL',
  'RESPOND',
  'ESCALATE',
  'HANDOFF',
  'BLOCK',
]);
```

**Missing keywords used in legacy conditions:**

- `contains` — e.g., `input contains "text"`
- `startsWith` / `endsWith`
- `matches`
- `has`
- Comparison operators as words: `equals`, `not_equals`

When `contains` appears in a condition like `input contains "text"`, `extractVariableReferences()` treats `contains` as a variable reference, causing `autoGuardConstraint()` to prepend `contains IS NOT SET OR ...`. Since `contains` is never set in the context, the auto-guard makes the constraint **always pass**.

**Example:**

```
REQUIRE input contains "booking"
```

Auto-guarded to:

```
input IS NOT SET OR contains IS NOT SET OR input contains "booking"
```

`contains IS NOT SET` → always true → entire constraint always passes.

**Recommendation:** Add all legacy condition operators to `CONSTRAINT_KEYWORDS`: `contains`, `startsWith`, `endsWith`, `matches`, `has`, `equals`, `includes`, `in`.

---

## 18. CONSTRAINTS — `redact` and `ensure/recommend` Actions Are Cosmetic

**Verdict: Correct for legacy path, incorrect for pipeline path**

See Issue #6 above for the full analysis. The modern pipeline has real implementations:

```typescript
// packages/compiler/src/platform/guardrails/action-executors.ts
export function executeRedact(content, mode, pattern); // ← real PII/pattern redaction
export function executeFix(content, strategy, maxLength); // ← truncate, strip_html, normalize, redact_pii
export function executeFilter(content, violationPatterns, minLength); // ← sentence-level filtering
```

The legacy constraint-executor and runtime constraint-checker treat all of these as `respond` (send a message, no content modification).

---

## Summary Table

| #   | Issue                           | Verdict                                 | Severity | Path                                   |
| --- | ------------------------------- | --------------------------------------- | -------- | -------------------------------------- |
| 1   | required/default redundancy     | **Fixed** (`W822` compiler warning)     | Low      | `constructs/utils.ts:199-246`          |
| 2   | Guardrail msg audience unclear  | Valid                                   | Medium   | `constraint-checker.ts:379-393`        |
| 3   | `shows_empathy` not implemented | Valid                                   | High     | `cel-functions.ts:436-494`             |
| 4   | COLLECT ELSE misleading         | Valid                                   | Medium   | `flow-step-executor.ts:3237-3315`      |
| 5   | Output guardrails don't work    | **Fixed** (pipeline)                    | —        | `output-guardrails.ts:39-68`           |
| 6   | Redact doesn't redact           | **Fixed** (pipeline), cosmetic (legacy) | Medium   | `action-executors.ts:15-27`            |
| 7   | Check expressions nonexistent   | Valid                                   | High     | `cel-functions.ts`                     |
| 8   | Priority field dead             | **Fixed** (pipeline)                    | —        | `pipeline.ts:148+`                     |
| 9   | Kind field dead                 | **Fixed** (pipeline)                    | —        | `pipeline.ts:160`                      |
| 10  | Phase names discarded           | **Confirmed** (warn as labels only)     | High     | `compiler.ts:1118`                     |
| 11  | ON_FAIL: BLOCK shows "BLOCK"    | **Fixed** (compiler)                    | High     | `compiler.ts:1470-1478`                |
| 12  | ON_FAIL: RESPOND has prefix     | **Fixed** (compiler)                    | High     | `parser:2938-2946`, `compiler.ts:1478` |
| 13  | AND/OR precedence inverted      | **Incorrect**                           | —        | `evaluator.ts:113-132`                 |
| 14  | Post-extraction clears all      | **Fixed** (targeted field clearing)     | Medium   | `flow-step-executor.ts:3509`           |
| 15  | Handoff needed execution wiring | **Fixed** (active runtime paths)        | Medium   | `constraint-checker.ts`                |
| 16  | Async onCheck fire-and-forget   | Valid (construct only)                  | Low      | `constraint-executor.ts:210-289`       |
| 17  | CONSTRAINT_KEYWORDS incomplete  | **Fixed** (compiler auto-guard)         | Medium   | `compiler.ts:1137-1155`                |
| 18  | Redact/ensure cosmetic          | Valid (legacy only)                     | Medium   | `constraint-executor.ts:234-244`       |

### Priority Fixes

1. **#7/#3 Nonexistent CEL functions** — Remove from examples or implement; add compile-time validation
2. **#10 Phase names discarded** — Keep label syntax, warn authors at compile time, and clean up misleading examples
3. **#18 Legacy constraint action gaps** — Decide whether to keep or remove the cosmetic legacy evaluator paths
