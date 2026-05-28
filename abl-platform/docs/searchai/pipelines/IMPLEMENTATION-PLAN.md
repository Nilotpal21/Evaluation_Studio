# Pipeline Implementation Plan

**Date:** 2026-03-08
**Status:** Ready for Development
**Total Tasks:** 20 implementation tasks (organized in 4 phases)

---

## Executive Summary

This implementation plan organizes pipeline development into **4 phases with clear dependencies**, enabling **parallel execution** where possible and ensuring **foundational work completes first**.

**Timeline Estimate:**

- **Phase 1 (Foundation):** Week 1-2 (3 tasks, fully parallelizable)
- **Phase 2 (Core Services):** Week 2-4 (4 tasks, partial parallelization)
- **Phase 3 (Backend APIs):** Week 4-5 (3 tasks, fully parallelizable)
- **Phase 4 (Frontend):** Week 6-8 (6 tasks, partial parallelization)

**Total:** 8 weeks (can be reduced to 6 weeks with 3+ developers)

---

## Task Organization Strategy

### Dependency Management

- **Phase markers** (#79, #69, #86, #73) track phase completion
- **Blocking relationships** prevent premature work on dependent tasks
- **Parallel execution** identified within each phase
- **Critical path** clearly marked for priority

### Parallelization Opportunities

- **Phase 1:** All 3 tasks can run in parallel (data models + registry)
- **Phase 2:** Circuit breaker + flow selection can run in parallel
- **Phase 3:** All 3 API tasks can run in parallel
- **Phase 4:** Multiple frontend components can run in parallel

---

## Phase 1: Foundation Layer (Week 1-2)

**Goal:** Set up data models and infrastructure
**Status:** #79 (Phase marker)
**Dependencies:** None (can start immediately)

### Tasks (All parallelizable ✅)

| Task | Subject                                     | Owner         | Priority | Dependencies |
| ---- | ------------------------------------------- | ------------- | -------- | ------------ |
| #84  | Implement PipelineDefinition MongoDB model  | Backend Dev 1 | CRITICAL | None         |
| #87  | Implement JobExecution model with TTL index | Backend Dev 2 | CRITICAL | None         |
| #77  | Create base provider registry structure     | Backend Dev 3 | HIGH     | None         |

### Deliverables

- ✅ `packages/database/src/models/pipeline-definition.model.ts`
- ✅ `packages/database/src/models/job-execution.model.ts`
- ✅ TTL index migration script
- ✅ `apps/search-ai/src/services/provider-registry/index.ts`

### Acceptance Criteria

- All models match design specifications (01-DATA-MODELS.md, 02-JOB-TRACKING-RETENTION.md)
- Validation rules implemented (flows.length 1-50, stage sequence)
- TTL index configured (90-day retention)
- All indexes created
- Tenant isolation verified
- Unit tests pass (>90% coverage)

### Critical Path Items

- **#84 (PipelineDefinition)** blocks Phase 2 flow selection and validation
- **#87 (JobExecution)** critical for production (prevents 730GB/year growth)
- **#77 (Provider registry)** blocks Phase 2 circuit breaker integration

---

## Phase 2: Core Services (Week 2-4)

**Goal:** Implement pipeline orchestration logic
**Status:** #69 (Phase marker, blocked by #79)
**Dependencies:** Phase 1 must complete

### Tasks (Partial parallelization)

#### Parallel Group A (Start immediately after Phase 1) ✅

| Task | Subject                                          | Owner         | Priority | Dependencies |
| ---- | ------------------------------------------------ | ------------- | -------- | ------------ |
| #85  | Integrate circuit breaker with provider registry | Backend Dev 3 | CRITICAL | #77          |
| #83  | Implement flow selection service (CEL)           | Backend Dev 1 | HIGH     | #84          |

#### Sequential Group B (After Group A)

| Task | Subject                               | Owner         | Priority | Dependencies  |
| ---- | ------------------------------------- | ------------- | -------- | ------------- |
| #74  | Implement BullMQ Flows integration    | Backend Dev 2 | CRITICAL | #84, #85, #83 |
| #68  | Implement pipeline validation service | Backend Dev 1 | HIGH     | #84, #83      |

### Deliverables

- ✅ `apps/search-ai/src/services/provider-registry/circuit-breaker-registry.ts`
- ✅ `apps/search-ai/src/services/flow-selection/flow-selection.service.ts`
- ✅ `apps/search-ai/src/services/pipeline-orchestration/flow-builder.ts`
- ✅ `apps/search-ai/src/services/pipeline-validation/validation.service.ts`

### Acceptance Criteria

- Circuit breaker wraps provider execution correctly
- Fallback providers work when circuit opens
- Flow selection matches design (priority-based, CEL evaluation)
- BullMQ flows have `failParentOnFailure: true` on ALL children
- Validation service implements all 18 rules
- Unit tests + integration tests pass

### Critical Path Items

- **#74 (BullMQ Flows)** blocks all Phase 3 API work (must complete first)
- **#85 (Circuit breaker)** critical for production resilience

---

## Phase 3: Backend APIs (Week 4-5)

**Goal:** Implement REST endpoints
**Status:** #86 (Phase marker, blocked by #69)
**Dependencies:** Phase 2 must complete

### Tasks (All parallelizable ✅)

| Task | Subject                                     | Owner         | Priority | Dependencies |
| ---- | ------------------------------------------- | ------------- | -------- | ------------ |
| #70  | Implement pipeline CRUD APIs (6 endpoints)  | Backend Dev 1 | CRITICAL | #68, #74     |
| #71  | Implement manual trigger APIs (3 endpoints) | Backend Dev 2 | HIGH     | #74, #83     |
| #72  | Implement provider schemas API              | Backend Dev 3 | MEDIUM   | #77          |

### Deliverables

- ✅ `apps/search-ai/src/routes/pipelines.ts` (6 endpoints)
- ✅ `apps/search-ai/src/routes/pipeline-triggers.ts` (3 endpoints)
- ✅ `apps/search-ai/src/routes/provider-schemas.ts` (1 endpoint)

### API Endpoints

**Pipeline CRUD (Task #70):**

1. GET `/api/projects/:projectId/knowledge-bases/:kbId/pipelines`
2. PATCH `/api/projects/:projectId/knowledge-bases/:kbId/pipelines/:id`
3. POST `/api/projects/:projectId/knowledge-bases/:kbId/pipelines/:id/publish`
4. POST `/api/projects/:projectId/knowledge-bases/:kbId/pipelines/validate`
5. POST `/api/projects/:projectId/knowledge-bases/:kbId/pipelines/:id/test-selection`
6. GET `/api/projects/:projectId/pipelines/providers/:stageType/schemas`

**Trigger APIs (Task #71):**

1. POST `/api/projects/:projectId/knowledge-bases/:kbId/documents/:docId/trigger-pipeline`
2. POST `/api/projects/:projectId/knowledge-bases/:kbId/sources/:sourceId/trigger-pipeline`
3. POST `/api/projects/:projectId/knowledge-bases/:kbId/trigger-pipeline`

**Provider Schemas (Task #72):**

1. GET `/api/projects/:projectId/pipelines/providers/:stageType/schemas`

### Acceptance Criteria

- All endpoints return structured responses
- Authentication + authorization middleware applied
- Tenant isolation on all queries
- Rate limiting applied to trigger endpoints (10 req/min)
- Backpressure prevents queue overload
- Error responses match spec (401/403/404/500)
- API documentation (Swagger/OpenAPI)
- Integration tests with auth + permissions

### Critical Path Items

- **#70 (CRUD APIs)** blocks all Phase 4 frontend work
- **#71 (Trigger APIs)** needed for testing pipeline execution

---

## Phase 4: Frontend (Week 6-8)

**Goal:** Implement Studio UI components
**Status:** #73 (Phase marker, blocked by #86 and #65)
**Dependencies:** Phase 3 + wiremock approval (#65)

### Tasks (Partial parallelization)

#### Sequential Task (Foundation)

| Task | Subject                                   | Owner          | Priority | Dependencies |
| ---- | ----------------------------------------- | -------------- | -------- | ------------ |
| #76  | Implement pipeline editor + Zustand store | Frontend Dev 1 | CRITICAL | #70          |

#### Parallel Group (After #76) ✅

| Task | Subject                      | Owner          | Priority | Dependencies |
| ---- | ---------------------------- | -------------- | -------- | ------------ |
| #75  | Implement flows list sidebar | Frontend Dev 1 | HIGH     | #76          |
| #81  | Implement React Flow canvas  | Frontend Dev 2 | HIGH     | #76          |
| #78  | Implement rule builder modal | Frontend Dev 3 | MEDIUM   | #76          |

#### Parallel Group (After #76 + APIs)

| Task | Subject                                  | Owner          | Priority | Dependencies |
| ---- | ---------------------------------------- | -------------- | -------- | ------------ |
| #82  | Implement stage configuration slide-over | Frontend Dev 2 | HIGH     | #72, #76     |
| #80  | Implement test selection modal           | Frontend Dev 3 | MEDIUM   | #71, #76     |

### Deliverables

- ✅ `apps/studio/src/features/pipelines/PipelineEditor.tsx`
- ✅ `apps/studio/src/features/pipelines/store/pipeline-store.ts` (Zustand)
- ✅ `apps/studio/src/features/pipelines/components/FlowsList.tsx`
- ✅ `apps/studio/src/features/pipelines/components/FlowCanvas.tsx`
- ✅ `apps/studio/src/features/pipelines/components/StageNode.tsx`
- ✅ `apps/studio/src/features/pipelines/components/StageConfigPanel.tsx`
- ✅ `apps/studio/src/features/pipelines/components/RuleBuilder.tsx`
- ✅ `apps/studio/src/features/pipelines/components/TestSelectionModal.tsx`

### Acceptance Criteria

- All wiremocks from UX-PIPELINE-CONFIGURATION.md implemented
- Zustand store manages draft/published state correctly
- React Flow canvas renders pipeline correctly
- Stage configuration uses dynamic form generation
- Rule builder creates valid CEL expressions
- Test selection modal calls API correctly
- Responsive design works on different screen sizes
- Unit tests + visual tests pass

### Critical Path Items

- **#76 (Editor + Zustand)** blocks all other frontend tasks (must complete first)
- **#65 (Wiremock approval)** is external dependency (user approval)

---

## Critical Path Analysis

### Longest Dependency Chain (Critical Path)

```
#84 (PipelineDefinition)
  → #83 (Flow selection)
    → #74 (BullMQ Flows)
      → #70 (CRUD APIs)
        → #76 (Editor + Zustand)
          → #75, #81, #82, #78, #80 (Frontend components)
```

**Total Critical Path Duration:** ~6-7 weeks

### Parallelization Opportunities

**Week 1-2 (Phase 1):**

- 3 developers → All tasks in parallel → **Completes in 1 week**

**Week 2-3 (Phase 2 - Group A):**

- 2 developers → Circuit breaker + flow selection in parallel → **Completes in 1 week**

**Week 3-4 (Phase 2 - Group B):**

- 2 developers → BullMQ Flows + validation in parallel → **Completes in 1 week**

**Week 4-5 (Phase 3):**

- 3 developers → All API tasks in parallel → **Completes in 1 week**

**Week 6 (Phase 4 - Foundation):**

- 1 developer → Editor + Zustand (sequential) → **Completes in 1 week**

**Week 7-8 (Phase 4 - Components):**

- 3 developers → All components in parallel → **Completes in 2 weeks**

**With 3 developers:** 6-7 weeks total
**With 2 developers:** 8-9 weeks total
**With 1 developer:** 12-14 weeks total

---

## Risk Mitigation

### High-Risk Items

**1. BullMQ Flows Integration (Task #74)**

- **Risk:** Silent failures, parent waiting forever (Issue #3851)
- **Mitigation:** Always set `failParentOnFailure: true`, validate FlowProducer.add() result
- **Owner:** Backend Dev 2

**2. TTL Index Migration (Task #87)**

- **Risk:** Downtime during index creation
- **Mitigation:** Use `background: true`, test in staging first with shorter TTL
- **Owner:** Backend Dev 2

**3. Circuit Breaker Integration (Task #85)**

- **Risk:** Circuit stuck in OPEN state
- **Mitigation:** Add monitoring, manual reset capability, comprehensive testing
- **Owner:** Backend Dev 3

**4. Frontend State Management (Task #76)**

- **Risk:** Draft/published state desync
- **Mitigation:** Zustand devtools, comprehensive unit tests, pessimistic updates
- **Owner:** Frontend Dev 1

### Medium-Risk Items

**5. Flow Selection CEL Evaluation (Task #83)**

- **Risk:** Complex CEL expressions hang or fail
- **Mitigation:** 5s timeout, fail-safe error handling (continue to next flow)
- **Owner:** Backend Dev 1

**6. Provider Configuration Forms (Task #82)**

- **Risk:** Dynamic form generation doesn't support all field types
- **Mitigation:** Start with basic types (text, number, boolean), add complex types later
- **Owner:** Frontend Dev 2

---

## Testing Strategy

### Unit Tests

- **Coverage Target:** >90% for all new code
- **Required for:** All services, models, components
- **Tools:** Jest, React Testing Library

### Integration Tests

- **Required for:** All API endpoints, database operations, BullMQ flows
- **Tools:** Jest + Supertest, MongoDB Memory Server, Redis Mock

### E2E Tests

- **Required for:** Critical user flows (create pipeline, publish, trigger)
- **Tools:** Playwright
- **Scenarios:**
  1. Create pipeline with multiple flows
  2. Configure stages and rules
  3. Test flow selection
  4. Publish pipeline
  5. Trigger pipeline manually

### Load Tests

- **Required for:** API endpoints, BullMQ flow creation
- **Tools:** k6
- **Scenarios:**
  1. 100 req/s on CRUD APIs
  2. 1000 flows created in 1 minute
  3. TTL index cleanup performance

---

## Monitoring & Observability

### CloudWatch Metrics (Task #87)

**Job Tracking:**

- TotalJobExecutions (count)
- JobsApproachingRetention (80+ days old)
- JobExecutionStorageMB (caps at ~180GB)

**Circuit Breaker (Task #85):**

- CircuitBreakerStateChanges (CLOSED/OPEN/HALF-OPEN)
- ProviderFailureRate (per provider)
- FallbackExecutionCount (fallback usage)

**Pipeline Execution (Task #71):**

- PipelineTriggersTotal (count)
- PipelineExecutionDuration (ms)
- FlowSelectionDuration (ms)

### CloudWatch Alarms

**CRITICAL:**

- JobExecution storage exceeds 200GB (expected ~180GB)
- Circuit breaker stuck in OPEN for >5 minutes
- TTL not deleting old jobs (>10K jobs 80+ days old)

**HIGH:**

- API response time >1s (P95)
- Pipeline trigger rate limit exceeded
- BullMQ queue depth >10K jobs

**MEDIUM:**

- Flow selection failure rate >5%
- Provider fallback usage >10%
- Validation error rate >20%

### Dashboards

**Pipeline Operations:**

- Active pipelines count
- Pipelines by knowledge base
- Draft vs published count
- Average flows per pipeline

**Execution Health:**

- Trigger requests (per hour)
- Successful vs failed executions
- Circuit breaker state (per provider)
- Queue depth (per queue)

**Performance:**

- API response times (P50, P95, P99)
- Flow selection duration
- Validation duration
- Database query performance

---

## Success Criteria

### Phase 1 Complete

- [ ] All 3 data models implemented
- [ ] TTL index migration tested in staging
- [ ] Provider registry structure complete
- [ ] Unit tests pass (>90% coverage)
- [ ] Integration tests pass

### Phase 2 Complete

- [ ] Circuit breaker integration works
- [ ] Flow selection matches design
- [ ] BullMQ flows created correctly
- [ ] Validation service implements 18 rules
- [ ] Integration tests with Redis/BullMQ pass

### Phase 3 Complete

- [ ] All 10 API endpoints implemented
- [ ] Authentication + authorization working
- [ ] Rate limiting applied
- [ ] Backpressure prevents overload
- [ ] API documentation complete
- [ ] Postman collection created

### Phase 4 Complete

- [ ] All wiremocks implemented
- [ ] Pipeline editor fully functional
- [ ] Can create, edit, publish pipelines
- [ ] Can trigger pipelines manually
- [ ] E2E tests pass
- [ ] User acceptance testing complete

### Production Ready

- [ ] All phases complete
- [ ] Load tests pass (100 req/s sustained)
- [ ] Monitoring dashboards live
- [ ] Alarms configured
- [ ] Documentation complete
- [ ] Runbook for operations team
- [ ] Migration plan for legacy pipelines

---

## Next Steps

### Immediate Actions (This Week)

1. **Assign owners** to Phase 1 tasks (#84, #87, #77)
2. **Create feature branch** `feature/pluggable-pipelines`
3. **Set up CI pipeline** for new code
4. **Schedule daily standups** for coordination
5. **Create Slack channel** #feat-pluggable-pipelines

### Week 1 Goals

- [ ] All Phase 1 tasks in progress
- [ ] First PR merged (PipelineDefinition model)
- [ ] Unit tests written and passing
- [ ] Integration test infrastructure set up

### Week 2 Goals

- [ ] Phase 1 complete
- [ ] Phase 2 tasks started
- [ ] Circuit breaker integration in progress
- [ ] Flow selection service in progress

---

## References

**Design Documents:**

- `docs/searchai/pipelines/design/backend/01-DATA-MODELS.md`
- `docs/searchai/pipelines/design/backend/02-JOB-TRACKING-RETENTION.md`
- `docs/searchai/pipelines/design/backend/03-CIRCUIT-BREAKER-IMPLEMENTATION.md`
- `docs/searchai/pipelines/design/frontend/UX-PIPELINE-CONFIGURATION.md`

**RFCs:**

- `docs/searchai/pipelines/rfcs/RFC-004-FLOW-BASED-ARCHITECTURE.md`
- `docs/searchai/pipelines/rfcs/RFC-005-Job-Tracking-Architecture.md`
- `docs/searchai/pipelines/rfcs/RFC-006-Job-Tracking-BullMQ-Flows-Integration.md`

**Skills:**

- `.claude/skills/search-ai-pipelines.md` - Implementation patterns and debugging
- `.claude/skills/bullmq-flows-guide.md` - BullMQ Flows production patterns

**Review:**

- `docs/searchai/pipelines/DESIGN-REVIEW-SUMMARY.md` - All issues fixed

---

**Questions or feedback? Contact the pipeline development team in #feat-pluggable-pipelines**
