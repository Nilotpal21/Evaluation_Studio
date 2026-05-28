/**
 * Pure-function tests for createBridgeForProfile.
 *
 * The function is extracted with injectable deps so the create and error
 * paths can be verified without mocking any platform modules.
 * All deps are in-test stubs.
 */

import { describe, it, expect, vi } from 'vitest';
import { createBridgeForProfile } from '@/app/api/auth-profiles/_bridge-create';

const baseParams = {
  profileId: 'prof-1',
  connector: 'salesforce',
  tenantId: 'tenant-1',
  projectId: 'project-1',
  displayName: 'My Salesforce Profile',
  userId: 'user-1',
};

describe('createBridgeForProfile', () => {
  it('returns { created: false, skipped: true } when connector is null', async () => {
    const upsertOne = vi.fn();
    const debug = vi.fn();

    const result = await createBridgeForProfile(
      { ...baseParams, connector: null },
      { upsertOne, log: { debug } },
    );

    expect(result).toEqual({ created: false, skipped: true });
    expect(upsertOne).not.toHaveBeenCalled();
  });

  it('returns { created: false, skipped: true } when connector is undefined', async () => {
    const upsertOne = vi.fn();
    const debug = vi.fn();

    const result = await createBridgeForProfile(
      { ...baseParams, connector: undefined },
      { upsertOne, log: { debug } },
    );

    expect(result).toEqual({ created: false, skipped: true });
    expect(upsertOne).not.toHaveBeenCalled();
  });

  it('returns { created: true, skipped: false } when upsertOne inserts a new row', async () => {
    const upsertOne = vi.fn().mockResolvedValue({ alreadyExisted: false });
    const debug = vi.fn();

    const result = await createBridgeForProfile(baseParams, { upsertOne, log: { debug } });

    expect(result).toEqual({ created: true, skipped: false });
  });

  it('returns { created: false, skipped: false } when row already existed', async () => {
    const upsertOne = vi.fn().mockResolvedValue({ alreadyExisted: true });
    const debug = vi.fn();

    const result = await createBridgeForProfile(baseParams, { upsertOne, log: { debug } });

    expect(result).toEqual({ created: false, skipped: false });
  });

  it('propagates upsertOne errors so the caller transaction can roll back', async () => {
    const upsertOne = vi.fn().mockRejectedValue(new Error('duplicate key'));
    const debug = vi.fn();

    await expect(createBridgeForProfile(baseParams, { upsertOne, log: { debug } })).rejects.toThrow(
      'duplicate key',
    );
  });

  it('passes the correct filter and setOnInsert shapes to upsertOne', async () => {
    const upsertOne = vi.fn().mockResolvedValue({ alreadyExisted: false });
    const debug = vi.fn();

    await createBridgeForProfile(baseParams, { upsertOne, log: { debug } });

    expect(upsertOne).toHaveBeenCalledOnce();
    const [filter, setOnInsert] = upsertOne.mock.calls[0];

    expect(filter).toEqual({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      connectorName: 'salesforce',
      authProfileId: 'prof-1',
    });
    expect(setOnInsert).toMatchObject({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      connectorName: 'salesforce',
      authProfileId: 'prof-1',
      displayName: 'My Salesforce Profile',
      scope: 'tenant',
      status: 'active',
    });
  });

  it('sets userId to null when not provided', async () => {
    const upsertOne = vi.fn().mockResolvedValue({ alreadyExisted: false });
    const debug = vi.fn();

    await createBridgeForProfile(
      { ...baseParams, userId: undefined },
      { upsertOne, log: { debug } },
    );

    const [, setOnInsert] = upsertOne.mock.calls[0];
    expect(setOnInsert.userId).toBeNull();
  });
});
