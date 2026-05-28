# Feature: PII Detection Enhancements

**Doc Type**: SUB-FEATURE
**Parent Feature**: [PII Detection & Redaction](../pii-detection.md)
**Status**: PLANNED
**Feature Area(s)**: `governance`, `customer experience`, `enterprise`, `observability`
**Package(s)**: `packages/compiler`, `apps/runtime`, `packages/database`, `apps/studio`
**Owner(s)**: `Platform Team`
**Testing Guide**: `../../testing/sub-features/pii-detection-enhancements.md`
**Last Updated**: 2026-03-27

---

## 1. Introduction / Overview

### Problem Statement

The existing PII Detection & Redaction system has 15 documented gaps (GAP-001 through GAP-015) that limit its effectiveness for production deployments:

1. **Architecture inconsistency (GAP-013, HIGH)**: The `PIIRecognizerRegistry` was designed as a pluggable, extensible detection registry, but three key consumers bypass it entirely — the `builtin-pii` guardrail provider, `PIIVault`, and CEL functions all call `pii-detector.ts` directly. Custom recognizers registered via `loadProjectPIIPatterns()` only work in the NLU path. This means project-scoped custom PII patterns are silently ignored during guardrail evaluation, vault tokenization, and CEL expression evaluation.

2. **Limited regex coverage (GAP-009-012)**: SSN only matches dashed format (misses `123456789`), credit card only matches 16-digit cards (misses 15-digit Amex), phone is US-centric (misses international E.164), and IPv6 is completely absent.

3. **No ML/NER detection (GAP-001, GAP-015)**: Only 5 PII types are detected via regex. Names, physical addresses, dates of birth, passport numbers, driver's licenses, bank accounts, and health IDs have zero detection coverage. No cloud PII API integration exists.

4. **No PII analytics (parent spec Open Question #5)**: No visibility into detection frequency, type distribution, false positive rates, or trends. Compliance officers cannot demonstrate detection effectiveness.

5. **Duplicate code (GAP-014)**: The 5 regex patterns are defined identically in both `pii-detector.ts` and `pii-recognizer-registry.ts`, risking drift.

### Goal Statement

Unify all PII detection through the `PIIRecognizerRegistry`, extend regex coverage for common format variants, integrate cloud-based ML PII detection (Google DLP, AWS Comprehend, Azure AI Language) for unstructured PII types, and provide a PII analytics dashboard for compliance visibility — resolving all 15 documented gaps in the parent feature spec.

### Summary

This enhancement delivers four capabilities:

1. **Registry unification**: All PII consumers (`detectPII()`, `containsPII()`, `builtin-pii` guardrail provider, `PIIVault`, CEL functions) route through `PIIRecognizerRegistry`. Duplicate regex definitions are eliminated. Custom patterns work in all detection paths.

2. **Regex enhancements**: Undashed SSN with area/group validation, 15-digit Amex and 13-digit Visa credit cards with Luhn, E.164 international phone format, IPv6 (full and compressed notation), and IBAN with country-code + check-digit validation. 5 new built-in recognizers added to the registry.

3. **Cloud PII provider integration**: A new `'cloud'` recognizer tier in `PIIRecognizerRegistry` with a `CloudPIIRecognizer` abstract base class. Concrete implementations for Google DLP (`@google-cloud/dlp`), AWS Comprehend (`@aws-sdk/client-comprehend`), and Azure AI Language (`@azure/ai-text-analytics`). Per-project configuration, auth-profile-based credential resolution, 500ms latency budget with circuit breaker, 60s content-hash Redis cache, per-tenant rate limiting and cost budget. Fail-open to regex-only on cloud failure.

4. **PII analytics dashboard**: New `pii_detections` ClickHouse table with hourly/daily materialized views. Dual-write from `PIIAuditLogger` (MongoDB for compliance + ClickHouse for analytics). New Observatory `'pii'` tab in Studio with time series, type distribution, per-agent breakdown, and trend visualizations. Tenant-scoped and project-scoped views with time-range filtering.

---

## 2. Scope

### Goals

- Unify all PII detection through `PIIRecognizerRegistry` — eliminate the registry bypass in `builtin-pii` provider, `PIIVault`, and CEL functions
- Consolidate duplicate regex patterns from `pii-detector.ts` into the registry as single source of truth
- Add 5 new built-in regex recognizers: undashed SSN, Amex/13-digit credit card, E.164 international phone, IPv6, IBAN
- Widen `PIIType` from closed union (`'email' | 'phone' | 'ssn' | 'credit_card' | 'ip_address'`) to extensible `string` with well-known constants
- Add `'cloud'` recognizer tier to `PIIRecognizerRegistry` with `CloudPIIRecognizer` abstract base class
- Integrate Google DLP, AWS Comprehend, and Azure AI Language as cloud PII recognizers
- Per-project cloud provider configuration in `project_runtime_configs.pii_redaction`
- Cloud provider credential resolution via existing auth profile infrastructure
- 500ms per-provider latency budget with circuit breaker fallback to regex-only
- Content-hash-based Redis cache (60s TTL) for cloud API results to reduce cost and latency
- Per-tenant cloud PII API rate limiting and monthly cost budget
- New `pii_detections` ClickHouse table with `tenant_id`, `project_id`, `session_id`, `pii_type`, `detection_source`, `provider`, `latency_ms`, `agent_name`
- Hourly and daily materialized views for PII analytics aggregation
- Dual-write from `PIIAuditLogger` to MongoDB (compliance) and ClickHouse (analytics)
- New Observatory `'pii'` tab in Studio with time series, type distribution pie chart, per-agent table, trend lines
- Tenant-scoped and project-scoped analytics views with time-range filtering
- Make PII guard field-to-type mapping configurable via project runtime config (GAP-006)
- Fix vault eviction to batch-evict 10% on capacity (GAP-007)
- E2E tests for PII pattern CRUD with real Express, auth middleware, MongoDB (GAP-008)

### Non-Goals (Out of Scope)

- Presidio sidecar (Python NER service) — deferred to later release
- Bulk PII pattern import/export (GAP-005) — low priority, no current demand
- Image/audio PII detection (beyond text extraction)
- Cross-session PII correlation or deduplication
- PII discovery scanning of stored historical data
- Real-time PII classification model training
- Random replacement cache scope change (GAP-002 resolved as WONTFIX — keep module-level global)

---

## 3. User Stories

1. As a **compliance officer**, I want PII detected by cloud ML providers (names, addresses, DOB) — not just regex patterns — so that our detection coverage meets regulatory audit requirements for GDPR/CCPA/HIPAA.
2. As a **project builder**, I want to configure Google DLP or AWS Comprehend per project so that my agents detect unstructured PII types (names, addresses) that regex cannot catch.
3. As a **compliance officer**, I want a PII analytics dashboard showing detection frequency by type, trend over time, and per-agent breakdown so that I can demonstrate detection effectiveness to auditors.
4. As a **project builder**, I want custom PII patterns I define to be enforced in guardrail evaluation, vault tokenization, AND CEL expressions — not just the NLU path — so that my custom patterns actually protect data across all detection surfaces.
5. As a **project builder**, I want SSN detection to catch both `123-45-6789` and `123456789` formats so that users cannot bypass redaction by omitting dashes.
6. As a **project builder**, I want international phone numbers in E.164 format (`+44 20 7946 0958`) detected so that non-US deployments have proper phone PII coverage.
7. As a **tenant admin**, I want to see cloud PII API usage and cost across projects so that I can manage cloud provider spend.
8. As a **platform operator**, I want cloud PII detection to fail-open to regex-only with logged degradation events so that cloud provider outages do not block agent conversations.
9. As a **project builder**, I want to configure which PII guard field-to-type mappings are active so that entity extraction exemptions work for custom PII types beyond the hardcoded defaults.

---

## 4. Functional Requirements

1. **FR-1**: The system must route all PII detection through `PIIRecognizerRegistry` — `detectPII()`, `containsPII()`, `detectPIISelective()`, `BuiltinPIIProvider.evaluate()`, `PIIVault.tokenize()`, and CEL functions `abl.contains_pii()` / `abl.redact_pii()` must use the registry, not hardcoded patterns.
2. **FR-2**: The system must eliminate duplicate regex patterns by removing the `PII_PATTERNS` array from `pii-detector.ts` and delegating all detection to the registry's `detectAll()`.
3. **FR-3**: The system must support a `'cloud'` recognizer tier in `PIIRecognizerRegistry` alongside existing `'regex'`, `'ml'`, and `'custom'` tiers.
4. **FR-4**: The system must provide a `CloudPIIRecognizer` abstract base class implementing `PIIRecognizer` with: HTTP call with configurable timeout, response-to-`PIIDetection[]` mapping, circuit breaker (5 failures → open, 30s reset), content-hash Redis cache (60s TTL).
5. **FR-5**: The system must detect PII using Google DLP, AWS Comprehend, and Azure AI Language cloud APIs, mapping provider-specific responses to `PIIDetection[]`. When a cloud provider is configured but its SDK is not installed, the system must return a descriptive error at configuration time, not fail silently at detection time.
6. **FR-6**: The system must support per-project cloud provider configuration via `project_runtime_configs.pii_redaction.cloudProviders[]` with fields: `provider`, `enabled`, `credentialId` (auth profile reference), `latencyBudgetMs` (default 500), and provider-specific config.
7. **FR-7**: The system must resolve cloud provider credentials via the existing auth profile infrastructure (`resolveAuthProfileCredentials()`), consistent with LLM and guardrail credential resolution.
8. **FR-8**: The system must enforce a per-provider latency budget (default 500ms) and abort cloud API calls that exceed it, falling back to regex-only detection for that request.
9. **FR-9**: The system must cache cloud PII detection results in Redis with a 60-second TTL, keyed on `sha256(text + provider + config)`, to reduce redundant API calls and cost.
10. **FR-10**: The system must enforce cloud PII API rate limits at both tenant level (configurable calls/minute) and project level (configurable calls/minute, default: tenant limit / project count). Per-session cloud API call limits (default: 50 calls/session) must prevent single-user budget exhaustion. Monthly cost budgets tracked in Redis counters at tenant level. When any limit is exhausted, the system must fall back to regex-only detection for that scope.
11. **FR-11**: The system must detect undashed SSN (`123456789`) with area number (001-899, excluding 666) and group number (01-99) validation, in addition to the existing dashed format.
12. **FR-12**: The system must detect 15-digit American Express and 13-digit legacy Visa credit card numbers with Luhn checksum validation, in addition to the existing 16-digit format.
13. **FR-13**: The system must detect international phone numbers in E.164 format (`+<country_code><number>`, 7-15 digits after country code) with known country code prefix validation.
14. **FR-14**: The system must detect IPv6 addresses in full notation, compressed notation (`::`), and mixed IPv4-mapped notation (`::ffff:192.0.2.1`).
15. **FR-15**: The system must detect IBAN (International Bank Account Number) with country code validation (2 letters + 2 check digits + up to 30 alphanumeric characters) and ISO 7064 Mod 97 check digit verification.
16. **FR-16**: The system must widen `PIIType` to `string` while preserving type safety: (a) export `WellKnownPIIType` union (`'email' | 'phone' | 'ssn' | 'credit_card' | 'ip_address' | 'iban' | 'ipv6'`) for contexts requiring compile-time checks, (b) export `WELL_KNOWN_PII_TYPES` const array for runtime validation, (c) define `PIIType = string` for extensibility, (d) update `getRedactLabel()` to return `[REDACTED_<TYPE>]` as fallback for unknown types. Existing code using the 5 well-known PIIType values must compile without changes.
17. **FR-17**: The system must write PII detection events to a new ClickHouse `pii_detections` table via `BufferedClickHouseWriter` with fields: `tenant_id`, `project_id`, `session_id`, `pii_type`, `detection_source` (`'regex' | 'cloud' | 'custom'`), `provider` (recognizer name), `count`, `latency_ms`, `agent_name`, `timestamp`.
18. **FR-18**: The system must provide hourly and daily materialized views over `pii_detections` for aggregated analytics queries.
19. **FR-19**: The system must dual-write PII audit events from `PIIAuditLogger` to both MongoDB (compliance, existing) and ClickHouse (analytics, new).
20. **FR-20**: The system must provide a new Observatory `'pii'` tab in Studio displaying: detection volume time series, PII type distribution pie chart, top detected types table, per-agent detection breakdown, and detection trend lines.
21. **FR-21**: The system must support both tenant-scoped and project-scoped PII analytics views with configurable time-range filtering (last 1h, 24h, 7d, 30d, 90d, custom).
22. **FR-22**: The system must make the PII guard field-to-type mapping (`FIELD_NAME_TO_PII_TYPE`, `ENTITY_TYPE_TO_PII_TYPE`) configurable via `project_runtime_configs.pii_redaction.gatherExemptions` instead of hardcoded lookup tables.
23. **FR-23**: The system must batch-evict 10% of oldest non-permanent vault entries when the vault reaches capacity (10K tokens), instead of the current single-entry eviction.
24. **FR-24**: The system must have E2E tests for PII pattern CRUD that exercise real Express server, full auth middleware chain, MongoDB, tenant isolation, and project isolation — no mocks of codebase components.
25. **FR-25**: The system must tighten the existing built-in phone recognizer to require a minimum of 10 digits with valid separators (spaces, hyphens, dots, parentheses), reducing false positives on short digit sequences.
26. **FR-26**: The system must require explicit tenant acknowledgment before enabling cloud PII detection for a project. The acknowledgment must confirm that user message text will be sent to the configured third-party cloud API for PII detection. Cloud providers must not be activatable without this consent flag.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                   |
| -------------------------- | ------------ | --------------------------------------------------------------------------------------- |
| Agent lifecycle            | PRIMARY      | All agent messages now route through unified registry; cloud detection adds ML coverage |
| Customer experience        | PRIMARY      | Broader PII detection catches more sensitive data before user exposure                  |
| Governance / controls      | PRIMARY      | Analytics dashboard provides compliance visibility; cloud ML meets audit requirements   |
| Enterprise / compliance    | PRIMARY      | Cloud DLP integration is a common enterprise requirement for regulated deployments      |
| Observability / tracing    | PRIMARY      | New PII analytics pipeline, Observatory tab, ClickHouse materialized views              |
| Integrations / channels    | SECONDARY    | Cloud providers are external integrations with credential management                    |
| Project lifecycle          | SECONDARY    | Per-project cloud provider configuration and analytics                                  |
| Admin / operator workflows | SECONDARY    | Tenant admin cost/usage visibility for cloud PII APIs                                   |

### Related Feature Integration Matrix

| Related Feature    | Relationship Type | Why It Matters                                                                           | Key Touchpoints                                          | Current State      |
| ------------------ | ----------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------ |
| PII Detection      | extends           | This is a sub-feature enhancing the parent PII system                                    | All files in parent spec §10                             | BETA               |
| Guardrails         | extends           | `builtin-pii` provider will route through registry after unification                     | `builtin-pii.ts`, `provider-registry.ts`                 | Implemented        |
| KMS / Encryption   | depends on        | Cloud provider credentials stored via auth profiles, resolved through KMS/VaultProvider  | `vault/index.ts`, `model-resolution.ts`                  | Implemented        |
| Model Hub          | shares data with  | Cloud PII credential resolution follows the same auth profile pattern as LLM credentials | `model-resolution.ts`, `resolveAuthProfileCredentials()` | Implemented        |
| Tracing            | emits into        | PII analytics pipeline writes to ClickHouse alongside existing trace infrastructure      | `clickhouse.ts`, `BufferedClickHouseWriter`              | Implemented        |
| Observatory        | extends           | New `'pii'` tab added to existing Observatory debug panel                                | `observatory-store.ts`, `DebugTab` type                  | Implemented        |
| Session Management | shares data with  | Per-session registry overlay loads project-specific custom + cloud recognizers           | `pattern-loader.ts`, session init                        | Implemented        |
| NLU / Gathers      | configured by     | Gather exemption field mapping becomes configurable instead of hardcoded                 | `pii-guard.ts`, `resolveGatherExemptions()`              | Needs modification |
| Audit Logging      | shares data with  | PII dual-write uses same `BufferedClickHouseWriter` pattern as `audit_events` pipeline   | `clickhouse.ts`, `BufferedClickHouseWriter`              | Implemented        |

---

## 6. Design Considerations

### Registry Unification Architecture

```
Before (current — bypass):
  builtin-pii.ts ──> detectPII() ──> PII_PATTERNS (hardcoded)
  pii-vault.ts   ──> redactPII() ──> PII_PATTERNS (hardcoded)
  CEL functions  ──> detectPII() ──> PII_PATTERNS (hardcoded)
  pii-guard.ts   ──> detectPIISelective(registry) ──> PIIRecognizerRegistry ✓

After (unified):
  ALL consumers ──> detectPII(registry) ──> PIIRecognizerRegistry
                                              |-- builtin-email (regex, permanent)
                                              |-- builtin-ssn (regex, permanent)
                                              |-- builtin-ssn-undashed (regex, permanent)
                                              |-- builtin-credit-card (regex, permanent)
                                              |-- builtin-credit-card-amex (regex, permanent)
                                              |-- builtin-phone (regex, permanent)
                                              |-- builtin-phone-e164 (regex, permanent)
                                              |-- builtin-ip-address (regex, permanent)
                                              |-- builtin-ipv6 (regex, permanent)
                                              |-- builtin-iban (regex, permanent)
                                              |-- custom-<name> (custom, per-project, per-session)
                                              |-- cloud-google-dlp (cloud, per-project, per-session)
                                              |-- cloud-aws-comprehend (cloud, per-project, per-session)
                                              |-- cloud-azure-ai (cloud, per-project, per-session)
```

**Key change**: `pii-detector.ts` removes the `PII_PATTERNS` array and `detectWithLocalPatterns()` function. When `registry` parameter is `undefined`, it calls `getDefaultPIIRecognizerRegistry()` instead of falling back to local patterns. This is backward-compatible — the default registry has the same 5 (now 10) permanent built-in recognizers.

### Cloud PII Provider Architecture

```
CloudPIIRecognizer (abstract base)
  |-- googleDLPRecognizer (concrete)
  |-- awsComprehendRecognizer (concrete)
  |-- azureAILanguageRecognizer (concrete)

Each recognizer:
  1. Check circuit breaker (5 failures → open, 30s reset)
  2. Check Redis cache (sha256 key, 60s TTL)
  3. Check rate limit (per-tenant calls/min in Redis)
  4. Check cost budget (per-tenant monthly in Redis counter)
  5. Call cloud API with latency budget (default 500ms)
  6. Map response to PIIDetection[] (type, start, end, value)
  7. Cache result in Redis
  8. Return detections (or empty array on any failure — fail-open)
```

### PII Analytics Pipeline

```
Detection Event
  |
  v
PIIAuditLogger.log(entry)
  |-- MongoDB insert (existing, compliance — 90-day TTL)
  |-- ClickHouse insert via BufferedClickHouseWriter (new, analytics)

ClickHouse:
  pii_detections (raw events)
    |-- pii_detections_hourly (materialized view → AggregatingMergeTree)
    |-- pii_detections_daily (materialized view → AggregatingMergeTree)

Studio Observatory → 'pii' tab
  |-- GET /api/projects/:projectId/analytics/pii/summary (time range)
  |-- GET /api/projects/:projectId/analytics/pii/by-type (pie chart)
  |-- GET /api/projects/:projectId/analytics/pii/by-agent (table)
  |-- GET /api/projects/:projectId/analytics/pii/trend (time series)
  |-- GET /api/tenants/:tenantId/analytics/pii/overview (tenant-level)
```

---

## 7. Technical Considerations

- **Backward compatibility**: `PIIType` widening from closed union to `string` is additive. All existing code using `'email' | 'phone' | 'ssn' | 'credit_card' | 'ip_address'` continues to work. New cloud-detected types are additional string values.
- **Registry default behavior**: After unification, calling `detectPII(text)` without a registry parameter auto-resolves `getDefaultPIIRecognizerRegistry()`. The default registry has 10 permanent built-in recognizers (the original 5 plus 5 new ones). No code that calls `detectPII(text)` needs to change.
- **Cloud API SDK versions**: Google DLP (`@google-cloud/dlp` v5+), AWS Comprehend (`@aws-sdk/client-comprehend` v3+), Azure AI Language (`@azure/ai-text-analytics` v5+). All are peer dependencies — only installed when the provider is configured.
- **Cloud API text limits**: Google DLP max 500KB, AWS Comprehend max 100KB, Azure max 5120 chars per document. Texts exceeding limits must be chunked with boundary-aware splitting (no PII split across chunks).
- **Redis key namespace**: Cloud PII cache keys use prefix `pii:cache:<tenant_id>:`. Rate limit keys use `pii:rate:<tenant_id>:<provider>:`. Cost budget keys use `pii:cost:<tenant_id>:<provider>:<yyyy-mm>:`.
- **ClickHouse partitioning**: `pii_detections` table partitioned by `toYYYYMM(timestamp)`, ordered by `(tenant_id, project_id, timestamp)`. TTL: 30d warm, 90d cold, 730d delete (matching `messages` table).
- **Undashed SSN false positives**: 9-digit sequences are common (zip+4, part numbers). Area number validation (001-899 excluding 666) and group number validation (01-99) reduce false positives. A confidence score threshold may be needed.
- **IBAN validation**: ISO 7064 Mod 97 check digit verification is computationally trivial but prevents false positives on random alphanumeric sequences.

---

## 8. How to Consume

### Studio UI

New Observatory `'pii'` tab accessible from the debug panel when a session is active. Displays:

- **Detection volume chart**: Time series of PII detections over selected range
- **Type distribution**: Pie chart showing detection breakdown by PII type
- **Per-agent breakdown**: Table showing detection counts per agent
- **Trend lines**: Detection rate over time with optional anomaly highlighting
- **Cloud provider status**: Health indicators for configured cloud providers (circuit breaker state, cache hit rate, cost remaining)

Cloud provider configuration available in **Project Settings > PII Protection** tab (existing `PIIProtectionTab.tsx`) with new "Cloud Providers" section.

### API (Runtime)

| Method | Path                                              | Purpose                                 |
| ------ | ------------------------------------------------- | --------------------------------------- |
| GET    | `/api/projects/:projectId/analytics/pii/summary`  | Detection summary for time range        |
| GET    | `/api/projects/:projectId/analytics/pii/by-type`  | Detection counts by PII type            |
| GET    | `/api/projects/:projectId/analytics/pii/by-agent` | Detection counts by agent               |
| GET    | `/api/projects/:projectId/analytics/pii/trend`    | Time series detection data              |
| GET    | `/api/tenants/:tenantId/analytics/pii/overview`   | Tenant-level cross-project PII overview |
| GET    | `/api/projects/:projectId/pii-providers/status`   | Cloud provider health + circuit breaker |
| PUT    | `/api/projects/:projectId/pii-providers`          | Configure cloud PII providers           |

All analytics routes require `authMiddleware` + `tenantRateLimit('request')`. Analytics read requires `pii-analytics:read` permission. Provider config requires `pii-pattern:write` permission. Cross-tenant access returns 404.

### API (Studio)

Studio proxies PII analytics and provider config API calls to the Runtime endpoints above via `apiFetch()`.

### Admin Portal

Tenant-level PII analytics overview at `/api/tenants/:tenantId/analytics/pii/overview`. Cloud provider cost tracking per tenant.

### Channel / SDK / Voice / A2A / MCP Integration

No channel-specific changes. PII detection enhancements (registry unification, new regex, cloud providers) are applied at the runtime execution layer and affect all channels uniformly.

---

## 9. Data Model

### Collections / Tables

```text
Extended in project_runtime_configs.pii_redaction (IPIIRedactionConfig):
  + cloudProviders: [{
      provider: 'google_dlp' | 'aws_comprehend' | 'azure_ai_language',
      enabled: boolean,
      credentialId: string,  // references auth profile _id
      latencyBudgetMs: number (default: 500),
      rateLimitPerMinute: number (default: 100),
      monthlyBudgetCents: number (optional),
      region: string (optional),  // data residency — routes API calls to specified region
      config: {
        // Provider-specific:
        // google_dlp: { infoTypes?: string[], minLikelihood?: string }
        // aws_comprehend: { languageCode?: string }
        // azure_ai_language: { categories?: string[] }
      }
    }]
  + cloudPiiConsent: boolean (default: false)  // tenant must acknowledge external data processing before cloud providers can be activated (FR-26)
  + gatherExemptions: {
      fieldNameToType: Record<string, string>,      // e.g., { "phone_number": "phone" }
      entityTypeToType: Record<string, string>       // e.g., { "phone": "phone" }
    }

New ClickHouse table: pii_detections
Fields:
  - tenant_id: String
  - project_id: String
  - user_id: String
  - session_id: String
  - pii_type: LowCardinality(String)
  - detection_source: LowCardinality(String)  -- 'regex' | 'cloud' | 'custom'
  - provider: LowCardinality(String)           -- recognizer name
  - count: UInt32
  - latency_ms: Float32
  - agent_name: LowCardinality(String)
  - timestamp: DateTime64(3)
Partition: toYYYYMM(timestamp)
Order by: (tenant_id, project_id, user_id, timestamp)
TTL: timestamp + INTERVAL 30 DAY TO VOLUME 'warm',
     timestamp + INTERVAL 90 DAY TO VOLUME 'cold',
     timestamp + INTERVAL 730 DAY DELETE

New ClickHouse MV: pii_detections_hourly
  SELECT tenant_id, project_id, pii_type, detection_source, provider,
         toStartOfHour(timestamp) as hour,
         sumState(count) as total_count,
         avgState(latency_ms) as avg_latency,
         countState() as event_count
  FROM pii_detections
  GROUP BY tenant_id, project_id, pii_type, detection_source, provider, hour
  → AggregatingMergeTree ORDER BY (tenant_id, project_id, hour, pii_type)

New ClickHouse MV: pii_detections_daily
  (same structure, toStartOfDay aggregation)
```

### Key Relationships

- `project_runtime_configs.pii_redaction.cloudProviders[].credentialId` references auth profile `_id` — resolved via `resolveAuthProfileCredentials()` at session init
- `pii_detections.tenant_id` + `project_id` scopes analytics queries — same isolation as `messages` table
- `pii_detections.session_id` correlates with `messages.session_id` for drill-down
- Cloud PII rate limit and cost budget tracked in Redis (not persisted in MongoDB)

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                           | Purpose                                                                  | Change Type |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ----------- |
| `packages/compiler/src/platform/security/pii-recognizer-registry.ts`           | Add `'cloud'` to `RecognizerTier`, increase `MAX_RECOGNIZERS`            | Modify      |
| `packages/compiler/src/platform/security/pii-detector.ts`                      | Remove `PII_PATTERNS`, delegate to registry, widen `PIIType`             | Modify      |
| `packages/compiler/src/platform/security/cloud-pii-recognizer.ts`              | Abstract base: circuit breaker, Redis cache, rate limit, latency budget  | New         |
| `packages/compiler/src/platform/security/cloud-providers/google-dlp.ts`        | Google DLP concrete recognizer                                           | New         |
| `packages/compiler/src/platform/security/cloud-providers/aws-comprehend.ts`    | AWS Comprehend concrete recognizer                                       | New         |
| `packages/compiler/src/platform/security/cloud-providers/azure-ai-language.ts` | Azure AI Language concrete recognizer                                    | New         |
| `packages/compiler/src/platform/security/pii-vault.ts`                         | Pass registry to `detectPII()` calls instead of using direct patterns    | Modify      |
| `packages/compiler/src/platform/security/pii-audit.ts`                         | Add ClickHouse dual-write alongside MongoDB                              | Modify      |
| `packages/compiler/src/platform/guardrails/providers/builtin-pii.ts`           | Route through registry instead of calling `detectPII()` without registry | Modify      |
| `packages/compiler/src/platform/nlu/enterprise/pii-guard.ts`                   | Read gather exemptions from config instead of hardcoded maps             | Modify      |

### Routes / Handlers

| File                                                     | Purpose                                         | Change Type |
| -------------------------------------------------------- | ----------------------------------------------- | ----------- |
| `apps/runtime/src/routes/pii-analytics.ts`               | PII analytics API endpoints (5 routes)          | New         |
| `apps/runtime/src/routes/pii-providers.ts`               | Cloud provider config + health endpoints        | New         |
| `apps/runtime/src/services/pii/cloud-provider-loader.ts` | Load and register cloud recognizers per-session | New         |
| `apps/runtime/src/services/pii/pii-analytics-service.ts` | ClickHouse query service for PII analytics      | New         |

### UI Components

| File                                                              | Purpose                                                 | Change Type |
| ----------------------------------------------------------------- | ------------------------------------------------------- | ----------- |
| `apps/studio/src/components/observatory/PIIAnalyticsTab.tsx`      | Observatory PII tab with charts and tables              | New         |
| `apps/studio/src/components/settings/PIICloudProviderSection.tsx` | Cloud provider configuration in PII Protection settings | New         |
| `apps/studio/src/store/observatory-store.ts`                      | Add `'pii'` to `DebugTab` type                          | Modify      |

### Database / Schema

| File                                                           | Purpose                                                             | Change Type |
| -------------------------------------------------------------- | ------------------------------------------------------------------- | ----------- |
| `packages/database/src/models/project-runtime-config.model.ts` | Extend `IPIIRedactionConfig` with cloudProviders + gatherExemptions | Modify      |
| `packages/database/src/clickhouse-schemas/init.ts`             | Add `pii_detections` table + hourly/daily MVs                       | Modify      |

### Tests

| File                                                                                 | Type        | Coverage Focus                                                   |
| ------------------------------------------------------------------------------------ | ----------- | ---------------------------------------------------------------- |
| `packages/compiler/src/__tests__/security/pii-detector-unified.test.ts`              | unit        | Registry delegation, no local patterns, backward compat          |
| `packages/compiler/src/__tests__/security/pii-recognizer-registry-cloud.test.ts`     | unit        | Cloud tier registration, circuit breaker, cache, rate limit      |
| `packages/compiler/src/__tests__/security/cloud-providers/google-dlp.test.ts`        | unit        | DLP API mapping, error handling, Luhn/validation passthrough     |
| `packages/compiler/src/__tests__/security/cloud-providers/aws-comprehend.test.ts`    | unit        | Comprehend API mapping, error handling                           |
| `packages/compiler/src/__tests__/security/cloud-providers/azure-ai-language.test.ts` | unit        | Azure AI mapping, error handling                                 |
| `packages/compiler/src/__tests__/security/pii-recognizer-registry-enhanced.test.ts`  | unit        | New built-in recognizers (undashed SSN, Amex, E.164, IPv6, IBAN) |
| `apps/runtime/src/__tests__/pii-analytics.test.ts`                                   | integration | Analytics endpoints with real ClickHouse queries                 |
| `apps/runtime/src/__tests__/pii-cloud-providers.test.ts`                             | integration | Cloud provider loading, credential resolution, session lifecycle |
| `apps/runtime/src/__tests__/pii-pattern-crud-e2e.test.ts`                            | e2e         | Pattern CRUD with real Express, auth, MongoDB, tenant isolation  |
| `apps/runtime/src/__tests__/pii-unified-registry-e2e.test.ts`                        | e2e         | Full detection pipeline: custom + cloud + regex through real API |

---

## 11. Configuration

### Environment Variables

| Variable                       | Default | Description                                                   |
| ------------------------------ | ------- | ------------------------------------------------------------- |
| `PII_CLOUD_CACHE_TTL_MS`       | `60000` | Redis cache TTL for cloud PII API results                     |
| `PII_CLOUD_DEFAULT_TIMEOUT_MS` | `500`   | Default per-provider latency budget (overridable per-project) |

### Runtime Configuration

Extended `project_runtime_configs.pii_redaction`:

```typescript
interface IPIIRedactionConfig {
  enabled: boolean;
  redact_input: boolean;
  redact_output: boolean;
  // New fields:
  cloudProviders?: ICloudPIIProviderConfig[];
  gatherExemptions?: {
    fieldNameToType?: Record<string, string>;
    entityTypeToType?: Record<string, string>;
  };
}

interface ICloudPIIProviderConfig {
  provider: 'google_dlp' | 'aws_comprehend' | 'azure_ai_language';
  enabled: boolean;
  credentialId: string;
  latencyBudgetMs?: number;
  rateLimitPerMinute?: number;
  monthlyBudgetCents?: number;
  region?: string; // e.g., 'us-east1', 'eu-west1' — routes API calls to region for data residency
  config?: Record<string, unknown>;
}
```

### DSL / Agent IR / Schema

No DSL changes. Cloud PII providers are configured at the project level, not per-agent. The `builtin-pii` guardrail provider continues to work unchanged in GUARDRAILS sections — it just routes through the registry now.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement                                                                                                                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tenant isolation  | Cloud provider credentials resolved per-tenant via auth profiles. Redis cache/rate/cost keys namespaced by `tenant_id`. ClickHouse queries always include `tenant_id` WHERE clause. Monthly cost budget is a shared tenant resource — per-project rate limits prevent single-project exhaustion. |
| Project isolation | Cloud providers configured per-project. Per-session registry overlay isolates custom + cloud recognizers between projects. Per-project rate limits (calls/minute) prevent cross-project denial of service. Analytics queries include `project_id`.                                               |
| User isolation    | Per-session cloud API call limits (50/session default) prevent single-user budget exhaustion. ClickHouse `pii_detections` includes `user_id` for per-user analytics scoping. Vault is per-session. Audit logs include `sessionId`.                                                               |

### Security & Compliance

- Cloud API credentials stored in auth profiles, resolved via KMS/VaultProvider — never in plaintext config
- Cloud PII detection results (type + position only) cached in Redis — raw text NEVER cached
- PII analytics in ClickHouse contain type names and counts only — never raw PII values
- Cloud API calls use TLS
- IBAN check digit verification (ISO 7064 Mod 97) prevents false positives on random strings
- Undashed SSN area/group validation reduces false positives on 9-digit sequences

#### Cloud Provider Data Handling

When cloud PII detection is enabled, user message text is sent to third-party cloud APIs for analysis. This has regulatory implications:

1. **Consent requirement (FR-26)**: Tenants must explicitly acknowledge and consent to external data processing before cloud PII providers can be activated. A `cloudPiiConsent` flag in tenant settings gates activation. Without consent, cloud provider configuration returns a 403 with an explanation.
2. **Data Processing Agreements (DPAs)**: Tenants are responsible for having DPAs in place with their chosen cloud provider. The configuration UI must display a notice linking to each provider's DPA terms:
   - Google DLP: processes data transiently with no customer data retention (per Google Cloud DPA)
   - AWS Comprehend: processes data in-transit, no storage beyond processing (per AWS DPA)
   - Azure AI Language: processes data in the configured region, no retention beyond processing (per Microsoft DPA)
3. **Data residency**: Cloud provider configuration includes an optional `region` field. The system must route API calls to the specified region endpoint to satisfy data residency requirements (e.g., EU-only processing for GDPR).
4. **Minimization**: Only the text content is sent to cloud APIs — no tenant IDs, session IDs, user IDs, or metadata. The text is the minimum needed for PII detection.
5. **Air-gapped deployments**: When no internet access is available, cloud PII providers cannot function. The system must operate in regex-only mode without errors (see GAP-E02).

### Performance & Scalability

- Registry unification: ~0 latency impact. Built-in regex detection remains sub-millisecond.
- Cloud providers: 50-200ms per call. Mitigated by 60s Redis cache (expect 60-80% hit rate for conversational sessions), circuit breaker, and latency budget abort.
- New regex recognizers (5 additional): ~0.5ms additional per detection call. Total still under 2ms for all 10 built-in recognizers.
- ClickHouse writes: `BufferedClickHouseWriter` batches at 10K rows or 5s intervals. No impact on request path latency.
- Analytics queries: Hourly/daily MVs ensure dashboard queries scan aggregated data, not raw events. Expected sub-second for 90-day ranges.
- Vault batch eviction: 10% eviction (1000 entries) is O(n) sort by insertion order but only triggers at capacity — no steady-state impact.

### Reliability & Failure Modes

- Cloud provider failures: Circuit breaker (5 failures → open, 30s reset) with fail-open to regex-only. Logged as `pii_cloud_degraded` trace event.
- Redis cache failures: Continue without caching — cloud API called directly. Logged as `pii_cache_unavailable`.
- Rate limit exhaustion: Fall back to regex-only. Logged as `pii_rate_limit_exceeded`.
- Cost budget exhaustion: Fall back to regex-only for remainder of month. Logged as `pii_cost_budget_exceeded`.
- ClickHouse write failures: `BufferedClickHouseWriter` retries 3x then drops batch. MongoDB writes are unaffected. Analytics data is eventually consistent, not authoritative for compliance.

### Observability

- Cloud provider circuit breaker state changes logged via `pii-cloud` logger prefix
- Redis cache hit/miss rates tracked as metrics (`pii_cloud_cache_hit`, `pii_cloud_cache_miss`)
- Cloud API latency tracked per call, aggregated in ClickHouse `pii_detections.latency_ms`
- Rate limit and cost budget status visible via `/api/projects/:projectId/pii-providers/status`
- Detection source breakdown (regex vs cloud vs custom) visible in Observatory `'pii'` tab
- Registry recognizer count and tier breakdown logged at session init

### Data Lifecycle

- **ClickHouse `pii_detections`**: 30d warm, 90d cold, 730d delete (matching `messages` table). No PII values stored — only type names and counts.
- **Redis cache**: 60s TTL auto-expiry. No manual cleanup needed.
- **Redis rate limit counters**: 1-minute sliding window with auto-expiry. Monthly cost counters expire at month end.
- **Cloud provider config**: Persisted in `project_runtime_configs`. No automatic expiry — managed by project builders.
- **Parent feature data lifecycle unchanged**: MongoDB audit logs (90d TTL), vault per-session, patterns no expiry.

---

## 13. Delivery Plan / Work Breakdown

1. **Registry Unification** (GAP-013, GAP-014)
   1.1 Widen `PIIType` from closed union to `string` with well-known constants in `pii-detector.ts`
   1.2 Add `'cloud'` to `RecognizerTier` in `pii-recognizer-registry.ts`
   1.3 Remove `PII_PATTERNS` array and `detectWithLocalPatterns()` from `pii-detector.ts`; delegate to `getDefaultPIIRecognizerRegistry()`
   1.4 Update `redactPII()` to accept optional `registry` parameter
   1.5 Update `BuiltinPIIProvider.evaluate()` to use `getDefaultPIIRecognizerRegistry()`
   1.6 Update `PIIVault` to accept and use registry parameter
   1.7 Update CEL function bindings (`abl.contains_pii`, `abl.redact_pii`) to use registry
   1.8 Update all existing tests to verify registry-based detection
   1.9 Increase `MAX_RECOGNIZERS` from 50 to 100 to accommodate cloud providers

2. **Regex Enhancements** (GAP-009, GAP-010, GAP-011, GAP-012, GAP-003 partial)
   2.1 Add `builtin-ssn-undashed` recognizer with area/group validation
   2.2 Add `builtin-credit-card-amex` recognizer for 15-digit Amex with Luhn
   2.3 Extend existing credit card recognizer to also match 13-digit legacy Visa
   2.4 Add `builtin-phone-e164` recognizer for E.164 international format
   2.5 Add `builtin-ipv6` recognizer (full, compressed, IPv4-mapped notation)
   2.6 Add `builtin-iban` recognizer with country code + ISO 7064 Mod 97 check digit validation
   2.7 Update `REDACT_LABELS` map for new types
   2.8 Unit tests for all new recognizers with edge cases

3. **Cloud PII Provider Infrastructure**
   3.1 Create `CloudPIIRecognizer` abstract base class with circuit breaker, Redis cache, rate limit, latency budget
   3.2 Implement `GoogleDLPRecognizer` with `@google-cloud/dlp` SDK
   3.3 Implement `AWSComprehendRecognizer` with `@aws-sdk/client-comprehend` SDK
   3.4 Implement `AzureAILanguageRecognizer` with `@azure/ai-text-analytics` SDK
   3.5 Extend `IPIIRedactionConfig` with `cloudProviders` array
   3.6 Create `cloud-provider-loader.ts` in runtime to register cloud recognizers per-session
   3.7 Add cloud provider config + health API routes
   3.8 Unit tests for each cloud recognizer (mock only external HTTP calls via DI)
   3.9 Integration tests for cloud provider loading with credential resolution
   3.10 Implement tenant consent gate for cloud PII activation (FR-26): `cloudPiiConsent` flag in project runtime config, consent check in cloud provider config PUT endpoint, consent acknowledgment UI in Studio

4. **PII Analytics Pipeline**
   4.1 Add `pii_detections` table to ClickHouse schema init
   4.2 Add `pii_detections_hourly` and `pii_detections_daily` materialized views
   4.3 Create `BufferedClickHouseWriter<PIIDetectionRow>` instance in runtime
   4.4 Extend `PIIAuditLogger` with dual-write to ClickHouse
   4.5 Create `pii-analytics-service.ts` for ClickHouse query logic
   4.6 Add PII analytics REST API routes (5 endpoints)
   4.7 Integration tests for analytics pipeline with real ClickHouse

5. **Studio UI — Observatory PII Tab**
   5.1 Add `'pii'` to `DebugTab` type in `observatory-store.ts`
   5.2 Create `PIIAnalyticsTab.tsx` with time series, pie chart, per-agent table, trend lines
   5.3 Create `PIICloudProviderSection.tsx` for cloud provider config in PII Protection settings
   5.4 Wire analytics API calls to Studio store

6. **Low-Priority Fixes** (GAP-004, GAP-006, GAP-007)
   6.1 Tighten phone regex to reduce false positives (minimum 10 digits with separators)
   6.2 Make gather exemption field mapping configurable via `pii_redaction.gatherExemptions`
   6.3 Change vault `evictIfNeeded()` to batch-evict 10% at capacity

7. **E2E Tests** (GAP-008)
   7.1 PII pattern CRUD E2E with RuntimeApiHarness, real auth, tenant isolation
   7.2 Unified registry E2E — custom + cloud + regex through real HTTP API
   7.3 Cloud provider health/status E2E with real middleware chain
   7.4 PII analytics API E2E with time-range filtering and tenant isolation
   7.5 New regex recognizers E2E — undashed SSN, Amex, E.164, IPv6, IBAN through HTTP test endpoint

---

## 14. Success Metrics

| Metric                       | Baseline         | Target               | How Measured                                                                                                                                              |
| ---------------------------- | ---------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Built-in PII types           | 5                | 10                   | Count of permanent recognizers in default registry                                                                                                        |
| Detection paths via registry | 1/4 (NLU only)   | 4/4 (all consumers)  | Code audit: all consumers route through registry                                                                                                          |
| Duplicate regex definitions  | 2 (detector+reg) | 0                    | Single source of truth in registry                                                                                                                        |
| Cloud PII types detectable   | 0                | 50+ (via Google DLP) | Cloud provider info type count                                                                                                                            |
| Cloud detection latency p99  | N/A              | < 500ms              | ClickHouse `pii_detections.latency_ms` percentile                                                                                                         |
| Cloud cache hit rate         | N/A              | > 60%                | Redis `pii_cloud_cache_hit` / total                                                                                                                       |
| Analytics query latency      | N/A              | < 1s for 90d range   | ClickHouse query profiling on MV tables                                                                                                                   |
| E2E test coverage (PII)      | 1 scenario       | 5+ scenarios         | Test file count with `e2e` type in test spec                                                                                                              |
| Parent spec gaps resolved    | 0/15             | 12/15                | GAP status in parent feature spec (GAP-002 WONTFIX, GAP-003 partial — E.164+IBAN added but full intl coverage requires cloud providers, GAP-005 deferred) |

---

## 15. Open Questions

1. Should cloud PII SDKs be bundled as direct dependencies or loaded dynamically to reduce package size for tenants that don't use cloud detection?
2. Should the PII analytics dashboard support custom alert thresholds (e.g., alert when detection volume spikes 3x above 7-day average)?
3. Should cloud PII detection results influence the confidence/severity score reported by the `builtin-pii` guardrail provider?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                            | Severity | Status |
| ------- | ---------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-E01 | Cloud PII SDKs add significant dependency weight (~50MB per provider). Dynamic loading may be needed.                  | Medium   | Open   |
| GAP-E02 | Cloud PII APIs require internet access. Air-gapped deployments must rely on regex-only detection.                      | Low      | Known  |
| GAP-E03 | Undashed SSN (`123456789`) has higher false positive risk on 9-digit sequences. May need confidence scoring.           | Medium   | Open   |
| GAP-E04 | Cloud PII API pricing varies by volume. Cost budget tracking is approximate (based on call count, not actual invoice). | Low      | Known  |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                          | Coverage Type | Status     | Test File / Note                                                            |
| --- | ------------------------------------------------- | ------------- | ---------- | --------------------------------------------------------------------------- |
| 1   | Registry unification — all consumers use registry | unit          | NOT TESTED | `pii-detector-unified.test.ts`                                              |
| 2   | Duplicate pattern elimination — no PII_PATTERNS   | unit          | NOT TESTED | `pii-detector-unified.test.ts`                                              |
| 3   | Undashed SSN detection + area/group validation    | unit          | NOT TESTED | `pii-recognizer-registry-enhanced.test.ts`                                  |
| 4   | Amex 15-digit + legacy Visa 13-digit + Luhn       | unit          | NOT TESTED | `pii-recognizer-registry-enhanced.test.ts`                                  |
| 5   | E.164 international phone detection               | unit          | NOT TESTED | `pii-recognizer-registry-enhanced.test.ts`                                  |
| 6   | IPv6 full + compressed + IPv4-mapped              | unit          | NOT TESTED | `pii-recognizer-registry-enhanced.test.ts`                                  |
| 7   | IBAN detection + Mod 97 validation                | unit          | NOT TESTED | `pii-recognizer-registry-enhanced.test.ts`                                  |
| 8   | Cloud recognizer circuit breaker + fallback       | unit          | NOT TESTED | `pii-recognizer-registry-cloud.test.ts`                                     |
| 9   | Cloud recognizer Redis cache hit/miss             | unit          | NOT TESTED | `pii-recognizer-registry-cloud.test.ts`                                     |
| 10  | Cloud recognizer rate limit + cost budget         | unit          | NOT TESTED | `pii-recognizer-registry-cloud.test.ts`                                     |
| 11  | Google DLP response mapping to PIIDetection[]     | unit          | NOT TESTED | `cloud-providers/google-dlp.test.ts`                                        |
| 12  | AWS Comprehend response mapping                   | unit          | NOT TESTED | `cloud-providers/aws-comprehend.test.ts`                                    |
| 13  | Azure AI Language response mapping                | unit          | NOT TESTED | `cloud-providers/azure-ai-language.test.ts`                                 |
| 14  | Cloud provider loading + credential resolution    | integration   | NOT TESTED | `pii-cloud-providers.test.ts`                                               |
| 15  | ClickHouse pii_detections write + read            | integration   | NOT TESTED | `pii-analytics.test.ts`                                                     |
| 16  | PII analytics API endpoints with time-range       | integration   | NOT TESTED | `pii-analytics.test.ts`                                                     |
| 17  | Dual-write audit logger (MongoDB + ClickHouse)    | integration   | NOT TESTED | `pii-analytics.test.ts`                                                     |
| 18  | PII pattern CRUD E2E with real auth + isolation   | e2e           | NOT TESTED | `pii-pattern-crud-e2e.test.ts`                                              |
| 19  | Unified registry E2E — custom + regex through API | e2e           | NOT TESTED | `pii-unified-registry-e2e.test.ts`                                          |
| 20  | Gather exemption config via runtime config        | integration   | NOT TESTED | `pii-cloud-providers.test.ts`                                               |
| 21  | Vault batch eviction at capacity                  | unit          | NOT TESTED | `pii-vault.test.ts` (extend existing)                                       |
| 22  | Observatory PII tab renders with mock data        | unit          | NOT TESTED | `apps/studio/src/__tests__/components/observatory/PIIAnalyticsTab.test.tsx` |

### Testing Notes

No tests exist for this enhancement yet (status: PLANNED). Unit tests will cover all new recognizers, cloud provider mapping, and circuit breaker logic. Integration tests will exercise the ClickHouse pipeline, cloud provider loading, and analytics endpoints. E2E tests will use `RuntimeApiHarness` with real Express, MongoDB, and auth middleware — no mocks of codebase components. Cloud API HTTP calls will be mocked via DI (external third-party services only).

> Full testing details: `../../testing/sub-features/pii-detection-enhancements.md`

---

## 18. References

- Parent feature: [PII Detection & Redaction](../pii-detection.md)
- Parent HLD: `docs/specs/pii-detection.hld.md`
- Parent plans: `docs/plans/2026-03-08-pii-phase2-plan.md`, `docs/plans/2026-03-09-pii-enhancements-design.md`
- Guardrails integration: [Guardrails](../guardrails.md) (builtin-pii provider)
- Analytics pipeline skill: `.claude/skills/analytics-pipeline-development.md`
- ClickHouse schema: `packages/database/src/clickhouse-schemas/init.ts`
- Observatory: `apps/studio/src/store/observatory-store.ts`
- Cloud provider APIs: [Google DLP](https://cloud.google.com/sensitive-data-protection/docs), [AWS Comprehend PII](https://docs.aws.amazon.com/comprehend/latest/dg/how-pii.html), [Azure AI Language PII](https://learn.microsoft.com/en-us/azure/ai-services/language-service/personally-identifiable-information/overview)
