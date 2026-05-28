# PII Detection & Redaction -- High-Level Design

**Status**: Implemented (BETA) -- ABLP-535 forward-looking boundary hardening complete; legacy backfill intentionally out of scope
**Feature Spec**: [docs/features/pii-detection.md](../features/pii-detection.md)
**Testing Guide**: [docs/testing/pii-detection.md](../testing/pii-detection.md)
**LLD**: [docs/plans/pii-detection.lld.md](../plans/pii-detection.lld.md)

---

## 1. Problem Statement

LLM-powered agents process user messages containing PII (email, phone, SSN, credit card, IP address) that must not leak through inference, tool calls, logs, or storage. The system must detect PII at the input boundary, tokenize it reversibly for LLM processing, render it appropriately per consumer (masked for users, redacted for logs, original for tools), and provide project-scoped custom pattern management -- all while maintaining sub-millisecond detection latency and compliance audit trails.

---

## 2. Alternatives Considered

### Alternative A: Destructive Redaction Only

Replace all detected PII with `[REDACTED_*]` labels permanently. No vault, no reversible tokenization.

- **Pros**: Simplest implementation, zero memory overhead, no session persistence needed
- **Cons**: Tools cannot access original PII for API calls/lookups, LLM loses semantic context, no configurable rendering per consumer
- **Effort**: S

### Alternative B: External PII Service (Presidio/AWS Comprehend)

Delegate PII detection to an external service like Microsoft Presidio or AWS Comprehend.

- **Pros**: Higher accuracy (NER-based), supports more PII types, maintained by specialists
- **Cons**: External dependency adds latency (10-50ms per call), cost per request, network dependency, reduces availability, harder to deploy on-premises
- **Effort**: L

### Alternative C: Regex + Vault + Pluggable Registry (Selected)

Built-in regex detection with reversible tokenization vault, pluggable recognizer registry for extensibility, and per-consumer rendering.

- **Pros**: Zero external dependencies, sub-millisecond latency, reversible tokenization preserves tool access, pluggable registry allows future ML integration, per-consumer rendering covers all access patterns
- **Cons**: Regex-only detection has lower recall for unstructured PII (names, addresses), more implementation complexity than destructive-only
- **Effort**: M

**Recommendation**: Alternative C selected. The regex + vault approach provides the best balance of latency, reversibility, and extensibility. The pluggable registry allows future ML integration (Alternative B) without architectural changes. The recognizer registry already defines an `ml` tier that can be wired when a lightweight NER model is available.

---

## 3. Architecture

### System Context Diagram

```
+------------------+     +------------------+     +------------------+
|                  |     |                  |     |                  |
|  Studio UI       |---->|  Runtime API     |---->|  MongoDB         |
|  (PIIProtection  |     |  /pii-patterns   |     |  pii_patterns    |
|   Tab + Dialog)  |     |  CRUD + test     |     |  pii_audit_logs  |
|                  |     |                  |     |                  |
+------------------+     +--------+---------+     +------------------+
                                  |
                                  v
                         +--------+---------+
                         |                  |
                         |  Execution Layer |
                         |  (reasoning-     |
                         |   executor)      |
                         |                  |
                         +--------+---------+
                                  |
                    +-------------+-------------+
                    |             |              |
                    v             v              v
           +-------+----+ +------+------+ +----+--------+
           |            | |             | |             |
           | PII Guard  | | PIIVault    | | Output PII  |
           | (input)    | | (tokenize)  | | Filter      |
           |            | |             | | (output)    |
           +-------+----+ +------+------+ +----+--------+
                    |             |              |
                    v             v              v
           +-------+----+ +------+------+ +----+--------+
           | Recognizer  | | Encrypted   | | Streaming   |
           | Registry    | | Vault       | | PII Buffer  |
           +-------+----+ +------+------+ +----+--------+
                    |             |              |
                    v             v              v
           +-------+----+ +------+------+ +----+--------+
           | Builtin-PII | | PII Audit   | | Trace       |
           | Guardrail   | | Logger      | | Scrubber    |
           +------------+ +-------------+ +-------------+
```

### Component Diagram

```
packages/compiler/src/platform/security/
  |-- pii-detector.ts         Core detection (5 regex, Luhn, range validation)
  |-- pii-vault.ts            Tokenization vault (10K cap, consumer rendering)
  |-- pii-recognizer-registry.ts  Pluggable registry (50 max, 3 tiers)
  |-- pii-audit.ts            Buffered audit logger (100 buffer, 5s flush)
  |-- streaming-pii-buffer.ts Streaming chunk boundary (40-char buffer)
  |-- encrypted-vault.ts      Encrypt/decrypt for session persistence
  |-- index.ts                Re-exports

packages/compiler/src/platform/guardrails/
  |-- providers/builtin-pii.ts  Tier 1 guardrail wrapping detectPII()
  |-- action-executors.ts       executeRedact(mode='pii'), executeFix('redact_pii')
  |-- action-applier.ts         Applies non-terminal actions to content

packages/compiler/src/platform/nlu/enterprise/
  |-- pii-guard.ts             Context-aware exemption for gather fields

apps/runtime/src/
  |-- routes/pii-patterns.ts   CRUD + test API (6 endpoints)
  |-- repos/pii-pattern-repo.ts  MongoDB repository
  |-- services/pii/
  |     |-- pattern-service.ts  Validation, backtracking detection, test
  |     |-- pattern-loader.ts   Load from DB, register custom recognizers
  |-- services/execution/
        |-- output-pii-filter.ts  Legacy + vault-aware output filtering
        |-- pii-audit-singleton.ts  Runtime audit logger instance
        |-- pii-audit-store-adapter.ts  MongoDB adapter for audit store

packages/database/src/models/
  |-- pii-pattern.model.ts     PIIPattern (tenant isolation plugin)
  |-- pii-audit-log.model.ts   PIIAuditLog (TTL index)
  |-- pii-token-vault.model.ts PIITokenVault (encrypted durable originals for audited reveal)
  |-- project-runtime-config.model.ts  IPIIRedactionConfig embedded

apps/studio/src/components/settings/
  |-- PIIProtectionTab.tsx     Settings tab (built-in + custom patterns)
  |-- PIIPatternFormDialog.tsx  CRUD dialog with live testing

apps/studio/src/components/session/
  |-- PIIRevealControls.tsx     Permission-gated message-scoped reveal modal
```

### Data Flow

**Input Path (User -> LLM)**:

1. User sends message via channel
2. `createPIIGuardHook()` triggers at NLU beforeExecute
3. `resolveGatherExemptions()` determines exempt PII types from active gather fields
4. `detectPIISelective(text, exemptTypes, registry)` detects ALL types, redacts non-exempt
5. If vault available: `vault.tokenize(text, exemptTypes)` -- reversible tokens
6. If vault unavailable: destructive `[REDACTED_*]` labels
7. Tokenized/redacted text sent to LLM

**Output Path (LLM -> User)**:

1. LLM generates response (may contain tokenized PII)
2. `filterOutputPII(text, config, options)` runs if `redactOutput` enabled
3. If vault available: `vault.renderForConsumer(text, 'user', patternConfigs)` -- masked rendering
4. If vault unavailable: `detectPIISelective()` with destructive labels
5. Rendered text delivered to user

**Tool Path**:

1. Tool receives tokenized text from LLM
2. `vault.renderForConsumer(text, 'tools')` -- original values restored
3. Tool makes API call with real PII
4. Tool result goes through output filter before display

**Streaming Path**:

1. LLM streams response chunks
2. `StreamingPIIBuffer.processChunk(chunk, detectPII)` buffers 40 trailing chars
3. Safe prefix emitted with PII redacted
4. `StreamingPIIBuffer.flush()` on stream end processes remaining buffer

**Audit Path**:

1. Every tokenize/detokenize/render/clear event creates `PIIAuditEntry`
2. `PIIAuditLogger.log(entry)` buffers in memory (max 100)
3. Auto-flush at capacity or every 5 seconds
4. `MongoDBPIIAuditStore.insert()` writes to `pii_audit_logs` collection
5. MongoDB TTL index auto-deletes after 90 days

**Admin Reveal Path (ABLP-535)**:

1. Studio checks exact `pii:reveal` through `/api/projects/:id/permissions/pii-reveal`
2. User opens a message-scoped reveal modal, provides a reason and optional ticket/case ID
3. Studio proxy repeats exact permission check and forwards to Runtime
4. Runtime verifies tenant/project/session scope and resolves selected message refs to durable token ids without exposing token ids through normal session APIs
5. `revealPIITokens()` reads `PIITokenVault`, writes audit rows synchronously, and returns only selected originals
6. Studio keeps raw values only in modal component state and clears them on close/session switch

Legacy sessions without durable token-vault provenance are not backfilled for ABLP-535. They are treated as unavailable/non-revealable in reveal flows.

### Key Integration Points

| Integration        | Interface                       | File                         | Direction |
| ------------------ | ------------------------------- | ---------------------------- | --------- |
| Guardrails         | `GuardrailModelProvider`        | `builtin-pii.ts`             | Export    |
| NLU Pipeline       | `NLUContext -> NLUContext` hook | `pii-guard.ts`               | Hook      |
| Session Store      | `serialize()`/`deserialize()`   | `pii-vault.ts`               | Both      |
| Encryption Service | `VaultEncryptionService`        | `encrypted-vault.ts`         | Import    |
| Execution Layer    | `filterOutputPII()`             | `output-pii-filter.ts`       | Export    |
| Trace System       | `scrubToolCallData()`           | `trace-scrubber.ts`          | Export    |
| EventStore         | `piiRetentionDays`              | `event-retention-service.ts` | Config    |

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern            | How Addressed                                                                                                                                                           |
| --- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | Tenant Isolation   | `PIIPattern` model uses `tenantIsolationPlugin`. All repo queries include `tenantId`. Routes use `getTenantId(req)` from `req.tenantContext`. Cross-tenant returns 404. |
| 2   | Project Isolation  | Patterns scoped by `{tenantId, projectId}`. Custom recognizers loaded per-project at session init. Unique index `{tenantId, projectId, name}`.                          |
| 3   | User Isolation     | Vault is per-session (not shared). `createdBy` tracked on patterns. Audit logs include `sessionId`.                                                                     |
| 4   | Auth & Permissions | Routes use `authMiddleware` + `requirePermission('pii-pattern:read'                                                                                                     | 'write')`. Rate limiting via `tenantRateLimit('request')`. |

### Behavioral Concerns

| #   | Concern       | How Addressed                                                                                                                                       |
| --- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | Performance   | Regex detection: sub-ms. Vault: O(1) Map lookup. No external service calls. Streaming buffer: 40-char overhead. Audit: async fire-and-forget.       |
| 6   | Scalability   | Vault 10K cap with LRU eviction. Registry 50 max. Audit buffer 100 entries. Random cache 50K max. All bounded with eviction.                        |
| 7   | Reliability   | Pattern loader graceful degradation (built-in only on failure). Vault encrypt/decrypt fail-open (null). Audit flush fail-logged, never blocking.    |
| 8   | Observability | PII types in trace metadata (never raw values). Pattern loader logs counts. Output filter logs redacted types. Audit logger logs flush diagnostics. |

### Cross-Cutting Concerns

| #   | Concern        | How Addressed                                                                                                                                                                                                                                                                                         |
| --- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | Data Lifecycle | Vault: per-session. Audit logs: 90-day TTL via MongoDB TTL index. Patterns: permanent until deleted. Random cache: process lifetime with 50K cap.                                                                                                                                                     |
| 10  | Security       | Vault encrypted with AES-256-GCM + tenant keys. Validators regex-only (no vm/eval). Backtracking detection. Protected fields cannot be overridden via API.                                                                                                                                            |
| 11  | Compliance     | OWASP LLM02: all PII types detected for audit even when exempt. Audit log retention configurable. EventStore has separate PII retention policy.                                                                                                                                                       |
| 12  | Migration      | Core feature is additive. ABLP-535 intentionally does not backfill legacy sessions; records without durable vault provenance remain non-revealable. Custom patterns are opt-in. Built-in recognizers always available. Config defaults are safe (enabled=true, redactInput=true, redactOutput=false). |

---

## 5. Data Model

```
pii_patterns (MongoDB)
  _id: UUIDv7
  tenantId: string (required, indexed)
  projectId: string (required)
  name: string (unique per {tenantId, projectId})
  piiType: string
  regex: string | null (custom patterns have regex, builtin overrides don't)
  validate: string | null (optional regex validator)
  redaction: { type, label?, maskConfig?, randomConfig? }
  consumerAccess: [{ consumer, renderMode }]
  defaultRenderMode: string
  enabled: boolean
  builtinOverride: boolean
  createdBy: string

pii_audit_logs (MongoDB, TTL)
  _id: UUIDv7
  tenantId, projectId, sessionId, tokenId
  piiType, consumer, action, renderMode, metadata
  expireAt: Date (TTL index, 90 days default)

project_runtime_configs (embedded)
  pii_redaction: { enabled, redact_input, redact_output }
```

---

## 6. API Surface

| Method | Path                                         | Scope   | Auth                | Purpose                        |
| ------ | -------------------------------------------- | ------- | ------------------- | ------------------------------ |
| GET    | `/api/projects/:projectId/pii-patterns`      | Project | `pii-pattern:read`  | List all patterns              |
| POST   | `/api/projects/:projectId/pii-patterns`      | Project | `pii-pattern:write` | Create pattern                 |
| POST   | `/api/projects/:projectId/pii-patterns/test` | Project | `pii-pattern:read`  | Test regex against sample text |
| GET    | `/api/projects/:projectId/pii-patterns/:id`  | Project | `pii-pattern:read`  | Get single pattern             |
| PUT    | `/api/projects/:projectId/pii-patterns/:id`  | Project | `pii-pattern:write` | Update pattern                 |
| DELETE | `/api/projects/:projectId/pii-patterns/:id`  | Project | `pii-pattern:write` | Delete pattern                 |

Response format: `{ success: true, data: ... }` or `{ success: false, error: { code, message } }`

Error codes: `TENANT_ACCESS_DENIED`, `VALIDATION_ERROR`, `NOT_FOUND`, `DUPLICATE`, `INTERNAL_ERROR`

---

## 7. Risks & Mitigations

| Risk                                      | Likelihood | Impact | Mitigation                                                                   |
| ----------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------- |
| Regex false positives (phone detection)   | Medium     | Low    | Phone validator requires 10-15 digits. Can be improved with ML tier later.   |
| Catastrophic backtracking in custom regex | Low        | High   | `CATASTROPHIC_BACKTRACKING_PATTERNS` detection blocks dangerous patterns.    |
| Vault memory growth in long sessions      | Low        | Medium | 10K token cap with LRU eviction. Encrypted persistence for session recovery. |
| Random cache growing unbounded            | Low        | Low    | 50K max with oldest-first eviction. Module-level lifetime.                   |
| Audit log data volume                     | Low        | Low    | 90-day TTL auto-deletion. Buffered writes reduce MongoDB pressure.           |

---

## 8. Future Considerations

- **ML/NER recognizers**: The registry `ml` tier is defined but not wired. A lightweight ONNX NER model could be added as a `PIIRecognizer` without architectural changes.
- **International patterns**: Built-in recognizers for EU national IDs, IBAN, NHS numbers, passport numbers.
- **PII analytics**: Detection frequency and type distribution piped through the ClickHouse analytics pipeline.
- **Import/export**: Cross-project pattern sharing via CLI export + Studio import.
- **Per-session random cache**: Replace module-level global with session-scoped cache for better isolation.
