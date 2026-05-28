# SDLC Log — HLD — SOAP Tool Support

**Feature**: SOAP Tool Support (sub-feature of Tool Invocations)
**Slug**: `soap-tool-support`
**Phase**: HLD
**Date**: 2026-04-27
**Author**: Claude Code (Opus 4.7) on behalf of `karthikeya.andhoju@kore.com`

---

## 1. Inputs

- Feature spec: `docs/features/sub-features/soap-tool-support.md` (PLANNED, 13 FRs).
- Test spec: `docs/testing/sub-features/soap-tool-support.md` (10 E2E + 7 INT + 26 unit + 12 sec scenarios).
- Parent HLD: `docs/specs/tool-invocations.hld.md` (STABLE — established the dispatcher + type-specific executor + middleware-chain pattern).
- Design quality gate: `.claude/skills/design-quality-gate.md` (12 architectural concerns).
- Pipeline reference: `docs/sdlc/pipeline.md`.
- Design-lint script: `tools/design-lint.sh` (has a known `set -e` + `((var++))` bug; manual-grep replication used for verification).

## 2. Clarifying Questions — Product Oracle Output

15 questions across Architecture & Data Flow, Integration & Dependencies, Risk & Migration. **Zero AMBIGUOUS items.**

| #   | Topic                       | Classification | Decision                                                                                                                                                                                                                                                      |
| --- | --------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Credible alternatives       | ANSWERED       | All 4 (a-d) are credible, not strawmen. Selected (a) protocol discriminator + branch in `HttpToolExecutor`.                                                                                                                                                   |
| A2  | Request-path data flow      | INFERRED       | Approximately correct, but the _vehicle_ for `wsSecurityCredentials` between middleware and executor needs an explicit decision (eventually flipped from `ctx.metadata` to a transient `tool.http_binding._wsSecurityCredentials` field — see Round-2 audit). |
| A3  | Scale & XML parse budget    | DECIDED        | "SOAP shares the same per-tool circuit breaker / rate limiter / keep-alive pool budget as REST" stated explicitly; XML parse capped by `HTTP_TOOL_MAX_RESPONSE_BYTES` and `HTTP_TOOL_SOAP_PARSER_MAX_DEPTH`.                                                  |
| A4  | Pattern deviations          | DECIDED        | Both deviations (branch-in-executor, credential-outside-standard-patch-surface) are justified — SOAP is HTTP, WS-Security is XML-body-level.                                                                                                                  |
| A5  | Deployment topology         | ANSWERED       | Code-only changes; no new service / worker / queue.                                                                                                                                                                                                           |
| I1  | Upstream deps               | INFERRED       | Complete; explicit dependency callouts for `agent-based-parser.ts` denylist and `safe-fetch`.                                                                                                                                                                 |
| I2  | Downstream consumers        | ANSWERED       | None — agent builders only.                                                                                                                                                                                                                                   |
| I3  | Frozen tool-shape consumers | INFERRED       | No breaking change. Project import/export, A2A bundle, IR compilation, MCP discovery all backward-compatible.                                                                                                                                                 |
| I4  | Compile vs execute time     | ANSWERED       | Execute time. Compilation stores fields verbatim; envelope rendering happens per-call.                                                                                                                                                                        |
| I5  | Breaking changes            | ANSWERED       | None — all four IR fields optional with defaults; `ToolAuthResult` extension is additive.                                                                                                                                                                     |
| R1  | Top technical risk          | DECIDED        | (b) `wsSecurityCredentials` propagation gap > (a) XXE > (c) namespace-prefix miss > (d) REST regression. Mitigation: FR-13 in Phase 1 + INT-3 gate.                                                                                                           |
| R2  | Data migration              | ANSWERED       | None — zero SOAP tools in production.                                                                                                                                                                                                                         |
| R3  | Rollback strategy           | DECIDED        | Code revert; orphaned SOAP tools acceptable; no feature flag.                                                                                                                                                                                                 |
| R4  | Phased rollout              | DECIDED        | None. Opt-in authoring + per-tenant breaker provide adequate gating.                                                                                                                                                                                          |
| R5  | Blast radius                | ANSWERED       | Per-tenant + per-tool, isolated. Zero cross-tenant blast.                                                                                                                                                                                                     |

## 3. Phase-Auditor Rounds

### Round 1 — APPROVED with HIGH/MEDIUM findings

| Severity       | Finding                                                                                                                                                       | Resolution                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| HIGH [HD-6]    | `patchToolWithResolvedAuth()` mechanism described inaccurately — the function takes `(tool, headers, queryParams?, tlsOptions?)`, not `ToolAuthResult`/`ctx`. | Reframed §3 step 3 as Option (i) vs Option (ii); HLD initially recommended Option (ii) — flipped in Round 2.                                          |
| HIGH [HD-9]    | `tools/design-lint.sh` exits 1 on this HLD — known bash bug (`((PASS_COUNT++))` under `set -e`).                                                              | Not an HLD content issue. Verified via manual regex replication that all required sections + 12 concerns are present. Tooling fix tracked separately. |
| MEDIUM [HD-2]  | Line-count claims for `http-tool-executor.ts` overstated ("2,500" / "2000"). Actual: 1,959.                                                                   | Corrected to "~2,000 lines" in two places.                                                                                                            |
| MEDIUM [HD-7]  | Concern #7 (Idempotency) N/A justification could be stronger.                                                                                                 | Expanded with HTTP-transport-vs-SOAP-message distinction and explicit pointer to `confirmation.require: 'when_side_effects'`.                         |
| MEDIUM [HD-8]  | Commit-scope-guard 3-package limit not flagged (this feature touches 6 packages).                                                                             | Added "Implementation constraint" sub-section to §9.                                                                                                  |
| MEDIUM [HD-10] | Open Question #3 was already answered inline by §4 + §6.                                                                                                      | Promoted to "Decisions made in this HLD" sub-section. Open Questions reduced from 6 to 5.                                                             |

### Round 2 — APPROVED with one structurally important HIGH

| Severity            | Finding                                                                                                                                                                                                                                                                                                                                          | Resolution                                                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HIGH [HD-6 round 2] | Option (ii) (`ctx.metadata` carrier) is structurally infeasible — verified via code: `tool-binding-executor.ts:335-340` terminal callback forwards `ctx.tool` but **not** `ctx.metadata` to `dispatch()`; `HttpToolExecutor.execute()` at `:388` has signature `(toolName, params, timeoutMs?, overrideTool?)` — no `ToolCallContext` parameter. | Flipped recommendation to Option (i) — transient `_wsSecurityCredentials` field on `tool.http_binding`. Added LLD task to enumerate every IR consumer that must strip the field. Sequence diagram updated. §9 Decisions rewritten. |
| MEDIUM              | `?debug=true` had no RBAC or nonce/timestamp guidance.                                                                                                                                                                                                                                                                                           | Added `tool:write` gating; flagged nonce/timestamp redaction as LLD decision.                                                                                                                                                      |
| MEDIUM              | E2E count "10 E2E" vs "7+7 promotion" was confusingly co-stated.                                                                                                                                                                                                                                                                                 | Clarified to "10 E2E (7 top-level + 3 isolation sub-scenarios)".                                                                                                                                                                   |

### Round 3 — APPROVED with cosmetic MEDIUMs

| Severity           | Finding                                                                                                                                                        | Resolution                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| MEDIUM             | 3 residual `ctx.metadata` references contradicting the flipped Option (i) recommendation: §3 step 4 narrative, §5 data model paragraph, §8 dependencies table. | All 3 cleaned up to reference `binding._wsSecurityCredentials`.             |
| MEDIUM (test spec) | Test spec header had `**HLD**: TBD`.                                                                                                                           | Updated to point at the now-existing `docs/specs/soap-tool-support.hld.md`. |

After Round 3, no CRITICAL or HIGH findings remain. The HLD is approved to proceed to LLD.

## 4. Files Created

| File                                          | Purpose                                                                                                                                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/specs/soap-tool-support.hld.md`         | High-Level Design — 12 architectural concerns, 4 alternatives evaluated, ASCII context + component + sequence diagrams, data model deltas, API design, cross-cutting concerns, dependencies. |
| `docs/sdlc-logs/soap-tool-support/hld.log.md` | This log.                                                                                                                                                                                    |

## 5. Files Updated

| File                                             | Change                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| `docs/testing/sub-features/soap-tool-support.md` | Updated header `**HLD**: TBD` → link to `../../specs/soap-tool-support.hld.md`. |

## 6. Quality Gate Snapshot

- All 12 architectural concerns addressed substantively (concern #7 Idempotency correctly N/A with full justification).
- 4 alternatives considered (A selected: branch in `HttpToolExecutor`); B/C/D each have genuine pros/cons/effort estimates.
- 3 ASCII diagrams: System Context, Component, Sequence.
- Data model: no new collections; `HttpBindingIR` and `ToolAuthResult` deltas spelled out with TypeScript shapes.
- API design: 5 modified endpoints; 5 distinct error codes; debug-mode response shape documented.
- Test strategy directly cites the test spec (real Express + MongoMemoryServer + Redis subprocess; no mocks of platform components).
- 5 open questions + 1 implementation constraint, all with carry-forward instructions to LLD.
- Manual replication of `design-lint.sh` checks: all required sections + 12 concerns PASS.
- Code-grounded throughout — every cited file path / line number verified against the repo.

## 7. Carry-Forward Items for LLD

Open questions explicitly delegated to the LLD phase:

1. `{{input.X}}` placeholders — auto-XML-escape vs `{{xml(input.X)}}` helper.
2. One-way SOAP operations — return shape (`null` / `{}` / `{ oneWay: true }`).
3. `fast-xml-parser` exact version pin (carried from /feature-spec; verify `processEntities: false` is the resolved default).
4. ABLP Jira ticket creation (carried from /feature-spec).
5. Connector-tool SOAP backport (out of v1 scope; flagged for connectors team).

Decisions made in HLD that the LLD must respect (or explicitly override with reasoning):

- `?debug=true` test endpoint gated behind `tool:write` permission.
- FR-13 credential propagation via transient `tool.http_binding._wsSecurityCredentials` field.
- LLD must enumerate every IR consumer (DSL emit, A2A export, `sourceHash`, project export, agent IR snapshot) and verify the transient field is stripped before serialization.
- Commit-scope-guard requires the 6-package implementation to be split across at least 2 sequential commits.

LLD decisions (not deferred above) that the LLD must make new:

- Whether `<wsse:Nonce>` + `<wsu:Timestamp>` are redacted from the `?debug=true` rendered envelope.
- Phased breakdown that respects the 3-package-per-commit hook limit.
- Exit criteria per phase (FR-13 propagation gating Phase 1; XXE-blocking parser config gating Phase 2; etc.).

## 8. Next Phase

Run `/lld soap-tool-support` to produce the Low-Level Design with phased implementation plan, exit criteria per phase, wiring checklist, and 5-round LLD-reviewer audit.
