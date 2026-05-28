export {
  PHASE_CONFIG,
  transitionPhase,
  getSpecialistForPhase,
  checkExitCriteria,
  getNextPhase,
  resolveMode,
} from './phase-machine.js';
export type { PhaseConfig } from './phase-machine.js';

export {
  validateStateTransition,
  RESUMABLE_STATES,
  LISTABLE_STATES,
  ARCHIVABLE_STATES,
} from './session-state-machine.js';

export { classifyMutationScope } from './scope-classifier.js';
export type { MutationScope } from './scope-classifier.js';

export { LoopDetector } from './loop-detection.js';

export { routeByContent } from './content-router.js';

export {
  synthesizeDefaultTopology,
  classifyTopologyPattern,
  synthesizePatternTopology,
  TOPOLOGY_PATTERN_VOCABULARY,
  TOPOLOGY_DECISION_TREE,
} from './topology-synthesis.js';
export type { TopologyPatternId, TopologyPatternDef } from './topology-synthesis.js';

export { pickNextGate, diffTopologyAgainstBuildState } from './build-gate-queue.js';
export type { BuildGateQueueInput, NextGateDecision, TopologyDiff } from './build-gate-queue.js';
