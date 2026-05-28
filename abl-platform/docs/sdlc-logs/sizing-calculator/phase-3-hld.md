# SDLC Log: Sizing Calculator -- Phase 3 HLD

**Date:** 2026-03-22
**Phase:** High-Level Design
**Feature:** sizing-calculator (#42)

## HLD Summary

### Architecture Decision

API hosted in admin service (not standalone microservice). Engine stays pure TS. Profiles in MongoDB. REST API (not GraphQL).

### 3 Alternatives Evaluated

1. **Standalone Sizing Microservice** -- REJECTED (operational overhead for low-traffic feature)
2. **Client-Side-Only Calculation** -- REJECTED (cannot persist profiles, no isolation enforcement)
3. **GraphQL API** -- REJECTED (overkill for 5 operations, no existing GraphQL infra)

### 12 Architectural Concerns Addressed

| #   | Concern                 | Key Decision                                                                             |
| --- | ----------------------- | ---------------------------------------------------------------------------------------- |
| 1   | Resource Isolation      | findOne({\_id, tenantId, projectId}); cross-tenant returns 404                           |
| 2   | Auth & Authz            | requireAuth + requireProjectPermission('sizing-profile:read/write')                      |
| 3   | Stateless & Distributed | Engine is pure compute; profiles in MongoDB; rate limits in Redis                        |
| 4   | Traceability            | TraceEvents for calculate/export/profile ops; structured logging                         |
| 5   | Compliance              | No PII in I/O; no secrets in output; encrypted at rest                                   |
| 6   | Performance             | Calculate <5ms engine + 200ms p99 HTTP; O(1) per tier                                    |
| 7   | Scalability             | Stateless horizontal; 50MB/tenant profile storage                                        |
| 8   | Reliability             | Engine has 0 external deps; graceful degradation if MongoDB down                         |
| 9   | Observability           | Prometheus histograms, counters; OpenTelemetry spans                                     |
| 10  | Data Model              | sizing_profiles collection with 4 indexes                                                |
| 11  | API Contracts           | 4 public endpoints + 5 profile CRUD endpoints                                            |
| 12  | Extensibility           | New services/stores/providers added via constants; pipeline pattern allows custom stages |

### Security Threat Model

7 threats identified with mitigations: input validation, rate limiting, tenant isolation, no credential exposure, generic error messages, scoped listing, no YAML injection.

### 5 Implementation Phases

1. API Core (calculate, export, tiers)
2. Profile Persistence (CRUD, MongoDB, isolation)
3. Compare & Breakdown (comparison endpoint, tier breakdown)
4. Studio UI (questionnaire form, topology view, growth chart)
5. Cost & Advanced Export (cost estimation, Terraform)

### New Types Introduced

- `TierBreakdown` -- shows which dimensions drove tier classification
- `SizingProfile` -- MongoDB document for saved configurations
- `CostEstimate` -- breakdown by compute/storage/network/managed

### Risk Register

5 risks identified; highest impact: Helm values incompatible with chart versions (mitigated by snapshot tests + CI validation).
