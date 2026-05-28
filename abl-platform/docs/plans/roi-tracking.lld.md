# ROI Tracking -- Low-Level Design

**Status**: STABLE
**Feature Spec**: [../features/roi-tracking.md](../features/roi-tracking.md)
**HLD**: [../specs/roi-tracking.hld.md](../specs/roi-tracking.hld.md)
**Testing Guide**: [../testing/roi-tracking.md](../testing/roi-tracking.md)
**Last Updated**: 2026-03-22

---

## Task T-1: ProjectCostConfig Mongoose Schema

### Files

- `packages/pipeline-engine/src/schemas/project-cost-config.schema.ts` -- 53 lines

### Interface: `IProjectCostConfig`

```typescript
interface IProjectCostConfig extends Document {
  tenantId: string;
  projectId: string;
  costPerHumanInteraction: number;
  costPerAIInteraction: number;
  fteCapacityPerDay: number;
  fteCostPerYear: number;
  monthlyBudget: number;
  containmentRate: number;
  totalConversationsPerMonth: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}
```

### Schema Details

- Collection: `project_cost_configs`
- All numeric fields required
- Timestamps: `{ timestamps: true }`
- Unique index: `{ tenantId: 1, projectId: 1 }`

### Export

- Exported via `packages/pipeline-engine/src/index.ts` as `ProjectCostConfigModel` and `IProjectCostConfig`

---

## Task T-2: ROICalculator Service

### Files

- `packages/pipeline-engine/src/pipeline/services/roi-calculator.service.ts` -- 92 lines

### Exported Types

```typescript
interface ROISummary {
  monthlySavings: number;
  annualSavings: number;
  fteEquivalent: number;
  roiPercentage: number;
  budgetStatus: 'under' | 'at' | 'over';
  budgetRemaining: number;
}

interface SimulationResult {
  currentContainment: number;
  simulatedContainment: number;
  currentMonthlySavings: number;
  simulatedMonthlySavings: number;
  additionalSavings: number;
  additionalFTEFreed: number;
}
```

### Methods

**`computeSavings(config)`**: `totalConversations * containmentRate * (humanCost - aiCost)`, rounded to 2 decimals.

**`computeFTEEquivalent(config)`**: `aiHandled / (fteCapacityPerDay * 22)`, rounded to 2 decimals.

**`computeROI(config)`**: `(monthlySavings / monthlyAICost) * 100`, rounded to 2 decimals. Returns 0 if `monthlyAICost === 0`.

**`computeBudgetStatus(config)`**: Returns `{ status: 'under'|'at'|'over', remaining }`.

**`computeSummary(config)`**: Calls all above methods, returns `ROISummary`. Logs at debug level.

**`simulateContainmentChange(config, newContainmentRate)`**: Creates modified config with new rate, computes current and simulated metrics, returns deltas.

### Key Implementation Detail

- All rounding: `Math.round(x * 100) / 100`
- Working days constant: `22`
- Uses `{ ...config, containmentRate: newRate }` spread for simulation (creates plain object, requires `as IProjectCostConfig` cast)

---

## Task T-3: ROI Route

### Files

- `apps/runtime/src/routes/roi.ts` -- 288 lines, 5 endpoints

### Lazy Imports

```typescript
async function getCostConfigModel() {
  const { ProjectCostConfigModel } = await import('@agent-platform/pipeline-engine');
  return ProjectCostConfigModel;
}
async function getROICalculator() {
  const { ROICalculator } = await import('@agent-platform/pipeline-engine');
  return new ROICalculator();
}
```

### Endpoints

**GET /config** -- Get cost configuration

- Permission: `session:read`
- Query: `ProjectCostConfigModel.findOne({ tenantId, projectId }).lean()`
- Returns: `{ success: true, data: config | null }`

**PUT /config** -- Create or update cost configuration

- Permission: `project:write`
- Upsert: `findOneAndUpdate({ tenantId, projectId }, { $set: body fields }, { upsert: true })`
- Body fields extracted: `costPerHumanInteraction`, `costPerAIInteraction`, `fteCapacityPerDay`, `fteCostPerYear`, `monthlyBudget`, `containmentRate`, `totalConversationsPerMonth`
- Records `createdBy` from `req.tenantContext.userId`
- Note: No validation on individual field types or ranges

**GET /summary** -- Full ROI summary

- Permission: `session:read`
- Loads config from MongoDB; if null, returns `{ data: null }`
- Instantiates `ROICalculator`, calls `computeSummary(config as any)`
- Returns: `ROISummary` object

**GET /budget** -- Budget status

- Permission: `session:read`
- Loads config from MongoDB; if null, returns `{ data: null }`
- Calls `calculator.computeBudgetStatus(config as any)`
- Returns: `{ status, remaining }`

**POST /simulate** -- Containment rate simulation

- Permission: `session:read`
- Body: `{ containmentRate }` -- validated as number between 0 and 1
- Loads config from MongoDB; if null, returns 404
- Calls `calculator.simulateContainmentChange(config as any, containmentRate)`
- Returns: `SimulationResult`

---

## Task T-4: Unit Tests

### Files

- `packages/pipeline-engine/src/__tests__/roi-calculator.test.ts` -- 109 lines, 8 test cases

### Test Config

Standard config for all tests: `100K convos, 0.72 containment, $5.00 human, $0.15 AI, 40/day FTE capacity, $55K/year, $50K budget`

### Test Cases

| Test                          | Expected Result                          |
| ----------------------------- | ---------------------------------------- |
| computeSavings                | 349,200                                  |
| computeFTEEquivalent          | 81.82                                    |
| computeROI                    | 3,233.33%                                |
| computeBudgetStatus (under)   | status: 'under', remaining: 39,200       |
| computeBudgetStatus (over)    | status: 'over', remaining: -5,800        |
| simulateContainmentChange     | +63,050 savings, +14.77 FTE freed        |
| computeSummary                | All fields match individual computations |
| computeROI (zero containment) | Returns 0 (no division by zero)          |

---

## Task T-5: Server Wiring

### Files

- `apps/runtime/src/server.ts` -- import at line 108, mount at line 528

### Mount Point

```typescript
app.use('/api/projects/:projectId/roi', roiRouter);
```

---

## Known Gaps

| ID      | Description                                                      | Severity |
| ------- | ---------------------------------------------------------------- | -------- |
| GAP-001 | No route-level tests (auth, validation, MongoDB, error handling) | High     |
| GAP-002 | PUT /config has no field-level validation (types, ranges)        | Medium   |
| GAP-003 | `config as any` type cast in route handlers                      | Low      |
| GAP-004 | ROI based on manual inputs, not real conversation data           | Medium   |
| GAP-005 | No historical tracking of config changes or ROI metrics          | Medium   |
| GAP-006 | Working days hardcoded as 22                                     | Low      |
| GAP-007 | `fteCostPerYear` stored but not used in any computation          | Low      |

---

## Dependencies

- `@agent-platform/pipeline-engine` -- ProjectCostConfigModel, ROICalculator exports
- `@agent-platform/openapi/express` -- OpenAPI router creation
- `@agent-platform/shared-auth` -- `requireProjectScope`
- `@abl/compiler/platform` -- `createLogger`
- `apps/runtime/src/middleware/auth.js` -- `authMiddleware`
- `apps/runtime/src/middleware/rate-limiter.js` -- `tenantRateLimit`
- `apps/runtime/src/middleware/rbac.js` -- `requireProjectPermission`

---

## Exit Criteria

- Cost config CRUD works with correct tenant/project isolation
- ROI summary computation matches expected values for standard config
- Budget status correctly classifies under/at/over
- Simulation correctly computes deltas between current and simulated containment
- Division-by-zero guard returns 0 for zero containment rate
- All calculator unit tests pass: `pnpm test --filter=pipeline-engine -- roi-calculator`
