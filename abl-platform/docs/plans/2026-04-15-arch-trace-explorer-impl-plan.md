# LLD: Arch AI Trace Explorer

**Feature Spec**: `docs/features/arch-trace-explorer.md`
**HLD**: `docs/specs/arch-trace-explorer.hld.md`
**Test Spec**: `docs/testing/arch-trace-explorer.md`
**Oracle Decisions**: `docs/sdlc-logs/arch-trace-explorer/lld.log.md`
**Status**: DRAFT
**Date**: 2026-04-15
**Ticket**: ABLP-162

---

## 1. Design Decisions

### Decision Log

Decisions inherited from HLD (D-HLD-1..D-HLD-12) remain in force; only NEW LLD-specific decisions are captured below.

| #    | Decision                                                                                                                                                                                                  | Rationale                                                                                                                                                                                                                                 | Alternatives Rejected                                                                                                                                                      |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1  | **5 phases**: Data Layer → Tracing Core → Mongo Provider → API Routes → Emission Wiring + UI                                                                                                              | Extends predecessor 4-phase pattern; keeps each phase ≤ 40 files per CLAUDE.md commit scope guard; separating tracing core from provider lets the pure in-memory core land before storage                                                 | (a) 9 workstreams per feature spec §13 verbatim — too granular, each would be a trivially-small phase; (b) Fresh structure — rejected because complexity fits inside tasks |
| D-2  | **3-event lifecycle lives inside `ArchSpanImpl`**; `packages/shared-observability/src/tracing/write-pipeline.ts` interface is unchanged                                                                   | `WritePipeline.write(event: Record<string, unknown>): void` already accepts any shape; `MongoWritePipeline` dispatches on `event.type`                                                                                                    | Widen the shared interface — rejected because it is cross-package breaking and runtime pattern works with the existing interface                                           |
| D-3  | **`ArchTracer` instrument at the single production call site** for `transitionPhase()` (`apps/studio/src/app/api/arch-ai/message/route.ts:4940`); `phase-machine.ts` stays a pure function                | Only 1 production caller; 20+ test callers would need updates if the signature changed                                                                                                                                                    | (a) Add `{ onTransition }` hook parameter — breaks package signature; (b) HOF wrapper — adds indirection, forces test updates                                              |
| D-4  | **`MongoTraceReader` projects `agentName: 'arch-ai'` at read time** — NOT persisted on the `arch_trace_spans` document                                                                                    | HLD Round-3 HD-3 recommended (a); constant per-row value is storage waste; widening `Span.agentName` is cross-package                                                                                                                     | (b) Persist on every doc — wasteful; (c) Widen observatory type to optional — rejected (cross-package breaking)                                                            |
| D-5  | **`estimateCost()` contract unchanged**; UT-6 rewritten to match actual `DEFAULT_PRICING` fallback behavior                                                                                               | `packages/shared-kernel/src/model-pricing.ts:51-71` has never returned null; changing that breaks runtime + arch-ai-assistant + model-hub callers                                                                                         | Change `estimateCost` to return `null` for unknown models — breaking for many consumers                                                                                    |
| D-6  | **`MongoTraceReader` is per-request constructed via DI** inside route handlers; **`MongoWritePipeline`** held once per session in `tracerRegistry` keyed by `sessionId`                                   | Matches predecessor `AuditLogEmitter` pattern; enables tests without `vi.mock` of platform packages (CLAUDE.md); Next.js has no reliable process-lifetime singleton                                                                       | Module-level singleton — unreliable across Next.js function restarts                                                                                                       |
| D-7  | **Per-session-era routing at `POST /api/arch-ai/sessions`**: persist `tracingStore: 'trace-spans' \| 'audit-logs'` on the session document; all downstream reads use that field                           | Feature spec §7 pins the store choice at session creation for lifetime coherence; HLD §4 Concern 10 treats this as the migration strategy                                                                                                 | Check the flag at every emission site — would race if the flag flips mid-session                                                                                           |
| D-8  | **UI replacement is two-step**: Phase 5 lands `TraceExplorer` behind flag (legacy tab stays); **separate post-Phase-5 follow-up PR** removes `ArchAuditLogsTab.tsx`                                       | CLAUDE.md deletion-ratio-guard blocks >30% deletions in feat commits; GAP-004 explicitly plans legacy cleanup as post-BETA PR                                                                                                             | Single PR with both — violates commit discipline; hides an additive feature behind a deletion                                                                              |
| D-9  | **Skip Phase-0 ALS experiment**; rely on INT-7 as regression guard with `tracer.run(span, fn)` fallback if ALS propagation fails                                                                          | HLD §9 Q2 calls experiment "optional, half-day"; runtime pattern proven; fallback cost < 2h                                                                                                                                               | Block Phase 5 on a Phase-0 experiment — unnecessarily lengthens the critical path                                                                                          |
| D-10 | **5 sub-commits for 5 instrumentation sites** in `message/route.ts` (7,479 lines); **no pre-extract refactor**                                                                                            | Predecessor wired 6 emission points successfully in the same file; fire-and-forget semantics isolate failures; additive ≤ 10 LOC per insertion point                                                                                      | Pre-extract helpers first — would be a refactor commit that isn't strictly required; predecessor proves it isn't necessary                                                 |
| D-11 | **Use semantic anchors (function names, call patterns) — NOT literal line numbers** — in the file change map for `message/route.ts`                                                                       | File has grown ~700 lines since the HLD was written; literal line numbers will drift before implementation starts                                                                                                                         | Pin literal line numbers — too brittle                                                                                                                                     |
| D-12 | **Implement all four `_seed` actions** (`seedSpans` / `updateStatus` / `bubbleError` / `reset`) in the same commit                                                                                        | 95% shared handler scaffold (auth + NODE_ENV guard + tracer construction); splitting is busywork                                                                                                                                          | Incremental — rejected as commit-churn without safety benefit                                                                                                              |
| D-13 | **`ArchTracer` tracks the currently-active phase span via an internal field** (`currentPhaseSpan: ArchSpan \| null`) exposed through `activePhaseSpan()` helper                                           | Phase transitions at `message/route.ts:4940` need to end the old phase span and start the new one; AsyncLocalStorage only gives you the _innermost_ active span                                                                           | Walk the parent chain looking for a span with `name === 'phase'` — more brittle and slower                                                                                 |
| D-14 | **Span cap enforcement lives inside `ArchTracer.startSpan()`** with a per-session counter held in `tracerRegistry`                                                                                        | Cap is a tracer-level invariant; per-session counter is zero-extra-IO because `tracerRegistry` already holds session-scoped state                                                                                                         | Check cap in `MongoWritePipeline` — would flush spans that will then be dropped, wasting revisions                                                                         |
| D-15 | **Kill-switch `ARCH_TRACE_ENABLED=false`** resolves to a **no-op `Tracer`** at factory construction time **AND** a defensive `if (!enabled) return` guard at `MongoWritePipeline.write()` entry           | HLD Round-1 M-5 pinned defense-in-depth pattern; zero per-emission overhead when disabled; per-emission guard catches live config reloads                                                                                                 | Factory-only — ignores runtime reloads; per-emission only — trivially fast but still wastes span construction                                                              |
| D-16 | **Route handler pattern uses `withRouteHandler` factory** (newer Studio standard); predecessor `audit-logs/*` uses raw `requireTenantAuth` + `requireAdminRole`                                           | `withRouteHandler` enforces cross-tenant 404 via `requireProject` BEFORE permission check (HLD §4 Concern 1, route-handler.ts:173-206); predecessor pattern would leak project existence                                                  | Mirror predecessor's raw auth — rejected; would require reimplementing 404-before-403 semantics per route and diverge from CLAUDE.md Centralized Auth invariant            |
| D-17 | **Response envelope uses concrete helpers per actual `api-response.ts` signatures** — `listJson(data, pagination)` for lists, `successJson(key, data)` for single resources, `actionJson({...})` for poll | `successJson(key, data)` emits `{ success: true, [key]: data }`; `listJson(data, pagination)` emits `{ success: true, data, pagination }`; both already at `apps/studio/src/lib/api-response.ts:59,64`. Helpers enforce shape consistency | Hand-build `NextResponse.json({ success: true, ... })` literals — rejected; diverges from helper-enforced envelope                                                         |
| D-18 | **UI components live under `apps/studio/src/components/admin/`** (same directory as predecessor `ArchAuditLogsTab.tsx`); NO new `arch-settings/` directory                                                | Predecessor precedent; tab registrar at `ArchSettingsPage.tsx` already knows the path; keeps legacy + new tabs in one directory until post-BETA cleanup PR                                                                                | New `arch-settings/` directory — rejected; forces imports to cross directories during legacy-active window                                                                 |
| D-19 | **Polling uses SWR's `refreshInterval`** (canonical Studio pattern — see `apps/studio/src/hooks/useSessionTraces.ts:89`, `useHumanTasks.ts:69`, `useApprovals.ts:68`, 10+ other hooks)                    | SWR handles teardown on unmount, window blur, error backoff automatically; manual `setInterval` in Zustand would duplicate that machinery and risk leaks                                                                                  | `setInterval` inside Zustand store — rejected; no Studio precedent; manual lifecycle management error-prone                                                                |

### Key Interfaces & Types

```typescript
// packages/arch-ai/src/tracing/index.ts
export { ArchTracer, createArchTracer } from './arch-tracer.js';
export { ArchRedactionBoundary } from './redaction.js';
export { MongoWritePipeline } from './providers/mongo-write-pipeline.js';
export { MongoTraceReader } from './providers/mongo-trace-reader.js';
export type { ArchTracerConfig, ArchTracerFactoryConfig, ArchSpan } from './arch-tracer.js';
export type { ArchSeedRequest } from './types.js';
export type { ArchTraceEventType } from './arch-event-types.js';
export * as ArchSpanAttributes from './arch-span-attributes.js';
export { ARCH_AGENT_NAME } from './constants.js';
```

```typescript
// packages/arch-ai/src/tracing/arch-tracer.ts
import type {
  Tracer,
  Span,
  SpanContext,
  WritePipeline,
} from '@agent-platform/shared-observability/tracing';

export interface ArchTracerConfig {
  sessionId: string;
  tenantId: string;
  userId: string;
  projectId: string | null;
  writePipeline: WritePipeline;
  rawPayloads: boolean; // for expiresAt computation inside child pipeline
  enabled: boolean; // kill-switch guard
}

export interface ArchSpan extends Span {
  readonly spanType:
    | 'session'
    | 'phase'
    | 'turn'
    | 'llm_call'
    | 'tool_execution'
    | 'arch_system_event';
  setStatus(status: 'ok' | 'error', message?: string): void;
  addEvent(name: string, data?: Record<string, unknown>): void;
  readonly ended: boolean;
}

export class ArchTracer implements Tracer {
  constructor(private readonly config: ArchTracerConfig) {
    /* ... */
  }
  startSpan(
    name: string,
    options?: { spanType?: ArchSpan['spanType']; attributes?: Record<string, string> },
  ): ArchSpan;
  run<T>(span: Span, fn: () => T | Promise<T>): T | Promise<T>;
  activeSpan(): Span | null;
  activePhaseSpan(): ArchSpan | null;
  startPhaseSpan(phase: string): ArchSpan;
  startTurnSpan(turnIndex: number): ArchSpan;
  startLLMCallSpan(model: string): ArchSpan;
  startToolSpan(toolName: string): ArchSpan;
  emitSystemEvent(kind: 'span_cap_exceeded', context: Record<string, string>): void;
  dispose(): Promise<void>; // flush + clear timer
}

export function createArchTracer(config: ArchTracerFactoryConfig): ArchTracer;
```

```typescript
// packages/arch-ai/src/tracing/types.ts
export type ArchSeedAction =
  | { action: 'seedSpans'; spans: ArchSpanSeedInput[]; flushImmediately?: boolean }
  | {
      action: 'updateStatus';
      spanId: string;
      status: 'running' | 'completed' | 'error';
      errorMessage?: string;
      flushImmediately?: boolean;
    }
  | { action: 'bubbleError'; rootSpanId: string; flushImmediately?: boolean }
  | { action: 'reset'; sessionId?: string };

export interface ArchSpanSeedInput {
  tenantId: string;
  userId: string;
  projectId: string | null;
  sessionId: string;
  spanId?: string;
  parentSpanId?: string | null;
  name: string;
  spanType: ArchSpan['spanType'];
  startTime?: Date;
  endTime?: Date;
  durationMs?: number;
  status: 'running' | 'completed' | 'error';
  attributes?: Record<string, string>;
  events?: Array<{ name: string; data?: Record<string, unknown>; timestamp?: Date }>;
}

export type ArchSeedRequest = ArchSeedAction;
```

```typescript
// packages/arch-ai/src/tracing/arch-event-types.ts
export const ARCH_EVENT_TYPES = {
  PHASE_TRANSITION: 'arch_phase_transition',
  BUILD_EVENT: 'arch_build_event',
  GATE_RESPONSE: 'arch_gate_response',
  SESSION_EVENT: 'arch_session_event',
  SPEC_UPDATE: 'arch_spec_update',
  SYSTEM_EVENT: 'arch_system_event',
} as const;
export type ArchTraceEventType = (typeof ARCH_EVENT_TYPES)[keyof typeof ARCH_EVENT_TYPES];
```

```typescript
// packages/arch-ai/src/tracing/constants.ts
export const ARCH_AGENT_NAME = 'arch-ai' as const;
export const SPAN_CAP_PER_SESSION = 2_000;
export const POLL_SPAN_CAP = 500;
export const DEFAULT_BUFFER_THRESHOLD = 50;
export const DEFAULT_FLUSH_INTERVAL_MS = 2_000;
export const DEFAULT_BUFFER_MAX = 100;
export const TRUNCATION_LIMIT_BYTES = 4 * 1024;
```

```typescript
// packages/arch-ai/src/tracing/providers/mongo-write-pipeline.ts
export interface MongoWritePipelineConfig {
  spanModel: Model<IArchTraceSpan>;
  sessionModel: Model<IArchTraceSession>;
  sessionId: string;
  tenantId: string;
  userId: string;
  projectId: string | null;
  rawPayloads: boolean;
  bufferThreshold?: number;
  flushIntervalMs?: number;
  enabled: boolean;
}

export class MongoWritePipeline implements WritePipeline {
  constructor(config: MongoWritePipelineConfig) {
    /* ... */
  }
  write(event: Record<string, unknown>): void; // dispatches span_start / span_update / span_end
  flush(): Promise<void>;
  dispose(): Promise<void>;
}
```

```typescript
// packages/arch-ai/src/tracing/providers/mongo-trace-reader.ts
export interface MongoTraceReaderDeps {
  spanModel: Model<IArchTraceSpan>;
  sessionModel: Model<IArchTraceSession>;
}

export interface ProjectScopeFilter {
  tenantId: string;
  projectId: string;
  sessionId?: string;
}
export interface OnboardingScopeFilter {
  tenantId: string;
  userId: string;
  sessionId?: string;
}
export type ScopeFilter = ProjectScopeFilter | OnboardingScopeFilter;

export class MongoTraceReader {
  constructor(private readonly deps: MongoTraceReaderDeps) {}
  listSessions(
    scope: ScopeFilter,
    opts: { page: number; limit: number },
  ): Promise<{ entries: SessionSummary[]; total: number; hasMore: boolean }>;
  fetchTree(scope: ScopeFilter & { sessionId: string }): Promise<ObservatorySpan[]>;
  pollSince(
    scope: ScopeFilter & { sessionId: string },
    sinceRevision: number,
  ): Promise<{ spans: ObservatorySpan[]; nextRevision: number | null }>;
  fetchSpan(scope: ScopeFilter & { spanId: string }): Promise<ObservatorySpan | null>;
  fetchStats(scope: ProjectScopeFilter): Promise<StatsResult>;
}
```

```typescript
// packages/database/src/models/arch-trace-span.model.ts — required fields only
export interface IArchTraceSpan {
  _id: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  status: 'running' | 'completed' | 'error';
  startTime: Date;
  endTime: Date | null;
  durationMs: number | null;
  events: Array<{ name: string; data?: Record<string, unknown>; timestamp: Date }>;
  attributes: Map<string, string>;
  tenantId: string;
  userId: string;
  sessionId: string;
  projectId: string | null;
  revision: number;
  expiresAt: Date; // absolute pre-computed at write time; raw-mode = now+7d, default = now+90d; fixed for document's lifetime. NOTE: a still-running span's descendants will also be orphaned when the root's TTL fires — acceptable for ALPHA (HLD Open Q6)
  createdAt: Date;
  updatedAt: Date;
}

// H-3 R2 fix — exact export shape copied from packages/database/src/models/arch-journal.model.ts:86-88 pattern:
export const ArchTraceSpan =
  (mongoose.models.ArchTraceSpan as mongoose.Model<IArchTraceSpan>) ||
  model<IArchTraceSpan>('ArchTraceSpan', ArchTraceSpanSchema);
// `||` (not `??`) to match 15+ existing model exports in packages/database/src/models/
// Schema options: { timestamps: true, collection: 'arch_trace_spans' } (L-2 R2 fix)
// events array sub-schema declared with { _id: false } per arch-audit-log.model.ts:65-73 pattern (M-4 R2 fix)
// attributes: Map<string, string> uses Mongoose native Map type — no sub-schema needed
```

### Module Boundaries

| Module                                                         | Responsibility                                                         | Depends On                                                                        |
| -------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `packages/arch-ai/src/tracing/`                                | `ArchTracer`, `ArchSpanImpl`, redaction, factory, constants, types     | `@agent-platform/shared-observability/tracing`, `@abl/compiler/platform` (logger) |
| `packages/arch-ai/src/tracing/providers/`                      | `MongoWritePipeline`, `MongoTraceReader`, `tracerRegistry`             | `@agent-platform/database` (models), arch-ai/tracing (interfaces)                 |
| `packages/database/src/models/arch-trace-*.model.ts`           | Mongoose schemas, indexes, TTL, tenant-isolation plugin, cascade hook  | `mongoose`, shared plugins                                                        |
| `packages/observatory/src/schema/trace-events.ts` (modified)   | Additive union widening + runtime array append                         | Nothing new                                                                       |
| `packages/shared-kernel/src/model-pricing.ts` (UNCHANGED code) | Canonical `estimateCost()` + `MODEL_PRICING`                           | Nothing                                                                           |
| `apps/studio/src/app/api/projects/[id]/arch-ai/traces/...`     | Project-scoped routes (5 endpoints)                                    | `@/lib/route-handler`, `@/lib/permissions`, arch-ai/tracing (reader)              |
| `apps/studio/src/app/api/arch-ai/traces/onboarding/...`        | Onboarding-scoped routes (4 endpoints)                                 | `@/lib/route-handler`, arch-ai/tracing (reader)                                   |
| `apps/studio/src/app/api/arch-ai/traces/_seed/route.ts`        | Test-only seed endpoint (NODE_ENV=test + admin role)                   | arch-ai/tracing (tracer + pipeline)                                               |
| `apps/studio/src/app/api/arch-ai/sessions/route.ts` (modified) | Per-session-era routing; root span creation                            | arch-ai/tracing (factory)                                                         |
| `apps/studio/src/app/api/arch-ai/message/route.ts` (modified)  | 5 instrumentation sub-commits                                          | arch-ai/tracing (tracerRegistry)                                                  |
| `apps/studio/src/components/admin/TraceExplorer*.tsx`          | UI components (master-detail layout, tree, detail panels)              | arch-ai/tracing (types), observatory (TraceTree)                                  |
| `apps/studio/src/store/arch-trace-store.ts`                    | Zustand store (sessions, spanMap, maxRevision, selected span, filters) | `zustand`, `@/lib/api-client`                                                     |

---

## 2. File-Level Change Map

### New Files

| File                                                                                      | Purpose                                                                                                              | LOC Estimate |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------ |
| `packages/arch-ai/src/tracing/index.ts`                                                   | Public API barrel                                                                                                    | ~30          |
| `packages/arch-ai/src/tracing/constants.ts`                                               | `ARCH_AGENT_NAME`, span/poll caps, buffer thresholds                                                                 | ~25          |
| `packages/arch-ai/src/tracing/types.ts`                                                   | `ArchSeedRequest`, `ArchSpanSeedInput`, public config types                                                          | ~70          |
| `packages/arch-ai/src/tracing/arch-event-types.ts`                                        | 6 `arch_*` event type constants + union type                                                                         | ~30          |
| `packages/arch-ai/src/tracing/arch-span-attributes.ts`                                    | Attribute key constants (`llm.model`, `tool.name`, `arch.systemEvent`, etc.)                                         | ~80          |
| `packages/arch-ai/src/tracing/arch-span.ts`                                               | `ArchSpanImpl` class (3-event lifecycle, idempotent end, setStatus)                                                  | ~150         |
| `packages/arch-ai/src/tracing/arch-tracer.ts`                                             | `ArchTracer` class (ALS, conveniences, bubble-up, cap, `run()`)                                                      | ~250         |
| `packages/arch-ai/src/tracing/redaction.ts`                                               | `ArchRedactionBoundary` (scrubSecrets + redactPII + 4KB + fail-closed)                                               | ~150         |
| `packages/arch-ai/src/tracing/factory.ts`                                                 | `createArchTracer()` / `createArchTraceReader()` + kill-switch resolution                                            | ~100         |
| `packages/arch-ai/src/tracing/tracer-registry.ts`                                         | Per-session `ArchTracer` + `MongoWritePipeline` cache; dispose on terminal                                           | ~100         |
| `packages/arch-ai/src/tracing/providers/mongo-write-pipeline.ts`                          | Buffered writes; 3-event dispatch; atomic revision claim; fail-closed flush                                          | ~300         |
| `packages/arch-ai/src/tracing/providers/mongo-trace-reader.ts`                            | Scoped queries (project + onboarding); agentName projection; poll cap                                                | ~200         |
| `packages/arch-ai/src/tracing/__tests__/arch-tracer.test.ts`                              | UT-1 (ALS), UT-2 (idempotent end), helpers                                                                           | ~200         |
| `packages/arch-ai/src/tracing/__tests__/error-bubbling.test.ts`                           | UT-3 (bubble-up chain), UT-3b (late bubble to ended parent)                                                          | ~120         |
| `packages/arch-ai/src/tracing/__tests__/redaction.test.ts`                                | UT-4 (scrub patterns, truncation, raw-mode tagging)                                                                  | ~180         |
| `packages/arch-ai/src/tracing/__tests__/redaction-isolation.test.ts`                      | INT-5b (fail-closed on scrubber exception)                                                                           | ~80          |
| `packages/arch-ai/src/tracing/__tests__/status-mapping.test.ts`                           | UT-5 (`ok` → `completed`)                                                                                            | ~50          |
| `packages/arch-ai/src/tracing/__tests__/mongo-write-pipeline.test.ts`                     | INT-4, INT-5, INT-6, UT-10, UT-11 (pipeline behavior against MongoMemoryServer)                                      | ~400         |
| `packages/arch-ai/src/tracing/__tests__/phase-transition.integration.test.ts`             | INT-8 (phase span + transition event)                                                                                | ~150         |
| `packages/arch-ai/src/tracing/__tests__/helpers/stub-llm-client.ts`                       | Deterministic `onStepFinish` stub (DI for INT-7 / E2E-1)                                                             | ~80          |
| `packages/arch-ai/src/tracing/__tests__/helpers/stub-tool-executor.ts`                    | Configurable tool outcome stub — `{ success \| error \| timeout \| partial }` + `delayMs` (DI for E2E-1/E2E-2/E2E-3) | ~80          |
| `packages/database/src/models/arch-trace-span.model.ts`                                   | Mongoose schema, 6 indexes (4 scope + spanId unique + expiresAt TTL), tenant plugin                                  | ~180         |
| `packages/database/src/models/arch-trace-session.model.ts`                                | Mongoose schema (revision counter), 3 indexes                                                                        | ~100         |
| `packages/database/src/__tests__/arch-trace-span.model.test.ts`                           | UT-8 (required fields), UT-9 (indexes + TTL)                                                                         | ~150         |
| `packages/database/src/__tests__/arch-trace-session.model.test.ts`                        | UT-7 (monotonic revision counter)                                                                                    | ~80          |
| `packages/database/src/__tests__/tenant-deletion-cascade.integration.test.ts`             | INT-10 (cascade removes both collections)                                                                            | ~120         |
| `apps/studio/src/app/api/projects/[id]/arch-ai/traces/sessions/route.ts`                  | GET project session list                                                                                             | ~80          |
| `apps/studio/src/app/api/projects/[id]/arch-ai/traces/sessions/[sessionId]/route.ts`      | GET project tree                                                                                                     | ~80          |
| `apps/studio/src/app/api/projects/[id]/arch-ai/traces/sessions/[sessionId]/poll/route.ts` | GET project poll                                                                                                     | ~80          |
| `apps/studio/src/app/api/projects/[id]/arch-ai/traces/spans/[spanId]/route.ts`            | GET project span detail                                                                                              | ~70          |
| `apps/studio/src/app/api/projects/[id]/arch-ai/traces/stats/route.ts`                     | GET project stats                                                                                                    | ~120         |
| `apps/studio/src/app/api/arch-ai/traces/onboarding/sessions/route.ts`                     | GET onboarding session list                                                                                          | ~80          |
| `apps/studio/src/app/api/arch-ai/traces/onboarding/sessions/[id]/route.ts`                | GET onboarding tree                                                                                                  | ~80          |
| `apps/studio/src/app/api/arch-ai/traces/onboarding/sessions/[id]/poll/route.ts`           | GET onboarding poll                                                                                                  | ~80          |
| `apps/studio/src/app/api/arch-ai/traces/onboarding/spans/[id]/route.ts`                   | GET onboarding span detail                                                                                           | ~70          |
| `apps/studio/src/app/api/arch-ai/traces/_seed/route.ts`                                   | POST test-only seed (4 actions, `NODE_ENV=test` + admin guard)                                                       | ~180         |
| `apps/studio/src/__tests__/arch-ai/traces-project-scoped.integration.test.ts`             | INT-1 (project + 401/403/404 matrix)                                                                                 | ~250         |
| `apps/studio/src/__tests__/arch-ai/traces-onboarding-scoped.integration.test.ts`          | INT-2 (onboarding scope)                                                                                             | ~200         |
| `apps/studio/src/__tests__/arch-ai/traces-poll.integration.test.ts`                       | INT-3 (relative-revision poll + bubble)                                                                              | ~180         |
| `apps/studio/src/__tests__/arch-ai/traces-llm-instrument.integration.test.ts`             | INT-7 (both `streamText()` sites)                                                                                    | ~200         |
| `apps/studio/src/__tests__/arch-ai/traces-caps.integration.test.ts`                       | INT-9 (2,000-span + 500-span poll cap)                                                                               | ~180         |
| `apps/studio/src/__tests__/arch-ai/sessions-routing.unit.test.ts`                         | NEW — per-session-era routing guard (D-7)                                                                            | ~100         |
| `apps/studio/src/__tests__/e2e/arch-trace-explorer.e2e.test.ts`                           | E2E-4 (cross-scope 404), E2E-6 (redaction at HTTP)                                                                   | ~300         |
| `apps/studio/e2e/arch-trace-explorer.spec.ts`                                             | E2E-1/2/3/5 (Playwright)                                                                                             | ~400         |
| `apps/studio/src/components/admin/TraceExplorer.tsx`                                      | Master-detail container                                                                                              | ~120         |
| `apps/studio/src/components/admin/TraceSessionList.tsx`                                   | Left panel                                                                                                           | ~100         |
| `apps/studio/src/components/admin/TraceSessionCard.tsx`                                   | Session row                                                                                                          | ~80          |
| `apps/studio/src/components/admin/TraceTree.tsx`                                          | Expandable tree root                                                                                                 | ~120         |
| `apps/studio/src/components/admin/TraceTreeNode.tsx`                                      | Recursive node                                                                                                       | ~150         |
| `apps/studio/src/components/admin/SpanDetailPanel.tsx`                                    | Dispatcher for type-specific views                                                                                   | ~80          |
| `apps/studio/src/components/admin/spans/LLMCallDetail.tsx`                                | LLM span detail                                                                                                      | ~120         |
| `apps/studio/src/components/admin/spans/ToolExecutionDetail.tsx`                          | Tool span detail                                                                                                     | ~120         |
| `apps/studio/src/components/admin/spans/PhaseTransitionDetail.tsx`                        | Phase transition detail                                                                                              | ~80          |
| `apps/studio/src/components/admin/SpanMetricCard.tsx`                                     | Reusable metric card                                                                                                 | ~40          |
| `apps/studio/src/store/arch-trace-store.ts`                                               | Zustand store (spanMap, maxRevision, selected, filters) — bare `create`, no middleware                               | ~150         |
| `apps/studio/src/hooks/useArchTraces.ts`                                                  | SWR hook wrapping `refreshInterval` polling; matches `useSessionTraces.ts:89` precedent                              | ~120         |
| `packages/shared-kernel/src/__tests__/model-pricing.test.ts` (may be new or additive)     | UT-6 (rewritten per D-5) asserting `DEFAULT_PRICING` fallback                                                        | ~80          |

**Total new files: 49. New-file LOC estimate: ~6,450.**

### Modified Files

| File                                                    | Change Description                                                                                                                                                                       | Risk   |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `packages/observatory/src/schema/trace-events.ts`       | Additive: widen `TraceEventType` union with 6 `arch_*` members; append to `ALL_TRACE_EVENT_TYPES` array                                                                                  | Low    |
| `packages/database/src/models/index.ts`                 | Append 2 lines: `export { ArchTraceSpan, type IArchTraceSpan } ...`, `export { ArchTraceSession, type IArchTraceSession } ...`                                                           | Low    |
| `packages/arch-ai/src/index.ts`                         | Append: `export * from './tracing/index.js'`                                                                                                                                             | Low    |
| `packages/arch-ai/package.json`                         | Add `mongodb-memory-server: ^11.0.1` to `devDependencies` (version-align with database + studio)                                                                                         | Low    |
| `apps/studio/src/lib/permissions.ts`                    | Register `StudioPermission.ARCH_TRACES_READ = 'arch:traces:read'` constant (catalog only; default grants live in the shared-auth RBAC file below)                                        | Low    |
| `packages/shared-auth/src/rbac/role-permissions.ts`     | Append `'arch:traces:read'` to `TENANT_ROLE_PERMISSIONS.ADMIN` array at L36-55 (OWNER is already `'*:*'` — wildcard covers it). MEMBER TBD per Open Q1 / GAP-008                         | Low    |
| `apps/studio/.env.example`                              | Add **8** env vars: 7 `ARCH_TRACE_*` (`TTL_DAYS`, `RAW_TTL_DAYS`, `BUFFER_SIZE`, `FLUSH_INTERVAL_MS`, `ENABLED`, `RAW_PAYLOADS`, `PROVIDER`) + `NEXT_PUBLIC_FEATURE_ARCH_TRACE_EXPLORER` | Low    |
| `apps/studio/src/app/api/arch-ai/sessions/route.ts`     | Phase 5.1 — per-session-era routing; persist `tracingStore` on session doc; construct `ArchTracer` via factory when flag on                                                              | Medium |
| `apps/studio/src/app/api/arch-ai/message/route.ts`      | Phase 5.3-5.7 — 5 sub-commits; semantic anchors below                                                                                                                                    | Medium |
| `apps/studio/src/components/admin/ArchSettingsPage.tsx` | Register `TraceExplorer` tab behind `NEXT_PUBLIC_FEATURE_ARCH_TRACE_EXPLORER`; legacy `ArchAuditLogsTab` renders when flag off (D-8)                                                     | Low    |
| `apps/studio/src/components/admin/ArchAuditLogsTab.tsx` | **No change in this LLD** — file remains untouched until post-BETA cleanup PR (D-8 + GAP-004)                                                                                            | None   |
| `packages/arch-ai/src/coordinator/phase-machine.ts`     | **No change.** Pure function remains pure (D-3). Instrumentation at call site only.                                                                                                      | None   |
| `packages/shared-kernel/src/model-pricing.ts`           | **No code change** (D-5). Test file updates only.                                                                                                                                        | None   |

**Semantic anchors (D-11) for `apps/studio/src/app/api/arch-ai/message/route.ts`:**

| Anchor                                                                   | Instrumentation Phase |
| ------------------------------------------------------------------------ | --------------------- |
| `export const dynamic = 'force-dynamic'` declaration (top of file)       | Phase 5.2 (verify)    |
| First block that reads `session.tracingStore` after `POST` handler entry | Phase 5.3 (new)       |
| `VALID_STATE_TRANSITIONS` IDLE→ACTIVE block with 409 `SESSION_BUSY`      | Phase 5.3 (no-op)     |
| First `streamText({` call inside ONBOARDING-mode branch                  | Phase 5.4 (new)       |
| Second `streamText({` call inside BUILD-phase agent generation branch    | Phase 5.5 (new)       |
| Tool executor loop (`for (const toolCall of ...)` or equivalent)         | Phase 5.6 (new)       |
| Sole call site of `transitionPhase(refreshed, next)` (currently L4940)   | Phase 5.7 (new)       |

Phase 5 implementer MUST rebase on `arch/stability` tip before each sub-commit and re-verify anchors. If an anchor has moved or been refactored away, STOP and escalate — do not guess.

### Deleted Files

**None.** GAP-004 legacy cleanup (`packages/arch-ai/src/audit/`, `arch-audit-log.model.ts`, 4 legacy audit-logs routes, `ArchAuditLogsTab.tsx`) is deferred to a post-BETA follow-up PR (D-8).

---

## 3. Implementation Phases

Every phase is independently deployable and testable. No phase leaves the system broken. Every phase ships behind the feature flag; emission is a no-op until Phase 5 wires it in.

### Phase 1: Data Layer

**Goal**: Observatory union widening + Mongoose models for `arch_trace_spans` and `arch_trace_sessions`, complete with indexes + TTL + tenant-delete cascade. Zero dependencies on subsequent phases.

**Tasks**:

1.1. **Widen observatory `TraceEventType` union** at `packages/observatory/src/schema/trace-events.ts:241-268`

- Add 6 string-literal union members: `'arch_phase_transition'`, `'arch_build_event'`, `'arch_gate_response'`, `'arch_session_event'`, `'arch_spec_update'`, `'arch_system_event'`
- Append same strings to `ALL_TRACE_EVENT_TYPES` runtime array (L276-464)
- Optional data-shape interfaces in `TraceEventData` union (L538-561) may be deferred

  1.2. **Create `packages/database/src/models/arch-trace-span.model.ts`**

- `IArchTraceSpan` interface matching HLD §5 shape
- Mongoose schema with all fields, `status` enum, `attributes: Map<string, string>`, `events` Mixed array
- 6 indexes (feature spec §9): `{tenantId, projectId, sessionId, startTime}`, `{tenantId, projectId, sessionId, revision}`, `{tenantId, userId, sessionId, startTime}`, `{tenantId, userId, sessionId, revision}`, `{spanId: 1} unique`, `{expiresAt: 1} TTL expireAfterSeconds: 0`
- Apply `tenantIsolationPlugin` (defense-in-depth)
- Reuse `uuidv7` from `packages/database/src/mongo/base-document.ts` per HLD R1 non-blocking note 3
- Export model with `mongoose.models` guard (pattern: `arch-journal.model.ts`)

  1.3. **Create `packages/database/src/models/arch-trace-session.model.ts`**

- `IArchTraceSession` interface with `sessionId` unique, `tenantId`, `userId`, `projectId`, `revision: number` default 0
- 3 indexes: `{sessionId: 1} unique`, `{tenantId, projectId}`, `{tenantId, userId}`
- Same `mongoose.models` guard pattern

  1.4. **Add exports** to `packages/database/src/models/index.ts` (2 lines)

  1.5. **Register tenant-deletion cascade** (C-1 fix — exact file, no "seam assumed"):

- **File**: `packages/database/src/cascade/cascade-delete.ts` — `deleteTenant(tenantId)` function at L49
- **Append** two lines alongside the existing `counts.XXX = (await XXX.deleteMany({ tenantId })).deletedCount` block (current pattern at L106-151):
  ```typescript
  counts.ArchTraceSpan = (await ArchTraceSpan.deleteMany({ tenantId })).deletedCount;
  counts.ArchTraceSession = (await ArchTraceSession.deleteMany({ tenantId })).deletedCount;
  ```
- Import both models at the top of the file alongside existing model imports
- **Pre-existing gap disclosure** — during verification, Phase 1 implementer discovered that predecessor collections (`ArchAuditLog`, `ArchSession`, `ArchJournal`) are NOT present in `deleteTenant()` today; they orphan on tenant delete. This is **out of scope for this LLD** (would expand Phase 1 beyond its 2-3 commit target and violate D-1). **Must file a separate ticket** before Phase 1 commit: "ABLP-XXX: Add `ArchAuditLog` / `ArchSession` / `ArchJournal` tenant-delete cascade (GDPR gap)" — linked in Phase 1 commit message as `References: ABLP-XXX`
- Add integration test INT-10 at `packages/database/src/__tests__/tenant-deletion-cascade.integration.test.ts` asserting only the two NEW collections cascade (pre-existing gap tested separately under the filed ticket)

  1.6. **Write model unit tests**

- `packages/database/src/__tests__/arch-trace-span.model.test.ts` — UT-8 (required fields), UT-9 (6 indexes exist)
- `packages/database/src/__tests__/arch-trace-session.model.test.ts` — UT-7 (monotonic revision via `findOneAndUpdate($inc)`)
- `packages/database/src/__tests__/tenant-deletion-cascade.integration.test.ts` — INT-10 (cascade scoped to tenant)

**Files Touched**:

- `packages/observatory/src/schema/trace-events.ts` — modified (2 spots)
- `packages/database/src/models/arch-trace-span.model.ts` — NEW
- `packages/database/src/models/arch-trace-session.model.ts` — NEW
- `packages/database/src/models/index.ts` — add 2 export lines
- `packages/database/src/cascade/cascade-delete.ts` — add 2 `deleteMany` lines inside `deleteTenant()` (L49 function); add 2 imports
- `packages/database/src/__tests__/arch-trace-span.model.test.ts` — NEW
- `packages/database/src/__tests__/arch-trace-session.model.test.ts` — NEW
- `packages/database/src/__tests__/tenant-deletion-cascade.integration.test.ts` — NEW

**Exit Criteria**:

- [ ] `pnpm build` at repo root succeeds with 0 errors (L-3 guard: observatory union widening is type-safe across runtime / search-ai / compiler exhaustive switches)
- [ ] `pnpm build --filter=@agent-platform/observatory --filter=@agent-platform/database` succeeds with 0 errors
- [ ] Observatory widening is purely additive (no deletions); old `TraceEventType` consumers compile unchanged
- [ ] `ArchTraceSpan.init()` creates all 6 indexes when connected to MongoDB (verified via `model.collection.getIndexes()` in UT-9)
- [ ] `ArchTraceSession.findOneAndUpdate({ sessionId }, { $inc: { revision: 10 } })` returns monotonic values (UT-7)
- [ ] UT-7, UT-8, UT-9 pass
- [ ] INT-10 passes (cascade deletes both NEW collections scoped to tenant; other tenant unaffected)
- [ ] `deleteTenant()` in `packages/database/src/cascade/cascade-delete.ts:49` includes `counts.ArchTraceSpan = ...` and `counts.ArchTraceSession = ...` (verified by grep: `grep -n 'ArchTraceSpan\|ArchTraceSession' packages/database/src/cascade/cascade-delete.ts` returns ≥ 4 lines)
- [ ] Separate ticket filed for predecessor cascade gap (`ArchAuditLog` / `ArchSession` / `ArchJournal`); ticket number cited in Phase 1 commit message
- [ ] `pnpm test --filter=@agent-platform/database` green
- [ ] New exports appear in `packages/database/src/models/index.ts` (verified by grep)
- [ ] `tenantIsolationPlugin` applied to both new models AND verified to no-op when no ALS context is registered (L-1 guard — queries must still return results in Studio without ALS provider)

**Test Strategy**:

- Unit: schema validation, index inspection (UT-7, UT-8, UT-9)
- Integration: MongoMemoryServer-backed cascade test (INT-10)
- E2E: N/A for this phase

**Rollback**:

Revert the commit. New collections may already exist in dev MongoDB — drop via `db.arch_trace_spans.drop()` + `db.arch_trace_sessions.drop()` manually; no migration touched other data. Observatory widening is type-only — no runtime impact when reverted.

---

### Phase 2: Tracing Core

**Goal**: `ArchTracer` + `ArchSpanImpl` + `ArchRedactionBoundary` + factory + types + constants. All pure/in-memory — no MongoDB dependency **in the tracing-core primitives** (tests inject stub `WritePipeline` implementations via DI). `factory.ts` declares the wiring contract; the `MongoWritePipeline` it wraps lands in Phase 3. Phase 2 is buildable and unit-testable on its own; phase 2 does NOT produce a working `createArchTracer()` with a real pipeline until Phase 3.

**Tasks**:

2.1. **Create `packages/arch-ai/src/tracing/constants.ts`** with `ARCH_AGENT_NAME`, span/poll caps, buffer defaults, truncation limit.

2.2. **Create `packages/arch-ai/src/tracing/arch-event-types.ts`** — 6 constants + union type per HLD §3.

2.3. **Create `packages/arch-ai/src/tracing/arch-span-attributes.ts`** — key constants (`llm.model`, `llm.inputTokens`, `llm.outputTokens`, `llm.totalTokens`, `llm.finishReason`, `llm.estimatedCost`, `tool.name`, `tool.callId`, `tool.resultStatus`, `tool.retryCount`, `tool.inputSummary`, `tool.durationMs`, `arch.systemEvent`, `trace.rawCapture`) with typed getter/setter helpers.

2.4. **Create `packages/arch-ai/src/tracing/arch-span.ts`** — `ArchSpanImpl` class:

- Implements write-side `Span`
- Constructor emits `span_start` event via `writePipeline.write({ type: 'span_start', ... })`
- `setAttribute(key, value)` — buffer attribute delta locally; emit `span_update` on next flush boundary or coalesce internally
- `addEvent(name, data?)` — buffer event; flush on boundary
- `setStatus(status: 'ok' | 'error', message?)` — set `attributes['span.status']`; if 'error', schedule bubble-up to parent on `end()`
- `end()` — idempotent (UT-2); emits `span_end` with final status (`ok` → `completed`, `error` → `error`), `endTime`, `durationMs`, full attributes Map, full events array; triggers bubble-up for error ancestors (FR-11)
- Tracks `ended: boolean`, rejects double-end with warn log

  2.5. **Create `packages/arch-ai/src/tracing/arch-tracer.ts`** — `ArchTracer` class:

- `AsyncLocalStorage<ArchSpan>` for parent propagation (mirrors `apps/runtime/src/services/tracing/tracer.ts:34`)
- `startSpan(name, options?)` — reads parent via `getStore()`; generates spanId + traceId (or inherits); returns `ArchSpan`
- `run<T>(span, fn)` — `spanStorage.run(span, fn)` (mirror runtime L99-105)
- `activeSpan()` returns `getStore() ?? null`
- `activePhaseSpan()` — internal field `currentPhaseSpan`, updated by `startPhaseSpan` + `endPhaseSpan()` helper (D-13)
- Convenience methods: `startPhaseSpan(phase)`, `startTurnSpan(turnIndex)`, `startLLMCallSpan(model)`, `startToolSpan(toolName)` — each sets `spanType` attribute and predefined scope attrs
- `emitSystemEvent({ kind: 'span_cap_exceeded', context })` — emits single `arch_system_event` span with `arch.systemEvent` attr, status 'error' (FR-22)
- Per-session span counter; `startSpan()` increments and returns no-op cap-exceeded sentinel if `count > SPAN_CAP_PER_SESSION` (D-14)
- `dispose()` — flush pipeline, clear any timers

  2.6. **Create `packages/arch-ai/src/tracing/redaction.ts`** — `ArchRedactionBoundary`:

- Wraps any `WritePipeline`
- `write(event)` — for each attribute value and event data:
  1. Apply `scrubSecrets()` (regex from `packages/compiler/src/platform/constructs/executors/scrub-patterns.ts:22-41`)
  2. Apply `redactPII()` (`packages/compiler/src/platform/security/pii-detector.ts`)
  3. If not `rawPayloads`, truncate to `TRUNCATION_LIMIT_BYTES` (4 KB) with `[truncated]` marker
  4. Tag span with `trace.rawCapture='true'` if `rawPayloads` mode
- Fail-closed: if any scrubber throws, replace value with `[REDACTION_FAILED]` marker, log `createLogger('arch-ai:tracing').warn({ redaction_failed: true, ...ctx })`, pass event through to pipeline (INT-5b). **Logger namespace convention (H-1 R2 fix)**: package internals (`packages/arch-ai/src/tracing/`) use `createLogger('arch-ai:tracing')`; Studio route handlers (`apps/studio/src/app/api/arch-ai/traces/...`) use `createLogger('api:arch-ai:traces:<sub-resource>')` per Studio convention (e.g. `api:arch-ai:traces:sessions`, `api:arch-ai:traces:spans`). The `api:` prefix distinguishes HTTP-handler logs from package-internal logs in aggregated output.

  2.7. **Create `packages/arch-ai/src/tracing/types.ts`** — public types (`ArchSeedRequest`, `ArchSpanSeedInput`, etc.)

  2.8. **Create `packages/arch-ai/src/tracing/factory.ts`** — `createArchTracer(config)`:

- Read `process.env.ARCH_TRACE_ENABLED` — if `'false'`, return NoOpTracer (zero-overhead implementations of all methods)
- Read `process.env.ARCH_TRACE_RAW_PAYLOADS` to decide `rawPayloads`
- Wrap `MongoWritePipeline` (from Phase 3) with `ArchRedactionBoundary`
- Return configured `ArchTracer`
- Also: `createArchTraceReader({ spanModel, sessionModel })` returns `MongoTraceReader` (D-6 per-request construction; this factory is a thin convenience)

  2.9. **Create `packages/arch-ai/src/tracing/index.ts`** — public API barrel.

  2.10. **Add `export * from './tracing/index.js'` to `packages/arch-ai/src/index.ts`**.

  2.11. **Add `mongodb-memory-server: ^11.0.1` to `packages/arch-ai/package.json`** `devDependencies`; run `pnpm install` at root to lock.

  2.12. **Write unit tests** (all in `packages/arch-ai/src/tracing/__tests__/`):

- `arch-tracer.test.ts` — UT-1 (ALS parent propagation), UT-2 (double-end no-op)
- `error-bubbling.test.ts` — UT-3 (bubble chain), UT-3b (late bubble to ended parent)
- `redaction.test.ts` — UT-4 (scrub patterns, truncation, raw-mode tag)
- `redaction-isolation.test.ts` — INT-5b (fail-closed on scrubber exception) **+ H-4 guard sub-cases**: (a) `scrubSecrets` throws → `[REDACTION_FAILED]` marker; (b) `redactPII` throws on pathological input (e.g. `Map` instance, circular object, non-string value) → same fail-closed outcome; (c) attribute serialization throws → span still emits with all three attributes replaced by `[REDACTION_FAILED]`
- `status-mapping.test.ts` — UT-5 (`ok` → `completed`)

  2.13. **Update `packages/shared-kernel/src/__tests__/model-pricing.test.ts`** per D-5 / HD-4:

- UT-6 asserts: every model in known list returns positive cost equal to its `MODEL_PRICING` entry; unknown model returns positive cost equal to `DEFAULT_PRICING` fallback (NOT null)
- Do NOT change `packages/shared-kernel/src/model-pricing.ts` code

**Files Touched**: See File-Level Change Map "Phase 2" rows (all Phase 2 NEW files).

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/arch-ai --filter=@agent-platform/shared-kernel` succeeds with 0 errors
- [ ] UT-1, UT-2, UT-3, UT-3b, UT-4, UT-5, UT-6 all pass
- [ ] INT-5b passes (redaction exception does NOT drop span; data replaced with `[REDACTION_FAILED]`)
- [ ] `ArchTracer` with `ARCH_TRACE_ENABLED=false` returns a no-op tracer whose `startSpan` / `setAttribute` / `end` / `run` are all zero-overhead
- [ ] `ArchSpan.setStatus('error')` on child updates parent status on `end()` (UT-3); bubble stops at already-error ancestor
- [ ] `tsc --noEmit` clean
- [ ] `packages/arch-ai/package.json` has `mongodb-memory-server` in devDependencies

**Test Strategy**:

- Unit: pure function tests for tracer lifecycle, redaction, status mapping, error bubbling — no MongoDB
- Integration: N/A (provider lives in Phase 3)
- E2E: N/A

**Rollback**:

Revert Phase 2 commits. No production impact — the module is not yet wired into any route or emitter.

---

### Phase 3: MongoDB Provider

**Goal**: `MongoWritePipeline` + `MongoTraceReader` + `tracerRegistry` (per-session cache). Provider-level integration tests exercise real MongoDB (`MongoMemoryServer`).

**Tasks**:

3.1. **Create `packages/arch-ai/src/tracing/providers/mongo-write-pipeline.ts`** — implements `WritePipeline`:

- In-memory buffer capped at `DEFAULT_BUFFER_MAX` (100 spans) with overflow drop + warn log (UT-10)
- `write(event)` switches on `event.type`:
  - `span_start` → buffer INSERT (status=`running`, startTime, scope fields)
  - `span_update` → buffer UPDATE (`$set` attributes delta, `$push` events delta)
  - `span_end` → buffer UPSERT with `$setOnInsert: { traceId, parentSpanId, name, startTime, tenantId, userId, sessionId, projectId, spanType }`; `$set: { status, endTime, durationMs, attributes, events }`
- `startTime` derivation for upsert-only case (INT-4 firm rule): `startTime = endTime - durationMs` if `durationMs` present, else `startTime = endTime`
- `expiresAt` computed at write time: `now + (rawPayloads ? ARCH_TRACE_RAW_TTL_DAYS : ARCH_TRACE_TTL_DAYS) * 86_400_000` ms
- `flush()`:
  1. Atomic revision claim: `const { revision: max } = await sessionModel.findOneAndUpdate({ sessionId }, { $inc: { revision: batchSize } }, { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true })`
  2. Stamp each write with `revision = max - batchSize + i + 1`
  3. `spanModel.bulkWrite(ops, { ordered: true })`
  4. Errors logged via `createLogger('arch-ai:tracing').warn({ bulkwrite_failed, batchSize, error })`; buffer cleared (UT-11)
- Timer: `setTimeout(() => flush(), DEFAULT_FLUSH_INTERVAL_MS)` — reset on each `write()`
- Threshold flush: when buffer ≥ `DEFAULT_BUFFER_THRESHOLD` (50)
- `ARCH_TRACE_ENABLED=false` per-emission guard (M-3 fix): `if (process.env.ARCH_TRACE_ENABLED === 'false') return` as the **first statement** of `write()`; the env var is re-read every call so SIGHUP reloads take effect immediately. Do NOT cache in a constructor-scoped boolean.
- `rawPayloads` frozen-per-session (M-4 fix): the pipeline's `rawPayloads: boolean` is read ONCE from `process.env.ARCH_TRACE_RAW_PAYLOADS` at `tracerRegistry.getOrCreate(sessionId, ...)` construction time and pinned for the session's lifetime. Mid-session env flips do NOT affect already-running sessions (predictable TTL + consistent `trace.rawCapture` tagging); new sessions get the new value.
- `dispose()` — flush + clear timer

  3.2. **Create `packages/arch-ai/src/tracing/providers/mongo-trace-reader.ts`** — scoped queries:

- `listSessions(scope, { page, limit })` — aggregates from `arch_trace_spans` grouped by `sessionId` using the root span (`parentSpanId: null`) as name source; `.lean()`; pagination via skip/limit
- `fetchTree(scope & sessionId)` — `spanModel.find({ ...scope, sessionId }).sort({ startTime: 1 }).lean()`; projects `agentName: 'arch-ai'` onto every returned row (D-4)
- `pollSince(scope & sessionId, sinceRevision)` — `spanModel.find({ ...scope, sessionId, revision: { $gt: sinceRevision } }).sort({ revision: 1 }).limit(POLL_SPAN_CAP + 1).lean()`; if > POLL_SPAN_CAP, return first POLL_SPAN_CAP with `nextRevision = last.revision`; else `nextRevision = null`
- `fetchSpan(scope & spanId)` — `spanModel.findOne({ ...scope, spanId }).lean()`; NOT `findById` + post-verify (regression guard per INT-1 step 2)
- `fetchStats(scope)` — aggregation grouping by `attributes['llm.model']` and phase (`arch.phase`) summing tokens and cost; `$toInt`/`$toDouble` on Map values in pipeline (R2 non-blocking note 5)

  3.3. **Create `packages/arch-ai/src/tracing/tracer-registry.ts`** — per-session cache:

- `Map<sessionId, { tracer: ArchTracer; pipeline: MongoWritePipeline; ttl: NodeJS.Timeout }>`
- `getOrCreate(sessionId, factoryArgs)` returns existing or constructs + caches
- `dispose(sessionId)` flushes and evicts
- TTL eviction after 30 min idle (session terminal + grace period); calls `dispose()` before removing
- Max size cap (100 sessions concurrent) with LRU eviction + warn log — per CLAUDE.md "every in-memory Map needs max size + TTL + eviction"

  3.4. **Integrate `estimateCost()` from `@agent-platform/shared-kernel/model-pricing.ts:17-71`** at the llm_call span-end path (wired in Phase 5.4/5.5). HLD R1 M-3 note: add `packages/arch-ai/src/tracing/` to the consumers list in `model-pricing.ts` header when the first call site is wired.

  3.5. **Write provider integration tests** (all use `MongoMemoryServer` via local `beforeAll` per test spec §3):

- `mongo-write-pipeline.test.ts` — INT-4 (upsert fallback with pinned `startTime` derivation), INT-5 (redaction scrubs before storage — end-to-end through the real boundary), INT-6 (atomic revision), UT-10 (buffer overflow cap), UT-11 (flush-failure fire-and-forget) **+ M-5 sub-case**: partial `bulkWrite({ ordered: true })` failure where ops 1-2 commit + ops 3-10 fail — assert (i) no exception propagates to caller, (ii) buffer is cleared (NOT retried to avoid duplicate inserts), (iii) warn log cites `batchSize`, (iv) revision gaps 3-10 are harmless (next flush claims from max+1)
- `phase-transition.integration.test.ts` — INT-8 (phase span + transition event when `transitionPhase()` would have been called — simulated via `_seed` + direct tracer invocation)

**Files Touched**:

- `packages/arch-ai/src/tracing/providers/mongo-write-pipeline.ts` — NEW
- `packages/arch-ai/src/tracing/providers/mongo-trace-reader.ts` — NEW
- `packages/arch-ai/src/tracing/tracer-registry.ts` — NEW
- `packages/arch-ai/src/tracing/__tests__/mongo-write-pipeline.test.ts` — NEW
- `packages/arch-ai/src/tracing/__tests__/phase-transition.integration.test.ts` — NEW
- `packages/shared-kernel/src/model-pricing.ts` — update header comment only (track new consumer)

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/arch-ai` succeeds
- [ ] INT-4 passes (upsert without prior `span_start` creates doc with `startTime = endTime - durationMs` when `durationMs` set, else `startTime = endTime`)
- [ ] INT-5 passes (secrets + PII scrubbed before hitting MongoDB; 4KB truncation in default mode; full-scrubbed retention in raw mode with `expiresAt = now + 7d`)
- [ ] INT-6 passes (two sequential flushes claim revisions 1-10 and 11-20 with no overlap; ordered bulkWrite commits N before N+1)
- [ ] UT-10 passes (buffer caps at 100; overflow drops oldest with warn log)
- [ ] UT-11 passes (`bulkWrite` throws → no exception propagates; buffer cleared; warn log emitted with failure context)
- [ ] INT-8 passes (phase span + transition event round-trip from tracer to Mongo)
- [ ] `tracerRegistry` LRU eviction + TTL dispose tested via unit scenario (eviction triggers pipeline `flush` + `dispose`; cache size never exceeds max)
- [ ] `pnpm test --filter=@agent-platform/arch-ai` green

**Test Strategy**:

- Unit: buffer overflow, flush failure handling (UT-10, UT-11)
- Integration: `MongoMemoryServer` for pipeline behavior (INT-4, INT-5, INT-6, INT-8)
- E2E: N/A (lives in Phase 4 + 5)

**Rollback**:

Revert Phase 3 commits. Provider module is consumed only by Phase 4 routes (not yet built) and Phase 5 emission (not yet wired). No production impact.

---

### Phase 4: API Routes

**Goal**: 9 new HTTP routes + test-only `_seed` endpoint + `StudioPermission.ARCH_TRACES_READ` registration. Zero dependencies on emission wiring.

**Tasks**:

4.1. **Register permission — two-file update** (R5 M-1 correction):

- **Catalog**: `apps/studio/src/lib/permissions.ts` — add `ARCH_TRACES_READ = 'arch:traces:read'` to the `StudioPermission` constant (the enum-like object, not a default-grant location)
- **Default grants**: `packages/shared-auth/src/rbac/role-permissions.ts:34-111` — append `'arch:traces:read'` to the `ADMIN` role's array (L36-55); `OWNER` already has `'*:*'` wildcard so no action needed for OWNER. MEMBER / OPERATOR / VIEWER stay unchanged pending Open Q1 resolution (GAP-008 — BETA blocker)
- Integration tests use explicit grants (not dependent on MEMBER default)

  4.2. **Create 5 project-scoped routes** under `apps/studio/src/app/api/projects/[id]/arch-ai/traces/`:

- Each route: `export const dynamic = 'force-dynamic'`; explicitly NOT `runtime = 'edge'` (HLD §4 Concern 4 firm rule)
- Wrap every handler with `withRouteHandler({ requireProject: true, permissions: StudioPermission.ARCH_TRACES_READ }, handler)`
- Construct `MongoTraceReader` per-request via DI (D-6)
- Every query includes explicit `{ tenantId: ctx.tenantId, projectId: ctx.project.id }` filter
- Poll endpoint validates `sinceRevision` via `z.coerce.number().int().nonnegative()`
- **Response envelope (D-17)**: pick the correct helper from `apps/studio/src/lib/api-response.ts` per response shape:
  - List + pagination → `listJson(entries, { total, page, hasMore })` (L64; shape `{ success: true, data, pagination }`)
  - Single resource → `successJson(key, data)` (L59; shape `{ success: true, [key]: data }` — e.g. `successJson('span', span)` or `successJson('stats', stats)`)
  - Poll (custom shape) → `actionJson({ spans, nextRevision })` (L69; shape `{ success: true, ...extra }`)
  - Errors → `errorJson(message, status, code)`
- Do NOT hand-build `NextResponse.json({ success: true, data: ... })` literals — helpers enforce envelope shape consistency

  4.3. **Create 4 onboarding-scoped routes** under `apps/studio/src/app/api/arch-ai/traces/onboarding/`:

- Wrap with `withRouteHandler({}, handler)` (default `requireAuth` only; no `requireProject`)
- Filter every query by `{ tenantId: ctx.user.tenantId, userId: ctx.user.id, projectId: null }`
- **HD-12 note — intentional 403-absence**: onboarding routes pass no `permissions` option to `withRouteHandler`, so the 403 branch is unreachable. Access is gated purely by the `{ tenantId, userId, projectId: null }` scope filter. Any request for a sessionId belonging to another user returns **404** (no existence leak), not 403. Symmetry with project-scoped routes is intentional: onboarding is user-private by design; there is no separate `arch:traces:onboarding:read` permission

  4.4. **Create test-only `_seed` endpoint** at `apps/studio/src/app/api/arch-ai/traces/_seed/route.ts`:

- Guard: if `process.env.NODE_ENV !== 'test'` return 404
- Auth: `requireAuth` + admin role (mirror `apps/studio/src/app/api/arch-ai/audit-logs/_seed/route.ts`)
- Body validated against `ArchSeedRequest` discriminated union (Zod schema). **H-2 R2 note**: this schema is broader than predecessor's flat `{ entries[] }` shape because the 4 harness actions take different payloads; Zod discriminated union is the primary validation (no `Array.isArray(body.entries)` fallback)
- Dispatch to the 4 action handlers (D-12):
  - `seedSpans` — construct `ArchTracer` with `MongoWritePipeline`; for each span input, call appropriate `startXSpan()` + `setAttribute()` + `setStatus()` + `end()`; flush if `flushImmediately`
  - `updateStatus` — load span → reconstruct tracer scope → emit `span_update` → `setStatus(...)` → `end()` (produces new revision)
  - `bubbleError` — load root span → call tracer's internal bubble-up routine to propagate error up the chain
  - `reset` — `ArchTraceSpan.deleteMany({ sessionId })` + `ArchTraceSession.deleteMany({ sessionId })` (test-only purge)
- Every action writes through real `ArchTracer` → `ArchRedactionBoundary` → `MongoWritePipeline` (NOT `insertMany` bypass)

  4.5. **Write integration tests**:

- `traces-project-scoped.integration.test.ts` — INT-1 (401 unauthenticated, 404 cross-project, 403 no permission, 400 malformed param, 200 same-project; compile-time anchor asserts `StudioPermission.ARCH_TRACES_READ === 'arch:traces:read'`) **+ explicit sub-case (H-3 guard)**: a `spanId` that exists in `tenant-B` is requested by a `tenant-A` user against `/api/projects/:projectAId/arch-ai/traces/spans/<tenantBSpanId>` — MUST return 404 even though `spanId` is globally unique (proves scope-in-query, not post-verify)
- `traces-onboarding-scoped.integration.test.ts` — INT-2 (onboarding scope; cross-user 404; in-project session invisible via onboarding route)
- `traces-poll.integration.test.ts` — INT-3 (relative-revision poll returns changed spans + bubbled ancestors in revision order; empty response at caught-up cursor)
- `traces-caps.integration.test.ts` — INT-9 (span cap emits single `arch_system_event`; poll cap truncates at 500 with continuation)

  4.6. **Write vitest in-process E2E tests**:

- `apps/studio/src/__tests__/e2e/arch-trace-explorer.e2e.test.ts` — E2E-4 (cross-scope 404 matrix across 2 tenants × 2 users), E2E-6 (redaction at HTTP — secrets/PII scrubbed from stored spans)

**Files Touched**: See File-Level Change Map "Phase 4" rows (9 route files + 1 `_seed` route + permissions update + 4 integration test files + 1 vitest E2E file).

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/studio` succeeds
- [ ] `StudioPermission.ARCH_TRACES_READ` registered; default grants applied to OWNER + ADMIN
- [ ] INT-1 passes: 401/400/403/404/200 matrix all correct; `requireProject` runs before permission check (cross-project returns 404, not 403)
- [ ] INT-2 passes: onboarding scope user-isolated within tenant
- [ ] INT-3 passes: poll returns spans in revision order with correct `nextRevision`
- [ ] INT-9 passes: span cap + poll cap enforced
- [ ] E2E-4 passes: 4 auth contexts (2 tenants × 2 users) × 13 step scenarios all 404/200 correctly
- [ ] E2E-6 passes: secrets not in stored spans (default + raw modes); PII replaced; raw mode preserves scrubbed full text with `expiresAt = now + 7d`
- [ ] All 10 new routes (9 scoped + `_seed`) declare `force-dynamic` (M-1 grep: `grep -rn "export const dynamic = 'force-dynamic'" apps/studio/src/app/api/projects/\[id\]/arch-ai/traces/ apps/studio/src/app/api/arch-ai/traces/ | wc -l` equals 10)
- [ ] No new route declares `runtime = 'edge'` (M-2 grep: `grep -rn "runtime = 'edge'" apps/studio/src/app/api/` returns 0 lines)
- [ ] Every route response uses the correct helper (`listJson` / `successJson` / `actionJson` / `errorJson`) from `apps/studio/src/lib/api-response.ts` per D-17 — verified by grep: `grep -rn "NextResponse.json" apps/studio/src/app/api/projects/\[id\]/arch-ai/traces/ apps/studio/src/app/api/arch-ai/traces/` returns 0 results
- [ ] `_seed` endpoint returns 404 when `NODE_ENV !== 'test'`
- [ ] `_seed` endpoint writes through real pipeline (verified by checking `revision` field populated after seed)
- [ ] `pnpm test --filter=@agent-platform/studio` green for new integration + vitest E2E suites

**Test Strategy**:

- Unit: N/A (handlers are thin glue; logic tested in Phase 2 + 3)
- Integration: HTTP → middleware chain → `MongoTraceReader` → MongoDB (`MongoMemoryServer`)
- E2E (vitest tier): cross-scope 404 matrix + redaction at HTTP

**Rollback**:

Revert commits. Routes are feature-flag-independent (flag gates the UI, not the routes) — but the UI has not been built yet, so no consumer. API routes land unused until Phase 5 exposes them.

---

### Phase 5: Emission Wiring + UI + Feature Flag

**Goal**: Wire `ArchTracer` through `message/route.ts` (5 sub-commits) and `sessions/route.ts`; build `TraceExplorer` UI; register tab behind feature flag. End state: when flag on, new UI renders; when flag off, legacy `ArchAuditLogsTab` renders (D-8).

**Pre-flight**:

1. Rebase on `arch/stability` tip
2. Verify all 7 semantic anchors listed in File-Level Change Map still present in `message/route.ts` and `sessions/route.ts`
3. If any anchor has moved significantly, update this LLD via a `[ABLP-162] docs(sdlc): refine LLD anchors` commit BEFORE proceeding

**Tasks**:

5.1. **Per-session-era routing at `sessions/route.ts`** (D-7):

- Read `process.env.NEXT_PUBLIC_FEATURE_ARCH_TRACE_EXPLORER` in the session-create handler
- Persist `tracingStore: 'trace-spans' | 'audit-logs'` on the created session document
- Branch construction: if `tracingStore === 'trace-spans'`, call `createArchTracer(...)`; else continue to construct legacy `AuditLogEmitter` (existing code untouched)
- Backfill handler for sessions missing the field: treat as `audit-logs` (back-compat)
- Unit test: `sessions-routing.unit.test.ts` covers all 3 branches + absent-field default
- Log `{ sessionId, event: 'legacy_session_default_to_audit_logs' }` on backfill

  5.2. **Root session span creation**:

- In `sessions/route.ts:POST` handler, after session document persisted and when `tracingStore === 'trace-spans'`, call `tracer.startSpan('session')` → set initial attributes (`arch.mode`, `arch.phase`) → DO NOT call `end()` — span stays `running` for session lifetime
- Root span `name` = `"New Session"` (placeholder per FR-17)
- Store `rootSpanId` on the session doc so subsequent message handler can look it up

  5.3. **Sub-commit 1 — First-message root-span backfill + turn span entry** (anchor: first line inside `POST` handler of `message/route.ts` after session loaded, before first `streamText()`):

- Load session via existing query
- Read `session.tracingStore`; if `'audit-logs'`, skip all tracer logic (legacy emitter remains wired)
- Otherwise: get or create `ArchTracer` from `tracerRegistry.getOrCreate(sessionId, ...)`
- If `session.messages.length === 1` (first user message): backfill `ArchTraceSpan.updateOne({ spanId: session.rootSpanId, ...scope }, { $set: { name: <truncated user message>, revision: <newClaim> } })` AND update `session.name` atomically
- Start turn span via `tracer.startTurnSpan(turnIndex)`; wrap the turn-handler body with `tracer.run(turnSpan, async () => { ... })`

  5.4. **Sub-commit 2 — Wrap first `streamText()` call (ONBOARDING site)**:

- Anchor: first `streamText({` in ONBOARDING-mode code path
- Start `llm_call` span via `tracer.startLLMCallSpan(model)` immediately before the call
- Add `onStepFinish: (stepInfo) => { llmSpan.setAttribute(ArchSpanAttributes.LLM_MODEL, stepInfo.response.modelId); llmSpan.setAttribute(ArchSpanAttributes.LLM_INPUT_TOKENS, String(stepInfo.usage.promptTokens)); ... including estimatedCost via estimateCost(...) }`
- Wrap the entire call in try/catch → `span.setStatus('error', err.message); throw err` in catch → `finally: llmSpan.end()`
- Important: if existing code already has an `onStepFinish` callback, compose with existing — do NOT clobber

  5.5. **Sub-commit 3 — Wrap second `streamText()` call (BUILD site)**:

- Same pattern as 5.4 at the BUILD-phase `streamText({` anchor
- This is the regression-guard site (INT-7 specifically targets this; predecessor shipped with this site un-instrumented)

  5.6. **Sub-commit 4 — Instrument tool executor**:

- Anchor: tool-executor invocation loop (identify via grep for tool-call dispatch pattern)
- Wrap each tool invocation with `tracer.startToolSpan(tool.name)`
- Before invoking: `toolSpan.setAttribute(ArchSpanAttributes.TOOL_NAME, ...)`, `TOOL_CALL_ID`, `TOOL_INPUT_SUMMARY` (scrubbed, truncated via boundary)
- After success: `TOOL_RESULT_STATUS='success'`, `TOOL_DURATION_MS`, `toolSpan.end()`
- On throw: `toolSpan.setStatus('error', err.message)`, `TOOL_RESULT_STATUS='error'`, `toolSpan.end()`; the tracer's bubble-up propagates to parent llm_call → turn → phase → session automatically (FR-11)

  5.7. **Sub-commit 5 — Phase transition instrumentation** (per D-3, anchor: `transitionPhase(refreshed, next)` call at L4940):

- Capture `prevPhase = refreshed.metadata.phase` and `phaseSpanToEnd = tracer.activePhaseSpan()`
- Call `transitionPhase(refreshed, next)` inside try/catch:
  - On throw: `tracer.activeSpan()?.addEvent('arch_phase_transition_failed', { from, to, reason })`; re-throw
  - On success: if `newPhase !== prevPhase`, call `phaseSpanToEnd?.end()` then `const newPhaseSpan = tracer.startPhaseSpan(newPhase); newPhaseSpan.addEvent('arch_phase_transition', { from: prevPhase, to: newPhase, trigger: 'coordinator' })`

    5.8. **Span cap enforcement** at `ArchTracer.startSpan()` (wired in Phase 2; verified end-to-end in this phase via INT-9):

- Counter on tracer instance; when incremented to `SPAN_CAP_PER_SESSION + 1`, call `emitSystemEvent({ kind: 'span_cap_exceeded', sessionId, currentCount })` and return a no-op sentinel span
- Subsequent `startSpan()` calls return sentinel without emitting cap event again

  5.9. **TraceExplorer UI components** (all files new, mount behind flag):

- `TraceExplorer.tsx` — master-detail container; feature-flag gate via `process.env.NEXT_PUBLIC_FEATURE_ARCH_TRACE_EXPLORER`; renders `TraceSessionList` + `TraceTree` + `SpanDetailPanel`. **Location (D-18 / R2 M-1)**: `apps/studio/src/components/admin/` (same directory as legacy `ArchAuditLogsTab.tsx`); do NOT create a new `arch-settings/` directory
- `TraceSessionList.tsx` + `TraceSessionCard.tsx` — left panel, sorted by recency
- `TraceTree.tsx` + `TraceTreeNode.tsx` — recursive expand/collapse, uses observatory `TraceTree` read-side type
- `SpanDetailPanel.tsx` — dispatcher; renders one of `LLMCallDetail`, `ToolExecutionDetail`, `PhaseTransitionDetail`
- `LLMCallDetail.tsx`, `ToolExecutionDetail.tsx`, `PhaseTransitionDetail.tsx` — type-specific panels with `SpanMetricCard` composed inside
- `SpanMetricCard.tsx` — reusable metric card primitive
- Raw-capture warning banner rendered on spans with `trace.rawCapture === 'true'` attribute

  5.10. **Zustand store** `apps/studio/src/store/arch-trace-store.ts` (store) **+ SWR hook** `apps/studio/src/hooks/useArchTraces.ts` (polling):

- Store: bare `create(set, get)` — NO `persist` (data TTL-expires server-side), NO `devtools` middleware; matches `arch-audit-store.ts` precedent (R2 M-3 fix)
- Store state: spanMap per session, maxRevision per session, selectedSessionId, selectedSpanId, filters (All / Errors / Slow)
- Store actions: `setSpansForSession`, `mergeSpanDelta`, `selectSession`, `selectSpan`, `setFilter` (pure state mutations — no I/O inside the store per atomic-selector convention)
- **Polling via SWR (D-19)**: new hook `useArchTraces(sessionId, { isActive })` wraps `swr(key, fetcher, { refreshInterval: isActive ? 5_000 : 0 })` — canonical Studio pattern (see `apps/studio/src/hooks/useSessionTraces.ts:89`, `useHumanTasks.ts:69`, 10+ other hooks). Fetcher calls `apiGet('/api/projects/:id/arch-ai/traces/sessions/:sid/poll?sinceRevision=<maxRev>')`; on response, hook calls `mergeSpanDelta` action. SWR handles teardown on unmount, window blur, error back-off automatically — no manual `setInterval`

  5.11. **Tab registration** at `apps/studio/src/components/admin/ArchSettingsPage.tsx` (verified to exist):

- Modify the tab router/nav to conditionally render based on flag
- When `process.env.NEXT_PUBLIC_FEATURE_ARCH_TRACE_EXPLORER === 'true'`: render `<TraceExplorer />` tab in place of (or alongside — implementer chooses least-disruptive) the `<ArchAuditLogsTab />` tab
- When flag off: continue to render `<ArchAuditLogsTab />` (legacy — D-8, keep until cleanup PR)
- Do NOT delete `ArchAuditLogsTab.tsx` in this commit

  5.12. **Update `apps/studio/.env.example`** with **8** new env vars (defaults from feature spec §11) — 7 `ARCH_TRACE_*` (TTL_DAYS, RAW_TTL_DAYS, BUFFER_SIZE, FLUSH_INTERVAL_MS, ENABLED, RAW_PAYLOADS, PROVIDER) + `NEXT_PUBLIC_FEATURE_ARCH_TRACE_EXPLORER`

  5.13. **Write integration tests** for instrumented paths:

- `traces-llm-instrument.integration.test.ts` — INT-7 (both `streamText()` sites emit `llm_call` spans with all 6 attributes; cost computed via `estimateCost`; parent is turn span)

  5.14. **Write Playwright E2E tests** at `apps/studio/e2e/arch-trace-explorer.spec.ts`:

- E2E-1 (full 5-level tree)
- E2E-2 (error bubbling visible in UI)
- E2E-3 (live polling running → completed)
- E2E-5 (feature flag toggle: off=legacy tab, on=new tab)
- All use stub LLM + stub tool executor via DI; no `vi.mock` of platform packages

  5.15. **Observability log line documentation** (HLD R1 non-blocking note 8):

- Document the log-line shape for flush success / failure / revision claim / upsert fallback in a new or existing runbook doc so log-based alerting is possible at ALPHA

**Files Touched**:

- `apps/studio/src/app/api/arch-ai/sessions/route.ts` — modify (5.1, 5.2)
- `apps/studio/src/app/api/arch-ai/message/route.ts` — modify (5.3-5.7, 5 sub-commits)
- `apps/studio/src/components/admin/*` — new UI files + tab registration mod
- `apps/studio/src/store/arch-trace-store.ts` — NEW
- `apps/studio/.env.example` — modify
- `apps/studio/src/__tests__/arch-ai/sessions-routing.unit.test.ts` — NEW
- `apps/studio/src/__tests__/arch-ai/traces-llm-instrument.integration.test.ts` — NEW
- `apps/studio/e2e/arch-trace-explorer.spec.ts` — NEW

**Exit Criteria**:

- [ ] All 5 sub-commits land with existing E2E suite green after each
- [ ] INT-7 passes for both `streamText()` sites; `llm_call` span has all 6 attributes; parent = turn span; `llm.estimatedCost` from `estimateCost()` (not local map)
- [ ] INT-8 passes (phase transition span + event; verified via INT-8 from Phase 3 but now exercised from real `message/route.ts` path)
- [ ] E2E-1 passes: 5-level tree (session → phase → turn → llm_call → tool_execution) all populated from real session
- [ ] E2E-2 passes: tool error status bubbles to every ancestor visually in UI
- [ ] E2E-3 passes: running span visible in UI during active session; transitions to completed on session end
- [ ] E2E-5 passes: flag toggle cleanly swaps legacy `ArchAuditLogsTab` with new `TraceExplorer`
- [ ] Root span name backfill works: first user message populates `session.name` AND root span `name` atomically (verified via GET `.../traces/sessions` after first message)
- [ ] Per-session-era routing unit test passes for all 3 branches
- [ ] `force-dynamic` declared in every modified route handler; no `runtime = 'edge'` anywhere
- [ ] SSE latency regression < 1 ms p95 confirmed via manual A/B comparison of `/api/arch-ai/message` with tracer on vs off (use existing SSE timing logs; record the before/after in the post-impl-sync log)
- [ ] `.env.example` contains all **8** env vars with documented defaults
- [ ] `ArchAuditLogsTab.tsx` file still present on disk (D-8 verification)
- [ ] `pnpm test --filter=@agent-platform/studio && pnpm build` both green

**Test Strategy**:

- Unit: per-session-era routing branch test
- Integration: LLM instrumentation at both streamText sites (INT-7); phase transition end-to-end (INT-8 re-exercised)
- E2E: full trace tree (E2E-1/2/3/5 via Playwright) — real MongoDB, real Studio, stubs only for LLM client and tool executor injected via DI

**Rollback**:

Two-stage rollback:

- **Emission rollback**: set `ARCH_TRACE_ENABLED=false` → tracer becomes no-op; no spans written; existing sessions' legacy emitter unaffected. Takes effect on next request.
- **UI rollback**: redeploy Studio with `NEXT_PUBLIC_FEATURE_ARCH_TRACE_EXPLORER=false` (build-time-inlined → requires rebuild). Legacy `ArchAuditLogsTab` renders for historical `arch_audit_logs` data.
- **Full revert**: git revert Phase 5 commits (excluding per-session-era routing — that is safely additive). Existing sessions with `tracingStore='trace-spans'` will have orphaned trace data — harmless, TTL-expires.

---

## 4. Wiring Checklist

Every new component must be wired into its callers. This checklist prevents agent-written code from nothing calling it.

### Package / Module wiring

- [ ] `packages/observatory/src/schema/trace-events.ts` — 6 new string-literal union members added to `TraceEventType`
- [ ] `packages/observatory/src/schema/trace-events.ts` — 6 new strings appended to `ALL_TRACE_EVENT_TYPES` runtime array
- [ ] `packages/database/src/models/index.ts` — exports `ArchTraceSpan`, `IArchTraceSpan`, `ArchTraceSession`, `IArchTraceSession`
- [ ] `packages/database/src/tenant-cascade.ts` (or equivalent cascade registry) — `ArchTraceSpan.deleteMany({ tenantId })` + `ArchTraceSession.deleteMany({ tenantId })` hooks registered
- [ ] `packages/arch-ai/src/index.ts` — `export * from './tracing/index.js'`
- [ ] `packages/arch-ai/src/tracing/index.ts` — public API: `ArchTracer`, `createArchTracer`, `ArchRedactionBoundary`, `MongoWritePipeline`, `MongoTraceReader`, `ArchSeedRequest`, `ARCH_AGENT_NAME`, event-type constants, span-attribute constants
- [ ] `packages/arch-ai/package.json` — `mongodb-memory-server: ^11.0.1` in `devDependencies`

### Route registration (Next.js App Router is convention-based — file presence = route)

- [ ] `apps/studio/src/app/api/projects/[id]/arch-ai/traces/sessions/route.ts` exists + exports `GET`
- [ ] `apps/studio/src/app/api/projects/[id]/arch-ai/traces/sessions/[sessionId]/route.ts` exists + exports `GET`
- [ ] `apps/studio/src/app/api/projects/[id]/arch-ai/traces/sessions/[sessionId]/poll/route.ts` exists + exports `GET`
- [ ] `apps/studio/src/app/api/projects/[id]/arch-ai/traces/spans/[spanId]/route.ts` exists + exports `GET`
- [ ] `apps/studio/src/app/api/projects/[id]/arch-ai/traces/stats/route.ts` exists + exports `GET`
- [ ] `apps/studio/src/app/api/arch-ai/traces/onboarding/sessions/route.ts` exists + exports `GET`
- [ ] `apps/studio/src/app/api/arch-ai/traces/onboarding/sessions/[id]/route.ts` exists + exports `GET`
- [ ] `apps/studio/src/app/api/arch-ai/traces/onboarding/sessions/[id]/poll/route.ts` exists + exports `GET`
- [ ] `apps/studio/src/app/api/arch-ai/traces/onboarding/spans/[id]/route.ts` exists + exports `GET`
- [ ] `apps/studio/src/app/api/arch-ai/traces/_seed/route.ts` exists + exports `POST` (guarded)
- [ ] Every new route declares `export const dynamic = 'force-dynamic'`
- [ ] No new route declares `export const runtime = 'edge'`

### Permission + auth

- [ ] `apps/studio/src/lib/permissions.ts` — `StudioPermission.ARCH_TRACES_READ = 'arch:traces:read'` registered (catalog)
- [ ] `packages/shared-auth/src/rbac/role-permissions.ts:36-55` — `'arch:traces:read'` appended to `TENANT_ROLE_PERMISSIONS.ADMIN` array (OWNER already `'*:*'` wildcard covers it; MEMBER pending Open Q1)
- [ ] Every project-scoped route wraps handler with `withRouteHandler({ requireProject: true, permissions: StudioPermission.ARCH_TRACES_READ }, handler)`
- [ ] Every onboarding-scoped route wraps handler with `withRouteHandler({}, handler)` and filters `{ tenantId, userId, projectId: null }`

### UI wiring

- [ ] `TraceExplorer.tsx` tab mounted inside the arch settings page (or the component that renders tab nav)
- [ ] Tab gate condition: `process.env.NEXT_PUBLIC_FEATURE_ARCH_TRACE_EXPLORER === 'true'`
- [ ] When flag off: legacy `ArchAuditLogsTab` continues to render (D-8)
- [ ] `useArchTraceStore` imported and consumed by `TraceExplorer` (not orphaned)
- [ ] Every child component (`TraceSessionList`, `TraceTree`, `SpanDetailPanel`, ...) imported from `TraceExplorer` tree (no orphan files)

### Emission wiring (Phase 5)

- [ ] `POST /api/arch-ai/sessions` reads flag + persists `tracingStore` on session doc
- [ ] `POST /api/arch-ai/message` branches on `session.tracingStore`
- [ ] When `tracingStore='trace-spans'`: `tracerRegistry.getOrCreate()` called at request entry
- [ ] Both `streamText({` call sites have `onStepFinish` wired and `llm_call` span wrapping
- [ ] Tool executor loop wraps each invocation with `tracer.startToolSpan`
- [ ] `transitionPhase()` call site at L4940 wrapped per 5.7
- [ ] Catch blocks in execution chain call `span.setStatus('error', err.message); span.end()`
- [ ] `tracerRegistry.dispose(sessionId)` called from `apps/studio/src/app/api/arch-ai/message/route.ts` **SSE stream's `finally` block** when the session reaches a terminal state (DONE/ERROR/ARCHIVED) — M-7 resolution. Alternative `process.on('SIGTERM')` handler in the server entry point calls `tracerRegistry.flushAll()` for graceful shutdown (Phase 5 polish)

### Config wiring

- [ ] `apps/studio/.env.example` has all 7 env vars with documented defaults
- [ ] `NEXT_PUBLIC_FEATURE_ARCH_TRACE_EXPLORER=false` in committed `.env.example`
- [ ] `ARCH_TRACE_ENABLED=true` in committed `.env.example`

### Background jobs / workers

None. TTL index handles retention. Flush timer is in-process, per-session via `MongoWritePipeline`.

---

## 5. Cross-Phase Concerns

### Database Migrations

**No migrations.** New MongoDB collections `arch_trace_spans` and `arch_trace_sessions` are created on first write (Mongoose auto-creates). Indexes created via `ArchTraceSpan.init()` / `ArchTraceSession.init()` at model registration. Tenant-deletion cascade hook is additive code registration, not a data migration.

Existing `arch_audit_logs` collection is UNTOUCHED. It TTL-expires independently over 90 days. GAP-004 tracks the post-BETA drop.

### Feature Flags

**Two independent flags with different lifecycles**:

| Flag                                      | Scope       | Default | Reload Semantics             | Effect                                                                 |
| ----------------------------------------- | ----------- | ------- | ---------------------------- | ---------------------------------------------------------------------- |
| `NEXT_PUBLIC_FEATURE_ARCH_TRACE_EXPLORER` | UI          | `false` | Build-time-inlined (rebuild) | `true` → `TraceExplorer` tab; `false` → legacy `ArchAuditLogsTab` tab  |
| `ARCH_TRACE_ENABLED`                      | Server kill | `true`  | Runtime-reloadable (SIGHUP)  | `false` → factory returns no-op tracer; per-emission guard in pipeline |

The session's `tracingStore` field is derived from `NEXT_PUBLIC_FEATURE_ARCH_TRACE_EXPLORER` at creation time (D-7). Once pinned, it does not change for that session's lifetime, regardless of subsequent flag flips.

### Configuration Changes

New env vars (feature spec §11 — all declared in `apps/studio/.env.example`):

```bash
ARCH_TRACE_TTL_DAYS=90
ARCH_TRACE_RAW_TTL_DAYS=7
ARCH_TRACE_BUFFER_SIZE=50
ARCH_TRACE_FLUSH_INTERVAL_MS=2000
ARCH_TRACE_ENABLED=true
ARCH_TRACE_RAW_PAYLOADS=false
ARCH_TRACE_PROVIDER=mongo
NEXT_PUBLIC_FEATURE_ARCH_TRACE_EXPLORER=false
```

No secrets. No tenant-level overrides. GAP-001 tracks per-tenant overrides as post-v1 work.

### Phase Dependency DAG (M-6 R4 resolution)

```
Phase 1 (Data Layer) ──┬─> Phase 2 (Tracing Core, pure)
                       │
                       └─> Phase 3 (Mongo Provider) <─── depends on Phase 2's factory contract + Phase 1 models
                                  │
                                  └─> Phase 4 (API Routes) <─── depends on Phase 3's MongoTraceReader + Phase 1 models
                                            │
                                            └─> Phase 5 (Emission Wiring + UI) <─── depends on Phases 2/3/4
```

- Phase 2 can begin once Phase 1's models are stubbed, even if Phase 1 tests lag.
- Phase 3 cannot start until Phase 2's factory + redaction land.
- Phase 4 cannot start until Phase 3 lands (route handlers construct `MongoTraceReader` per request).
- Phase 5 cannot start until Phases 2/3/4 all land.
- **No in-phase parallelism** within Phase 5's 5 sub-commits — they are sequential (each sub-commit's exit criteria gates the next).

### Deployment Topology Assumption (H-1 resolution)

**Studio is deployed as one or more pods behind an SSE-sticky load balancer** — all requests for a given `sessionId` route to the pod that opened the session's SSE stream for the duration of that stream. This is an existing assumption shared with the predecessor `arch-audit-logs` emitter (identical per-request in-memory buffering).

Given that invariant:

- `tracerRegistry` per-pod is **correct**: a session's writes are always issued by one pod during its active lifetime; if the session later opens a new SSE stream after a terminal transition on a different pod, that pod constructs a fresh tracer; no overlap.
- **Span-cap counter** (D-14) is per-pod-per-session. If stickiness breaks (LB re-routes mid-session), two pods could each emit up to `SPAN_CAP_PER_SESSION` for the same session — over-emission past the cap. Correctness loss only; tenant-scope and fire-and-forget preserved. Known operational characteristic, not a blocker.
- **Flush timer + in-memory buffer** (Phase 3.1) is pod-local. On pod shutdown, unflushed spans are lost — fire-and-forget semantics accept this (HLD §4 Concern 5). For graceful shutdown, register `process.on('SIGTERM')` to call `tracerRegistry.flushAll()` before exit — Phase 5 polish, not blocking.

**Action**: Phase 1 implementer confirms with deploy team that Studio's load balancer is SSE-sticky. If NOT, escalate before Phase 3 — the revision-claim strategy would need to move span-cap counter into `arch_trace_sessions` via `$inc`.

### Legacy Code Retention

`packages/arch-ai/src/audit/*`, `packages/database/src/models/arch-audit-log.model.ts`, 4 legacy routes under `apps/studio/src/app/api/arch-ai/audit-logs/*`, and `apps/studio/src/components/admin/ArchAuditLogsTab.tsx` are all UNTOUCHED during Phase 1-5. Flag-conditional UI (D-8) keeps the legacy tab visible when flag is off.

Post-BETA cleanup PR (GAP-004) deletes all five in a single commit — separate from this LLD.

### Commit Discipline (CLAUDE.md alignment)

Each phase produces between 1 and 6 commits:

| Phase   | Target Commit Count | Rationale                                                                                                  |
| ------- | ------------------- | ---------------------------------------------------------------------------------------------------------- |
| Phase 1 | 2-3                 | (1) observatory widening, (2) models + tests + cascade, (3) integration test if split                      |
| Phase 2 | 2                   | (1) tracing-core module + unit tests, (2) model-pricing test fix (D-5)                                     |
| Phase 3 | 2-3                 | (1) mongo-write-pipeline + tracer-registry + tests, (2) mongo-trace-reader, (3) integration tests if split |
| Phase 4 | 3-4                 | (1) permission + route scaffolds, (2) seed endpoint, (3) integration tests, (4) vitest E2E                 |
| Phase 5 | 7-9                 | (1) sessions-routing, (2-6) 5 message-route sub-commits, (7) UI components, (8) store, (9) Playwright E2E  |

Total: 16-21 commits. Every commit passes `pnpm build && pnpm test --filter=<affected>`.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 5 phases complete with all per-phase exit criteria met
- [ ] E2E tests E2E-1 through E2E-6 passing (6/6)
- [ ] Integration tests INT-1 through INT-10 (including INT-5b) passing (11/11)
- [ ] Unit tests UT-1 through UT-11 (including UT-3b) passing (12/12)
- [ ] `pnpm build && pnpm test` green (no regressions in existing test suites)
- [ ] `pnpm test:report` produces no failures for affected packages
- [ ] Feature spec Tests table (§17) updated to reflect **19** actual test files via `/post-impl-sync` — test spec §8 lists 18; the 19th (`apps/studio/src/__tests__/arch-ai/sessions-routing.unit.test.ts`) is LLD-added per D-7; post-impl-sync will reconcile both docs
- [ ] Test spec Coverage Matrix (§1) has no FR marked PLANNED — all are IN PROGRESS or STABLE
- [ ] Testing matrix at `docs/testing/README.md` updated to reflect ALPHA status
- [x] HLD status remains APPROVED (promoted in HLD R3 audit — no further action required)
- [ ] LLD status promoted from DRAFT → DONE
- [ ] Feature spec status promoted PLANNED → ALPHA (see §7 below)
- [ ] `docs/sdlc-logs/arch-trace-explorer/agents.md` (or per-package `agents.md`) updated with learnings

---

## 7. Lifecycle Promotion Criteria (D-RD5 / RD-5)

**ALPHA** (flag default=false, dogfooding ready):

- [ ] All acceptance criteria in §6 met
- [ ] Unit + integration + E2E test counts match feature spec §17 / test spec §1
- [ ] Manual verification checklist (test spec §10) items 1-5 completed
- [ ] SSE latency regression budget < 1 ms p95 confirmed via A/B measurement with tracer on vs off
- [ ] `/post-impl-sync arch-trace-explorer` run; feature spec status field updated to ALPHA
- [ ] Zero CRITICAL and zero HIGH issues in pr-reviewer audits (5 rounds per `/implement`)

**BETA** (flag default=true in prod, legacy tab replaced):

- [ ] ≥ 2 weeks at ALPHA with zero sev-1 / sev-2 incidents
- [ ] Open Q1 resolved: platform-auth team decision on `arch:traces:read` default grant for MEMBER role (GAP-008)
- [ ] E2E-5 flag-toggle test green in production (flag default=true in committed config after approval)
- [ ] `ArchAuditLogsTab.tsx` removal PR merged (separate from this LLD per D-8)
- [ ] Manual verification checklist §10 items 6-10 completed against production
- [ ] Feature spec §14 success metrics hit targets (admin page load < 1 s for session list, < 2 s for tree at typical session size)

**STABLE** (legacy code deleted):

- [ ] ≥ 4 weeks at BETA with zero sev-1 / sev-2 incidents
- [ ] GAP-004 post-BETA cleanup PR merged: deletes `packages/arch-ai/src/audit/`, `arch-audit-log.model.ts`, 4 legacy routes under `apps/studio/src/app/api/arch-ai/audit-logs/*`
- [ ] `arch_audit_logs` MongoDB collection dropped (after 90-day TTL drained per GAP-003)
- [ ] GAP-005 (future-worker concurrency) evaluated — either resolved or formally accepted as permanent constraint in the session-lifecycle contract

---

## 8. Risks

| Risk                                                                                                                            | Phase         | Severity | Mitigation                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-1: AsyncLocalStorage does not propagate across Vercel AI SDK `streamText()` callbacks                                         | Phase 5.4-5.6 | Medium   | INT-7 is the regression guard. Fallback: wrap each `streamText` call with explicit `tracer.run(span, () => streamText({...}))` (runtime pattern). Expected Phase 5 cost if fallback triggers: < 2 h. D-9.                              |
| R-2: `message/route.ts` has drifted since HLD authored (7,479 → N LOC); semantic anchors may have moved                         | Phase 5.3-5.7 | Medium   | D-11 uses semantic anchors rather than line numbers. Pre-flight step in Phase 5 re-verifies every anchor. If an anchor has been refactored away, implementer stops and updates this LLD via a prep commit before proceeding.           |
| R-3: `transitionPhase()` at L4940 may gain additional production call sites after HLD was written                               | Phase 5.7     | Low      | Pre-flight grep: `rg 'transitionPhase\(' packages/ apps/`. If additional call sites exist, apply the same call-site instrumentation pattern to each. If a production caller exists inside `packages/arch-ai/`, re-evaluate D-3.        |
| R-4: Revision counter contention if single-writer invariant is ever relaxed (GAP-005)                                           | Phase 3       | Low      | Architecturally enforced today via SSE request lifecycle + session state machine IDLE→ACTIVE atomic transition. Test INT-6 covers sequential flushes only (not concurrent). If relaxed in future, add Mongo transaction wrapping.      |
| R-5: MongoMemoryServer binary download fails on CI (first run)                                                                  | Phase 1+3+4+5 | Low      | Test spec §3 harness note prescribes try/catch-and-skip in `beforeAll`. Subsequent runs hit binary cache at `~/.cache/mongodb-binaries/`. CI runners must allow outbound network for the first download.                               |
| R-6: `onStepFinish` shape mismatch between Vercel AI SDK version in-repo and what INT-7 asserts                                 | Phase 5.4-5.5 | Low      | Before Phase 5, grep `packages/ apps/` for existing `onStepFinish` usages to confirm actual callback shape. Update INT-7 fixture if real shape diverges (e.g. `response.modelId` vs `stepInfo.model`). Implementation uses real types. |
| R-7: Legacy `ArchAuditLogsTab` consumers break when flag flips (e.g. browser-cached URL)                                        | Phase 5.11    | Low      | Flag gate is server-rendered; browser cache does not see a tab that isn't in the HTML. If legacy `/audit-logs` routes are still linked in nav, those links remain functional during flag transition.                                   |
| R-8: `estimateCost` returns `DEFAULT_PRICING` fallback for a model that is NOT in runtime's `ModelResolutionService` known list | Phase 5.4-5.5 | Low      | Per D-5, this is the documented behavior. `llm.estimatedCost` will be positive but "generic". UI shows the cost; operators can treat high DEFAULT_PRICING costs as a signal to add the model to `MODEL_PRICING`.                       |
| R-9: Open Q1 (arch:traces:read default grants) unresolved blocks BETA but not ALPHA                                             | ALPHA → BETA  | Medium   | Tests use explicit grants and do not depend on the default. Tracked as GAP-008. Escalate to platform-auth team at ALPHA promotion.                                                                                                     |
| R-10: Session.name backfill race — if two `POST /api/arch-ai/message` requests hit simultaneously for the first turn            | Phase 5.3     | Low      | Session state machine's IDLE→ACTIVE atomic transition + 409 SESSION_BUSY guarantees one writer. Only one request observes `messages.length === 1`. Verified by existing state-machine tests.                                           |

---

## 9. Open Questions

1. **Tenant-cascade hook location** (Phase 1.5) — Round 1 resolved this: `packages/database/src/cascade/cascade-delete.ts:deleteTenant()` at L49 is the seam. Closed.
2. **`arch_trace_spans` TTL cascade for still-running spans** — feature spec §15 Open Q4 + HLD §9 Open Q6. Running spans at TTL boundary will be deleted while `endTime` is null. Acceptable for ALPHA; confirm during ALPHA dogfooding.
3. **Observability log-line shape for ALPHA alerting** — HLD R1 non-blocking note 8. Phase 5.15 documents the shape; specific log-based alerting rules tracked separately by ops.
4. **`arch:traces:read` default grant matrix** — Open Q1 / GAP-008. Blocks BETA, not ALPHA.
5. **SSE latency regression measurement methodology** — ALPHA exit criterion says "< 1 ms p95 via A/B measurement". Exact methodology (sample size, duration, traffic profile) TBD in `/implement`. Consensus: run the existing SSE stream with identical inputs before and after the tracer is wired, compare p95 using existing SSE timing logs.

### HLD Open-Question Provenance (M-3 R4 resolution)

| HLD Q                                    | Topic                            | LLD Resolution                                                                           |
| ---------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------- |
| Q1 (arch:traces:read default grant)      | BETA blocker                     | LLD §9 Q4 + §7 BETA criteria (GAP-008)                                                   |
| Q2 (ALS across Vercel AI SDK callbacks)  | Fallback plan needed             | LLD D-9 (skip Phase-0 experiment) + §8 R-1 (explicit `tracer.run()` fallback documented) |
| Q3 (kill-switch evaluation strategy)     | Single-check vs defense-in-depth | LLD D-15 (defense-in-depth: factory-time no-op + per-emission guard)                     |
| Q4 (per-tenant raw-capture toggle)       | Post-v1                          | LLD §5 Configuration Changes (GAP-001 acknowledged as post-v1)                           |
| Q5 (`stats` per-user breakdown)          | Post-v1                          | LLD §5 + Feature spec §15 Open Q5 deferred per privacy review                            |
| Q6 (TTL cascade for still-running spans) | ALPHA dogfooding                 | LLD §9 Q2 (above)                                                                        |
| Q7 (observatory reader consolidation)    | Post-v1                          | LLD §8 R-Y + GAP-007 acknowledgment                                                      |

### Test-Spec Known Gaps (M-2 R4 resolution)

| Gap ID  | Topic                                           | LLD Placement                                                                                                            |
| ------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| GAP-T01 | No load test for 2,000-span UI render           | Accepted for v1; §10 manual checklist item covers render sanity. STABLE-gate item if incidents emerge                    |
| GAP-T02 | No automated axe a11y scan                      | Accepted for v1; §10 manual checklist covers keyboard/ARIA. Planned post-v1 enhancement                                  |
| GAP-T03 | No chaos test for DB-down during flush          | Permanent — fire-and-forget design is silent-drop by spec §12. Not a gate                                                |
| GAP-T04 | No cross-tenant ALS provider test               | Covered indirectly by explicit `{ tenantId }` filters in INT-1. Requires Studio-wide ALS provider registration (post-v1) |
| GAP-T05 | No `arch:traces:read` default grant matrix test | Resolved when Open Q1 resolves (BETA gate per GAP-008); tests currently use explicit grants                              |

---

## 10. References

- **Feature spec**: `docs/features/arch-trace-explorer.md`
- **HLD**: `docs/specs/arch-trace-explorer.hld.md`
- **Test spec**: `docs/testing/arch-trace-explorer.md`
- **Oracle log**: `docs/sdlc-logs/arch-trace-explorer/lld.log.md`
- **Predecessor LLD** (pattern reference): `docs/plans/2026-04-12-arch-audit-logs-impl-plan.md`
- **Runtime tracer reference pattern** (port, don't import): `apps/runtime/src/services/tracing/{tracer.ts, span.ts, write-pipeline.ts, tracer-registry.ts}`
- **Canonical contracts**: `packages/shared-observability/src/tracing/index.ts:6-18`
- **Observatory read-side**: `packages/observatory/src/schema/{trace-events.ts, spans.ts}`
- **Redaction utilities**: `packages/compiler/src/platform/constructs/executors/{scrub-patterns.ts:22-41, trace-scrubber.ts:18-60}`, `security/pii-detector.ts`
- **Model pricing (canonical)**: `packages/shared-kernel/src/model-pricing.ts:17-71`
- **Phase machine** (unchanged): `packages/arch-ai/src/coordinator/phase-machine.ts:95`
- **Route handler** (middleware ordering): `apps/studio/src/lib/route-handler.ts:108-220`
- **Permissions catalog**: `apps/studio/src/lib/permissions.ts:15-63`
- **Session state machine** (single-writer invariant): `packages/arch-ai/src/coordinator/session-state-machine.ts:19-30`; `apps/studio/src/app/api/arch-ai/message/route.ts:547-582, 800`
- **Instrumentation targets** (semantic anchors — not line numbers): `apps/studio/src/app/api/arch-ai/message/route.ts`; `sessions/route.ts:91-110`
- **Feature-flag idiom**: `docs/arch/features/CC-F04-feature-flag.md:13, 35`; `apps/studio/.env.example`
- **CLAUDE.md**: Core Invariants §1 (Resource Isolation), §4 (Traceability), §5 (Compliance); Test Architecture; E2E Test Standards; Commit Discipline
- **Design-quality-gate skill**: 12 architectural concerns (addressed in HLD §4; inherited here)
- **Platform principles skill**: tenant isolation, centralized auth, stateless distributed, traceability, compliance, performance
- **Superpowers design doc** (historical): `docs/superpowers/specs/2026-04-14-arch-trace-explorer-design.md`
