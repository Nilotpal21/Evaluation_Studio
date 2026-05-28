---
name: coverage-ramp
description: Use when adding tests, reviewing test coverage, setting coverage targets, or deciding what to test first for maximum impact. Provides progressive coverage targets and testing strategy for each app.
---

# Coverage Ramp

## Overview

Progressive coverage improvement strategy. Current thresholds are low — the goal is steady improvement each sprint, not heroic one-time efforts. Test new code first, then add tests for code being refactored.

## Current vs Target Thresholds

| Package                  | Current Lines | Current Branches | Current Functions | Target Lines (Sprint 4) |
| ------------------------ | ------------- | ---------------- | ----------------- | ----------------------- |
| `apps/runtime`           | 12%           | 11%              | 16%               | 35%                     |
| `apps/studio`            | 7%            | 4%               | 12%               | 30%                     |
| `apps/search-ai`         | 24%           | 19%              | 16%               | 45%                     |
| `apps/search-ai-runtime` | 46%           | 39%              | 46%               | 55%                     |
| `packages/compiler`      | 75%           | 59%              | 69%               | 80%                     |
| `packages/database`      | 53%           | 31%              | 31%               | 60%                     |
| `packages/core`          | 69%           | 55%              | 92%               | 75%                     |
| `packages/project-io`    | 86%           | 77%              | 78%               | 90%                     |

Thresholds file: `coverage-thresholds.json`

## Priority: What to Test First

### Tier 1: Highest ROI

1. **New code** — every new file gets tests (non-negotiable)
2. **Code being refactored** — parity tests before changing anything
3. **Auth/isolation paths** — authz tests prevent security regressions
4. **Route handlers** — integration tests catch wiring issues

### Tier 2: High Value

5. **Service layer** — unit tests for business logic
6. **Error paths** — ensure errors propagate correctly
7. **Queue job processors** — test job handling with mock queue

### Tier 3: Fill In

8. **Utility functions** — pure functions are easy to test
9. **Middleware** — test middleware chain behavior
10. **UI components** — snapshot/interaction tests

## Test Patterns by Layer

### Route Integration Test

```typescript
describe('POST /api/projects/:projectId/connectors', () => {
  it('creates connector with valid input', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/connectors`)
      .set('Authorization', `Bearer ${token}`)
      .send(validPayload);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).post(`/api/projects/${projectId}/connectors`).send(validPayload);
    expect(res.status).toBe(401);
  });

  it('returns 404 for cross-tenant access', async () => {
    const res = await request(app)
      .post(`/api/projects/${otherTenantProjectId}/connectors`)
      .set('Authorization', `Bearer ${token}`)
      .send(validPayload);
    expect(res.status).toBe(404);
  });
});
```

### Service Unit Test

```typescript
describe('ConnectorService.create', () => {
  it('creates with tenant scoping', async () => {
    const result = await service.create({
      name: 'test',
      tenantId: 'tenant-1',
      projectId: 'project-1',
    });
    expect(result.tenantId).toBe('tenant-1');
  });

  it('throws on duplicate name within tenant', async () => {
    await service.create({ name: 'dup', tenantId: 't1', projectId: 'p1' });
    await expect(service.create({ name: 'dup', tenantId: 't1', projectId: 'p1' })).rejects.toThrow(
      /duplicate/i,
    );
  });
});
```

### Parity Test (for refactoring)

```typescript
describe('GatherExecutor parity', () => {
  const fixtures = require('./fixtures/gather-scenarios.json');

  fixtures.forEach((fixture) => {
    it(`matches old behavior: ${fixture.name}`, async () => {
      const newResult = await gatherExecutor.execute(fixture.input);
      expect(newResult).toMatchObject(fixture.expectedOutput);
    });
  });
});
```

## Coverage Improvement Workflow

1. Run `pnpm test --coverage` to see current state
2. Identify uncovered files in the area you're working on
3. Add tests for YOUR changes first (new code = new tests)
4. If time allows, add tests for adjacent untested code
5. Update `coverage-thresholds.json` when new floor is established

## Key Files

| File                                 | Purpose                           |
| ------------------------------------ | --------------------------------- |
| `coverage-thresholds.json`           | Current enforced thresholds       |
| `apps/runtime/src/__tests__/`        | Runtime test examples             |
| `packages/compiler/src/__tests__/`   | High-coverage test examples (75%) |
| `packages/project-io/src/__tests__/` | High-coverage test examples (86%) |
