# Feature Spec Log — Prompt Library

**Feature slug:** `prompt-library`
**Phase:** 1 (Feature Spec)
**Started:** 2026-04-27
**Author:** prasanna@kore.com (driven by Claude Code SDLC pipeline)

---

## Inputs

- User request: "build prompt library under Resources — manage prompts, version them, refer in agents, test side-by-side against models"
- Brainstorm round produced 9 locked design decisions (D-1 through D-9) before invoking `/feature-spec`

## Locked design decisions inherited from brainstorm

- **D-1** — Pinned reference: `SystemPromptConfig.libraryRef = { promptId, versionId, resolvedHash }`
- **D-2** — Content: single Handlebars template string + `description?` + `variables[]` + `tags[]`
- **D-3** — Test harness: single-turn (system + 1 user message → response) only
- **D-4** — Compare axes: prompt × N models AND N versions × model — no cross-product in v1
- **D-5** — Test path: Studio → runtime proxy → `ModelResolutionService.resolve()` → Vercel AI SDK `generateText()`
- **D-6** — Lifecycle: 3-state — `draft` / `active` / `archived`
- **D-7** — Storage: `PromptLibraryItem` + `PromptLibraryVersion` in `packages/database` with `tenantIsolationPlugin` (matching `WorkflowVersion`)
- **D-8** — RBAC: `prompt:create`, `prompt:read`, `prompt:update`, `prompt:delete`, `prompt:test`, `prompt:promote`
- **D-9** — UI: 4th slot in `resourceNavDefs`

## Product oracle decisions (Phase 1 clarifying questions)

Oracle agent (separate spawn) was given 13 clarifying questions across Scope (4), User Stories (4), Technical (5).

### Outcomes by classification

| Classification | Count | Notes                                                               |
| -------------- | ----- | ------------------------------------------------------------------- |
| ANSWERED       | 7     | Grounded in code evidence — no judgment needed                      |
| DECIDED        | 5     | Oracle made judgment calls; logged below                            |
| AMBIGUOUS      | 1     | A-4 priority driver — defaulted in spec, surfaced in Open Questions |

### DECIDED items (oracle judgment calls)

1. **D-A2 (NG scope)** — v1 explicitly excludes: automated prompt optimization, CI/CD eval integration, prompt chaining, prompt-as-tool. Reason: overlaps with `agent-testing-evals` (BETA) or v2+ scope.
2. **D-B1 (Personas)** — added Tester persona with `prompt:read` + `prompt:test`, matching `tester` project role pattern in `packages/shared-auth/src/rbac/role-permissions.ts:155-175`.
3. **D-B2 (UI integration)** — prompt picker in IdentityEditor (option A in oracle proposal) rather than DSL-only. Reason: better UX; existing IdentityEditor is the natural surface.
4. **D-B3 (Performance targets)** — 500ms platform overhead (not 200ms), 5 compare panes, 32KB template, 200 versions, 20 variables. Reason: realistic given HTTP-hop + credential resolution.
5. **D-C2 (Data model template)** — use `WorkflowVersion` model as template (not `AgentVersion`). Reason: `AgentVersion` lacks `tenantId`/`tenantIsolationPlugin` and relies on parent agent for scoping; that's wrong for a top-level resource. Active version is determined by query (`status: 'active'`), not by a pointer field.

### AMBIGUOUS escalation (surfaced in spec §15 Open Questions)

- **A-4 priority/timeline driver** — no explicit roadmap, customer ask, or competitive analysis artifact in repo. Defaulted in spec to "internal prompt-engineering pain + parity with PromptHub/Langfuse" for Problem Statement framing. Decision does not change build scope; only frames urgency for prioritization of P1 items (e.g., extract-to-library, cost estimation).

## Files created

- `docs/features/prompt-library.md` — feature spec (PLANNED)
- `docs/testing/prompt-library.md` — testing guide placeholder (PLANNED)
- `docs/sdlc-logs/prompt-library/feature-spec.log.md` — this log

## Files modified

- `docs/features/README.md` — added row 15a
- `docs/testing/README.md` — added row 15a

## Audit findings

### Round 1 — APPROVED with HIGH/MEDIUM fixes

- **FS-2 (HIGH)** — `SystemPromptConfig` snippet in §11 didn't match real interface (`sections` was shown optional; should be required + inline). FIXED.
- **FS-7 (HIGH)** — Data model section didn't note the reverse-reference scan against `agent_versions.irContent`. FIXED — added "Queried Existing Collections" subsection cross-referencing GAP-003.
- **FS-8 (HIGH)** — Delivery plan phase 4 lacked explicit testing subtask for Studio proxy routes. FIXED — added subtask 4.7.
- **FS-9 (MEDIUM)** — Test file `library-ref-runtime.e2e.test.ts` referenced in §17 but missing from §10 Tests table. FIXED — added row.
- **FS-10 (MEDIUM)** — README index updates not noted in delivery plan. FIXED — extended subtask 6.4.
- All Verified items passed. No CRITICAL findings.

### Round 2 — APPROVED, no blockers

- All 5 round-1 fixes verified correct (not just present).
- Cross-phase consistency verified between feature spec, testing guide, and SDLC log.
- One MEDIUM finding deferred to test-spec phase: **FR-10 reverse-reference endpoint** (`GET .../prompts/:promptId/references`) has no dedicated E2E/integration scenario yet — INT-3 tests `usageCount` but not the endpoint response shape. Will be picked up by `/test-spec`.
- No CRITICAL or HIGH findings.

## Next phase

`/test-spec prompt-library` to generate the full E2E + integration test specification.

## Open items carried forward to next phase

- A-4 priority driver (decision deferred to user during HLD/LLD if it affects scope cuts)
- DSL surface for `SYSTEM_PROMPT_REF:` directive (deferred to v2)
- Reverse-reference indexing strategy (defer to LLD)
- Streaming responses in compare mode (defer to v2)
- Test variable binding to session/agent context (defer to v2)
- Cost estimation in compare panes (defer; needs Model Hub pricing data)
