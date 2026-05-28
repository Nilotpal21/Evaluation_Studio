# Phase 2: Test Spec Playbook

Generate a comprehensive testing specification. This defines how to verify the feature works — E2E and integration scenarios are mandatory.

## Prerequisites

- Feature spec at `docs/features/<slug>.md` — **required** (run Phase 1 first if missing)
- Access to existing test files in the codebase

## Workflow

### Step 1: Read the Feature Spec

Read `docs/features/<slug>.md` thoroughly. Extract:

- All functional requirements (FR-N)
- User stories
- Data model
- API endpoints
- Non-functional concerns
- Delivery plan phases
- Any surface-semantics contract: supported asset/entity types, design-time surfaces, runtime materialization, and unsupported/local-only behavior

Also read:

- The previous phase's `## Phase Handoff Packet` from `docs/sdlc-logs/<slug>/feature-spec.log.md`
- Existing test files: search `**/__tests__/**` and `**/*.test.ts` for existing coverage
- HLD/LLD if they exist: `docs/specs/` and `docs/plans/`
- Bugfix characterization artifact if present: `docs/sdlc-logs/<slug>/characterization.md`

### Step 2: Ask Clarifying Questions

Ask 3-5 questions per area.

**Test Scope & Priorities**

- Which functional requirements are highest risk?
- Are there known edge cases or failure modes from production?
- What's the current test coverage baseline?
- What external dependencies need mocking vs real integration?
- What's the test environment setup — Docker, local services, CI?

**E2E Scenarios**

- What are the critical user journeys that must work end-to-end?
- What auth/permission combinations need E2E coverage?
- Are there cross-feature interactions that need E2E testing?
- What data seeding is required?
- Are there performance/load scenarios to include?
- If assets are imported/reused/referenced, which surfaces should show them, which surfaces should stay local-only, and what should be validated at runtime versus only in design-time UX?

**Integration Boundaries**

- Which service boundaries need integration tests?
- Are there webhook/event-driven flows?
- What tenant/project isolation scenarios need testing?
- Are there race conditions or concurrency scenarios?
- What error/failure paths need integration-level testing?

**Critical Feature Gate Verification (auth, isolation, compliance, privacy, retention, encryption)**

- Which terminology boundaries need explicit test coverage so later phases do not redefine the contract?
- What fail-closed behaviors must be proven: status codes, error envelope, non-leaky 404s, reject paths?
- Which threat-model abuse paths need direct test scenarios?
- What rollout and rollback behavior must be proven before HLD starts?

**How to handle answers — use the [Decision Classification Protocol](pipeline.md#decision-classification-protocol):**

- **ANSWERED**: Answer found in code/docs — proceed, cite the source
- **INFERRED**: Answer derived from patterns/conventions — proceed, state the basis
- **DECIDED**: No clear answer; judgment call made — proceed, document the rationale
- **AMBIGUOUS**: Multiple valid interpretations — **ask the user and wait**
- Log all classifications to `docs/sdlc-logs/<slug>/test-spec.log.md`

### Step 3: Generate the Test Spec

Create the test spec with these **mandatory** sections:

#### Coverage Matrix

```markdown
| FR   | Description | Unit | Integration | E2E | Manual | Status |
| ---- | ----------- | ---- | ----------- | --- | ------ | ------ |
| FR-1 | ...         | ❌   | ❌          | ❌  | ❌     | ...    |
```

Every FR from the feature spec MUST appear.

#### E2E Test Scenarios (MANDATORY — minimum 5)

For each scenario:

- **Preconditions**: Setup required
- **Steps**: Numbered HTTP requests (POST, GET, etc.)
- **Expected Result**: What success looks like
- **Auth Context**: tenant + project + user
- **Isolation Check**: Cross-tenant returns 404

**E2E Rules:**

- Must exercise the real system through its HTTP API
- No mocking codebase components (`vi.mock`, `jest.mock` are forbidden)
- No direct DB access (no importing Mongoose models)
- Start real servers on random ports with full middleware chain
- Include structured content types, not just plain strings
- If this is a bug fix or regression, preserve at least one negative-proof scenario from `docs/sdlc-logs/<slug>/characterization.md`

#### Integration Test Scenarios (MANDATORY — minimum 5)

For each scenario:

- **Boundary**: Which services are being tested together
- **Setup**: Required infrastructure
- **Steps**: What happens
- **Expected Result**: Success criteria
- **Failure Mode**: What happens when a dependency is down

#### Unit Test Scenarios

For each scenario:

- **Module**: What's being tested
- **Input**: Test data
- **Expected Output**: What the function should return

#### Surface Semantics & Design-Time vs Runtime Verification

Required when the feature imports, reuses, references, mounts, or otherwise exposes assets across boundaries. Use N/A with justification if not applicable.

- Supported asset/entity types
- Where each asset appears at design time (inventory page, contextual picker, read-only badge, etc.)
- Which surfaces intentionally stay local-only
- Whether the asset is editable or read-only in each surface
- How design-time names or bindings map to runtime names / mounts / selectors / snapshots
- Which unsupported asset classes must remain absent

#### Security & Isolation Tests

- [ ] Cross-tenant access returns 404
- [ ] Cross-project access returns 404
- [ ] Cross-user access returns 404 (for user-owned resources)
- [ ] Missing auth returns 401
- [ ] Insufficient permissions returns 403
- [ ] Input validation rejects malformed data

#### Critical Feature Gate Coverage

Required for auth, isolation, compliance, privacy, retention, or encryption work. Use `N/A` with justification otherwise.

- Terminology coverage: how the test plan proves the boundary vocabulary stays stable
- Fail-closed coverage: deny paths, non-leaky status codes, error-envelope assertions
- Threat-model coverage: abuse-path or misuse scenarios derived from the protected assets
- Rollout and rollback coverage: mode transitions, compatibility lanes, migration guards, or feature-flag behavior

#### Performance & Load Tests (if applicable)

#### Test Infrastructure

- Required services (Docker, databases, etc.)
- Data seeding strategy
- Environment variables needed
- CI configuration

#### Test File Mapping

```markdown
| Test File | Type        | Covers     |
| --------- | ----------- | ---------- |
| ...       | e2e         | FR-1, FR-2 |
| ...       | integration | FR-3       |
```

#### Open Testing Questions

### Step 4: Update Cross-References

1. Update `docs/testing/README.md` with the new entry
2. Update the feature spec's §17 (Testing & Validation) to reference this test spec
3. If sub-feature: update `docs/testing/sub-features/README.md`

### Step 5: Review

Run 2 rounds of review:

Every round emits the standard review output contract from [pipeline.md — Review Round Output Contract](pipeline.md#review-round-output-contract).

**Round 1 — Coverage & Completeness**

- [ ] At least 5 E2E test scenarios
- [ ] At least 5 integration test scenarios
- [ ] Every FR from feature spec appears in coverage matrix
- [ ] E2E scenarios specify auth context
- [ ] E2E scenarios do NOT reference mocks or direct DB access
- [ ] Integration scenarios specify service boundaries
- [ ] Security & isolation section filled (not just checkboxes)
- [ ] Test file mapping has actual or planned paths
- [ ] Imported/referenced asset features include design-time vs runtime verification and local-only / unsupported-surface assertions where relevant
- [ ] Critical-feature gate coverage is complete when applicable

**Round 2 — Alignment**

- [ ] Scenarios cover the highest-risk FRs identified in Step 2
- [ ] E2E scenarios match user stories from the feature spec
- [ ] Integration boundaries match the data flow from the feature spec
- [ ] Surface-semantics scenarios align with the feature spec's supported/unsupported asset contract
- [ ] Bugfix characterization negative proof is preserved when applicable

### Step 6: Commit & Log

1. Commit: `[ABLP-2] docs(<scope>): add <feature-name> test spec`
2. Log to `docs/sdlc-logs/<slug>/test-spec.log.md`
3. Append the standard `## Phase Handoff Packet` to `docs/sdlc-logs/<slug>/test-spec.log.md` using the template from [pipeline.md — Phase Handoff Packet](pipeline.md#phase-handoff-packet)
4. Update `<package>/agents.md` for each package touched — append learnings (testing infrastructure available, coverage baseline, missing test fixtures). See [pipeline.md — Package Learnings](pipeline.md#package-learnings-agentsmd) for details.
   - If a package has no `agents.md`, create one with a heading and the first entry
   - If learnings span multiple packages, also append to `docs/sdlc-logs/agents.md`

## Context Management

See [pipeline.md — Context Management](pipeline.md#context-management) for the full rules. Key points for this phase:

- After writing the test spec to disk, re-read it if you need to reference it — don't rely on memory
- Spawn oracle and auditor as separate operations with fresh context
- After resolving audit findings, summarize in 3-5 bullets before the next round
- After committing, clear/compress context before the next SDLC phase

## Quality Principles

This phase is governed by the [Quality Principles](pipeline.md#quality-principles) defined in the pipeline reference. In particular:

- **No Shortcuts**: E2E and integration scenarios must be realistic end-to-end flows, not simplified stubs. Minimum 5 each — no exceptions. Scenarios must cover auth, isolation, and error paths, not just the happy path.
- **Test Integrity**: E2E scenarios must specify real HTTP calls against real servers with full middleware. Integration scenarios must test real service boundaries. No scenario should describe mocking codebase components — only external third-party services may be mocked, and only via dependency injection (not `vi.mock()`/`jest.mock()`). Scenarios must include structured content types, not just plain strings. No TODO stubs.

## Output Checklist

- [ ] Test spec at `docs/testing/<slug>.md`
- [ ] 5+ E2E scenarios, 5+ integration scenarios
- [ ] Coverage matrix maps every FR
- [ ] Testing README updated
- [ ] Feature spec §17 cross-referenced
- [ ] Phase Handoff Packet appended to the phase log
- [ ] `agents.md` updated for each package touched
- [ ] Committed to version control

## Next Phase

Proceed to [Phase 3: HLD](hld-playbook.md).
