# Phase 3: HLD (High-Level Design) Playbook

Design the architecture for the feature. The HLD answers "how does this fit into the system?" and addresses 12 architectural concerns.

## Prerequisites

- Feature spec at `docs/features/<slug>.md` — **required** (run Phase 1 first if missing)
- Test spec at `docs/testing/<slug>.md` — recommended but not blocking, except for critical auth/isolation/compliance/privacy/retention/encryption work where the critical-feature gate must be satisfied before HLD starts
- For bugfix or regression work, `docs/sdlc-logs/<slug>/characterization.md` with reproduction artifact, target seam, and negative proof — **required before HLD expansion**

## Workflow

### Step 1: Read Prerequisites

1. Read the feature spec: `docs/features/<slug>.md`
2. Read the test spec if it exists: `docs/testing/<slug>.md`
3. Read the previous phase's `## Phase Handoff Packet` from `docs/sdlc-logs/<slug>/feature-spec.log.md`
4. Read the previous phase's `## Phase Handoff Packet` from `docs/sdlc-logs/<slug>/test-spec.log.md` if the test spec exists
5. Read the characterization artifact if this is a bugfix/regression: `docs/sdlc-logs/<slug>/characterization.md`
6. Verify the critical-feature gate is satisfied when applicable
7. Search for current implementations related to this feature
8. Check `docs/specs/` and `docs/plans/` for related prior work

### Step 2: Ask Clarifying Questions

Ask 3-5 questions per area. Use the [Decision Classification Protocol](pipeline.md#decision-classification-protocol) (ANSWERED/INFERRED/DECIDED/AMBIGUOUS) to handle answers. Log all classifications to `docs/sdlc-logs/<slug>/hld.log.md`.

**Architecture & Data Flow**

- What's the preferred architecture pattern (service extraction, route handler, worker)?
- How does data flow — request path, event-driven, or both?
- What's the expected scale (requests/sec, data volume)?
- Are there existing codebase patterns to follow or deviate from?
- What's the deployment topology?
- If the feature imports or mounts shared assets, what is visible at design time, what stays local-only, and what gets materialized or resolved only at deploy/runtime?

**Integration & Dependencies**

- Which existing services/packages does this depend on?
- New external dependencies or third-party integrations?
- API contract with upstream/downstream consumers?
- Breaking changes to existing APIs?
- How does this interact with the compile → deploy → execute lifecycle?

**Risk & Migration**

- What's the biggest technical risk?
- Is there existing data that needs migration?
- Rollback strategy if this fails in production?
- Feature flags or phased rollout requirements?
- Blast radius if something goes wrong?

**Activation, Reachability & Wiring**

- What production entry point activates this behavior?
- Which router mount, import chain, caller path, or runtime registration makes it reachable?
- What is the most likely way this work could be implemented but remain unwired?
- What evidence will later prove production reachability?

### Step 3: Generate the HLD

Create `docs/specs/<slug>.hld.md` with this structure:

#### 1. Problem Statement

Refined from the feature spec with clarifying question context.

#### 2. Alternatives Considered

**Minimum 2 alternatives.** For each:

- Description
- Pros / Cons
- Effort estimate (S/M/L)

Then: **Recommendation** with rationale and trade-offs acknowledged.

#### 3. Architecture

- **System Context Diagram**: ASCII or Mermaid showing the feature in the broader system
- **Component Diagram**: Internal components and interactions
- **Data Flow**: Step-by-step request/event flow
- **Sequence Diagram**: For complex multi-service interactions
- **Surface Semantics & Ownership**: Required when the feature reuses/imports/references assets. Document source-of-truth ownership, where the assets appear in control-plane UX, and what runtime path materializes them.
- **Activation & Reachability Path**: Required when the feature adds or changes reachable behavior. Document the intended production entry point, caller chain, and where wiring proof will come from later.

#### 4. The 12 Architectural Concerns

Every HLD must address these. Use N/A with justification if not applicable.

**Structural Concerns:**

| #   | Concern                 | What to Document                                     |
| --- | ----------------------- | ---------------------------------------------------- |
| 1   | **Tenant Isolation**    | How data is scoped per tenant (query-level tenantId) |
| 2   | **Data Access Pattern** | Repository layer? Direct model? Caching?             |
| 3   | **API Contract**        | Request/response shapes, error envelope, versioning  |
| 4   | **Security Surface**    | Auth, input validation, SSRF prevention, encryption  |

**Behavioral Concerns:**

| #   | Concern           | What to Document                                             |
| --- | ----------------- | ------------------------------------------------------------ |
| 5   | **Error Model**   | What fails, how, user experience, recovery                   |
| 6   | **Failure Modes** | Network partition, timeout, partial failure, circuit breaker |
| 7   | **Idempotency**   | Safe retry, dedup strategy                                   |
| 8   | **Observability** | Traces, logs, debug in production                            |

**Operational Concerns:**

| #   | Concern                | What to Document                                  |
| --- | ---------------------- | ------------------------------------------------- |
| 9   | **Performance Budget** | Latency targets, payload sizes, batch limits      |
| 10  | **Migration Path**     | Current state → target state transition           |
| 11  | **Rollback Plan**      | Revert strategy if production fails               |
| 12  | **Test Strategy**      | Unit vs integration vs E2E split, coverage target |

#### 5. Data Model

- New collections/tables (schema, fields, types, indexes)
- Modified collections/tables
- Key relationships

#### 6. API Design

- New endpoints (method, path, purpose, auth)
- Modified endpoints
- Error responses

#### 7. Cross-Cutting Concerns

- Audit logging
- Rate limiting
- Caching (strategy and TTLs)
- Encryption (at rest and in transit)

#### 8. Dependencies

- Upstream (this feature depends on) — with risk assessment
- Downstream (depends on this feature) — with impact assessment

#### 9. Open Questions & Decisions Needed

#### 10. References

### Step 4: Validate

1. Verify all 12 concerns are addressed
2. Verify at least 2 alternatives were considered
3. Cross-reference with feature spec — every FR should be traceable to the design
4. If the feature imports or references assets, verify the HLD explains local-vs-referenced ownership and the design-time/runtime boundary
5. Verify the activation path and production reachability thinking are explicit when the behavior must be reachable in production
6. Verify bugfix characterization and the critical-feature gate were consumed when applicable

### Step 5: Review

Run 3 rounds:

Every round emits the standard review output contract from [pipeline.md — Review Round Output Contract](pipeline.md#review-round-output-contract).

**Round 1 — Full Audit**

- [ ] All 12 architectural concerns addressed
- [ ] 2+ alternatives with trade-offs
- [ ] Architecture diagrams present
- [ ] Data model complete
- [ ] API design complete
- [ ] Open questions listed
- [ ] Imported/referenced asset features explain surface ownership and design-time vs runtime materialization
- [ ] Activation and production reachability path are explicit when relevant

**Round 2 — Deep Dive**

- [ ] Data model/API design reviewed for correctness
- [ ] Previously-flagged items verified as fixed
- [ ] Error model covers real failure scenarios
- [ ] Performance budget is realistic
- [ ] Wiring and reachability assumptions are plausible and evidence-backed

**Round 3 — Cross-Phase Consistency**

- [ ] HLD implements all FRs from feature spec
- [ ] Test strategy aligns with test spec scenarios
- [ ] No contradictions between feature spec and HLD
- [ ] Critical-feature gate and bugfix characterization remain reflected when applicable

### Step 6: Commit & Log

1. Commit: `[ABLP-2] docs(<scope>): add <feature-name> HLD`
2. Log to `docs/sdlc-logs/<slug>/hld.log.md`
3. Append the standard `## Phase Handoff Packet` to `docs/sdlc-logs/<slug>/hld.log.md` using the template from [pipeline.md — Phase Handoff Packet](pipeline.md#phase-handoff-packet)
4. Update `<package>/agents.md` for each package touched — append learnings (service boundaries discovered, undocumented dependencies, data flow quirks). See [pipeline.md — Package Learnings](pipeline.md#package-learnings-agentsmd) for details.
   - If a package has no `agents.md`, create one with a heading and the first entry
   - If learnings span multiple packages, also append to `docs/sdlc-logs/agents.md`

## Context Management

See [pipeline.md — Context Management](pipeline.md#context-management) for the full rules. Key points for this phase:

- After writing the HLD to disk, re-read it if you need to reference it — don't rely on memory
- Spawn oracle and auditor as separate operations with fresh context
- HLD has 3 review rounds — summarize fixes in 3-5 bullets between each round
- After committing, clear/compress context before the next SDLC phase

## Quality Principles

This phase is governed by the [Quality Principles](pipeline.md#quality-principles) defined in the pipeline reference. In particular:

- **No Shortcuts**: All 12 architectural concerns must be genuinely addressed — not hand-waved with "TBD". Alternatives must be real trade-off evaluations, not strawmen set up to fail. The design must account for isolation, auth, error handling, and failure modes, not just the happy path.
- **Test Integrity**: The test strategy (concern #12) must specify real service boundaries for integration tests and real HTTP API interaction for E2E tests. Do not design a test strategy around mocking codebase components.

## Output Checklist

- [ ] HLD at `docs/specs/<slug>.hld.md`
- [ ] All 12 concerns addressed
- [ ] 2+ alternatives considered
- [ ] Architecture diagrams included
- [ ] Activation and reachability path documented when relevant
- [ ] Phase Handoff Packet appended to the phase log
- [ ] `agents.md` updated for each package touched
- [ ] Committed to version control

## Next Phase

Proceed to [Phase 4: LLD](lld-playbook.md).
