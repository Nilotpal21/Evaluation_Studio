/**
 * Memory Integration — Facade connecting standalone memory services to the execution pipeline.
 *
 * This module provides fire-and-forget-safe wrappers around:
 * - MemoryExecutor (REMEMBER triggers, RECALL instructions)
 * - EventDetector (maps tool calls/entity extractions to memory events)
 * - PreferenceDetector (extracts preference signals from user utterances)
 *
 * Ownership model:
 * - FactStore is scoped to (tenantId, userId, projectId) at construction time
 * - Keys are just paths (e.g., "preferences.chain") — no user prefix baked in
 * - The store itself enforces isolation; callers don't need to build composite keys
 *
 * Performance:
 * - initializeAllMemory() loads persistent defaults via getMany() ($in query, 1 DB round-trip)
 * - Only readable paths are fetched (write-only paths skipped)
 * - Session-start recall runs in parallel with defaults loading
 * - REMEMBER writes and preference stores are fire-and-forget
 *
 * Every function:
 * - Guards with no-op on missing memory config or FactStore
 * - Wraps body in try/catch — emits memory_error trace, never throws
 * - Isolates per-field errors for persistent memory loading
 */

import type { AgentIR } from '@abl/compiler';
import type { PersistentMemory } from '@abl/compiler/platform/ir/schema.js';
import { evaluateRememberTriggers, executeRecallInstructions } from './memory-executor.js';
import {
  filterUnchangedOperations,
  clampDedupDepthCap,
  DEFAULT_DEDUP_MAX_DEPTH,
} from './memory-dedup.js';
import { RecallService } from '../omnichannel/recall-service.js';
import { getOmnichannelSettings } from '../omnichannel/omnichannel-settings-service.js';
import {
  resolveToolAfterEvents,
  resolveAgentEvents,
  detectEntityEvents,
} from './event-detector.js';
import { detectPreferencesFromText } from './preference-detector.js';
import type { RuntimeSession } from './types.js';
import { createLogger } from '@abl/compiler/platform';
import {
  ensureExecutionTreeValues,
  getExecutionTreeValue,
  refreshExecutionTreeProjection,
  setExecutionTreeValue,
} from './memory-scope-runtime.js';

const log = createLogger('memory-integration');

type TraceCallback = (event: { type: string; data: Record<string, unknown> }) => void;

// =============================================================================
// Combined Session-Start Entry Point (replaces separate init + recall)
// =============================================================================

/**
 * Single entry point for all session-start memory operations.
 * Runs persistent-defaults loading and session_start RECALL in parallel.
 *
 * Call this once in initializeSession() — it replaces the two separate calls.
 */
export async function initializeAllMemory(
  session: RuntimeSession,
  agentIR: AgentIR,
  onTraceEvent?: TraceCallback,
): Promise<void> {
  try {
    const memory = agentIR.memory;
    if (!memory) {
      emitDecisionTrace(session, onTraceEvent, {
        type: 'memory_unavailable',
        data: {
          reason: 'no_memory_config',
          operation: 'init',
          agentName: agentIR.metadata?.name || session.agentName,
        },
      });
      await executeOmnichannelRecall(session, agentIR, onTraceEvent);
      session.data.values._memory_initialized_agent = agentIR.metadata?.name ?? session.agentName;
      return;
    }

    // Session memory: set initial values (synchronous, no DB)
    if (memory.session) {
      for (const sv of memory.session) {
        if (sv.initial_value !== undefined && !(sv.name in session.data.values)) {
          session.data.values[sv.name] = sv.initial_value;
        }
      }
    }

    // Initialize built-in counter
    if (!('_clarification_count' in session.data.values)) {
      session.data.values._clarification_count = 0;
    }

    // Parallel: batch-load persistent defaults, execute session_start RECALL,
    // and hydrate any omnichannel recall context. These are all independent
    // startup reads against separate backing stores.
    await Promise.all([
      loadPersistentDefaults(session, memory.persistent || [], onTraceEvent, agentIR),
      executeRecallForEvents(
        session,
        memory.recall || [],
        ['session:start'],
        'session_start',
        onTraceEvent,
      ),
      executeOmnichannelRecall(session, agentIR, onTraceEvent),
    ]);
    session.data.values._memory_initialized_agent = agentIR.metadata?.name ?? session.agentName;

    onTraceEvent?.({
      type: 'memory_init',
      data: {
        sessionVarsLoaded: memory.session?.length ?? 0,
        persistentVarsLoaded: memory.persistent?.length ?? 0,
      },
    });
  } catch (err) {
    log.error('initializeAllMemory failed', { error: String(err) });
    onTraceEvent?.({
      type: 'memory_error',
      data: { operation: 'initializeAllMemory', error: String(err) },
    });
  }
}

export async function initializeActivatedAgentMemory(
  session: RuntimeSession,
  agentIR: AgentIR,
  onTraceEvent?: TraceCallback,
): Promise<void> {
  const initializedForAgent = session.data.values._memory_initialized_agent;
  if (initializedForAgent === agentIR.metadata?.name) {
    refreshExecutionTreeProjection(session, agentIR);
    return;
  }

  if (agentIR.memory?.session) {
    for (const sv of agentIR.memory.session) {
      if (sv.initial_value !== undefined && !(sv.name in session.data.values)) {
        session.data.values[sv.name] = sv.initial_value;
      }
    }
  }

  await loadPersistentDefaults(session, agentIR.memory?.persistent || [], onTraceEvent, agentIR);
  await executeOmnichannelRecall(session, agentIR, onTraceEvent);
  session.data.values._memory_initialized_agent = agentIR.metadata?.name ?? session.agentName;
}

// =============================================================================
// Gap 4: Load Persistent Defaults (batch read)
// =============================================================================

/**
 * Loads persistent memory from FactStore(s) in batch queries.
 * User-scoped paths load from session.factStore, project-scoped from session.projectFactStore.
 * Falls back to default_value from the IR for paths not found in the store.
 */
async function loadPersistentDefaults(
  session: RuntimeSession,
  persistent: PersistentMemory[],
  onTraceEvent?: TraceCallback,
  agentIR?: AgentIR,
): Promise<void> {
  if (persistent.length === 0) {
    refreshExecutionTreeProjection(session, agentIR);
    return;
  }

  // Split by scope
  const userPaths = persistent.filter((pm) => (pm.scope ?? 'user') === 'user');
  const projectPaths = persistent.filter((pm) => pm.scope === 'project');
  const executionTreePaths = persistent.filter((pm) => (pm.scope as string) === 'execution_tree');

  // Load user-scoped paths from user factStore
  await loadPathsFromStore(session, userPaths, session.factStore, 'user', onTraceEvent);

  // Load project-scoped paths from project factStore
  await loadPathsFromStore(
    session,
    projectPaths,
    session.projectFactStore,
    'project',
    onTraceEvent,
  );

  await loadPathsFromExecutionTree(session, executionTreePaths);
  refreshExecutionTreeProjection(session, agentIR);
}

/** Load a set of persistent paths from a specific fact store */
async function loadPathsFromStore(
  session: RuntimeSession,
  paths: PersistentMemory[],
  factStore: import('@abl/compiler/platform/stores/fact-store.js').FactStore | undefined,
  scope: 'user' | 'project',
  onTraceEvent?: TraceCallback,
): Promise<void> {
  if (paths.length === 0) return;

  if (!factStore) {
    // No FactStore — fall back to default_value for all paths
    for (const pm of paths) {
      if (pm.default_value !== undefined) {
        session.data.values[pm.path] = pm.default_value;
      }
    }
    return;
  }

  try {
    // Only fetch paths that should be loaded (read or readwrite, not write-only)
    const readablePaths = paths.filter((pm) => pm.access !== 'write').map((pm) => pm.path);

    // Single $in query instead of loading all facts and filtering client-side
    const factMap = readablePaths.length > 0 ? await factStore.getMany(readablePaths) : new Map();

    for (const pm of paths) {
      if (pm.access === 'write') continue; // write-only paths are not loaded at start
      const fact = factMap.get(pm.path);
      if (fact) {
        session.data.values[pm.path] = fact.value;
      } else if (pm.default_value !== undefined) {
        session.data.values[pm.path] = pm.default_value;
      }
    }
  } catch (err) {
    log.warn(`Batch fact load failed for ${scope} scope, falling back to defaults`, {
      error: String(err),
    });
    // Per-field fallback to default_value
    for (const pm of paths) {
      if (pm.default_value !== undefined && !(pm.path in session.data.values)) {
        session.data.values[pm.path] = pm.default_value;
      }
    }
    onTraceEvent?.({
      type: 'memory_error',
      data: { operation: 'loadPersistentDefaults', scope, error: String(err) },
    });
  }
}

async function loadPathsFromExecutionTree(
  session: RuntimeSession,
  paths: PersistentMemory[],
): Promise<void> {
  if (paths.length === 0) {
    return;
  }

  const executionTreeValues = ensureExecutionTreeValues(session);
  for (const pm of paths) {
    if (pm.access === 'write') {
      continue;
    }

    const value = executionTreeValues[pm.path];
    if (value !== undefined) {
      session.data.values[pm.path] = value;
    } else if (pm.default_value !== undefined) {
      session.data.values[pm.path] = pm.default_value;
    }
  }
}

// =============================================================================
// Gap 1: Evaluate REMEMBER Triggers After State Change
// =============================================================================

/**
 * Evaluates REMEMBER triggers against current session state and stores
 * matching values to the FactStore. Fire-and-forget safe.
 */
export async function evaluateRememberAfterStateChange(
  session: RuntimeSession,
  onTraceEvent?: TraceCallback,
): Promise<void> {
  try {
    const ir = session.agentIR;
    if (!ir?.memory?.remember?.length) {
      emitDecisionTrace(session, onTraceEvent, {
        type: 'memory_unavailable',
        data: {
          reason: 'no_memory_config',
          operation: 'remember',
          agentName: session.agentName,
        },
      });
      return;
    }

    const factStore = session.factStore;

    // Build a lookup map from path → scope for routing writes
    const scopeMap = new Map<string, 'user' | 'project' | 'execution_tree'>();
    if (ir.memory.persistent) {
      for (const p of ir.memory.persistent) {
        scopeMap.set(
          p.path,
          (p.scope as 'user' | 'project' | 'execution_tree' | undefined) ?? 'user',
        );
      }
    }

    const operations = evaluateRememberTriggers(ir.memory.remember, session.data.values, {
      factStore,
      tenantId: session.tenantId,
      userId: session.userId,
    });

    if (operations.length === 0) {
      // No triggers matched (existing behavior)
      emitDecisionTrace(session, onTraceEvent, {
        type: 'memory_trigger_evaluated',
        data: {
          result: false,
          reason: 'no_conditions_matched',
          triggerCount: ir.memory.remember.length,
          agentName: session.agentName,
        },
      });
      return;
    }

    // Resolve dedup depth cap once per session — lazy-load from ProjectSettings.
    const depthCap = await resolveDedupDepthCap(session);

    // Group operations by scope so each backing store gets one getMany / dedup pass.
    type BucketOp = {
      op: (typeof operations)[number];
      scope: 'user' | 'project' | 'execution_tree';
    };
    const userBucket: BucketOp[] = [];
    const projectBucket: BucketOp[] = [];
    const executionTreeBucket: BucketOp[] = [];
    for (const op of operations) {
      const scope = scopeMap.get(op.key) ?? 'user';
      if (scope === 'project') {
        projectBucket.push({ op, scope });
      } else if (scope === 'execution_tree') {
        executionTreeBucket.push({ op, scope });
      } else {
        userBucket.push({ op, scope });
      }
    }

    const toWrite: Array<BucketOp & { targetStore: NonNullable<typeof factStore> }> = [];
    const executionTreeWrites: BucketOp[] = [];
    const skipped: BucketOp[] = [];

    for (const [bucket, bucketScope, targetStore] of [
      [userBucket, 'user' as const, factStore],
      [projectBucket, 'project' as const, session.projectFactStore],
    ] as const) {
      if (bucket.length === 0) continue;
      if (!targetStore) {
        emitDecisionTrace(session, onTraceEvent, {
          type: 'memory_unavailable',
          data: {
            reason: 'no_fact_store',
            operation: 'remember',
            scope: bucketScope,
            agentName: session.agentName,
          },
        });
        for (const entry of bucket) {
          log.warn('REMEMBER skipped — no store for scope', {
            key: entry.op.key,
            scope: bucketScope,
          });
        }
        continue;
      }
      const keys = bucket.map((entry) => entry.op.key);
      const currentFacts = await targetStore.getMany(keys);
      const currentValues = new Map<string, unknown>();
      for (const [key, fact] of currentFacts) currentValues.set(key, fact.value);

      const dedupResult = filterUnchangedOperations(
        bucket.map((entry) => entry.op),
        currentValues,
        depthCap,
      );
      const writeSet = new Set(dedupResult.toWrite.map((o) => o.key));
      for (const entry of bucket) {
        if (writeSet.has(entry.op.key)) {
          toWrite.push({ ...entry, targetStore });
        } else {
          skipped.push(entry);
        }
      }
    }

    if (executionTreeBucket.length > 0) {
      const currentValues = new Map<string, unknown>();
      for (const entry of executionTreeBucket) {
        currentValues.set(entry.op.key, getExecutionTreeValue(session, entry.op.key));
      }

      const dedupResult = filterUnchangedOperations(
        executionTreeBucket.map((entry) => entry.op),
        currentValues,
        depthCap,
      );
      const writeSet = new Set(dedupResult.toWrite.map((entry) => entry.key));
      for (const entry of executionTreeBucket) {
        if (writeSet.has(entry.op.key)) {
          executionTreeWrites.push(entry);
        } else {
          skipped.push(entry);
        }
      }
    }

    // Emit a skip trace for each deduped op. Always visible (not verbosity-gated)
    // so dashboards can still count writes-skipped regardless of trace level.
    if (skipped.length > 0) {
      for (const entry of skipped) {
        onTraceEvent?.({
          type: 'memory_dedup_skipped',
          data: {
            trigger: entry.op.key,
            reason: 'unchanged',
            skipped: true,
            scope: entry.scope,
            agentName: session.agentName,
          },
        });
      }
    }

    // Execute writes.
    for (const entry of toWrite) {
      try {
        await entry.targetStore.set({
          key: entry.op.key,
          value: entry.op.value,
          ttlMs: entry.op.ttl ? parseTtlToMs(entry.op.ttl) : undefined,
          source: {
            type: 'agent',
            agentName: session.agentName,
            sessionId: session.id,
          },
        });
      } catch (err) {
        log.warn('REMEMBER store failed', { key: entry.op.key, error: String(err) });
      }
    }

    for (const entry of toWrite) {
      emitDecisionTrace(session, onTraceEvent, {
        type: 'memory_trigger_evaluated',
        data: {
          result: true,
          trigger: entry.op.key,
          value: entry.op.value,
          agentName: session.agentName,
        },
      });
    }

    for (const entry of executionTreeWrites) {
      setExecutionTreeValue(session, entry.op.key, entry.op.value);
      session.data.values[entry.op.key] = entry.op.value;
      emitDecisionTrace(session, onTraceEvent, {
        type: 'memory_trigger_evaluated',
        data: {
          result: true,
          trigger: entry.op.key,
          value: entry.op.value,
          scope: 'execution_tree',
          agentName: session.agentName,
        },
      });
    }

    if (executionTreeWrites.length > 0) {
      refreshExecutionTreeProjection(session);
    }

    if (toWrite.length > 0 || executionTreeWrites.length > 0 || skipped.length > 0) {
      onTraceEvent?.({
        type: 'memory_remember',
        data: {
          stored: toWrite.map((e) => e.op.key),
          executionTreeStored: executionTreeWrites.map((e) => e.op.key),
          skipped: skipped.map((e) => e.op.key),
        },
      });
    }
  } catch (err) {
    log.error('evaluateRememberAfterStateChange failed', { error: String(err) });
    onTraceEvent?.({
      type: 'memory_error',
      data: { operation: 'evaluateRememberAfterStateChange', error: String(err) },
    });
  }
}

// =============================================================================
// Gap 2: Execute RECALL (shared implementation for all event sources)
// =============================================================================

/**
 * Shared RECALL execution for any event source.
 * Runs recall instructions matching the given events and injects data into session.
 * Accepts recall instructions directly to avoid dependency on session.agentIR.
 */
async function executeRecallForEvents(
  session: RuntimeSession,
  recallInstructions: import('@abl/compiler/platform/ir/schema.js').RecallInstruction[],
  events: string[],
  eventSource: string,
  onTraceEvent?: TraceCallback,
): Promise<void> {
  if (!recallInstructions.length) return;

  const injectedData: Record<string, unknown> = {};

  if (session.factStore) {
    const userData = await executeRecallInstructions(recallInstructions, events, {
      factStore: session.factStore,
      tenantId: session.tenantId,
      userId: session.userId,
    });
    Object.assign(injectedData, userData);
  }

  if (session.projectFactStore) {
    const projectData = await executeRecallInstructions(recallInstructions, events, {
      factStore: session.projectFactStore,
      tenantId: session.tenantId,
      userId: session.userId,
    });
    Object.assign(injectedData, projectData);
  }

  const persistentScopes = new Map(
    (session.agentIR?.memory?.persistent ?? []).map((entry) => [
      entry.path,
      entry.scope as string | undefined,
    ]),
  );
  for (const instruction of recallInstructions) {
    if (instruction.action?.type !== 'inject_context') {
      continue;
    }

    for (const path of instruction.action.paths) {
      if (persistentScopes.get(path) !== 'execution_tree') {
        continue;
      }

      const executionTreeValue = getExecutionTreeValue(session, path);
      if (executionTreeValue !== undefined) {
        injectedData[path] = executionTreeValue;
      }
    }
  }

  const injectedKeys = Object.keys(injectedData);

  if (injectedKeys.length > 0) {
    Object.assign(session.data.values, injectedData);
    refreshExecutionTreeProjection(session);
    onTraceEvent?.({
      type: 'memory_recall',
      data: { event: eventSource, events, injectedKeys },
    });
  }

  // Emit detailed recall result trace at verbose/debug verbosity
  emitDecisionTrace(session, onTraceEvent, {
    type: 'memory_recall_result',
    data: {
      factsFound: injectedKeys.length,
      factsLoaded: injectedKeys,
      event: eventSource,
      agentName: session.agentName,
    },
  });
}

/**
 * Execute RECALL after a tool call. Fire-and-forget safe.
 */
export async function executeRecallAfterToolCall(
  session: RuntimeSession,
  toolName: string,
  onTraceEvent?: TraceCallback,
): Promise<void> {
  try {
    const ir = session.agentIR;
    if (!ir?.memory?.recall?.length) {
      emitDecisionTrace(session, onTraceEvent, {
        type: 'memory_unavailable',
        data: {
          reason: 'no_memory_config',
          operation: 'recall',
          agentName: session.agentName,
        },
      });
      return;
    }

    const events = resolveToolAfterEvents(toolName);
    if (events.length === 0) return;
    await executeRecallForEvents(
      session,
      ir.memory.recall,
      events,
      `tool:${toolName}`,
      onTraceEvent,
    );
  } catch (err) {
    log.error('executeRecallAfterToolCall failed', { error: String(err) });
    onTraceEvent?.({
      type: 'memory_error',
      data: { operation: 'executeRecallAfterToolCall', error: String(err) },
    });
  }
}

/**
 * Execute RECALL for an agent lifecycle event (before/after handoff, delegate, fan-out).
 * Fire-and-forget safe — never throws.
 */
export async function executeRecallForAgentEvent(
  session: RuntimeSession,
  agentName: string,
  phase: 'before' | 'after',
  onTraceEvent?: TraceCallback,
): Promise<void> {
  try {
    const ir = session.agentIR;
    if (!ir?.memory?.recall?.length) {
      return;
    }

    const events = resolveAgentEvents(agentName, phase);
    if (events.length === 0) return;
    await executeRecallForEvents(
      session,
      ir.memory.recall,
      events,
      `agent:${agentName}:${phase}`,
      onTraceEvent,
    );
  } catch (err) {
    log.error('executeRecallForAgentEvent failed', {
      agentName,
      phase,
      error: err instanceof Error ? err.message : String(err),
    });
    onTraceEvent?.({
      type: 'memory_error',
      data: { operation: 'executeRecallForAgentEvent', agentName, phase, error: String(err) },
    });
  }
}

/**
 * Execute RECALL after entity extraction. Fire-and-forget safe.
 */
export async function executeRecallAfterExtraction(
  session: RuntimeSession,
  fieldNames: string[],
  onTraceEvent?: TraceCallback,
): Promise<void> {
  try {
    const ir = session.agentIR;
    if (!ir?.memory?.recall?.length) {
      emitDecisionTrace(session, onTraceEvent, {
        type: 'memory_unavailable',
        data: {
          reason: 'no_memory_config',
          operation: 'recall',
          agentName: session.agentName,
        },
      });
      return;
    }

    const events = detectEntityEvents(fieldNames);
    if (events.length === 0) return;
    await executeRecallForEvents(
      session,
      ir.memory.recall,
      events,
      'entity_extraction',
      onTraceEvent,
    );
  } catch (err) {
    log.error('executeRecallAfterExtraction failed', { error: String(err) });
    onTraceEvent?.({
      type: 'memory_error',
      data: { operation: 'executeRecallAfterExtraction', error: String(err) },
    });
  }
}

// =============================================================================
// Gap 3: Detect and Store Preferences
// =============================================================================

/**
 * Detects preference signals from user utterances and stores them via FactStore.
 * Only runs for gather fields with preferences: true. Fire-and-forget safe.
 */
export async function detectAndStorePreferences(
  session: RuntimeSession,
  userMessage: string,
  fieldNames: string[],
  onTraceEvent?: TraceCallback,
): Promise<void> {
  try {
    const ir = session.agentIR;
    const gatherFields = ir?.gather?.fields;
    if (!gatherFields) {
      emitDecisionTrace(session, onTraceEvent, {
        type: 'memory_unavailable',
        data: {
          reason: 'no_memory_config',
          operation: 'preferences',
          agentName: session.agentName,
        },
      });
      return;
    }

    const prefFields = gatherFields.filter((f) => f.preferences && fieldNames.includes(f.name));
    if (prefFields.length === 0) return;

    const factStore = session.factStore;
    if (!factStore) {
      emitDecisionTrace(session, onTraceEvent, {
        type: 'memory_unavailable',
        data: {
          reason: 'no_fact_store',
          operation: 'preferences',
          agentName: session.agentName,
        },
      });
      return;
    }

    const detected = detectPreferencesFromText(userMessage);
    if (detected.length === 0) return;

    for (const pref of detected) {
      try {
        const key = `preferences.${pref.category}`;
        const existing = await factStore.get({ key });
        const existingValues = (existing?.value as string[]) ?? [];
        if (!existingValues.includes(pref.value)) {
          await factStore.set({
            key,
            value: [...existingValues, pref.value],
            source: {
              type: 'agent',
              agentName: session.agentName,
              sessionId: session.id,
            },
          });
        }

        // Emit per-preference decision trace
        emitDecisionTrace(session, onTraceEvent, {
          type: 'preference_detected',
          data: {
            category: pref.category,
            confidence: pref.confidence,
            text: pref.value,
            agentName: session.agentName,
          },
        });
      } catch (err) {
        log.warn('Preference store failed', { category: pref.category, error: String(err) });
      }
    }

    onTraceEvent?.({
      type: 'memory_preferences',
      data: { detected: detected.length, categories: detected.map((d) => d.category) },
    });
  } catch (err) {
    log.error('detectAndStorePreferences failed', { error: String(err) });
    onTraceEvent?.({
      type: 'memory_error',
      data: { operation: 'detectAndStorePreferences', error: String(err) },
    });
  }
}

// =============================================================================
// Omnichannel Recall (Cross-Channel Transcript History)
// =============================================================================

/**
 * Execute omnichannel recall to retrieve cross-channel transcript history.
 *
 * This is separate from the FactStore-based memory recall. It queries the
 * Message collection for previous conversation messages from the same contact
 * across different channels/sessions.
 *
 * Fire-and-forget safe — errors are logged but never thrown.
 * Results are injected into session context as an `_omnichannel_recall` data value.
 *
 * @param session - The current runtime session
 * @param agentIR - The agent IR configuration (checked for omnichannel.recall.enabled)
 * @param onTraceEvent - Optional trace event callback
 */
export async function executeOmnichannelRecall(
  session: RuntimeSession,
  agentIR: AgentIR,
  onTraceEvent?: TraceCallback,
): Promise<void> {
  try {
    // Check if omnichannel recall is enabled in the agent IR
    if (!agentIR.omnichannel?.recall?.enabled) {
      emitDecisionTrace(session, onTraceEvent, {
        type: 'omnichannel_recall_skipped',
        data: {
          reason: 'not_enabled_in_agent_ir',
          agentName: agentIR.metadata?.name ?? session.agentName,
        },
      });
      return;
    }

    // Require tenant and project context
    const tenantId = session.tenantId;
    const projectId = session.projectId;
    if (!tenantId || !projectId) {
      emitDecisionTrace(session, onTraceEvent, {
        type: 'omnichannel_recall_skipped',
        data: {
          reason: 'missing_tenant_or_project',
          agentName: session.agentName,
        },
      });
      return;
    }

    // Require a contact ID from the caller context
    const contactId = session.callerContext?.contactId;
    if (!contactId) {
      emitDecisionTrace(session, onTraceEvent, {
        type: 'omnichannel_recall_skipped',
        data: {
          reason: 'no_contact_id',
          agentName: session.agentName,
        },
      });
      return;
    }

    // Check identity tier from caller context
    const identityTier = session.callerContext?.identityTier ?? 0;

    // Get project settings for minTier check
    const settings = await getOmnichannelSettings(tenantId, projectId);
    const minTier = settings.identity.minTier;

    if (identityTier < minTier) {
      emitDecisionTrace(session, onTraceEvent, {
        type: 'omnichannel_recall_skipped',
        data: {
          reason: 'identity_tier_insufficient',
          identityTier,
          minTier,
          agentName: session.agentName,
        },
      });
      return;
    }

    // Check project-level recall enabled
    if (!settings.recall.enabled) {
      emitDecisionTrace(session, onTraceEvent, {
        type: 'omnichannel_recall_skipped',
        data: {
          reason: 'recall_disabled_in_project_settings',
          agentName: session.agentName,
        },
      });
      return;
    }

    // Execute recall
    const recallService = new RecallService(tenantId, projectId);
    const result = await recallService.getRecallMessages({
      sessionId: session.id,
      tenantId,
      projectId,
      contactId,
      maxMessages: agentIR.omnichannel.recall.maxMessages ?? settings.recall.maxMessages,
      maxAgeDays: agentIR.omnichannel.recall.maxAgeDays ?? settings.recall.maxAgeDays,
      allowedChannels:
        settings.recall.defaultAllowedChannels.length > 0
          ? settings.recall.defaultAllowedChannels
          : undefined,
    });

    // Inject results into session data values
    if (result.messages.length > 0) {
      session.data.values._omnichannel_recall = result;

      onTraceEvent?.({
        type: 'omnichannel_recall_complete',
        data: {
          messageCount: result.messages.length,
          matchedSessions: result.metadata.matchedSessions,
          truncated: result.metadata.truncated,
          payloadBytes: result.metadata.payloadBytes,
          agentName: session.agentName,
        },
      });
    } else {
      emitDecisionTrace(session, onTraceEvent, {
        type: 'omnichannel_recall_complete',
        data: {
          messageCount: 0,
          reason: 'no_messages_found',
          agentName: session.agentName,
        },
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('executeOmnichannelRecall failed', { error: message });
    onTraceEvent?.({
      type: 'memory_error',
      data: { operation: 'executeOmnichannelRecall', error: message },
    });
  }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Emit a decision trace event if verbosity is 'verbose' or 'debug'.
 * Decision traces are suppressed at 'standard' and 'minimal' verbosity.
 */
function emitDecisionTrace(
  session: RuntimeSession,
  onTraceEvent: TraceCallback | undefined,
  event: { type: string; data: Record<string, unknown> },
): void {
  if (!onTraceEvent) return;
  const verbosity = session.traceVerbosity ?? 'standard';
  if (verbosity !== 'verbose' && verbosity !== 'debug') return;
  onTraceEvent(event);
}

/**
 * Resolve the REMEMBER dedup depth cap for a session.
 *
 * Cached on the session after first resolution — project settings rarely
 * change within a session lifetime, and the DB lookup is on the hot path
 * for every turn that fires REMEMBER triggers.
 *
 * Resolution order:
 *   ProjectSettings.memory.dedupMaxDepth → DEFAULT_DEDUP_MAX_DEPTH
 */
async function resolveDedupDepthCap(session: RuntimeSession): Promise<number> {
  if (typeof session.resolvedDedupMaxDepth === 'number') {
    return session.resolvedDedupMaxDepth;
  }
  let raw: number | null | undefined;
  if (session.tenantId && session.projectId) {
    try {
      const { isDatabaseAvailable } = await import('../../db/index.js');
      if (isDatabaseAvailable()) {
        const { findProjectSettings } = await import('../../repos/project-settings-repo.js');
        const settings = (await findProjectSettings(session.projectId, session.tenantId)) as {
          memory?: { dedupMaxDepth?: number | null } | null;
        } | null;
        raw = settings?.memory?.dedupMaxDepth ?? undefined;
      }
    } catch (err) {
      log.warn('Failed to load ProjectSettings for dedup depth cap, using default', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const depthCap = raw != null ? clampDedupDepthCap(raw) : DEFAULT_DEDUP_MAX_DEPTH;
  session.resolvedDedupMaxDepth = depthCap;
  return depthCap;
}

/** Parse TTL string (e.g. "30d", "2h") to milliseconds */
function parseTtlToMs(ttl: string): number | undefined {
  const match = ttl.match(/^(\d+)(d|h|m|s)$/);
  if (!match) return undefined;
  const [, amount, unit] = match;
  const num = parseInt(amount, 10);
  switch (unit) {
    case 'd':
      return num * 24 * 60 * 60 * 1000;
    case 'h':
      return num * 60 * 60 * 1000;
    case 'm':
      return num * 60 * 1000;
    case 's':
      return num * 1000;
    default:
      return undefined;
  }
}
