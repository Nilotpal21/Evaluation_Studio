# Arch-AI In-Project Agent-Update Flow — End-to-End Audit

**Date:** 2026-05-05
**Branch:** `zarch/newtools`
**Scope:** Trace the IN*PROJECT propose → validate → apply path through UI, route, orchestration, tools, persistence, and back. Identify gaps not covered by [`2026-05-05-arch-ai-capabilities-and-gaps-audit.md`](./2026-05-05-arch-ai-capabilities-and-gaps-audit.md) §10.
**Companion:** capabilities-and-gaps audit (above) catalogs \_what* arch-ai can do; this doc audits _how the update flow actually executes_ and where it leaks.

---

## TL;DR

- The IN_PROJECT update flow is a 4-stage state machine: `IDLE → AWAIT_PENDING → APPLYING → IDLE` (or `AWAIT_BLOCKED` on repair-cap).
- Hash-based optimistic concurrency landed (SHA-256, dual-check at outer fast-fail + inside transaction). PROPOSAL_STALE clear path landed.
- **Two unbounded-blast-radius leaks remain:** silent diagnostics-throw swallow (G2) and regex-only cascade rename (G1). Both directly produce the user's stated pain point — "fix opens new problem."
- Specialist routing is content-router-driven, but `composeInProjectPrompt` is generalist-only — every specialist sees the same system prompt, only tool allow-list differs. Knowledge cards are the only specialist-specific signal.
- `agent_ops` exposes 3 parallel write paths (`modify`, `create`, `propose_modification`) that bypass the safety net (cross-agent validation, concurrency hash, cascade rename, cache invalidation, pending-mutation persistence).
- Cross-tab cache invalidation is local-only — 7 string keys on in-process Maps. No SSE broadcast. Other Studio panels see stale data.
- 20 gaps catalogued, 3 CRITICAL.

---

## 1. Visual flow (happy path)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ STUDIO BROWSER                                                           │
└──────────────────────────────────────────────────────────────────────────┘

 User types "make refundbot ask politely for order_id"
     │
 ArchOverlay.handleSendWithFiles                  components/arch/overlay/ArchOverlay.tsx:378
     │   sendMessage(text, files, refs)
 useArchChat.sendMessage  →  streamPost           ui/hook.ts:671
     │   POST /api/arch-ai/message
     ▼

┌──────────────────────────────────────────────────────────────────────────┐
│ STUDIO API ROUTE                            app/api/arch-ai/message/     │
│                                             route.ts                     │
└──────────────────────────────────────────────────────────────────────────┘

 requireTenantAuth (57)  → parse body (61)
 sessionService.getById (72) → requireProjectAccess (132 if IN_PROJECT)
 BUSY guard (98) → IDLE → ACTIVE atomic transition (159)
 acquireTurnLock (Redis, 219)
 createSSEStream + heartbeat 15s (233/270)
 messageTask = processInProjectMessage(...)
 NextResponse(stream, 'text/event-stream')

┌──────────────────────────────────────────────────────────────────────────┐
│ PROCESS-IN-PROJECT          processors/process-in-project.ts:271         │
└──────────────────────────────────────────────────────────────────────────┘

 BUILD → BLUEPRINT backtrack? (classifyMutationScope, 573-625)
 createProductionTurnEngine(tenantId)             engine-factory.ts:2333
 resolveTurnPlan:
   ├─ routeByContent(userMessage)                 content-router.ts:278
   ├─ getPageContextSpecialistBias                coordinator-bridge.ts:97
   ├─ getAllowedToolNames(phase, mode, specialist)
   │  └─ IN_PROJECT_SPECIALIST_TOOL_MAP           types/tools.ts:128-284
   ├─ composeInProjectPrompt                      prompts/index.ts:109
   │   ├─ BASE_PROMPT
   │   ├─ IN_PROJECT_GENERALIST_PROMPT  ⚠ specialist param ignored (deprecated)
   │   ├─ selectKnowledgeCards(userMsg)            card-router.ts:822
   │   ├─ formatContextSection(pageContext)
   │   ├─ projectMemorySection
   │   └─ IN_PROJECT_PHASE_PROMPT
   └─ journalSection appended after compose
 toolRegistry.subset(allowedToolNames)             registry.ts:207
 prepareTurnHistory + filePreamble
 engine.runTurn(...)                               turn-engine.ts:899

┌──────────────────────────────────────────────────────────────────────────┐
│ TURN ENGINE LOOP            turn-engine.ts:899                           │
└──────────────────────────────────────────────────────────────────────────┘

 while (rounds < cap):
   llmClient.stream(...)                           Vercel AI SDK streamText
   ├─ text_delta → SSE 'text_delta' (live)
   ├─ tool_call:
   │   ├─ interactive (ask_user/collect_*) → commit + pause turn + return
   │   └─ internal: ToolInvoker.invoke(...) → result → re-enter loop
   └─ finish → break

 LLM emits propose_modification(agentName, updatedCode | sections)
   │
   ▼

┌──────────────────────────────────────────────────────────────────────────┐
│ propose_modification                in-project-tools.ts:1809-2105        │
└──────────────────────────────────────────────────────────────────────────┘

 1. Validate input (xor: updatedCode | sections; isNew requires updatedCode)
 2. ProjectAgent.findOne({projectId, tenantId, name})
 3. proposedCode = sections ? spliceSections(...) : updatedCode
 4. validateProjectAgentCode(ctx, projectId, agentName, proposedCode)
    ┌──────────────────────────────────────────────────┐
    │ a. parseAgentBasedABL(proposedCode)              │
    │ b. siblings = ProjectAgent.find({projectId})     │
    │ c. resolveToolImplementations (tool binding)     │
    │ d. compileABLtoIR([target, ...siblings])         │
    │ e. before-keys = runProjectDiagnostics(siblings) │ ⚠ excludes edited agent's old doc
    │ f. after-findings = runProjectDiagnostics(all)   │
    │ g. semanticRegressions =                         │
    │      after.filter(severity='error'               │ ⚠ catches errors only, not warnings
    │                   && key ∉ before)               │
    │      key = sha(severity|code|agent|cat|path)     │ ⚠ message excluded
    │ h. wrapped in try/catch{} swallow                │ ⚠ silent on diagnostics throw (G2)
    └──────────────────────────────────────────────────┘
 5. !valid && repairCount<100 → VALIDATION_FAILED (loop, no pendingMutation)
 6. !valid && repairCount>=100 → setPendingMutation(reviewStatus:'blocked')
 7. valid → setPendingMutation({
       tool: 'apply_modification',
       target: agentName,
       scope: classifyAgentMutationScope(...),
       before, after: proposedCode,
       beforeHash: sha256(currentCode),
       reviewStatus: 'pending',
       impact, validation
    })
    return { success: true, proposal }

 [LLM expected to call ask_user(Confirmation) per prompt — no engine interlock]

 LLM emits ask_user({ widgetType: 'Confirmation', confirmLabel: 'Apply' })
   │
   ▼ interactive_tool path
 turn-engine commits, sets pendingInteraction, emits 'interactive_tool'
   ▼

┌──────────────────────────────────────────────────────────────────────────┐
│ STUDIO BROWSER — proposal review                                         │
└──────────────────────────────────────────────────────────────────────────┘

 SSE 'artifact_updated' { artifact:'diff', status:'pending', payload:proposal }
   │ syncDiffArtifact → upsertDiffTab → setOverlayState('artifacts')
 InProjectArtifactPanel renders InProjectDiffCard (Monaco diff, read-only)
 Chat renders Confirmation widget (Apply / Discard)

 User clicks Apply
   │ Confirmation.onSubmit(true) → WidgetRenderer → ArchOverlay
 sendToolAnswer(toolCallId, true) → POST /api/arch-ai/message
   { type:'tool_answer', toolCallId, answer:true }

┌──────────────────────────────────────────────────────────────────────────┐
│ DETERMINISTIC RESOLVE (NO LLM)     process-in-project.ts:312-501         │
└──────────────────────────────────────────────────────────────────────────┘

 type='tool_answer' && pendingMutation && pendingInteraction.widgetType='Confirmation'
 resolvePendingMutationDeterministically('accept', pendingMutation)
 buildInProjectTools.apply_modification.execute({ agentName })
   ▼

┌──────────────────────────────────────────────────────────────────────────┐
│ apply_modification + applyProjectAgentModification                       │
│                                in-project-tools.ts:984-1216 / 2108       │
└──────────────────────────────────────────────────────────────────────────┘

 apply_modification execute (2114-2214):
   Gate 1: NO_REVIEWED_PROPOSAL  if !pendingMut || target ≠ agentName
   Gate 2: PROPOSAL_BLOCKED      if reviewStatus = 'blocked'
   Gate 3: PROPOSAL_PAYLOAD_MISSING if !pendingMut.after
   dispatch isNew ? createNewProjectAgent : applyProjectAgentModification

 applyProjectAgentModification(ctx, projectId, agentName, updatedCode, beforeHash):
   a. ProjectAgent.findOne — outer hash check
      liveHash ≠ beforeHash → PROPOSAL_STALE (clears pendingMut later)
   b. validateProjectAgentCode (re-validate)
      fail → VALIDATION_FAILED (pendingMut NOT cleared)
   c. extractAgentNameFromABL — rename detection + pattern guard
      invalid → INVALID_AGENT_NAME
   d. withTransaction:
      ├─ re-read in-txn with session
      ├─ liveHashInTxn ≠ beforeHash → throw ProposalStaleError → rollback
      ├─ ProjectAgent.updateOne($set: {dslContent, name?, agentPath?})
      ├─ cascade rename — ⚠ ONLY for TO: regex (G1)
      │   misses: DELEGATE...AGENT, ESCALATE TARGET, available_agents,
      │           lowercase to:, action_handler.handoff/delegate,
      │           error_handler.handoff_target
      ├─ Project.updateOne({entryAgentName:Old} → New)
      └─ refreshPersistedStudioProjectAgentDraftMetadata
   e. invalidateProjectCaches(tenantId, projectId)
      ⚠ 7 in-process keys only; no IR/diagnostics/topology cache; no broadcast
   f. return { success: true, agentName, applied: true }

 setPendingMutation(null) (best-effort)
   ▼
 Deterministic resolver post-apply:
   ├─ artifact_updated { journal, entry }
   ├─ if hasTopologyImpact → read_topology + artifact_updated { topology }
   │   → SWR mutate /api/projects/:id/topology
   ├─ artifact_updated { diff, status:'applied' }
   │   → setLastAgentEdit() → AgentDetailPage / AgentEditor reload
   ├─ text_delta summary
   ├─ turn_committed + turn_ended { reason:'natural' }
   └─ ACTIVE → IDLE
```

---

## 2. State machine

```
  IDLE
   │  propose_modification(agentName, code|sections, isNew?)
   ▼
  VALIDATING
   │── fail (count<100) ──→ IDLE  (return VALIDATION_FAILED, no pendingMutation)
   │── fail (count>=100) ─→ AWAIT_BLOCKED  (setPendingMutation reviewStatus=blocked)
   └── success ──────────→ AWAIT_PENDING   (setPendingMutation reviewStatus=pending,
                                             beforeHash=H(currentCode))

  AWAIT_BLOCKED
   │── apply_modification ─→ rejected: PROPOSAL_BLOCKED  (stays in AWAIT_BLOCKED)
   │── dismiss_proposal ──→ IDLE
   └── propose_modification (revised) → VALIDATING

  AWAIT_PENDING
   │── apply_modification → APPLYING
   │── dismiss_proposal ─→ IDLE
   │── proposal_response action=modify → IDLE
   └── propose_modification (revised) → VALIDATING (overwrites pending entry)

  APPLYING (= applyProjectAgentModification)
   │── outer hash mismatch ─→ PROPOSAL_STALE → pendingMut cleared → IDLE
   │── re-validate fail ────→ VALIDATION_FAILED (pendingMut NOT cleared) → AWAIT_PENDING
   │── invalid name ────────→ INVALID_AGENT_NAME (pendingMut NOT cleared) → AWAIT_PENDING
   │── txn hash mismatch ───→ PROPOSAL_STALE (rollback) → pendingMut cleared → IDLE
   │── update + cascade ok ─→ invalidateProjectCaches → APPLIED
   └── any other throw ─────→ INTERNAL (pendingMut NOT cleared) → AWAIT_PENDING

  APPLIED
   └── clear pendingMutation (best-effort) → IDLE
```

---

## 3. Scenarios traced

### S1 — Happy path

PROPOSE → ask_user → APPLY → success. `lastAgentEditTimestamp` triggers `AgentDetailPage` and `AgentEditor` reload. Topology mutate fires only if `hasTopologyImpact`.

### S2 — Tab race / stale proposal

1. Tab A (canvas) and Tab B (arch-ai) open on same agent.
2. Tab B: LLM proposes → `pendingMutation.beforeHash = H₀`.
3. Tab A: user edits agent → `dslContent` → `H₁`.
4. Tab B: Apply → outer hash check fails → `PROPOSAL_STALE`.
5. `pendingMutation` cleared. Diff tab does NOT auto-dismiss (only `applied|rejected` trigger that). Banner shows raw error text. **No "re-propose" button.**

### S3 — Hidden cascade leak (rename)

1. User: "rename RefundBot → RefundAgent."
2. Sibling has `available_agents: [RefundBot]` and `DELEGATE...AGENT: RefundBot`.
3. Propose validates (single-agent compile passes).
4. Apply enters txn. `cascadeHandoffRename` regex `\bTO:\s*RefundBot\b` **misses both**.
5. After-state diagnostics: depending on rule coverage, either:
   - H-04 surfaces with a new key tuple → VALIDATION_FAILED → rollback. **OR**
   - The dangling reference key collapses with a pre-existing finding (G6) → suppressed → **silently commits broken DSL**.
6. Cache invalidated, but diagnostics cache isn't (it's not registered). User sees green checkmark; runtime fails on next handoff.

### S4 — Repair-cap exhaustion

1. LLM proposes invalid ABL (e.g. malformed `WHEN:` expression).
2. `repairCounts['refundbot']++` → `VALIDATION_FAILED`.
3. LLM revises, reproposes — loop.
4. After 100 attempts, propose returns `proposal:{ reviewStatus:'blocked' }` AND calls `setPendingMutation(reviewStatus:'blocked')`.
5. UI shows blocked-state diff with full validation hints (only place rich validation is rendered).
6. LLM may keep calling propose; counter is per-request, fresh request resets to 0 (intentional per comment 1234-1242).
7. `dismiss_proposal` clears pending but **does NOT reset `repairCounts`** — next failure still hits 100.

### S5 — Direct `agent_ops.modify` bypass

1. LLM picks `agent_ops.modify` instead of `propose_modification`.
2. `modifyAgent` → `updateProjectAgent` directly.
3. Validation: parse + **single-doc** compile only. **No cross-agent validation, no diagnostics, no cascade rename, no concurrency hash, no `invalidateProjectCaches`.**
4. `dryRun` defaults to `true` — but if LLM passes `false`, the write commits silently.
5. `agent_ops.propose_modification` is even worse: it returns a proposal envelope but **never calls `setPendingMutation`** → orphaned, can't be applied.

### S6 — Network failure mid-apply

1. Apply transaction commits in Mongo.
2. SSE drops before `artifact_updated{status:'applied'}` reaches client.
3. Reconnect: replay from Redis ring buffer if within retention; else `snapshot_required` → `loadCurrentSession`.
4. Fresh session shows `pendingMutation: null` (cleared post-apply).
5. `clearPendingDiffTabIfUnbacked` removes diff tab silently.
6. **User sees diff tab disappear with no confirmation.** `Retry` button (if visible) is a TODO stub.

### S7 — Cross-tab desync

1. Apply succeeds. `setLastAgentEdit()` fires.
2. Subscribers: only `AgentDetailPage`, `AgentEditor`, `App.tsx` eval-suggestion banner.
3. **Not subscribed:** trace viewer, KB browser, deployments tab, evals dashboard, project dashboard, AgentSelector dropdown (`useAgents`), agent list pages on other routes.
4. After agent rename: dropdowns show old name until route change or focus revalidate.

---

## 4. Gap consolidation (priority-ranked)

These are gaps NOT already in the capabilities-and-gaps audit §10 follow-up list.

| #   | Gap                                                                                                                                                                                                                   | Severity | Where                                                       | Fix shape                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| G1  | `cascadeHandoffRename` regex only matches `TO:` — silently breaks `DELEGATE...AGENT:`, `ESCALATE TARGET:`, `available_agents`, lowercase `to:`, action_handler `handoff:`/`delegate:`, `error_handler.handoff_target` | CRITICAL | `in-project-tools.ts:580, 1145`                             | AST-aware rename across routing edges (graph already at `routing-edge-extraction.ts`). Audit §8.5 locks as auto-rewrite.     |
| G2  | `runProjectDiagnostics` exception swallowed — silent regression bypass; CLAUDE.md "No swallowed catches" violation                                                                                                    | CRITICAL | `in-project-tools.ts:562-564`                               | Log + emit a structured warning; keep `valid:true` so diagnostics outage doesn't block all edits.                            |
| G3  | `agent_ops` parallel paths bypass safety net (`modify`, `create`, `propose_modification` actions skip cross-agent validation, concurrency hash, cascade rename, cache invalidation, pending-mutation persistence)     | CRITICAL | `agent-ops.ts:178-453`                                      | Forward all three actions to IN_PROJECT propose/apply, OR delete and remove from tool surface.                               |
| G4  | `composeInProjectPrompt` ignores specialist (`@deprecated`) — system prompt identical for all specialists                                                                                                             | HIGH     | `prompts/index.ts:109`                                      | Re-introduce per-specialist prompt section, OR force-load specialist domain card per audit §5.4.                             |
| G5  | No engine interlock between `propose_modification` and `apply_modification` — LLM can apply without intervening Confirmation                                                                                          | HIGH     | `turn-engine.ts:1048+`, `in-project-tools.ts:2120`          | Add `pendingMutation.confirmedAt` check in apply gate, OR make apply non-LLM-callable (only deterministic resolver invokes). |
| G6  | `diagnosticFindingKey` excludes `message` — distinct defects sharing `(severity, code, agent, category, path)` collapse                                                                                               | HIGH     | `in-project-tools.ts:209-227`                               | Include defect-id (rule match offset), or expand key with `(referenced_target, referenced_field)` for cross-agent codes.     |
| G7  | `semanticRegressions` filter only catches `severity='error'` — regression that downgrades to warning slips through                                                                                                    | HIGH     | `in-project-tools.ts:480-483`                               | Add severity-increase detector: same key, higher severity in after vs before.                                                |
| G8  | `invalidateProjectCaches` invalidates 7 string keys only — no IR/diagnostics/topology cache; no SSE broadcast                                                                                                         | HIGH     | `cache-invalidation.ts:25-40`                               | Emit SSE `project_invalidated`; register IR + diagnostics caches; client SWR/React-Query subscribers.                        |
| G9  | No audit journal for direct `apply_modification` calls — only `proposal_response` deterministic resolver writes journal                                                                                               | HIGH     | `in-project-tools.ts:1180`, `process-in-project.ts:381-406` | Move journal write inside `applyProjectAgentModification` (after txn commit, before cache invalidate).                       |
| G10 | Apply-time `VALIDATION_FAILED` rich validation discarded by `extractToolError`                                                                                                                                        | MEDIUM   | `process-in-project.ts:357`                                 | Forward full `validation` object on SSE error event.                                                                         |
| G11 | `INTERNAL` errors leak raw `err.message` to LLM (4 sites)                                                                                                                                                             | MEDIUM   | `in-project-tools.ts:980, 1211, 2099, 2211`                 | Sanitize per CLAUDE.md "User-Facing Runtime Error Sanitization."                                                             |
| G12 | `pendingMutation` not cleared on post-propose `NOT_FOUND` or `VALIDATION_FAILED` from writer — LLM retries with same envelope                                                                                         | MEDIUM   | `in-project-tools.ts:1029, 1063`                            | Mirror PROPOSAL_STALE clear pattern.                                                                                         |
| G13 | No `CONCURRENT_EDIT` distinct from `PROPOSAL_STALE` — can't distinguish "apply lost a race" from "stale read"                                                                                                         | MEDIUM   | `in-project-tools.ts:1196`                                  | Add `CONCURRENT_EDIT` for in-txn re-check; keep `PROPOSAL_STALE` for outer pre-txn fast-fail.                                |
| G14 | UI: `PROPOSAL_STALE` has no "re-propose with current state" affordance                                                                                                                                                | MEDIUM   | `ArchOverlay.tsx:574-603`, `event-dispatcher.ts:1044-1061`  | Code-aware copy + button to resend last user prompt.                                                                         |
| G15 | UI: cross-tab desync — KB browser, deployments, evals, traces, project dashboard, `AgentSelector` don't subscribe to `lastAgentEditTimestamp`                                                                         | MEDIUM   | `arch-ai-store.ts:395` and consumers                        | Subscribe each long-lived view OR move to SSE-driven SWR mutate.                                                             |
| G16 | UI: `Retry` button exists but `retry` action is TODO stub                                                                                                                                                             | LOW      | `hook.ts:846-848`                                           | Wire (replay last user message) or hide when stub.                                                                           |
| G17 | UI: `sendProposal` action is dead code (no consumer)                                                                                                                                                                  | LOW      | `hook.ts:687-688, 815`                                      | Delete or wire.                                                                                                              |
| G18 | UI: network failure mid-apply leaves no confirmation copy when SSE drops past Redis retention                                                                                                                         | LOW      | `hook.ts:614-622`, `proposal-artifacts.ts`                  | On `snapshot_required` re-fetch, compare new `dslContent` to diff-tab's `before/after` and toast "applied silently."         |
| G19 | `dismiss_proposal` does not reset `repairCounts` — same agent immediately blocks again on next failure                                                                                                                | LOW      | `in-project-tools.ts:2218-2230`                             | Call `resetRepairAttempt(agentName)` inside dismiss.                                                                         |
| G20 | No undo / version history — applied modifications non-reversible                                                                                                                                                      | DESIGN   | n/a                                                         | Capture inverse cascade in journal, add `undo_modification` tool.                                                            |

---

## 5. Recommended next move

Two unbounded-blast-radius items map directly to the user's stated pain ("solving one problem but opening another"): **G2** (silent diagnostics swallow) and **G1** (regex cascade leak). Both ship broken DSL that compiles but breaks at runtime.

**Suggested order:**

1. **G2** — 5-line fix; lands now in this session.
2. **G1** — separate focused branch, AST-aware rename. Worth a small spec.
3. **G3** — collapse `agent_ops` parallel write paths.
4. **G5** — engine interlock between propose/apply.
5. **G7** — severity-increase regression detection.
6. UI cluster (G14, G15) — better PROPOSAL_STALE UX + cross-tab sync.

---

## 6. References

- Capabilities-and-gaps audit: [`2026-05-05-arch-ai-capabilities-and-gaps-audit.md`](./2026-05-05-arch-ai-capabilities-and-gaps-audit.md)
- Wire-unregistered-tools spec (G#1 from capabilities audit, RESOLVED 2026-05-05): [`2026-05-05-wire-unregistered-tools-spec.md`](./2026-05-05-wire-unregistered-tools-spec.md)
- Plugin discard decision: `~/.claude/projects/-Users-sriharshanalluri-abl-platform/memory/feedback-plugin-approach-discarded.md`
- Cross-cutting principles: `CLAUDE.md` § Resource Isolation, Centralized Auth, Type Safety, Studio Route Handler Gotchas, User-Facing Runtime Error Sanitization
