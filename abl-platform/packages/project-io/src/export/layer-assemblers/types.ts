import type {
  ExportDslFormat,
  GuardrailArchiveFormat,
  LayerName,
  LayerAssemblyResult,
} from '../../types.js';

export interface LayerQueryContext {
  projectId: string;
  tenantId: string;
  /** When true, include deployment-pinned version snapshots in the export */
  includeDeployments?: boolean;
  /** Optional environment names to include when exporting deployment-scoped assets. */
  environments?: string[];
  /** DSL output format — source preserves existing DSL; yaml materializes canonical YAML. */
  dslFormat?: ExportDslFormat;
  /** Guardrail archive format — controls .guardrail.json vs .guardrail.yaml output */
  guardrailFormat?: GuardrailArchiveFormat;
}

/**
 * Each layer assembler queries its own data and builds file entries.
 * Assemblers are independent — they don't depend on each other's output.
 */
export interface LayerAssembler {
  readonly layer: LayerName;
  assemble(ctx: LayerQueryContext): Promise<LayerAssemblyResult>;
  countEntities(ctx: LayerQueryContext): Promise<number>;
}
