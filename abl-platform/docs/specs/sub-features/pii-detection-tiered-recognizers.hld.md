# HLD: PII Detection Tiered Recognizers (Foundation + STANDARD Tier)

**Feature Spec**: [`docs/features/sub-features/pii-detection-tiered-recognizers.md`](../../features/sub-features/pii-detection-tiered-recognizers.md)
**Test Spec**: [`docs/testing/sub-features/pii-detection-tiered-recognizers.md`](../../testing/sub-features/pii-detection-tiered-recognizers.md)
**Parent HLD**: [`docs/specs/pii-detection.hld.md`](../pii-detection.hld.md)
**Sibling Sub-Feature**: [`docs/features/sub-features/pii-detection-enhancements.md`](../../features/sub-features/pii-detection-enhancements.md) (cloud tier — shares Foundation prerequisites)
**Status**: APPROVED — implementation complete (ALPHA), 5-round pr-review APPROVED 2026-05-09
**JIRA**: ABLP-921
**Author**: GirishAh-Kore
**Date**: 2026-05-09

---

## 1. Problem Statement

The platform ships a production-grade PII _lifecycle_ (vault, per-consumer rendering, streaming detection, encrypted persistence, audit, GDPR cascade) but the _detection_ layer beneath it is narrow and inconsistent:

- **5 entity types** detected today (email, phone, SSN, credit card, IPv4) versus 65+ in industry-standard libraries.
- **No confidence scoring** — every match is binary; there is no way to tune precision/recall, prefer one of two overlapping detections, or boost confidence using nearby context words.
- **US-only patterns**, with documented divergence between `pii-detector.ts` (13–19 digit credit card, dashed+undashed SSN) and `pii-recognizer-registry.ts` (16-digit-only credit card, dashed-only SSN).
- **Three direct registry-bypass paths** at `trace-scrubber.ts:136`, `cel-functions.ts:18`, and `action-executors.ts:23,59` silently fall through to a hardcoded copy of the 5 patterns when no registry is supplied. A fourth surface — `builtin-pii.ts:25` — exhibits the same fall-through whenever `request.context?.piiRecognizerRegistry` is `undefined`; it is transitively closed by the FR-3 fix to `detectPII()` itself (see §10.1 migration table).
- **Duplicate regex source of truth** — the same 5 patterns are re-declared in `pii-detector.ts` and `pii-recognizer-registry.ts`, risking drift.
- **No latency budgets or per-entry-point instrumentation** — only the guardrail provider records timings; the NLU guard, output filter, vault, and streaming buffer have none.

Customers in regulated industries (healthcare, financial services) and non-US markets get insufficient coverage today. Competitors (Decagon, Sierra, Vectara) ship multi-region recognizer coverage as table stakes; ABL is behind on this baseline.

This HLD covers Foundation (WS-1) + STANDARD tier (WS-2) deliverables. The ADVANCED/MAXIMUM tiers (GLiNER NER), the cloud tier (sibling sub-feature), and the Studio settings UX (WS-4) are explicitly out of scope.

---

## 2. Alternatives Considered

### Option A — Status quo + targeted bug fixes only

Fix only the three concrete defects (registry-bypass, duplicate regex, credit-card divergence). No new packs, no confidence scoring.

- **Pros**: Smallest blast radius. Closes the documented bugs without adding new capability.
- **Cons**: Does nothing for the industry-parity problem. Customers in EU/APAC/regulated industries still write custom patterns by hand. No path to NER (WS-3) or cloud (sibling spec) without a second refactor.
- **Effort**: S
- **Verdict**: Rejected. The Foundation refactors are prerequisites for both this spec's STANDARD packs _and_ the sibling cloud-tier spec; doing them once is cheaper than doing them twice.

### Option B — Hybrid: Foundation + STANDARD tier in-process via recognizer packs (Selected)

Land Foundation refactors (FR-1…FR-5, FR-8) plus the eight STANDARD recognizer packs (FR-6) registered into the existing `PIIRecognizerRegistry`. Pure-regex + hand-ported checksum validators. Zero new runtime dependencies.

- **Pros**: One coherent change. Foundation prerequisites usable by sibling cloud-tier spec without rework. Zero infrastructure cost (in-process). p95 ≤ 5 ms target achievable per industry benchmarks (IBM mcp-context-forge ~10 ms / 1KB at 12 patterns ⇒ ~3 ms / 1KB at our optimization budget). Existing `permanent: true` flag and `RegexPIIRecognizer` constructor support packs without architectural rework.
- **Cons**: Regex cannot solve unstructured PII (names, addresses, DoBs, organization names). A project that needs name/address detection should not enable STANDARD as a substitute — that need is squarely WS-3 territory. ~150 LoC of hand-ported validators (IBAN mod-97, Verhoeff, DEA, BTC base58) instead of a third-party validator library.
- **Effort**: M
- **Verdict**: **Selected.** Best balance of scope, effort, and forward compatibility.

### Option C — Foundation only, defer all packs to a later spec

Land Foundation (FR-1…FR-5, FR-8). Ship `core` pack as the de-duped legacy 5-recognizer set. Defer `us`/`eu`/`apac`/`financial`/`medical`/`network`/`international-phone` packs to later sub-features (one per region/domain).

- **Pros**: Smallest first commit. Each pack ships under its own JIRA with its own metrics.
- **Cons**: Industry parity moves further out. Each follow-up spec re-traverses the SDLC (feature spec → test spec → HLD → LLD → audit) for changes that are mostly mechanical regex-and-validator authoring. Sibling cloud-tier spec is unblocked at the same point either way (Foundation-only).
- **Effort**: S (this spec) + 4× M (follow-up specs) = high total
- **Verdict**: Rejected on total cost. Per-pack JIRAs add SDLC overhead disproportionate to the per-pack risk.

### Recommendation

**Option B selected.** Single coherent change; reuses existing registry/validator/recognizer machinery; zero new runtime deps; preserves a clean extension point for both the cloud tier (sibling spec) and the future GLiNER tier (WS-3).

---

## 3. Architecture

### 3.1 Framing

This sub-feature is a **registry-centric additive extension**. The `PIIRecognizerRegistry` singleton and its per-project overlay pattern remain the only architectural primitives. Recognizer packs are collections of `RegexPIIRecognizer` instances that register _into_ the existing registry at two levels:

1. **Module-load** (singleton fallback) — `getDefaultPIIRecognizerRegistry()` registers the `core` pack (replacing the 5 legacy built-ins) plus any pack listed in `PII_DEFAULT_RECOGNIZER_PACKS` env. This is the registry the three ex-bypass surfaces (`trace-scrubber`, `cel-functions`, `action-executors`) default to after FR-4.
2. **Per-session** (project overlay) — `resolveProjectPIISnapshot()` constructs a fresh `PIIRecognizerRegistry`, registers built-ins, registers the project's `enabled_recognizer_packs`, then overlays project custom patterns via `loadProjectPIIPatterns()`.

No new wrapper layer. No PackManager class. The pack system is "a directory of factories, each calling `registry.register(rec, { permanent: true })`."

**Pack registration ordering — `core` pack vs `registerBuiltInRecognizers()`**

Today both `getDefaultPIIRecognizerRegistry()` (`pii-recognizer-registry.ts:261-267`) and `createRecognizerRegistry()` in `session-pii-context.ts:119-123` call `registerBuiltInRecognizers()` first, registering 5 recognizers under names `builtin-email`, `builtin-ssn`, `builtin-credit-card`, `builtin-phone`, `builtin-ip-address`. The `register()` method silently overwrites on name conflict (the `MAX_RECOGNIZERS` size check only fires for _new_ names, per `pii-recognizer-registry.ts:29-44`).

**Decision (binding for the LLD):** refactor `registerBuiltInRecognizers()` to delegate to `core.register(registry)` — i.e., the `core` pack becomes the single source of truth for the legacy 5 entity types, and `registerBuiltInRecognizers()` becomes a thin compatibility shim that calls into the `core` pack. This avoids the name-collision question entirely (built-in registration _is_ `core` registration), keeps the function name as a stable export for any external caller, and makes the `core` pack list (e.g., 13–19 digit credit card, undashed-SSN extension) the canonical legacy set. Pack recognizer names use a stable `core-*` prefix (e.g. `core-email`, `core-ssn`) — no `builtin-*` names persist after this change. Audit-log entries and trace events written before this spec retain their original recognizer-name strings (no rename migration); going forward they carry the `core-*` form. The LLD must enforce this rename in §10.1's audit-log compatibility note.

### 3.2 System Context Diagram

```
                 ┌───────────────────────┐
                 │  Studio runtime-config│  (existing)
                 │  PATCH /pii_redaction │
                 └───────────┬───────────┘
                             │ tier, latency_budget_ms,
                             │ confidence_threshold,
                             │ enabled_recognizer_packs
                             ▼
                 ┌───────────────────────┐
                 │  ProjectRuntimeConfig │  Mongoose + Zod (extended additively)
                 │  pii_redaction sub-doc│
                 └───────────┬───────────┘
                             │ bumpPIIConfigEpoch (already wired)
                             ▼
                 ┌───────────────────────┐
                 │  Session bootstrap    │  resolveProjectPIISnapshot()
                 │  registry overlay     │   → built-ins
                 │                       │   → registerEnabledPacks(...)   NEW
                 │                       │   → loadProjectPIIPatterns(...)
                 └───────────┬───────────┘
                             │
       ┌─────────────┬───────┴──────┬─────────────┬─────────────┐
       │             │              │             │             │
       ▼             ▼              ▼             ▼             ▼
  ┌────────┐    ┌────────┐    ┌─────────┐   ┌─────────┐   ┌─────────┐
  │NLU     │    │PII     │    │Output   │   │Streaming│   │Trace    │
  │Guard   │    │Vault   │    │Filter   │   │Buffer   │   │Scrubber │
  └───┬────┘    └───┬────┘    └────┬────┘   └────┬────┘   └────┬────┘
      │             │              │             │             │
      └─────────────┴──────┬───────┴─────────────┴─────────────┘
                           │ pii.detect.latency_ms (NEW)         pii.detect.degraded (NEW)
                           ▼
                 ┌───────────────────────┐
                 │  Trace event channel  │
                 └───────────────────────┘
```

### 3.3 Component Diagram

```
packages/compiler/src/platform/security/
├── pii-detector.ts                    EXTEND: drop detectWithLocalPatterns(),
│                                              route detectPII/redact/contains
│                                              through getDefaultPIIRecognizerRegistry().
├── pii-recognizer-registry.ts         EXTEND: PIIDetection.confidence/recognizer,
│                                              detectAllAsync(), context-word
│                                              boost in RegexPIIRecognizer,
│                                              MAX_RECOGNIZERS 50 → 100.
├── context-enhancer.ts                NEW   : pure function applyContextBoost(text,
│                                              matchSpan, contextWords, config) → number.
├── recognizer-packs/
│   ├── index.ts                       NEW   : registerPacks(packNames, registry),
│   │                                          PACK_NAMES enum.
│   ├── core.ts                        NEW   : email, US phone, SSN dashed+undashed,
│   │                                          credit-card 13–19 digit + Luhn, IPv4.
│   ├── us.ts                          NEW   : passport, DL, ITIN, bank acct, ABA routing.
│   ├── eu.ts                          NEW   : IBAN(mod-97), UK NHS, NINO, GB passport,
│   │                                          DE TaxID, IT fiscal code, ES NIF/NIE,
│   │                                          PL PESEL, FI PIC, SE personal number.
│   ├── apac.ts                        NEW   : IN Aadhaar(Verhoeff), PAN, GSTIN,
│   │                                          SG NRIC, AU TFN/Medicare/ABN/ACN, KR RRN.
│   ├── financial.ts                   NEW   : SWIFT/BIC, BTC wallet (base58 check).
│   ├── medical.ts                     NEW   : MRN, NPI(Luhn-prefixed), DEA(checksum).
│   ├── network.ts                     NEW   : IPv6, MAC, URL with embedded creds.
│   ├── international-phone.ts         NEW   : delegates to phone-extraction.ts
│   │                                          (libphonenumber-js findPhoneNumbersInText).
│   └── _validators.ts                 NEW   : hand-ported IBAN mod-97, Verhoeff,
│                                              DEA, BTC base58. Reuses existing
│                                              luhnCheck() from registry. ~150 LoC.
├── pii-vault.ts                       EXTEND: PIIToken.confidence (additive).
├── pii-audit.ts                       EXTEND: PIIAuditEntry.confidence/recognizer.
└── streaming-pii-buffer.ts            EXTEND: pass confidence/recognizer through
                                              chunk results. Telemetry seam stays
                                              in the runtime caller (compiler must
                                              not import runtime trace infra).

apps/runtime/src/
├── routes/project-runtime-config.ts   EXTEND: Zod schema accepts new fields;
│                                              GAP-010 z.enum on packs.
├── routes/pii-patterns.ts             EXTEND: POST /test response: confidence + recognizer.
├── services/pii/
│   ├── session-pii-context.ts         EXTEND: RuntimePIIRedactionConfig,
│   │                                          ProjectPIIRedactionConfig,
│   │                                          RuntimePIIProjectSnapshot,
│   │                                          mapProjectPIIRedactionConfig() —
│   │                                          all four interfaces extended with
│   │                                          tier / latencyBudgetMs /
│   │                                          confidenceThreshold /
│   │                                          enabledRecognizerPacks.
│   └── pattern-loader.ts              EXTEND: registerEnabledPacks() before
│                                              loadProjectPIIPatterns().
├── services/execution/
│   ├── output-pii-filter.ts           EXTEND: confidence_threshold filter +
│   │                                          performance.now() telemetry.
│   └── pii-llm-redaction.ts           EXTEND: performance.now() telemetry around
│                                              vault tokenize.
└── services/observability/
    └── pii-telemetry.ts               NEW   : tiny helper recordPIIDetectLatency
                                              (entry_point, tier, pack?, recognizer?, ms).
                                              Wraps existing trace channel.

packages/database/src/models/
├── project-runtime-config.model.ts    EXTEND: IPIIRedactionConfig adds 4 fields
│                                              with Mongoose defaults.
├── pii-audit-log.model.ts             EXTEND: confidence?, recognizer? (additive,
│                                              not indexed).
└── pii-token-vault.model.ts           EXTEND: confidence? (additive).

packages/shared/src/validation/
└── project-runtime-config.ts          EXTEND: piiRedactionConfigSchema adds
                                              tier/budget/threshold/packs with
                                              Zod enum on packs (GAP-010).

packages/constructs/.../trace-scrubber.ts        FIX: default to singleton.
packages/.../cel-functions.ts                    FIX: default to singleton.
packages/.../guardrails/action-executors.ts      FIX: default to singleton.
   (All three guarded by PII_BYPASS_FIX_ENABLED env for rollback — default `true`, set `false` to revert to legacy bypass.)
```

### 3.4 Data Flow

**Pack registration on session bootstrap:**

```
PATCH runtime-config.pii_redaction.enabled_recognizer_packs = ['core','eu']
    │
    ▼
bumpPIIConfigEpoch(tenantId, projectId)             ← already wired (project-runtime-config.ts:491-492)
    │
    ▼ (next session message)
session-pii-context.ts: resolveProjectPIISnapshot
    │
    ▼
createRecognizerRegistry()                          ← built-ins via registerBuiltInRecognizers
    │
    ▼
registerEnabledPacks(['core','eu'], registry)       ← NEW — for each pack name, call
                                                       packModule.register(registry).
                                                       Each pack registers its
                                                       recognizers with permanent: true.
    │
    ▼
loadProjectPIIPatterns(tenantId, projectId, registry)  ← existing, custom patterns last
    │
    ▼
session.piiVault.setRecognizerRegistry(registry)
```

**Detection at any entry point (sync path, unchanged shape):**

```
text → registry.detectAll(text)
       ├── for each registered RegexPIIRecognizer:
       │     → re.exec loop
       │     → optional validate(match)            (Luhn, IBAN mod-97, Verhoeff, …)
       │     → applyContextBoost(text, match, contextWords, baseConfidence, contextBoost)
       │            → confidence = baseConfidence  if no context word in window
       │            → confidence = min(1.0, baseConfidence + contextBoost) otherwise
       │     → push PIIDetection { type, start, end, confidence, recognizer: name }
       └── removeOverlaps(detections)              ← prefer higher confidence on ties
```

**Async detection (forward-compat for WS-3 GLiNER, no async recognizers ship in this spec):**

```
text → registry.detectAllAsync(text, { latencyBudgetMs })
       ├── sync results ← detectAll(text)         (returns immediately; no timer)
       ├── async results ← Promise.all(asyncRecognizers.map(r => r.detectAsync(text)))
       │                    wrapped via in-house withTimeout(asyncPromise, latencyBudgetMs)
       │                    on timeout → emit pii.detect.degraded {reason: 'async_budget_exceeded'}
       └── merged via removeOverlaps(sync ∪ async)
```

**Latency telemetry at each entry point (FR-8):**

```
caller wraps detection call:
    const start = performance.now();
    const result = registry.detectAll(text);
    recordPIIDetectLatency({
      entry_point: 'nlu_guard' | 'vault_tokenize' | 'output_filter' | 'streaming_chunk',
      tier, pack?, recognizer?, ms: performance.now() - start,
    });
```

This re-uses the existing `performance.now()` idiom from `builtin-pii.ts:24-39` rather than introducing a new instrumentation library.

### 3.5 Sequence — PATCH config → mid-session pack switch

```
Studio                Runtime-config route       Mongo               session-pii-context
  │   PATCH packs        │                          │                       │
  │ ────────────────────►│                          │                       │
  │                      │ Zod validate (GAP-010)   │                       │
  │                      │ findOneAndUpdate         │                       │
  │                      │ ────────────────────────►│                       │
  │                      │ bumpPIIConfigEpoch       │                       │
  │                      │ (existing wiring)        │                       │
  │ ◄── 200 OK ──────────│                          │                       │
  │                                                                         │
                          (next user message in session)                    │
                                                                            │
Session refresh ── refreshSessionPIIContext ─────────────────────────────► resolveProjectPIISnapshot
                                                                            │
                                                                            ▼
                                                          read epoch (cache miss)
                                                          read ProjectRuntimeConfig
                                                          createRecognizerRegistry
                                                          registerEnabledPacks(['core','eu'])
                                                          loadProjectPIIPatterns
                                                          session.piiVault.setRecognizerRegistry
                                                                            │
                                                          ▼ subsequent detections honor 'eu' pack
```

---

## 4. The 12 Architectural Concerns

### Structural

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | All new fields live under `project_runtime_configs.pii_redaction`, which inherits the existing `{tenantId, projectId}` filter at the Mongoose layer. Audit log entries (`pii_audit_logs`) and vault entries (`pii_token_vault`) keep their `tenantIsolationPlugin`; the new optional `confidence`/`recognizer`/(vault)`confidence` fields are siblings on tenant-scoped documents, not new collections. Cross-tenant access continues to return **404** (CLAUDE.md Core Invariant #1). Pack code is platform-shipped — pack selection is configuration, never tenant-derived data.                                                                                                                                                                                                                                               |
| 2   | **Data Access Pattern** | Read path: `ProjectRuntimeConfig.findOne({_id: projectId, tenantId})` already used by `session-pii-context.ts`. Write path: existing PATCH route at `apps/runtime/src/routes/project-runtime-config.ts:341` with Zod validation + `findOneAndUpdate`. Caching: existing snapshot cache keyed by `{tenantId, projectId, epoch}`; epoch bumped on any `pii_redaction` change (already wired). No new repository, no new cache layer.                                                                                                                                                                                                                                                                                                                                                                                               |
| 3   | **API Contract**        | Two existing routes extended additively, no new routes: PATCH `/api/projects/:projectId/runtime-config` accepts new optional `tier`, `latency_budget_ms`, `confidence_threshold`, `enabled_recognizer_packs` fields under `pii_redaction`; POST `/api/projects/:projectId/pii-patterns/test` adds `confidence` and `recognizer` to the response payload. Error envelope unchanged: `{ success, data?, error?: { code, message, issues? } }`; GAP-010 (unknown pack name) closes via a Zod `z.enum([...])` constraint on `enabled_recognizer_packs`, producing the existing `VALIDATION_ERROR` code with the offending pack name carried in `error.issues` (precedent at `project-runtime-config.ts:58-69`). No new error code introduced. Response shape backward-compatible — clients ignoring the new fields continue to work. |
| 4   | **Security Surface**    | No new auth surface — existing `requirePermission('runtime_config:write')` and `requirePermission('pii-pattern:write')` middleware on the touched routes. No new credentials, secrets, or external calls. **ReDoS posture (Concern 6)**: pack patterns reviewed against existing `CATASTROPHIC_BACKTRACKING_PATTERNS` heuristic from `pattern-service.ts`; UT-6 adversarial corpus enforces ≤ 50 ms per pattern at unit-test layer. **Input validation**: Zod `enum` validator on `enabled_recognizer_packs` rejects unknown pack names at the API boundary with HTTP 400 (GAP-010 closed at API layer). Pack code is platform-only — never tenant-supplied — so no new arbitrary-regex compile path is introduced.                                                                                                              |

### Behavioral

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | Three failure modes documented and bounded: (a) **unknown pack name** → API returns 400 `VALIDATION_ERROR` (existing code) via Zod `z.enum([...])`, with the offending pack name carried in `error.issues`; session-bootstrap path treats unknown names as no-op + operator warning (UT-7) so an outdated pod doesn't crash on a new pack name added by a newer pod. (b) **regex throws inside `RegexPIIRecognizer.detect()`** → caught at the registry, recognizer suppressed for the remainder of the request, `pii.detect.degraded {reason: 'recognizer_threw'}` emitted, other recognizers continue (INT-13). (c) **async budget exceeded** → sync results returned immediately; pending async results discarded; `pii.detect.degraded {reason: 'async_budget_exceeded'}` emitted (INT-5). All three preserve the user-facing path — no PII detection failure is propagated as an HTTP error from a chat session.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 6   | **Failure Modes** | Latency-budget enforcement uses the **in-house `withTimeout(promise, ms)` pattern** already established in `packages/agent-transfer/src/session/transfer-session-store.ts:45`, `packages/arch-ai/src/session/file-store-service.ts:241`, `packages/shared/src/repos/external-agent-config-repo.ts:265`, and three other call sites — no `cockatiel` or other resilience library is introduced. The pattern is: `Promise.race([promise, timeoutPromise])` with the timeout rejecting after `ms`. **Cleanup invariant** — the version of `withTimeout` used by `detectAllAsync` MUST clear its `setTimeout` handle on the success path (`promise.then(...).finally(() => clearTimeout(timer))`); otherwise, on a high-throughput pod making hundreds of detection calls per second, orphan timers accumulate as a slow leak. The existing call sites are lower throughput (Redis ops) and have not surfaced the leak; this is the higher-throughput consumer that forces the cleanup. The LLD must enforce this in the helper or inline the cleaned-up form. Per-pattern execution timeout (GAP-009) is **explicitly deferred** with the ReDoS adversarial test (UT-6) as primary mitigation in this revision. Sync recognizers always return before the budget timer can fire — sync-path latency is bounded by ReDoS testing, not by the async budget.                                                                                                                                                                                                                                                                                               |
| 7   | **Idempotency**   | PATCH on `runtime-config` is idempotent at the field level (same input → same stored shape). Detection is a pure function of `(text, registry-state)`; same inputs → same detections (modulo iteration order, which `removeOverlaps` already normalizes). Pack registration is idempotent because the registry's `register()` rejects duplicate names. No retry safety concerns introduced beyond the existing config-update path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 8   | **Observability** | New trace dimension `pii.detect.latency_ms` emitted at the entry points that have production callers — **NLU guard** (`pii-guard.ts`), **vault tokenize** (`pii-llm-redaction.ts`), and **output filter** (`output-pii-filter.ts`) — with sub-dimensions `{entry_point, tier, pack?, recognizer?}`. The fourth entry point listed in feature-spec FR-8, **streaming chunk** (`StreamingPIIBuffer.processChunk`), is _exported and unit-tested_ but has **no production caller** today (verified via grep across `apps/runtime/src/` and `packages/compiler/src/platform/` excluding tests and `dist/`). FR-8's streaming-buffer instrumentation is therefore deferred until the streaming caller is wired — the LLD ships the `StreamingPIIChunkResult` confidence/recognizer fields and the buffer-side hook surface, but the `entry_point='streaming_chunk'` trace event has no emit site in this revision. Wiring the streaming caller is **out of scope** for this HLD — to be picked up by a follow-up that closes the streaming-pipeline production integration. New trace event `pii.detect.degraded` emitted on async timeout, regex throw, or unknown-pack warning. Audit log gains `confidence` + `recognizer` for compliance reporting. **Drift signals** (per AWS Comprehend Service Card and Databricks LogSentinel guidance) — per-recognizer detection volume rolled up by hour/day, ratio of detections above vs below threshold, and a concentration alert when any single recognizer dominates a project's detections — are recorded as a follow-up; the primitives ship now. No new dashboard or alert is introduced in this HLD. |

### Operational

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 9   | **Performance Budget** | Targets per feature-spec §12: STANDARD-tier **p95 ≤ 5 ms, p99 ≤ 10 ms per detection entry point** on a typical 4-core runtime pod. The 5 ms budget applies to **typical chat-message payloads (1–2 KB)**, not to the worst-case 10 KB messages — at 10 KB and ~40 patterns, IBM's `mcp-context-forge` benchmark predicts ~30 ms naive, which exceeds the budget. The HLD therefore commits to **two budget tiers**: (i) p95 ≤ 5 ms on payloads ≤ 2 KB (the dominant traffic shape), and (ii) p95 ≤ 30 ms on payloads up to 10 KB (ceiling, well under the 200 ms async budget). **Mitigations**: (a) regex pre-compilation is preserved (existing `RegexPIIRecognizer.detect()` clones the compiled `regex.source` per call — does not re-`new RegExp` from a string each time); (b) `confidence_threshold` filtering provides an early-exit knob per project — when a recognizer's `baseConfidence` is below the project's threshold, the registry can skip it entirely (LLD detail); (c) `recognizer-packs.bench.ts` microbenchmark suite gates the build at the documented budgets per pack at 100/500/1000/5000-character payloads (test-spec §6); (d) per-request `latency_budget_ms` (default 200 ms) on async path. Memory overhead bounded by raised `MAX_RECOGNIZERS = 100` cap. No throughput regression budget committed in this revision; saturation re-run via `saturation-finder` before BETA per delivery plan. |
| 10  | **Migration Path**     | **No data migration scripts.** All new fields (`tier`, `latency_budget_ms`, `confidence_threshold`, `enabled_recognizer_packs` on runtime config; `confidence`, `recognizer` on audit/vault) are additive with documented Mongoose-level defaults. Read-time defaults applied via `mapProjectPIIRedactionConfig()` in `session-pii-context.ts` (existing `??` fallback pattern extended). Legacy documents missing the new fields resolve to `tier='basic'`, `enabled_recognizer_packs=['core']` — preserving today's 5-recognizer behavior byte-for-byte (see migration note below). Audit/vault entries written before this spec lacks `confidence`/`recognizer`; no backfill (feature spec GAP-006). The `core` pack adopts the **13–19 digit + Luhn** credit-card pattern from `pii-detector.ts`, which is broader than the registry's current 16-digit-only pattern — this is a **detection-expanding bug fix** documented in §11.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 11  | **Rollback Plan**      | Three independent rollback levers, none requiring a code deploy: (a) **per-project config**: setting `enabled_recognizer_packs = ['core']` on any project disables all STANDARD packs for that project (live, takes effect at the next epoch refresh). (b) **per-project tier**: setting `tier = 'basic'` is the doc-level intent flag; runtime treats it as equivalent to `enabled_recognizer_packs = ['core']` if both are set. (c) **per-pod env var `PII_BYPASS_FIX_ENABLED=false`**: causes `trace-scrubber.ts`, `cel-functions.ts`, and `action-executors.ts` to revert to passing `undefined` for the registry parameter (legacy bypass behavior), preserving today's behavior on those three surfaces if a custom pattern surfaced via the new path causes an incident. The env var defaults to `true` (fix-enabled, matching the runtime's existing `*_ENABLED` naming convention; unset is treated as `true`). The env var is a temporary lever; remove after one stable release cycle. **Code rollback** (revert the commit) is also clean because all changes are additive and the `pii_redaction` Mongoose subdocument default is `() => ({})`.                                                                                                                                                                                                                                                                   |
| 12  | **Test Strategy**      | Authoritative test plan: [`docs/testing/sub-features/pii-detection-tiered-recognizers.md`](../../testing/sub-features/pii-detection-tiered-recognizers.md). 8 E2E (incl. 1 regression + 1 error-path), 13 integration, 8 unit + 1 benchmark. **No mocking of `@agent-platform/*` or `@abl/*`.** E2E uses real Express + `MongoMemoryServer` + auth via `RuntimeApiHarness`; seed via API, assert via API. Integration tests for the registry-bypass fix (INT-1…INT-4) instantiate a real `PIIRecognizerRegistry`, register a project pattern, and assert the registry is honored on every detection surface. Pure-JS deps (`libphonenumber-js`) run live; never module-level mocked. INT-5 uses dependency injection (constructor-injected synthetic async recognizer) — not module mocking. ReDoS gating in UT-6 with 50 adversarial payloads per pack. Field-propagation regression in INT-7/INT-8 covers the four-interface chain in `session-pii-context.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

---

## 5. Data Model

> **Terminology — two unrelated uses of "tier"**: (a) **project tier** — `basic|standard|advanced|maximum`, the project-config capability level chosen by builders; (b) **recognizer tier** — `regex|ml|custom|cloud`, the existing classification on each `PIIRecognizer` instance used for priority ordering inside `removeOverlaps()`. The two never collide in code (different field names on different objects); the LLD must keep them lexically distinct.

### 5.1 Modified collections

```text
project_runtime_configs (existing collection, sub-document extended)
  pii_redaction:
    enabled              boolean                     (existing, default true)
    redact_input         boolean                     (existing, default true)
    redact_output        boolean                     (existing, default false)
    tier                 'basic'|'standard'|'advanced'|'maximum'  NEW, default 'basic'
    latency_budget_ms    number                                   NEW, default 200
    confidence_threshold number                                   NEW, default 0.5  (range 0.0–1.0)
    enabled_recognizer_packs string[]                             NEW, default ['core']
                              (Zod enum: core|us|eu|apac|financial|medical|network|international-phone)
  Indexes: unchanged.
  Mongoose schema default: { type: PIIRedactionConfigSchema, default: () => ({}) }
                           — preserved; child schema defaults fill missing fields.
```

```text
pii_audit_logs (existing TTL collection)
  confidence  number?  NEW, optional, range 0.0–1.0, written on new entries only
  recognizer  string?  NEW, optional, e.g. 'core-email', 'iban', 'ap-aadhaar'
  Indexes: unchanged. New fields not indexed (audit reads are time-bounded scans).
  TTL: unchanged (90 days, inherited from parent feature).
```

```text
pii_token_vault (existing encrypted collection)
  confidence  number?  NEW, optional — captured at tokenization for audit provenance.
  Indexes: unchanged.
```

### 5.2 New in-process types (no DB shape)

`PIIDetection` (in `packages/compiler/src/platform/security/pii-detector.ts`) gains two additive fields:

```ts
interface PIIDetection {
  type: PIIType;
  start: number;
  end: number;
  confidence: number; // NEW — required, defaults to 1.0 for legacy regex matches
  recognizer?: string; // NEW — optional, recognizer.name, e.g. 'core-email'
}
```

`RegexPIIRecognizer` constructor widens additively (existing call sites compile unchanged):

```ts
class RegexPIIRecognizer {
  constructor(
    name: string,
    supportedTypes: PIIType[],
    regex: RegExp,
    piiType: PIIType,
    validate?: (m: string) => boolean,
    tier: RecognizerTier = 'regex',
    config?: {
      // NEW — optional bag for context-word boost
      contextWords?: string[];
      contextBoost?: number; // default 0.35
      baseConfidence?: number; // default 1.0
      contextWindowTokens?: number; // default 12
    },
  ) {}
}
```

`MAX_RECOGNIZERS` constant in `pii-recognizer-registry.ts` raised from **50 → 100** to provide headroom for ~45 permanent (5 built-ins + ~40 pack) plus ~50 custom patterns per project overlay. Pack recognizers register with `permanent: true`, so they cannot be evicted by custom-pattern overflow.

### 5.3 Key relationships

- `project_runtime_configs._id == ProjectId`. A change in `pii_redaction` triggers `bumpPIIConfigEpoch(tenantId, projectId)` (already wired); the existing snapshot cache invalidation governs propagation latency.
- `pii_audit_logs` rows continue to reference `(tenantId, projectId, sessionId, messageId)`; new fields are siblings on the same document.
- `PIITokenVault` entries remain keyed on `(tenantId, sessionId, tokenId)`; `confidence` is metadata only.

---

## 6. API Design

### 6.1 New endpoints

**None.** This sub-feature ships zero new HTTP routes.

### 6.2 Modified endpoints

| Method | Path                                         | Change                                                                                                                                                                                                                                                                                                        |
| ------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PATCH  | `/api/projects/:projectId/runtime-config`    | Body's `pii_redaction` accepts new optional fields `tier`, `latency_budget_ms`, `confidence_threshold`, `enabled_recognizer_packs`. Zod validator: pack list constrained to `z.enum(['core','us','eu','apac','financial','medical','network','international-phone'])`. Existing auth: `runtime_config:write`. |
| GET    | `/api/projects/:projectId/runtime-config`    | Response body's `pii_redaction` always includes the four new fields with defaults (via `normalizeConfig()`).                                                                                                                                                                                                  |
| POST   | `/api/projects/:projectId/pii-patterns/test` | Response payload extended: each detected hit carries `confidence` (number) and `recognizer` (string). Existing auth: `pii-pattern:read`.                                                                                                                                                                      |
| GET    | `/api/projects/:projectId/pii-patterns`      | Unchanged.                                                                                                                                                                                                                                                                                                    |

### 6.3 Error responses

Existing envelope `{ success: false, error: { code, message } }`. New error code:

| Code                          | HTTP | Trigger                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VALIDATION_ERROR` (existing) | 400  | PATCH includes a pack name outside the `z.enum([...])` Zod constraint on `enabled_recognizer_packs`. Body keeps the existing envelope `{ success: false, error: { code: 'VALIDATION_ERROR', message, issues } }` — `issues` (already produced by the `onValidationError` handler at `apps/runtime/src/routes/project-runtime-config.ts:58-69`) carries the offending pack name(s) under `path = ['pii_redaction', 'enabled_recognizer_packs', N]`. The valid packs in the same request are **not** silently applied — the entire PATCH is rejected. |

**Decision: GAP-010 closes via Zod `z.enum([...])` on `enabled_recognizer_packs`, not via a pre-Zod custom validator.** This reuses the existing `VALIDATION_ERROR` + `issues` pipeline, matches the Zod-validation precedent already in the route, and avoids introducing a parallel validation step. The feature spec's proposed `INVALID_RECOGNIZER_PACK` error code is not introduced — `VALIDATION_ERROR` is sufficient and consistent with the rest of the route. (E2E-ERR-1 in the test spec asserts the rejection at the HTTP boundary; it does not bind to a specific custom code, so this decision is compatible.)

Existing codes (`VALIDATION_ERROR`, `TENANT_ACCESS_DENIED`, `NOT_FOUND`, `INTERNAL_ERROR`) keep current meaning.

---

## 7. Cross-Cutting Concerns

| Concern            | Decision                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Audit Logging**  | Every detection write to `pii_audit_logs` carries `confidence` + `recognizer` going forward. Legacy entries remain unbackfilled (GAP-006).                                           |
| **Rate Limiting**  | Existing `tenantRateLimit('request')` middleware on the touched routes is unchanged. Detection itself is on the request path and inherits per-request rate limits.                   |
| **Caching**        | Existing `ProjectRuntimeConfig` snapshot cache (keyed by `{tenantId, projectId, epoch}`) — invalidated by existing `bumpPIIConfigEpoch` on any `pii_redaction` change. No new cache. |
| **Encryption**     | Existing AES-256-GCM tenant-keyed encryption on vault unchanged. Pack code is platform-shipped, not encrypted at rest.                                                               |
| **Tenant context** | All routes already use `getTenantId(req)` from `req.tenantContext`. No new tenant context plumbing.                                                                                  |

---

## 8. Dependencies

### 8.1 Upstream — what this feature consumes

| Dependency                                                                   | Type                     | Where                                                                                                                                                                                              | Risk                                                                                                                                               |
| ---------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PIIRecognizerRegistry` (`packages/compiler/security`)                       | Internal — reused        | `pii-recognizer-registry.ts:13-118`                                                                                                                                                                | None — stable API, additive extension                                                                                                              |
| `RegexPIIRecognizer` (same file)                                             | Internal — reused        | `pii-recognizer-registry.ts:120-154`                                                                                                                                                               | None — additive constructor parameter                                                                                                              |
| `getDefaultPIIRecognizerRegistry()` singleton                                | Internal — reused        | `pii-recognizer-registry.ts:261-267`                                                                                                                                                               | None                                                                                                                                               |
| `loadProjectPIIPatterns()`                                                   | Internal — reused        | `apps/runtime/src/services/pii/pattern-loader.ts:60-176`                                                                                                                                           | None — pack registration slots in _before_ this call                                                                                               |
| `bumpPIIConfigEpoch`                                                         | Internal — reused        | `apps/runtime/src/services/pii/pii-epoch.ts:56-85`; PATCH route already calls it at `project-runtime-config.ts:491-492`                                                                            | None                                                                                                                                               |
| `mapProjectPIIRedactionConfig()`                                             | Internal — extended      | `apps/runtime/src/services/pii/session-pii-context.ts:42-48`                                                                                                                                       | LOW — four-field additive extension; INT-7/INT-8 enforce parity                                                                                    |
| `luhnCheck()`                                                                | Internal — reused        | `pii-recognizer-registry.ts:170-190`                                                                                                                                                               | None                                                                                                                                               |
| `libphonenumber-js` (`findPhoneNumbersInText`, `parsePhoneNumberFromString`) | External — already a dep | `packages/compiler/src/platform/utils/phone-extraction.ts:11-16`                                                                                                                                   | None — `international-phone` pack delegates to `phone-extraction.ts`, no new direct usage                                                          |
| In-house `withTimeout(promise, ms)` pattern                                  | Internal — reused        | `packages/agent-transfer/src/session/transfer-session-store.ts:45-52`; `packages/arch-ai/src/session/file-store-service.ts:241`; `packages/shared/src/repos/external-agent-config-repo.ts:265-275` | LOW — extracted to a small shared utility under `packages/compiler/src/platform/security/_with-timeout.ts` (or reused inline) for `detectAllAsync` |
| `performance.now()` telemetry idiom                                          | Internal — reused        | `packages/compiler/src/platform/guardrails/providers/builtin-pii.ts:24-39`                                                                                                                         | None                                                                                                                                               |
| `CATASTROPHIC_BACKTRACKING_PATTERNS` ReDoS heuristic                         | Internal — reused        | `apps/runtime/src/services/pii/pattern-service.ts`                                                                                                                                                 | None                                                                                                                                               |
| Existing trace channel                                                       | Internal — reused        | shared/runtime trace plumbing                                                                                                                                                                      | None                                                                                                                                               |

### 8.2 New runtime dependencies

**None.** Feature-spec §11 originally proposed `validator` (^13), `cockatiel` (^3), and `@types/validator`; this HLD removes all three. Justification:

| Originally proposed dep                         | Capability                    | Replacement in this HLD                                                            |
| ----------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------- |
| `cockatiel.Policy.timeout()`                    | Async timeout                 | In-house `withTimeout(promise, ms)` pattern, used in 5+ files today                |
| `validator.isLuhnNumber`                        | Luhn check                    | Existing `luhnCheck()` at `pii-recognizer-registry.ts:170`                         |
| `validator.isCreditCard`                        | Credit card                   | Existing Luhn + 13–19 digit regex (after `core` pack alignment)                    |
| `validator.isMobilePhone`                       | International phone           | Existing `libphonenumber-js` via `phone-extraction.ts`                             |
| `validator.isIP`                                | IPv4/IPv6                     | Existing IPv4 regex; new IPv6 regex in `network` pack                              |
| `validator.isIBAN`                              | IBAN mod-97                   | Hand-port mod-97 to `_validators.ts` (~25 LoC)                                     |
| `validator.isPassportNumber('GB' \| 'US' \| …)` | Passport per country          | Hand-port the ~10 country regex+validator pairs we actually need to per-pack files |
| `validator.isIdentityCard('IN' \| 'SG' \| …)`   | Identity card                 | Same as passport — pack-local regex + checksum                                     |
| `validator.isTaxID('en-US' \| 'de-DE' \| …)`    | Tax ID per locale             | Same — pack-local                                                                  |
| `validator.isBtcAddress`                        | Bitcoin address               | Hand-port base58-check (~15 LoC) in `_validators.ts`                               |
| Aadhaar Verhoeff                                | (validator.js does not cover) | Hand-port Verhoeff (~30 LoC) in `_validators.ts` (already in feature spec)         |
| DEA checksum                                    | (no validator.js coverage)    | Hand-port (~10 LoC) in `_validators.ts` (already in feature spec)                  |

Total hand-port scope: ~150 LoC of validators in `_validators.ts` plus per-pack regex tables. Net result: zero new transitive runtime dependencies, stronger ReDoS posture (we own and can lint every regex), no exposure to `validator.js` upstream regex changes.

### 8.3 Downstream — who depends on this feature

| Consumer                                                         | Impact                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sibling cloud-tier sub-feature (`pii-detection-enhancements.md`) | Inherits `confidence`/`recognizer` fields, `detectAllAsync`, the four-field `IPIIRedactionConfig` extension, and the registry-bypass fixes. Whichever spec lands Foundation first owns these interfaces. Open Question 6 in the feature spec asks how to lock parity — see §11 below. |
| Future GLiNER sidecar (WS-3)                                     | Will register an async recognizer via the new `detectAllAsync` path; existing sync recognizers untouched.                                                                                                                                                                             |
| Existing `BuiltinPIIProvider` guardrail                          | Score derivation gains `confidence`-aware logic in WS-2 (currently binary 1.0 / 0.0 — extends to threshold-aware per project config).                                                                                                                                                 |
| Existing `streaming-pii-buffer.ts` consumers                     | Receive `confidence`/`recognizer` on `StreamingPIIChunkResult` (additive).                                                                                                                                                                                                            |
| Existing `pii-audit.ts` audit-log readers                        | Receive `confidence`/`recognizer` on `PIIAuditEntry` (additive).                                                                                                                                                                                                                      |

---

## 9. Open Questions & Decisions Needed

1. **Foundation-first parity with sibling spec** (feature spec OQ-6). Both this sub-feature and `pii-detection-enhancements.md` need WS-1 prerequisites — `confidence`/`recognizer`, `detectAllAsync`, `IPIIRedactionConfig` extensions, and registry-bypass fixes. Recommendation: **whichever spec ships Foundation first owns the canonical interfaces; the second spec consumes them unchanged via `/post-impl-sync` parity check**. No shared "PII Foundation" extraction needed at this point — the surface is small enough.
2. **Tenant-level cap on packs** (feature spec OQ-2 / GAP-004). Out of scope for this spec; flagged for a future governance sub-feature. Decision deferred.
3. **Context-boost default `0.35`** (feature spec OQ-3). Adopted from Presidio's `LemmaContextAwareEnhancer`. Reviewable after empirical FP/FN data from STANDARD-tier rollout. Not re-litigated here.
4. **IPv6 pack placement** (feature spec OQ-4). HLD adopts the audit doc's choice: IPv6 lives in the **`network`** pack, not `core`. Projects that need IPv6 detection enable `network` (a one-line `enabled_recognizer_packs` change). Rationale: keeps `core` byte-for-byte equivalent to today's legacy 5-recognizer set.
5. **Per-pack rollout flag** (feature spec OQ-5). HLD does not introduce a global "registry-bypass-fix disable" flag separately from `PII_BYPASS_FIX_ENABLED` (Concern 11). The env var is per-pod and toggles all three call sites uniformly — sufficient for incident rollback.
6. **Per-entity-type confidence threshold overrides** (feature spec OQ-9). Out of scope. The single project-level `confidence_threshold` is sufficient for v1; per-entity overrides can be added additively in a follow-up without breaking this spec's API.
7. **Tier naming** (feature spec OQ-10). HLD keeps `basic`/`standard`/`advanced`/`maximum` for backward compatibility with the audit doc and the sibling spec. Studio UX may rename; runtime API stays stable.
8. **`detectAllAsync` keep vs defer** (feature spec OQ-11). Decision: **keep**. Cost is ~30 LoC for the registry method using the in-house `withTimeout` pattern; `cockatiel` is no longer in the picture so there is no orphan dependency cost. UT-8 + INT-5 cover both the sync-only path and the synthetic-async timeout path.
9. **Per-pattern execution timeout (GAP-009)**. Deferred. Primary mitigation: UT-6 (50 adversarial payloads per pack, 50 ms wall-time limit per pattern) + ReDoS heuristic at PR review. A future sub-feature can layer per-pattern timeouts inside `RegexPIIRecognizer.detect()` without breaking this HLD.
10. **Golden corpus storage** (test-spec OQ-4). HLD recommends programmatic generation with a deterministic seed under `packages/compiler/src/__tests__/security/fixtures/`, not committed JSON files. Keeps repo size flat.

---

## 10. Migration Notes

### 10.1 Behavioral changes vs. legacy

| Surface                                                 | Legacy behavior                                                                                                                                                                            | After this HLD                                                                                                                                                                          | Net change                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `detectPII`/`redactPII`/`containsPII` (no registry arg) | In-file `detectWithLocalPatterns()` with 5 hardcoded patterns                                                                                                                              | Routes through `getDefaultPIIRecognizerRegistry()` → `core` pack                                                                                                                        | **Detection-expanding** on two patterns (see next two rows). All other entity types: byte-for-byte identical to today.                                                                                                                                                                                                                                                                                            |
| Credit-card pattern (NLU-guard path via registry)       | 16-digit only, 4×4 format with separators (registry); 13–19 digits + Luhn (`pii-detector.ts`)                                                                                              | Unified on 13–19 digits + Luhn in `core` pack                                                                                                                                           | **Detection-expanding bug fix** — registry-side path now catches Amex (15-digit) and old Visa (13-digit). Luhn validator gates precision; FP risk minimal.                                                                                                                                                                                                                                                        |
| SSN pattern (NLU-guard path)                            | Dashed only (`123-45-6789`) at `pii-detector.ts:62` and registry built-in                                                                                                                  | Dashed **and** undashed (`123456789`) in `core` pack                                                                                                                                    | **Detection-expanding** — closes documented bug (feature spec §1). Undashed 9-digit numbers without context can produce FPs (any 9-digit ID/order number); confidence-threshold + context-word boosting on neighbouring "SSN"/"social security" mitigate. Operators should monitor `pii.detect.degraded` and the per-recognizer detection-volume drift signal during the first week of `tier='standard'` rollout. |
| `trace-scrubber.ts`                                     | Bypass: 5 hardcoded patterns; custom patterns silently ignored                                                                                                                             | Honors registry singleton; custom patterns reach this surface                                                                                                                           | **Closes silent-data-leak bug** for projects with custom patterns                                                                                                                                                                                                                                                                                                                                                 |
| `cel-functions.ts` (`abl.has_pii`, `abl.redact_pii`)    | Same bypass as above                                                                                                                                                                       | Honors singleton                                                                                                                                                                        | Same                                                                                                                                                                                                                                                                                                                                                                                                              |
| `action-executors.ts` (redact / fix actions)            | Same bypass                                                                                                                                                                                | Honors singleton                                                                                                                                                                        | Same                                                                                                                                                                                                                                                                                                                                                                                                              |
| `builtin-pii.ts` guardrail provider                     | Calls `detectPII(content, request.context?.piiRecognizerRegistry)` — when context registry is `undefined` (e.g. caller plumbing gap) the call falls through to `detectWithLocalPatterns()` | **Transitively fixed by FR-3** — `detectPII()` now defaults to `getDefaultPIIRecognizerRegistry()` when its second argument is undefined; no change required to `builtin-pii.ts` itself | **Closes a fourth bypass surface** transitively. No separate code change in `builtin-pii.ts`; the FR-3 unification is sufficient. Plumbing audit: registry is supplied via `pipeline.ts:595` (`context.piiRecognizerRegistry ?? this.piiRecognizerRegistry`); both branches are now safe even if undefined.                                                                                                       |
| Audit log entries                                       | `confidence`/`recognizer` absent                                                                                                                                                           | Present on new entries                                                                                                                                                                  | Additive — readers ignoring the fields unaffected                                                                                                                                                                                                                                                                                                                                                                 |
| Vault entries (`PIITokenVault`)                         | `confidence` absent                                                                                                                                                                        | Present on new entries                                                                                                                                                                  | Additive                                                                                                                                                                                                                                                                                                                                                                                                          |

### 10.2 Rollout strategy

1. **Deploy with default config** (`tier='basic'`, `enabled_recognizer_packs=['core']`) — preserves today's behavior on every project. The Foundation refactors take effect immediately; STANDARD packs are opt-in.
2. **Monitor `pii.detect.degraded` and `pii.detect.latency_ms`** for one week before enabling STANDARD on any production project. Ensure p95 stays ≤ 5 ms.
3. **Opt-in STANDARD per project** via PATCH `runtime-config` — start with EU-customer projects (`['core','eu']`), then APAC (`['core','apac']`), then full STANDARD (`['core','us','eu','apac','financial','medical','network','international-phone']`).
4. **`PII_BYPASS_FIX_ENABLED` env var** — leave unset (default = `true` = fix enabled). Deploy with rollback lever ready (set to `false` per pod to revert); remove the lever after one stable release cycle (parent feature `/post-impl-sync` ALPHA→BETA criterion).

### 10.3 No data migration

The feature spec confirms: no migration scripts, no backfill. All new fields apply read-time defaults via `mapProjectPIIRedactionConfig()` (`??` fallback) and Mongoose schema defaults. Legacy `project_runtime_configs` with no `pii_redaction.tier` resolve to `'basic'`. Legacy audit entries without `confidence`/`recognizer` remain valid.

---

## 11. References

- Feature spec: [`docs/features/sub-features/pii-detection-tiered-recognizers.md`](../../features/sub-features/pii-detection-tiered-recognizers.md)
- Test spec: [`docs/testing/sub-features/pii-detection-tiered-recognizers.md`](../../testing/sub-features/pii-detection-tiered-recognizers.md)
- Parent feature: [`docs/features/pii-detection.md`](../../features/pii-detection.md)
- Parent HLD: [`docs/specs/pii-detection.hld.md`](../pii-detection.hld.md)
- Sibling sub-feature: [`docs/features/sub-features/pii-detection-enhancements.md`](../../features/sub-features/pii-detection-enhancements.md)
- Source plan: [`docs/audit/2026-05-08-pii-detection-gap-analysis-and-enhancement-plan.md`](../../audit/2026-05-08-pii-detection-gap-analysis-and-enhancement-plan.md)
- Microsoft Presidio (regex source for porting; MIT): https://github.com/microsoft/presidio
- IBM mcp-context-forge (PII regex performance benchmarks): public benchmarks cited in feature-spec §7
- AWS Comprehend Detect-PII Service Card (drift-signal guidance): https://docs.aws.amazon.com/ai/responsible-ai/comprehend-detectpii/overview.html
- Presidio Evaluation framework (F2-as-primary-metric convention): https://microsoft.github.io/presidio/evaluation/

---

## Appendix A — Library Capability Audit (decision evidence)

This appendix records the audit run during HLD generation that led to the **zero new runtime deps** decision in §8.

| Proposed dep / capability                       | Already-present mechanism                                                              | File / dep                                                                                                                                                                                                         | Verdict                                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `cockatiel.Policy.timeout()` for async budget   | In-house `withTimeout(promise, ms)` (`Promise.race` + `setTimeout`) — used in 5+ files | `packages/agent-transfer/src/session/transfer-session-store.ts:45-52`, `packages/arch-ai/src/session/file-store-service.ts:241`, `packages/shared/src/repos/external-agent-config-repo.ts:265-275`, two more sites | Use existing pattern; do not add `cockatiel`                                |
| `validator.isLuhnNumber`                        | `luhnCheck()` at `pii-recognizer-registry.ts:170`                                      | same file                                                                                                                                                                                                          | Reuse                                                                       |
| `validator.isCreditCard`                        | Existing Luhn + 13–19 digit regex (after FR-3 unification)                             | `pii-detector.ts:67` + Luhn                                                                                                                                                                                        | Reuse                                                                       |
| `validator.isIP`                                | Existing IPv4 regex; new IPv6 in `network` pack                                        | `pii-detector.ts`, registry built-ins                                                                                                                                                                              | Reuse / write IPv6 directly                                                 |
| `validator.isMobilePhone` (per country)         | `libphonenumber-js` `findPhoneNumbersInText` — already a `packages/compiler` dep       | `packages/compiler/src/platform/utils/phone-extraction.ts:11-16`                                                                                                                                                   | Reuse via `phone-extraction.ts`; `international-phone` pack delegates to it |
| `validator.isIBAN`                              | None                                                                                   | —                                                                                                                                                                                                                  | Hand-port mod-97 (~25 LoC) in `_validators.ts`                              |
| `validator.isPassportNumber('GB' \| 'US' \| …)` | None                                                                                   | —                                                                                                                                                                                                                  | Hand-port the ~10 countries we actually need into per-pack files            |
| `validator.isIdentityCard('IN' \| …)`           | None                                                                                   | —                                                                                                                                                                                                                  | Same — pack-local regex + checksum                                          |
| `validator.isTaxID(locale)`                     | None                                                                                   | —                                                                                                                                                                                                                  | Same — pack-local                                                           |
| `validator.isBtcAddress`                        | None                                                                                   | —                                                                                                                                                                                                                  | Hand-port base58-check (~15 LoC) in `_validators.ts`                        |
| Verhoeff (Aadhaar)                              | None                                                                                   | —                                                                                                                                                                                                                  | Hand-port (~30 LoC) — already specified in feature-spec §7                  |
| DEA checksum                                    | None                                                                                   | —                                                                                                                                                                                                                  | Hand-port (~10 LoC) — already specified                                     |
| Latency telemetry                               | `performance.now()` idiom                                                              | `packages/compiler/src/platform/guardrails/providers/builtin-pii.ts:24-39`                                                                                                                                         | Reuse idiom in NLU guard / vault / output filter / streaming buffer callers |
| Recognizer eviction protection                  | `register(rec, { permanent: true })`                                                   | `pii-recognizer-registry.ts:29-55`                                                                                                                                                                                 | Reuse — packs register as `permanent: true`                                 |
| Per-recognizer validator hook                   | `RegexPIIRecognizer.validate?: (m: string) => boolean`                                 | `pii-recognizer-registry.ts:120-128`                                                                                                                                                                               | Reuse — packs supply hand-ported validators here                            |
| ReDoS heuristic                                 | `CATASTROPHIC_BACKTRACKING_PATTERNS`                                                   | `apps/runtime/src/services/pii/pattern-service.ts`                                                                                                                                                                 | Reuse for build-time review of pack patterns                                |
| `pii-epoch` cache invalidation on pack change   | `bumpPIIConfigEpoch` already fires for any `pii_redaction` change                      | `apps/runtime/src/routes/project-runtime-config.ts:491-492`                                                                                                                                                        | No new wiring required                                                      |

**Net: zero new runtime dependencies. ~150 LoC of hand-ported validators in `_validators.ts` versus a 670 KB `validator.js` transitive dep. Stronger ReDoS posture (we own every regex). No exposure to upstream regex changes.**
