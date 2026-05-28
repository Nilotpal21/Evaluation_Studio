# SDLC Pipeline Backlog

> **Created**: 2026-03-22
> **Last Updated**: 2026-03-25
> **Purpose**: Track re-running every feature through the proper SDLC pipeline (`/feature-spec` -> `/test-spec` -> `/hld` -> `/lld`) with full audit loops, product-oracle, and phase-auditors.

---

## Why This Exists

All 76 features have feature specs and testing guides, but **96% were bulk-generated** without the proper SDLC pipeline. This means:

- No clarifying questions were asked (product-oracle skipped)
- No audit loops were run (phase-auditor skipped)
- No SDLC logs exist for traceability
- Specs are shallow — template-filled rather than code-grounded
- 29 features have NO HLD or LLD at all
- 47 features have HLD/LLD but they were generated in a single pass, not iteratively

**Goal**: Re-run all 4 SDLC phases for every feature, 2-3 features at a time, priority-ordered.

---

## Execution Rules

1. Run `/feature-spec <slug>` — full pipeline with oracle + 2 audit rounds
2. Run `/test-spec <slug>` — full pipeline with 2 audit rounds
3. Run `/hld <slug>` — full pipeline with 3 audit rounds
4. Run `/lld <slug>` — full pipeline with 5 audit rounds
5. Run `/compact` between each phase
6. Commit after each phase completes
7. Update this backlog with timestamps after each phase

---

## Status Legend

| Symbol | Meaning               |
| ------ | --------------------- |
| `-`    | Not started           |
| `R`    | Running now           |
| `D`    | Done (with timestamp) |
| `S`    | Skipped (with reason) |

---

## P0 — Critical (Security, Core Runtime, High-Risk)

Features where bugs have maximum blast radius or security/compliance implications. Run these first.

| #   | Feature               | Slug                    | Status | Spec    | Test    | HLD     | LLD     | Notes                                                                   |
| --- | --------------------- | ----------------------- | ------ | ------- | ------- | ------- | ------- | ----------------------------------------------------------------------- |
| 1   | Auth Profiles         | `auth-profiles`         | BETA   | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. 13 missing test files found, pkg naming corrected                 |
| 2   | Memory & Sessions     | `memory-sessions`       | BETA   | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. 8 gaps (2 HIGH), 4-phase LLD plan                                 |
| 3   | Guardrails            | `guardrails`            | BETA   | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. projectId bug found, 84% E2E gap, 8-phase LLD                     |
| 4   | PII Detection         | `pii-detection`         | BETA   | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. 15 FRs, 7 gaps, no E2E for pattern CRUD API                       |
| 5   | Encryption at Rest    | `encryption-at-rest`    | BETA   | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. Pkg path corrected, PBKDF2 gap, 10 gaps total                     |
| 6   | KMS                   | `kms`                   | ALPHA  | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. 28 test files found, 10 gaps (2 HIGH)                             |
| 7   | Audit Logging         | `audit-logging`         | ALPHA  | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. env hardcoded, unbounded ClickHouse, no TTL                       |
| 8   | Pipeline Engine       | `pipeline-engine`       | ALPHA  | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. Core eval infrastructure, 4-phase LLD                             |
| 9   | EventStore            | `eventstore`            | BETA   | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. Cross-tenant wildcard, 58 console.log violations                  |
| 10  | Alerts                | `alerts`                | ALPHA  | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. SQL injection CRITICAL, mass-assignment HIGH, in-memory scheduler |
| 11  | Identity Verification | `identity-verification` | ALPHA  | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. Timing-safe hash gap, stubbed wiring, 4-phase LLD                 |
| 12  | Rate Limiting         | `rate-limiting`         | BETA   | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. 6 limiter surfaces, test coverage gap, 3-phase LLD                |

**Suggested batches**: [1,2,3] → [4,5,6] → [7,8,9] → [10,11,12]

---

## P1 — Important (Core Platform, High Integration Surface)

Core features that define the platform's value proposition. STABLE features missing HLD/LLD, or high-integration features.

| #   | Feature                     | Slug                        | Status | Spec    | Test    | HLD     | LLD     | Notes                                                         |
| --- | --------------------------- | --------------------------- | ------ | ------- | ------- | ------- | ------- | ------------------------------------------------------------- |
| 13  | ABL Language                | `abl-language`              | STABLE | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. Dual-parser arch, 200 test files, CEL hardening needed  |
| 14  | Agent Anatomy               | `agent-anatomy`             | STABLE | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. agent_versions lacks tenantId, console.error gap        |
| 15  | Agent Development (Studio)  | `agent-development-studio`  | STABLE | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. 60+ routes, 20+ stores, 10 gaps, 6-phase LLD            |
| 16  | Agent Testing & Evals       | `agent-testing-evals`       | ALPHA  | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. 27 FRs, no Studio UI yet, 5-phase LLD, ~75 test cases   |
| 17  | Model Hub                   | `model-hub`                 | BETA   | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. 7 collections, 11 gaps, policy enforcement missing      |
| 18  | Deployments & Versioning    | `deployments-versioning`    | ALPHA  | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. 5 models, 8 gaps, no Studio UI, 5-phase LLD             |
| 19  | Tool Invocations            | `tool-invocations`          | BETA   | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. 50+ files, 10 gaps, SSRF validator, 4-phase LLD         |
| 20  | Channels                    | `channels`                  | ALPHA  | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. 27 types, zero E2E exists, 6-phase LLD                  |
| 21  | Multi-Agent Orchestration   | `multi-agent-orchestration` | BETA   | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. RoutingExecutor 4141 LOC, 3 E2E gaps, 4-phase LLD       |
| 22  | SSO / Enterprise Auth       | `sso-enterprise-auth`       | ALPHA  | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. 14 FRs, 8 gaps, 6-phase LLD                             |
| 23  | Session Compaction          | `session-compaction`        | ALPHA  | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. Disabled by default, compaction model TODO, 4-phase LLD |
| 24  | NLU / Intent Classification | `nlu`                       | ALPHA  | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. 2 phantom files removed, 12 FRs, 10 gaps, 4-phase LLD   |
| 25  | Tenant LLM Policy           | `tenant-llm-policy`         | ALPHA  | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. Zero tests, 403 vs 404 gap, fail-open by design         |
| 26  | Tracing & Observability     | `tracing-observability`     | ALPHA  | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. 4-tier storage, 30+ event types, 5-phase LLD            |
| 27  | Webhook System              | `webhook-system`            | ALPHA  | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. HMAC signing, SSRF protection, zero tests, 5-phase LLD  |
| 28  | Environment Variables       | `environment-variables`     | ALPHA  | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. Base fallback gap, 18 FRs, 7 gaps, 4-phase LLD          |

**Suggested batches**: [13,14] → [15,16] → [17,18] → [19,20] → [21,22] → [23,24] → [25,26] → [27,28]

---

## P2 — Standard (BETA Features, Moderate Risk)

Features approaching stability or with meaningful integration surface.

| #   | Feature                 | Slug                       | Status  | Spec    | Test    | HLD     | LLD     | Notes                                                                        |
| --- | ----------------------- | -------------------------- | ------- | ------- | ------- | ------- | ------- | ---------------------------------------------------------------------------- |
| 29  | Connectors              | `connectors`               | ALPHA   | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. 21 FRs, zero E2E, 4 CLAUDE.md violations                               |
| 30  | MCP Support             | `mcp-support`              | ALPHA   | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. Dual exec path, no live E2E, 3-phase LLD                               |
| 31  | A2A Integration         | `a2a-integration`          | BETA    | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. 11 gaps, globalThis.fetch patch, 5-phase                               |
| 32  | SDK                     | `sdk`                      | ALPHA   | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. 18 FRs, zero E2E, origin validation gap, 5-phase LLD                   |
| 33  | Voice Capabilities      | `voice-capabilities`       | ALPHA   | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. 9 FRs, zero E2E/integ, 4 transports, 5-phase LLD                       |
| 34  | Voice Analytics         | `voice-analytics`          | ALPHA   | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. 20 FRs, 13 gaps, MV agent_name missing, 4-phase LLD                    |
| 35  | OpenAPI Documentation   | `openapi-documentation`    | ALPHA   | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. 18 FRs, zero tests, 52/117 Studio routes unannotated, 4-phase LLD      |
| 36  | Proactive Messaging     | `proactive-messaging`      | PLANNED | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. 10 FRs, no channel outbound(), consent model, 5-phase LLD              |
| 37  | Knowledge Graph         | `knowledge-graph`          | ALPHA   | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. 30 FRs, Cypher injection P0, no E2E, 5-phase LLD                       |
| 38  | Structured Data         | `structured-data`          | ALPHA   | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. 9 FR groups, SQL injection gap, query stubs TODO, 6-phase LLD          |
| 39  | Connector Discovery     | `connector-discovery`      | ALPHA   | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. 8 FRs, only SharePoint impl, 30% coverage, 5-phase LLD                 |
| 40  | Multimodal Processing   | `multimodal-processing`    | PLANNED | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. 24 FRs, no audio/video proc, 3 overlapping workers, 5-phase LLD        |
| 41  | Platform Admin          | `platform-admin`           | ALPHA   | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. 12 FRs, JWT not verified P0, no rate limiting, 7-phase LLD             |
| 42  | Sizing Calculator       | `sizing-calculator`        | PLANNED | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. 24 FRs, no HTTP API/UI, HA multiplier unused, 5-phase LLD              |
| 43  | Diagnostics Engine      | `diagnostics`              | PLANNED | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. 20 FRs, 7 analyzers exist, no persistence, 5-phase LLD                 |
| 44  | Circuit Breaker         | `circuit-breaker`          | PLANNED | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. 15 FRs, 4 independent impls, SessionLLMClient unprotected, 7-phase LLD |
| 45  | Configuration Mgmt      | `configuration-management` | PLANNED | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. 10 FRs, TenantConfigService duplication, no feature flags, 7-phase LLD |
| 46  | Project Canvas          | `project-canvas`           | PLANNED | D 03-22 | D 03-22 | D 03-22 | D 03-22 | DONE. 15 FRs, client-side only, ReactFlow+ELK exists, 5-phase LLD            |
| 47  | Project Import/Export   | `project-import-export`    | ALPHA   | D 03-23 | D 03-23 | D 03-23 | D 03-23 | DONE. 18 FRs, versioning, conflict resolution, selective import, 4-phase LLD |
| 48  | Workflows & Human Tasks | `workflows`                | ALPHA   | D 03-23 | D 03-23 | D 03-23 | D 03-23 | DONE. 30 FRs, zero E2E, CRUD routes missing, ~7500 LOC, 8-phase LLD          |
| 49  | Contacts Management     | `contacts`                 | ALPHA   | D 03-23 | D 03-23 | D 03-23 | D 03-23 | DONE. Contact CRUD, import/export, dedup, merge, lifecycle tracking          |
| 50  | Device Auth             | `device-auth`              | ALPHA   | D 03-23 | D 03-23 | D 03-23 | D 03-23 | DONE. Auth field mismatch, device code flow, polling, 4-phase LLD            |
| 51  | Invitations             | `invitations`              | ALPHA   | D 03-23 | D 03-23 | D 03-23 | D 03-23 | DONE. Workspace invites, role-based, expiry, acceptance flow, 4-phase LLD    |
| 52  | Email Channel / SMTP    | `email-channel`            | ALPHA   | D 03-23 | D 03-23 | D 03-23 | D 03-23 | DONE. SMTP/IMAP, template rendering, attachments, 7-phase LLD                |
| 53  | LiveKit Integration     | `livekit`                  | ALPHA   | D 03-23 | D 03-23 | D 03-23 | D 03-23 | DONE. Voice integration, room mgmt, real-time audio, 4-phase LLD             |

**Suggested batches**: [29,30,31] → [32,33,34] → [35,36,37] → [38,39,40] → [41,42,43] → [44,45,46] → [47,48,49] → [50,51,52] → [53]

---

## P3 — Low Priority (ALPHA, PLANNED, Niche)

Features in early development or narrow scope. Run last.

| #   | Feature                   | Slug                             | Status  | Spec    | Test    | HLD     | LLD     | Notes                                                                |
| --- | ------------------------- | -------------------------------- | ------- | ------- | ------- | ------- | ------- | -------------------------------------------------------------------- |
| 54  | Agent Transfer            | `agent-transfer`                 | ALPHA   | D 03-23 | D 03-23 | D 03-23 | D 03-23 | DONE. IVR + warm/cold transfer, context preservation, 4-phase LLD    |
| 55  | Multi-Agent Session Mgmt  | `multi-agent-session-management` | PLANNED | D 03-23 | D 03-23 | D 03-23 | D 03-23 | DONE. Shared session state, handoff context, isolation, 4-phase LLD  |
| 56  | CORS                      | `cors`                           | BETA    | D 03-23 | D 03-23 | D 03-23 | D 03-23 | DONE. Single-origin gap found, 3 open gaps, 5-phase LLD              |
| 57  | Workspace Sharing         | `workspace-sharing`              | BETA    | D 03-23 | D 03-23 | D 03-23 | D 03-23 | DONE. Studio collaboration, role-based access, 5-phase LLD           |
| 58  | Message Templates         | `message-templates`              | PLANNED | D 03-23 | D 03-23 | D 03-23 | D 03-23 | DONE. Template CRUD, variable interpolation, versioning              |
| 59  | Analytics Dashboard       | `analytics-insights-dashboard`   | PLANNED | D 03-23 | D 03-23 | D 03-23 | D 03-23 | DONE. ClickHouse insights, KPI widgets, custom dashboards            |
| 60  | Observatory               | `observatory`                    | ALPHA   | D 03-23 | D 03-23 | D 03-23 | D 03-23 | DONE. Session replay, real-time monitoring, trace viz, 4-phase LLD   |
| 61  | Web Crawling              | `web-crawling`                   | PLANNED | D 03-23 | D 03-23 | D 03-23 | D 03-23 | DONE. Playwright crawler, sitemap discovery, rate limiting           |
| 62  | Proxy Configuration       | `proxy-config`                   | ALPHA   | D 03-23 | D 03-23 | D 03-23 | D 03-23 | DONE. HTTP/SOCKS5 routing, per-tenant config, env fallback           |
| 63  | OAuth Tooling             | `oauth-tooling`                  | PLANNED | D 03-23 | D 03-23 | D 03-23 | D 03-23 | DONE. OAuth provider mgmt, token refresh, PKCE flow, 4-phase LLD     |
| 64  | Seed Data                 | `seed-data`                      | ALPHA   | D 03-23 | D 03-23 | D 03-23 | D 03-23 | DONE. Seed generation, env-aware profiles, idempotent seeding        |
| 65  | Custom Events             | `custom-external-events`         | PLANNED | D 03-23 | D 03-23 | D 03-23 | D 03-23 | DONE. External event ingestion, webhook routing, schema validation   |
| 66  | Tags & Eval Tags          | `tags`                           | PLANNED | D 03-23 | D 03-23 | D 03-23 | D 03-23 | DONE. 14 FRs, 7 gaps, eval tagging, tag CRUD, 7-phase LLD            |
| 67  | ROI Tracking              | `roi-tracking`                   | PLANNED | D 03-23 | D 03-23 | D 03-23 | D 03-23 | DONE. 15 FRs, ROI calculator, budget alerts, 7-phase LLD             |
| 68  | ABL LSP / VS Code         | `abl-lsp`                        | PLANNED | D 03-23 | D 03-23 | D 03-23 | D 03-23 | DONE. 3 existing packages, 3-layer arch, 75 tests, 7-phase LLD       |
| 69  | Billing & Usage           | `billing`                        | PLANNED | D 03-23 | D 03-23 | D 03-23 | D 03-23 | DONE. 5 existing models, quota enforcement, credit pipeline, 5-phase |
| 70  | Experiments / A/B Testing | `experiments`                    | PLANNED | D 03-23 | D 03-23 | D 03-23 | D 03-23 | DONE. 24 FRs, FNV-1a hashing, Redis-cached, 7-phase LLD              |
| 71  | Feedback System           | `feedback`                       | ALPHA   | D 03-23 | D 03-23 | D 03-23 | D 03-23 | DONE. 12 FRs, ClickHouse storage, thumbs/rating/CSAT, 6-phase LLD    |
| 72  | Transcripts               | `transcripts`                    | PLANNED | D 03-23 | D 03-23 | D 03-23 | D 03-23 | DONE. Session export, gzip, RBAC, encryption plugin, 5-phase LLD     |
| 73  | Filler Messages           | `filler-messages`                | BETA    | D 03-23 | D 03-23 | D 03-23 | D 03-23 | DONE. 14 FRs, 34 existing tests, Phase 1 MVP complete, 3-phase LLD   |
| 74  | Arch AI Assistant         | `arch-ai-assistant`              | BETA    | D 03-23 | D 03-23 | D 03-23 | D 03-23 | DONE. 17 components, 3 stores, 7 routes, 13 test files, 6-phase LLD  |
| 75  | Gradient Design Tokens    | `gradient-design-tokens`         | PLANNED | D 03-23 | D 03-23 | D 03-23 | D 03-23 | DONE. 8 gradient patterns, 2-tier token arch, 42 tests, 5-phase LLD  |
| 76  | Reusable Agent Modules    | `reusable-agent-modules`         | ALPHA   | D 03-23 | D 03-23 | D 03-23 | D 03-23 | DONE. 20 FRs, 381 tests, 5 entities, 6 sprints, mature impl          |

**Suggested batches**: [54,55,56] → [57,58,59] → [60,61,62] → [63,64,65] → [66,67,68] → [69,70,71] → [72,73,74] → [75,76]

---

## Progress Summary

| Priority     | Total  | Spec Done | Test Done | HLD Done | LLD Done | Fully Done |
| ------------ | ------ | --------- | --------- | -------- | -------- | ---------- |
| P0 Critical  | 12     | 12        | 12        | 12       | 12       | 12         |
| P1 Important | 16     | 16        | 16        | 16       | 16       | 16         |
| P2 Standard  | 25     | 25        | 25        | 25       | 25       | 25         |
| P3 Low       | 23     | 23        | 23        | 23       | 23       | 23         |
| **Total**    | **76** | **76**    | **76**    | **76**   | **76**   | **76**     |

---

## Execution Log

_Record each batch run here with timestamps._

| Batch | Features                                           | Started          | Spec | Test | HLD | LLD | Completed        |
| ----- | -------------------------------------------------- | ---------------- | ---- | ---- | --- | --- | ---------------- |
| P0-B1 | Auth Profiles, Memory & Sessions, Guardrails       | 2026-03-22 16:30 | D    | D    | D   | D   | 2026-03-22 17:00 |
| P0-B2 | PII Detection, Encryption at Rest, KMS             | 2026-03-22 18:35 | D    | D    | D   | D   | 2026-03-22 19:00 |
| P0-B3 | Audit Logging, Pipeline Engine, EventStore         | 2026-03-22 19:15 | D    | D    | D   | D   | 2026-03-22 20:30 |
| P0-B4 | Alerts, Identity Verification, Rate Limiting       | 2026-03-22 21:00 | D    | D    | D   | D   | 2026-03-22 21:50 |
| P1-B1 | ABL Language, Agent Anatomy                        | 2026-03-22 21:50 | D    | D    | D   | D   | 2026-03-22 22:10 |
| P1-B2 | Agent Dev Studio, Agent Testing & Evals            | 2026-03-22 22:10 | D    | D    | D   | D   | 2026-03-22 22:30 |
| P1-B3 | Model Hub, Deployments & Versioning                | 2026-03-22 22:30 | D    | D    | D   | D   | 2026-03-22 22:50 |
| P1-B4 | Tool Invocations, Channels                         | 2026-03-22 22:50 | D    | D    | D   | D   | 2026-03-22 23:10 |
| P1-B5 | Multi-Agent Orchestration, SSO Enterprise Auth     | 2026-03-22 23:10 | D    | D    | D   | D   | 2026-03-22 23:30 |
| P1-B6 | Session Compaction, NLU                            | 2026-03-22 23:30 | D    | D    | D   | D   | 2026-03-22 23:50 |
| P1-B7 | Tenant LLM Policy, Tracing & Observability         | 2026-03-22 23:50 | D    | D    | D   | D   | 2026-03-23 00:10 |
| P1-B8 | Webhook System, Environment Variables              | 2026-03-23 00:10 | D    | D    | D   | D   | 2026-03-23 00:30 |
| P2-B1 | Connectors, MCP Support, A2A Integration           | 2026-03-23 00:30 | D    | D    | D   | D   | 2026-03-23 01:00 |
| P2-B2 | SDK, Voice Capabilities, Voice Analytics           | 2026-03-23 01:00 | D    | D    | D   | D   | 2026-03-23 01:40 |
| P2-B3 | OpenAPI Docs, Proactive Messaging, Knowledge Graph | 2026-03-23 01:42 | D    | D    | D   | D   | 2026-03-23 01:58 |
| P2-B4 | Structured Data, Connector Discovery, Multimodal   | 2026-03-23 01:59 | D    | D    | D   | D   | 2026-03-23 02:12 |
| P2-B5 | Platform Admin, Sizing Calculator, Diagnostics     | 2026-03-23 02:12 | D    | D    | D   | D   | 2026-03-23 02:26 |
| P2-B6 | Circuit Breaker, Config Mgmt, Project Canvas       | 2026-03-23 02:27 | D    | D    | D   | D   | 2026-03-23 02:40 |
| P2-B7 | Project Import/Export, Workflows, Contacts         | 2026-03-23 02:41 | D    | D    | D   | D   | 2026-03-23 07:24 |
| P2-B8 | Device Auth, Invitations, Email Channel            | 2026-03-23 07:25 | D    | D    | D   | D   | 2026-03-23 07:43 |
| P2-B9 | LiveKit Integration                                | 2026-03-23 07:44 | D    | D    | D   | D   | 2026-03-23 08:07 |
| P3-B1 | Agent Transfer, Multi-Agent Session, CORS          | 2026-03-23 07:44 | D    | D    | D   | D   | 2026-03-23 08:07 |
| P3-B2 | Workspace Sharing, Message Templates, Analytics    | 2026-03-23 08:08 | D    | D    | D   | D   | 2026-03-23 08:30 |
| P3-B3 | Observatory, Web Crawling, Proxy Config            | 2026-03-23 08:31 | D    | D    | D   | D   | 2026-03-23 08:51 |
| P3-B4 | OAuth Tooling, Seed Data, Custom Events            | 2026-03-23 08:52 | D    | D    | D   | D   | 2026-03-23 09:30 |
| P3-B5 | Tags, ROI Tracking, ABL LSP                        | 2026-03-23 09:31 | D    | D    | D   | D   | 2026-03-23 10:34 |
| P3-B6 | Billing, Experiments, Feedback                     | 2026-03-23 10:35 | D    | D    | D   | D   | 2026-03-23 12:22 |
| P3-B7 | Transcripts, Filler Messages, Arch AI Assistant    | 2026-03-23 12:23 | D    | D    | D   | D   | 2026-03-23 13:00 |
| P3-B8 | Gradient Design Tokens, Reusable Agent Modules     | 2026-03-23 13:01 | D    | D    | D   | D   | 2026-03-23 13:35 |

---

## Notes

- Features with existing SDLC logs (filler-messages, arch-ai-assistant, gradient-design-tokens, reusable-agent-modules, connectors) may need lighter re-runs — check log quality before deciding
- 8 HIGH-severity security findings documented in `docs/feature-quality-matrix.md` — prioritize features containing those findings (Alerts SQL injection, EventStore cross-tenant, Transcripts path traversal, Experiments mass assignment, Device Auth field mismatch)
- Status discrepancies found: arch-ai-assistant (README: ALPHA, spec: STABLE), filler-messages (README: BETA, spec: STABLE), reusable-agent-modules (README: PLANNED, spec: ALPHA) — specs are authoritative
