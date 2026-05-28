import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { calibratedSizeServices } from '../engine/calibrated-service-sizer.js';
import { sizeApplicationServices } from '../engine/service-sizer.js';
import { sizeComputeServices } from '../engine/compute-sizer.js';
import type { CalibrationProfile } from '../types/calibration.types.js';
import { makeQ } from './helpers/make-questionnaire.js';

async function loadCalibration(): Promise<CalibrationProfile> {
  const raw = await readFile(join(__dirname, 'fixtures/calibration-m.json'), 'utf-8');
  return JSON.parse(raw) as CalibrationProfile;
}

describe('calibratedSizeServices', () => {
  it('computes replicas from measured maxRpsPerPod', async () => {
    const calibration = await loadCalibration();
    const q = makeQ({
      agents: {
        agentCount: 5,
        concurrentConversations: 500,
        avgConversationLength: 10,
        messagesPerDay: 10000,
        toolCallsPerConversation: 3,
        multiAgentUsage: 0,
      },
    });

    const services = calibratedSizeServices('M', q, calibration);
    const runtime = services.find((s) => s.name === 'runtime');

    expect(runtime).toBeDefined();
    // 500 concurrent / 180 maxRps * 1.2 headroom = ceil(3.33) = 4
    expect(runtime!.replicas).toBe(4);
  });

  it('respects tier minimum replicas', async () => {
    const calibration = await loadCalibration();
    const q = makeQ({
      agents: {
        agentCount: 1,
        concurrentConversations: 10,
        avgConversationLength: 5,
        messagesPerDay: 100,
        toolCallsPerConversation: 1,
        multiAgentUsage: 0,
      },
    });

    const services = calibratedSizeServices('M', q, calibration);
    const runtime = services.find((s) => s.name === 'runtime');

    // ceil(10 / 180 * 1.2) = 1, but M tier minimum should be >= 2
    expect(runtime!.replicas).toBeGreaterThanOrEqual(2);
  });

  it('uses max(RPS, connections) for two-dimensional sizing — RPS dominates', async () => {
    const calibration = await loadCalibration();
    const q = makeQ({
      agents: {
        agentCount: 5,
        concurrentConversations: 5000,
        avgConversationLength: 10,
        messagesPerDay: 1000,
        toolCallsPerConversation: 1,
        multiAgentUsage: 0,
      },
    });

    const services = calibratedSizeServices('M', q, calibration);
    const runtime = services.find((s) => s.name === 'runtime');

    // RPS replicas: ceil(5000 / 180 * 1.2) = 34
    // Connection replicas: ceil(5000 / 850 * 1.2) = 8
    // max(2, 34, 8) = 34
    expect(runtime!.replicas).toBe(34);
  });

  it('connection dimension contributes when maxRpsPerPod is very high', async () => {
    const calibration = await loadCalibration();
    calibration.services.runtime.saturation.maxRpsPerPod = 50000;
    const q = makeQ({
      agents: {
        agentCount: 5,
        concurrentConversations: 5000,
        avgConversationLength: 10,
        messagesPerDay: 1000,
        toolCallsPerConversation: 1,
        multiAgentUsage: 0,
      },
    });

    const services = calibratedSizeServices('M', q, calibration);
    const runtime = services.find((s) => s.name === 'runtime');

    // RPS replicas: ceil(5000 / 50000 * 1.2) = 1
    // Connection replicas: ceil(5000 / 850 * 1.2) = 8
    // max(2, 1, 8) = 8
    expect(runtime!.replicas).toBe(8);
  });

  it('uses measured CPU/memory with 15% buffer for resources', async () => {
    const calibration = await loadCalibration();
    const q = makeQ();

    const services = calibratedSizeServices('M', q, calibration);
    const runtime = services.find((s) => s.name === 'runtime');

    // cpuPeak 1.82 * 1.15 = 2.093 → roundUp to 2.25
    expect(parseFloat(runtime!.resources.cpu)).toBeGreaterThanOrEqual(2);
    // memoryPeak 3.2 * 1.15 = 3.68 → roundUp to 3.75Gi
    expect(runtime!.resources.memory).toMatch(/\d+(\.\d+)?Gi/);
  });

  it('falls back to provisioned specs when Coroot data is null', async () => {
    const calibration = await loadCalibration();
    calibration.services.runtime.measured.cpuPeak = null;
    calibration.services.runtime.measured.memoryPeak = null;
    const q = makeQ();

    const services = calibratedSizeServices('M', q, calibration);
    const runtime = services.find((s) => s.name === 'runtime');

    expect(runtime!.resources.cpu).toBe('2');
    expect(runtime!.resources.memory).toBe('4Gi');
  });

  it('includes HPA config on calibrated services', async () => {
    const calibration = await loadCalibration();
    const q = makeQ();
    const calibratedNames = Object.keys(calibration.services);

    const services = calibratedSizeServices('M', q, calibration);
    for (const svc of services) {
      if (calibratedNames.includes(svc.name)) {
        expect(svc.hpa).toBeDefined();
        expect(svc.hpa!.minReplicas).toBe(svc.replicas);
        expect(svc.hpa!.maxReplicas).toBeGreaterThan(svc.replicas);
      }
    }
  });

  it('includes uncalibrated services with hardcoded defaults', async () => {
    const calibration = await loadCalibration();
    const q = makeQ();

    const services = calibratedSizeServices('M', q, calibration);
    const calibratedNames = Object.keys(calibration.services);

    // Calibrated services should be present
    for (const name of calibratedNames) {
      expect(services.find((s) => s.name === name)).toBeDefined();
    }

    // Hardcoded-only services should also be present
    const hardcoded = [...sizeApplicationServices('M', q), ...sizeComputeServices('M', q)];
    for (const svc of hardcoded) {
      expect(services.find((s) => s.name === svc.name)).toBeDefined();
    }

    // Total count should match full hardcoded list (at minimum)
    expect(services.length).toBeGreaterThanOrEqual(hardcoded.length);
  });

  it('calibrated services override hardcoded defaults', async () => {
    const calibration = await loadCalibration();
    const q = makeQ();

    const calibratedServices = calibratedSizeServices('M', q, calibration);
    const hardcoded = [...sizeApplicationServices('M', q), ...sizeComputeServices('M', q)];

    // For a calibrated service, resources should differ from hardcoded
    const calibratedRuntime = calibratedServices.find((s) => s.name === 'runtime');
    const hardcodedRuntime = hardcoded.find((s) => s.name === 'runtime');
    expect(calibratedRuntime).toBeDefined();
    expect(hardcodedRuntime).toBeDefined();
    // Calibrated uses measured CPU with buffer, so it should differ from hardcoded
    expect(calibratedRuntime!.resources.cpu).not.toBe(hardcodedRuntime!.resources.cpu);
  });
});
