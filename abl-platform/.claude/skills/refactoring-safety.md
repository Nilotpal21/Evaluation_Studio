---
name: refactoring-safety
description: Use when performing large refactors, consolidating duplicate code, migrating to new patterns, or delegating execution to new modules. Provides strangler pattern, shadow mode, and parity testing techniques to prevent regressions.
---

# Refactoring Safety

## Overview

Safe refactoring patterns for large-scale codebase changes. Every refactor in this codebase uses the strangler pattern with shadow execution — never big-bang rewrites.

## When to Use

- Consolidating runtime executors (2,626 + 4,105 LOC)
- Extracting services from route handlers (1,700 LOC connectors.ts)
- Splitting shared package into focused packages
- Migrating any established pattern to a new one
- Any change touching >500 LOC across multiple files

## Core Pattern: Strangler + Shadow

```
1. Write parity tests  -->  2. Build new path alongside old
                                     |
                                     v
                         3. Shadow: run both, compare
                                     |
                                     v
                         4. Parity >= 99.5%?
                           /              \
                         no                yes
                          |                 |
                     fix gaps         5. Cutover
                          |                 |
                     back to 3        6. Monitor 1 sprint
                                           |
                                     7. Remove old path
```

## Step 1: Parity Test Harness

Before changing anything, capture current behavior as test fixtures:

```typescript
// apps/runtime/src/__tests__/pre-refactor/gather-parity.test.ts
describe('Gather execution parity', () => {
  const fixtures = loadFixtures('gather-scenarios.json');

  for (const fixture of fixtures) {
    it(`produces same output for: ${fixture.name}`, async () => {
      const oldResult = await oldGatherPath(fixture.input);
      const newResult = await newGatherExecutor(fixture.input);

      expect(newResult.fields).toEqual(oldResult.fields);
      expect(newResult.validationErrors).toEqual(oldResult.validationErrors);
      expect(newResult.nextStep).toEqual(oldResult.nextStep);
    });
  }
});
```

### Fixture Collection Strategy

- Record real execution traces from development/staging
- Include edge cases: timeouts, validation failures, multi-turn gather
- Minimum 20 fixtures per execution path being refactored

## Step 2: Build New Path Alongside Old

Never delete the old code until the new code is proven:

```typescript
// New module lives next to old
// apps/runtime/src/services/execution/gather-executor.ts (NEW)
// apps/runtime/src/services/execution/flow-step-executor.ts (OLD, still active)

export class GatherExecutor {
  async execute(context: ExecutionContext): Promise<GatherResult> {
    // New implementation extracted from flow-step-executor.ts
  }
}
```

## Step 3: Shadow Execution

Run both paths and compare outputs:

```typescript
async executeGather(session: RuntimeSession, step: FlowStep) {
  const oldResult = await this.oldGatherPath(session, step);

  if (featureFlags.get('shadow-gather-executor')) {
    try {
      const newResult = await this.gatherExecutor.execute(
        this.mapToContext(session, step)
      );

      if (!deepEqual(oldResult, newResult)) {
        logger.warn('gather-parity-mismatch', {
          sessionId: session.id,
          stepId: step.id,
          diff: diffObjects(oldResult, newResult),
        });
      }
    } catch (err) {
      logger.error('shadow-gather-error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return oldResult; // Always return old result during shadow phase
}
```

## Step 4: Cutover Criteria

Only switch when ALL are met:

- [ ] Parity >= 99.5% over 1 week of shadow traffic
- [ ] Zero shadow errors for 48 hours
- [ ] All parity test fixtures pass
- [ ] Performance within 10% of old path (measure p50, p95, p99)

## Step 5: Cleanup

After one sprint of stability on the new path:

- Remove old code path
- Remove shadow comparison logic
- Remove feature flag
- Update architecture scorecard (`tools/architecture-scorecard.sh`)

## Exit Criteria Template

For every refactoring phase, define:

```markdown
### Phase N Exit Criteria

- [ ] Parity tests: X fixtures, all passing
- [ ] Shadow mode: >= 99.5% match over Y period
- [ ] Performance: p95 latency within 10% of baseline
- [ ] Zero sev1/sev2 regressions
- [ ] Code review approved
- [ ] Old path removable (no remaining callers)
```

## Anti-Patterns

| Anti-Pattern                        | Why It Fails                     | Do Instead               |
| ----------------------------------- | -------------------------------- | ------------------------ |
| Big-bang rewrite                    | Untestable, high regression risk | Strangler + shadow       |
| "Just swap it" without parity tests | Silent behavior changes          | Write fixtures FIRST     |
| Removing old code immediately       | No rollback path                 | Wait one sprint          |
| Shadow mode without telemetry       | Can't measure parity             | Log every mismatch       |
| Skipping edge case fixtures         | Regressions in uncommon paths    | Min 20 fixtures per path |

## Key Files

| File                                                        | Purpose                                |
| ----------------------------------------------------------- | -------------------------------------- |
| `docs/TODO-RUNTIME-ENGINE-CONSOLIDATION.md`                 | Master plan for runtime refactoring    |
| `apps/runtime/src/services/runtime-executor.ts`             | Primary refactoring target (2,626 LOC) |
| `apps/runtime/src/services/execution/flow-step-executor.ts` | Delegation source (4,105 LOC)          |
| `apps/runtime/src/__tests__/pre-refactor/`                  | Parity test fixtures location          |
