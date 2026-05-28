---
name: design-quality-gate
description: Use when writing a design doc, RFC, research document, or implementation plan. Also use when transitioning between research, design, and planning phases. Ensures consistent quality and completeness across all design artifacts.
---

# Design Quality Gate

## Overview

Standardized quality gates for each transition in the research -> design -> plan pipeline. Ensures every design doc covers the 12 architectural concerns that matter in this codebase, and every plan has measurable exit criteria.

## When to Use

- Starting a research phase for a new feature
- Writing or reviewing a design document
- Transitioning from design to implementation plan
- Reviewing an existing design for completeness

## Automated Validation

Run `tools/design-lint.sh <path>` to check completeness:

```bash
tools/design-lint.sh docs/plans/2026-03-07-feature-design.md
tools/design-lint.sh docs/plans/2026-03-07-feature-plan.md
```

## Gate 1: Research -> Design

Before writing a design doc, research must include:

- [ ] **Problem statement** — what exactly are we solving and why now
- [ ] **Alternatives analysis** — at least 2-3 approaches evaluated
- [ ] **Trade-offs matrix** — pros/cons/risks for each approach
- [ ] **Decision rationale** — why the chosen approach wins
- [ ] **Prior art** — what exists in the codebase already (use `platform-toolkit` skill)
- [ ] **Scope boundary** — what is explicitly NOT included

### Research Anti-Patterns

| Anti-Pattern                                   | Fix                                               |
| ---------------------------------------------- | ------------------------------------------------- |
| Single approach presented as "the design"      | Always evaluate 2-3 alternatives first            |
| Research without problem statement             | Start with "what problem does this solve?"        |
| Copy-paste from external docs without analysis | Synthesize findings into trade-offs               |
| Scope creep in research phase                  | Define explicit scope boundary before researching |

## Gate 2: Design -> Plan (The 12 Concerns)

Every design document must address these 12 architectural concerns. Mark N/A with justification if not applicable.

### Structural Concerns

| #   | Concern                 | Question to Answer                                       |
| --- | ----------------------- | -------------------------------------------------------- |
| 1   | **Tenant isolation**    | How is data scoped per tenant? Query-level `tenantId`?   |
| 2   | **Data access pattern** | Repository layer? Direct model access? Caching strategy? |
| 3   | **API contract**        | Request/response shapes? Error envelope? Versioning?     |
| 4   | **Security surface**    | Auth requirements? Input validation? SSRF? Encryption?   |

### Behavioral Concerns

| #   | Concern           | Question to Answer                                            |
| --- | ----------------- | ------------------------------------------------------------- |
| 5   | **Error model**   | What fails? How? What does the user see? Recovery path?       |
| 6   | **Failure modes** | Network partition? Timeout? Partial failure? Circuit breaker? |
| 7   | **Idempotency**   | Can operations be safely retried? Dedup strategy?             |
| 8   | **Observability** | What traces/logs? How to debug in production?                 |

### Operational Concerns

| #   | Concern                | Question to Answer                                        |
| --- | ---------------------- | --------------------------------------------------------- |
| 9   | **Performance budget** | Latency targets? Payload sizes? Batch limits?             |
| 10  | **Migration path**     | How to get from current state? Strangler? Feature flag?   |
| 11  | **Rollback plan**      | What if this fails in production? How to revert?          |
| 12  | **Test strategy**      | Unit vs integration split? Parity tests? Coverage target? |

### Design Doc Template

```markdown
# [Feature] Design

## Problem Statement

[What are we solving and why now]

## Alternatives Considered

### Option A: [name]

[Description, pros, cons]

### Option B: [name]

[Description, pros, cons]

### Recommendation: [chosen option]

[Why this wins]

## Architecture

[Diagrams, data flow, component interaction]

## 12 Concerns

[Address each or mark N/A with justification]

## Open Questions

[Unresolved decisions that need input]
```

## Gate 3: Plan -> Implementation

Every implementation plan must include:

- [ ] **Phased breakdown** — ordered phases with dependencies
- [ ] **Exit criteria per phase** — measurable conditions (not "it works")
- [ ] **Task granularity** — each task completable in one session
- [ ] **Test strategy per phase** — what tests validate each phase
- [ ] **Shadow/parity strategy** (for refactors) — how to verify behavioral equivalence
- [ ] **Rollback strategy** — feature flags or revert path per phase

### Plan Anti-Patterns

| Anti-Pattern                | Fix                                           |
| --------------------------- | --------------------------------------------- |
| "Phase 1: Build everything" | Break into tasks completable in one session   |
| Exit criteria: "tests pass" | Specific: "99.5% parity on shadow traffic"    |
| No test strategy            | Each phase must state what tests are added    |
| Big-bang cutover            | Strangler pattern + shadow mode for refactors |

## Key Files

| File                                                      | Purpose                                        |
| --------------------------------------------------------- | ---------------------------------------------- |
| `docs/plans/`                                             | All existing design docs and plans (186 files) |
| `docs/plans/2026-03-01-guardrails-system-design.md`       | Example of comprehensive design                |
| `docs/plans/2026-03-01-guardrails-implementation-plan.md` | Example of phased plan with exit criteria      |
| `tools/design-lint.sh`                                    | Automated design doc completeness checker      |
