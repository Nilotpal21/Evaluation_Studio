/**
 * ConnectionsDisassembler — converts exported connection layer files back into StagedRecords.
 *
 * Handles: connector connections and connector configs.
 * Resolves auth profile names to IDs using ctx.authProfileMapping.
 * Strips REDACTED placeholder values from credential fields.
 *
 * Pure function — no DB access. All ownership fields injected from server context.
 */

import type { LayerDisassembler, DisassembleContext, DisassembleResult } from './types.js';
import type { StagedRecord, SupersededRecord } from '../staged-importer.js';
import {
  safeParseJSON,
  injectOwnership,
  buildRecord,
  buildSuperseded,
  buildMatchingSuperseded,
  stripRedactedValues,
  extractNameFromPath,
} from './disassembler-utils.js';

/** Check if a record with matching field value exists in the existing record list. */
function existsInExisting(
  existing: Array<{ _id: string; [key: string]: unknown }> | undefined,
  matchField: string,
  matchValue: string,
): boolean {
  if (!existing) return false;
  return existing.some((r) => r[matchField] === matchValue);
}

/** Runtime fields that should not be imported into connector configs. */
const CONNECTOR_CONFIG_STRIP_FIELDS = ['oauthTokenId', 'syncState', 'errorState'];

export class ConnectionsDisassembler implements LayerDisassembler {
  readonly layer = 'connections' as const;

  async disassemble(ctx: DisassembleContext): Promise<DisassembleResult> {
    const records: StagedRecord[] = [];
    const superseded: SupersededRecord[] = [];
    const warnings: string[] = [];

    const existingConnections = ctx.existingRecordIds?.get('connector_connections');
    const existingConfigs = ctx.existingRecordIds?.get('connector_configs');

    // Track whether we have auth profile mapping available
    const hasAuthMapping =
      ctx.authProfileMapping !== undefined && Object.keys(ctx.authProfileMapping).length > 0;

    // --- Phase 1 & 2: Parse connection files and resolve auth profiles ---
    for (const [filePath, content] of ctx.files) {
      // --- Connector Connections ---
      if (filePath.match(/^connections\/connectors\/[^/]+\.connection\.json$/)) {
        const parsed = safeParseJSON(filePath, content, warnings);
        if (!parsed) continue;

        // Skip if conflict strategy is 'skip' and a matching connection already exists
        const connDisplayName = parsed.displayName as string | undefined;
        const connConnectorName = parsed.connectorName as string | undefined;
        if (ctx.conflictStrategy === 'skip') {
          if (
            (connDisplayName &&
              existsInExisting(existingConnections, 'displayName', connDisplayName)) ||
            (connConnectorName &&
              existsInExisting(existingConnections, 'connectorName', connConnectorName))
          ) {
            continue;
          }
        }

        // Strip REDACTED values from any config sub-objects
        const cleaned = stripRedactedValues(parsed);

        // Resolve auth profile name to ID
        const authProfileName = cleaned.authProfileName as string | undefined;
        if (authProfileName) {
          if (hasAuthMapping && ctx.authProfileMapping) {
            const mappedId = ctx.authProfileMapping[authProfileName];
            if (mappedId) {
              cleaned.authProfileId = mappedId;
              delete cleaned.authProfileName;
            } else {
              const connName =
                (cleaned.displayName as string) ||
                (cleaned.connectorName as string) ||
                extractNameFromPath(filePath, '.connection.json') ||
                'unknown';
              warnings.push(
                `Connection '${connName}' references auth profile '${authProfileName}' ` +
                  'which could not be resolved in the target tenant',
              );
            }
          } else if (!hasAuthMapping) {
            // Only warn once about missing mapping; individual connection warnings are redundant
          }
        }

        const data = injectOwnership(cleaned, ctx);
        records.push(buildRecord('connections', 'connector_connections', data));
        continue;
      }

      // --- Connector Configs ---
      if (filePath.match(/^connections\/configs\/[^/]+\.connector-config\.json$/)) {
        const parsed = safeParseJSON(filePath, content, warnings);
        if (!parsed) continue;

        // Skip if conflict strategy is 'skip' and a matching config already exists
        const configConnectorType = parsed.connectorType as string | undefined;
        if (
          ctx.conflictStrategy === 'skip' &&
          configConnectorType &&
          existsInExisting(existingConfigs, 'connectorType', configConnectorType)
        ) {
          continue;
        }

        // Strip runtime fields
        for (const field of CONNECTOR_CONFIG_STRIP_FIELDS) {
          delete parsed[field];
        }
        if (typeof parsed.sourceId === 'string') {
          parsed._connectorConfigSourceId = parsed.sourceId;
        }

        const data = injectOwnership(parsed, ctx);
        records.push(buildRecord('connections', 'connector_configs', data));
        continue;
      }
    }

    // Emit a single warning if no auth profile mapping was provided and connections reference profiles
    if (!hasAuthMapping) {
      const connectionsWithProfiles = [...ctx.files.entries()].some(([filePath, content]) => {
        if (!filePath.match(/^connections\/connectors\/[^/]+\.connection\.json$/)) return false;
        try {
          const parsed = JSON.parse(content);
          return !!parsed.authProfileName;
        } catch {
          return false;
        }
      });
      if (connectionsWithProfiles) {
        warnings.push(
          'No auth profile mapping provided — connections will be imported without auth profile references',
        );
      }
    }

    // --- Build superseded records for replacement strategies ---
    if (ctx.conflictStrategy === 'replace') {
      superseded.push(
        ...buildSuperseded('connections', 'connector_connections', existingConnections),
      );
      superseded.push(...buildSuperseded('connections', 'connector_configs', existingConfigs));
    } else if (ctx.conflictStrategy === 'merge') {
      const connectionSuperseded = [
        ...buildMatchingSuperseded(
          'connections',
          'connector_connections',
          existingConnections,
          records.filter((record) => record.collection === 'connector_connections'),
          'displayName',
        ),
        ...buildMatchingSuperseded(
          'connections',
          'connector_connections',
          existingConnections,
          records.filter((record) => record.collection === 'connector_connections'),
          'connectorName',
        ),
      ];
      const dedupedConnectionSuperseded = new Map(
        connectionSuperseded.map((record) => [record.recordId, record]),
      );
      superseded.push(...dedupedConnectionSuperseded.values());
      superseded.push(
        ...buildMatchingSuperseded(
          'connections',
          'connector_configs',
          existingConfigs,
          records.filter((record) => record.collection === 'connector_configs'),
          'connectorType',
        ),
      );
    }

    return { records, superseded, warnings };
  }
}
