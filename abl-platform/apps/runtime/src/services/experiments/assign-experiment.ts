/**
 * Experiment Assignment Result
 *
 * Returned by tryAssignExperimentPreSession in session-factory.ts.
 * Kept here as the canonical type definition to avoid circular imports.
 */

export interface ExperimentAssignmentResult {
  experimentId: string;
  experimentGroup: 'control' | 'experiment';
  /** Entry agent version for the assigned group. Empty string in deployment mode. */
  agentVersionId: string;
  assignmentMode: 'version' | 'deployment';
  assignmentDeploymentId?: string;
}
