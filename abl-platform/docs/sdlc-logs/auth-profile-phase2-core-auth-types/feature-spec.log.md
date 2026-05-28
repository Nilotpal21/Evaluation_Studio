# Feature Spec Log: Auth Profile Phase 2 Core Auth Types

## 2026-04-23

### Context

- Worktree: `/Users/Pattabhi.Dasari/abl-platform/.worktrees/auth-profile-phase2-core-auth-types`
- Feature slug: `auth-profile-phase2-core-auth-types`
- Source inputs:
  - prior user direction to focus Phase 2 on `basic`, `custom_header`, `aws_iam`, and `mtls`
  - existing auth-profile docs and Phase 2 plans
  - current backend/runtime/Studio code paths

### Clarification Questions and Inferred Answers

#### Scope & Problem

1. What specific problem does this solve? Who experiences it today?
   - **INFERRED**: Operators and platform engineers see a mismatch between backend-supported Phase 2 auth types and what Studio/runtime clearly expose and honor.
2. What is the boundary — what is explicitly out of scope?
   - **INFERRED**: Defer `azure_ad`, `ssh_key`, remaining Phase 2 follow-ons, and all Phase 3 auth types from this feature.
3. Is this a new capability or an enhancement to an existing feature?
   - **ANSWERED**: Enhancement/narrowed rollout of the existing Auth Profiles feature.
4. What is the priority or timeline driver?
   - **INFERRED**: Ship the core four types first instead of treating the full Phase 2 list as one monolith.
5. Are there competing approaches or prior attempts?
   - **INFERRED**: Prior approach was broad Phase 2 planning across all enterprise types; this feature narrows scope for clearer delivery.

#### User Stories & Requirements

1. Who are the primary personas?
   - **INFERRED**: Project admins, workspace operators, integration engineers, and platform/security reviewers.
2. What are the critical journeys?
   - **INFERRED**: Create profile, attach profile, validate whether runtime honors the auth type, and fail closed if unsupported.
3. What are the must-haves vs nice-to-haves?
   - **DECIDED**: Must-have = `basic`, `custom_header`, `aws_iam`, `mtls`; nice-to-have/deferred = rest of Phase 2.
4. Are there specific performance or scale requirements?
   - **INFERRED**: No special scale target beyond existing Auth Profiles behavior; signing/TLS overhead must be bounded to supported execution paths.
5. What existing features does this interact with?
   - **ANSWERED**: Auth Profiles, Tool Invocations, Connectors, and Integration Auth Profiles.

#### Technical & Architecture

1. Which packages/services are affected?
   - **ANSWERED**: `packages/shared`, `packages/database`, `apps/runtime`, `packages/compiler`, `apps/studio`.
2. What data models need to change?
   - **INFERRED**: No new collections; reuse `auth_profiles` and existing `authProfileId` bindings.
3. Are there security or isolation implications?
   - **ANSWERED**: Yes; preserve tenant/project/user isolation and redaction, and fail closed for unsupported `aws_iam` / `mtls`.
4. What is the deployment or migration strategy?
   - **INFERRED**: Additive rollout with no backfill; gate by Studio/runtime support completeness.
5. Are there external dependencies or integrations?
   - **INFERRED**: AWS SigV4 semantics and TLS client-cert support on HTTPS transport paths.

### Files Created

- `docs/features/sub-features/auth-profile-phase2-core-auth-types.md`
- `docs/testing/sub-features/auth-profile-phase2-core-auth-types.md`
- `docs/sdlc-logs/auth-profile-phase2-core-auth-types/feature-spec.log.md`

### Index Updates

- `docs/features/README.md`
- `docs/features/sub-features/README.md`
- `docs/testing/README.md`
- `docs/testing/sub-features/README.md`

### Audit Loop

#### Round 1

- **Method**: Local self-audit against `docs/features/TEMPLATE.md` and `docs/features/AUTHORING_GUIDE.md`
- **Findings**:
  - Missing sections from the earlier draft were filled: delivery plan, success metrics, gaps, testing & validation
  - Feature scope was tightened to avoid implying Phase 2 completion
  - Studio/backend/runtime distinction was made explicit
- **Resolution**: Updated the generated spec before writing final files

#### Round 2

- **Method**: Fresh local review pass focused on cross-phase consistency with the testing guide
- **Findings**:
  - Testing guide needed to call out current backend-vs-frontend mismatch more explicitly
  - `aws_iam` had to be marked as a signing gap rather than described as fully implemented
- **Resolution**: Aligned the testing guide and feature gaps with repository evidence

### Outstanding Decisions

- `roleArn` / `externalId` UI exposure is still open
- final placement of supported-consumer messaging in Studio picker flows is still open
- first supported `aws_iam` runtime path breadth is still open
