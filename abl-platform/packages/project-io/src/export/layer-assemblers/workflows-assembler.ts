import type { LayerAssembler, LayerQueryContext } from './types.js';
import type { LayerAssemblyResult } from '../../types.js';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { Workflow } from '@agent-platform/database';
import {
  AuthProfile,
  WorkflowVersion,
  Deployment,
  TriggerRegistration,
} from '@agent-platform/database/models';
import { sanitizeName, stripInternalFields } from './assembler-utils.js';
import { assignCollisionSafePath } from '../folder-builder.js';

const log = createLogger('workflows-assembler');

type WorkflowTriggerExport = {
  id: string;
  triggerName: string;
  type: string;
  status?: string;
  config: Record<string, unknown>;
  authProfileName?: string;
  webhookMode?: string;
  webhookDelivery?: string;
  cronExpression?: string;
  pollingIntervalMs?: number;
  environment?: string | null;
};

export class WorkflowsAssembler implements LayerAssembler {
  readonly layer = 'workflows' as const;

  async assemble(ctx: LayerQueryContext): Promise<LayerAssemblyResult> {
    const { projectId, tenantId } = ctx;
    const files = new Map<string, string>();
    const warnings: string[] = [];
    let entityCount = 0;

    const workflows = await Workflow.find({ projectId, tenantId })
      .lean()
      .select('name type description tags metadata');

    // Build name→id lookup for version resolution
    const nameToId = new Map<string, string>();
    const workflowExportPathNameById = new Map<string, string>();

    for (const workflow of workflows) {
      const record = workflow as Record<string, unknown>;
      const workflowId = String(record._id);
      const name = sanitizeName(record.name as string);
      nameToId.set(record.name as string, workflowId);
      const clean = stripInternalFields(record, [
        '_v',
        'archivedAt',
        // Strip legacy fields that now live on versions
        'steps',
        'triggers',
        'status',
        'nodes',
        'edges',
        'envVars',
        'inputSchema',
        'outputSchema',
        'deployment',
      ]);
      clean._exportedId = workflowId;
      const path = assignCollisionSafePath(`workflows/${name}.workflow.json`, files);
      workflowExportPathNameById.set(
        workflowId,
        path.slice('workflows/'.length, -'.workflow.json'.length),
      );
      files.set(path, JSON.stringify(clean, null, 2));
      entityCount++;
    }

    // Always export all versions (draft + published)
    await this.assembleAllVersions(
      projectId,
      tenantId,
      nameToId,
      workflowExportPathNameById,
      files,
      warnings,
    );

    // Additionally export deployment-pinned versions when deployments are included
    // (ensures pinned versions from other projects or stale references are captured)
    if (ctx.includeDeployments) {
      await this.assembleDeploymentPinnedVersions(
        projectId,
        tenantId,
        nameToId,
        workflowExportPathNameById,
        files,
        warnings,
      );
    }

    log.info('Workflows layer assembled', { projectId, workflows: workflows.length });
    return { layer: 'workflows', files, entityCount, warnings };
  }

  /**
   * Export ALL workflow versions (draft + published) for every workflow.
   * In the version-first model, versions are the primary data.
   */
  private async assembleAllVersions(
    projectId: string,
    tenantId: string,
    nameToId: Map<string, string>,
    workflowExportPathNameById: Map<string, string>,
    files: Map<string, string>,
    warnings: string[],
  ): Promise<void> {
    const workflowIds = Array.from(nameToId.values());
    if (workflowIds.length === 0) return;

    const versions = await WorkflowVersion.find({
      workflowId: { $in: workflowIds },
      tenantId,
      projectId,
      deleted: { $ne: true },
    }).lean();
    const triggersByVersionId = await this.loadTriggersByVersionId(
      projectId,
      tenantId,
      workflowIds,
      versions as Array<Record<string, unknown>>,
    );

    // Build workflowId→name reverse lookup
    const idToName = new Map<string, string>();
    for (const [name, id] of nameToId) {
      idToName.set(id, name);
    }

    for (const version of versions) {
      const record = version as Record<string, unknown>;
      const workflowName = idToName.get(record.workflowId as string);
      if (!workflowName) continue;

      const safeName =
        workflowExportPathNameById.get(record.workflowId as string) ?? sanitizeName(workflowName);
      const safeVersion = (record.version as string).replace(/[^a-zA-Z0-9._-]/g, '_');
      const basePath = `workflows/versions/${safeName}/${safeVersion}.version.json`;

      const path = assignCollisionSafePath(basePath, files);

      const versionFile: Record<string, unknown> = {
        version: record.version,
        state: record.state,
        environment: record.environment ?? null,
        source_hash: record.sourceHash,
        changelog: record.changelog ?? null,
        triggers: triggersByVersionId.get(String(record._id)) ?? record.triggers ?? [],
        created_by: record.createdBy,
        created_at: record.createdAt,
        published_at: record.publishedAt ?? null,
        definition: record.definition,
      };

      files.set(path, JSON.stringify(versionFile, null, 2));
    }

    if (versions.length === 0 && workflowIds.length > 0) {
      warnings.push(
        'No workflow versions found — workflows may lack draft versions (pre-migration)',
      );
    }
  }

  /**
   * Collect all pinned workflow versions referenced in deployment manifests
   * and emit them as `workflows/versions/{name}/{version}.version.json`.
   */
  private async assembleDeploymentPinnedVersions(
    projectId: string,
    tenantId: string,
    nameToId: Map<string, string>,
    workflowExportPathNameById: Map<string, string>,
    files: Map<string, string>,
    warnings: string[],
  ): Promise<void> {
    const deployments = await Deployment.find({ projectId, tenantId }).lean();

    // Collect unique (workflowName, version) pairs across all deployments
    const pinnedPairs = new Map<string, Set<string>>();
    for (const deployment of deployments) {
      const manifest = (deployment as Record<string, unknown>).workflowVersionManifest as
        | Record<string, string>
        | undefined;
      if (!manifest) continue;

      for (const [workflowName, version] of Object.entries(manifest)) {
        if (!version) continue;
        const existing = pinnedPairs.get(workflowName) ?? new Set<string>();
        existing.add(version);
        pinnedPairs.set(workflowName, existing);
      }
    }

    if (pinnedPairs.size === 0) return;

    // Collect all workflowIds we need to query
    const workflowIds: string[] = [];
    for (const workflowName of pinnedPairs.keys()) {
      const id = nameToId.get(workflowName);
      if (id) {
        workflowIds.push(id);
      } else {
        warnings.push(`Workflow "${workflowName}" referenced in deployment manifest not found`);
      }
    }

    if (workflowIds.length === 0) return;

    // Load all versions for referenced workflows
    const versions = await WorkflowVersion.find({
      workflowId: { $in: workflowIds },
      tenantId,
      projectId,
    }).lean();
    const triggersByVersionId = await this.loadTriggersByVersionId(
      projectId,
      tenantId,
      workflowIds,
      versions as Array<Record<string, unknown>>,
    );

    // Build workflowId→name reverse lookup
    const idToName = new Map<string, string>();
    for (const [name, id] of nameToId) {
      idToName.set(id, name);
    }

    // Emit version files for pinned versions only
    for (const version of versions) {
      const record = version as Record<string, unknown>;
      const workflowName = idToName.get(record.workflowId as string);
      if (!workflowName) continue;

      const pinnedVersions = pinnedPairs.get(workflowName);
      if (!pinnedVersions?.has(record.version as string)) continue;

      const safeName =
        workflowExportPathNameById.get(record.workflowId as string) ?? sanitizeName(workflowName);
      const safeVersion = (record.version as string).replace(/[^a-zA-Z0-9._-]/g, '_');
      const basePath = `workflows/versions/${safeName}/${safeVersion}.version.json`;
      if (files.has(basePath)) {
        continue;
      }
      const path = assignCollisionSafePath(basePath, files);

      const versionFile = {
        version: record.version,
        state: record.state,
        environment: record.environment ?? null,
        source_hash: record.sourceHash,
        changelog: record.changelog ?? null,
        triggers: triggersByVersionId.get(String(record._id)) ?? record.triggers ?? [],
        created_by: record.createdBy,
        created_at: record.createdAt,
        published_at: record.publishedAt ?? null,
        definition: record.definition,
      };

      files.set(path, JSON.stringify(versionFile, null, 2));
    }

    // Warn for pinned versions not found in database
    for (const [workflowName, pinnedVersionSet] of pinnedPairs) {
      const workflowId = nameToId.get(workflowName);
      if (!workflowId) continue;
      for (const pinnedVersion of pinnedVersionSet) {
        const found = versions.some(
          (v: Record<string, unknown>) =>
            v.workflowId === workflowId && v.version === pinnedVersion,
        );
        if (!found) {
          warnings.push(
            `Workflow "${workflowName}" version "${pinnedVersion}" referenced in deployment manifest not found`,
          );
        }
      }
    }
  }

  private async loadTriggersByVersionId(
    projectId: string,
    tenantId: string,
    workflowIds: string[],
    versions: Array<Record<string, unknown>>,
  ): Promise<Map<string, WorkflowTriggerExport[]>> {
    if (workflowIds.length === 0) {
      return new Map();
    }

    const registrations = await TriggerRegistration.find({
      tenantId,
      projectId,
      workflowId: { $in: workflowIds },
      status: { $ne: 'deleted' },
    }).lean();
    const authProfileIds = [
      ...new Set(
        (registrations as Array<Record<string, unknown>>)
          .map((record) =>
            typeof record.authProfileId === 'string' && record.authProfileId.length > 0
              ? record.authProfileId
              : null,
          )
          .filter((authProfileId): authProfileId is string => authProfileId !== null),
      ),
    ];
    const authProfiles =
      authProfileIds.length > 0
        ? await AuthProfile.find({ tenantId, _id: { $in: authProfileIds } })
            .lean()
            .select('name')
        : [];
    const authProfileNameById = new Map(
      (authProfiles as Array<Record<string, unknown>>)
        .filter((profile) => typeof profile._id === 'string' && typeof profile.name === 'string')
        .map((profile) => [String(profile._id), String(profile.name)]),
    );
    const byVersionId = new Map<string, WorkflowTriggerExport[]>();
    const versionIdByWorkflowAndVersion = new Map<string, string>();
    const draftVersionIdByWorkflow = new Map<string, string>();

    for (const version of versions) {
      const workflowId = typeof version.workflowId === 'string' ? version.workflowId : null;
      const versionName = typeof version.version === 'string' ? version.version : null;
      const versionId = typeof version._id === 'string' ? version._id : null;
      if (!workflowId || !versionName || !versionId) {
        continue;
      }
      versionIdByWorkflowAndVersion.set(`${workflowId}:${versionName}`, versionId);
      if (versionName === 'draft') {
        draftVersionIdByWorkflow.set(workflowId, versionId);
      }
    }

    for (const registration of registrations) {
      const record = registration as Record<string, unknown>;
      const workflowVersionId =
        typeof record.workflowVersionId === 'string' ? record.workflowVersionId : null;
      const workflowId = typeof record.workflowId === 'string' ? record.workflowId : null;
      const workflowVersion =
        typeof record.workflowVersion === 'string' ? record.workflowVersion : null;
      const resolvedWorkflowVersionId =
        workflowVersionId ??
        (workflowId && workflowVersion
          ? versionIdByWorkflowAndVersion.get(`${workflowId}:${workflowVersion}`)
          : undefined) ??
        (workflowId ? draftVersionIdByWorkflow.get(workflowId) : undefined);
      if (!resolvedWorkflowVersionId) {
        continue;
      }

      const authProfileName =
        typeof record.authProfileId === 'string'
          ? authProfileNameById.get(record.authProfileId)
          : undefined;
      const exported: WorkflowTriggerExport = {
        id: String(record._id),
        triggerName:
          typeof record.triggerName === 'string' ? record.triggerName : String(record.triggerType),
        type: typeof record.triggerType === 'string' ? record.triggerType : 'webhook',
        ...(typeof record.status === 'string' ? { status: record.status } : {}),
        config:
          record.config && typeof record.config === 'object' && !Array.isArray(record.config)
            ? (record.config as Record<string, unknown>)
            : {},
        ...(authProfileName ? { authProfileName } : {}),
        ...(typeof record.webhookMode === 'string' ? { webhookMode: record.webhookMode } : {}),
        ...(typeof record.webhookDelivery === 'string'
          ? { webhookDelivery: record.webhookDelivery }
          : {}),
        ...(typeof record.cronExpression === 'string'
          ? { cronExpression: record.cronExpression }
          : {}),
        ...(typeof record.pollingIntervalMs === 'number'
          ? { pollingIntervalMs: record.pollingIntervalMs }
          : {}),
        ...(typeof record.environment === 'string' || record.environment === null
          ? { environment: record.environment as string | null }
          : {}),
      };
      const existing = byVersionId.get(resolvedWorkflowVersionId) ?? [];
      existing.push(exported);
      byVersionId.set(resolvedWorkflowVersionId, existing);
    }

    return byVersionId;
  }

  async countEntities(ctx: LayerQueryContext): Promise<number> {
    return Workflow.countDocuments({
      projectId: ctx.projectId,
      tenantId: ctx.tenantId,
    });
  }
}
