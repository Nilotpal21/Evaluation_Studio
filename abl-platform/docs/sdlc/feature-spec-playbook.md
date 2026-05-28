# Phase 1: Feature Spec Playbook

Generate a repository-grounded feature specification. This is the first artifact in the SDLC pipeline — it defines what to build, who it's for, and why.

## Prerequisites

- A problem description or feature request
- Access to the codebase and existing docs

## Workflow

### Step 1: Check for Prior Art

Before writing anything:

1. Check if a spec already exists in `docs/features/` for this feature
2. Check `docs/specs/` and `docs/plans/` for related design work
3. Search the codebase for existing implementations related to the feature
4. Read `docs/features/TEMPLATE.md` and `docs/features/AUTHORING_GUIDE.md`
5. If this is a bug fix or regression, create or refresh `docs/sdlc-logs/<slug>/characterization.md` with the reproduction artifact, target seam, and negative proof before broadening scope

### Step 2: Ask Clarifying Questions

**Do NOT generate a full document from a one-line description.** Ask 3-5 questions per area first.

**Scope & Problem**

- What specific problem does this solve? Who experiences it today?
- What is the boundary — what is explicitly OUT of scope?
- Is this a new capability or an enhancement to an existing feature?
- What's the priority/timeline driver?
- Are there competing approaches or prior attempts?

**User Stories & Requirements**

- Who are the primary personas (developer, operator, admin, end-user)?
- What are the critical user journeys?
- What are the must-have vs nice-to-have requirements?
- Are there specific performance or scale requirements?
- What existing features does this interact with?
- If the feature imports, reuses, or references assets across boundaries, which asset types are supported, where should they appear in consumer UIs, and what is intentionally local-only or out of scope?

**Technical & Architecture**

- Which packages/services are affected?
- What data models need to change?
- Are there security/isolation implications?
- What's the deployment/migration strategy?
- Are there external dependencies or integrations?

**Critical Feature Gate (auth, isolation, compliance, privacy, retention, encryption)**

- Which overlapping terms need a short terminology table before design starts?
- What is the fail-closed contract: status codes, error-envelope shape, and non-leaky behavior?
- Which assets, actors, or data paths need a threat-model summary?
- What rollout and rollback shape is required: `audit`, `warn`, `enforce`, feature flag, migration guard, or compatibility lane?

**How to handle answers — use the [Decision Classification Protocol](pipeline.md#decision-classification-protocol):**

- **ANSWERED**: Answer found in code/docs — proceed, cite the source
- **INFERRED**: Answer derived from patterns/conventions — proceed, state the basis
- **DECIDED**: No clear answer; judgment call made — proceed, document the rationale
- **AMBIGUOUS**: Multiple valid interpretations — **ask the user and wait**
- Log all classifications to `docs/sdlc-logs/<slug>/feature-spec.log.md`

### Step 3: Generate the Spec

Use `docs/features/TEMPLATE.md` as the skeleton. Fill ALL required sections:

| Section                      | What to Write                                                                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| §1 Introduction              | Problem statement, goal statement, summary                                                                                                            |
| §2 Scope                     | Goals (3+) and non-goals (3+)                                                                                                                         |
| §3 User Stories              | Minimum 3, using "As a `<persona>`, I want..." format                                                                                                 |
| §4 Functional Requirements   | Minimum 4, numbered FR-N, testable "The system must..." statements                                                                                    |
| §5 Classification Matrix     | Lifecycle impact + related feature integration matrix (2+ related features)                                                                           |
| §6 Design Considerations     | Mockups, UX flows, style system (if applicable)                                                                                                       |
| §7 Technical Considerations  | Constraints, dependencies, architectural decisions                                                                                                    |
| §8 How to Consume            | Studio UI, API Runtime, API Studio, Admin, Channels, plus a surface semantics matrix and design-time vs runtime behavior when assets cross boundaries |
| §9 Data Model                | Collections, fields, indexes, relationships                                                                                                           |
| §10 Key Implementation Files | Domain logic, routes, UI components, tests                                                                                                            |
| §11 Configuration            | Env vars, runtime config, DSL/IR references                                                                                                           |
| §12 Non-Functional Concerns  | Isolation (tenant/project/user), security, performance, reliability, observability, data lifecycle                                                    |
| §13 Delivery Plan            | Parent tasks with numbered subtasks                                                                                                                   |
| §14 Success Metrics          | Baseline, target, measurement method                                                                                                                  |
| §15 Open Questions           | Minimum 1 — nothing is fully known upfront                                                                                                            |
| §16 Gaps & Known Issues      | Severity + status for each                                                                                                                            |
| §17 Testing & Validation     | Coverage summary + pointer to test spec                                                                                                               |
| §18 References               | Links to related docs                                                                                                                                 |

**Rules:**

- Ground every claim in code evidence — if you can't find code to support a statement, mark it as a gap or open question
- Use N/A with justification for sections that don't apply
- Non-functional concerns MUST address tenant, project, and user isolation
- If the feature imports, reuses, references, or mounts assets, §8 MUST say which asset/entity types are supported, where they appear, whether they are editable, how consumers reference them, how runtime materializes them, and what stays unsupported or local-only
- If this is a bug fix or regression, reference `docs/sdlc-logs/<slug>/characterization.md` in §18 and preserve the reproduction artifact, target seam, and negative proof
- If this is auth, isolation, compliance, privacy, retention, or encryption work, the spec MUST capture the critical-feature gate before HLD:
  - terminology table
  - fail-closed behavior
  - threat-model summary
  - rollout and rollback shape

### Step 4: Determine Doc Location

- **Major feature** (own lifecycle, APIs, data model): `docs/features/<slug>.md`
- **Sub-feature** (narrower, nested under a broader feature): `docs/features/sub-features/<slug>.md`

### Step 5: Create Testing Guide Placeholder

Create a matching testing guide:

- Location: `docs/testing/<slug>.md` (or `docs/testing/sub-features/<slug>.md`)
- Include: coverage matrix with rows for each FR, E2E scenario stubs (3+), integration scenario stubs (3+)
- Status: PLANNED

### Step 6: Update Indexes

1. Add the new doc to `docs/features/README.md` (Major or Sub-Feature table)
2. Add the testing guide to `docs/testing/README.md`
3. If sub-feature: update `docs/features/sub-features/README.md` and `docs/testing/sub-features/README.md`

### Step 7: Review

Run 2 rounds of review. Each review should check:

Every round emits the standard review output contract from [pipeline.md — Review Round Output Contract](pipeline.md#review-round-output-contract).

**Round 1 — Completeness & Quality**

- [ ] All 18 TEMPLATE.md sections addressed
- [ ] Minimum 3 user stories
- [ ] Minimum 4 functional requirements (testable)
- [ ] Integration matrix references 2+ related features
- [ ] Non-functional concerns address isolation
- [ ] Imported/referenced asset features include a surface semantics matrix and explicit design-time vs runtime behavior
- [ ] Critical-feature gate is satisfied when applicable
- [ ] Delivery plan has parent tasks with numbered subtasks
- [ ] Open questions section has 1+ items
- [ ] Claims grounded in code evidence

**Round 2 — Cross-Phase Consistency**

- [ ] FR numbering is consistent and referenced in test matrix
- [ ] Scope boundaries match non-goals
- [ ] User stories align with functional requirements
- [ ] Implementation files exist at stated paths (or are clearly marked as planned)
- [ ] Supported vs unsupported asset/entity types are explicit, and standard list pages vs contextual authoring surfaces are not conflated
- [ ] Bugfix characterization artifact is referenced and still valid when applicable

Fix CRITICAL and HIGH findings. Log remaining MEDIUM findings.

### Step 8: Commit & Log

1. Commit: `[ABLP-2] docs(<scope>): add <feature-name> feature spec`
2. Log to `docs/sdlc-logs/<slug>/feature-spec.log.md`:
   - Questions asked and answers received
   - Files created
   - Review findings and resolutions
3. Append the standard `## Phase Handoff Packet` to `docs/sdlc-logs/<slug>/feature-spec.log.md` using the template from [pipeline.md — Phase Handoff Packet](pipeline.md#phase-handoff-packet)
4. Update `<package>/agents.md` for each package touched — append learnings (packages affected, existing patterns discovered, API surface surprises). See [pipeline.md — Package Learnings](pipeline.md#package-learnings-agentsmd) for details.
   - If a package has no `agents.md`, create one with a heading and the first entry
   - If learnings span multiple packages, also append to `docs/sdlc-logs/agents.md`

## Context Management

See [pipeline.md — Context Management](pipeline.md#context-management) for the full rules. Key points for this phase:

- After writing the spec to disk, re-read it if you need to reference it — don't rely on memory
- Spawn oracle and auditor as separate operations with fresh context
- After resolving audit findings, summarize in 3-5 bullets before the next round — don't carry the full report forward
- After committing, clear/compress context before the next SDLC phase

## Quality Principles

This phase is governed by the [Quality Principles](pipeline.md#quality-principles) defined in the pipeline reference. In particular:

- **No Shortcuts**: Requirements must be testable and complete, not hand-wavy. Non-functional concerns (isolation, security, performance) must be addressed in the spec, not deferred. Every claim must be grounded in code evidence — mark unknowns explicitly rather than guessing.
- **Test Integrity**: The testing placeholder (§17) and test spec scenarios must describe real system interactions. E2E scenarios should specify HTTP calls with auth context and isolation checks, not mock-based tests.

## Output Checklist

- [ ] Feature spec at `docs/features/<slug>.md` (or sub-features/)
- [ ] Testing guide placeholder at `docs/testing/<slug>.md`
- [ ] Index files updated (features README, testing README)
- [ ] SDLC log entry at `docs/sdlc-logs/<slug>/feature-spec.log.md`
- [ ] Phase Handoff Packet appended to the phase log
- [ ] `agents.md` updated for each package touched
- [ ] Committed to version control

## Next Phase

Proceed to [Phase 2: Test Spec](test-spec-playbook.md).
