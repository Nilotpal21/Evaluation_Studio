/**
 * kubectl Operations Tests
 *
 * Mocks child_process.execFile to test kubectl operation logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promisify } from 'util';

const { mockExecFilePromise } = vi.hoisted(() => ({
  mockExecFilePromise: vi.fn<(...args: any[]) => Promise<{ stdout: string; stderr: string }>>(),
}));

vi.mock('child_process', () => {
  const fn = (...args: any[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === 'function') {
      return mockExecFilePromise(...args.slice(0, -1)).then(
        (result) => cb(null, result.stdout, result.stderr),
        (err) => cb(err, '', ''),
      );
    }
  };
  fn[promisify.custom] = mockExecFilePromise;
  return { execFile: fn };
});

import {
  scaleDown,
  restoreReplicas,
  getPodResources,
  waitForPodReady,
} from '../../../commands/benchmark/kubectl-ops.js';

function mockSuccess(stdout = '') {
  mockExecFilePromise.mockResolvedValue({ stdout, stderr: '' });
}

function mockFailure(errorMessage: string) {
  mockExecFilePromise.mockRejectedValue(new Error(errorMessage));
}

describe('scaleDown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should scale deployment to 1 replica and wait for rollout', async () => {
    mockSuccess();

    await scaleDown('abl-runtime', 'abl');

    expect(mockExecFilePromise).toHaveBeenCalledTimes(2);

    const firstCall = mockExecFilePromise.mock.calls[0];
    expect(firstCall[0]).toBe('kubectl');
    expect(firstCall[1]).toContain('--replicas=1');

    const secondCall = mockExecFilePromise.mock.calls[1];
    expect(secondCall[0]).toBe('kubectl');
    expect(secondCall[1]).toContain('rollout');
  });

  it('should reject on scale failure', async () => {
    mockFailure('deployment not found');

    await expect(scaleDown('nonexistent', 'abl')).rejects.toThrow('deployment not found');
  });
});

describe('restoreReplicas', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should restore to the specified replica count', async () => {
    mockSuccess();

    await restoreReplicas('abl-runtime', 3, 'abl');

    expect(mockExecFilePromise).toHaveBeenCalledTimes(1);
    const call = mockExecFilePromise.mock.calls[0];
    expect(call[1]).toContain('--replicas=3');
  });
});

describe('getPodResources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return CPU and memory from pod spec', async () => {
    let callCount = 0;
    mockExecFilePromise.mockImplementation(async () => {
      callCount++;
      const stdout = callCount === 1 ? '500m' : '512Mi';
      return { stdout, stderr: '' };
    });

    const resources = await getPodResources('abl-runtime', 'abl');
    expect(resources.cpu).toBe('500m');
    expect(resources.memory).toBe('512Mi');
  });

  it('should return "unknown" for missing resource fields', async () => {
    mockSuccess('');

    const resources = await getPodResources('abl-runtime', 'abl');
    expect(resources.cpu).toBe('unknown');
    expect(resources.memory).toBe('unknown');
  });
});

describe('waitForPodReady', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call kubectl rollout status with correct timeout', async () => {
    mockSuccess();

    await waitForPodReady('abl-runtime', 'abl', 60_000);

    expect(mockExecFilePromise).toHaveBeenCalledTimes(1);
    const call = mockExecFilePromise.mock.calls[0];
    expect(call[1]).toContain('--timeout=60s');
  });

  it('should reject on timeout', async () => {
    mockFailure('timed out waiting for rollout');

    await expect(waitForPodReady('abl-runtime', 'abl', 5_000)).rejects.toThrow('timed out');
  });
});
