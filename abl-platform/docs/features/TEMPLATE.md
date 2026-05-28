# Feature: <Feature Name>

**Doc Type**: MAJOR FEATURE | SUB-FEATURE | HUB
**Parent Feature**: <Required for sub-features; otherwise N/A>
**Status**: STABLE | BETA | ALPHA | PLANNED
**Feature Area(s)**: `project lifecycle`, `agent lifecycle`, `customer experience`, `observability`, `governance`, `enterprise`, `admin operations`, `integrations`
**Package(s)**: `<primary packages>`
**Owner(s)**: `<team / package owners>`
**Testing Guide**: <Use `../testing/<feature>.md` for top-level docs or `../../testing/sub-features/<feature>.md` for sub-feature docs>
**Last Updated**: <date>

---

## 1. Introduction / Overview

### Problem Statement

<What problem does this feature solve? Who experiences the problem today? What breaks or becomes inefficient without this feature?>

### Goal Statement

<What is the intended outcome of the feature? State the product or platform goal in one clear paragraph.>

### Summary

<Briefly describe what the feature does, how users or operators interact with it, and why it matters.>

---

## 2. Scope

### Goals

- Goal 1
- Goal 2
- Goal 3

### Non-Goals (Out of Scope)

- Non-goal 1
- Non-goal 2
- Non-goal 3

---

## 3. User Stories

1. As a `<persona>`, I want `<capability>` so that `<benefit>`.
2. As a `<persona>`, I want `<capability>` so that `<benefit>`.
3. As a `<persona>`, I want `<capability>` so that `<benefit>`.

---

## 4. Functional Requirements

1. **FR-1**: The system must...
2. **FR-2**: The system must...
3. **FR-3**: The system must...
4. **FR-4**: The system must...

> Prefer numbered, testable statements. Use "The system must..." language and avoid mixing requirements with implementation details.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level               | Notes |
| -------------------------- | -------------------------- | ----- |
| Project lifecycle          | PRIMARY / SECONDARY / NONE |       |
| Agent lifecycle            | PRIMARY / SECONDARY / NONE |       |
| Customer experience        | PRIMARY / SECONDARY / NONE |       |
| Integrations / channels    | PRIMARY / SECONDARY / NONE |       |
| Observability / tracing    | PRIMARY / SECONDARY / NONE |       |
| Governance / controls      | PRIMARY / SECONDARY / NONE |       |
| Enterprise / compliance    | PRIMARY / SECONDARY / NONE |       |
| Admin / operator workflows | PRIMARY / SECONDARY / NONE |       |

### Related Feature Integration Matrix

| Related Feature | Relationship Type                                                                  | Why It Matters | Key Touchpoints | Current State |
| --------------- | ---------------------------------------------------------------------------------- | -------------- | --------------- | ------------- |
|                 | depends on / extends / shares data with / emits into / configured by / tested with |                |                 |               |

> Use this matrix to show how the feature interacts with the rest of the platform. Prefer linking to the corresponding feature docs.

---

## 6. Design Considerations (Optional)

<Link mockups, UX flows, component references, content requirements, accessibility expectations, or style-system considerations if this feature has a meaningful UI or operator experience.>

---

## 7. Technical Considerations (Optional)

<Document constraints, dependencies, rollout sequencing, architectural decisions, migration notes, or implementation recommendations. Example: "Should integrate with the existing Auth module and reuse unified auth middleware.">

---

## 8. How to Consume

### Studio UI

<How users interact with this feature in Studio. Include routes, screens, workflow entry points, and role expectations. Distinguish standard inventory/list pages from contextual authoring surfaces when the feature only appears in some places.>

### Surface Semantics Matrix

<Required whenever the feature imports, reuses, references, mounts, or otherwise exposes assets across boundaries (tenant/project/module/template/shared library/etc.). Document the consumer-visible contract, not just the implementation intent. Use N/A with justification if the feature has no design-time/runtime split.>

| Asset / Entity Type | Source of Truth / Ownership | Design-Time Surface(s) | Editable or Read-Only? | Consumer Reference / Binding Model | Runtime Materialization / Resolution | Notes / Unsupported State |
| ------------------- | --------------------------- | ---------------------- | ---------------------- | ---------------------------------- | ------------------------------------ | ------------------------- |
|                     |                             |                        |                        |                                    |                                      |                           |

### Design-Time vs Runtime Behavior

<Spell out what exists only in the control plane / design-time UX, what is materialized at deploy/runtime, and what remains local-only. If aliases, selectors, pointers, snapshots, mounted names, or compiled/runtime identifiers differ from the author-facing names, document both forms explicitly.>

### API (Runtime)

<REST / WebSocket endpoints exposed by Runtime.>

| Method | Path | Purpose |
| ------ | ---- | ------- |
|        |      |         |

### API (Studio)

<Studio-side API routes or server actions, if applicable.>

| Method | Path | Purpose |
| ------ | ---- | ------- |
|        |      |         |

### Admin Portal

<Admin-facing pages or endpoints for tenant-wide or platform-wide management.>

### Channel / SDK / Voice / A2A / MCP Integration

<How this feature behaves across channels and integration surfaces. Explicitly note when the feature is not channel-aware.>

---

## 9. Data Model

### Collections / Tables

<MongoDB collections, SQL tables, config documents, or derived indexes involved in the feature.>

```text
Collection: <name>
Fields:
  - _id: string
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed if project-scoped)
  - createdBy: string (required if user-owned)
  - ...
Indexes:
  - { tenantId: 1, projectId: 1 }
  - ...
```

### Key Relationships

<How the feature relates to other records, documents, queues, traces, or external systems.>

---

## 10. Key Implementation Files

### Domain / Core Logic

| File | Purpose |
| ---- | ------- |
|      |         |

### Routes / Handlers

| File | Purpose |
| ---- | ------- |
|      |         |

### UI Components

| File | Purpose |
| ---- | ------- |
|      |         |

### Jobs / Workers / Background Processes

| File | Purpose |
| ---- | ------- |
|      |         |

### Tests

| File | Type                     | Coverage Focus |
| ---- | ------------------------ | -------------- |
|      | unit / integration / e2e |                |

---

## 11. Configuration

### Environment Variables

| Variable | Default | Description |
| -------- | ------- | ----------- |
|          |         |             |

### Runtime Configuration

<Feature flags, tenant-level settings, per-project settings, rollout switches, or operational toggles.>

### DSL / Agent IR / Schema

<If the feature is configurable in the DSL, compiler IR, OpenAPI schema, or form schema, show the relevant shape.>

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| Project isolation | Every project-scoped read/write must include `projectId` and cross-project access must return 404.      |
| Tenant isolation  | Every tenant-scoped read/write must include `tenantId` and cross-tenant access must return 404.         |
| User isolation    | User-owned resources must be filtered by `createdBy` / `ownerId` and cross-user access must return 404. |

### Security & Compliance

<Authn/authz expectations, encryption, secret handling, audit logging, compliance concerns, PII minimization, retention or erasure needs.>

### Performance & Scalability

<Latency expectations, throughput constraints, cache behavior, queueing, batching, indexing, or horizontal scale notes.>

### Reliability & Failure Modes

<Retry behavior, idempotency, degraded modes, operational blast radius, recovery expectations.>

### Observability

<Trace events, metrics, logs, dashboards, alerts, and debugging entry points.>

### Data Lifecycle

<Retention, TTLs, archival, deletion cascades, or migration concerns.>

---

## 13. Delivery Plan / Work Breakdown

Use parent tasks with numbered subtasks so execution can be tracked clearly.

1. Parent task
   1.1 Subtask
   1.2 Subtask
2. Parent task
   2.1 Subtask
   2.2 Subtask

---

## 14. Success Metrics

| Metric | Baseline | Target | How Measured |
| ------ | -------- | ------ | ------------ |
|        |          |        |              |

<Examples: reduce support tickets, improve task completion rate, increase agent adoption, lower latency, reduce configuration errors.>

---

## 15. Open Questions

1. Open question 1
2. Open question 2
3. Open question 3

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description | Severity            | Status                         |
| ------- | ----------- | ------------------- | ------------------------------ |
| GAP-001 |             | High / Medium / Low | Open / In Progress / Mitigated |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario | Coverage Type                     | Status                   | Test File / Note |
| --- | -------- | --------------------------------- | ------------------------ | ---------------- |
| 1   |          | unit / integration / e2e / manual | PASS / FAIL / NOT TESTED |                  |

### Testing Notes

<Summarize what is already covered, what is missing, and where live validation or manual verification is still needed.>

> Full testing details: <Use the relative path that matches the doc location: `../testing/<feature>.md` for top-level docs or `../../testing/sub-features/<feature>.md` for sub-feature docs.>

---

## 18. References

- Design docs: `docs/specs/...`, `docs/plans/...`
- Reference docs: `docs/feature-matrix.md`, `docs/enterprise-readiness.md`
- Related feature docs: [link to related feature docs]
