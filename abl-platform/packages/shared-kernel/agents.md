# agents.md — packages / shared-kernel

Agent learning journal for this package. Append-only log of architectural decisions, patterns, gotchas, and insights discovered during SDLC work.

Agents MUST read this file before modifying code in this package. Agents MUST append learnings after completing work.

## Lifecycle Inventory — Cross-Boundary Types

These types are defined in this package but consumed at multiple boundaries across the monorepo. Adding/changing a field here without updating every consumer has historically caused multi-commit hardening sweeps. **Before editing any of these, run the Omitted-Edit Audit from `.claude/agents/pr-reviewer.md`** — list every consumer file via `rg -l --type ts -e '\bTypeName\b' apps packages` and classify each as UPDATED / CORRECT-UNCHANGED / MISSED.

| Type                                                                                                       | Defined in                                                                   | Boundaries crossed                                                                                                                          | Past incident                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `TraceEvent`, `TraceEventType`, `TraceEventDomain`, `TraceEventRegistryEntry`                              | `src/types/trace-event.ts`                                                   | runtime trace store → SDK / studio trace UI / search-ai confidence scoring / mcp-debug bridge / pipeline-engine eval / eventstore migration | Generic high-fanout; new event types or `data` shape changes silently dropped by older consumers if added without updating the union |
| `ResponseProvenance`, `ResponseProvenanceKind`, `ResponseProvenanceAccumulator`, `ResponseMessageMetadata` | `src/response-provenance.ts`                                                 | runtime session ops → redis session store → web-sdk → studio response viewer                                                                | ABLP-654 (4 fix commits): provenance metadata tail dropped at SDK boundary; tests added at `__tests__/response-provenance.test.ts`   |
| `GatherInterruptTrace`, `GatherInterruptCandidateSurface`                                                  | `src/gather-interrupt-trace.ts`                                              | runtime gather pipeline → trace store → studio gather visualizer                                                                            | Cross-layer trace shape; verify candidate surfaces serialize end-to-end                                                              |
| `ModelPricing`, `ModelRouting`, `LRUTTLCacheOptions`                                                       | `src/model-pricing.ts`, `src/model-routing.ts`, `src/cache/lru-ttl-cache.ts` | runtime model resolution → budget enforcement → model-resolution cache key                                                                  | Per `CLAUDE.md` "Model Resolution Contract" — cache keys must include the right scope (user vs settings-only)                        |

When editing any row above, also re-read the `Model Resolution Contract` section in `CLAUDE.md` and the corresponding parity test under `src/__tests__/`.

---

<!-- Append new entries below this line. Format:
## <DATE> — <Feature/Context>
**Category**: architecture | testing | pattern | gotcha | process
**Learning**: <what was learned — specific and actionable>
**Files**: <key files involved>
**Impact**: <how this affects future work in this package>
-->

## 2026-04-08 — Shared-Kernel Test Shadow Artifacts

**Category**: testing
**Learning**: Ignored `.js`/`.d.ts` artifacts under `src/` can shadow the TypeScript sources during Vitest runs because the package uses ESM-style `.js` imports from `.ts` files. Prune ignored generated artifacts from `src/` before running shared-kernel tests so local stale outputs do not override the real implementation.
**Files**: packages/shared-kernel/package.json, packages/shared-kernel/scripts/prune-source-artifacts.mjs, packages/shared-kernel/src/security/inbound-auth.ts
**Impact**: Future test failures in this package may come from local shadow artifacts instead of tracked code changes; keep `src/` TypeScript-only at test time.

## 2026-04-06 — Canonical Voice Trace Event Types

**Category**: architecture
**Learning**: Runtime UX trace events used by the SDK (`tool_thought`, `status_update`, `status_clear`) need to live in the canonical `TraceEventType` union, and `TraceEvent.data` should be documented as the primary home for event-specific fields even when older emitters still flatten fields at the top level.
**Files**: `src/types/trace-event.ts`
**Impact**: Future trace producers and consumers should treat `event.data` as canonical and keep top-level field reads only as backward-compatibility shims.

## 2026-04-17 — Workspace Package Count Ratchet

**Category**: testing
**Learning**: The shared-kernel architecture fitness gate counts package workspaces under `packages/` including nested package workspaces such as `packages/connectors/base` and `packages/connectors/sharepoint`; when package inventory changes, update both `WORKSPACE_PACKAGE_COUNT` and the scorecard comment in `src/__tests__/architecture-fitness.test.ts` together.
**Files**: `src/__tests__/architecture-fitness.test.ts`
**Impact**: Future package additions or removals should refresh the ratchet and its explanatory scorecard in the same change so CI failures stay obvious and the file does not drift into conflicting counts.

## 2026-04-19 — ABL Contract Hardening Phase 5 (canonical trace registry ownership)

**Category**: architecture
**Learning**: The stable trace-contract split is: shared-kernel owns the full event inventory, domain grouping, and runtime-emitted subset; downstream packages consume that exported registry instead of redefining narrower unions. When a new trace event is added, update `trace-event-registry.ts`, the shared-kernel contract test, and the downstream parity tests in the same slice.
**Files**: `src/constants/trace-event-registry.ts`, `src/types/trace-event.ts`, `src/index.ts`, `src/__tests__/trace-event-contract.test.ts`
**Impact**: Future trace event additions or renames should start in shared-kernel and ship with parity coverage. If a downstream package needs extra payload semantics, add them there without copying the canonical event-name union.

## 2026-04-19 — compareSemverDesc as canonical semver comparator

**Category**: architecture
**Learning**: `src/utils/semver-compare.ts` hosts the canonical `compareSemverDesc()` used by `apps/runtime` (`workflow-version-service.ts` re-exports) and `apps/workflow-engine` (`lib/semver-compare.ts` re-exports). Zero-dep implementation — the regex-gated `parseSemver()` accepts `vX.Y.Z` and `X.Y.Z` with optional `-prerelease`, rejects anything else (returns `null`). Ordering: valid semver → invalid strings → `'draft'`. Pre-release comparison matches semver §11 item 4 (numeric identifiers < alphanumeric, shorter pre-release < longer when all identifiers match). The `|| 0` guard on the final return of `compareSemverDesc` coerces `-0` → `0` so callers using `Object.is`-based equality (Vitest `.toBe(0)`) pass when pre-releases tie.
**Files**: `src/utils/semver-compare.ts`, `src/index.ts`
**Impact**: Any new workflow/agent-version sorting in the monorepo should import from `@agent-platform/shared-kernel` (root barrel) instead of depending on the `semver` npm package. Do not add the `semver` npm dep to this package — zero-dep is load-bearing for the "kernel" designation. As of 2026-04-19, Studio also consumes this comparator: `apps/studio/src/lib/semver-compare.ts` re-exports `compareSemverDesc` under the existing `compareSemverDescLocal` alias, so runtime / workflow-engine / Studio all go through this one parser. No parallel Studio implementation remains.

## 2026-04-25 — Agent Assist trace-event family (ABLP-390)

**Category**: architecture
**Learning**: The Agent Assist V1 facade adds the `agent_assist.*` trace-event family (8 events: `received`, `binding_resolved`, `delegated`, `translated_response`, `error`, `callback_scheduled`, `callback_delivered`, `callback_failed`). All eight are registered in `src/constants/trace-event-registry.ts`, exported from `src/index.ts` as the `AgentAssistTraceEventType` union, and included in `RUNTIME_EVENT_TYPES`. The `trace-event-contract.test.ts` regression asserts every member of the family is present in (a) `AGENT_ASSIST_TRACE_EVENT_TYPES`, (b) the registry's domain grouping, and (c) the runtime event-type union — keep that as a feature. The earlier `agentic_compat.*` family was renamed to `agent_assist.*` in the same slice that retired the POC kill-switch — the rename touches all three places at once and the contract test catches any drift.
**Files**: `src/constants/trace-event-registry.ts`, `src/index.ts`, `src/__tests__/trace-event-contract.test.ts`
**Impact**: Adding a new trace-event family: add the SCREAMING_SNAKE constant array, derive a TS union type, add the union to `RUNTIME_EVENT_TYPES`, export from the barrel, and add the appropriate rows to the contract test in the same change. Skipping any of these causes the contract test to fail loudly.

## 2026-04-27 — Internal-network trust list ≠ SSRF outbound deny-list

**Category**: gotcha
**Learning**: `BLOCKED_IPV4_CIDRS` (in `src/security/ssrf-validator.ts`) is the SSRF _outbound deny-list_ — it includes RFC 1918 plus reserved/test-net ranges (`198.51.100.0/24`, `203.0.113.0/24`, `192.0.0.0/24`, `198.18/15`, `224/4`, `240/4`) and link-local (`169.254.0.0/16`, which contains cloud metadata). Do NOT reuse `isPrivateIP()` to decide whether an `X-Forwarded-For` hop is a trustworthy internal proxy — that lets a public source IP from a reserved range forge an internal hop and bypass `requireInternalNetworkAccess`. Use the dedicated `isInternalTrustedIP()` predicate (also in `ssrf-validator.ts`), which matches only RFC 1918 (10/8, 172.16/12, 192.168/16), loopback (127/8 / `::1`), IPv6 ULA (`fc00::/7`), and link-local (`fe80::/10`) — the actual "internal" set. `internal-network.ts` consumes `isInternalTrustedIP` for this reason.
**Files**: `src/security/ssrf-validator.ts`, `src/security/internal-network.ts`, `apps/runtime/src/__tests__/internal-network-middleware.test.ts`
**Impact**: When adding a new "is this IP trusted-internal?" call site, import `isInternalTrustedIP`. When tightening the SSRF deny-list (adding more reserved ranges to `BLOCKED_IPV4_CIDRS`), `isPrivateIP` automatically picks them up but `isInternalTrustedIP` does NOT — that asymmetry is intentional. Keep it that way.

## 2026-04-27 — `safeFetch` lives at a node-only subpath, not the security barrel

**Category**: architecture
**Learning**: `safeFetch`, `assertUrlSafeForFetch`, and `SSRFError` are exported from `@agent-platform/shared-kernel/security/safe-fetch` (subpath), NOT from the `@agent-platform/shared-kernel/security` barrel. The reason: `safe-fetch.ts` imports `node:dns/promises`, `node:http`, `node:https` — Studio's Next.js Turbopack build fails with "the chunking context (unknown) does not support external modules (request: node:dns/promises)" if those node-only imports leak into a client bundle. The `./security/safe-fetch` package.json export keeps node:\* out of the barrel, and the barrel keeps the synchronous `assertUrlSafeForSSRF` (URL-shape only) reachable from anywhere.
**Files**: `packages/shared-kernel/package.json` (`exports['./security/safe-fetch']`), `src/security/safe-fetch.ts`, `src/security/index.ts`
**Impact**: Any new code importing `safeFetch`/`assertUrlSafeForFetch` must use the subpath. Tests mocking these must `vi.mock('@agent-platform/shared-kernel/security/safe-fetch', ...)` — the old `security` barrel mock silently no-ops. When adding new node-only utilities, keep them out of the security barrel and add a dedicated subpath export.

## 2026-04-27 — SOAP Tool Support Phase 1a (form type extension)

**Category**: architecture
**Learning**: `HttpToolFormData` in `project-tool-form.ts` is re-exported by `packages/shared/src/types/project-tool-form.ts` — adding optional fields here propagates automatically to the shared package without needing to update the re-export. New fields should use camelCase (matching existing form conventions) and be optional to maintain backward compatibility.
**Files**: `src/types/project-tool-form.ts`
**Impact**: When adding optional fields to tool form types, verify the shared package re-export file still covers the types you need. No re-export change needed for optional field additions to existing interfaces.

---

**Category**: bug | gotcha
**Learning**: `normalizeHttpAuthConfig()` previously preserved inline `apiKey` and `token` secrets in the normalized output even when `hasAuthProfileRef` was true. This caused literal credentials to be written to the tool DSL alongside the auth profile reference, which (a) is a security smell and (b) caused false-positive `LITERAL_AUTH_VALUE` publish-safety violations. When adding new "profile takes precedence over inline" logic to any normalizer, check ALL auth type branches — the fix guarded `api_key` and `bearer` but not `oauth2_client`/`oauth2_user` client secrets (lower risk since those flows don't use inline secrets in practice).
**Files**: `src/utils/http-auth-config-normalizer.ts`
**Impact**: A single comment on `hasAuthProfileRef` at the point of its declaration is sufficient — don't duplicate the reason across every branch that uses it.

---

## 2026-05-20 — PII Trace Event Family Expansion (ABLP-535 meta-review)

**Category**: architecture
**Learning**: The PII trace event family (`PII_TRACE_EVENT_TYPES` in `trace-event-registry.ts`) now has 4 members: `pii_plaintext_dispensed` (original), `pii_audit_missing_tenant` (F-10 sentinel fallback), `pii_pattern_override_suppressed_original` (F-11 suppression warning), and `workflow_unprotected_pii_dispatched` (F-7 safety-net detection). The first three are emitted by the runtime via `onTraceEvent` and must be in `RUNTIME_EVENT_TYPES`. The fourth is emitted by the workflow engine via `log.warn()` only (not yet a trace event) and must NOT be in `RUNTIME_EVENT_TYPES`.

When adding new PII-related trace events: add to `PII_TRACE_EVENT_TYPES`, which automatically propagates to `TRACE_EVENT_GROUPS.pii`, `ALL_TRACE_EVENT_TYPES`, and `TRACE_EVENT_REGISTRY` via `registryEntriesForDomain('pii', ...)`. Only add to `RUNTIME_EVENT_TYPES` if the event is emitted by the runtime (not by other services). The `trace-event-contract.test.ts` will catch missing entries.

**Files**: `src/constants/trace-event-registry.ts`, `src/__tests__/trace-event-contract.test.ts`
**Impact**: When adding runtime-emitted trace events, update both `PII_TRACE_EVENT_TYPES` (or the appropriate domain array) and `RUNTIME_EVENT_TYPES`. Missing the `RUNTIME_EVENT_TYPES` entry causes the `emittedByRuntime` registry flag to be `false`, which misclassifies the event's origin in dashboards.
