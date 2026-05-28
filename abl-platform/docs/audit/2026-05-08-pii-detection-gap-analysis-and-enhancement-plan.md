# PII Detection System — Gap Analysis & Enhancement Plan

**Date:** 2026-05-08
**Scope:** Full PII detection subsystem — detection engine, recognizer registry, vault, runtime pipeline, guardrails, infrastructure
**Status:** BETA (per `docs/specs/pii-detection.hld.md`)

---

## Executive Summary

The ABL platform has a **mature PII lifecycle system** (vault, consumer rendering, audit, GDPR cascades, streaming) that exceeds what any off-the-shelf library provides. However, the **detection layer** — the foundation everything else rests on — has significant gaps: only 5 entity types, no confidence scoring, no NER/ML integration, US-only patterns, and architectural inconsistencies (registry bypass, regex duplication). These gaps limit the platform's value for international deployments and compliance-sensitive customers.

This report audits those gaps, then proposes a **tiered enhancement plan** (Option D: GLiNER sidecar + ported Presidio recognizers) with user-configurable depth, latency budgets, and infrastructure requirements.

**Key numbers:**

- 5 entity types detected today vs 65+ in Presidio
- 0 confidence scoring (binary detect/no-detect)
- 0 NER/ML recognizers implemented (the `ml` tier is defined but empty)
- 3 code paths bypass the recognizer registry
- 2 regex patterns diverge between `pii-detector.ts` and `pii-recognizer-registry.ts`
- 0 performance tests or latency budgets exist

---

## Part 1: Current System Strengths

Before cataloguing gaps, it's important to document what the platform does **better** than Presidio or any off-the-shelf alternative. These represent substantial engineering investment and should not be disrupted by enhancements.

| Capability                    | Implementation                                                                                                                | Presidio Equivalent                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Reversible tokenization vault | `pii-vault.ts` — `{{PII:TYPE:uuid}}` tokens, 10K cap, oldest-first eviction                                                   | None                                   |
| Per-consumer rendering        | 5 modes (original/masked/redacted/tokenized/random) per PII type per consumer (LLM/user/logs/tools/admin)                     | None                                   |
| Streaming PII detection       | `streaming-pii-buffer.ts` — 320-char trailing buffer handles PII split across chunks                                          | None                                   |
| Encrypted durable storage     | `encrypted-vault.ts` — AES-256-GCM with tenant-scoped keys, MongoDB persistence                                               | None                                   |
| Async buffered audit logging  | `pii-audit.ts` — 100-entry buffer, 5s flush, 90-day TTL, fire-and-forget                                                      | None                                   |
| GDPR cascade delete           | Tenant → project → session cascade for PII collections + deletion-request tracking with SLA deadlines                         | None                                   |
| Context-aware exemption       | Gather-field exemption in `pii-guard.ts` — suppresses detection for PII types matching fields being collected                 | None                                   |
| Custom pattern CRUD API       | REST API at `/api/projects/:projectId/pii-patterns` with ReDoS protection, sandbox validators, epoch-based cache invalidation | Recognizers added via Python code only |
| Deep output protection        | Separate delivery (masked) and history (tokenized) versions of every message via `session-output-protection.ts`               | None                                   |
| Multi-layer trace scrubbing   | Pino field redaction + secret pattern scrubbing + PII redaction + voice trace scrubbing                                       | Not in scope                           |
| DSL-level field sensitivity   | IR schema supports per-field `sensitive`, `sensitive_display`, `mask_config`, `pii_type`, `transient`                         | Not applicable                         |

**Conclusion:** The platform's PII **lifecycle** is production-grade. The **detection** layer is where investment is needed.

---

## Part 2: Gap Analysis

### GAP-1: Limited Entity Type Coverage (CRITICAL)

**Current state:** 5 builtin types — email, phone, SSN, credit card, IPv4.

**What's missing (Presidio covers all of these):**

| Category               | Missing Entity Types                                                                             | Impact                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| **Identity documents** | Passport numbers (US, UK, IN, etc.), driver's license, national IDs (Aadhaar, NRIC, PESEL, etc.) | High — compliance audits for regulated industries |
| **Financial**          | IBAN, bank account numbers, routing numbers (ABA), tax IDs (ITIN, TIN, PAN, GSTIN, VAT)          | High — financial services customers               |
| **Personal**           | Person names, physical addresses, dates of birth, age                                            | Critical — the most common PII in conversation    |
| **Medical**            | Medical record numbers, Medicare/NHS numbers, medical conditions, medications                    | Critical — HIPAA compliance                       |
| **Network**            | IPv6, MAC addresses, URLs with credentials                                                       | Medium                                            |
| **Crypto**             | Bitcoin/Ethereum wallet addresses                                                                | Low                                               |
| **Location**           | Geographic coordinates, named locations                                                          | Medium                                            |

**Presidio provides 65+ entity types** with country-specific recognizers for 15+ countries (US, UK, Germany, India, Australia, Singapore, Korea, Poland, Finland, Nigeria, Thailand, Sweden, Turkey, Canada, Italy, Spain).

**Risk:** Customers in regulated industries (healthcare, financial services) or non-US markets have insufficient PII coverage. A customer conversation containing "My name is John Smith, born March 15 1990, IBAN GB82 WEST 1234 5698 7654 32" would detect **zero** PII entities.

---

### GAP-2: No Confidence Scoring (HIGH)

**Current state:** Detection is binary — a pattern either matches or it doesn't. The `PIIDetection` interface has no `confidence` field:

```typescript
// pii-detector.ts:21-30
export interface PIIDetection {
  type: PIIType;
  start: number;
  end: number;
  value: string; // safe preview, never raw
}
```

**What's missing:**

- No ability to tune precision/recall tradeoff (e.g., "only redact PII with >0.8 confidence")
- No way to rank competing detections when spans overlap (currently uses positional ordering)
- No way to boost confidence using context words (Presidio's `LemmaContextAwareEnhancer` boosts scores by 0.35 when context words like "my SSN is" appear nearby)
- No threshold filtering — everything detected is treated equally

**Impact:** Higher false positive rate on ambiguous patterns. A 5-digit number could be a zip code, a score, or random digits — without context scoring, there's no way to differentiate.

**Propagation scope if added:** Adding `confidence?: number` to `PIIDetection` touches ~8 production files + ~10 test files. Manageable as a backward-compatible additive change.

---

### GAP-3: No NER/ML Integration (HIGH)

**Current state:** The recognizer registry defines an `ml` tier with priority 1 (between `custom` at 0 and `regex` at 2), but **zero implementations exist**. The `PIIRecognizer` interface is the only integration point:

```typescript
// pii-recognizer-registry.ts:21
export interface PIIRecognizer {
  name: string;
  supportedTypes: PIIType[];
  tier: RecognizerTier; // 'regex' | 'ml' | 'custom'
  detect(text: string): PIIDetection[];
}
```

**Blockers for ML integration:**

1. `detect()` is **synchronous** — ML models require async inference (HTTP call to sidecar or ONNX runtime). Making it async cascades to 15-20 files, 30+ call sites.
2. No `confidence` field on detections (see GAP-2).
3. No `language` parameter for multilingual models.
4. No model lifecycle management (load/unload/warm-up).
5. No batch detection API for throughput optimization.

**What NER would unlock:** Detection of person names, physical addresses, organization names, dates of birth, medical terms — entity types that regex fundamentally cannot detect because they have no fixed pattern.

---

### GAP-4: US-Only Pattern Coverage (HIGH)

**Phone number regex** (`pii-detector.ts:77`):

```regex
/(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}\b/g
```

- Only matches US format with optional `+1` prefix
- Misses: E.164 international (`+44 20 7946 0958`), European (`030 12345678`), Asian (`03-1234-5678`), `00`-prefix dialing

**SSN regex** (`pii-detector.ts:62`):

```regex
/\b(\d{3}-\d{2}-\d{4})\b/g
```

- Comment at line 61 says "123-45-6789 or 123456789" but **only the dashed form is implemented**
- Misses: undashed `123456789`, space-separated `123 45 6789`

**Credit card regex divergence:**

- `pii-detector.ts:69`: `/\b\d(?:[\s-]?\d){12,18}\b/g` — matches 13-19 digits
- `pii-recognizer-registry.ts:215`: `/\b(\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4})\b/g` — matches only 16 digits in 4-4-4-4 grouping
- Registry version misses: 13-digit Visa, 15-digit Amex (4-6-5), 19-digit Maestro

**IPv6:** Not detected at all.

---

### GAP-5: Recognizer Registry Bypass (MEDIUM)

Three code paths can bypass the recognizer registry, falling back to hardcoded patterns in `pii-detector.ts`. This means custom patterns registered via the API are only effective in the NLU guard path, not across all detection surfaces.

| Bypass Location            | File                  | Line   | Risk                                                                                        |
| -------------------------- | --------------------- | ------ | ------------------------------------------------------------------------------------------- |
| Trace scrubbing            | `trace-scrubber.ts`   | 136    | Custom patterns not applied to trace events if `options.piiRecognizerRegistry` is undefined |
| CEL expressions            | `cel-functions.ts`    | 18     | `abl.has_pii()`, `abl.redact_pii()` use hardcoded patterns if CEL context lacks registry    |
| Guardrail action executors | `action-executors.ts` | 23, 59 | Redact/fix actions use hardcoded patterns if caller doesn't pass registry                   |

**Root cause:** `detectPII()`, `redactPII()`, `containsPII()` all accept an **optional** `registry` parameter. When omitted, they fall through to `detectWithLocalPatterns()` — the hardcoded 5-regex path.

**Compounding issue:** The 5 regex patterns are defined **identically in both files** (`pii-detector.ts` and `pii-recognizer-registry.ts`) — a DRY violation. If one is updated without the other, they drift. The feature spec at `docs/features/pii-detection.md:207` already flags this.

---

### GAP-6: Zero Performance Baselines (MEDIUM)

- **No latency budgets** — no `MAX_PII_LATENCY`, timeout, or circuit breaker on detection
- **No performance tests** — no benchmark files exist anywhere
- **Single measurement point** — only `builtin-pii.ts` records `performance.now()` latency; the NLU guard, output filter, vault tokenization, and streaming buffer have no timing
- **No ReDoS timeout enforcement** — custom pattern validators have a 50ms soft timeout (warning logged) but no hard kill. A slow regex blocks the event loop.

**Risk:** Adding ML-based detection (10-500ms per call) without latency budgets could degrade user-facing response times with no alerting.

---

### GAP-7: Async Pipeline Readiness (MEDIUM)

The entire PII detection pipeline is synchronous. Making `PIIRecognizer.detect()` async would cascade through:

| Scope                      | Files Affected                                                      | Complexity                  |
| -------------------------- | ------------------------------------------------------------------- | --------------------------- |
| Core detection functions   | `pii-detector.ts` (4 functions)                                     | Low                         |
| Registry                   | `pii-recognizer-registry.ts` (detectAll)                            | Low                         |
| Vault tokenization         | `pii-vault.ts` (tokenize)                                           | Medium                      |
| Streaming buffer           | `streaming-pii-buffer.ts` (processChunk, flush + detector callback) | High                        |
| Output filter              | `output-pii-filter.ts` (filterOutputPII)                            | Low                         |
| Session output protection  | `session-output-protection.ts` (cascade to callers)                 | Medium                      |
| Trace scrubber             | `trace-scrubber.ts` (synchronous pipeline)                          | High                        |
| CEL functions              | `cel-functions.ts` (CEL evaluators expect sync functions)           | Very High                   |
| Guardrail action executors | `action-executors.ts`                                               | Low                         |
| Custom dimensions          | `custom-dimensions.ts`                                              | Low                         |
| Message persistence        | `message-persistence-queue.ts`                                      | Low (already async context) |
| **Total**                  | **15-20 files, 30+ call sites**                                     | **Medium-High**             |

The CEL integration is the hardest — CEL evaluators typically expect synchronous functions. This may require a design compromise (e.g., ML detection runs separately, results cached, CEL reads from cache).

---

### GAP-8: No Multi-Language Support (LOW-MEDIUM)

- No `language` parameter on `PIIRecognizer.detect()`, `detectPII()`, or `PIIRecognizerRegistry.detectAll()`
- No `supportedLanguages` field on recognizer interface
- No locale-aware regex patterns
- Phone/SSN patterns are US-specific
- Email and credit card patterns are language-neutral (no gap)

**Impact:** Non-English deployments have degraded PII coverage. The medium-term roadmap (`docs/features/pii-detection.md:218`) defers this to the Presidio sidecar, which is correct — regex cannot solve multilingual NER.

---

## Part 3: Enhancement Plan — Option D (GLiNER Sidecar + Ported Presidio Recognizers)

### Design Philosophy: User-Configurable Detection Depth

The core insight: **not every customer needs the same depth of PII detection**. A simple chatbot handling FAQs has different PII risk than a healthcare intake agent. Adding ML-based detection adds latency. The user should choose their protection level, and the platform should clearly communicate the cost.

### Proposed Tier Model

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    PII Detection Tier Configuration                     │
│                 (Project Settings > PII Protection)                     │
├──────────┬────────────────────────────────────┬──────────┬──────────────┤
│ Tier     │ What's Detected                    │ Latency  │ Default      │
├──────────┼────────────────────────────────────┼──────────┼──────────────┤
│ BASIC    │ Email, phone (US), SSN, credit     │ <1 ms    │ AUTO-ON      │
│ (regex)  │ card, IPv4/IPv6                    │          │              │
├──────────┼────────────────────────────────────┼──────────┼──────────────┤
│ STANDARD │ BASIC + international phone,       │ 1-5 ms   │ AUTO-ON      │
│ (regex+) │ undashed SSN, passport, IBAN,      │          │              │
│          │ driver's license, tax IDs,         │          │              │
│          │ bank accounts, Amex/Maestro cards  │          │              │
├──────────┼────────────────────────────────────┼──────────┼──────────────┤
│ ADVANCED │ STANDARD + person names,           │ 30-200   │ OPT-IN       │
│ (NER/ML) │ addresses, dates of birth,         │ ms       │ (warns about │
│          │ organization names, locations,     │          │  latency)    │
│          │ medical terms, custom NER labels   │          │              │
├──────────┼────────────────────────────────────┼──────────┼──────────────┤
│ MAXIMUM  │ ADVANCED + custom ML models,       │ 50-500   │ OPT-IN       │
│ (full)   │ multiple NER passes, highest       │ ms       │ (requires    │
│          │ recall, cross-reference validation │          │  GLiNER GPU) │
└──────────┴────────────────────────────────────┴──────────┴──────────────┘
```

**Latency alert UX (Studio):**

When a user selects ADVANCED or MAXIMUM, the UI should display:

> **Performance notice:** This detection level adds approximately 30-200ms to each message. For real-time voice agents, this may cause perceptible delay. [Learn more]

### Architecture

```
                    ┌───────────────────────────────────┐
                    │  Project Runtime Config (MongoDB)  │
                    │  piiDetectionTier: 'basic' |       │
                    │    'standard' | 'advanced' |       │
                    │    'maximum'                       │
                    │  piiLatencyBudgetMs: 200            │
                    │  piiConfidenceThreshold: 0.5       │
                    │  enabledRecognizerPacks: [...]     │
                    └────────────┬──────────────────────┘
                                 │
                    ┌────────────▼──────────────────────┐
                    │   PIIRecognizerRegistry            │
                    │                                    │
                    │   tier: 'custom'  → DB patterns    │
                    │   tier: 'ml'      → GLiNER client  │
                    │   tier: 'regex'   → Builtin +      │
                    │                     Presidio-ported │
                    └────────────┬──────────────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                  │
     ┌────────▼─────┐  ┌────────▼─────┐  ┌────────▼────────┐
     │ BASIC/STD    │  │ ADVANCED/MAX │  │ CUSTOM          │
     │ (in-process) │  │ (HTTP call)  │  │ (DB-loaded)     │
     │              │  │              │  │                  │
     │ Regex +      │  │ GLiNER       │  │ Per-project      │
     │ validators   │  │ Sidecar      │  │ regex patterns   │
     │ <1-5ms       │  │ 30-200ms     │  │ <1ms             │
     └──────────────┘  └──────┬───────┘  └─────────────────┘
                              │
                    ┌─────────▼──────────┐
                    │  GLiNER Service     │
                    │  (Python sidecar)   │
                    │                     │
                    │  POST /predict      │
                    │  GET  /health       │
                    │  GET  /metrics      │
                    │                     │
                    │  Model: gliner_     │
                    │  multi_pii-v1       │
                    │  (209M params)      │
                    └────────────────────┘
```

### Execution Flow

```
User message arrives
        │
        ▼
  Read project PII tier config
        │
        ├── BASIC:    run regex recognizers (5 builtin)                    <1ms
        ├── STANDARD: run regex recognizers (5 builtin + ported Presidio)  1-5ms
        ├── ADVANCED: run STANDARD + async GLiNER call (parallel)         30-200ms
        └── MAXIMUM:  run STANDARD + GLiNER (large model, multi-pass)    50-500ms
        │
        ▼
  Merge results (confidence-based dedup)
        │
        ▼
  Apply confidence threshold filter
        │
        ▼
  Continue to vault tokenization (unchanged)
```

**Key design decision:** BASIC and STANDARD tiers run **entirely in-process** with zero external dependencies. Only ADVANCED and MAXIMUM require the GLiNER sidecar. This means:

- The platform remains fully functional without GLiNER deployed
- BASIC/STANDARD latency is identical to today (<1ms → 1-5ms)
- GLiNER is an optional infrastructure add-on, not a hard dependency

---

## Part 4: Workstream Breakdown

### Workstream 1: Foundation (Prerequisites)

These changes are required regardless of tier and fix existing gaps.

#### WS-1.1: Add Confidence Scoring to PIIDetection

**Scope:** ~8 production files, ~10 test files

```typescript
// pii-detector.ts — updated interface
export interface PIIDetection {
  type: PIIType;
  start: number;
  end: number;
  value: string; // safe preview, never raw
  confidence: number; // 0.0-1.0, default 1.0 for regex matches
  recognizer?: string; // which recognizer produced this detection
}
```

**Changes:**
| File | Change |
|---|---|
| `pii-detector.ts` | Add `confidence` to `PIIDetection`, `createSafePIIDetection()`, update `removeOverlaps()` to prefer higher confidence |
| `pii-recognizer-registry.ts` | Pass confidence through `detectAll()`, `RegexPIIRecognizer.detect()` returns confidence from pattern config (default 1.0) |
| `pii-vault.ts` | Store confidence in `PIIToken` for audit |
| `pii-audit.ts` | Log confidence in audit entries |
| `builtin-pii.ts` | Derive guardrail score from max/avg detection confidence |
| `pii-guard.ts` | Filter by `confidenceThreshold` from NLU config (already referenced in test: `pii-guard.test.ts:23`) |
| `output-pii-filter.ts` | Filter by confidence threshold |
| `streaming-pii-buffer.ts` | Pass confidence through chunk results |

**Backward compatible:** Yes — `confidence` defaults to `1.0` for all existing regex detections.

#### WS-1.2: Make detect() Support Async

**Scope:** 15-20 files, 30+ call sites

**Strategy:** Don't change the interface to `Promise<PIIDetection[]>` everywhere. Instead, introduce a parallel path:

```typescript
// pii-recognizer-registry.ts — new interface
export interface PIIRecognizer {
  name: string;
  supportedTypes: PIIType[];
  tier: RecognizerTier;
  detect(text: string): PIIDetection[];                    // sync (regex, custom)
  detectAsync?(text: string): Promise<PIIDetection[]>;     // async (ml)
}

// PIIRecognizerRegistry — new method
async detectAllAsync(text: string, opts?: {
  exemptTypes?: Set<PIIType>;
  latencyBudgetMs?: number;
}): Promise<PIIDetection[]> {
  // Run sync recognizers immediately
  const syncResults = this.detectAll(text, opts?.exemptTypes);

  // Run async recognizers in parallel with timeout
  const asyncRecognizers = this.getAsyncRecognizers();
  if (asyncRecognizers.length === 0) return syncResults;

  const asyncResults = await Promise.race([
    Promise.all(asyncRecognizers.map(r => r.detectAsync!(text))),
    timeout(opts?.latencyBudgetMs ?? 200)
  ]);

  // Merge and deduplicate by confidence
  return mergeDetections([...syncResults, ...asyncResults.flat()]);
}
```

**Key design decision:** The existing synchronous `detectAll()` is unchanged. A new `detectAllAsync()` runs sync recognizers first (instant), then async recognizers with a latency budget. If the budget expires, async results are dropped and the system degrades to regex-only.

**CEL compatibility:** CEL functions continue to use synchronous `detectAll()`. ML-based detection is not available in CEL expressions — this is acceptable because CEL guardrails should remain fast.

#### WS-1.3: Fix Registry Bypass

**Scope:** 3 files

| File                  | Fix                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `trace-scrubber.ts`   | Make `piiRecognizerRegistry` required in `TraceScrubberOptions`, or default to `getDefaultPIIRecognizerRegistry()` |
| `cel-functions.ts`    | Thread registry from CEL evaluation context; fall back to `getDefaultPIIRecognizerRegistry()`                      |
| `action-executors.ts` | Accept registry from guardrail evaluation context; fall back to `getDefaultPIIRecognizerRegistry()`                |

#### WS-1.4: Fix Regex Duplication

**Scope:** 2 files

Eliminate the duplicate regex definitions in `pii-detector.ts`. All detection should route through `PIIRecognizerRegistry`. The `detectWithLocalPatterns()` fallback in `pii-detector.ts` should use `getDefaultPIIRecognizerRegistry()` instead of maintaining its own copy of the patterns.

Fix the credit card regex divergence (13-19 digit vs 16-digit-only).

#### WS-1.5: Add Latency Budget Infrastructure

**Scope:** 3-4 files

```typescript
// New: PII detection config in ProjectRuntimeConfig
export interface PIIDetectionConfig {
  tier: 'basic' | 'standard' | 'advanced' | 'maximum';
  latencyBudgetMs: number; // default: 200ms
  confidenceThreshold: number; // default: 0.5
  enabledRecognizerPacks: string[]; // e.g., ['us', 'eu', 'financial', 'medical']
  glinerEndpoint?: string; // e.g., 'http://gliner-sidecar:8000'
  glinerModel?: string; // e.g., 'gliner_multi_pii-v1'
}
```

Add `performance.now()` instrumentation to all PII detection entry points:

- `pii-guard.ts` (NLU guard)
- `pii-llm-redaction.ts` (vault tokenization)
- `output-pii-filter.ts` (output filter)
- `streaming-pii-buffer.ts` (streaming chunks)

Emit latency as a trace event dimension for monitoring.

**Estimated effort for Workstream 1:** M (2-3 weeks)

---

### Workstream 2: STANDARD Tier — Port Presidio Regex Recognizers

Port Presidio's pattern-based recognizers (MIT-licensed) into our `RegexPIIRecognizer` format. No external service required — these run in-process.

#### Recognizer Packs (user-selectable)

| Pack                    | Entity Types                                                                                                                                 | Source                                 | Validator Logic                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------ |
| **core** (auto-on)      | Email, phone (US), SSN (dashed+undashed), credit card (13-19 digit + Luhn), IPv4, IPv6                                                       | Existing + enhanced                    | Luhn, octet validation, SSN area exclusion |
| **us** (auto-on for US) | US passport, US driver's license, US ITIN, US bank account, US ABA routing                                                                   | Presidio port                          | Format validators per state                |
| **eu**                  | IBAN (30+ countries), UK NHS, UK NINO, UK passport, DE tax ID, DE passport, IT fiscal code, ES NIF/NIE, PL PESEL, FI PIC, SE personal number | Presidio port                          | IBAN checksum, Verhoeff (where applicable) |
| **apac**                | IN Aadhaar (Verhoeff), IN PAN, IN GSTIN, SG NRIC, AU TFN (checksum), AU Medicare, AU ABN/ACN, KR RRN                                         | Presidio port                          | Verhoeff, TFN checksum, Luhn variants      |
| **financial**           | IBAN, SWIFT/BIC, bank account patterns, crypto wallet addresses                                                                              | Presidio port                          | IBAN checksum, BIC format                  |
| **medical**             | Medical record numbers, DEA numbers, NPI numbers                                                                                             | Presidio port                          | NPI Luhn check, DEA checksum               |
| **network**             | IPv6, MAC address, URL with credentials                                                                                                      | New                                    | Format validation                          |
| **international-phone** | E.164 format, country-code-aware matching for 50+ countries                                                                                  | New (based on libphonenumber patterns) | Digit count per country code               |

#### Implementation Approach

Each pack is a self-contained module that registers recognizers:

```typescript
// packages/compiler/src/platform/security/recognizer-packs/us.ts
export function registerUSRecognizers(registry: PIIRecognizerRegistry): void {
  registry.register(
    new RegexPIIRecognizer({
      name: 'us-passport',
      supportedTypes: ['us_passport'],
      patterns: [/\b[0-9]{9}\b/g], // 9-digit, context-dependent
      validator: (match) => validateUSPassport(match),
      contextWords: ['passport', 'travel document', 'state department'],
      baseConfidence: 0.3, // low without context, boosted by context words
    }),
    { permanent: true },
  );

  // ... more recognizers
}
```

#### Context Enhancement (Ported from Presidio)

Add a `contextWords` field to `RegexPIIRecognizer` and implement context boosting:

```typescript
export interface RegexPIIRecognizerConfig {
  name: string;
  supportedTypes: PIIType[];
  patterns: RegExp[];
  validator?: (match: string) => boolean;
  contextWords?: string[]; // NEW: words that boost confidence
  contextBoost?: number; // NEW: default 0.35
  baseConfidence?: number; // NEW: default 1.0 for regex
}
```

When context words are found within N tokens of a match, the detection's confidence is boosted by `contextBoost` (default 0.35, matching Presidio). This dramatically reduces false positives on ambiguous patterns (e.g., 9-digit numbers that could be passport numbers or random IDs).

**Estimated effort for Workstream 2:** L (3-4 weeks)

---

### Workstream 3: ADVANCED/MAXIMUM Tier — GLiNER Sidecar

#### Infrastructure

##### Service Deployment

The platform already runs 3 Python sidecar services with the exact same pattern:

- **Docling** (port 8080) — document processing
- **BGE-M3** (port 8000) — embeddings
- **Preprocessing** (port 8003) — query preprocessing

GLiNER would be the 4th, following the identical pattern:

```yaml
# docker-compose.yml addition
gliner-service:
  build:
    context: ./services/gliner-service
    dockerfile: Dockerfile
  container_name: abl-gliner
  restart: unless-stopped
  ports:
    - '8004:8000'
  environment:
    GLINER_MODEL: urchade/gliner_multi_pii-v1
    GLINER_DEVICE: cpu # or cuda for GPU hosts
    GLINER_DTYPE: float32 # bf16 for GPU
    GLINER_MAX_BATCH_SIZE: 16
    GLINER_THRESHOLD: 0.5
    PYTHONUNBUFFERED: 1
  volumes:
    - gliner_model_cache:/root/.cache/huggingface
  healthcheck:
    test: ['CMD', 'curl', '-f', 'http://localhost:8000/health']
    interval: 30s
    timeout: 10s
    retries: 3
    start_period: 90s # model loading takes 30-60s
  networks:
    - backend
```

##### Model Selection

| Model                 | Params | Size     | Use Case                                                   | Latency (CPU) | Latency (GPU) |
| --------------------- | ------ | -------- | ---------------------------------------------------------- | ------------- | ------------- |
| `gliner_multi_pii-v1` | 209M   | ~1.16 GB | **Recommended default** — multilingual, fine-tuned for PII | 80-200ms      | 8-20ms        |
| `gliner_small-v2.1`   | 166M   | 611 MB   | Budget/low-latency — English only                          | 50-150ms      | 5-15ms        |
| `gliner_medium-v2.1`  | 209M   | 781 MB   | General NER — English                                      | 80-200ms      | 8-20ms        |
| `gliner_large-v2.1`   | 459M   | 1.78 GB  | Highest accuracy — English                                 | 150-400ms     | 15-35ms       |
| `gliner_multi-v2.1`   | 209M   | 1.16 GB  | Multilingual general NER                                   | 80-200ms      | 8-20ms        |

**Recommendation:** Start with `gliner_multi_pii-v1` (PII-tuned, multilingual, 209M). Allow per-project override via `PIIDetectionConfig.glinerModel`.

##### Hardware Requirements

| Deployment                           | CPU     | RAM   | GPU      | Cost Estimate      |
| ------------------------------------ | ------- | ----- | -------- | ------------------ |
| **Dev/staging (CPU)**                | 2 cores | 4 GB  | None     | ~$30/mo (cloud VM) |
| **Production (CPU, <10 req/s)**      | 4 cores | 8 GB  | None     | ~$60/mo            |
| **Production (GPU, >10 req/s)**      | 4 cores | 16 GB | 1x T4/L4 | ~$200-400/mo       |
| **High-throughput (GPU, >50 req/s)** | 8 cores | 32 GB | 1x A10G  | ~$400-800/mo       |

For the ONNX-quantized CPU path (recommended for cost-sensitive deployments):

- `gliner_multi_pii-v1` ONNX int8: ~200-250MB model, ~2 GB RAM, 40-110ms latency on 4 cores

##### Latency Budget Enforcement

```
┌──────────────────────────────────────────────────────┐
│           Message Processing Timeline                 │
│                                                       │
│  t=0ms    Start PII detection                         │
│  t=0.5ms  Regex recognizers complete (BASIC/STANDARD) │
│  t=0.5ms  Fire async GLiNER request (if ADVANCED+)   │
│           ┌─────────── Latency budget ──────────┐    │
│           │                                      │    │
│  t=50ms   │ GLiNER response received (typical)  │    │
│           │ → Merge results, continue pipeline   │    │
│           │                                      │    │
│  t=200ms  │ Budget expires (if GLiNER slow)      │    │
│           └──────────────────────────────────────┘    │
│           → Degrade to regex-only results             │
│           → Log degradation event                     │
│           → Continue pipeline (no user impact)        │
│                                                       │
│  Vault tokenization, consumer rendering,              │
│  audit logging proceed unchanged                      │
└──────────────────────────────────────────────────────┘
```

**Graceful degradation:** If GLiNER is slow or unavailable, the system falls back to regex-only detection. The user is never blocked. A degradation trace event is emitted for monitoring.

##### GLiNER Client (Node.js)

```typescript
// packages/compiler/src/platform/security/gliner-client.ts
export class GLiNERClient {
  private endpoint: string;
  private timeout: number;
  private circuitBreaker: CircuitBreaker;

  async predict(
    text: string,
    labels: string[],
    opts?: {
      threshold?: number;
      flatNer?: boolean;
    },
  ): Promise<GLiNEREntity[]> {
    // Circuit breaker: if 5 failures in 60s, open circuit for 30s
    return this.circuitBreaker.execute(async () => {
      const response = await fetch(`${this.endpoint}/predict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          labels,
          threshold: opts?.threshold ?? 0.5,
          flat_ner: opts?.flatNer ?? true,
        }),
        signal: AbortSignal.timeout(this.timeout),
      });
      return response.json();
    });
  }
}
```

##### GLiNER ML Recognizer

```typescript
// packages/compiler/src/platform/security/recognizers/gliner-recognizer.ts
export class GLiNERRecognizer implements PIIRecognizer {
  name = 'gliner-ner';
  supportedTypes: PIIType[] = [
    'person',
    'location',
    'organization',
    'date_of_birth',
    'address',
    'medical_condition',
  ];
  tier: RecognizerTier = 'ml';

  private client: GLiNERClient;
  private labelMap: Map<string, PIIType>; // GLiNER label → PIIType

  detect(text: string): PIIDetection[] {
    // Sync stub — throws if called directly
    throw new Error('GLiNERRecognizer requires async detection. Use detectAsync().');
  }

  async detectAsync(text: string): Promise<PIIDetection[]> {
    const labels = Array.from(this.labelMap.keys());
    const entities = await this.client.predict(text, labels);
    return entities.map((e) => ({
      type: this.labelMap.get(e.label) ?? (e.label as PIIType),
      start: e.start,
      end: e.end,
      value: `[REDACTED_${(this.labelMap.get(e.label) ?? e.label).toUpperCase()}]`,
      confidence: e.score,
      recognizer: this.name,
    }));
  }
}
```

**Estimated effort for Workstream 3:** L-XL (4-6 weeks including infrastructure)

---

### Workstream 4: Studio UI for Tier Configuration

#### Settings Tab Enhancement

Extend the existing **Project Settings > PII Protection** tab with tier selection:

```
┌─────────────────────────────────────────────────────────┐
│  PII Protection Settings                                 │
│                                                          │
│  Detection Tier                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │ ○ BASIC — Email, phone (US), SSN, credit card, IP │  │
│  │   Latency: <1ms | No additional infrastructure     │  │
│  │                                                     │  │
│  │ ● STANDARD — Basic + international IDs, IBAN,      │  │
│  │   passports, tax IDs, bank accounts                 │  │
│  │   Latency: 1-5ms | No additional infrastructure    │  │
│  │                                                     │  │
│  │ ○ ADVANCED — Standard + person names, addresses,   │  │
│  │   dates of birth, organizations, locations          │  │
│  │   Latency: 30-200ms | Requires GLiNER service      │  │
│  │   ⚠ Adds latency to each message                   │  │
│  │                                                     │  │
│  │ ○ MAXIMUM — All detections, highest recall,         │  │
│  │   multi-pass NER                                    │  │
│  │   Latency: 50-500ms | Requires GLiNER GPU          │  │
│  │   ⚠ Significant latency impact for voice agents    │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  Recognizer Packs        (available for STANDARD+)       │
│  ┌────────────────────────────────────────────────────┐  │
│  │ ☑ Core (email, phone, SSN, credit card, IP)       │  │
│  │ ☑ United States (passport, DL, ITIN, bank acct)   │  │
│  │ ☐ European Union (IBAN, NHS, NINO, DE/IT/ES IDs)  │  │
│  │ ☐ Asia-Pacific (Aadhaar, PAN, NRIC, TFN)          │  │
│  │ ☐ Financial (SWIFT/BIC, crypto wallets)            │  │
│  │ ☐ Medical (MRN, DEA, NPI)                          │  │
│  │ ☐ International Phone (E.164, 50+ country codes)   │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  Confidence Threshold    [====●=====] 0.5                │
│  Latency Budget          [=======●==] 200ms              │
│                                                          │
│  Custom Patterns         [Manage patterns →]             │
└─────────────────────────────────────────────────────────┘
```

**Estimated effort for Workstream 4:** M (2-3 weeks)

---

## Part 5: Implementation Sequence

```
Phase 1: Foundation (WS-1)                              Weeks 1-3
├── WS-1.1: Confidence scoring on PIIDetection
├── WS-1.2: Async detect support (detectAllAsync)
├── WS-1.3: Fix registry bypass (3 files)
├── WS-1.4: Fix regex duplication (2 files)
└── WS-1.5: Latency budget infrastructure

Phase 2: STANDARD Tier (WS-2)                           Weeks 3-6
├── Port core recognizer pack (enhanced builtins)
├── Port US recognizer pack
├── Port EU recognizer pack
├── Port APAC recognizer pack
├── Port financial, medical, network packs
├── Implement context-word confidence boosting
└── Wire recognizer packs to project config

Phase 3: ADVANCED Tier (WS-3)                           Weeks 6-10
├── Build GLiNER Docker sidecar service
├── GLiNER client + circuit breaker
├── GLiNER ML recognizer implementation
├── Latency budget enforcement + graceful degradation
├── docker-compose integration
└── K8s deployment manifests (Helm/KubeRay)

Phase 4: Studio UX (WS-4)                               Weeks 8-11
├── Tier selection UI
├── Recognizer pack checkboxes
├── Confidence threshold slider
├── Latency budget configuration
└── Latency warning banners for ADVANCED/MAXIMUM
```

Phases 3 and 4 overlap — Studio UI can start once the config schema (WS-1.5) is defined.

---

## Part 6: Risk Assessment

| Risk                                                 | Probability | Impact                                    | Mitigation                                                                     |
| ---------------------------------------------------- | ----------- | ----------------------------------------- | ------------------------------------------------------------------------------ |
| GLiNER sidecar adds cold-start latency (30-60s)      | High        | Low — only affects pod restarts           | Bake model into Docker image; use readiness probe                              |
| Async detect cascade breaks CEL functions            | Medium      | Medium — CEL expects sync                 | Keep CEL on sync path; ML detection excluded from CEL                          |
| Ported Presidio recognizers increase false positives | Medium      | Medium — user frustration                 | Confidence threshold filtering; context-word boosting; per-pack enable/disable |
| GLiNER GPU cost in production                        | Medium      | Medium — infrastructure cost              | Default to CPU with ONNX; GPU only for MAXIMUM tier                            |
| Regex DRY fix introduces regressions                 | Low         | High — PII detection is security-critical | Run full existing test suite; add regression tests before refactor             |
| International phone patterns too aggressive          | Medium      | Low — configurable per pack               | Off by default; contextWords required for low-confidence patterns              |

---

## Part 7: Success Metrics

| Metric                        | Current              | Target (STANDARD)    | Target (ADVANCED)     |
| ----------------------------- | -------------------- | -------------------- | --------------------- |
| Entity types detected         | 5                    | 40+                  | 55+                   |
| Person name detection         | 0%                   | 0% (regex can't)     | >85% F1               |
| International phone detection | 0%                   | >90% for E.164       | >90%                  |
| IBAN detection                | 0%                   | >95% (with checksum) | >95%                  |
| False positive rate           | Unknown (no metrics) | <5% (with context)   | <3% (with confidence) |
| Detection latency p95         | <1ms                 | <5ms                 | <200ms                |
| Detection latency p99         | <1ms                 | <10ms                | <500ms                |
| Registry bypass paths         | 3                    | 0                    | 0                     |

---

## Appendix A: Files Requiring Changes (Complete List)

### Workstream 1 (Foundation)

| File                                                                    | Change Type                                               | WS       |
| ----------------------------------------------------------------------- | --------------------------------------------------------- | -------- |
| `packages/compiler/src/platform/security/pii-detector.ts`               | Modify — add confidence, fix DRY                          | 1.1, 1.4 |
| `packages/compiler/src/platform/security/pii-recognizer-registry.ts`    | Modify — add confidence, detectAllAsync, context boosting | 1.1, 1.2 |
| `packages/compiler/src/platform/security/pii-vault.ts`                  | Modify — store confidence, async tokenize                 | 1.1, 1.2 |
| `packages/compiler/src/platform/security/pii-audit.ts`                  | Modify — log confidence                                   | 1.1      |
| `packages/compiler/src/platform/security/streaming-pii-buffer.ts`       | Modify — async detector callback                          | 1.2      |
| `packages/compiler/src/platform/nlu/enterprise/pii-guard.ts`            | Modify — confidence threshold                             | 1.1      |
| `packages/compiler/src/platform/guardrails/providers/builtin-pii.ts`    | Modify — derive score from confidence                     | 1.1      |
| `packages/compiler/src/platform/constructs/executors/trace-scrubber.ts` | Modify — require registry                                 | 1.3      |
| `packages/compiler/src/platform/constructs/cel-functions.ts`            | Modify — default to singleton registry                    | 1.3      |
| `packages/compiler/src/platform/guardrails/action-executors.ts`         | Modify — default to singleton registry                    | 1.3      |
| `apps/runtime/src/services/execution/output-pii-filter.ts`              | Modify — confidence threshold, latency                    | 1.1, 1.5 |
| `apps/runtime/src/services/execution/pii-llm-redaction.ts`              | Modify — latency instrumentation                          | 1.5      |
| `apps/runtime/src/services/pii/session-pii-context.ts`                  | Modify — tier config, latency budget                      | 1.5      |

### Workstream 2 (STANDARD Tier)

| File                                                                              | Change Type                            |
| --------------------------------------------------------------------------------- | -------------------------------------- |
| `packages/compiler/src/platform/security/recognizer-packs/core.ts`                | New — enhanced builtins                |
| `packages/compiler/src/platform/security/recognizer-packs/us.ts`                  | New — US patterns                      |
| `packages/compiler/src/platform/security/recognizer-packs/eu.ts`                  | New — EU patterns                      |
| `packages/compiler/src/platform/security/recognizer-packs/apac.ts`                | New — APAC patterns                    |
| `packages/compiler/src/platform/security/recognizer-packs/financial.ts`           | New — financial patterns               |
| `packages/compiler/src/platform/security/recognizer-packs/medical.ts`             | New — medical patterns                 |
| `packages/compiler/src/platform/security/recognizer-packs/network.ts`             | New — network patterns                 |
| `packages/compiler/src/platform/security/recognizer-packs/international-phone.ts` | New — E.164 patterns                   |
| `packages/compiler/src/platform/security/recognizer-packs/index.ts`               | New — pack registry                    |
| `packages/compiler/src/platform/security/context-enhancer.ts`                     | New — context-word confidence boosting |

### Workstream 3 (ADVANCED Tier)

| File                                                                       | Change Type                         |
| -------------------------------------------------------------------------- | ----------------------------------- |
| `services/gliner-service/`                                                 | New directory — Python sidecar      |
| `services/gliner-service/Dockerfile`                                       | New                                 |
| `services/gliner-service/server.py`                                        | New — FastAPI/Ray Serve wrapper     |
| `services/gliner-service/requirements.txt`                                 | New                                 |
| `packages/compiler/src/platform/security/gliner-client.ts`                 | New — HTTP client + circuit breaker |
| `packages/compiler/src/platform/security/recognizers/gliner-recognizer.ts` | New — ML recognizer                 |
| `docker-compose.yml`                                                       | Modify — add gliner-service         |
| `docker-compose.gpu.yml`                                                   | Modify — add GPU override           |

### Workstream 4 (Studio UI)

| File                                                           | Change Type                     |
| -------------------------------------------------------------- | ------------------------------- |
| `apps/studio/src/components/settings/PIIProtectionTab.tsx`     | Modify — add tier selection     |
| `packages/database/src/models/project-runtime-config.model.ts` | Modify — add PIIDetectionConfig |

---

## Appendix B: Presidio Entity Types Available for Porting

Full list of Presidio's MIT-licensed recognizers that can be ported:

| Recognizer                | Entity Type       | Validation             | Context Words                                | Priority              |
| ------------------------- | ----------------- | ---------------------- | -------------------------------------------- | --------------------- |
| CreditCardRecognizer      | CREDIT_CARD       | Luhn checksum          | credit, card, visa, mastercard, cc, amex     | P0 (enhance existing) |
| EmailRecognizer           | EMAIL_ADDRESS     | Regex only             | email, e-mail, mail                          | P0 (enhance existing) |
| PhoneRecognizer           | PHONE_NUMBER      | Digit count            | phone, mobile, cell, telephone, tel, contact | P0 (enhance existing) |
| IbanRecognizer            | IBAN_CODE         | IBAN checksum          | iban, bank account, bank number              | P1                    |
| IpRecognizer              | IP_ADDRESS        | Octet/IPv6 validation  | ip, ip address, internet protocol            | P0 (add IPv6)         |
| UsPassportRecognizer      | US_PASSPORT       | 9-digit format         | passport, travel document                    | P1                    |
| UsSsnRecognizer           | US_SSN            | Area exclusion rules   | ssn, social security, tax                    | P0 (enhance existing) |
| UsItinRecognizer          | US_ITIN           | IRS format             | itin, individual taxpayer                    | P1                    |
| UsBankRecognizer          | US_BANK_NUMBER    | Digit count + context  | bank account, account number, routing        | P1                    |
| UsDriverLicenseRecognizer | US_DRIVER_LICENSE | State format patterns  | driver license, driver's license, DL         | P1                    |
| UkNhsRecognizer           | UK_NHS            | Modulus 11 checksum    | nhs, national health                         | P2                    |
| UkNinoRecognizer          | UK_NINO           | Format validation      | national insurance, NI number                | P2                    |
| InAadhaarRecognizer       | IN_AADHAAR        | Verhoeff checksum      | aadhaar, uid, unique identification          | P2                    |
| InPanRecognizer           | IN_PAN            | Format validation      | pan, permanent account                       | P2                    |
| SgNricFinRecognizer       | SG_NRIC_FIN       | Checksum               | nric, fin, national registration             | P2                    |
| AuTfnRecognizer           | AU_TFN            | TFN checksum           | tax file number, tfn                         | P2                    |
| AuMedicareRecognizer      | AU_MEDICARE       | Checksum               | medicare, medicare number                    | P2                    |
| DateTimeRecognizer        | DATE_TIME         | Multiple patterns      | born, birthday, dob, date                    | P1                    |
| CryptoRecognizer          | CRYPTO            | Bitcoin format         | bitcoin, btc, wallet, crypto                 | P3                    |
| MedicalLicenseRecognizer  | MEDICAL_LICENSE   | NPI Luhn, DEA checksum | medical, license, npi, dea                   | P2                    |

---

## Appendix C: GLiNER PII-Specific Labels

The `gliner_multi_pii-v1` model is fine-tuned to recognize these PII-related entity types out of the box:

| Label                    | Description                  | Example                         |
| ------------------------ | ---------------------------- | ------------------------------- |
| `person`                 | Person names                 | "John Smith"                    |
| `location`               | Physical locations/addresses | "123 Main St, Springfield"      |
| `organization`           | Company/org names            | "Acme Corporation"              |
| `date_of_birth`          | Dates of birth               | "March 15, 1990"                |
| `phone_number`           | Phone numbers (any format)   | "+44 20 7946 0958"              |
| `email`                  | Email addresses              | "john@example.com"              |
| `credit_card`            | Credit card numbers          | "4111-1111-1111-1111"           |
| `social_security_number` | SSN/national IDs             | "123-45-6789"                   |
| `passport_number`        | Passport numbers             | "X12345678"                     |
| `driver_license`         | Driver's license numbers     | "D123-4567-8901"                |
| `bank_account`           | Bank account/IBAN            | "GB82 WEST 1234 5698 7654 32"   |
| `medical_record`         | Medical record numbers       | "MRN-12345"                     |
| `ip_address`             | IP addresses                 | "192.168.1.1"                   |
| `url`                    | URLs with PII                | "https://user:pass@example.com" |
| `username`               | Usernames/handles            | "@john_smith"                   |
| `password`               | Plaintext passwords          | "MyP@ssw0rd!"                   |
| `address`                | Street addresses             | "456 Oak Ave, Apt 3B"           |
| `nationality`            | Nationalities                | "American", "British"           |
| `ethnicity`              | Ethnic identifiers           | Context-dependent               |
| `religion`               | Religious identifiers        | Context-dependent               |
| `political_affiliation`  | Political identifiers        | Context-dependent               |

The model can also accept **custom labels** at inference time (zero-shot). For example, passing `["insurance_policy_number", "vehicle_registration"]` would detect those entities without retraining.
