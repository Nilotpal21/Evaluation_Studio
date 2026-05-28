# RFC-025: Expert — Business Specification Agent

**Status**: Draft
**Date**: 2026-03-16

---

## The Gap

Arch helps developers build. Nobody helps the business team **specify what to build**, and Arch has **no ground-truth requirements from the business** to build against. This is not one gap — it's three:

- **No business authoring tool.** The business team has no AI-assisted surface to capture and structure their requirements.
- **No persistent spec for Arch.** Arch operates without a source of truth for what the business actually asked for — it works from code context alone.
- **No accountability loop.** Neither the business team nor Arch can verify whether the implementation matches the original intent.

Today's flow:

```
Business person → tells developer what they want (meetings, tickets, docs)
Developer → opens Studio → fills in ProjectBrief form (domain, problem, use cases, tone, channels)
Arch → generates topology + ABL from that brief
Developer → edits/evolves agents with Arch
```

**Three problems:**

1. **The brief is developer-authored.** Business intent gets translated (and lossy-compressed) through a developer before it reaches Arch. The `ProjectBrief` type has 10 fields. Real business requirements have constraints, compliance needs, SLAs, edge cases, approval chains, and success criteria that don't fit.

2. **The brief is fire-and-forget.** `arch-context-builder.ts` doesn't reference `ProjectBrief` at all. Once generation completes, Arch works from compiled IR + conversation history only. The original business intent is gone from context — developers can drift without anyone noticing.

3. **No business feedback loop.** After the initial brief, the business team has no surface to review what Arch built against what they asked for. They can't verify, update requirements, or flag drift.

---

## Proposal: Expert

A business-facing AI agent that owns the **specification lifecycle** — upstream of Arch, persistent through implementation, and reviewable by non-technical stakeholders.

### What Expert Does

| Phase        | Expert's Role                                                                                                                                                                                                                                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Discover** | Interviews the business user: goals, user personas, channels, compliance, SLAs, edge cases, success metrics. Produces a structured specification.                                                                                                                                                                                                                              |
| **Specify**  | Turns the interview into a versioned, structured spec document — not a form, not a brief, a living document with sections the business team can review and approve.                                                                                                                                                                                                            |
| **Hand off** | The approved spec becomes Arch's primary input. Arch reads it as context during every stage — not just generation.                                                                                                                                                                                                                                                             |
| **Monitor**  | Arch relies on Expert's spec as the business ground truth. Spec-compliance reviews run on demand and via configurable hooks — version creation, deployment to non-dev environments, or other team-defined triggers. Inconsistencies are flagged before they hit production: "This change removes the escalation path, which the spec requires to route to a human supervisor." |
| **Evolve**   | When production data or new requirements surface, Expert helps the business team update the spec, and Arch re-plans from the updated version.                                                                                                                                                                                                                                  |

### The Spec as Contract

The spec is the connective tissue between business and engineering:

```
Business team ←→ Expert ←→ Spec (versioned, structured) ←→ Arch ←→ Implementation
```

- **Business reads**: plain-language requirements, success criteria, approved flows
- **Arch reads**: structured constraints, channel requirements, compliance rules, SLAs, edge-case definitions
- **Compliance checks**: Spec-compliance reviews run on demand and at configurable hooks (version creation, non-dev deployments) — not on every edit

### What the Spec Contains (not a ProjectBrief)

```
- Business objective & success metrics
- User personas with context (not just "target users")
- Channel requirements with business rules per channel
- Compliance & policy constraints (with severity: must/should/nice-to-have)
- Escalation & approval chains
- SLA targets (response time, resolution time, handoff limits)
- Edge cases & failure modes (what happens when X?)
- Integration requirements (systems of record, auth, data flows)
- Acceptance criteria per use case
- Version history with change rationale
```

### How It Changes the Arch Workflow

**Today**: Arch's `buildSystemPrompt()` injects `currentAbl`, `topology`, and `editContext`. No spec.

**With Expert**: Arch's context builder also loads the current approved spec. Spec-compliance reviews run on demand and at configurable hooks — version creation, deployment to non-dev environments, or other team-defined triggers. If a developer removes an escalation path that the spec requires, it gets flagged before it reaches production.

This isn't about blocking developers — it's about making business intent visible and traceable through implementation.

### Surfaces

| Surface                   | Who           | What                                                               |
| ------------------------- | ------------- | ------------------------------------------------------------------ |
| **Studio (Expert panel)** | Business team | Interview, review spec, approve changes, see implementation status |
| **Studio (Arch panel)**   | Developer     | Sees spec constraints in context, gets drift warnings              |
| **Notifications**         | Business team | "Arch proposed a change that affects your escalation requirements" |
| **Spec diff view**        | Both          | Side-by-side: what the spec says vs what's implemented             |

---

## What This Enables

- Business team has a **seat at the table** without needing to read ABL
- Arch has **persistent business context** instead of a fire-and-forget brief
- Developers can't silently drift from requirements — drift is flagged, not blocked
- Spec versioning creates an **audit trail** from business intent to implementation
- The same spec can drive **test generation** (acceptance criteria → test scenarios)

---

## Design Decisions

1. **Spec format**: Markdown, multi-document. An index document links to one document per business requirement area — different use cases can have different owners. Standard global behavior (error handling, fallback, welcome experience, etc.) gets its own files. The UI stitches these into a single readable view, but on disk they're individual markdown files that commit to git and render properly in any git host.

2. **Approval model**: Approvals are not required for Arch to proceed — early in a project things are fluid. However, if the project enables review hooks, then an approved spec version and its associated design version are linked to the hook. Passing that hook is required to promote to non-dev environments. Unapproved specs are not visible to Arch — only approved versions enter Arch's context.

3. **Drift detection granularity**: Semantic comparison via LLM. Field-level matching is too brittle for natural-language requirements — the LLM can reason about whether an implementation change violates the intent of a spec section, not just whether a keyword is missing.

4. **Scope**: Project-scoped only. One spec per project.

5. **Context separation**: Expert and Arch maintain their own LLM contexts. The spec is the only interface between them. This is deliberate — the business team may be working on a future version of the spec while the developer is still building the current one. Coupling their contexts would force them onto the same iteration.
