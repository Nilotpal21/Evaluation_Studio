# EVA-6527 / ABLP-420 — Open Items Log

**Context**: Backend gaps surfaced while designing the AI4W V2 autonomous-agent builder. Source document: `KoreServer/ai4w-abl-backend-open-items.md`. Scope tracked here is ABL-side only — AI4W-only items are the KoreServer team's responsibility.

**Status legend**: `OPEN`, `RESOLVED`, `DEFERRED`.

---

## OI-1. `/info` rate-limit policy — OPEN

**Reference**: Feature spec §15 OQ-0, HLD §9 OQ-0, LLD P4 task 5.2.

**Context**: The standalone `/ping` endpoint was folded into `GET /api/v1/channels/ai4w/{connectionId}/info`. The question now applies to `/info`, which is AI4W's primary "Test & Continue" + banner-refresh path and may be polled periodically by the V2 autonomous-agent builder.

**Question**: Should `GET /api/v1/channels/ai4w/{connectionId}/info` be:

- (a) fully exempt from the per-connection rate limiter (current default),
- (b) share the `/message` bucket, or
- (c) sit on a separate generous bucket (e.g. 60/min)?

All three options still feed the **auth-failure counter**, so bad creds are still blocked after the configured threshold — this question is purely about valid-auth calls.

**Consequences**:

- (a) — cheapest for AI4W's periodic health probes and banner refreshes; `/info` does additional DB reads (tenant, project, deployment count, deployment findOne) so it is more expensive than `/ping` was, but still negligible vs `/message`. Current default.
- (b) — simplest to reason about; AI4W must budget info calls against `/message` quota.
- (c) — best isolation; needs a new Redis counter + new config knob.

**Deciders**: Ajay, Prasanna.
**Needed by**: before the AI4W V2 builder ships the periodic health-probe feature.
**Default behaviour until resolved**: option (a) — `/info` is exempt from tenant rate-limit quota.
**Tracking**: update this file when decided.

---

## OI-2. Deactivate / reactivate UX reuse — RESOLVED

**Reference**: Feature spec §4 FR-21, LLD Phase 6 / P7.

**Question**: Do we need a new "reactivate" API, or does the existing ABL channel-customization PATCH endpoint cover it?

**Decision (2026-04-22)**: Existing channel-customization PATCH `/channel-connections/:id` (already supports toggling `status`) covers reactivation. No new reactivate endpoint required on the internal API surface. The admin UX stays in ABL — AI4W only calls `deactivate` and `DELETE`.

**Implication**: P7 ships with **two** new endpoints (deactivate + DELETE), not three.

---

## OI-3. `agentId` / `deploymentId` backfill for existing connections — RESOLVED

**Reference**: user confirmation during plan review, 2026-04-22.

**Question**: Do existing AI4W ChannelConnection documents in dev/staging need a migration when `agentId` moves from required → always-null?

**Decision (2026-04-22)**: No existing data. No migration required. New provisioning sets `agentId: null`. If stale dev docs exist with `agentId` populated, they are harmless — runtime resolution now goes through `DeploymentResolver` using `deploymentId`/`environment` regardless of `agentId`.

---

## OI-4. Studio agent-level discovery endpoint removal — RESOLVED

**Reference**: Feature spec §8 API table, HLD §6 API table.

**Question**: Remove (breaking) or deprecate the legacy `GET /tenants/:tenantId/agents/discoverable`?

**Decision (2026-04-22)**: Remove. No external consumers at the time of removal (AI4W V2 hasn't shipped). `/projects/discoverable` supersedes it.

---

## OI-5. `goToAppUrl` / `toolCount` in discovery response — RESOLVED

**Reference**: `ai4w-abl-backend-open-items.md` §1, §3.

**Decision (2026-04-22)**: AI4W constructs the app URL client-side; `goToAppUrl` is **not** included in the ABL response. `toolCount` is out of scope for EVA-6527 and is **not** included.

**Implication**: The project discovery response includes only `{id, name, description, agentCount}`.
