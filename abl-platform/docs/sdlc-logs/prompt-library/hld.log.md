# HLD Log — Prompt Library

**Feature slug:** `prompt-library`
**Phase:** 3 (HLD)
**Started:** 2026-04-27
**Author:** prasanna@kore.com (driven by Claude Code SDLC pipeline)

---

## Inputs

- Feature spec: `docs/features/prompt-library.md`
- Test spec: `docs/testing/prompt-library.md`
- Phase-1 log: `docs/sdlc-logs/prompt-library/feature-spec.log.md`
- Phase-2 log: `docs/sdlc-logs/prompt-library/test-spec.log.md`
- Related HLDs: `docs/specs/agent-anatomy.hld.md`, `docs/specs/agent-development-studio.hld.md`, `docs/specs/model-hub.hld.md`

## Product oracle decisions (Phase 3 clarifying questions)

Oracle agent (separate spawn) answered questions across Architecture (5), Integration (5), Risk & Migration (5).

### Outcomes by classification

| Classification | Count | Notes                                                                |
| -------------- | ----- | -------------------------------------------------------------------- |
| ANSWERED       | 10    | Grounded in codebase — file/line cited                               |
| DECIDED        | 5     | Oracle made judgment calls within established patterns; logged below |
| INFERRED       | 0     | All inferences confirmed by direct code evidence                     |
| AMBIGUOUS      | 0     | No escalations needed                                                |

### DECIDED items (oracle judgment calls)

1. **Architecture choice (D-1)**: Option A (runtime-native, Studio proxy) over Option B (Studio-owned) and Option C (microservice). Runtime owns credential/budget governance; Studio isolation invariants satisfied.
2. **Compile integration (D-2)**: Pre-compile hook in `VersionService.createVersion()`, not in the compiler itself. Compiler (`compileABLtoIR()`) stays pure.
3. **usageCount placement (D-3)**: Service layer (post-compile hook), not compiler. Compiler is pure.
4. **Feature gate (D-4)**: Enabled by default; `requireFeature()` available for soft-launch if needed. RBAC is the primary access gate.
5. **Test endpoint architecture (D-5)**: `Promise.all` over pane tasks with per-pane `AbortController`, partial failure returns HTTP 200 with `failedPanes[]`.

### Key code references discovered

| Concern                    | Reference                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Studio proxy helper        | `apps/studio/src/lib/runtime-proxy.ts:39` (`proxyToRuntime()`)                                                  |
| Feature gate exports       | `apps/runtime/src/middleware/feature-gate.ts:63` (`requireFeature()`), `:146` (`createFailClosedFeatureGate()`) |
| Template engine            | `packages/shared/src/prompts/template-engine.ts:101` (`renderTemplate()`)                                       |
| Audit helpers              | `apps/runtime/src/services/audit-helpers.ts` (wrapper over `audit-store-singleton.ts`)                          |
| Optimistic promote pattern | `apps/runtime/src/services/version-service.ts` (`promoteVersion()`)                                             |
| ModelResolutionService     | `apps/runtime/src/services/llm/model-resolution.ts` (`ModelResolutionService.resolve()`)                        |
| PERMISSION_REGISTRY        | `packages/shared-auth/src/rbac/role-permissions.ts` (`PERMISSION_REGISTRY`)                                     |
| tenantIsolationPlugin      | `packages/database/` (WorkflowVersion pattern)                                                                  |

## Files created / modified

### Created

- `docs/specs/prompt-library.hld.md` — full HLD (576 lines, 3 audit rounds, APPROVED)
- `docs/sdlc-logs/prompt-library/hld.log.md` — this log

## Audit findings

### Round 1 — APPROVED with HIGH/MEDIUM fixes

- **HD-2 (HIGH)**: §7 Feature Gate used non-existent `createFeatureGate()`. FIXED — updated to `requireFeature()` / `createFailClosedFeatureGate()`.
- **HD-3 (MEDIUM)**: Compiler component diagram annotation ambiguous. FIXED — clarified `ir/schema.ts (modified — type-only, compileABLtoIR() unchanged)`.
- **HD-6 (MEDIUM)**: §10 References had stale line numbers. FIXED — replaced with function names only; added `feature-gate.ts` entry.

### Round 2 — APPROVED with HIGH/MEDIUM fixes

- **HD-4a (HIGH)**: `PromptLibraryItem` schema missing `nextVersionNumber` counter (needed for TOCTOU-safe version assignment). FIXED — added field with `$inc` semantics.
- **HD-4b (HIGH)**: Promote two-step atomicity window not documented. FIXED — §4 Concern #6 now explicitly documents the transient dual-active window and defers transaction-vs-accepted-window decision to LLD.
- **HD-8a (MEDIUM)**: Audit section referenced `getAuditStore()` directly rather than `audit-helpers.ts` wrappers. FIXED.
- **HD-4c (MEDIUM)**: Item-level archive semantics underspecified. FIXED — schema note clarifies manual archive via `PATCH .../prompts/:promptId`, v1.

### Round 3 — APPROVED, no blockers

- HIGH/CRITICAL: None.
- All R1 + R2 fixes verified correct.
- All 15 FRs traced to HLD sections.
- Two MEDIUM items deferred to LLD:
  - New audit helper functions needed in `audit-helpers.ts` (`auditPromptCreated`, `auditPromptVersionPromoted`, etc.)
  - Item-level archive transition semantics (one-way vs reversible) to be specified in LLD.

## Next phase

`/lld prompt-library` to generate the phased implementation plan.

## Open items carried forward

- GAP-003: reverse-reference query latency for projects with >1000 agents — addressed in open question §9.1 (start with query-time scan, add denormalized collection if needed)
- Promote atomicity strategy (transaction vs accepted window) — deferred to LLD, must be resolved in INT-1
- versionNumber assignment race (findOneAndUpdate $inc vs max()+1) — deferred to LLD; recommendation in §9.4
- Item-level archive transition semantics — deferred to LLD
