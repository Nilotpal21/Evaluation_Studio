# PII Phase 2+3 — Full Specification & Comparison

## 1. Executive Summary

PII Phase 2+3 completes the PII handling pipeline for ABL. Phase 1 (already shipped) added input-side redaction with context-aware exemptions. Phase 2 adds **output redaction**, **reversible tokenization**, **sensitive display rendering**, **transient field cleanup**, and **session-scoped vault integration**. Phase 3 adds **encrypted vault persistence**, **pluggable recognizers**, **MongoDB audit logging**, **Redis vault storage**, **per-tool PII access**, and **streaming PII filtering**.

**Deliverables:** 16 modules fully wired, 13 commits, 527 passing tests across 14 test files. **No remaining gaps.**

---

## 2. Module Specifications

### 2.1 Output PII Filter

**File:** `apps/runtime/src/services/execution/output-pii-filter.ts`
**Test:** `apps/runtime/src/__tests__/output-pii-filter.test.ts` (15 tests)

**Purpose:** Redacts PII from agent responses before delivery to the user. Prevents the agent from echoing back collected PII (e.g. "I found your account under user@example.com").

**API:**

```typescript
function filterOutputPII(
  text: string,
  config: PIIRedactionConfig,
  exemptTypes?: Set<PIIType>,
): OutputPIIFilterResult;

interface PIIRedactionConfig {
  enabled: boolean;
  redactInput: boolean;
  redactOutput: boolean;
}

interface OutputPIIFilterResult {
  text: string; // Redacted or original text
  filtered: boolean; // Whether any PII was redacted
  redactedTypes: PIIType[]; // Which PII types were found and redacted
}
```

**Behavior:**

- Returns original text unchanged when `config.enabled === false` or `config.redactOutput === false`
- Delegates to `detectPIISelective()` for detection — same engine as input redaction
- Supports `exemptTypes` for types that should pass through (e.g. types user just provided)
- Logs via `createLogger('output-pii-filter')` when filtering occurs (OWASP LLM02 audit)
- Returns original text when no PII is detected

**Test coverage (15 tests):**

- Email, phone, SSN, credit card, IP address redaction
- Config flag combinations (disabled, redactOutput=false)
- No-PII passthrough, empty string, multiple PII types
- Exempt types, logging verification

---

### 2.2 PII Token Vault

**File:** `packages/compiler/src/platform/security/pii-vault.ts`
**Test:** `packages/compiler/src/__tests__/security/pii-vault.test.ts` (32 tests)

**Purpose:** Reversible tokenization. Replaces destructive `[REDACTED_*]` labels with `{{PII:<type>:<uuid>}}` tokens that can be resolved back to originals for authorized consumers.

**Token format:** `{{PII:<type>:<uuid>}}`

- `type`: one of `email`, `phone`, `ssn`, `credit_card`, `ip_address`
- `uuid`: `crypto.randomUUID()` (v4)

**API:**

```typescript
class PIIVault {
  tokenize(text: string, exemptTypes?: Set<PIIType>): TokenizeResult;
  detokenize(text: string): string;
  renderForConsumer(text: string, consumer: PIIConsumer): string;
  clear(): void;
  getTokenCount(): number;
}

type PIIConsumer = 'llm' | 'user' | 'logs' | 'tools';

interface PIIToken {
  id: string;
  type: PIIType;
  original: string;
  token: string;
}

interface TokenizeResult {
  text: string;
  tokens: PIIToken[];
}

function maskValue(value: string, type: PIIType): string; // exported
```

**Per-consumer rendering:**

| Consumer | Sees                          | Example                 |
| -------- | ----------------------------- | ----------------------- |
| `llm`    | Token as-is                   | `{{PII:phone:abc-123}}` |
| `user`   | Masked value                  | `***-***-4567`          |
| `logs`   | Redacted label                | `[REDACTED_PHONE]`      |
| `tools`  | Original value                | `555-123-4567`          |
| Unknown  | Redacted label (safe default) | `[REDACTED_PHONE]`      |

**Masking rules (`maskValue`):**

| Type          | Rule                                                  | Example                           |
| ------------- | ----------------------------------------------------- | --------------------------------- |
| `phone`       | Last 4 digits                                         | `***-***-4567`                    |
| `email`       | First char of local + domain (single-char: full mask) | `u***@example.com` or `***@b.com` |
| `credit_card` | Last 4 digits                                         | `****-****-****-1111`             |
| `ssn`         | Full mask                                             | `***-**-****`                     |
| `ip_address`  | Full mask                                             | `***.***.***.***`                 |

**Safety mechanisms:**

- **Bounded Map:** `MAX_VAULT_TOKENS = 10,000` with oldest-first eviction (CLAUDE.md invariant)
- **Regex safety:** `createTokenRegex()` factory — fresh regex per call, no shared `lastIndex` state
- **Email privacy:** Single-char local parts (e.g. `a@example.com`) produce `***@example.com`, not `a***@example.com`
- **Unknown tokens:** `detokenize` and `renderForConsumer` leave unrecognized token IDs unchanged

**Test coverage (32 tests):**

- Tokenize: PII replacement, multiple types, exempt types, unique UUIDs, all-exempt, vault storage
- Detokenize: round-trip, multiple tokens, no-tokens, unknown tokens
- renderForConsumer: all 4 consumers + unknown, unknown token IDs
- clear + getTokenCount lifecycle
- maskValue: all 5 PII types + edge cases (short values, missing @, single-char local)
- Eviction: bounded map behavior
- Pre-existing patterns: text already containing `{{PII:...}}` format

---

### 2.3 Sensitive Display Renderer

**File:** `packages/compiler/src/platform/security/sensitive-display.ts`
**Test:** `packages/compiler/src/__tests__/security/sensitive-display.test.ts` (24 tests)

**Purpose:** Renders collected GatherField values according to their `sensitive_display` and `mask_config` settings. Used in confirmation messages, summaries, and agent responses where gathered values are displayed outside the active gather context.

**API:**

```typescript
function renderSensitiveValue(value: unknown, field: GatherField): string;
```

**Behavior by `sensitive_display` mode:**

| Mode                         | Output                      | Example          |
| ---------------------------- | --------------------------- | ---------------- |
| `'redact'`                   | `[REDACTED]`                | `[REDACTED]`     |
| `'replace'`                  | `[FIELD_NAME]` (uppercased) | `[PHONE_NUMBER]` |
| `'mask'`                     | Configurable mask           | `*******890`     |
| Not set / `sensitive: false` | Original value              | `1234567890`     |

**Mask defaults:** `show_first: 0, show_last: 3, char: '*'`

**Edge cases:**

- `null`/`undefined` → empty string `''`
- Non-string values (numbers, booleans) → `String(value)` coercion
- Short values (length ≤ showFirst + showLast) → `char.repeat(Math.max(length, 3))`
- `sensitive: false` always returns original regardless of `sensitive_display`

**Test coverage (24 tests):**

- Non-sensitive passthrough (6 tests)
- Redact mode (2 tests)
- Replace mode (2 tests)
- Mask mode: default config, custom config, short values, empty string (6 tests)
- Null/undefined handling (3 tests)
- Type coercion: numbers, booleans, objects (5 tests)

---

### 2.4 Transient PII Cleanup

**File:** `apps/runtime/src/services/execution/transient-cleanup.ts`
**Test:** `apps/runtime/src/__tests__/transient-cleanup.test.ts` (14 tests)

**Purpose:** Removes fields marked `transient: true` from session data after gather completes. Handles ephemeral PII like CVV, OTP, and one-time verification tokens.

**API:**

```typescript
function cleanupTransientFields(data: Record<string, unknown>, fields: GatherField[]): string[]; // returns removed field names
```

**Behavior:**

- Iterates `fields`, deletes any with `transient: true` that exist in `data`
- Mutates `data` in-place (avoids unnecessary copying for large session objects)
- Logs removed field names via `createLogger('transient-cleanup')` when cleanup occurs
- Returns list of removed field names for trace events
- No-op when no transient fields exist or none are present in data

**Test coverage (14 tests):**

- Basic removal, multiple transient fields, no transient fields
- Fields not in data, empty fields array, empty data
- Explicit `transient: false`, `transient: undefined`
- Non-transient field preservation, in-place mutation verification
- Iteration order, extra data fields not in definitions
- Logging behavior (called/not-called)

---

### 2.5 Session Vault Integration

**Files modified:**

- `packages/compiler/src/platform/security/index.ts` — barrel exports
- `packages/compiler/src/index.ts` — main barrel exports
- `packages/compiler/package.json` — `exports` map for deep imports
- `apps/runtime/src/services/execution/types.ts` — `RuntimeSession.piiVault`

**Test:** `apps/runtime/src/__tests__/session-pii-vault.test.ts` (24 tests)

**Changes:**

1. **Barrel exports:** `PIIVault`, `maskValue`, `PIIToken`, `PIIConsumer`, `TokenizeResult`, `renderSensitiveValue` all accessible from `@abl/compiler`
2. **Package.json exports:** `./platform/security` and `./platform/security/pii-vault.js` added for direct deep imports
3. **RuntimeSession type:** Added `piiVault?: PIIVault` optional field (line 244 of types.ts)

**Test coverage (24 tests):**

- Round-trip tokenize/detokenize for all 5 PII types
- Per-consumer rendering (tools, user, logs, llm) for all types
- Exemptions with per-consumer rendering
- Detokenize after clear, no-PII passthrough, unknown token IDs
- Multiple PII values, maskValue unit tests
- Session-like object integration test
- getTokenCount tracking

---

### 2.6 PII Detector (Pluggable Registry Support)

**File:** `packages/compiler/src/platform/security/pii-detector.ts`
**Test:** `packages/compiler/src/__tests__/security/pii-detector.test.ts` (45+ tests via test.each)

**Purpose:** Regex-based PII detection with optional pluggable registry. Core engine used by both input guards and output filters.

**API (updated for registry support):**

```typescript
function detectPII(text: string, registry?: PIIRecognizerRegistry): PIIDetectionResult;
function detectPIISelective(
  text: string,
  exemptTypes?: Set<PIIType>,
  registry?: PIIRecognizerRegistry,
): SelectivePIIResult;
function containsPII(text: string, registry?: PIIRecognizerRegistry): boolean;
function redactPII(text: string): string; // delegates to detectPII
```

**Behavior:**

- When `registry` is provided, uses `registry.detectAll(text)` instead of hardcoded `PII_PATTERNS`
- When omitted, falls back to built-in patterns (backward compatible)
- `REDACT_LABELS` map for consistent label output: `email→[REDACTED_EMAIL]`, `ssn→[REDACTED_SSN]`, `credit_card→[REDACTED_CARD]`, `phone→[REDACTED_PHONE]`, `ip_address→[REDACTED_IP]`
- Overlap removal: keeps first/longer match when detections overlap
- Validators: Luhn check for credit cards, digit range for phone/IP

**Callsite wiring:**

- `pii-guard.ts:108` — passes `getDefaultPIIRecognizerRegistry()` to `detectPIISelective()`
- `output-pii-filter.ts:43` — passes `getDefaultPIIRecognizerRegistry()` to `detectPIISelective()`

---

### 2.7 PII Recognizer Registry

**File:** `packages/compiler/src/platform/security/pii-recognizer-registry.ts`
**Test:** `packages/compiler/src/__tests__/security/pii-recognizer-registry.test.ts` (39 tests)

**Purpose:** Presidio-inspired pluggable recognizer interface. Allows registration of custom PII recognizers (regex, ML, or domain-specific).

**API:**

```typescript
interface PIIRecognizer {
  name: string;
  supportedTypes: PIIType[];
  tier: 'regex' | 'ml' | 'custom';
  detect(text: string): PIIDetection[];
}

class PIIRecognizerRegistry {
  register(recognizer: PIIRecognizer, options?: { permanent?: boolean }): void;
  unregister(name: string): boolean;
  get(name: string): PIIRecognizer | undefined;
  detectAll(text: string, exemptTypes?: Set<PIIType>): PIIDetection[];
  listRecognizers(): Array<{ name: string; tier: RecognizerTier; types: PIIType[] }>;
  getRecognizerCount(): number;
}

class RegexPIIRecognizer implements PIIRecognizer { ... }

function getDefaultPIIRecognizerRegistry(): PIIRecognizerRegistry; // singleton
function resetDefaultRegistry(): void; // testing
```

**Built-in recognizers (5, all permanent):**

| Name                  | Type        | Validator    |
| --------------------- | ----------- | ------------ |
| `builtin-email`       | email       | —            |
| `builtin-ssn`         | ssn         | —            |
| `builtin-credit-card` | credit_card | Luhn check   |
| `builtin-phone`       | phone       | Digit length |
| `builtin-ip-address`  | ip_address  | Octet range  |

**Safety:** `MAX_RECOGNIZERS = 50` with oldest-non-permanent eviction. Error isolation in `detectAll()` — one failing recognizer doesn't break others.

---

### 2.8 Encrypted Vault

**File:** `packages/compiler/src/platform/security/encrypted-vault.ts`
**Test:** `packages/compiler/src/__tests__/security/encrypted-vault.test.ts` (17 tests)

**Purpose:** App-level vault encryption via tenant-scoped keys. Provides `VaultEncryptionService` interface decoupled from concrete `EncryptionService`.

**API:**

```typescript
interface VaultEncryptionService {
  encryptForTenant(plaintext: string, tenantId: string): string;
  decryptForTenant(encryptedData: string, tenantId: string): string;
}

function encryptVault(
  vault: PIIVault,
  tenantId: string,
  service: VaultEncryptionService,
): string | null;
function decryptVault(
  encrypted: string,
  tenantId: string,
  service: VaultEncryptionService,
): PIIVault | null;
```

**Note:** In production, vault data is encrypted at rest via Redis field-level encryption (`piiVaultData` in `ENCRYPTED_FIELDS` in `redis-session-store.ts`). The `encrypted-vault.ts` module provides an additional app-level encryption option.

---

### 2.9 PII Audit Logger

**File:** `packages/compiler/src/platform/security/pii-audit.ts`
**Test:** `packages/compiler/src/__tests__/security/pii-audit.test.ts` (17 tests)

**Purpose:** Async, fire-and-forget audit logging for PII access events. Buffers entries and flushes in batches.

**API:**

```typescript
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

class PIIAuditLogger {
  constructor(store: PIIAuditStore);
  log(entry: PIIAuditEntry): void; // non-blocking
  async flush(): Promise<void>;
  stop(): void;
  getBufferSize(): number;
}
```

**Configuration:** `MAX_BUFFER_SIZE = 100`, `FLUSH_INTERVAL_MS = 5000`, `DEFAULT_RETENTION_DAYS = 90`

---

### 2.10 PII Audit MongoDB Model

**File:** `packages/database/src/models/pii-audit-log.model.ts`
**Test:** `packages/database/src/__tests__/pii-audit-log.test.ts` (17 tests)

**Schema fields:** `_id` (uuidv7), `tenantId`, `projectId`, `sessionId`, `tokenId`, `piiType`, `consumer` (enum: llm/user/logs/tools), `action` (enum: tokenize/detokenize/render/clear), `metadata`, `expireAt` (TTL), `createdAt`

**Indexes:** `(tenantId, sessionId)`, `(tenantId, createdAt DESC)`, `(tenantId, piiType, createdAt DESC)`, TTL on `expireAt` (auto-delete after 90 days)

**Collection:** `pii_audit_logs`

---

### 2.11 MongoDB Audit Store Adapter

**File:** `apps/runtime/src/services/execution/pii-audit-store-adapter.ts`

**Purpose:** Connects `PIIAuditLogger` (compiler) to `PIIAuditLog` MongoDB model (database) via the `PIIAuditStore` interface. Lazy-loads the model to avoid requiring MongoDB connection at import time.

```typescript
class MongoDBPIIAuditStore implements PIIAuditStore {
  async insert(entry: PIIAuditEntry & { expireAt: Date }): Promise<void>;
}
function getAuditStore(): MongoDBPIIAuditStore; // singleton
```

---

### 2.12 PII Audit Singleton

**File:** `apps/runtime/src/services/execution/pii-audit-singleton.ts`

**Purpose:** Singleton `PIIAuditLogger` for the runtime. Lazily instantiated on first access.

```typescript
function getPIIAuditLogger(): PIIAuditLogger;
function resetPIIAuditLogger(): void; // testing
```

**Wired at 3 points in reasoning-executor.ts:**

| Event    | When                                | Fields logged                                 |
| -------- | ----------------------------------- | --------------------------------------------- |
| tokenize | Output PII tokenization (line ~971) | Per-token: tokenId, piiType, consumer='user'  |
| render   | Per-tool context injection (~1557)  | key, consumer=toolDef.pii_access, toolName    |
| clear    | Session complete/handoff (~1024)    | tokenId='\*', piiType='\*', consumer='system' |

---

### 2.13 PII Guard (Input-Side, Phase 1)

**File:** `packages/compiler/src/platform/nlu/enterprise/pii-guard.ts`
**Test:** `packages/compiler/src/__tests__/enterprise/pii-guard.test.ts` (33 tests)

**Purpose:** Input-side PII redaction with context-aware exemptions. Part of the NLU pipeline.

**API:**

```typescript
function createPIIGuardHook(
  config: NLUConfig,
): (ctx: NLUContext, task: NLUTask) => Promise<NLUContext>;
function resolveGatherExemptions(
  missingFields?: string[],
  declaredEntities?: EntityDefinition[],
): Set<PIIType>;
```

**Field-to-PII mappings:** phone/mobile/cell → `phone`, email/contact_email → `email`, ssn/social_security → `ssn`, credit_card/card_number → `credit_card`, ip/ip_address → `ip_address`

**Wiring:** `tenant-manager.ts:200` — `hooks.beforeExecute = createPIIGuardHook(config)` when `config.piiRedaction.enabled`. Now uses `getDefaultPIIRecognizerRegistry()` for pluggable detection.

---

## 3. Comparison: Design → Plan → Implementation

### 3.1 Design Doc Requirements (Phase 2 section, lines 246-291)

| Design Requirement                                          | Plan Task         | Implementation                                                   | Status                    |
| ----------------------------------------------------------- | ----------------- | ---------------------------------------------------------------- | ------------------------- |
| Token format `{{PII:<type>:<uuid>}}`                        | Task 2            | `PIIVault.tokenize()` produces exact format                      | **Implemented**           |
| AES-256-GCM encrypted vault at rest                         | Task 2 (deferred) | `ENCRYPTED_FIELDS` in redis-session-store + `encrypted-vault.ts` | **Implemented (Phase 3)** |
| Redis session-lifetime tokens                               | Task 5 (deferred) | `piiVaultData` field in `SessionData`, serialized to Redis       | **Implemented (Phase 3)** |
| MongoDB audit retention with TTL                            | Not planned       | `PIIAuditLog` model + `PIIAuditLogger` → reasoning-executor      | **Implemented (Phase 3)** |
| Transient PII: cleanup after gather                         | Task 4            | `cleanupTransientFields()` on complete/handoff                   | **Implemented**           |
| Per-consumer views: LLM=tokens                              | Task 2            | `renderForConsumer(text, 'llm')` returns tokens as-is            | **Implemented**           |
| Per-consumer views: User=masked/replaced/original           | Task 2 + Task 3   | `renderForConsumer(text, 'user')` + `renderSensitiveValue()`     | **Implemented**           |
| Per-consumer views: Logs=redacted                           | Task 2            | `renderForConsumer(text, 'logs')` returns `[REDACTED_*]`         | **Implemented**           |
| Per-consumer views: Tools=original                          | Task 2            | `renderForConsumer(text, 'tools')` returns original              | **Implemented**           |
| Pluggable recognizers (`PIIRecognizer` interface)           | Not planned       | `PIIRecognizerRegistry` → wired into `detectPII`/`pii-guard`     | **Implemented (Phase 3)** |
| XO `isSensitive` → `sensitive: true`                        | Phase 1           | `GatherField.sensitive` in IR schema                             | **Implemented (Phase 1)** |
| XO `sensitive_pattern.display.type` → `sensitive_display`   | Phase 1 + Task 3  | Schema field + `renderSensitiveValue()` renderer                 | **Implemented**           |
| XO `sensitive_pattern.display.maskingProps` → `mask_config` | Phase 1 + Task 3  | Schema field + `maskString()` with configurable params           | **Implemented**           |
| XO `isTransient` → `transient: true`                        | Phase 1 + Task 4  | Schema field + `cleanupTransientFields()`                        | **Implemented**           |
| XO `#*#TYPE-UNIQID-DISPLAY#*#` → `{{PII:<type>:<uuid>}}`    | Task 2            | Exact token format match                                         | **Implemented**           |
| XO `redactObj()/redactObjEntity()` → selective redaction    | Phase 1           | `detectPIISelective()` with exemptions                           | **Implemented (Phase 1)** |
| XO `AnonymizeUtils.excludeFields` → per-consumer views      | Task 2            | `PIIVault.renderForConsumer()`                                   | **Implemented**           |

### 3.2 Plan → Implementation Comparison

| Plan Item                   | Plan Tests | Actual Tests | Delta   | Notes                                                                          |
| --------------------------- | ---------- | ------------ | ------- | ------------------------------------------------------------------------------ |
| Task 1: Output PII filter   | 7          | 15           | +8      | Added per-type tests (SSN, card, IP), edge cases, logging verification         |
| Task 2: PII token vault     | 14         | 32           | +18     | Added maskValue unit tests, eviction, pre-existing patterns, single-char email |
| Task 3: Sensitive display   | 8          | 24           | +16     | Added type coercion (numbers, booleans, objects), extensive mask mode tests    |
| Task 4: Transient cleanup   | 5          | 14           | +9      | Added explicit false/undefined, mutation verification, logging, ordering       |
| Task 5: Session integration | 4          | 24           | +20     | Added per-type rendering, exemptions, multi-value, maskValue, session object   |
| **Total**                   | **38**     | **109**      | **+71** | **2.87x plan target**                                                          |

### 3.3 Plan Deviations

| Deviation                                        | Description                                                                                                                             | Rationale                                                                                                                                                                          |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`piiRedactionConfig` on session**              | Plan assumed `session.nluConfig.piiRedaction`. Implementation adds `session.piiRedactionConfig` resolved lazily via `buildNLUConfig()`. | `NLUConfig` is not on session or AgentIR. Resolving from environment + env vars at execute() start is simpler and matches the existing `session.versionInfo?.environment` pattern. |
| **`maskValue` exported**                         | Plan had `maskValue` as a private function. Implementation exports it.                                                                  | Code review identified the need for direct testing of all masking branches.                                                                                                        |
| **`createTokenRegex()` factory**                 | Plan used module-level `const TOKEN_REGEX` with `g` flag. Implementation uses factory.                                                  | Code review found latent `lastIndex` corruption risk with shared stateful `g`-flag regex.                                                                                          |
| **`MAX_VAULT_TOKENS` eviction**                  | Plan had unbounded `Map`. Implementation caps at 10,000 with oldest-first eviction.                                                     | CLAUDE.md invariant: "Every in-memory Map needs max size, TTL, and eviction."                                                                                                      |
| **Email single-char mask fix**                   | Plan had `${local[0]}***@${domain}`. Implementation guards `local.length > 1`.                                                          | Code review found 1-char local parts (e.g. `a@b.com`) fully exposed.                                                                                                               |
| **Session types path**                           | Plan said `apps/runtime/src/services/session/types.ts`. Actual: `apps/runtime/src/services/execution/types.ts`.                         | The `RuntimeSession` interface lives in the execution module, not session module.                                                                                                  |
| **Barrel exports were partially done by Task 3** | Plan had Task 5 adding `renderSensitiveValue` to barrel. Task 3 agent already did it.                                                   | Agent autonomy — Task 3 correctly identified the export was needed for its own tests.                                                                                              |

---

## 4. What's Implemented vs. Not

### Implemented (Phase 2)

| Capability                                    | Module                            | Status    |
| --------------------------------------------- | --------------------------------- | --------- |
| Output PII redaction (agent responses)        | `output-pii-filter.ts`            | **Wired** |
| Reversible PII tokenization                   | `pii-vault.ts`                    | **Wired** |
| Per-consumer views (LLM/user/logs/tools)      | `pii-vault.ts`                    | **Wired** |
| Sensitive field display (redact/mask/replace) | `sensitive-display.ts`            | **Wired** |
| Transient field cleanup (CVV/OTP)             | `transient-cleanup.ts`            | **Wired** |
| Session-scoped vault + config resolution      | `reasoning-executor.ts:235-245`   | **Wired** |
| Bounded vault with eviction                   | `pii-vault.ts`                    | **Wired** |
| PII redaction config from environment         | `reasoning-executor.ts:235-242`   | **Wired** |
| Streaming PII filtering (4 flush points)      | `reasoning-executor.ts:1023-1033` | **Wired** |
| Per-tool PII access control                   | `reasoning-executor.ts:1527-1532` | **Wired** |

### Wired Integration Points (completed)

| Integration Point                         | Where                                        | How                                                                                                                  |
| ----------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| PIIVault + config initialization          | `reasoning-executor.ts:235-245`              | Lazily resolves `piiRedactionConfig` via `buildNLUConfig({ environment, envVars })`, creates `PIIVault` when enabled |
| Reversible tokenization in response path  | `reasoning-executor.ts:962-970`              | `vault.tokenize()` + `renderForConsumer('user')` when vault available; destructive `filterOutputPII()` fallback      |
| Streaming PII filter (4 flush points)     | `reasoning-executor.ts:784,871,891,1196`     | `filterChunkPII()` wraps all 4 `onChunk` flush points — tokenize + render for user                                   |
| Transient cleanup at gather completion    | `reasoning-executor.ts:1004`                 | `cleanupTransientFields(session.data.values, gatherFields)` on `complete` or `handoff` actions                       |
| Vault clear on session end                | `reasoning-executor.ts:1007-1008`            | `session.piiVault.clear()` on `complete` or `handoff`                                                                |
| Per-tool PII access in context injection  | `reasoning-executor.ts:1527-1532`            | `vault.renderForConsumer(val, toolDef.pii_access)` when tool has restricted `pii_access`                             |
| Sensitive display in confirmations        | `tool-confirmation.ts`, `field-inference.ts` | `renderSensitiveValue(value, field)` for gathered values in confirmation messages                                    |
| Vault persistence (serialize/deserialize) | `runtime-executor.ts`                        | `vault.serialize()` in `saveSessionSnapshot()`, `PIIVault.deserialize()` in `rehydrateSession()`                     |
| Redis encrypted storage                   | `redis-session-store.ts`                     | `piiVaultData` in `SESSION_JSON_FIELDS` + `ENCRYPTED_FIELDS` (AES-256-GCM at rest)                                   |

### Phase 3 — Implemented

| Capability                              | Module                                                               | Status    |
| --------------------------------------- | -------------------------------------------------------------------- | --------- |
| AES-256-GCM encrypted vault persistence | `redis-session-store.ts` (`ENCRYPTED_FIELDS` + `encrypted-vault.ts`) | **Wired** |
| Redis session-lifetime token storage    | `redis-session-store.ts` (piiVaultData field)                        | **Wired** |
| MongoDB audit retention with TTL        | `pii-audit-log.model.ts` + `pii-audit-singleton.ts`                  | **Wired** |
| Pluggable recognizers (`PIIRecognizer`) | `pii-recognizer-registry.ts` → `detectPII`/`pii-guard.ts`            | **Wired** |
| Per-consumer views in streaming         | `reasoning-executor.ts` (filterChunkPII)                             | **Wired** |
| Configurable per-tool `pii_access`      | `schema.ts` + `reasoning-executor.ts`                                | **Wired** |

### Phase 2 Gaps — Resolved

| Previously Open Gap                               | Resolution                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| PIIVault `tokenize()` not called in response path | Now uses vault.tokenize() + renderForConsumer('user') when vault is available               |
| `renderSensitiveValue()` not called in executor   | Wired into tool-confirmation.ts and field-inference.ts for sensitive gathered value display |
| No integration tests for wired paths              | 16 integration tests in `pii-integration.test.ts`                                           |
| Streaming path (`onChunk`) not filtered           | `filterChunkPII()` wraps all 4 onChunk flush points in reasoning-executor                   |
| `PIIVault.clear()` not called on session end      | vault.clear() called on complete/handoff actions after transient cleanup                    |

### Remaining Gaps — All Resolved

| Previously Open Gap                                    | Resolution                                                                                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PIIRecognizerRegistry not wired into detectPII         | `detectPII`/`detectPIISelective` now accept optional `registry` param. `pii-guard.ts` and `output-pii-filter.ts` pass `getDefaultPIIRecognizerRegistry()`.          |
| PIIAuditLogger not instantiated in reasoning-executor  | `MongoDBPIIAuditStore` adapter + singleton `getPIIAuditLogger()`. Wired at tokenize, render (per-tool), and clear events in reasoning-executor.                     |
| Vault encryption uses interface, not EncryptionService | Already resolved: `piiVaultData` is in `ENCRYPTED_FIELDS` in `redis-session-store.ts` — encrypted via `EncryptionService.encryptForTenant()` (AES-256-GCM at rest). |

---

## 5. Test Inventory

| File                              | Package  | Tests   | Covers                                                                |
| --------------------------------- | -------- | ------- | --------------------------------------------------------------------- |
| `pii-detector.test.ts`            | compiler | 45+     | detectPII, detectPIISelective, containsPII, redactPII, registry param |
| `pii-vault.test.ts`               | compiler | 32      | tokenize, detokenize, renderForConsumer, maskValue, eviction          |
| `pii-recognizer-registry.test.ts` | compiler | 39      | register/unregister, detectAll, built-ins, eviction, errors           |
| `sensitive-display.test.ts`       | compiler | 24      | redact/mask/replace modes, edge cases, type coercion                  |
| `encrypted-vault.test.ts`         | compiler | 17      | encrypt/decrypt round-trip, error handling, empty vault               |
| `pii-audit.test.ts`               | compiler | 17      | buffer, flush, TTL, error handling, stop/cleanup                      |
| `pii-guard.test.ts`               | compiler | 33      | createPIIGuardHook, resolveGatherExemptions, field mappings           |
| `pii-integration.test.ts`         | runtime  | 16      | output tokenization, streaming, transient, vault lifecycle            |
| `output-pii-filter.test.ts`       | runtime  | 15      | per-type redaction, config flags, exempt types, logging               |
| `transient-cleanup.test.ts`       | runtime  | 14      | field removal, edge cases, mutation, logging                          |
| `session-pii-vault.test.ts`       | runtime  | 24      | serialize/deserialize, per-consumer, session integration              |
| `tool-confirmation.test.ts`       | runtime  | 22      | renderSensitiveValue in confirmations (5 PII-specific)                |
| `field-inference.test.ts`         | runtime  | 39      | renderSensitiveValue in inferences (6 PII-specific)                   |
| `pii-audit-log.test.ts`           | database | 17      | schema validation, TTL index, enums, collection name                  |
| **Total (vitest)**                |          | **527** | Verified via `pnpm vitest run` across all 14 files                    |

---

## 6. Complete File Inventory

### Implementation Files

| File                                                                 | Package  | Role                                         |
| -------------------------------------------------------------------- | -------- | -------------------------------------------- |
| `packages/compiler/src/platform/security/pii-detector.ts`            | compiler | Detection engine (5 PII types)               |
| `packages/compiler/src/platform/security/pii-vault.ts`               | compiler | Reversible tokenization vault                |
| `packages/compiler/src/platform/security/pii-recognizer-registry.ts` | compiler | Pluggable recognizer interface               |
| `packages/compiler/src/platform/security/encrypted-vault.ts`         | compiler | App-level vault encryption                   |
| `packages/compiler/src/platform/security/pii-audit.ts`               | compiler | Buffered audit logger                        |
| `packages/compiler/src/platform/security/sensitive-display.ts`       | compiler | Sensitive field rendering                    |
| `packages/compiler/src/platform/security/index.ts`                   | compiler | Barrel exports                               |
| `packages/compiler/src/platform/nlu/enterprise/pii-guard.ts`         | compiler | Input-side PII guard hook                    |
| `packages/compiler/src/platform/ir/schema.ts`                        | compiler | IR fields: pii_access, sensitive, transient  |
| `apps/runtime/src/services/execution/reasoning-executor.ts`          | runtime  | Integration hub (all PII wiring)             |
| `apps/runtime/src/services/execution/output-pii-filter.ts`           | runtime  | Destructive output redaction fallback        |
| `apps/runtime/src/services/execution/transient-cleanup.ts`           | runtime  | Ephemeral field cleanup                      |
| `apps/runtime/src/services/execution/pii-audit-store-adapter.ts`     | runtime  | MongoDB ↔ PIIAuditStore adapter              |
| `apps/runtime/src/services/execution/pii-audit-singleton.ts`         | runtime  | Singleton audit logger                       |
| `apps/runtime/src/services/execution/tool-confirmation.ts`           | runtime  | Sensitive display in confirmations           |
| `apps/runtime/src/services/execution/field-inference.ts`             | runtime  | Sensitive display in inferences              |
| `apps/runtime/src/services/execution/types.ts`                       | runtime  | RuntimeSession.piiVault, piiRedactionConfig  |
| `apps/runtime/src/services/session/types.ts`                         | runtime  | SessionData.piiVaultData, piiRedactionConfig |
| `apps/runtime/src/services/session/redis-session-store.ts`           | runtime  | ENCRYPTED_FIELDS, SESSION_JSON_FIELDS        |
| `apps/runtime/src/services/runtime-executor.ts`                      | runtime  | Vault serialize/deserialize lifecycle        |
| `packages/database/src/models/pii-audit-log.model.ts`                | database | MongoDB audit schema + TTL index             |

### IR Schema Fields

| Interface        | Field               | Type/Values                      | Purpose                             |
| ---------------- | ------------------- | -------------------------------- | ----------------------------------- |
| `ToolDefinition` | `pii_access`        | `'tools'\|'user'\|'logs'\|'llm'` | Per-tool PII visibility level       |
| `GatherField`    | `sensitive`         | `boolean`                        | Marks field as carrying PII         |
| `GatherField`    | `sensitive_display` | `'redact'\|'mask'\|'replace'`    | Display mode outside gather context |
| `GatherField`    | `mask_config`       | `{show_first, show_last, char}`  | Masking parameters for mask mode    |
| `GatherField`    | `transient`         | `boolean`                        | Ephemeral — deleted after gather    |

---

## 7. Architecture Diagram

```
User Input                              Agent Response
    │                                        ▲
    ▼                                        │
┌───────────────┐                            │
│ PII Guard     │ Phase 1                    │
│ (input)       │                            │
│ pii-guard.ts  │                            │
└───────┬───────┘                            │
        │                                    │
        ▼                                    │
┌───────────────┐                            │
│ detectPII-    │ Phase 1                    │
│ Selective()   │                            │
│ pii-detector  │                            │
└───────────────┘                            │
                                             │
┌══════════════════════════════════════════════════════════════════════════════┐
║                reasoning-executor.ts (integration hub)                       ║
║                                                                              ║
║  execute() start (line 235-245):                                             ║
║    ┌──────────────────────────────────────────────┐                          ║
║    │ 1. Resolve piiRedactionConfig via             │                         ║
║    │    buildNLUConfig(environment, envVars)        │                         ║
║    │ 2. Initialize PIIVault if enabled              │                         ║
║    └──────────────────────────────────────────────┘                          ║
║                        │                                                     ║
║                        ▼                                                     ║
║           [ LLM reasoning loop ]                                             ║
║                │               │                                             ║
║                │               ▼                                             ║
║                │   Streaming: filterChunkPII() (lines 784, 871, 891, 1196)   ║
║                │     vault.tokenize() + renderForConsumer('user')             ║
║                │                                                             ║
║                ▼                                                             ║
║  Tool execution (line 1527-1532):                                            ║
║    ┌──────────────────────────────────────────────┐                          ║
║    │ Per-tool pii_access: vault.renderForConsumer() │                         ║
║    │   tools → original, user → masked, logs → [R] │                         ║
║    └──────────────────────────────────────────────┘                          ║
║                        │                                                     ║
║                        ▼                                                     ║
║  After output guardrails (line 962-970):                                     ║
║    ┌──────────────────────────────────────────────┐                          ║
║    │ vault.tokenize() → history (reversible tokens) │                         ║
║    │ vault.renderForConsumer('user') → user (masked) │                        ║
║    │ fallback: filterOutputPII() → destructive [R]  │                         ║
║    └──────────────────────────────────────────────┘                          ║
║                        │                                                     ║
║                        ▼                                                     ║
║  On complete/handoff (line 1004-1008):                                       ║
║    ┌──────────────────────────────────────────────┐                          ║
║    │ cleanupTransientFields(data, fields) → CVV gone │                        ║
║    │ session.piiVault.clear()                        │                        ║
║    └──────────────────────────────────────────────┘                          ║
╚══════════════════════════════════════════════════════════════════════════════╝
         │                                    │
         ▼                                    ▼
┌────────────────────────┐   ┌────────────────────────────────────┐
│ runtime-executor.ts    │   │     redis-session-store.ts         │ Phase 3
│ (session persistence)  │   │                                    │
│                        │   │  piiVaultData in ENCRYPTED_FIELDS  │
│  saveSessionSnapshot:  │──►│  AES-256-GCM encryption at rest   │
│    vault.serialize()   │   │  SESSION_JSON_FIELDS parsing      │
│  rehydrateSession:     │◄──│                                    │
│    PIIVault.deserialize│   └────────────────────────────────────┘
└────────────────────────┘

┌───────────────────────────────────────────────────┐
│                   PII Token Vault                  │ Phase 2
│              pii-vault.ts (PIIVault)               │
│                                                    │
│  tokenize() ──► {{PII:<type>:<uuid>}} tokens       │
│  detokenize() ──► original values                  │
│  renderForConsumer() ──► per-consumer views         │
│  serialize() / deserialize() ──► JSON persistence  │
│                                                    │
│  store: Map<id, PIIToken> (max 10,000, eviction)   │
└───────────────────────┬───────────────────────────┘
                        │
        ┌───────────────┼───────────────┐───────────┐
        ▼               ▼               ▼           ▼
   ┌─────────┐   ┌───────────┐   ┌──────────┐ ┌─────────┐
   │  LLM    │   │   User    │   │  Logs    │ │  Tools  │
   │ tokens  │   │  masked   │   │ redacted │ │ original│
   └─────────┘   └───────────┘   └──────────┘ └─────────┘

┌───────────────────────────────────────────────────┐
│            Sensitive Display Renderer               │ Phase 2
│         sensitive-display.ts                        │
│  renderSensitiveValue(value, field) ──►             │
│    redact / replace / mask (configurable)          │
│  Wired: tool-confirmation.ts, field-inference.ts   │
└───────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────┐
│          Phase 3: Extensibility Modules             │
│                                                    │
│  encrypted-vault.ts ─── VaultEncryptionService     │
│  pii-recognizer-registry.ts ─── PIIRecognizer[]    │
│  pii-audit.ts ─── PIIAuditLogger (buffered)        │
│  pii-audit-log.model.ts ─── MongoDB TTL (90 days) │
└───────────────────────────────────────────────────┘
```

---

## 7. XO Migration Readiness

| XO Feature                         | ABL Phase 1                     | ABL Phase 2                              | Gap  |
| ---------------------------------- | ------------------------------- | ---------------------------------------- | ---- |
| `isSensitive` on entity            | `GatherField.sensitive`         | —                                        | None |
| `sensitive_pattern.display`        | `GatherField.sensitive_display` | `renderSensitiveValue()` renderer        | None |
| `maskingProps`                     | `GatherField.mask_config`       | `maskString()` with configurable params  | None |
| `isTransient`                      | `GatherField.transient`         | `cleanupTransientFields()` — wired       | None |
| `Sensitive:<streamId>:<userId>`    | `ctx.missingFields` exemptions  | —                                        | None |
| `#*#TYPE-UNIQID-DISPLAY#*#` tokens | —                               | `{{PII:<type>:<uuid>}}` in PIIVault      | None |
| `redactObj()/redactObjEntity()`    | `detectPIISelective()`          | —                                        | None |
| `AnonymizeUtils.excludeFields`     | —                               | `renderForConsumer()` per-consumer views | None |
| Output PII redaction               | —                               | `filterOutputPII()` — wired              | None |
| Encrypted PII storage              | —                               | `encrypted-vault.ts` + Redis persistence | None |
| Pluggable recognizers              | —                               | `PIIRecognizerRegistry` → `detectPII`    | None |

---

## 8. Commits

| #   | SHA         | Message                                                                      | Files                                                                                     |
| --- | ----------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | `02377fdf4` | `docs(shared): add PII Phase 2 implementation plan`                          | plan doc                                                                                  |
| 2   | `c492595e1` | `feat(compiler): add PII token vault with reversible tokenization`           | pii-vault.ts + tests                                                                      |
| 3   | `08f91de62` | `feat(compiler): add sensitive display renderer for gathered values`         | sensitive-display.ts + tests + barrel                                                     |
| 4   | `ced89f16b` | `feat(runtime): add output PII redaction filter for agent responses`         | output-pii-filter.ts + tests                                                              |
| 5   | `d1c113e3e` | `feat(runtime): integrate PII vault into session lifecycle`                  | types.ts + barrel + package.json + tests                                                  |
| 6   | `eda23ad67` | `feat(runtime): add transient PII cleanup after gather completes`            | transient-cleanup.ts + tests                                                              |
| 7   | `be669f8ab` | (review fixes)                                                               | pii-vault.ts eviction, regex factory, email mask + tests                                  |
| 8   | `b64b4aa01` | `feat(runtime): wire PII Phase 2 integration points into reasoning executor` | reasoning-executor.ts + types.ts                                                          |
| 9   | `73f1fa0f0` | `docs(shared): update PII Phase 2 spec with integration status`              | spec doc                                                                                  |
| 10  | `72863ed6c` | `feat(runtime,compiler): complete PII Phase 2 gaps and Phase 3`              | 20 files — recognizer registry, encrypted vault, audit, Redis, streaming, per-tool access |
| 11  | `6e8fc816e` | `docs(shared): update PII spec to reflect Phase 2+3 completion`              | spec doc                                                                                  |
| 12  | `9078dd4c0` | `docs(shared): correct PII spec — accurate test counts, line refs`           | spec doc                                                                                  |
| 13  | `49c2871c5` | `feat(runtime,compiler): wire remaining PII gaps — registry, audit, spec`    | pii-detector, pii-guard, output-pii-filter, audit adapter+singleton, reasoning-executor   |
