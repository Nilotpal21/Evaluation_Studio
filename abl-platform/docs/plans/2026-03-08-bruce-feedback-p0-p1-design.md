# Bruce Wilcox Feedback — P0/P1 Implementation Design

**Date**: 2026-03-08
**Status**: Complete
**Scope**: 4 items from Bruce Wilcox's external review prioritized as P0/P1

### Implementation Status

| Design                                           | Priority | Status                                                                                                  | Tests                                                                      |
| ------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Design 1: Tool Confirmation Immutability         | P0       | **Complete**                                                                                            | 32 passing (`tool-confirmation.test.ts`, `tool-confirmation-gate.test.ts`) |
| Design 2: PII Guard Field-Type Awareness         | P1       | **Complete** — Phase 1+2+3 all implemented (16 modules). See `docs/plans/2026-03-08-pii-phase2-spec.md` | 527 passing across 14 test files                                           |
| Design 3: Post-Guardrail Parameter Re-validation | P1       | **Complete**                                                                                            | 5 passing (`post-guardrail-revalidation.test.ts`)                          |
| Design 4: Custom Regex Extractors for GATHER     | P1       | **Complete**                                                                                            | 10 passing (`gather-extraction-pattern.test.ts`)                           |

### Implementation Files

**Design 1 — Tool Confirmation Immutability:**

- `apps/runtime/src/services/execution/tool-confirmation.ts` — snapshot, immutability validation, confirmation message formatting
- `apps/runtime/src/services/execution/reasoning-executor.ts:1454-1521` — confirmation gate wired before tool execution
- `packages/compiler/src/platform/ir/schema.ts` — `confirmation` field on `ToolDefinition`

**Design 3 — Post-Guardrail Re-validation:**

- `apps/runtime/src/services/execution/reasoning-executor.ts:1398-1423` — `validateToolInputs()` called after guardrail modification
- `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts:560-639` — `validateToolInputs()` function

**Design 4 — Custom Regex Extractors:**

- `packages/compiler/src/platform/constructs/executors/gather-executor.ts:80-131` — `extractByPattern()`, `validateExtractionPattern()`
- `packages/compiler/src/platform/constructs/executors/gather-executor.ts:210-236` — pattern-first extraction in `evaluate()`
- `packages/compiler/src/platform/ir/schema.ts` — `extraction_pattern`, `extraction_group` on `GatherField`

## Context

Bruce Wilcox reviewed ABL's spec and runtime, identifying security vulnerabilities and
migration-blocking gaps. This design addresses the 4 highest-priority items, incorporating
lessons from XO platform analysis, industry research (Azure, AWS Bedrock, Presidio, Google DLP),
and OWASP LLM Top 10 (2025).

### Migration Context

Kore.ai's migration order: AP 1.0 customers first, new customers second, XO 10/11 third.
Every design decision below is evaluated against: "Does this block or enable migration?"

---

## Design 1: Tool Confirmation Immutability (P0)

### Problem

No tool-call-level confirmation exists in the runtime. When added, a security vulnerability
arises: users could modify parameters between confirmation prompt and execution. This is
OWASP LLM Top 10 relevant (sensitive action execution without verified intent).

### Current State

- `reasoning-executor.ts` executes tool calls at line 1444 after guardrail validation
- Existing confirmation patterns: `_pending_fuzzy`, `_pending_inferences`, `_queued_intent_confirmation_` (all in `flow-step-executor.ts`)
- IR schema has `confirmation: 'always' | 'never' | 'on_change'` for gather profiles only
- `ToolHints.side_effects: boolean` exists but isn't used for confirmation gating

### Design

#### IR Schema Changes (`schema.ts`)

Add to `ToolDefinition`:

```typescript
confirmation?: {
  require: 'always' | 'never' | 'when_side_effects';
  immutable_params?: string[];  // params locked after user confirms
};
```

#### DSL Syntax

```abl
TOOLS:
  process_refund:
    confirm: always
    immutable: [order_id, amount, currency]
    # ...existing tool config
```

#### Runtime Flow (`reasoning-executor.ts`)

Insert confirmation gate after guardrail check (line 1394), before `session.toolExecutor.execute()` (line 1444):

1. Resolve confirmation requirement:
   - `'always'` → always confirm
   - `'when_side_effects'` → confirm if `toolDef.hints.side_effects === true`
   - `'never'` or absent → skip
2. Snapshot confirmed params → `session.data.values._pending_tool_confirmation`
3. Set `session.waitingForInput = ['_tool_confirmation_']`
4. Return confirmation message to user (tool name, params summary)
5. On user response:
   - "yes" → compare current params against snapshot for `immutable_params`
     - If any immutable param changed → reject with error, emit trace event
     - If unchanged → execute tool
   - "no" → return cancellation result to LLM, emit trace event

#### New File: `apps/runtime/src/services/execution/tool-confirmation.ts`

```typescript
export interface ToolConfirmationSnapshot {
  toolName: string;
  toolCallId: string;
  params: Record<string, unknown>;
  immutableParams: string[];
  snapshotHash: string; // SHA-256 of JSON.stringify(immutableParams values)
  createdAt: number;
  expiresAt: number; // TTL — don't confirm stale snapshots
}

export function createSnapshot(toolCall, toolDef): ToolConfirmationSnapshot;
export function validateImmutability(
  snapshot,
  currentParams,
): { valid: boolean; violations: string[] };
export function formatConfirmationMessage(toolCall, toolDef): string;
```

#### Trace Events

```typescript
{ type: 'tool_confirmation_requested', data: { toolName, params, immutableParams } }
{ type: 'tool_confirmation_approved', data: { toolName, toolCallId } }
{ type: 'tool_confirmation_rejected', data: { toolName, toolCallId, reason } }
{ type: 'tool_confirmation_immutability_violation', data: { toolName, violations } }
```

#### Security Properties

- Snapshot includes SHA-256 hash of immutable param values — tamper-evident
- TTL on snapshots (default 5 minutes) — stale confirmations auto-expire
- Immutability check compares deep-equal, not reference equal
- Snapshot stored server-side in session state — client cannot modify

### Files to Modify

| File                                                        | Change                                             |
| ----------------------------------------------------------- | -------------------------------------------------- |
| `packages/compiler/src/platform/ir/schema.ts`               | Add `confirmation` to `ToolDefinition`             |
| `apps/runtime/src/services/execution/reasoning-executor.ts` | Confirmation gate before line 1444                 |
| `apps/runtime/src/services/execution/tool-confirmation.ts`  | New — snapshot/compare/format helpers              |
| Compiler DSL parser                                         | Support `confirm:` and `immutable:` in TOOLS block |

---

## Design 2: PII Guard Field-Type Awareness (P1)

### Problem

`pii-guard.ts` blindly redacts all user messages via `redactPII()`, including when the user
is providing a phone number or SSN that the agent explicitly asked for via GATHER. This
breaks entity extraction and creates a terrible UX.

### XO Platform Analysis

XO solves this with:

- **Redis key** `Sensitive:<streamId>:<userId>` tracks current sensitive entity being gathered
- **Token vault** `#*#TYPE-UNIQID-DISPLAY#*#` stores originals in MongoDB for validation
- **Per-entity `isSensitive`** flag + `sensitive_pattern` config
- **Three display modes**: redaction, masking (partial reveal), replacement
- **Transient PII**: `isTransient` with TTL cleanup for CVV/OTP
- **Dual pipeline**: `redactObj()` (global) + `redactObjEntity()` (per-entity)

#### XO Strengths to Preserve

- Context-aware exemption (don't redact what you're gathering)
- Vault-based reversibility (original values recoverable)
- Transient PII with auto-cleanup
- Per-entity sensitive configuration

#### XO Flaws to Fix

- Delimiter-based token parsing (`#*#`) — fragile, breaks if display value contains delimiter
- Plain-text vault in MongoDB — compliance risk (GDPR/HIPAA require encryption at rest)
- Regex-only detection — misses names, addresses, free-text medical info
- Per-entity-node boolean — too coarse, no per-context policy overrides
- Single display mode per pattern — no per-consumer views
- Object mutation pattern (`obj.isGlobalPII = true`) — spaghetti state

### Industry Best Practices

| Dimension         | Best Practice                                            | Source                   |
| ----------------- | -------------------------------------------------------- | ------------------------ |
| Reversibility     | Crypto-based tokens (AES-SIV, FPE-FFX)                   | Google DLP, AWS Bedrock  |
| Context exemption | Per-entity policy overrides in single request            | Azure AI Language (2025) |
| LLM boundary      | Separate assessment from invocation, tokenize before LLM | AWS Bedrock Guardrails   |
| Display modes     | Per-consumer views (LLM/user/logs see different things)  | AWS tokenization pattern |
| Detection         | ML + regex + checksum (pluggable recognizers)            | Presidio                 |
| Transient PII     | TTL-based cleanup (XO is ahead of industry here)         | Kore.ai XO               |
| Audit             | Always log detections even if exempted                   | OWASP LLM02 (2025)       |

### Design — Phase 1 (P1, implement now)

#### IR Schema Changes (`schema.ts`)

Add to `GatherField`:

```typescript
sensitive?: boolean;                              // field carries PII
sensitive_display?: 'redact' | 'mask' | 'replace'; // how to display in non-gathering contexts
mask_config?: { show_first: number; show_last: number; char: string };
transient?: boolean;                              // auto-cleanup after gather completes
```

Add to `EntityDefinition` (NLU types):

```typescript
sensitive?: boolean;  // mirrors GatherField.sensitive for NLU awareness
```

#### Context-Aware Exemption (`pii-guard.ts`)

Current code (broken):

```typescript
// Blindly redacts everything
const result = redactPII(ctx.userMessage);
return { ...ctx, userMessage: result.redacted };
```

Fixed:

```typescript
const exemptTypes = resolveGatherExemptions(ctx.missingFields, ctx.declaredEntities);
const result = redactPIISelective(ctx.userMessage, exemptTypes);
// Still log ALL detections for audit (OWASP LLM02)
if (result.detections.length > 0) {
  log.info('pii-detected', {
    types: result.detections.map((d) => d.type),
    exempted: result.exemptedTypes,
    redacted: result.redactedTypes,
  });
}
return { ...ctx, userMessage: result.redacted };
```

#### Selective Redaction API (`pii-detector.ts`)

```typescript
export function redactPIISelective(
  text: string,
  exemptTypes?: Set<PIIType>,
): PIIDetectionResult & { exemptedTypes: PIIType[]; redactedTypes: PIIType[] };
```

- Runs ALL detectors (always detect everything)
- Only redacts non-exempt types
- Returns full detection list for audit trail
- Exempt types are still present in `detections[]` with an `exempted: true` flag

#### Type Mapping Function

```typescript
function resolveGatherExemptions(
  missingFields: string[] | undefined,
  declaredEntities: EntityDefinition[] | undefined,
): Set<PIIType> {
  // Map gather field types/semantics to PII types:
  // phone, tel → PIIType.PHONE
  // email → PIIType.EMAIL
  // ssn, social_security → PIIType.SSN
  // credit_card, card_number → PIIType.CREDIT_CARD
  // Only exempt if the field is currently being gathered (in missingFields)
}
```

### Design — Phase 2 (P2, XO migration readiness)

#### Tokenization with Encrypted Vault

- **Token format**: `{{PII:<type>:<uuid>}}` — clean, parseable, no delimiter ambiguity
- **Vault storage**: AES-256-GCM encrypted at rest with tenant-scoped keys (existing infra)
- **Redis**: Session-lifetime tokens for active conversations
- **MongoDB**: Audit retention with TTL indexes
- **Transient PII**: Redis-only, no MongoDB persistence, TTL auto-cleanup

#### Per-Consumer Views

| Consumer    | Sees                                                                 |
| ----------- | -------------------------------------------------------------------- |
| LLM         | Tokenized: `{{PII:PHONE:abc123}}`                                    |
| User        | Display mode: masked `***-***-7890`, replaced `[PHONE]`, or original |
| Logs/traces | Fully redacted: `[REDACTED_PHONE]`                                   |
| Tools       | Original (configurable per tool via `context_access`)                |

#### Pluggable Recognizers (Presidio-inspired)

```typescript
interface PIIRecognizer {
  name: string;
  supportedTypes: PIIType[];
  tier: 'regex' | 'ml' | 'custom';
  detect(text: string): PIIDetection[];
}
```

- Tier 1: Regex (existing, fast, zero-cost)
- Tier 2: NER-based (optional, for names/addresses/medical)
- Tier 3: Custom domain-specific (for XO migration — custom entity patterns)

#### XO Migration Mapping

| XO Concept                                | ABL Equivalent                                     |
| ----------------------------------------- | -------------------------------------------------- |
| `isSensitive` on entity node              | `sensitive: true` on GatherField                   |
| `sensitive_pattern.display.type`          | `sensitive_display` on GatherField                 |
| `sensitive_pattern.display.maskingProps`  | `mask_config` on GatherField                       |
| `isTransient`                             | `transient: true` on GatherField                   |
| `Sensitive:<streamId>:<userId>` Redis key | `ctx.missingFields` in NLUContext (already exists) |
| `#*#TYPE-UNIQID-DISPLAY#*#`               | `{{PII:<type>:<uuid>}}` (Phase 2)                  |
| `redactObj()` + `redactObjEntity()`       | Single `redactPIISelective()` with exemptions      |
| `AnonymizeUtils.excludeFields`            | Per-consumer views (Phase 2)                       |

### Files to Modify (Phase 1)

| File                                                         | Change                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `packages/compiler/src/platform/ir/schema.ts`                | Add `sensitive`, `sensitive_display`, `mask_config`, `transient` to GatherField |
| `packages/compiler/src/platform/security/pii-detector.ts`    | Add `redactPIISelective()` with exempt types                                    |
| `packages/compiler/src/platform/nlu/enterprise/pii-guard.ts` | Read `ctx.missingFields`, resolve exemptions, call selective API                |
| `packages/compiler/src/platform/nlu/types.ts`                | Add `sensitive` to EntityDefinition                                             |

---

## Design 3: Post-Guardrail Parameter Re-validation (P1)

### Problem

In `reasoning-executor.ts` lines 1379-1394, when guardrails modify tool parameters
(e.g., redacting PII from input), the modified params skip `validateToolInputs()`.
Guardrail-modified params could violate type constraints, required fields, or enum
restrictions.

### Current Flow (broken)

```
guardrail evaluates tool input
  → guardrail modifies content (redact/fix action)
  → JSON.parse modified content
  → replace toolCall.input
  → proceed to execution  ← SKIPS VALIDATION
```

### Fixed Flow

```
guardrail evaluates tool input
  → guardrail modifies content (redact/fix action)
  → JSON.parse modified content
  → replace toolCall.input
  → validateToolInputs(toolName, toolCall.input, toolDef.parameters)  ← RE-VALIDATE
  → proceed to execution
```

### Implementation

After line 1394 in `reasoning-executor.ts`, add:

```typescript
// Re-validate after guardrail modification
const toolDef = session.agentIR?.tools?.find((t) => t.name === toolCall.name);
if (toolDef?.parameters) {
  validateToolInputs(toolCall.name, toolCall.input, toolDef.parameters);
}
```

If validation fails after guardrail modification, return error to LLM (don't execute tool).
This catches scenarios like:

- Guardrail redacts a required field to `[REDACTED]` → type validation fails
- Guardrail truncates a value below minimum length
- Guardrail modifies an enum value to something not in the allowed set

### Files to Modify

| File                                                        | Change                                          |
| ----------------------------------------------------------- | ----------------------------------------------- |
| `apps/runtime/src/services/execution/reasoning-executor.ts` | Add `validateToolInputs()` call after line 1394 |

~5 lines of code. Low risk, high value.

---

## Design 4: Custom Regex Extractors for GATHER (P1)

### Problem

XO 10/11 migration requires custom extraction patterns on gather fields. XO uses
`sensitive_pattern.regex` arrays for per-entity extraction. ABL needs an equivalent
for fields like policy numbers, account IDs, employee codes that have specific formats.

### Current State

- `ExtractionStrategy = 'auto' | 'ml' | 'llm' | 'hybrid' | 'pattern'`
- `'pattern'` strategy exists in IR but has no runtime implementation for custom regex
- `extraction_hints` (string array) exists on GatherField but is only used as LLM hints
- XO's `sensitive_pattern.regex` is an array of regex strings per entity node

### Design

#### IR Schema Changes (`schema.ts`)

Add to `GatherField`:

```typescript
extraction_pattern?: string;   // regex pattern for value extraction
extraction_group?: number;     // capture group index (default: 0 = full match)
```

#### DSL Syntax

```abl
GATHER:
  policy_number:
    type: string
    extraction_pattern: "POL-\\d{6}-[A-Z]{2}"
    prompt: "What is your policy number?"

  employee_id:
    type: string
    extraction_pattern: "EMP-(\\d{4,8})"
    extraction_group: 1  # capture the digits only
    prompt: "What is your employee ID?"
```

#### Runtime Flow (`gather-executor.ts`)

Add pattern extraction as **first-priority strategy** (before LLM/ML):

1. If `field.extraction_pattern` exists:
   a. Compile regex (with validation — reject invalid/ReDoS patterns)
   b. Test against user message
   c. If match found → extract value (using `extraction_group` or full match)
   d. Run through field's `validation` rules (if any)
   e. If valid → use extracted value, skip LLM extraction for this field
   f. If no match or invalid → fall through to configured `extraction_strategy`

2. Pattern validation at compile time:
   - Reject patterns that don't compile
   - Warn on patterns vulnerable to ReDoS (exponential backtracking)
   - Max pattern length: 500 chars

#### XO Migration Mapping

| XO Concept                             | ABL Equivalent                                                             |
| -------------------------------------- | -------------------------------------------------------------------------- |
| `sensitive_pattern.regex[]` (array)    | `extraction_pattern` (single regex — simpler, compose with `\|` if needed) |
| Entity node regex matching             | GatherField `extraction_pattern`                                           |
| Implicit "mask everything if no regex" | Explicit `sensitive: true` + `sensitive_display`                           |

### Files to Modify

| File                                                                     | Change                                                      |
| ------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `packages/compiler/src/platform/ir/schema.ts`                            | Add `extraction_pattern`, `extraction_group` to GatherField |
| `packages/compiler/src/platform/constructs/executors/gather-executor.ts` | Pattern extraction as first-priority strategy               |
| Compiler DSL parser                                                      | Support `extraction_pattern:` in GATHER blocks              |
| Compiler validation                                                      | Regex compilation check, ReDoS warning                      |

---

## Priority and Dependencies

```
P0: Tool Confirmation Immutability
  └── No dependencies, implement first

P1: Post-Guardrail Re-validation
  └── No dependencies, smallest change (~5 lines)

P1: PII Guard Field-Type Awareness (Phase 1)
  └── No dependencies on other P1s
  └── Phase 2 depends on encryption infra (already exists)

P1: Custom Regex Extractors
  └── No dependencies on other P1s
```

Recommended implementation order:

1. Post-guardrail re-validation (smallest, immediate security fix)
2. Tool confirmation immutability (P0, most critical)
3. PII guard field-type awareness Phase 1 (enables XO migration planning)
4. Custom regex extractors (enables XO migration)

---

## Testing Strategy

### Tool Confirmation Immutability

- Unit: snapshot creation, immutability validation, hash comparison
- Integration: full confirmation flow with mock session (approve, reject, tamper)
- Security: verify snapshot is server-side only, TTL expiration works

### PII Guard Field-Type Awareness

- Unit: `redactPIISelective()` with various exempt type combinations
- Unit: `resolveGatherExemptions()` type mapping
- Integration: full NLU pipeline with gather context — verify phone not redacted when gathering phone
- Regression: verify non-exempt PII still redacted during gather

### Post-Guardrail Re-validation

- Unit: guardrail modifies required field → validation error
- Unit: guardrail modifies enum value → validation error
- Integration: full tool call with guardrail modification → re-validation catches invalid state

### Custom Regex Extractors

- Unit: pattern compilation, extraction with capture groups
- Unit: ReDoS pattern detection
- Integration: gather flow with extraction_pattern → value extracted without LLM call
- Edge: no match → fallback to LLM extraction
