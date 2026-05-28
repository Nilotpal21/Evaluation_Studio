# Data Flow Audit: Redis Dual-Mode Review Fixes

Date: 2026-05-10
Branch: `worktree-redis-cluster-dual-mode`

## Scope

Review-triggered audit for Redis dual-mode configuration fields and queue key
propagation:

- `redis.password` / `REDIS_PASSWORD`
- `redis.tls` / `REDIS_TLS` / `REDIS_TLS_ENABLED`
- `redis.cluster` / `REDIS_CLUSTER`
- BullMQ prefix `{bull}` for TypeScript producers and the Go crawler worker
- Removed duplicate runtime `parseRedisUrl` helper

The auth-profile-specific `data-propagation-audit` was also considered because
the branch touches auth-profile files. Those changes only adjust Redis client
typing/locking and UI close/toast behavior; they do not add, remove, or modify
OAuth/auth-profile config or secret fields, so the 8-layer OAuth field matrix is
not applicable to this fix commit.

## Propagation Matrix

| Field / Value                    | Definition                                                                    | Env Mapping                                                            | Admin Config Surface                                                         | Runtime Resolution                                                                                                                    | Consumption                                                                                                  | Regression Coverage                                                                                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `redis.password`                 | `packages/config/src/schemas/redis.schema.ts`                                 | `packages/config/src/env-mapping.ts` maps `REDIS_PASSWORD`             | `apps/admin/src/app/api/config/route.ts` and `diff/route.ts` map and mask it | `packages/redis/src/connection.ts` preserves `REDIS_PASSWORD` even when `REDIS_URL` is set; config resolver passes `password` through | `createRedisConnection()` and `createBullMQConnectionOptions()` apply explicit password over URL credentials | `packages/config/src/__tests__/env-mapping.test.ts`, `packages/redis/src/__tests__/connection.test.ts`, `packages/redis/src/__tests__/bullmq.test.ts` |
| `redis.tls`                      | `packages/config/src/schemas/redis.schema.ts`                                 | `REDIS_TLS` and documented `REDIS_TLS_ENABLED` both map to `redis.tls` | Admin config and diff routes include both env names                          | Env resolver reads both names; cluster seed parsing honors `rediss://`                                                                | Node Redis clients get TLS options; Go already reads `REDIS_TLS_ENABLED`                                     | `packages/config/src/__tests__/env-mapping.test.ts`, `packages/redis/src/__tests__/connection.test.ts`                                                |
| `redis.cluster`                  | `packages/config/src/schemas/redis.schema.ts`                                 | `REDIS_CLUSTER` maps to `redis.cluster`                                | Admin config and diff routes include `REDIS_CLUSTER`                         | Env/config resolvers pass `cluster: true` through                                                                                     | `createRedisConnection()` constructs cluster handles from parsed seed nodes                                  | Existing cluster helper tests plus focused Redis suite                                                                                                |
| BullMQ prefix `{bull}`           | `packages/redis/src/bullmq.ts` default worker options and app queue factories | N/A                                                                    | N/A                                                                          | N/A                                                                                                                                   | Go crawler worker now uses `{bull}:queue:*`, matching TypeScript producers                                   | `go test ./...` in `apps/crawler-go-worker`; static `rg` found no remaining bare `bull:%s` queue keys                                                 |
| Duplicate `parseRedisUrl` helper | Removed from `apps/runtime/src/services/queues/redis-utils.ts`                | N/A                                                                    | N/A                                                                          | `packages/redis` keeps the canonical parser internally as `parseStandaloneRedisUrl()`                                                 | Runtime DLQ script now uses `createBullMQConnectionOptions()` from `@agent-platform/redis`                   | Static `rg` found no remaining `parseRedisUrl` symbol                                                                                                 |

## Findings

- No propagation gaps found for the Redis fields added or repaired in this fix
  commit.
- `redis.password` is intentionally optional and internal to Redis connection
  construction. It is surfaced in admin config for drift checks but masked by
  the existing secret masking rules.
- `REDIS_TLS_ENABLED` is now accepted by Node config paths to match the Go
  worker and documented deployment examples.
- The Go crawler worker now uses the same `{bull}` hash tag as BullMQ
  producers, so all queue keys share one Redis Cluster slot.

## Verification

- `pnpm --filter @agent-platform/config build`
- `pnpm --filter @agent-platform/redis build` after building
  `@agent-platform/shared-kernel`
- `pnpm --filter @agent-platform/config exec vitest run src/__tests__/env-mapping.test.ts src/__tests__/schemas/redis-tls.test.ts`
- `pnpm --filter @agent-platform/redis exec vitest run src/__tests__/connection.test.ts src/__tests__/bullmq.test.ts src/__tests__/cluster-helpers.cluster.test.ts src/__tests__/migration-completeness.static.test.ts`
- `GOCACHE=/private/tmp/ablp-go-build-cache go test ./...` in
  `apps/crawler-go-worker`

Root `pnpm build` remains blocked before these changes are reached by existing
`@abl/compiler` / workspace build-order errors noted in the Phase A review.
