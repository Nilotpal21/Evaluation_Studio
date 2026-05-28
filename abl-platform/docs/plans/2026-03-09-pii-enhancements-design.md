# PII Enhancements Design — Custom Patterns, Configurable Masking, Consumer Access Control, Studio UI

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Date:** 2026-03-09
**Status:** Draft
**Scope:** Best-in-class PII configuration system for ABL Platform

---

## 1. Current State Summary

### 1.1 Existing Modules

| Module              | File                                                                 | Purpose                                                                                                                                                                                                |
| ------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PII Detector        | `packages/compiler/src/platform/security/pii-detector.ts`            | Regex-based detection for 5 PII types (email, phone, SSN, credit card, IP). Supports selective redaction with exempt types.                                                                            |
| PII Vault           | `packages/compiler/src/platform/security/pii-vault.ts`               | Reversible tokenization (`{{PII:<type>:<uuid>}}`). 4 hardcoded consumers: `llm` (sees tokens), `user` (masked), `logs` (redacted labels), `tools` (original). In-memory store with 10k cap + eviction. |
| Recognizer Registry | `packages/compiler/src/platform/security/pii-recognizer-registry.ts` | Pluggable 3-tier recognizer system (regex/ml/custom). 5 built-in permanent recognizers. Max 50 recognizers with eviction.                                                                              |
| PII Audit Logger    | `packages/compiler/src/platform/security/pii-audit.ts`               | Async fire-and-forget audit logging with buffered batch writes. 90-day default retention with TTL.                                                                                                     |
| Output PII Filter   | `apps/runtime/src/services/execution/output-pii-filter.ts`           | Redacts PII from agent responses before delivery, controlled by `redactOutput` config.                                                                                                                 |
| Audit Log Model     | `packages/database/src/models/pii-audit-log.model.ts`                | MongoDB model with TTL index, tenant/session/token/consumer fields. Consumer enum: `['llm', 'user', 'logs', 'tools']`.                                                                                 |
| Security Config     | `packages/config/src/schemas/security.schema.ts`                     | Zod schema with `piiDetection` and `piiRedaction` booleans. No per-pattern or per-consumer config.                                                                                                     |

### 1.2 Test Coverage

| Test File                                                                  | Tests  | Coverage                                                                                                                            |
| -------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `packages/compiler/src/__tests__/security/pii-detector.test.ts`            | 28     | All 5 PII types, selective redaction, overlap handling, containsPII                                                                 |
| `packages/compiler/src/__tests__/security/pii-vault.test.ts`               | 21     | Tokenize/detokenize, per-consumer rendering, maskValue, eviction, serialization                                                     |
| `packages/compiler/src/__tests__/security/pii-recognizer-registry.test.ts` | 27     | Register/unregister, permanent protection, detectAll, error isolation, capacity eviction, built-in recognizers, singleton lifecycle |
| `apps/runtime/src/__tests__/output-pii-filter.test.ts`                     | 14     | Config flags, per-type redaction, exemptions, logging                                                                               |
| **Total**                                                                  | **90** |                                                                                                                                     |

### 1.3 What This Plan Delivers

This is not a gap-closing exercise against a competitor. The goal is to make ABL's PII system the best in the market by building on the strong foundation already in place. The key improvements:

1. **Custom PII patterns** — Users define project-specific patterns (employee IDs, account numbers, medical record numbers) via Studio UI with live testing, beyond the 5 built-in types.
2. **Configurable masking** — Per-pattern control over `showFirst`, `showLast`, and `maskChar` instead of hardcoded per-type rules.
3. **Configurable consumer access** — Per-pattern render mode per consumer, replacing the hardcoded 4-consumer switch with an extensible system.
4. **Random redaction** — Format-preserving random replacement that prevents LLMs from treating redaction markers as special tokens.
5. **Streaming PII buffer** — Handles partial PII spanning chunk boundaries in streaming responses (already identified as a gap in Phase 2+3 spec).

### 1.4 What This Plan Does NOT Include (Deferred)

These were considered and explicitly deferred to keep scope achievable:

- **ML-based NER detection**: The recognizer registry already has an `ml` tier. Wiring a lightweight NER model (via the NLU sidecar or an embedded ONNX model) would improve recall for context-dependent PII (names, addresses) but requires model packaging, latency budgeting, and a separate evaluation cycle. Deferred to a follow-up plan when the NLU sidecar is production-ready.
- **PII analytics dashboard**: Detection frequency, type distribution, and false-positive rates in ClickHouse. Valuable but requires the analytics pipeline (see `analytics-pipeline-development` skill). Tagged as a future enhancement once the ClickHouse ingest path is stable.
- **Import/export PII configs**: Cross-project pattern sharing. Low urgency — most deployments have <10 custom patterns. Can be added as a CLI export + Studio import when demand exists.

---

## 2. Design — Configurable Masking

This is the simplest, most self-contained change. No new models, no new routes. Pure library enhancement.

### 2.1 Problem

`maskValue()` in `pii-vault.ts` has hardcoded per-type masking. Phone always shows last 4, email always shows first char + domain, SSN is always fully masked. No way to configure these rules per pattern or per deployment.

### 2.2 Type Changes

```typescript
// pii-vault.ts
export interface MaskConfig {
  /** Number of leading characters to show (default: 0) */
  showFirst: number;
  /** Number of trailing characters to show (default: 0) */
  showLast: number;
  /** Character used for masking (default: '*') */
  maskChar: string;
}

/** Default mask configs per PII type (backward compatible with current behavior) */
export const DEFAULT_MASK_CONFIGS: Record<PIIType, MaskConfig> = {
  phone: { showFirst: 0, showLast: 4, maskChar: '*' },
  email: { showFirst: 1, showLast: 0, maskChar: '*' },
  credit_card: { showFirst: 0, showLast: 4, maskChar: '*' },
  ssn: { showFirst: 0, showLast: 0, maskChar: '*' },
  ip_address: { showFirst: 0, showLast: 0, maskChar: '*' },
};
```

### 2.3 New maskValue Signature

```typescript
export function maskValue(value: string, type: PIIType, config?: MaskConfig): string;
```

When `config` is omitted, function delegates to existing type-specific logic (backward compatible). When provided, it uses the generic masking algorithm.

### 2.4 Generic Masking Algorithm

```typescript
function applyMask(value: string, config: MaskConfig): string {
  const { showFirst, showLast, maskChar } = config;
  if (value.length <= showFirst + showLast) {
    return maskChar.repeat(value.length);
  }
  const prefix = value.substring(0, showFirst);
  const suffix = value.substring(value.length - showLast);
  const maskLen = value.length - showFirst - showLast;
  return prefix + maskChar.repeat(maskLen) + suffix;
}
```

**Special case -- email:** When `type === 'email'`, apply mask to the local part only, preserve `@domain`. The config's `showFirst`/`showLast` apply to the local part.

```typescript
function maskEmail(value: string, config: MaskConfig): string {
  const atIndex = value.indexOf('@');
  if (atIndex < 0) return applyMask(value, config);
  const local = value.substring(0, atIndex);
  const domain = value.substring(atIndex);
  return applyMask(local, config) + domain;
}
```

### 2.5 Backward Compatibility

- `maskValue('555-123-4567', 'phone')` -- same output as today (`***-***-4567`)
- `maskValue('555-123-4567', 'phone', { showFirst: 3, showLast: 4, maskChar: '#' })` -- `555####4567`
- Existing `renderForConsumer(text, 'user')` without consumer configs uses type defaults

---

## 3. Design — Random Redaction

### 3.1 Problem

Neither predefined labels (`[REDACTED_EMAIL]`) nor masked values (`u***@example.com`) produce plausible-looking replacements. LLMs detect these as redaction markers and may change behavior (e.g., asking for the "real" value, or generating output that references the redaction). A random replacement that preserves format plausibility (e.g., `jsmith42@mailhost.net`) avoids this.

### 3.2 Type Changes

```typescript
export type RedactionType = 'predefined' | 'masked' | 'random';

export interface RandomRedactionConfig {
  charset: 'alphanumeric' | 'alphabetic' | 'numeric' | 'custom';
  customChars?: string;
  /** Length of replacement. undefined = match original value length */
  length?: number;
}
```

### 3.3 Implementation

```typescript
import { randomBytes } from 'node:crypto';

const CHARSETS: Record<string, string> = {
  alphanumeric: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  alphabetic: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
  numeric: '0123456789',
};

export function generateRandomReplacement(
  originalLength: number,
  config: RandomRedactionConfig,
): string {
  const chars =
    config.charset === 'custom'
      ? (config.customChars ?? CHARSETS.alphanumeric)
      : CHARSETS[config.charset];
  const len = config.length ?? originalLength;
  const bytes = randomBytes(len);
  let result = '';
  for (let i = 0; i < len; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}
```

### 3.4 Session-Scoped Consistency Cache

Same PII token must render to the same random value within a session to avoid confusing multi-turn conversations where the same value appears repeatedly:

```typescript
private readonly randomCache = new Map<string, string>(); // key: `${tokenId}:${consumer}`
```

Cache is cleared on `vault.clear()`. Same `MAX_VAULT_TOKENS` eviction applies.

---

## 4. Design — Configurable Consumer Access

### 4.1 Problem

The 4 hardcoded consumers (`llm`, `user`, `logs`, `tools`) are a closed set. The `renderForConsumer` switch statement must be modified for every new consumer. Real deployments need additional consumers (analytics, supervisor, export, debug) with per-pattern access control.

### 4.2 Approach: Unified Pattern Model

The original design had two separate database models: `pii_patterns` (for custom detection patterns) and `pii_consumer_configs` (for consumer access rules). This is over-engineered. Consumer access rules are always scoped to a pattern -- there is no use case for "consumer access rules without a pattern." Merging them into a single `pii_patterns` collection eliminates a second model, a second CRUD route set, and the need to join the two at runtime.

Built-in patterns (email, phone, SSN, credit card, IP) get consumer access configs via special "override" documents that reference the built-in pattern name but have no `regex` field.

### 4.3 Type Changes

```typescript
// pii-vault.ts — extend consumer type
export type PIIConsumerBuiltin = 'llm' | 'user' | 'logs' | 'tools';
export type PIIConsumer = PIIConsumerBuiltin | string; // allow custom consumer names

export type PIIRenderMode = 'original' | 'masked' | 'redacted' | 'tokenized' | 'random';

export interface PIIConsumerAccessRule {
  consumer: PIIConsumer;
  renderMode: PIIRenderMode;
}

export interface PIIPatternConfig {
  /** Pattern name (e.g. 'email', 'ssn', or custom 'employee_id') */
  patternName: string;
  /** Default render mode for consumers not in the access list */
  defaultRenderMode: PIIRenderMode;
  /** Per-consumer overrides */
  consumerAccess: PIIConsumerAccessRule[];
  /** Mask config (when renderMode is 'masked') */
  maskConfig?: MaskConfig;
  /** Random config (when renderMode is 'random') */
  randomConfig?: RandomRedactionConfig;
}
```

### 4.4 PIIVault Changes

Extend `renderForConsumer` with an optional config parameter:

```typescript
renderForConsumer(
  text: string,
  consumer: PIIConsumer,
  patternConfigs?: PIIPatternConfig[],
): string
```

**Resolution order:**

1. Look up `patternConfigs` for a matching `patternName` + `consumer` -- use that `renderMode`
2. Look up `patternConfigs` for a matching `patternName` with no consumer match -- use `defaultRenderMode`
3. No config found -- fall back to hardcoded switch (backward compatible)

This means existing code calling `renderForConsumer(text, 'logs')` without the third argument works exactly as before.

### 4.5 Backward Compatibility

- `PIIConsumer` widens from a 4-value union to `PIIConsumerBuiltin | string`. All existing code passes one of the 4 builtin values.
- `renderForConsumer` gains an optional third parameter. Omitting it triggers the hardcoded switch.
- The audit log model's `consumer` field widens from `enum` to `String` so custom consumer names can be recorded.

---

## 5. Design — Custom PII Patterns + Studio UI

### 5.1 Database Model — Unified PiiPattern Collection

A single model handles both custom detection patterns and consumer access overrides for built-in patterns.

```typescript
// packages/database/src/models/pii-pattern.model.ts
export interface IPIIPattern {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  description?: string;
  /** PII type for categorization and default masking */
  piiType: string;
  /**
   * Regex pattern string. Required for custom patterns.
   * Null for built-in override records (email, phone, ssn, credit_card, ip_address).
   */
  regex?: string;
  /** Optional validator expression (evaluated in restricted sandbox) */
  validate?: string;
  /** Redaction configuration */
  redaction: {
    type: 'predefined' | 'masked' | 'random';
    label?: string;
    maskConfig?: { showFirst: number; showLast: number; maskChar: string };
    randomConfig?: {
      charset: 'alphanumeric' | 'alphabetic' | 'numeric' | 'custom';
      customChars?: string;
      length?: number;
    };
  };
  /** Per-consumer access control */
  consumerAccess: Array<{ consumer: string; renderMode: string }>;
  defaultRenderMode: string;
  enabled: boolean;
  /** True for records overriding built-in patterns */
  builtinOverride: boolean;
  _v: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}
```

**Indexes:**

- `{ tenantId: 1, projectId: 1 }` (compound for listing)
- `{ tenantId: 1, projectId: 1, name: 1 }` (unique -- no duplicate names per project)

### 5.2 Pattern Type System

The `PIIType` union (`email | phone | ssn | credit_card | ip_address`) is currently closed. Custom patterns introduce arbitrary type strings. Rather than widening `PIIType` to `string` everywhere (losing type safety), custom patterns use a separate `piiType: string` field on the DB model while the vault token format continues using the string as-is in `{{PII:<piiType>:<uuid>}}`. The detector and vault already pass type as `string` internally -- only the type alias is restrictive.

Add to `pii-detector.ts`:

```typescript
/** Extended PII type that includes custom pattern types */
export type PIITypeExtended = PIIType | string;
```

The recognizer registry's `PIIRecognizer` interface already uses `PIIType[]` for `supportedTypes`. For custom recognizers, cast the custom type string. This keeps backward compatibility for all built-in code paths while allowing extension.

### 5.3 Security — Regex and Validator Sandboxing

**Regex validation at save time:**

- Compile regex in a try/catch to reject invalid patterns
- Max regex length: 2048 chars
- Reject regexes with known catastrophic backtracking patterns via a simple heuristic: reject patterns containing `(.+)+`, `(.*)*`, or nested quantifiers on capturing groups
- Enforce a compilation timeout: wrap `new RegExp()` in a `vm.runInNewContext` with 100ms timeout to catch regex DoS at save time

**Validator sandboxing:**

- Validator expressions evaluated via `vm.runInNewContext` with:
  - 50ms timeout
  - Empty sandbox: no `require`, `process`, `fs`, `globalThis`, `fetch`
  - Only `value` (the matched string) and `RegExp` available in scope
- Max validator length: 1024 chars

### 5.4 Page Location in Studio

New settings sub-page: **Settings > PII Protection**

Following the existing `ProjectSettingsPage.tsx` pattern:

```typescript
{active === 'pii-protection' && <PIIProtectionTab />}
```

Navigation sidebar entry: `settings-pii-protection`.

### 5.5 UI Components

#### 5.5.1 PIIProtectionTab

Location: `apps/studio/src/components/settings/PIIProtectionTab.tsx`

Layout follows `ConfigVariablesTab` pattern:

- **Global toggle section** at top: PII Detection (on/off), PII Output Redaction (on/off). These map to the existing `piiDetection` and `piiRedaction` booleans in `SecurityConfig`.
- **Built-in patterns section**: Read-only cards for the 5 built-in types. Each has a "Configure" button that opens a dialog for consumer access and masking overrides only (no regex editing).
- **Custom patterns section**: Header with "Add Pattern" button, then a card list.
- **Empty state**: "No custom patterns configured. The 5 built-in patterns are always active."

Each pattern card shows:

- **Name** (bold) + **Type** badge
- **Regex** preview (monospace, truncated) -- hidden for built-in overrides
- **Redaction type** indicator
- **Enabled/Disabled** toggle
- **Actions:** Edit (pencil), Test (beaker), Delete (trash with confirm) -- delete hidden for built-in overrides

#### 5.5.2 PIIPatternFormDialog

Location: `apps/studio/src/components/settings/PIIPatternFormDialog.tsx`

Modal dialog (follows `GuardrailPolicyForm` pattern) with sections:

1. **Basics**: Name, description, enabled toggle
2. **Detection** (hidden for built-in overrides): Regex pattern (monospace input), PII type selector, optional validator
3. **Redaction**: Type radio (Predefined | Masked | Random) with type-specific config
4. **Consumer Access**: Default render mode selector + per-consumer override table with add/remove rows
5. **Live Test** (inline in dialog): Text input, "Test" button, results with highlighted matches and per-consumer rendering preview

The live test section runs client-side regex matching for instant feedback (no API call needed for the regex test itself). The full test (with validator) calls the backend test endpoint.

#### 5.5.3 No Separate PIIPatternTestPanel

The original design had a standalone `PIIPatternTestPanel` component accessible from the pattern card. This is unnecessary -- the inline test section in the form dialog covers the same functionality. The card's "Test" button simply opens the form dialog scrolled to the test section. One fewer component to build and maintain.

### 5.6 API Routes

Studio proxies to Runtime for PII pattern CRUD:

| Studio Route                                                              | Runtime Route                                             | Method | Purpose        |
| ------------------------------------------------------------------------- | --------------------------------------------------------- | ------ | -------------- |
| `apps/studio/src/app/api/projects/[id]/pii-patterns/route.ts`             | `GET /api/projects/:projectId/pii-patterns`               | GET    | List patterns  |
| `apps/studio/src/app/api/projects/[id]/pii-patterns/route.ts`             | `POST /api/projects/:projectId/pii-patterns`              | POST   | Create pattern |
| `apps/studio/src/app/api/projects/[id]/pii-patterns/[patternId]/route.ts` | `GET /api/projects/:projectId/pii-patterns/:patternId`    | GET    | Get pattern    |
| `apps/studio/src/app/api/projects/[id]/pii-patterns/[patternId]/route.ts` | `PUT /api/projects/:projectId/pii-patterns/:patternId`    | PUT    | Update pattern |
| `apps/studio/src/app/api/projects/[id]/pii-patterns/[patternId]/route.ts` | `DELETE /api/projects/:projectId/pii-patterns/:patternId` | DELETE | Delete pattern |
| `apps/studio/src/app/api/projects/[id]/pii-patterns/test/route.ts`        | `POST /api/projects/:projectId/pii-patterns/test`         | POST   | Test detection |

### 5.7 Runtime Route + Service + Repo

New route file: `apps/runtime/src/routes/pii-patterns.ts`

All routes scoped to `tenantId` + `projectId` via `requireProjectPermission`. Follows the established Router + Service + Repo pattern from Sprint 3 API verticalization.

```
apps/runtime/src/routes/pii-patterns.ts        — route handlers
apps/runtime/src/services/pii/pattern-service.ts — validation, business logic
apps/runtime/src/repos/pii-pattern-repo.ts       — tenant-scoped DB queries
```

Test endpoint:

```typescript
interface PIIPatternTestRequest {
  regex: string;
  text: string;
  validate?: string;
  redaction?: { type: string; maskConfig?: MaskConfig; randomConfig?: RandomRedactionConfig };
  consumerAccess?: Array<{ consumer: string; renderMode: string }>;
  defaultRenderMode?: string;
}

interface PIIPatternTestResponse {
  success: boolean;
  data: {
    detections: Array<{ type: string; start: number; end: number; value: string }>;
    consumerPreviews: Record<string, string>;
  };
}
```

### 5.8 Pattern Loading at Runtime

When the runtime initializes a session, load custom PII patterns from the database and register them in the session's recognizer registry:

```typescript
async function loadProjectPIIPatterns(
  tenantId: string,
  projectId: string,
  registry: PIIRecognizerRegistry,
): Promise<PIIPatternConfig[]> {
  const patterns = await PIIPatternModel.find({ tenantId, projectId, enabled: true });

  const configs: PIIPatternConfig[] = [];

  for (const pattern of patterns) {
    // Register custom recognizers (skip built-in overrides — they only configure rendering)
    if (pattern.regex && !pattern.builtinOverride) {
      const recognizer = new RegexPIIRecognizer(
        `custom-${pattern.name}`,
        [pattern.piiType as PIIType],
        new RegExp(pattern.regex, 'g'),
        pattern.piiType as PIIType,
        pattern.validate ? buildSandboxedValidator(pattern.validate) : undefined,
      );
      registry.register(recognizer);
    }

    // Collect consumer access configs for vault rendering
    configs.push({
      patternName: pattern.piiType,
      defaultRenderMode: pattern.defaultRenderMode as PIIRenderMode,
      consumerAccess: pattern.consumerAccess.map((ca) => ({
        consumer: ca.consumer,
        renderMode: ca.renderMode as PIIRenderMode,
      })),
      maskConfig: pattern.redaction.maskConfig,
      randomConfig: pattern.redaction.randomConfig,
    });
  }

  return configs;
}
```

The returned `PIIPatternConfig[]` is stored on the session and passed to `vault.renderForConsumer()` calls.

---

## 6. Design — Streaming PII Buffer

### 6.1 Problem

Streaming responses deliver text in chunks. A phone number like `555-123-4567` might arrive as `...call 555-12` | `3-4567 for...`. Neither chunk contains the full PII, so per-chunk detection misses it. The Phase 2+3 spec identified this gap but did not include an implementation.

### 6.2 Approach: Trailing Buffer

A simple trailing buffer that holds the last N characters from the previous chunk and prepends them to the current chunk for detection:

```typescript
export class StreamingPIIBuffer {
  /** Max PII token length we need to catch across boundaries */
  private static readonly BUFFER_SIZE = 40; // longest expected PII: intl phone ~20 chars, CC ~19
  private buffer = '';

  /**
   * Process a streaming chunk. Returns the safe-to-emit prefix
   * and updates the internal buffer with the trailing portion.
   */
  processChunk(
    chunk: string,
    detector: (text: string) => PIIDetectionResult,
  ): {
    safeText: string;
    detections: PIIDetection[];
  } {
    const combined = this.buffer + chunk;

    // Detect PII in the combined text
    const result = detector(combined);

    if (!result.hasPII) {
      // No PII — emit everything except the trailing buffer portion
      const safeLen = Math.max(0, combined.length - StreamingPIIBuffer.BUFFER_SIZE);
      this.buffer = combined.substring(safeLen);
      return { safeText: combined.substring(0, safeLen), detections: [] };
    }

    // PII found — emit the redacted version up to the buffer boundary
    const safeLen = Math.max(0, combined.length - StreamingPIIBuffer.BUFFER_SIZE);
    this.buffer = combined.substring(safeLen);
    return {
      safeText: result.redacted.substring(0, safeLen),
      detections: result.detections.filter((d) => d.end <= safeLen),
    };
  }

  /** Flush remaining buffer (call at stream end) */
  flush(detector: (text: string) => PIIDetectionResult): {
    safeText: string;
    detections: PIIDetection[];
  } {
    const result = detector(this.buffer);
    const text = result.hasPII ? result.redacted : this.buffer;
    const detections = result.detections;
    this.buffer = '';
    return { safeText: text, detections };
  }
}
```

### 6.3 Why Not More Complex Approaches

- **Regex lookahead per chunk**: Fragile, requires pattern-specific logic for each PII type.
- **Full text reassembly**: Defeats the purpose of streaming (memory, latency).
- **ML-based boundary detection**: Overkill for this problem; trailing buffer solves it with ~40 chars of overhead.

The 40-character buffer adds negligible latency (one chunk's worth of delay for the trailing portion) and catches all 5 built-in PII types plus most custom patterns.

### 6.4 Integration Point

The `StreamingPIIBuffer` is instantiated per streaming response in the reasoning executor. It wraps the existing `filterOutputPII` call:

```typescript
// In reasoning-executor streaming path
const piiBuffer = new StreamingPIIBuffer();

// For each chunk:
const { safeText, detections } = piiBuffer.processChunk(chunk, (text) =>
  detectPIISelective(text, exemptTypes, registry),
);
// Emit safeText to client

// At stream end:
const { safeText: finalText } = piiBuffer.flush((text) =>
  detectPIISelective(text, exemptTypes, registry),
);
// Emit finalText to client
```

---

## 7. Test Plan

### 7.1 Configurable Masking (~12 tests)

| Test                                              | Description                                  |
| ------------------------------------------------- | -------------------------------------------- |
| `maskValue` with default config (backward compat) | Each PII type produces same output as before |
| `maskValue` with custom showFirst                 | Shows N leading chars                        |
| `maskValue` with custom showLast                  | Shows N trailing chars                       |
| `maskValue` with custom maskChar                  | Uses specified character                     |
| `maskValue` with showFirst + showLast > length    | Full mask (edge case)                        |
| Email masking preserves domain                    | `@domain.com` always visible                 |
| Email masking with custom config                  | showFirst/showLast apply to local part       |
| `applyMask` with empty string                     | Returns empty string                         |

### 7.2 Random Redaction (~10 tests)

| Test                                             | Description                                                    |
| ------------------------------------------------ | -------------------------------------------------------------- |
| `generateRandomReplacement` with each charset    | Returns correct length, valid chars for each                   |
| `generateRandomReplacement` with custom charset  | Uses only specified chars                                      |
| `generateRandomReplacement` with explicit length | Overrides original length                                      |
| `generateRandomReplacement` match-original       | Output length matches input                                    |
| Random render mode in `renderForConsumer`        | Returns random string for random-configured patterns           |
| Random cache consistency                         | Same token + consumer returns same random value within session |
| Random cache cleared on vault clear              | New values generated after clear                               |

### 7.3 Consumer Access Control (~15 tests)

| Test                                                 | Description                                              |
| ---------------------------------------------------- | -------------------------------------------------------- |
| `renderForConsumer` with pattern config              | Renders according to per-pattern consumer access rules   |
| `renderForConsumer` with default render mode         | Falls back to `defaultRenderMode` for unlisted consumers |
| `renderForConsumer` without config (backward compat) | Uses hardcoded switch, same as before                    |
| Custom consumer name                                 | Accepts arbitrary string consumer names                  |
| Multiple patterns with different configs             | Each pattern resolves its own config                     |
| All 5 render modes                                   | original, masked, redacted, tokenized, random each work  |
| Audit logging with custom consumers                  | Audit entries record custom consumer names               |

### 7.4 PII Patterns CRUD + UI (~30 tests)

| Test                            | Description                                                   |
| ------------------------------- | ------------------------------------------------------------- |
| Pattern list rendering          | Renders pattern cards with correct badges and toggles         |
| Create pattern form validation  | Validates required fields, regex syntax, saves via API        |
| Edit pattern                    | Pre-fills form, saves updates                                 |
| Delete pattern with confirm     | Confirm dialog, deletes via API                               |
| Enable/disable toggle           | Updates pattern `enabled` field                               |
| Inline test in form dialog      | Sends test request, displays detections and consumer previews |
| Empty state                     | Shows message when no custom patterns exist                   |
| Built-in override cards         | Shows built-in patterns as read-only with configure button    |
| Runtime CRUD endpoints          | Full CRUD lifecycle with tenant/project isolation             |
| Pattern loading at session init | Loads enabled custom patterns into recognizer registry        |
| Regex validation at save time   | Rejects invalid regex, catastrophic backtracking patterns     |
| Duplicate name prevention       | Returns 409 for duplicate pattern name in same project        |
| Validator sandbox security      | Validator cannot access process, require, fs                  |
| Cross-tenant isolation          | Project A patterns invisible to project B (returns 404)       |

### 7.5 Streaming PII Buffer (~10 tests)

| Test                                 | Description                                |
| ------------------------------------ | ------------------------------------------ |
| Phone number split across chunks     | Detected and redacted correctly            |
| Email split across chunks            | Detected and redacted correctly            |
| No PII in chunks                     | Text passes through with buffer delay only |
| PII entirely within one chunk        | Detected normally                          |
| Multiple PII across chunk boundaries | All detected                               |
| Flush at stream end                  | Remaining buffer processed                 |
| Empty chunks                         | Handled gracefully                         |
| Buffer does not grow unbounded       | Fixed 40-char window                       |

### 7.6 Integration (~5 tests)

| Test                                                                | Description                                 |
| ------------------------------------------------------------------- | ------------------------------------------- |
| Full pipeline: custom pattern + tokenization + per-consumer render  | End-to-end with custom pattern              |
| Session lifecycle: load from DB, process input, render output       | Patterns loaded from DB and used at runtime |
| Backward compatibility: no custom configs = same behavior as before | Regression guard                            |

### 7.7 Total Test Estimate

| Feature              | New Tests |
| -------------------- | --------- |
| Configurable Masking | ~12       |
| Random Redaction     | ~10       |
| Consumer Access      | ~15       |
| PII Patterns + UI    | ~30       |
| Streaming PII Buffer | ~10       |
| Integration          | ~5        |
| **Total**            | **~82**   |

---

## 8. Implementation Plan

### Phase 1: Core Engine Changes (Tasks 1-4)

Pure library changes in `packages/compiler` with no DB or UI dependencies.

#### Task 1: Configurable Masking

**TDD: Write tests first, then implement.**

Files:

- Modify: `packages/compiler/src/platform/security/pii-vault.ts`
- Test: `packages/compiler/src/__tests__/security/pii-vault.test.ts` -- add ~12 masking tests

Steps:

1. Add `MaskConfig` interface and `DEFAULT_MASK_CONFIGS` constant
2. Implement `applyMask()` and `maskEmail()` private functions
3. Update `maskValue()` to accept optional `MaskConfig` parameter
4. Existing maskValue tests must still pass (backward compat)
5. Write new tests for custom configs and edge cases

#### Task 2: Random Redaction

**TDD: Write tests first, then implement.**

Files:

- Modify: `packages/compiler/src/platform/security/pii-vault.ts`
- Test: `packages/compiler/src/__tests__/security/pii-vault.test.ts` -- add ~10 random tests

Steps:

1. Add `RedactionType`, `RandomRedactionConfig` types
2. Implement `generateRandomReplacement()`
3. Add `randomCache` map to PIIVault with eviction
4. Write tests for all charset options, length modes, cache consistency

#### Task 3: Configurable Consumer Access

**TDD: Write tests first, then implement.**

Files:

- Modify: `packages/compiler/src/platform/security/pii-vault.ts`
- Test: `packages/compiler/src/__tests__/security/pii-vault.test.ts` -- add ~15 consumer tests

Depends on: Task 1, Task 2

Steps:

1. Add `PIIRenderMode`, `PIIConsumerAccessRule`, `PIIPatternConfig` types
2. Widen `PIIConsumer` type to accept arbitrary strings
3. Add `resolveRenderMode()` helper with 3-level resolution
4. Update `renderForConsumer` with optional third parameter
5. Write tests for all render modes, resolution fallbacks, backward compatibility

#### Task 4: Streaming PII Buffer

**TDD: Write tests first, then implement.**

Files:

- Create: `packages/compiler/src/platform/security/streaming-pii-buffer.ts`
- Test: `packages/compiler/src/__tests__/security/streaming-pii-buffer.test.ts` -- ~10 tests

Steps:

1. Implement `StreamingPIIBuffer` class with `processChunk()` and `flush()`
2. Write tests for split PII, no PII, flush, empty chunks
3. Export from `packages/compiler/src/platform/security/index.ts`

### Phase 2: Database + Runtime API (Tasks 5-7)

#### Task 5: Database Model + Audit Log Update

Files:

- Create: `packages/database/src/models/pii-pattern.model.ts`
- Modify: `packages/database/src/models/pii-audit-log.model.ts` -- widen consumer enum to String, add renderMode field
- Modify: `packages/database/src/index.ts` -- export new model

Steps:

1. Create PiiPattern model with indexes and validation
2. Update audit log: consumer field from enum to String, add `renderMode` field
3. Register model in ModelRegistry, export from package index

#### Task 6: Pattern CRUD Routes + Service + Repo

Files:

- Create: `apps/runtime/src/routes/pii-patterns.ts`
- Create: `apps/runtime/src/services/pii/pattern-service.ts`
- Create: `apps/runtime/src/repos/pii-pattern-repo.ts`
- Test: `apps/runtime/src/__tests__/pii-patterns-routes.test.ts` -- ~12 tests

Depends on: Task 5

Steps:

1. Create repo with tenant-scoped queries (`find({tenantId, projectId})`, never `findById`)
2. Create service: regex compilation validation, catastrophic backtracking check, name uniqueness, length limits
3. Create route with `requireProjectPermission` middleware
4. Implement test endpoint: compile regex, run detection, generate consumer previews
5. Register route in runtime app
6. Write CRUD + isolation + validation tests

#### Task 7: Pattern Loading Service

Files:

- Create: `apps/runtime/src/services/pii/pattern-loader.ts`
- Test: `apps/runtime/src/__tests__/pii-pattern-loader.test.ts` -- ~8 tests

Depends on: Task 5, Task 3

Steps:

1. Implement `loadProjectPIIPatterns()` function
2. Implement `buildSandboxedValidator()` with `vm.runInNewContext`
3. Wire into session initialization
4. Return `PIIPatternConfig[]` for vault rendering
5. Write tests for loading, validation, error handling, empty project

### Phase 3: Studio UI (Tasks 8-10)

#### Task 8: Studio API Proxy Routes

Files:

- Create: `apps/studio/src/app/api/projects/[id]/pii-patterns/route.ts`
- Create: `apps/studio/src/app/api/projects/[id]/pii-patterns/[patternId]/route.ts`
- Create: `apps/studio/src/app/api/projects/[id]/pii-patterns/test/route.ts`

Depends on: Task 6

Steps:

1. Create list/create proxy route
2. Create single-pattern proxy route (GET, PUT, DELETE)
3. Create test proxy route
4. Follow existing guardrail proxy pattern for auth forwarding

#### Task 9: PIIProtectionTab Component

Files:

- Create: `apps/studio/src/components/settings/PIIProtectionTab.tsx`
- Modify: `apps/studio/src/components/settings/ProjectSettingsPage.tsx` -- add tab

Depends on: Task 8

Steps:

1. Create component with SWR data fetching (follows `ConfigVariablesTab` pattern)
2. Add global toggle section for piiDetection/piiRedaction
3. Add built-in pattern cards (read-only, configure button for overrides)
4. Add custom pattern card list with create/edit/delete/toggle
5. Add empty state
6. Wire into ProjectSettingsPage, add navigation sidebar entry

#### Task 10: PIIPatternFormDialog Component

Files:

- Create: `apps/studio/src/components/settings/PIIPatternFormDialog.tsx`

Depends on: Task 9

Steps:

1. Create form dialog with 5 sections (basics, detection, redaction, consumer access, live test)
2. Implement client-side regex validation and preview
3. Wire create and edit modes (edit pre-fills from existing pattern)
4. Add consumer access table with add/remove rows
5. Add inline test section with regex highlighting and per-consumer preview

### Phase 4: Integration + Wiring (Tasks 11-12)

#### Task 11: Output Filter + Streaming Wiring

Files:

- Modify: `apps/runtime/src/services/execution/output-pii-filter.ts` -- accept consumer configs
- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts` -- wire StreamingPIIBuffer
- Test: add ~5 tests to `output-pii-filter.test.ts`

Depends on: Task 3, Task 4, Task 7

Steps:

1. Update output filter to accept and pass `PIIPatternConfig[]` to vault rendering
2. Wire `StreamingPIIBuffer` into reasoning executor streaming path
3. Write tests for configurable output filtering and streaming integration

#### Task 12: Integration Tests

Files:

- Modify: `apps/runtime/src/__tests__/pii-integration.test.ts` -- add ~5 integration tests

Depends on: all previous tasks

Steps:

1. Full pipeline test: custom pattern + tokenization + per-consumer rendering
2. Session lifecycle: load from DB, process, render
3. Backward compat: no custom configs = same behavior
4. Streaming: PII split across chunks detected correctly

### Dependency Graph

```
Task 1 (Masking) ─────┐
Task 2 (Random) ──────├─ Task 3 (Consumer Access) ─┬─ Task 11 (Output Filter + Streaming Wiring)
Task 4 (Streaming) ───┘                             │
                                                     │
Task 5 (DB Models) ───┬─ Task 6 (CRUD Routes) ──── Task 8 (Studio Proxy)
                       │                              Task 9 (PIIProtectionTab)
                       └─ Task 7 (Pattern Loader) ─┘  Task 10 (PatternFormDialog)

All ──────────────────────────────────────────────── Task 12 (Integration)
```

### Task Summary

| Task      | Description                    | New/Modified Files    | Est. Tests |
| --------- | ------------------------------ | --------------------- | ---------- |
| 1         | Configurable Masking           | 1 modified, 1 test    | 12         |
| 2         | Random Redaction               | 1 modified, 1 test    | 10         |
| 3         | Configurable Consumer Access   | 1 modified, 1 test    | 15         |
| 4         | Streaming PII Buffer           | 1 created, 1 test     | 10         |
| 5         | Database Models                | 1 created, 2 modified | 0          |
| 6         | PII Pattern CRUD Routes        | 3 created, 1 test     | 12         |
| 7         | Pattern Loading Service        | 1 created, 1 test     | 8          |
| 8         | Studio API Proxy Routes        | 3 created             | 0          |
| 9         | PIIProtectionTab Component     | 1 created, 1 modified | 5          |
| 10        | PIIPatternFormDialog Component | 1 created             | 5          |
| 11        | Output Filter + Streaming Wire | 2 modified, 1 test    | 5          |
| 12        | Integration Tests              | 1 modified            | 5          |
| **Total** |                                | **~20 files**         | **~87**    |

---

## 9. Simplifications vs. Original Design

1. **Eliminated `pii_consumer_configs` collection.** Consumer access rules are embedded in the unified `pii_patterns` model. One fewer DB collection, one fewer CRUD route set (Task 7 in the original), one fewer service + repo pair. Saves ~3 files and ~8 tests.

2. **Eliminated standalone `PIIPatternTestPanel`.** The inline test section in the form dialog covers the same functionality. One fewer component.

3. **Added `builtinOverride` flag** instead of separate consumer config collection. Built-in pattern overrides are just `pii_patterns` documents with `builtinOverride: true` and no `regex` field.

4. **Client-side regex testing** in the form dialog for instant feedback. The backend test endpoint is only needed for validator testing (which requires the sandbox).

5. **Added Streaming PII Buffer** as a new feature (not in original). This is a real gap identified in Phase 2+3 spec. Simple 40-char trailing buffer, ~80 lines of code, high impact.

6. **Deferred ML-based NER, analytics dashboard, import/export** explicitly with rationale rather than silently ignoring them.
