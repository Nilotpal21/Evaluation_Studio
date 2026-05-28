/**
 * Function Step Executor
 *
 * Runs user-written JavaScript in an isolated-vm V8 sandbox with a mutable
 * `context` object. Users read upstream data via `context.trigger`, `context.steps`,
 * etc. and write results via `context.x = "ABC"`. User-written properties are
 * captured and applied to the root workflow context after successful execution.
 *
 * Console capture, resource limits (memory, timeout, output size), and atomic
 * rollback on failure are preserved from the original design.
 */

import ivm from 'isolated-vm';
import { createLogger } from '@abl/compiler/platform';
import { FUNCTION_CONTEXT_READONLY_TOP_LEVEL_KEYS } from '@agent-platform/shared-kernel/types';
import { type MemoryProjection } from '../context/expression-resolver.js';
import {
  getContextVariables,
  getFunctionContextImmutableKeys,
  type WorkflowContextData,
} from '../context/step-context-schema.js';
import { WorkflowStepError, StepErrorCode } from '../errors/step-errors.js';
import {
  FUNCTION_NODE_MEMORY_MB,
  FUNCTION_NODE_MAX_OUTPUT_BYTES,
  FUNCTION_NODE_MAX_LOGS,
} from '../constants.js';

/**
 * Surface required by the function-node memory globals. Implemented by
 * `RuntimeMemoryClient` in production. Tests inject in-process fakes that
 * implement the same shape — no `vi.mock` of the real client.
 *
 * Method semantics mirror the runtime route:
 *  - `get` returns the value (or `undefined` when not found / tombstoned)
 *  - `set` is fire-and-forget from the caller's POV
 *  - `delete` writes a tombstone
 *  - `loadProjection` is the read-side; only used by `loadMemoryProjection`
 *    in `workflow-handler.ts` — included here so the same client object can
 *    be threaded end-to-end.
 */
export interface FunctionMemoryClient {
  loadProjection?(req: {
    tenantId: string;
    projectId: string;
    workflowId: string;
    endUserId?: string;
  }): Promise<MemoryProjection>;
  get(req: {
    tenantId: string;
    projectId: string;
    workflowId: string;
    runId: string;
    actor: { kind: 'workflow-author' | 'end-user'; endUserId?: string };
    scope: 'workflow' | 'project' | 'user';
    key: string;
    endUserId?: string;
  }): Promise<unknown>;
  set(req: {
    tenantId: string;
    projectId: string;
    workflowId: string;
    runId: string;
    actor: { kind: 'workflow-author' | 'end-user'; endUserId?: string };
    scope: 'workflow' | 'project' | 'user';
    key: string;
    endUserId?: string;
    value: unknown;
    ttl?: string;
  }): Promise<void>;
  delete(req: {
    tenantId: string;
    projectId: string;
    workflowId: string;
    runId: string;
    actor: { kind: 'workflow-author' | 'end-user'; endUserId?: string };
    scope: 'workflow' | 'project' | 'user';
    key: string;
    endUserId?: string;
  }): Promise<void>;
}

/**
 * Optional dependencies threaded into a function-node execution. When
 * `memoryClient` is omitted, the `memory.*` globals still exist (so author
 * code can be syntactically valid) but every op throws `STORAGE_UNAVAILABLE`.
 * That signals a wiring miss instead of silently succeeding.
 *
 * `runId` and `actor` are per-run identity — the host attaches them to every
 * outbound memory op so the runtime can audit + enforce per-run quotas.
 */
export interface FunctionExecutorDeps {
  memoryClient?: FunctionMemoryClient;
  runId?: string;
  actor?: { kind: 'workflow-author' | 'end-user'; endUserId?: string };
}

const log = createLogger('workflow-engine:function-executor');

export interface FunctionStep {
  id: string;
  type: 'function';
  config: {
    code: string;
    timeout?: number;
  };
}

export interface FunctionResult {
  output: unknown;
  logs: Array<{ level: 'log' | 'warn' | 'error'; args: unknown[] }>;
  durationMs: number;
}

/**
 * Extract line/column from a V8 error stack trace.
 */
function extractLineColumn(err: Error): { line?: number; column?: number } {
  const stack = err.stack ?? '';
  const match = /:(\d+):(\d+)/.exec(stack);
  if (match) {
    return { line: parseInt(match[1], 10), column: parseInt(match[2], 10) };
  }
  return {};
}

/**
 * Execute a function step in an isolated V8 sandbox.
 *
 * The script receives a `context` global with read-only sub-trees (trigger, steps,
 * workflow, tenant, vars) and allows direct property writes (context.x = "ABC")
 * which are captured and applied to the root workflow context after success.
 * Workflow data is exposed only through `context`. If `vars` is a declared
 * root variable, it behaves like any other user variable through `context.vars`.
 *
 * D-9 prototype findings (recorded for future reference):
 *  (a) `applySyncPromise` blocks the isolate's worker thread until the host
 *      promise resolves — observed in `scratch/applysync-prototype.ts`.
 *  (b) Host throws propagate as throwable JS errors at the script call site.
 *  (c) `script.run({ timeout })` does NOT cancel a script that's blocked
 *      inside `applySyncPromise` — so the per-op timeout MUST live in the
 *      HTTP client's `AbortSignal` (see `MEMORY_OP_TIMEOUT_MS`).
 *  (d) `applySyncPromise` may only be invoked from a NON-DEFAULT thread.
 *      `script.runSync(ctx)` runs on the calling (main) thread → throws
 *      "may not be called from the default thread". MUST use
 *      `await script.run(ctx)` so the script runs on a worker thread.
 *
 * Decision: switched from `script.runSync` to `await script.run` for ALL
 * function-node executions. The change is transparent to existing tests
 * (this function was already async); the script-side timeout option works
 * the same on both. The win is that memory ops can call out to the host.
 *
 * Head-of-line blocking caveat (tracked as GAP-021 in the feature spec):
 *   `applySyncPromise` parks an isolate worker thread for the duration
 *   of the host fetch. Worst case per run: `MAX_WRITES_PER_RUN` (100) ×
 *   `MEMORY_OP_TIMEOUT_MS` (5 s) = ~500 s of worker-thread occupancy if
 *   every call hits the full timeout. The libuv pool is bumped to 8 in
 *   the workflow-engine Dockerfile (`UV_THREADPOOL_SIZE=8`), so under
 *   pathological multi-tenant load a small set of bad-actor tenants
 *   could starve other workflows of worker threads. Mitigations in
 *   v1.1: per-tenant isolate-thread budget (HLD D-9), per-run circuit
 *   breaker on consecutive timeouts, or moving memory ops off the
 *   blocking path entirely (queue + ack pattern). Not a v1 blocker —
 *   the 5 s op timeout means the worst case is bounded and observable.
 */
export async function executeFunctionStep(
  step: FunctionStep,
  ctx: WorkflowContextData,
  deps?: FunctionExecutorDeps,
): Promise<FunctionResult> {
  const startTime = Date.now();
  const timeoutMs = (step.config.timeout ?? 10) * 1000;

  // D-5: Backward compat guard — delegate to transform for legacy function nodes
  if (!step.config.code && (step.config as Record<string, unknown>).inputExpression) {
    throw new WorkflowStepError(
      StepErrorCode.SCRIPT_ERROR,
      'Function node has legacy transform config (inputExpression). Please use a transform node instead.',
    );
  }

  if (!step.config.code) {
    return {
      output: undefined,
      logs: [],
      durationMs: Date.now() - startTime,
    };
  }

  const isolate = new ivm.Isolate({ memoryLimit: FUNCTION_NODE_MEMORY_MB });

  try {
    const isoContext = isolate.createContextSync();
    const jail = isoContext.global;

    // Set up global reference
    jail.setSync('global', jail.derefInto());

    // --- Host-side write buffer for context property writes ---
    const writeBuffer: Record<string, unknown> = {};

    // --- Console capture ---
    const consoleLogs: Array<{ level: 'log' | 'warn' | 'error'; args: unknown[] }> = [];

    const captureConsole = (level: 'log' | 'warn' | 'error') => {
      return new ivm.Callback((...args: unknown[]) => {
        if (consoleLogs.length < FUNCTION_NODE_MAX_LOGS) {
          consoleLogs.push({ level, args });
        }
      });
    };

    jail.setSync('_console_log', captureConsole('log'));
    jail.setSync('_console_warn', captureConsole('warn'));
    jail.setSync('_console_error', captureConsole('error'));

    // --- Callback for context property writes (called from Proxy set trap) ---
    jail.setSync(
      '_contextWrite',
      new ivm.Callback((key: unknown, value: unknown) => {
        if (typeof key !== 'string') return;
        writeBuffer[key] = value;
      }),
    );

    // --- Callback for steps.start.input writes ---
    // Directly mutates ctx.steps.start.input so the live context reflects the write.
    // steps.start.input.* is the only sub-path of steps that function nodes may write.
    jail.setSync(
      '_startInputWrite',
      new ivm.Callback((key: unknown, value: unknown) => {
        if (typeof key !== 'string') return;
        const startStep = (ctx.steps as Record<string, unknown>)?.start as
          | Record<string, unknown>
          | undefined;
        if (!startStep) return;
        if (!startStep.input || typeof startStep.input !== 'object') {
          startStep.input = {};
        }
        (startStep.input as Record<string, unknown>)[key] = value;
      }),
    );
    jail.setSync(
      '_startInputDelete',
      new ivm.Callback((key: unknown) => {
        if (typeof key !== 'string') return;
        const startStep = (ctx.steps as Record<string, unknown>)?.start as
          | Record<string, unknown>
          | undefined;
        if (!startStep?.input || typeof startStep.input !== 'object') return;
        delete (startStep.input as Record<string, unknown>)[key];
      }),
    );

    // --- Memory ops via applySyncPromise (Phase 4) ---
    //
    // Three host async references back the in-isolate `memory.<scope>.{get,set,delete}`
    // globals. The script calls them via `applySyncPromise(...)` which blocks
    // the worker thread until the host promise resolves. The host:
    //   1. Calls the runtime memory client (which signs a fresh JWT and POSTs).
    //   2. Mutates `ctx.memory` for set/delete so subsequent reads in the
    //      SAME run see the new value (in-run projection update — FR-14).
    //
    // When `deps.memoryClient` is missing the host throws STORAGE_UNAVAILABLE.
    // That propagates up through the bootstrap script as a real Error so author
    // code can catch it with try/catch.
    const memoryClient = deps?.memoryClient;
    const runId = deps?.runId;
    const actor = deps?.actor;
    const tenantId = ctx.tenant.tenantId;
    const projectId = ctx.tenant.projectId;
    const workflowId = ctx.workflow.id;

    // Make sure ctx.memory is a real object so the in-run mutations from
    // set/delete can write back. The handler defaults this to empty scopes.
    if (!ctx.memory) {
      ctx.memory = { workflow: {}, project: {}, user: undefined };
    }
    const liveMemory = ctx.memory as MemoryProjection;

    /**
     * Narrowing version of `ensureWired` — returns the deps as non-nullable
     * locals so call sites can avoid `!` assertions on the closure variables.
     * Throws `STORAGE_UNAVAILABLE: ...` when any required dep is missing.
     */
    function requireWired(): {
      memoryClient: NonNullable<typeof memoryClient>;
      runId: string;
      actor: NonNullable<typeof actor>;
    } {
      if (!memoryClient) {
        throw new Error('STORAGE_UNAVAILABLE: memoryClient not configured for this execution');
      }
      if (!runId || !actor) {
        throw new Error('STORAGE_UNAVAILABLE: runId/actor missing — cannot perform memory op');
      }
      return { memoryClient, runId, actor };
    }

    function memoryScope(scope: 'workflow' | 'project' | 'user'): Record<string, unknown> {
      if (scope === 'user') {
        if (!liveMemory.user) liveMemory.user = {};
        return liveMemory.user;
      }
      return liveMemory[scope];
    }

    // ─── Transferability constraints ─────────────────────────────────
    // `applySyncPromise` arguments and return values must be PRIMITIVES
    // (string/number/boolean/null/undefined) or `ivm.ExternalCopy`/`Reference`
    // wrappers — plain objects/arrays from inside the isolate are NOT
    // transferable. We serialize values to JSON across the boundary in BOTH
    // directions (script → host: encode in bootstrap; host → script: encode
    // in the host fn). The wrapper script JSON.parses on the way back.
    //
    // Errors: Error instances also can't cross the boundary. We rethrow as
    // plain Errors with `<CODE>: <message>` so authors can branch on code:
    //     try { memory.workflow.set('wf:x', 1); }
    //     catch (e) { if (e.message.startsWith('RESERVED_PREFIX:')) ... }

    function rethrowAsPlain(err: unknown): never {
      if (err instanceof Error) {
        const code = (err as Error & { code?: string }).code ?? err.name ?? 'INTERNAL';
        throw new Error(`${code}: ${err.message}`);
      }
      throw new Error(`INTERNAL: ${String(err)}`);
    }

    const memoryGet = new ivm.Reference(
      async (scope: unknown, key: unknown): Promise<string | undefined> => {
        try {
          const wired = requireWired();
          if (typeof scope !== 'string' || typeof key !== 'string') {
            throw new Error('memory.get: scope and key must be strings');
          }
          if (scope !== 'workflow' && scope !== 'project' && scope !== 'user') {
            throw new Error(`memory.get: invalid scope '${scope}'`);
          }
          const value = await wired.memoryClient.get({
            tenantId,
            projectId,
            workflowId,
            runId: wired.runId,
            actor: wired.actor,
            scope,
            key,
            ...(wired.actor.endUserId ? { endUserId: wired.actor.endUserId } : {}),
          });
          if (value === undefined) return undefined;
          // Serialize on the way back across the isolate boundary. The
          // bootstrap script JSON.parses to restore type fidelity.
          return JSON.stringify(value);
        } catch (err) {
          rethrowAsPlain(err);
        }
      },
    );

    const memorySet = new ivm.Reference(
      async (scope: unknown, key: unknown, valueJson: unknown, ttl: unknown): Promise<void> => {
        try {
          const wired = requireWired();
          if (typeof scope !== 'string' || typeof key !== 'string') {
            throw new Error('memory.set: scope and key must be strings');
          }
          if (scope !== 'workflow' && scope !== 'project' && scope !== 'user') {
            throw new Error(`memory.set: invalid scope '${scope}'`);
          }
          if (typeof valueJson !== 'string') {
            throw new Error(
              'memory.set: value must be JSON-serializable (string crossed isolate boundary)',
            );
          }
          let value: unknown;
          try {
            value = JSON.parse(valueJson);
          } catch (parseErr) {
            throw new Error(
              `INVALID_VALUE: failed to parse JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
            );
          }
          const ttlString =
            ttl === undefined || ttl === null
              ? undefined
              : typeof ttl === 'string'
                ? ttl
                : String(ttl);
          await wired.memoryClient.set({
            tenantId,
            projectId,
            workflowId,
            runId: wired.runId,
            actor: wired.actor,
            scope,
            key,
            ...(wired.actor.endUserId ? { endUserId: wired.actor.endUserId } : {}),
            value,
            ...(ttlString ? { ttl: ttlString } : {}),
          });
          // FR-14 in-run projection update — writes are visible to subsequent
          // expressions and function nodes in the same run. We mutate the host
          // `ctx.memory` reference; the isolate-side `memory.<scope>` snapshot
          // is still the old projection but reads go through `.get()` which
          // hits the host and now sees the updated value.
          memoryScope(scope)[key] = value;
        } catch (err) {
          rethrowAsPlain(err);
        }
      },
    );

    const memoryDelete = new ivm.Reference(async (scope: unknown, key: unknown): Promise<void> => {
      try {
        const wired = requireWired();
        if (typeof scope !== 'string' || typeof key !== 'string') {
          throw new Error('memory.delete: scope and key must be strings');
        }
        if (scope !== 'workflow' && scope !== 'project' && scope !== 'user') {
          throw new Error(`memory.delete: invalid scope '${scope}'`);
        }
        await wired.memoryClient.delete({
          tenantId,
          projectId,
          workflowId,
          runId: wired.runId,
          actor: wired.actor,
          scope,
          key,
          ...(wired.actor.endUserId ? { endUserId: wired.actor.endUserId } : {}),
        });
        delete memoryScope(scope)[key];
      } catch (err) {
        rethrowAsPlain(err);
      }
    });

    jail.setSync('_memoryGet', memoryGet);
    jail.setSync('_memorySet', memorySet);
    jail.setSync('_memoryDelete', memoryDelete);

    // --- Inject workflow context data ---
    // Phase 3 read-side: agentSession, agentContext, memory are explicitly
    // copied into the isolate as plain JSON. The host-side projections are
    // already deep-frozen by the materializer — but `ivm.ExternalCopy` clones
    // into the isolate, so the in-isolate copy is a fresh (mutable) object.
    // The wrapper script re-deep-freezes them below so user code sees a
    // frozen view in strict mode.
    const contextVariables = getContextVariables(ctx);
    const hasDeclaredVars = Object.prototype.hasOwnProperty.call(contextVariables, 'vars');
    const contextData = {
      ...contextVariables,
      ...(hasDeclaredVars ? {} : { vars: contextVariables }),
      trigger: ctx.trigger,
      workflow: ctx.workflow,
      tenant: ctx.tenant,
      steps: ctx.steps,
      // Optional fields — `ivm.ExternalCopy` handles `undefined` by omitting.
      // We assign explicitly with conditional spread so unset projections
      // don't materialize as `null` keys in the isolate.
      ...(ctx.agentSession ? { agentSession: ctx.agentSession } : {}),
      ...(ctx.agentContext ? { agentContext: ctx.agentContext } : {}),
      ...(ctx.memory
        ? { memory: ctx.memory }
        : { memory: { workflow: {}, project: {}, user: undefined } }),
    };
    jail.setSync('_contextData', new ivm.ExternalCopy(contextData).copyInto());
    jail.setSync('_hasDeclaredVars', hasDeclaredVars);

    // --- Inject immutable key set ---
    jail.setSync(
      '_immutableKeys',
      new ivm.ExternalCopy(getFunctionContextImmutableKeys(ctx)).copyInto(),
    );

    // --- Inject readonly top-level key set ---
    // Sourced from @agent-platform/shared-kernel so studio's Expression Browser
    // filter and this runtime guard cannot drift apart.
    jail.setSync(
      '_readonlyTopLevelKeys',
      new ivm.ExternalCopy([...FUNCTION_CONTEXT_READONLY_TOP_LEVEL_KEYS]).copyInto(),
    );

    // 'use strict' lives in the Function preamble (before the const memory binding)
    // so it is the first directive and actually activates strict mode.
    const userCode = JSON.stringify(
      `${step.config.code}\n//# sourceURL=function-node-${step.id}.js`,
    );

    // --- Build the wrapper script ---
    const wrapperCode = `
      'use strict';
      const __contextWrite = _contextWrite;
      const __consoleLog = _console_log;
      const __consoleWarn = _console_warn;
      const __consoleError = _console_error;
      const __baseData = _contextData;
      const __hasDeclaredVars = _hasDeclaredVars;
      const __immutableKeys = new Set(_immutableKeys);
      const __readonlyTopLevelKeys = new Set(_readonlyTopLevelKeys);
      const __startInputWrite = _startInputWrite;
      const __startInputDelete = _startInputDelete;

      delete globalThis._contextWrite;
      delete globalThis._console_log;
      delete globalThis._console_warn;
      delete globalThis._console_error;
      delete globalThis._contextData;
      delete globalThis._hasDeclaredVars;
      delete globalThis._immutableKeys;
      delete globalThis._readonlyTopLevelKeys;
      delete globalThis._startInputWrite;
      delete globalThis._startInputDelete;

      function __deepFreeze(obj) {
        if (obj === null || typeof obj !== 'object') return obj;
        Object.freeze(obj);
        for (const v of Object.values(obj)) {
          if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) __deepFreeze(v);
        }
        return obj;
      }

      function __clone(value) {
        if (value === undefined) return undefined;
        return JSON.parse(JSON.stringify(value));
      }

      const __userWrites = {};

      function __makeRootVariableProxy(rootKey, value) {
        if (value === null || typeof value !== 'object') return value;
        return new Proxy(value, {
          get(obj, prop) {
            return obj[prop];
          },
          set(obj, prop, nextValue) {
            if (typeof prop !== 'string') return false;
            obj[prop] = nextValue;
            __userWrites[rootKey] = obj;
            __contextWrite(rootKey, obj);
            return true;
          },
          deleteProperty(obj, prop) {
            if (typeof prop !== 'string') return false;
            delete obj[prop];
            __userWrites[rootKey] = obj;
            __contextWrite(rootKey, obj);
            return true;
          }
        });
      }

      const console = {
        log: (...args) => __consoleLog(...args),
        warn: (...args) => __consoleWarn(...args),
        error: (...args) => __consoleError(...args),
      };

      // Deep-freeze the read-only sub-trees
      __deepFreeze(__baseData.trigger);
      __deepFreeze(__baseData.workflow);
      __deepFreeze(__baseData.tenant);
      // Phase 3 read-side: deep-freeze agent projections + memory snapshot.
      // The host-side materializer has already frozen these, but ExternalCopy
      // clones into the isolate so we re-freeze here. These are guaranteed
      // present (memory is defaulted; agentSession/agentContext may be absent).
      if (__baseData.agentSession) __deepFreeze(__baseData.agentSession);
      if (__baseData.agentContext) __deepFreeze(__baseData.agentContext);
      __deepFreeze(__baseData.memory);

      if (!__hasDeclaredVars) __deepFreeze(__baseData.vars);

      // Build steps proxy: steps.start.input.* is the only writable sub-path.
      // Non-start steps are deep-frozen. The start step is left unfrozen because
      // __startStepProxy's set trap blocks all non-input writes explicitly.
      const __stepsData = __clone(__baseData.steps) || {};
      for (const [k, v] of Object.entries(__stepsData)) {
        if (k !== 'start') {
          __deepFreeze(v);
        }
        // start step: NOT frozen — proxy set trap enforces immutability instead
      }

      // Tracks in-isolate writes to start.input so reads reflect them immediately.
      const __startInputWrites = {};

      const __startInputProxy = __stepsData.start
        ? new Proxy(__stepsData.start.input || {}, {
            get(target, prop) {
              if (typeof prop === 'string' && prop in __startInputWrites) return __startInputWrites[prop];
              return target[prop];
            },
            set(target, prop, value) {
              if (typeof prop !== 'string') return false;
              __startInputWrites[prop] = value;
              __startInputWrite(prop, value);
              return true;
            },
            deleteProperty(target, prop) {
              if (typeof prop !== 'string') return false;
              delete __startInputWrites[prop];
              __startInputDelete(prop);
              return true;
            },
          })
        : undefined;

      const __startStepProxy = __stepsData.start
        ? new Proxy(__stepsData.start, {
            get(target, prop) {
              if (prop === 'input') return __startInputProxy;
              return target[prop];
            },
            set() { throw new Error('Cannot overwrite immutable context property: steps'); },
            deleteProperty() { throw new Error('Cannot delete immutable context property: steps'); },
          })
        : undefined;

      const __stepsProxy = new Proxy(__stepsData, {
        get(target, prop) {
          if (prop === 'start' && __startStepProxy) return __startStepProxy;
          return target[prop];
        },
        set() {
          throw new Error('Cannot overwrite immutable context property: steps');
        },
        deleteProperty() {
          throw new Error('Cannot delete immutable context property: steps');
        }
      });

      // Read-only top-level keys: host-owned projections that user code must
      // not replace. Use a distinct error prefix so tests can distinguish them
      // from the structural immutable keys (trigger, steps, etc.).
      // The list is sourced from @agent-platform/shared-kernel via the
      // _readonlyTopLevelKeys global (set above) so studio's Expression
      // Browser filter and this guard cannot drift.

      // Create a Proxy that intercepts reads/writes to context
      // - Immutable keys (trigger, steps, workflow, tenant, vars, loop vars) are read-only
      // - Read-only projection keys (agentSession, agentContext, memory) are also read-only
      // - Any other key (context.x = "ABC") is captured via _contextWrite callback
      //   and also stored on a local object so the script can read it back
      const context = new Proxy(__baseData, {
        get(target, prop) {
          if (prop === 'steps') return __stepsProxy;
          if (typeof prop === 'string' && prop in __userWrites) {
            return __userWrites[prop];
          }
          return __makeRootVariableProxy(prop, target[prop]);
        },
        set(target, prop, value) {
          if (typeof prop !== 'string') return false;
          if (__immutableKeys.has(prop)) {
            throw new Error('Cannot overwrite immutable context property: ' + prop);
          }
          if (__readonlyTopLevelKeys.has(prop)) {
            throw new Error('Cannot overwrite read-only context property: ' + prop);
          }
          __userWrites[prop] = value;
          __contextWrite(prop, value);
          return true;
        },
        deleteProperty(target, prop) {
          if (typeof prop === 'string' && __immutableKeys.has(prop)) {
            throw new Error('Cannot delete immutable context property: ' + prop);
          }
          if (typeof prop === 'string' && __readonlyTopLevelKeys.has(prop)) {
            throw new Error('Cannot delete read-only context property: ' + prop);
          }
          delete __userWrites[prop];
          return true;
        }
      });

      // ─── Memory globals (Phase 4 write-side) ────────────────────────
      //
      // memory.workflow.get/set/delete (and .project.*, .user.*) call
      // the host via applySyncPromise. The host returns a Promise; the
      // isolate worker thread blocks until it resolves. Errors propagate as
      // throws — author code can wrap in try/catch.
      //
      // The literal memory global is constructed here every run; it is NOT
      // a frozen snapshot of __baseData.memory. Reads via .get() always go
      // to the host, so values written in this run are visible to subsequent
      // gets — the host also keeps the static projection in sync.
      const memory = (function () {
        // applySyncPromise can only carry primitives across the boundary —
        // we serialize values to JSON in both directions for type fidelity.
        function makeScope(scopeName) {
          return Object.freeze({
            get: function (key) {
              const json = _memoryGet.applySyncPromise(undefined, [scopeName, key]);
              if (json === undefined || json === null) return undefined;
              try { return JSON.parse(json); } catch (e) { return undefined; }
            },
            set: function (key, value, opts) {
              const ttl = opts && typeof opts === 'object' ? opts.ttl : undefined;
              const json = JSON.stringify(value);
              if (typeof json !== 'string') {
                throw new Error('INVALID_VALUE: value is not JSON-serializable');
              }
              _memorySet.applySyncPromise(undefined, [scopeName, key, json, ttl]);
            },
            delete: function (key) {
              _memoryDelete.applySyncPromise(undefined, [scopeName, key]);
            },
          });
        }
        return Object.freeze({
          workflow: makeScope('workflow'),
          project: makeScope('project'),
          user: makeScope('user'),
        });
      })();

      // 'use strict' must be the first directive in the function body.
      // 'memory' is exposed as a const so user code cannot reassign it (memory = null throws).
      const __userFunction = Function('context', 'console', '_m', "'use strict';\\nconst memory = _m;\\n" + ${userCode});
      __userFunction(context, console, memory);

      // Capture final state of user writes (including in-place mutations like push)
      globalThis.__finalUserWrites = JSON.stringify(__userWrites);
    `;

    // --- Compile and run ---
    //
    // D-9 (d): switched from `script.runSync` → `await script.run`. The
    // change is mandatory because applySyncPromise (used by memory globals)
    // requires a non-default thread; runSync executes on the calling thread.
    // `script.run({ timeout })` enforces script CPU time the same way.
    const script = isolate.compileScriptSync(wrapperCode);
    await script.run(isoContext, { timeout: timeoutMs });

    // --- Read back the final user writes from the isolate ---
    // This captures mutations (push, splice, etc.) that the host-side
    // writeBuffer misses because only the initial set triggers the callback.
    const finalWritesJson = jail.getSync('__finalUserWrites', { copy: true }) as string | undefined;
    const finalWrites: Record<string, unknown> = finalWritesJson
      ? (JSON.parse(finalWritesJson) as Record<string, unknown>)
      : writeBuffer;

    // --- Validate output size ---
    const serialized = JSON.stringify(finalWrites);
    if (serialized && serialized.length > FUNCTION_NODE_MAX_OUTPUT_BYTES) {
      throw new WorkflowStepError(
        StepErrorCode.SCRIPT_ERROR,
        `Context writes exceed maximum size of ${FUNCTION_NODE_MAX_OUTPUT_BYTES} bytes`,
      );
    }

    // Step output = all user-written properties.
    //
    // Replay safety: we intentionally do NOT mutate `ctx` here. The
    // step runs inside `restateCtx.run()` in `dispatchWithRetry`, so any
    // direct context write would not be journaled — on replay Restate
    // returns the journaled return value but does not re-execute this
    // callback. `workflowStep` re-applies `result.output` into the root context
    // once ctx.run resolves (see workflow-handler.ts step-completion block),
    // which covers both first-run and replay paths with a single authoritative
    // write. Mutating here was the source of a double-write on first run and
    // silent drift if this shape ever diverged from the re-apply logic.
    const output = Object.keys(finalWrites).length > 0 ? { ...finalWrites } : undefined;

    log.debug('Function step executed', {
      stepId: step.id,
      durationMs: Date.now() - startTime,
      logCount: consoleLogs.length,
      hasOutput: output !== undefined,
      writeCount: Object.keys(writeBuffer).length,
    });

    return {
      output,
      logs: consoleLogs,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    // On error, discard all buffered writes (atomic rollback)
    const message = err instanceof Error ? err.message : String(err);

    // Check for timeout
    if (message.includes('Script execution timed out')) {
      throw new WorkflowStepError(
        StepErrorCode.SCRIPT_ERROR,
        `Function timed out after ${timeoutMs}ms`,
      );
    }

    // Check for memory limit (OOM can also dispose the isolate before we catch)
    if (
      message.includes('Array buffer allocation failed') ||
      message.includes('heap out of memory') ||
      message.includes('Isolate is already disposed') ||
      message.includes('disposed')
    ) {
      throw new WorkflowStepError(
        StepErrorCode.SCRIPT_ERROR,
        `Function exceeded memory limit of ${FUNCTION_NODE_MEMORY_MB}MB`,
      );
    }

    // Extract line/column for syntax and runtime errors
    const loc = err instanceof Error ? extractLineColumn(err) : {};
    const locSuffix = loc.line !== undefined ? ` at line ${loc.line}, column ${loc.column}` : '';

    throw new WorkflowStepError(StepErrorCode.SCRIPT_ERROR, `${message}${locSuffix}`);
  } finally {
    if (!isolate.isDisposed) {
      isolate.dispose();
    }
  }
}
