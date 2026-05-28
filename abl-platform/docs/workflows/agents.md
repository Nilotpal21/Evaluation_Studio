# Workflows — agents.md (Hub)

Central index for the workflows feature. Start here, then follow links to domain-specific agents.md files.

Agents MUST read this file before working on any workflows-related code. This file points you to the right place.

---

## Architecture at a Glance

The workflow system spans **4 layers** across the monorepo:

| Layer                | Package                                                          | What It Does                                                               | agents.md                                        |
| -------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------ |
| **Shared Types**     | `packages/shared`, `packages/shared-kernel`, `packages/database` | TypeScript types, Zod schemas, Mongoose models                             | `packages/shared/src/types/agents.md`            |
| **Execution Engine** | `apps/workflow-engine`                                           | Restate-backed durable execution, 12 step executors, triggers, human tasks | `apps/workflow-engine/agents.md`                 |
| **API Gateway**      | `apps/runtime`                                                   | CRUD + proxy to engine, auth, validation                                   | `apps/runtime/src/routes/agents.md`              |
| **UI**               | `apps/studio`                                                    | ReactFlow canvas, config panels, debug panel, Zustand stores               | `apps/studio/src/components/workflows/agents.md` |
| **E2E Tests**        | `apps/studio/e2e/workflows`                                      | Playwright tests — lifecycle, nodes, triggers, monitor                     | `apps/studio/e2e/workflows/agents.md`            |

## Where Things Live

### Documentation

| Doc                      | Location                                                | Purpose                                                      |
| ------------------------ | ------------------------------------------------------- | ------------------------------------------------------------ |
| Deployment & Components  | `docs/workflows/workflows-deployment-and-components.md` | Topology, ports, inter-service flows, env vars, Docker setup |
| High-Level Understanding | `docs/workflows/workflows-high-level-understanding.md`  | DB schema, execution data flow, context resolution           |
| Feature Spec             | `docs/features/workflows.md`                            | Requirements, user stories, scope                            |
| HLD                      | `docs/specs/workflows.hld.md`                           | Architecture, 12 concerns                                    |
| LLD                      | `docs/plans/workflows.lld.md`                           | Implementation plan                                          |
| Test Spec                | `docs/testing/workflows.md`                             | Coverage matrix, E2E + integration scenarios                 |
| Sub-feature specs        | `docs/features/sub-features/workflow-*.md`              | Triggers, editor modes, copilot, function node               |
| Change specs             | `docs/specs/workflow-*.changes.md`                      | Incremental design docs for specific changes                 |

### Code

| Area                | Key Entry Points                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workflow types      | `packages/shared-kernel/src/types/workflow-types.ts` (source), `packages/shared/src/types/workflow-types.ts` (compat re-export), `workflow-schemas.ts` |
| DB models           | `packages/database/src/models/workflow.model.ts`, `workflow-execution.model.ts`, `workflow-version.model.ts`, `workflow-api-key.model.ts`              |
| Engine entry        | `apps/workflow-engine/src/index.ts`                                                                                                                    |
| Engine handler      | `apps/workflow-engine/src/handlers/workflow-handler.ts`                                                                                                |
| Canvas-to-steps     | `apps/workflow-engine/src/handlers/canvas-to-steps.ts`                                                                                                 |
| Expression resolver | `apps/workflow-engine/src/context/expression-resolver.ts`                                                                                              |
| Step executors      | `apps/workflow-engine/src/executors/*.ts` (12 executors)                                                                                               |
| Runtime CRUD routes | `apps/runtime/src/routes/workflows.ts`                                                                                                                 |
| Runtime proxy       | `apps/runtime/src/middleware/workflow-engine-proxy.ts`                                                                                                 |
| Studio canvas       | `apps/studio/src/components/workflows/canvas/WorkflowCanvas.tsx`                                                                                       |
| Canvas store        | `apps/studio/src/store/workflow-canvas-store.ts`                                                                                                       |
| Studio API client   | `apps/studio/src/api/workflows.ts`                                                                                                                     |
| Studio BFF routes   | `apps/studio/src/app/api/projects/[id]/workflows/`                                                                                                     |
| E2E helpers         | `apps/studio/e2e/workflows/helpers.ts`                                                                                                                 |

## Local Setup — Quick Start

```bash
# 1. Start infrastructure (Docker): workflow-engine, restate, mongo, redis
docker compose up -d

# 2. Start Studio + Runtime (local dev with hot-reload)
pnpm dev:workflows
```

Full setup details: `docs/workflows/workflows-deployment-and-components.md` (Section 5).

### Service Ports

| Service                      | Port  | Notes                                           |
| ---------------------------- | ----- | ----------------------------------------------- |
| Studio                       | 5173  | Hot-reload via Turbopack                        |
| Runtime                      | 3112  | Hot-reload via tsx                              |
| Workflow Engine (Express)    | 9080  | Docker — requires rebuild                       |
| Workflow Engine (Restate H2) | 9081  | Docker — requires rebuild                       |
| Restate Admin                | 9070  | Docker                                          |
| Restate Ingress              | 8091  | Docker (mapped from 8080)                       |
| MongoDB                      | 27018 | Docker (mapped from 27017)                      |
| Redis                        | 6380  | Docker (mapped from 6379), password: `localdev` |

### After Code Changes

| Changed                       | Action                                                         |
| ----------------------------- | -------------------------------------------------------------- |
| `apps/workflow-engine/src/**` | Docker rebuild required (see `apps/workflow-engine/agents.md`) |
| `apps/studio/src/**`          | Auto hot-reload                                                |
| `apps/runtime/src/**`         | Auto hot-reload                                                |
| `packages/**`                 | `pnpm build --filter=<pkg>`, then restart consumers if needed  |

## Cross-Cutting Concerns

### Request Flow (Execute)

```
Browser -> Studio BFF -> Workflow Engine -> Restate -> Engine (H2 callback)
                                                         -> Step Executors
                                                         -> MongoDB (persist)
                                                         -> Redis Pub/Sub (status)
```

### Request Flow (CRUD)

```
Browser -> Studio BFF -> Runtime -> MongoDB
```

### Key Invariants

1. **Tenant + Project isolation** on every MongoDB query
2. **JWT_SECRET must match** across Studio, Runtime, and Workflow Engine
3. **Restate replays** — all MongoDB ops in Restate handlers must be idempotent (upsert, not insert)
4. **Node names are unique** per workflow — enforced in UI store and server-side
5. **Steps indexed by both UUID and name** in `ctx.steps` — tests checking step count must account for doubling

## Sync Protocol

| Trigger                    | What to Update                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------- |
| After any workflow commit  | Relevant domain `agents.md` learnings section                                          |
| After E2E test changes     | `apps/studio/e2e/workflows/agents.md` coverage tracker                                 |
| After new node type        | UI agents.md (config panel), engine agents.md (executor), E2E agents.md (coverage gap) |
| After architecture changes | Engine agents.md + this hub                                                            |
| After `/post-impl-sync`    | This hub gets a status refresh                                                         |

---

<!-- Append cross-cutting learnings below this line. Format:
## <DATE> — <Topic>
**Learning**: <what was learned>
**Impact**: <how this affects workflows work>
-->

## 2026-04-15 — Workflow Engine API Port And Restate Port Must Stay Distinct

**Learning**: Runtime and Studio call the workflow-engine Express API on `9080`. Port `9081` is the separate Restate service endpoint and should only be used for Restate registration/callback wiring, not normal workflow HTTP traffic.
**Impact**: When a workflow caller reports "engine unreachable," verify which port it is using before chasing auth or route bugs.

## 2026-04-15 — Record Workflow E2E Claims At The Right Fidelity

**Learning**: A single public-API regression test is enough to stop saying a workflow area has zero E2E coverage, but it is not evidence that the feature is broadly beta-ready or production-wired. Workflow docs and agents logs should say whether coverage is a narrow regression, local-dev only, or verified against deployed wiring.
**Impact**: Post-implementation sync work should separate implemented behavior from deployment reachability and avoid overstating completeness.
