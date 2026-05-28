# Arch AI: In-Project Integration Setup

**Date:** 2026-05-05
**Status:** ALPHA — Implementation complete (Phases 0–7 landed on `zarch/newtools`), behind feature flag `ARCH_INTEGRATIONS_V1`. Unit + integration tests green; 7 E2E specs scaffolded but skipped pending fixtures (`mock-oauth-provider.ts`, `mock-rest-endpoint.ts`, `mock-mcp-server.ts`). Not yet promoted to BETA.
**Mode:** IN_PROJECT only
**Tracking:** ABLP-162
**Last Updated:** 2026-05-06

## 1. Summary

Extend the existing in-project Arch AI overlay so users can set up, wire, verify, and maintain integrations end-to-end inside chat, with parity to the manual Connections / Auth Profiles / Tools editor pages for the common SaaS, REST, and MCP scenarios. Arch acts as a step-by-step collaborator: it proposes one move at a time, the user approves or edits via widgets, and Arch maps each integration to the specific agents that need it. A new `integration` artifact tab surfaces in-progress and live integrations as durable, re-openable artifacts. The feature reuses the existing `IntegrationDraft` state machine, `integration-methodologist` specialist, widget infrastructure, and tool-routing layer.

**Decision A — Connector tool path:** v1 produces **HTTP-typed `ProjectTool`s against provider REST APIs** (e.g., a `post_slack_message` tool that calls `https://slack.com/api/chat.postMessage` with an `auth_profile_ref`). `ConnectorConnection` rows are still created so dynamic dropdowns work in chat (`resolve_options`) and so the connection appears on the manual Connections page — but the runtime tool dispatch goes through `auth_profile_ref` directly, not through the connector. Activepieces-typed connector tools (with prebuilt action validations) are deferred to v2; that path requires runtime changes to extend `PROJECT_TOOL_TYPES`.

**Decision B — LLM context for integrations:** v1 keeps the IN_PROJECT generalist prompt unchanged and adds **3 new L2 knowledge cards** (`integration-setup-workflow`, `oauth-flow-primer`, `integration-failure-diagnosis`) keyed on integration regexes. These auto-load when the user mentions OAuth, Slack, "hook up", "integrate with", etc. The `integration-methodologist` specialist tool map remains the gate for which tools the LLM can call.

**v1 deltas:** 2 new widgets (`OAuthLaunch`, `IntegrationPlan`), 1 new tool (`connection_ops`), 1 extended tool (`auth_ops` with 6 more auth types), 1 new action (`integration_ops:revalidate`), 1 new artifact tab type (`integration`), 1 new SSE card variant (`integration_suggestion_card`), 1 new sanitizer helper, 1 runtime-side MCP cache invalidation hook, content-router regex extension, 3 new L2 knowledge cards, 2 prompt-injection loaders (project state + active draft), `pageContext` extension for integration entities. Rollout in 6 phases; runtime touched only for the MCP TTL hook (concession to enable S7).

## 2. Goal

Today, in-project Arch has the building blocks (`integration_ops`, `auth_ops`, `mcp_server_ops`, `tools_ops`, `agent_ops`, `propose_modification`, `apply_modification`, `collect_secret`) but no surface that ties them together. Users cannot complete an integration setup inside Arch — OAuth consent has no widget, connector connection creation has no tool, dynamic option resolution is unavailable, and integrations are invisible until you reopen the chat. This work closes those gaps so a user can say "hook up Slack so my ops_agent can post into #ops" and Arch handles the entire flow from auth profile creation through OAuth consent, tool generation, agent wiring (via the existing diff-approval path), and live verification — without ever leaving the chat panel.

## 3. Out of scope (deferred to v2)

- **Onboarding integration setup.** Onboarding (`/arch`) continues to defer integrations to in-project; this work targets `ArchOverlay` only.
- **Knowledge-base / SearchAI data sources.** KB ingestion has different mental shape (sync state, discovery, scope picker) and only SharePoint is implemented today. Defer.
- **OpenAPI bulk importer.** Net-new code path; high-value but expensive. Defer.
- **Workspace-scoped auth profile creation.** Admin-only on the manual UI; v1 stays project-scoped. Arch can read inherited workspace profiles but writes only project-scoped.
- **Enterprise auth types.** mTLS, AWS-IAM, SAML, Kerberos, SSH-key, hawk, ws_security. Rare for chat-driven setup; defer.
- **Activepieces-typed connector tools** (with prebuilt action validations + dynamic prop schemas). Requires extending `PROJECT_TOOL_TYPES` to include `'connector'`, runtime changes to dispatch via `ConnectorToolExecutor` for persisted tools, and a new tool-creation path. Significant runtime surface area — v2.
- **Background token-refresh worker.** Refresh stays reactive (existing platform behavior). v1 surfaces failures when they occur, does not preempt them.
- **Cross-project integration suggestions.** Arch suggests integrations only for the current project. Cross-project learning stays in `ArchLearningMemory`.

## 4. User scenarios

### S1 — User asks Arch to add a SaaS integration (OAuth)

User opens Arch overlay on a project page, types: "Hook up Slack so ops_agent can post into #ops."

1. Content router matches `\bslack\b` (after content-router regex extension — see §8.7) and routes to `integration-methodologist`. L2 cards `integration-setup-workflow`, `oauth-flow-primer`, `tool-binding-auth` auto-load. Arch starts a new `IntegrationDraft` via `integration_ops:start`. `metadata.activeIntegrationDraftId` is set on the session. Project state is auto-injected into the prompt by the new `projectStateSummaryLoader` (§8.8) so the LLM already knows ops_agent exists.
2. Arch reads the catalog via `platform_context:list_auth_profiles`, sees no Slack `oauth2_app` profile exists, and proposes a plan via the `IntegrationPlan` widget (5 steps: profile → OAuth → tool → channel pick → wire to ops_agent → test).
3. User approves the plan. Arch calls `auth_ops:create` with `authType: 'oauth2_app', name: 'Slack OAuth App'`. Tool returns `{ needsSecrets: true, flowId, requiredSecrets: ['clientSecret'] }`. UI renders `SecretInput` widget. User pastes the Slack app's clientSecret. Atomic Redis consume; tool re-invokes; profile created. `syncActiveDraftFromAuthProfile` merges the profile id into the draft's `authProfileIds[]`.
4. Arch emits the new `OAuthLaunch` widget via `ask_user`. Widget receives the full `ConsentConnector` shape (see §6.2) and runs `useBatchOAuth` machinery. Popup opens `/api/projects/:id/auth-profiles/oauth/initiate`. User consents on Slack. Slack redirects to `/oauth/auth-profile-callback`. Server-side callback exchanges code → tokens, upserts `EndUserOAuthToken`, AND creates the `oauth2_token` profile linked via `linkedAppProfileId`. Popup postMessages `auth-profile-oauth-callback` to opener. Widget submits `{ status: 'connected', oauthTokenProfileId, expiresAt }` as the tool answer.
5. Arch calls the new `connection_ops:create` to bind the `oauth2_token` profile to the Slack connector. This is a `ConnectorConnection` row (binding, no credentials). `syncActiveDraftFromConnection` adds the connection id to the draft's `connectionIds[]`. The connection is what makes `connection_ops:resolve_options` work in the next step, and what makes the integration show up on the manual Connections page.
6. Arch calls `tools_ops:create` with type `http`: a `post_slack_message(channel: string, text: string)` ProjectTool whose endpoint is `https://slack.com/api/chat.postMessage`, `method: POST`, headers include `Authorization: Bearer {{auth.access_token}}`, `auth_profile_ref` set to the `oauth2_token` profile id. The runtime resolves auth via `auth_profile_ref` directly; ConnectorConnection is NOT consulted by the runtime for this `http`-typed tool.
7. Arch calls `connection_ops:resolve_options` for the `channel` parameter. The tool proxies to Studio's existing route at `/api/projects/[id]/connectors/[connectorName]/actions/[actionName]/props/[propName]/options` (which itself proxies to workflow-engine). Returns `{ options: [{ value: 'C0123', label: '#ops' }, ...] }`. UI renders `SingleSelect` widget. User picks `#ops`. The selected channel ID is stored as a default parameter value on the ProjectTool.
8. Arch reads `ops_agent.abl` via `read_agent`, then calls `propose_modification` with the diff: appending `post_slack_message(channel: string, text: string) -> { ok: boolean, ts: string }` to the agent's `TOOLS:` block. UI renders the existing diff-card widget (`InProjectDiffCard`). User clicks Approve.
9. Arch calls `apply_modification` with the proposal id. The agent DSL is updated. Then `tools_ops:test` runs a live invocation with sample parameters (`channel: '#ops', text: 'integration test'`). Result is sanitized via the new `sanitize-tool-error.ts` helper and surfaced via `tool_result`. On success, draft transitions to `complete`; `metadata.activeIntegrationDraftId` is cleared. Artifact card pill: `auth ✓ tool ✓ wired ✓ test ✓`.

**Caveat surfaced to user:** The newly wired tool is visible only to NEW agent sessions. Live production sessions running ops*agent continue with the pre-edit IR until they end. Arch surfaces this in the success message: *"Wired and tested. Existing live sessions will pick up the change on their next start."\_

### S2 — Arch proactively suggests an integration

User opens the Arch overlay (`openOverlay()` action). The suggestion engine runs (debounced once per 30-min window per `(tenantId, projectId)`):

1. `computeIntegrationSuggestions(ctx, projectId, pageContext)` runs (signature now includes `pageContext` for biasing).
2. Reads `ProjectAgent` list, `ProjectTool` list, and active `IntegrationDraft`s via `platform_context` cached calls.
3. Detects `support_agent.abl` has unbound `TOOLS:` entries (signatures declared but no implementation in `ProjectTool`). Pattern-matches names like `look_up_ticket(ticket_id)` against `integration-hints.ts` provider registry.
4. **Page-aware biasing:** if `pageContext.entity.type === 'agent'` and `entity.name === 'support_agent'`, the suggestion is anchored to that agent first. If `pageContext.page === 'tools'`, suggestions favor tool-discovery framing. If `pageContext.page === 'connections'`, suggestions favor connection-binding for existing auth profiles.
5. Emits a suggestion card via `integration_suggestion_card` SSE event (proper plumbing through widget variant enum + compat union + dispatcher + KB_CARD_MAP — see §6.4): "support_agent has an unbound `look_up_ticket` tool. Two providers fit: Zendesk, Intercom." Buttons: pick one, skip.
6. If user clicks a provider, the chat input is prefilled with structured `prefillMetadata = { kind: 'start_integration', providerKey: 'zendesk', targetAgentNames: ['support_agent'] }`. The chat-input watcher converts this into a hidden first tool call to `integration_ops:start(...)` server-side, skipping a redundant LLM round-trip. Subsequent flow follows S1.

### S3 — User edits an auth profile manually, then resumes Arch

User starts a Slack integration draft, leaves it at `needs_input`, edits the linked auth profile via the Connections page (e.g., adjusts scopes), returns to the project page, opens Arch overlay, clicks the `integration` artifact tab, clicks the in-progress Slack draft.

1. Click handler on the integration card sets `prefillMetadata = { kind: 'resume_integration', draftId, intent: 'resume' }` in the store. The chat-input watcher detects the metadata and POSTs a structured tool-driven resume to a new server route: `POST /api/arch-ai/integration-drafts/:id/resume` (NEW, see §17). This is NOT a free-text "/resume <id>" message — it's a structured handoff that avoids LLM string parsing.
2. Server-side: the resume route runs `integration_ops:revalidate` (re-reads `authProfileIds`, `toolIds`, `connectionIds`, `variableNamespaceIds`, `targetAgentNames`). Recomputes status via existing `deriveDraftStatus`.
3. The result is rendered as the next assistant message in the chat: "✓ auth profile updated externally — scopes now include `chat:write` and `channels:read`. ⚠ no tool created yet. Resume: shall I create `post_slack_message`?" with affirm/dismiss buttons.

### S4 — Tool starts failing in production

User notices their support_agent is erroring. Opens Arch, asks "why is support_agent failing?"

1. Content router matches `\b(failing|error|broken|stuck)\b` patterns; routes to `diagnostician`. L2 cards `integration-failure-diagnosis` (NEW, see §8.6), `tool-binding-auth`, and the agents/tools cards auto-load.
2. The new `integration-failure-diagnosis` L2 card explicitly tells the LLM the tool chain to use: `query_traces` → `integration_ops:list` → `integration_ops:revalidate` → propose fix.
3. `query_traces` returns recent errors: 401 on `look_up_ticket`. `integration_ops:revalidate` flags the linked Zendesk auth profile as `oauth_grant_missing_or_expired`. Arch proposes re-running OAuth consent.
4. User confirms via `Confirmation` widget; `OAuthLaunch` widget fires. After successful re-consent, draft transitions back to `complete`. Arch suggests testing once more via `tools_ops:test`.

### S5 — User asks Arch to add an internal REST API

User: "Add a tool that calls our internal billing API to check invoice status."

1. Content router matches `\b(add|set up|integrate)\s+.*\bapi\b` → `integration-methodologist`. L2 card `integration-setup-workflow` loads.
2. `integration-methodologist` starts a draft, asks via `SingleSelect`: "Do you have a cURL command, OpenAPI URL, or want to describe the endpoint?"
3. User pastes a cURL. Arch parses via `parseCurlCommand` from `@/lib/curl-parser` (CORRECT name; was `parseCurl` in earlier draft).
4. Asks about auth via `SingleSelect`: "What auth does this API use?" Options: `none | api_key | bearer | basic | custom_header | digest | azure_ad`.
5. User picks `bearer`. Arch creates a `bearer` auth profile, collects token via `SecretInput`, atomic consume, profile created.
6. Wires to the relevant agent via `propose_modification` → user approves → `apply_modification`. Tests live via `tools_ops:test`. Done.

## 5. Architecture overview

```
┌────────────────────────────────────────────────────────────────┐
│ Studio (Next.js process)                                       │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ ArchOverlay (existing, on every project page)            │  │
│  │  ┌────────────────────────┐  ┌───────────────────────┐   │  │
│  │  │ Artifact panel (left)  │  │ Chat panel (right)    │   │  │
│  │  │ Tabs: journal, spec,   │  │ - assistant messages  │   │  │
│  │  │   topology, health,    │  │ - widgets (NEW: OAuth │   │  │
│  │  │   search-ai,           │  │   Launch, IntegPlan)  │   │  │
│  │  │   ★ integration (NEW)  │  │ - suggestion cards    │   │  │
│  │  │ - Integration artifact │  │ - status cards        │   │  │
│  │  │   list view            │  │ - prefillMetadata     │   │  │
│  │  │ - Click → resume       │  │   watcher (NEW)       │   │  │
│  │  │   (structured handoff) │  │                       │   │  │
│  │  └────────────────────────┘  └───────────────────────┘   │  │
│  └──────────────────────────────────────────────────────────┘  │
│                          │                                     │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ /api/arch-ai/message (SSE)                               │  │
│  │   → process-in-project.ts (NEW: project-state loader,    │  │
│  │     active-draft loader injected into prompt)            │  │
│  │     → engine.runTurn() → LLM (claude-sonnet-4-6)         │  │
│  │       ← tool_call: integration_ops, auth_ops,            │  │
│  │         connection_ops (NEW), tools_ops, propose_mod,    │  │
│  │         apply_mod, etc.                                  │  │
│  │       → tool dispatch (in-project-tools.ts)              │  │
│  │                                                          │  │
│  │ /api/arch-ai/integration-drafts/:id/resume (NEW)         │  │
│  │   → server-side revalidate, no LLM call                  │  │
│  └──────────────────────────────────────────────────────────┘  │
│                          │                                     │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Tool implementations                                     │  │
│  │  - integration-ops.ts (extend: revalidate action,        │  │
│  │    connectionIds in entity revalidation)                 │  │
│  │  - auth-ops.ts (extend: 6 more auth types, NOT incl.     │  │
│  │    oauth2_token — system-managed)                        │  │
│  │  - connection-ops.ts (NEW)                               │  │
│  │  - tools-ops.ts (existing)                               │  │
│  │  - agent-ops.ts (existing — used directly)               │  │
│  │  - sanitize-tool-error.ts (NEW)                          │  │
│  │                                                          │  │
│  │  All call:                                               │  │
│  │  - integration-draft-service.ts (Mongo IntegrationDraft) │  │
│  │  - syncActiveDraftFrom* (auto-merge into active draft;   │  │
│  │    NEW: syncActiveDraftFromConnection)                   │  │
│  │                                                          │  │
│  │  Wiring path: propose_modification + apply_modification  │  │
│  │  (existing diff-approval, not direct agent_ops:update)   │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌────────────────────────────────────────────────────────────────┐
│ MongoDB                                                        │
│  - arch_sessions (metadata.activeIntegrationDraftId pointer)   │
│  - arch_integration_drafts (state machine; NEW connectionIds[])│
│  - auth_profiles (17 auth types, encrypted via DEK envelope)   │
│  - end_user_oauth_tokens (durable grants)                      │
│  - connector_connections (binds AuthProfile ↔ connector;       │
│      created so resolve_options works + manual UI visible)     │
│  - project_tools (HTTP-typed for v1; uses auth_profile_ref)    │
│  - project_agents                                              │
└────────────────────────────────────────────────────────────────┘
                                ▼
┌────────────────────────────────────────────────────────────────┐
│ apps/runtime (port 3112)                                       │
│  - resolves ProjectTool fresh each turn (no cache by name)     │
│  - AuthProfile cache: 5-min TTL, invalidated by updatedAt      │
│  - MCP servers: 5-min init TTL per project — NEEDS new         │
│    invalidation hook so Arch-created MCP servers are visible   │
│    to existing pod sessions without waiting (see §8.9)         │
└────────────────────────────────────────────────────────────────┘
```

Key principle: **all reads pull fresh from Mongo on each tool call.** No background sync, no event subscriptions. Manual edits in the Connections page are immediately visible to Arch on the next read. The `integration_ops:revalidate` action handles the case where an in-progress draft references an entity changed externally. Live agent sessions running concurrent with Arch edits do NOT see DSL/IR changes until session end (caveat surfaced to user in §S1 acceptance message).

## 6. Surface (UI changes)

### 6.1 New artifact tab: `integration`

**Type union extension** (`apps/studio/src/lib/arch-ai/store/arch-ai-store.ts:11`):

```ts
export type ArtifactTabType =
  | 'agent_code'
  | 'diff'
  | 'topology'
  | 'spec-document'
  | 'journal'
  | 'summary'
  | 'search-ai'
  | 'health'
  | 'integration'; // NEW
```

**Tab content render case** in `InProjectArtifactPanel.tsx:206`:

```ts
case 'integration': {
  return <IntegrationArtifactView tab={tab} sessionId={sessionId} projectId={projectId} />;
}
```

**Component:** `apps/studio/src/lib/arch-ai/components/arch/panels/IntegrationArtifactView.tsx` (NEW). Renders:

- A list of `IntegrationDraft` rows for the current project (queried via `GET /api/arch-ai/projects/[projectId]/integration-drafts`, NEW route, returns drafts excluding `archived`).
- Each row: provider name + status pill + four-checkpoint badges (`auth · tool · wiring · test` derived from `authProfileIds.length > 0`, `toolIds.length > 0`, `targetAgentNames.length > 0`, `lastTestStatus === 'pass'`).
- "Resume" button per row → sets `prefillMetadata = { kind: 'resume_integration', draftId, intent: 'resume' }` (structured handoff, see §11).
- "Add integration" button at bottom → sets `prefillMetadata = { kind: 'start_integration' }`.
- Empty state: "No integrations yet. Ask Arch in chat to set one up."

**Tab creation:** the tab is added by a new init effect inside `ArchOverlay.tsx`. When the session hydrates and a server-side query returns ≥1 non-archived `IntegrationDraft` for the project, the effect calls `useArchAIStore.getState().addTab({ type: 'integration', label: 'Integrations', data: { count } })`. The tab is **closeable** (NOT added to `NON_CLOSEABLE_TAB_TYPES`); same UX as `health` / `diff`. If no drafts exist, no tab is created until the user starts one (suggestion-engine path or user-initiated `integration_ops:start`).

### 6.2 New widgets

**`OAuthLaunch`** (`apps/studio/src/lib/arch-ai/components/arch/widgets/OAuthLaunch.tsx`):

Triggered by `ask_user` with `widgetType: 'OAuthLaunch'` and the FULL input shape required by `useBatchOAuth`:

```ts
interface OAuthLaunchInput {
  authProfileId: string; // the oauth2_app profile id
  authProfileRef: string; // 'authprofile:<id>' or named ref
  connectorName: string; // e.g. 'slack' — provider key
  connectionMode: 'shared' | 'per_user';
  scopes: string[];
  requirementKey?: string; // optional grouping key for batch consent
  environment?: string;
  providerLabel: string; // user-facing display
}
```

The widget constructs a synthetic `ConsentConnector` (the shape `useBatchOAuth.connectors[]` expects) and calls `useBatchOAuth.startOAuth(requirementKey)`. Reuses the existing 600x700 popup, postMessage `auth-profile-oauth-callback`, 5-min timeout, and origin-checked listener. Server-side OAuth callback creates the `oauth2_token` profile linked to the `oauth2_app` profile via `linkedAppProfileId`, and writes the `EndUserOAuthToken` row.

On success: submits tool answer `{ status: 'connected', oauthTokenProfileId, expiresAt }`. The `oauthTokenProfileId` is what subsequent steps (`connection_ops:create`, `tools_ops:create`) reference.
On failure/cancel: submits `{ status: 'failed' | 'canceled', error?: string }` (sanitized).

**`IntegrationPlan`** (`apps/studio/src/lib/arch-ai/components/arch/widgets/IntegrationPlan.tsx`):

Triggered by `ask_user` with `widgetType: 'IntegrationPlan'` and `input: { steps: PlanStep[], rationale?: string }`. Renders a numbered checklist of proposed steps with editable text. User actions: `Approve plan` | `Edit step…` | `Reject`. Returns `{ action: 'approve' | 'edit' | 'reject', editedSteps?, feedback? }`.

### 6.3 WidgetRenderer extension

`WidgetRenderer.tsx:130` adds two cases inside the `ask_user` switch on `widgetType`:

```ts
case 'OAuthLaunch':
  return <OAuthLaunch input={input as OAuthLaunchInput} onSubmit={onSubmit} />;
case 'IntegrationPlan':
  return <IntegrationPlan input={input as IntegrationPlanInput} onSubmit={onSubmit} />;
```

`AskUserInput` discriminated union (`apps/studio/src/lib/arch-ai/components/arch/widgets/types.ts:173`) gets two new variants. Zod schema in `apps/studio/src/lib/arch-ai/tool-schemas.ts:4` extends the `widgetType` enum AND adds conditional `input` schema branches for the new variants (existing approach for `BlueprintConfirm`, `TopologyApproval`, etc.).

### 6.4 Suggestion cards — full SSE plumbing

A new card type `integration_suggestion_card` requires plumbing across the durable v2 envelope and the v1 compat layer. Specifically:

1. **`packages/arch-ai/src/types/turn-events.ts:218`** — extend the `widget` `variant` enum to include `'integration_suggestion_card'`.
2. **`apps/studio/src/lib/arch-ai/compat/v1-core-refs.ts:18`** — extend `V4InProjectCardEventName` union and the switch at lines 473-481.
3. **`apps/studio/src/lib/arch-ai/ui/event-dispatcher.ts:1488-1516`** — extend `syncWidgetArtifact` to handle the new variant (calls `appendKbCardMessage`).
4. **`apps/studio/src/lib/arch-ai/components/arch/cards/index.ts:17-24`** — register `integration_suggestion_card: IntegrationSuggestionCard` in `KB_CARD_MAP`.
5. **Card renderer:** `apps/studio/src/lib/arch-ai/components/arch/cards/IntegrationSuggestionCard.tsx` (NEW).

Card payload shape:

```ts
{
  type: 'integration_suggestion_card',
  payload: {
    title: string;
    rationale: string;
    providerOptions: Array<{ name: string; logo?: string; providerKey: string }>;
    targetAgentNames?: string[];   // for biasing; carried into prefillMetadata on click
    skipLabel?: string;
  }
}
```

User clicks a provider button → sets `prefillMetadata = { kind: 'start_integration', providerKey, targetAgentNames }` rather than emitting a free-text message. This avoids LLM-side parsing of provider names and keeps the handoff structured.

## 7. Data model

### 7.1 IntegrationDraft schema additions

Two field additions to `packages/database/src/models/arch-integration-draft.model.ts`:

```ts
// NEW: connection ids tracked alongside other entity ids
connectionIds: string[];           // ConnectorConnection ids — populated by syncActiveDraftFromConnection
```

Plus the test-status fields from §7.2 below. The existing fields (`toolIds`, `authProfileIds`, `envVarKeys`, `configVarKeys`, `variableNamespaceIds`, `targetAgentNames`, `pendingSteps`, `lastIntentSummary`, `status`, `source`, `providerKey`) remain unchanged.

Per CLAUDE.md "Cross-boundary field propagation": every consumer of `DraftDocument` / `IntegrationDraftSummary` must be touched in the same change. Consumer list:

- `apps/studio/src/lib/arch-ai/integration-draft-service.ts` — `DraftDocument` interface (line 26-47), `IntegrationDraftSummary` interface (line 71-87), `normalizeDraft()` (line 126-148), `syncActiveDraftFrom*` family.
- `apps/studio/src/lib/arch-ai/tools/integration-ops.ts` — entire surface (start/get_active/list/update/run_tool_test/complete/archive/revalidate).
- `apps/studio/src/lib/arch-ai/components/arch/panels/IntegrationArtifactView.tsx` (NEW) — reads via the new GET route.
- `apps/studio/src/app/api/arch-ai/projects/[projectId]/integration-drafts/route.ts` (NEW).
- `apps/studio/src/app/api/arch-ai/integration-drafts/[id]/resume/route.ts` (NEW).
  A round-trip parity test asserts each field survives DB → service → tool → UI hop.

### 7.2 Test status fields on `IntegrationDraft`

```ts
// Single-value summary — drives the four-checkpoint pill
lastTestStatus?: 'pass' | 'fail' | 'pending' | null;
lastTestAt?: Date | null;
lastTestError?: string | null;     // sanitized via sanitize-tool-error.ts

// Rolling history — drives the artifact card's expanded detail view
testHistory?: Array<{
  at: Date;
  status: 'pass' | 'fail';
  error?: string;                  // sanitized
  sanitizedSampleInput?: string;
}>;  // capped at 5, FIFO eviction
```

Set by `tools_ops:test` and `integration_ops:run_tool_test`. Sanitization runs through `sanitize-tool-error.ts` (NEW; see §13.3).

### 7.3 Session metadata

No change. `metadata.activeIntegrationDraftId: string | null` already tracks the active draft (`arch-session.model.ts:191`).

## 8. Tools

### 8.1 New: `connection_ops`

File: `apps/studio/src/lib/arch-ai/tools/connection-ops.ts` (NEW).

Actions:

| Action                  | Purpose                                                                 | Backend                                                                                                                                                                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`                  | List existing `ConnectorConnection` rows for the project                | Direct Mongoose query on `ConnectorConnection` model, scoped by `tenantId + projectId`                                                                                                                                                                               |
| `create`                | Bind an `AuthProfile` (typically `oauth2_token`) to a connector         | `getConnectionService()` from `apps/studio/src/lib/connection-service.ts:91` (the Studio singleton wrapper around `ConnectionService` from `packages/connectors/src/services/connection-service.ts`)                                                                 |
| `delete`                | Remove a binding                                                        | Same wrapper service                                                                                                                                                                                                                                                 |
| `resolve_options`       | Fetch dynamic dropdown options (Slack channels, Notion DBs, etc.)       | Calls Studio's existing proxy route at `/api/projects/[id]/connectors/[connectorName]/actions/[actionName]/props/[propName]/options` (which itself proxies to workflow-engine's `/api/v1/connectors/.../options` via `apps/studio/src/lib/workflow-engine-proxy.ts`) |
| `resolve_dynamic_props` | Fetch dynamic property schema (Jira issue fields after picking project) | Same proxy with action variant                                                                                                                                                                                                                                       |

Permission: requires `project:integration:write` (extends `guards.ts`). Cache-invalidates after create/delete via `invalidateProjectCaches(tenantId, projectId)`.

After every successful `create`, calls `syncActiveDraftFromConnection(connectionId)` (NEW helper in `integration-draft-service.ts`) which appends the connection id to `IntegrationDraft.connectionIds[]` of the active draft.

Tool result shape: `{ success: true, data: ... }` or `{ success: false, error: { code, message } }`. `resolve_options` returns `{ disabled: boolean, placeholder?: string, options: Array<{ value, label }> }`.

Specialist tool map: added to `integration-methodologist` only (`packages/arch-ai/src/types/tools.ts:250`).

**Workflow-engine availability:** if workflow-engine is unreachable, `resolve_options` returns `{ disabled: true, placeholder: 'Connector unavailable; please type the value manually.' }` — Arch's chat then falls back to a plain `TextInput` widget for the user to enter the value (channel name / database id / etc.) by hand. Mirrors the manual UI's behavior under the same failure.

### 8.2 Extension: `auth_ops` — additional auth types

File: `apps/studio/src/lib/arch-ai/tools/auth-ops.ts:8`.

Extend `SUPPORTED_AUTH_TYPES`:

```ts
const SUPPORTED_AUTH_TYPES = [
  'api_key',
  'bearer',
  'oauth2_app',
  'oauth2_client_credentials',
  // NEW in v1:
  'basic',
  'custom_header',
  'digest',
  'azure_ad',
  'none',
] as const;
```

Extend `REQUIRED_SECRETS` map for each new type, mirroring `AUTH_TYPE_METADATA` from `apps/studio/src/components/auth-profiles/auth-type-metadata.ts` (the source of truth for the manual UI). Use the same Zod validation in `packages/shared/src/validation/auth-profile.schema.ts`.

**`oauth2_token` is NOT in this list.** Per the Studio API at `apps/studio/src/app/api/projects/[id]/auth-profiles/route.ts:227-229`, `oauth2_token` profiles are explicitly rejected for manual creation: _"oauth2_token profiles are system-managed and cannot be created manually. Use the OAuth authorize/callback flow instead."_ They are created automatically by the OAuth callback at `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/callback/route.ts:210-211` after a successful flow. Arch never calls `auth_ops:create` for the token half.

**Defer to v2:** `mtls`, `aws_iam`, `ssh_key`, `kerberos`, `saml`, `hawk`, `ws_security`. These are enterprise auth types unlikely to be set up via chat.

### 8.3 Extension: `integration_ops:revalidate` — new action

File: `apps/studio/src/lib/arch-ai/tools/integration-ops.ts:292`.

New action: `revalidate`.

Behavior:

1. Loads the `IntegrationDraft` by id (or active draft from session pointer).
2. Re-reads each referenced entity:
   - `authProfileIds[]` → `AuthProfile` documents (and linked `EndUserOAuthToken` for `oauth2_token` references)
   - `toolIds[]` → `ProjectTool` documents
   - `connectionIds[]` → `ConnectorConnection` documents (NEW with §7.1)
   - `variableNamespaceIds[]` → variable namespace documents
   - `targetAgentNames[]` → `ProjectAgent` documents
3. For each entity, computes whether it still exists, is still valid (e.g., AuthProfile not revoked, OAuth grant not expired beyond grace period), and whether the draft's recorded relationship still holds.
4. Calls existing `deriveDraftStatus` to recompute status from the fresh data.
5. Returns `{ success: true, data: { status, changes: [{ entityType, entityId, change, summary }], pendingSteps } }`.
6. Persists the recomputed draft.

Triggered:

- Automatically via `integration_ops:get_active`.
- By the new `POST /api/arch-ai/integration-drafts/:id/resume` route (when user clicks resume in the artifact panel).
- Inside the suggestion-engine startup pass.

### 8.4 Wiring path: `propose_modification` + `apply_modification`

Wiring an integration's tool to an agent uses the **existing diff-approval path**, NOT a direct `agent_ops:update` write. The `integration-methodologist` specialist already has `propose_modification`, `apply_modification`, `dismiss_proposal` in its tool map (`packages/arch-ai/src/types/tools.ts:254-256`).

Flow:

1. `read_agent('ops_agent')` → returns current DSL.
2. `propose_modification({ agentName, dsl: <updated DSL with appended TOOLS: entry>, rationale })` → emits a `diff` artifact tab + assistant message. UI renders existing `InProjectDiffCard`.
3. User clicks Approve → tool answer to `Confirmation` widget → server runs `apply_modification(proposalId)`.
4. Or user clicks Reject / Edit → `dismiss_proposal` runs; LLM iterates.

**No `agent_ops` change is needed for this feature.** The earlier draft of this spec proposed adding `agent_ops` to the `integration-methodologist` tool map — that was redundant with the propose/apply path. Drop that change.

### 8.5 Suggestion-engine helper

File: `apps/studio/src/lib/arch-ai/processors/integration-suggestions.ts` (NEW).

Function signature:

```ts
async function computeIntegrationSuggestions(
  ctx: ToolPermissionContext,
  projectId: string,
  pageContext?: PageContext,
): Promise<IntegrationSuggestion[]>;
```

Logic:

1. Reads project state via `platform_context` cached calls.
2. For each `ProjectAgent`: parse the agent's ABL via `@abl/core`, find `TOOLS:` entries declared without implementation in `ProjectTool`. These are "unbound TOOLS."
3. **Page-aware biasing:**
   - `pageContext.entity.type === 'agent' && entity.name === X` → suggestions for agent X first.
   - `pageContext.page === 'tools'` → bias to tool-discovery suggestions.
   - `pageContext.page === 'connections'` → bias to connection-binding suggestions.
   - `pageContext.entity.type === 'connection'` → bias to "wire this connection" suggestions.
4. For each unbound tool: heuristic match against `apps/studio/src/lib/arch-ai/integration-hints.ts` provider registry; LLM-narrated fallback when heuristics miss.
5. For each broken active draft (status `failed` or `lastTestStatus === 'fail'` AND `lastTestAt > now - 24h`): emit a "broken integration" suggestion.
6. Returns up to 3 suggestions.

Trigger points:

- On `openOverlay()`: dispatch low-priority compute.
- After `turn_committed` if `(agents, tools, drafts)` changed: re-run, debounced 5s.
- Manual: "Review integrations" chip in `ArchEntryState.tsx`.

LLM cost control: a single Redis throttle key per `(tenantId, projectId)` with 30-min TTL gates session-open and turn-end triggers. The first request runs the full pass with one `claude-sonnet-4-6` call; subsequent requests in the window return cached suggestions or no-op. The manual chip click bypasses the throttle.

### 8.6 New L2 knowledge cards

Three new files under `packages/arch-ai/src/knowledge/cards/generated/` (or hand-curated equivalents):

1. **`integration-setup-workflow.ts`** — the full multi-step decision tree (auth-type selection, OAuth vs API key, connection vs no connection, wiring path). Triggered by content-router regexes for SaaS provider names + integration keywords (see §8.7).
2. **`oauth-flow-primer.ts`** — explains the two-half OAuth model (`oauth2_app` user-creates, `oauth2_token` system-creates after callback), what `OAuthLaunch` does, expected widget answers. Triggered on `oauth`, `consent`, `authorize`, `callback`.
3. **`integration-failure-diagnosis.ts`** — explicit tool chain for fixing broken integrations: `query_traces` → `integration_ops:list` → `integration_ops:revalidate` → propose fix. Triggered on `(failing|error|broken|stuck|401|403).*\b(agent|tool|integration)\b`.

Cards are loaded by `selectKnowledgeCards()` in `packages/arch-ai/src/knowledge/card-router.ts` whenever their regexes match the user's message. Token budget remains 6000 (`MAX_KNOWLEDGE_TOKENS`); typical card size 1000-1500 tokens.

### 8.7 Content router regex extension

File: `packages/arch-ai/src/coordinator/content-router.ts` — extend the `integration-methodologist` block in `ROUTE_RULES`:

```ts
// Add to integration-methodologist patterns:
/\b(slack|zendesk|notion|jira|stripe|hubspot|gmail|google\s+workspace|github|gitlab|salesforce|outlook|teams|discord|asana|linear|airtable|shopify|sendgrid|twilio|servicenow)\b/i,
/\b(hook\s+up|connect\s+(my|the|to)|integrate\s+with|wire\s+up)\b/i,
/\b(set\s+up|setup)\s+(?:my\s+)?(?:new\s+)?integration\b/i,
/\b(api\s+key|bearer\s+token|oauth\s+app)\b/i,
```

Without these, "Hook up Slack" and "connect to Slack" fall through to `abl-construct-expert` (wrong specialist, wrong tool map). Verified blocker — content-router today has no `slack`, `hook up`, or `connect to <provider>` patterns.

Also extend the `getPageContextSpecialistBias` function at `coordinator-bridge.ts:97-206` to bias to `integration-methodologist` when:

- `entityType === 'integration_draft'` (NEW entity type — see §6.1 + page-context registry update).

### 8.8 Prompt enrichment loaders

Two new loaders added to `buildTurnPlanLoaders` in `apps/studio/src/lib/arch-ai/processors/runtime-support.ts:48`:

1. **`projectStateSummaryLoader(ctx, projectId)`** — returns a 200-500 token summary injected as a `## Project State` section in the IN_PROJECT prompt:

   ```
   ## Project State
   - Agents: ops_agent, support_agent, billing_agent (3 total)
   - Tools: 5 ProjectTools defined (3 wired to ops_agent, 2 unwired)
   - Auth profiles: Slack OAuth App (oauth2_app, shared), Stripe API Key (api_key, personal)
   - MCP servers: 1 (linear)
   - Active integration draft: Zendesk (status: needs_input, 2 pending steps)
   - Recent test failures (24h): none
   ```

   This is computed once per turn from `platform_context` cached reads. Token budget capped.

2. **`activeDraftSnapshotLoader(ctx, sessionId)`** — when `metadata.activeIntegrationDraftId` is set, injects a `## Active Integration` section:
   ```
   ## Active Integration
   You are mid-flow on integration setup. Current draft snapshot:
   - Provider: slack | Status: needs_input
   - Auth profile: Slack OAuth App [created]
   - Tools: post_slack_message [created], get_slack_channels [pending]
   - Wiring: ops_agent [proposed, awaiting approval]
   - Pending steps: [complete_oauth_consent, wire_to_agent, run_test]
   - Last test: not yet run
   Do not call integration_ops:get_active to learn this — call it only when making changes.
   ```

Both loaders compose into `composeInProjectPrompt` at `packages/arch-ai/src/prompts/index.ts:109` after the existing context sections. Without these, the LLM has to call `platform_context.list_*` 3-5 times per first turn just to learn project state — significant UX cost.

### 8.9 Runtime-side MCP cache invalidation hook

File: NEW `apps/studio/src/lib/runtime-mcp-cache-invalidation.ts` (parallel to existing `apps/studio/src/lib/runtime-model-cache-invalidation.ts:39`).

Function: `notifyRuntimeMcpServersChanged(tenantId, projectId)`.

Modification to `apps/runtime/src/services/mcp/runtime-mcp-provider.ts`: expose a `resetProjectInit(tenantId, projectId)` method that clears the `projectInitialized` map entry, forcing the next session start in that project to reload MCP servers from MongoDB.

Triggered by Studio after `mcp_server_ops:create | update | delete`. Without this hook, a new MCP server is invisible to existing pod sessions for up to 5 minutes (the existing `PROJECT_INIT_TTL_MS = 5 * 60_000` from `runtime-mcp-provider.ts:35`). With the hook, new sessions started immediately after see the new server.

This is the only runtime-side change in v1. The spec previously claimed `apps/runtime/` was untouched; that claim is corrected.

## 9. Conversation flow (state machine)

Soft state machine driven by `IntegrationDraft.pendingSteps`:

```
[start]
   │
   ▼
{intent capture}                ←── user message OR suggestion-card click (with prefillMetadata)
   │
   ▼
integration_ops:start           →  draft created in 'draft' state
   │                                metadata.activeIntegrationDraftId = draftId
   │                                projectStateSummaryLoader / activeDraftSnapshotLoader
   │                                pull this into next turn's prompt
   ▼
{plan proposal}                 →  IntegrationPlan widget shows numbered steps
   │
   ▼ (user approves)
{auth setup}                    →  branch on auth needs:
   │  ├─ OAuth      →  auth_ops:create(oauth2_app) → SecretInput → OAuthLaunch
   │  │                  ↓ server-side callback creates oauth2_token + EndUserOAuthToken
   │  ├─ API key    →  auth_ops:create(api_key) + SecretInput
   │  └─ None       →  skip
   │
   ▼
{connection bind}               →  connection_ops:create (creates ConnectorConnection)
   │                                syncActiveDraftFromConnection adds id
   │
   ▼
{tool generation}               →  tools_ops:create (HTTP-typed against provider REST API,
   │                                with auth_profile_ref pointing to oauth2_token / api_key profile)
   │
   ▼ (optional)
{discovery}                     →  connection_ops:resolve_options → SingleSelect/MultiSelect
   │                                user picks; default param value stored on ProjectTool
   │
   ▼
{wiring proposal}               →  read_agent → diff prepared → propose_modification
   │                                emits diff artifact tab + assistant chat message
   │
   ▼ (user approves diff)
apply_modification              →  agent DSL persisted with new TOOLS: entry
   │
   ▼
{verification}                  →  tools_ops:test (live invocation, sanitized errors)
   │
   ▼ (test passes)
integration_ops:complete        →  draft.status = 'complete'
                                    metadata.activeIntegrationDraftId cleared
                                    artifact card shows ✓✓✓✓
                                    Surface caveat: live sessions need restart
                                    to see new wiring
```

Each `{...}` is an LLM turn that may use multiple internal tool calls. The LLM decides when to interrupt for user input via `ask_user` widgets.

**Loop-detector tuning:** `LoopDetector` flags 5 identical/paraphrase tool calls per turn. Multi-step flows that re-invoke `tools_ops` / `auth_ops` / `connection_ops` with similar args risk false positives. Mitigation in v1: each call uses different args (different toolId, different action). If false positives surface in testing, add `integration_ops`, `auth_ops`, `tools_ops`, `connection_ops` to the loop detector's call-similarity exclusion list.

**Cancellation:** at any step, user can type "cancel" or close the overlay. Existing `cancel` mechanism via `POST /api/arch-ai/sessions/:id/cancel` sets `cancelRequested: true`; engine polls between tool boundaries. On cancel mid-flow, draft remains at its current state (e.g., `needs_input`) — user can resume later via the artifact panel.

## 10. Auth handling

### 10.1 OAuth flow end-to-end inside Arch

```
1. auth_ops:create({authType: 'oauth2_app', name: 'Slack OAuth App'})
   → tool returns { needsSecrets: true, flowId: 'flow_abc',
                    requiredSecrets: ['clientSecret'] }

2. WidgetRenderer renders SecretInput for clientSecret
   → user pastes; UI POSTs to /api/arch-ai/secrets/:flowId
   → setFlowSecrets(flowId, { clientSecret: '...' }) — Redis 15-min TTL

3. LLM re-invokes auth_ops:create with same flowId
   → consumeFlowSecrets(flowId) — atomic GETDEL
   → POST /api/projects/:id/auth-profiles { authType: 'oauth2_app', ... }
   → AuthProfile encrypted via DEK envelope
   → returns { profileId: <oauth2_app_id> }

4. LLM emits ask_user widget OAuthLaunch with input:
   {
     authProfileId: <oauth2_app_id>,
     authProfileRef: 'authprofile:<id>',
     connectorName: 'slack',
     connectionMode: 'per_user',
     scopes: ['chat:write'],
     providerLabel: 'Slack',
     requirementKey: 'slack-oauth-<draft_id>'
   }
   → UI renders "Connect to Slack" button
   → user clicks
   → useBatchOAuth opens 600x700 popup
   → popup loads /api/projects/:id/auth-profiles/oauth/initiate
   → Studio returns authUrl with PKCE state
   → user consents on Slack
   → Slack redirects to /oauth/auth-profile-callback
   → callback POSTs to /api/projects/:id/auth-profiles/oauth/callback
   → server-side: exchanges code for tokens
                  creates the oauth2_token AuthProfile linked via linkedAppProfileId
                  upserts EndUserOAuthToken
   → callback page postMessages 'auth-profile-oauth-callback' to opener
   → useBatchOAuth catches message, resolves
   → widget submits tool answer:
     { status: 'connected', oauthTokenProfileId: <oauth2_token_id>, expiresAt }

5. LLM continues with connection_ops:create({
     connectorName: 'slack',
     authProfileId: <oauth2_token_id>
   })
   → ConnectorConnection row created
   → syncActiveDraftFromConnection adds to draft.connectionIds[]

6. LLM continues with tools_ops:create (HTTP-typed) and remaining flow.
```

The user's experience: paste clientSecret → click Connect → consent on Slack → return to Arch, which is already on the next step.

### 10.2 API key / bearer / basic flows

Simpler. No popup. `auth_ops:create({authType: 'api_key', ...})` → SecretInput → atomic consume → AuthProfile created. Subsequent `tools_ops:create` references the profile via `auth_profile_ref`. No `connection_ops:create` needed for non-SaaS-connector use cases (custom REST APIs).

### 10.3 Non-secret flows (`none` for public APIs)

`auth_ops:create({authType: 'none'})` directly creates a profile with no secrets. LLM proceeds.

### 10.4 Revalidation on resume

On every `integration_ops:get_active` (or explicit `revalidate`), Arch re-reads referenced entities. If an `oauth2_token` profile's underlying `EndUserOAuthToken` is missing or expired beyond grace period, marks the draft as `needs_input` with a step "re-authorize OAuth." User clicks the integration card → server-side resume route runs revalidate → chat resumes → OAuthLaunch widget fires again.

### 10.5 Visibility / scope handling and collision recovery

When creating profiles, Arch defaults:

- `oauth2_app`: `visibility: 'shared'` (clientSecret is org-level)
- `oauth2_token`: `connectionMode: 'per_user'` (each user authorizes separately) — created automatically by callback, not by `auth_ops:create`
- `api_key` / `bearer` / `basic`: ask the user via `Confirmation` widget if ambiguous: "Personal credential or shared with the team?"

When in doubt, defaults to `personal` for safety.

**Collision handling:** If `auth_ops:create` returns a Mongo duplicate-key error on the unique index `(tenantId, projectId, name, environment)` (shared visibility) or `(tenantId, projectId, createdBy, name, environment)` (personal visibility), Arch's `auth_ops:create` returns a structured error `{ success: false, error: { code: 'PROFILE_NAME_COLLISION', existingProfileId, existingProfileSummary } }`. Arch then emits a `Confirmation` widget: "A profile named 'Slack OAuth App' already exists in this project (created by Alice on Mar 12). Reuse it for this integration, or pick a different name?" If reuse → `syncActiveDraftFromAuthProfile` adds the existing id. If new name → re-invoke `auth_ops:create` with disambiguated name (e.g., suffix `(2)` or user-typed name).

This is a new failure mode worth handling explicitly because two different users in the same project setting up the same provider WILL collide on the default name with shared visibility.

## 11. Coexistence with existing UI

The Connections page, Auth Profiles page, and Tools editor remain. They become **management/listing surfaces**; Arch becomes the **authoring surface**.

| Surface                         | Role after this change                                            |
| ------------------------------- | ----------------------------------------------------------------- |
| Connections page                | Browse all connector connections, manual edit, manual revoke      |
| Auth Profiles page              | Browse all auth profiles, manual edit/rotate, admin workspace ops |
| Tools editor                    | Browse all ProjectTools, manual edit DSL, run individual tests    |
| Agent builder                   | View/edit agent ABL, see TOOLS: block                             |
| **Arch Integrations tab (NEW)** | Browse in-progress drafts, resume in chat                         |
| **Arch chat (NEW capability)**  | Chat-driven setup, suggestions, multi-step orchestration          |

Cross-links (NEW, optional v1):

- Connections page row: "Open in Arch" button → opens overlay + sets `prefillMetadata = { kind: 'manage_integration', connectionId, providerKey, draftId? }`
- Tools editor row: "Edit with Arch" → opens overlay + sets `prefillMetadata = { kind: 'manage_tool', toolId, toolName }`
- Score detail (eval failures): existing trigger, augmented to set `prefillMetadata = { kind: 'diagnose', evalId, sessionId }` for richer context.

`prefillMetadata` is a new field on the Zustand store: `prefillMetadata: PrefillMetadata | null`, where `PrefillMetadata` is a discriminated union `{ kind: 'start_integration' | 'resume_integration' | 'manage_integration' | 'manage_tool' | 'diagnose', ...payload }`. The chat-input `useEffect` watches `prefillMetadata` and either: (a) injects a structured first message, or (b) for `kind: 'resume_integration'`, calls the new `POST /api/arch-ai/integration-drafts/:id/resume` route directly — server-side runs revalidate without an LLM round-trip and posts the result as the assistant's first message.

**Sync direction:** all surfaces read from Mongo; all writes go through service layer (`getConnectionService()`, `AuthProfileService`, `ProjectToolService`) and trigger `invalidateProjectCaches`. Arch's `syncActiveDraftFrom*` helpers fire on Arch-driven mutations. The new `revalidate` action covers the case where the manual UI is the mutator.

## 12. Suggestion engine

Triggers (in order of cost):

1. **On overlay open** (`openOverlay()`): low-priority compute. Dispatches `computeIntegrationSuggestions(ctx, projectId, pageContext)` after the chat history loads. Surfaces 0–3 suggestions as `integration_suggestion_card`s in the welcome section.
2. **After turn-end** if `(agents, tools, drafts)` changed: re-run suggestions, debounced 5 seconds.
3. **Manual chip click**: a "Review integrations" chip in `ArchEntryState.tsx` calls the same helper.

`pageContext` (passed in) is used to bias suggestions per §8.5. Without it, suggestions are project-scoped; with it, they're page-relevant.

Suggestion sources:

- Unbound `TOOLS:` in agents (parsed from ABL DSL).
- Active drafts in `failed` state or `lastTestStatus === 'fail'` recent.
- Spec document `BlueprintOutput.integrations` if present.
- Cross-project learnings from `ArchLearningMemory` (low-priority for v1).

LLM cost control: 30-min Redis throttle key per `(tenantId, projectId)`. Manual chip click bypasses.

## 13. Verification / testing

### 13.1 Live test gate

`tools_ops:test` already exists. After tool creation, Arch calls it with sample input. Result types:

- `pass` → draft progresses; emit next-step card.
- `fail` (4xx auth) → `revalidate` runs; if auth profile is the issue, return to OAuth/SecretInput step.
- `fail` (5xx provider) → emit error card with retry / skip-test / report buttons. User can mark draft `complete` despite test fail with explicit confirmation: "Skip live test? You'll see this error in production."
- `timeout` → retry once; on second timeout, treat as `fail (5xx)`.

### 13.2 Test history

`IntegrationDraft.testHistory` (defined in §7.2) caps at 5 entries with FIFO eviction. Surfaced in the artifact card's expanded detail view.

### 13.3 Sanitization helper

New file: `apps/studio/src/lib/arch-ai/sanitize-tool-error.ts`.

Per CLAUDE.md "User-Facing Runtime Error Sanitization" rule, the spec previously referenced "the existing sanitizer" — but no such canonical helper exists in the codebase. This work creates one with explicit redaction rules:

- Strip tenant IDs, project IDs, full URLs containing query strings or basic-auth credentials (`https://user:pass@host/...`), full stack traces, internal hostnames matching `*.internal` / `*.svc.cluster.local`.
- Preserve HTTP status codes, error messages from the provider's own response body (capped at 500 chars), and a sanitized URL host (no path/query).
- Used by `tools_ops:test`, `integration_ops:run_tool_test`, `integration_ops:revalidate`, `auth_ops:validate`, and the new `connection_ops` actions.
- Logs keep raw context — only the user-visible string is sanitized.

Public API: `sanitizeToolError(rawError: unknown): { code: string, message: string, hint?: string }`.

## 14. Risks

| Risk                                                                       | Mitigation                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loop detector false positives during multi-step setup                      | Each tool call uses different args; if false positives arise, exclude `integration_ops`, `auth_ops`, `tools_ops`, `connection_ops` from the loop detector's call-similarity check                                                        |
| OAuth popup blocked by browser                                             | `useBatchOAuth` already handles this; surface to user with retry button                                                                                                                                                                  |
| Manual edit collision (user edits draft-referenced entity in another tab)  | `revalidate` action; `Confirmation` widget if structural conflict                                                                                                                                                                        |
| OAuth grant stale (EndUserOAuthToken expired/revoked)                      | `revalidate` flags this; re-runs OAuthLaunch                                                                                                                                                                                             |
| Two ArchOverlay sessions in different browser tabs same user, same project | Existing partial unique index on `arch_sessions` allows ONE non-terminal session per `(tenantId, userId, mode, projectId)`. The second overlay opens onto the same session. No collision.                                                |
| `apply_modification` fails partway through wiring                          | Transactional at agent level (whole DSL). User approves diff first; on apply failure, draft stays at `ready_to_apply`                                                                                                                    |
| Sensitive secrets leaking into chat / journal                              | `collect_secret` bypasses LLM context; `OAuthLaunch` only carries non-secret state. Audit log only carries metadata, never tokens. Verified via existing audit emitter sanitizer.                                                        |
| Suggestion engine LLM cost                                                 | 30-min throttle per `(tenantId, projectId)`; max 3 suggestions per call                                                                                                                                                                  |
| `connection_ops:resolve_options` requires live HTTP to workflow-engine     | If workflow-engine down, return `{ disabled: true, placeholder: 'Connector unavailable; please type the value manually.' }` and Arch falls back to plain `TextInput`                                                                     |
| **AuthProfile cache TTL (5min) staleness at runtime**                      | Edit to a profile may not be reflected in runtime tool execution for up to 5 min. Surfaced in test-failure UI: "Credentials may be stale; retry in 5 min." Deferred to v2: server-side cache-bust on profile update.                     |
| **AuthProfile shared name collision (multi-user)**                         | `PROFILE_NAME_COLLISION` error path with reuse-or-rename `Confirmation` widget. See §10.5.                                                                                                                                               |
| **Concurrent token refresh contention**                                    | Platform-wide 2s deadline; surfaces as "integration temporarily unavailable, retry." Sanitized.                                                                                                                                          |
| **Live session IR frozen vs. wiring edit**                                 | `apply_modification` only affects NEW agent sessions. Live production sessions keep pre-edit IR until session end. Caveat surfaced to user in the wiring success message. v2: explicit "force restart sessions" affordance after wiring. |
| **MCP server 5-min TTL**                                                   | New MCP server invisible to existing pod sessions for up to 5 min. Mitigation: new runtime-side cache invalidation hook (§8.9). With hook, new sessions started immediately after see the new server.                                    |
| **Newly-created ProjectTool invisible to in-flight live sessions**         | Live agent session that started before the tool was created keeps frozen IR. New sessions see the tool immediately (runtime resolves fresh per session start). Caveat surfaced in success message.                                       |
| **Two different users same project setting up same provider**              | Default visibility=shared causes collision at `auth_ops:create`. Handled by collision recovery in §10.5.                                                                                                                                 |

## 15. Open questions

None blocking. Remaining decisions are implementation details (exact heuristic registry for unbound-TOOLS provider matching, exact L2 card content) appropriate for the LLD phase.

## 16. v1 acceptance criteria

A user with an existing project can:

1. Open Arch overlay (already possible).
2. Type "set up Slack so ops_agent can post into #ops" and complete the entire flow inside Arch:
   - clientSecret collection
   - OAuth consent via popup (server-side creates oauth2_token automatically)
   - tool creation (HTTP-typed against Slack REST API)
   - channel selection via dynamic dropdown
   - agent wiring via diff approval (`propose_modification` → `apply_modification`)
   - live test
   - all without leaving the Arch overlay.
3. Open the Integrations artifact tab and see the Slack integration as a `complete` card with `auth ✓ tool ✓ wired ✓ test ✓`.
4. Edit the Slack auth profile via the Connections page, return to Arch, click the integration card, and have Arch revalidate (server-side, no LLM round-trip) and surface the changes in chat.
5. Receive a proactive suggestion when opening Arch on a project with unbound `TOOLS:` in any agent, biased by current page context.
6. Set up an internal REST API by pasting cURL, with API-key/bearer/basic/digest/azure_ad/custom_header/none auth, wired to one or more agents.
7. Set up an MCP server by URL, with bearer/api-key/oauth2_client_credentials auth, with selected tools imported as ProjectTools and wired to agents — visible to NEW agent sessions immediately (per §8.9 cache invalidation hook).
8. See the wiring caveat surfaced in the success message: live production sessions need to restart to pick up new wiring.

E2E tests (per CLAUDE.md "E2E Test Standards", no mocking, real HTTP):

- `e2e/arch-ai-integrations/saas-oauth.spec.ts` — S1 with mock OAuth provider
- `e2e/arch-ai-integrations/rest-api.spec.ts` — S5
- `e2e/arch-ai-integrations/mcp-server.spec.ts` — S7 including cache-invalidation verification
- `e2e/arch-ai-integrations/revalidate.spec.ts` — S3
- `e2e/arch-ai-integrations/suggestion.spec.ts` — S2 including page-context biasing
- `e2e/arch-ai-integrations/collision.spec.ts` — multi-user shared-profile collision recovery
- `e2e/arch-ai-integrations/sanitization.spec.ts` — verifies `sanitize-tool-error.ts` redactions

## 17. Files to create / modify

### New files

```
apps/studio/src/lib/arch-ai/
  components/arch/
    panels/IntegrationArtifactView.tsx                    ← list of drafts
    widgets/OAuthLaunch.tsx                               ← OAuth consent widget
    widgets/IntegrationPlan.tsx                           ← multi-step plan widget
    cards/IntegrationSuggestionCard.tsx                   ← suggestion card render
  tools/connection-ops.ts                                 ← NEW tool
  processors/integration-suggestions.ts                   ← suggestion engine helper
  integration-hints.ts                                    ← provider hint registry
  sanitize-tool-error.ts                                  ← user-facing error sanitizer

apps/studio/src/lib/
  runtime-mcp-cache-invalidation.ts                       ← Studio→runtime hook for §8.9

apps/studio/src/app/api/arch-ai/
  projects/[projectId]/integration-drafts/route.ts        ← GET list of drafts
  integration-drafts/[id]/resume/route.ts                 ← POST: server-side resume

packages/arch-ai/src/knowledge/cards/generated/
  integration-setup-workflow.ts                           ← NEW L2 card
  oauth-flow-primer.ts                                    ← NEW L2 card
  integration-failure-diagnosis.ts                        ← NEW L2 card

docs/superpowers/specs/2026-05-05-arch-ai-integrations-in-project-design.md   ← this file

e2e/arch-ai-integrations/                                 ← test suite
  saas-oauth.spec.ts
  rest-api.spec.ts
  mcp-server.spec.ts
  revalidate.spec.ts
  suggestion.spec.ts
  collision.spec.ts
  sanitization.spec.ts
```

### Modified files

```
apps/studio/src/lib/arch-ai/
  store/arch-ai-store.ts                                  ← extend ArtifactTabType;
                                                            add prefillMetadata + setter
  components/arch/overlay/ArchOverlay.tsx                 ← integration tab init effect;
                                                            prefillMetadata watcher
  components/arch/panels/InProjectArtifactPanel.tsx       ← add 'integration' tab case
  components/arch/widgets/WidgetRenderer.tsx              ← register OAuthLaunch +
                                                            IntegrationPlan cases
  components/arch/widgets/types.ts                        ← extend AskUserInput union
  components/arch/cards/index.ts                          ← register
                                                            IntegrationSuggestionCard
                                                            in KB_CARD_MAP
  ui/event-dispatcher.ts                                  ← extend syncWidgetArtifact
                                                            for new variant
  compat/v1-core-refs.ts                                  ← extend
                                                            V4InProjectCardEventName
                                                            union + dispatcher switch
  tools/auth-ops.ts                                       ← extend SUPPORTED_AUTH_TYPES
                                                            + REQUIRED_SECRETS;
                                                            collision handling
  tools/integration-ops.ts                                ← add 'revalidate' action;
                                                            include connectionIds
  tools/in-project-tools.ts                               ← register connection_ops
  tool-schemas.ts                                         ← Zod schemas for new tool
                                                            actions + widgets
  integration-draft-service.ts                            ← syncActiveDraftFromConnection;
                                                            connectionIds + testHistory
                                                            + lastTest* in DraftDocument
                                                            and IntegrationDraftSummary;
                                                            normalizeDraft
  processors/process-in-project.ts                        ← invoke suggestion engine on
                                                            session-open
  processors/runtime-support.ts                           ← projectStateSummaryLoader,
                                                            activeDraftSnapshotLoader

packages/arch-ai/src/types/
  tools.ts                                                ← add 'connection_ops' to
                                                            ToolName union;
                                                            add 'connection_ops' to
                                                            integration-methodologist
                                                            tool map
  turn-events.ts                                          ← extend widget variant enum
                                                            with 'integration_suggestion_card'
  page-context.ts                                         ← add 'integration_draft' to
                                                            entity type enum;
                                                            optional pageContext.user
                                                            (role/scopes)

packages/arch-ai/src/coordinator/
  content-router.ts                                       ← extend integration-methodologist
                                                            regex patterns (§8.7)
  coordinator-bridge.ts                                   ← extend
                                                            getPageContextSpecialistBias
                                                            for integration_draft entity

packages/arch-ai/src/prompts/
  index.ts                                                ← compose project-state
                                                            and active-draft sections
                                                            into composeInProjectPrompt

packages/arch-ai/src/knowledge/
  card-router.ts                                          ← register triggers for the 3
                                                            new L2 cards

packages/database/src/models/
  arch-integration-draft.model.ts                         ← add connectionIds[];
                                                            lastTestStatus / lastTestAt /
                                                            lastTestError; testHistory[]

apps/runtime/src/services/mcp/
  runtime-mcp-provider.ts                                 ← expose resetProjectInit
                                                            method (§8.9 hook)

apps/studio/src/lib/arch-ai/build-page-context.ts         ← projector for entity.metadata
                                                            on connections / tools /
                                                            mcp-servers / agents pages
```

### Untouched (deliberate)

- `packages/connectors/` core — Studio uses the existing `getConnectionService()` wrapper
- `packages/shared-auth-profile/` — auth profile resolution, encryption, OAuth state machine unchanged
- `apps/studio/src/components/connections/` — manual UI unchanged (only adds optional "Open in Arch" button)
- `apps/studio/src/components/auth-profiles/` — manual UI unchanged
- `apps/runtime/src/tools/` — runtime resolves ProjectTools fresh per session start; HTTP tool dispatch path unchanged

## 18. Rollout plan

Each phase is one or two commits, scoped to ≤40 files and ≤3 packages per CLAUDE.md commit-scope guard.

1. **Phase 0 — Runtime MCP cache invalidation hook** (small, isolated): expose `resetProjectInit` on `runtime-mcp-provider.ts`; add Studio→runtime helper `runtime-mcp-cache-invalidation.ts`. Tests: existing MCP tests unaffected.
2. **Phase 1 — Tooling foundation** (no UI surface yet): `auth_ops` extension (6 new types + collision handling), `connection_ops` new tool, `integration_ops:revalidate` action, `IntegrationDraft` schema additions, `sanitize-tool-error.ts`. Behind feature flag `ARCH_INTEGRATIONS_V1` (default off in prod, on in staging).
3. **Phase 2 — Knowledge + routing**: 3 new L2 cards, content-router regex extension, `pageContext` extensions, `getPageContextSpecialistBias` extension, `projectStateSummaryLoader`, `activeDraftSnapshotLoader`.
4. **Phase 3 — Widgets**: `OAuthLaunch` and `IntegrationPlan` widgets + Zod schemas + WidgetRenderer cases + SSE plumbing for `integration_suggestion_card`.
5. **Phase 4 — Artifact tab**: extend store (ArtifactTabType + prefillMetadata), add `IntegrationArtifactView`, register tab init effect, new GET drafts route, new resume route. Now usable.
6. **Phase 5 — Suggestion engine**: helper + trigger points + `integration_suggestion_card` rendering + integration-hints registry.
7. **Phase 6 — E2E tests**: full suite per CLAUDE.md standards (no mocks of platform components).
8. **Phase 7 — Flag flip**: enable `ARCH_INTEGRATIONS_V1` in prod after a week of staging soak.

## 19. Definition of done

- All v1 acceptance criteria pass in staging.
- All seven E2E tests pass with real HTTP servers, no mocks.
- Manual parity verified against §6 of the brainstorming HTML (`auth-parity.html`): every "v1 plan" row delivered (modulo enterprise auth types deferred to v2).
- No regressions in existing Arch onboarding or in-project flows (covered by existing test suites).
- `agents.md` updated in `packages/arch-ai/`, `apps/studio/src/lib/arch-ai/`, `apps/runtime/src/services/mcp/`, and `packages/database/`.
- `post-impl-sync` run: feature spec, test spec, and HLD updated; testing matrix updated.
- Cross-boundary field propagation per CLAUDE.md verified: every consumer of `IntegrationDraft` updated for the new fields, and a round-trip parity test asserts each field survives the DB→service→tool→UI hop.
- Jira tracking ticket closed.
