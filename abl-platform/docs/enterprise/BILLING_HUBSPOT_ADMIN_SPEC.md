# Billing, HubSpot Integration & Platform Admin — Product Specification

**Date:** 2026-03-03
**Status:** Draft
**Authors:** Platform Engineering
**Scope:** End-to-end billing system, HubSpot CRM integration, platform operations admin, workspace admin

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Architecture](#2-system-architecture)
3. [Billing Model](#3-billing-model)
4. [HubSpot Integration](#4-hubspot-integration)
5. [Platform Ops Admin](#5-platform-ops-admin)
6. [Workspace Admin](#6-workspace-admin)
7. [API Reference](#7-api-reference)
8. [Data Models](#8-data-models)
9. [Security & Compliance](#9-security--compliance)
10. [Implementation Roadmap](#10-implementation-roadmap)

---

## 1. Executive Summary

The ABL platform serves enterprise customers who need granular billing, CRM-integrated deal management, and comprehensive admin tooling. This spec covers three interconnected systems:

- **Billing**: A deal-based model with hybrid credits, phased limits, per-environment resource caps, and multi-deal aggregation — replacing the current hardcoded `PLAN_LIMITS` approach
- **HubSpot Integration**: One-way CRM sync (HubSpot → Platform) for deal lifecycle management, enabling the sales team to manage commercial terms in HubSpot while the platform enforces them
- **Platform Admin**: Two admin surfaces — an internal Platform Ops app for Kore.ai engineers and an embedded Workspace Admin for customer tenant admins — sharing a common UI component library

### Current State

| Area            | Today                                                                            | Target                                                                           |
| --------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Billing         | 4 hardcoded plan tiers (FREE/TEAM/BUSINESS/ENTERPRISE) with static `PLAN_LIMITS` | Deal-based with phases, per-environment limits, hybrid credits, overage policies |
| CRM             | None                                                                             | HubSpot webhook + periodic sync, one-way read                                    |
| Platform Admin  | 4 pages (Dashboard, Config, Secrets, Audit)                                      | 10 pages with tenant management, billing, health, resilience                     |
| Workspace Admin | 7 pages (Members, Models, Arch, Voice, Security, Secrets, Billing)               | 14 pages with KMS, guardrails, connectors, analytics, enhanced billing           |

---

## 2. System Architecture

### 2.1 Admin App Topology

```
                        ┌─────────────────────────────────┐
                        │        Load Balancer             │
                        └──────┬──────────────┬────────────┘
                               │              │
              ┌────────────────▼──┐    ┌──────▼───────────────┐
              │  Platform Ops     │    │  Studio + Workspace  │
              │  apps/admin/      │    │  apps/studio/        │
              │  Port 3003        │    │  Port 5173           │
              │                   │    │                      │
              │  IP allowlist     │    │  Tenant-scoped auth  │
              │  Super-admin role │    │  Role: OWNER/ADMIN   │
              └────────┬─────────┘    └──────┬───────────────┘
                       │                     │
                       ▼                     ▼
              ┌──────────────────────────────────────────────┐
              │         packages/admin-ui/                    │
              │  Shared: DataTable, MetricCard, StatusBadge,  │
              │  FilterBar, PageHeader, ConfirmDialog,        │
              │  ChartCard, EmptyState, Tabs, Skeleton        │
              └──────────────────┬───────────────────────────┘
                                 │
              ┌──────────────────▼───────────────────────────┐
              │            Runtime API                        │
              │  apps/runtime/ — Port 3112                    │
              │                                               │
              │  /api/platform/admin/*  (Platform Ops routes) │
              │  /api/tenants/:id/*     (Workspace routes)    │
              └──────┬──────────────┬───────────────┬────────┘
                     │              │               │
              ┌──────▼──┐   ┌──────▼──┐    ┌───────▼──────┐
              │ MongoDB  │   │  Redis  │    │  ClickHouse  │
              │ (models) │   │ (cache) │    │  (analytics) │
              └──────────┘   └─────────┘    └──────────────┘
```

### 2.2 Shared UI Package (`packages/admin-ui/`)

Both admin surfaces share a component library built on shadcn/ui + Tailwind with HSL-based design tokens:

```
packages/admin-ui/
├── src/
│   ├── components/
│   │   ├── data-table.tsx       # Sortable, filterable, paginated table
│   │   ├── metric-card.tsx      # Stat card (value, label, trend, icon)
│   │   ├── status-badge.tsx     # Semantic status badges
│   │   ├── filter-bar.tsx       # Composable filter row
│   │   ├── page-header.tsx      # Title + description + actions
│   │   ├── confirm-dialog.tsx   # Destructive action confirmation
│   │   ├── empty-state.tsx      # No-data placeholder
│   │   ├── skeleton.tsx         # Loading placeholders
│   │   ├── tabs.tsx             # Radix Tabs wrapper
│   │   ├── date-range-picker.tsx
│   │   └── chart/               # Area, pie, bar charts
│   ├── hooks/
│   │   ├── use-api.ts           # SWR-based data fetching
│   │   └── use-debounce.ts
│   ├── tokens/
│   │   └── colors.css           # Shared HSL design tokens
│   └── lib/
│       ├── format.ts            # Number/date/byte formatters
│       └── cn.ts                # clsx + tailwind-merge
```

Data fetching uses SWR (`useApi` hook) with auth header injection, 401 redirect, error normalization, and automatic revalidation.

---

## 3. Billing Model

### 3.1 Plan Tiers (Base Layer)

Every organization starts with a plan tier that provides baseline resource limits:

| Tier           | Target         | Pricing          | Self-Serve              |
| -------------- | -------------- | ---------------- | ----------------------- |
| **FREE**       | Evaluation/dev | $0               | Yes                     |
| **TEAM**       | Small teams    | Per-seat + usage | Yes (upgrade from FREE) |
| **BUSINESS**   | Mid-market     | Annual contract  | Yes (upgrade from TEAM) |
| **ENTERPRISE** | Large orgs     | Custom deal      | No — Contact Sales only |

Plan limits are defined in `PLAN_LIMITS` (runtime config) and serve as the base layer in the limit resolution chain. The existing `Subscription` model tracks the org's active plan tier, billing cycle, external Stripe IDs, and hierarchical quota allocations.

### 3.2 Deal-Based Commercial Model

Deals are the primary commercial entity, replacing the plan tier as the source of truth for resource limits and features for ENTERPRISE customers. Self-serve tiers (FREE/TEAM/BUSINESS) continue using plan defaults unless a deal overrides them.

#### Deal Lifecycle

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  Created  │───▶│  Active  │───▶│  Paused  │───▶│  Expired │
│(HubSpot  │    │          │    │(billing  │    │          │
│ or manual)│    │          │    │ issue)   │    │          │
└──────────┘    └────┬─────┘    └──────────┘    └──────────┘
                     │                               ▲
                     │          ┌──────────┐         │
                     └─────────▶│ Canceled │─────────┘
                                └──────────┘
```

#### Deal Structure

Each deal contains:

| Field             | Purpose                                                     |
| ----------------- | ----------------------------------------------------------- |
| `organizationId`  | The owning organization                                     |
| `hubspotDealId`   | Optional HubSpot linkage for CRM sync                       |
| `scope`           | `organization` (all projects) or `project` (single project) |
| `aggregationMode` | How this deal's limits combine with others                  |
| `phases[]`        | Time-based phases with per-environment limits               |
| `overagePolicy`   | What happens when limits are hit                            |
| `creditAllotment` | Hybrid credit pool configuration                            |
| `features[]`      | Feature keys this deal unlocks                              |

#### Deal Phases

Deals progress through phases over time, each with independent resource limits per environment:

```
Deal: "Acme Corp Enterprise 2026"
├── Phase: "trial" (Jan 1 – Mar 31)
│   ├── dev:        100 concurrent sessions, 500K tokens/min
│   ├── staging:    50  concurrent sessions, 250K tokens/min
│   └── production: 25  concurrent sessions, 100K tokens/min
├── Phase: "ramp" (Apr 1 – Jun 30)
│   ├── dev:        500 concurrent sessions, 2M tokens/min
│   ├── staging:    250 concurrent sessions, 1M tokens/min
│   └── production: 100 concurrent sessions, 500K tokens/min
└── Phase: "full" (Jul 1 – Dec 31)
    ├── dev:        1000 concurrent sessions, 5M tokens/min
    ├── staging:    500  concurrent sessions, 2.5M tokens/min
    └── production: 500  concurrent sessions, 2.5M tokens/min
```

Each phase's `ILimitSet` includes:

- `maxConcurrentSessions` — Simultaneous active sessions
- `requestsPerMinute` — API request rate limit
- `tokensPerMinute` — LLM token throughput
- `toolCallsPerMinute` — Tool execution rate
- `messagesPerMonth` — Monthly message volume cap
- `maxAgentsPerProject` — Agent count per project
- `maxProjectsPerOrg` — Project count per organization
- `traceRetentionDays` — How long trace data is kept
- `sessionRetentionDays` — Session data retention
- `maxServiceTimeoutMs` — External service call timeout
- `maxResponseBodyBytes` — Response size cap
- `maxConcurrentServiceCalls` — Parallel external calls
- `maxPendingTimers` — Timer queue depth
- `maxEventTypesPerApp` — Event type diversity cap
- `auditLogRetentionDays` — Audit trail retention
- `archiveRetentionDays` — Archive data retention

### 3.3 Multi-Deal Aggregation

Organizations may have multiple active deals (e.g., a platform deal + a project-specific add-on). Each deal declares its `aggregationMode`:

| Mode        | Resolution                         | Example                                           |
| ----------- | ---------------------------------- | ------------------------------------------------- |
| `additive`  | Sum limits across deals            | Deal A: 1000 RPM + Deal B: 500 RPM = **1500 RPM** |
| `max_wins`  | Take highest per-limit             | Deal A: 1000 RPM, Deal B: 2000 RPM = **2000 RPM** |
| `dedicated` | Reserved for assigned project only | Deal's 1000 RPM is **only** for its `projectId`   |

Special rules:

- **Features**: Union-merged — if any active deal unlocks `sso`, SSO is enabled org-wide
- **Credits**: Always additive — total credit pool = sum of all deal credit allotments

### 3.4 Limit Resolution Chain

When the runtime checks whether a request is allowed, it resolves limits through this chain:

```
1. Plan Defaults           PLAN_LIMITS[tier]
        ↓
2. Org Deal Aggregation    All org-scoped deals, aggregated by mode
        ↓
3. Project Deal            scope=project, dedicated limits for the specific project
        ↓
4. Active Phase            Select phase where now() is between startDate and endDate
        ↓
5. Environment             Select dev/staging/production limit set
        ↓
6. Admin Overrides         Manual overrides set by platform admin
        ↓
7. Credit Check            Sufficient credits remaining in the current period?
```

Each layer can only increase limits (override upward) relative to the plan defaults. Admin overrides at step 6 are the exception — they can also decrease limits (e.g., throttle a misbehaving tenant).

### 3.5 Hybrid Credit Model

Credits provide a consumption-based billing mechanism on top of rate limits. Each deal defines a `creditAllotment`:

```typescript
{
  totalCredits: 100_000,          // Shared pool size for the period
  featureMinimums: {
    llm: 60_000,                  // Guaranteed minimum for LLM usage
    voice: 15_000,                // Guaranteed minimum for voice
    search: 15_000,               // Guaranteed minimum for search
    tools: 10_000,                // Guaranteed minimum for tool calls
  },
  creditRates: {
    llm_token_1k: 1,             // 1 credit per 1K tokens
    voice_minute: 10,            // 10 credits per voice minute
    search_query: 2,             // 2 credits per search query
    tool_call: 0.5,              // 0.5 credits per tool call
    session: 0.1,                // 0.1 credits per session
  },
  periodType: 'monthly',         // Reset cycle: monthly | annual | phase
}
```

#### Credit Consumption Logic

1. When a feature is used, check if the feature's minimum pool has capacity
2. If yes, deduct from the feature minimum (source: `minimum`)
3. If the feature minimum is exhausted, deduct from the shared pool (source: `shared`)
4. If the shared pool is also exhausted, apply the deal's `overagePolicy`

#### Credit Ledger

Each deal has a `CreditLedger` per billing period that tracks:

- `totalAllocated` — Credits available this period
- `totalConsumed` — Credits used so far
- `featureUsage` — Per-feature breakdown (allocated vs consumed)
- `sharedPoolConsumed` — Credits drawn from the shared pool
- `entries[]` — Transaction log (usage, topup, adjustment, rollover)

### 3.6 Overage Handling

When a deal's limits or credits are exhausted:

| Policy         | Behavior                                                              | User Experience                               |
| -------------- | --------------------------------------------------------------------- | --------------------------------------------- |
| `hard_stop`    | Reject requests. Return HTTP 429 `QUOTA_EXCEEDED`                     | Agent stops responding, user sees quota error |
| `soft_cap`     | Alert at thresholds, continue serving. Log overage for billing        | Seamless for users; billing contact notified  |
| `auto_upgrade` | Apply next-tier limits automatically. Flag for billing reconciliation | Seamless; auto-invoiced at period end         |

Alert delivery for all policies:

- Webhook POST to configured URL
- Email to billing contact
- Platform Ops dashboard notification
- Alert at configured thresholds (e.g., 75%, 90%, 100%)

### 3.7 Self-Serve Upgrades & Credit Top-ups

| Action          | Available To   | Mechanism                                                  |
| --------------- | -------------- | ---------------------------------------------------------- |
| FREE → TEAM     | FREE tier orgs | Stripe Checkout                                            |
| TEAM → BUSINESS | TEAM tier orgs | Stripe Checkout                                            |
| → ENTERPRISE    | Any            | "Contact Sales" → offline deal via HubSpot                 |
| Credit top-up   | All tiers      | Stripe Checkout → creates `credit_topup` billing line item |
| Feature add-on  | TEAM/BUSINESS  | One-off purchase → `addon` billing line item               |

### 3.8 Billing Line Items

Every billable event creates a `BillingLineItem` linked to the deal:

| Category       | Trigger                    | Example                                   |
| -------------- | -------------------------- | ----------------------------------------- |
| `base`         | Monthly/annual base charge | "Enterprise Base — March 2026"            |
| `overage`      | Usage beyond deal limits   | "Token Overage — 2.1M tokens @ $0.002/1K" |
| `addon`        | One-off feature purchase   | "SSO Add-on"                              |
| `credit_topup` | Credit purchase            | "10,000 Credit Top-up"                    |

Line items accumulate until invoiced. The `invoiced` flag + `invoiceId` track reconciliation.

### 3.9 Feature Catalog

Features are gatable capabilities unlocked by deals or plan tiers:

```
sso, mfa, custom_domains, priority_support, analytics,
archiving, data_residency, custom_models, audit_export,
guardrails, kms_byok, api_access, voice_channels,
multi_environment, white_labeling
```

Features from all active deals are union-merged: if any deal unlocks a feature, it's enabled for the org.

---

## 4. HubSpot Integration

### 4.1 Overview

HubSpot serves as the system of record for commercial deal lifecycle. The platform reads deal data from HubSpot but never writes back — maintaining a clean one-way data flow.

```
┌───────────────┐         ┌──────────────────────┐
│   HubSpot     │────────▶│   ABL Platform       │
│   (CRM)       │  READ   │                      │
│               │  ONLY   │  Deal model updated   │
│  Deal stages  │         │  Limits recalculated   │
│  Contact info │         │  Features toggled      │
│  Custom props │         │                       │
└───────────────┘         └──────────────────────┘
```

**Sync direction:** HubSpot → Platform (one-way read)
**No platform data is pushed back to HubSpot.**

### 4.2 Sync Mechanisms

#### 4.2.1 Webhook Listener (Real-time)

**Endpoint:** `POST /api/platform/admin/hubspot/webhook`

HubSpot sends webhook events when deals or contacts change. The platform processes:

| HubSpot Event              | Platform Action                                         |
| -------------------------- | ------------------------------------------------------- |
| `deal.stage.changed`       | Update `Deal.status` based on stage mapping             |
| `deal.property.changed`    | Update deal name, amount, close date, custom properties |
| `deal.deleted`             | Set `Deal.status = 'canceled'`                          |
| `contact.property.changed` | Update linked billing contact info                      |

**Webhook Security:**

- HubSpot webhook signature verification (HMAC-SHA256)
- Request body hash validation
- IP allowlist for HubSpot's webhook IPs
- Idempotency: deduplicate by `hubspotDealId` + event timestamp

**Processing:**

```
Webhook received
    ↓
Verify HMAC signature
    ↓
Parse event payload
    ↓
Find Deal by hubspotDealId
    ↓
If not found: log warning, skip (deal not linked yet)
    ↓
Apply field updates
    ↓
Recalculate resolved limits for affected org
    ↓
Invalidate Redis cache for org/tenant limits
    ↓
Emit audit event: 'hubspot:deal-synced'
```

#### 4.2.2 Periodic Sync (Backup)

**Schedule:** Every 15 minutes via cron job

Polls HubSpot API for deals modified since last sync timestamp. This catches events that webhooks may miss (network issues, HubSpot downtime, etc.).

```
Cron fires (every 15 min)
    ↓
Fetch deals modified since lastSyncTimestamp from HubSpot API
    ↓
For each modified deal:
    ↓
  Find linked Deal document by hubspotDealId
    ↓
  Compare and apply field changes
    ↓
  Emit audit event if changed
    ↓
Update lastSyncTimestamp
```

**Pagination:** HubSpot API returns 100 results per page. The sync job handles pagination automatically.

**Rate Limiting:** HubSpot API limits (100 requests per 10 seconds for private apps). The sync job uses exponential backoff.

#### 4.2.3 Manual Sync (On-demand)

**Endpoint:** `POST /api/platform/admin/hubspot/sync`

Platform ops can trigger a manual sync for a specific deal or all deals. Used after linking a new deal or investigating sync issues.

### 4.3 Field Mapping

| HubSpot Field                  | Platform Field               | Notes                                    |
| ------------------------------ | ---------------------------- | ---------------------------------------- |
| `dealname`                     | `Deal.name`                  | Direct mapping                           |
| `amount`                       | Informational (not billing)  | HubSpot amount is reference only         |
| `dealstage`                    | `Deal.status`                | Mapped via configurable stage→status map |
| `closedate`                    | `Deal.contractEndDate`       | Close date = contract end                |
| `hs_deal_stage_probability`    | Informational                | Track in deal metadata                   |
| `associated_contacts[0].email` | Org billing contact          | First associated contact                 |
| Custom: `abl_plan_tier`        | `Deal.phases[].environments` | Custom HubSpot property for plan details |
| Custom: `abl_credit_allotment` | `Deal.creditAllotment`       | JSON in custom property                  |
| Custom: `abl_features`         | `Deal.features[]`            | Comma-separated feature keys             |

### 4.4 Deal Stage → Status Mapping

Configurable mapping stored in platform config:

```typescript
const HUBSPOT_STAGE_MAP: Record<string, Deal['status']> = {
  appointmentscheduled: 'active', // Discovery stage → active
  qualifiedtobuy: 'active', // Qualified → active
  presentationscheduled: 'active', // Presentation → active
  decisionmakerboughtin: 'active', // Decision → active
  contractsent: 'active', // Contract out → active
  closedwon: 'active', // Closed Won → active
  closedlost: 'canceled', // Closed Lost → canceled
};
```

Admins can customize this mapping per HubSpot pipeline.

### 4.5 HubSpot Configuration

Stored encrypted in platform config (not per-tenant — platform-level):

```typescript
interface HubSpotConfig {
  enabled: boolean;
  privateAppToken: string; // Encrypted — HubSpot private app access token
  webhookSecret: string; // Encrypted — For signature verification
  portalId: string; // HubSpot portal/account ID
  pipelineId?: string; // Specific deal pipeline to sync (optional)
  stageMapping: Record<string, string>; // Stage → status mapping
  syncIntervalMinutes: number; // Periodic sync interval (default: 15)
  customProperties: string[]; // Additional HubSpot properties to sync
  lastSyncTimestamp?: Date; // Last successful sync time
}
```

### 4.6 UI Actions

The Platform Ops Deal Management UI provides:

| Action                   | Description                                                               |
| ------------------------ | ------------------------------------------------------------------------- |
| **Link HubSpot Deal**    | Enter HubSpot deal ID → platform fetches metadata → populates deal fields |
| **Unlink Deal**          | Remove `hubspotDealId` — deal becomes manually managed                    |
| **Refresh from HubSpot** | Pull latest data for a specific deal immediately                          |
| **View in HubSpot**      | External link to HubSpot deal record                                      |
| **Sync Status**          | Show last sync time, sync status, next scheduled sync                     |

### 4.7 Error Handling

| Scenario                   | Handling                                    |
| -------------------------- | ------------------------------------------- |
| HubSpot API timeout        | Retry with exponential backoff (3 attempts) |
| Invalid webhook signature  | Reject with 401, log security event         |
| Deal not found in platform | Log warning, skip (deal not linked)         |
| HubSpot API rate limit     | Back off, retry on next sync cycle          |
| Conflicting updates        | HubSpot wins (it's the system of record)    |
| HubSpot downtime           | Periodic sync catches up when API recovers  |

### 4.8 Implementation Phases

| Phase       | Scope                                                        | Priority        |
| ----------- | ------------------------------------------------------------ | --------------- |
| **Phase A** | Deal model `hubspotDealId` field + manual link/unlink in UI  | **Implemented** |
| **Phase B** | Webhook listener with signature verification + field mapping | Next            |
| **Phase C** | Periodic sync cron job + rate limiting + pagination          | After B         |
| **Phase D** | Custom property sync + stage mapping configuration UI        | After C         |
| **Phase E** | Sync health monitoring + alerting on sync failures           | After D         |

---

## 5. Platform Ops Admin

### 5.1 Overview

The Platform Ops Admin (`apps/admin/`, port 3003) is an internal tool for Kore.ai engineers to manage the multi-tenant platform. It requires IP allowlist authentication + super-admin role.

### 5.2 Page Inventory

#### Existing Pages (4)

| Page              | Path       | Description                                                     |
| ----------------- | ---------- | --------------------------------------------------------------- |
| **Dashboard**     | `/`        | Platform summary — tenant count, active sessions, system health |
| **Configuration** | `/config`  | Runtime configuration management                                |
| **Secrets**       | `/secrets` | Secret rotation and management                                  |
| **Audit Log**     | `/audit`   | Platform-wide audit trail (ClickHouse)                          |

#### New Pages (6)

##### 5.2.1 Tenant Management (`/tenants`)

**List View:**

- DataTable with columns: name, slug, status badge (`active`/`suspended`/`archived`), plan tier badge (`FREE`/`TEAM`/`BUSINESS`/`ENTERPRISE`), owner email, org name, member count, created date
- Filters: status, plan tier, search by name/slug
- Pagination: 50 per page, configurable 1–100
- Click row → tenant detail

**Detail View (`/tenants/[id]`):**

- Header: Tenant name, status badge, quick actions (Suspend / Activate / Archive)
- Tabs:
  - **Overview**: Plan tier, resolved limits summary, LLM policy, retention settings, org info
  - **Members**: Member list with roles (read-only view)
  - **Projects**: Project list with agent count, deployment status per project
  - **Deals**: Deal management for this tenant's org (full deal CRUD — see Section 5.2.5)
  - **Usage**: Embedded usage summary (ClickHouse data)
  - **Config Overrides**: Per-tenant/per-project limit overrides

**APIs:**

- `GET /api/platform/admin/tenants` — List with aggregates (subscription plan, member count)
- `GET /api/platform/admin/tenants/:id` — Detail with org, subscription, deals
- `PATCH /api/platform/admin/tenants/:id/status` — Status transitions with audit log
- `GET /api/platform/admin/tenants/:id/members` — Member list with user details
- `GET /api/platform/admin/tenants/:id/projects` — Project list with agent counts

##### 5.2.2 Config Overrides (`/config-overrides`)

- **Left Panel**: Plan defaults for all 4 tiers (FREE/TEAM/BUSINESS/ENTERPRISE) displayed side-by-side
- **Right Panel**: Tenant selector → resolved config with override highlights
- Visual diff: green for overridden values, grey for defaults
- Edit per section with validation against `VALID_LIMIT_KEYS`
- ConfirmDialog for all mutations
- Recent changes audit trail at bottom

**APIs:**

- `GET /api/platform/admin/tenant-config/plans` — All plan defaults
- `GET /api/platform/admin/tenant-config/:tenantId` — Resolved config + overrides
- `PUT /api/platform/admin/tenant-config/:tenantId/overrides` — Set tenant-level overrides
- `DELETE /api/platform/admin/tenant-config/:tenantId/overrides` — Clear tenant overrides
- `PUT /api/platform/admin/tenant-config/:tenantId/projects/:projectId/overrides` — Project-level overrides
- `DELETE /api/platform/admin/tenant-config/:tenantId/projects/:projectId/overrides` — Clear project overrides

##### 5.2.3 Model Provisioning (`/models`)

**List View:**

- DataTable: display name, provider icon, model ID, tier badge, status (`active`/`revoked`), target tenant, connections count, capability badges (text, tools, streaming, vision, voice)
- Filters: provider, tier, status, tenant search
- "Provision Model" button

**Provision Wizard (3-step dialog):**

1. Select integration type (`Easy`/`API`) + provider + model
2. Configure: display name, temperature, maxTokens, capabilities
3. Add initial connection (API key, auth type)

**Model Detail (`/models/[id]`):**

- Settings form (editable)
- Connections table with Validate / Delete actions
- "Revoke Model" destructive action with ConfirmDialog

**APIs:**

- `GET /api/platform/admin/tenant-models` — List models (filter by `targetTenantId`)
- `POST /api/platform/admin/tenant-models` — Provision model with optional initial connection
- `GET /api/platform/admin/tenant-models/:id` — Model detail with connections
- `PATCH /api/platform/admin/tenant-models/:id` — Update model properties
- `POST /api/platform/admin/tenant-models/:id/connections` — Add connection (encrypts API key)
- `POST /api/platform/admin/tenant-models/:id/connections/:connId/validate` — Test inference
- `POST /api/platform/admin/tenant-models/:id/revoke` — Soft-revoke (sets `isActive=false`)

##### 5.2.4 System Health (`/health`)

- **Top Row MetricCards**: Total Tenants, Active Sessions, Open Circuit Breakers, Error Rate (24h)
- **Service Status Grid**:
  - Core: MongoDB, Redis, ClickHouse
  - Runtime: NLU Sidecar, SearchAI, KMS
  - External: LLM Providers (aggregate), Voice Services (aggregate)
- Each service shows: StatusBadge, latency (ms), last check time
- Auto-refresh every 30 seconds

**API:** `GET /api/platform/admin/system-health` — Aggregated health from all services

##### 5.2.5 Resilience Controls (`/resilience`)

- Backend indicator badge (Redis-backed or in-memory)
- Circuit breaker DataTable: name, state (color-coded: green=CLOSED, yellow=HALF_OPEN, red=OPEN), failure count, last failure timestamp
- State filter + search
- Per-breaker "Reset" button with ConfirmDialog
- Tenant health section: tenant search → health breakdown by level → "Force Reset All" button

**APIs:**

- `GET /api/platform/admin/resilience/circuit-breakers` — All breaker states
- `GET /api/platform/admin/resilience/tenants/:tenantId/health` — Per-tenant health
- `POST /api/platform/admin/resilience/circuit-breakers/:name/reset` — Force reset
- `POST /api/platform/admin/resilience/tenants/:tenantId/reset-all` — Reset all for tenant

##### 5.2.6 Usage & Analytics (`/usage`)

- Date range selector (7d / 30d / 90d / custom)
- Platform totals: total tokens, total cost, total sessions, active tenants
- Top tenants DataTable sorted by cost
- Provider breakdown PieChart
- Daily trend AreaChart
- Model breakdown DataTable

**API:** `GET /api/platform/admin/usage-summary` — Cross-tenant aggregation from ClickHouse

### 5.3 Deal Management (within Tenant Detail)

The Deals tab on the tenant detail page provides full deal CRUD:

**Deal List:**

- DataTable: name, status, scope, aggregation mode, active phase, renewal date, HubSpot linked indicator
- "Create Deal" button
- Filter by status

**Deal Detail (slide-over or sub-page):**

- **Header**: Deal name, status, HubSpot badge with "View in HubSpot" link
- **Phases timeline**: Visual timeline showing phase progression with current phase highlighted
- **Current Phase Limits**: Per-environment limit grid (dev/staging/production)
- **Credit Balance**: Progress bar (consumed/allocated), per-feature breakdown
- **Billing Line Items**: DataTable with period, description, amount, category, invoiced status
- **Actions**: Edit Deal, Pause/Resume, Link/Unlink HubSpot, Add Credits, Create Line Item

**APIs:**

- `GET /api/platform/admin/deals` — List (filter by org, status, scope)
- `POST /api/platform/admin/deals` — Create deal
- `GET /api/platform/admin/deals/:id` — Detail
- `PATCH /api/platform/admin/deals/:id` — Update
- `POST /api/platform/admin/deals/:id/assign` — Assign to org/project
- `GET /api/platform/admin/deals/:id/credits` — Credit ledger for current period
- `POST /api/platform/admin/deals/:id/credits/topup` — Add credits (creates billing line item)
- `GET /api/platform/admin/deals/:id/line-items` — Billing line items (paginated)
- `POST /api/platform/admin/deals/:id/line-items` — Create line item

### 5.4 Sidebar Navigation

```
OVERVIEW
  Dashboard

TENANTS
  Tenant Management
  Config Overrides
  Model Provisioning

OPERATIONS
  System Health
  Resilience Controls

OBSERVABILITY
  Usage & Analytics
  Audit Log

INFRASTRUCTURE
  Configuration
  Secrets
```

---

## 6. Workspace Admin

### 6.1 Overview

Workspace Admin is embedded inside Studio (`apps/studio/`, port 5173) under the `/admin/*` path. It's accessible to tenant admins (OWNER or ADMIN role) for managing their workspace.

### 6.2 Page Inventory

#### Existing Pages (7)

| Page                | Path              | Description                            |
| ------------------- | ----------------- | -------------------------------------- |
| **Members**         | `/admin/members`  | Invite, manage roles, remove members   |
| **LLM Providers**   | `/admin/models`   | Configure LLM models and connections   |
| **Arch Settings**   | `/admin/arch`     | Arch AI assistant configuration        |
| **Voice Services**  | `/admin/voice`    | Voice provider configuration           |
| **Security**        | `/admin/security` | SSO, MFA, IP restrictions              |
| **Secrets**         | `/admin/secrets`  | Secret management for the workspace    |
| **Usage & Billing** | `/admin/billing`  | Current usage metrics and plan details |

#### New Pages (7)

##### 6.2.1 KMS Management (`/admin/kms`)

4 tabs:

- **Configuration**: KMS provider, encryption tier, compliance level, failure policy. Edit form for all `kms-admin` config fields. Per-environment and per-project overrides.
- **Encryption Keys**: DataTable of data encryption keys (DEKs) — key ID, status (`active`/`decrypt-only`/`expired`), project, environment, created date. "Rotate Keys" button with project/environment/reason filter.
- **Health**: KMS provider health card, DEK counts, provider latency. "Validate Endpoint" action.
- **Audit**: KMS-specific audit log from ClickHouse. Date range filter, pagination.

##### 6.2.2 Environment Variables (`/admin/env-vars`)

- Project selector dropdown
- DataTable: key, environment tabs (dev/staging/prod), encrypted badge, last updated
- "Add Variable" dialog with key validation
- Bulk import: paste `key=value` pairs
- Reference display: which agents use `{{env.KEY}}`

##### 6.2.3 Guardrails (`/admin/guardrails`)

**Guardrail Providers (org-level):**

- Card per provider: name, adapter type, endpoint, active/inactive toggle
- "Add Provider" dialog with circuit breaker and retry configuration
- Health status per provider

**Guardrail Policies (project-scoped):**

- Project selector dropdown
- Policy list: name, mode (`monitor`/`enforce`), rules count, provider
- "Create Policy" dialog with rule editor, constitution principles, budget controls

##### 6.2.4 Connectors & Channels (`/admin/connectors`)

**Channel Connections tab:**

- Cards per type: Slack, MS Teams, Email, Jambonz Voice, Custom
- Configure dialog with credentials, webhook URLs, deployment scoping
- Status indicators and webhook verification

**SDK Channels tab:**

- DataTable: name, type (`web`/`mobile`/`voice`/`api`), environment, API key (masked), deployment
- Create / edit / delete channels

##### 6.2.5 Agent Performance (`/admin/analytics/agents`)

- Project selector
- Agent grid: name, call count, error rate, avg latency, containment rate, cost
- Agent detail: time-series charts (latency, error rate, volume), tool breakdown
- Comparison mode: select 2 agents for side-by-side comparison

##### 6.2.6 Session Explorer (`/admin/analytics/sessions`)

- Project + date range selector
- Session list: ID, start time, duration, status, agent path, cost, message count
- Filters: status, agent, date range, duration, has-error toggle
- Session detail: conversation timeline (messages, tool calls, handoffs, decisions)
- Summary metrics: completion rate, avg duration, avg cost

##### 6.2.7 Trace Viewer (`/admin/analytics/traces`)

- Project + date range selector
- Event stream with category filters (LLM call, tool call, decision, error, handoff)
- Search by session ID, agent name, event type, error text
- Event detail panel: full payload, timing, parent span
- Error-first view toggle
- Ad-hoc SQL query interface for advanced users

### 6.3 Enhanced Billing Page (`/admin/billing`)

The existing billing page gains these sections:

| Section                 | Description                                                        |
| ----------------------- | ------------------------------------------------------------------ |
| **Active Deals**        | Current deals with phase indicator, renewal date, scope            |
| **Credit Balance**      | Total/consumed/remaining progress bar, per-feature breakdown chart |
| **Usage vs Limits**     | Progress bars per limit type with deal source indication           |
| **Contact Sales**       | Button for Enterprise upgrade (no self-serve for Enterprise)       |
| **Self-Serve Upgrade**  | Plan upgrade for FREE → TEAM, TEAM → BUSINESS (Stripe Checkout)    |
| **Credit Top-up**       | Purchase additional credits (Stripe Checkout, all tiers)           |
| **Alert Configuration** | Threshold percentages for credit/limit warnings                    |
| **Invoice History**     | Billing line items grouped by period                               |

**APIs:**

- `GET /api/tenants/:tenantId/deals` — Deals for the tenant's org
- `GET /api/tenants/:tenantId/credits` — Credit balance and usage
- `POST /api/tenants/:tenantId/upgrade` — Self-serve plan upgrade (FREE/TEAM/BUSINESS only)
- `POST /api/tenants/:tenantId/credits/topup` — Purchase credits
- `GET /api/tenants/:tenantId/features` — Resolved feature flags

### 6.4 Sidebar Navigation

```
WORKSPACE ADMIN
  Members
  LLM Providers
  Arch Settings
  Voice Services
  Security
  Secrets

CONFIGURATION
  Environment Variables (NEW)
  Guardrails (NEW)
  Connectors & Channels (NEW)

ANALYTICS
  Agent Performance (NEW)
  Session Explorer (NEW)
  Trace Viewer (NEW)

OPERATIONS
  KMS Management (NEW)

BILLING
  Usage & Billing (enhanced)
```

---

## 7. API Reference

### 7.1 Platform Ops APIs

#### Tenant Management

| Method | Path                                       | Purpose                      | Auth           |
| ------ | ------------------------------------------ | ---------------------------- | -------------- |
| GET    | `/api/platform/admin/tenants`              | List tenants with aggregates | Platform Admin |
| GET    | `/api/platform/admin/tenants/:id`          | Tenant detail                | Platform Admin |
| PATCH  | `/api/platform/admin/tenants/:id/status`   | Change status                | Platform Admin |
| GET    | `/api/platform/admin/tenants/:id/members`  | List members                 | Platform Admin |
| GET    | `/api/platform/admin/tenants/:id/projects` | List projects                | Platform Admin |

#### Deal Management

| Method | Path                                          | Purpose               | Auth           |
| ------ | --------------------------------------------- | --------------------- | -------------- |
| GET    | `/api/platform/admin/deals`                   | List deals            | Platform Admin |
| POST   | `/api/platform/admin/deals`                   | Create deal           | Platform Admin |
| GET    | `/api/platform/admin/deals/:id`               | Deal detail           | Platform Admin |
| PATCH  | `/api/platform/admin/deals/:id`               | Update deal           | Platform Admin |
| POST   | `/api/platform/admin/deals/:id/assign`        | Assign to org/project | Platform Admin |
| GET    | `/api/platform/admin/deals/:id/credits`       | Credit ledger         | Platform Admin |
| POST   | `/api/platform/admin/deals/:id/credits/topup` | Add credits           | Platform Admin |
| GET    | `/api/platform/admin/deals/:id/line-items`    | Billing line items    | Platform Admin |
| POST   | `/api/platform/admin/deals/:id/line-items`    | Create line item      | Platform Admin |

#### Config Overrides

| Method | Path                                                                        | Purpose                     | Auth           |
| ------ | --------------------------------------------------------------------------- | --------------------------- | -------------- |
| GET    | `/api/platform/admin/tenant-config/plans`                                   | All plan defaults           | Platform Admin |
| GET    | `/api/platform/admin/tenant-config`                                         | List tenants with overrides | Platform Admin |
| GET    | `/api/platform/admin/tenant-config/:tenantId`                               | Resolved config             | Platform Admin |
| PUT    | `/api/platform/admin/tenant-config/:tenantId/overrides`                     | Set tenant overrides        | Platform Admin |
| DELETE | `/api/platform/admin/tenant-config/:tenantId/overrides`                     | Clear tenant overrides      | Platform Admin |
| PUT    | `/api/platform/admin/tenant-config/:tenantId/projects/:projectId/overrides` | Set project overrides       | Platform Admin |
| DELETE | `/api/platform/admin/tenant-config/:tenantId/projects/:projectId/overrides` | Clear project overrides     | Platform Admin |

#### Model Provisioning

| Method | Path                                                                 | Purpose             | Auth           |
| ------ | -------------------------------------------------------------------- | ------------------- | -------------- |
| GET    | `/api/platform/admin/tenant-models`                                  | List models         | Platform Admin |
| POST   | `/api/platform/admin/tenant-models`                                  | Provision model     | Platform Admin |
| GET    | `/api/platform/admin/tenant-models/:id`                              | Model detail        | Platform Admin |
| PATCH  | `/api/platform/admin/tenant-models/:id`                              | Update model        | Platform Admin |
| POST   | `/api/platform/admin/tenant-models/:id/connections`                  | Add connection      | Platform Admin |
| PATCH  | `/api/platform/admin/tenant-models/:id/connections/:connId`          | Update connection   | Platform Admin |
| DELETE | `/api/platform/admin/tenant-models/:id/connections/:connId`          | Remove connection   | Platform Admin |
| POST   | `/api/platform/admin/tenant-models/:id/revoke`                       | Revoke model        | Platform Admin |
| POST   | `/api/platform/admin/tenant-models/:id/connections/:connId/validate` | Validate connection | Platform Admin |

#### Resilience

| Method | Path                                                          | Purpose              | Auth           |
| ------ | ------------------------------------------------------------- | -------------------- | -------------- |
| GET    | `/api/platform/admin/resilience/circuit-breakers`             | All breaker states   | Platform Admin |
| GET    | `/api/platform/admin/resilience/tenants/:tenantId/health`     | Tenant health        | Platform Admin |
| POST   | `/api/platform/admin/resilience/circuit-breakers/:name/reset` | Reset breaker        | Platform Admin |
| POST   | `/api/platform/admin/resilience/tenants/:tenantId/reset-all`  | Reset all for tenant | Platform Admin |

#### HubSpot

| Method | Path                                  | Purpose             | Auth           |
| ------ | ------------------------------------- | ------------------- | -------------- |
| POST   | `/api/platform/admin/hubspot/webhook` | Webhook receiver    | HMAC signature |
| POST   | `/api/platform/admin/hubspot/sync`    | Manual sync trigger | Platform Admin |

#### System

| Method | Path                                   | Purpose                         | Auth           |
| ------ | -------------------------------------- | ------------------------------- | -------------- |
| GET    | `/api/platform/admin/system-health`    | Service health aggregation      | Platform Admin |
| GET    | `/api/platform/admin/usage-summary`    | Cross-tenant usage (ClickHouse) | Platform Admin |
| GET    | `/api/platform/admin/billing/overview` | Revenue summary                 | Platform Admin |
| GET    | `/api/platform/admin/features/catalog` | All gatable features            | Platform Admin |

### 7.2 Workspace APIs

| Method | Path                                   | Purpose                      | Auth              |
| ------ | -------------------------------------- | ---------------------------- | ----------------- |
| GET    | `/api/tenants/:tenantId/usage`         | Usage analytics (ClickHouse) | `credential:read` |
| GET    | `/api/tenants/:tenantId/deals`         | Deals for tenant's org       | OWNER/ADMIN       |
| GET    | `/api/tenants/:tenantId/credits`       | Credit balance/usage         | OWNER/ADMIN       |
| POST   | `/api/tenants/:tenantId/upgrade`       | Self-serve upgrade           | OWNER             |
| POST   | `/api/tenants/:tenantId/credits/topup` | Purchase credits             | OWNER             |
| GET    | `/api/tenants/:tenantId/features`      | Resolved feature flags       | OWNER/ADMIN       |

---

## 8. Data Models

### 8.1 MongoDB Collections Summary

| Collection           | Model             | Purpose                                                        | Key Indexes                                                          |
| -------------------- | ----------------- | -------------------------------------------------------------- | -------------------------------------------------------------------- |
| `organizations`      | `Organization`    | Top-level entity, SSO, domains, encrypted billing config       | `slug` (unique), `ownerId`, `domainMappings.domain` (unique, sparse) |
| `tenants`            | `Tenant`          | Workspace with LLM policy, settings, status                    | `slug` (unique), `organizationId`, `ownerId`, `status`               |
| `subscriptions`      | `Subscription`    | Plan tier, quotas, entitlements, Stripe IDs                    | `organizationId`, `tenantId`, `status`, `planTier`                   |
| `deals`              | `Deal`            | Commercial deals with phases, limits, credits, HubSpot linkage | `{organizationId, status}`, `hubspotDealId` (unique, sparse)         |
| `credit_ledgers`     | `CreditLedger`    | Per-period credit tracking, transaction log                    | `{dealId, periodStart}` (unique), `{organizationId, periodStart}`    |
| `billing_line_items` | `BillingLineItem` | Invoice line items (base/overage/addon/credit_topup)           | `{dealId, periodLabel}`                                              |
| `usage_periods`      | `UsagePeriod`     | Aggregated billing-period metrics                              | `{subscriptionId, periodLabel}` (unique), `invoiced`                 |
| `llm_usage_metrics`  | `LLMUsageMetric`  | Per-call LLM metrics (tokens, cost, latency)                   | `{tenantId, createdAt}`, `sessionId`, `{tenantId, provider, model}`  |

### 8.2 ClickHouse Tables

| Table             | Purpose                                     | Key Columns                                                                                                                                           |
| ----------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform_events` | Unified analytics sink for all trace events | `tenant_id`, `project_id`, `session_id`, `event_type`, `agent_name`, `timestamp`, `duration_ms`, `has_error`, `data`, `metadata`, `custom_dimensions` |

The `platform_events` table is the modern analytics store. The `custom_dimensions Map(String, String)` column (see separate Custom Metadata Propagation design) enables indexed queries on business metadata.

### 8.3 Entity Relationships

```
Organization (1)
  ├── Tenant (many)
  │     ├── TenantMember (many)
  │     ├── Project (many)
  │     │     ├── ProjectAgent (many)
  │     │     ├── ProjectTool (many)
  │     │     └── Deployment (many)
  │     └── LLMUsageMetric (many)
  │
  ├── Subscription (1)
  │     ├── TenantQuota (many)
  │     │     └── ProjectQuota (many)
  │     └── UsagePeriod (many)
  │
  └── Deal (many)
        ├── CreditLedger (many — one per period)
        └── BillingLineItem (many)
```

---

## 9. Security & Compliance

### 9.1 Authentication

| Surface            | Auth Method                 | Additional                                            |
| ------------------ | --------------------------- | ----------------------------------------------------- |
| Platform Ops Admin | JWT token + IP allowlist    | `requirePlatformAdmin()` + `requirePlatformAdminIp()` |
| Workspace Admin    | JWT token                   | Tenant-scoped, role check (OWNER/ADMIN)               |
| HubSpot Webhook    | HMAC-SHA256 signature       | IP allowlist for HubSpot IPs                          |
| Self-serve billing | JWT token + Stripe Checkout | Server-side session creation                          |

### 9.2 Encryption

| Data                        | At Rest                                       | In Transit |
| --------------------------- | --------------------------------------------- | ---------- |
| Organization billing config | Field-level encryption (`encryptionPlugin`)   | TLS 1.3    |
| LLM API keys                | Tenant-scoped encryption (`encryptForTenant`) | TLS 1.3    |
| SSO config                  | Encrypted field (`encryptedConfig`)           | TLS 1.3    |
| HubSpot tokens              | Encrypted in platform config                  | TLS 1.3    |

API keys are **never returned in API responses** — they are sanitized before serialization.

### 9.3 Multi-Tenant Isolation

- All queries use `findOne({ _id, tenantId })` pattern — never `findById()`
- Cross-tenant access returns **404** (not 403) to prevent existence leaking
- `tenantIsolationPlugin` auto-applied to usage metrics
- Platform Admin operates outside tenant context (requires separate super-admin auth)

### 9.4 Audit Logging

Every mutation in admin surfaces creates an audit log entry:

```typescript
{
  userId: string;        // Who performed the action
  tenantId?: string;     // Affected tenant (if applicable)
  action: string;        // e.g., 'platform-admin:create-deal'
  metadata: {            // Action-specific details
    dealId?: string;
    changes?: Record<string, unknown>;
    // ...
  };
  requestId: string;     // Correlation ID
  timestamp: Date;
}
```

Audit log is queryable via ClickHouse (`/api/audit` route) with date range, action type, and user filters.

### 9.5 Rate Limiting

All admin routes are rate-limited via `tenantRateLimit('request')`. Platform Admin routes have separate rate limits from workspace routes.

---

## 10. Implementation Roadmap

### Phase 1: Foundation + Platform Ops Core

**Goal:** Shared UI library + core platform admin pages

- Create `packages/admin-ui/` with shadcn/ui components (DataTable, MetricCard, StatusBadge, FilterBar, PageHeader, ConfirmDialog, EmptyState, Skeleton, Tabs, charts)
- Migrate existing 4 `apps/admin/` pages to shared components
- Build new Platform Ops pages:
  - Tenant Management (list + detail with tabs)
  - Config Overrides (plan defaults + tenant overrides)
  - Model Provisioning (list + provision wizard + detail)
  - Resilience Controls (circuit breakers + tenant health)
- New APIs: tenant list/detail/status, system health

**Depends on:** Nothing (can start immediately)

### Phase 2: Billing Infrastructure

**Goal:** Deal-based billing model operational

- Deal CRUD APIs (implemented — `platform-admin-deals.ts`)
- Credit ledger management (implemented)
- Billing line item management (implemented)
- HubSpot integration Phase A+B (webhook listener + field mapping)
- Credit tracking in runtime (intercept LLM usage events → debit credits)
- Updated limit resolution chain (deals → phases → environments → admin overrides → credit check)
- Platform Ops: Deal Management tab on tenant detail
- Overage enforcement (hard_stop: 429, soft_cap: alert, auto_upgrade: next tier)

**Depends on:** Phase 1 (shared UI for deal management UI)

### Phase 3: Workspace Admin — Configuration

**Goal:** Tenant admins can manage workspace configuration

- KMS Management (4 tabs: config, keys, health, audit)
- Environment Variables (project-scoped key/value management)
- Guardrails (providers + policies)
- Connectors & Channels (channel connections + SDK channels)
- Updated workspace admin sidebar navigation

**Depends on:** Phase 1 (shared UI components)

### Phase 4: Workspace Admin — Analytics

**Goal:** Tenant admins have full observability

- Agent Performance (grid + detail + comparison)
- Session Explorer (list + conversation timeline)
- Trace Viewer (event stream + SQL query)
- All consuming existing analytics ClickHouse endpoints

**Depends on:** Phase 1 (shared UI), existing analytics APIs

### Phase 5: Workspace Billing + Platform Health

**Goal:** Customer-facing billing + platform ops monitoring

- Enhanced Billing page (deals, credits, limits, alerts, invoices)
- Self-serve upgrade (FREE → TEAM → BUSINESS via Stripe)
- Credit top-up flow (Stripe Checkout)
- Platform Ops: System Health page
- Platform Ops: Usage & Analytics page (cross-tenant ClickHouse aggregation)
- HubSpot integration Phase C+D (periodic sync + custom properties + stage mapping config)

**Depends on:** Phase 2 (billing infrastructure), Phase 1 (shared UI)

### Phase 6: Polish & Integration

**Goal:** Production-ready, tested, integrated

- Feature gating enforcement across both UIs (disable UI sections based on resolved features)
- Alert delivery infrastructure (webhook + email for overage/threshold)
- HubSpot integration Phase E (sync health monitoring + alerting)
- Shared component refinements based on usage feedback
- E2E tests for critical flows (deal creation, credit consumption, upgrade, HubSpot sync)
- Studio gradual migration to shared components where applicable

**Depends on:** All previous phases

### Implementation Status

| Component                                                                                | Status      | Notes                                      |
| ---------------------------------------------------------------------------------------- | ----------- | ------------------------------------------ |
| MongoDB models (Deal, CreditLedger, BillingLineItem, Subscription, Organization, Tenant) | Implemented | All schemas and indexes in place           |
| Deal CRUD API (`platform-admin-deals.ts`)                                                | Implemented | Full CRUD + credits + line items           |
| Tenant management API (`platform-admin-tenants.ts`)                                      | Implemented | List, detail, status, members, projects    |
| Config override API (`platform-admin-config.ts`)                                         | Implemented | Plans, tenant/project overrides            |
| Model provisioning API (`platform-admin-models.ts`)                                      | Implemented | Provision, connections, validate, revoke   |
| Resilience API (`platform-admin-resilience.ts`)                                          | Implemented | Circuit breakers, tenant health, reset     |
| Usage analytics API (`tenant-usage.ts`)                                                  | Implemented | ClickHouse-backed tenant usage             |
| `packages/admin-ui/` shared components                                                   | Implemented | Core component set                         |
| Admin app pages                                                                          | Partially   | 4 existing pages, new pages not yet built  |
| HubSpot webhook listener                                                                 | Not started | Deal model has `hubspotDealId` field ready |
| HubSpot periodic sync                                                                    | Not started | —                                          |
| Credit tracking in runtime                                                               | Not started | —                                          |
| Limit resolution with deals                                                              | Not started | —                                          |
| Overage enforcement                                                                      | Not started | —                                          |
| Workspace admin new pages                                                                | Not started | —                                          |
| Self-serve upgrade (Stripe)                                                              | Not started | —                                          |
| Feature gating                                                                           | Not started | —                                          |

---

## Key Decisions

| Decision                | Choice                                  | Rationale                                                         |
| ----------------------- | --------------------------------------- | ----------------------------------------------------------------- |
| Two separate admin apps | Platform Ops + Workspace Admin          | Different users, auth models, security boundaries                 |
| Shared UI library       | `packages/admin-ui/` with shadcn/ui     | Consistency, reduced duplication, accessible primitives           |
| Data fetching           | SWR (replaces custom useFetch)          | Caching, revalidation, dedup — already used in Studio             |
| Billing model           | Deal-based with HubSpot                 | Supports multi-deal orgs, phases, per-env limits, credit hybrid   |
| Enterprise upgrade      | Contact Sales only                      | No self-serve for Enterprise — offline invoice, HubSpot deal flow |
| Self-serve              | FREE/TEAM/BUSINESS only                 | Stripe Checkout for plan upgrades and credit top-ups              |
| Aggregation             | Per-deal mode                           | Flexible for different commercial arrangements                    |
| Credits                 | Hybrid (shared pool + feature minimums) | Balances simplicity with per-feature guarantees                   |
| HubSpot sync direction  | One-way read (HubSpot → Platform)       | HubSpot is system of record for commercial terms                  |
| Overage alerting        | Webhook + email + dashboard             | Multi-channel ensures billing contacts are reached                |
