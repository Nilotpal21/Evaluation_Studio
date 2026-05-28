# Change Review Rubric

Use this rubric to review any non-trivial change in the ABL Platform. It is intended for code review, design review, self-review before merge, and post-implementation sync.

The goal is not to produce a generic checklist. The goal is to catch the regressions this repository repeatedly experiences:

- scope and auth drift
- reasoning-path and flow-path divergence
- implemented-but-unwired features
- import/export round-trip loss
- docs and examples drifting away from the running product
- tests that only confirm current implementation instead of domain behavior

## Purpose

This rubric exists to answer one question:

**Does this change preserve platform invariants, product contracts, and user-facing behavior while remaining provable through the right tests and wiring evidence?**

Use it alongside:

- `AGENTS.md` for repo-wide invariants and testing rules
- `docs/sdlc/` phase playbooks for feature development
- feature specs, test specs, HLDs, and LLDs for the touched area

## How To Use This Rubric

1. Classify the change.
2. Classify the persona swim lanes it crosses: end user, agent developer, platform developer.
3. Mark 2-5 `Primary Concerns`.
4. Mark any `Secondary Concerns`.
5. For every primary concern, collect proof:
   - persona/source-of-truth ownership
   - code/path evidence
   - public-boundary tests
   - deny-path or failure-path tests
   - wiring or activation verification
   - docs/examples updates when contracts changed
6. Record open risks explicitly. A vague "should be fine" is not proof.

If a concern is `N/A`, write one sentence explaining why. Do not mark large concerns `N/A` by default.

## Cross-Cutting Gate: Persona Boundaries & Swim Lanes

**Protects**

- clear ownership between end user, agent developer, and platform developer
- explicit source-of-truth and precedence rules across design time, runtime, import/export, and replay
- separation between project-owned and platform-owned assets even when both render on one end-user surface

**Review when**

- localization, prompts, settings, auth references, runtime messages, builder UX, exports/imports, replay/rehydration, or any change that crosses Studio/runtime/platform boundaries

**Review questions**

- Which persona authors the changed behavior or asset?
- What is the canonical source of truth for each lane?
- Does the same end-user surface combine project-owned and platform-owned material? If yes, is the boundary explicit?
- Are adjacent lanes referencing the canonical asset or copying it into a second authority?
- What precedence order applies if project-owned and platform-owned values overlap?
- What deny/fail-closed behavior prevents one lane from overwriting or shadowing another?

**Proof expected**

- a short lane matrix or swim-lane note in the design/review artifact
- code/path evidence showing ownership remains explicit
- round-trip/replay coverage when cross-lane material is persisted or rehydrated
- docs/examples updated when ownership or precedence rules change

## Evidence Categories

Use these proof types throughout the review:

- **Ownership proof**: evidence that end-user, agent-developer, and platform-developer lanes remain distinct where intended, with a documented source of truth and precedence order.
- **Code evidence**: the actual route, service, model, executor, or UI entry point changed in the correct place.
- **Boundary tests**: HTTP, WebSocket, SDK, queue, or workflow tests that validate the public contract.
- **Regression tests**: tests aimed at the bug or failure mode that motivated the change.
- **Deny-path tests**: cross-tenant, cross-project, wrong-owner, invalid-auth, and malformed-input cases.
- **Wiring verification**: proof that production entry points can reach the changed behavior.
- **Round-trip verification**: export/import, save/load, persist/rehydrate, compile/deploy/execute, or publish/consume fidelity.
- **Docs/examples sync**: specs, docs, examples, and fixtures updated to match reality.

## Default Baseline

On most changes, review the `Cross-Cutting Gate: Persona Boundaries & Swim Lanes` plus at least these concerns unless they are truly irrelevant:

1. Scope, Identity & Authorization
2. Contracts & Compatibility
3. Security & Secret Safety
4. Activation, Deployment & Reachability
5. Test Integrity, Regression Coverage & Behavior Validation

For runtime, channel, session, or execution changes, also default to:

- Session State, Metadata & Memory
- Execution & Orchestration
- Traceability, Audit & Observability
- Distributed Reliability & Scale

## Concern Catalog

## 1. Scope, Identity & Authorization

**Protects**

- tenant, project, user, contact, and service-principal isolation
- non-leaky access behavior
- canonical actor/subject semantics
- explicit scoping instead of ambient or repaired identity

**Review when**

- routes, middleware, auth helpers, Studio proxies, ownership checks, admin APIs, session APIs, contact flows, transfer flows, queue producers, or persistence filters change

**Review questions**

- Does every read and write carry the correct tenant and project scope?
- Does the code use the correct owner dimension for the resource: `userId`, `createdBy`, `contactId`, `projectId`, or `tenantId`?
- Does cross-scope access fail closed and return the expected non-leaky status?
- Is identity derived from validated boundary input rather than optional legacy fields or late repair logic?
- If this change touches Studio route handlers, are queries explicitly scoped rather than relying on ALS?

**Proof expected**

- scoped query filters in the route, service, or repository layer
- allow-path and deny-path tests
- wrong-tenant, wrong-project, and wrong-owner coverage where applicable
- explicit justification for any admin bypass

## 2. Session State, Metadata & Memory

**Protects**

- session lifecycle correctness
- message/session metadata integrity
- hot-store/cold-store consistency
- memory ownership and persistence boundaries
- recall semantics across different ownership scopes
- compaction, retention, and restore behavior

**Review when**

- sessions, messages, metadata, Redis/Mongo session paths, contact memory, recall, compaction, transcripts, session forks, or resume flows change

**Review questions**

- Does the change preserve the correct session source of truth across hot and cold paths?
- Are session metadata and message metadata validated and normalized at the boundary?
- Does the change keep per-session state distinct from cross-session memory?
- Are memory and recall scopes explicit and correct for the feature: session, contact, actor/user, project, tenant, or service-principal?
- If recall behavior changed, do all relevant scopes still honor isolation and ownership semantics instead of falling back to ambiguous legacy fields?
- If multiple code paths can read or write memory, do they resolve the same ownership scope and precedence order?
- If session restore or queue persistence changed, can stale or partial scope leak into the restore path?
- Are session mutations concurrency-safe and durable under reconnects or pod restarts?

**Proof expected**

- session create/load/save/restore tests
- memory write/read/recall tests for the affected scopes
- explicit deny-path tests proving one scope cannot read another scope's memory or recall lane
- metadata size and validation tests when metadata contracts changed
- cold-restore and reconnect coverage when storage behavior changed
- explicit handling of compatibility paths for legacy session shapes

## 3. Contact & Omnichannel Continuity

**Protects**

- canonical human subject identity
- contact resolution and merge semantics
- omnichannel continuity and live-session joins
- transfer/handoff continuity across channels

**Review when**

- contacts, identity verification, omnichannel recall, live session attach, agent transfer, SDK continuity, or voice/text bridging change

**Review questions**

- Is the same human represented consistently across channels?
- Does the change preserve the distinction between actor, subject, and transport metadata?
- Are verification strength and continuity scope widened only when policy allows it?
- Do transfer, join, and resume flows preserve the same `contactId` or canonical subject-of-record?
- Could a transport-specific identifier accidentally become authoritative identity?

**Proof expected**

- contact resolve-or-create tests
- merge and back-link tests when identity linkage changes
- cross-channel continuity or join-path coverage
- transfer session tests that validate subject continuity

## 4. Execution & Orchestration

**Protects**

- tool, workflow, routing, handoff, delegate, escalate, and HITL behavior
- safe side effects
- idempotent and durable orchestration

**Review when**

- executors, orchestration services, tool dispatch, workflow runtime, routing logic, approvals, inbox, or async execution paths change

**Review questions**

- Does the feature behave correctly at the execution boundary, not just inside one helper?
- Are orchestration steps idempotent or safely retryable?
- Are pause/resume, waiting states, retries, and partial failures handled explicitly?
- Do side-effecting operations preserve confirmation, audit, and auth requirements?
- Does the change preserve deterministic state transitions for workflows and HITL paths?

**Proof expected**

- public-boundary execution tests
- failure-path tests for timeouts, retries, and partial completion
- HITL or queue resume coverage where applicable
- explicit evidence that side effects cannot occur twice without intent

## 5. Reasoning vs Flow Path Consistency

**Protects**

- parity between reasoning agents and scripted flow agents where the platform promises shared behavior
- intentional, documented differences where the paths truly differ

**Review when**

- GATHER, extraction, tool calls, constraints, completion checks, handoff, localization, metadata propagation, trace events, or any execution-layer utility shared by both paths changes

**Review questions**

- Does this behavior need to exist in both reasoning and flow paths?
- If only one path changed, is the difference intentional and documented?
- Are validation, tracing, and state updates consistent between `ReasoningExecutor` and `FlowStepExecutor`?
- Could a bug fix in one engine leave the other path incorrect?
- Do docs and examples still describe the real parity story?

**Proof expected**

- parity tests for both paths when behavior should match
- explicit `N/A` rationale when only one path is relevant
- updated docs/specs if the paths intentionally diverge

## 6. Contracts & Compatibility

**Protects**

- API, WebSocket, SDK, A2A, tool, workflow, and internal event contracts
- backward compatibility during rollout
- boundary metadata normalization

**Review when**

- request/response shapes, event payloads, tool schemas, exported manifests, SDK payloads, WebSocket messages, or queue envelopes change

**Review questions**

- What contract changed and who consumes it?
- Is there an existing compatibility lane that must be preserved?
- Is versioning or a rollout shim required?
- Are reserved metadata keys kept out of generic forwarding?
- If more than one persona lane consumes the contract, is ownership explicit rather than inferred from the shared end-user surface?
- Are docs, examples, fixtures, and OpenAPI/schema artifacts still accurate?

**Proof expected**

- contract tests at the public boundary
- compatibility tests for legacy payloads when rollout requires them
- explicit update to canonical docs/specs/examples
- removal plan for temporary shims if added

## 7. Import / Export / Round-Trip Fidelity

**Protects**

- project-io correctness
- Git/export serialization fidelity
- import preview and apply correctness
- persisted config surviving round-trip without semantic loss

**Review when**

- `project-io`, Git sync, module publish/import, localization assets, auth profiles, environment variables, or any persisted asset format changes

**Review questions**

- Can the changed asset still export into the canonical file or manifest shape?
- Can the same artifact import back without silent drift?
- Are IDs, aliases, namespaces, environment bindings, and auth references preserved or intentionally remapped?
- Does the control-plane representation match the runtime materialized representation?
- Does the serialized shape preserve ownership domain so project-owned and platform-owned assets do not collapse during round-trip?
- If a feature claims import/export support, is there round-trip proof?

**Proof expected**

- round-trip import/export tests
- snapshot or fixture validation for canonical serialized shapes
- preview/apply tests if import preview exists
- explicit docs update when the exported contract changes

## 8. Security & Secret Safety

**Protects**

- centralized auth usage
- secret storage and resolution
- SSRF, sandbox, and tool-safety boundaries
- user-visible error sanitization

**Review when**

- auth, tokens, OAuth, auth profiles, secrets, tool execution, webhook handling, sandbox code, or public error surfaces change

**Review questions**

- Does the change continue to use centralized auth and permission checks?
- Are secrets resolved late and stored encrypted instead of copied into unsafe places?
- Are outbound calls still protected against SSRF or unsafe host targeting?
- Are user-facing errors sanitized while logs retain operational detail?
- Could this path bypass confirmation, auth-profile resolution, or secret redaction?

**Proof expected**

- authz tests
- secret redaction or encryption tests when relevant
- SSRF/sandbox deny tests for HTTP/sandbox paths
- sanitized error assertions on user-visible surfaces

## 9. Privacy, Retention & Compliance

**Protects**

- GDPR/erasure flows
- TTL and retention policy correctness
- PII minimization and redaction
- compliance reporting and archive safety

**Review when**

- PII-bearing fields, retention logic, archive/export behavior, deletion cascades, audit retention, or compliance tooling change

**Review questions**

- Did this change introduce new PII or a new subject-of-record?
- Are retention and deletion semantics explicit and testable?
- Does erasure still reach all relevant artifacts or compatibility paths?
- Are audit or archive records anonymized or preserved according to policy?
- Does the data model stay minimal, or did we add durable sensitive state without review?

**Proof expected**

- retention or cascade-delete tests
- explicit field review for new sensitive data
- archive/export tests when compliance surfaces changed
- docs update if compliance behavior changed

## 10. Traceability, Audit & Observability

**Protects**

- TraceStore coverage
- audit trail completeness
- operator debugging ability
- consistent diagnostics across live and replayed paths

**Review when**

- execution flows, session flows, tools, workflows, deployment surfaces, admin actions, or observability/read-models change

**Review questions**

- Does the changed path emit the trace and audit signals operators depend on?
- Are trace events structured and correlated with tenant/project/session context?
- Do replayed and live views represent the same semantics?
- Can operators still debug failures without reading raw source?
- Did the change remove or bypass an established trace/audit hook?

**Proof expected**

- trace-event or audit assertions in tests
- structured logging retained in changed execution paths
- additive read-model fields for Studio/admin surfaces when semantics changed

## 11. Distributed Reliability & Scale

**Protects**

- cross-pod correctness
- cache bounds and eviction
- queue safety
- lock usage and retry behavior
- saturation resistance

**Review when**

- Redis usage, queues, locks, in-memory maps, retries, concurrency control, workflow execution, or throughput-sensitive code changes

**Review questions**

- Does this change assume pod-local truth where the platform requires shared state?
- Are in-memory maps bounded with max size, TTL, and eviction?
- Are distributed locks used where concurrent writers can race?
- Could retries or duplicate deliveries cause data corruption or double side effects?
- Does this change create a new hot path that needs latency or saturation consideration?

**Proof expected**

- concurrency tests or lock-path coverage where races matter
- queue and retry-path tests
- explicit max size / TTL / eviction evidence for new maps or caches
- load or benchmark follow-up when the path is throughput-sensitive

## 12. Activation, Deployment & Reachability

**Protects**

- compile -> persist -> deploy -> execute lifecycle
- route mounting
- Studio shell wiring
- real production reachability vs code existence

**Review when**

- routes, proxies, navigation, deployment endpoints, feature-flagged UI, workflow triggers, modules, SDK surfaces, or any "implemented but not reachable" area changes

**Review questions**

- Is the feature actually reachable from the production entry point?
- Is the route mounted in the real server, not only in a test harness?
- Is the UI mounted in the real shell and navigation model?
- Does deployment or publication materialize the changed asset into runtime?
- If this affects a feature flag, is the enabled/disabled behavior both reachable and safe?

**Proof expected**

- server mount or caller-path verification
- Studio shell/navigation verification for UI work
- deployment/build tests when activation depends on publish/deploy
- post-impl-sync notes when reachability is subtle or newly verified

## 13. Product UX & Design System

**Protects**

- coherent product behavior
- accessible states
- design-token alignment
- stable UI composition in Studio, Admin, and Web SDK

**Review when**

- user-facing UI changes, SDK widgets, shell/nav, forms, dialogs, observability views, or empty/error/loading states change

**Review questions**

- Does the experience match the established product surface and design system?
- Are loading, empty, error, disabled, and success states intentional?
- Are design tokens and semantic intents used instead of hard-coded palette values?
- Is the UX resilient on both desktop and smaller surfaces where applicable?
- Does the end-user surface stay free of builder-only or platform-internal language and controls?
- Does the UI tell the truth about runtime state and wiring?

**Proof expected**

- component and integration tests for state handling
- visual/manual verification for meaningful UX changes
- token or semantic intent usage in implementation

## 14. Builder UX, Onboarding & Localization

**Protects**

- builder-facing creation flows
- Arch onboarding and in-project authoring
- persona-specific authoring boundaries
- localization authoring contracts
- content-management ergonomics

**Review when**

- onboarding flows, Arch AI flows, builder tooling, localization assets, content editors, or Git-backed authoring experiences change

**Review questions**

- Does the builder workflow reduce friction or create new hidden gates?
- Are design-time authoring semantics aligned with runtime consumption semantics?
- Are builder-facing assets clearly separated from end-user and platform-owned assets?
- If localization/content assets changed, do canonical file/path contracts still hold, and do project-owned vs platform-owned catalogs remain distinct?
- Does the UX preserve clear mental models for builders and operators?
- Are follow-up steps obvious after success, failure, or partial completion?

**Proof expected**

- builder workflow tests or walkthrough verification
- localization/content path tests if applicable
- lane/ownership notes when the workflow crosses project-owned and platform-owned content
- docs or screenshots/wire notes for substantial UX changes

## 15. Docs, Examples, Cross-Module Consistency & Code Sanity

**Protects**

- truthfulness of feature docs, examples, READMEs, and fixtures
- example code compiling or matching current contracts
- post-implementation sync quality
- consistency across modules, surfaces, and code paths that claim to implement the same contract

**Review when**

- public contracts, DSL behavior, examples, docs-internal guides, feature specs, test guides, or example projects are touched or invalidated by the change

**Review questions**

- Do docs still describe what production actually does?
- Do examples still compile, parse, or validate against the current implementation?
- Did the change create new divergence between feature docs and real code paths?
- If a route or UI is described as available, is it actually wired?
- If this change alters a documented invariant, did the canonical guide move with it?
- Do multiple modules or code paths implement the same concept differently in a way that creates ambiguity for future changes or reviews?
- If there is ambiguity, duplicate authority, or conflicting behavior across modules, docs, or runtime paths, has it been called out as an explicit audit finding rather than buried in notes?
- When multiple personas touch the same capability, do docs say who owns what and which source of truth wins?

**Proof expected**

- docs updates in the same change when contracts shifted
- example validation or fixture tests where available
- explicit path verification for referenced files and routes
- honest status updates when coverage or wiring is still partial
- explicit audit findings for unresolved ambiguity, duplicate authority, or conflicting implementations across codebase paths

## 16. Test Integrity, Regression Coverage & Behavior Validation

**Protects**

- tests proving intended behavior rather than implementation details
- regression safety for known failures
- realistic black-box coverage at public boundaries

**Review when**

- always, especially when behavior, routing, persistence, auth, or orchestration changes

**Review questions**

- Do tests validate the promised domain behavior, not just the current implementation shape?
- Would the tests survive an internal refactor that preserves behavior?
- Is there a regression test for the exact bug or failure mode?
- Are tests at the correct level: unit for pure logic, integration for service boundaries, E2E for public behavior?
- Do E2E tests avoid mocking platform components and internal modules?
- Are deny paths, failure paths, and concurrency paths covered where they matter?

**Proof expected**

- new or updated regression tests for changed behavior
- public-boundary tests for routes, WebSocket, SDK, workflow, or queue behavior
- no codebase-component mocking in E2E coverage
- assertions against expected contract, not incidental implementation details

## Minimum Acceptance Bar

A change is not review-complete if any of these remain unresolved without explicit signoff:

- scope or auth gaps are untested or hand-waved
- public contract changes lack compatibility reasoning
- production reachability is assumed but not verified
- docs or examples now lie about real behavior
- persona/source-of-truth ownership is ambiguous or silently merged across end-user, agent-developer, and platform-developer lanes
- ambiguity or conflicting behavior across modules/code paths exists but was not recorded as an audit finding
- tests only cover helpers while missing the real boundary
- known reasoning/flow parity implications were ignored
- import/export or publish/consume fidelity was changed without round-trip proof

## Review Worksheet

Use this format in PR descriptions, review notes, or implementation logs:

```md
Change:

Persona swim lanes touched:

- End user:
- Agent developer:
- Platform developer:

Cross-lane source of truth / precedence:

-

Primary concerns:

- Concern 1
- Concern 2
- Concern 3

Secondary concerns:

- Concern 4
- Concern 5

For each primary concern:

- Contract / invariant being protected:
- What changed:
- Proof:
- Remaining risk:

Required proof checklist:

- persona boundary proof
- scope/auth proof
- contract/compatibility proof
- activation/wiring proof
- regression test proof
- docs/examples sync proof
```

## Suggested Review Output

For each finding, prefer this structure:

- **Concern**
- **Severity**
- **What regressed or could regress**
- **Why the current change does not yet prove safety**
- **What proof is missing or what should change**

This keeps reviews aligned with platform invariants instead of devolving into line-by-line commentary.

## Ambiguity Rule

If review uncovers ambiguity, duplicate authority, or conflicting behavior across modules, routes, services, executors, docs, examples, or other codebase paths, that must be written up as an explicit audit finding.

Do not downgrade these to "follow-up ideas" when they affect reviewability, correctness, or future change safety.

Examples:

- two modules implement the same ownership or recall logic with different precedence rules
- reasoning and flow paths claim parity but differ silently
- feature docs, examples, and production code disagree on the supported contract
- Studio, runtime, and export/import paths represent the same asset differently without an explicit boundary contract
