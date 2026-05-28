export {
  SERVICE_REGISTRY,
  SERVICE_CATEGORIES,
  SERVICE_TEST_ORDER,
  resolveServices,
} from './service-registry.js';
export type { ServiceRegistryEntry, ServiceCategory } from './service-registry.js';

export { runPreflight } from './preflight.js';
export type { PreflightCheck, PreflightResult, PreflightOptions } from './preflight.js';

export { scaleDown, restoreReplicas, getPodResources, waitForPodReady } from './kubectl-ops.js';
export type { PodResources } from './kubectl-ops.js';

export { parseK6Summary, runK6Saturation } from './k6-runner.js';
export type { K6SaturationResult, K6RunOptions } from './k6-runner.js';

export { detectSaturation } from './saturation-detector.js';
export type { SaturationInput, SaturationResult } from './saturation-detector.js';

export { assembleServiceCapacity, assembleProfile, mergeProfiles } from './profile-assembler.js';
export type { ServiceCapacityInput, ProfileAssemblyInput } from './profile-assembler.js';
