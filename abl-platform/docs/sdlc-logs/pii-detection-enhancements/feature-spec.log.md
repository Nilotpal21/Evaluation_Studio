# SDLC Log: PII Detection Enhancements — Feature Spec

**Date**: 2026-03-27
**Phase**: Feature Spec (Phase 1)
**Feature**: pii-detection-enhancements

---

## Oracle Decisions

15 clarifying questions answered. 0 AMBIGUOUS — no user escalation needed.

### Scope & Problem

| #   | Question                         | Classification | Decision                                                                                                            |
| --- | -------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | Cloud provider integration model | DECIDED        | New `'cloud'` tier in PIIRecognizerRegistry. `CloudPIIRecognizer` abstract base, concrete subclasses per provider.  |
| 2   | Cloud provider configuration     | DECIDED        | Per-project in `project_runtime_configs.pii_redaction.cloudProviders[]`. Multiple simultaneous providers supported. |
| 3   | Cloud provider credentials       | ANSWERED       | Existing auth profile + credential resolution (same as LLM providers). Tenant-scoped via KMS/VaultProvider.         |
| 4   | Analytics dashboard scope        | DECIDED        | New Observatory tab (`'pii'`). Time series, pie chart (type dist), table (top types), trend lines.                  |
| 5   | Breaking changes                 | INFERRED       | No breaking changes. `PIIType` widens from closed union to `string` with well-known constants (additive).           |

### User Stories & Requirements

| #   | Question                       | Classification | Decision                                                                                                                        |
| --- | ------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 6   | Cloud provider latency         | DECIDED        | Synchronous with 500ms per-provider latency budget. Circuit breaker + 60s content-hash cache via Redis.                         |
| 7   | Cloud provider fallback        | DECIDED        | Fail-open to regex-only. Never block. Log `pii_cloud_degraded` trace events.                                                    |
| 8   | Analytics personas             | DECIDED        | Compliance officers (frequency, audit completeness), project builders (per-project/agent), tenant admins (cross-project, cost). |
| 9   | Analytics granularity          | DECIDED        | Both tenant-scoped and project-scoped. Time-range filtering mandatory.                                                          |
| 10  | Custom pattern scope expansion | INFERRED       | YES — custom patterns active in ALL paths after unification. Per-session registry ensures project isolation.                    |

### Technical & Architecture

| #   | Question                  | Classification | Decision                                                                                                              |
| --- | ------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------- |
| 11  | ClickHouse pipeline state | ANSWERED       | Partially exists. `messages.has_pii` column exists. No `pii_detections` table. Needs new table + MVs + dual-write.    |
| 12  | Registry architecture     | DECIDED        | Global singleton (built-ins, permanent) + per-session overlays (custom patterns + cloud providers).                   |
| 13  | Cloud provider cost       | DECIDED        | 60s Redis cache + per-tenant rate limit + monthly cost budget in Redis counter. Fallback to regex on exhaustion.      |
| 14  | Data model changes        | DECIDED        | Extend `IPIIRedactionConfig`, new ClickHouse `pii_detections` table, widen `PIIType` to string. No migrations needed. |
| 15  | International patterns    | DECIDED        | Only E.164 + IBAN as new regex. Cloud providers handle country-specific IDs.                                          |

## Files Created

- `docs/features/sub-features/pii-detection-enhancements.md`
- `docs/testing/sub-features/pii-detection-enhancements.md`
- `docs/sdlc-logs/pii-detection-enhancements/feature-spec.log.md` (this file)

## Key Code Evidence

- `PIIRecognizerRegistry`: `RecognizerTier = 'regex' | 'ml' | 'custom'` at `pii-recognizer-registry.ts:15`
- `PIIRecognizer` interface at `pii-recognizer-registry.ts:17-22`
- `PIIType` closed union at `pii-detector.ts:34` — needs widening
- `detectPII()` optional `registry` parameter at `pii-detector.ts:116` — unification changes default behavior
- `IPIIRedactionConfig` at `project-runtime-config.model.ts:49-53` — needs `cloudProviders` extension
- `CircuitBreaker` at `circuit-breaker.ts:30-32` — reusable for cloud providers
- `BufferedClickHouseWriter` at `clickhouse.ts:117-306` — pattern for PII analytics ingestion
- ClickHouse `messages.has_pii` column at `clickhouse-schemas/init.ts:42`
- `DebugTab` type at `observatory-store.ts:29-37` — needs `'pii'` addition
- No existing Google DLP / AWS Comprehend / Azure AI code — greenfield

## Audit Results

### Round 1: NEEDS_REVISION

2 CRITICAL, 5 HIGH, 3 MEDIUM findings. All resolved:

- Added Cloud Provider Data Handling subsection (DPA, data residency, consent, minimization)
- Added FR-26 (tenant consent) and FR-25 (phone regex tightening)
- Extended FR-10 to per-project + per-session rate limits
- Rewrote FR-16 with WellKnownPIIType union + fallback strategy
- Rewrote FR-5 as behavior-testable
- Added user_id to ClickHouse table, Audit Logging to integration matrix
- Fixed test file path, E2E-4 setup wording, gap resolution count

### Round 2: APPROVED

0 CRITICAL. 3 HIGH (non-blocking) resolved immediately:

- Added `region` to ICloudPIIProviderConfig
- Added `cloudPiiConsent` to data model
- Added delivery subtask 3.10 for consent gate
- Added FR-25, FR-26 to test spec coverage matrix
- Added E2E-6 consent gate scenario
