---
name: architecture-simplification
description: Use when refactoring routes, extracting services, splitting packages, simplifying executors, or any work that reduces codebase complexity. Also use when asked to thin handler, verticalize, extract, decompose, or consolidate code.
---

# Architecture Simplification

## Overview

Standards and patterns for the ongoing architecture simplification effort. Target: unified execution core, thin route handlers, strict layered modules, decomposed shared package, and enforced boundaries.

## Target Architecture

```
Route (auth + validate + delegate)
  -> Application Service (orchestration + transactions)
    -> Domain Service (business logic)
      -> Repository (data access + tenant scoping)
        -> Model (Mongoose/Prisma)
```

## Current State vs Target

| Area               | Current                          | Target                                        | Metric                          |
| ------------------ | -------------------------------- | --------------------------------------------- | ------------------------------- |
| Runtime executor   | 2,626 LOC monolith               | Thin orchestration shell (~1,500 LOC)         | 40% reduction                   |
| Flow step executor | 4,105 LOC                        | Delegated sub-executors                       | Each <500 LOC                   |
| connectors.ts      | 1,700 LOC (route+DB+queue+OAuth) | Route <300 LOC + services                     | Route file max 300 LOC          |
| Studio API         | 294 route handlers               | Thin handlers, domain services                | No direct Model calls in routes |
| Shared package     | 115 files, depends on database   | shared-kernel (types only) + concern packages | No DB dependency in kernel      |
| Coverage           | Runtime 12%, Studio 7%           | Runtime 35%, Studio 30%                       | Progressive ramp per sprint     |

## Route Standards

**Max 300 LOC per route file.** Route files do ONLY:

1. Auth middleware (`requireAuth`, `requireProjectPermission`)
2. Input validation (Zod `.parse()`)
3. Service call (single function)
4. Response mapping (standard envelope)

### What Does NOT Belong in Routes

| Violation                           | Move To                     |
| ----------------------------------- | --------------------------- |
| `Model.findOne()`, `Model.create()` | Repository layer            |
| `queue.add()`, `new Queue()`        | Application service         |
| OAuth state management              | Auth service                |
| Business logic / conditionals       | Domain service              |
| Redis `get`/`set` for caching       | Cache service or repository |
| Error transformation                | Error middleware            |

### Route Refactoring Pattern

```typescript
// BEFORE: 500 LOC route with mixed concerns
router.post('/', async (req, res) => {
  const config = await ConnectorConfig.findOne({ tenantId: req.tenantId });
  // ... 80 lines of validation ...
  // ... 60 lines of business logic ...
  // ... queue.add(...) ...
  res.json(result);
});

// AFTER: Thin route delegating to service
router.post('/', requireProjectPermission(req, res, 'connector:create'), async (req, res) => {
  const body = CreateConnectorSchema.parse(req.body);
  const result = await connectorService.create({
    ...body,
    tenantId: req.tenantId,
    projectId: req.params.projectId,
  });
  res.json({ success: true, data: result });
});
```

## Shared Package Decomposition

### Target Split

| Package                | Contains                                  | Dependencies       |
| ---------------------- | ----------------------------------------- | ------------------ |
| `shared-kernel`        | Types, error codes, contracts, constants  | Zero internal deps |
| `shared-auth`          | Auth middleware, permission helpers       | shared-kernel      |
| `shared-observability` | Logger factory, trace helpers, metrics    | shared-kernel      |
| `shared-security`      | Encryption, SSRF protection, sanitization | shared-kernel      |

### Rules

- `shared-kernel` MUST NOT depend on `@agent-platform/database`
- Apps import only the concern package they need, not omnibus `shared`
- No reverse coupling: domain packages never import from app packages

## Runtime Consolidation

Follow the phased plan in `docs/TODO-RUNTIME-ENGINE-CONSOLIDATION.md`:

### Delegation Order (safest first)

1. Gather execution -> `GatherExecutor`
2. Constraint evaluation -> `ConstraintExecutor`
3. Completion checking -> `CompleteExecutor`
4. Handoff/delegate -> `HandoffExecutor`, `DelegateExecutor`
5. Flow stepping -> `FlowExecutor`
6. Reasoning zones -> `ReasoningExecutor`

### Safe Refactoring Protocol

1. **Write parity tests first** — capture current behavior as test fixtures
2. **Extract to new module** — new code alongside old
3. **Shadow mode** — run both paths, compare outputs, log mismatches
4. **Cutover** — switch to new path when parity >= 99.5%
5. **Cleanup** — remove old path after one sprint of stability

Use the `refactoring-safety` skill for detailed strangler/shadow patterns.

## Repository Pattern

Template for tenant-scoped data access:

```typescript
class ConnectorRepository {
  async findById(id: string, tenantId: string) {
    return ConnectorConfig.findOne({ _id: id, tenantId });
  }

  async create(data: CreateConnectorDto & { tenantId: string }) {
    return ConnectorConfig.create(data);
  }

  async updateById(id: string, tenantId: string, update: UpdateConnectorDto) {
    return ConnectorConfig.findOneAndUpdate({ _id: id, tenantId }, update, { new: true });
  }
}
```

## Automated Scorecard

Run `tools/architecture-scorecard.sh` to measure progress:

```bash
tools/architecture-scorecard.sh              # Full scorecard
tools/architecture-scorecard.sh --routes     # Route complexity only
tools/architecture-scorecard.sh --shared     # Shared package coupling
tools/architecture-scorecard.sh --coverage   # Coverage vs targets
```

## Key Files

| File                                                        | Purpose                                   |
| ----------------------------------------------------------- | ----------------------------------------- |
| `docs/TODO-RUNTIME-ENGINE-CONSOLIDATION.md`                 | Runtime consolidation phases              |
| `apps/runtime/src/services/runtime-executor.ts`             | 2,626 LOC — primary simplification target |
| `apps/runtime/src/services/execution/flow-step-executor.ts` | 4,105 LOC — delegation target             |
| `apps/search-ai/src/routes/connectors.ts`                   | 1,700 LOC — route refactoring pilot       |
| `packages/shared/package.json`                              | Current coupling (depends on database)    |
| `coverage-thresholds.json`                                  | Current coverage gates                    |
| `tools/architecture-scorecard.sh`                           | Automated architecture metrics            |
