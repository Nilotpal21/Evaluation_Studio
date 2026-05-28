# agents.md — apps / studio

Agent learning journal for this package. Append-only log of architectural decisions, patterns, gotchas, and insights discovered during SDLC work.

Agents MUST read this file before modifying code in this package. Agents MUST append learnings after completing work.

## Lifecycle Inventory — Cross-Boundary Surfaces

Studio is the **read/write UI for backend types it does not own**. Every form, prefill, table, and preview displays a value defined elsewhere — drift between backend acceptance and studio rendering is the most common bug class. Studio also hosts API route handlers (`src/app/api/.../route.ts`) that re-implement tenant scoping locally (no AsyncLocalStorage). **Before changing a form, prefill, preview, or route below, run the Omitted-Edit Audit from `.claude/agents/pr-reviewer.md`.**

| Surface / Type                                            | Lives in                                                       | Backend source-of-truth                                                                                                   | Past incident                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Voice-tier project model selector                         | `src/components/...` (project model picker), `src/api/...`     | runtime LLM voice-tier acceptance + filler config (`apps/runtime/src/services/llm/`, `apps/runtime/src/services/filler/`) | ABLP-540 (6 fix commits): studio rejected voice-tier realtime models even after backend accepted them. Studio acceptance must lag backend by zero.                                                                                                                                                         |
| Git preview / export companion metadata                   | `src/app/api/projects/[id]/...git*` routes, related preview UI | `packages/project-io/src/agent-companion-metadata.ts` + assemblers/disassemblers                                          | ABLP-791 (16 fix commits): studio export and git-preview parity. UI dropped fields the backend was already preserving.                                                                                                                                                                                     |
| Action submit envelope (form preservation)                | studio action authoring components                             | `apps/runtime/src/handlers/`, `apps/runtime/src/routes/`                                                                  | ABLP-612 (10 fix commits): submit envelope wasn't preserved across routing rounds; studio agent-repo reads needed tenant scoping.                                                                                                                                                                          |
| Module catalog / reusable modules                         | `src/app/api/projects/[id]/module-catalog/...`                 | runtime feature-gate + project-io module-release                                                                          | ABLP-51 (5 fix commits): reusable module audit + e2e flow.                                                                                                                                                                                                                                                 |
| Filler InlineStatus before `response_start`               | studio voice UI                                                | runtime filler delivery (ABLP-710)                                                                                        | Filler events must reach the studio surface BEFORE the response — race fixed via inFlightFiller chaining.                                                                                                                                                                                                  |
| Studio API route handlers (anywhere under `src/app/api/`) | every route handler                                            | various                                                                                                                   | Studio routes have NO ALS tenant injection. Every Mongoose query must include `tenantId: user.tenantId` explicitly. `validateBody()` consumes the request body — reject unknown fields with Zod `.strict()` instead of re-reading via `request.clone()`. (See `CLAUDE.md` "Studio Route Handler Gotchas".) |

**When backend acceptance changes, studio acceptance must change in lockstep.** Run `rg -l --type ts -e '\bTypeName\b' apps/studio` for every backend type that just changed, and verify the studio render path (form / prefill / preview / API route) handles the new shape.

---

<!-- Append new entries below this line. Format:
## <DATE> — <Feature/Context>
**Category**: architecture | testing | pattern | gotcha | process
**Learning**: <what was learned — specific and actionable>
**Files**: <key files involved>
**Impact**: <how this affects future work in this package>
-->

> Older entries (before 2026-04-01) archived in [`agents.archive.md`](agents.archive.md). Read the archive when older context is needed.

## 2026-05-18 — Temporarily Disabled Project Navigation

**Category**: pattern
**Learning**: Temporarily disabling a Studio project surface can hide it from `ProjectSidebar` and `config/navigation.ts` without deleting the `ProjectPage` union, `PROJECT_PAGES` inventory, or `AppShell` render case. This preserves direct-route/deep-link behavior while removing the page from sidebar and Universal Search discovery.
**Files**: `src/components/navigation/ProjectSidebar.tsx`, `src/config/navigation.ts`, `src/__tests__/module-studio-wiring.test.tsx`
**Impact**: Future temporary page disables should update both navigation copies and add a regression check that the hidden page is absent from sidebar rendering and `getAllNavItems()`.

## 2026-05-20 — Arch Overlay Panel State Must Not Reinitialize Sessions

**Category**: gotcha
**Learning**: `ArchOverlay` has internal panel states (`chat`, `artifacts`, `ide`) that are layout concerns, not lifecycle events. Session bootstrap effects and wrapper reset keys should depend on project changes and open/closed state only; depending on the full `overlayState` makes `Show artifacts` or automatic artifact/proposal panel switches remount, clear, and refetch the active in-project session, turning a live conversation into a resume gate.
**Files**: `src/components/navigation/AppShell.tsx`, `src/lib/arch-ai/components/arch/overlay/ArchOverlay.tsx`, `src/__tests__/arch-ai/app-shell-arch-overlay-reset-key.test.ts`
**Impact**: Future Arch overlay features should keep session initialization and error-boundary reset keys separate from panel toggles and add regression coverage before wiring new overlay modes.

## 2026-05-03 — ABLP-612 Agent Path and Prompt Reference Hardening

**Category**: architecture
**Learning**: ProjectAgent `agentPath` is a server-owned canonical identity field derived from `{projectId, name}`. Studio create/update clients should not send editable path values; metadata UI may display the path read-only, and PATCH must reject client path mutation.
**Files**: `src/app/api/projects/[id]/agents/route.ts`, `src/app/api/projects/[id]/agents/[agentId]/route.ts`, `src/api/projects.ts`, `src/components/agents/AgentDetailPage.tsx`
**Impact**: Future Studio agent metadata work should mutate name/description separately and let the service derive path atomically on rename. Prompt-library references UI must preserve and show runtime `draftAgents` so blocking draft refs are discoverable.

## 2026-04-27 — ABLP-535 Audited PII Reveal UX

**Category**: security
**Learning**: Studio reveal UI must use an exact `pii:reveal` permission probe and a reveal proxy that repeats the same permission check before Runtime forwarding. The UI should send only message-scoped selectors plus reason/ticket metadata; raw values belong only in the active modal's component state and must clear on close or session/message changes.
**Files**: `src/components/session/PIIRevealControls.tsx`, `src/components/observatory/DebugTabs.tsx`, `src/app/api/projects/[id]/permissions/pii-reveal/route.ts`, `src/app/api/runtime/sessions/[id]/pii/reveal/route.ts`, `src/__tests__/components/pii-reveal-controls.test.tsx`, `src/__tests__/api-routes/api-proxy-routes.test.ts`
**Impact**: Future Studio compliance surfaces should link to this explicit reveal workflow rather than adding "show raw" toggles, storing reveal state in Zustand, or revealing inside trace JSON.

## 2026-04-29 — Arch AI Proposal Health Regression Gate

**Category**: architecture
**Learning**: `validateProjectAgentCode()` must compare full-project diagnostics before and after an agent edit, then block new semantic errors. Agent-scoped diagnostics miss incoming dependency regressions, such as editing a child agent so an upstream `RETURN: true` handoff now triggers CO-04.
**Files**: `src/lib/arch-ai/tools/in-project-tools.ts`, `src/lib/arch-ai/tools/validate-agent.ts`, `src/__tests__/arch-ai/agent-edit-runtime-validation.test.ts`
**Impact**: Future proposal validation changes should keep the before/after full-project semantic gate. Agent-scoped validation should surface related full-project findings so Arch can see upstream/downstream contract impact. Health-check cleanups are allowed only when they preserve or improve the real project health, not merely remove the local warning that triggered the edit.

## 2026-04-28 — Authorize at Creation (ABLP-619, FR-9 + FR-10)

**Category**: pattern
**Learning**: Two-phase create for OAuth `auth-profile` is "create row in `pending_authorization`, then resolve via inline grant or popup OAuth flow before exposing the row as `active`". For `oauth2_client_credentials` the resolution happens server-side via `_create-cc-flow.ts` (a fully DI-driven pure function — caller provides `resolveClientCredentialsToken`, the model surface, `serviceDeps`, `emitTrace`, `traceEventNames` and gets back a discriminated union). For `oauth2_app` the resolution happens in the browser via `<AuthProfileOAuthDialog>` opened inline by `<AuthProfileSlideOver>`. The slide-over defers `setSaving(false)` and `onSaved()` until the dialog resolves; a `useRef` flag (`authorizeSucceededRef`) prevents Radix's `onOpenChange` side-effect from double-firing the cancel handler after success.
**Files**: `src/app/api/projects/[id]/auth-profiles/route.ts`, `src/app/api/auth-profiles/route.ts`, `src/app/api/auth-profiles/_create-cc-flow.ts`, `src/components/auth-profiles/AuthProfileSlideOver.tsx`, `src/components/auth-profiles/AuthProfileOAuthDialog.tsx`
**Impact**: Any future "save then external interaction" UX should follow this pattern: pure-function resolver behind the route handler, `useRef` flag to gate Radix close side-effects, and a status enum value to represent the in-flight server-side resource (so the resource isn't cluttered with `null`able foreign keys to a separate "pending" collection).

**Category**: architecture
**Learning**: Workspace OAuth routes live at `apps/studio/src/app/api/admin/auth-profiles/oauth/{initiate,callback,user-consent}/route.ts` and use `buildTenantOAuthAppLookupFilter` (no projectId in the filter, `scope: 'tenant'`). The state payload omits `projectId` and is validated against `tenantId + userId`. Status flips on the workspace callback use the filter `{ _id, tenantId, projectId: null, scope: 'tenant', status: 'pending_authorization' }` for idempotent updates. The `'_workspace'` string sentinel was deleted across `apps/studio/src/`; UI components now use `projectId: string | null` with `null` routing through the workspace endpoints.
**Files**: `src/app/api/admin/auth-profiles/oauth/initiate/route.ts`, `src/app/api/admin/auth-profiles/oauth/callback/route.ts`, `src/app/api/admin/auth-profiles/oauth/user-consent/route.ts`, `src/components/auth-profiles/WorkspaceAuthProfilesPage.tsx`, `src/components/auth-profiles/AuthProfileSlideOver.tsx`
**Impact**: Future workspace-scoped Studio routes must use the existing `buildTenantOAuthAppLookupFilter` and the `projectId === null` discriminator pattern. Do not invent new sentinel strings ('\_workspace', 'tenant-bridge', etc.) — `null` is the canonical workspace-scope marker for `projectId` in API clients and component props.

**Category**: gotcha
**Learning**: `AuthProfileStatusBadge` previously rendered the status enum verbatim with `capitalize`, which surfaces the new `pending_authorization` value as the literal "Pending_authorization" with a visible underscore. The fix is a `STATUS_I18N_KEY` map and a translation key per status (`auth_profiles.status_active`, etc.). The new color assignment `pending_authorization: 'bg-info-subtle text-info border-info-muted'` uses semantic info-tone design tokens (no hardcoded Tailwind palette colors — design-token-lint hook clean).
**Files**: `src/components/auth-profiles/AuthProfileStatusBadge.tsx`, `src/components/auth-profiles/auth-type-metadata.ts`, `packages/i18n/locales/en/studio.json`
**Impact**: When extending an enum that's user-visible, audit every render path BEFORE the enum value lands — `capitalize` and similar string transforms are silent broken-glass paths that don't fail build or test.

**Category**: testing
**Learning**: FR-10 ("integration-node bind never triggers OAuth re-consent") is best regression-tested with a hybrid: (1) static-import scan over `IntegrationNodeConfig.tsx` against `initiateOAuth` / `initiateWorkspaceOAuth` / `/auth-profiles/oauth/initiate`, (2) runtime API replay of the bind data path + Playwright `page.on('request')` listener asserting zero `/auth-profiles/oauth/initiate` traffic. The static scan catches code-time re-introduction; the runtime scan catches a regression in an upstream service that reads as a side-effect.
**Files**: `e2e/auth-profiles/integration-bind-no-consent.e2e.ts`
**Impact**: Use this pattern any time you have a "must never call X" invariant. The static scan is cheap and immediate; the runtime check is evidence-bearing.

## 2026-04-15 — Dynamic Dropdown Resolver (Studio Layer)

**Category**: architecture
**Learning**: Workflow integration nodes render Activepieces `Property.Dropdown` fields through a live resolver. Studio proxies `POST /api/projects/:id/connectors/:connectorName/actions/:actionName/props/:propName/options` to workflow-engine's flat-prefixed catalog route. The workflow-engine catalog routes are not project-scoped in the URL, so the Studio proxy moves the projectId from the URL into the request body alongside `connectionId`/`propsValue`/`searchValue`. The Studio route uses the standard `withRouteHandler` + `proxyToWorkflowEngine` pattern with `requireProject: true` and `[WORKFLOW_READ, CONNECTION_READ]` permissions — the same shape as `/api/projects/:id/connectors/:connectorName/actions/route.ts`.
**Files**: `src/app/api/projects/[id]/connectors/[connectorName]/actions/[actionName]/props/[propName]/options/route.ts`, `src/lib/workflow-engine-proxy.ts`
**Impact**: Future project-scoped proxy routes that hit flat workflow-engine endpoints should keep following this "projectId in body" pattern rather than duplicating the route tree in workflow-engine.

**Category**: pattern
**Learning**: `DynamicActionForm` takes optional `projectId` / `connectorName` / `actionName` / `connectionId` context props. A connector prop is rendered via the live `DynamicDropdownField` only when (a) `prop.refreshers` is present AND (b) all four context props are set. When context is missing (e.g. before a connection is picked) or `refreshers` is absent, the form degrades gracefully: dropdown with static options if available, text input otherwise. Refresher re-fetch is driven by a memoized `refresherKey` string (`name=value|name=value`) in the effect deps to avoid re-running on array identity changes.
**Files**: `src/components/workflows/canvas/config/DynamicActionForm.tsx`, `src/components/workflows/canvas/config/DynamicDropdownField.tsx`, `src/components/workflows/canvas/config/IntegrationNodeConfig.tsx`
**Impact**: Any new dynamic form that needs connection-scoped runtime lookups should reuse `DynamicDropdownField` directly rather than re-implementing the fetch/refresh lifecycle. Thread context top-down from IntegrationNodeConfig — do not introduce additional Zustand stores for transient edit-time state.

## 2026-04-23 — Discovery Panel LLD (Crawler UX)

**Category**: architecture
**Learning**: `BrowserDiscoveryInline.tsx` is the SSE consumer shell. New Discovery Panel components (DiscoveryConsole, DiscoveryTree, CoverageSummary, DecisionCards) render inside it — don't replace BrowserDiscoveryInline, delegate its running-state rendering to DiscoveryPanel. Use `useRef` for tree nodes and discovered URL set to persist across re-renders.
**Files**: `src/components/search-ai/crawl-flow/BrowserDiscoveryInline.tsx`, `src/components/search-ai/crawl-flow/types.ts`
**Impact**: Keep BrowserDiscoveryInline as the SSE connection manager. All new discovery UI goes in child components.

**Category**: gotcha
**Learning**: `ExplorePanel.tsx` has an inline `looksLikeVariable()` at line 76 — a third copy of the same heuristic (also in depth-prober.ts and extraction-cascade.ts). Consolidate to a single export from `packages/crawler/src/intelligence/utils/url-heuristics.ts`.
**Files**: `src/components/search-ai/crawl-flow/ExplorePanel.tsx`
**Impact**: Before adding URL heuristic functions, check for existing copies across studio/crawler-mcp-server/packages.

**Category**: gotcha
**Learning**: `State4Crawl.tsx` already exists as a file. LLD Phase 6 enhances it — don't create a new file. Verify file existence with Glob before listing files as NEW in implementation plans.
**Files**: `src/components/search-ai/crawl-flow/State4Crawl.tsx`
**Impact**: Always glob-check before assuming a file needs creation.

**Category**: pattern
**Learning**: Navigation wiring for new settings tabs: (1) add page to `ProjectPage` type union, (2) add to `settingsSubPages` map, (3) add to `settingsPageMap`, (4) add nav item in `ProjectSidebar.tsx` settings group, (5) add import + case in `AppShell.tsx` renderContent. Missing any step = invisible page.
**Files**: `src/store/navigation-store.ts`, `src/components/navigation/ProjectSidebar.tsx`, `src/components/navigation/AppShell.tsx`
**Impact**: Use this 5-step wiring checklist for any new settings tab. This is the #1 agent failure mode — writing a component that nothing renders.

---

## 2026-04-23 — ABLP-513 Tool Test Config Resolution Parity

**Category**: architecture
**Learning**: Studio `executeToolTest()` bypasses the normal agent compilation pipeline, so direct Tool Test execution must explicitly load namespace-scoped project config variables and run compiler `resolveConfigVariables()` against the built `ToolDefinition` before executing. The pre-pass must skip top-level `auth_profile_ref`; config-backed auth profile names still need to remain as `{{config.KEY}}` templates until the auth middleware resolves them through `resolveAuthProfileRef()`.
**Files**: `src/services/tool-test-service.ts`, `src/__tests__/tool-test-service.test.ts`
**Impact**: Any future Studio preview or direct-execution path that builds tools from raw DSL needs this same config-resolution step plus the `auth_profile_ref` exception, otherwise Tool Test behavior will drift from runtime agent execution.

**Category**: gotcha
**Learning**: Legacy project tools can have an empty `variableNamespaceIds` array even though new project config variables are auto-linked to the project default namespace. Direct Tool Test must compute an effective namespace scope before config pre-resolution: explicit tool namespaces win, otherwise fall back to the project default namespace. Without that fallback, `{{config.X}}` placeholders stay unresolved and the HTTP executor can surface a misleading SSRF failure on the unresolved target.
**Files**: `src/services/tool-test-service.ts`, `src/__tests__/tool-test-service.test.ts`
**Impact**: Future namespace-scoped variable changes should distinguish raw helper fail-closed behavior from compatibility fallbacks in Studio execution paths. Preserve tenantId + projectId on every namespace and membership lookup.

## 2026-04-16 — Rich Content Authoring Disclosure

**Category**: architecture
**Learning**: Studio rich-content preview support is broader than current ABL slash-insert authoring support. The parser/compiler surface for `/rich-template` insertion is currently limited to `FORMATS:`, `CAROUSEL:`, and the current `ACTIONS:` subset, so the catalog and insert panel must disclose a separate `dslAuthoringMode` (`supported`, `partial`, `preview_only`) instead of implying every previewable template is insertable today.
**Files**: `src/lib/template-catalog.ts`, `src/components/templates/TemplateInsertPanel.tsx`, `src/components/templates/TemplateCatalogPage.tsx`, `src/__tests__/template-catalog.test.ts`, `src/__tests__/template-insert-panel.test.tsx`
**Impact**: Future template-catalog or `/rich-template` work must update authoring disclosure and parser support together. Do not mark a template as insertable until the parser/compiler can actually accept the emitted DSL.

## 2026-04-16 — Isolated Studio Bootstrap For SDK Widget E2E

**Category**: gotcha
**Learning**: In the isolated `next start` browser stack, `ensureDb()` must reattach the DEK facade and global KMS resolver into the active model module context after `initDEKFacade()`. Without `setEncryptionFacade(dek.facade)` and `setGlobalKMSResolver(dek.resolver)`, encrypted model writes inside `dev-login` fail with "encrypted fields require the DEK facade" even though MongoDB connectivity succeeded.
**Files**: `src/lib/ensure-db.ts`, `src/__tests__/lib-sso.test.ts`, `e2e/helpers/sdk-browser-stack.ts`
**Impact**: If isolated Studio auth/bootstrap fails only under browser harnesses, inspect DEK facade wiring before assuming the widget or runtime is broken.

**Files**: `src/components/modules/PublishModuleDialog.tsx`, `src/components/modules/ImportModuleDialog.tsx`
**Impact**: When composing dialogs into page wrappers, verify whether the dialog self-manages its visibility or requires explicit open/onClose props. This asymmetry is the #1 implementation trap for module page wrappers.

**Category**: gotcha
**Learning**: `config/navigation.ts` and `ProjectSidebar.tsx` are independent copies of navigation definitions. `config/navigation.ts` items use `group: string` property; `ProjectSidebar.tsx` items use `section: string` property. The files are out of sync: `config/navigation.ts` is missing `settings-auth-profiles`, `settings-attachments`, and `pipelines`. Both files must be updated when adding new navigation entries.
**Files**: `src/config/navigation.ts`, `src/components/navigation/ProjectSidebar.tsx`
**Impact**: When adding sidebar entries, always update BOTH files. UniversalSearch reads from `config/navigation.ts` via `getAllNavItems()` — missing entries there means the page is not searchable.

**Category**: pattern
**Learning**: For top-level resource pages (like `module-dependencies`), no entries in `settingsSubPages` or `settingsPageMap` are needed — the generic URL handler in `navigation-store.ts` parses them as `page = parts[2]`. Only settings sub-pages (URL: `/settings/<slug>`) need map entries.
**Files**: `src/store/navigation-store.ts`
**Impact**: When adding new pages, determine if it's a settings sub-page (needs 3 map entries) or a top-level page (needs only the ProjectPage union variant).

---

## 2026-04-03 — Channel Identity Config + Auth Profile Control Plane

**Category**: gotcha
**Learning**: Channel create/edit payloads must now send provider verification policy as `identityVerification.providerVerificationStrength`. Runtime route utils reject the old top-level `providerVerificationStrength`, and conflicting nested/top-level values are treated as invalid input.
**Files**: `src/components/deployments/channels/CreateInstanceDialog.tsx`, `src/components/deployments/channels/tabs/ConfigurationTab.tsx`
**Impact**: Future channel UI changes should treat nested `identityVerification` as the only stable API shape. Reintroducing the top-level field will break runtime validation.

**Category**: architecture
**Learning**: Studio remains the canonical control plane for project/workspace auth-profile CRUD, bulk actions, and OAuth UX even though Runtime now has a smaller shared/workspace auth-profile router. Legacy `oauth2_token` profiles should be surfaced as read-only migration records in Studio instead of editable long-term state.
**Files**: `src/app/api/projects/[id]/auth-profiles/**`, `src/app/api/auth-profiles/**`, `src/components/auth-profiles/AuthProfileSlideOver.tsx`
**Impact**: New Studio auth-profile features should keep project/workspace flows in the BFF routes and preserve the migration-state treatment for legacy token profiles.

## 2026-04-05 — Web SDK Channel Parity Slice 2

**Category**: architecture
**Learning**: Studio SDK repo mutations should accept `tenantId` explicitly even when the underlying collection is keyed by `projectId`. The safe pattern is `findProjectByIdAndTenant()` before create/update/delete, then persist/query `tenantId` on tenant-scoped records like `WidgetConfig`.
**Files**: `src/repos/sdk-repo.ts`, `src/app/api/sdk/embed/[projectId]/route.ts`, `src/app/api/sdk/keys/[keyId]/route.ts`, `src/app/api/sdk/keys/route.ts`, `src/app/api/sdk/preview-token/route.ts`, `src/app/api/sdk/share/exchange/route.ts`, `src/app/api/sdk/share/route.ts`, `src/app/api/sdk/widget/[projectId]/route.ts`
**Impact**: Future Studio BFF work for SDK resources should thread `tenantId` from project access checks into repo helpers instead of assuming project ownership is enough once the route is authorized.

## 2026-04-05 — Interactions Tab Feature Architecture

**Category**: architecture
**Learning**: The Interactions tab is a pure client-side feature with zero backend routes. It consumes trace events from `ObservatoryStore` (which subscribes to WebSocket) and processes them into interaction cards using `event-processor.ts`. All event grouping, token aggregation, parallel detection, memory diff calculation, and flow state derivation happen in the browser. This keeps the feature stateless and avoids adding new API surfaces.
**Files**: `src/components/observatory/interactions/InteractionsTab.tsx`, `src/components/observatory/interactions/event-processor.ts`, `src/store/observatory-store.ts`
**Impact**: When adding new debug panel features, consider the client-side processing model for trace events. This avoids backend dependency cycles and keeps Studio responsive even with poor network conditions. Process trace events incrementally using `useMemo()` to avoid re-processing entire sessions on every render.

**Category**: pattern
**Learning**: Interactions tab implements bounded memory for agent switches by limiting `switchMap` to the last 100 interactions (InteractionsTab.tsx:43). Without this, sessions with 500+ interactions would create a Map with 500+ entries, causing memory bloat. For long-running sessions, always limit derived data structures to recent interactions and use virtualization for rendering.
**Files**: `src/components/observatory/interactions/InteractionsTab.tsx`
**Impact**: Future Observatory features that process large session histories should implement similar bounded structures. Consider: interaction limit (last N), time-based window (last hour), or size-based limit (last 10MB of events).

**Category**: testing
**Learning**: Interactions tab has 24 tests (6 unit + 11 integration + 7 E2E) covering core logic, service boundaries, and security isolation. Integration tests use real event-processor (no mocks) with fixture events. E2E tests use real MongoDB, real auth, no mocked codebase components. The feature was promoted from ALPHA to BETA after implementing minimum test coverage (3 integration + 3 E2E) to resolve GAP-001.
**Files**: `src/__tests__/interactions-*.test.ts`, `src/__tests__/fixtures/trace-events.ts`, `e2e/interactions-tab.spec.ts`, `docs/testing/interactions-tab.md`
**Impact**: When adding new Observatory features, follow this test layering: (1) Unit tests for pure logic, (2) Integration tests for service boundaries with fixtures, (3) E2E tests for full HTTP API + MongoDB + auth. Do not mock codebase components in integration/E2E tests — only external third-party services via DI.

**Category**: gotcha
**Learning**: Trace event schema is not versioned. Runtime can add new trace event types (e.g., `gather_start`, `gather_complete` were added for gather lifecycle banners) and Studio must handle unknown event types gracefully. The event processor uses a `Set` of known lifecycle events and a `Record` mapping event types to step types, with defaults for unmapped events. When Runtime adds new trace events, update `constants.ts` `EVENT_TO_STEP` and `LIFECYCLE_EVENTS` accordingly, or events will be dropped from the timeline.
**Files**: `src/components/observatory/interactions/constants.ts`, `src/components/observatory/interactions/event-processor.ts`, `apps/runtime/src/services/execution/trace-helpers.ts`
**Impact**: If Interactions tab stops showing certain steps after a Runtime upgrade, check if new trace event types were added without updating `constants.ts`. Long-term solution: implement trace event schema versioning with Runtime version negotiation (GAP-006 in feature spec).

**Category**: pattern
**Learning**: For retroactive feature specs (documenting already-implemented features), follow this workflow: (1) Read design doc if it exists, (2) Read implementation code to verify actual functionality, (3) Run unit tests to understand coverage, (4) Document known gaps honestly (e.g., "No E2E tests"), (5) Mark status as ALPHA if gaps exist. This ensures specs are grounded in reality, not aspirational. Delivery plan should note "This feature has already been implemented" and list completion dates.
**Files**: `docs/features/interactions-tab.md`, `docs/testing/interactions-tab.md`, `docs/sdlc-logs/interactions-tab/feature-spec.log.md`
**Impact**: When writing retroactive specs for other implemented features (e.g., Observatory, Agent Testing, Model Hub), use Interactions tab as a template. Prioritize accuracy over completeness — better to document 10 known gaps than to claim functionality that doesn't exist.

## 2026-04-06 — Eval Preflight Belongs In The Runs Workflow

**Category**: testing
**Learning**: `EvalPreflightPanel` is part of the operator workflow, not a standalone diagnostic component. If it is not mounted inside `RunsTab`, the preflight API can exist and the component can compile while users never see the checks and component tests rightfully fail. Keep the panel visible in both the empty-run and active-run views so setup guidance stays attached to the place where users launch and monitor evals.
**Files**: `src/components/evals/tabs/RunsTab.tsx`, `src/components/evals/EvalPreflightPanel.tsx`, `src/__tests__/components/evals/runs-tab-preflight.test.tsx`
**Impact**: Future eval UX changes should treat preflight diagnostics as part of the runs tab contract and keep component coverage for both zero-run and existing-run states.

## 2026-04-06 — Web SDK Channel Parity Slice 7

**Category**: architecture
**Learning**: Studio SDK key routes should consume structured `allowedOrigins` and `permissions` values directly from `sdk-repo` and must not `JSON.stringify` or `JSON.parse` those fields in handlers. Keep legacy repair/normalization inside the shared seam (`sdk-repo` + database model normalizers), then format route responses from the normalized repo record.
**Files**: `src/repos/sdk-repo.ts`, `src/app/api/sdk/keys/route.ts`, `src/app/api/sdk/keys/[keyId]/route.ts`, `src/app/api/sdk/share/exchange/route.ts`
**Impact**: Future SDK control-plane changes should add new key or project lookups to repo helpers first, then have routes consume the typed repo contract rather than importing models directly or hand-parsing persisted fields.

## 2026-04-03 — ARCH Specialist Enhancement: Topology Pattern Intelligence

**Category**: pattern
**Learning**: When adding new fields to topology Zod schemas, always use `.catch()` defaults for backwards compatibility. The `topologyResponseSchemaLenient` is the primary schema for LLM-generated topologies; the strict schema is for chat-route validated input. The lenient schema now includes `pattern`, `reasoning`, `role`, `suggestedConstructs`, and `returnsControl`. The `generate-topology.ts` tool also has its own local output schemas to ensure new fields get defaults before being returned to the caller.
**Files**: `src/services/arch.service.ts`, `src/lib/arch-ai/tools/generate-topology.ts`
**Impact**: Future topology schema additions should follow the same `.catch()` pattern. The strict schema was intentionally not updated with expanded edge types to avoid breaking the chat route — update it when the chat route is ready to handle the new edge types.

**Category**: gotcha
**Learning**: `generateTopologyStub()` uses an explicit array type annotation for the `nodes` array because TypeScript infers a narrow type from the initial supervisor element (`executionMode: 'reasoning'`), which prevents pushing elements with `executionMode: 'scripted' | 'reasoning'`. Without the annotation, TS error TS2322 occurs on the `.push()` call.
**Files**: `src/services/arch.service.ts`
**Impact**: If adding new node types or execution modes to stubs, ensure the array type annotation includes them.

## 2026-04-03 — ARCH v0.3 CREATE Phase Wiring

**Category**: pattern
**Learning**: The `handleCreateProject` function in `page.tsx` originally used raw `fetch()` to POST `{ type: 'create' }` — this bypassed the SSE stream parsing in `useArchChat`, so the `tool_result` event (containing `projectId`) was never received by the frontend. The fix was to use the existing `sendCreate()` from `useArchChat`, which goes through `postMessage` and properly processes the SSE stream. Always use the hook's send functions rather than raw fetch for SSE-streaming endpoints.
**Files**: `src/app/arch/page.tsx`, `src/hooks/useArchChat.ts`
**Impact**: Any future Arch actions that emit SSE events must go through `postMessage` (via the hook's exposed methods) — never raw `fetch()`. The `tool_result` SSE event type was already parsed by `parseSSEStream` but silently dropped by the `default` case in the switch. New SSE event types from `ArchSSEEventSchema` need explicit `case` handlers.

**Category**: gotcha
**Learning**: When a `tool_result` event arrives mid-stream (after `text_delta` events), the pending `assistantContent` must be finalized as its own message before appending the tool_result message. Otherwise, the tool_result message could clobber or merge with the text content. The pattern: check `assistantContent`, flush it into the last assistant message, reset to empty string, then append the new tool_result message.
**Files**: `src/hooks/useArchChat.ts`
**Impact**: If adding more tool_result handlers (beyond `create_project`), follow the same flush-then-append pattern.

## 2026-04-06 — Connector OAuth Catalog Validation

**Category**: pattern
**Learning**: `src/lib/connector-oauth.ts` now delegates all connector OAuth `connectionConfig` validation to `@agent-platform/connectors/auth` instead of trimming keys locally. Any Studio route or test fixture that expects `connectionConfig` to survive initiation must declare those keys in the catalog metadata first; undeclared keys are rejected before pending OAuth state is stored.
**Files**: `src/lib/connector-oauth.ts`, `src/app/api/projects/[id]/connections/oauth/initiate/route.ts`, `src/__tests__/connector-oauth.test.ts`, `src/__tests__/connection-oauth-callback-route.test.ts`
**Impact**: Future connector OAuth tests should model real catalog `connectionConfig` metadata in the fixture before asserting on the stored payload. Do not rely on ad-hoc extra keys surviving initiation anymore.

## 2026-04-06 — Connector OAuth Callback Origin Validation

**Category**: gotcha
**Learning**: `new URL(appUrl).origin` is not a sufficient fail-closed check for Studio OAuth callback origins because non-web schemes like `javascript:` and `file:` parse successfully and produce the literal origin string `"null"`. The connection OAuth initiate route must reject any `NEXT_PUBLIC_APP_URL` that is missing or not `http:`/`https:` before constructing `redirect_uri`.
**Files**: `src/app/api/projects/[id]/connections/oauth/initiate/route.ts`, `src/__tests__/connector-oauth.test.ts`
**Impact**: Future Studio OAuth initiate flows should validate configured app URLs as real web origins and keep a regression test for invalid env values so header-based fallback logic or `"null"` callback origins do not reappear.

## 2026-04-06 — Connection OAuth Callback Hardening

**Category**: security
**Learning**: The Studio connection OAuth callback must re-run SSRF validation on `pending.tokenUrl` before exchanging the authorization code, even when initiate already validated the resolved URL. Treat callback-time token exchange as a separate trust boundary and keep it behind an explicit 10-second `AbortController` timeout.
**Files**: `src/app/api/projects/[id]/connections/oauth/callback/route.ts`, `src/__tests__/connection-oauth-callback-route.test.ts`
**Impact**: Future callback-route changes must preserve callback-time SSRF revalidation and abortable fetch coverage. Happy-path-only callback tests are not enough for this seam.

**Category**: testing
**Learning**: The connection OAuth callback now fails closed when `completeOAuthSetup()` throws or unexpectedly returns `null` after a successful token exchange. Route tests should keep both branches covered because production uses strict persistence mode while mocks can still accidentally return `null`.
**Files**: `src/app/api/projects/[id]/connections/oauth/callback/route.ts`, `src/__tests__/connection-oauth-callback-route.test.ts`
**Impact**: When mocking `getConnectionService()` in callback-route tests, verify both persistence-exception and missing-record paths return 500 instead of silently reporting success.

## 2026-04-06 — Connection OAuth Callback Rollback

**Category**: architecture
**Learning**: The Studio connection OAuth callback creates a placeholder connection before `completeOAuthSetup()`. If token persistence fails or returns no updated record, the route must delete that placeholder before returning `500`; otherwise the project is left with an active OAuth2 connection that has empty credentials.
**Files**: `src/app/api/projects/[id]/connections/oauth/callback/route.ts`, `src/__tests__/connection-oauth-callback-route.test.ts`
**Impact**: Future OAuth callback or reconnect flows that split create-vs-persist into separate steps must preserve the rollback invariant and keep regression coverage on both the thrown-error and null-result persistence paths.

## 2026-04-06 — Studio SDK Channel Admin Contract Alignment

**Category**: gotcha
**Learning**: The Studio SDK-channel admin UI cannot treat `apiKey` as a guaranteed raw key value. Runtime now returns the embeddable `pk_...` prefix as a nullable display/copy field, while clearable settings such as `allowedOrigins` and `rateLimitRpm` must be sent as explicit `null` on edit so the runtime can clear persisted values instead of interpreting omission as "leave unchanged."
**Files**: `src/hooks/useConnectors.ts`, `src/components/admin/ConnectorsPage.tsx`, `src/__tests__/api-routes/admin-sdk-channels-route.test.ts`
**Impact**: Future Studio admin forms for SDK channels should distinguish between create-time omission and update-time clearing. When contract fields are display-only or nullable, keep the hook types and copy UI aligned with runtime rather than assuming every channel has a copyable secret-like key string.

## 2026-04-06 — Admin SDK Channel Proxy Round-Trip Assertions

**Category**: testing
**Learning**: `admin-sdk-channels-route.test.ts` should assert both halves of the proxy seam: the outbound request body forwarded to runtime and the inbound runtime JSON returned to Studio unchanged. The load-bearing fields here are `rateLimitRpm`, `allowedOrigins`, and the display-safe `apiKey` `pk_...` prefix.
**Files**: `src/app/api/admin/sdk-channels/route.ts`, `src/__tests__/api-routes/admin-sdk-channels-route.test.ts`
**Impact**: Future admin proxy changes should not stop at URL/method assertions. If runtime adds or reshapes SDK-channel contract fields, update the proxy test to prove Studio still round-trips the runtime payload verbatim.

## 2026-04-07 — Channel Connection Delete Messaging Resolver

**Category**: pattern
**Learning**: Channel connection delete copy now relies on a shared resolver instead of per-component branching. `resolveChannelDeleteAction()` should treat non-inactive `channel_connection` rows as a deactivate flow, while `resolveChannelDeleteOutcome()` should prefer the runtime’s returned `outcome` so success toasts reflect whether the backend deactivated or hard-deleted the record.
**Files**: `src/lib/channel-delete-behavior.ts`, `src/components/deployments/channels/ChannelInstanceList.tsx`, `src/components/deployments/channels/ChannelInstanceConfig.tsx`, `src/components/admin/ConnectorsPage.tsx`, `src/__tests__/components/channel-delete-copy.test.tsx`
**Impact**: Future channel lifecycle or copy changes should update the shared resolver and the focused regression test together instead of hand-patching the list, config, and admin views separately.

## 2026-04-06 — Web SDK Channel Parity Slice 3

**Category**: architecture
**Learning**: `SessionHistoryBridge` in `StudioChatPanel` must forward `SessionMessage.role` unchanged when hydrating SDK transcript items. Coercing `’thought’` to `’system’` breaks parity with the SDK `MessageRole` contract and strips stored thought messages of their intended rendering semantics during trace synthesis.
**Files**: `src/components/chat/StudioChatPanel.tsx`, `src/types/index.ts`, `src/__tests__/session-message-synthesis.test.ts`
**Impact**: Future Studio chat/session normalization should treat `MessageRole` from `@agent-platform/web-sdk` as the source of truth and keep a regression that proves stored thought messages survive synthesis without role rewriting.

## 2026-04-06 — Web SDK Channel Parity Slice 4

**Category**: architecture
**Learning**: `useStudioTransport` must bridge SDK lifecycle events from two separate Studio signals: `sessionId` changes for session-boundary resets and `WebSocketContext.isConnected` transitions for real network disconnects/reconnects. Keep that bridge in one place so combined session+connectivity changes emit at most one reset sequence instead of duplicate `connected` events.
**Files**: `src/adapters/useStudioTransport.ts`, `src/__tests__/studio-transport.test.ts`
**Impact**: Future transport-adapter work should treat websocket connectivity as part of the `SDKTransport` contract, not just a derived `isConnected()` getter, and should keep a rerender-based regression that proves lifecycle listeners fire on real websocket state changes.

## 2026-04-07 — Web SDK Browser E2E Resilience And Voice Coverage

**Category**: testing
**Learning**: SDK browser E2E tests only guard the real Studio seam when they trigger transport and media lifecycle changes directly. For agent chat resilience, install a page-init tracker for runtime `/ws` sockets, close the active socket from the page, and wait for both a replacement socket and the chat input re-enable before sending the follow-up prompt. For shared preview voice, open the launcher first, grant microphone permission, probe `getUserMedia`, and assert `voice_start`/`voice_audio`/`voice_stop` client frames plus `voice_started`/`voice_stopped` server frames. Mode-toggle or websocket-count checks alone are nominal coverage and miss real regressions.
**Files**: `e2e/sdk-chat-consolidation-e2e.spec.ts`, `e2e/sdk-preview-share.spec.ts`
**Impact**: Future Studio SDK browser tests should prefer explicit reconnect and voice-lifecycle probes over passive UI continuity assertions so transport regressions fail at the browser boundary instead of slipping through as false confidence.

## 2026-04-06 — Learning Academy Studio UI (Phase 6)

**Category**: architecture
**Learning**: Academy pages use the Next.js App Router (`src/app/academy/`) with a dedicated layout that wraps a client-side `AcademyLayout` component (header + sidebar + main). The `/academy` path is excluded from the SPA catch-all rewrite in `proxy.ts` (same pattern as `/docs`). API calls go through proxy: `/api/academy/*` -> `ACADEMY_URL` (default `http://localhost:3116`) -> `/api/v1/academy/*`.
**Files**: `src/app/academy/layout.tsx`, `src/components/academy/AcademyLayout.tsx`, `src/proxy.ts`
**Impact**: New academy sub-pages (e.g., `/academy/courses`, `/academy/leaderboard`) will be picked up by the existing App Router layout without additional proxy or SPA routing changes.

**Category**: pattern
**Learning**: The academy i18n namespace is a separate JSON file (`packages/i18n/locales/en/academy.json`) merged as `academy: academyMessages` in the i18n request config. This requires a corresponding turbopack resolveAlias entry in `next.config.mjs` for dev mode. Components use `useTranslations('academy')` to access keys.
**Files**: `packages/i18n/locales/en/academy.json`, `src/i18n/request.ts`, `next.config.mjs`
**Impact**: Adding new locale namespaces requires three changes: (1) create the JSON file, (2) import in `request.ts`, (3) add turbopack alias in `next.config.mjs`.

**Category**: pattern
**Learning**: The academy Zustand store defines types locally rather than importing from `@agent-platform/academy` to avoid adding a server-side package as a client dependency. The API response types are simple JSON shapes that can be maintained as a lightweight mirror.
**Files**: `src/store/academy-store.ts`
**Impact**: If the academy API types change significantly, update the mirror types in academy-store.ts accordingly.

## 2026-04-06 — Learning Academy Studio UI (Phase 7: Core Pages)

**Category**: architecture
**Learning**: Academy UI pages follow a flat data-fetching pattern using `apiFetch` + `useState` (not SWR or Zustand for page-level data). Only shared state (config, progress) lives in the Zustand store. Page-specific data (courses list, module info, quiz questions) is fetched locally. This avoids over-engineering the store for data that is only used by one page.
**Files**: `src/app/academy/courses/page.tsx`, `src/app/academy/courses/[courseId]/page.tsx`, `src/app/academy/modules/[moduleId]/page.tsx`
**Impact**: Future academy pages should follow this same pattern: use the store for cross-page state, use local state for page-specific data.

**Category**: gotcha
**Learning**: The `AcademyProgress.modules` field from the API is a plain JSON object (not a Map) because MongoDB Map fields are serialized as `Record<string, T>` over JSON. The store type uses `Record<string, AcademyModuleProgress>` rather than `Map<string, ModuleProgress>`. Access via `progress.modules?.[moduleId]` — not `.get()`.
**Files**: `src/store/academy-store.ts`
**Impact**: Never assume Map-like API responses from JSON endpoints. Always use Record/plain-object access patterns for deserialized Map fields.

**Category**: pattern
**Learning**: Module viewer uses `useRef` flags (`contentLoadedRef`, `quizLoadedRef`) to avoid re-fetching content/quiz when switching tabs. This is a simple alternative to SWR's caching and avoids adding SWR as a dependency for these endpoints.
**Files**: `src/app/academy/modules/[moduleId]/page.tsx`
**Impact**: For simple fire-once fetches that don't need revalidation, useRef flags are cleaner than SWR.

**Category**: pattern
**Learning**: Academy component types (PersonaCardData, CourseCardData, ModuleCardData, QuizFormQuestion, QuizResultData) are co-located with their components as exported interfaces. This avoids a separate types file and keeps component props self-documenting.
**Files**: `src/components/academy/PersonaCard.tsx`, `src/components/academy/CourseCard.tsx`, `src/components/academy/ModuleCard.tsx`, `src/components/academy/QuizForm.tsx`, `src/components/academy/QuizResults.tsx`
**Impact**: When adding new academy components, export their data types from the component file.

## 2026-04-09 — WebSocket Auth Refresh Regression Harness

**Category**: testing
**Learning**: Studio auth-refresh regression tests need mocked `clearAuth()` to apply the same Zustand state mutation as the real store. If the mock only records calls, `apiFetch()` and `scheduleTokenRefresh()` failures can be asserted, but the downstream `WebSocketProvider` disconnect path is not reproduced. The regression harness should drive all three seams together: background `401`, auth-store flip, and WebSocket teardown.
**Files**: `src/__tests__/websocket-auth-refresh-regression.test.tsx`, `src/lib/api-client.ts`, `src/api/auth.ts`, `src/contexts/WebSocketContext.tsx`
**Impact**: Future auth/WebSocket regressions should keep the mock store stateful and verify both the auth flag and `WebSocket.close()` behavior, not just whether `clearAuth()` was invoked.

## 2026-04-09 — Scheduled Refresh Disconnect Reproduction

**Category**: testing
**Learning**: The scheduled refresh path needs its own integrated regression because `scheduleTokenRefresh()` can fail long after the initial render. The reliable reproducer is: mount `WebSocketProvider`, arm the refresh timer, advance fake timers into the background refresh `401`, then rerender so the mocked auth-store transition can propagate into the provider and expose the unintended `WebSocket.close()`.
**Files**: `src/__tests__/websocket-auth-refresh-regression.test.tsx`, `src/api/auth.ts`, `src/contexts/WebSocketContext.tsx`
**Impact**: When Studio auth or WebSocket lifecycle logic changes, keep at least one timer-driven regression test that exercises the delayed refresh failure path end-to-end instead of only unit-testing `scheduleTokenRefresh()` in isolation.

## 2026-04-09 — Preserve Token State In Auth Refresh Regressions

**Category**: testing
**Learning**: For background-refresh failures, asserting only `clearAuth()` calls is too weak. The regression test should also verify the in-memory `accessToken` remains intact, because Studio’s reconnect and debug-log browsing flows both depend on the token surviving transient `401`s even before the WebSocket provider rerenders.
**Files**: `src/__tests__/websocket-auth-refresh-regression.test.tsx`, `src/lib/api-client.ts`, `src/api/auth.ts`
**Impact**: Future auth-refresh fixes should preserve both the auth flag and the current token on transient refresh failures; otherwise higher-level WebSocket and trace-view regressions can slip through despite unit tests that only inspect function calls.

## 2026-04-09 — Explicit Logout Signal For WebSocket Teardown

**Category**: architecture
**Learning**: Studio WebSocket lifecycle should not key teardown off transient `isAuthenticated` flips. Background refresh failures must leave auth and the live socket intact, while real session-ending flows (`logout()`, idle timeout, and cross-tab logout sync) emit a shared `studio-auth:logout` signal that the `WebSocketProvider` listens to before closing the active socket.
**Files**: `src/store/auth-store.ts`, `src/api/auth.ts`, `src/contexts/WebSocketContext.tsx`, `src/lib/api-client.ts`
**Impact**: Future auth changes should treat destructive logout as an explicit event, not an inferred side effect of refresh failures or temporary auth-store transitions. If a new logout path is added, it needs to emit the same signal so WebSocket teardown stays aligned across tabs.

## 2026-04-10 — ABLP-274: Markdown rendering in Observatory InteractionStep

**Category**: pattern
**Learning**: Session detail conversation history (Observatory → Interactions panel) was displaying raw markdown syntax as plain text. InteractionStep.tsx rendered user_input and agent_response content with `<span className="whitespace-pre-wrap">` instead of parsing markdown. The fix: import react-markdown (already in package.json), add a `hasMarkdown()` helper using regex to detect common markdown patterns (`##`, `**`, `- `, `[](url)`, `` ` ``), and add a `renderContent()` helper that conditionally renders with `<ReactMarkdown remarkPlugins={[remarkGfm]}>` when markdown is detected, falling back to plain text otherwise. Apply Tailwind prose classes (`prose prose-sm dark:prose-invert`) for consistent formatting.
**Files**: `src/components/observatory/interactions/InteractionStep.tsx`
**Impact**: Future message display components in Studio should follow this pattern: detect markdown with regex, render conditionally with react-markdown, preserve truncate logic, and use prose classes for styling. Storage should always remain as raw strings for flexibility and auditability — markdown rendering is a display concern, not a data concern.

## 2026-04-10 — ABLP-274: Markdown Rendering in Session Detail View

**Category**: pattern
**Learning**: Agent response content in InteractionStep component must render markdown (headers, bold, italic, lists, code blocks, blockquotes) as formatted HTML, not raw text. Use ReactMarkdown with remarkGfm plugin to parse and render markdown syntax. User input (user_input type) should preserve literal text including markdown-like syntax, as users might type markdown characters intentionally.
**Files**: `src/components/observatory/interactions/InteractionStep.tsx`, `src/__tests__/components/interaction-step-markdown.test.tsx`
**Impact**: When rendering agent-generated content in UI components, consider whether markdown formatting should be applied. Agent responses benefit from markdown rendering for rich formatting (weather data, summaries, structured output). User inputs should remain literal to preserve user intent.

**Category**: testing
**Learning**: When writing regression tests for UI rendering bugs, assert the CORRECT expected behavior (markdown symbols should NOT appear, HTML elements SHOULD be present), not the current buggy behavior. Tests like `expect(content).toContain(‘# Current Weather’)` document bugs but don’t enforce fixes. Instead, use `expect(content).not.toContain(‘# Current Weather’)` and `expect(container.querySelector(‘h1’)).toBeTruthy()` to verify proper markdown rendering.
**Files**: `src/__tests__/components/interaction-step-markdown.test.tsx`
**Impact**: Regression tests should fail when the bug is present and pass when fixed. Avoid documenting current behavior if that behavior is incorrect.

## 2026-04-11 — Platform Keys

**Category**: gotcha
**Learning**:

1. **Studio Next.js API routes lack AsyncLocalStorage context** — the `tenantIsolationPlugin` cannot auto-inject `tenantId`. ALL Mongoose queries in Studio route handlers must include explicit `tenantId: user.tenantId`. Never rely on the plugin’s ALS-based auto-scoping in Studio.
2. **`validateBody` consumes the request body** — calling `request.clone().json()` after `validateBody` is unreliable. Use Zod `.strict()` on the schema to reject unknown fields instead of re-parsing the body.
3. **`uuidv7` is not re-exported from `@agent-platform/database`** — use `crypto.randomUUID()` as alternative for clientId generation.
4. **Dev-login rate limiter** kicks in after ~10 sequential test users in the same harness session. Consolidate tests that need separate auth contexts or share workspace/project setups across related tests to avoid 429 errors.
5. **Mongoose `.lean()` returns untyped results** in chained queries — explicitly type the variable (`const keys: IApiKey[] = ...`) rather than using a generic parameter on `.lean<T>()`.
   **Files**: `src/app/api/keys/route.ts`, `src/app/api/keys/[keyId]/route.ts`, `src/app/api/keys/platform-key-utils.ts`, `src/__tests__/platform-keys-api.test.ts`, `src/__tests__/platform-keys-api.e2e.test.ts`
   **Impact**: Any future Studio API route handler must include explicit tenantId in all queries. Test suites with many separate dev-login calls should batch auth-sharing to avoid rate limiting. Use `.strict()` instead of body re-parsing for unknown field rejection.

## 2026-04-12 — Platform Keys Phase 2 E2E Harness Seeding

**Category**: testing
**Learning**: When a Studio E2E scenario needs legacy/backwards-compat seed data that public routes cannot create, extend `studio-api-harness.ts` with a clearly test-only `POST /__test/...` endpoint instead of importing Mongoose models in the E2E spec. This preserves the repo's black-box E2E rule while still enabling cases like colon-scoped legacy platform keys.
**Files**: `src/__tests__/helpers/studio-api-harness.ts`, `src/__tests__/platform-keys-api.e2e.test.ts`
**Impact**: Future Studio E2E suites needing seed/setup beyond public app APIs should put that logic in the harness layer, not in the test file itself.

## 2026-04-14 — DeployPanel Revoked Key Refresh Regression

**Category**: testing
**Learning**: The user-visible revoked-key bug is easiest to reproduce in a component regression by simulating the full delete-refresh cycle: render `DeployPanel`, open the Public Keys tab, mock `DELETE /api/sdk/keys/:id` to succeed, then have the next `GET /api/sdk/keys` return the same key with `isActive: false`. Today `fetchData()` stores that inactive key unchanged and `ApiKeysTab` still renders it with an "Inactive" badge instead of falling back to the empty state.
**Files**: `src/components/deploy/DeployPanel.tsx`, `src/__tests__/components/deploy-panel-public-key-guidance.test.tsx`, `src/app/api/sdk/keys/route.ts`
**Impact**: Future deployment key regressions should test the post-delete refresh path, not only the initial load, because the bug depends on how refreshed inactive keys flow from the API into the tab state.

## 2026-04-14 — SDK Key Visibility Contract

**Category**: pattern
**Learning**: Studio deployment surfaces should treat revoked public SDK keys as non-displayable state at two boundaries: the BFF list route must pass `isActive: true` into `findPublicApiKeys()`, and `DeployPanel.fetchData()` should still filter refreshed keys client-side before storing them. That keeps the UI stable even if an upstream list response leaks inactive records.
**Files**: `src/app/api/sdk/keys/route.ts`, `src/components/deploy/DeployPanel.tsx`, `src/__tests__/api-routes/api-deployment-routes.test.ts`, `src/__tests__/components/deploy-panel-public-key-guidance.test.tsx`
**Impact**: Any future SDK key list consumer in Studio should preserve the active-only contract on the server and keep client-side filtering close to state ingestion rather than relying on render-time conditionals.

## 2026-04-13 — Pipeline Data Query & Export (Phase 6)

**Category**: architecture
**Learning**: Pipeline data query uses a three-layer pattern: schema resolver (Mongo lookup) -> query builder (pure SQL construction) -> ClickHouse client (execution). The schema resolver reads the `store-results` node from the pipeline definition's `nodes[]` array, extracting `config.table` and `config.outputSchema.columns`. The query builder is a pure function that validates all inputs and produces parameterized SQL. The ClickHouse client is a singleton with DI factory for testing.
**Files**: `src/lib/pipeline-data/schema-resolver.ts`, `src/lib/pipeline-data/query-builder.ts`, `src/lib/pipeline-data/clickhouse-client.ts`
**Impact**: Future pipeline data features (count queries, aggregation, time-series) should extend the query builder rather than building SQL in routes.

**Category**: gotcha
**Learning**: `requireProjectAccess(projectId, user)` takes projectId FIRST, user SECOND. This is the opposite order from what many plan specs assume. Always read `src/lib/project-access.ts` before using. Use `isAccessError()` (not `isAuthError()`) to check the result.
**Files**: `src/lib/project-access.ts`
**Impact**: Every new project-scoped route must verify this signature.

**Category**: gotcha
**Learning**: `checkRateLimit(key, maxAttempts, windowMs)` returns `{ allowed: boolean, retryAfter?: number }` — NOT `{ exceeded }`. The plan spec had the wrong shape. Always read `src/lib/rate-limit.ts` before using.
**Files**: `src/lib/rate-limit.ts`
**Impact**: Any route using rate limiting must check `!limited.allowed`, not `limited.exceeded`.

**Category**: gotcha
**Learning**: `AuthenticatedUser` uses `user.id` (not `user.userId`) and `user.tenantId` (present on `TenantAuthenticatedUser`). Plan specs frequently reference `user.userId` which doesn't exist.
**Files**: `src/lib/auth.ts`
**Impact**: Always read the auth types before writing route handlers.

**Category**: testing
**Learning**: Schema resolver tests require `ENCRYPTION_MASTER_KEY` env var because `ensureDb()` checks for it, even when using MongoMemoryServer. Set a dummy 64-char hex value in the test file: `process.env.ENCRYPTION_MASTER_KEY = process.env.ENCRYPTION_MASTER_KEY || 'a'.repeat(64)`.
**Files**: `src/lib/pipeline-data/schema-resolver.test.ts`
**Impact**: Any test that calls code using `ensureDb()` needs this env var set.

**Category**: gotcha
**Learning**: Zod's `z.unknown()` in an object schema makes the field optional in the inferred TypeScript type (`value?: unknown`). If the consuming TypeScript interface uses `value: unknown` (required), there's a type mismatch. Use `value?: unknown` in the interface to match.
**Files**: `src/lib/pipeline-data/query-builder.ts`
**Impact**: When building TypeScript interfaces that match Zod schemas with `z.unknown()`, use optional properties.

## 2026-04-13 — Pipeline Observability Phase 5: Test Trigger Route

**Category**: pattern
**Learning**: Pipeline route handlers that call Restate use dynamic imports: `await import('@agent-platform/pipeline-engine/client')` for `getRestateClient`, `await import('@agent-platform/pipeline-engine')` for service references like `pipelineTrigger`, and `await import('@agent-platform/pipeline-engine/schemas')` for Mongoose models. The `getRestateClient()` reads `RESTATE_INGRESS_URL` env var and returns an ingress client that makes HTTP POST calls to `${url}/${serviceName}/${handlerName}`.
**Files**: `src/app/api/pipelines/[pipelineId]/test/route.ts`, `src/app/api/pipelines/[pipelineId]/activate/route.ts`
**Impact**: When testing routes that use Restate, set `RESTATE_INGRESS_URL` to a test HTTP server rather than mocking `@agent-platform/*` packages (blocked by platform-mock-lint).

**Category**: testing
**Learning**: Integration tests for pipeline routes can avoid mocking `@agent-platform/*` by: (1) using MongoMemoryServer for real Mongoose models, (2) spinning up an `http.createServer` to simulate Restate ingress and setting `RESTATE_INGRESS_URL` to it. The Restate SDK client sends HTTP POST to `${url}/${serviceName}/${handlerName}` with JSON body, expects 200 + JSON for success, throws `HttpCallError` with message containing response text for non-2xx. The route catches these errors and maps the error code string (embedded in the message) to HTTP status codes.
**Files**: `src/__tests__/pipelines/pipeline-test-run.test.ts`
**Impact**: Reuse this test HTTP server pattern for any route that delegates to Restate.

**Category**: gotcha
**Learning**: `checkRateLimit(key, maxAttempts, windowMs)` from `@/lib/rate-limit` takes `windowMs` (milliseconds), not seconds. The in-memory fallback kicks in when Redis is unavailable (`isRedisAvailable()` returns false), which is the case in all test environments.
**Files**: `src/lib/rate-limit.ts`
**Impact**: Always use milliseconds (e.g., `60_000` not `60`) for the window parameter.

**Category**: gotcha
**Learning**: `requireProjectAccess(projectId, user)` — projectId comes FIRST, user comes SECOND. Plan specs frequently reverse the order. There is no standalone `requirePermission` helper in Studio — check `user.permissions.includes('perm')` directly.
**Files**: `src/lib/project-access.ts`
**Impact**: Always read the source of `requireProjectAccess` before using it.

**Category**: gotcha
**Learning**: `PipelineDefinition.supportedTriggers` entries require `strategy`, `label`, and `description` fields (all `required: true` in the Mongoose schema). Test seed data must include these fields or the create call throws a ValidationError that silently skips all tests.
**Files**: `packages/pipeline-engine/src/schemas/pipeline-definition.schema.ts`
**Impact**: When seeding pipeline definitions in tests, always provide complete trigger entries.

## 2026-04-13 — Pipeline Observability Phase 9: Data Tab UI

**Category**: pattern
**Learning**: The Data tab uses a `queryVersion` key pattern on `ClickHousePreviewTable` to force component remount on each new query. This ensures fresh state (rows, pagination offset, error code) without complex reset logic. The drawer variant uses a ref guard (`autoQueried`) to trigger the initial query after mount via `setTimeout` to avoid setState-during-render.
**Files**: `src/components/pipelines/data/ClickHousePreviewTable.tsx`, `src/components/pipelines/data/PipelineDataPanel.tsx`
**Impact**: If adding new query-driven components, consider this key-based remount pattern instead of manual state resets.

**Category**: gotcha
**Learning**: The `ClickHousePreviewTable` component uses `apiFetch` directly (not SWR) for the POST query endpoint because SWR is designed for GET-style idempotent fetches. The export endpoint similarly uses `apiFetch` + blob download. Both need explicit `Content-Type: application/json` headers.
**Files**: `src/components/pipelines/data/ClickHousePreviewTable.tsx`, `src/components/pipelines/data/PipelineDataPanel.tsx`
**Impact**: When adding POST-based data fetching in Studio, use `apiFetch` directly rather than SWR. SWR hooks should be reserved for GET endpoints.

**Category**: pattern
**Learning**: Client-side types for backend responses should be mirrored in a local `types.ts` file (e.g., `components/pipelines/data/types.ts`) rather than importing from server-side code that may pull in Mongoose or Node.js dependencies. This follows the same pattern established in `components/pipelines/runs/types.ts`.
**Files**: `src/components/pipelines/data/types.ts`
**Impact**: Always create client-side type mirrors for backend shapes. Never import from `src/lib/pipeline-data/` or similar server paths in client components.

## 2026-04-13 — Pipeline Observability UI: Cross-Phase Learnings

**Category**: architecture
**Learning**: Pipeline runs and data preview live under four tabs on PipelinesListPage (Built-in, Custom, Recent Runs, Data). Run Detail is a drawer. Test drawer opens from three entry points (card menu, PipelineConfigPage header, Run row Re-run) but shares one component via `pipeline-test-store` Zustand store. Data preview is filter-driven — no free-form SQL — gated by the pipeline's declared outputSchema.columns.filterable flag.
**Files**: `src/components/pipelines/runs/`, `src/components/pipelines/test/`, `src/components/pipelines/data/`
**Impact**: New surfaces should reuse RecentRunsPanel/ClickHousePreviewTable rather than duplicate the filter + table logic.

**Category**: pattern
**Learning**: ClickHouse queries use parameter binding via @clickhouse/client query_params. Never string-concatenate user filters. Column allowlist checked against schema.columns.filterable. Table name server-resolved from pipelineId — never from request body.
**Files**: `src/lib/pipeline-data/query-builder.ts`
**Impact**: Any expansion of the Data tab (new operators, free-form SQL) must go through the same allowlist + parameter-binding path.

## 2026-04-14 -- Custom Project Roles (ABLP-254, ABLP-327)

**Category**: architecture, testing
**Learning**:

1. **Extract services early for testability.** The project member CRUD logic was initially inline in route handlers, making it hard to test business rules without mocking HTTP/auth plumbing. Extracting `ProjectMemberService` and `project-member-repo.ts` enabled focused business rule testing.
2. **Project access hardening pattern.** `requireProjectAccess` was updated from "same-tenant = access" to "explicit membership OR owner OR tenant admin". This is the correct pattern: use membership as the canonical access check, with `ownerId` as a safety fallback. Non-members get 404 (not 403) to avoid existence leaks.
3. **Route param naming: `[memberId]` not `[userId]`.** Using `[userId]` as a route param creates ambiguity with the authenticated user's ID in middleware. The `[memberId]` convention is clearer.
4. **Permission centralization to `shared-auth`.** Project role permissions (`PROJECT_ROLE_PERMISSIONS`, `evaluateProjectPermission`, `PERMISSION_REGISTRY`) belong in `packages/shared-auth/src/rbac/`, not in the runtime app or `packages/shared`. Both Studio and Runtime import from `@agent-platform/shared/rbac` (which re-exports from shared-auth).
5. **Custom role schema guards.** The `ProjectMember` model needs `pre('validate')` and `pre('findOneAndUpdate')` hooks to enforce the `role === 'custom' <=> customRoleId !== null` invariant. Without these, the DB can enter an inconsistent state.

**Files**: `src/services/project-member-service.ts`, `src/repos/project-member-repo.ts`, `src/lib/project-access.ts`, `src/lib/require-project-member-or-admin.ts`, `src/app/api/projects/[id]/members/`
**Impact**: Future project-scoped features must check explicit `ProjectMember` membership (not just tenant context). Import permission constants from `@agent-platform/shared/rbac`, never from runtime directly.

## 2026-04-15 — Reusable Modules Studio Wiring

**Category**: architecture
**Learning**: Module UI work in Studio is only production-ready when four shell layers are wired together at the same time: `navigation-store.ts` for route shapes, `ProjectSidebar.tsx` for visible entry points, `config/navigation.ts` for UniversalSearch reachability, and `AppShell.tsx` for actual rendering plus project-level bootstrapping. Wiring only the page component or only the sidebar still leaves the feature functionally incomplete.
**Files**: `src/store/navigation-store.ts`, `src/components/navigation/ProjectSidebar.tsx`, `src/config/navigation.ts`, `src/components/navigation/AppShell.tsx`, `src/components/modules/ModuleSettingsPage.tsx`, `src/components/modules/ModuleDependenciesPage.tsx`
**Impact**: Future Studio features with “implemented but unreachable” symptoms should audit shell wiring explicitly instead of assuming a built component is discoverable.

**Category**: gotcha
**Learning**: `useImportedSymbols` depends on `module-store.dependencies`, so loading module dependencies inside `ModuleDependencyList` is too late and too narrow. The correct hydration point is the project shell (`AppShell`) so authoring surfaces such as `ABLSymbolTree`, `ToolPickerDialog`, and `CoordinationSection` have the data before their first render.
**Files**: `src/components/navigation/AppShell.tsx`, `src/hooks/useImportedSymbols.ts`, `src/store/module-store.ts`, `src/__tests__/module-dependency-loading.test.tsx`
**Impact**: Any future feature that feeds global authoring hooks from page-local state should move hydration to the shell or another project-scoped bootstrap layer.

## 2026-05-11 — One-Shot Arch AI Generate Endpoint (ABLP-946)

**Category**: architecture
**Learning**: The one-shot `/api/arch-ai/generate` endpoint drives the full INTERVIEW → BLUEPRINT → BUILD → CREATE pipeline server-side by looping `processMessage` with synthetic events from a pure-function dispatcher (`oneshot-dispatcher.ts`). Key design decisions:

1. **Dispatcher is a pure function** — `decideNextEvent(session, specText)` maps session state to the next `MessageRequest`, making it unit-testable without mocks.
2. **processMessage does NOT reset ACTIVE → IDLE on return** — the SSE route's `.finally()` block does this. The one-shot handler must replicate this cleanup after each processMessage call.
3. **BLUEPRINT prompt must explicitly tell the LLM NOT to call ask_user** — otherwise the LLM may ask questions, burning BLUEPRINT_MAX_QUESTIONS (3) iterations and auto-synthesizing a 1-agent topology via `synthesizeDefaultTopology`.
4. **CREATE phase requires two steps** — `handleBuildAction('create')` transitions BUILD → CREATE, then `msg.type='create'` actually creates the project.
5. **Runaway-loop guard** — 5 consecutive same-type dispatches = abort.
   **Files**: `src/app/api/arch-ai/generate/route.ts`, `src/lib/arch-ai/oneshot-dispatcher.ts`, `src/__tests__/arch-ai/oneshot-dispatcher.test.ts`, `src/__tests__/arch-ai/oneshot-generate-validation.test.ts`
   **Impact**: Future modifications to `processMessage` must consider the one-shot path. If new interaction types are added (widgets, gates), the dispatcher must handle them. The dispatch loop pattern can be reused for other server-driven pipeline executions.

## 2026-04-15 — Arch v0.3 Stream Handling

**Category**: architecture
**Learning**: The Arch v0.3 frontend must stay aligned with the live SSE contract from `process-message.ts`. `gate_request` and `progress` are still emitted by the backend and must be handled in `useArchChat`; treating onboarding as “gate-free” in the client leaves pending approval steps invisible and makes streamed project-create progress disappear from the UI.
**Files**: `src/hooks/useArchChat.ts`, `src/lib/arch-ai/processors/process-message.ts`, `packages/arch-ai/src/types/sse-events.ts`
**Impact**: When changing the Arch stream protocol, update backend emitters, the shared SSE types, and the frontend hook in the same change. Add regression tests for any newly handled event type.

**Category**: pattern
**Learning**: Arch stream debugging is easier when both backend and frontend log through one request-scoped layer instead of ad hoc `console.*` calls. The backend now has a single observed stream wrapper, and the frontend uses a dedicated Zustand-backed stream debug store/helper so SSE lifecycle events, parse failures, and gate/progress mismatches can be inspected consistently.
**Files**: `src/app/api/arch-ai/message/route.ts`, `src/lib/arch-ai/stream-observer.ts`, `src/lib/arch-ai/stream-debug.ts`, `src/store/arch-stream-debug-store.ts`
**Impact**: Prefer extending these shared stream logging layers rather than adding new console statements inside Arch chat hooks, overlay boot logic, or SSE emitters.

## 2026-04-14 — Workflow-as-Tool UI E2E Tests

**Category**: testing
**Learning**: Key patterns and gotchas for Playwright UI E2E tests against Studio's workflow-tool components:

1. **Shared UI primitives lack testid passthrough** — Select, Tabs, Badge needed optional `testid` props added. Extending with a prop is cleaner than wrapping in `<div data-testid>`.
2. **ToolsListPage workflow tab has no Create button** — `primaryAction` is `undefined` for workflow/searchai tabs. The `/tools/new?type=workflow` URL is the correct entry point for testing the create flow.
3. **Route-level Zod rejects `status: 'draft'`** — only `active|paused|archived` are valid. Use `archived` as a substitute for "not visible in active-only pickers" in test fixtures.
4. **Re-authenticate in afterAll** — JWT tokens from beforeAll may expire during long serial test suites. Always call `loginViaDevApi` + `getToken` at the start of afterAll to prevent orphaned test data.
5. **Replace ALL waitForTimeout** — including in beforeAll blocks. Use `element.waitFor({ state: 'visible' })` or `expect(locator).toBeVisible({ timeout })` everywhere. Eliminates CI flakiness from fixed delays.
6. **Radix Select portals to document.body** — use `page.getByRole('listbox')` to find the dropdown, not a locator scoped to the trigger's parent.
7. **Hard assertions over soft guards** — never wrap E2E assertions in `if (isVisible)` guards. If the element should be there, `expect().toBeVisible()` must fail when it's missing.
   **Files**: `e2e/workflow-tool-config.spec.ts`, `e2e/workflow-tool-list.spec.ts`, `e2e/helpers/workflow-seed.ts`, `src/components/ui/Select.tsx`, `src/components/ui/Tabs.tsx`, `src/components/ui/Badge.tsx`
   **Impact**: Future Studio E2E specs for tool types should follow these patterns. The seed helper pattern (`seedWorkflowWithWebhook` / `deleteSeededWorkflow`) can be replicated for other tool types. Always check whether the tools list page has a Create button for the tab type before writing create-dialog E2E flows.

## 2026-04-15 — Workflow Versioning: Studio UI Changes

**Category**: architecture
**Learning**: Key patterns for the workflow versioning Studio integration:

1. **WorkflowVersionsTab** (`src/components/workflows/tabs/WorkflowVersionsTab.tsx`) uses SWR to fetch versions from `/api/projects/:id/workflows/:wfId/versions`. API returns `{ success, versions, total }` — access via `versionsData.versions`, NOT `.data`.
2. **Canvas auto-save** (`src/components/workflows/canvas/useWorkflowSave.ts`) targets `PATCH /versions/draft`. Payload MUST wrap fields under `definition: { nodes, edges, envVars, inputSchema, outputSchema }` — the PATCH handler reads `req.body.definition.*`, not flat fields.
3. **Status removal** — Workflow cards, list page, and detail page no longer show status badges or status filters. Workflow has no `status` field; version state (`active`/`inactive`) is per-version, shown in the Versions tab.
4. **5 proxy routes** added under `src/app/api/projects/[id]/workflows/[workflowId]/versions/` — all use `workflow:update` permission (not `workflow:write`).
   **Files**: `src/components/workflows/tabs/WorkflowVersionsTab.tsx`, `src/components/workflows/canvas/useWorkflowSave.ts`, `src/api/workflows.ts`, `src/components/workflows/WorkflowCard.tsx`, `src/components/workflows/WorkflowDetailPage.tsx`, `src/components/workflows/WorkflowsListPage.tsx`
   **Impact**: Future workflow UI work should reference version state (active/inactive on WorkflowVersion), not workflow status. The versions SWR key pattern can be replicated for other version-aware tabs.

## 2026-04-15 — Workflow-as-Tool picker alignment with version-first model

**Category**: architecture, UX
**Learning**: When registering a workflow as a tool, the original single workflow+trigger picker does not fit the version-first model. Split into three sequential dropdowns in `src/components/tools/WorkflowConfigForm.tsx`:

1. **Workflow dropdown** — project-scoped, no status filter (container `status` is vestigial).
2. **Version dropdown** — filters to `version === 'draft' || state === 'active'`. Drafts are spec-guaranteed active per `docs/specs/workflow-versioning.hld.md`; some older version docs have `state: undefined` which historically caused `"vdraft · undefined"` labels. Default selection prefers first published (non-draft) active version, falls back to draft.
3. **Trigger dropdown** — filters to `triggerType === 'webhook'`, `status !== 'deleted'`, and applies version pinning (`!tr.workflowVersionId || tr.workflowVersionId === selectedVersionId`). Unpinned triggers apply across all versions.

Input parameters are derived from the selected version's `start` node `inputVariables` (fetched via `getVersion(projectId, workflowId, versionId)`), NOT from the container's live definition. Trigger-node config `inputVariables` take precedence if present.

`ToolCreateDialog.tsx` must forward `parameters` to `POST /tools` so the stored tool exposes the params the LLM sees — omitting this left the tool detail page empty and the LLM unable to call the tool. Also enforce `TOOL_NAME_REGEX` at the UI layer for fast feedback.

**Files**: `src/components/tools/WorkflowConfigForm.tsx`, `src/components/tools/ToolCreateDialog.tsx`, `packages/i18n/locales/en/studio.json`
**Impact**: Any future tool picker that binds to versioned resources (workflows, compiled agents, datasets) should follow this three-dropdown pattern and honor draft-always-active semantics.

## 2026-04-16 — Template Catalog Support Disclosure

**Category**: pattern
**Learning**: Template catalog metadata is only useful if the UI surfaces it. `template-catalog.ts` can derive `webRenderMode` and `studioPreviewMode` from `@agent-platform/web-sdk`, but `TemplateCatalogPage` should render badges for those modes on cards and in the detail pane so authors can tell whether a preview is native, fallback, or limited.
**Files**: `src/lib/template-catalog.ts`, `src/components/templates/TemplateCatalogPage.tsx`
**Impact**: Future template-catalog additions should update the shared support matrix in the SDK and verify the Studio page still exposes the resulting support modes instead of hiding them in unused fields.

**Category**: gotcha
**Learning**: `actions` are top-level message payloads, not nested under `richContent`. `TemplatePreview` must split `{ actions, ...richContent }` before handing data to `TemplateMockProvider`, or Studio preview will miss raw ActionSet messages even though the SDK renders them.
**Files**: `src/components/templates/TemplatePreview.tsx`, `src/components/templates/TemplateMockProvider.tsx`
**Impact**: Future Studio template previews should model the real message wire shape first, then apply preview-specific simplifications such as sanitized HTML or channel-native fallback summaries.

## 2026-04-16 — Rich Content Coverage Follow-On

**Category**: testing
**Learning**: Template catalog category controls are rendered as accessible tabs (`role="tab"`), not generic buttons. Tests that try to locate category filters by button role are brittle and miss the actual keyboard-navigation contract.
**Files**: `src/components/templates/TemplateCatalogPage.tsx`, `src/__tests__/template-catalog-page.test.tsx`
**Impact**: Future Studio catalog or picker tests should query the category controls as tabs first, then assert the active-state and panel behavior from that accessibility contract.

**Category**: testing
**Learning**: HTML preview coverage is strongest when it asserts sanitized DOM structure, not just text output. Checking that the rendered preview omits unsafe elements like `<script>` caught real sanitization behavior without overfitting to a specific stripped-text string.
**Files**: `src/components/templates/TemplateMockProvider.tsx`, `src/__tests__/template-preview.test.tsx`
**Impact**: Future Studio preview tests for sanitized content should assert the resulting DOM shape and the absence of unsafe nodes instead of relying only on text snapshots.

**Category**: gotcha
**Learning**: The isolated SDK widget browser stack needs `RUNTIME_PUBLIC_BASE_URL`, a valid hex `ENCRYPTION_MASTER_KEY`, and `ALLOW_INMEMORY_AUTH_GATE_STATE_STORE=true` when Redis is disabled. Without those, Studio serves embed config pointing at the wrong runtime or auth preflight blocks the widget before `ON_START`.
**Files**: `e2e/helpers/sdk-browser-stack.ts`, `e2e/helpers/sdk-browser-e2e.ts`, `e2e/sdk-widget.spec.ts`
**Impact**: Future isolated browser regressions that exercise SDK sessions should treat these env defaults as part of the test harness, not as optional debugging knobs.

## 2026-04-18 — ABL Contract Hardening Phase 1

**Category**: pattern
**Learning**: For Studio docs surfaces backed by repo-root canonical sources, wiring the check only into the root build is insufficient. The Studio package build itself must run `pnpm --dir ../.. abl:docs:check`, and the Turbo `@agent-platform/studio#build` task must declare the repo-root docs and generator inputs; otherwise Turbo can serve a cached Studio build when only canonical docs changed.
**Files**: `apps/studio/package.json`, `apps/studio/content/abl-reference/full-specification.mdx`, `turbo.json`
**Impact**: Any future Studio content mirrors or generated docs should update both the local package build script and the Turbo build inputs together so stale canonical sources cannot slip through caching.

---

## 2026-04-18 — Workflow Webhook Versioning Phase 4 (Studio UI)

**Category**: pattern
**Learning**: The `Badge` component (`src/components/ui/Badge.tsx`) does NOT support `onClick`, `title`, or `aria-label` props. To make a badge clickable, wrap it in a `<button>` element. For tooltips, wrap in a `<span title="...">`. Available variants are: `default`, `accent`, `success`, `warning`, `error`, `info`, `purple`. There is NO `neutral` or `muted` variant — use `default` for neutral/gray badges.
**Files**: `src/components/ui/Badge.tsx`, `src/components/workflows/WorkflowDetailPage.tsx`
**Impact**: Always READ the Badge source before using it. The LLD may propose prop names that do not exist on the actual component.

**Category**: pattern
**Learning**: Viewed-version prop threading pattern: `WorkflowDetailPage` computes `viewedVersionInfo` (a memo from the versions SWR response) and passes `viewedVersion` + `viewedState` as optional props down through `WorkflowTriggersTab` → `TriggerCard` → `WebhookQuickStart` → `CodeSnippets`. Each component accepts optional props so existing callers are unaffected.
**Files**: `src/components/workflows/WorkflowDetailPage.tsx`, `src/components/workflows/tabs/WorkflowTriggersTab.tsx`, `src/components/workflows/triggers/WebhookQuickStart.tsx`, `src/components/workflows/triggers/CodeSnippets.tsx`
**Impact**: Follow this optional-prop-threading pattern for any feature that needs data from the detail page header to propagate into nested trigger/snippet components.

**Category**: pattern
**Learning**: `useTranslations` was introduced in `WorkflowDetailPage.tsx` for the first time (it was already used in `WebhookQuickStart` and `CodeSnippets`). The namespace is `workflows.versions` with flat key names using underscores (e.g., `state_active`, `tooltip_active`, `versionBadgeLabel`). ICU format for interpolation: `servedVia` uses `{version}`.
**Files**: `src/components/workflows/WorkflowDetailPage.tsx`, `packages/i18n/locales/en/studio.json`
**Impact**: New i18n keys for version-related UI go under `workflows.versions.*` in studio.json.

**Category**: pattern
**Learning**: `WorkflowConfigForm` now persists `workflowVersion` (semver string) on the `WorkflowConfig` type. When the user picks a version, `handleVersionChange` resolves the version ID to its semver string via `versions.find(v => v.id === versionId)?.version` and sets it on the config. When the user picks "Latest active (auto-resolve)" (empty versionId), `workflowVersion` is set to `undefined` which omits it from the DSL.
**Files**: `src/components/tools/WorkflowConfigForm.tsx`, `src/components/tools/shared-types.ts`
**Impact**: Downstream consumers of `WorkflowConfig` (e.g., tool create dialog, DSL writer) should handle `workflowVersion?: string` — absent means auto-resolve.

**Category**: pattern
**Learning**: `CodeSnippets.buildCurl()` now uses the short URL pattern `/api/v1/workflows/:wid/execute` (not the long proxy URL). Query params are built with a local `buildQuery()` helper that combines `mode` and `version` params. The status-poll URL in `async_poll` tab is version-less because the execution is already version-pinned at dispatch.
**Files**: `src/components/workflows/triggers/CodeSnippets.tsx`
**Impact**: The `projectId` parameter in `buildCurl` is now unused for URL generation (prefixed with `_`). It remains wired for backward compat but could be removed in a future cleanup.

## 2026-04-18 — Local semver comparator handles pre-release + invalid strings (GAP-007 fix)

**Category**: pattern
**Learning**: Studio's `compareSemverDescLocal` in `src/components/workflows/WorkflowDetailPage.tsx` now handles pre-release identifiers (`v1.0.0-beta` correctly orders between `v1.0.0` and `v0.99.99`) AND invalid strings (don't crash, sort after valid versions, before 'draft'). Parses semver via a regex + identifier-list parser rather than pulling in the `semver` npm dep to keep the bundle small. Matches runtime/engine `compareSemverDesc` semantics for every valid input, including pre-release ordering.
**Files**: `src/components/workflows/WorkflowDetailPage.tsx`
**Impact**: Any future version-display surfaces that sort version lists client-side should reuse this comparator (or extract to a shared helper). The regex `^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?$` is strict — 4-part versions like `v1.2.3.4` are treated as invalid.
**Superseded 2026-04-19**: the local regex parser described above was replaced by a re-export from `@agent-platform/shared-kernel`. See the 2026-04-19 entry below — the regex-based comparator no longer lives in Studio.

## 2026-04-19 — Studio semver-compare now re-exports from shared-kernel

**Category**: pattern
**Learning**: `src/lib/semver-compare.ts` is now a one-line re-export: `export { compareSemverDesc as compareSemverDescLocal } from '@agent-platform/shared-kernel'`. The local regex-based parser added 2026-04-18 is gone — Studio, runtime, and workflow-engine all go through the canonical `packages/shared-kernel/src/utils/semver-compare.ts` parser. The original bundle-size argument (avoid the `semver` npm dep) is preserved because shared-kernel's impl is zero-dep; Studio already depends on shared-kernel via other imports, so no new graph edge.
**Files**: `src/lib/semver-compare.ts`
**Impact**: Do NOT restore a local implementation. New semver comparisons in Studio UI code should import `compareSemverDescLocal` from `src/lib/semver-compare.ts` (which is this re-export) or `compareSemverDesc` directly from `@agent-platform/shared-kernel`. Keep the `Local` suffix on existing call sites for import stability.

## 2026-04-19 — WorkflowTriggersTab UX polish + canonical cron read path

**Category**: pattern
**Learning**: Trigger cards are now collapsible. The header (icon + label + badge + lifecycle actions) is always visible; the body (URL / cron / app details + `WebhookQuickStart` quick-start) renders only when `expanded` is true. `aria-expanded` + `aria-controls` on the toggle button mirror the details panel id (`trigger-details-${trigger.id}`). Other UX changes in the same pass:

- `formatCronPreset(config)` renders a human-readable summary (`"Daily at 09:00"`, `"Weekly on Monday at 09:00 (America/New_York)"`, `"Monthly on the 15th at 09:00"`, `"Once at <locale string>"`) when the server stored only the preset form without a resolved cron expression. The cron display prefers `config.cronExpression` (canonical), falls back to `formatCronPreset`, then to `"Schedule not configured"`.
- `normalizeTrigger()` falls through `rawConfig.cronExpression ?? rawConfig.expression ?? raw.cronExpression` so legacy records (with the cron on the top-level document) still surface in the UI.
- `handleFire()` fails fast when `trigger.status !== 'active'` — "Trigger is disabled. Resume it to fire." — no backend call. Previously the backend's generic error gave users no hint that the lifecycle state was the cause.
- `useSWR` now destructures `isLoading`; a Skeleton scaffold (two placeholder cards matching the real layout, with `data-testid="triggers-loading"`) renders while the initial fetch is in flight. Prevents the EmptyState flash.
- Lifecycle actions (Fire / Delete / Pause-Resume) all use `Button size="sm"` so padding and icon sizes align horizontally. Replaced the bespoke `<button>` wrappers with three `<Button variant="ghost" size="sm">` instances.
  **Files**: `src/components/workflows/tabs/WorkflowTriggersTab.tsx`
  **Impact**: New trigger card types (beyond webhook/cron/event) must follow the same collapsible pattern — put lifecycle actions in the header row, put details in the expanded body. Use `normalizeTrigger` (or extend it) when adding a config field that might arrive under a legacy top-level key. When adding a list view that uses SWR, always gate on `isLoading` with a skeleton scaffold before falling through to the empty state.

## 2026-04-18 — WORKFLOW_TABS + TRIGGER_TYPES i18n migration (H-3/H-4 fix)

**Category**: pattern
**Learning**: `WorkflowDetailPage.tsx` previously had a module-level `WORKFLOW_TABS` array with hardcoded English labels. Moved to a `useMemo([tDetail])` inside the component using `useTranslations('workflows.detail').tabs.*` keys. Same refactor for `WorkflowTriggersTab.tsx`'s `TRIGGER_TYPE_CONFIG` (display variant for legacy types) and `TRIGGER_TYPES` (creation-form picker) — separated into a label-less `TRIGGER_TYPE_META` constant (icons + variants, no copy) plus `triggerTypeLabelKey()` helper that maps to `workflows.triggers.type_*` i18n keys. Labels now computed per-render via `useTranslations('workflows.triggers')`.
**Files**: `src/components/workflows/WorkflowDetailPage.tsx`, `src/components/workflows/tabs/WorkflowTriggersTab.tsx`, `packages/i18n/locales/en/studio.json`
**Impact**: Follow this pattern for any component with a module-level constant holding user-facing strings. Separate non-locale data (icons, variants) into a module-level constant, derive labels via `useMemo([t])`.

## 2026-04-18 — ABL Contract Hardening Phase 2 (coordination contract mirrors)

**Category**: pattern
**Learning**: Studio’s ABL reference surface now picks up named `RETURN_HANDLERS` and machine-only handoff guidance from generated contract facts, not bespoke page edits. That keeps Studio’s reference UI aligned with compiler-owned coordination semantics even when the long-form spec narrative lags behind the generated facts.
**Files**: `apps/studio/content/abl-reference/contract-facts.mdx`, `apps/studio/content/abl-reference/full-specification.mdx`
**Impact**: Future ABL contract work should land in the shared registry + generated facts path first so Studio help surfaces stay current without manual MDX drift.

## 2026-04-19 — ABL Contract Hardening Phase 4 (lookup ownership authoring guidance)

**Category**: pattern
**Learning**: When a platform contract distinguishes canonical shared configuration from an experimental compatibility lane, Studio authoring should say that directly at the edit point instead of expecting users to infer it from external docs. The runtime-config lookup-table section now labels project runtime tables as canonical and agent-local `LOOKUP_TABLES` as experimental compatibility only.
**Files**: `apps/studio/src/components/settings/RuntimeConfigTab.tsx`, `packages/i18n/locales/en/studio.json`
**Impact**: Future Studio authoring surfaces for beta/experimental ABL features should add inline contract guidance where authors configure the canonical alternative, not just in reference docs.

## 2026-04-19 — ABL Contract Hardening Phase 5 (trace normalization consumers)

**Category**: architecture
**Learning**: Studio should treat dotted platform event names as an ingestion-edge concern, not as a downstream UI concern. The durable pattern is: normalize replay/live event names through `normalizeEventType()` as events enter the store, keep canonical filter defaults bound to `ALL_TRACE_EVENT_TYPES`, and let downstream interaction/presentation helpers operate on the normalized vocabulary.
**Files**: `src/store/trace-store.ts`, `src/types/index.ts`, `src/utils/observatory-event-presentation.ts`, `src/components/observatory/interactions/event-processor.ts`, `src/components/observatory/interactions/SwimLaneTimeline.tsx`
**Impact**: Future observatory/interactions work should remove dotted-name branches from downstream helpers whenever possible and add compatibility regressions at the normalization boundary instead of weakening the canonical UI types.

## 2026-04-19 — ABL Contract Hardening Phase 6 (mirrored guide integrity)

**Category**: pattern
**Learning**: Studio’s mirrored ABL guide pages need the same “standalone snippet” discipline as docs-internal. Named `ON_RETURN` examples should be self-contained, placeholder fallback routes should stay explicit machine-agent examples (for example `Clarification_Agent`, not an undefined human-ish fallback), and the Studio copy should remain byte-identical with docs-internal so authored examples do not diverge between surfaces.
**Files**: `apps/studio/content/guides/multi-agent-orchestration.mdx`, `apps/studio/content/abl-reference/multi-agent-and-supervisor.mdx`, `packages/compiler/src/__tests__/docs/phase6-doc-alignment.test.ts`
**Impact**: Future Studio docs mirror edits should update the paired docs-internal page in the same slice and keep handler/fallback examples copy-paste safe.

## 2026-04-19 — ABL Contract Hardening follow-up (handoff history authoring)

**Category**: pattern
**Learning**: Handoff-history defaults need to round-trip through the Studio authoring UI as a real contract, not as a silently dropped convenience. The safe pattern is: expose `auto` as the default choice, preserve explicit `full` and `summary_only` selections on save, and keep the DSL updater emitting the exact selected history value so the canvas does not erase intentional coordination decisions.
**Files**: `apps/studio/src/components/canvas/ConnectionTypePicker.tsx`, `apps/studio/src/components/agents/AgentListPage.tsx`, `apps/studio/src/lib/agent-canvas/dsl-updater.ts`, `apps/studio/src/__tests__/dsl-updater.test.ts`
**Impact**: Future Studio coordination controls should round-trip canonical ABL values exactly, even when a platform default exists, because lossy save behavior quickly teaches authors the wrong contract.

## 2026-04-19 — ABL Contract Hardening Phase 8 (static anatomy parity)

**Category**: process
**Learning**: The static `public/agent-anatomy/*.html` surfaces are not generated, but they still influence how authors understand the language. They need the same contract governance as the live docs because stale mock editor dropdowns and example panels can keep re-teaching removed defaults long after Studio/runtime behavior changes.
**Files**: `public/agent-anatomy/coordination.html`, `public/agent-anatomy/index.html`, `public/agent-anatomy/workflows.html`, `public/agent-anatomy/monaco-editor-wireframe.html`
**Impact**: Future coordination-contract changes in Studio should include a quick sweep of the static anatomy/demo HTML alongside real UI code, or the design reference will quietly drift from the shipped authoring surface.

## 2026-04-19 — ABL Contract Hardening Phase 10C (typed bounded history in docs + anatomy)

**Category**: pattern
**Learning**: When Studio exposes a richer authoring shape than a legacy shorthand, its docs and static anatomy need to model the structured UI mental model, not the shorthand token. For bounded handoff history, that means teaching `auto` as the default and showing the bounded option as a `last_n` mode plus a separate count, rather than reusing concrete `last_5` / `last_10` snippets.
**Files**: `content/abl-reference/multi-agent-and-supervisor.mdx`, `content/guides/multi-agent-orchestration.mdx`, `content/examples/orchestration-and-integration.mdx`, `public/agent-anatomy/coordination.html`
**Impact**: Future Studio contract changes should update both generated/mirrored docs and the static anatomy vocabulary in the same slice so the editor mental model, help content, and design references stay aligned.

## 2026-04-20 — Live Studio Screenshot Harness

**Category**: testing
**Learning**: `loginViaDevApi()` plus targeted `context.route('**/api/**')` intercepts is enough to render project-scoped screens inside the real Studio shell for report screenshots, but the Pipelines landing page also fetches `/api/projects/:projectId/pipeline-config` on first paint. If that runtime proxy path is not mocked, the page never stabilizes enough for deterministic tab screenshots even when the runs/data observability routes are mocked.
**Files**: `e2e/runtime-studio-convergence-report.ts`
**Impact**: Future Studio screenshot/report automation should mock the project list, project details, and any eagerly-loaded proxy routes for the target page instead of only mocking the visually obvious data requests.

## 2026-04-21 — Session Detail Must Hydrate Agent IR By Session, Not By Current Agent Name

**Category**: gotcha
**Learning**: Historical session detail pages cannot fetch IR from the flat `/api/runtime/agents/:name` path because that only returns the current project agent definition, not the pinned version that actually ran. The session detail hook now defers the IR fetch until the IR tab opens, but it calls `/api/runtime/sessions/:id/agent-spec?projectId=...` so runtime can resolve the session-scoped snapshot. This also avoids name/path drift when `currentAgent` is stored as a project path like `domain/AgentName`.
**Files**: `src/hooks/useSessionDetail.ts`, `src/app/api/runtime/sessions/[id]/agent-spec/route.ts`, `src/__tests__/hooks/session-hooks.test.ts`, `src/__tests__/api-routes/api-proxy-routes.test.ts`
**Impact**: Any future Studio surface that inspects a historical session's ABL/IR must fetch through a session-scoped route, not a flat agent lookup, or the UI will silently show today's agent (or nothing) instead of the pinned version from the session.

## 2026-04-21 — Historical Traces Still Arrive In Mixed snake_case/camelCase Shapes

**Category**: gotcha
**Learning**: The session-detail replay path and the execution-tree builder need to accept both canonical camelCase fields and older mirrored snake_case payload fields. `agent_name`, `tool_name`, top-level `span_id`, and payload `agent`/`tool` still appear in historical traces, and if Studio only reads `agentName`/`toolName`, child events get dropped from the tree and knowledge-base/tool nodes collapse to "unknown".
**Files**: `src/hooks/useSessionDetail.ts`, `src/lib/buildAgentTree.ts`, `src/lib/label-utils.ts`, `src/utils/replay-trace-events.ts`, `src/__tests__/buildAgentTree.test.ts`
**Impact**: When adding new trace consumers in Studio, normalize field aliases at the edge and keep at least one regression test that exercises the legacy snake_case shape. The observability store is not the only place that needs this compatibility layer.

## 2026-04-22 — Voice Provider Registry

**Category**: architecture
**Learning**: For Studio voice surfaces, keep the shared provider matrix in `@agent-platform/config` and add only a thin Studio wrapper for JSX concerns like icons, field configs, and S2S component dispatch. `VoiceServicesPage`, `speech-providers.ts`, `S2SProviderSelector`, and `S2SConfigFields` should all consume the same shared capability helpers instead of maintaining local provider lists.
**Files**: `src/components/voice/voice-provider-registry.tsx`, `src/components/admin/VoiceServicesPage.tsx`, `src/components/deployments/channels/S2SProviderSelector.tsx`, `src/components/deployments/channels/S2SConfigFields.tsx`, `src/api/speech-providers.ts`, `src/api/voice-services.ts`
**Impact**: Future provider additions should update the shared registry first, then extend the Studio wrapper only if new UI fields/components are needed.

**Category**: testing
**Learning**: Focused Studio verification for this area is fastest and most reliable with direct `vitest` file targets (`pnpm --dir apps/studio exec vitest run ...`) plus a filtered `tsc --noEmit` pass for the touched files. Going through the package `build` script can pull in unrelated `web-sdk` or repo-root checks before it reaches the changed voice components.
**Files**: `src/__tests__/speech-providers.test.ts`, `src/__tests__/s2s-provider-selector.test.tsx`
**Impact**: When refactoring small Studio surfaces, prefer direct file-targeted tests for fast proof and use full package build only when the broader workspace is known-clean.

## 2026-04-23 — Voice Pipeline STT Provider Parity

**Category**: pattern
**Learning**: Voice Services provider-field metadata needs explicit `storage` (`apiKey` vs `config`), `sensitive`, and `authProfileEligible` flags. The admin form can no longer assume every provider is a single API-key field if we want to support mixed secret/config STT vendors cleanly.
**Files**: `src/components/voice/voice-provider-registry.tsx`, `src/components/admin/VoiceServicesPage.tsx`
**Impact**: Future voice-provider additions should start by declaring field storage semantics in the Studio registry wrapper so create/edit flows, auth-profile toggles, and redacted re-open behavior stay correct.

**Category**: gotcha
**Learning**: The Studio service-instance proxy must forward `serviceType` and `isActive` query params to runtime, and channel speech-provider helpers should still re-filter `isActive` client-side. Without both layers, inactive voice providers can leak into channel dropdowns.
**Files**: `src/app/api/service-instances/route.ts`, `src/api/speech-providers.ts`
**Impact**: Any future Studio BFF route that proxies filtered runtime lists should preserve filter params explicitly and not assume the downstream default is sufficient.

## 2026-04-23 — Voice Pipeline TTS + S2S Provider Parity

**Category**: pattern
**Learning**: The Studio voice provider wrapper needs to separate three concerns cleanly: shared provider membership/capabilities stay in `@agent-platform/config`, provider-card field metadata stays in `voice-provider-registry.tsx`, and per-provider deployment widgets stay in dedicated channel field components such as `DeepgramS2SFields` and `UltravoxS2SFields`. Trying to push JSX field details back into shared config makes the registry noisy and couples Studio-only concerns into runtime consumers.
**Files**: `src/components/voice/voice-provider-registry.tsx`, `src/components/deployments/channels/DeepgramS2SFields.tsx`, `src/components/deployments/channels/UltravoxS2SFields.tsx`
**Impact**: Future provider additions should first extend the shared capability matrix, then add Studio wrapper metadata only where new UI fields or dedicated field components are actually needed.

**Category**: gotcha
**Learning**: Selector/support-message tests need to follow the shared capability copy exactly. When partial-provider messaging changed from “support pending” to “inline handoff/prompt-swap remains limited,” `S2SProviderSelector` stayed correct because it reads shared helpers, but the direct test assertion still failed. Shared support copy changes need a quick sweep of Studio selector tests and docs in the same slice.
**Files**: `src/components/deployments/channels/S2SProviderSelector.tsx`, `src/__tests__/s2s-provider-selector.test.tsx`, `src/api/voice-services.ts`
**Impact**: Any future shared capability-message change should immediately update the selector tests and related docs indexes so Studio does not keep asserting stale product language.

## 2026-04-23 — Conversation Behavior profile authoring lifecycle

**Category**: gotcha
**Learning**: Behavior-profile pages are not safe to treat as raw config-variable CRUD. If agents still reference a profile via `USE BEHAVIOR_PROFILE`, rename/delete actions must fail closed with a 409 and a `usedByAgents` payload, otherwise Studio can orphan live agent references. The create flow also needs a reserved internal route segment (for example `__new__`) instead of `/profiles/new`, or a real profile named `new` becomes impossible to open.
**Files**: `src/app/api/projects/[id]/behavior-profiles/[profileName]/route.ts`, `src/components/profiles/ProfileListPage.tsx`, `src/components/profiles/ProfileDetailPage.tsx`, `src/__tests__/api-routes/api-behavior-profile-routes.test.ts`, `src/__tests__/components/profile-list-page.test.tsx`
**Impact**: Future reusable authoring surfaces in Studio should model reference lifecycle explicitly, block destructive actions while references exist, and avoid human-readable route sentinels that can collide with real entity names.

## 2026-04-24 — ABLP-523 Parallel Tool Cards In Observatory

**Category**: architecture
**Learning**: Observatory interaction processing can still merge same-agent tool events into a single `tool_call` step, but that step must carry a normalized `toolCalls[]` child list keyed by `toolCallId` when present and otherwise by span/event identity. Both the expanded card renderer and the collapsed interaction summary need to read `toolCalls[]` instead of a single `step.data.tool`, or parallel sibling tools collapse into one visible card even though the raw event list still contains both.
**Files**: `src/components/observatory/interactions/event-processor.ts`, `src/components/observatory/interactions/ToolCallContent.tsx`, `src/components/observatory/interactions/InteractionCard.tsx`, `src/__tests__/interactions-event-processor.test.ts`, `src/__tests__/tool-call-content.test.tsx`
**Impact**: Future grouped observability steps should define an explicit child-item contract in step data before any UI summary or detail component consumes them; otherwise the processor and renderer will quietly disagree about cardinality.

## 2026-04-24 — PII Pattern Live Test Must Send Effective piiType

**Category**: gotcha
**Learning**: The Studio PII Pattern dialog’s live-test request needs the effective `piiType`, not just the regex/redaction fields currently visible in the form. Built-in override flows and runtime preview masking logic both depend on `piiType` to choose the correct recognizer/masking path; omitting it makes live preview drift from the saved pattern contract.
**Files**: `src/components/settings/PIIPatternFormDialog.tsx`
**Impact**: Any future Studio “test before save” path for built-in or server-recognized PII should send the same detection contract fields the persistence route uses, even when some of those fields are read-only in the UI.

## 2026-04-24 — Auth Profile Phase 2 Core Auth Types (Post-Impl Sync)

**Category**: architecture
**Learning**: Auth-profile authoring surfaces should derive selectable Phase 2 types from `listSelectablePhase2CoreAuthTypes('auth_profile_editor')`, and raw-connection flows must pass `consumerKind="raw_connection"` into `AuthProfilePicker` so attach-only messaging comes from the same shared contract Studio uses elsewhere.
**Files**: `src/components/auth-profiles/auth-type-metadata.ts`, `src/components/auth-profiles/AuthProfilePicker.tsx`, `src/components/connections/CreateConnectionModal.tsx`
**Impact**: Future auth-profile UI work should extend the shared support matrix instead of adding package-local allowlists or duplicating warning copy in Studio components.

## 2026-04-25 — Integration Auth Overrides Need Matching Slide-Over Mapping

**Category**: architecture
**Learning**: Enabling auth on the integrations catalog for connectors whose generated catalog says `none` or `custom` is a two-part change. `buildIntegrationProviders()` can override the exposed auth types (for example `twilio -> basic`, `amazon-s3 -> aws_iam`), but `AuthProfileSlideOver` must also map and infer those provider auth types or it falls back to the wrong editor form. Amazon S3 additionally needs the AWS IAM form prefilled with `service: 's3'` so the SigV4 profile opens in a usable state.
**Files**: `src/lib/integration-provider-service.ts`, `src/components/auth-profiles/AuthProfileSlideOver.tsx`, `src/__tests__/api-routes/auth-profiles/auth-profile-providers.test.ts`, `src/__tests__/components/auth-profile-slide-over.test.tsx`
**Impact**: Future integration-auth enablement work should update the provider override map, slide-over provider-type inference, and the focused provider/slide-over tests in the same slice.

## 2026-04-25 — Microsoft Teams Must Prefer The Azure AD Nango Alias

**Category**: architecture
**Learning**: `microsoft-teams` has a same-name Nango provider entry, but that record is `authMode: 'none'` and does not expose the Azure AD OAuth URLs Studio needs. The integration provider service must therefore prefer the shared alias mapping (`microsoft-teams -> microsoft`) when the exact-match provider is not actually OAuth-capable, rather than blindly trusting name matches.
**Files**: `src/lib/integration-provider-service.ts`, `src/__tests__/api-routes/auth-profiles/auth-profile-providers.test.ts`
**Impact**: When a connector has both an exact Nango name match and a manual alias, verify which provider actually exposes usable auth metadata before assuming the exact match is the right one.

## 2026-04-25 — Integration Auth Catalog Supports Auth-Only Virtual Providers

**Category**: architecture
**Learning**: The integrations auth catalog is no longer just a mirror of the runtime-backed connector catalog. `buildIntegrationProviders()` can append auth-only virtual providers (for example Microsoft/Azure/AWS entries), but they must also be added to `connector-categories.ts` because `IntegrationAuthTab` groups and filters by `getConnectorCategory(connectorName)`, not by the provider object's raw `category` field. Microsoft/Azure catalog entries should prefer the existing `azure_ad` auth type when available, while AWS service entries can prefill `aws_iam.service`.
**Files**: `src/lib/integration-provider-service.ts`, `src/components/connections/connector-categories.ts`, `src/components/auth-profiles/AuthProfileSlideOver.tsx`
**Impact**: Future auth-only integration providers need changes in three places together: provider assembly, category mapping, and slide-over auth-prefill inference.

## 2026-04-25 — Integration Cards Use Friendly Auth Labels, And Client-Credentials Needs Explicit Prefill

**Category**: pattern
**Learning**: The integration card header is easier to scan when it shows the display name plus friendly auth badges (`OAuth 2.0`, `Client Credentials`, `Azure AD`, etc.) instead of the old connector/category subheader. For integration authoring, `oauth2_client_credentials` cannot reuse the OAuth app prefill path automatically; it needs either `connector.oauth2.tokenUrl` or an explicit `authPrefill.oauth2_client_credentials` block, otherwise the form opens without a usable token endpoint.
**Files**: `src/components/auth-profiles/IntegrationCard.tsx`, `src/components/auth-profiles/AuthProfileSlideOver.tsx`, `src/lib/integration-provider-service.ts`
**Impact**: Future integration auth types should provide user-facing badge labels and, for client-credentials flows, explicit token URL/scopes prefill rather than assuming the OAuth app path will cover them.

## 2026-04-25 — Connections Catalog Must Stay On The Same Auth-Aware Source As Auth Profiles

**Category**: architecture
**Learning**: The Auth Profiles integrations tab and the project Connections catalog now share the same provider assembly logic. If one surface gains a new auth override, alias preference, or filtered utility connector rule, the other surface must be updated in the same slice or Studio drifts immediately. Power BI is a good example: the generated connector is `oauth2`, Nango's exact provider is non-oauth, and the correct Studio authoring experience is the existing `azure_ad` form with the Power BI resource, not a generic client-credentials form.
**Files**: `src/lib/integration-provider-service.ts`, `src/app/api/projects/[id]/connectors/route.ts`, `src/hooks/useAvailableConnectors.ts`, `src/components/connections/CatalogCard.tsx`, `src/components/connections/CreateConnectionModal.tsx`
**Impact**: Future integration-auth work in Studio should treat Auth Profiles and Connections as one coupled UX surface: update provider assembly, visible-connector filtering, card labels, and create-flow auth selection together.

## 2026-04-24 — ABLP-564 Phase 2: Pipeline save routes wired to ContractRegistry

**Category**: architecture
**Learning**: `POST /api/pipelines` and `PATCH /api/pipelines/:id` now construct a module-level `ContractRegistry` and pass it into `validateGraphPipeline`. Two subtle correctness points captured in this phase: (1) `supportedTriggers` must be resolved from `triggerSelections` BEFORE calling `validateGraphPipeline`, otherwise the compat validator sees an empty trigger list and no-ops silently — on POST the routes now resolve first, set `body.supportedTriggers`, and validate; on PATCH they merge resolved triggers onto `merged` before validation. (2) `stampContractVersions(body)` walks `body.nodes` and adds `contractVersion` from the registry before both validation and save, so newly-saved pipelines are treated strictly (not legacy) on subsequent edits. PATCH persists the stamped nodes from `merged.nodes`, not the raw `body.nodes`.
**Files**: `src/app/api/pipelines/route.ts`, `src/app/api/pipelines/[pipelineId]/route.ts`
**Impact**: Any new pipeline-mutation route must (a) resolve triggerSelections before validation, (b) call `stampContractVersions` on the body before saving graph nodes. If a node type gets a new version in `NODE_ENRICHMENT`, existing saved pipelines stay on the old version until re-saved — forcing an old contractVersion to re-validate under new rules is a future migration concern, not automatic.

## 2026-04-25 — ABLP-564 Phase 3: Destination UX + test drawer

**Category**: pattern
**Learning**: `ConfigSchemaForm` gained an `info` field renderer — takes the text from `field.description`, honors `showWhen` visibility, and styles per `field.intent` (info/warning/success/error). The `PipelineTestDrawer` now prefers `trigger.exampleOutput` for pre-filling the test payload; the old `buildTemplateFromInputSchema` key-name heuristic remains as a fallback for pipelines persisted before ABLP-564 Phase 1 (their saved `supportedTriggers[]` lacks `exampleOutput`). The drawer strips `tenantId`/`projectId` from the payload because those are injected server-side from auth context, not the test form.
**Files**: `src/components/pipelines/ConfigSchemaForm.tsx` (info renderer), `src/components/pipelines/PipelineTestDrawer.tsx` (buildPayloadForTrigger), `src/app/api/pipelines/_shared/resolve-triggers.ts` (exampleOutput plumbing)
**Impact**: When introducing a new destination option or a new conditional-help banner in `store-results` (or any node), add it as an `info` entry in `node-type-definitions.json` rather than hardcoding UI branches. Legacy pipelines saved before a Mongoose sub-schema change will show the new fields as `undefined` until re-saved — code that consumes them must tolerate missing fields (as the drawer fallback does).

## 2026-04-25 — ABLP-564 Phase 4: Run UX + re-drive

**Category**: architecture
**Learning**: Phase 4 adds three independent capabilities: (1) `pipeline-run-error-interpreter.ts` — a pure TS module with a 10-entry ordered regex catalog that maps server-side error strings to plain-English diagnosis + action type. Zero imports, fully unit-tested, extends by appending entries. (2) `StepsList.tsx` now calls the interpreter for every failed step and renders a diagnosis banner + "Open in editor" / "Re-drive" buttons. Needs `runId`, `pipelineId`, `projectId` props threaded from `RunDetailDrawer` — all three are already on the run record. (3) "Open in editor" sets `?selectedNodeId=<step.id>` on the pipeline-editor URL; `PipelineEditorPage` now reads this param on mount and polls until the pipeline hydrates, then calls `selectNode()` and removes the param via `history.replaceState`. The poll interval (100 ms) is necessary because hydration is async — a one-shot `useEffect` on pipelineData would race against the initial render.
**Files**: `src/lib/pipeline-run-error-interpreter.ts`, `src/__tests__/pipeline-run-error-interpreter.test.ts`, `src/components/pipelines/runs/StepsList.tsx`, `src/components/pipelines/runs/RunDetailDrawer.tsx`, `src/components/pipelines/PipelineEditorPage.tsx`, `src/app/api/pipelines/runs/[runId]/redrive/route.ts`
**Impact**: To extend the error catalog, append a new `CatalogEntry` to the `CATALOG` array in `pipeline-run-error-interpreter.ts` — no other files need changing. The "Re-drive" button calls `POST /api/pipelines/runs/:runId/redrive` which reads the run's stored `triggerInput` and fires a new run via Restate; runs persisted before ABLP-564 Phase 1 have no `triggerInput` and will get a 400 — the button should check this gracefully (current behavior: shows the error in the drawer).

## 2026-04-25 — ABLP-564 Phase 5: Expression editor (Monaco)

**Category**: architecture
**Learning**: P5 replaces `<textarea>` for `expressionAware: true` multiline fields with a Monaco-based `ExpressionEditor` component. Key decisions: (1) Used **Monaco** (already installed via `@monaco-editor/react`) instead of CodeMirror — avoids a new dependency and Monaco already provides autocomplete + markers + hover out of the box. (2) Used Monaco's built-in `handlebars` language for `{{...}}` syntax highlighting — correct semantic match. (3) Component is **lazy-loaded** via `React.lazy` in ConfigSchemaForm, so Monaco's ~2 MB bundle is only downloaded when an expressionAware field actually renders. (4) Expression parsing logic (`extractExpressionRefs`) extracted to `src/lib/pipeline-expression-utils.ts` — pure function with no heavy dependencies, easily unit-tested without loading Monaco. (5) Autocomplete + marker providers are registered per-mount and re-registered when the nodes list changes (via `useEffect` on the store subscription). Providers are properly disposed on unmount via `providerDisposables.current`. (6) V1 upstream-node approximation: offers ALL non-trigger, non-self nodes as autocomplete candidates (correct for linear pipelines; permissive for DAGs but markers still validate correctly). (7) `expressionAware?: boolean` added to both `ConfigField` and `ConfigFieldDefinition` interfaces in `packages/pipeline-engine/src/pipeline/types.ts`, and set to `true` on `llm-evaluate.systemPrompt` + `llm-evaluate.userPrompt` in the seed JSON.
**Files**: `src/components/pipelines/ExpressionEditor.tsx`, `src/lib/pipeline-expression-utils.ts`, `src/__tests__/expression-editor.test.ts`, `src/components/pipelines/ConfigSchemaForm.tsx` (lazy import + Suspense + currentNodeId prop), `src/components/pipelines/NodeConfigPanel.tsx` (threads currentNodeId)
**Impact**: To add a new expressionAware field: (a) set `expressionAware: true` + `multiline: true` on the field in `node-type-definitions.json` (or pass the prop programmatically), (b) the ExpressionEditor will auto-populate autocomplete from that node's upstream nodes. To add new expression pattern support (e.g. `{{pipeline.input.X}}`), update `extractExpressionRefs` in `pipeline-expression-utils.ts` and add the corresponding autocomplete branch in `ExpressionEditor.tsx`. Always test `extractExpressionRefs` in isolation (unit test in `expression-editor.test.ts`); Monaco integration tests require a real browser.

## 2026-04-25 — ABLP-564 Phase 6: Pipeline templates + template picker

**Category**: architecture
**Learning**: P6 introduces a template system for custom pipelines. Templates live in `packages/pipeline-engine/src/pipeline/templates/` as JSON files (one per template + `index.json`) — not in Mongo. `template-registry.ts` loads them at call time via `fs.promises.readFile`; the build script copies them to `dist/pipeline/templates/` alongside `seed-data/`. The Studio "New Pipeline" button now opens `TemplatePicker.tsx` (a SlidePanel component) which calls `GET /api/pipelines/templates`, and clicking a template calls `POST /api/pipelines/templates/:id/clone` which validates the definition (same path as POST /api/pipelines) and saves it. Important fix: `user-message` and `agent-message` triggers had `payload` missing from their `inputSchema.required` (only `tenantId` + `sessionId` were listed). This caused template conformance tests to fail for `per-message-guardrail` because `read-message-window` requires `payload`. Adding `payload` to both triggers' `required` array is semantically correct — Kafka message events always provide it. The compat test that expected a payload-validation error for `user-message + read-message-window` was updated to use `session-ended` instead (which genuinely lacks payload).
**Files**: `src/app/api/pipelines/templates/route.ts`, `src/app/api/pipelines/templates/[templateId]/clone/route.ts`, `src/components/pipelines/TemplatePicker.tsx`, `src/components/pipelines/PipelinesListPage.tsx`
**Impact**: Adding a new template requires: (a) a JSON file in `packages/pipeline-engine/src/pipeline/templates/`, (b) an entry in `index.json`. The conformance test (`packages/pipeline-engine/src/__tests__/templates.test.ts`) will catch any template that doesn't pass current graph validation — it runs in CI. Path traversal protection: `template-registry.ts` rejects any id with characters outside `[a-z0-9-]` and returns null; the clone route validates this by checking `safeId === id`.

## 2026-04-25 — ABLP-564 Phase 7: Live dataflow preview

**Category**: architecture
**Learning**: Live dataflow preview (P7) runs activity handlers in-process without Restate via a minimal `PreviewContext` mock: `ctx.run(name, fn)` calls `fn()` directly; `ctx.console` is a no-op; all other methods throw. `SERVICE_HANDLERS` (the type-→-handler dispatch table in `activity-router.service.ts`) was exported to avoid duplicating the handler registry. Nodes with `sideEffectClass: 'write' | 'external'` return a synthetic skip response (`{ skipped: 'preview' }`) so no real writes or external calls occur. BFS path-finding walks from `entryNodeId` → `nodeId`, accumulating `previousSteps` at each hop. Redis cache from the design spec was deferred to V2 (the preview call is idempotent and fast — read-conversation + compute nodes on a single session run in ~2-3 seconds). The Studio UI is a collapsible "Preview output" section in `NodeConfigPanel` (not a dedicated tab) — simpler and doesn't require a tab bar change.
**Files**: `packages/pipeline-engine/src/pipeline/services/preview.service.ts`, `packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts` (SERVICE_HANDLERS exported), `apps/runtime/src/routes/pipeline-observability.ts` (new POST route), `apps/studio/src/components/pipelines/NodeConfigPanel.tsx` (preview section)
**Impact**: Extending preview support to new node types is automatic (preview.service.ts pulls from the same `SERVICE_HANDLERS` table and `ContractRegistry`). Nodes that aren't in `SERVICE_HANDLERS` get synthetic skips. If a node uses `ctx.serviceClient` (only `sub-pipeline`) it will throw "not supported in preview mode" — `sub-pipeline` has `sideEffectClass: 'external'` so it's already gated. If a new node uses a different `ctx` method, the Proxy will throw with a clear error. Redis caching of preview results (5-min TTL keyed by pipeline hash + node + session) can be added as a follow-up — add a Redis `GET` before execution and `SET` after in `previewNode()`.

## 2026-04-25 — ABLP-564 Phase 8: Store Results save suggestions

**Category**: pattern
**Learning**: Store Results authoring should present the upstream data contract directly where persistence is configured. `NodeConfigPanel` now derives Save Suggestions from the selected node's direct upstream output schema: numeric fields wire ClickHouse score persistence (`storageStrategy`, `scorePath`, `scoreName`, `sourceStep`), and full upstream output wires Mongo document persistence (`documentPath`). The Available Data panel deliberately excludes trigger aliases and unrelated nodes so authors copy canonical paths like `steps.compute-quality.output.overallScore`, not legacy aliases such as `entry-read`.
**Files**: `src/components/pipelines/NodeConfigPanel.tsx`, `src/components/pipelines/ConfigSchemaForm.tsx`, `src/components/pipelines/available-data.ts`
**Impact**: Future persistence or expression helpers should derive from direct graph edges and node output schemas, not from global node lists. Destination-specific copy must distinguish ClickHouse table from MongoDB collection; stale metadata from older node definitions should be normalized at render time until all saved pipelines are re-saved.

## 2026-04-25 — ABLP-477 Model Selector Credential Readiness

**Category**: pattern
**Learning**: Agent execution model selectors should consume the same credential-readiness signal as project model settings. The durable contract is: keep existing unavailable selections visible with an explicit warning, hide no-credential models from new selection, and forward tenant-model query parameters so Studio can request the active catalog plus connection counts needed for the check.
**Files**: `src/hooks/useProjectModelOptions.ts`, `src/components/agent-editor/sections/ExecutionEditor.tsx`, `src/app/api/tenant-models/route.ts`
**Impact**: Future model picker surfaces should derive readiness from project model config plus tenant model active connection counts instead of rendering every project model by name; otherwise fresh tenants see selectable providers that runtime cannot actually execute.

## 2026-04-25 — ABLP-281 Preview Retry Must Mint A Fresh SDK Session

**Category**: gotcha
**Learning**: The share preview page must treat WebSocket retry as a new SDK session exchange, not just as reopening the widget chrome. A dropped preview socket can keep `hasEverConnected=true`, so retry and tab-visibility recovery need to check the actual WebSocket readyState, exchange the share token again, preserve callerData as userContext, and then drive `activeSdkToken` so the connection effect really reconnects.
**Files**: `src/app/preview/page.tsx`, `src/lib/preview-reconnect.ts`
**Impact**: Future preview recovery work should key reconnection off transport state plus terminal-session state, not UI-open state, and should keep the token-exchange path shared between first connect, retry, and visibility recovery.

## 2026-04-25 — ABLP-183 Debug Session State Is Wider Than Chat State

**Category**: gotcha
**Learning**: Starting a new Studio test run must reset both chat/session state and Observatory state before fetching or loading the next agent. Clearing only `useSessionStore` still leaves global Observatory events, flow, static graph, and token metrics visible until a later `agent_loaded` message, which can show the previous project’s trace/token data after project switches.
**Files**: `src/hooks/useProjectAgentSessionLauncher.ts`, `src/contexts/WebSocketContext.tsx`, `src/components/chat/ChatWithDebugPanel.tsx`
**Impact**: Future “fresh run” or project/agent scope changes should reset the complete debug-session surface immediately, not only the transcript, so the UI fails empty instead of leaking stale cross-project execution state.

## 2026-04-26 — Async Error Surfacing for Tool Metadata and Bulk Import (ABLP-579)

**Category**: pattern
**Learning**: Tool metadata background loads and Search AI orphan-source cleanup must not use swallowed `.catch(() => {})` handlers. The stable Studio contract is `console.error(...)` for developer diagnostics plus `toast.error(sanitizeError(...))` for the user, while preserving any existing success or warning toast on the main flow.
**Files**: `src/components/tools/ToolDetailPage.tsx`, `src/components/tools/ToolsListPage.tsx`, `src/components/search-ai/BulkImportForm.tsx`, `src/__tests__/components/tool-detail-page.test.tsx`, `src/__tests__/components/tools-list-page-import.test.tsx`, `src/__tests__/search-ai/bulk-import-form.test.tsx`
**Impact**: Future Studio background-effect or cleanup promises should follow this toast-plus-console reporting pattern instead of silently discarding asynchronous failures.

## 2026-04-26 — Human Task Regex Validation Guard (ABLP-578)

**Category**: pattern
**Learning**: Inbox `DynamicForm` should treat `HumanTaskFieldDef.validation` as a typed contract (`HumanTaskFieldValidation`) and only run client-side regex checks when the pattern passes the local safety heuristic and the input length stays bounded. Unsafe, invalid, or oversized regex evaluations should be skipped client-side so the server remains the source of truth for final validation.
**Files**: `src/api/human-tasks.ts`, `src/components/inbox/DynamicForm.tsx`, `src/__tests__/components/DynamicForm.test.tsx`
**Impact**: Future human-task form validation changes should extend the typed validation interface first and keep regex work behind explicit safety gates rather than compiling arbitrary metadata patterns directly in the browser.

## 2026-04-26 — Studio Tenant-Scoped Mongoose Queries

**Category**: architecture
**Learning**: Studio does not register a Mongoose tenant AsyncLocalStorage provider, so direct `find` / `findOne` queries cannot rely on `tenantIsolationPlugin` to repair missing scope. For `ServiceNode` and `AgentLock`, carry `tenantId` on the model itself and require explicit tenant-aware filters in repos/routes. For `VariableNamespaceMembership` lookups in tool save/test flows, pass both `tenantId` and `projectId` on every `findOne()` so namespace checks stay inside the current tenant.
**Files**: `src/repos/service-node-repo.ts`, `src/app/api/service-nodes/route.ts`, `src/app/api/service-nodes/[id]/route.ts`, `src/app/api/projects/[id]/locks/route.ts`, `src/app/api/projects/[id]/agents/[agentId]/lock/route.ts`, `src/app/api/projects/[id]/tools/[toolId]/route.ts`, `src/services/tool-test-service.ts`
**Impact**: Any future Studio server-side Mongo query must either include `tenantId` directly or prove scope through a verified project join before hitting Mongoose. Project-only filters are not sufficient in Studio.

## 2026-04-26 — Studio Tenant Query ESLint Lane

**Category**: process
**Learning**: Studio now has a package-local ESLint lane (`pnpm --dir apps/studio lint`) backed by `eslint.config.mjs` and `eslint-rules/no-unscoped-mongoose-query.js`. The rule intentionally targets direct database-model query calls with inline filters and treats `Deal`, `ToolTestEndpoint`, and approved project-join models (`AgentOwnership`, `ModelConfig`, `ProjectAgent`, etc.) as explicit exceptions; fixture files plus `src/__tests__/no-unscoped-mongoose-query-lint.test.ts` are the regression harness for unsafe-vs-safe behavior.
**Files**: `eslint.config.mjs`, `eslint-rules/no-unscoped-mongoose-query.js`, `eslint-rules/fixtures/no-unscoped-mongoose-query.*.ts`, `scripts/run-eslint.mjs`, `src/__tests__/no-unscoped-mongoose-query-lint.test.ts`
**Impact**: Future Studio tenant-isolation lint work should extend the custom rule and fixtures instead of adding more Claude-only hooks. Keep the rule scoped to real database model calls and add explicit allow-list entries when a model is intentionally global, public-capability keyed, or project-join scoped.

## 2026-04-26 — Model Catalog Edge Cases (ABLP-540/581/265)

**Category**: gotcha
**Learning**: Workspace API/custom tenant models may legitimately have `modelId: null`; project-level adds should bind by `tenantModelId` and synthesize a stable project `modelId` such as `tenant:<tenantModelId>` instead of rejecting or deduping all null models together. Tenant model settings that round-trip through the runtime list endpoint must include explicit `useResponsesApi` and `useStreaming` fields, and the expanded settings panel must resync local edit state when the refreshed model prop changes. Studio's HTTP tool test preview should form-encode placeholders inside `body_type: form` templates so previewed requests match runtime execution.
**Files**: `src/components/settings/ModelConfigTab.tsx`, `src/app/api/models/route.ts`, `src/components/admin/ModelsPage.tsx`, `src/app/api/tenant-models/route.ts`, `src/app/api/tenant-models/[id]/route.ts`, `src/services/tool-test-service.ts`
**Impact**: Future model catalog and tool-preview changes should treat nullable provider catalog fields as first-class and keep runtime request serialization mirrored in Studio inspection output.

## 2026-04-26 — Studio Sessions Are Project-Owned

**Category**: architecture
**Learning**: Studio chat/debug sessions are not personal workspace-user resources. They originate from a workspace user, but access to session history, traces, attachments, and debug detail is governed by `tenantId + projectId + project permission`; Runtime uses `Session.source.type === 'studio'` (or legacy `channel === 'web_debug'`) to distinguish this from public/channel sessions.
**Files**: `../runtime/src/routes/sessions.ts`, `../runtime/src/routes/attachments.ts`, `../runtime/src/services/identity/stored-session-access-source.ts`
**Impact**: Studio BFF routes should proxy Runtime session APIs and rely on project RBAC. Avoid adding `createdBy`/`initiatedById` filters to Studio session lists or detail views unless the feature is explicitly personal rather than project-scoped.

## 2026-04-27 — SOAP Tool Support Phase 3/4 (Studio UI + E2E Suite)

**Category**: testing | pattern
**Learning**: The SOAP E2E test suite (`src/__tests__/e2e/soap-tool.e2e.test.ts`) mirrors the `tool-invocations-api.e2e.test.ts` harness pattern: MongoMemoryServer + Redis subprocess + runtime process + Studio route modules + dev-login. All helpers (callStudioRoute, seedApiState, reservePort, etc.) are self-contained copies — do NOT import from the parent E2E file per E2E test isolation requirements. The SOAP stub server fixture (`fixtures/soap-stub-server.ts`) uses `express.text()` for XML body parsing (not JSON), runs two separate Express servers for SOAP 1.1 (text/xml) and 1.2 (application/soap+xml) on random ports, and captures all requests via a shared array exposed at `GET /captured-requests`. `vi.mock('server-only', () => ({}))` is the only permitted mock.
**Files**: `src/__tests__/e2e/soap-tool.e2e.test.ts`, `src/__tests__/e2e/fixtures/soap-stub-server.ts`
**Impact**: Future E2E test suites for new tool protocols should follow this pattern: (1) duplicate harness helpers rather than importing from other E2E files, (2) create a dedicated stub server fixture in `fixtures/`, (3) use random ports via `server.listen(0, '127.0.0.1')`, (4) capture requests for assertion via a `/captured-requests` endpoint.

## 2026-04-28 — SOAP Tool Support Post-ALPHA (Turbopack Workaround + Tool-Test-Service)

**Category**: gotcha
**Learning**: Turbopack's dev-server route resolver fails to match deep 6-segment App Router API paths like `/api/projects/[id]/tools/[toolId]/test`. The workaround is a two-part solution: (1) add a `TOOL_TEST_PATH_RE` regex in `src/proxy.ts` that rewrites the deep path to a flat 4-segment path (`/api/tool-test/[projectId]/[toolId]`), and (2) create a flat route handler at `src/app/api/tool-test/[projectId]/[toolId]/route.ts` that proxies auth + permissions identically to the canonical path. This is a dev-only issue — production builds resolve routes correctly.
**Files**: `src/proxy.ts`, `src/app/api/tool-test/[projectId]/[toolId]/route.ts`
**Impact**: If other deep Studio API routes fail under Turbopack, the same pattern (proxy rewrite + flat handler) can be applied. Track these workarounds so they can be removed when Turbopack fixes deep route resolution.

**Category**: pattern
**Learning**: `tool-test-service.ts` display functions should mirror wire-format behavior: (1) SOAPAction display should show the RFC-quoted form (e.g., `"http://example.com/Action"`) because that is what the server actually sends, (2) `resolveDisplayPlaceholders` must handle all placeholder namespaces consistently — `{{session.X}}` renders as `[session.key]` matching the existing `{{_context.X}}` → `[context.key]` pattern, (3) HTTP status helpers (`httpStatusText()`, `resolveDisplayStatus()`) map internal error codes to user-facing status codes (TOOL_TIMEOUT→504, TOOL_SOAP_FAULT→200, TOOL_HTTP_ERROR→502, etc.).
**Files**: `src/services/tool-test-service.ts`, `src/__tests__/tool-test-service.test.ts`
**Impact**: When adding new tool error codes or protocol-specific error handling, update the `resolveDisplayStatus()` mapping and add corresponding test assertions.

## 2026-04-28 — Arch Attachment Defaults Mirror Runtime

**Category**: gotcha
**Learning**: Arch AI uses its own attachment config resolver and upload MIME normalization in Studio, so Runtime default MIME updates do not automatically apply to Arch uploads. Keep `src/lib/arch-ai/attachment-config-resolver.ts` in sync with Runtime defaults for shared multimodal upload types such as `text/markdown`, and normalize browser `application/octet-stream` uploads by filename before UI validation, route validation, multimodal upload, or stored file metadata.
**Files**: `src/app/arch/page.tsx`, `src/lib/arch-ai/attachment-config-resolver.ts`, `src/lib/arch-ai/file-mime.ts`, `src/lib/arch-ai/file-store.ts`, `src/lib/arch/upload-files.ts`, `src/lib/arch-ai/components/arch/chat/FileAttachment.tsx`, `src/lib/arch-ai/components/arch/widgets/FileUpload.tsx`, `src/__tests__/arch-ai/file-mime.test.ts`, `src/__tests__/arch-ai/file-attachment.test.tsx`, `src/__tests__/arch-ai/arch-attachment-file-store.test.ts`
**Impact**: Future shared attachment MIME defaults need a Studio Arch surface check from picker to route to file-store, otherwise Arch can reject valid uploads before the request reaches multimodal-service.

## 2026-04-28 — ABLP-664 External Agent Autocomplete in ABLEditor

**Category**: pattern
**Learning**: ABLEditor's completion provider uses a caching pattern (useRef + TTL) for fetching tool/agent names. When adding new completion sources (external agents), follow the same pattern: (1) create a separate `useRef` cache, (2) add a parallel `loadXForContext()` async function with identical cache-check and error-handling, (3) use `Promise.all` in the completion provider to fetch all sources concurrently, (4) merge results into the `CompletionContext`. `CompletionContext.availableAgents` only accepts `Array<{ name: string }>` — no type field. The Studio proxy test uses source-string matching (`fs.readFileSync` + `expect(source).toContain(...)`) rather than vi.mock-based functional tests for route verification.
**Files**: `src/components/abl/ABLEditor.tsx`, `src/__tests__/external-agents-api.test.ts`
**Impact**: Future completion source additions (e.g., knowledge bases, workflows) should follow this same cache-ref + parallel-fetch pattern. The Studio proxy test pattern is reusable for any `withRouteHandler` + `proxyToRuntime` route verification.

## 2026-04-28 — ABLP-674 AWS Bedrock Provider Integration (LLD phase)

**Category**: gotcha

**Learning**: `AddConnectionDialog.tsx` has a Cancel button with an inline `onClick` that manually resets individual state vars (lines ~664-677). It does NOT call the central `reset()` function. Any new state variables added to the dialog (e.g., `newCredBedrockMode`) will NOT be reset when Cancel is clicked unless you also add the setter to this inline handler OR consolidate the handler to call `reset()`. The correct fix: consolidate to call `reset()` (and ensure `reset()` calls `setShowCreateForm(false)`). Avoid duplicating the state reset logic.
**Files**: `src/components/admin/AddConnectionDialog.tsx:163-185 (reset), 664-677 (inline Cancel onClick)`
**Impact**: Every future state variable added to AddConnectionDialog must be checked: is it in `reset()`? Is it in the inline Cancel onClick? Both must be kept in sync, or consolidate to `reset()` only.

**Category**: pattern

**Learning**: `RadioGroup` component at `src/components/ui/RadioGroup.tsx` supports `description` on each option (renders as small gray text below the label). Use it for contextual help text on credential mode toggles (e.g., "Running on EKS? The platform IAM role provides credential-free access."). The component accepts `direction: 'horizontal' | 'vertical'` and is built on `@radix-ui/react-radio-group` — fully keyboard-accessible.
**Files**: `src/components/ui/RadioGroup.tsx`
**Impact**: For any credential mode or feature toggle that needs contextual help text per option, `RadioGroup` with `description` is the correct pattern — no need for separate `<p>` tags below inputs.

## 2026-04-28 — ABLP-674 AWS Bedrock Provider Integration (post-impl-sync)

**Category**: process

**Learning**: LLD D-5 decided to use hardcoded English for Bedrock labels (no i18n keys) for "consistency with pre-existing hardcoded labels." This was reversed during pr-review (rounds 1 and 5) — the correct decision was to use i18n `t()` calls for all Bedrock labels. The lesson: the LLD's decision to defer i18n for consistency was wrong. When a feature spec explicitly lists `packages/i18n/locales/en/studio.json` in §10 Key Implementation Files and §13 Delivery Plan, that scope must be honored in implementation. "Consistency with existing hardcoded debt" is not a valid reason to introduce new hardcoded strings — it deepens the debt.
**Files**: `src/components/admin/AddConnectionDialog.tsx`, `packages/i18n/locales/en/studio.json`
**Impact**: Always implement i18n as specified in the feature spec §10/§13, regardless of what pre-existing strings do. If the i18n migration of pre-existing strings is out of scope, explicitly scope the i18n task to the NEW strings only.

**Category**: gotcha

**Learning**: `@agent-platform/llm` (which includes `@ai-sdk/amazon-bedrock` and `@aws-sdk/*`) must NOT be imported in Next.js client-side components. These packages pull in Node.js-only modules (node-fetch, fetch-blob) that Turbopack cannot bundle for the browser. The Studio `AddConnectionDialog` is rendered on the client. Instead, define a local const with a comment referencing the canonical export:

```typescript
// Must match BEDROCK_AMBIENT_SENTINEL in packages/llm/src/provider-factory.ts
const BEDROCK_AMBIENT_SENTINEL = '__iam_role__' as const;
```

**Files**: `src/components/admin/AddConnectionDialog.tsx`, `packages/llm/src/provider-factory.ts`
**Impact**: Any time a Studio component needs a constant from a server-side package, define it locally with a cross-reference comment. Never import server-only packages into client components.

---

## 2026-04-23 — Discovery Panel Implementation (Crawler UX)

**Category**: architecture
**Learning**: Pure utility functions in `discovery/` (tree-utils, url-set, decision-utils, console-utils, coverage-utils) must return i18n keys, NOT English strings. Rendering components call `useTranslations('search_ai.crawl_flow')` and translate at render time. Types include `messageParams`/`labelParams`/`reasonParams` for interpolation. Sub-components like `TreeNodeRow` and `BrowseItemRow` need their own `useTranslations` call — passing `t` as a prop causes type mismatches with next-intl's complex return type.
**Files**: `src/components/search-ai/crawl-flow/discovery/*.ts`, `src/components/search-ai/crawl-flow/DiscoveryTree.tsx`, `src/components/search-ai/crawl-flow/DecisionCards.tsx`
**Impact**: Any new pure utility returning user-visible text must return i18n keys. Never pass next-intl's `t` function as a prop — let each component call `useTranslations` directly.

**Category**: gotcha
**Learning**: Avoid O(n) operations in SSE progress handlers that fire every ~1s. `flattenTree()` on every progress event was O(n) for large trees. Replaced with incremental prefix tracking via a ref. Similarly, `DiscoveredUrlSet.evictLowest()` was O(n) scanning the entire Map — replaced with confidence-bucketed tracking for O(1) eviction. Always check: is this code in a hot path?
**Files**: `src/components/search-ai/crawl-flow/DiscoveryPanel.tsx`, `src/components/search-ai/crawl-flow/discovery/url-set.ts`
**Impact**: Any computation in a progress/SSE useEffect must be O(1) or O(k) where k is new items — never full-tree scans.

**Category**: pattern
**Learning**: SSE EventSource connections should implement reconnection with exponential backoff (3 retries, doubling delay from 1s to 8s). The backend SSE endpoint in search-ai already sends current progress to late-joining clients, so reconnection recovers state. Use a shared `terminalRef` flag across reconnections to prevent retry after `complete`/`error` events. Extract `attachListeners()` as a reusable function for both initial connect and retry.
**Files**: `src/components/search-ai/crawl-flow/BrowserDiscoveryInline.tsx`
**Impact**: Any future SSE-based UI must include reconnection logic — network blips are common.

**Category**: pattern
**Learning**: Unbounded React state arrays (e.g., console entries) must be capped with FIFO eviction. Cap at ~200 entries using `next.length > MAX ? next.slice(-MAX) : next` in the state updater. This prevents memory growth and re-render slowdown on long-running discovery sessions.
**Files**: `src/components/search-ai/crawl-flow/DiscoveryPanel.tsx`
**Impact**: Any accumulating state array (logs, events, messages) needs a cap.

---

**Date**: 2026-04-29
**Feature**: Agent Governance Dashboard (ABLP-698)
**Category**: architecture

**Learning**: Studio does not import from runtime packages directly. Governance type contracts are maintained as a TypeScript interface mirror in `src/lib/governance-contracts.ts`. The GOVERNANCE_METRICS and GOVERNANCE_PIPELINE_TYPES constants must exactly match the runtime's METRIC_REGISTRY (packages/database) — a divergence caused a data-flow audit CRITICAL finding. When maintaining parallel type definitions, add a comment referencing the source of truth: "// Exact ClickHouse column names — must mirror METRIC_REGISTRY in packages/database".
**Files**: `src/lib/governance-contracts.ts`
**Impact**: Any Studio contract file that mirrors runtime types needs a comment pointing to the authoritative source and must be validated at data-flow audit time.

---

**Date**: 2026-04-29
**Feature**: Agent Governance Dashboard (ABLP-698)
**Category**: pattern

**Learning**: Studio governance uses a catch-all proxy route at `src/app/api/runtime/governance/[...path]/route.ts` that forwards all governance requests to the runtime. The proxy must handle binary responses (PDF, CSV) without JSON-parsing — check `Content-Type` before calling `safeJsonParse`. Pattern: if `contentType.startsWith('application/pdf') || contentType.startsWith('text/csv')`, pipe the binary response through directly as a NextResponse with the original Content-Type and Content-Disposition headers.
**Files**: `src/app/api/runtime/governance/[...path]/route.ts`
**Impact**: Studio catch-all proxies for binary downloads must check Content-Type before JSON-parsing.

## 2026-04-28 — ABLP-155 Direct WebSocket Push (workflows-websocket-direct)

**Category**: architecture
**Learning**: `useExecutionWebSocket` manages its own WebSocket connection directly — no React context wrapper (`WorkflowEngineSocketContext`) was created. The hook is called at `WorkflowCanvasPage.tsx` L101 and returns a `WorkflowExecution | null` identical to `useExecutionPolling`, making it a true drop-in. The decision to skip the context wrapper simplified the component tree and avoided prop-drilling a context value that is only consumed by one component.
**Files**: `src/components/workflows/canvas/useExecutionWebSocket.ts`, `src/components/workflows/canvas/WorkflowCanvasPage.tsx`
**Impact**: If a second consumer of the WS execution stream appears (e.g., a sidebar or notification badge), extract a context at that point — do not pre-create it speculatively.

**Category**: architecture
**Learning**: `execution-merge.ts` contains three pure functions (`applySnapshot`, `mergeStepDelta`, `mergeExecutionDelta`) for normalizing WS messages into the `WorkflowExecution` type. These are trivially testable (19 unit tests, zero mocks) precisely because they are pure functions. The `workflowName` field was removed from `applySnapshot` — it was flowing in from the WS snapshot but was always `undefined` in the debug panel since the DB projection never included it.
**Files**: `src/components/workflows/canvas/execution-merge.ts`, `src/__tests__/execution-merge.test.ts`
**Impact**: Any new fields in the WS snapshot contract should be added to `applySnapshot` with explicit defaults and a unit test. Never assume a field is always present.

**Category**: architecture
**Learning**: `workflowEngineWsUrl` is wired through `RuntimeConfigContext` (field added at L30) and populated from `process.env.WORKFLOW_ENGINE_WS_URL` in `layout.tsx` L58 with an auto-derive fallback in `proxy.ts` L453 (replaces `http://` → `ws://`). The proxy also handles WebSocket upgrades so that in dev, Studio's Next.js proxy forwards WS connections without CORS issues.
**Files**: `src/contexts/RuntimeConfigContext.tsx`, `src/app/layout.tsx`, `src/proxy.ts`
**Impact**: For any new external WebSocket endpoint Studio needs to reach, follow the same pattern: add to RuntimeConfigContext, populate in layout.tsx, add proxy route in proxy.ts. This avoids CORS issues in dev without needing `next.config.mjs` changes.

**Category**: gotcha
**Learning**: The raw JSON panel in `WorkflowDebugPanel.tsx` previously showed the full `execution` object (including internal `_id`, `tenantId`, `context`, etc.). Changed to show `execution.context` only so the panel matches what the engine uses as its source of truth. Both the canvas side-panel (`data={execution.context}`) and monitor inline (`data={execution.context}`) were updated.
**Files**: `src/components/workflows/canvas/panels/WorkflowDebugPanel.tsx`
**Impact**: If adding new raw-data views to the debug panel, scope them to the relevant sub-object (context, output, or input) rather than the full execution document.

---

## 2026-04-30 — Crawler UI Component Architecture

**Category**: architecture
**Learning**: The web crawl UI entry point is `CrawlFlowV5` (rendered from `AddSourceButton.tsx` when the user selects web crawling from the connector catalog). CrawlFlowV5 is a multi-step slide panel that orchestrates: site profiling → discovery (HTTP or browser) → section review → configuration → crawl submission. It calls the search-ai API client at `src/api/crawl.ts` for all backend interactions. Key child components still in use: `CrawlJobForm` (configuration), `CrawlJobProgress` (real-time progress via WebSocket), `CrawledPagesView` (results), `CrawlJobHistory` (past jobs from `SourceDetailPanel`). Discovery panel components live in `src/components/search-ai/crawl-flow/discovery/`.
**Files**: `src/components/search-ai/crawl-flow/CrawlFlowV5.tsx`, `src/components/search-ai/data/AddSourceButton.tsx`, `src/api/crawl.ts`, `src/components/search-ai/crawl-flow/discovery/`
**Impact**: All new crawl UI work goes through `CrawlFlowV5`. The connector catalog in `AddSourceButton.tsx` routes web selection to CrawlFlowV5. Real-time progress uses WebSocket at `/api/admin/progress/subscribe`; discovery uses SSE proxied through search-ai.

## 2026-04-25 — Agent Assist V1 Facade — Studio surface (ABLP-390)

**Category**: architecture
**Learning**: The Agent Assist binding-management UX lives at `src/components/settings/AgentAssistSettingsPage.tsx`, registered as a top-level sidebar entry (`settings-agent-assist`, route segment `/settings/agent-assist`) — explicitly **not** nested inside Agent Transfer. The earlier draft put it under Agent Transfer; that mixed two unrelated concerns (call-center handoff vs Kore.ai widget integration) and confused operators. Pulling it out gives Agent Assist its own `settings.agent_assist` i18n namespace and lets future Agent Assist work evolve without touching the transfer flow. The page consumes Studio Next.js routes under `src/app/api/projects/[id]/agent-assist-bindings/...` which proxy to the runtime project-scoped router; SSE-bearing proxies must call `agent-assist-proxy.ts` (not `runtime-proxy.ts`) so they apply `Cache-Control: no-cache, no-transform` on the passthrough.
**Files**: `src/components/settings/AgentAssistSettingsPage.tsx`, `src/components/settings/ProjectSettingsPage.tsx`, `src/components/navigation/AppShell.tsx`, `src/components/navigation/ProjectSidebar.tsx`, `src/config/navigation.ts`, `src/store/navigation-store.ts`, `src/lib/agent-assist-proxy.ts`, `src/api/agent-assist-bindings.ts`, `src/hooks/useAgentAssistBindings.ts`, `src/app/api/projects/[id]/agent-assist-bindings/**/route.ts`, `src/app/api/v2/apps/[appId]/environments/[envName]/**/route.ts`
**Impact**: Any future settings page that integrates an external system as a sibling of "Agent Transfer" should follow the same pattern — top-level sidebar entry, dedicated i18n namespace, dedicated proxy helper if SSE is involved. Don't nest it under an unrelated existing settings page. Adding routes that pass SSE through Studio? Use `agent-assist-proxy.ts` (or a similar `no-transform`-aware helper); the generic `runtime-proxy.ts` is JSON-only.

## 2026-04-25 — Agent Assist API key UI shows the plaintext prefix, not the doc-id last-4

**Category**: gotcha
**Learning**: When showing a "fingerprint" for an API key the user has already copied, the displayable identifier MUST be the recognizable plaintext prefix (e.g. `abl_f931…`), NOT a slice of the opaque ApiKey doc UUID (`…e128`). The first time we shipped this, the table showed the doc-UUID last-4 — after a regenerate the last-4 changed but the user couldn't tell because nothing visually matched the plaintext key they'd copied to Kore.ai's widget. Fix: persist `apiKeyPrefix` on the binding (set when the key is minted/rotated by the runtime) and display it everywhere a fingerprint is shown.
**Files**: `src/api/agent-assist-bindings.ts` (`AgentAssistBinding.apiKeyPrefix`), `src/components/settings/AgentAssistSettingsPage.tsx` (table cell + Configuration modal fingerprint), `src/hooks/useAgentAssistBindings.ts`
**Impact**: Any future "show the user a non-secret fingerprint of a credential" UI must persist + display the recognizable plaintext prefix that the user actually possesses, not an internal storage id. The plaintext is shown exactly once at mint time; the prefix is the only durable thing the user can correlate against. This pattern applies to any per-binding / per-credential surface (e.g. SDK API keys, webhook signing keys).

## 2026-05-03 — Auth Profile Validate Endpoint (ABLP-619)

**Category**: architecture
**Learning**: The validate endpoint (`POST /api/[projects/:id/]auth-profiles/:profileId/validate`) delegates to `_piece-auth-validator.ts` which holds `BUILT_IN_LIVE_CHECKS` — a 28-entry `Record<string, LiveCheckFn>` keyed by connector slug. The DI pattern uses `RunPieceAuthValidateDeps` (an interface passed into the handler) so tests can inject a stub AP piece without mocking module imports. The endpoint returns `{ valid: boolean, validationMethod: 'live' | 'structural' | 'optimistic', message: string }`. Connectors with no `BUILT_IN_LIVE_CHECKS` entry fall through to structural (Zod schema check) or optimistic (returns `valid: true` when structural also fails). On success, the handler writes `lastValidatedAt: new Date()` to the profile document and returns the updated timestamp in the response body.
**Files**: `src/app/api/auth-profiles/_piece-auth-validator.ts`, `src/app/api/auth-profiles/[profileId]/validate/route.ts`, `src/app/api/projects/[id]/auth-profiles/[profileId]/validate/route.ts`
**Impact**: Adding a new live check: add a new `LiveCheckFn` entry to `BUILT_IN_LIVE_CHECKS` in `_piece-auth-validator.ts`. Do NOT add it to the route handler directly. The test file `auth-profile-piece-validate.test.ts` has a test group per connector slug — add a matching group for any new entry. The project-scoped validate route requires `StudioPermission.AUTH_PROFILE_WRITE` (`auth-profile:write`), so only OWNER/EDITOR roles can call it.

**Category**: gotcha
**Learning**: `dev-login` grants `role: 'OWNER'` to every authenticated user in the dev environment. This means 403-via-permission-mismatch cannot be reproduced in E2E tests that use `dev-login` for user2. The personal-profile isolation (404 for non-creator) IS testable because `ensureUsableAuthProfile` checks `profile.createdBy === actor.id`, not the RBAC role. When writing E2E tests for endpoints that gate on RBAC, use visibility/ownership isolation to verify access boundaries instead.
**Files**: `src/app/api/auth/dev-login/route.ts`, `src/app/api/auth-profiles/_auth-profile-route-utils.ts`
**Impact**: Do not write E2E tests that expect a 403 from permission mismatch when using dev-login — they will never fail because dev-login always grants OWNER. For personal-resource isolation, test the creator vs non-creator pattern (which returns 404) instead.

## 2026-05-03 — Integration Auth Profiles: GAP-008/009 fixes + cascadeDeleteBridge extraction (ABLP-619)

**Category**: architecture
**Learning**: `cascadeDeleteBridge` was extracted to `src/app/api/auth-profiles/_bridge-cascade.ts` as a pure function with injectable deps (`deleteOne` + `log`). Both the project-scoped and workspace-scoped DELETE routes call it via `cascadeDeleteBridge({ profileId, tenantId }, { deleteOne: ..., log })`. This pattern (extract side-effecting operations to pure functions with DI) makes the function testable without any module mocks — the test file (`auth-profile-bridge-cascade.test.ts`) passes in simple stub objects. Apply this pattern any time a route handler contains a non-trivial side effect that needs unit testing.
**Files**: `src/app/api/auth-profiles/_bridge-cascade.ts`, `src/app/api/auth-profiles/[profileId]/route.ts` (DELETE), `src/app/api/projects/[id]/auth-profiles/[profileId]/route.ts` (DELETE), `src/__tests__/auth-profile-bridge-cascade.test.ts`
**Impact**: If adding new cascade operations to DELETE routes, follow `cascadeDeleteBridge`'s pattern: extract a pure function in the `_bridge-cascade.ts` file (or a similar `_*.ts` file), inject real model methods at the call site, and add unit tests for all error paths.

**Category**: gotcha
**Learning**: GAP-008 fix — when the `oauth2_client_credentials` validate route encounters an SSRF-blocked tokenUrl, returning a hard 400 is wrong because it conflates a security policy decision with a credential validation failure. The correct response is a soft structural failure: `{ valid: false, validationMethod: 'structural', message: 'Token endpoint blocked by SSRF policy' }`. The caller receives a 200 with `valid: false`, which is semantically correct ("your credentials are structurally invalid") and does not surface a confusing SSRF error to the operator.
**Files**: `src/app/api/auth-profiles/[profileId]/validate/route.ts`, `src/app/api/projects/[id]/auth-profiles/[profileId]/validate/route.ts`
**Impact**: Any validate-style endpoint that calls an external URL should catch SSRF errors and return structural failure (200 + `valid: false`), not a 400. A 400 implies the caller sent bad input; SSRF is a security policy gate, not a client error.

**Category**: architecture
**Learning**: GAP-009 fix — auth types without a live-check path (`bearer`, `azure_ad`, `basic`, `aws_iam`) return `validationMethod: 'optimistic'` with `valid: true`. To prevent silent false positives, the route now also returns `warning: 'Credential shape looks valid, but no live check was performed — outcome is not confirmed'`. E2E-21 asserts `warning` is truthy. Any future endpoint that returns an "assumed-valid" result without real verification should include a `warning` field.
**Files**: `src/app/api/auth-profiles/[profileId]/validate/route.ts`, `src/app/api/projects/[id]/auth-profiles/[profileId]/validate/route.ts`
**Impact**: Follow the `warning` field convention for all optimistic/assumed results. Callers (UI, SDK) should surface the warning in a non-blocking way (tooltip, secondary text) so operators know the result is unconfirmed.

**Category**: ui
**Learning**: Test Credentials button added to `AuthProfileSlideOver.tsx` footer — only shown in edit mode (`isEdit && ...`), disabled when `isLegacyReadOnly` or `saving`, uses the `testing` state boolean to show a loading spinner. Routes to `validateAuthProfile` (project scope) or `validateWorkspaceAuthProfile` (workspace scope). The `isLegacyReadOnly` flag (`legacyMigration?.status === 'legacy_read_only' || isLegacyCreateFlow`) is the canonical gate for disabling write-adjacent actions on migration records.
**Files**: `src/components/auth-profiles/AuthProfileSlideOver.tsx`, `src/api/auth-profiles.ts` (`validateAuthProfile`, `validateWorkspaceAuthProfile`)
**Impact**: The `isLegacyReadOnly` + `isEdit` guard pattern should be reused for any future actions that are only applicable in edit mode and must be blocked for migration profiles.

---

### 2026-05-06 — A2A Spec 1 (ABLP-162): External-Agent Executor + Polish Layer

**Category**: arch-ai tools / chat UI / event dispatcher

**Learning 1 — Specialist UI atoms (Badge / Chip) share `specialist-style.ts` to prevent drift.**
`SpecialistBadge.tsx` and the new `SpecialistChip.tsx` (compact ~24px pill in `ArchHeroStrip`) both import `ICON_MAP`, `ROLE_STYLES`, `FALLBACK_STYLE` from `lib/arch-ai/components/arch/chat/specialist-style.ts`. Future specialist UI variants should import from the same module — never copy the maps. Use `clsx()` for className composition (the convention `ExternalAgentCard.tsx` documents in its header), not template-literal interpolation.

**Files**: `src/lib/arch-ai/components/arch/chat/{specialist-style.ts, SpecialistBadge.tsx, SpecialistChip.tsx, ArchHeroStrip.tsx}`.

**Learning 2 — Specialist transition narration uses a two-step setState pattern.**
In `event-dispatcher.ts case 'specialist'`: capture `prevSpecialist` BEFORE `setState`, then dispatch the state change, then emit narration only on a non-trivial transition (prev !== next AND a prior assistant message exists). If you skip the capture-before-setState ordering, the narration always reads the new value and never fires. The narration goes through `appendStatusMessage()` on the Zustand store (canonical `StatusMessage` type lives in `lib/arch-ai/ui/types.ts` and has a required `timestamp` field).

**Files**: `src/lib/arch-ai/ui/event-dispatcher.ts`, `src/lib/arch-ai/ui/store.ts`, `src/lib/arch-ai/ui/types.ts`.

**Learning 3 — `external_agent_ops` Studio executor is a CRUD proxy, not a runtime client.**
The executor in `lib/arch-ai/tools/external-agent-ops.ts` calls `apiFetch` to existing `/api/projects/:id/external-agents/...` Studio routes — those proxy to runtime. The exception is `discover_preview`, which fetches the AgentCard directly using `assertUrlSafeForSSRF` + `redirect: 'manual'` + 256KB streamed cap. The streaming cap (R5 H-4) uses `res.body?.getReader()` + per-chunk total byte check + `reader.cancel()` on overflow — NEVER `res.text()` before checking length, or a malicious endpoint omitting Content-Length OOMs the pod. `synthesizeHandoffBlock` runs `sanitizeFreeText()` on description/skill names (strips `<script>`, all HTML tags, control chars, caps at 500 chars) before embedding in DSL — caught by Phase 3 latent test.

**Files**: `src/lib/arch-ai/tools/external-agent-ops.ts`.

**Learning 4 — Knowledge-card SSE variant requires 5-place wiring.**
Adding `external_agent_card` (or any new kbCards variant) needed coordinated edits across:

1. `packages/arch-ai/src/types/sse-events.ts` (`ExternalAgentCardEventSchema` + add to `ArchSSEEventSchema` discriminated union + export type)
2. `packages/arch-ai/src/types/turn-events.ts` (variant enum)
3. `packages/arch-ai/src/types/index.ts` + root `index.ts` (re-export)
4. `apps/studio/src/lib/arch-ai/ui/event-dispatcher.ts` (`case 'external_agent_card'` switch arm)
5. `apps/studio/src/lib/arch-ai/components/arch/cards/index.ts` (`KB_CARD_MAP` registration)

Forget any one and the variant either won't type-check or will silently fall through to the default render path.

**Learning 5 — lint-staged stash/restore silently reverts unstaged work — write commit messages to `/tmp/<file>.txt` and use `git commit -F`.**
A heredoc inside `git commit -m "$(cat <<EOF ... EOF)"` can be re-parsed by lint-staged's pre-commit harness in unexpected ways. The reliable pattern is `cat > /tmp/msg.txt <<'EOF' ... EOF; git commit -F /tmp/msg.txt`. This was used for every Spec 1 commit to avoid losing work on hook failures.

## 2026-05-06 — Arch AI Agent Edit Validation

**Category**: gotcha
**Learning**: Arch AI agent rename validation has to compile the planned post-rename project graph, including sibling handoff rewrites from the old agent name to the proposed new name. Validating the renamed agent against unchanged siblings creates a false missing-handoff-target block before the real apply path can perform its cascade.
**Files**: `src/lib/arch-ai/tools/in-project-tools.ts`, `src/__tests__/arch-ai/agent-edit-runtime-validation.test.ts`
**Impact**: Future Arch AI edit gates should compare before/after project health and only block target-agent or newly introduced compile errors. Pre-existing unrelated sibling compile/tool-binding errors should be surfaced as warnings so small safe edits are not hostage to stale project debt.

**Category**: pattern
**Learning**: Studio tool URL validation can allow unresolved `{{env.X}}` / `{{secrets.X}}` placeholders only when the literal URL prefix is safe. Placeholder-only endpoints such as `{{env.TOOL_BASE_URL}}/events` are saved for runtime resolution, but literal unsafe prefixes such as `http://169.254.169.254/{{env.PATH}}` still run through SSRF validation and fail closed.
**Files**: `src/lib/resolve-and-validate-url.ts`, `src/lib/tool-creation-service.ts`, `src/lib/arch-ai/tools/tools-ops.ts`, `src/app/api/projects/[id]/tools/route.ts`, `src/app/api/projects/[id]/tools/[toolId]/route.ts`, `src/app/api/projects/[id]/tools/import/route.ts`
**Impact**: New Studio tool creation/import/update paths should opt into unresolved runtime URL placeholders deliberately and should preserve the literal-prefix SSRF check instead of bypassing validation based on error-message text.

**Category**: gotcha
**Learning**: Agent identity parsing in Arch AI edit/apply paths must handle both `AGENT:` and `SUPERVISOR:` declarations. Rename comparison baselines should normalize the "before" graph into the proposed post-rename names before diffing diagnostics, and new-agent proposals must reject mismatches between the requested target name and the ABL declaration.
**Files**: `src/lib/arch-ai/tools/in-project-tools.ts`, `src/__tests__/arch-ai/agent-edit-runtime-validation.test.ts`, `src/__tests__/arch-ai/propose-apply-modification-fixups.test.ts`
**Impact**: Future agent edit scenarios should include ordinary agent rename, supervisor rename, rename with pre-existing diagnostics, and `isNew` declaration mismatch coverage. Otherwise identity drift can pass validation but write inconsistent DB records.

**Category**: pattern
**Learning**: In-project agent modification proposals should distinguish "cannot safely apply this edit" from "can apply, but will not be runtime-ready yet." Missing ProjectTool bindings from the resolver (`E721`) and project diagnostics (`T-04`) are runtime-readiness warnings: keep the proposal successful, set `impact.runtimeReady = false`, include `impact.tools.unresolved`, and add a next action telling the user to create/link the ProjectTool before production traffic. Do not block the edit just because the user may create the tool in a later step.
**Files**: `src/lib/arch-ai/tools/in-project-tools.ts`, `src/__tests__/arch-ai/agent-edit-runtime-validation.test.ts`, `src/__tests__/arch-ai/in-project-tools-topology.test.ts`
**Impact**: Future validation gates should only hard-block parse errors, target-agent/new compile regressions, broken cross-agent topology, or diagnostics that would make the proposed graph inconsistent. Deferred integration work belongs in proposal impact and warnings so Arch can explain the tradeoff, ask for confirmation, and then act based on the user's choice.

**Category**: pattern
**Learning**: Rename proposals now produce explicit cascade impact before apply. `propose_modification` reports `impact.rename` with the old/new names, affected sibling agents, per-agent reference counts, and topology added/removed edges after planned handoff rewrites. The apply step still needs user confirmation, but the proposal should explain that sibling handoff references will move from the old agent name to the new one.
**Files**: `src/lib/arch-ai/tools/in-project-tools.ts`, `src/__tests__/arch-ai/in-project-tools-topology.test.ts`
**Impact**: Any future agent-identity edit should expose its cross-agent mutation radius in the proposal payload first. The user asked for "rename X" but the real action may include "also update A, B, C references"; Arch must make that visible before applying.

## 2026-05-11 — Eval Retention Settings Surface

**Category**: gotcha
**Learning**: Adding a new `ProjectPage` settings leaf requires updates beyond the sidebar: `navigation-store.ts`, `ProjectSidebar.tsx`, `config/navigation.ts`, `AppShell.tsx`, `lib/project-pages.ts`, and i18n nav labels. The `PROJECT_PAGES` exhaustiveness check fails the production build if the runtime inventory is missed.
**Files**: `src/store/navigation-store.ts`, `src/components/navigation/AppShell.tsx`, `src/components/navigation/ProjectSidebar.tsx`, `src/config/navigation.ts`, `src/lib/project-pages.ts`
**Impact**: Treat project settings navigation as a multi-file contract. Run the Studio build after adding a leaf because TypeScript catches missing inventory wiring.

**Category**: testing
**Learning**: Tenant-only Studio API e2e tests can avoid the full runtime harness by mounting only the needed Next route handlers behind a minimal Express adapter. This keeps the test HTTP-only while avoiding unrelated runtime package resolution failures.
**Files**: `src/__tests__/eval-retention-api.e2e.test.ts`
**Impact**: For workspace/tenant APIs that do not call runtime, prefer a small route harness over `startStudioApiHarness()` when the full harness adds irrelevant dependencies.

## 2026-05-13 — Marketplace Install Flow E2E Tests

**Category**: testing
**Learning**: E2E tests for template install flows must handle multiple possible backend states gracefully. Install operations create real database entries, so tests use `Date.now()` in project names for uniqueness. The agent install flow is a multi-dialog chain (detail page -> project selector -> preview -> confirm) where each transition requires re-querying `page.getByRole('dialog')` since the previous dialog is replaced. Use `test.skip()` inside test bodies when prerequisite state is unavailable (e.g., no projects for agent install). Tab selectors should use `.or()` fallback (`getByRole('tab')` or `getByText()`) since the Tabs component may not use native `role="tab"`.
**Files**: `e2e/marketplace-install.spec.ts`
**Impact**: Future marketplace E2E tests should follow the same graceful-skip pattern for backend-dependent flows. Template slugs (`hr-onboarding`, `customer-service-agent`) must match the seed script in `apps/template-store/src/scripts/seed-templates.ts`.

## 2026-05-16 — Draft Elimination T-6: Wizard Component Refactor

**Category**: refactoring, crawl-flow
**Learning**: When replacing CrawlDraft API calls with source-based APIs in the crawl wizard:

- `updateCrawlConfig` API takes `Record<string, unknown>` for sections/auth/settings — typed interfaces like `CrawlDraftSection[]` need explicit `as unknown as Array<Record<string, unknown>>` casts. The `sectionsToRecords()` wrapper centralizes this.
- The `CrawlConfig` type name conflicts between `types.ts` (UI crawl settings) and `search-ai.ts` (source crawlConfig subdocument). Import the UI one from `./types` and reference the API one via `SearchAISource['crawlConfig']`.
- Discovery state is now in a separate `SourceConfigState` collection — saving requires `updateDiscoveryState()` (PUT endpoint) rather than a field on the crawl config PATCH.
- `DomainCheckResult` type still has `draftId` from the `checkDomain` endpoint — global renames can accidentally hit it. Use grep to verify after bulk renames.
- `fetchSources(indexId)` returns all sources — when resuming a specific source, filter client-side. Consider adding a single-source GET endpoint for efficiency.
  **Files**: `CrawlFlowV5.tsx`, `State1UrlEntry.tsx`, `State2Analysis.tsx`, `types.ts`
  **Impact**: T-7 (SourcesTable) and T-8 (cleanup) depend on these renames being stable. The `CrawlDraftSection` type and old draft API functions are still exported from `api/crawl.ts` — T-8 removes them.

## 2026-05-16 — Governance Feature Gate

**Category**: pattern
**Learning**: Governance feature gating is Studio-only: `/api/features` exposes `governance`, `useFeatures()` returns `hasGovernance`, and Studio hides sidebar/search/direct page rendering when false. The governance proxy and Runtime APIs remain ungated.
**Files**: `src/app/api/features/route.ts`, `src/hooks/use-features.ts`, `src/components/navigation/ProjectSidebar.tsx`, `src/components/navigation/UniversalSearch.tsx`, `src/components/navigation/AppShell.tsx`
**Impact**: For discoverability-only flags, hide every Studio navigation entry point without adding BFF or Runtime API enforcement.

## 2026-05-17 — Arch Model Policy Bootstrap Uses Narrow Export

**Category**: pattern
**Learning**: Studio Arch bootstrap model defaults should import `selectArchModelPolicyDefaults` from `@agent-platform/arch-ai/model-policy`, not the Arch package root. The root export can initialize broader generation modules in Studio unit tests; the model-policy subpath keeps project/tenant model default selection isolated.
**Files**: `src/lib/arch-ai/model-policy-defaults.ts`, `src/__tests__/lib/arch-model-policy-defaults.test.ts`, cross-reference `packages/arch-ai/src/model-policy.ts`
**Impact**: Future Studio model bootstrap changes should keep candidate collection local to Studio, but delegate tier/capability selection to Arch policy so support defaults remain non-reasoning and reasoning/research remains opt-in.

## 2026-05-17 — Arch setup errors are builder diagnostics

**Category**: user-facing diagnostics
**Learning**: `src/lib/arch-ai/engine-factory.ts` throws the message that Arch's turn engine later classifies and forwards through Studio error events. This surface is for the agent builder, so the fallback should be technically actionable ("Arch model configuration is incomplete") while still avoiding raw credential, tenant, or internal resolution detail. The classifier ignores raw model-config messages for the final emitted text, but Studio should still seed a useful setup diagnostic at the throw site.
**Files**: `src/lib/arch-ai/engine-factory.ts`, cross-reference `packages/arch-ai/src/engine/error-classifier.ts`
**Impact**: When adding Arch setup/configuration checks, keep raw provider/model details in logs or trace metadata only. Studio-visible messages can use technical categories, but they must stay sanitized and actionable.

## 2026-05-17 — Topology APIs should preserve edge experience metadata

**Category**: data propagation
**Learning**: `/api/projects/[id]/topology` is a production topology surface, not just a mini-map helper. When compiler app graph connections include fields like `experienceMode`, `returns`, and `when`, the route should forward them instead of collapsing delegate edges to generic routing. The agents list mini-topology types must accept the same fields even if the compact visual does not render every one yet.
**Files**: `src/app/api/projects/[id]/topology/route.ts`, `src/components/agents/AgentListPage.tsx`, `src/components/agents/AgentMiniTopology.tsx`, `src/types/arch.ts`, `src/lib/arch-ai/types/arch.ts`, `src/__tests__/api-routes/api-topology-route.test.ts`
**Impact**: Future topology additions should update the API response type, shared UI topology types, and route parity tests together so Arch/runtime topology intent is not silently flattened before the UI can render it.

## 2026-05-17 — Playwright Failure Timeout Ceiling

**Category**: testing
**Learning**: Studio Playwright configs should keep per-test timeouts explicit and capped at 180s. Config-level timeouts alone do not cap specs that call `test.setTimeout(...)`; long overrides in `apps/studio/e2e/**` must also stay at or below 180_000ms so failures surface promptly.
**Files**: `playwright.config.ts`, `e2e-playwright.config.ts`, `e2e-env.config.ts`, `e2e/softphone-automation-runner.ts`, `e2e/**/*.spec.ts`
**Impact**: When adding long E2E coverage, prefer targeted waits inside the test and keep any `test.setTimeout(...)` override at 180_000ms or lower. Do not reintroduce 5-10 minute Playwright test budgets without a separate runner lane.

## 2026-05-17 — MCP-Facing ABL Diagnostics Live Server-Side

**Category**: architecture
**Learning**: MCP tools are distributed independently from the platform, so ABL package validation, compiler-model discovery, design linting, and transcript failure diagnosis should live in Studio APIs and use the platform's real compiler/diagnostics stack. MCP wrappers can improve UX for updated clients, but stale clients still need server-owned `debug_docs` content and normalized API error bodies to make the contract discoverable.
**Files**: `src/app/api/abl/package/**`, `src/lib/abl-package-analysis.ts`, `content/abl-reference/*.mdx`
**Impact**: Future ABL repair workflows should add platform endpoints first, then wrap them from MCP so operators can loop over traces, eval results, best-practice diagnostics, and agent-definition patches. Keep docs generation (`pnpm abl:docs:generate`) in the implementation loop because Studio/docs builds run `abl:docs:check` as a drift gate, not an automatic generator.

---

## ABLP-932 — HTTP Tool Non-2xx Response Body (2026-05-19)

**Category**: tool test service + UI state
**Learning**: `tool-test-service.ts` loads `ToolBindingExecutor` via `await import('@abl/compiler/platform/studio-exports.js')` — a standard dynamic import that webpack traces. Because `@abl/compiler` is in `serverExternalPackages`, it loads from the compiled `dist/` at runtime, NOT the TypeScript source. Any changes to `@abl/compiler` source require `npx turbo build --filter=@abl/compiler` followed by a Studio restart to take effect.
**Files**: `src/services/tool-test-service.ts`, `src/store/tool-store.ts`, `src/components/tools/TestToolDialog.tsx`, `src/components/tools/ToolTestPanel.tsx`
**Impact**: `ToolTestResult` (store type) and `ToolTestOutput` (service type) must stay in sync — if you add a field to the service output, add it to the store type too or the UI components will fail the TypeScript build. The tool test UI has three states: Success (green), HTTP Error Response (amber — `httpError: true`), and Execution Error (red — `error` string set).

---

## ABLP-1123 — Auth-profile slide-over schema projection + footer actions

**Category**: pattern | gotcha
**Learning**: Auth-profile slide-over save uses a schema-driven projection. `buildSaveConfig` filters `config` through `getAllowedConfigKeys(authType)` so only keys the backend Zod schema accepts ever ship. Any UI state key not in the schema is silently dropped at the boundary. Type-aware composition steps (OAuth URL inline, oauth2_client_credentials tokenUrl template resolve, connectionConfig forward) happen AFTER projection and only write keys the schema accepts. Footer layout: Re-authorize/Authorize left (OAuth only), Test + Save right. Save is disabled until `isDirty` flips true (any change handler), and re-disabled after successful save.
**Files**: `src/components/auth-profiles/AuthProfileSlideOver.tsx` (`buildSaveConfig`), `src/components/auth-profiles/AuthProfileImpactModal.tsx`
**Impact**: Adding a new field to a UI form — declare it in the auth-type Zod schema too, otherwise projection drops it silently at save. The unified `AuthProfileImpactModal` handles disable/revoke/delete; do not add a new bespoke confirm dialog for a fourth destructive action — extend `ImpactAction` instead.

## 2026-05-15 — Document-Extraction Integrations Studio Surface (Phase 2-3) — ABLP-1073

**Category**: pattern
**Learning**: Docling + Azure Document Intelligence live on the existing Connections page (`/projects/:projectId/connections`, header label "Integrations"). The connection itself is the enable/disable binding — there is no separate "Document Extraction" settings tab. Connector-specific operational panels (rate-limit, monthly usage caps) render inside `ConnectionExpandPanel` when the user expands the relevant connection, gated by `connection.connectorName`. The BFF proxies under `/api/projects/[projectId]/integrations/*` forward to the workflow-engine `projectRouter` and back the new in-panel views (`DoclingQuotaView`, `AzureDIUsageView`). The Integration Picker on the workflow canvas auto-gates from the connection collection (no static catalog rebuild needed). i18n keys live under the `studio.integrations.*` namespace. Quota PATCH calls send `Content-Type: application/json`.
**Earlier mistake (corrected)**: An initial pass added a parallel Settings → Document Extraction page (`settings-integrations` nav id + `IntegrationsSettingsTab` + an enable/disable toggle) on top of the Connections page that already covered the same thing. This duplicated the front door and forced the toggle state and the connection lifecycle to be kept in sync. Deleted the page and merged the operational UI into `ConnectionExpandPanel`.
**Files**: `src/components/projects/DoclingQuotaView.tsx`, `src/components/projects/AzureDIUsageView.tsx`, `src/components/connections/ConnectionExpandPanel.tsx`, `src/app/api/projects/[projectId]/integrations/**/route.ts` (BFF proxies — unchanged).
**Impact**: One place for the user — the connection card. Rate-limit and usage-cap admin surface as connector-specific panels. New extraction connectors follow the same pattern: add a per-connector panel in `ConnectionExpandPanel` keyed off `connectorName`.

## 2026-05-17 — auth.type='none' picker hide + sentinel auto-bind — ABLP-1073

**Category**: pattern
**Learning**: For connectors with `auth.type='none'` (Docling, future no-auth integrations), the Studio Integration node MUST NOT show an Auth Profile picker — there's nothing to pick. But the workflow-engine expects a `connectionId` on every step. Convention: `IntegrationNodeConfig.tsx:152-158` auto-binds the synthetic sentinel `system-<connector>-none` whenever the catalog connector's `authType === 'none'`. The `useEffect` at L205-211 ALSO backfills the sentinel for nodes saved BEFORE this UI knew about the sentinel pattern. The same UI behavior is mirrored in `TestActionModal.tsx` so the Test Action modal hides its picker for sentinel connections. Both client regexes (`TestActionModal.tsx:93`) must match the server resolver regex (`packages/connectors/src/auth/connection-resolver.ts:114`) — currently both `^system-[a-z0-9-]+-none$`.
**Files**: `src/components/workflows/canvas/config/IntegrationNodeConfig.tsx:140-211`, `IntegrationPickerModal.tsx:25-32` (`CatalogConnector.authType` field), `TestActionModal.tsx:89-94`.
**Impact**: When adding a new `auth.type='none'` connector, no UI changes needed — the picker auto-hides + sentinel auto-binds based on catalog metadata alone. If a future connector uses uppercase or non-`[a-z0-9-]` chars in its name, the sentinel regex will reject it and the picker will surface — tighten the connector name to match the registry convention.

## 2026-05-17 — Auth-profile POST/PATCH live-validate after save — ABLP-1073

**Category**: pattern
**Learning**: Connector-bound credential profiles MUST be live-validated against the provider AFTER saving — otherwise a user can save an Azure DI profile with a wrong subscription key and the failure only surfaces at the first workflow run. Pattern mirrors the existing `oauth2_client_credentials` inline-grant flow: after the save/persist completes, call `runPieceAuthValidate({profile, decryptedSecrets})`. On `{valid: false}`, roll back the row (POST: `deleteOne` + delete bridge `ConnectorConnection`; PATCH: revert `encryptedSecrets`/`config`/`linkedAppProfileId` to the pre-save snapshot, then re-save). Skip for OAuth flows (own lifecycle) and `auth.type='none'` (nothing to validate). Both POST and PATCH paths must apply IDENTICAL skip rules to avoid asymmetry.
**Files**: `src/app/api/projects/[id]/auth-profiles/route.ts:462-505`, `src/app/api/projects/[id]/auth-profiles/[profileId]/route.ts:342-387`.
**Impact**: Any new connector with a `validateAuth` hook automatically gets this protection — the routes detect the hook via `runPieceAuthValidate`. If you add a new authType that should ALSO skip validation, update the skip rules in BOTH POST and PATCH together — asymmetry is a maintenance risk flagged in data-flow audit F-V1-1.

## 2026-05-17 — Studio /execute must tolerate empty body — ABLP-1073

**Category**: pattern
**Learning**: Studio's workflow Run button POSTs `/execute` with no body. The route handler previously called `await request.clone().json()` which throws `SyntaxError: Unexpected end of JSON input` on empty payload. Read as text first, parse only if non-empty, default to `{}`. The downstream workflow-engine Zod schema accepts empty `{}` for studio-triggered runs.
**Files**: `src/app/api/projects/[id]/workflows/[workflowId]/execute/route.ts:18-34`.
**Impact**: When adding new request-body parsing anywhere in studio API routes, default to the text-then-parse pattern — `.json()` on an empty request body always throws.

---

## 2026-05-21 — ABLP-1073: Canvas Edge Computation and Step Status Display

**Category**: pattern | gotcha

**computeExecutionEdges — canvasNodeType fallback**:

- `human` (approval) and `data_entry` both compile to engine type `human_task`. `step.nodeType` cannot distinguish them.
- Fix: `getTakenHandle(step, canvasNodeType?)` — pass `nodeById.get(step.stepId)?.data.nodeType` as the canvas type. `canvasNodeType ?? step.nodeType` resolves correctly.
- `data_entry` → `on_success`/`on_failure` handles. `human`/`human_task` → `on_approve`/`on_reject`.
- Always use canvas `data.nodeType` as authoritative — it's never converted to engine type.

**StepLogItem — add status cases when extending the status union**:

- Adding to `ExecutionStepResult['status']` in `api/workflows.ts` requires matching cases in `StepLogItem.tsx` `getStatusDisplay()` and icon logic.
- `rejected` → XCircle red, error badge. `approved` → CheckCircle2 green, success badge.
- Also update `DONE_STATUSES` in `computeExecutionEdges.ts` if the new status should trigger edge highlighting.

**Files**: `src/components/workflows/canvas/edges/computeExecutionEdges.ts`, `src/components/workflows/canvas/panels/StepLogItem.tsx`, `src/api/workflows.ts`.

---

## 2026-05-20 — PII Mask UX: three inputs + live preview (ABLP-535 F-6)

**Category**: pattern
**Learning**: The PII Pattern Form Dialog (`PIIPatternFormDialog.tsx`) configures masked redaction via three always-visible inputs — `show_first`, `show_last`, `mask_character` — backed by an inline `previewMask()` helper that mirrors `applyMask` in `pii-vault.ts` (preserves `@domain` for emails; otherwise prefix + `maskChar.repeat(middle)` + suffix). The preview reads from `MASK_PREVIEW_SAMPLES[piiType]` (or `MASK_PREVIEW_FALLBACK` for custom types) and re-computes on every keystroke so users see the exact runtime output.

An earlier iteration used a "Mask Style" dropdown with Full / Last 4 / First 4 / Custom presets — removed because the three inputs already cover every preset configuration, and the dropdown's static hint text could drift from the actual values.

**Files**: `src/components/settings/PIIPatternFormDialog.tsx`, `packages/i18n/locales/en/studio.json`
**Impact**: When adding new sample plaintexts for new PII types, extend `MASK_PREVIEW_SAMPLES`. If `applyMask` in `pii-vault.ts` ever changes its algorithm (e.g., adds a new type-aware special case), `previewMask()` must be updated in lockstep — it is an intentional copy to avoid pulling a server-only compiler import into the UI bundle.

---

## ABLP-1145 — Invitation Bypass + canCreateWorkspace Claim (2026-05-21)

### What changed

- `auth-service.ts`: `JWTPayload.canCreateWorkspace?: boolean` + `createAccessToken` options + `createTokenPair`/`buildTokenPair`/`switchTenant` all compute `canCreate = isSuperAdmin || canUserCreateWorkspace(email)`
- `lib/auth.ts`: `AuthenticatedUser.canCreateWorkspace?: boolean` decoded from JWT payload
- `store/auth-store.ts`: `User.canCreateWorkspace`, decoded in `setAuth` + `setTokens`
- `app/api/auth/me/route.ts`: returns `canCreateWorkspace: result.canCreateWorkspace ?? true`
- All 9 auth routes: thread `inviteToken` (from body or `oauth_invite` cookie) to `isEmailAllowedForAuth`

### Learnings

**`createAccessToken` is synchronous — keep it that way**: The function cannot do DB calls. Callers (`createTokenPair`, `buildTokenPair`, `switchTenant`) must compute `canCreate` before calling it. Pattern: `const canCreate = isSuperAdmin || (await canUserCreateWorkspace(user.email))` then pass as option.

**`canCreateWorkspace` uses `=== false` pattern everywhere**: The field is absent for users who CAN create workspaces (backward compat — old tokens). Only explicitly `false` for restricted users. Always check `user.canCreateWorkspace === false` (not `!user.canCreateWorkspace`) to avoid breaking undefined = allowed.

**`switchTenant` was missed in initial plan**: `switchTenant` in `auth-service.ts` also calls `createAccessToken` but was not covered in the plan. Always grep for ALL callers of token-creation functions when adding new computed claims.

**`oauth_invite` cookie position matters**: All OAuth callbacks read `oauth_invite` cookie but use it AFTER the domain check. The fix is to move the read BEFORE `isEmailAllowedForAuth`. Check this pattern whenever modifying OAuth callback routes. Affects: Google, Microsoft, LinkedIn, OIDC, SAML.

**Auth routes: `inviteToken` flows from URL → body → DB**:

- Login/signup pages: `searchParams.get('invite')` → fetch body as `inviteToken`
- OAuth/SSO: `request.cookies.get('oauth_invite')?.value` → passed to `isEmailAllowedForAuth`
- DB layer validates against real invitation records (SHA-256 hash match + email + status + expiry)
