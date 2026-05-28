import { LAYER_DEFAULTS, type LayerName } from '../types.js';
import type { LayerAssembler, LayerQueryContext } from './layer-assemblers/types.js';
import {
  ChannelsAssembler,
  ConnectionsAssembler,
  CoreAssembler,
  EvalsAssembler,
  GuardrailsAssembler,
  PromptsAssembler,
  SearchAssembler,
  VocabularyAssembler,
  WorkflowsAssembler,
} from './layer-assemblers/index.js';

export interface ExportLayerPreviewEntry {
  name: LayerName;
  defaultMode: (typeof LAYER_DEFAULTS)[LayerName];
  entityCount: number;
}

const LAYER_ORDER = Object.keys(LAYER_DEFAULTS) as LayerName[];

const DEFAULT_ASSEMBLER_FACTORIES: Record<LayerName, () => LayerAssembler> = {
  core: () => new CoreAssembler(),
  connections: () => new ConnectionsAssembler(),
  prompts: () => new PromptsAssembler(),
  guardrails: () => new GuardrailsAssembler(),
  workflows: () => new WorkflowsAssembler(),
  evals: () => new EvalsAssembler(),
  search: () => new SearchAssembler(),
  channels: () => new ChannelsAssembler(),
  vocabulary: () => new VocabularyAssembler(),
};

export function listCanonicalExportLayers(): LayerName[] {
  return [...LAYER_ORDER];
}

export function buildDefaultAssemblerMap(layers: LayerName[]): Map<LayerName, LayerAssembler> {
  const assemblers = new Map<LayerName, LayerAssembler>();

  for (const layer of layers) {
    const factory = DEFAULT_ASSEMBLER_FACTORIES[layer];
    if (factory) {
      assemblers.set(layer, factory());
    }
  }

  return assemblers;
}

export async function buildLayerPreview(
  ctx: LayerQueryContext,
  assemblers: Map<LayerName, LayerAssembler> = buildDefaultAssemblerMap(LAYER_ORDER),
  layers: LayerName[] = LAYER_ORDER,
): Promise<ExportLayerPreviewEntry[]> {
  const counts = await Promise.all(
    layers.map(async (layer) => ({
      layer,
      entityCount: (await assemblers.get(layer)?.countEntities(ctx)) ?? 0,
    })),
  );

  const countByLayer = new Map(counts.map((entry) => [entry.layer, entry.entityCount]));

  return layers.map((layer) => ({
    name: layer,
    defaultMode: LAYER_DEFAULTS[layer],
    entityCount: countByLayer.get(layer) ?? 0,
  }));
}
