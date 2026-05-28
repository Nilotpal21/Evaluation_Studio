# LLD: arch-ai A2A Spec 1 — CRUD + Wiring + Adaptiveness

- **Design Doc:** [`docs/superpowers/specs/2026-05-05-arch-ai-a2a-spec1-design.md`](../superpowers/specs/2026-05-05-arch-ai-a2a-spec1-design.md) (combines feature-spec + HLD + test-spec — brainstorm route)
- **SDLC Log:** [`docs/sdlc-logs/arch-ai-a2a-spec1/lld.log.md`](../sdlc-logs/arch-ai-a2a-spec1/lld.log.md)
- **Tracking:** ABLP-162
- **Branch target:** `develop` (from `zarch/newtools`)
- **Status:** DONE (implementation complete 2026-05-06; Gate 1 passed; Gates 2/3 deferred to CI/UAT)
- **Date:** 2026-05-05
- **Implementation log:** [`docs/sdlc-logs/arch-ai-a2a-spec1/implementation.log.md`](../sdlc-logs/arch-ai-a2a-spec1/implementation.log.md)
- **Post-impl sync:** [`docs/sdlc-logs/arch-ai-a2a-spec1/post-impl-sync.log.md`](../sdlc-logs/arch-ai-a2a-spec1/post-impl-sync.log.md)

---

## 1. Design Decisions

### 1.1 Decision Log

| #    | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Alternatives Rejected                                                                                                                                                                                                                                                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1  | Author L2 `external-agents` card by extending source MDX at `apps/docs-internal/content/abl-reference/multi-agent-and-supervisor.mdx` and running `pnpm abl:docs:generate`                                                                                                                                                                                                                                                                                                                 | Cards/generated/ directory is auto-generated (every file carries `// Auto-generated from docs-internal MDX` header); design §5.11 already requires regenerating `handoff-delegate.ts` from MDX, so MDX edits happen anyway; avoids two-source-of-truth drift                                                                                                                                                                                                                                                                                    | Hand-author the card directly in `cards/generated/` — rejected (drift risk, breaks regen invariant)                                                                                                                                                                                                                                               |
| D-2  | 5-phase decomposition: (1) permissions+types, (2) backend auth-aware test, (3) executor+UI, (4) adaptiveness, (5) indicators+prompts+docs                                                                                                                                                                                                                                                                                                                                                  | Each phase shippable in isolation; respects CLAUDE.md commit-scope guard (≤40 files, ≤3 packages); respects field-propagation hook                                                                                                                                                                                                                                                                                                                                                                                                              | 6-phase one-per-commit (granularity exceeds value); 2-phase backend/frontend split (phase 2 too big for one PR review)                                                                                                                                                                                                                            |
| D-3  | No feature flag                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | RBAC + intent-pattern gating + additive-only changes; the only behavior-changing surface (auth-aware test_connection) has per-call optional arg defaulting to safe                                                                                                                                                                                                                                                                                                                                                                              | GrowthBook flag (overkill for additive changes; new env var would require runtime config sync)                                                                                                                                                                                                                                                    |
| D-4  | Test-after with pure-function unit tests written first per phase                                                                                                                                                                                                                                                                                                                                                                                                                           | CLAUDE.md "Test Architecture" prefers pure-function tests; HTTP/E2E TDD against real PM2 is high-friction; `vi.mock` of internal packages is forbidden                                                                                                                                                                                                                                                                                                                                                                                          | Strict TDD per phase (incompatible with no-mocks rule); test-after entirely (loses pure-function correctness gate)                                                                                                                                                                                                                                |
| D-5  | Definition of done: Gate 1 (build+test) + Gate 2 (5 E2E + auth round-trip in CI) + Gate 3 (manual PM2 chat acceptance with logs/screenshots in `docs/sdlc-logs/<slug>/`)                                                                                                                                                                                                                                                                                                                   | Spec 1's motivation IS closing a silent-failure gap (auth-misconfig invisible to user); strictest acceptable level                                                                                                                                                                                                                                                                                                                                                                                                                              | Gate 1 only (insufficient for confidence); Gate 1+2 (no end-user verification of the closure)                                                                                                                                                                                                                                                     |
| D-6  | `routing_decision` emitted as **TurnTraceRecorder span event** at **engine turn-start** in `packages/arch-ai/src/engine/turn-engine.ts`, where the recorder is constructed and `trace.event({spanId, name, attributes})` is already used (e.g. `emitGateCheckTrace` at line 520-539). Routing metadata returned from `routeByContent` → `TurnPlan.routing` → `RunTurnInput.routing` → engine emission. Drops `userInputSnippet` (cross-user PII). **REVISED in R1, R2, RE-REVISED in R3.** | Three prior attempts failed: (R1) JournalEntry blocked by 5-kind union; (R2 v1) TraceRecorder at content-router site has no context; (R2 v2) `resolveTurnPlan` does not have `traceRecorder` either — the recorder is constructed inside `runTurn` AFTER `resolveTurnPlan` returns. R3 found this. The only architecture that works is to bubble routing metadata through `TurnPlan` → `RunTurnInput`, then emit at the engine turn-start point where the recorder exists. Mirrors the existing `emitGateCheckTrace` pattern in turn-engine.ts. | (a) JournalEntry — REJECTED R1; (b) TraceRecorder at routeByContent — REJECTED R2; (c) Drop from Spec 1 — REJECTED (adaptiveness observability requirement); (d) Plumb emitter callback through routeByContent — REJECTED (recorder doesn't exist that early); (e) TraceRecorder at resolveTurnPlan — REJECTED R3 (recorder not yet constructed). |
| D-7  | LLD targets `develop` from `zarch/newtools` branch                                                                                                                                                                                                                                                                                                                                                                                                                                         | Design doc's `zarch/improvements` reference is stale; current branch is 14 commits ahead of `develop` under ABLP-162                                                                                                                                                                                                                                                                                                                                                                                                                            | Re-branch from main (main has diverged on different track per `git merge-base`)                                                                                                                                                                                                                                                                   |
| D-8  | Add `EXTERNAL_AGENT_TEST_AUTH` env-var override at runtime route as belt-and-suspenders rollback for auth-aware test_connection                                                                                                                                                                                                                                                                                                                                                            | Hotfix becomes one env-var flip; no code change required to revert behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Code-only revert (acceptable but slower); per-tenant flag (overkill)                                                                                                                                                                                                                                                                              |
| D-9  | Extract `ICON_MAP` + `ROLE_STYLES` from `SpecialistBadge.tsx` into shared `specialist-style.ts`; build new `SpecialistChip` as compact variant                                                                                                                                                                                                                                                                                                                                             | Avoids duplication; both surfaces use identical iconography; design §5.7 already references "icon + color mapping from `SpecialistBadge.tsx:80-93`"                                                                                                                                                                                                                                                                                                                                                                                             | Reuse `SpecialistBadge` directly (margin/padding mismatch for inline use); duplicate maps in `SpecialistChip` (drift risk)                                                                                                                                                                                                                        |
| D-10 | Add `appendStatusMessage` action + `statusMessages: StatusMessage[]` (list slot) to `useArchUIStore`; keep existing `statusMessage: string \| null` for legacy                                                                                                                                                                                                                                                                                                                             | Design proposes API that doesn't exist (`appendStatusMessage`); existing single-slot can't represent transition history                                                                                                                                                                                                                                                                                                                                                                                                                         | Repurpose single slot (transitions overwrite each other; bad UX); skip transition narration entirely (defeats §5.8 goal)                                                                                                                                                                                                                          |
| D-11 | `discover_preview` validates JSON response with inline Zod subset schema; do NOT import `AgentCard` from `@a2a-js/sdk`                                                                                                                                                                                                                                                                                                                                                                     | Treats response as untrusted public-internet input; gives executor a stable return type independent of SDK evolution                                                                                                                                                                                                                                                                                                                                                                                                                            | Use SDK `AgentCard` type directly (couples executor to SDK; no validation of incoming JSON); use full `discoverAgent` use case (requires runtime port wiring per Spec 3)                                                                                                                                                                          |

### 1.2 Key Interfaces & Types

```typescript
// ─────────────────────────────────────────────────────────────────────────
// 1. external_agent_ops input schema (Zod, inline in in-project-tools.ts)
// ─────────────────────────────────────────────────────────────────────────
const externalAgentOpsInputSchema = z
  .object({
    action: z.enum([
      'list',
      'read',
      'discover_preview',
      'create',
      'update',
      'delete',
      'test_connection',
    ]),

    // Read/update/delete/test_connection
    id: z.string().min(1).optional(),

    // Discover/create/update — endpoint
    endpoint: z.string().url().optional(),

    // Create/update — config fields
    name: z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/)
      .max(128)
      .optional(),
    displayName: z.string().nullable().optional(),
    protocol: z.enum(['a2a', 'rest']).optional(),
    authType: z.enum(['none', 'bearer', 'api_key']).optional(),

    // Secret-flow handshake (auto-injected from secret store on retry)
    flowId: z.string().optional(),

    // Test_connection — defaults true (auth-aware)
    withAuth: z.boolean().optional(),

    // Delete — second-call confirmation
    confirmed: z.boolean().optional(),
  })
  .strict();

// ─────────────────────────────────────────────────────────────────────────
// 2. Result shape (mirrors McpServerOpsResult)
// ─────────────────────────────────────────────────────────────────────────
type ExternalAgentOpsResult = {
  success?: boolean;
  data?: ExternalAgentConfigView | ExternalAgentConfigView[] | DiscoveredCardPreview;
  error?: { code: ExternalAgentErrorCode; message: string };
  needsSecrets?: boolean;
  flowId?: string;
  requiredSecrets?: SecretField[];
  needsConfirmation?: boolean;
  warning?: string;
  message?: string;
};

type ExternalAgentErrorCode =
  | 'INVALID_URL'
  | 'SSRF_REJECTED'
  | 'TIMEOUT'
  | 'HTTP_ERROR'
  | 'INVALID_JSON'
  | 'INVALID_CARD'
  | 'NOT_FOUND'
  | 'DUPLICATE_NAME'
  | 'PERMISSION_DENIED'
  | 'TEST_FAILED'
  | 'UPSTREAM_ERROR';

// ─────────────────────────────────────────────────────────────────────────
// 3. DiscoveredCardPreview — Zod-validated subset of AgentCard
//    Treats /.well-known/agent-card.json response as untrusted input.
// ─────────────────────────────────────────────────────────────────────────
const discoveredCardPreviewSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().optional(),
  description: z.string().optional(),
  version: z.string().optional(),
  protocolVersion: z.string().optional(),
  protocol: z.literal('a2a'), // Hard-coded — Spec 1 only supports A2A discovery
  capabilities: z
    .object({
      streaming: z.boolean().optional(),
      pushNotifications: z.boolean().optional(),
      stateTransitionHistory: z.boolean().optional(),
    })
    .optional(),
  defaultInputModes: z.array(z.string()).optional(),
  defaultOutputModes: z.array(z.string()).optional(),
  skills: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
        inputModes: z.array(z.string()).optional(),
        outputModes: z.array(z.string()).optional(),
        inputSchema: z.unknown().optional(),
      }),
    )
    .optional(),
});
type DiscoveredCardPreview = z.infer<typeof discoveredCardPreviewSchema>;

// ─────────────────────────────────────────────────────────────────────────
// 4. StatusMessage list extension (D-10) — additive on useArchUIStore
// ─────────────────────────────────────────────────────────────────────────
interface ArchUIStore {
  // ... existing fields
  statusMessages: StatusMessage[]; // NEW (additive list slot)
  appendStatusMessage: (msg: StatusMessage) => void; // NEW
  statusMessage: string | null; // EXISTING (legacy single-slot, kept for back-compat)
  // ...
}

// ─────────────────────────────────────────────────────────────────────────
// 5. routing_decision trace span event (D-6, third revision in R3)
//
// Architecture: routing metadata bubbles up through three layers without
// emitting at any site that lacks a TurnTraceRecorder. Emission happens
// at engine turn-start in turn-engine.ts where the recorder is constructed
// and `trace.event(...)` is already used.
//
// Layer 1 — pure router:
//   routeByContent(userMessage: string): RoutingDecision
//
// Layer 2 — TurnPlan extension (resolveTurnPlan in coordinator-bridge.ts):
//   TurnPlan { ..., routing: RoutingDecision }
//
// Layer 3 — engine emission point (turn-engine.ts runTurn after recorder
//   construction, mirrors emitGateCheckTrace pattern at lines 520-539):
//   trace.event({ spanId: turnSpanId, name: 'routing_decision',
//                 attributes: input.routing })
// ─────────────────────────────────────────────────────────────────────────
type RoutingDecision = {
  specialist: AnySpecialistId;
  matchedPattern: string | null; // pattern.source from regex; null on default fallthrough
  pageContextBias?: string; // when bias kicked in for short anaphoric input
};

// Layer 2: extend TurnPlan
interface TurnPlan {
  // ... existing fields
  routing: RoutingDecision; // NEW (additive)
}

// Layer 3: extend RunTurnInput, then engine emits
interface RunTurnInput {
  // ... existing fields
  routing: RoutingDecision; // NEW (passed from TurnPlan)
}
// In turn-engine.ts runTurn() after TurnTraceRecorder is constructed (~line 297):
//   trace.event({
//     spanId: turnSpanId,
//     name: 'routing_decision',
//     attributes: {
//       specialist: input.routing.specialist,
//       matchedPattern: input.routing.matchedPattern,
//       pageContextBias: input.routing.pageContextBias,
//       // userInputSnippet intentionally omitted (cross-user PII risk)
//     },
//   });

// ─────────────────────────────────────────────────────────────────────────
// 6. Auth-aware test_connection helper signature (Phase 2)
// ─────────────────────────────────────────────────────────────────────────
async function testExternalAgentConnection(
  endpoint: string,
  tenantId: string,
  allowPrivate: boolean,
  deps: TestConnectionDeps, // R4 HIGH-1: actual type name
  authConfig?: { type: 'bearer' | 'api_key'; value: string; header?: string }, // NEW optional 5th arg
): Promise<{ reachable: boolean; agentCard?: AgentCard; latencyMs: number; error?: string }>;
```

### 1.3 Module Boundaries

| Module                                                                            | Responsibility                                                                                                                                                                  | Depends On                                                                        |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `packages/arch-ai/src/types`                                                      | `ToolName` union; `IN_PROJECT_SPECIALIST_TOOL_MAP`; classification adapter                                                                                                      | None (foundational types)                                                         |
| `packages/arch-ai/src/coordinator/content-router`                                 | Pure regex-based intent → specialist routing. Returns `RoutingDecision { specialist, matchedPattern, pageContextBias? }`. NO emission at this layer (third revision)            | `types/constants` (specialist IDs)                                                |
| `packages/arch-ai/src/knowledge/cards`                                            | L2 knowledge cards delivered to system prompt in IN_PROJECT mode                                                                                                                | `knowledge/card-router` for trigger registration; MDX source for generation       |
| `packages/arch-ai/src/journal`                                                    | Append-only event log of decisions, mutations, validations (NOT MODIFIED in Spec 1; listed for context only — D-6 third revision uses TraceRecorder spans, not journal entries) | None (writer is a port consumed by consumers)                                     |
| `packages/arch-ai/src/prompts/specialists`                                        | Specialist-prompt files (loaded only during ONBOARDING phases per audit finding)                                                                                                | None                                                                              |
| `apps/studio/src/lib/arch-ai/tools/external-agent-ops`                            | Studio-side executor for `external_agent_ops`; HTTP-proxies to Studio routes; secret-flow handshake; SSRF-guarded discover_preview                                              | `tools/secret-store`; `@agent-platform/shared-kernel/security`; Studio API routes |
| `apps/studio/src/lib/arch-ai/tools/in-project-tools`                              | Vercel-AI tool() registration glue                                                                                                                                              | `tools/external-agent-ops`; `tools/guards`                                        |
| `apps/studio/src/lib/arch-ai/components/arch/cards/ExternalAgentCard`             | Chat widget rendering ExternalAgentConfigView                                                                                                                                   | Shared `SkillChips` component; `ui/types` ChatMessage shape                       |
| `apps/studio/src/components/external-agents/SkillChips`                           | Shared skill chip list (used by EditPanel + ExternalAgentCard)                                                                                                                  | None                                                                              |
| `apps/studio/src/lib/arch-ai/ui/{store,event-dispatcher}`                         | Zustand store; SSE event → store mutation dispatch                                                                                                                              | `ui/types` (StatusMessage, ChatMessage)                                           |
| `apps/studio/src/lib/arch-ai/components/arch/chat/{ArchHeroStrip,SpecialistChip}` | Live phase + active-specialist indicator                                                                                                                                        | `useArchUIStore.currentSpecialist`; shared `specialist-style`                     |
| `apps/studio/src/lib/permissions`                                                 | StudioPermission union + EXTERNAL*AGENT*\* constants                                                                                                                            | None (foundational)                                                               |
| `packages/shared/src/repos/external-agent-config-repo`                            | `testExternalAgentConnection` helper (now auth-aware)                                                                                                                           | `@agent-platform/a2a` (createA2AClientWithAuth)                                   |
| `apps/runtime/src/routes/external-agents`                                         | HTTP CRUD + test-connection (now passes authConfig to helper)                                                                                                                   | `external-agent-config-repo`; encryption plugin                                   |

### 1.4 Architectural Compliance Notes

- **Tenant isolation (CLAUDE.md core invariant 1):** every Mongo query in `external-agent-config-repo` already includes tenantId via plugin (`tenantIsolationPlugin`). Spec 1 changes don't bypass this.
- **Centralized auth (invariant 2):** Studio routes use `withRouteHandler({ permissions, requireProject })`; runtime route uses `requireProjectPermission`. Spec 1 only adds `EXTERNAL_AGENT_*` strings to typed constants — no custom JWT verification.
- **Stateless distributed (invariant 3):** secret-store uses Redis (`packages/shared-kernel/src/redis/redis-pool.ts`-backed) with in-memory fallback for dev; no pod-local truth.
- **Traceability (invariant 4):** new `routing_decision` TraceRecorder span event (NOT JournalEntry — see D-6 R3 third revision) emitted at engine turn-start in `packages/arch-ai/src/engine/turn-engine.ts` `runTurn()` (~line 297, mirrors `emitGateCheckTrace` pattern at lines 520-539) where the `TurnTraceRecorder` is constructed and active turn `spanId` exists; no new ad-hoc logging.
- **Compliance (invariant 5):** `encryptedAuthConfig` field already encrypts via `encryptionPlugin`; Spec 1 does not change the secret-storage path.
- **Performance (invariant 6):** discover_preview has 5s timeout; test_connection has 5s timeout (existing); no unbounded retries.
- **No console.log:** all logging via `createLogger('arch-ai/external-agent-ops')` per CLAUDE.md.
- **No swallowed catches:** every `catch` block either logs + propagates or returns structured `error.code` per CLAUDE.md hook.
- **Structured error envelopes (CLAUDE.md key rule):** every executor return path is `{success, data?, error?: {code, message}}` per `mcp-server-ops.ts:52-62` mirror.

---

## 2. File-Level Change Map

### 2.1 New Files (6)

| File                                                                      | Purpose                                                                  | LOC Estimate |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------ |
| `apps/studio/src/lib/arch-ai/tools/external-agent-ops.ts`                 | Studio executor `executeExternalAgentOps(input, ctx)`                    | ~430         |
| `apps/studio/src/lib/arch-ai/components/arch/cards/ExternalAgentCard.tsx` | Chat widget                                                              | ~80          |
| `apps/studio/src/components/external-agents/SkillChips.tsx`               | Shared skill-chips component (extracted from EditPanel)                  | ~30          |
| `packages/arch-ai/src/knowledge/cards/generated/external-agents.ts`       | L2 KB card (auto-generated from MDX per D-1)                             | ~150         |
| `apps/studio/src/lib/arch-ai/components/arch/chat/specialist-style.ts`    | Shared `ICON_MAP` + `ROLE_STYLES` extracted from `SpecialistBadge` (D-9) | ~70          |
| `apps/studio/src/lib/arch-ai/components/arch/chat/SpecialistChip.tsx`     | Compact specialist indicator (D-9)                                       | ~40          |

(Total: 6 new files, not 4 as in design — additions per oracle D-9 and D-1 split.)

### 2.2 Modified Files (27)

| File                                                                                       | Change Description                                                                                                      | Risk |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ---- |
| `packages/arch-ai/src/types/tools.ts`                                                      | Append `\| 'external_agent_ops'` to `ToolName` union; add to integration-methodologist tool map                         | Low  |
| `packages/arch-ai/src/tools/adapters/classification.ts`                                    | Add `external_agent_ops: 'internal'`                                                                                    | Low  |
| `packages/arch-ai/src/coordinator/content-router.ts`                                       | Add 5 new external-agent intent patterns; change `routeByContent` return type to `RoutingDecision` (D-6 third revision) | Med  |
| `packages/arch-ai/src/knowledge/card-router.ts`                                            | Register `external-agents` card with 5 trigger patterns                                                                 | Low  |
| `packages/arch-ai/src/knowledge/platform-limits.ts`                                        | Append "Remote agent handoffs" subsection (~6 lines)                                                                    | Low  |
| `packages/arch-ai/src/knowledge/cards/generated/handoff-delegate.ts`                       | Regenerate from MDX with remote subsection (D-1)                                                                        | Low  |
| `packages/arch-ai/src/prompts/specialists/integration-methodologist.ts`                    | Add `external_agent_ops` to "Your Tools" + new section + workflow (low-priority — does not fire today, future-proofing) | Low  |
| `packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts`                         | Add HANDOFF golden remote example (fires in BUILD onboarding)                                                           | Low  |
| `packages/arch-ai/src/prompts/specialists/multi-agent-architect.ts`                        | Add 4th handoff variant + limitation flag (fires in BLUEPRINT onboarding)                                               | Low  |
| `apps/studio/src/lib/arch-ai/tools/in-project-tools.ts`                                    | Inline Zod schema + `tool({...})` block parallel to mcp_server_ops at line 2304-2324                                    | Med  |
| `apps/studio/src/lib/arch-ai/guards.ts`                                                    | Add `external_agent_ops` to ACTION_TO_PERMISSION + DANGEROUS_ACTIONS                                                    | Low  |
| `apps/studio/src/lib/permissions.ts`                                                       | Add 4 EXTERNAL*AGENT*\* constants                                                                                       | Low  |
| `apps/studio/src/app/api/projects/[id]/external-agents/route.ts`                           | Replace `as any` with EXTERNAL_AGENT_READ/CREATE                                                                        | Low  |
| `apps/studio/src/app/api/projects/[id]/external-agents/[agentId]/route.ts`                 | Replace `as any` (3 sites)                                                                                              | Low  |
| `apps/studio/src/app/api/projects/[id]/external-agents/[agentId]/test-connection/route.ts` | Replace `as any`                                                                                                        | Low  |
| `packages/arch-ai/src/engine/coordinator-bridge.ts`                                        | Add `'a2a_integration'` capability + `'external-agents'` page bias (R6 CRITICAL-2 — HYPHEN matches sidebar id)          | Low  |
| `apps/studio/src/lib/arch-ai/components/arch/chat/ArchHeroStrip.tsx`                       | Add second-line `<SpecialistChip>` reading `useArchUIStore.currentSpecialist`                                           | Low  |
| `apps/studio/src/lib/arch-ai/components/arch/chat/SpecialistBadge.tsx`                     | Refactor: import `ICON_MAP` + `ROLE_STYLES` from new `specialist-style.ts`                                              | Low  |
| `apps/studio/src/lib/arch-ai/ui/types.ts`                                                  | Add `kbCards`-equivalent variant: `external_agent_card` to ChatMessage card union (or keep generic)                     | Low  |
| `apps/studio/src/lib/arch-ai/ui/store.ts`                                                  | Add `statusMessages: StatusMessage[]` + `appendStatusMessage(msg)` action (D-10)                                        | Med  |
| `apps/studio/src/lib/arch-ai/ui/event-dispatcher.ts`                                       | Add `case 'external_agent_card'` parallel to kb_status_card; add transition narration on `specialist` event change      | Med  |
| `apps/studio/src/lib/arch-ai/construct-catalog.ts`                                         | Fix wrong `CONTEXT: "string"` syntax + add LOCATION/ENDPOINT/PROTOCOL block (throwaway after v5)                        | Low  |
| `apps/studio/src/lib/arch-ai/handbook-reference.ts`                                        | Add HANDOFF + LOCATION:remote section if file structure permits                                                         | Low  |
| `apps/studio/src/components/external-agents/ExternalAgentEditPanel.tsx`                    | Replace inline skill-chip rendering at line 161-175 with `<SkillChips>` import                                          | Low  |
| `packages/shared/src/repos/external-agent-config-repo.ts`                                  | Add optional `authConfig` 5th arg to `testExternalAgentConnection`; switch client factory                               | Med  |
| `apps/runtime/src/routes/external-agents.ts`                                               | Parse `encryptedAuthConfig`; pass authConfig to helper; gate via `EXTERNAL_AGENT_TEST_AUTH` env (D-8)                   | Med  |
| `apps/docs-internal/content/abl-reference/multi-agent-and-supervisor.mdx`                  | Add remote handoff content (sources for both `handoff-delegate.ts` regen and new `external-agents.ts` card per D-1)     | Low  |
| `docs/superpowers/specs/2026-05-05-arch-knowledge-spine-explain-first-design.md`           | Append "Remote-agent fields" paragraph near `interface ConstructSpec` (§4.2 ~line 182)                                  | Low  |

(Total: 27 modified files. Three packages affected: `arch-ai`, `studio`, `shared`. Plus `runtime` app + docs. Cross-package fan-out within commit-scope guard limits when split into 5 phase-aligned commits.)

### 2.3 Deleted Files

None.

### 2.4 Test Files

| File                                                                                            | Type        | Purpose                                                                                   |
| ----------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| `apps/studio/src/__tests__/external-agent-ops/url-ssrf-validator.test.ts` (NEW)                 | Unit        | Pure function: URL validation + SSRF wrapper                                              |
| `apps/studio/src/__tests__/external-agent-ops/agent-card-sanity.test.ts` (NEW)                  | Unit        | Pure function: Zod schema accepts/rejects expected/unexpected JSON                        |
| `apps/studio/src/__tests__/external-agent-ops/handoff-synthesizer.test.ts` (NEW)                | Unit        | Pure function: card.inputSchema → HANDOFF DSL block                                       |
| `apps/studio/src/__tests__/external-agent-ops/tool-result-shape.test.ts` (NEW)                  | Unit        | Shape conformance: every action returns canonical envelope                                |
| `packages/arch-ai/src/__tests__/content-router-external-agent.test.ts` (NEW)                    | Unit        | Each new pattern routes to integration-methodologist                                      |
| `apps/runtime/src/__tests__/external-agents-integration.test.ts` (EXTEND)                       | Integration | Add 5 scenarios per design §8 row 2 (full executor against real Mongo + Studio + runtime) |
| `apps/runtime/src/__tests__/external-agent-registry-resolution.test.ts` (EXTEND, lines 362-372) | Integration | Auth round-trip — close known gap                                                         |
| `apps/studio/src/__tests__/external-agents-api.test.ts` (EXTEND)                                | Structural  | Assert no `as any` permission casts in 3 route files (6 as-any casts total)               |
| `apps/studio/e2e/arch-external-agent.spec.ts` (NEW)                                             | E2E         | 5 scenarios per design §8 row 3 (Playwright, real PM2 servers, no mocks)                  |

---

## 3. Implementation Phases

CRITICAL: Each phase is independently deployable AND independently testable. Each phase commits as a single PR (or 2 small PRs if review-load demands).

### Phase 1: Permissions + Types Foundation

**Goal**: Land the typed permission constants, ToolName union extension, and classification mapping. System still runs because the new identifier is unused — no behavior change.

**Tasks**:

1.1. Add `EXTERNAL_AGENT_READ`, `EXTERNAL_AGENT_CREATE`, `EXTERNAL_AGENT_UPDATE`, `EXTERNAL_AGENT_DELETE` constants to `apps/studio/src/lib/permissions.ts`. Verify the StudioPermission union remains backward-compatible (existing string-literal callers must still type-check).

1.2. Replace `as any` permission casts in 3 external-agents route files (6 casts total): `route.ts:12,22`, `[agentId]/route.ts:13,22,34`, `[agentId]/test-connection/route.ts:11`. Each cast becomes typed reference to one of the new constants.

1.3. Append `| 'external_agent_ops'` to `ToolName` union at `packages/arch-ai/src/types/tools.ts:10-57` (after `mcp_server_ops` line 41).

1.4. Add `'external_agent_ops'` to `IN_PROJECT_SPECIALIST_TOOL_MAP['integration-methodologist']` at `packages/arch-ai/src/types/tools.ts:250-269`.

1.5. Add `external_agent_ops: 'internal'` to `packages/arch-ai/src/tools/adapters/classification.ts:42-46`.

1.6. Add `external_agent_ops` entry to `apps/studio/src/lib/arch-ai/guards.ts` `ACTION_TO_PERMISSION` map (7 actions → 4 permissions). Add `delete` to `DANGEROUS_ACTIONS.external_agent_ops`.

1.7. **REMOVED in R1** — JournalEntry extension obsolete (D-6 revised; routing_decision now a trace span event, no type addition needed).

1.8. **Verify dual ToolName alignment** (R1 HIGH-2): `tools/adapters/classification.ts` exports `keyof typeof TOOL_CLASSIFICATION` as a separate `ToolName` shape. Adding `external_agent_ops: 'internal'` keeps the two aligned. Add an inline comment in `types/tools.ts` near the `ToolName` union noting "Every entry must also have a kind in `tools/adapters/classification.ts:TOOL_CLASSIFICATION`" so future tool additions don't drift.

1.9. **Backfill missing classification entries** (R2 MEDIUM-4): pre-existing drift — 6 tools exist in `types/tools.ts:10-57` ToolName union but missing from `tools/adapters/classification.ts:TOOL_CLASSIFICATION`: `variable_ops`, `integration_ops`, `agent_ops`, `deployment_ops`, `testing_ops`, `analytics_ops`. Add `'internal'` kind for each so `toolKind('agent_ops')` doesn't throw at registration. Document in commit message that this closes pre-existing drift.

1.10. **Export `ExternalAgentConfigView`** (R2 CRITICAL-5; corrected import path per R6 CRITICAL-4): the type is currently inline-private in `apps/runtime/src/routes/external-agents.ts:120-137`. Studio executor + ExternalAgentCard need it. Move definition to `packages/shared/src/types/external-agent.ts`. **R6 CRITICAL-4 FIX**: `@agent-platform/shared/types/external-agent` is NOT an exported subpath in `packages/shared/package.json`. Choose option (c) — re-export through `@agent-platform/shared/repos` (matches existing `NormalizedExternalAgentConfig` consumer pattern at `apps/runtime/src/routes/external-agents.ts:32-36`). Imports become `import type { ExternalAgentConfigView } from '@agent-platform/shared/repos';`. Also: **R6 HIGH-3** — migrate test-file copies of the type at `apps/runtime/src/__tests__/external-agents-integration.test.ts:72` and `apps/runtime/src/__tests__/external-agent-registry.e2e.test.ts:81` to import from shared; otherwise local copies will silently diverge.

1.11. Write structural test `external-agents-api.test.ts` extension asserting no `as any` casts in the 3 route files (6 as-any casts total).

**Files Touched**:

- `apps/studio/src/lib/permissions.ts` — add 4 constants
- `apps/studio/src/app/api/projects/[id]/external-agents/route.ts` — remove 2 `as any`
- `apps/studio/src/app/api/projects/[id]/external-agents/[agentId]/route.ts` — remove 3 `as any`
- `apps/studio/src/app/api/projects/[id]/external-agents/[agentId]/test-connection/route.ts` — remove 1 `as any`
- `packages/arch-ai/src/types/tools.ts` — extend union + tool map
- `packages/arch-ai/src/tools/adapters/classification.ts` — register kind
- `apps/studio/src/lib/arch-ai/guards.ts` — permission map
- `packages/arch-ai/src/tools/adapters/classification.ts` — backfill missing entries (6 tools per R2 MEDIUM-4)
- `packages/shared/src/types/external-agent.ts` — export `ExternalAgentConfigView` (R2 CRITICAL-5; create file if needed)
- `apps/runtime/src/routes/external-agents.ts` — import view type from shared (move from inline)
- `apps/studio/src/__tests__/external-agents-api.test.ts` — extend structural test

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/studio --filter=@agent-platform/arch-ai` succeeds with 0 errors
- [ ] `pnpm test --filter=@agent-platform/studio -- external-agents-api` passes (structural test green)
- [ ] `tsc --noEmit` (incremental hook) passes for every file touched
- [ ] `git grep -n 'as any' apps/studio/src/app/api/projects/\[id\]/external-agents/` returns zero matches
- [ ] `EXTERNAL_AGENT_*` constants resolved by every consumer (verified by tsc)
- [ ] `ToolName` union has `external_agent_ops`; `IN_PROJECT_SPECIALIST_TOOL_MAP['integration-methodologist']` includes it (verified by `git grep`)
- [ ] `pnpm test:report` shows no new failures vs baseline

**Test Strategy**:

- **Unit (test-first)**: none in this phase (pure structural changes; no functions added).
- **Integration**: none (no behavior change).
- **Structural**: extend `external-agents-api.test.ts` to assert zero `as any` casts.

**Rollback**: Single git-revert of the phase commit. Backward-compat preserved because old string-literal permission usage still type-checks.

---

### Phase 2: Backend Auth-Aware test_connection

**Goal**: Make `testExternalAgentConnection` actually exercise the configured auth so bearer-token misconfiguration becomes observable. Add `EXTERNAL_AGENT_TEST_AUTH` env-var rollback gate.

**Tasks**:

2.1. Modify `packages/shared/src/repos/external-agent-config-repo.ts:206-246` to accept optional `authConfig?: { type: 'bearer' | 'api_key'; value: string; header?: string }` as 5th arg. When provided, set `deps.createClient = (baseUrl) => createA2AClientWithAuth(baseUrl, authConfig)`. When absent, current unauthenticated client used.

2.2. Update `apps/runtime/src/routes/external-agents.ts` — TWO call sites need authConfig (R6 HIGH-1 — CREATE handler background fetch was missed):

**(a) Explicit `POST /:id/test-connection` handler at line 321-375:**

- After config lookup (line 338), check `process.env.EXTERNAL_AGENT_TEST_AUTH !== 'false'` (D-8 belt-and-suspenders). If `'false'`, emit `log.warn('External agent test_connection bypassing auth via EXTERNAL_AGENT_TEST_AUTH=false rollback', {tenantId})` so the rollback path is observable in logs (R1 HIGH-3).
- **`encryptedAuthConfig` shape composition** (R1 CRITICAL-2): the stored JSON is `{value, header?}` ONLY (per `external-agents.ts:224` and `ExternalAgentConfig.model.ts:51`). The `type` field comes from `config.authType` (separate model field). When env-gate passes AND `config.authType !== 'none'` AND `config.encryptedAuthConfig`, parse the encrypted JSON: `const parsed = JSON.parse(config.encryptedAuthConfig) as {value: string; header?: string};` then compose: `const authConfig = { type: config.authType, value: parsed.value, header: parsed.header };`. Pass this to the helper.
- If env-gate fails, pass `undefined` (current behavior).

**(b) CREATE handler's async background fetch at line 229-238 (R6 HIGH-1)**: this call also runs `testExternalAgentConnection` immediately after CREATE returns — without authConfig today. Apply the SAME composition logic so `lastConnectionStatus` reflects auth-aware behavior from the very first record. Otherwise: bearer agent created → background unauth fetch sets `connected` → user clicks Test → status flips to `failed` (auth-aware). That's the silent-failure mode Spec 1 is closing.

**Document `EXTERNAL_AGENT_TEST_AUTH`** in `apps/runtime/.env.example` (or nearest equivalent — verify the file exists in Phase 2 preflight). Default unset = enabled. Set to `'false'` for emergency rollback.

2.3. Add the auth round-trip integration test extending `apps/runtime/src/__tests__/external-agent-registry-resolution.test.ts:362-372` (the explicitly-noted gap). Use `examples/external-a2a-bridge/external-vercel-agent` as fixture for a real bearer-protected A2A endpoint. Assert: pre-Spec-1 path (no authConfig) returned `reachable: true` despite bad token; post-Spec-1 path (with authConfig) returns `reachable: false` with auth error.

2.4. Add test verifying `EXTERNAL_AGENT_TEST_AUTH=false` falls through to legacy unauthenticated path (regression guard).

**Files Touched**:

- `packages/shared/src/repos/external-agent-config-repo.ts` — extend signature
- `apps/runtime/src/routes/external-agents.ts` — pass authConfig + env gate
- `apps/runtime/src/__tests__/external-agent-registry-resolution.test.ts` — close known gap
- `apps/runtime/src/__tests__/external-agents-integration.test.ts` — add env-gate fallback test

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/shared --filter=@agent-platform/runtime` succeeds
- [ ] Auth round-trip test passes against fixture A2A agent — bad token surfaces as `reachable: false` with auth-error message
- [ ] `EXTERNAL_AGENT_TEST_AUTH=false` env gate test passes — falls through to unauth path
- [ ] No regression in existing `external-agent-registry-resolution.test.ts` scenarios (33+ assertions remain green)
- [ ] No console.log added (CLAUDE.md hook check)
- [ ] `findExternalAgentConfigByName` unchanged — no consumer of repo changes
- [ ] Rollback verified manually: setting `EXTERNAL_AGENT_TEST_AUTH=false` and re-running test-connection returns success against bad-token endpoint (= legacy behavior)

**Test Strategy**:

- **Unit (test-first)**: not applicable — change is in I/O wrapper.
- **Integration (test-first)**: write the auth round-trip extension test BEFORE the helper change. Assert the failure mode the new code catches.
- **E2E**: not in this phase (defer to Phase 5 E2E suite).

**Rollback**: Two paths — (a) flip `EXTERNAL_AGENT_TEST_AUTH=false` env var (one-line config, no code change); (b) git-revert the phase commit (helper signature change is backward-compat — `authConfig` optional).

---

### Phase 3: Studio Executor + Tool Registration + UI Card

**Goal**: After this phase, `external_agent_ops` is callable end-to-end from arch chat. ExternalAgentCard renders. Tool not yet adaptively reachable (Phase 4 closes that).

**Tasks**:

3.1. Create `apps/studio/src/lib/arch-ai/tools/external-agent-ops.ts` (new ~430-line file). Mirror `mcp-server-ops.ts:1-432` structure.

**R7 RISK #3 — `flowId` scoping invariants** (must be asserted in code + tests): `consumeFlowSecrets(flowId)` from `tools/secret-store.ts` MUST enforce: (a) `flowId` keyed by `(tenantId, userId, sessionId)` — cross-session/user/tenant redemption rejected; (b) single-use atomic GETDEL (already per oracle B2); (c) TTL ≤ 5 minutes (matches existing 15-min default; consider tightening for PKCE-flow security parity); (d) tool-name namespace partitioning so a `flowId` for `mcp_server_ops` cannot be redeemed by `external_agent_ops` (read `secret-store.ts` to confirm key structure; if not partitioned, add a `toolName` discriminator OR rely on `requiredSecrets` schema mismatch to 400). **Add EXT-6 integration test** asserting cross-session reuse returns `null`/error and cross-tool reuse 400s.

Mirror structure:

- `ExternalAgentOpsResult` type
- `executeExternalAgentOps(input, ctx)` entry function
- 7 action handlers: `list`, `read`, `discover_preview`, `create`, `update`, `delete`, `test_connection`
- Permission gate via `checkToolPermission('external_agent_ops', action, ctx)` (mirror line 321 of mcp-server-ops)
- Dangerous-action gate (delete) returning `{needsConfirmation: true, warning}` on first call (mirror line 336)
- Secret-flow handshake using `consumeFlowSecrets(flowId)` from `./secret-store` (D-2). When `authType !== 'none'` and no `flowId`, return `{needsSecrets: true, flowId, requiredSecrets: [...]}`
- HTTP boundary: `apiFetch` to `${NEXTAUTH_URL}/api/projects/:projectId/external-agents/...` with `Authorization: Bearer ${ctx.authToken}` (R6 MED-6 — required, mirrors `mcp-server-ops.ts:258`), `X-Tenant-Id`, `X-Project-Id`, `X-User-Id` headers and 30s timeout (mirror lines 248-266)
- All return paths use `{success?, data?, error?: {code, message}, ...}` envelope
- Each successful read/create/update/test_connection emits `emitCard({type: 'external_agent_card', data: ExternalAgentConfigView})` (mirror in-project-tools.ts:2570-2583)

  3.2. **R8 IMPROVEMENT**: instead of hand-writing fetch + JSON parse, reuse `@a2a-js/sdk`'s port-free `DefaultAgentCardResolver.resolve(baseUrl, path?)` (defaults to `/.well-known/agent-card.json`) — saves ~30-50 LOC, inherits SDK's redirect/content-type handling. Composition:

1.  **Pre-flight SSRF gate**: use `new SsrfEndpointValidator().validate(endpoint, allowPrivate)` from `@agent-platform/a2a` (R6 HIGH-2 — matches the runtime route's pattern at `apps/runtime/src/routes/external-agents.ts:172`; both ultimately call `assertUrlSafeForSSRF` from `@agent-platform/shared-kernel/security` so they're functionally equivalent, but using the same wrapper as the runtime keeps the executor canonical). Return `{error: {code: 'SSRF_REJECTED'}}` on rejection.
2.  **Resolver call**: `await new DefaultAgentCardResolver().resolve(endpoint)` from `@a2a-js/sdk/client`. Wrap in `Promise.race` against `AbortSignal.timeout(5000)` for the 5s timeout.
3.  **Payload cap (R1 MED-5)**: SDK's resolver doesn't cap response size. Either (a) wrap the SDK fetch with `safeFetch` from `@agent-platform/shared-kernel/security` if it accepts a custom fetcher, OR (b) add a `Content-Length` pre-check before reading body (>262144 = 256KB → abort).
4.  **Zod safety-net validation (D-11)**: SDK returns `AgentCard` typed but not runtime-validated; pass through the Zod subset schema from §1.2 to defend against malformed responses (D-11 invariant).
5.  **Prod-safe SSRF (R1 MED-7)**: confirm `getDevSSRFOptions()` returns prod-safe options when `NODE_ENV=production` — read `packages/shared-kernel/src/security/ssrf-validator.ts` to verify private-IP rejection is enforced in prod.

**Alternative**: inject the platform's `discoverAgent` use case from `packages/a2a/src/application/discover-agent.ts` with simple stubs (`tracing: noopTracing`, `validator: validateUrlForSSRF`, `createClient: A2AClient.createFromUrl`). ~25 LOC of wiring. Picks up tracing parity with `external-agent-config-repo` for free. Equivalent in functionality; choose the simpler one at impl time.

3.3. Pure function: extract `parseAndValidateAgentCard(json: unknown): {ok: true, card: DiscoveredCardPreview} | {ok: false, error: ExternalAgentErrorCode}` using the Zod subset schema (D-11).

3.4. Inline `externalAgentOpsInputSchema` Zod definition in `apps/studio/src/lib/arch-ai/tools/in-project-tools.ts` near line 104 (matching mcp_server_ops convention).

3.5. Register `external_agent_ops: tool({...})` block in same file near line 2304-2324 — wrap dynamic import of executor + inject `{projectId, sessionId, user, authToken}` from context.

3.6. Create `apps/studio/src/components/external-agents/SkillChips.tsx` — extract chip-rendering JSX from `ExternalAgentEditPanel.tsx:161-175`. Props: `{skills: Array<{ id, name }>, max?: number, showOverflow?: boolean}`.

3.7. Update `apps/studio/src/components/external-agents/ExternalAgentEditPanel.tsx` to import + use `<SkillChips>` instead of inline JSX.

3.8. Create `apps/studio/src/lib/arch-ai/components/arch/cards/ExternalAgentCard.tsx`. **R2 HIGH-2 FIXES** — match KBStatusCard patterns precisely:

- First line: `'use client'` directive
- Export shape: `memo(ExternalAgentCardImpl)` wrap
- Conditional classes: `clsx` (not template literals)
- Prop name: `event: ExternalAgentCardEvent` (NOT `data` — match KBStatusCard's `event` convention)
- Type location: define `ExternalAgentCardEvent` in `packages/arch-ai/src/types/sse-events.ts` (R3 CRITICAL-4 — `events.ts` does NOT exist; the actual file is `sse-events.ts` where `KBStatusCardEventSchema`, `KBStatusCardEvent`, etc. live at lines 353-448). **R6 MED-1 FIX**: define a strongly-typed payload Zod schema mirroring `ExternalAgentConfigView` fields (id, name, displayName, endpoint, protocol, authType, authConfigured, lastConnectionStatus, lastConnectionLatencyMs, lastDiscoveredCard) — do NOT use `data: z.unknown()` (other card events in the file use strongly-typed payloads). Export `ExternalAgentCardEvent` alongside the other 6 card-event types. Re-exported via `packages/arch-ai/src/types/index.ts:50-62` and `packages/arch-ai/src/index.ts:64-69`. Add to discriminated-union `ArchSSEEventSchema` (lines 450-484). Import in card component: `import type { ExternalAgentCardEvent } from '@agent-platform/arch-ai';`
- i18n strategy: hardcoded English labels matching KBStatusCard (NOT i18n via `t()` like ExternalAgentEditPanel — chat cards are always English in current codebase). Document in commit message that i18n alignment with EditPanel is a follow-up.
- Renders: title (`name` + `displayName`) + endpoint (truncated, copy-on-click) + protocol badge + status badge + latency + `<SkillChips skills={event.lastDiscoveredCard?.skills ?? []}>`.
- Read `apps/studio/src/lib/arch-ai/components/arch/cards/KBStatusCard.tsx` end-to-end before implementing to mirror exact structure.

  3.9. Update `apps/studio/src/lib/arch-ai/ui/event-dispatcher.ts:1495-1515` — add `case 'external_agent_card':` parallel to existing kb_status_card. **R1 HIGH-1 + R2 HIGH-3 FIXES** — discriminator extension is required at multiple layers:

1.  **Source-of-truth `update.variant` literal-string union**: `event-dispatcher.ts:1495` is `switch (update.variant)` against a discriminated union (`'kb_status_card' | 'upload_progress_card' | 'search_results_card' | 'kb_health_card' | 'connector_status_card' | 'doc_processing_card'`). The source-of-truth type lives at **`packages/arch-ai/src/types/sse-events.ts`** (R3 confirmed `events.ts` does NOT exist). Add `'external_agent_card'` to that Zod enum (`turn-events.ts:220-233` per R3 verification, also re-exported via `sse-events.ts`).
2.  **Inline `isKbCardMessage` type guard**: extend to accept the new variant (or rename to `isCardMessage` with broader discriminator).
3.  **Dispatcher case**: `case 'external_agent_card':` parallel to `kb_status_card` — appends to `kbCards[]` (ChatMessage already accepts generic-shape).

3.10. Update `apps/studio/src/lib/arch-ai/ui/types.ts:81` if needed — `kbCards?: Array<{type: string; [key: string]: unknown}>` is already generic per oracle B4 / verification. If a stricter discriminated union is in use, extend it to include the new `'external_agent_card'` literal.

3.11. Write 4 unit tests (test-first per D-4) in `apps/studio/src/__tests__/external-agent-ops/`:

- `url-ssrf-validator.test.ts` — accepts http(s), rejects `file://`, rejects 169.254.x.x in non-dev mode, accepts in dev mode. **R7 RISK #2 additions**: also assert (a) **DNS rebinding** defense — when `validateUrlForSSRF` resolves a hostname to a public IP, the subsequent connect must use that pinned IP (not re-resolve); (b) **redirect-follow** rejection — `discover_preview` fetch sets `redirect: 'manual'` or rejects 3xx responses (test with a stub server returning 302 to 127.0.0.1); (c) **IPv6 private ranges** — reject `fc00::/7`, `fd00::/8`, `::1`, `fe80::/10`. If the existing `validateUrlForSSRF` doesn't cover any of these, escalate to a `shared-kernel` improvement task (out of Spec 1 scope) AND apply a defensive wrapper in the executor.
- `agent-card-sanity.test.ts` — Zod schema accepts well-formed AgentCard JSON, rejects missing `name`, rejects invalid skills array
- `handoff-synthesizer.test.ts` — given card.inputSchema, produces valid HANDOFF DSL block
- (4th) `tool-result-shape.test.ts` — shape conformance: every action returns the canonical envelope

  3.12. Write 5 integration tests extending `apps/runtime/src/__tests__/external-agents-integration.test.ts`. **R4 HIGH-2 FIX**: existing file already has `INT-1` through `INT-7` (verified — `INT-7: Input validation` describe block at line 354). New scenarios should use `EXT-1` through `EXT-5` (executor-scoped) to avoid collision and signal these are executor-level (not route-level) tests:

- EXT-1 to EXT-5: list/read/create/update/delete via `executeExternalAgentOps` end-to-end
- Each uses MongoMemoryServer + real Express auth/RBAC/SSRF chain + MockA2ARemoteAgent (existing pattern; no `vi.mock` of internal packages per CLAUDE.md "Test Architecture")

**Files Touched**:

- `apps/studio/src/lib/arch-ai/tools/external-agent-ops.ts` — NEW
- `apps/studio/src/lib/arch-ai/tools/in-project-tools.ts` — schema + tool registration
- `apps/studio/src/components/external-agents/SkillChips.tsx` — NEW
- `apps/studio/src/components/external-agents/ExternalAgentEditPanel.tsx` — use shared SkillChips
- `apps/studio/src/lib/arch-ai/components/arch/cards/ExternalAgentCard.tsx` — NEW
- `apps/studio/src/lib/arch-ai/ui/event-dispatcher.ts` — add card case
- `apps/studio/src/lib/arch-ai/ui/types.ts` — verify card variant
- `apps/studio/src/__tests__/external-agent-ops/url-ssrf-validator.test.ts` — NEW
- `apps/studio/src/__tests__/external-agent-ops/agent-card-sanity.test.ts` — NEW
- `apps/studio/src/__tests__/external-agent-ops/handoff-synthesizer.test.ts` — NEW
- `apps/studio/src/__tests__/external-agent-ops/tool-result-shape.test.ts` — NEW
- `apps/runtime/src/__tests__/external-agents-integration.test.ts` — extend with 5 scenarios

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/studio --filter=@agent-platform/arch-ai` succeeds
- [ ] All 4 unit tests pass
- [ ] All 5 integration tests pass against real Mongo + runtime
- [ ] Manual smoke: invoke `external_agent_ops(list)` from a stub harness — returns project's external agents
- [ ] Manual smoke: invoke `external_agent_ops(discover_preview, endpoint=https://...vercel-agent...)` — returns parsed AgentCard
- [ ] Manual smoke: ExternalAgentCard renders correctly when emitted via `kbCards[]` (Storybook OR live PM2)
- [ ] No `vi.mock` of any internal package per CLAUDE.md "Test Architecture" hook
- [ ] No `console.log` per CLAUDE.md hook
- [ ] EditPanel still renders skills correctly post-refactor (visual regression — manual screenshot diff)
- [ ] `SkillChips` imported in both EditPanel + ExternalAgentCard (no duplication)

**Test Strategy**:

- **Unit (test-first)**: 4 pure-function tests written BEFORE the executor implementation (D-4 exception). Each test encodes the exact contract.
- **Integration (test-after)**: 5 scenarios written alongside or after executor — must use real services per CLAUDE.md.
- **E2E**: deferred to Phase 5.

**Rollback**: git-revert phase commits. ExternalAgentCard is additive (no consumer breaks). SkillChips refactor: revert restores inline JSX in EditPanel (independent of the rest).

---

### Phase 4: Adaptiveness Layer

**Goal**: Arch reliably routes external-agent intent to integration-methodologist; L2 KB card delivers prompt guidance in IN_PROJECT mode; pageContext bias kicks in on the external-agents page. After this phase, the tool from Phase 3 is actually reachable in real conversations.

**Tasks**:

4.1. Add 5 new specialist intent patterns to `packages/arch-ai/src/coordinator/content-router.ts:144-181` BEFORE `multi-agent-architect`'s `\bdelegate\b` rule. **R3 CRITICAL-3 FIX**: `RouteRule` shape is `{patterns: RegExp[], specialist}` (plural — multiple regexes per rule). Choose ONE of:

- **Option A (recommended, matches existing convention)**: extend the existing `integration-methodologist` rule's `patterns: [...]` array (currently 30+ patterns) with the 5 new regexes. Place them at top of that array if intent-priority matters.
- **Option B (separate rule, ordered before delegate)**: create a new `RouteRule` with `{patterns: [r1, r2, r3, r4, r5], specialist: 'integration-methodologist'}` and insert it BEFORE the multi-agent-architect rule.

Patterns to add (either option):

```ts
/\b(external|remote|partner|third.party)\s+agent\b/i,
/\bconnect\s+(to|with)\s+(?:our|my|the|their)?\s*\w+\s+agent\b/i,
/\ba2a\s+(handoff|integration|connection|endpoint)\b/i,
/\bregister\s+(?:an?|the)\s+(external|remote)\s+agent\b/i,
/\bagent[- ]card\b/i,
```

For `routeByContent`'s matched-pattern capture (task 4.2(a)), the `pattern.source` is from the inner-loop regex within the matched rule's `patterns` array (the specific regex that fired), not the outer rule.

4.2. **Emit `routing_decision` at engine turn-start** (R3 CRITICAL-2 — third revision; R2 v2 was wrong because `resolveTurnPlan` does NOT have `traceRecorder` either — it's constructed inside `runTurn` AFTER `resolveTurnPlan` returns). Four-layer plumbing:

(a) **Modify `routeByContent` signature** in `packages/arch-ai/src/coordinator/content-router.ts:278`. Change return type from `AnySpecialistId` to `RoutingDecision { specialist, matchedPattern, pageContextBias? }`. Capture `pattern.source` of the matched rule's matching regex (or `null` on default fallthrough). Update all existing callers to read `.specialist`.

(b) **Extend `TurnPlan`** in `packages/arch-ai/src/engine/coordinator-bridge.ts`. Add `routing: RoutingDecision` field; `resolveTurnPlan` populates from `routeByContent` result. Pure data passthrough — no recorder needed at this layer.

(c) **Extend `RunTurnInput`** in `packages/arch-ai/src/engine/turn-engine.ts:203-257`. Add `routing: RoutingDecision`.

(c.5) **Update ALL THREE Studio call sites** that construct `RunTurnInput` from `TurnPlan` (R4 CRITICAL-2; R6 CRITICAL-3 — verified there are 3 call sites, not 2):

1.  `apps/studio/src/lib/arch-ai/message-handler.ts:1721`
2.  `apps/studio/src/lib/arch-ai/processors/process-in-project.ts:774`
3.  `apps/studio/src/lib/arch-ai/processors/process-message.ts:680`

Each must forward `turnPlan.routing → RunTurnInput.routing`. If `message-handler.ts` is missed, every turn driven through that handler silently drops the routing trace event — the exact wiring gap the LLD is preventing. **R6 HIGH-4 alternative**: mark `routing?: RoutingDecision` (optional) on `RunTurnInput` with a safe default `null` in the engine emit code path; otherwise every test fixture instantiating `RunTurnInput` (e.g. `packages/arch-ai/src/__tests__/engine/turn-engine-interview.test.ts:169`) breaks. Recommend optional with default-null + lint to enforce all 3 production call sites populate it.

(d) **Emit at engine turn-start** in `turn-engine.ts` `runTurn()` AFTER the `TurnTraceRecorder` is constructed (~line 297-309). **R6 MED-2 + MED-3 FIXES**: (a) add `export const EVENT_ROUTING_DECISION = 'routing_decision' as const;` to `packages/arch-ai/src/engine/trace/event-names.ts` (matches existing constants like `EVENT_RETRY`, `EVENT_BUDGET_EXHAUSTED`); reference the constant rather than string literal. (b) The pattern actually mirrors **inline span events** (e.g. `EVENT_BUDGET_EXHAUSTED` at turn-engine.ts:622), NOT `emitGateCheckTrace` (which uses `startSpan`/`endSpan` for child spans). Code:

```ts
// Span event: point-in-time routing decision
trace.event({
  spanId: turnSpanId,
  name: EVENT_ROUTING_DECISION, // constant from event-names.ts
  attributes: {
    specialist: input.routing.specialist,
    matchedPattern: input.routing.matchedPattern,
    pageContextBias: input.routing.pageContextBias,
  },
});
// R7 IMPROVEMENT #4 — also set `arch.specialist` as turn-span ATTRIBUTE
// (in addition to event) so OTel sampling can key on it at trace head
trace.setAttribute(turnSpanId, 'arch.specialist', input.routing.specialist);
```

READ `engine/trace-recorder.ts:113-122` for the exact `event(options: EmitSpanEventOptions)` signature; verify `setAttribute` API exists on the recorder (if not, add or use the underlying OTel span). `userInputSnippet` intentionally omitted (cross-user PII risk).

4.3. Edit `apps/docs-internal/content/abl-reference/multi-agent-and-supervisor.mdx` to ADD: (a) a "Remote Agent" subsection covering LOCATION/ENDPOINT/PROTOCOL/auth-via-registry/CONTEXT.pass typing, AND (b) a "External Agent Registry + arch-ai workflow" section with the 6 sub-points from design §5.5.

4.4a. **Add `CARD_MAPPINGS` entry** in `tools/abl-docs/card-mapping.ts` (R2 CRITICAL-2 — emission is governed here, NOT in `generate.ts`). **R3 HIGH-3 dependency**: this task DEPENDS on task 4.3 — the H2/H3 anchors named in `sections` MUST exist in the MDX before this task runs. Add a new `CardMappingEntry`:

```ts
{
  id: 'external-agents',
  exportName: 'EXTERNAL_AGENTS_CARD',
  title: 'External Agent Registry',
  sources: [{
    file: 'abl-reference/multi-agent-and-supervisor.mdx',
    sections: ['Remote Agent', 'External Agent Registry + arch-ai workflow'],
  }],
  maxTokens: 2000, // match similar card sizing
}
```

READ existing entries (e.g. for `handoff-delegate`) to confirm field shape and adjust accordingly. **Exit criterion**: generated `external-agents.ts` has non-empty `EXTERNAL_AGENTS_CARD` content (regression: empty content = MDX anchors don't match `sections` strings).

4.4b. **Append `CARD_FILE_COVERAGE` entry** in `packages/arch-ai/src/knowledge/cards/_mapping.ts` (R2 CRITICAL-3 — without this, L3 BM25 will inject duplicate chunks already covered by the L2 card):

```ts
'external-agents': ['abl-reference/multi-agent-and-supervisor.mdx'],
```

4.4c. Run `pnpm abl:docs:generate` to regenerate `packages/arch-ai/src/knowledge/cards/generated/handoff-delegate.ts` AND emit NEW `packages/arch-ai/src/knowledge/cards/generated/external-agents.ts`. Verify both files exist and contain remote-agent content. **D-1 invariant honored**: cards remain auto-generated from MDX (no hand-authored fallback — Phase 4 prereq is the `card-mapping.ts` entry, not generator extension).

4.5. Register the new card's triggers in `packages/arch-ai/src/knowledge/card-router.ts` using the **actual schema** (R2 CRITICAL-1 — existing pattern is synchronous static import + `CardEntry { id, content, patterns }`):

1.  Add static import near line 51: `import { EXTERNAL_AGENTS_CARD } from './cards/generated/external-agents.js';`
2.  Push to `CARD_REGISTRY`:
    ```ts
    {
      id: 'external-agents',
      content: EXTERNAL_AGENTS_CARD,
      patterns: [
        /\b(external|remote|partner|third.party)\s+agent\b/i,
        /\bLOCATION:\s*remote\b/i,
        /\ba2a\s+(handoff|integration|endpoint)\b/i,
        /\bagent[- ]card\b/i,
        /\bconnect\s+(to|with)\s+.*\s+agent\b/i,
      ],
    }
    ```
3.  READ `card-router.ts:59-63` for the exact `CardEntry` interface and current registry to mirror style/order.

4.6. Append a "Remote agent handoffs" subsection (~6 lines) to `packages/arch-ai/src/knowledge/platform-limits.ts:13-71` covering `LOCATION: remote / ENDPOINT (optional, registry resolves) / PROTOCOL: a2a|rest / auth in registry / CONTEXT.pass typing`.

4.7. Add capability + page mapping in `packages/arch-ai/src/engine/coordinator-bridge.ts:97-206` `getPageContextSpecialistBias`. **R3 MEDIUM-2 detail**: function structure is conditional branches (`if (entityType === ... || page === ... || capabilities.has(...)) return 'specialist'`), NOT a key-value object. Insert into the existing `'integration-methodologist'` branch (currently around lines 135-150):

- Add `page === 'external-agents'` to that branch's page-disjunction
- Add `capabilities.has('a2a_integration')` to that branch's capability-check disjunction

  4.8. Write `packages/arch-ai/src/__tests__/content-router-external-agent.test.ts` — assert each of the 5 new patterns routes to integration-methodologist (via `routeByContent` returning `{specialist: 'integration-methodologist', matchedPattern: '<source>'}`); assert default fallthrough returns `matchedPattern: null`. Trace event emission tested separately at engine layer.

**Files Touched**:

- `packages/arch-ai/src/coordinator/content-router.ts` — patterns + return RoutingDecision (D-6 third revision)
- `packages/arch-ai/src/engine/coordinator-bridge.ts` — extend `TurnPlan.routing`; pageContext bias (consolidated with task 4.7)
- `packages/arch-ai/src/engine/turn-engine.ts` — extend `RunTurnInput.routing`; emit `routing_decision` trace event in `runTurn()` ~line 297
- `apps/studio/src/lib/arch-ai/processors/process-message.ts` (or `process-in-project.ts` — locate via grep) — forward `turnPlan.routing → RunTurnInput.routing` (R4 CRITICAL-2)
- `apps/docs-internal/content/abl-reference/multi-agent-and-supervisor.mdx` — MDX source
- `tools/abl-docs/card-mapping.ts` — `CARD_MAPPINGS` entry (R2 CRITICAL-2; was missing from Files Touched)
- `packages/arch-ai/src/knowledge/cards/_mapping.ts` — `CARD_FILE_COVERAGE` entry (R2 CRITICAL-3; was missing)
- `packages/arch-ai/src/knowledge/cards/generated/handoff-delegate.ts` — REGENERATED
- `packages/arch-ai/src/knowledge/cards/generated/external-agents.ts` — NEW (generated)
- `packages/arch-ai/src/knowledge/card-router.ts` — register card (R2 CRITICAL-1 corrected schema)
- `packages/arch-ai/src/knowledge/platform-limits.ts` — L0 subsection
- `packages/arch-ai/src/__tests__/content-router-external-agent.test.ts` — NEW

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/arch-ai --filter=@agent-platform/studio` succeeds
- [ ] Routing-pattern test passes: each of 5 trigger phrases routes to integration-methodologist
- [ ] Routing-pattern test passes: `routeByContent` returns `RoutingDecision { specialist: 'integration-methodologist', matchedPattern: <source> }` with non-null `matchedPattern` for each trigger. (Trace span event emission tested separately at engine layer per D-6 third revision.)
- [ ] L2 card load test: simulate IN_PROJECT prompt composition with input "external agent" — `external-agents` card content appears in composed prompt
- [ ] `pnpm abl:docs:generate` runs cleanly (no MDX parse errors)
- [ ] `handoff-delegate.ts` regenerated content includes "Remote Agent" subsection
- [ ] `external-agents.ts` new file generated with 6 sections from design §5.5
- [ ] PageContext bias test: `getPageContextSpecialistBias({page: 'external_agents', capability: undefined, userInput: 'fix this'})` returns `'integration-methodologist'`
- [ ] No regression in existing card-router tests (`pnpm test --filter=@agent-platform/arch-ai card-router`)

**Test Strategy**:

- **Unit (test-first)**: routing-pattern test written BEFORE adding patterns to content-router. Encodes which phrases must reach integration-methodologist.
- **Unit**: card-router `external-agents` trigger test extending existing patterns.
- **Integration**: pageContext bias test verifying short anaphoric turns on external-agents page route correctly.

**Rollback**: git-revert phase commit. The L2 card and routing patterns are purely additive — removing them returns arch to pre-Spec-1 routing for external-agent intent.

---

### Phase 5: Live Indicators + Transition Narration + Prompt Edits + Catalog Fix + v5 Amendment

**Goal**: Polish layer. Users see active specialist live, see transitions narrated, and BLUEPRINT/BUILD onboarding has accurate remote-agent guidance. Final Spec 1 commit.

**Tasks**:

5.1. Create `apps/studio/src/lib/arch-ai/components/arch/chat/specialist-style.ts` — extract `ICON_MAP` from `SpecialistBadge.tsx:17-28`, `ROLE_STYLES` from lines 31-68, AND `FALLBACK_STYLE` from lines 70-73 (R6 MED-4 — otherwise SpecialistChip will redefine it, causing drift). Export all three as named exports.

5.2. Refactor `apps/studio/src/lib/arch-ai/components/arch/chat/SpecialistBadge.tsx` to import from `specialist-style.ts` (no behavior change; just deduplication setup for Step 5.3).

5.3. Create `apps/studio/src/lib/arch-ai/components/arch/chat/SpecialistChip.tsx` — compact variant. **R2 HIGH-1 FIX**: existing `ICON_MAP`/`ROLE_STYLES` are keyed by **icon name** (`clipboard, network, code, shield, phone, database, plug, activity, flask`), NOT specialist ID. Props must mirror `SpecialistBadge`: `{name: string, icon: string}`. Renders ~24px-tall pill (smaller than SpecialistBadge) with icon + lowercase label. Imports `ICON_MAP` + `ROLE_STYLES` from `specialist-style.ts`.

5.4. Update `apps/studio/src/lib/arch-ai/components/arch/chat/ArchHeroStrip.tsx:40-71`. **R3 HIGH-1 detail**: current component is purely presentational with zero state subscriptions; props are `{variant, projectName, phase, onReset, headerActions}`. Adding the indicator requires:

- New imports: `import { useArchUIStore } from '@/lib/arch-ai/ui/store'; import { SpecialistChip } from './SpecialistChip';`
- Atomic-selector: `const currentSpecialist = useArchUIStore((s) => s.currentSpecialist);` (returns `{name, icon} | null` per oracle B3)
- Render second-line indicator passing BOTH `name` and `icon`:

```tsx
{
  currentSpecialist && (
    <SpecialistChip name={currentSpecialist.name} icon={currentSpecialist.icon} />
  );
}
```

5.5. Update `apps/studio/src/lib/arch-ai/ui/store.ts` (D-10):

- Add `statusMessages: StatusMessage[]` field (initial: `[]`)
- Add `appendStatusMessage(msg: StatusMessage): void` action
- Keep existing `statusMessage: string | null` and its setter for legacy callers

  5.6. Update `apps/studio/src/lib/arch-ai/ui/event-dispatcher.ts:257-279` (where SSE `specialist` event is dispatched). **R2 HIGH-4 FIX** — the existing dispatcher pattern uses TWO-step state updates (compute outside, dispatch via `getState()` AFTER `setState()` returns). DO NOT call `appendStatusMessage` from inside the `setState((s) => ...)` callback that overwrites `currentSpecialist` — it's racy. Pattern:

```ts
case 'specialist': {
  // Step 1: read prevSpecialist BEFORE setState (synchronous capture)
  const prevSpecialist = useArchUIStore.getState().currentSpecialist;
  const nextSpecialist = { name: env.name, icon: env.icon };
  const hasPriorAssistantMessage = useArchUIStore.getState().messages.some(
    (m) => m.role === 'assistant'
  );

  // Step 2: dispatch state change
  useArchUIStore.setState({ currentSpecialist: nextSpecialist });

  // Step 3: emit narration AFTER state change, only on non-trivial transition
  if (
    prevSpecialist?.name &&
    prevSpecialist.name !== nextSpecialist.name &&
    hasPriorAssistantMessage
  ) {
    useArchUIStore.getState().appendStatusMessage({
      id: cryptoRandomId(),  // R1 MED-3: use existing helper, NOT crypto.randomUUID()
      type: 'info',
      text: `Switching to ${SPECIALIST_DISPLAY[nextSpecialist.name] ?? nextSpecialist.name} for ${transitionReason(nextSpecialist.name)}…`,
    });
  }
  break;
}
```

`transitionReason` is a small in-file helper mapping specialist → reason (e.g. `integration-methodologist` → "tool/connection setup"). `cryptoRandomId` is a **local helper** in `event-dispatcher.ts:1100-1104` (not a project-wide export per R3 HIGH-2) — call directly within the same file, no import needed.

5.7. Update `apps/studio/src/lib/arch-ai/components/arch/chat/ChatStatusMessage.tsx` consumer to read `statusMessages` from the store via `useArchUIStore((s) => s.statusMessages)` and pass through `<ChatStatusMessages messages={statusMessages}>`. (Verify the consumer location during impl — likely the chat panel or assistant wrapper.)

5.8. Edit `packages/arch-ai/src/prompts/specialists/integration-methodologist.ts` (low-priority per audit; future-proofing):

- Update line 6 description to mention external-agent registry
- Add `external_agent_ops` to "Your Tools" list at line 18
- Add new section parallel to "MCP Server Management" (line 160-174) titled "External Agent Registry" — mirror L2 card content
- Add workflow example parallel to line 217-222: "Workflow: Connect external agent and wire HANDOFF"

  5.9. Edit `packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts:80-189` — add HANDOFF golden example showing remote variant with LOCATION:remote (no ENDPOINT/PROTOCOL — registry resolves).

  5.10. Edit `packages/arch-ai/src/prompts/specialists/multi-agent-architect.ts:21-25` — add 4th handoff variant ("remote") with explicit limitation flag in prompt text per design §5.10.

  5.11. Edit `apps/studio/src/lib/arch-ai/construct-catalog.ts:303-324` — fix the wrong `CONTEXT: "string"` syntax (use structured form) AND add LOCATION/ENDPOINT/PROTOCOL/REMOTE block with example.

  5.12. Edit `apps/studio/src/lib/arch-ai/handbook-reference.ts` — add HANDOFF + LOCATION:remote section if file structure permits (read first; if not, document why and skip).

  5.13. Append the v5 amendment paragraph to `docs/superpowers/specs/2026-05-05-arch-knowledge-spine-explain-first-design.md` near the `interface ConstructSpec` declaration (R3 LOW-1 — currently §4.2 around line 182, NOT §3 as design said). Single paragraph, ~150 words.

  5.14. Write the 5 E2E scenarios in `apps/studio/e2e/arch-external-agent.spec.ts` (NEW). Use Playwright with real PM2 servers (production mode per CLAUDE.md — `SKIP_SETUP=1 NODE_ENV=production pm2 start abl-studio`). Scenarios:

- Happy path — register, test, wire HANDOFF, compile passes
- Discovery fails (timeout) — fall back to manual flow A
- Duplicate name — arch suggests alternative
- Auth failure post-create — `lastConnectionStatus='failed'`, registration persists
- SSRF rejection on `discover_preview` — sanitized message, no fetch attempt

**Files Touched**:

- `apps/studio/src/lib/arch-ai/components/arch/chat/specialist-style.ts` — NEW
- `apps/studio/src/lib/arch-ai/components/arch/chat/SpecialistBadge.tsx` — refactor imports
- `apps/studio/src/lib/arch-ai/components/arch/chat/SpecialistChip.tsx` — NEW
- `apps/studio/src/lib/arch-ai/components/arch/chat/ArchHeroStrip.tsx` — second-line indicator
- `apps/studio/src/lib/arch-ai/ui/store.ts` — statusMessages list + appendStatusMessage action
- `apps/studio/src/lib/arch-ai/ui/event-dispatcher.ts` — transition narration on specialist change
- `apps/studio/src/lib/arch-ai/components/arch/chat/ChatStatusMessage.tsx` — read from store list (verify consumer)
- `packages/arch-ai/src/prompts/specialists/integration-methodologist.ts` — section + workflow
- `packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts` — HANDOFF goldens
- `packages/arch-ai/src/prompts/specialists/multi-agent-architect.ts` — 4th handoff variant
- `apps/studio/src/lib/arch-ai/construct-catalog.ts` — HANDOFF fix + LOCATION block
- `apps/studio/src/lib/arch-ai/handbook-reference.ts` — LOCATION:remote section (conditional)
- `docs/superpowers/specs/2026-05-05-arch-knowledge-spine-explain-first-design.md` — v5 amendment
- `apps/studio/e2e/arch-external-agent.spec.ts` — NEW (5 scenarios)

**Exit Criteria**:

- [ ] `pnpm build` (full) succeeds
- [ ] `pnpm test:report` (full) passes — no new failures vs baseline
- [ ] All 5 E2E scenarios pass against real PM2 stack
- [ ] Manual smoke: `ArchHeroStrip` shows `Phase: ... · Specialist: ...` when in IN_PROJECT mode
- [ ] Manual smoke: typing "external agent" in chat triggers narration "Switching to Integration Methodologist…" if previous specialist differed
- [ ] `SpecialistBadge` and `SpecialistChip` render identically for the same specialist (visual regression — Storybook snapshot or screenshot diff)
- [ ] No `vi.mock('@agent-platform/...')` in any new test (CLAUDE.md hook)
- [ ] `git diff develop --stat` shows ≤22 modified files in this phase commit (within commit-scope guard)
- [ ] **Gate 3 (definition of done D-5)**: manual PM2 acceptance run with logs/screenshot/video saved to `docs/sdlc-logs/arch-ai-a2a-spec1/gate3-evidence.md`. Includes: full happy-path conversation transcript, ExternalAgentCard rendering proof, post-flow agent DSL diff showing HANDOFF block added.

**Test Strategy**:

- **Unit (test-first)**: not applicable — phase 5 is glue + UI + prompts.
- **Integration**: deferred to E2E since phases 1-4 covered integration paths.
- **E2E (test-after)**: 5 scenarios written alongside or after the indicator/narration changes. Real PM2 — no mocks per CLAUDE.md "E2E Test Standards".

**Rollback**: git-revert phase commit. Most surfaces are additive. Only sensitive: `event-dispatcher` transition-narration logic — if it misfires, revert just that file.

---

## 4. Wiring Checklist

CRITICAL: Every new component must be wired into its callers. The "tool registered but never called" failure mode is the #1 agent failure.

### General

- [ ] `external_agent_ops` token added to `ToolName` union (Phase 1 task 1.3)
- [ ] `external_agent_ops` added to `IN_PROJECT_SPECIALIST_TOOL_MAP['integration-methodologist']` (Phase 1 task 1.4)
- [ ] `external_agent_ops` added to `ACTION_TO_PERMISSION` + `DANGEROUS_ACTIONS` in `guards.ts` (Phase 1 task 1.6)
- [ ] `external_agent_ops` added to `classification.ts` (Phase 1 task 1.5)
- [ ] `external_agent_ops` Vercel-AI `tool({...})` block registered in `in-project-tools.ts` (Phase 3 task 3.5) — NEW tool actually exposed to LLM
- [ ] `executeExternalAgentOps` dynamically imported by the registration block (verified by grep `from '@/lib/arch-ai/tools/external-agent-ops'`)
- [ ] `kbCards` channel accepts new variant `external_agent_card` (verify against `ui/types.ts` shape — Phase 3 task 3.10)
- [ ] `event-dispatcher` `case 'external_agent_card'` routes to `appendKbCardMessage` or equivalent (Phase 3 task 3.9)
- [ ] L2 card `external-agents` registered in `card-router.ts` triggers (Phase 4 task 4.5)
- [ ] L2 card `external-agents` actually loads in IN_PROJECT prompt composition — verify by typing trigger phrase + tracing prompt
- [ ] PageContext bias `'a2a_integration'` + `'external_agents'` keys present in `coordinator-bridge.ts:97-206` (Phase 4 task 4.7)
- [ ] Routing patterns at top of `routeByContent` BEFORE `\bdelegate\b` (Phase 4 task 4.1) — order matters
- [ ] `routing_decision` trace event emitted at engine turn-start in `turn-engine.ts runTurn()` after TurnTraceRecorder construction (~line 297) — NOT from `routeByContent` or `resolveTurnPlan` (D-6 third revision)
- [ ] `routeByContent` signature returns `RoutingDecision { specialist, matchedPattern, pageContextBias? }` not just `AnySpecialistId`
- [ ] `TurnPlan` extended with `routing: RoutingDecision` field (Phase 4 task 4.2(b))
- [ ] `RunTurnInput` extended with `routing: RoutingDecision` field (Phase 4 task 4.2(c))
- [ ] **Studio call site that constructs `RunTurnInput` from `TurnPlan` forwards `routing`** — locate via `git grep 'new TurnEngine\|runTurn(' apps/studio/`; outside arch-ai package (R4 CRITICAL-2)
- [ ] `trace.event({spanId, name, attributes})` invocation in `turn-engine.ts runTurn()` matches actual API at `engine/trace-recorder.ts:113-122`
- [ ] L0 `platform-limits.ts` "Remote agent handoffs" subsection appears in composed prompts (verify by grep)
- [ ] `useArchUIStore.statusMessages` + `appendStatusMessage` action exported (Phase 5 task 5.5)
- [ ] `ChatStatusMessages` consumer reads from `useArchUIStore.statusMessages` (Phase 5 task 5.7)
- [ ] `ArchHeroStrip` renders `<SpecialistChip>` when `currentSpecialist` is non-null (Phase 5 task 5.4)
- [ ] `SpecialistChip` imports from `specialist-style.ts` (not duplicating maps; Phase 5 task 5.3)
- [ ] `EXTERNAL_AGENT_*` constants used in 3 route files (6 as-any casts total) (no `as any` — Phase 1 task 1.2)
- [ ] `EXTERNAL_AGENT_TEST_AUTH` env var honored at runtime route (Phase 2 task 2.2)
- [ ] `authConfig` parameter actually passed to `testExternalAgentConnection` from runtime route (Phase 2 task 2.2)
- [ ] `createA2AClientWithAuth` factory wired in `testExternalAgentConnection` when authConfig present (Phase 2 task 2.1)

### Studio UI

- [ ] `ExternalAgentCard.tsx` imported and rendered by event-dispatcher's card path — verify by grep
- [ ] `SkillChips.tsx` imported by both `ExternalAgentEditPanel.tsx` AND `ExternalAgentCard.tsx` — verify by grep
- [ ] `ExternalAgentEditPanel.tsx` no longer has inline skill-chip JSX (Phase 3 task 3.7)
- [ ] `external_agent_ops` tool's onError flows back into chat assistant message via existing `tool-result` handling in `event-dispatcher` (no new error wiring needed; verify)
- [ ] `discover_preview` failures surface as `error.code` in tool result and the LLM is prompted to fall back to manual flow A (handled by integration-methodologist L2 card guidance)
- [ ] `delete` action's `needsConfirmation` flow uses existing Confirmation widget (no new widget required)
- [ ] No native `<select>` elements added (CLAUDE.md hook)
- [ ] No `bg-accent text-foreground` (CLAUDE.md hook)
- [ ] `ExternalAgentCard` `disabled={isPending}` not applicable (display-only, no actions per design §5.9)
- [ ] No new Studio API route added (Spec 1 reuses existing `/api/projects/[id]/external-agents/` routes)
- [ ] All 5 existing external-agents routes actually called by an executor: `external-agent-ops.ts` apiFetch URLs (verify by grep)

### Documentation

- [ ] MDX source `multi-agent-and-supervisor.mdx` edited (Phase 4 task 4.3)
- [ ] `pnpm abl:docs:generate` ran cleanly producing both regenerated `handoff-delegate.ts` AND new `external-agents.ts`
- [ ] L2 card `external-agents` regenerable from MDX (verify by re-running generator — output should match)
- [ ] v5 design doc amendment paragraph appears near `interface ConstructSpec` declaration (§4.2 ~line 182) of v5 spec (Phase 5 task 5.13)

---

## 5. Cross-Phase Concerns

### 5.1 Database Migrations

None. The `ExternalAgentConfig` model is unchanged. All Spec 1 changes are wire-only.

### 5.2 Feature Flags

Per D-3, no GrowthBook flag. Belt-and-suspenders rollback uses a single env var:

| Flag                       | Phase | Purpose                                                                                                                                                                                                           | Default                    |
| -------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `EXTERNAL_AGENT_TEST_AUTH` | 2     | Set to `'false'` to fall back to legacy unauthenticated test_connection (one-line hotfix; D-8). When `'false'`, runtime route emits `log.warn(...)` for observability. Documented in `apps/runtime/.env.example`. | unset (treated as enabled) |

**R1 MED-1 migration consideration**: Phase 2 may cause pre-existing external agents to suddenly show `lastConnectionStatus='failed'` if their stored credentials are stale or invalid (which the unauthenticated test_connection hid). Communicate to operators: existing agents may need credential refresh after Spec 1 lands. Optionally — out of scope for Spec 1 — run a one-time non-failing audit pass before flipping the default that surfaces "X agents would have failed under auth-aware test" without persisting the failed state.

### 5.3 Configuration Changes

No new env vars required by default. The `EXTERNAL_AGENT_TEST_AUTH` flag is opt-out only — operators set it to `'false'` only if a hotfix is needed.

Document in `apps/runtime/.env.example` if exists (verify during Phase 2; otherwise add a one-line note in the runtime route's nearest README/comments).

### 5.4 Telemetry / Observability

- New `routing_decision` trace span event (NOT JournalEntry) — content-router decisions become observable; emitted at engine turn-start (D-6 third revision; Phase 4 task 4.2)
- No new metrics; no new dashboards
- Existing trace events (`a2a_call`, `handoff_progress`, `a2a_async_suspend`) unchanged
- Logging: `createLogger('arch-ai/external-agent-ops')` in the new executor. Routing decisions are durable as trace span events; no separate logger needed at content-router (which is now pure data per D-6 third revision).

### 5.5 Coordination With In-Flight Work

| Stream                               | Coordination                                                                                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Knowledge Spine v5                   | Spec 1 amends v5 design doc only (Phase 5 task 5.13). No code dependency. v5 generator (when implemented) replaces `construct-catalog.ts` (D-7 fix is then deletable). |
| ABLP-162 wire-tools (this branch)    | Spec 1 lands as continuation. Branch is `zarch/newtools` from `develop`. Already 14 commits ahead. No conflicts.                                                       |
| Spec 2 (topology + blueprint)        | Independent. Spec 2 will extend `TopologyAgentSchema.remote` and add diagnostic codes. Can begin immediately after Spec 1 lands.                                       |
| Spec 3 (backend + runtime hardening) | Independent. Spec 3 will replace executor-side discover_preview with a runtime endpoint, add delegate-path auth, error sanitizer, OAuth, etc.                          |

---

## 6. Acceptance Criteria (Whole Feature)

Per D-5, three gates in sequence.

### Gate 1 — Code Lands and All Tests Pass

- [ ] All 5 phases complete with their phase-specific exit criteria met
- [ ] `pnpm build` (full monorepo) succeeds with 0 errors
- [ ] `pnpm test:report` shows zero new failures vs `develop` baseline
- [ ] All E2E tests from §8 of design doc pass (5 scenarios)
- [ ] All integration tests from §8 pass (5 scenarios + auth round-trip + env-gate fallback)
- [ ] All unit tests from §8 pass (4 pure functions + routing patterns + structural)
- [ ] `npx prettier --check` passes on all changed files
- [ ] No regression in existing `external-agent-registry-resolution.test.ts` (33+ existing assertions remain green)
- [ ] CLAUDE.md PreToolUse hooks pass on every commit (no `vi.mock` of internal packages, no `console.log`, no swallowed catches, no hardcoded Tailwind palette colors, no native selects, no `as any` permission casts in route files)

### Gate 2 — CI E2E Suite Green

- [ ] `pnpm test:e2e --filter=arch-external-agent` passes 5/5 scenarios on CI against PM2-hosted Studio + runtime + Mongo
- [ ] Auth round-trip test against fixture A2A agent at `examples/external-a2a-bridge/external-vercel-agent` passes — bad token surfaces `reachable: false`
- [ ] Adaptiveness verification: 5 trigger phrases each route to integration-methodologist via `routeByContent` returning correct `RoutingDecision { specialist: 'integration-methodologist', matchedPattern: <source> }` (assertion in routing-pattern test). Trace event emission tested separately at engine layer.
- [ ] L2 card load verification: simulated IN_PROJECT prompt composition with trigger input contains external-agents card content

### Gate 3 — Manual User-Acceptance (Strictest, per D-5)

Recorded in `docs/sdlc-logs/arch-ai-a2a-spec1/gate3-evidence.md`:

- [ ] Run PM2 in production mode: `SKIP_SETUP=1 NODE_ENV=production pm2 restart abl-studio abl-runtime`
- [ ] Open Studio in browser; create or open a project in IN_PROJECT mode
- [ ] Type: "Connect my Salesforce agent at https://sf.example.com/agent so my Triage agent can hand off billing escalations" (or equivalent with a real reachable A2A endpoint, e.g. `examples/external-a2a-bridge/external-vercel-agent` running locally)
- [ ] Observe: arch routes to integration-methodologist; UI second-line shows `Specialist: Integration Methodologist`; transition status message appears
- [ ] Observe: arch calls `discover_preview`, displays card preview
- [ ] Observe: secret-flow handshake (collect_secret widget for bearer token)
- [ ] Observe: `create` succeeds; ExternalAgentCard renders with green status badge
- [ ] Observe: `propose_modification` shows the synthesized HANDOFF block; user confirms
- [ ] Observe: `apply_modification` succeeds; `compile_abl` returns success
- [ ] Open Studio's external-agents page — verify the new agent is listed with `lastConnectionStatus='connected'`
- [ ] Save full conversation transcript + post-flow agent DSL diff + 3 screenshots (chat panel showing cards/badges; external-agents page showing new agent; agent DSL view showing HANDOFF block) to `gate3-evidence.md`

### Documentation Sync (post-acceptance)

- [ ] Run `/post-impl-sync arch-ai-a2a-spec1` to update feature spec, test spec coverage, design doc status
- [ ] Update `packages/arch-ai/agents.md` with Spec 1 learnings (e.g. journal-writer reachability from content-router, MDX-source convention for L2 cards)
- [ ] Update `apps/studio/agents.md` with Spec 1 learnings (e.g. SkillChips refactor pattern, statusMessages list addition)
- [ ] Update `docs/sdlc-logs/agents.md` if any cross-cutting learning surfaces

---

## 7. Open Questions

1. **RESOLVED in R3** — D-6 was thrice-revised: (i) JournalEntry → TraceRecorder; (ii) caller-side emission at `resolveTurnPlan`; (iii) lift to engine turn-start. `routeByContent` returns `RoutingDecision`; routing flows TurnPlan → RunTurnInput → engine; emission at `turn-engine.ts runTurn() ~line 297` where `TurnTraceRecorder` is constructed. No journal-service plumbing needed.

2. **RESOLVED in R2** — split into Phase 4 tasks 4.4a (`CARD_MAPPINGS` entry in `tools/abl-docs/card-mapping.ts`) and 4.4b (`CARD_FILE_COVERAGE` entry in `_mapping.ts`). Both have explicit deliverables and exit criteria.

3. **`construct-catalog.ts` IN_PROJECT effect**: design notes the file is loaded somewhere but does the BUILD-phase prompt actually consume the modified HANDOFF entry? Verify by greppping consumers during Phase 5 task 5.11. If unused in IN_PROJECT (plausible — given the v5 plan to delete it), the fix is doc-only (acceptable per Q3 C).

4. **Handbook-reference.ts file structure** (Phase 5 task 5.12 conditional): the file is referenced in design but its current contents are unverified. May not have a HANDOFF section structure to extend. Skip if structure doesn't permit; document in agents.md.

5. **`external_agent_card` variant in `kbCards[]`**: Phase 3 task 3.10 assumes `kbCards` is generic. Verify the existing dispatcher pattern accepts arbitrary `type` discriminants without a type widening. If not, add discriminated-union member explicitly. **R1 HIGH-1 expanded** in task 3.9: `isKbCardMessage` type guard must be extended.

6. **PM2 acceptance fixture A2A endpoint**: Gate 3 needs a reachable A2A endpoint. The local fixture at `examples/external-a2a-bridge/external-vercel-agent` should suffice but must be running. If unavailable, document in gate3-evidence.md and use a pre-recorded video instead.

7. **R1 MED-6 commit-scope guard verification (UPDATED in R4)**: each phase's commit must satisfy the CLAUDE.md commit-scope hook (≤40 non-doc files, ≤3 packages). Per-phase counts: Phase 1 = 11 files / 3 packages (studio + arch-ai + shared via ExternalAgentConfigView export + runtime route). Phase 2 = 4 files / 2 packages (shared + runtime + .env.example doc). Phase 3 = 12 files / 2 packages (studio + runtime tests). Phase 4 = 12 files / 3-4 packages (arch-ai + studio + tools/abl-docs + apps/docs-internal MDX). **Verify `pnpm-workspace.yaml` membership of `tools/abl-docs` and `apps/docs-internal` before commit** — if both are workspace packages, Phase 4 may need a split commit (e.g. routing-engine extraction in one + card-pipeline in another) to satisfy ≤3-package guard. Phase 5 = 14 files / 2 packages (studio + arch-ai). All within limits. Verify exact count before each phase's commit.

These are all implementation-time confirmations, NOT design-time blockers. Each can be resolved in its corresponding phase.

---

## 8. Deferred / Spec 3 Roadmap Items (added by R7 industry audit)

The following are real concerns surfaced by R7 industry research but explicitly deferred to Spec 3 with rationale:

| Item                                                 | Source                                                                           | Defer rationale                                                                                                                                                                                                          | Spec 3 placement                                                                                                                                                                                    |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agent-card response caching (ETag/If-None-Match)** | A2A spec — servers SHOULD include caching headers; @a2a-js/sdk caches internally | Minor perf cliff only (back-to-back fetches double-cost). SDK `DefaultAgentCardResolver` may handle internally — verify in Phase 3 preflight.                                                                            | Add `lastDiscoveredCard.etag` + `lastDiscoveredCard.lastModified` columns to `external_agent_configs`; pass `If-None-Match` on subsequent fetches.                                                  |
| **HANDOFF synthesizer pinning `card.version`**       | A2A spec — agents MUST reject mismatching contextId/taskId                       | HANDOFF synthesis is full-feature in Spec 1, but version pinning belongs with topology awareness (Spec 2) and runtime resilience (Spec 3). Add `card.version` as comment in synthesized DSL during Spec 1 as breadcrumb. | Add `card.versionAtHandoffWrite` field to `ExternalAgentConfig.lastDiscoveredCard`; runtime warns on version drift.                                                                                 |
| **GetExtendedAgentCard authenticated extended card** | A2A spec — extended card mechanism for auth-gated skills                         | Spec 3's "OAuth wiring" item didn't include extended card retrieval. Without it, Spec 1 sees only the public card; auth-gated skills are invisible to arch.                                                              | Add to Spec 3 roadmap (§11 of design doc): "After auth-aware test_connection succeeds, optionally call GetExtendedAgentCard if the public card declares `supportsAuthenticatedExtendedCard: true`." |
| **E2E: card-version drift mid-conversation**         | A2A spec lifecycle                                                               | Three additional E2E scenarios (E2E-6/7/8) — defer to Spec 3 because resilience surface (retries, sanitizer, structured errors) lands there. Spec 1's 5 E2E scenarios cover the silent-misconfig closure goal.           | Spec 3 E2E suite extension.                                                                                                                                                                         |
| **E2E: partial handoff failure / network split**     | A2A spec lifecycle (input-required, auth-required)                               | Same — Spec 3 territory.                                                                                                                                                                                                 | Spec 3 E2E suite extension.                                                                                                                                                                         |
| **E2E: contextId/taskId invariant**                  | A2A spec                                                                         | Same — Spec 3 territory.                                                                                                                                                                                                 | Spec 3 E2E suite extension.                                                                                                                                                                         |

Update to Spec 3 design doc (§11 of `2026-05-05-arch-ai-a2a-spec1-design.md`) — Phase 5 task 5.13's v5 amendment is unchanged; this is a separate Spec 3 doc update due in the post-Spec-1 follow-up.

---

## 9. Post-Implementation Notes (2026-05-06)

Implementation closed across 11 commits on `zarch/newtools` (Phase 1 → Phase 6 doc/log). All
five LLD phases hit their stated exit criteria; full monorepo `pnpm build` 55/55, Spec 1 unit

- integration suite 87 studio + 623 arch-ai green. See implementation log for the full ledger.

### Key deviations from this LLD (already documented per-phase)

- **Phase 2 task 2.4 location** — env-gate fallback test consolidated into
  `external-agent-registry-resolution.test.ts` rather than `external-agents-integration.test.ts`
  (same harness, tighter cohesion).
- **Phase 3 task 3.1** — `discover_preview` implemented natively via `fetch` + SSRF gate +
  256 KB streamed cap (R8 IMPROVEMENT option b). No new dep on `@a2a-js/sdk` or
  `@agent-platform/a2a` from `apps/studio/`.
- **Phase 3 task 3.12** — EXT-1..EXT-5 land in the runtime integration test (HTTP contract)
  rather than as in-process executor tests, because the executor has no clean cross-package
  import path. Executor envelope conformance is covered by `tool-result-shape.test.ts`.
- **Phase 4 task 4.2(d)** — `TurnTraceRecorder` exposes no `setAttribute()`; the
  `routing_decision` span event is emitted with all three attributes (`specialist`,
  `matchedPattern`, `pageContextBias`) but no head-of-trace attribute is set on the turn
  span. Follow-up to add `setAttribute()` to the recorder if OTel sampling needs it.
- **Phase 5 task 5.13** — v5 amendment placed immediately after the closing fence of the
  `ConstructSpec` code block in the v5 design doc (LLD said "near line 182" but that line is
  inside a fenced ts code block; markdown blockquote cannot break the fence).
- **Phase 5 task 5.14** — three E2E scenarios are real working tests; two scenarios
  (auth-failure persistence, discovery timeout fallback) are `test.fixme` per LLD §5.14
  explicit allowance, with TODO(spec3-hardening) breadcrumbs.

### Gate status

| Gate                        | Status      | Notes                                                                                                           |
| --------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------- |
| 1 — Code lands + tests pass | ✅ COMPLETE | Commits `2a0e270769` … `97f3274a6f`; build 55/55; Spec 1 tests 87+623 green.                                    |
| 2 — CI E2E suite green      | ⏸ DEFERRED  | Runs against `develop` post-merge; Playwright spec scaffolded at `apps/studio/e2e/arch-external-agent.spec.ts`. |
| 3 — Manual user-acceptance  | ⏸ DEFERRED  | Operator-driven; evidence to `gate3-evidence.md`.                                                               |

### Deferred follow-up (12+ items)

Tracked in `docs/sdlc-logs/arch-ai-a2a-spec1/implementation.log.md` "Deferred findings" ledger.
Highest-impact deferrals:

- R3 CRITICAL-1 — `vi.mock('@/lib/redis-client')` in `suggestions-engine.test.ts` (parallel
  ABLP-162 stream commit `fd987765f5`, predates Spec 1). Refactor `computeIntegrationSuggestions`
  to take redis via DI.
- R5 H-2 — `PROJECT_STATE_CACHE` unbounded `Map` in `runtime-support.ts` (parallel stream).
- R5 H-3 — `connection_ops` outbound `fetch` missing `AbortSignal.timeout` (parallel stream).
- R4 M-1 — Resume route `[id]/resume/route.ts` first lookup omits `projectId` (load-then-authorize
  is safe today but diverges from CLAUDE.md invariant).
