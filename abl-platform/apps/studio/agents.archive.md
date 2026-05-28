# agents.md archive — apps / studio

Entries archived from `agents.md` on 2026-05-04. All dated entries below are from before 2026-04-01. Append-only log; read when older context is needed.

---

## 2026-03-28 — Web SDK Source Resolution

**Category**: gotcha
**Learning**: Studio cannot consume `packages/web-sdk/src/react/index.ts` directly under Turbopack yet because the SDK source uses ESM-style `.js` specifiers inside `.ts`/`.tsx` files (for example `./AgentProvider.js`), and Turbopack resolves those literally instead of applying webpack-style extension aliasing. The reliable fix is to keep Studio importing the package export and automatically build `@agent-platform/web-sdk` before Studio `dev`, `build`, and `analyze`, while root `dev` and `dev:studio` also include the `web-sdk` watcher.
**Files**: `package.json`, `apps/studio/package.json`, `apps/studio/vitest.config.ts`, `apps/studio/vitest.unit.config.ts`, `apps/studio/vitest.coverage.config.ts`
**Impact**: If `@agent-platform/web-sdk/react` works in Vitest but fails in `next dev`/`next build`, do not switch Studio to raw SDK source without first solving the `.js`-specifier issue in Turbopack. Prefer auto-building the SDK entrypoints instead of depending on manual `pnpm build --filter=@agent-platform/web-sdk` steps.

## 2026-03-28 — Chat Header Dynamic i18n Keys

**Category**: gotcha
**Learning**: `StudioChatHeader` renders dynamic translation keys like `agent_type_${agent.type}` and `agent_mode_${agent.mode}`. `next-intl` still throws `MISSING_MESSAGE` for absent dynamic keys even if a caller tries to pass a default message, so dynamic badge labels must use `t.has(key)` before `t(key)`, and the locale must include the current runtime variants (`agent`, `supervisor`, `reasoning`, `scripted`).
**Files**: `src/components/chat/StudioChatHeader.tsx`, `packages/i18n/locales/en/studio.json`, `src/__tests__/components/studio-chat-panel.test.tsx`
**Impact**: When Studio adds new agent types or modes, update the locale and keep the `t.has` fallback in place so the chat UI degrades to a humanized label instead of logging `MISSING_MESSAGE` and breaking the panel.

## 2026-03-28 — Test Suite Modularization Coverage

**Category**: testing
**Learning**: Studio split coverage cannot rely on Vitest blob/json reporters alone because `vitest-force-exit.ts` can terminate forks-pool runs before reporter flush. The reliable path is hybrid: each split phase writes a phase-local `coverage-final.json` when it exits naturally, otherwise `run-coverage.ts` falls back to the raw V8 `coverage-*.json` artifacts under `.vitest-reports/split-coverage/partials/` and converts them through a dedicated `vitest.coverage.config.ts` merge context.
**Files**: `run-coverage.ts`, `run-tests-plan.ts`, `vitest.coverage.config.ts`, `vitest-force-exit.ts`
**Impact**: Future Studio coverage changes should preserve this hybrid merge flow. If coverage output goes missing again, check for a missing `coverage-final.json` first, then inspect the raw `.tmp-*` V8 files before assuming the tests themselves failed.

## 2026-03-27 — Test Suite Modularization Phase 4-5

**Category**: testing
**Learning**: `run-tests-plan.ts` is executed directly via `node --import tsx`, so it must derive `APP_ROOT` from `import.meta.url` and normalize repo-root path filters to app-relative paths before building the split-runner plan. It must also avoid injecting a second `--passWithNoTests` when the caller already forwarded that flag. Without those guardrails, commands like `pnpm --dir apps/studio test -- apps/studio/src/__tests__/stores/ --passWithNoTests` fail before the tests even start.
**Files**: `run-tests-plan.ts`, `src/__tests__/run-tests-plan.test.ts`
**Impact**: Any future Studio test tooling that shells into `apps/studio` but accepts repo-root paths should reuse this normalization pattern.

**Category**: gotcha
**Learning**: `vitest.node.config.ts` needs `root: __dirname`, and `setup-node.ts` must preserve `__nativeFetch` plus mock `localStorage`/`sessionStorage`. Node API/E2E suites rely on repo-root invocation, real fetch restoration, and Zustand persist globals even without happy-dom.
**Files**: `vitest.node.config.ts`, `src/__tests__/setup-node.ts`
**Impact**: If node-lane discovery drops files or API/E2E suites lose fetch/storage globals after refactors, check these two files first.

**Category**: process
**Learning**: The Studio node lane is now intentionally reserved for API, integration, and E2E-style suites; UI-heavy domains flow through the split light/unit runner instead of `test:node`.
**Files**: `vitest.node.config.ts`, `run-tests.ts`, `.husky/pre-push`
**Impact**: Hook automation and local debugging should target `test:node` only for server-side or API-heavy domains and use `pnpm test -- <domain>` for UI domains.

## 2026-03-22 — Reusable Agent Modules Phase 1

**Category**: architecture
**Learning**: Studio module UI follows the standard route→API→component pattern: API routes under `src/app/api/projects/[projectId]/modules/`, pages under `src/app/projects/[projectId]/modules/`, components in `src/components/modules/`. The module library page lists available modules with publish/import actions. Module detail pages show releases, dependencies, and consumer projects.
**Files**: `src/app/api/projects/[projectId]/modules/route.ts`, `src/components/modules/ModuleLibrary.tsx`, `src/components/modules/ModuleDetail.tsx`
**Impact**: New module UI features (e.g., dependency graph visualization, version diff view) should follow the same Next.js App Router pattern with API routes as BFF layer.

**Category**: testing
**Learning**: Studio has 48 module-related tests covering: API route handlers (CRUD, publish, import), component rendering (library, detail, dependency picker), and store updates. Tests use MSW for API mocking in component tests and direct handler invocation for API route tests.
**Files**: `src/__tests__/api-modules.test.ts`, `src/__tests__/components/modules/`, `src/__tests__/store/module-store.test.ts`
**Impact**: Studio component tests should always test both the happy path render and error states (API failure, empty data, loading). MSW is the standard for API mocking in component tests — do not use `vi.mock` on fetch.

## 2026-03-22 — Attachment Settings UI

**Category**: pattern
**Learning**: Settings tabs use direct `apiFetch` with `useState` — no SWR, no Zustand store. Follow the TraceDimensionsTab pattern. Load via `useCallback` with `[projectId]` deps, save via inline async handler. Use atomic Zustand selector `useNavigationStore((s) => s.projectId)` to avoid re-renders.
**Files**: `src/components/settings/AttachmentSettingsTab.tsx`, `src/store/navigation-store.ts`
**Impact**: Future settings tabs should follow this pattern. The override/inherited indicator UX (`renderOverrideIndicator` with reset-to-default) is new and reusable for any settings tab backed by a 3-tier config.

**Category**: gotcha
**Learning**: Studio vitest uses `vitest-force-exit.ts` global setup that kills the process via `process.exit()` after 2 seconds in forks pool mode. This suppresses test output — tests pass (exit code 0) but reporter can't flush before exit. JSON and verbose reporters are both affected. Confirm pass/fail via exit code only.
**Files**: `vitest-force-exit.ts`, `run-tests.ts`
**Impact**: Don't rely on reporter output for Studio test results. Use exit code. pr-reviewer agents may flag "no test output" — this is expected behavior, not a failure.

**Category**: gotcha
**Learning**: Package name is `@agent-platform/studio` (not `studio`). Use `pnpm build --filter=@agent-platform/studio`. The `--filter=studio` form silently fails with "No package found".
**Files**: `package.json`
**Impact**: Always use the full scoped package name with turbo/pnpm filter commands.

**Category**: testing
**Learning**: Always add `aria-label` to `<select>` and `<input>` elements that don't have a visible `<label>` element. pr-reviewer catches this in production readiness rounds. i18n keys for field names double as accessible labels via `t('field_pii_policy')`.
**Files**: `src/components/settings/AttachmentSettingsTab.tsx`
**Impact**: Include aria-labels in initial implementation to avoid review round fix-ups.

## 2026-03-22 — Reusable Agent Modules Phase 2 Sprint 1

**Category**: testing
**Learning**: Module test count in Studio is now 86 (was 58). Added `api-module-dependencies.test.ts` (17 tests) covering import validation: alias uniqueness, self-import guard, max dependency limit (5), secret config override rejection, cross-tenant 404, project isolation for DELETE, MongoDB 11000 duplicate key handling. Tool picker (5 tests) and coordination section (6 tests) were already committed from Phase 1 Sprint 3 but incorrectly listed as NOT IMPL in the test spec.
**Files**: `src/__tests__/api-module-dependencies.test.ts`, `src/__tests__/tool-picker-imported-tools.test.tsx`, `src/__tests__/coordination-section-imported-agents.test.tsx`
**Impact**: Import validation tests mock DB models (not route handlers) and test the full Next.js route handler flow. Follow this pattern for future route tests: mock `@agent-platform/database/models`, `@/lib/auth`, `@/lib/project-access`, then import and call the route handler directly.

**Category**: architecture
**Learning**: Consolidated `selectedTraceNodeId` from `ui-store` into `observatory-store.selection` with `{ executionNodeId, spanId, eventId }`. Added `spanId` to `TreeNode` in `buildAgentTree.ts` for execution-tree ↔ span-tree linking. Removed `ui-store` imports from 6 components: DebugTabs, SpanTree, AgentExecutionTree, OverviewTab, SessionDetailPage, replay-trace-events. This was a side-fix unrelated to modules.
**Files**: `src/store/observatory-store.ts`, `src/hooks/useSessionDetail.ts`, `src/lib/buildAgentTree.ts`, `src/store/ui-store.ts`
**Impact**: All trace/span/execution selection state now lives in `observatory-store.selection`. Do not reference `ui-store` for trace node selection — it has been removed.

---

## 2026-03-22 — Reusable Agent Modules Phase 2 Sprint 2

**Category**: pattern
**Learning**: The upgrade PATCH handler follows the same import confirmation pattern from the POST handler but skips alias validation and max-dependency checks (since the alias doesn't change and no new dependency is created). It uses `diffModuleContracts()` from `@agent-platform/project-io` to compute a structured diff between the current and target contract, returning `{ hasBreakingChanges, summary }` in the response. The `contractSnapshot` field on dependencies may be `undefined` for pre-Phase-2 records — always provide an empty contract fallback for the diff.
**Files**: `src/app/api/projects/[id]/module-dependencies/[dependencyId]/route.ts`
**Impact**: Future upgrade-related features (e.g., batch upgrade, auto-upgrade) should reuse the same diff computation pattern and prerequisite validation logic.

**Category**: pattern
**Learning**: The GET dependencies handler uses a MongoDB aggregation pipeline (`$match` + `$sort` + `$group`) to batch-query latest releases for update-available enrichment. This avoids N+1 queries when listing dependencies. The aggregation only runs when `depModuleIds.length > 0`. The `$group` uses `$first` after `$sort: { createdAt: -1 }` to get the most recently created release per module.
**Files**: `src/app/api/projects/[id]/module-dependencies/route.ts`
**Impact**: This aggregation pattern (match-sort-group-first) is reusable anywhere we need "latest X per group" queries. The `archivedAt: { $in: [null, undefined] }` filter handles both null and missing fields.

**Category**: pattern
**Learning**: The diff endpoint (GET `/module-dependencies/:dependencyId/diff`) computes three independent outputs: (1) contract diff via `diffModuleContracts()`, (2) prerequisite issues by comparing required prereqs between current and target, (3) mounted symbol changes by comparing provided agents/tools with alias prefix. These are independent computations serving different UI needs (diff panel, prereq checklist, namespace impact).
**Files**: `src/app/api/projects/[id]/module-dependencies/[dependencyId]/diff/route.ts`
**Impact**: The diff endpoint is read-only and safe to call repeatedly (no side effects). It's designed to be called before the PATCH upgrade to show a preview.

**Category**: pattern
**Learning**: The consumers endpoint (GET `/module/consumers`) uses a reverse lookup pattern: `ProjectModuleDependency.find({moduleProjectId: projectId})` where the current project IS the module. This is the opposite direction from the dependencies list. Enrichment with project names and deployment status uses batch queries (`$in`) to avoid N+1. The `DeploymentModuleSnapshot` check for active deployments uses `moduleReleaseIds: { $in: releaseIds }` leveraging the multikey index.
**Files**: `src/app/api/projects/[id]/module/consumers/route.ts`
**Impact**: The reverse lookup pattern is important for module governance (who depends on me?). The `MODULE_MANAGE` permission is more restrictive than `MODULE_READ` since consumer information is sensitive.

**Category**: pattern
**Learning**: The archive POST handler on `/module/releases/:releaseId` uses a two-layer archival guard with three checks: (a) environment pointers, (b) deployment snapshots, (c) dependency records. The `DeploymentModuleSnapshot.exists()` intentionally does NOT scope by tenantId for safety (shared modules). The `action: z.enum(['archive'])` body schema pattern supports future actions without adding HTTP methods.
**Files**: `src/app/api/projects/[id]/module/releases/[releaseId]/route.ts`
**Impact**: Future actions on releases (e.g., `restore`) can be added to the same endpoint by extending the enum. The archival guard pattern should be reused for any deletion/archival of shared resources.

**Category**: testing
**Learning**: When testing route handlers that use `withRouteHandler`, the PATCH handler calls `ProjectModuleDependency.findOne()` directly (no `.lean()`) while the diff GET handler calls `.findOne().lean()`. Mock setup must account for this: use `mockResolvedValue(doc)` for direct calls and `{ lean: () => Promise.resolve(doc) }` for chained lean calls. The same model mock can handle both if you check which handler is being tested.
**Files**: `src/__tests__/api-module-upgrade.test.ts`
**Impact**: Future route test files for the module-dependencies handlers must check the source to see if `.lean()` is chained. The pattern is inconsistent between PATCH (no lean) and GET diff (lean). Tests that get the mock shape wrong will see "Cannot read property 'lean' of undefined" or receive the mock chain object instead of the document.

---

## 2026-03-22 — Reusable Agent Modules Phase 2 Sprint 3

**Category**: pattern
**Learning**: The `UpgradeModuleDialog` follows the same Dialog+Button pattern as ImportModuleDialog and PublishModuleDialog but is simpler (single-step, no catalog selection). It loads data on open via `useEffect`, disables the confirm button when prerequisite issues block the upgrade, and uses a danger-variant button when breaking changes are detected. The dialog receives all data via props (no store interaction) to keep it stateless and testable.
**Files**: `src/components/modules/UpgradeModuleDialog.tsx`, `src/components/modules/ModuleDependencyList.tsx`
**Impact**: Future upgrade-related UI (e.g., batch upgrade, auto-upgrade scheduling) should extend or wrap UpgradeModuleDialog rather than creating new dialogs.

**Category**: pattern
**Learning**: When rendering optional data inside `.map()` callbacks where TypeScript narrows in the JSX conditional but not in nested callbacks (e.g., `onClick`), extract the optional value into a local variable at the top of the `.map()` callback. Example: `const update = dep.updateAvailable;` then use `update` in both the conditional render and the click handler. This avoids non-null assertions which violate Studio rules.
**Files**: `src/components/modules/ModuleDependencyList.tsx`
**Impact**: Apply this pattern whenever optional nested objects need to be accessed in event handlers within JSX.

**Category**: pattern
**Learning**: The `ReverseDepPanel` is designed as a standalone component that manages its own data fetching. `ModuleSettingsPanel` loads just the consumer count on mount (separate from the panel), and the `ReverseDepPanel` re-fetches its own data when expanded. This avoids lifting consumer data state into the settings panel. The consumer count fetch failure is non-critical and fails silently.
**Files**: `src/components/modules/ReverseDepPanel.tsx`, `src/components/modules/ModuleSettingsPanel.tsx`
**Impact**: For supplementary data that enriches UI but isn't required for the primary flow, wrap in try/catch with no error propagation.

**Category**: pattern
**Learning**: `ArchiveReleaseButton` is a self-contained button+dialog component designed to be rendered per-item in a release list. The 409 error (release in use) is handled specially with a distinct toast message. The parent passes `onArchived` to refresh the release list after successful archival.
**Files**: `src/components/modules/ArchiveReleaseButton.tsx`
**Impact**: This per-item action button pattern (button opens confirm dialog, handles specific error codes, calls parent callback) is reusable for other destructive per-item actions.

---

## 2026-03-22 — Reusable Agent Modules Phase 2 Sprint 3 (Browser Smoke)

**Category**: testing
**Learning**: Playwright E2E smoke tests for modules use a "UI-first with API-fallback" strategy. Each scenario first attempts browser UI interaction (click buttons, fill forms), then falls back to direct API calls via `page.request` if UI elements aren't found. This makes tests resilient to UI layout changes while still exercising the browser path when available. The established patterns from `attachment-settings-e2e.spec.ts` (devLogin, getToken, getProjectId, shared page instance, serial execution) should be reused for all new browser E2E tests.
**Files**: `e2e/reusable-agent-modules-smoke.spec.ts`, `e2e/attachment-settings-e2e.spec.ts`
**Impact**: Future browser smoke tests should follow this dual-strategy pattern. Pure API verification as a fallback ensures tests don't become flaky due to UI element visibility timing while still exercising browser-level behavior.

**Category**: gotcha
**Learning**: Playwright `page.route()` for mocking API responses only intercepts page-level fetches (from the browser context). Direct `page.request.get()` calls from the test code bypass route mocks. Use `page.route()` to test how the UI reacts to different API responses, not to mock the API itself. Always call `page.unroute()` to restore normal behavior after the test.
**Files**: `e2e/reusable-agent-modules-smoke.spec.ts`
**Impact**: When testing feature flags or error states via route mocking, be aware that API verification calls in the same test will hit the real server, not the mock.

**Category**: gotcha
**Learning**: Module smoke tests that require two distinct projects (e.g., import/dependency scenarios) must handle the case where only one project exists. The module system blocks self-import, so tests that create a dependency must `test.skip()` if `moduleProjectId === consumerProjectId`. Use unique version numbers (`Date.now() % 10000`) to avoid conflicts across test runs since releases are append-only (no delete API).
**Files**: `e2e/reusable-agent-modules-smoke.spec.ts`
**Impact**: Any test that creates module dependencies must check for two-project availability first. Test cleanup cannot remove published releases — only dependencies.

## 2026-03-24 — SharePoint Wave 4 Batch 2 (Security, Config, Multi-Connector)

**Category**: gotcha
**Learning**: When using `useMemo`/`useCallback` that reference each other, declaration order matters for TypeScript. If `toggleSelectAll` references `filteredSources`, `filteredSources` must be declared first. This is a block-scoping issue — `const` declarations in function bodies are NOT hoisted.
**Files**: `src/components/search-ai/data/SourcesTable.tsx`
**Impact**: Always declare useMemo values before useCallback functions that depend on them.

**Category**: pattern
**Learning**: SharePointDetailPanel wiring pattern: tab content is rendered conditionally in the main content area (`activeTab === 'security' && activeConnectorId && <SecurityTab .../>`). Dialogs (ConfigExportDialog, ContentPurgeDialog) are rendered after the content div with their own open/onClose state, triggered from DropdownMenu items. Tooltips wrapping disabled menu items should be removed when enabling them.
**Files**: `src/components/search-ai/sharepoint/SharePointDetailPanel.tsx`
**Impact**: Follow this pattern when wiring new tabs or dialogs into the panel.

**Category**: pattern
**Learning**: i18n namespace nesting for sharepoint config: `search_ai.sharepoint.config.history`, `search_ai.sharepoint.config.drift`, etc. In studio.json, this becomes `"config": { "history": { ... }, "drift": { ... } }` nested inside the `"sharepoint"` object. Sub-components (ScopesSection, TokenExpirySection, etc.) share the parent SecurityTab's namespace (`search_ai.sharepoint.security`) rather than having their own.
**Files**: `packages/i18n/locales/en/studio.json`
**Impact**: Follow nested namespace pattern for deeply nested features. Security sub-sections share one namespace.

---

## 2026-03-24 — Omnichannel Session Continuity Gap Closure Phase 2

**Category**: pattern
**Learning**: OmnichannelSettingsPanel follows the same pattern as AttachmentSettingsTab: direct `apiFetch` with `useState` for load/save, `NextIntlClientProvider` for i18n in tests, `vi.mock` only for `apiFetch` (not codebase components). The panel has 4 sections (recall, identity, consent, liveSync) and a new retention section added during gap closure.
**Files**: `src/components/projects/OmnichannelSettingsPanel.tsx`, `src/__tests__/omnichannel-settings-panel.test.tsx`
**Impact**: Future omnichannel settings extensions should follow this pattern. The test file (10 tests) covers render, load, save, validation, and empty states.

**Category**: architecture
**Learning**: Studio omnichannel API routes proxy to runtime via `apiFetch` to the runtime's `/api/projects/:projectId/omnichannel/*` endpoints. Routes are at `src/app/api/projects/[id]/omnichannel/route.ts` and `src/app/api/projects/[id]/omnichannel/audit/route.ts`. Navigation wiring uses `settings-omnichannel` page key in `navigation.ts`.
**Files**: `src/app/api/projects/[id]/omnichannel/route.ts`, `src/app/api/projects/[id]/omnichannel/audit/route.ts`, `src/config/navigation.ts`
**Impact**: Any new omnichannel Studio endpoints (e.g., join-links proxy) should follow the same BFF proxy pattern.

## 2026-03-25 — lucide-react Icon Mock (Proxy approach)

**Category**: gotcha
**Learning**: `vi.importActual('lucide-react')` fails silently under happy-dom forks pool — icons render as real SVGs without `data-testid`. Fix: use a synchronous Proxy in `setup.tsx` that intercepts any PascalCase property and returns a lightweight SVG stub with `data-testid="icon-{name}"`. No per-file `vi.mock('lucide-react')` needed. Also: `vi.useFakeTimers()` must be in `beforeEach`/`afterEach`, not at module level; `vi.hoisted()` is required for mock values used in `vi.mock()` factory closures; Radix Checkbox uses `aria-checked` attribute, not `.checked`.
**Files**: `src/__tests__/setup.tsx`
**Impact**: Never use `vi.importActual` for large packages under happy-dom. Prefer synchronous Proxy mocks. Always use `vi.hoisted()` for mock objects referenced in `vi.mock()` factories.

---

## 2026-03-24 — Five9 Adapter (Agent Transfer)

**Category**: pattern
**Learning**: The Agent Transfer settings page (`AgentTransferSettingsPage.tsx`) uses a provider registry (`agent-desktop-registry.ts`) to enumerate available CCaaS providers. Adding a new provider to the UI requires: (1) add entry to `AGENT_DESKTOP_PROVIDERS` array with `providerKey`, `label`, `icon`, `fields`, (2) create/extend `EditConnectionDialog.tsx` for inline connection editing. The `PhoneCall` icon from lucide-react v0.303.0 was used instead of `Headset` (which is unavailable in this version).
**Files**: `src/components/settings/agent-desktop-registry.ts`, `src/components/settings/EditConnectionDialog.tsx`, `src/components/settings/AgentTransferSettingsPage.tsx`
**Impact**: Future CCaaS providers (e.g., Genesys, NICE) follow the same registry pattern. Always check `lucide-react` icon availability against Studio's pinned version (0.303.0) before specifying icons.

**Category**: testing
**Learning**: No React component test infrastructure exists for the settings pages. `EditConnectionDialog` and `AgentTransferSettingsPage` lack unit/integration tests due to missing test setup (MSW, render utilities for settings context). INT-9 and INT-10 from the test spec are deferred for this reason.
**Files**: `src/components/settings/EditConnectionDialog.tsx`
**Impact**: Adding React component tests for settings pages requires first establishing the test infrastructure (MSW handlers, settings context providers). This is a pre-existing gap affecting all settings pages, not just Five9.

## 2026-03-25 — Module Studio Wiring LLD

**Category**: gotcha
**Learning**: `PublishModuleDialog` and `ImportModuleDialog` have asymmetric control patterns. `PublishModuleDialog` reads `publishDialogOpen` from module-store internally (self-managing) — the caller just renders it and passes `projectId`. `ImportModuleDialog` takes explicit `{ open, onClose, projectId, onImported? }` props — the caller must thread open state from the store. Always read dialog component source before composing page wrappers.

## 2026-03-25 — Studio Theme & Docs Integration Phase 4 (Docs Routing + Layout)

**Category**: architecture
**Learning**: The `(internal)` route group in `src/app/docs/(internal)/` is critical for isolating the access gate layout from existing `/docs/abl` and `/docs/agent-anatomy` pages. These existing pages sit directly under `src/app/docs/` and are NOT wrapped by the `(internal)` layout. Any new MDX-based docs routes must be placed INSIDE the `(internal)` group to get the access gate + sidebar.
**Files**: `src/app/docs/(internal)/layout.tsx`, `src/app/docs/(internal)/[...slug]/page.tsx`, `src/app/docs/abl/page.tsx`
**Impact**: When adding new docs pages, place them inside `(internal)` for gated MDX docs, or directly under `docs/` for public/ungated pages.

**Category**: gotcha
**Learning**: In React 19 (used by Next.js 15+), `ReactElement.props` is typed as `{}` not `any`. Casting `children as React.ReactElement` then accessing `.props.className` causes TS errors. Fix: use a generic `React.ReactElement<CodeChildProps>` with an explicit interface. Also, `params` and `cookies()` must be awaited in Next.js 15+ App Router.
**Files**: `src/components/docs/mdx/index.tsx`, `src/app/docs/(internal)/[...slug]/page.tsx`
**Impact**: Always use typed generics when accessing ReactElement props. Always `await params` and `await cookies()` in server components.

**Category**: gotcha
**Learning**: The docs access API route at `/api/docs/access` uses `findRefreshToken` (READ-ONLY) from `auth-repo.ts`. Do NOT use `refreshTokens()` from `auth-service.ts` as that ROTATES the token. The layout calls this API route server-side by forwarding cookies.
**Files**: `src/app/api/docs/access/route.ts`, `src/app/docs/(internal)/layout.tsx`
**Impact**: Any future docs access checks should use the same API route, not call auth-service directly.

**Category**: pattern
**Learning**: The `gray-matter` package must be in `serverExternalPackages` in `next.config.mjs` to avoid webpack bundling issues. The `@tailwindcss/typography` plugin is registered in `tailwind.config.js` for `.prose` class support. The `.docs-prose` class in `globals.css` maps Tailwind prose variables to semantic design tokens.
**Files**: `next.config.mjs`, `tailwind.config.js`, `src/app/globals.css`
**Impact**: Any new server-only npm packages used in docs rendering may need to be added to `serverExternalPackages`.

---

## 2026-03-25 — SDK Chat UI Consolidation Phase 3 (Studio Integration)

**Category**: architecture
**Learning**: Studio integrates with the SDK via a transport adapter pattern (`useStudioTransport` hook in `src/adapters/`). WebSocketContext exposes `subscribeChatMessage` for external subscribers to receive raw ServerMessage events. The transport hook translates Studio ServerMessage to SDK TransportServerMessage and filters out Studio-only types (state_update, action_taken, session_reset, etc.). This allows SDK components to receive only chat-relevant messages.
**Files**: `src/adapters/useStudioTransport.ts`, `src/contexts/WebSocketContext.tsx`
**Impact**: Future SDK integrations should use the same transport adapter pattern. Do not add SDK-specific logic to WebSocketContext directly — keep it in the adapter layer.

**Category**: gotcha
**Learning**: To import `@agent-platform/web-sdk` sub-path exports (e.g., `@agent-platform/web-sdk/react`) in Studio, BOTH tsconfig paths AND vitest resolve aliases are needed. tsconfig paths handle TypeScript compilation, vitest resolve aliases handle Vite's runtime module resolution. They must point to the same source files (e.g., `../../packages/web-sdk/src/react/index.ts`). Without vitest aliases, tests fail with module resolution errors even when tsc passes.
**Files**: `tsconfig.json`, `vitest.config.ts`, `vitest.unit.config.ts`
**Impact**: Any new workspace package imported with sub-path exports needs both mappings. This is a common source of "works in tsc, fails in vitest" issues.

**Category**: gotcha
**Learning**: Studio uses observatory-store's `setDebugPanelTab('traces')` for switching debug panel tabs, NOT `setActiveTab` (which is a different method for a different tab union type). When opening the debug panel programmatically, call `setDebugPanelOpen(true)` followed by `setDebugPanelTab('traces')`.
**Files**: `src/store/observatory-store.ts`, `src/components/chat/StudioChatPanel.tsx`
**Impact**: Always verify store method names by reading the source before using them.

**Category**: testing
**Learning**: Studio test files using `renderHook` from `@testing-library/react` require happy-dom environment. They must be: (1) included in `vitest.unit.config.ts` include list, (2) excluded from `vitest.light.config.ts` exclude list. The `.test.ts` extension (not `.test.tsx`) is what causes them to be picked up by the light config — explicit include/exclude overrides are needed.
**Files**: `vitest.unit.config.ts`, `vitest.light.config.ts`, `src/__tests__/studio-transport.test.ts`
**Impact**: Any new `.test.ts` file using React Testing Library renderHook needs this dual config treatment.

**Category**: testing
**Learning**: Zustand store mocks in Studio tests need `Object.assign()` pattern to support both selector-based `useStore(s => s.field)` and static `useStore.getState()` access. Pattern: `Object.assign((selector) => selector(store), { getState: () => store })`. Without this, components that call `useStore.getState()` will throw.
**Files**: `src/__tests__/studio-chat-panel.test.tsx`
**Impact**: All Zustand store mocks should use this pattern if the component being tested uses both selector and static access patterns.

## 2026-03-26 — Session Observability Gaps (Test Implementation)

**Category**: testing
**Learning**: `synthesizeTurnSpans` is tested indirectly through `replayTraceEventsIntoObservatory` since it's a private function. Tests feed crafted `TraceEvent[]` arrays and inspect the observatory store's `addEvent` calls via mock. The function detects turns with real lifecycle events via `turnsWithRealEnter`/`turnsWithRealExit` Sets and only injects synthetic events for turns missing them.
**Files**: `src/__tests__/span-synthesis.test.ts`, `src/utils/replay-trace-events.ts`
**Impact**: When modifying synthesis logic, verify all 8 test cases cover: no lifecycle, all real, partial, timestamp offsets, spanId preservation, agentName extraction, single-turn.

**Category**: testing
**Learning**: `augmentedMessages` tests use `renderHook` from `@testing-library/react` with mocked `useSWR` to exercise the real dedup + synthesis algorithm in `useSessionDetail`. Key dedup parameters: 5s window + 100-char prefix match. Tests need `@vitest-environment happy-dom` directive for DOM API availability when run from repo root config.
**Files**: `src/__tests__/session-message-synthesis.test.ts`, `src/hooks/useSessionDetail.ts`
**Impact**: Studio test files using `renderHook` or any DOM API must include `@vitest-environment happy-dom` at the top for cross-config compatibility.

**Category**: gotcha
**Learning**: Studio tests must be run via the studio-specific vitest config (`cd apps/studio && pnpm vitest run`) to resolve `@/` path aliases. Running from repo root without `--config` fails with "Failed to resolve import @/store/auth-store".
**Files**: `vitest.config.ts`
**Impact**: CI should run studio tests with `--filter=studio` or from the studio directory.

## 2026-03-28 — Studio Domain Test Entry Points

**Category**: testing
**Learning**: Studio domain runs are now easiest through package scripts instead of raw Vitest commands. Use `pnpm --dir apps/studio test:stores`, `test:components`, `test:hooks`, `test:arch-ai`, and `test:search-ai` for split-runner domains, and `test:api-routes` for node-only route suites. `src/__tests__/TEST_INDEX.md` documents both the domain commands and the remaining root-level residual groups.
**Files**: `package.json`, `src/__tests__/TEST_INDEX.md`
**Impact**: Prefer the package scripts for targeted Studio work. They preserve the correct runner/config pairing and reduce guesswork about whether a suite belongs on the split runner or the node lane.

## 2026-03-28 — Studio Docs Domain Extraction

**Category**: testing
**Learning**: The root-level `docs-*` suites can move safely into `src/__tests__/docs/` because they only depend on direct relative imports plus the shared `fixtures/docs-content` directory. Observatory stays at the root for now, but a dedicated `test:observatory` alias is safe because the split runner already routes its pure logic files and happy-dom hooks into the right lanes.
**Files**: `package.json`, `src/__tests__/TEST_INDEX.md`, `src/__tests__/docs/`
**Impact**: Future Studio test cleanup should extract clean ownership clusters into folders first, then add alias scripts for mixed-runner root-level groups until their environment split is simple enough to move.

## 2026-03-28 — Chat Session List Authority

**Category**: sessions
**Learning**: Studio’s session list route must proxy Runtime rather than reading Mongo directly. The project can exist with zero persisted `sessions` rows while the chat UI still expects live runtime-backed history semantics, and DB-only reads silently return `sessions: []`. Keep the list behavior centralized in Runtime so in-memory/live-session handling does not drift.
**Files**: `src/app/api/runtime/sessions/route.ts`
**Impact**: When debugging “empty sessions list” issues, check Runtime and Mongo separately. A zero-row Mongo result is not enough to conclude there are no live sessions.

**Category**: sessions
**Learning**: Session sidebar resume logic must treat the unified session ID as the default runtime session ID. Use `runtimeSessionId || id` when resuming active sessions so old split-ID records still work and newer unified-ID sessions do not fall back to the slower historical `switchSession()` path.
**Files**: `src/components/chat/SessionSidebar.tsx`
**Impact**: Any future cleanup around session identifiers needs to preserve this compatibility until all older split-ID session records are gone.

**Category**: sessions
**Learning**: `useAgentSessions` should not poll forever when the sidebar history is empty. The useful polling cases are: there is an active/idle session already in the fetched list, or Studio has a `currentSessionId` that has not shown up in the list yet. Pair that with a one-shot `refresh()` when `currentSessionId` changes so newly started chats appear immediately without keeping the empty-state list hot forever.
**Files**: `src/hooks/useAgentSessions.ts`, `src/components/chat/SessionSidebar.tsx`
**Impact**: If session-list traffic spikes again, check whether polling was widened beyond active/current sessions or whether the current-session refresh hook was removed.
