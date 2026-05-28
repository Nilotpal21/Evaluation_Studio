# SDLC Log: Billing — Phase 1 (Feature Spec)

**Date:** 2026-03-23
**Phase:** Feature Spec
**Status:** COMPLETE

## Summary

Generated feature spec for the Billing & Usage feature at `docs/features/billing.md`.

## Codebase Exploration

Searched the codebase for all billing-related artifacts before writing:

### Existing Models (packages/database/src/models/)

- `subscription.model.ts` — Plan tiers, hierarchical quotas (org→tenant→project), entitlements
- `deal.model.ts` — Commercial deals with phased limits, credit allotments, overage policies
- `credit-ledger.model.ts` — Per-deal credit tracking with entries (usage, topup, adjustment, rollover)
- `usage-period.model.ts` — Aggregated usage metrics per billing period
- `billing-line-item.model.ts` — Invoice line items (base, overage, addon, credit_topup)

### Existing Routes (apps/runtime/src/routes/)

- `workspace-billing.ts` — `/api/tenants/:tenantId/billing` — deals, credits, upgrade (placeholder), topup (placeholder), features
- `tenant-usage.ts` — `/api/tenants/:tenantId/usage` — ClickHouse-backed usage analytics
- `platform-admin-usage.ts` — `/api/platform/admin/usage-summary` — cross-tenant aggregation
- `platform-admin-deals.ts` — `/api/platform/admin/deals` — deal CRUD

### Existing Infrastructure

- `feature-gate.ts` middleware with PLAN_FEATURES (FREE/TEAM/BUSINESS/ENTERPRISE)
- `clickhouse-metrics-store.ts` with getTenantUsage/CostBreakdown/DailyUsage/ProjectUsage
- Seed migration for dev-login ENTERPRISE subscription
- No Studio UI exists for billing/usage

## Key Decisions (Product Oracle)

| ID  | Question                             | Decision                                                            | Classification                 |
| --- | ------------------------------------ | ------------------------------------------------------------------- | ------------------------------ |
| D1  | What data store for real-time usage? | ClickHouse for queries, MongoDB for summaries                       | DECIDED (existing pattern)     |
| D2  | Quota enforcement strategy?          | Redis cache (60s TTL), fail-open                                    | DECIDED (matches feature-gate) |
| D3  | Aggregation mechanism?               | BullMQ repeatable job (hourly)                                      | DECIDED (platform convention)  |
| D4  | External billing provider?           | Stripe (fields exist on Subscription)                               | INFERRED                       |
| D5  | Phase 1 vs Phase 2 split?            | Usage dashboard + quota enforcement first; Stripe integration later | DECIDED                        |

## Audit Findings

Self-audit before commit:

- [x] Problem statement grounded in actual codebase gaps
- [x] All referenced files verified to exist
- [x] User stories have concrete acceptance criteria
- [x] Technical context references real code paths
- [x] NFRs have measurable targets
- [x] Risks include mitigations
