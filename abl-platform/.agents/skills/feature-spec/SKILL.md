---
name: feature-spec
description: Generate a complete feature specification in docs/features/. Asks 3-5 clarifying questions per major section before writing. Uses the project TEMPLATE.md. Also creates a placeholder testing guide.
---

# Feature Spec Generator

> **Playbook**: [`docs/sdlc/feature-spec-playbook.md`](docs/sdlc/feature-spec-playbook.md) | **Pipeline**: [`docs/sdlc/pipeline.md`](docs/sdlc/pipeline.md)

## Purpose

Generates a repository-grounded feature specification in `docs/features/` using the project's `TEMPLATE.md`. Ensures completeness by asking clarifying questions BEFORE writing each major section.

## Trigger

User invokes `/feature-spec <feature-name-or-description>`.

## Workflow

### Phase 1: Discovery & Clarification

BEFORE writing anything, you MUST ask clarifying questions. Do NOT skip this phase.

1. **Read the template**: `docs/features/TEMPLATE.md` and `docs/features/AUTHORING_GUIDE.md`
2. **Search for prior art**: Check if a spec already exists in `docs/features/` for this feature. Check `docs/specs/` and `docs/plans/` for related design work.
3. **Read relevant code**: Use Glob/Grep to find existing implementations related to the feature.
4. **Ask 3-5 clarifying questions for EACH of these areas** (present all at once, grouped by section):

   **Scope & Problem (3-5 questions)**
   - What specific problem does this solve? Who experiences it today?
   - What is the boundary — what is explicitly OUT of scope?
   - Is this a new capability or an enhancement to an existing feature?
   - What's the priority/timeline driver?
   - Are there competing approaches or prior attempts?

   **User Stories & Requirements (3-5 questions)**
   - Who are the primary personas (developer, operator, admin, end-user)?
   - What are the critical user journeys?
   - What are the must-have vs nice-to-have requirements?
   - Are there specific performance or scale requirements?
   - What existing features does this interact with?

   **Technical & Architecture (3-5 questions)**
   - Which packages/services are affected?
   - What data models need to change?
   - Are there security/isolation implications?
   - What's the deployment/migration strategy?
   - Are there external dependencies or integrations?

5. **Spawn the product-oracle agent** to answer these questions autonomously:
   - Pass ALL questions grouped by section as the prompt
   - Include: "Answer these clarifying questions for the feature: <feature-name>. Read docs/features/, AGENTS.md, and relevant code."
   - The oracle will return ANSWERED, INFERRED, DECIDED, or AMBIGUOUS classifications
   - **If ANY questions are AMBIGUOUS**: Present ONLY those to the user and wait
   - **If ALL questions are ANSWERED/INFERRED/DECIDED**: Proceed immediately — do not wait

6. **Log the oracle decisions** to `docs/sdlc-logs/<slug>/feature-spec.log.md`:
   - Record all questions asked, oracle answers, and decisions made
   - Flag any DECIDED items (oracle made a judgment call) for visibility

### Phase 2: Generation

After receiving answers (from oracle and/or user):

1. **Generate the feature spec** using `docs/features/TEMPLATE.md` as the skeleton
2. **Fill ALL required sections** per the Authoring Guide:
   - Introduction / Overview (with Problem Statement, Goal Statement, Summary)
   - Scope (Goals + Non-Goals)
   - User Stories (minimum 3)
   - Functional Requirements (numbered, testable FR-N statements)
   - Feature Classification & Integration Matrix
   - How to Consume (Studio UI, API Runtime, API Studio, Admin, Channels)
   - Data Model (collections, fields, indexes, relationships)
   - Key Implementation Files
   - Configuration (env vars, runtime config, DSL/IR)
   - Non-Functional Concerns (isolation, security, performance, reliability, observability, data lifecycle)
   - Delivery Plan / Work Breakdown (parent tasks with numbered subtasks)
   - Success Metrics
   - Open Questions
   - Gaps, Known Issues & Limitations
   - Testing & Validation
3. **Ground every claim in code evidence** — if you can't find code to support a statement, mark it as a gap or open question
4. **Determine doc type**: Major feature → `docs/features/<slug>.md`, Sub-feature → `docs/features/sub-features/<slug>.md`

### Phase 3: Testing Guide Placeholder

1. Create a matching testing guide in `docs/testing/<slug>.md` (or `docs/testing/sub-features/<slug>.md`)
2. Include sections from the testing-toolkit skill structure:
   - Feature metadata
   - Current State
   - Coverage Matrix (with rows for each FR, columns for unit/integration/e2e/manual)
   - E2E Test Scenarios (minimum 3)
   - Integration Test Scenarios (minimum 3)
   - Status: PLANNED

### Phase 4: Index Updates

1. Update `docs/features/README.md` — add the new doc to the appropriate table
2. Update `docs/testing/README.md` — add the new testing guide
3. If sub-feature, update `docs/features/sub-features/README.md` and `docs/testing/sub-features/README.md`

### Phase 4b: Audit Loop (2 rounds minimum)

Spawn the **phase-auditor** agent to audit the generated feature spec:

```
Audit this feature spec.
Phase: FEATURE-SPEC
Artifact: docs/features/<slug>.md
Reference: docs/features/TEMPLATE.md, docs/features/AUTHORING_GUIDE.md
Round: 1 of 2
```

**Audit feedback loop:**

1. Auditor returns APPROVED or NEEDS_REVISION with structured findings
2. If NEEDS_REVISION: fix ALL CRITICAL and HIGH findings, then re-submit for round 2
3. If APPROVED on round 1: still run round 2 as a fresh-eyes pass (auditor focuses on cross-phase consistency)
4. After round 2: proceed regardless (log any remaining MEDIUM findings)

**Ralph-loop integration:** If running inside a ralph-loop, each loop iteration counts as an audit round. The auditor findings are in the output — the next iteration picks them up. Do NOT run internal audit loops redundantly with the ralph-loop. Check for `.Codex/ralph-loop.local.md` to detect if you're in a loop.

**Log audit findings** to `docs/sdlc-logs/<slug>/feature-spec.log.md` — include round number, findings, and resolutions.

## Output

- Feature spec at `docs/features/<slug>.md`
- Testing guide placeholder at `docs/testing/<slug>.md`
- Updated index files
- Audit log in `docs/sdlc-logs/<slug>/feature-spec.log.md`

### Phase 5: Commit & Log

1. **Commit the feature spec**: `git add docs/features/<slug>.md docs/testing/<slug>.md` and commit with message: `[ABLP-2] docs(<scope>): add <feature-name> feature spec`
2. **Log progress** to `docs/sdlc-logs/<slug>/feature-spec.log.md`:
   - Timestamp, oracle decisions, files created, open questions
3. **Update agents.md** for each package touched — append learnings (packages affected, existing patterns discovered, API surface surprises) to `<package>/agents.md`. See [`docs/sdlc/pipeline.md` — Package Learnings](docs/sdlc/pipeline.md#package-learnings-agentsmd) for what to log.
   - If it spans multiple packages, also append to `docs/sdlc-logs/agents.md`
   - If a package has no `agents.md`, create one using the standard template
4. **Next phase**: Tell the user to run `/test-spec <feature-name>` next

## Context Management

CRITICAL: SDLC skills generate large amounts of context (oracle answers, spec content, audit findings). You MUST actively manage context to avoid degradation.

**Between phases within this skill:**

- After Phase 2 (Generation) completes and the file is written, the spec content is persisted on disk. You do NOT need to keep it in working memory — re-read the file if needed.
- Always spawn the product-oracle and phase-auditor as **separate Agent tool invocations**. They start with fresh context and return only their findings. Never inline oracle/auditor work in the main conversation.

**Between audit rounds:**

- After resolving findings from audit round N, briefly summarize what was fixed (3-5 bullet points) before spawning round N+1. Do NOT carry forward the full audit report text.
- Each audit agent reads the artifact fresh from disk — it does not need the prior round's full findings passed in.

**After this skill completes:**

- Once the commit succeeds, run `/compact` to compress conversation context before the user invokes the next SDLC phase (e.g., `/test-spec`).
- If the user invokes the next SDLC skill in the same conversation, the first action of that skill should be to read its inputs fresh from disk — never rely on in-memory context from a prior skill's execution.

## Quality Gates

> Governed by the [Quality Principles](docs/sdlc/pipeline.md#quality-principles). No shortcuts — robust & architecturally sound. Test integrity — no mocking codebase components.

- Every section of TEMPLATE.md must be addressed (use N/A with justification if not applicable)
- Minimum 3 user stories
- Minimum 4 functional requirements
- Integration matrix must reference at least 2 related features
- Non-functional concerns must address tenant, project, and user isolation — these are NOT optional
- Delivery plan must have parent tasks with numbered subtasks
- Open questions section must have at least 1 item (nothing is fully known upfront)
- Requirements must be testable and complete, not hand-wavy — "the system should work well" is not a requirement
- Every claim must be grounded in code evidence — mark unknowns explicitly rather than guessing
- Testing placeholder (§17) must describe real system interactions, not mock-based tests
- E2E scenarios in the testing placeholder must specify HTTP calls with auth context and isolation checks
