---
name: hld
description: Generate a High-Level Design document in docs/specs/. Addresses the 12 architectural concerns. Asks 3-5 clarifying questions per section. Reads the feature spec from docs/features/ as input.
---

# HLD (High-Level Design) Generator

> **Playbook**: [`docs/sdlc/hld-playbook.md`](docs/sdlc/hld-playbook.md) | **Pipeline**: [`docs/sdlc/pipeline.md`](docs/sdlc/pipeline.md)

## Purpose

Generates a High-Level Design document in `docs/specs/<feature>.hld.md`. Ensures architectural completeness by addressing the 12 concerns from the design-quality-gate skill. Asks clarifying questions BEFORE writing.

## Trigger

User invokes `/hld <feature-name>`.

## Workflow

### Phase 1: Read Prerequisites

1. **Find the feature spec**: Read `docs/features/<feature>.md` (or sub-features variant)
2. **If no feature spec exists**: STOP and tell the user to run `/feature-spec` first
3. **Read the test spec** if it exists: `docs/testing/<feature>.md`
4. **Read existing code**: Search for current implementations related to this feature
5. **Read related designs**: Check `docs/specs/` and `docs/plans/` for related prior work
6. **Load the design-quality-gate skill** mentally — you must address all 12 concerns

### Phase 2: Clarifying Questions

Ask 3-5 clarifying questions for EACH area:

**Architecture & Data Flow (3-5 questions)**

- What's the preferred architecture pattern (service extraction, route handler, worker, etc.)?
- How does data flow through the system — request path, event-driven, or both?
- What's the expected scale (requests/sec, data volume, concurrent users)?
- Are there existing patterns in the codebase we should follow or deviate from?
- What's the deployment topology — single service, multi-service, worker queue?

**Integration & Dependencies (3-5 questions)**

- Which existing services/packages does this feature depend on?
- Does this introduce new external dependencies or third-party integrations?
- What's the API contract with upstream/downstream consumers?
- Are there breaking changes to existing APIs?
- How does this interact with the compile → deploy → execute lifecycle?

**Risk & Migration (3-5 questions)**

- What's the biggest technical risk?
- Is there existing data that needs migration?
- What's the rollback strategy if this fails in production?
- Are there feature flags or phased rollout requirements?
- What's the blast radius if something goes wrong?

**Spawn the product-oracle agent** to answer these questions autonomously:

- Pass ALL questions grouped by section as the prompt
- Include: "Answer these clarifying questions for the HLD: <feature-name>. Read the feature spec at docs/features/<slug>.md, existing architecture in docs/specs/, and the design-quality-gate 12 concerns."
- The oracle will return ANSWERED, INFERRED, DECIDED, or AMBIGUOUS classifications
- **If ANY questions are AMBIGUOUS**: Present ONLY those to the user and wait
- **If ALL questions are ANSWERED/INFERRED/DECIDED**: Proceed immediately

**Log the oracle decisions** to `docs/sdlc-logs/<slug>/hld.log.md`.

### Phase 3: Generation

Generate the HLD with this structure:

```markdown
# HLD: <Feature Name>

**Feature Spec**: `docs/features/<slug>.md`
**Test Spec**: `docs/testing/<slug>.md`
**Status**: DRAFT | REVIEW | APPROVED
**Author**: <user>
**Date**: <today>

---

## 1. Problem Statement

<From feature spec, refined with clarifying question answers>

## 2. Alternatives Considered

### Option A: <name>

- **Description**: ...
- **Pros**: ...
- **Cons**: ...
- **Effort**: S/M/L

### Option B: <name>

- **Description**: ...
- **Pros**: ...
- **Cons**: ...
- **Effort**: S/M/L

### Option C: <name> (if applicable)

### Recommendation: <chosen option>

**Rationale**: <why this wins — trade-offs acknowledged>

## 3. Architecture

### System Context Diagram

<ASCII or Mermaid diagram showing the feature in the broader system>

### Component Diagram

<Internal components and their interactions>

### Data Flow

<Request/event flow through the system, step by step>

### Sequence Diagram (for complex interactions)

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                        |
| --- | ----------------------- | ------------------------------------------------------ |
| 1   | **Tenant Isolation**    | <How data is scoped per tenant — query-level tenantId> |
| 2   | **Data Access Pattern** | <Repository layer? Direct model? Caching?>             |
| 3   | **API Contract**        | <Request/response shapes, error envelope, versioning>  |
| 4   | **Security Surface**    | <Auth, input validation, SSRF, encryption>             |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                |
| --- | ----------------- | -------------------------------------------------------------- |
| 5   | **Error Model**   | <What fails, how, user experience, recovery>                   |
| 6   | **Failure Modes** | <Network partition, timeout, partial failure, circuit breaker> |
| 7   | **Idempotency**   | <Safe retry, dedup strategy>                                   |
| 8   | **Observability** | <Traces, logs, debug in production>                            |

### Operational Concerns

| #   | Concern                | Design Decision                                     |
| --- | ---------------------- | --------------------------------------------------- |
| 9   | **Performance Budget** | <Latency targets, payload sizes, batch limits>      |
| 10  | **Migration Path**     | <Current state → target state transition>           |
| 11  | **Rollback Plan**      | <Revert strategy if production fails>               |
| 12  | **Test Strategy**      | <Unit vs integration vs E2E split, coverage target> |

## 5. Data Model

### New Collections/Tables

<Schema with fields, types, indexes>

### Modified Collections/Tables

<Changes to existing schemas>

### Key Relationships

<How new data relates to existing data>

## 6. API Design

### New Endpoints

| Method | Path | Purpose | Auth |
| ------ | ---- | ------- | ---- |
| ...    | ...  | ...     | ...  |

### Modified Endpoints

<Changes to existing APIs>

### Error Responses

<Error codes and messages for this feature>

## 7. Cross-Cutting Concerns

- **Audit Logging**: <what gets logged>
- **Rate Limiting**: <applicable limits>
- **Caching**: <strategy and TTLs>
- **Encryption**: <at rest and in transit>

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency | Type | Risk |
| ---------- | ---- | ---- |
| ...        | ...  | ...  |

### Downstream (depends on this feature)

| Consumer | Impact |
| -------- | ------ |
| ...      | ...    |

## 9. Open Questions & Decisions Needed

1. ...
2. ...

## 10. References

- Feature spec: `docs/features/<slug>.md`
- Test spec: `docs/testing/<slug>.md`
- Related designs: ...
```

### Phase 4: Validation

1. Run `tools/design-lint.sh docs/specs/<slug>.hld.md` to check completeness
2. Verify all 12 concerns are addressed (or marked N/A with justification)
3. Verify at least 2 alternatives were considered
4. Cross-reference with feature spec — every FR should be traceable to the design

### Phase 4b: Audit Loop (3 rounds minimum)

Spawn the **phase-auditor** agent:

```
Audit this HLD.
Phase: HLD
Artifact: docs/specs/<slug>.hld.md
Feature spec: docs/features/<slug>.md
Test spec: docs/testing/<slug>.md
Round: 1 of 3
```

**Audit feedback loop:**

1. Round 1: Full audit — all 12 concerns, alternatives, cross-phase consistency
2. If NEEDS_REVISION: fix CRITICAL/HIGH findings, re-submit for round 2
3. Round 2: Focused re-audit on previously-flagged items + data model/API deep dive
4. Round 3: Final pass — cross-phase consistency with feature spec and test spec
5. After round 3: proceed (log remaining findings)

**Ralph-loop integration:** If `.Codex/ralph-loop.local.md` exists and is active, each loop iteration counts as an audit round — skip internal loops.

### Phase 5: Commit & Log

1. **Commit the HLD**: `git add docs/specs/<slug>.hld.md` and commit with message: `[ABLP-2] docs(<scope>): add <feature-name> HLD`
2. **Log progress** to `docs/sdlc-logs/<slug>/hld.log.md`
3. **Update agents.md** for each package touched — append learnings (service boundaries discovered, undocumented dependencies, data flow quirks) to `<package>/agents.md`. See [`docs/sdlc/pipeline.md` — Package Learnings](docs/sdlc/pipeline.md#package-learnings-agentsmd) for what to log. Cross-cutting → `docs/sdlc-logs/agents.md`.
4. **Next phase**: Tell the user to run `/lld <feature-name>` next

## Context Management

CRITICAL: SDLC skills generate large amounts of context (oracle answers, spec content, audit findings). You MUST actively manage context to avoid degradation.

**Between phases within this skill:**

- After Phase 3 (Generation) completes and the file is written, the HLD content is persisted on disk. You do NOT need to keep it in working memory — re-read the file if needed.
- Always spawn the product-oracle and phase-auditor as **separate Agent tool invocations**. They start with fresh context and return only their findings. Never inline oracle/auditor work in the main conversation.

**Between audit rounds (3 rounds for HLD):**

- After resolving findings from audit round N, briefly summarize what was fixed (3-5 bullet points) before spawning round N+1. Do NOT carry forward the full audit report text.
- Each audit agent reads the artifact fresh from disk — it does not need the prior round's full findings passed in.
- HLD has 3 mandatory rounds — context discipline is especially important here to avoid degradation by round 3.

**After this skill completes:**

- Once the commit succeeds, run `/compact` to compress conversation context before the user invokes the next SDLC phase (e.g., `/lld`).
- If the user invokes the next SDLC skill in the same conversation, the first action of that skill should be to read its inputs fresh from disk — never rely on in-memory context from a prior skill's execution.

## Quality Gates

> Governed by the [Quality Principles](docs/sdlc/pipeline.md#quality-principles). No shortcuts — robust & architecturally sound. Test integrity — no mocking codebase components.

- MUST address all 12 architectural concerns — genuinely, not hand-waved with "TBD" (N/A with justification is acceptable)
- MUST include at least 2 alternative approaches with real trade-off evaluations, not strawmen set up to fail
- MUST include architecture diagrams (ASCII or Mermaid)
- MUST include data model changes (or explicitly state "no data model changes")
- MUST include API design (or explicitly state "no API changes")
- MUST design for the real system — account for isolation, auth, error handling, and failure modes, not just the happy path
- Test strategy (concern #12) must specify real service boundaries for integration tests and real HTTP API interaction for E2E tests — do not design a test strategy around mocking codebase components
- Problem statement must match the feature spec
- Open questions section must have at least 1 item
- `tools/design-lint.sh` must pass
