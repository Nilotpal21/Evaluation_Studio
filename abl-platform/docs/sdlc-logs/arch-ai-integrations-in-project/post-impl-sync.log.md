# Post-Implementation Sync — Arch AI In-Project Integrations (ABLP-162)

**Date:** 2026-05-06
**Branch:** `zarch/newtools`
**Tracking:** ABLP-162
**Feature flag:** `ARCH_INTEGRATIONS_V1`

## Status Transition

PLANNED → **ALPHA**

- Implementation phases 0–7 complete and committed (66 ABLP-162 commits).
- Behind feature flag `ARCH_INTEGRATIONS_V1`; not promoted to BETA.
- Promotion to BETA blocked on E2E fixture work (see Remaining Gaps).

## Documents Updated

| Document                                                                      | Change                                                                                |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `docs/superpowers/specs/2026-05-05-arch-ai-integrations-in-project-design.md` | Status: Design → ALPHA (impl complete); tracking: TBD → ABLP-162; added Last Updated. |
| `docs/superpowers/plans/2026-05-05-arch-ai-integrations-in-project.md`        | Added Status: DONE block + Last Updated.                                              |
| `docs/sdlc-logs/arch-ai-integrations-in-project/post-impl-sync.log.md`        | New (this file).                                                                      |
| `packages/arch-ai/agents.md`                                                  | Appended package-level learnings from this feature.                                   |

> No `docs/features/<slug>.md` or `docs/testing/<slug>.md` artifact existed for this feature — its canonical spec/plan live under `docs/superpowers/`. Both updated in place.

## Phase Summary (representative commits)

| Phase                                | Highlight                                                                                                              | Representative SHA                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 0 — Runtime MCP cache hook           | `resetProjectInit`, internal route + service-auth, Studio invalidation helper                                          | `cd0f5f8fc1`, `9951712f6b`, `f2e0feadd1`                                           |
| 1 — Schema + sanitizer               | `IntegrationDraft` field extension; `sanitize-tool-error.ts` (with FQDN + stack-trace redaction)                       | `d56d05426a`, `f9bbafff25`, `a8d2c0f98e`, `fdf88205b9`                             |
| 2 — Tools                            | `auth_ops` 9 auth types + collision recovery; `connection_ops`; `integration_ops:revalidate`; runtime MCP-cache wiring | `d661ae81bb`, `55ca9fe484`, `4217365a19`, `ea507c4769`, `19ec712bad`               |
| 3 — Knowledge + routing              | 3 L2 cards; content-router SaaS regex; pageContext `integration_draft`                                                 | `dc98959419`, `2718036cbb`, `3c407b2443`, `424fdd348d`, `c96915dc64`               |
| 4 — Prompt loaders                   | `projectStateSummaryLoader` + `activeDraftSnapshotLoader`                                                              | `34c7ba1224`                                                                       |
| 5 — Widgets / events                 | `OAuthLaunch`, `IntegrationPlan`, `IntegrationSuggestionCard`, turn-events extension                                   | `22f66be2cc`, `c04fdbd68c`, `4ba1ffc531`, `dc1f642651`, `d61bb1af3c`, `377e471c50` |
| 6 — Routes + store + artifact tab    | drafts list + resume routes; store `prefillMetadata`; `IntegrationArtifactView`; ArchOverlay tab                       | `40645f9495`, `0a3c5b48e5`, `945893a9cd`, `258605c833`, `fbff288c2f`               |
| 7 — Suggestion engine + E2E scaffold | hints registry + suggestion engine; 7 E2E specs scaffolded; rollout doc                                                | `42bbf52444`, `fd987765f5`, `59c27619c2`, `52f0938548`, `9cfeae875e`               |
| Bonus — A2A Spec 1                   | external_agent_ops + auth-aware test_connection + adaptiveness layer                                                   | `2fd9cc13e8`, `dc67ee60f9`, `7ce9080c3b`, `1cc2940c46`                             |
| Cleanup                              | pr-review LOW + HIGH fixups; latent Phase-3 test repair; A2A acceptance log                                            | `f27fb489a3`, `34258636b4`, `88fc8c0cbd`, `16dc5f5924`, `97f3274a6f`               |

## Coverage Delta

| Type              | Before | After                                       | Notes                                                                                                                                                                                                                                                                                                                                                           |
| ----------------- | ------ | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit tests        | 0      | ~25 (arch-ai integ surface)                 | sanitize-tool-error, integration-hints, IntegrationSuggestionCard, IntegrationPlan, OAuthLaunch, WidgetRenderer, IntegrationArtifactView, content-router (integ patterns), card-router (3 new L2), arch-integration-draft model, integration-draft-service, suggestions-engine, integration-suggestion-emit, runtime-support, propose-apply-modification fixups |
| Integration tests | 0      | 4 (Studio routes + tools)                   | `integ-drafts-route.test.ts`, `integ-drafts-resume-route.test.ts`, `auth-ops.test.ts` (collision recovery), `connection-ops.test.ts`, `revalidate-action.test.ts`, `mcp-server-ops.test.ts`, `engine-factory-in-project-tools.test.ts`                                                                                                                          |
| E2E tests         | 0      | 0 effective (7 scaffolded, all `test.skip`) | Specs land in `apps/studio/e2e/arch-ai-integrations/` — saas-oauth, rest-api, mcp-server, revalidate, suggestion, collision, sanitization. Lifting skip blocked on three fixture files.                                                                                                                                                                         |

> Per quality gate: skipped specs do **not** count toward E2E coverage. The matrix above marks them as 0 effective.

## Test File Mapping

| Concern                                                                   | Test                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sanitizer redaction (URLs, creds, UUIDs, FQDNs, stack traces, file paths) | `apps/studio/src/lib/arch-ai/__tests__/sanitize-tool-error.test.ts`                                                                                                                                                              |
| Hints registry + provider matching                                        | `apps/studio/src/lib/arch-ai/__tests__/integration-hints.test.ts`                                                                                                                                                                |
| Suggestion computation + page bias                                        | `apps/studio/src/lib/arch-ai/processors/__tests__/suggestions-engine.test.ts`, `integration-suggestion-emit.test.ts`                                                                                                             |
| Project-state + active-draft prompt loaders                               | `apps/studio/src/lib/arch-ai/processors/__tests__/runtime-support.test.ts`                                                                                                                                                       |
| Drafts list / resume routes                                               | `apps/studio/src/__tests__/arch-ai/integ-drafts-route.test.ts`, `integ-drafts-resume-route.test.ts`                                                                                                                              |
| Draft service incl. `syncActiveDraftFromConnection`                       | `apps/studio/src/__tests__/arch-ai/integration-draft-service.test.ts`                                                                                                                                                            |
| auth_ops collision recovery + 9 auth types                                | `apps/studio/src/lib/arch-ai/tools/__tests__/auth-ops.test.ts`                                                                                                                                                                   |
| connection_ops 5 actions                                                  | `apps/studio/src/lib/arch-ai/tools/__tests__/connection-ops.test.ts`                                                                                                                                                             |
| integration_ops:revalidate (incl. oauth_grant_missing detection)          | `apps/studio/src/lib/arch-ai/tools/__tests__/revalidate-action.test.ts`                                                                                                                                                          |
| MCP cache invalidation (in-flight promise)                                | `apps/runtime/src/__tests__/.../in-flight reset` (`a2e26ecbde`)                                                                                                                                                                  |
| In-project tool registration (4 newly wired)                              | `apps/studio/src/__tests__/arch-ai/engine-factory-in-project-tools.test.ts`                                                                                                                                                      |
| 3 L2 knowledge cards regex                                                | `packages/arch-ai/src/knowledge/__tests__/{integration-setup-workflow,oauth-flow-primer,integration-failure-diagnosis}.test.ts`                                                                                                  |
| Content-router SaaS / verb / setup / auth patterns                        | `packages/arch-ai/src/coordinator/__tests__/content-router.test.ts`                                                                                                                                                              |
| pageContext `integration_draft` bias                                      | `packages/arch-ai/src/__tests__/engine/coordinator-bridge-in-project-context.test.ts`                                                                                                                                            |
| Draft model FIFO eviction + new fields                                    | `packages/database/src/__tests__/arch-integration-draft.test.ts`                                                                                                                                                                 |
| Widgets render + dispatch                                                 | `apps/studio/src/lib/arch-ai/components/arch/widgets/__tests__/{OAuthLaunch,IntegrationPlan,WidgetRenderer}.test.tsx`, `cards/__tests__/IntegrationSuggestionCard.test.tsx`, `panels/__tests__/IntegrationArtifactView.test.tsx` |
| Turn events + dispatcher (suggestion variant)                             | `apps/studio/src/lib/arch-ai/ui/__tests__/event-dispatcher.test.ts`                                                                                                                                                              |
| Store `prefillMetadata` + integration tab                                 | `apps/studio/src/lib/arch-ai/store/__tests__/arch-ai-store.test.ts`                                                                                                                                                              |

## Deviations from Plan

1. **Decision pivot (during design):** v1 produces HTTP-typed `ProjectTool`s only; Activepieces-typed connector tools deferred to v2. Captured in design §1 (Decision A).
2. **L2 cards instead of specialist prompt loading (Decision B):** `composeInProjectPrompt` always uses GENERALIST in IN_PROJECT mode, so the methodologist's prompt would not have been loaded. Closed the gap by routing 3 new L2 cards via `card-router` regex.
3. **Phase 0 task 0.1 retest:** initial test passed even with the fix reverted (vacuous). Rewrote to issue a second `ensureProjectServers` before the first resolves; verified by revert.
4. **Phase 0 task 0.2 auth correction:** first cut used `requireInternalNetworkAccess`; reviewer flagged. Corrected to `requireServiceAuth` + `rejectIfTokenMismatch` with `createServiceToken` signing (commit `f2e0feadd1`).
5. **Sanitizer dead-code fix:** `extractMessage` originally returned `err.message` only — `STACK_TRACE_LINE` / `FILE_PATH` regexes never fired. Fixed to read `err.message + err.stack`; widened internal-FQDN regex (commit `fdf88205b9`).
6. **Permissions adapted to actual codebase:** `connection_ops` uses `connection:read/write/delete` (not the spec's `project:integration:*`).
7. **Connection-service signature:** spec described named-arg create; actual signature is positional `getConnectionService().create(tenantId, projectId, input, userId)` with required `displayName` (defaults to `connectorName`).
8. **Dynamic-options endpoint path:** corrected to `…/actions/[actionName]/props/[propName]/options` and `…/dynamic-fields` (not `/dynamic-props`).
9. **Commitlint scope:** `arch-ai` is not an allowed scope; arch-ai-only changes commit under `shared`.
10. **A2A Spec 1 (bonus):** delivered alongside in scope (analytics_ops, deployment_ops, agent_ops, testing_ops wiring + external_agent_ops + auth-aware test_connection + adaptiveness polish). Tracked under same ticket.

## Remaining Gaps (must clear before BETA)

- **E2E fixtures missing.** All 7 specs are `test.skip` until:
  - `apps/studio/e2e/fixtures/mock-oauth-provider.ts`
  - `apps/studio/e2e/fixtures/mock-rest-endpoint.ts`
  - `apps/studio/e2e/fixtures/mock-mcp-server.ts`
  - `apps/studio/e2e/fixtures/integration-project.ts`
  - `apps/studio/e2e/fixtures/shared-tenant.ts` (collision spec)
  - `data-testid` / `data-widget` selectors on Arch overlay surfaces.
- **Studio auth-profiles route**: surface E11000 → 409 mapping (filed as follow-up during impl).
- **`custom_header.headerValues` nested-record secret-store**: deferred follow-up; current `auth_ops` extension covers the 9 main auth types but the nested-record path needs secret-store handling.
- **Test architecture follow-up**: a few existing arch-ai tests still use `vi.mock` of platform components — flagged but not in scope for this feature.
- **Production soak**: feature is on a branch behind a flag, not on `develop` yet. PR + soak required before BETA.

## Promotion Criteria → BETA

1. Land 5+ E2E specs as real (unskipped) Playwright runs against fixtures above.
2. Manual walkthrough of S1 (Slack OAuth) and S5 (REST API) on a live Studio instance.
3. PR review on `zarch/newtools`; merge to `develop`.
4. Resolve E11000 → 409 mapping and `custom_header.headerValues` follow-ups (or formally defer in the design's §16).

## Auditor Pass

Phase 6b (phase-auditor) **NOT spawned** for this sync — the post-impl phase is a documentation reconciliation, the implementation already passed pr-reviewer rounds 1–5 with all CRITICAL/HIGH cleared (commits `34258636b4`, `88fc8c0cbd`, `f27fb489a3`). Re-running phase-auditor adds no new signal at this stage; promotion-time audit will run as part of BETA gate.
