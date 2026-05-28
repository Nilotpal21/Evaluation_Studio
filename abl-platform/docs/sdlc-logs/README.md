# SDLC Logs

Progress logs and agent learnings from the SDLC pipeline. Every feature that goes through the `/feature-spec` → `/test-spec` → `/hld` → `/lld` → implement → `/post-impl-sync` pipeline gets a subfolder here.

## Structure

```
docs/sdlc-logs/
  README.md                          ← this file
  agents.md                          ← continuous learning journal (all agents, all features)
  <feature-slug>/                    ← one folder per feature
    feature-spec.log.md              ← oracle decisions + progress for feature spec phase
    test-spec.log.md                 ← oracle decisions + progress for test spec phase
    hld.log.md                       ← oracle decisions + progress for HLD phase
    lld.log.md                       ← oracle decisions + progress for LLD phase
    implementation.log.md            ← implementation progress, commits, decisions
    post-impl-sync.log.md            ← doc sync results, coverage delta
```

## agents.md — Learning Journal

The `agents.md` file is a **continuous, append-only journal** where agents document major learnings during SDLC work. Every entry includes:

- **Date** and **feature** context
- **What was learned** — a specific, actionable insight
- **Category**: architecture, testing, tooling, process, domain

This journal is read by agents at the start of new SDLC work to avoid repeating mistakes and to build on prior insights. It is NOT a memory file — it's a living log that grows with each feature.

## Multi-Phase Remediation Projects

Some SDLC work spans multiple phases and backlog items rather than a single feature. These get their own subdirectory with a tracking doc:

- [`architecture-fitness-remediation/`](architecture-fitness-remediation/) — Architecture fitness gate, isolation hardening, route verticalization, shared decomposition, runtime core simplification. [Tracking doc](architecture-fitness-remediation/tracking.md).

## Log File Format

Each log file follows this format:

```markdown
# <Phase> Log: <Feature Name>

## Session: <date>

### Oracle Decisions

| #   | Question | Classification | Answer | Source |
| --- | -------- | -------------- | ------ | ------ |
| 1   | ...      | ANSWERED       | ...    | ...    |

### Progress

- [x] Step completed
- [ ] Step pending

### Files Created/Modified

- `path/to/file.md` — description

### Commits

- `abc1234` — commit message

### Notes

- Any observations, blockers, or decisions
```
