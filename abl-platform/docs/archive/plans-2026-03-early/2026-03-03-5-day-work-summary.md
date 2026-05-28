# ABL Platform — 5-Day Engineering Summary (Feb 27 - Mar 3, 2026)

## Overview

Over the past 5 days, 500+ commits were landed across the ABL platform monorepo, spanning 8 major workstreams: runtime resilience hardening, guardrails pipeline, NLU robustness, concurrent execution model, ABL language tooling, workflow engine, admin console, and behavior profiles. The work touched every layer of the stack — compiler, runtime, studio, database, CLI, and a new admin app.

## Runtime Resilience & Observability

The runtime received deep hardening across circuit breakers, rate limiting, and session management. Circuit breakers gained background persistence for half-open transitions and hydration observability flags, closing multi-pod inconsistency windows. Session concurrency tracking was redesigned from a Redis INCR/DECR counter to a SET-based membership model (SADD/SREM/SCARD) with configurable 48h TTL, eliminating counter drift for unbounded sessions. Rate limiters became plan-aware (FREE/TEAM/BUSINESS/ENTERPRISE tiers), all magic numbers were externalized to env vars, and 13 console.log calls were migrated to structured logging. OTEL metrics were activated for rate limiter fallbacks, LLM backpressure, and circuit breaker state transitions.

## Guardrails Pipeline (6 Phases)

A complete guardrails system was built from scratch: Tier 1 local CEL evaluators, Tier 2 model-based providers (OpenAI Moderation, PII detection, custom HTTP), Tier 3 LLM evaluators, and a pipeline orchestrator with action executors (redact, filter, fix). The pipeline integrates at tool_input, tool_output, handoff, and streaming response checkpoints. Cost tracking via Redis, result caching, webhook delivery, trace events, and tenant-scoped policy CRUD APIs round out the system.

## NLU & Extraction Robustness

A 4-tier extraction pipeline replaced the single-shot regex approach: JavaScript libraries (chrono-node, libphonenumber-js), Python NLU sidecar with circuit breaker, LLM fallback, and sidecar-based correction detection. Multi-intent support added strategy dispatch (primary_queue, fan_out), an intent queue lifecycle, and ON_INPUT priority handling. Lookup table validation gained fuzzy matching, disambiguation, and inference confirmation flows.

## Concurrent Execution Model

An ExecutionCoordinator was introduced as the single entry point for all message processing across WebSocket (debug + SDK) and HTTP chat routes. It includes per-session message queuing, Redis-backed dedup, configurable concurrency strategies, 429 queue-full responses, and execution lifecycle trace events for ClickHouse archival.

## CEL Expression Engine & ABL Language Tooling

The ABL expression language was migrated from a custom evaluator to CEL (Common Expression Language) via a dual-mode evaluator supporting both syntaxes during transition. A full language service package was built: diagnostics, completions (context-aware, CEL functions, value suggestions), hover info, document symbols, YAML format detection, and Monaco integration with Monarch tokenizer and syntax highlighting. A CLI migration tool automates ABL-to-CEL conversion.

## Workflow Engine & Connectors

A standalone workflow-engine service was bootstrapped with Restate for durable execution, step executors (agent, tool, condition, delay, parallel, approval, async webhook, loop, transform), a trigger engine (webhooks, polling, cron), and a connector framework with build-time importers for Activepieces and Nango providers. Studio gained a 3-panel workflow editor, step editors with dynamic connector loading, and trigger controls.

## Admin Console

A new admin app was scaffolded with shared UI components (DataTable, FilterBar, grouped sidebar), and pages for config overrides (with plan defaults comparison), model provisioning, and resilience controls. The runtime added platform admin APIs for tenant list/detail/status and workflow-engine proxy routes.

## Behavior Profiles

A new BEHAVIOR_PROFILE DSL section was implemented end-to-end: parser, compiler (to IR), runtime profile resolver with context assembly, trace events, project import/export support, and Studio pages with Arch AI integration.

## Key Design & Architecture Documents

- `docs/plans/2026-03-01-guardrails-system-design.md` — Guardrails architecture
- `docs/plans/2026-03-01-concurrent-execution-model-design.md` — Execution model redesign
- `docs/plans/2026-03-01-nlu-robustness-design.md` — NLU 3-phase design
- `docs/plans/2026-03-01-workflow-engine-wiring-design.md` — Workflow engine architecture
- `docs/plans/2026-03-02-behavior-profiles-design.md` — Behavior profiles design
- `docs/plans/2026-03-02-unified-agent-type-design.md` — Unified agent type (MODE removal)
- `docs/plans/2026-03-01-abl-extensions-roadmap-design.md` — ABL extensions roadmap
- `docs/plans/2026-03-03-admin-ui-billing-design.md` — Admin console design
- `docs/plans/2026-03-03-cb-persistence-session-counter-design.md` — Resilience fixes design
- `docs/plans/2026-02-28-execution-model-redesign-design.md` — Fan-out execution design
- `docs/plans/2026-03-03-session-message-lifecycle-design.md` — Session lifecycle
- `docs/plans/2026-02-27-unified-analytics-event-framework-design.md` — Analytics framework
- `docs/plans/2026-02-28-tool-permissions-alignment-design.md` — Tool permissions
- `docs/plans/2026-02-26-lambda-sandbox-runner-design.md` — Lambda sandbox runner
- `docs/abl/CEL_MIGRATION_GUIDE.md` — CEL migration guide
