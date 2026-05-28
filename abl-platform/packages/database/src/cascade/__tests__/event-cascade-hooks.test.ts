/**
 * UT-06 — EventCascadeHook backward compatibility.
 *
 * Verifies that:
 *  1. A hook implementation that does NOT define `deleteByExecutionIds`
 *     still satisfies the `EventCascadeHook` interface (optional method,
 *     LLD §3.4 / D-7).
 *  2. Callers using optional chaining (`hook.deleteByExecutionIds?.(…)`)
 *     get `undefined` back without throwing when the method is absent.
 *  3. An implementation that DOES define the method routes through it
 *     exactly once with the expected arguments.
 *
 * No mocks — uses plain object literals. The runtime's existing hook
 * impl at `apps/runtime/src/services/eventstore-singleton.ts` still has
 * only `deleteBySessionIds` + `deleteTenant`, and this test guards that
 * adding the new optional method does not force those consumers to update.
 */

import { describe, it, expect } from 'vitest';
import {
  registerEventCascadeHook,
  getEventCascadeHook,
  _resetEventCascadeHook,
  type EventCascadeHook,
} from '../event-cascade-hooks.js';

describe('EventCascadeHook — deleteByExecutionIds optional method', () => {
  it('accepts a hook WITHOUT deleteByExecutionIds (back-compat for existing runtime hook)', () => {
    _resetEventCascadeHook();
    const legacyHook: EventCascadeHook = {
      deleteBySessionIds: async () => {},
      deleteTenant: async () => {},
    };

    registerEventCascadeHook(legacyHook);
    const registered = getEventCascadeHook();

    expect(registered).not.toBeNull();
    expect(registered!.deleteBySessionIds).toBeDefined();
    expect(registered!.deleteTenant).toBeDefined();
    expect(registered!.deleteByExecutionIds).toBeUndefined();
  });

  it('optional chaining returns undefined instead of throwing when the method is absent', async () => {
    _resetEventCascadeHook();
    const legacyHook: EventCascadeHook = {
      deleteBySessionIds: async () => {},
      deleteTenant: async () => {},
    };
    registerEventCascadeHook(legacyHook);

    const hook = getEventCascadeHook()!;
    const result = await hook.deleteByExecutionIds?.('t1', ['exec-1']);

    expect(result).toBeUndefined();
  });

  it('invokes deleteByExecutionIds exactly once with the forwarded arguments when provided', async () => {
    _resetEventCascadeHook();
    const calls: Array<{ tenantId: string; executionIds: string[] }> = [];
    const modernHook: EventCascadeHook = {
      deleteBySessionIds: async () => {},
      deleteTenant: async () => {},
      deleteByExecutionIds: async (tenantId, executionIds) => {
        calls.push({ tenantId, executionIds });
      },
    };

    registerEventCascadeHook(modernHook);
    await getEventCascadeHook()!.deleteByExecutionIds?.('tenant-x', ['e1', 'e2']);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.tenantId).toBe('tenant-x');
    expect(calls[0]!.executionIds).toEqual(['e1', 'e2']);
  });
});
