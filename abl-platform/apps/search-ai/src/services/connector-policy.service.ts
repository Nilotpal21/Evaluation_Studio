/**
 * Connector Policy Service
 *
 * Provides read-only access to org-level connector policies.
 * Returns sensible defaults when no explicit policy is configured.
 * Policy CRUD is out of scope (admin-level feature).
 */

import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('connector-policy');

// ─── Types ────────────────────────────────────────────────────────────────

export interface ConnectorPolicy {
  maxConnectorsPerKB: number | null;
  selfApprovalAllowed: boolean;
  credentialExportAllowed: boolean;
  templateSharingScope: 'project' | 'tenant' | 'global';
  requireApprovalForPermissionAwareSearch: boolean;
}

// ─── Default Policy ──────────────────────────────────────────────────────

const DEFAULT_POLICY: ConnectorPolicy = {
  maxConnectorsPerKB: null, // unlimited
  selfApprovalAllowed: true,
  credentialExportAllowed: false,
  templateSharingScope: 'tenant',
  requireApprovalForPermissionAwareSearch: false,
};

// ─── Service Functions ───────────────────────────────────────────────────

export async function getConnectorPolicy(tenantId: string): Promise<ConnectorPolicy> {
  // Future: Read from a tenant-level config collection or environment variables.
  // For now, return sensible defaults.
  logger.debug('Returning default connector policy', { tenantId });
  return { ...DEFAULT_POLICY };
}
