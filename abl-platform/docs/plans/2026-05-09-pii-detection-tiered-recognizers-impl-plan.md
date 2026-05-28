# LLD: PII Detection Tiered Recognizers (Foundation + STANDARD Tier)

**Feature Spec**: [`docs/features/sub-features/pii-detection-tiered-recognizers.md`](../features/sub-features/pii-detection-tiered-recognizers.md)
**HLD**: [`docs/specs/sub-features/pii-detection-tiered-recognizers.hld.md`](../specs/sub-features/pii-detection-tiered-recognizers.hld.md)
**Test Spec**: [`docs/testing/sub-features/pii-detection-tiered-recognizers.md`](../testing/sub-features/pii-detection-tiered-recognizers.md)
**Parent Feature**: [`docs/features/pii-detection.md`](../features/pii-detection.md)
**Sibling Sub-Feature** (consumes Foundation contract): [`docs/features/sub-features/pii-detection-enhancements.md`](../features/sub-features/pii-detection-enhancements.md)
**Status**: DONE (Phases 1a–4 complete; Phase 5 partial — bench + 5 E2E deferred to follow-up). 5-round pr-review APPROVED 2026-05-09. See `docs/sdlc-logs/pii-detection-tiered-recognizers/implementation.log.md` for full breakdown.
**JIRA**: ABLP-921
**Author**: GirishAh-Kore
**Date**: 2026-05-09

---

## 1. Design Decisions

### 1.1 Decision Log

| #    | Decision                                                                                                                                                                                                                                                                                                                                                                              | Rationale                                                                                                                                                                                                                                                                                                                                                                           | Alternatives Rejected                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1  | Foundation refactors and the `core` pack land **together** as Phase 1 (split across two commits 1a + 1b).                                                                                                                                                                                                                                                                             | `core` IS the DRY fix target — `registerBuiltInRecognizers()` becomes a thin shim that delegates to `core.register()` (HLD §3.1). FR-3 (remove `detectWithLocalPatterns`) cannot complete without `core`.                                                                                                                                                                           | "Foundation only first, packs later" — leaves `registerBuiltInRecognizers` in an inconsistent state and forces a second compile-pass to retire `builtin-*`. |
| D-2  | Pack delivery split into 3 phases by region/domain affinity: P2 (us + eu), P3 (apac + financial + medical), P4 (network + international-phone).                                                                                                                                                                                                                                       | Each commit stays under the **40-file / 3-package** limit (`commit-scope-guard.sh`). Validator helpers in `_validators.ts` land alongside their first consumer (P3 — Verhoeff for `apac`, DEA for `medical`).                                                                                                                                                                       | Per-pack phases (8) — too many SDLC laps; single-phase pack drop — busts the 40-file limit.                                                                 |
| D-3  | `confidence` is added as a **required** field on `PIIDetection`, but populated centrally by extending the existing `createSafePIIDetection()` factory. The factory is **defined** at `pii-detector.ts:115` (the actual file the implementer modifies) and **called** from `pii-recognizer-registry.ts:68` and 5 other call sites.                                                     | Existing `RegexPIIRecognizer.detect()` instances funnel every match through that factory; extending the factory means **zero changes** to existing recognizer call sites while keeping the type non-optional.                                                                                                                                                                       | Optional `confidence?` (drift risk — caller forgets to populate); breaking change to `PIIRecognizer.detect()` signature (cascades into custom-pattern API). |
| D-4  | `withTimeout` is extracted to `packages/compiler/src/platform/security/_with-timeout.ts` with the **`clearTimeout` cleanup invariant** (HLD §4 Concern 6). Existing leaky sites are NOT migrated.                                                                                                                                                                                     | Both existing implementations (`transfer-session-store.ts:45-52`, `file-store-service.ts:241-248`) leak timers (verified — neither calls `clearTimeout`). Migrating them adds 2 packages → busts 3-pkg limit.                                                                                                                                                                       | Inline in `pii-recognizer-registry.ts` (works but loses reuse); shared package (correct but blows commit scope; defer to follow-up tech-debt ticket).       |
| D-5  | `MAX_RECOGNIZERS` raised from **50 → 100** AND pack recognizers register with `permanent: true`.                                                                                                                                                                                                                                                                                      | Belt-and-suspenders. ~45 permanent (5 built-in + 40 pack) + headroom for ~50 custom patterns. `permanent: true` blocks pack eviction even if a project registers many custom patterns.                                                                                                                                                                                              | Raise cap only (no `permanent`) — eviction order still risks losing pack recognizers under heavy custom-pattern load.                                       |
| D-6  | `registerBuiltInRecognizers()` is preserved as an **export** but rewritten to call `core.register(registry)`. Recognizer names migrate from `builtin-*` to `core-*` going forward; legacy audit-log entries keep their old names.                                                                                                                                                     | Avoids breaking any external import of `registerBuiltInRecognizers`. Audit-log rename is unnecessary because this LLD ships **zero new audit read APIs** (D-8).                                                                                                                                                                                                                     | Hard rename (breaking); compatibility shim that translates names at read time (no read API to fix).                                                         |
| D-7  | Detection-expanding bug fix — the `core` pack adopts the **13-19 digit + Luhn** credit-card pattern (from `pii-detector.ts`) AND **dashed + undashed SSN**. Documented in HLD §10.1.                                                                                                                                                                                                  | Closes the documented divergence (registry today is 16-digit-only and dashed-only SSN). Luhn validator + context-word boost mitigate FP risk on undashed 9-digit inputs.                                                                                                                                                                                                            | Keep registry's narrower pattern (preserves status quo but drops the documented bug fix).                                                                   |
| D-8  | No new audit-log read API in this LLD scope. INT-11 captures via DI on `PIIAuditStore` (constructor-injected test double).                                                                                                                                                                                                                                                            | HLD commits "zero new HTTP routes". Feature-spec OQ-7 frames this as a parent-feature gap. E2E-1 already asserts `confidence`/`recognizer` via the trace API.                                                                                                                                                                                                                       | Add `findByTenantProject` + new route — out of HLD scope; introduces auth-permission decisions.                                                             |
| D-9  | No tenant-level pack allowlist env var. Rollout uses three independent levers: per-project `enabled_recognizer_packs`, per-project `tier`, and per-pod `PII_BYPASS_FIX_ENABLED`.                                                                                                                                                                                                      | HLD §11 settled this; tenant cap is deferred to a future governance sub-feature.                                                                                                                                                                                                                                                                                                    | Tenant-level env var (out of scope per HLD §9 item 2).                                                                                                      |
| D-10 | No DB migration script. Mongoose schema defaults + `mapProjectPIIRedactionConfig()` `??` fallback handle legacy documents at read time.                                                                                                                                                                                                                                               | New fields are not indexed; no read-side query needs the column populated.                                                                                                                                                                                                                                                                                                          | One-time backfill script (unnecessary; adds operational risk).                                                                                              |
| D-11 | Microbenchmarks (`recognizer-packs.bench.ts`) are **non-blocking** in CI. Hard CI gate is the ReDoS adversarial test (UT-6) at 50 ms wall time per pattern.                                                                                                                                                                                                                           | Test-spec §6 commits to non-blocking. Operational p95/p99 targets observed via `pii.detect.latency_ms` in production telemetry, not CI gates.                                                                                                                                                                                                                                       | Blocking benchmark (CI flakiness disproportionate to value).                                                                                                |
| D-12 | The four parallel runtime-side interfaces in `session-pii-context.ts` (`RuntimePIIRedactionConfig`, `ProjectPIIRedactionConfig`, `RuntimePIIProjectSnapshot`, `mapProjectPIIRedactionConfig`) are **all extended additively**. `ProjectPIIRedactionConfig` and `mapProjectPIIRedactionConfig` are also **promoted to exports** so the sibling sub-feature can consume them unchanged. | Verified state: `RuntimePIIRedactionConfig` (line 19) and `RuntimePIIProjectSnapshot` (line 25) are already `export interface`; `ProjectPIIRedactionConfig` (line 31) and `mapProjectPIIRedactionConfig` (line 42) are non-exported locals. Feature-spec §10 explicitly flags propagation. Exporting the remaining two locks the contract per Foundation Stability Contract (§1.4). | Keep non-exported — sibling spec would have to redeclare; field-propagation regression risk doubles.                                                        |

### 1.2 Key Interfaces & Types

```ts
// packages/compiler/src/platform/security/pii-detector.ts
export interface PIIDetection {
  type: PIIType;
  start: number;
  end: number;
  value: string;
  confidence: number; // NEW — required, defaulted to 1.0 by createSafePIIDetection()
  recognizer?: string; // NEW — optional, recognizer.name (e.g. 'core-email', 'eu-iban')
}

// packages/compiler/src/platform/security/pii-recognizer-registry.ts
export interface RegexPIIRecognizerConfig {
  // NEW — exported additive config bag
  contextWords?: string[];
  contextBoost?: number; // default 0.35
  baseConfidence?: number; // default 1.0
  contextWindowTokens?: number; // default 12
}

export class RegexPIIRecognizer implements PIIRecognizer {
  constructor(
    name: string,
    supportedTypes: PIIType[],
    regex: RegExp,
    piiType: PIIType,
    validate?: (m: string) => boolean,
    tier: RecognizerTier = 'regex',
    config?: RegexPIIRecognizerConfig, // NEW — optional, additive
  ) {
    /* … */
  }
}

export class PIIRecognizerRegistry {
  // existing detectAll() unchanged
  detectAllAsync( // NEW
    text: string,
    opts?: { latencyBudgetMs?: number; exemptTypes?: Set<PIIType> },
  ): Promise<PIIDetection[]>;
  // existing register() unchanged
}

// packages/compiler/src/platform/security/_with-timeout.ts (NEW)
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T>;
// MUST clear setTimeout handle on success path (see §4 Concern 6 of HLD)

// packages/compiler/src/platform/security/context-enhancer.ts (NEW)
export function applyContextBoost(
  text: string,
  matchStart: number,
  matchEnd: number,
  config: RegexPIIRecognizerConfig,
): number; // returns confidence

// packages/shared/src/validation/pii-pack-names.ts (NEW)
// **Deviation from HLD §3.3 component diagram**: the HLD originally placed PACK_NAMES inside
// packages/compiler/src/platform/security/recognizer-packs/index.ts. Verified at LLD-time that
// @abl/compiler already depends on @agent-platform/shared (not the reverse), so re-exporting
// PACK_NAMES from compiler back into the shared Zod schema would create a circular dep.
// PACK_NAMES is declared in @agent-platform/shared instead; the compiler-side recognizer-packs
// dispatcher imports it. Functional surface is unchanged; only the location moved.
export const PACK_NAMES = [
  'core',
  'us',
  'eu',
  'apac',
  'financial',
  'medical',
  'network',
  'international-phone',
] as const;
export type PackName = (typeof PACK_NAMES)[number];

// packages/compiler/src/platform/security/recognizer-packs/index.ts (NEW)
import { PACK_NAMES, type PackName } from '@agent-platform/shared/validation';
export function registerPacks(packNames: PackName[], registry: PIIRecognizerRegistry): void;

// packages/database/src/models/project-runtime-config.model.ts
export interface IPIIRedactionConfig {
  enabled: boolean;
  redact_input: boolean;
  redact_output: boolean;
  tier?: 'basic' | 'standard' | 'advanced' | 'maximum'; // NEW
  latency_budget_ms?: number; // NEW
  confidence_threshold?: number; // NEW
  enabled_recognizer_packs?: PackName[]; // NEW
}

// apps/runtime/src/services/pii/session-pii-context.ts — all four exported now (see D-12)
export interface RuntimePIIRedactionConfig {
  enabled: boolean;
  redactInput: boolean;
  redactOutput: boolean;
  tier: 'basic' | 'standard' | 'advanced' | 'maximum'; // NEW
  latencyBudgetMs: number; // NEW
  confidenceThreshold: number; // NEW
  enabledRecognizerPacks: PackName[]; // NEW
}
export interface ProjectPIIRedactionConfig {
  /* mirror of IPIIRedactionConfig with optional fields */
}
export interface RuntimePIIProjectSnapshot {
  redactionConfig: RuntimePIIRedactionConfig;
  piiRecognizerRegistry?: PIIRecognizerRegistry;
  piiPatternConfigs: PIIPatternConfig[];
}
export function mapProjectPIIRedactionConfig(
  raw: ProjectPIIRedactionConfig | undefined,
): RuntimePIIRedactionConfig;

// apps/runtime/src/observability/pii-telemetry.ts (NEW)
// Wraps the existing TraceStore.addEvent(sessionId, event) API at apps/runtime/src/services/trace-store.ts:72
// `event.data: Record<string, unknown>` carries dimensions; there is no `dimensions`/`value` field.
export type PIIEntryPoint = 'nlu_guard' | 'vault_tokenize' | 'output_filter' | 'streaming_chunk';
export function recordPIIDetectLatency(
  traceStore: TraceStoreInterface,
  sessionId: string,
  opts: {
    entry_point: PIIEntryPoint;
    tier: string;
    pack?: string;
    recognizer?: string;
    ms: number;
  },
): void;
export function recordPIIDetectDegraded(
  traceStore: TraceStoreInterface,
  sessionId: string,
  opts: {
    entry_point: PIIEntryPoint;
    reason: 'async_budget_exceeded' | 'recognizer_threw' | 'unknown_pack';
    recognizer?: string;
  },
): void;
```

### 1.3 Module Boundaries

| Module                              | Responsibility                                                                                          | Depends On                                                                                                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recognizer-packs/*.ts`             | Regex + validator pairs registered into a `PIIRecognizerRegistry`. Pure data-plus-factory.              | `pii-recognizer-registry.ts`, `_validators.ts`, (P4) `phone-extraction.ts`                                                                                                                                                                    |
| `recognizer-packs/_validators.ts`   | Hand-ported checksum validators: IBAN mod-97, Verhoeff, DEA, BTC base58.                                | None (pure functions). Re-exports `luhnCheck` from `pii-recognizer-registry.ts`.                                                                                                                                                              |
| `recognizer-packs/index.ts`         | Pack registry: maps `PackName` → `register(registry)` factory; no-ops on unknown names.                 | All `recognizer-packs/*.ts` modules.                                                                                                                                                                                                          |
| `context-enhancer.ts`               | Pure window-scan helper used by `RegexPIIRecognizer.detect()`.                                          | None.                                                                                                                                                                                                                                         |
| `_with-timeout.ts`                  | Cleaned-up `withTimeout(promise, ms, label)` with `clearTimeout` on success.                            | None. (Underscore prefix is a new local convention for the `recognizer-packs/` directory and the `security/` private helpers — not a pre-existing compiler-package idiom; convention used here for visual grouping of internal-only helpers.) |
| `pattern-loader.ts` (extended)      | Order: built-ins → `registerEnabledPacks` → `loadProjectPIIPatterns` (custom).                          | `recognizer-packs/index.ts`, `pii-recognizer-registry.ts`.                                                                                                                                                                                    |
| `session-pii-context.ts` (extended) | Resolve `RuntimePIIProjectSnapshot` with the four new fields and the registry overlay.                  | Mongoose `ProjectRuntimeConfig`, `mapProjectPIIRedactionConfig`, pattern-loader.                                                                                                                                                              |
| `pii-telemetry.ts` (new)            | Tiny wrapper around the existing trace channel — emits `pii.detect.latency_ms` / `pii.detect.degraded`. | Existing `TraceStore` channel.                                                                                                                                                                                                                |

### 1.4 Foundation Stability Contract (for sibling sub-feature)

This sub-feature lands Foundation first; the sibling cloud-tier sub-feature (`pii-detection-enhancements.md`) consumes these stable exported types **unchanged** via `/post-impl-sync` parity check (per HLD §9 item 1, oracle Q12).

| Stable export                                                                                                            | Owned in                                                | Sibling-spec contract                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `PIIDetection` (with `confidence: number` and `recognizer?: string`)                                                     | `pii-detector.ts`                                       | Must consume the additive shape; cloud-tier detections populate `recognizer` with cloud-provider name.              |
| `RegexPIIRecognizerConfig` (`contextWords`, `contextBoost`, `baseConfidence`, `contextWindowTokens`)                     | `pii-recognizer-registry.ts`                            | Cloud-tier recognizers may ignore (cloud APIs do their own enhancement) — interface is opt-in additive.             |
| `PIIRecognizerRegistry.detectAllAsync(text, { latencyBudgetMs })`                                                        | `pii-recognizer-registry.ts`                            | Cloud-tier recognizers register as **async** recognizers and rely on the same `latency_budget_ms` guard.            |
| `IPIIRedactionConfig` extensions (`tier`, `latency_budget_ms`, `confidence_threshold`, `enabled_recognizer_packs`)       | `packages/database/.../project-runtime-config.model.ts` | Cloud tier adds its own `cloud_provider_config` siblings; pack list narrows to in-process packs only.               |
| `RuntimePIIRedactionConfig` / `ProjectPIIRedactionConfig` / `RuntimePIIProjectSnapshot` / `mapProjectPIIRedactionConfig` | `apps/runtime/src/services/pii/session-pii-context.ts`  | Sibling spec extends each interface additively (no field drops); test spec mandates field-propagation parity tests. |

If any sibling-spec change requires a **non-additive** edit to a row above, it MUST be hoisted into a Foundation refactor with parity tests — not embedded in the sibling spec.

---

## 2. File-Level Change Map

### 2.1 New Files

| File                                                                                  | Purpose                                                                                                                        | LOC Estimate | Phase                                        |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------ | -------------------------------------------- |
| `packages/compiler/src/platform/security/_with-timeout.ts`                            | Extracted `withTimeout(promise, ms, label)` with `clearTimeout` on success.                                                    | ~25          | 1a                                           |
| `packages/compiler/src/platform/security/context-enhancer.ts`                         | `applyContextBoost()` pure helper — case-insensitive token-window scan.                                                        | ~60          | 1a                                           |
| `packages/compiler/src/platform/security/recognizer-packs/index.ts`                   | `registerPacks()` dispatcher. **Imports** `PACK_NAMES`/`PackName` from `@agent-platform/shared/validation` (does not declare). | ~30          | 1b                                           |
| `packages/compiler/src/platform/security/recognizer-packs/core.ts`                    | Email, US phone, dashed+undashed SSN, 13–19-digit Luhn credit card, IPv4.                                                      | ~120         | 1b                                           |
| `packages/compiler/src/platform/security/recognizer-packs/us.ts`                      | US passport, DL, ITIN, bank account, ABA routing.                                                                              | ~140         | 2                                            |
| `packages/compiler/src/platform/security/recognizer-packs/eu.ts`                      | IBAN(mod-97), UK NHS, NINO, GB passport, DE TaxID, IT fiscal, ES NIF/NIE, PL PESEL, FI PIC, SE PN.                             | ~280         | 2                                            |
| `packages/compiler/src/platform/security/recognizer-packs/_validators.ts`             | Hand-ported IBAN mod-97, Verhoeff, DEA, BTC base58. Re-exports existing `luhnCheck`.                                           | ~150         | 3                                            |
| `packages/compiler/src/platform/security/recognizer-packs/apac.ts`                    | IN Aadhaar (Verhoeff), PAN, GSTIN, SG NRIC, AU TFN/Medicare/ABN/ACN, KR RRN.                                                   | ~220         | 3                                            |
| `packages/compiler/src/platform/security/recognizer-packs/financial.ts`               | SWIFT/BIC, BTC wallet (base58check via `_validators.ts`).                                                                      | ~80          | 3                                            |
| `packages/compiler/src/platform/security/recognizer-packs/medical.ts`                 | MRN, NPI (Luhn-prefixed), DEA (checksum).                                                                                      | ~90          | 3                                            |
| `packages/compiler/src/platform/security/recognizer-packs/network.ts`                 | IPv6, MAC address, URL with embedded credentials.                                                                              | ~80          | 4                                            |
| `packages/compiler/src/platform/security/recognizer-packs/international-phone.ts`     | Wraps `phone-extraction.ts` (libphonenumber-js findPhoneNumbersInText).                                                        | ~60          | 4                                            |
| `apps/runtime/src/observability/pii-telemetry.ts`                                     | `recordPIIDetectLatency` / `recordPIIDetectDegraded` helpers wrapping the trace channel.                                       | ~50          | 1b                                           |
| `packages/compiler/src/__tests__/security/_validators.test.ts`                        | Unit tests for IBAN mod-97, Verhoeff, DEA, BTC base58 (test-first per D-4).                                                    | ~150         | 3 (test-first sub-task lands at start of P3) |
| `packages/compiler/src/__tests__/security/pii-detector.confidence.test.ts`            | UT-1.                                                                                                                          | ~80          | 1a                                           |
| `packages/compiler/src/__tests__/security/recognizer-packs.test.ts`                   | UT-2 (core parity), UT-3 (per-pack), UT-7 (unknown pack name).                                                                 | ~250         | grows P1b → P4                               |
| `packages/compiler/src/__tests__/security/recognizer-packs.bench.ts`                  | Vitest `bench` microbenchmark.                                                                                                 | ~120         | 4                                            |
| `packages/compiler/src/__tests__/security/recognizer-packs.redos.test.ts`             | UT-6 (50 adversarial payloads × 8 packs).                                                                                      | ~180         | 4                                            |
| `packages/compiler/src/__tests__/security/aadhaar-verhoeff.test.ts`                   | UT-4.                                                                                                                          | ~50          | 3                                            |
| `packages/compiler/src/__tests__/security/context-enhancer.test.ts`                   | UT-5.                                                                                                                          | ~80          | 1a                                           |
| `packages/compiler/src/__tests__/security/pii-recognizer-registry.async.test.ts`      | UT-8.                                                                                                                          | ~50          | 1a                                           |
| `packages/compiler/src/__tests__/security/pii-recognizer-registry.capacity.test.ts`   | INT-12 (`MAX_RECOGNIZERS = 100`, `permanent: true`).                                                                           | ~80          | 1b                                           |
| `packages/compiler/src/__tests__/security/pii-recognizer-registry.exception.test.ts`  | INT-13 (recognizer-throw containment).                                                                                         | ~60          | 4                                            |
| `packages/compiler/src/__tests__/security/registry-bypass-regression.test.ts`         | INT-1 / INT-2 / INT-3 / INT-4.                                                                                                 | ~180         | 1a                                           |
| `packages/compiler/src/__tests__/security/detect-all-async.test.ts`                   | INT-5 (synthetic async + budget exceedance + clearTimeout cleanup).                                                            | ~120         | 1a                                           |
| `apps/runtime/src/__tests__/pii/session-pii-context.epoch.test.ts`                    | INT-10 (mid-session epoch refresh).                                                                                            | ~120         | 1b                                           |
| `apps/runtime/src/__tests__/pii/registry-isolation.test.ts`                           | INT-9 (project + tenant overlay isolation).                                                                                    | ~140         | 1b                                           |
| `apps/runtime/src/__tests__/pii/pii-latency-telemetry.test.ts`                        | INT-6 (latency telemetry on 3 production entry points).                                                                        | ~140         | 1b                                           |
| `apps/runtime/src/__tests__/e2e/pii-pack-eu.e2e.test.ts`                              | E2E-1.                                                                                                                         | ~150         | 2                                            |
| `apps/runtime/src/__tests__/e2e/pii-confidence-threshold.e2e.test.ts`                 | E2E-2.                                                                                                                         | ~150         | 2                                            |
| `apps/runtime/src/__tests__/e2e/pii-cross-project-isolation.e2e.test.ts`              | E2E-3.                                                                                                                         | ~150         | 3                                            |
| `apps/runtime/src/__tests__/e2e/pii-tier-mid-session.e2e.test.ts`                     | E2E-4.                                                                                                                         | ~160         | 4                                            |
| `apps/runtime/src/__tests__/e2e/pii-pack-and-custom-pattern-coexist.e2e.test.ts`      | E2E-5.                                                                                                                         | ~160         | 4                                            |
| `apps/runtime/src/__tests__/e2e/pii-custom-pattern-survives-pack-disable.e2e.test.ts` | E2E-7.                                                                                                                         | ~180         | 4                                            |
| `apps/runtime/src/__tests__/e2e/pii-config-validation.e2e.test.ts`                    | E2E-ERR-1 (Zod enum rejection).                                                                                                | ~120         | 1b                                           |

> **Test fixtures** under `packages/compiler/src/__tests__/security/fixtures/` are programmatically generated with a deterministic seed per test-spec OQ-4 / HLD §9 item 10 — no committed JSON files. The `fixtures/` path is a runtime namespace for generated data, not a committed directory; nothing under it is checked into git.
>
> **E2E-6 deferred**: the test spec §8 file mapping lists `apps/runtime/src/__tests__/e2e/pii-streaming-iban.e2e.test.ts` as NEW for E2E-6, but this LLD does **not** create that file in any phase. Per HLD §4 Concern 8 and test-spec §2 E2E-6 status, the streaming-pipeline production caller does not exist yet; the test is deferred until that wiring lands in a follow-up sub-feature. This LLD's Phase 5.6 logs the wiring follow-up explicitly.

### 2.2 Modified Files

| File                                                                    | Change Description                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Risk | Phase                       |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | --------------------------- |
| `packages/compiler/src/platform/security/pii-detector.ts`               | Add `confidence`/`recognizer` to `PIIDetection`. Drop `detectWithLocalPatterns` + `PII_PATTERNS` array. Route `detectPII`/`redactPII`/`containsPII`/`detectPIISelective` through `getDefaultPIIRecognizerRegistry()`. Export `removeOverlaps` (currently private — needed by `detectAllAsync`).                                                                                                                                                                        | Med  | 1a                          |
| `packages/compiler/src/platform/security/pii-recognizer-registry.ts`    | Raise `MAX_RECOGNIZERS = 50 → 100`. Extend `RegexPIIRecognizer` constructor with optional `RegexPIIRecognizerConfig`. Extend `createSafePIIDetection` factory to default `confidence = 1.0` and `recognizer = recognizer.name`. Add `detectAllAsync()`. Wire context-boost into the `detect()` hot path. Refactor `registerBuiltInRecognizers()` to delegate to `core.register()` when `core.ts` lands in 1b (P1a leaves a no-op stub call site that is filled in 1b). | High | 1a + 1b                     |
| `packages/compiler/src/platform/security/pii-vault.ts`                  | Add `confidence?: number` to `PIIToken`. Carry through `tokenize()` and `renderForConsumer()`.                                                                                                                                                                                                                                                                                                                                                                         | Low  | 1a                          |
| `packages/compiler/src/platform/security/pii-audit.ts`                  | Add `confidence?: number`, `recognizer?: string` to `PIIAuditEntry`. Logger forwards both to `PIIAuditStore.insert()`.                                                                                                                                                                                                                                                                                                                                                 | Low  | 1a                          |
| `packages/compiler/src/platform/security/streaming-pii-buffer.ts`       | Pass `confidence` / `recognizer` through `StreamingPIIChunkResult.detections`. Buffer-side hook surface only; runtime caller-side wiring deferred (HLD §4 Concern 8).                                                                                                                                                                                                                                                                                                  | Low  | 1a                          |
| `packages/compiler/src/platform/constructs/executors/trace-scrubber.ts` | At line 136, default `options?.piiRecognizerRegistry ?? getDefaultPIIRecognizerRegistry()`. Honor `PII_BYPASS_FIX_ENABLED` env (returns legacy bypass behavior).                                                                                                                                                                                                                                                                                                       | Med  | 1a                          |
| `packages/compiler/src/platform/constructs/cel-functions.ts`            | Same default at the registry-capture site (line ~90 + the three call sites at 453/458/473).                                                                                                                                                                                                                                                                                                                                                                            | Med  | 1a                          |
| `packages/compiler/src/platform/guardrails/action-executors.ts`         | Same default in `executeRedact` (line 23) and `executeFix` (line 59).                                                                                                                                                                                                                                                                                                                                                                                                  | Med  | 1a                          |
| `packages/compiler/src/platform/guardrails/providers/builtin-pii.ts`    | Transitively fixed by FR-3 — when `request.context?.piiRecognizerRegistry` is `undefined`, `detectPII()` now defaults to the singleton. **No explicit code change**; verified by INT-1. Telemetry already uses `performance.now()` idiom — kept as the reference pattern.                                                                                                                                                                                              | None | 1a (verification only)      |
| `packages/compiler/src/platform/nlu/enterprise/pii-guard.ts`            | Filter detections below `confidence_threshold` (resolved from `RuntimePIIRedactionConfig`). Wrap `detectPIISelective` call with `recordPIIDetectLatency({ entry_point: 'nlu_guard', … })`.                                                                                                                                                                                                                                                                             | Med  | 1b                          |
| `apps/runtime/src/services/execution/output-pii-filter.ts`              | Filter by `confidence_threshold`. Wrap detection call with `recordPIIDetectLatency({ entry_point: 'output_filter', … })`.                                                                                                                                                                                                                                                                                                                                              | Med  | 1b                          |
| `apps/runtime/src/services/execution/pii-llm-redaction.ts`              | Wrap `vault.tokenize()` with `recordPIIDetectLatency({ entry_point: 'vault_tokenize', … })`.                                                                                                                                                                                                                                                                                                                                                                           | Low  | 1b                          |
| `apps/runtime/src/services/pii/session-pii-context.ts`                  | Export `RuntimePIIRedactionConfig`, `ProjectPIIRedactionConfig`, `RuntimePIIProjectSnapshot`, `mapProjectPIIRedactionConfig` (D-12). Extend each with the four new fields. Plumb `tier`, `latencyBudgetMs`, `confidenceThreshold`, `enabledRecognizerPacks` through `resolveProjectPIISnapshot()` and `refreshSessionPIIContext()`.                                                                                                                                    | High | 1b                          |
| `apps/runtime/src/services/pii/pattern-loader.ts`                       | Insert `registerPacks(snapshot.enabledRecognizerPacks, registry)` before `loadProjectPIIPatterns()`. Unknown pack names emit `recordPIIDetectDegraded({ reason: 'unknown_pack' })` and are skipped (UT-7).                                                                                                                                                                                                                                                             | Med  | 1b                          |
| `apps/runtime/src/routes/project-runtime-config.ts`                     | Body's `pii_redaction` accepts the four new fields. Zod constraint on `enabled_recognizer_packs`: `z.array(z.enum([...PACK_NAMES]))`. (Existing route auth at line 349 unchanged: `requireProjectPermission(req, res, 'runtime_config:write')`.)                                                                                                                                                                                                                       | Med  | 1b                          |
| `apps/runtime/src/routes/pii-patterns.ts`                               | POST `/test` response payload extended: each detected hit carries `confidence: number` and `recognizer: string`. Existing auth `requirePermission('pii-pattern:read')` at line 187 unchanged.                                                                                                                                                                                                                                                                          | Low  | 1b                          |
| `packages/database/src/models/project-runtime-config.model.ts`          | Extend `IPIIRedactionConfig` and `PIIRedactionConfigSchema` (lines 49-53, 199-206) with four new optional fields + Mongoose defaults (`'basic'`, `200`, `0.5`, `['core']`).                                                                                                                                                                                                                                                                                            | Low  | 1b                          |
| `packages/database/src/models/pii-audit-log.model.ts`                   | Add `confidence?: number`, `recognizer?: string` to `IPIIAuditLog` + Mongoose schema. Indexes unchanged.                                                                                                                                                                                                                                                                                                                                                               | Low  | 1a                          |
| `packages/database/src/models/pii-token-vault.model.ts`                 | Add `confidence?: number` to `IPIITokenVault` + Mongoose schema. Indexes unchanged.                                                                                                                                                                                                                                                                                                                                                                                    | Low  | 1a                          |
| `packages/shared/src/validation/project-runtime-config.ts`              | Extend `piiRedactionConfigSchema` (line 36) with the four new optional fields and the Zod enum on `enabled_recognizer_packs`. Imports `PACK_NAMES` from the new sibling file `./pii-pack-names.ts` (declared in 1b-prep). Also extends `runtimeConfigResponseSchema.pii_redaction` (~line 274) and `PROJECT_RUNTIME_CONFIG_DEFAULTS.pii_redaction` (~line 224).                                                                                                        | Med  | 1b-prep                     |
| `apps/runtime/vitest.e2e.config.ts`                                     | Append the 7 new E2E test files to the explicit `defaultInclude` allowlist. Without this, files silently skip in CI even when `vitest run <file>` passes locally.                                                                                                                                                                                                                                                                                                      | Low  | each phase as new E2Es land |

### 2.3 Deleted Files / Symbols

| Symbol                                                         | Reason                                                                                                                                        |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `detectWithLocalPatterns` (private, `pii-detector.ts:250-268`) | Replaced by routing through `getDefaultPIIRecognizerRegistry()` per FR-3. Caller paths that previously fell through now go via the singleton. |
| `PII_PATTERNS` array (private, `pii-detector.ts:53-97`)        | Same — single source of truth is the `core` pack.                                                                                             |
| Private `luhnCheck` in `pii-detector.ts` (lines 306-326)       | Existing duplicate. Replace call sites with the registry's `luhnCheck` (line 170). One source of truth.                                       |

> No package-level deletions. The `core` pack name change (`builtin-* → core-*`) is **not** a deletion — `registerBuiltInRecognizers()` remains exported as a compatibility shim (D-6).

---

## 3. Implementation Phases

> CRITICAL: Each phase is independently deployable and testable. The system remains green between phases — a partial rollout (Phase 1 only, Phase 1+2, …) is functional and ALPHA-deployable.

### Phase 1a — Foundation Refactors (Compiler-only)

**Goal**: Land `confidence`/`recognizer` field threading, the cleaned-up `withTimeout` helper, async detection path, registry-bypass fixes, and the `RegexPIIRecognizer` config-bag surface — all without touching the runtime or DB. Singleton fallback paths still serve the legacy 5 built-ins because `core.ts` does not exist yet — `registerBuiltInRecognizers()` keeps its current behavior in this commit.

**Tasks**:

1a.1. Add `confidence: number` and `recognizer?: string` to `PIIDetection` in `pii-detector.ts`. Extend `createSafePIIDetection()` at `pii-recognizer-registry.ts:68` to default `confidence = 1.0` and accept `recognizer.name`. Verify all call sites compile — there are 6 today, none populate `confidence` so the default applies. (D-3)
1a.2. Drop `detectWithLocalPatterns` (`pii-detector.ts:250-268`) and `PII_PATTERNS` (`pii-detector.ts:53-97`). Reroute `detectPII`/`redactPII`/`containsPII`/`detectPIISelective` to default to `getDefaultPIIRecognizerRegistry()` when no registry is passed (verified: `detectPIISelective` also has the `detectWithLocalPatterns` fallback at line 218; reroute it as well). Export `removeOverlaps` from `pii-detector.ts` (today private at line 273) — `detectAllAsync` will reuse it. Promote `luhnCheck` in `pii-recognizer-registry.ts:170` from private function to **named export** so it can be imported by `_validators.ts` (P3) and the `core` pack (P1b). Drop the private `luhnCheck` duplicate in `pii-detector.ts:306-326` and rewrite its single internal call site (inside `detectWithLocalPatterns`) to import from the registry — though after the deletion in this same task, the duplicate has no remaining caller. (FR-3)
1a.3. Create `_with-timeout.ts` with the cleaned-up signature (D-4). Body must call `clearTimeout(timer)` in the `.finally(...)` of the wrapped promise so the timer cannot outlive a successful resolution.
1a.4. Add `detectAllAsync(text, opts?)` to `PIIRecognizerRegistry`. Pseudo-flow: run sync recognizers via existing `detectAll()`; for any registered async recognizer, wrap its `detectAsync(text)` in `withTimeout(_, opts.latencyBudgetMs ?? 200, 'pii.detect.async')`; on timeout reject, emit `pii.detect.degraded { reason: 'async_budget_exceeded' }` (telemetry helper not yet wired in this commit — temporary `console.warn` is **not** acceptable; use a deferred emit hook that 1b connects). (FR-2)
1a.5. Extend `RegexPIIRecognizer` constructor with optional `config?: RegexPIIRecognizerConfig` (D-3). Add the context-word boost call inside `RegexPIIRecognizer.detect()` invoking `applyContextBoost(text, match.index, match.index + match[0].length, config)`. Default behavior with no config = `confidence = baseConfidence (1.0)`, identical to today.
1a.6. Create `context-enhancer.ts` with `applyContextBoost()` — case-insensitive, punctuation-tolerant, raw-token window scan (HLD §3.4). Pure function; no platform deps. (FR-7) **Known recall gap** (per Round 7 industry-research finding): raw-token matching does NOT match inflected forms (context word `'passport'` will not match `'passports'` in text). Presidio's `LemmaContextAwareEnhancer` lemmatizes to handle this; the LLD intentionally avoids pulling in a JS NLP runtime. Pack authors MUST include common inflections in their `contextWords` lists (e.g., `['passport', 'passports']`). The JSDoc on `RegexPIIRecognizerConfig.contextWords` must document: (a) single tokens only — multi-word phrases like `"date of birth"` must be split (Presidio constraint), (b) inflected forms must be enumerated explicitly until a future enhancement adds stemming.
1a.7. Default `trace-scrubber.ts:136`, `cel-functions.ts:90`, and `action-executors.ts:23/59` to `getDefaultPIIRecognizerRegistry()` when their respective registry options are `undefined`. Wrap each default behind an `isPIIBypassFixEnabled()` helper that returns `process.env.PII_BYPASS_FIX_ENABLED !== 'false'` (default behavior is fix-enabled — operator must explicitly opt out). Naming follows the runtime's existing `_ENABLED` convention (e.g., `FEATURE_VOICE_ENABLED`, `FEATURE_STREAMING_ENABLED`). Note the actual parameter names differ across the three files: `cel-functions.ts` and `trace-scrubber.ts` use `piiRecognizerRegistry`; `action-executors.ts` uses `recognizerRegistry`. The default-fallback expression must match each file's existing parameter name. (FR-4)
1a.8. Add `confidence?: number` to `PIIToken` (`pii-vault.ts`); carry through `tokenize()`/`renderForConsumer()`. Add `confidence?` and `recognizer?` to `PIIAuditEntry` (`pii-audit.ts`). Update `PIIAuditLogger.log()` to forward both to `PIIAuditStore.insert()`. Add `confidence` / `recognizer` to `StreamingPIIChunkResult.detections` shape — buffer hook surface only.
1a.9. Update Mongoose models (`pii-audit-log.model.ts`, `pii-token-vault.model.ts`) to accept the new optional fields. No index changes. No backfill (D-10).
1a.10. Tests: UT-1 (`pii-detector.confidence.test.ts`), UT-5 (`context-enhancer.test.ts`), UT-8 (`pii-recognizer-registry.async.test.ts`), INT-1/2/3/4 (`registry-bypass-regression.test.ts`), INT-5 (`detect-all-async.test.ts`).

**Files Touched**: `packages/compiler/src/platform/security/{pii-detector,pii-recognizer-registry,pii-vault,pii-audit,streaming-pii-buffer,_with-timeout,context-enhancer}.ts`, `packages/compiler/src/platform/constructs/executors/trace-scrubber.ts`, `packages/compiler/src/platform/constructs/cel-functions.ts`, `packages/compiler/src/platform/guardrails/action-executors.ts`, `packages/database/src/models/{pii-audit-log,pii-token-vault}.model.ts`, plus the 5 unit/integration test files. **~22 files, 2 packages**.

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/compiler --filter=@abl/database` succeeds with **0** TypeScript errors.
- [ ] `pnpm test --filter=@abl/compiler` runs UT-1 / UT-5 / UT-8 / INT-1 / INT-2 / INT-3 / INT-4 / INT-5; all green.
- [ ] `grep -nF 'detectWithLocalPatterns\|PII_PATTERNS' packages/compiler/src/platform/security/pii-detector.ts` returns **zero matches** (FR-3 verified by static grep).
- [ ] `grep -rn 'getDefaultPIIRecognizerRegistry\|piiRecognizerRegistry' packages/compiler/src/platform/constructs/cel-functions.ts packages/compiler/src/platform/constructs/executors/trace-scrubber.ts packages/compiler/src/platform/guardrails/action-executors.ts` shows the singleton fallback wired at every previously-bypassed call site.
- [ ] `pnpm test --filter=@abl/compiler -- --testPathPattern=registry-bypass` passes with `PII_BYPASS_FIX_ENABLED` unset (default = fix-enabled, exercises the singleton fallback); passes with `PII_BYPASS_FIX_ENABLED=false` while exercising the legacy bypass code path (INT-1/2/3/4 each include both modes).
- [ ] Hook scan: `field-propagation-lint.sh` reports **no** unhandled boundaries on the `PIIDetection` / `PIIToken` / `PIIAuditEntry` / `StreamingPIIChunkResult` extensions.
- [ ] Existing PII test suite (`packages/compiler/src/__tests__/security/pii-detector.test.ts`, `pii-vault.test.ts`, `pii-audit.test.ts`, `streaming-pii-buffer.test.ts`) — **0 regressions**. Type-check via `pnpm typecheck --filter=@abl/compiler` clean.

**Test Strategy**:

- **Unit**: pure-function tests for `applyContextBoost` (UT-5), `withTimeout` cleanup invariant (covered in INT-5), confidence-default factory (UT-1), `detectAllAsync` sync-only path (UT-8).
- **Integration**: registry-bypass regression (INT-1/2/3/4) instantiates a real `PIIRecognizerRegistry`, registers a project-only test pattern, and asserts it fires through every previously-bypassed surface — both with the bypass-fix on (default — env unset or `=true`) and with `PII_BYPASS_FIX_ENABLED=false` (asserts legacy behavior). INT-5 wires a synthetic async recognizer via constructor DI (test-only `register({...recognizer, detectAsync: () => sleep(300).then(...)})`); asserts (a) wall time ≤ `latencyBudgetMs + 20ms`, (b) only sync detections returned, (c) `pii.detect.degraded` callback fires once with `reason: 'async_budget_exceeded'`, (d) timer is cleared on success path (no `unhandledRejection` after the test resolves).

**Rollback**: This commit is a clean refactor. Revert via `git revert <sha>` — no data migration to undo, no flag to flip. Audit-log entries written between deploy and revert simply have `confidence`/`recognizer` columns populated; readers ignoring those fields are unaffected.

---

### Phase 1b — Runtime Wiring + `core` Pack + Config Fields

**Goal**: Stand up the pack registry, ship the `core` pack as the single source of truth for the legacy 5 entity types, extend `IPIIRedactionConfig` with the four new fields, wire them through `session-pii-context.ts` to detection callers, and emit production latency telemetry on the three live entry points (NLU guard, vault tokenize, output filter). After this commit, ALPHA-eligible behavior is in place: BASIC tier preserves today's behavior byte-for-byte; STANDARD tier with `enabled_recognizer_packs = ['core']` is functionally identical to BASIC.

**Tasks**:

1b.1. Create `recognizer-packs/index.ts` exporting `registerPacks(packNames, registry)`. The file **imports** `PACK_NAMES` and `PackName` from `@agent-platform/shared/validation` (declared in 1b-prep) — it does NOT declare them locally. Each pack exports `register(registry: PIIRecognizerRegistry): void`; the dispatcher maps each name to its pack module's `register()`; unknown name logs warning and emits `pii.detect.degraded { reason: 'unknown_pack', recognizer: name }` (UT-7).
1b.2. Create `recognizer-packs/core.ts` with the 5 entity types. Use `RegexPIIRecognizer` with `permanent: true`, `tier: 'regex'`. Patterns: email (existing), US phone (existing), SSN (**dashed + undashed** — D-7), credit card (**13-19 digit + Luhn** — D-7, validator = registry's existing `luhnCheck`), IPv4 (existing). Names use `core-*` prefix (`core-email`, `core-ssn`, `core-credit-card`, `core-phone`, `core-ipv4`). No context-word boost in `core` (legacy parity).
1b.3. Refactor `registerBuiltInRecognizers()` (`pii-recognizer-registry.ts:196-253`) to delegate to `core.register(registry)`. Keep the function exported as a compatibility shim (D-6). Verify the singleton `getDefaultPIIRecognizerRegistry()` (line 261) and `createRecognizerRegistry()` in `session-pii-context.ts` (line 119) both still work — both call the shim.
1b.4. Raise `MAX_RECOGNIZERS = 50 → 100` (`pii-recognizer-registry.ts:13`). All pack recognizers register with `permanent: true` (D-5) — verified by INT-12.
1b.5. Extend `IPIIRedactionConfig` and `PIIRedactionConfigSchema` (`packages/database/src/models/project-runtime-config.model.ts:49-53, 199-206`) with optional `tier?`, `latency_budget_ms?`, `confidence_threshold?`, `enabled_recognizer_packs?`. **Use `default: undefined` at the Mongoose layer** to match the existing pattern in this file (verified: `currency_api_url`, `table_name`, `endpoint` at lines 194/213/214 all use `default: undefined`). The defaults `'basic'` / `200` / `0.5` / `['core']` are applied by `mapProjectPIIRedactionConfig()` via `??` fallbacks (single source of default truth, consistent with how the existing `enabled` / `redact_input` / `redact_output` defaults flow through the mapper). The schema-level `PIIRedactionConfigSchema` `default: () => ({})` (existing) ensures the subdocument exists for legacy documents that have no `pii_redaction` at all. (FR-5)
1b.6. Extend the Zod schema at `packages/shared/src/validation/project-runtime-config.ts:36`:

```ts
tier: z.enum(['basic','standard','advanced','maximum']).optional(),
latency_budget_ms: z.number().int().min(50).max(2000).optional(),
confidence_threshold: z.number().min(0).max(1).optional(),
enabled_recognizer_packs: z.array(z.enum([...PACK_NAMES])).optional(),
```

`PACK_NAMES` is declared in `packages/shared/src/validation/pii-pack-names.ts` (NEW file) and imported here. `@abl/compiler` already depends on `@agent-platform/shared` (verified in `packages/compiler/package.json`); declaring `PACK_NAMES` in shared and importing it into compiler matches the existing dep direction (a reverse re-export from compiler back to shared would create a cycle). The compiler-side `recognizer-packs/index.ts` imports `PACK_NAMES` and `PackName` from `@agent-platform/shared/validation`. Existing `onValidationError` handler at `apps/runtime/src/routes/project-runtime-config.ts:58-69` produces the `VALIDATION_ERROR` envelope unchanged. (GAP-010, E2E-ERR-1)
1b.7. Export and extend the four parallel interfaces in `apps/runtime/src/services/pii/session-pii-context.ts` (D-12). Add `tier` / `latencyBudgetMs` / `confidenceThreshold` / `enabledRecognizerPacks` to each. `mapProjectPIIRedactionConfig` reads each field with a `??` default (`'basic'`, `200`, `0.5`, `['core']`). `resolveProjectPIISnapshot` returns the full `RuntimePIIRedactionConfig`. `refreshSessionPIIContext` propagates all four fields onto `session.piiRedactionConfig`. (FR-5; risk D-12 — INT-7/INT-8 enforce parity.)
1b.8. Insert `registerPacks(snapshot.enabledRecognizerPacks, registry)` in `apps/runtime/src/services/pii/pattern-loader.ts:60` between `createRecognizerRegistry()` (built-ins) and `loadProjectPIIPatterns()` (custom). Order is: built-ins (now `core` via shim) → enabled packs → custom patterns. Custom patterns retain their priority (`tier: 'custom'` = priority 0, lowest numeric = highest priority in `removeOverlaps`).
1b.9. Create `apps/runtime/src/observability/pii-telemetry.ts` exporting `recordPIIDetectLatency(traceStore, sessionId, opts)` and `recordPIIDetectDegraded(traceStore, sessionId, opts)`. The actual `TraceStoreInterface.addEvent` signature is `addEvent(sessionId: string, event: TraceEvent): void | Promise<void>` (verified at `apps/runtime/src/services/trace-store.ts:72`); the canonical `TraceEvent` carries data inside a `data: Record<string, unknown>` field, NOT `dimensions`/`value`. The exact emit shape is therefore:

```ts
traceStore.addEvent(sessionId, {
  id: randomUUID(),
  sessionId,
  type: 'pii.detect.latency_ms',
  timestamp: new Date(),
  data: { entry_point, tier, pack, recognizer, ms },
});
```

and analogously for `'pii.detect.degraded'` with `data: { entry_point, reason, recognizer }`. The `sessionId` is plumbed in by the caller from the existing `RequestContext` / session object (each detection entry point already has access). Implementation idiom for the `performance.now()` measurement follows `packages/compiler/src/platform/guardrails/providers/builtin-pii.ts:24-39`. Each helper accepts an injected `TraceStore` so unit tests can spy via constructor DI rather than module mocking (CLAUDE.md test architecture). Resolve the deferred `pii.detect.degraded` emit hook from Phase 1a — connect `_with-timeout.ts` callers to this helper through a callback parameter on `detectAllAsync(text, { latencyBudgetMs, onDegraded?: (reason) => void })`, so the compiler package emits via the runtime-supplied callback and does NOT acquire a runtime → compiler edge.
1b.10. Wire latency telemetry on three production entry points (HLD §4 Concern 8):

- `apps/runtime/src/services/execution/output-pii-filter.ts:83` — wrap the `detectPIISelective` call.
- `apps/runtime/src/services/execution/pii-llm-redaction.ts:68` — wrap `vault.tokenize`.
- `packages/compiler/src/platform/nlu/enterprise/pii-guard.ts:109` — wrap `detectPIISelective`. (FR-8)
- **Streaming-chunk entry point is intentionally NOT wired** — `StreamingPIIBuffer.processChunk` has no production caller (HLD §4 Concern 8); test-spec INT-6 explicitly defers it.
  1b.11. Wire `confidence_threshold` filtering: in `output-pii-filter.ts` and `pii-guard.ts`, drop detections with `confidence < snapshot.confidenceThreshold`. Default 0.5; legacy regex matches default `confidence = 1.0` so they always pass.
  1b.12. Extend POST `/api/projects/:projectId/pii-patterns/test` response shape at `apps/runtime/src/routes/pii-patterns.ts:237` — the `detections` array entries gain `confidence: number` and `recognizer: string`. Existing auth `pii-pattern:read` (line 187) is unchanged. Response envelope `{ success, data }` unchanged.
  1b.13. Append the new E2E test file (`pii-config-validation.e2e.test.ts`) to `apps/runtime/vitest.e2e.config.ts`'s `defaultInclude` allowlist. Run `pnpm test --filter=@apps/runtime -- --testPathPattern=pii-config-validation` and verify it executes (not silently skipped).
  1b.14. Tests: UT-2 (`recognizer-packs.test.ts` — core parity, including a **negative-test fixture group of 20 9-digit non-SSN strings** like zip+4 codes, order numbers, internal IDs that must NOT trigger an SSN detection given default `confidence_threshold = 0.5` and no context word — Round 7 SSN-FP guardrail), UT-7 (in same file — unknown pack), INT-7 (extend `apps/runtime/src/__tests__/pii/session-pii-context.test.ts`), INT-8 (extend same), INT-9 (`registry-isolation.test.ts`), INT-10 (`session-pii-context.epoch.test.ts`), INT-11 (extend `apps/runtime/src/__tests__/services/pii-audit-store-adapter.test.ts` with DI capture), INT-12 (`pii-recognizer-registry.capacity.test.ts`), INT-6 (`pii-latency-telemetry.test.ts`), E2E-ERR-1 (`pii-config-validation.e2e.test.ts`).

**Files Touched**: `packages/compiler/src/platform/security/pii-recognizer-registry.ts`, `packages/compiler/src/platform/security/recognizer-packs/{index,core}.ts`, `packages/compiler/src/platform/nlu/enterprise/pii-guard.ts`, `packages/database/src/models/project-runtime-config.model.ts`, `packages/shared/src/validation/project-runtime-config.ts`, `apps/runtime/src/services/pii/{session-pii-context,pattern-loader}.ts`, `apps/runtime/src/observability/pii-telemetry.ts`, `apps/runtime/src/services/execution/{output-pii-filter,pii-llm-redaction}.ts`, `apps/runtime/src/routes/{project-runtime-config,pii-patterns}.ts`, `apps/runtime/vitest.e2e.config.ts`, plus 9 test files (5 new + 4 extends). **~28 files, 3 packages** (compiler, database+shared, runtime — at the limit; verify the `commit-scope-guard.sh` count is ≤ 40 non-doc files and packages are exactly compiler / database / shared / runtime — that's **4 packages**, busts the limit. Mitigation: split shared-validation extension into a tiny **prep commit 1b-prep** done first inside Phase 1b; the main 1b commit then touches compiler + database + runtime only.)

**Per-phase commit type** (canonical — uses these exact prefixes to satisfy `deletion-ratio-guard.sh`, which blocks `feat()` commits with >30% deletions):

- Phase 1a: `refactor(compiler):` — deletes `detectWithLocalPatterns` / `PII_PATTERNS` / duplicate `luhnCheck`; net additive but high deletion-ratio overall. `refactor()` is exempt from the deletion-ratio guard.
- 1b-prep: `refactor(shared):` — schema extension, no deletions.
- 1b: `feat(runtime):` — additive feature surface; no deletions.
- P2 / P3 / P4: `feat(compiler):` — pack additions; no deletions.
- P5: `docs(...):` — `/post-impl-sync` doc updates and `agents.md` learnings.

**Commit-scope safeguard**: split into **1b-prep** (`refactor(shared): declare PACK_NAMES and extend piiRedactionConfigSchema`) committed first. The 1b-prep commit covers:

- New file `packages/shared/src/validation/pii-pack-names.ts` exporting `PACK_NAMES` + `PackName`.
- Extend `packages/shared/src/validation/project-runtime-config.ts:36` (`piiRedactionConfigSchema`) with the four new optional fields and `z.array(z.enum([...PACK_NAMES]))`.
- Extend `runtimeConfigResponseSchema.pii_redaction` (same file, ~line 274) with the four new fields so GET/PATCH responses round-trip them — without this, the API would silently strip the new fields from responses.
- Extend `PROJECT_RUNTIME_CONFIG_DEFAULTS.pii_redaction` (same file, ~line 224) so `normalizeConfig()` at `apps/runtime/src/routes/project-runtime-config.ts:267-270` returns the four defaults (`tier: 'basic'`, `latency_budget_ms: 200`, `confidence_threshold: 0.5`, `enabled_recognizer_packs: ['core']`) when fields are missing.
- Update `packages/shared/src/validation/index.ts` to re-export `PACK_NAMES` from `./pii-pack-names.js`.

That's 2-3 files, 1 package (`@agent-platform/shared`). Then **1b proper** touches compiler + database + runtime (3 packages, within the limit). Both share the same JIRA ticket [ABLP-921].

**Exit Criteria**:

- [ ] `pnpm build` (root, all packages via Turbo) succeeds with **0** TypeScript errors.
- [ ] `pnpm test --filter=@abl/compiler --filter=@apps/runtime --filter=@abl/database` runs UT-2 / UT-7 / INT-6 / INT-7 / INT-8 / INT-9 / INT-10 / INT-11 / INT-12 + E2E-ERR-1; all green.
- [ ] `grep -F 'export interface RuntimePIIRedactionConfig' apps/runtime/src/services/pii/session-pii-context.ts` returns a hit (D-12 propagation contract).
- [ ] `grep -F 'mapProjectPIIRedactionConfig' apps/runtime/src/services/pii/session-pii-context.ts | grep export` returns a hit.
- [ ] `field-propagation-lint.sh` clean on the `IPIIRedactionConfig` boundary chain — every layer carries the four new fields.
- [ ] PATCH `/api/projects/:id/runtime-config` with `enabled_recognizer_packs = ['core', 'eu', 'eurpoe']` returns HTTP 400 with `error.code = 'VALIDATION_ERROR'` and `error.issues[0].path = ['pii_redaction', 'enabled_recognizer_packs', 2]`. (E2E-ERR-1)
- [ ] PATCH … with `enabled_recognizer_packs = ['core']` returns 200 and persists; subsequent GET shows `tier='basic'` (default), `confidence_threshold=0.5`, `latency_budget_ms=200`.
- [ ] Trace stream during a single chat round at `tier='standard'` shows `pii.detect.latency_ms` events with `entry_point ∈ {nlu_guard, vault_tokenize, output_filter}`. INT-6 asserts.
- [ ] `MAX_RECOGNIZERS` constant is `100` (`grep -F 'MAX_RECOGNIZERS = 100' packages/compiler/src/platform/security/pii-recognizer-registry.ts` matches).
- [ ] `vitest.e2e.config.ts` allowlist includes `pii-config-validation.e2e.test.ts` — verify by running `pnpm vitest run --config apps/runtime/vitest.e2e.config.ts --listTests | grep pii-config-validation`.
- [ ] No regression in existing `apps/runtime/src/__tests__/pii/session-pii-context.test.ts` — all prior cases pass plus the new INT-7/INT-8 extensions.
- [ ] `core` pack parity verified: UT-2 sends 200 fixture inputs through the legacy 5 entity types and asserts every detection the legacy path produced is also produced by the `core` pack; credit-card 13-digit and 19-digit + Amex 15-digit cases produce a hit (detection-expanding bug fix per D-7); SSN undashed `123456789` produces a hit.

**Test Strategy**:

- **Unit**: `recognizer-packs.test.ts` covers UT-2 (core parity, 200 fixtures) and UT-7 (`enabled_recognizer_packs = ['core', 'totally-fake']` resolves to `core` only with a warning).
- **Integration**: INT-7/INT-8 extend the existing `session-pii-context.test.ts` with assertions that legacy documents resolve to documented defaults, and new PATCHes round-trip. INT-9 (`registry-isolation.test.ts`) builds three projects (P-A T1, P-B T1, P-C T2) with different pack selections and asserts overlay isolation. INT-10 mid-session epoch refresh asserts `bumpPIIConfigEpoch` invalidates the snapshot cache and the next `refreshSessionPIIContext` picks up new pack selection (used in 1b only with `core` — the EU IBAN assertion lands in Phase 2). INT-11 captures audit entries via DI; INT-12 verifies `MAX_RECOGNIZERS = 100` and pack recognizers retain `permanent: true` (no eviction when 60 custom patterns are added). INT-6 captures trace events emitted during a single chat round.
- **E2E**: E2E-ERR-1 hits the runtime API with malformed pack names and asserts the structured error envelope at the HTTP boundary.

**Rollback**: Revert the commit. Mongoose schema defaults remain — no data corruption. Or, **without** reverting: PATCH all production projects to `enabled_recognizer_packs = ['core']` (this is the pre-1b behavior — singleton continues to serve `core` because `registerBuiltInRecognizers` shim still works). Or set `PII_BYPASS_FIX_ENABLED=false` per pod to revert the three bypass surfaces to legacy behavior.

**Foundation Stability Cut**: After Phase 1b ships, the contract in §1.4 is **frozen** for the sibling sub-feature. Any future change to those exports must come through a separate Foundation refactor with parity tests and `/post-impl-sync`.

---

### Phase 2 — `us` + `eu` Packs

**Goal**: Land the highest-customer-demand regional packs. EU pack is the largest single pack (10 entity types incl. IBAN with mod-97 checksum). US pack adds passport, DL, ITIN, bank account, ABA routing.

**Prerequisite**: Phase 1b completed and merged.

**Tasks**:

2.1. Implement `recognizer-packs/us.ts`: 5 recognizers (us-passport, us-dl, us-itin, us-bank-account, us-aba-routing). Each `RegexPIIRecognizer` with `permanent: true`. `us-itin` uses a regex with `(9XX-7X-XXXX)` pattern; ABA routing has a checksum validator implemented inline (10 LoC). Context words: `['passport', 'driver', 'license', 'itin', 'tax', 'bank', 'account', 'routing', 'aba']`. `baseConfidence = 0.7` (lower than `core` because numeric IDs are noisier without context); `contextBoost = 0.35`.
2.2. Implement `recognizer-packs/eu.ts`: 10 recognizers. IBAN uses `_validators.ts#isIbanMod97` — but `_validators.ts` does NOT exist yet (lands in P3). Therefore **inline a fully functional IBAN mod-97 validator inside `eu.ts`** for this phase, with a TODO marker and a JIRA cross-link to consolidate into `_validators.ts` in P3. The inline validator is **complete and production-ready** — not a stub; the TODO is a cross-reference comment for the planned consolidation, not deferred work. Recognizers: eu-iban, eu-uk-nhs, eu-uk-nino, eu-uk-passport, eu-de-tax-id, eu-it-fiscal-code, eu-es-nif-nie, eu-pl-pesel, eu-fi-pic, eu-se-personal-number. Context words per entity (e.g., NHS: `['nhs', 'health', 'patient']`).
2.3. Extend `recognizer-packs.test.ts` with UT-3 fixtures for `us` and `eu` packs — 30 valid + 30 corrupted per entity type. Assert IBANs with bad mod-97 do NOT detect.
2.4. Add E2E-1 (`pii-pack-eu.e2e.test.ts`) and E2E-2 (`pii-confidence-threshold.e2e.test.ts`). Append both to `vitest.e2e.config.ts` allowlist. Note: E2E-2 exercises the **context-boost path on a custom pattern** (registered via POST `/pii-patterns` with `baseConfidence = 0.4` and `contextWords = ['passport']`) — it does NOT depend on `us`/`eu` pack context-word lists. The `RegexPIIRecognizer` context-boost wiring landed in Phase 1a (task 1a.5); this E2E is the first runtime exercise of that wiring through the runtime API surface.
2.5. Refresh `recognizer-packs.test.ts` UT-2 fixtures to confirm `core` parity is unaffected by the new packs being available in the registry (overlap dedup via `removeOverlaps`).

**Files Touched**: `recognizer-packs/{us,eu}.ts` (new), `recognizer-packs.test.ts` (extended), 2 new E2E test files, `apps/runtime/vitest.e2e.config.ts`. **~6 files, 2 packages**.

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/compiler --filter=@apps/runtime` clean.
- [ ] UT-2/UT-3 pass for `us` and `eu` entity types — IBAN with valid mod-97 detects (≥0.5 confidence); corrupted IBAN does NOT.
- [ ] E2E-1: PATCH P1 to `enabled_recognizer_packs = ['core', 'eu']`; chat session with `"IBAN GB82 WEST 1234 5698 7654 32"` produces a detection visible via the trace API with `recognizer = 'eu-iban'`. Sibling project P2 (no EU pack) emits **no** IBAN detection.
- [ ] E2E-2: lowering `confidence_threshold` from 0.7 to 0.35 surfaces previously-suppressed detections — asserted via the trace event count delta across before/after sessions.
- [ ] `recognizer-packs/eu.ts` includes a `// TODO(ABLP-921 P3): consolidate isIbanMod97 into _validators.ts` comment marker, and `_validators.ts` doesn't exist yet.

**Test Strategy**:

- **Unit**: per-pack fixture-driven coverage of every entity type. ReDoS adversarial pass deferred to UT-6 in Phase 4 (which will sweep all packs once they all exist).
- **E2E**: API-driven, real `MongoMemoryServer`, real auth via `RuntimeApiHarness`. No mocking of platform packages; `libphonenumber-js` runs live. Cross-project isolation is asserted in E2E-1's isolation check.

**Rollback**: PATCH affected projects to `enabled_recognizer_packs = ['core']`; pack code remains in the binary but does nothing without explicit opt-in. Or revert the commit.

---

### Phase 3 — `apac` + `financial` + `medical` Packs + Validators Consolidation

**Goal**: Land the regulated-industry and APAC regional coverage. This phase introduces `_validators.ts` because three of the new packs need hand-ported validators (Verhoeff for Aadhaar, BTC base58check for `financial`, DEA checksum for `medical`).

**Prerequisite**: Phase 2 completed and merged.

**Tasks**:

3.1. **Test-first** (D-4): land `_validators.test.ts` with 20 valid + 20 corrupted fixtures per validator (IBAN mod-97, Verhoeff, DEA, BTC base58). The `_validators.ts` module is empty/skeleton at this point; tests fail (red).
3.2. Implement `recognizer-packs/_validators.ts`: 4 hand-ported validators + re-export of registry's `luhnCheck`. Tests from 3.1 should now pass. **Per Round 8 OSS audit** — embed source attribution as one-line header comments per validator for correctness traceability:

- `isIbanMod97`: design reference is `ibantools` (MIT, https://github.com/Simplify/ibantools) — port the mod-97 core only, NOT the BBAN country tables.
- `verhoeffCheck`: public algorithm spec — Verhoeff (1969) lookup-table form; no maintained npm package exists for vendoring.
- `deaCheck`: DEA Diversion Control documentation (weighted mod-10); no npm package available.
- `btcBase58Check`: design reference is `bs58check` (MIT, bitcoinjs-lib) — port the base58 alphabet decode + double-SHA256 check; do NOT add `@noble/hashes` as a transitive dep.
  No new runtime deps are added (HLD §8.2 binding decision confirmed by Round 8 audit; `validator.js` evaluated and rejected due to documented ReDoS CVE history and 3-of-12 missing validators).
  3.3. Replace the inline IBAN mod-97 in `recognizer-packs/eu.ts` (added in P2 with TODO marker) with `import { isIbanMod97 } from './_validators.js'`. Verify UT-3 EU fixtures still pass.
  3.4. Implement `recognizer-packs/apac.ts`: 8 recognizers (in-aadhaar via Verhoeff, in-pan, in-gstin, sg-nric with checksum, au-tfn, au-medicare, au-abn-acn, kr-rrn). Aadhaar uses `_validators.ts#verhoeffCheck`.
  3.5. Implement `recognizer-packs/financial.ts`: SWIFT/BIC regex (no checksum), BTC wallet (`_validators.ts#btcBase58Check`). IBAN coverage stays in `eu` pack (per HLD §3.3 component diagram comment "shared with eu").
  3.6. Implement `recognizer-packs/medical.ts`: MRN regex, NPI (existing `luhnCheck` with the `80840` prefix harness — see test-spec UT-3), DEA (`_validators.ts#deaCheck`).
  3.7. Add `aadhaar-verhoeff.test.ts` (UT-4 — 20 valid + 20 with last digit corrupted). Add E2E-3 (`pii-cross-project-isolation.e2e.test.ts`) — 3 projects under different tenants/configs, registry-overlay isolation through HTTP. Append E2E to allowlist.
  3.8. Extend `recognizer-packs.test.ts` UT-3 fixtures for `apac`/`financial`/`medical`.

**Files Touched**: `recognizer-packs/{_validators,apac,financial,medical}.ts` (new), `recognizer-packs/eu.ts` (1-line edit), `_validators.test.ts` (new), `aadhaar-verhoeff.test.ts` (new), `recognizer-packs.test.ts` (extended), 1 E2E test, `apps/runtime/vitest.e2e.config.ts`. **~10 files, 2 packages**.

**Exit Criteria**:

- [ ] `_validators.test.ts` passes — all 4 validators (IBAN mod-97, Verhoeff, DEA, BTC base58) accept 20 valid and reject 20 corrupted inputs each.
- [ ] `eu.ts` no longer contains an inline IBAN mod-97 — `grep -F 'isIbanMod97' packages/compiler/src/platform/security/recognizer-packs/eu.ts` shows only the import statement.
- [ ] UT-3 + UT-4 pass for `apac`, `financial`, `medical` entity types.
- [ ] E2E-3 passes: P1 (T1, `medical`) sees MRN detections; P2 (T1, no `medical`) does not; P3 (T2) cannot read P1's runtime-config (HTTP 404).
- [ ] No regression in P2 tests (UT-2 core, UT-3 us/eu).
- [ ] `pnpm build` clean.

**Test Strategy**:

- **Unit**: validator unit tests are the harness; pack tests verify the integration.
- **E2E**: API-driven cross-project + cross-tenant isolation through the runtime API.

**Rollback**: Same as P2 — flip `enabled_recognizer_packs` per project, or revert.

---

### Phase 4 — `network` + `international-phone` Packs + Microbenchmarks + ReDoS Adversarial Pass + Remaining E2E

**Goal**: Final coverage. Land the smaller two packs, the microbenchmark suite (HLD §4 Concern 9 mandate), the ReDoS adversarial sweep across all 8 packs, and the remaining E2E scenarios.

**Prerequisite**: Phase 3 completed and merged.

**Tasks**:

4.1. Implement `recognizer-packs/network.ts`: ipv6 (regex), mac-address, url-with-credentials (matches `https?://user:pass@host`).
4.2. Implement `recognizer-packs/international-phone.ts`: thin wrapper around the existing `packages/compiler/src/platform/utils/phone-extraction.ts` (`extractPhoneFromText` / `findPhoneNumbersInText` with `defaultCountry = 'US'`). Import path from inside `recognizer-packs/`: `'../../utils/phone-extraction.js'`. Each detection populates `recognizer = 'intl-phone'` and `confidence = 1.0` (libphonenumber's per-country digit-count validation is the gate).
4.3. Add `recognizer-packs.bench.ts` (Vitest `bench`, non-blocking per D-11): exercise each pack at 100 / 500 / 1000 / 5000-character payloads. Document the baseline numbers in the bench output as a marker for future regressions. Add a CI lane that invokes `pnpm vitest bench --filter=@abl/compiler` separately from the test lane.
4.4. Add `recognizer-packs.redos.test.ts` (UT-6, **CI-blocking**): 50 adversarial payloads × 8 packs = 400 cases. Wall-time bound = **25 ms per pattern** (industry norm for developer-authored patterns is 10–25 ms; 50 ms is for untrusted inputs and would compound to ~1 s across 40 patterns, breaching the 30 ms p95 target — Round 7 industry-research finding). If any pattern exceeds, the test fails — this is the hard gate D-11 commits to. Each pack PR in P2/P3/P4 must additionally include a **per-pack smoke ReDoS check** (10 adversarial payloads, same 25 ms bound) so vulnerable patterns are caught at the phase they ship in, not deferred to the comprehensive P4 sweep.
4.5. Add `pii-recognizer-registry.exception.test.ts` (INT-13): synthetic recognizer whose `detect()` throws on a particular input; assert (a) exception does not propagate, (b) other recognizers' detections are returned, (c) `pii.detect.degraded { reason: 'recognizer_threw' }` emitted, (d) the offending recognizer is suppressed for the remainder of the request.
4.6. Add E2E-4 (`pii-tier-mid-session.e2e.test.ts`), E2E-5 (`pii-pack-and-custom-pattern-coexist.e2e.test.ts`), E2E-7 (`pii-custom-pattern-survives-pack-disable.e2e.test.ts`). Append all three to `vitest.e2e.config.ts` allowlist.
4.7. Update `recognizer-packs.test.ts` UT-3 fixtures for `network` and `international-phone`.

**Files Touched**: `recognizer-packs/{network,international-phone}.ts` (new), `recognizer-packs.{bench,redos.test}.ts` (new), `pii-recognizer-registry.exception.test.ts` (new), `recognizer-packs.test.ts` (extended), 3 E2E test files, `apps/runtime/vitest.e2e.config.ts`. **~10 files, 2 packages**.

**Exit Criteria**:

- [ ] `pnpm test --filter=@abl/compiler -- --testPathPattern=recognizer-packs.redos` passes — every pattern under 50 ms per adversarial input. (UT-6 is the hard CI gate.)
- [ ] `pnpm vitest bench --filter=@abl/compiler` runs and reports per-pack p50/p95 numbers; non-zero output for each pack at each payload size. (D-11 — non-blocking; reports only.)
- [ ] INT-13 passes — recognizer-throw containment.
- [ ] E2E-4, E2E-5, E2E-7 all green via `pnpm vitest run --config apps/runtime/vitest.e2e.config.ts`.
- [ ] All 8 packs registered: `grep -lF 'register(registry' packages/compiler/src/platform/security/recognizer-packs/` lists exactly 8 files (excluding `index.ts`, `_validators.ts`, `_validators.test.ts`).
- [ ] `field-propagation-lint.sh` final pass — clean on the entire `IPIIRedactionConfig` chain.

**Test Strategy**:

- **Unit**: ReDoS adversarial sweep is the primary CI gate for catastrophic regression. Bench is observability-only.
- **Integration**: INT-13 closes the recognizer-throw failure mode.
- **E2E**: full surface coverage of the user stories from feature spec §3.

**Rollback**: Per-pack PATCH; pack-level rollback is per-project. Revert the commit if the bench reveals a systemic regression.

---

### Phase 5 — Verification & ALPHA Promotion

**Goal**: Operate the gates required to mark ABLP-921 ALPHA per CLAUDE.md feature lifecycle.

**Prerequisite**: Phases 1-4 merged.

**Tasks**:

5.1. Run `pnpm test:report` end-to-end. Inspect `test-reports/SUMMARY.md` for any unexpected failures across the entire monorepo.
5.2. Run `./tools/run-semgrep.sh` on the touched paths (auth, crypto, HTTP handlers, user input) per CLAUDE.md key rules. Address any **CRITICAL/HIGH** findings.
5.3. Manual smoke test: deploy to dev environment with `tier='basic'`, `enabled_recognizer_packs=['core']` on every project. Verify p95 `pii.detect.latency_ms` ≤ 5 ms across NLU guard / vault tokenize / output filter. Verify zero `pii.detect.degraded` events.
5.4. Promote a pilot project to `tier='standard'`, `enabled_recognizer_packs=['core','eu']`. Verify IBAN detections appear in the audit log with `confidence`/`recognizer` populated.
5.5. Run `/post-impl-sync pii-detection-tiered-recognizers` to:

- Update sub-feature spec status PLANNED → ALPHA.
- Update parent feature spec (`docs/features/pii-detection.md`) gap statuses (close GAP-013 registry-bypass; update detection coverage from 5 to 40+).
- Update testing matrix coverage column.
- Update HLD/LLD status to DONE.
- Append per-package learnings to each touched package's `agents.md` (per CLAUDE.md "Every SDLC phase updates `agents.md` for each package touched"): `packages/compiler/agents.md` (recognizer-pack registration ordering; `withTimeout` cleanup invariant; `core` pack as canonical 5-recognizer set; `MAX_RECOGNIZERS = 100` rationale), `apps/runtime/agents.md` (4-interface field-propagation requirement in `session-pii-context.ts`; vitest E2E allowlist requirement; `pii-telemetry.ts` callback pattern keeps compiler→runtime edge from forming), `packages/database/agents.md` (`default: undefined` Mongoose pattern preserved on additive PII fields), `packages/shared/agents.md` (`PACK_NAMES` placement avoids circular dep). Cross-cutting findings (`registerBuiltInRecognizers` shim trick, audit-log read-API gap deferred) → `docs/sdlc-logs/agents.md`.
  5.6. Open follow-up tickets:
- **Tech debt**: Consolidate `withTimeout` from `agent-transfer`, `arch-ai`, and `_with-timeout.ts` into `packages/shared/src/util/with-timeout.ts`. Migrate the two existing leaky sites (D-4 deferred work).
- **Streaming pipeline integration**: Wire `StreamingPIIBuffer.processChunk` to a production caller and add the deferred E2E-6 streaming test (HLD §4 Concern 8).
- **Audit-log read API**: Parent-feature gap (D-8) — design a `GET /api/projects/:projectId/pii-audit` route with auth permission decisions.
- **GAP-009 follow-up**: Per-pattern execution timeout inside `RegexPIIRecognizer.detect()`.
- **`PII_BYPASS_FIX_ENABLED` removal**: Remove the env-var lever after one stable release cycle (HLD §11).
  5.7. **Saturation check (BETA gate, run before BETA promotion — not blocking ALPHA)**: invoke `/saturation-finder` skill against a test project at `tier='standard'` with all 8 packs enabled. Document results in `docs/sdlc-logs/pii-detection-tiered-recognizers/saturation-2026-XX-XX.md`. If p95 stays ≤ 5 ms (≤ 2 KB) and ≤ 30 ms (≤ 10 KB), eligible for BETA.

**Exit Criteria**:

- [ ] `pnpm test:report` SUMMARY shows zero failures on touched packages.
- [ ] `tools/run-semgrep.sh` zero CRITICAL/HIGH on touched files.
- [ ] Pilot project at `tier='standard'` runs for ≥ 24 hours without `pii.detect.degraded` events.
- [ ] Sub-feature status: ALPHA. Testing matrix updated. Parent feature spec gap statuses refreshed.
- [ ] Follow-up tickets filed and linked from `docs/sdlc-logs/pii-detection-tiered-recognizers/`.

**Rollback**: Re-PATCH all production projects to `enabled_recognizer_packs=['core']` and `tier='basic'` (immediate, no deploy). Then choose between `PII_BYPASS_FIX_ENABLED=false` rollout (per-pod env, reverts the three bypass surfaces to legacy behavior) or revert the merge if a deeper regression is suspected.

---

## 4. Wiring Checklist

> Every new component must be wired into its callers. This is the #1 failure mode for agent-written code.

- [ ] `recognizer-packs/index.ts` — imports `PACK_NAMES` from `@agent-platform/shared/validation` and exports `registerPacks(packNames, registry)`. The same `PACK_NAMES` constant is consumed by `packages/shared/src/validation/project-runtime-config.ts` Zod schema directly (no re-export through compiler).
- [ ] `recognizer-packs/{core,us,eu,apac,financial,medical,network,international-phone}.ts` — each exports `register(registry)` consumed by `recognizer-packs/index.ts`.
- [ ] `recognizer-packs/_validators.ts` — exports `isIbanMod97`, `verhoeffCheck`, `deaCheck`, `btcBase58Check`, plus re-export of `luhnCheck` from `pii-recognizer-registry.ts`. Consumers: `eu.ts` (mod-97), `apac.ts` (Verhoeff), `medical.ts` (DEA), `financial.ts` (base58).
- [ ] `_with-timeout.ts` — exports `withTimeout`. Consumed by `pii-recognizer-registry.ts:detectAllAsync()`.
- [ ] `context-enhancer.ts` — exports `applyContextBoost`. Consumed by `RegexPIIRecognizer.detect()` in `pii-recognizer-registry.ts`.
- [ ] `pii-telemetry.ts` — exports `recordPIIDetectLatency`, `recordPIIDetectDegraded`. Consumed by `pii-guard.ts`, `output-pii-filter.ts`, `pii-llm-redaction.ts`, and `pii-recognizer-registry.ts:detectAllAsync` (via deferred-emit hook resolved in 1b).
- [ ] **`onDegraded` callback chain wired end-to-end**: `_with-timeout.ts` timer fires → `detectAllAsync({ onDegraded })` invokes the callback with a reason → runtime caller passes `(reason) => recordPIIDetectDegraded(traceStore, sessionId, { entry_point, reason, recognizer })`. Compiler package never imports the trace channel — the runtime caller owns the emit. Verified by INT-5 (assertion (c) of phase 1a).
- [ ] `registerEnabledPacks` (call inside `pattern-loader.ts`) — invoked between `createRecognizerRegistry()` and `loadProjectPIIPatterns()` inside `resolveProjectPIISnapshot()`.
- [ ] Mongoose models touched (`pii-audit-log.model.ts`, `pii-token-vault.model.ts`, `project-runtime-config.model.ts`) — already listed in `packages/database/src/models/index.ts` (verified at lines 775, 777-782; no new model entries needed).
- [ ] PATCH route Zod schema imports `PACK_NAMES` (re-exported from `@abl/shared/validation/project-runtime-config`).
- [ ] POST `/test` route (`pii-patterns.ts`) returns extended response with `confidence` and `recognizer`. Studio UI consumer is **out of scope** (no Studio UX work in this sub-feature) — runtime returns the additive fields; clients ignoring them keep working.
- [ ] Runtime SDK / WebSocket protocol — no changes (detection metadata flows through existing `messageMetadata` envelope; no protocol-level addition).
- [ ] `apps/runtime/vitest.e2e.config.ts` — appends each new E2E file to `defaultInclude` allowlist as it lands (per phase).
- [ ] OpenAPI spec — **N/A**. Verified `apps/runtime/openapi/` does not exist; the runtime does not maintain a generated OpenAPI surface today. This is a pre-existing gap unrelated to this LLD; no action required here.
- [ ] No new workers, no new DI containers, no new middleware chain entries — detection runs on the existing request path through the existing services.

**Studio UI (no Studio work in this sub-feature)**:

- [ ] Studio settings UX is explicitly out of scope (HLD §6 / feature spec §8). No new Studio routes, no new components, no native `<select>` checks.

---

## 5. Cross-Phase Concerns

### 5.1 Database Migrations

**No migration scripts** (D-10). Mongoose schema defaults handle missing fields at read time:

- `IPIIRedactionConfig`: defaults `tier='basic'`, `latency_budget_ms=200`, `confidence_threshold=0.5`, `enabled_recognizer_packs=['core']`.
- `IPIIAuditLog.confidence`/`.recognizer`: undefined on legacy entries; readers tolerate.
- `IPIITokenVault.confidence`: undefined on legacy entries; metadata-only.

`mapProjectPIIRedactionConfig()` provides a defensive `??` fallback layer in `session-pii-context.ts`. Verified by INT-7.

### 5.2 Feature Flags

| Flag                                     | Type          | Default    | Scope                                                                                              | When to flip                                                                            |
| ---------------------------------------- | ------------- | ---------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `PII_BYPASS_FIX_ENABLED`                 | env (per pod) | `true`     | Default is fix-enabled. Setting `false` reverts the 3 bypass surfaces to legacy behavior.          | Incident lever during initial rollout. Remove after one stable release cycle (HLD §11). |
| `pii_redaction.tier`                     | per-project   | `basic`    | Doc-level intent; runtime treats as equivalent to `enabled_recognizer_packs=['core']` if both set. | Builders opt projects into STANDARD via PATCH.                                          |
| `pii_redaction.enabled_recognizer_packs` | per-project   | `['core']` | Effective pack list                                                                                | Pilot rollout (EU first → APAC → all packs) per HLD §10.2.                              |

No GrowthBook flags; no LaunchDarkly flags. All gating is config-data on `ProjectRuntimeConfig`.

### 5.3 Configuration Changes

New environment variables (all optional, per spec §11):

| Variable                           | Default | Purpose                                                                                                                                                                             |
| ---------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PII_DEFAULT_TIER`                 | `basic` | Platform-wide fallback for `tier`.                                                                                                                                                  |
| `PII_DEFAULT_LATENCY_BUDGET_MS`    | `200`   | Platform-wide fallback for `latency_budget_ms`.                                                                                                                                     |
| `PII_DEFAULT_CONFIDENCE_THRESHOLD` | `0.5`   | Platform-wide fallback for `confidence_threshold`.                                                                                                                                  |
| `PII_DEFAULT_RECOGNIZER_PACKS`     | `core`  | Comma-separated platform-wide fallback for `enabled_recognizer_packs`.                                                                                                              |
| `PII_BYPASS_FIX_ENABLED`           | `true`  | Per-pod fix toggle. Default `true` = fix on (registry singleton fallback). Set `false` to revert `trace-scrubber` / `cel-functions` / `action-executors` to legacy bypass behavior. |

All new env vars resolved at startup in `apps/runtime/src/config/...` (existing pattern). Per-project values on `ProjectRuntimeConfig` always win.

### 5.4 Telemetry & Observability

New trace dimensions (emitted via `pii-telemetry.ts`):

- `pii.detect.latency_ms` — sub-dimensions `{ entry_point, tier, pack?, recognizer?, ms }`.
- `pii.detect.degraded` — sub-dimensions `{ entry_point, reason, recognizer?, pack? }`. `reason ∈ {'async_budget_exceeded', 'recognizer_threw', 'unknown_pack'}`.

No Grafana dashboard or Prometheus alert in this LLD's scope (D-14, HLD §4 Concern 8). Trace event schema documented in §1.2 above for downstream consumers.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 5 phases complete with each phase's exit criteria met.
- [ ] `pnpm build` (Turbo, all packages) succeeds with **0** TypeScript errors.
- [ ] `pnpm test:report` SUMMARY shows zero failures on touched packages.
- [ ] All 7 active E2E scenarios from the test spec are green: E2E-1, E2E-2, E2E-3, E2E-4, E2E-5, E2E-7, E2E-ERR-1 (E2E-6 deferred per HLD §4 Concern 8 — does not count toward this gate).
- [ ] All 13 integration scenarios from the test spec are green.
- [ ] All 8 unit scenarios from the test spec are green; UT-6 (ReDoS) is a hard CI gate.
- [ ] Microbenchmark suite produces baseline numbers; D-11 keeps it non-blocking.
- [ ] **No regressions** in existing PII test suite — `pnpm test --filter=@abl/compiler --filter=@apps/runtime -- --testPathPattern=pii` is green at every phase boundary.
- [ ] `field-propagation-lint.sh` clean on the entire `IPIIRedactionConfig` boundary chain.
- [ ] `tools/run-semgrep.sh` zero CRITICAL/HIGH on touched files (P5).
- [ ] Sub-feature spec status: ALPHA via `/post-impl-sync`.
- [ ] Parent `pii-detection.md` gap statuses refreshed: GAP-013 closed; entity-type count 5 → 40+.
- [ ] Foundation Stability Contract (§1.4) frozen — sibling sub-feature can consume the listed exports unchanged. The sibling sub-feature's LLD review must explicitly cite §1.4 of this LLD and confirm no non-additive change is introduced. Any change to a §1.4 row after Phase 1b ships is hoisted into a Foundation refactor (with parity tests + `/post-impl-sync`), never embedded in the sibling spec.

---

## 7. Open Questions

> Round 7 (industry research) surfaced 5 follow-up improvements that are **non-blocking** for ALPHA but worth tracking; they appear as items 5–9 below.

1. **`PIIPatternConfig` consumer of `confidence_threshold`** — Custom user-defined patterns today register with default `confidence = 1.0` (FR-7 baseConfidence default). Should the custom-pattern API (POST `/api/projects/:id/pii-patterns`) accept an optional `baseConfidence` field so builders can configure low-confidence custom patterns that benefit from `confidence_threshold` filtering? Recommendation: **defer to a follow-up sub-feature**; this LLD keeps custom-pattern surface unchanged and relies on context-word boost via the existing `loadProjectPIIPatterns` overlay.
2. **`pii_redaction.tier='advanced'` and `'maximum'` semantics** — Today the LLD treats values other than `basic` and `standard` as equivalent to `standard` (both run the in-process pack pipeline). Should the runtime emit a warning if a builder PATCHes `tier='advanced'` while no advanced recognizers (GLiNER) are registered, OR silently treat as `'standard'`? Recommendation: **emit `pii.detect.degraded { reason: 'unsupported_tier' }`** at session bootstrap so monitoring catches misconfigurations. **Disposition**: deferred to the sibling sub-feature `pii-detection-enhancements.md` (which introduces the cloud tier and is the natural owner of tier-vs-capability checks). Not assigned to a Phase in this LLD.
3. **`removeOverlaps` exposure** — Phase 1a exports `removeOverlaps` from `pii-detector.ts` so `detectAllAsync` can reuse it after merging sync + async results. This widens the public API surface of `pii-detector.ts`. Should it instead live as a static helper on `PIIRecognizerRegistry`? Either is correct; keeping it co-located with `pii-detector.ts` (its only existing consumer) is the lower-churn move.
4. **Validator vendoring** — Hand-ported validators in `_validators.ts` need to be reviewed against authoritative sources (IBAN registry doc; Indian govt Aadhaar Verhoeff spec; DEA's two-letter prefix table; BTC base58check). Source review is in scope of P3 implementation, but a tech-writing pass to embed the specifications as comments inside `_validators.ts` would aid future maintenance. Recommendation: **embed RFC / spec links as one-line comments per validator**.
5. **Shadow / dry-run mode for STANDARD rollout** (Round 7 finding). AWS Comprehend's service card recommends a three-stage rollout (shadow → canary → full); the LLD's plan jumps directly from per-project opt-in to active redaction. Should the runtime add a `pii_redaction.dry_run: boolean` flag (default `false`) that runs detection and emits `pii.detect.*` telemetry but skips the redact step? Disposition: **deferred** — the existing `redact_input`/`redact_output` flags can be set to `false` per-project to achieve detect-only mode (operators can monitor `pii.detect.latency_ms` without redaction), so a dedicated `dry_run` flag is redundant for v1. Revisit if operators report needing both `redact_*=true` AND a separate dry-run override (i.e., per-pack rather than per-project shadow).
6. **Golden-set regression corpus** (Round 7 finding). The success-metrics targets (F2 ≥ 0.85, recall ≥ 0.95 for credit-card / IBAN) need a reproducible benchmark. Should the LLD ship a committed annotated corpus (~200 multi-entity samples per pack) and add a `pnpm bench:pii-quality` non-blocking CI lane? Disposition: **deferred to follow-up ticket** (logged in P5.6) — the synthetic-fixture approach in UT-3 covers per-pattern precision; a multi-entity golden set is a higher-investment quality measurement that should land alongside drift monitoring in Observability's follow-up sub-feature.
7. **Tighter ReDoS threshold per pattern** (Round 7 finding). The LLD now uses **25 ms per pattern** in UT-6 (Phase 4) plus per-pack smoke ReDoS at each phase. Industry guidance for developer-authored patterns is 10–25 ms; 50 ms (the original number from the test spec) is the upper bound for untrusted inputs. Should we tighten to 10 ms? Recommendation: **stay at 25 ms** for ALPHA (more headroom for V8 JIT warmup and CI machine noise) and revisit after the P4 microbench produces baseline numbers — if every pack reports p95 ≤ 5 ms per pattern, tighten to 10 ms in a follow-up.
8. **SSN undashed FP regression coverage** (Round 7 finding). The detection-expanding bug fix in D-7 (undashed `123456789` SSN) is mitigated by `confidence_threshold` and context-word boost, but UT-3 fixtures should include explicit **negative tests** for common 9-digit non-SSN strings (zip+4 codes `941073210`, order numbers, internal IDs) to catch FP regressions at unit-test layer. Disposition: **add to UT-3 acceptance** in Phase 1b (test 1b.14 — extend `recognizer-packs.test.ts` with the 9-digit negative-test fixture group as part of `core` parity coverage).
9. **`vuln-regex-detector` / `recheck` static analysis** (Round 7 finding). Industry recommends a CI-time static-analysis tool that catches catastrophic backtracking statically rather than via wall-time tests. Should the LLD add a `pnpm lint:redos` step that runs `recheck` on every `recognizer-packs/*.ts`? Disposition: **deferred to GAP-009 follow-up**. The per-pack smoke ReDoS at each phase boundary + UT-6 in P4 is sufficient defense-in-depth for ALPHA; static analysis is a hardening improvement.

---

## 8. Risk Register & Mitigations

| Risk                                                                                                              | Severity | Mitigation                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`mapProjectPIIRedactionConfig` field drop** (D-12 — biggest risk per oracle Q13)                                | HIGH     | Four parallel interfaces extended in 1b; INT-7/INT-8 explicitly assert each layer round-trips all four new fields. `field-propagation-lint.sh` is a hook-level guardrail.                          |
| **SSN undashed FP storm on rollout** (D-7 — detection-expanding bug fix on `123456789` numeric inputs)            | MED      | Confidence-threshold filtering (default 0.5) + context-word boost on `["ssn", "social", "security"]`. Operators monitor `pii.detect.degraded` and per-recognizer detection volume during P5 pilot. |
| **`PII_BYPASS_FIX_ENABLED` becomes load-bearing** — left enabled in production indefinitely                       | MED      | Follow-up ticket (P5.6) explicitly removes the env var after one stable release cycle. ALPHA → BETA gate requires the env var to be at default.                                                    |
| **`withTimeout` orphan timer** under high throughput (D-4 cleanup invariant)                                      | MED      | INT-5 explicitly asserts cleanup; the new `_with-timeout.ts` MUST contain a `.finally(() => clearTimeout(timer))` clause. Code review gate at PR time.                                             |
| **Pack regex ReDoS** introduced in P2/P3/P4                                                                       | MED      | UT-6 in P4 sweeps all 8 packs at 50 ms wall time per pattern — hard CI gate. Each pack PR must include a manual ReDoS heuristic review against `CATASTROPHIC_BACKTRACKING_PATTERNS`.               |
| **`MAX_RECOGNIZERS = 100` hit by a heavy custom-pattern customer** (~45 permanent + 50 custom + headroom = tight) | LOW      | INT-12 verifies `permanent: true` blocks pack eviction. Operators monitor registry capacity via the `recognizer count` log emitted at session bootstrap (existing log line).                       |
| **Sibling spec breaks Foundation contract** — adds non-additive change to `IPIIRedactionConfig`                   | MED      | Foundation Stability Contract (§1.4) is the explicit gate. Sibling sub-feature's LLD review MUST cite §1.4. `/post-impl-sync` parity check enforced.                                               |
| **Phase 1b commit busts 3-package limit** (compiler + database + shared + runtime = 4)                            | MED      | Mitigation built in: Phase 1b-prep commits the `packages/shared` Zod-schema extension first; main 1b commit then touches compiler + database + runtime only.                                       |

---

## 9. References

- Feature spec: [`docs/features/sub-features/pii-detection-tiered-recognizers.md`](../features/sub-features/pii-detection-tiered-recognizers.md)
- HLD: [`docs/specs/sub-features/pii-detection-tiered-recognizers.hld.md`](../specs/sub-features/pii-detection-tiered-recognizers.hld.md)
- Test spec: [`docs/testing/sub-features/pii-detection-tiered-recognizers.md`](../testing/sub-features/pii-detection-tiered-recognizers.md)
- LLD oracle log: [`docs/sdlc-logs/pii-detection-tiered-recognizers/lld.log.md`](../sdlc-logs/pii-detection-tiered-recognizers/lld.log.md)
- Source plan: [`docs/audit/2026-05-08-pii-detection-gap-analysis-and-enhancement-plan.md`](../audit/2026-05-08-pii-detection-gap-analysis-and-enhancement-plan.md)
- SDLC pipeline: [`docs/sdlc/pipeline.md`](../sdlc/pipeline.md)
- Post-impl-sync playbook: [`docs/sdlc/post-impl-sync-playbook.md`](../sdlc/post-impl-sync-playbook.md)
- Existing test harness: `apps/runtime/src/__tests__/helpers/runtime-api-harness.ts`
- E2E config (allowlist): `apps/runtime/vitest.e2e.config.ts`
- ReDoS heuristic: `apps/runtime/src/services/pii/pattern-service.ts` (`CATASTROPHIC_BACKTRACKING_PATTERNS`)
