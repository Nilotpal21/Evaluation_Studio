/**
 * ClickHouse Experiment Assignment Writer
 *
 * Writes experiment group assignment records to the ClickHouse
 * `experiment_assignments` table. Follows the same insert pattern used
 * by KMS audit logger and other fire-and-forget analytics writers.
 *
 * This function is designed to be called fire-and-forget from the session
 * creation path — callers should `.catch()` and log rather than await.
 */

import { createLogger } from '@abl/compiler/platform';
import { toClickHouseDateTime } from '@agent-platform/database/clickhouse';
import type { ClickHouseClient } from '@clickhouse/client';

const log = createLogger('experiment-assignment-writer');

const TABLE = 'abl_platform.experiment_assignments';

// ─── Types ─────────────────────────────────────────────────────────────

export interface ExperimentAssignmentData {
  tenantId: string;
  projectId: string;
  experimentId: string;
  sessionId: string;
  experimentGroup: 'control' | 'experiment';
  agentVersionId: string;
  assignmentMode: 'version' | 'deployment';
  assignmentDeploymentId?: string;
  assignedAt: Date;
}

// ─── Writer ────────────────────────────────────────────────────────────

/**
 * Insert a single experiment assignment record into ClickHouse.
 *
 * Designed for fire-and-forget usage:
 * ```
 * writeExperimentAssignment(data, chClient).catch(err =>
 *   log.error('Failed to write experiment assignment', { ... })
 * );
 * ```
 */
export async function writeExperimentAssignment(
  data: ExperimentAssignmentData,
  chClient: ClickHouseClient,
): Promise<void> {
  const row = {
    tenant_id: data.tenantId,
    project_id: data.projectId,
    experiment_id: data.experimentId,
    session_id: data.sessionId,
    experiment_group: data.experimentGroup,
    agent_version_id: data.agentVersionId,
    assignment_mode: data.assignmentMode,
    deployment_id: data.assignmentDeploymentId ?? '',
    assigned_at: toClickHouseDateTime(data.assignedAt),
  };

  await chClient.insert({
    table: TABLE,
    values: [row],
    format: 'JSONEachRow',
  });

  log.info('Experiment assignment written to ClickHouse', {
    experimentId: data.experimentId,
    sessionId: data.sessionId,
    group: data.experimentGroup,
  });
}
