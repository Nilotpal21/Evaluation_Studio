# SDLC Playbooks

Agent-agnostic software development lifecycle playbooks for the ABL platform. These guides describe the structured process for taking a feature from idea to production — usable by any AI agent (Claude Code, Codex, Cursor, etc.) or human developer.

## Pipeline Overview

Every non-trivial feature follows 6 phases in order. Each phase produces a specific artifact that the next phase consumes.

| Phase | Name           | Input                          | Output                                        | Min Reviews |
| ----- | -------------- | ------------------------------ | --------------------------------------------- | ----------- |
| 1     | Feature Spec   | Problem description            | `docs/features/<slug>.md`                     | 2           |
| 2     | Test Spec      | Feature spec                   | `docs/testing/<slug>.md`                      | 2           |
| 3     | HLD            | Feature spec + test spec       | `docs/specs/<slug>.hld.md`                    | 3           |
| 4     | LLD            | Feature spec + HLD + test spec | `docs/plans/<date>-<slug>-impl-plan.md`       | 5           |
| 5     | Implementation | LLD + all prior artifacts      | Source code + tests                           | 5           |
| 6     | Post-Impl Sync | All artifacts + git diff       | Updated docs reflecting actual implementation | 1           |

**Rule: Never skip a phase.** Each phase catches different classes of errors. Skipping the HLD and going straight to code is how architectural debt accumulates.

**Special lane for bugfixes:** before HLD/LLD expansion, bugfix and regression work must produce a characterization artifact at `docs/sdlc-logs/<slug>/characterization.md` with a reproduction artifact, target seam, and negative proof.

**Critical feature gate:** auth, isolation, compliance, privacy, retention, and encryption work must satisfy the critical-feature gate in the Feature Spec and Test Spec before HLD starts.

**Phase handoff rule:** every phase log must end with the standard Phase Handoff Packet so the next phase starts from a compact, explicit handoff rather than stale conversational context.

## Persona Boundaries & Swim Lanes

Every non-trivial feature must declare the persona swim lanes it crosses. Do not collapse all content, configuration, and UX into one generic "developer" lane. At minimum, reason about these three lanes:

| Persona            | Primary role                   | Canonical ownership / source of truth                                                                                     | Main surfaces                                                                           | Must not silently absorb                                                  |
| ------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| End user           | Consumes the product           | No authoring authority; consumes resolved output                                                                          | Runtime responses, widgets, notifications, exported artifacts, user-facing UI           | Raw infra details, internal diagnostics, platform-only configuration      |
| Agent developer    | Authors project behavior       | Project-scoped agents, prompts, flow copy, project localization assets, project settings intent, auth references          | Studio builder surfaces, project exports/imports, runtime materialized project behavior | Platform-owned system copy, shared runtime semantics, infra contracts     |
| Platform developer | Owns shared platform contracts | Runtime semantics, Studio/Admin shell behavior, platform UI/system/error/auth copy, shared catalogs, compatibility layers | Studio/Admin product surfaces, shared APIs, operational tooling                         | Project-owned agent content, per-project copy, project behavior decisions |

For any cross-lane feature, the spec, HLD, or review must answer:

- Which lane authors the asset or behavior?
- Which store, file, or schema is the canonical source of truth?
- Which surfaces materialize it at design time, runtime, import/export, and replay?
- Is another lane referencing the asset or copying it into a second authority?
- What precedence order applies when project-owned and platform-owned concerns meet?
- What fail-closed behavior prevents one lane from mutating or shadowing another by accident?

This applies to localization, prompts, settings, auth references, runtime messages, exports, and replay contracts. Example: project localization and platform localization can both render to the same end user, but they remain different catalogs with different owners, rollout paths, and review criteria.

## Phase Playbooks

| Playbook                                              | When to Use                                |
| ----------------------------------------------------- | ------------------------------------------ |
| [Pipeline Reference](pipeline.md)                     | Understand the full lifecycle and statuses |
| [Phase 1: Feature Spec](feature-spec-playbook.md)     | Defining what to build                     |
| [Phase 2: Test Spec](test-spec-playbook.md)           | Defining how to verify it                  |
| [Phase 3: HLD](hld-playbook.md)                       | Designing the architecture                 |
| [Phase 4: LLD](lld-playbook.md)                       | Planning the implementation                |
| [Phase 5: Implementation](implement-playbook.md)      | Building it                                |
| [Phase 6: Post-Impl Sync](post-impl-sync-playbook.md) | Syncing docs to reality                    |
| [Change Review Rubric](change-review-rubric.md)       | Reviewing changes against platform gates   |

## Review Rubric

The [Change Review Rubric](change-review-rubric.md) is the canonical 16-concern checklist used across code review, design review, pre-merge self-review, and post-implementation sync. Helix concerns in `.helix/concerns/` align to these 16 categories via their `rubric_concern` field.

## Feature Status Lifecycle

Every feature has a status that tracks its maturity:

```
PLANNED ──→ ALPHA ──→ BETA ──→ STABLE
  (spec)    (code)   (tested)  (production)
```

See [Pipeline Reference](pipeline.md) for full transition criteria.

## Using These Playbooks with AI Agents

These playbooks are designed to work with any agent that can read files, write files, search code, and run shell commands. To use them:

1. **Point the agent at this directory**: Tell it "Follow the SDLC playbooks in `docs/sdlc/`"
2. **Start with the right phase**: If you have no artifacts, start at Phase 1. If you already have a feature spec, start at Phase 2.
3. **The agent reads the playbook for each phase**, follows the workflow steps, and produces the expected artifact.
4. **Review the artifact** at each phase before proceeding.

### Agent-Specific Setup

| Agent       | How to Configure                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | Skills in `.claude/skills/` wrap these playbooks with Claude-specific tooling. Use `/feature-spec`, `/hld`, etc.                |
| Codex       | Add to system prompt: "Follow the SDLC playbooks in docs/sdlc/ for all feature work. Read the relevant playbook before acting." |
| Cursor      | Add to `.cursorrules`: "For feature development, follow docs/sdlc/pipeline.md. Read the phase playbook before starting."        |
| Human       | Read the playbook for your current phase. Use the checklists as review gates.                                                   |

## Key Conventions

- **Artifact locations are fixed** — don't put specs in random places
- **Commit after each phase** — one commit per artifact, message format: `[ABLP-2] docs(<scope>): <description>`
- **Log everything** to `docs/sdlc-logs/<feature-slug>/` — one log file per phase
- **Clarifying questions first** — never generate a full document from a one-line description
- **Ground in code** — every claim in a spec must be traceable to repository evidence
- **Declare persona swim lanes early** — feature specs, HLDs, and reviews must make end-user, agent-developer, and platform-developer boundaries explicit
- **Mark unknowns** — use "Open Questions" sections rather than guessing
- **Emit a Phase Handoff Packet after every phase** — add the compact packet to the end of the phase log before moving forward
- **Plan reachability early** — HLD and LLD must treat implemented-vs-wired as a design concern, not just a post-implementation cleanup task
- **Evaluate SDLC prompt changes** — compare playbook edits against a small corpus of prior features and bugfixes before treating them as an improvement

## Related

- [Feature docs index](../features/README.md)
- [Testing docs index](../testing/README.md)
- [Feature template](../features/TEMPLATE.md)
- [Authoring guide](../features/AUTHORING_GUIDE.md)
