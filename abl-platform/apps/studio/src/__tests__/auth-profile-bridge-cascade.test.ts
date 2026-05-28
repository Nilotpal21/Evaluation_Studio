/**
 * Pure-function tests for cascadeDeleteBridge.
 *
 * The function is extracted with injectable deps so the error path can be
 * verified without mocking any platform modules. All deps are in-test stubs.
 */

import { describe, it, expect, vi } from 'vitest';
import { cascadeDeleteBridge } from '@/app/api/auth-profiles/_bridge-cascade';

describe('cascadeDeleteBridge', () => {
  it('returns { deleted: true } when deleteOne resolves', async () => {
    const deleteOne = vi.fn().mockResolvedValue({ deletedCount: 1 });
    const warn = vi.fn();

    const result = await cascadeDeleteBridge(
      { profileId: 'prof-1', tenantId: 'tenant-1' },
      { deleteOne, log: { warn } },
    );

    expect(result).toEqual({ deleted: true });
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns { deleted: false } and logs a warning when deleteOne throws an Error', async () => {
    const deleteOne = vi.fn().mockRejectedValue(new Error('connection refused'));
    const warn = vi.fn();

    const result = await cascadeDeleteBridge(
      { profileId: 'prof-2', tenantId: 'tenant-2' },
      { deleteOne, log: { warn } },
    );

    expect(result).toEqual({ deleted: false });
    expect(warn).toHaveBeenCalledOnce();
    const [msg, ctx] = warn.mock.calls[0];
    expect(msg).toMatch(/cascade-delete/i);
    expect(ctx.error).toBe('connection refused');
    expect(ctx.profileId).toBe('prof-2');
    expect(ctx.tenantId).toBe('tenant-2');
  });

  it('stringifies non-Error thrown values in the warning context', async () => {
    const deleteOne = vi.fn().mockRejectedValue('timeout');
    const warn = vi.fn();

    const result = await cascadeDeleteBridge(
      { profileId: 'prof-3', tenantId: 'tenant-3' },
      { deleteOne, log: { warn } },
    );

    expect(result).toEqual({ deleted: false });
    const [, ctx] = warn.mock.calls[0];
    expect(ctx.error).toBe('timeout');
  });

  it('passes the correct filter shape to deleteOne', async () => {
    const deleteOne = vi.fn().mockResolvedValue({});
    const warn = vi.fn();

    await cascadeDeleteBridge(
      { profileId: 'prof-4', tenantId: 'tenant-4' },
      { deleteOne, log: { warn } },
    );

    expect(deleteOne).toHaveBeenCalledWith({ authProfileId: 'prof-4', tenantId: 'tenant-4' });
  });
});
