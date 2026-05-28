# Arch-AI A2A Support — Spec 1: CRUD + Wiring + Adaptiveness

- **Date:** 2026-05-05
- **Status:** IMPLEMENTED (2026-05-06) — Gate 1 ✅; Gates 2 (CI E2E) and 3 (manual UAT) deferred. See [`docs/sdlc-logs/arch-ai-a2a-spec1/post-impl-sync.log.md`](../../sdlc-logs/arch-ai-a2a-spec1/post-impl-sync.log.md).
- **Branch target:** `develop` (via feature branch from current `zarch/improvements`)
- **Scope:** Spec 1 of 3 in the "arch-ai supports A2A fully" track
- **Tracking:** [ABLP-162](https://jira/browse/ABLP-162) (continuation of arch-ai wire-tools track)

---

## 1. Motivation

The platform already has a complete external-agent registry (`external_agent_configs` collection, project-scoped CRUD, encryption-at-rest, on-demand `test-connection`, agent-card cache), full compiler IR support for `HANDOFF TO: name LOCATION: remote`, and runtime resolution via `resolveRemoteFromHandoff` + `enrichWithRegistryAuth`. Studio also has CRUD UI components.

Arch-AI is **invisible** to all of this. There is no `external_agent_ops` tool, no specialist guidance for external agents, no L2 knowledge card, no content-router pattern, and no UI signal that arch could help. Users today register external agents through a manual modal, then must paste DSL into agents themselves. MCP servers, by contrast, get a full chat-driven flow (`mcp_server_ops`).

Spec 1 closes that asymmetry for the IN_PROJECT phase: arch can register, test, and wire external agents end-to-end through chat, and is **adaptive enough to actually fire** when users mention external/remote/A2A agents.

This is the first of three specs:

| Spec              | Scope                                                                                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Spec 1 (this)** | A2A in arch-ai — CRUD + wiring + adaptiveness + auth-aware test                                                                                                   |
| Spec 2            | A2A topology + blueprint awareness — schema extension, planner, generation, diagnostics, INTERVIEW capture                                                        |
| Spec 3            | A2A backend + runtime hardening — delegate-path auth, server-side discover endpoint, error sanitizer, structured codes, inbound traces, OAuth, retries, streaming |

---

## 2. Goals & Non-Goals

### Goals

1. Arch can register, test, and wire an external agent end-to-end through chat — no Studio modal needed.
2. **Discovery-first**: user provides URL, arch fetches `/.well-known/agent-card.json` server-side (SSRF-guarded), auto-fills name/protocol/skills.
3. **Single-conversation**: `integration-methodologist` owns CRUD + `propose_modification` of HANDOFF block in caller agent. `CONTEXT.pass` fields populated from the discovered agent card's input schema where available.
4. **`test_connection` is auth-aware**: today the helper uses an unauthenticated client, so a bearer-token misconfig is invisible to the user. Spec 1 changes the helper to use `createA2AClientWithAuth` when `authConfig` is present.
5. **`EXTERNAL_AGENT_*` permission constants** typed in Studio — kill the `as any` casts on 5 route files.
6. **Adaptive routing**: arch reaches `external_agent_ops` reliably when users mention external/remote/A2A/partner agents.
7. **Live UI context**: users see which specialist is active and which transitions occurred.

### Non-goals (deferred — explicit Spec 2/3 territory)

| Concern                                                                                    | Spec                                                                  |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `TopologyAgentSchema` extension with `remote` field; `generate_topology` planner awareness | Spec 2                                                                |
| `Specification.externalAgents[]` capture during INTERVIEW                                  | Spec 2                                                                |
| Read-only `external_agent_ops` on `multi-agent-architect`, `abl-construct-expert`          | Spec 2 (depends on the schema extension above)                        |
| `external_agent_ops` in `PHASE_TOOL_MAP['BUILD']`                                          | Spec 2 (only useful after BLUEPRINT carries structured remote agents) |
| Diagnostic H-\* codes for remote handoffs                                                  | Spec 2                                                                |
| Server-side `discover` HTTP endpoint (new runtime route replacing executor fetch)          | Spec 3                                                                |
| Delegate-path + fan-out auth injection (today only HANDOFF path)                           | Spec 3                                                                |
| User-error sanitizer for remote-handoff failures                                           | Spec 3                                                                |
| Structured A2A error codes; inbound TraceEvents; OAuth wiring; retries; streaming          | Spec 3                                                                |

---

## 3. Decisions Recorded

| ID      | Question                                    | Decision                                                                                                                                                                | Source            |
| ------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Q1      | Primary chat flow                           | **Discovery-first single-shot** (option C) — arch calls `discover_preview` immediately on URL; falls back to multi-step manual flow if discovery fails                  | brainstorm        |
| Q2      | HANDOFF wiring ownership                    | **integration-methodologist owns CRUD + wiring** in one conversation (option B) — already has `read_agent`, `propose_modification`, `apply_modification`, `compile_abl` | brainstorm        |
| Q3      | v5 Knowledge Spine coordination             | **Branch** (option C) — fix `construct-catalog.ts` inline now AND amend v5 design doc with remote-agent fields paragraph                                                | brainstorm        |
| AUDIT-1 | Spec 1 has 4-of-5 dumb scenarios as drafted | Add 6 adaptiveness items (content-router patterns, L2 card, pageContext bias, header indicator, transition narration, routing trace)                                    | post-design audit |

---

## 4. Architecture

### 4.1 Happy-path flow (one conversation, one specialist)

```
USER (in IN_PROJECT phase, project page = arbitrary):
  "Connect my Salesforce agent at https://sf.example.com/agent
   so my Triage agent can hand off billing escalations."
   │
   ▼
CONTENT ROUTER (coordinator/content-router.ts)
   │  matches new pattern \b(connect\s+to\s+|external|remote|partner)\s+.*\bagent\b
   │  → integration-methodologist
   │  emits routing_decision trace event
   │
   ▼
INTEGRATION-METHODOLOGIST  [UI shows active-specialist indicator]
   │
   │  L2 KB CARD LOAD: knowledge/cards/external-agents (NEW)
   │   triggered by external/remote/a2a/partner pattern
   │   delivers full external-agent guidance into the system prompt
   │
   │  1. external_agent_ops(discover_preview, endpoint=<url>)
   │     └─ executor: SSRF-guarded fetch /.well-known/agent-card.json (5s)
   │     └─ returns {name, displayName, protocol, skills, inputSchema?, capabilities}
   │
   │  2. ask_user(SingleSelect, authType)        [skipped if card declares it]
   │
   │  3. collect_secret(authValue [+ authHeader for api_key])  [if auth needed]
   │
   │  4. external_agent_ops(create, name, endpoint, protocol, authType, flowId)
   │     └─ studio proxy → runtime POST /api/projects/:id/external-agents
   │     └─ encryptionPlugin encrypts authConfig at rest
   │
   │  5. external_agent_ops(test_connection, id, withAuth=true)
   │     └─ runtime POST /api/projects/:id/external-agents/:id/test-connection
   │     └─ NEW: discoverAgent uses createA2AClientWithAuth(...)
   │     └─ updates lastConnectionStatus + lastDiscoveredCard
   │
   │  6. emit ExternalAgentCard widget (status + skills + endpoint)
   │
   │  7. read_agent("Triage")
   │
   │  8. propose_modification("Triage", HANDOFF block synthesized from card)
   │     └─ CONTEXT.pass fields from card.inputSchema where available
   │     └─ LOCATION: remote   (ENDPOINT/PROTOCOL omitted: registry resolves)
   │
   │  9. ask_user(Confirmation)
   │ 10. apply_modification + compile_abl
   │
   ▼ DONE
```

### 4.2 Routing path — how arch reaches `external_agent_ops`

```
User text → process-message.ts → resolveTurnPlan() → mode-branch
                                        │
                          ┌─────────────┴─────────────┐
                  ONBOARDING (locked)         IN_PROJECT (this spec)
                          │                          │
                getSpecialistForPhase()      routeByContent(userInput)  ← Spec 1 patches here
                          │                          │
                          ▼                          ▼
              {INTERVIEW, BLUEPRINT,       Tries patterns in order:
                BUILD, CREATE}                external_agent_intent  (NEW)
              specialist locked              mcp_server  → integration-methodologist
              by phase                       salesforce  → integration-methodologist
                                             ...
                                             default: abl-construct-expert
                                                        │
                                                        ▼
                                             Tools = IN_PROJECT_SPECIALIST_TOOL_MAP
                                                        [specialist]
                                             Prompt = IN_PROJECT_GENERALIST_PROMPT
                                                      + L2 KB cards matching userInput  ← Spec 1 adds card
```

**Critical insight from audit**: in IN_PROJECT mode, the system prompt is the GENERALIST prompt regardless of routed specialist (`prompts/index.ts:102-104, 121` — the `specialist` param is `@deprecated`). Specialist-specific guidance reaches the LLM only via L2 knowledge cards selected by `card-router.ts` regex. This makes the new L2 `external-agents` card the **primary delivery mechanism** for arch's external-agent knowledge in IN_PROJECT, NOT the prompt-file edit.

### 4.3 Fallback paths

| Trigger                                | Behavior                                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Discovery 5xx / timeout / non-A2A card | Fall back to manual flow A — arch asks for name/protocol explicitly via `ask_user`                                |
| SSRF rejection                         | Sanitized "endpoint not reachable" message; no fetch attempted                                                    |
| 409 DUPLICATE_NAME                     | Arch suggests alternative name, asks user to confirm                                                              |
| Secret missing                         | Standard secret-flow handshake (existing pattern from `mcp_server_ops`)                                           |
| `test_connection` fails post-create    | Masked error displayed; **registration NOT rolled back** (`lastConnectionStatus='failed'`) — matches MCP behavior |
| `compile_abl` fails on HANDOFF block   | Arch unwinds proposal, rebuilds block, retries                                                                    |
| User edits existing config             | Re-runs steps 5+ to refresh card; auth re-test only if `authConfig` changed                                       |

### 4.4 Phase coverage matrix (this spec only)

| Phase      | Spec 1 effect                                                                                                                                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| INTERVIEW  | No effect — `Specification.externalAgents` capture deferred to Spec 2                                                                                                                                                             |
| BLUEPRINT  | Cosmetic only — `multi-agent-architect` prompt mentions `remote` 4th variant; NO structured topology change (Spec 2). Architect can narrate remote agents but `generate_topology` cannot encode them                              |
| BUILD      | Prompt-level only — `abl-construct-expert` HANDOFF goldens include remote example; `construct-catalog.ts` HANDOFF entry fixed + LOCATION block added (throwaway after v5). NO `external_agent_ops` in BUILD's tool set            |
| IN_PROJECT | **Full flow** — content router routes external-agent intent to integration-methodologist; L2 card delivers prompt guidance; `external_agent_ops` executes; `ExternalAgentCard` renders; HANDOFF wiring via `propose_modification` |
| CREATE     | No effect                                                                                                                                                                                                                         |

---

## 5. Components

### 5.1 Tool: `external_agent_ops`

#### Action enum (7 actions)

| Action             | Args                                                         | Returns                                                                                             | Notes                                                                    |
| ------------------ | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `list`             | —                                                            | `ExternalAgentConfigView[]`                                                                         | scoped by project                                                        |
| `read`             | `id`                                                         | `ExternalAgentConfigView`                                                                           | 404 → `{error:{code:'NOT_FOUND'}}`                                       |
| `discover_preview` | `endpoint`                                                   | `{name, displayName, protocol, skills, inputSchema?, capabilities, version}`                        | **no persistence**; SSRF-guarded executor fetch; 5s timeout              |
| `create`           | `name, displayName?, endpoint, protocol, authType, flowId?`  | persisted view                                                                                      | secret-flow handshake when `authType !== 'none'`                         |
| `update`           | `id, displayName?, endpoint?, protocol?, authType?, flowId?` | updated view                                                                                        | `name` immutable per runtime contract                                    |
| `delete`           | `id, confirmed?`                                             | `{success: true}`                                                                                   | dangerous-action gate; first call returns `{needsConfirmation, warning}` |
| `test_connection`  | `id, withAuth?` (default `true`)                             | updated view with refreshed `lastDiscoveredCard`, `lastConnectionStatus`, `lastConnectionLatencyMs` | **NEW**: when `withAuth=true`, runs through `createA2AClientWithAuth`    |

Skipped vs `mcp_server_ops`: no `import_tools` (skills aren't ProjectTools), no `test_tool` (external agents aren't tools).

#### Result shape (mirrors `McpServerOpsResult`)

```ts
{
  success?: boolean
  data?: ExternalAgentConfigView | ExternalAgentConfigView[] | DiscoveredCardPreview
  error?: { code: string; message: string }
  needsSecrets?: boolean
  flowId?: string
  requiredSecrets?: SecretField[]
  needsConfirmation?: boolean
  warning?: string
  message?: string
}
```

#### Schema location

Inline in `apps/studio/src/lib/arch-ai/tools/in-project-tools.ts` (matches established convention for `mcp_server_ops`, `tools_ops`, etc.). Strict mode (`.strict()`) — unknown args 400.

#### `discover_preview` server-side fetch (executor logic)

```
1. Validate URL: absolute, http/https only, no userinfo, no fragments
2. SSRF guard via @agent-platform/shared-kernel/security validateUrl()
   (same module the runtime uses)
3. fetch(`${endpoint}/.well-known/agent-card.json`, { signal: AbortSignal.timeout(5000) })
4. Parse JSON; basic AgentCard sanity check (`name` required)
5. Return { success: true, data: {...} }
   On any failure: { success: false, error: { code, message } }
   Codes: 'INVALID_URL' | 'SSRF_REJECTED' | 'TIMEOUT' | 'HTTP_ERROR' | 'INVALID_JSON' | 'INVALID_CARD'
```

`discoverAgent` from `packages/a2a/src/application/discover-agent.ts` is **not used** for Spec 1 — it requires injected ports designed for the runtime context. Spec 3 promotes discovery to a runtime endpoint that does use the full use case; Spec 1 keeps it executor-local.

### 5.2 Permissions

#### Studio constants — `apps/studio/src/lib/permissions.ts`

```ts
EXTERNAL_AGENT_READ: 'external_agent:read';
EXTERNAL_AGENT_CREATE: 'external_agent:create';
EXTERNAL_AGENT_UPDATE: 'external_agent:update';
EXTERNAL_AGENT_DELETE: 'external_agent:delete';
```

Replace `as any` casts in 5 route files:

- `apps/studio/src/app/api/projects/[id]/external-agents/route.ts:12,22`
- `apps/studio/src/app/api/projects/[id]/external-agents/[agentId]/route.ts:13,22,34`
- `apps/studio/src/app/api/projects/[id]/external-agents/[agentId]/test-connection/route.ts:11`

#### Arch-AI guards — `apps/studio/src/lib/arch-ai/guards.ts`

```ts
ACTION_TO_PERMISSION.external_agent_ops = {
  list: 'external_agent:read',
  read: 'external_agent:read',
  discover_preview: 'external_agent:read',
  create: 'external_agent:create',
  update: 'external_agent:update',
  delete: 'external_agent:delete',
  test_connection: 'external_agent:update',
};
DANGEROUS_ACTIONS.external_agent_ops = ['delete'];
```

### 5.3 Tool registration

| File                                                          | Change                                                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `packages/arch-ai/src/types/tools.ts:10-57`                   | Append `\| 'external_agent_ops'` to `ToolName` union (after `mcp_server_ops` line 41)       |
| `packages/arch-ai/src/types/tools.ts:250-269`                 | Add `'external_agent_ops'` to `IN_PROJECT_SPECIALIST_TOOL_MAP['integration-methodologist']` |
| `packages/arch-ai/src/tools/adapters/classification.ts:42-46` | Add `external_agent_ops: 'internal'`                                                        |
| `apps/studio/src/lib/arch-ai/tools/external-agent-ops.ts`     | **NEW** — `executeExternalAgentOps(input, ctx)`, ~430 lines mirroring `mcp-server-ops.ts`   |
| `apps/studio/src/lib/arch-ai/tools/in-project-tools.ts`       | Inline schema + `tool({...})` block parallel to `mcp_server_ops` at line 2304-2324          |

### 5.4 Adaptiveness — Content router

#### `packages/arch-ai/src/coordinator/content-router.ts:144-181`

Add new specialist intent rule at top of integration-methodologist patterns block (so it wins over generic `delegate` matches):

```ts
// External A2A agent intent — must come BEFORE multi-agent-architect's delegate pattern
{ pattern: /\b(external|remote|partner|third.party)\s+agent\b/i,
  specialist: 'integration-methodologist' },
{ pattern: /\bconnect\s+(to|with)\s+(?:our|my|the|their)?\s*\w+\s+agent\b/i,
  specialist: 'integration-methodologist' },
{ pattern: /\ba2a\s+(handoff|integration|connection|endpoint)\b/i,
  specialist: 'integration-methodologist' },
{ pattern: /\bregister\s+(?:an?|the)\s+(external|remote)\s+agent\b/i,
  specialist: 'integration-methodologist' },
{ pattern: /\bagent[- ]card\b/i,
  specialist: 'integration-methodologist' },
```

Also emit a routing trace event so routing decisions are observable in the journal/trace store. Exact mechanism (whether via `traceStore.emit`, `journalStore.append`, or a new SSE event) is decided in the implementation plan — the requirement is: every `routeByContent` decision produces a durable record `{specialist, matchedPattern, userInputSnippet}` inspectable by the diagnostician.

### 5.5 Adaptiveness — L2 Knowledge Card (primary IN_PROJECT delivery)

#### `packages/arch-ai/src/knowledge/cards/generated/external-agents.ts` (NEW)

Card content pulls from L3 index entries at `l3-index.json:685, 1423, 1465` plus the integration-methodologist external-agent workflow. Sections:

1. **What is an external agent?** — A2A-compatible agent registered in `external_agent_configs` outside the platform. ABL agents hand off to it via `LOCATION: remote`.
2. **Tool: `external_agent_ops`** — 7 actions with one-line descriptions and the standard secret-flow + dangerous-action gates.
3. **Discovery-first pattern** — always start with `discover_preview` if user provides a URL; the agent card at `/.well-known/agent-card.json` describes capabilities, skills, required auth.
4. **Secret-flow** — `create` first without `flowId`; if `requiredSecrets` returned, `collect_secret` per field, retry with same `flowId`. Never ask for tokens via plain `ask_user`.
5. **Wiring HANDOFF** — after `test_connection` succeeds, `read_agent` on caller, synthesize HANDOFF block from card.inputSchema, `propose_modification`, `Confirmation`, `apply_modification`, `compile_abl`. ENDPOINT and PROTOCOL omitted from DSL — registry resolves at runtime.
6. **HANDOFF remote DSL form** (golden):
   ```yaml
   HANDOFF:
     - TO: SalesforceAgent
       WHEN: intent.category == "billing_escalation"
       LOCATION: remote
       CONTEXT:
         pass: [user_id, conversation_summary]
   ```

#### `packages/arch-ai/src/knowledge/card-router.ts` — register card triggers

```ts
{ id: 'external-agents',
  triggers: [
    /\b(external|remote|partner|third.party)\s+agent\b/i,
    /\bLOCATION:\s*remote\b/i,
    /\ba2a\s+(handoff|integration|endpoint)\b/i,
    /\bagent[- ]card\b/i,
    /\bconnect\s+(to|with)\s+.*\s+agent\b/i,
  ],
  load: () => import('./cards/generated/external-agents.js') }
```

### 5.6 Adaptiveness — PageContext capability

#### `apps/studio/src/lib/arch-ai/components/arch/coordinator-bridge.ts:97-206`

Add capability + page mapping:

```ts
// in getPageContextSpecialistBias
'a2a_integration': 'integration-methodologist',
'external_agents':  'integration-methodologist',  // page name for short anaphoric turns
```

So when a user is on the Studio external-agents page and types "fix this", they land on integration-methodologist.

### 5.7 Adaptiveness — Live active-specialist indicator

#### `apps/studio/src/lib/arch-ai/components/arch/chat/ArchHeroStrip.tsx:40-71`

Compact variant gains a second-line indicator:

```tsx
<div className="text-xs text-muted-foreground">
  Phase: <PhaseBadge phase={phase} />
  {activeSpecialist && (
    <>
      {' · '}
      Specialist: <SpecialistChip specialist={activeSpecialist} />
    </>
  )}
</div>
```

Reads `useArchUIStore().currentSpecialist`. `SpecialistChip` reuses the icon + color mapping from existing `SpecialistBadge.tsx:80-93`.

### 5.8 Adaptiveness — Specialist transition narration

#### `apps/studio/src/lib/arch-ai/ui/event-dispatcher.ts:257-279`

When the SSE `specialist` event arrives and `prevSpecialist !== nextSpecialist`, emit a `ChatStatusMessage`:

```ts
if (prevSpecialist && prevSpecialist !== specialist) {
  appendStatusMessage({
    kind: 'specialist_transition',
    text: `Switching to ${SPECIALIST_DISPLAY[specialist]} for ${transitionReason(specialist)}…`,
    timestamp: Date.now(),
  });
}
```

`transitionReason` is a small lookup keyed on specialist (e.g. `integration-methodologist` → "tool/connection setup").

### 5.9 UI: `ExternalAgentCard` widget

#### `apps/studio/src/lib/arch-ai/components/arch/cards/ExternalAgentCard.tsx` (NEW)

Renders:

| Element        | Source field                            |
| -------------- | --------------------------------------- |
| Title          | `name` + `displayName`                  |
| Endpoint       | `endpoint` (truncated, copy-on-click)   |
| Protocol badge | `protocol` (a2a / rest)                 |
| Status badge   | `lastConnectionStatus` (green/red/gray) |
| Latency        | `lastConnectionLatencyMs`               |
| Skill chips    | `lastDiscoveredCard.skills[]`           |

Refactor in scope: extract `<SkillChips>` from `apps/studio/src/components/external-agents/ExternalAgentEditPanel.tsx:161-175` so the chat card and the edit panel share one component (lives at `apps/studio/src/components/external-agents/SkillChips.tsx`).

Modeled after `KBStatusCard.tsx` and `KBHealthCard.tsx`.

#### Emission

`external-agent-ops.ts` calls `emitCard({type: 'external_agent_card', data: ExternalAgentConfigView})` on `read | create | update | test_connection | list`. `apps/studio/src/lib/arch-ai/ui/event-dispatcher.ts:1495-1515` adds a case parallel to `kb_status_card`.

### 5.10 Specialist prompt edits — runtime effect varies by specialist

**Key finding from audit**: `composeInProjectPrompt()` (`prompts/index.ts:102-104, 121`) ignores its `specialist` parameter (`@deprecated`); the `IN_PROJECT_GENERALIST_PROMPT` is always used. ONBOARDING phases use phase-locked specialist prompts directly.

| Specialist file                | Where it runs                               | Where its prompt is read                                            | Runtime effect of Spec 1 edits                                                                                                                                     |
| ------------------------------ | ------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `integration-methodologist.ts` | IN_PROJECT only (routed via content-router) | **Bypassed by GENERALIST**                                          | **Zero today.** Edit kept for maintainability + future-proofing if the bypass is removed. **Primary IN_PROJECT delivery is the L2 card from §5.5.**                |
| `abl-construct-expert.ts`      | BUILD onboarding + IN_PROJECT (routed)      | Loaded directly during BUILD onboarding; bypassed in IN_PROJECT     | **Fires in BUILD onboarding only.** HANDOFF goldens reach BUILD-time agent generation.                                                                             |
| `multi-agent-architect.ts`     | BLUEPRINT onboarding + IN_PROJECT (routed)  | Loaded directly during BLUEPRINT onboarding; bypassed in IN_PROJECT | **Fires in BLUEPRINT onboarding only.** Used for narrative awareness of remote handoffs; does NOT change the structured `TopologyOutputSchema` (Spec 2 territory). |

#### `packages/arch-ai/src/prompts/specialists/integration-methodologist.ts` (low-priority, future-proofing)

- Update line 6 description: "...for agents using ABL's tool binding system **AND for connecting external A2A-compatible agents via the external-agent registry**."
- Add `external_agent_ops` to "Your Tools" list at line 18.
- New section parallel to "MCP Server Management" (line 160-174) titled **"External Agent Registry"** — same content as L2 card §5.5.
- New workflow example parallel to line 217-222: **"Workflow: Connect external agent and wire HANDOFF"**.

These edits do not fire in current architecture but mirror the L2 card content so a future fix to `composeInProjectPrompt` lights them up automatically. Acceptable parallel cost: ~80 lines of prompt text. If de-scope pressure exists, this single file's edit can be deferred to Spec 2 without functional impact.

#### `packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts:80-189` (fires in BUILD onboarding)

Add HANDOFF golden example showing remote variant:

```yaml
HANDOFF:
  - TO: SalesforceAgent
    WHEN: intent.category == "billing_escalation"
    LOCATION: remote
    CONTEXT:
      pass: [user_id, conversation_summary]
```

Note: ENDPOINT and PROTOCOL omitted because the registry resolves them; arch should NOT include them in DSL.

#### `packages/arch-ai/src/prompts/specialists/multi-agent-architect.ts:21-25` (fires in BLUEPRINT onboarding)

Add 4th handoff variant: "remote — target is registered in the project's external-agent registry; arch resolves endpoint, protocol, and auth at runtime". **Flag the limitation explicitly in the prompt text**: "BLUEPRINT topology output cannot durably encode remote nodes in v1 — `TopologyOutputSchema` has no `remote` field. Mention remote agents in plan text/conversation but do not promise downstream BUILD will produce structured remote handoffs. Structured remote-agent topology lands in Spec 2."

### 5.11 Knowledge layers — L0 platform-limits + Studio catalog

| Layer           | File                                                                      | Change                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| L0              | `packages/arch-ai/src/knowledge/platform-limits.ts:13-71`                 | Append "Remote agent handoffs" subsection (~6 lines) covering LOCATION/ENDPOINT/PROTOCOL/auth-via-registry/CONTEXT.pass typing         |
| L2 card         | `packages/arch-ai/src/knowledge/cards/generated/handoff-delegate.ts:1-50` | Regenerate from MDX `apps/docs-internal/.../multi-agent-and-supervisor.mdx`; port equivalent of L3 index line 685 content              |
| Studio catalog  | `apps/studio/src/lib/arch-ai/construct-catalog.ts:303-324`                | **Fix** wrong `CONTEXT: "string"` syntax + **add** LOCATION/ENDPOINT/PROTOCOL block with remote example. Throwaway after v5 (per Q3 C) |
| Studio handbook | `apps/studio/src/lib/arch-ai/handbook-reference.ts`                       | Add HANDOFF + LOCATION:remote section if file structure permits                                                                        |

### 5.12 Backend — auth-aware `test_connection`

| Layer                    | File                                                              | Change                                                                                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo helper              | `packages/shared/src/repos/external-agent-config-repo.ts:206-246` | `testExternalAgentConnection(endpoint, tenantId, allowPrivate, deps, authConfig?)` — when `authConfig` provided, set `deps.createClient = (baseUrl) => createA2AClientWithAuth(baseUrl, authConfig)` |
| Route                    | `apps/runtime/src/routes/external-agents.ts:321-375`              | After config lookup (line 338), parse `JSON.parse(encryptedAuthConfig)` for `{value, header?}` if `authType !== 'none'`, pass as 5th arg to helper                                                   |
| `discoverAgent` use case | `packages/a2a/src/application/discover-agent.ts`                  | **No change** — auth-agnostic by injection (caller chooses factory)                                                                                                                                  |

### 5.13 v5 Knowledge Spine amendment

Single paragraph appended to `docs/superpowers/specs/2026-05-05-arch-knowledge-spine-explain-first-design.md` Section 3 (`ConstructSpec`):

> **Remote-agent fields (added 2026-05-05).** When the catalog generator at `packages/compiler/scripts/build-knowledge-catalog.ts` lands, it must include the IR's `RemoteAgentLocation` shape on HANDOFF and DELEGATE constructs: `location: 'local' | 'remote'`, `endpoint?: string`, `protocol?: 'a2a' | 'rest'`, `auth?: { type, header? }` (no `value` — runtime-injected from the external-agent registry), `timeout?: string`. Registry-resolved fields (`endpoint`, `auth.value`) are not part of the DSL and must not appear in `ConstructSpec.fields[]`. Add an advisory `validCombinations` rule `HANDOFF_REMOTE_REQUIRES_REGISTRATION` that warns when `LOCATION: remote` references a name absent from `external_agent_configs` for the project. Lift "remote-agent reachable + registry-status fresh" into `runtimeFeasibilityChecks` in v1.5.

---

## 6. Data Flow (end-to-end, IN_PROJECT happy path)

```
[1] User text: "connect my SF agent at https://sf.example.com/agent..."
[2] process-message.ts → resolveTurnPlan() → IN_PROJECT branch
[3] routeByContent() — matches /\bconnect\s+to\s+.+\s+agent\b/i → integration-methodologist
[4] traceStore.emit('routing_decision', {specialist, matchedPattern, snippet})
[5] event-dispatcher receives 'specialist' SSE → emits 'Switching to Integration Methodologist…' ChatStatusMessage
[6] ArchHeroStrip second line updates: 'Specialist: Integration Methodologist'
[7] composeInProjectPrompt: GENERALIST + L2 cards (incl. external-agents card)
[8] LLM call with tools = IN_PROJECT_SPECIALIST_TOOL_MAP['integration-methodologist'] (incl. external_agent_ops)
[9] Tool: external_agent_ops(discover_preview, endpoint=...) →
       executor SSRF-validates → fetch /.well-known/agent-card.json → returns DiscoveredCardPreview
[10] LLM emits ask_user(SingleSelect, authType) [skipped if card declares auth requirements]
[11] Tool: collect_secret(authValue, [authHeader]) — flowId issued, secret stored in flow store
[12] Tool: external_agent_ops(create, ..., flowId) →
        executor consumes flow secrets → POST /api/projects/:id/external-agents (Studio proxy) →
        runtime route validates Zod → encryptionPlugin encrypts → Mongo insert
[13] Tool: external_agent_ops(test_connection, id, withAuth=true) →
        runtime route looks up config → parses encryptedAuthConfig (decrypted on read) →
        testExternalAgentConnection(..., authConfig) → discoverAgent with createA2AClientWithAuth →
        patchExternalAgentConnectionStatus updates lastConnectionStatus + lastDiscoveredCard
[14] emit ExternalAgentCard widget — event-dispatcher renders via case 'external_agent_card'
[15] Tool: read_agent("Triage") → returns full agent DSL
[16] LLM synthesizes HANDOFF block from card.inputSchema:
        - TO: <name>
          WHEN: <inferred from user intent>
          LOCATION: remote
          CONTEXT:
            pass: [<fields from inputSchema>]
[17] Tool: propose_modification("Triage", sections=[{construct: 'HANDOFF', content: ...}])
[18] LLM emits ask_user(Confirmation, "Add HANDOFF to <name> in Triage?")
[19] On confirm: Tool: apply_modification → Tool: compile_abl → success
[20] LLM final assistant message summarizes
```

---

## 7. Error Handling

| Failure                                   | Layer         | Surface                                                                                                         |
| ----------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------- |
| Discovery 5xx / timeout                   | executor      | Falls back to manual flow A; arch asks user for name+protocol                                                   |
| SSRF rejected                             | executor      | `error.code='SSRF_REJECTED'`, sanitized message; no fetch attempted                                             |
| 409 DUPLICATE_NAME                        | runtime route | `error.code='DUPLICATE_NAME'`; arch suggests alternative + retries                                              |
| Secret missing                            | executor      | `needsSecrets` + `flowId` returned; standard secret-flow handshake                                              |
| `test_connection` fails                   | runtime route | `lastConnectionStatus='failed'` persisted; arch surfaces sanitized error message; **does not roll back create** |
| `compile_abl` fails                       | tool          | Arch unwinds proposal via `dismiss_proposal`; rebuilds HANDOFF block; retries                                   |
| User edits existing config — auth changed | executor      | Re-runs `test_connection` with new authConfig                                                                   |
| RBAC denied                               | guards.ts     | `error.code='PERMISSION_DENIED'`, sanitized message                                                             |

User-facing errors at the assistant layer use the existing pattern: structured `error.code` is logged; only sanitized `message` is shown. (The full sanitizer for remote-handoff errors at runtime is a Spec 3 deliverable.)

---

## 8. Testing Strategy

Per `CLAUDE.md` "Test Architecture": no mocking platform components; pure functions where possible; HTTP-only E2E.

| Layer                     | Min count | Files                                                                                                                                                                     |
| ------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unit (pure functions)** | 4         | `apps/studio/src/__tests__/external-agent-ops/` — URL+SSRF validator, AgentCard sanity check, HANDOFF synthesizer (card.inputSchema → DSL block), routing-pattern matcher |
| **Integration**           | 5         | `executeExternalAgentOps` for all 7 actions against real Studio API + runtime + Mongo, mirroring `apps/runtime/src/__tests__/external-agents-integration.test.ts`         |
| **E2E**                   | 5         | `apps/studio/e2e/arch-external-agent.spec.ts` (NEW) — full chat-driven flow; real PM2 servers, no mocks                                                                   |
| **Auth round-trip**       | 1         | Closes the known gap at `external-agent-registry-resolution.test.ts:362-372` — use fixture `examples/external-a2a-bridge/external-vercel-agent`                           |
| **Routing patterns**      | 1         | `packages/arch-ai/src/__tests__/content-router-external-agent.test.ts` (NEW) — assert each new pattern routes to integration-methodologist                                |
| **Structural**            | 1         | Asserts no `as any` permission casts in the 5 external-agents route files (extends `apps/studio/src/__tests__/external-agents-api.test.ts`)                               |

### E2E scenarios (concrete)

1. **Happy path** — register, test, wire HANDOFF in caller agent, compile passes
2. **Discovery fails (timeout)** — fall back to manual flow A
3. **Duplicate name** — arch suggests alternative
4. **Auth failure post-create** — `lastConnectionStatus='failed'`, registration persists, arch surfaces sanitized error
5. **SSRF rejection on `discover_preview`** — sanitized message, no fetch attempt

### Adaptiveness verification (manual + automated)

- Type 5 trigger phrases ("connect to our X agent", "remote agent", "external agent for billing", "register an A2A agent", "agent card discovery") in IN_PROJECT chat — assert each routes to integration-methodologist via `routing_decision` trace
- Verify L2 card loads on each (knowledge-card load trace)
- Verify ArchHeroStrip second line updates on specialist switch
- Verify ChatStatusMessage appears on transition

---

## 9. File Inventory (concrete)

### New files (4)

| File                                                                      | Purpose                                  | Approx LOC |
| ------------------------------------------------------------------------- | ---------------------------------------- | ---------- |
| `apps/studio/src/lib/arch-ai/tools/external-agent-ops.ts`                 | Studio executor for `external_agent_ops` | ~430       |
| `apps/studio/src/lib/arch-ai/components/arch/cards/ExternalAgentCard.tsx` | Chat widget                              | ~80        |
| `apps/studio/src/components/external-agents/SkillChips.tsx`               | Shared skill-chips component             | ~30        |
| `packages/arch-ai/src/knowledge/cards/generated/external-agents.ts`       | L2 KB card                               | ~150       |

### Modified files (~18)

| File                                                                                       | Concern                                       |
| ------------------------------------------------------------------------------------------ | --------------------------------------------- |
| `packages/arch-ai/src/types/tools.ts`                                                      | ToolName union; specialist tool map           |
| `packages/arch-ai/src/tools/adapters/classification.ts`                                    | Tool kind                                     |
| `packages/arch-ai/src/coordinator/content-router.ts`                                       | New patterns + routing trace                  |
| `packages/arch-ai/src/knowledge/card-router.ts`                                            | New card triggers                             |
| `packages/arch-ai/src/knowledge/platform-limits.ts`                                        | L0 remote rules                               |
| `packages/arch-ai/src/knowledge/cards/generated/handoff-delegate.ts`                       | Regenerate w/ remote subsection               |
| `packages/arch-ai/src/prompts/specialists/integration-methodologist.ts`                    | New section + workflow                        |
| `packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts`                         | HANDOFF goldens                               |
| `packages/arch-ai/src/prompts/specialists/multi-agent-architect.ts`                        | 4th handoff variant + limitation flag         |
| `apps/studio/src/lib/arch-ai/tools/in-project-tools.ts`                                    | Schema + tool registration                    |
| `apps/studio/src/lib/arch-ai/guards.ts`                                                    | Permission map + dangerous actions            |
| `apps/studio/src/lib/permissions.ts`                                                       | EXTERNAL*AGENT*\* constants                   |
| `apps/studio/src/app/api/projects/[id]/external-agents/route.ts`                           | Remove `as any`                               |
| `apps/studio/src/app/api/projects/[id]/external-agents/[agentId]/route.ts`                 | Remove `as any`                               |
| `apps/studio/src/app/api/projects/[id]/external-agents/[agentId]/test-connection/route.ts` | Remove `as any`                               |
| `apps/studio/src/lib/arch-ai/components/arch/coordinator-bridge.ts`                        | PageContext bias                              |
| `apps/studio/src/lib/arch-ai/components/arch/chat/ArchHeroStrip.tsx`                       | Active-specialist indicator                   |
| `apps/studio/src/lib/arch-ai/ui/event-dispatcher.ts`                                       | ExternalAgentCard case + transition narration |
| `apps/studio/src/lib/arch-ai/construct-catalog.ts`                                         | HANDOFF fix + LOCATION block                  |
| `apps/studio/src/lib/arch-ai/handbook-reference.ts`                                        | LOCATION:remote section                       |
| `apps/studio/src/components/external-agents/ExternalAgentEditPanel.tsx`                    | Use shared SkillChips                         |
| `packages/shared/src/repos/external-agent-config-repo.ts`                                  | Auth-aware `testExternalAgentConnection`      |
| `apps/runtime/src/routes/external-agents.ts`                                               | Pass authConfig to helper                     |
| `docs/superpowers/specs/2026-05-05-arch-knowledge-spine-explain-first-design.md`           | Remote-fields amendment paragraph             |

**Total**: 4 new + ~18 modified = ~22 files. Three packages (`arch-ai`, `studio`, `shared`) plus `apps/runtime` plus a doc-only edit. Within commit-scope guard limits when split into focused commits.

### Suggested commit decomposition (6 commits)

1. `feat(shared): EXTERNAL_AGENT_* permission constants + remove as-any casts`
2. `feat(arch-ai): external_agent_ops tool token + classification + specialist tool map`
3. `feat(studio): external_agent_ops executor + Studio tool registration + UI widget`
4. `feat(arch-ai): adaptiveness — content-router patterns + L2 KB card + pageContext bias`
5. `feat(studio): live specialist indicator + transition narration + auth-aware test_connection`
6. `docs(arch-ai): v5 spine amendment + Spec 1 design doc`

Each commit ≤ 5-6 files, additive only, single concern. Compatible with the deletion-ratio guard and commit-scope guard hooks.

---

## 10. Open Risks

| Risk                                                                                             | Mitigation                                                                                                            |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| L2 card pattern matches too eagerly (e.g. "remote agent" in BLUEPRINT context)                   | Card only loads in IN_PROJECT mode; BLUEPRINT/BUILD have phase-locked specialists. Verify card-router phase-awareness |
| Content-router's new external-agent pattern overlaps with multi-agent-architect's `\bdelegate\b` | Place external-agent rule **before** delegate rule in `routeByContent` order                                          |
| `discover_preview` SSRF guard misses an attack vector                                            | Reuse `@agent-platform/shared-kernel/security` validator; mirror runtime's `getDevSSRFOptions` pattern                |
| HANDOFF synthesizer over-populates CONTEXT.pass from a permissive card schema                    | Cap at 5 fields; ask user to confirm via Confirmation widget                                                          |
| Specialist transition narration is too noisy                                                     | Only narrate when `prevSpecialist !== nextSpecialist` AND there was at least one prior assistant message              |
| `EXTERNAL_AGENT_*` constants conflict with existing typed permissions                            | Validate `StudioPermission` union remains backward-compatible (no string-literal-only callers break)                  |

---

## 11. Out of Scope (Spec 2 + Spec 3 Roadmap)

### Spec 2 (next): A2A topology + blueprint awareness

- `TopologyAgentSchema.remote?: { endpoint, protocol, authProfileRef? }` extension
- `generate_topology` planner aware of remote nodes (terminal, no internal gather/handoff plan)
- `agent-architecture-planner.ts` treats remote nodes as terminal
- `apps/studio/src/lib/arch-ai/abl-builder.ts:103-111` emits `LOCATION: remote` when `node.location === 'remote'`
- `Specification.externalAgents?: ExternalAgentRef[]` capture during INTERVIEW
- Read-only `external_agent_ops` access for `multi-agent-architect`, `abl-construct-expert`
- New diagnostic codes H-16 through H-19 for remote handoff invariants
- v5 Knowledge Spine generator extension to emit remote fields

### Spec 3 (last): A2A backend + runtime hardening

- Server-side `discover` HTTP endpoint (replaces executor fetch)
- `enrichWithRegistryAuth` extended to delegate-path + fan-out paths
- User-error sanitizer for remote-handoff failures
- Structured A2A error codes (replace concatenated JSON-RPC code in message)
- Inbound TraceEvents (today only logged)
- Outbound boundary metadata normalization (interactionContext, sessionMetadata, messageMetadata)
- OAuth wiring (today: stub)
- Inbound API-key auth (today: only Bearer accepted)
- Retries / circuit breakers on outbound
- `lastConnectionStatus` updated by handoff outcomes (today only by manual test)
- Streaming re-enabled (SDK async-generator workaround)

---

## Post-Implementation Reality Check (2026-05-06)

**Status:** Spec 1 shipped per design — `external_agent_ops` reachable end-to-end from arch
chat, ExternalAgentCard renders in the chat surface, content-router routes external-agent
intent to integration-methodologist, L2 `external-agents` card composed into IN_PROJECT
prompts, pageContext bias kicks in on the external-agents page, `routing_decision` span event
emitted at turn-start, auth-aware `test_connection` closes the silent-misconfig gap.

**Key code-side outcomes vs design:**

| Design claim                                                                                   | Reality                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `external_agent_ops` exposes `list/read/discover_preview/create/update/delete/test_connection` | ✅ All 7 actions implemented at `apps/studio/src/lib/arch-ai/tools/external-agent-ops.ts`                                                                                                                                                                  |
| `discover_preview` uses A2A SDK `DefaultAgentCardResolver` (or equivalent)                     | Native `fetch` + `assertUrlSafeForSSRF` + `redirect: 'manual'` + 256 KB streamed cap + Zod safety-net (R8 IMPROVEMENT option b — no new dep)                                                                                                               |
| `test_connection` runs through `createA2AClientWithAuth` when `withAuth=true`                  | ✅ Wired in both runtime call sites (POST `/:id/test-connection` + CREATE async background fetch); `EXTERNAL_AGENT_TEST_AUTH=false` env-var rollback documented in `apps/runtime/.env.example`                                                             |
| ExternalAgentCard mirrors KBStatusCard structure                                               | ✅ Same `event: ExternalAgentCardEvent` prop; shared `SkillChips` between card + EditPanel                                                                                                                                                                 |
| Content router gains 5 external-agent regexes at top of integration-methodologist rule         | ✅ `packages/arch-ai/src/coordinator/content-router.ts:90-96`                                                                                                                                                                                              |
| `routing_decision` span event emitted at turn-start                                            | ✅ `EVENT_ROUTING_DECISION = 'routing_decision'` emitted via `trace.event()` in `turn-engine.ts`. **Caveat:** no `setAttribute('arch.specialist')` because `TurnTraceRecorder` exposes no setAttribute API — head-of-trace OTel sampling needs a follow-up |
| pageContext bias for `page === 'external-agents'`                                              | ✅ `coordinator-bridge.ts:getPageContextSpecialistBias`                                                                                                                                                                                                    |
| Specialist transition narration in chat surface                                                | ✅ `event-dispatcher.ts:case 'specialist'` two-step pattern (capture prevSpecialist BEFORE setState; emit narration AFTER); SpecialistChip renders live in `ArchHeroStrip.CompactHeroStrip`                                                                |

**Spec 3 backlog seeded by R7/R8 audits** is captured in §8 of the LLD plus the Spec 3
forward-look sections of this design doc.
