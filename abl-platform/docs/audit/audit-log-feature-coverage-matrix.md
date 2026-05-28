# Audit Log Feature Coverage Matrix

> Historical snapshot: this matrix was captured on 2026-04-16 before the shared audit migration completed. Coverage ratings and weak-area notes here may lag the current implementation. For live status, use [docs/testing/audit-logging.md](../testing/audit-logging.md) together with [docs/audit/audit-log-system-deep-dive.md](./audit-log-system-deep-dive.md). Update 2026-05-09: routine session lifecycle/read telemetry is no longer considered audit-log-worthy; `session.started`, `session.ended`, `session.accessed`, and `trace.queried` should be read from analytics/EventStore/traces rather than captured as new shared audit rows.

Date: 2026-04-16

Purpose: readable, feature-by-feature view of which areas that require audit logging are:

- fully covered with durable audit writes
- partially covered
- operational logging only
- missing or unclear

Related references:

- `docs/features/audit-logging.md`
- `docs/specs/audit-logging.hld.md`
- `docs/testing/audit-logging.md`
- `docs/audit/audit-log-system-deep-dive.md`
- `docs/audit/audit-log-manager-summary.md`

## How To Read This

- `Durable`: writes to a durable audit store or dedicated audit collection/table
- `Partial`: audit exists, but there are important gaps in wiring, retention, schema, or guarantees
- `Operational only`: logs or memory buffers exist, but not a durable compliance-grade audit trail
- `Missing / unclear`: the feature looks like it should be audited, but no strong production write path was found in this pass

Important note:

- `Missing / unclear` does not mean "provably absent everywhere"
- it means "no convincing durable audit path was found during source inspection"

## Quick Read

### Strong areas

- KMS audit
- PII audit
- connector audit
- Arch AI audit
- many Studio CRUD and security flows
- many runtime admin/config/security routes
- runtime sessions, workflows, versions, and contact CRUD routes

### Weak areas

- shared generic `audit_logs` layer
- generic runtime ClickHouse audit behavior
- omnichannel audit
- SearchAI field mapping operations
- inbound webhook handling
- Git integration audit
- contact lifecycle audit through the DDD contact context
- several Studio action families that exist in the action catalog but do not have obvious write callsites

## 1. Studio: Auth, Security, And Account Events

| Feature area                                                        | Coverage          | Current state                                | Main note                                                                                           |
| ------------------------------------------------------------------- | ----------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Login / failed login / account lock                                 | Durable           | Logged via Studio `logAuditEvent()`          | `apps/studio/src/app/api/auth/login/route.ts`                                                       |
| Signup / verify email / forgot password / reset password            | Durable           | Logged via Studio `logAuditEvent()`          | `apps/studio/src/app/api/auth/signup/route.ts`, `verify-email`, `forgot-password`, `reset-password` |
| Logout                                                              | Missing / unclear | Logout route revokes token and clears cookie | No `logAuditEvent()` found in `apps/studio/src/app/api/auth/logout/route.ts`                        |
| Token refresh / token revoke / all-token revoke                     | Missing / unclear | Action constants exist                       | No strong write callsites found                                                                     |
| MFA setup / verify / fail / lock / recovery code used               | Durable           | Logged via Studio `logAuditEvent()`          | `apps/studio/src/app/api/mfa/verify/route.ts`                                                       |
| MFA disable                                                         | Missing / unclear | Action constant exists                       | No clear write callsite found                                                                       |
| Device auth flow                                                    | Missing / unclear | Action constants exist                       | No clear write callsites found                                                                      |
| SSO login / failed login / config / verification / replay detection | Missing / unclear | Action constants exist                       | No clear write callsites found in this pass                                                         |

## 2. Studio: Workspace, Project, Member, And Org Governance

| Feature area                         | Coverage | Current state                                                                                  | Main note                                                      |
| ------------------------------------ | -------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Workspace create / archive / restore | Durable  | Logged via Studio `logAuditEvent()`                                                            | `create-workspace`, `workspaces/[tenantId]/archive`, `restore` |
| Workspace membership lifecycle       | Durable  | Role change, remove, deactivate, lock, reactivate, suspend, unlock, revoke sessions are logged | `apps/studio/src/app/api/workspaces/[tenantId]/members/...`    |
| Invitations                          | Durable  | Sent, accepted, resent, revoked are logged                                                     | Workspace invitation routes and accept routes                  |
| Organizations                        | Durable  | Organization create and workspace link are logged                                              | `apps/studio/src/app/api/organizations/...`                    |
| Projects                             | Durable  | Create, update, delete, archive, restore are logged                                            | `apps/studio/src/app/api/projects/...`                         |
| Project membership                   | Durable  | Add, role change, remove are logged                                                            | `apps/studio/src/services/project-member-service.ts`           |
| Agents in Studio                     | Durable  | Add and remove are logged                                                                      | `apps/studio/src/app/api/projects/[id]/agents/...`             |

## 3. Studio: Build, Config, And Tooling

| Feature area                                    | Coverage          | Current state                                                                  | Main note                                                   |
| ----------------------------------------------- | ----------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Modules / releases                              | Durable           | Enable, disable, publish, promote, import, upgrade, remove, archive are logged | `apps/studio/src/app/api/projects/[id]/module...`           |
| Module delete blocked                           | Missing / unclear | Action constant exists                                                         | No clear write callsite found                               |
| Tools                                           | Durable           | Create, import, duplicate, update, delete are logged                           | Tools routes and tool-creation service                      |
| Credentials / tenant credentials                | Durable           | Create, update, delete are logged                                              | Credentials routes                                          |
| Model configs                                   | Durable           | Create, update, delete are logged                                              | Models routes                                               |
| Service nodes / external API integration config | Durable           | Create, update, delete are logged                                              | Service node routes                                         |
| Retention / GDPR scheduler events               | Durable           | Retention sweep and GDPR events are logged                                     | `apps/studio/src/services/retention/retention-scheduler.ts` |
| Archive actions                                 | Missing / unclear | Action constants exist                                                         | No strong write callsites found                             |
| Debug token / debug access / debug tool actions | Missing / unclear | Action constants exist                                                         | No strong write callsites found                             |

## 4. Studio: Integration Surfaces

| Feature area                             | Coverage         | Current state                          | Main note                                                                                   |
| ---------------------------------------- | ---------------- | -------------------------------------- | ------------------------------------------------------------------------------------------- |
| Git integration create / update / delete | Operational only | Structured app logs exist              | No durable Studio audit write found in `apps/studio/src/app/api/projects/[id]/git/route.ts` |
| Git webhook receiver                     | Operational only | Structured logs only                   | `apps/studio/src/app/api/webhooks/git/[projectId]/route.ts`                                 |
| Git promote / PR-based flow              | Partial          | Route comments treat PR as audit trail | This is externalized history, not a unified internal audit row                              |

## 5. Runtime: Core Product Lifecycle

| Feature area                     | Coverage | Current state                                                                                  | Main note                                                                           |
| -------------------------------- | -------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Contacts CRUD routes             | Durable  | Create, update, delete, link session audited via runtime helpers                               | `apps/runtime/src/routes/contacts.ts`, `apps/runtime/src/services/audit-helpers.ts` |
| Contact domain context lifecycle | Partial  | Audit abstraction exists for create/merge/link/self-merge                                      | Durable `onContactAudit` is not wired in runtime startup                            |
| Sessions                         | Partial  | Destructive/admin mutations remain audited; routine lifecycle/read telemetry is analytics-only | Session mutation helpers and EventStore/trace analytics                             |
| Test/debug session features      | Durable  | Context injected, tool mock set, test session created                                          | Runtime helpers used from websocket handler                                         |
| Workflows                        | Durable  | Create, update, archive                                                                        | `apps/runtime/src/routes/workflows.ts`                                              |
| Versions / DSL lifecycle         | Durable  | Version created, promoted, deprecated, DSL updated                                             | Versions and project-agents routes                                                  |
| HTTP async subscriptions         | Durable  | Subscription create, update, delete                                                            | `apps/runtime/src/routes/http-async-channel.ts`                                     |

## 6. Runtime: Security, Compliance, And External Access

| Feature area               | Coverage         | Current state                                                                                                                         | Main note                                                                         |
| -------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| OAuth integrations         | Durable          | Auth events written through buffered audit writer                                                                                     | `apps/runtime/src/routes/oauth.ts`, `apps/runtime/src/repos/auth-repo.ts`         |
| Channel OAuth integrations | Durable          | Auth events written through buffered audit writer                                                                                     | `apps/runtime/src/routes/channel-oauth.ts`, `apps/runtime/src/repos/auth-repo.ts` |
| Tool execution             | Partial          | Credentialed, external-endpoint, and failed tool calls go through shared `AuditStore`; local/test executions are trace telemetry only | `apps/runtime/src/services/execution/llm-wiring.ts`, `tool-audit-logger.ts`       |
| PII access                 | Durable          | Dedicated PII audit store and logger                                                                                                  | `reasoning-executor.ts`, `packages/compiler/src/platform/security/pii-audit.ts`   |
| KMS operations             | Durable          | Dedicated ClickHouse KMS audit                                                                                                        | KMS routes, jobs, and logger                                                      |
| Omnichannel features       | Operational only | Structured logs + in-memory ring buffer                                                                                               | Not a durable compliance-grade audit path                                         |

## 7. Runtime: Admin, Config, And Platform Governance

These routes are broad but important. They do have audit writes, mostly through the runtime buffered `writeAuditLog(...)` path.

| Feature family                                  | Coverage | Current state                                         | Example routes                                                                                                                                                            |
| ----------------------------------------------- | -------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Alert config                                    | Durable  | Audit writes present                                  | `apps/runtime/src/routes/alert-config.ts`                                                                                                                                 |
| Environment variables                           | Durable  | Audit writes present                                  | `apps/runtime/src/routes/environment-variables.ts`                                                                                                                        |
| Proxy config                                    | Durable  | Audit writes present                                  | `apps/runtime/src/routes/proxy-config.ts`                                                                                                                                 |
| Guardrail providers / policies                  | Durable  | Audit writes present                                  | `apps/runtime/src/routes/guardrail-providers.ts`, `guardrail-policies.ts`                                                                                                 |
| Tenant models / LLM policy / project LLM config | Durable  | Audit writes present                                  | `tenant-models.ts`, `tenant-llm-policy.ts`, `project-llm-config.ts`                                                                                                       |
| Tool secrets / SDK public keys                  | Durable  | Audit writes present                                  | `tool-secrets.ts`, `sdk-public-keys.ts`                                                                                                                                   |
| Project settings / runtime config               | Durable  | Audit writes present                                  | `project-settings.ts`, `project-runtime-config.ts`                                                                                                                        |
| Platform admin config families                  | Durable  | Audit writes present across many admin route families | `platform-admin-config.ts`, `...billing-policy.ts`, `...deals.ts`, `...features.ts`, `...hubspot.ts`, `...models.ts`, `...resilience.ts`, `...tenants.ts`, `...traces.ts` |

## 8. SearchAI: Connector And External System Coverage

| Feature area                                      | Coverage          | Current state                                                   | Main note                                                      |
| ------------------------------------------------- | ----------------- | --------------------------------------------------------------- | -------------------------------------------------------------- |
| Connector lifecycle                               | Durable           | Dedicated connector audit subsystem                             | `apps/search-ai/src/services/connector-audit.service.ts`       |
| Connector sync lifecycle                          | Durable           | `sync.started`, `sync.completed`, `sync.failed` written durably | `apps/search-ai/src/workers/connector-sync-worker.ts`          |
| Connector proposal/setup lifecycle                | Durable           | Proposal approval/abandon and permission disable are audited    | `apps/search-ai/src/services/proposal.service.ts`              |
| Connector template/config management              | Durable           | Template reapply/update and config import are audited           | `apps/search-ai/src/services/connector-config-mgmt.service.ts` |
| Connector audit query/export                      | Durable           | Dedicated query and export routes                               | `apps/search-ai/src/routes/connector-audit.ts`                 |
| Connector notification preferences / test webhook | Missing / unclear | Routes exist                                                    | No obvious audit write found in `connector-notifications.ts`   |
| Inbound SharePoint webhooks                       | Operational only  | `console.log` / `console.warn` / `console.error`                | No dedicated connector audit write found in `webhooks.ts`      |
| Field mappings                                    | Operational only  | Logger-only “audit” helper                                      | `apps/search-ai/src/routes/mappings.ts`                        |
| Custom domain / taxonomy helper flows             | Missing / unclear | Generic audit helper exists                                     | No production callsites found in this pass                     |

## 9. SearchAI: Crawl And Knowledge Operations

| Feature area    | Coverage | Current state                                        | Main note                                        |
| --------------- | -------- | ---------------------------------------------------- | ------------------------------------------------ |
| Crawl lifecycle | Partial  | Dedicated crawl audit model and history routes exist | Audit rows are deleted when crawl job is deleted |

## 10. Dedicated Domain-Owned Audit Systems

| Subsystem       | Coverage | Current state                                | Main note                                                 |
| --------------- | -------- | -------------------------------------------- | --------------------------------------------------------- |
| KMS audit       | Durable  | Dedicated ClickHouse table and dedicated API | Strongest compliance-grade path                           |
| PII audit       | Durable  | Dedicated Mongo model and logger             | Strong path, but buffered shutdown behavior still matters |
| Connector audit | Durable  | Dedicated model/service/routes/export        | Cleanest external integration audit system                |
| Arch AI audit   | Durable  | Dedicated model, APIs, UI, export            | Strong domain-owned subsystem                             |

## 11. Admin Portal And Shared Model-Plugin Coverage

| Feature area                           | Coverage                        | Current state                                | Main note                                                          |
| -------------------------------------- | ------------------------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| Admin UI access history                | Partial                         | Durable rows exist in shared `audit_logs`    | Intentionally scoped to admin UI access history                    |
| Admin config / secret mutation history | Operational only / externalized | UI explicitly points to Bitbucket and ArgoCD | Not unified inside admin audit log                                 |
| Mongoose plugin on sensitive models    | Partial                         | Real plugin coverage exists on many models   | Actor propagation and sink-shape consistency are still weak points |

## 12. Shared Platform Layer

These are not user-facing features, but they affect audit quality across the whole platform.

| Area                             | Coverage | Current state                     | Main note                                               |
| -------------------------------- | -------- | --------------------------------- | ------------------------------------------------------- |
| Shared `AuditStore` contract     | Partial  | Good abstraction exists           | Backends do not preserve the contract consistently      |
| Shared Mongo `audit_logs`        | Partial  | Many writers use it               | Mixed schemas and mixed metadata encoding               |
| Generic runtime ClickHouse audit | Partial  | Exists as primary runtime backend | Tenant/query/trace/event-shape mismatches               |
| Studio audit API                 | Partial  | Queryable                         | Personal scope is user-only, not tenant-filtered        |
| Admin audit API                  | Partial  | Queryable                         | Good for admin access history, not full mutation ledger |
| Archive/export story             | Partial  | Support exists in pieces          | Not yet one clean tenant-safe end-to-end export path    |
| Alerting hooks                   | Partial  | Designed in abstraction           | Not consistently wired platform-wide                    |

## 13. Highest-Value Gaps

If we need a short list of the most important audit coverage gaps, these are the ones to focus on first:

1. Studio logout
2. Studio token lifecycle actions
3. Studio device auth and SSO action families
4. Studio archive action family
5. Git integration create/update/delete and inbound webhooks
6. Contact lifecycle events emitted through the DDD contact context
7. Connector notification preference / test-webhook actions
8. SearchAI inbound webhook handling
9. SearchAI field mapping operations
10. SearchAI custom-domain / taxonomy helper callsites
11. Omnichannel, if it needs to be compliance-grade rather than operational only

## Bottom Line

The system does not have one simple answer to "is this feature audited?"

The accurate answer is:

- many important features are audited
- some are audited only through dedicated subsystems
- some are only operational logs
- some have action names or abstractions defined, but no clear production write path

This is why the audit story should be described as:

- broad coverage
- uneven quality
- strong dedicated subsystems
- weaker shared generic layer
