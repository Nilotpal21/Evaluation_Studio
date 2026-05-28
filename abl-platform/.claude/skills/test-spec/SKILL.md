---
name: test-spec
description: Generate a comprehensive testing specification in docs/testing/. Mandates E2E and integration test scenarios. Asks 3-5 clarifying questions before writing. Reads the feature spec from docs/features/ as input.
---

# Test Spec Generator

> **Playbook**: [`docs/sdlc/test-spec-playbook.md`](docs/sdlc/test-spec-playbook.md) | **Pipeline**: [`docs/sdlc/pipeline.md`](docs/sdlc/pipeline.md)

## Purpose

Generates a comprehensive testing specification in `docs/testing/` for a feature. ALWAYS includes E2E test scenarios and integration test scenarios — these are non-negotiable. Reads the feature spec as primary input.

## Trigger

User invokes `/test-spec <feature-name>`.

## Workflow

### Phase 1: Read Feature Spec

1. **Find the feature spec**: Look in `docs/features/<feature>.md` or `docs/features/sub-features/<feature>.md`
2. **If no feature spec exists**: STOP and tell the user to run `/feature-spec` first. A test spec without a feature spec is incomplete by definition.
3. **Read the feature spec** thoroughly — extract:
   - All functional requirements (FR-N)
   - User stories
   - Data model
   - API endpoints
   - Non-functional concerns
   - Delivery plan phases
4. **Read existing test files**: Search `**/__tests__/**` and `**/*.test.ts` for existing coverage of this feature
5. **Read the HLD/LLD if they exist**: Check `docs/specs/` and `docs/plans/` for related design docs

### Phase 2: Clarifying Questions

Ask 3-5 clarifying questions for EACH area:

**Test Scope & Priorities (3-5 questions)**

- Which functional requirements are highest risk and need the most coverage?
- Are there known edge cases or failure modes from production/support?
- What's the current test coverage baseline (if any)?
- Are there external dependencies that need mocking vs real integration?
- What's the test environment setup — Docker, local services, CI?

**E2E Scenarios (3-5 questions)**

- What are the critical user journeys that must work end-to-end?
- What auth/permission combinations need E2E coverage?
- Are there cross-feature interactions that need E2E testing?
- What data seeding is required for realistic E2E scenarios?
- Are there performance/load scenarios to include?

**Integration Boundaries (3-5 questions)**

- Which service boundaries need integration tests (API → DB, service → service)?
- Are there webhook/event-driven flows that need integration coverage?
- What tenant/project isolation scenarios need testing?
- Are there race conditions or concurrency scenarios?
- What error/failure paths need integration-level testing?

**Spawn the product-oracle agent** to answer these questions autonomously:

- Pass ALL questions grouped by section as the prompt
- Include: "Answer these clarifying questions for the test spec: <feature-name>. Read the feature spec at docs/features/<slug>.md, existing tests, and CLAUDE.md E2E standards."
- The oracle will return ANSWERED, INFERRED, DECIDED, or AMBIGUOUS classifications
- **If ANY questions are AMBIGUOUS**: Present ONLY those to the user and wait
- **If ALL questions are ANSWERED/INFERRED/DECIDED**: Proceed immediately

**Log the oracle decisions** to `docs/sdlc-logs/<slug>/test-spec.log.md`.

### Phase 3: Generation

Generate the test spec with these MANDATORY sections:

```markdown
# Test Specification: <Feature Name>

**Feature Spec**: `docs/features/<slug>.md`
**HLD**: `docs/specs/<slug>.hld.md` (if exists)
**LLD**: `docs/plans/<slug>.md` (if exists)
**Status**: PLANNED | IN PROGRESS | STABLE
**Last Updated**: <date>

---

## 1. Coverage Matrix

| FR   | Description | Unit  | Integration | E2E   | Manual | Status |
| ---- | ----------- | ----- | ----------- | ----- | ------ | ------ |
| FR-1 | ...         | ✅/❌ | ✅/❌       | ✅/❌ | ✅/❌  | ...    |

## 2. E2E Test Scenarios (MANDATORY)

CRITICAL: E2E tests must exercise the real system through its HTTP API.
No mocks, no direct DB access, no stubbed servers.

### E2E-1: <Scenario Name>

- **Preconditions**: ...
- **Steps**: 1. POST ... 2. GET ... 3. Assert ...
- **Expected Result**: ...
- **Auth Context**: tenant + project + user
- **Isolation Check**: Cross-tenant returns 404

### E2E-ERR-1: <Form Name> — Submission with Invalid Data

- **Preconditions**: authenticated user on the form page
- **Steps**: 1. Navigate to form. 2. Submit with invalid/missing required field. 3. Assert field-level error appears in DOM. 4. Fix field. 5. Re-submit. 6. Assert success.
- **Expected Result**: error message visible in UI; form does not navigate away on failure
- **Auth Context**: tenant + project + user
- **Why required**: "forms fail on first try" is the most common Studio quality gap — no test ever submits with bad data

### E2E-ERR-2: <Form Name> — API Returns 422

- **Preconditions**: authenticated user; server configured to return 422 for this input
- **Steps**: 1. Submit valid-looking form data that the server rejects (e.g., duplicate name). 2. Assert error message from server response is displayed in the UI.
- **Expected Result**: user sees the server's error message, not a blank form or silent failure
- **Auth Context**: tenant + project + user

(minimum 5 E2E scenarios)

## 3. Integration Test Scenarios (MANDATORY)

### INT-1: <Scenario Name>

- **Boundary**: <service A → service B>
- **Setup**: ...
- **Steps**: ...
- **Expected Result**: ...
- **Failure Mode**: <what happens when B is down>

(minimum 5 integration scenarios)

## 4. Unit Test Scenarios

### UT-1: <Scenario Name>

- **Module**: ...
- **Input**: ...
- **Expected Output**: ...

## 5. Security & Isolation Tests

- [ ] Cross-tenant access returns 404
- [ ] Cross-project access returns 404
- [ ] Cross-user access returns 404 (for user-owned resources)
- [ ] Missing auth returns 401
- [ ] Insufficient permissions returns 403
- [ ] Input validation rejects malformed data

## 6. Performance & Load Tests (if applicable)

## 7. Test Infrastructure

- **Required services**: ...
- **Data seeding**: ...
- **Environment variables**: ...
- **CI configuration**: ...

## 8. Test File Mapping

| Test File | Type        | Covers     |
| --------- | ----------- | ---------- |
| ...       | e2e         | FR-1, FR-2 |
| ...       | integration | FR-3       |

## 9. Open Testing Questions

1. ...
```

### Phase 4: Cross-References

1. Update `docs/testing/README.md` if this is a new entry
2. Update the feature spec's "Testing & Validation" section (§17) to reference this test spec
3. If sub-feature, update `docs/testing/sub-features/README.md`

### Phase 4b: Audit Loop (2 rounds minimum)

Spawn the **phase-auditor** agent:

```
Audit this test spec.
Phase: TEST-SPEC
Artifact: docs/testing/<slug>.md
Feature spec: docs/features/<slug>.md
Round: 1 of 2
```

**Audit feedback loop:**

1. Auditor returns APPROVED or NEEDS_REVISION
2. If NEEDS_REVISION: fix CRITICAL/HIGH findings (especially E2E count, FR mapping, no-mocks), re-submit round 2
3. After round 2: proceed (log remaining MEDIUM findings)

**Ralph-loop integration:** If `.claude/ralph-loop.local.md` exists and is active, each loop iteration counts as an audit round — skip internal loops.

### Phase 5: Commit & Log

1. **Commit the test spec**: `git add docs/testing/<slug>.md` and commit with message: `[ABLP-2] docs(<scope>): add <feature-name> test spec`
2. **Log progress** to `docs/sdlc-logs/<slug>/test-spec.log.md`
3. **Update agents.md** for each package touched — append learnings (testing infrastructure available, coverage baseline, missing test fixtures) to `<package>/agents.md`. See [`docs/sdlc/pipeline.md` — Package Learnings](docs/sdlc/pipeline.md#package-learnings-agentsmd) for what to log. Cross-cutting → `docs/sdlc-logs/agents.md`.
4. **Next phase**: Tell the user to run `/hld <feature-name>` next

## Context Management

CRITICAL: SDLC skills generate large amounts of context (oracle answers, spec content, audit findings). You MUST actively manage context to avoid degradation.

**Between phases within this skill:**

- After Phase 3 (Generation) completes and the file is written, the spec content is persisted on disk. You do NOT need to keep it in working memory — re-read the file if needed.
- Always spawn the product-oracle and phase-auditor as **separate Agent tool invocations**. They start with fresh context and return only their findings. Never inline oracle/auditor work in the main conversation.

**Between audit rounds:**

- After resolving findings from audit round N, briefly summarize what was fixed (3-5 bullet points) before spawning round N+1. Do NOT carry forward the full audit report text.
- Each audit agent reads the artifact fresh from disk — it does not need the prior round's full findings passed in.

**After this skill completes:**

- Once the commit succeeds, run `/compact` to compress conversation context before the user invokes the next SDLC phase (e.g., `/hld`).
- If the user invokes the next SDLC skill in the same conversation, the first action of that skill should be to read its inputs fresh from disk — never rely on in-memory context from a prior skill's execution.

## Quality Gates

> Governed by the [Quality Principles](docs/sdlc/pipeline.md#quality-principles). No shortcuts — robust & architecturally sound. Test integrity — no mocking codebase components.

- MUST have at least 5 E2E test scenarios — no exceptions
- MUST have at least 5 integration test scenarios — no exceptions
- Every functional requirement (FR-N) from the feature spec must appear in the coverage matrix
- Security & isolation tests section must be filled (not just checkboxes)
- E2E scenarios must specify auth context (tenant + project + user)
- E2E scenarios must NOT reference mocks, stubs, or direct DB access — only external third-party services may be mocked, and only via dependency injection
- E2E scenarios must describe real HTTP API interaction against real servers with full middleware chain
- Integration scenarios must specify the service boundary being tested — both services must be real, not stubbed
- Integration scenarios must NOT mock the components under test — mock only external dependencies outside the service boundary
- Test file mapping must map to actual or planned test file paths
- No TODO stubs — every scenario must have concrete steps, expected results, and auth context
- Scenarios must include structured content types (arrays, objects), not just plain strings
- **Form error path E2E scenarios are MANDATORY** for any feature with a form: at least 1 scenario must submit the form with invalid/missing data and assert the error message appears in the DOM; at least 1 scenario must test the API returning a 4xx error and assert the error is surfaced in the UI — not just that the request was made
- **Wiring verification scenario is MANDATORY** for any feature with a new Studio API route: at least 1 E2E scenario must prove the Studio UI → Studio API route → runtime/service chain is reachable by making a real HTTP request through the full chain — never mock the route or the service in this scenario
- The Coverage Matrix must have at least one row explicitly for the error/failure path of each form or mutation — not just the success path
