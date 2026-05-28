# Merge Audit Pass 3 — Final Sweep

**Branch:** `feature/trace-platform-infrastructure-v2` → `develop`
**Date:** 2026-03-14
**Auditor:** Claude (automated)

## Prior passes

- Pass 1: runtimeSessionId bugs in route files, missing withTraceContext in search-ai workers, spanVersion/activeSpanStack cleanup, dead code removal, duplicate type removal — all fixed.
- Pass 2: Additional cleanups — all resolved.

---

## Check 1: Import consistency — channel-trace-utils.ts

**Status: PASS**

`apps/runtime/src/services/channel-trace-utils.ts` exists and is correctly imported by all consumers:

| Consumer                            | Import path                          | Correct? |
| ----------------------------------- | ------------------------------------ | -------- |
| `routes/channel-genesys.ts`         | `../services/channel-trace-utils.js` | Yes      |
| `routes/channel-vxml.ts`            | `../services/channel-trace-utils.js` | Yes      |
| `routes/channel-audiocodes.ts`      | `../services/channel-trace-utils.js` | Yes      |
| `routes/chat.ts`                    | `../services/channel-trace-utils.js` | Yes      |
| `websocket/handler.ts`              | `../services/channel-trace-utils.js` | Yes      |
| `websocket/sdk-handler.ts`          | `../services/channel-trace-utils.js` | Yes      |
| `services/queues/inbound-worker.ts` | `../channel-trace-utils.js`          | Yes      |

Internal imports within channel-trace-utils are also valid:

- `@abl/compiler/platform` — createLogger (standard)
- `@abl/compiler/platform/observability` — getCurrentTraceId (standard)
- `./eventstore-singleton.js` — verified exists
- `@agent-platform/sti` — getSharedSTRBuffer (verified: exported from `packages/sti/src/index.ts`)
- `./tracing/str-writer-singleton.js` — verified exists

---

## Check 2: ResolvedSession.runtimeSessionId in non-route files

**Status: PASS**

Grep for `session.runtimeSessionId` across `apps/runtime/src/` (excluding websocket and tests) returned **zero matches**.

The `ResolvedSession` type (`apps/runtime/src/channels/session-resolver.ts:67`) contains `channelSessionId`, `sessionId`, and `isNew` — no `runtimeSessionId` field. Clean.

Websocket files (`handler.ts`, `sdk-handler.ts`, `twilio-media-handler.ts`) use `runtimeSessionId` on their own state types (SDKClientState, TwilioMediaSession, WsClientState), which is correct and expected.

---

## Check 3: session-factory.ts runtimeSessionId

**Status: PASS**

`apps/runtime/src/channels/pipeline/session-factory.ts` uses `runtimeSessionId` only in **log messages** as structured context (lines 93 and 162):

```
runtimeSessionId: runtimeSession.id,
```

This is accessing `runtimeSession.id` (the `RuntimeSession` object returned by `executor.createSessionFromResolved`), NOT `session.runtimeSessionId` on a `ResolvedSession`. The return type `SessionCreationResult` (defined in `./types.ts`) has `runtimeSession: RuntimeSession` — no `runtimeSessionId` field. Correct usage.

---

## Check 4: Feature branch's new packages/modules

### 4a: packages/shared-observability

**Status: PASS**

- Package exists at `packages/shared-observability/`
- `extractTrace` is exported from `src/tracing/propagation.ts` and re-exported via `src/tracing/index.ts`
- The `./tracing` subpath export is correctly declared in `package.json`
- Build produces `dist/tracing/index.js` with all 8 tracing modules
- Consumers use the correct subpath import: `@agent-platform/shared-observability/tracing`
- All 6 app Dockerfiles have the required `COPY packages/shared-observability/package.json` line

Note: The main `src/index.ts` does NOT re-export the tracing module — this is intentional. Consumers must use the `/tracing` subpath import, which is the correct pattern (keeps the main entry point lightweight for consumers who only need middleware/locks).

### 4b: ClickHouse DDL / migrations

**Status: PASS (no new files)**

No new `.sql` files were added by the feature branch. Existing ClickHouse DDL files:

- `scripts/clickhouse-init/01-init.sql` (unchanged)
- `packages/pipeline-engine/src/pipeline/schemas/clickhouse-analytics-tables.sql` (unchanged)
- `packages/pipeline-engine/src/pipeline/schemas/clickhouse-analytics-mvs.sql` (unchanged)
- `apps/search-ai/migrations/clickhouse/006_json_path_index.sql` (unchanged)

If the feature branch introduced new trace event types stored in ClickHouse, the DDL may need updating — but this would be a follow-up task, not a merge blocker.

---

## Check 5: telco-noc removal

### 5a: Workspace configuration

**Status: PASS**

- `pnpm-workspace.yaml` uses glob pattern `apps/*` — no explicit telco-noc entry
- Root `package.json` has no telco-noc reference

### 5b: Directory state

**Status: WARN — stale artifacts remain on disk**

`apps/telco-noc/` still exists on disk with:

- `.env` (potential credentials leak risk)
- `.next/` (stale build output)
- `node_modules/` (stale dependencies)
- `next-env.d.ts`
- `.turbo/`

However, the directory has **no `package.json`** and **no git-tracked files** (`git ls-files apps/telco-noc/` returns empty). The `.gitignore` covers `.next/`, `node_modules/`, and `.env`, so these won't be committed. Since there's no `package.json`, pnpm will skip it during workspace resolution.

**Recommendation:** Delete `apps/telco-noc/` entirely to avoid confusion:

```bash
rm -rf apps/telco-noc/
```

### 5c: Import references

**Status: PASS**

Zero references to `telco-noc` in:

- `apps/admin/src/` (no imports)
- `apps/studio/src/` (no imports)
- Any `.ts`/`.tsx` source files outside of telco-noc's own build artifacts

---

## Summary

| Check                                  | Status | Action needed?                                       |
| -------------------------------------- | ------ | ---------------------------------------------------- |
| 1. channel-trace-utils imports         | PASS   | None                                                 |
| 2. ResolvedSession.runtimeSessionId    | PASS   | None                                                 |
| 3. session-factory.ts runtimeSessionId | PASS   | None                                                 |
| 4a. shared-observability package       | PASS   | None                                                 |
| 4b. ClickHouse DDL                     | PASS   | None (follow-up if new event types need tables)      |
| 5a. telco-noc workspace config         | PASS   | None                                                 |
| 5b. telco-noc directory artifacts      | WARN   | Delete `apps/telco-noc/` (untracked cruft with .env) |
| 5c. telco-noc import references        | PASS   | None                                                 |

**Merge verdict:** Safe to merge. One cleanup recommendation (delete stale telco-noc directory) that is non-blocking.
