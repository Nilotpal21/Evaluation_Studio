# Test Spec Log: Auth Profile Phase 2 Core Auth Types

## 2026-04-23

### Context

- Worktree: `/Users/Pattabhi.Dasari/abl-platform/.worktrees/auth-profile-phase2-core-auth-types`
- Feature slug: `auth-profile-phase2-core-auth-types`
- Input feature spec: `docs/features/sub-features/auth-profile-phase2-core-auth-types.md`

### Clarification Questions and Inferred Answers

#### Test Scope & Priorities

1. Which functional requirements are highest risk and need the most coverage?
   - **DECIDED**: FR-3, FR-6, FR-7, FR-8, and FR-9 are the highest-risk items because they cover Studio reachability and runtime honoring/fail-closed behavior.
2. Are there known edge cases or failure modes from production/support?
   - **INFERRED**: The main failure mode is mismatch between backend support, Studio exposure, and runtime honoring, especially for `aws_iam` and `mtls`.
3. What is the current test coverage baseline?
   - **ANSWERED**: Shared schema/materialization tests exist, `custom_header` drift validation exists, and `mtls` HTTP-tool-path integration exists.
4. Are there external dependencies that need mocking vs real integration?
   - **DECIDED**: Internal codebase components must remain real. External verifier services for HTTPS mTLS and SigV4 may be local test servers.
5. What is the test environment setup?
   - **ANSWERED**: Existing Studio E2E suites use MongoMemoryServer, dev-login, local route modules, and optional local Redis.

#### E2E Scenarios

1. What are the critical user journeys that must work end to end?
   - **ANSWERED**: Create profile, attach profile, execute supported consumer, and fail closed on unsupported combinations.
2. What auth/permission combinations need E2E coverage?
   - **INFERRED**: Authenticated project admin happy paths plus cross-tenant/cross-project isolation failures.
3. Are there cross-feature interactions that need E2E testing?
   - **ANSWERED**: Yes; Auth Profiles interacts with Tool Invocations and connector-style `authProfileId` binding semantics.
4. What data seeding is required?
   - **ANSWERED**: Dev-login, project creation, auth-profile creation through public routes, and tool configuration through public APIs.
5. Are there performance/load scenarios to include?
   - **DECIDED**: No dedicated load test in this phase; lightweight overhead checks are sufficient.

#### Integration Boundaries

1. Which service boundaries need integration tests?
   - **ANSWERED**: shared validation -> Studio routes, shared validation -> Runtime routes, runtime auth resolution -> HTTP tool middleware, HTTP executor -> transport.
2. Are there webhook or event-driven flows?
   - **INFERRED**: Not central to this scoped feature.
3. What tenant/project isolation scenarios need testing?
   - **ANSWERED**: Cross-tenant `404`, cross-project `404`, and personal-profile visibility controls.
4. Are there race conditions or concurrency scenarios?
   - **DECIDED**: Not the first-order risk for this feature; signing/transport honoring is higher priority.
5. What error/failure paths need integration-level testing?
   - **ANSWERED**: `custom_header` drift, unsupported `aws_iam`, unsupported/plain-HTTP `mtls`, malformed payloads, and sanitized failure surfaces.

### Files Updated

- `docs/testing/sub-features/auth-profile-phase2-core-auth-types.md`
- `docs/sdlc-logs/auth-profile-phase2-core-auth-types/test-spec.log.md`

### Audit Loop

#### Round 1

- **Method**: Local self-audit against the test-spec skill quality gates
- **Findings**:
  - Placeholder guide needed to be replaced with a full FR matrix
  - Required minimum counts for E2E and integration scenarios were missing
  - Security/isolation section needed concrete expectations instead of placeholders
- **Resolution**: Replaced the placeholder with a full test spec containing 7 E2E scenarios, 7 integration scenarios, and detailed isolation coverage

#### Round 2

- **Method**: Fresh local pass focused on file mapping and harness realism
- **Findings**:
  - Test file mapping needed to point at existing auth-profile and tool-invocation harnesses
  - `aws_iam` coverage had to stay explicitly planned until a signer exists
- **Resolution**: Added concrete existing/planned test files and kept `aws_iam` marked as planned rather than overstating coverage

### Notes

- No commit was created in this step because the user did not ask for one.
- Feature spec cross-reference already pointed to this testing guide, so no additional feature-doc rewrite was required.
