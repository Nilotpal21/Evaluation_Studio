# SDLC Log: Sizing Calculator -- Phase 2 Test Spec

**Date:** 2026-03-22
**Phase:** Test Spec
**Feature:** sizing-calculator (#42)

## Test Spec Summary

### Test Counts

| Category             | Count              | Notes                                             |
| -------------------- | ------------------ | ------------------------------------------------- |
| E2E Tests            | 8                  | All P0 API flows, full middleware chain           |
| Integration Tests    | 8                  | Engine boundaries, rate limiting, provider matrix |
| Property-Based Tests | 3                  | Monotonicity, tier ordering, non-negativity       |
| Snapshot Tests       | 2                  | Helm YAML golden files                            |
| Unit Tests           | 9 files (existing) | Already in packages/sizing-calculator             |

### Key Design Decisions

1. **No mocking** -- All E2E tests use real Express servers with full middleware chain
2. **Two-tenant setup** -- E2E-7 tests cross-tenant isolation with tenantA/tenantB
3. **Boundary testing** -- E2E-5 tests exact tier boundary transitions (10->11 agents, etc.)
4. **Fixture-based** -- Two canonical questionnaire fixtures (Tier-S, Tier-XL) reused across tests
5. **Coverage matrix** -- Every component has at least 2 test categories covering it

### Gaps Identified

- Studio UI not covered (deferred to BETA phase)
- Cost estimation not covered (P1 feature, not yet implemented)
- Terraform/PDF export not covered (P2 features)
- CLI integration tests need the CLI to be wired to the API (currently standalone)

### E2E Scenarios (8)

1. E2E-1: Calculate Topology Full Flow (Tier S)
2. E2E-2: Calculate Topology Full Flow (Tier XL with GPU)
3. E2E-3: Export Helm Values
4. E2E-4: Questionnaire Validation -- Invalid Input
5. E2E-5: Questionnaire Validation -- Boundary Values
6. E2E-6: Compare Multiple Configurations
7. E2E-7: Profile CRUD with Tenant Isolation
8. E2E-8: Authentication Required

### Integration Scenarios (8)

1. INT-1: Tier Classification Across All Boundaries
2. INT-2: Service Sizer Workload Scaling
3. INT-3: Datastore Sizer TTL Policies
4. INT-4: Managed Recommender Decision Matrix
5. INT-5: Disk Growth Projections Sanity
6. INT-6: Helm Values Generator Structure
7. INT-7: Rate Limiting on Calculate Endpoint
8. INT-8: Cloud Provider Instance Types
