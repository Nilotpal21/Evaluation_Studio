/**
 * Buffered service facades — proxy factories that intercept mutator calls
 * and enqueue them as ProjectWrites into a TurnBuffer for atomic commit.
 *
 * Source of truth: docs/superpowers/specs/2026-04-18-arch-ai-engine-rewire-design.md §7a
 * Plan: docs/superpowers/plans/2026-04-18-arch-ai-engine-rewire-impl-plan.md Phase 1.4
 *
 * Design rationale:
 *   Tool code keeps calling `ctx.services.sessionService.updateSpecification(...)`
 *   exactly as before, but the write doesn't actually land in Mongo until
 *   `buffer.commit()` succeeds inside a transaction. Reader methods (get*, find*,
 *   list*, read*, count*, exists*) pass through to the real implementation.
 *
 * ─── LIMITATION: service-layer session passthrough ──────────────────────
 *
 * The collection proxy (`createBufferedArchSessionsCollection`) correctly
 * injects the Mongoose transaction `session` into the native driver call at
 * commit time — mutators on that proxy participate in `withTransaction`.
 *
 * Service-level proxies (SessionService, JournalService, SpecDocumentService,
 * ProjectService) do NOT currently forward the session. Their `execute`
 * callback receives `_session` (unused) and calls the real service method
 * with the ORIGINAL args only. Rationale: v1 service methods do not accept
 * a `session` parameter. Atomicity for service-layer mutations relies on
 * Mongoose's AsyncLocalStorage session propagation when they execute inside
 * a `withTransaction` block (Mongoose 8+). This is "best-effort" atomicity,
 * per spec §7a.
 *
 * Strict atomicity requires threading `session` through each service method
 * signature — a larger refactor tracked separately. For this rewamp, any
 * service mutation that cannot tolerate partial application (if ALS
 * propagation fails) should be re-expressed as a direct
 * `ctx.services.archSessionsCollection.*` call, which DOES inject session.
 *
 * ─── CONTRACT: naming conventions for service methods ───────────────────
 *
 * The service-proxy mutator detection is prefix-based (see SERVICE_MUTATOR_REGEX
 * below). For this to work safely, service authors MUST follow these naming
 * rules:
 *   - **Mutator methods** (state-changing, side-effect-producing): prefix with
 *     `update`, `append`, `create`, `delete`, `remove`, `set`, `replace`,
 *     `archive`, or `close`.
 *   - **Reader methods**: prefix with `get`, `find`, `list`, `read`, `count`,
 *     or `exists`. Never use a mutator-sounding prefix for a reader.
 *   - **Utility/setup helpers** that look like mutators (e.g., `setupCache`,
 *     `createLogger`) MUST NOT be exposed as methods on proxied service
 *     objects — keep them as module-scope functions instead.
 *
 * A method mismatch is a silent bug: a reader named `setPreferred` would be
 * buffered instead of executing. When in doubt, prefer explicit renaming to
 * maintaining an allowlist.
 */

import type { TurnBuffer } from './turn-buffer.js';

// ─── Constants ──────────────────────────────────────────────────────────

/** Regex matching service-level mutator method names (prefix-based). */
const SERVICE_MUTATOR_REGEX =
  /^(update|append|add|create|delete|remove|set|replace|archive|close)/i;

/**
 * Native Mongo collection mutators mapped to the index of their optional
 * `options` parameter. This lets us inject the transaction `{ session }`
 * at the correct position without accidentally merging into the `update`
 * or `filter` argument.
 *
 * MAX_SIZE: fixed constant map, never grows — no eviction needed.
 */
const COLLECTION_MUTATOR_OPTS_INDEX = new Map<string, number>([
  ['updateOne', 2], // (filter, update, opts?)
  ['updateMany', 2], // (filter, update, opts?)
  ['findOneAndUpdate', 2], // (filter, update, opts?)
  ['replaceOne', 2], // (filter, replacement, opts?)
  ['deleteOne', 1], // (filter, opts?)
  ['deleteMany', 1], // (filter, opts?)
  ['insertOne', 1], // (doc, opts?)
  ['insertMany', 1], // (docs, opts?)
]);

// ─── Generic service proxy ──────────────────────────────────────────────

function makeServiceProxy<T extends object>(real: T, buffer: TurnBuffer, serviceLabel: string): T {
  return new Proxy(real, {
    get(target, prop, recv) {
      const orig = Reflect.get(target, prop, recv);
      if (typeof orig !== 'function') return orig;

      const name = String(prop);

      // Reader methods pass through directly.
      if (!SERVICE_MUTATOR_REGEX.test(name)) {
        return (orig as Function).bind(target);
      }

      // Mutator methods: enqueue into the buffer, return void.
      return (...args: unknown[]): Promise<undefined> => {
        buffer.enqueueProjectWrite({
          label: `${serviceLabel}:${name}`,
          execute: async (_session: unknown) => {
            await (orig as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          },
        });
        return Promise.resolve(undefined);
      };
    },
  }) as T;
}

// ─── Service proxy factories ────────────────────────────────────────────

export function createBufferedSessionService<T extends object>(real: T, buffer: TurnBuffer): T {
  return makeServiceProxy(real, buffer, 'sessionService');
}

export function createBufferedJournalService<T extends object>(real: T, buffer: TurnBuffer): T {
  return makeServiceProxy(real, buffer, 'journalService');
}

export function createBufferedSpecDocumentService<T extends object>(
  real: T,
  buffer: TurnBuffer,
): T {
  return makeServiceProxy(real, buffer, 'specDocumentService');
}

export function createBufferedProjectService<T extends object>(real: T, buffer: TurnBuffer): T {
  return makeServiceProxy(real, buffer, 'projectService');
}

// ─── Native Mongo collection proxy ──────────────────────────────────────

/**
 * Minimal shape of a Mongoose/native Mongo collection — used only as a
 * generic constraint for the proxy factory. Does not need to be exhaustive;
 * the proxy intercepts by method name string matching.
 */
export interface MinimalCollection {
  updateOne?: (
    filter: unknown,
    update: unknown,
    opts?: unknown,
  ) => Promise<{ matchedCount: number }>;
  updateMany?: (
    filter: unknown,
    update: unknown,
    opts?: unknown,
  ) => Promise<{ matchedCount: number }>;
  findOneAndUpdate?: (filter: unknown, update: unknown, opts?: unknown) => Promise<unknown>;
  deleteOne?: (filter: unknown, opts?: unknown) => Promise<{ deletedCount: number }>;
  deleteMany?: (filter: unknown, opts?: unknown) => Promise<{ deletedCount: number }>;
  insertOne?: (doc: unknown, opts?: unknown) => Promise<unknown>;
  insertMany?: (docs: unknown[], opts?: unknown) => Promise<unknown>;
  replaceOne?: (filter: unknown, repl: unknown, opts?: unknown) => Promise<unknown>;
  findOne?: (filter: unknown) => Promise<unknown>;
  find?: (filter: unknown) => unknown;
  [k: string]: unknown;
}

/**
 * Wraps a native ArchSessions Mongo collection so that mutator calls
 * (updateOne, insertOne, etc.) are enqueued into the TurnBuffer instead
 * of executing immediately. Reader calls (findOne, find) pass through.
 *
 * When the enqueued ProjectWrite executes at commit time, the real method
 * is called with the transaction session injected into the options arg.
 *
 * Returns optimistic success shapes ({ matchedCount: 1 }) so callers that
 * inspect the return value do not break. Callers that rely on matchedCount=0
 * for error paths need a separate migration (not this task).
 */
export function createBufferedArchSessionsCollection<C extends MinimalCollection>(
  real: C,
  buffer: TurnBuffer,
): C {
  return new Proxy(real, {
    get(target, prop, recv) {
      const orig = Reflect.get(target, prop, recv);
      if (typeof orig !== 'function') return orig;

      const name = String(prop);

      // Reader methods pass through directly.
      const optsIndex = COLLECTION_MUTATOR_OPTS_INDEX.get(name);
      if (optsIndex === undefined) {
        return (orig as Function).bind(target);
      }

      // Mutator: enqueue + return optimistic success shape.
      return (...args: unknown[]): Promise<{ matchedCount: number }> => {
        buffer.enqueueProjectWrite({
          label: `archSessions:${name}`,
          execute: async (session: unknown) => {
            // Inject the transaction session at the known options position.
            // If the caller provided an options object, merge session into it.
            // Otherwise, set a new { session } at that position.
            const existing = args[optsIndex];
            if (existing !== null && existing !== undefined && typeof existing === 'object') {
              args[optsIndex] = { ...(existing as object), session };
            } else {
              args[optsIndex] = { session };
            }

            await (orig as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          },
        });

        // Pre-commit optimistic return.
        return Promise.resolve({ matchedCount: 1 });
      };
    },
  }) as C;
}
