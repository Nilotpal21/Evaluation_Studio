# PII Vault Boundary Contract — Low-Level Design

**Ticket**: ABLP-535
**Status**: DONE
**HLD**: `docs/specs/pii-vault-boundary-contract.hld.md`
**Feature Spec**: `docs/features/sub-features/pii-vault-boundary-contract.md`
**Test Spec**: `docs/testing/sub-features/pii-vault-boundary-contract.md`

---

## Task T-1: Schema & Core Vault

### Files to Modify

- `packages/compiler/src/platform/ir/schema.ts` — add `'original'` to `pii_access` union
- `packages/compiler/src/platform/security/pii-vault.ts` — add `'original'` case in `resolveRenderMode()`, add bare-UUID restoration in `renderForConsumer()`

### Function Signatures

**schema.ts:1003** — ToolIR.pii_access:

```typescript
pii_access?: 'original' | 'tools' | 'user' | 'logs' | 'llm';
```

**pii-vault.ts — resolveRenderMode()** — add case:

```typescript
case 'original':
  return 'original';
```

**pii-vault.ts — renderForConsumer()** — add bare-UUID second pass:

```typescript
renderForConsumer(
  text: string,
  consumer: PIIConsumer | string,
  patternConfigs?: PIIPatternConfig[],
): string {
  // Pass 1: regex-based {{PII:type:id}} replacement (existing)
  let result = text.replace(createTokenRegex(), ...);

  // Pass 2: bare-UUID restoration (NEW)
  // Only scan if vault has tokens and text might contain UUIDs
  if (this.store.size > 0) {
    result = this.restoreBareUUIDs(result, consumer, patternConfigs);
  }

  return result;
}

private restoreBareUUIDs(
  text: string,
  consumer: PIIConsumer | string,
  patternConfigs?: PIIPatternConfig[],
): string {
  // Match UUID-format strings: 8-4-4-4-12 hex
  const UUID_REGEX = /\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/g;
  return text.replace(UUID_REGEX, (match) => {
    const token = this.store.get(match);
    if (!token) return match; // Not a vault token — pass through

    const mode = resolveRenderMode(consumer, token.type, patternConfigs);
    const config = patternConfigs?.find(c => c.patternName === token.type);
    // Re-use the same switch logic as the main renderForConsumer
    return this.renderToken(token, mode, config, match);
  });
}
```

Extract the switch block from `renderForConsumer` into a private `renderToken()` helper to avoid duplication between Pass 1 and Pass 2.

### Subtasks

1. ST-1.1: Add `'original'` to `pii_access` union in `schema.ts`
2. ST-1.2: Add `'original'` case to `resolveRenderMode()` in `pii-vault.ts`
3. ST-1.3: Extract `renderToken()` helper from `renderForConsumer()`
4. ST-1.4: Add `restoreBareUUIDs()` private method
5. ST-1.5: Wire bare-UUID pass into `renderForConsumer()`

### Acceptance Criteria

- AC-1.1: `resolveRenderMode('original', 'ssn')` returns `'original'`
  - Verify: unit test direct call
- AC-1.2: `vault.renderForConsumer(tokenized, 'original')` returns plaintext
  - Verify: unit test
- AC-1.3: Bare UUID matching vault entry restored; non-vault UUID passes through
  - Verify: unit test with mixed UUIDs
- AC-1.4: All existing consumer defaults unchanged (regression)
  - Verify: existing tests still pass

---

## Task T-2: Trace Event Registry

### Files to Modify

- `packages/shared-kernel/src/constants/trace-event-registry.ts` — add PII trace event group

### Changes

Add new PII_TRACE_EVENT_TYPES group:

```typescript
export const PII_TRACE_EVENT_TYPES = ['pii_plaintext_dispensed'] as const;
export type PIITraceEventType = (typeof PII_TRACE_EVENT_TYPES)[number];
```

Add to TRACE_EVENT_GROUPS:

```typescript
pii: PII_TRACE_EVENT_TYPES,
```

Add to ALL_TRACE_EVENT_TYPES spread and RUNTIME_EVENT_TYPES:

```typescript
...PII_TRACE_EVENT_TYPES,
```

Add to TRACE_EVENT_REGISTRY:

```typescript
...registryEntriesForDomain('pii', PII_TRACE_EVENT_TYPES),
```

### Subtasks

1. ST-2.1: Add `PII_TRACE_EVENT_TYPES` array and type
2. ST-2.2: Add `pii` to `TRACE_EVENT_GROUPS`
3. ST-2.3: Add to `ALL_TRACE_EVENT_TYPES` spread
4. ST-2.4: Add to `RUNTIME_EVENT_TYPES`
5. ST-2.5: Add to `TRACE_EVENT_REGISTRY` entries

### Acceptance Criteria

- AC-2.1: `'pii_plaintext_dispensed'` is a valid `TraceEventType`
  - Verify: TypeScript compilation succeeds
- AC-2.2: `TRACE_EVENT_REGISTRY['pii_plaintext_dispensed'].emittedByRuntime` is `true`
  - Verify: unit assertion or build

---

## Task T-3: Runtime Tool Execution

### Files to Modify

- `apps/runtime/src/services/execution/pii-tool-execution.ts` — add `'original'` to type + normalizer
- `apps/runtime/src/services/execution/reasoning-executor.ts` — add audit event emission
- `apps/runtime/src/routes/internal-tools.ts` — wire PII context into Tool Test

### Function Signatures

**pii-tool-execution.ts**:

```typescript
export type ToolPIIAccess = 'original' | 'tools' | 'user' | 'logs' | 'llm';

function normalizeToolPIIAccess(value: unknown): ToolPIIAccess {
  return value === 'original' ||
    value === 'user' ||
    value === 'logs' ||
    value === 'llm' ||
    value === 'tools'
    ? value
    : 'tools';
}
```

Also update `restorePIITokensForToolExecution` string check to support bare UUIDs:

```typescript
if (typeof value === 'string') {
  // The vault's renderForConsumer now handles both {{PII:...}} tokens AND bare UUIDs,
  // so skip the fast-path optimization when bare UUIDs might be present.
  if (!value.includes('{{PII:') && !session.piiVault?.getTokenCount()) {
    return value;
  }
  return session.piiVault!.renderForConsumer(value, piiAccess, session.piiPatternConfigs);
}
```

**reasoning-executor.ts** — after tool execution input is rendered, if `piiAccess === 'original'`:

```typescript
// After restorePIITokensForToolExecution:
if (toolDef?.pii_access === 'original' && session.piiVault) {
  // Emit audit event for plaintext PII dispense
  const dispensedTokens = session.piiVault.listTokens();
  for (const token of dispensedTokens) {
    const entityHash = createHash('sha256').update(token.original).digest('hex');
    onTraceEvent?.({
      type: 'pii_plaintext_dispensed',
      data: {
        tenantId: session.tenantId || '',
        projectId: session.projectId || '',
        sessionId: session.id,
        toolName: toolCall.name,
        entityType: token.type,
        entityHash,
        agentId: session.agentName,
        piiAccess: 'original',
      },
    });
    getPIIAuditLogger().log({
      tenantId: session.tenantId || '',
      projectId: session.projectId || '',
      sessionId: session.id,
      tokenId: token.id,
      piiType: token.type,
      consumer: 'original',
      action: 'plaintext_dispensed',
      metadata: { toolName: toolCall.name, entityHash },
    });
  }
}
```

Note: The audit emission should only fire for tokens that were actually present in the rendered text, not all vault tokens. We need to track which tokens were rendered. The approach: add an optional `onTokenRendered` callback to `renderForConsumer` or check if the input text contained PII tokens.

Revised approach — simpler and more accurate: Check if the input text had `{{PII:` tokens OR bare UUIDs, and if piiAccess is 'original', emit one audit event per tool call (not per token). This avoids the complexity of tracking individual token rendering.

**internal-tools.ts** — Wire PII rendering into Tool Test params:
The Tool Test route needs to apply PII rendering when the tool has a configured `pii_access`. Since Tool Test doesn't have a full session, we create a lightweight PIIVault, tokenize the params, then render.

### Subtasks

1. ST-3.1: Add `'original'` to `ToolPIIAccess` type and `normalizeToolPIIAccess()`
2. ST-3.2: Update `restorePIITokensForToolExecution` string check for bare-UUID support
3. ST-3.3: Add audit event emission in `reasoning-executor.ts` for `'original'` path
4. ST-3.4: Wire PII context into `internal-tools.ts` Tool Test route

### Acceptance Criteria

- AC-3.1: `normalizeToolPIIAccess('original')` returns `'original'`
- AC-3.2: `normalizeToolPIIAccess('invalid')` returns `'tools'`
- AC-3.3: Tool with `pii_access: 'original'` receives plaintext in tool args
- AC-3.4: `pii_plaintext_dispensed` trace event emitted on original dispense
- AC-3.5: PIIAuditLogger entry logged on original dispense
- AC-3.6: Tool Test route applies PII rendering same as live execution

---

## Task T-4: Studio UI

### Files to Modify

- `apps/studio/src/components/agent-detail/ToolsSection.tsx` — replace native `<select>` with `<Select>`, fix labels, add 'original'
- `apps/studio/src/components/agent-editor/sections/ToolsEditor.tsx` — same fix
- `packages/i18n/locales/en/studio.json` — update labels + add `pii_original_plaintext` key

### Changes

**ToolsSection.tsx** (~line 520-536):
Replace native `<select>` with design-system `<Select>`:

```tsx
<Select
  value={tool.piiAccess ?? 'tools'}
  onChange={(val) => {
    onChangeTool(index, {
      ...tool,
      piiAccess: val === 'tools' ? undefined : (val as ToolPIIAccess),
    });
  }}
  options={[
    { value: 'original', label: t('pii_original_plaintext') },
    { value: 'tools', label: t('pii_redacted') },
    { value: 'user', label: t('pii_masked') },
    { value: 'logs', label: t('pii_redacted_logs') },
    { value: 'llm', label: t('pii_tokenized') },
  ]}
  className="!w-40 shrink-0"
/>
```

**ToolsEditor.tsx** (~line 426-441): Same replacement pattern.

**i18n studio.json** — update both agent_detail and agent_editor sections:

```json
"pii_original_plaintext": "Original (plaintext)",
"pii_redacted": "Redacted",
"pii_masked": "Masked",
"pii_redacted_logs": "Redacted (logs)",
"pii_tokenized": "Tokenized"
```

Note: The existing `pii_original` key was mislabeled — it mapped to `value="tools"` which resolves to redacted. We add `pii_original_plaintext` for the new `value="original"` and keep `pii_redacted` for `value="tools"`.

### Subtasks

1. ST-4.1: Add new i18n keys in `studio.json`
2. ST-4.2: Replace native `<select>` with `<Select>` in `ToolsSection.tsx`
3. ST-4.3: Replace native `<select>` with `<Select>` in `ToolsEditor.tsx`
4. ST-4.4: Update `piiAccess` type assertion to include `'original'`

### Acceptance Criteria

- AC-4.1: Dropdown shows "Original (plaintext)", "Redacted", "Masked", "Redacted (logs)", "Tokenized"
- AC-4.2: Default selection is "Redacted" (value='tools')
- AC-4.3: Selecting "Original (plaintext)" sets `piiAccess: 'original'`
- AC-4.4: No native `<select>` elements in PII Access UI
- AC-4.5: TypeScript build succeeds

---

## Task T-5: Tests

### Files to Create

- `apps/runtime/src/__tests__/pii-vault-boundary.test.ts` — unit tests
- `apps/runtime/src/__tests__/pii-vault-boundary.integration.test.ts` — integration tests
- `apps/runtime/src/__tests__/pii-vault-boundary.e2e.test.ts` — E2E tests

### Files to Modify

- `apps/runtime/src/__tests__/sessions/session-pii-vault.test.ts` — add ABLP-535 closure comment, add 'original' test
- `apps/runtime/src/__tests__/reported-pii-masking-gaps.test.ts` — add ABLP-535 closure comment

### Subtasks

1. ST-5.1: Unit tests — resolveRenderMode, normalizeToolPIIAccess, bare-UUID, renderForConsumer
2. ST-5.2: Integration tests — audit logging, trace events, session var restoration
3. ST-5.3: E2E tests — full round-trips, cross-session isolation, Tool Test parity
4. ST-5.4: Update existing tests with ABLP-535 closure comments

### Acceptance Criteria

- AC-5.1: >= 9 unit tests pass
- AC-5.2: >= 6 integration tests pass
- AC-5.3: >= 6 E2E tests pass
- AC-5.4: No `vi.mock` of platform components
- AC-5.5: All existing PII tests still pass (regression)

---

## Phase 2 — Audit Precision & Tool Test Parity

**Design Review:** `docs/reviews/2026-05-19-pii-vault-boundary-beta-promotion.md`
**Status:** DONE

Two approved refinements from the ALPHA review that close the remaining
MEDIUM (R1) and LOW (R2) findings before BETA promotion.

---

### Task R1: Audit Emission Precision (refactor)

**Problem:** `reasoning-executor.ts:5040-5067` iterates every token in the
session's vault when emitting `pii_plaintext_dispensed` audit events. It should
iterate only the tokens that were actually substituted into this specific tool
call's arguments.

**Approach:** Add a sibling method `renderForConsumerWithTrace` on `PIIVault`
that returns both the rendered text and the set of substituted tokens. Thread
the dispensed-token set from `restorePIITokensForToolExecution` through to the
audit emitter in `reasoning-executor.ts`.

#### Files to Modify

- `packages/compiler/src/platform/security/pii-vault.ts` (~line 187-263) — add `renderForConsumerWithTrace()` sibling method
- `apps/runtime/src/services/execution/pii-tool-execution.ts` (~line 29-64) — change `restorePIITokensForToolExecution` return type to `{ value: unknown; dispensedTokens: PIIToken[] }`, use `renderForConsumerWithTrace` for string rendering
- `apps/runtime/src/services/execution/reasoning-executor.ts` (~line 5034-5067, ~5098-5121) — update both callers of `restorePIITokensForToolExecution` to destructure the new return type; replace vault-wide `listTokens()` iteration with `dispensedTokens` iteration

#### Type Signature Changes

**pii-vault.ts — new sibling method:**

```typescript
renderForConsumerWithTrace(
  text: string,
  consumer: PIIConsumer | string,
  patternConfigs?: PIIPatternConfig[],
): { text: string; renderedTokens: PIIToken[] }
```

Both passes (regex `createTokenRegex()` pass and `restoreBareUUIDs`) must
contribute to the tracking set. Uses a `Set<string>` of token IDs internally;
returns defensive copies of matched `PIIToken` objects (same pattern as
`listTokens()`).

**pii-tool-execution.ts — return type change:**

```typescript
// Before
export function restorePIITokensForToolExecution(
  session: RuntimeSession,
  value: unknown,
  options?: ToolPIIRenderOptions,
): unknown;

// After
export interface PIIRestorationResult {
  value: unknown;
  dispensedTokens: PIIToken[];
}

export function restorePIITokensForToolExecution(
  session: RuntimeSession,
  value: unknown,
  options?: ToolPIIRenderOptions,
): PIIRestorationResult;
```

The `PIIToken` type is re-exported from `@abl/compiler/platform/security/pii-vault.js`.

**Caller updates (reasoning-executor.ts):**

```typescript
// Line ~5034 — main tool execution path
const { value: executionInput, dispensedTokens } = restorePIITokensForToolExecution(
  session,
  cleanInput,
  { piiAccess: toolDef?.pii_access },
);

// Line ~5040 — audit emission (CHANGED: iterate dispensedTokens, not listTokens)
if (toolDef?.pii_access === 'original' && dispensedTokens.length > 0) {
  for (const token of dispensedTokens) {
    // ... same event shape, only count semantics change
  }
}

// Line ~5102 — CONTEXT_ACCESS.read path
const { value: renderedValue, dispensedTokens: ctxDispensed } = restorePIITokensForToolExecution(
  session,
  val,
  { piiAccess: piiConsumer },
);
```

**internal-tools.ts — Tool Test caller (~line 512):**

```typescript
const { value: restoredParams } = restorePIITokensForToolExecution(testSession, effectiveParams, {
  piiAccess,
});
effectiveParams = restoredParams as Record<string, unknown>;
```

#### Helper Methods (internal to PIIVault)

```typescript
// New private method — same as restoreBareUUIDs but tracks which tokens matched
private restoreBareUUIDsWithTrace(
  text: string,
  consumer: PIIConsumer | string,
  patternConfigs: PIIPatternConfig[] | undefined,
  renderedIds: Set<string>,
): string
```

#### Subtasks

1. ST-R1.1: Add `renderForConsumerWithTrace()` to `PIIVault` — delegates to existing `renderToken()`, tracks matched IDs via `Set<string>`, returns defensive copies
2. ST-R1.2: Add `restoreBareUUIDsWithTrace()` private helper — same as `restoreBareUUIDs` but populates the tracking set
3. ST-R1.3: Define `PIIRestorationResult` interface in `pii-tool-execution.ts` and change `restorePIITokensForToolExecution` return type
4. ST-R1.4: Update reasoning-executor.ts line ~5034 — destructure new return type for main tool execution
5. ST-R1.5: Update reasoning-executor.ts line ~5040-5067 — iterate `dispensedTokens` instead of `session.piiVault.listTokens()`
6. ST-R1.6: Update reasoning-executor.ts line ~5102 — destructure new return type for CONTEXT_ACCESS path
7. ST-R1.7: Update internal-tools.ts line ~512 — destructure new return type for Tool Test path
8. ST-R1.8: Unit tests for `renderForConsumerWithTrace` (vault with 0/1/N tokens, only some substituted, bare-UUID hits counted)
9. ST-R1.9: Integration test for `restorePIITokensForToolExecution` — verify `dispensedTokens` contains only the tokens present in the rendered args
10. ST-R1.10: E2E test — multi-token vault where only 1 is dispensed; assert exactly 1 `pii_plaintext_dispensed` event

#### Acceptance Criteria

- AC-R1.1: `renderForConsumerWithTrace` returns only the tokens that were substituted (not all vault tokens)
- AC-R1.2: Bare-UUID hits are included in `renderedTokens`
- AC-R1.3: `renderForConsumer` signature and behavior are unchanged (backward-compatible)
- AC-R1.4: `pii_plaintext_dispensed` event shape is identical — same fields, same hash algorithm
- AC-R1.5: Zero `pii_plaintext_dispensed` events when no PII tokens appear in tool args
- AC-R1.6: Existing 60 tests still pass
- AC-R1.7: `restorePIITokensForToolExecutionText` helper updated to match new return type

#### Risk Register

| Risk                                                                                                   | Impact                                     | Likelihood | Mitigation                                                                                        |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------- |
| Caller misses destructuring change — uses raw `PIIRestorationResult` as tool input                     | TypeScript compile error (caught at build) | LOW        | `pnpm build --filter=runtime` after every file change                                             |
| `renderForConsumerWithTrace` misses a substitution path (token in set but not rendered, or vice versa) | Audit log under/over-reports               | LOW        | Unit test: tokenize 3 values, render text containing only 1; assert `renderedTokens.length === 1` |
| Bare-UUID tracking diverges from rendering                                                             | Audit log misses bare-UUID dispenses       | LOW        | Dedicated bare-UUID unit test                                                                     |

---

### Task R2: Tool Test Nested-Object Tokenization (fix)

**Problem:** `internal-tools.ts:506-511` tokenizes only top-level string
parameters. Nested objects, arrays, and string leaves inside them pass through
untouched, bypassing the PII policy gate.

**Approach:** Extract a pure recursive helper `tokenizeStringLeavesDeep` that
walks nested structures and tokenizes every string leaf via the vault. Replace
the flat loop with one call to this helper.

#### Files to Modify

- `apps/runtime/src/routes/internal-tools.ts` (~line 506-511) — replace flat loop with recursive helper call

#### Files to Create (optional — co-located helper)

- None. The helper is defined in the same file to minimize diff. If the helper
  grows beyond ~30 lines, consider extracting to
  `apps/runtime/src/services/execution/pii-deep-tokenizer.ts`.

#### Function Signature

```typescript
function tokenizeStringLeavesDeep(
  value: unknown,
  piiVault: PIIVault,
  visited: WeakSet<object>,
): unknown;
```

- Recurses into plain objects (`{}`) and arrays (`[]`)
- Tokenizes every string leaf via `piiVault.tokenize(leaf).text`
- Passes through numbers, booleans, `null`, `undefined` unchanged
- Uses `WeakSet<object>` to break cycles — if an object is already in `visited`, return it as-is
- Does NOT use JSON.stringify/parse (explicitly rejected in design review)

#### Subtasks

1. ST-R2.1: Add `tokenizeStringLeavesDeep()` function in `internal-tools.ts`
2. ST-R2.2: Replace flat loop at line 506-511 with one call: `effectiveParams = tokenizeStringLeavesDeep(effectiveParams, piiVault, new WeakSet()) as Record<string, unknown>`
3. ST-R2.3: Unit tests for the helper (flat string, nested object, nested array, mixed types, cyclic reference, non-string scalar passthrough)
4. ST-R2.4: Integration/E2E test — POST nested-payload Tool Test request, assert nested string leaves are tokenized and rendered per `pii_access`

#### Acceptance Criteria

- AC-R2.1: Nested string values are tokenized (not passed through as plaintext)
- AC-R2.2: Non-string scalars (numbers, booleans, null) pass through unchanged
- AC-R2.3: Cyclic objects do not cause infinite recursion (WeakSet guard)
- AC-R2.4: Top-level string parameters still tokenized (no regression)
- AC-R2.5: Rendering side (`restorePIITokensForToolExecution`) already handles nested objects — no modification needed (verified by existing integration tests)
- AC-R2.6: Existing 60 tests still pass

#### Risk Register

| Risk                                             | Impact                                                  | Likelihood | Mitigation                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------- |
| Recursive walk hits a prototype-polluted object  | Unexpected tokenization of `__proto__` or `constructor` | VERY LOW   | `Object.entries()` iterates own-enumerable only; no prototype traversal                           |
| Very deeply nested payload causes stack overflow | Tool Test 500 error                                     | VERY LOW   | Tool Test payloads are developer-typed; typical depth <10. Add a MAX_DEPTH guard (32) if paranoid |
| Key names that look like PII get tokenized       | False positive — key names are not values               | NONE       | Helper tokenizes VALUES only, not keys                                                            |

---

## Phase 3 — Meta-Review Findings (BETA Promotion)

**Design Review:** `docs/reviews/2026-05-20-pii-mask-behavior-and-workflow-scope-decisions.md`
**PR Review Log:** `docs/sdlc-logs/pii-vault-boundary-contract/pr-review.log.md`
**Status:** IN PROGRESS

Twelve findings from the BETA-promotion meta-review. Organized into five
implementation commits (Phases 1-5) with independent concerns per commit.

---

### Task F-1: Centralize Audit Emission in restorePIITokensForToolExecution (CRITICAL)

**Problem:** The `pii_plaintext_dispensed` audit emission exists ONLY at
`reasoning-executor.ts:5046-5072` (the main tool dispatch path). Four other
call sites — `routing-executor.ts:3193` (fan-out), `routing-executor.ts:5250`
(parallel), `hook-executor.ts:89`, and `internal-tools.ts:550` (Tool Test) —
call `restorePIITokensForToolExecution` but silently drop the returned
`dispensedTokens`, never emitting audit events. This violates FR-5.

The sixth call site — `reasoning-executor.ts:5107` (context_access.read) —
emits an audit entry but uses synthetic fields (`tokenId: key`,
`piiType: 'context_var'`) instead of real per-token data (F-8).

**Approach — Choke-Point Audit Emission:**

Move audit emission INTO `restorePIITokensForToolExecution` itself. The
function gains an optional `auditContext` parameter. When present AND
`dispensedTokens.length > 0` AND `piiAccess === 'original'`, the function
emits `pii_plaintext_dispensed` events internally — callers no longer need
to remember.

#### Files to Modify

- `apps/runtime/src/services/execution/pii-tool-execution.ts` — add `PIIAuditContext` interface, emit audit events inside `restorePIITokensForToolExecution`
- `apps/runtime/src/services/execution/reasoning-executor.ts` (~line 5034, ~5107) — pass `auditContext`, remove inline audit block at 5046-5072, remove synthetic audit at 5110-5121
- `apps/runtime/src/services/execution/routing-executor.ts` (~line 3193, ~5250) — pass `auditContext`
- `apps/runtime/src/services/execution/hook-executor.ts` (~line 89) — pass `auditContext`
- `apps/runtime/src/routes/internal-tools.ts` (~line 550) — pass `auditContext`

#### Type Signature Changes

```typescript
// pii-tool-execution.ts — new interface
export interface PIIAuditContext {
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void;
  toolName: string;
  agentId?: string;
  sessionId?: string;
  tenantId?: string;
  projectId?: string;
}

// Extended options
export interface ToolPIIRenderOptions {
  piiAccess?: ToolPIIAccess;
  auditContext?: PIIAuditContext;
}
```

#### Dedup Logic (F-5)

Inside the audit emission loop, collect tokens into a `Map<string, PIIToken>`
keyed by `token.id` before emitting. When the same PII token appears in
multiple leaves of a nested object (e.g., `{ a: shared, b: shared }` where
`shared` contains a tokenized SSN), only ONE audit event is emitted per
unique token ID.

#### tenantId Fallback (F-10)

When `auditContext.tenantId` is falsy (empty string or undefined), the audit
event uses `tenantId: '__internal__'` as a sentinel AND emits a warning-level
trace event `pii_audit_missing_tenant`. This preserves audit data while
flagging investigation.

#### context_access.read Synthetic Fields (F-8)

The context_access.read path at `reasoning-executor.ts:5107` now passes
`auditContext` to `restorePIITokensForToolExecution`. Since the function
emits real per-token events, the synthetic `tokenId: key` / `piiType: 'context_var'`
block at lines 5110-5121 is removed. Audit events now use real `token.id`
and `token.type`.

#### Subtasks

1. ST-F1.1: Add `PIIAuditContext` interface to `pii-tool-execution.ts`
2. ST-F1.2: Move `ToolPIIRenderOptions.auditContext` into options
3. ST-F1.3: Add audit emission inside `restorePIITokensForToolExecution` with Map-based dedup
4. ST-F1.4: Add `pii_audit_missing_tenant` warning event for empty tenantId
5. ST-F1.5: Update `reasoning-executor.ts:5034` — pass `auditContext`, remove inline audit block
6. ST-F1.6: Update `reasoning-executor.ts:5107` — pass `auditContext`, remove synthetic audit
7. ST-F1.7: Update `routing-executor.ts:3193` — pass `auditContext`
8. ST-F1.8: Update `routing-executor.ts:5250` — pass `auditContext`
9. ST-F1.9: Update `hook-executor.ts:89` — pass `auditContext`
10. ST-F1.10: Update `internal-tools.ts:550` — pass `auditContext` (use `'studio-tool-test'` as agentId)
11. ST-F1.11: Register `pii_audit_missing_tenant` in trace-event-registry.ts

#### Acceptance Criteria

- AC-F1.1: All 6 call sites pass `auditContext` — zero silent `dispensedTokens` drops
- AC-F1.2: `pii_plaintext_dispensed` events emitted from inside `restorePIITokensForToolExecution`
- AC-F1.3: Duplicate tokens across leaves → exactly 1 audit event per unique token ID
- AC-F1.4: Empty tenantId → `'__internal__'` sentinel + `pii_audit_missing_tenant` warning
- AC-F1.5: context_access.read path emits real token data, not synthetic fields
- AC-F1.6: No regression — existing 74 tests pass
- AC-F1.7: reasoning-executor.ts has zero inline audit emission code for PII

---

### Task F-3: WeakMap-Based Shared-Object Tokenization (HIGH)

**Problem:** `tokenizeStringLeavesDeep` in `internal-tools.ts:167` uses a
`WeakSet<object>` for cycle detection. When a shared (non-cyclic) object
appears at multiple positions in the tree, the second visit returns the
ORIGINAL (untokenized) object because the `WeakSet` marks it as "visited"
and short-circuits. Only the first occurrence gets tokenized.

**Approach:** Switch from `WeakSet<object>` to `WeakMap<object, unknown>`.
On first visit, walk the object, build the tokenized clone, store it in the
WeakMap. On re-visit, return the cached tokenized clone instead of the original.

This also fixes the cycle-branch issue: when a cycle is detected, the
function returns the in-progress tokenized clone (which will be populated by
the time the caller reads it), not the original mutable reference.

#### Files to Modify

- `apps/runtime/src/routes/internal-tools.ts` (~line 167-197) — rewrite `tokenizeStringLeavesDeep` to use `WeakMap<object, unknown>`

#### Function Signature Change

```typescript
// Before
function tokenizeStringLeavesDeep(
  value: unknown,
  piiVault: PIIVault,
  visited: WeakSet<object>,
): unknown;

// After
function tokenizeStringLeavesDeep(
  value: unknown,
  piiVault: PIIVault,
  cache: WeakMap<object, unknown>,
): unknown;
```

#### Algorithm

```typescript
function tokenizeStringLeavesDeep(
  value: unknown,
  piiVault: PIIVault,
  cache: WeakMap<object, unknown>,
): unknown {
  if (typeof value === 'string') {
    return piiVault.tokenize(value).text;
  }
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }
  // Cache hit — return previously tokenized clone (handles shared objects AND cycles)
  const cached = cache.get(value as object);
  if (cached !== undefined) {
    return cached;
  }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    cache.set(value as object, result); // Pre-register for cycles
    for (const entry of value) {
      result.push(tokenizeStringLeavesDeep(entry, piiVault, cache));
    }
    return result;
  }
  const result: Record<string, unknown> = {};
  cache.set(value as object, result); // Pre-register for cycles
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = tokenizeStringLeavesDeep(entry, piiVault, cache);
  }
  return result;
}
```

Key differences from current code:

1. `WeakMap` instead of `WeakSet` — stores the tokenized clone
2. Pre-register the result BEFORE recursing — handles cycles by returning the
   partially-built clone (which the parent holds a reference to)
3. Both shared references (`{ a: shared, b: shared }`) resolve to the SAME
   tokenized clone

#### Also Fix: F-NIT (Test Honesty)

Export `tokenizeStringLeavesDeep` from `internal-tools.ts` for testability.
Update the unit test in `pii-vault-boundary.test.ts:333-363` to import and
exercise the REAL production function instead of maintaining a mirrored copy.

#### Subtasks

1. ST-F3.1: Rewrite `tokenizeStringLeavesDeep` with `WeakMap<object, unknown>`
2. ST-F3.2: Export the function for testability
3. ST-F3.3: Update caller at line 545-549 to pass `new WeakMap()` instead of `new WeakSet()`
4. ST-F3.4: Update unit tests to import real function, add shared-object test
5. ST-F3.5: Add self-cycle test — cycle property points to the tokenized clone
6. ST-F3.6: Add cross-reference test — `{ a: shared, b: shared }` both tokenized

#### Acceptance Criteria

- AC-F3.1: `{ a: shared, b: shared }` where `shared = { ssn: '...' }` → both `a.ssn` and `b.ssn` are tokenized
- AC-F3.2: Self-cycle — works, cycle property references the tokenized clone
- AC-F3.3: Cross-array cycle — works
- AC-F3.4: All existing tokenization tests pass (no regression)
- AC-F3.5: Test imports real `tokenizeStringLeavesDeep`, not a mirrored copy

---

### Task F-2: Pause/Resume Vault Test for 'original' Consumer (CRITICAL)

**Problem:** No test covers the serialize → deserialize → `renderForConsumer('original')`
round-trip. The `encrypted-vault.test.ts` covers `llm`, `tools`, `user`, and
`logs` consumers but not `'original'`.

**Approach:** Tests-only — no production code change unless investigation
reveals a defect.

#### Files to Modify

- `apps/runtime/src/__tests__/pii-vault-boundary.test.ts` — add serialize/deserialize round-trip tests
- `apps/runtime/src/__tests__/pii-vault-boundary.integration.test.ts` — add integration test through `restorePIITokensForToolExecution`

#### Tests

1. **Unit**: `PIIVault.serialize()` → `PIIVault.deserialize()` → `renderForConsumer('original')` returns plaintext
2. **Unit**: Deserialized vault preserves token IDs — `renderForConsumerWithTrace` returns correct `renderedTokens`
3. **Integration**: Full round-trip through `restorePIITokensForToolExecution` with `piiAccess: 'original'` on a deserialized vault — asserts plaintext value AND correct `dispensedTokens`

#### Acceptance Criteria

- AC-F2.1: Serialize/deserialize round-trip preserves original values for 'original' consumer
- AC-F2.2: Deserialized vault's `renderForConsumerWithTrace` returns matching `renderedTokens`
- AC-F2.3: `restorePIITokensForToolExecution` on deserialized vault returns correct `dispensedTokens`

---

### Task F-4: HTTP E2E for Tool Test Endpoint with piiAccess (HIGH)

**Problem:** No E2E test exercises the Tool Test HTTP endpoint
(`POST /api/projects/:projectId/tools/:toolName/test`) with the `piiAccess`
parameter. The endpoint's PII rendering path is tested only via integration.

#### Files to Modify

- `apps/runtime/src/__tests__/e2e/pii-vault-boundary.e2e.test.ts` — add E2E tests
- `apps/runtime/src/__tests__/helpers/pii-e2e-helpers.ts` — add helper for Tool Test endpoint if needed

#### Tests

1. **E2E-5a**: Bootstrap project, POST to `/api/projects/:projectId/tools/:toolName/test`
   with `piiAccess: 'original'` and params containing PII (both flat AND nested).
   Assert tool captor received plaintext.
2. **E2E-5b**: Same with `piiAccess: 'tools'` (default). Assert tool captor received
   redacted values AND no `pii_plaintext_dispensed` event.

#### Acceptance Criteria

- AC-F4.1: Tool Test endpoint with `piiAccess: 'original'` dispatches plaintext to mock tool
- AC-F4.2: Tool Test endpoint with `piiAccess: 'tools'` dispatches redacted to mock tool
- AC-F4.3: Nested PII in params is tokenized and rendered correctly

---

### Task F-6: User-Configurable PII Mask Style (MEDIUM)

**Problem:** SSN masking produces `***-**-****` (full mask) but design review
document claims `***-**-6789` (last 4 visible). PM decision: keep full mask
as default, add per-pattern "last 4 visible" option.

**Approach:** The runtime already supports `maskConfig.showLast: 4` via
`applyMask()` in `pii-vault.ts:459`. The `DEFAULT_MASK_CONFIGS.ssn` has
`{ showFirst: 0, showLast: 0 }`. The fix is to surface a UI control that
maps to the existing `showLast` field.

#### Files to Modify

- `packages/database/src/models/pii-pattern-config.model.ts` (or equivalent schema) — add `maskStyle` preset field if not already covered by `maskConfig`
- `apps/studio/src/components/project-settings/PIIPatternConfigPanel.tsx` (or equivalent) — add "Mask style" dropdown
- `packages/i18n/locales/en/studio.json` — add i18n keys for mask style options
- `docs/features/sub-features/pii-vault-boundary-contract.md` — update FR-N to reflect user-configurable behavior

**Investigation needed first:** Verify the Studio PII pattern config UI exists
and what the schema looks like. The `maskConfig` field on `PIIPatternConfig`
already holds `showFirst`/`showLast`/`maskChar` — the UI may just need a
preset selector that maps to known combinations.

#### Subtasks

1. ST-F6.1: Investigate existing Studio PII pattern config UI
2. ST-F6.2: Add mask style dropdown (Full mask / Last 4 visible)
3. ST-F6.3: Wire dropdown to `maskConfig.showLast` field
4. ST-F6.4: Add i18n keys
5. ST-F6.5: Add live preview showing example output
6. ST-F6.6: Add unit test for `applyMask` with `showLast: 4`
7. ST-F6.7: Update feature spec

#### Acceptance Criteria

- AC-F6.1: Default mask for SSN is `***-**-****` (full mask, no behavior change)
- AC-F6.2: Developer can select "Last 4 visible" in Studio → subsequent renders produce `***-**-6789`
- AC-F6.3: `applyMask('123-45-6789', { showFirst: 0, showLast: 4, maskChar: '*' }, 'ssn')` returns `***-**-6789`
- AC-F6.4: i18n keys present for both options
- AC-F6.5: Feature spec updated to reflect user-configurable behavior

---

### Task F-7: Workflow PII Safety Net + Docs (MEDIUM)

**Problem:** Workflow engine bypasses PII vault entirely. PM decision: Phase 1
only — document as out-of-scope + add detection safety net.

#### Files to Modify

- `apps/workflow-engine/src/index.ts` (~line 743) — add code comment documenting the PII bypass
- `docs/features/sub-features/pii-vault-boundary-contract.md` — add workflow engine to "Non-Goals" if not already there
- `packages/shared-kernel/src/constants/trace-event-registry.ts` — register `workflow_unprotected_pii_dispatched`
- `apps/workflow-engine/src/index.ts` (~line 753) — add PII pattern scanner before `fetch` call

#### PII Detection in Workflow Tool Dispatch

Before the `fetch` call at line 747, scan `input.params` for PII patterns
using a lightweight regex check (reuse patterns from `pii-detector.ts`). If
PII patterns are detected, emit `workflow_unprotected_pii_dispatched` trace
event with `{ tenantId, workflowId, toolName, piiTypesDetected }` — NOT the
actual values.

#### Subtasks

1. ST-F7.1: Add code comment at `workflow-engine/src/index.ts:743`
2. ST-F7.2: Update feature spec Non-Goals
3. ST-F7.3: Register `workflow_unprotected_pii_dispatched` trace event
4. ST-F7.4: Add PII pattern scanner in workflow tool dispatch path
5. ST-F7.5: Unit test — workflow dispatch with PII emits event
6. ST-F7.6: Unit test — workflow dispatch without PII does NOT emit event

#### Acceptance Criteria

- AC-F7.1: Code comment at workflow engine tool dispatch documents PII bypass
- AC-F7.2: Feature spec Non-Goals mentions workflow engine
- AC-F7.3: PII in workflow tool params → `workflow_unprotected_pii_dispatched` event emitted
- AC-F7.4: No PII in params → no event
- AC-F7.5: Event payload contains PII type names only, never values

---

### Task F-9: Document Bare-UUID False-Positive Risk (MEDIUM)

**Problem:** The `restoreBareUUIDs` function matches UUID-format strings
against the vault. If a tool argument contains a legitimate UUID (e.g., a
document ID) that happens to collide with a vault token ID, it would be
incorrectly replaced. This risk is undocumented.

**Approach:** Code comment only — no code change.

#### Files to Modify

- `packages/compiler/src/platform/security/pii-vault.ts` (~line 294) — add comment documenting collision probability and threat model

#### Comment Content

Document:

1. UUIDs are 128-bit random → collision probability is ~2^(-64) per pair
2. A vault with 100 tokens and a tool call with 10 UUIDs → ~1000 comparisons → P(collision) ≈ 5.4 × 10^(-17)
3. Mitigation: vault-scoped (no cross-session), in-memory only
4. Accepted risk: negligible probability, and false positive would manifest
   as the tool receiving a PII value instead of a document ID (detectable
   via audit log)

#### Acceptance Criteria

- AC-F9.1: Comment at `restoreBareUUIDs` documents collision probability and threat model

---

### Task F-11: Pattern-Override Suppression Warning (LOW)

**Problem:** When `resolveRenderMode` returns a mode different from a tool's
requested `'original'` access due to a pattern-level `consumerAccess` override,
the tool silently receives a non-plaintext value. No warning is emitted.

**Approach:** Add a warning trace event `pii_pattern_override_suppressed_original`
in `renderToken` (or in `restorePIITokensForToolExecution`) when the resolved
mode differs from the requested consumer AND the consumer is `'original'`.

#### Files to Modify

- `packages/compiler/src/platform/security/pii-vault.ts` — extend `renderForConsumerWithTrace` to detect suppression
- `packages/shared-kernel/src/constants/trace-event-registry.ts` — register `pii_pattern_override_suppressed_original`
- `apps/runtime/src/services/execution/pii-tool-execution.ts` — emit warning when suppression detected

#### Implementation Detail

In `renderForConsumerWithTrace`, when the consumer is `'original'` and
`resolveRenderMode` returns a mode that is NOT `'original'` (i.e., a pattern
override suppressed the plaintext request), add a `suppressedPatterns` list
to the return type:

```typescript
renderForConsumerWithTrace(
  text: string,
  consumer: PIIConsumer | string,
  patternConfigs?: PIIPatternConfig[],
): {
  text: string;
  renderedTokens: PIIToken[];
  suppressedPatterns: Array<{ patternName: string; actualMode: PIIRenderMode }>;
}
```

The caller in `restorePIITokensForToolExecution` checks `suppressedPatterns`
and emits `pii_pattern_override_suppressed_original` via `auditContext.onTraceEvent`.

#### Subtasks

1. ST-F11.1: Register `pii_pattern_override_suppressed_original` trace event
2. ST-F11.2: Extend `renderForConsumerWithTrace` return to include `suppressedPatterns`
3. ST-F11.3: Emit warning in `restorePIITokensForToolExecution` when suppression detected
4. ST-F11.4: Integration test — pattern override suppresses 'original' → warning emitted

#### Acceptance Criteria

- AC-F11.1: Pattern override that changes 'original' to 'redacted' emits `pii_pattern_override_suppressed_original`
- AC-F11.2: No suppression → no warning
- AC-F11.3: Event payload includes `toolName`, `entityType`, `requestedMode: 'original'`, `actualMode`

---

### Commit Plan

| Phase | Findings            | Commit Message                                                                                               | Packages                                                                              |
| ----- | ------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 1     | F-1, F-5, F-8, F-10 | `[ABLP-535] refactor(runtime): centralize pii_plaintext_dispensed audit in restorePIITokensForToolExecution` | `apps/runtime`, `packages/shared-kernel`                                              |
| 2     | F-3, F-NIT          | `[ABLP-535] fix(runtime): WeakMap shared-object tokenization in Tool Test path`                              | `apps/runtime`                                                                        |
| 3     | F-2, F-4            | `[ABLP-535] test(runtime): pause/resume vault + Tool Test HTTP E2E coverage`                                 | `apps/runtime`                                                                        |
| 4     | F-6                 | `[ABLP-535] feat(studio): user-configurable PII mask style`                                                  | `apps/studio`, `packages/i18n`, `packages/database`                                   |
| 5     | F-7, F-9, F-11      | `[ABLP-535] feat(runtime): workflow PII safety net + pattern-override warning + docs`                        | `apps/runtime`, `apps/workflow-engine`, `packages/compiler`, `packages/shared-kernel` |

All commits: `[ABLP-535]` prefix, ≤40 files, ≤3 packages (Phase 5 touches 4
packages — split if needed).
