# HELIX V2 Quality Checklist

This checklist captures the minimum bar HELIX must satisfy before a replay or live implementation can be called successful. It is derived from the current HELIX replay gaps, the SDLC pipeline requirements in `/Users/prasannaarikala/projects/agent-platform/docs/sdlc/pipeline.md`, and the implementation acceptance requirements in `/Users/prasannaarikala/projects/agent-platform/.agents/skills/implement/SKILL.md`.

## 1. Work Item Inputs

- [ ] Feature spec is loaded when available.
- [ ] Test spec is loaded when available.
- [ ] HLD is loaded when available.
- [ ] LLD / implementation plan is loaded when available.
- [ ] Worktree launches sync every referenced work-item document into the detached execution context.

## 2. Discovery and Planning

- [ ] Deep scan surfaces direct code seams, dependent seams, persistence seams, and historical replay seams.
- [ ] Oracle findings are classified by horizon (`immediate`, `next`, `near-term`, `long-term`).
- [ ] Immediate and next findings become blocking implementation obligations.
- [ ] Plans remain seam-aware and future-proof.
- [ ] Replay-specific historical seam files stay blocking until implemented or explicitly justified.

## 3. Invariant and Negative-Test Coverage

- [ ] Every changed invariant has at least one positive-path proof.
- [ ] Every changed invariant has at least one negative-path proof.
- [ ] Cross-tenant, cross-project, and cross-user isolation checks are covered when relevant.
- [ ] Persistence-layer invariants are covered when routes/services touch models, schemas, or repositories.
- [ ] Missing target seams from replay comparison remain blocking, even when local tests are green.

## 4. Wiring and Consumer Verification

- [ ] New or changed exports are verified against known consumers.
- [ ] Middleware and route ordering constraints are verified.
- [ ] Same-package consumer surfaces are reviewed for wiring correctness.
- [ ] Compatibility or legacy routes are verified when the feature changes canonical routes.

## 5. Security and Isolation Verification

- [ ] Auth enforcement is explicitly checked.
- [ ] Tenant, project, and user isolation are explicitly checked.
- [ ] Missing isolation checks stay blocking until proven safe.
- [ ] Security-sensitive changes receive a dedicated review, not just a generic implementation review.

## 6. Acceptance Verification

- [ ] Integration and E2E coverage exist for the user-visible behavior.
- [ ] Acceptance verification confirms the implementation matches the work-item feature semantics, not only local tests.
- [ ] Replay success is blocked if required semantic seams are still missing, even if extra tests were added.

## 7. Production Readiness

- [ ] Regression suite runs on affected packages.
- [ ] Production-readiness review confirms no obvious rollout blockers remain.
- [ ] Non-blocking documentation or Jira/bookkeeping failures do not invalidate already-green proof.

## 8. Replay Adjudication

- [ ] Replay compares against the historical target seam, not just the current dirty diff.
- [ ] Every declared replay target file is present in the final replay diff or explicitly justified.
- [ ] Extra tests are allowed only after semantic completeness is achieved.
- [ ] A replay is successful only when correctness, completeness, and coverage are at least as strong as the original outcome.
