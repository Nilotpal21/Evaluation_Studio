# SDLC Pipeline Reference

Complete reference for the ABL platform's structured development lifecycle.

## The 6 Phases

```
┌─────────────┐    ┌────────────┐    ┌─────┐    ┌─────┐    ┌────────────────┐    ┌────────────────┐
│ Feature Spec │───→│ Test Spec  │───→│ HLD │───→│ LLD │───→│ Implementation │───→│ Post-Impl Sync │
│  (Phase 1)   │    │ (Phase 2)  │    │ (3) │    │ (4) │    │    (Phase 5)   │    │   (Phase 6)    │
└─────────────┘    └────────────┘    └─────┘    └─────┘    └────────────────┘    └────────────────┘
     ↓                   ↓              ↓          ↓              ↓                      ↓
 docs/features/     docs/testing/   docs/specs/ docs/plans/   Source code          All docs updated
```

### Phase 1: Feature Spec

- **Purpose**: Define what to build, who it's for, and why
- **Input**: Problem description or user request
- **Output**: `docs/features/<slug>.md`
- **Template**: `docs/features/TEMPLATE.md`
- **Review**: 2 rounds minimum
- **Playbook**: [feature-spec-playbook.md](feature-spec-playbook.md)

### Phase 2: Test Spec

- **Purpose**: Define how to verify the feature works — domain logic, state transitions, invariants
- **Input**: Feature spec
- **Output**: `docs/testing/<slug>.md`
- **Prerequisite**: Feature spec must exist
- **Review**: 2 rounds minimum
- **Playbook**: [test-spec-playbook.md](test-spec-playbook.md)
- **Test style**: Codex-quality domain validation (see [Domain Validation Tests](#domain-validation-tests--codex-quality) below)

### Phase 3: High-Level Design (HLD)

- **Purpose**: Design the architecture — how the feature fits into the system
- **Input**: Feature spec + test spec
- **Output**: `docs/specs/<slug>.hld.md`
- **Prerequisite**: Feature spec must exist
- **Review**: 3 rounds minimum
- **Playbook**: [hld-playbook.md](hld-playbook.md)

### Phase 4: Low-Level Design (LLD)

- **Purpose**: Plan the implementation — exact files, phases, exit criteria
- **Input**: Feature spec + HLD + test spec
- **Output**: `docs/plans/<date>-<slug>-impl-plan.md`
- **Prerequisite**: Feature spec AND HLD must exist
- **Review**: 5 rounds minimum (highest-risk planning artifact)
- **Playbook**: [lld-playbook.md](lld-playbook.md)

### Phase 5: Implementation

- **Purpose**: Write the code, slice by slice per the LLD, test-locking each slice before moving on
- **Input**: LLD + all prior artifacts
- **Output**: Source code, tests, one commit per slice (implementation + tests together)
- **Prerequisite**: LLD must exist
- **Review**: 5 rounds of code review after all slices complete
- **Playbook**: [implement-playbook.md](implement-playbook.md)
- **Workflow**: Slice-by-slice (see [Slice-by-Slice Implementation](#slice-by-slice-implementation) below)

### Phase 6: Post-Implementation Sync

- **Purpose**: Update all documentation to reflect what was actually built
- **Input**: All artifacts + git diff of implementation
- **Output**: Updated feature spec, test spec, HLD, LLD
- **Prerequisite**: Implementation committed
- **Review**: 1 round (verification pass)
- **Playbook**: [post-impl-sync-playbook.md](post-impl-sync-playbook.md)

---

## Feature Status Lifecycle

Every feature has a status that reflects its maturity. Status transitions are gated by specific criteria.

### Status Definitions

| Status      | Meaning                                                                                        | Audience                                          | Breaking Changes?                        |
| ----------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------- |
| **PLANNED** | Specified but not implemented. Feature spec exists, code does not.                             | Internal planning only                            | N/A                                      |
| **ALPHA**   | First implementation complete. Core happy path works. Gaps and rough edges expected.           | Internal team and trusted testers — expect breaks | Yes — without notice                     |
| **BETA**    | Functional and tested. E2E and integration tests pass. Known gaps documented but non-blocking. | Early adopters — breakage unlikely but possible   | Limited — documented, migration provided |
| **STABLE**  | Production-ready. Full test coverage, docs synced, no open CRITICAL/HIGH gaps.                 | All users — relied upon for production            | No — backwards-compatible only           |

### Transition Criteria

#### PLANNED → ALPHA

Gated by: **Implementation complete (Phase 5)**

- [ ] LLD phases implemented and committed
- [ ] Core happy path works (manual or automated verification)
- [ ] `pnpm build` passes for affected packages
- [ ] At least 1 E2E test or manual walkthrough demonstrates the feature
- [ ] Feature spec updated with implementation file paths
- [ ] Known gaps documented in feature spec §16

#### ALPHA → BETA

Gated by: **Test coverage + review**

- [ ] E2E tests passing — minimum 3 scenarios from test spec
- [ ] Integration tests passing — minimum 3 scenarios from test spec
- [ ] Unit tests cover core logic paths
- [ ] All CRITICAL gaps from feature spec §16 resolved
- [ ] HIGH gaps resolved or have documented workarounds
- [ ] Code review completed (5 rounds or equivalent)
- [ ] **Data-flow & dependency-wiring audit completed (2 rounds) if feature meets any mandatory trigger condition** — audit log at `docs/sdlc-logs/<slug>/data-flow-audit.md`, no CRITICAL findings open
- [ ] Feature spec, test spec, and testing README updated
- [ ] No regressions in existing test suites

#### BETA → STABLE

Gated by: **Full coverage + production validation**

- [ ] All E2E scenarios from test spec passing (minimum 5)
- [ ] All integration scenarios from test spec passing (minimum 5)
- [ ] Security & isolation tests passing (cross-tenant 404, cross-project 404, auth 401, permissions 403)
- [ ] No open CRITICAL or HIGH gaps
- [ ] MEDIUM gaps resolved or accepted with documented rationale
- [ ] Performance validated against success metrics
- [ ] All docs (feature spec, test spec, HLD, LLD) marked as current
- [ ] Testing guide coverage matrix shows green for all mandatory scenarios
- [ ] At least 1 week of production or staging use without regression

### Status ↔ SDLC Phase Mapping

| SDLC Phase Completed              | Feature Status |
| --------------------------------- | -------------- |
| Feature Spec                      | PLANNED        |
| Test Spec                         | PLANNED        |
| HLD                               | PLANNED        |
| LLD                               | PLANNED        |
| Implementation                    | ALPHA          |
| Post-Impl Sync + E2E pass         | BETA           |
| Full validation + production soak | STABLE         |

### Testing Guide Status Mapping

| Feature Status | Testing Guide Status | Meaning                                |
| -------------- | -------------------- | -------------------------------------- |
| PLANNED        | PLANNED              | No tests exist yet                     |
| ALPHA          | IN PROGRESS          | Some tests written, gaps expected      |
| BETA           | PARTIAL              | E2E + integration passing, gaps remain |
| STABLE         | STABLE               | Full coverage matrix green             |

---

## Doc Sync Reality Checks

These rules apply whenever a feature/test/design artifact is updated after implementation:

- Verify every referenced file path with `rg --files` before writing inventories, implementation-file lists, or gap tables.
- Distinguish **implemented** from **wired/reachable**. A route, component, or helper can exist in source while still being unreachable from the production entry point.
- Treat **Production Wiring Verification** as its own proof category. E2E/integration tests prove behavior; wiring verification proves the production entry point can actually reach that behavior.
- Do not defer implemented-vs-wired analysis until post-implementation sync. HLD and LLD must identify the intended production entry point, activation path, and wiring proof obligations before code is written.
- For features that import, reuse, reference, or mount assets across boundaries, document the **surface semantics** explicitly: which asset/entity types are supported, where they appear at design time, whether they are editable or read-only, what remains local-only, how design-time names map to runtime names, and what runtime path materializes them.
- A first deterministic public-API regression means the feature no longer has zero E2E coverage, but the testing guide should remain `PARTIAL` until the broader scenario family is covered.
- Wiring checklist items need evidence (router mount, import trace, caller path, build entry), not just file presence.

---

## Specialized Entry Lanes

### Characterization-First Bugfix Lane

When the primary work item is a bug, regression, isolation leak, wiring gap, or other behavioral defect, start with a characterization checkpoint before expanding HLD or LLD.

**Required artifact:** `docs/sdlc-logs/<slug>/characterization.md`

**Required contents:**

- **Reproduction artifact**: exact failing scenario, request sequence, stack trace, screenshot, or test output
- **Target seam**: the narrowest code seam or contract believed to contain the defect
- **Negative proof**: a failing or deny-path check that proves the bug exists and that the future fix must keep rejecting the wrong behavior
- **Known blast radius**: adjacent routes, packages, workers, or user journeys likely affected
- **Open ambiguities**: anything that still blocks safe planning

**Rules:**

1. Feature Spec and Test Spec must reference the characterization artifact when the work item is a bugfix.
2. HLD and LLD must not expand the solution until the reproduction artifact, target seam, and negative proof exist.
3. If the bug cannot yet be reproduced deterministically, the next obligation is to improve characterization, not to jump ahead to architecture.

### Critical Feature Gate (Before HLD)

For auth, isolation, compliance, privacy, retention, or encryption work, the Feature Spec and Test Spec must capture the operational contract before HLD starts.

**Feature Spec must include:**

- a terminology table for overlapping concepts
- explicit fail-closed behavior, including stable status/error-envelope expectations
- a threat-model summary covering protected assets, abuse paths, and primary mitigations
- rollout and rollback shape, including `audit` / `warn` / `enforce` modes when relevant

**Test Spec must include:**

- coverage for the terminology and contract boundaries
- fail-closed and negative-path scenarios
- threat-model-driven abuse-path tests
- rollout and rollback verification scenarios

**Gate rule:** HLD may proceed only after the Feature Spec and Test Spec both mark this gate as satisfied, or explicitly document why it is `N/A`.

---

## Artifact Locations

| Artifact                | Location                                       | Named As                                                |
| ----------------------- | ---------------------------------------------- | ------------------------------------------------------- |
| Feature spec            | `docs/features/<slug>.md`                      | `<feature-name>.md`                                     |
| Feature spec (sub)      | `docs/features/sub-features/<slug>.md`         | Same                                                    |
| Test spec               | `docs/testing/<slug>.md`                       | `<feature-name>.md`                                     |
| Test spec (sub)         | `docs/testing/sub-features/<slug>.md`          | Same                                                    |
| HLD                     | `docs/specs/<slug>.hld.md`                     | `<feature>.hld.md`                                      |
| LLD / Impl plan         | `docs/plans/<date>-<slug>-impl-plan.md`        | Date-prefixed                                           |
| SDLC logs               | `docs/sdlc-logs/<slug>/`                       | One folder per feature                                  |
| Phase log               | `docs/sdlc-logs/<slug>/<phase>.log.md`         | One log per phase; must end with a Phase Handoff Packet |
| Bugfix characterization | `docs/sdlc-logs/<slug>/characterization.md`    | Bugfix-only preplanning artifact                        |
| Prompt eval report      | `docs/sdlc-logs/prompt-evals/<date>-<name>.md` | SDLC prompt/playbook evaluation                         |
| Package learnings       | `<package>/agents.md`                          | Append-only                                             |
| Cross-cutting learnings | `docs/sdlc-logs/agents.md`                     | Append-only                                             |

---

## Phase Handoff Packet

Every phase log must end with a compact handoff packet for the next phase. The next phase starts by reading the previous packet, not by reconstructing the entire prior conversation or review history.

### Packet Template

```markdown
## Phase Handoff Packet

**Phase**: <Feature Spec | Test Spec | HLD | LLD | Implementation | Post-Impl Sync>
**Status**: <READY_FOR_NEXT_PHASE | BLOCKED | COMPLETE>

**Objective**:

- <1-2 bullets>

**Scope**:

- <1-3 bullets>

**Evidence Files**:

- <repo path>
- <repo path>

**Key Decisions**:

- [ANSWERED] <decision and source>
- [INFERRED] <decision and basis>
- [DECIDED] <decision and rationale>

**Open Ambiguities**:

- <only items that remain unresolved>

**Invariants**:

- <contracts that the next phase must preserve>

**Next-Phase Obligations**:

- <proofs, docs, questions, or commands the next phase must resolve first>
```

### Rules

1. Keep it compact: 1-3 bullets per field unless a field is empty.
2. `Evidence Files` must be actual repo paths the next phase can read directly.
3. `Open Ambiguities` may be empty, but if non-empty they must be carried forward explicitly.
4. `Next-Phase Obligations` should name concrete proofs, documents, or questions the next phase must resolve before broadening scope.
5. `Post-Impl Sync` still emits a final packet. Use `Status: COMPLETE` and list follow-up obligations for BETA/STABLE promotion if any remain.

---

## Package Learnings (`agents.md`)

Every package/app in the monorepo has its own `agents.md` at its root (e.g., `apps/runtime/agents.md`, `packages/database/agents.md`). These are **append-only** logs of learnings discovered during SDLC work — patterns that worked, gotchas, architectural decisions that changed, testing gaps.

### Why

AI agents (and humans) repeat the same mistakes when working in unfamiliar packages. `agents.md` captures hard-won knowledge so the next person or agent working in that package benefits from prior experience instead of rediscovering the same issues.

### Rules

1. **Read before modifying**: Before touching code in a package, read its `agents.md` to learn from prior work
2. **Write after completing**: After completing any SDLC phase that touches a package, append learnings to its `agents.md`
3. **Create on first touch**: If a package doesn't have `agents.md`, create one with a heading and the first entry
4. **Package-specific → package `agents.md`**: Patterns, gotchas, and decisions specific to one package
5. **Cross-cutting → `docs/sdlc-logs/agents.md`**: Learnings that span multiple packages or are platform-wide
6. **Every SDLC phase updates `agents.md`** — not just implementation. A feature spec phase might discover that a package's API is different than expected; an HLD phase might reveal an undocumented service boundary. These are all learnings worth capturing.

### What to Log

- Patterns that worked well or failed in that package
- Architectural decisions that changed during the phase
- Testing gaps discovered
- Gotchas for future agents/developers working in this package
- Unexpected behaviors, undocumented constraints, or non-obvious conventions

### When to Update

| SDLC Phase     | What to Log                                                                        |
| -------------- | ---------------------------------------------------------------------------------- |
| Feature Spec   | Packages affected, existing patterns discovered, API surface surprises             |
| Test Spec      | Testing infrastructure available, coverage baseline, missing test fixtures         |
| HLD            | Service boundaries discovered, undocumented dependencies, data flow quirks         |
| LLD            | File-level surprises (signatures differ from docs), technical debt found           |
| Implementation | What worked, what didn't, build/test gotchas, wiring issues encountered            |
| Post-Impl Sync | Deviations from plan, gaps found during doc audit, path/wiring verification issues |

---

## Data-Flow & Dependency-Wiring Audit

This is a **mandatory explicit audit** (2 rounds minimum) for any feature that crosses a process or policy boundary. It is separate from — and runs after — the 5-round implementation review.

### Core Mindset

> **Do not ask "does this function redact?"**
> Ask: **"Can the raw value reach any consumer without passing through the approved boundary?"**

The audit picks one sensitive value — a user message, a credential, a PII field, a session assignment, a tenant ID — and follows it through every boundary where it can be copied, stored, transformed, published, decrypted, rendered, or consumed. A code review asks whether each function is correct. This audit asks whether the correct function is **always on the critical path** for every route that value can take.

### When Mandatory

Trigger this audit before declaring a feature BETA-ready when any of these conditions apply:

| Condition                                                    | Examples                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------ |
| New **sensitive value** enters or flows through the system   | PII, credentials, API keys, message content, health data           |
| New **serialization boundary** added                         | Kafka/EventBus payload, Restate input, HTTP call, worker queue job |
| New **dependency wiring**                                    | Constructor injection, factory deps, singleton registration        |
| **Parallel implementations** exist                           | Two service variants, two route families, live vs. async trigger   |
| New **persistence** of a previously in-memory value          | DB write, ClickHouse INSERT, Redis cache                           |
| Feature touches **right-to-erasure** or data retention paths | Cascade deletes, TTL changes, anonymization                        |

For all other features, apply the Data-Flow mindset as a lens during Round 4 (Security & Isolation) of the standard 5-round review.

### The 9 Audit Dimensions

Every audit traces the value through all 9 dimensions:

| Dim | Name                         | Question                                                                              |
| --- | ---------------------------- | ------------------------------------------------------------------------------------- |
| 1   | **Source**                   | Where does the value first enter? What validation is applied at entry?                |
| 2   | **Writes**                   | Where is it persisted? Raw, encrypted, hashed, or redacted?                           |
| 3   | **Serialization Boundaries** | Where does it cross a process boundary? EventBus, Kafka, Restate, HTTP, worker queue? |
| 4   | **Read Paths**               | Who reads it back? What projections expose it?                                        |
| 5   | **Policy Boundary**          | Is it rendered at the right boundary for the right consumer?                          |
| 6   | **Consumers / Sinks**        | Where can it reach an LLM, external API, or external system?                          |
| 7   | **Dependency Wiring**        | Is the required service actually initialized and passed through?                      |
| 8   | **Parallel Paths**           | Are there sibling implementations? Do they handle the value identically?              |
| 9   | **Regression Tests**         | Are there boundary tests that will fail if a future change bypasses the policy gate?  |

### Policy Boundary (Dim 5) — The Most Critical

Map every consumer against its required policy level:

| Consumer Class                           | Allowed Policy                      |
| ---------------------------------------- | ----------------------------------- |
| LLM prompt                               | redacted or explicitly approved raw |
| External tool / HTTP action              | redacted or stripped                |
| Studio session view                      | role-gated                          |
| Admin reveal                             | gate + audit log                    |
| Background pipeline (analytics, scoring) | depends on data class               |
| Logs / traces                            | never raw PII                       |
| Kafka / EventBus downstream              | redacted at emit                    |

**If raw value can reach a consumer without passing through the approved gate — that is a CRITICAL finding, regardless of whether it currently happens in practice.**

### Round Structure

| Round       | Focus                                                        | Entry Criteria                                     | Exit Criteria                                                                                                              |
| ----------- | ------------------------------------------------------------ | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Round 1** | Full path trace — all 9 dimensions for every sensitive value | All implementation slices committed, build passing | Every CRITICAL and HIGH finding has a proposed fix; every Source → Sink path accounted for                                 |
| **Round 2** | Fix verification + boundary tests                            | Round 1 fixes committed                            | No CRITICAL findings open; boundary tests added at each policy gate; parallel paths verified identical; audit log complete |

### Audit Log

Create `docs/sdlc-logs/<slug>/data-flow-audit.md` with the findings matrix, per-value path trace, and final verdict. The log is a prerequisite for BETA status promotion.

### Skill Reference

Use the `/data-flow-audit` skill for the full 9-dimension audit procedure, reporting templates, and the field-propagation sub-audit (for simpler layer-omission checks).

---

## Review Standards

### Review Round Focus Areas

| Round | Focus Area                                                                   |
| ----- | ---------------------------------------------------------------------------- |
| 1     | Code quality — types, error handling, logging, style                         |
| 2     | Architecture compliance — matches HLD, isolation, auth, stateless patterns   |
| 3     | Test coverage — E2E and integration scenarios from test spec covered         |
| 4     | Security & isolation — tenant/project/user isolation, auth, input validation |
| 5     | Production readiness — performance, observability, failure modes, edge cases |

### Severity Levels

| Severity | Must Fix Before Proceeding? | Notes                                    |
| -------- | --------------------------- | ---------------------------------------- |
| CRITICAL | Yes                         | Blocks the next phase                    |
| HIGH     | Should fix                  | Defer only with documented justification |
| MEDIUM   | Log if deferred             | Fix if time permits                      |
| LOW      | Optional                    | Style, naming, minor improvements        |

### Review Round Output Contract

Every review round must produce the same fixed output, whether the artifact is a spec, plan, code change, or post-implementation sync pass.

```markdown
## Review Round N: <Focus>

### Blocking Findings

- [CRITICAL|HIGH] <finding>

### Why They Matter

- <impact on correctness, isolation, wiring, reachability, or delivery>

### Exact Fixes Required

- <specific edits, proofs, or commands required before the next round>

### Retry Packet

- Re-read: <files or artifacts>
- Preserve: <invariants and contracts>
- Re-prove: <tests, wiring evidence, or review checks>
- Open Questions: <only if any remain>
```

**Rules:**

- If there are no blocking findings, say `No blocking findings.` and still emit the Retry Packet.
- `Why They Matter` must describe user or system impact, not just restate the finding.
- `Exact Fixes Required` must be actionable enough that the next pass can execute them without reinterpretation.
- `Retry Packet` should stay small and point at the minimal evidence set needed for the next round.

### Review Checklists by Phase

Each review round uses the Review Round Output Contract above.

**Feature Spec** — 5 passes:

- Pass 1: Completeness — all required sections filled, minimums met (3+ user stories, 4+ FRs, isolation addressed)
- Pass 2: Cross-phase consistency — FRs align with user stories, testing placeholder matches FRs
- Pass 3: Platform audit — no invariant violations, no reinvention of existing capabilities, correct isolation model
- Pass 4: Industry research expert audit — aligned with industry best practices, known failure modes addressed
- Pass 5: OSS library audit — existing libraries identified for custom implementations, license-compatible

**Test Spec, HLD** — 2-3 rounds:

- Round 1: Completeness — all required sections filled, minimums met (5+ E2E scenarios, 5+ integration scenarios, 12 concerns for HLD)
- Round 2: Cross-phase consistency — scenarios cover all FRs, HLD implements all FRs
- Round 3 (HLD only): Deep dive — data model correctness, API design, error model covers real failures

**LLD** — 8 rounds:

- Round 1: Architecture compliance — isolation, auth, stateless, traceability
- Round 2: Pattern consistency — matches existing code, no reinvention
- Round 3: Completeness — every FR covered, file paths verified, signatures checked
- Round 4: Cross-phase consistency — LLD implements HLD, covers test spec scenarios
- Round 5: Final sweep — task independence, wiring checklist, domain rules
- Round 6: Platform audit — no invariant violations, dep wiring verified, no duplicate infrastructure
- Round 7: Industry research expert audit — implementation approach aligns with industry, operational risks addressed
- Round 8: OSS library audit — existing libraries identified, custom tasks simplified where applicable

**Implementation** — 5 rounds:

- Round 1: Code quality — types correct, error handling present, logging conventions, style
- Round 2: HLD compliance — implementation matches architecture, isolation patterns, auth middleware
- Round 3: Test coverage — E2E and integration scenarios from test spec covered
- Round 4: Security & isolation — tenant/project/user isolation, auth checks, input validation
- Round 5: Production readiness — performance, observability, failure modes, edge cases

---

## Quality Principles

These principles apply to EVERY phase of the SDLC pipeline — from writing specs to writing code to syncing docs. They are the canonical source of truth; individual playbooks and skills reference back to this section.

### No Shortcuts — Robust & Architecturally Sound

Every artifact — whether a spec, design doc, implementation plan, or code change — MUST be robust and architecturally sound.

- **No quick hacks**: If the architecturally correct solution is harder, do it anyway. A shortcut that bypasses the service layer, skips validation, or hard-codes values is NOT acceptable.
- **Follow established patterns**: Read existing code in the area before writing new code. Match the layering, error handling, and testing patterns already in use.
- **No TODO stubs in shipped artifacts**: If something is needed, implement it. If it's genuinely deferred, document it in the LLD with a phase assignment and track it in the feature spec gaps table.
- **Ground in evidence**: Every claim in a spec must be traceable to code, tests, or docs. Never invent behavior that doesn't exist. Mark unknowns explicitly.
- **Design for the real system**: Specs and designs must account for isolation, auth, error handling, and failure modes — not just the happy path. If a spec omits these, it's incomplete.

**Phase-specific applications:**

| Phase          | What "No Shortcuts" Means                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Feature Spec   | Requirements are testable and complete, not hand-wavy. Non-functional concerns (isolation, security) are addressed, not deferred.                      |
| Test Spec      | E2E and integration scenarios are Codex-quality domain validation: multi-step journeys with state verification, not simplified stubs. Minimum 5 each.  |
| HLD            | All 12 architectural concerns are addressed. Alternatives are genuinely evaluated, not strawmen.                                                       |
| LLD            | Exit criteria are measurable. File paths are exact. Wiring checklist is complete. Every task is implementable.                                         |
| Implementation | Code follows the architecturally correct pattern, not the easy path. No TODO stubs. No skipped validation. Each slice is test-locked before moving on. |
| Post-Impl Sync | Docs reflect reality, not aspirations. Coverage matrix is honest (❌ where tests don't exist).                                                         |

### Production Reachability — Separate From Code Existence

Design and planning phases must treat implemented-vs-wired as a first-class question, not a post-implementation cleanup item.

- **HLD must identify the activation path**: which production entry point, mount path, caller chain, or runtime registration makes the feature reachable
- **LLD must translate that into proof obligations**: exact wiring tasks, expected callers, and the evidence needed to prove reachability after implementation
- **Implementation and Post-Impl Sync verify the plan was realized**: code existence is necessary but never sufficient

**Phase-specific applications:**

| Phase          | What "Production Reachability" Means                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| HLD            | Architecture names the production entry point, activation path, and where wiring evidence will come from               |
| LLD            | Wiring checklist items include expected proof (mount trace, import trace, caller path, build entry), not just presence |
| Implementation | Wiring verification proves the intended activation path is real before moving on                                       |
| Post-Impl Sync | Docs distinguish implemented behavior from reachable behavior and update status honestly                               |

### Test Integrity — No Mocking Codebase Components

Tests must exercise the real system. Mocking should only be used for **external third-party services** that are outside the codebase boundary.

**Rules:**

1. **E2E tests must NOT mock any codebase components** — `vi.mock()` / `jest.mock()` are FORBIDDEN in E2E tests. The only acceptable mocks are for external services (third-party APIs, payment gateways, email providers) injected via dependency injection.
2. **Integration tests must NOT mock the components under test** — mock only external dependencies outside the service boundary. If you're testing service A calling service B, both A and B should be real.
3. **API-only interaction in E2E** — Seed data via POST endpoints, assert via GET responses. Never import database models or query the DB directly.
4. **Real servers** — Start Express on random ports (`{ port: 0 }`). The full middleware chain must execute: auth, rate limiting, tenant isolation, validation.
5. **Test all content types** — When testing data round-trips, include structured types (arrays, objects, `ContentBlock[]`), not just plain strings.
6. **No TODO stubs in test files** — Committed test files must have working infrastructure and assertions. `// TODO: add test` is not a test.

**What CAN be mocked:**

- External third-party APIs (OpenAI, Stripe, SendGrid, etc.) — via DI, not `vi.mock()`
- External infrastructure not available in CI (cloud services, hardware)
- Time/clocks for deterministic testing (`vi.useFakeTimers()` is fine)

**What MUST NOT be mocked:**

- Codebase components (services, repositories, middleware, route handlers)
- Database access (use real DB or in-memory DB like MongoMemoryServer)
- Auth middleware, tenant isolation, input validation
- Any component that has had bugs masked by mocking in the past

**Phase-specific applications:**

| Phase          | What "Test Integrity" Means                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| Test Spec      | E2E scenarios specify real HTTP calls, not mock-based tests. Scenarios include auth context and isolation checks. |
| LLD            | Test strategy per phase specifies real service boundaries, not mocked layers.                                     |
| Implementation | Test files use real servers, real middleware, real DB. Only external services are mocked via DI.                  |
| Post-Impl Sync | Coverage matrix reflects actual test quality — a test that mocks the component under test is marked ❌, not ✅.   |

### Domain Validation Tests — Codex Quality

Test specs and implementation tests MUST go beyond basic CRUD assertions. Every E2E and integration scenario must be a **multi-step user journey** that validates domain logic, state transitions, and cross-route invariants — not just "POST returns 201, GET returns the item."

**What makes a test "Codex quality":**

1. **Multi-step journeys**: Each test exercises 3+ API calls that form a real user workflow. A lifecycle test walks through create → update → verify intermediate state → transition → verify final state → attempt invalid transition → verify rejection.

2. **State transition validation**: After every mutating operation, the test reads back state from a different route and asserts the intermediate result. Don't trust that a 200 response means the operation worked — verify the state changed correctly.

3. **Invariant enforcement**: Tests verify business rules across multiple routes:
   - A role downgrade cascade: demote admin → verify they lose access to admin-only operations → verify audit trail recorded the change
   - A soft delete cascade: archive workspace → verify all projects archived → verify cross-tenant user still can't see them → restore → verify everything comes back
   - A privilege escalation guard: attempt to create a resource with scopes beyond your role → verify rejection → verify no partial state was created

4. **Cross-route coherence**: Tests prove that state written by one route is correctly visible to other routes. If a key is revoked via DELETE, the GET list must exclude it, the PATCH must return 404, and the runtime auth must reject it.

5. **Negative path depth**: Don't just test "unauthorized returns 401." Test the complete negative scenario: wrong tenant gets 404 (not 403), wrong project gets empty list (not error), deactivated user gets 403, archived resource gets 410, expired grace period gets 410.

**Anti-patterns (reject in test spec review):**

| Anti-Pattern                    | Why It Fails                                                       | Codex Alternative                                                                                               |
| ------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| "POST /resource → assert 201"   | Proves the route handler ran, not that the domain logic worked     | POST → GET → assert all fields correct → attempt duplicate → assert 409                                         |
| "PATCH /resource → assert 200"  | Doesn't verify the update persisted or was visible to other routes | PATCH → GET from different route → assert changed fields → assert unchanged fields didn't mutate                |
| "DELETE /resource → assert 200" | Doesn't verify cascading side effects                              | DELETE → GET list → assert removed → attempt GET by ID → assert 404 → verify cascade (child records cleaned up) |
| Single-route tests              | Miss cross-route bugs (the most common class of production issues) | Multi-route journeys that exercise the feature end-to-end                                                       |
| Testing only the happy path     | Misses the edge cases where most bugs hide                         | Every scenario must include at least 1 negative assertion (rejection, guard, invariant check)                   |

**Minimum requirements per test spec:**

- **5+ E2E domain scenarios** — each is a multi-step journey with state verification at every step
- **5+ integration scenarios** — each tests a real service boundary with domain logic assertions
- At least 1 scenario that exercises a **full lifecycle** (create → use → modify → archive/delete → verify cascade)
- At least 1 scenario that tests **cross-tenant isolation** with state verification (not just status code checks)
- At least 1 scenario that tests **privilege escalation prevention** with verification that no partial state was created
- At least 1 scenario that tests **concurrent or sequential operations** on the same resource by different actors

**Phase-specific applications:**

| Phase          | What "Codex Quality" Means                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| Test Spec      | Scenarios describe multi-step journeys with intermediate assertions, not single-route smoke tests           |
| LLD            | Each implementation slice specifies which test scenarios lock it (see Slice-by-Slice Implementation)        |
| Implementation | Tests are written alongside the slice code, not as an afterthought. Slice is not complete until tests pass. |
| Post-Impl Sync | Coverage matrix maps each scenario to the FR it validates and the slice it locks                            |

### Slice-by-Slice Implementation

Implementation (Phase 5) follows a **slice-by-slice** workflow: implement one vertical slice of functionality, write tests that lock it, verify all tests pass, commit, then move to the next slice. No slice is started until the previous slice is test-locked.

**What is a slice?**

A slice is the smallest unit of functionality that can be independently tested end-to-end. It typically corresponds to one LLD phase or sub-phase, but may be smaller if the phase contains independent concerns.

Examples:

- Scope registry + validation utilities + unit tests = 1 slice
- CRUD route update + ceiling check + E2E tests = 1 slice
- Runtime resolveApiKey expansion + backwards compat + integration tests = 1 slice

**The slice workflow:**

```
┌─────────────────────────────────────────────────────────────┐
│  For each slice:                                             │
│                                                              │
│  1. IMPLEMENT the slice code                                 │
│  2. WRITE tests that validate the slice (domain + E2E)       │
│  3. RUN tests — all must pass (new + existing)               │
│  4. COMMIT implementation + tests together                   │
│  5. VERIFY no regressions in existing test suite             │
│  6. MOVE to next slice                                       │
│                                                              │
│  If tests fail → fix the implementation, NOT the test.       │
│  If existing tests break → the slice introduced a regression │
│  — fix it before proceeding.                                 │
└─────────────────────────────────────────────────────────────┘
```

**Rules:**

1. **Tests and code ship together**: Never commit implementation without its tests. Never commit tests without their implementation. One commit per slice = code + tests.
2. **Test-lock before moving on**: A slice is "locked" when its tests pass AND no existing tests regressed. Only then can the next slice begin.
3. **Fix forward, not backward**: If slice 3's tests reveal a bug in slice 1's implementation, fix slice 1 first, verify slice 1's tests still pass, then resume slice 3.
4. **Each slice is independently revertable**: Because each commit contains a complete slice (code + tests), any slice can be reverted without orphaning tests or leaving untested code.
5. **Map slices to test scenarios**: The LLD should specify which test spec scenarios are covered by each slice. After implementation, the coverage matrix should show which slices lock which scenarios.

**Slice sizing guidance:**

| Too Small             | Right Size                                       | Too Large                          |
| --------------------- | ------------------------------------------------ | ---------------------------------- |
| Adding a single field | CRUD routes + validation + E2E lifecycle test    | Entire feature in one slice        |
| One unit test         | Service layer + route integration + domain test  | Multiple packages in one slice     |
| A type definition     | Middleware + wiring + cross-route invariant test | Implementation + refactoring mixed |

**Phase-specific applications:**

| Phase          | What "Slice-by-Slice" Means                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| LLD            | Each phase/sub-phase specifies: (a) what code changes, (b) which test scenarios lock it, (c) exit criteria that include "tests pass" |
| Implementation | Implement → test → verify → commit → next. Never batch multiple slices into one commit.                                              |
| Post-Impl Sync | Coverage matrix maps slices to commits, showing which commit locked which FR                                                         |

---

### Test Execution — Structured Failure Capture

Use `pnpm test:report` to run all tests once and produce a structured failure log in `test-reports/` (gitignored). This eliminates the iterative run-fix-run cycle by capturing ALL failures upfront.

**Commands:**

| Command                     | Purpose                                        |
| --------------------------- | ---------------------------------------------- |
| `pnpm test:report`          | Full test tier, all packages, with build       |
| `pnpm test:report:fast`     | Fast/unit tier only                            |
| `pnpm test:report:failures` | Re-aggregate existing JSON reports (no re-run) |

**Flags** (passed after `--`):

| Flag              | Example           | Purpose                                 |
| ----------------- | ----------------- | --------------------------------------- |
| `--filter <name>` | `--filter studio` | Run only matching packages              |
| `--skip-build`    | `--skip-build`    | Skip turbo build step                   |
| `--parallel <n>`  | `--parallel 4`    | Run N packages concurrently             |
| `--tier <tier>`   | `--tier test`     | Select test tier (default: `test:fast`) |

**Outputs** (all in `test-reports/`, gitignored):

- `<package>.json` — per-package vitest JSON report
- `failures.json` — consolidated failures, machine-readable (feed to agents)
- `SUMMARY.md` — human-readable failure report grouped by package/file
- `run-summary.json` — execution metadata (pass/fail/timeout per package)

**Workflow:**

1. Run `pnpm test:report` — captures everything in one pass
2. Open `test-reports/SUMMARY.md` — see all failures with error messages
3. Fix all from the log — no re-running between fixes
4. Run `pnpm test:report` — verify once at the end

**CI integration:** Add a step that runs `pnpm test:report` and uploads `test-reports/` as a build artifact. Download the artifact when CI fails instead of re-running locally.

**Implementation:** `tools/test-capture.ts` (runner) + `tools/aggregate-failures.ts` (aggregator).

---

## Clarifying Questions & Decision Protocol

Every planning phase (Feature Spec, Test Spec, HLD, LLD) MUST ask 3-5 clarifying questions per major section BEFORE generating content. Do NOT generate a full document from a one-line description.

### Why

The clarifying questions phase catches misunderstandings early and produces dramatically better output. A 5-minute question round prevents hours of rework.

### Process

1. **Identify question areas** — each phase playbook defines the specific areas (scope, requirements, architecture, risk, etc.)
2. **Ask 3-5 questions per area** — group all questions and present them together
3. **Answer autonomously where possible** — if the answer is clearly available in the codebase, docs, or reasonable inference, answer it without blocking on the user
4. **Classify each answer** using the decision protocol below
5. **Escalate only AMBIGUOUS items** — present these to the user and wait for a response
6. **Log all decisions** to `docs/sdlc-logs/<slug>/<phase>.log.md`

### Decision Classification Protocol

Every clarifying question gets classified into one of four categories:

| Classification | Meaning                                                                             | Action                                                                |
| -------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **ANSWERED**   | Answer found directly in code, docs, or explicit user input                         | Proceed — cite the source                                             |
| **INFERRED**   | Answer derived from patterns, conventions, or related features in the codebase      | Proceed — state the inference and basis                               |
| **DECIDED**    | No clear answer exists; a reasonable judgment call was made                         | Proceed — document the decision and rationale so it can be challenged |
| **AMBIGUOUS**  | Multiple valid interpretations exist; choosing wrong would cause significant rework | **STOP and ask the user**                                             |

**Rules:**

- ANSWERED and INFERRED items proceed without blocking — the source/basis is logged
- DECIDED items proceed but are flagged for visibility — the user can override later
- AMBIGUOUS items MUST be escalated — do not guess on high-impact ambiguities
- All classifications are logged to `docs/sdlc-logs/<slug>/<phase>.log.md` for traceability

---

## Commit Conventions

- **Format**: `[ABLP-2] <type>(<scope>): <description>`
- **Types**: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`
- **One commit per implementation slice** (code + tests together) during implementation
- **One commit per artifact** during planning phases
- **Run `npx prettier --write <files>`** before every commit
- **Run `pnpm build --filter=<package>`** before committing code changes

### Pre-Commit Checklist

1. `npx prettier --write <changed-files>`
2. `pnpm build --filter=<affected-package>`
3. `pnpm test --filter=<affected-package>`
4. `git add <files> && git commit`

The pre-commit hook enforces steps 1-2 (prettier + typecheck). Step 3 is enforced at push time. Skipping these steps results in the 2.8:1 fix-to-feat ratio observed in the March 21-25 audit.

### Auto-Commit Rules

Commit every reasonable change immediately. Do not batch up large sets of changes.

- **After generating a spec/design/plan**: Commit the document immediately
- **After each implementation phase**: Commit the phase's changes
- **After fixing review findings**: Commit the fixes
- **After updating docs**: Commit the doc updates
- **After updating agents.md**: Include in the same commit or commit immediately

---

## Context Management

These rules ensure correctness across long-running tasks. They apply to AI agents but the underlying principle — "re-read from disk, don't trust memory" — is good practice for anyone working across multiple SDLC phases.

### Rules

AI agents accumulate context as they read files, generate content, and process review findings. Without active management, output quality degrades.

### Rules

1. **Read artifacts from disk, not memory** — after writing a file, re-read it if you need to reference it later
2. **Spawn reviewers as separate operations** — each reviewer should start fresh, not inherit the full conversation
3. **Summarize between review rounds** — after fixing findings from round N, write a 3-5 bullet summary before starting round N+1; don't carry the full review report forward
4. **Clear context between phases** — after committing a phase artifact, compress/clear context before starting the next phase
5. **Clear mid-skill for long phases** — LLD has 5 review rounds; clear context after round 3 to prevent degradation in rounds 4-5
6. **Artifacts on disk are the source of truth** — a fresh read of a 200-line LLD is cheaper than degraded output from stale context
7. **Start each phase from the prior handoff packet** — read the previous phase's compact packet before diving back into the full artifact set

---

## SDLC Prompt Evaluation Loop

When changing `docs/sdlc/*.md`, evaluate the prompt/playbook change against a small corpus of past features and bugfixes before treating the new prompt as better.

### Minimum Corpus

- 3 recent feature flows with at least Feature Spec, Test Spec, and HLD artifacts
- 3 recent bugfix/regression flows with characterization evidence or equivalent failure logs
- Prefer examples with review rounds and post-implementation updates so rework is measurable

### Compare

- **Question count**: did the new prompt reduce unnecessary clarification while still surfacing true ambiguities?
- **Cycle time**: how many review rounds or follow-up passes were needed to reach an acceptable artifact?
- **Review defects**: which blocking findings appeared in later rounds that should have been caught earlier?
- **Doc rework**: how much content had to be rewritten in the next phase because the earlier prompt under-specified the contract?

### Output

Record the comparison in `docs/sdlc-logs/prompt-evals/<date>-<name>.md` with:

- baseline prompt/playbook
- candidate prompt/playbook
- corpus entries used
- metric deltas
- keep / revise / reject decision

### Promotion Rule

Do not treat a prompt/playbook edit as an improvement unless it holds or improves artifact quality while reducing question churn, review defects, or cross-phase rework on the evaluation corpus.
