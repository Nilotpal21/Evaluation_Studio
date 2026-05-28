# PII Detection & Redaction -- Low-Level Design

**Status**: Implemented (BETA)
**Feature Spec**: [docs/features/pii-detection.md](../features/pii-detection.md)
**HLD**: [docs/specs/pii-detection.hld.md](../specs/pii-detection.hld.md)
**Testing Guide**: [docs/testing/pii-detection.md](../testing/pii-detection.md)

---

## 1. Design Decisions

### Decision Log

| Decision                                   | Rationale                                                                        | Alternatives Rejected                                            |
| ------------------------------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Regex-based detection over ML/NER          | Sub-ms latency, zero dependencies, deterministic, sufficient for structured PII  | External NER service (latency), embedded ONNX model (complexity) |
| Reversible tokenization over destructive   | Tools need original values for API calls; LLM needs semantic tokens              | Destructive-only (breaks tools), passthrough (no protection)     |
| In-memory vault over Redis/DB storage      | Session-scoped lifecycle, sub-ms access, encrypted serialization for persistence | Redis vault (network overhead), DB vault (latency)               |
| Regex-only validators over vm.Script       | Security: no arbitrary JS execution. Regex suffices for PII validation           | vm.Script sandbox (escape risk), eval (forbidden)                |
| Buffered audit over synchronous writes     | Fire-and-forget prevents audit from blocking request path                        | Sync writes (blocking), queue-based (infrastructure overhead)    |
| Module-level random cache over per-session | Simpler implementation; consistency across sessions for same PII values          | Per-session cache (better isolation, more memory)                |
| 40-char streaming buffer                   | Sufficient for longest PII pattern (credit card: 19 chars + separators)          | 20-char (too small for phone+country code), 100-char (wasteful)  |

### Key Interfaces & Types

```typescript
// pii-detector.ts
type PIIType = 'email' | 'phone' | 'ssn' | 'credit_card' | 'ip_address';

interface PIIDetection {
  type: PIIType;
  start: number;
  end: number;
  value: string;
}

interface PIIDetectionResult {
  hasPII: boolean;
  detections: PIIDetection[];
  redacted: string;
}

interface SelectivePIIResult extends PIIDetectionResult {
  exemptedTypes: PIIType[];
  redactedTypes: PIIType[];
}

// pii-vault.ts
type PIIConsumer = 'llm' | 'user' | 'logs' | 'tools' | (string & {});
type PIIRenderMode = 'original' | 'masked' | 'redacted' | 'tokenized' | 'random';

interface PIIToken {
  id: string;
  type: PIIType;
  original: string;
  token: string; // {{PII:<type>:<uuid>}}
}

interface TokenizeResult {
  text: string;
  tokens: PIIToken[];
}

interface MaskConfig {
  showFirst: number;
  showLast: number;
  maskChar: string;
}

interface RandomRedactionConfig {
  charset: 'alphanumeric' | 'alphabetic' | 'numeric' | 'custom';
  customChars?: string;
  length?: number;
}

interface PIIPatternConfig {
  patternName: string;
  defaultRenderMode: PIIRenderMode;
  consumerAccess: PIIConsumerAccessRule[];
  maskConfig?: MaskConfig;
  randomConfig?: RandomRedactionConfig;
}

// pii-recognizer-registry.ts
type RecognizerTier = 'regex' | 'ml' | 'custom';

interface PIIRecognizer {
  name: string;
  supportedTypes: PIIType[];
  tier: RecognizerTier;
  detect(text: string): PIIDetection[];
}

// pii-audit.ts
interface PIIAuditEntry {
  tenantId: string;
  projectId: string;
  sessionId: string;
  tokenId: string;
  piiType: string;
  consumer: string;
  action: string;
  metadata?: Record<string, unknown>;
  retentionDays?: number;
}

interface PIIAuditStore {
  insert(entry: PIIAuditEntry & { expireAt: Date }): Promise<void>;
}

// encrypted-vault.ts
interface VaultEncryptionService {
  encryptForTenant(plaintext: string, tenantId: string): string;
  decryptForTenant(encryptedData: string, tenantId: string): string;
}

// output-pii-filter.ts
interface OutputPIIFilterResult {
  text: string;
  filtered: boolean;
  redactedTypes: PIIType[];
}

// Database model (pii-pattern.model.ts)
interface IPIIPattern {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  description?: string;
  piiType: string;
  regex?: string;
  validate?: string;
  redaction: IPIIPatternRedaction;
  consumerAccess: IPIIPatternConsumerAccess[];
  defaultRenderMode: string;
  enabled: boolean;
  builtinOverride: boolean;
  createdBy: string;
}

// Database model (pii-audit-log.model.ts)
interface IPIIAuditLog {
  _id: string;
  tenantId: string;
  projectId: string;
  sessionId: string;
  tokenId: string;
  piiType: string;
  consumer: 'llm' | 'user' | 'logs' | 'tools';
  renderMode?: string;
  action: 'tokenize' | 'detokenize' | 'render' | 'clear';
  metadata?: Record<string, unknown>;
  expireAt: Date;
}

// Database model (project-runtime-config.model.ts)
interface IPIIRedactionConfig {
  enabled: boolean;
  redact_input: boolean;
  redact_output: boolean;
}
```

### Module Boundaries

| Module                    | Responsibilities                                                | Dependencies                   |
| ------------------------- | --------------------------------------------------------------- | ------------------------------ |
| `pii-detector`            | Regex patterns, detection, selective redaction, overlap removal | None (standalone)              |
| `pii-vault`               | Tokenization, consumer rendering, masking, random replacement   | `pii-detector` (detection)     |
| `pii-recognizer-registry` | Pluggable registry, built-in registrations, custom recognizers  | `pii-detector` (types)         |
| `pii-audit`               | Buffered audit logging                                          | None (interface-based)         |
| `streaming-pii-buffer`    | Chunk boundary detection for streaming                          | `pii-detector` (types)         |
| `encrypted-vault`         | Serialize/encrypt/decrypt vault                                 | `pii-vault` (serialization)    |
| `builtin-pii`             | Guardrail provider wrapping detection                           | `pii-detector` (detectPII)     |
| `pii-guard`               | Context-aware NLU input redaction                               | `pii-detector`, `pii-registry` |
| `trace-scrubber`          | PII/secret removal from trace data                              | `pii-detector` (redactPII)     |
| `output-pii-filter`       | Output filtering (legacy + vault-aware)                         | `pii-detector`, `pii-vault`    |
| `pattern-loader`          | DB to registry loading at session init                          | `pii-registry`, `pii-repo`     |
| `pattern-service`         | Validation, backtracking detection, pattern testing             | `pattern-loader` (validator)   |
| `pii-pattern-repo`        | MongoDB CRUD                                                    | `@agent-platform/database`     |
| `pii-patterns route`      | REST API endpoints                                              | `pattern-service`, `pii-repo`  |

---

## 2. File-Level Change Map

### Implemented Files

**Compiler Package -- Core Detection & Vault:**

| File                                                                 | Purpose                                                  | LOC  |
| -------------------------------------------------------------------- | -------------------------------------------------------- | ---- |
| `packages/compiler/src/platform/security/pii-detector.ts`            | Core detection: 5 regex, validators, selective redaction | ~303 |
| `packages/compiler/src/platform/security/pii-vault.ts`               | Tokenization vault, consumer rendering, masking, random  | ~367 |
| `packages/compiler/src/platform/security/pii-recognizer-registry.ts` | Pluggable recognizer registry, built-in registrations    | ~242 |
| `packages/compiler/src/platform/security/pii-audit.ts`               | Buffered audit logger                                    | ~80  |
| `packages/compiler/src/platform/security/streaming-pii-buffer.ts`    | 40-char trailing buffer for streaming                    | ~121 |
| `packages/compiler/src/platform/security/encrypted-vault.ts`         | Encrypt/decrypt vault for persistence                    | ~50  |
| `packages/compiler/src/platform/security/index.ts`                   | Module re-exports                                        | ~55  |

**Compiler Package -- Guardrail & NLU Integration:**

| File                                                                    | Purpose                                           | LOC  |
| ----------------------------------------------------------------------- | ------------------------------------------------- | ---- |
| `packages/compiler/src/platform/guardrails/providers/builtin-pii.ts`    | Tier 1 guardrail provider wrapping detectPII      | ~47  |
| `packages/compiler/src/platform/guardrails/action-executors.ts`         | executeRedact('pii') and executeFix('redact_pii') | ~76  |
| `packages/compiler/src/platform/guardrails/action-applier.ts`           | Apply non-terminal actions (redact/fix/filter)    | ~109 |
| `packages/compiler/src/platform/nlu/enterprise/pii-guard.ts`            | Context-aware PII guard with gather exemptions    | ~129 |
| `packages/compiler/src/platform/constructs/executors/trace-scrubber.ts` | PII + secret scrubbing from trace data            | ~94  |

**Runtime -- API & Services:**

| File                                                             | Purpose                                                   | LOC  |
| ---------------------------------------------------------------- | --------------------------------------------------------- | ---- |
| `apps/runtime/src/routes/pii-patterns.ts`                        | CRUD + test REST API (6 endpoints)                        | ~424 |
| `apps/runtime/src/repos/pii-pattern-repo.ts`                     | MongoDB repository (findAll, findEnabled, findById, etc.) | ~68  |
| `apps/runtime/src/services/pii/pattern-service.ts`               | Validation, backtracking, pattern testing                 | ~300 |
| `apps/runtime/src/services/pii/pattern-loader.ts`                | Load from DB, register custom recognizers                 | ~157 |
| `apps/runtime/src/services/execution/output-pii-filter.ts`       | Output PII filtering (legacy + vault-aware)               | ~96  |
| `apps/runtime/src/services/execution/pii-audit-singleton.ts`     | Runtime audit logger singleton                            | ~25  |
| `apps/runtime/src/services/execution/pii-audit-store-adapter.ts` | MongoDB adapter for PIIAuditStore interface               | ~42  |

**Database Models:**

| File                                                           | Purpose                                         | LOC        |
| -------------------------------------------------------------- | ----------------------------------------------- | ---------- |
| `packages/database/src/models/pii-pattern.model.ts`            | PIIPattern Mongoose model with tenant isolation | ~153       |
| `packages/database/src/models/pii-audit-log.model.ts`          | PIIAuditLog Mongoose model with TTL index       | ~92        |
| `packages/database/src/models/project-runtime-config.model.ts` | IPIIRedactionConfig embedded in project config  | (embedded) |

**Studio UI:**

| File                                                           | Purpose                                         | LOC   |
| -------------------------------------------------------------- | ----------------------------------------------- | ----- |
| `apps/studio/src/components/settings/PIIProtectionTab.tsx`     | Project settings tab for PII pattern management | ~400+ |
| `apps/studio/src/components/settings/PIIPatternFormDialog.tsx` | Modal form for pattern CRUD with live testing   | ~400+ |

**Test Files:**

| File                                                                           | Type        | Tests |
| ------------------------------------------------------------------------------ | ----------- | ----- |
| `packages/compiler/src/__tests__/security/pii-detector.test.ts`                | unit        | ~28   |
| `packages/compiler/src/__tests__/security/pii-vault.test.ts`                   | unit        | ~32   |
| `packages/compiler/src/__tests__/security/pii-recognizer-registry.test.ts`     | unit        | ~27   |
| `packages/compiler/src/__tests__/security/streaming-pii-buffer.test.ts`        | unit        | ~12   |
| `packages/compiler/src/__tests__/security/encrypted-vault.test.ts`             | unit        | ~8    |
| `packages/compiler/src/__tests__/security/pii-audit.test.ts`                   | unit        | ~8    |
| `packages/compiler/src/__tests__/guardrails/providers/builtin-pii.test.ts`     | unit        | ~7    |
| `packages/compiler/src/__tests__/guardrails/providers/builtin-pii-e2e.test.ts` | unit        | ~4    |
| `packages/compiler/src/__tests__/enterprise/pii-guard.test.ts`                 | unit        | ~6    |
| `apps/runtime/src/__tests__/output-pii-filter.test.ts`                         | unit        | ~14   |
| `apps/runtime/src/__tests__/pii-pattern-loader.test.ts`                        | unit        | ~10   |
| `apps/runtime/src/__tests__/pii-sandbox-escape.test.ts`                        | unit        | ~5    |
| `apps/runtime/src/__tests__/pii-testpattern-redos.test.ts`                     | unit        | ~4    |
| `apps/runtime/src/__tests__/pii-integration.test.ts`                           | integration | ~8    |
| `apps/runtime/src/__tests__/session-pii-vault.test.ts`                         | integration | ~6    |
| `apps/runtime/src/__tests__/attachment-pii.e2e.test.ts`                        | e2e         | ~6    |
| `packages/database/src/__tests__/pii-audit-log.test.ts`                        | unit        | ~5    |

---

## 3. Implementation Phases (Historical)

The feature was implemented in 3 phases. This section documents what was built in each phase for traceability.

### Phase 1: Core Detection Engine

**Exit Criteria**: `detectPII()`, `containsPII()`, `detectPIISelective()` working with all 5 types; unit tests passing.

| Task | File                   | Description                                                     | Status |
| ---- | ---------------------- | --------------------------------------------------------------- | ------ |
| 1.1  | `pii-detector.ts`      | 5 regex patterns with validators (Luhn, range, digit count)     | Done   |
| 1.2  | `pii-detector.ts`      | `detectPIISelective()` with exempt types + audit-safe detection | Done   |
| 1.3  | `pii-detector.ts`      | Overlap removal (sort by start, skip overlapping)               | Done   |
| 1.4  | `pii-detector.test.ts` | ~28 unit tests for all types, edge cases, overlaps              | Done   |

### Phase 2: Tokenization Vault + Streaming + Encryption

**Exit Criteria**: PIIVault round-trip working, streaming buffer handling chunk boundaries, encrypted persistence.

| Task | File                         | Description                                                             | Status |
| ---- | ---------------------------- | ----------------------------------------------------------------------- | ------ |
| 2.1  | `pii-vault.ts`               | `tokenize()` with `{{PII:<type>:<uuid>}}` format, 10K cap with LRU      | Done   |
| 2.2  | `pii-vault.ts`               | `renderForConsumer()` with resolution chain + 4 default consumers       | Done   |
| 2.3  | `pii-vault.ts`               | `applyMask()` with email-aware masking, configurable showFirst/showLast | Done   |
| 2.4  | `pii-vault.ts`               | `getRandomReplacement()` with session-scoped cache (50K max)            | Done   |
| 2.5  | `pii-vault.ts`               | `serialize()`/`deserialize()` for JSON persistence                      | Done   |
| 2.6  | `pii-recognizer-registry.ts` | Pluggable registry, 5 permanent built-in recognizers, max 50            | Done   |
| 2.7  | `streaming-pii-buffer.ts`    | 40-char trailing buffer, `processChunk()`, `flush()`                    | Done   |
| 2.8  | `encrypted-vault.ts`         | `encryptVault()`/`decryptVault()` via VaultEncryptionService            | Done   |
| 2.9  | Tests                        | ~70+ unit tests across vault, registry, streaming, encrypted            | Done   |

### Phase 3: Runtime Integration + API + Studio UI

**Exit Criteria**: Pattern CRUD API working, custom patterns loaded at session init, output filter wired, Studio UI functional.

| Task | File                         | Description                                               | Status |
| ---- | ---------------------------- | --------------------------------------------------------- | ------ |
| 3.1  | `pii-audit.ts`               | Buffered audit logger (100 entries, 5s flush)             | Done   |
| 3.2  | `pii-audit-store-adapter.ts` | MongoDB adapter for audit store                           | Done   |
| 3.3  | `pii-audit-singleton.ts`     | Runtime singleton accessor                                | Done   |
| 3.4  | `output-pii-filter.ts`       | Legacy + vault-aware output filtering                     | Done   |
| 3.5  | `pattern-loader.ts`          | Load from DB, register custom recognizers                 | Done   |
| 3.6  | `pattern-service.ts`         | Validation (regex, backtracking, length), pattern testing | Done   |
| 3.7  | `pii-pattern-repo.ts`        | MongoDB CRUD repository                                   | Done   |
| 3.8  | `pii-patterns.ts`            | REST API (6 endpoints) with auth, rate limiting, audit    | Done   |
| 3.9  | `pii-pattern.model.ts`       | Mongoose model with tenant isolation                      | Done   |
| 3.10 | `pii-audit-log.model.ts`     | Mongoose model with TTL index                             | Done   |
| 3.11 | `builtin-pii.ts`             | Guardrail provider wrapping detectPII()                   | Done   |
| 3.12 | `pii-guard.ts`               | Context-aware NLU input redaction                         | Done   |
| 3.13 | `trace-scrubber.ts`          | PII scrubbing from tool call trace data                   | Done   |
| 3.14 | `PIIProtectionTab.tsx`       | Studio settings tab                                       | Done   |
| 3.15 | `PIIPatternFormDialog.tsx`   | Studio CRUD dialog with live testing                      | Done   |
| 3.16 | Tests                        | ~30+ integration and E2E tests                            | Done   |

---

## 4. Wiring Checklist

All wiring verified against actual codebase:

| Wiring Point                                 | Source                          | Target                                                                | Verified                                   |
| -------------------------------------------- | ------------------------------- | --------------------------------------------------------------------- | ------------------------------------------ |
| PII detector exports                         | `security/index.ts`             | Compiler public API                                                   | Yes -- all types and functions re-exported |
| Builtin-PII provider auto-registration       | `provider-registry.ts:47-52`    | `BuiltinPIIProvider` imported and registered as permanent             | Yes                                        |
| Action executors redact mode                 | `action-executors.ts:16`        | `redactPII()` from `pii-detector.ts`                                  | Yes                                        |
| Action executors fix strategy                | `action-executors.ts:47`        | `redactPII()` from `pii-detector.ts`                                  | Yes                                        |
| Action applier calls executors               | `action-applier.ts:57-63`       | `executeRedact()`, `executeFix()`, `executeFilter()`                  | Yes                                        |
| PII guard hook creation                      | `pii-guard.ts:94-128`           | `detectPIISelective()` + `getDefaultPIIRecognizerRegistry()`          | Yes                                        |
| Trace scrubber uses redactPII                | `trace-scrubber.ts:92`          | `redactPII()` from `pii-detector.ts`                                  | Yes                                        |
| Pattern route mounts service                 | `pii-patterns.ts:18`            | `validatePattern`, `testPattern` from `pattern-service.ts`            | Yes                                        |
| Pattern route mounts repo                    | `pii-patterns.ts:17`            | `piiPatternRepo` from `pii-pattern-repo.ts`                           | Yes                                        |
| Pattern loader uses repo                     | `pattern-loader.ts:17`          | `findEnabled` from `pii-pattern-repo.ts`                              | Yes                                        |
| Pattern loader registers recognizers         | `pattern-loader.ts:60-65`       | `RegexPIIRecognizer` from compiler + `registry.register()`            | Yes                                        |
| Audit singleton uses adapter                 | `pii-audit-singleton.ts:7`      | `getAuditStore()` from `pii-audit-store-adapter.ts`                   | Yes                                        |
| Audit adapter uses model                     | `pii-audit-store-adapter.ts:19` | `PIIAuditLog` from `@agent-platform/database/models`                  | Yes                                        |
| Output filter uses detector                  | `output-pii-filter.ts:12`       | `detectPIISelective`, `getDefaultPIIRecognizerRegistry` from compiler | Yes                                        |
| PIIPattern model registers in ModelRegistry  | `pii-pattern.model.ts:147`      | `ModelRegistry.registerModelDefinition('PIIPattern')`                 | Yes                                        |
| PIIAuditLog model registers in ModelRegistry | `pii-audit-log.model.ts:86`     | `ModelRegistry.registerModelDefinition('PIIAuditLog')`                | Yes                                        |

---

## 5. Test Plan

### Unit Test Coverage

All core modules have unit tests with high coverage:

- `pii-detector.ts`: All 5 types, validation, selective redaction, overlaps
- `pii-vault.ts`: Tokenize, detokenize, render, mask, random, evict, serialize
- `pii-recognizer-registry.ts`: Register, unregister, permanent, detectAll, evict
- `streaming-pii-buffer.ts`: Chunk boundary, flush, short text, empty chunks
- `encrypted-vault.ts`: Round-trip, empty, failure handling
- `pii-audit.ts`: Buffer, flush, TTL, failure
- `builtin-pii.ts`: Name, cost, availability, detection, latency, raw
- `pii-guard.ts`: Exemptions, hook creation, config-disabled
- `output-pii-filter.ts`: Legacy, vault-aware, config flags, exempt types
- `pattern-loader.ts`: DB loading, registration, override, failure graceful
- `pii-sandbox-escape.test.ts`: Regex-only validation, JS rejection, backtracking
- `pii-testpattern-redos.test.ts`: ReDoS prevention, valid/invalid validators

### Integration Test Coverage

- `pii-integration.test.ts`: Vault round-trip with output filter, consumer views
- `session-pii-vault.test.ts`: Vault lifecycle in session store

### E2E Coverage

- `attachment-pii.e2e.test.ts`: Attachment PII detection pipeline

### E2E Gaps (to be addressed)

1. **Pattern CRUD API E2E** -- Real Express server, full auth middleware, all 6 endpoints
2. **Cross-tenant isolation E2E** -- Two tenants, verify 404 for cross-tenant access
3. **Custom pattern runtime detection E2E** -- Create pattern, new session, detect custom PII
4. **Streaming PII filtering E2E** -- Real streaming agent response with PII across chunk boundaries

---

## 6. Rollback Strategy

The feature is fully opt-in and can be disabled without code changes:

1. **Immediate**: Set `pii_redaction.enabled = false` in project runtime config. All PII detection stops.
2. **Pattern cleanup**: Delete custom patterns via API or direct MongoDB query on `pii_patterns` collection.
3. **Audit cleanup**: TTL index auto-deletes audit logs after 90 days. For immediate cleanup: `db.pii_audit_logs.drop()`.
4. **No schema migration needed**: All models are additive. Removing PII detection leaves no orphan data.

---

## 7. Constants & Limits Reference

| Constant                         | Value           | File                                           | Purpose                              |
| -------------------------------- | --------------- | ---------------------------------------------- | ------------------------------------ |
| `MAX_VAULT_TOKENS`               | 10,000          | `pii-vault.ts:22`                              | In-memory vault token capacity       |
| `MAX_RECOGNIZERS`                | 50              | `pii-recognizer-registry.ts:13`                | Recognizer registry capacity         |
| `MAX_REGISTRY_SIZE`              | 100             | `provider-registry.ts:31`                      | Guardrail provider registry capacity |
| `REGISTRY_TTL_MS`                | 300,000 (5 min) | `provider-registry.ts:32`                      | Provider registry TTL                |
| `StreamingPIIBuffer.BUFFER_SIZE` | 40              | `streaming-pii-buffer.ts:27`                   | Trailing buffer for streaming        |
| `MAX_BUFFER_SIZE`                | 100             | `pii-audit.ts:31`                              | Audit logger buffer capacity         |
| `FLUSH_INTERVAL_MS`              | 5,000           | `pii-audit.ts:32`                              | Audit logger flush interval          |
| `DEFAULT_RETENTION_DAYS`         | 90              | `pii-audit.ts:28`, `pii-audit-log.model.ts:43` | Audit log TTL                        |
| `MAX_REGEX_LENGTH`               | 2,048           | `pattern-service.ts:17`                        | Custom regex max length              |
| `MAX_VALIDATOR_LENGTH`           | 1,024           | `pattern-service.ts:18`                        | Validator expression max length      |
| `SANDBOX_TIMEOUT_MS`             | 50              | `pattern-loader.ts:23`                         | Validator execution timeout warning  |
| `MAX_RANDOM_CACHE`               | 50,000          | `pii-vault.ts:268`                             | Random replacement cache capacity    |
