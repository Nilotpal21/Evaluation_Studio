import type { Questionnaire } from '../schemas/questionnaire.schema.js';
import type { ServiceTopology, Tier } from '../types/topology.types.js';
import type { CalibrationProfile } from '../types/calibration.types.js';
import { expectedRps } from './traffic-model.js';
import { roundUpCpu, roundUpMemoryGi, parseMemoryGi, inferNodePool } from './resource-utils.js';
import { sizeApplicationServices } from './service-sizer.js';
import { sizeComputeServices } from './compute-sizer.js';

const MIN_REPLICAS: Record<Tier, number> = { S: 1, M: 2, L: 3, XL: 3 };

export function calibratedSizeServices(
  tier: Tier,
  questionnaire: Questionnaire,
  calibration: CalibrationProfile,
  headroom = 1.2,
): ServiceTopology[] {
  // Start with the full hardcoded service list as defaults
  const allHardcoded = [
    ...sizeApplicationServices(tier, questionnaire),
    ...sizeComputeServices(tier, questionnaire),
  ];
  const fallbackMap = new Map<string, ServiceTopology>();
  for (const svc of allHardcoded) {
    fallbackMap.set(svc.name, svc);
  }

  const services: ServiceTopology[] = [];

  for (const [name, capacity] of Object.entries(calibration.services)) {
    const rps = expectedRps(name, questionnaire);

    const replicasForRps =
      capacity.saturation.maxRpsPerPod > 0
        ? Math.ceil((rps / capacity.saturation.maxRpsPerPod) * headroom)
        : MIN_REPLICAS[tier];

    let replicasForConnections = 0;
    if (capacity.websocket && questionnaire.agents.concurrentConversations > 0) {
      replicasForConnections = Math.ceil(
        (questionnaire.agents.concurrentConversations /
          capacity.websocket.maxTotalConnectionsPerPod) *
          headroom,
      );
    }

    const replicas = Math.max(MIN_REPLICAS[tier], replicasForRps, replicasForConnections);

    const measuredCpu = capacity.measured.cpuPeak
      ? roundUpCpu(parseFloat(capacity.measured.cpuPeak) * 1.15)
      : null;
    const measuredMemGi = capacity.measured.memoryPeak
      ? roundUpMemoryGi((parseMemoryGi(capacity.measured.memoryPeak) ?? 0) * 1.15)
      : null;

    const cpu = measuredCpu !== null ? `${measuredCpu}` : capacity.provisioned.cpu;
    const memory = measuredMemGi !== null ? `${measuredMemGi}Gi` : capacity.provisioned.memory;

    const cpuNum = parseFloat(cpu);
    const nodePool = inferNodePool(name, cpuNum);

    services.push({
      name,
      replicas,
      resources: { cpu, memory },
      nodePool,
      hpa: {
        minReplicas: replicas,
        maxReplicas: Math.ceil(replicas * 1.5),
        targetCPUPercent: 70,
        targetMemoryPercent: 80,
      },
    });

    fallbackMap.delete(name);
  }

  // Add remaining non-calibrated services with hardcoded defaults
  for (const svc of fallbackMap.values()) {
    services.push(svc);
  }

  return services;
}
