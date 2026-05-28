---
doc-type: feature-spec
status: ALPHA
feature-area: developer-tooling
priority: P0
---

# HELIX — Harness for Engineering Loops and Intelligent eXecution

## Introduction

### Problem

AI-assisted development today requires manual orchestration: the developer must decide which model to use for each task, manually chain SDLC phases, interpret failures, re-run with corrections, and maintain context across iterations. Different models have complementary strengths — Codex excels at deep code reading, safe refactoring, and incremental commits; Claude excels at architecture, design, and review — but no system leverages both together autonomously.

Known model weaknesses that cause regressions:

- Claude creates duplicate code paths instead of reusing existing utilities
- Impact analysis is incomplete — affected files/imports aren't fully traced
- Wiring gets missed — components are written but not connected
- Tests are mock-heavy rather than comprehensive E2E
- Both models suggest outdated framework versions

### Goal

Build an autonomous pipeline orchestrator that takes a work item (feature audit, bug fix, enhancement) and drives it through the full development lifecycle — scanning, multi-oracle analysis, planning, implementation, testing, review, and commit — using the optimal model for each stage, with real-time visibility and user checkpoints for ambiguous decisions.

### Summary

HELIX is a CLI-first agentic engineering harness (`helix`) that orchestrates multi-model AI pipelines. It uses Codex CLI for deep code analysis and implementation, layers Claude models on top for architecture review and orchestration, runs 4 parallel oracles to catch gaps from different perspectives, and executes fixes slice-by-slice with milestone commits and quality gates.

## Scope

### Goals

1. **Holistic Feature Audit pipeline**: Deep scan → Multi-oracle analysis → Sliced plan → Slice-by-slice implementation with commits
2. **Bug Fix pipeline**: Reproduce → Root cause → Fix → Regress
3. **Multi-model routing**: Codex for code reading/implementation, Claude Opus for design/review, Sonnet for fast operations
4. **4 parallel oracles**: Codebase, Architecture, Testing, Domain — with consensus protocol
5. **Chatty incremental progress**: Real-time terminal streaming showing exactly what's happening
6. **Async resumable sessions**: Persist to disk, resume after interruption
7. **User checkpoints**: Present ambiguous decisions, get approval at milestones
8. **Quality gates**: Typecheck, test, lint between every stage
9. **Milestone commits**: Stop at reasonable boundaries, commit, review, next slice

### Non-Goals

- VS Code extension (v2 — uses VS Code terminal for v1)
- New feature from scratch pipeline (v2 — uses existing SDLC skills)
- Custom pipeline builder UI (v2)
- Cost tracking and billing (v2)

## User Stories

1. As a developer, I want to run `helix audit "Channel Parity"` and have it find every gap, redundancy, and bug in that feature
2. As a developer, I want to see real-time progress of what the system is doing and what it's finding
3. As a developer, I want to be asked when the system can't decide something, not have it guess wrong
4. As a developer, I want each fix committed as a separate, reviewable unit
5. As a developer, I want to Ctrl+C and resume later without losing progress
6. As a developer, I want `helix fix "bug description"` to reproduce, fix, and regress a bug autonomously

## Architecture

### Components

| Component            | Location                  | Purpose                                         |
| -------------------- | ------------------------- | ----------------------------------------------- |
| CLI                  | `src/cli.ts`              | Entry point, argument parsing, session dispatch |
| Session Manager      | `src/session/`            | Create, persist, resume, list sessions          |
| Pipeline Engine      | `src/pipeline/`           | Stage execution, quality gates, looping         |
| Model Router         | `src/models/`             | Route stages to Claude/Codex, layered execution |
| Oracle Constellation | `src/oracles/`            | 4 parallel oracles with consensus protocol      |
| Progress Reporter    | `src/ui/`                 | Terminal streaming, interactive questions       |
| Pipeline Templates   | `src/pipeline/templates/` | Holistic Audit, Bug Fix definitions             |

### Model Strategy

| Stage           | Engine                   | Model                      | Why                             |
| --------------- | ------------------------ | -------------------------- | ------------------------------- |
| Deep Scan       | Codex CLI                | extra-high effort          | Deep codebase understanding     |
| Oracle Analysis | Claude Code              | Opus (4 oracles)           | Architecture/design perspective |
| Plan Generation | Claude Code              | Opus                       | Architectural planning          |
| Implementation  | Codex CLI + Claude layer | Codex primary, Opus review | Best of both                    |
| Testing         | Codex CLI + Claude layer | Codex writes, Opus reviews | Comprehensive E2E               |
| Review          | Claude Code              | Opus                       | Thorough review                 |
| Regression      | Claude Code              | Sonnet                     | Fast test execution             |

### Pipeline: Holistic Feature Audit

```
Deep Scan → Oracle Analysis (4 parallel) → User Checkpoint →
Plan Generation → User Checkpoint → Implementation (per slice) →
E2E Testing → Regression → Doc Sync
```

### Pipeline: Bug Fix

```
Reproduce → Root Cause (Codex + Claude layer) → User Checkpoint →
Implement Fix → Regression Test → Review → Full Regression
```

## Delivery Plan

### Phase 1 (Current): Core Skeleton

- Package structure, types, CLI
- Session manager, pipeline engine
- Model executors (Claude SDK, Codex CLI)
- Progress reporter, pipeline templates

### Phase 2: Scanners + Oracle Refinement

- Code scanner (AST-based import/export analysis)
- Test scanner (mock detection, coverage gaps)
- Integration scanner (cross-package wiring)
- Oracle prompt tuning

### Phase 3: Context Management

- Work journal integration with agents.md
- Cross-iteration learning
- SDLC log integration

### Phase 4: Production Hardening

- Cost tracking per session/stage
- Concurrent session support
- VS Code extension wrapper
