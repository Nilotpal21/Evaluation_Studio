# Studio IA Redesign + Analytics & Insights Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restructure the Studio's information architecture into persona-based sections, consolidate traces into sessions, add governance & guardrails as a top-level concept, merge platform admin into the Admin App, and build the full Decagon-parity analytics & insights surface (233 customer queries across 10+ screens) — phased into 4 milestones.

**Architecture:** The Studio sidebar moves from 2 flat sections (Project/Observe) to 5 persona-based sections (Build, Resources, Insights, Operate, Manage). Analytics surfaces are built in Studio (project-scoped) and Admin App (platform-scoped). The "Ask AI" conversational analytics is dual-homed: Arch side panel + dedicated query bar. Guardrails and governance surface as top-level nav items, not buried inside agent detail.

**Tech Stack:** React 18, Zustand, SWR, Recharts, Framer Motion, Tailwind CSS, Lucide icons, Next.js 15 (Admin App), ClickHouse (analytics backend), MongoDB (session data), next-intl (i18n)

---

## Target Information Architecture

### Studio Project Sidebar (Final State)

```
[Project Switcher]

  BUILD
  ○ Overview                  (adaptive dashboard — existing)
  ○ Agents                    (agent list + topology — existing)
  ○ Workflows                 (workflow list — existing)
  ○ Experiments               (A/B testing, versioning, simulations — NEW)

  RESOURCES
  ○ Tools                     (HTTP, sandbox, MCP tabs — existing)
  ○ Knowledge Bases           (SearchAI — existing, renamed)
  ○ Integrations              (connections — existing, renamed)

  INSIGHTS
  ○ Dashboard                 (executive KPIs — NEW)
  ○ Agent Performance         (per-agent diagnostics — NEW)
  ○ Quality Monitor           (watchtower — NEW)
  ○ Customer Insights         (intents, VoC, sentiment — NEW)

  OPERATE
  ○ Sessions                  (conversations + traces tabs — MERGED)
  ○ Deployments               (environments, channels, API keys — MOVED)
  ○ Alerts                    (proactive notifications + inbox — NEW)

  GOVERN
  ○ Guardrails                (policies, providers, constraints — ELEVATED)
  ○ Governance                (agent registry, compliance, external agents — NEW)

  ──────
  ○ Settings                  (project settings 8-tab page — existing)
```

### Studio Admin Sidebar (Grouped)

```
[← Back to Projects]

  TEAM
  ○ Members                   (existing)
  ○ Security                  (MFA, SSO, audit — existing)

  AI CONFIGURATION
  ○ LLM Providers             (existing)
  ○ Arch                      (existing)
  ○ Voice Services            (existing)

  ACCOUNT
  ○ Secrets                   (existing)
  ○ Billing & Usage           (existing)
```

**Removed from Studio:** Platform Admin area (`/platform-admin/provisioned-models`) — merged into Admin App.

### Admin App Sidebar (Platform-Wide — port 3003)

```
  OVERVIEW
  ○ Dashboard                 (existing)

  TENANTS
  ○ Tenant Management         (existing)
  ○ Config Overrides          (existing)
  ○ Model Provisioning        (existing)

  OPERATIONS
  ○ Resilience Controls       (existing)
  ○ Provisioned Models        (MOVED from Studio platform-admin)

  ANALYTICS                   (NEW — platform-scoped aggregate views)
  ○ Platform Usage            (cross-tenant usage, cost, trends)
  ○ Platform Health           (system-wide health dashboard)

  OBSERVABILITY
  ○ Audit Log                 (existing)

  INFRASTRUCTURE
  ○ Configuration             (existing)
  ○ Secrets                   (existing)
```

---

## Phase Overview

| Phase       | Focus                                                      | Screens   | Query Coverage              |
| ----------- | ---------------------------------------------------------- | --------- | --------------------------- |
| **Phase 1** | IA restructure + Dashboard + Sessions consolidation        | 3 screens | ~40 queries (Tiers 1, 4)    |
| **Phase 2** | Agent Diagnostics + Quality Monitor                        | 2 screens | ~60 queries (Tiers 2, 3)    |
| **Phase 3** | Customer Insights + Experiments + Alerts + Governance      | 4 screens | ~80 queries (Tiers 3, 4, 6) |
| **Phase 4** | Ask AI + Voice Analytics + Platform Analytics + Compliance | 4 screens | ~53 queries (Tiers 6, 7)    |

---

## Phase 1: IA Restructure + Executive Dashboard + Sessions Consolidation

### Task 1: Update Navigation Store Types

**Files:**

- Modify: `apps/studio/src/store/navigation-store.ts`

**Step 1: Update ProjectPage type**

Add new page types and remove deprecated ones. The `ProjectPage` type needs these additions: `'experiments'`, `'dashboard'`, `'agent-performance'`, `'quality-monitor'`, `'customer-insights'`, `'alerts'`, `'guardrails-config'`, `'governance'`. Rename: `'search-ai'` stays (URL path) but sidebar label changes. Remove `'traces'` as a top-level page (becomes a tab inside sessions). Remove `'observability'` and `'contacts'` (placeholders).

```typescript
// In navigation-store.ts, update the ProjectPage type:
export type ProjectPage =
  | 'overview'
  | 'agents'
  | 'tools'
  | 'workflows'
  | 'experiments' // NEW — A/B testing, versioning
  | 'search-ai' // existing (renamed in sidebar label to "Knowledge Bases")
  | 'connections' // existing (renamed in sidebar label to "Integrations")
  | 'dashboard' // NEW — executive KPIs
  | 'agent-performance' // NEW — per-agent diagnostics
  | 'quality-monitor' // NEW — watchtower
  | 'customer-insights' // NEW — intents, VoC, sentiment
  | 'sessions' // existing (now includes traces tab)
  | 'deployments' // existing (moved to OPERATE section)
  | 'alerts' // NEW — proactive notifications (replaces inbox)
  | 'guardrails-config' // NEW — guardrail policies top-level
  | 'governance' // NEW — agent registry, compliance
  | 'mcp-servers'
  | 'profiles'
  | 'inbox' // DEPRECATED — keep for backward compat, redirect to alerts
  | 'analytics' // DEPRECATED — keep for backward compat, redirect to dashboard
  | 'traces' // DEPRECATED — keep for backward compat, redirect to sessions
  | 'settings';
```

**Step 2: Add redirect logic in navigate()**

In the `navigate` function's URL parsing, add redirects for deprecated pages:

```typescript
// After parsing page from URL:
if (page === 'traces') {
  page = 'sessions';
  tab = 'traces';
}
if (page === 'analytics') {
  page = 'dashboard';
}
if (page === 'inbox') {
  page = 'alerts';
}
if (page === 'observability' || page === 'contacts') {
  page = 'overview';
}
```

**Step 3: Update breadcrumb generation**

Update the breadcrumb builder to handle new pages and generate correct labels.

**Step 4: Run build to verify**

```bash
pnpm build --filter @agent-platform/studio
```

**Step 5: Commit**

```bash
git add apps/studio/src/store/navigation-store.ts
git commit -m "[ABLP-2] refactor(studio): update navigation store types for IA redesign"
```

---

### Task 2: Restructure ProjectSidebar into 5+ Sections

**Files:**

- Modify: `apps/studio/src/components/navigation/ProjectSidebar.tsx`
- Modify: `packages/i18n/locales/en/studio.json`

**Step 1: Update i18n keys**

Add new navigation translation keys in `packages/i18n/locales/en/studio.json` under `"nav"`:

```json
{
  "nav": {
    "experiments": "Experiments",
    "knowledge_bases": "Knowledge Bases",
    "integrations": "Integrations",
    "insights_dashboard": "Dashboard",
    "agent_performance": "Agent Performance",
    "quality_monitor": "Quality Monitor",
    "customer_insights": "Customer Insights",
    "alerts": "Alerts",
    "guardrails_config": "Guardrails",
    "governance_label": "Governance",
    "sections": {
      "build": "Build",
      "resources": "Resources",
      "insights": "Insights",
      "operate": "Operate",
      "govern": "Govern"
    }
  }
}
```

**Step 2: Replace nav item definitions**

Replace `projectNavDefs` and `observeNavDefs` in `ProjectSidebar.tsx` with 5 section arrays:

```typescript
import {
  Bot,
  Wrench,
  Workflow,
  BookOpen,
  Plug,
  Rocket,
  LayoutDashboard,
  BarChart3,
  Activity,
  ShieldAlert,
  MessageSquare,
  Bell,
  FlaskConical,
  TrendingUp,
  Sparkles,
  Eye,
  Shield,
  Landmark,
  Settings,
  ChevronsLeft,
  ChevronsRight,
  ChevronDown,
} from 'lucide-react';

const buildNavDefs: NavItemDef[] = [
  { id: 'overview', Icon: LayoutDashboard, key: 'overview' },
  { id: 'agents', Icon: Bot, key: 'agents' },
  { id: 'workflows', Icon: Workflow, key: 'workflows' },
  { id: 'experiments', Icon: FlaskConical, key: 'experiments' },
];

const resourcesNavDefs: NavItemDef[] = [
  { id: 'tools', Icon: Wrench, key: 'tools' },
  { id: 'search-ai', Icon: BookOpen, key: 'knowledge_bases' },
  { id: 'connections', Icon: Plug, key: 'integrations' },
];

const insightsNavDefs: NavItemDef[] = [
  { id: 'dashboard', Icon: TrendingUp, key: 'insights_dashboard' },
  { id: 'agent-performance', Icon: Activity, key: 'agent_performance' },
  { id: 'quality-monitor', Icon: Eye, key: 'quality_monitor' },
  { id: 'customer-insights', Icon: Sparkles, key: 'customer_insights' },
];

const operateNavDefs: NavItemDef[] = [
  { id: 'sessions', Icon: MessageSquare, key: 'sessions' },
  { id: 'deployments', Icon: Rocket, key: 'deployments' },
  { id: 'alerts', Icon: Bell, key: 'alerts' },
];

const governNavDefs: NavItemDef[] = [
  { id: 'guardrails-config', Icon: ShieldAlert, key: 'guardrails_config' },
  { id: 'governance', Icon: Landmark, key: 'governance_label' },
];
```

**Step 3: Render 5 sections in the nav area**

Replace the two existing `<div className="space-y-0.5">` blocks with 5 section blocks, each with a section header. Use the same pattern as existing sections but with the new arrays.

**Step 4: Keep Settings in bottom rail**

Settings stays in `bottomNavDefs` — same position, same border-t separator.

**Step 5: Verify collapsed mode**

Ensure all new icons render correctly in collapsed mode (56px width, icon only, title tooltip).

**Step 6: Commit**

```bash
git add apps/studio/src/components/navigation/ProjectSidebar.tsx packages/i18n/locales/en/studio.json
git commit -m "[ABLP-2] refactor(studio): restructure sidebar into Build/Resources/Insights/Operate/Govern sections"
```

---

### Task 3: Group Admin Sidebar Items

**Files:**

- Modify: `apps/studio/src/components/navigation/AdminSidebar.tsx`
- Modify: `packages/i18n/locales/en/studio.json`

**Step 1: Add i18n section keys**

```json
"sections": {
  "team": "Team",
  "ai_configuration": "AI Configuration",
  "account": "Account"
}
```

**Step 2: Split flat navItemDefs into 3 groups**

```typescript
const teamNavDefs: NavItemDef[] = [
  { id: 'members', Icon: Users, key: 'workspace_members' },
  { id: 'security', Icon: Shield, key: 'security_compliance' },
];

const aiConfigNavDefs: NavItemDef[] = [
  { id: 'models', Icon: Brain, key: 'llm_providers' },
  { id: 'arch', Icon: Sparkles, key: 'arch' },
  { id: 'voice', Icon: Mic, key: 'voice_services' },
];

const accountNavDefs: NavItemDef[] = [
  { id: 'secrets', Icon: Key, key: 'secrets' },
  { id: 'billing', Icon: CreditCard, key: 'billing_usage' },
];
```

**Step 3: Render 3 sections with headers**

Same pattern as ProjectSidebar sections — uppercase label + items.

**Step 4: Commit**

```bash
git add apps/studio/src/components/navigation/AdminSidebar.tsx packages/i18n/locales/en/studio.json
git commit -m "[ABLP-2] refactor(studio): group admin sidebar into Team/AI Config/Account sections"
```

---

### Task 4: Remove Platform Admin from Studio + Remove Placeholder Pages

**Files:**

- Modify: `apps/studio/src/components/navigation/AppShell.tsx` (remove platform-admin sidebar rendering, remove placeholder pages for observability/contacts, add redirects)
- Modify: `apps/studio/src/store/navigation-store.ts` (remove PlatformAdminPage type or keep for backward compat)
- Delete: `apps/studio/src/components/navigation/PlatformAdminSidebar.tsx`
- Delete: `apps/studio/src/components/platform-admin/ProvisionedModelsPage.tsx`

**Step 1: Remove PlatformAdminSidebar references from AppShell**

In `AppShell.tsx`:

- Remove import of `PlatformAdminSidebar`
- Remove `area === 'platform-admin'` from sidebar rendering (desktop + mobile)
- In `renderContent`: replace `platform-admin` case with redirect to Admin App (show a redirect card with link to `NEXT_PUBLIC_ADMIN_URL || 'http://localhost:3003'`)
- Remove `observability` and `contacts` cases (or redirect to overview)
- Remove the Platform Admin header button (`ShieldCheck` icon) — replace with a link that opens the Admin App in a new tab

**Step 2: Remove placeholder pages**

Remove `case 'observability'` and `case 'contacts'` from `renderContent`. They already redirect via the navigation store (Task 1).

**Step 3: Add new page routing in renderContent**

Add cases for new pages (stub components initially):

```typescript
case 'dashboard':
  return <InsightsDashboardPage />;
case 'agent-performance':
  return <AgentPerformancePage />;
case 'quality-monitor':
  return <QualityMonitorPage />;
case 'customer-insights':
  return <CustomerInsightsPage />;
case 'experiments':
  return <ExperimentsPage />;
case 'alerts':
  return <AlertsPage />;
case 'guardrails-config':
  return <GuardrailsConfigPage />;
case 'governance':
  return <GovernancePage />;
```

For now, create lightweight placeholder components in `apps/studio/src/components/` for each new page that show the page title and "Coming soon" — but these are NOT in the sidebar (they're routed to, not surfaced until implemented). The difference from before: no nav items point to unimplemented pages until the phase that builds them.

**Step 4: Delete old files**

```bash
rm apps/studio/src/components/navigation/PlatformAdminSidebar.tsx
rm apps/studio/src/components/platform-admin/ProvisionedModelsPage.tsx
```

**Step 5: Commit**

```bash
git add -A
git commit -m "[ABLP-2] refactor(studio): remove platform admin area, delete placeholder pages, add new page stubs"
```

---

### Task 5: Consolidate Traces into Sessions Page

**Files:**

- Modify: `apps/studio/src/components/session/SessionsListPage.tsx` (add tabs: Conversations | Traces)
- Move/Integrate: `apps/studio/src/components/traces/TracesPage.tsx` content into a `TracesTab` within Sessions

**Step 1: Add tab state to SessionsListPage**

Add a tab switcher at the top: `Conversations | Traces`. The current SessionsListPage content becomes the Conversations tab. The current TracesPage content becomes the Traces tab (agent-grouped view).

```typescript
const [activeTab, setActiveTab] = useState<'conversations' | 'traces'>(
  tab === 'traces' ? 'traces' : 'conversations',
);
```

Read `tab` from navigation store. If URL is `/projects/:id/sessions?tab=traces`, show traces tab.

**Step 2: Extract TracesTab component**

Move the TracesPage rendering logic into a `TracesTab` component in the same file or a sub-file. Keep the agent-grouped view, date filter, and agent filter.

**Step 3: Remove standalone traces route**

In `AppShell.tsx`, the `case 'traces'` now redirects to sessions (already handled by Task 1 navigation redirect).

**Step 4: Commit**

```bash
git add apps/studio/src/components/session/SessionsListPage.tsx apps/studio/src/components/navigation/AppShell.tsx
git commit -m "[ABLP-2] refactor(studio): consolidate traces into sessions page as tab"
```

---

### Task 6: Executive Insights Dashboard Page

**Files:**

- Create: `apps/studio/src/components/insights/InsightsDashboardPage.tsx`
- Create: `apps/studio/src/hooks/useInsightsDashboard.ts`

This is the primary analytics landing page. Maps to **Section 1 of the customer queries doc** (CX Operations Leader — At a Glance, Trends, ROI). Answers queries #1–#24.

**Step 1: Create the data hook**

`useInsightsDashboard.ts` — fetches from existing endpoints:

- `/api/runtime/analytics/session-metrics` → containment rate, resolution rate, avg duration
- `/api/runtime/analytics/cost-breakdown` → cost per conversation, savings
- `/api/tenant-usage` → token spend, daily trends
- `/api/runtime/analytics/event-counts` → conversation volume
- `/api/runtime/analytics/metrics` → CSAT (when available), error rates

```typescript
interface InsightsDashboardData {
  summary: {
    totalConversations: number;
    containmentRate: number; // AI-resolved / total
    estimatedCostSavings: number; // contained * (human_cost - ai_cost)
    avgCSAT: number | null; // null until CSAT pipeline built
    escalationRate: number;
    avgCostPerConversation: number;
    tokenSpendToday: number;
  };
  trends: {
    daily: Array<{
      date: string;
      conversations: number;
      containment: number;
      cost: number;
      csat: number | null;
    }>;
  };
  costBreakdown: Array<{
    agentName: string;
    conversations: number;
    cost: number;
    containmentRate: number;
  }>;
}
```

**Step 2: Create the page component**

`InsightsDashboardPage.tsx` — layout:

```
┌─────────────────────────────────────────────────────┐
│ PageHeader: "Insights Dashboard"                     │
│ Description: "Executive overview of AI agent program"│
│ [Date range selector] [Project filter if applicable] │
├─────────────────────────────────────────────────────┤
│ ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐ │
│ │Convos │ │Contain│ │Savings│ │ CSAT  │ │Escal. │ │
│ │ 12.4K │ │ 67.2% │ │$142K  │ │ 4.2   │ │ 8.3%  │ │
│ │ +12%  │ │ +3.1% │ │ +22%  │ │ +0.1  │ │ -2.4% │ │
│ └───────┘ └───────┘ └───────┘ └───────┘ └───────┘ │
├─────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────┐ │
│ │ Conversation Volume & Containment Rate Trend    │ │
│ │ (Area chart: volume bars + containment line)    │ │
│ │ [30d / 90d / YTD toggle]                        │ │
│ └─────────────────────────────────────────────────┘ │
├──────────────────────┬──────────────────────────────┤
│ Cost Breakdown Table │ Token Spend vs Budget        │
│ Agent | Conv | Cost  │ (Gauge or area chart)         │
│  ...  |  ... | ...   │                              │
└──────────────────────┴──────────────────────────────┘
```

Use existing `@agent-platform/admin-ui` components: `MetricCard`, `PageHeader`, `DataTable`, `SkeletonTable`, `EmptyState`. Use Recharts `AreaChart`, `BarChart` for trends.

**Step 3: Wire into AppShell**

Import and render for `case 'dashboard'`.

**Step 4: Commit**

```bash
git add apps/studio/src/components/insights/ apps/studio/src/hooks/useInsightsDashboard.ts apps/studio/src/components/navigation/AppShell.tsx
git commit -m "[ABLP-2] feat(studio): add executive insights dashboard page"
```

---

### Task 7: Merge Inbox into Alerts Stub Page

**Files:**

- Create: `apps/studio/src/components/alerts/AlertsPage.tsx`
- Modify: `apps/studio/src/components/navigation/AppShell.tsx`

**Step 1: Create AlertsPage**

Two tabs: `Approvals | Alerts`

- **Approvals tab**: Move the current `InboxPage` content here (workflow approval queue).
- **Alerts tab**: Stub with empty state: "No alert rules configured yet. Alert rules will notify you when metrics cross thresholds." — shows the pattern for Phase 3 implementation.

**Step 2: Wire into AppShell**

Replace `case 'inbox'` with redirect to `alerts`. Add `case 'alerts': return <AlertsPage />`.

**Step 3: Commit**

```bash
git add apps/studio/src/components/alerts/AlertsPage.tsx apps/studio/src/components/navigation/AppShell.tsx
git commit -m "[ABLP-2] feat(studio): merge inbox into alerts page with approvals + alerts tabs"
```

---

### Task 8: Elevate Guardrails to Top-Level Page

**Context — Current Guardrails Architecture:**

- **Per-agent guardrails**: Defined in the "Rules" collapsible section of Agent Detail page (`RulesSection.tsx`). These are inline ABL DSL constraints and guardrails embedded in each agent definition. They stay in agent detail — they're part of agent authoring.
- **Project-level guardrail policies**: Managed via `GET/POST /api/projects/:projectId/guardrail-policies` (runtime route `guardrail-policies.ts`). These are cross-agent policies that apply to all agents in a project. Currently no UI surface — only API.
- **Tenant-level guardrail providers**: Managed via `GET/POST /api/tenants/:tenantId/guardrail-providers` (runtime route `guardrail-providers.ts`). External evaluation services (adapters, endpoints, models). Currently no UI surface — only API.
- **Runtime evaluation pipeline**: Multi-tier evaluation (tier1/tier2/tier3 evaluators), streaming evaluator, circuit breaker, cost tracker — all fully implemented in `packages/compiler/src/platform/guardrails/`.

**What this task does:** Creates a new top-level Guardrails page that surfaces the **project-level policies** and **tenant-level providers** that currently have no UI. Per-agent Rules stay in Agent Detail.

**Files:**

- Create: `apps/studio/src/components/guardrails/GuardrailsConfigPage.tsx`
- Create: `apps/studio/src/hooks/useGuardrailPolicies.ts`

**Step 1: Create data hook**

Fetch from existing runtime endpoints:

- `GET /api/projects/:projectId/guardrail-policies` — project-level policies
- `GET /api/tenants/:tenantId/guardrail-providers` — tenant-level providers

**Step 2: Create page**

Three tabs: `Policies | Providers | Audit`

- **Policies tab**: List all project-level guardrail policies. Each policy shows: name, description, enabled/disabled status, rules (constitution principles, budget controls, streaming config), provider overrides. CRUD actions (create, edit, toggle, delete). Uses existing `GuardrailPolicy` model. Note: these are different from per-agent constraints in the Rules section — these are project-wide policies that apply to all agents.
- **Providers tab**: List tenant-level guardrail provider configs. Each shows: adapter type (e.g., LLM-as-judge, regex, external webhook), endpoint URL, model, categories, circuit breaker status, health check. CRUD from existing `TenantGuardrailProviderConfig` model.
- **Audit tab**: Guardrail evaluation history — leverages ClickHouse `platform_events` filtered by `category = 'guardrail'`. Shows: timestamp, session, agent, guardrail name, result (pass/fail/error), action taken, latency.

**Step 3: Wire into AppShell**

```typescript
case 'guardrails-config':
  return <GuardrailsConfigPage />;
```

**Step 4: Commit**

```bash
git add apps/studio/src/components/guardrails/ apps/studio/src/hooks/useGuardrailPolicies.ts
git commit -m "[ABLP-2] feat(studio): elevate guardrails to top-level page with policies, providers, audit tabs"
```

---

### Task 9: Governance Stub Page

**Files:**

- Create: `apps/studio/src/components/governance/GovernancePage.tsx`

**Step 1: Create page**

This is a stub page for Phase 3+ but with enough structure to show intent. Two tabs: `Agent Registry | Compliance`

- **Agent Registry tab**: Lists all agents in the project with their compliance status (guardrail coverage, test coverage, deployment status). Data source: existing agent list + guardrail policy associations. This is the foundation for the "Agent Management Platform" that can bring in agents from other platforms.
- **Compliance tab**: Stub showing planned features: regulation checks, data handling audits, PII compliance status.

**Step 2: Wire into AppShell**

```typescript
case 'governance':
  return <GovernancePage />;
```

**Step 3: Commit**

```bash
git add apps/studio/src/components/governance/GovernancePage.tsx
git commit -m "[ABLP-2] feat(studio): add governance page stub with agent registry and compliance tabs"
```

---

### Task 10: Phase 1 Build Verification

**Step 1: Build all packages**

```bash
pnpm build
```

**Step 2: Run Studio tests**

```bash
pnpm --filter @agent-platform/studio test
```

**Step 3: Visual verification**

Start Studio and verify:

- Sidebar shows 5 sections (Build, Resources, Insights, Operate, Govern) + Settings
- Admin sidebar shows 3 groups (Team, AI Configuration, Account)
- Platform Admin area is gone (header button opens Admin App in new tab)
- Sessions page has Conversations + Traces tabs
- Dashboard page renders with metric cards and charts
- Alerts page has Approvals + Alerts tabs
- Guardrails page has Policies + Providers + Audit tabs
- Old URLs (`/traces`, `/analytics`, `/inbox`) redirect correctly

**Step 4: Commit any fixes**

---

## Phase 2: Agent Diagnostics + Quality Monitor

### Task 11: Agent Performance Page

**Files:**

- Create: `apps/studio/src/components/insights/AgentPerformancePage.tsx`
- Create: `apps/studio/src/hooks/useAgentPerformance.ts`

Maps to **Section 2 of the customer queries doc** (AI/Agent Operations — queries #25–#58).

**Layout:**

```
┌──────────────────────────────────────────────────────┐
│ PageHeader: "Agent Performance"                       │
│ [Date range] [Agent filter dropdown]                  │
├──────────────────────────────────────────────────────┤
│ Agent Comparison Table (sortable)                     │
│ Agent | Containment | Escalation | CSAT | Cost | Δ   │
│ ─────────────────────────────────────────────────    │
│ BillingAgent  | 72% | 8% | 4.1 | $0.12 | ↑3%       │
│ SupportAgent  | 65% | 15% | 3.8 | $0.18 | ↓2%      │
├──────────────────────────────────────────────────────┤
│ [Click agent for deep-dive panel]                     │
│ ┌────────────────────┬───────────────────────────┐   │
│ │ Conversation Flow  │ Tool Usage Effectiveness   │   │
│ │ (Sankey diagram)   │ (bar chart: success/fail)  │   │
│ ├────────────────────┼───────────────────────────┤   │
│ │ Escalation Drivers │ Extraction Accuracy        │   │
│ │ (pie: AOP/LLM/user)│ (per-field accuracy table) │   │
│ └────────────────────┴───────────────────────────┘   │
└──────────────────────────────────────────────────────┘
```

**Data sources:**

- `/api/projects/:projectId/analytics/agents/:agentName` (existing endpoint)
- `/api/projects/:projectId/analytics/metrics` with groupBy=agentName
- `/api/projects/:projectId/analytics/events` with category filters

**Key components to build:**

- `AgentComparisonTable` — sortable table with per-agent metrics
- `AgentDeepDive` — expandable panel with 4 quadrants
- `ConversationFlowSankey` — Sankey diagram using recharts-sankey or d3-sankey
- `ToolUsageChart` — bar chart of tool success/failure rates
- `EscalationDriversPie` — pie chart of escalation reasons
- `ExtractionAccuracyTable` — per-field extraction metrics

---

### Task 12: Quality Monitor Page (Watchtower)

**Files:**

- Create: `apps/studio/src/components/insights/QualityMonitorPage.tsx`
- Create: `apps/studio/src/hooks/useQualityMonitor.ts`
- Create: `apps/runtime/src/routes/quality-evaluations.ts` (new API)

Maps to **Section 3 of the customer queries doc** (QA/CX Analyst — queries #59–#85).

**Layout:**

```
┌──────────────────────────────────────────────────────┐
│ PageHeader: "Quality Monitor"                         │
│ [Date range] [Quality criteria filter]                │
├──────────────────────────────────────────────────────┤
│ ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐            │
│ │Analyzed│ │Flagged│ │Flag % │ │Halluc.│            │
│ │ 2,945  │ │ 1,237 │ │ 42%   │ │ 3.2%  │            │
│ └───────┘ └───────┘ └───────┘ └───────┘            │
├──────────────────────────────────────────────────────┤
│ Flagged Conversations (table with drill-down)         │
│ Session | Agent | Criteria Failed | Score | Sentiment │
│ ─────────────────────────────────────────────────    │
│ Click → opens session detail with quality annotations │
├──────────────────────────────────────────────────────┤
│ ┌─────────────────────┬──────────────────────────┐   │
│ │ Quality Score Dist. │ Criteria Failure Rates    │   │
│ │ (histogram 1-5)     │ (bar chart per criterion) │   │
│ ├─────────────────────┼──────────────────────────┤   │
│ │ Sentiment Trend     │ Friction Detection        │   │
│ │ (line: pos/neg/neu) │ (frustration indicators)  │   │
│ └─────────────────────┴──────────────────────────┘   │
└──────────────────────────────────────────────────────┘
```

**New Runtime API: Quality Evaluations**

Create `apps/runtime/src/routes/quality-evaluations.ts`:

- `GET /api/projects/:projectId/quality/summary` — flagged counts, score distribution
- `GET /api/projects/:projectId/quality/flagged` — flagged conversation list with criteria
- `GET /api/projects/:projectId/quality/criteria` — quality criteria definitions + pass/fail rates
- `GET /api/projects/:projectId/quality/sentiment` — sentiment distribution over time

Data source: ClickHouse `platform_events` with `category = 'evaluation'` and `event_type IN ('quality_check', 'sentiment_analysis', 'guardrail_check')`.

---

## Phase 3: Customer Insights + Experiments + Alerts + Governance

### Task 13: Customer Insights Page

Maps to **Section 5** (Product Manager / VoC — queries #95–#116).

**Tabs:** `Intents | Topics | Sentiment | Churn Signals`

- **Intents tab**: Intent distribution table (ranked by volume), deflection rate per intent, trend sparklines. "What's driving the metric" decomposition.
- **Topics tab**: Emerging topic discovery, topic co-occurrence matrix, topic trend chart.
- **Sentiment tab**: Turn-level sentiment aggregation, sentiment pivot detection, recovery pattern analysis.
- **Churn Signals tab**: Repeat contact detection, declining CSAT per customer, cancellation intent detection.

**New Runtime APIs:**

- `GET /api/projects/:projectId/insights/intents` — intent distribution + deflection
- `GET /api/projects/:projectId/insights/topics` — topic discovery + trends
- `GET /api/projects/:projectId/insights/sentiment` — sentiment analysis
- `GET /api/projects/:projectId/insights/churn-signals` — churn risk indicators

### Task 14: Experiments Page

Maps to **Section 8** (A/B Testing — queries #155–#162).

**Tabs:** `A/B Tests | Agent Versions | Simulations`

- **A/B Tests tab**: Create experiment (name, control version, experiment version, traffic split). View running experiments with: conversation counts, deflection rate comparison, CSAT comparison, statistical significance indicator. "Should we roll out?" recommendation.
- **Agent Versions tab**: Version list with traffic splits, per-version metrics comparison, rollback button.
- **Simulations tab**: Upload test scenarios, run simulation against agent version, view pass/fail results.

**New Runtime APIs:**

- `GET/POST /api/projects/:projectId/experiments` — experiment CRUD
- `GET /api/projects/:projectId/experiments/:id/results` — experiment metrics
- `GET /api/projects/:projectId/agent-versions` — version list with traffic splits
- `POST /api/projects/:projectId/simulations` — run simulation

### Task 15: Alerts Page (Full Implementation)

Expand the stub from Task 7 with:

- **Alert Rules tab**: Create/edit alert rules with: metric (containment, CSAT, error rate, latency, sentiment, hallucination rate), condition (threshold, anomaly), window (5m, 15m, 1h), notification channel (email, Slack webhook). Maps to **Section 10** (queries #190–#200).
- **Alert History tab**: Timeline of triggered alerts with: trigger time, metric value, threshold, resolved time.
- **Approvals tab**: Keep existing inbox content.

**New Runtime APIs:**

- `GET/POST /api/projects/:projectId/alert-rules` — rule CRUD
- `GET /api/projects/:projectId/alert-history` — triggered alerts

### Task 16: Governance Page (Full Implementation)

Expand the stub from Task 9:

- **Agent Registry tab**: Full agent inventory with: source (ABL native, external), compliance score, guardrail coverage, test coverage, last audit date. Support for registering external agents (from other platforms — this is the Agent Management Platform integration point).
- **Compliance tab**: Data handling audit, PII compliance status, regulatory disclosure verification, GDPR retention compliance.
- **Audit Trail tab**: Full conversation lifecycle audit (leverages existing audit store).

---

## Phase 4: Ask AI + Voice Analytics + Platform Analytics + Compliance

### Task 17: Ask AI (Conversational Analytics)

Maps to **Section 9** (queries #163–#189).

**Two surfaces:**

1. **Arch integration**: Add an "Analytics" mode to the Arch side panel. When in analytics context, Arch can answer data questions using the existing analytics APIs. Uses tool calls to query ClickHouse via the SQL query endpoint.

2. **Dedicated query bar**: Add a natural language search bar at the top of the Dashboard page. Translates NL queries to API calls, displays results inline with charts/tables.

### Task 18: Voice Analytics Page

Maps to **Section 11** (queries #201–#210).

Add a "Voice" tab to the Agent Performance page or a separate voice analytics section:

- WER tracking, MOS scoring, TTFA latency, barge-in detection, dead air analysis.
- Data source: ClickHouse `platform_events` with voice-specific event types.

### Task 19: Platform Analytics in Admin App

**Files in `apps/admin/`:**

Two new pages in the Admin App:

- **Platform Usage**: Cross-tenant usage dashboard. Token consumption, cost trends, tenant comparison, budget alerts. Aggregates from `/api/platform/admin/usage` (new endpoint).
- **Platform Health**: System-wide health dashboard. Service status, ClickHouse/Redis/MongoDB health, circuit breaker states, latency percentiles. Aggregates from existing resilience API + new health endpoint.

### Task 20: Compliance & Audit Pages

Maps to **Section 13** (queries #219–#225).

Enhance the Governance page's Compliance tab with:

- Conversation audit trail viewer (full lifecycle log)
- Data access audit log
- GDPR retention status dashboard
- PII exposure event tracking
- Regulatory disclosure verification
- Filtered export for regulatory review

---

## Phase 1 Verification Checklist

After Phase 1 (Tasks 1–10):

- [ ] Sidebar shows 5 sections + Settings in bottom rail
- [ ] Admin sidebar shows 3 grouped sections
- [ ] Platform Admin area removed from Studio
- [ ] `/traces` redirects to `/sessions?tab=traces`
- [ ] `/analytics` redirects to `/dashboard`
- [ ] `/inbox` redirects to `/alerts`
- [ ] `/observability` and `/contacts` redirect to `/overview`
- [ ] Sessions page has Conversations + Traces tabs
- [ ] Executive Dashboard renders with metric cards and charts
- [ ] Alerts page has Approvals + Alerts tabs
- [ ] Guardrails page has Policies + Providers + Audit tabs
- [ ] Governance page has Agent Registry + Compliance tabs
- [ ] `pnpm build` passes
- [ ] No broken navigation links

---

## Files Summary (Phase 1)

### Modify

| File                                                       | Change                                      |
| ---------------------------------------------------------- | ------------------------------------------- |
| `apps/studio/src/store/navigation-store.ts`                | Add new page types, deprecation redirects   |
| `apps/studio/src/components/navigation/ProjectSidebar.tsx` | 5 sections with new icons/items             |
| `apps/studio/src/components/navigation/AdminSidebar.tsx`   | 3 grouped sections                          |
| `apps/studio/src/components/navigation/AppShell.tsx`       | Remove platform-admin, add new page routing |
| `apps/studio/src/components/session/SessionsListPage.tsx`  | Add Conversations/Traces tabs               |
| `packages/i18n/locales/en/studio.json`                     | New nav keys                                |

### Create

| File                                                             | Purpose                      |
| ---------------------------------------------------------------- | ---------------------------- |
| `apps/studio/src/components/insights/InsightsDashboardPage.tsx`  | Executive KPI dashboard      |
| `apps/studio/src/hooks/useInsightsDashboard.ts`                  | Dashboard data hook          |
| `apps/studio/src/components/alerts/AlertsPage.tsx`               | Alerts + Approvals           |
| `apps/studio/src/components/guardrails/GuardrailsConfigPage.tsx` | Guardrail policies top-level |
| `apps/studio/src/hooks/useGuardrailPolicies.ts`                  | Guardrail data hook          |
| `apps/studio/src/components/governance/GovernancePage.tsx`       | Agent registry + compliance  |

### Delete

| File                                                                  | Reason                |
| --------------------------------------------------------------------- | --------------------- |
| `apps/studio/src/components/navigation/PlatformAdminSidebar.tsx`      | Merged into Admin App |
| `apps/studio/src/components/platform-admin/ProvisionedModelsPage.tsx` | Merged into Admin App |
