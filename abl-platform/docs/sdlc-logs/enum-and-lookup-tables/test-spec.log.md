# Test Spec — Oracle Log: enum-and-lookup-tables

**Date:** 2026-03-24
**Phase:** TEST-SPEC
**Oracle:** Inline (agent model unavailable)

## Test Scope & Priorities

1. **Highest risk requirements?** — ANSWERED. GAP-1 (parser options), GAP-2 (compiler enum→IR), GAP-3 (LLM prompt injection) are HIGH severity per feature spec. These are the core pipeline: DSL→IR→Runtime. GAP-4 (API headers) and GAP-5 (Studio UI) are MEDIUM.
2. **Known edge cases?** — INFERRED. Large value sets (>100 for token budget, >1000 for parser warning), empty options arrays, duplicate values, special characters in values, case-sensitivity boundaries.
3. **Current coverage baseline?** — ANSWERED. 31 tests across 5 files: parser-enum-options (7), parser-lookup-headers (4), gather-enum-compilation (5), extraction-lookup-injection (9), lookup-resolver-gaps (6). No E2E or integration tests exist.
4. **External dependencies?** — ANSWERED. MongoDB for collection source (real in integration, mock in unit). External HTTP APIs for api source (mock via fetchFn DI). No other external deps.
5. **Test environment?** — ANSWERED. Docker Compose for infra (MongoDB, Redis). Vitest for unit/integration. CI via Harness. Studio dev server for manual UI testing.

## E2E Scenarios

1. **Critical user journeys?** — ANSWERED. (a) DSL with enum field → compile → runtime extracts with enum constraint → validates. (b) DSL with lookup table → compile → runtime resolves lookup → validates/rejects. (c) Studio UI creates lookup field → serializes to DSL → round-trips back.
2. **Auth/permission combinations?** — ANSWERED. lookup_data:read for GET entries, lookup_data:write for POST/DELETE entries and upload. Cross-tenant isolation on collection source.
3. **Cross-feature interactions?** — INFERRED. Gather + flow steps (lookup validation in multi-step flows), gather + fuzzy match confirmation flow, gather + re-prompt on invalid value.
4. **Data seeding?** — DECIDED. Seed lookup_entries collection with test values per tenant/project. Seed inline DSL with various option counts. No complex seeding needed.
5. **Performance scenarios?** — DECIDED. Large inline table (1000+ values) parsing, API timeout handling, circuit breaker behavior under load. Not critical for initial test spec.

## Integration Boundaries

1. **Service boundaries?** — ANSWERED. Parser→Compiler (DSL text→IR), Runtime→LookupResolver (field value→lookup result), REST API→MongoDB (CRUD operations), Studio→Serializer→DSL (editor state→DSL text).
2. **Event-driven flows?** — DECIDED. None. Lookup resolution is synchronous request-response. No webhooks or async events.
3. **Tenant/project isolation?** — ANSWERED. Collection source queries must include tenantId+projectId. REST API routes are project-scoped. Cross-tenant lookups must return not-found.
4. **Race conditions?** — INFERRED. Concurrent lookup resolutions sharing cache entries, TTL cache expiry during resolution, circuit breaker state transitions under concurrent failures.
5. **Error/failure paths?** — ANSWERED. API circuit breaker (3 failures→open), SSRF blocking private IPs, upload size limits (1MB body, 10K values), bulk upsert limits (1K/request), malformed CSV/JSON uploads.

## Classification Summary

- ANSWERED: 10
- INFERRED: 3
- DECIDED: 3
- AMBIGUOUS: 0

No questions require user escalation. Proceeding with test spec generation.
