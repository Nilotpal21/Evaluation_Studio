# Feature Documentation Quality Matrix

> **Last Updated**: 2026-03-25
> **Total Features Documented**: 78 (31 original + 47 newly documented)

This matrix tracks documentation completeness and quality for every platform feature.

---

## Documentation Coverage Summary

| Metric                      | Count |
| --------------------------- | ----- |
| Features with Feature Spec  | 78    |
| Features with Testing Guide | 78    |
| Features with HLD           | 50    |
| Features with LLD           | 49    |
| Full SDLC coverage (all 4)  | 49    |
| Features at 18/18 sections  | 43    |
| Features with < 18 sections | 4     |
| Features at STABLE          | 0     |
| Features at BETA            | 4     |
| Features at ALPHA           | 25    |
| Features at PLANNED         | 16    |

---

## Quality Matrix — Newly Documented Features (45)

| Feature                                                         | Status  | Spec | Test | HLD | LLD | Sections | Gaps | Quality      |
| --------------------------------------------------------------- | ------- | ---- | ---- | --- | --- | -------- | ---- | ------------ |
| **Security & Compliance**                                       |         |      |      |     |     |          |      |              |
| [Guardrails](features/guardrails.md)                            | BETA    | Y    | Y    | Y   | Y   | 18/18    | 5    | GOOD         |
| [PII Detection](features/pii-detection.md)                      | BETA    | Y    | Y    | Y   | Y   | 18/18    | 5    | GOOD         |
| [KMS](features/kms.md)                                          | ALPHA   | Y    | Y    | Y   | Y   | 18/18    | 9    | GOOD         |
| [Encryption at Rest](features/encryption-at-rest.md)            | BETA    | Y    | Y    | Y   | Y   | 18/18    | 6    | GOOD         |
| [Audit Logging](features/audit-logging.md)                      | ALPHA   | Y    | Y    | Y   | Y   | 18/18    | 6    | GOOD         |
| [Identity Verification](features/identity-verification.md)      | ALPHA   | Y    | Y    | Y   | Y   | 18/18    | 7    | GOOD         |
| **Analytics & Observability**                                   |         |      |      |     |     |          |      |              |
| [Analytics Dashboard](features/analytics-insights-dashboard.md) | PLANNED | Y    | Y    | Y   | Y   | 18/18    | 4    | GOOD         |
| [Voice Analytics](features/voice-analytics.md)                  | ALPHA   | Y    | Y    | Y   | Y   | 18/18    | 5    | GOOD         |
| [Observatory](features/observatory.md)                          | ALPHA   | Y    | Y    | Y   | Y   | 18/18    | 5    | GOOD         |
| [EventStore](features/eventstore.md)                            | BETA    | Y    | Y    | Y   | Y   | 15/18    | 11   | NEEDS REVIEW |
| [Alerts](features/alerts.md)                                    | ALPHA   | Y    | Y    | Y   | Y   | 13/18    | 10   | NEEDS REVIEW |
| **SearchAI Sub-systems**                                        |         |      |      |     |     |          |      |              |
| [Web Crawling](features/web-crawling.md)                        | PLANNED | Y    | Y    | Y   | Y   | 18/18    | 7    | GOOD         |
| [Knowledge Graph](features/knowledge-graph.md)                  | ALPHA   | Y    | Y    | Y   | Y   | 18/18    | 9    | GOOD         |
| [Structured Data](features/structured-data.md)                  | ALPHA   | Y    | Y    | Y   | Y   | 12/18    | 8    | NEEDS REVIEW |
| [Connector Discovery](features/connector-discovery.md)          | ALPHA   | Y    | Y    | Y   | Y   | 12/18    | 0    | NEEDS REVIEW |
| [Multimodal Processing](features/multimodal-processing.md)      | PLANNED | Y    | Y    | Y   | Y   | 10/18    | 9    | NEEDS REVIEW |
| **Platform Operations**                                         |         |      |      |     |     |          |      |              |
| [Platform Admin](features/platform-admin.md)                    | ALPHA   | Y    | Y    | Y   | Y   | 18/18    | 5    | GOOD         |
| [Billing & Usage](features/billing.md)                          | PLANNED | Y    | Y    | Y   | Y   | 18/18    | 5    | GOOD         |
| [Sizing Calculator](features/sizing-calculator.md)              | PLANNED | Y    | Y    | Y   | Y   | 18/18    | 4    | GOOD         |
| [Diagnostics Engine](features/diagnostics.md)                   | PLANNED | Y    | Y    | Y   | Y   | 18/18    | 3    | GOOD         |
| [Circuit Breaker](features/circuit-breaker.md)                  | PLANNED | Y    | Y    | Y   | Y   | 18/18    | 4    | GOOD         |
| [Configuration Mgmt](features/configuration-management.md)      | PLANNED | Y    | Y    | Y   | Y   | 18/18    | 5    | GOOD         |
| **Developer Experience**                                        |         |      |      |     |     |          |      |              |
| [ABL LSP / VS Code](features/abl-lsp.md)                        | PLANNED | Y    | Y    | Y   | Y   | 18/18    | 8    | GOOD         |
| [Project Canvas](features/project-canvas.md)                    | PLANNED | Y    | Y    | Y   | Y   | 18/18    | 8    | GOOD         |
| [Project Import/Export](features/project-import-export.md)      | ALPHA   | Y    | Y    | Y   | Y   | 18/18    | 6    | GOOD         |
| **Runtime — Core**                                              |         |      |      |     |     |          |      |              |
| [Pipeline Engine](features/pipeline-engine.md)                  | ALPHA   | Y    | Y    | Y   | Y   | 18/18    | 14   | GOOD         |
| [Workflows](features/workflows.md)                              | ALPHA   | Y    | Y    | Y   | Y   | 18/18    | 5    | GOOD         |
| [Contacts](features/contacts.md)                                | ALPHA   | Y    | Y    | Y   | Y   | 18/18    | 6    | GOOD         |
| [Experiments](features/experiments.md)                          | PLANNED | Y    | Y    | Y   | Y   | 18/18    | 6    | GOOD         |
| [Feedback](features/feedback.md)                                | ALPHA   | Y    | Y    | Y   | Y   | 18/18    | 5    | GOOD         |
| [Device Auth](features/device-auth.md)                          | ALPHA   | Y    | Y    | Y   | Y   | 18/18    | 6    | GOOD         |
| **Runtime — Engine**                                            |         |      |      |     |     |          |      |              |
| [Session Compaction](features/session-compaction.md)            | ALPHA   | Y    | Y    | Y   | Y   | 18/18    | 3    | GOOD         |
| [NLU / Intent Classification](features/nlu.md)                  | ALPHA   | Y    | Y    | Y   | Y   | 18/18    | 5    | GOOD         |
| [Proxy Configuration](features/proxy-config.md)                 | ALPHA   | Y    | Y    | Y   | Y   | 18/18    | 5    | GOOD         |
| [Tenant LLM Policy](features/tenant-llm-policy.md)              | ALPHA   | Y    | Y    | Y   | Y   | 18/18    | 6    | GOOD         |
| **Integration & Communication**                                 |         |      |      |     |     |          |      |              |
| [SSO / Enterprise Auth](features/sso-enterprise-auth.md)        | ALPHA   | Y    | Y    | Y   | Y   | 18/18    | 4    | GOOD         |
| [Invitations](features/invitations.md)                          | ALPHA   | Y    | Y    | Y   | Y   | 18/18    | 5    | GOOD         |
| [Email Channel](features/email-channel.md)                      | ALPHA   | Y    | Y    | Y   | Y   | 18/18    | 5    | GOOD         |
| [LiveKit Integration](features/livekit.md)                      | ALPHA   | Y    | Y    | Y   | Y   | 18/18    | 4    | GOOD         |
| [OAuth Tooling](features/oauth-tooling.md)                      | PLANNED | Y    | Y    | Y   | Y   | 18/18    | 3    | GOOD         |
| [Seed Data](features/seed-data.md)                              | ALPHA   | Y    | Y    | Y   | Y   | 18/18    | 6    | GOOD         |
| **Miscellaneous**                                               |         |      |      |     |     |          |      |              |
| [Custom Events](features/custom-external-events.md)             | PLANNED | Y    | Y    | Y   | Y   | 18/18    | 6    | GOOD         |
| [Tags & Eval Tags](features/tags.md)                            | PLANNED | Y    | Y    | Y   | Y   | 18/18    | 6    | GOOD         |
| [Transcripts](features/transcripts.md)                          | PLANNED | Y    | Y    | Y   | Y   | 18/18    | 8    | GOOD         |
| [ROI Tracking](features/roi-tracking.md)                        | PLANNED | Y    | Y    | Y   | Y   | 18/18    | 7    | GOOD         |

**Legend**: Spec = Feature Spec, Test = Testing Guide, HLD = High-Level Design, LLD = Low-Level Design. Sections = count of 18 template sections present. Gaps = documented GAP-NNN entries. Quality: GOOD (18/18 sections, all 4 docs), NEEDS REVIEW (missing sections or docs).

---

## Features Needing Review

These features have fewer than 18/18 template sections and need additional content:

| Feature               | Sections | Missing                                  |
| --------------------- | -------- | ---------------------------------------- |
| Alerts                | 13/18    | Sections 5-7, 13-14 likely incomplete    |
| Connector Discovery   | 12/18    | Multiple sections likely stub or missing |
| Multimodal Processing | 10/18    | Significant sections missing             |
| Structured Data       | 12/18    | Multiple sections likely stub or missing |
| EventStore            | 15/18    | 3 sections incomplete                    |

---

## Critical Security Findings Across All Features

These were discovered during source code exploration for doc generation:

| Feature       | Finding                                                                        | Severity |
| ------------- | ------------------------------------------------------------------------------ | -------- |
| Transcripts   | Path traversal vulnerability — no ID sanitization on `output/transcripts/`     | HIGH     |
| Experiments   | Mass assignment — `req.body` passed directly to `$set` in PUT                  | HIGH     |
| Alerts        | SQL injection — metric/sourceTable interpolated into SQL                       | HIGH     |
| EventStore    | Cross-tenant wildcard — `tenantId: '*'` in EvaluationDispatcher                | HIGH     |
| Device Auth   | Auth field mismatch — `req.user?.id` vs `req.user?.sub`                        | MEDIUM   |
| Custom Events | Error format inconsistency — bare string vs structured object                  | LOW      |
| ROI Tracking  | Unused field — `fteCostPerYear` stored but never used                          | LOW      |
| Tags          | Model misplacement — EvaluationTagConfig in runtime instead of pipeline-engine | LOW      |

---

## Test Coverage Status

| Coverage Level                 | Count | Features                                                                                                                                                                                                                                                     |
| ------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Good (unit + some integration) | 12    | Guardrails, PII, KMS, Pipeline Engine, Session Compaction, NLU, SSO, Seed Data, Circuit Breaker, Project Import/Export, Platform Admin, Observatory                                                                                                          |
| Partial (unit only)            | 18    | Encryption, Audit Logging, Identity Verification, Analytics, Voice Analytics, EventStore, Web Crawling, Knowledge Graph, Diagnostics, Config Mgmt, ABL LSP, Proxy Config, Tenant LLM Policy, Invitations, Email Channel, LiveKit, OAuth Tooling, Device Auth |
| Minimal or None                | 15    | Alerts, Structured Data, Connector Discovery, Multimodal, Billing, Sizing Calculator, Workflows, Contacts, Experiments, Feedback, Custom Events, Tags, Transcripts, ROI Tracking, Project Canvas                                                             |

---

## Status Distribution

```
STABLE                        0 features
BETA    ███                   4 features (Guardrails, PII Detection, Encryption at Rest, EventStore)
ALPHA   █████████████████████ 25 features
PLANNED █████████████         16 features
```
