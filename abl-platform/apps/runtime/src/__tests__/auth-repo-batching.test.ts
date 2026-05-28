import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockWriteAuditEvent, mockWarn } = vi.hoisted(() => ({
  mockWriteAuditEvent: vi.fn(),
  mockWarn: vi.fn(),
}));
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

vi.mock('../services/audit-store-singleton.js', () => ({
  getAuditStore: vi.fn(),
  writeAuditEvent: (...args: unknown[]) => mockWriteAuditEvent(...args),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: (...args: unknown[]) => mockWarn(...args),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

describe('auth-repo shared audit writes', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockWriteAuditEvent.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    const authRepo = await import('../repos/auth-repo.js');
    authRepo._resetAuthAuditBufferStateForTests();
  });

  async function loadAuthRepo() {
    const authRepo = await import('../repos/auth-repo.js');
    authRepo._resetAuthAuditBufferStateForTests();
    return authRepo;
  }

  it('reports shared-audit-store mode', async () => {
    const authRepo = await loadAuthRepo();

    expect(authRepo.getAuthAuditBufferConfig()).toEqual({
      mode: 'shared-audit-store',
    });
    expect(authRepo.getAuthAuditBufferStats()).toMatchObject({
      enqueuedWrites: 0,
      failedWrites: 0,
      pendingWrites: 0,
      shutdownRequested: false,
    });
  });

  it('writes canonical shared audit events through the runtime singleton and drains on shutdown', async () => {
    const deferred = createDeferred<void>();
    mockWriteAuditEvent.mockReturnValueOnce(deferred.promise);

    const authRepo = await loadAuthRepo();
    authRepo.writeAuditLog({
      action: 'auth.user.success',
      userId: 'user-1',
      tenantId: 'tenant-1',
      metadata: {
        projectId: 'project-1',
        resourceType: 'auth',
        resourceId: 'user-1',
        traceId: 'trace-1',
      },
    });

    expect(mockWriteAuditEvent).toHaveBeenCalledTimes(1);
    expect(mockWriteAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: 'shared',
        source: 'runtime-auth',
        eventType: 'auth.user.success',
        action: 'auth.user.success',
        actorId: 'user-1',
        actorType: 'user',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        resourceType: 'auth',
        resourceId: 'user-1',
        traceId: 'trace-1',
        retentionClass: 'auth',
        metadata: {
          projectId: 'project-1',
          resourceType: 'auth',
          resourceId: 'user-1',
          traceId: 'trace-1',
        },
      }),
    );
    expect(authRepo.getAuthAuditBufferStats()).toMatchObject({
      enqueuedWrites: 1,
      failedWrites: 0,
      pendingWrites: 1,
      shutdownRequested: false,
    });

    const shutdownPromise = authRepo.shutdownAuditLogs();
    expect(authRepo.getAuthAuditBufferStats()).toMatchObject({
      pendingWrites: 1,
      shutdownRequested: true,
    });

    deferred.resolve();
    await shutdownPromise;

    expect(authRepo.getAuthAuditBufferStats()).toMatchObject({
      enqueuedWrites: 1,
      failedWrites: 0,
      pendingWrites: 0,
      shutdownRequested: true,
    });
  });

  it('uses runtime deployment environment when metadata does not include one', async () => {
    process.env.NODE_ENV = 'production';
    const authRepo = await loadAuthRepo();

    authRepo.writeAuditLog({
      action: 'config.updated',
      userId: 'admin-1',
      tenantId: 'tenant-2',
      metadata: {
        resourceType: 'config',
        resourceId: 'cfg-1',
      },
    });

    expect(mockWriteAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: 'production',
        source: 'runtime-store',
        retentionClass: 'crud',
      }),
    );
  });

  it('respects explicit metadata environment when provided', async () => {
    const authRepo = await loadAuthRepo();

    authRepo.writeAuditLog({
      action: 'config.updated',
      userId: 'admin-1',
      tenantId: 'tenant-2',
      metadata: {
        environment: 'staging',
        resourceType: 'config',
        resourceId: 'cfg-1',
      },
    });

    expect(mockWriteAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: 'staging',
      }),
    );
  });

  it('increments failure stats and logs when the shared audit write fails', async () => {
    mockWriteAuditEvent.mockRejectedValueOnce(new Error('pipeline unavailable'));

    const authRepo = await loadAuthRepo();
    authRepo.writeAuditLog({
      action: 'auth.user.success',
      userId: 'user-1',
      tenantId: 'tenant-1',
    });

    await authRepo.shutdownAuditLogs();

    expect(authRepo.getAuthAuditBufferStats()).toMatchObject({
      enqueuedWrites: 1,
      failedWrites: 1,
      pendingWrites: 0,
      shutdownRequested: true,
    });
    expect(mockWarn).toHaveBeenCalledWith('Auth audit write failed', {
      action: 'auth.user.success',
      error: 'pipeline unavailable',
    });
  });

  it('ignores new writes after shutdown has started', async () => {
    const authRepo = await loadAuthRepo();

    await authRepo.shutdownAuditLogs();
    authRepo.writeAuditLog({
      action: 'auth.user.success',
      userId: 'user-1',
      tenantId: 'tenant-1',
    });

    expect(mockWriteAuditEvent).not.toHaveBeenCalled();
    expect(authRepo.getAuthAuditBufferStats()).toMatchObject({
      enqueuedWrites: 0,
      failedWrites: 0,
      pendingWrites: 0,
      shutdownRequested: true,
    });
  });
});
