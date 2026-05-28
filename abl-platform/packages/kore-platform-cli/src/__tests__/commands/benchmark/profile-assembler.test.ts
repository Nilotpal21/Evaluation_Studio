/**
 * Profile Assembler Tests
 *
 * Tests profile assembly, merging, and service capacity construction.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  assembleServiceCapacity,
  assembleProfile,
  mergeProfiles,
} from '../../../commands/benchmark/profile-assembler.js';
import type { CalibrationProfile } from '@agent-platform/sizing-calculator';

describe('assembleServiceCapacity', () => {
  it('should assemble a ServiceCapacity from k6 and saturation results', () => {
    const result = assembleServiceCapacity({
      serviceName: 'runtime',
      k6Result: {
        latency: { p50Ms: 10, p95Ms: 50, p99Ms: 100, minMs: 1, maxMs: 500 },
        errorRate: 0.005,
        rps: 200,
        maxVUs: 50,
        durationMs: 60000,
        timestamps: { start: '2026-01-01T00:00:00Z', end: '2026-01-01T00:01:00Z' },
        summaryPath: '/tmp/summary.json',
      },
      saturation: {
        saturated: true,
        trigger: 'error-rate',
        maxRpsPerPod: 200,
        maxConcurrentPerPod: 50,
      },
      podResources: { cpu: '500m', memory: '512Mi' },
      testedUrl: 'http://abl-runtime.abl.svc.cluster.local',
      testedViaIngress: false,
      baselineP95Ms: 25,
    });

    expect(result.provisioned.cpu).toBe('500m');
    expect(result.provisioned.memory).toBe('512Mi');
    expect(result.saturation.trigger).toBe('error-rate');
    expect(result.saturation.maxRpsPerPod).toBe(200);
    expect(result.saturation.maxConcurrentPerPod).toBe(50);
    expect(result.latency.p50Ms).toBe(10);
    expect(result.latency.p95Ms).toBe(50);
    expect(result.latency.baselineP95Ms).toBe(25);
    expect(result.websocket).toBeNull();
    expect(result.testedUrl).toBe('http://abl-runtime.abl.svc.cluster.local');
    expect(result.testedViaIngress).toBe(false);
  });

  it('should use default measured values when not provided', () => {
    const result = assembleServiceCapacity({
      serviceName: 'runtime',
      k6Result: {
        latency: { p50Ms: 10, p95Ms: 50, p99Ms: 100, minMs: 1, maxMs: 500 },
        errorRate: 0,
        rps: 100,
        maxVUs: 20,
        durationMs: 30000,
        timestamps: { start: '2026-01-01T00:00:00Z', end: '2026-01-01T00:00:30Z' },
        summaryPath: '/tmp/s.json',
      },
      saturation: {
        saturated: false,
        trigger: 'none',
        maxRpsPerPod: 100,
        maxConcurrentPerPod: 20,
      },
      podResources: { cpu: '1', memory: '1Gi' },
      testedUrl: 'http://test',
      testedViaIngress: false,
      baselineP95Ms: 30,
    });

    expect(result.measured.cpuPeak).toBeNull();
    expect(result.measured.podRestarts).toBe(0);
    expect(result.measured.oomKills).toBe(0);
  });

  it('should use provided measured values', () => {
    const result = assembleServiceCapacity({
      serviceName: 'runtime',
      k6Result: {
        latency: { p50Ms: 10, p95Ms: 50, p99Ms: 100, minMs: 1, maxMs: 500 },
        errorRate: 0,
        rps: 100,
        maxVUs: 20,
        durationMs: 30000,
        timestamps: { start: '2026-01-01T00:00:00Z', end: '2026-01-01T00:00:30Z' },
        summaryPath: '/tmp/s.json',
      },
      saturation: {
        saturated: false,
        trigger: 'none',
        maxRpsPerPod: 100,
        maxConcurrentPerPod: 20,
      },
      podResources: { cpu: '1', memory: '1Gi' },
      testedUrl: 'http://test',
      testedViaIngress: false,
      baselineP95Ms: 30,
      measured: {
        cpuPeak: '450m',
        cpuAvg: '200m',
        memoryPeak: '400Mi',
        memoryAvg: '300Mi',
        podRestarts: 1,
        oomKills: 0,
      },
    });

    expect(result.measured.cpuPeak).toBe('450m');
    expect(result.measured.cpuAvg).toBe('200m');
    expect(result.measured.podRestarts).toBe(1);
  });

  it('should map "none" trigger to "error-rate" for type safety', () => {
    const result = assembleServiceCapacity({
      serviceName: 'runtime',
      k6Result: {
        latency: { p50Ms: 10, p95Ms: 50, p99Ms: 100, minMs: 1, maxMs: 500 },
        errorRate: 0,
        rps: 100,
        maxVUs: 20,
        durationMs: 30000,
        timestamps: { start: '2026-01-01T00:00:00Z', end: '2026-01-01T00:00:30Z' },
        summaryPath: '/tmp/s.json',
      },
      saturation: {
        saturated: false,
        trigger: 'none',
        maxRpsPerPod: 100,
        maxConcurrentPerPod: 20,
      },
      podResources: { cpu: '1', memory: '1Gi' },
      testedUrl: 'http://test',
      testedViaIngress: false,
      baselineP95Ms: 30,
    });

    // The CalibrationProfile type expects SaturationTrigger, not 'none'
    expect(result.saturation.trigger).toBe('error-rate');
  });
});

describe('assembleProfile', () => {
  let originalDateNow: () => number;

  beforeEach(() => {
    originalDateNow = Date.now;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-25T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should create a profile with version 1.0 and current timestamp', () => {
    const profile = assembleProfile({
      tier: 'M',
      environment: 'staging-eks',
      services: {},
    });

    expect(profile.version).toBe('1.0');
    expect(profile.tier).toBe('M');
    expect(profile.timestamp).toBe('2026-03-25T12:00:00.000Z');
    expect(profile.environment).toBe('staging-eks');
    expect(profile.services).toEqual({});
    expect(profile.dataStores).toEqual({});
  });

  it('should include provided services', () => {
    const mockCapacity = {
      provisioned: { cpu: '500m', memory: '512Mi' },
      saturation: { trigger: 'error-rate' as const, maxRpsPerPod: 100, maxConcurrentPerPod: 20 },
      websocket: null,
      scenarios: {},
      measured: {
        cpuPeak: null,
        cpuAvg: null,
        memoryPeak: null,
        memoryAvg: null,
        podRestarts: 0,
        oomKills: 0,
      },
      latency: { p50Ms: 10, p95Ms: 50, p99Ms: 100, minMs: 1, maxMs: 500, baselineP95Ms: 25 },
      testedUrl: 'http://test',
      testedViaIngress: false,
    };

    const profile = assembleProfile({
      tier: 'L',
      environment: 'prod',
      services: { runtime: mockCapacity },
    });

    expect(Object.keys(profile.services)).toHaveLength(1);
    expect(profile.services['runtime']).toBeDefined();
  });
});

describe('mergeProfiles', () => {
  function makeProfile(overrides: Partial<CalibrationProfile> = {}): CalibrationProfile {
    return {
      version: '1.0',
      tier: 'M',
      timestamp: '2026-01-01T00:00:00.000Z',
      environment: 'test',
      services: {},
      dataStores: {},
      ...overrides,
    };
  }

  it('should throw on empty input', () => {
    expect(() => mergeProfiles([])).toThrow('Cannot merge zero profiles');
  });

  it('should throw on tier mismatch', () => {
    const p1 = makeProfile({ tier: 'M' });
    const p2 = makeProfile({ tier: 'L' });

    expect(() => mergeProfiles([p1, p2])).toThrow('Tier mismatch');
  });

  it('should merge services from multiple profiles (last wins)', () => {
    const capacity1 = {
      provisioned: { cpu: '500m', memory: '512Mi' },
      saturation: { trigger: 'error-rate' as const, maxRpsPerPod: 100, maxConcurrentPerPod: 20 },
      websocket: null,
      scenarios: {},
      measured: {
        cpuPeak: null,
        cpuAvg: null,
        memoryPeak: null,
        memoryAvg: null,
        podRestarts: 0,
        oomKills: 0,
      },
      latency: { p50Ms: 10, p95Ms: 50, p99Ms: 100, minMs: 1, maxMs: 500, baselineP95Ms: 25 },
      testedUrl: 'http://test',
      testedViaIngress: false,
    };

    const capacity2 = {
      ...capacity1,
      saturation: { trigger: 'latency' as const, maxRpsPerPod: 200, maxConcurrentPerPod: 40 },
    };

    const p1 = makeProfile({ services: { runtime: capacity1 } });
    const p2 = makeProfile({ services: { runtime: capacity2, searchAi: capacity1 } });

    const merged = mergeProfiles([p1, p2]);

    expect(Object.keys(merged.services)).toHaveLength(2);
    expect(merged.services['runtime'].saturation.trigger).toBe('latency');
    expect(merged.services['searchAi']).toBeDefined();
  });

  it('should use the latest timestamp', () => {
    const p1 = makeProfile({ timestamp: '2026-01-01T00:00:00.000Z' });
    const p2 = makeProfile({ timestamp: '2026-03-01T00:00:00.000Z' });

    const merged = mergeProfiles([p1, p2]);

    expect(merged.timestamp).toBe('2026-03-01T00:00:00.000Z');
  });

  it('should use environment from the last profile', () => {
    const p1 = makeProfile({ environment: 'staging' });
    const p2 = makeProfile({ environment: 'production' });

    const merged = mergeProfiles([p1, p2]);

    expect(merged.environment).toBe('production');
  });

  it('should pass through a single profile', () => {
    const p1 = makeProfile({ environment: 'solo' });
    const merged = mergeProfiles([p1]);

    expect(merged.environment).toBe('solo');
    expect(merged.version).toBe('1.0');
  });
});
