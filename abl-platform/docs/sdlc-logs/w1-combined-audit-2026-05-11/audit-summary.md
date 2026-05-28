# W1 Combined Audit Report — 2026-05-11

**Auditor:** codex gpt-5.5 (reasoning effort: high)
**Worktree:** `/tmp/w1-audit-codex` (base: `origin/develop` at `27cd08b1e5`)
**Tokens used:** 1,136,143
**Note:** Full report could not be written by codex due to read-only sandbox; this summary is reconstructed from `/tmp/w1-audit-codex/CODEX_LAST_MESSAGE.txt` and `/tmp/w1-audit-codex/audit-run.log`.

## Verdict per PR

| PR                                     | Verdict         | CRITICAL | HIGH | MEDIUM | LOW |
| -------------------------------------- | --------------- | -------: | ---: | -----: | --: |
| W1.1 ABLP-946 — Arch one-shot RPC      | PASS-with-fixes |        0 |    3 |      0 |   1 |
| W1.2 ABLP-945 — Eval token rollup      | PASS-with-fixes |        0 |    1 |      2 |   0 |
| W1.3 ABLP-973 — Arch as internal agent | **FAIL**        |    **1** |    3 |      0 |   1 |
| W1.4 ABLP-947 — Session.source ext     | PASS-with-fixes |        0 |    0 |      3 |   0 |

## CRITICAL findings (block merge)

### W1.3-C1 — Service-token project scope is not enforced (authorization bypass)

**Location:** `apps/studio/src/app/api/internal/arch-ai/invoke/route.ts`
**Evidence:**

- Line 42: route accepts `input.projectId` (user-controlled)
- Line 84: only extracts `{ tenantId, serviceName }` from the service token
- Line 117: calls `oneshotArchGenerate({ tenantId, userId: serviceUserId }, input.spec, ...)` — never compares `input.projectId` against the token's projectId claim, never loads the requested project by tenant to check existence, never returns a non-leaky 404 on mismatch.

**Impact:** A workflow-engine service token issued for project A can call this endpoint with `projectId: B` and operate against B. Resource Isolation invariant (CLAUDE.md Core Invariant #1) violated. The existing platform pattern (`PROJECT_SCOPE_MISMATCH` → 404, see `apps/runtime/src/__tests__/auth/middleware/rbac.test.ts:336` and `apps/runtime/src/__tests__/internal-service-auth-tenant-cross-check.test.ts:88`) is the canonical reference.

**Fix:** Either (a) require the service token to carry a `projectId` claim and compare with `input.projectId`, returning 404-style `PROJECT_SCOPE_MISMATCH` on mismatch, or (b) load the project by `{_id: input.projectId, tenantId}` and 404 if not found.

## HIGH findings (must fix before merge)

### W1.1-H1, W1.3-H1 — One-shot Arch path collects events in memory instead of using the observed/audit stream

The one-shot orchestrator collects Arch events in memory rather than routing through the observed/audit stream path the multi-turn flow uses. Result: **TraceEvent parity gap** — the durable observability the SSE path provides isn't preserved. Compliance posture and post-hoc trace querying both affected.

**Fix direction:** Reuse the existing stream observer (`apps/studio/src/lib/arch-ai/stream-observer.ts`) to write events through the same persistence path the SSE handler uses; collect a separately-handled return value rather than building the response from in-memory event capture.

### W1.1-H2, W1.3-H2 — In-process timers / loop state across async waits

The one-shot orchestrator uses in-process timers and accumulates loop state across `await`s during the INTERVIEW → BLUEPRINT → BUILD pipeline. This is at the HTTP handler boundary (bounded by the 180s endpoint timeout) so it isn't the same severity as the agent-runtime invariant — but it does add an in-flight memory cost and a fragility if the Studio pod restarts mid-request.

**Note vs CLAUDE.md Core Invariant #4 (Stateless Agent Runtime):** The invariant strictly targets agent DSL execution in `apps/runtime`, not Studio HTTP handlers. This finding is a "design smell" not a strict invariant violation. **However:** the codex finding is worth taking seriously — if Arch generation needs to run >180s for complex SOPs, this design caps it. Migrating to a workflow-engine-backed durable orchestration would fix both the latency cap and the restart fragility.

### W1.3-H3 — `system/arch` declares `requiredPermissions: ['project:write']` but runtime shortcut doesn't enforce it

`packages/arch-ai/src/system-agent.ts` declares the system agent requires `project:write`. The runtime shortcut path in `apps/runtime/src/services/execution/system-agent-handler.ts` invokes Arch via DELEGATE without enforcing this permission. A FLOW with DELEGATE to `system/arch` from a project where the caller lacks `project:write` would currently succeed.

**Fix:** At `handleSystemAgentDelegate`, check `requiredPermissions` against the calling agent's project-scope permissions before dispatch.

### W1.2-H1 — Visibility taxonomy widening may regress existing `accumulateResponseProvenance` callers

The W1.2 reconcile widened `INTERNAL_ONLY_PURPOSES` and `INTERNAL_ONLY_OPERATION_TYPES` in `packages/shared-kernel/src/response-provenance.ts` to include runtime contexts like `engine_decision`, `routing`, `eval_judge`, `validation`, `tool_selection`, `summarization`, `coordination`. This is a behavior change in `accumulateResponseProvenance` (used by existing `responseProvenance` accumulation, not just the new rollup): events previously classified `customer_visible` now classify `internal_only`.

**Fix:** Audit every consumer of `accumulateResponseProvenance` to confirm the widening is safe. Specifically check the produce-LLM-disclosure logic; if a response was attributed `kind: 'llm'` because a `routing` event used to be `customer_visible`, that attribution may shift to `scripted` after the change.

## MEDIUM findings

### W1.2-M1 / W1.2-M2 — (unspecified in codex summary; likely lockfile/migration concerns)

Codex flagged 2 medium findings but did not enumerate them in the final summary. Likely candidates from the diff scan: (a) ClickHouse migration ALTER TABLE doesn't backfill historical rows; (b) `RunSummary.estimatedCost` field is additive but consumers querying older runs see `0` until backfill or new runs land. Manual verification recommended.

### W1.4-M1 / M2 / M3 — (unspecified)

Codex flagged 3 medium findings on W1.4 but did not enumerate. Likely candidates: (a) the `hasHttpTestContextPermission` silent-drop pattern is a deviation from typical structured-error rejection; document it; (b) the analytics filter default of `['production']` is hard-coded — a tenant might want `['production', 'eval']` as default for internal QA; (c) Studio UI tests for the new filter may be thin. Manual verification recommended.

## LOW findings

### W1.1-L1 — Two-dot vs three-dot diff confusion

Codex flagged `W1.1/W1.2 are not based on current origin/develop; the requested two-dot diffs show ~24.6k apparent deletions each`. This is because develop moved between the rebase and the audit (develop is at `27cd08b1e5`; W1.1 merge-base with develop is at `2cc6fa88f2`). Not a real issue — three-dot diff (`origin/develop...feat/ablp-arch-oneshot-rpc`) is clean. **However**: rebasing W1.1, W1.2 onto the latest develop before merge is a good hygiene step.

### W1.3-L1 — System agent test coverage thin on negative paths

`apps/runtime/src/__tests__/system-agent-handler.test.ts` covers happy-path delegate but not cross-tenant projectId, missing permissions, or stale-spec cases. Add at least three negative-path tests.

## Cross-PR composition

### W1.3 vs W1.1 contract

Success payloads (`{ projectId, agents[], topology }`) compatible. **Auth and trace guarantees diverge:** W1.1's HTTP route uses `requireTenantAuth` (user JWT); W1.3's internal route uses `verifyServiceToken` but lacks the project-scope check (W1.3-C1 above). Trace events differ — W1.3 path emits `delegate_start`/`delegate_complete` with `systemAgent: true` but does not emit Arch's own pipeline trace events (the H1 finding).

### W1.2 + W1.4 composition

**Intent sound and consistent.** Eval sessions are tagged `knownSource: 'eval'` (W1.4), excluded from billing rollups by default (W1.4), and the agent-under-test cost is still summed for `RunSummary.estimatedCost` (W1.2) — two systems writing to different ledger surfaces from the same trace stream. No double-count, no miss.

### Authorization model alignment (end-to-end)

- **External SDK caller (no `hasHttpTestContextPermission`)** → `knownSource` field silently dropped, defaults to `production`. **OK** (W1.4 design).
- **Internal pipeline-engine caller** → auto-tags eval via `eval-runtime-request.ts`. **OK** (W1.4 design).
- **Service token from workflow-engine to Arch invoke endpoint** → **FAIL** (W1.3-C1: no projectId scope check).

### Trace event consistency

W1.1, W1.2, W1.4 emit expected events. **W1.3 has a trace gap** (H1) — the delegate path doesn't propagate Arch's own pipeline trace events.

### Merge feasibility

Likely conflicts on rebase to latest develop:

- `apps/runtime/src/services/execution/types.ts` (W1.3 + W1.4)
- `apps/runtime/src/services/runtime-executor.ts` (W1.3 + W1.4)
- `packages/i18n/locales/en/studio.json` (W1.4 + general develop churn)
- `packages/arch-ai/src/index.ts` (W1.1 + W1.3)
- `pnpm-lock.yaml` (universal)

## Recommended merge order

1. **W1.4 first** — smallest cross-cutting risk, base is current develop, behavior-only change. Lowest blast radius.
2. **W1.2 second** — bug fix, narrow blast radius, depends on H1 audit of `accumulateResponseProvenance` consumers being clean.
3. **W1.1 third** — unblocks W1.3 once base is rebased onto latest develop. Address H1 + H2 first (TraceEvent parity + design smell).
4. **W1.3 last** — only after the CRITICAL authorization bypass is fixed AND the system-agent permission enforcement is added.

## Recommendations to act on now

1. **Block W1.3 merge** until C1 is fixed. This is non-negotiable — it's an authorization bypass against the platform's #1 invariant.
2. **Rebase W1.1, W1.2 onto current origin/develop** before opening PRs to clear the two-dot-diff noise the audit flagged.
3. **Address W1.2-H1** by auditing every `accumulateResponseProvenance` consumer to confirm the widened internal-only list doesn't regress disclosure semantics.
4. **Decide on W1.1-H1/H2 / W1.3-H1/H2 in-memory orchestration** — fix in this iteration or accept and file follow-up for workflow-backed migration.
5. **Add system-agent permission check** (W1.3-H3) in the same change as the C1 fix.

## Logs

- Full codex transcript: `/tmp/w1-audit-codex/audit-run.log` (~1.8 MB)
- Last-message summary: `/tmp/w1-audit-codex/CODEX_LAST_MESSAGE.txt`
