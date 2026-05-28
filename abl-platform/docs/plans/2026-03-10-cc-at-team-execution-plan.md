# Call Control & Agent Transfer — Team Execution Plan

**Date:** 2026-03-10
**Goal:** Fix all critical/high bugs with thorough test coverage, audit against all design docs
**Input:** Comprehensive gap analysis (53 gaps, 6 already applied, 47 remaining actionable)

---

## Team Structure

| Agent                | Scope                                                    | Files                                                                    |
| -------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------ |
| **backend-fixes**    | agent-transfer package: Redis, recovery, auth, lifecycle | `packages/agent-transfer/src/**`                                         |
| **runtime-security** | Runtime route auth, validation, tenant isolation         | `apps/runtime/src/routes/agent-transfer-*`, `apps/runtime/src/server.ts` |
| **studio-fixes**     | Studio UI: API routes, components, error handling        | `apps/studio/src/**`                                                     |
| **audit-leader**     | Verify ALL gaps against ALL docs, report remaining       | Read-only review                                                         |

---

## Agent 1: backend-fixes (packages/agent-transfer)

### Critical

None remaining (LUA_UPDATE_SESSION, leader SET XX, auth refresh all applied)

### High

- [ ] **B1** SMEMBERS → SSCAN in `session-recovery-service.ts:204` (batch 100)
- [ ] **B2** Pipeline batching for recovery (HMGET + EXISTS in batches, not sequential)
- [ ] **B3** extendTTL channel hint — accept optional channel param, skip HGETALL when provided
- [ ] **B4** Cross-pod timeout cancel — use BullMQ `queue.remove(deterministic-jobId)` directly
- [ ] **B5** getActiveSessions tenant isolation — add tenantId param, use per-tenant set or SSCAN+filter

### Medium

- [ ] **B6** SmartAssist pool configurable (remove hardcoded `connections: 50`)
- [ ] **B7** Graceful shutdown DRAIN_TIMEOUT_MS 5s → 15s
- [ ] **B8** Rate limiter ZREMRANGEBYRANK after ZADD (cap sorted set)
- [ ] **B9** Boot defer recovery scan (async after server listening)
- [ ] **B10** CsatHandler csatStartedAt string → number
- [ ] **B11** Dead letter tenant isolation (namespace keys per tenant)
- [ ] **B12** SdkNotificationQueue dead letter integration
- [ ] **B13** forceEvictOldest O(N) sort → Map iteration

### Tests Required

- SSCAN with >100 sessions mock
- Recovery pipeline batch correctness
- extendTTL with/without channel hint
- Cross-pod cancel simulation
- Tenant-scoped getActiveSessions
- Rate limiter cap enforcement
- Graceful shutdown drain timing

---

## Agent 2: runtime-security (apps/runtime)

### Critical

- [ ] **R1** Auth middleware on agent-transfer-sessions.ts route
- [ ] **R2** Auth middleware on agent-transfer-settings.ts route
- [ ] **R3** Schema validation on PUT /settings body
- [ ] **R4** Register routes in server.ts (if not already)

### High

- [ ] **R5** Tenant-scoped session list (filter at query level, not in-memory)
- [ ] **R6** Webhook per-provider secret config lookup

### Tests Required

- 401 without auth on all agent-transfer endpoints
- 403 without correct project permission
- 400 on invalid PUT /settings body
- Tenant isolation: tenant A cannot see tenant B sessions
- Webhook signature verification per-provider

---

## Agent 3: studio-fixes (apps/studio)

### Critical

- [ ] **S1** Create endTransferSession API route (`api/projects/[id]/agent-transfer/sessions/[sessionId]/end/route.ts`)
- [ ] **S2** Voice config flat → nested restructure (match backend VoiceGatewayConfigSchema)

### High

- [ ] **S3** TTL unit conversion (×60 on save, ÷60 on load)
- [ ] **S4** Priority enum: `normal/urgent` → `medium/critical` to match IR
- [ ] **S5** Provider filter: remove nice/five9, add salesforce/servicenow/generic
- [ ] **S6** handleEndSession catch block + toast.error
- [ ] **S7** handleReset catch block + toast.error + immediate local state sync
- [ ] **S8** Channel column in sessions table
- [ ] **S9** Search/pagination on TransferSessionsPage
- [ ] **S10** Voice transfer sub-editor in EscalationEditor (transfer method, SIP headers)
- [ ] **S11** Session detail modal: add missing fields (CSAT, disposition, ownerPod, heartbeat, TTL)
- [ ] **S12** End Session button in detail modal
- [ ] **S13** Agent transfer settings dedicated API route (GET+PUT)

### Medium

- [ ] **S14** Empty state with link to settings-agent-transfer
- [ ] **S15** Error state with sanitizeError + retry
- [ ] **S16** Live duration display (setInterval 1000ms)
- [ ] **S17** Loading skeleton for sessions table
- [ ] **S18** Default status filter excludes ended sessions

### Tests Required

- endSession API route returns 200 on valid call
- Voice config round-trip (save nested, load displays flat)
- TTL round-trip (30 min → 1800 seconds → 30 min)
- Priority round-trip (medium/critical preserved)
- Provider filter matches adapter registry
- Error handling: verify toast appears on failures

---

## Agent 4: audit-leader

### Audit Checklist

1. Read ALL design docs (callflow-agent-desktop-design, studio-agent-transfer-design, gap-analysis, critical-fixes-plan, call-control-findings-plan)
2. For EACH gap in the comprehensive analysis, verify:
   - Code change exists and is correct
   - Test exists and covers the fix
   - No regressions introduced
3. Run full test suites: `packages/agent-transfer`, `apps/runtime` (if buildable)
4. Report remaining gaps with severity
5. Verify zero CRITICAL gaps remain

---

## Success Criteria

- [ ] All 4 CRITICAL gaps fixed with tests
- [ ] All HIGH bug-fix gaps fixed with tests
- [ ] All MEDIUM straightforward fixes applied
- [ ] Full test suites pass
- [ ] Audit confirms zero CRITICAL/HIGH gaps remain
- [ ] Code formatted with prettier
