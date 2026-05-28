import { describe, it, expect } from 'vitest';
import { executeFunctionStep, type FunctionStep } from '../executors/function-executor.js';
import type { WorkflowContextData } from '../context/expression-resolver.js';

function makeCtx(overrides?: Partial<WorkflowContextData>): WorkflowContextData {
  return {
    trigger: {
      type: 'studio',
      payload: { items: [1, 2, 3], name: 'test' },
    },
    workflow: { id: 'wf-1', name: 'test-flow', executionId: 'exec-1' },
    tenant: { tenantId: 't1', projectId: 'p1' },
    steps: {
      start: { input: { postId: 1 }, output: { postId: 1 }, status: 'completed' },
      step1: { output: { total: 42 }, status: 'completed' },
    },
    counter: 0,
    ...overrides,
  };
}

function makeStep(overrides?: Partial<FunctionStep['config']>): FunctionStep {
  return {
    id: 'fn-1',
    type: 'function',
    config: {
      code: 'context.result = "ok";',
      timeout: 5,
      ...overrides,
    },
  };
}

describe('function-executor', () => {
  describe('unit tests', () => {
    // UT-1: Basic execution — context write produces output
    it('UT-1: context write produces output', async () => {
      const step = makeStep({ code: 'context.value = 42;' });
      const result = await executeFunctionStep(step, makeCtx());
      expect(result.output).toEqual({ value: 42 });
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    // UT-2: Context injection — all fields accessible
    it('UT-2: all context fields accessible', async () => {
      const step = makeStep({
        code: `
          context.out = {
            triggerType: context.trigger.type,
            payload: context.trigger.payload,
            workflowId: context.workflow.id,
            tenantId: context.tenant.tenantId,
            stepOutput: context.steps.step1.output.total,
            startInput: context.steps.start.input.postId,
            counter: context.counter,
          };
        `,
      });
      const result = await executeFunctionStep(step, makeCtx());
      const out = (result.output as Record<string, unknown>).out;
      expect(out).toEqual({
        triggerType: 'studio',
        payload: { items: [1, 2, 3], name: 'test' },
        workflowId: 'wf-1',
        tenantId: 't1',
        stepOutput: 42,
        startInput: 1,
        counter: 0,
      });
    });

    // UT-3: Read-only sub-trees — mutations rejected
    it('UT-3: read-only sub-tree mutations are rejected', async () => {
      const step = makeStep({
        code: `
          try { context.trigger.payload.name = 'hacked'; } catch(e) {}
          context.name = context.trigger.payload.name;
        `,
      });
      const ctx = makeCtx();
      const result = await executeFunctionStep(step, ctx);
      // Frozen object rejects mutation (sloppy mode silently ignores)
      expect((result.output as Record<string, unknown>).name).toBe('test');
      expect(ctx.trigger.payload.name).toBe('test');
    });

    // UT-4: Structured data write
    it('UT-4: structured data write via context', async () => {
      const step = makeStep({
        code: `
          context.users = [{ name: "Alice", age: 30 }, { name: "Bob", age: 25 }];
          context.metadata = { total: 2, page: 1 };
        `,
      });
      const result = await executeFunctionStep(step, makeCtx());
      expect(result.output).toEqual({
        users: [
          { name: 'Alice', age: 30 },
          { name: 'Bob', age: 25 },
        ],
        metadata: { total: 2, page: 1 },
      });
    });

    // UT-5: Multiple writes — all captured
    it('UT-5: multiple context writes all captured', async () => {
      const step = makeStep({
        code: `
          context.a = 1;
          context.b = 2;
          context.a = 10;
        `,
      });
      const result = await executeFunctionStep(step, makeCtx());
      expect(result.output).toEqual({ a: 10, b: 2 });
    });

    // UT-6: Context writes surfaced on `result.output`.
    //
    // Post-ABLP-2 #7 replay-safety fix: the executor no longer mutates
    // `ctx` directly (that would not be journaled across a Restate
    // replay). The handler now re-applies `result.output` into the root context
    // once ctx.run resolves, so the contract under test here is the
    // returned shape — root context is pinned as a regression guard that the
    // executor has NOT written directly.
    it('UT-6: context writes surfaced on result.output, not written directly to ctx', async () => {
      const ctx = makeCtx();
      const step = makeStep({
        code: `
          context.x = 10;
          context.y = 20;
        `,
      });
      const result = await executeFunctionStep(step, ctx);
      expect(result.output).toEqual({ x: 10, y: 20 });
      // Replay-safety invariant: executor must NOT write ctx directly.
      expect(ctx.x).toBeUndefined();
      expect(ctx.y).toBeUndefined();
    });

    // UT-7: Console capture
    it('UT-7: console.log/warn/error captured with levels', async () => {
      const step = makeStep({
        code: `
          console.log("hello", 42);
          console.warn("warning!");
          console.error("oh no", { detail: true });
          context.done = true;
        `,
      });
      const result = await executeFunctionStep(step, makeCtx());
      expect(result.logs).toHaveLength(3);
      expect(result.logs[0]).toEqual({ level: 'log', args: ['hello', 42] });
      expect(result.logs[1]).toEqual({ level: 'warn', args: ['warning!'] });
      expect(result.logs[2]).toEqual({ level: 'error', args: ['oh no', { detail: true }] });
    });

    // UT-8: Timeout enforcement
    it('UT-8: while(true) terminated after timeout', async () => {
      const step = makeStep({
        code: 'while(true) {}',
        timeout: 1,
      });
      await expect(executeFunctionStep(step, makeCtx())).rejects.toThrow(/timed out/);
    }, 10000);

    // UT-9: Memory limit enforcement
    it('UT-9: OOM with large allocation', async () => {
      const step: FunctionStep = {
        id: 'fn-oom',
        type: 'function',
        config: {
          code: `
            const arr = [];
            while (true) { arr.push(new Array(1024 * 1024).fill("x")); }
          `,
          timeout: 10,
        },
      };
      await expect(executeFunctionStep(step, makeCtx())).rejects.toThrow(
        /memory limit|SCRIPT_ERROR/,
      );
    }, 15000);

    // UT-10: Output size limit
    it('UT-10: oversized context writes rejected', async () => {
      const step = makeStep({
        code: `context.big = "x".repeat(2 * 1024 * 1024);`,
      });
      await expect(executeFunctionStep(step, makeCtx())).rejects.toThrow(/exceed maximum size/);
    });

    // UT-11: Read data and transform
    it('UT-11: read trigger data and transform', async () => {
      const step = makeStep({
        code: `
          const items = context.trigger.payload.items;
          context.doubled = items.map(i => i * 2);
          context.count = items.length;
        `,
      });
      const result = await executeFunctionStep(step, makeCtx());
      expect(result.output).toEqual({ doubled: [2, 4, 6], count: 3 });
    });

    // UT-12: Overwriting read-only key throws
    it('UT-12: overwriting immutable key throws', async () => {
      const step = makeStep({
        code: `context.trigger = { hacked: true };`,
      });
      await expect(executeFunctionStep(step, makeCtx())).rejects.toThrow(
        /Cannot overwrite immutable context property/,
      );
    });

    it('UT-12b: workflow data is only available through context', async () => {
      const step = makeStep({
        code: `
          context.checks = {
            contextCounter: context.counter,
            bareVars: typeof vars,
            internalContextData: typeof _contextData,
            internalContextWrite: typeof _contextWrite,
            internalImmutableKeys: typeof _immutableKeys,
          };
        `,
      });
      const result = await executeFunctionStep(step, makeCtx());
      expect(result.output).toEqual({
        checks: {
          contextCounter: 0,
          bareVars: 'undefined',
          internalContextData: 'undefined',
          internalContextWrite: 'undefined',
          internalImmutableKeys: 'undefined',
        },
      });
    });

    it('UT-12c: declared vars is a writable root variable through context only', async () => {
      const step = makeStep({
        code: `
          context.vars.counter = 9;
        `,
      });
      const result = await executeFunctionStep(
        step,
        makeCtx({ vars: { counter: 0 } } as Partial<WorkflowContextData>),
      );
      expect(result.output).toEqual({ vars: { counter: 9 } });
    });

    it('UT-12d: cannot use bare vars directly', async () => {
      const step = makeStep({
        code: `vars.counter = 9;`,
      });
      await expect(executeFunctionStep(step, makeCtx())).rejects.toThrow(/vars is not defined/);
    });

    it('UT-12e: cannot write context.vars directly', async () => {
      const step = makeStep({
        code: `context.vars.counter = 9;`,
      });
      await expect(executeFunctionStep(step, makeCtx())).rejects.toThrow(
        /Cannot assign to read only property|object is not extensible|read only/,
      );
    });

    it('UT-12f: can write context.steps.start.input.* (only mutable sub-path in steps)', async () => {
      const step = makeStep({
        code: `context.steps.start.input.foo = 'bar'; context.result = context.steps.start.input.foo;`,
      });
      const ctx = makeCtx({
        steps: {
          start: { nodeType: 'start', stepId: 'start', status: 'completed', input: {} },
        },
      });
      const result = await executeFunctionStep(step, ctx);
      // Write is reflected immediately in context.steps.start.input
      expect((ctx.steps.start as Record<string, unknown>).input).toMatchObject({ foo: 'bar' });
      // And readable back within the same script
      expect((result.output as Record<string, unknown>).result).toBe('bar');
    });

    it('UT-12g: loop variables are immutable function context keys', async () => {
      const step = makeStep({
        code: `context.currentItem = 'changed';`,
      });
      await expect(
        executeFunctionStep(
          step,
          makeCtx({
            currentItem: 'original',
            currentItem_index: 0,
            currentItem_count: 2,
          }),
        ),
      ).rejects.toThrow(/Cannot overwrite immutable context property: currentItem/);
    });

    it('UT-12h: bare loop variable assignment is not allowed', async () => {
      const step = makeStep({
        code: `currentItem = 'changed';`,
      });
      await expect(
        executeFunctionStep(
          step,
          makeCtx({
            currentItem: 'original',
            currentItem_index: 0,
            currentItem_count: 2,
          }),
        ),
      ).rejects.toThrow(/currentItem is not defined/);
    });

    // UT-13: Syntax error
    it('UT-13: syntax error throws SCRIPT_ERROR', async () => {
      const step = makeStep({ code: 'const x = {;' });
      await expect(executeFunctionStep(step, makeCtx())).rejects.toThrow(/SyntaxError|Unexpected/);
    });

    // UT-14: Runtime error
    it('UT-14: runtime error throws SCRIPT_ERROR', async () => {
      const step = makeStep({ code: 'undefinedFunction();' });
      await expect(executeFunctionStep(step, makeCtx())).rejects.toThrow(
        /undefinedFunction is not defined/,
      );
    });

    // UT-15: No writes = undefined output
    it('UT-15: no writes produces undefined output', async () => {
      const step = makeStep({ code: 'const x = 1;' });
      const result = await executeFunctionStep(step, makeCtx());
      expect(result.output).toBeUndefined();
    });

    // UT-16: Script can read back its own writes
    it('UT-16: script can read back own writes via context', async () => {
      const step = makeStep({
        code: `
          context.x = 10;
          context.y = context.x * 2;
        `,
      });
      const result = await executeFunctionStep(step, makeCtx());
      expect(result.output).toEqual({ x: 10, y: 20 });
    });

    // UT-17: Empty code returns undefined
    it('UT-17: empty code returns undefined output', async () => {
      const step = makeStep({ code: '' });
      const result = await executeFunctionStep(step, makeCtx());
      expect(result.output).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // UT-4 (Phase 3) — agent projection + memory globals: present, frozen
  // ─────────────────────────────────────────────────────────────────
  describe('UT-4 — agent projections + memory globals', () => {
    it('agentSession is accessible as a frozen global with positive-list fields', async () => {
      const ctx = makeCtx({
        agentSession: Object.freeze({
          sessionId: 'sess-1',
          agentName: 'sales-agent',
          channel: 'web',
          source: 'public',
          endUserId: 'user-42',
          locale: 'en-US',
          startedAt: '2026-04-27T12:00:00Z',
          lastActivityAt: '2026-04-27T12:05:00Z',
        }),
      });
      const step = makeStep({
        code: `
          context.snapshot = {
            channel: context.agentSession.channel,
            source: context.agentSession.source,
            endUserId: context.agentSession.endUserId,
            agentName: context.agentSession.agentName,
            isFrozen: Object.isFrozen(context.agentSession),
          };
        `,
      });
      const result = await executeFunctionStep(step, ctx);
      const snap = (result.output as Record<string, Record<string, unknown>>).snapshot;
      expect(snap.channel).toBe('web');
      expect(snap.source).toBe('public');
      expect(snap.endUserId).toBe('user-42');
      expect(snap.agentName).toBe('sales-agent');
      expect(snap.isFrozen).toBe(true);
    });

    it('mutating agentSession.channel does NOT change the value (deep-frozen)', async () => {
      const ctx = makeCtx({
        agentSession: Object.freeze({
          sessionId: 'sess-1',
          agentName: 'sales-agent',
          channel: 'web',
          source: 'public',
          endUserId: undefined,
          locale: undefined,
          startedAt: '2026-04-27T12:00:00Z',
          lastActivityAt: '2026-04-27T12:05:00Z',
        }),
      });
      const step = makeStep({
        code: `
          try { context.agentSession.channel = 'hacked'; } catch(e) {}
          context.after = context.agentSession.channel;
        `,
      });
      const result = await executeFunctionStep(step, ctx);
      expect((result.output as Record<string, unknown>).after).toBe('web');
    });

    it('mutating nested agentContext.attachments[0].name is rejected', async () => {
      const ctx = makeCtx({
        agentContext: Object.freeze({
          caller: Object.freeze({ type: 'agent', id: 'sales-agent' }),
          invocation: Object.freeze({
            tool: 'sendQuote',
            args: Object.freeze({ amount: 100 }) as Record<string, unknown>,
          }),
          attachments: Object.freeze([
            Object.freeze({
              id: 'att-1',
              mimeType: 'application/pdf',
              sizeBytes: 1024,
              name: 'quote.pdf',
            }),
          ]) as ReadonlyArray<{
            readonly id: string;
            readonly mimeType: string;
            readonly sizeBytes: number;
            readonly name: string;
          }>,
          messageMetadata: undefined,
        }),
      });
      const step = makeStep({
        code: `
          try { context.agentContext.attachments[0].name = 'hacked'; } catch(e) {}
          context.afterName = context.agentContext.attachments[0].name;
        `,
      });
      const result = await executeFunctionStep(step, ctx);
      expect((result.output as Record<string, unknown>).afterName).toBe('quote.pdf');
    });

    it('overwriting top-level agentSession throws via the readonly-key Proxy guard', async () => {
      const ctx = makeCtx({
        agentSession: Object.freeze({
          sessionId: 'sess-1',
          agentName: 'sales-agent',
          channel: 'web',
          source: 'public',
          endUserId: undefined,
          locale: undefined,
          startedAt: '2026-04-27T12:00:00Z',
          lastActivityAt: '2026-04-27T12:05:00Z',
        }),
      });
      const step = makeStep({
        code: `context.agentSession = null;`,
      });
      await expect(executeFunctionStep(step, ctx)).rejects.toThrow(
        /Cannot overwrite read-only context property: agentSession/,
      );
    });

    it('overwriting top-level memory throws via the readonly-key Proxy guard', async () => {
      const step = makeStep({
        code: `context.memory = { workflow: { hacked: true } };`,
      });
      await expect(executeFunctionStep(step, makeCtx())).rejects.toThrow(
        /Cannot overwrite read-only context property: memory/,
      );
    });

    it('memory defaults to empty workflow/project scopes when no projection is set', async () => {
      // Agent-less webhook run — memory is undefined on ctx. Function-executor
      // defaults to `{ workflow: {}, project: {}, user: undefined }`.
      const step = makeStep({
        code: `
          context.snap = {
            workflowKeys: Object.keys(context.memory.workflow),
            projectKeys: Object.keys(context.memory.project),
            userIsUndefined: context.memory.user === undefined,
          };
        `,
      });
      const result = await executeFunctionStep(step, makeCtx());
      const snap = (result.output as Record<string, Record<string, unknown>>).snap;
      expect(snap.workflowKeys).toEqual([]);
      expect(snap.projectKeys).toEqual([]);
      expect(snap.userIsUndefined).toBe(true);
    });

    it('memory.workflow.<key> read returns the projected value', async () => {
      const ctx = makeCtx({
        memory: {
          workflow: { lastCursor: 'wf-cursor-7', counter: 42 },
          project: { theme: 'dark' },
          user: { preferredLanguage: 'en' },
        },
      });
      const step = makeStep({
        code: `
          context.snap = {
            cursor: context.memory.workflow.lastCursor,
            counter: context.memory.workflow.counter,
            theme: context.memory.project.theme,
            lang: context.memory.user.preferredLanguage,
          };
        `,
      });
      const result = await executeFunctionStep(step, ctx);
      const snap = (result.output as Record<string, Record<string, unknown>>).snap;
      expect(snap.cursor).toBe('wf-cursor-7');
      expect(snap.counter).toBe(42);
      expect(snap.theme).toBe('dark');
      expect(snap.lang).toBe('en');
    });

    it('agent-less run — context.agentSession === undefined (no throw)', async () => {
      const step = makeStep({
        code: `
          context.snap = {
            hasSession: typeof context.agentSession,
            hasContext: typeof context.agentContext,
          };
        `,
      });
      const result = await executeFunctionStep(step, makeCtx());
      const snap = (result.output as Record<string, Record<string, unknown>>).snap;
      // The isolate sees no agentSession/agentContext key on contextData when
      // the host omits them. Both reads return `undefined` cleanly.
      expect(snap.hasSession).toBe('undefined');
      expect(snap.hasContext).toBe('undefined');
    });
  });

  // UT-6 — memory.workflow/.project/.user.get/set/delete globals.
  //
  // Phase 4 layers writable memory ops on top of the read-side projection.
  // Inside the V8 isolate, `memory.workflow.get('foo')` calls a host
  // `RuntimeMemoryClient` via `ivm.Reference.applySyncPromise`. These tests
  // verify the global SHAPE — that the injected functions exist, that
  // overwrites are still rejected by the readonly-key guard, and that an
  // in-isolate `set` followed by `get` returns the just-set value (in-run
  // projection update — FR-14).
  //
  // The integration test (`workflow-memory-isolate.integration.test.ts`) covers
  // INT-3 (round-trip via the real route) and INT-12 (retry idempotency).
  describe('UT-6 — memory globals (write-side)', () => {
    it('memory.workflow.get/set/delete are functions; overwrite still rejected', async () => {
      const captured: Record<string, unknown> = {};
      const memoryClient = {
        async loadProjection() {
          return { workflow: {}, project: {}, user: undefined };
        },
        async get() {
          return undefined;
        },
        async set(req: { scope: string; key: string; value: unknown }) {
          captured[`set:${req.scope}:${req.key}`] = req.value;
        },
        async delete(req: { scope: string; key: string }) {
          captured[`del:${req.scope}:${req.key}`] = true;
        },
      };
      const step = makeStep({
        code: `
          context.snap = {
            wfGet: typeof memory.workflow.get,
            wfSet: typeof memory.workflow.set,
            wfDel: typeof memory.workflow.delete,
            projGet: typeof memory.project.get,
            userGet: typeof memory.user.get,
          };
        `,
      });
      const result = await executeFunctionStep(step, makeCtx(), {
        memoryClient,
        runId: 'run-1',
        actor: { kind: 'workflow-author' },
      });
      const snap = (result.output as Record<string, Record<string, unknown>>).snap;
      expect(snap.wfGet).toBe('function');
      expect(snap.wfSet).toBe('function');
      expect(snap.wfDel).toBe('function');
      expect(snap.projGet).toBe('function');
      expect(snap.userGet).toBe('function');

      // Reassigning the top-level `memory` object still throws.
      const overwriteStep = makeStep({ code: `memory = null;` });
      await expect(
        executeFunctionStep(overwriteStep, makeCtx(), {
          memoryClient,
          runId: 'run-1',
          actor: { kind: 'workflow-author' },
        }),
      ).rejects.toThrow();
    });

    it('set→get round-trip within a run reads the just-written value (FR-14)', async () => {
      const store = new Map<string, unknown>();
      const memoryClient = {
        async loadProjection() {
          return { workflow: {}, project: {}, user: undefined };
        },
        async get(req: { scope: string; key: string }) {
          return store.get(`${req.scope}:${req.key}`);
        },
        async set(req: { scope: string; key: string; value: unknown }) {
          store.set(`${req.scope}:${req.key}`, req.value);
        },
        async delete(req: { scope: string; key: string }) {
          store.delete(`${req.scope}:${req.key}`);
        },
      };
      const step = makeStep({
        code: `
          memory.workflow.set('counter', 7);
          context.echoed = memory.workflow.get('counter');
        `,
      });
      const result = await executeFunctionStep(step, makeCtx(), {
        memoryClient,
        runId: 'run-1',
        actor: { kind: 'workflow-author' },
      });
      expect((result.output as Record<string, unknown>).echoed).toBe(7);
    });

    it('throws STORAGE_UNAVAILABLE when no memoryClient is wired (signals wiring miss)', async () => {
      // Per LLD §Phase 4: when the optional `deps` is absent or omits
      // `memoryClient`, memory globals still EXIST but every op throws
      // STORAGE_UNAVAILABLE. Authors get a clear signal — not silent success.
      const step = makeStep({
        code: `
          try { memory.workflow.set('x', 1); context.fail = 'NO_THROW'; }
          catch (e) { context.captured = String(e && e.message || e); }
        `,
      });
      const result = await executeFunctionStep(step, makeCtx());
      const out = result.output as Record<string, unknown>;
      expect(out.fail).toBeUndefined();
      expect(out.captured).toMatch(/STORAGE_UNAVAILABLE|memoryClient|not configured/i);
    });

    it('host errors propagate as throws inside the isolate', async () => {
      const memoryClient = {
        async loadProjection() {
          return { workflow: {}, project: {}, user: undefined };
        },
        async get() {
          throw new Error('runtime down');
        },
        async set() {
          /* unused */
        },
        async delete() {
          /* unused */
        },
      };
      const step = makeStep({
        code: `
          try { memory.workflow.get('foo'); context.fail = 'NO_THROW'; }
          catch (e) { context.captured = String(e && e.message || e); }
        `,
      });
      const result = await executeFunctionStep(step, makeCtx(), {
        memoryClient,
        runId: 'run-1',
        actor: { kind: 'workflow-author' },
      });
      const out = result.output as Record<string, unknown>;
      expect(out.fail).toBeUndefined();
      expect(out.captured).toContain('runtime down');
    });
  });

  describe('integration tests', () => {
    // INT-2: Sandbox isolation
    it('INT-2: Node.js globals are not accessible', async () => {
      const step = makeStep({
        code: `
          context.checks = {
            hasProcess: typeof process !== 'undefined',
            hasRequire: typeof require !== 'undefined',
            hasSetTimeout: typeof setTimeout !== 'undefined',
            hasBuffer: typeof Buffer !== 'undefined',
          };
        `,
      });
      const result = await executeFunctionStep(step, makeCtx());
      const checks = (result.output as Record<string, Record<string, boolean>>).checks;
      expect(checks.hasProcess).toBe(false);
      expect(checks.hasRequire).toBe(false);
      expect(checks.hasSetTimeout).toBe(false);
      expect(checks.hasBuffer).toBe(false);
    });

    // INT-3: Failed scripts leave root context clean.
    //
    // Under the pre-ABLP-2-#7 contract this was an "atomic rollback" — the
    // executor wrote ctx eagerly then rolled back on failure. Under the
    // post-fix contract the invariant is stronger: the executor never writes
    // ctx at all, and failed scripts never produce a `result.output`
    // either, so the handler's re-apply is a no-op on error.
    it('INT-3: failed script leaves root context untouched', async () => {
      const ctx = makeCtx();
      const step = makeStep({
        code: `
          context.shouldDiscard = "yes";
          throw new Error("intentional failure");
        `,
      });
      await expect(executeFunctionStep(step, ctx)).rejects.toThrow('intentional failure');
      expect(ctx.shouldDiscard).toBeUndefined();
    });

    // INT-4: Frozen context sub-trees
    it('INT-4: deep context properties are frozen', async () => {
      const step = makeStep({
        code: `
          const original = context.trigger.payload.items;
          try { context.trigger.payload.items = [999]; } catch(e) {}
          context.items = context.trigger.payload.items;
          context.same = (context.trigger.payload.items === original);
        `,
      });
      const result = await executeFunctionStep(step, makeCtx());
      const output = result.output as Record<string, unknown>;
      expect(output.items).toEqual([1, 2, 3]);
      expect(output.same).toBe(true);
    });

    // INT-7: Concurrent cross-tenant isolation
    it('INT-7: concurrent executions are isolated', async () => {
      const ctx1 = makeCtx({ tenant: { tenantId: 'tenant-A', projectId: 'proj-A' } });
      const ctx2 = makeCtx({ tenant: { tenantId: 'tenant-B', projectId: 'proj-B' } });

      const step1 = makeStep({ code: `context.owner = context.tenant.tenantId;` });
      const step2 = makeStep({ code: `context.owner = context.tenant.tenantId;` });

      const [r1, r2] = await Promise.all([
        executeFunctionStep(step1, ctx1),
        executeFunctionStep(step2, ctx2),
      ]);

      // Isolation is visible on the returned outputs — ctx is untouched
      // by the executor (handler is responsible for re-applying per-run).
      expect((r1.output as Record<string, unknown>).owner).toBe('tenant-A');
      expect((r2.output as Record<string, unknown>).owner).toBe('tenant-B');
      expect(ctx1.owner).toBeUndefined();
      expect(ctx2.owner).toBeUndefined();
    });
  });
});
