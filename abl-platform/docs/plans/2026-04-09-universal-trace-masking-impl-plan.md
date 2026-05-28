# LLD: Universal Trace Event Masking

**Feature Spec**: `docs/features/sub-features/universal-trace-masking.md`
**HLD**: `docs/specs/universal-trace-masking.hld.md`
**Test Spec**: `docs/testing/sub-features/universal-trace-masking.md`
**Status**: DONE
**Date**: 2026-04-09
**Jira**: [ABLP-214](https://koreteam.atlassian.net/browse/ABLP-214)

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                  | Rationale                                                                                                                                          | Alternatives Rejected                                                            |
| --- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| D-1 | Leverage `scrub-patterns.ts` `DEFAULT_SECRET_PATTERNS` in trace-scrubber  | `scrub-patterns.ts` already has correct Bearer regex (no `^` anchor), AKIA, `abl_`, and generic API key patterns. No need to duplicate.            | Maintaining separate pattern lists in trace-scrubber.ts                          |
| D-2 | Add key prefix patterns to `scrub-patterns.ts` (single source of truth)   | New `sk-`, `pk_`, `ghp_`, `gho_` patterns benefit all consumers (sanitizer-middleware, response-sanitizer, trace-scrubber).                        | Adding prefixes only to trace-scrubber.ts (siloes the patterns)                  |
| D-3 | Secret key name detection stays in `trace-scrubber.ts`                    | `trace-scrubber.ts` already has key-aware recursion (`scrubValue(value, key)` and `scrubString(value, key)`). `scrubSecrets()` does not pass keys. | Adding key-name awareness to scrub-patterns.ts (larger refactor, more consumers) |
| D-4 | `scrubTraceEvent()` = `scrubSecrets()` + secret key names + `redactPII()` | Layers all three protection tiers: secret patterns, key name redaction, PII detection. Each layer is independent and idempotent.                   | Single monolithic function (harder to test independently)                        |
| D-5 | Remove Luhn validation from credit card detection                         | Feature spec FR-7: mask ALL 13-19 digit sequences. Luhn causes false negatives for test cards and typos.                                           | Keep Luhn and add a separate no-Luhn pattern (complexity)                        |
| D-6 | Fail-open in `emit()` — catch scrubbing errors, emit original             | Observability > scrubbing. A scrubbing failure should not drop trace events. Warning log enables remediation.                                      | Fail-closed (drop event on scrub error — loses observability)                    |

### Key Interfaces & Types

```typescript
// New export from trace-scrubber.ts
export function scrubTraceEvent(data: Record<string, unknown>): Record<string, unknown>;

// Internal — set of key names that trigger value redaction
const SECRET_KEY_NAMES: ReadonlySet<string>; // password, token, secret, api_key, ...

// Modified in pii-detector.ts — credit_card pattern
// BEFORE: validate: (match) => luhnCheck(match.replace(/[\s-]/g, ''))
// AFTER:  validate removed (undefined) — all 13-19 digit sequences match

// Modified credit_card regex for broader coverage:
// BEFORE: /\b(\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4})\b/g  (16 digits only)
// AFTER:  /\b\d(?:[\s-]?\d){12,18}\b/g  (13-19 digits with optional separators)
```

### Module Boundaries

| Module                  | Responsibility                                                        | Depends On                                |
| ----------------------- | --------------------------------------------------------------------- | ----------------------------------------- |
| `scrub-patterns.ts`     | Single source of truth for secret regex patterns                      | None                                      |
| `trace-scrubber.ts`     | Key-aware deep scrubbing: secret patterns + key name detection + PII  | `scrub-patterns.ts`, `pii-detector.ts`    |
| `pii-detector.ts`       | PII detection: email, phone, SSN, credit card (stricter), IP          | None                                      |
| `trace-emitter.ts`      | Calls `scrubTraceEvent()` inside `emit()` gated by `enableScrub`      | `trace-scrubber.ts` (via `@abl/compiler`) |
| `emit-to-eventstore.ts` | Existing ClickHouse scrubbing (unchanged, receives pre-scrubbed data) | `scrub-patterns.ts`                       |

---

## 2. File-Level Change Map

### New Files

None. All changes are to existing files.

### Modified Files

| File                                                                    | Change Description                                                                                                                                                               | Risk |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `packages/compiler/src/platform/constructs/executors/scrub-patterns.ts` | Add `sk-`, `pk_`, `ghp_`, `gho_` key prefix patterns to `DEFAULT_SECRET_PATTERNS`                                                                                                | Low  |
| `packages/compiler/src/platform/constructs/executors/trace-scrubber.ts` | Replace local `SECRET_PATTERNS` with import from `scrub-patterns.ts`. Add `SECRET_KEY_NAMES` set. Add `scrubTraceEvent()` export. Update `scrubString()` to use shared patterns. | Med  |
| `packages/compiler/src/platform/security/pii-detector.ts`               | Update `credit_card` regex to 13-19 digits. Remove `validate: luhnCheck`.                                                                                                        | Low  |
| `packages/compiler/src/platform/constructs/index.ts`                    | Add `scrubTraceEvent` to barrel export (line 235)                                                                                                                                | Low  |
| `packages/compiler/src/index.ts`                                        | Add `scrubTraceEvent` to barrel export (line 521-524)                                                                                                                            | Low  |
| `apps/runtime/src/services/trace-emitter.ts`                            | Import `scrubTraceEvent`, add scrubbing inside `emit()` gated by `enableScrub`                                                                                                   | Med  |
| `packages/compiler/src/__tests__/constructs/trace-scrubber.test.ts`     | Add tests for `scrubTraceEvent()`: key prefixes, secret key names, idempotency, null safety, performance                                                                         | Low  |
| `packages/compiler/src/__tests__/security/pii-detector.test.ts`         | Update credit card test: Luhn-failing card should now be detected (line 102-106)                                                                                                 | Low  |

### Deleted Files

None.

---

## 3. Implementation Phases

CRITICAL: Each phase is independently deployable and testable.
No phase leaves the system in a broken state.

---

### Phase 1: Enhance Secret Patterns (compiler)

**Goal**: Add key prefix patterns to the shared secret pattern library.

**Tasks**:

1.1. Add key prefix patterns to `DEFAULT_SECRET_PATTERNS` in `scrub-patterns.ts`:

- `sk-` prefix: `/\bsk-[A-Za-z0-9]{20,}\b/g` (OpenAI-style)
- `pk_live_` / `pk_test_` prefix: `/\bpk_(?:live|test)_[A-Za-z0-9]{20,}\b/g` (Stripe-style)
- `ghp_` prefix: `/\bghp_[A-Za-z0-9]{20,}\b/g` (GitHub personal access token)
- `gho_` prefix: `/\bgho_[A-Za-z0-9]{20,}\b/g` (GitHub OAuth token)

  1.2. Run `pnpm build --filter=@abl/compiler` to verify no type errors.

**Files Touched**:

- `packages/compiler/src/platform/constructs/executors/scrub-patterns.ts` — add 4 regex patterns to `DEFAULT_SECRET_PATTERNS` array

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/compiler` succeeds with 0 errors
- [ ] Existing `scrub-patterns` consumers (`sanitizer-middleware.ts`, `emit-to-eventstore.ts`) continue to compile
- [ ] No existing tests broken: `pnpm --filter @abl/compiler test` passes

**Test Strategy**:

- Unit: Existing tests in `scrub-patterns.test.ts` (if exists) or verified via trace-scrubber tests in Phase 3

**Rollback**: Revert the 4 added regex lines. Zero downstream impact.

---

### Phase 2: Enhance trace-scrubber and pii-detector (compiler)

**Goal**: Replace trace-scrubber's weak patterns with shared patterns, add secret key name detection, export `scrubTraceEvent()`, and make credit card detection stricter.

**Tasks**:

2.1. **Update `trace-scrubber.ts`** — replace local `SECRET_PATTERNS` with import from `scrub-patterns.ts`:

- Remove local `SECRET_PATTERNS` array (lines 11-14)
- Import `DEFAULT_SECRET_PATTERNS` and `SENSITIVE_HEADER_NAMES` from `./scrub-patterns.js`
- Remove local `SENSITIVE_HEADERS` set (lines 17-24) — use `SENSITIVE_HEADER_NAMES` from shared module
- Keep local `REDACTED` constant or import from `scrub-patterns.js`

  2.2. **Add `SECRET_KEY_NAMES` set** to `trace-scrubber.ts`:

```typescript
const SECRET_KEY_NAMES: ReadonlySet<string> = new Set([
  'password',
  'passwd',
  'pass',
  'secret',
  'secret_key',
  'secretkey',
  'api_key',
  'apikey',
  'api_secret',
  'apisecret',
  'token',
  'access_token',
  'accesstoken',
  'refresh_token',
  'credential',
  'credentials',
  'private_key',
  'privatekey',
  'client_secret',
  'clientsecret',
  'authorization',
  'auth_token',
  'authtoken',
]);
```

2.3. **Update `scrubString()`** to use `DEFAULT_SECRET_PATTERNS`:

- Replace `for (const pattern of SECRET_PATTERNS)` with `for (const pattern of DEFAULT_SECRET_PATTERNS)`
- Add secret key name check before pattern matching:
  ```typescript
  if (key && SECRET_KEY_NAMES.has(key.toLowerCase())) {
    return REDACTED;
  }
  ```
- Use `SENSITIVE_HEADER_NAMES` instead of local `SENSITIVE_HEADERS`

  2.4. **Add `scrubTraceEvent()` export**:

```typescript
export function scrubTraceEvent(data: Record<string, unknown>): Record<string, unknown> {
  return scrubValue(data) as Record<string, unknown>;
}
```

This is functionally identical to `scrubToolCallData()` but with a semantically distinct name for trace-level scrubbing. Both delegate to `scrubValue()`.

2.5. **Update `pii-detector.ts`** — stricter credit card:

- Change credit_card regex from `/\b(\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4})\b/g` to `/\b\d(?:[\s-]?\d){12,18}\b/g`
- Remove `validate: (match: string) => luhnCheck(match.replace(/[\s-]/g, ''))` (set to `undefined` or remove the property)

  2.6. **Update barrel exports**:

- `packages/compiler/src/platform/constructs/index.ts` line 235: add `scrubTraceEvent` to the export
- `packages/compiler/src/index.ts` lines 521-524: add `scrubTraceEvent` to the export

  2.7. Run `pnpm build --filter=@abl/compiler` to verify.

**Files Touched**:

- `packages/compiler/src/platform/constructs/executors/trace-scrubber.ts` — replace patterns, add key name set, add export
- `packages/compiler/src/platform/security/pii-detector.ts` — update credit_card regex, remove Luhn
- `packages/compiler/src/platform/constructs/index.ts` — add `scrubTraceEvent` export
- `packages/compiler/src/index.ts` — add `scrubTraceEvent` export

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/compiler` succeeds with 0 errors
- [ ] `scrubTraceEvent` is importable: `import { scrubTraceEvent } from '@abl/compiler'`
- [ ] Existing `scrubToolCallData` behavior unchanged (same patterns, now from shared source)
- [ ] `pnpm build --filter=@agent-platform/runtime` succeeds (runtime depends on compiler)

**Test Strategy**:

- Unit: Tests added in Phase 3
- Build verification: `pnpm build` for compiler and runtime packages

**Rollback**: Revert changes to trace-scrubber.ts, pii-detector.ts, and barrel exports. Restore local `SECRET_PATTERNS` and `SENSITIVE_HEADERS`.

---

### Phase 3: Add and update unit tests (compiler)

**Goal**: Add unit tests for all new patterns and behavior. Update existing tests for changed behavior.

**Tasks**:

3.1. **Update `trace-scrubber.test.ts`** — add tests for `scrubTraceEvent()`:

- Import `scrubTraceEvent` alongside existing `scrubToolCallData`
- Add `describe('scrubTraceEvent')` block with:
  - UT-1: Bearer token mid-string match (`"Authorization: Bearer eyJ..."` → `"Authorization: Bearer [REDACTED]"`)
  - UT-2: API key assignment pattern (`"api_key=AKIAIOSFODNN7EXAMPLE"` → `"api_key=[REDACTED]"`)
  - UT-3: `sk-` prefix detection
  - UT-4: `pk_live_` prefix detection
  - UT-5: `ghp_` prefix detection
  - UT-6: `abl_` prefix detection
  - UT-7: Secret key name redaction (`{ password: "x", username: "y" }` → `{ password: "[REDACTED]", username: "y" }`)
  - UT-8: Nested object traversal with secret key names
  - UT-9: Array traversal with secret key names
  - UT-13: Idempotent — already-redacted values unchanged
  - UT-14: Null/undefined/empty input returns unchanged
  - UT-15: Performance — <1ms for typical 2KB event

    3.2. **Update existing Bearer test** (line 34-42):

- Current: `expect(scrubbed.token).toBe('[REDACTED]')` for `"Bearer eyJ..."` as a full string value
- After: The shared patterns will still match the full Bearer string, so this test should remain passing. Verify.

  3.3. **Update `pii-detector.test.ts`** — credit card test:

- Line 102-106: Change `expect(ccDetections).toHaveLength(0)` to `expect(ccDetections).toHaveLength(1)` (Luhn-failing card is now detected)
- Add assertion: `expect(ccDetections[0].value).toBe('[REDACTED_CARD]')`

  3.4. Run full test suite: `pnpm --filter @abl/compiler test`

**Files Touched**:

- `packages/compiler/src/__tests__/constructs/trace-scrubber.test.ts` — add `scrubTraceEvent` tests
- `packages/compiler/src/__tests__/security/pii-detector.test.ts` — update credit card assertion

**Exit Criteria**:

- [ ] `pnpm --filter @abl/compiler test` passes with 0 failures
- [ ] New `scrubTraceEvent` describe block has ≥12 passing tests
- [ ] Credit card test asserts Luhn-failing card IS detected
- [ ] All existing tests still pass (no regressions)

**Test Strategy**:

- Unit: All new tests are pure function tests — input → output, no mocks, no side effects

**Rollback**: Revert test file changes. Tests are additive — no production impact.

---

### Phase 4: Wire scrubbing into emit() (runtime)

**Goal**: Add universal scrubbing inside `trace-emitter.ts` `emit()` function.

**Tasks**:

4.1. **Add import** in `trace-emitter.ts`:

- Add `scrubTraceEvent` to the existing import from `@abl/compiler` (line 16):

  ```typescript
  import { scrubToolCallData, redactPII, scrubTraceEvent } from '@abl/compiler';
  ```

  4.2. **Add scrubbing inside `emit()`** — after building `storedEvent` (after line 136), before TraceStore write (line 140):

```typescript
// Universal PII/secret scrubbing — scrub event.data before any storage or transport
if (enableScrub && storedEvent.data) {
  try {
    storedEvent.data = scrubTraceEvent(storedEvent.data as Record<string, unknown>);
  } catch (err) {
    log.warn('Trace event scrubbing failed — emitting original event', {
      sessionId,
      eventType: storedEvent.type,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
```

4.3. Run `pnpm build --filter=@agent-platform/runtime` to verify.

**Files Touched**:

- `apps/runtime/src/services/trace-emitter.ts` — add import, add scrubbing block in `emit()`

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/runtime` succeeds with 0 errors
- [ ] `pnpm build` (full monorepo) succeeds
- [ ] `scrubTraceEvent` call is inside `emit()` function, gated by `enableScrub`
- [ ] Try/catch wraps the scrubbing call with fail-open semantics (warning log + original event)

**Test Strategy**:

- Integration: Tested in Phase 5
- Build verification: Full monorepo build

**Rollback**: Remove the import addition and the scrubbing block (6-10 lines). `emit()` returns to its previous behavior.

---

### Phase 5: Integration and existing test verification (runtime)

**Goal**: Verify the full pipeline works end-to-end and no existing tests are broken.

**Tasks**:

5.1. Run full compiler test suite: `pnpm --filter @abl/compiler test`
5.2. Run full runtime test suite: `pnpm --filter @agent-platform/runtime test`
5.3. Run full monorepo build: `pnpm build`
5.4. Run full monorepo test suite: `pnpm test` (or `pnpm test:report` for structured output)
5.5. Verify no regressions in related packages that import from `@abl/compiler`

**Files Touched**:

- None — this phase is verification only

**Exit Criteria**:

- [ ] `pnpm --filter @abl/compiler test` — 0 failures
- [ ] `pnpm --filter @agent-platform/runtime test` — 0 failures
- [ ] `pnpm build` — 0 errors across all packages
- [ ] No test regressions in any package

**Test Strategy**:

- Full suite: Compiler unit tests, runtime integration tests, monorepo-wide build

**Rollback**: N/A — no code changes in this phase.

---

## 4. Wiring Checklist

CRITICAL: Every new component must be wired into its callers.

- [ ] `scrubTraceEvent` exported from `packages/compiler/src/platform/constructs/executors/trace-scrubber.ts`
- [ ] `scrubTraceEvent` re-exported from `packages/compiler/src/platform/constructs/index.ts` (line 235)
- [ ] `scrubTraceEvent` re-exported from `packages/compiler/src/index.ts` (lines 521-524)
- [ ] `scrubTraceEvent` imported in `apps/runtime/src/services/trace-emitter.ts` (line 16)
- [ ] `scrubTraceEvent` called inside `emit()` function, gated by `enableScrub`
- [ ] `DEFAULT_SECRET_PATTERNS` imported in `trace-scrubber.ts` from `./scrub-patterns.js`
- [ ] `SENSITIVE_HEADER_NAMES` imported in `trace-scrubber.ts` from `./scrub-patterns.js`
- [ ] Key prefix patterns added to `DEFAULT_SECRET_PATTERNS` in `scrub-patterns.ts`
- [ ] Credit card regex updated in `pii-detector.ts` — Luhn validation removed
- [ ] Existing `scrubToolCallData` still works unchanged (delegates to same `scrubValue()`)
- [ ] No new routes, models, workers, or middleware needed
- [ ] No OpenAPI spec changes needed
- [ ] No UI component changes needed (Studio receives pre-scrubbed data)

---

## 5. Cross-Phase Concerns

### Database Migrations

None. No schema changes. Existing collections store scrubbed data instead of raw data.

### Feature Flags

None. Existing `scrubPII` tenant configuration flag (propagated via `createTraceEmitter({ scrubPII })`) controls the behavior. Plan-based defaults: FREE/TEAM=false, BUSINESS/ENTERPRISE=true.

### Configuration Changes

None. No new environment variables or config keys.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All phases complete with exit criteria met
- [ ] `scrubTraceEvent()` scrubs ALL event types passing through `emit()` when `enableScrub=true`
- [ ] Bearer tokens matched mid-string (not just at start)
- [ ] API key patterns detected (AKIA, sk-, pk*live*, ghp*, gho*, abl\_)
- [ ] Secret key names trigger value redaction (password, token, api_key, etc.)
- [ ] Credit card-like sequences (13-19 digits) masked without Luhn validation
- [ ] `scrubPII=false` disables all scrubbing in `emit()`
- [ ] Double-scrubbing for tool_call/llm_call events is idempotent (no garbled output)
- [ ] Scrubbing failure in `emit()` logs warning and emits original event (fail-open)
- [ ] `pnpm build` succeeds across all packages with 0 errors
- [ ] `pnpm test` passes across all packages with 0 regressions
- [ ] All 12+ new unit tests in trace-scrubber.test.ts pass
- [ ] Credit card Luhn test updated and passes in pii-detector.test.ts

---

## 7. Open Questions

1. **`emitToEventStore()` redundancy**: After emit()-level scrubbing via `scrubTraceEvent()`, the separate scrubbing in `emit-to-eventstore.ts` (lines 57-61: `scrubSecrets()` + `redactPIIFn()`) becomes redundant. Should it be removed for simplicity, or kept as defense-in-depth? **Decision: Keep for now** — defense-in-depth is preferred, and removal is a separate refactor concern.

2. **Studio-side masking removal**: The feature spec mentions removing `mask-sensitive-data.ts` from Studio. However, `mask-sensitive-data.ts` does not exist in the codebase (grep returns no results). This phase 4 from the feature spec's delivery plan is already done or was never needed. **Decision: No action needed.**

3. **`scrub-patterns.ts` test coverage**: The shared patterns file may not have dedicated tests. Should we add tests for the new key prefix patterns in a separate `scrub-patterns.test.ts` file, or are the `trace-scrubber.test.ts` tests sufficient? **Decision: Test via trace-scrubber.test.ts** — the patterns are exercised through `scrubTraceEvent()` which uses them.
