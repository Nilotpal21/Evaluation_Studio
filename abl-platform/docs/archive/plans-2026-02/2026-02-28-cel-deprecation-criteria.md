# Legacy Expression Evaluator Deprecation Criteria

## Current State

After CEL Phase 2, all expression evaluation paths go through the dual evaluator
(CEL-first, legacy fallback). The legacy evaluator is only invoked when CEL fails.

## Counters to Monitor

| Counter                                 | Source                  | Meaning                               |
| --------------------------------------- | ----------------------- | ------------------------------------- |
| `celMetrics.celSuccess`                 | `dual-evaluator.ts`     | CEL evaluated successfully            |
| `celMetrics.celFallback`                | `dual-evaluator.ts`     | CEL failed, used legacy               |
| `celMetrics.nullInjections`             | `dual-evaluator.ts`     | Missing identifiers injected as null  |
| `constraint_guard_skipped` trace events | `constraint-checker.ts` | Guard caused constraint to be skipped |

## Deprecation Gate

The legacy evaluator can be removed when ALL of the following are true:

1. **`celFallback` is 0** across all production tenants for 30 consecutive days
2. **No new ABL expressions** use legacy-only syntax (all new agents use CEL or YAML)
3. **Migration tooling** has been run on all existing agent definitions to convert
   legacy ABL expressions to CEL syntax at the DSL level
4. **Integration tests** cover every expression pattern that currently triggers fallback

## Removal Plan

1. Add a `LEGACY_EVALUATOR_ENABLED` feature flag (default: true)
2. Set to false in staging, run full test suite
3. Monitor for 14 days in staging
4. Set to false in production, monitor for 30 days
5. Remove legacy evaluator code, `isLegacyExpression`, `migrateExpression`
6. Remove `celMetrics.celFallback` counter
7. Simplify `evaluateConditionDual` -> `evaluateCondition` (direct CEL only)

## Estimated Timeline

- Phase 2 complete: March 2026
- Monitoring period: March-April 2026
- Legacy removal (if criteria met): May 2026
