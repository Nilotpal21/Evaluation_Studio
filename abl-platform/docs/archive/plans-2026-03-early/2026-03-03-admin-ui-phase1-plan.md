# Admin UI Phase 1: Foundation + Platform Ops Core

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create the shared admin UI package and add 4 new platform ops pages (Tenant Management, Config Overrides, Model Provisioning, Resilience Controls) with supporting APIs.

**Architecture:** Shared `packages/admin-ui/` built on shadcn/ui provides reusable components consumed by `apps/admin/`. New runtime API route for tenant listing. Existing APIs for config overrides, model provisioning, and resilience. Admin app pages use existing `useFetch` hook (SWR migration deferred to Phase 6).

**Tech Stack:** Next.js 14, React 18, shadcn/ui (Radix primitives), Tailwind CSS 3.4, recharts, Zod, Express, Mongoose, vitest

**Design doc:** `docs/plans/2026-03-03-admin-ui-billing-design.md`

---

## Task 1: Create Shared UI Package Scaffold

**Files:**

- Create: `packages/admin-ui/package.json`
- Create: `packages/admin-ui/tsconfig.json`
- Create: `packages/admin-ui/src/index.ts`
- Create: `packages/admin-ui/src/lib/cn.ts`
- Create: `packages/admin-ui/src/lib/format.ts`

**Step 1: Create package.json**

Dependencies: `@radix-ui/react-dialog`, `@radix-ui/react-select`, `@radix-ui/react-tabs`, `@radix-ui/react-tooltip`, `@radix-ui/react-slot`, `class-variance-authority`, `clsx`, `lucide-react`, `recharts`, `tailwind-merge`. Peer deps: `react`, `react-dom`.

**Step 2: Create tsconfig.json targeting ES2022, jsx react-jsx, strict mode**

**Step 3: Create `src/lib/cn.ts`** — `clsx` + `tailwind-merge` utility

**Step 4: Create `src/lib/format.ts`** — formatNumber (handles -1 as Unlimited), formatBytes, formatMs, formatDate, formatDateTime, relativeTime helpers

**Step 5: Create `src/index.ts`** barrel export for cn and format utilities

**Step 6: Run `pnpm install`**

**Step 7: Commit** `[ABLP-2] feat(admin-ui): scaffold shared admin UI package`

---

## Task 2: Shared UI Components — Core Primitives

**Files:**

- Create: `packages/admin-ui/src/components/status-badge.tsx`
- Create: `packages/admin-ui/src/components/metric-card.tsx`
- Create: `packages/admin-ui/src/components/page-header.tsx`
- Create: `packages/admin-ui/src/components/empty-state.tsx`
- Create: `packages/admin-ui/src/components/skeleton.tsx`
- Create: `packages/admin-ui/src/components/confirm-dialog.tsx`
- Modify: `packages/admin-ui/src/index.ts`

**Step 1: StatusBadge** — Supports variants: healthy, degraded, down, unknown, active, suspended, archived, open, closed, half-open. Each variant has matching bg/text/border colors and a colored dot indicator.

**Step 2: MetricCard** — Shows title, large value, optional description, optional icon in accent box, optional trend indicator with +/- coloring.

**Step 3: PageHeader** — Title + description + optional actions slot. Consistent mb-8 spacing.

**Step 4: EmptyState** — Centered layout with optional icon, title, description, action button.

**Step 5: Skeleton** — Base shimmer component + SkeletonCard and SkeletonTable presets.

**Step 6: ConfirmDialog** — Radix Dialog with title, description, cancel/confirm buttons. Supports `variant: 'destructive'` for red styling. Loading state on confirm button.

**Step 7: Update barrel export**

**Step 8: Commit** `[ABLP-2] feat(admin-ui): add core shared components`

---

## Task 3: Shared UI Components — DataTable and FilterBar

**Files:**

- Create: `packages/admin-ui/src/components/data-table.tsx`
- Create: `packages/admin-ui/src/components/filter-bar.tsx`
- Modify: `packages/admin-ui/src/index.ts`

**Step 1: DataTable** — Generic `DataTable<T>` component with:

- Column definition: key, header, render function, optional sortable + sortFn, optional width
- Client-side sorting with arrow indicators (Lucide ArrowUpDown/ArrowUp/ArrowDown)
- Loading state (skeleton rows)
- Empty state (message)
- Row hover highlighting, optional onRowClick
- Pagination footer: page N of M (total), Previous/Next buttons

**Step 2: FilterBar** — Composable filter row with:

- Optional search input with Lucide Search icon
- Array of select filters (label, value, options, onChange)
- Optional actions slot (ml-auto aligned)

**Step 3: Update exports**

**Step 4: Commit** `[ABLP-2] feat(admin-ui): add DataTable and FilterBar components`

---

## Task 4: Wire Admin App to Shared Package

**Files:**

- Modify: `apps/admin/package.json`
- Modify: `apps/admin/tailwind.config.ts`

**Step 1:** Add `"@agent-platform/admin-ui": "workspace:*"` to admin dependencies

**Step 2:** Add `'../../packages/admin-ui/src/**/*.{js,ts,jsx,tsx}'` to Tailwind content paths

**Step 3:** Run `pnpm install && pnpm build --filter @agent-platform/admin` — verify build succeeds

**Step 4: Commit** `[ABLP-2] feat(admin): wire shared admin-ui package`

---

## Task 5: Update Admin App Sidebar Navigation

**Files:**

- Modify: `apps/admin/src/app/(dashboard)/layout.tsx`

**Step 1:** Replace flat NAV_ITEMS with grouped navigation structure:

- OVERVIEW: Dashboard (existing `/`)
- TENANTS: Tenant Management (`/tenants`), Config Overrides (`/config-overrides`), Model Provisioning (`/models`)
- OPERATIONS: Resilience Controls (`/resilience`)
- OBSERVABILITY: Audit Log (existing `/audit`)
- INFRASTRUCTURE: Configuration (existing `/config`), Secrets (existing `/secrets`)

Use Lucide icons: `Users`, `SlidersHorizontal`, `Brain`, `ShieldCheck`, `BarChart3`

Render group headers as uppercase text-xs labels with spacing between groups.

**Step 2:** Verify sidebar renders with `pnpm dev --filter @agent-platform/admin`

**Step 3: Commit** `[ABLP-2] feat(admin): add grouped sidebar navigation for new pages`

---

## Task 6: Runtime API — Tenant List Endpoint

**Files:**

- Create: `apps/runtime/src/routes/platform-admin-tenants.ts`
- Modify: `apps/runtime/src/server.ts`
- Create: `apps/runtime/src/__tests__/platform-admin-tenants.test.ts`

**Step 1: Write tests** following `platform-admin-config.test.ts` mock pattern:

- Mock authMiddleware, requirePlatformAdmin, requirePlatformAdminIp, tenantRateLimit, createLogger, writeAuditLog, getConfig
- Mock Tenant, Subscription, TenantMember from database/models
- Tests: GET / returns paginated list with aggregates, GET /:id returns detail, PATCH /:id/status changes status + audit log, 404 for unknown tenant, 400 for invalid status

**Step 2: Run tests — verify they fail**

**Step 3: Implement route** with standard middleware chain (authMiddleware, tenantRateLimit, requirePlatformAdmin, requirePlatformAdminIp):

- `GET /` — List tenants with pagination (default 25, max 100). Enrich with subscription planTier and member count via parallel queries. Filter by status, planTier, search (name regex).
- `GET /:tenantId` — Detail with tenant, subscription, organization, member count.
- `PATCH /:tenantId/status` — Zod-validated status transition (active/suspended/archived). Audit log with `platform-admin:change-tenant-status`.

**Step 4: Mount** at `/api/platform/admin/tenants` in server.ts

**Step 5: Run tests — verify they pass**

**Step 6: Commit** `[ABLP-2] feat(runtime): add platform admin tenant list/detail/status API`

---

## Task 7: Tenant Management Page

**Files:**

- Create: `apps/admin/src/app/api/tenants/route.ts` (proxy to runtime)
- Create: `apps/admin/src/app/api/tenants/[tenantId]/route.ts`
- Create: `apps/admin/src/app/(dashboard)/tenants/page.tsx`
- Modify: `apps/admin/src/types/api.ts`

**Step 1:** Add TenantSummary and TenantsResponse types to api.ts

**Step 2:** Create proxy API routes that forward to runtime with admin auth headers

**Step 3:** Create tenant list page using DataTable, StatusBadge, PageHeader, FilterBar from `@agent-platform/admin-ui`. Show status badge, plan tier badge, member count, relative time for created date.

**Step 4:** Verify at `http://localhost:3003/tenants`

**Step 5: Commit** `[ABLP-2] feat(admin): add tenant management page`

---

## Task 8: Config Overrides Page

**Files:**

- Create: `apps/admin/src/app/api/tenant-config/route.ts`
- Create: `apps/admin/src/app/api/tenant-config/[tenantId]/route.ts`
- Create: `apps/admin/src/app/api/tenant-config/[tenantId]/overrides/route.ts`
- Create: `apps/admin/src/app/(dashboard)/config-overrides/page.tsx`

**Step 1:** Create proxy routes forwarding to runtime `platform-admin-config` endpoints

**Step 2:** Create config overrides page:

- Left panel: Plan defaults table (FREE/TEAM/BUSINESS/ENTERPRISE columns)
- Right panel: Tenant selector, resolved config with green highlights for overrides
- Edit form with ConfirmDialog for mutations

**Step 3:** Verify at `http://localhost:3003/config-overrides`

**Step 4: Commit** `[ABLP-2] feat(admin): add config overrides page with plan defaults comparison`

---

## Task 9: Model Provisioning Page

**Files:**

- Create: `apps/admin/src/app/api/tenant-models/route.ts`
- Create: `apps/admin/src/app/api/tenant-models/[id]/route.ts`
- Create: `apps/admin/src/app/(dashboard)/models/page.tsx`

**Step 1:** Create proxy routes forwarding to runtime `platform-admin-models` endpoints

**Step 2:** Create model provisioning page:

- DataTable with provider, model ID, tier badge, status, tenant, connections, capabilities
- Filters by provider, tier, status
- "Provision Model" button opens dialog
- ConfirmDialog for revoke action

**Step 3:** Verify at `http://localhost:3003/models`

**Step 4: Commit** `[ABLP-2] feat(admin): add model provisioning page`

---

## Task 10: Resilience Controls Page

**Files:**

- Create: `apps/admin/src/app/api/resilience/[...path]/route.ts`
- Create: `apps/admin/src/app/(dashboard)/resilience/page.tsx`

**Step 1:** Create catch-all proxy route forwarding to runtime `platform-admin-resilience` endpoints

**Step 2:** Create resilience controls page:

- Backend badge (Redis/memory)
- Circuit breaker DataTable with StatusBadge for state
- Per-breaker Reset button with ConfirmDialog
- Tenant health section with search, health breakdown, Force Reset All with ConfirmDialog

**Step 3:** Verify at `http://localhost:3003/resilience`

**Step 4: Commit** `[ABLP-2] feat(admin): add resilience controls page`

---

## Task 11: Build Verification

**Step 1:** Run `pnpm build` — all packages build successfully

**Step 2:** Run `pnpm --filter @agent-platform/runtime test` — all tests pass

**Step 3:** Commit if any fixes needed

---

## Summary

| Task | Component                | New Files | Modified Files |
| ---- | ------------------------ | --------- | -------------- |
| 1    | Shared UI scaffold       | 5         | 0              |
| 2    | Core UI components       | 6         | 1              |
| 3    | DataTable + FilterBar    | 2         | 1              |
| 4    | Wire admin app           | 0         | 2              |
| 5    | Sidebar navigation       | 0         | 1              |
| 6    | Tenant list API          | 2 + tests | 1              |
| 7    | Tenant management page   | 3         | 1              |
| 8    | Config overrides page    | 4         | 0              |
| 9    | Model provisioning page  | 3         | 0              |
| 10   | Resilience controls page | 2         | 0              |
| 11   | Build verification       | 0         | 0              |
