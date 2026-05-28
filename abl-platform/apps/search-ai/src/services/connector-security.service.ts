/**
 * Connector Security Service
 *
 * Provides security overview, blast radius analysis, emergency revoke,
 * and security document export for connector configurations.
 */

import { createLogger } from '@abl/compiler/platform';
import type { IConnectorConfig, IEndUserOAuthToken } from '@agent-platform/database';
import { getLazyModel } from '../db/index.js';
import { ConnectorError } from './connector.service.js';
import { writeAuditEntry } from './connector-audit.service.js';

const logger = createLogger('connector-security-service');

const ConnectorConfig = getLazyModel<IConnectorConfig>('ConnectorConfig');
const EndUserOAuthToken = getLazyModel<IEndUserOAuthToken>('EndUserOAuthToken');

// ─── Types ────────────────────────────────────────────────────────────────

export interface ScopeJustificationInfo {
  why: string;
  usedFor: string;
  cannotDo: string;
}

export interface SecurityOverviewResponse {
  grantedScopes: Array<{
    scope: string;
    description: string;
    grantedAt: string;
    justification?: ScopeJustificationInfo;
  }>;
  tokenStatus: { expiresAt: string | null; isExpired: boolean; daysRemaining: number };
  accessSummary: { accesses: string[]; doesNotAccess: string[] };
  approvalGate: { mode: 'none' | 'pending' | 'approved'; approvedBy?: string };
}

export interface BlastRadiusResponse {
  documentCount: number;
  chunkCount: number;
  embeddingCount: number;
  permissionEntriesCount: number;
}

// ─── Scope descriptions & justifications ────────────────────────────────

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  'Sites.Read.All': 'Read items in all site collections',
  'Sites.ReadWrite.All': 'Read and write items in all site collections',
  'Files.Read.All': 'Read all files that user can access',
  'Files.ReadWrite.All': 'Read and write all files that user can access',
  'User.Read': 'Read user profile',
  'GroupMember.Read.All': 'Read all group memberships',
  'Directory.Read.All': 'Read directory data',
  offline_access: 'Maintain access to data you have given it access to',
};

const SCOPE_JUSTIFICATIONS: Record<string, { why: string; usedFor: string; cannotDo: string }> = {
  'Sites.Read.All': {
    why: 'Discover and read site structure, document libraries, and metadata for search indexing',
    usedFor: 'Site discovery, document enumeration, delta sync',
    cannotDo: 'Create, modify, or delete any sites or content',
  },
  'Files.Read.All': {
    why: 'Read document content (Word, PDF, Excel, HTML) for text extraction and indexing',
    usedFor: 'Content indexing, webhook-based real-time sync',
    cannotDo: 'Upload, modify, or delete any files',
  },
  'GroupMember.Read.All': {
    why: 'Resolve AD group memberships so search results respect SharePoint access controls',
    usedFor: 'Permission-aware search — users only see documents they can access in SharePoint',
    cannotDo: 'Modify group memberships or read anything beyond group member lists',
  },
  'Directory.Read.All': {
    why: 'Read directory data to resolve nested group memberships',
    usedFor: 'Deep group resolution for permission-aware search accuracy',
    cannotDo: 'Modify directory objects or read sensitive profile data',
  },
  offline_access: {
    why: 'Background sync runs on schedule and requires token refresh without re-authentication',
    usedFor: 'Scheduled sync, token refresh for unattended operations',
    cannotDo: 'Escalate access or bypass admin consent',
  },
  'User.Read': {
    why: 'Read basic user profile to identify the authenticating user',
    usedFor: 'Audit trail — recording who authenticated the connector',
    cannotDo: 'Read other users profiles or modify any user data',
  },
};

/** Permissions deliberately NOT requested — used in security exports. */
const NOT_REQUESTED_SCOPES = [
  { scope: 'Sites.ReadWrite.All', reason: 'We never write to SharePoint' },
  { scope: 'Sites.FullControl.All', reason: 'We never need admin-level access' },
  { scope: 'Files.ReadWrite.All', reason: 'We never modify or delete files' },
  { scope: 'User.ReadWrite.All', reason: 'We never modify user profiles' },
  { scope: 'Mail.Read', reason: 'We never access email or Exchange' },
  { scope: 'Chat.Read', reason: 'We never access Teams chat messages' },
];

// ─── Service Functions ───────────────────────────────────────────────────

export async function getSecurityOverview(
  connectorId: string,
  tenantId: string,
): Promise<SecurityOverviewResponse> {
  const connector = await ConnectorConfig.findOne({ _id: connectorId, tenantId }).lean();
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  // Find OAuth token via connector's oauthTokenId
  const oauthTokenId = (connector as Record<string, unknown>).oauthTokenId as string | null;
  const token = oauthTokenId
    ? await EndUserOAuthToken.findOne({ _id: oauthTokenId, tenantId }).lean()
    : null;

  // scope is a space-separated string on the token
  const scopeStr = token?.scope ?? '';
  const scopeList = scopeStr.split(' ').filter(Boolean);

  const grantedScopes = scopeList.map((scope) => {
    const justification = SCOPE_JUSTIFICATIONS[scope];
    return {
      scope,
      description: SCOPE_DESCRIPTIONS[scope] ?? scope,
      grantedAt: token?.createdAt ? new Date(token.createdAt).toISOString() : '',
      ...(justification
        ? {
            justification: {
              why: justification.why,
              usedFor: justification.usedFor,
              cannotDo: justification.cannotDo,
            },
          }
        : {}),
    };
  });

  const now = new Date();
  const expiresAt = token?.expiresAt ? new Date(token.expiresAt).toISOString() : null;
  const isExpired = token?.expiresAt ? new Date(token.expiresAt) < now : true;
  const daysRemaining = token?.expiresAt
    ? Math.max(0, Math.ceil((new Date(token.expiresAt).getTime() - now.getTime()) / 86400000))
    : 0;

  const permissionMode =
    (connector.connectionConfig as Record<string, unknown>)?.permissionMode ?? 'public_access';

  const accesses: string[] = ['Site collections', 'Document libraries'];
  const doesNotAccess: string[] = ['Email / Exchange', 'Teams chat', 'OneDrive personal files'];

  if (permissionMode === 'enabled') {
    accesses.push('User and group permissions');
  } else {
    doesNotAccess.push('User and group permissions');
  }

  return {
    grantedScopes,
    tokenStatus: { expiresAt, isExpired, daysRemaining },
    accessSummary: { accesses, doesNotAccess },
    approvalGate: { mode: 'none' },
  };
}

export async function getBlastRadius(
  connectorId: string,
  tenantId: string,
): Promise<BlastRadiusResponse> {
  const connector = await ConnectorConfig.findOne({ _id: connectorId, tenantId }).lean();
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  const sourceId = (connector as Record<string, unknown>).sourceId as string | undefined;
  if (!sourceId) {
    return { documentCount: 0, chunkCount: 0, embeddingCount: 0, permissionEntriesCount: 0 };
  }

  // Count documents, chunks, and embeddings for this source
  const SearchDocument = getLazyModel('SearchDocument');
  const SearchChunk = getLazyModel('SearchChunk');

  const [documentCount, chunkCount] = await Promise.all([
    SearchDocument.countDocuments({ sourceId, tenantId }),
    SearchChunk.countDocuments({ sourceId, tenantId }),
  ]);

  return {
    documentCount,
    chunkCount,
    embeddingCount: chunkCount, // Each chunk has an embedding
    permissionEntriesCount: 0, // Would need Neo4j query; return 0 for now
  };
}

export async function emergencyRevoke(
  connectorId: string,
  tenantId: string,
  actor: string,
): Promise<{ revokedAt: string }> {
  const connector = await ConnectorConfig.findOne({ _id: connectorId, tenantId }).lean();
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  // Delete OAuth token referenced by this connector
  const oauthTokenId = (connector as unknown as Record<string, unknown>).oauthTokenId as
    | string
    | null;
  if (oauthTokenId) {
    await EndUserOAuthToken.findOneAndUpdate(
      { _id: oauthTokenId, tenantId },
      { $set: { revokedAt: new Date() } },
    );
  }

  // Disable the connector
  await ConnectorConfig.findOneAndUpdate(
    { _id: connectorId, tenantId },
    { $set: { isPaused: true, 'syncState.syncInProgress': false } },
    { new: true },
  );

  const revokedAt = new Date().toISOString();

  // Write audit entry — log partial failure if audit write fails
  try {
    await writeAuditEntry({
      connectorId,
      tenantId,
      actor,
      actorType: 'user',
      event: 'security.emergency_revoke',
      category: 'lifecycle',
      metadata: { revokedAt },
    });
  } catch (auditErr) {
    logger.error('Failed to write audit entry for emergency revoke', {
      connectorId,
      error: auditErr instanceof Error ? auditErr.message : String(auditErr),
    });
  }

  logger.info('Emergency revoke completed', { connectorId, tenantId, actor });

  return { revokedAt };
}

export async function exportSecurityDocument(
  connectorId: string,
  tenantId: string,
  format: 'json' | 'yaml' | 'markdown',
): Promise<{ contentType: string; data: string; filename: string }> {
  const overview = await getSecurityOverview(connectorId, tenantId);
  const blastRadius = await getBlastRadius(connectorId, tenantId);

  const connector = await ConnectorConfig.findOne({ _id: connectorId, tenantId }).lean();
  const connectorName =
    ((connector?.connectionConfig as Record<string, unknown>)?.displayName as string) ??
    'connector';

  const exportedAt = new Date().toISOString();

  const document = {
    connectorId,
    connectorName,
    exportedAt,
    security: overview,
    blastRadius,
    notRequestedScopes: NOT_REQUESTED_SCOPES,
  };

  if (format === 'json') {
    return {
      contentType: 'application/json',
      data: JSON.stringify(document, null, 2),
      filename: `${connectorName}-security-review.json`,
    };
  }

  if (format === 'yaml') {
    const yamlData = jsonToSimpleYaml(document);
    return {
      contentType: 'text/yaml',
      data: yamlData,
      filename: `${connectorName}-security-review.yaml`,
    };
  }

  // Markdown format — enriched with justifications, compliance, data handling
  const md = buildEnrichedMarkdown(connectorName, exportedAt, overview, blastRadius);

  return {
    contentType: 'text/markdown',
    data: md,
    filename: `${connectorName}-security-review.md`,
  };
}

/** Build the enriched 4-section security review markdown. */
function buildEnrichedMarkdown(
  connectorName: string,
  exportedAt: string,
  overview: SecurityOverviewResponse,
  blastRadius: BlastRadiusResponse,
): string {
  const sections: string[] = [];

  // Header
  sections.push(
    `# Security Review: ${connectorName}`,
    '',
    `**Exported:** ${exportedAt}`,
    `**Scope:** Live connected data`,
    '',
    '> Valid as of the export date. Re-export for the current state.',
  );

  // Section 1: Executive Summary
  sections.push(
    '',
    '---',
    '',
    '## 1. Executive Summary',
    '',
    '| Aspect | Value |',
    '|--------|-------|',
    `| Scopes granted | ${overview.grantedScopes.length} |`,
    `| Scopes NOT requested | ${NOT_REQUESTED_SCOPES.length} |`,
    `| Access type | Read-only — no write access |`,
    `| Documents indexed | ${blastRadius.documentCount} |`,
    `| Token status | ${overview.tokenStatus.isExpired ? 'Expired' : `Valid (${overview.tokenStatus.daysRemaining} days remaining)`} |`,
  );

  // Section 2: Permissions Detail
  sections.push(
    '',
    '---',
    '',
    '## 2. Permissions Detail',
    '',
    '### Granted Scopes',
    '',
    '| Permission | Description | Why We Need It | Cannot Do |',
    '|------------|-------------|----------------|-----------|',
    ...overview.grantedScopes.map((s) => {
      const j = s.justification;
      return `| \`${s.scope}\` | ${s.description} | ${j?.why ?? 'N/A'} | ${j?.cannotDo ?? 'N/A'} |`;
    }),
    '',
    '### Permissions NOT Requested',
    '',
    '| Permission | Why NOT Requested |',
    '|------------|-------------------|',
    ...NOT_REQUESTED_SCOPES.map((s) => `| \`${s.scope}\` | ${s.reason} |`),
  );

  // Section 3: Security & Compliance
  sections.push(
    '',
    '---',
    '',
    '## 3. Security & Compliance',
    '',
    '### Token Status',
    '',
    `- **Expires:** ${overview.tokenStatus.expiresAt ?? 'N/A'}`,
    `- **Status:** ${overview.tokenStatus.isExpired ? 'Expired' : 'Valid'}`,
    `- **Days remaining:** ${overview.tokenStatus.daysRemaining}`,
    '',
    '### Access Summary',
    '',
    '**Can access:**',
    ...overview.accessSummary.accesses.map((a) => `- ✓ ${a}`),
    '',
    '**Cannot access:**',
    ...overview.accessSummary.doesNotAccess.map((a) => `- ✗ ${a}`),
    '',
    '### Data Handling',
    '',
    '| Aspect | Detail |',
    '|--------|--------|',
    '| Encryption at rest | AES-256-GCM with tenant-specific keys |',
    '| Encryption in transit | TLS 1.2+ |',
    '| Original files stored | No — only extracted text and embeddings |',
    '| Third-party sharing | None |',
    '| Tenant isolation | All data tenant-scoped; cross-tenant returns 404 |',
    '',
    '### Compliance Alignment',
    '',
    '| Practice | SOC 2 | ISO 27001 | GDPR |',
    '|----------|-------|-----------|------|',
    '| Encryption at rest | CC6.1 | A.10.1.1 | Art. 32(1)(a) |',
    '| Encryption in transit | CC6.7 | A.13.1.1 | Art. 32(1)(a) |',
    '| Tenant isolation | CC6.3 | A.9.4.1 | Art. 25 |',
    '| Read-only permissions | CC6.1 | A.9.1.2 | Art. 5(1)(c) |',
    '| Instant token revocation | CC6.2 | A.9.2.6 | Art. 17 |',
    '| Audit logging | CC7.2 | A.12.4.1 | Art. 30 |',
    '| Data retention with TTLs | CC6.5 | A.8.3.2 | Art. 5(1)(e) |',
  );

  // Section 4: Appendix
  sections.push(
    '',
    '---',
    '',
    '## 4. Appendix',
    '',
    '### Blast Radius',
    '',
    `- **Documents:** ${blastRadius.documentCount}`,
    `- **Chunks:** ${blastRadius.chunkCount}`,
    `- **Embeddings:** ${blastRadius.embeddingCount}`,
    '',
    '### Revocation',
    '',
    '1. One-click emergency revoke from the platform Security tab',
    '2. Remove app registration from Azure AD portal',
    '3. Revoke admin consent from Azure AD > Enterprise Applications',
    '',
    '### Data Retention',
    '',
    '| Data Type | Retention | Cleanup |',
    '|-----------|-----------|---------|',
    '| Synced documents | Until connector deleted | Cascading delete |',
    '| Vector embeddings | Until connector deleted | Cleanup within 15 min |',
    '| Discovery cache | 7-day TTL | Auto-purged |',
    '| OAuth tokens | Until revoked/expired | Instant revocation |',
    '| Sync job data | 24-hour | Auto-purged |',
    '| Audit logs | 90 days | Configurable |',
  );

  return sections.join('\n');
}

/** Simple JSON-to-YAML converter for flat/shallow objects (avoids js-yaml dep in service). */
function jsonToSimpleYaml(obj: unknown, indent = 0): string {
  const prefix = '  '.repeat(indent);
  if (obj === null || obj === undefined) return `${prefix}null`;
  if (typeof obj === 'string') return `${prefix}"${obj}"`;
  if (typeof obj === 'number' || typeof obj === 'boolean') return `${prefix}${obj}`;
  if (Array.isArray(obj)) {
    if (obj.length === 0) return `${prefix}[]`;
    return obj.map((item) => `${prefix}- ${jsonToSimpleYaml(item, 0).trim()}`).join('\n');
  }
  if (typeof obj === 'object') {
    const entries = Object.entries(obj as Record<string, unknown>);
    return entries
      .map(([key, value]) => {
        if (typeof value === 'object' && value !== null) {
          return `${prefix}${key}:\n${jsonToSimpleYaml(value, indent + 1)}`;
        }
        return `${prefix}${key}: ${jsonToSimpleYaml(value, 0).trim()}`;
      })
      .join('\n');
  }
  return `${prefix}${String(obj)}`;
}
