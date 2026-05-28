# SDLC Log: Guardrails Test Spec

**Phase**: 2 - Test Spec
**Date**: 2026-03-22
**Status**: Complete

---

## Clarifying Questions & Resolutions

### Test Scope

1. **Q: What is the current test coverage baseline?**
   - Classification: ANSWERED
   - Source: Codebase search found 49+ test files across compiler and runtime
   - Answer: 41 unit test files, 22 integration test files, 3 E2E test files. Strong unit coverage, significant E2E gaps.

2. **Q: Which FRs are highest risk?**
   - Classification: DECIDED
   - Answer: FR-3 (policy inheritance) and FR-4 (evaluation kinds) are highest risk because they are architectural multipliers -- bugs affect every guardrail evaluation. FR-7 (streaming) is high risk because it's a production-critical path.

3. **Q: What external dependencies need mocking vs real integration?**
   - Classification: DECIDED
   - Answer: Use mock HTTP servers for deterministic testing. Real LLM/OpenAI calls are out of scope for automated tests. builtin_pii is fully local and best E2E candidate.

### E2E Scenarios

4. **Q: What are the critical user journeys?**
   - Classification: INFERRED
   - Source: Feature spec user stories + coverage matrix gaps
   - Answer: 8 E2E scenarios covering: PII blocking, multi-tier cascade, policy scoping, reask action, tool call blocking, streaming, cross-tenant isolation, circuit breaker.

5. **Q: What auth/permission combinations need coverage?**
   - Classification: ANSWERED
   - Source: Route files use `authMiddleware`, `requirePermission`, `requireFeature`
   - Answer: All routes require auth + rate limiting + feature gate. Cross-tenant isolation is critical.

### Integration Boundaries

6. **Q: Which service boundaries need integration tests?**
   - Classification: ANSWERED
   - Source: Pipeline factory loads from DB, policy resolver merges scopes, streaming evaluator uses pipeline, cost tracker uses Redis
   - Answer: 7 integration scenarios covering factory-DB, resolver-policy, streaming-pipeline, cost-Redis, webhook-HTTP, routes-auth, output-execution.

## Key Findings

- 49+ existing test files providing comprehensive unit coverage
- 8 E2E scenarios defined (exceeds minimum 5)
- 7 integration scenarios defined (exceeds minimum 5)
- Coverage matrix maps all 14 FRs to test types
- Provider x kind matrix: 4 providers x 5 kinds = 20 E2E combinations needed
- 9 coverage gaps identified with priority ordering
- Test architecture notes documented for each test type

## Output Verification

- [x] 8 E2E scenarios (exceeds minimum 5)
- [x] 7 integration scenarios (exceeds minimum 5)
- [x] Coverage matrix maps all 14 FRs
- [x] Provider x kind matrix documented
- [x] Security and isolation section
- [x] Test infrastructure requirements
- [x] How to run section with commands
- [x] Coverage gaps with priority order
