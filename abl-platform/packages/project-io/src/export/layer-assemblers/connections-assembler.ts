import type { LayerAssembler, LayerQueryContext } from './types.js';
import type { LayerAssemblyResult } from '../../types.js';
import { createLogger } from '@abl/compiler/platform/logger.js';
import {
  ConnectorConnection,
  ConnectorConfig,
  SearchIndex,
  SearchSource,
} from '@agent-platform/database';
import { sanitizeName, stripInternalFields } from './assembler-utils.js';
import { assignCollisionSafePath } from '../folder-builder.js';

const log = createLogger('connections-assembler');

const CONNECTION_SECRET_KEYS = [
  'encryptedCredentials',
  'encryptionKeyVersion',
  'oauth2RefreshToken',
];

/** Auth profile metadata collected during export (secrets stripped) */
export interface ExportedAuthProfileRef {
  name: string;
  authType: string;
  scope: 'tenant' | 'project';
  connector?: string;
  category?: string;
  connectionMode?: 'shared' | 'per_user';
  config: Record<string, unknown>;
  referencedBy: string[];
}

/**
 * Extract auth profile requirement metadata from connections.
 * Strips secrets — only config shape and type info are exported.
 */
export function extractAuthProfileRequirementsFromConnections(
  connections: Array<Record<string, unknown>>,
): ExportedAuthProfileRef[] {
  const profileMap = new Map<string, ExportedAuthProfileRef>();

  for (const conn of connections) {
    const authProfileId = conn.authProfileId as string | undefined;
    const authProfileName = conn.authProfileName as string | undefined;
    if (!authProfileId && !authProfileName) continue;

    const profileKey = authProfileName ?? authProfileId ?? '';
    const connectorName =
      (conn.displayName as string) || (conn.connectorName as string) || 'unknown';

    const existing = profileMap.get(profileKey);
    if (existing) {
      existing.referencedBy.push(connectorName);
    } else {
      const authProfile = conn.authProfile as Record<string, unknown> | undefined;
      profileMap.set(profileKey, {
        name: profileKey,
        authType: (authProfile?.authType as string) ?? 'unknown',
        scope: (authProfile?.scope as 'tenant' | 'project') ?? 'project',
        connector: authProfile?.connector as string | undefined,
        category: authProfile?.category as string | undefined,
        connectionMode:
          (authProfile?.connectionMode as 'shared' | 'per_user') ??
          (authProfile?.visibility === 'personal' ? 'per_user' : 'shared'),
        config: stripSecrets(authProfile?.config ?? {}),
        referencedBy: [connectorName],
      });
    }
  }

  return [...profileMap.values()];
}

/** Strip sensitive fields from config, preserving only shape info */
function stripSecrets(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== 'object') return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    // Redact anything that looks like a credential value
    const isSecret = /secret|password|token|key|credential/i.test(key) && typeof value === 'string';
    result[key] = isSecret ? '***REDACTED***' : value;
  }
  return result;
}

export class ConnectionsAssembler implements LayerAssembler {
  readonly layer = 'connections' as const;

  /** Auth profile refs collected during the last assemble() call */
  public lastAuthProfileRefs: ExportedAuthProfileRef[] = [];

  async assemble(ctx: LayerQueryContext): Promise<LayerAssemblyResult> {
    const { projectId, tenantId } = ctx;
    const files = new Map<string, string>();
    const warnings: string[] = [];
    let entityCount = 0;

    const connectionsPromise = ConnectorConnection.find({ projectId, tenantId }).lean();
    const sourceIdsPromise = this.findProjectSearchSourceIds(projectId, tenantId);
    const [connections, sourceIds] = await Promise.all([connectionsPromise, sourceIdsPromise]);
    const configs =
      sourceIds.length > 0
        ? await ConnectorConfig.find({ tenantId, sourceId: { $in: sourceIds } }).lean()
        : [];

    // Collect auth profile requirements before stripping
    this.lastAuthProfileRefs = extractAuthProfileRequirementsFromConnections(
      connections as Array<Record<string, unknown>>,
    );

    for (const conn of connections) {
      const name = sanitizeName(
        ((conn as Record<string, unknown>).displayName as string) ||
          ((conn as Record<string, unknown>).connectorName as string),
      );
      const clean = stripInternalFields(conn as Record<string, unknown>, [
        ...CONNECTION_SECRET_KEYS,
        'authProfileId', // Never export raw IDs — use authProfileName instead
      ]);
      const path = assignCollisionSafePath(`connections/connectors/${name}.connection.json`, files);
      files.set(path, JSON.stringify(clean, null, 2));
      entityCount++;
    }

    for (const config of configs) {
      const name = sanitizeName((config as Record<string, unknown>).connectorType as string);
      const clean = stripInternalFields(config as Record<string, unknown>, [
        'oauthTokenId',
        'syncState',
        'errorState',
      ]);
      const path = assignCollisionSafePath(
        `connections/configs/${name}.connector-config.json`,
        files,
      );
      files.set(path, JSON.stringify(clean, null, 2));
      entityCount++;
    }

    log.info('Connections layer assembled', {
      projectId,
      connections: connections.length,
      configs: configs.length,
      authProfiles: this.lastAuthProfileRefs.length,
    });
    return { layer: 'connections', files, entityCount, warnings };
  }

  async countEntities(ctx: LayerQueryContext): Promise<number> {
    const sourceIds = await this.findProjectSearchSourceIds(ctx.projectId, ctx.tenantId);
    const [connCount, configCount] = await Promise.all([
      ConnectorConnection.countDocuments({
        projectId: ctx.projectId,
        tenantId: ctx.tenantId,
      }),
      sourceIds.length > 0
        ? ConnectorConfig.countDocuments({ tenantId: ctx.tenantId, sourceId: { $in: sourceIds } })
        : Promise.resolve(0),
    ]);
    return connCount + configCount;
  }

  private async findProjectSearchSourceIds(projectId: string, tenantId: string): Promise<string[]> {
    const indexes = await SearchIndex.find({ projectId, tenantId }).lean().select('_id');
    const indexIds = indexes.map((index: Record<string, unknown>) => String(index._id));
    if (indexIds.length === 0) {
      return [];
    }

    const sources = await SearchSource.find({ tenantId, indexId: { $in: indexIds } })
      .lean()
      .select('_id');
    return sources.map((source: Record<string, unknown>) => String(source._id));
  }
}
