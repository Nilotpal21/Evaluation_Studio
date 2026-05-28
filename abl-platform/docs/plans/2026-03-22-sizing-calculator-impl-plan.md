# LLD & Implementation Plan: Sizing Calculator

**Feature:** sizing-calculator (#42)
**Created:** 2026-03-22
**Last Updated:** 2026-03-22
**Status:** PLANNED
**HLD Reference:** `docs/specs/sizing-calculator.hld.md`
**Feature Spec Reference:** `docs/features/sizing-calculator.md`
**Test Spec Reference:** `docs/testing/sizing-calculator.md`

---

## Implementation Overview

5 phases, each with clear entry/exit criteria and a file-level wiring checklist. Phases 1-3 are the ALPHA milestone (API + CLI). Phase 4 is BETA (Studio UI). Phase 5 is STABLE (cost + advanced export).

**Total estimated files to create/modify:** 28
**Total estimated LOC (new):** ~2,200

---

## Phase 1: API Core

**Goal:** Expose the sizing engine via REST API in the admin service. Implement calculate, export (Helm), and tiers endpoints.

**Entry Criteria:**

- `packages/sizing-calculator` builds and all 9 existing test files pass
- `apps/admin` builds and existing tests pass

### Files to Create

| #   | File                                                | Purpose                                                                                | LOC Est. |
| --- | --------------------------------------------------- | -------------------------------------------------------------------------------------- | -------- |
| 1   | `apps/admin/src/routes/sizing/sizing.router.ts`     | Route registration: POST /calculate, POST /export, GET /tiers                          | 40       |
| 2   | `apps/admin/src/routes/sizing/sizing.controller.ts` | Request handling: parse body, validate via Zod, delegate to service, format response   | 120      |
| 3   | `apps/admin/src/routes/sizing/sizing.service.ts`    | Business logic: call engine functions, build TierBreakdown, dispatch export generators | 100      |
| 4   | `apps/admin/src/routes/sizing/sizing.schemas.ts`    | Request/response Zod schemas: CalculateRequest, ExportRequest, TierBreakdown           | 60       |
| 5   | `apps/admin/src/routes/sizing/index.ts`             | Barrel export                                                                          | 5        |

### Files to Modify

| #   | File                             | Change                                             | Impact          |
| --- | -------------------------------- | -------------------------------------------------- | --------------- |
| 1   | `apps/admin/src/routes/index.ts` | Register sizing router under `/api/sizing`         | Low -- additive |
| 2   | `apps/admin/package.json`        | Add `@agent-platform/sizing-calculator` dependency | Low             |

### Implementation Details

**sizing.router.ts:**

```typescript
import { Router } from 'express';
import { requireAuth } from '@abl/shared/middleware'; // verify actual import
import { SizingController } from './sizing.controller.js';

const router = Router();
const controller = new SizingController();

router.post('/calculate', requireAuth, controller.calculate);
router.post('/export', requireAuth, controller.export);
router.get('/tiers', requireAuth, controller.getTiers);

export { router as sizingRouter };
```

**sizing.controller.ts:**
Key patterns:

- Validate request body with `QuestionnaireSchema.safeParse()`
- On validation failure: return `{ success: false, error: { code: 'INVALID_QUESTIONNAIRE', message, details: zodErrors } }`
- On success: call `sizingService.calculate(questionnaire)` and return `{ success: true, data: result }`
- Export: validate `ExportRequestSchema`, dispatch to `sizingService.export(topology, format)`
- Tiers: return static tier boundary data from the engine's `TIER_BOUNDARIES`

**sizing.service.ts:**
Key patterns:

- `calculate(questionnaire)`: calls `calculateTopology()` from engine, builds `TierBreakdown`, returns both
- `export(topology, format)`: dispatches to `generateHelmValues()` for Helm format; returns `{ files: Record<string, string> }`
- `getTierBoundaries()`: returns the tier boundary definitions from engine constants

**TierBreakdown construction:**

```typescript
function buildTierBreakdown(questionnaire: Questionnaire): TierBreakdown {
  const tier = classifyTier(questionnaire);
  const dimensions = [
    {
      name: 'agentCount',
      value: questionnaire.agents.agentCount,
      boundary: getBoundaryForTier(tier, 'maxAgents'),
    },
    {
      name: 'concurrentConversations',
      value: questionnaire.agents.concurrentConversations,
      boundary: getBoundaryForTier(tier, 'maxConcurrentConversations'),
    },
    // ... all 5 dimensions
  ];
  // Mark which dimension(s) exceed the previous tier's boundary
  return { tier, dimensions, drivingDimension: findDrivingDimension(dimensions) };
}
```

### Wiring Checklist

- [ ] `sizingRouter` imported and registered in `apps/admin/src/routes/index.ts`
- [ ] `@agent-platform/sizing-calculator` added to `apps/admin/package.json` dependencies
- [ ] `requireAuth` middleware imported from correct path (READ the import source first)
- [ ] Error responses use platform envelope `{ success, data/error }`
- [ ] `createLogger('sizing')` used for all logging (not console.log)

### Exit Criteria

- [ ] `POST /api/sizing/calculate` returns valid ClusterTopology for all 4 tiers
- [ ] `POST /api/sizing/export` returns Helm YAML files for a valid topology
- [ ] `GET /api/sizing/tiers` returns tier boundary definitions
- [ ] Invalid questionnaire returns 400 with Zod errors
- [ ] Unauthenticated requests return 401
- [ ] E2E-1, E2E-3, E2E-4, E2E-5, E2E-8 test scenarios pass
- [ ] `pnpm build --filter=admin` succeeds
- [ ] `pnpm test --filter=admin` passes (existing + new tests)

---

## Phase 2: Profile Persistence

**Goal:** Add CRUD endpoints for sizing profiles with tenant and project isolation in MongoDB.

**Entry Criteria:**

- Phase 1 exit criteria met
- Admin service has existing MongoDB model patterns to follow

### Files to Create

| #   | File                                                        | Purpose                                                         | LOC Est. |
| --- | ----------------------------------------------------------- | --------------------------------------------------------------- | -------- |
| 1   | `packages/database/src/models/sizing-profile.model.ts`      | Mongoose schema and model for SizingProfile                     | 80       |
| 2   | `apps/admin/src/routes/sizing/sizing-profile.repo.ts`       | Data access layer: CRUD with tenantId/projectId isolation       | 120      |
| 3   | `apps/admin/src/routes/sizing/sizing-profile.controller.ts` | Profile CRUD request handling                                   | 150      |
| 4   | `apps/admin/src/routes/sizing/sizing-profile.router.ts`     | Profile routes under `/api/projects/:projectId/sizing-profiles` | 30       |
| 5   | `apps/admin/src/routes/sizing/sizing-profile.schemas.ts`    | Zod schemas for profile create/update requests                  | 40       |

### Files to Modify

| #   | File                                    | Change                                       | Impact          |
| --- | --------------------------------------- | -------------------------------------------- | --------------- |
| 1   | `apps/admin/src/routes/index.ts`        | Register profile router under project routes | Low -- additive |
| 2   | `packages/database/src/models/index.ts` | Export SizingProfile model                   | Low             |

### Implementation Details

**sizing-profile.model.ts:**

```typescript
const SizingProfileSchema = new Schema(
  {
    tenantId: { type: String, required: true, index: true },
    projectId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    description: { type: String, default: '' },
    questionnaire: { type: Schema.Types.Mixed, required: true },
    topology: { type: Schema.Types.Mixed, required: true },
    costEstimate: { type: Schema.Types.Mixed },
    version: { type: Number, default: 1 },
    createdBy: { type: String, required: true, index: true },
  },
  { timestamps: true },
);

SizingProfileSchema.index({ tenantId: 1, projectId: 1 });
SizingProfileSchema.index({ tenantId: 1, projectId: 1, name: 1 }, { unique: true });
```

**sizing-profile.repo.ts:**
Key invariants (from CLAUDE.md):

- NEVER use `findById()` -- always `findOne({ _id, tenantId, projectId })`
- Updates: `findOneAndUpdate({ _id, tenantId, projectId }, update, { new: true })`
- Deletes: `deleteOne({ _id, tenantId, projectId })`
- Cross-tenant access returns `null` (controller maps to 404)

```typescript
class SizingProfileRepo {
  async create(data: CreateProfileInput): Promise<SizingProfileDoc> {
    return SizingProfile.create(data);
  }

  async findById(
    id: string,
    tenantId: string,
    projectId: string,
  ): Promise<SizingProfileDoc | null> {
    return SizingProfile.findOne({ _id: id, tenantId, projectId });
  }

  async list(tenantId: string, projectId: string, createdBy?: string): Promise<SizingProfileDoc[]> {
    const filter: Record<string, unknown> = { tenantId, projectId };
    if (createdBy) filter.createdBy = createdBy;
    return SizingProfile.find(filter).sort({ createdAt: -1 }).limit(100);
  }

  async update(
    id: string,
    tenantId: string,
    projectId: string,
    data: UpdateProfileInput,
  ): Promise<SizingProfileDoc | null> {
    return SizingProfile.findOneAndUpdate(
      { _id: id, tenantId, projectId },
      { $set: data, $inc: { version: 1 } },
      { new: true },
    );
  }

  async delete(id: string, tenantId: string, projectId: string): Promise<boolean> {
    const result = await SizingProfile.deleteOne({ _id: id, tenantId, projectId });
    return result.deletedCount === 1;
  }
}
```

**sizing-profile.controller.ts:**

- Create: Validate input, calculate topology, save profile, return 201
- Read: Find by id with tenant/project isolation, return 200 or 404
- List: Find all for tenant/project, return 200
- Update: Find and update with isolation, return 200 or 404
- Delete: Delete with isolation, return 200 or 404

### Wiring Checklist

- [ ] `SizingProfile` model exported from `packages/database/src/models/index.ts`
- [ ] Profile router registered under project routes in `apps/admin/src/routes/index.ts`
- [ ] `requireProjectPermission` used on all profile routes (READ actual signature first)
- [ ] All queries include `tenantId` and `projectId`
- [ ] Cross-tenant access returns 404 (not 403)
- [ ] `createdBy` set from `req.user.userId` on create
- [ ] Optimistic concurrency via `version` field with `$inc`

### Exit Criteria

- [ ] Profile CRUD operations work via API
- [ ] Cross-tenant access returns 404
- [ ] Cross-project access returns 404
- [ ] Profile list is scoped to authenticated tenant/project
- [ ] E2E-7 test scenario passes
- [ ] `pnpm build --filter=admin --filter=database` succeeds
- [ ] SizingProfile model has required indexes

---

## Phase 3: Compare & Breakdown

**Goal:** Add configuration comparison endpoint and tier breakdown details to the calculate response.

**Entry Criteria:**

- Phase 2 exit criteria met

### Files to Create

| #   | File                                                      | Purpose                                         | LOC Est. |
| --- | --------------------------------------------------------- | ----------------------------------------------- | -------- |
| 1   | `packages/sizing-calculator/src/engine/tier-breakdown.ts` | Build TierBreakdown with dimension-level detail | 60       |

### Files to Modify

| #   | File                                                | Change                                      | Impact |
| --- | --------------------------------------------------- | ------------------------------------------- | ------ |
| 1   | `apps/admin/src/routes/sizing/sizing.controller.ts` | Add compare handler                         | Low    |
| 2   | `apps/admin/src/routes/sizing/sizing.service.ts`    | Add compare logic (map over questionnaires) | Low    |
| 3   | `apps/admin/src/routes/sizing/sizing.router.ts`     | Add POST /compare route                     | Low    |
| 4   | `apps/admin/src/routes/sizing/sizing.schemas.ts`    | Add CompareRequest schema                   | Low    |
| 5   | `packages/sizing-calculator/src/index.ts`           | Export `buildTierBreakdown`                 | Low    |

### Implementation Details

**tier-breakdown.ts:**

```typescript
import type { Questionnaire } from '../schemas/questionnaire.schema.js';
import type { Tier } from '../types/topology.types.js';
import { classifyTier } from './tier-classifier.js';

export interface TierBreakdown {
  tier: Tier;
  dimensions: TierDimension[];
  drivingDimension: string;
}

export interface TierDimension {
  name: string;
  value: number;
  sBoundary: number;
  mBoundary: number;
  lBoundary: number;
  exceededTier: Tier | null;
}

export function buildTierBreakdown(questionnaire: Questionnaire): TierBreakdown {
  // Implementation: check each dimension against tier boundaries
  // Identify the dimension that drove the highest tier
}
```

**Compare endpoint:**

- Accepts `{ configurations: Questionnaire[] }` (2-5 items)
- Validates each questionnaire
- Maps each through `calculateTopology()` and `buildTierBreakdown()`
- Returns `{ results: Array<{ topology: ClusterTopology, breakdown: TierBreakdown }> }`

### Wiring Checklist

- [ ] `buildTierBreakdown` exported from `packages/sizing-calculator/src/index.ts`
- [ ] Compare endpoint validates array length (2-5 items)
- [ ] Each questionnaire in the array is individually validated
- [ ] Calculate endpoint now also returns `tierBreakdown` alongside `topology`

### Exit Criteria

- [ ] Compare endpoint returns topologies for 2+ configurations
- [ ] Calculate response includes `tierBreakdown` with dimension details
- [ ] E2E-2 and E2E-6 test scenarios pass
- [ ] `pnpm build --filter=sizing-calculator --filter=admin` succeeds

---

## Phase 4: Studio UI

**Goal:** Build the Studio interface for the sizing questionnaire, topology visualization, and disk growth chart.

**Entry Criteria:**

- Phase 3 exit criteria met
- Studio design system patterns reviewed (invoke `studio-design-system` skill)

### Files to Create

| #   | File                                                      | Purpose                                             | LOC Est. |
| --- | --------------------------------------------------------- | --------------------------------------------------- | -------- |
| 1   | `apps/studio/src/app/sizing/page.tsx`                     | Main sizing page with questionnaire and results     | 80       |
| 2   | `apps/studio/src/app/sizing/layout.tsx`                   | Layout wrapper                                      | 20       |
| 3   | `apps/studio/src/components/sizing/QuestionnaireForm.tsx` | Multi-step form with 8 sections                     | 300      |
| 4   | `apps/studio/src/components/sizing/TopologyView.tsx`      | Topology result display (services, stores, pools)   | 200      |
| 5   | `apps/studio/src/components/sizing/DiskGrowthChart.tsx`   | Line chart for 12-month disk growth projections     | 100      |
| 6   | `apps/studio/src/components/sizing/ExportPanel.tsx`       | Export format selection and download                | 80       |
| 7   | `apps/studio/src/components/sizing/TierBadge.tsx`         | Visual tier indicator (S/M/L/XL with colors)        | 30       |
| 8   | `apps/studio/src/components/sizing/index.ts`              | Barrel export                                       | 10       |
| 9   | `apps/studio/src/store/sizing-store.ts`                   | Zustand store for questionnaire state and API calls | 80       |
| 10  | `apps/studio/src/app/api/sizing/route.ts`                 | API proxy route (if Studio proxies to admin)        | 30       |

### Implementation Details

**QuestionnaireForm.tsx:**

- 8 step form matching the 8 questionnaire sections
- Step navigation with progress indicator
- Field validation using Zod schema (client-side)
- Responsive layout following Studio design system

**TopologyView.tsx:**

- Three sections: Services table, Data Stores table, Node Pools table
- Each row shows name, replicas, CPU, memory, storage, node pool
- TierBadge component shows current tier with color coding
- Managed recommendations shown inline with data stores

**DiskGrowthChart.tsx:**

- Line chart with 7 lines (one per data store)
- X-axis: months (1-12)
- Y-axis: cumulative GB
- Uses existing charting library from Studio (check which one is installed)

**sizing-store.ts:**

```typescript
interface SizingState {
  questionnaire: Partial<Questionnaire>;
  currentStep: number;
  topology: ClusterTopology | null;
  tierBreakdown: TierBreakdown | null;
  isCalculating: boolean;
  error: string | null;
  setQuestionnaireSection: (section: string, data: unknown) => void;
  calculate: () => Promise<void>;
  exportTopology: (format: string) => Promise<Record<string, string>>;
  reset: () => void;
}
```

### Wiring Checklist

- [ ] Sizing page added to Studio navigation/sidebar
- [ ] API calls use SWR or fetch to admin service sizing endpoints
- [ ] Form components follow Studio design system (colors, typography, spacing)
- [ ] Zustand store uses `persist` middleware if needed for draft questionnaires
- [ ] Error states displayed for API failures
- [ ] Loading states shown during calculation

### Exit Criteria

- [ ] Questionnaire form renders all 8 sections with navigation
- [ ] Submitting form calls calculate API and displays topology
- [ ] Disk growth chart renders with data from API response
- [ ] Export panel triggers download of Helm values
- [ ] Manual UI review passes
- [ ] `pnpm build --filter=studio` succeeds

---

## Phase 5: Cost Estimation & Advanced Export

**Goal:** Add cloud cost estimation and Terraform export support.

**Entry Criteria:**

- Phase 4 exit criteria met

### Files to Create

| #   | File                                                              | Purpose                                                    | LOC Est. |
| --- | ----------------------------------------------------------------- | ---------------------------------------------------------- | -------- |
| 1   | `packages/sizing-calculator/src/cost/pricing-data.ts`             | Static pricing data for AWS/Azure/GCP instance types       | 150      |
| 2   | `packages/sizing-calculator/src/cost/cost-estimator.ts`           | Calculate monthly cost from topology + pricing data        | 80       |
| 3   | `packages/sizing-calculator/src/cost/index.ts`                    | Barrel export                                              | 5        |
| 4   | `packages/sizing-calculator/src/generators/terraform-hcl.ts`      | Generate Terraform HCL for node pools and managed services | 150      |
| 5   | `packages/sizing-calculator/src/__tests__/cost-estimator.test.ts` | Unit tests for cost calculation                            | 80       |
| 6   | `packages/sizing-calculator/src/__tests__/terraform-hcl.test.ts`  | Unit tests for Terraform generation                        | 60       |

### Files to Modify

| #   | File                                                 | Change                                                             | Impact |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------ | ------ |
| 1   | `packages/sizing-calculator/src/index.ts`            | Export cost estimator and Terraform generator                      | Low    |
| 2   | `packages/sizing-calculator/src/generators/index.ts` | Export Terraform generator                                         | Low    |
| 3   | `apps/admin/src/routes/sizing/sizing.service.ts`     | Add cost estimation to calculate response; add terraform to export | Low    |
| 4   | `apps/admin/src/routes/sizing/sizing.schemas.ts`     | Add 'terraform' to export format enum                              | Low    |

### Implementation Details

**pricing-data.ts:**

- Static JSON object with monthly prices per instance type per region
- Covers compute instances, storage (per GB/month), managed service base costs
- Updated monthly via `tools/refresh-cloud-pricing.sh` script (manual trigger)
- Falls back gracefully if data is incomplete (returns partial estimate with warning)

**cost-estimator.ts:**

```typescript
export function estimateCost(topology: ClusterTopology, region: string): CostEstimate {
  // Sum compute costs (instance type * count * hours/month)
  // Sum storage costs (GB * price/GB/month)
  // Sum managed service costs (if managed recommendation accepted)
  // Return breakdown: { compute, storage, network, managedServices, monthlyTotal }
}
```

**terraform-hcl.ts:**

- Generate node pool definitions for EKS/AKS/GKE
- Generate managed service declarations (DocumentDB, ElastiCache, etc.)
- Output as `.tf` files per resource category

### Wiring Checklist

- [ ] Cost estimator exported from `packages/sizing-calculator/src/index.ts`
- [ ] Terraform generator exported from `packages/sizing-calculator/src/generators/index.ts`
- [ ] Export endpoint handles `format: 'terraform'`
- [ ] Calculate response optionally includes `costEstimate` when pricing data available
- [ ] Studio UI shows cost breakdown if available
- [ ] Unit tests for cost and Terraform generation pass

### Exit Criteria

- [ ] Cost estimation returns breakdown for all 3 cloud providers
- [ ] Terraform export generates valid HCL for node pools
- [ ] Studio UI displays cost breakdown table
- [ ] `pnpm build --filter=sizing-calculator` succeeds
- [ ] All new unit tests pass
- [ ] INT-8 (cloud provider instance types) passes with Terraform output

---

## Cross-Phase Concerns

### Error Handling (All Phases)

Every new handler/service/repo function must:

1. Validate input at the boundary (Zod for API, type checks for internal)
2. Return platform error envelope on failure: `{ success: false, error: { code, message, details? } }`
3. Use `createLogger('sizing')` -- never console.log
4. Handle errors: `err instanceof Error ? err.message : String(err)`
5. Never swallow errors: no `.catch(() => {})`

### Testing (All Phases)

Each phase adds tests that match the test spec:

- Phase 1: E2E-1, E2E-3, E2E-4, E2E-5, E2E-8 + INT-1, INT-6, INT-8
- Phase 2: E2E-7 + INT-3, INT-4
- Phase 3: E2E-2, E2E-6 + INT-2, INT-5
- Phase 4: Manual UI review
- Phase 5: Cost unit tests, Terraform unit tests

### Pre-Commit Checklist (All Phases)

Before every commit:

1. `npx prettier --write <changed-files>`
2. `pnpm build --filter=<affected-packages>`
3. `pnpm test --filter=<affected-packages>`
4. Verify no `console.log`, no `findById()`, no `.catch(() => {})`

---

## Dependency Graph

```
Phase 1 (API Core)
  └── Phase 2 (Profile Persistence)
       └── Phase 3 (Compare & Breakdown)
            ├── Phase 4 (Studio UI)
            └── Phase 5 (Cost & Export)
```

Phases 4 and 5 are independent of each other and can be parallelized.

---

## Summary

| Phase     | Files Created | Files Modified | LOC Est.   | Key Deliverable                    |
| --------- | ------------- | -------------- | ---------- | ---------------------------------- |
| 1         | 5             | 2              | 325        | Calculate + Export + Tiers API     |
| 2         | 5             | 2              | 420        | Profile CRUD with tenant isolation |
| 3         | 1             | 5              | 60         | Compare endpoint + TierBreakdown   |
| 4         | 10            | 0              | 930        | Studio UI (form, topology, chart)  |
| 5         | 6             | 4              | 525        | Cost estimation + Terraform export |
| **Total** | **27**        | **13**         | **~2,260** | **Full feature delivery**          |
