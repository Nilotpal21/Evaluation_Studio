import type { LayerAssembler, LayerQueryContext } from './types.js';
import type { LayerAssemblyResult } from '../../types.js';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { GuardrailPolicy, ProjectAgent } from '@agent-platform/database';
import { sanitizeName, stripInternalFields } from './assembler-utils.js';
import { guardrailArchivePath, serializeGuardrailArchive } from '../../guardrail-projection.js';
import { assignCollisionSafePath } from '../folder-builder.js';

const log = createLogger('guardrails-assembler');

function sanitizeProviderOverridesForExport(overrides: unknown): unknown {
  if (!Array.isArray(overrides)) {
    return overrides;
  }

  return overrides.map((override) => {
    if (!override || typeof override !== 'object' || Array.isArray(override)) {
      return override;
    }

    const sanitized = { ...(override as Record<string, unknown>) };
    delete sanitized.apiKeyCredentialId;
    delete sanitized.authProfileId;
    return sanitized;
  });
}

export class GuardrailsAssembler implements LayerAssembler {
  readonly layer = 'guardrails' as const;

  async assemble(ctx: LayerQueryContext): Promise<LayerAssemblyResult> {
    const { projectId, tenantId } = ctx;
    const files = new Map<string, string>();
    const warnings: string[] = [];
    let entityCount = 0;
    const guardrailFormat = ctx.guardrailFormat ?? 'json';

    const policies = await GuardrailPolicy.find({
      tenantId,
      $or: [
        { 'scope.type': 'project', 'scope.projectId': projectId },
        { 'scope.type': 'agent', 'scope.projectId': projectId },
      ],
    }).lean();

    const policyRecords = policies as Array<Record<string, unknown>>;

    const agentScopedPolicies = policyRecords.filter((policyRecord) => {
      const scope = policyRecord.scope;
      return (
        scope &&
        typeof scope === 'object' &&
        !Array.isArray(scope) &&
        (scope as Record<string, unknown>).type === 'agent' &&
        typeof (scope as Record<string, unknown>).agentDefId === 'string'
      );
    });

    const agentDefIds = Array.from(
      new Set(
        agentScopedPolicies
          .map(
            (policyRecord) =>
              ((policyRecord.scope as Record<string, unknown>).agentDefId as string) ?? '',
          )
          .filter((agentDefId: string) => agentDefId.length > 0),
      ),
    );

    const agentNameById = new Map<string, string>();
    if (agentDefIds.length > 0) {
      const agents = await ProjectAgent.find({
        tenantId,
        projectId,
        _id: { $in: agentDefIds },
      }).lean();

      for (const agent of agents) {
        const record = agent as Record<string, unknown>;
        if (typeof record._id === 'string' && typeof record.name === 'string') {
          agentNameById.set(record._id, record.name);
        }
      }
    }

    for (const record of policyRecords) {
      const name = sanitizeName(record.name as string);
      const clean = stripInternalFields(record, ['__v']);
      // Strip webhook secrets from settings
      const settings = clean.settings as Record<string, unknown> | undefined;
      if (settings) {
        delete settings.webhookSecret;
      }

      clean.providerOverrides = sanitizeProviderOverridesForExport(clean.providerOverrides);

      const scope = clean.scope as Record<string, unknown> | undefined;
      if (scope?.type === 'agent' && typeof scope.agentDefId === 'string') {
        const agentName = agentNameById.get(scope.agentDefId);
        if (agentName) {
          scope.agentName = agentName;
        } else {
          warnings.push(
            `Guardrail "${String(record.name)}" references agentDefId "${scope.agentDefId}" with no matching project agent name`,
          );
        }
      }

      const path = assignCollisionSafePath(guardrailArchivePath(name, guardrailFormat), files);
      files.set(path, serializeGuardrailArchive(clean, guardrailFormat));
      entityCount++;
    }

    log.info('Guardrails layer assembled', { projectId, policies: policies.length });
    return { layer: 'guardrails', files, entityCount, warnings };
  }

  async countEntities(ctx: LayerQueryContext): Promise<number> {
    return GuardrailPolicy.countDocuments({
      tenantId: ctx.tenantId,
      $or: [
        { 'scope.type': 'project', 'scope.projectId': ctx.projectId },
        { 'scope.type': 'agent', 'scope.projectId': ctx.projectId },
      ],
    });
  }
}
