# Default PR Review Gates

Use these gates for every PR review unless the user narrows scope. Append any additional gates the user requests.

This file is split into two layers:

- **Universal core gates** — apply to any project. Don't edit these per-project; they encode review concerns common to all software (regression, security, isolation, dead code, distributed systems, audit logging, message-boundary hygiene, wiring/reachability, code quality, encryption, tests, UX).
- **Project-Specific Gates** (the section near the end of this file) — domain gates for _this_ repo (`agent-transfer`, `customer-contact`, `design-system`, `import-export-roundtrip`, `durable-execution` framework choice, etc.). Override or replace this section per project. The PR-review skill reads it via the `{{DOMAIN_GATES_PATH}}` variable.

When you port this skill to another repo, edit only the "Project-Specific Gates" section. Resolve `{{REPO_HOST}}`, `{{BASE_BRANCH}}`, `{{MONOREPO_APPS}}`, `{{PLATFORM_PKG_GLOBS}}`, `{{TICKET_KEY_REGEX}}`, etc. via the discovery commands in `SKILL.md`'s "Project Configuration" section, not by hardcoding in prose here.

## Mandatory Gates (must be explicitly addressed in every report)

Every PR review report MUST include an explicit verdict for each of these gates: `PASS`, `FAIL`, `UNVERIFIED (<reason>)`, or — for trigger-conditional gates — `N/A (<reason>)`. Do not omit a gate just because nothing was found — say so explicitly. The `rubric_concern: N` annotation maps each gate to `docs/sdlc/change-review-rubric.md` so findings reconcile with the canonical 16-concern rubric.

### Always-applicable (8 gates — no `N/A` allowed)

1. `functional-regression` (rubric 6) — Does this change break or alter behavior of other features?
2. `security` (rubric 8) — Are auth, input validation, secret handling, encryption, **PII pass-through surfaces**, and injection vectors safe? (`pii-passthrough` is a mandatory sub-check.)
3. `isolation` (rubric 1) — Are tenant, project, user, and session-source scoping enforced everywhere the change touches?
4. `stale-or-duplicate-code` (rubric 6) — Did this PR leave dead code, duplicates, or half-migrated flows behind?
5. `cross-pod` (rubric 11) — Is shared state held in Redis/Mongo (not pod-local memory)? Are distributed locks correct? Cache eviction and TTL bounded?
6. `audit-log` (rubric 10) — Do sensitive operations (auth events, secret writes, permission changes, exports, deletions) emit `TraceEvent` / audit-log entries via shared `TraceStore`?
7. `boundary-metadata` (rubric 2) — Are reserved transport keys (e.g. `history` during A2A handoff) kept out of generic forwarded metadata? Sliding-window conversation invariants preserved? Per-message metadata validated at the entry point?
8. `wiring-reachability` (rubric 12) — Do new public surfaces (routes, executors, UI entry points, package exports) have a verified path from a production entry point (`server.ts`, `apps/studio` route handler, public SDK barrel) to the implementation? "Implemented" must equal "reachable."

### Trigger-conditional (emit `N/A (<reason>)` when the trigger does not apply)

9. `coverage-matrix` (rubric 16) — When `docs/features/<slug>.md` and `docs/testing/<slug>.md` exist, is there a clean two-way mapping between code and test spec? Missing testing spec for a non-trivial feature is itself a `FAIL`. `N/A` only for pure infra/refactor PRs with no feature slug.
10. `durable-execution` (rubric 4) — When the PR touches `apps/workflow-engine/**` or imports `@restatedev/*`, are Restate replay rules satisfied? `N/A` otherwise.
11. `agent-transfer` (rubric 4) — When the PR touches `packages/agent-transfer/**`, channel adapters, or `apps/runtime/src/services/transfer/**`: do adapter changes propagate session-end / disposition / wrap-up correctly? Are inline connection edits round-tripped? `N/A` otherwise.
12. `customer-contact` (rubric 3) — When the PR touches contact identity, channel adapters, omnichannel session continuity, or end-user identity resolution (`contactId`, `customerId`, `anonymousId`, channel artifacts): is identity reuse across channels deterministic and tenant-isolated? `N/A` otherwise.
13. `design-system` (rubric 13) — When the PR touches `apps/studio/src/components/**` or any Studio UI: no hardcoded Tailwind palette colors, no native `<select>`, no `bg-accent text-foreground` pairing (use `text-accent-foreground`), no inline-style escape hatches. Use semantic tokens from `@agent-platform/design-tokens`. `N/A` for non-Studio PRs.
14. `import-export-roundtrip` (rubric 7) — When the PR touches `packages/project-io/**` or any IR/manifest/schema consumed by export/import: does an export → import → export round-trip produce identical output? Manifest shape stable? Cross-reference resolution deterministic? `N/A` otherwise.

Below is the full gate definition for each, plus the supporting gates (`code-quality`, `encryption`, `tests`, `ux-ui`) that remain part of the default review.

## Core Gates

- `functional-regression` (mandatory)
  - **callers and consumers**: identify every caller of changed functions, routes, hooks, events, schemas, and shared types. List which features depend on the changed surface.
  - **shared contracts**: changes to shared packages (`@agent-platform/*`, `@abl/*`), DTOs, Zod schemas, event payloads, queue messages, or DB models — confirm all consumers were updated in the same PR or remain compatible.
  - **runtime behavior**: changed prompt builders, model resolution, IR hashing, cache keys, or session lifecycle — confirm existing agents/sessions still resolve and execute correctly.
  - **routes and middleware order**: new or reordered Express routes must not shadow existing routes (static before parameterized). New middleware must not break existing auth or tenant injection.
  - **migrations and schema changes**: backwards-compatible read path, no destructive defaults on existing rows, rollback story exists.
  - **feature flags and rollout**: new behavior gated where existing features depend on the old behavior.
  - **build graph and Dockerfiles**: new packages added to every relevant Dockerfile (`apps/runtime`, `apps/search-ai`, `apps/admin`, `apps/studio`).
  - **regression tests**: existing test suites for adjacent features still pass; PR includes coverage for any newly-touched call sites.
  - **ranked-query ordering** (`ranked-query-ordering` sub-check): when a PR introduces a query function whose name implies ranking or ordering (`getTop*`, `getMost*`, `getSummary*`, `getBest*`, `getRecent*`, or any function that returns a sorted/limited collection), verify the underlying query explicitly orders results before limiting. For SQL: `ORDER BY` must precede `LIMIT`. For Cypher (Neo4j): `collect()[..N]` collects in arbitrary order — results must be ordered via `ORDER BY` before `collect()`, or use a `LIMIT` on an ordered `MATCH`. A function named `getTopValues` or `getAttributeSummaries` that collects arbitrary items and slices them silently returns non-deterministic data, passing all tests because tests don't assert ordering. Hits = `FAIL` under `functional-regression`.
  - **data-mapping completeness** (`data-mapping-completeness` sub-check): when a PR introduces or substantially modifies a builder or mapper function that constructs a typed output from a source schema (e.g. Nango provider config → `IntegrationProvider`, connector catalog entry → runtime auth shape, external provider metadata → OAuth2 params object), verify that every semantically meaningful field in the source has an explicit corresponding assignment in the output. A field that exists in the source but is absent from or silently defaulted in the output (e.g. `scopeSeparator` hardcoded to `' '` instead of forwarded from the provider config) is a `FAIL` unless the omission is explicitly documented. Check specifically: (a) string fields that affect protocol behavior — scope separators, encoding flags, authorization params, token params, audience, grant type variants — are forwarded or explicitly set; (b) numeric/boolean fields that change OAuth/auth flow behavior are propagated with correct type handling, not silently coerced or dropped; (c) every field added to the source type (or its upstream config shape) has a corresponding mapping in all builders that consume that source. To verify, grep for the source interface/type name, find every builder that reads from it, and confirm each meaningful field appears on the left-hand side of an assignment to the output object. A hardcoded fallback (`?? 'default'`) on a field the source config controls = `FAIL` unless the fallback is the only sensible behavior and the source genuinely lacks that field.
  - **multi-step write atomicity**: for every handler that performs two or more sequential writes before returning (e.g. create AuthProfile, then upsert ConnectorConnection bridge, then call an external token endpoint), trace the failure path at each intermediate step. If step N fails after writes at steps 1..N-1 have committed, verify the handler deletes all previously-written records — scoped narrowly by `tenantId` and the operation-specific key — before surfacing the error to the caller. Ghost records (persisted for an operation that ultimately returned failure) leave the system in a state the API response implies never happened, creating phantom entries that callers cannot manage. If the cleanup write itself can fail, the handler must surface that failure loudly rather than swallowing it. Any multi-step write path without cleanup-on-failure for intermediate writes = `FAIL`.
  - **shutdown sequence ordering** (`shutdown-sequence-ordering` sub-check): when a PR touches async teardown or `close()` / `shutdown()` methods in queue consumers, event consumers, or streaming service handlers, verify the ordering of close/flush/disconnect steps. The invariant: any writer or downstream processor that handles events delivered _during_ a producer/consumer `close()` call must remain open until after the final flush completes. Wrong order — `writers.close()` first, then `queues.close()`, then `flush()` — silently drops all events delivered to the queue during its own close sequence because writers are already gone. Correct order: `producers/consumers.close()` → `flush()` → `writers.close()`. Any reversed ordering where downstream writers are torn down before the final flush of events they would process = `FAIL`.
  - **DB query filter field path accuracy** (`db-filter-field-path` sub-check): when the diff adds or modifies Mongoose/ORM query filter objects (`.find()`, `.findOne()`, `.deleteMany()`, `.updateMany()`), verify every filter field key resolves to the actual schema location. The same invisible-bug pattern as `credential-field-path` applies to query filters: a filter `{ executionId: id }` when the schema stores the value at `source.executionId` is syntactically valid, passes TypeScript compilation, produces no runtime error, and silently matches zero documents — permanently leaving records that should have been cascaded. In Mongoose, dotted-string paths (`'source.executionId'`) and top-level key objects (`{ executionId: id }`) are semantically different. Read the model's schema definition to locate the actual field path and confirm the filter key matches. Any filter key that does not match the field's actual schema path = `FAIL`.
  - **cascade deletion completeness** (`cascade-deletion-completeness` sub-check): when a PR adds or modifies a deletion handler for a parent entity (cascade-delete hook, `pre('deleteOne')`, cleanup service, event-driven cascade trigger), enumerate all dependent collections that hold foreign-key references to that parent. For each collection, verify the handler includes a `deleteMany` (or equivalent) scoped by `tenantId` AND the parent's ID. Common omissions: outbox/event-log records keyed by `entityId`/`entityKind`, join table entries, child entity records, and per-entity cache entries. A parent delete that leaves orphaned children violates referential integrity: orphaned outbox records trigger phantom event replays on restart; orphaned children cause incorrect aggregations. To check: grep the codebase for models referencing the parent entity's ID field and confirm the cascade handler deletes from every matched model. Any dependent collection without a corresponding scoped delete = `FAIL`.
  - **explicit blast-radius statement**: the report must list which existing features this PR could affect and how the reviewer verified each one.
- `security` (mandatory)
  - **auth enforcement**: every new route uses `createUnifiedAuthMiddleware` / `requireAuth`. No custom `jwt.verify`, no manual `Authorization` header parsing outside `packages/shared-auth/`.
  - **permission checks**: `requirePermission()` / `requireProjectPermission()` present on every protected handler. API keys and platform keys authorized by explicit scopes, never by creator membership or owner fallback.
  - **input validation**: Zod (or equivalent) at every boundary; `.strict()` on body schemas; ID fields use plain string validation (`z.string().min(1)`), not branded ID validators that assume a specific format.
  - **secret handling**: no secrets in code, logs, traces, error messages, or user-visible surfaces. Sanitizer helpers used on user-facing runtime errors.
  - **unsafe logging**: no PII, tokens, credentials, model IDs, or tenant IDs in logs that surface to users; structured `createLogger` only — no `console.*` in server code.
  - **PII in pass-through surfaces**: logs are not the only leak path. For every new field that crosses an intermediate surface, confirm it is classified and either redacted, encrypted, or has a documented exemption. Pass-through surfaces include:
    - `TraceEvent` payloads stored in `TraceStore`
    - BullMQ / Kafka job payloads and Redis cache values
    - Outbound LLM provider request bodies (system/user/tool messages, metadata, tool args)
    - Webhook bodies sent to tenant-configured URLs
    - A2A / handoff metadata forwarded between agents
    - Error responses returned to the caller (sanitized) vs. error logs (raw)
    - Third-party telemetry / APM / debug-export channels
    - BYOC retention windows (data leaving our retention boundary)
      Cross-reference the `data-flow-audit` skill when the diff introduces a new field that crosses two or more of these surfaces.
  - **auth/credential field path accuracy** (`credential-field-path` sub-check): when the diff contains conditional checks that gate re-authorization, credential invalidation, or force-reauth on a specific OAuth/auth field (e.g. "if client ID changed → force reauth"), cross-reference every field access path against the runtime schema definition. Confirm the path resolves to where the field actually lives at runtime (e.g. `updates.secrets.clientId`, not `updates.config.clientId`). A conditional on the wrong path is syntactically valid, passes TypeScript compilation, produces no runtime error — it simply never fires when the real field changes, silently preserving a stale auth grant with no signal to the operator. Any mismatch between the checked path and the field's actual schema location = `FAIL`. When the diff does not touch auth/credential conditional checks, emit `credential-field-path: N/A`.
  - **auth-profile field propagation** (`auth-profile-propagation` sub-check): the `data-propagation-audit` skill MUST run before this gate can PASS when the PR touches OAuth/auth-profile fields. Steps: (1) determine whether the diff touches OAuth/auth-profile schemas, catalog entries, Studio forms, OAuth initiation/callback, token exchange/refresh, or runtime auth-profile resolution; (2) when it does, run `data-propagation-audit` against the PR diff and include its findings in this review report; (3) the security gate verdict is `FAIL` until all `data-propagation-audit` CRITICAL/HIGH findings are resolved. When the diff does not touch OAuth/auth-profile fields, emit `auth-profile-propagation: N/A (no OAuth/auth-profile fields touched)` rather than running an unrelated audit. Rationale: OAuth field propagation gaps (e.g. `scopeSeparator`, auth/token params, `PHASE1_AUTH_TYPES` alias removal) are invisible to a surface-level code read — they only surface when fields are traced through schema → catalog → UI → OAuth round-trip layers.
  - **injection / SSRF / SSTI / XSS**: parameterized queries only, URL allowlisting on outbound fetches, escaped templates on user-controlled HTML.
  - **encryption at rest and in transport**: tokens, keys, certificates, PEMs, OAuth refresh tokens, API keys must be encrypted at rest with the standard helpers. TLS enforced for outbound calls.
  - **rate limiting and abuse**: new public endpoints have rate limits and auth before any expensive work.
  - **dependency and supply chain**: new dependencies justified, pinned, and not abandoned packages.
- `isolation` (mandatory)
  - **tenant scoping**: every Mongoose query in changed code includes `tenantId`. No `findById` without tenant. Studio Next.js routes scope explicitly (no ALS injection).
  - **project scoping**: routes under `/api/projects/:projectId/...` filter by `projectId`. Resources verified `resource.projectId === req.params.projectId` before mutation.
  - **user ownership**: user-owned resources (API keys, personal tokens, personal credentials) filter by `userId` / `createdBy`.
  - **session-derived scoping**: dispatch on `Session.source` — public/channel sessions use end-user identity (`contactId`, `customerId`, `anonymousId`, channel artifact); Studio debug sessions use project RBAC, not workspace user ownership.
  - **non-leaky 404 behavior**: cross-scope access returns `404`, never `403`. Existence of a resource in another tenant/project must not be observable.
  - **fail-closed defaults**: missing tenant/project context fails the request, never falls through to global scope.
  - **cache and queue isolation**: Redis keys, BullMQ queues, and in-memory caches keyed by tenant/project where appropriate; no cross-tenant cache poisoning.
  - **trace and log isolation**: trace events and logs include scope identifiers and never bleed cross-tenant data into shared dashboards.
- `stale-or-duplicate-code` (mandatory)
  - **dead code**: unused exports, unreachable branches, orphaned files, commented-out blocks, leftover scaffolding, TODO stubs that were never wired.
  - **duplicate logic**: copy-pasted helpers, parallel implementations of the same flow, two services answering the same question, two schemas representing the same entity.
  - **partially migrated flows**: old code path still wired alongside the new one without a feature flag or removal plan; legacy compatibility shims left in the steady-state typed contract instead of a narrow rollout branch.
  - **unreachable or unwired code**: new function/route/component that no caller imports or mounts; new package not added to relevant Dockerfiles or app barrels; new test file never collected by the runner.
  - **redundant types**: duplicated DTOs / Zod schemas / interfaces that should reuse existing shared types.
  - **leftover debug scaffolding**: `console.log` (blocked by hook but check anyway), debug-only env reads, hardcoded test IDs, sample data committed by accident.
  - **export removal**: feature commits must be additive — flag any deleted exported symbol that still has consumers; require the consumer-update commit to land first.
- `code-quality`
  - correctness
  - readability
  - maintainability
  - error handling (no swallowed catches, structured error responses, `err instanceof Error ? err.message : String(err)`)
  - contract alignment with shared types and signatures
- `encryption`
  - encryption at rest
  - encryption in transport
  - token, key, certificate, and PEM handling
- `tests`
  - missing coverage on new code paths
  - misleading coverage (tests that mock the thing they claim to verify)
  - mocked E2E anti-patterns (no `vi.mock` of `@agent-platform/*`, `@abl/*`, or relative imports; no direct DB access in E2E)
  - gaps between implementation and tests
  - regression coverage for adjacent features the PR could affect (ties into `functional-regression`)
- `coverage-matrix` (mandatory)
  - **trigger**: when `docs/features/<slug>.md` and `docs/testing/<slug>.md` both exist, run the matrix. When neither exists for a non-trivial feature PR, the gate is `FAIL` with the missing-artifact reason. When the PR is a pure infra/refactor PR with no feature slug, emit `N/A`.
  - **spec → code**: every test scenario row in the testing spec maps to at least one test file in the PR (or a pre-existing test that still exercises it). Spec rows with no test = `FAIL`.
  - **code → spec**: every new public surface (new exported function, new route, new event payload, new UI flow) appears in the testing spec. New surfaces missing from the spec = `FAIL` (spec drift), and the report must cite which surface and where it should land in the spec.
  - **claim verification**: any "implemented" or "wired/reachable" claim in the feature spec must be backed by an integration or E2E test that hits the real route — unit tests alone do not satisfy a wired/reachable claim.
- `durable-execution` (mandatory — emit `N/A` with reason when the PR does not touch `apps/workflow-engine/**`, import anything from `@restatedev/*`, or modify a Restate handler)
  - **replay determinism**: nondeterministic operations — `Date.now()`, `Math.random()`, `crypto.randomUUID()`, `uuid()`, `new Date()` without an arg, network/HTTP fetches, file I/O, env reads that can change — only inside `ctx.run(name, fn)`. Capturing the result outside `ctx.run` breaks replay.
  - **idempotent side-effects**: every `ctx.run` whose body has an external side-effect (DB write, queue publish, webhook call, payment, email) is idempotent or keyed by a stable execution identifier. A retried replay must not double-charge / double-send / double-write.
  - **stable handler & step IDs**: the string passed as the `ctx.run` step name is stable across deploys for the same logical step. Renaming a step name without a versioned handler breaks in-flight executions.
  - **no closure mutation across awaits**: handler-local mutable state mutated across an `await` (especially `await ctx.run(...)` or `await ctx.sleep(...)`) is a replay hazard. Reads after a suspension must come from `ctx.run` results, durable state, or recomputed-deterministic-from-input values.
  - **versioned handlers on payload-shape change**: when a Restate handler's input or persisted state shape changes, the change either lands behind a new handler version or has an explicit migration for in-flight executions. A breaking change to an already-deployed handler is a `FAIL`.
  - **awaits inside loops**: `for ... await ctx.run(...)` is fine; `Promise.all(items.map(i => ctx.run(name, ...)))` with the SAME step name across iterations is not — step names must be unique per call site (e.g. include the item key).
  - **no sleeping outside `ctx.sleep` / no waiting outside `ctx.awakeable`**: raw `setTimeout` / `await new Promise(r => setTimeout(r, n))` does not survive replay.
  - **side-effect ordering**: when emitting events that other handlers consume, ensure the publish step runs after the durable state write (or is itself part of a transactional `ctx.run`) — replay must not produce ghost events for state that never committed.
- `ux-ui`
  - confusing states
  - missing validation or empty states
  - accessibility
  - broken labels, forms, and user messaging
  - design tokens (no hardcoded Tailwind palette colors in UI code)
- `cross-pod` (mandatory)
  - **no pod-local truth**: in-memory `Map`, `Set`, or module-level mutable state used as authoritative state must be replaced by Redis/Mongo. In-memory is acceptable only as a cache with explicit max-size, TTL, and eviction policy.
  - **distributed locking**: any "first writer wins" / "exactly-once" claim uses Redis `SET NX PX` (or equivalent) with a stable lock key, a bounded TTL, and a path that releases the lock on every exit.
  - **cache key construction**: keys include tenant/project scope; no global keys for tenant-scoped data; eviction strategy documented.
  - **stateful queue or socket handlers**: any handler that holds a connection / subscription / aggregator across pod restarts has a recovery story (durable store, replay, or explicit "best-effort" tag).
  - **singleton service connection state**: when a PR introduces or modifies a module-level singleton that wraps a stateful connection (database, graph DB, message broker, external API client), verify: (a) if the connection drops after initialization, the singleton detects the stale driver and reconnects or fails fast with a readable error — checking `driver !== null` is not sufficient; (b) every call site checks service availability before using it; (c) if startup initialization is optional (wrapped in try/warn/continue), every route handler that uses the service must guard with an availability check and return a graceful 503/404, not a raw TypeError from a null driver. The pattern "server continues despite init failure + no availability guard at use sites" = `FAIL`.
  - **health flag pessimistic initialization** (`health-flag-initial-state` sub-check): when a PR introduces or modifies a service class with internal health or availability flags (`healthy`, `producerHealthy`, `consumerHealthy`, `connected`, `isReady`, etc.), verify the initial value is `false` (unhealthy until proven), never `true` (optimistic). A health flag initialized to `true` before the first successful operation causes the service to appear healthy to callers the moment the class is instantiated — before any connection, handshake, or subscription has been confirmed. If startup fails or is slow, traffic is routed to a service that has never proven connectivity, silently failing at the operational level with no error signal to the caller. Check: any `boolean` class field or constructor assignment whose name implies health/availability/connection state must initialize to `false`. An assignment of `= true` or `this.X = true` in a property initializer or constructor body, before the first confirmed connection event, = `FAIL`.
  - **stale heartbeat / leadership**: locks/leases that depend on heartbeats include drift detection and stale-recovery logic, not "trust forever."
- `audit-log` (mandatory)
  - **emit on every sensitive op**: secret read/write, permission grant/revoke, role change, project/agent create/delete, export, import, deletion, OAuth grant, JIT auth, billing event. Each has a `TraceEvent` (or audit-log entry) via the shared `TraceStore` — no ad-hoc `log.info` substitutes.
  - **structured payload**: include `tenantId`, `projectId`, `userId`/`actorId`, `action`, `target`, `outcome` (success | failure | denied), and a stable `eventType`. No free-form audit messages.
  - **redaction respected**: audit payloads pass through the standard sanitizer — no raw secrets, tokens, or unredacted PII.
  - **failure-path coverage**: denied / forbidden / 404 paths emit an audit entry too — silent denials are how exfiltration hides.
  - **retention boundary**: audit events respect feature retention TTLs and erasure cascades; do not leak past the retention window.
- `boundary-metadata` (mandatory)
  - **reserved transport keys**: keys like `history`, `_meta`, `__internal`, `__transport`, A2A handoff metadata, and SDK-protocol shims must not leak into generic forwarded metadata or persisted records.
  - **per-message metadata validated at entry**: every entry point (HTTP, WebSocket, A2A, SDK, channel adapter) validates `messageMetadata` shape before forwarding; downstream consumers do not re-validate.
  - **canonical `messageMetadata`**: forward the canonical structure into execution; do not splice in transport-only fields.
  - **sliding-window invariants**: conversation history bounded; no unbounded `messages.push(...)`. Compaction strategy documented when context windows could overflow.
  - **versioned protocol compatibility**: SDK ↔ runtime contract changes keep compat shims narrow, explicit, and outside the steady-state typed contract; remove only after older bundles are no longer expected.
- `wiring-reachability` (mandatory)
  - **production entry-point trace**: for every new route / executor / handler / UI page introduced by the PR, trace the import chain from a production entry point (`apps/runtime/src/server.ts`, `apps/studio/app/...`, `apps/workflow-engine/src/index.ts`, public SDK barrel) to the implementation. Cite the file/line where it is mounted/imported/registered.
  - **mounted means tested**: an "implemented" claim without an integration or E2E test that hits the route through the production entry point is a `FAIL`. Unit tests of the inner function do not satisfy a wiring claim.
  - **build-graph wiring**: new packages added to every Dockerfile that runs `pnpm install --frozen-lockfile` (`apps/runtime`, `apps/search-ai`, `apps/admin`, `apps/studio`). New ESLint rules registered in `eslint.config.mjs`. New i18n keys present in every locale file the build verifies.
  - **Studio API wiring**: every new Studio route handler is reachable via the Next.js app-router file-system mapping and exercised by a route test or E2E hitting the real URL.
  - **Studio UI wiring**: new UI components are mounted in the app shell / settings nav / picker registries, not just exported from a barrel. New nav entries appear in the production sidebar render.

## Project-Specific Gates

The gates below this marker are scoped to this repo (`abl-platform`). When porting this skill, replace this section with the equivalent domain gates for the target project (or remove it entirely). The universal core gates above this marker should remain unchanged.

- `agent-transfer` (trigger-conditional — `N/A` when the PR does not touch `packages/agent-transfer/**`, channel adapters, or `apps/runtime/src/services/transfer/**`)
  - **adapter session-end propagation**: adapter changes propagate `session_end` / `disposition` / `wrap-up` to the runtime, the channel, and any downstream analytics/billing.
  - **inline connection edits**: connection-config edits round-trip through the adapter without losing fields; redacted secrets stay redacted.
  - **transfer correlation**: outgoing transfer requests carry stable correlation IDs; the receiving adapter can map back to the originating session.
  - **fail-closed**: transfer failures end the session deterministically rather than leaving it in an undefined state.
- `customer-contact` (trigger-conditional — `N/A` when the PR does not touch contact identity, channel adapters, omnichannel session continuity, or end-user identity resolvers)
  - **identity precedence**: `contactId` > `customerId` > `anonymousId` > channel artifact (per platform spec). Changes preserve the precedence order.
  - **cross-channel reuse**: when the same end-user reaches the platform via two channels, identity merge/reuse is deterministic and tenant-isolated. No accidental cross-tenant identity unification.
  - **channel artifact normalization**: artifacts (Slack `team_id:app_id`, Email address-cased, WhatsApp E.164) are normalized at ingress; downstream code does not re-normalize.
  - **PII boundary**: contact identity records pass through the same redaction/encryption helpers as other PII surfaces (see `security` / `pii-passthrough`).
- `design-system` (trigger-conditional — `N/A` when the PR does not touch `apps/studio/src/components/**` or other Studio UI)
  - **no hardcoded palette**: no `bg-blue-500`, `text-red-400`, raw Tailwind palette colors. Use semantic tokens from `@agent-platform/design-tokens`.
  - **accent foreground pairing**: never `bg-accent text-foreground` (invisible). Always `bg-accent text-accent-foreground`.
  - **no native `<select>`**: use `<Select>` from `components/ui/Select.tsx`. Use `<FilterSelect>` for filter toolbars.
  - **typography and spacing**: use the design-system scale; no inline-style escape hatches for sizing/spacing.
  - **dark/light parity**: every new visual asset works in both themes. Do not check only one mode.
  - **PreToolUse hooks (`design-token-lint.sh`, `accent-foreground-lint.sh`, `native-select-lint.sh`) are backstops** — verify hook output appeared in the PR's commit history; if hooks were skipped, treat as `FAIL`.
- `import-export-roundtrip` (trigger-conditional — `N/A` when the PR does not touch `packages/project-io/**` or any IR / manifest / schema consumed by export-import)
  - **lossless round-trip**: export → import → export produces byte-identical (or canonical-equivalent) output for the touched assets.
  - **manifest shape stability**: the v1/v2 manifest contract is preserved; new fields land additive with explicit version bumps.
  - **tool signature extraction**: tool definitions, IR hashes, and binding signatures stay stable under round-trip.
  - **cross-reference resolution**: references between assets (agent → tool, workflow → agent, channel → connector) resolve deterministically after import.
  - **redaction round-trip**: secrets exported as redacted placeholders re-import as redacted placeholders, never as plaintext.
- `reliability` (rubric 9) (trigger-conditional — `N/A` when PR touches no outbound calls, queue producers/consumers, or cross-service integrations)
  - **timeout enforcement** (`reliability-timeout`): every outbound call (HTTP fetch, gRPC stub, Kafka producer send, Redis blocking command) carries an explicit timeout. `fetch(url)` without a timeout option, `producer.send()` without a delivery timeout = `FAIL`.
  - **retry and backoff** (`reliability-retry`): transient failure handling uses exponential backoff with jitter; retries are bounded by max-attempts AND a total-time cap. Tight retry loops with no backoff or no upper bound = `FAIL`.
  - **circuit breaking** (`reliability-circuit`): calls to optional or known-unstable downstream services use a circuit breaker or the platform equivalent. Unguarded synchronous fan-out to an optional dependency that can cascade failures to callers = `FAIL`.
  - **graceful degradation** (`reliability-degradation`): for every external dependency the PR introduces or touches, document what the system does when that dependency is unavailable. Acceptable: returns cached data, returns partial result, returns 503 with Retry-After. Not acceptable: unhandled exception propagates to end-user, session hard-crashes, or request hangs indefinitely. "Throws to caller" without a recovery strategy = `FAIL`.
  - **idempotency of retried operations** (`reliability-idempotency`): operations that may be retried (queue message processing, webhook delivery, background job steps) are idempotent or keyed by a stable idempotency key. Duplicate delivery must not produce duplicate side effects (double-charge, double-send, double-write). Absence of dedup key on a retriable write = `FAIL`.
- `scalability` (rubric 11) (trigger-conditional — `N/A` when PR touches no DB queries, list endpoints, or hot-path handlers)
  - **N+1 query detection** (`scalability-n-plus-one`): loops issuing one DB query per iteration instead of a single batched query. `for (const id of ids) { await Model.findById(id); }` when `Model.find({ _id: { $in: ids } })` is available = `FAIL`. Check every `forEach`/`map`/`for...of` block in changed handlers for embedded query calls.
  - **unbounded result sets** (`scalability-unbounded-results`): every new or modified list query must have an explicit `.limit()` or cursor-based pagination. A query returning O(n) rows proportional to tenant data size without a bound is a scalability cliff that passes in dev and fails in a mature tenant = `FAIL` unless the collection is provably small-and-fixed.
  - **index coverage** (`scalability-index-coverage`): new query filter fields must have a corresponding index in the schema definition or migration file. Confirm the field appears in an index definition. An unindexed filter runs a full-collection scan at scale = `FAIL`.
  - **hot-path synchronous I/O** (`scalability-hot-path`): CPU-intensive work (large JSON serialization, complex regex over unbounded strings, synchronous crypto) or blocking I/O in real-time session handlers (voice stream, message dispatch) must be offloaded or bounded in wall-clock time. Flag `await longRunningOp()` on the critical path without documented latency justification.
  - **in-memory structure growth** (`scalability-memory-growth`): new `Map`, `Set`, or arrays that grow proportional to request volume or entity count without an explicit eviction strategy, TTL, or max-size cap = memory leak at scale = `FAIL`.
  - **connection pool exhaustion** (`scalability-connection-pool`): new code that opens a DB, Redis, Kafka, or external API connection inside a route handler or per-request service method instead of drawing from a shared startup-initialized pool is a scalability cliff — every concurrent request holds a connection until the response finishes, exhausting the pool under load. Any `new MongoClient(uri)`, `new Redis(opts)`, `new Kafka()`, or HTTP agent construction inside a route handler = `FAIL`. Connections must be established at startup, stored as a module-level singleton, and reused across requests. Pool size limits must be configured explicitly (not left at driver defaults, often 1 or 5) and documented in the service startup config.
- `observability` (rubric 10) (trigger-conditional — `N/A` for PRs introducing no new services, workers, or high-frequency endpoints)
  - **metrics emission** (`observability-metrics`): new high-frequency paths (called >1/sec at production scale) emit at least one counter, histogram, or gauge via the project's metrics client. Metric names follow the project's naming convention and carry tenant/project labels. A path that only logs on error cannot support SLOs or alerts = `FAIL`.
  - **health check registration** (`observability-health`): new services and workers register in the project's health check endpoint so the platform watchdog can observe them. An unregistered worker is invisible to monitoring — outages are detected by users, not alerts = `FAIL`.
  - **trace context propagation** (`observability-trace`): outbound calls from new handlers carry the incoming trace/correlation ID in the downstream request (HTTP header, Kafka message header, BullMQ job data). Lost trace context breaks end-to-end tracing = `FAIL` for services in the critical session path.
  - **structured log levels** (`observability-log-levels`): new code uses the project's structured logger (`createLogger`, not `console.*`) at correct levels — `info` for expected ops, `warn` for recoverable anomalies, `error` only for unexpected failures (not routine 4xx client errors). `error`-level on expected 404s floods alerting.
  - **error rate observability** (`observability-error-rate`): new error paths increment a counter metric or emit a structured event that can feed an error-rate alert. Pure catch-and-log handling with no counter makes it impossible to detect systematic failures before they become incidents = `FAIL` for services in the critical path.
- `data-lifecycle` (rubric 1) (trigger-conditional — `N/A` for PRs touching no DB models, no new fields, and no deletion handlers)
  - **tenant-delete cascade** (`data-lifecycle-tenant-delete`): new collections must appear in the project's tenant deletion handler. Grep the tenant-delete service / cascade hook and confirm the new model has a corresponding `deleteMany({ tenantId })`. Missing = GDPR/CCPA debt and data bloat after tenant offboarding = `FAIL`.
  - **PII erasure compliance** (`data-lifecycle-pii-erasure`): new fields holding personal data (names, emails, phone numbers, addresses, free-text user content, contact identifiers, session transcripts) must be included in the project's data-erasure request handler (right-to-erasure). New PII fields without a documented erasure path = `FAIL`.
  - **retention TTL for ephemeral data** (`data-lifecycle-ttl`): event-log records, outbox records, queue job results, audit events, and cache entries that are not the system of record must have a documented TTL or archival strategy. A collection that only grows (no TTL, no archive, no cleanup job) is a scalability and compliance liability at enterprise data volumes.
  - **index lifecycle** (`data-lifecycle-index`): new compound indexes must be ordered high-cardinality-first, low-cardinality-second, matching the query predicate order. Indexes on high-write fields must justify their write-amplification cost. New partial indexes must be structured so queries that should use them include the partial filter expression.

## Advisory Concerns (triage cards, never blocking)

When the PR touches one of these surfaces, the report includes a triage card with three options (`option_A` / `option_B` / `option_C`) for the user to choose from explicitly. Advisory concerns never block merge by themselves — they collect non-trivial decisions for the user, and oracle/AI-generated prose for an advisory concern is not promoted to canonical findings without user confirmation.

| Advisory concern                         | Trigger                                                         | What to triage                                                                     |
| ---------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `clean-contracts` (rubric 6)             | shared package / DTO / Zod schema / public type changes         | option to deprecate-then-remove vs. dual-version vs. break-with-migration          |
| `reasoning-flow-parity` (rubric 5)       | reasoning prompts, tool-loop logic, planning vs. flow execution | option to keep both paths vs. converge vs. branch by feature flag                  |
| `studio-wiring` (rubric 12)              | new Studio UI components, app-shell navigation                  | option to mount in main nav vs. settings vs. modal                                 |
| `studio-api-wiring` (rubric 12)          | new Studio API route requiring client wiring                    | option to expose via SWR hook vs. server action vs. RPC                            |
| `omnichannel` (rubric 3)                 | session continuity / channel handoff changes                    | option to preserve session state vs. reset vs. branch by channel                   |
| `scale` (rubric 11)                      | hot path / queue / cache changes that could affect throughput   | option to load-test before merge vs. roll behind flag vs. monitor in prod          |
| `localization` (rubric 14)               | new user-facing strings                                         | option to ship with English-only first vs. block on full i18n vs. fall-back-mode   |
| `onboarding-ux` (rubric 14)              | first-run / signup / setup flows                                | option to gate behind feature flag vs. enable for all vs. cohort rollout           |
| `form-submission-resilience` (rubric 13) | new form / mutation surface                                     | option to add optimistic UI vs. server-validation-only vs. progressive enhancement |
| `ux-design` (rubric 13)                  | net-new UI surface / interaction                                | option to ship MVP vs. full design-spec vs. iterate-after-merge                    |
| `docs-examples-consistency` (rubric 15)  | feature spec changes, public examples, README changes           | option to update docs in same PR vs. follow-up doc PR vs. mark spec stale          |

For each triggered advisory concern, the report has a single line:

```
advisory:<concern> — TRIAGE
  option_A: <one line>
  option_B: <one line>
  option_C: <one line>
  recommendation: <one of A/B/C with one-line justification>
```

The user picks; the skill does not auto-resolve.

## Layer-by-Layer Audit Lens

Review each changed area through these layers when relevant:

1. schema and type contracts
2. route handlers and validation
3. auth and permission middleware
4. service logic
5. storage and model filters
6. runtime or execution paths
7. UI and Studio wiring
8. tests, build wiring, and launch paths

## Report Labels

Use concise gate labels in findings, for example:

- `functional-regression`
- `security`
- `pii-passthrough` (sub-label under `security`)
- `credential-field-path` (sub-label under `security`)
- `multi-step-atomicity` (sub-label under `functional-regression`)
- `data-mapping-completeness` (sub-label under `functional-regression`)
- `ranked-query-ordering` (sub-label under `functional-regression`)
- `singleton-service-guard` (sub-label under `cross-pod`)
- `health-flag-initial-state` (sub-label under `cross-pod`)
- `shutdown-sequence-ordering` (sub-label under `functional-regression`)
- `db-filter-field-path` (sub-label under `functional-regression`)
- `cascade-deletion-completeness` (sub-label under `functional-regression`)
- `reliability` (gate)
- `reliability-timeout` (sub-label under `reliability`)
- `reliability-retry` (sub-label under `reliability`)
- `reliability-circuit` (sub-label under `reliability`)
- `reliability-degradation` (sub-label under `reliability`)
- `reliability-idempotency` (sub-label under `reliability`)
- `scalability` (gate)
- `scalability-n-plus-one` (sub-label under `scalability`)
- `scalability-unbounded-results` (sub-label under `scalability`)
- `scalability-index-coverage` (sub-label under `scalability`)
- `scalability-hot-path` (sub-label under `scalability`)
- `scalability-memory-growth` (sub-label under `scalability`)
- `scalability-connection-pool` (sub-label under `scalability`)
- `observability` (gate)
- `observability-metrics` (sub-label under `observability`)
- `observability-health` (sub-label under `observability`)
- `observability-trace` (sub-label under `observability`)
- `observability-log-levels` (sub-label under `observability`)
- `observability-error-rate` (sub-label under `observability`)
- `data-lifecycle` (gate)
- `data-lifecycle-tenant-delete` (sub-label under `data-lifecycle`)
- `data-lifecycle-pii-erasure` (sub-label under `data-lifecycle`)
- `data-lifecycle-ttl` (sub-label under `data-lifecycle`)
- `data-lifecycle-index` (sub-label under `data-lifecycle`)
- `encryption`
- `isolation`
- `cross-pod`
- `audit-log`
- `boundary-metadata`
- `wiring-reachability`
- `tests`
- `coverage-matrix` (sub-label under `tests`)
- `durable-execution`
- `agent-transfer`
- `customer-contact`
- `design-system`
- `import-export-roundtrip`
- `ux-ui`
- `stale-code`
- `duplicate-code`
- `code-quality`
- `advisory:<concern>` for advisory-tier findings (e.g. `advisory:scale`, `advisory:omnichannel`)

Every finding line must include `(rubric N)` where N is the rubric concern from `docs/sdlc/change-review-rubric.md` so cross-tool reconciliation works (Helix YAMLs ↔ this skill's findings ↔ rubric prose).
