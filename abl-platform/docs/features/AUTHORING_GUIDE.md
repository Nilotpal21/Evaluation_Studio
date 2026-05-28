# Feature Doc Authoring Guide

Use this guide when creating or refreshing feature documentation in `docs/features/`.

## 1. Choose the Right Doc Type

| Doc Type          | When to Use It                                                                    | Location                                  |
| ----------------- | --------------------------------------------------------------------------------- | ----------------------------------------- |
| Major feature     | Platform capability with its own lifecycle, APIs, data model, and testing surface | `docs/features/<feature>.md`              |
| Sub-feature       | Focused capability nested under a broader feature                                 | `docs/features/sub-features/<feature>.md` |
| Cross-feature hub | Overview page that ties multiple major features together                          | `docs/features/<feature>.md`              |

Mirror the same structure in `docs/testing/`.

## 2. Authoring Rules

- Start from [TEMPLATE.md](TEMPLATE.md).
- Ground the doc in repository evidence: code, tests, [feature-matrix.md](../feature-matrix.md), and [enterprise-readiness.md](../enterprise-readiness.md).
- Do not invent shipped behavior. Mark unknowns explicitly in `Open Questions` or `Gaps`.
- For features that import, reuse, reference, or mount assets across boundaries, explicitly document the surface semantics: which asset types are supported, where they appear at design time, whether they are editable or read-only, how consumers reference them, what runtime materializes, and which asset classes remain unsupported.
- Always fill in:
  - Introduction / Overview
  - Goals
  - User Stories
  - Functional Requirements
  - Non-Goals
  - Feature Classification & Integration Matrix
  - Non-Functional Concerns, including project / tenant / user isolation
  - Success Metrics
  - Open Questions
  - Delivery Plan / Work Breakdown with parent tasks and numbered subtasks
- In `How to Consume`, distinguish standard inventory/list pages from contextual authoring surfaces, and document design-time vs runtime behavior whenever the feature has a control-plane/runtime split.
- Add or update the matching testing guide in `docs/testing/`.
- Update [README.md](README.md), [../testing/README.md](../testing/README.md), and the sub-feature indexes when adding new docs.

## 3. Sub-Feature Placement

Focused docs should live under `sub-features/` once they are clearly narrower than a major platform capability.

Examples:

- `docs/features/sub-features/password-login.md`
- `docs/features/sub-features/sdk-channel-creation.md`
- `docs/testing/sub-features/password-login.md`

If a feature grows into a major platform surface with its own lifecycle, move it back to the top level and leave a redirect note or update all references in the same change.

## 4. Feature Index Expectations

Every new feature or sub-feature should update the indexes so readers can discover it quickly.

- Add major features to the `Major Feature Modules` table in [README.md](README.md).
- Add focused docs to the `Focused Sub-Feature Modules` table in [README.md](README.md).
- Add matching testing guides to [../testing/README.md](../testing/README.md).
- If the doc is a sub-feature, add it to [sub-features/README.md](sub-features/README.md) and `docs/testing/sub-features/README.md`.

## 5. Recommended Authoring Prompt

Use the prompt below when asking an LLM or agent to generate a new feature doc:

```md
Generate a repository-grounded feature document for <feature name> using `docs/features/TEMPLATE.md`.

Requirements:

- Decide whether this is a major feature, a sub-feature, or a cross-feature hub.
- If it is a sub-feature, place it in `docs/features/sub-features/<slug>.md` and create the matching testing guide in `docs/testing/sub-features/<slug>.md`.
- Use code, tests, `docs/feature-matrix.md`, and `docs/enterprise-readiness.md` as source material.
- Fill all required sections in the template, including:
  - Introduction / Overview
  - Goals
  - User Stories
  - Functional Requirements
  - Non-Goals
  - Lifecycle / platform impact matrix
  - Related feature integration matrix
  - Surface semantics for any imported/reused/shared asset types: supported assets, where they appear, editability, consumer reference model, runtime materialization, unsupported assets
  - Non-functional concerns, especially project / tenant / user isolation
  - Success Metrics
  - Open Questions
  - Delivery Plan / Work Breakdown with numbered parent tasks and subtasks
- Explicitly call out customer-facing, agent-lifecycle, project-lifecycle, observability, governance, and enterprise impact where relevant.
- Cross-link related feature docs and the matching testing guide.
- Update `docs/features/README.md`, `docs/testing/README.md`, and any sub-feature indexes if a new doc is created or moved.
- Mark unknowns or unverified behavior instead of guessing.
```

## 6. Feature Status Lifecycle

> Canonical reference: [`docs/sdlc/pipeline.md` — Feature Status Lifecycle](../sdlc/pipeline.md#feature-status-lifecycle). The definitions below are kept in sync with that reference.

Every feature has a status that reflects its maturity. Status transitions are gated by specific criteria tied to the SDLC pipeline.

### Status Definitions

| Status      | Meaning                                                                                                       | Who Can Use It                                                                  | Breaking Changes Allowed?                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **PLANNED** | Specified but not yet implemented. Feature spec exists, code does not.                                        | Internal planning only — not available to users                                 | N/A                                                            |
| **ALPHA**   | First implementation complete. Core happy path works. Gaps, rough edges, and missing tests are expected.      | Internal team and trusted testers only — expect breakage                        | Yes — APIs, data model, and behavior may change without notice |
| **BETA**    | Feature is functional and tested. E2E and integration tests pass. Known gaps are documented but non-blocking. | Available to early adopters — feedback expected, breakage unlikely but possible | Limited — documented in release notes, migration path provided |
| **STABLE**  | Production-ready. Full test coverage, docs synced, no open CRITICAL/HIGH gaps.                                | All users — relied upon for production workloads                                | No — backwards-compatible only, deprecation before removal     |

### Transition Criteria

#### PLANNED → ALPHA

Gated by: **`/implement` completion (Phase 5 of SDLC)**

- [ ] LLD implementation phases complete (code committed)
- [ ] Core happy-path functional (manual or automated verification)
- [ ] `pnpm build` passes for affected packages
- [ ] At least 1 E2E test or manual walkthrough demonstrates the feature works
- [ ] Feature spec updated with implementation file paths (`/post-impl-sync` or manual)
- [ ] Known gaps documented in feature spec §16

#### ALPHA → BETA

Gated by: **Test coverage + review pass**

- [ ] E2E tests passing — minimum 3 scenarios from test spec
- [ ] Integration tests passing — minimum 3 scenarios from test spec
- [ ] Unit tests cover core logic paths
- [ ] All CRITICAL gaps from feature spec §16 resolved
- [ ] HIGH gaps either resolved or have documented workarounds
- [ ] PR review completed (5 rounds of pr-reviewer or equivalent human review)
- [ ] Feature spec, test spec, and testing README updated to reflect actual state
- [ ] No regressions in existing test suites (`pnpm test` for affected packages)

#### BETA → STABLE

Gated by: **Full coverage + production validation**

- [ ] All E2E scenarios from test spec passing (minimum 5)
- [ ] All integration scenarios from test spec passing (minimum 5)
- [ ] Security & isolation tests passing (cross-tenant 404, cross-project 404, auth 401, permissions 403)
- [ ] No open CRITICAL or HIGH gaps in feature spec §16
- [ ] MEDIUM gaps either resolved or accepted with documented rationale
- [ ] Performance validated against success metrics (feature spec §14)
- [ ] Accessibility requirements met (if applicable)
- [ ] Feature spec, test spec, HLD, and LLD all marked as current
- [ ] Testing guide coverage matrix shows ✅ for all mandatory scenarios
- [ ] At least 1 week of production use (or staging equivalent) without regression

### Status and SDLC Phase Mapping

| SDLC Phase Completed              | Feature Status After |
| --------------------------------- | -------------------- |
| Feature Spec                      | PLANNED              |
| Test Spec                         | PLANNED              |
| HLD                               | PLANNED              |
| LLD                               | PLANNED              |
| Implementation                    | ALPHA                |
| Post-Impl Sync + E2E pass         | BETA                 |
| Full validation + production soak | STABLE               |

### Testing Guide Status Mapping

The testing guide status in `docs/testing/README.md` should track the feature status:

| Feature Status | Testing Guide Status | Meaning                                     |
| -------------- | -------------------- | ------------------------------------------- |
| PLANNED        | PLANNED              | No tests exist yet                          |
| ALPHA          | IN PROGRESS          | Some tests written, gaps expected           |
| BETA           | PARTIAL              | E2E + integration passing, some gaps remain |
| STABLE         | STABLE               | Full coverage matrix green                  |

### When to Update Status

Status updates happen at two points:

1. **During `/post-impl-sync`**: The skill checks transition criteria and updates the feature spec and testing guide status accordingly.
2. **During manual review**: When a human reviewer or auditor verifies that transition criteria are met.

Never update status without verifying the transition criteria. A feature at ALPHA with all tests passing should be promoted to BETA. A feature at BETA with no open gaps and production validation should be promoted to STABLE.

A single deterministic public-API regression test is enough to stop saying "zero E2E", but it does **not** by itself satisfy the BETA threshold. Keep the testing guide `PARTIAL` until the broader scenario matrix is covered.

## 7. Review Checklist

- Is the scope explicit?
- Are goals and non-goals separated clearly?
- Are requirements testable?
- Does the doc state whether the feature primarily affects projects, agents, customers, observability, governance, or enterprise concerns?
- Does the doc explain project / tenant / user isolation where applicable?
- If the doc has API or route tables, does it distinguish implemented behavior from production-wired/reachable behavior?
- If the feature imports or reuses assets, does the doc say exactly which asset types appear where, whether they are editable or read-only, how design-time names map to runtime names, and what remains unsupported or local-only?
- Is there a matching testing guide?
- Are discovery indexes updated?
