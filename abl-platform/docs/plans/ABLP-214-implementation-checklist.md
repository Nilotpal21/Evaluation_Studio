# ABLP-214 Implementation Checklist

Quick reference for implementing Runtime masking.

---

## Pre-Implementation

- [ ] Read full implementation plan: `2026-04-08-ablp-214-runtime-masking-implementation-plan.md`
- [ ] Get team approval for approach
- [ ] Decide on open questions (audit logging, whitelists, rollout strategy)
- [ ] Create Jira subtasks for each phase

---

## Phase 1: Enhance trace-scrubber.ts

### Files to Modify:

- [ ] `packages/compiler/src/platform/constructs/executors/trace-scrubber.ts`
- [ ] `packages/compiler/src/__tests__/constructs/trace-scrubber.test.ts`

### Changes:

- [ ] Add `apiKey` pattern
- [ ] Add `keyPrefix` pattern
- [ ] Add `SECRET_KEY_PATTERNS` array
- [ ] Add `isSecretKey()` function
- [ ] Update `scrubString()` to apply all patterns
- [ ] Export new `scrubTraceEvent()` function
- [ ] Fix Bearer token regex (remove ^ anchor)

### Testing:

- [ ] Run: `pnpm --filter @abl/compiler test src/__tests__/constructs/trace-scrubber.test.ts`
- [ ] Update test: Bearer token expects "Bearer [REDACTED]"
- [ ] Add test: API key masking
- [ ] Add test: Key prefix masking
- [ ] Add test: Secret key name detection

---

## Phase 2: Stricter Credit Card Masking

### Files to Modify:

- [ ] `packages/compiler/src/platform/security/pii-detector.ts`
- [ ] `packages/compiler/src/__tests__/security/pii-detector.test.ts`

### Changes:

- [ ] Update credit_card regex to `/\b\d(?:[ -]*\d){12,18}\b/g`
- [ ] Remove Luhn validation
- [ ] Update comment: "Mask ALL 13-19 digit sequences"

### Testing:

- [ ] Run: `pnpm --filter @abl/compiler test src/__tests__/security/pii-detector.test.ts`
- [ ] Rename test: "detects all 13-19 digit sequences (stricter policy)"
- [ ] Change assertion: `toHaveLength(1)` instead of `toHaveLength(0)`

---

## Phase 3: Apply Universal Scrubbing

### Files to Modify:

- [ ] `apps/runtime/src/services/trace-emitter.ts`

### Changes:

- [ ] Add import: `import { scrubTraceEvent } from '@abl/compiler';`
- [ ] In `emit()` function (line ~116):
  - [ ] Scrub event.data before creating storedEvent
  - [ ] Use scrubbed version for MongoDB/WebSocket/ClickHouse

### Testing:

- [ ] Create: `apps/runtime/src/__tests__/trace-emitter-masking.test.ts`
- [ ] Test: API keys masked in decision events
- [ ] Test: Credit cards masked in LLM responses
- [ ] Test: Emails masked in error messages
- [ ] Test: Password fields masked by key name
- [ ] Run: `pnpm --filter @agent-platform/runtime test`

---

## Phase 4: Remove Studio Masking

### Files to Delete:

- [ ] `apps/studio/src/utils/mask-sensitive-data.ts`
- [ ] `apps/studio/src/__tests__/mask-sensitive-data.test.ts`
- [ ] `apps/studio/src/__tests__/components/DebugTabs-deprecated-badge.test.ts`

### Files to Revert:

- [ ] `apps/studio/src/components/observatory/interactions/ToolCallContent.tsx`
- [ ] `apps/studio/src/components/observatory/interactions/DecisionContent.tsx`
- [ ] `apps/studio/src/components/observatory/interactions/RawEventBlock.tsx`
- [ ] `apps/studio/src/components/ui/JsonViewer.tsx`
- [ ] `apps/studio/src/components/observatory/LLMCallCard.tsx`
- [ ] `apps/studio/src/components/observatory/NodeDetailPanel.tsx`

### Commands:

```bash
# Find masking-related commits
git log --oneline --grep="mask"

# Revert commits
git revert <commit-hash-1> <commit-hash-2> <commit-hash-3>
```

### Testing:

- [ ] Run: `pnpm --filter @agent-platform/studio build`
- [ ] Verify: No import errors
- [ ] Verify: Studio UI still displays traces correctly

---

## E2E Verification

### Manual Testing:

- [ ] Start local: `apx up`
- [ ] Create test agent with sensitive data:
  - [ ] API key: `api_key=sk-test123456789`
  - [ ] Credit card: `4111-1111-1111-1111`
  - [ ] Email: `test@example.com`
  - [ ] Password field: `{ password: "secret" }`
- [ ] Send message and verify masking in:
  - [ ] Studio Interactions tab
  - [ ] Studio Traces tab
  - [ ] Studio Response section

### Database Verification:

- [ ] MongoDB: Check `db.sessions.findOne()` for masked data
- [ ] ClickHouse: Check `SELECT * FROM platform_events` for masked data
- [ ] Logs: Check `docker logs abl-runtime-1` for no secrets

---

## Pre-Commit Checks

- [ ] All unit tests pass: `pnpm test`
- [ ] Build succeeds: `pnpm build`
- [ ] Prettier formatted: `npx prettier --write <files>`
- [ ] No console.log statements
- [ ] No TypeScript errors: `pnpm typecheck`
- [ ] Commit message follows convention: `[ABLP-214] fix(runtime): implement universal trace event masking`

---

## Pull Request

- [ ] Create PR with all changes
- [ ] Link to Jira: ABLP-214
- [ ] Reference implementation plan in PR description
- [ ] Add screenshots of masked data in Studio
- [ ] Request review from security team
- [ ] Verify CI/CD pipeline passes

---

## Post-Merge

- [ ] Deploy to staging
- [ ] Run E2E verification on staging
- [ ] Monitor logs for errors
- [ ] Deploy to production
- [ ] Monitor production for 24 hours
- [ ] Mark ABLP-214 as Done

---

## Rollback (If Needed)

- [ ] Option 1: Disable via config: `{ security: { scrubPII: false } }`
- [ ] Option 2: `git revert <commit-hash>`
- [ ] Option 3: Feature flag: `ENABLE_UNIVERSAL_SCRUBBING=false`

---

## Estimated Time Per Phase

| Phase     | Time     |
| --------- | -------- |
| Phase 1   | 1.5h     |
| Phase 2   | 0.5h     |
| Phase 3   | 1h       |
| Phase 4   | 0.5h     |
| Testing   | 1h       |
| E2E       | 0.5h     |
| PR        | 0.5h     |
| **Total** | **5.5h** |
