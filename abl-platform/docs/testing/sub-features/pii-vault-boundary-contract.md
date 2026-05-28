# Testing Specification: PII Vault Boundary Contract

**Feature**: [PII Vault Boundary Contract](../../features/sub-features/pii-vault-boundary-contract.md)
**Status**: PARTIAL
**Ticket**: ABLP-535
**Last Updated**: 2026-05-20

---

## Coverage Matrix

| #   | FR        | Scenario                                                                                    | Type        | Status                 | Test File                                                        |
| --- | --------- | ------------------------------------------------------------------------------------------- | ----------- | ---------------------- | ---------------------------------------------------------------- |
| 1   | FR-1,FR-2 | `resolveRenderMode('original')` returns `'original'`                                        | unit        | PASS                   | `pii-vault-boundary.test.ts`                                     |
| 2   | FR-2      | `resolveRenderMode('tools')` returns `'redacted'` (secure default)                          | unit        | PASS                   | `pii-vault-boundary.test.ts`                                     |
| 3   | FR-4      | Bare-UUID detection: false-positive check on non-vault UUIDs                                | unit        | PASS                   | `pii-vault-boundary.test.ts`                                     |
| 4   | FR-4      | Bare-UUID restoration succeeds for current-session vault entries                            | unit        | PASS                   | `pii-vault-boundary.test.ts`                                     |
| 5   | FR-2      | `vault.renderForConsumer(text, 'original')` returns plaintext                               | unit        | PASS                   | `pii-vault-boundary.test.ts`                                     |
| 6   | FR-3      | `normalizeToolPIIAccess('original')` returns `'original'`                                   | unit        | PASS                   | `pii-vault-boundary.test.ts`                                     |
| 7   | FR-3      | `normalizeToolPIIAccess('garbage')` returns `'tools'` (never `'original'`)                  | unit        | PASS                   | `pii-vault-boundary.test.ts`                                     |
| 8   | FR-4      | Bare-UUID restoration only matches UUIDs in current session vault                           | unit        | PASS                   | `pii-vault-boundary.test.ts`                                     |
| 9   | FR-2      | `renderForConsumer` with `'original'` returns plaintext for all entity types                | integration | PASS                   | `pii-vault-boundary.integration.test.ts`                         |
| 10  | FR-5      | `'original'` plaintext dispense emits audit log entry via PIIAuditLogger                    | integration | PASS (prereq)          | `pii-vault-boundary.integration.test.ts` (INT-2/INT-3)           |
| 11  | FR-5      | `'original'` plaintext dispense emits `pii_plaintext_dispensed` trace event                 | integration | PASS (prereq)          | `pii-vault-boundary.integration.test.ts` (INT-2/INT-3)           |
| 12  | FR-2      | `vault.renderForConsumer(text, 'tools')` returns `[REDACTED_*]`                             | integration | PASS                   | `pii-vault-boundary.integration.test.ts`                         |
| 13  | FR-4      | Session var with PII token restored at configured access level via tool context_access.read | integration | PASS (via composition) | `pii-vault-boundary.integration.test.ts`                         |
| 14  | FR-8      | `pii-patterns` route uses `requireProjectPermission` — cross-project denied                 | e2e         | PASS                   | `pii-vault-boundary.e2e.test.ts` (E2E-6a/6b)                     |
| 15  | FR-1-FR-5 | PII in user input tokenized before LLM                                                      | e2e         | PASS                   | `pii-vault-boundary.e2e.test.ts` (E2E-1)                         |
| 16  | FR-2      | PII in LLM output masked for user                                                           | e2e         | PASS                   | `pii-vault-boundary.e2e.test.ts` (E2E-2)                         |
| 17  | FR-4      | Bare-UUID restoration: LLM strips `{{PII:...}}` wrapper → tool still gets correct value     | e2e         | COVERED (INT)          | `pii-vault-boundary.integration.test.ts` (INT-4)                 |
| 18  | FR-4      | Cross-session isolation: bare UUID from session A not restored in session B                 | e2e         | PASS                   | `pii-vault-boundary.e2e.test.ts` (E2E-4)                         |
| 19  | FR-7      | Tool Test UI uses same restorePIITokensForToolExecution path                                | integration | PASS (arch)            | Same function reused — architectural parity                      |
| 20  | FR-8      | RBAC: PII pattern access denied cross-tenant via HTTP                                       | e2e         | PASS                   | `pii-vault-boundary.e2e.test.ts` (E2E-6b)                        |
| 21  | ---       | Masking of original: user sees masked plaintext, not masked token UUID                      | unit        | PASS                   | `pii-vault-boundary.test.ts`                                     |
| 22  | FR-9      | Existing broken-behavior tests updated with ABLP-535 closure comments                       | unit        | PASS                   | `session-pii-vault.test.ts`, `reported-pii-masking-gaps.test.ts` |
| 23  | R1        | `renderForConsumerWithTrace` returns only substituted tokens (0/1/N tokens, bare-UUID)      | unit        | PASS                   | `pii-vault-boundary.test.ts`                                     |
| 24  | R1        | `renderForConsumerWithTrace` parity with `renderForConsumer` (same rendered text)           | unit        | PASS                   | `pii-vault-boundary.test.ts`                                     |
| 25  | R1        | `renderForConsumerWithTrace` defensive copies (modify does not affect vault)                | unit        | PASS                   | `pii-vault-boundary.test.ts`                                     |
| 26  | R1        | `dispensedTokens` precision: only tokens in rendered args, not all vault tokens             | integration | PASS                   | `pii-vault-boundary.integration.test.ts`                         |
| 27  | R1        | `dispensedTokens` accumulates across nested object leaves                                   | integration | PASS                   | `pii-vault-boundary.integration.test.ts`                         |
| 28  | R1        | `dispensedTokens` includes bare-UUID hits                                                   | integration | PASS                   | `pii-vault-boundary.integration.test.ts`                         |
| 29  | R1        | `dispensedTokens` empty when session has no vault                                           | integration | PASS                   | `pii-vault-boundary.integration.test.ts`                         |
| 30  | R2        | Deep tokenization: flat string, nested object, nested array, mixed, cycle, scalar passthru  | unit        | PASS                   | `pii-vault-boundary.test.ts`                                     |
| 31  | R2        | Nested tokenization + rendering round-trip (tokenize nested → render per piiAccess)         | integration | PASS                   | `pii-vault-boundary.integration.test.ts`                         |
| 32  | R2        | Non-string scalars in nested structures pass through unmodified                             | integration | PASS                   | `pii-vault-boundary.integration.test.ts`                         |

**Totals**: 57 unit + 32 integration + 2 call-site-invariant + 10 E2E = 101 test cases (was 73; +19 meta-review unit, +3 meta-review integration, +2 invariant, +4 E2E precision)

**Coverage gaps acknowledged**: Scenarios 10/11 (audit event content assertion) tested at prerequisite level (vault returns plaintext + dispensedTokens available for hashing). Full trace event interception requires stateful mock LLM E2E. Scenario 17 covered at integration level (INT-4) rather than E2E level. R1 audit precision is now tested at integration level (dispensedTokens count assertion); full E2E assertion of exact `pii_plaintext_dispensed` event count remains covered by existing E2E-1. Workflow safety-net detection (DFA-M2) has no automated test. See `docs/sdlc-logs/pii-vault-boundary-contract/pr-review.log.md` and `data-flow-audit.md` for details.

---

## Unit Tests

### U-1: resolveRenderMode with 'original' consumer

**File**: `apps/runtime/src/__tests__/pii-vault-boundary.test.ts`
**Covers**: FR-1, FR-2

```
Given: resolveRenderMode called with consumer='original', no pattern configs
When: function executes
Then: returns 'original'
Verify: Direct function call assertion
```

### U-2: resolveRenderMode — all consumer defaults unchanged

**Covers**: FR-2 (regression)

```
Given: resolveRenderMode called with each built-in consumer
Then:
  - 'tools' → 'redacted'
  - 'user' → 'masked'
  - 'logs' → 'redacted'
  - 'llm' → 'tokenized'
  - 'admin' → 'redacted'
  - 'system' → 'redacted'
  - unknown → 'redacted'
```

### U-3: normalizeToolPIIAccess accepts 'original'

**Covers**: FR-3

```
Given: normalizeToolPIIAccess('original')
Then: returns 'original'

Given: normalizeToolPIIAccess('garbage')
Then: returns 'tools'

Given: normalizeToolPIIAccess(undefined)
Then: returns 'tools'

Given: normalizeToolPIIAccess(null)
Then: returns 'tools'
```

### U-4: Bare-UUID false-positive check

**Covers**: FR-4

```
Given: vault has token with UUID 'abc-123'
And: text contains UUIDs 'abc-123' and 'xyz-789' (not in vault)
When: renderForConsumer is called with consumer='original'
Then: 'abc-123' is restored to plaintext
And: 'xyz-789' passes through unchanged
```

### U-5: Bare-UUID restoration for vault entries

**Covers**: FR-4

```
Given: vault tokenizes "My SSN is 123-45-6789"
And: tokenized text is {{PII:ssn:<uuid>}}
When: LLM strips wrapper, text becomes just <uuid>
And: renderForConsumer called with bare UUID text and consumer='original'
Then: <uuid> is restored to '123-45-6789'
```

### U-6: renderForConsumer with 'original' returns plaintext

**Covers**: FR-2

```
Given: vault has tokenized SSN
When: renderForConsumer(tokenized, 'original')
Then: returns original plaintext 'My SSN is 123-45-6789'
```

### U-7: Masking of original value (not token UUID)

**Covers**: FR-2

```
Given: vault tokenizes phone number '+1-555-867-5309'
When: renderForConsumer(tokenized, 'user')
Then: returns masked original '***-***-****' (not masked UUID)
```

### U-8: Pattern-level consumerAccess override takes precedence

**Covers**: FR-2

```
Given: patternConfigs with consumerAccess [{consumer:'original', renderMode:'redacted'}]
When: resolveRenderMode('original', 'ssn', patternConfigs)
Then: returns 'redacted' (override wins over builtin)
```

### U-9: Existing tests updated with ABLP-535 comments

**Covers**: FR-9

```
Given: session-pii-vault.test.ts line 88
Then: comment documents this tests the secure default ('tools' → redacted)

Given: reported-pii-masking-gaps.test.ts line 1083
Then: comment documents ABLP-535 closure
```

---

## Integration Tests

### INT-1: renderForConsumer 'original' returns plaintext for all PII types

**File**: `apps/runtime/src/__tests__/pii-vault-boundary.integration.test.ts`
**Covers**: FR-2

```
Given: vault tokenizes SSN, phone, email, credit card
When: renderForConsumer(tokenized, 'original') for each
Then: each returns the original plaintext
```

### INT-2: Audit log entry on 'original' dispense

**Covers**: FR-5

```
Given: session with vault, tool with pii_access='original'
When: restorePIITokensForToolExecution called
Then: PIIAuditLogger.log() is called with:
  - consumer: 'original'
  - action: 'plaintext_dispensed'
  - piiType matches the entity type
  - entityHash is SHA-256 of original value
```

### INT-3: Trace event emission on 'original' dispense

**Covers**: FR-5

```
Given: session with vault, reasoning-executor dispatches tool call with pii_access='original'
When: tool execution occurs
Then: onTraceEvent called with type='pii_plaintext_dispensed'
And: data includes tenantId, projectId, sessionId, toolName, entityType, entityHash
```

### INT-4: Session var PII restoration at configured access level

**Covers**: FR-4

```
Given: session with tool.context_access.read = ['customer_phone']
And: session.data.values.customer_phone = '{{PII:phone:<uuid>}}'
And: tool.pii_access = 'original'
When: reasoning-executor injects context vars
Then: executionInput._context.customer_phone = original phone number
```

### INT-5: normalizeToolPIIAccess integration with restorePIITokensForToolExecution

**Covers**: FR-3

```
Given: session with vault, tool with pii_access='original'
When: restorePIITokensForToolExecution(session, tokenized, {piiAccess: 'original'})
Then: returns plaintext

Given: piiAccess='garbage'
Then: returns redacted (normalizes to 'tools')
```

### INT-6: pii-patterns route project-scoped RBAC

**Covers**: FR-8

```
Given: pii-patterns route middleware chain
When: request with projectId A tries to access pattern in projectId B
Then: 404 (cross-scope)
```

---

## E2E Tests

### E2E-1: Full Round-Trip — Original Access

**File**: `apps/runtime/src/__tests__/pii-vault-boundary.e2e.test.ts`
**Covers**: FR-1, FR-2, FR-3, FR-5

```
1. Bootstrap project with agent, tool configured pii_access='original'
2. POST /chat — user message with SSN "My SSN is 123-45-6789"
3. Mock LLM receives tokenized context {{PII:ssn:<uuid>}}
4. Mock LLM emits tool call with tokenized arg
5. Assert tool executor receives plaintext '123-45-6789'
6. Assert pii_plaintext_dispensed trace event emitted
7. Assert user response contains masked '***-**-****'
```

### E2E-2: Full Round-Trip — Redacted Access (Default)

**Covers**: FR-2, FR-3

```
1. Bootstrap project with agent, tool with no pii_access (defaults to 'tools')
2. POST /chat — user message with PII
3. Mock LLM emits tool call
4. Assert tool executor receives [REDACTED_SSN]
5. Assert NO pii_plaintext_dispensed trace event
```

### E2E-3: Bare-UUID Restoration

**Covers**: FR-4

```
1. Bootstrap project, tool with pii_access='original'
2. User sends PII, LLM gets tokenized
3. Mock LLM strips {{PII:...}} wrapper, emits bare UUID in tool args
4. Assert tool receives correct plaintext (bare-UUID restoration triggered)
```

### E2E-4: Cross-Session Bare-UUID Isolation

**Covers**: FR-4 (negative)

```
1. Session A: tokenize PII, capture UUID from vault
2. Session B: mock LLM emits tool call with Session A's UUID
3. Assert Session B tool receives UUID unchanged (not restored)
```

### E2E-5: Tool Test UI Parity

**Covers**: FR-7

```
1. POST /api/projects/:projectId/tools/:toolName/test with PII params
2. Assert response reflects PII rendering per configured access level
3. Compare with live execution result — must match
```

### E2E-6: RBAC — PII Patterns Cross-Project Isolation

**Covers**: FR-8

```
1. Create PII pattern in project A
2. GET /api/projects/:projectB/pii-patterns — assert 404 or empty
3. GET /api/projects/:projectA/pii-patterns — assert 200 with pattern
```

---

## Negative / Edge-Case Tests

### NEG-1: Unrecognized pii_access normalizes to 'tools'

```
Given: tool with pii_access='invalid_value'
When: normalizeToolPIIAccess called
Then: returns 'tools' (redacted), NEVER 'original'
```

### NEG-2: Vault empty — text passes through

```
Given: empty vault
When: renderForConsumer called
Then: text returned unchanged
```

### NEG-3: Bare UUID not in vault — passes through

```
Given: vault has no entries
When: text contains random UUID
Then: UUID passes through unchanged in output
```

### NEG-4: LLM consumer forced to 'tokenized'

```
Given: any configuration
When: resolveRenderMode('llm', ...)
Then: ALWAYS returns 'tokenized', never 'original'
```

### NEG-5: Cross-session vault isolation

```
Given: vault A has token abc-123
And: vault B has no entries
When: vault B processes text containing 'abc-123'
Then: 'abc-123' passes through unchanged
```

---

## Production Wiring Verification

| Wiring Point                                     | Verification Method                                              |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| `resolveRenderMode('original')` path reachable   | E2E-1: tool configured with pii_access='original' gets plaintext |
| `pii_plaintext_dispensed` trace event registered | Build succeeds (TypeScript catches missing registry entries)     |
| Studio UI dropdown includes 'original' option    | Manual + build verification (i18n key exists)                    |
| Tool Test route wired with PII context           | E2E-5: Tool Test API returns PII-rendered result                 |

---

## Notes

- E2E tests use `RuntimeApiHarness` (in-process Express + MongoMemoryServer), not mocked components
- LLM is mocked via DI (external third-party, allowed per test architecture rules)
- Tool executor results asserted via HTTP API response (no direct DB access)
- All tests run without `vi.mock` of platform components per CLAUDE.md rules
- SHA-256 hash in audit events verified by computing expected hash from known input
