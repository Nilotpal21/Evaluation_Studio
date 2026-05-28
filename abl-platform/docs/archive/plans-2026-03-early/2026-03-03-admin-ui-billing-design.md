# Admin UI & Billing System Design

**Date:** 2026-03-03
**Status:** Approved
**Scope:** Two admin apps (Platform Ops + Workspace Admin), shared UI library, billing/subscription model with HubSpot integration

---

## 1. Overview

Two admin applications serve different user groups:

1. **Platform Ops Admin** (`apps/admin/`, port 3003) — Internal Kore.ai engineers managing the multi-tenant platform
2. **Workspace Admin** (inside `apps/studio/`, `/admin/*`) — Customer tenant admins managing their workspace

Both apps share a common UI component library (`packages/admin-ui/`) built on shadcn/ui + Tailwind.

The billing system introduces a Deal-based model with HubSpot integration, hybrid credits, per-environment limits, time-based phases, and multi-deal aggregation.

---

## 2. Shared UI Package

### Package: `packages/admin-ui/`

```
packages/admin-ui/
├── package.json              # @agent-platform/admin-ui
├── tsconfig.json
├── tailwind.config.ts        # Shared design tokens
├── src/
│   ├── index.ts              # Public exports
│   ├── tokens/
│   │   └── colors.css        # Shared HSL design tokens
│   ├── components/
│   │   ├── data-table.tsx    # Sortable, filterable, paginated table
│   │   ├── metric-card.tsx   # Stat card (value, label, trend, icon)
│   │   ├── status-badge.tsx  # Semantic status (healthy/degraded/down/unknown)
│   │   ├── filter-bar.tsx    # Composable filter row (search, select, date range)
│   │   ├── page-header.tsx   # Title + description + actions
│   │   ├── confirm-dialog.tsx# Destructive action confirmation
│   │   ├── empty-state.tsx   # No-data placeholder
│   │   ├── skeleton.tsx      # Loading placeholders
│   │   ├── tabs.tsx          # Radix Tabs wrapper
│   │   ├── chart/
│   │   │   ├── area-chart.tsx
│   │   │   ├── pie-chart.tsx
│   │   │   └── bar-chart.tsx
│   │   └── ui/               # shadcn/ui primitives
│   ├── hooks/
│   │   ├── use-api.ts        # SWR-based data fetching with auth
│   │   └── use-debounce.ts
│   └── lib/
│       ├── format.ts         # Number/date/byte formatting
│       └── cn.ts             # clsx + tailwind-merge
```

### Design Token Strategy

Both apps use HSL-based CSS variables. The shared package exports canonical tokens in `colors.css`. Each app imports and can override specific values. Both apps maintain dark themes.

### Data Fetching

SWR-based `useApi` hook replaces the custom `useFetch` in `apps/admin/`:

- Auth header injection from cookie/token
- 401 redirect to login
- Error normalization
- Automatic revalidation

---

## 3. Platform Ops Admin — Page Inventory

### Existing Pages (4)

| Page          | Path       | Status                                 |
| ------------- | ---------- | -------------------------------------- |
| Dashboard     | `/`        | Existing — enhanced with summary cards |
| Configuration | `/config`  | Existing                               |
| Secrets       | `/secrets` | Existing                               |
| Audit Log     | `/audit`   | Existing                               |

### New Pages (6)

#### 3.1 Tenant Management (`/tenants`)

**List view:**

- DataTable: tenant name, slug, status badge (active/suspended/archived), plan tier badge (FREE/TEAM/BUSINESS/ENTERPRISE), owner email, org name, member count, created date
- Filters: status, plan tier, search by name/slug
- Pagination (50 per page)

**Detail view (`/tenants/[id]`):**

- Header: tenant name, status, quick actions (suspend/activate/archive)
- Tabs:
  - **Overview**: Plan tier, limits summary, LLM policy, retention settings, org info
  - **Members**: Member list with roles (read-only)
  - **Projects**: Project list with agent count, deployment status
  - **Deals**: Deal management for this tenant's org (see Section 4)
  - **Usage**: Embedded usage summary
  - **Config Overrides**: Override management

**New API:** `GET /api/platform/admin/tenants` — list with aggregates from Tenant + Subscription + TenantMember models
**New API:** `GET /api/platform/admin/tenants/:id` — detail with org, subscription, deals
**New API:** `PATCH /api/platform/admin/tenants/:id/status` — status transitions + audit log

#### 3.2 Config Overrides (`/config-overrides`)

- Plan defaults panel (left): FREE/TEAM/BUSINESS/ENTERPRISE side-by-side
- Tenant override panel (right): select tenant, show resolved config with override highlights
- Visual diff: green for overridden values, grey for defaults
- Edit per section with validation against `VALID_LIMIT_KEYS`
- Confirm dialog for mutations
- Recent changes audit trail

**Data source:** Existing `platform-admin-config` routes

#### 3.3 Model Provisioning (`/models`)

**List view:**

- DataTable: display name, provider icon, model ID, tier badge, status (active/revoked), tenant, connections count, capabilities badges
- Filters: provider, tier, status, tenant search
- "Provision Model" button

**Provision wizard (3-step dialog):**

1. Integration type (Easy/API) + provider + model
2. Configure: display name, temperature, maxTokens, capabilities
3. Add initial connection (API key, auth type)

**Model detail (`/models/[id]`):**

- Settings form (editable)
- Connections table with validate/delete actions
- "Revoke Model" destructive action

**Data source:** Existing `platform-admin-models` routes

#### 3.4 System Health (`/health`)

- Top row metric cards: Total Tenants, Active Sessions, Open Circuit Breakers, Error Rate (24h)
- Service status grid:
  - Core: MongoDB, Redis, ClickHouse
  - Runtime: NLU Sidecar, SearchAI, KMS
  - External: LLM Providers (aggregate), Voice Services (aggregate)
- Each service: status badge, latency, last check time
- Auto-refresh every 30s

**New API:** `GET /api/platform/admin/system-health` — aggregates health from all services

#### 3.5 Resilience Controls (`/resilience`)

- Backend indicator badge (Redis/memory)
- Circuit breaker table: name, state (color-coded), failure count, last failure
- State filter, search
- Per-breaker "Reset" button with confirm dialog
- Tenant health section: tenant search, health breakdown by level, "Force Reset All" button

**Data source:** Existing `platform-admin-resilience` routes

#### 3.6 Usage & Analytics (`/usage`)

- Date range selector (7d/30d/90d/custom)
- Platform totals: tokens, cost, sessions, active tenants
- Top tenants table sorted by cost
- Provider breakdown pie chart
- Daily trend area chart
- Model breakdown table

**New API:** `GET /api/platform/admin/usage-summary` — cross-tenant aggregation from ClickHouse

### Updated Sidebar Navigation

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

## 4. Billing & Subscription Model

### 4.1 Current State

- 4 plan tiers: FREE, TEAM, BUSINESS, ENTERPRISE with hardcoded `PLAN_LIMITS`
- `Subscription` model with `planTier`, `externalBillingId`, `tenantQuotas[]` → `projectQuotas[]`
- `overageBehavior` and `burstAllowed` fields exist but are not enforced
- No HubSpot integration, no deal concept, no phase progression

### 4.2 New Data Models

#### Deal Collection

```typescript
interface IDeal {
  _id: string; // UUID v7
  organizationId: string;
  hubspotDealId?: string; // HubSpot deal ID
  hubspotContactId?: string; // HubSpot contact ID
  name: string; // "Acme Corp - Enterprise Q1 2026"
  status: 'active' | 'paused' | 'expired' | 'canceled';

  // Scope
  scope: 'organization' | 'project';
  projectId?: string; // Set when scope = 'project'

  // Aggregation
  aggregationMode: 'additive' | 'max_wins' | 'dedicated';

  // Phases
  phases: IDealPhase[];

  // Overage
  overagePolicy: 'hard_stop' | 'soft_cap' | 'auto_upgrade';
  overageAlertThresholds: number[]; // e.g., [75, 90, 100]

  // Credits
  creditAllotment: ICreditAllotment;

  // Features
  features: string[]; // Unlocked feature keys

  // Commercial
  renewalDate?: Date;
  contractEndDate?: Date;
  billingLineItems: IBillingLineItem[];

  createdAt: Date;
  updatedAt: Date;
}
```

#### Deal Phase

```typescript
interface IDealPhase {
  name: string; // "trial" | "ramp" | "full" | custom
  startDate: Date;
  endDate: Date;
  environments: {
    dev: ILimitSet;
    staging: ILimitSet;
    production: ILimitSet;
  };
  creditAllotment?: ICreditAllotment; // Phase-level override
  features?: string[]; // Progressive feature unlock
}
```

#### Limit Set

```typescript
interface ILimitSet {
  maxConcurrentSessions: number;
  requestsPerMinute: number;
  tokensPerMinute: number;
  toolCallsPerMinute: number;
  messagesPerMonth: number;
  maxAgentsPerProject: number;
  maxProjectsPerOrg: number;
  traceRetentionDays: number;
  sessionRetentionDays: number;
  maxServiceTimeoutMs: number;
  maxResponseBodyBytes: number;
  maxConcurrentServiceCalls: number;
  maxPendingTimers: number;
  maxEventTypesPerApp: number;
  auditLogRetentionDays: number;
  archiveRetentionDays: number;
}
```

#### Credit Allotment (Hybrid Model)

```typescript
interface ICreditAllotment {
  totalCredits: number; // Shared pool size
  featureMinimums: {
    // Guaranteed minimums per feature
    llm: number;
    voice: number;
    search: number;
    tools: number;
  };
  creditRates: {
    // Cost per unit in credits
    llm_token_1k: number;
    voice_minute: number;
    search_query: number;
    tool_call: number;
    session: number;
  };
  periodType: 'monthly' | 'annual' | 'phase';
}
```

#### Credit Ledger

```typescript
interface ICreditLedger {
  _id: string;
  dealId: string;
  organizationId: string;
  periodStart: Date;
  periodEnd: Date;
  totalAllocated: number;
  totalConsumed: number;
  featureUsage: {
    llm: { allocated: number; consumed: number };
    voice: { allocated: number; consumed: number };
    search: { allocated: number; consumed: number };
    tools: { allocated: number; consumed: number };
  };
  sharedPoolConsumed: number;
  entries: ICreditEntry[];
}

interface ICreditEntry {
  timestamp: Date;
  feature: 'llm' | 'voice' | 'search' | 'tools' | 'session';
  units: number;
  credits: number;
  source: 'minimum' | 'shared';
  projectId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}
```

#### Billing Line Item

```typescript
interface IBillingLineItem {
  _id: string;
  dealId: string;
  periodLabel: string; // "2026-03"
  description: string;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  category: 'base' | 'overage' | 'addon' | 'credit_topup';
  invoiced: boolean;
  invoiceId?: string;
  createdAt: Date;
}
```

#### Feature Catalog (Static Config)

```typescript
const FEATURE_CATALOG = [
  'sso',
  'mfa',
  'custom_domains',
  'priority_support',
  'analytics',
  'archiving',
  'data_residency',
  'custom_models',
  'audit_export',
  'guardrails',
  'kms_byok',
  'api_access',
  'voice_channels',
  'multi_environment',
  'white_labeling',
] as const;
```

### 4.3 Multi-Deal Aggregation

When an org has multiple deals, limits resolve by `aggregationMode`:

| Mode        | Behavior                      | Example                                       |
| ----------- | ----------------------------- | --------------------------------------------- |
| `additive`  | Sum limits across deals       | Deal A: 1000 RPM + Deal B: 500 RPM = 1500 RPM |
| `max_wins`  | Highest value per limit       | Deal A: 1000 RPM, Deal B: 2000 RPM = 2000 RPM |
| `dedicated` | Reserved for assigned project | Deal A's 1000 RPM is only for its project     |

- Features: union-merged (if any deal unlocks SSO, SSO is enabled)
- Credits: always additive (total pool = sum of all deal credit allotments)

### 4.4 Limit Resolution Chain

```
1. Plan defaults (PLAN_LIMITS[tier])
       ↓
2. Aggregate org-scoped deals (by aggregationMode per deal)
       ↓
3. Project-specific deal (scope=project, dedicated limits)
       ↓
4. Active phase (select by current date)
       ↓
5. Environment (dev/staging/prod)
       ↓
6. Admin overrides (platform admin manual overrides)
       ↓
7. Credit check (sufficient credits remaining?)
```

### 4.5 Overage Handling

| Policy         | Behavior                                                       |
| -------------- | -------------------------------------------------------------- |
| `hard_stop`    | Reject requests at limit. Return 429 `QUOTA_EXCEEDED`          |
| `soft_cap`     | Alert at thresholds, continue serving. Log overage for billing |
| `auto_upgrade` | Apply next-tier limits. Flag for billing reconciliation        |

Alert delivery: Webhook to configured URL + email to billing contact + platform ops dashboard notification.

### 4.6 Self-Serve Upgrades

- Available for: FREE → TEAM, TEAM → BUSINESS only
- Enterprise: "Contact Sales" (offline invoice, HubSpot deal management)
- Credit top-ups: Stripe Checkout session for all tiers
- Feature add-ons: One-off purchases create `addon` billing line items

### 4.7 HubSpot Integration

**Sync direction:** HubSpot → Platform (one-way read for deal data)

- **Webhook listener:** `POST /api/platform/admin/hubspot/webhook` receives deal stage changes, contact updates
- **Periodic sync:** Cron job polls HubSpot API every 15 minutes
- **Fields synced:** Deal name, amount, stage, close date, contact name/email, custom properties
- **UI actions:** "Link HubSpot Deal" (enter ID, pull metadata), "Unlink Deal", "Refresh from HubSpot", view deal in HubSpot

---

## 5. Workspace Admin — Page Inventory

### Existing Pages (7)

| Page            | Path              | Status              |
| --------------- | ----------------- | ------------------- |
| Members         | `/admin/members`  | Existing            |
| LLM Providers   | `/admin/models`   | Existing            |
| Arch Settings   | `/admin/arch`     | Existing            |
| Voice Services  | `/admin/voice`    | Existing            |
| Security        | `/admin/security` | Existing            |
| Secrets         | `/admin/secrets`  | Existing            |
| Usage & Billing | `/admin/billing`  | Existing — enhanced |

### New Pages (7)

#### 5.1 KMS Management (`/admin/kms`)

**Tabs:**

- **Configuration**: KMS provider, encryption tier, compliance level, failure policy. Edit form for all `kms-admin` config fields. Per-environment and per-project overrides.
- **Encryption Keys**: DataTable of DEKs — key ID, status (active/decrypt-only/expired), project, environment, created date. "Rotate Keys" button with project/environment/reason filter.
- **Health**: KMS provider health card, DEK counts, provider latency. "Validate Endpoint" action.
- **Audit**: KMS-specific audit log from ClickHouse. Date range filter, pagination.

**Data source:** All 7 existing `kms-admin` endpoints

#### 5.2 Environment Variables (`/admin/env-vars`)

- Project selector dropdown
- DataTable: key, environment tabs (dev/staging/prod), encrypted badge, last updated
- "Add Variable" dialog with key validation
- Bulk import: paste key=value pairs
- Reference display showing which agents use `{{env.KEY}}`

**Data source:** Existing `env-vars` routes

#### 5.3 Guardrails (`/admin/guardrails`)

**Guardrail Providers (org-level):**

- Card per provider: name, adapter type, endpoint, active/inactive toggle
- "Add Provider" dialog with circuit breaker and retry config
- Health status per provider

**Guardrail Policies (project-scoped):**

- Project selector dropdown
- Policy list: name, mode (monitor/enforce), rules count, provider
- "Create Policy" dialog with rule editor, constitution principles, budget controls

**Data source:** Existing `guardrail-providers` and `guardrail-policies` routes

#### 5.4 Connectors & Channels (`/admin/connectors`)

**Channel Connections tab:**

- Cards per type: Slack, MS Teams, Email, Jambonz Voice, Custom
- Configure dialog with credentials, webhook URLs, deployment scoping
- Status indicators and webhook verification

**SDK Channels tab:**

- DataTable: name, type (web/mobile/voice/api), environment, API key (masked), deployment
- Create/edit/delete channels

**Data source:** Existing `channel-connections` and `channels` routes (project-scoped, project selector at top)

#### 5.5 Agent Performance (`/admin/analytics/agents`)

- Project selector
- Agent grid: name, call count, error rate, avg latency, containment rate, cost
- Agent detail: time-series charts (latency, error rate, volume), tool breakdown
- Comparison mode: 2 agents side-by-side

**Data source:** Existing `analytics/agents/:agentName` + `analytics/metrics`

#### 5.6 Session Explorer (`/admin/analytics/sessions`)

- Project + date range selector
- Session list: ID, start time, duration, status, agent path, cost, messages
- Filters: status, agent, date range, duration, has error
- Session detail: conversation timeline (messages, tool calls, handoffs)
- Summary metrics: completion rate, avg duration, avg cost

**Data source:** Existing `analytics/session-metrics` + `analytics/events`

#### 5.7 Trace Viewer (`/admin/analytics/traces`)

- Project + date range selector
- Event stream with category filters (LLM call, tool call, decision, error, handoff)
- Search by session ID, agent name, event type, error text
- Event detail panel: full payload, timing, parent span
- Error-first view toggle
- Ad-hoc SQL query interface for advanced users

**Data source:** Existing `analytics/events` + `analytics/query` + `analytics/sql-query`

### Enhanced Billing Page

Additional sections for the existing billing page:

- **Active Deals** card: current deals, phase indicator, renewal date
- **Credit Balance**: total/consumed/remaining progress bar, per-feature breakdown
- **Usage vs Limits**: progress bars per limit type with deal source
- **"Contact Sales"** button for Enterprise upgrade (no self-serve for Enterprise)
- **Self-serve upgrade** for FREE → TEAM, TEAM → BUSINESS (Stripe checkout)
- **Credit top-up** button (Stripe checkout, all tiers)
- **Alert Configuration**: threshold percentages for credit/limit warnings
- **Invoice History**: billing line items grouped by period

### Updated Sidebar Navigation

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

## 6. New APIs Required

### Platform Ops APIs

| Method | Path                                     | Purpose                      |
| ------ | ---------------------------------------- | ---------------------------- |
| GET    | `/api/platform/admin/tenants`            | List tenants with aggregates |
| GET    | `/api/platform/admin/tenants/:id`        | Tenant detail                |
| PATCH  | `/api/platform/admin/tenants/:id/status` | Status transitions           |
| GET    | `/api/platform/admin/system-health`      | Aggregated service health    |
| GET    | `/api/platform/admin/usage-summary`      | Cross-tenant usage rollup    |
| GET    | `/api/platform/admin/billing/overview`   | Revenue summary              |
| POST   | `/api/platform/admin/hubspot/webhook`    | HubSpot webhook receiver     |
| POST   | `/api/platform/admin/hubspot/sync`       | Manual HubSpot sync          |

### Deal/Billing APIs

| Method | Path                                          | Purpose                                   |
| ------ | --------------------------------------------- | ----------------------------------------- |
| GET    | `/api/platform/admin/deals`                   | List deals (filter by org, status, scope) |
| POST   | `/api/platform/admin/deals`                   | Create deal                               |
| GET    | `/api/platform/admin/deals/:id`               | Deal detail                               |
| PATCH  | `/api/platform/admin/deals/:id`               | Update deal                               |
| POST   | `/api/platform/admin/deals/:id/assign`        | Assign to project/org                     |
| GET    | `/api/platform/admin/deals/:id/credits`       | Credit ledger                             |
| POST   | `/api/platform/admin/deals/:id/credits/topup` | Add credits                               |
| GET    | `/api/platform/admin/deals/:id/line-items`    | Billing line items                        |
| POST   | `/api/platform/admin/deals/:id/line-items`    | Create line item                          |

### Workspace APIs

| Method | Path                                   | Purpose                                 |
| ------ | -------------------------------------- | --------------------------------------- |
| GET    | `/api/tenants/:tenantId/deals`         | Deals for tenant's org                  |
| GET    | `/api/tenants/:tenantId/credits`       | Credit balance/usage                    |
| POST   | `/api/tenants/:tenantId/upgrade`       | Self-serve upgrade (FREE/TEAM/BUSINESS) |
| POST   | `/api/tenants/:tenantId/credits/topup` | Purchase credits                        |

### Feature Gating APIs

| Method | Path                                   | Purpose                |
| ------ | -------------------------------------- | ---------------------- |
| GET    | `/api/tenants/:tenantId/features`      | Resolved feature flags |
| GET    | `/api/platform/admin/features/catalog` | All gatable features   |

---

## 7. Implementation Phases

### Phase 1: Foundation + Platform Ops Core

- Create `packages/admin-ui/` with shadcn/ui and shared components
- Migrate existing 4 `apps/admin/` pages to shared components
- New platform ops pages: Tenant Management, Config Overrides, Model Provisioning, Resilience Controls
- New APIs: tenant list/detail/status

### Phase 2: Billing Infrastructure

- New data models: Deal, CreditLedger, BillingLineItem
- All deal CRUD APIs
- HubSpot integration (webhook + sync)
- Credit tracking in runtime (intercept usage events)
- Updated limit resolution (deals + phases + environments)
- Platform ops: Deal Management (tenant detail tab), Billing Overview
- Overage enforcement (hard_stop/soft_cap/auto_upgrade)

### Phase 3: Workspace Admin — Configuration

- KMS Management page (4 tabs)
- Environment Variables page
- Guardrails page (providers + policies)
- Connectors & Channels page
- Updated AdminSidebar navigation

### Phase 4: Workspace Admin — Analytics

- Agent Performance page with charts
- Session Explorer with conversation timeline
- Trace Viewer with event stream
- All consuming existing analytics endpoints

### Phase 5: Workspace Billing + Platform Health

- Enhanced Billing page (deals, credits, limits, alerts, Contact Sales)
- Self-serve upgrade (FREE → TEAM → BUSINESS, Stripe)
- Credit top-up flow
- Platform ops System Health page
- Platform ops Usage & Analytics page
- New APIs: system-health, cross-tenant usage

### Phase 6: Polish & Integration

- Feature gating enforcement across both UIs
- Alert delivery (webhook + email for overage)
- Shared component refinements
- E2E tests for critical flows
- Studio gradual migration to shared components

---

## 8. Key Decisions

| Decision           | Choice                                      | Rationale                                                                |
| ------------------ | ------------------------------------------- | ------------------------------------------------------------------------ |
| Two separate apps  | Platform Ops + Workspace Admin              | Different users, auth models (IP allowlist for ops), security boundaries |
| Shared UI library  | `packages/admin-ui/` with shadcn/ui         | Consistency across apps, reduced duplication, accessible primitives      |
| Data fetching      | SWR (replaces custom useFetch)              | Caching, revalidation, dedup — already used in Studio                    |
| Billing model      | Deal-based with HubSpot                     | Supports multi-deal orgs, phases, per-env limits, credit hybrid          |
| Enterprise upgrade | Contact Sales only                          | No self-serve for Enterprise — offline invoice, HubSpot deal flow        |
| Self-serve         | FREE/TEAM/BUSINESS only                     | Stripe Checkout for plan upgrades and credit top-ups                     |
| Aggregation        | Per-deal mode (additive/max_wins/dedicated) | Flexible for different commercial arrangements                           |
| Credits            | Hybrid (shared pool + feature minimums)     | Balances simplicity with per-feature guarantees                          |
| Deployments        | Project-level, not workspace admin          | Consistent with runtime API scoping, belongs in project context          |
