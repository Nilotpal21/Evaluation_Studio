# ABLP-214: Runtime Sensitive Data Masking - Implementation Plan

**Date:** 2026-04-08
**Branch:** KI0326/bugfixes
**Priority:** P0 - Security Issue
**Estimated Effort:** 4-6 hours

---

## Problem Statement

**Current State:**
Sensitive data (API keys, credit cards, emails, passwords) is:

- ❌ Stored UNMASKED in MongoDB
- ❌ Stored UNMASKED in ClickHouse
- ❌ Transmitted UNMASKED over WebSocket
- ❌ Logged UNMASKED in server logs
- ✅ Only masked in Studio UI (too late - data already leaked)

**Root Cause:**
Runtime's `trace-emitter.ts` emit() function does NOT scrub events before storage/transmission.
Only tool_call events are scrubbed (lines 203, 232), but decision/LLM response/error events are not.

**Security Impact:**

- Compliance violation (PII exposure)
- Potential credential leakage in logs/observability
- Data breach if database is compromised

---

## Solution Overview

### Universal Scrubbing at Emission Point

Scrub ALL trace events in the `emit()` function BEFORE:

- Writing to MongoDB (TraceStore)
- Sending over WebSocket
- Writing to ClickHouse (EventStore)
- Logging to stdout/files

```
┌─────────────┐
│ Trace Event │
└──────┬──────┘
       │
       ▼
┌─────────────────┐
│ emit() function │ ◄─── SCRUB HERE (Universal Layer)
└──────┬──────────┘
       │
       ├──► MongoDB (masked)
       ├──► ClickHouse (masked)
       ├──► WebSocket (masked)
       └──► Logs (masked)
```

---

## Implementation Phases

### Phase 1: Enhance trace-scrubber.ts Patterns

**File:** `packages/compiler/src/platform/constructs/executors/trace-scrubber.ts`

**Add Missing Patterns:**

```typescript
const SECRET_PATTERNS = {
  // Existing (keep as-is)
  bearerToken: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, // Fix: remove ^ anchor
  secretsTemplate: /\{\{secrets\.\w+\}\}/g,

  // NEW patterns to add
  apiKey:
    /(?:api[_-]?key|apikey|api[_-]?secret|secret[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["']?([A-Za-z0-9\-._~+/]{20,})["']?/gi,
  keyPrefix:
    /\b(sk-[a-zA-Z0-9]{20,}|pk-[a-zA-Z0-9]{20,}|abl_[a-z]+_[a-zA-Z0-9]{16,}|ghp_[a-zA-Z0-9]{36}|gho_[a-zA-Z0-9]{36})\b/g,
};

const SECRET_KEY_PATTERNS = [
  'password',
  'secret',
  'token',
  'api_key',
  'apikey',
  'api-key',
  'auth',
  'credential',
  'private_key',
  'privatekey',
  'access_key',
  'accesskey',
  'client_secret',
  'clientsecret',
];

function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SECRET_KEY_PATTERNS.some((p) => lower.includes(p));
}
```

**Update `scrubString()` to apply all patterns:**

```typescript
function scrubString(value: string, key?: string): string {
  // Check key name first (password, token, etc.)
  if (key && SENSITIVE_HEADERS.has(key.toLowerCase())) return REDACTED;
  if (key && isSecretKey(key)) return REDACTED;

  // Apply all patterns
  let result = value;
  result = result.replace(SECRET_PATTERNS.bearerToken, () => `Bearer ${REDACTED}`);
  result = result.replace(SECRET_PATTERNS.secretsTemplate, () => REDACTED);
  result = result.replace(SECRET_PATTERNS.apiKey, (match, key) => match.replace(key, REDACTED));
  result = result.replace(SECRET_PATTERNS.keyPrefix, () => REDACTED);

  // PII detection (email, phone, SSN, credit cards)
  result = redactPII(result);

  return result;
}
```

**Add new export:**

```typescript
/**
 * Scrub an entire trace event (deep recursive scrub of all fields)
 */
export function scrubTraceEvent(event: Record<string, unknown>): Record<string, unknown> {
  return scrubValue(event) as Record<string, unknown>;
}
```

**Files to Modify:**

- ✅ `packages/compiler/src/platform/constructs/executors/trace-scrubber.ts`

**Tests to Update:**

- ✅ `packages/compiler/src/__tests__/constructs/trace-scrubber.test.ts`
  - Update existing tests for Bearer token (expect "Bearer [REDACTED]")
  - Add tests for API keys
  - Add tests for key prefixes
  - Add tests for secret key names

---

### Phase 2: Stricter Credit Card Masking in PII Detector

**File:** `packages/compiler/src/platform/security/pii-detector.ts`

**Current Issue:**
Only masks Luhn-valid credit cards. Invalid numbers like `4111-1111-1111-1112` leak through.

**Change:**

```typescript
// Line 64-70 - BEFORE
{
  type: 'credit_card',
  regex: /\b(\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4})\b/g,
  redactLabel: '[REDACTED_CARD]',
  validate: (match: string) => luhnCheck(match.replace(/[\s-]/g, '')),
},

// AFTER (stricter)
{
  type: 'credit_card',
  // Mask ALL 13-19 digit sequences (with optional separators)
  regex: /\b\d(?:[ -]*\d){12,18}\b/g,
  redactLabel: '[REDACTED_CARD]',
  // No validation - mask everything that looks like a card number
},
```

**Files to Modify:**

- ✅ `packages/compiler/src/platform/security/pii-detector.ts`

**Tests to Update:**

- ✅ `packages/compiler/src/__tests__/security/pii-detector.test.ts`
  - Rename test: "does not detect card number that fails Luhn check" → "detects all 13-19 digit sequences (stricter policy)"
  - Change assertion: `expect(ccDetections).toHaveLength(0)` → `expect(ccDetections).toHaveLength(1)`

---

### Phase 3: Apply Universal Scrubbing in trace-emitter.ts

**File:** `apps/runtime/src/services/trace-emitter.ts`

**Current `emit()` function (lines 116-158):**

```typescript
function emit(event: TraceEvent): TraceEventWithId | undefined {
  const storedEvent: TraceEventWithId = {
    ...event, // ❌ UNMASKED
    id: crypto.randomUUID(),
    sessionId,
    // ... enrichment
  };

  getTraceStore().addEvent(sessionId, storedEvent); // ❌ UNMASKED to MongoDB
  ws.send(JSON.stringify({ event: storedEvent })); // ❌ UNMASKED to WebSocket
  emitToEventStore(...storedEvent); // ❌ UNMASKED to ClickHouse

  return storedEvent;
}
```

**New `emit()` with universal scrubbing:**

```typescript
import { scrubTraceEvent } from '@abl/compiler'; // ADD import at top

function emit(event: TraceEvent): TraceEventWithId | undefined {
  // ✅ SCRUB FIRST - before anything else (if enabled)
  const scrubbedEventData = enableScrub ? scrubTraceEvent(event.data ?? {}) : (event.data ?? {});

  const scrubbedEvent: TraceEvent = {
    ...event,
    data: scrubbedEventData,
  };

  // Enrich with module provenance
  const provenance =
    event.agentName && moduleProvenanceMap ? moduleProvenanceMap[event.agentName] : undefined;

  const storedEvent: TraceEventWithId = {
    ...scrubbedEvent, // ✅ Now using scrubbed version
    id: crypto.randomUUID(),
    sessionId,
    ...(deploymentId && { deploymentId }),
    ...(environment && { environment }),
    ...(agentVersions && { agentVersions }),
    ...(provenance && {
      moduleAlias: provenance.alias,
      moduleProjectId: provenance.moduleProjectId,
      moduleReleaseId: provenance.moduleReleaseId,
      sourceAgentName: provenance.sourceAgentName,
    }),
  };

  // All downstream consumers now get masked data
  getTraceStore().addEvent(sessionId, storedEvent); // ✅ MASKED to MongoDB

  const message: ServerMessage = {
    type: 'trace_event',
    sessionId,
    event: storedEvent,
  };

  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message)); // ✅ MASKED to WebSocket
  }

  if (tenantId) {
    const eventStore = getEventStore();
    if (eventStore) {
      emitToEventStore({
        eventStore,
        event: storedEvent, // ✅ MASKED to ClickHouse
        // ... rest
      });
    }
  }

  return storedEvent;
}
```

**Files to Modify:**

- ✅ `apps/runtime/src/services/trace-emitter.ts`

**Critical:** Add import at top of file:

```typescript
import { scrubTraceEvent } from '@abl/compiler';
```

---

### Phase 4: Remove Redundant Studio Masking

**Files to Revert/Delete:**

1. **DELETE:** `apps/studio/src/utils/mask-sensitive-data.ts`
2. **DELETE:** `apps/studio/src/__tests__/mask-sensitive-data.test.ts`
3. **DELETE:** `apps/studio/src/__tests__/components/DebugTabs-deprecated-badge.test.ts`

4. **REVERT changes in:**
   - `apps/studio/src/components/observatory/interactions/ToolCallContent.tsx`
   - `apps/studio/src/components/observatory/interactions/DecisionContent.tsx`
   - `apps/studio/src/components/observatory/interactions/RawEventBlock.tsx`
   - `apps/studio/src/components/ui/JsonViewer.tsx`
   - `apps/studio/src/components/observatory/LLMCallCard.tsx`
   - `apps/studio/src/components/observatory/NodeDetailPanel.tsx`

**Commands:**

```bash
# Revert Studio commits
git log --oneline | grep "mask-sensitive-data\|masking"  # Find commit hashes
git revert <commit-hash-1> <commit-hash-2> <commit-hash-3>

# Or reset to before masking commits
git reset --hard <commit-before-masking>
```

---

## Testing Strategy

### Unit Tests

**Compiler Package:**

```bash
# Run trace-scrubber tests
pnpm --filter @abl/compiler test src/__tests__/constructs/trace-scrubber.test.ts

# Run PII detector tests
pnpm --filter @abl/compiler test src/__tests__/security/pii-detector.test.ts
```

**Expected Results:**

- ✅ All existing tests pass with updated assertions
- ✅ New tests for API keys, key prefixes, secret key names pass

---

### Integration Tests

**Runtime Package:**

Create new test: `apps/runtime/src/__tests__/trace-emitter-masking.test.ts`

```typescript
describe('Trace Emitter - Sensitive Data Masking', () => {
  it('masks API keys in decision events', async () => {
    const emitter = createTraceEmitter({
      sessionId: 'test',
      ws: mockWs,
      scrubPII: true,
    });

    emitter.emit({
      type: 'decision',
      timestamp: new Date(),
      data: {
        reasoning: 'Using api_key=sk-1234567890abcdefghijk',
      },
    });

    const sentMessage = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sentMessage.event.data.reasoning).toContain('[REDACTED]');
    expect(sentMessage.event.data.reasoning).not.toContain('sk-1234567890');
  });

  it('masks credit cards in LLM responses', async () => {
    // Test with card: 4111-1111-1111-1111
    // Verify it's [REDACTED_CARD]
  });

  it('masks emails in error messages', async () => {
    // Test with email: user@example.com
    // Verify it's [REDACTED_EMAIL]
  });

  it('masks password fields by key name', async () => {
    emitter.emit({
      type: 'tool_call',
      data: {
        input: { password: 'supersecret123', username: 'john' },
      },
    });

    const sent = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sent.event.data.input.password).toBe('[REDACTED]');
    expect(sent.event.data.input.username).toBe('john');
  });
});
```

---

### E2E Verification

**Manual Testing Checklist:**

1. **Start local Runtime + Studio:**

   ```bash
   apx up
   ```

2. **Create test agent with sensitive data:**

   ```abl
   agent TestMasking {
     on_message {
       RESPOND "Testing: api_key=sk-test123456789, card=4111-1111-1111-1111, email=test@example.com"
     }
   }
   ```

3. **Send message and verify in Studio UI:**
   - ✅ Interactions tab shows `[REDACTED]` for API key
   - ✅ Traces tab shows `[REDACTED_CARD]` for credit card
   - ✅ Response shows `[REDACTED_EMAIL]` for email

4. **Verify in MongoDB:**

   ```bash
   mongosh
   use agent-platform
   db.sessions.findOne({ _id: ObjectId('...') })
   ```

   - ✅ Conversation history has masked data
   - ✅ Tool call inputs/outputs masked

5. **Verify in ClickHouse:**

   ```sql
   SELECT * FROM platform_events WHERE session_id = 'xxx' LIMIT 10;
   ```

   - ✅ All events have masked data in `data` field

6. **Check server logs:**

   ```bash
   docker logs abl-runtime-1 | grep "api_key\|sk-"
   ```

   - ✅ No unmasked secrets in logs

---

## Rollback Plan

### If Issues Found in Production:

**Option 1: Disable scrubbing via tenant config**

```typescript
// In tenant settings (MongoDB)
{
  security: {
    scrubPII: false;
  }
}
```

This reverts to current behavior (unmasked) immediately.

**Option 2: Revert Git commits**

```bash
git revert <commit-hash-of-this-change>
git push origin KI0326/bugfixes --force
```

**Option 3: Feature flag (if added)**

```typescript
const ENABLE_UNIVERSAL_SCRUBBING = process.env.ENABLE_UNIVERSAL_SCRUBBING === 'true';

const scrubbedEventData =
  enableScrub && ENABLE_UNIVERSAL_SCRUBBING
    ? scrubTraceEvent(event.data ?? {})
    : (event.data ?? {});
```

---

## Performance Considerations

### Impact Analysis:

**Current:** Only tool calls scrubbed (~10% of events)
**After:** ALL events scrubbed (100% of events)

**Overhead per event:**

- String pattern matching: ~0.1-0.5ms
- Deep object traversal: ~0.1-0.3ms
- **Total: ~0.2-0.8ms per event**

**For 1000 events/session:**

- Additional latency: ~200-800ms total
- Per-event: negligible (<1ms)

**Mitigation:**

- Scrubbing is O(n) where n = data size
- Regex patterns are pre-compiled (fast)
- Only runs if `scrubPII: true` (can be disabled)

---

## Security Audit Checklist

Before marking as complete:

- [ ] No secrets stored unmasked in MongoDB
- [ ] No secrets stored unmasked in ClickHouse
- [ ] No secrets transmitted unmasked over WebSocket
- [ ] No secrets in server logs (stdout/files)
- [ ] Masking patterns cover: API keys, credit cards, emails, SSN, phone, Bearer tokens, key prefixes
- [ ] Key name detection works (password, token, api_key fields)
- [ ] All tests pass (unit + integration)
- [ ] E2E manual verification complete
- [ ] Performance impact acceptable (<1ms per event)
- [ ] Rollback plan tested

---

## Definition of Done

### Code Changes:

- ✅ trace-scrubber.ts enhanced with all patterns
- ✅ pii-detector.ts updated for stricter credit cards
- ✅ trace-emitter.ts applies universal scrubbing in emit()
- ✅ Studio masking code removed/reverted
- ✅ All tests updated and passing

### Testing:

- ✅ Unit tests pass (compiler + runtime)
- ✅ Integration tests added and pass
- ✅ E2E manual verification complete
- ✅ MongoDB inspection shows masked data
- ✅ ClickHouse inspection shows masked data
- ✅ WebSocket messages show masked data

### Documentation:

- ✅ This implementation plan created
- ✅ Comments added to scrubTraceEvent() function
- ✅ CLAUDE.md updated (if needed)

### Deployment:

- ✅ PR created with all changes
- ✅ Code review approved
- ✅ CI/CD pipeline passes
- ✅ Merged to develop
- ✅ Deployed to staging
- ✅ Staging verification complete
- ✅ Deployed to production

---

## Timeline Estimate

| Phase                             | Effort        | Dependencies |
| --------------------------------- | ------------- | ------------ |
| Phase 1: Enhance trace-scrubber   | 1.5 hours     | None         |
| Phase 2: PII detector stricter CC | 0.5 hours     | None         |
| Phase 3: Apply in trace-emitter   | 1 hour        | Phase 1      |
| Phase 4: Remove Studio masking    | 0.5 hours     | None         |
| Testing (unit + integration)      | 1 hour        | Phase 1-3    |
| E2E verification                  | 0.5 hours     | All phases   |
| Documentation + PR                | 0.5 hours     | All phases   |
| **Total**                         | **5.5 hours** |              |

**Contingency:** +1 hour for unexpected issues
**Estimated Total:** 6-7 hours

---

## Dependencies

### External:

- None (all changes internal to Runtime/Compiler)

### Internal:

- Phase 3 depends on Phase 1 (scrubTraceEvent export)
- Testing depends on all implementation phases

### Breaking Changes:

- None (backward compatible)
- Existing scrubPII config continues to work
- Default behavior: scrubbing enabled (safer)

---

## Success Metrics

### Before:

- ❌ Sensitive data in MongoDB: **YES (leaked)**
- ❌ Sensitive data in ClickHouse: **YES (leaked)**
- ❌ Sensitive data over WebSocket: **YES (leaked)**
- ❌ Tool calls masked: **YES**
- ❌ Other events masked: **NO**

### After:

- ✅ Sensitive data in MongoDB: **NO (masked)**
- ✅ Sensitive data in ClickHouse: **NO (masked)**
- ✅ Sensitive data over WebSocket: **NO (masked)**
- ✅ Tool calls masked: **YES**
- ✅ Other events masked: **YES**
- ✅ Coverage: **100% of events**

---

## Open Questions

1. **Should we add audit logging for scrubbing actions?**
   - Log when sensitive data is detected and masked?
   - Track pattern match counts for metrics?

2. **Do we need a "whitelist" for certain fields?**
   - Some tool outputs might need to preserve structure
   - Add `skipScrubbing: true` option per event type?

3. **Should scrubbing be gradual rollout?**
   - Start with 10% of tenants, then 50%, then 100%?
   - Or all tenants immediately?

4. **Do we need different scrubbing levels?**
   - Level 1: PII only (email, phone, SSN)
   - Level 2: PII + secrets (API keys, tokens)
   - Level 3: Aggressive (all patterns)

**Decision:** Discuss with team before implementation.

---

## References

- **Jira:** https://koreteam.atlassian.net/browse/ABLP-214
- **PR:** https://bitbucket.org/koreteam1/abl-platform/pull-requests/623
- **Branch:** KI0326/bugfixes
- **Related Files:**
  - `packages/compiler/src/platform/constructs/executors/trace-scrubber.ts`
  - `packages/compiler/src/platform/security/pii-detector.ts`
  - `apps/runtime/src/services/trace-emitter.ts`

---

**Plan Status:** ✅ READY FOR IMPLEMENTATION
**Next Step:** Get approval, then execute Phase 1
