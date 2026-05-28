/**
 * Export Assembler Map Builder
 *
 * Delegates canonical assembler construction to the shared project-io seam.
 * Kept as a Studio-local lazy import boundary to avoid loading assembler code
 * on every request path that does not export.
 */

import type { LayerName } from '@agent-platform/project-io';
import { buildDefaultAssemblerMap, type LayerAssembler } from '@agent-platform/project-io/export';

/**
 * Build a map of assemblers for the requested layers.
 */
export function buildAssemblerMap(layers: LayerName[]): Map<LayerName, LayerAssembler> {
  return buildDefaultAssemblerMap(layers);
}
