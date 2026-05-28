# ABLP-900 Triage: Root Supervisor Incorrectly Calls `__return_to_parent__`

**Owner:** Bhanuraja Kurapati
**Triaged by:** Prasanna (root cause analysis + reproduction test)
**Date:** 2026-05-16

---

## Symptom

After CAIAuth_Specialist completes and returns to the root supervisor (CignaRouter), the root selects `__return_to_parent__` with reasoning "Authentication successful". The runtime correctly rejects it (`"No parent to return to."`), but the tool should never have been visible to the root agent in the first place.

Observed in Grok realtime voice (`grok-2-1212`), project `019dd384-2796-7dd3-8abb-60a40e2143ce`.

## Root Cause

**Primary site:** `apps/runtime/src/services/execution/prompt-builder.ts:1268-1269`

```typescript
const activeThread = getActiveThread(session);
if (activeThread?.returnExpected && activeThread?.handoffFrom) {
  tools.push({ name: SYSTEM_TOOL_RETURN_TO_PARENT, ... });
}
```

The guard consults **transient thread state** (`returnExpected`, `handoffFrom`) but never validates **topology** (whether the current agent actually has a parent in the supervisor hierarchy). If any code path allows these fields to be true on the root's active thread, the tool leaks.

**Production trigger:** `apps/runtime/src/services/voice/korevg/realtime-tool-definitions.ts:29-57`

```typescript
function buildRealtimeToolDefinitionsForAgent(session, agentName, agentIR) {
  const activeThread = getActiveThread(session); // <-- current active thread (could be child)
  const tempThread = {
    ...activeThread, // copies returnExpected + handoffFrom from child!
    agentName,
    agentIR,
    status: 'active',
  };
  // ...
  return toRealtimeToolDefinitions(buildTools(tempSession));
}
```

When `buildGoogleRealtimeToolDefinitions` iterates ALL agents to create a stable superset (Google/Gemini cannot update tools mid-session), it spreads the child's `returnExpected: true` and `handoffFrom` into every agent's temp session, including the root. `buildTools` sees the condition met and adds `__return_to_parent__` to the root.

**Grok-specific amplifier:** For Grok realtime, the `session.update` with new tools is deferred until after the current response completes (line 3735 in `korevg-router.ts`). Between the child's return and the deferred session.update, the model retains the child's tool set (which includes `__return_to_parent__`) and can call it as the root.

## Reproduction Test

File: `apps/runtime/src/__tests__/execution/supervisor-tools.repro.test.ts`

Simulates the leaked state: root thread has `returnExpected=true` + `handoffFrom` set (as occurs via the Google superset builder or the Grok race window), calls `buildTools`, asserts `__return_to_parent__` is NOT present. Fails today because no topology guard exists.

## Future-Ready Solution

**Principle:** Control-flow built-in tools are derived from **supervisor topology**, not transient thread state. Root agents never see `return_to_parent`; leaf agents only see `return_to_parent` for their actual ancestors.

### Implementation Path

1. **Add topology guard to `buildTools`** (prompt-builder.ts:1268):
   - In addition to `returnExpected && handoffFrom`, require `session.threadStack.length > 0` (proving a parent frame exists on the stack).
   - This is the minimal fix that prevents the tool from ever appearing on a root-active session.

2. **Fix `buildRealtimeToolDefinitionsForAgent`** (realtime-tool-definitions.ts:35):
   - Override `returnExpected: false` and `handoffFrom: undefined` in the temp thread when building for an agent that is NOT the current active child. Only preserve `returnExpected` for the currently active child thread.

3. **Compile-time helper** (`isRootAgent(topology, name)`):
   - An agent is root if no other agent targets it via `HANDOFF: TO: <name> RETURN: true`.
   - Emit during compilation; attach to `AgentIR.metadata.isRoot` or expose from `compilationOutput`.
   - Require all future system-tool emission sites to consult topology, not just runtime state.

4. **Grok deferred update race:**
   - When `executeRealtimeToolCall` processes `__return_to_parent__`, the resulting session.update should be sent immediately (not deferred), or the tool should be stripped from the existing session tool list inline before deferral.

### Validation Criteria

- `buildTools(session)` NEVER returns `__return_to_parent__` when `session.threadStack.length === 0`
- `buildGoogleRealtimeToolDefinitions` does not include `__return_to_parent__` for the root agent
- The existing runtime guard at `routing-executor.ts:4621` remains as a defense-in-depth backstop
