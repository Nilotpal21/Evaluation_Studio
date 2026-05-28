# Feature: PII Detection & Redaction

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: BETA
**Feature Area(s)**: `governance`, `customer experience`, `enterprise`, `agent lifecycle`
**Package(s)**: `packages/compiler`, `apps/runtime`, `packages/database`, `apps/studio`, `packages/eventstore`
**Owner(s)**: `Platform Team`
**Testing Guide**: `../testing/pii-detection.md`
**Last Updated**: 2026-05-09

---

## 1. Introduction / Overview

### Problem Statement

LLM-powered agents routinely handle user messages containing personally identifiable information (PII) such as email addresses, phone numbers, Social Security Numbers, and credit card numbers. Without systematic detection and redaction, this PII flows unprotected through LLM inference, tool calls, logs, and persistent storage -- creating regulatory risk (GDPR, CCPA, HIPAA), credential exposure, and data breach liability. Competitors like Decagon and Sierra treat PII handling as table stakes; ABL must match or exceed this standard.

### Goal Statement

Provide a configurable, multi-layered PII detection and redaction system that protects sensitive data across the entire agent execution lifecycle -- from user input through LLM processing, tool execution, streaming output, and audit logging -- while allowing authorized consumers (tools, users) to access original values through a reversible tokenization vault with per-consumer rendering controls.

### Summary

PII Detection & Redaction is a cross-cutting security feature integrated into the ABL compiler and runtime. The system consists of:

1. **Pluggable recognizer registry** with the `core` pack (5 enhanced built-in regex recognizers — email, phone, SSN, credit card, IP) plus seven additional opt-in packs (`us`, `eu`, `apac`, `financial`, `medical`, `network`, `international-phone`) covering 40+ entity types, and support for custom project-scoped patterns. Detections carry `confidence` + `recognizer` metadata. (`packages/compiler/src/platform/security/pii-recognizer-registry.ts`, `recognizer-packs/`). See sub-feature: [PII Detection Tiered Recognizers](sub-features/pii-detection-tiered-recognizers.md) (ALPHA 05-09).
2. **Reversible tokenization vault** that replaces PII with `{{PII:<type>:<uuid>}}` tokens for LLM processing and restores original values for authorized consumers (`packages/compiler/src/platform/security/pii-vault.ts`)
3. **Configurable per-consumer rendering** with 5 modes: original, masked, redacted, tokenized, random (`resolveRenderMode()` in `pii-vault.ts`)
4. **Output PII filtering** that redacts agent responses before delivery (`apps/runtime/src/services/execution/output-pii-filter.ts`)
5. **Streaming PII buffer** that handles detection across chunk boundaries via a 40-character trailing buffer (`packages/compiler/src/platform/security/streaming-pii-buffer.ts`)
6. **Encrypted vault persistence** for session continuity using AES-256-GCM with tenant-scoped keys (`packages/compiler/src/platform/security/encrypted-vault.ts`)
7. **Audit logging** for compliance tracking with 90-day TTL retention (`packages/compiler/src/platform/security/pii-audit.ts`, `packages/database/src/models/pii-audit-log.model.ts`)
8. **Custom pattern management** via Studio UI and REST API with CRUD + test endpoints (`apps/runtime/src/routes/pii-patterns.ts`, `apps/studio/src/components/settings/PIIProtectionTab.tsx`)
9. **Guardrail integration** as a zero-cost Tier 1 provider (`packages/compiler/src/platform/guardrails/providers/builtin-pii.ts`)
10. **Trace scrubbing** that applies PII redaction to tool call trace data (`packages/compiler/src/platform/constructs/executors/trace-scrubber.ts`)
11. **Runtime read-boundary protection** so session detail, message history, trace list, and span-child APIs return the same redacted representation as live chat.
12. **Durable encrypted reveal vault** (`PIITokenVault`) for post-session audited reveal without making messages, traces, or normal session APIs raw-value sources.
13. **Explicit admin reveal workflow** through exact `pii:reveal` permission, reason/ticket audit metadata, Runtime reveal endpoint, and Studio message-scoped reveal modal.

---

## 2. Scope

### Goals

- Regex-based PII detection for 5 built-in types with Luhn validation (credit cards) and range validation (IPs, phones)
- Pluggable recognizer registry supporting regex, ML, and custom tiers with max 50 recognizer capacity
- Custom project-scoped patterns with configurable regex + optional validator expressions
- Reversible tokenization vault with per-consumer rendering (LLM sees tokens, users see masked, logs see redacted, tools see originals)
- Configurable input and output redaction via project runtime config (`pii_redaction.enabled`, `redact_input`, `redact_output`)
- Context-aware exemptions: PII types matching active gather fields are exempt from redaction during entity extraction
- Configurable masking (showFirst, showLast, maskChar) and random replacement (charset, length) per pattern
- Streaming PII buffer for chunk-boundary detection in streaming responses
- Encrypted vault serialization for session persistence using tenant-scoped AES-256-GCM
- PII audit logging with TTL-based retention (default 90 days)
- Custom pattern management via Studio UI with live regex testing
- Integration as a Tier 1 guardrail provider (`builtin-pii`) with circuit breaker protection
- Trace scrubbing for tool call data in observability pipelines

### Non-Goals (Out of Scope)

- ML/NER-based PII recognition (recognizer registry supports `ml` tier but no ML recognizers are currently implemented)
- Image/audio PII detection (attachment PII is text-extraction only)
- Cross-session PII correlation or deduplication
- PII discovery scanning of stored historical data
- Legacy backfill/migration for sessions created before durable reveal-vault provenance existed. Such sessions may be non-revealable and are not migrated as part of ABLP-535.
- International PII patterns beyond US formats (EU national IDs, IBAN, NHS numbers)
- Real-time PII classification model training
- PII analytics dashboard (detection frequency, type distribution)

---

## 3. User Stories

1. As a **project builder**, I want PII in user messages to be automatically redacted before reaching the LLM so that sensitive data is not leaked through inference.
2. As a **project builder**, I want PII in agent responses to be redacted before delivery so that sensitive data is not displayed in chat transcripts.
3. As a **project builder**, I want to define custom PII patterns for domain-specific data (e.g., internal employee IDs, policy numbers, medical record numbers) so that organization-specific PII is detected.
4. As a **tool developer**, I want tools to receive original (unredacted) PII values so that API calls and lookups work correctly.
5. As a **compliance officer**, I want all PII access events to be audit-logged with retention controls so that we can demonstrate regulatory compliance.
6. As a **project builder**, I want to test PII patterns against sample text before deploying them so that I can verify detection accuracy and see consumer previews.
7. As an **operations engineer**, I want PII to be redacted in logs and trace data regardless of consumer type so that log aggregation systems never contain sensitive data.
8. As a **project builder**, I want PII detection to not block entity extraction during gathers so that data collection flows work naturally even when PII redaction is enabled.
9. As a **platform operator**, I want PII vault data to be encrypted at rest with tenant-scoped keys so that vault persistence meets enterprise security requirements.
10. As a **project builder**, I want to configure per-pattern masking rules (e.g., show last 4 digits of a phone number) so that users see enough context without full PII exposure.

---

## 4. Functional Requirements

1. **FR-1**: The system must detect email, phone, SSN, credit card, and IP address patterns in text using regex with validation (Luhn for credit cards, 0-255 range for IPs, 10-15 digit count for phones).
2. **FR-2**: The system must support custom PII patterns scoped to tenant + project with configurable regex, optional validator expression, and redaction strategy.
3. **FR-3**: The system must tokenize detected PII into reversible `{{PII:<type>:<uuid>}}` tokens for LLM processing and store originals in a session-scoped vault.
4. **FR-4**: The system must render PII differently per consumer: LLM (tokenized), user (masked), logs (redacted), tools (original) -- with override capability via per-pattern consumer access rules.
5. **FR-5**: The system must support 3 redaction modes per pattern: predefined label (`[REDACTED_*]`), masked (configurable showFirst/showLast/maskChar), and random replacement (configurable charset/length).
6. **FR-6**: The system must filter PII from agent output when `redactOutput` is enabled in project runtime config, supporting both legacy (destructive) and vault-aware (reversible) modes.
7. **FR-7**: The system must detect PII across streaming chunk boundaries using a trailing buffer of 40 characters.
8. **FR-8**: The system must encrypt vault contents for session persistence using the platform's tenant-scoped AES-256-GCM encryption service.
9. **FR-9**: The system must audit-log PII access events (tokenize, detokenize, render, clear) with configurable retention TTL (default 90 days) using a buffered fire-and-forget logger.
10. **FR-10**: The system must validate custom pattern regex for compilation errors, catastrophic backtracking risk (nested quantifiers), and maximum length (2048 chars).
11. **FR-11**: The system must provide a pattern test endpoint that returns detection matches and consumer preview renderings for sample text.
12. **FR-12**: The system must exempt PII types that match active gather fields during entity extraction (context-aware exemption via `resolveGatherExemptions()`).
13. **FR-13**: The system must integrate as a zero-cost Tier 1 guardrail provider (`builtin-pii`) in the guardrail pipeline with circuit breaker protection.
14. **FR-14**: The system must scrub PII from tool call trace data before it reaches observability systems.
15. **FR-15**: The system must enforce vault capacity limits (10K tokens max with LRU eviction) and recognizer registry limits (50 max with non-permanent eviction).
16. **FR-16**: Normal session, message-history, trace-list, and span-child read APIs must apply PII/secrets read-boundary protection and must not expose raw originals.
17. **FR-17**: Raw admin reveal must be available only through a dedicated audited endpoint requiring exact `pii:reveal`, project scope, reason, and selected token/message scope.
18. **FR-18**: Durable reveal originals must be encrypted in `PIITokenVault`, scoped by tenant/project/session, erased with their owning scope, and read only by the reveal service.
19. **FR-19**: Studio reveal UX must be permission-gated, message-scoped, audited, and ephemeral, with raw values cleared on modal close or session/message changes.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                    |
| -------------------------- | ------------ | ------------------------------------------------------------------------ |
| Agent lifecycle            | PRIMARY      | Every agent message triggers PII detection on input/output               |
| Customer experience        | PRIMARY      | Controls what PII users see in responses; masked rendering for user view |
| Governance / controls      | PRIMARY      | Core compliance feature for regulated deployments (GDPR, CCPA, HIPAA)    |
| Enterprise / compliance    | PRIMARY      | Audit logging, encrypted vault persistence, TTL retention, tenant-scoped |
| Observability / tracing    | SECONDARY    | PII types logged as trace metadata; trace scrubber removes raw PII       |
| Integrations / channels    | SECONDARY    | PII handling is channel-agnostic via execution layer                     |
| Project lifecycle          | SECONDARY    | Custom patterns are project-scoped resources managed via Studio UI       |
| Admin / operator workflows | NONE         | PII patterns are project-scoped, not tenant/admin-scoped                 |

### Related Feature Integration Matrix

| Related Feature    | Relationship Type | Why It Matters                                                                     | Key Touchpoints                                     | Current State |
| ------------------ | ----------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------- | ------------- |
| Guardrails         | extends           | `builtin-pii` is a Tier 1 guardrail provider in the pipeline                       | `provider-registry.ts`, `builtin-pii.ts`            | Implemented   |
| KMS / Encryption   | depends on        | Vault encryption uses `VaultEncryptionService` with tenant-scoped AES-256-GCM keys | `encrypted-vault.ts`                                | Implemented   |
| Session Management | shares data with  | PII vault is serialized/encrypted per session for continuity across turns          | Session store, `pii-vault.ts` serialize/deserialize | Implemented   |
| Tracing            | emits into        | Trace scrubber applies `redactPII()` to tool call data                             | `trace-scrubber.ts`                                 | Implemented   |
| NLU / Gathers      | configured by     | PII guard exempts types matching active gather fields                              | `pii-guard.ts`, `resolveGatherExemptions()`         | Implemented   |
| Attachments        | integrates        | Multimodal service runs PII detection on extracted attachment text                 | `attachment-preprocessor`                           | Implemented   |
| EventStore         | configured by     | Event registry tracks `containsPII` metadata and has PII retention policy          | `event-retention-service.ts`, `piiRetentionDays`    | Implemented   |

---

## 6. Design Considerations

### Detection Architecture

```
User Input
    |
    v
[PIIRecognizerRegistry]
    |-- builtin-email (regex, permanent)
    |-- builtin-ssn (regex, permanent)
    |-- builtin-credit-card (regex + Luhn, permanent)
    |-- builtin-phone (regex + digit count, permanent)
    |-- builtin-ip-address (regex + octet range, permanent)
    |-- custom-<name> (regex + optional validator, per-project, loaded at session init)
    |
    v
[detectPIISelective(text, exemptTypes, registry)]
    |-- Detects ALL types for audit (OWASP LLM02 compliance)
    |-- Splits exempt vs redact based on exemptTypes set
    |-- Overlap removal: keep first/longer match
    |
    v
[PIIVault.tokenize()]
    |-- Replaces non-exempt PII with {{PII:<type>:<uuid>}} tokens
    |-- Stores originals in in-memory Map (max 10K, oldest-first eviction)
    |
    v
[Consumer Rendering via resolveRenderMode()]
    |-- Resolution chain: per-consumer override -> pattern defaultRenderMode -> builtin defaults
    |-- LLM:   {{PII:PHONE:abc123}}       (tokenized -- preserves semantic meaning)
    |-- User:  ***-***-4567                (masked -- configurable showFirst/showLast/maskChar)
    |-- Logs:  [REDACTED_PHONE]            (redacted -- always safe for log aggregation)
    |-- Tools: +1-555-123-4567             (original -- enables API calls and lookups)
```

### Streaming PII Detection

The `StreamingPIIBuffer` (in `streaming-pii-buffer.ts`) maintains a trailing 40-character buffer across chunks. This handles PII patterns that span chunk boundaries (e.g., a phone number split between two streaming chunks). Each chunk is prepended with the buffer, PII detection runs on the combined text, and only the safe prefix (before the trailing buffer) is emitted. On stream end, `flush()` processes the remaining buffer.

### Detection Coverage Analysis (as of 2026-03-27)

The 5 built-in regex recognizers in `pii-detector.ts` have the following coverage characteristics:

| PII Type    | Regex Pattern                                | Validators        | Catches                                     | Misses                                                      |
| ----------- | -------------------------------------------- | ----------------- | ------------------------------------------- | ----------------------------------------------------------- |
| email       | Standard RFC-like email regex                | None              | Most standard email formats                 | Edge cases (quoted local parts, IP domain literals)         |
| ssn         | `\b\d{3}-\d{2}-\d{4}\b`                      | None              | Dashed SSN only (`123-45-6789`)             | Undashed SSN (`123456789`), space-separated (`123 45 6789`) |
| phone       | US-centric with optional `+1`/`1-`           | 10-15 digit count | US/NANP phone numbers                       | International formats (UK `+44`, India `+91`, etc.)         |
| credit_card | `\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b` | Luhn checksum     | 16-digit cards (Visa, Mastercard, Discover) | 15-digit Amex, 13-digit old Visa, 19-digit extended cards   |
| ip_address  | `\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b`     | 0-255 octet range | IPv4 addresses                              | IPv6 addresses (`::1`, `fe80::`, full notation)             |

**PII types not detected by any built-in recognizer:** names, physical addresses, dates of birth, passport numbers, driver's license numbers, bank account/routing numbers, health IDs (NHS, Medicare), tax IDs (ITIN, EIN), VINs, biometric identifiers.

### Architecture Inconsistency: Registry Bypass

The `PIIRecognizerRegistry` (`pii-recognizer-registry.ts`) was designed as a pluggable, extensible detection registry supporting regex/ml/custom tiers. However, three key consumers bypass it entirely:

1. **`builtin-pii` guardrail provider** (`builtin-pii.ts`): Calls `detectPII()` from `pii-detector.ts` directly, not through the registry
2. **`PIIVault`** (`pii-vault.ts`): Uses `redactPII()` from `pii-detector.ts` directly
3. **CEL functions** (`abl.contains_pii()`, `abl.redact_pii()`): Call `detectPII()`/`redactPII()` from `pii-detector.ts` directly

Only the NLU PII Guard path (`pii-guard.ts` → `detectPIISelective()`) uses the registry. This means custom recognizers registered via `loadProjectPIIPatterns()` are only active in the NLU path, not in guardrail evaluation, vault tokenization, or CEL expressions.

Additionally, the 5 regex patterns are defined identically in both `pii-detector.ts` and `pii-recognizer-registry.ts` — a DRY violation that risks drift if one is updated without the other.

### Enhancement Roadmap

| Timeframe   | Enhancement                                                          | Effort | Impact |
| ----------- | -------------------------------------------------------------------- | ------ | ------ |
| Short-term  | Unify `pii-detector.ts` patterns through `PIIRecognizerRegistry`     | S      | High   |
| Short-term  | Add undashed SSN pattern (`\b\d{9}\b` with area/group validation)    | XS     | Medium |
| Short-term  | Extend credit card regex for 15-digit Amex and 13-digit cards        | XS     | Medium |
| Short-term  | Add IPv6 regex recognizer                                            | S      | Low    |
| Short-term  | Add international phone prefixes (E.164 format)                      | S      | Medium |
| Medium-term | Presidio sidecar (Python NER service) for names, addresses, DOB      | L      | High   |
| Medium-term | Route all consumers through registry (fix bypass inconsistency)      | M      | High   |
| Long-term   | Google DLP API integration for production-grade ML detection         | XL     | High   |
| Long-term   | Domain-specific recognizer packs (healthcare, financial, government) | L      | Medium |

### Context-Aware Exemptions

The `createPIIGuardHook()` in `pii-guard.ts` resolves which PII types should be exempt from redaction based on active gather fields. For example, if the agent is gathering a `phone_number` entity, phone PII is exempt from redaction so entity extraction works. This uses two mapping tables: `FIELD_NAME_TO_PII_TYPE` (e.g., `phone_number` -> `phone`) and `ENTITY_TYPE_TO_PII_TYPE` (e.g., entity type `phone` -> PII type `phone`).

---

## 7. Technical Considerations

- **Regex safety**: Custom patterns are validated for compilation errors and catastrophic backtracking (nested quantifiers like `(.+)+`) before storage. The `CATASTROPHIC_BACKTRACKING_PATTERNS` array in `pattern-service.ts` catches common ReDoS vectors.
- **Sandbox security**: Custom validator expressions are restricted to regex-only execution (no arbitrary JavaScript). The `buildSandboxedValidator()` function in `pattern-loader.ts` compiles the expression as a `RegExp` and never uses `vm.Script` or `eval`. A 50ms timeout guard logs slow validators.
- **Vault eviction**: In-memory vault has a 10K token max with oldest-first eviction. The `evictIfNeeded()` method fires after each `store.set()`.
- **Random replacement consistency**: Session-scoped cache (50K max) in `pii-vault.ts` ensures the same PII value always maps to the same random string within a session via `getRandomReplacement()`.
- **Selective redaction audit**: `detectPIISelective()` always detects ALL types for audit trail, then splits exempt/redact. No PII is silently ignored (OWASP LLM02 compliance).
- **Fire-and-forget audit**: `PIIAuditLogger` uses a 100-entry in-memory buffer with 5-second flush interval. Flush failures are logged but never block the request path.
- **Tenant isolation plugin**: The `PIIPattern` model uses `tenantIsolationPlugin` from the database package, which automatically scopes all queries to the current tenant.

---

## 8. How to Consume

### Studio UI

PII pattern management is available under **Project Settings > PII Protection** tab (`apps/studio/src/components/settings/PIIProtectionTab.tsx`). Builders can:

- View built-in patterns (email, phone, SSN, credit card, IP) with icons and descriptions
- Create/edit/delete custom patterns via `PIIPatternFormDialog` with live regex testing
- Configure per-pattern redaction mode (predefined label, masked, random)
- Set per-consumer access rules (original, masked, redacted, tokenized, random)
- Override built-in pattern redaction settings without deleting them

### API (Runtime)

| Method | Path                                               | Purpose                                                                                                        |
| ------ | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/projects/:projectId/pii-patterns`            | List all patterns for project                                                                                  |
| POST   | `/api/projects/:projectId/pii-patterns`            | Create custom pattern                                                                                          |
| GET    | `/api/projects/:projectId/pii-patterns/:id`        | Get single pattern by ID                                                                                       |
| PUT    | `/api/projects/:projectId/pii-patterns/:id`        | Update pattern                                                                                                 |
| DELETE | `/api/projects/:projectId/pii-patterns/:id`        | Delete pattern                                                                                                 |
| POST   | `/api/projects/:projectId/pii-patterns/test`       | Test regex against sample text with preview                                                                    |
| POST   | `/api/projects/:projectId/sessions/:id/pii/reveal` | Reveal selected durable token originals; requires exact `pii:reveal`, reason, scoped session lookup, and audit |

All routes require `authMiddleware` + `tenantRateLimit('request')`. Create/update/delete require `pii-pattern:write` permission. List/get/test require `pii-pattern:read` permission. Cross-tenant access returns 404 (not 403).

### API (Studio)

Studio proxies PII pattern API calls to the Runtime endpoints listed above via `apiFetch()`.

Studio also exposes:

| Method | Path                                                        | Purpose                                                                                     |
| ------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| GET    | `/api/projects/:id/permissions/pii-reveal`                  | Exact `pii:reveal` permission probe for reveal affordance gating                            |
| POST   | `/api/runtime/sessions/:id/pii/reveal?projectId=:projectId` | No-store proxy to Runtime reveal endpoint; repeats exact permission check before forwarding |

### Admin Portal

N/A -- PII patterns are project-scoped, not tenant/admin-scoped.

### Channel / SDK / Voice / A2A / MCP Integration

PII detection is channel-agnostic. It is applied at the runtime execution layer on all input/output regardless of the originating channel. The same detection and rendering pipeline applies to WebSocket, REST, voice, A2A, and MCP interactions.

---

## 9. Data Model

### Collections / Tables

```text
Collection: pii_patterns
Fields:
  - _id: string (UUIDv7)
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - name: string (required, unique per tenant+project)
  - description: string (optional)
  - piiType: string (e.g., 'email', 'ssn', 'employee_id')
  - regex: string (required for custom, null for builtin overrides)
  - validate: string (optional regex validator expression)
  - redaction: {
      type: 'predefined' | 'masked' | 'random',
      label?: string,
      maskConfig?: { showFirst: number, showLast: number, maskChar: string },
      randomConfig?: { charset: 'alphanumeric'|'alphabetic'|'numeric'|'custom', customChars?: string, length?: number }
    }
  - consumerAccess: [{ consumer: string, renderMode: 'original'|'masked'|'redacted'|'tokenized'|'random' }]
  - defaultRenderMode: string
  - enabled: boolean (default: true)
  - builtinOverride: boolean (default: false)
  - createdBy: string
  - _v: number (default: 1)
  - createdAt: Date (auto)
  - updatedAt: Date (auto)
Plugins: tenantIsolationPlugin
Indexes:
  - { tenantId: 1, projectId: 1 }
  - { tenantId: 1, projectId: 1, name: 1 } (unique)

Collection: pii_audit_logs
Fields:
  - _id: string (UUIDv7)
  - tenantId: string (required, indexed)
  - projectId: string (required)
  - sessionId: string (required, indexed)
  - tokenId: string (required)
  - piiType: string (required)
  - consumer: enum ['llm', 'user', 'logs', 'tools', 'admin', 'system'] (required)
  - renderMode: string (optional)
  - action: enum ['tokenize', 'detokenize', 'render', 'clear'] (required)
  - metadata: object (optional)
  - expireAt: Date (TTL index, default 90 days)
  - _v: number (default: 1)
  - createdAt: Date (auto)
Indexes:
  - { tenantId: 1, sessionId: 1 }
  - { tenantId: 1, createdAt: -1 }
  - { tenantId: 1, piiType: 1, createdAt: -1 }
  - { expireAt: 1 } (TTL, expires: 0)

Embedded in project_runtime_configs:
  pii_redaction: {
    enabled: boolean,
    redact_input: boolean,
    redact_output: boolean
  }

Collection: pii_token_vault
Fields:
  - _id: string (UUIDv7)
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - sessionId: string (required, indexed)
  - tokenId: string (required, unique per tenant+project+session)
  - token: string (required)
  - piiType: string (required)
  - patternName: string (required)
  - encryptedOriginalValue: string (required; encrypted by database encryption plugin)
  - sourceSurface: enum ['input', 'output', 'tool', 'trace', 'message', 'unknown']
  - sourceMessageId/sourceTraceId/sourceSpanId/sourceFieldPath: string (optional correlation)
  - revealable: boolean (default: true)
  - erasedAt: Date | null
  - erasureReason: string | null
  - expireAt: Date (TTL index, default 90 days)
Indexes:
  - { tenantId: 1, projectId: 1, sessionId: 1, tokenId: 1 } (unique)
  - { tenantId: 1, projectId: 1, sessionId: 1 }
  - { tenantId: 1, projectId: 1, sessionId: 1, revealable: 1 }
  - { tenantId: 1, projectId: 1, piiType: 1, createdAt: -1 }
```

### Key Relationships

- `pii_patterns` are project-scoped and loaded at session init by `loadProjectPIIPatterns()` in `pattern-loader.ts`
- `pii_audit_logs` reference `tokenId` from the in-memory `PIIVault` store and `sessionId` from the runtime session
- `pii_token_vault` stores durable encrypted originals for revealable tokens and is the only raw-value source for post-session admin reveal
- `project_runtime_configs.pii_redaction` controls the master toggle, input redaction, and output redaction behavior
- EventStore `RetentionPolicy.events.piiRetentionDays` controls PII scrubbing in event data separately from audit log TTL

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                    | Purpose                                                                                         |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `packages/compiler/src/platform/security/pii-detector.ts`               | Core detection: 5 regex patterns, Luhn/range validators, selective redaction, overlap removal   |
| `packages/compiler/src/platform/security/pii-vault.ts`                  | Reversible tokenization vault, consumer rendering, masking, random replacement, serialize/deser |
| `packages/compiler/src/platform/security/pii-recognizer-registry.ts`    | Pluggable recognizer registry, 5 built-in registrations, `RegexPIIRecognizer` class             |
| `packages/compiler/src/platform/security/pii-audit.ts`                  | Buffered fire-and-forget audit logger (100-entry buffer, 5s flush)                              |
| `packages/compiler/src/platform/security/streaming-pii-buffer.ts`       | Streaming chunk-boundary PII detection with 40-char trailing buffer                             |
| `packages/compiler/src/platform/security/encrypted-vault.ts`            | Encrypt/decrypt vault for session persistence via `VaultEncryptionService`                      |
| `packages/compiler/src/platform/security/index.ts`                      | Re-exports all PII types and functions from the security module                                 |
| `packages/compiler/src/platform/guardrails/providers/builtin-pii.ts`    | Guardrail provider wrapping `detectPII()` -- zero cost, always available                        |
| `packages/compiler/src/platform/guardrails/action-executors.ts`         | `executeRedact()` with `pii` mode delegates to `redactPII()`, `executeFix()` has `redact_pii`   |
| `packages/compiler/src/platform/guardrails/action-applier.ts`           | Applies non-terminal guardrail actions (redact, fix, filter) to content                         |
| `packages/compiler/src/platform/nlu/enterprise/pii-guard.ts`            | Context-aware PII guard hook: `resolveGatherExemptions()` + `createPIIGuardHook()`              |
| `packages/compiler/src/platform/constructs/executors/trace-scrubber.ts` | Scrubs PII + secrets from tool call trace data for observability                                |

### Routes / Handlers

| File                                                       | Purpose                                                                                              |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/routes/pii-patterns.ts`                  | REST API: CRUD + test endpoint, auth + rate limiting, audit logging                                  |
| `apps/runtime/src/routes/sessions.ts`                      | Session read-boundary protection and audited `POST /sessions/:id/pii/reveal` endpoint                |
| `apps/runtime/src/repos/session-repo.ts`                   | Tenant/project scoped message lookup used for message-scoped reveal selector expansion               |
| `apps/runtime/src/repos/pii-pattern-repo.ts`               | MongoDB repository: findAll, findEnabled, findById, findByName, create, update, remove               |
| `apps/runtime/src/services/pii/pattern-service.ts`         | Validation (regex compilation, backtracking detection, length limits), test endpoint logic           |
| `apps/runtime/src/services/pii/pattern-loader.ts`          | Load enabled patterns from DB at session init, register custom recognizers                           |
| `apps/runtime/src/services/pii/pii-token-vault-service.ts` | Durable token-vault flush/reveal service, synchronous reveal audit, unavailable token classification |

### UI Components

| File                                                                    | Purpose                                                                               |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `apps/studio/src/components/settings/PIIProtectionTab.tsx`              | Project settings tab: global toggles, built-in + custom patterns                      |
| `apps/studio/src/components/settings/PIIPatternFormDialog.tsx`          | Modal form: create/edit patterns, live regex testing, consumer access                 |
| `apps/studio/src/components/session/PIIRevealControls.tsx`              | Permission-gated, message-scoped, audited reveal modal with ephemeral raw-value state |
| `apps/studio/src/components/observatory/DebugTabs.tsx`                  | Renders message-scoped reveal controls in the Observatory conversation/history tab    |
| `apps/studio/src/app/api/projects/[id]/permissions/pii-reveal/route.ts` | Exact `pii:reveal` permission probe for Studio UI gating                              |
| `apps/studio/src/app/api/runtime/sessions/[id]/pii/reveal/route.ts`     | Studio no-store reveal proxy that repeats exact permission checks before forwarding   |

### Runtime Integration

| File                                                             | Purpose                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| `apps/runtime/src/services/execution/output-pii-filter.ts`       | Output PII filtering: legacy (destructive) + vault-aware modes     |
| `apps/runtime/src/services/execution/pii-audit-singleton.ts`     | Singleton `PIIAuditLogger` instance for the runtime                |
| `apps/runtime/src/services/execution/pii-audit-store-adapter.ts` | MongoDB adapter connecting `PIIAuditLogger` to `PIIAuditLog` model |

### Database Models

| File                                                           | Purpose                                                   |
| -------------------------------------------------------------- | --------------------------------------------------------- |
| `packages/database/src/models/pii-pattern.model.ts`            | PIIPattern Mongoose model with tenant isolation plugin    |
| `packages/database/src/models/pii-audit-log.model.ts`          | PIIAuditLog Mongoose model with TTL index                 |
| `packages/database/src/models/pii-token-vault.model.ts`        | Durable encrypted token-original store for audited reveal |
| `packages/database/src/models/project-runtime-config.model.ts` | `IPIIRedactionConfig` embedded in project runtime config  |

### Tests

| File                                                                           | Type        | Coverage Focus                                                                      |
| ------------------------------------------------------------------------------ | ----------- | ----------------------------------------------------------------------------------- |
| `packages/compiler/src/__tests__/security/pii-detector.test.ts`                | unit        | All 5 PII types, Luhn validation, selective redaction, overlaps                     |
| `packages/compiler/src/__tests__/security/pii-vault.test.ts`                   | unit        | Tokenize/detokenize, consumer rendering, masking, random, eviction                  |
| `packages/compiler/src/__tests__/security/pii-recognizer-registry.test.ts`     | unit        | Registry lifecycle, permanent protection, max eviction, detectAll                   |
| `packages/compiler/src/__tests__/security/streaming-pii-buffer.test.ts`        | unit        | Chunk boundary detection, buffer flush, empty chunks                                |
| `packages/compiler/src/__tests__/security/encrypted-vault.test.ts`             | unit        | Encrypt/decrypt round-trip, empty vault, failure handling                           |
| `packages/compiler/src/__tests__/security/pii-audit.test.ts`                   | unit        | Buffered writes, flush on full, TTL calculation, failure logging                    |
| `packages/compiler/src/__tests__/guardrails/providers/builtin-pii.test.ts`     | unit        | Provider name, cost, availability, detection, latency tracking                      |
| `packages/compiler/src/__tests__/guardrails/providers/builtin-pii-e2e.test.ts` | unit        | Full pipeline E2E: detection through guardrail evaluate() across kinds              |
| `packages/compiler/src/__tests__/enterprise/pii-guard.test.ts`                 | unit        | Gather exemptions, PII guard hook, config-disabled passthrough                      |
| `apps/runtime/src/__tests__/output-pii-filter.test.ts`                         | unit        | Legacy + vault-aware filtering, config flags, exempt types                          |
| `apps/runtime/src/__tests__/pii-pattern-loader.test.ts`                        | unit        | DB loading, custom recognizer registration, consumer config                         |
| `apps/runtime/src/__tests__/pii-sandbox-escape.test.ts`                        | unit        | Regex-only validation, arbitrary JS rejection, backtracking                         |
| `apps/runtime/src/__tests__/pii-testpattern-redos.test.ts`                     | unit        | ReDoS prevention, nested quantifier rejection                                       |
| `apps/runtime/src/__tests__/reported-pii-masking-gaps.test.ts`                 | unit        | PII masking edge cases, message persistence redaction policies                      |
| `apps/runtime/src/__tests__/pii/pii-token-vault-service.test.ts`               | unit        | Durable vault flush/reveal, unavailable tokens, audit fail-closed                   |
| `apps/runtime/src/__tests__/auth/middleware/rbac.test.ts`                      | unit        | Exact-sensitive `pii:reveal` authorization and broad-admin denial                   |
| `apps/runtime/src/__tests__/sessions/session-routes.test.ts`                   | integration | Session read-boundary scrubbing, reveal route, message selector expansion           |
| `apps/studio/src/__tests__/api-routes/api-proxy-routes.test.ts`                | integration | Studio reveal permission probe and no-store reveal proxy behavior                   |
| `apps/studio/src/__tests__/components/pii-reveal-controls.test.tsx`            | unit        | Reveal affordance gating, reason requirement, ephemeral clearing, unavailable state |
| `apps/studio/src/__tests__/project-permission.test.ts`                         | unit        | Studio exact-sensitive project permission behavior                                  |
| `apps/studio/src/__tests__/api-routes/route-handler-rbac.test.ts`              | unit        | Studio route-handler RBAC exact-sensitive denial behavior                           |
| `packages/database/src/__tests__/pii-audit-log.test.ts`                        | unit        | PIIAuditLog model schema validation, TTL index, required fields                     |
| `packages/database/src/__tests__/pii-pattern-model.test.ts`                    | unit        | PIIPattern model `validate` field handling, reserved-key suppression                |
| `apps/runtime/src/attachments/__tests__/message-preprocessor-pii.test.ts`      | unit        | Message preprocessor PII redaction policy (redact/block/allow)                      |
| `apps/multimodal-service/src/jobs/__tests__/process-job-pii.test.ts`           | unit        | PII detection in document/audio/video processing jobs                               |
| `apps/runtime/src/__tests__/pii-integration.test.ts`                           | integration | End-to-end vault tokenize/render, output filter, session lifecycle                  |
| `apps/runtime/src/__tests__/sessions/session-pii-vault.test.ts`                | integration | Vault lifecycle in session store                                                    |
| `apps/runtime/src/attachments/__tests__/preprocessor-pii-integration.test.ts`  | integration | Real PII detection wired through message preprocessor                               |
| `apps/multimodal-service/src/__tests__/pii-pipeline-integration.test.ts`       | integration | PII detection in multimodal pipeline with real detectPII                            |
| `apps/runtime/src/__tests__/tools-deployment/attachment-pii.e2e.test.ts`       | e2e         | Attachment PII redaction with real Express, MongoDB, auth                           |

---

## 11. Configuration

### Environment Variables

No dedicated environment variables. PII is controlled via project runtime config in the database.

### Runtime Configuration

Stored in `project_runtime_configs.pii_redaction` (see `IPIIRedactionConfig` in `project-runtime-config.model.ts`):

- `enabled` (boolean, default: true) -- master toggle for PII detection
- `redact_input` (boolean, default: true) -- redact PII from user input before LLM
- `redact_output` (boolean, default: false) -- redact PII from agent responses

### DSL / Agent IR / Schema

PII detection is not directly declared in the ABL DSL. The `builtin-pii` guardrail provider can be referenced in GUARDRAILS sections:

```yaml
GUARDRAILS:
  ssn_detection:
    kind: input
    check: not_matches_pattern(input, "\\b\\d{3}-\\d{2}-\\d{4}\\b")
    action: warn
    message: 'SSN detected. Please avoid sharing sensitive information.'

  pii_output_prevention:
    kind: output
    check: not_matches_pattern(response, "\\b\\d{3}-\\d{2}-\\d{4}\\b")
    action: block
    message: 'Response blocked: Cannot include SSN-like patterns.'
```

Custom PII patterns are managed via the runtime API, not the DSL. The guardrail action-executors support `redact` mode with `pii` mode type and `fix` strategy `redact_pii`.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement                                                                                                                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation  | `PIIPattern` model uses `tenantIsolationPlugin`. All repo queries include `tenantId`. Vault tokens are session-scoped.                                                                                          |
| Project isolation | Custom recognizers are loaded per-project at session init via `loadProjectPIIPatterns(tenantId, projectId, registry)`. Cross-project patterns never mix. Pattern unique index is `{tenantId, projectId, name}`. |
| User isolation    | Vault is per-session (not shared across users). Audit logs include `sessionId` for per-user tracking. Pattern `createdBy` tracks ownership.                                                                     |

### Security & Compliance

- PII vault contents encrypted at rest using AES-256-GCM with tenant-scoped keys via `VaultEncryptionService`
- Custom validators sandboxed: regex-only, no `vm.Script`/`eval`, 50ms timeout guard
- Audit logs have configurable TTL retention (default 90 days) with MongoDB TTL index auto-deletion
- All PII detections logged for audit regardless of exemption status (OWASP LLM02 compliance)
- Trace scrubber applies `redactPII()` to tool call data before observability ingestion
- Protected fields (tenantId, \_id, createdBy) cannot be overridden via API (`PROTECTED_FIELDS` set in route)
- Pattern CRUD operations generate audit log entries via `writeAuditLog()`

### Performance & Scalability

- Regex-based detection: sub-millisecond for typical messages (5 patterns scanned sequentially)
- Vault: 10K token max with LRU eviction (`MAX_VAULT_TOKENS = 10_000`)
- Recognizer registry: 50 max with non-permanent eviction, 5-minute TTL (`MAX_RECOGNIZERS = 50`, `REGISTRY_TTL_MS = 300_000`)
- Streaming buffer: 40-character overhead per chunk (`StreamingPIIBuffer.BUFFER_SIZE = 40`)
- Audit logging: fire-and-forget with 100-entry buffer (`MAX_BUFFER_SIZE = 100`) and 5-second flush interval
- Random replacement cache: 50K max module-level singleton (`MAX_RANDOM_CACHE = 50_000`)
- Custom regex length capped at 2048 chars, validator at 1024 chars

### Reliability & Failure Modes

- Pattern loader failures are caught and logged; session continues with built-in recognizers only
- Vault encryption failures return null; session continues without encrypted persistence
- Audit log flush failures are caught and logged; never block the request path
- Invalid custom regex patterns are rejected at creation time (validation in `pattern-service.ts`)
- Catastrophic backtracking patterns are rejected before storage
- Circuit breaker on `builtin-pii` provider in guardrail registry (shared with all providers)
- Regex execution uses fresh `RegExp` instances to avoid shared `lastIndex` state bugs

### Observability

- PII type detections logged as trace metadata (type names only, never raw PII values)
- Pattern loader logs `pii-patterns-loaded` with count of total, custom, and override patterns
- Output PII filter logs `output-pii-filtered` with redacted and exempted types
- Audit logger uses `pii-audit` log prefix for buffer and flush diagnostics
- Guardrail provider registry logs circuit breaker state changes for all providers including `builtin-pii`
- Recognizer registry logs registration, eviction, and error events per recognizer

### Data Lifecycle

- **PII vault**: Per-session lifecycle, destroyed when session ends. Max 10K tokens with LRU eviction. Encrypted serialization for cross-turn persistence.
- **PII audit logs**: 90-day default retention via MongoDB TTL index on `expireAt` field. Auto-deletion without manual intervention.
- **Custom patterns**: No automatic expiry; managed by project builders via CRUD API. Unique index prevents duplicates.
- **Random replacement cache**: Module-level singleton, no TTL (lives for process lifetime). 50K max with oldest-first eviction.
- **EventStore PII retention**: Separate `piiRetentionDays` in `RetentionPolicy` for scrubbing PII from events (distinct from audit log TTL).

---

## 13. Delivery Plan / Work Breakdown

Feature is fully implemented. Implementation phases were:

1. **Core Detection Engine** (Phase 1)
   1.1 PII detector with 5 built-in regex patterns and Luhn/range validators
   1.2 Selective redaction API (`detectPIISelective()`) detecting all types for audit
   1.3 Overlap handling and match deduplication
   1.4 `containsPII()` fast boolean check

2. **Tokenization Vault** (Phase 2)
   2.1 Reversible tokenization with `{{PII:<type>:<uuid>}}` format
   2.2 Per-consumer rendering (LLM, user, logs, tools) with `renderForConsumer()`
   2.3 Configurable masked rendering with email-aware masking (`applyMask()`)
   2.4 Random replacement with session-scoped cache (`getRandomReplacement()`)
   2.5 Serialize/deserialize for session persistence

3. **Recognizer Registry** (Phase 2)
   3.1 Pluggable registry supporting regex, ml, and custom tiers
   3.2 5 permanent built-in recognizers with validators via `registerBuiltInRecognizers()`
   3.3 `RegexPIIRecognizer` class for custom pattern recognizers

4. **Streaming & Persistence** (Phase 2)
   4.1 Streaming PII buffer for chunk-boundary detection (40-char trailing buffer)
   4.2 Encrypted vault serialization via `VaultEncryptionService`

5. **Audit & Compliance** (Phase 3)
   5.1 PII audit logger with buffered batch writes and 90-day TTL
   5.2 MongoDB adapter for audit store (`MongoDBPIIAuditStore`)
   5.3 Runtime singleton accessor (`getPIIAuditLogger()`)

6. **Runtime Integration** (Phase 3)
   6.1 Output PII filter (legacy destructive + vault-aware modes)
   6.2 Custom pattern loader from DB (`loadProjectPIIPatterns()`)
   6.3 Pattern validation service with backtracking detection
   6.4 Pattern CRUD routes with test endpoint

7. **Studio UI** (Phase 3)
   7.1 `PIIProtectionTab` with built-in + custom pattern management
   7.2 `PIIPatternFormDialog` with live regex testing and consumer access configuration

8. **Cross-Feature Integration** (Phase 3)
   8.1 Built-in PII guardrail provider (`BuiltinPIIProvider`)
   8.2 Trace scrubber integration (`scrubToolCallData()`)
   8.3 Context-aware PII guard for NLU gather fields

9. **ABLP-535 Boundary Hardening** (2026-04-27)
   9.1 Runtime session/message/trace read boundaries scrub PII/secrets before historical responses
   9.2 Exact-sensitive `pii:reveal` permission added without granting it to existing built-in roles
   9.3 Runtime/Studio PII settings clarified: configurable patterns can be disabled; baseline secret scrubbing remains always on
   9.4 Durable encrypted `PIITokenVault` added for revealable token originals
   9.5 Runtime audited reveal endpoint and Studio message-scoped reveal modal added
   9.6 Legacy backfill intentionally excluded; old sessions without vault provenance are non-revealable

---

## 14. Success Metrics

| Metric                    | Baseline | Target          | How Measured                                                |
| ------------------------- | -------- | --------------- | ----------------------------------------------------------- |
| Built-in PII types        | 0        | 5               | Count of permanent recognizers in registry                  |
| Detection latency         | N/A      | < 1ms           | `performance.now()` in `BuiltinPIIProvider.evaluate()`      |
| Vault token capacity      | N/A      | 10K max         | `MAX_VAULT_TOKENS` constant, LRU eviction verification      |
| Audit log retention       | N/A      | 90 days default | MongoDB TTL index on `expireAt` field                       |
| Custom pattern validation | N/A      | 100%            | Backtracking detection catches all nested quantifiers       |
| Validator security        | N/A      | No code exec    | Regex-only sandbox verified by `pii-sandbox-escape.test.ts` |
| Consumer rendering modes  | N/A      | 5 modes         | original, masked, redacted, tokenized, random               |

---

## 15. Open Questions

1. Should ML/NER-based recognizers be implemented for higher-accuracy detection of names, addresses, and other unstructured PII? The registry supports `ml` tier but no ML recognizers exist. **Assessment (2026-03-27):** Microsoft Presidio (Python, Apache 2.0) is the strongest candidate — supports 50+ PII types via spaCy NER, integrates as a sidecar service. Google DLP is a managed alternative but adds cloud dependency.
2. Should international PII patterns (EU national IDs, IBAN, NHS numbers, passport numbers) be added as built-in recognizers? **Assessment (2026-03-27):** Current phone/SSN/credit-card regexes are US-centric. At minimum, E.164 international phone format and IBAN should be added as built-in recognizers to support non-US deployments.
3. Should the random replacement cache be per-session instead of the current module-level global singleton?
4. Should PII patterns support import/export for migration between projects?
5. Should a PII analytics dashboard (detection frequency, type distribution, false-positive rates) be built using the ClickHouse analytics pipeline?
6. Should all PII consumers (guardrail provider, PIIVault, CEL functions) be routed through `PIIRecognizerRegistry` instead of calling `pii-detector.ts` directly? This would make custom recognizers effective across all paths, not just NLU.
7. Should the duplicate regex definitions in `pii-detector.ts` and `pii-recognizer-registry.ts` be consolidated into a single source of truth?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                          | Severity | Status                                                                                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GAP-001 | No ML/NER-based recognizers implemented (registry supports `ml` tier)                                                                                                                | Medium   | Open (deferred to ADVANCED tier — sub-feature TBD)                                                                                                                     |
| GAP-002 | Random replacement cache is module-level global, not per-session                                                                                                                     | Low      | Open                                                                                                                                                                   |
| GAP-003 | No international PII patterns beyond US formats (EU national IDs, IBAN, NHS)                                                                                                         | Medium   | Resolved — `eu`/`apac`/`international-phone` packs ship in [PII Detection Tiered Recognizers](sub-features/pii-detection-tiered-recognizers.md) (ALPHA 05-09)          |
| GAP-004 | Phone regex has higher false positive rate on short digit sequences (10-digit minimum helps)                                                                                         | Low      | Known                                                                                                                                                                  |
| GAP-005 | No bulk pattern import/export for cross-project migration                                                                                                                            | Low      | Open                                                                                                                                                                   |
| GAP-006 | PII guard `FIELD_NAME_TO_PII_TYPE` mapping is hardcoded, not extensible via config                                                                                                   | Low      | Known                                                                                                                                                                  |
| GAP-007 | Vault `evictIfNeeded()` only evicts one entry per insert; could be overwhelmed by burst                                                                                              | Low      | Known                                                                                                                                                                  |
| GAP-008 | No E2E tests exercising the full HTTP API for PII pattern CRUD with real auth middleware                                                                                             | Medium   | Open                                                                                                                                                                   |
| GAP-009 | SSN regex only matches dashed format (`123-45-6789`); misses undashed (`123456789`) and spaced formats                                                                               | Medium   | Resolved — `core` pack adds undashed SSN (Tiered Recognizers D-7) — ALPHA 05-09                                                                                        |
| GAP-010 | Credit card regex only matches 16-digit cards; misses 15-digit Amex and 13-digit old Visa                                                                                            | Medium   | Resolved — `core` pack adopts 13–19 digit + Luhn (Tiered Recognizers D-7) — ALPHA 05-09                                                                                |
| GAP-011 | Phone regex is US/NANP-centric; misses international formats (UK `+44`, India `+91`, E.164)                                                                                          | Medium   | Resolved — `international-phone` pack via `libphonenumber-js` (Tiered Recognizers WS-2) — ALPHA 05-09                                                                  |
| GAP-012 | No IPv6 detection — only IPv4 addresses are recognized                                                                                                                               | Low      | Resolved — `network` pack adds IPv6 (Tiered Recognizers WS-2) — ALPHA 05-09                                                                                            |
| GAP-013 | Registry bypass: guardrail provider, PIIVault, and CEL functions call `pii-detector.ts` directly, skipping `PIIRecognizerRegistry` — custom recognizers ineffective outside NLU path | High     | Resolved — `_pii-bypass-fix.ts` defaults all three surfaces to `getDefaultPIIRecognizerRegistry()` (Tiered Recognizers FR-4) — ALPHA 05-09                             |
| GAP-014 | Duplicate regex patterns defined identically in `pii-detector.ts` and `pii-recognizer-registry.ts` — DRY violation risks drift                                                       | Medium   | Resolved — `detectWithLocalPatterns()` removed; standalone exports route through registry singleton (Tiered Recognizers FR-3) — ALPHA 05-09                            |
| GAP-015 | No detection for names, addresses, DOB, passports, driver's licenses, bank accounts, health IDs                                                                                      | Medium   | Partially resolved — passports/DL/bank-accounts/health IDs covered by `us`/`eu`/`apac`/`medical` packs (ALPHA 05-09); names/addresses/DOB defer to ADVANCED tier (NER) |
| GAP-016 | Legacy sessions created before durable reveal-vault provenance are not backfilled or made revealable as part of ABLP-535                                                             | Low      | Accepted                                                                                                                                                               |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                         | Coverage Type    | Status | Test File / Note                                                                           |
| --- | ------------------------------------------------ | ---------------- | ------ | ------------------------------------------------------------------------------------------ |
| 1   | PII detection for all 5 types                    | unit             | PASS   | `pii-detector.test.ts`                                                                     |
| 2   | Selective redaction with exemptions              | unit             | PASS   | `pii-detector.test.ts`                                                                     |
| 3   | Vault tokenize/detokenize round-trip             | unit             | PASS   | `pii-vault.test.ts`                                                                        |
| 4   | Consumer rendering modes (all 5)                 | unit             | PASS   | `pii-vault.test.ts`                                                                        |
| 5   | Streaming PII buffer boundary detection          | unit             | PASS   | `streaming-pii-buffer.test.ts`                                                             |
| 6   | Custom pattern loading and registration          | unit             | PASS   | `pii-pattern-loader.test.ts`                                                               |
| 7   | Pattern validation (regex, backtracking)         | unit             | PASS   | `pii-testpattern-redos.test.ts`                                                            |
| 8   | Output PII filter (legacy + vault-aware)         | unit             | PASS   | `output-pii-filter.test.ts`                                                                |
| 9   | Encrypted vault serialize/deserialize            | unit             | PASS   | `encrypted-vault.test.ts`                                                                  |
| 10  | Sandbox security (no code execution)             | unit             | PASS   | `pii-sandbox-escape.test.ts`                                                               |
| 11  | Recognizer registry lifecycle                    | unit             | PASS   | `pii-recognizer-registry.test.ts`                                                          |
| 12  | Builtin-pii guardrail pipeline across kinds      | unit             | PASS   | `builtin-pii-e2e.test.ts`                                                                  |
| 13  | PII masking edge cases and persistence redaction | unit             | PASS   | `reported-pii-masking-gaps.test.ts`                                                        |
| 14  | PIIAuditLog model schema and TTL index           | unit             | PASS   | `pii-audit-log.test.ts`                                                                    |
| 15  | PIIPattern model validate field handling         | unit             | PASS   | `pii-pattern-model.test.ts`                                                                |
| 16  | Session PII vault integration                    | integration      | PASS   | `sessions/session-pii-vault.test.ts`                                                       |
| 17  | End-to-end PII redaction flow                    | integration      | PASS   | `pii-integration.test.ts`                                                                  |
| 18  | Attachment PII redaction E2E                     | e2e              | PASS   | `tools-deployment/attachment-pii.e2e.test.ts`                                              |
| 19  | Message preprocessor PII policy                  | unit             | PASS   | `message-preprocessor-pii.test.ts`                                                         |
| 20  | Preprocessor PII integration                     | integration      | PASS   | `preprocessor-pii-integration.test.ts`                                                     |
| 21  | Multimodal PII pipeline integration              | integration      | PASS   | `pii-pipeline-integration.test.ts`                                                         |
| 22  | Process job PII detection                        | unit             | PASS   | `process-job-pii.test.ts`                                                                  |
| 23  | Pattern CRUD routes via HTTP API                 | e2e              | GAP    | Route tests exist but no real-server E2E (see GAP-008)                                     |
| 24  | Historical read-boundary redaction parity        | integration      | PASS   | `sessions/session-routes.test.ts`                                                          |
| 25  | Durable vault reveal and audit fail-closed       | unit             | PASS   | `pii-token-vault-service.test.ts`                                                          |
| 26  | Exact-sensitive `pii:reveal` authorization       | unit/integration | PASS   | `auth/middleware/rbac.test.ts`, `project-permission.test.ts`, `route-handler-rbac.test.ts` |
| 27  | Studio reveal UX gating and ephemeral clearing   | unit             | PASS   | `pii-reveal-controls.test.tsx`                                                             |
| 28  | Studio reveal proxy and permission probe         | integration      | PASS   | `api-proxy-routes.test.ts`                                                                 |
| 29  | Legacy sessions without vault provenance         | API/UI           | PASS   | Reveal returns unavailable/non-revealable; no backfill required                            |

### Testing Notes

Comprehensive unit coverage exists for the core detection engine, tokenization vault, recognizer registry, streaming buffer, security sandbox, guardrail pipeline integration, PII masking edge cases, durable token-vault reveal behavior, exact-sensitive reveal authorization, and database models (PIIAuditLog, PIIPattern, PIITokenVault). Integration tests cover vault lifecycle, output filtering, message preprocessor PII policy, session read-boundary scrubbing, message-scoped reveal expansion, Studio reveal proxy routing, and the multimodal pipeline using real `detectPII()`. Attachment PII redaction has full E2E coverage with real Express, MongoDB, and auth middleware. The remaining gap is E2E testing of the PII pattern CRUD API with real Express server, middleware chain, and auth -- tests currently mock the database layer.

> Full testing details: `../testing/pii-detection.md`

---

## 18. References

- Design docs: `docs/plans/2026-03-08-pii-phase2-spec.md`, `docs/plans/2026-03-09-pii-enhancements-design.md`, `docs/plans/2026-03-08-pii-phase2-plan.md`
- Guardrails integration: `docs/features/guardrails.md` (built-in PII provider)
- Guardrails audit: `docs/audit/guardrails-coverage-matrix-2026-03-09.md`
- DSL example: `examples/guardrails/agents/pii_protection.agent.abl`
- Security reference: `docs/security/SECURITY.md`
