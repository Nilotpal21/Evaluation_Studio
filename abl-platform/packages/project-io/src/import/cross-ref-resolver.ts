/**
 * Cross-Reference Resolver — Phase 2.5 of the staged import pipeline.
 *
 * After staging (all records have new _id values) but before activation
 * (records still carry import lifecycle state 'staged'), this resolver:
 *
 * 1. Builds name->newId maps for anchor collections (workflows, search_indexes,
 *    channel_connections, project_agents, eval_scenarios, eval_personas)
 * 2. Updates dependent collections' foreign keys via batched bulkWrite
 * 3. Strips all temporary _ prefixed fields from staged records
 *
 * Total round trips: ~18-20 (10 queries + 7-8 bulkWrites) vs ~850+ without batching.
 */

import { createLogger } from '@abl/compiler/platform/logger.js';
import { computeSourceHash } from '@agent-platform/shared';
import { IMPORT_LIFECYCLE_FIELD } from './staged-importer.js';

const log = createLogger('cross-ref-resolver');

const IMPORT_LIFECYCLE_STATE_PATH = `${IMPORT_LIFECYCLE_FIELD}.state`;

// ─── Types ────────────────────────────────────────────────────────────────

/**
 * Defines a cross-reference rule for resolving foreign keys between collections.
 */
export interface CrossRefRule {
  /** Collection containing the anchor record (the one being referenced) */
  anchorCollection: string;
  /** Field on the anchor record used as the join key (e.g., 'name', 'slug') */
  anchorMatchField: string;
  /** Collection containing the dependent record */
  dependentCollection: string;
  /** Temporary field on the dependent record holding the join value */
  tempJoinField: string;
  /** Field on the dependent record to set with the resolved anchor _id */
  targetForeignKey: string;
}

/**
 * Defines a cross-reference rule for array-type foreign keys (e.g., scenarioIds).
 */
export interface ArrayCrossRefRule {
  /** Collection containing the record with the array field */
  collection: string;
  /** The array field to populate with resolved IDs */
  arrayField: string;
  /** Temporary field holding the names to resolve */
  tempNamesField: string;
  /** Collection containing the anchor records */
  anchorCollection: string;
  /** Field on the anchor record used as the join key */
  anchorMatchField: string;
  /** For nested entities, compose key from parentSet + name */
  compositeKey?: boolean;
  /** Temporary field on the anchor record holding the parent reference */
  anchorParentField?: string;
}

/**
 * Database adapter interface for cross-reference resolution.
 * Decoupled from Mongoose for testability.
 */
export interface CrossRefDbAdapter {
  /**
   * Query staged records for a specific collection with a filter and projection.
   * Used to build name->newId maps for anchor collections and to find
   * dependent records with temp join fields.
   */
  queryStagedRecords(
    collection: string,
    filter: Record<string, unknown>,
    projection: Record<string, number>,
  ): Promise<Array<Record<string, unknown>>>;

  /**
   * Batch-update staged records using bulkWrite with { ordered: false }.
   * Each operation targets a specific staged record by _id.
   */
  batchUpdateStagedRecords(
    collection: string,
    operations: Array<{
      filter: Record<string, unknown>;
      update: Record<string, unknown>;
    }>,
  ): Promise<void>;
}

// ─── Cross-Reference Rules ────────────────────────────────────────────────

/**
 * Standard cross-reference rules: single foreign key resolution.
 */
export const CROSS_REF_RULES: CrossRefRule[] = [
  // workflows -> workflow_versions
  {
    anchorCollection: 'workflows',
    anchorMatchField: 'name',
    dependentCollection: 'workflow_versions',
    tempJoinField: '_workflowName',
    targetForeignKey: 'workflowId',
  },
  // search_indexes -> search_sources
  {
    anchorCollection: 'search_indexes',
    anchorMatchField: 'slug',
    dependentCollection: 'search_sources',
    tempJoinField: '_indexSlug',
    targetForeignKey: 'indexId',
  },
  // search_sources -> connector_configs
  {
    anchorCollection: 'search_sources',
    anchorMatchField: '_exportedId',
    dependentCollection: 'connector_configs',
    tempJoinField: '_connectorConfigSourceId',
    targetForeignKey: 'sourceId',
  },
  // search_indexes -> knowledge_bases
  {
    anchorCollection: 'search_indexes',
    anchorMatchField: 'slug',
    dependentCollection: 'knowledge_bases',
    tempJoinField: '_indexSlug',
    targetForeignKey: 'searchIndexId',
  },
  // channel_connections -> webhook_subscriptions
  {
    anchorCollection: 'channel_connections',
    anchorMatchField: 'displayName',
    dependentCollection: 'webhook_subscriptions',
    tempJoinField: '_channelDisplayName',
    targetForeignKey: 'channelConnectionId',
  },
  // project_agents -> channel_connections.agentId
  {
    anchorCollection: 'project_agents',
    anchorMatchField: 'name',
    dependentCollection: 'channel_connections',
    tempJoinField: '_channelAgentName',
    targetForeignKey: 'agentId',
  },
  // project_agents -> guardrail_policies.scope.agentDefId
  {
    anchorCollection: 'project_agents',
    anchorMatchField: 'name',
    dependentCollection: 'guardrail_policies',
    tempJoinField: '_guardrailAgentName',
    targetForeignKey: 'scope.agentDefId',
  },
  // knowledge_bases -> domain_vocabularies
  {
    anchorCollection: 'knowledge_bases',
    anchorMatchField: '_exportedId',
    dependentCollection: 'domain_vocabularies',
    tempJoinField: '_vocabularyKnowledgeBaseId',
    targetForeignKey: 'projectKnowledgeBaseId',
  },
  // knowledge_bases -> canonical_schemas
  {
    anchorCollection: 'knowledge_bases',
    anchorMatchField: '_exportedId',
    dependentCollection: 'canonical_schemas',
    tempJoinField: '_schemaKnowledgeBaseId',
    targetForeignKey: 'knowledgeBaseId',
  },
  // Note: eval_scenarios/eval_personas _parentSetName -> eval_set relationship is
  // handled by ARRAY_CROSS_REF_RULES (scenarioIds/personaIds) below. The EvalSet
  // model owns the relationship via arrays; scenarios/personas have no parentSetId field.
];

/**
 * Array cross-reference rules: populate array fields with resolved IDs.
 */
export const ARRAY_CROSS_REF_RULES: ArrayCrossRefRule[] = [
  {
    collection: 'eval_sets',
    arrayField: 'scenarioIds',
    tempNamesField: '_nestedScenarioNames',
    anchorCollection: 'eval_scenarios',
    anchorMatchField: 'name',
    compositeKey: true,
    anchorParentField: '_parentSetName',
  },
  {
    collection: 'eval_sets',
    arrayField: 'personaIds',
    tempNamesField: '_nestedPersonaNames',
    anchorCollection: 'eval_personas',
    anchorMatchField: 'name',
    compositeKey: true,
    anchorParentField: '_parentSetName',
  },
  // eval_evaluators -> eval_sets.evaluatorIds (evaluators are shared, not nested — no composite key)
  {
    collection: 'eval_sets',
    arrayField: 'evaluatorIds',
    tempNamesField: '_nestedEvaluatorNames',
    anchorCollection: 'eval_evaluators',
    anchorMatchField: 'name',
  },
];

// ─── Known temp fields for cleanup ────────────────────────────────────────

const KNOWN_TEMP_FIELDS = [
  '_workflowName',
  '_indexSlug',
  '_channelDisplayName',
  '_channelAgentName',
  '_guardrailAgentName',
  '_searchAiIndexExportedId',
  '_parentSetName',
  '_nestedScenarioNames',
  '_nestedPersonaNames',
  '_nestedEvaluatorNames',
  '_vocabularyKnowledgeBaseId',
  '_schemaKnowledgeBaseId',
  '_connectorConfigSourceId',
  '_exportedId',
  '_workflowVersion',
  '_workflowToolExportedWorkflowId',
  '_workflowToolExportedTriggerId',
];

// ─── Resolver ─────────────────────────────────────────────────────────────

/**
 * Resolve cross-references between staged records.
 *
 * Runs as Phase 2.5: after staging (records have new _ids) but before
 * activation (records are still marked as staged).
 *
 * @param db - Database adapter for querying and updating staged records
 * @param operationId - Import operation ID for scoping queries
 * @param stagedRecordIds - Map of collection -> array of new _ids from staging
 * @returns Count of resolved references and any warnings
 */
export async function resolveCrossReferences(
  db: CrossRefDbAdapter,
  operationId: string,
  stagedRecordIds?: Record<string, string[]>,
): Promise<{ resolved: number; warnings: string[] }> {
  let resolved = 0;
  const warnings: string[] = [];

  log.info('Starting cross-reference resolution', { operationId });

  // ── STEP 1: Build name->newId maps for anchor collections ─────────────

  const anchorMaps = new Map<string, Map<string, string>>();

  // Collect unique anchor collections
  const anchorCollections = new Set<string>();
  for (const rule of CROSS_REF_RULES) {
    anchorCollections.add(rule.anchorCollection);
  }
  for (const rule of ARRAY_CROSS_REF_RULES) {
    anchorCollections.add(rule.anchorCollection);
  }

  for (const anchorCollection of anchorCollections) {
    const ids = stagedRecordIds?.[anchorCollection];
    if (!ids || ids.length === 0) {
      anchorMaps.set(anchorCollection, new Map());
      continue;
    }

    // Find which match fields we need for this anchor collection
    const matchFields = new Set<string>();
    for (const rule of CROSS_REF_RULES) {
      if (rule.anchorCollection === anchorCollection) {
        matchFields.add(rule.anchorMatchField);
      }
    }
    for (const rule of ARRAY_CROSS_REF_RULES) {
      if (rule.anchorCollection === anchorCollection) {
        matchFields.add(rule.anchorMatchField);
        if (rule.anchorParentField) {
          matchFields.add(rule.anchorParentField);
        }
      }
    }

    // Build projection
    const projection: Record<string, number> = { _id: 1 };
    for (const field of matchFields) {
      projection[field] = 1;
    }

    const records = await db.queryStagedRecords(
      anchorCollection,
      stagedRecordFilter(ids),
      projection,
    );

    const nameMap = new Map<string, string>();
    for (const record of records) {
      const id = String(record._id);
      // For each match field, add an entry
      for (const field of matchFields) {
        const value = record[field];
        if (typeof value === 'string') {
          nameMap.set(`${field}:${value}`, id);
        }
      }
      // For composite keys (eval scenarios/personas with parent set), add composite entry
      for (const rule of ARRAY_CROSS_REF_RULES) {
        if (
          rule.anchorCollection === anchorCollection &&
          rule.compositeKey &&
          rule.anchorParentField
        ) {
          const parentValue = record[rule.anchorParentField];
          const nameValue = record[rule.anchorMatchField];
          if (typeof parentValue === 'string' && typeof nameValue === 'string') {
            nameMap.set(`composite:${parentValue}/${nameValue}`, id);
          }
        }
      }
    }

    anchorMaps.set(anchorCollection, nameMap);
  }

  // ── STEP 2: Resolve standard cross-references ────────────────────────

  for (const rule of CROSS_REF_RULES) {
    const dependentIds = stagedRecordIds?.[rule.dependentCollection];
    if (!dependentIds || dependentIds.length === 0) continue;

    const anchorMap = anchorMaps.get(rule.anchorCollection);
    if (!anchorMap || anchorMap.size === 0) {
      warnings.push(
        `No anchor records found in "${rule.anchorCollection}" for resolving "${rule.dependentCollection}.${rule.targetForeignKey}"`,
      );
      continue;
    }

    // Query dependent records for their temp join field values
    const dependentRecords = await db.queryStagedRecords(
      rule.dependentCollection,
      stagedRecordFilter(dependentIds),
      { _id: 1, [rule.tempJoinField]: 1 },
    );

    const updates: Array<{
      filter: Record<string, unknown>;
      update: Record<string, unknown>;
    }> = [];

    for (const record of dependentRecords) {
      const joinValue = record[rule.tempJoinField];
      if (typeof joinValue !== 'string') continue;

      const lookupKey = `${rule.anchorMatchField}:${joinValue}`;
      const resolvedId = anchorMap.get(lookupKey);

      if (resolvedId) {
        updates.push({
          filter: { _id: record._id },
          update: {
            $set: { [rule.targetForeignKey]: resolvedId },
            $unset: { [rule.tempJoinField]: 1 },
          },
        });
        resolved++;
      } else {
        warnings.push(
          `Cannot resolve ${rule.targetForeignKey} for "${rule.dependentCollection}" record: ` +
            `"${rule.tempJoinField}" = "${joinValue}" not found in "${rule.anchorCollection}"`,
        );
        // Still strip the temp field even if unresolved
        updates.push({
          filter: { _id: record._id },
          update: { $unset: { [rule.tempJoinField]: 1 } },
        });
      }
    }

    if (updates.length > 0) {
      await db.batchUpdateStagedRecords(rule.dependentCollection, updates);
    }
  }

  // ── STEP 3: Resolve array cross-references (eval sets) ───────────────

  for (const rule of ARRAY_CROSS_REF_RULES) {
    const collectionIds = stagedRecordIds?.[rule.collection];
    if (!collectionIds || collectionIds.length === 0) continue;

    const anchorMap = anchorMaps.get(rule.anchorCollection);
    if (!anchorMap) continue;

    // Query the collection records that have the temp names field
    const collectionRecords = await db.queryStagedRecords(
      rule.collection,
      stagedRecordFilter(collectionIds),
      { _id: 1, name: 1, [rule.tempNamesField]: 1 },
    );

    const updates: Array<{
      filter: Record<string, unknown>;
      update: Record<string, unknown>;
    }> = [];

    for (const record of collectionRecords) {
      const names = record[rule.tempNamesField];
      if (!Array.isArray(names) || names.length === 0) {
        // Strip the temp field even if empty
        updates.push({
          filter: { _id: record._id },
          update: { $unset: { [rule.tempNamesField]: 1 } },
        });
        continue;
      }

      const setName = typeof record.name === 'string' ? record.name : '';
      const resolvedIds: string[] = [];

      for (const name of names) {
        if (typeof name !== 'string') continue;

        let resolvedId: string | undefined;
        if (rule.compositeKey) {
          // Composite key: parentSetName/entityName
          resolvedId = anchorMap.get(`composite:${setName}/${name}`);
        } else {
          resolvedId = anchorMap.get(`${rule.anchorMatchField}:${name}`);
        }

        if (resolvedId) {
          resolvedIds.push(resolvedId);
          resolved++;
        } else {
          warnings.push(
            `Cannot resolve ${rule.arrayField} entry "${name}" ` +
              `for eval set "${setName}" in "${rule.anchorCollection}"`,
          );
        }
      }

      updates.push({
        filter: { _id: record._id },
        update: {
          $set: { [rule.arrayField]: resolvedIds },
          $unset: { [rule.tempNamesField]: 1 },
        },
      });
    }

    if (updates.length > 0) {
      await db.batchUpdateStagedRecords(rule.collection, updates);
    }
  }

  const searchAiToolResolution = await resolveImportedSearchAiToolBindings(
    db,
    stagedRecordIds,
    anchorMaps,
  );
  resolved += searchAiToolResolution.resolved;
  warnings.push(...searchAiToolResolution.warnings);

  const workflowTriggerResolution = await resolveImportedWorkflowTriggerBindings(
    db,
    stagedRecordIds,
  );
  resolved += workflowTriggerResolution.resolved;
  warnings.push(...workflowTriggerResolution.warnings);

  // ── STEP 4: Safety net — strip all remaining temp _ fields ────────────

  await stripRemainingTempFields(db, stagedRecordIds, warnings);

  log.info('Cross-reference resolution complete', {
    operationId,
    resolved,
    warnings: warnings.length,
  });

  return { resolved, warnings };
}

function quoteDslScalar(value: string): string {
  return JSON.stringify(value);
}

function upsertIndentedDslProperty(dslContent: string, key: string, value: string): string {
  const lines = dslContent.split('\n');
  const propertyPattern = new RegExp(`^(\\s*)${key}\\s*:\\s*.*$`);
  const nextLine = (indent: string) => `${indent}${key}: ${quoteDslScalar(value)}`;

  for (let i = 1; i < lines.length; i += 1) {
    const match = lines[i].match(propertyPattern);
    if (match) {
      lines[i] = nextLine(match[1] ?? '  ');
      return lines.join('\n');
    }
  }

  const typeLineIndex = lines.findIndex((line, index) => index > 0 && /^\s*type\s*:/.test(line));
  const insertIndex = typeLineIndex >= 0 ? typeLineIndex + 1 : Math.min(lines.length, 1);
  const indent = typeLineIndex >= 0 ? (lines[typeLineIndex].match(/^\s*/)?.[0] ?? '  ') : '  ';
  lines.splice(insertIndex, 0, nextLine(indent));
  return lines.join('\n');
}

async function resolveImportedSearchAiToolBindings(
  db: CrossRefDbAdapter,
  stagedRecordIds: Record<string, string[]> | undefined,
  anchorMaps: Map<string, Map<string, string>>,
): Promise<{ resolved: number; warnings: string[] }> {
  const toolIds = stagedRecordIds?.project_tools;
  const searchIndexIds = stagedRecordIds?.search_indexes;
  if (!toolIds?.length || !searchIndexIds?.length) {
    return { resolved: 0, warnings: [] };
  }

  let searchIndexMap = anchorMaps.get('search_indexes') ?? new Map<string, string>();
  if (![...searchIndexMap.keys()].some((key) => key.startsWith('_exportedId:'))) {
    const searchIndexes = await db.queryStagedRecords(
      'search_indexes',
      stagedRecordFilter(searchIndexIds),
      { _id: 1, _exportedId: 1 },
    );
    searchIndexMap = new Map(searchIndexMap);
    for (const index of searchIndexes) {
      if (typeof index._exportedId === 'string') {
        searchIndexMap.set(`_exportedId:${index._exportedId}`, String(index._id));
      }
    }
  }

  if (searchIndexMap.size === 0) {
    return { resolved: 0, warnings: [] };
  }

  const toolRecords = await db.queryStagedRecords('project_tools', stagedRecordFilter(toolIds), {
    _id: 1,
    dslContent: 1,
    _searchAiIndexExportedId: 1,
  });
  const updates: Array<{
    filter: Record<string, unknown>;
    update: Record<string, unknown>;
  }> = [];
  const warnings: string[] = [];
  let resolved = 0;

  for (const record of toolRecords) {
    const exportedId = record._searchAiIndexExportedId;
    if (typeof exportedId !== 'string') {
      continue;
    }

    const targetIndexId = searchIndexMap.get(`_exportedId:${exportedId}`);
    if (!targetIndexId) {
      warnings.push(
        `Cannot resolve SearchAI tool index_id for "project_tools" record: ` +
          `"_searchAiIndexExportedId" = "${exportedId}" not found in "search_indexes"`,
      );
      updates.push({
        filter: { _id: record._id },
        update: { $unset: { _searchAiIndexExportedId: 1 } },
      });
      continue;
    }

    const dslContent = typeof record.dslContent === 'string' ? record.dslContent : '';
    const nextDslContent = upsertIndentedDslProperty(dslContent, 'index_id', targetIndexId);
    updates.push({
      filter: { _id: record._id },
      update: {
        $set: {
          dslContent: nextDslContent,
          sourceHash: computeSourceHash(nextDslContent),
        },
        $unset: { _searchAiIndexExportedId: 1 },
      },
    });
    resolved += 1;
  }

  if (updates.length > 0) {
    await db.batchUpdateStagedRecords('project_tools', updates);
  }

  return { resolved, warnings };
}

async function resolveImportedWorkflowTriggerBindings(
  db: CrossRefDbAdapter,
  stagedRecordIds: Record<string, string[]> | undefined,
): Promise<{ resolved: number; warnings: string[] }> {
  const workflowIds = stagedRecordIds?.workflows;
  const workflowVersionIds = stagedRecordIds?.workflow_versions;
  const triggerRegistrationIds = stagedRecordIds?.trigger_registrations;
  const toolIds = stagedRecordIds?.project_tools;
  if (!workflowIds?.length || !workflowVersionIds?.length) {
    return { resolved: 0, warnings: [] };
  }

  const workflows = await db.queryStagedRecords('workflows', stagedRecordFilter(workflowIds), {
    _id: 1,
    name: 1,
    _exportedId: 1,
  });
  const workflowIdByName = new Map<string, string>();
  const workflowIdByExportedId = new Map<string, string>();
  for (const workflow of workflows) {
    const id = String(workflow._id);
    if (typeof workflow.name === 'string') {
      workflowIdByName.set(workflow.name, id);
    }
    if (typeof workflow._exportedId === 'string') {
      workflowIdByExportedId.set(workflow._exportedId, id);
    }
  }

  const workflowVersions = await db.queryStagedRecords(
    'workflow_versions',
    stagedRecordFilter(workflowVersionIds),
    { _id: 1, workflowId: 1, version: 1 },
  );
  const workflowVersionIdByWorkflowAndVersion = new Map<string, string>();
  for (const version of workflowVersions) {
    if (typeof version.workflowId === 'string' && typeof version.version === 'string') {
      workflowVersionIdByWorkflowAndVersion.set(
        `${version.workflowId}:${version.version}`,
        String(version._id),
      );
    }
  }

  const warnings: string[] = [];
  let resolved = 0;
  const triggerIdByExportedId = new Map<string, string>();

  if (triggerRegistrationIds?.length) {
    const triggerRegistrations = await db.queryStagedRecords(
      'trigger_registrations',
      stagedRecordFilter(triggerRegistrationIds),
      { _id: 1, _exportedId: 1, _workflowName: 1, _workflowVersion: 1 },
    );
    const triggerUpdates: Array<{
      filter: Record<string, unknown>;
      update: Record<string, unknown>;
    }> = [];

    for (const trigger of triggerRegistrations) {
      if (typeof trigger._exportedId === 'string') {
        triggerIdByExportedId.set(trigger._exportedId, String(trigger._id));
      }

      const workflowName = trigger._workflowName;
      const workflowVersion = trigger._workflowVersion;
      if (typeof workflowName !== 'string' || typeof workflowVersion !== 'string') {
        continue;
      }

      const workflowId = workflowIdByName.get(workflowName);
      if (!workflowId) {
        warnings.push(
          `Cannot resolve workflowId for "trigger_registrations" record: ` +
            `"_workflowName" = "${workflowName}" not found in "workflows"`,
        );
        triggerUpdates.push({
          filter: { _id: trigger._id },
          update: { $unset: { _workflowName: 1, _workflowVersion: 1 } },
        });
        continue;
      }

      const workflowVersionId = workflowVersionIdByWorkflowAndVersion.get(
        `${workflowId}:${workflowVersion}`,
      );
      if (!workflowVersionId) {
        warnings.push(
          `Cannot resolve workflowVersionId for "trigger_registrations" record: ` +
            `version "${workflowVersion}" not found for workflow "${workflowName}"`,
        );
        triggerUpdates.push({
          filter: { _id: trigger._id },
          update: { $set: { workflowId }, $unset: { _workflowName: 1, _workflowVersion: 1 } },
        });
        continue;
      }

      triggerUpdates.push({
        filter: { _id: trigger._id },
        update: {
          $set: { workflowId, workflowVersionId },
          $unset: { _workflowName: 1, _workflowVersion: 1 },
        },
      });
      resolved += 1;
    }

    if (triggerUpdates.length > 0) {
      await db.batchUpdateStagedRecords('trigger_registrations', triggerUpdates);
    }
  }

  if (!toolIds?.length || workflowIdByExportedId.size === 0 || triggerIdByExportedId.size === 0) {
    return { resolved, warnings };
  }

  const workflowToolRecords = await db.queryStagedRecords(
    'project_tools',
    stagedRecordFilter(toolIds),
    {
      _id: 1,
      dslContent: 1,
      _workflowToolExportedWorkflowId: 1,
      _workflowToolExportedTriggerId: 1,
    },
  );
  const toolUpdates: Array<{
    filter: Record<string, unknown>;
    update: Record<string, unknown>;
  }> = [];

  for (const tool of workflowToolRecords) {
    const exportedWorkflowId = tool._workflowToolExportedWorkflowId;
    const exportedTriggerId = tool._workflowToolExportedTriggerId;
    if (typeof exportedWorkflowId !== 'string' || typeof exportedTriggerId !== 'string') {
      continue;
    }

    const targetWorkflowId = workflowIdByExportedId.get(exportedWorkflowId);
    const targetTriggerId = triggerIdByExportedId.get(exportedTriggerId);
    if (!targetWorkflowId || !targetTriggerId) {
      warnings.push(
        `Cannot resolve workflow tool binding for "project_tools" record: ` +
          `workflow "${exportedWorkflowId}" or trigger "${exportedTriggerId}" was not imported`,
      );
      toolUpdates.push({
        filter: { _id: tool._id },
        update: {
          $unset: {
            _workflowToolExportedWorkflowId: 1,
            _workflowToolExportedTriggerId: 1,
          },
        },
      });
      continue;
    }

    const dslContent = typeof tool.dslContent === 'string' ? tool.dslContent : '';
    const nextDslContent = upsertIndentedDslProperty(
      upsertIndentedDslProperty(dslContent, 'workflow_id', targetWorkflowId),
      'trigger_id',
      targetTriggerId,
    );
    toolUpdates.push({
      filter: { _id: tool._id },
      update: {
        $set: {
          dslContent: nextDslContent,
          sourceHash: computeSourceHash(nextDslContent),
        },
        $unset: {
          _workflowToolExportedWorkflowId: 1,
          _workflowToolExportedTriggerId: 1,
        },
      },
    });
    resolved += 1;
  }

  if (toolUpdates.length > 0) {
    await db.batchUpdateStagedRecords('project_tools', toolUpdates);
  }

  return { resolved, warnings };
}

/**
 * Safety net: strip any remaining temp _ prefixed fields from staged records.
 *
 * This catches cases where:
 * - A new disassembler adds temp fields not covered by the resolver rules
 * - An error in resolution leaves temp fields unstripped
 *
 * Uses countDocuments first to avoid reading document bodies in the normal case.
 */
async function stripRemainingTempFields(
  db: CrossRefDbAdapter,
  stagedRecordIds: Record<string, string[]> | undefined,
  warnings: string[],
): Promise<void> {
  if (!stagedRecordIds) return;

  // Build the $or condition for known temp fields
  const tempFieldConditions = KNOWN_TEMP_FIELDS.map((field) => ({
    [field]: { $exists: true },
  }));

  for (const [collection, ids] of Object.entries(stagedRecordIds)) {
    if (!ids || ids.length === 0) continue;

    try {
      // Query for any records that still have temp fields
      const recordsWithTempFields = await db.queryStagedRecords(
        collection,
        stagedRecordWithTempFieldsFilter(ids, tempFieldConditions),
        // Project all known temp fields plus _id
        KNOWN_TEMP_FIELDS.reduce(
          (proj, field) => {
            proj[field] = 1;
            return proj;
          },
          { _id: 1 } as Record<string, number>,
        ),
      );

      if (recordsWithTempFields.length === 0) continue;

      const cleanupUpdates: Array<{
        filter: Record<string, unknown>;
        update: Record<string, unknown>;
      }> = [];

      for (const record of recordsWithTempFields) {
        const unsetFields: Record<string, number> = {};
        for (const field of KNOWN_TEMP_FIELDS) {
          if (record[field] !== undefined) {
            unsetFields[field] = 1;
          }
        }

        if (Object.keys(unsetFields).length > 0) {
          cleanupUpdates.push({
            filter: { _id: record._id },
            update: { $unset: unsetFields },
          });
        }
      }

      if (cleanupUpdates.length > 0) {
        await db.batchUpdateStagedRecords(collection, cleanupUpdates);
        warnings.push(
          `Safety net: stripped ${cleanupUpdates.length} residual temp fields from "${collection}"`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Failed to strip temp fields from "${collection}": ${msg}`);
    }
  }
}

function stagedRecordFilter(ids: string[]): Record<string, unknown> {
  return {
    _id: { $in: ids },
    $or: [
      { [IMPORT_LIFECYCLE_STATE_PATH]: 'staged' },
      // Backward compatibility for staged records created before import
      // lifecycle metadata existed.
      { status: 'staged' },
    ],
  };
}

function stagedRecordWithTempFieldsFilter(
  ids: string[],
  tempFieldConditions: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    $and: [stagedRecordFilter(ids), { $or: tempFieldConditions }],
  };
}
