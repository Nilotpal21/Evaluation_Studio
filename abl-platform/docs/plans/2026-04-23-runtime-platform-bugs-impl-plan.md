# Runtime / Platform Bugs — Implementation Plan

**Date:** 2026-04-23
**Tickets:** ABLP-528, ABLP-529, ABLP-530, ABLP-531
**Branch:** develop (current branch — no feature branch required; each ticket lands independently)

## Summary

Four bugs surfaced on agents-dev during ABLP-396 reconnect verification:

| Ticket   | Title                                                                                 | Severity         | Owner area       |
| -------- | ------------------------------------------------------------------------------------- | ---------------- | ---------------- |
| ABLP-528 | Runtime liveness probe hits heavy /health — causes pod restarts and 502s on reconnect | P0               | runtime + deploy |
| ABLP-529 | Refresh-token rotation is non-atomic — concurrent refresh triggers mass revocation    | P1               | studio auth      |
| ABLP-530 | Investigate 17MB Buffer RangeError in session-retention cleanup                       | P2 spike         | runtime          |
| ABLP-531 | Investigate elevated Mongo TCP connection count from runtime                          | P2 investigation | runtime          |

The duplicate-user-message bug originally suspected alongside these has **already landed** in commits `0b6be4027`, `95e174c1d`, `1d448c9f2`, `d8c9e98e4` and is out of scope here.

## Evidence snapshot (agents-dev at time of investigation)

- 2/2 runtime pods ready, 8 container restarts in ~4.5 hours, no OOMs, no panics in logs
- p50 5ms, p95 5s, p99 20s — classic tail latency
- Studio proxies to runtime saw `ConnectTimeoutError`, `ECONNREFUSED`, `socket hang up` during restart windows
- `session-cleanup` RangeError fires hourly; caught; does not crash the pod
- `/api/auth/refresh` intermittently returns 401 with `Invalid or expired refresh token`; user locked out of Studio

## Sequencing

No split hotfix for ABLP-528. Moving _readiness_ to `/health/ready` does not stop container restarts — kubelet kills on _liveness_ failures, which continue to hit the heavy `/health`. Any fix that wants to stop the churn has to touch liveness. Two paths:

```
Option A — Emergency mitigation only (deploy-only, covers all envs):
  [ABLP-528] Base-chart edit: bump runtime livenessProbe.timeoutSeconds (1→15)
             and failureThreshold (3→5). Buys ~75s tolerance per probe
             cycle. Does NOT root-cause; reduces restart frequency while
             the proper fix lands.

Option B — Proper fix (runtime + base-chart, single coordinated change):
  [ABLP-528] apps/runtime: add shallow /health/live endpoint.
  [ABLP-528] helm/abl-platform/values.yaml (base chart): runtime
             livenessProbe.path → /health/live, readinessProbe.path
             → /health/ready, startupProbe.path → /health/ready.
             Covers every environment because tier/env files have
             no probe overrides — they inherit from base.
  Requires a runtime release (image tag bump) to land together with
  the chart change, so the chart's new probe path matches an endpoint
  the running image actually exposes.

Recommended: ship A today as the mitigation, then B as the permanent fix.

Day 0–1 (in parallel with ABLP-528 Option B):
  [ABLP-529] Studio atomic refresh-token rotation + family/generation
             population + schema migration.

Later:
  [ABLP-530] Instrument both session-cleanup and session-timeout-sweep
             catches; confirm getDistinctTenantIds() as the source of the
             17 MB RangeError; replace with an aggregation cursor at the
             shared helper (session-repo.ts:509). Fix covers both callers.
  [ABLP-531] Re-measure Mongo TCP connections after ABLP-528 Option B
             lands; investigate further only if still elevated.
```

---

## ABLP-528 — Runtime liveness probe

### Root cause (confirmed)

- Liveness probe targets `/health` (`helm/abl-platform/values.yaml:83-87` — `path: /health`, `failureThreshold: 3`, `timeoutSeconds: 1` default; overridden to 5 in dev at `environments/dev/values.yaml:109-110`).
- `apps/runtime/src/server.ts:582` — `/health` handler awaits `MongoConnectionManager.healthCheck()`.
- `packages/database/src/mongo/connection.ts:251-282` — health check does `admin.ping()` + `admin.serverStatus()`.
- Dev configMap (`environments/dev/values.yaml:79-81`): `MONGODB_MAX_POOL_SIZE: "10"`, `MONGODB_WAIT_QUEUE_TIMEOUT_MS: "5000"`. Code default (`apps/runtime/src/server.ts:1791-1796`): `serverSelectionTimeoutMs: 10000`, `socketTimeoutMs: 45000`.
- Under pool pressure, the health-check call stalls past 5s → 3 consecutive failures in ~90s → kubelet SIGKILLs the container. No crash logs because kubelet, not the process, kills it.

### Already in place

- `apps/runtime/src/server.ts:685` exposes `GET /health/ready`, backed by `apps/runtime/src/change-management/readiness.ts` which returns 503 on `isShuttingDown`, heap-pressure, Mongo not ready, Redis ping failure, or change-compatibility failure.
- Studio block in the same chart (`helm/abl-platform/values.yaml:148-190`) already uses `/health/startup`, `/health/ready`, `/health/live`.

### Gap

1. Runtime has no `/health/live`.
2. Helm chart runtime block still points liveness, readiness, and startup at `/health`.

### Option A — Emergency mitigation (deploy-only, base chart, all envs)

A dev-only override is not enough — every environment inherits from `helm/abl-platform/values.yaml` (tier files have no probe overrides on this repo state). If we want to reduce restart frequency _today_ without a runtime release, bump liveness tolerance in the base chart:

```yaml
# helm/abl-platform/values.yaml, runtime block (around line 83-87)
livenessProbe:
  path: /health
  periodSeconds: 30
  failureThreshold: 5 # was 3
  timeoutSeconds: 15 # was 1 (or 5 where env-overridden)
```

Total stall tolerance becomes `failureThreshold × (periodSeconds + timeoutSeconds)` ≈ 5 × 45s = 225s of repeated probe failures before kubelet kills. Mongo health calls have a hard ceiling of `serverSelectionTimeoutMs: 10000` + `waitQueueTimeoutMs: 10000`, so a single probe tops out around 20s — comfortably inside 15s × 5.

**Caveat:** does not fix the root cause. Under sustained Mongo saturation, restarts are still possible. Also slower to detect genuinely dead processes (~225s vs ~90s). This is a mitigation, not a fix.

Exit criteria (Option A):

- Pod restart count on agents-dev over a 2-hour window drops below pre-fix rate.
- Kubelet `Last State: Terminated (Reason: Error)` events on runtime pods trend to zero.

### Option B — Proper fix (runtime + base chart, single coordinated change)

Two files in `apps/runtime/src/`, one file in `abl-platform-deploy/helm/abl-platform/`.

Option B is the permanent fix. It touches the base chart only, which covers every environment because tier and env files have no probe overrides on this repo state. Must land together with a runtime release carrying the new endpoint, else liveness probes hit a 404 and containers are killed.

**B.1 — Add `/health/live` endpoint** (`apps/runtime/src/server.ts`, adjacent to line 685).

```ts
app.get('/health/live', (_req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({ status: 'not_live', reason: 'shutting_down' });
  }
  const heapUsedMB = process.memoryUsage().heapUsed / 1048576;
  const heapLimitMB = getRuntimeHeapLimitMb();
  if (heapUsedMB > heapLimitMB) {
    return res.status(503).json({
      status: 'not_live',
      reason: 'memory_pressure',
      heapUsedMB: Math.round(heapUsedMB),
      heapLimitMB: Math.round(heapLimitMB),
    });
  }
  res.json({ status: 'live' });
});
```

No `requireInternalNetworkAccess` (same as `/health/ready` — kubelet originates these).

**B.2 — Helm chart** (`abl-platform-deploy/helm/abl-platform/values.yaml:74-87` — base chart, covers all envs):

```yaml
runtime:
  # ...
  startupProbe:
    path: /health/ready
    failureThreshold: 30
    periodSeconds: 10
  readinessProbe:
    path: /health/ready
    periodSeconds: 10
    failureThreshold: 3
    timeoutSeconds: 1
  livenessProbe:
    path: /health/live
    periodSeconds: 30
    failureThreshold: 3
    timeoutSeconds: 1
```

Leave `environments/dev/values.yaml:106-110` overrides in place (they work with either path). Verified: tier files (`values-tier-{s,m,l,xl}.yaml`) carry no probe overrides, so the base-chart edit applies to every tier automatically.

**B.3 — Keep `/health` endpoint** for back-compat (LB/monitoring tooling).

**Rollout coordination:** the base-chart probe path change must not roll out to an environment before that environment's runtime image carries `/health/live`. Sequence:

1. Ship runtime change containing `/health/live` and cut a release.
2. Merge helm values change to `develop`.
3. ArgoCD promotes dev → QA → staging → prod; each environment must be on a runtime image ≥ the release from step 1 before it receives the values change. If values land first, liveness probes 404 and pods are restarted.

Exit criteria (Option B):

- Pod restart count = 0 over a 4-hour window on dev (no Mongo-slow restarts).
- Readiness still correctly reflects Mongo/Redis outages (verified by killing a Mongo pod and observing Service endpoint withdrawal without container restart).
- Liveness continues to catch genuinely dead processes (verified by sending SIGSTOP to the runtime process and observing kubelet restart after 90s).
- No probe-path 404s in runtime logs across rollout (the rollout sequence from B.3 is followed).

### Testing

- **Unit** (`apps/runtime/src/__tests__/health/live-endpoint.test.ts` — new): Mongo disconnected, `/health/live` returns 200.
- **Integration** (`apps/runtime/src/__tests__/integration/health-probes.test.ts` — new): boot runtime with Mongo unreachable, assert `/health/live` 200 and `/health/ready` 503.
- **Manual dev smoke**: after ArgoCD roll, simulate Mongo pressure (scale Mongo to 1 replica temporarily) and observe readiness drops / liveness stays.

### Risk

Low. `/health/live` is additive; `/health` stays. Chart change is probe-path only, no workload config changes.

---

## ABLP-529 — Refresh-token rotation

### Root cause (confirmed)

- `apps/studio/src/services/auth-service.ts:452-503` — `refreshTokens()` reads (`findRefreshToken`), checks `revokedAt`, writes (`updateRefreshToken({_id}, {revokedAt: now})`), then mints a new pair. Non-atomic.
- `apps/studio/src/repos/auth-repo.ts:327-339` — `updateRefreshToken` is `findOneAndUpdate({_id: id}, {$set: data})` **without** `revokedAt: null` guard.
- `packages/database/src/models/refresh-token.model.ts:14-25` — schema has `familyId: string | null` and `generation: number` with indexes, **not populated** by `createRefreshToken` (`auth-service.ts:379-395`).

### Failure modes

1. **Cross-tab race**: two tabs share the httpOnly `refresh_token` cookie. Both fire `/refresh` concurrently, both pass the `revokedAt === null` check, both revoke, both mint a new pair. Browser keeps only the last `Set-Cookie`. The other tab's next refresh presents a now-revoked token → `revokeUserRefreshTokens(userId)` mass-revoke fires → all sessions logged out.
2. **Network-retry race**: server rotated successfully, `Set-Cookie` lost to transport glitch, client retries with original (now-revoked) token → same mass-revoke.

Existing client-side dedup (`apps/studio/src/lib/api-client.ts:23-58`, `apps/studio/src/api/auth.ts:74-82`) collapses concurrent refreshes per tab — does not help cross-tab or retry cases.

### Fix

**3.1 — Atomic conditional rotation** (`apps/studio/src/repos/auth-repo.ts`):

```ts
export async function rotateRefreshToken(
  id: string,
  data: { revokedAt: Date; rotatedToId?: string },
): Promise<any> {
  await ensureDb();
  const { RefreshToken } = await import('@agent-platform/database/models');
  const doc = await RefreshToken.findOneAndUpdate(
    { _id: id, revokedAt: null },
    { $set: data },
    { new: true },
  ).lean();
  return doc ? normalizeRefreshToken(doc) : null;
}
```

A `null` result means we lost the race.

Keep the existing `updateRefreshToken` for callers that don't need the guard (e.g., admin flows), but the rotation path in `auth-service.refreshTokens` must use `rotateRefreshToken`.

**3.2 — Populate family / generation on create** (`apps/studio/src/services/auth-service.ts:379`):

```ts
export async function createRefreshToken(
  userId: string,
  lineage?: { familyId: string; generation: number; rotatedFromId?: string },
): Promise<{ token: string; id: string; familyId: string; generation: number }> {
  const { refreshExpiry } = getJWTConfig();
  const token = crypto.randomBytes(64).toString('hex');
  const hashedToken = hashToken(token);
  const expiryMs = parseExpiry(refreshExpiry);
  const expiresAt = new Date(Date.now() + expiryMs);

  const familyId = lineage?.familyId ?? crypto.randomUUID();
  const generation = lineage?.generation ?? 1;

  const created = await createRefreshTokenRepo({
    token: hashedToken,
    userId,
    expiresAt,
    familyId,
    generation,
    ...(lineage?.rotatedFromId ? { rotatedFromId: lineage.rotatedFromId } : {}),
  });

  return { token, id: created.id, familyId, generation };
}
```

Add `rotatedFromId: string | null` to `IRefreshToken` schema (`packages/database/src/models/refresh-token.model.ts`) so the winner's row links back to the predecessor. Optional; useful for audit. Not strictly required for correctness.

**3.3 — Race-loss / replay path** (`apps/studio/src/services/auth-service.ts:refreshTokens`):

**Constraint:** refresh tokens are stored as hashes only (`hashToken(rawToken)` in `apps/studio/src/repos/auth-repo.ts`). The raw token exists only in the HTTP response that created it. Once that response closes, the winner's raw token lives only in the winner's cookie — the server cannot retrieve or re-emit it.

**Therefore:** when the loser detects a race-loss or a legitimate replay, it **mints a fresh sibling refresh token in the same family** rather than trying to return the winner's. Both winner and loser end up with distinct, valid refresh tokens. The browser applies both `Set-Cookie` responses; whichever arrives last wins the cookie value. Both tokens remain valid on the server (same family) and either can successfully rotate on the next refresh.

Pseudocode:

```ts
const hashedToken = hashToken(oldRefreshToken);
const tokenRecord = await findRefreshToken(hashedToken);
if (!tokenRecord) return null;
if (tokenRecord.expiresAt < new Date()) return null;

const familyId = tokenRecord.familyId ?? crypto.randomUUID();
const presentedGen = tokenRecord.generation ?? 1;

// Attempt to atomically claim the rotation of this specific token id.
const rotated = await rotateRefreshToken(tokenRecord.id, { revokedAt: new Date() });

if (rotated) {
  // Winner path: we claimed the rotation.
  const created = await createRefreshToken(tokenRecord.userId, {
    familyId,
    generation: presentedGen + 1,
    rotatedFromId: tokenRecord.id,
  });
  return buildTokenPair(tokenRecord.user, tenantContext, created.token);
}

// Race-loss or replay: this specific token id was already revoked by
// someone else. Inspect the family to decide between "legitimate replay"
// and "genuine reuse attack".
const family = await findRefreshTokensByFamily(familyId);
const maxGeneration = family.reduce((max, row) => Math.max(max, row.generation ?? 1), presentedGen);
const graceCutoff = Date.now() - GRACE_WINDOW_MS;
const hasRecentChild = family.some(
  (row) => (row.generation ?? 1) > presentedGen && row.createdAt.getTime() >= graceCutoff,
);

// Genuine reuse: presented generation is more than 1 behind family head.
// An attacker replaying a long-stolen token lands here.
if (presentedGen < maxGeneration - 1) {
  await revokeFamily(familyId);
  return null;
}

// No recent child and presented token is revoked outside grace window:
// also treat as reuse.
if (!hasRecentChild) {
  await revokeFamily(familyId);
  return null;
}

// Legitimate race-loss or network-retry replay within grace window.
// Mint a sibling refresh token at max_generation + 1. The winner's token
// remains valid; this loser now also has a valid token. Whichever
// Set-Cookie the browser applies last wins the cookie value.
const sibling = await createRefreshToken(tokenRecord.userId, {
  familyId,
  generation: maxGeneration + 1,
  rotatedFromId: tokenRecord.id,
});
return buildTokenPair(tokenRecord.user, tenantContext, sibling.token);
```

**Reuse detection rule:** a presented token that is **more than one generation behind** the family's current max is treated as reuse (revoke family). Exactly-one-behind is treated as legitimate replay within grace window, sibling-minted otherwise.

**Grace window:** 10 seconds (env override `AUTH_REFRESH_GRACE_WINDOW_MS`). Cross-tab and network retries complete in well under 1s; anything minutes later should not be tolerated because stolen tokens can replay indefinitely.

**Cost:** each race-loss creates one extra refresh-token row. Bounded by concurrent-tab count × refresh rate. TTL cleans rows up at expiry (7 days default).

**What about duplicate generations?** If two losers race concurrently, both may read `maxGeneration` before either inserts, and both insert at `maxGeneration + 1`. Schema does not enforce uniqueness on `(familyId, generation)`, so both inserts succeed. Reuse detection remains correct because it compares to the actual max, which naturally climbs as more rows are added. If we later want stricter invariants, add a unique compound index and catch the duplicate-key error to retry with `max + 1` — not required in v1.

**3.4 — Schema migration**

- Add `rotatedFromId: string | null` to `refresh-token.model.ts`.
- Migration script (`packages/database/src/migrations/YYYYMMDD-refresh-token-family-generation.ts`):
  - For each existing row with `familyId: null`: assign `familyId: uuid()`, `generation: 1`, `rotatedFromId: null`. One row per "family chain" (each existing token becomes its own family root; lineage tracking starts from now).
  - Drop nullability of `familyId` (required from now on).
- Run via existing `pnpm migrate:run` wiring.

**3.5 — Optional: cross-tab dedup** (`apps/studio/src/lib/api-client.ts`)

Use `BroadcastChannel('auth-refresh')` so the first tab to fire `/refresh` broadcasts the new access token; other tabs listen and consume instead of firing their own. Not required for correctness (server-side fix is sufficient) but reduces `/refresh` QPS. Defer to follow-up.

### Exit criteria

- Unit tests in `apps/studio/src/__tests__/auth-services.test.ts`:
  - Concurrent `refreshTokens(tokenA)` × 2 → exactly one caller wins the atomic rotation and mints at gen 2; the loser mints a sibling at gen 3 (or higher). Both callers get distinct valid refresh tokens; family ends with three rows (gen 1 revoked, gen 2 active, gen 3 active). No mass-revoke fired.
  - Replay `refreshTokens(tokenA)` after successful rotation within grace window → race-loss path mints a sibling token; caller receives valid pair; no mass-revoke.
  - Replay `refreshTokens(tokenA)` after grace window expires → returns null, family revoked.
- Integration test: fire two `/api/auth/refresh` concurrently with the same cookie, assert HTTP 200 on both, no `revokedAt` timestamp on all user tokens (mass-revoke should not fire).
- Manual on dev: open Studio in two tabs on agents-dev, refresh one until token rotates, refresh the other, assert no lockout.

### Risk

Medium. Schema migration + auth code. Migration is backfill-only, additive. Code change is behind existing `refreshTokens()` boundary — callers unchanged. Mitigations:

- Ship the schema migration separately and verify backfill before deploying service code that depends on `familyId` being populated.
- Feature-flag the grace-window path behind `AUTH_REFRESH_GRACE_WINDOW_MS=10000` so we can disable it quickly if a regression surfaces.

---

## ABLP-530 — Unbounded-distinct RangeError in tenant-iterating retention jobs

### Evidence

- `apps/runtime/src/services/session-cleanup-job.ts:76-79, 147-152, 204-209` — three catch sites that currently surface the error class.
- Error: `The value of "offset" is out of range. It must be >= 0 && <= 17825792. Received 17825794..17825797`. 17,825,792 = 17 × 1024 × 1024 — one past BSON's 16 MB max document size, consistent with a MongoDB wire-protocol response buffer overrun.

### Shared root-cause surface

`apps/runtime/src/repos/session-repo.ts:509-512`:

```ts
export async function getDistinctTenantIds(): Promise<string[]> {
  const { Session } = await import('@agent-platform/database/models');
  return Session.distinct('tenantId').exec();
}
```

`Session.distinct('tenantId')` returns the entire distinct set in a single BSON command response. As the unique set grows past the driver's ~16 MB buffer boundary, the response overflows.

This helper is called by **two** retention jobs today, both of which materialise the full tenant list up-front and iterate:

| Caller                    | File:line                                                    | Current symptom                                                           |
| ------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Session-retention cleanup | `apps/runtime/src/services/session-cleanup-job.ts:163`       | Error observed in dev logs (65 hits in 2h).                               |
| Session-timeout sweep     | `apps/runtime/src/services/session-timeout-sweep-job.ts:469` | Not yet observed but identical exposure — same helper, same growth curve. |

Scoping the fix to only the cleanup job leaves the timeout sweep one tenant-count increment away from the same failure.

### Spike + fix plan (one ticket, one PR)

Phase 1 — **Confirm the source** (spike, ~2 hours):

1. Add full-stack instrumentation at the two catch sites in `session-cleanup-job.ts` (lines 76-79, 147-152). Log the stack trace, the active tenant list length (if already materialised), and the last query in progress.
2. Deploy to dev. Wait for the next cleanup interval fire (`interval: 60m`).
3. Confirm the throw originates in `getDistinctTenantIds` / the Mongo driver's BSON buffer path.

Phase 2 — **Fix once, at the shared helper**:

Replace `Session.distinct('tenantId').exec()` with a streaming aggregation cursor so no single response ever has to carry the full set:

```ts
export async function getDistinctTenantIds(): Promise<string[]> {
  const { Session } = await import('@agent-platform/database/models');
  const cursor = Session.aggregate<{ _id: string }>([{ $group: { _id: '$tenantId' } }]).cursor({
    batchSize: 1000,
  });
  const tenantIds: string[] = [];
  for await (const doc of cursor) {
    if (doc._id) tenantIds.push(doc._id);
  }
  return tenantIds;
}
```

Because both callers use the shared helper, this single edit closes both exposure paths. No caller-side changes needed.

Phase 3 — **Audit for other `.distinct(…)` callers**. Grep `apps/runtime/src` and `packages/` for `\.distinct\(`. For each caller, confirm the result set is bounded (small domain, or already paginated upstream), or convert to a cursor-based equivalent.

### Exit criteria

- Zero `session-cleanup` RangeError log lines over 6 hours on dev after fix deployed.
- `session-timeout-sweep` has no equivalent error in the same window (search pattern hash `d41d8cd98f00b204e9800998ecf8427e` originating from either job).
- Both jobs log their completion messages ("Session retention cleanup completed" / the sweep's equivalent) at expected cadence.
- Phase 3 audit produces either a written confirmation list ("these other `.distinct(...)` callers remain bounded and why") or additional PRs converting them.

### Risk

Low. Spike is instrumentation-only, no behavior change. Fix is a drop-in equivalent for both current callers — they both consume the returned array the same way. Aggregation cursor uses the existing Mongoose connection and pool; no new resource footprint.

---

## ABLP-531 — Mongo TCP connection count

Blocked by ABLP-528. After ABLP-528 lands:

1. Re-query Coroot `get_app_health` on runtime over a 2-hour stable window.
2. If peak active TCP connections to Mongo is ≤ 2 × pool size × 1.5 (allowing churn), close ticket as resolved by ABLP-528.
3. Otherwise, audit:
   - `packages/database/src/mongo/connection.ts` heartbeat behavior
   - any per-request `mongoose.createConnection` hidden in workers / queue consumers
   - `serverSelectionTimeoutMs` and retry policy behavior under Mongo hiccups

---

## Artifacts to produce (per ticket)

| Ticket   | Source files                                                                                                                                                                                          | Tests                                                                       | Commits                                                                                                                                                                                                                                      |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ABLP-528 | `apps/runtime/src/server.ts` (+`/health/live`), `abl-platform-deploy/helm/abl-platform/values.yaml` (base chart — covers all envs)                                                                    | `apps/runtime/src/__tests__/health/live-endpoint.test.ts`                   | Option A (optional, deploy-only): 1× base-chart livenessProbe tolerance bump. Option B (permanent): 1× runtime release carrying `/health/live`, 1× base-chart probe-path switch coordinated to ship after the runtime image reaches each env |
| ABLP-529 | `apps/studio/src/repos/auth-repo.ts`, `apps/studio/src/services/auth-service.ts`, `packages/database/src/models/refresh-token.model.ts`, `packages/database/src/migrations/*-refresh-token-family.ts` | `apps/studio/src/__tests__/auth-services.test.ts` (extended)                | 1× migration, 1× code fix                                                                                                                                                                                                                    |
| ABLP-530 | Phase 1: `apps/runtime/src/services/session-cleanup-job.ts` (instrumentation). Phase 2: `apps/runtime/src/repos/session-repo.ts` (shared helper — fix covers both callers).                           | `apps/runtime/src/__tests__/services/session-cleanup-tenant-cursor.test.ts` | 1× instrumentation, 1× fix at the shared helper                                                                                                                                                                                              |
| ABLP-531 | none initially                                                                                                                                                                                        | none                                                                        | investigation-only                                                                                                                                                                                                                           |

## References

- Original investigation thread: runtime restart triage during ABLP-396 validation on agents-dev
- Prior ABLP-396 commits: `73dce71dd`, `9f2cbb6e3`, `0b6be4027`, `95e174c1d`, `1d448c9f2`, `d8c9e98e4`
- Prior ABLP-497 commit (studio dedup): `e2e842654`
