/**
 * Previewable Pipelines Service
 *
 * Returns the list of pipelines whose output can be queried in the Data tab.
 *
 * Two sources:
 *   1. Builtin pipelines with a hardcoded table mapping (only those with an
 *      enabled PipelineConfig for the project).
 *   2. Tenant-owned custom pipeline definitions that declare a store-results
 *      node with a `table` config.
 *
 * Note: all collections in this module are request-scoped (local to a single
 * function call) — they do not accumulate across requests, so no TTL or
 * eviction is required.
 */

import { getBuiltinPreviewablePipelines } from './schema-resolver.js';
import {
  CUSTOM_PIPELINE_RESULTS_TABLE,
  DESTINATION_REGISTRY,
} from '@agent-platform/pipeline-engine/contracts';

export interface PreviewablePipeline {
  id: string;
  name: string;
  kind: 'builtin' | 'custom';
}

/**
 * Given a store-results config, return the table name iff it is previewable
 * (destination is ClickHouse — the only destination the Preview tab can query)
 * AND the table name conforms to the ClickHouse `database.table` format.
 *
 * Legacy (undefined `destination`) is treated as ClickHouse for back-compat —
 * but the same table-format rule still applies, so unformatted tables get filtered.
 */
function previewableTableFromStoreConfig(
  config: Record<string, unknown> | undefined,
): string | null {
  if (!config) return null;
  const rawDestination = config.destination as string | undefined;
  const destinationId = rawDestination ?? 'clickhouse'; // legacy default
  const destContract =
    destinationId in DESTINATION_REGISTRY
      ? DESTINATION_REGISTRY[destinationId as keyof typeof DESTINATION_REGISTRY]
      : undefined;
  if (!destContract?.previewable) return null;
  const table = (config.table as string | undefined) ?? CUSTOM_PIPELINE_RESULTS_TABLE;
  if (destContract.table.regex && !destContract.table.regex.test(table)) return null;
  return table;
}

/** Search nodes, steps, and strategy steps for a previewable store-results table. */
export function findStoreTable(def: Record<string, unknown>): string | null {
  const isStore = (type?: string, activity?: string) =>
    type === 'store-results' ||
    type === 'store-insight' ||
    activity === 'store-results' ||
    activity === 'store-insight';

  // Graph-based nodes
  const nodes = (def.nodes as Array<Record<string, unknown>>) ?? [];
  for (const n of nodes) {
    if (isStore(n.type as string | undefined)) {
      const table = previewableTableFromStoreConfig(n.config as Record<string, unknown>);
      if (table) return table;
    }
  }

  // Legacy flat steps
  const steps = (def.steps as Array<Record<string, unknown>>) ?? [];
  for (const s of steps) {
    if (isStore(s.type as string | undefined, s.activity as string | undefined)) {
      const table = previewableTableFromStoreConfig(s.config as Record<string, unknown>);
      if (table) return table;
    }
  }

  // Strategy steps
  type StrategyMap = Record<string, { steps?: Array<Record<string, unknown>> }>;
  const strategies = def.strategies as StrategyMap | Map<string, unknown> | undefined;
  if (strategies) {
    const entries: StrategyMap =
      strategies instanceof Map
        ? (Object.fromEntries(strategies) as StrategyMap)
        : (strategies as StrategyMap);
    for (const strategy of Object.values(entries)) {
      for (const s of strategy.steps ?? []) {
        if (isStore(s.type as string | undefined, s.activity as string | undefined)) {
          const table = previewableTableFromStoreConfig(s.config as Record<string, unknown>);
          if (table) return table;
        }
      }
    }
  }

  return null;
}

export async function listPreviewablePipelines(args: {
  tenantId: string;
  projectId: string;
}): Promise<PreviewablePipeline[]> {
  const { PipelineDefinitionModel, PipelineConfigModel } =
    await import('@agent-platform/pipeline-engine/schemas');

  // 1. Builtin pipelines with known ClickHouse tables
  const builtinPreviews = getBuiltinPreviewablePipelines();

  // Enabled configs for this project (plain Record — not accumulated state)
  const configs = await PipelineConfigModel.find({
    tenantId: args.tenantId,
    $or: [{ projectId: args.projectId }, { projectId: null }],
    enabled: true,
  }).lean();

  const enabledPipelineTypes: Record<string, true> = {};
  for (const c of configs) enabledPipelineTypes[c.pipelineType] = true;

  // Builtin definitions for names
  const builtinIds = builtinPreviews.map((b) => b.pipelineId);
  const builtinDefs = await PipelineDefinitionModel.find({
    _id: { $in: builtinIds },
    tenantId: '__platform__',
    status: 'active',
  }).lean();

  const defNameMap: Record<string, string> = {};
  for (const d of builtinDefs) {
    defNameMap[String(d._id)] = d.name;
  }

  const builtinData: PreviewablePipeline[] = builtinPreviews
    .filter((b) => {
      const def = builtinDefs.find((d) => String(d._id) === b.pipelineId);
      if (!def) return false;
      const ptype = def.pipelineType;
      return ptype ? enabledPipelineTypes[ptype] === true : false;
    })
    .map((b) => ({
      id: b.pipelineId,
      name: defNameMap[b.pipelineId] ?? b.pipelineId,
      kind: 'builtin',
    }));

  // 2. Custom pipeline definitions with store-results nodes
  const customDefs = await PipelineDefinitionModel.find({
    tenantId: args.tenantId,
    projectId: args.projectId,
    status: 'active',
  }).lean();

  const customData: PreviewablePipeline[] = customDefs
    .map((d): PreviewablePipeline | null => {
      const tableName = findStoreTable(d as unknown as Record<string, unknown>);
      if (!tableName) return null;
      return {
        id: String(d._id),
        name: d.name,
        kind: 'custom',
      };
    })
    .filter((x): x is PreviewablePipeline => x !== null);

  return [...builtinData, ...customData];
}
