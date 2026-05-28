/**
 * Preflight Checks Tests
 *
 * Mocks child_process.execFile to test preflight verification logic.
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

import { runPreflight } from '../../../commands/benchmark/preflight.js';

function setupExecFileMock(responses: Record<string, { stdout?: string; error?: Error }>) {
  mockExecFilePromise.mockImplementation(async (cmd: string, args: string[]) => {
    const key = `${cmd} ${(args || []).join(' ')}`;

    // Find a matching response by prefix
    let matched: { stdout?: string; error?: Error } | undefined;
    for (const [prefix, resp] of Object.entries(responses)) {
      if (key.startsWith(prefix)) {
        matched = resp;
        break;
      }
    }

    if (!matched) {
      matched = { stdout: '' };
    }

    if (matched.error) {
      throw matched.error;
    }
    return { stdout: matched.stdout ?? '', stderr: '' };
  });
}

describe('runPreflight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should pass when all tools are available', async () => {
    setupExecFileMock({
      'kubectl version': { stdout: 'Client Version: v1.28.0' },
      'k6 version': { stdout: 'k6 v0.47.0' },
      'kubectl get namespace': { stdout: 'NAME   STATUS   AGE\nabl    Active   10d' },
      'kubectl get deployment': { stdout: '1' },
    });

    const result = await runPreflight({
      namespace: 'abl',
      services: ['runtime'],
      deploymentNames: ['abl-runtime'],
      requireCoroot: false,
    });

    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.originalReplicas).toHaveProperty('runtime');
  });

  it('should fail when kubectl is not available', async () => {
    setupExecFileMock({
      'kubectl version': { error: new Error('not found') },
      'k6 version': { stdout: 'k6 v0.47.0' },
      'kubectl get namespace': { error: new Error('not found') },
      'kubectl get deployment': { error: new Error('not found') },
    });

    const result = await runPreflight({
      namespace: 'abl',
      services: ['runtime'],
      deploymentNames: ['abl-runtime'],
      requireCoroot: false,
    });

    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.includes('kubectl'))).toBe(true);
  });

  it('should fail when k6 is not available', async () => {
    setupExecFileMock({
      'kubectl version': { stdout: 'Client Version: v1.28.0' },
      'k6 version': { error: new Error('not found') },
      'kubectl get namespace': { stdout: 'abl Active' },
      'kubectl get deployment': { stdout: '1' },
    });

    const result = await runPreflight({
      namespace: 'abl',
      services: ['runtime'],
      deploymentNames: ['abl-runtime'],
      requireCoroot: false,
    });

    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.includes('k6'))).toBe(true);
  });

  it('should fail when namespace does not exist', async () => {
    setupExecFileMock({
      'kubectl version': { stdout: 'Client Version: v1.28.0' },
      'k6 version': { stdout: 'k6 v0.47.0' },
      'kubectl get namespace': { error: new Error('not found') },
      'kubectl get deployment': { stdout: '1' },
    });

    const result = await runPreflight({
      namespace: 'missing-ns',
      services: ['runtime'],
      deploymentNames: ['abl-runtime'],
      requireCoroot: false,
    });

    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.includes('missing-ns'))).toBe(true);
  });

  it('should record original replica counts', async () => {
    setupExecFileMock({
      'kubectl version': { stdout: 'Client Version: v1.28.0' },
      'k6 version': { stdout: 'k6 v0.47.0' },
      'kubectl get namespace': { stdout: 'abl Active' },
      'kubectl get deployment': { stdout: '3' },
    });

    const result = await runPreflight({
      namespace: 'abl',
      services: ['runtime', 'search-ai'],
      deploymentNames: ['abl-runtime', 'abl-search-ai'],
      requireCoroot: false,
    });

    expect(result.originalReplicas['runtime']).toBe(3);
    expect(result.originalReplicas['search-ai']).toBe(3);
  });

  it('should add warning when optional Coroot is unreachable', async () => {
    setupExecFileMock({
      'kubectl version': { stdout: 'Client Version: v1.28.0' },
      'k6 version': { stdout: 'k6 v0.47.0' },
      'kubectl get namespace': { stdout: 'abl Active' },
      'kubectl get deployment': { stdout: '1' },
      curl: { error: new Error('connection refused') },
    });

    const result = await runPreflight({
      namespace: 'abl',
      services: ['runtime'],
      deploymentNames: ['abl-runtime'],
      requireCoroot: false,
      corootUrl: 'http://coroot:8080',
    });

    expect(result.passed).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('metrics will be unavailable');
  });

  it('should fail when required Coroot is unreachable', async () => {
    setupExecFileMock({
      'kubectl version': { stdout: 'Client Version: v1.28.0' },
      'k6 version': { stdout: 'k6 v0.47.0' },
      'kubectl get namespace': { stdout: 'abl Active' },
      'kubectl get deployment': { stdout: '1' },
      curl: { error: new Error('connection refused') },
    });

    const result = await runPreflight({
      namespace: 'abl',
      services: ['runtime'],
      deploymentNames: ['abl-runtime'],
      requireCoroot: true,
      corootUrl: 'http://coroot:8080',
    });

    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.includes('Coroot'))).toBe(true);
  });
});
