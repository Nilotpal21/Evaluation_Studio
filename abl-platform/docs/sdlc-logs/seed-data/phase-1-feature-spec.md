# SDLC Log: Seed Data -- Phase 1 (Feature Spec)

**Date:** 2026-03-23
**Phase:** Feature Spec
**Artifact:** `docs/features/seed-data.md`

## Summary

Generated feature spec for the seed data infrastructure consolidation. Analyzed 7 existing seed scripts (`seed-mongo.ts`, `seed-tenant.ts`, `seed-tools.ts`, `seed-pipelines.ts`, `seed-prompt-templates.ts`, `seed-travel-workflows.ts`, `seed-secrets.ts`), the runtime `/api/seed-data` route, and the Studio proxy route.

## Key Decisions

| Decision                                     | Classification | Rationale                                                           |
| -------------------------------------------- | -------------- | ------------------------------------------------------------------- |
| Unify under orchestrator pattern             | DECIDED        | 5+ duplicated upsert helpers, no single entry point                 |
| Keep individual scripts functional           | DECIDED        | Backward compatibility for existing CI/CD                           |
| Zod validation before DB writes              | DECIDED        | No current validation; schema drift causes silent data corruption   |
| Fix workflow idempotency (deterministic IDs) | DECIDED        | `seed-travel-workflows.ts` generates random UUIDs on every run      |
| Out-of-scope: UI admin panel                 | DECIDED        | Low priority; CLI-first approach aligns with platform team workflow |

## Codebase Files Read

- `apps/runtime/src/routes/seed-data.ts` (runtime API)
- `apps/studio/src/app/api/seed-data/route.ts` (Studio proxy)
- `packages/database/seed-mongo.ts` (main seed script, 919 lines)
- `scripts/seed-tenant.ts` (per-tenant seeding)
- `scripts/seed-tools.ts` (DSL tool extraction)
- `scripts/seed-pipelines.ts` (pipeline definitions)
- `scripts/seed-prompt-templates.ts` (prompt catalog seeding)
- `scripts/seed-secrets.ts` (AWS Secrets Manager)
- `scripts/seed-travel-workflows.ts` (workflow records)
- `packages/pipeline-engine/src/pipeline/seed-node-types.ts`
- `packages/database/src/constants/system-roles.ts`
- `packages/database/src/migrations/cli.ts`
