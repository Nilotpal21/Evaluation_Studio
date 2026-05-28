# Feature: Experiments / A/B Testing

**Status**: PLANNED
**Feature Area(s)**: `runtime`, `pipeline-engine`, `studio`, `analytics`
**Package(s)**: `apps/runtime`, `packages/pipeline-engine`, `apps/studio`, `packages/database`
**Owner(s)**: Platform team
**Testing Guide**: [docs/testing/experiments.md](../testing/experiments.md)
**Last Updated**: 2026-03-23

---

## 1. Introduction / Overview

### Problem Statement

The ABL platform supports agent versioning (via `AgentVersion` model) and deployments (via `Deployment` model with `agentVersionManifest`), but there is no way to run two agent versions simultaneously against live traffic and measure which performs better. Teams must deploy a new version to 100% of traffic and manually compare metrics before/after — a high-risk process that provides no statistical confidence in the comparison.

The `packages/pipeline-engine` already contains an `ExperimentModel` schema and an `ExperimentResultsService` with t-test, chi-squared, and power analysis — but these are unused scaffolding with no runtime integration, no traffic routing, no assignment persistence, and no Studio UI.

### Goal Statement

Provide a complete A/B testing framework that allows platform users to define experiments comparing agent versions, route live traffic between control and experiment groups with sticky session assignment, collect per-group metrics via ClickHouse, compute statistical significance automatically, and manage experiments through a Studio UI — all while maintaining tenant/project isolation and safety guardrails (auto-rollback on guardrail metric breach).

### Summary

Experiments let teams compare two agent configurations (control vs. experiment) on live traffic with configurable traffic splits. The runtime assigns each new session to a group deterministically (hash-based, sticky for the session lifetime). Metrics flow through the existing analytics pipeline into ClickHouse, partitioned by experiment group. The pipeline-engine computes significance periodically. Studio provides a management UI for creating, monitoring, and concluding experiments. Safety guardrails auto-stop experiments if key metrics degrade beyond thresholds.

---

## 2. Scope

### Goals

- **G-1**: Define experiments that compare a control deployment/version against an experiment deployment/version within a project
- **G-2**: Route live traffic between control and experiment groups based on configurable traffic split (0.0-1.0)
- **G-3**: Persist session-to-group assignment so a session always sees the same agent version throughout its lifetime (sticky assignment)
- **G-4**: Collect per-group metrics in ClickHouse (session outcomes, eval scores, latency, token usage, custom success metrics)
- **G-5**: Compute statistical significance (t-test, chi-squared) with confidence intervals and minimum sample size detection
- **G-6**: Provide safety guardrails: auto-stop experiment if guardrail metrics (error rate, latency P99, eval score degradation) breach configurable thresholds
- **G-7**: Studio UI for experiment lifecycle management (create, start, monitor, stop, conclude)
- **G-8**: Studio UI for experiment results visualization (group comparison, significance indicators, metric trends)

### Non-Goals (Out of Scope)

- **Multi-variant testing** (3+ groups) — only two-group A/B in this phase
- **Feature flags** — experiments compare full agent versions, not individual feature toggles
- **Bayesian significance** — frequentist methods only (t-test, chi-squared) in this phase
- **Cross-project experiments** — experiments are scoped to a single project
- **Automatic winner promotion** — concluding an experiment and promoting the winner to full traffic is a manual action
- **Custom metric definition UI** — success/guardrail metrics reference pre-defined metric names from the analytics pipeline
- **Multi-armed bandit** — fixed traffic split only, no adaptive allocation
- **Experiment scheduling** — experiments start/stop manually, no time-based scheduling

---

## 3. User Stories

1. As a **project admin**, I want to create an experiment that compares two agent versions so that I can measure which version performs better on live traffic.
2. As a **project admin**, I want to set a traffic split (e.g., 80/20 control/experiment) so that I can limit exposure to the experimental version.
3. As a **project admin**, I want sessions to be sticky to their assigned group so that users have a consistent experience within a session.
4. As a **project admin**, I want to define success metrics (e.g., containment rate, avg eval score) so that I can measure what "better" means for my use case.
5. As a **project admin**, I want to define guardrail metrics with thresholds (e.g., error rate < 5%) so that the experiment auto-stops if the new version causes harm.
6. As a **project admin**, I want to see real-time experiment results with statistical significance indicators so that I know when I have enough data to make a decision.
7. As a **project admin**, I want to stop an experiment early if results are clear or if issues arise so that I can limit risk.
8. As a **project admin**, I want to view the experiment history for a project so that I can track what was tested and the outcomes.
9. As a **platform operator**, I want experiments to be tenant/project-isolated so that one tenant's experiments cannot affect another's traffic.
10. As a **platform operator**, I want only one active experiment per project at a time so that traffic assignment is unambiguous.

---

## 4. Functional Requirements

### 4.1 Experiment Lifecycle

1. **FR-1**: The system must allow creating an experiment in `draft` status with: name, description, control version ID, experiment version ID, traffic split (0.01-0.99), success metric names, guardrail metric names with thresholds.
2. **FR-2**: The system must enforce that only one experiment per project can be in `running` status at a time.
3. **FR-3**: The system must support experiment status transitions: `draft` -> `running` -> `stopped` | `completed`.
4. **FR-4**: Starting an experiment must validate that both agent versions exist and belong to the same project.
5. **FR-5**: Stopping an experiment must immediately cease traffic splitting (all traffic to control) and record the stop time.

### 4.2 Traffic Routing

6. **FR-6**: When a new session is created and an experiment is running for that project, the runtime must assign the session to `control` or `experiment` group based on the traffic split percentage.
7. **FR-7**: Group assignment must be deterministic and sticky: once a session is assigned, it must always be routed to the same agent version for its lifetime.
8. **FR-8**: Assignment must be stored on the session document (e.g., `experimentId`, `experimentGroup` fields) for auditability.
9. **FR-9**: The assignment algorithm must be a deterministic hash of `(experimentId, sessionId)` compared against the traffic split, ensuring consistent distribution without external state lookups on each request.

### 4.3 Metrics Collection

10. **FR-10**: Session events (creation, completion, disposition, error) must include the experiment group label in ClickHouse records when the session is part of an experiment.
11. **FR-11**: Eval production scores must include the experiment group label when the session is part of an experiment.
12. **FR-12**: The system must store per-experiment assignment counts in a ClickHouse table for sample size tracking.

### 4.4 Results Computation

13. **FR-13**: The system must compute statistical significance for each success metric using the `ExperimentResultsService` (t-test for continuous, chi-squared for proportions).
14. **FR-14**: Results must include: per-group sample size, per-metric means, p-values, confidence intervals, lift percentage, and whether the minimum sample size has been reached.
15. **FR-15**: Results must be recomputed periodically (configurable interval, default 1 hour) and on-demand via API.

### 4.5 Safety Guardrails

16. **FR-16**: For each guardrail metric, the system must compare the experiment group's metric against the control group or against an absolute threshold.
17. **FR-17**: If any guardrail metric breaches its threshold, the system must auto-stop the experiment and record the reason.
18. **FR-18**: Guardrail checks must run on the same schedule as results computation.

### 4.6 Studio UI

19. **FR-19**: Studio must provide a project-level "Experiments" page accessible via sidebar navigation under the **EVALUATE** section.
20. **FR-20**: The experiments page must list all experiments for the project with status, date range, and quick results summary.
21. **FR-21**: The experiment detail page must show: configuration, real-time results with significance indicators, group metrics comparison chart, guardrail status, and action buttons (start/stop/conclude).
22. **FR-22**: The experiment creation form must allow selecting agent versions from a dropdown, setting traffic split via slider, optional channel scoping, and adding success/guardrail metrics.
23. **FR-23-NEW**: The system must exclude studio debug sessions (`source.type = 'studio'`) from experiment assignment.
24. **FR-24-NEW**: The system must support channel-scoped experiments: when `channels` is non-empty, only sessions on listed channels receive experiment assignment.
25. **FR-25-NEW**: A2A child sessions (sessions with `parentId` set) must inherit the parent session's experiment group rather than receive independent assignment.
26. **FR-26-NEW**: End-user identity stickiness: when a session has a `contactId`, assignment must be keyed on `contactId` so the same end-user always maps to the same group across sessions.
27. **FR-27-NEW**: Guardrail rules must support `comparison: 'relative_to_control'` mode, where the threshold is evaluated against the relative degradation from the control group.
28. **FR-28-NEW**: Guardrail auto-stop must write an audit log entry via the platform audit logging system.
29. **FR-29-NEW**: When a session undergoes right-to-erasure, the corresponding `experiment_assignments` row in ClickHouse must be deleted.

### 4.7 API Design

23. **FR-23**: All experiment APIs must be under `/api/projects/:projectId/experiments` and enforce tenant + project isolation.
24. **FR-24**: The API must support: `POST` (create), `GET` (list), `GET /:id` (detail with results), `PUT /:id` (update draft), `POST /:id/start`, `POST /:id/stop`, `POST /:id/results` (on-demand recompute).

---

## 5. Non-Functional Requirements

1. **NFR-1**: Traffic routing decision must add < 5ms latency to session creation (hash computation only, no DB lookup).
2. **NFR-2**: Results computation for 10K sessions must complete within 30 seconds.
3. **NFR-3**: Experiment data must respect tenant isolation — no cross-tenant data leakage in ClickHouse queries.
4. **NFR-4**: Guardrail auto-stop must trigger within 2x the results computation interval (default: within 2 hours).
5. **NFR-5**: Session assignment must produce a uniform distribution within +/- 2% of the configured traffic split for sample sizes > 1000.
6. **NFR-6**: Experiment metadata must be auditable — all state transitions logged with timestamp and actor.

---

## 6. Technical Context

### Existing Infrastructure

| Component                   | Status     | Notes                                                                                                                                                                |
| --------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ExperimentModel` (MongoDB) | Scaffolded | `packages/pipeline-engine/src/schemas/experiment.schema.ts` — has basic fields but missing: guardrail thresholds, assignment counts, auto-stop reason                |
| `ExperimentResultsService`  | Scaffolded | `packages/pipeline-engine/src/pipeline/services/experiment-results.service.ts` — t-test, chi-squared, power analysis implemented but no ClickHouse query integration |
| `Deployment` model          | Production | `packages/database/src/models/deployment.model.ts` — tracks agent version manifests per environment                                                                  |
| `AgentVersion` model        | Production | `packages/database/src/models/agent-version.model.ts` — versioned DSL/IR snapshots                                                                                   |
| `Session` model             | Production | `packages/database/src/models/session.model.ts` — has `deploymentId` field but no experiment assignment fields                                                       |
| ClickHouse analytics tables | Production | `packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts` — sentiment, intent, quality tables exist but have no experiment_group column               |
| ClickHouse eval tables      | Production | `packages/pipeline-engine/src/pipeline/schemas/init-eval-tables.ts` — eval_production_scores exists but has no experiment_group column                               |

### Integration Points

1. **Runtime session creation** — Must check for active experiment and assign group
2. **Runtime agent version resolution** — Must resolve the correct version based on group assignment
3. **Pipeline-engine analytics events** — Must propagate experiment group to ClickHouse
4. **Pipeline-engine results computation** — Must query ClickHouse by experiment group and compute significance
5. **Studio API routes** — Must proxy experiment CRUD to runtime or expose directly
6. **Studio UI** — New experiments page in project scope

---

## 7. Risks & Mitigations

| Risk                                                                          | Impact | Probability | Mitigation                                                                                         |
| ----------------------------------------------------------------------------- | ------ | ----------- | -------------------------------------------------------------------------------------------------- |
| Traffic split imbalance at small sample sizes                                 | Medium | High        | Document minimum sample size requirements; show warning in UI when below threshold                 |
| Session stickiness failure (session routed to wrong version mid-conversation) | High   | Low         | Store assignment on session document; resolve version from session, not from experiment config     |
| Guardrail auto-stop race condition (multiple workers checking simultaneously) | Medium | Medium      | Use Redis distributed lock for auto-stop decision                                                  |
| ClickHouse query timeout on large experiment datasets                         | Medium | Low         | Partition by experiment_id; use materialized views for pre-aggregation                             |
| Experiment version deleted while experiment is running                        | High   | Low         | Validate version existence at start; block version deletion while referenced by running experiment |

---

## 8. Decision Log

| #   | Decision                                                   | Rationale                                                                                                       | Classification |
| --- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------- |
| D-1 | Hash-based assignment (not random)                         | Deterministic, reproducible, no external state needed. `hash(experimentId + sessionId) % 10000 < split * 10000` | DECIDED        |
| D-2 | One active experiment per project                          | Avoids ambiguous traffic assignment; multi-experiment requires complex multi-way splitting                      | DECIDED        |
| D-3 | Extend existing ExperimentModel rather than new collection | Scaffolding exists with correct tenant/project isolation                                                        | DECIDED        |
| D-4 | Store assignment on Session document                       | Ensures stickiness survives runtime restarts; no separate assignment table needed                               | DECIDED        |
| D-5 | Frequentist significance only (no Bayesian)                | Simpler to implement and explain; industry standard for A/B testing; Bayesian can be added later                | DECIDED        |
| D-6 | Compare deployment-pinned versions (not draft DSL)         | Experiments must use stable, compiled agent versions for reproducibility                                        | DECIDED        |
| D-7 | Guardrail auto-stop (not auto-rollback)                    | Auto-rollback is complex (draining, state migration); auto-stop + manual action is safer                        | DECIDED        |
| D-8 | Results computation via periodic cron (not streaming)      | Batch computation is simpler, more efficient for ClickHouse aggregation queries                                 | DECIDED        |

---

## 9. Open Questions

None — all questions resolved via decision log above.

---

## 10. Success Criteria

- [ ] Experiment can be created, started, and stopped via API
- [ ] Live traffic is split between control and experiment groups per configured ratio
- [ ] Sessions are sticky to their assigned group
- [ ] Per-group metrics are visible in ClickHouse
- [ ] Statistical significance is computed and displayed in Studio
- [ ] Guardrail breach auto-stops the experiment
- [ ] All APIs enforce tenant + project isolation
- [ ] E2E tests cover the full lifecycle
